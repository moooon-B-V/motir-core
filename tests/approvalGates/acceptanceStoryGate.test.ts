import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';
import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { MergeChangeRequestResult } from '@/lib/git/types';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE STORY'S VITEST GATE (Story MOTIR-4949 · Subtask MOTIR-5791) — the ASSEMBLED
// acceptance gate against a real Postgres, driven the way an agent drives it: a receipt
// published through `publish_acceptance_result` with the E2E subtask's LEAF key.
//
// Each card in the story ships its own units, and each can be green while the story is
// wrong — the design-gate hole (MOTIR-5652) lived between two correct pieces. So this
// file stands at the joins:
//
//   · THE PLACEMENT MATRIX (`approval-gates.md` §1, the MOTIR-5787 amendment, points
//     1–3) — a STORY run and a SINGLE-CARD run, built as fixtures, and which card each
//     question lands on in each;
//   · THE LIFECYCLES — approve before green, a merge re-asked alone, a newer receipt,
//     and a republish after approval;
//   · THE GUARDS — one decide path, one loader, and nothing raised with the switch OFF.
//
// The object store and the billing entitlement seam are the only fakes; the host's merge
// is the git seam's `mergeChangeRequest`, stubbed per pull request.

const store = new Map<string, { size: number; contentType: string }>();
const minted = new Map<string, { contentType: string; maxBytes: number }>();

vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  mintPrivateUploadToken: vi.fn(
    async (pathname: string, opts: { contentType: string; maxBytes: number }) => {
      minted.set(pathname, { contentType: opts.contentType, maxBytes: opts.maxBytes });
      return `https://store.example/signed/${encodeURIComponent(pathname)}`;
    },
  ),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  signedDownloadUrl: vi.fn(async (pathname: string) => `https://store.example/get/${pathname}`),
  deleteAttachmentBlob: vi.fn(async () => {}),
}));

/** A paid plan, so the ONLY thing deciding eligibility is the project's switch. */
const aiAccess = vi.hoisted(() => ({ current: null as AiAccessDTO | null }));
vi.mock('@/lib/services/billingService', () => ({
  billingService: { getAiAccessForContext: vi.fn(async () => aiAccess.current) },
}));

const { runCreateAcceptanceUpload, runPublishAcceptanceResult } =
  await import('@/lib/mcp/tools/publishAcceptanceResult');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { pullRequestMergeService } = await import('@/lib/services/pullRequestMergeService');
const { reconcileGatesFor } = await import('@/lib/services/gateSetFor');
const { settleGreenVerdict } = await import('@/lib/services/mergeGates');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');

const github = getGitProvider('github') as Required<GitProvider>;

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  store.clear();
  minted.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "approval_gate", "acceptance_evidence", "attachment" RESTART IDENTITY CASCADE',
  );
  fx = await makeWorkItemFixture();
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { prMergeMode: 'manual', acceptanceVideoEnabled: true },
  });
  aiAccess.current = {
    applicable: true,
    organizationId: fx.workspace.organizationId,
    organizationName: 'Acme',
    canManageBilling: true,
    hasPaidAiPlan: true,
    balance: 100,
    tierName: 'Pro',
    tierAllotment: 100,
    renewsAt: null,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── fixtures ────────────────────────────────────────────────────────────────

async function item(kind: 'story' | 'subtask', title: string, parentId?: string) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
}

/** The run's HOW TO TEST record — what makes a card its run's TARGET (`runTarget.ts`). */
async function runTargetRecord(workItemId: string) {
  await adminDb.testInstructions.create({
    data: { workspaceId: fx.workspaceId, projectId: fx.projectId, workItemId, bodyMd: '## Run it' },
  });
}

/** One pull request delivered by `workItemId`, its latest check at `head` with `conclusion`. */
async function deliver(workItemId: string, number: number, head: string, conclusion: string) {
  seq += 1;
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-5791-${seq}`,
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
      repoId: `repo-5791-${seq}`,
      owner: 'acme',
      name: `web${seq}`,
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number,
      title: `Change #${number}`,
      state: 'open',
      headRef: `parent/ACME-${number}`,
      baseRef: 'main',
      provider: 'github',
    },
  });
  await adminDb.workItemDelivery.create({
    data: { workspaceId: fx.workspaceId, workItemId, githubPullRequestId: pr.id, repoId: repo.id },
  });
  await adminDb.githubCheckRun.create({
    data: { pullRequestId: pr.id, commitSha: head, checkName: 'Vitest', conclusion },
  });
  return pr;
}

/** A receipt published the way an agent publishes one: mint, PUT, publish — by `key`. */
async function publishVia(key: string, commitSha: string) {
  const grant = await runCreateAcceptanceUpload({ key }, fx.ctx);
  if (grant.isError) return grant;
  const video = (grant.structuredContent as { video: { pathname: string } }).video;
  const g = minted.get(video.pathname)!;
  store.set(video.pathname, { contentType: g.contentType, size: 4096 });
  return runPublishAcceptanceResult(
    { key, videoPathname: video.pathname, commitSha, producedByKey: key },
    fx.ctx,
  );
}

