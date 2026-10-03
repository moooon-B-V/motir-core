import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  AUTOSAVE_MAX_WAIT_MS,
  AUTOSAVE_QUIET_MS,
  AUTOSAVE_RETRY_MAX_MS,
  isLocalOrigin,
  isPageArchived,
  isPageBodyTooLarge,
  startAutosave,
  type OnlineEventTarget,
  type SaveStatus,
} from '../../src/editor/autosave';
import { PageBodyTooLargeError } from '../../src';
import { archivedError, tooLargeError } from './fixtures';

// The autosave loop on its own (MOTIR-7275): a Yjs doc, a fake `saveUpdate`,
// fake timers. The component suite drives the same loop through a real editor.

interface Deferred {
  resolve: (value: { revision: number }) => void;
  reject: (err: unknown) => void;
}

function harness(options: { online?: OnlineEventTarget | null } = {}) {
  const doc = new Y.Doc();
  const text = doc.getText('body');
  const calls: Uint8Array[] = [];
  const pending: Deferred[] = [];
  const statuses: SaveStatus[] = [];
  const saveUpdate = vi.fn(
    (update: Uint8Array) =>
      new Promise<{ revision: number }>((resolve, reject) => {
        calls.push(update);
        pending.push({ resolve, reject });
      }),
  );
  const autosave = startAutosave({
    doc,
    saveUpdate,
    onStatusChange: (s) => statuses.push(s),
    onlineTarget: options.online === undefined ? null : options.online,
  });
  /** A keystroke, written the way the editor's binding writes one. */
  const type = (s: string) => doc.transact(() => text.insert(text.length, s), ySyncPluginKey);
  /** The text a fresh doc reads after applying every update in `updates`. */
  const replay = (updates: Uint8Array[]) => {
    const copy = new Y.Doc();
    for (const u of updates) Y.applyUpdate(copy, u);
    return copy.getText('body').toString();
  };
  /** Settle the oldest request and let its continuation run. */
  const settle = async (outcome: 'ok' | Error) => {
    const next = pending.shift()!;
    if (outcome === 'ok') next.resolve({ revision: 2 });
    else next.reject(outcome);
    await vi.advanceTimersByTimeAsync(0);
  };
  return { doc, text, calls, statuses, saveUpdate, autosave, type, replay, settle };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('origin', () => {
  it('counts the binding and the undo manager as this tab, and nothing else', () => {
    const doc = new Y.Doc();
    expect(isLocalOrigin(ySyncPluginKey)).toBe(true);
    expect(isLocalOrigin(new Y.UndoManager(doc.getText('t')))).toBe(true);
    expect(isLocalOrigin(null)).toBe(false);
    expect(isLocalOrigin('remote')).toBe(false);
    expect(isLocalOrigin({ provider: true })).toBe(false);
  });

  it('never sends an update another origin applied', async () => {
    const h = harness();
    const other = new Y.Doc();
    other.getText('body').insert(0, 'from elsewhere');
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(other), 'remote');
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(other));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS * 2);
    expect(h.saveUpdate).not.toHaveBeenCalled();
    expect(h.autosave.status).toBe('saved');
    expect(h.statuses).toEqual([]);
  });
});

describe('batching', () => {
  it('sends one merged update after 1 s of quiet', async () => {
    const h = harness();
    h.type('a');
    h.type('b');
    expect(h.autosave.status).toBe('saving');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_QUIET_MS - 1);
    expect(h.saveUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    expect(h.replay(h.calls)).toBe('ab');
    await h.settle('ok');
    expect(h.statuses).toEqual(['saving', 'saved']);
  });

  it('caps continuous typing at 5 s', async () => {
    const h = harness();
    for (let t = 0; t < 6000; t += 200) {
      h.type('x');
      await vi.advanceTimersByTimeAsync(200);
      if (t === 4800) expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    }
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
  });

  it('keeps one request in flight; the next batch goes when it settles', async () => {
    const h = harness();
    h.type('one');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_QUIET_MS);
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    h.type('two');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS * 2);
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    await h.settle('ok');
    expect(h.saveUpdate).toHaveBeenCalledTimes(2);
    expect(h.replay(h.calls)).toBe('onetwo');
    await h.settle('ok');
    expect(h.autosave.status).toBe('saved');
  });

  it('lets a quiet timer still running send what was typed during a request', async () => {
    const h = harness();
    h.type('one');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_QUIET_MS);
    h.type('two');
    await h.settle('ok');
    expect(h.autosave.status).toBe('saving');
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_QUIET_MS);
    expect(h.saveUpdate).toHaveBeenCalledTimes(2);
  });

  it('flushes on demand, and a flush with nothing buffered sends nothing', async () => {
    const h = harness();
    h.autosave.flush();
    expect(h.saveUpdate).not.toHaveBeenCalled();
    h.type('now');
    h.autosave.flush();
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('failure', () => {
  it('goes offline, keeps the batch, and retries with backoff capped at 30 s', async () => {
    const h = harness();
    h.type('a');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_QUIET_MS);
    await h.settle(new TypeError('Failed to fetch'));
    expect(h.autosave.status).toBe('offline');

    // Typed while offline: carried by the retry, no timer of its own.
    h.type('b');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.saveUpdate).toHaveBeenCalledTimes(2);
    expect(h.replay([h.calls[1]!])).toBe('ab');

    // 4 s, 8 s, 16 s, then capped at 30 s.
    const delays = [4_000, 8_000, 16_000, AUTOSAVE_RETRY_MAX_MS, AUTOSAVE_RETRY_MAX_MS];
    for (const delay of delays) {
      const before = h.saveUpdate.mock.calls.length;
      await h.settle(new TypeError('Failed to fetch'));
      expect(h.autosave.status).toBe('offline');
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.saveUpdate).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.saveUpdate).toHaveBeenCalledTimes(before + 1);
    }

    await h.settle('ok');
    expect(h.autosave.status).toBe('saved');
    expect(h.statuses).toEqual(['saving', 'offline', 'saved']);
  });

  it('sends at once when edits arrived while an offline retry was out', async () => {
    const h = harness();
    h.type('a');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_QUIET_MS);
    await h.settle(new Error('500'));
    await vi.advanceTimersByTimeAsync(2_000);
    h.type('b');
    await h.settle('ok');
    expect(h.saveUpdate).toHaveBeenCalledTimes(3);
    // The third request carries 'b' alone; it reads after the retry's 'a'.
    expect(h.replay([h.calls[1]!, h.calls[2]!])).toBe('ab');
    expect(h.replay([h.calls[1]!])).toBe('a');
    expect(h.autosave.status).toBe('saving');
  });

  it('retries on the browser online event', async () => {
    const listeners = new Set<() => void>();
    const online: OnlineEventTarget = {
      addEventListener: (_t, l) => void listeners.add(l),
      removeEventListener: (_t, l) => void listeners.delete(l),
    };
    const h = harness({ online });
    // Online while nothing is offline does nothing.
    listeners.forEach((l) => l());
    h.type('a');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_QUIET_MS);
    // Nor while a request is out.
    listeners.forEach((l) => l());
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    await h.settle(new TypeError('offline'));
    listeners.forEach((l) => l());
    expect(h.saveUpdate).toHaveBeenCalledTimes(2);
    h.autosave.dispose();
    expect(listeners.size).toBe(0);
  });

  it('treats a saveUpdate that throws synchronously as a failure', async () => {
    const doc = new Y.Doc();
    const statuses: SaveStatus[] = [];
    const autosave = startAutosave({
      doc,
      saveUpdate: () => {
        throw new Error('boom');
      },
      onStatusChange: (s) => statuses.push(s),
      onlineTarget: null,
    });
    doc.transact(() => doc.getText('t').insert(0, 'x'), ySyncPluginKey);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_QUIET_MS);
    expect(autosave.status).toBe('offline');
    autosave.dispose();
  });
});

