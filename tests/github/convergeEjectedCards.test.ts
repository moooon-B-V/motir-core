import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: vi.fn(async () => {}) }));

import { db } from '@/lib/db';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { ejectedCardConvergenceService } from '@/lib/services/ejectedCardConvergenceService';
import { randomToken } from '../helpers/random';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';

// THE CONVERGENCE OF THE CARDS THE OLD RULES LEFT STRANDED (Story MOTIR-5799 ·
// MOTIR-5809; `approval-gates.md` §4 FOURTH AMENDMENT, point 9), on a REAL Postgres.
//
// One card is built per POPULATION — A: Implemented with a retryable exit · B:
// Implemented with a conflict (already right) · C: Approved with a neutral removal ·
// D: Approved with a member that never landed and carries no outcome, under an old
// approval — plus the shapes the sweep must leave alone. The sweep is asserted to move
// A, C and D, to count B, and to do it through the one entry point rather than a copy.

const HEAD = 'c'.repeat(40);
const KIND = 'pull_request_approval';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function exitOn(
  pullRequestId: string,
  opts: { disposition?: 'failure' | 'neutral'; headSha?: string; rawReason?: string } = {},
) {
  return adminDb.githubPullRequestQueueExit.create({
    data: {
      pullRequestId,
      deliveryId: `guid-${randomToken(8)}`,
      rawReason: opts.rawReason ?? (opts.disposition === 'neutral' ? 'MANUAL' : 'CI_FAILURE'),
      disposition: opts.disposition ?? 'failure',
      headSha: opts.headSha ?? HEAD,
      exitedAt: new Date(Date.now() + 60_000),
    },
  });
}

/**
 * A card delivered by ONE green pull request, green-promoted to `in_review` with its
 * awaiting gate raised the shipped way — then, unless `approve` is false, APPROVED.
 */
async function greenCard(fx: WorkItemFixture, title: string, approve = true) {
  const card = await createTestWorkItem(fx, { kind: 'task', title });
  const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
  const pr = await deliveredPr(fx, card.id, repo, {
    headRef: `subtask/${title}`,
    checks: { Vitest: 'success' },
  });
  await setStatus(card.id, 'in_review');
  const gate = await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: card.id,
      kind: KIND,
      subjectId: card.id,
      subjectVersion: `acme/${repo.name}#${pr.number}@${HEAD}`,
      routedToId: fx.ownerId,
    },
  });
  if (approve) {
    await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );
  }
  return { card, pr, gate };
}

/** The shape the OLD arm left: approved, ejected for a failure, moved to implemented. */
async function strandedCard(fx: WorkItemFixture, title: string, exitHead = HEAD) {
  const built = await greenCard(fx, title);
  await exitOn(built.pr.id, { headSha: exitHead });
  await setStatus(built.card.id, 'implemented');
  return built;
}

async function setMode(fx: WorkItemFixture, mode: 'manual' | 'auto') {
  await adminDb.project.update({ where: { id: fx.projectId }, data: { prMergeMode: mode } });
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const awaiting = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId, kind: KIND, state: 'awaiting' } });

/** An `approved` card whose gate was decided LONG ago, with one open member carrying no
 *  outcome at all — what a host refusal looked like before MOTIR-5833 recorded one. */
async function unrecordedRefusalCard(fx: WorkItemFixture, title: string, decidedMinutesAgo = 30) {
  const card = await createTestWorkItem(fx, { kind: 'task', title });
  const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
  const pr = await deliveredPr(fx, card.id, repo, {
    headRef: `subtask/${title}`,
    checks: { Vitest: 'success' },
  });
  await setStatus(card.id, 'in_review');
  // Created already-decided: a decided gate is immutable, so its `decidedAt` cannot be
  // aged afterwards.
  const gate = await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: card.id,
      kind: KIND,
      subjectId: card.id,
      subjectVersion: `acme/${repo.name}#${pr.number}@${HEAD}`,
      routedToId: fx.ownerId,
      state: 'approved',
      decidedById: fx.ownerId,
      decidedAt: new Date(Date.now() - decidedMinutesAgo * 60_000),
    },
  });
  await setStatus(card.id, 'approved');
  return { card, pr, gate };
}

