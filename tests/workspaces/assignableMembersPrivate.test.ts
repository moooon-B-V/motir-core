import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The assignee pickers on a PRIVATE project (Story 6.4.6) offer the project's
// members only — and since Story MOTIR-6168 · MOTIR-6463 each row carries the
// person's WORKSPACE role, their role in every project, not a project role.

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
    email: `amp-${label}-${seq++}@ex.com`,
    password: 'hunter2hunter2',
    name: label,
  });

describe('assignableMembersService.list — a private project', () => {
  it("lists only the project's members, each with their workspace role", async () => {
    const manager = await user('manager');
    const { workspace } = await workspacesService.createWorkspace({
      name: `AMP ${seq++}`,
      ownerUserId: manager.id,
    });
    const ctx = { userId: manager.id, workspaceId: workspace.id };
    const viewer = await user('viewer');
    const outsider = await user('outsider');
    await workspacesService.addMember({
      userId: viewer.id,
      workspaceId: workspace.id,
      role: 'viewer',
    });
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: manager.id,
      name: 'Vault',
    });
    await projectMembersService.setAccessLevel({
      key: project.identifier,
      actorUserId: manager.id,
      ctx,
      level: 'private',
    });
    // Joins the workspace AFTER the project went private, so is not on it.
    await workspacesService.addMember({ userId: outsider.id, workspaceId: workspace.id });

    const rows = await assignableMembersService.list({
      projectId: project.id,
      accessLevel: 'private',
      ctx,
    });
    const byId = new Map(rows.map((r) => [r.userId, r]));
    expect(byId.has(outsider.id)).toBe(false);
    expect(byId.get(viewer.id)).toMatchObject({ workspaceRole: 'viewer', customRole: null });
  });
});
