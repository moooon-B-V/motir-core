import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { workItemsService } from '@/lib/services/workItemsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The PROJECT BINDING at dispatch (MOTIR-2607; ADR Amendment 1 §A.6).
//
// The binding narrows WHERE a token acts; the grant narrows WHAT it may do. It
// is enforced in ONE place — `projectAccessService`'s `resolveInputs`, the
// single point where a project id meets an actor — so both bearer seams inherit
// it and no route has to remember to ask.
//
// The refusal is NOT-FOUND, never a permission denial: "forbidden" would confirm
// the other project exists, turning a deliberately narrowed credential into an
// oracle for enumerating a workspace.

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function textOf(content: unknown): string {
  return JSON.stringify(content);
}

/** A client whose ServiceContext carries `tokenProjectId` — what the MCP auth
 *  gate builds for a project-bound token. */
async function connect(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(
    () => ctx,
    () => [...GRANTABLE_PERMISSIONS],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('a PROJECT-BOUND token at the MCP seam', () => {
  it('reads its OWN project exactly as an unbound token does', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Mine' },
      fx.ctx,
    );
    const client = await connect({ ...fx.ctx, tokenProjectId: fx.projectId });
    const res = await client.callTool({
      name: 'get_work_item',
      arguments: { key: item.identifier },
    });
    // The binding narrows WHERE, not WHAT — asserted, so it cannot quietly
    // become a second grant.
    expect(res.isError).toBeFalsy();
    await client.close();
  });

  it('is NOT-FOUND on another project in the SAME workspace', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const item = await workItemsService.createWorkItem(
      { projectId: other.projectId, kind: 'task', title: 'Theirs' },
      other.ctx,
    );
    // Bound to fx's project, reaching for `other`'s item.
    const client = await connect({ ...other.ctx, tokenProjectId: fx.projectId });
    const res = await client.callTool({
      name: 'get_work_item',
      arguments: { key: item.identifier },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res.content)).toContain('NOT_FOUND');
    // NOT a permission denial — that is what would leak the project's existence.
    expect(textOf(res.content)).not.toContain('PERMISSION_NOT_GRANTED');
    await client.close();
  });

  it('is refused BEFORE the service runs — no write lands', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other2', identifier: 'OTH2' });
    const item = await workItemsService.createWorkItem(
      { projectId: other.projectId, kind: 'task', title: 'Untouched' },
      other.ctx,
    );
    const client = await connect({ ...other.ctx, tokenProjectId: fx.projectId });
    const res = await client.callTool({
      name: 'transition_status',
      arguments: { key: item.identifier, status: 'in_progress' },
    });
    expect(res.isError).toBe(true);
    const after = await workItemsService.getWorkItemByIdentifier(
      other.projectId,
      item.identifier,
      other.ctx,
    );
    expect(after.status).toBe('todo');
    await client.close();
  });

  it('`list_projects` returns exactly its ONE project', async () => {
    const fx = await makeWorkItemFixture();
    await makeWorkItemFixture({ name: 'Other3', identifier: 'OTH3' });
    const client = await connect({ ...fx.ctx, tokenProjectId: fx.projectId });
    const res = await client.callTool({ name: 'list_projects', arguments: {} });
    const listed = (res.structuredContent as { projects?: { key: string }[] })?.projects ?? [];
    expect(listed).toHaveLength(1);
    expect(listed[0]!.key).toBe(fx.projectIdentifier);
    await client.close();
  });
});

describe('an UNBOUND (device) token is unaffected — this is the CLI specification', () => {
  // ⚠️ NOT a compatibility shim to tighten later. A NULL binding is what
  // `motir login` mints, and spanning the projects the holder's roles reach is
  // the whole point of that credential. A change that made NULL refuse
  // everything would break the CLI and would read, from the diff, like tidying.
  it('reaches every project its holder can browse', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Reachable' },
      fx.ctx,
    );
    const client = await connect(fx.ctx);
    const res = await client.callTool({
      name: 'get_work_item',
      arguments: { key: item.identifier },
    });
    expect(res.isError).toBeFalsy();
    await client.close();
  });

  it('`list_projects` enumerates them all', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const res = await client.callTool({ name: 'list_projects', arguments: {} });
    const listed = (res.structuredContent as { projects?: unknown[] })?.projects ?? [];
    expect(listed.length).toBeGreaterThanOrEqual(1);
    await client.close();
  });

  it('the device mint really does produce a NULL binding', async () => {
    // The end the specification hangs off: if `cliDeviceService`'s credential
    // ever acquired a project, every assertion above would still pass and the
    // CLI would still be broken.
    const fx = await makeWorkItemFixture();
    const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'CLI · workbox',
      fixedGrant: CLI_TOKEN_GRANT,
    });
    const verified = await apiTokensService.verify(token);
    expect(verified.projectId).toBeNull();
  });
});
