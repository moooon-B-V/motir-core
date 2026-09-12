import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { createTestUser } from './fixtures/userFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// THE AUDIT SET IS WRITTEN (Story MOTIR-4778 · Bug MOTIR-5046; ADR
// docs/decisions/approval-gates.md §6a), against a REAL Postgres.
//
// ⚠️ WHAT THIS FILE IS FOR, AND WHY IT IS NOT `approval-gate-audit.test.ts`.
// That suite proves the six columns EXIST, are nullable, survive an actor
// deletion, and cannot be edited once decided — and it writes them through
// `adminDb` to do it, which is right for what it tests and is exactly why it
// could not notice that THE PRODUCT NEVER WROTE ONE. Every column shipped
// nullable and documented as *null while `awaiting`*, so an empty row was a
// legal state at every layer: nothing was red, and all six were null on every
// row in production for the whole life of MOTIR-4912.
//
// So every assertion here drives the REAL door — `approvalGatesService.decide`
// — or the REAL publish path, and reads the column back off the row. An
// assertion that constructs the write itself would reproduce the original bug's
// blind spot exactly.
//
// The load-bearing ones, in the order they were easiest to get wrong:
//
//   · THE VERSION, THROUGH A REAL SUBJECT. `subject_version` is asserted equal
//     to the `commitSha` of evidence a real publish created, not to a string the
//     test also supplied to the door. It is §6a's *"the one that carries the
//     whole claim"*: without it the row says somebody approved *a design*, and a
//     design is a moving object.
//   · THE AUTHORITY, ONE ARM AT A TIME. `decided_under_authority` is asserted
//     separately for an assignee, a reporter and an admin, because a
//     single-arm test passes with the value hard-coded — which is the shape the
//     three-term `||` it replaced would have produced.
//   · THE OUTCOME'S NEGATIVE. `outcome_ref` must be NULL on the arm that
//     deliberately writes no status, rather than carrying a stale value from the
//     arm that does. A test that only drove the terminal approval would pass
//     against an implementation that always wrote `done`.
//   · THE ROUTING, BY DRIVING A PUBLISH. `routed_to_id` is asserted on a gate a
//     real publish created. Calling `designResultGateHandler.routeTo` directly
//     would assert the function computes what it always computed — the defect
//     was that NOTHING CALLED IT.
//
// ⚠️ ONE `vi.mock`, and it is the same one every design-publish test takes:
// `@/lib/blob/uploader`, the ONE external. No network; `headPrivateBlob` is what
// makes the publish's authoritative size/type read answerable. Nothing about the
// gate, the door or the audit columns is stubbed.

const store = new Map<string, { contentType: string; size: number }>();

vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { workItemsService } = await import('@/lib/services/workItemsService');

let fx: WorkItemFixture;
let card: WorkItem;

beforeEach(async () => {
  store.clear();
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
  // In review is where a published design waiting for a decision actually sits,
  // and it is what makes the design gate's own `in_review → done` effect a legal
  // edge — so these tests exercise the real approve path rather than a status
  // the workflow would refuse.
  await workItemsService.updateStatus(subtask.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(subtask.id, 'in_review', fx.ctx);
  card = await adminDb.workItem.findUniqueOrThrow({ where: { id: subtask.id } });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Publish one design version through the real path; returns its evidence DTO. */
async function publish(label: string, commitSha: string | null = `sha-${label}`) {
  const pathname = `${designPrefix(fx.workspaceId, card.id)}${label}.mock.html`;
  store.set(pathname, { contentType: 'text/html', size: 2048 });
  return designEvidenceService.recordFromPathnames(
    {
      workItemId: card.id,
      assets: [{ kind: 'mock', sourcePath: `design/work-items/${label}.mock.html`, pathname }],
      commitSha,
    },
    fx.ctx,
  );
}

/** The gate the publish path wrote for a given version. */
async function gateFor(evidenceId: string) {
  return adminDb.approvalGate.findFirstOrThrow({ where: { subjectId: evidenceId } });
}

/** Read the decided row straight from the database — never through the DTO, so
 *  a mapper that dropped a field could not hide a column that was never set. */
async function rowOf(gateId: string) {
  return adminDb.approvalGate.findUniqueOrThrow({ where: { id: gateId } });
}

/** Give the card an assignee, so the routing and authority arms can differ. */
async function assignTo(userId: string | null) {
  await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: userId } });
}

/** A workspace member of a given role, as a decider. */
async function member(role: 'member' | 'admin') {
  const user = await createTestUser();
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: fx.workspaceId, role },
  });
  return user;
}

