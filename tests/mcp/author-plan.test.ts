import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { isBillableTool } from '@/lib/mcp/rateLimitGate';
import { permissionDenial } from '@/lib/mcp/permissionGate';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { ADD_PLAN_ITEMS_TOOL_NAME, CREATE_PLAN_TOOL_NAME } from '@/lib/mcp/tools/authorPlan';
import { GET_PLAN_TOOL_NAME } from '@/lib/mcp/tools/getPlan';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `create_plan` + `add_plan_items` (Story MOTIR-2982 · Subtask MOTIR-2988) —
// the PAT-authed door onto the plan substrate.
//
// Four contracts are locked here, and each is one the module could break
// silently:
//
//   1. A TREE ARRIVES LAYER BY LAYER. `planItemIds` comes back index-for-index
//      with the proposals that were sent, and `planItem:<id>` refs built from it
//      reconstruct the proposed parenting and dependency edges when the plan is
//      read back. This is the seam an append-order mistake hides in — neither
//      tool's own arguments would look wrong.
//   2. NOTHING BECOMES A WORK ITEM. The project's item count is unchanged after
//      a whole tree is authored and the plan is closed. This is the single most
//      important property of the story.
//   3. THE AUTHOR IS STAMPED, NOT ACCEPTED. `authorSource` is `mcp` because the
//      tool set it, and every `add` carries the plan's own triple in its
//      `planningProvenance` — which is what lets materialize READ that field
//      (MOTIR-2990) without a caller being able to forge it.
//   4. THE GATES ARE THE SERVICE'S. Both permissions, the cross-tenant
//      not-found, the closed-plan refusal, and the billable-set exclusion.
//
// Real Postgres, the real MCP server over the in-memory transport with a
// fixed-context resolver (the `get-plan.test.ts` pattern). motir-ai is never
// involved: neither tool starts a job.

const struct = (r: CallToolResult) => r.structuredContent as unknown as PlanWithItemsDto;
const ids = (r: CallToolResult) =>
  (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;
const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'author-plan', version: '0.0.0' });
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

async function openPlan(client: Client, fx: WorkItemFixture): Promise<string> {
  const result = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'An agent-authored plan',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5',
  });
  return struct(result).id;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('create_plan', () => {
  it('opens a generating plan and stamps `mcp` plus the self-reported harness/model', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);

    const result = await call(client, CREATE_PLAN_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
      title: 'Billing',
      summary: 'Invoices and the emails that carry them.',
      plannedWithHarness: 'Claude Code',
      plannedWithModel: 'claude-opus-5',
    });

    const plan = struct(result);
    expect(plan.status).toBe('generating');
    expect(plan.projectId).toBe(fx.projectId);
    expect(plan.title).toBe('Billing');
    expect(plan.itemCount).toBe(0);

    // SERVER-SET: the tool fixes `mcp`, and there is no argument that could have
    // said otherwise — the property MOTIR-2990's materialize read leans on.
    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(row.authorSource).toBe('mcp');
    expect(row.authorHarness).toBe('Claude Code');
    expect(row.authorModel).toBe('claude-opus-5');

    // WHO ASKED — the token owner, recorded without an argument for it. An
    // agent acts on a person's credential, and that person is the requester.
    expect(row.createdById).toBe(fx.ownerId);

    expect(text(result)).toContain('written by Claude Code');
    await client.close();
  });

  it('states the proposal gate — no work item, approval happens in Motir', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const result = await call(client, CREATE_PLAN_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
    });
    expect(text(result)).toContain('PROPOSALS, not work items');
    await client.close();
  });

  it('answers NOT FOUND for another tenant’s project — never a 403 leak', async () => {
    const fx = await makeWorkItemFixture();
    const outsider = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    const client = await connectClient(outsider.ctx);

    const result = await call(client, CREATE_PLAN_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('PROJECT_NOT_FOUND');

    // …and nothing was opened in the tenant that was probed.
    const plans = await adminDb.plan.count({ where: { projectId: fx.projectId } });
    expect(plans).toBe(0);
    await client.close();
  });
});

