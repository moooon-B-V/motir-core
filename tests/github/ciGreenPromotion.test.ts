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
import { promoteDeliveredCardsOnGreen, promoteIfCiAlreadyGreen } from '@/lib/services/ciPromotion';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// MOTIR-3006 — CI GREEN IS WHAT MAKES A CARD REVIEWABLE.
//
// `implemented` says the code is pushed; In Review says a human should look. The
// only thing entitled to move a card between them is the build. Two things this
// suite exists to pin, and both were defects the card names explicitly:
//
//  1. The promotion is PER PULL REQUEST, not per linked card. A session pull
//     request carries N cards and its link column names NONE of them, so a green
//     run must promote all N. Asserted with N > 1 — N = 1 passes even with the
//     1:1 defect.
//  2. The promotion is a LATCH, not an edge. The run pushes BEFORE it transitions
//     (MOTIR-3004), so the green verdict can land while the card is still In
//     Progress. A card ARRIVING at `implemented` therefore re-reads the recorded
//     verdict, and promotes itself if it is already green.
//
// Real Postgres, the real webhook service, the real provider seam — no mocks.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-ci-promote';
const REPO_PROVIDER_ID = '881';

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
        name: 'acme',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx };
}

/** Open a pull request whose head ref is `headBranch`. When it names a card's
 *  identifier the sync links it (and moves the card to `implemented`); when it
 *  does not — a session branch — the row is stored linked to nothing, which is
 *  exactly the shape `motir auto` produces. */
async function openPr(headBranch: string, number: number) {
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `A change (${headBranch})`,
      head: { ref: headBranch },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

function checkSuitePayload(opts: {
  conclusion: string | null;
  headSha: string;
  status?: string;
  prNumbers?: number[];
  headBranch?: string | null;
}) {
  return {
    action: 'completed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: opts.headSha,
      head_branch: opts.headBranch ?? null,
      status: opts.status ?? 'completed',
      conclusion: opts.conclusion,
      app: { slug: 'github-actions' },
      pull_requests: (opts.prNumbers ?? []).map((n) => ({ number: n })),
    },
  };
}

const ci = (opts: Parameters<typeof checkSuitePayload>[0]) =>
  githubWebhookService.handleEvent('check_suite', checkSuitePayload(opts));

async function statusOf(workItemId: string): Promise<string> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}

async function revisionCount(workItemId: string): Promise<number> {
  return adminDb.workItemRevision.count({ where: { workItemId } });
}

/** A card at `implemented` with its own pull request — the ordinary shape. */
async function cardWithPr(
  s: Awaited<ReturnType<typeof makeScenario>>,
  title: string,
  number: number,
) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  // MOTIR-3674 — the link is the only association a pull request has; the key in
  // the branch is a label. A run writes it the moment `gh pr create` returns,
  // which is before the `opened` delivery lands.
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'acme',
    number,
    headRef: `subtask/${item.identifier}-work`,
    title: `A change (subtask/${item.identifier}-work)`,
  });
  await openPr(`subtask/${item.identifier}-work`, number);
  expect(await statusOf(item.id)).toBe('implemented');
  return item;
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** MOTIR-3674 — the link for a case that opens its pull request directly rather
 *  than through `cardWithPr`. */
async function linkOne(identifier: string, number: number) {
  await linkPrByIdentifier({
    identifier,
    owner: 'moooon',
    name: 'acme',
    number,
    headRef: `subtask/${identifier}-work`,
    title: `A change (subtask/${identifier}-work)`,
  });
}

