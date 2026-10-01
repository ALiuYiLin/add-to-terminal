import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** Outcome of one delivery attempt, ready to show to the user. */
export interface SinkResult {
    ok: boolean;
    detail: string;
    /**
     * The push reached DSH but the page never confirmed the draft write.
     * Retrying through another destination could duplicate the reference, so
     * callers must not silently fall back.
     */
    uncertain?: boolean;
    /**
     * DSH is simply not in play: no bridge discovered, or no page open. This is
     * the normal state for a terminal-only user, so callers fall back quietly
     * instead of reporting a failure.
     */
    unavailable?: boolean;
}

export interface Sink {
    send(...args: never[]): Promise<SinkResult>;
}

/** Route prefix owned by the DSH-side bridge plugin. */
const ROUTE = '/dsh-add-to-terminal';
const TOKEN_HEADER = 'x-dsh-bridge-token';
/** Remembered target tab, so a reconnect keeps the same DSH page selected. */
export const TARGET_KEY = 'addToTerminal.dshTargetTabId';
/**
 * Set when the user explicitly disconnects DSH for this workspace: references
 * then go straight to the terminal, without probing the bridge at all.
 */
export const DISCONNECTED_KEY = 'addToTerminal.dshDisconnected';
export const TARGETS_COMMAND = 'addToTerminal.connectTarget';
export const DISCONNECT_COMMAND = 'addToTerminal.disconnectTarget';

export interface BridgeInfo {
    url: string;
    token: string;
}

export interface DshTarget {
    tabId: string;
    label?: string;
    writable?: boolean;
    sessionId?: string | null;
    focused?: boolean;
    connectedAt?: number;
    lastFocusAt?: number;
}

/** The discovery file the DSH bridge writes on startup. */
export function bridgeFilePath(): string {
    return path.join(os.tmpdir(), 'dsh-add-to-terminal', 'bridge.json');
}

export function readBridgeInfo(): BridgeInfo | undefined {
    try {
        const raw = fs.readFileSync(bridgeFilePath(), 'utf8');
        const parsed = JSON.parse(raw) as { url?: unknown; token?: unknown };
        if (typeof parsed.url === 'string' && parsed.url !== '' && typeof parsed.token === 'string' && parsed.token !== '') {
            return { url: parsed.url, token: parsed.token };
        }
    } catch {
        // Missing or stale discovery file: the configured URL/token is the fallback.
    }
    return undefined;
}

/** Bridge endpoint, from the discovery file with configured overrides. */
export function resolveBridge(): BridgeInfo | undefined {
    const config = vscode.workspace.getConfiguration('addToTerminal');
    const configuredUrl = (config.get<string>('dshUrl', '') ?? '').trim();
    const configuredToken = (config.get<string>('dshToken', '') ?? '').trim();
    const info = readBridgeInfo();
    const url = configuredUrl !== '' ? configuredUrl : info?.url;
    const token = configuredToken !== '' ? configuredToken : info?.token;
    if (url === undefined || token === undefined || url === '' || token === '') {
        return undefined;
    }
    return { url: url.replace(/\/+$/, ''), token };
}

/** Every DSH page currently connected to the bridge. */
export async function listTargets(): Promise<
    { ok: true; targets: DshTarget[] } | { ok: false; detail: string; unavailable: boolean }
