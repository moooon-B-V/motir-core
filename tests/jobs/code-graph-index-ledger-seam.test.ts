import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import { codeGraphIndex } from '@/lib/jobs/definitions/codeGraphIndex';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { fakeOrchestrator } from '@/lib/orchestrator/adapters/fake';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  containerExitsWith,
  INDEX_REPO_REF,
  indexEventFor,
  indexJobRuns,
  indexSleepSteps,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
} from '../helpers/indexFleet';

// THE ASSEMBLED DISPATCH → LEDGER SEAM (Story MOTIR-1981 · MOTIR-1992) — the
// story's motir-core test gate, driving the REAL job on the `fake` orchestrator
// against a REAL Postgres and reading the result back through the ledger's REAL
// CONSUMERS.
//
// ⚠️ WHY NOT ASSERT THE `job_run` ROW. `tests/jobs/code-graph-index.test.ts`
// covers the durable step SHAPE and does assert the row — correctly, because the
// shape is what writes it. This file exists for the failure that assertion
// CANNOT see: KEY DRIFT between what the job writes and what the readers
// `select` on. `listSucceededCodeGraphIndexRepoRefs` matches on
// `output.repoRef`, `findSucceededCodeGraphIndex` matches on the same key for
// ONE repo, and both filter `status = 'succeeded'` and `functionId =
// 'system.code-graph-index'`. Rename any of those on either side and a row
// assertion still passes while every downstream reader goes blind — the enqueue
// gate re-indexes forever and the onboarding wizard's Next button never
// enables. So every assertion here goes through the shipped reader.
//
// The four things it pins (`docs/decisions/code-graph-index-fleet.md` §6):
//   1. A dispatched index is visible to BOTH real consumers — the enqueue gate's
//      repoRef set AND `MigrateIndexStatusDto`.
//   2. N repos produce N runs with N DISTINCT `output.repoRef`s — the contract
//      that forbids batching. Batching makes N−1 repos read as never-indexed.
//   3. The three no-op verdicts reach the ledger as `succeeded` and STILL do not
//      count as an index — the dangerous case, because those rows ARE succeeded.
//   4. A container failure's exit class is legible in the FAILURE RECORD, which
//      is written by `onFailure` (a separate Inngest invocation — PRODECT_FINDINGS
//      #39), not by the handler's own throw.

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await db.$executeRawUnsafe('TRUNCATE TABLE "migrate_onboarding" RESTART IDENTITY CASCADE');
  // The admission slots are real rows and no FK cascade reaches them; a file
  // that left them behind would slowly fill the index lane and start deferring
  // its own later cases.
  await db.fleetInFlightSlot.deleteMany({});
  _resetInstallationTokenCache();
  fakeOrchestrator.reset();
  resetTarballBodyTrap();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

