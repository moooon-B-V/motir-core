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
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
  UPDATE_PLAN_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `update_plan` (MOTIR-4637) — the MCP door onto a plan's OWN title and summary.
//
// The tool is THIN: the lock, the frozen-status gate and the trail write are all
// `plansService.correctPlanBrief`, and
// `tests/integration/plans/correctPlanBrief.test.ts` proves them there. What is
// asserted HERE is what only the transport can answer:
//
//   1. THE TOOL EXISTS AND REACHES THE SERVICE — through the real MCP transport,
//      with a real argument schema, not a direct service call.
//   2. ⚠️ THE PERMISSION CONTRACT, IN BOTH DIRECTIONS — and the one that matters
//      is the REFUSAL. A token built from `CLI_TOKEN_GRANT` must be DENIED, and
//      the assertion is built from that CONSTANT rather than an inline list, so a
//      later widening of the grant fails HERE instead of quietly letting a
//      sandboxed run rewrite what a plan says about itself.
//   3. THE DESCRIPTION STATES THE CONTRACT an agent plans against — including
//      the one thing it cannot guess: that this is NOT the door onto a proposal.
//   4. NOTHING BECOMES A WORK ITEM.

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
  const client = new Client({ name: 'update-plan', version: '0.0.0' });
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

/** A CLOSED plan carrying two proposals and a wrong summary — the incident. */
async function plannedPlanWithTwoAdds(client: Client, fx: WorkItemFixture) {
  const created = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'Close the BYOK code-index loop',
    summary: 'The org is the billing unit for code indexing.',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5',
  });
  const planId = (created.structuredContent as unknown as { id: string }).id;

  await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: [{ op: 'add', proposedFields: { title: 'The prerequisite', kind: 'story' } }],
  });
  await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: [{ op: 'add', proposedFields: { title: 'The dependent', kind: 'task' } }],
  });
  await call(client, ADD_PLAN_ITEMS_TOOL_NAME, { planId, proposals: [], final: true });
  return { planId };
}

describe('the tool is registered, permissioned and free', () => {
  it('is in the registry and declared in TOOL_PERMISSIONS', () => {
    expect(MCP_TOOL_NAMES).toContain(UPDATE_PLAN_TOOL_NAME);
    expect(TOOL_PERMISSIONS[UPDATE_PLAN_TOOL_NAME]).toBe('ai:view_plan');
  });

  it('the gate opens with the key and closes without it', () => {
    const withoutIt = GRANTABLE_PERMISSIONS.filter(
      (p) => p !== TOOL_PERMISSIONS[UPDATE_PLAN_TOOL_NAME],
    );
    expect(permissionDenial(UPDATE_PLAN_TOOL_NAME, withoutIt)).not.toBeNull();
    expect(permissionDenial(UPDATE_PLAN_TOOL_NAME, GRANTABLE_PERMISSIONS)).toBeNull();
  });

  it('is NOT billable — correcting a sentence starts no model job', () => {
    expect(isBillableTool(UPDATE_PLAN_TOOL_NAME)).toBe(false);
  });

  it('a CLI-minted token is REFUSED, and the refusal names the missing key', () => {
    // Built from the CONSTANT, never from an inline list: widening
    // `CLI_TOKEN_GRANT` later fails THIS test rather than quietly handing a
    // sandboxed run the plan-authoring surface through a sixth door.
    expect(CLI_TOKEN_GRANT).not.toContain('ai:view_plan');
    const denial = permissionDenial(UPDATE_PLAN_TOOL_NAME, [...CLI_TOKEN_GRANT]);
    expect(denial).not.toBeNull();
    const text = textOf(denial!);
    expect(text).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(text).toContain('ai:view_plan');
    expect(text).toContain(UPDATE_PLAN_TOOL_NAME);
  });

  it('its description states the contract an agent plans against', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === UPDATE_PLAN_TOOL_NAME)!;

    // The status boundary — the half a caller would otherwise discover by being
    // refused.
    expect(tool.description).toContain('planned');
    expect(tool.description).toContain('approved');
    expect(tool.description).toContain('declined');
    // ⚠️ AND THE HALF NOBODY CAN GUESS: this is not the door onto a proposal,
    // and the neighbouring tool that IS one is named.
    expect(tool.description).toMatch(/NO proposal/);
    expect(tool.description).toContain(UPDATE_PLAN_PROPOSAL_TOOL_NAME);
  });
});

describe('driven through the real transport with a workspace PAT', () => {
  it('corrects a `planned` plan’s summary and keeps every proposal, on the same id', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId } = await plannedPlanWithTwoAdds(client, fx);

    const corrected = await call(client, UPDATE_PLAN_TOOL_NAME, {
      planId,
      summary: 'Motir does not charge for code indexing.',
    });
    expect(corrected.isError).toBeFalsy();

    const payload = corrected.structuredContent as unknown as {
      id: string;
      status: string;
      itemCount: number;
    };
    expect(payload.id).toBe(planId);
    expect(payload.status).toBe('planned');
    expect(payload.itemCount).toBe(2);

    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(row.summary).toBe('Motir does not charge for code indexing.');
    expect(row.title).toBe('Close the BYOK code-index loop');
  });

  it('refuses a call that sends neither field, without touching the plan', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId } = await plannedPlanWithTwoAdds(client, fx);

    const refused = await call(client, UPDATE_PLAN_TOOL_NAME, { planId });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('INVALID_PROPOSAL');

    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(row.summary).toBe('The org is the billing unit for code indexing.');
  });

  it('surfaces PLAN_NOT_EDITABLE on a decided plan, through the transport', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId } = await plannedPlanWithTwoAdds(client, fx);
    const { plansService } = await import('@/lib/services/plansService');
    await plansService.declinePlan(planId, fx.ctx);

    const refused = await call(client, UPDATE_PLAN_TOOL_NAME, { planId, title: 'Too late' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('PLAN_NOT_EDITABLE');
  });

  it('creates NO work item', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId } = await plannedPlanWithTwoAdds(client, fx);
    const before = await adminDb.workItem.count({ where: { projectId: fx.projectId } });

    await call(client, UPDATE_PLAN_TOOL_NAME, { planId, summary: 'Corrected.' });

    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(before);
  });
});
