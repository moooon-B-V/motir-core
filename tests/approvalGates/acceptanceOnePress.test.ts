import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { MergeChangeRequestResult } from '@/lib/git/types';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// ONE PRESS, TWO GATES — A STORY RUN'S ACCEPTANCE (Story MOTIR-4949 · Subtask MOTIR-5789;
// `approval-gates.md` §1, the MOTIR-5787 amendment, point 2), against a REAL Postgres.
//
// When a story is run as a whole its run's pull requests are the STORY's delivery set,
// and the story holds two questions: *is this what I wanted?* (the receipt, PRIMARY) and
// *do these commits land?*. One press on the acceptance gate answers both — the
// acceptance decided, the merge gate decided at the same instant, and every member merged
// through the one merge path — and the video merges NOWHERE, because it is not a file in
// any of them. The host is the seam's `mergeChangeRequest`, stubbed per pull request.

vi.mock('@/lib/blob/uploader', () => {
  let n = 0;
  return {
    putAttachment: vi.fn(async (p: string) => ({ url: `https://blob.example/${p}-${++n}` })),
    putPrivateAttachment: vi.fn(async (p: string) => ({ pathname: `${p}-${++n}` })),
    signedDownloadUrl: vi.fn(async (p: string) => `https://blob.example/signed/${p}`),
    deleteAttachmentBlob: vi.fn(async () => {}),
  };
});

const { acceptanceEvidenceService } = await import('@/lib/services/acceptanceEvidenceService');
const { pullRequestMergeService } = await import('@/lib/services/pullRequestMergeService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { AcceptanceEvidenceStoryClosedError } = await import('@/lib/acceptanceEvidence/errors');

const HEAD_WEB = '9840d00ea1b2c3d4e5f60718293a4b5c6d7e8f90';
const HEAD_API = '1111111111111111111111111111111111111111';
const github = getGitProvider('github') as Required<GitProvider>;
const video = () => new File([new Uint8Array(1024)], 'run.webm', { type: 'video/webm' });

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  // ⚠️ THE ORDER IS THE SUITE'S, NOT THIS FILE'S (MOTIR-3066): every truncate naming these
  // tables takes them `acceptance_evidence` → `attachment` → `approval_gate`, and two
  // statements taking shared tables in opposite orders deadlock (40P01) the moment they run
  // against one database. `tests/truncate-lock-order.test.ts` is what holds the order.
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "approval_gate" RESTART IDENTITY CASCADE',
  );
  fx = await makeWorkItemFixture();
  await adminDb.project.update({ where: { id: fx.projectId }, data: { prMergeMode: 'manual' } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A STORY in review whose own run delivered `acme/web#7` and `acme/api#12`, both green. */
async function storyRun() {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Accept a story from its recording' },
    fx.ctx,
  );
  await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(story.id, 'in_review', fx.ctx);

  const members: Record<number, { prId: string }> = {};
  for (const [name, number, head] of [
    ['web', 7, HEAD_WEB],
    ['api', 12, HEAD_API],
  ] as const) {
    seq += 1;
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: `inst-5789-${seq}`,
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
        repoId: `repo-5789-${seq}`,
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
        headRef: 'parent/ACME-20-acceptance',
        baseRef: 'main',
        provider: 'github',
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: story.id,
        githubPullRequestId: pr.id,
        repoId: repo.id,
      },
    });
    await adminDb.githubCheckRun.create({
      data: { pullRequestId: pr.id, commitSha: head, checkName: 'Vitest', conclusion: 'success' },
    });
    members[number] = { prId: pr.id };
  }
  return { story, web: members[7]!, api: members[12]! };
}

const gatesOf = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });

function stubHost(answers: Record<number, MergeChangeRequestResult>) {
  return vi
    .spyOn(github, 'mergeChangeRequest')
    .mockImplementation(async (args) => answers[args.number]!);
}

