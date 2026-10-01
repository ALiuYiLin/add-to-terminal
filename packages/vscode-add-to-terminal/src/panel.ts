import * as vscode from 'vscode';
import { DISCONNECT_COMMAND, DshTarget, TARGET_KEY, TARGETS_COMMAND, listTargets } from './sink';

export const VIEW_ID = 'addToTerminal.targets';
export const REFRESH_COMMAND = 'addToTerminal.refreshTargets';
export const SELECT_COMMAND = 'addToTerminal.selectTarget';

/** One row of the DSH page list, or the empty-state row. */
type TargetsNode =
    | { kind: 'target'; target: DshTarget }
    | { kind: 'empty'; text: string; hint?: string };

/** What the panel needs from the extension: deliver the current selection, and the disconnect switch. */
export interface DshPanelHost {
    deliverSelection(tabId: string): Promise<void>;
    /** True when DSH is disconnected for this workspace (references go to the terminal). */
    isDshOff(): boolean;
    /** Disconnect (`true`) or reconnect (`false`). */
    setDshOff(value: boolean): Promise<void>;
}

/**
 * The sidebar list of DSH pages that are currently open in a browser. Clicking
 * a row makes it the target and immediately delivers the editor selection to
 * that exact page (the extension then also brings the browser forward).
 *
 * The bridge only knows about pages that hold a live SSE connection, so the
 * list is empty until DSH Web is open — which is also the only state in which
 * a delivery can land in an input box. A user who never opens DSH Web is not in
 * an error state: the panel says so calmly and references keep going to the
 * terminal, and 断开 (the title-bar button, a row button, or the Quick Pick)
 * makes that explicit and stops probing the bridge.
 */
export class DshPanel implements vscode.TreeDataProvider<TargetsNode> {
    private readonly changed = new vscode.EventEmitter<void>();
    private readonly status: vscode.StatusBarItem;
    private targets: DshTarget[] = [];
    private problem: string | undefined;
    private problemIsFatal = false;
    private timer: NodeJS.Timeout | undefined;
    private view: vscode.TreeView<TargetsNode> | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly host: DshPanelHost
    ) {
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
        this.status.command = SELECT_COMMAND;
    }

    readonly onDidChangeTreeData = this.changed.event;

    // ------------------------------------------------------------ tree data --

    getChildren(): TargetsNode[] {
        if (this.targets.length === 0) {
            if (this.host.isDshOff()) {
                return [{
                    kind: 'empty',
                    text: '已断开 · 只发到终端',
                    hint: '引用直接发给终端；点这里或状态栏可以重新选择 DSH 页面',
                }];
            }
            return [{
                kind: 'empty',
                text: this.problem === undefined ? '只发到终端' : 'DSH 暂不可用 · 只发到终端',
                hint: this.problem ?? '在浏览器里打开 DSH Web 后会自动出现；只发到终端也可以',
            }];
        }
        return this.targets.map((target) => ({ kind: 'target', target }));
    }

    getTreeItem(node: TargetsNode): vscode.TreeItem {
        if (node.kind === 'empty') {
            const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
            item.description = node.hint;
            item.iconPath = new vscode.ThemeIcon(this.host.isDshOff() ? 'debug-disconnect' : 'info');
            item.contextValue = 'dshEmpty';
            item.tooltip = node.hint;
            /* Clicking the empty row opens the target picker: the way back from "只发到终端". */
            item.command = { command: SELECT_COMMAND, title: '选择 DSH 页面' };
            return item;
        }

        const target = node.target;
        const current = this.rememberedTabId() === target.tabId;
        const item = new vscode.TreeItem(target.label ?? target.tabId, vscode.TreeItemCollapsibleState.None);
        const state = target.writable === false ? '无输入框' : '可写';
        // "当前目标" is what Ctrl+Alt+T delivers to right now.
        item.description = current ? `当前目标 · ${state}` : state;
        item.iconPath = new vscode.ThemeIcon(current ? 'plug' : (target.writable === false ? 'circle-slash' : 'circle-filled'));
        item.contextValue = current ? 'dshTargetCurrent' : 'dshTarget';
        item.tooltip = [
            target.label ?? target.tabId,
            `状态：${target.writable === false ? '当前没有输入框（未选择会话或正在提交）' : '可写入输入框'}`,
            `tabId：${target.tabId}`,
            target.sessionId === null || target.sessionId === undefined ? '会话：未报告' : `会话：${target.sessionId}`,
            current ? '当前目标：单击重新投递；行尾插头图标可断开' : '单击连接这个 DSH 页面',
        ].join('\n');
        // Clicking connects this page: set as target, deliver, bring forward.
        item.command = { command: TARGETS_COMMAND, title: '连接这个 DSH 页面', arguments: [target.tabId] };
        return item;
    }

    // ------------------------------------------------------------- lifecycle --

    start(intervalMs = 3000): void {
        this.view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: this, showCollapseAll: false });
        this.context.subscriptions.push(
            this.view,
            this.status,
            this.changed,
            this.view.onDidChangeVisibility((event) => {
                if (event.visible) {
                    void this.refresh();
                    this.schedule(intervalMs);
                } else {
                    this.stopTimer();
                }
            })
        );
        void this.refresh();
        this.schedule(intervalMs);
    }

    private schedule(intervalMs: number): void {
        this.stopTimer();
        this.timer = setInterval(() => {
            void this.refresh();
        }, intervalMs);
    }

    private stopTimer(): void {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    async refresh(): Promise<void> {
        if (this.host.isDshOff()) {
            /* Disconnected: don't even probe the bridge. */
            this.targets = [];
            this.problem = undefined;
            this.problemIsFatal = false;
            this.changed.fire();
            this.renderStatus();
            return;
        }
        const listed = await listTargets();
        if (listed.ok) {
            this.targets = listed.targets;
            this.problem = undefined;
            this.problemIsFatal = false;
        } else {
            this.targets = [];
            this.problem = listed.detail;
            this.problemIsFatal = !listed.unavailable;
        }
        this.changed.fire();
        this.renderStatus();
    }

    // ---------------------------------------------------------------- target --

    targetsSnapshot(): DshTarget[] {
        return this.targets;
    }

    rememberedTabId(): string | undefined {
        return this.context.workspaceState.get<string>(TARGET_KEY);
    }

    async setTarget(tabId: string): Promise<void> {
        /* Connecting after a disconnect re-enables the DSH destination. */
        if (this.host.isDshOff()) {
            await this.host.setDshOff(false);
        }
        await this.context.workspaceState.update(TARGET_KEY, tabId);
        this.renderStatus();
    }

    async disconnect(): Promise<void> {
        await this.host.setDshOff(true);
        await this.refresh();
    }

    /** The page Ctrl+Alt+T would use right now. */
    activeTarget(): DshTarget | undefined {
        const remembered = this.rememberedTabId();
        return this.targets.find((target) => target.tabId === remembered)
            ?? this.targets.find((target) => target.writable !== false);
    }

    private renderStatus(): void {
        const off = this.host.isDshOff();
        const active = off ? undefined : this.activeTarget();

        if (off) {
            this.status.text = '$(terminal) 只发到终端';
            this.status.tooltip = '已断开 DSH：引用直接发给终端。点击可选择 DSH 页面并重新连接。';
        } else if (this.targets.length === 0) {
            /* Terminal-only is a normal state, not an error. */
            this.status.text = '$(terminal) 只发到终端';
            this.status.tooltip = this.problem === undefined
                ? '没有打开的 DSH 页面：引用直接发给终端。在浏览器打开 DSH Web 后这里会出现它。'
                : `${this.problem}\n${this.problemIsFatal ? '点击可重试或选择 DSH 页面。' : '引用会直接发给终端。'}`;
        } else if (active === undefined) {
            this.status.text = '$(warning) DSH 无可写入页面';
            this.status.tooltip = '已连接的 DSH 页面当前都没有输入框';
        } else {
            /* 工作区 · 标题 —— the bridge composes the label; no browser name. */
            this.status.text = `$(plug) DSH: ${active.label ?? active.tabId}`;
            this.status.tooltip = `${active.label ?? active.tabId}\n点击选择目标页面或断开 DSH`;
        }
        this.status.show();
    }
}

