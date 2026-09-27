import { afterEach, describe, expect, it, vi } from 'vitest';
import { findFirst, renderTree, textOf } from '../../helpers/serverPageHarness';

// Story MOTIR-6169 · MOTIR-6548 — the no-project landing (`/no-project`) and the
// shell it renders (`design/shell/no-project--limited.mock.html` S1 / S3). The
// page sends a reader who DOES resolve a project on to the signed-in landing, and
// otherwise renders the shell with the workspace's name and the create door only
// for someone `canOfferCreateProject` allows. Only the session and the service
// reads are stubbed; the page and the shell are the real modules.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { getWorkspaceContext } = vi.hoisted(() => ({ getWorkspaceContext: vi.fn() }));
const { getActiveProject } = vi.hoisted(() => ({ getActiveProject: vi.fn() }));
const { canOfferCreateProject } = vi.hoisted(() => ({ canOfferCreateProject: vi.fn() }));
const { getWorkspaceSummary } = vi.hoisted(() => ({ getWorkspaceSummary: vi.fn() }));
const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('next/navigation', async () => ({
  ...(await import('../../helpers/serverPageHarness')).navigationHooks(),
  redirect,
}));
vi.mock('next-intl/server', async () => ({
  getTranslations: (await import('../../helpers/serverPageHarness')).serverTranslations,
}));
vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/workspaces', () => ({ getWorkspaceContext }));
vi.mock('@/lib/projects', () => ({ getActiveProject }));
vi.mock('@/lib/services/projectsService', () => ({
  projectsService: { canOfferCreateProject },
}));
vi.mock('@/lib/services/workspacesService', () => ({
  workspacesService: { getWorkspaceSummary },
}));

import NoProjectPage from '@/app/(authed)/no-project/page';
import { NoProjectShell } from '@/app/(authed)/_components/NoProjectShell';
import { NoProjectCreateButton } from '@/app/(authed)/_components/NoProjectCreateButton';
import { EmptyState } from '@/components/ui/EmptyState';

afterEach(() => {
  vi.clearAllMocks();
});

function signedIn() {
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  getWorkspaceContext.mockResolvedValue({ userId: 'u1', workspaceId: 'ws1' });
  getWorkspaceSummary.mockResolvedValue({ id: 'ws1', name: 'moooon' });
}

describe('/no-project', () => {
  it('renders the shell for a reader with no project, naming the workspace', async () => {
    signedIn();
    getActiveProject.mockResolvedValue(null);
    canOfferCreateProject.mockResolvedValue(false);

    const shell = findFirst(await renderTree(NoProjectPage), NoProjectShell);
    expect(shell?.props).toEqual({ workspaceName: 'moooon', canCreateProject: false });
    expect(canOfferCreateProject).toHaveBeenCalledWith('u1', 'ws1');
  });

  it('sends a reader who DOES resolve a project on to the signed-in landing', async () => {
    signedIn();
    getActiveProject.mockResolvedValue({ projectId: 'p1' });
    await expect(renderTree(NoProjectPage)).rejects.toThrow('REDIRECT:/workbench');
  });

  it('sends a signed-out request to sign-in', async () => {
    getSession.mockResolvedValue(null);
    await expect(renderTree(NoProjectPage)).rejects.toThrow('REDIRECT:/sign-in');
  });
});

describe('NoProjectShell', () => {
  it('says who can let them in, and offers NO create door to someone who may not create', async () => {
    const tree = await NoProjectShell({ workspaceName: 'moooon', canCreateProject: false });
    const empty = findFirst(tree, EmptyState)!;
    expect(empty.props['title']).toBe('title');
    expect(empty.props['action']).toBeUndefined();
    expect(textOf(tree)).not.toContain('create');
  });

  it('offers the primary "Create a project" to someone who may', async () => {
    const tree = await NoProjectShell({ workspaceName: 'moooon', canCreateProject: true });
    const empty = findFirst(tree, EmptyState)!;
    const action = empty.props['action'] as React.ReactElement<{ label: string }>;
    expect(action.type).toBe(NoProjectCreateButton);
    expect(action.props.label).toBe('create');
  });
});
