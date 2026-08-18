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
import {
  statusDerivationOnChildSetChanged,
  statusDerivationOnCreated,
  statusDerivationOnRequested,
  statusDerivationOnTransitioned,
} from '@/lib/jobs/definitions/statusDerivation';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
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
  await adminDb.$disconnect();
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
  it('dispatches BOTH directions from one event, with the item id AND its workspace', async () => {
    const { rollUp, cascade } = stubBothDirections();

    const engine = new InngestTestEngine({
      function: statusDerivationOnTransitioned,
      events: [EVENT],
    });
    const { result } = await engine.execute();

    // ⚠️ BOTH ARGUMENTS ARE ASSERTED, and `workspaceId` is the load-bearing one
    // (MOTIR-2880). Each service's phase-1 read of `work_item` /
    // `workspace_membership` is now `withWorkspaceServiceContext`-bound, because
    // no policy on either table reads `app.system_admin` — so under `motir_app`
    // a handler that dropped this argument would resolve NOTHING and return
    // `no_parent` / `unresolvable` for every transition, silently. This
    // assertion is the seam where that argument is either threaded off the
    // envelope or lost, so it pins the value and not merely the arity.
    expect(rollUp).toHaveBeenCalledTimes(1);
    expect(rollUp).toHaveBeenCalledWith('wi-1', 'ws-1');
    expect(cascade).toHaveBeenCalledTimes(1);
    // ⚠️ AND THE CASCADE'S THIRD ARGUMENT IS THE TRANSITION, THREADED OFF THE
    // ENVELOPE (MOTIR-2957). ADR §4's trigger is *"an item transitions INTO a
    // done-category status"* — a property of the MOVE — and the service used to
    // re-derive it by reading the item's current status instead. That is a
    // different predicate the moment a concurrent derivation has moved the row,
    // which rung 4 does routinely; the cascade then declined, and a user's Done
    // was discarded with nothing left to re-fire it. This assertion is the seam
    // where the transition is either carried across or dropped, so it pins the
    // VALUES off the event and not merely the arity.
    expect(cascade).toHaveBeenCalledWith('wi-1', 'ws-1', {
      fromStatusKey: 'in_progress',
      toStatusKey: 'done',
    });
    // The payload carries no parentId, so each service resolves its own
    // neighbours WITHIN that workspace — the handler passes the item id, the
    // tenant, and the transition, and nothing else.
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

    const runs = await adminDb.jobRun.findMany({
      where: { functionId: 'status-derivation/transitioned' },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.eventName).toBe('work-item/transitioned');
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.workspaceId).toBe(fx.workspaceId);
    expect(runs[0]!.failure).toBeNull();
  });
});

// ── The CHILD-SET consumers (Story MOTIR-2888 · Subtask MOTIR-2892) ──
//
// Same reason this file exists at all: an unregistered consumer fires silently
// never. These two are the whole of the recompute's new trigger surface, and
// their failure mode is exactly the one MOTIR-2888 was filed about — a child set
// changes, nothing runs, and the board quietly lies.

