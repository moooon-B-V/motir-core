import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { MergeChangeRequestError } from '@/lib/git/errors';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { MergeChangeRequestResult } from '@/lib/git/types';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateNotFoundError,
  ApprovalGateSupersededError,
} from '@/lib/approvalGates/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// APPROVE AND MERGE (Story MOTIR-4909 · MOTIR-5483 · MOTIR-5613; `approval-gates.md` §8's
// SECOND AMENDMENT, decisions 1 and 4), against a REAL Postgres.
//
// ⚠️ ONE GATE PER CARD. A press decides the card's `pull_request_approval` gate and then
// merges every member; each member's outcome is recorded on ITS OWN PULL REQUEST, and no
// `pull_request_merge` row exists anywhere in this file. A retry addresses
// (the card's gate, one pull request). The host is the seam's `mergeChangeRequest`, stubbed
// per pull request — the one thing that leaves the process. The properties under test are the
// ORDER (the approval commits before any merge), the RECORD (one actor, one source, one
// instant across every row a press writes) and PARTIAL SUCCESS (a refused member leaves the
// approval and the other member standing).

const HEAD_WEB = '9840d00ea1b2c3d4e5f60718293a4b5c6d7e8f90';
const HEAD_API = '1111111111111111111111111111111111111111';
const github = getGitProvider('github') as Required<GitProvider>;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

/** A story in review whose run delivered `acme/web#7` and `acme/api#12`, both green, holding
 *  the card's ONE approve-and-merge gate over the set. */
async function pressable() {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Throttle the public API' },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);

  const members: Record<number, { prId: string; version: string }> = {};
  for (const [name, number, head] of [
    ['web', 7, HEAD_WEB],
    ['api', 12, HEAD_API],
  ] as const) {
    seq += 1;
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: `inst-5483-${seq}`,
        accountLogin: 'acme',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await adminDb.githubRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        installationId: installation.id,
        repoId: `repo-5483-${seq}`,
        owner: 'acme',
        name,
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number,
        title: `Change in ${name}`,
        state: 'open',
        headRef: 'parent/ACME-12-throttle',
        baseRef: 'main',
        provider: 'github',
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: item.id,
        githubPullRequestId: pr.id,
        repoId: repo.id,
      },
    });
    await adminDb.githubCheckRun.create({
      data: { pullRequestId: pr.id, commitSha: head, checkName: 'Vitest', conclusion: 'success' },
    });
    members[number] = { prId: pr.id, version: `acme/${name}#${number}@${head}` };
  }

  const approval = await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: 'pull_request_approval',
        subjectId: item.id,
        subjectVersion: `${members[12]!.version},${members[7]!.version}`,
      },
      tx,
    ),
  );
  return { item, approval, web: members[7]!, api: members[12]! };
}

/** Answer the seam per pull request number. */
function stubHost(answers: Record<number, MergeChangeRequestResult>, onCall?: () => Promise<void>) {
  return vi.spyOn(github, 'mergeChangeRequest').mockImplementation(async (args) => {
    await onCall?.();
    return answers[args.number]!;
  });
}

const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });
/** What a merge leaves on the PULL REQUEST — where the outcome lives since MOTIR-5613. */
const prRecord = async (id: string) => {
  const { mergeAuthority, mergeOutcomeRef } = await adminDb.githubPullRequest.findUniqueOrThrow({
    where: { id },
  });
  return { mergeAuthority, mergeOutcomeRef };
};
const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

