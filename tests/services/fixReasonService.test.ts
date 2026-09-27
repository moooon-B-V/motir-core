import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { WorkItemFixReason } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { recomputeWorkItemFixReason } from '@/lib/services/fixReasonService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import {
  FIX_NOTE_PREVIEW_MAX,
  FIX_REASON_PRIORITY,
  notePreviewOf,
  reviewerNameOf,
  sameFixReason,
} from '@/lib/workItems/fixReason';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';
import { warmPool } from '../helpers/warmPool';

// `WorkItem.fixReason` (Story MOTIR-6588 · MOTIR-6600), over real Postgres.
//
// What is under test: the stored answer is `motir fix`'s own — every shape the repair
// claim takes reads a pull-request reason, every refusal reads nothing (or a reviewer's
// standing Request changes) — the priority when several reasons hold, each clearing
// condition, and that two recomputes racing on one card store what a serial one would.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const HEAD = 'c'.repeat(40); // the head `deliveredPr` writes its check rows at

const recompute = (fx: WorkItemFixture, workItemId: string) =>
  withWorkspaceContext({ userId: fx.ownerId, workspaceId: fx.workspaceId }, (tx) =>
    recomputeWorkItemFixReason(workItemId, tx),
  );

async function stored(workItemId: string) {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } });
  return { fixReason: row.fixReason, fixDetail: row.fixDetail };
}

async function exitOn(
  pullRequestId: string,
  opts: {
    rawReason?: string;
    disposition?: 'failure' | 'neutral';
    headSha?: string;
    failingCheckName?: string | null;
  } = {},
) {
  return adminDb.githubPullRequestQueueExit.create({
    data: {
      pullRequestId,
      deliveryId: `guid-${randomToken(8)}`,
      rawReason: opts.rawReason ?? 'CI_FAILURE',
      disposition: opts.disposition ?? 'failure',
      headSha: opts.headSha ?? HEAD,
      exitedAt: new Date('2026-09-18T10:00:00.000Z'),
      requeuedAt: null,
      failingCheckName:
        opts.failingCheckName === undefined ? 'Merge queue / e2e' : opts.failingCheckName,
      failingCheckUrl: null,
    },
  });
}

async function conflict(pullRequestId: string, headSha = HEAD) {
  await adminDb.githubPullRequest.update({
    where: { id: pullRequestId },
    data: { mergeableState: 'dirty', mergeableStateHeadSha: headSha },
  });
}

/** A card at `status` with one open pull request carrying `checks`. */
async function cardWith(
  fx: WorkItemFixture,
  status: string,
  checks: Record<string, 'success' | 'failure' | 'pending'> = { Vitest: 'success' },
) {
  const card = await createTestWorkItem(fx, { kind: 'task', title: `card ${randomToken(4)}` });
  await setStatus(card.id, status);
  const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
  const pr = await deliveredPr(fx, card.id, repo, { headRef: `subtask/${randomToken(4)}`, checks });
  return { card, repo, pr };
}

/** A decided approve-to-merge Request changes on `workItemId`, about `subjectVersion`. */
async function requestChanges(
  fx: WorkItemFixture,
  workItemId: string,
  subjectVersion: string,
  opts: {
    noteMd?: string | null;
    decidedAt?: Date;
    state?: 'changes_requested' | 'approved';
    kind?: 'pull_request_approval' | 'design_result';
  } = {},
) {
  return adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId,
      kind: opts.kind ?? 'pull_request_approval',
      subjectId: workItemId,
      subjectVersion,
      state: opts.state ?? 'changes_requested',
      decidedById: fx.ownerId,
      decidedAt: opts.decidedAt ?? new Date('2026-09-26T10:00:00Z'),
      decidedByLabel: 'Yue Zhu <yue@example.com>',
      decisionSource: 'ui',
      decidedUnderAuthority: 'assignee',
      noteMd:
        opts.noteMd === undefined
          ? '\n  Rename the export button.  \nAnd the tooltip.'
          : opts.noteMd,
    },
  });
}

const versionOf = (repoName: string, number: number, head = HEAD) =>
  `acme/${repoName}#${number}@${head}`;

