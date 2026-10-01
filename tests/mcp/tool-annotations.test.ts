import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer, MCP_SERVER_INFO, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import {
  annotatedServer,
  MAX_TOOL_TITLE_LENGTH,
  TOOL_ANNOTATIONS,
  ToolAnnotationError,
} from '@/lib/mcp/toolAnnotations';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The HINT table and its registration seam (Story MOTIR-6974 · Subtask MOTIR-7001).
//
// Three layers:
//  - the TABLE — total over `MCP_TOOL_NAMES`, every field explicit, and the
//    verbs that can only be destructive classified that way;
//  - the SEAM — its four refusals, each naming the tool;
//  - `tools/list` from `buildMcpServer` composed AS PRODUCTION COMPOSES IT (a
//    grant resolver and `meterBillableTools = true`), so the hints are proven to
//    survive the permission and rate-limit wrappers, not just the seam alone.
//
// The runtime proof that a read-only row writes nothing is the story's
// integration gate; the per-row evidence here is the comment on each row.

/** A resolver that FAILS if any tool body runs — listing must never reach one. */
const neverResolved = (() => {
  throw new Error('tool body reached — tools/list must not run a handler');
}) as unknown as () => ServiceContext;

const READ_KEYS = ['openWorldHint', 'readOnlyHint'];
const WRITE_KEYS = ['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'];

describe('TOOL_ANNOTATIONS — the table', () => {
  it('has exactly one row per MCP tool name', () => {
    expect(Object.keys(TOOL_ANNOTATIONS).sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it('spells every field on every row, and only the fields its kind allows', () => {
    for (const [name, row] of Object.entries(TOOL_ANNOTATIONS)) {
      const keys = Object.keys(row).sort();
      expect(keys, name).toEqual(row.readOnlyHint ? READ_KEYS : WRITE_KEYS);
      for (const value of Object.values(row)) {
        expect(typeof value, name).toBe('boolean');
      }
    }
  });

  it('classifies every deleting / archiving / unlinking / overwriting / moving verb as a destructive write', () => {
    const prefixes = [
      'delete_',
      'archive_',
      'unarchive_',
      'unlink_',
      'withdraw_',
      'update_',
      'move_',
      'complete_',
      'close_',
    ];
    const destructiveByName = MCP_TOOL_NAMES.filter(
      (name) => name === 'transition_status' || prefixes.some((p) => name.startsWith(p)),
    );
    // A floor, so an empty filter cannot pass vacuously.
    expect(destructiveByName.length).toBeGreaterThanOrEqual(20);
    for (const name of destructiveByName) {
      expect(TOOL_ANNOTATIONS[name], name).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
    }
  });

  it('is a leaf: every import in the module is `import type`', () => {
    const source = readFileSync(path.join(process.cwd(), 'lib/mcp/toolAnnotations.ts'), 'utf8');
    const imports = source.split('\n').filter((line) => /^\s*import\b/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line, line).toMatch(/^import type /);
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toMatch(/\bimport\(/);
  });

  it('carries an evidence comment directly above every row', () => {
    const lines = readFileSync(
      path.join(process.cwd(), 'lib/mcp/toolAnnotations.ts'),
      'utf8',
    ).split('\n');
    for (const name of MCP_TOOL_NAMES) {
      const at = lines.findIndex((line) => line.startsWith(`  ${name}: {`));
      expect(at, name).toBeGreaterThan(0);
      expect(lines[at - 1], name).toMatch(/^ {2}\/\/ [RW]: \S+\.ts → /);
    }
  });
});

describe('annotatedServer — the registration seam', () => {
  const noop = async () => ({ content: [] });
  const shape = { key: z.string() };

  function register(name: string, config: Record<string, unknown>) {
    const server = annotatedServer(new McpServer(MCP_SERVER_INFO));
    return () =>
      server.registerTool(
        name,
        { description: 'x', inputSchema: shape, ...config } as never,
        noop as never,
      );
  }

  it('refuses a name with no row, naming it', () => {
    expect(register('not_a_tool', { title: 'Not a tool' })).toThrow(ToolAnnotationError);
    expect(register('not_a_tool', { title: 'Not a tool' })).toThrow(/"not_a_tool"/);
  });

  it('refuses a prototype key as a name — the table is looked up by own key only', () => {
    expect(register('toString', { title: 'To string' })).toThrow(/"toString".*no row/);
  });

  it('refuses a registration with no config at all, naming the tool', () => {
    const server = annotatedServer(new McpServer(MCP_SERVER_INFO));
    expect(() =>
      (server.registerTool as unknown as (name: string) => void)('get_work_item'),
    ).toThrow(/"get_work_item".*no title/);
  });

  it('passes every other property of the server through unwrapped', () => {
    const inner = new McpServer(MCP_SERVER_INFO);
    expect(annotatedServer(inner).server).toBe(inner.server);
  });

  it('refuses a missing title, naming the tool', () => {
    expect(register('get_work_item', {})).toThrow(/"get_work_item".*no title/);
  });

  it('refuses a blank title, naming the tool', () => {
    expect(register('get_work_item', { title: '   ' })).toThrow(/"get_work_item".*no title/);
  });

  it('refuses a title of 65 characters and accepts one of 64', () => {
    expect(register('get_work_item', { title: 'x'.repeat(MAX_TOOL_TITLE_LENGTH + 1) })).toThrow(
      /"get_work_item".*65 characters/,
    );
    expect(register('get_work_item', { title: 'x'.repeat(MAX_TOOL_TITLE_LENGTH) })).not.toThrow();
  });

  it('refuses a config that already carries annotations, naming the tool', () => {
    expect(
      register('get_work_item', { title: 'Get work item', annotations: { readOnlyHint: true } }),
    ).toThrow(/"get_work_item".*own annotations/);
  });

  it('passes every other config field through untouched', async () => {
    const server = annotatedServer(new McpServer(MCP_SERVER_INFO));
    server.registerTool(
      'delete_work_item',
      { title: 'Delete it', description: 'desc', inputSchema: shape },
      noop,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'delete_work_item',
      title: 'Delete it',
      description: 'desc',
      annotations: { title: 'Delete it', ...TOOL_ANNOTATIONS.delete_work_item },
    });
  });
});

describe('tools/list — composed as production composes it', () => {
  it('serves a guarded title, repeated as `annotations.title`, and exactly the table row on every tool', async () => {
    const server = buildMcpServer(neverResolved, () => [], true);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());

    for (const tool of tools) {
      expect(typeof tool.title, tool.name).toBe('string');
      const title = tool.title as string;
      expect(title.trim().length, tool.name).toBeGreaterThan(0);
      expect(title.length, tool.name).toBeLessThanOrEqual(MAX_TOOL_TITLE_LENGTH);
      // The directory listing reads the name from `annotations.title` (MOTIR-7189),
      // so it is the tool's own title, beside exactly the table's hints.
      expect(tool.annotations, tool.name).toStrictEqual({
        title,
        ...TOOL_ANNOTATIONS[tool.name as keyof typeof TOOL_ANNOTATIONS],
      });
    }
  });
});
