// E2E: the STORY's verification recipe, automated
// (Story MOTIR-3417 · Subtask MOTIR-3487 — closes the Story).
//
// @smoke — a push burst coalesces into ONE refresh that boots a container, polls
// it and settles it ON THE POSTGRES ENGINE, and a worker restart mid-index
// resumes rather than orphaning.
//
// ⚠️ WHAT MADE THIS WRITABLE. It was blocked: the index writer crosses two
// boundaries — motir-ai's run-credential mint and GitHub's tarball redirect —
// and neither had a seam in this lane. MOTIR-3564 built one
// (`lib/test-code-graph-mock.ts`, installed by the WORKER, because the supervisor
// is a job). `tests/e2e/code-graph-writer-seam.spec.ts` is that card's own smoke;
// this file is the story's assertions on top of it.
//
// ⚠️ AND WHAT THE CARD ASKED FOR THAT CANNOT BE WRITTEN AS WRITTEN. Its second
// assertion is *"That run's payload is the LAST delivery's, asserted on a field
// that differs between the pushes."* There is no such field:
// `enqueueCodeGraphRefresh` builds `CodeGraphRefreshData` from the STORED repo —
// `{installationId, workspaceId, repoOwner, repoName, defaultBranch}` — so two
// pushes to one repo produce byte-identical event data. The property is real and
// is asserted in its honest form: the coalesce REPOINTS `job_queue.event_id` at
// the newest `job_event` row, so the executed run carries the LAST delivery's
// event. (And "it indexes the last push's head" holds by construction rather than
// by assertion: the container fetches the default branch's CURRENT head at run
// time, which is why the refresh job pins no SHA.)
//
// ⚠️ NOTHING HERE REACHES THE NETWORK. The container is the `fake` orchestrator
// selected by the shipped `MOTIR_FLEET_ORCHESTRATOR` seam; both HTTP boundaries
// are undici intercepts; the archive host carries a trap that fails loudly if
// anything fetches bytes in-process. No new webServer entry and no new service.

import { expect, test, type APIRequestContext } from '@playwright/test';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { truncateJobRuns } from '@/tests/helpers/db';
import { signUp, createFirstProject } from './_helpers/shell-session';
import { clearJobRouting, routeJobsToEngine } from './_helpers/job-routing';
import { postSignedWebhook } from './_helpers/github-seed';
import { killJobWorker, startJobWorker } from './_helpers/job-worker-process';
import {
  E2E_INDEX_INSTALLATION_ID,
  E2E_INDEX_REPOS,
  indexRepoRef,
  seedConnectedRepos,
} from './_helpers/migrate-index-seed';

const REFRESH_JOB = 'system.code-graph-refresh';
const [STOREFRONT, BILLING_API] = E2E_INDEX_REPOS;

// ⚠️ THE BUDGET IS THE DECLARED DEBOUNCE, NOT SLOWNESS. `codeGraphRefresh`
// declares `period: '2m'`, and the engine honours it by setting `run_at` two
// minutes after the LAST same-key arrival — so a burst is due two minutes after
// its last push, by contract. The restart case adds the lease: a SIGKILLed worker
// holds its claim until `LEASE_MS` (60 s) expires, which is what makes the run
// reclaimable. Shortening either would mean changing the job's declaration or the
// worker's lease, which is exactly what this spec must not do.
test.describe.configure({ timeout: 600_000, mode: 'serial' });

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
  // Unconditional: a spec that leaves the routing set hands the next one a server
  // running this job on a lane it was not written against — and `jobs-flow.spec.ts`
  // asserts the opposite lane against this same server.
  await clearJobRouting();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

// ── helpers ────────────────────────────────────────────────────────────────

type SeedRepo = (typeof E2E_INDEX_REPOS)[number];

function pushPayload(repo: SeedRepo, head: string) {
  return {
    ref: `refs/heads/${repo.defaultBranch}`,
    after: head,
    installation: { id: Number(E2E_INDEX_INSTALLATION_ID) },
    repository: {
      // The STORED provider id — `handlePush` resolves the repo by
      // `(installation, providerRepoId)` and answers 2xx `unknown_repo` for a
      // mismatch, which is why every delivery below asserts the OUTCOME.
      id: Number(repo.providerRepoId),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      default_branch: repo.defaultBranch,
      owner: { login: repo.owner },
    },
  };
}