describe('one press: the approval, then every member', () => {
  it('decides the card’s ONE gate and merges both members — the decision on the gate, each outcome on its pull request', async () => {
    const { item, approval, web, api } = await pressable();
    stubHost({
      7: { outcome: 'merged', commitSha: 'merge-web' },
      12: { outcome: 'merged', commitSha: 'merge-api' },
    });

    const result = await pullRequestMergeService.approveAndMerge(
      { gateId: approval.id, source: 'ui' },
      fx.ctx,
    );

    expect(result.approval.gate.state).toBe('approved');
    expect(await statusOf(item.id)).toBe('approved');
    // In the approval's canonical order — `acme/api` before `acme/web`.
    expect(result.members.map((m) => [m.subjectVersion, m.outcome])).toEqual([
      [api.version, 'merged'],
      [web.version, 'merged'],
    ]);

    // ONE gate, decided once, by one actor from one source.
    const gates = await adminDb.approvalGate.findMany({ where: { workItemId: item.id } });
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      id: approval.id,
      kind: 'pull_request_approval',
      state: 'approved',
      decidedById: fx.ownerId,
      decisionSource: 'ui',
    });
    // …and each member's result on the row that owns it.
    expect(await prRecord(web.prId)).toEqual({
      mergeAuthority: 'gate',
      mergeOutcomeRef: 'merge-web',
    });
    expect(await prRecord(api.prId)).toEqual({
      mergeAuthority: 'gate',
      mergeOutcomeRef: 'merge-api',
    });
  });

  it('calls the host only AFTER the approval has committed — read from another connection', async () => {
    const { item, approval } = await pressable();
    const seenAtMerge: Array<{ gate: string; card: string }> = [];
    stubHost(
      {
        7: { outcome: 'merged', commitSha: 'merge-web' },
        12: { outcome: 'merged', commitSha: 'merge-api' },
      },
      async () => {
        seenAtMerge.push({
          gate: (await gateRow(approval.id)).state,
          card: await statusOf(item.id),
        });
      },
    );

    await pullRequestMergeService.approveAndMerge({ gateId: approval.id, source: 'ui' }, fx.ctx);

    expect(seenAtMerge).toEqual([
      { gate: 'approved', card: 'approved' },
      { gate: 'approved', card: 'approved' },
    ]);
  });

  it('a member whose repository has a merge queue is ENQUEUED: the queue entry rides the pull request, card still approved', async () => {
    const { item, approval, api } = await pressable();
    stubHost({
      7: { outcome: 'merged', commitSha: 'merge-web' },
      12: { outcome: 'enqueued', entryId: 'MQE_7' },
    });

    const result = await pullRequestMergeService.approveAndMerge(
      { gateId: approval.id, source: 'ui' },
      fx.ctx,
    );

    expect(result.members.find((m) => m.subjectVersion === api.version)?.outcome).toBe('enqueued');
    // The gate's outcome is the STATUS the approval moved the card to — a merge, or a
    // queue entry, writes nothing onto the gate.
    expect((await gateRow(approval.id)).outcomeRef).toBe('approved');
    const pr = await adminDb.githubPullRequest.findUniqueOrThrow({ where: { id: api.prId } });
    expect(pr.mergeOutcomeRef).toBe('queue:MQE_7');
    expect(await statusOf(item.id)).toBe('approved');
  });
});

