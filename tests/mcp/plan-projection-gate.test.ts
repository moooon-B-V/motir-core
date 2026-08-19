import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { buildMcpServer } from '@/lib/mcp/registry';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { projectedSearchDelta, projectedWorkItem } from '@/lib/services/planProjectionService';
import { planValidityService } from '@/lib/services/planValidityService';
import type { PlanWithItemsDto, ProposalInput } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE STORY GATE (Story MOTIR-3093 · Subtask MOTIR-3097) over real Postgres.
//
// The projected-validity RULES are `planValidityService`'s own suite and the
// per-tool transport is MOTIR-3095's / MOTIR-3096's. What lives HERE is the set
// of invariants that only become breakable once a PAT can reach the projection —
// each one an ABSENCE, which is why none of them would be noticed by a
// percentage or by any other test in the story passing.

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
  const client = new Client({ name: 'projection-gate', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** Call a tool, swallowing a transport-level rejection into an error result —
 *  a tool that REFUSES an unknown argument and one that ignores it are both
 *  legitimate answers to "does a plan reach the ready set", and the assertion
 *  below is about what comes back either way. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: String(err) }] };
  }
}

const struct = (r: CallToolResult) => (r.structuredContent ?? {}) as Record<string, unknown>;
const text = (r: CallToolResult) => (r.content as { type: string; text: string }[])[0]?.text ?? '';
const whole = (r: CallToolResult) => JSON.stringify(r);

const mk = (
  fx: WorkItemFixture,
  title: string,
  kind: 'epic' | 'story' | 'task' | 'subtask',
  parentId?: string,
) => workItemsService.createWorkItem({ projectId: fx.projectId, kind, title, parentId }, fx.ctx);

async function freshPlan(fx: WorkItemFixture): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Plan' }, fx.ctx);
  return plan.id;
}

const addProposals = (fx: WorkItemFixture, planId: string, proposals: ProposalInput[]) =>
  plansService.addProposals(planId, proposals, fx.ctx);

const refByTitle = (plan: PlanWithItemsDto, title: string): string =>
  `${TEMP_REF_PREFIX}${plan.items.find((i) => i.proposedFields?.title === title)!.id}`;

// ⚠️ THE GUARD THAT STOPS AN AGENT DISPATCHING A CARD THAT DOES NOT EXIST.
// A proposal is not a work item: it has no key, `claim_next_ready` cannot
// transition a row that is not there, and the natural call after a ready list is
// *claim this*. So the ready family takes no projection — and because that is an
// ABSENCE, it is asserted directly rather than inferred from the tools' schemas.
describe('the ready set NEVER contains a proposal, even when a plan is named', () => {
  it('list_ready / next_ready / claim_next_ready return no proposal for a plan whose adds would otherwise be ready', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    // Two ROOT `add`s with no blockers at all — the shape that would qualify as
    // ready the instant it materialized. If a projection ever leaked into the
    // ready path, this is what would come through it.
    await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Would-be ready A', kind: 'task' } },
      { op: 'add', proposedFields: { title: 'Would-be ready B', kind: 'task' } },
    ]);

    const client = await connectClient(fx.ctx);
    for (const tool of ['list_ready', 'next_ready', 'claim_next_ready']) {
      const withPlan = await call(client, tool, { projectKey: fx.projectIdentifier, planId });
      const without = await call(client, tool, { projectKey: fx.projectIdentifier });
      for (const res of [withPlan, without]) {
        expect(whole(res), `${tool} leaked a temp-ref`).not.toContain(TEMP_REF_PREFIX);
        expect(whole(res), `${tool} leaked a proposal title`).not.toContain('Would-be ready');
      }
    }
  });

  it('no proposal is dispatchable — nothing in the tree moved, and the plan is untouched', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Would-be ready', kind: 'task' } },
    ]);
    const before = await adminDb.workItem.count({ where: { projectId: fx.projectId } });

    const client = await connectClient(fx.ctx);
    await call(client, 'claim_next_ready', { projectKey: fx.projectIdentifier, planId });

    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(before);
    expect((await plansService.getPlan(planId, fx.ctx)).items).toHaveLength(1);
  });
});