/**
 * Register the panel, its commands and its status bar entry.
 * `host.deliverSelection` performs the actual delivery to one exact page;
 * `host.isDshOff` / `host.setDshOff` own the "只能发终端" switch.
 */
export function registerDshPanel(context: vscode.ExtensionContext, host: DshPanelHost): DshPanel {
    const panel = new DshPanel(context, host);

    /** Quick Pick entry that turns DSH off; shown while DSH is in play. */
    const disconnectItem = {
        label: '$(debug-disconnect) 断开 DSH · 只发到终端',
        description: '不再投递到页面，直接发给终端',
        detail: '可以随时点击这里重新连接',
        disconnect: true as const,
    };

    context.subscriptions.push(
        vscode.commands.registerCommand(TARGETS_COMMAND, async (tabId: unknown) => {
            if (typeof tabId !== 'string' || tabId === '') {
                return;
            }
            await panel.setTarget(tabId);
            await host.deliverSelection(tabId);
            await panel.refresh();
        }),
        vscode.commands.registerCommand(REFRESH_COMMAND, async () => {
            await panel.refresh();
        }),
        vscode.commands.registerCommand(DISCONNECT_COMMAND, async () => {
            await panel.disconnect();
            vscode.window.setStatusBarMessage('Add to Terminal：已断开 DSH，引用将只发到终端', 4000);
        }),
        vscode.commands.registerCommand(SELECT_COMMAND, async () => {
            const off = host.isDshOff();
            if (off) {
                await host.setDshOff(false);
            }
            await panel.refresh();
            const targets = panel.targetsSnapshot();
            const items = [
                ...(targets.length === 0 && !off ? [] : [disconnectItem]),
                ...targets.map((target) => ({
                    label: target.label ?? target.tabId,
                    description: target.writable === false ? '无输入框' : '可写',
                    detail: `tabId ${target.tabId}`,
                    tabId: target.tabId,
                    disconnect: false as const,
                })),
            ];
            if (items.length === 0) {
                await host.setDshOff(true);
                await panel.refresh();
                vscode.window.showInformationMessage(
                    '没有已连接的 DSH 页面：引用将只发到终端。在浏览器里打开 DSH Web 后会自动出现在这里。'
                );
                return;
            }
            const picked = await vscode.window.showQuickPick(items, {
                title: 'DSH 投递目标',
                placeHolder: '选中的页面会成为投递目标，并把当前选区投过去；也可以断开，只发到终端',
            });
            if (picked === undefined) {
                return;
            }
            if (picked.disconnect === true) {
                await panel.disconnect();
                vscode.window.setStatusBarMessage('Add to Terminal：已断开 DSH，引用将只发到终端', 4000);
                return;
            }
            await panel.setTarget(picked.tabId);
            await host.deliverSelection(picked.tabId);
            await panel.refresh();
        })
    );

    panel.start();
    return panel;
}