describe('partial success', () => {
  it('a REFUSED member leaves the approval, the card and the other member standing, and names its refusal', async () => {
    const { item, approval, web, api } = await pressable();
    stubHost({
      7: { outcome: 'merged', commitSha: 'merge-web' },
      12: { outcome: 'refused', refusal: { code: 'conflict' } },
    });

    const result = await pullRequestMergeService.approveAndMerge(
      { gateId: approval.id, source: 'ui' },
      fx.ctx,
    );

    expect(result.members).toEqual([
      {
        subjectVersion: api.version,
        pullRequestId: api.prId,
        outcome: 'refused',
        refusal: { tag: 'MERGE_CONFLICT' },
      },
      { subjectVersion: web.version, pullRequestId: web.prId, outcome: 'merged' },
    ]);
    // ⚠️ THE APPROVAL IS NOT UNDONE BY A REFUSED MERGE, and the refusal is recorded
    // NOWHERE: the refused pull request simply has no outcome yet, which is what makes it
    // retryable.
    expect((await gateRow(approval.id)).state).toBe('approved');
    expect(await statusOf(item.id)).toBe('approved');
    expect(await prRecord(api.prId)).toEqual({ mergeAuthority: null, mergeOutcomeRef: null });
    expect(await prRecord(web.prId)).toEqual({
      mergeAuthority: 'gate',
      mergeOutcomeRef: 'merge-web',
    });
  });

  it('a member the card can no longer merge reports `no_merge_gate`, and the other still merges', async () => {
    const { approval, web, api } = await pressable();
    // #7 was closed by hand before the press: it is still a member of what was approved,
    // and there is nothing left to merge.
    await adminDb.githubPullRequest.update({
      where: { id: web.prId },
      data: { state: 'closed' },
    });
    const seam = stubHost({ 12: { outcome: 'merged', commitSha: 'merge-api' } });

    const result = await pullRequestMergeService.approveAndMerge(
      { gateId: approval.id, source: 'ui' },
      fx.ctx,
    );

    expect(result.members.map((m) => [m.subjectVersion, m.outcome])).toEqual([
      [api.version, 'merged'],
      [web.version, 'no_merge_gate'],
    ]);
    expect(seam).toHaveBeenCalledTimes(1);
  });

  it('RETRY merges only that member, under the approval that already stands', async () => {
    const { item, approval, web, api } = await pressable();
    stubHost({
      7: { outcome: 'merged', commitSha: 'merge-web' },
      12: { outcome: 'refused', refusal: { code: 'checks_not_green' } },
    });
    await pullRequestMergeService.approveAndMerge({ gateId: approval.id, source: 'ui' }, fx.ctx);
    const decidedAt = (await gateRow(approval.id)).decidedAt!.toISOString();
    vi.restoreAllMocks();
    const seam = stubHost({ 12: { outcome: 'merged', commitSha: 'merge-api' } });

    const retried = await pullRequestMergeService.retryApproveAndMergeMember(
      { approvalGateId: approval.id, pullRequestId: api.prId, source: 'ui' },
      fx.ctx,
    );

    expect(retried).toEqual({
      subjectVersion: api.version,
      pullRequestId: api.prId,
      outcome: 'merged',
    });
    // ONLY that one: one host call, and the sibling's record is the first press's.
    expect(seam).toHaveBeenCalledTimes(1);
    expect(await prRecord(api.prId)).toEqual({
      mergeAuthority: 'gate',
      mergeOutcomeRef: 'merge-api',
    });
    expect(await prRecord(web.prId)).toEqual({
      mergeAuthority: 'gate',
      mergeOutcomeRef: 'merge-web',
    });
    // ⚠️ AND NOTHING WAS DECIDED AGAIN: the card's one gate still carries the instant of
    // the original press, and there is still exactly one of it.
    const gates = await adminDb.approvalGate.findMany({ where: { workItemId: item.id } });
    expect(gates).toHaveLength(1);
    expect(gates[0]!.decidedAt?.toISOString()).toBe(decidedAt);
  });
});

describe('the door’s refusals end the press before any host is called', () => {
  it('a SUPERSEDED approval gate is refused, and nothing is merged', async () => {
    const { approval } = await pressable();
    await adminDb.approvalGate.update({
      where: { id: approval.id },
      data: { state: 'superseded' },
    });
    const seam = vi.spyOn(github, 'mergeChangeRequest');

    await expect(
      pullRequestMergeService.approveAndMerge({ gateId: approval.id, source: 'ui' }, fx.ctx),
    ).rejects.toBeInstanceOf(ApprovalGateSupersededError);
    expect(seam).not.toHaveBeenCalled();
  });

  it('an ALREADY-DECIDED approval gate is refused, and nothing is merged', async () => {
    const { approval } = await pressable();
    await approvalGatesService.decide(
      { gateId: approval.id, decision: 'request_changes', source: 'ui' },
      fx.ctx,
    );
    const seam = vi.spyOn(github, 'mergeChangeRequest');

    await expect(
      pullRequestMergeService.approveAndMerge({ gateId: approval.id, source: 'ui' }, fx.ctx),
    ).rejects.toBeInstanceOf(ApprovalGateAlreadyDecidedError);
    expect(seam).not.toHaveBeenCalled();
  });
});

describe('boundaries', () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

  it('the supplied-`decidedAt` input is reachable from neither the decide route nor the server action', () => {
    for (const rel of [
      'app/api/approval-gates/[id]/decide/route.ts',
      'app/(authed)/items/[key]/approvalGateActions.ts',
    ]) {
      expect(read(rel), rel).not.toMatch(/decidedAt/);
    }
    // And the wire input the door takes carries no such field.
    const inputType = /export interface DecideGateInput \{[\s\S]*?\n\}/.exec(
      read('lib/services/approvalGatesService.ts'),
    )?.[0];
    expect(inputType).toBeDefined();
    expect(inputType).not.toMatch(/decidedAt/);
  });

  it('the press names no Git host implementation and no App credential', () => {
    for (const rel of [
      'lib/services/pullRequestMergeService.ts',
      'lib/services/approvalGatesService.ts',
    ]) {
      const code = read(rel);
      expect(code, rel).not.toMatch(/from '@\/lib\/git\/providers\//);
      expect(code, rel).not.toMatch(/from '@\/lib\/github\/appAuth'/);
    }
  });
});

