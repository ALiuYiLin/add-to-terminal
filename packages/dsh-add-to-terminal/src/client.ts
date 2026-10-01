/**
 * dsh-add-to-terminal — Client (page) half (TypeScript source).
 *
 * One SSE connection per browser tab. The tab reports which session it shows
 * and whether its composer is currently writable; when the Host half pushes a
 * reference, this module writes it into the composer draft through the public
 * `inputActions` face of the `conversation.input.left` slot — exactly like
 * typing, never submitting.
 *
 * The connection and the pending queue live at module scope so they survive
 * composer mount/unmount (session switches, blank Hero). Only the draft write
 * needs a mounted composer.
 *
 * Safety rules learned the hard way — this module must never be able to break
 * the page it runs in:
 *   1. `window.__ModuleLoader__` registration is guarded and wrapped, so a
 *      stale replay of the bundle cannot throw into the boot audit.
 *   2. `apply()` never throws.
 *   3. The SSE is opened only after `/ping` proves the bridge is really served
 *      by the backend. Otherwise the SPA fallback would answer with index.html
 *      and EventSource would sit in a hot MIME-error retry loop, eating the
 *      per-origin connection budget the app itself needs.
 *   4. Every reconnect goes through that probe with exponential backoff.
 */
(function registerBridgeClient(): void {
    const loader = window.__ModuleLoader__;
    if (loader === undefined) return;
    // No "already registered" guard: the Host reloads this row on HMR, and a
    // guard would silently leave the updated module inert. A replay of the same
    // bundle is handled by the catch below instead.
    try {
        loader.load({ id: 'dsh-add-to-terminal', factory });
    } catch (error) {
        console.warn('[dsh-add-to-terminal] client registration skipped:', error);
    }

    function factory(require: (name: string) => unknown): unknown {
        const React = require('react') as {
            createElement(type: unknown, props: unknown): unknown;
            useEffect(effect: () => (() => void) | void, deps?: readonly unknown[]): void;
        };

        const ROUTE = '/dsh-add-to-terminal';
        const PING_URL = `${ROUTE}/ping`;
        const TAB_KEY = 'dsh-add-to-terminal.tabId';
        const CLIENT_VERSION = 'ts-0.2.1';
        const MAX_PENDING = 5;
        const PROBE_MIN_MS = 3000;
        const PROBE_MAX_MS = 60000;

        interface BridgeClientState {
            tabId: string;
            es: EventSource | null;
            bound: { sessionId: string | null; inputActions: InputActionsLike } | null;
            draft: string;
            /** Human-readable "which page" label reported to the extension. */
            label: string;
            /** How far the page half got, for remote diagnosis. */
            stage: string;
            /** Last client-side problem, reported to the host for diagnosis. */
            note: string | null;
            pending: BridgeItem[];
            titleObserver: MutationObserver | null;
            flashTimer: ReturnType<typeof setTimeout> | null;
            probeTimer: ReturnType<typeof setTimeout> | null;
            backoffMs: number;
            stopped: boolean;
        }

        function problem(where: string, error: unknown): void {
            const message = error instanceof Error ? error.message : String(error);
            state.note = `${where}: ${message}`.slice(0, 280);
            console.warn(`[dsh-add-to-terminal] ${state.note}`);
        }

        /** Stable per-tab identity: survives reload, distinct per tab. */
        function resolveTabId(): string {
            try {
                const existing = window.sessionStorage?.getItem(TAB_KEY);
                if (existing !== undefined && existing !== null && existing !== '') return existing;
                const created = typeof window.crypto?.randomUUID === 'function'
                    ? window.crypto.randomUUID().replace(/-/g, '').slice(0, 8)
                    : Math.random().toString(36).slice(2, 10);
                window.sessionStorage?.setItem(TAB_KEY, created);
                return created;
            } catch {
                return Math.random().toString(36).slice(2, 10);
            }
        }

        /** Page title without our own flash marker. */
        function pageTitle(): string {
            if (typeof document === 'undefined') return '';
            return String(document.title || '').replace(/^●\s*/, '').trim();
        }

        function baseName(directory: string): string {
            const trimmed = directory.replace(/[\\/]+$/, '');
            const parts = trimmed.split(/[\\/]/);
            return parts.length === 0 ? '' : (parts[parts.length - 1] ?? '');
        }

        /**
         * Label for the page, read from the session it is showing:
         * `<workspace> · <session title>`, degrading to whichever half exists.
         * No browser name and no tab id: the extension disambiguates tabs.
         */
        function labelForSession(meta: SessionMetaLike | undefined | null): string | undefined {
            if (meta === undefined || meta === null) return undefined;
            const workspace = typeof meta.cwd === 'string' ? baseName(meta.cwd) : '';
            const rawTitle = typeof meta.title === 'string' && meta.title.trim() !== ''
                ? meta.title.trim()
                : (typeof meta.displayTitle === 'string' ? meta.displayTitle.trim() : '');
            const title = rawTitle === workspace ? '' : rawTitle;
            if (workspace !== '' && title !== '') return `${workspace} · ${title}`;
            if (title !== '') return title;
            if (workspace !== '') return workspace;
            return undefined;
        }

        const state: BridgeClientState = {
            tabId: resolveTabId(),
            es: null,
            bound: null,
            draft: '',
            label: pageTitle() === '' ? 'DSH 页面' : pageTitle(),
            stage: 'loaded',
            note: null,
            pending: [],
            titleObserver: null,
            flashTimer: null,
            probeTimer: null,
            backoffMs: PROBE_MIN_MS,
            stopped: false,
        };

        function post(path: string, payload: unknown): void {
            try {
                void fetch(`${ROUTE}${path}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    keepalive: true,
                }).catch(() => undefined);
            } catch {
                /* fetch unavailable: the bridge simply reports nothing */
            }
        }

        function present(): void {
            post('/present', {
                tabId: state.tabId,
                label: state.label,
                writable: state.bound !== null,
                sessionId: state.bound === null ? null : state.bound.sessionId,
                client: CLIENT_VERSION,
                stage: state.stage,
                note: state.note,
                focused: typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : true,
                visible: typeof document === 'undefined' ? true : document.visibilityState === 'visible',
            });
        }

        function ack(nonce: string, ok: boolean, reason?: string): void {
            post('/ack', { tabId: state.tabId, nonce, ok, reason });
        }

        function decorate(text: string): string {
            const draft = String(state.draft ?? '');
            return draft !== '' && !/\s$/.test(draft) ? `\n${text}` : text;
        }

        function writeDraft(text: string): boolean {
            const bound = state.bound;
            if (bound === null) return false;
            const actions = bound.inputActions;
            if (actions === null || actions === undefined || typeof actions.insertText !== 'function') return false;
            for (let attempt = 0; attempt < 3; attempt += 1) {
                try {
                    const span = actions.captureInsertion();
                    if (actions.insertText(text, span)) return true;
                } catch {
                    return false;
                }
            }
            return false;
        }

        /**
         * Mark this tab in the browser's tab strip. Bringing a browser window to
         * the front is not reliably possible from a page, so the tab title is the
         * dependable "it landed here" signal.
         */
        function flashTitle(): void {
            if (typeof document === 'undefined') return;
            if (!document.title.startsWith('● ')) document.title = `● ${document.title}`;
            if (state.flashTimer !== null) clearTimeout(state.flashTimer);
            state.flashTimer = setTimeout(() => {
                state.flashTimer = null;
                if (document.title.startsWith('● ')) document.title = document.title.slice(2);
            }, 6000);
        }

        function deliver(nonce: string, text: string): boolean {
            const ok = writeDraft(decorate(text));
            if (ok) flashTitle();
            ack(nonce, ok, ok ? undefined : 'insert-failed');
            return ok;
        }

        function flushPending(): void {
            if (state.bound === null || state.pending.length === 0) return;
            const items = state.pending.splice(0, state.pending.length);
            for (const item of items) deliver(item.nonce, item.text);
        }

        function enqueue(nonce: string, text: string): void {
            state.pending.push({ nonce, text });
            while (state.pending.length > MAX_PENDING) {
                const dropped = state.pending.shift();
                if (dropped !== undefined) ack(dropped.nonce, false, 'no-composer');
            }
        }

        // ------------------------------------------------------- connection --

        function scheduleProbe(): void {
            if (state.stopped || state.probeTimer !== null) return;
            const delay = state.backoffMs;
            state.backoffMs = Math.min(state.backoffMs * 2, PROBE_MAX_MS);
            state.probeTimer = setTimeout(() => {
                state.probeTimer = null;
                void probeAndConnect();
            }, delay);
        }

        /**
         * Only open a stream once the backend confirms it serves the bridge.
         * Without this, a page whose backend has no bridge (plugin disabled or
         * not yet applied) would hammer the SPA fallback forever.
         */
        async function probeAndConnect(): Promise<void> {
            if (state.stopped || state.es !== null) return;
            let ready = false;
            try {
                const response = await fetch(PING_URL, { cache: 'no-store' });
                if (response.ok) {
                    const payload = await response.json() as { bridge?: unknown } | null;
                    ready = payload !== null && payload.bridge === 'dsh-add-to-terminal';
                }
            } catch {
                ready = false;
            }
            if (state.stopped) return;
            if (!ready) {
                scheduleProbe();
                return;
            }
            state.backoffMs = PROBE_MIN_MS;
            openStream();
        }

        function openStream(): void {
            if (state.es !== null || state.stopped) return;
            let es: EventSource;
            try {
                es = new EventSource(`${ROUTE}/stream?tabId=${encodeURIComponent(state.tabId)}`);
            } catch {
                scheduleProbe();
                return;
            }
            state.es = es;
            es.addEventListener('hello', () => {
                present();
                flushPending();
            });
            es.addEventListener('open', () => {
                state.backoffMs = PROBE_MIN_MS;
                present();
            });
            es.addEventListener('item', (event: MessageEvent) => {
                let payload: BridgeItem | null = null;
                try {
                    payload = JSON.parse(String(event.data)) as BridgeItem;
                } catch {
                    return;
                }
                if (payload === null || typeof payload !== 'object' || typeof payload.text !== 'string') return;
                const nonce = typeof payload.nonce === 'string' ? payload.nonce : '';
                if (state.bound === null) enqueue(nonce, payload.text);
                else deliver(nonce, payload.text);
            });
            // Take reconnection into our own hands: close and re-probe with
            // backoff instead of letting the browser retry in a tight loop.
            es.onerror = () => {
                try {
                    es.close();
                } catch {
                    /* already closed */
                }
                if (state.es === es) state.es = null;
                scheduleProbe();
            };
        }

        function watchTitle(): void {
            if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
            const titleElement = document.querySelector('title');
            if (titleElement === null) return;
            state.titleObserver = new MutationObserver(() => {
                // With no bound session the page title is all we have to show.
                if (state.bound === null) {
                    const next = pageTitle() === '' ? 'DSH 页面' : pageTitle();
                    if (next !== state.label) state.label = next;
                }
                present();
            });
            state.titleObserver.observe(titleElement, { childList: true, characterData: true, subtree: true });
        }

        // ------------------------------------------------------------ seat ----

        const fallbackInputHook = <S,>(selector: (snapshot: InputStateLike) => S): S => selector({ draft: '' });
        const fallbackSessionsHook = <S,>(selector: (snapshot: SessionsSnapshotLike) => S): S => selector({ byId: {} });

        /** Side-effect-free seat: reports writability and owns the draft binding. */
        function BridgeSeat(props: SeatProps): null {
            const selectDraft = typeof props.useInput === 'function' ? props.useInput : fallbackInputHook;
            let draft = '';
            try {
                draft = selectDraft((snapshot) => (snapshot === null || snapshot === undefined ? '' : String(snapshot.draft ?? '')));
            } catch (error) {
                problem('useInput', error);
            }

            const sessionId = props.sessionId ?? '';
            const selectSessions = typeof props.useSessions === 'function' ? props.useSessions : fallbackSessionsHook;
            let sessionLabel: string | undefined;
            try {
                const meta = selectSessions((snapshot) => (snapshot === null || snapshot === undefined ? null : snapshot.byId?.[sessionId] ?? null));
                sessionLabel = labelForSession(meta);
            } catch (error) {
                problem('useSessions', error);
            }

            React.useEffect(() => {
                try {
                    state.draft = typeof draft === 'string' ? draft : '';
                } catch (error) {
                    problem('draft effect', error);
                }
            }, [draft]);

            // Runs before the bind effect, so its present() already carries this label.
            React.useEffect(() => {
                try {
                    const next = sessionLabel ?? (pageTitle() === '' ? 'DSH 页面' : pageTitle());
                    if (next !== state.label) {
                        state.label = next;
                        present();
                    }
                } catch (error) {
                    problem('label effect', error);
                }
            }, [sessionLabel]);

            React.useEffect(() => {
                try {
                    state.bound = props.inputActions === undefined
                        ? null
                        : { sessionId: props.sessionId ?? null, inputActions: props.inputActions };
                    state.stage = props.inputActions === undefined ? 'seated-no-actions' : 'seated';
                    console.info(`[dsh-add-to-terminal] seat mounted (${state.stage})`);
                    present();
                    flushPending();
                } catch (error) {
                    problem('bind effect', error);
                }
                return () => {
                    try {
                        if (state.bound !== null && state.bound.sessionId === (props.sessionId ?? null)) state.bound = null;
                        state.stage = 'unseated';
                        console.info('[dsh-add-to-terminal] seat unmounted');
                        present();
                    } catch (error) {
                        problem('unbind effect', error);
                    }
                };
            }, [props.sessionId, props.inputActions]);

            return null;
        }

        // ------------------------------------------------------------ apply ---

        interface ClientContext {
            slots?: {
                inject(key: string, callback: () => unknown): unknown;
                register(options: Record<string, unknown>, component: unknown): () => void;
            };
        }

        function start(ctx: ClientContext): () => void {
            const onFocusChange = (): void => {
                present();
            };
            window.addEventListener('focus', onFocusChange);
            window.addEventListener('blur', onFocusChange);
            document.addEventListener('visibilitychange', onFocusChange);
            watchTitle();
            // First probe immediately (cheap, async); only retries back off.
            void probeAndConnect();

            let disposeSeat: (() => void) | undefined;
            if (ctx.slots === undefined) {
                state.stage = 'no-slots-service';
                problem('apply', new Error('ctx.slots is unavailable'));
            } else {
                const injected = ctx.slots.inject('conversation.input.left', () => {
                    state.stage = 'slot-registered';
                    console.info('[dsh-add-to-terminal] composer seat registered');
                    return ctx.slots?.register(
                        { name: 'conversation.input.left', id: 'dsh-add-to-terminal', order: 95 },
                        (props: SeatProps) => React.createElement(BridgeSeat, props),
                    );
                });
                disposeSeat = typeof injected === 'function' ? (injected as () => void) : undefined;
            }
            state.stage = state.stage === 'loaded' ? 'applied' : state.stage;

            return () => {
                window.removeEventListener('focus', onFocusChange);
                window.removeEventListener('blur', onFocusChange);
                document.removeEventListener('visibilitychange', onFocusChange);
                if (disposeSeat !== undefined) {
                    try {
                        disposeSeat();
                    } catch {
                        /* already disposed */
                    }
                }
                if (state.titleObserver !== null) {
                    state.titleObserver.disconnect();
                    state.titleObserver = null;
                }
                if (state.flashTimer !== null) {
                    clearTimeout(state.flashTimer);
                    state.flashTimer = null;
                }
                if (state.probeTimer !== null) {
                    clearTimeout(state.probeTimer);
                    state.probeTimer = null;
                }
                if (state.es !== null) {
                    try {
                        state.es.close();
                    } catch {
                        /* already closed */
                    }
                    state.es = null;
                }
                state.bound = null;
                state.pending.length = 0;
            };
        }

        function apply(ctx: ClientContext): () => void {
            let stop: (() => void) | undefined;
            try {
                stop = start(ctx);
            } catch (error) {
                problem('apply', error);
                console.warn('[dsh-add-to-terminal] client half inactive:', error);
            }
            return () => {
                try {
                    stop?.();
                } catch {
                    /* ignore */
                }
            };
        }

        const module = { exports: {} as Record<string, unknown> };
        module.exports.name = 'dsh-add-to-terminal';
        module.exports.inject = ['slots'];
        module.exports.apply = apply;
        return module.exports;
    }
})();
