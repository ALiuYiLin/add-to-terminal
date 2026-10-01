/**
 * Host-half suite that runs the REAL compiled plugin (lib/host.js) against a
 * throwaway node:http server — no DSH profile install, no browser, nothing
 * written outside the OS temp dir (the bridge discovery file, removed on
 * dispose).
 *
 * Covers: /ping, token gate, Origin rejection, SSE connect, /present,
 * /targets, /context cwd, /push + ack, not-writable, not-connected, duplicate
 * tabId reconnect, no-ack timeout, discovery file contents, dispose cleanup.
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const HOST_PATH = path.join(__dirname, '..', 'lib', 'host.js');
const SESSION_CWD = process.cwd();
// Never touch a live instance's discovery file: point the plugin at our own.
const DISCOVERY = path.join(os.tmpdir(), 'dsh-add-to-terminal-standalone', `bridge-${process.pid}.json`);
process.env.DSH_ADD_TO_TERMINAL_BRIDGE_FILE = DISCOVERY;
const ROUTE = '/dsh-add-to-terminal';

const checks = [];
function check(name, condition, detail) {
    checks.push({ name, ok: condition === true, detail });
    console.log(`${condition === true ? 'PASS' : 'FAIL'}  ${name}${condition === true ? '' : `  -> ${JSON.stringify(detail)}`}`);
}

function waitFor(predicate, timeoutMs, label) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const step = () => {
            if (predicate()) {
                resolve(true);
                return;
            }
            if (Date.now() - started > timeoutMs) {
                reject(new Error(`timeout waiting for ${label}`));
                return;
            }
            setTimeout(step, 25);
        };
        step();
    });
}

class FakePage {
    constructor(tabId, label) {
        this.tabId = tabId;
        this.label = label;
        this.items = [];
        this.buffer = '';
        this.closed = false;
        this.hello = false;
    }

    connect(port) {
        return new Promise((resolve, reject) => {
            this.request = http.get(
                { hostname: '127.0.0.1', port, path: `${ROUTE}/stream?tabId=${this.tabId}` },
                (response) => {
                    this.status = response.statusCode;
                    response.setEncoding('utf8');
                    response.on('data', (chunk) => this.onData(chunk));
                    response.on('close', () => {
                        this.closed = true;
                    });
                    response.on('end', () => {
                        this.closed = true;
                    });
                    waitFor(() => this.hello, 2000, 'hello').then(resolve, reject);
                }
            );
            this.request.on('error', reject);
        });
    }

    onData(chunk) {
        this.buffer += chunk;
        let index = this.buffer.indexOf('\n\n');
        while (index !== -1) {
            const raw = this.buffer.slice(0, index);
            this.buffer = this.buffer.slice(index + 2);
            let event = 'message';
            let data = '';
            for (const line of raw.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (event === 'hello') this.hello = true;
            else if (event === 'item') {
                try {
                    this.items.push(JSON.parse(data));
                } catch {
                    /* ignore */
                }
            }
            index = this.buffer.indexOf('\n\n');
        }
    }

    close() {
        try {
            this.request.destroy();
        } catch {
            /* already gone */
        }
    }
}

