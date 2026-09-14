import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ name: string; data: Record<string, unknown>; gatesAtSend: number }> = [];
vi.mock('@/lib/jobs/sendEvent', async () => {
  const { adminDb: admin } = await import('../helpers/adminDb');
  return {
    sendEvent: async (name: string, data: Record<string, unknown>) => {
      // Read on ANOTHER connection at the moment of sending: a gate visible here was
      // committed before the event left, which is what "post-commit" means.
      const gatesAtSend = await admin.approvalGate.count({
        where: { workItemId: String(data['workItemId']), kind: 'pull_request_merge' },
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
import { raiseMergeGates } from '@/lib/services/mergeGates';
import { resolveRunTargetFor } from '@/lib/services/runTarget';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// RAISE and WITHDRAW merge gates (Story MOTIR-4882 · MOTIR-5515; `approval-gates.md`
// §4's second amendment, decisions 1–3), against a REAL Postgres through the real
// webhook service — the same doors a GitHub delivery walks.
//
// One `awaiting` `pull_request_merge` gate per green pull request, on the run target,
// in a `manual` project — written in the transaction that promotes the card, and
// `superseded` the moment what it asks about changes.

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

async function mergeGates(workItemId: string) {
  return adminDb.approvalGate.findMany({
    where: { workItemId, kind: 'pull_request_merge' },
    orderBy: { createdAt: 'asc' },
  });
}

async function awaitingVersions(workItemId: string): Promise<string[]> {
  return (await mergeGates(workItemId))
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

/** A card promoted to in_review on two green pull requests, holding their two gates. */
async function reviewedWithTwoGates(email: string) {
  const s = await makeScenario(email);
  const item = await cardWithPrs(s, 'Two pull requests', [11, 12]);
  await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
  await ci({ conclusion: 'success', headSha: 'sha-b', number: 12 });
  expect(await statusOf(item.id)).toBe('in_review');
  expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#11@sha-a', 'moooon/acme#12@sha-b']);
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

describe('RAISE — one awaiting gate per green pull request, on the run target, in a manual project', () => {
  it('a card whose two pull requests turn green reaches in_review holding TWO gates, each naming its head', async () => {
    const s = await makeScenario('mg-raise@example.com');
    const item = await cardWithPrs(s, 'Two pull requests', [11, 12]);

    // One green of two is not the verdict: no promotion, no gate.
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await mergeGates(item.id)).toEqual([]);

    await ci({ conclusion: 'success', headSha: 'sha-b', number: 12 });
    expect(await statusOf(item.id)).toBe('in_review');

    const gates = await mergeGates(item.id);
    expect(gates).toHaveLength(2);
    expect(gates.map((g) => [g.subjectId, g.subjectVersion, g.state, g.routedToId])).toEqual(
      expect.arrayContaining([
        [await prId(11), 'moooon/acme#11@sha-a', 'awaiting', s.user.id],
        [await prId(12), 'moooon/acme#12@sha-b', 'awaiting', s.user.id],
      ]),
    );
  });

  it('the same card in an AUTO project reaches in_review and holds no merge gate', async () => {
    const s = await makeScenario('mg-auto@example.com');
    await adminDb.project.update({ where: { id: s.project.id }, data: { prMergeMode: 'auto' } });
    const item = await cardWithPrs(s, 'Auto', [11, 12]);

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
    await ci({ conclusion: 'success', headSha: 'sha-b', number: 12 });

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await mergeGates(item.id)).toEqual([]);
  });

  it('one pull request green and one red: the card stays implemented and holds no gate', async () => {
    const s = await makeScenario('mg-red@example.com');
    const item = await cardWithPrs(s, 'Half green', [11, 12]);

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
    await ci({ conclusion: 'failure', headSha: 'sha-b', number: 12 });

    expect(await statusOf(item.id)).toBe('implemented');
    expect(await mergeGates(item.id)).toEqual([]);
  });

  it('a green pull request whose provider cannot merge (GitLab) gets no gate; the same one on GitHub does', async () => {
    const s = await makeScenario('mg-gitlab@example.com');
    // Promote with no gates first, so the provider is the only thing that differs
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
    expect(await mergeGates(item.id)).toEqual([]);

    await adminDb.githubRepo.update({ where: { id: repo.id }, data: { provider: 'github' } });
    await promote();
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#11@sha-a']);
  });

  it('a CHILD a container run delivers holds no gate; its run target does — and How to test names the same card', async () => {
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
    const pullRequestIds = [await prId(13)];

    const raised = await withWorkspaceContext(s.ctx, async (tx) => {
      const rows = await Promise.all(
        [child.id, story.id].map((id) => tx.workItem.findUniqueOrThrow({ where: { id } })),
      );
      return {
        child: await raiseMergeGates({ item: rows[0]!, pullRequestIds }, s.ctx, tx),
        story: await raiseMergeGates({ item: rows[1]!, pullRequestIds }, s.ctx, tx),
        target: await resolveRunTargetFor(rows[0]!, tx),
      };
    });

    expect(raised.child).toBe(0);
    expect(raised.story).toBe(1);
    expect(await mergeGates(child.id)).toEqual([]);
    expect(await awaitingVersions(story.id)).toEqual(['moooon/acme#13@sha-p']);

    // The raise and the How to test block resolve the SAME run target.
    expect(raised.target).toMatchObject({ kind: 'ancestor', holder: { id: story.id } });
    expect((await howToTestService.getForWorkItem(child.id, s.ctx)).runTarget).toEqual({
      key: story.identifier,
    });
  });
});

describe('WITHDRAW — superseded when what the gate asks about changes', () => {
  it('a NEW COMMIT supersedes only that pull request’s gate; its green raises a fresh gate on the new head', async () => {
    const { item } = await reviewedWithTwoGates('mg-push@example.com');

    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-a2', number: 11 });
    const afterPush = await mergeGates(item.id);
    expect(
      afterPush.map((g) => [g.subjectVersion, g.state]).sort((a, b) => a[0]!.localeCompare(b[0]!)),
    ).toEqual([
      ['moooon/acme#11@sha-a', 'superseded'],
      ['moooon/acme#12@sha-b', 'awaiting'],
    ]);

    await ci({ conclusion: 'success', headSha: 'sha-a2', number: 11 });
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingVersions(item.id)).toEqual([
      'moooon/acme#11@sha-a2',
      'moooon/acme#12@sha-b',
    ]);
    // The other pull request's gate is the SAME row it was — untouched, not re-raised.
    const twelve = (await mergeGates(item.id)).filter((g) => g.subjectVersion?.includes('#12@'));
    expect(twelve).toHaveLength(1);
  });

  it('a `synchronize` delivery supersedes the gate on the head it moved away from', async () => {
    const { item } = await reviewedWithTwoGates('mg-sync@example.com');

    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('synchronize', 11, `subtask/${item.identifier}-11`, {
        head: { ref: `subtask/${item.identifier}-11`, sha: 'sha-a3' },
      }),
    );

    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#12@sha-b']);
  });

  it('a CLOSED pull request supersedes its gate', async () => {
    const { item } = await reviewedWithTwoGates('mg-closed@example.com');

    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('closed', 12, `subtask/${item.identifier}-12`),
    );

    const twelve = (await mergeGates(item.id)).find((g) => g.subjectVersion?.includes('#12@'));
    expect(twelve?.state).toBe('superseded');
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#11@sha-a']);
  });

  it('UNLINKING a pull request supersedes that card’s gate for it, and only that one', async () => {
    const { s, item } = await reviewedWithTwoGates('mg-unlink@example.com');

    const result = await githubPullRequestService.unlinkPullRequestByCoordinates(
      { workItemId: item.id, projectId: s.project.id, owner: 'moooon', name: 'acme', number: 12 },
      s.ctx,
    );

    expect(result.removed).toBe(true);
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#11@sha-a']);
  });
});

describe('one transaction, one gate per pull request, however the events arrive', () => {
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
    expect(await mergeGates(item.id)).toEqual([]);
    expect(sent.filter((e) => e.name === 'work-item/transitioned')).toEqual([]);
  });

  it('two green events for one card, concurrently, leave one gate per pull request; a redelivery adds none', async () => {
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
    expect(await awaitingVersions(item.id)).toEqual([
      'moooon/acme#11@sha-a',
      'moooon/acme#12@sha-b',
    ]);

    await Promise.all([green(11), green(11)]);
    expect(await mergeGates(item.id)).toHaveLength(2);
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
