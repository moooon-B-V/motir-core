import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { buildMcpServer } from '@/lib/mcp/registry';
import { runSearchWorkItems, SEARCH_WORK_ITEMS_TOOL_NAME } from '@/lib/mcp/tools/searchWorkItems';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { parseAdvancedFilterParam } from '@/lib/issues/issueListAdvancedFilter';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// `search_work_items` (Subtask 7.8.6) over real Postgres. The tool rides the
// SAME 6.1.1 FilterAST envelope + the SAME `getProjectIssuesList` read the
// /items List view uses, so the headline test proves IDENTICAL result sets
// across the two carriers (URL param vs MCP envelope). The rest cover the
// codec/registry error mapping (foreign version, unknown field), the
// parameterized-compiler injection contract, cursor pagination, and the
// 404-not-403 cross-tenant scoping — the 7.8.6 acceptance criteria.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function make(fx: WorkItemFixture, kind: 'task' | 'bug' | 'story', title: string) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind, title }, fx.ctx);
}

/** Connect an in-memory MCP client to a server bound to `ctx`. */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** Build the agent-facing envelope arg from a FilterAst (the expanded form the
 * tool's zod schema accepts — version + combinator + conditions). */
function envelopeArg(ast: FilterAst) {
  return {
    version: 'v1',
    combinator: ast.combinator,
    conditions: ast.conditions.map((c) => ({
      field: c.field,
      operator: c.operator,
      value: c.value,
    })),
  };
}

describe('search_work_items — FilterAST parity with the /items read', () => {
  it('tools/list advertises the search tool with an input schema', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === SEARCH_WORK_ITEMS_TOOL_NAME);
    expect(tool).toBeTruthy();
    expect(tool!.inputSchema).toBeTruthy();
    await client.close();
  });

  it('a v1 AST returns the IDENTICAL result set through the tool and the /items URL carrier', async () => {
    const fx = await makeWorkItemFixture();
    await make(fx, 'task', 'Wire the dispatch');
    await make(fx, 'task', 'Wire the board');
    await make(fx, 'bug', 'Drag drops wrong column');
    await make(fx, 'story', 'Sprint cadence');

    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'kind', operator: 'is_any_of', value: ['task'] }],
    };

    // The /items URL carrier: encode → decode the param exactly as the page
    // boundary does, then run the same read the List view calls.
    const parsed = parseAdvancedFilterParam(encodeFilterParam(ast));
    expect(parsed.state).toBe('active');
    const urlResult = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT, filter: { ast: (parsed as { ast: FilterAst }).ast } },
      fx.ctx,
    );

    // The MCP carrier: the same AST as a tool envelope.
    const toolRes = (
      await runSearchWorkItems({ projectKey: 'PROD', filter: envelopeArg(ast) }, fx.ctx)
    ).structuredContent as { items: { key: number }[]; total: number; nextCursor: string | null };

    expect(toolRes.total).toBe(urlResult.total);
    expect(toolRes.items.map((i) => i.key)).toEqual(urlResult.items.map((i) => i.key));
    // Sanity: it actually filtered (two tasks, not all four items).
    expect(toolRes.total).toBe(2);
    expect(toolRes.nextCursor).toBeNull();
  });

  it('no filter pages the whole project', async () => {
    const fx = await makeWorkItemFixture();
    await make(fx, 'task', 'A');
    await make(fx, 'bug', 'B');
    const res = (await runSearchWorkItems({ projectKey: 'PROD' }, fx.ctx)).structuredContent as {
      items: unknown[];
      total: number;
    };
    expect(res.total).toBe(2);
    expect(res.items).toHaveLength(2);
  });
});