> {
    const bridge = resolveBridge();
    if (bridge === undefined) {
        return {
            ok: false,
            unavailable: true,
            detail: `未发现 DSH 桥接（${bridgeFilePath()}）—— 引用会直接发到终端。`,
        };
    }
    try {
        const listed = await httpJson(`${bridge.url}${ROUTE}/targets`, { method: 'GET', token: bridge.token, timeoutMs: 1200 });
        if (listed.status === 401) {
            return { ok: false, unavailable: false, detail: 'DSH 桥接令牌不匹配（bridge.json 可能已过期）。' };
        }
        if (listed.status !== 200 || listed.json?.ok !== true) {
            return { ok: false, unavailable: false, detail: `DSH 桥接响应异常（HTTP ${listed.status}）。` };
        }
        return { ok: true, targets: Array.isArray(listed.json.targets) ? (listed.json.targets as DshTarget[]) : [] };
    } catch (error) {
        // A dead port usually means DSH was closed: treat it as "not in play".
        return { ok: false, unavailable: true, detail: `无法连接 DSH（${bridge.url}）：${messageOf(error)}` };
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function httpJson(
    url: string,
    options: { method: string; token?: string; body?: unknown; timeoutMs: number }
): Promise<{ status: number; json?: any }> {
    return new Promise((resolve, reject) => {
        let target: URL;
        try {
            target = new URL(url);
        } catch {
            reject(new Error(`无效的 DSH 地址：${url}`));
            return;
        }
        if (target.protocol !== 'http:') {
            reject(new Error(`暂不支持的协议：${target.protocol}`));
            return;
        }
        const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), 'utf8');
        const headers: Record<string, string | number> = {};
        if (options.token) {
            headers[TOKEN_HEADER] = options.token;
        }
        if (payload) {
            headers['content-type'] = 'application/json';
            headers['content-length'] = payload.length;
        }
        const request = http.request(
            {
                hostname: target.hostname,
                port: target.port === '' ? 80 : Number(target.port),
                path: `${target.pathname}${target.search}`,
                method: options.method,
                headers,
                timeout: options.timeoutMs,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on('data', (chunk: Buffer) => chunks.push(chunk));
                response.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let json: any;
                    try {
                        json = JSON.parse(text);
                    } catch {
                        json = undefined;
                    }
                    resolve({ status: response.statusCode ?? 0, json });
                });
            }
        );
        request.on('timeout', () => request.destroy(new Error('请求超时')));
        request.on('error', reject);
        if (payload) {
            request.write(payload);
        }
        request.end();
    });
}

/** Sends text to a terminal without executing it (existing behaviour). */
export class TerminalSink {
    private lastActiveTerminal: vscode.Terminal | undefined;

