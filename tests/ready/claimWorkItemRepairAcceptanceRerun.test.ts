import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalGateRefusalVerdict } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';

// THE ACCEPTANCE RE-RUN CLASS of the repair claim (Story MOTIR-6071 · MOTIR-6502;
// `docs/decisions/acceptance-refusal-verdict.md` §4), over real Postgres.
//
// A story run whose acceptance video was sent back with **Re-run** has GREEN checks —
// the shipped predicate refuses it `not_failing`. The new class admits it at the
// Implemented and In Review rungs, hands over EVERY open member with the reviewer's
// reason, and ends the moment a newer receipt asks again. Nothing writes a status.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const REASON = 'The empty board should say how to add the first card.';

/** A story run: a story at `status` with one open GREEN delivery of its own, a current
 *  receipt, and its acceptance refused as described. */
async function refusedStoryRun(
  fx: WorkItemFixture,
  opts: {
    status?: 'implemented' | 'in_review';
    verdict?: ApprovalGateRefusalVerdict | null;
    source?: 'ui' | 'github';
    state?: 'changes_requested' | 'approved';
  } = {},
) {
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'Exports list' });
  const child = await createTestWorkItem(fx, {
    kind: 'subtask',
    title: 'The empty state',
    parentId: story.id,
  });
  await setStatus(child.id, 'implemented');
  await setStatus(story.id, opts.status ?? 'in_review');
  const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
  const pr = await deliveredPr(fx, story.id, repo, {
    headRef: 'parent/exports-list',
    baseRef: 'main',
    checks: { Vitest: 'success', Lint: 'success' },
  });
  const receipt = await adminDb.acceptanceEvidence.create({
    data: { workspaceId: fx.workspaceId, workItemId: story.id, status: 'changes_requested' },
  });
  const decidedAt = new Date('2026-09-26T10:00:00Z');
  const gate = await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: story.id,
      kind: 'acceptance_result',
      subjectId: receipt.id,
      subjectVersion: 'c'.repeat(40),
      state: opts.state ?? 'changes_requested',
      decidedById: fx.ownerId,
      decidedAt,
      decidedByLabel: 'Yue Zhu',
      decisionSource: opts.source ?? 'ui',
      decidedUnderAuthority: 'assignee',
      noteMd: REASON,
      refusalVerdict: opts.verdict === undefined ? 'revise' : opts.verdict,
    },
  });
  return { story, child, repo, pr, receipt, gate, decidedAt };
}

const claim = (fx: WorkItemFixture, key: string) =>
  workItemRepairService.claimRepair(fx.projectId, key, fx.ctx);

async function statusesOf(...ids: string[]) {
  const rows = await adminDb.workItem.findMany({ where: { id: { in: ids } } });
  return Object.fromEntries(rows.map((r) => [r.id, r.status]));
}