describe('search_work_items — error mapping + the parameterized-compiler contract', () => {
  it('a foreign envelope version returns the codec’s typed error as a tool error', async () => {
    const fx = await makeWorkItemFixture();
    const res = await runSearchWorkItems(
      {
        projectKey: 'PROD',
        filter: { version: 'v2', combinator: 'and', conditions: [] },
      },
      fx.ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('UNSUPPORTED_FILTER_VERSION');
  });

  it('an unknown field returns the registry’s typed validation error as a tool error', async () => {
    const fx = await makeWorkItemFixture();
    // The registry throws (UnknownFilterFieldError) from inside the service; the
    // register wrapper's try/catch maps it, so drive this through the client.
    const client = await connectClient(fx.ctx);
    const res = await client.callTool({
      name: SEARCH_WORK_ITEMS_TOOL_NAME,
      arguments: {
        projectKey: 'PROD',
        filter: {
          version: 'v1',
          combinator: 'and',
          conditions: [{ field: 'nope', operator: 'is_any_of', value: ['x'] }],
        },
      },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('UNKNOWN_FILTER_FIELD');
    await client.close();
  });

  it('an injection probe dies in the parameterized compiler — no crash, no match', async () => {
    const fx = await makeWorkItemFixture();
    await make(fx, 'task', 'Legit item');
    const res = (
      await runSearchWorkItems(
        {
          projectKey: 'PROD',
          filter: {
            version: 'v1',
            combinator: 'and',
            conditions: [
              { field: 'text', operator: 'contains', value: "'; DROP TABLE work_item; --" },
            ],
          },
        },
        fx.ctx,
      )
    ).structuredContent as { items: unknown[]; total: number };
    // The probe binds as a parameter → ILIKE matches nothing; the table is intact.
    expect(res.total).toBe(0);
    expect(res.items).toHaveLength(0);
    const stillThere = (await runSearchWorkItems({ projectKey: 'PROD' }, fx.ctx))
      .structuredContent as { total: number };
    expect(stillThere.total).toBe(1);
  });

  it('an invalid cursor returns a tool error', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const res = await client.callTool({
      name: SEARCH_WORK_ITEMS_TOOL_NAME,
      arguments: { projectKey: 'PROD', cursor: 'not-a-cursor!!' },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('INVALID_SEARCH_CURSOR');
    await client.close();
  });
});

describe('search_work_items — cursor pagination + tenancy', () => {
  it('limit caps the page and nextCursor walks the rest, ending at an empty terminal page', async () => {
    const fx = await makeWorkItemFixture();
    for (const t of ['A', 'B', 'C']) await make(fx, 'task', t);

    const p1 = (await runSearchWorkItems({ projectKey: 'PROD', limit: 2 }, fx.ctx))
      .structuredContent as { items: { key: number }[]; total: number; nextCursor: string | null };
    expect(p1.total).toBe(3);
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();

    const p2 = (
      await runSearchWorkItems({ projectKey: 'PROD', limit: 2, cursor: p1.nextCursor! }, fx.ctx)
    ).structuredContent as { items: { key: number }[]; nextCursor: string | null };
    expect(p2.items).toHaveLength(1);
    expect(p2.items[0]!.key).not.toBe(p1.items[0]!.key);
    // Last page → no further cursor (the past-the-tail case has its own test).
    expect(p2.nextCursor).toBeNull();
  });

  it('a past-the-tail cursor returns an empty page with no error', async () => {
    const fx = await makeWorkItemFixture();
    await make(fx, 'task', 'Only');
    // page 2 of a single-item project → empty.
    const cursor = Buffer.from(JSON.stringify({ page: 2 }), 'utf8').toString('base64url');
    const res = await runSearchWorkItems({ projectKey: 'PROD', cursor }, fx.ctx);
    expect(res.isError).toBeFalsy();
    const body = res.structuredContent as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toHaveLength(0);
    expect(body.nextCursor).toBeNull();
  });

  it('a cross-tenant project key is not-found (404-not-403), no existence leak', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });
    await make(other, 'task', 'Secret');
    // Query OTHER's project through the first tenant's context (the service
    // throws ProjectNotFoundError; the register wrapper maps it).
    const client = await connectClient(fx.ctx);
    const res = await client.callTool({
      name: SEARCH_WORK_ITEMS_TOOL_NAME,
      arguments: { projectKey: 'OTHER' },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('PROJECT_NOT_FOUND');
    await client.close();
  });
});
