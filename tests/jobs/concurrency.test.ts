import { describe, expect, it, vi } from 'vitest';
import { inngest } from '@/lib/jobs/client';
import { defineJob, type ConcurrencyOption } from '@/lib/jobs/defineJob';

// The concurrency boundary (MOTIR-1982). `defineJob` used to declare
// `concurrency?: number` and emit `{ limit: n }`, which meant `key` and
// `scope` — Inngest's own per-TENANT sub-queue controls — could not be
// expressed by ANY job in this repo. These tests pin the widened contract at
// both ends: what defineJob hands `createFunction`, and what the constructed
// Inngest function actually kept.
//
// Two assertion surfaces, deliberately:
//   - the `createFunction` spy proves what defineJob PASSED (the repo's
//     existing pattern, see retries.test.ts). It only works because defineJob
//     is called INLINE here — pointed at a definition module under
//     `vi.resetModules()` it silently captures nothing, because the re-imported
//     module builds against a fresh client the spy never saw.
//   - `fn.opts` proves what Inngest KEPT after construction, so a future SDK
//     that normalized or dropped `key`/`scope` would fail here even though the
//     spy still looked right.

/** The Inngest config object defineJob builds, narrowed to the field under test. */
type ConfigWithConcurrency = {
  concurrency?: number | ConcurrencyOption | ConcurrencyOption[];
};

/** Define a job inline and return BOTH views of its concurrency config. */
function captureConcurrency(concurrency?: number | ConcurrencyOption | ConcurrencyOption[]) {
  const spy = vi.spyOn(inngest, 'createFunction');
  try {
    const fn = defineJob(
      { id: 'system.code-graph-index', ...(concurrency !== undefined ? { concurrency } : {}) },
      () => undefined,
    );
    return {
      /** What defineJob passed to createFunction. */
      passed: (spy.mock.calls.at(-1)?.[0] as ConfigWithConcurrency | undefined)?.concurrency,
      /** What the constructed Inngest function kept. */
      kept: (fn as unknown as { opts: ConfigWithConcurrency }).opts.concurrency,
    };
  } finally {
    spy.mockRestore();
  }
}

describe('defineJob forwards concurrency to Inngest', () => {
  it('omits concurrency entirely when the job does not declare one', () => {
    const { passed, kept } = captureConcurrency();
    expect(passed).toBeUndefined();
    expect(kept).toBeUndefined();
  });

  it('normalizes a bare number to { limit: n } — the pre-MOTIR-1982 behaviour, unchanged', () => {
    const { passed, kept } = captureConcurrency(2);
    expect(passed).toEqual({ limit: 2 });
    expect(kept).toEqual({ limit: 2 });
  });

  it('forwards a KEYED option unmangled — key and scope both survive', () => {
    const keyed: ConcurrencyOption = {
      limit: 1,
      key: 'event.data.workspaceId',
      scope: 'env',
    };
    const { passed, kept } = captureConcurrency(keyed);
    // Deep equality, not a field spot-check: the point of the card is that
    // fields were being DROPPED, so the assertion has to be exhaustive.
    expect(passed).toEqual({ limit: 1, key: 'event.data.workspaceId', scope: 'env' });
    expect(kept).toEqual({ limit: 1, key: 'event.data.workspaceId', scope: 'env' });
  });

  it('forwards an ARRAY of constraints unmangled, in order', () => {
    // The fairness + capacity pair: no single tenant occupies more than one
    // slot, and the job as a whole never exceeds four.
    const constraints: ConcurrencyOption[] = [
      { limit: 1, key: 'event.data.workspaceId' },
      { limit: 4 },
    ];
    const { passed, kept } = captureConcurrency(constraints);
    expect(passed).toEqual([{ limit: 1, key: 'event.data.workspaceId' }, { limit: 4 }]);
    expect(kept).toEqual([{ limit: 1, key: 'event.data.workspaceId' }, { limit: 4 }]);
    // Order is part of the contract — Inngest reads the entries positionally.
    expect((kept as ConcurrencyOption[])[0]?.key).toBe('event.data.workspaceId');
  });

  it('does not share or mutate the caller’s constraint array', () => {
    const constraints: ConcurrencyOption[] = [{ limit: 1, key: 'event.data.workspaceId' }];
    captureConcurrency(constraints);
    expect(constraints).toEqual([{ limit: 1, key: 'event.data.workspaceId' }]);
  });
});
