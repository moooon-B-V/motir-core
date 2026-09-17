import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ name: string; data: Record<string, unknown>; gatesAtSend: number }> = [];
vi.mock('@/lib/jobs/sendEvent', async () => {
  const { adminDb: admin } = await import('../helpers/adminDb');
  return {
    sendEvent: async (name: string, data: Record<string, unknown>) => {
      // Read on ANOTHER connection at the moment of sending: a gate visible here was
      // committed before the event left.
      const gatesAtSend = await admin.approvalGate.count({
        where: { workItemId: String(data['workItemId']), kind: 'pull_request_approval' },
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
import { promoteDeliveredCardsOnGreen } from '@/lib/services/ciPromotion';
import { raisePullRequestApprovalGate } from '@/lib/services/pullRequestApprovalGates';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// RAISE and WITHDRAW the `pull_request_approval` gate (Story MOTIR-4909 · MOTIR-5482;
// `approval-gates.md` §8's amendment, decisions 1, 3 and 4), against a REAL Postgres through
// the real webhook service — the same doors a GitHub delivery walks. The fixtures mirror
// `mergeGates.test.ts`, whose transaction this gate joins.
//
// ONE `awaiting` approve-and-merge gate per card, on the run target, in a `manual` project,
// once its whole delivery set is green — and `superseded` when that set changes.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-approval-gates';
const REPO_PROVIDER_ID = '992';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const KIND = 'pull_request_approval';

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

/** A CI verdict for one pull request at one commit. */
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

/** A card delivered by one pull request per number, linked and opened, at `implemented`. */
async function cardWithPrs(s: Scenario, title: string, numbers: number[]) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  for (const number of numbers) await openLinked(item.identifier, number);
  expect(await statusOf(item.id)).toBe('implemented');
  return item;
}

async function openLinked(identifier: string, number: number) {
  const headRef = `subtask/${identifier}-${number}`;
  await linkPrByIdentifier({ identifier, owner: 'moooon', name: 'acme', number, headRef });
  await githubWebhookService.handleEvent(
    'pull_request',
    pullRequestPayload('opened', number, headRef),
  );
}

async function statusOf(workItemId: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } })).status;
}

async function prId(number: number): Promise<string> {
  return (await adminDb.githubPullRequest.findFirstOrThrow({ where: { number } })).id;
}

async function approvalGates(workItemId: string) {
  return adminDb.approvalGate.findMany({
    where: { workItemId, kind: KIND },
    orderBy: { createdAt: 'asc' },
  });
}

async function awaiting(workItemId: string) {
  return (await approvalGates(workItemId)).filter((g) => g.state === 'awaiting');
}

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

const promote = async (s: Scenario, number: number) =>
  promoteDeliveredCardsOnGreen({
    changeRequestId: await prId(number),
    workspaceId: s.workspace.id,
    actorUserId: s.user.id,
  });

/** A card promoted on two green pull requests, holding its one approve-and-merge gate. */
async function reviewedWithGate(email: string) {
  const s = await makeScenario(email);
  const item = await cardWithPrs(s, 'Two pull requests', [11, 12]);
  await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
  await ci({ conclusion: 'success', headSha: 'sha-b', number: 12 });
  expect(await statusOf(item.id)).toBe('in_review');
  const [gate] = await awaiting(item.id);
  expect(gate?.subjectVersion).toBe('moooon/acme#11@sha-a,moooon/acme#12@sha-b');
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

describe('RAISE — one awaiting gate per card, on the run target, when its whole set is green', () => {
  it('a card whose two pull requests turn green reaches in_review holding ONE gate over both heads', async () => {
    const s = await makeScenario('pa-raise@example.com');
    const item = await cardWithPrs(s, 'Two pull requests', [11, 12]);

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
    expect(await approvalGates(item.id)).toEqual([]);

    await ci({ conclusion: 'success', headSha: 'sha-b', number: 12 });
    expect(await statusOf(item.id)).toBe('in_review');
    const gates = await approvalGates(item.id);
    expect(gates).toHaveLength(1);
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(gates[0]).toMatchObject({
      state: 'awaiting',
      subjectId: item.id,
      subjectVersion: 'moooon/acme#11@sha-a,moooon/acme#12@sha-b',
      routedToId: row.assigneeId ?? row.reporterId,
    });
  });

  it('routes to the ASSIGNEE when the card has one, and not to its reporter', async () => {
    const s = await makeScenario('pa-route@example.com');
    const item = await cardWithPrs(s, 'Assigned', [11]);
    const assignee = await usersService.createUser({
      email: 'pa-assignee@example.com',
      password: PASSWORD,
      name: 'Assignee',
    });
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: assignee.id } });

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });

    const [gate] = await awaiting(item.id);
    expect(gate?.routedToId).toBe(assignee.id);
  });

  it('the same card in an AUTO project reaches in_review and holds no gate', async () => {
    const s = await makeScenario('pa-auto@example.com');
    await adminDb.project.update({ where: { id: s.project.id }, data: { prMergeMode: 'auto' } });
    const item = await cardWithPrs(s, 'Auto', [11, 12]);

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
    await ci({ conclusion: 'success', headSha: 'sha-b', number: 12 });

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await approvalGates(item.id)).toEqual([]);
  });

  // ⚠️ REVERSED — MOTIR-5662, one of MOTIR-5652's two root causes. The run-target
  // refusal is gone: a card with something to decide has a gate regardless of who
  // holds the run target. In a parent run the How-to-test record is written once
  // onto the PARENT, so every child resolved to `ancestor` and raised nothing,
  // while the parent's own promotion was skipped by `ContainerHasOpenChildrenError`.
  it('a CHILD a container run delivers raises its gate too, though its run target is the ANCESTOR', async () => {
    const s = await makeScenario('pa-child@example.com');
    const story = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'story', title: 'The story' },
      s.ctx,
    );
    const child = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A child', parentId: story.id },
      s.ctx,
    );
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
      const [childRow, storyRow] = await Promise.all(
        [child.id, story.id].map((id) => tx.workItem.findUniqueOrThrow({ where: { id } })),
      );
      return {
        child: await raisePullRequestApprovalGate(childRow!, tx),
        story: await raisePullRequestApprovalGate(storyRow!, tx),
      };
    });

    expect(raised).toEqual({ child: true, story: true });
    for (const id of [child.id, story.id]) {
      expect((await awaiting(id)).map((g) => g.subjectVersion)).toEqual(['moooon/acme#13@sha-p']);
    }
  });
});

