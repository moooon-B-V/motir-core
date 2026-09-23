import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-5865 — A CI DELIVERY DIED ON PRISMA'S 5 s BUDGET WHILE DOING NO WORK.
//
// Observed in production 100 times between 2026-08-30 and 2026-09-20 as a
// `P2028` — *the timeout for this transaction was 5000 ms, however 19058 ms
// passed* — at `changeRequestCiFeedback.ts:165` on release `38310cc7`, which is
// the PHASE-1 RESOLVE: one read-only transaction of nine single-row indexed
// reads, no network call, no row lock. Nothing in it can take 19 s by working;
// it can only take 19 s by WAITING — for a lock another session holds on a
// table it reads (a deploy migration's `ALTER TABLE` takes ACCESS EXCLUSIVE,
// and every reader queues behind it), or for a starved process. The monitor
// evidence was cascade-deleted with its binding on 2026-09-22 (MOTIR-5976's
// comment), so which wait it was cannot be read back; the fixture below forces
// the lock shape because it is the one a test can drive deterministically.
//
// Why it matters more than one 500: GitHub does not redeliver a failed webhook
// and nothing enqueues this path, so the delivery's conclusion is never
// recorded — and every downstream derivation is a fold over the RECORDED rows,
// so a dropped `failure` reads as green (MOTIR-4264's header states the same
// consequence one phase later).
//
// The fixture is signal-driven, not a sleep race: the lock is released only
// once Postgres itself reports the delivery's backend WAITING on it, and then
// held past the 5 s default so the pre-fix transaction has expired by the time
// it can proceed.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-ci-tx-budget';
const REPO_PROVIDER_ID = '5865';
const BRANCH = 'subtask/MOTIR-5865-budget';
/** Past Prisma's 5000 ms default, and inside the budget the fix declares. */
const HOLD_AFTER_WAIT_MS = 5_500;

async function makeScenario() {
  const user = await usersService.createUser({
    email: 'budget@example.com',
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: REPO_PROVIDER_ID,
        owner: 'moooon',
        name: 'motir-core',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });

  const card = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'the card the pull request delivers' },
    ctx,
  );
  await workItemsService.updateStatus(card.id, 'in_progress', ctx);

  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: 5865,
      state: 'open',
      merged: false,
      title: 'A pull request that names nothing',
      head: { ref: BRANCH },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
  await githubPullRequestService.linkPullRequestByCoordinates(
    {
      workItemId: card.id,
      projectId: project.id,
      owner: 'moooon',
      name: 'motir-core',
      number: 5865,
      headRef: BRANCH,
      baseRef: 'main',
      title: null,
    },
    ctx,
  );
  return { card };
}

const failedCheck = () =>
  githubWebhookService.handleEvent('check_run', {
    action: 'completed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_run: {
      head_sha: 'sha-budget',
      status: 'completed',
      conclusion: 'failure',
      name: 'vitest',
      check_suite: { head_branch: null },
      pull_requests: [{ number: 5865 }],
    },
  });

/** The query text of the first backend in THIS test database that is blocked on
 *  a lock — a signal read from the server, never a guess about timing. */
async function waitForABackendBlockedOnALock(): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = await adminDb.$queryRaw<{ query: string }[]>`
      SELECT query FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (rows[0]) return rows[0].query;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the delivery never blocked on the lock — the wait was not forced');
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a CI delivery that WAITS in its read-only resolve is not killed by the 5 s default (MOTIR-5865)', () => {
  it('records the conclusion and answers when a lock on `work_item` holds the resolve past 5 s', async () => {
    const { card } = await makeScenario();

    // Another session takes the lock a migration's `ALTER TABLE work_item`
    // takes. The delivery's resolve reaches `work_item` (the session-branch arm
    // of the delivery set) and queues behind it.
    let releaseLock!: () => void;
    const lockReleased = new Promise<void>((resolve) => (releaseLock = resolve));
    let lockHeld!: () => void;
    const lockTaken = new Promise<void>((resolve) => (lockHeld = resolve));
    const holder = adminDb.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE work_item IN ACCESS EXCLUSIVE MODE');
        lockHeld();
        await lockReleased;
      },
      { timeout: 60_000 },
    );
    await lockTaken;

    const delivery = failedCheck();
    // Observe the settlement now, so a rejection is never unhandled while the
    // lock is still being held.
    const settled = delivery.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    const blockedQuery = await waitForABackendBlockedOnALock();
    // It is the resolve that is waiting — the read-only phase the production
    // frame named — not a write further on.
    expect(blockedQuery).toContain('work_item');
    expect(blockedQuery).toMatch(/^SELECT/i);

    await new Promise((resolve) => setTimeout(resolve, HOLD_AFTER_WAIT_MS));
    releaseLock();
    await holder;

    const result = await settled;
    // THE DEFECT: before the fix this is `{ ok: false }` carrying P2028 —
    // "A commit cannot be executed on an expired transaction".
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({ event: 'ci', outcome: 'failed', ciState: 'failing' });

    // The red vote is RECORDED — the row a pre-fix delivery never wrote.
    const rows = await adminDb.githubCheckRun.findMany({ where: { commitSha: 'sha-budget' } });
    expect(rows.map((r) => [r.checkName, r.conclusion])).toEqual([['vitest', 'failure']]);
    const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(item.ciState).toBe('failing');
  }, 60_000);
});
