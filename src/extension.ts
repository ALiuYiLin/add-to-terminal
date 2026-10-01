import * as vscode from 'vscode';
import * as path from 'path';
import { DshSink, SinkResult, TerminalSink } from './sink';
import { DshPanel, registerDshPanel } from './panel';

/** One reference the user asked to deliver. Lines are 0-based and inclusive. */
interface ReferenceItem {
    uri: vscode.Uri;
    startLine?: number;
    endLine?: number;
    /** Trailing diagnostics text, e.g. " error: Cannot find name 'foo'". */
    suffix?: string;
}

let terminalSink: TerminalSink;
let dshSink: DshSink;
let dshPanel: DshPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('Add to Terminal extension is now active!');

    terminalSink = new TerminalSink(context);
    dshSink = new DshSink(context);
    dshPanel = registerDshPanel(context, {
        deliverSelection: deliverSelectionToTarget,
        isDshOff: () => dshSink.isDisconnected(),
        setDshOff: (value: boolean) => dshSink.setDisconnected(value),
    });

    const addReferenceCmd = vscode.commands.registerCommand(
        'addToTerminal.addReference',
        () => addReference()
    );

    const addFileReferenceCmd = vscode.commands.registerCommand(
        'addToTerminal.addFileReference',
        (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => addFileReference(uri, selectedUris)
    );

    const sendDiagnosticCmd = vscode.commands.registerCommand(
        'addToTerminal.sendDiagnostic',
        (uri: vscode.Uri, message: string, severity: vscode.DiagnosticSeverity, line: number) =>
            sendDiagnostic(uri, message, severity, line)
    );

    const codeActionProvider = vscode.languages.registerCodeActionsProvider(
        { pattern: '**/*' },
        new AddToTerminalCodeActionProvider()
    );

    context.subscriptions.push(
        addReferenceCmd,
        addFileReferenceCmd,
        sendDiagnosticCmd,
        codeActionProvider
    );
}

/**
 * Get formatted file path from a URI based on the `pathFormat` setting.
 * Used by the terminal destination, which keeps its historical output shape.
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
        default: {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            formatted = workspaceFolder ? path.relative(workspaceFolder.uri.fsPath, filePath) : filePath;
            break;
        }
    }

    // Normalize to forward slashes: backslashes would break shell escaping
    // and clickable path references on Windows.
    return formatted.replace(/\\/g, '/');
}

/**
 * Path used in a DSH `@mention`. Relative mentions resolve from the DSH
 * session's workspace root, so a relative path is only emitted when the file
 * really lives under that root; otherwise the absolute path is used.
 */
