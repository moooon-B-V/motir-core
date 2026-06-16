import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { scopeDenial, SCOPE_NOT_GRANTED_CODE } from '@/lib/mcp/scopeGate';
import { DEFAULT_TOKEN_SCOPES, TOKEN_SCOPES, toolScope, type TokenScope } from '@/lib/mcp/scopes';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// The per-token SCOPE GATE at MCP dispatch (Story 7.7 · Subtask 7.7.17). Two
// layers, mirroring the rest of the MCP suite:
//  - the PURE decision (`scopeDenial`) looped over the WHOLE registry — the
//    "fails by construction" guard: a future tool added without scope-gating
//    surfaces here because the loop covers every `MCP_TOOL_NAMES` entry;
//  - the WIRED server round-trip over real Postgres — proving the gate fires
//    BEFORE the service, and that scope NARROWS but does not REPLACE the 6.4
//    role (scope∩role both enforced).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

function textOf(content: unknown): string {
  return JSON.stringify(content);
}

describe('scopeDenial — pure decision over the whole registry', () => {
  it('allows every tool when the token holds all scopes', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(
        scopeDenial(name, [...TOKEN_SCOPES]),
        `${name} should pass an all-scope token`,
      ).toBeNull();
    }
  });

  it('denies each tool when its OWN scope is withheld (loop the registry)', () => {
    for (const name of MCP_TOOL_NAMES) {
      const required = toolScope(name);
      const withoutIt = TOKEN_SCOPES.filter((s) => s !== required);
      const denied = scopeDenial(name, withoutIt);
      expect(denied, `${name} should be denied without "${required}"`).not.toBeNull();
      expect(denied?.isError).toBe(true);
      expect(textOf(denied?.content)).toContain(SCOPE_NOT_GRANTED_CODE);
      expect(textOf(denied?.content)).toContain(required);
    }
  });

  it('grants read tools — and ONLY read tools — to a read-only token', () => {
    for (const name of MCP_TOOL_NAMES) {
      const isRead = toolScope(name) === 'read';
      const allowed = scopeDenial(name, ['read']) === null;
      expect(allowed, `${name} read-only allowance`).toBe(isRead);
    }
  });

  it('the default token (all-minus-delete) passes every tool EXCEPT delete_work_item', () => {
    for (const name of MCP_TOOL_NAMES) {
      const denied = scopeDenial(name, DEFAULT_TOKEN_SCOPES);
      if (name === 'delete_work_item') {
        expect(denied, 'delete is the only default-off tool').not.toBeNull();
        expect(textOf(denied?.content)).toContain(SCOPE_NOT_GRANTED_CODE);
      } else {
        expect(denied, `${name} should pass the default token`).toBeNull();
      }
    }
  });

  it('fails CLOSED on a tool name that maps to no scope', () => {
    const denied = scopeDenial('not_a_real_tool', [...TOKEN_SCOPES]);
    expect(denied).not.toBeNull();
    expect(textOf(denied?.content)).toContain(SCOPE_NOT_GRANTED_CODE);
  });
});

/** Connect an in-memory MCP client to a server bound to `ctx` + granted `scopes`. */
async function connectClient(ctx: ServiceContext, scopes: TokenScope[]): Promise<Client> {
  const server = buildMcpServer(
    () => ctx,
    () => scopes,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('scope gate — wired through the MCP server', () => {
  it('rejects a write tool the token lacks the scope for, BEFORE the service runs', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Guard me' },
      fx.ctx,
    );
    const before = await workItemsService.getWorkItemByIdentifier(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );

    // A read-only token — no work_items:write.
    const client = await connectClient(fx.ctx, ['read']);
    const res = await client.callTool({
      name: 'transition_status',
      arguments: { key: item.identifier, status: 'in_progress' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res.content)).toContain(SCOPE_NOT_GRANTED_CODE);

    // The service never ran: the status is unchanged.
    const after = await workItemsService.getWorkItemByIdentifier(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    expect(after.status).toBe(before.status);
    await client.close();
  });

  it('scope NARROWS but does not REPLACE the role — scope∩role both enforced', async () => {
    const a = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: a.projectId, kind: 'task', title: 'A only' },
      a.ctx,
    );
    // A second, independent tenant whose context cannot reach tenant A.
    const b = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });

    // (1) Scope GRANTED, role DENIES (cross-tenant) → 404-not-403, NOT a scope error.
    const crossTenant = await connectClient(b.ctx, [...TOKEN_SCOPES]);
    const roleDenied = await crossTenant.callTool({
      name: 'transition_status',
      arguments: { key: item.identifier, status: 'in_progress' },
    });
    expect(roleDenied.isError).toBe(true);
    expect(textOf(roleDenied.content)).toContain('PROJECT_NOT_FOUND');
    expect(textOf(roleDenied.content)).not.toContain(SCOPE_NOT_GRANTED_CODE);
    await crossTenant.close();

    // (2) Role ALLOWS, scope ABSENT → scope-denied (the gate fires before the role check).
    const scopeShort = await connectClient(a.ctx, ['read']);
    const scopeDenied = await scopeShort.callTool({
      name: 'transition_status',
      arguments: { key: item.identifier, status: 'in_progress' },
    });
    expect(scopeDenied.isError).toBe(true);
    expect(textOf(scopeDenied.content)).toContain(SCOPE_NOT_GRANTED_CODE);
    await scopeShort.close();
  });

  it('the default token can archive but NOT delete (the one default-off tool)', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Archive vs delete' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx, DEFAULT_TOKEN_SCOPES);

    const del = await client.callTool({
      name: 'delete_work_item',
      arguments: { key: item.identifier },
    });
    expect(del.isError).toBe(true);
    expect(textOf(del.content)).toContain(SCOPE_NOT_GRANTED_CODE);

    const arch = await client.callTool({
      name: 'archive_work_item',
      arguments: { key: item.identifier },
    });
    expect(arch.isError).toBeFalsy();
    await client.close();
  });
});