const gatesOn = async (workItemId: string) =>
  (
    await adminDb.approvalGate.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } })
  ).map((g) => [g.kind, g.state] as const);

const HEAD = 'a1'.repeat(20);

/** A STORY RUN: the story is its run's target and delivers the run's pull request. */
async function storyRun(conclusion = 'success') {
  const story = await item('story', 'Accept a story from its recording');
  const e2e = await item('subtask', 'Story E2E + acceptance video', story.id);
  // A run in hand, CI reported: the story is in review, where a real story run sits when
  // anything is pressed (the approve-to-merge approval writes `approved` from there).
  // Its child is landed first — a container reaches review only over built children.
  await workItemsService.updateStatus(e2e.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(e2e.id, 'implemented', fx.ctx);
  await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(story.id, 'in_review', fx.ctx);
  await runTargetRecord(story.id);
  const pr = await deliver(story.id, 402, HEAD, conclusion);
  return { story, e2e, pr };
}

// ── the placement matrix ────────────────────────────────────────────────────

describe('the placement matrix — which card each question lands on (points 1–3)', () => {
  it('(a) a STORY run: the story holds acceptance (primary) + the merge question; the E2E child holds neither', async () => {
    const { story, e2e } = await storyRun('success');

    const published = await publishVia(e2e.identifier, 'c0ffee1');
    expect(published.isError, JSON.stringify(published)).toBeFalsy();

    expect(await gatesOn(story.id)).toEqual([
      ['acceptance_result', 'awaiting'],
      ['pull_request_approval', 'awaiting'],
    ]);
    expect(await gatesOn(e2e.id)).toEqual([]);
  });

  it('(b) a SINGLE-CARD run: the story holds the acceptance question alone; the subtask only its own merge question', async () => {
    const story = await item('story', 'Accept a story from its recording');
    const e2e = await item('subtask', 'Story E2E + acceptance video', story.id);
    await runTargetRecord(e2e.id);
    await deliver(e2e.id, 410, HEAD, 'success');

    const published = await publishVia(e2e.identifier, 'c0ffee1');
    expect(published.isError, JSON.stringify(published)).toBeFalsy();
    // The subtask's own green set asks its own question — exactly as the CI promotion does.
    await withWorkspaceContext(fx.ctx, async (tx) =>
      reconcileGatesFor((await tx.workItem.findUniqueOrThrow({ where: { id: e2e.id } }))!, tx),
    );

    expect(await gatesOn(story.id)).toEqual([['acceptance_result', 'awaiting']]);
    expect(await gatesOn(e2e.id)).toEqual([['pull_request_approval', 'awaiting']]);
  });
});

// ── the lifecycles ──────────────────────────────────────────────────────────

describe('the lifecycles', () => {
  it('approve BEFORE green: the press is not refused, no merge gate is raised on the green, and the merge is carried', async () => {
    const { story, e2e, pr } = await storyRun('pending');
    await publishVia(e2e.identifier, 'c0ffee1');
    expect(await gatesOn(story.id)).toEqual([['acceptance_result', 'awaiting']]);
    const acceptance = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: story.id, kind: 'acceptance_result' },
    });

    const pressed = await pullRequestMergeService.approveAndMerge(
      { gateId: acceptance.id, source: 'ui', noteMd: null, stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );
    // No companion yet — the merge is HELD, not refused (AMENDMENT 6 Q4).
    expect(pressed.approval.gate.state).toBe('approved');
    expect(pressed.members).toEqual([]);

    // The set goes green.
    await adminDb.githubCheckRun.updateMany({
      where: { pullRequestId: pr.id },
      data: { conclusion: 'success' },
    });
    const requests = await withWorkspaceContext(fx.ctx, async (tx) => {
      const row = await tx.workItem.findUniqueOrThrow({ where: { id: story.id } });
      await reconcileGatesFor(row, tx);
      return settleGreenVerdict({ item: row, pullRequestIds: [pr.id] }, fx.ctx, tx);
    });
    // The standing acceptance carries the merge: nothing new is asked, and the merge is owed.
    expect(await gatesOn(story.id)).toEqual([['acceptance_result', 'approved']]);
    expect(requests.map((r) => r.pullRequestId)).toEqual([pr.id]);
  });

  it('a merge re-asked ALONE: after the press, a push moves the head and the next green asks only the merge', async () => {
    const { story, e2e, pr } = await storyRun('success');
    await publishVia(e2e.identifier, 'c0ffee1');
    const acceptance = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: story.id, kind: 'acceptance_result' },
    });
    vi.spyOn(github, 'mergeChangeRequest').mockImplementation(
      async () =>
        ({
          outcome: 'refused',
          refusal: { code: 'conflict' },
        }) as unknown as MergeChangeRequestResult,
    );
    await pullRequestMergeService.approveAndMerge(
      { gateId: acceptance.id, source: 'ui', noteMd: null, stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );

    // The agent pushes a fix: a NEW head, and a new green verdict at it.
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: pr.id,
        commitSha: 'b2'.repeat(20),
        checkName: 'Vitest',
        conclusion: 'success',
      },
    });
    await withWorkspaceContext(fx.ctx, async (tx) =>
      reconcileGatesFor(await tx.workItem.findUniqueOrThrow({ where: { id: story.id } }), tx),
    );

    const rows = await adminDb.approvalGate.findMany({
      where: { workItemId: story.id },
      orderBy: { createdAt: 'asc' },
    });
    // Acceptance stands, decided once; the merge is asked again, alone, over the new head.
    expect(rows.filter((g) => g.kind === 'acceptance_result').map((g) => g.state)).toEqual([
      'approved',
    ]);
    const awaitingMerge = rows.filter(
      (g) => g.kind === 'pull_request_approval' && g.state === 'awaiting',
    );
    expect(awaitingMerge).toHaveLength(1);
    expect(awaitingMerge[0]!.subjectVersion).toContain('b2'.repeat(20));
  });

  it('a NEWER receipt supersedes the awaiting question with cause `republished`', async () => {
    const { story, e2e } = await storyRun('pending');
    await publishVia(e2e.identifier, 'c0ffee1');
    await publishVia(e2e.identifier, 'd00d002');

    const rows = await adminDb.approvalGate.findMany({
      where: { workItemId: story.id, kind: 'acceptance_result' },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'republished'],
      ['awaiting', null],
    ]);
  });

  it('after APPROVAL, with the story pull request still open, a republish through the MCP door is refused', async () => {
    const { story, e2e } = await storyRun('pending');
    await publishVia(e2e.identifier, 'c0ffee1');
    const acceptance = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: story.id, kind: 'acceptance_result' },
    });
    await pullRequestMergeService.approveAndMerge(
      { gateId: acceptance.id, source: 'ui', noteMd: null, stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );

    const refused = await publishVia(e2e.identifier, 'd00d002');
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain('ACCEPTANCE_EVIDENCE_ALREADY_APPROVED');
    expect(await gatesOn(story.id)).toEqual([['acceptance_result', 'approved']]);
  });
});

