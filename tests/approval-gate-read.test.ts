import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import {
  ApprovalGateNotAuthorisedError,
  ApprovalGateStaleSubjectError,
} from '@/lib/approvalGates/errors';
import { PermissionDeniedError } from '@/lib/projects/errors';
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
 * workspace's owner — so they hold `approval:decide_any` and the ADMIN
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
    kind?: 'design_result' | 'pull_request_merge' | 'pull_request_approval' | 'decision_approval';
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

  it('reads an awaiting gate of an UNREGISTERED kind without refusing, routed by the shared rule (MOTIR-4906)', async () => {
    // The pull-request gate is unregistered until MOTIR-4909, and the item page's
    // Development block still draws its frame over such a row. `handlerFor` refuses
    // an unregistered kind — correct for the decide door, wrong for this read.
    const { item, gate } = await designSubtaskWithGate({ kind: 'pull_request_approval' });

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'pull_request_approval' },
      fx.ctx,
    );

    expect(read.gate?.id).toBe(gate.id);
    expect(read.gate?.kind).toBe('pull_request_approval');
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
      {
        stamp: DECIDED_WITHOUT_A_READER,
        gateId: gate.id,
        decision: 'request_changes',
        source: 'ui',
      },
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
          { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: verb, source: 'ui' },
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

describe('routedToLabel — the *waiting on* line NAMES somebody (MOTIR-5191)', () => {
  // ⚠️ THIS BLOCK IS THE HALF THE COMPONENT TESTS STRUCTURALLY CANNOT COVER.
  // `tests/components/approval-gate-control.test.tsx` renders the frame with
  // `routedToLabel: 'Mara S.'` and asserts the sentence — and it passed on the
  // defect, because it supplied the name the application did not. A test that
  // hands a component its input cannot discover that no caller ever does. So
  // the assertions here drive the READ, and the guard beside them
  // (`tests/approval-gate-routed-to-wiring.test.ts`) drives the CALL SITE.

  it('names the ASSIGNEE the gate is routed to', async () => {
    const other = await createTestUser({ name: 'Mara Sandoval' });
    const { item } = await designSubtaskWithGate({ assigneeId: other.id });

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      fx.ctx,
    );

    expect(read.routedToLabel).toBe('Mara Sandoval');
  });

  it('falls through to the REPORTER when the card has no assignee — §2 exactly', async () => {
    const { item } = await designSubtaskWithGate({ assigneeId: null });

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      fx.ctx,
    );

    // `assigneeId ?? reporterId`: the fixture owner reports every card it makes.
    const reporter = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ctx.userId } });
    expect(read.routedToLabel).toBe(reporter.name?.trim() || reporter.email);
  });

  it('degrades to the EMAIL when the routed member has a blank name', async () => {
    // `User.name` is non-nullable but not non-EMPTY, so the display rule has to
    // be `name || email` rather than `name ?? email` — a blank one would
    // otherwise render *"Waiting on ."*
    const nameless = await createTestUser();
    await adminDb.user.update({ where: { id: nameless.id }, data: { name: '   ' } });
    const { item } = await designSubtaskWithGate({ assigneeId: nameless.id });

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      fx.ctx,
    );

    expect(read.routedToLabel).toBe(nameless.email);
  });

  it('SURVIVES the routed member being deleted — it does not strand the surface', async () => {
    // Criterion 6, and the answer is structural rather than defensive:
    // `WorkItem.assignee` is `onDelete: SetNull`, so deleting the assignee nulls
    // the column and §2's rule falls through to the reporter — who is
    // `onDelete: Restrict` and therefore cannot be deleted while they report the
    // card at all. The surface degrades to a DIFFERENT REAL NAME, never to a
    // broken read. This is also why ADR §3 is right that the routing column
    // needs no surviving label beside it.
    const leaver = await createTestUser({ name: 'Departed Member' });
    const { item } = await designSubtaskWithGate({ assigneeId: leaver.id });

    await adminDb.user.delete({ where: { id: leaver.id } });

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      fx.ctx,
    );

    const reporter = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ctx.userId } });
    expect(read.routedToLabel).toBe(reporter.name?.trim() || reporter.email);
  });

  it('tracks a REASSIGNMENT — the label is the LIVE routing answer, not the gate’s frozen `routedToId`', async () => {
    // ⚠️ THE CARD PRESCRIBED `routedToId` AND THIS IS WHY IT DOES NOT.
    // `routedToId` is written at gate CREATION (ADR §6a: *"the assignee can
    // change afterwards"*) and is the AUDIT record of who was ASKED. The
    // sentence it would feed is present tense and its reader's next act is to go
    // and ask somebody — so on a reassigned card the frozen column names a
    // person who no longer sees the gate at all. `approvalGateRepository`'s
    // queue predicate makes the same choice for the same reason, in as many
    // words. Both columns are right, about different questions.
    const first = await createTestUser({ name: 'First Owner' });
    const { item, gate } = await designSubtaskWithGate({ assigneeId: first.id });
    // The helper creates the gate without one, so write the audit column the
    // publish path would have written — otherwise the frozen-vs-live assertion
    // below compares against a null and passes for the wrong reason.
    await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: { routedToId: first.id },
    });

    const second = await createTestUser({ name: 'Second Owner' });
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: second.id } });

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      fx.ctx,
    );

    expect(read.routedToLabel).toBe('Second Owner');
    // And the audit column is untouched by the reassignment, which is the whole
    // reason it exists — asserted here so the two can never be collapsed.
    const frozen = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(frozen.routedToId).toBe(first.id);
  });
});

