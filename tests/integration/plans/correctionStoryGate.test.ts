import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { permissionDenial } from '@/lib/mcp/permissionGate';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  UPDATE_PLAN_ITEM_TOOL_NAME,
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
  WITHDRAW_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The story's GATE (Story MOTIR-3533 · Subtask MOTIR-3542).
//
// ── What is HERE, and what deliberately is not ──────────────────────────────
//
// The card's own rule (AC7): *no assertion here duplicates a sibling card's own
// units.* All seven of its blocks are covered — but six of them are covered by
// the cards that SHIP the behaviour, under the code-and-tests-are-one-deliverable
// floor, and restating them here would buy a second place for them to drift.
// So they are NAMED, with where they live:
//
//   1. the FROZEN statuses, `approved` and `declined`, error naming the status
//      → `correctAndWithdrawProposal.test.ts` (3 cases, both tools, both statuses);
//   2. the append-time ref refusal, whole-batch rollback, and the EXACT live shape
//      → `appendRefRefusal.test.ts` (`modify` + `patch.blockedByAdd`, counted
//      before and after) and `tests/plans/appendRefCheck.test.ts` (the verdict, pure);
//   3. a structural correction cannot re-introduce an unresolvable ref, self-ref
//      included → `correctAndWithdrawProposal.test.ts`;
//   4. the withdraw's blast radius — the referrer refusal on BOTH carriers, and a
//      `modify`'s target released → `correctAndWithdrawProposal.test.ts`;
//   5. the deepen contract unchanged → `correctAndWithdrawProposal.test.ts` (the
//      service merge) and `correct-plan-proposal.test.ts` (the shipped input schema,
//      read back over the transport);
//   6. the permission contract in both directions, the CLI token built from
//      `CLI_TOKEN_GRANT` → `correct-plan-proposal.test.ts`.
//
// What is left is the ASSEMBLED SEAM, which is the only thing no single card can
// see, because each card's tests stop at its own half:
//
//   A. **ONE PLAN'S WHOLE LIFE, THROUGH THE TOOLS** — the mistake refused at the
//      append, the plan authored properly, closed for review, CORRECTED and a
//      proposal WITHDRAWN while a reviewer holds it, then approved and frozen.
//      The three code cards compose here or nowhere.
//   B. **THE TRAIL, READ BACK THROUGH THE READ PATH** — every act on the merged
//      timeline `planReviewService` renders, in order, with its actor. The write
//      side is MOTIR-3540's; the read side is the SIBLING STORY's; that they agree
//      is neither card's own test.
//   C. **THE CORRECTION SURVIVES APPROVE** — what materializes is what was
//      corrected, not what was appended. This is the assertion that makes the
//      whole story worth shipping, and it spans every card in it.
//   D. **THE GRANT, ONE ASSERTION ACROSS THE WHOLE SURFACE** — not "these two
//      tools refuse a CLI token" (block 6's, already made) but that the plan
//      AUTHORING surface as a set is closed to one, so a future tool added to it
//      cannot open the set by accident.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'correction-story-gate', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> => (await client.callTool({ name, arguments: args })) as CallToolResult;

const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');