// ⚠️ THE ACCESS BOUNDARY. Every projected call gets its gate from ONE place —
// `plansService.getPlan`'s browse assert inside `buildProjection` — so if that
// leaked, it would leak on all five at once.
describe('the workspace boundary holds on every projected call', () => {
  it('a token from another workspace naming this plan gets not-found — never a projection, never proof it exists', async () => {
    const owner = await makeWorkItemFixture();
    const story = await mk(owner, 'Owner story', 'story');
    const planId = await freshPlan(owner);
    await addProposals(owner, planId, [
      { op: 'add', proposedFields: { title: 'Owner secret', kind: 'task' }, parentRef: story.id },
    ]);

    const outsider = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    const client = await connectClient(outsider.ctx);

    for (const [tool, args] of [
      ['validate_plan', { planId }],
      ['validate_sprint', { planId }],
      ['validate_work_item', { key: story.identifier, planId }],
      ['get_work_item', { key: story.identifier, planId }],
      ['search_work_items', { projectKey: outsider.projectIdentifier, planId }],
    ] as const) {
      const res = await call(client, tool, args);
      expect(res.isError, `${tool} answered an outsider`).toBe(true);
      // 404-not-403: the refusal must not distinguish "not yours" from "does not
      // exist", and it must carry none of the plan's content either way.
      expect(text(res)).toMatch(/NOT_FOUND/);
      expect(whole(res)).not.toContain('Owner secret');
      expect(whole(res)).not.toContain(TEMP_REF_PREFIX);
    }
  });
});

// ⚠️ THE TEMP-REF SURVIVES APPROVE — as a real key, which is the whole point of
// the addressing model. Before: the only way to name the card. After: it names a
// work item, and the temp-ref is spent.
describe('a temp-ref before approve is the card that has a key after it', () => {
  it('validates by temp-ref while proposed, and the materialized item carries the same title under a real key', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    const plan = await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Becomes real', kind: 'task' } },
    ]);
    const ref = refByTitle(plan, 'Becomes real');
    const planItemId = plan.items[0]!.id;

    const client = await connectClient(fx.ctx);
    const beforeApprove = await call(client, 'validate_work_item', { key: ref, planId });
    expect(beforeApprove.isError).toBeFalsy();
    expect(struct(beforeApprove).key).toBe(ref);

    await plansService.markPlanned(planId, fx.ctx);
    const approved = await plansService.approvePlan(planId, fx.ctx);
    const materialized = approved.items.find((i) => i.id === planItemId)!;
    expect(materialized.workItemId).not.toBeNull();

    const row = await adminDb.workItem.findUniqueOrThrow({
      where: { id: materialized.workItemId! },
    });
    expect(row.title).toBe('Becomes real');
    // The real key now answers the un-projected read the temp-ref never could.
    const afterApprove = await call(client, 'get_work_item', { key: row.identifier });
    expect(afterApprove.isError).toBeFalsy();
    expect((struct(afterApprove).item as { title: string }).title).toBe('Becomes real');
  });
});

// The registry guards. The maps are `Record<McpToolName, …>`, so a MISSING row is
// a compile error — what a test adds is the KEY each one is filed under, which is
// not, and which is exactly what an analogy with a neighbouring tool gets wrong.
describe('the registry rows this story added or touched', () => {
  it('names the exact permission for every tool that gained a projected mode', () => {
    expect(TOOL_PERMISSIONS.validate_plan).toBe('project:browse');
    expect(TOOL_PERMISSIONS.validate_work_item).toBe('project:browse');
    expect(TOOL_PERMISSIONS.validate_sprint).toBe('project:browse');
    expect(TOOL_PERMISSIONS.get_work_item).toBe('project:browse');
    expect(TOOL_PERMISSIONS.search_work_items).toBe('project:browse');
    // NOT `ai:view_plan` — that key gates the plan DECISIONS, and a projection
    // decides nothing. The neighbouring `add_plan_items` is the analogy that
    // would file these wrong, so it is pinned here beside them.
    expect(TOOL_PERMISSIONS.add_plan_items).toBe('ai:view_plan');
  });

  it('registers `validate_plan` on the server and in the legacy scope table', async () => {
    expect(MCP_TOOL_NAMES).toContain('validate_plan');
    expect(TOOL_SCOPES.validate_plan).toBe('read');
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const shipped = (await client.listTools()).tools;
    expect(shipped.map((t) => t.name)).toContain('validate_plan');
    // The five projected-capable tools all advertise the SAME argument name —
    // MOTIR-3094 Q5's whole point was that they address a plan identically.
    for (const name of [
      'validate_plan',
      'validate_work_item',
      'validate_sprint',
      'get_work_item',
      'search_work_items',
    ]) {
      const tool = shipped.find((t) => t.name === name)!;
      expect(Object.keys(tool.inputSchema.properties ?? {}), name).toContain('planId');
    }
  });
});

