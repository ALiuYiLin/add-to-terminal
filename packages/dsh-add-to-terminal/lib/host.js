/**
 * dsh-add-to-terminal — Host half (TypeScript source).
 *
 * A loopback-only rendezvous between the "Add to Terminal" VS Code extension
 * and every open DSH Web page:
 *
 *   VS Code extension --POST /push--> this plugin --SSE--> DSH Web page
 *                                                        (writes the
 *                                                         composer draft)
 *
 * The extension reads `os.tmpdir()/dsh-add-to-terminal/bridge.json` for the
 * Web server URL and this process's bearer token, so nothing has to be
 * configured by hand and a random Web port still works.
 *
 * Endpoints (all under `/dsh-add-to-terminal`):
 *   GET  /ping      any: "is the bridge behind this URL?" (used by the page
 *                   half before it opens a stream, so a page can never sit in
 *                   a hot SSE retry loop against a server that has no bridge)
 *   GET  /targets   extension: list connected pages           (token)
 *   GET  /context   extension: the target page's session cwd   (token)
 *   POST /push      extension: deliver text to one page        (token)
 *   GET  /stream    page: SSE connection for one tab
 *   POST /present   page: report label / writability / focus
 *   POST /ack       page: confirm the draft write
 *
 * Trust model: the Web server carries no authentication or origin policy of
 * its own, so this route owns both. Extension endpoints require the bearer
 * token and reject any request that carries an `Origin` (a browser could
 * otherwise post cross-origin without a preflight). Page endpoints require a
 * same-origin request. Nothing here can submit a prompt: the page only writes
 * the draft, exactly like typing.
 *
 * Boot reliability: only `webServer` is a hard dependency, so the routes go up
 * as early as possible; the session query service is optional and only read
 * for the advisory `/context` answer.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const ROUTE = '/dsh-add-to-terminal';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_CHARS = 20_000;
const ACK_TIMEOUT_MS = 2500;
const SSE_PING_MS = 25_000;
const TOKEN_HEADER = 'x-dsh-bridge-token';
export const name = 'dsh-add-to-terminal';
export function apply(ctx) {
    const resolved = ctx.get('webServer');
    if (resolved === undefined) {
        console.warn('[dsh-add-to-terminal] webServer service unavailable; bridge disabled');
        return;
    }
    // Non-optional alias so nested helpers type-check on older TS narrowing rules.
    const webServer = resolved;
    /**
     * The optional session query service, resolved per request: it is not a
     * hard dependency, so it may appear after this row is applied.
     */
    function sessionQueryService() {
        return ctx.get('sessionQuery');
    }
    const token = crypto.randomBytes(24).toString('hex');
    const connections = new Map();
    const pendingAcks = new Map();
    // Overridable so a test run can never clobber a live instance's discovery file.
    const discoveryFile = process.env.DSH_ADD_TO_TERMINAL_BRIDGE_FILE
        ?? path.join(os.tmpdir(), 'dsh-add-to-terminal', 'bridge.json');
    let pingTimer = null;
    let discoveryTimer = null;
    let discoveryRetry = null;
    let stopped = false;
    // ------------------------------------------------------------- helpers --
    function sendJson(res, status, payload) {
        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        try {
            res.writeHead(status, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': String(body.length),
                'Cache-Control': 'no-store',
            });
            res.end(body);
        }
        catch {
            /* socket already gone */
        }
    }
    function readJsonBody(req) {
        return new Promise((resolve) => {
            const chunks = [];
            let size = 0;
            let settled = false;
            const finish = (value) => {
                if (settled)
                    return;
                settled = true;
                resolve(value);
            };
            req.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_BODY_BYTES) {
                    finish(undefined);
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on('error', () => finish(undefined));
            req.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if (text.trim() === '')
                    return finish({});
                try {
                    const parsed = JSON.parse(text);
                    finish(parsed !== null && typeof parsed === 'object' ? parsed : undefined);
                }
                catch {
                    finish(undefined);
                }
            });
        });
    }
    /** Page-facing endpoints accept only same-origin (or origin-less) requests. */
    function sameOrigin(req) {
        const origin = req.headers.origin;
        if (origin === undefined || origin === '')
            return true;
        try {
            return new URL(origin).host === req.headers.host;
        }
        catch {
            return false;
        }
    }
    /** Extension-facing endpoints: bearer token and never a browser Origin. */
    function fromExtension(req) {
        if (req.headers.origin !== undefined)
            return false;
        const presented = req.headers[TOKEN_HEADER];
        if (typeof presented !== 'string' || presented.length !== token.length)
            return false;
        try {
            return crypto.timingSafeEqual(Buffer.from(presented, 'utf8'), Buffer.from(token, 'utf8'));
        }
        catch {
            return false;
        }
    }
    function queryOf(req) {
        return new URL(req.url ?? '/', 'http://localhost').searchParams;
    }
    function textOf(value, max) {
        return typeof value === 'string' ? value.slice(0, max) : '';
    }
    // -------------------------------------------------------- registry -------
    function liveConnections() {
        const list = [];
        for (const conn of connections.values()) {
            if (!conn.closed)
                list.push(conn);
        }
        return list;
    }
    function targetSummary(conn) {
        return {
            tabId: conn.tabId,
            label: conn.label,
            writable: conn.writable,
            sessionId: conn.sessionId,
            client: conn.client,
            stage: conn.stage,
            note: conn.note,
            focused: conn.focused,
            connectedAt: conn.connectedAt,
            lastFocusAt: conn.lastFocusAt,
        };
    }
    function handlePing(req, res) {
        if (req.method !== 'GET')
            return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        sendJson(res, 200, { ok: true, bridge: 'dsh-add-to-terminal', route: ROUTE, time: Date.now() });
    }
    function handleStream(req, res) {
        if (req.method !== 'GET')
            return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!sameOrigin(req))
            return sendJson(res, 403, { ok: false, error: 'cross-origin' });
        const tabId = textOf(queryOf(req).get('tabId'), 64);
        if (tabId === '')
            return sendJson(res, 400, { ok: false, error: 'tabId-required' });
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        if (typeof res.flushHeaders === 'function')
            res.flushHeaders();
        if (typeof req.socket?.setTimeout === 'function')
            req.socket.setTimeout(0);
        // A reload reconnects with the same tabId; retire the stale socket.
        const previous = connections.get(tabId);
        if (previous !== undefined && previous.res !== res) {
            previous.closed = true;
            connections.delete(tabId);
            try {
                previous.res.end();
            }
            catch {
                /* already closed */
            }
        }
        const conn = {
            tabId,
            res,
            label: 'DSH 页面',
            writable: false,
            sessionId: null,
            client: null,
            stage: null,
            note: null,
            focused: false,
            connectedAt: Date.now(),
            lastFocusAt: 0,
            closed: false,
        };
        connections.set(tabId, conn);
        const cleanup = () => {
            if (conn.closed)
                return;
            conn.closed = true;
            if (connections.get(tabId) === conn)
                connections.delete(tabId);
            try {
                res.end();
            }
            catch {
                /* already closed */
            }
        };
        req.on('close', cleanup);
        res.on('close', cleanup);
        res.on('error', cleanup);
        // A page reaching us is proof the bridge is reachable: make sure the
        // extension can find it too.
        ensureDiscovery();
        try {
            res.write(`event: hello\ndata: ${JSON.stringify({ tabId, route: ROUTE })}\n\n`);
        }
        catch {
            cleanup();
        }
        return undefined;
    }
    async function handlePresent(req, res) {
        if (req.method !== 'POST')
            return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!sameOrigin(req))
            return sendJson(res, 403, { ok: false, error: 'cross-origin' });
        const body = await readJsonBody(req);
        if (body === undefined)
            return sendJson(res, 400, { ok: false, error: 'bad-body' });
        const tabId = textOf(body.tabId, 64);
        const conn = connections.get(tabId);
        if (conn === undefined || conn.closed)
            return sendJson(res, 404, { ok: false, error: 'unknown-tab' });
        if (typeof body.label === 'string' && body.label.trim() !== '')
            conn.label = body.label.trim().slice(0, 160);
        if (typeof body.writable === 'boolean')
            conn.writable = body.writable;
        if (body.sessionId === null || typeof body.sessionId === 'string')
            conn.sessionId = body.sessionId;
        if (typeof body.client === 'string')
            conn.client = body.client.slice(0, 40);
        if (typeof body.stage === 'string')
            conn.stage = body.stage.slice(0, 40);
        if (typeof body.note === 'string')
            conn.note = body.note.slice(0, 280);
        else if (body.note === null)
            conn.note = null;
        if (typeof body.focused === 'boolean') {
            conn.focused = body.focused;
            if (body.focused)
                conn.lastFocusAt = Date.now();
        }
        return sendJson(res, 200, { ok: true });
    }
    function handleTargets(req, res) {
        if (req.method !== 'GET')
            return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!fromExtension(req))
            return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return sendJson(res, 200, { ok: true, route: ROUTE, targets: liveConnections().map(targetSummary), now: Date.now() });
    }
    async function handleContext(req, res) {
        if (req.method !== 'GET')
            return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!fromExtension(req))
            return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        const tabId = textOf(queryOf(req).get('tabId'), 64);
        const conn = connections.get(tabId);
        if (conn === undefined || conn.closed)
            return sendJson(res, 404, { ok: false, error: 'not-connected' });
        let cwd = null;
        const sessionQuery = sessionQueryService();
        if (conn.sessionId !== null && sessionQuery !== undefined) {
            try {
                const records = await sessionQuery.filterSessions([{ kind: 'id', values: [conn.sessionId] }]);
                const header = records[0]?.header;
                if (header !== undefined && typeof header.cwd === 'string')
                    cwd = header.cwd;
            }
            catch {
                cwd = null;
            }
        }
        return sendJson(res, 200, { ok: true, tabId: conn.tabId, sessionId: conn.sessionId, cwd });
    }
    /**
     * Pick the page a push goes to. An exact tabId wins; otherwise a lone page
     * is used, and with several candidates the most recently focused writable one.
     */
    function chooseTarget(tabId) {
        const list = liveConnections();
        if (tabId !== '' && tabId !== 'auto') {
            const conn = connections.get(tabId);
            if (conn === undefined || conn.closed)
                return { error: 'not-connected' };
            return { conn };
        }
        const writable = list.filter((conn) => conn.writable);
        if (writable.length === 1)
            return { conn: writable[0] };
        if (writable.length > 1) {
            const sorted = writable
                .slice()
                .sort((a, b) => (b.lastFocusAt - a.lastFocusAt) || (b.connectedAt - a.connectedAt));
            return { conn: sorted[0] };
        }
        if (list.length === 1)
            return { conn: list[0] };
        if (list.length === 0)
            return { error: 'no-page' };
        return { error: 'no-writable-page' };
    }
    function pushToPage(conn, nonce, text) {
        return new Promise((resolve) => {
            let timer = null;
            let settled = false;
            const finish = (payload) => {
                if (settled)
                    return;
                settled = true;
                pendingAcks.delete(nonce);
                if (timer !== null)
                    clearTimeout(timer);
                resolve(payload);
            };
            timer = setTimeout(() => finish({ ok: false, delivered: false, reason: 'no-ack' }), ACK_TIMEOUT_MS);
            pendingAcks.set(nonce, { finish, tabId: conn.tabId });
            try {
                const item = { nonce, text, ts: Date.now() };
                conn.res.write(`event: item\ndata: ${JSON.stringify(item)}\n\n`);
            }
            catch {
                finish({ ok: false, delivered: false, reason: 'not-connected' });
            }
        });
    }
    async function handlePush(req, res) {
        if (req.method !== 'POST')
            return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!fromExtension(req))
            return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        const body = await readJsonBody(req);
        if (body === undefined)
            return sendJson(res, 400, { ok: false, error: 'bad-body' });
        const text = typeof body.text === 'string' ? body.text : '';
        if (text.trim() === '')
            return sendJson(res, 400, { ok: false, error: 'empty-text' });
        if (text.length > MAX_TEXT_CHARS)
            return sendJson(res, 413, { ok: false, error: 'text-too-long' });
        const nonce = typeof body.nonce === 'string' && body.nonce !== '' ? body.nonce.slice(0, 80) : crypto.randomUUID();
        const requested = typeof body.tabId === 'string' ? body.tabId.slice(0, 64) : 'auto';
        const chosen = chooseTarget(requested);
        if ('error' in chosen) {
            return sendJson(res, 200, { ok: false, delivered: false, reason: chosen.error, targets: liveConnections().map(targetSummary) });
        }
        const conn = chosen.conn;
        if (!conn.writable) {
            return sendJson(res, 200, { ok: false, delivered: false, reason: 'not-writable', tabId: conn.tabId, label: conn.label });
        }
        const outcome = await pushToPage(conn, nonce, text);
        return sendJson(res, 200, { ...outcome, tabId: conn.tabId, label: conn.label, sessionId: conn.sessionId });
    }
    async function handleAck(req, res) {
        if (req.method !== 'POST')
            return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        if (!sameOrigin(req))
            return sendJson(res, 403, { ok: false, error: 'cross-origin' });
        const body = await readJsonBody(req);
        if (body === undefined)
            return sendJson(res, 400, { ok: false, error: 'bad-body' });
        const nonce = typeof body.nonce === 'string' ? body.nonce : '';
        const entry = pendingAcks.get(nonce);
        if (entry !== undefined) {
            const ok = body.ok !== false;
            entry.finish({
                ok,
                delivered: ok,
                reason: ok ? undefined : (typeof body.reason === 'string' ? body.reason : 'insert-failed'),
            });
        }
        return sendJson(res, 200, { ok: true });
    }
    function route(handler) {
        return (req, res) => {
            void Promise.resolve()
                .then(() => handler(req, res))
                .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                if (!res.headersSent)
                    sendJson(res, 400, { ok: false, error: message });
                else {
                    try {
                        res.end();
                    }
                    catch {
                        /* socket gone */
                    }
                }
            });
        };
    }
    // ------------------------------------------------------ discovery -------
    function writeDiscovery(attempt = 0) {
        if (stopped)
            return;
        const port = Number(webServer.port ?? 0);
        if (!Number.isFinite(port) || port === 0) {
            if (attempt < 40)
                discoveryRetry = setTimeout(() => writeDiscovery(attempt + 1), 250);
            return;
        }
        const host = webServer.host === '0.0.0.0' ? '127.0.0.1' : (webServer.host ?? '127.0.0.1');
        const payload = {
            url: `http://${host}:${port}`,
            port,
            token,
            route: ROUTE,
            pid: process.pid,
            updatedAt: Date.now(),
        };
        try {
            fs.mkdirSync(path.dirname(discoveryFile), { recursive: true });
            fs.writeFileSync(discoveryFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
            try {
                fs.chmodSync(discoveryFile, 0o600);
            }
            catch {
                /* best effort (Windows) */
            }
            console.log(`[dsh-add-to-terminal] bridge ready at ${payload.url}${ROUTE} (discovery: ${discoveryFile})`);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[dsh-add-to-terminal] could not write ${discoveryFile}: ${message}`);
        }
    }
    /** Who owns the discovery file right now, if anyone. */
    function discoveryOwner() {
        try {
            const parsed = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));
            return typeof parsed.token === 'string' ? parsed.token : undefined;
        }
        catch {
            return undefined;
        }
    }
    /**
     * Republish when the file is missing or unreadable, but never overwrite a
     * different instance's file: a live reload can have two instances briefly
     * alive, and the older one must not steal the extension's rendezvous.
     */
    function ensureDiscovery() {
        if (stopped)
            return;
        const owner = discoveryOwner();
        if (owner !== undefined && owner !== token)
            return;
        writeDiscovery();
    }
    function removeDiscovery() {
        // Same rule on the way out: a newer instance's file stays.
        const owner = discoveryOwner();
        if (owner !== token)
            return;
        try {
            fs.rmSync(discoveryFile, { force: true });
        }
        catch {
            /* best effort */
        }
    }
    const routeDisposers = [
        webServer.register({ kind: 'exact', path: `${ROUTE}/ping`, handler: route(handlePing) }),
        webServer.register({ kind: 'exact', path: `${ROUTE}/stream`, handler: route(handleStream) }),
        webServer.register({ kind: 'exact', path: `${ROUTE}/present`, handler: route(handlePresent) }),
        webServer.register({ kind: 'exact', path: `${ROUTE}/targets`, handler: route(handleTargets) }),
        webServer.register({ kind: 'exact', path: `${ROUTE}/context`, handler: route(handleContext) }),
        webServer.register({ kind: 'exact', path: `${ROUTE}/push`, handler: route(handlePush) }),
        webServer.register({ kind: 'exact', path: `${ROUTE}/ack`, handler: route(handleAck) }),
    ];
    pingTimer = setInterval(() => {
        for (const conn of liveConnections()) {
            try {
                conn.res.write(': ping\n\n');
            }
            catch {
                conn.closed = true;
                connections.delete(conn.tabId);
                try {
                    conn.res.end();
                }
                catch {
                    /* socket gone */
                }
            }
        }
    }, SSE_PING_MS);
    if (typeof pingTimer.unref === 'function')
        pingTimer.unref();
    // Self-healing: the discovery file is the extension's only way in, so a
    // temp cleanup (or a lost race) must not disable the bridge for good.
    discoveryTimer = setInterval(() => {
        ensureDiscovery();
    }, 30_000);
    if (typeof discoveryTimer.unref === 'function')
        discoveryTimer.unref();
    writeDiscovery();
    ctx.effect(() => () => {
        stopped = true;
        if (pingTimer !== null)
            clearInterval(pingTimer);
        if (discoveryTimer !== null)
            clearInterval(discoveryTimer);
        if (discoveryRetry !== null)
            clearTimeout(discoveryRetry);
        for (const entry of pendingAcks.values())
            entry.finish({ ok: false, delivered: false, reason: 'disposed' });
        pendingAcks.clear();
        for (const conn of connections.values()) {
            conn.closed = true;
            try {
                conn.res.end();
            }
            catch {
                /* socket gone */
            }
        }
        connections.clear();
        for (const dispose of routeDisposers) {
            try {
                dispose();
            }
            catch {
                /* already removed */
            }
        }
        removeDiscovery();
    }, 'dsh-add-to-terminal: bridge routes');
}