describe('WITHDRAW — superseded when the set the gate asked about changes', () => {
  it('a NEW COMMIT supersedes the gate while the card stays in review; the next green raises a fresh one on the new head', async () => {
    const { item } = await reviewedWithGate('pa-push@example.com');

    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-a2', number: 11 });
    expect(await awaiting(item.id)).toEqual([]);
    expect((await approvalGates(item.id)).map((g) => g.state)).toEqual(['superseded']);
    expect(await statusOf(item.id)).toBe('in_review');

    await ci({ conclusion: 'success', headSha: 'sha-a2', number: 11 });
    expect(await statusOf(item.id)).toBe('in_review');
    expect((await awaiting(item.id)).map((g) => g.subjectVersion)).toEqual([
      'moooon/acme#11@sha-a2,moooon/acme#12@sha-b',
    ]);
  });

  it('a `synchronize` delivery supersedes the gate', async () => {
    const { item } = await reviewedWithGate('pa-sync@example.com');

    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('synchronize', 11, `subtask/${item.identifier}-11`, {
        head: { ref: `subtask/${item.identifier}-11`, sha: 'sha-a3' },
      }),
    );

    expect(await awaiting(item.id)).toEqual([]);
  });

  it('a late check row for the SAME head withdraws nothing', async () => {
    const { item } = await reviewedWithGate('pa-late@example.com');

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });

    expect(await awaiting(item.id)).toHaveLength(1);
  });

  it('a CLOSED member supersedes the gate', async () => {
    const { item } = await reviewedWithGate('pa-closed@example.com');

    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('closed', 12, `subtask/${item.identifier}-12`),
    );

    expect(await awaiting(item.id)).toEqual([]);
  });

  // ⚠️ AMENDED — MOTIR-5663. The withdrawal still happens and still records
  // `set_changed`; what is new is that the site then ASKS what the card should hold
  // now. The remaining member is green, so the answer is a gate over the SMALLER
  // set — which is the structural half of this level: a question retired for an
  // excellent reason used to leave the card with none (MOTIR-5604, paid for once at
  // one site while six others behaved the same way).
  it('UNLINKING a member supersedes the gate and re-asks over the smaller set', async () => {
    const { s, item } = await reviewedWithGate('pa-unlink@example.com');

    const result = await githubPullRequestService.unlinkPullRequestByCoordinates(
      { workItemId: item.id, projectId: s.project.id, owner: 'moooon', name: 'acme', number: 12 },
      s.ctx,
    );

    expect(result.removed).toBe(true);
    expect((await awaiting(item.id)).map((g) => g.subjectVersion)).toEqual([
      'moooon/acme#11@sha-a',
    ]);
  });

  it('LINKING a new member supersedes the gate; re-linking one it already delivers does not', async () => {
    const { item } = await reviewedWithGate('pa-link@example.com');

    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 11,
      headRef: `subtask/${item.identifier}-11`,
    });
    expect(await awaiting(item.id)).toHaveLength(1);

    await openLinked(item.identifier, 14);
    expect(await awaiting(item.id)).toEqual([]);
  });
});