// The projection's own edge cases — reached through the service rather than a
// tool, because they are properties of the merge and not of any transport.
// ⚠️ NOT here, deliberately: a `modify`'s PATCHED body being the one the
// prose-vs-graph advisory scans is already asserted by
// `tests/integration/plans/planValidityService.test.ts` ("a `modify`'s PATCHED
// body is what gets scanned, not the stored one"). This gate covers the MCP
// surface over the rules, not the rules — duplicating one would give two places
// to update and one of them would be forgotten.
describe('the projection merge — the cases a plan can put in front of it', () => {
  it('drops a `modify` whose target is no longer in the tree, instead of inventing a node for it', async () => {
    const fx = await makeWorkItemFixture();
    const doomed = await mk(fx, 'Archived later', 'task');
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      { op: 'modify', workItemId: doomed.id, patch: { title: 'Never applied' } },
    ]);
    // The projection reads the live tree, and archiving takes the row out of it —
    // so the plan now patches something that is not there. The merge must skip
    // it rather than resurrect it.
    await workItemsService.archiveWorkItem(doomed.id, fx.ctx);

    const delta = await projectedSearchDelta(planId, fx.ctx);
    expect(delta.modifiedIds).toEqual([]);
    const verdict = await planValidityService.validateProjectedPlan(planId, fx.ctx);
    expect(verdict.valid).toBe(true);
  });

  it('drops a `modify`d edge whose target does not resolve, rather than gating on a phantom', async () => {
    const fx = await makeWorkItemFixture();
    const gated = await mk(fx, 'Gated', 'task');
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      {
        op: 'modify',
        workItemId: gated.id,
        // A well-formed id naming no row anybody can see. The `add` path's
        // twin is asserted below; both arms of the same rule, because the merge
        // applies them in different passes.
        patch: { blockedByAdd: ['cmyyyyyyyyyyyyyyyyyyyyyyy'] },
      },
    ]);

    const detail = await projectedWorkItem(planId, gated.identifier, fx.ctx);
    expect(detail.blockedBy).toEqual([]);
    expect((await planValidityService.validateProjectedPlan(planId, fx.ctx)).valid).toBe(true);
  });

  it('drops a proposed edge whose target does not resolve, rather than gating on a phantom', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: { title: 'Gated by nothing', kind: 'task' },
        // A well-formed id that names no row anybody can see. An edge to it must
        // vanish — the alternative is a plan that can never be valid because it
        // is blocked by something that does not exist.
        blockedByRefs: ['cmzzzzzzzzzzzzzzzzzzzzzzz'],
      },
    ]);

    const verdict = await planValidityService.validateProjectedPlan(planId, fx.ctx);
    expect(verdict.valid).toBe(true);
    expect(verdict.blockers).toEqual([]);
  });

  it('a detail read of a plan-only subtree needs no stored rows at all', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    const parent = await addProposals(fx, planId, [
      { op: 'add', proposedFields: { title: 'Proposed parent', kind: 'story' } },
    ]);
    const parentRef = refByTitle(parent, 'Proposed parent');
    await addProposals(fx, planId, [
      {
        op: 'add',
        proposedFields: { title: 'Proposed leaf', kind: 'subtask', storyPoints: 2 },
        parentRef,
      },
    ]);

    const detail = await projectedWorkItem(planId, parentRef, fx.ctx);
    expect(detail.target.proposal).toBe(true);
    expect(detail.committedChildren).toEqual([]);
    expect(detail.proposedChildren).toHaveLength(1);
    expect(detail.proposedChildren[0]!.storyPoints).toBe(2);
    expect(detail.proposedChildren[0]!.parent).toBe(parentRef);
  });
});
