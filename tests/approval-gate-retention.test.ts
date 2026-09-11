import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateKind, WorkItem } from '@/generated/prisma/client';
import type { GateEffect, GateHandler } from '@/lib/approvalGates/registry';
import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// RETENTION — an APPROVED design version's bytes are PINNED, and a SUPERSEDED
// subject retires its awaiting gate (Story MOTIR-4778 · Subtask MOTIR-4913; ADR
// docs/decisions/approval-gates.md §6b and §6c with its MOTIR-4911 amendment),
// against a REAL Postgres.
//
// The bug this exists to prevent is INVISIBLE FOR A WEEK. The supersede path
// unlinks a superseded row's attachments and the orphan-GC reclaims their blobs
// after a 7-day window, so an approval that failed to pin looks perfectly
// healthy on the day it happens and arrives seven days later as a decision
// pointing at nulls. `lib/acceptanceEvidence/errors.ts` records Motir paying for
// exactly this once already, one domain over.
//
// So the assertions here deliberately go PAST the flag:
//
//   · THE BYTES, NOT THE COLUMN. Every retention test runs the real
//     `sweepOrphanAttachments` with the rows aged past the safety window and
//     then reads the ASSET URLS back through the same mapper the panel renders.
//     Asserting `pinnedAt !== null` would pass with the predicate wired
//     backwards, because the flag and the unlink are different statements.
//   · THE PULL-REQUEST PATH, EXPLICITLY. §6c's amendment exists because keying
//     retention on the `design_result` gate stops pinning for the COMMON case —
//     a design that opened a pull request is approved through
//     `pull_request_approval`. A test that only drives the design gate would pass
//     against the very implementation the amendment forbids.
//   · THE NEGATIVE. `request_changes` must still let the bytes go. A pin that
//     fired on every decision would satisfy every positive assertion above and
//     silently disable the reclaim the product depends on.
//   · THE RACE, with genuine concurrency. A publish and an approval overlapping
//     is the interleaving §6c names; a serial assertion passes with no lock at
//     all, which is precisely the bug.
//
// ⚠️ TWO `vi.mock`s, both narrow, and neither touches the database.
//
//   1. `@/lib/blob/uploader` — the ONE external. Same disposition
//      `tests/design-evidence-routes.test.ts` records: no network, and
//      `headPrivateBlob` is what makes a publish's authoritative size/type read
//      answerable. `deleteAttachmentBlob` is stubbed so the GC sweep can run.
//   2. `@/lib/approvalGates/registry`'s `handlerFor`, for ONE kind. See
//      `stubbedPullRequestApprovalHandler` below — `pull_request_approval` is a
//      declared registry HOLE on `origin/main` (MOTIR-4909 / MOTIR-4910 own it),
//      so `handlerFor` refuses it before the door's transaction opens and the
//      criterion could not otherwise be exercised at all. The stub supplies only
//      what the missing card will: a handler that records a decision and writes
//      no status. Everything the criterion is about — the door, the gate row, the
//      pin, the supersede — runs through the real path.

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

/**
 * What MOTIR-4909 / MOTIR-4910 will register for `pull_request_approval`,
 * reduced to the two things this file needs from it: it resolves nothing and it
 * writes no status (ADR §4 — the MERGE writes `done`, an approval does not).
 *
 * ⚠️ IT DOES NOTHING ABOUT DESIGN EVIDENCE, and that is the whole point of the
 * test it serves. If the pin were a handler's job, this stub would prove it by
 * failing to pin; because the pin is the DOOR's, the bytes survive with no line
 * of code here.
 */
const stubbedPullRequestApprovalHandler: GateHandler = {
  async resolveSubject() {
    return null;
  },
  // MOTIR-4909's card will answer this with the pull request's `headSha`
  // (ADR §6a). Null here, which is the honest stand-in AND the case the door
  // must survive: an unknown version records a null column, never a refusal.
  async subjectVersion() {
    return null;
  },
  routeTo() {
    return null;
  },
  permission: 'work_item:edit',
  statusIntent: null,
  async approve(): Promise<GateEffect> {
    return { statusWritten: null, statusDeferredReason: 'merge_writes_done' };
  },
  async requestChanges(): Promise<GateEffect> {
    return { statusWritten: null, statusDeferredReason: 'request_changes_moves_nothing' };
  },
};