describe('the pure half', () => {
  it('the priority is the enum declaration order', () => {
    expect(FIX_REASON_PRIORITY).toEqual(Object.values(WorkItemFixReason));
  });

  it('a note preview is its first non-empty line, trimmed and cut', () => {
    expect(notePreviewOf(null)).toBeNull();
    expect(notePreviewOf('  \n\n')).toBeNull();
    expect(notePreviewOf('\n  first  \nsecond')).toBe('first');
    const long = 'x'.repeat(FIX_NOTE_PREVIEW_MAX + 20);
    const cut = notePreviewOf(long)!;
    expect(cut).toHaveLength(FIX_NOTE_PREVIEW_MAX);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('the reviewer is drawn by NAME — the live user row first, else the audit label without its email', () => {
    expect(
      reviewerNameOf({ name: 'Mei Lin', email: 'mei@example.com' }, 'Old <old@example.com>'),
    ).toBe('Mei Lin');
    expect(reviewerNameOf({ name: '  ', email: 'mei@example.com' }, null)).toBe('mei@example.com');
    expect(reviewerNameOf(null, 'Mei Lin <mei@example.com>')).toBe('Mei Lin');
    expect(reviewerNameOf(null, 'octocat')).toBe('octocat');
    expect(reviewerNameOf(null, '<only@example.com>')).toBe('<only@example.com>');
    expect(reviewerNameOf(null, null)).toBeNull();
  });

  it('sameFixReason compares the reason and the whole detail', () => {
    const detail = {
      repair: 'fix' as const,
      check: 'Vitest',
      queueReason: null,
      base: null,
      reviewerName: null,
      notePreview: null,
      gate: null,
      affected: 1,
      total: 1,
    };
    expect(
      sameFixReason({ fixReason: null, fixDetail: null }, { fixReason: null, fixDetail: null }),
    ).toBe(true);
    expect(
      sameFixReason(
        { fixReason: 'ci_failed', fixDetail: detail },
        { fixReason: 'ci_failed', fixDetail: detail },
      ),
    ).toBe(true);
    expect(
      sameFixReason(
        { fixReason: 'ci_failed', fixDetail: detail },
        { fixReason: 'ci_failed', fixDetail: { ...detail, affected: 2 } },
      ),
    ).toBe(false);
    // jsonb hands the keys back in its own order — still the same answer.
    const reordered = Object.fromEntries(Object.entries(detail).reverse());
    expect(
      sameFixReason(
        { fixReason: 'ci_failed', fixDetail: reordered },
        { fixReason: 'ci_failed', fixDetail: detail },
      ),
    ).toBe(true);
    expect(
      sameFixReason(
        { fixReason: 'ci_failed', fixDetail: null },
        { fixReason: 'ci_failed', fixDetail: detail },
      ),
    ).toBe(false);
  });
});

describe('each reason alone', () => {
  it('a red build is ci_failed, naming the first failing check', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await cardWith(fx, 'implemented', {
      Vitest: 'failure',
      Lint: 'failure',
      Build: 'success',
    });

    const value = await recompute(fx, card.id);

    expect(value).toEqual({
      fixReason: 'ci_failed',
      fixDetail: {
        repair: 'fix',
        check: 'Lint',
        queueReason: null,
        base: null,
        reviewerName: null,
        notePreview: null,
        gate: null,
        affected: 1,
        total: 1,
      },
    });
    expect(await stored(card.id)).toEqual(value);
  });

  it('a standing queue failure is queue_failed, naming the queue check and reason', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await cardWith(fx, 'implemented');
    await exitOn(pr.id, { rawReason: 'CI_TIMEOUT' });

    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'queue_failed',
      fixDetail: {
        repair: 'fix',
        check: 'Merge queue / e2e',
        queueReason: 'CI_TIMEOUT',
        affected: 1,
        total: 1,
      },
    });
  });

  it('a conflict is conflicted, naming the base', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await cardWith(fx, 'implemented');
    await conflict(pr.id);

    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'conflicted',
      fixDetail: { repair: 'fix', base: 'main', check: null },
    });
  });

  it('a Request changes at the current heads is changes_requested, naming the reviewer and the note’s first line', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await requestChanges(fx, card.id, versionOf(repo.name, pr.number));

    expect(await recompute(fx, card.id)).toEqual({
      fixReason: 'changes_requested',
      fixDetail: {
        repair: 'run',
        check: null,
        queueReason: null,
        base: null,
        reviewerName: fx.owner.name,
        notePreview: 'Rename the export button.',
        gate: 'pull_request_approval',
        affected: 1,
        total: 1,
      },
    });
  });

  it('an acceptance sent back with Re-run is changes_requested on the acceptance gate, repaired by `motir fix`', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Exports list' });
    await setStatus(story.id, 'in_review');
    const repo = await connectRepairRepo(fx, 'web');
    await deliveredPr(fx, story.id, repo, {
      headRef: 'parent/exports',
      checks: { Vitest: 'success' },
    });
    const receipt = await adminDb.acceptanceEvidence.create({
      data: { workspaceId: fx.workspaceId, workItemId: story.id, status: 'changes_requested' },
    });
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: story.id,
        kind: 'acceptance_result',
        subjectId: receipt.id,
        subjectVersion: HEAD,
        state: 'changes_requested',
        decidedById: fx.ownerId,
        decidedAt: new Date('2026-09-26T10:00:00Z'),
        decidedByLabel: 'Yue Zhu <yue@example.com>',
        decisionSource: 'ui',
        decidedUnderAuthority: 'assignee',
        noteMd: 'The empty board should say how to add the first card.',
        refusalVerdict: 'revise',
      },
    });

    expect(await recompute(fx, story.id)).toMatchObject({
      fixReason: 'changes_requested',
      fixDetail: {
        repair: 'fix',
        gate: 'acceptance_result',
        reviewerName: fx.owner.name,
        notePreview: 'The empty board should say how to add the first card.',
      },
    });
    // …and it agrees with the claim, which takes it as its own repair class.
    const claim = await workItemRepairService.claimRepair(fx.projectId, story.identifier, fx.ctx);
    expect(claim).toMatchObject({ outcome: 'claimed', repairClass: 'acceptance_rerun' });
  });
});

