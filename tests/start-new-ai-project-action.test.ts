import { afterEach, describe, expect, it, vi } from 'vitest';

// Unit test for the "Plan a new project with AI" server action
// (startNewAiProjectAction, MOTIR-1486). It must mint a FRESH draft project
// with the provisional name, pin it active, and redirect to /onboarding — so
// the AI door always plans a NEW project, never the currently-active one.

const { getSession } = vi.hoisted(() => ({
  getSession: vi.fn(async (): Promise<{ user: { id: string } } | null> => ({ user: { id: 'u1' } })),
}));
const { getWorkspaceContext } = vi.hoisted(() => ({
  getWorkspaceContext: vi.fn(async () => ({ workspaceId: 'ws1' })),
}));
const { createProject, setActiveProject } = vi.hoisted(() => ({
  createProject: vi.fn(async (_input: Record<string, unknown>) => ({ id: 'p_new' })),
  setActiveProject: vi.fn(async (_input: Record<string, unknown>) => undefined),
}));
const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));

vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/workspaces', () => ({ getWorkspaceContext }));
vi.mock('@/lib/services/projectsService', () => ({
  projectsService: { createProject, setActiveProject },
}));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(
    async () => (key: string) => (key === 'project.untitled' ? 'Untitled project' : key),
  ),
}));

import { startNewAiProjectAction } from '@/app/(authed)/_project-actions';

afterEach(() => {
  vi.clearAllMocks();
});

describe('startNewAiProjectAction', () => {
  it('creates a provisional-named draft project, pins it active, and redirects to /onboarding', async () => {
    await startNewAiProjectAction();

    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws1',
        actorUserId: 'u1',
        name: 'Untitled project',
      }),
    );
    // No identifier passed → the service auto-derives a workspace-unique one.
    expect(createProject.mock.calls[0]?.[0]).not.toHaveProperty('identifier');

    // The NEW project is pinned active (so /onboarding scopes discovery to it,
    // not to whatever project was active before).
    expect(setActiveProject).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', workspaceId: 'ws1', projectId: 'p_new' }),
    );

    // Hands off to the shipped onboarding fork.
    expect(redirect).toHaveBeenCalledWith('/onboarding');
  });

  it('throws before creating anything when unauthenticated', async () => {
    getSession.mockResolvedValueOnce(null);
    await expect(startNewAiProjectAction()).rejects.toThrow('UNAUTHENTICATED');
    expect(createProject).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});