vi.mock('@/lib/approvalGates/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/approvalGates/registry')>();
  return {
    ...actual,
    handlerFor: (kind: ApprovalGateKind) =>
      kind === 'pull_request_approval'
        ? stubbedPullRequestApprovalHandler
        : actual.handlerFor(kind),
  };
});

const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { attachmentsService, ORPHAN_SAFETY_WINDOW_MS } =
  await import('@/lib/services/attachmentsService');
const { approvalGateRepository } = await import('@/lib/repositories/approvalGateRepository');
const { designEvidenceRepository } = await import('@/lib/repositories/designEvidenceRepository');
const { toDesignEvidenceDto } = await import('@/lib/mappers/designEvidenceMappers');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { ApprovalGateSupersededError } = await import('@/lib/approvalGates/errors');

let fx: WorkItemFixture;
let card: WorkItem;

beforeEach(async () => {
  store.clear();
  deletedBlobs.length = 0;
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  // A design subtask hangs under the story it draws (`lib/issues/parentRules.ts`),
  // which is also the real shape a publish arrives at.
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Approve a design' },
    fx.ctx,
  );
  const subtask = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Draw the frame' },
    fx.ctx,
  );
  // The card sits IN REVIEW, which is where a published design waiting for a
  // decision actually is — and it is what makes the design gate's own effect
  // (`in_review → done`) a legal edge, so these tests exercise the real approve
  // path rather than a status the workflow would refuse.
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

/** The `awaiting` gate the publish path wrote for a given version. */
async function gateFor(evidenceId: string) {
  return adminDb.approvalGate.findFirstOrThrow({ where: { subjectId: evidenceId } });
}

/**
 * Put a gate of an arbitrary KIND on the card, so the retention rule can be
 * driven through a door other than `design_result` — which is the case §6c's
 * amendment is about.
 */
async function gateOfKind(kind: ApprovalGateKind, subjectId: string) {
  return withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: card.id,
        kind,
        subjectId,
      },
      tx,
    ),
  );
}

/**
 * Run the REAL orphan-GC over rows aged past the safety window — the mechanism
 * that actually destroys the bytes. Nothing short of this distinguishes "the
 * attachment was not unlinked" from "the attachment was unlinked and the sweep
 * has not come round yet", and the second is the state a broken pin leaves.
 */
async function ageAndSweep() {
  await adminDb.attachment.updateMany({
    data: { createdAt: new Date(Date.now() - ORPHAN_SAFETY_WINDOW_MS - 60_000) },
  });
  return attachmentsService.sweepOrphanAttachments();
}

/** The panel's own view of one version, read back through the shipped mapper. */
async function readBack(evidenceId: string) {
  const row = await withWorkspaceContext(fx.ctx, (tx) =>
    designEvidenceRepository.findById(evidenceId, tx),
  );
  return row ? toDesignEvidenceDto(row) : null;
}

