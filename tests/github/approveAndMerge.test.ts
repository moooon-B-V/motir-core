import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { MergeChangeRequestResult } from '@/lib/git/types';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateSupersededError,
} from '@/lib/approvalGates/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// APPROVE AND MERGE (Story MOTIR-4909 · MOTIR-5483; `approval-gates.md` §8's amendment,
// decision 5), against a REAL Postgres. The host is the seam's `mergeChangeRequest`, stubbed
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
 *  the approve-and-merge gate over the set and one merge gate per pull request. */
async function pressable() {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Throttle the public API' },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);

  const members: Record<number, { prId: string; mergeGateId: string; version: string }> = {};
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
    const version = `acme/${name}#${number}@${head}`;
    const mergeGate = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: item.id,
          kind: 'pull_request_merge',
          subjectId: pr.id,
          subjectVersion: version,
        },
        tx,
      ),
    );
    members[number] = { prId: pr.id, mergeGateId: mergeGate.id, version };
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
const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

describe('one press: the approval, then every member', () => {
  it('decides the approval and both merge gates as ONE decision — same actor, source and instant', async () => {
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

    const rows = await Promise.all([approval.id, web.mergeGateId, api.mergeGateId].map(gateRow));
    expect(rows.map((r) => r.state)).toEqual(['approved', 'approved', 'approved']);
    expect(new Set(rows.map((r) => r.decidedById))).toEqual(new Set([fx.ownerId]));
    expect(new Set(rows.map((r) => r.decisionSource))).toEqual(new Set(['ui']));
    expect(new Set(rows.map((r) => r.decidedAt?.toISOString()))).toEqual(
      new Set([rows[0]!.decidedAt!.toISOString()]),
    );
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

  it('a member whose repository has a merge queue is ENQUEUED: gate outcome null, queue entry on the pull request, card still approved', async () => {
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
    expect((await gateRow(api.mergeGateId)).outcomeRef).toBeNull();
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
        mergeGateId: api.mergeGateId,
        pullRequestId: api.prId,
        outcome: 'refused',
        refusal: { tag: 'MERGE_CONFLICT' },
      },
      {
        subjectVersion: web.version,
        mergeGateId: web.mergeGateId,
        pullRequestId: web.prId,
        outcome: 'merged',
      },
    ]);
    expect((await gateRow(approval.id)).state).toBe('approved');
    expect(await statusOf(item.id)).toBe('approved');
    expect((await gateRow(api.mergeGateId)).state).toBe('awaiting');
    expect((await gateRow(web.mergeGateId)).state).toBe('approved');
  });

  it('a member with NO awaiting merge gate reports `no_merge_gate`, and the other still merges', async () => {
    const { approval, web, api } = await pressable();
    await adminDb.approvalGate.update({
      where: { id: web.mergeGateId },
      data: { state: 'superseded' },
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

  it('RETRY decides only that member’s merge gate, at the press’s instant', async () => {
    const { approval, web, api } = await pressable();
    stubHost({
      7: { outcome: 'merged', commitSha: 'merge-web' },
      12: { outcome: 'refused', refusal: { code: 'checks_not_green' } },
    });
    await pullRequestMergeService.approveAndMerge({ gateId: approval.id, source: 'ui' }, fx.ctx);
    vi.restoreAllMocks();
    const seam = stubHost({ 12: { outcome: 'merged', commitSha: 'merge-api' } });

    const retried = await pullRequestMergeService.retryApproveAndMergeMember(
      { approvalGateId: approval.id, mergeGateId: api.mergeGateId, source: 'ui' },
      fx.ctx,
    );

    expect(retried).toMatchObject({ mergeGateId: api.mergeGateId, outcome: 'merged' });
    expect(seam).toHaveBeenCalledTimes(1);
    const [approvalRow, apiRow, webRow] = (await Promise.all(
      [approval.id, api.mergeGateId, web.mergeGateId].map(gateRow),
    )) as [
      Awaited<ReturnType<typeof gateRow>>,
      Awaited<ReturnType<typeof gateRow>>,
      Awaited<ReturnType<typeof gateRow>>,
    ];
    expect(apiRow.state).toBe('approved');
    expect(apiRow.decidedById).toBe(fx.ownerId);
    expect(apiRow.decidedAt?.toISOString()).toBe(approvalRow.decidedAt?.toISOString());
    expect(webRow.state).toBe('approved');
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