async function theFixture() {
  const manual = await makeWorkItemFixture({ name: 'Manual', identifier: 'MAN' });
  await setMode(manual, 'manual');
  const auto = await makeWorkItemFixture({ name: 'Auto', identifier: 'AUT' });
  await setMode(auto, 'auto');

  // A · implemented, a RETRYABLE exit standing at the head.
  const atHead = await strandedCard(manual, 'at-head');
  // B · implemented, a CONFLICT: already where the new rules put it.
  const conflict = await greenCard(manual, 'conflict');
  await exitOn(conflict.pr.id, { rawReason: 'MERGE_CONFLICT' });
  await setStatus(conflict.card.id, 'implemented');
  // C · approved, a NEUTRAL removal standing: the removal spent the approval.
  const neutral = await greenCard(manual, 'neutral');
  await exitOn(neutral.pr.id, { disposition: 'neutral' });
  await setStatus(neutral.card.id, 'approved');
  // D · approved, an un-landed member with NO outcome under an old approval.
  const unrecorded = await unrecordedRefusalCard(manual, 'unrecorded');

  // …and the shapes the sweep must leave alone.
  const moved = await strandedCard(manual, 'head-moved', 'a'.repeat(40));
  const inAuto = await strandedCard(auto, 'auto-mode');
  const alreadyAsked = await greenCard(manual, 'already-in-review');
  await exitOn(alreadyAsked.pr.id);
  await adminDb.approvalGate.create({
    data: {
      workspaceId: manual.workspaceId,
      projectId: manual.projectId,
      workItemId: alreadyAsked.card.id,
      kind: KIND,
      subjectId: alreadyAsked.card.id,
      subjectVersion: alreadyAsked.gate.subjectVersion,
      routedToId: manual.ownerId,
    },
  });
  await setStatus(alreadyAsked.card.id, 'in_review');
  // Stranded, but nobody ever said yes: its latest merge gate still awaits.
  const unapproved = await greenCard(manual, 'no-approved-gate', false);
  await exitOn(unapproved.pr.id);
  await setStatus(unapproved.card.id, 'implemented');
  // A press that may still be in flight: approved a minute ago.
  const tooRecent = await unrecordedRefusalCard(manual, 'too-recent', 1);

  return {
    atHead,
    conflict,
    neutral,
    unrecorded,
    moved,
    inAuto,
    alreadyAsked,
    unapproved,
    tooRecent,
  };
}

