import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workspaceRoleDefinitionService } from '@/lib/services/workspaceRoleDefinitionService';
import { NotAMemberError } from '@/lib/workspaces/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { setWorkspaceRoleFor } from '../helpers/workspaceRoleFixtures';

// What the workspace Roles pages read (Story MOTIR-6168 · MOTIR-6466), against
// real Postgres: the built-ins then the custom roles by name, each with its
// WORKSPACE holder count, and whether the reader may author — every member
// reads, only a Manager authors, and someone outside is not-found.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
const user = (label: string) =>
  usersService.createUser({
    email: `rpc-${label}-${seq++}@ex.com`,
    password: 'hunter2hunter2',
    name: label,
  });

async function build() {
  const manager = await user('manager');
  const { workspace } = await workspacesService.createWorkspace({
    name: `RPC ${seq++}`,
    ownerUserId: manager.id,
  });
  const member = await user('member');
  await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
  const viewer = await user('viewer');
  await workspacesService.addMember({
    userId: viewer.id,
    workspaceId: workspace.id,
    role: 'viewer',
  });
  const contractor = await user('contractor');
  await workspacesService.addMember({ userId: contractor.id, workspaceId: workspace.id });
  const zebra = await adminDb.workspaceRoleDefinition.create({
    data: { workspaceId: workspace.id, name: 'Zebra', permissions: ['project:browse'] },
  });
  const alpha = await adminDb.workspaceRoleDefinition.create({
    data: {
      workspaceId: workspace.id,
      name: 'Alpha',
      permissions: ['project:browse', 'comment:add'],
    },
  });
  await setWorkspaceRoleFor(contractor.id, workspace.id, alpha.id);
  return { workspace, manager, member, viewer, zebra, alpha };
}

const ctx = (userId: string, workspaceId: string) => ({ userId, workspaceId });

describe('getRolesPageCatalog', () => {
  it('lists Manager · Member · Viewer, then custom roles by name, with workspace holder counts', async () => {
    const fx = await build();
    const { catalog, canManage } = await workspaceRoleDefinitionService.getRolesPageCatalog(
      fx.workspace.id,
      ctx(fx.manager.id, fx.workspace.id),
    );
    expect(canManage).toBe(true);
    expect(catalog.roles.map((r) => r.name ?? r.key)).toEqual([
      'manager',
      'member',
      'viewer',
      'Alpha',
      'Zebra',
    ]);
    const count = (key: string) => catalog.roles.find((r) => r.key === key)?.memberCount;
    expect(count('manager')).toBe(1);
    expect(count('member')).toBe(1);
    expect(count('viewer')).toBe(1);
    expect(count(fx.alpha.id)).toBe(1);
    expect(count(fx.zebra.id)).toBe(0);
    expect(catalog.roles.find((r) => r.key === fx.alpha.id)?.permissions).toEqual([
      'project:browse',
      'comment:add',
    ]);
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
  });

  it('a Member and a Viewer read the same catalog, and may not author', async () => {
    const fx = await build();
    for (const reader of [fx.member, fx.viewer]) {
      const page = await workspaceRoleDefinitionService.getRolesPageCatalog(
        fx.workspace.id,
        ctx(reader.id, fx.workspace.id),
      );
      expect(page.canManage).toBe(false);
      expect(page.catalog.roles).toHaveLength(5);
    }
  });

  it('someone outside the workspace is not-found', async () => {
    const fx = await build();
    const stranger = await user('stranger');
    await expect(
      workspaceRoleDefinitionService.getRolesPageCatalog(
        fx.workspace.id,
        ctx(stranger.id, fx.workspace.id),
      ),
    ).rejects.toBeInstanceOf(NotAMemberError);
  });
});