describe('agreement with `motir fix` — the repair claim’s own matrix', () => {
  // Each shape is built, recomputed, then CLAIMED: a claimable shape stores a
  // pull-request reason, and every refusal stores nothing. The claim runs last because
  // a successful one opens a `fix` run.
  const PR_REASONS = ['queue_failed', 'conflicted', 'ci_failed'];

  type Shape = [label: string, build: (fx: WorkItemFixture) => Promise<string>];
  const shapes: Shape[] = [
    [
      'implemented + red',
      async (fx) => (await cardWith(fx, 'implemented', { Vitest: 'failure' })).card.id,
    ],
    [
      'implemented + queue failure',
      async (fx) => {
        const { card, pr } = await cardWith(fx, 'implemented');
        await exitOn(pr.id);
        return card.id;
      },
    ],
    [
      'implemented + conflict',
      async (fx) => {
        const { card, pr } = await cardWith(fx, 'implemented');
        await conflict(pr.id);
        return card.id;
      },
    ],
    [
      'in_review + a code-fixable ejection',
      async (fx) => {
        const { card, pr } = await cardWith(fx, 'in_review');
        await exitOn(pr.id, { rawReason: 'MERGE_CONFLICT', failingCheckName: null });
        return card.id;
      },
    ],
    ...(['todo', 'in_progress', 'approved', 'done'] as const).map(
      (status): Shape => [
        `${status} + red (not_implemented)`,
        async (fx) => (await cardWith(fx, status, { Vitest: 'failure' })).card.id,
      ],
    ),
    [
      'archived + red (not_implemented)',
      async (fx) => {
        const { card } = await cardWith(fx, 'implemented', { Vitest: 'failure' });
        await adminDb.workItem.update({ where: { id: card.id }, data: { archivedAt: new Date() } });
        return card.id;
      },
    ],
    [
      'a child of a run target (repair_on_run_target)',
      async (fx) => {
        const story = await createTestWorkItem(fx, { kind: 'story', title: 'the run target' });
        const child = await createTestWorkItem(fx, {
          kind: 'subtask',
          title: 'a child',
          parentId: story.id,
        });
        await setStatus(child.id, 'implemented');
        const repo = await connectRepairRepo(fx, 'web');
        await deliveredPr(fx, child.id, repo, {
          headRef: 'parent/x',
          checks: { Vitest: 'failure' },
        });
        await testInstructionsService.publish(
          {
            workItemId: story.id,
            bodyMd: '## Precondition\n\nSign in.',
            previewPath: null,
            repos: [{ repoId: repo.id, commitSha: HEAD }],
          },
          fx.ctx,
        );
        return child.id;
      },
    ],
    [
      'implemented with no pull requests (no_pull_requests)',
      async (fx) => {
        const card = await createTestWorkItem(fx, { kind: 'task', title: 'no PRs' });
        await setStatus(card.id, 'implemented');
        return card.id;
      },
    ],
    [
      'a running build (ci_running)',
      async (fx) => (await cardWith(fx, 'implemented', { Vitest: 'pending' })).card.id,
    ],
    ['a green build (not_failing)', async (fx) => (await cardWith(fx, 'implemented')).card.id],
    [
      'a conflict only at an OLD head (not_failing)',
      async (fx) => {
        const { card, pr } = await cardWith(fx, 'implemented');
        await conflict(pr.id, 'f'.repeat(40));
        return card.id;
      },
    ],
    [
      'in_review + a setting ejection (repair_not_code)',
      async (fx) => {
        const { card, pr } = await cardWith(fx, 'in_review');
        await exitOn(pr.id, { rawReason: 'BRANCH_PROTECTIONS' });
        return card.id;
      },
    ],
    [
      'in_review + a neutral ejection (repair_not_code)',
      async (fx) => {
        const { card, pr } = await cardWith(fx, 'in_review');
        await exitOn(pr.id, { rawReason: 'MANUAL', disposition: 'neutral' });
        return card.id;
      },
    ],
    [
      'in_review + red, no ejection (not_failing)',
      async (fx) => (await cardWith(fx, 'in_review', { Vitest: 'failure' })).card.id,
    ],
  ];

  it.each(shapes)('%s', async (_label, build) => {
    const fx = await makeWorkItemFixture();
    const id = await build(fx);
    const value = await recompute(fx, id);
    const card = await adminDb.workItem.findUniqueOrThrow({ where: { id } });

    const claim = await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx);

    if (claim.outcome === 'claimed') {
      expect(PR_REASONS).toContain(value.fixReason);
    } else {
      expect(claim.outcome).toBe('not_repairable');
      expect(value).toEqual({ fixReason: null, fixDetail: null });
    }
    expect(await stored(id)).toEqual(value);
  });
});

