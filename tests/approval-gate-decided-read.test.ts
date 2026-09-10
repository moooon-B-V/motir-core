import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// THE DECIDED GATE'S READ (Story MOTIR-4778 · Subtask MOTIR-5033) — the frame's
// states `E` and `G` surviving a page reload, against a REAL Postgres.
//
// MOTIR-4792's frame read only the AWAITING set, so the instant somebody
// decided, the whole record left the screen: who decided, when, on WHICH bytes,
// and whether those bytes were kept. The pin ADR §6c writes to keep an approved
// version's files then had no visible consumer at all — which is the fastest
// way for a pin to be quietly removed by somebody reclaiming storage.
//
// What is load-bearing here:
//
//   · A LIVE QUESTION OUTRANKS A DECIDED ONE. A card approved, reopened and
//     republished holds three gates and exactly one can be acted on. Sorting
//     on recency alone happens to agree today — the republish creates its gate
//     after superseding the old one, in the same transaction — so this asserts
//     the RULE rather than the coincidence.
//   · APPROVALS ACCUMULATE AND EARLIER PINS ARE NEVER RELEASED (ADR §6d/§6c).
//     Only one approval is current, so it is natural to write the pin as a
//     single current value; a card approved twice has two real approvals about
//     two sets of bytes, and releasing the first when the second lands destroys
//     the older evidence at exactly the moment the history became interesting.
//     Asserted past the FLAG, through the real orphan-GC — `pinnedAt !== null`
//     would pass with the predicate wired backwards.
//   · THE SUBJECT IS READ BY THE GATE'S OWN `subjectId`. This is the assertion
//     that stops the port being "simplified" back to the card's current design,
//     which would silently re-point a finished decision at bytes nobody
//     approved while the screen looked completely right.
//
// ⚠️ ONE `vi.mock`, the same narrow one `tests/approval-gate-retention.test.ts`
// records: `@/lib/blob/uploader` is the ONE external. No network, and
// `headPrivateBlob` is what makes a publish's authoritative size/type read
// answerable. `deleteAttachmentBlob` is stubbed so the GC sweep can run.

const store = new Map<string, { contentType: string; size: number }>();
const deletedBlobs: string[] = [];

vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(async (pathname: string) => {
    deletedBlobs.push(pathname);
  }),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { attachmentsService, ORPHAN_SAFETY_WINDOW_MS } =
  await import('@/lib/services/attachmentsService');
const { approvalGateRepository } = await import('@/lib/repositories/approvalGateRepository');
const { workItemsService } = await import('@/lib/services/workItemsService');

let fx: WorkItemFixture;
let card: WorkItem;

beforeEach(async () => {
  store.clear();
  deletedBlobs.length = 0;
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Approve a design' },
    fx.ctx,
  );
  const subtask = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Draw the frame' },
    fx.ctx,
  );
  // In Review is where a published design waiting for a decision actually sits,
  // and it is what makes the design gate's own effect (`in_review → done`) a
  // legal edge — so these tests drive the real approve path.
  await workItemsService.updateStatus(subtask.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(subtask.id, 'in_review', fx.ctx);
  card = await adminDb.workItem.findUniqueOrThrow({ where: { id: subtask.id } });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Publish one design version; returns the evidence DTO the publish recorded. */
async function publish(label: string) {
  const pathname = `${designPrefix(fx.workspaceId, card.id)}${label}.mock.html`;
  store.set(pathname, { contentType: 'text/html', size: 2048 });
  return designEvidenceService.recordFromPathnames(
    {
      workItemId: card.id,
      assets: [{ kind: 'mock', sourcePath: `design/work-items/${label}.mock.html`, pathname }],
      commitSha: `sha-${label}`,
    },
    fx.ctx,
  );
}

/** The gate the publish path wrote for a given version. */
async function gateFor(evidenceId: string) {
  return adminDb.approvalGate.findFirstOrThrow({ where: { subjectId: evidenceId } });
}

/** Run the REAL orphan-GC over rows aged past the safety window. Nothing short
 *  of this distinguishes "not unlinked" from "unlinked, sweep not yet run". */
async function ageAndSweep() {
  await adminDb.attachment.updateMany({
    data: { createdAt: new Date(Date.now() - ORPHAN_SAFETY_WINDOW_MS - 60_000) },
  });
  return attachmentsService.sweepOrphanAttachments();
}

/** Reopen an approved card so it can be republished and approved again — the
 *  human half of the cycle (`done → in_progress` is a declared transition). */
async function reopen() {
  await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(card.id, 'in_review', fx.ctx);
}

describe('the frame reads a gate WHATEVER its state', () => {
  it('keeps the APPROVED gate on the card after the decision — state `E` survives a reload', async () => {
    const v1 = await publish('v1');
    const v1Gate = await gateFor(v1.id);
    await approvalGatesService.decide(
      { gateId: v1Gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: card.id, kind: 'design_result' },
      fx.ctx,
    );

    expect(read.gate?.id).toBe(v1Gate.id);
    expect(read.gate?.state).toBe('approved');
    expect(read.gate?.decidedAt).not.toBeNull();
    // The awaiting-only read is where the record used to disappear.
    const awaiting = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: card.id, kind: 'design_result' },
      fx.ctx,
    );
    expect(awaiting.gate).toBeNull();
  });

  it('keeps a CHANGES-REQUESTED gate too — state `F`', async () => {
    const v1 = await publish('v1');
    const v1Gate = await gateFor(v1.id);
    await approvalGatesService.decide(
      { gateId: v1Gate.id, decision: 'request_changes', source: 'ui' },
      fx.ctx,
    );

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: card.id, kind: 'design_result' },
      fx.ctx,
    );
    expect(read.gate?.state).toBe('changes_requested');
  });

  it('returns a SUPERSEDED gate when there is no live question — state `G`', async () => {
    const v1 = await publish('v1');
    const v1Gate = await gateFor(v1.id);
    // The product's own withdrawal, written by the publish path (MOTIR-4913).
    // Driven directly here because the shipped republish writes a REPLACEMENT
    // gate in the same transaction, so it never leaves a card whose only gate
    // is superseded — see this suite's next test, and the finding in the pull
    // request body.
    await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.supersedeAwaitingByWorkItem(card.id, 'design_result', tx),
    );

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: card.id, kind: 'design_result' },
      fx.ctx,
    );
    expect(read.gate?.id).toBe(v1Gate.id);
    expect(read.gate?.state).toBe('superseded');
    // A withdrawn question names nobody — the frame's `G` depends on it.
    expect(read.gate?.decidedById).toBeNull();
    expect(read.gate?.decidedAt).toBeNull();
    expect(read.gate?.noteMd).toBeNull();
  });

  it('a LIVE question outranks a decided one, however much older it is', async () => {
    const v1 = await publish('v1');
    await approvalGatesService.decide(
      { gateId: (await gateFor(v1.id)).id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );
    await reopen();
    const v2 = await publish('v2');

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: card.id, kind: 'design_result' },
      fx.ctx,
    );

    // Two gates exist — v1's approved one and v2's new awaiting one (the
    // republish's supersede matches no `awaiting` row once v1 was decided) —
    // and the only one anybody can act on is v2's.
    expect(await adminDb.approvalGate.count({ where: { workItemId: card.id } })).toBe(2);
    expect(read.gate?.subjectId).toBe(v2.id);
    expect(read.gate?.state).toBe('awaiting');
  });

  it('does not leak a gate across workspaces', async () => {
    const v1 = await publish('v1');
    await gateFor(v1.id);
    const other = await makeWorkItemFixture();

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: card.id, kind: 'design_result' },
      other.ctx,
    );
    expect(read.gate).toBeNull();
    expect(read.canDecide).toBe(false);
  });
});