/** Deliver one push and assert it actually enqueued, rather than merely 2xx'd. */
async function push(request: APIRequestContext, repo: SeedRepo, head: string): Promise<void> {
  const res = await postSignedWebhook(request, 'push', pushPayload(repo, head));
  expect(res.status()).toBeLessThan(300);
  // ⚠️ THE OUTCOME, NOT THE STATUS. The ack never hinges on the queue, so
  // `unknown_installation` / `unknown_repo` / `ignored_ref` are all 2xx. A status
  // assertion alone would pass on a burst that enqueued nothing and leave the
  // failure to surface minutes later as a missing row.
  expect(await res.json()).toMatchObject({ result: { outcome: 'refresh_enqueued' } });
}

/** Sign up, make a project, and connect `repos` — the state a refresh needs. */
async function seedWorkspace(page: Parameters<typeof signUp>[0], repos: SeedRepo[]) {
  const email = `refresh-engine-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  await signUp(page, email);
  await createFirstProject(page, 'Refresh Engine');
  const local = email.split('@')[0]!;
  const ws = await adminDb.workspace.findFirstOrThrow({ where: { name: `${local}'s Workspace` } });
  await seedConnectedRepos(ws.id, repos);
  return ws;
}

const queuedRows = () => adminDb.jobQueueRun.findMany({ where: { jobId: REFRESH_JOB } });
const ledgerRows = () => adminDb.jobRun.findMany({ where: { functionId: REFRESH_JOB } });

// ─────────────────────────────────────────────────────────────────────────────

test('a same-repo BURST coalesces into ONE run carrying the LAST delivery @smoke', async ({
  page,
  request,
}) => {
  await seedWorkspace(page, [STOREFRONT!]);

  for (const head of ['sha-1', 'sha-2', 'sha-3', 'sha-4']) {
    await push(request, STOREFRONT!, head);
  }

  // ⚠️ THE COUNT IS THE ASSERTION, not the existence of a first run. A shape that
  // enqueued four and ran four would satisfy "a refresh happened".
  const rows = await queuedRows();
  expect(rows, 'four pushes, one pending run').toHaveLength(1);

  // Four events were written; the coalesced row points at the LAST of them.
  const events = await adminDb.jobEvent.findMany({
    where: { name: REFRESH_JOB },
    orderBy: { receivedAt: 'asc' },
  });
  expect(events).toHaveLength(4);
  expect(rows[0]!.eventId, 'the run carries the LAST delivery').toBe(events.at(-1)!.id);
  expect(rows[0]!.debounceKey).toBe(
    `${E2E_INDEX_INSTALLATION_ID}/${STOREFRONT!.owner}/${STOREFRONT!.name}`,
  );

  // …and it runs, on the engine, to the ledger contract.
  await expect
    .poll(async () => (await ledgerRows())[0]?.status ?? 'none', {
      message: 'the coalesced refresh should settle on the engine',
      timeout: 300_000,
      intervals: [1_000],
    })
    .toBe('succeeded');

  const runs = await ledgerRows();
  expect(runs, 'ONE job_run per repo').toHaveLength(1);
  expect(runs[0]!.output).toMatchObject({
    indexed: true,
    repoRef: indexRepoRef(STOREFRONT!),
    projectsIndexed: 1,
  });

  // The collapse, observed from outside the process (MOTIR-3484): the memoized
  // side effects, and not one poll or wait checkpoint.
  const steps = await adminDb.jobStep.findMany({ where: { runId: rows[0]!.id } });
  const ids = steps.map((s) => s.stepId).filter((id) => !id.startsWith('job-run:'));
  expect(ids.some((id) => id.startsWith('index-boot:'))).toBe(true);
  expect(ids.some((id) => id.startsWith('index-settle:'))).toBe(true);
  expect(ids.filter((id) => id.startsWith('index-poll:') || id.startsWith('index-wait:'))).toEqual(
    [],
  );

  // The slot was taken and given back: the container is provably gone.
  expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
});

