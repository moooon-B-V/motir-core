import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { ApprovalGateNotAuthorisedError } from '@/lib/approvalGates/errors';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { createTestUser } from './fixtures/userFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// THE FRAME'S READ (Story MOTIR-4778 · Subtask MOTIR-4792) — the one the
// approval frame renders from, against a REAL Postgres.
//
// What is load-bearing here, and why each assertion exists:
//
//   · SCOPED BY KIND. A card carrying a repository SET legitimately holds
//     SEVERAL simultaneous awaiting gates (ADR §6b's uniqueness is
//     `(workItemId, kind, subjectId)`), so a read that returned "the awaiting
//     gate" would hand the design section a merge gate the moment that kind
//     ships. This is the assertion that stops it.
//   · `canDecide` IS THE AUTHORITY ANSWER, NOT THE ROUTING ONE — and after ADR
//     §2's 2026-09-11 amendment (MOTIR-5192) the two COINCIDE for the
//     relationship arms and part company only at the ADMIN override. The rule is
//     the assignee, or the reporter WHEN THERE IS NO ASSIGNEE, or an admin. A
//     read that returned the routing answer would draw state `B` — the port, no
//     verbs — for an admin who is perfectly entitled to decide, and the work
//     would sit there.
//   · IT AGREES WITH THE DOOR, ASSERTED OVER THE WHOLE MATRIX rather than case
//     by case. `canDecide: true` and a refusal from `decide` draws verbs the
//     door refuses; `canDecide: false` and a successful `decide` withholds verbs
//     from somebody entitled to them. BOTH are failures, and only a matrix
//     catches the second — which is exactly the half a narrowing applied to one
//     site and not the other produces. The two now read ONE function
//     (`resolveGateAuthority`), and this matrix is what proves it.
//   · NO EXISTENCE LEAK. A cross-workspace card reads as "nothing awaiting",
//     never as a gate somebody else's tenant owns.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/**
 * ⚠️ `reporterId` EXISTS BECAUSE `fx.ownerId` IS ALSO A WORKSPACE OWNER, and
 * that overlap made the reporter arm untestable in isolation (MOTIR-5192).
 *
 * Everything the fixture creates is reported by `fx.ownerId`, who is the
 * workspace's owner — so `isWorkspaceManagerFor` is true for them and the ADMIN
 * arm authorises them whatever the reporter arm says. Under the old
 * `assignee OR reporter OR admin` rule the reporter term short-circuited first
 * and nobody noticed; the moment that term became conditional, every "the
 * reporter is refused" assertion started passing through the admin arm instead.
 *
 * So a test about the REPORTER arm reports the item as a PLAIN MEMBER. A test
 * about the admin arm is the one that keeps the owner.
 */
async function designSubtaskWithGate(
  opts: {
    assigneeId?: string | null;
    reporterId?: string;
    kind?: 'design_result' | 'pull_request_merge';
  } = {},
) {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Approve a design' },
    fx.ctx,
  );
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Draw the frame' },
    fx.ctx,
  );
  // The card has to be somewhere approval can legally take it to `done` — the
  // same walk the decide-door suite does. Without it the door's own effect
  // raises `IllegalTransitionError` from `todo`, which would make the
  // agrees-with-the-door assertion fail for a reason that has nothing to do with
  // authority.
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
  if (opts.assigneeId !== undefined || opts.reporterId !== undefined) {
    await adminDb.workItem.update({
      where: { id: item.id },
      data: {
        ...(opts.assigneeId !== undefined ? { assigneeId: opts.assigneeId } : {}),
        ...(opts.reporterId !== undefined ? { reporterId: opts.reporterId } : {}),
      },
    });
  }
  const gate = await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: opts.kind ?? 'design_result',
        subjectId: `design-evidence-${item.id}`,
      },
      tx,
    ),
  );
  return { story, item, gate };
}

/** A workspace member with no administrative role — see the helper's note on why
 *  the fixture OWNER cannot stand in for a reporter or an assignee. */
async function plainMember() {
  const user = await createTestUser();
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: fx.workspaceId, role: 'member' },
  });
  return user;
}