const ids = (r: CallToolResult) =>
  (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;

// ── A + B + C · the assembled seam ──────────────────────────────────────────

describe('the whole story, composed — a plan authored, mistyped, corrected and approved', () => {
  it('drives every act through the tools, and what approve materializes is the CORRECTION', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const existing = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'A card the plan re-scopes',
    });

    const created = await call(client, CREATE_PLAN_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
      title: 'The whole life of a plan',
      plannedWithHarness: 'Claude Code',
      plannedWithModel: 'claude-opus-5',
    });
    const planId = (created.structuredContent as unknown as { id: string }).id;

    // ── 1. THE MISTAKE, refused where it is made ────────────────────────────
    // The exact shape that produced the live artifact: two proposals in ONE
    // batch, the second referencing the first through an id that does not exist
    // until this call returns.
    const refused = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'The prerequisite', kind: 'task' } },
        {
          op: 'modify',
          workItemId: existing.id,
          patch: { blockedByAdd: [`${TEMP_REF_PREFIX}PLACEHOLDER`] },
        },
      ],
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('UNRESOLVED_PLAN_REF');
    // The composed property: the plan is still EMPTY, so the broken artifact
    // never reaches the review queue at all.
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);

    // ── 2. AUTHORED PROPERLY, in two calls ──────────────────────────────────
    const prereq = ids(
      await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
        planId,
        proposals: [{ op: 'add', proposedFields: { title: 'The prerequisite', kind: 'task' } }],
      }),
    )[0]!;
    const [dependent, doomed] = ids(
      await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
        planId,
        proposals: [
          { op: 'add', proposedFields: { title: 'The dependent', kind: 'task' } },
          { op: 'add', proposedFields: { title: 'Should not have been proposed', kind: 'task' } },
        ],
      }),
    ) as [string, string];

    // ── 3. CLOSED FOR REVIEW — a reviewer is now holding it ─────────────────
    await call(client, ADD_PLAN_ITEMS_TOOL_NAME, { planId, proposals: [], final: true });
    expect((await plansService.getPlan(planId, fx.ctx)).status).toBe('planned');

    // ── 4. CORRECTED under the reviewer, over the MCP ───────────────────────
    const corrected = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: dependent,
      blockedByRefs: [`${TEMP_REF_PREFIX}${prereq}`],
      title: 'The dependent, corrected',
    });
    expect(corrected.isError).toBeFalsy();

    // ── 5. WITHDRAWN — one proposal off the plan, not a whole decline ───────
    const withdrawn = await call(client, WITHDRAW_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: doomed,
    });
    expect(withdrawn.isError).toBeFalsy();
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(2);

    // ── 6. APPROVED — and THE CORRECTION IS WHAT MATERIALIZES ───────────────
    // The assertion the whole story is for. Every card contributes to it and
    // none of them can make it: the append wrote one shape, the correction
    // wrote another, and materialize reads the second.
    await plansService.approvePlan(planId, fx.ctx);

    const dependentRow = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, title: 'The dependent, corrected' },
    });
    const prereqRow = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, title: 'The prerequisite' },
    });
    // The corrected EDGE is a real link, resolved from the temp-ref at approve.
    const link = await adminDb.workItemLink.findFirstOrThrow({
      where: { fromId: dependentRow.id, toId: prereqRow.id, kind: 'is_blocked_by' },
    });
    expect(link).toBeTruthy();
    // …and the withdrawn proposal materialized NOTHING.
    expect(
      await adminDb.workItem.count({
        where: { projectId: fx.projectId, title: 'Should not have been proposed' },
      }),
    ).toBe(0);

    // ── 7. FROZEN — and the refusal points at the surface that is now live ──
    const tooLate = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: dependent,
      title: 'Too late',
    });
    expect(tooLate.isError).toBe(true);
    expect(textOf(tooLate)).toContain('update_work_item');
  });

  it('every act reaches the TIMELINE, in order, with the agent that made it', async () => {
    // The seam between MOTIR-3540's writes and the sibling story's READ path.
    // Each card sees one half: the write tests read `planRevision` rows through
    // `adminDb`, and the read tests are fed hand-built rows. That the two agree
    // on a plan an agent actually drove is neither card's assertion.
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);

    const planId = (
      await call(client, CREATE_PLAN_TOOL_NAME, {
        projectKey: fx.projectIdentifier,
        title: 'Trail',
        plannedWithHarness: 'Claude Code',
        plannedWithModel: 'claude-opus-5',
      })
    ).structuredContent as unknown as { id: string };
    const id = (planId as unknown as { id: string }).id;

    // ⚠️ KINDS CHOSEN SO THE CORRECTED TREE IS LEGAL (MOTIR-3936). The
    // correction below re-parents 'Two' UNDER 'One', and since MOTIR-3936
    // `correctProposal` re-runs the close's gate — so a correction that leaves
    // the plan in a state approve would refuse is now REFUSED, and no `edited`
    // row is written. `ALLOWED_CHILD_TYPES` lets a STORY hold a task and does
    // not let a task hold a task, so this test wrote a re-parent approve was
    // always going to reject; it survived only because nothing checked. This is
    // the same care `tests/e2e/plan-proposal-correction.spec.ts` already takes,
    // for the same reason — the assertion here is about the TIMELINE, and the
    // correction is only its vehicle.
    const first = ids(
      await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
        planId: id,
        proposals: [{ op: 'add', proposedFields: { title: 'One', kind: 'story' } }],
      }),
    )[0]!;
    const second = ids(
      await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
        planId: id,
        proposals: [{ op: 'add', proposedFields: { title: 'Two', kind: 'task' } }],
      }),
    )[0]!;
    await call(client, ADD_PLAN_ITEMS_TOOL_NAME, { planId: id, proposals: [], final: true });
    await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId: id,
      planItemId: second,
      parentRef: `${TEMP_REF_PREFIX}${first}`,
    });
    await call(client, WITHDRAW_PLAN_PROPOSAL_TOOL_NAME, { planId: id, planItemId: second });

    const { history } = await planReviewService.getPlanReview(id, fx.ctx);
    // ⚠️ FIVE rows for six acts, and the missing one is not a lost act — the two
    // consecutive appends COLLAPSE, because they are the same kind by the same
    // actor with nothing between them (the sibling story's collapse rule). The
    // seam is exactly where that becomes observable: the write side records two
    // rows and the read side renders one carrying a count of two, and no single
    // card's tests see both halves.
    expect(history.map((e) => e.kind)).toEqual([
      'created',
      'appended',
      'planned',
      'edited',
      'withdrawn',
    ]);
    expect(history.find((e) => e.kind === 'appended')!.count).toBe(2);
    // …and the two content acts after `planned` are NOT collapsed into each
    // other, because they are different kinds — so a reviewer sees them as two
    // separate things that happened while they were reading.
    expect(history.find((e) => e.kind === 'edited')!.count).toBe(1);
    expect(history.find((e) => e.kind === 'withdrawn')!.count).toBe(1);

    // ⚠️ The two content acts that happened AFTER the plan was closed sit AFTER
    // `planned` — which is the reviewer's whole question: what they are looking
    // at is not what they started reading.
    const plannedAt = history.findIndex((e) => e.kind === 'planned');
    expect(history.findIndex((e) => e.kind === 'edited')).toBeGreaterThan(plannedAt);
    expect(history.findIndex((e) => e.kind === 'withdrawn')).toBeGreaterThan(plannedAt);

    // …and both name the AGENT, not the person holding the token. A correction
    // reaching a `planned` plan is an agent act by construction — that is the
    // only reason the tool exists — and the reviewer needs to see which one.
    for (const kind of ['edited', 'withdrawn'] as const) {
      const event = history.find((e) => e.kind === kind)!;
      expect(event.actorHarness, `${kind} must name its harness`).toBe('Claude Code');
      expect(event.actorModel, `${kind} must name its model`).toBe('claude-opus-5');
    }

    // The withdraw's row OUTLIVES the proposal it removed — the id is a value in
    // the diff, not a relation the cascade would null.
    const row = await adminDb.planRevision.findFirstOrThrow({
      where: { planId: id, changeKind: 'withdrawn' },
    });
    expect((row.diff as { withdrewPlanItemId?: string }).withdrewPlanItemId).toBe(second);
  });
});