describe('priority — the first reason that holds is stored', () => {
  it('queue failure > conflict > red, with the affected count per reason', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr: ejected } = await cardWith(fx, 'implemented', { Vitest: 'failure' });
    const conflicted = await deliveredPr(fx, card.id, repo, {
      headRef: 'b',
      checks: { Vitest: 'success' },
    });
    await conflict(conflicted.id);
    const red = await deliveredPr(fx, card.id, repo, {
      headRef: 'c',
      checks: { Vitest: 'failure' },
    });
    await deliveredPr(fx, card.id, repo, { headRef: 'd', checks: { Vitest: 'success' } });

    await exitOn(ejected.id);
    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'queue_failed',
      fixDetail: { affected: 1, total: 4 },
    });

    await adminDb.githubPullRequestQueueExit.deleteMany({ where: { pullRequestId: ejected.id } });
    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'conflicted',
      fixDetail: { affected: 1, total: 4 },
    });

    await adminDb.githubPullRequest.update({
      where: { id: conflicted.id },
      data: { mergeableState: 'clean' },
    });
    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'ci_failed',
      fixDetail: { affected: 2, total: 4 },
    });
    expect(red.id).toBeTruthy();
  });

  it('a pull-request reason outranks a standing Request changes', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'implemented', { Vitest: 'failure' });
    await requestChanges(fx, card.id, versionOf(repo.name, pr.number));

    expect((await recompute(fx, card.id)).fixReason).toBe('ci_failed');
  });
});

