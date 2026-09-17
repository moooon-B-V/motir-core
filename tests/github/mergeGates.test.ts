import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ name: string; data: Record<string, unknown>; gatesAtSend: number }> = [];
vi.mock('@/lib/jobs/sendEvent', async () => {
  const { adminDb: admin } = await import('../helpers/adminDb');
  return {
    sendEvent: async (name: string, data: Record<string, unknown>) => {
      // Read on ANOTHER connection at the moment of sending: a gate visible here was
      // committed before the event left, which is what "post-commit" means.
      const gatesAtSend = await admin.approvalGate.count({
        where: { workItemId: String(data['workItemId']) },
      });
      sent.push({ name, data, gatesAtSend });
    },
  };
});

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { howToTestService } from '@/lib/services/howToTestService';
import { promoteDeliveredCardsOnGreen } from '@/lib/services/ciPromotion';
import { raisePullRequestApprovalGate } from '@/lib/services/pullRequestApprovalGates';
import { resolveRunTargetFor } from '@/lib/services/runTarget';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// ONE GATE per card (MOTIR-5603 · MOTIR-5611; `approval-gates.md` §8's SECOND
// AMENDMENT, decisions 1 and 2), against a REAL Postgres through the real webhook
// service — the same doors a GitHub delivery walks.
//
// A green delivery set leaves EXACTLY ONE `awaiting` gate on the run target in a
// `manual` project — the `pull_request_approval` gate over the whole set — and NEVER a
// per-pull-request `pull_request_merge` gate. This file is the regression guard for
// that: every assertion below fails if the manual arm ever raises one again.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-merge-gates';
const REPO_PROVIDER_ID = '991';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

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

