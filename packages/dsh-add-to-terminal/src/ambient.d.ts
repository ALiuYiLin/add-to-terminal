/**
 * Ambient types shared by both halves of the bridge.
 *
 * This file is a *script* declaration (no imports/exports) on purpose: the
 * client half must compile to a classic script for `window.__ModuleLoader__`,
 * so it cannot import types from a module.
 */

/** One DSH Web page (browser tab) connected to the bridge. */
interface DshTarget {
    tabId: string;
    label?: string;
    writable?: boolean;
    sessionId?: string | null;
    /** Which client build the page runs, e.g. "ts-0.2.0". */
    client?: string | null;
    /** How far the page half got: loaded/applied/slot-registered/seated/... */
    stage?: string | null;
    /** Last client-side problem reported by that page, for diagnosis. */
    note?: string | null;
    focused?: boolean;
    connectedAt?: number;
    lastFocusAt?: number;
}

/** One item pushed from the host half to a page. */
interface BridgeItem {
    nonce: string;
    text: string;
    ts?: number;
}

/** The public per-session input face (`InputActions`), narrowed to what we use. */
interface InputActionsLike {
    captureInsertion(): unknown;
    insertText(text: string, span: unknown): boolean;
    setDraft(text: string): void;
}

interface InputStateLike {
    draft?: string;
}

/** Session metadata a page can read for a human-meaningful label. */
interface SessionMetaLike {
    cwd?: string;
    title?: string;
    displayTitle?: string;
}

/** The `useSessions` snapshot shape (only the part the label needs). */
interface SessionsSnapshotLike {
    byId?: Record<string, SessionMetaLike | undefined>;
}

/** Props a `conversation.input.left` occupant receives (the parts we read). */
interface SeatProps {
    sessionId?: string | null;
    inputActions?: InputActionsLike;
    useInput?: <S>(selector: (state: InputStateLike) => S) => S;
    useSessions?: <S>(selector: (state: SessionsSnapshotLike) => S) => S;
}

interface ModuleLoaderLike {
    load(definition: { id: string; factory: (require: (name: string) => unknown) => unknown }): void;
}

interface Window {
    /** Injected by the Harness Web shell. Absent on any other page. */
    __ModuleLoader__?: ModuleLoaderLike;
}