describe('a terminal GREEN promotes the cards a pull request delivers', () => {
  it('moves a single-card pull request from implemented to in_review', async () => {
    const s = await makeScenario('ci-single@example.com');
    const item = await cardWithPr(s, 'A change', 11);

    const res = await ci({ conclusion: 'success', headSha: 'sha1', prNumbers: [11] });

    expect(res).toMatchObject({ outcome: 'verified', ciState: 'passing' });
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('promotes ALL the cards on a SESSION branch from ONE green run (N > 1)', async () => {
    // The defect this asserts: a session pull request's link column names none of
    // its cards, so a promotion that resolves "the linked work item" moves one of
    // N and leaves the rest at Implemented forever. N = 3 here because N = 1
    // passes even with the defect.
    const s = await makeScenario('ci-session@example.com');
    const branch = 'motir/auto-20260819-020000';
    const items = [];
    for (const title of ['One', 'Two', 'Three']) {
      const item = await workItemsService.createWorkItem(
        { projectId: s.project.id, kind: 'task', title },
        s.ctx,
      );
      await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
      await workItemsService.markIntegrated(item.id, branch, s.ctx);
      expect(await statusOf(item.id)).toBe('implemented');
      items.push(item);
    }
    await openPr(branch, 12);

    const res = await ci({ conclusion: 'success', headSha: 'sha-a', prNumbers: [12] });

    expect(res).toMatchObject({ outcome: 'no_work_item' });
    for (const item of items) expect(await statusOf(item.id)).toBe('in_review');
  });

  it('leaves a sibling that is NOT at implemented exactly where it is', async () => {
    // A human who moved one card back to In Progress to rework it must not have it
    // yanked forward by a green run — while its siblings still promote.
    const s = await makeScenario('ci-sibling@example.com');
    const branch = 'motir/auto-20260819-030000';
    const promoted = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Promoted' },
      s.ctx,
    );
    const reworking = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Being reworked' },
      s.ctx,
    );
    for (const item of [promoted, reworking]) {
      await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
      await workItemsService.markIntegrated(item.id, branch, s.ctx);
    }
    await workItemsService.updateStatus(reworking.id, 'in_progress', s.ctx);
    await openPr(branch, 13);

    await ci({ conclusion: 'success', headSha: 'sha-b', prNumbers: [13] });

    expect(await statusOf(promoted.id)).toBe('in_review');
    expect(await statusOf(reworking.id)).toBe('in_progress');
  });
});

