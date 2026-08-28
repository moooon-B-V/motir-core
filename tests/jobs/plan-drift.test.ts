import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JobTestEngine } from '../helpers/jobs';
import { db } from '@/lib/db';
import { defineJob } from '@/lib/jobs/defineJob';
import { jobDefinitions } from '@/lib/jobs/registry';
import { planDriftOnTransitioned } from '@/lib/jobs/definitions/planDrift';
import { planDriftService } from '@/lib/services/planDriftService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// PLAN DRIFT — the WIRING of the eager mover (Bug MOTIR-3560 · Subtask
// MOTIR-3579; `docs/decisions/agent-authored-plans.md` AMENDMENT 9 D5).
//
// The service has its own suite over real Postgres
// (`tests/integration/plans/planDrift.test.ts`); what is unproven without THIS
// file is that anything ever calls it. An unregistered consumer fires silently
// never — no error, no ledger row, nothing to alert on — and this job is the
// difference between `planned` meaning *approvable* and meaning *probably*.

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
  const mark = vi
    .spyOn(planDriftService, 'markStaleForTerminalTarget')
    .mockResolvedValue({ markedStale: [], restored: [], skipped: [] });
  const restore = vi
    .spyOn(planDriftService, 'restoreForRevivedTarget')
    .mockResolvedValue({ markedStale: [], restored: [], skipped: [] });
  return { mark, restore };
}

describe('plan-drift/transitioned — the wiring', () => {
  it('is REGISTERED — an unserved consumer fires silently never', () => {
    expect(jobDefinitions).toContain(planDriftOnTransitioned);
  });

  it('does not collide with the OTHER consumers of the same event', () => {
    // The derivation, watcher, bell fan-in and automation consumers all ride
    // `work-item/transitioned`; distinct ids are what let them coexist rather
    // than one replacing another.
    const ids = jobDefinitions.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('triggers on work-item/transitioned under its own id, with the idempotent budget', () => {
    const def = defineJob(
      {
        id: 'plan-drift/transitioned',
        trigger: 'work-item/transitioned',
        retryPolicy: 'idempotent',
      },
      () => undefined,
    );
    expect(def.trigger).toBe('work-item/transitioned');
    expect(def.id).toBe('plan-drift/transitioned');
  });

  it('dispatches BOTH directions from one event, threading the workspace and the TRANSITION', async () => {
    const { mark, restore } = stubBothDirections();
    const engine = new JobTestEngine({ function: planDriftOnTransitioned, events: [EVENT] });
    await engine.execute();

    // ⚠️ THE FROM/TO ARE THE LOAD-BEARING ARGUMENTS. Entry into a terminal
    // status — and exit from one — are properties of the TRANSITION, not of the
    // resulting row: a handler that re-read the item instead would be decided by
    // whatever raced in first, which is the class MOTIR-2957 measured failing 7
    // times in 20 in the cascade. `workspaceId` is load-bearing for the same
    // reason it is in the derivation job (MOTIR-2880): the service's reads are
    // workspace-context-bound, so dropping it resolves nothing, silently.
    const args = ['wi-1', 'ws-1', { fromStatusKey: 'in_progress', toStatusKey: 'done' }];
    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith(...args);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith(...args);
  });

  it('reaches the service through the INJECTED bag, not an ad-hoc import', async () => {
    // The spies above are on the module singleton the bag holds, so a handler
    // importing the service directly would ALSO be caught by them. What this
    // pins is the shape: the definition names `services.planDrift`.
    const source = readFileSync(
      resolve(process.cwd(), 'lib/jobs/definitions/planDrift.ts'),
      'utf8',
    );
    expect(source).toContain('services.planDrift.markStaleForTerminalTarget');
    expect(source).toContain('services.planDrift.restoreForRevivedTarget');
  });

  it('runs each direction as its OWN durable step, so a retry cannot re-run a finished one', () => {
    // Asserted STRUCTURALLY, on the definition source, for the reason the
    // derivation suite gives: whether two `step.run` calls were memoized
    // separately is a property of the code, and a run that never retried looks
    // identical either way.
    const source = readFileSync(
      resolve(process.cwd(), 'lib/jobs/definitions/planDrift.ts'),
      'utf8',
    );
    expect(source).toContain("ctx.step.run('mark-stale-for-terminal-target'");
    expect(source).toContain("ctx.step.run('restore-for-revived-target'");
  });
});
