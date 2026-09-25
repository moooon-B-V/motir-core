// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { OrganizationDTO } from '@/lib/dto/organizations';
import type { WorkspaceSummaryDTO } from '@/lib/dto/workspaces';

// MOTIR-6312 · `design/org-admin/org-admin--workspaces-at-org-tier.mock.html`
// panels 3a–3c: each shell door onto an org-tier act renders for the roles that
// hold it and is ABSENT — never disabled — for the rest. The org role comes from
// the one capability table (`lib/organizations/capabilities.ts`), read off the
// role the shell is already handed.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
}));
vi.mock('@/app/(authed)/_actions', () => ({
  switchOrganizationAction: vi.fn(async () => undefined),
  switchWorkspaceAction: vi.fn(async () => undefined),
  createOrganizationAction: vi.fn(async () => undefined),
  createWorkspaceAction: vi.fn(async () => ({ ok: true })),
}));

import { OrgControl } from '@/app/(authed)/_components/OrgControl';
import { WorkspaceSwitcher } from '@/app/(authed)/_components/WorkspaceSwitcher';
import { ShellTierNav } from '@/app/(authed)/_components/ShellTierNav';

const ACME: OrganizationDTO = { id: 'org_acme', name: 'Acme', slug: 'acme' };
const BEACON: OrganizationDTO = { id: 'org_beacon', name: 'Beacon', slug: 'beacon' };
const ws = (n: number): WorkspaceSummaryDTO[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `ws${i}`,
    name: `Workspace ${i}`,
    slug: `ws${i}`,
    organizationId: ACME.id,
  }));

function renderOrgControl(
  role: string,
  { revealed = false, orgs = [ACME] }: { revealed?: boolean; orgs?: OrganizationDTO[] } = {},
) {
  return render(
    <ToastProvider>
      <OrgControl
        activeOrg={{ id: ACME.id, name: ACME.name, role }}
        orgs={orgs}
        cloudBilling
        workspaceTierRevealed={revealed}
      />
    </ToastProvider>,
  );
}

function openOrgMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Organization menu' }));
}

const menuRows = () =>
  [
    ...screen.queryAllByRole('link').map((a) => a.textContent?.trim() ?? ''),
    ...screen
      .queryAllByRole('button')
      .map((b) => b.textContent?.trim() ?? '')
      .filter((t) => t === 'New workspace'),
  ].filter(Boolean);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OrgControl — the org menu by role', () => {
  for (const role of ['owner', 'admin']) {
    it(`an ${role.toUpperCase()} gets every org row and New workspace`, () => {
      renderOrgControl(role, { revealed: true });
      openOrgMenu();
      expect(menuRows()).toEqual([
        'Settings',
        'Security',
        'Members',
        'Usage & cost',
        'Billing & plans',
        'New workspace',
      ]);
    });
  }

  it('3a · a MEMBER at ONE workspace keeps Settings alone — no New workspace, no org rows', () => {
    renderOrgControl('member', { revealed: false });
    openOrgMenu();
    expect(menuRows()).toEqual(['Settings']);
  });

  it('3b · a MEMBER at 2+ workspaces in ONE org sees the org name as a plain LABEL', () => {
    renderOrgControl('member', { revealed: true });
    // No button, no chevron over an empty popover — just the name.
    expect(screen.queryByRole('button', { name: 'Organization menu' })).toBeNull();
    expect(screen.getByText('Acme')).toBeTruthy();
  });

  it('3b · a MEMBER at 2+ workspaces in 2+ orgs keeps the menu, holding Switch organization alone', () => {
    renderOrgControl('member', { revealed: true, orgs: [ACME, BEACON] });
    openOrgMenu();
    expect(menuRows()).toEqual([]);
    expect(screen.getByRole('button', { name: /Beacon/ })).toBeTruthy();
    expect(screen.queryByText('New workspace')).toBeNull();
  });
});

describe('WorkspaceSwitcher — the Create workspace doors', () => {
  it('offers Create workspace to someone who may create', () => {
    render(
      <ToastProvider>
        <WorkspaceSwitcher workspaces={ws(2)} activeWorkspaceId="ws0" canCreateWorkspace />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Switch workspace' }));
    expect(screen.getByRole('button', { name: 'Create workspace' })).toBeTruthy();
  });

  it('3c · a MEMBER’s popover has no Create workspace — the list and the act-on group close up', () => {
    render(
      <ToastProvider>
        <WorkspaceSwitcher workspaces={ws(2)} activeWorkspaceId="ws0" canCreateWorkspace={false} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Switch workspace' }));
    expect(screen.queryByRole('button', { name: 'Create workspace' })).toBeNull();
    // The act-on-this-workspace group is untouched.
    expect(screen.getByRole('link', { name: /Workspace settings/ })).toBeTruthy();
  });

  it('3c · the cold-start CTA is gated the same way', () => {
    render(
      <ToastProvider>
        <WorkspaceSwitcher workspaces={[]} activeWorkspaceId={null} canCreateWorkspace={false} />
      </ToastProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Create workspace' })).toBeNull();
  });
});

describe('ShellTierNav — derives both doors from the org role it is handed', () => {
  function renderTier(activeOrg: { id: string; name: string; role: string } | null, n: number) {
    return render(
      <ToastProvider>
        <ShellTierNav
          activeOrg={activeOrg}
          orgs={activeOrg ? [ACME] : []}
          workspaces={ws(n)}
          activeWorkspaceId="ws0"
          cloudBilling={false}
          placement="drawer"
        />
      </ToastProvider>,
    );
  }

  it('an org MEMBER at 2 workspaces: org name as a label, switcher without Create', () => {
    renderTier({ id: ACME.id, name: ACME.name, role: 'member' }, 2);
    expect(screen.queryByRole('button', { name: 'Organization menu' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Switch workspace' }));
    expect(screen.queryByRole('button', { name: 'Create workspace' })).toBeNull();
  });

  it('an org ADMIN at 2 workspaces keeps both doors', () => {
    renderTier({ id: ACME.id, name: ACME.name, role: 'admin' }, 2);
    fireEvent.click(screen.getByRole('button', { name: 'Switch workspace' }));
    expect(screen.getByRole('button', { name: 'Create workspace' })).toBeTruthy();
  });

  it('someone with NO organization may create — the switcher is handed canCreateWorkspace', () => {
    // `ShellTierNav` renders the switcher only at 2+ workspaces, so the no-org
    // arm is asserted on the derivation's output rather than a cold start.
    renderTier(null, 2);
    fireEvent.click(screen.getByRole('button', { name: 'Switch workspace' }));
    expect(screen.getByRole('button', { name: 'Create workspace' })).toBeTruthy();
  });
});
