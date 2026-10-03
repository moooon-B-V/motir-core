import { describe, expect, it } from 'vitest';
import { createConcurrencyGate } from '@/lib/async/concurrencyGate';

// The gate MOTIR-6788 puts in front of the CI-feedback consumer: at most `limit`
// units run at once, the rest wait in arrival order, and a unit that throws still
// gives its slot back.

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-queued microtask and continuation run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createConcurrencyGate', () => {
  it('runs at most `limit` units at once and queues the rest', async () => {
    const gate = createConcurrencyGate(2);
    const blockers = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = blockers.map((b, i) =>
      gate.run(async () => {
        started.push(i);
        await b.promise;
        return i;
      }),
    );
    await flush();
    expect(started).toEqual([0, 1]);
    expect(gate.active).toBe(2);
    expect(gate.queued).toBe(2);

    blockers[1]!.resolve();
    await flush();
    expect(started).toEqual([0, 1, 2]);
    expect(gate.active).toBe(2);
    expect(gate.queued).toBe(1);

    blockers[0]!.resolve();
    blockers[2]!.resolve();
    blockers[3]!.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect(gate.active).toBe(0);
    expect(gate.queued).toBe(0);
  });

  it('hands slots out in arrival order', async () => {
    const gate = createConcurrencyGate(1);
    const order: string[] = [];
    const first = deferred();
    const a = gate.run(async () => {
      order.push('a');
      await first.promise;
    });
    const b = gate.run(async () => {
      order.push('b');
    });
    const c = gate.run(async () => {
      order.push('c');
    });
    await flush();
    expect(order).toEqual(['a']);
    first.resolve();
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('frees the slot when a unit throws, and passes the error through', async () => {
    const gate = createConcurrencyGate(1);
    const failing = gate.run(async () => {
      throw new Error('boom');
    });
    const next = gate.run(async () => 'ran');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ran');
    expect(gate.active).toBe(0);
  });

  it('refuses a limit that is not a positive whole number', () => {
    expect(() => createConcurrencyGate(0)).toThrow(RangeError);
    expect(() => createConcurrencyGate(-1)).toThrow(RangeError);
    expect(() => createConcurrencyGate(1.5)).toThrow(RangeError);
  });
});