describe('subject_version — the approved BYTES, resolved through the kind (ADR §6a)', () => {
  it('an approval records the resolved subject’s commitSha', async () => {
    const evidence = await publish('frame', 'c0ffee1234567890');
    const gate = await gateFor(evidence.id);

    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    const row = await rowOf(gate.id);
    expect(row.subjectVersion).toBe('c0ffee1234567890');
  });

  it('⚠️ it is THAT version, not the card’s CURRENT one — a republish before the decision does not move it', async () => {
    // The whole argument for the column. v1's gate asks about v1's bytes; a
    // republish makes v2 current, and a version read from "the card's design"
    // would silently re-point the record at a version nobody approved. v1's gate
    // is `superseded` by the republish, so the decision that can still be taken
    // is v2's — and it must record v2's sha and not v1's.
    await publish('v1', 'aaaaaaaaaaaa');
    const v2 = await publish('v2', 'bbbbbbbbbbbb');

    const gate = await gateFor(v2.id);
    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    const row = await rowOf(gate.id);
    expect(row.subjectVersion).toBe('bbbbbbbbbbbb');
    expect(row.subjectVersion).not.toBe('aaaaaaaaaaaa');
  });

  it('a version the kind cannot answer is recorded as NULL, and the decision still lands', async () => {
    // A design published from a tree with no commit behind it. The record is
    // weaker evidence; it is not an error, and refusing the press to protect a
    // footnote would throw away the decision itself.
    const evidence = await publish('no-sha', null);
    const gate = await gateFor(evidence.id);

    const result = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    expect(result.gate.state).toBe('approved');
    expect((await rowOf(gate.id)).subjectVersion).toBeNull();
  });
});

describe('decided_by_label — WHO, surviving their departure (ADR §6a)', () => {
  it('records the decider’s name and email as at the decision', async () => {
    const evidence = await publish('frame');
    const gate = await gateFor(evidence.id);

    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    expect((await rowOf(gate.id)).decidedByLabel).toBe(`${fx.owner.name} <${fx.owner.email}>`);
  });

  it('⚠️ and the label is what SURVIVES — deleting the decider nulls the FK and leaves the answer', async () => {
    // `approval-gate-audit.test.ts` asserts the `SetNull` behaviour on a row it
    // wrote by hand, which is right for a test ABOUT the referential action.
    // This asserts it on a row THE PRODUCT wrote, which is the half that was
    // missing: a `SetNull` preserving a column the door never filled preserves
    // nothing at all, and that is precisely the state production was in.
    //
    // ⚠️ IT IS A REJECTION, AND THE REASON IS A DIFFERENT FK. A terminal
    // APPROVAL moves the card, and `applyStatusTransition` writes a
    // `work_item_revision` whose `changedById` is `onDelete: Restrict` — so a
    // member who has approved anything cannot be deleted while their revision
    // trail stands, and the test would measure that refusal instead of this
    // column (the same trap the sibling suite records for `WorkItem.reporter`).
    // `request_changes` moves nothing (§3), so it leaves no revision and the
    // departure is reachable — and a rejection is a decision, so the label is
    // owed on it either way.
    const assignee = await member('member');
    await assignTo(assignee.id);
    const evidence = await publish('frame');
    const gate = await gateFor(evidence.id);

    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'request_changes', source: 'ui' },
      { userId: assignee.id, workspaceId: fx.workspaceId },
    );
    await adminDb.user.delete({ where: { id: assignee.id } });

    const row = await rowOf(gate.id);
    expect(row.state).toBe('changes_requested');
    expect(row.decidedById).toBeNull();
    expect(row.decidedByLabel).toBe(`${assignee.name} <${assignee.email}>`);
    // And the routing FK goes the same way, on a row the publish path wrote.
    expect(row.routedToId).toBeNull();
  });

  it('a decider with a BLANK name degrades to the bare email — never to `<email>`', async () => {
    // `actorLabel`'s own header says this in as many words — *"`User.name` is
    // non-nullable but not non-EMPTY, so a blank one degrades to the bare email
    // rather than to `<email>`"* — and nothing asserted it. A documented degrade
    // with no test is a sentence, not a behaviour: the arm that produces
    // `<email>` is one missing falsy check away, and `<jo@example.com>` in an
    // audit column reads as a bug in the name rather than as an absent name.
    const decider = await member('member');
    await adminDb.user.update({ where: { id: decider.id }, data: { name: '' } });
    await assignTo(decider.id);
    const gate = await gateFor((await publish('frame')).id);

    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'request_changes', source: 'ui' },
      { userId: decider.id, workspaceId: fx.workspaceId },
    );

    const row = await rowOf(gate.id);
    expect(row.decidedByLabel).toBe(decider.email);
    expect(row.decidedByLabel).not.toContain('<');
  });
});