function pullRequestPayload(action: string, number: number, headRef: string, extra = {}) {
  return {
    action,
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: action === 'closed' ? 'closed' : 'open',
      merged: false,
      title: `A change (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
      ...extra,
    },
  };
}

/** A green (or not) CI verdict for one pull request at one commit. */
const ci = (opts: {
  conclusion: string | null;
  headSha: string;
  number: number;
  status?: string;
}) =>
  githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: opts.headSha,
      head_branch: null,
      status: opts.status ?? 'completed',
      conclusion: opts.conclusion,
      app: { slug: 'github-actions' },
      pull_requests: [{ number: opts.number }],
    },
  });

/** ONE named check at one commit — how a LATE row for an old commit arrives (a
 *  workflow reporting after the push, a redelivery). The name is one that commit has
 *  not reported yet, so the ingestion INSERTS a row rather than updating one. */
const checkRun = (opts: { name: string; conclusion: string; headSha: string; number: number }) =>
  githubWebhookService.handleEvent('check_run', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_run: {
      head_sha: opts.headSha,
      status: 'completed',
      conclusion: opts.conclusion,
      name: opts.name,
      check_suite: { head_branch: null, id: 777 },
      pull_requests: [{ number: opts.number }],
    },
  });

/** A card delivered by one pull request per number, each linked the way a run links
 *  it and opened, so the card sits at `implemented`. */
async function cardWithPrs(s: Scenario, title: string, numbers: number[]) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  for (const number of numbers) {
    const headRef = `subtask/${item.identifier}-${number}`;
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number,
      headRef,
    });
    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('opened', number, headRef),
    );
  }
  expect(await statusOf(item.id)).toBe('implemented');
  return item;
}

async function statusOf(workItemId: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } })).status;
}

async function prId(number: number): Promise<string> {
  return (await adminDb.githubPullRequest.findFirstOrThrow({ where: { number } })).id;
}

/** Every gate on the card, whatever its kind — what a person would see waiting. */
async function gatesOf(workItemId: string) {
  return adminDb.approvalGate.findMany({
    where: { workItemId },
    orderBy: { createdAt: 'asc' },
  });
}

/** The gate kind MOTIR-5611 retired. Every call below asserts this is EMPTY. */
async function mergeGates(workItemId: string) {
  return adminDb.approvalGate.findMany({
    where: { workItemId, kind: 'pull_request_merge' },
    orderBy: { createdAt: 'asc' },
  });
}

async function awaitingVersions(workItemId: string): Promise<string[]> {
  return (await gatesOf(workItemId))
    .filter((g) => g.state === 'awaiting')
    .map((g) => g.subjectVersion ?? '')
    .sort();
}

/** Record a green check row directly — for the cases that drive the promotion by hand. */
async function greenRow(number: number, sha: string) {
  await adminDb.githubCheckRun.create({
    data: {
      pullRequestId: await prId(number),
      commitSha: sha,
      checkName: 'ci / vitest',
      conclusion: 'success',
    },
  });
}

/** A card promoted to in_review on two green pull requests, holding its ONE gate. */
async function reviewedWithOneGate(email: string) {
  const s = await makeScenario(email);
  const item = await cardWithPrs(s, 'Two pull requests', [11, 12]);
  await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
  await ci({ conclusion: 'success', headSha: 'sha-b', number: 12 });
  expect(await statusOf(item.id)).toBe('in_review');
  const gates = await gatesOf(item.id);
  expect(gates).toHaveLength(1);
  expect(gates[0]!.kind).toBe('pull_request_approval');
  expect(await mergeGates(item.id)).toEqual([]);
  return { s, item };
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  sent.length = 0;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('ONE GATE — a green delivery set leaves exactly one awaiting gate on the run target', () => {
  it('a card whose two pull requests turn green reaches in_review holding ONE gate over BOTH heads', async () => {
    const s = await makeScenario('mg-raise@example.com');
    const item = await cardWithPrs(s, 'Two pull requests', [11, 12]);

    // One green of two is not the verdict: no promotion, no gate.
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await gatesOf(item.id)).toEqual([]);

    await ci({ conclusion: 'success', headSha: 'sha-b', number: 12 });
    expect(await statusOf(item.id)).toBe('in_review');

    const gates = await gatesOf(item.id);
    expect(gates).toHaveLength(1);
    expect([
      gates[0]!.kind,
      gates[0]!.subjectId,
      gates[0]!.subjectVersion,
      gates[0]!.state,
    ]).toEqual([
      'pull_request_approval',
      item.id,
      'moooon/acme#11@sha-a,moooon/acme#12@sha-b',
      'awaiting',
    ]);
    expect(gates[0]!.routedToId).toBe(s.user.id);
    // MOTIR-5611: the per-pull-request kind is never raised again.
    expect(await mergeGates(item.id)).toEqual([]);

    // And through the PRODUCTION read — a row in the table that the scoped read
    // cannot see is not a question anybody is being asked.
    const awaiting = await withWorkspaceContext(s.ctx, (tx) =>
      approvalGateRepository.findAwaitingByWorkItem(item.id, tx),
    );
    expect(awaiting.map((g) => g.kind)).toEqual(['pull_request_approval']);
  });

  it('the same card in an AUTO project reaches in_review and holds NO gate at all', async () => {
    const s = await makeScenario('mg-auto@example.com');
    await adminDb.project.update({ where: { id: s.project.id }, data: { prMergeMode: 'auto' } });
    const item = await cardWithPrs(s, 'Auto', [11, 12]);

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
    await ci({ conclusion: 'success', headSha: 'sha-b', number: 12 });

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await gatesOf(item.id)).toEqual([]);
  });

  it('one pull request green and one red: the card stays implemented and holds no gate', async () => {
    const s = await makeScenario('mg-red@example.com');
    const item = await cardWithPrs(s, 'Half green', [11, 12]);

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
    await ci({ conclusion: 'failure', headSha: 'sha-b', number: 12 });

    expect(await statusOf(item.id)).toBe('implemented');
    expect(await gatesOf(item.id)).toEqual([]);
  });

  it('a card whose provider cannot merge (GitLab) gets no gate; the same one on GitHub gets ONE', async () => {
    const s = await makeScenario('mg-gitlab@example.com');
    // Promote with no gate first, so the provider is the only thing that differs
    // between the two re-raises below.
    await adminDb.project.update({ where: { id: s.project.id }, data: { prMergeMode: 'auto' } });
    const item = await cardWithPrs(s, 'GitLab', [11]);
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
    expect(await statusOf(item.id)).toBe('in_review');
    await adminDb.project.update({ where: { id: s.project.id }, data: { prMergeMode: 'manual' } });

    const repo = await adminDb.githubRepo.findFirstOrThrow({ where: { name: 'acme' } });
    const promote = async () =>
      promoteDeliveredCardsOnGreen({
        changeRequestId: await prId(11),
        workspaceId: s.workspace.id,
        actorUserId: s.user.id,
      });

    await adminDb.githubRepo.update({ where: { id: repo.id }, data: { provider: 'gitlab' } });
    await promote();
    expect(await gatesOf(item.id)).toEqual([]);

    await adminDb.githubRepo.update({ where: { id: repo.id }, data: { provider: 'github' } });
    await promote();
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#11@sha-a']);
    expect(await mergeGates(item.id)).toEqual([]);
  });

  // ⚠️ REVERSED — MOTIR-5662, one of MOTIR-5652's two root causes. This test
  // pinned `raisePullRequestApprovalGate`'s run-target refusal: a card whose run
  // target resolved to `{ kind: 'ancestor' }` raised nothing. `resolveRunTargetFor`
  // answers *whose How to test is this*, which is true and useful; it was never an
  // answer to *does this card have something to decide*. In a parent run the
  // How-to-test record is written once onto the PARENT, so EVERY child resolved to
  // `ancestor` and raised nothing — while the parent's own promotion was skipped by
  // `ContainerHasOpenChildrenError`. No gate anywhere.
  //
  // The How-to-test half of the assertion is UNCHANGED and is why the test is kept
  // rather than deleted: the two questions used to share one answer, and this is
  // where they are shown to have come apart.
  it('a CHILD a container run delivers raises its gate exactly as its run target does — and How to test still names the ancestor', async () => {
    const s = await makeScenario('mg-child@example.com');
    const story = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'story', title: 'The story' },
      s.ctx,
    );
    const child = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A child', parentId: story.id },
      s.ctx,
    );
    // The parent run's record — what makes the story the run target.
    await adminDb.testInstructions.create({
      data: {
        workspaceId: s.workspace.id,
        projectId: s.project.id,
        workItemId: story.id,
        bodyMd: '## Open the page',
      },
    });
    for (const identifier of [story.identifier, child.identifier]) {
      await linkPrByIdentifier({
        identifier,
        owner: 'moooon',
        name: 'acme',
        number: 13,
        headRef: `parent/${story.identifier}-work`,
      });
    }
    await greenRow(13, 'sha-p');

    const raised = await withWorkspaceContext(s.ctx, async (tx) => {
      const rows = await Promise.all(
        [child.id, story.id].map((id) => tx.workItem.findUniqueOrThrow({ where: { id } })),
      );
      return {
        child: await raisePullRequestApprovalGate(rows[0]!, tx),
        story: await raisePullRequestApprovalGate(rows[1]!, tx),
        target: await resolveRunTargetFor(rows[0]!, tx),
      };
    });

    expect(raised.child).toBe(true);
    expect(raised.story).toBe(true);
    expect(await awaitingVersions(child.id)).toEqual(['moooon/acme#13@sha-p']);
    expect(await awaitingVersions(story.id)).toEqual(['moooon/acme#13@sha-p']);

    // The child's run target is still the STORY — naming the resolved kind, because
    // the point is that a gate is now raised DESPITE it.
    expect(raised.target).toMatchObject({ kind: 'ancestor', holder: { id: story.id } });
    expect((await howToTestService.getForWorkItem(child.id, s.ctx)).runTarget).toEqual({
      key: story.identifier,
    });
  });
});

describe('WITHDRAW — the card’s ONE gate is superseded when its SET changes', () => {
  it('a NEW COMMIT supersedes the card’s gate; the next green raises a fresh one over the new set', async () => {
    const { item } = await reviewedWithOneGate('mg-push@example.com');

    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-a2', number: 11 });
    const afterPush = await gatesOf(item.id);
    expect(afterPush.map((g) => [g.subjectVersion, g.state])).toEqual([
      ['moooon/acme#11@sha-a,moooon/acme#12@sha-b', 'superseded'],
    ]);

    await ci({ conclusion: 'success', headSha: 'sha-a2', number: 11 });
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#11@sha-a2,moooon/acme#12@sha-b']);
    expect(await mergeGates(item.id)).toEqual([]);
  });

  // MOTIR-5604 — green → push → green must leave exactly ONE awaiting gate even when a row
  // for the OLD commit is written after the new one's. The head used to be the commit of
  // the newest ROW, so that late row made the old commit current again: the withdrawal
  // superseded the fresh gate, and the raise named the old head.
  it('a LATE row for the OLD commit, written after the new head went green, leaves the fresh gate standing', async () => {
    const { s, item } = await reviewedWithOneGate('mg-late-after@example.com');

    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-a2', number: 11 });
    await ci({ conclusion: 'success', headSha: 'sha-a2', number: 11 });
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#11@sha-a2,moooon/acme#12@sha-b']);

    await checkRun({ name: 'CodeQL', conclusion: 'success', headSha: 'sha-a', number: 11 });

    // Rows for BOTH commits exist, and the older commit's was written last.
    const rows = await adminDb.githubCheckRun.findMany({
      where: { pullRequestId: await prId(11) },
      orderBy: { createdAt: 'desc' },
    });
    expect(new Set(rows.map((r) => r.commitSha))).toEqual(new Set(['sha-a', 'sha-a2']));
    expect(rows[0]!.commitSha).toBe('sha-a');

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#11@sha-a2,moooon/acme#12@sha-b']);
    const awaiting = await withWorkspaceContext(s.ctx, (tx) =>
      approvalGateRepository.findAwaitingByWorkItem(item.id, tx),
    );
    expect(awaiting.map((g) => g.kind)).toEqual(['pull_request_approval']);
    expect(await mergeGates(item.id)).toEqual([]);
  });

  it('a LATE row for the OLD commit, written between the push and the new green, does not stop the green raising over the NEW head', async () => {
    const { item } = await reviewedWithOneGate('mg-late-between@example.com');

    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-a2', number: 11 });
    expect(await awaitingVersions(item.id)).toEqual([]);

    // The old commit reports a check it had not reported before, AFTER the new commit's
    // first row. The new commit's verdict then UPDATES its pending row, which keeps that
    // row's creation time — so the old commit's row stays the newest one.
    await checkRun({ name: 'CodeQL', conclusion: 'success', headSha: 'sha-a', number: 11 });
    await ci({ conclusion: 'success', headSha: 'sha-a2', number: 11 });

    const gates = await gatesOf(item.id);
    expect(gates.filter((g) => g.state === 'awaiting')).toHaveLength(1);
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#11@sha-a2,moooon/acme#12@sha-b']);
    expect(await mergeGates(item.id)).toEqual([]);
  });

  it('a `synchronize` delivery supersedes the gate asked about the head it moved away from', async () => {
    const { item } = await reviewedWithOneGate('mg-sync@example.com');

    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('synchronize', 11, `subtask/${item.identifier}-11`, {
        head: { ref: `subtask/${item.identifier}-11`, sha: 'sha-a3' },
      }),
    );

    expect(await awaitingVersions(item.id)).toEqual([]);
  });

  it('a CLOSED member supersedes the gate — the set nobody can merge is no longer the question', async () => {
    const { item } = await reviewedWithOneGate('mg-closed@example.com');

    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('closed', 12, `subtask/${item.identifier}-12`),
    );

    expect(await awaitingVersions(item.id)).toEqual([]);
    expect((await gatesOf(item.id)).map((g) => g.state)).toEqual(['superseded']);
  });

  // ⚠️ AMENDED — MOTIR-5663. The withdrawal still happens and still records
  // `set_changed`; what is new is that the site then ASKS what the card should hold
  // now. The remaining member is green, so the answer is a gate over the SMALLER
  // set — which is the structural half of this level: a question retired for an
  // excellent reason used to leave the card with none (MOTIR-5604, paid for once at
  // one site while six others behaved the same way).
  it('UNLINKING a member supersedes that card’s gate and re-asks over the smaller set', async () => {
    const { s, item } = await reviewedWithOneGate('mg-unlink@example.com');

    const result = await githubPullRequestService.unlinkPullRequestByCoordinates(
      { workItemId: item.id, projectId: s.project.id, owner: 'moooon', name: 'acme', number: 12 },
      s.ctx,
    );

    expect(result.removed).toBe(true);
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#11@sha-a']);
  });
});

describe('one transaction, ONE gate per card, however the events arrive', () => {
  it('a gate insert that FAILS rolls the status write back with it', async () => {
    const s = await makeScenario('mg-rollback@example.com');
    const item = await cardWithPrs(s, 'Rollback', [11]);
    await greenRow(11, 'sha-a');
    vi.spyOn(approvalGateRepository, 'create').mockRejectedValueOnce(new Error('insert failed'));
    sent.length = 0;

    await expect(
      promoteDeliveredCardsOnGreen({
        changeRequestId: await prId(11),
        workspaceId: s.workspace.id,
        actorUserId: s.user.id,
      }),
    ).rejects.toThrow('insert failed');

    expect(await statusOf(item.id)).toBe('implemented');
    expect(await gatesOf(item.id)).toEqual([]);
    expect(sent.filter((e) => e.name === 'work-item/transitioned')).toEqual([]);
  });

  it('two green events for one card, concurrently, leave ONE gate; a redelivery adds none', async () => {
    const s = await makeScenario('mg-race@example.com');
    const item = await cardWithPrs(s, 'Race', [11, 12]);
    await greenRow(11, 'sha-a');
    await greenRow(12, 'sha-b');
    const green = async (number: number) =>
      promoteDeliveredCardsOnGreen({
        changeRequestId: await prId(number),
        workspaceId: s.workspace.id,
        actorUserId: s.user.id,
      });

    const [first, second] = await Promise.all([green(11), green(12)]);

    expect([...first, ...second]).toContain(item.id);
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#11@sha-a,moooon/acme#12@sha-b']);

    await Promise.all([green(11), green(11)]);
    expect(await gatesOf(item.id)).toHaveLength(1);
    expect(await mergeGates(item.id)).toEqual([]);
  });

  it('work-item/transitioned is still sent after commit, with the payload it always carried', async () => {
    const s = await makeScenario('mg-event@example.com');
    const item = await cardWithPrs(s, 'Event', [11]);
    sent.length = 0;

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });

    const transitioned = sent.filter((e) => e.name === 'work-item/transitioned');
    expect(transitioned).toHaveLength(1);
    expect(transitioned[0]!.data).toEqual({
      workspaceId: s.workspace.id,
      workItemId: item.id,
      actorId: s.user.id,
      fromStatusKey: 'implemented',
      toStatusKey: 'in_review',
      revisionId: expect.any(String),
    });
    // The gate was committed before the event left.
    expect(transitioned[0]!.gatesAtSend).toBe(1);
  });
});
