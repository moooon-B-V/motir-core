import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { MergeChangeRequestResult } from '@/lib/git/types';
import {
  ApprovalGateAlreadyRequeuedError,
  ApprovalGateNotFoundError,
} from '@/lib/approvalGates/errors';
import { QueueAgainRefusedError } from '@/lib/mergeQueue/errors';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// QUEUE AGAIN (Story MOTIR-5461 · MOTIR-5634; `docs/decisions/approval-gates.md` §4 THIRD
// AMENDMENT, decision 5), on a REAL Postgres. A pull request the merge queue removed is
// put back by ONE press while its head is unchanged — on the card's DECIDED approval in a
// `manual` project, as a person's re-dispatch in an `auto` one — and never twice. The host
// is the seam's `mergeChangeRequest`, stubbed: the one thing that leaves the process.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-queue-again';
const REPO_PROVIDER_ID = '994';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const KIND = 'pull_request_approval';
const github = getGitProvider('github') as Required<GitProvider>;

const captured = JSON.parse(
  readFileSync(
    join(process.cwd(), 'tests/fixtures/github/merge-queue/dequeued-ci-failure.json'),
    'utf8',
  ),
).payload as Record<string, unknown>;

function dequeued(number: number, headSha: string, reason = 'CI_FAILURE') {
  const pr = structuredClone(captured['pull_request']) as Record<string, unknown>;
  pr['number'] = number;
  pr['head'] = { ...(pr['head'] as Record<string, unknown>), sha: headSha };
  return {
    ...captured,
    reason,
    number,
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: pr,
  };
}

let guid = 0;
const eject = (number: number, headSha: string, reason?: string) =>
  githubWebhookService.handleEvent(
    'pull_request',
    dequeued(number, headSha, reason),
    `g-${++guid}`,
  );

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function makeScenario(email: string, mode: 'manual' | 'auto') {
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
  await adminDb.project.update({ where: { id: project.id }, data: { prMergeMode: mode } });
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
  return { user, workspace, project, ctx: { userId: user.id, workspaceId: workspace.id } };
}

const ci = (number: number, headSha: string) =>
  githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: headSha,
      head_branch: null,
      status: 'completed',
      conclusion: 'success',
      app: { slug: 'github-actions' },
      pull_requests: [{ number }],
    },
  });

async function card(s: Scenario, numbers: number[]) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'Queued work' },
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
    await githubWebhookService.handleEvent('pull_request', {
      action: 'opened',
      installation: INSTALLATION,
      repository: { id: Number(REPO_PROVIDER_ID) },
      pull_request: {
        number,
        state: 'open',
        merged: false,
        title: `A change (${headRef})`,
        head: { ref: headRef },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });
  }
  return item;
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const pr = (number: number) => adminDb.githubPullRequest.findFirstOrThrow({ where: { number } });
const awaitingGates = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId, kind: KIND, state: 'awaiting' } });
const latestExit = async (number: number) =>
  adminDb.githubPullRequestQueueExit.findFirstOrThrow({
    where: { pullRequestId: (await pr(number)).id },
    orderBy: { createdAt: 'desc' },
  });
const markQueued = async (number: number, authority: 'gate' | 'auto_mode') =>
  adminDb.githubPullRequest.update({
    where: { id: (await pr(number)).id },
    data: { mergeAuthority: authority, mergeOutcomeRef: `queue:entry-${number}` },
  });

function stubHost(answer: MergeChangeRequestResult, onCall?: () => Promise<void>) {
  return vi.spyOn(github, 'mergeChangeRequest').mockImplementation(async () => {
    await onCall?.();
    return answer;
  });
}

/** A `manual` card with #11 and #12, approved, both queued — and #11 then EJECTED for a
 *  failure, so the card reads `implemented`. */
async function ejectedManual(email: string, reason = 'CI_FAILURE') {
  const s = await makeScenario(email, 'manual');
  const item = await card(s, [11, 12]);
  await ci(11, 'sha-a');
  await ci(12, 'sha-b');
  const [gate] = await awaitingGates(item.id);
  await approvalGatesService.decide({ gateId: gate!.id, decision: 'approve', source: 'ui' }, s.ctx);
  await markQueued(11, 'gate');
  await markQueued(12, 'gate');
  await eject(11, 'sha-a', reason);
  const approved = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate!.id } });
  return { s, item, approved, prId: (await pr(11)).id };
}

const press = (s: Scenario, approvalGateId: string, pullRequestId: string) =>
  pullRequestMergeService.retryApproveAndMergeMember(
    { approvalGateId, pullRequestId, noteMd: null, source: 'ui' },
    s.ctx,
  );

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