describe('ejectedCardConvergenceService.converge', () => {
  it('the DRY RUN classifies all four populations — and changes no row', async () => {
    const cards = await theFixture();
    const before = {
      statuses: await adminDb.workItem.findMany({ orderBy: { id: 'asc' } }),
      gates: await adminDb.approvalGate.findMany({ orderBy: { id: 'asc' } }),
      exits: await adminDb.githubPullRequestQueueExit.findMany({ orderBy: { id: 'asc' } }),
      refusals: await adminDb.githubPullRequestMergeRefusal.findMany({ orderBy: { id: 'asc' } }),
    };

    const report = await ejectedCardConvergenceService.converge({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.failed).toEqual([]);
    const converged = new Set(report.converged.map((c) => c.workItemId));
    // A, C and D are moved; B is counted where it already is.
    expect(converged.has(cards.atHead.card.id)).toBe(true);
    expect(converged.has(cards.neutral.card.id)).toBe(true);
    expect(converged.has(cards.unrecorded.card.id)).toBe(true);
    expect(converged.has(cards.conflict.card.id)).toBe(false);
    const reasonOf = (id: string) => report.skipped.find((s) => s.workItemId === id)?.reason;
    expect(reasonOf(cards.conflict.card.id)).toBe('cant_land_held');
    expect(reasonOf(cards.moved.card.id)).toBe('head_moved');
    expect(reasonOf(cards.inAuto.card.id)).toBe('auto_mode');
    expect(reasonOf(cards.alreadyAsked.card.id)).toBe('already_in_review');
    expect(reasonOf(cards.unapproved.card.id)).toBe('no_approved_gate');
    expect(reasonOf(cards.tooRecent.card.id)).toBe('too_recent');

    expect(await adminDb.workItem.findMany({ orderBy: { id: 'asc' } })).toEqual(before.statuses);
    expect(await adminDb.approvalGate.findMany({ orderBy: { id: 'asc' } })).toEqual(before.gates);
    expect(await adminDb.githubPullRequestQueueExit.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before.exits,
    );
    expect(
      await adminDb.githubPullRequestMergeRefusal.findMany({ orderBy: { id: 'asc' } }),
    ).toEqual(before.refusals);
  });

  it('APPLY moves A, C and D, leaves B where it is, and a second apply converges 0', async () => {
    const cards = await theFixture();
    const oldGate = await adminDb.approvalGate.findUniqueOrThrow({
      where: { id: cards.atHead.gate.id },
    });

    const report = await ejectedCardConvergenceService.converge({ dryRun: false });

    expect(report.failed).toEqual([]);
    // A — asked again, with ONE fresh gate over the same commits.
    expect(await statusOf(cards.atHead.card.id)).toBe('in_review');
    const [fresh, ...more] = await awaiting(cards.atHead.card.id);
    expect(more).toEqual([]);
    expect(fresh).toMatchObject({ subjectVersion: oldGate.subjectVersion });
    expect(
      await adminDb.approvalGate.findUniqueOrThrow({ where: { id: cards.atHead.gate.id } }),
    ).toEqual(oldGate);
    // B — the conflict holds it at Implemented, and nothing is asked.
    expect(await statusOf(cards.conflict.card.id)).toBe('implemented');
    expect(await awaiting(cards.conflict.card.id)).toEqual([]);
    // C — the neutral removal spent the approval, so the card asks again.
    expect(await statusOf(cards.neutral.card.id)).toBe('in_review');
    expect(await awaiting(cards.neutral.card.id)).toHaveLength(1);
    // D — the refusal nobody recorded becomes a row, classed retryable, and asks again.
    expect(await statusOf(cards.unrecorded.card.id)).toBe('in_review');
    expect(await awaiting(cards.unrecorded.card.id)).toHaveLength(1);
    expect(
      await adminDb.githubPullRequestMergeRefusal.findMany({
        where: { pullRequestId: cards.unrecorded.pr.id },
      }),
    ).toEqual([expect.objectContaining({ code: 'unrecorded', supersededAt: null })]);
    // The skipped cards are exactly where they were.
    expect(await statusOf(cards.moved.card.id)).toBe('implemented');
    expect(await statusOf(cards.inAuto.card.id)).toBe('implemented');
    expect(await statusOf(cards.unapproved.card.id)).toBe('implemented');
    expect(await statusOf(cards.tooRecent.card.id)).toBe('approved');
    expect(await awaiting(cards.alreadyAsked.card.id)).toHaveLength(1);

    const again = await ejectedCardConvergenceService.converge({ dryRun: false });
    expect(again.converged).toEqual([]);
    expect(again.skipped.find((s) => s.workItemId === cards.atHead.card.id)?.reason).toBe(
      'already_in_review',
    );
    expect(await awaiting(cards.atHead.card.id)).toHaveLength(1);
  });

  it('calls the re-ask entry point and carries no copy of the move or the raise', () => {
    const source = readFileSync(
      join(process.cwd(), 'lib/services/ejectedCardConvergenceService.ts'),
      'utf8',
    );
    const script = readFileSync(join(process.cwd(), 'scripts/converge-ejected-cards.ts'), 'utf8');
    expect(source).toContain('settleUnlandedOutcome(item, landingClass, ctx, tx)');
    for (const text of [source, script]) {
      expect(text).not.toMatch(/applyStatusTransition\s*\(/);
      expect(text).not.toMatch(/approvalGateRepository\.create\s*\(/);
      expect(text).not.toMatch(/reconcileGatesFor\s*\(/);
    }
  });

  it('the workflow is a workflow_dispatch whose dry_run input defaults to true', () => {
    const yml = readFileSync(
      join(process.cwd(), '.github/workflows/converge-ejected-cards.yml'),
      'utf8',
    );
    expect(yml).toMatch(/workflow_dispatch:\s*\n\s*inputs:\s*\n\s*dry_run:/);
    expect(yml).toMatch(/dry_run:[\s\S]*?default: true/);
    expect(yml).toContain('pnpm db:converge:unlanded-cards --dry-run');
  });
});
