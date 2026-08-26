import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_PERMISSIONS, CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { isBillableTool } from '@/lib/mcp/rateLimitGate';
import { permissionDenial, PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  UPDATE_PLAN_ITEM_TOOL_NAME,
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
  WITHDRAW_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `update_plan_proposal` + `withdraw_plan_proposal` (Story MOTIR-3533 · Subtask
// MOTIR-3541) — the MCP door onto a LANDED plan.
//
// Both tools are THIN: the lock, the frozen-status gate, the ref re-validation,
// the referrer check and the trail write are all `plansService`, and
// `tests/integration/plans/correctAndWithdrawProposal.test.ts` proves them
// there. What is asserted HERE is what only the transport can answer:
//
//   1. THE TOOLS EXIST AND REACH THE SERVICE — through the real MCP transport,
//      with a real argument schema, not a direct service call.
//   2. ⚠️ THE PERMISSION CONTRACT, IN BOTH DIRECTIONS — and the one that matters
//      is the REFUSAL. A token built from `CLI_TOKEN_GRANT` must be DENIED, and
//      the assertion is built from that CONSTANT rather than from an inline
//      permission list, so a later widening of the grant fails HERE instead of
//      silently changing what a sandboxed run may do to a plan. MOTIR-3058 and
//      MOTIR-3051 both shipped green against an admin token and refused the one
//      caller they were built for; this is the assertion neither had.
//   3. NOTHING BECOMES A WORK ITEM, on either tool.

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
  const client = new Client({ name: 'correct-plan-proposal', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text?: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

/** A plan with two `add`s appended in SEPARATE calls, so both ids are refable. */
async function planWithTwoAdds(client: Client, fx: WorkItemFixture) {
  const created = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'A correctable plan',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5',
  });
  const planId = (created.structuredContent as unknown as { id: string }).id;

  const first = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: [{ op: 'add', proposedFields: { title: 'The prerequisite', kind: 'story' } }],
  });
  const firstId = (first.structuredContent as unknown as { planItemIds: string[] }).planItemIds[0]!;

  const second = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: [{ op: 'add', proposedFields: { title: 'The dependent', kind: 'task' } }],
  });
  const secondId = (second.structuredContent as unknown as { planItemIds: string[] })
    .planItemIds[0]!;

  return { planId, firstId, secondId };
}

describe('the two tools are registered, permissioned and free', () => {
  it('are in the registry and declared in TOOL_PERMISSIONS', () => {
    expect(MCP_TOOL_NAMES).toContain(UPDATE_PLAN_PROPOSAL_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(WITHDRAW_PLAN_PROPOSAL_TOOL_NAME);
    expect(TOOL_PERMISSIONS[UPDATE_PLAN_PROPOSAL_TOOL_NAME]).toBe('ai:view_plan');
    expect(TOOL_PERMISSIONS[WITHDRAW_PLAN_PROPOSAL_TOOL_NAME]).toBe('ai:view_plan');
  });

  it('the gate opens with the key and closes without it', () => {
    for (const tool of [
      UPDATE_PLAN_PROPOSAL_TOOL_NAME,
      WITHDRAW_PLAN_PROPOSAL_TOOL_NAME,
    ] as const) {
      const withoutIt = GRANTABLE_PERMISSIONS.filter((p) => p !== TOOL_PERMISSIONS[tool]);
      expect(permissionDenial(tool, withoutIt), `${tool} should be denied`).not.toBeNull();
      expect(permissionDenial(tool, GRANTABLE_PERMISSIONS)).toBeNull();
    }
  });

  it('are NOT billable — correcting a plan starts no model job', () => {
    expect(isBillableTool(UPDATE_PLAN_PROPOSAL_TOOL_NAME)).toBe(false);
    expect(isBillableTool(WITHDRAW_PLAN_PROPOSAL_TOOL_NAME)).toBe(false);
  });

  it('their descriptions state the contract an agent plans against', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const correct = byName.get(UPDATE_PLAN_PROPOSAL_TOOL_NAME)!;
    expect(correct.description).toContain('planned');
    expect(correct.description).toContain('approved');
    expect(correct.description).toContain('update_work_item');
    expect(correct.description).toContain('declined');

    const withdraw = byName.get(WITHDRAW_PLAN_PROPOSAL_TOOL_NAME)!;
    // The dangling-ref behaviour is the one an agent cannot guess and would
    // otherwise discover by being refused.
    expect(withdraw.description).toMatch(/referenc/i);
    expect(withdraw.description).toContain('remove');
  });
});

// ── ⚠️ THE ASSERTION THIS CARD EXISTS FOR ───────────────────────────────────