// ── D · the grant, over the SET rather than the two tools ───────────────────

describe('the plan-AUTHORING surface as a whole is closed to a CLI-minted token', () => {
  it('every author tool refuses one — so a tool added to the set cannot open it by accident', () => {
    // Block 6's assertion is per-tool and lives with the tools. This one is over
    // the SET: the property `_shared.md` states — a sandboxed run can open a plan
    // and can write nothing to it — is about plan authoring, not about two names.
    // A future author tool declared under a key the CLI grant happens to hold
    // would satisfy every per-tool test and silently break this one.
    const AUTHOR_WRITES = [
      ADD_PLAN_ITEMS_TOOL_NAME,
      UPDATE_PLAN_ITEM_TOOL_NAME,
      UPDATE_PLAN_PROPOSAL_TOOL_NAME,
      WITHDRAW_PLAN_PROPOSAL_TOOL_NAME,
    ] as const;

    for (const tool of AUTHOR_WRITES) {
      expect(permissionDenial(tool, [...CLI_TOKEN_GRANT]), `${tool} must refuse`).not.toBeNull();
    }
    // And the shape of the contract is preserved, not merely the refusals: such
    // a run CAN still open a plan, which is what makes the refusal legible as a
    // policy rather than as an outage.
    expect(permissionDenial(CREATE_PLAN_TOOL_NAME, [...CLI_TOKEN_GRANT])).toBeNull();
  });
});
