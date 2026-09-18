import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
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
      { stamp: DECIDED_WITHOUT_A_READER, gateId: approval.id, source: 'ui' },
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

    await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: approval.id, source: 'ui' },
      fx.ctx,
    );

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
      { stamp: DECIDED_WITHOUT_A_READER, gateId: approval.id, source: 'ui' },
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
      { stamp: DECIDED_WITHOUT_A_READER, gateId: approval.id, source: 'ui' },
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
      { stamp: DECIDED_WITHOUT_A_READER, gateId: approval.id, source: 'ui' },
      fx.ctx,
    );

    expect(result.members.map((m) => [m.subjectVersion, m.outcome])).toEqual([
      [api.version, 'merged'],
      [web.version, 'no_merge_gate'],
    ]);
    expect(seam).toHaveBeenCalledTimes(1);
  });

  it('a member the card NO LONGER DELIVERS reports `no_merge_gate`, and is never sent to the host', async () => {
    const { approval, web, api } = await pressable();
    // #7 is unlinked AFTER the approval committed — while the host is merging #12, which the
    // canonical order presses first. The approval no longer covers a pull request the card
    // does not deliver.
    const seam = stubHost({ 12: { outcome: 'merged', commitSha: 'merge-api' } }, async () => {
      await adminDb.workItemDelivery.deleteMany({ where: { githubPullRequestId: web.prId } });
    });

    const result = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: approval.id, source: 'ui' },
      fx.ctx,
    );

    expect(result.approval.gate.state).toBe('approved');
    expect(result.members.map((m) => [m.subjectVersion, m.outcome, m.pullRequestId])).toEqual([
      [api.version, 'merged', api.prId],
      [web.version, 'no_merge_gate', null],
    ]);
    expect(seam).toHaveBeenCalledTimes(1);
    expect(await prRecord(web.prId)).toEqual({ mergeAuthority: null, mergeOutcomeRef: null });
  });

  it('RETRY merges only that member, under the approval that already stands', async () => {
    const { item, approval, web, api } = await pressable();
    stubHost({
      7: { outcome: 'merged', commitSha: 'merge-web' },
      12: { outcome: 'refused', refusal: { code: 'checks_not_green' } },
    });
    await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: approval.id, source: 'ui' },
      fx.ctx,
    );
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
      pullRequestMergeService.approveAndMerge(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: approval.id, source: 'ui' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateSupersededError);
    expect(seam).not.toHaveBeenCalled();
  });

  it('an ALREADY-DECIDED approval gate is refused, and nothing is merged', async () => {
    const { approval } = await pressable();
    await approvalGatesService.decide(
      {
        stamp: DECIDED_WITHOUT_A_READER,
        gateId: approval.id,
        decision: 'request_changes',
        source: 'ui',
      },
      fx.ctx,
    );
    const seam = vi.spyOn(github, 'mergeChangeRequest');

    await expect(
      pullRequestMergeService.approveAndMerge(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: approval.id, source: 'ui' },
        fx.ctx,
      ),
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
    await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: approval.id, source: 'ui' },
      fx.ctx,
    );

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
    await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: approval.id, source: 'ui' },
      fx.ctx,
    );
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

