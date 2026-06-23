// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { OrganizationDTO } from '@/lib/dto/organizations';

// MOTIR-1312 — switching the active org must NOT just refresh in place (it leaves
// the page body on the OLD org: client islands seeded from props don't re-seed,
// and the URL may be scoped to an old-org entity). It must navigate to the
// work-items surface, falling back to refresh only when already there. This test
// drives the real OrgControl switcher and asserts the navigation, not refresh.
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const nav = vi.hoisted(() => ({ pathname: '/dashboard' }));
const { switchOrganizationAction } = vi.hoisted(() => ({
  switchOrganizationAction: vi.fn(async () => undefined),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => nav.pathname,
}));
vi.mock('@/app/(authed)/_actions', () => ({
  switchOrganizationAction,
  createOrganizationAction: vi.fn(async () => undefined),
  createWorkspaceAction: vi.fn(async () => undefined),
}));

import { OrgControl } from '@/app/(authed)/_components/OrgControl';

const ACME: OrganizationDTO = { id: 'org_acme', name: 'Acme', slug: 'acme' };
const BEACON: OrganizationDTO = { id: 'org_beacon', name: 'Beacon', slug: 'beacon' };

function renderOrgControl() {
  return render(
    <ToastProvider>
      <OrgControl
        activeOrg={{ id: ACME.id, name: ACME.name, slug: ACME.slug, role: 'owner' }}
        orgs={[ACME, BEACON]}
        cloudBilling={false}
      />
    </ToastProvider>,
  );
}

async function openMenuAndSwitchToBeacon() {
  fireEvent.click(screen.getByRole('button', { name: 'Organization menu' }));
  const beacon = await screen.findByRole('button', { name: /Beacon/ });
  fireEvent.click(beacon);
  await waitFor(() => expect(switchOrganizationAction).toHaveBeenCalledWith('org_beacon'));
}

beforeEach(() => {
  nav.pathname = '/dashboard';
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OrgControl — navigation after switching org (MOTIR-1312)', () => {
  it('navigates to the work-items surface (does NOT merely refresh in place) from another page', async () => {
    nav.pathname = '/dashboard';
    renderOrgControl();
    await openMenuAndSwitchToBeacon();

    await waitFor(() => expect(push).toHaveBeenCalledWith('/items'));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('navigates away from a deep, old-org-scoped URL', async () => {
    nav.pathname = '/items/MOTIR-804';
    renderOrgControl();
    await openMenuAndSwitchToBeacon();

    await waitFor(() => expect(push).toHaveBeenCalledWith('/items'));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes in place when already on the work-items surface', async () => {
    nav.pathname = '/items';
    renderOrgControl();
    await openMenuAndSwitchToBeacon();

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(push).not.toHaveBeenCalled();
  });
});
