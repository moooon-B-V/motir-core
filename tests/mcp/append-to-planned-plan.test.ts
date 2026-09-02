import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { TOOL_PERMISSIONS, CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { permissionDenial, PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { ADD_PLAN_ITEMS_TOOL_NAME, CREATE_PLAN_TOOL_NAME } from '@/lib/mcp/tools/authorPlan';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Bug MOTIR-4153 — `add_plan_items { revision: true }`, the MCP half of
// AMENDMENT 10 D1 (`docs/decisions/agent-authored-plans.md` AMENDMENT 12).
//
// The SUBSTRATE is proved in `tests/integration/plans/revisionAppend.test.ts` —
// the status gate, the ref check, the close's gate, the trail row. What is
// asserted HERE is what only the transport can answer, on the same three axes
// `correct-plan-proposal.test.ts` uses for the sibling verbs:
//
//   1. THE FLAG EXISTS ON THE WIRE and reaches the service, through a real MCP
//      client with a real argument schema — not a direct service call with an
//      options object the transport might never have carried.
//   2. THE ARGUMENT GRAMMAR — the two cross-field refusals that live in the
//      adapter because a `ZodRawShape` has nowhere to hang them, and which a
//      service test therefore cannot see at all.
//   3. ⚠️ THE PERMISSION CONTRACT IS UNMOVED. A token built from
//      `CLI_TOKEN_GRANT` must still be denied, and the assertion is built from
//      that CONSTANT so a later widening fails HERE rather than silently handing
//      a sandboxed run a third verb on a landed plan.

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
  const client = new Client({ name: 'append-to-planned-plan', version: '0.0.0' });
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

/** A plan authored and CLOSED over the door under test, exactly as a real
 *  authoring pass closes one: append the shape, then `final: true`. */
async function closedPlan(client: Client, fx: WorkItemFixture) {
  const created = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'A plan that landed',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5',
  });
  const planId = (created.structuredContent as unknown as { id: string }).id;

  const first = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: [{ op: 'add', proposedFields: { title: 'The story', kind: 'story' } }],
  });
  const firstId = (first.structuredContent as unknown as { planItemIds: string[] }).planItemIds[0]!;

  const closed = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: [],
    final: true,
  });
  return { planId, firstId, closeResult: closed };
}

describe('the flag reaches the service over the real transport', () => {
  it('appends to a `planned` plan and returns the new proposal’s id', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId } = await closedPlan(client, fx);

    const revised = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      revision: true,
      proposals: [
        { op: 'add', proposedFields: { title: 'The card the correction needed', kind: 'task' } },
      ],
    });

    expect(revised.isError).toBeFalsy();
    const ids = (revised.structuredContent as unknown as { planItemIds: string[] }).planItemIds;
    expect(ids).toHaveLength(1);
    const stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: ids[0]! } });
    expect((stored.proposedFields as { title?: string }).title).toBe(
      'The card the correction needed',
    );
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'planned',
    );
  });

  it('says what happened, and does NOT repeat the “accepts no further proposals” line', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId } = await closedPlan(client, fx);

    const revised = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      revision: true,
      proposals: [{ op: 'add', proposedFields: { title: 'Arrived late', kind: 'task' } }],
    });

    // Until a revision could append, `status === 'planned'` in this summary meant
    // exactly one thing — this call carried `final: true` — so the line said the
    // plan accepts no further proposals. A revision reaches the same status
    // having just disproved that.
    const text = textOf(revised);
    expect(text).toContain('timeline');
    expect(text).not.toContain('accepts no further');
  });

  it('the CLOSE’s own summary names the door instead of declaring a dead end', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { closeResult } = await closedPlan(client, fx);
    expect(textOf(closeResult)).toContain('revision: true');
  });

  it('an undeclared append to the same plan is refused, and the refusal names the flag', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId } = await closedPlan(client, fx);

    const refused = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'add', proposedFields: { title: 'Undeclared', kind: 'task' } }],
    });

    expect(refused.isError).toBe(true);
    const text = textOf(refused);
    expect(text).toContain('PLAN_NOT_GENERATING');
    expect(text).toContain('revision: true');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(1);
  });

  it('a `planItem:` ref into the plan being revised resolves', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, firstId } = await closedPlan(client, fx);

    const revised = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      revision: true,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'A child of what was already there', kind: 'task' },
          parentRef: `${TEMP_REF_PREFIX}${firstId}`,
        },
      ],
    });

    const id = (revised.structuredContent as unknown as { planItemIds: string[] }).planItemIds[0]!;
    expect((await adminDb.planItem.findUniqueOrThrow({ where: { id } })).parentRef).toBe(
      `${TEMP_REF_PREFIX}${firstId}`,
    );
  });
});