describe('too large', () => {
  it('recognises the refusal by its code', () => {
    expect(isPageBodyTooLarge(tooLargeError())).toBe(true);
    expect(isPageBodyTooLarge(new PageBodyTooLargeError(1, 2))).toBe(true);
    expect(isPageBodyTooLarge(new Error('x'))).toBe(false);
    expect(isPageBodyTooLarge(null)).toBe(false);
    expect(isPageBodyTooLarge('PAGE_BODY_TOO_LARGE')).toBe(false);
  });

  it('stops for good: too_large, and nothing is sent again', async () => {
    const h = harness();
    h.type('a');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_QUIET_MS);
    await h.settle(tooLargeError());
    expect(h.autosave.status).toBe('too_large');
    h.type('b');
    h.autosave.flush();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_RETRY_MAX_MS * 4);
    h.autosave.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    expect(h.statuses).toEqual(['saving', 'too_large']);
    expect(h.text.toString()).toBe('ab');
  });
});

describe('archived (MOTIR-7423)', () => {
  it('recognises the refusal by its code', () => {
    expect(isPageArchived(archivedError())).toBe(true);
    expect(isPageArchived(tooLargeError())).toBe(false);
    expect(isPageArchived(new Error('x'))).toBe(false);
    expect(isPageArchived(null)).toBe(false);
    expect(isPageArchived('PAGE_ARCHIVED')).toBe(false);
  });

  it('stops for good: archived, nothing is retried, and the content stays', async () => {
    const h = harness();
    h.type('a');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_QUIET_MS);
    await h.settle(archivedError());
    expect(h.autosave.status).toBe('archived');
    h.type('b');
    h.autosave.flush();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_RETRY_MAX_MS * 4);
    h.autosave.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    expect(h.statuses).toEqual(['saving', 'archived']);
    expect(h.text.toString()).toBe('ab');
  });
});

describe('dispose', () => {
  it('stops listening and sends what is buffered once, reporting nothing', async () => {
    const h = harness();
    h.type('a');
    h.autosave.dispose();
    h.autosave.dispose(); // idempotent
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    expect(h.replay(h.calls)).toBe('a');
    h.type('b');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS);
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    await h.settle(new Error('gone'));
    expect(h.statuses).toEqual(['saving']);
  });

  it('waits for a request in flight, and resends its batch if that one failed', async () => {
    const h = harness();
    h.type('a');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_QUIET_MS);
    h.type('b');
    h.autosave.dispose();
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    await h.settle(new TypeError('offline'));
    expect(h.saveUpdate).toHaveBeenCalledTimes(2);
    expect(h.replay([h.calls[1]!])).toBe('ab');
  });

  it('sends nothing when nothing is buffered', async () => {
    const h = harness();
    h.autosave.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.saveUpdate).not.toHaveBeenCalled();
  });

  it('listens on window by default', () => {
    const add = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal('window', { addEventListener: add, removeEventListener: remove });
    try {
      const autosave = startAutosave({
        doc: new Y.Doc(),
        saveUpdate: vi.fn(),
        onStatusChange: vi.fn(),
      });
      expect(add).toHaveBeenCalledWith('online', expect.any(Function));
      autosave.dispose();
      expect(remove).toHaveBeenCalledWith('online', expect.any(Function));
    } finally {
      vi.unstubAllGlobals();
    }
    // No window: nothing to listen on, and nothing throws.
    startAutosave({ doc: new Y.Doc(), saveUpdate: vi.fn(), onStatusChange: vi.fn() }).dispose();
  });
});
