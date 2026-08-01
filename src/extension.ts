import * as vscode from 'vscode';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    console.log('Add to Terminal extension is now active!');

    const addReferenceCmd = vscode.commands.registerCommand(
        'addToTerminal.addReference',
        (arg1?: vscode.Uri | vscode.Uri[], arg2?: vscode.Uri[]) => addReferenceToTerminal(arg1, arg2)
    );

    const sendDiagnosticCmd = vscode.commands.registerCommand(
        'addToTerminal.sendDiagnostic',
        (uri: vscode.Uri, message: string, severity: vscode.DiagnosticSeverity, line: number) =>
            sendDiagnosticToTerminal(uri, message, severity, line)
    );

    const codeActionProvider = vscode.languages.registerCodeActionsProvider(
        { pattern: '**/*' },
        new AddToTerminalCodeActionProvider()
    );

    context.subscriptions.push(addReferenceCmd, sendDiagnosticCmd, codeActionProvider);
}

/**
 * Get formatted file path from a URI based on configuration
 */
function getFormattedPathFromUri(uri: vscode.Uri): string {
    const config = vscode.workspace.getConfiguration('addToTerminal');
    const pathFormat = config.get<string>('pathFormat', 'relative');
    const filePath = uri.fsPath;

    switch (pathFormat) {
        case 'absolute':
            return filePath;
        case 'basename':
            return path.basename(filePath);
        case 'relative':
        default:
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            if (workspaceFolder) {
                return path.relative(workspaceFolder.uri.fsPath, filePath);
            }
            return filePath;
    }
}

/**
 * Get the terminal to use (existing or new)
 */
async function getTerminal(): Promise<vscode.Terminal> {
    const activeTerminal = vscode.window.activeTerminal;
    if (activeTerminal) {
        return activeTerminal;
    }

    const terminals = vscode.window.terminals;
    if (terminals.length > 0) {
        return terminals[terminals.length - 1];
    }

    return vscode.window.createTerminal('Add to Terminal');
}

/**
 * Send text to terminal without executing (no newline)
 */
async function sendToTerminal(text: string): Promise<void> {
    const terminal = await getTerminal();
    terminal.show();
    terminal.sendText(text, false);
}

/**
 * Get diagnostics that overlap the cursor position
 */
function getDiagnosticsAtCursor(editor: vscode.TextEditor): vscode.Diagnostic[] {
    const cursor = editor.selection.active;
    return vscode.languages.getDiagnostics(editor.document.uri)
        .filter(d => d.range.contains(cursor));
}

/**
 * Map diagnostic severity to a short label
 */
function severityLabel(severity: vscode.DiagnosticSeverity): string {
    switch (severity) {
        case vscode.DiagnosticSeverity.Error: return 'error';
        case vscode.DiagnosticSeverity.Warning: return 'warning';
        case vscode.DiagnosticSeverity.Information: return 'info';
        case vscode.DiagnosticSeverity.Hint: return 'hint';
        default: return 'diagnostic';
    }
}

/**
 * Format diagnostic messages suffix: " error: msg1 | warning: msg2"
 */
function formatDiagnosticSuffix(diagnostics: vscode.Diagnostic[]): string {
    if (diagnostics.length === 0) { return ''; }
    const parts = diagnostics.map(d => `${severityLabel(d.severity)}: ${d.message}`);
    return ' ' + parts.join(' | ');
}

/**
 * Format line reference: `filePath:startLine-endLine`
 */
function formatLineReference(filePath: string, startLine: number, endLine?: number): string {
    const displayStart = startLine + 1;
    if (endLine !== undefined && endLine !== startLine) {
        const displayEnd = endLine + 1;
        return `\`${filePath}:${displayStart}-${displayEnd}\``;
    }
    return `\`${filePath}:${displayStart}\``;
}

/**
 * Format file path reference (without line numbers): `filePath`
 */
function formatFileReference(filePath: string): string {
    return `\`${filePath}\``;
}

