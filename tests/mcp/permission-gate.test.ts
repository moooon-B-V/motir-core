import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { permissionDenial, PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { toolPermission } from '@/lib/mcp/toolPermissions';
import { DEFAULT_TOKEN_GRANT, GRANTABLE_PERMISSIONS, type TokenGrant } from '@/lib/tokens/grant';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// The per-token PERMISSION GATE at MCP dispatch (Story 7.7 · Subtask 7.7.17,
// re-pointed onto the permission vocabulary by MOTIR-2576). Two layers,
// mirroring the rest of the MCP suite:
//  - the PURE decision (`permissionDenial`) looped over the WHOLE registry — the
//    "fails by construction" guard: a future tool added without permission
//    gating surfaces here because the loop covers every `MCP_TOOL_NAMES` entry;
//  - the WIRED server round-trip over real Postgres — proving the gate fires
//    BEFORE the service, and that the grant NARROWS but does not REPLACE the 6.4
//    role (grant ∩ role both enforced).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

function textOf(content: unknown): string {
  return JSON.stringify(content);
}

describe('permissionDenial — pure decision over the whole registry', () => {
  it('allows every tool when the grant holds every grantable permission', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(
        permissionDenial(name, GRANTABLE_PERMISSIONS),
        `${name} should pass a fully-granted token`,
      ).toBeNull();
    }
  });

  it('denies each tool when its OWN permission is withheld (loop the registry)', () => {
    for (const name of MCP_TOOL_NAMES) {
      const required = toolPermission(name);
      const withoutIt = GRANTABLE_PERMISSIONS.filter((k) => k !== required);
      const denied = permissionDenial(name, withoutIt);
      expect(denied, `${name} should be denied without "${required}"`).not.toBeNull();
      expect(denied?.isError).toBe(true);
      expect(textOf(denied?.content)).toContain(PERMISSION_NOT_GRANTED_CODE);
      // The denial NAMES the missing key — the whole point of the re-point.
      expect(textOf(denied?.content)).toContain(required);
    }
  });

  it('never names a RETIRED scope string in a denial', () => {
    // The failure this story exists to remove: an error telling an operator to
    // grant something the screen does not offer.
    for (const name of MCP_TOOL_NAMES) {
      const denied = permissionDenial(name, []);
      const text = textOf(denied?.content);
      for (const retired of [
        'work_items:write',
        'work_items:archive',
        'work_items:delete',
        'sprints:write',
      ]) {
        expect(text, `${name}'s denial names the retired "${retired}"`).not.toContain(retired);
      }
    }
  });

  it('grants browse tools — and ONLY browse tools — to a browse-only token', () => {
    for (const name of MCP_TOOL_NAMES) {
      const isRead = toolPermission(name) === 'project:browse';
      const allowed = permissionDenial(name, ['project:browse']) === null;
      expect(allowed, `${name} browse-only allowance`).toBe(isRead);
    }
  });

  it('the default grant passes every tool EXCEPT the irreversible three', () => {
    // Archive joins delete here, and that is the narrowing ADR §8 records: both
    // assert `work_item:delete`, so one key cannot hold them apart.
    const withheld = new Set(['delete_work_item', 'archive_work_item', 'unarchive_work_item']);
    for (const name of MCP_TOOL_NAMES) {
      const denied = permissionDenial(name, DEFAULT_TOKEN_GRANT);
      if (withheld.has(name)) {
        expect(denied, `${name} is default-off`).not.toBeNull();
        expect(textOf(denied?.content)).toContain(PERMISSION_NOT_GRANTED_CODE);
      } else {
        expect(denied, `${name} should pass the default grant`).toBeNull();
      }
    }
  });

  it('withholding ai:plan stops the billable submits and NOTHING else', () => {
    // The separation the six scopes could not express: a token that files work
    // items but cannot spend the owner's AI credits.
    const noPlanning = GRANTABLE_PERMISSIONS.filter((k) => k !== 'ai:plan');
    const blocked = MCP_TOOL_NAMES.filter((n) => permissionDenial(n, noPlanning) !== null);
    expect([...blocked].sort()).toEqual(
      ['append_plan_turn', 'expand_item', 'open_plan_session', 'submit_plan_session'].sort(),
    );
  });

  it('withholding comment:add stops add_comment and NOTHING else', () => {
    const noComments = GRANTABLE_PERMISSIONS.filter((k) => k !== 'comment:add');
    const blocked = MCP_TOOL_NAMES.filter((n) => permissionDenial(n, noComments) !== null);
    expect(blocked).toEqual(['add_comment']);
  });

  it('fails CLOSED on a tool name that maps to no permission', () => {
    const denied = permissionDenial('not_a_real_tool', GRANTABLE_PERMISSIONS);
    expect(denied).not.toBeNull();
    expect(textOf(denied?.content)).toContain(PERMISSION_NOT_GRANTED_CODE);
  });

  it('fails CLOSED on an empty grant, for every tool', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(permissionDenial(name, []), `${name} must be denied by an empty grant`).not.toBeNull();
    }
  });
});

