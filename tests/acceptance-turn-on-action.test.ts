import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// `turnOnAcceptanceVideoAction` — the acceptance panel's own write, after
// MOTIR-5172 made it PROJECT-scoped. Real Postgres, real service, real permission
// resolution; the session, the active-project resolver and Next's cache are the
// only stubs (a Server Action called directly has no request scope).
//
// ⚠️ THE DEFECT THIS PINS. MOTIR-4925 moved the switch's READ to
// `Project.acceptanceVideoEnabled` and left this action writing the
// ORGANISATION's column, so the press flipped a flag nothing read. The first case
// therefore asserts BOTH columns: the project's moves, and the organisation's
// does not — a test reading only the project column would pass against an action
// that wrote both.

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
    await projectMembersService.addMember({
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
    organizationId: workspace.organizationId,
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

/** Read by SQL, not the generated client: the organisation column has no
 *  application reader after MOTIR-5172, and a test must not become one. */
async function orgColumn(organizationId: string): Promise<boolean> {
  const rows = await adminDb.$queryRaw<{ acceptance_video_enabled: boolean }[]>`
    SELECT acceptance_video_enabled FROM organization WHERE id = ${organizationId}`;
  return rows[0]!.acceptance_video_enabled;
}

describe('turnOnAcceptanceVideoAction', () => {
  it('a project admin turns the PROJECT switch on — and the organisation column does not move', async () => {
    const s = await seed('admin');
    const orgBefore = await orgColumn(s.organizationId);
    actAs(s.admin, s.workspaceId);

    const res = await turnOnAcceptanceVideoAction({
      projectId: s.projectId,
      itemIdentifier: `${s.identifier}-1`,
    });

    expect(res).toEqual({ ok: true });
    expect(await projectSwitch(s.projectId)).toBe(true);
    expect(await orgColumn(s.organizationId)).toBe(orgBefore);
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
