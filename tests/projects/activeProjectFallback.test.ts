import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-6169 · MOTIR-6548 — the active project is always one the person can
// ENTER. The fallback picks the first enterable project in the switcher's order;
// a reader who can enter none gets NO project (and `ensureDefaultProject` neither
// hands them someone else's nor creates one); a revoked active project is
// replaced on the next resolution; and an EMPTY workspace is still healed with
// its default project, exactly as MOTIR-4870 made it. Real Postgres throughout.

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
    email: `apf-${label}-${seq++}@ex.com`,
    password: 'hunter2hunter2',
    name: label,
  });

/** A workspace with three projects (A, B, C — none seeded by the workspace) and a
 *  plain Member, whose scope and additions each case sets. */
async function build() {
  const manager = await user('manager');
  const { workspace } = await workspacesService.createWorkspace({
    name: `APF ${seq++}`,
    ownerUserId: manager.id,
  });
  const member = await user('member');
  await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
  const projects = [];
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    projects.push(
      await projectsService.createProject({
        workspaceId: workspace.id,
        actorUserId: manager.id,
        name,
      }),
    );
  }
  const ctx = { userId: manager.id, workspaceId: workspace.id };
  const add = (projectKey: string, userId: string) =>
    projectMembersService.addMember({
      key: projectKey,
      actorUserId: manager.id,
      ctx,
      targetUserId: userId,
    });
  const limit = (userId: string) =>
    workspacesService.setMemberAccessScope({
      actorUserId: manager.id,
      workspaceId: workspace.id,
      targetUserId: userId,
      scope: 'limited',
    });
  return { workspaceId: workspace.id, manager, member, projects, add, limit };
}

const pointerOf = async (userId: string, workspaceId: string) =>
  (
    await adminDb.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId, workspaceId } },
    })
  ).activeProjectId;

const projectCount = (workspaceId: string) => adminDb.project.count({ where: { workspaceId } });

describe('the fallback picks a project the person can ENTER', () => {
  it('a Limited Member added only to the LAST project resolves that one — never the first two', async () => {
    const f = await build();
    const gamma = f.projects[2]!;
    await f.add(gamma.identifier, f.member.id);
    await f.limit(f.member.id);

    const active = await projectsService.getActiveProject(f.member.id, f.workspaceId);
    expect(active?.id).toBe(gamma.id);
    // …and the pointer heals to it, through the resolver's one write.
    expect(await pointerOf(f.member.id, f.workspaceId)).toBe(gamma.id);
  });

  it('a Limited Member added to NO project gets no project, and no project is created for them', async () => {
    const f = await build();
    await f.limit(f.member.id);
    const before = await projectCount(f.workspaceId);

    expect(await projectsService.getActiveProject(f.member.id, f.workspaceId)).toBeNull();
    expect(
      await projectsService.ensureDefaultProject({
        workspaceId: f.workspaceId,
        actorUserId: f.member.id,
      }),
    ).toBeNull();
    expect(await projectCount(f.workspaceId)).toBe(before);
    expect(await pointerOf(f.member.id, f.workspaceId)).toBeNull();
  });

  it('ensureDefaultProject answers the first project the CALLER can enter, not the workspace’s first', async () => {
    const f = await build();
    const beta = f.projects[1]!;
    await f.add(beta.identifier, f.member.id);
    await f.limit(f.member.id);

    const ensured = await projectsService.ensureDefaultProject({
      workspaceId: f.workspaceId,
      actorUserId: f.member.id,
    });
    expect(ensured?.id).toBe(beta.id);
    expect(await projectCount(f.workspaceId)).toBe(3);
  });
});

describe('revocation lands on the next request', () => {
  it('a Full Member whose active project goes Members only resolves another project they can enter', async () => {
    const f = await build();
    const [alpha, beta] = f.projects;
    await projectsService.setActiveProject({
      userId: f.member.id,
      workspaceId: f.workspaceId,
      projectId: alpha!.id,
    });
    expect((await projectsService.getActiveProject(f.member.id, f.workspaceId))?.id).toBe(
      alpha!.id,
    );

    await projectMembersService.setAccessMode({
      key: alpha!.identifier,
      mode: 'members',
      actorUserId: f.manager.id,
      ctx: { userId: f.manager.id, workspaceId: f.workspaceId },
    });

    const next = await projectsService.getActiveProject(f.member.id, f.workspaceId);
    expect(next?.id).toBe(beta!.id);
    expect(await pointerOf(f.member.id, f.workspaceId)).toBe(beta!.id);
  });

  it('…and resolves NO project when every project went Members only', async () => {
    const f = await build();
    for (const p of f.projects) {
      await projectMembersService.setAccessMode({
        key: p.identifier,
        mode: 'members',
        actorUserId: f.manager.id,
        ctx: { userId: f.manager.id, workspaceId: f.workspaceId },
      });
    }
    expect(await projectsService.getActiveProject(f.member.id, f.workspaceId)).toBeNull();
    // The Manager, who enters everything, is unaffected.
    expect(await projectsService.getActiveProject(f.manager.id, f.workspaceId)).not.toBeNull();
  });
});

describe('an EMPTY workspace is still healed (MOTIR-4870, unchanged)', () => {
  it('the first visit creates the default project, and resolves to it', async () => {
    const owner = await user('owner');
    const { workspace } = await workspacesService.createWorkspace({
      name: `Empty ${seq++}`,
      ownerUserId: owner.id,
    });
    expect(await projectCount(workspace.id)).toBe(0);

    const active = await projectsService.getActiveProject(owner.id, workspace.id);
    expect(active).not.toBeNull();
    expect(await projectCount(workspace.id)).toBe(1);
  });
});

describe('canOfferCreateProject — the no-project shell’s create door', () => {
  it('withholds it from a Limited Member, and offers it to a Full Member and the Manager', async () => {
    const f = await build();
    expect(await projectsService.canOfferCreateProject(f.member.id, f.workspaceId)).toBe(true);
    expect(await projectsService.canOfferCreateProject(f.manager.id, f.workspaceId)).toBe(true);
    await f.limit(f.member.id);
    expect(await projectsService.canOfferCreateProject(f.member.id, f.workspaceId)).toBe(false);
  });

  it('offers it to an org Admin reaching a workspace they never joined', async () => {
    const f = await build();
    const orgAdmin = await user('orgadmin');
    const organizationId = (
      await adminDb.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })
    ).organizationId;
    await adminDb.organizationMembership.create({
      data: { organizationId, userId: orgAdmin.id, role: 'admin' },
    });
    expect(await projectsService.canOfferCreateProject(orgAdmin.id, f.workspaceId)).toBe(true);
  });
});