describe('the QUICK VIEW reads the same member facts (Bug MOTIR-5650)', () => {
  const peek = (identifier: string) =>
    workItemsService.getQuickView(fx.projectId, identifier, 'open', fx.ctx, 'en');

  it('carries the approved gate’s members — the facts the item page’s frame reads', async () => {
    const { item, approval, web, api } = await pressable();
    stubHost({
      7: { outcome: 'enqueued', entryId: 'MQE_11' },
      12: { outcome: 'refused', refusal: { code: 'conflict' } },
    });
    await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: approval.id, source: 'ui' },
      fx.ctx,
    );

    const view = await peek(item.identifier);
    expect(view.mergeMembers).toEqual([
      // No merge-queue exit on either (MOTIR-5634 / MOTIR-5635 carry it on the same read).
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
    expect(view.mergeMembers).toEqual(
      await pullRequestMergeService.listApprovalMembers(
        { workItemId: item.id, approvalGateId: approval.id },
        fx.ctx,
      ),
    );
  });

  it('carries none while the gate still awaits', async () => {
    const { item } = await pressable();
    expect((await peek(item.identifier)).mergeMembers).toEqual([]);
  });

  it('carries none — and reads no gate — for a card with no linked pull request', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Nothing delivered yet' },
      fx.ctx,
    );
    const spy = vi.spyOn(approvalGateRepository, 'findLatestByWorkItem');
    expect((await peek(item.identifier)).mergeMembers).toEqual([]);
    expect(spy.mock.calls.filter(([, kind]) => kind === 'pull_request_approval')).toEqual([]);
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
      { stamp: DECIDED_WITHOUT_A_READER, gateId: fixture.approval.id, source: 'ui' },
      fx.ctx,
    );
    vi.restoreAllMocks();
    return fixture;
  };

  it('approveAndMerge handed a gate of another KIND is a programming error, and decides nothing', async () => {
    const { item } = await pressable();
    // ⚠️ `decision_approval`, not `design_result` — MOTIR-5664 ADMITS the design kind
    // by name, because pressing the primary design gate is what merges the set. The
    // guard is still the guard: a kind it does not know is still a programming error.
    const foreign = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: 'decision_approval',
        subjectId: 'ev-1',
      },
    });
    await expect(
      pullRequestMergeService.approveAndMerge(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: foreign.id, source: 'ui' },
        fx.ctx,
      ),
    ).rejects.toThrow(/handed a decision_approval gate/);
    expect((await gateRow(foreign.id)).state).toBe('awaiting');
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
    await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: approval.id, source: 'ui' },
      fx.ctx,
    );
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

