import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-4264 — THE CI-FEEDBACK TRANSACTION HELD THE CHANGE REQUEST'S ROW LOCK
// ACROSS N COMMENT WRITES ON OTHER CONNECTIONS.
//
// Observed in production as a `P2028` — *the timeout for this transaction was
// 5000 ms, however 5379 ms passed* — thrown by the check-row upsert, which is the
// FIRST write after `lockById` and two indexed reads. Nothing there is slow; the
// 5.4 s was spent WAITING for the lock, behind deliveries that were mid-comment.
// A motir-core pull request carries ~34 checks that finish in bursts, so the k-th
// delivery queued behind k−1 holders, the webhook 500'd, and — because GitHub does
// not retry a failed delivery and nothing enqueues this path — that check's row was
// never written at all. A dropped `failure` does not read as "we do not know": the
// next success folds over the rows that ARE recorded and writes *this work is
// verified* over a red build.
//
// ── What these fixtures assert, and why in this shape ────────────────────────
// The defect is CONTENTION, and a timing assertion about contention is a flake
// generator on a box that shares one Postgres across parallel sessions. So neither
// of the first two tests measures duration:
//
//  1. CONCURRENCY is asserted on the OUTCOME — N deliveries land together, N rows
//     are recorded, and exactly ONE comment survives per card. Before this card the
//     same fixture serialized every delivery behind the comment writes.
//  2. THE LOCK is asserted STRUCTURALLY — from inside the comment write, a second
//     connection takes `FOR UPDATE NOWAIT` on the very row the fold locks. It
//     succeeds only if the fold has already committed. Under the old shape this
//     raised `55P03 lock_not_available`, which is the defect stated as one line of
//     SQL rather than as a stopwatch.
//  3. DURABILITY is asserted by breaking the comment write outright: the row must
//     still be recorded, the delivery must not throw, and the next delivery at that
//     commit must still see the red vote.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-ci-lock-hold';
const REPO_PROVIDER_ID = '9414';

async function makeScenario(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
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
  return { user, workspace, project, ctx };
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function openPr(number: number, headRef: string) {
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: 'A pull request that names nothing',
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

async function makeCard(s: Scenario, title: string) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  return item;
}

async function link(s: Scenario, workItemId: string, opts: { number: number; headRef: string }) {
  return githubPullRequestService.linkPullRequestByCoordinates(
    {
      workItemId,
      projectId: s.project.id,
      owner: 'moooon',
      name: 'motir-core',
      number: opts.number,
      headRef: opts.headRef,
      baseRef: 'main',
      title: null,
    },
    s.ctx,
  );
}

const ci = (opts: {
  conclusion: string | null;
  headSha: string;
  prNumbers: number[];
  name: string;
}) =>
  githubWebhookService.handleEvent('check_run', {
    action: 'completed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_run: {
      head_sha: opts.headSha,
      status: 'completed',
      conclusion: opts.conclusion,
      name: opts.name,
      check_suite: { head_branch: null },
      pull_requests: opts.prNumbers.map((n) => ({ number: n })),
    },
  });

