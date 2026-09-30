import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { test, expect } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';

// The registry's names, through the LEAF that is keyed by them (a
// `Record<McpToolName, …>`) — the registry itself imports `server-only`.
const TOOL_NAMES = Object.keys(TOOL_PERMISSIONS).sort();

// CLAUDE ASKS BEFORE MOTIR WRITES — the story's E2E
// (Story MOTIR-6974 · Subtask MOTIR-7004).
//
// A real MCP client connects to the RUNNING app over Streamable HTTP with a
// freshly minted token and receives the tool list Claude would receive. Every
// tool is checked against Claude's connector directory criteria, one read-only
// and one destructive call behave as their hints say, and the published
// catalogue is compared with what the server actually served.
//
// ── WHY THIS IS NOT AN `acceptance-*` SPEC ──────────────────────────────────
// The story has no surface Motir draws: the approval prompt the hints drive is
// Claude's own UI. Under the NON-UI exemption the receipt is not a video but the
// recorded `tools/list` and a per-tool report against the criteria, which this
// spec writes to its output directory (`mcp-tools-list.json`,
// `mcp-directory-criteria.md`). So it runs in the main lane, on every PR.
//
// ── WHAT IT DOES NOT PROVE ─────────────────────────────────────────────────
// That every read-only tool writes nothing is the story's integration gate
// (`tests/mcp/tool-hints-integration.test.ts`), which runs each one against the
// database and records the SQL. This spec stays at one read and one destructive
// call, as a client of the deployed server sees them.

const PASSWORD = 'mcp-tool-hints-e2e-pass-123';
const MAX_NAME = 64;
const MAX_TITLE = 64;

interface Seed {
  projectKey: string;
  itemKey: string;
  commentId: string;
  /** The ordinary CLI grant — reads and comment writes. */
  fullToken: string;
  /** Narrowed to `project:browse` alone: may read, may not delete a comment. */
  browseToken: string;
}

async function seed(): Promise<Seed> {
  const owner = await usersService.createUser({
    email: 'mcp-tool-hints@example.com',
    password: PASSWORD,
    name: 'Hint Reviewer',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Tool Hints Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Tool hints',
    identifier: 'HINT',
  });
  const ctx = { userId: owner.id, workspaceId: workspace.id };
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'Read me without asking', parentId: null },
    ctx,
  );
  const comment = await commentsService.addComment(
    item.id,
    { bodyMd: 'A comment the agent will delete.' },
    ctx,
  );
  const full = await apiTokensService.create(owner.id, workspace.id, {
    label: 'mcp-tool-hints-full',
    projectId: project.id,
    permissions: [...CLI_TOKEN_GRANT],
  });
  const browse = await apiTokensService.create(owner.id, workspace.id, {
    label: 'mcp-tool-hints-browse',
    projectId: project.id,
    permissions: ['project:browse'],
  });
  return {
    projectKey: project.identifier,
    itemKey: item.identifier,
    commentId: comment.id,
    fullToken: full.token,
    browseToken: browse.token,
  };
}