async function main() {
    // ---------------------------------------------------- fake web server --
    const routes = new Map();
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname;
        const handler = routes.get(pathname);
        if (handler === undefined) {
            // Mirrors the shipped SPA fallback: HTML for anything unclaimed.
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<!doctype html><title>DSH</title>');
            return;
        }
        void handler(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    let sessionQuery;
    const fakeWebServer = {
        port,
        host: '127.0.0.1',
        register(route) {
            routes.set(route.path, route.handler);
            return () => routes.delete(route.path);
        },
    };
    let dispose = () => {};
    const ctx = {
        get(name) {
            if (name === 'webServer') return fakeWebServer;
            if (name === 'sessionQuery') return sessionQuery;
            return undefined;
        },
        effect(callback) {
            dispose = callback();
            return () => {};
        },
    };

    const api = (method, pathname, payload, options = {}) =>
        new Promise((resolve, reject) => {
            const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload), 'utf8');
            const headers = {};
            if (body) {
                headers['content-type'] = 'application/json';
                headers['content-length'] = body.length;
            }
            if (options.token) headers['x-dsh-bridge-token'] = options.token;
            if (options.origin) headers.origin = options.origin;
            const request = http.request(
                { hostname: '127.0.0.1', port, path: `${ROUTE}${pathname}`, method, headers },
                (response) => {
                    const chunks = [];
                    response.on('data', (chunk) => chunks.push(chunk));
                    response.on('end', () => {
                        const text = Buffer.concat(chunks).toString('utf8');
                        let json;
                        try {
                            json = JSON.parse(text);
                        } catch {
                            json = undefined;
                        }
                        resolve({ status: response.statusCode, json, text, type: response.headers['content-type'] });
                    });
                }
            );
            request.on('error', reject);
            if (body) request.write(body);
            request.end();
        });

    // ------------------------------------------------------ load the plugin --
    const module = await import(pathToFileURL(HOST_PATH).href);
    check('host: the compiled module exports name + apply', module.name === 'dsh-add-to-terminal' && typeof module.apply === 'function', { name: module.name });
    module.apply(ctx);

    // ------------------------------------------------------------- /ping ----
    const ping = await api('GET', '/ping');
    check('host: /ping answers with the bridge marker', ping.status === 200 && ping.json?.bridge === 'dsh-add-to-terminal', ping.json);
    check('host: /ping is JSON, not the SPA fallback', String(ping.type).includes('application/json'), ping.type);

    // ---------------------------------------------------------- discovery ---
    const discovery = JSON.parse(fs.readFileSync(DISCOVERY, 'utf8'));
    check('host: discovery file carries url/port/token', discovery.port === port && discovery.url === `http://127.0.0.1:${port}` && typeof discovery.token === 'string' && discovery.token.length > 20, discovery);
    const token = discovery.token;

    // ------------------------------------------------------- auth / origin --
    check('host: /targets without a token is 401', (await api('GET', '/targets')).status === 401);
    check('host: /targets with a wrong token is 401', (await api('GET', '/targets', undefined, { token: 'x'.repeat(token.length) })).status === 401);
    const withOrigin = await api('GET', '/targets', undefined, { token, origin: 'http://evil.example' });
    check('host: an extension endpoint rejects any browser Origin', withOrigin.status === 401, { status: withOrigin.status });
    const pageOrigin = await api('POST', '/present', { tabId: 'nope', writable: true }, { origin: 'http://evil.example' });
    check('host: a page endpoint rejects a cross-origin request', pageOrigin.status === 403, { status: pageOrigin.status });

    // ------------------------------------------------------ page lifecycle --
    const tabId = 'standalone1';
    const page = new FakePage(tabId, 'ignored');
    await page.connect(port);
    check('host: the stream sends hello', page.hello === true && page.status === 200, { hello: page.hello, status: page.status });

    await api('POST', '/present', { tabId, label: 'docs.10coding-demos · 线性代数讲义', writable: true, sessionId: 'session-1', focused: true });
    let targets = await api('GET', '/targets', undefined, { token });
    const mine = (targets.json?.targets ?? []).filter((entry) => entry.tabId === tabId);
    check(
        'host: /targets lists the page with its label and writability',
        mine.length === 1 && mine[0].label === 'docs.10coding-demos · 线性代数讲义' && mine[0].writable === true,
        mine
    );

    // --------------------------------------------------------------- push ---
    const pushPromise = api('POST', '/push', { tabId, text: '@standalone.ts:1-2', nonce: 'n1' }, { token });
    await waitFor(() => page.items.length === 1, 3000, 'the pushed item');
    check('host: the item carries the exact text and nonce', page.items[0]?.text === '@standalone.ts:1-2' && page.items[0]?.nonce === 'n1', page.items);
    await api('POST', '/ack', { nonce: 'n1', ok: true });
    const pushed = await pushPromise;
    check('host: ack turns the push into delivered:true', pushed.json?.ok === true && pushed.json.delivered === true, pushed.json);
    check('host: the push response names the target', pushed.json?.label === 'docs.10coding-demos · 线性代数讲义', pushed.json?.label);

    // ------------------------------------------------------------ /context --
    sessionQuery = { async filterSessions() { return [{ header: { cwd: SESSION_CWD } }]; } };
    const withQuery = await api('GET', `/context?tabId=${tabId}`, undefined, { token });
    check('host: /context reads the session cwd', withQuery.json?.cwd === SESSION_CWD, withQuery.json);
    sessionQuery = undefined;
    const withoutQuery = await api('GET', `/context?tabId=${tabId}`, undefined, { token });
    check('host: /context degrades to cwd:null without the session service', withoutQuery.status === 200 && withoutQuery.json?.cwd === null, withoutQuery.json);

    // ------------------------------------------------- refusal paths -------
    await api('POST', '/present', { tabId, writable: false });
    const refused = await api('POST', '/push', { tabId, text: '@x.ts:1', nonce: 'n2' }, { token });
    check('host: not writable -> not-writable, nothing pushed', refused.json?.reason === 'not-writable' && page.items.length === 1, { json: refused.json, items: page.items.length });
    const missing = await api('POST', '/push', { tabId: 'no-such-tab', text: '@x.ts:2', nonce: 'n3' }, { token });
    check('host: unknown tab -> not-connected', missing.json?.reason === 'not-connected', missing.json);
    const noPage = await api('POST', '/push', { tabId: 'auto', text: '@x.ts:3', nonce: 'n4' }, { token });
    check('host: a lone unwritable page is attempted, then refused', noPage.json?.reason === 'not-writable', noPage.json);

    // ------------------------------------------------- reconnect semantics --
    await api('POST', '/present', { tabId, writable: true });
    const reloaded = new FakePage(tabId, 'ignored');
    await reloaded.connect(port);
    await waitFor(() => page.closed === true, 2000, 'the stale socket to retire').catch(() => undefined);
    targets = await api('GET', '/targets', undefined, { token });
    check('host: reconnect keeps exactly one entry for the tabId', (targets.json?.targets ?? []).filter((entry) => entry.tabId === tabId).length === 1, targets.json);
    check('host: reconnect retires the stale socket', page.closed === true, { closed: page.closed });

    // ---------------------------------------------------------- no ack ------
    // The reconnected socket is the live one now, so present on it.
    await api('POST', '/present', { tabId, label: 'docs.10coding-demos · 线性代数讲义', writable: true });
    const started = Date.now();
    const noAck = await api('POST', '/push', { tabId, text: '@noack.ts:1', nonce: 'n5' }, { token });
    const waited = Date.now() - started;
    check('host: a silent page ends as no-ack after the timeout', noAck.json?.reason === 'no-ack' && waited >= 2300, { json: noAck.json, waited });

    // ----------------------------------------------------------- dispose ----
    reloaded.close();
    dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    check('host: dispose removes the discovery file', fs.existsSync(DISCOVERY) === false, DISCOVERY);
    const afterDispose = await api('GET', '/ping');
    check('host: dispose unregisters the routes (fallback answers again)', afterDispose.json === undefined && afterDispose.text.includes('<!doctype html>'), afterDispose.status);

    server.close();
    const failed = checks.filter((entry) => entry.ok !== true);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
    console.error('[suite failure]', error);
    process.exitCode = 1;
});