describe('decided_under_authority — WHICH RUNG authorised the press (ADR §2, §6a)', () => {
  // ⚠️ THREE TESTS, NOT ONE. The composition this replaced was a three-term
  // `||`: it computed *may this press be honoured?* and discarded *on what
  // grounds?*. A single-arm assertion cannot tell a real answer from a constant,
  // and the constant is exactly what a careless fix would write.

  it('the ASSIGNEE’s press records `assignee`', async () => {
    const assignee = await member('member');
    await assignTo(assignee.id);
    const gate = await gateFor((await publish('frame')).id);

    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui' },
      { userId: assignee.id, workspaceId: fx.workspaceId },
    );

    expect((await rowOf(gate.id)).decidedUnderAuthority).toBe('assignee');
  });

  it('the REPORTER’s press records `reporter`', async () => {
    // `fx.ownerId` reports everything the fixture creates, and the card has no
    // assignee — which is the routing fallback §2 names, and (since §2's
    // 2026-09-11 amendment, MOTIR-5192) the ONLY state in which the reporter arm
    // is reachable at all. The `reporter` member of the vocabulary survives that
    // narrowing unchanged; it simply stops being reachable on an assigned item.
    await assignTo(null);
    const gate = await gateFor((await publish('frame')).id);

    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    expect((await rowOf(gate.id)).decidedUnderAuthority).toBe('reporter');
  });

  it('an ADMIN who is neither records `admin`', async () => {
    const admin = await member('admin');
    await assignTo(null);
    const gate = await gateFor((await publish('frame')).id);

    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui' },
      { userId: admin.id, workspaceId: fx.workspaceId },
    );

    expect((await rowOf(gate.id)).decidedUnderAuthority).toBe('admin');
  });

  it('⚠️ an actor who is BOTH assignee and reporter records `assignee` — the ROUTING order, not an arbitrary one', async () => {
    // §2 routes `assigneeId ?? reporterId`, so this person was asked AS the
    // assignee, and that is what the audit must say. It is the one case where
    // two arms are simultaneously true, so it is the one that pins the order.
    await assignTo(fx.ownerId);
    const gate = await gateFor((await publish('frame')).id);

    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    expect((await rowOf(gate.id)).decidedUnderAuthority).toBe('assignee');
  });

  it('⚠️ a HISTORICAL `reporter` row on an ASSIGNED item is left exactly as it was — no migration, no backfill (MOTIR-5192)', async () => {
    // §2's 2026-09-11 amendment made the reporter arm unreachable on an assigned
    // item. Rows written BEFORE it record a press that really happened under the
    // rule in force at the time, and §6a freezes the arm precisely so a later
    // rule change cannot rewrite history — a backfill or a re-derivation would
    // destroy the one thing the column exists to preserve.
    //
    // The row is written directly rather than through the door, because the door
    // can no longer produce it. That is the point: this asserts the absence of a
    // data migration, which no test driving the current door could reach.
    const assignee = await member('member');
    await assignTo(assignee.id);
    const gate = await gateFor((await publish('frame')).id);
    await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: {
        state: 'approved',
        decidedById: fx.ownerId,
        decidedAt: new Date('2026-09-09T10:00:00.000Z'),
        decidedUnderAuthority: 'reporter',
      },
    });

    const row = await rowOf(gate.id);
    expect(row.decidedUnderAuthority).toBe('reporter');
    expect(row.decidedById).toBe(fx.ownerId);
    expect(row.state).toBe('approved');
  });
});

describe('decision_source — THROUGH WHICH SURFACE (ADR §6a)', () => {
  it('records what the caller declared, verbatim', async () => {
    const gate = await gateFor((await publish('frame')).id);

    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'api' },
      fx.ctx,
    );

    // Not `ui`. §6a exists so *"a human click is distinguishable from a
    // programmatic call"*, and a door that defaulted to `ui` would make the
    // strongest claim available on behalf of a caller that never made it.
    expect((await rowOf(gate.id)).decisionSource).toBe('api');
  });

  it('the two shipped call sites declare the two surfaces they are', async () => {
    // A grep-level assertion, deliberately: the value is a property of the CALL
    // SITE and nothing inside the service can check it. These are the only two
    // callers of the door on `origin/main`, and each says which door it is.
    const { readFile } = await import('node:fs/promises');
    const action = await readFile('app/(authed)/items/[key]/approvalGateActions.ts', 'utf8');
    const route = await readFile('app/api/approval-gates/[id]/decide/route.ts', 'utf8');
    expect(action).toContain("source: 'ui'");
    expect(route).toContain("source: 'api'");
  });
});

