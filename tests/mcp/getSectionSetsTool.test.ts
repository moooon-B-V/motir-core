import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '@/lib/mcp/registry';
import { GET_SECTION_SETS_TOOL_NAME, runGetSectionSets } from '@/lib/mcp/tools/getSectionSets';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { sectionSchemaService } from '@/lib/services/sectionSchemaService';
import { presentSectionSets } from '@/lib/api/v1/sectionSets/schema';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// `get_section_sets` (MOTIR-9029): no database, no project — the sets are a product
// contract, so the tool is exercised through the registry's in-memory transport.

const STUB_CONTEXT = { userId: 'gate', workspaceId: 'gate' } as unknown as ServiceContext;

async function connect(): Promise<Client> {
  const server = buildMcpServer(() => STUB_CONTEXT);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'section-sets', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}
function text(result: unknown): string {
  return (result as { content: { text: string }[] }).content.map((c) => c.text).join('\n');
}

describe('get_section_sets', () => {
  it('is listed read-only with no projectKey', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === GET_SECTION_SETS_TOOL_NAME,
    );
    await client.close();
    expect(tool).toBeDefined();
    expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual(['kind', 'type']);
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect(TOOL_PERMISSIONS.get_section_sets).toBe('project:browse');
  });

  it('structuredContent equals the service output for a cell', async () => {
    const client = await connect();
    const res = await client.callTool({
      name: GET_SECTION_SETS_TOOL_NAME,
      arguments: { kind: 'task', type: 'code' },
    });
    await client.close();
    expect(res.isError).toBeFalsy();
    expect(structured(res)).toEqual(
      presentSectionSets(sectionSchemaService.describe({ kind: 'task', type: 'code' })),
    );
    const body = text(res);
    for (const required of ['framing', 'scopeBoundary', 'acceptanceCriteria', 'contextRefs']) {
      expect(body).toContain(required);
    }
    expect(body).toMatch(/required: framing, scopeBoundary, acceptanceCriteria, contextRefs;/);
  });

  it('answers the whole registry with no arguments', () => {
    const res = runGetSectionSets({});
    expect(res.isError).toBeFalsy();
    expect(structured(res)).toEqual(presentSectionSets(sectionSchemaService.describe()));
  });

  it('refuses an unknown kind by name and never returns a default set', () => {
    const res = runGetSectionSets({ kind: 'nope' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('UNKNOWN_SECTION_CELL');
    expect(text(res)).toContain("'nope'");
    expect(res.structuredContent).toBeUndefined();
  });
});
