// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { ProjectDTO } from '@/lib/dto/projects';

// MOTIR-1559 — after switching the active PROJECT, the sidebar switcher must
// LAND the user on the work-items list (`/items`), not do a bare
// `router.refresh()` that leaves a stale, old-project-scoped URL / client
// island in place. This mirrors the org/workspace switchers (MOTIR-1312) via
// the shared `afterContextSwitchTarget(pathname)` contract: push `/items`
// unless already there, in which case refresh in place.

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
let pathnameValue = '/dashboard';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => pathnameValue,
}));

// DB-free unit render: stub the project Server Actions the switcher imports.
const { setActiveProjectAction } = vi.hoisted(() => ({
  setActiveProjectAction: vi.fn(async () => undefined),
}));
vi.mock('@/app/(authed)/_project-actions', () => ({
  createProjectAction: vi.fn(async () => undefined),
  setActiveProjectAction,
  archiveProjectAction: vi.fn(async () => undefined),
  startNewAiProjectAction: vi.fn(async () => undefined),
}));

import { ProjectSwitcher } from '@/app/(authed)/_components/ProjectSwitcher';

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

function renderSwitcher() {
  return renderWithIntl(
    <ToastProvider>
      <ProjectSwitcher projects={[ACME, BETA]} activeProjectId={ACME.id} />
    </ToastProvider>,
  );
}

/** Open the popover and click the row for the named (non-active) project. */
function switchTo(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Switch project' }));
  fireEvent.click(screen.getByText(name));
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

describe('ProjectSwitcher — post-switch landing (MOTIR-1559)', () => {
  it('navigates to /items after switching to a different project (not a bare refresh)', async () => {
    renderSwitcher();
    switchTo('Beta Labs');

    await waitFor(() => expect(setActiveProjectAction).toHaveBeenCalledWith('proj_beta'));
    // The bug was a bare refresh() with NO navigation. The fix pushes to /items
    // (abandoning the stale old-project URL); the action's revalidatePath (not
    // exercised by this mock) is what re-seeds the layout server-side. The
    // regression guard is that a push to /items happens and NOT a bare refresh.
    await waitFor(() => expect(push).toHaveBeenCalledWith('/items'));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes in place (no push) when the switch happens while already on /items', async () => {
    pathnameValue = '/items';
    renderSwitcher();
    switchTo('Beta Labs');

    await waitFor(() => expect(setActiveProjectAction).toHaveBeenCalledWith('proj_beta'));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(push).not.toHaveBeenCalled();
  });

  it('is a no-op when the active project is re-selected (no action, no navigation)', () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: 'Switch project' }));
    // "Acme" also labels the trigger, so pick the copy inside the popover's
    // project list row (the one with an <li> ancestor), not the trigger.
    const activeRow = screen.getAllByText('Acme').find((el) => el.closest('li'));
    fireEvent.click(activeRow!);

    expect(setActiveProjectAction).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
