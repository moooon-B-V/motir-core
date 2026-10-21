// MOTIR-9186 — a stream whose read THROWS is a lost connection, not a failed job.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeStream } from '@/lib/planning/planEditsClient';

const enc = new TextEncoder();

/** A response whose body yields `chunks`, then rejects the next read. */
function droppingResponse(chunks: string[]): Response {
  let i = 0;
  const reader = {
    read: async () => {
      if (i < chunks.length) return { done: false, value: enc.encode(chunks[i++]) };
      throw new TypeError('network error');
    },
  };
  return { ok: true, body: { getReader: () => reader } } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('consumeStream — transport failure vs server error', () => {
  it('reports a read that rejects through onLost, never onError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => droppingResponse(['event: status\ndata: {"status":"running"}\n\n'])),
    );
    const onError = vi.fn();
    const onDone = vi.fn();
    const onLost = vi.fn();
    const onFrame = vi.fn();

    await consumeStream('/s', new AbortController().signal, onError, onDone, onFrame, onLost);

    expect(onFrame).toHaveBeenCalledWith('status', { status: 'running' });
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('reports a fetch that rejects through onLost', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const onError = vi.fn();
    const onLost = vi.fn();

    await consumeStream('/s', new AbortController().signal, onError, vi.fn(), undefined, onLost);

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps onError(null) for a caller that passes no onLost', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => droppingResponse([])),
    );
    const onError = vi.fn();

    await consumeStream('/s', new AbortController().signal, onError, vi.fn());

    expect(onError).toHaveBeenCalledWith(null);
  });

  it('still reports a server error frame through onError, never onLost', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => droppingResponse(['event: error\ndata: {"code":"BOOM"}\n\n'])),
    );
    const onError = vi.fn();
    const onLost = vi.fn();

    await consumeStream('/s', new AbortController().signal, onError, vi.fn(), undefined, onLost);

    expect(onError).toHaveBeenCalledWith('BOOM');
    expect(onLost).not.toHaveBeenCalled();
  });

  it('says nothing for an aborted request', async () => {
    const ac = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    );
    const onError = vi.fn();
    const onLost = vi.fn();

    await consumeStream('/s', ac.signal, onError, vi.fn(), undefined, onLost);

    expect(onError).not.toHaveBeenCalled();
    expect(onLost).not.toHaveBeenCalled();
  });
});
