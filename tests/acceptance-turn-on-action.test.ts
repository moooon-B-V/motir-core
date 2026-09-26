import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { addToProjectAs } from './helpers/workspaceRoleFixtures';

// `turnOnAcceptanceVideoAction` — the acceptance panel's own write, after
// MOTIR-5172 made it PROJECT-scoped. Real Postgres, real service, real permission
// resolution; the session, the active-project resolver and Next's cache are the
// only stubs (a Server Action called directly has no request scope).
//
// ⚠️ THE DEFECT THIS PINS. MOTIR-4925 moved the switch's READ to
// `Project.acceptanceVideoEnabled` and left this action writing the
// ORGANISATION's column, so the press flipped a flag nothing read. The first case
// asserts the PROJECT column moves. It used to also assert the organisation's did
// not; that column was dropped by MOTIR-5195, so an action writing it would now
// fail outright rather than silently.

const session = { current: null as { user: { id: string; email: string } } | null };
const activeCtx = { current: null as { userId: string; workspaceId: string } | null };
const { revalidatePath } = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));
vi.mock('next/cache', () => ({ revalidatePath }));

const { turnOnAcceptanceVideoAction } =
  await import('@/app/(authed)/items/[key]/acceptanceActions');

const PASSWORD = 'turn-on-action-pass-123';

beforeEach(async () => {
  vi.clearAllMocks();
  session.current = null;
  activeCtx.current = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seed(slug: string) {
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
  const ownerCtx = { userId: owner.id, workspaceId: workspace.id };

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
    return u;
  }

  const admin = await projectActor('admin');
  const member = await projectActor('member');
  // Start from OFF on the project — the only state the panel offers Turn on in.
  await adminDb.project.update({
    where: { id: project.id },
    data: { acceptanceVideoEnabled: false },
  });
  return {
    workspaceId: workspace.id,
    projectId: project.id,
    identifier: project.identifier,
    admin,
    member,
  };
}

function actAs(user: { id: string; email: string }, workspaceId: string) {
  session.current = { user: { id: user.id, email: user.email } };
  activeCtx.current = { userId: user.id, workspaceId };
}

async function projectSwitch(projectId: string): Promise<boolean> {
  const row = await adminDb.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { acceptanceVideoEnabled: true },
  });
  return row.acceptanceVideoEnabled;
}

describe('turnOnAcceptanceVideoAction', () => {
  it('a project admin turns the PROJECT switch on', async () => {
    const s = await seed('admin');
    actAs(s.admin, s.workspaceId);

    const res = await turnOnAcceptanceVideoAction({
      projectId: s.projectId,
      itemIdentifier: `${s.identifier}-1`,
    });

    expect(res).toEqual({ ok: true });
    expect(await projectSwitch(s.projectId)).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith(`/items/${s.identifier}-1`);
  });

  it('a project MEMBER is refused in PROJECT terms, and nothing moves or revalidates', async () => {
    const s = await seed('member');
    actAs(s.member, s.workspaceId);

    const res = await turnOnAcceptanceVideoAction({
      projectId: s.projectId,
      itemIdentifier: `${s.identifier}-1`,
    });

    expect(res).toEqual({
      ok: false,
      error: 'Only a project admin can turn on acceptance video.',
    });
    expect(await projectSwitch(s.projectId)).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('a project that does not resolve reads as gone, not as an organisation refusal', async () => {
    const s = await seed('gone');
    actAs(s.admin, s.workspaceId);

    const res = await turnOnAcceptanceVideoAction({
      projectId: 'cm_no_such_project',
      itemIdentifier: `${s.identifier}-1`,
    });

    expect(res).toEqual({ ok: false, error: 'That project no longer exists.' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
