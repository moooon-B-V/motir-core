import { ySyncPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

// The page editor's autosave loop (Story MOTIR-5752 · MOTIR-7275), under
// `docs/decisions/pages.md` §3 and `design/pages/design-notes.md` § _State 8_.
//
// ⚠️ IT SENDS UPDATES, NEVER DOCUMENTS. Every LOCAL Yjs update is buffered, and a
// batch goes to `saveUpdate` as ONE `Y.mergeUpdates(batch)`; the server applies it
// to the stored state. Two writers who saved from stale copies both keep their
// edits, because Yjs updates merge in any order.
//
// The rules, each one a line of the card:
//
//  • LOCAL ORIGIN ONLY. Tiptap's collaboration binding (`@tiptap/y-tiptap`'s
//    `ySyncPlugin`) writes every editor change inside `doc.transact(…,
//    ySyncPluginKey)`, and its undo manager replays undo / redo with ITSELF as
//    the origin. Those two are this tab's writer. Anything else — a provider, a
//    `Y.applyUpdate(doc, u, 'remote')`, the initial state applied with no origin —
//    is somebody else's edit arriving, and echoing it back would be a save the
//    writer never made. So the test is "is it ours", never "is the origin null".
//  • 1 s of quiet, capped at 5 s of continuous typing.
//  • ONE request in flight. A batch that comes due while one is out waits for it
//    to settle, then goes at once.
//  • A failure keeps the batch: it goes back to the FRONT of the buffer, the
//    status reads `offline`, and the whole buffer — the failed batch plus every
//    edit made since — is resent with backoff (2 s, 4 s, 8 s … capped at 30 s) and
//    on the browser's `online` event. Any refusal that is not the size refusal is
//    retried the same way: the writer's edits are in this tab and nowhere else.
//  • `PAGE_BODY_TOO_LARGE` is final. The status reads `too_large` and nothing is
//    sent again from this loop; the content stays in the editor so it can be
//    copied out (the notes' "the loop stops for good").

/** The save indicator's four values. */
export type SaveStatus = 'saved' | 'saving' | 'offline' | 'too_large';

/** Quiet before a batch goes. */
export const AUTOSAVE_QUIET_MS = 1_000;
/** The longest continuous typing runs before a batch goes anyway. */
export const AUTOSAVE_MAX_WAIT_MS = 5_000;
/** The first retry after a failed save; each next one doubles. */
export const AUTOSAVE_RETRY_BASE_MS = 2_000;
/** The retry delay never grows past this. */
export const AUTOSAVE_RETRY_MAX_MS = 30_000;

/** Is a Yjs transaction origin THIS tab's editor (a keystroke, an undo, a redo)? */
export function isLocalOrigin(origin: unknown): boolean {
  return origin === ySyncPluginKey || origin instanceof Y.UndoManager;
}

/**
 * Is a rejection the save route's size refusal? The host turns the route's 413
 * body (`{ code: 'PAGE_BODY_TOO_LARGE', … }`) into a rejection carrying that
 * `code` — `PageBodyTooLargeError` itself qualifies — so the editor knows no URL
 * and no status code, only the stable refusal code.
 */
export function isPageBodyTooLarge(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'PAGE_BODY_TOO_LARGE'
  );
}

/** Where the `online` event is heard. `window` in a browser. */
export interface OnlineEventTarget {
  addEventListener(type: 'online', listener: () => void): void;
  removeEventListener(type: 'online', listener: () => void): void;
}

export interface AutosaveOptions {
  doc: Y.Doc;
  saveUpdate: (update: Uint8Array) => Promise<{ revision: number }>;
  onStatusChange: (status: SaveStatus) => void;
  /** Defaults to `window` when there is one. */
  onlineTarget?: OnlineEventTarget | null;
}

export interface Autosave {
  /** The current status. */
  readonly status: SaveStatus;
  /** Send what is buffered now, without waiting for quiet. */
  flush(): void;
  /**
   * Stop listening. Anything still buffered is sent once, best-effort, after
   * any request in flight, and no status is reported for it.
   */
  dispose(): void;
}

