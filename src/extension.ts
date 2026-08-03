import * as vscode from 'vscode';
import * as path from 'path';

/** The most recently focused terminal, if any. */
let lastActiveTerminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('Add to Terminal extension is now active!');

    const addReferenceCmd = vscode.commands.registerCommand(
        'addToTerminal.addReference',
        () => addReferenceToTerminal()
    );

    const addFileReferenceCmd = vscode.commands.registerCommand(
        'addToTerminal.addFileReference',
        (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => addFileReferenceToTerminal(uri, selectedUris)
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

    context.subscriptions.push(
        addReferenceCmd,
        addFileReferenceCmd,
        sendDiagnosticCmd,
        codeActionProvider,
        vscode.window.onDidChangeActiveTerminal(t => { lastActiveTerminal = t; }),
        vscode.window.onDidCloseTerminal(t => {
            if (lastActiveTerminal === t) { lastActiveTerminal = undefined; }
        })
    );
}

/**
 * Get formatted file path from a URI based on configuration
 */
function getFormattedPathFromUri(uri: vscode.Uri): string {
    const config = vscode.workspace.getConfiguration('addToTerminal');
    const pathFormat = config.get<string>('pathFormat', 'relative');
    const filePath = uri.fsPath;

    let formatted: string;
    switch (pathFormat) {
        case 'absolute':
            formatted = filePath;
            break;
        case 'basename':
            formatted = path.basename(filePath);
            break;
        case 'relative':
        default:
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            formatted = workspaceFolder ? path.relative(workspaceFolder.uri.fsPath, filePath) : filePath;
            break;
    }

    // Normalize to forward slashes: backslashes would break shell escaping
    // and Claude Code's clickable path references on Windows.
    return formatted.replace(/\\/g, '/');
}

/**
 * Get the terminal to use (existing or new)
 */
async function getTerminal(): Promise<vscode.Terminal> {
    if (lastActiveTerminal) {
        return lastActiveTerminal;
    }

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
    try {
        const terminal = await getTerminal();
        terminal.show();
        terminal.sendText(text, false);
    } catch (err) {
        vscode.window.showErrorMessage(
            `Failed to send to terminal: ${err instanceof Error ? err.message : String(err)}`
        );
    }
}

/**
 * Get diagnostics that overlap the current selection(s).
 */
function getDiagnosticsInSelection(editor: vscode.TextEditor): vscode.Diagnostic[] {
    const selections = editor.selections;
    return vscode.languages.getDiagnostics(editor.document.uri)
        .filter(d => selections.some(s => s.intersection(d.range) !== undefined));
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
 * Sanitize a diagnostic message so it can't break the backtick reference or
 * inject extra lines into the terminal.
 */
function sanitizeMessage(message: string): string {
    const cleaned = message
        .replace(/`/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    const maxLength = 200;
    return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

/**
 * Format diagnostic messages suffix: " error: msg1 | warning: msg2"
 */
function formatDiagnosticSuffix(diagnostics: vscode.Diagnostic[]): string {
    if (diagnostics.length === 0) { return ''; }
    const parts = diagnostics.map(d => `${severityLabel(d.severity)}: ${sanitizeMessage(d.message)}`);
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
    if (!(uri instanceof vscode.Uri)) {
        vscode.window.showWarningMessage('This command can only be used from the Quick Fix menu.');
        return;
    }

    const filePath = getFormattedPathFromUri(uri);
    const displayLine = line + 1; // 0-based → 1-based
    const label = severityLabel(severity);
    sendToTerminal(`\`${filePath}:${displayLine}\` ${label}: ${sanitizeMessage(message)}`);
}

/**
 * Get the inclusive line range covered by a selection.
 *
 * A VS Code selection that ends at column 0 of a line does not actually
 * include that line, so subtract one to avoid reporting one extra line.
 */
function selectionLineRange(selection: vscode.Selection): { start: number; end: number } {
    const start = selection.start.line;
    let end = selection.end.line;
    if (end > start && selection.end.character === 0) {
        end -= 1;
    }
    return { start, end };
}

/**
 * Add the active editor's file + selected line range to the terminal.
 *
 * Invoked from the editor context menu or the Ctrl+Alt+T keybinding.
 * Outputs `filePath:startLine-endLine` plus any diagnostics at the cursor.
 */
function addReferenceToTerminal(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    if (editor.document.uri.scheme !== 'file') {
        vscode.window.showWarningMessage('Cannot add reference: the active editor is not a file on disk.');
        return;
    }

    const filePath = getFormattedPathFromUri(editor.document.uri);
    const { start, end } = selectionLineRange(editor.selection);
    const ref = formatLineReference(filePath, start, end);
    const suffix = formatDiagnosticSuffix(getDiagnosticsInSelection(editor));
    sendToTerminal(ref + suffix);
}

/**
 * Add plain file path reference(s) to the terminal.
 *
 * Invoked from the Explorer context menu.
 * Outputs backtick-wrapped file paths, comma-separated for multiple files.
 */
function addFileReferenceToTerminal(uri?: vscode.Uri, selectedUris?: vscode.Uri[]): void {
    const flat: vscode.Uri[] = [];
    if (uri instanceof vscode.Uri) {
        flat.push(uri);
    }
    if (Array.isArray(selectedUris)) {
        for (const item of selectedUris) {
            if (item instanceof vscode.Uri) {
                flat.push(item);
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

    if (uris.length === 0) {
        vscode.window.showWarningMessage('No files selected');
        return;
    }

    const refs = uris.map(u => formatFileReference(getFormattedPathFromUri(u)));
    sendToTerminal(refs.join(', '));
}

export function deactivate() {
    console.log('Add to Terminal extension deactivated');
}