async function session(token: string, baseURL: string | undefined): Promise<Client> {
  if (!baseURL) throw new Error('no Playwright baseURL — the MCP transport has nowhere to go');
  const client = new Client({ name: 'mcp-tool-hints-e2e', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/api/mcp', baseURL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

/** Every page of `tools/list` — the SDK follows no cursor on its own. */
async function listAll(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

interface CriteriaRow {
  name: string;
  title: string;
  hints: Tool['annotations'];
  checks: Record<string, boolean>;
}

/** Claude's directory criteria, one verdict per criterion per tool. */
function judge(tool: Tool): CriteriaRow {
  const a = tool.annotations ?? {};
  const isWrite = a.readOnlyHint === false;
  return {
    name: tool.name,
    title: tool.title ?? '',
    hints: tool.annotations,
    checks: {
      'name ≤ 64': tool.name.length <= MAX_NAME,
      'title 1–64':
        typeof tool.title === 'string' &&
        tool.title.trim().length > 0 &&
        tool.title.length <= MAX_TITLE,
      readOnlyHint: typeof a.readOnlyHint === 'boolean',
      'write hints':
        !isWrite ||
        (typeof a.destructiveHint === 'boolean' && typeof a.idempotentHint === 'boolean'),
    },
  };
}

const passed = (row: CriteriaRow) => Object.values(row.checks).every(Boolean);

function criteriaReport(rows: CriteriaRow[]): string {
  const cell = (v: unknown) => (v === undefined ? '—' : String(v));
  const criteria = Object.keys(rows[0]!.checks);
  const lines = [
    '# MCP tools against Claude’s connector directory criteria',
    '',
    `${rows.length} tools listed by \`tools/list\`; ${rows.filter(passed).length} pass every criterion.`,
    '',
    `| Tool | Title | readOnly | destructive | idempotent | openWorld | ${criteria.join(' | ')} | Verdict |`,
    `| --- | --- | --- | --- | --- | --- | ${criteria.map(() => '---').join(' | ')} | --- |`,
    ...rows
      .map((row) =>
        [
          `\`${row.name}\``,
          row.title,
          cell(row.hints?.readOnlyHint),
          cell(row.hints?.destructiveHint),
          cell(row.hints?.idempotentHint),
          cell(row.hints?.openWorldHint),
          ...criteria.map((c) => (row.checks[c] ? 'pass' : 'FAIL')),
          passed(row) ? 'pass' : 'FAIL',
        ].join(' | '),
      )
      .map((line) => `| ${line} |`),
    '',
  ];
  return lines.join('\n');
}

const text = (r: CallToolResult) =>
  r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

interface ItemState {
  updatedAt: string;
  status: unknown;
  commentCount: number;
}

async function readItem(client: Client, key: string): Promise<ItemState> {
  const res = (await client.callTool({
    name: 'get_work_item',
    arguments: { key },
  })) as CallToolResult;
  expect(res.isError, text(res)).toBeFalsy();
  const item = (res.structuredContent as { item: ItemState }).item;
  return { updatedAt: item.updatedAt, status: item.status, commentCount: item.commentCount };
}

test('a real MCP client receives every tool with a title and hints that pass Claude’s criteria', async ({
  request,
  baseURL,
}, testInfo) => {
  await resetDatabase();
  const s = await seed();
  const client = await session(s.fullToken, baseURL);

  let tools: Tool[] = [];
  await test.step('connect and list — every tool against the directory criteria', async () => {
    tools = await listAll(client);
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    const rows = tools.map(judge);

    // The RECEIPT, written before the verdict so a failing run still leaves
    // the evidence of what failed.
    await writeFile(
      testInfo.outputPath('mcp-tools-list.json'),
      `${JSON.stringify({ tools }, null, 2)}\n`,
    );
    await writeFile(testInfo.outputPath('mcp-directory-criteria.md'), criteriaReport(rows));
    await testInfo.attach('mcp-tools-list.json', {
      path: testInfo.outputPath('mcp-tools-list.json'),
      contentType: 'application/json',
    });
    await testInfo.attach('mcp-directory-criteria.md', {
      path: testInfo.outputPath('mcp-directory-criteria.md'),
      contentType: 'text/markdown',
    });

    expect(rows.filter((row) => !passed(row))).toEqual([]);
  });

  await test.step('a read-only tool changes nothing', async () => {
    const hint = tools.find((t) => t.name === 'get_work_item')!.annotations;
    expect(hint?.readOnlyHint).toBe(true);
    const before = await readItem(client, s.itemKey);
    const after = await readItem(client, s.itemKey);
    expect(after).toEqual(before);
    expect(before.commentCount).toBe(1);
  });

  await test.step('a destructive tool does what its hint warns', async () => {
    const hint = tools.find((t) => t.name === 'delete_comment')!.annotations;
    expect(hint).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const first = (await client.callTool({
      name: 'delete_comment',
      arguments: { commentId: s.commentId },
    })) as CallToolResult;
    expect(first.isError, text(first)).toBeFalsy();
    expect((await readItem(client, s.itemKey)).commentCount).toBe(0);

    const again = (await client.callTool({
      name: 'delete_comment',
      arguments: { commentId: s.commentId },
    })) as CallToolResult;
    expect(again.isError).toBe(true);
    expect(text(again)).toContain('COMMENT_NOT_FOUND');
  });

  await test.step('the published catalogue matches the running server', async () => {
    const res = await request.get('/api/docs/mcp-tools.json');
    expect(res.status()).toBe(200);
    const doc = (await res.json()) as {
      toolCount: number;
      groups: { tools: { name: string; title: string; annotations: unknown }[] }[];
    };
    const published = doc.groups.flatMap((group) => group.tools);
    expect(doc.toolCount).toBe(tools.length);
    const served = new Map(
      tools.map((t) => [t.name, { title: t.title, annotations: t.annotations }]),
    );
    expect(published.map((t) => t.name).sort()).toEqual([...served.keys()].sort());
    for (const row of published) {
      expect({ title: row.title, annotations: row.annotations }, row.name).toEqual(
        served.get(row.name),
      );
    }
  });

  await client.close();
});

test('without a token nothing is listed, and a narrowed token sees the hints but cannot delete', async ({
  request,
  baseURL,
}) => {
  await resetDatabase();
  const s = await seed();

  await test.step('no token — the transport’s 401, before any tool is named', async () => {
    const res = await request.post('/api/mcp', {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(res.status()).toBe(401);
    const body = await res.text();
    expect(body).not.toContain('get_work_item');
    expect(body).not.toContain('readOnlyHint');
  });

  const narrow = await session(s.browseToken, baseURL);
  await test.step('project:browse alone still lists every tool with its hints', async () => {
    const tools = await listAll(narrow);
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    expect(tools.map(judge).filter((row) => !passed(row))).toEqual([]);
  });

  await test.step('delete_comment is refused as permission-denied, and the comment stays', async () => {
    const res = (await narrow.callTool({
      name: 'delete_comment',
      arguments: { commentId: s.commentId },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('PERMISSION_NOT_GRANTED');
    expect((await readItem(narrow, s.itemKey)).commentCount).toBe(1);
  });

  await narrow.close();
});