describe('add_plan_items — the append-order temp-ref contract', () => {
  it('authors a two-layer tree whose parenting and edges survive a get_plan read', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    // Layer 1 — the containers.
    const first = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'Billing', kind: 'epic' } },
        { op: 'add', proposedFields: { title: 'Invoices', kind: 'story' } },
      ],
    });
    const [epicId, storyId] = ids(first);
    expect(ids(first)).toHaveLength(2);

    // Layer 2 — the leaves, hung off ids the FIRST call returned. This is the
    // whole point of the ordered id list: neither proposal above exists as a
    // work item, so `planItem:<id>` is the only way to name one as a parent.
    const second = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      final: true,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Invoice PDF', kind: 'subtask', storyPoints: 3 },
          parentRef: `${TEMP_REF_PREFIX}${storyId}`,
        },
        {
          op: 'add',
          proposedFields: { title: 'Email the invoice', kind: 'subtask', storyPoints: 2 },
          parentRef: `${TEMP_REF_PREFIX}${storyId}`,
        },
      ],
    });
    const [pdfId] = ids(second);
    expect(struct(second).status).toBe('planned');

    // Read it back through the SIBLING tool a client would use to show it: the
    // proposed tree reconstructs from what came out of the append.
    const read = struct(await call(client, GET_PLAN_TOOL_NAME, { planId }));
    expect(read.itemCount).toBe(4);
    const byId = new Map(read.items.map((i) => [i.id, i]));
    expect(byId.get(epicId!)!.proposedFields!.title).toBe('Billing');
    expect(byId.get(storyId!)!.proposedFields!.title).toBe('Invoices');
    expect(byId.get(pdfId!)!.parentRef).toBe(`${TEMP_REF_PREFIX}${storyId}`);
    await client.close();
  });

  it('returns the ids INDEX-FOR-INDEX with the proposals that were sent', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const titles = ['first', 'second', 'third', 'fourth'];
    const result = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: titles.map((title) => ({ op: 'add', proposedFields: { title } })),
    });

    // The assertion an off-by-one or a re-sort would fail, and that neither
    // tool's own arguments would reveal.
    const read = struct(await call(client, GET_PLAN_TOOL_NAME, { planId }));
    const byId = new Map(read.items.map((i) => [i.id, i.proposedFields?.title]));
    expect(ids(result).map((id) => byId.get(id))).toEqual(titles);
    await client.close();
  });

  it('carries dependency edges as intra-plan temp-refs', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const first = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'add', proposedFields: { title: 'The schema' } }],
    });
    const [schemaId] = ids(first);

    const second = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'The service on it' },
          blockedByRefs: [`${TEMP_REF_PREFIX}${schemaId}`],
        },
      ],
    });

    const read = struct(await call(client, GET_PLAN_TOOL_NAME, { planId }));
    const consumer = read.items.find((i) => i.id === ids(second)[0]);
    expect(consumer!.blockedByRefs).toEqual([`${TEMP_REF_PREFIX}${schemaId}`]);
    await client.close();
  });

  it('`final: true` closes the plan, and a later append is REFUSED', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const closed = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      final: true,
      proposals: [{ op: 'add', proposedFields: { title: 'Only' } }],
    });
    expect(struct(closed).status).toBe('planned');

    const late = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'add', proposedFields: { title: 'Too late' } }],
    });
    expect(late.isError).toBe(true);
    // The service's own typed refusal, in the words it sends an agent. (Unlike
    // the two not-found cases below, `PlanNotGeneratingError` renders as prose
    // rather than a code — this asserts what a client actually reads.)
    expect(text(late)).toContain('not generating');

    // The refusal is a refusal — the plan holds exactly what it held.
    const count = await adminDb.planItem.count({ where: { planId } });
    expect(count).toBe(1);
    await client.close();
  });
});