describe('an APPROVED version keeps its bytes across a supersede (ADR §6c)', () => {
  it('survives the republish AND the orphan-GC — the asset URLs still resolve', async () => {
    const v1 = await publish('v1');
    const v1Gate = await gateFor(v1.id);

    await approvalGatesService.decide(
      { gateId: v1Gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );
    await publish('v2');

    const summary = await ageAndSweep();

    // The mapper nulls `url` / `mimeType` / `sizeBytes` the moment the
    // Attachment is gone (`lib/dto/designEvidence.ts`), so a non-null URL here
    // IS the retention guarantee — read from the version's own row, after the
    // sweep that would have destroyed it.
    const pinned = await readBack(v1.id);
    expect(pinned!.assets).toHaveLength(1);
    expect(pinned!.assets[0]!.url).toMatch(/^\/api\/attachments\/.+\/content$/);
    expect(pinned!.assets[0]!.mimeType).toBe('text/html');
    expect(pinned!.assets[0]!.sizeBytes).toBe(2048);
    expect(summary.deleted).toBe(0);
    expect(deletedBlobs).toEqual([]);

    // PIN, not FREEZE (§6c): the supersede still happened.
    const superseded = await adminDb.designEvidence.findUniqueOrThrow({ where: { id: v1.id } });
    expect(superseded.isCurrent).toBe(false);
    expect(superseded.pinnedAt).not.toBeNull();
  });

  it('holds when the approval came through `pull_request_approval` — the case a KIND-keyed pin would miss', async () => {
    // ⚠️ THIS IS THE CRITERION §6c's AMENDMENT EXISTS FOR. A design that opened a
    // pull request is approved through this kind, so an implementation that went
    // looking for an approved `design_result` gate would unlink here exactly as
    // it always did — with no error and no other failing test — and the bytes
    // would be gone a week later.
    const v1 = await publish('v1');
    const prGate = await gateOfKind('pull_request_approval', 'github-pull-request-1');

    await approvalGatesService.decide(
      { gateId: prGate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );
    await publish('v2');
    const summary = await ageAndSweep();

    const pinned = await readBack(v1.id);
    expect(pinned!.assets[0]!.url).not.toBeNull();
    expect(pinned!.assets[0]!.sizeBytes).toBe(2048);
    expect(summary.deleted).toBe(0);

    // And the gate that carried the decision is untouched by any of it — the pin
    // is a fact about the SUBJECT, recorded on the version's own row.
    const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: prGate.id } });
    expect(row.kind).toBe('pull_request_approval');
    expect(row.state).toBe('approved');
  });

  it('re-approving the SAME version keeps the FIRST pin, and a second version pins separately (§6d)', async () => {
    const v1 = await publish('v1');
    await approvalGatesService.decide(
      { gateId: (await gateFor(v1.id)).id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );
    const firstPin = (await adminDb.designEvidence.findUniqueOrThrow({ where: { id: v1.id } }))
      .pinnedAt;

    // A second approval on the same still-current version — a card can carry more
    // than one gate at a time (ADR §4's amendment).
    const second = await gateOfKind('pull_request_approval', 'github-pull-request-1');
    await approvalGatesService.decide(
      { gateId: second.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );
    const afterSecond = (await adminDb.designEvidence.findUniqueOrThrow({ where: { id: v1.id } }))
      .pinnedAt;
    expect(afterSecond?.getTime()).toBe(firstPin?.getTime());

    // Approvals ACCUMULATE across versions: reopen, republish, approve again, and
    // BOTH versions are pinned — never "the approved one".
    const v2 = await publish('v2');
    await approvalGatesService.decide(
      { gateId: (await gateFor(v2.id)).id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );
    const v3 = await publish('v3');
    await ageAndSweep();

    expect((await readBack(v1.id))!.assets[0]!.url).not.toBeNull();
    expect((await readBack(v2.id))!.assets[0]!.url).not.toBeNull();
    expect((await readBack(v3.id))!.assets[0]!.url).not.toBeNull();
  });
});

describe('an UNAPPROVED version still lets its bytes go — the intended loss (ADR §6c)', () => {
  it('`request_changes` leaves the superseded row UNLINKED and the GC reclaims it', async () => {
    // The negative half, and it is load-bearing: a pin that fired on every
    // DECISION rather than on every APPROVAL passes every test above while
    // quietly disabling the reclaim.
    const v1 = await publish('v1');
    const v1Gate = await gateFor(v1.id);

    await approvalGatesService.decide(
      {
        gateId: v1Gate.id,
        decision: 'request_changes',
        source: 'ui',
        noteMd: 'The port is too short.',
      },
      fx.ctx,
    );
    await publish('v2');

    const beforeSweep = await adminDb.designEvidence.findUniqueOrThrow({ where: { id: v1.id } });
    expect(beforeSweep.pinnedAt).toBeNull();

    const summary = await ageAndSweep();
    expect(summary.deleted).toBe(1);
    expect(deletedBlobs).toHaveLength(1);

    // The ROW survives — §6c keeps the record of what was published and who sent
    // it back; only the bytes go.
    const reclaimed = await readBack(v1.id);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.assets).toHaveLength(1);
    expect(reclaimed!.assets[0]!.url).toBeNull();
    expect(reclaimed!.assets[0]!.sizeBytes).toBeNull();

    // And the decision itself is kept in full.
    const gateRow = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: v1Gate.id } });
    expect(gateRow.state).toBe('changes_requested');
    expect(gateRow.noteMd).toBe('The port is too short.');
  });

  it('a version nobody decided at all is reclaimed exactly as before', async () => {
    const v1 = await publish('v1');
    await publish('v2');

    const summary = await ageAndSweep();
    expect(summary.deleted).toBe(1);
    expect((await readBack(v1.id))!.assets[0]!.url).toBeNull();
  });
});