    constructor(context: vscode.ExtensionContext) {
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTerminal((terminal) => {
                this.lastActiveTerminal = terminal;
            }),
            vscode.window.onDidCloseTerminal((terminal) => {
                if (this.lastActiveTerminal === terminal) {
                    this.lastActiveTerminal = undefined;
                }
            })
        );
    }

    private resolveTerminal(): vscode.Terminal {
        if (this.lastActiveTerminal) {
            return this.lastActiveTerminal;
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

    async send(text: string): Promise<SinkResult> {
        try {
            const terminal = this.resolveTerminal();
            terminal.show();
            terminal.sendText(text, false);
            return { ok: true, detail: '已发送到终端' };
        } catch (error) {
            return { ok: false, detail: `发送到终端失败：${messageOf(error)}` };
        }
    }
}

/**
 * Delivers text into the composer draft of a DSH Web page: finds the pages the
 * DSH bridge reports, picks a target, asks it for its session cwd (so relative
 * references are only used when they resolve), then pushes the rendered text.
 */
export class DshSink {
    constructor(private readonly context: vscode.ExtensionContext) {}

    private config() {
        return vscode.workspace.getConfiguration('addToTerminal');
    }

    /** True when the user disconnected DSH for this workspace (terminal-only). */
    isDisconnected(): boolean {
        return this.context.workspaceState.get<boolean>(DISCONNECTED_KEY) === true;
    }

    /** Disconnect (`true`) or reconnect (`false`); disconnecting also drops the remembered target. */
    async setDisconnected(value: boolean): Promise<void> {
        await this.context.workspaceState.update(DISCONNECTED_KEY, value);
        if (value) {
            await this.context.workspaceState.update(TARGET_KEY, undefined);
        }
    }

    private chooseTarget(targets: DshTarget[]): { target: DshTarget } | { error: string } {
        if (targets.length === 0) {
            return { error: 'DSH Web 页面未打开（没有已连接的标签页）。' };
        }
        const remembered = this.context.workspaceState.get<string>(TARGET_KEY);
        const rememberedTarget = remembered === undefined ? undefined : targets.find((t) => t.tabId === remembered);
        if (rememberedTarget !== undefined && rememberedTarget.writable !== false) {
            return { target: rememberedTarget };
        }
        const writable = targets.filter((t) => t.writable !== false);
        if (writable.length === 1) {
            return { target: writable[0] };
        }
        if (writable.length > 1) {
            const sorted = writable
                .slice()
                .sort((a, b) => ((b.lastFocusAt ?? 0) - (a.lastFocusAt ?? 0)) || ((b.connectedAt ?? 0) - (a.connectedAt ?? 0)));
            return { target: sorted[0] };
        }
        if (targets.length === 1) {
            return { target: targets[0] };
        }
        return { error: '当前没有可写入的 DSH 页面（都停在无输入框的界面）。' };
    }

    private reasonText(reason: unknown): string {
        switch (reason) {
            case 'no-page':
                return 'DSH Web 页面未打开（没有已连接的标签页）。';
            case 'no-writable-page':
                return '当前没有可写入的 DSH 页面（都停在无输入框的界面）。';
            case 'not-connected':
                return '目标 DSH 标签页已断开。';
            case 'not-writable':
                return '目标 DSH 页面当前没有输入框（未选择会话或正在提交）。';
            case 'no-ack':
                return '已推送到 DSH，但未收到插入确认（页面可能正在提交）。';
            case 'insert-failed':
                return 'DSH 输入框拒绝了这次插入。';
            case 'text-too-long':
                return '内容过长，DSH 桥接已拒绝。';
            default:
                return `DSH 投递被拒绝（${String(reason ?? 'unknown')}）。`;
        }
    }

    async send(render: (cwd: string | undefined) => string, options: { tabId?: string } = {}): Promise<SinkResult> {
        const bridge = resolveBridge();
        if (bridge === undefined) {
            return {
                ok: false,
                unavailable: true,
                detail: `未发现 DSH 桥接（${bridgeFilePath()}）—— 引用会直接发到终端。`,
            };
        }

        let targets: DshTarget[];
        try {
            const listed = await httpJson(`${bridge.url}${ROUTE}/targets`, { method: 'GET', token: bridge.token, timeoutMs: 1200 });
            if (listed.status === 401) {
                return { ok: false, detail: 'DSH 桥接令牌不匹配（bridge.json 可能已过期）。' };
            }
            if (listed.status !== 200 || listed.json?.ok !== true) {
                return { ok: false, detail: `DSH 桥接响应异常（HTTP ${listed.status}）。` };
            }
            targets = Array.isArray(listed.json.targets) ? (listed.json.targets as DshTarget[]) : [];
        } catch (error) {
            return { ok: false, unavailable: true, detail: `无法连接 DSH（${bridge.url}）：${messageOf(error)}` };
        }

        if (targets.length === 0) {
            return { ok: false, unavailable: true, detail: '没有打开的 DSH 页面。' };
        }

        let target: DshTarget;
        if (options.tabId !== undefined) {
            const explicit = targets.find((entry) => entry.tabId === options.tabId);
            if (explicit === undefined) {
                return { ok: false, detail: '目标 DSH 页面已断开（不再出现在桥接列表里）。' };
            }
            target = explicit;
        } else {
            const chosen = this.chooseTarget(targets);
            if ('error' in chosen) {
                return { ok: false, detail: chosen.error };
            }
            target = chosen.target;
        }

        let cwd: string | undefined;
        try {
            const context = await httpJson(
                `${bridge.url}${ROUTE}/context?tabId=${encodeURIComponent(target.tabId)}`,
                { method: 'GET', token: bridge.token, timeoutMs: 800 }
            );
            if (context.status === 200 && typeof context.json?.cwd === 'string') {
                cwd = context.json.cwd;
            }
        } catch {
            cwd = undefined;
        }

        const text = render(cwd);
        if (text.trim() === '') {
            return { ok: false, detail: '没有可投递的内容。' };
        }
        const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

        let pushed: { status: number; json?: any };
        try {
            pushed = await httpJson(`${bridge.url}${ROUTE}/push`, {
                method: 'POST',
                token: bridge.token,
                timeoutMs: 4000,
                body: { tabId: target.tabId, text, nonce },
            });
        } catch (error) {
            return { ok: false, detail: `投递失败：${messageOf(error)}` };
        }

        const json = pushed.json;
        if (pushed.status === 200 && json?.ok === true && json.delivered === true) {
            void this.context.workspaceState.update(TARGET_KEY, target.tabId);
            if (this.config().get<boolean>('dshFocus', false)) {
                // Bare origin only: a fragment (e.g. #dsh-focus=<nonce>) makes the
                // browser treat it as a different URL and open ANOTHER tab.
                void vscode.env.openExternal(vscode.Uri.parse(bridge.url)).then(undefined, () => undefined);
            }
            const label = typeof json.label === 'string' && json.label !== '' ? json.label : target.label ?? target.tabId;
            return { ok: true, detail: `已插入 DSH 输入框（${label}）` };
        }
        const reason = json?.reason;
        return {
            ok: false,
            detail: this.reasonText(reason),
            uncertain: reason === 'no-ack',
            /* The page closed between the listing and the push: still "not in play". */
            unavailable: reason === 'no-page',
        };
    }
}