describe('the members read — what a reload still knows (MOTIR-5484)', () => {
  it('reads a queued member as queued, and a refused one as retryable — with no reason', async () => {
    const { item, approval, web, api } = await pressable();
    stubHost({
      7: { outcome: 'enqueued', entryId: 'MQE_9' },
      12: { outcome: 'refused', refusal: { code: 'conflict' } },
    });
    await pullRequestMergeService.approveAndMerge({ gateId: approval.id, source: 'ui' }, fx.ctx);

    const members = await pullRequestMergeService.listApprovalMembers(
      { workItemId: item.id, approvalGateId: approval.id },
      fx.ctx,
    );
    // In the set's own order, and nothing a refusal said survives into the read.
    expect(members).toEqual([
      {
        subjectVersion: api.version,
        pullRequestId: api.prId,
        queued: false,
        retryable: true,
        exit: null,
        requeueable: false,
      },
      {
        subjectVersion: web.version,
        pullRequestId: web.prId,
        queued: true,
        retryable: false,
        exit: null,
        requeueable: false,
      },
    ]);
  });

  it('stops reading a member as queued once its pull request has merged', async () => {
    const { item, approval, web } = await pressable();
    stubHost({
      7: { outcome: 'enqueued', entryId: 'MQE_10' },
      12: { outcome: 'merged', commitSha: 'merge-api' },
    });
    await pullRequestMergeService.approveAndMerge({ gateId: approval.id, source: 'ui' }, fx.ctx);
    await adminDb.githubPullRequest.update({
      where: { id: web.prId },
      data: { merged: true, state: 'closed' },
    });

    const members = await pullRequestMergeService.listApprovalMembers(
      { workItemId: item.id, approvalGateId: approval.id },
      fx.ctx,
    );
    // Merged is not retryable either: there is nothing left to try.
    expect(members.map((m) => [m.queued, m.retryable])).toEqual([
      [false, false],
      [false, false],
    ]);
  });

  it('is empty for an approval gate that has not been approved', async () => {
    const { item, approval } = await pressable();
    expect(
      await pullRequestMergeService.listApprovalMembers(
        { workItemId: item.id, approvalGateId: approval.id },
        fx.ctx,
      ),
    ).toEqual([]);
  });
});