describe('approvalGatesService.getAwaitingForWorkItem', () => {
  it('returns the awaiting gate of the KIND asked for', async () => {
    const { item, gate } = await designSubtaskWithGate();

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      fx.ctx,
    );

    expect(read.gate?.id).toBe(gate.id);
    expect(read.gate?.state).toBe('awaiting');
    expect(read.gate?.kind).toBe('design_result');
  });

  it('does NOT return a gate of a DIFFERENT kind on the same card', async () => {
    // ⚠️ THE ONE THAT MATTERS AT SCALE. One card can carry a design gate and a
    // merge gate at once; a kind-blind read hands the design section the wrong
    // subject and it renders a merge decision inside a design port.
    const { item } = await designSubtaskWithGate({ kind: 'pull_request_merge' });

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      fx.ctx,
    );

    expect(read.gate).toBeNull();
    expect(read.canDecide).toBe(false);
  });

  it('returns nothing when the card has no gate at all — the ordinary case', async () => {
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Nothing pending' },
      fx.ctx,
    );

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: story.id, kind: 'design_result' },
      fx.ctx,
    );

    expect(read.gate).toBeNull();
  });

  it('does not return a DECIDED gate — the awaiting set is what the verbs read', async () => {
    const { item, gate } = await designSubtaskWithGate();
    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'request_changes', source: 'ui' },
      fx.ctx,
    );

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      fx.ctx,
    );

    expect(read.gate).toBeNull();
  });
});

describe('canDecide — the AUTHORITY answer, and it agrees with the door', () => {
  it('is FALSE for the REPORTER when the gate is routed to an assignee (ADR §2, 2026-09-11)', async () => {
    // Routing is `assigneeId ?? reporterId` — ONE recipient. Authority is the
    // assignee, the reporter WHEN THERE IS NO ASSIGNEE, or an admin. Here the
    // assignee is somebody else, so the reporter arm is closed and this reader
    // gets state `B`: the port, no verbs.
    //
    // ⚠️ THIS ASSERTION IS INVERTED FROM WHAT IT SAID UNTIL 2026-09-11, and the
    // inversion is the card's whole subject. The 2026-09-08 amendment let three
    // people press a gate shown to one; an approval that two people could have
    // made is owned by neither. Kept rather than deleted, with its reason, so
    // the file records that authority was once the other way round.
    const reporter = await plainMember();
    const assignee = await plainMember();
    const { item } = await designSubtaskWithGate({
      assigneeId: assignee.id,
      reporterId: reporter.id,
    });

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      { userId: reporter.id, workspaceId: fx.workspaceId },
    );

    // The gate is READ — being unable to press is not being unable to see.
    expect(read.gate).not.toBeNull();
    expect(read.canDecide).toBe(false);
  });

  it('is TRUE for the SAME reporter when the item has NO assignee — the condition DISCRIMINATES', async () => {
    // The pair of the case above, differing in exactly one field. Without it the
    // assertion above is satisfied by a `canDecide` that is simply always false,
    // which is precisely what a careless narrowing writes.
    const reporter = await plainMember();
    const { item } = await designSubtaskWithGate({
      assigneeId: null,
      reporterId: reporter.id,
    });

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      { userId: reporter.id, workspaceId: fx.workspaceId },
    );

    expect(read.gate).not.toBeNull();
    expect(read.canDecide).toBe(true);
  });

  it('is TRUE for an ADMIN on an item that HAS an assignee — the escape hatch the narrowing left standing', async () => {
    const assignee = await createTestUser();
    const admin = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: admin.id, workspaceId: fx.workspaceId, role: 'admin' },
    });
    const { item } = await designSubtaskWithGate({ assigneeId: assignee.id });

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      { userId: admin.id, workspaceId: fx.workspaceId },
    );

    expect(read.canDecide).toBe(true);
  });
});