function getDshPathFromUri(uri: vscode.Uri, cwd: string | undefined): string {
    const absolute = uri.fsPath.replace(/\\/g, '/');
    const config = vscode.workspace.getConfiguration('addToTerminal');
    if (config.get<string>('dshPathStyle', 'relative') === 'absolute') {
        return absolute;
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
        return absolute;
    }
    const relative = path.relative(workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
    if (relative === '' || relative.startsWith('..')) {
        return absolute;
    }
    if (cwd !== undefined && cwd !== '') {
        const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        if (!absolute.toLowerCase().startsWith(`${root}/`)) {
            return absolute;
        }
    }
    return relative;
}

/**
 * Get diagnostics that overlap the given range.
 */
function getDiagnosticsInRange(uri: vscode.Uri, range: vscode.Range): vscode.Diagnostic[] {
    return vscode.languages.getDiagnostics(uri)
        .filter(d => range.intersection(d.range) !== undefined);
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

const MAX_DIAGNOSTICS = 5;

/**
 * Format diagnostic messages suffix: " error: msg1 | warning: msg2"
 * Duplicates are removed and the total is capped to keep the input readable.
 */
function formatDiagnosticSuffix(diagnostics: vscode.Diagnostic[]): string {
    if (diagnostics.length === 0) { return ''; }
    const seen = new Set<string>();
    const parts: string[] = [];
    let skipped = 0;
    for (const d of diagnostics) {
        const key = `${d.severity}:${d.message}`;
        if (seen.has(key)) { skipped++; continue; }
        seen.add(key);
        if (parts.length < MAX_DIAGNOSTICS) {
            parts.push(`${severityLabel(d.severity)}: ${sanitizeMessage(d.message)}`);
        } else {
            skipped++;
        }
    }
    let suffix = ' ' + parts.join(' | ');
    if (skipped > 0) { suffix += ` (+${skipped} more)`; }
    return suffix;
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

/** Terminal rendering: backticked paths, one comma-separated line. */
function renderTerminal(items: ReferenceItem[]): string {
    return items
        .map(item => {
            const filePath = getFormattedPathFromUri(item.uri);
            const reference = item.startLine === undefined
                ? formatFileReference(filePath)
                : formatLineReference(filePath, item.startLine, item.endLine);
            return reference + (item.suffix ?? '');
        })
        .join(', ');
}

/** DSH rendering: `@relative/path:line-line`, one reference per line. */
function renderDsh(items: ReferenceItem[], cwd: string | undefined): string {
    return items.map(item => {
        let target = getDshPathFromUri(item.uri, cwd);
        if (item.startLine !== undefined) {
            const displayStart = item.startLine + 1;
            target += item.endLine !== undefined && item.endLine !== item.startLine
                ? `:${displayStart}-${item.endLine + 1}`
                : `:${displayStart}`;
        }
        const mention = /\s/.test(target) ? `@"${target}"` : `@${target}`;
        return mention + (item.suffix ?? '');
    }).join('\n');
}

/**
 * Deliver one batch to the configured destination, falling back to the
 * terminal when the DSH page is gone and the user asked for that fallback.
 *
 * Three states go straight to the terminal without a failure dialog, because
 * they are not failures — plenty of people only ever use the terminal half:
 *   destination = terminal        (the historical behaviour)
 *   DSH disconnected by the user  (panel/status-bar 断开)
 *   no DSH page in play           (bridge missing, DSH closed, no tab open)
 */
async function deliver(items: ReferenceItem[], options: { tabId?: string } = {}): Promise<void> {
    if (items.length === 0) {
        return;
    }
    const config = vscode.workspace.getConfiguration('addToTerminal');
    const destination = config.get<string>('destination', 'dsh');
    const fallback = config.get<boolean>('fallbackToTerminal', true);

    const sendTerminal = async (): Promise<boolean> => {
        const outcome: SinkResult = await terminalSink.send(renderTerminal(items));
        if (!outcome.ok) {
            vscode.window.showErrorMessage(outcome.detail);
        }
        return outcome.ok;
    };

    /** Terminal delivery for a state that is not a DSH failure: tell, don't scold. */
    const sendTerminalQuietly = async (note: string): Promise<void> => {
        const delivered = await sendTerminal();
        if (delivered) {
            vscode.window.setStatusBarMessage(`Add to Terminal：${note}`, 3500);
        }
    };

    if (destination === 'terminal') {
        await sendTerminal();
        return;
    }

    if (dshSink.isDisconnected()) {
        await sendTerminalQuietly('已断开 DSH，发往终端');
        void dshPanel?.refresh();
        return;
    }

    const outcome = await dshSink.send((cwd) => renderDsh(items, cwd), options);
    if (outcome.ok) {
        vscode.window.setStatusBarMessage(`Add to Terminal：${outcome.detail}`, 4000);
        if (destination === 'both') {
            await sendTerminal();
        }
        void dshPanel?.refresh();
        return;
    }

    /* DSH is simply not in play: the terminal is the destination, quietly. */
    if (outcome.unavailable === true) {
        if (fallback) {
            await sendTerminalQuietly('没有打开的 DSH 页面，发往终端');
        } else {
            vscode.window.showWarningMessage(`DSH 不可用：${outcome.detail}`);
        }
        void dshPanel?.refresh();
        return;
    }

    if (destination === 'both') {
        const delivered = await sendTerminal();
        vscode.window.showWarningMessage(
            `DSH 投递失败：${outcome.detail}${delivered ? '（已同时发往终端）' : ''}`
        );
        void dshPanel?.refresh();
        return;
    }

    // Pushed but unconfirmed: falling back could insert the reference twice.
    if (outcome.uncertain === true) {
        vscode.window.showWarningMessage(
            `DSH 投递未确认：${outcome.detail}（未自动回退，以免重复；可重试或改用终端）`
        );
        void dshPanel?.refresh();
        return;
    }

    if (fallback) {
        const delivered = await sendTerminal();
        vscode.window.showWarningMessage(
            `DSH 投递失败：${outcome.detail}${delivered ? '，已回退到终端。' : ''}`
        );
        void dshPanel?.refresh();
        return;
    }
    vscode.window.showErrorMessage(`DSH 投递失败：${outcome.detail}`);
    void dshPanel?.refresh();
}

/**
 * References for the active editor's selections, or undefined when there is
 * nothing to deliver (non-file document, cancelled unsaved-changes prompt).
 */
async function buildEditorItems(): Promise<ReferenceItem[] | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return undefined;
    }
    if (editor.document.uri.scheme !== 'file') {
        vscode.window.showWarningMessage('Cannot add reference: the active editor is not a file on disk.');
        return undefined;
    }
    if (editor.document.isDirty) {
        const choice = await vscode.window.showWarningMessage(
            'The file has unsaved changes; line numbers may not match the saved file.',
            'Save',
            'Send anyway'
        );
        if (!choice) { return undefined; }
        if (choice === 'Save') {
            await editor.document.save();
        }
    }
    return editor.selections.map(selection => {
        const { start, end } = selectionLineRange(selection);
        return {
            uri: editor.document.uri,
            startLine: start,
            endLine: end,
            suffix: formatDiagnosticSuffix(getDiagnosticsInRange(editor.document.uri, selection))
        };
    });
}

/**
 * Panel / Quick Pick entry: deliver the current selection to one exact DSH
 * page (the page the user just clicked in the sidebar).
 */
async function deliverSelectionToTarget(tabId: string): Promise<void> {
    const items = await buildEditorItems();
    if (items === undefined || items.length === 0) {
        vscode.window.setStatusBarMessage('Add to Terminal：已选定 DSH 页面（当前没有可投递的选区）', 4000);
        return;
    }
    await deliver(items, { tabId });
}

/**
 * Code Action Provider: adds "Add to Terminal" to the Quick Fix (lightbulb) menu
 * for each diagnostic at the cursor position.
 */
class AddToTerminalCodeActionProvider implements vscode.CodeActionProvider {
    provideCodeActions(
        _document: vscode.TextDocument,
        _range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext
    ): vscode.CodeAction[] {
        if (_document.uri.scheme !== 'file') {
            return [];
        }
        return context.diagnostics.map(diagnostic => {
            const label = severityLabel(diagnostic.severity);
            const title = `Add to Terminal: ${label}: ${sanitizeMessage(diagnostic.message)}`;
            const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
            action.command = {
                command: 'addToTerminal.sendDiagnostic',
                title: 'Add to Terminal',
                arguments: [
                    _document.uri.toString(),
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
 * Send a single diagnostic (invoked from Quick Fix code action).
 * Output shape: `filePath:line` error: message / @filePath:line error: message
 *
 * The URI is passed as a string so it survives command argument serialization
 * (e.g. remote extension hosts), then reconstructed via Uri.parse.
 */
function sendDiagnostic(
    uriOrString: vscode.Uri | string,
    message: string,
    severity: vscode.DiagnosticSeverity,
    line: number
): void {
    const uri = typeof uriOrString === 'string' ? vscode.Uri.parse(uriOrString) : uriOrString;
    if (!(uri instanceof vscode.Uri) || uri.scheme !== 'file') {
        vscode.window.showWarningMessage('This command can only be used from the Quick Fix menu for files on disk.');
        return;
    }

    const label = severityLabel(severity);
    const item: ReferenceItem = {
        uri,
        startLine: line,
        suffix: ` ${label}: ${sanitizeMessage(message)}`
    };
    void deliver([item]);
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
 * Add the active editor's file + selected line range(s) to the destination.
 *
 * Invoked from the editor context menu or the Ctrl+Alt+T keybinding.
 * Outputs `filePath:startLine-endLine` plus any diagnostics at the cursor,
 * one entry per cursor/selection (multi-cursor aware).
 */
async function addReference(): Promise<void> {
    const items = await buildEditorItems();
    if (items === undefined) {
        return;
    }
    await deliver(items);
}

/**
 * Add plain file path reference(s).
 *
 * Invoked from the Explorer context menu.
 * Outputs backticked file paths (terminal) or @mentions (DSH), comma-separated
 * for multiple files on the terminal destination and newline-separated on DSH.
 */
function addFileReference(uri?: vscode.Uri, selectedUris?: vscode.Uri[]): void {
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

    void deliver(uris.map(u => ({ uri: u })));
}

export function deactivate() {
    console.log('Add to Terminal extension deactivated');
}