describe('everything that is not a terminal green promotes nothing', () => {
  it('a terminal FAILURE writes ciState failing and moves no card', async () => {
    const s = await makeScenario('ci-fail@example.com');
    const item = await cardWithPr(s, 'A change', 14);

    const res = await ci({ conclusion: 'failure', headSha: 'sha1', prNumbers: [14] });

    expect(res).toMatchObject({ outcome: 'failed', ciState: 'failing' });
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('a PARTIAL aggregate — a check still pending — promotes nothing', async () => {
    const s = await makeScenario('ci-partial@example.com');
    const item = await cardWithPr(s, 'A change', 15);

    // One check still running, one green, at the same sha: the aggregate is not
    // terminal, so the card stays put whatever the terminal one says.
    await githubWebhookService.handleEvent('check_run', {
      action: 'completed',
      installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
      repository: { id: Number(REPO_PROVIDER_ID) },
      check_run: {
        head_sha: 'sha1',
        status: 'in_progress',
        conclusion: null,
        name: 'e2e',
        check_suite: { head_branch: null },
        pull_requests: [{ number: 15 }],
      },
    } as Record<string, unknown>);
    await githubWebhookService.handleEvent('check_run', {
      action: 'completed',
      installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
      repository: { id: Number(REPO_PROVIDER_ID) },
      check_run: {
        head_sha: 'sha1',
        status: 'completed',
        conclusion: 'success',
        name: 'build',
        check_suite: { head_branch: null },
        pull_requests: [{ number: 15 }],
      },
    });

    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('a green run for a SUPERSEDED sha, after a newer push, promotes nothing', async () => {
    const s = await makeScenario('ci-superseded@example.com');
    const item = await cardWithPr(s, 'A change', 16);

    // The order is the realistic one, and it is what makes the assertion mean
    // something: the OLD sha's checks are sighted first (still running), THEN a
    // newer push records its own, and only then does the old sha's verdict land.
    // `derivePrCiState` orders shas by FIRST sighting, so the late green belongs
    // to a commit the branch has already moved past.
    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-old', prNumbers: [16] });
    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-new', prNumbers: [16] });
    await ci({ conclusion: 'success', headSha: 'sha-old', prNumbers: [16] });

    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('never promotes from in_progress — the window is not closed by widening the source', async () => {
    // The reflex this rules out: a card whose agent died before it finished is
    // still `in_progress`, and a green run must not carry it into In Review.
    const s = await makeScenario('ci-source@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Never finished' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await linkOne(item.identifier, 17);
    await openPr(`subtask/${item.identifier}-work`, 17);
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    expect(await statusOf(item.id)).toBe('in_progress');

    await ci({ conclusion: 'success', headSha: 'sha1', prNumbers: [17] });

    expect(await statusOf(item.id)).toBe('in_progress');
  });
});

describe('the LATCH — a card that arrives at implemented AFTER the green', () => {
  it('promotes itself the moment it arrives, with no further delivery', async () => {
    // The window MOTIR-3004's push-first ordering opens: the agent pushes, CI
    // reports green, and only then does the card reach `implemented`. Edge 1
    // found nothing; edge 2 is what saves it.
    const s = await makeScenario('latch@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Green arrived first' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await linkOne(item.identifier, 18);
    await openPr(`subtask/${item.identifier}-work`, 18);
    // Put it back to in_progress: the pull-request delivery moved it to
    // implemented, and this test is about the card NOT being there when CI reports.
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);

    await ci({ conclusion: 'success', headSha: 'sha1', prNumbers: [18] });
    expect(await statusOf(item.id)).toBe('in_progress');

    // The agent's own transition, arriving late — and landing at in_review.
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('latches a SESSION card too, through mark_integrated', async () => {
    // The loop integrates its cards one at a time and CI runs on each push, so a
    // card can join a branch whose verdict is ALREADY green. The first card is
    // what makes the delivery record rows at all — a pull request that delivers
    // nothing is still the clean no-op it always was, which is why the green has
    // to be recorded while at least one card is on the branch.
    const s = await makeScenario('latch-session@example.com');
    const branch = 'motir/auto-20260819-040000';
    const first = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'First on the branch' },
      s.ctx,
    );
    await workItemsService.updateStatus(first.id, 'in_progress', s.ctx);
    await workItemsService.markIntegrated(first.id, branch, s.ctx);
    await openPr(branch, 19);
    await ci({ conclusion: 'success', headSha: 'sha-s', prNumbers: [19] });
    expect(await statusOf(first.id)).toBe('in_review');

    // A LATER card joins the same branch, after the verdict is already recorded.
    const later = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Integrated after the green' },
      s.ctx,
    );
    await workItemsService.updateStatus(later.id, 'in_progress', s.ctx);
    await workItemsService.markIntegrated(later.id, branch, s.ctx);

    expect(await statusOf(later.id)).toBe('in_review');
  });

  it('does NOT latch on a failing, a pending, or a superseded verdict', async () => {
    const s = await makeScenario('latch-guards@example.com');

    // failing
    const failing = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Red' },
      s.ctx,
    );
    await workItemsService.updateStatus(failing.id, 'in_progress', s.ctx);
    await linkOne(failing.identifier, 20);
    await openPr(`subtask/${failing.identifier}-work`, 20);
    await workItemsService.updateStatus(failing.id, 'in_progress', s.ctx);
    await ci({ conclusion: 'failure', headSha: 'sha1', prNumbers: [20] });
    await workItemsService.updateStatus(failing.id, 'implemented', s.ctx);
    expect(await statusOf(failing.id)).toBe('implemented');

    // still pending
    const pending = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Running' },
      s.ctx,
    );
    await workItemsService.updateStatus(pending.id, 'in_progress', s.ctx);
    await linkOne(pending.identifier, 21);
    await openPr(`subtask/${pending.identifier}-work`, 21);
    await workItemsService.updateStatus(pending.id, 'in_progress', s.ctx);
    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha1', prNumbers: [21] });
    await workItemsService.updateStatus(pending.id, 'implemented', s.ctx);
    expect(await statusOf(pending.id)).toBe('implemented');

    // superseded: green on an old sha, a newer push still running
    const superseded = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Stale green' },
      s.ctx,
    );
    await workItemsService.updateStatus(superseded.id, 'in_progress', s.ctx);
    await linkOne(superseded.identifier, 22);
    await openPr(`subtask/${superseded.identifier}-work`, 22);
    await workItemsService.updateStatus(superseded.id, 'in_progress', s.ctx);
    await ci({ conclusion: 'success', headSha: 'sha-old', prNumbers: [22] });
    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-new', prNumbers: [22] });
    await workItemsService.updateStatus(superseded.id, 'implemented', s.ctx);
    expect(await statusOf(superseded.id)).toBe('implemented');
  });

  it('is a clean no-op for a card with NO change request at all', async () => {
    // The ordinary case for a human moving a card to Implemented by hand.
    const s = await makeScenario('latch-none@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'No pull request' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);

    expect(await statusOf(item.id)).toBe('implemented');
  });
});

describe('idempotence — the two edges never promote twice', () => {
  it('a redelivered green performs no second transition and records no second revision', async () => {
    const s = await makeScenario('ci-idempotent@example.com');
    const item = await cardWithPr(s, 'A change', 23);

    await ci({ conclusion: 'success', headSha: 'sha1', prNumbers: [23] });
    expect(await statusOf(item.id)).toBe('in_review');
    const afterFirst = await revisionCount(item.id);

    await ci({ conclusion: 'success', headSha: 'sha1', prNumbers: [23] });

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await revisionCount(item.id)).toBe(afterFirst);
  });

  it('the two edges together produce ONE promotion, whichever fires first', async () => {
    const s = await makeScenario('ci-both-edges@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Both edges' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await linkOne(item.identifier, 24);
    await openPr(`subtask/${item.identifier}-work`, 24);
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);

    // Edge 2 first: the green is recorded, then the card arrives.
    await ci({ conclusion: 'success', headSha: 'sha1', prNumbers: [24] });
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    expect(await statusOf(item.id)).toBe('in_review');
    const afterLatch = await revisionCount(item.id);

    // Edge 1 second: another delivery of the same verdict finds it already there.
    await ci({ conclusion: 'success', headSha: 'sha1', prNumbers: [24] });

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await revisionCount(item.id)).toBe(afterLatch);
  });
});

describe('a card the promotion CANNOT move is skipped, not fatal', () => {
  it('a project with no `in_review` loses only its own card — the siblings still promote', async () => {
    // A workspace may hold a project on a CUSTOM workflow that has no
    // `in_review` at all, and a run's session branch can carry cards from both.
    // The rule is the one `completeSession` already applies to a close-out: a
    // per-card refusal is a skip, so one unpromotable card cannot strand the
    // rest of the run at Implemented.
    const s = await makeScenario('ci-refused@example.com');
    const custom = await projectsService.createProject({
      workspaceId: s.workspace.id,
      actorUserId: s.user.id,
      name: 'Custom',
      identifier: 'CUST',
    });
    // The custom workflow's review column is called something else, which is all
    // it takes: the target status does not exist for this project.
    await adminDb.workflowStatus.updateMany({
      where: { projectId: custom.id, key: 'in_review' },
      data: { key: 'code_review' },
    });

    const branch = 'motir/auto-20260819-050000';
    const ordinary = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Ordinary workflow' },
      s.ctx,
    );
    const refused = await workItemsService.createWorkItem(
      { projectId: custom.id, kind: 'task', title: 'Custom workflow' },
      s.ctx,
    );
    for (const item of [ordinary, refused]) {
      await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
      await workItemsService.markIntegrated(item.id, branch, s.ctx);
      expect(await statusOf(item.id)).toBe('implemented');
    }
    await openPr(branch, 23);
    const before = await revisionCount(refused.id);

    // The green still reports normally — a skipped card is not a failed webhook.
    await ci({ conclusion: 'success', headSha: 'sha-r', prNumbers: [23] });

    expect(await statusOf(ordinary.id)).toBe('in_review');
    expect(await statusOf(refused.id)).toBe('implemented');
    // …and it was SKIPPED, not moved somewhere else: nothing was written for it.
    expect(await revisionCount(refused.id)).toBe(before);
  });

  it('a workflow with no EDGE to in_review is skipped the same way', async () => {
    // The second tolerated refusal: the status exists, but this project's
    // workflow has no `implemented → in_review` transition. Both refusals are
    // the project's own answer about its own card, and neither is a fault of
    // the run — so both skip rather than throw.
    const s = await makeScenario('ci-noedge@example.com');
    const edgeless = await projectsService.createProject({
      workspaceId: s.workspace.id,
      actorUserId: s.user.id,
      name: 'Edgeless',
      identifier: 'EDGE',
    });
    const from = await adminDb.workflowStatus.findFirstOrThrow({
      where: { projectId: edgeless.id, key: 'implemented' },
    });
    const to = await adminDb.workflowStatus.findFirstOrThrow({
      where: { projectId: edgeless.id, key: 'in_review' },
    });
    await adminDb.workflowTransition.deleteMany({
      where: { projectId: edgeless.id, fromStatusId: from.id, toStatusId: to.id },
    });

    const branch = 'motir/auto-20260819-060000';
    const ordinary = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Ordinary workflow' },
      s.ctx,
    );
    const refused = await workItemsService.createWorkItem(
      { projectId: edgeless.id, kind: 'task', title: 'No edge to review' },
      s.ctx,
    );
    for (const item of [ordinary, refused]) {
      await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
      await workItemsService.markIntegrated(item.id, branch, s.ctx);
    }
    await openPr(branch, 24);

    await ci({ conclusion: 'success', headSha: 'sha-e', prNumbers: [24] });

    expect(await statusOf(ordinary.id)).toBe('in_review');
    expect(await statusOf(refused.id)).toBe('implemented');
  });
});