async function commentsOn(workItemId: string) {
  return adminDb.comment.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('concurrent deliveries at one head commit (MOTIR-4264 AC 1)', () => {
  const BRANCH = 'subtask/MOTIR-4264-lock-hold';

  it('records EVERY row and leaves exactly one comment when six checks finish together', async () => {
    const s = await makeScenario('burst@example.com');
    const card = await makeCard(s, 'the card the pull request delivers');
    await openPr(940, BRANCH);
    await link(s, card.id, { number: 940, headRef: BRANCH });

    const names = ['lint', 'typecheck', 'prettier', 'build', 'vitest', 'e2e'];
    const results = await Promise.all(
      names.map((name) =>
        ci({ conclusion: 'success', headSha: 'sha-burst', prNumbers: [940], name }),
      ),
    );

    // NOT ONE OF THEM MAY FAIL. The failure this card is about is a delivery that
    // threw `P2028` on its way to writing its row.
    for (const res of results) expect(res).toMatchObject({ event: 'ci', outcome: 'verified' });

    // Every vote recorded — the counterfactual is a MISSING row, not a ratio.
    const rows = await adminDb.githubCheckRun.findMany({ where: { commitSha: 'sha-burst' } });
    expect(rows.map((r) => r.checkName).sort()).toEqual([...names].sort());

    // MOTIR-2946 / MOTIR-3770 hold under the new shape: one comment per
    // (change request, head commit, card), whatever order the six landed in.
    const comments = await commentsOn(card.id);
    expect(comments).toHaveLength(1);
    expect(await adminDb.githubCiFeedbackComment.count({ where: { commitSha: 'sha-burst' } })).toBe(
      1,
    );

    // And it agrees with the whole set — the convergence pass is what keeps this
    // true when a delivery that folded EARLIER writes LATER.
    expect(comments[0]!.bodyMd).toBe(
      '✅ **CI passing** — all 6 checks succeeded on the linked pull request. This work is verified.',
    );
  });
});

describe('the change-request lock is NOT held across the comment write (MOTIR-4264 AC 2)', () => {
  const BRANCH = 'subtask/MOTIR-4264-no-foreign-work';

  it('lets a second connection take FOR UPDATE NOWAIT on the row while the comment is being written', async () => {
    const s = await makeScenario('unlocked@example.com');
    const card = await makeCard(s, 'a card');
    await openPr(941, BRANCH);
    await link(s, card.id, { number: 941, headRef: BRANCH });
    const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 941 } });

    // The probe runs from INSIDE the comment write, on a different connection.
    // `NOWAIT` turns "somebody holds this row" into an immediate error instead of
    // a wait, so this is a structural question with an immediate answer rather
    // than a measurement of how long anything took.
    const probes: ('acquired' | 'locked')[] = [];
    const probeTheRow = async () => {
      try {
        await adminDb.$queryRawUnsafe(
          'SELECT id FROM github_pull_request WHERE id = $1 FOR UPDATE NOWAIT',
          pr.id,
        );
        probes.push('acquired');
      } catch {
        probes.push('locked');
      }
    };

    const realAdd = commentsService.addComment.bind(commentsService);
    vi.spyOn(commentsService, 'addComment').mockImplementation(async (...args) => {
      await probeTheRow();
      return realAdd(...args);
    });

    const res = await ci({
      conclusion: 'success',
      headSha: 'sha-probe',
      prNumbers: [941],
      name: 'build',
    });
    expect(res).toMatchObject({ outcome: 'verified' });

    // One probe, and it got the row. Before this card the fold still held it here
    // and this read raised `55P03 lock_not_available`.
    expect(probes).toEqual(['acquired']);
  });
});

describe('a conclusion is never lost when the comment write fails (MOTIR-4264 AC 3)', () => {
  const BRANCH = 'subtask/MOTIR-4264-durable-row';

  it('records the FAILURE row, does not throw, and the next delivery still reads the red vote', async () => {
    const s = await makeScenario('durable@example.com');
    const card = await makeCard(s, 'a card');
    await openPr(942, BRANCH);
    await link(s, card.id, { number: 942, headRef: BRANCH });

    // The render breaks in the way production broke it: after the row is durable
    // and before anything has been said about it.
    const broken = vi
      .spyOn(commentsService, 'addComment')
      .mockRejectedValue(new Error('comment write failed'));

    const red = await ci({
      conclusion: 'failure',
      headSha: 'sha-lost',
      prNumbers: [942],
      name: 'vitest',
    });
    // The delivery still answers, and it answers about the recorded set — the
    // webhook must not 500 on a host that never retries.
    expect(red).toMatchObject({ event: 'ci', outcome: 'failed', ciState: 'failing' });
    expect(broken).toHaveBeenCalled();

    const stored = await adminDb.githubCheckRun.findMany({ where: { commitSha: 'sha-lost' } });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.conclusion).toBe('failure');
    expect(await commentsOn(card.id)).toHaveLength(0);

    // The red vote survives its own delivery's failure. A later green check at the
    // same commit folds over BOTH rows, so the comment says failed and the card's
    // signal stays failing — where a dropped row would have read as all-green.
    broken.mockRestore();
    const green = await ci({
      conclusion: 'success',
      headSha: 'sha-lost',
      prNumbers: [942],
      name: 'lint',
    });
    expect(green).toMatchObject({ outcome: 'verified', ciState: 'failing' });

    const comments = await commentsOn(card.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyMd).toContain('CI failed');
    expect(comments[0]!.bodyMd).toContain('`vitest`');
    const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(item.ciState).toBe('failing');
  });
});