describe('manual mode — Queue again on the card’s ONE decided approval', () => {
  it('re-enqueues, stamps the exit, returns the card to approved, and asks nobody anything', async () => {
    const { s, item, approved, prId } = await ejectedManual('manual-ok@example.com');
    expect(await statusOf(item.id)).toBe('implemented');
    const host = stubHost({ outcome: 'enqueued', entryId: 'MQE_2' });
    sent.length = 0;

    const outcome = await press(s, approved.id, prId);

    expect(outcome).toMatchObject({ pullRequestId: prId, outcome: 'enqueued' });
    expect(host).toHaveBeenCalledTimes(1);
    expect(host.mock.calls[0]![0]).toMatchObject({ number: 11, expectedHeadSha: 'sha-a' });
    expect((await pr(11)).mergeOutcomeRef).toBe('queue:MQE_2');
    expect((await latestExit(11)).requeuedAt).not.toBeNull();
    expect(await statusOf(item.id)).toBe('approved');
    // The decided gate is byte-for-byte what it was, and nothing new is asked.
    expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: approved.id } })).toEqual(
      approved,
    );
    expect(await awaitingGates(item.id)).toEqual([]);
    expect(sent.filter((e) => e.name === 'work-item/transitioned')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ fromStatusKey: 'implemented', toStatusKey: 'approved' }),
      }),
    ]);
  });

  it('a neutral exit re-enqueues and leaves the card where it was', async () => {
    const { s, item, approved, prId } = await ejectedManual('manual-neutral@example.com', 'MANUAL');
    expect(await statusOf(item.id)).toBe('approved');
    stubHost({ outcome: 'enqueued', entryId: 'MQE_3' });

    const outcome = await press(s, approved.id, prId);

    expect(outcome).toMatchObject({ outcome: 'enqueued' });
    expect(await statusOf(item.id)).toBe('approved');
    expect((await latestExit(11)).requeuedAt).not.toBeNull();
  });

  it('a moved head is refused, and nothing is claimed and no host is called', async () => {
    const { s, item, approved, prId } = await ejectedManual('manual-moved@example.com');
    const host = stubHost({ outcome: 'enqueued', entryId: 'MQE_4' });
    await ci(11, 'sha-a2');
    // The push re-armed the card with its ONE fresh question.
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingGates(item.id)).toHaveLength(1);

    const outcome = await press(s, approved.id, prId);

    expect(outcome).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'APPROVAL_GATE_SUPERSEDED' },
    });
    expect(host).not.toHaveBeenCalled();
    expect((await latestExit(11)).requeuedAt).toBeNull();
  });

  it('a host refusal releases the claim, so the exit is offered again', async () => {
    const { s, item, approved, prId } = await ejectedManual('manual-refused@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'conflict' } });

    const outcome = await press(s, approved.id, prId);

    expect(outcome).toMatchObject({ outcome: 'refused', refusal: { tag: 'MERGE_CONFLICT' } });
    expect((await latestExit(11)).requeuedAt).toBeNull();
    expect(await statusOf(item.id)).toBe('implemented');
    const members = await pullRequestMergeService.listApprovalMembers(
      { workItemId: item.id, approvalGateId: approved.id },
      s.ctx,
    );
    expect(members.find((m) => m.pullRequestId === prId)).toMatchObject({ requeueable: true });
  });

  it('a host FAULT releases the claim and is rethrown, not dressed as a refusal', async () => {
    const { s, item, approved, prId } = await ejectedManual('manual-fault@example.com');
    vi.spyOn(github, 'mergeChangeRequest').mockRejectedValue(new Error('the host is on fire'));

    await expect(press(s, approved.id, prId)).rejects.toThrow('the host is on fire');
    expect((await latestExit(11)).requeuedAt).toBeNull();
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('a second press on the same exit is refused and enqueues nothing', async () => {
    const { s, approved, prId } = await ejectedManual('manual-twice@example.com');
    const host = stubHost({ outcome: 'enqueued', entryId: 'MQE_5' });

    await press(s, approved.id, prId);
    const second = await press(s, approved.id, prId);

    expect(second).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'MERGE_ALREADY_REQUEUED' },
    });
    expect(host).toHaveBeenCalledTimes(1);
    expect((await pr(11)).mergeOutcomeRef).toBe('queue:MQE_5');
  });

  it('two presses at once enqueue exactly once, and the other is refused', async () => {
    const { s, approved, prId } = await ejectedManual('manual-race@example.com');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const host = stubHost({ outcome: 'enqueued', entryId: 'MQE_6' }, () => gate);

    const both = Promise.all([press(s, approved.id, prId), press(s, approved.id, prId)]);
    // Let both reach their claim before the winner's host call returns.
    await new Promise((r) => setTimeout(r, 200));
    release();
    const outcomes = await both;

    expect(host).toHaveBeenCalledTimes(1);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['enqueued', 'refused']);
    expect(outcomes.find((o) => o.outcome === 'refused')).toMatchObject({
      refusal: { tag: 'MERGE_ALREADY_REQUEUED' },
    });
  });

  it('the auto entry point refuses a manual project', async () => {
    const { s, item, prId } = await ejectedManual('manual-auto-door@example.com');
    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: prId },
        s.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'wrong_mode' });
  });
});