describe('the press and its retry refuse what they were not handed (MOTIR-5486 coverage floor)', () => {
  const pressed = async () => {
    const fixture = await pressable();
    stubHost({
      7: { outcome: 'merged', commitSha: 'merge-web' },
      12: { outcome: 'merged', commitSha: 'merge-api' },
    });
    await pullRequestMergeService.approveAndMerge(
      { gateId: fixture.approval.id, source: 'ui' },
      fx.ctx,
    );
    vi.restoreAllMocks();
    return fixture;
  };

  it('approveAndMerge handed a gate of another KIND is a programming error, and decides nothing', async () => {
    const { item } = await pressable();
    const design = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: 'design_result',
        subjectId: 'ev-1',
      },
    });
    await expect(
      pullRequestMergeService.approveAndMerge({ gateId: design.id, source: 'ui' }, fx.ctx),
    ).rejects.toThrow(/handed a design_result gate/);
    expect((await gateRow(design.id)).state).toBe('awaiting');
  });

  it('a retry it cannot act on is refused with the door’s own errors — unknown, undecided, not a member', async () => {
    const { approval, api } = await pressable();
    const retry = (approvalGateId: string, pullRequestId: string) =>
      pullRequestMergeService.retryApproveAndMergeMember(
        { approvalGateId, pullRequestId, source: 'ui' },
        fx.ctx,
      );
    // The approval still awaits: there is no press to retry a member of.
    await expect(retry(approval.id, api.prId)).rejects.toBeInstanceOf(ApprovalGateNotFoundError);
    await expect(retry('no-such-gate', api.prId)).rejects.toBeInstanceOf(ApprovalGateNotFoundError);

    const other = await pressed();
    // A pull request that is not this card's, and one that does not exist at all: the
    // approval covers neither, and neither is a reason to re-ask it.
    await expect(retry(other.approval.id, api.prId)).rejects.toBeInstanceOf(
      ApprovalGateSupersededError,
    );
    await expect(retry(other.approval.id, 'no-such-pull-request')).rejects.toBeInstanceOf(
      ApprovalGateSupersededError,
    );
    expect((await gateRow(other.approval.id)).state).toBe('approved');
  });

  it('a retried member with no recorded head is a withdrawn question, reported as nothing to merge', async () => {
    const { approval, web } = await pressed();
    // Every check row for #7 disappears, so the pull request has no head to compare.
    await adminDb.githubCheckRun.deleteMany({ where: { pullRequestId: web.prId } });

    const member = await pullRequestMergeService.retryApproveAndMergeMember(
      { approvalGateId: approval.id, pullRequestId: web.prId, source: 'ui' },
      fx.ctx,
    );
    expect(member).toEqual({
      subjectVersion: web.version,
      pullRequestId: null,
      outcome: 'no_merge_gate',
    });
  });

  it.each([
    [
      'an already-decided gate names its decider',
      () => new ApprovalGateAlreadyDecidedError('g', 'approved', 'u', new Date(), 'Ada L.'),
      { tag: 'APPROVAL_GATE_ALREADY_DECIDED', decidedByLabel: 'Ada L.' },
    ],
    [
      'a missing permission is not authorised',
      () => new PermissionDeniedError('p', 'approval:decide_any'),
      { tag: 'APPROVAL_GATE_NOT_AUTHORISED' },
    ],
    [
      'a project out of reach is not found',
      () => new ProjectNotFoundError('p'),
      { tag: 'APPROVAL_GATE_NOT_FOUND' },
    ],
    [
      'a host that did not answer is unexpected',
      () => new MergeChangeRequestError('github', 'timeout'),
      { tag: 'UNEXPECTED' },
    ],
  ])('a member refusal maps into the frame’s vocabulary: %s', async (_label, error, refusal) => {
    const { approval, api } = await pressed();
    // The check's own first call — every refusal below is raised before a host is named.
    vi.spyOn(projectAccessService, 'assertPermission').mockRejectedValue(error());

    const member = await pullRequestMergeService.retryApproveAndMergeMember(
      { approvalGateId: approval.id, pullRequestId: api.prId, source: 'ui' },
      fx.ctx,
    );
    expect(member).toMatchObject({ outcome: 'refused', refusal });
  });

  it('an error that is not a refusal of the member is rethrown, not swallowed', async () => {
    const { approval, api } = await pressed();
    vi.spyOn(projectAccessService, 'assertPermission').mockRejectedValue(
      new Error('the database fell over'),
    );

    await expect(
      pullRequestMergeService.retryApproveAndMergeMember(
        { approvalGateId: approval.id, pullRequestId: api.prId, source: 'ui' },
        fx.ctx,
      ),
    ).rejects.toThrow('the database fell over');
  });

  it('the members read: a member whose PULL REQUEST is gone is neither queued nor retryable', async () => {
    const { item, approval, web, api } = await pressable();
    stubHost({
      7: { outcome: 'merged', commitSha: 'merge-web' },
      12: { outcome: 'enqueued', entryId: 'MQE_11' },
    });
    await pullRequestMergeService.approveAndMerge({ gateId: approval.id, source: 'ui' }, fx.ctx);
    // #12's pull request row disappears after it was queued.
    await adminDb.workItemDelivery.deleteMany({ where: { githubPullRequestId: api.prId } });
    await adminDb.githubPullRequest.delete({ where: { id: api.prId } });

    const members = await pullRequestMergeService.listApprovalMembers(
      { workItemId: item.id, approvalGateId: approval.id },
      fx.ctx,
    );
    // The member the approval named is still listed — the set is what was approved, not
    // what survives — but there is nothing to say about it and nothing to press.
    expect(members).toEqual([
      {
        subjectVersion: api.version,
        pullRequestId: null,
        queued: false,
        retryable: false,
        exit: null,
        requeueable: false,
      },
      {
        subjectVersion: web.version,
        pullRequestId: web.prId,
        queued: false,
        retryable: false,
        exit: null,
        requeueable: false,
      },
    ]);
  });
});