describe('a row that is GONE by the time the promotion runs', () => {
  // Both edges run AFTER their transaction has committed, so the world can have
  // moved on: the pull request row can be deleted (a repository disconnected,
  // an installation removed) and the card can be archived away. Neither may
  // throw — a promotion that raises here turns a recorded verdict into a webhook
  // GitHub retries forever, and a card's own transition into a 500.
  it('a change request that no longer exists promotes nothing, quietly', async () => {
    const s = await makeScenario('gone-pr@example.com');

    const promoted = await promoteDeliveredCardsOnGreen({
      changeRequestId: 'no-such-change-request',
      workspaceId: s.workspace.id,
      actorUserId: s.user.id,
    });

    expect(promoted).toEqual([]);
  });

  it('a work item that no longer exists latches nothing, quietly', async () => {
    const s = await makeScenario('gone-item@example.com');

    await expect(promoteIfCiAlreadyGreen('no-such-work-item', s.ctx)).resolves.toBe(false);
  });
});

// ── ALL GREEN PROMOTES (Story MOTIR-3655 · MOTIR-3685) ───────────────────────
//
// `ciPromotion` shipped promoting every card a pull request delivers the moment
// THAT pull request went green — correct while a card had one pull request, and
// wrong the first time it has two. A card delivered by a green pull request and
// a red one was announced reviewable on half its evidence.
//
// This is a CHANGE to shipped behaviour, so the unchanged case is asserted as
// carefully as the changed one: over a set of ONE, "every" and "some" agree, and
// almost every card in the tree is that case.

