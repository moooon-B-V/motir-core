import { expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from '@/lib/mcp/registry';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture } from '../../fixtures/workItemFixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';

// Shared fixtures for the Story MOTIR-7731 integration suite (MOTIR-8099): an
// organisation in a chosen content language, the three-field read the suite
// asserts on, an MCP caller over the in-memory transport, and an UNRECORDED
// row — what everything written before content languages looks like.

export type FieldLanguages = [string | null, string | null, string | null];

/** A workspace + project whose organisation's content language is `language`. */
export async function orgIn(language: string): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture();
  await setOrgLanguage(fx.workspace.organizationId, language);
  return fx;
}

export async function setOrgLanguage(organizationId: string, language: string): Promise<void> {
  await adminDb.organization.update({
    where: { id: organizationId },
    data: { contentLanguage: language },
  });
}

/** The stored [title, description, explanation] languages, read off the row. */
export async function storedLanguages(workItemId: string): Promise<FieldLanguages> {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } });
  return [row.titleLanguage, row.descriptionLanguage, row.explanationLanguage];
}

/** A work item with text in all three fields and NO language recorded. */
export async function unrecordedItem(fx: WorkItemFixture, title: string) {
  const item = await createTestWorkItem(fx, { kind: 'task', title });
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      descriptionMd: 'An old body',
      explanationMd: 'An old why',
      titleLanguage: null,
      descriptionLanguage: null,
      explanationLanguage: null,
    },
  });
  return item;
}

/** Call one MCP tool as `ctx`, through the real server and its schemas. */
export async function callMcp(
  ctx: ServiceContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'content-language-story', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

/** The structured payload of a call that must have succeeded. */
export function mcpOk<T>(res: CallToolResult): T {
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return res.structuredContent as T;
}