describe('outcome_ref — WHAT THE DECISION CAUSED (ADR §6a)', () => {
  it('a TERMINAL approval records the status it wrote', async () => {
    const gate = await gateFor((await publish('frame')).id);

    const result = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    // The same value the effect reports, on the row — so an auditor reading the
    // table alone can close the loop from decision to effect.
    expect(result.effect.statusWritten).toBe('done');
    expect((await rowOf(gate.id)).outcomeRef).toBe('done');
  });

  it('⚠️ it is NULL on the arm that deliberately writes no status — `merge_writes_done`', async () => {
    // ADR §8's discriminator: a card with a linked OPEN pull request is approved
    // and moved by the MERGE, so this decision caused no transition. Recording
    // `done` here would put a status on the row that the card does not have.
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: 'inst-5046',
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
        repoId: 'repo-5046',
        owner: 'acme',
        name: 'web',
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number: 11,
        title: 'draw the frame',
        state: 'open',
        headRef: 'design/frame',
        baseRef: 'main',
        provider: 'github',
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: card.id,
        githubPullRequestId: pr.id,
        repoId: repo.id,
      },
    });
    const gate = await gateFor((await publish('frame')).id);

    const result = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    expect(result.effect.statusDeferredReason).toBe('merge_writes_done');
    const row = await rowOf(gate.id);
    expect(row.outcomeRef).toBeNull();
    // The decision itself still landed, with the rest of its audit set — the
    // outcome being empty is a fact about the effect, not about the record.
    expect(row.state).toBe('approved');
    expect(row.subjectVersion).toBe('sha-frame');
    expect(row.decidedUnderAuthority).toBe('reporter');
  });
});

describe('request_changes writes the decision-time columns too (ADR §6a exempts none of them)', () => {
  it('a REJECTION is a decision, and it records everything but an outcome', async () => {
    // The negative that keeps the write out of the `approve` branch. A fix that
    // filled the columns only on approval would satisfy every other test in this
    // file and leave half the audit empty — and a rejection is exactly the
    // decision an auditor most wants attributed.
    const gate = await gateFor((await publish('frame', 'deadbeefdeadbeef')).id);

    const result = await approvalGatesService.decide(
      {
        gateId: gate.id,
        decision: 'request_changes',
        noteMd: 'The port is too short.',
        source: 'ui',
      },
      fx.ctx,
    );

    expect(result.gate.state).toBe('changes_requested');
    const row = await rowOf(gate.id);
    expect(row.subjectVersion).toBe('deadbeefdeadbeef');
    expect(row.decidedByLabel).toBe(`${fx.owner.name} <${fx.owner.email}>`);
    expect(row.decidedUnderAuthority).toBe('reporter');
    expect(row.decisionSource).toBe('ui');
    // §3: request_changes moves nothing, so there is no outcome to name.
    expect(row.outcomeRef).toBeNull();
  });
});

describe('routed_to_id — WHO THE PRODUCT ASKED, computed at CREATION (ADR §2, §6a)', () => {
  it('⚠️ a gate the PUBLISH path created carries the routing — which is `routeTo`’s first production caller', async () => {
    // Asserted by DRIVING A PUBLISH, never by calling the handler. The defect
    // was not that `routeTo` computed the wrong answer; it was that nothing
    // called it at all, and a test that called it directly would have passed
    // throughout.
    const assignee = await member('member');
    await assignTo(assignee.id);

    const evidence = await publish('frame');

    expect((await gateFor(evidence.id)).routedToId).toBe(assignee.id);
  });

  it('falls back to the REPORTER when there is no assignee — §2’s `assigneeId ?? reporterId`', async () => {
    await assignTo(null);

    const evidence = await publish('frame');

    expect((await gateFor(evidence.id)).routedToId).toBe(fx.ownerId);
  });

  it('⚠️ it is frozen at CREATION — re-assigning the card afterwards does not move it', async () => {
    // The entire reason the column exists rather than being derived on read:
    // *"the assignee can change afterwards"*, so the live card can only answer
    // who the product WOULD ask, never who it DID.
    const first = await member('member');
    await assignTo(first.id);
    const evidence = await publish('frame');

    const second = await member('member');
    await assignTo(second.id);

    expect((await gateFor(evidence.id)).routedToId).toBe(first.id);
  });
});