describe('claimRepair — an acceptance sent back with Re-run (MOTIR-6502)', () => {
  for (const status of ['implemented', 'in_review'] as const) {
    it(`claims a ${status} story run with GREEN checks, naming the class, the reason and every open member`, async () => {
      const fx = await makeWorkItemFixture();
      const { story, child, repo, pr, decidedAt } = await refusedStoryRun(fx, { status });
      const before = await statusesOf(story.id, child.id);

      const result = await claim(fx, story.identifier);

      expect(result).toMatchObject({
        outcome: 'claimed',
        reason: null,
        repairClass: 'acceptance_rerun',
        acceptanceRefusal: {
          reasonMd: REASON,
          decidedByLabel: 'Yue Zhu',
          decidedAt: decidedAt.toISOString(),
        },
      });
      expect(result.pullRequests).toEqual([
        expect.objectContaining({
          repo: `acme/${repo.name}`,
          number: pr.number,
          headRef: 'parent/exports-list',
          ci: 'passing',
          failingChecks: [],
        }),
      ]);
      // Nothing moves: the claim is a `fix` run, not a status write.
      expect(await statusesOf(story.id, child.id)).toEqual(before);
      const runs = await adminDb.dispatchRun.findMany({
        where: { command: 'fix', cards: { some: { workItemId: story.id } } },
      });
      expect(runs).toHaveLength(1);
    });
  }

  it('the holder claiming again is mine, and is handed the reason again', async () => {
    const fx = await makeWorkItemFixture();
    const { story } = await refusedStoryRun(fx);
    const first = await claim(fx, story.identifier);
    const again = await claim(fx, story.identifier);
    expect(again).toMatchObject({
      outcome: 'mine',
      runId: first.runId,
      repairClass: 'acceptance_rerun',
      acceptanceRefusal: { reasonMd: REASON },
    });
  });

  it.each([
    ['re_plan', { verdict: 're_plan' as const }],
    ['no verdict', { verdict: null }],
    ['a GitHub-sourced refusal', { source: 'github' as const, verdict: null }],
    ['an approval', { state: 'approved' as const, verdict: null }],
  ])('%s is not a Re-run — refused not_failing, nothing opened', async (_label, opts) => {
    const fx = await makeWorkItemFixture();
    const { story } = await refusedStoryRun(fx, opts);

    const result = await claim(fx, story.identifier);

    expect(result).toMatchObject({
      outcome: 'not_repairable',
      reason: 'not_failing',
      repairClass: 'ci',
      acceptanceRefusal: null,
      pullRequests: [],
    });
    expect(
      await adminDb.dispatchRun.count({
        where: { command: 'fix', cards: { some: { workItemId: story.id } } },
      }),
    ).toBe(0);
  });

  it('a NEWER receipt ends the class — the refusal was about a recording that is no longer current', async () => {
    const fx = await makeWorkItemFixture();
    const { story, receipt } = await refusedStoryRun(fx);
    await adminDb.acceptanceEvidence.update({
      where: { id: receipt.id },
      data: { isCurrent: false },
    });
    await adminDb.acceptanceEvidence.create({
      data: { workspaceId: fx.workspaceId, workItemId: story.id },
    });

    expect(await claim(fx, story.identifier)).toMatchObject({
      outcome: 'not_repairable',
      reason: 'not_failing',
    });
  });

  it('an AWAITING acceptance question ends the class — the video is being asked about again', async () => {
    const fx = await makeWorkItemFixture();
    const { story, receipt } = await refusedStoryRun(fx);
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: story.id,
        kind: 'acceptance_result',
        subjectId: receipt.id,
        subjectVersion: 'd'.repeat(40),
        state: 'awaiting',
      },
    });

    expect(await claim(fx, story.identifier)).toMatchObject({
      outcome: 'not_repairable',
      reason: 'not_failing',
    });
  });

  it('a story whose only delivery is closed has nothing to push to — refused, never a Re-run', async () => {
    const fx = await makeWorkItemFixture();
    const { story, pr } = await refusedStoryRun(fx);
    await adminDb.githubPullRequest.update({
      where: { id: pr.id },
      data: { state: 'closed', merged: true },
    });

    const result = await claim(fx, story.identifier);
    expect(result.outcome).toBe('not_repairable');
    expect(result.repairClass).toBe('ci');
  });

  it('a later refusal of ANOTHER kind does not hide the acceptance refusal — the class reads its own kind', async () => {
    const fx = await makeWorkItemFixture();
    const { story, pr } = await refusedStoryRun(fx);
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: story.id,
        kind: 'pull_request_approval',
        subjectId: pr.id,
        subjectVersion: 'e'.repeat(40),
        state: 'superseded',
        supersededCause: 'pulled_back',
      },
    });
    expect((await claim(fx, story.identifier)).repairClass).toBe('acceptance_rerun');
  });
});

describe('getRepairView — the Development block offers `motir fix` for a Re-run (MOTIR-6502)', () => {
  it('offers the command with the class and the reason, and opens nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { story, pr } = await refusedStoryRun(fx);

    const view = await workItemRepairService.getRepairView(story.id, fx.ctx);

    expect(view).toMatchObject({
      state: 'offer',
      repairClass: 'acceptance_rerun',
      acceptanceRefusal: { reasonMd: REASON, decidedByLabel: 'Yue Zhu' },
      lastGaveUp: null,
    });
    expect(view.state === 'offer' ? view.failing.map((f) => f.number) : []).toEqual([pr.number]);
    expect(
      await adminDb.dispatchRun.count({
        where: { command: 'fix', cards: { some: { workItemId: story.id } } },
      }),
    ).toBe(0);
  });

  it('names the holder once the Re-run is claimed, still as a Re-run', async () => {
    const fx = await makeWorkItemFixture();
    const { story } = await refusedStoryRun(fx);
    await claim(fx, story.identifier);

    expect(await workItemRepairService.getRepairView(story.id, fx.ctx)).toMatchObject({
      state: 'in_progress',
      repairClass: 'acceptance_rerun',
      byViewer: true,
    });
  });

  it('a Re-plan offers nothing — the planner answers it, not `motir fix`', async () => {
    const fx = await makeWorkItemFixture();
    const { story } = await refusedStoryRun(fx, { verdict: 're_plan' });
    expect(await workItemRepairService.getRepairView(story.id, fx.ctx)).toEqual({
      state: 'hidden',
    });
  });

  it('a CHILD of the story is pointed at nothing of its own — the Re-run is the story’s', async () => {
    const fx = await makeWorkItemFixture();
    const { child } = await refusedStoryRun(fx);
    expect(await workItemRepairService.getRepairView(child.id, fx.ctx)).toEqual({
      state: 'hidden',
    });
  });
});