describe('getForWorkItem is TOTAL over ApprovalGateKind (MOTIR-5223)', () => {
  it('an UNREGISTERED kind with a row returns the gate instead of throwing', async () => {
    // The approval overlay asks this read about any kind its URL names, and
    // `handlerFor` refuses a kind with no handler. A render read must still
    // draw the row: the routed-to name falls back to §2's shared rule.
    // `pull_request_merge` is the one registry hole left (RETIRED by MOTIR-5616);
    // `decision_approval` was one until MOTIR-5676 registered it.
    const { item, gate } = await designSubtaskWithGate({ kind: 'pull_request_merge' });

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'pull_request_merge' },
      fx.ctx,
    );

    expect(read.gate?.id).toBe(gate.id);
    expect(read.gate?.kind).toBe('pull_request_merge');
    expect(read.routedToLabel).not.toBeNull();
  });
});

describe('canDecide holds the KIND’s permission FLOOR, as the door does (MOTIR-5445)', () => {
  // ⚠️ THE MATRIX ABOVE CANNOT SEE THIS, because every actor in it holds the
  // floor: a plain workspace member can edit work items. The relationship arms
  // were the whole of `canDecide`, and the one shape that separates them from
  // the door is a reader who IS the assignee and may NOT edit — a project
  // `viewer`. The queue read held the floor; this read did not.

  /** A project `viewer`: a workspace member whose ONLY project membership is `viewer`. */
  async function projectViewer() {
    const user = await plainMember();
    await adminDb.projectMembership.deleteMany({
      where: { userId: user.id, projectId: fx.projectId },
    });
    await adminDb.projectMembership.create({
      data: {
        userId: user.id,
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        role: 'viewer',
      },
    });
    return user;
  }

  it('a project VIEWER who is the ASSIGNEE sees the gate, may not decide it — and the door agrees', async () => {
    const viewer = await projectViewer();
    const reporter = await plainMember();
    const { item, gate } = await designSubtaskWithGate({
      assigneeId: viewer.id,
      reporterId: reporter.id,
    });
    const ctx = { userId: viewer.id, workspaceId: fx.workspaceId };

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      ctx,
    );
    expect(read.gate?.id).toBe(gate.id);
    expect(read.canDecide).toBe(false);

    await expect(
      approvalGatesService.decide(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('POSITIVE CONTROL — the same relationship with the floor held may decide', async () => {
    const assignee = await plainMember();
    const reporter = await plainMember();
    const { item } = await designSubtaskWithGate({
      assigneeId: assignee.id,
      reporterId: reporter.id,
    });

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      { userId: assignee.id, workspaceId: fx.workspaceId },
    );
    expect(read.canDecide).toBe(true);
  });

  it('an UNREGISTERED kind names no floor, so it keeps the AUTHORITY answer alone', async () => {
    // No handler, no `permission` — the Development block's pull-request frame
    // draws *Awaiting you* from this for the person the gate is routed to
    // (MOTIR-5336), and a bystander still reads false.
    const assignee = await projectViewer();
    const { item } = await designSubtaskWithGate({
      kind: 'pull_request_merge',
      assigneeId: assignee.id,
      reporterId: (await plainMember()).id,
    });
    const read = (userId: string) =>
      approvalGatesService.getForWorkItem(
        { workItemId: item.id, kind: 'pull_request_merge' },
        { userId, workspaceId: fx.workspaceId },
      );

    expect((await read(assignee.id)).canDecide).toBe(true);
    expect((await read((await plainMember()).id)).canDecide).toBe(false);
  });
});

describe('`since` — what has moved for a reader HOLDING this gate open (MOTIR-5243)', () => {
  // ⚠️ THE POINT OF THIS BLOCK IS THE AGREEMENT, not the list. An open approval
  // draws a notice BEFORE a press and the door refuses AFTER one, and the whole
  // design rests on those two never disagreeing about whether something moved.
  // They agree here because they are one comparison asked twice — `stampMoved`,
  // through `getForWorkItem`'s `since` and through `decide`'s own check.

  async function stampOf(item: { id: string }): Promise<string> {
    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      fx.ctx,
    );
    if (!read.stamp) throw new Error('an awaiting gate must carry a stamp');
    return read.stamp;
  }

  async function movedSince(item: { id: string }, since: string) {
    return (
      await approvalGatesService.getForWorkItem(
        { workItemId: item.id, kind: 'design_result', since },
        fx.ctx,
      )
    ).movedSince;
  }

  it('answers EMPTY while nothing has moved — a notice that fires on any activity is noise', async () => {
    const { item } = await designSubtaskWithGate({ assigneeId: fx.ownerId });
    const stamp = await stampOf(item);

    expect(await movedSince(item, stamp)).toEqual([]);
  });

  it('answers EMPTY when no `since` is presented — the read is unchanged for every other caller', async () => {
    const { item } = await designSubtaskWithGate({ assigneeId: fx.ownerId });
    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      fx.ctx,
    );
    expect(read.movedSince).toEqual([]);
  });

  it('names `criteria` when the card body moved under the reader', async () => {
    const { item } = await designSubtaskWithGate({ assigneeId: fx.ownerId });
    const stamp = await stampOf(item);

    await workItemsService.updateWorkItem(
      item.id,
      { descriptionMd: '## Acceptance criteria\n\n- one more thing' },
      fx.ctx,
    );

    expect(await movedSince(item, stamp)).toEqual(['criteria']);
  });

  it('names `subject` when the published version moved under the reader', async () => {
    const { item, gate } = await designSubtaskWithGate({ assigneeId: fx.ownerId });
    const stamp = await stampOf(item);

    await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: { subjectVersion: 'a-newer-version' },
    });

    expect(await movedSince(item, stamp)).toEqual(['subject']);
  });

  it('AGREES WITH THE DOOR, from ONE change — the notice and the refusal are one comparison', async () => {
    const { item, gate } = await designSubtaskWithGate({ assigneeId: fx.ownerId });
    const stamp = await stampOf(item);

    // ONE change, read two ways.
    await workItemsService.updateWorkItem(
      item.id,
      { descriptionMd: '## Acceptance criteria\n\n- it moved' },
      fx.ctx,
    );

    const noticeSays = await movedSince(item, stamp);

    let refusalSays: readonly string[] = [];
    try {
      await approvalGatesService.decide(
        { stamp, gateId: gate.id, decision: 'approve', source: 'ui' },
        fx.ctx,
      );
      throw new Error('the door must refuse a press against a stamp that has moved');
    } catch (err) {
      if (!(err instanceof ApprovalGateStaleSubjectError)) throw err;
      refusalSays = err.moved;
    }

    expect(noticeSays).toEqual(['criteria']);
    expect([...refusalSays]).toEqual([...noticeSays]);
  });

  it('answers EMPTY for a gate nobody can press — a decided gate has moved past the question', async () => {
    const { item, gate } = await designSubtaskWithGate({ assigneeId: fx.ownerId });
    const stamp = await stampOf(item);
    await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: { state: 'approved', decidedAt: new Date() },
    });

    expect(await movedSince(item, stamp)).toEqual([]);
  });

  it('names EVERY component for a stamp it cannot read — the honest answer to a token nobody can vouch for', async () => {
    const { item } = await designSubtaskWithGate({ assigneeId: fx.ownerId });

    expect(await movedSince(item, 'not-a-stamp')).toEqual(['subject', 'pull_requests', 'criteria']);
  });
});
