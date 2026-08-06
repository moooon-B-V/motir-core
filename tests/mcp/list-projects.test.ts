import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import {
  LIST_PROJECTS_TOOL_NAME,
  type McpProjectRow,
  toProjectRow,
} from '@/lib/mcp/tools/listProjects';
import { presentMcpProjectRow } from '@/lib/mcp/payloads/planning';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject } from '../fixtures/projectFixtures';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// `list_projects` (MOTIR-1879) over real Postgres — the read that lets a client
// RESOLVE a project instead of demanding its key.
//
// The assertions that matter, in order of what would hurt most if it broke:
//  1. TENANCY — a token bound to workspace A never sees workspace B's projects.
//     The workspace is not an input (it comes from the token-resolved context),
//     so this is structural; the test pins it against a real second tenant.
//  2. The access checks are the UI's — asserted by comparing the tool's rows to
//     `projectsService.listProjects`, the exact read the app shell's project
//     switcher calls, rather than by re-deriving the gate here.
//  3. No N+1 — the repository call count is invariant to the row count.
//
// Built with a FIXED-context resolver over the in-memory transport (the
// tools.test.ts pattern): the bearer plumbing is tested in auth.test.ts and the
// scope narrowing in scope-gate.test.ts, so this file exercises the tool.

const PASSWORD = 'hunter2hunter2';

/** Connect an in-memory MCP client to a server bound to `ctx` (no scope gate). */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'list-projects-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** Call `list_projects` through the transport and return the raw tool result. */
async function callListProjects(ctx: ServiceContext): Promise<CallToolResult> {
  const client = await connectClient(ctx);
  try {
    return (await client.callTool({
      name: LIST_PROJECTS_TOOL_NAME,
      arguments: {},
    })) as CallToolResult;
  } finally {
    await client.close();
  }
}

/** The `projects` array out of a successful result. */
function rowsOf(res: CallToolResult): McpProjectRow[] {
  expect(res.isError).toBeFalsy();
  return (res.structuredContent as { projects: McpProjectRow[] }).projects;
}

async function makeUser(email: string, name = 'User') {
  return usersService.createUser({ email, password: PASSWORD, name });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('list_projects — registration + the token workspace read', () => {
  it('is advertised with an input schema, and is a `read`-scoped tool', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();

    const tool = tools.find((t) => t.name === LIST_PROJECTS_TOOL_NAME);
    expect(tool, 'list_projects is not registered').toBeTruthy();
    expect(tool!.inputSchema).toBeTruthy();
    // Registered under the stable name AND carried in the exported list, so the
    // scope map's totality guard (tests/mcp/scopes.test.ts) covers it.
    expect(MCP_TOOL_NAMES).toContain(LIST_PROJECTS_TOOL_NAME);
    expect(TOOL_SCOPES[LIST_PROJECTS_TOOL_NAME]).toBe('read');
    await client.close();
  });

  it('a workspace with ONE project returns exactly one row carrying key + name', async () => {
    const fx = await makeWorkItemFixture();

    const rows = rowsOf(await callListProjects(fx.ctx));
    expect(rows).toHaveLength(1);
    const [only] = rows;
    expect(only).toEqual({
      key: fx.project.identifier,
      id: fx.project.id,
      name: fx.project.name,
      slug: fx.project.slug,
      accessLevel: fx.project.accessLevel,
      // ADDED by MOTIR-2230: the row now derives from v1's `projectSchema`,
      // which publishes `archived`. `listProjects` filters archived rows out, so
      // a listed project is live by construction — but a client that cannot tell
      // a dead project from a live one is the hazard the v1 field exists for.
      archived: false,
    });
    // `key` is the string the OTHER tools take as `projectKey` — the whole point
    // of the tool is that this value round-trips without translation.
    const client = await connectClient(fx.ctx);
    const ready = await client.callTool({
      name: 'list_ready',
      arguments: { projectKey: only!.key },
    });
    expect(ready.isError).toBeFalsy();
    await client.close();
  });

  it('returns every project in the workspace, and the text block names each one', async () => {
    const fx = await makeWorkItemFixture();
    const second = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Second',
      identifier: 'SEC',
    });

    const res = await callListProjects(fx.ctx);
    const rows = rowsOf(res);
    expect(rows.map((r) => r.key).sort()).toEqual(
      [fx.project.identifier, second.identifier].sort(),
    );

    const text = JSON.stringify(res.content);
    expect(text).toContain(fx.project.identifier);
    expect(text).toContain(second.identifier);
    expect(text).toContain('Second');
  });

  it('a workspace with NO projects returns an empty list, not an error', async () => {
    const { workspace, owner } = await createTestWorkspace({ name: 'Empty Co' });

    const res = await callListProjects({ userId: owner.id, workspaceId: workspace.id });
    expect(res.isError).toBeFalsy();
    expect(rowsOf(res)).toEqual([]);
    expect(JSON.stringify(res.content)).toContain('No projects');
  });
});

