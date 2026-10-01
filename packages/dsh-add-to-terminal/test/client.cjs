/**
 * Client-half harness: loads the real client.js in a stub DOM and drives it
 * through the page behaviours a browser would produce — connect, report,
 * queue while no composer is mounted, flush on mount, separator handling,
 * insert failure, unmount. No browser and no real draft involved.
 */
const fs = require('fs');
const path = require('path');

const CLIENT_PATH = path.join(__dirname, '..', 'lib', 'client.js');

const checks = [];
function check(name, condition, detail) {
    checks.push({ name, ok: condition === true, detail });
    console.log(`${condition === true ? 'PASS' : 'FAIL'}  ${name}${condition === true ? '' : `  -> ${JSON.stringify(detail)}`}`);
}

// ---------------------------------------------------------------- stub DOM --
const storage = new Map();
const windowListeners = new Map();
const documentListeners = new Map();
const fetchCalls = [];

const fakeReact = {
    createElement: (type, props) => ({ type, props }),
    useEffect: () => {
        throw new Error('useEffect ran outside a render');
    },
};

let renderHooks = null;

global.window = {
    __ModuleLoader__: { load: (definition) => { loaded = definition; } },
    sessionStorage: {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, value),
    },
    crypto: { randomUUID: () => 'abcd1234-0000-4000-8000-000000000000' },
    addEventListener: (type, listener) => {
        const list = windowListeners.get(type) ?? [];
        list.push(listener);
        windowListeners.set(type, list);
    },
    removeEventListener: () => {},
};

global.document = {
    title: 'My Session',
    visibilityState: 'visible',
    hasFocus: () => true,
    addEventListener: (type, listener) => {
        const list = documentListeners.get(type) ?? [];
        list.push(listener);
        documentListeners.set(type, list);
    },
    removeEventListener: () => {},
    querySelector: () => null,
};

// Node exposes its own read-only `navigator`, so define ours explicitly.
Object.defineProperty(global, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/154.0.0.0 Safari/537.36' },
    configurable: true,
    writable: true,
});

/** Whether /ping answers like the bridge (true) or like the SPA fallback (false). */
let pingOk = true;