test('a burst across TWO repos produces TWO runs — the key does not merge tenants @smoke', async ({
  page,
  request,
}) => {
  await seedWorkspace(page, [STOREFRONT!, BILLING_API!]);

  // Interleaved on purpose: a resolver that dropped a term would coalesce these
  // into one bucket, which is exactly the Inngest failure mode MOTIR-2994
  // measured and the engine refuses at registration.
  await push(request, STOREFRONT!, 'sf-1');
  await push(request, BILLING_API!, 'ba-1');
  await push(request, STOREFRONT!, 'sf-2');
  await push(request, BILLING_API!, 'ba-2');

  const rows = await queuedRows();
  expect(rows, 'two repos, two pending runs').toHaveLength(2);
  expect(rows.map((r) => r.debounceKey).sort()).toEqual(
    [
      `${E2E_INDEX_INSTALLATION_ID}/${BILLING_API!.owner}/${BILLING_API!.name}`,
      `${E2E_INDEX_INSTALLATION_ID}/${STOREFRONT!.owner}/${STOREFRONT!.name}`,
    ].sort(),
  );

  await expect
    .poll(async () => (await ledgerRows()).filter((r) => r.status === 'succeeded').length, {
      message: 'both repos should settle',
      timeout: 300_000,
      intervals: [1_000],
    })
    .toBe(2);

  // ONE `output.repoRef` each — the per-repo ledger contract §6 forces, which a
  // dispatch that BATCHED would fail.
  const refs = (await ledgerRows())
    .map((r) => (r.output as { repoRef?: string } | null)?.repoRef)
    .sort();
  expect(refs).toEqual([indexRepoRef(BILLING_API!), indexRepoRef(STOREFRONT!)].sort());
});

test('the coalesced run is RENDERED on the operator dashboard @smoke', async ({
  page,
  request,
}) => {
  await seedWorkspace(page, [STOREFRONT!]);
  await push(request, STOREFRONT!, 'dash-1');

  await expect
    .poll(async () => (await ledgerRows())[0]?.status ?? 'none', {
      message: 'the refresh should settle before the dashboard is read',
      timeout: 300_000,
      intervals: [1_000],
    })
    .toBe('succeeded');

  // The only user-visible thing this story could have broken: the ledger DTOs the
  // jobs surface reads. Unchanged by the collapse, and this is what says so.
  await page.goto('/settings/workspace/jobs');
  await expect(page.getByRole('heading', { name: 'Job runs', exact: true })).toBeVisible();
  const row = page.getByText(REFRESH_JOB, { exact: false }).first();
  await expect(row).toBeVisible();
});

test('a worker KILLED mid-index resumes on the SAME container — one boot, no orphan @smoke', async ({
  page,
  request,
}) => {
  await seedWorkspace(page, [STOREFRONT!]);
  await push(request, STOREFRONT!, 'restart-1');

  const [queued] = await queuedRows();
  expect(queued).toBeDefined();

  // ⚠️ WAIT FOR THE BOOT STEP, NOT FOR A TIMER. `index-boot:<pid>` appearing in
  // `job_step` is the authoritative signal that a container exists and the
  // supervisor is watching it — which is precisely "mid-index". Killing on a
  // sleep would race the boot and sometimes test nothing.
  await expect
    .poll(
      async () =>
        (await adminDb.jobStep.findMany({ where: { runId: queued!.id } })).some((s) =>
          s.stepId.startsWith('index-boot:'),
        ),
      { message: 'the supervisor should boot a container', timeout: 300_000, intervals: [500] },
    )
    .toBe(true);

  // THE KILL — SIGKILL, not the graceful drain. A drain would let the supervisor
  // FINISH, which would prove the opposite of the story's criterion.
  await killJobWorker();
  await startJobWorker();

  // The resumed run completes. The lease has to expire before the row is
  // reclaimable (`LEASE_MS`, 60 s), so this is the longest wait in the file.
  await expect
    .poll(async () => (await ledgerRows())[0]?.status ?? 'none', {
      message: 'the resumed supervisor should settle the SAME container',
      timeout: 300_000,
      intervals: [1_000],
    })
    .toBe('succeeded');

  // ⚠️ THE ASSERTION THE CARD TURNS ON: ONE BOOT. "It finished" is true of the
  // double-boot case too — and a second boot is a second billed container and a
  // second admission slot. The boot sits inside a memoized step, so the resumed
  // pass replayed it instead of provisioning again.
  const steps = await adminDb.jobStep.findMany({ where: { runId: queued!.id } });
  const boots = steps.filter((s) => s.stepId.startsWith('index-boot:'));
  expect(boots, 'exactly one boot across both passes').toHaveLength(1);

  const runs = await ledgerRows();
  expect(runs, 'one job_run, not one per pass').toHaveLength(1);
  expect(runs[0]!.output).toMatchObject({ indexed: true, repoRef: indexRepoRef(STOREFRONT!) });

  // NO ORPHAN: the slot is back, so the container was torn down rather than left
  // running with nothing watching it — the failure this whole story is about.
  expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
});
