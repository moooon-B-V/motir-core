// E2E: the index WRITER path actually executes in this lane
// (Story MOTIR-3417 · Subtask MOTIR-3564).
//
// ⚠️ THIS IS THE SEAM'S OWN PROOF, NOT THE STORY'S E2E. MOTIR-3487 owns the
// story-level assertions — coalescing a push burst, two repos staying
// independent, the dashboard, and a mid-index worker restart. This spec asserts
// exactly one thing: that a `system.code-graph-refresh` run claimed by the lane's
// worker can now REACH `settleIndexContainer` and leave the ledger row the whole
// index path exists to produce. Everything MOTIR-3487 wants is built on that, and
// until this passes none of it is writable.
//
// ⚠️ WHY THE SEAM WAS NEEDED AT ALL. `bootIndexContainer` crosses two boundaries
// before it provisions: motir-ai's run-credential mint and GitHub's tarball
// redirect. Neither had a stub in this lane, and `migrate-index-fleet.spec.ts` —
// which looks like it drives the fleet — SEEDS ledger rows and says so in its own
// header. `lib/test-code-graph-mock.ts` is the stub; the worker installs it,
// because the supervisor is a JOB and the worker is the process that makes both
// calls.
//
// ⚠️ AND NOTHING HERE REACHES THE NETWORK. The container is the `fake`
// orchestrator (selected by the shipped `MOTIR_FLEET_ORCHESTRATOR` seam), the two
// HTTP boundaries are undici intercepts, and the download host carries a trap
// that fails loudly if anything ever tries to fetch the archive in-process.

import { expect, test } from '@playwright/test';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { truncateJobRuns } from '@/tests/helpers/db';
import { signUp, createFirstProject } from './_helpers/shell-session';
import { clearJobRouting, routeJobsToEngine } from './_helpers/job-routing';
import { postSignedWebhook } from './_helpers/github-seed';
import {
  E2E_INDEX_INSTALLATION_ID,
  E2E_INDEX_REPOS,
  indexRepoRef,
  seedConnectedRepos,
} from './_helpers/migrate-index-seed';

const REFRESH_JOB = 'system.code-graph-refresh';
const [REPO] = E2E_INDEX_REPOS;

// ⚠️ THE WAIT IS THE DECLARED DEBOUNCE WINDOW, not slowness. `codeGraphRefresh`
// declares `period: '2m'`, and the engine implements it (MOTIR-3483) by setting
// `run_at` two minutes after the last same-key arrival — so a single push is due
// two minutes later BY CONTRACT. Add the worker's claim interval, the boot, a
// poll at the shipped 3s cadence and the settle, and the floor is ~2m10s. The
// budget below is that plus room, and shortening it would mean changing the job's
// declaration, which is exactly what this spec must not do.
test.describe.configure({ timeout: 360_000 });

test.beforeEach(async () => {
  await resetDatabase();
  await truncateJobRuns();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "job_event", "job_queue", "job_step" RESTART IDENTITY CASCADE',
  );
  await adminDb.fleetInFlightSlot.deleteMany({});
  await routeJobsToEngine(REFRESH_JOB);
});

