import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { presentWorkItemRepairClaim } from '@/lib/api/v1/workLoop/schema';
import { db } from '@/lib/db';
import { recomputeWorkItemFixReason } from '@/lib/services/fixReasonService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { REVIEW_AGENT_REVIEWER_NAME } from '@/lib/workItems/fixReason';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';

// THE `review` REPAIR CLASS (Story MOTIR-1626 · MOTIR-6822; `approval-gates.md` §12.4,
// §12.7), over real Postgres.
//
// A card a REVIEW sent back — the review agent's `changes_requested` on `agent_review`,
// or a person's Request changes on the approve-and-merge gate — at the delivery set's
// CURRENT version is claimable by `motir fix` though its checks are green, and the claim
// carries the findings in full and who sent it back. The To fix column agrees with the
// claim (`repair: 'fix'` for both kinds), a refusal about an OLDER version admits
// nothing, and a push — a head move — clears the reason without touching the decision.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const HEAD = 'c'.repeat(40); // the head `deliveredPr` writes its check rows at
const versionOf = (repoName: string, number: number, head = HEAD) =>
  `acme/${repoName}#${number}@${head}`;

const FINDINGS = [
  '1. `exportCsv` drops the header row when the list is empty.',
  '2. The new route has no tenant check — read `projectAccessService.assertCanBrowse`.',
  '',
  'Both must be fixed before this can merge.',
].join('\n');

const recompute = (fx: WorkItemFixture, workItemId: string) =>
  withWorkspaceContext({ userId: fx.ownerId, workspaceId: fx.workspaceId }, (tx) =>
    recomputeWorkItemFixReason(workItemId, tx),
  );

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

/** A decided review refusal on `workItemId`, about `subjectVersion`. */
async function sentBack(
  fx: WorkItemFixture,
  workItemId: string,
  subjectVersion: string,
  kind: 'agent_review' | 'pull_request_approval',
  opts: { decidedAt?: Date; state?: 'changes_requested' | 'approved' } = {},
) {
  const byAgent = kind === 'agent_review';
  return adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId,
      kind,
      subjectId: workItemId,
      subjectVersion,
      state: opts.state ?? 'changes_requested',
      decidedById: fx.ownerId,
      decidedAt: opts.decidedAt ?? new Date('2026-09-29T10:00:00Z'),
      decidedByLabel: 'Yue Zhu <yue@example.com>',
      decisionSource: 'ui',
      decidedUnderAuthority: byAgent ? 'review_agent' : 'assignee',
      noteMd: FINDINGS,
    },
  });
}

const claimOf = (fx: WorkItemFixture, key: string) =>
  workItemRepairService.claimRepair(fx.projectId, key, fx.ctx);

describe('the `review` class — a green card a review sent back is claimable by `motir fix`', () => {
  it('the review AGENT’s refusal at the current version: claimed, with the FULL findings and the agent named', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    const gate = await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'agent_review');

    const claim = await claimOf(fx, card.identifier);

    expect(claim).toMatchObject({
      outcome: 'claimed',
      reason: null,
      repairClass: 'review',
      acceptanceRefusal: null,
      reviewRefusal: {
        gate: 'agent_review',
        findingsMd: FINDINGS,
        // The agent is named as the agent, never as the run's attributed user (§12.3).
        reviewerName: REVIEW_AGENT_REVIEWER_NAME,
        decidedAt: '2026-09-29T10:00:00.000Z',
      },
    });
    // EVERY open member is handed over — green, on its own branch.
    expect(claim.pullRequests).toEqual([
      expect.objectContaining({ number: pr.number, headRef: pr.headRef, ci: 'passing' }),
    ]);
    // The claim is a `fix` run; the card's status and the decision are untouched.
    expect(await adminDb.dispatchRun.count({ where: { command: 'fix' } })).toBe(1);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).status).toBe(
      'in_review',
    );
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } })).state).toBe(
      'changes_requested',
    );
  });

  it('a PERSON’s Request changes on the approve-and-merge gate: claimed, naming the person', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'pull_request_approval');

    const claim = await claimOf(fx, card.identifier);

    expect(claim).toMatchObject({
      outcome: 'claimed',
      repairClass: 'review',
      reviewRefusal: {
        gate: 'pull_request_approval',
        findingsMd: FINDINGS,
        // The live user row's name — never the gate's `Name <email>` audit label.
        reviewerName: fx.owner.name,
      },
    });
  });

  it('a resumed claim (`mine`) hands the findings again; a rival (`taken`) gets nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'agent_review');
    await claimOf(fx, card.identifier);

    const again = await claimOf(fx, card.identifier);

    expect(again).toMatchObject({ outcome: 'mine', repairClass: 'review' });
    expect(again.reviewRefusal?.findingsMd).toBe(FINDINGS);
    expect(again.pullRequests).toHaveLength(1);
  });

  it('the v1 wire carries the class and the findings field by field', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'agent_review');

    const wire = presentWorkItemRepairClaim(await claimOf(fx, card.identifier));

    expect(wire.repairClass).toBe('review');
    expect(wire.reviewRefusal).toEqual({
      gate: 'agent_review',
      findingsMd: FINDINGS,
      reviewerName: REVIEW_AGENT_REVIEWER_NAME,
      decidedAt: '2026-09-29T10:00:00.000Z',
    });
  });

  it('a red member rides along — the class is still `review`, and To fix names the red check first', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'implemented', { Vitest: 'failure' });
    await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'agent_review');

    // The shipped priority is unchanged: a pull-request reason outranks the refusal.
    expect((await recompute(fx, card.id)).fixReason).toBe('ci_failed');
    const claim = await claimOf(fx, card.identifier);
    expect(claim).toMatchObject({ outcome: 'claimed', repairClass: 'review' });
    expect(claim.pullRequests[0]).toMatchObject({ ci: 'failing', failingChecks: ['Vitest'] });
  });
});

