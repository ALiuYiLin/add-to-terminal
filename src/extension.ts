import * as vscode from 'vscode';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    console.log('Add to Terminal extension is now active!');

    // Command: Add file reference to terminal (file:line-end format)
    const addReferenceCmd = vscode.commands.registerCommand(
        'addToTerminal.addReference',
        () => addReferenceToTerminal()
    );

    // Command: Add file path from explorer context menu
    const addFileCmd = vscode.commands.registerCommand(
        'addToTerminal.addFile',
        (uri: vscode.Uri) => addFileToTerminal(uri)
    );

    context.subscriptions.push(addReferenceCmd, addFileCmd);
}

/**
 * Get the formatted file path based on configuration
 */
function getFormattedFilePath(editor: vscode.TextEditor): string {
    const config = vscode.workspace.getConfiguration('addToTerminal');
    const pathFormat = config.get<string>('pathFormat', 'relative');
    const filePath = editor.document.uri.fsPath;

    return formatPath(filePath, editor.document.uri);
}

/**
 * Format file path based on configuration
 */
function formatPath(filePath: string, uri: vscode.Uri): string {
    const config = vscode.workspace.getConfiguration('addToTerminal');
    const pathFormat = config.get<string>('pathFormat', 'relative');

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
    // Check if there's an active terminal
    const activeTerminal = vscode.window.activeTerminal;
    if (activeTerminal) {
        return activeTerminal;
    }

    // Get all terminals
    const terminals = vscode.window.terminals;
    if (terminals.length > 0) {
        return terminals[terminals.length - 1];
    }

    // Create new terminal
    return vscode.window.createTerminal('Add to Terminal');
}

/**
 * Send text to terminal without executing (no newline)
 */
async function sendToTerminal(text: string): Promise<void> {
    const terminal = await getTerminal();
    terminal.show();
    terminal.sendText(text, false);  // false = don't add newline, don't execute
}

/**
 * Format line reference: file:line or file:startLine-endLine
 */
function formatLineReference(filePath: string, startLine: number, endLine?: number): string {
    const displayStart = startLine + 1;  // Convert 0-based to 1-based
    if (endLine !== undefined && endLine !== startLine) {
        const displayEnd = endLine + 1;
        return `${filePath}:${displayStart}-${displayEnd}`;
    }
    return `${filePath}:${displayStart}`;
}

/**
 * Add file reference to terminal (main command)
 * Outputs: file:line or file:startLine-endLine
 */
function addReferenceToTerminal(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const filePath = getFormattedFilePath(editor);
    const selection = editor.selection;

    // If no selection, use current line; if selection spans multiple lines, show range
    const startLine = selection.start.line;
    const endLine = selection.end.line;

    const reference = formatLineReference(filePath, startLine, endLine);
    sendToTerminal(reference);
}

/**
 * Add file path from explorer context menu
 * Called when right-clicking a file in the explorer
 */
function addFileToTerminal(uri: vscode.Uri): void {
    if (!uri) {
        vscode.window.showWarningMessage('No file selected');
        return;
    }

    const filePath = formatPath(uri.fsPath, uri);
    sendToTerminal(filePath);
}

export function deactivate() {
    console.log('Add to Terminal extension deactivated');
}