describe('each clearing condition', () => {
  it('a green push clears ci_failed', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await cardWith(fx, 'implemented', { Vitest: 'failure' });
    expect((await recompute(fx, card.id)).fixReason).toBe('ci_failed');

    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: pr.id,
        commitSha: 'd'.repeat(40),
        checkName: 'Vitest',
        conclusion: 'success',
      },
    });

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
    expect(await stored(card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('a resolved conflict clears conflicted', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await cardWith(fx, 'implemented');
    await conflict(pr.id);
    expect((await recompute(fx, card.id)).fixReason).toBe('conflicted');

    await adminDb.githubPullRequest.update({
      where: { id: pr.id },
      data: { mergeableState: 'clean' },
    });

    expect((await recompute(fx, card.id)).fixReason).toBeNull();
  });

  it('a new commit after changes were requested clears it — and the card then waits on CI', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await requestChanges(fx, card.id, versionOf(repo.name, pr.number));
    expect((await recompute(fx, card.id)).fixReason).toBe('changes_requested');

    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: pr.id,
        commitSha: 'e'.repeat(40),
        checkName: 'Vitest',
        conclusion: 'pending',
      },
    });

    expect((await recompute(fx, card.id)).fixReason).toBeNull();
  });

  it('a later approval of the same set clears a Request changes', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    const version = versionOf(repo.name, pr.number);
    await requestChanges(fx, card.id, version);
    await requestChanges(fx, card.id, version, {
      state: 'approved',
      decidedAt: new Date('2026-09-26T11:00:00Z'),
    });

    expect((await recompute(fx, card.id)).fixReason).toBeNull();
  });

  it.each(['done', 'cancelled', 'todo'])('a card moved to `%s` reads nothing', async (status) => {
    const fx = await makeWorkItemFixture();
    const { card } = await cardWith(fx, 'implemented', { Vitest: 'failure' });
    expect((await recompute(fx, card.id)).fixReason).toBe('ci_failed');

    await setStatus(card.id, status);

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
  });

  it('an archived card reads nothing, even with a standing Request changes', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await requestChanges(fx, card.id, versionOf(repo.name, pr.number));
    expect((await recompute(fx, card.id)).fixReason).toBe('changes_requested');

    await adminDb.workItem.update({ where: { id: card.id }, data: { archivedAt: new Date() } });

    expect((await recompute(fx, card.id)).fixReason).toBeNull();
  });

  it('a refusal of a DIFFERENT kind is not a changes_requested reason', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await requestChanges(fx, card.id, versionOf(repo.name, pr.number), { kind: 'design_result' });

    expect((await recompute(fx, card.id)).fixReason).toBeNull();
  });
});

describe('the write', () => {
  it('writes nothing when the answer has not moved', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await cardWith(fx, 'implemented', { Vitest: 'failure' });
    await recompute(fx, card.id);
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });

    await recompute(fx, card.id);

    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('a card no transaction can see reads nothing and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    expect(await recompute(fx, 'no-such-card')).toEqual({ fixReason: null, fixDetail: null });
  });

  it('two recomputes racing on one card store what a serial recompute would', async () => {
    await warmPool();
    const fx = await makeWorkItemFixture();
    const { card, repo } = await cardWith(fx, 'implemented');
    // Two events land at once: a red check on a second member, and a conflict on a third.
    const second = await deliveredPr(fx, card.id, repo, { headRef: 'b', checks: {} });
    const third = await deliveredPr(fx, card.id, repo, {
      headRef: 'c',
      checks: { Vitest: 'success' },
    });

    await Promise.all([
      withWorkspaceContext({ userId: fx.ownerId, workspaceId: fx.workspaceId }, async (tx) => {
        await tx.githubCheckRun.create({
          data: {
            pullRequestId: second.id,
            commitSha: HEAD,
            checkName: 'Vitest',
            conclusion: 'failure',
          },
        });
        return recomputeWorkItemFixReason(card.id, tx);
      }),
      withWorkspaceContext({ userId: fx.ownerId, workspaceId: fx.workspaceId }, async (tx) => {
        await tx.githubPullRequest.update({
          where: { id: third.id },
          data: { mergeableState: 'dirty', mergeableStateHeadSha: HEAD },
        });
        return recomputeWorkItemFixReason(card.id, tx);
      }),
    ]);

    const serial = await recompute(fx, card.id);
    expect(serial.fixReason).toBe('conflicted');
    expect(await stored(card.id)).toEqual(serial);
  });
});