test.afterEach(async () => {
  // Unconditional: a spec that leaves the routing set hands the next spec a
  // server running this job on a lane it was not written against.
  await clearJobRouting();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

/** The `push` delivery a default-branch commit produces. */
function pushPayload(head: string) {
  return {
    ref: `refs/heads/${REPO!.defaultBranch}`,
    after: head,
    installation: { id: Number(E2E_INDEX_INSTALLATION_ID) },
    repository: {
      // ⚠️ THE STORED PROVIDER ID, not an invented one. `handlePush` resolves the
      // repo by `(installation, providerRepoId)`, and a mismatch returns 2xx with
      // `unknown_repo` — which is why the assertion below is on the OUTCOME and
      // not on the status.
      id: Number(REPO!.providerRepoId),
      name: REPO!.name,
      full_name: `${REPO!.owner}/${REPO!.name}`,
      default_branch: REPO!.defaultBranch,
      owner: { login: REPO!.owner },
    },
  };
}

test('a push drives the index writer to a SUCCEEDED ledger row on the engine @smoke', async ({
  page,
  request,
}) => {
  const email = `writer-seam-${Date.now()}@example.test`;
  await signUp(page, email);
  await createFirstProject(page, 'Writer Seam');

  const local = email.split('@')[0]!;
  const ws = await adminDb.workspace.findFirstOrThrow({
    where: { name: `${local}'s Workspace` },
  });
  await seedConnectedRepos(ws.id, [REPO!]);

  const res = await postSignedWebhook(request, 'push', pushPayload('sha-writer-seam'));
  expect(res.status(), 'the webhook route must accept the delivery').toBeLessThan(300);
  // ⚠️ THE OUTCOME, NOT THE STATUS. `handlePush` answers 2xx for
  // `unknown_installation`, `unknown_repo` and `ignored_ref` alike — the ack never
  // hinges on the queue — so a status assertion alone would pass on a delivery
  // that enqueued nothing and leave the real failure to surface 150 seconds later
  // as a missing ledger row.
  expect(await res.json()).toMatchObject({ result: { outcome: 'refresh_enqueued' } });

  // ⚠️ THE AUTHORITATIVE SIGNAL IS THE LEDGER ROW, never a timer and never a
  // rendered pixel. The run is debounced (2m by declaration), claimed by the
  // worker, supervised across several polls and then settled — so the wait is on
  // the row reaching a TERMINAL state, and the assertion is on what it says.
  await expect
    .poll(
      async () =>
        (
          await adminDb.jobRun.findFirst({
            where: { functionId: REFRESH_JOB },
            orderBy: { startedAt: 'desc' },
          })
        )?.status ?? 'none',
      {
        message: 'the refresh run should reach a terminal state on the engine',
        timeout: 300_000,
        intervals: [1_000],
      },
    )
    .toBe('succeeded');

  // ONE row per repo, carrying ONE `output.repoRef` — the contract MOTIR-3417
  // refuses to let this story change, and the thing `listSucceededCodeGraphIndexRepoRefs`
  // and the onboarding wizard both read.
  const runs = await adminDb.jobRun.findMany({ where: { functionId: REFRESH_JOB } });
  expect(runs).toHaveLength(1);
  expect(runs[0]!.output).toMatchObject({
    indexed: true,
    repoRef: indexRepoRef(REPO!),
    projectsIndexed: 1,
  });

  // ⚠️ AND IT REALLY WENT THROUGH THE SUPERVISOR, which is what distinguishes
  // this from a seeded row. The memoized steps the collapse kept are the
  // evidence: a run that short-circuited would have written none of them.
  const queued = await adminDb.jobQueueRun.findFirstOrThrow({
    where: { jobId: REFRESH_JOB },
  });
  expect(queued.state).toBe('succeeded');
  const steps = await adminDb.jobStep.findMany({ where: { runId: queued.id } });
  const ids = steps.map((s) => s.stepId).filter((id) => !id.startsWith('job-run:'));
  expect(ids).toContain('resolve-target');
  expect(ids.some((id) => id.startsWith('index-admit:'))).toBe(true);
  expect(ids.some((id) => id.startsWith('index-boot:'))).toBe(true);
  expect(ids.some((id) => id.startsWith('index-settle:'))).toBe(true);
  // And no poll or wait checkpoint — the collapse, observed from the outside
  // (MOTIR-3484). A run that polled N times wrote none of them.
  expect(ids.filter((id) => id.startsWith('index-poll:') || id.startsWith('index-wait:'))).toEqual(
    [],
  );

  // The admission slot was taken and given back: the container is provably gone,
  // so the capacity is provably free.
  expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
});