describe('MOTIR-5664 — ONE APPROVAL, TWO GATES: pressing the PRIMARY design gate merges the set', () => {
  // Yue's sentence, quoted in `design-result.md` AMENDMENT 4 Q8 and built here:
  // "if there's linked PR, the PR and the design should show together in one section
  // … because they become one gate, approve the design will merge the PR too."
  //
  // The cards before this one arrange for both gates to exist with the design
  // primary. Without this one, pressing the primary records an opinion and leaves
  // the pull requests sitting there with nobody having merged them — a worse state
  // than the bug being fixed, because the surface would now claim to have asked and
  // been answered.

  /** Give a pressable card a CURRENT design result and an awaiting design gate. */
  async function withDesignGate(item: { id: string }) {
    const evidence = await adminDb.designEvidence.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: item.id,
        commitSha: HEAD_WEB,
        isCurrent: true,
      },
    });
    const gate = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: item.id,
          kind: 'design_result',
          subjectId: evidence.id,
          subjectVersion: evidence.commitSha,
        },
        tx,
      ),
    );
    return { evidence, gate };
  }

  it('decides BOTH gates — one actor, one instant — and merges every member', async () => {
    const { item, approval, web, api } = await pressable();
    const { gate: design } = await withDesignGate(item);
    const host = stubHost({
      7: { outcome: 'merged', commitSha: 'merge-web' },
      12: { outcome: 'merged', commitSha: 'merge-api' },
    });

    const result = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: design.id, source: 'ui' },
      fx.ctx,
    );

    const [designRow, mergeRow] = await Promise.all([gateRow(design.id), gateRow(approval.id)]);
    expect(designRow.state).toBe('approved');
    expect(mergeRow.state).toBe('approved');
    // ONE person's decision at ONE instant — §8's amendment, decision 5(c), the
    // option the approve-and-merge press already uses for exactly this.
    expect(mergeRow.decidedById).toBe(designRow.decidedById);
    expect(mergeRow.decidedAt?.toISOString()).toBe(designRow.decidedAt?.toISOString());

    expect(host).toHaveBeenCalledTimes(2);
    expect(result.members.map((m) => m.outcome)).toEqual(['merged', 'merged']);
    // Each outcome on its OWN pull request — where it has lived since MOTIR-5613.
    expect((await prRecord(web.prId)).mergeOutcomeRef).not.toBeNull();
    expect((await prRecord(api.prId)).mergeOutcomeRef).not.toBeNull();
  });

  it('a member the host REFUSES is reported, not silently skipped, and the approval stands', async () => {
    // MOTIR-5604's finding: a card going quiet is worse than a card saying no.
    const { item, approval } = await pressable();
    const { gate: design } = await withDesignGate(item);
    const host = vi.spyOn(github, 'mergeChangeRequest').mockImplementation(async (args) => {
      if (args.number === 12)
        throw new MergeChangeRequestError('the host is behind', 'unexpected_status');
      return { outcome: 'merged', commitSha: 'merge-web' };
    });

    const result = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: design.id, source: 'ui' },
      fx.ctx,
    );

    expect(host).toHaveBeenCalledTimes(2);
    expect(result.members.map((m) => m.outcome).sort()).toEqual(['merged', 'refused']);
    expect((await gateRow(approval.id)).state).toBe('approved');
    expect((await gateRow(design.id)).state).toBe('approved');
  });

  it('with NO merge gate the design decision STANDS and the merge is HELD (AMENDMENT 6 Q4)', async () => {
    // The design gate rises on PUBLISH and the merge gate on GREEN, so the primary
    // can be pressed before CI has spoken. Q4: "the decision stands and the merge
    // follows on the next green verdict, with no second press." Refusing the press
    // would leave a card with a question on it that cannot be answered, which is the
    // silent stall MOTIR-5652 was filed about, arriving through a door built on purpose.
    const { item, approval } = await pressable();
    await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.supersedeAwaitingByWorkItem(
        item.id,
        'pull_request_approval',
        'head_moved',
        tx,
      ),
    );
    const { gate: design } = await withDesignGate(item);
    const host = stubHost({ 7: { outcome: 'merged', commitSha: 'merge-web' } });

    const result = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: design.id, source: 'ui' },
      fx.ctx,
    );

    expect((await gateRow(design.id)).state).toBe('approved');
    expect(result.members).toEqual([]);
    expect(host).not.toHaveBeenCalled();
    // The withdrawn merge gate is untouched: the press answered the design question,
    // and the commits are answered by `settleGreenVerdict` on the next green.
    expect((await gateRow(approval.id)).state).toBe('superseded');
  });

  it('a card with NO pull request still writes `done` and merges nothing — today’s behaviour', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'A design nobody delivers' },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
    const { gate: design } = await withDesignGate(item);
    const host = stubHost({});

    const result = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: design.id, source: 'ui' },
      fx.ctx,
    );

    expect((await gateRow(design.id)).state).toBe('approved');
    expect(result.members).toEqual([]);
    expect(host).not.toHaveBeenCalled();
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'done',
    );
  });

  // Bug MOTIR-5712 — THE SAME PRESS THROUGH THE OTHER DOORS. The To-approve queue now
  // lists such a card by its design gate ONLY, and its row opens the overlay, whose
  // design port presses through `decideGate` (as does the REST decide route). Before
  // this, `decideGate` handed a design approve to the plain door: the design was
  // decided, the merge gate stayed awaiting, and it came back as a second question.
  it('decideGate on the design gate is the SAME press — both gates decided, every member merged', async () => {
    const { item, approval } = await pressable();
    const { gate: design } = await withDesignGate(item);
    const host = stubHost({
      7: { outcome: 'merged', commitSha: 'merge-web' },
      12: { outcome: 'merged', commitSha: 'merge-api' },
    });

    const result = await pullRequestMergeService.decideGate(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: design.id, decision: 'approve', source: 'api' },
      fx.ctx,
    );

    expect(result.gate.id).toBe(design.id);
    expect((await gateRow(design.id)).state).toBe('approved');
    expect((await gateRow(approval.id)).state).toBe('approved');
    expect(host).toHaveBeenCalledTimes(2);
    expect(result.members.map((m) => m.outcome)).toEqual(['merged', 'merged']);
  });

  it('decideGate on a design gate with NO merge gate beside it decides the design alone, as before', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'A design nobody delivers' },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
    const { gate: design } = await withDesignGate(item);
    const host = stubHost({});

    const result = await pullRequestMergeService.decideGate(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: design.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    expect((await gateRow(design.id)).state).toBe('approved');
    expect(result.members).toEqual([]);
    expect(host).not.toHaveBeenCalled();
  });

  it('decideGate REQUEST CHANGES on the design gate decides only the design — nothing is merged', async () => {
    const { item, approval } = await pressable();
    const { gate: design } = await withDesignGate(item);
    const host = stubHost({});

    const result = await pullRequestMergeService.decideGate(
      {
        stamp: DECIDED_WITHOUT_A_READER,
        gateId: design.id,
        decision: 'request_changes',
        noteMd: 'The empty state is missing.',
        source: 'ui',
      },
      fx.ctx,
    );

    expect((await gateRow(design.id)).state).toBe('changes_requested');
    expect((await gateRow(approval.id)).state).toBe('awaiting');
    expect(result.members).toEqual([]);
    expect(host).not.toHaveBeenCalled();
  });
});