describe('the members read — requeueable only where Queue again is honest', () => {
  it('is true for a standing exit at the approved head, and false otherwise', async () => {
    const { s, item, approved, prId } = await ejectedManual('read@example.com');
    const read = async () =>
      (
        await pullRequestMergeService.listApprovalMembers(
          { workItemId: item.id, approvalGateId: approved.id },
          s.ctx,
        )
      ).find((m) => m.pullRequestId === prId)!;
    const sibling = async () =>
      (
        await pullRequestMergeService.listApprovalMembers(
          { workItemId: item.id, approvalGateId: approved.id },
          s.ctx,
        )
      ).find((m) => m.pullRequestId !== prId)!;

    // A standing failure exit at the head the approval named.
    expect(await read()).toMatchObject({
      requeueable: true,
      retryable: false,
      queued: false,
      exit: { rawReason: 'CI_FAILURE', disposition: 'failure', headSha: 'sha-a', requeuedAt: null },
    });
    // A member the queue never removed.
    expect(await sibling()).toMatchObject({ requeueable: false, exit: null, queued: true });

    // Put back: no longer requeueable.
    await adminDb.githubPullRequestQueueExit.updateMany({
      where: { pullRequestId: prId },
      data: { requeuedAt: new Date() },
    });
    expect(await read()).toMatchObject({ requeueable: false });

    // A fresh exit at a head the approval did not name (the member was pushed).
    await adminDb.githubPullRequestQueueExit.create({
      data: {
        pullRequestId: prId,
        deliveryId: 'g-moved',
        rawReason: 'CI_FAILURE',
        disposition: 'failure',
        headSha: 'sha-other',
        exitedAt: new Date(Date.now() + 1000),
      },
    });
    await ci(11, 'sha-other');
    expect(await read()).toMatchObject({ requeueable: false });
  });
});

