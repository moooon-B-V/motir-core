import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectAutoTranslateSettingsService as service } from '@/lib/services/projectAutoTranslateSettingsService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectSettingChangeRepository } from '@/lib/repositories/projectSettingChangeRepository';
import { NotProjectAdminError, ProjectNotFoundError } from '@/lib/projects/errors';
import { RECENT_CHANGE_LIMIT } from '@/lib/dto/projectAutoTranslateSettings';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// Task MOTIR-8826 — the auto-translate switch's service over the REAL stack: the
// READ takes `project:browse` (a member sees the state), the WRITE takes
// `project:administer`, a flip and its trail row commit together, and a patch
// naming the held value writes nothing. Posture as
// `approval-gate-settings-access.test.ts`: real services, real Postgres.

const PASSWORD = 'auto-translate-settings-pass-123';

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctxFor = (userId: string, workspaceId: string): WorkspaceContext => ({ userId, workspaceId });

interface Seeded {
  projectId: string;
  workspaceId: string;
  admin: WorkspaceContext;
  member: WorkspaceContext;
  /** A workspace member with no role on a PRIVATE project — cannot browse it. */
  outsider: WorkspaceContext;
}

async function seed(slug: string): Promise<Seeded> {
  const user = (email: string, name: string) =>
    usersService.createUser({ email, password: PASSWORD, name });

  const owner = await user(`owner-${slug}@ex.com`, 'Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
  });
  const ownerCtx = ctxFor(owner.id, workspace.id);
  await projectMembersService.setAccessMode({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    mode: 'members',
  });

  async function projectActor(role: 'admin' | 'member') {
    const u = await user(`${role}-${slug}@ex.com`, role);
    await workspacesService.addMember({ userId: u.id, workspaceId: workspace.id });
    await addToProjectAs({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: u.id,
      role,
    });
    return ctxFor(u.id, workspace.id);
  }

  const outsider = await user(`outsider-${slug}@ex.com`, 'Outsider');
  await workspacesService.addMember({ userId: outsider.id, workspaceId: workspace.id });

  return {
    projectId: project.id,
    workspaceId: workspace.id,
    admin: await projectActor('admin'),
    member: await projectActor('member'),
    outsider: ctxFor(outsider.id, workspace.id),
  };
}

const stored = async (projectId: string) =>
  (await adminDb.project.findUniqueOrThrow({ where: { id: projectId } })).autoTranslateWorkContent;
const trailOf = (projectId: string) =>
  adminDb.projectAutoTranslateChange.findMany({
    where: { projectId },
    orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
  });