describe('a SUPERSEDED subject retires its AWAITING gate (ADR §6b)', () => {
  it('the prior version’s gate becomes `superseded`, and the new version gets its own `awaiting` one', async () => {
    const v1 = await publish('v1');
    const v1Gate = await gateFor(v1.id);
    expect(v1Gate.state).toBe('awaiting');

    const v2 = await publish('v2');

    const retired = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: v1Gate.id } });
    expect(retired.state).toBe('superseded');

    const fresh = await gateFor(v2.id);
    expect(fresh.state).toBe('awaiting');
    expect(fresh.id).not.toBe(v1Gate.id);
  });

  it('carries NO actor, NO authority and NO note — the audit can never read it as a decision', async () => {
    const v1 = await publish('v1');
    const v1Gate = await gateFor(v1.id);
    await publish('v2');

    const retired = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: v1Gate.id } });
    expect(retired.state).toBe('superseded');
    expect(retired.decidedById).toBeNull();
    expect(retired.decidedAt).toBeNull();
    expect(retired.noteMd).toBeNull();
    // The row is otherwise byte-identical to the one the publish wrote.
    expect(retired.createdAt.getTime()).toBe(v1Gate.createdAt.getTime());
    expect(retired.subjectId).toBe(v1.id);
    expect(retired.kind).toBe('design_result');
  });

  it('disappears from the routing reads — the Approvals tab stops asking about a design that is gone', async () => {
    const v1 = await publish('v1');
    const v1Gate = await gateFor(v1.id);
    const v2 = await publish('v2');

    const byItem = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.findAwaitingByWorkItem(card.id, tx),
    );
    // MOTIR-4791 narrowed `findAwaitingByWorkspace` into the ROUTING read the
    // Approvals tab actually makes — one project, routed to one person, paged.
    // The assertion is unchanged in substance: the superseded gate leaves the
    // routing read. The card is created through `fx.ctx` with no assignee, so
    // §2's `assigneeId ?? reporterId` routes it to that same actor.
    const byRouting = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.findAwaitingRoutedTo(
        { projectIds: [fx.projectId], userId: fx.ctx.userId },
        { skip: 0, take: 50 },
        tx,
      ),
    );

    expect(byItem.map((g) => g.id)).not.toContain(v1Gate.id);
    expect(byItem.map((g) => g.subjectId)).toEqual([v2.id]);
    expect(byRouting.map((g) => g.subjectId)).toEqual([v2.id]);
  });

  it('is refused by the decide door with a typed error — a withdrawn question, not somebody’s answer', async () => {
    const v1 = await publish('v1');
    const v1Gate = await gateFor(v1.id);
    await publish('v2');

    await expect(
      approvalGatesService.decide({ gateId: v1Gate.id, decision: 'approve', source: 'ui' }, fx.ctx),
    ).rejects.toBeInstanceOf(ApprovalGateSupersededError);

    // The refusal wrote nothing: the state is still the product's, not a person's.
    const untouched = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: v1Gate.id } });
    expect(untouched.state).toBe('superseded');
    expect(untouched.decidedById).toBeNull();
  });

  it('leaves a DECIDED gate alone — an answer outlives its subject', async () => {
    const v1 = await publish('v1');
    const v1Gate = await gateFor(v1.id);
    await approvalGatesService.decide(
      { gateId: v1Gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    await publish('v2');

    const decided = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: v1Gate.id } });
    expect(decided.state).toBe('approved');
    expect(decided.decidedById).toBe(fx.ownerId);
  });

  it('touches no OTHER kind’s gate on the same card', async () => {
    const v1 = await publish('v1');
    const merge = await gateOfKind('pull_request_merge', 'github-pull-request-1');

    await publish('v2');

    const untouched = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: merge.id } });
    expect(untouched.state).toBe('awaiting');
    expect(
      (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: (await gateFor(v1.id)).id } }))
        .state,
    ).toBe('superseded');
  });
});