describe('approvals ACCUMULATE — approve, reopen, republish, approve again', () => {
  it('leaves BOTH approvals naming their OWN version, with neither pin released', async () => {
    // ⚠️ THE FULL CYCLE, and the assertion that matters is the FIRST version's.
    // Writing the pin as a single current value passes every other test in this
    // repository and destroys the older evidence here.
    const v1 = await publish('v1');
    const v1Gate = await gateFor(v1.id);
    await approvalGatesService.decide(
      { gateId: v1Gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    await reopen();
    const v2 = await publish('v2');
    const v2Gate = await gateFor(v2.id);
    await approvalGatesService.decide(
      { gateId: v2Gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    // TWO approved gates, each about its OWN bytes.
    const approved = await adminDb.approvalGate.findMany({
      where: { workItemId: card.id, state: 'approved' },
      orderBy: { createdAt: 'asc' },
    });
    expect(approved).toHaveLength(2);
    expect(approved.map((g) => g.subjectId)).toEqual([v1.id, v2.id]);

    // NEITHER pin was released — asserted past the flag, through the real GC.
    const summary = await ageAndSweep();
    expect(summary.deleted).toBe(0);
    expect(deletedBlobs).toEqual([]);
    for (const id of [v1.id, v2.id]) {
      const row = await adminDb.designEvidence.findUniqueOrThrow({ where: { id } });
      expect(row.pinnedAt).not.toBeNull();
    }
  });

  it('the PORT addresses the PINNED version, not the current one', async () => {
    // The criterion the design calls load-bearing: `E` keeps showing the
    // approved version even after a newer design is published.
    const v1 = await publish('v1');
    const v1Gate = await gateFor(v1.id);
    await approvalGatesService.decide(
      { gateId: v1Gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );
    await reopen();
    const v2 = await publish('v2');

    const subject = await designEvidenceService.getForGateSubject(
      { workItemId: card.id, subjectId: v1Gate.subjectId },
      fx.ctx,
    );
    const current = await designEvidenceService.getCurrentForWorkItem(card.id, fx.ctx);

    // The two DIFFER, which is the whole point — and the pinned one is v1.
    expect(current!.id).toBe(v2.id);
    expect(subject.evidence!.id).toBe(v1.id);
    expect(subject.evidence!.commitSha).toBe('sha-v1');
    expect(subject.filesKept).toBe(true);
  });

  it('says the files are NOT kept when the version was sent back', async () => {
    // Only an APPROVAL pins (§6c), so a rejected version is reclaimed on
    // purpose — and the line has to say so rather than reassure.
    const v1 = await publish('v1');
    const v1Gate = await gateFor(v1.id);
    await approvalGatesService.decide(
      { gateId: v1Gate.id, decision: 'request_changes', source: 'ui' },
      fx.ctx,
    );

    const subject = await designEvidenceService.getForGateSubject(
      { workItemId: card.id, subjectId: v1Gate.subjectId },
      fx.ctx,
    );
    expect(subject.evidence!.id).toBe(v1.id);
    expect(subject.filesKept).toBe(false);
  });

  it('refuses a subject that belongs to ANOTHER card', async () => {
    // `subjectId` is an opaque cuid taken off a gate row; the gate and the
    // evidence are joined by convention alone. RLS already hides another
    // workspace's row — this closes the cross-CARD case inside one workspace,
    // where nothing else would.
    const v1 = await publish('v1');
    const otherCard = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'A different card' },
      fx.ctx,
    );

    const subject = await designEvidenceService.getForGateSubject(
      { workItemId: otherCard.id, subjectId: v1.id },
      fx.ctx,
    );
    expect(subject.evidence).toBeNull();
    expect(subject.filesKept).toBe(false);
  });
});