describe('list_projects — cross-tenant isolation', () => {
  it('a token bound to workspace A never sees a project in workspace B', async () => {
    const a = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'AAA' });
    const b = await makeWorkItemFixture({ name: 'Tenant B', identifier: 'BBB' });

    // A's context: only A's project, and B's is absent by id AND by key.
    const fromA = rowsOf(await callListProjects(a.ctx));
    expect(fromA.map((r) => r.id)).toEqual([a.project.id]);
    expect(fromA.map((r) => r.key)).not.toContain(b.project.identifier);
    expect(fromA.map((r) => r.id)).not.toContain(b.project.id);

    // Symmetric, so the isolation isn't an artifact of creation order.
    const fromB = rowsOf(await callListProjects(b.ctx));
    expect(fromB.map((r) => r.id)).toEqual([b.project.id]);
    expect(fromB.map((r) => r.key)).not.toContain(a.project.identifier);
  });

  it("A's user asking with B's workspace id is refused — the membership gate, not a listing of B", async () => {
    const a = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'AAA' });
    const b = await makeWorkItemFixture({ name: 'Tenant B', identifier: 'BBB' });

    // A forged/stale binding (A's user + B's workspace) can never enumerate B:
    // the service asserts membership first, so it is a clean NOT_A_MEMBER tool
    // error — never a partial or empty-but-successful read of the other tenant.
    const res = await callListProjects({ userId: a.ownerId, workspaceId: b.workspaceId });
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toContain('NOT_A_MEMBER');
    expect(text).not.toContain(b.project.identifier);
  });
});

