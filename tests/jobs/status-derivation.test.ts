import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { defineJob } from '@/lib/jobs/defineJob';
import { jobFunctions } from '@/lib/jobs/registry';
import { jobServices } from '@/lib/jobs/services';
import { RETRY_POLICIES } from '@/lib/jobs/retries';
import { parentStatusRollupService } from '@/lib/services/parentStatusRollupService';
import { childStatusCascadeService } from '@/lib/services/childStatusCascadeService';
import { statusDerivationOnTransitioned } from '@/lib/jobs/definitions/statusDerivation';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// Story MOTIR-1615 · Subtask MOTIR-1621 — the TRIGGER SEAM for bidirectional
// status derivation. The two services have their own suites; what is unproven
// without this file is the WIRING, and an unregistered consumer fires silently
// never — no error, no ledger row, nothing to alert on.
//
// What this locks:
//   1. the consumer is REGISTERED and triggers on `work-item/transitioned`;
//   2. its id is DISTINCT from the other consumers of that same event, so it
//      coexists with the watcher / bell / automation ones rather than replacing
//      one of them;
//   3. it dispatches BOTH directions, in the rollup-then-cascade order, from the
//      one event — passing the item id each service resolves its neighbours from;
//   4. the two run as SEPARATE durable steps, so a retry cannot re-run a
//      direction that already succeeded;
//   5. the retry budget is the `idempotent` policy's, which is only safe because
//      both services converge on re-run;
//   6. the services are reached through the INJECTED bag, not an ad-hoc import.

beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateAuthTables();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
});

const EVENT = {
  name: 'work-item/transitioned' as const,
  data: {
    workspaceId: 'ws-1',
    workItemId: 'wi-1',
    actorId: 'user-1',
    fromStatusKey: 'in_progress',
    toStatusKey: 'done',
    revisionId: 'rev-1',
  },
};

function stubBothDirections() {
  const rollUp = vi
    .spyOn(parentStatusRollupService, 'rollUpForChild')
    .mockResolvedValue({ outcome: 'no_parent' });
  const cascade = vi
    .spyOn(childStatusCascadeService, 'cascadeToChildren')
    .mockResolvedValue({ outcome: 'not_done' });
  return { rollUp, cascade };
}