/** The enqueue gate's view: the workspace's indexed repoRef set. */
function indexedRepoRefs(workspaceId: string): Promise<string[]> {
  return withSystemContext((tx) =>
    jobRunRepository.listSucceededCodeGraphIndexRepoRefs(workspaceId, tx),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · DISPATCH → LEDGER, through BOTH real readers.
// ─────────────────────────────────────────────────────────────────────────────

describe('a dispatched index is visible to the ledger’s REAL consumers', () => {
  it('the enqueue gate finds the repo AND the wizard’s status DTO shows it indexed', async () => {
    const { workspaceId, ownerUserId, projectIds, installationId } = await seedIndexWorkspace(
      'seam-both',
      1,
    );
    stubIndexFleet();
    containerExitsWith(0);

    const engine = new InngestTestEngine({ function: codeGraphIndex });
    const { result } = await engine.execute({
      events: [indexEventFor({ installationId, workspaceId })],
      steps: indexSleepSteps(projectIds),
    });
    expect(result).toMatchObject({ indexed: true, repoRef: INDEX_REPO_REF });

    // READER 1 — the enqueue gate (`enqueueFirstIndexForRepos` /
    // `sweepReposMissingFirstIndex` both build their indexed SET from this).
    expect(await indexedRepoRefs(workspaceId)).toEqual([INDEX_REPO_REF]);

    // READER 2 — the onboarding wizard's per-repo rows, through the SERVICE that
    // builds `MigrateIndexStatusDto`. It matches on a DIFFERENT repository method
    // (`findSucceededCodeGraphIndex`, keyed by repoRef) than reader 1, so a key
    // change that kept one working could still blind the other.
    const ctx = { userId: ownerUserId, workspaceId };
    const run = await migrateOnboardingService.startMigration(projectIds[0]!, ctx);
    const status = await migrateOnboardingService.getIndexStatus(run.id, ctx);

    expect(status.repos).toEqual([
      { provider: 'github', repoRef: INDEX_REPO_REF, status: 'indexed' },
    ]);
    expect(status.indexedCount).toBe(1);
    expect(status.total).toBe(1);
    // The wizard's Next button. A drifted key leaves this false forever, and the
    // migrate onboarding cannot be completed at all.
    expect(status.allIndexed).toBe(true);
  }, 30_000);

  it('a repo with no run reads as PENDING through the same DTO — the assertion is not vacuous', async () => {
    const { workspaceId, ownerUserId, projectIds } = await seedIndexWorkspace('seam-pending', 1);

    const ctx = { userId: ownerUserId, workspaceId };
    const run = await migrateOnboardingService.startMigration(projectIds[0]!, ctx);
    const status = await migrateOnboardingService.getIndexStatus(run.id, ctx);

    expect(status.repos).toEqual([
      { provider: 'github', repoRef: INDEX_REPO_REF, status: 'pending' },
    ]);
    expect(status.allIndexed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · ONE RUN, ONE repoRef, N REPOS — the contract that forbids batching (§6).
// ─────────────────────────────────────────────────────────────────────────────

describe('four repos produce four runs with four DISTINCT repoRefs', () => {
  it('never batches repos into one run — every repo carries its own claim', async () => {
    const repos = [
      { owner: 'moooon', name: 'motir-core' },
      { owner: 'moooon', name: 'motir-ai' },
      { owner: 'moooon', name: 'motir-gateway' },
      { owner: 'moooon', name: 'motir-meta' },
    ];
    const { workspaceId, ownerUserId, projectIds, installationId, repoRefs } =
      await seedIndexWorkspace('seam-four', 1, repos);
    stubIndexFleet();
    containerExitsWith(0);

    for (const repo of repos) {
      const engine = new InngestTestEngine({ function: codeGraphIndex });
      const { result } = await engine.execute({
        events: [
          indexEventFor({
            installationId,
            workspaceId,
            repoOwner: repo.owner,
            repoName: repo.name,
          }),
        ],
        steps: indexSleepSteps(projectIds),
      });
      expect(result).toEqual({
        indexed: true,
        repoRef: `${repo.owner}/${repo.name}`,
        projectsIndexed: 1,
      });
    }

    // FOUR rows, all succeeded, with FOUR distinct repoRefs. A run that batched
    // would leave one row claiming one ref, and the other three repos would read
    // as never-indexed to every consumer below — silently, forever.
    const runs = await indexJobRuns();
    expect(runs).toHaveLength(4);
    expect(runs.every((run) => run.status === 'succeeded')).toBe(true);
    const written = runs.map((run) => (run.output as { repoRef?: string } | null)?.repoRef);
    expect(new Set(written).size).toBe(4);

    // And the consumers agree, which is the point: the gate sees all four…
    expect((await indexedRepoRefs(workspaceId)).sort()).toEqual([...repoRefs].sort());
    // …and the wizard ticks all four, so its Next button enables.
    const ctx = { userId: ownerUserId, workspaceId };
    const run = await migrateOnboardingService.startMigration(projectIds[0]!, ctx);
    const status = await migrateOnboardingService.getIndexStatus(run.id, ctx);
    expect(status.total).toBe(4);
    expect(status.indexedCount).toBe(4);
    expect(status.allIndexed).toBe(true);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · THE NO-OP VERDICTS — `succeeded`, and still NOT an index.
// ─────────────────────────────────────────────────────────────────────────────

describe('a no-op verdict reaches the ledger and still does not count as an index', () => {
  // ⚠️ THE DANGEROUS SHAPE. These rows are `status: 'succeeded'` — the same
  // status a real index writes — and differ only in carrying no `output.repoRef`.
  // A reader that filtered on status alone would treat a vanished installation
  // as a built code graph and never index the repo again.
  it.each([
    ['installation_missing', 'the installation vanished before the job ran'],
    ['no_projects', 'the workspace has no project to index into'],
  ] as const)(
    '%s: a succeeded row with no repoRef is not a graph (%s)',
    async (reason, _why) => {
      const projectCount = reason === 'no_projects' ? 0 : 1;
      const { workspaceId, installationId } = await seedIndexWorkspace(
        `seam-${reason.slice(0, 6)}`,
        projectCount,
      );
      stubIndexFleet();

      const engine = new InngestTestEngine({ function: codeGraphIndex });
      const { result } = await engine.execute({
        events: [
          indexEventFor({
            // `installation_missing` is driven by naming an installation that is
            // not there; `no_projects` by a real one over an empty workspace.
            installationId: reason === 'installation_missing' ? 'inst-gone' : installationId,
            workspaceId,
          }),
        ],
      });
      expect(result).toEqual({ indexed: false, reason });

      // The row IS there, and it IS succeeded — the contract that the ledger
      // records WHY nothing was indexed.
      const runs = await indexJobRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe('succeeded');
      expect(runs[0]!.output).toEqual({ indexed: false, reason });

      // And NEITHER consumer counts it. The enqueue gate still sees nothing…
      expect(await indexedRepoRefs(workspaceId)).toEqual([]);
      // …so the operator sweep still finds the repo missing and would re-enqueue it.
      const report = await codeGraphIndexService.sweepReposMissingFirstIndex({
        workspaceId,
        dryRun: true,
      });
      expect(report.scanned).toBe(1);
      expect(report.alreadyIndexed).toBe(0);
      expect(report.missing.map((repo) => repo.repoRef)).toEqual([INDEX_REPO_REF]);
    },
    30_000,
  );

  it('workspace_missing writes no row at all, and the repo stays un-indexed', async () => {
    const { workspaceId, installationId } = await seedIndexWorkspace('seam-nows', 1);
    stubIndexFleet();

    const engine = new InngestTestEngine({ function: codeGraphIndex });
    const { result, error } = (await engine.execute({
      events: [indexEventFor({ installationId, workspaceId: 'ws-gone' })],
    })) as { result?: unknown; error?: unknown };

    // A vanished tenant is a clean no-op, never a throw — and `job_run`'s
    // workspace FK means there is no row to write for it (MOTIR-1545).
    expect(error).toBeUndefined();
    expect(result).toEqual({ indexed: false, reason: 'workspace_missing' });
    expect(await indexJobRuns()).toEqual([]);

    expect(await indexedRepoRefs(workspaceId)).toEqual([]);
    const report = await codeGraphIndexService.sweepReposMissingFirstIndex({
      workspaceId,
      dryRun: true,
    });
    expect(report.missing.map((repo) => repo.repoRef)).toEqual([INDEX_REPO_REF]);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · A FAILED CONTAINER'S REASON IS LEGIBLE IN THE FAILURE RECORD.
// ─────────────────────────────────────────────────────────────────────────────

describe('a container failure is legible in the ledger, not an opaque code', () => {
  // ⚠️ THE FAILURE RECORD IS WRITTEN BY `onFailure`, NOT BY THE THROW. A step
  // scheduled from a try/catch after the terminally-failed step never executes on
  // the real executor (PRODECT_FINDINGS #39), so `defineJob` moved the
  // dead-letter write into Inngest's `onFailure` — a SEPARATE invocation the
  // in-process engine does not drive. Asserting only the thrown error therefore
  // proves nothing about what an operator actually reads off the run. So this
  // drives the handler to its throw, then invokes the SHIPPED `onFailure` off the
  // function's own config with exactly the payload Inngest hands it.
  it.each([
    [30, 'graph_unbuildable'],
    [137, 'out_of_memory'],
  ] as const)(
    'exit %i lands in the failure record as %s',
    async (exitCode, exitClass) => {
      const { workspaceId, projectIds, installationId } = await seedIndexWorkspace(
        `seam-fail${exitCode}`,
        1,
      );
      stubIndexFleet();
      containerExitsWith(exitCode);
      const event = indexEventFor({ installationId, workspaceId });

      const engine = new InngestTestEngine({ function: codeGraphIndex });
      const { result, error } = (await engine.execute({
        events: [event],
        steps: indexSleepSteps(projectIds),
      })) as { result?: unknown; error?: { message?: string } };

      expect(result).toBeUndefined();
      // The handler threw, so the row it started is still `running` — the
      // intended UX for a retrying run, and the row `onFailure` correlates to.
      const running = await indexJobRuns();
      expect(running).toHaveLength(1);
      expect(running[0]!.status).toBe('running');

      // Now the terminal-failure invocation, with the shape `defineJob` reads:
      // the ORIGINAL event under `event.data.event`, and the error that ended it.
      const onFailure = (
        codeGraphIndex as unknown as { opts: { onFailure: (a: unknown) => unknown } }
      ).opts.onFailure;
      await onFailure({
        event: { data: { event, run_id: 'run-terminal' } },
        error: new Error(String(error?.message)),
        step: { run: async (_id: string, fn: () => unknown) => fn() },
      });

      // ⚠️ WHAT THE OPERATOR READS. The exit code is the container's entire
      // diagnostic channel, so the record names the class — "the parser died on
      // this tree" and "the kernel OOM-killed it" are different on-call responses,
      // and a bare `137` sends the wrong one to the repo instead of the fleet.
      const [failed] = await indexJobRuns();
      expect(failed!.status).toBe('failed');
      const failure = failed!.failure as { message?: string } | null;
      expect(failure?.message).toContain(exitClass);
      expect(failure?.message).toContain(INDEX_REPO_REF);
      expect(failure?.message).not.toBe(String(exitCode));

      // And the failed run still claims nothing: it carries no output, so no
      // consumer can read the repo as indexed.
      expect(failed!.output).toBeNull();
      expect(await indexedRepoRefs(workspaceId)).toEqual([]);
    },
    30_000,
  );
});
