import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine } from '../helpers/jobs';
import { db } from '@/lib/db';
import { codeGraphIndex } from '@/lib/jobs/definitions/codeGraphIndex';
import { codeGraphIndexDispatchService } from '@/lib/services/codeGraphIndexDispatchService';
import { fakeOrchestrator } from '@motir/orchestrator';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  INDEX_REPO_REF,
  containerExitsWith,
  driveIndexFleetFast,
  indexEventFor,
  indexJobRuns,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
} from '../helpers/indexFleet';

// WHERE A REFRESH'S CORE-SIDE TIME WENT (MOTIR-4413) — the LEDGER's half.
//
// `tests/ciFleet/codeGraphIndexDispatch.test.ts` proves the three spans are
// derived from sources that survive a `JobRunDefer`. This file proves the other
// end of the same wire: that what a dispatch measured reaches `job_run.output`,
// per `(repo × project)`, WITHOUT disturbing the three fields §6's ledger
// contract is made of.
//
// ⚠️ THE TWO HALVES ARE NOT REDUNDANT, and the split is the same one the fleet's
// own suites already use. A span can be derived perfectly and then dropped by the
// fan-out — `indexEveryProject` throws out of its loop on every pass but the
// last, so "the number was computed" and "the number reached the row" are
// genuinely different claims, and only the second is what an operator reads.

const REPO_REF = INDEX_REPO_REF;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  _resetInstallationTokenCache();
  fakeOrchestrator.reset();
  resetTarballBodyTrap();
  driveIndexFleetFast();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // FLEET-WIDE and reached by no cascade — see the note in
  // `tests/jobs/code-graph-index.test.ts`, which this file shares a world with.
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the ledger row carries the CORE-side phases, per (repo × project)', () => {
  it('records THREE named spans for EVERY project, beside the unchanged three fields', async () => {
    const { workspaceId, projectIds, installationId } = await seedIndexWorkspace('cgt-rows', 2);
    stubIndexFleet();
    containerExitsWith(0);

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result } = await engine.execute({
      events: [indexEventFor({ installationId, workspaceId, eventId: 'evt-cgt-rows' })],
    });

    const output = result as {
      indexed: boolean;
      repoRef: string;
      projectsIndexed: number;
      coreTimings?: { projectId: string; phasesMs: Record<string, number>; totalMs?: number }[];
    };

    // §6, untouched: this is what `listSucceededCodeGraphIndexRepoRefs` and the
    // onboarding wizard read, and the card that adds a fourth key is exactly the
    // card that has to prove it did not move the other three.
    expect(output.indexed).toBe(true);
    expect(output.repoRef).toBe(REPO_REF);
    expect(output.projectsIndexed).toBe(2);

    // ONE row per container, not one per repo. Two projects means two
    // containers, two admissions and two boots — and a single aggregated
    // `phasesMs` would make a slow boot on one of them unreadable.
    expect(output.coreTimings).toHaveLength(2);
    expect(output.coreTimings!.map((t) => t.projectId).sort()).toEqual([...projectIds].sort());
    for (const timing of output.coreTimings!) {
      expect(Object.keys(timing.phasesMs).sort()).toEqual([
        'admissionWait',
        'boot',
        'pollToDetect',
      ]);
      expect(timing.totalMs).toBe(Object.values(timing.phasesMs).reduce((sum, ms) => sum + ms, 0));
    }

    // AND IT IS ON THE PERSISTED ROW, not only in the handler's return value —
    // the ledger is the surface an operator actually reads, and it round-trips
    // through JSON to get there.
    const runs = await indexJobRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.output).toEqual(output);
  }, 30_000);

  it('a dispatch that reports NO spans still writes the ledger row it always wrote', async () => {
    const { workspaceId, installationId } = await seedIndexWorkspace('cgt-none', 1);
    stubIndexFleet();
    containerExitsWith(0);

    // ⚠️ THE STATE THIS MODELS IS A DEPLOYMENT MID-ROLLOUT, and it is the reason
    // the field is optional rather than merely nullable. A run already in flight
    // when this card ships replays an `index-admit` memo written in the old
    // shape for the rest of its life, so `coreTimings` comes back with an empty
    // map — and the row it writes must be byte-identical to the row it would
    // have written before, because §6 says that row is a permanent claim and
    // every reader of it predates this card.
    //
    // ⚠️ IT CHAINS OFF THE EXISTING SPY RATHER THAN RE-BINDING THE METHOD.
    // `driveIndexFleetFast` has already replaced `advanceIndexContainer`, and
    // `vi.spyOn` returns THAT SAME spy rather than a fresh one — so binding the
    // method here and calling it from a new implementation calls the new
    // implementation, which is a stack overflow rather than a failed assertion.
    const spy = vi.mocked(codeGraphIndexDispatchService.advanceIndexContainer);
    const withFastBudgets = spy.getMockImplementation()!;
    spy.mockImplementation(async (runId, input, options) => {
      const outcome = await withFastBudgets(runId, input, options);
      if (outcome.outcome !== 'settled') return outcome;
      return { ...outcome, coreTimings: { phasesMs: {} } };
    });

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result, error } = (await engine.execute({
      events: [indexEventFor({ installationId, workspaceId, eventId: 'evt-cgt-none' })],
    })) as { result?: unknown; error?: unknown };

    // Telemetry did not fail the run — the whole contract, stated as an
    // assertion. `logPhaseTimings` carries the same rule for the motir-ai half.
    expect(error).toBeUndefined();
    // EXACTLY the three fields. `toEqual` rather than `toMatchObject`, because
    // the claim is that no fourth key appears at all: an empty `coreTimings: []`
    // would be a run announcing that it measured nothing, which is noise on a row
    // many readers parse.
    expect(result).toEqual({ indexed: true, repoRef: REPO_REF, projectsIndexed: 1 });

    const runs = await indexJobRuns();
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.output).toEqual({ indexed: true, repoRef: REPO_REF, projectsIndexed: 1 });
  }, 30_000);
});
