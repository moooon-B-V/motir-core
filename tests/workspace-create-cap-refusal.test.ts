import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntitlementExceededError } from '@/lib/billing/errors';

// MOTIR-5130 — a workspace-cap refusal is a BUSINESS-RULE answer, not a server
// fault. `entitlementsService.assertWithinWorkspaceCap` throws a typed
// `EntitlementExceededError` carrying the plan's limit AND the `entitlement`
// discriminator `lib/billing/entitlements.ts` describes as "the field on
// `EntitlementExceededError` the UI keys its upgrade" prompt from. Before this
// card `createWorkspaceAction` wrapped its service call in no `try`/`catch`, so
// both were discarded: the throw escaped the Server Action, Next rendered a 500
// on `POST /workbench`, and the user was told Motir had malfunctioned when in
// fact Motir had worked correctly and their plan has a ceiling.
//
// Everything the action touches is stubbed — this is a test of the action's
// ERROR BOUNDARY, not of the cap (that is `entitlementsService.test.ts`) and not
// of the seam (that is `last-active-project-seam.test.ts`, which drives the real
// services against real Postgres). So no database is needed here.

const sessionUser = { id: 'user_5130', email: 'cap@example.com' };
const cookieJar = new Map<string, string>();

const { createWorkspace, ensureDefaultProject, recordLastActiveProjectForWorkspace } = vi.hoisted(
  () => ({
    createWorkspace: vi.fn(),
    ensureDefaultProject: vi.fn(async () => undefined),
    recordLastActiveProjectForWorkspace: vi.fn(async () => undefined),
  }),
);

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(async () => (sessionUser.id ? { user: { ...sessionUser } } : null)),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => void cookieJar.set(name, value),
    delete: (name: string) => void cookieJar.delete(name),
  }),
}));
vi.mock('@/lib/services/workspacesService', () => ({
  workspacesService: { createWorkspace },
}));
vi.mock('@/lib/services/organizationsService', () => ({
  organizationsService: {
    resolveActiveOrganization: vi.fn(async () => ({
      organization: { id: 'org_5130', name: 'Capped', slug: 'capped' },
    })),
  },
}));
vi.mock('@/lib/services/projectsService', () => ({
  projectsService: { ensureDefaultProject, recordLastActiveProjectForWorkspace },
}));

const { createWorkspaceAction } = await import('@/app/(authed)/_actions');
const { WORKSPACE_COOKIE_NAME } = await import('@/lib/workspaces');

beforeEach(() => {
  cookieJar.clear();
  sessionUser.id = 'user_5130';
  createWorkspace.mockReset();
  ensureDefaultProject.mockClear();
  recordLastActiveProjectForWorkspace.mockClear();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('createWorkspaceAction — the §4.4 workspace cap', () => {
  it('RETURNS the refusal instead of throwing, carrying the message and the entitlement key', async () => {
    // The exact throw `assertWithinWorkspaceCap` makes at its ceiling.
    createWorkspace.mockRejectedValue(
      new EntitlementExceededError('workspaces', { limit: 1, usage: 1 }),
    );

    // The defect, stated as the assertion: this call USED to reject, and a
    // rejecting Server Action is a 500 at the transport.
    const result = await createWorkspaceAction('zyx');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable — narrowed above');
    // The message NAMES the plan limit, which is the one thing a 500 could never
    // say (`errors.ts`: "Your plan's workspaces limit has been reached.").
    expect(result.error).toContain('workspaces limit');
    // …and the discriminator survives the boundary, so the upgrade prompt that
    // keys off it (8.1.7/8.1.8) has something to key on. Carrying it is the
    // whole reason the error is typed.
    expect(result.entitlement).toBe('workspaces');
  });

  it('leaves the active-workspace cookie ALONE on a refusal — nothing was created', async () => {
    cookieJar.set(WORKSPACE_COOKIE_NAME, 'ws_existing');
    createWorkspace.mockRejectedValue(
      new EntitlementExceededError('workspaces', { limit: 1, usage: 1 }),
    );

    await createWorkspaceAction('zyx');

    // The refusal is not a switch: the reader stays where they were, and the
    // post-create seeding never runs.
    expect(cookieJar.get(WORKSPACE_COOKIE_NAME)).toBe('ws_existing');
    expect(ensureDefaultProject).not.toHaveBeenCalled();
    expect(recordLastActiveProjectForWorkspace).not.toHaveBeenCalled();
  });

  it('does NOT swallow anything else — a genuine fault still propagates unchanged', async () => {
    // The guard against this becoming a blanket catch. A real fault must still
    // reach the platform's error handler as a 500, because that claim is TRUE
    // for it.
    const boom = new Error('connection terminated unexpectedly');
    createWorkspace.mockRejectedValue(boom);

    await expect(createWorkspaceAction('zyx')).rejects.toBe(boom);
  });

  it('the success path is unchanged — workspace created, cookie set, project seeded', async () => {
    createWorkspace.mockResolvedValue({
      workspace: { id: 'ws_new', name: 'Fresh', slug: 'fresh' },
    });

    const result = await createWorkspaceAction('  Fresh  ');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable — narrowed above');
    expect(result.workspace).toEqual({ id: 'ws_new', name: 'Fresh', slug: 'fresh' });
    // The name is still trimmed on the way in, the org still nests it, the
    // cookie still points at the new workspace, and both post-create seams still
    // fire — the behaviour MOTIR-4870 and 8.8.28 put here.
    expect(createWorkspace).toHaveBeenCalledWith({
      name: 'Fresh',
      ownerUserId: 'user_5130',
      organizationId: 'org_5130',
    });
    expect(cookieJar.get(WORKSPACE_COOKIE_NAME)).toBe('ws_new');
    expect(ensureDefaultProject).toHaveBeenCalledWith({
      workspaceId: 'ws_new',
      actorUserId: 'user_5130',
    });
    expect(recordLastActiveProjectForWorkspace).toHaveBeenCalledWith('user_5130', 'ws_new');
  });

  it('still refuses an unauthenticated caller and an empty name by THROWING', async () => {
    // These two guards are programming/transport errors rather than business
    // rules, so they keep their existing shape — the cap arm is not a licence to
    // convert every refusal into a return value.
    createWorkspace.mockResolvedValue({ workspace: { id: 'ws', name: 'x', slug: 'x' } });
    await expect(createWorkspaceAction('   ')).rejects.toThrow('EMPTY_NAME');

    sessionUser.id = '';
    await expect(createWorkspaceAction('Fresh')).rejects.toThrow('UNAUTHENTICATED');
  });
});