describe('a CLI-minted token is REFUSED, and the refusal names the missing key', () => {
  it('CLI_TOKEN_GRANT does not carry `ai:view_plan`, so both tools are denied', () => {
    // Built from the CONSTANT, never from an inline list. That is the whole
    // mechanism: widening `CLI_TOKEN_GRANT` later fails THIS test rather than
    // quietly handing a sandboxed run the plan-authoring surface.
    expect(CLI_TOKEN_GRANT).not.toContain('ai:view_plan');

    for (const tool of [
      UPDATE_PLAN_PROPOSAL_TOOL_NAME,
      WITHDRAW_PLAN_PROPOSAL_TOOL_NAME,
    ] as const) {
      const denial = permissionDenial(tool, [...CLI_TOKEN_GRANT]);
      expect(denial, `${tool} must refuse a CLI-minted token`).not.toBeNull();
      const text = textOf(denial!);
      expect(text).toContain(PERMISSION_NOT_GRANTED_CODE);
      // It names the key the operator would have to grant, not just "denied".
      expect(text).toContain('ai:view_plan');
      expect(text).toContain(tool);
    }
  });

  it('is the SAME refusal a CLI token already gets on `add_plan_items` — not a new limit', () => {
    // The contract `motir-meta/prompts/_shared.md` states: such a run can open a
    // plan (`create_plan` needs only `work_item:edit`) and is refused on its
    // first append. These two tools join the refused set; nothing about what a
    // sandboxed run may do to a plan has changed.
    expect(permissionDenial(CREATE_PLAN_TOOL_NAME, [...CLI_TOKEN_GRANT])).toBeNull();
    expect(permissionDenial(ADD_PLAN_ITEMS_TOOL_NAME, [...CLI_TOKEN_GRANT])).not.toBeNull();
    expect(permissionDenial(UPDATE_PLAN_ITEM_TOOL_NAME, [...CLI_TOKEN_GRANT])).not.toBeNull();
  });
});

describe('driven through the real transport with a workspace PAT', () => {
  it('corrects a proposal’s parent and dependency edges on a `planned` plan', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, firstId, secondId } = await planWithTwoAdds(client, fx);

    // Close it for review — the case the story exists for.
    await call(client, ADD_PLAN_ITEMS_TOOL_NAME, { planId, proposals: [], final: true });

    const corrected = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: secondId,
      parentRef: `${TEMP_REF_PREFIX}${firstId}`,
      blockedByRefs: [`${TEMP_REF_PREFIX}${firstId}`],
    });
    expect(corrected.isError).toBeFalsy();

    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: secondId } });
    expect(row.parentRef).toBe(`${TEMP_REF_PREFIX}${firstId}`);
    expect(row.blockedByRefs).toEqual([`${TEMP_REF_PREFIX}${firstId}`]);
  });

  it('corrects a `modify`’s patch — the shape the live artifact got wrong', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'An existing card' });
    const { planId, firstId } = await planWithTwoAdds(client, fx);

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: target.id, patch: { priority: 'low' } }],
    });
    const modifyId = (appended.structuredContent as unknown as { planItemIds: string[] })
      .planItemIds[0]!;

    const corrected = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: modifyId,
      patch: { blockedByAdd: [`${TEMP_REF_PREFIX}${firstId}`] },
    });
    expect(corrected.isError).toBeFalsy();
    expect(
      await adminDb.planItem.findUniqueOrThrow({ where: { id: modifyId } }).then((r) => r.patch),
    ).toEqual({ blockedByAdd: [`${TEMP_REF_PREFIX}${firstId}`] });
  });

  it('REFUSES a correction that names no proposal, through the transport', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, secondId } = await planWithTwoAdds(client, fx);

    const result = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: secondId,
      parentRef: `${TEMP_REF_PREFIX}nothing`,
    });
    // Typed and readable — not a JSON-RPC internal error carrying ORM prose.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('UNRESOLVED_PLAN_REF');
  });

  it('withdraws a proposal, and REFUSES one a sibling still references', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, firstId, secondId } = await planWithTwoAdds(client, fx);

    await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: secondId,
      blockedByRefs: [`${TEMP_REF_PREFIX}${firstId}`],
    });

    const refused = await call(client, WITHDRAW_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: firstId,
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('PLAN_PROPOSAL_REFERENCED');
    expect(textOf(refused)).toContain(secondId);

    // Clear the reference, then it withdraws.
    await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: secondId,
      blockedByRefs: [],
    });
    const ok = await call(client, WITHDRAW_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: firstId,
    });
    expect(ok.isError).toBeFalsy();
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(1);
  });

  it('REFUSES both once the plan is approved, naming the status and the work item', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, secondId } = await planWithTwoAdds(client, fx);
    await call(client, ADD_PLAN_ITEMS_TOOL_NAME, { planId, proposals: [], final: true });

    const { plansService } = await import('@/lib/services/plansService');
    await plansService.approvePlan(planId, fx.ctx);

    const correction = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: secondId,
      title: 'Too late',
    });
    expect(correction.isError).toBe(true);
    expect(textOf(correction)).toContain('PLAN_NOT_EDITABLE');
    expect(textOf(correction)).toContain('update_work_item');

    const withdraw = await call(client, WITHDRAW_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: secondId,
    });
    expect(withdraw.isError).toBe(true);
    expect(textOf(withdraw)).toContain('PLAN_NOT_EDITABLE');
  });

  it('creates NO work item — the property the whole surface rests on', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const before = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
    const { planId, firstId, secondId } = await planWithTwoAdds(client, fx);

    await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: secondId,
      parentRef: `${TEMP_REF_PREFIX}${firstId}`,
      title: 'Renamed',
    });
    await call(client, WITHDRAW_PLAN_PROPOSAL_TOOL_NAME, { planId, planItemId: secondId });

    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(before);
  });
});

describe('the deepen tool is untouched', () => {
  it('`update_plan_item` still cannot reach the structural fields', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const deepen = tools.find((t) => t.name === UPDATE_PLAN_ITEM_TOOL_NAME)!;
    const props = Object.keys(
      (deepen.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    expect(props).not.toContain('parentRef');
    expect(props).not.toContain('blockedByRefs');
    expect(props).not.toContain('targetRepo');
    expect(props).not.toContain('patch');
  });
});