global.fetch = async (url, init) => {
    const target = String(url);
    fetchCalls.push({ url: target, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    if (target.endsWith('/ping')) {
        // A backend without the bridge answers the SPA fallback: HTML, no marker.
        return pingOk
            ? { ok: true, json: async () => ({ ok: true, bridge: 'dsh-add-to-terminal' }) }
            : { ok: true, json: async () => ({ ok: false }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
};

class FakeEventSource {
    constructor(url) {
        this.url = url;
        this.handlers = new Map();
        this.closed = false;
        FakeEventSource.instances.push(this);
    }
    addEventListener(type, listener) {
        const list = this.handlers.get(type) ?? [];
        list.push(listener);
        this.handlers.set(type, list);
    }
    emit(type, payload) {
        for (const listener of this.handlers.get(type) ?? []) {
            listener({ data: payload === undefined ? undefined : JSON.stringify(payload) });
        }
    }
    close() {
        this.closed = true;
    }
}
FakeEventSource.instances = [];
global.EventSource = FakeEventSource;

let loaded = null;

// ------------------------------------------------------------- load client --
const source = fs.readFileSync(CLIENT_PATH, 'utf8');
// Evaluate the loader registration; the module only registers a factory.
new Function('window', 'document', 'navigator', 'EventSource', source)(global.window, global.document, global.navigator, global.EventSource);

if (loaded === null) {
    throw new Error('client.js did not register a module');
}
const clientModule = loaded.factory((request) => {
    if (request === 'react') {
        return fakeReact;
    }
    throw new Error(`unexpected require: ${request}`);
});

// Mount helper: the slot occupant is a factory wrapping the seat component in
// React.createElement, so unwrap the descriptor before running its hooks.
function renderSeat(props) {
    const element = occupantFactory(props);
    const component = element?.type ?? renderedComponent;
    const componentProps = element?.props ?? props;
    const effects = [];
    fakeReact.useEffect = (callback) => {
        effects.push(callback);
    };
    component(componentProps);
    const cleanups = effects.map((effect) => effect()).filter((value) => typeof value === 'function');
    return { element, cleanups };
}

let occupantFactory = null;
let renderedComponent = null;
let registrationOptions = null;
let registered = false;

const ctx = {
    slots: {
        inject: (key, callback) => {
            check('inject targets the composer tool row', key === 'conversation.input.left');
            callback();
            return () => {};
        },
        register: (options, component) => {
            registrationOptions = options;
            occupantFactory = component;
            registered = true;
            return () => {};
        },
    },
};

// Capture the component the occupant factory passes to createElement.
fakeReact.createElement = (type, props) => {
    renderedComponent = type;
    return { type, props };
};

clientModule.apply(ctx);

function lastFetch(suffix) {
    for (let index = fetchCalls.length - 1; index >= 0; index -= 1) {
        if (fetchCalls[index].url.endsWith(suffix)) {
            return fetchCalls[index].body;
        }
    }
    return undefined;
}

function countFetch(suffix) {
    return fetchCalls.filter((call) => call.url.endsWith(suffix)).length;
}

// --------------------------------------------------------------- scenario --
async function main() {
    // The stream now opens only after /ping confirms the bridge is served.
    await settle(8);

    check('client: registered into conversation.input.left', registered === true && registrationOptions?.id === 'dsh-add-to-terminal', registrationOptions);
    check('client: one EventSource was opened', FakeEventSource.instances.length === 1, FakeEventSource.instances.length);

    const stream = FakeEventSource.instances[0];
    const connectedTabId = new URL(`http://x${stream.url}`).searchParams.get('tabId');
    check('client: stream URL carries a tabId', typeof connectedTabId === 'string' && connectedTabId.length === 8, stream.url);
    check('client: tabId is persisted for reloads', storage.get('dsh-add-to-terminal.tabId') === connectedTabId, [...storage.entries()]);

    stream.emit('hello');
    await tick();
    const unboundPresent = lastFetch('/present');
    check('client: reports not writable while no composer is mounted', unboundPresent?.writable === false, unboundPresent);
    check('client: label falls back to the page title without a session', unboundPresent?.label === 'My Session', unboundPresent?.label);

    // An item arriving with no composer must be queued, not acked.
    stream.emit('item', { nonce: 'q1', text: '@queued.ts:1' });
    await tick();
    check('client: queues an item while unbound and does not ack', countFetch('/ack') === 0, fetchCalls);

    // Mount a composer seat: fake inputActions record what the client writes.
    const writes = [];
    let insertResult = true;
    const inputActions = {
        captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
        insertText: (text) => {
            writes.push(text);
            return insertResult;
        },
        setDraft: () => {},
    };
    let draft = '';
    const sessions = {
        byId: {
            s1: {
                id: 's1',
                cwd: path.join('E:', 'code3', 'docs.10coding-demos'),
                title: '线性代数讲义',
                displayTitle: '线性代数讲义',
            },
        },
    };
    const props = {
        sessionId: 's1',
        inputActions,
        useInput: (selector) => selector({ draft }),
        useSessions: (selector) => selector(sessions),
    };

    let mounted = renderSeat(props);
    await tick();
    check('client: flush writes the queued item on mount', writes.length === 1 && writes[0] === '@queued.ts:1', writes);
    check('client: flush acks success', lastFetch('/ack')?.ok === true && lastFetch('/ack')?.nonce === 'q1', lastFetch('/ack'));
    check('client: reports writable once mounted', lastFetch('/present')?.writable === true, lastFetch('/present'));
    check('client: a successful write marks the tab title', document.title.startsWith('● '), document.title);

    // The label is 工作区 · 标题: no browser name/version, no tab id.
    stream.emit('hello');
    await tick();
    const sessionLabel = lastFetch('/present')?.label;
    check('client: label is 工作区 · 标题', sessionLabel === 'docs.10coding-demos · 线性代数讲义', sessionLabel);
    check('client: label carries no browser name', !/Chrome|Edge|Firefox|Safari|Opera/.test(sessionLabel ?? ''), sessionLabel);
    check('client: label carries no tab id', !/#/.test(sessionLabel ?? ''), sessionLabel);
    check('client: the flash marker is stripped from the label', !/●/.test(sessionLabel ?? ''), sessionLabel);

    // A blank session (no durable title) degrades to the workspace name alone.
    sessions.byId.s1.title = undefined;
    sessions.byId.s1.displayTitle = 'docs.10coding-demos';
    mounted.cleanups.forEach((cleanup) => cleanup());
    mounted = renderSeat(props);
    await tick();
    check('client: a blank session labels just the workspace', lastFetch('/present')?.label === 'docs.10coding-demos', lastFetch('/present')?.label);
    sessions.byId.s1.title = '线性代数讲义';
    sessions.byId.s1.displayTitle = '线性代数讲义';
    mounted.cleanups.forEach((cleanup) => cleanup());
    mounted = renderSeat(props);
    await tick();

    // A non-empty draft gets a newline separator.
    draft = 'please review';
    mounted.cleanups.forEach((cleanup) => cleanup());
    mounted = renderSeat(props);
    await tick();
    writes.length = 0;
    stream.emit('item', { nonce: 'q2', text: '@second.ts:2' });
    await tick();
    check('client: appends with a newline when the draft is not empty', writes[0] === '\n@second.ts:2', writes);
    check('client: acks the second item', lastFetch('/ack')?.nonce === 'q2' && lastFetch('/ack')?.ok === true, lastFetch('/ack'));

    // A refused insert must be reported, not silently swallowed.
    insertResult = false;
    stream.emit('item', { nonce: 'q3', text: '@third.ts:3' });
    await tick();
    check('client: reports a refused insert', lastFetch('/ack')?.nonce === 'q3' && lastFetch('/ack')?.ok === false && lastFetch('/ack')?.reason === 'insert-failed', lastFetch('/ack'));

    // Unmount (session switch): report not writable and queue again.
    insertResult = true;
    mounted.cleanups.forEach((cleanup) => cleanup());
    await tick();
    const acksBefore = countFetch('/ack');
    stream.emit('item', { nonce: 'q4', text: '@fourth.ts:4' });
    await tick();
    check('client: unmount reports not writable', lastFetch('/present')?.writable === false, lastFetch('/present'));
    check('client: queues again after unmount', countFetch('/ack') === acksBefore, { acksBefore, now: countFetch('/ack') });

    // Remount flushes it, and a dropped pending item is bounded.
    mounted = renderSeat(props);
    await tick();
    check('client: remount flushes the queued item', lastFetch('/ack')?.nonce === 'q4', lastFetch('/ack'));

    // Registration metadata stays stable for the slot owner.
    check('client: registration options are stable', registrationOptions?.order === 95 && registrationOptions?.name === 'conversation.input.left', registrationOptions);

    // ---------------------------------------------- connection safety ------
    const instancesBefore = FakeEventSource.instances.length;
    stream.onerror?.();
    await settle();
    check('client: a stream error closes that stream', stream.closed === true, { closed: stream.closed });
    check(
        'client: a stream error does not reconnect immediately',
        FakeEventSource.instances.length === instancesBefore,
        { before: instancesBefore, after: FakeEventSource.instances.length }
    );

    // A backend that serves no bridge must never be streamed: this is what
    // used to put the page in a hot MIME-error retry loop.
    pingOk = false;
    const secondModule = loadInstance();
    secondModule.apply({ slots: { inject: () => () => {}, register: () => () => {} } });
    await settle(8);
    check(
        'client: no stream is opened while /ping reports no bridge',
        FakeEventSource.instances.length === instancesBefore,
        { before: instancesBefore, after: FakeEventSource.instances.length }
    );

    pingOk = true;
    const connected = await waitUntil(() => FakeEventSource.instances.length > instancesBefore, 6000);
    check('client: the next probe connects once the bridge answers again', connected === true, { after: FakeEventSource.instances.length });

    const failed = checks.filter((entry) => entry.ok !== true);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length > 0) {
        process.exitCode = 1;
    }
}

function tick() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

async function settle(times = 4) {
    for (let index = 0; index < times; index += 1) {
        await tick();
    }
}

function waitUntil(predicate, timeoutMs) {
    const started = Date.now();
    return new Promise((resolve) => {
        const step = () => {
            if (predicate()) {
                resolve(true);
                return;
            }
            if (Date.now() - started > timeoutMs) {
                resolve(false);
                return;
            }
            setTimeout(step, 25);
        };
        step();
    });
}

/** Evaluate the compiled client again as an independent instance. */
function loadInstance() {
    window.__DSH_ADD_TO_TERMINAL_REGISTERED__ = false;
    loaded = null;
    new Function('window', 'document', 'navigator', 'EventSource', source)(window, document, navigator, EventSource);
    return loaded.factory((name) => {
        if (name === 'react') {
            return fakeReact;
        }
        throw new Error(`unexpected require: ${name}`);
    });
}

main().catch((error) => {
    console.error('[harness failure]', error);
    process.exitCode = 1;
});