describe('a story run — the receipt is the PRIMARY, and one press also merges (MOTIR-5789)', () => {
  it('a PUBLISH on a story whose set is green raises BOTH questions, acceptance first — through the predicate', async () => {
    const { story } = await storyRun();
    const receipt = await acceptanceEvidenceService.recordFromUpload(
      { workItemId: story.id, video: video(), commitSha: 'c0ffee1' },
      fx.ctx,
    );

    const gates = await gatesOf(story.id);
    expect(gates.map((g) => [g.kind, g.state])).toEqual([
      ['acceptance_result', 'awaiting'],
      ['pull_request_approval', 'awaiting'],
    ]);
    expect(gates[0]!.subjectId).toBe(receipt.id);
    // The merge gate names the STORY and its commits; nothing about the video is in it.
    expect(gates[1]!.subjectId).toBe(story.id);
    expect(gates[1]!.subjectVersion).toBe(`acme/api#12@${HEAD_API},acme/web#7@${HEAD_WEB}`);
  });

  it('ONE press on the acceptance gate decides it, decides the merge gate at the same instant, and merges every member', async () => {
    const { story, web, api } = await storyRun();
    await acceptanceEvidenceService.recordFromUpload(
      { workItemId: story.id, video: video(), commitSha: 'c0ffee1' },
      fx.ctx,
    );
    const [acceptance] = await gatesOf(story.id);
    const host = stubHost({
      7: { outcome: 'merged', commitSha: 'merge-web' },
      12: { outcome: 'merged', commitSha: 'merge-api' },
    });

    const pressed = await pullRequestMergeService.approveAndMerge(
      { gateId: acceptance!.id, source: 'ui', noteMd: null, stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );

    expect(pressed.approval.gate.state).toBe('approved');
    expect(pressed.members.map((m) => m.outcome)).toEqual(['merged', 'merged']);
    expect(host).toHaveBeenCalledTimes(2);

    const [acceptanceRow, mergeRow] = await gatesOf(story.id);
    expect(acceptanceRow!.state).toBe('approved');
    expect(mergeRow!.state).toBe('approved');
    // ONE person's decision at ONE instant (§8's amendment, decision 5(c)).
    expect(mergeRow!.decidedAt?.toISOString()).toBe(acceptanceRow!.decidedAt?.toISOString());

    // Each outcome lives on its own pull request — the video is on none of them.
    for (const prId of [web.prId, api.prId]) {
      const pr = await adminDb.githubPullRequest.findUniqueOrThrow({ where: { id: prId } });
      expect(pr.mergeOutcomeRef).not.toBeNull();
    }

    // The receipt is signed (the freeze keys on this), and the story waits for the merge
    // webhook to write `done`: the acceptance handler writes nothing while its own
    // delivery is open (point 7), and the merge gate's approval writes `approved`.
    const receipt = await adminDb.acceptanceEvidence.findFirstOrThrow({
      where: { workItemId: story.id, isCurrent: true },
    });
    expect(receipt.status).toBe('approved');
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } });
    expect(row.status).toBe('approved');
  });

  it('with the receipt APPROVED and a story pull request still open, a republish is refused — the story still stands on the approval (point 6; MOTIR-5872)', async () => {
    const { story } = await storyRun();
    await acceptanceEvidenceService.recordFromUpload(
      { workItemId: story.id, video: video(), commitSha: 'c0ffee1' },
      fx.ctx,
    );
    const [acceptance] = await gatesOf(story.id);
    // The host refuses nothing and merges nothing: the pull requests stay OPEN.
    stubHost({
      7: { outcome: 'enqueued', entryId: 'queue-7' },
      12: { outcome: 'enqueued', entryId: 'queue-12' },
    });
    await pullRequestMergeService.approveAndMerge(
      { gateId: acceptance!.id, source: 'ui', noteMd: null, stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );

    await expect(
      acceptanceEvidenceService.recordFromUpload(
        { workItemId: story.id, video: video(), commitSha: 'd00d002' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(AcceptanceEvidenceStoryClosedError);
    const acceptanceRows = (await gatesOf(story.id)).filter((g) => g.kind === 'acceptance_result');
    expect(acceptanceRows.map((g) => g.state)).toEqual(['approved']);
  });

  // ⚠️ MOTIR-5872 — approval pins the recording; it does not freeze the STORY.
  // The two cases below are the design gate's `assertDesignSettled` rung,
  // transposed: at or above `implemented` with a pull request open the story is
  // still OFFERING the approved work, below it the work is being redone.
  async function approvedWithOpenPullRequests() {
    const { story } = await storyRun();
    await acceptanceEvidenceService.recordFromUpload(
      { workItemId: story.id, video: video(), commitSha: 'c0ffee1' },
      fx.ctx,
    );
    const [acceptance] = await gatesOf(story.id);
    stubHost({
      7: { outcome: 'enqueued', entryId: 'queue-7' },
      12: { outcome: 'enqueued', entryId: 'queue-12' },
    });
    await pullRequestMergeService.approveAndMerge(
      { gateId: acceptance!.id, source: 'ui', noteMd: null, stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );
    const approved = await adminDb.acceptanceEvidence.findFirstOrThrow({
      where: { workItemId: story.id, isCurrent: true },
    });
    expect(approved.status).toBe('approved');
    return { story, approved };
  }

  it('a story EJECTED back to Implemented with its pull request still open still stands on the approval — refused', async () => {
    const { story } = await approvedWithOpenPullRequests();
    await workItemsService.updateStatus(story.id, 'implemented', fx.ctx);

    await expect(
      acceptanceEvidenceService.recordFromUpload(
        { workItemId: story.id, video: video(), commitSha: 'd00d002' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(AcceptanceEvidenceStoryClosedError);
  });

  it('a story PULLED BACK to In progress records again, and the approved recording keeps its bytes', async () => {
    const { story, approved } = await approvedWithOpenPullRequests();
    await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);

    const next = await acceptanceEvidenceService.recordFromUpload(
      { workItemId: story.id, video: video(), commitSha: 'd00d002' },
      fx.ctx,
    );
    expect(next.status).toBe('pending');
    expect(next.id).not.toBe(approved.id);

    const history = await adminDb.acceptanceEvidence.findUniqueOrThrow({
      where: { id: approved.id },
    });
    expect(history.isCurrent).toBe(false);
    expect(history.status).toBe('approved');
    const kept = await adminDb.attachment.findUniqueOrThrow({
      where: { id: approved.attachmentId! },
    });
    expect(kept.workItemId).toBe(story.id);
  });
});