describe('auto mode — a person’s Queue again', () => {
  async function ejectedAuto(email: string) {
    const s = await makeScenario(email, 'auto');
    const item = await card(s, [21]);
    await ci(21, 'sha-auto');
    expect(await statusOf(item.id)).toBe('in_review');
    await markQueued(21, 'auto_mode');
    await eject(21, 'sha-auto');
    expect(await statusOf(item.id)).toBe('implemented');
    return { s, item, prId: (await pr(21)).id };
  }

  it('re-dispatches the same head under a NEW key and returns the card to in_review', async () => {
    const { s, item, prId } = await ejectedAuto('auto-ok@example.com');
    const firstKey = `${prId}:sha-auto`;
    expect(sent.some((e) => e.data['idempotencyKey'] === firstKey)).toBe(true);
    const exit = await latestExit(21);
    sent.length = 0;

    const result = await pullRequestMergeService.requeueAutoMember(
      { workItemId: item.id, pullRequestId: prId },
      s.ctx,
    );

    expect(result).toEqual({ pullRequestId: prId, headSha: 'sha-auto', status: 'in_review' });
    const dispatched = sent.filter((e) => e.name === 'pull-request/auto-merge.requested');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.data).toMatchObject({
      pullRequestId: prId,
      headSha: 'sha-auto',
      idempotencyKey: `${prId}:sha-auto:requeue:${exit.id}`,
    });
    expect(dispatched[0]!.data['idempotencyKey']).not.toBe(firstKey);
    expect(await statusOf(item.id)).toBe('in_review');
    expect((await latestExit(21)).requeuedAt).not.toBeNull();
    expect(await awaitingGates(item.id)).toEqual([]);
  });

  it('a second call is refused', async () => {
    const { s, item, prId } = await ejectedAuto('auto-twice@example.com');
    await pullRequestMergeService.requeueAutoMember(
      { workItemId: item.id, pullRequestId: prId },
      s.ctx,
    );

    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: prId },
        s.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateAlreadyRequeuedError);
  });

  it('a moved head is refused', async () => {
    const { s, item, prId } = await ejectedAuto('auto-moved@example.com');
    await ci(21, 'sha-auto-2');

    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: prId },
        s.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'head_moved' });
  });

  it('a caller without work_item:edit is refused', async () => {
    const { s, item, prId } = await ejectedAuto('auto-perm@example.com');
    vi.spyOn(projectAccessService, 'assertPermission').mockRejectedValue(
      new PermissionDeniedError(s.project.id, 'work_item:edit'),
    );

    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: prId },
        s.ctx,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect((await latestExit(21)).requeuedAt).toBeNull();
  });

  it('the gate path refuses an auto project — it has no approval to reuse', async () => {
    const { s, prId } = await ejectedAuto('auto-gate-door@example.com');
    await expect(press(s, 'no-such-gate', prId)).rejects.toBeInstanceOf(ApprovalGateNotFoundError);
  });

  it('an unknown card is not found', async () => {
    const { s, prId } = await ejectedAuto('auto-unknown@example.com');
    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: 'no-such-card', pullRequestId: prId },
        s.ctx,
      ),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('a pull request the card does not deliver is refused', async () => {
    const { s, item } = await ejectedAuto('auto-not-delivered@example.com');
    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: 'no-such-pull-request' },
        s.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'not_delivered' });
  });

  it('a closed pull request is refused, and nothing is claimed', async () => {
    const { s, item, prId } = await ejectedAuto('auto-closed@example.com');
    await adminDb.githubPullRequest.update({ where: { id: prId }, data: { state: 'closed' } });

    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: prId },
        s.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'not_open' });
    expect((await latestExit(21)).requeuedAt).toBeNull();
  });

  it('re-dispatches but leaves a card a person has since moved elsewhere', async () => {
    const { s, item, prId } = await ejectedAuto('auto-moved-card@example.com');
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    sent.length = 0;

    const result = await pullRequestMergeService.requeueAutoMember(
      { workItemId: item.id, pullRequestId: prId },
      s.ctx,
    );

    expect(result).toMatchObject({ status: 'in_progress' });
    expect(await statusOf(item.id)).toBe('in_progress');
    expect(sent.map((e) => e.name)).toEqual(['pull-request/auto-merge.requested']);
  });

  it('the standing-exits read offers Queue again until the head moves or it is put back', async () => {
    const { s, item, prId } = await ejectedAuto('auto-read@example.com');
    const read = () =>
      pullRequestMergeService.listStandingQueueExits({ workItemId: item.id }, s.ctx);

    expect(await read()).toEqual([
      expect.objectContaining({
        pullRequestId: prId,
        repo: 'moooon/acme',
        number: 21,
        requeueable: true,
        exit: expect.objectContaining({
          rawReason: 'CI_FAILURE',
          disposition: 'failure',
          failingCheckName: null,
        }),
      }),
    ]);

    await ci(21, 'sha-auto-2');
    expect(await read()).toEqual([expect.objectContaining({ requeueable: false })]);

    await adminDb.githubPullRequestQueueExit.updateMany({
      where: { pullRequestId: prId },
      data: { requeuedAt: new Date() },
    });
    expect(await read()).toEqual([]);
    expect(
      await pullRequestMergeService.listStandingQueueExits({ workItemId: 'no-such-card' }, s.ctx),
    ).toEqual([]);
  });

  it('the standing-exits read answers nothing for a closed pull request or a manual project', async () => {
    const { s, item, prId } = await ejectedAuto('auto-read-closed@example.com');
    await adminDb.githubPullRequest.update({ where: { id: prId }, data: { state: 'closed' } });
    expect(
      await pullRequestMergeService.listStandingQueueExits({ workItemId: item.id }, s.ctx),
    ).toEqual([]);

    const manual = await ejectedManual('manual-read@example.com');
    expect(
      await pullRequestMergeService.listStandingQueueExits(
        { workItemId: manual.item.id },
        manual.s.ctx,
      ),
    ).toEqual([]);
  });

  it('a pull request with no standing exit is refused', async () => {
    const s = await makeScenario('auto-no-exit@example.com', 'auto');
    const item = await card(s, [22]);
    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: (await pr(22)).id },
        s.ctx,
      ),
    ).rejects.toBeInstanceOf(QueueAgainRefusedError);
  });
});