describe('list_projects — the access checks are the UI switcher’s', () => {
  it('hides a private project from a plain member and reveals it on project membership', async () => {
    const owner = await makeUser('owner-mcp-lp@ex.com', 'Owner');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Gated Co',
      ownerUserId: owner.id,
    });
    const ownerCtx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };

    const open = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Open Project',
      identifier: 'OPN',
    });
    const secret = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Secret Project',
      identifier: 'SEC',
    });
    await projectMembersService.setAccessLevel({
      key: secret.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level: 'private',
    });

    // A plain workspace member added AFTER the project went private, so they were
    // never auto-seeded onto it.
    const plain = await makeUser('plain-mcp-lp@ex.com', 'Plain');
    await workspacesService.addMember({ userId: plain.id, workspaceId: workspace.id });
    const plainCtx: ServiceContext = { userId: plain.id, workspaceId: workspace.id };

    // The owner browses both; the plain member sees only the open one.
    expect(
      rowsOf(await callListProjects(ownerCtx))
        .map((r) => r.key)
        .sort(),
    ).toEqual([open.identifier, secret.identifier].sort());
    expect(rowsOf(await callListProjects(plainCtx)).map((r) => r.key)).toEqual([open.identifier]);

    // Adding them to the private project reveals it — same gate, no tool logic.
    await projectMembersService.addMember({
      key: secret.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: plain.id,
      role: 'viewer',
    });
    expect(
      rowsOf(await callListProjects(plainCtx))
        .map((r) => r.key)
        .sort(),
    ).toEqual([open.identifier, secret.identifier].sort());
  });

  it('agrees EXACTLY with projectsService.listProjects — the switcher’s own read', async () => {
    // The acceptance criterion is "access checks match the UI's, verified by
    // pointing the test at the same service the project switcher uses". So this
    // asserts EQUALITY with that service's output rather than re-deriving the
    // policy: if the tool ever grew a gate of its own, this fails.
    const owner = await makeUser('owner-parity@ex.com', 'Owner');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Parity Co',
      ownerUserId: owner.id,
    });
    const ownerCtx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };
    for (const [name, identifier] of [
      ['One', 'ONE'],
      ['Two', 'TWO'],
      ['Three', 'THR'],
    ] as const) {
      await projectsService.createProject({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        name,
        identifier,
      });
    }
    await projectMembersService.setAccessLevel({
      key: 'THR',
      actorUserId: owner.id,
      ctx: ownerCtx,
      level: 'private',
    });
    const viewer = await makeUser('viewer-parity@ex.com', 'Viewer');
    await workspacesService.addMember({ userId: viewer.id, workspaceId: workspace.id });

    for (const ctx of [ownerCtx, { userId: viewer.id, workspaceId: workspace.id }]) {
      const viaService = await projectsService.listProjects(ctx.workspaceId, ctx.userId);
      const viaTool = rowsOf(await callListProjects(ctx));
      // Same assertion, one layer over: the tool agrees EXACTLY with the
      // switcher's own read. Compared through the presenter the tool now uses
      // (MOTIR-2230) rather than `toProjectRow`, so the `archived` field the v1
      // schema adds is on both sides of the equality rather than only one.
      expect(viaTool).toEqual(viaService.map(presentMcpProjectRow));
    }
  });
});

describe('list_projects — cost does not grow with the row count (no N+1)', () => {
  it('issues the same, constant repository calls for 1 project and for 5', async () => {
    const owner = await makeUser('owner-n1@ex.com', 'Owner');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Scale Co',
      ownerUserId: owner.id,
    });
    // A PLAIN member, not the owner: a workspace manager short-circuits the
    // browse filter, so only a plain member exercises the per-project
    // membership resolution — the place an N+1 would actually live.
    const member = await makeUser('member-n1@ex.com', 'Member');
    await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
    const memberCtx: ServiceContext = { userId: member.id, workspaceId: workspace.id };

    const identifiers = ['P1', 'P2', 'P3', 'P4', 'P5'];
    await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Project 1',
      identifier: identifiers[0],
    });

    /** Call the tool with the repository edge spied, and report the call counts. */
    async function measure(): Promise<{
      listCalls: number;
      membershipCalls: number;
      batchedIdCounts: number[];
      rows: number;
    }> {
      const listSpy = vi.spyOn(projectRepository, 'findByWorkspace');
      const membershipSpy = vi.spyOn(projectMembershipRepository, 'findByUserAndProjects');
      try {
        const rows = rowsOf(await callListProjects(memberCtx));
        return {
          listCalls: listSpy.mock.calls.length,
          membershipCalls: membershipSpy.mock.calls.length,
          batchedIdCounts: membershipSpy.mock.calls.map((c) => (c[1] as string[]).length),
          rows: rows.length,
        };
      } finally {
        listSpy.mockRestore();
        membershipSpy.mockRestore();
      }
    }

    const one = await measure();
    expect(one.rows).toBe(1);

    for (const [index, identifier] of identifiers.slice(1).entries()) {
      await projectsService.createProject({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        name: `Project ${index + 2}`,
        identifier,
      });
    }

    const five = await measure();
    expect(five.rows).toBe(5);

    // The whole point: five times the rows, the SAME number of queries.
    expect(five.listCalls).toBe(one.listCalls);
    expect(five.membershipCalls).toBe(one.membershipCalls);
    expect(five.listCalls).toBe(1);
    expect(five.membershipCalls).toBe(1);
    // ...and the one membership call is BATCHED over every project id, which is
    // what makes the count constant rather than accidentally so.
    expect(one.batchedIdCounts).toEqual([1]);
    expect(five.batchedIdCounts).toEqual([5]);
  });
});