/** Record a SECOND pull request as delivering `workItemId`.
 *
 *  ⚠️ MOTIR-3674 — this goes through the REAL link door now. It used to insert a
 *  `work_item_delivery` row directly, which was a faithful fixture only while the
 *  title parse ALSO stamped `github_pull_request.work_item_id` from the branch.
 *  With the parse retired and that column dropped (MOTIR-3757), the delivery row
 *  IS the whole of a link — but the door stays the door: a fixture that inserts
 *  the row itself asserts a shape rather than the behaviour a caller gets, and
 *  `link_pull_request` does more than write the row (it stamps the provenance and
 *  refreshes the unlinked-pull-request check). */
async function alsoDelivers(
  s: Awaited<ReturnType<typeof makeScenario>>,
  workItemId: string,
  prNumber: number,
) {
  const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: prNumber } });
  await githubPullRequestService.linkPullRequest(workItemId, pr.id, s.ctx);
  return pr;
}

describe('a card reaches In Review only when EVERY pull request delivering it is green', () => {
  it('one green and one RED leaves it at implemented', async () => {
    const s = await makeScenario('allgreen-red@example.com');
    const card = await cardWithPr(s, 'spans two pull requests', 41);
    await openPr('subtask/ACME-1-second', 42);
    await alsoDelivers(s, card.id, 42);

    await ci({ conclusion: 'failure', headSha: 'sha-red', prNumbers: [42] });
    await ci({ conclusion: 'success', headSha: 'sha-green', prNumbers: [41] });

    // The green one WOKE the promotion; it did not decide it.
    expect(await statusOf(card.id)).toBe('implemented');
  });

  it('one green and one still RUNNING leaves it at implemented', async () => {
    // `running` is not a failure and not a pass — the loop is waiting for a
    // verdict, not receiving one — so it withholds exactly as a red does.
    const s = await makeScenario('allgreen-running@example.com');
    const card = await cardWithPr(s, 'one still building', 43);
    await openPr('subtask/ACME-1-second', 44);
    await alsoDelivers(s, card.id, 44);

    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-pending', prNumbers: [44] });
    await ci({ conclusion: 'success', headSha: 'sha-green', prNumbers: [43] });

    expect(await statusOf(card.id)).toBe('implemented');
  });

  it('BOTH green promotes it', async () => {
    const s = await makeScenario('allgreen-both@example.com');
    const card = await cardWithPr(s, 'both landed', 45);
    await openPr('subtask/ACME-1-second', 46);
    await alsoDelivers(s, card.id, 46);

    await ci({ conclusion: 'success', headSha: 'sha-a', prNumbers: [45] });
    await ci({ conclusion: 'success', headSha: 'sha-b', prNumbers: [46] });

    expect(await statusOf(card.id)).toBe('in_review');
  });

  it('the LATCH still works — the SECOND pull request going green later promotes it', async () => {
    // The property the latch exists for, now over a set: the first green arrives
    // and correctly does nothing, and the card is promoted by the last one
    // rather than being stranded at implemented for ever.
    const s = await makeScenario('allgreen-latch@example.com');
    const card = await cardWithPr(s, 'the second one lands later', 47);
    await openPr('subtask/ACME-1-second', 48);
    await alsoDelivers(s, card.id, 48);

    await ci({ conclusion: 'success', headSha: 'sha-first', prNumbers: [47] });
    expect(await statusOf(card.id)).toBe('implemented');

    await ci({ conclusion: 'success', headSha: 'sha-second', prNumbers: [48] });
    expect(await statusOf(card.id)).toBe('in_review');
  });

  it('a RED that goes green on a re-push promotes it — the fixing loop’s own case', async () => {
    // MOTIR-3685's watch-and-fix loop pushes a fix, and the newer sha's green
    // must outrank the older sha's red. That is `derivePrCiState`'s latest-sha
    // rule, reached through the set.
    const s = await makeScenario('allgreen-refix@example.com');
    const card = await cardWithPr(s, 'fixed on the second try', 49);
    await openPr('subtask/ACME-1-second', 50);
    await alsoDelivers(s, card.id, 50);

    await ci({ conclusion: 'success', headSha: 'sha-ok', prNumbers: [49] });
    await ci({ conclusion: 'failure', headSha: 'sha-bad', prNumbers: [50] });
    expect(await statusOf(card.id)).toBe('implemented');

    await ci({ conclusion: 'success', headSha: 'sha-fixed', prNumbers: [50] });
    expect(await statusOf(card.id)).toBe('in_review');
  });

  it('a SINGLE-pull-request card is unchanged — every and some agree over a set of one', async () => {
    // The case nearly every card in the tree is. An all-green rule that
    // perturbed it would have made the product worse to fix a rarity.
    const s = await makeScenario('allgreen-single@example.com');
    const card = await cardWithPr(s, 'the ordinary card', 51);

    await ci({ conclusion: 'success', headSha: 'sha-only', prNumbers: [51] });

    expect(await statusOf(card.id)).toBe('in_review');
  });

  it('a card with NO pull request at all is never promoted — an empty set is not green', async () => {
    // `[].every(...)` is vacuously true, so the empty case has to be refused
    // explicitly or a card with no evidence whatever promotes itself.
    const s = await makeScenario('allgreen-none@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'no pull request' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);

    expect(await promoteIfCiAlreadyGreen(item.id, s.ctx)).toBe(false);
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('BOTH EDGES agree — the arrival edge withholds on the same set edge 1 withholds on', async () => {
    // The latch only works if the two edges ask the same question. If one
    // counted ANY and the other EVERY, a card would be reviewable or not
    // depending on which edge happened to fire.
    const s = await makeScenario('allgreen-edges@example.com');
    const card = await cardWithPr(s, 'arrives after a partial green', 52);
    await openPr('subtask/ACME-1-second', 53);
    await alsoDelivers(s, card.id, 53);

    await ci({ conclusion: 'success', headSha: 'sha-a', prNumbers: [52] });
    await ci({ conclusion: 'failure', headSha: 'sha-b', prNumbers: [53] });

    // Drive the ARRIVAL edge directly, which is the one a run's own transition
    // fires. It must reach the same verdict.
    expect(await promoteIfCiAlreadyGreen(card.id, s.ctx)).toBe(false);
    expect(await statusOf(card.id)).toBe('implemented');
  });
});