/**
 * Code Action Provider: adds "Add to Terminal" to the Quick Fix (lightbulb) menu
 * for each diagnostic at the cursor position.
 */
class AddToTerminalCodeActionProvider implements vscode.CodeActionProvider {
    provideCodeActions(
        _document: vscode.TextDocument,
        _range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        _token: vscode.CancellationToken
    ): vscode.CodeAction[] {
        return context.diagnostics.map(diagnostic => {
            const label = severityLabel(diagnostic.severity);
            const title = `Add to Terminal: ${label}: ${diagnostic.message}`;
            const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
            action.command = {
                command: 'addToTerminal.sendDiagnostic',
                title: 'Add to Terminal',
                arguments: [
                    _document.uri,
                    diagnostic.message,
                    diagnostic.severity,
                    diagnostic.range.start.line
                ]
            };
            return action;
        });
    }
}

/**
 * Send a single diagnostic to the terminal (invoked from Quick Fix code action).
 * Output format: `filePath:line` error: message
 */
function sendDiagnosticToTerminal(
    uri: vscode.Uri,
    message: string,
    severity: vscode.DiagnosticSeverity,
    line: number
): void {
    const filePath = getFormattedPathFromUri(uri);
    const displayLine = line + 1; // 0-based → 1-based
    const label = severityLabel(severity);
    sendToTerminal(`\`${filePath}:${displayLine}\` ${label}: ${message}`);
}

/**
 * Add file reference to terminal
 *
 * When invoked from Explorer context (URIs provided):
 *   outputs backtick-wrapped file paths, comma-separated for multiple files
 *
 * When invoked from Editor context (URI matches active editor):
 *   outputs backtick-wrapped `filePath:startLine-endLine`
 */
function addReferenceToTerminal(
    arg1?: vscode.Uri | vscode.Uri[],
    arg2?: vscode.Uri[]
): void {
    // Flatten all arguments into a URI list (handles various VS Code arg-passing patterns)
    const rawArgs: unknown[] = [arg1, arg2];
    const flat: vscode.Uri[] = [];
    for (const a of rawArgs) {
        if (a instanceof vscode.Uri) {
            flat.push(a);
        } else if (Array.isArray(a)) {
            for (const item of a) {
                if (item instanceof vscode.Uri) {
                    flat.push(item);
                }
            }
        }
    }
    // Deduplicate by fsPath
    const seen = new Set<string>();
    const uris: vscode.Uri[] = [];
    for (const u of flat) {
        if (!seen.has(u.fsPath)) {
            seen.add(u.fsPath);
            uris.push(u);
        }
    }

    // --- Editor context: single URI matching active editor, show file:line-range ---
    const editor = vscode.window.activeTextEditor;
    const isEditorContext =
        editor && uris.length === 1 &&
        uris[0].fsPath === editor.document.uri.fsPath;

    if (isEditorContext) {
        const filePath = getFormattedPathFromUri(editor.document.uri);
        const selection = editor.selection;
        const startLine = selection.start.line;
        const endLine = selection.end.line;
        const ref = formatLineReference(filePath, startLine, endLine);
        const suffix = formatDiagnosticSuffix(getDiagnosticsAtCursor(editor));
        sendToTerminal(ref + suffix);
        return;
    }

    // --- Explorer context: file(s) from Explorer, show path(s) only ---
    if (uris.length > 0) {
        const refs = uris.map(u => formatFileReference(getFormattedPathFromUri(u)));
        sendToTerminal(refs.join(', '));
        return;
    }

    // --- Fallback: no URI, use active editor ---
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const filePath = getFormattedPathFromUri(editor.document.uri);
    const selection = editor.selection;
    const startLine = selection.start.line;
    const endLine = selection.end.line;
    const ref = formatLineReference(filePath, startLine, endLine);
    const suffix = formatDiagnosticSuffix(getDiagnosticsAtCursor(editor));
    sendToTerminal(ref + suffix);
}

export function deactivate() {
    console.log('Add to Terminal extension deactivated');
}
