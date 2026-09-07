// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ProjectDTO } from '@/lib/dto/projects';
import { renderWithIntl } from '../helpers/renderWithIntl';

// Story MOTIR-1215 · Subtask MOTIR-3647 — the two DOORS onto the workspace
// Security pane, and the one condition both share.
//
// ⚠️ BOTH ARE GATED ON THE TIER REVEAL, AND THE ROWS BESIDE THEM ARE NOT.
// `/settings/workspace/jobs`, `/github` and `/gitlab` must keep rendering at
// every count — they are workspace-SCOPED but not workspace-NAMED, and §6
// reveals a tier rather than relocating every page beneath it. This pane IS
// workspace-named and `notFound()`s below the threshold, so a door to it there
// would be a promise the product then refuses (`SidebarNav`'s own standing
// rule). Below the threshold the control is reached through the org-settings
// fold-in instead — so nothing is lost, only re-homed.

let pathname = '/dashboard';
const { navSearchParams } = vi.hoisted(() => ({ navSearchParams: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  // MOTIR-4730 — the planning door in this tree reads the address, so a
  // partial navigation mock is a crash rather than a gap.
  useSearchParams: () => navSearchParams,
}));
vi.mock('@/lib/auth/client', () => ({ signOut: vi.fn(async () => undefined) }));
vi.mock('@/app/(authed)/_project-actions', () => ({ setActiveProjectAction: vi.fn() }));
vi.mock('@/app/(authed)/_actions', () => ({ switchWorkspaceAction: vi.fn() }));
// The palette composes over provider context; stub each hook so the unit render
// is context-free and it mounts open (the shape every palette test here uses).
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

import { SidebarNav } from '@/app/(authed)/_components/SidebarNav';
import { AppCommandPalette } from '@/app/(authed)/_components/AppCommandPalette';

const PROJECT = {
  id: 'p1',
  key: 'MOTIR',
  identifier: 'MOTIR',
  name: 'Motir',
  archivedAt: null,
} as unknown as ProjectDTO;

const USER = { name: 'Yue', email: 'yue@example.com' };
const HREF = '/settings/workspace/security';

afterEach(cleanup);

function renderRail(workspaceTierRevealed: boolean) {
  return renderWithIntl(
    <SidebarNav
      activeProject={PROJECT}
      settingsPermissions={[]}
      user={USER}
      workspaceTierRevealed={workspaceTierRevealed}
    />,
  );
}

describe('the settings rail', () => {
  it('renders a Security row when the workspace tier is REVEALED', () => {
    const { container } = renderRail(true);
    expect(container.innerHTML).toContain(`href="${HREF}"`);
  });

  it('renders NO Security row below the threshold — a door to a 404 is worse than none', () => {
    const { container } = renderRail(false);
    expect(container.innerHTML).not.toContain(HREF);
  });

  it('the rows BESIDE it are unaffected at either count', () => {
    // The whole point of the gate being on this row and not on its neighbours.
    for (const revealed of [true, false]) {
      cleanup();
      const { container } = renderRail(revealed);
      expect(container.innerHTML, `revealed=${revealed}`).toContain(
        'href="/settings/workspace/jobs"',
      );
      // Git moved to the ORGANISATION tier (MOTIR-4680) — a different change
      // from this file's §6 fold, and the row is still here at both counts,
      // which is what this case is about.
      expect(container.innerHTML, `revealed=${revealed}`).toContain(
        'href="/settings/organization/git"',
      );
    }
  });

  it('the Settings row does not read as current while Security is the active route', () => {
    // Only one row may read current; the parent door stands down for each of its
    // more-specific sub-routes, and Security joins that list.
    pathname = HREF;
    const { container } = renderRail(true);
    const current = [...container.querySelectorAll('[aria-current="page"]')].map((el) =>
      el.getAttribute('href'),
    );
    expect(current).toEqual([HREF]);
    pathname = '/dashboard';
  });
});

describe('the ⌘K palette', () => {
  function renderPalette(workspaceCount: number) {
    return renderWithIntl(
      <AppCommandPalette
        workspaces={Array.from({ length: workspaceCount }, (_, i) => ({
          id: `ws${i}`,
          name: `Workspace ${i}`,
          slug: `ws${i}`,
          organizationId: 'org_acme',
        }))}
        activeWorkspaceId="ws0"
        projects={[PROJECT]}
        activeProjectId={PROJECT.id}
        hasProject={false}
      />,
    );
  }

  it('offers the ORG security pane at every count — an organization always exists', () => {
    for (const count of [1, 2]) {
      cleanup();
      renderPalette(count);
      expect(
        screen.getByRole('option', { name: /go to organization security/i }),
        `count=${count}`,
      ).toBeTruthy();
    }
  });

  it('offers the WORKSPACE pane only once the tier is revealed', () => {
    renderPalette(2);
    expect(screen.getByRole('option', { name: /go to workspace security/i })).toBeTruthy();

    cleanup();
    renderPalette(1);
    expect(screen.queryByRole('option', { name: /go to workspace security/i })).toBeNull();
  });
});