// ── the guards ──────────────────────────────────────────────────────────────

describe('the guards', () => {
  const files = (root: string) =>
    execSync(`grep -rl --include=*.ts --include=*.tsx . ${root} || true`, {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  const code = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

  it('ONE decide path: nothing but the acceptance HANDLER writes a receipt status from production code', () => {
    // A receipt's `approved` IS the freeze (point 6), so a second writer would be a second
    // way to accept a story — one that skips the gate, its audit and its status rule.
    // `acceptanceEvidenceService.setStatus` survives for tests; it must have no caller here.
    const writers = ['lib', 'app', 'components']
      .flatMap(files)
      .filter((f) => code(f).includes('acceptanceEvidenceRepository.updateStatus('))
      .sort();
    expect(writers).toEqual([
      'lib/approvalGates/acceptanceResultHandler.ts',
      'lib/services/acceptanceEvidenceService.ts',
    ]);
    const setStatusCallers = ['lib', 'app', 'components']
      .flatMap(files)
      .filter((f) => code(f).includes('acceptanceEvidenceService.setStatus('));
    expect(setStatusCallers).toEqual([]);
  });

  it('ONE loader: the predicate is called from `gateSetFor` alone, which is where the receipt is read', () => {
    const callers = ['lib', 'app', 'components']
      .flatMap(files)
      .filter((f) => f !== 'lib/approvalGates/gateSet.ts' && code(f).includes('resolveGateSet('));
    expect(callers).toEqual(['lib/services/gateSetFor.ts']);
    expect(code('lib/services/gateSetFor.ts')).toContain(
      "approvalGateRepository.findLatestByWorkItem(item.id, 'acceptance_result', tx)",
    );
  });

  it('the switch OFF: the publish is refused, no receipt is written, and NO gate is raised', async () => {
    const { story, e2e } = await storyRun('success');
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { acceptanceVideoEnabled: false },
    });

    const refused = await publishVia(e2e.identifier, 'c0ffee1');
    expect(refused.isError).toBe(true);
    expect(await adminDb.acceptanceEvidence.count({ where: { workItemId: story.id } })).toBe(0);
    expect(
      await adminDb.approvalGate.count({
        where: { workItemId: story.id, kind: 'acceptance_result' },
      }),
    ).toBe(0);
  });
});
