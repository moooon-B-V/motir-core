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

// THE CONVERGENCE OF CARDS EJECTED BEFORE THE RE-ASK SHIPPED (Story MOTIR-5799 ·
// MOTIR-5809; `approval-gates.md` §4 FOURTH AMENDMENT, point 7), on a REAL Postgres.
//
// Each card is built in the shape the OLD ejection arm left it — a person approved it,
// the queue threw a pull request out for a failure, and the card was moved to
// `implemented` with no gate — plus the four shapes the sweep must leave alone and one
// it must not even look at. The sweep is asserted to converge exactly one, and to
// converge it through the re-ask entry point rather than a copy of it.

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
  opts: { disposition?: 'failure' | 'neutral'; headSha?: string } = {},
) {
  return adminDb.githubPullRequestQueueExit.create({
    data: {
      pullRequestId,
      deliveryId: `guid-${randomToken(8)}`,
      rawReason: opts.disposition === 'neutral' ? 'MANUAL' : 'CI_FAILURE',
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

async function fiveCards() {
  const manual = await makeWorkItemFixture({ name: 'Manual', identifier: 'MAN' });
  await setMode(manual, 'manual');
  const auto = await makeWorkItemFixture({ name: 'Auto', identifier: 'AUT' });
  await setMode(auto, 'auto');

  const atHead = await strandedCard(manual, 'at-head');
  const moved = await strandedCard(manual, 'head-moved', 'a'.repeat(40));
  const inAuto = await strandedCard(auto, 'auto-mode');
  // A NEUTRAL exit: somebody took it out. Not a failure, so not a candidate at all.
  const neutral = await greenCard(manual, 'neutral');
  await exitOn(neutral.pr.id, { disposition: 'neutral' });
  // What a live ejection now leaves: in_review, asking, with the failure standing.
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

  return { atHead, moved, inAuto, neutral, alreadyAsked, unapproved };
}

describe('ejectedCardConvergenceService.converge', () => {
  it('the DRY RUN classifies the fixture — 1 converged and one skip per reason — and changes no row', async () => {
    const cards = await fiveCards();
    const before = {
      statuses: await adminDb.workItem.findMany({ orderBy: { id: 'asc' } }),
      gates: await adminDb.approvalGate.findMany({ orderBy: { id: 'asc' } }),
      exits: await adminDb.githubPullRequestQueueExit.findMany({ orderBy: { id: 'asc' } }),
    };

    const report = await ejectedCardConvergenceService.converge({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.converged.map((c) => c.workItemId)).toEqual([cards.atHead.card.id]);
    const reasonOf = (id: string) => report.skipped.find((s) => s.workItemId === id)?.reason;
    expect(reasonOf(cards.moved.card.id)).toBe('head_moved');
    expect(reasonOf(cards.inAuto.card.id)).toBe('auto_mode');
    expect(reasonOf(cards.alreadyAsked.card.id)).toBe('already_in_review');
    expect(reasonOf(cards.unapproved.card.id)).toBe('no_approved_gate');
    // The neutral card is not a candidate: its only exit is not a failure.
    expect(reasonOf(cards.neutral.card.id)).toBeUndefined();
    expect(report.scanned).toBe(5);

    expect(await adminDb.workItem.findMany({ orderBy: { id: 'asc' } })).toEqual(before.statuses);
    expect(await adminDb.approvalGate.findMany({ orderBy: { id: 'asc' } })).toEqual(before.gates);
    expect(await adminDb.githubPullRequestQueueExit.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before.exits,
    );
  });

  it('APPLY converges exactly the one card — in_review, ONE awaiting gate, the old gate unchanged — and a second apply converges 0', async () => {
    const cards = await fiveCards();
    const oldGate = await adminDb.approvalGate.findUniqueOrThrow({
      where: { id: cards.atHead.gate.id },
    });

    const report = await ejectedCardConvergenceService.converge({ dryRun: false });

    expect(report.failed).toEqual([]);
    expect(report.converged.map((c) => c.workItemId)).toEqual([cards.atHead.card.id]);
    expect(await statusOf(cards.atHead.card.id)).toBe('in_review');
    const [fresh, ...more] = await awaiting(cards.atHead.card.id);
    expect(more).toEqual([]);
    expect(fresh).toMatchObject({ subjectVersion: oldGate.subjectVersion });
    expect(
      await adminDb.approvalGate.findUniqueOrThrow({ where: { id: cards.atHead.gate.id } }),
    ).toEqual(oldGate);
    // The skipped cards are exactly where they were.
    expect(await statusOf(cards.moved.card.id)).toBe('implemented');
    expect(await statusOf(cards.inAuto.card.id)).toBe('implemented');
    expect(await statusOf(cards.unapproved.card.id)).toBe('implemented');
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
    expect(source).toContain('reaskMergeAfterEjection(item, ctx, tx)');
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
    expect(yml).toContain('pnpm db:converge:ejected-cards --dry-run');
  });
});