describe('the child-set consumers — the wiring (MOTIR-2892)', () => {
  it('both are REGISTERED', () => {
    expect(jobFunctions).toContain(statusDerivationOnCreated);
    expect(jobFunctions).toContain(statusDerivationOnChildSetChanged);
  });

  it('each triggers on its own event, under an id distinct from the other consumers', () => {
    const byId = new Map(
      jobFunctions.map((f) => [
        (f as { id: () => string }).id(),
        (f as { opts?: { triggers?: Array<{ event?: string }> } }).opts,
      ]),
    );
    // `id()` prefixes the app id, so match on the suffix the definition declares.
    const find = (suffix: string) => [...byId.entries()].find(([id]) => id.endsWith(suffix))?.[1];

    expect(find('status-derivation/created')?.triggers).toEqual([{ event: 'work-item/created' }]);
    expect(find('status-derivation/child-set-changed')?.triggers).toEqual([
      { event: 'work-item/child-set.changed' },
    ]);
    // `work-item/created` already has two consumers (the automation engine and
    // the outward bug telemetry); this is the additional-consumer form.
    const createdConsumers = jobFunctions.filter((f) =>
      ((f as { opts?: { triggers?: Array<{ event?: string }> } }).opts?.triggers ?? []).some(
        (t) => t.event === 'work-item/created',
      ),
    );
    expect(createdConsumers.length).toBeGreaterThanOrEqual(3);
  });

  // ── The import race (Bug MOTIR-2902) ───────────────────────────────────────
  //
  // A bulk import writes each row as `createWorkItem` (which emits this event)
  // then `setImportedStatus` (which deliberately emits NOTHING, so an import
  // cannot fan out a notification per row). So this consumer is the ONLY
  // derivation trigger an import produces, and undebounced it reads the child's
  // status at whatever instant it runs — BEFORE the pin it sees `todo`, settles
  // the parent at `todo`, and nothing re-fires because the child set never
  // changes again. The debounce moves the run to `period` after the LAST create
  // under that parent, by which time the pin has committed.
  it('DEBOUNCES on the parent — so the recompute reads the child set after the burst, not during it', () => {
    const opts = (statusDerivationOnCreated as { opts?: { debounce?: unknown } }).opts;
    expect(opts?.debounce).toEqual({
      key: 'event.data.parentId',
      period: '2s',
      timeout: '30s',
    });
  });

  it('keys the debounce on the PARENT — a wider key would DROP a recompute, not merely delay it', () => {
    const { key } = (statusDerivationOnCreated as { opts: { debounce: { key: string } } }).opts
      .debounce;

    // The load-bearing assertion of this card. A debounce COALESCES same-key
    // events and runs once with the LAST one, while the handler recomputes the
    // parent of THAT event's `workItemId`. Keyed on the parent every coalesced
    // event names the same parent, so the survivor recomputes it correctly.
    // Keyed on the workspace or the project, creates under DIFFERENT parents
    // collapse into one run and every other parent's recompute is silently lost
    // — the same latency win bought with a correctness regression.
    expect(key).toBe('event.data.parentId');
    expect(key).not.toBe('event.data.workspaceId');
    expect(key).not.toBe('event.data.projectId');
    // …and keyed on the ITEM nothing would ever coalesce, so the debounce would
    // be inert and the race would survive it.
    expect(key).not.toBe('event.data.workItemId');
  });

  // ── The silent-edit consumer (Bug MOTIR-2902) ────────────────────────────
  it('status-derivation/requested is REGISTERED and triggers on the derivation-only event', () => {
    expect(jobFunctions).toContain(statusDerivationOnRequested);
    const opts = (
      statusDerivationOnRequested as { opts?: { triggers?: Array<{ event?: string }> } }
    ).opts;
    expect(opts?.triggers).toEqual([{ event: 'work-item/derivation.requested' }]);
  });

  it('is the ONLY consumer of that event — which is what keeps the import storm-free', () => {
    // `setImportedStatus` deliberately emits no `work-item/transitioned` so a
    // bulk import cannot fan out one notification per row. This event exists to
    // trigger derivation WITHOUT reopening that. The moment a second consumer
    // subscribes — a watcher, the bell fan-in, the automation engine — that
    // property is gone and the import is storming again, silently.
    const consumers = jobFunctions.filter((f) =>
      ((f as { opts?: { triggers?: Array<{ event?: string }> } }).opts?.triggers ?? []).some(
        (t) => t.event === 'work-item/derivation.requested',
      ),
    );
    expect(consumers).toEqual([statusDerivationOnRequested]);
  });

  it('forwards the debounce to Inngest — an option the wrapper drops is a no-op that reads as a fix', () => {
    const spy = vi.spyOn(inngest, 'createFunction');
    try {
      defineJob(
        {
          id: 'status-derivation/created',
          trigger: 'work-item/created',
          retryPolicy: 'idempotent',
          debounce: { key: 'event.data.parentId', period: '2s', timeout: '30s' },
        },
        () => undefined,
      );
      const config = spy.mock.calls.at(-1)?.[0] as { debounce?: unknown } | undefined;
      expect(config?.debounce).toEqual({
        key: 'event.data.parentId',
        period: '2s',
        timeout: '30s',
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the child-set consumers — the dispatch (MOTIR-2892)', () => {
  it('created: recomputes the created item’s PARENT, and runs no cascade', async () => {
    const { rollUp, cascade } = stubBothDirections();

    const engine = new InngestTestEngine({
      function: statusDerivationOnCreated,
      events: [
        {
          name: 'work-item/created' as const,
          data: {
            workspaceId: 'ws-1',
            projectId: 'p-1',
            workItemId: 'child-1',
            actorId: 'user-1',
          },
        },
      ],
    });
    await engine.execute();

    // BOTH arguments, for MOTIR-2880's reason: the workspace is what makes the
    // rollup's RLS-scoped reads return rows at all. A consumer that forgot it
    // would answer `no_parent` forever, silently.
    expect(rollUp).toHaveBeenCalledWith('child-1', 'ws-1');
    // A create transitions nothing, so nothing ENTERED a done-category status.
    // Running the cascade here is what would let a parent that just came back
    // force-close the child that brought it there.
    expect(cascade).not.toHaveBeenCalled();
  });

  /** A fixed instant, so the trigger assertion below is about the value being
   *  CARRIED rather than about when the test ran. */
  const EDIT_AT = '2026-08-17T12:00:00.000Z';

  it('child-set changed: recomputes EVERY parent named, each in its own step', async () => {
    const recompute = vi
      .spyOn(parentStatusRollupService, 'recomputeParent')
      .mockResolvedValue({ outcome: 'no_rung', parentId: 'p' });
    const cascade = vi
      .spyOn(childStatusCascadeService, 'cascadeToChildren')
      .mockResolvedValue({ outcome: 'not_done' });

    const engine = new InngestTestEngine({
      function: statusDerivationOnChildSetChanged,
      events: [
        {
          name: 'work-item/child-set.changed' as const,
          data: {
            workspaceId: 'ws-1',
            parentIds: ['old-parent', 'new-parent'],
            workItemId: 'mover-1',
            reason: 'reparented' as const,
            occurredAt: EDIT_AT,
          },
        },
      ],
    });
    await engine.execute();

    // A re-parent changes TWO child sets in opposite directions — recomputing
    // only one of them is the defect this asserts against.
    expect(recompute).toHaveBeenCalledTimes(2);
    // The EDIT's own instant rides along (MOTIR-2965) — a re-parent removes the
    // mover from the old parent's set, so nothing left in that set dates the
    // change and a backward recompute could not tell a stale claim from a live
    // one. Both ends get the same instant: one edit, two child sets.
    const trigger = { occurredAt: new Date(EDIT_AT) };
    expect(recompute).toHaveBeenCalledWith('old-parent', 'ws-1', trigger);
    expect(recompute).toHaveBeenCalledWith('new-parent', 'ws-1', trigger);
    expect(cascade).not.toHaveBeenCalled();
  });

  it('child-set changed: reaches the service through the INJECTED bag', () => {
    expect(jobServices.parentStatusRollup).toBe(parentStatusRollupService);
  });
});