describe('a publish RACING an approval cannot strand the approved bytes (ADR §6c)', () => {
  it('genuine concurrency: whichever wins, no version is left approved-and-unlinked', async () => {
    const v1 = await publish('v1');
    const v1Gate = await gateFor(v1.id);

    // Genuine concurrency against a warm pool, NOT two serial calls. Serially,
    // every ordering of these two is safe even with the pin written AFTER the
    // decision's transaction — which is the bug §6c names.
    const [decided, published] = await Promise.allSettled([
      approvalGatesService.decide({ gateId: v1Gate.id, decision: 'approve', source: 'ui' }, fx.ctx),
      publish('v2'),
    ]);

    // The publish always lands: PIN, not FREEZE — an approval never refuses a
    // republish (the divergence from MOTIR-2764 this card is built on).
    expect(published.status).toBe('fulfilled');

    await ageAndSweep();
    const v1Row = await adminDb.designEvidence.findUniqueOrThrow({ where: { id: v1.id } });
    const v1Dto = await readBack(v1.id);

    // TWO legitimate outcomes, and the assertion pins the INVARIANT rather than
    // the identity of the winner (the scheduler's business):
    if (decided.status === 'fulfilled') {
      // The decide won the gate row: v1 was still current when it pinned, so its
      // bytes MUST have survived the republish that followed.
      expect(decided.value.gate.state).toBe('approved');
      expect(v1Row.pinnedAt).not.toBeNull();
      expect(v1Dto!.assets[0]!.url).not.toBeNull();
    } else {
      // The publish won: it retired v1's gate before touching the evidence, so
      // the decision was refused as a WITHDRAWN QUESTION. Nothing was approved,
      // so nothing was owed retention — the one thing that must not happen is an
      // approval recorded against bytes that went.
      expect(decided.reason).toBeInstanceOf(ApprovalGateSupersededError);
      const gateRow = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: v1Gate.id } });
      expect(gateRow.state).toBe('superseded');
      expect(gateRow.decidedById).toBeNull();
      expect(v1Row.pinnedAt).toBeNull();
    }

    // The invariant itself, asserted in BOTH branches: approved ⇒ fetchable.
    const approvedGate = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: v1Gate.id } });
    if (approvedGate.state === 'approved') {
      expect(v1Dto!.assets[0]!.url).not.toBeNull();
    }
  });
});

describe('the existing WITHDRAW behaviour is untouched (MOTIR-3215)', () => {
  it('withdrawing a current result still leaves its attachments LINKED', async () => {
    const v1 = await publish('v1');

    await designEvidenceService.withdrawCurrentForWorkItem(
      { workItemId: card.id, reason: 'Published onto the wrong card.' },
      fx.ctx,
    );

    const summary = await ageAndSweep();
    expect(summary.deleted).toBe(0);

    const withdrawn = await readBack(v1.id);
    expect(withdrawn!.withdrawnAt).not.toBeNull();
    expect(withdrawn!.assets[0]!.url).not.toBeNull();
    // And it was never pinned — the row survives because a WITHDRAWAL keeps its
    // record, not because anybody approved it.
    const row = await adminDb.designEvidence.findUniqueOrThrow({ where: { id: v1.id } });
    expect(row.pinnedAt).toBeNull();
  });
});
