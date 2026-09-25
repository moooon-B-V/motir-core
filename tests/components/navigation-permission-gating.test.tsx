// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { OrganizationDTO } from '@/lib/dto/organizations';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';

// MOTIR-6175 — navigation offers no room closed to the actor (Story MOTIR-6166;
// the permission-gated UI rule's rows 1–4 in `design/projects/design-notes.md`).
// Each case below is a door the MOTIR-6172 inventory found open onto a room
// that refused its actor, and each asserts BOTH halves: the actor the room
// refuses is not offered the door, and the actor it serves still is.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(authed)/_actions', () => ({
  switchOrganizationAction: vi.fn(async () => undefined),
  createOrganizationAction: vi.fn(async () => undefined),
  createWorkspaceAction: vi.fn(async () => undefined),
  switchWorkspaceAction: vi.fn(async () => undefined),
}));
vi.mock('@/app/(authed)/_project-actions', () => ({
  setActiveProjectAction: vi.fn(async () => undefined),
}));
vi.mock('@/lib/auth/client', () => ({ signOut: vi.fn(async () => undefined) }));
vi.mock('@/app/(authed)/_components/CommandPaletteProvider', () => ({
  useCommandPalette: () => ({ open: true, setOpen: vi.fn() }),
}));
vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({ openCreateIssue: vi.fn(), canCreate: true }),
}));
vi.mock('@/app/(authed)/_components/OnboardingResumeProvider', () => ({
  useOnboardingResume: () => false,
}));
vi.mock('@/lib/contexts/theme-context', () => ({
  useTheme: () => ({ pattern: 'light', setPattern: vi.fn() }),
}));

import { OrgControl } from '@/app/(authed)/_components/OrgControl';
import { AppCommandPalette } from '@/app/(authed)/_components/AppCommandPalette';
import { UnmappedStatusesTray } from '@/app/(authed)/boards/_components/UnmappedStatusesTray';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';

afterEach(() => cleanup());

// ── The org menu reads the org settings REGISTRY ───────────────────────────────

const ACME: OrganizationDTO = { id: 'org_acme', name: 'Acme', slug: 'acme' };

function openOrgMenu(role: string, { cloudBilling = true, workspaceTierRevealed = false } = {}) {
  renderWithIntl(
    <ToastProvider>
      <OrgControl
        activeOrg={{ id: ACME.id, name: ACME.name, role }}
        orgs={[ACME]}
        cloudBilling={cloudBilling}
        workspaceTierRevealed={workspaceTierRevealed}
      />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Organization menu' }));
  return (name: string) => screen.queryByRole('link', { name }) !== null;
}

describe('the organization menu', () => {
  it('an org OWNER is offered every settings room', () => {
    const has = openOrgMenu('owner', { workspaceTierRevealed: true });
    for (const name of ['Settings', 'Security', 'Members', 'Usage & cost', 'Billing & plans']) {
      expect(has(name), name).toBe(true);
    }
  });

  it('a PLAIN org member is offered no room that answers them with the forbidden panel', () => {
    const has = openOrgMenu('member');
    // Security, Members and Billing are owner/admin rooms.
    expect(has('Security')).toBe(false);
    expect(has('Members')).toBe(false);
    expect(has('Billing & plans')).toBe(false);
    // Usage & cost too: the role model's org tier carries no org rows for a
    // Member (MOTIR-6312 · design panel 3), re-applied over MOTIR-6175.
    expect(has('Usage & cost')).toBe(false);
    // Below the workspace-tier reveal, Settings hosts their folded-in workspace
    // sections (and Leave workspace) — kept.
    expect(has('Settings')).toBe(true);
  });

  it('ABOVE the reveal a plain member in one org gets the org NAME as a label — no menu over nothing', () => {
    // MOTIR-6312 · panel 3b: no row is left for them and there is no other org
    // to switch to, so the control is a plain label rather than a button over an
    // empty popover.
    renderWithIntl(
      <ToastProvider>
        <OrgControl
          activeOrg={{ id: ACME.id, name: ACME.name, role: 'member' }}
          orgs={[ACME]}
          cloudBilling
          workspaceTierRevealed
        />
      </ToastProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Organization menu' })).toBeNull();
    expect(screen.getByText('Acme', { exact: true })).toBeTruthy();
  });

  it('off cloud nobody is offered Billing — the room 404s there', () => {
    expect(openOrgMenu('owner', { cloudBilling: false })('Billing & plans')).toBe(false);
  });
});

// ── ⌘K Create ───────────────────────────────────────────────────────────────

const PROJECT = {
  id: 'proj_motir',
  workspaceId: 'ws_1',
  name: 'Motir',
  identifier: 'MOTIR',
  key: 'MOTIR',
  archivedAt: null,
} as unknown as ProjectDTO;

function renderPalette(permissions: readonly PermissionKey[]) {
  return renderWithIntl(
    <AppCommandPalette
      workspaces={[]}
      activeWorkspaceId="ws_1"
      projects={[PROJECT]}
      activeProjectId={PROJECT.id}
      settingsPermissions={permissions}
    />,
  );
}

describe('the ⌘K Create action', () => {
  it('is not offered to a Viewer — the create modal is not even mounted for them', () => {
    renderPalette([...BUILTIN_ROLE_PERMISSIONS.viewer]);
    expect(screen.queryByRole('option', { name: /create work item/i })).toBeNull();
  });

  it('is offered to a Member', () => {
    renderPalette([...BUILTIN_ROLE_PERMISSIONS.member]);
    expect(screen.getByRole('option', { name: /create work item/i })).toBeTruthy();
  });
});

// ── The board's unmapped-statuses tray ────────────────────────────────────────

describe('the unmapped-statuses tray', () => {
  const STATUSES = [
    {
      id: 's9',
      projectId: 'p1',
      key: 'qa',
      label: 'QA',
      category: 'in_progress',
      color: null,
      position: 'a9',
      isInitial: false,
    },
  ] as never;

  function renderTray(permissions: readonly PermissionKey[]) {
    return renderWithIntl(
      <ProjectAccessProvider permissions={[...permissions]}>
        <UnmappedStatusesTray statuses={STATUSES} boardId="b1" />
      </ProjectAccessProvider>,
    );
  }

  it('warns everyone, and offers the Map-columns door only to a board configurer', () => {
    renderTray([...BUILTIN_ROLE_PERMISSIONS.member]);
    expect(screen.getByTestId('board-unmapped-tray')).toBeTruthy();
    expect(screen.getByText('QA')).toBeTruthy();
    expect(screen.queryByTestId('board-unmapped-link')).toBeNull();

    cleanup();
    renderTray([...BUILTIN_ROLE_PERMISSIONS.member, 'board:configure']);
    expect(screen.getByTestId('board-unmapped-link').getAttribute('href')).toBe(
      '/settings/project/board?board=b1',
    );
  });
});