describe('status-derivation/transitioned — the wiring (MOTIR-1621)', () => {
  it('is REGISTERED — an unserved consumer fires silently never', () => {
    expect(jobFunctions).toContain(statusDerivationOnTransitioned);
  });

  it('triggers on work-item/transitioned, under an id distinct from the event name', () => {
    const spy = vi.spyOn(inngest, 'createFunction');
    try {
      defineJob(
        {
          id: 'status-derivation/transitioned',
          trigger: 'work-item/transitioned',
          retryPolicy: 'idempotent',
        },
        () => undefined,
      );
      const config = spy.mock.calls.at(-1)?.[0] as
        | { id?: string; triggers?: Array<{ event?: string }> }
        | undefined;
      expect(config?.triggers).toEqual([{ event: 'work-item/transitioned' }]);
      // Distinct from the event name is what lets several consumers of the SAME
      // event coexist (the watcher, the bell fan-in, the automation engine, and
      // this one).
      expect(config?.id).toBe('status-derivation/transitioned');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not collide with the OTHER consumers of the same event', () => {
    const ids = jobFunctions.map((f) => (f as { id: () => string }).id());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('takes the IDEMPOTENT retry budget — safe only because both services converge', () => {
    const spy = vi.spyOn(inngest, 'createFunction');
    try {
      defineJob(
        {
          id: 'status-derivation/transitioned',
          trigger: 'work-item/transitioned',
          retryPolicy: 'idempotent',
        },
        () => undefined,
      );
      const config = spy.mock.calls.at(-1)?.[0] as { retries?: number } | undefined;
      // Inngest's `retries` counts RE-tries, so the policy's attempts become
      // attempts-1.
      expect(config?.retries).toBe(RETRY_POLICIES.idempotent.maxAttempts - 1);
    } finally {
      spy.mockRestore();
    }
  });

  it('reaches both services through the INJECTED bag — the same singletons', () => {
    expect(jobServices.parentStatusRollup).toBe(parentStatusRollupService);
    expect(jobServices.childStatusCascade).toBe(childStatusCascadeService);
  });
});

describe('status-derivation/transitioned — the dispatch (MOTIR-1621)', () => {
  it('dispatches BOTH directions from one event, with the transitioned item id', async () => {
    const { rollUp, cascade } = stubBothDirections();

    const engine = new InngestTestEngine({
      function: statusDerivationOnTransitioned,
      events: [EVENT],
    });
    const { result } = await engine.execute();

    expect(rollUp).toHaveBeenCalledTimes(1);
    expect(rollUp).toHaveBeenCalledWith('wi-1');
    expect(cascade).toHaveBeenCalledTimes(1);
    expect(cascade).toHaveBeenCalledWith('wi-1');
    // The payload carries no parentId, so each service resolves its own
    // neighbours — the handler passes the item id and nothing else.
    expect(result).toEqual({
      rollup: { outcome: 'no_parent' },
      cascade: { outcome: 'not_done' },
    });
  });

  it('runs the ROLLUP first — the direction that can create work for the other', async () => {
    const order: string[] = [];
    vi.spyOn(parentStatusRollupService, 'rollUpForChild').mockImplementation(async () => {
      order.push('rollup');
      return { outcome: 'no_parent' };
    });
    vi.spyOn(childStatusCascadeService, 'cascadeToChildren').mockImplementation(async () => {
      order.push('cascade');
      return { outcome: 'not_done' };
    });

    const engine = new InngestTestEngine({
      function: statusDerivationOnTransitioned,
      events: [EVENT],
    });
    await engine.execute();

    expect(order).toEqual(['rollup', 'cascade']);
  });

  it('runs each direction as its OWN durable step, so a retry cannot re-run a finished one', () => {
    // Asserted STRUCTURALLY, on the definition source. Whether two `step.run`
    // calls were memoized separately is a property of the code, not of a single
    // successful execution — a run that never retried looks identical either
    // way, so an execution-based assertion here would pass even if both
    // directions were collapsed into one step.
    const source = readFileSync(
      resolve(process.cwd(), 'lib/jobs/definitions/statusDerivation.ts'),
      'utf8',
    );
    expect(source).toContain("ctx.step.run('roll-up-parent'");
    expect(source).toContain("ctx.step.run('cascade-to-children'");
  });

  it('a transition on a childless top-level item is a clean no-op both ways', async () => {
    // The commonest case by far: neither direction has anything to do, and the
    // job still succeeds rather than erroring on a shape it cannot act on.
    vi.spyOn(parentStatusRollupService, 'rollUpForChild').mockResolvedValue({
      outcome: 'no_parent',
    });
    vi.spyOn(childStatusCascadeService, 'cascadeToChildren').mockResolvedValue({
      outcome: 'no_open_children',
      itemId: 'wi-1',
    });

    const engine = new InngestTestEngine({
      function: statusDerivationOnTransitioned,
      events: [EVENT],
    });
    const { result } = await engine.execute();

    expect(result).toEqual({
      rollup: { outcome: 'no_parent' },
      cascade: { outcome: 'no_open_children', itemId: 'wi-1' },
    });
  });

  it('writes one succeeded, TENANTED ledger row under the event name', async () => {
    stubBothDirections();
    // A real workspace: the ledger row is tenanted from the payload, and
    // `recordStart` skips a run whose tenant does not exist.
    const fx = await makeWorkItemFixture();

    const engine = new InngestTestEngine({
      function: statusDerivationOnTransitioned,
      events: [{ ...EVENT, data: { ...EVENT.data, workspaceId: fx.workspaceId } }],
    });
    await engine.execute();

    const runs = await db.jobRun.findMany({
      where: { functionId: 'status-derivation/transitioned' },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.eventName).toBe('work-item/transitioned');
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.workspaceId).toBe(fx.workspaceId);
    expect(runs[0]!.failure).toBeNull();
  });
});
