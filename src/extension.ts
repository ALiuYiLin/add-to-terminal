import * as vscode from 'vscode';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    console.log('Add to Terminal extension is now active!');

    const addReferenceCmd = vscode.commands.registerCommand(
        'addToTerminal.addReference',
        (arg1?: vscode.Uri | vscode.Uri[], arg2?: vscode.Uri[]) => addReferenceToTerminal(arg1, arg2)
    );

    context.subscriptions.push(addReferenceCmd);
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
 * Add file reference to terminal
 *
 * When invoked from Explorer context (arg1 is a URI or array of URIs):
 *   outputs backtick-wrapped file paths, comma-separated for multiple files
 *
 * When invoked from Editor context (no URI args):
 *   outputs backtick-wrapped `filePath:startLine-endLine`
 */
function addReferenceToTerminal(
    arg1?: vscode.Uri | vscode.Uri[],
    arg2?: vscode.Uri[]
): void {
    // Resolve URIs passed from VS Code (editor/context or explorer/context)
    let uris: vscode.Uri[] | undefined;

    if (Array.isArray(arg1)) {
        uris = arg1;
    } else if (arg1 instanceof vscode.Uri) {
        // Multi-select in Explorer passes (firstUri, allUris) in newer VS Code
        uris = arg2 && arg2.length > 0 ? arg2 : [arg1];
    }

    // --- Editor context: active editor has focus, show file:line-range ---
    const editor = vscode.window.activeTextEditor;
    const receivedUriFromEditor =
        editor && uris && uris.length === 1 &&
        uris[0].fsPath === editor.document.uri.fsPath;

    if (receivedUriFromEditor) {
        const filePath = getFormattedPathFromUri(editor.document.uri);
        const selection = editor.selection;
        const startLine = selection.start.line;
        const endLine = selection.end.line;
        sendToTerminal(formatLineReference(filePath, startLine, endLine));
        return;
    }

    // --- Explorer context: file(s) selected, show file path(s) only ---
    if (uris && uris.length > 0) {
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
    sendToTerminal(formatLineReference(filePath, startLine, endLine));
}

export function deactivate() {
    console.log('Add to Terminal extension deactivated');
}