function merge(batch: Uint8Array[]): Uint8Array {
  return batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch);
}

/** Start the loop over `doc`. Updates already in the doc are not sent. */
export function startAutosave(options: AutosaveOptions): Autosave {
  const { doc, saveUpdate, onStatusChange } = options;
  const onlineTarget =
    options.onlineTarget === undefined
      ? typeof window === 'undefined'
        ? null
        : window
      : options.onlineTarget;

  let status: SaveStatus = 'saved';
  let buffer: Uint8Array[] = [];
  let inFlight: Promise<void> | null = null;
  // A batch came due while a request was out; it goes when that one settles.
  let flushPending = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let stopped = false;
  let disposed = false;

  const setStatus = (next: SaveStatus): void => {
    if (next === status) return;
    status = next;
    if (!disposed) onStatusChange(next);
  };

  const clearSendTimers = (): void => {
    if (quietTimer) clearTimeout(quietTimer);
    if (maxTimer) clearTimeout(maxTimer);
    quietTimer = null;
    maxTimer = null;
  };

  const clearRetry = (): void => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const send = (batch: Uint8Array): Promise<{ revision: number }> =>
    new Promise((resolve) => resolve(saveUpdate(batch)));

  function flush(): void {
    clearSendTimers();
    if (stopped || disposed || buffer.length === 0) return;
    if (inFlight) {
      flushPending = true;
      return;
    }
    flushPending = false;
    clearRetry();
    const batch = merge(buffer);
    buffer = [];
    if (status !== 'offline') setStatus('saving');
    inFlight = send(batch).then(onSaved, (err: unknown) => onFailed(err, batch));
  }

  function onSaved(): void {
    inFlight = null;
    failures = 0;
    if (disposed) return;
    if (buffer.length === 0) {
      setStatus('saved');
      return;
    }
    // Edits arrived while the request was out. If a batch already came due (or
    // the loop was offline, where nothing schedules one), send it now; otherwise
    // the quiet timer those edits set is still running and will.
    setStatus('saving');
    if (flushPending || quietTimer === null) flush();
  }

  function onFailed(err: unknown, batch: Uint8Array): void {
    inFlight = null;
    flushPending = false;
    // The failed batch is kept, ahead of anything typed since. Order does not
    // matter to Yjs; keeping it is what matters.
    buffer = [batch, ...buffer];
    clearSendTimers();
    if (isPageBodyTooLarge(err)) {
      stopped = true;
      clearRetry();
      setStatus('too_large');
      return;
    }
    if (disposed) return;
    setStatus('offline');
    const delay = Math.min(AUTOSAVE_RETRY_BASE_MS * 2 ** failures, AUTOSAVE_RETRY_MAX_MS);
    failures += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      flush();
    }, delay);
  }

  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (stopped || !isLocalOrigin(origin)) return;
    buffer.push(update);
    // Offline, the scheduled retry (or the `online` event) carries the edit.
    if (status === 'offline') return;
    setStatus('saving');
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(flush, AUTOSAVE_QUIET_MS);
    if (!maxTimer) maxTimer = setTimeout(flush, AUTOSAVE_MAX_WAIT_MS);
  };

  const onOnline = (): void => {
    if (status !== 'offline' || inFlight) return;
    clearRetry();
    flush();
  };

  doc.on('update', onUpdate);
  onlineTarget?.addEventListener('online', onOnline);

  return {
    get status() {
      return status;
    },
    flush,
    dispose() {
      if (disposed) return;
      doc.off('update', onUpdate);
      onlineTarget?.removeEventListener('online', onOnline);
      clearSendTimers();
      clearRetry();
      disposed = true;
      // Read the buffer when the last send goes, not now: a request still out
      // that fails puts its batch back first, and one refused as too large
      // stops the loop, in which case nothing goes.
      const last = (): Promise<unknown> => {
        if (stopped || buffer.length === 0) return Promise.resolve();
        const rest = merge(buffer);
        buffer = [];
        return send(rest).catch(() => undefined);
      };
      void (inFlight ? inFlight.then(last) : last());
    },
  };
}