describe('canDecide AGREES WITH THE DOOR over the whole authority matrix (MOTIR-5192)', () => {
  // ⚠️ A MATRIX, NOT A CASE LIST, and the difference is the point. The authority
  // rule is resolved for TWO questions — what the surface renders (`canDecide`)
  // and what the door enforces (`authority`) — and the failure this card exists
  // to prevent is one of them being narrowed and the other not. Per-case
  // assertions catch that only where somebody thought to write the case; running
  // every row through BOTH halves catches it wherever the two disagree.
  //
  // Read each row as: for this relationship, with the item assigned or not, the
  // surface says X and the door must agree with X. Either direction of
  // disagreement is a failure — verbs drawn that are refused, and verbs withheld
  // from somebody entitled to press.
  const MATRIX: {
    label: string;
    relationship: 'assignee' | 'reporter' | 'admin' | 'bystander';
    assigned: boolean;
    canDecide: boolean;
  }[] = [
    { label: 'the ASSIGNEE', relationship: 'assignee', assigned: true, canDecide: true },
    {
      label: 'the REPORTER of an ASSIGNED item',
      relationship: 'reporter',
      assigned: true,
      canDecide: false,
    },
    {
      label: 'the REPORTER of an UNASSIGNED item',
      relationship: 'reporter',
      assigned: false,
      canDecide: true,
    },
    {
      label: 'an ADMIN on an ASSIGNED item',
      relationship: 'admin',
      assigned: true,
      canDecide: true,
    },
    {
      label: 'an ADMIN on an UNASSIGNED item',
      relationship: 'admin',
      assigned: false,
      canDecide: true,
    },
    {
      label: 'a plain MEMBER who is neither',
      relationship: 'bystander',
      assigned: true,
      canDecide: false,
    },
    {
      label: 'a plain MEMBER on an UNASSIGNED item',
      relationship: 'bystander',
      assigned: false,
      canDecide: false,
    },
  ];

  // BOTH VERBS, because the rule is stated for both and a conditional applied to
  // one branch of the decide switch would pass an approve-only matrix.
  const VERBS = ['approve', 'request_changes'] as const;

  for (const row of MATRIX) {
    for (const verb of VERBS) {
      it(`${row.label}: canDecide is ${row.canDecide}, and \`${verb}\` agrees`, async () => {
        // ⚠️ EVERY ACTOR IS A PLAIN MEMBER EXCEPT THE DELIBERATE ADMIN, and the
        // REPORTER is written onto the item rather than inherited from the
        // fixture. `fx.ownerId` reports everything the fixture creates AND owns
        // the workspace, so a matrix built on it would resolve four of these
        // seven rows through the admin arm and prove nothing about the
        // relationship arms at all (see the helper's note).
        const assignee = await plainMember();
        const reporter = await plainMember();

        let actorId: string;
        if (row.relationship === 'assignee') actorId = assignee.id;
        else if (row.relationship === 'reporter') actorId = reporter.id;
        else if (row.relationship === 'admin') {
          const admin = await createTestUser();
          await adminDb.workspaceMembership.create({
            data: { userId: admin.id, workspaceId: fx.workspaceId, role: 'admin' },
          });
          actorId = admin.id;
        } else actorId = (await plainMember()).id;

        const { item, gate } = await designSubtaskWithGate({
          assigneeId: row.assigned ? assignee.id : null,
          reporterId: reporter.id,
        });
        const ctx = { userId: actorId, workspaceId: fx.workspaceId };

        const read = await approvalGatesService.getAwaitingForWorkItem(
          { workItemId: item.id, kind: 'design_result' },
          ctx,
        );
        expect(read.canDecide).toBe(row.canDecide);

        const press = approvalGatesService.decide(
          { gateId: gate.id, decision: verb, source: 'ui' },
          ctx,
        );

        if (row.canDecide) {
          const decided = await press;
          expect(decided.gate.state).toBe(verb === 'approve' ? 'approved' : 'changes_requested');
        } else {
          await expect(press).rejects.toBeInstanceOf(ApprovalGateNotAuthorisedError);
          // Nothing was written — a refusal that half-decided would be worse
          // than one that let the press through.
          const persisted = await adminDb.approvalGate.findUniqueOrThrow({
            where: { id: gate.id },
          });
          expect(persisted.state).toBe('awaiting');
          expect(persisted.decidedUnderAuthority).toBeNull();
        }
      });
    }
  }
});

describe('no existence leak', () => {
  it('reads as "nothing awaiting" for a card in another workspace', async () => {
    const { item } = await designSubtaskWithGate();
    const stranger = await makeWorkItemFixture();

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      stranger.ctx,
    );

    // Indistinguishable from a card that simply has no gate — the same posture
    // the decide door takes with its 404.
    expect(read.gate).toBeNull();
    expect(read.canDecide).toBe(false);
  });
});
