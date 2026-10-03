import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildMcpServer } from '@/lib/mcp/registry';
import { referencedServer } from '@/lib/mcp/toolReference';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { mcpToolCatalogueDocument } from '@/lib/apiDocs/mcp';
import {
  MCP_TOOL_REFERENCE_PAGE_URL,
  mcpToolDocAnchor,
  mcpToolReferenceSentence,
  withMcpToolReference,
  withoutMcpToolReference,
} from '@/lib/apiDocs/mcpToolReference';

// EVERY TOOL LINKS ITS OWN REFERENCE ENTRY (MOTIR-7391).
//
// Claude's connector directory suggested "Reference the target API docs in the
// description" on six write tools. The registration seam (`toolReference.ts`)
// now ends every description with a link to `/docs/mcp/tools#tool-<name>`. This
// holds each SHIPPED description to two things: the link it ends with names that
// tool's own anchor, and that anchor is one the reference page renders — the
// page draws one entry per tool in the catalogue this app serves
// (`/api/docs/mcp-tools.json`), with `id="tool-<name>"`, and
// `mcpToolDocAnchor` is that rule held on this side.

/** `tools/list` runs no handler and needs no actor, so a stub context is honest. */
const STUB_CONTEXT = { userId: 'gate', workspaceId: 'gate' } as unknown as ServiceContext;

interface ListedTool {
  name: string;
  description?: string;
}

async function listTools(server: McpServer): Promise<ListedTool[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcp-tool-reference-links', version: '0.0.0' });
  await client.connect(clientTransport);
  const listed = await client.listTools();
  await client.close();
  return listed.tools as ListedTool[];
}

/** Every anchor the reference page renders: one per tool in the served catalogue. */
function pageAnchors(): Set<string> {
  return new Set(
    mcpToolCatalogueDocument().groups.flatMap((group) =>
      group.tools.map((tool) => mcpToolDocAnchor(tool.name)),
    ),
  );
}

/** The `#…` anchor of the reference link a description ends with, or `null`. */
function linkedAnchor(description: string): string | null {
  const match = description.match(/Reference: (\S+)$/);
  if (!match?.[1]) return null;
  const url = new URL(match[1]);
  if (`${url.origin}${url.pathname}` !== MCP_TOOL_REFERENCE_PAGE_URL) return null;
  return url.hash.slice(1);
}

/** The predicate, shared by the real assertion and its counterfactual. */
function misLinked(tools: readonly ListedTool[], anchors: ReadonlySet<string>): string[] {
  return tools
    .map((tool) => {
      const anchor = linkedAnchor(tool.description ?? '');
      if (anchor === null) return `${tool.name}: no reference link at the end`;
      if (anchor !== mcpToolDocAnchor(tool.name)) return `${tool.name}: links #${anchor}`;
      if (!anchors.has(anchor)) return `${tool.name}: #${anchor} is not on the page`;
      return null;
    })
    .filter((line): line is string => line !== null);
}

describe('every registered MCP tool links its own reference entry', () => {
  it('ends each shipped description with a link to that tool’s anchor on the page', async () => {
    const tools = await listTools(buildMcpServer(() => STUB_CONTEXT));
    expect(tools.length).toBeGreaterThan(0);

    expect(misLinked(tools, pageAnchors())).toEqual([]);
  });

  it('covers the six tools the connector directory flagged', async () => {
    const tools = await listTools(buildMcpServer(() => STUB_CONTEXT));
    const byName = new Map(tools.map((tool) => [tool.name, tool.description ?? '']));
    for (const name of [
      'add_comment',
      'add_lesson',
      'append_plan_turn',
      'edit_comment',
      'link_pull_request',
      'unlink_pull_request',
    ]) {
      expect(byName.get(name)).toMatch(
        new RegExp(`Reference: https://app\\.motir\\.co/docs/mcp/tools#tool-${name}$`),
      );
    }
  });

  it('keeps each tool’s own words ahead of the link, unchanged', async () => {
    const tools = await listTools(buildMcpServer(() => STUB_CONTEXT));
    for (const tool of tools) {
      const authored = withoutMcpToolReference(tool.name, tool.description ?? '');
      expect(authored, tool.name).not.toBe('');
      expect(authored, tool.name).not.toContain(MCP_TOOL_REFERENCE_PAGE_URL);
    }
  });

  // The guard is proved to FIRE, through the same predicate: a link to another
  // tool's anchor, a missing link, and an anchor the page does not render.
  it('FIRES on a wrong anchor, a missing link and an anchor the page lacks', () => {
    const anchors = new Set([mcpToolDocAnchor('a_tool'), mcpToolDocAnchor('b_tool')]);
    expect(
      misLinked(
        [
          { name: 'a_tool', description: withMcpToolReference('b_tool', 'Does a.') },
          { name: 'b_tool', description: 'Does b.' },
          { name: 'c_tool', description: withMcpToolReference('c_tool', 'Does c.') },
        ],
        anchors,
      ),
    ).toEqual([
      'a_tool: links #tool-b_tool',
      'b_tool: no reference link at the end',
      'c_tool: #tool-c_tool is not on the page',
    ]);
  });
});

describe('the reference seam', () => {
  it('appends the sentence as its own paragraph, and to a tool with no description', async () => {
    const server = referencedServer(new McpServer({ name: 't', version: '0' }));
    server.registerTool('with_text', { description: 'Does a thing.  \n' }, async () => ({
      content: [],
    }));
    server.registerTool('without_text', { inputSchema: { x: z.string() } }, async () => ({
      content: [],
    }));

    const byName = new Map((await listTools(server)).map((tool) => [tool.name, tool.description]));
    expect(byName.get('with_text')).toBe(
      `Does a thing.\n\n${mcpToolReferenceSentence('with_text')}`,
    );
    expect(byName.get('without_text')).toBe(mcpToolReferenceSentence('without_text'));
  });

  it('strips exactly its own sentence and nothing else', () => {
    const shipped = withMcpToolReference('a_tool', 'Does a.');
    expect(withoutMcpToolReference('a_tool', shipped)).toBe('Does a.');
    // Another tool's sentence is not this tool's, so it stays — and moves the pin.
    expect(withoutMcpToolReference('b_tool', shipped)).toBe(shipped);
    expect(withoutMcpToolReference('a_tool', 'Does a.')).toBe('Does a.');
  });
});