describe('access: a browser may read it, only an administrator may change it', () => {
  it('a project MEMBER reads the state', async () => {
    const s = await seed('member-read');
    await expect(service.getSettings(s.projectId, s.member)).resolves.toMatchObject({
      autoTranslateWorkContent: false,
      changes: [],
      totalChanges: 0,
    });
  });

  it('a non-browser’s read is ProjectNotFoundError', async () => {
    const s = await seed('outsider-read');
    await expect(service.getSettings(s.projectId, s.outsider)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('a member’s write is NotProjectAdminError, and nothing changes', async () => {
    const s = await seed('member-write');
    await expect(
      service.updateSettings(s.projectId, { autoTranslateWorkContent: true }, s.member),
    ).rejects.toBeInstanceOf(NotProjectAdminError);
    expect(await stored(s.projectId)).toBe(false);
    expect(await trailOf(s.projectId)).toHaveLength(0);
  });

  it('a non-browser’s write is ProjectNotFoundError, and nothing changes', async () => {
    const s = await seed('outsider-write');
    await expect(
      service.updateSettings(s.projectId, { autoTranslateWorkContent: true }, s.outsider),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(await stored(s.projectId)).toBe(false);
  });

  it('another workspace’s project is not reachable by either verb', async () => {
    const a = await seed('ws-a');
    const b = await seed('ws-b');
    await expect(service.getSettings(b.projectId, a.admin)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
    await expect(
      service.updateSettings(b.projectId, { autoTranslateWorkContent: true }, a.admin),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(await stored(b.projectId)).toBe(false);
    expect(await trailOf(b.projectId)).toHaveLength(0);
  });
});

describe('a flip writes the switch and one trail row together', () => {
  it('turning it on records the caller, false → true and an instant inside the call', async () => {
    const s = await seed('on');
    const before = Date.now();
    const result = await service.updateSettings(
      s.projectId,
      { autoTranslateWorkContent: true },
      s.admin,
    );
    const after = Date.now();

    expect(result.autoTranslateWorkContent).toBe(true);
    expect(await stored(s.projectId)).toBe(true);
    const rows = await trailOf(s.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      changedByUserId: s.admin.userId,
      fromEnabled: false,
      toEnabled: true,
      workspaceId: s.workspaceId,
    });
    expect(rows[0]!.changedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(rows[0]!.changedAt.getTime()).toBeLessThanOrEqual(after + 1000);
    expect(result.changes[0]).toMatchObject({
      changedByUserId: s.admin.userId,
      changedByName: 'admin',
      fromEnabled: false,
      toEnabled: true,
    });
    expect(result.totalChanges).toBe(1);
  });

  it('turning it off records true → false as the newest change', async () => {
    const s = await seed('off');
    await service.updateSettings(s.projectId, { autoTranslateWorkContent: true }, s.admin);
    const result = await service.updateSettings(
      s.projectId,
      { autoTranslateWorkContent: false },
      s.admin,
    );

    expect(result.autoTranslateWorkContent).toBe(false);
    expect(await stored(s.projectId)).toBe(false);
    expect(result.changes.map((c) => [c.fromEnabled, c.toEnabled])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it('a failing trail append rolls the switch back', async () => {
    const s = await seed('append-fails');
    vi.spyOn(projectSettingChangeRepository, 'append').mockRejectedValueOnce(new Error('boom'));
    await expect(
      service.updateSettings(s.projectId, { autoTranslateWorkContent: true }, s.admin),
    ).rejects.toThrow('boom');
    expect(await stored(s.projectId)).toBe(false);
    expect(await trailOf(s.projectId)).toHaveLength(0);
  });

  it('a failing column write leaves no trail row', async () => {
    const s = await seed('write-fails');
    vi.spyOn(projectRepository, 'updateAutoTranslateWorkContent').mockRejectedValueOnce(
      new Error('boom'),
    );
    await expect(
      service.updateSettings(s.projectId, { autoTranslateWorkContent: true }, s.admin),
    ).rejects.toThrow('boom');
    expect(await stored(s.projectId)).toBe(false);
    expect(await trailOf(s.projectId)).toHaveLength(0);
  });

  it('writes nothing else: the project’s other switches read back as they were', async () => {
    const s = await seed('nothing-else');
    const pick = (p: Record<string, unknown>) => {
      const { autoTranslateWorkContent: _a, updatedAt: _u, ...rest } = p;
      return rest;
    };
    const before = pick(await adminDb.project.findUniqueOrThrow({ where: { id: s.projectId } }));
    await service.updateSettings(s.projectId, { autoTranslateWorkContent: true }, s.admin);
    await service.updateSettings(s.projectId, { autoTranslateWorkContent: false }, s.admin);
    const after = pick(await adminDb.project.findUniqueOrThrow({ where: { id: s.projectId } }));
    expect(after).toEqual(before);
  });
});

describe('a patch naming the held value is a read', () => {
  it('writes no column and appends no trail row, however often it repeats', async () => {
    const s = await seed('noop');
    const first = await service.updateSettings(
      s.projectId,
      { autoTranslateWorkContent: false },
      s.admin,
    );
    expect(first).toMatchObject({ autoTranslateWorkContent: false, changes: [], totalChanges: 0 });

    await service.updateSettings(s.projectId, { autoTranslateWorkContent: true }, s.admin);
    await service.updateSettings(s.projectId, { autoTranslateWorkContent: true }, s.admin);
    await service.updateSettings(s.projectId, {}, s.admin);
    expect(await trailOf(s.projectId)).toHaveLength(1);
  });

  it('two administrators flipping at once record one change each way, never two of the same', async () => {
    const s = await seed('race');
    await Promise.all([
      service.updateSettings(s.projectId, { autoTranslateWorkContent: true }, s.admin),
      service.updateSettings(s.projectId, { autoTranslateWorkContent: true }, s.admin),
    ]);
    const rows = await trailOf(s.projectId);
    expect(rows).toHaveLength(1);
    expect([rows[0]!.fromEnabled, rows[0]!.toEnabled]).toEqual([false, true]);
  });
});

describe('the read-back', () => {
  it('is bounded and newest first, and totalChanges says when it is capped', async () => {
    const s = await seed('capped');
    const base = Date.now() - 1_000_000;
    await adminDb.projectAutoTranslateChange.createMany({
      data: Array.from({ length: RECENT_CHANGE_LIMIT + 5 }, (_, i) => ({
        workspaceId: s.workspaceId,
        projectId: s.projectId,
        changedByUserId: s.admin.userId,
        fromEnabled: i % 2 === 1,
        toEnabled: i % 2 === 0,
        changedAt: new Date(base + i * 1000),
      })),
    });

    const result = await service.getSettings(s.projectId, s.member);
    expect(result.changes).toHaveLength(RECENT_CHANGE_LIMIT);
    expect(result.totalChanges).toBe(RECENT_CHANGE_LIMIT + 5);
    const times = result.changes.map((c) => Date.parse(c.changedAt));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(times[0]).toBe(base + (RECENT_CHANGE_LIMIT + 4) * 1000);
  });

  it('a change survives its author: the row stays, with its facts and no actor', async () => {
    const s = await seed('author-gone');
    await service.updateSettings(s.projectId, { autoTranslateWorkContent: true }, s.admin);
    await adminDb.user.delete({ where: { id: s.admin.userId } });

    const result = await service.getSettings(s.projectId, s.member);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      changedByUserId: null,
      changedByName: null,
      fromEnabled: false,
      toEnabled: true,
    });
  });

  it('returns the STORED value for an untouched project, not a computed default', async () => {
    const s = await seed('stored');
    await adminDb.project.update({
      where: { id: s.projectId },
      data: { autoTranslateWorkContent: true },
    });
    expect((await service.getSettings(s.projectId, s.member)).autoTranslateWorkContent).toBe(true);
  });
});