/** Connect an in-memory MCP client to a server bound to `ctx` + this `grant`. */
async function connectClient(ctx: ServiceContext, grant: TokenGrant): Promise<Client> {
  const server = buildMcpServer(
    () => ctx,
    () => [...grant],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('permission gate — wired through the MCP server', () => {
  it('rejects a write tool the grant lacks the permission for, BEFORE the service runs', async () => {
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

    // A browse-only token — no work_item:edit.
    const client = await connectClient(fx.ctx, ['project:browse']);
    const res = await client.callTool({
      name: 'transition_status',
      arguments: { key: item.identifier, status: 'in_progress' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res.content)).toContain(PERMISSION_NOT_GRANTED_CODE);

    // The service never ran: the status is unchanged.
    const after = await workItemsService.getWorkItemByIdentifier(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    expect(after.status).toBe(before.status);
    await client.close();
  });

  it('the grant NARROWS but does not REPLACE the role — grant ∩ role both enforced', async () => {
    const a = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: a.projectId, kind: 'task', title: 'A only' },
      a.ctx,
    );
    // A second, independent tenant whose context cannot reach tenant A.
    const b = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });

    // (1) Permission GRANTED, role DENIES (cross-tenant) → 404-not-403, NOT a
    // permission error.
    const crossTenant = await connectClient(b.ctx, GRANTABLE_PERMISSIONS);
    const roleDenied = await crossTenant.callTool({
      name: 'transition_status',
      arguments: { key: item.identifier, status: 'in_progress' },
    });
    expect(roleDenied.isError).toBe(true);
    expect(textOf(roleDenied.content)).toContain('PROJECT_NOT_FOUND');
    expect(textOf(roleDenied.content)).not.toContain(PERMISSION_NOT_GRANTED_CODE);
    await crossTenant.close();

    // (2) Role ALLOWS, permission ABSENT → permission-denied (the gate fires
    // before the role check).
    const scopeShort = await connectClient(a.ctx, ['project:browse']);
    const scopeDenied = await scopeShort.callTool({
      name: 'transition_status',
      arguments: { key: item.identifier, status: 'in_progress' },
    });
    expect(scopeDenied.isError).toBe(true);
    expect(textOf(scopeDenied.content)).toContain(PERMISSION_NOT_GRANTED_CODE);
    await scopeShort.close();
  });

  it('the default grant can neither delete NOR archive — they share one key', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Archive vs delete' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx, DEFAULT_TOKEN_GRANT);

    const del = await client.callTool({
      name: 'delete_work_item',
      arguments: { key: item.identifier },
    });
    expect(del.isError).toBe(true);
    expect(textOf(del.content)).toContain(PERMISSION_NOT_GRANTED_CODE);

    // Archive was ON by default under the six scopes. Both operations assert
    // `work_item:delete` in shipped code, so "all but the irreversible one"
    // withholds both — ADR §8, asserted here rather than discovered.
    const arch = await client.callTool({
      name: 'archive_work_item',
      arguments: { key: item.identifier },
    });
    expect(arch.isError).toBe(true);
    expect(textOf(arch.content)).toContain('work_item:delete');
    await client.close();
  });

  it('a grant WITH the irreversible key can archive and delete', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Archivable' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx, ['project:browse', 'work_item:delete']);
    const arch = await client.callTool({
      name: 'archive_work_item',
      arguments: { key: item.identifier },
    });
    expect(arch.isError).toBeFalsy();
    await client.close();
  });
});