describe('what the class does NOT admit — the existing refusals are unchanged', () => {
  it('a refusal about an OLDER version admits nothing: not_failing, and To fix reads nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await sentBack(fx, card.id, versionOf(repo.name, pr.number, 'a'.repeat(40)), 'agent_review');

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
    expect(await claimOf(fx, card.identifier)).toMatchObject({
      outcome: 'not_repairable',
      reason: 'not_failing',
      repairClass: 'ci',
      reviewRefusal: null,
      pullRequests: [],
    });
  });

  it('a green In Review card with no refusal is still not_failing', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await cardWith(fx, 'in_review');

    expect(await claimOf(fx, card.identifier)).toMatchObject({
      outcome: 'not_repairable',
      reason: 'not_failing',
    });
  });

  it('a later approval of the same version answers the refusal: not_failing', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    const version = versionOf(repo.name, pr.number);
    await sentBack(fx, card.id, version, 'agent_review');
    await sentBack(fx, card.id, version, 'agent_review', {
      state: 'approved',
      decidedAt: new Date('2026-09-29T11:00:00Z'),
    });

    expect(await claimOf(fx, card.identifier)).toMatchObject({ reason: 'not_failing' });
  });

  it('a refusal of a DIFFERENT kind is no review class', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: card.id,
        kind: 'design_result',
        subjectId: card.id,
        subjectVersion: versionOf(repo.name, pr.number),
        state: 'changes_requested',
        decidedById: fx.ownerId,
        decidedAt: new Date('2026-09-29T10:00:00Z'),
        decidedByLabel: 'Yue Zhu',
        decisionSource: 'ui',
        decidedUnderAuthority: 'assignee',
        noteMd: 'Wrong colour.',
      },
    });

    expect(await claimOf(fx, card.identifier)).toMatchObject({ reason: 'not_failing' });
  });

  it.each(['todo', 'in_progress', 'approved', 'done'])(
    'a card at `%s` with a standing refusal is not_implemented',
    async (status) => {
      const fx = await makeWorkItemFixture();
      const { card, repo, pr } = await cardWith(fx, status);
      await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'agent_review');

      expect(await claimOf(fx, card.identifier)).toMatchObject({ reason: 'not_implemented' });
    },
  );

  it('a child that shares its run target’s pull requests is never claimed as a review — it is pointed at the run target', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'the run target' });
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'a child',
      parentId: story.id,
    });
    // At Implemented: an In Review child with green checks is refused `not_failing`
    // before the run target is resolved — the shipped order, which this class leaves alone.
    await setStatus(child.id, 'implemented');
    const repo = await connectRepairRepo(fx, 'web');
    const pr = await deliveredPr(fx, child.id, repo, {
      headRef: 'parent/x',
      checks: { Vitest: 'success' },
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
    await sentBack(fx, child.id, versionOf(repo.name, pr.number), 'agent_review');

    expect(await claimOf(fx, child.identifier)).toMatchObject({
      outcome: 'not_repairable',
      reason: 'repair_on_run_target',
      runTargetKey: story.identifier,
    });
  });
});

describe('To fix agrees with the claim — `repair: fix` for both review kinds', () => {
  it.each([
    ['agent_review', () => REVIEW_AGENT_REVIEWER_NAME],
    ['pull_request_approval', (fx: WorkItemFixture) => fx.owner.name],
  ] as const)('%s → changes_requested, repaired by `motir fix`', async (kind, nameOf) => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await sentBack(fx, card.id, versionOf(repo.name, pr.number), kind);

    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'changes_requested',
      fixDetail: {
        repair: 'fix',
        gate: kind,
        reviewerName: nameOf(fx),
        notePreview: '1. `exportCsv` drops the header row when the list is empty.',
        affected: 1,
        total: 1,
      },
    });
  });
});

describe('the repair’s push clears it', () => {
  it('a head move after the repair clears To fix and the claim, and leaves the decision as it was', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    const gate = await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'agent_review');
    expect((await recompute(fx, card.id)).fixReason).toBe('changes_requested');
    const claim = await claimOf(fx, card.identifier);
    expect(claim.repairClass).toBe('review');

    // The repair pushed: the first check at the NEW head is a new version.
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: pr.id,
        commitSha: 'e'.repeat(40),
        checkName: 'Vitest',
        conclusion: 'pending',
      },
    });

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
    // The decided refusal is history: nothing re-decided, re-opened or superseded it.
    const after = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(after).toMatchObject({ state: 'changes_requested', noteMd: FINDINGS });
    expect(after.decidedAt).toEqual(gate.decidedAt);
    // And nothing re-runs by itself: the only run is the repair the person claimed.
    expect(await adminDb.dispatchRun.count()).toBe(1);
  });
});

describe('the Development block’s fix part — the sent-back surface is MOTIR-6825’s', () => {
  it('a GREEN review claim draws nothing here, as before the class existed', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'agent_review');

    expect(await workItemRepairService.getRepairView(card.id, fx.ctx)).toEqual({
      state: 'hidden',
    });
  });

  it('a review claim with a red member draws that member as the ci part', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'implemented', { Vitest: 'failure' });
    await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'agent_review');

    expect(await workItemRepairService.getRepairView(card.id, fx.ctx)).toMatchObject({
      state: 'offer',
      repairClass: 'ci',
      failing: [{ number: pr.number, ci: 'failing' }],
    });
  });
});
