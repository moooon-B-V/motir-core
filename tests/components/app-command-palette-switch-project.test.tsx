// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { ProjectDTO } from '@/lib/dto/projects';

// MOTIR-1559 — the ⌘K "Switch to <project>" command must LAND the user on the
// work-items list (`/items`) after switching, exactly like the sidebar
// ProjectSwitcher and the palette's own switchWorkspace handler already do
// (MOTIR-1312). Before the fix `switchProject` did a bare `router.refresh()`,
// leaving a stale, old-project-scoped URL / client island in place.

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
let pathnameValue = '/dashboard';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => pathnameValue,
}));

const { setActiveProjectAction, switchWorkspaceAction } = vi.hoisted(() => ({
  setActiveProjectAction: vi.fn(async () => undefined),
  switchWorkspaceAction: vi.fn(async () => undefined),
}));
vi.mock('@/app/(authed)/_project-actions', () => ({ setActiveProjectAction }));
vi.mock('@/app/(authed)/_actions', () => ({ switchWorkspaceAction }));
vi.mock('@/lib/auth/client', () => ({ signOut: vi.fn(async () => undefined) }));

// The palette is a composition over provider context; stub each provider hook
// so the unit render is DB/context-free and the palette mounts open.
vi.mock('@/app/(authed)/_components/CommandPaletteProvider', () => ({
  useCommandPalette: () => ({ open: true, setOpen: vi.fn() }),
}));
vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({ openCreateIssue: vi.fn(), canCreate: false }),
}));
vi.mock('@/app/(authed)/_components/OnboardingResumeProvider', () => ({
  useOnboardingResume: () => false,
}));
vi.mock('@/lib/contexts/theme-context', () => ({
  useTheme: () => ({ pattern: 'light', setPattern: vi.fn() }),
}));

import { AppCommandPalette } from '@/app/(authed)/_components/AppCommandPalette';

function project(over: Partial<ProjectDTO> = {}): ProjectDTO {
  return {
    id: 'proj_acme',
    workspaceId: 'ws_1',
    name: 'Acme',
    identifier: 'ACME',
    avatarIcon: null,
    avatarColor: null,
    archivedAt: null,
    ...over,
  } as unknown as ProjectDTO;
}

const ACME = project({ id: 'proj_acme', name: 'Acme', identifier: 'ACME' });
const BETA = project({ id: 'proj_beta', name: 'Beta Labs', identifier: 'BETA' });

function renderPalette() {
  return renderWithIntl(
    <AppCommandPalette
      workspaces={[]}
      activeWorkspaceId="ws_1"
      projects={[ACME, BETA]}
      activeProjectId={ACME.id}
      hasProject
    />,
  );
}

beforeEach(() => {
  pathnameValue = '/dashboard';
});
afterEach(() => {
  cleanup();
  push.mockClear();
  refresh.mockClear();
  setActiveProjectAction.mockClear();
});

describe('AppCommandPalette — switchProject landing (MOTIR-1559)', () => {
  it('navigates to /items after ⌘K-switching to a different project (not a bare refresh)', async () => {
    renderPalette();
    fireEvent.click(screen.getByRole('option', { name: /Switch to Beta Labs/ }));

    await waitFor(() => expect(setActiveProjectAction).toHaveBeenCalledWith('proj_beta'));
    // Push to /items (abandon the stale old-project URL); the action's
    // revalidatePath (not exercised by this mock) re-seeds the layout
    // server-side. The regression guard is the push to /items, not a bare refresh.
    await waitFor(() => expect(push).toHaveBeenCalledWith('/items'));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes in place (no push) when switching while already on /items', async () => {
    pathnameValue = '/items';
    renderPalette();
    fireEvent.click(screen.getByRole('option', { name: /Switch to Beta Labs/ }));

    await waitFor(() => expect(setActiveProjectAction).toHaveBeenCalledWith('proj_beta'));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(push).not.toHaveBeenCalled();
  });

  it('is a no-op when the active project row is selected (badged Current, no navigation)', () => {
    renderPalette();
    // The active project renders by name with a "Current" badge and no switch.
    fireEvent.click(screen.getByRole('option', { name: /Acme/ }));

    expect(setActiveProjectAction).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
