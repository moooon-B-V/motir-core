import type { ProjectAccessMode } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  PUBLIC_PROJECT_PERMISSIONS,
  ROLE_GATED_PERMISSIONS,
  WORKSPACE_ROLE_PERMISSIONS,
} from '@/lib/permissions/builtinRoles';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// The ONE entry rule, resolved through the database (Story MOTIR-6169 ·
// MOTIR-6543): the access MODE on the project, the SCOPE on the membership,
// whether the person was ADDED, and the Manager rail — read by `getPermissions`,
// the browse gate and the project listing alike.
//
// The contractor case: a Member with a Limited scope, added to project A only,
// beside a Members-only B, an Open-to-the-workspace C and a Public D.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const sorted = (s: Iterable<string>) => [...s].sort();
let seq = 0;

async function user(label: string) {
  const n = seq++;
  return adminDb.user.create({
    data: { email: `pe-${label}-${n}@example.com`, name: `PE ${label}`, emailVerified: true },
  });
}

async function tenant() {
  const n = seq++;
  const org = await adminDb.organization.create({
    data: { name: `Org pe${n}`, slug: `pe-org-${n}` },
  });
  const ws = await adminDb.workspace.create({
    data: { name: `WS pe${n}`, slug: `pe-ws-${n}`, organizationId: org.id },
  });
  const project = (label: string, mode: ProjectAccessMode) =>
    adminDb.project.create({
      data: {
        name: label,
        slug: `pe-${label.toLowerCase()}-${n}`,
        identifier: `PE${label}${n}`,
        workspaceId: ws.id,
        ...projectAccessData(mode),
      },
    });
  const A = await project('A', 'members');
  const B = await project('B', 'members');
  const C = await project('C', 'workspace');
  const D = await project('D', 'public');

  const manager = await user('manager');
  const contractor = await user('contractor');
  const full = await user('full');
  const orgAdmin = await user('orgadmin');
  await adminDb.workspaceMembership.create({
    data: { userId: manager.id, workspaceId: ws.id, role: 'admin', workspaceRole: 'manager' },
  });
  await adminDb.workspaceMembership.create({
    data: {
      userId: contractor.id,
      workspaceId: ws.id,
      role: 'member',
      workspaceRole: 'member',
      accessScope: 'limited',
    },
  });
  await adminDb.workspaceMembership.create({
    data: { userId: full.id, workspaceId: ws.id, role: 'member', workspaceRole: 'member' },
  });
  // An org Admin who is NOT a member of the workspace — composed in as a Manager.
  await adminDb.organizationMembership.create({
    data: { organizationId: org.id, userId: orgAdmin.id, role: 'admin' },
  });
  await adminDb.projectMembership.create({
    data: { workspaceId: ws.id, projectId: A.id, userId: contractor.id, role: 'member' },
  });
  const ctx = (userId: string) => ({ userId, workspaceId: ws.id });
  return { wsId: ws.id, A, B, C, D, manager, contractor, full, orgAdmin, ctx };
}

describe('the Limited contractor, added to A only', () => {
  it('holds exactly the Member set in A', async () => {
    const t = await tenant();
    const held = await projectAccessService.getPermissions(t.A.id, t.ctx(t.contractor.id));
    expect(sorted(held)).toEqual(sorted(WORKSPACE_ROLE_PERMISSIONS.member));
  });

  it('holds nothing in a members or workspace project, and only the public read set in a public one', async () => {
    const t = await tenant();
    for (const p of [t.B, t.C]) {
      const held = await projectAccessService.getPermissions(p.id, t.ctx(t.contractor.id));
      expect(sorted(held), p.identifier).toEqual([]);
    }
    const onPublic = await projectAccessService.getPermissions(t.D.id, t.ctx(t.contractor.id));
    expect(sorted(onPublic)).toEqual(sorted(PUBLIC_PROJECT_PERMISSIONS));
  });

  it('is refused as NOT-FOUND on a non-public project it was not added to', async () => {
    const t = await tenant();
    for (const p of [t.B, t.C]) {
      const err = await projectAccessService
        .assertCanBrowse(p.id, t.ctx(t.contractor.id))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProjectAccessDeniedError);
      expect((err as ProjectAccessDeniedError).kind).toBe('browse');
      // …and the key-addressed door every page and route resolves through turns
      // that into ProjectNotFoundError — the 404, no existence leak.
      await expect(
        projectsService.resolveByKey(p.identifier, t.ctx(t.contractor.id)),
      ).rejects.toBeInstanceOf(ProjectNotFoundError);
    }
  });

  it('lists only A — the public project it was not added to included out', async () => {
    const t = await tenant();
    const listed = await projectsService.listProjects(t.wsId, t.contractor.id);
    expect(listed.map((p) => p.identifier)).toEqual([t.A.identifier]);
  });
});

describe('a Full member, added nowhere', () => {
  it('enters the workspace and public projects with the Member set, and not the members-only ones', async () => {
    const t = await tenant();
    const onC = await projectAccessService.getPermissions(t.C.id, t.ctx(t.full.id));
    expect(sorted(onC)).toEqual(sorted(WORKSPACE_ROLE_PERMISSIONS.member));
    for (const p of [t.A, t.B]) {
      expect(sorted(await projectAccessService.getPermissions(p.id, t.ctx(t.full.id)))).toEqual([]);
    }
    const listed = await projectsService.listProjects(t.wsId, t.full.id);
    expect(sorted(listed.map((p) => p.identifier))).toEqual(
      sorted([t.C.identifier, t.D.identifier]),
    );
  });
});

describe('the Manager rail', () => {
  it('a Manager and an org Admin who is not a workspace member enter every project in every mode', async () => {
    const t = await tenant();
    for (const actor of [t.manager, t.orgAdmin]) {
      for (const p of [t.A, t.B, t.C, t.D]) {
        const held = await projectAccessService.getPermissions(p.id, t.ctx(actor.id));
        for (const key of ROLE_GATED_PERMISSIONS) {
          expect(held.has(key), `${actor.name} in ${p.identifier} lacks ${key}`).toBe(true);
        }
      }
    }
    const listed = await projectsService.listProjects(t.wsId, t.manager.id);
    expect(listed).toHaveLength(4);
  });
});