describe('add_plan_items — authorship and the proposal gate', () => {
  it('stamps every `add` with the PLAN’s authorship triple', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const result = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'add', proposedFields: { title: 'A proposal' } }],
    });

    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: ids(result)[0]! } });
    const fields = row.proposedFields as { planningProvenance?: Record<string, unknown> };
    // The plan's own triple, copied at the append — so the plan's attribution and
    // its items' attribution cannot disagree, and materialize reads a value a
    // Motir write seam wrote rather than one a caller sent.
    expect(fields.planningProvenance).toEqual({
      source: 'mcp',
      harness: 'Claude Code',
      model: 'claude-opus-5',
    });
    await client.close();
  });

  it('offers NO way for a caller to set the provenance itself', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    // The zod schema for `proposedFields` has no `planningProvenance` member, so
    // a caller sending one is not merely ignored downstream — the argument never
    // reaches the service. Asserted through the stored row rather than through
    // the schema, because what matters is what got written.
    const result = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: {
            title: 'Forged',
            planningProvenance: { source: 'native', harness: 'Motir' },
          },
        },
      ],
    });

    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: ids(result)[0]! } });
    const fields = row.proposedFields as { planningProvenance?: Record<string, unknown> };
    expect(fields.planningProvenance).toEqual({
      source: 'mcp',
      harness: 'Claude Code',
      model: 'claude-opus-5',
    });
    await client.close();
  });

  it('creates NO work item — the project’s tree is untouched until approve', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const before = await adminDb.workItem.count({ where: { projectId: fx.projectId } });

    const planId = await openPlan(client, fx);
    const first = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'add', proposedFields: { title: 'Epic', kind: 'epic' } }],
    });
    await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      final: true,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Story', kind: 'story' },
          parentRef: `${TEMP_REF_PREFIX}${ids(first)[0]}`,
        },
      ],
    });

    // A project-wide COUNT, not the absence of a particular title: the property
    // is that authoring a whole plan writes nothing to the tree at all.
    const after = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
    expect(after).toBe(before);
    await client.close();
  });

  it('answers NOT FOUND for another tenant’s plan id', async () => {
    const fx = await makeWorkItemFixture();
    const outsider = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    const owner = await connectClient(fx.ctx);
    const planId = await openPlan(owner, fx);

    const intruder = await connectClient(outsider.ctx);
    const result = await call(intruder, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'add', proposedFields: { title: 'leak?' } }],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('PLAN_NOT_FOUND');

    const count = await adminDb.planItem.count({ where: { planId } });
    expect(count).toBe(0);
    await owner.close();
    await intruder.close();
  });
});

describe('the four registries and the gates', () => {
  it('names the permission each tool’s own service asserts', () => {
    // `plansService.createPlan` → assertCanEdit → `work_item:edit`;
    // `plansService.addProposals` / `markPlanned` → `ai:view_plan`.
    // `docs/decisions/token-permissions.md` §3, and the ADR's Q2.
    expect(TOOL_PERMISSIONS[CREATE_PLAN_TOOL_NAME]).toBe('work_item:edit');
    expect(TOOL_PERMISSIONS[ADD_PLAN_ITEMS_TOOL_NAME]).toBe('ai:view_plan');
  });

  it('refuses a token missing EITHER key — authoring needs both', () => {
    for (const tool of [CREATE_PLAN_TOOL_NAME, ADD_PLAN_ITEMS_TOOL_NAME] as const) {
      const withoutIt = GRANTABLE_PERMISSIONS.filter((p) => p !== TOOL_PERMISSIONS[tool]);
      expect(permissionDenial(tool, withoutIt), `${tool} should be denied`).not.toBeNull();
      expect(permissionDenial(tool, GRANTABLE_PERMISSIONS)).toBeNull();
    }
  });

  it('is NOT billable — authoring a plan never draws on the generation allowance', () => {
    // Both are database writes. `MCP_BILLABLE_TOOLS` holds exactly the tools that
    // make motir-ai run a model job, and capping plan authoring against the
    // owner's generation budget would be a cost that does not exist.
    expect(isBillableTool(CREATE_PLAN_TOOL_NAME)).toBe(false);
    expect(isBillableTool(ADD_PLAN_ITEMS_TOOL_NAME)).toBe(false);
  });
});