describe('the argument grammar — the two pairings the adapter refuses', () => {
  it('`revision` + `final` is refused, and nothing is appended', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId } = await closedPlan(client, fx);

    const refused = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      revision: true,
      final: true,
      proposals: [{ op: 'add', proposedFields: { title: 'Both flags', kind: 'task' } }],
    });

    expect(refused.isError).toBe(true);
    // The refusal has to arrive BEFORE the write: `markPlanned` is un-relaxed, so
    // the composed call would append and then throw from the close, having
    // already written.
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(1);
    expect(textOf(refused)).toContain('cannot be combined');
  });

  it('`revision` with an EMPTY batch is refused, and is NOT sent to `final: true`', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId } = await closedPlan(client, fx);

    const refused = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      revision: true,
      proposals: [],
    });

    expect(refused.isError).toBe(true);
    const text = textOf(refused);
    expect(text).toContain('update_plan_proposal');
    // The pre-existing empty-batch refusal would have pointed the caller at
    // `final: true`, which on an already-closed plan is the one thing this
    // pairing must not be told to do.
    expect(text).not.toContain('CLOSE the plan');
  });

  it('an EMPTY batch with no flags at all still gets the ORIGINAL refusal', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const created = await call(client, CREATE_PLAN_TOOL_NAME, { projectKey: fx.projectIdentifier });
    const planId = (created.structuredContent as unknown as { id: string }).id;

    const refused = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, { planId, proposals: [] });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('CLOSE the plan');
  });
});

describe('the tool tells an agent the contract before it has to discover it', () => {
  it('the description names the revision door and keeps the frozen boundary', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const append = tools.find((t) => t.name === ADD_PLAN_ITEMS_TOOL_NAME)!;

    expect(append.description).toContain('revision: true');
    expect(append.description).toContain('approved');
    expect(append.description).toContain('declined');
    // The `revision` input is on the published schema, not only in the prose.
    expect(Object.keys(append.inputSchema.properties ?? {})).toContain('revision');
  });
});

// ── ⚠️ THE ASSERTION THAT MUST NOT CHANGE ───────────────────────────────────

describe('a CLI-minted token is still REFUSED — this card widens no grant', () => {
  it('CLI_TOKEN_GRANT does not carry `ai:view_plan`, so the append stays denied', async () => {
    // Built from the CONSTANT, never from an inline list: widening
    // `CLI_TOKEN_GRANT` later fails THIS test rather than quietly handing a
    // sandboxed run a third verb on a landed plan. AMENDMENT 10's boundary said
    // the grant is not widened; AMENDMENT 12 widens the DOOR and not the key.
    expect(CLI_TOKEN_GRANT).not.toContain('ai:view_plan');
    expect(TOOL_PERMISSIONS[ADD_PLAN_ITEMS_TOOL_NAME]).toBe('ai:view_plan');

    const denial = permissionDenial(ADD_PLAN_ITEMS_TOOL_NAME, [...CLI_TOKEN_GRANT]);
    expect(denial).not.toBeNull();
    const text = textOf(denial!);
    expect(text).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(text).toContain('ai:view_plan');
  });

  it('the flag buys nothing at the gate — it is an argument, not a capability', async () => {
    // The permission is asserted on the TOOL, before any argument is read, so
    // there is no shape of `add_plan_items` call a CLI-minted token can make.
    expect(permissionDenial(ADD_PLAN_ITEMS_TOOL_NAME, [...CLI_TOKEN_GRANT])).not.toBeNull();
    expect(permissionDenial(ADD_PLAN_ITEMS_TOOL_NAME, ['ai:view_plan'])).toBeNull();
  });
});