describe('one transaction, one gate per card, however the events arrive', () => {
  it('an approval-gate insert that FAILS rolls the status write and the merge gates back with it', async () => {
    const s = await makeScenario('pa-rollback@example.com');
    const item = await cardWithPrs(s, 'Rollback', [11]);
    await greenRow(11, 'sha-a');
    const create = approvalGateRepository.create.bind(approvalGateRepository);
    vi.spyOn(approvalGateRepository, 'create').mockImplementation((data, tx) =>
      data.kind === KIND ? Promise.reject(new Error('approval insert failed')) : create(data, tx),
    );
    sent.length = 0;

    await expect(promote(s, 11)).rejects.toThrow('approval insert failed');

    expect(await statusOf(item.id)).toBe('implemented');
    expect(await adminDb.approvalGate.count({ where: { workItemId: item.id } })).toBe(0);
    expect(sent.filter((e) => e.name === 'work-item/transitioned')).toEqual([]);
  });

  it('two green events for one card, concurrently, leave ONE gate; a redelivery adds none', async () => {
    const s = await makeScenario('pa-race@example.com');
    const item = await cardWithPrs(s, 'Race', [11, 12]);
    await greenRow(11, 'sha-a');
    await greenRow(12, 'sha-b');

    await Promise.all([promote(s, 11), promote(s, 12)]);

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaiting(item.id)).toHaveLength(1);

    await Promise.all([promote(s, 11), promote(s, 11)]);
    expect(await approvalGates(item.id)).toHaveLength(1);
  });

  it('work-item/transitioned is still sent after commit, with the gate already visible', async () => {
    const s = await makeScenario('pa-event@example.com');
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
    expect(transitioned[0]!.gatesAtSend).toBe(1);
  });
});

describe('AMENDMENT 6 Q5 — the withdrawal records WHY, and the three PR causes are distinct', () => {
  // Until MOTIR-5659 a superseded row carried `state` and nothing else, so every
  // surface describing one had to guess — and MOTIR-5586 / MOTIR-5651 are the two
  // that guessed "a newer design was published" over all of them. The three
  // withdrawals below are three different sentences a person should be told, and
  // the point of these assertions is that the ROW can now tell them apart. A
  // single `expect(state).toBe('superseded')` passes with all three wired to one
  // cause, which is the state this story is undoing.

  it('a moved HEAD records `head_moved`', async () => {
    const { item } = await reviewedWithGate('pa-cause-head@example.com');

    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-a2', number: 11 });

    expect((await approvalGates(item.id)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'head_moved'],
    ]);
  });

  it('a CLOSED member records `member_closed`', async () => {
    const { item } = await reviewedWithGate('pa-cause-closed@example.com');

    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('closed', 12, `subtask/${item.identifier}-12`),
    );

    expect((await approvalGates(item.id)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'member_closed'],
    ]);
  });

  // Two tests rather than one: each scenario reuses the same pull-request numbers,
  // and only `beforeEach` truncates — a second `reviewedWithGate` in one test
  // inherits the first card's green check rows and never passes through
  // `implemented`.
  it('a member JOINING the set records `set_changed`', async () => {
    const { item } = await reviewedWithGate('pa-cause-join@example.com');

    await openLinked(item.identifier, 14);

    expect((await approvalGates(item.id)).map((g) => g.supersededCause)).toEqual(['set_changed']);
  });

  it('a member LEAVING the set records `set_changed` too', async () => {
    const { s, item } = await reviewedWithGate('pa-cause-unlink@example.com');

    await githubPullRequestService.unlinkPullRequestByCoordinates(
      { workItemId: item.id, projectId: s.project.id, owner: 'moooon', name: 'acme', number: 12 },
      s.ctx,
    );

    // Two rows now (MOTIR-5663): the withdrawn one carrying its cause, and the
    // fresh question over the smaller set — which carries none, because it is a
    // question rather than a withdrawal.
    expect((await approvalGates(item.id)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'set_changed'],
      ['awaiting', null],
    ]);
  });

  it('an AWAITING gate carries NO cause — the column describes a withdrawal, not a question', async () => {
    const { item } = await reviewedWithGate('pa-cause-awaiting@example.com');

    expect((await awaiting(item.id)).map((g) => g.supersededCause)).toEqual([null]);
  });

  it('a cause is not an ACTOR: the withdrawal still writes no decider, authority or note', async () => {
    // §6b's invariant, re-asserted because this story is the first thing to add a
    // column to that write. A cause says what happened to the SUBJECT; it must
    // not become the toehold by which a product write starts looking like a
    // person's answer.
    const { item } = await reviewedWithGate('pa-cause-noactor@example.com');

    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-a2', number: 11 });

    const [row] = await approvalGates(item.id);
    expect(row).toMatchObject({ state: 'superseded', supersededCause: 'head_moved' });
    expect({
      decidedById: row!.decidedById,
      decidedAt: row!.decidedAt,
      decidedByLabel: row!.decidedByLabel,
      decidedUnderAuthority: row!.decidedUnderAuthority,
      decisionSource: row!.decisionSource,
      noteMd: row!.noteMd,
    }).toEqual({
      decidedById: null,
      decidedAt: null,
      decidedByLabel: null,
      decidedUnderAuthority: null,
      decisionSource: null,
      noteMd: null,
    });
  });
});
