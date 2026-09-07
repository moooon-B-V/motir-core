// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ProjectDTO } from '@/lib/dto/projects';
import { renderWithIntl } from '../helpers/renderWithIntl';

// Story MOTIR-4669 · MOTIR-4710 — the rail SWAPS to the organisation-settings nav.
//
// The third of three area branches, and the one that closes a gap rather than
// adding a feature. `SidebarNav` swapped on exactly two predicates —
// `isAccountSettingsPath` and `isProjectSettingsPath` — so `/settings/organization*`
// rendered the ORDINARY rail with the bottom `Settings` row lit, and the four org
// sub-routes were reachable only from the `OrgControl` pop-over. People arrived
// (the bottom row points here whenever no project is active) at a page naming none
// of them.
//
// The registry's own unit tests (`tests/settings/organizationSettingsNav.test.ts`)
// prove the filtering. THIS file proves the RAIL — that the branch is reached, that
// the header names the organisation rather than the project or the user, and that
// what the registry decided is what actually renders.

let pathname = '/settings/organization';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { SidebarNav } from '@/app/(authed)/_components/SidebarNav';

const PROJECT = {
  id: 'p1',
  key: 'MOTIR',
  identifier: 'MOTIR',
  name: 'Motir',
  archivedAt: null,
} as unknown as ProjectDTO;

const USER = { name: 'Yue', email: 'yue@example.com' };
const ADMIN_ORG = { name: 'moooon', isOrgAdmin: true };
const MEMBER_ORG = { name: 'moooon', isOrgAdmin: false };

function renderRail(
  organization: { name: string; isOrgAdmin: boolean } | null,
  billingAvailable = true,
) {
  return renderWithIntl(
    <SidebarNav
      activeProject={PROJECT}
      user={USER}
      organization={organization}
      billingAvailable={billingAvailable}
    />,
  );
}

const rowNames = () =>
  screen
    .getAllByRole('link')
    .map((a) => a.textContent?.trim() ?? '')
    .filter(Boolean);

afterEach(() => {
  pathname = '/settings/organization';
  cleanup();
});

describe('the rail SWAPS on an organisation-settings route', () => {
  it('renders the organisation nav, in registry order', () => {
    renderRail(ADMIN_ORG);
    // `Git` joined in MOTIR-4680, in the SAME commit as its route — the move
    // every row in these registries makes.
    expect(rowNames()).toEqual([
      'Back to Motir',
      'Organisation',
      'Git',
      'Members',
      'Security',
      'Usage & cost',
      'Billing & plans',
    ]);
  });

  it('⚠️ the PRODUCT rail is gone while in the area — this is a swap, not an addition', () => {
    // The property that makes it an AREA. If the branch were reached but returned
    // the ordinary sections plus a group, a person inside organisation settings
    // would see Board, Roadmap and the rest — which is what "the same setting nav
    // as the project setting" rules out.
    renderRail(ADMIN_ORG);
    expect(screen.queryByRole('link', { name: 'Board' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Job runs' })).toBeNull();
  });

  it('the HEAD names the ORGANISATION — not the project, not the user', () => {
    // Each area's head names the tenant that area configures. The project area
    // shows the ProjectSwitcher, the account area the signed-in user; getting this
    // one wrong would be invisible to a type checker and obvious to a reader.
    renderRail(ADMIN_ORG);
    expect(screen.getByText('moooon')).toBeTruthy();
    expect(screen.getByText('Organisation settings')).toBeTruthy();
    expect(screen.queryByText('yue@example.com')).toBeNull();
  });

  it('every group heading renders, in order', () => {
    renderRail(ADMIN_ORG);
    const headings = screen.getAllByText(/^(General|Access|Billing)$/).map((n) => n.textContent);
    expect(headings).toEqual(['General', 'Access', 'Billing']);
  });

  it('the ACTIVE row is the route, and it is the only one', () => {
    pathname = '/settings/organization/members';
    renderRail(ADMIN_ORG);
    const current = screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current'));
    expect(current.map((a) => a.textContent?.trim())).toEqual(['Members']);
  });

  it('⚠️ the ROOT row is active on the root ALONE', () => {
    // Every other href sits beneath this one, so without the registry's `exact`
    // flag `Organisation` would read current on all five routes at once.
    pathname = '/settings/organization';
    renderRail(ADMIN_ORG);
    const current = screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current'));
    expect(current.map((a) => a.textContent?.trim())).toEqual(['Organisation']);
  });
});

describe('the two filtered arms, as they RENDER', () => {
  it('a plain org member sees `Organisation` and `Git` — absent, not disabled', () => {
    // Both survive, for two DIFFERENT reasons: `Organisation` because §6d's
    // folded-in workspace sections (and Leave workspace) are reached only through
    // it, `Git` because §6 forbids a relocation that narrows an audience and the
    // surface it moved from checks no role at all.
    renderRail(MEMBER_ORG);
    expect(rowNames()).toEqual(['Back to Motir', 'Organisation', 'Git']);
    // Nothing marks the gap: an entry point is a promise about a room, and a
    // disabled row is a promise the product then refuses (MOTIR-2468).
    expect(screen.queryByText('Access')).toBeNull();
    expect(screen.queryByText('Billing')).toBeNull();
  });

  it('off cloud, `Billing & plans` is gone and its group keeps `Usage & cost`', () => {
    renderRail(ADMIN_ORG, false);
    expect(rowNames()).not.toContain('Billing & plans');
    expect(rowNames()).toContain('Usage & cost');
    expect(screen.getByText('Billing')).toBeTruthy(); // the group heading survives
  });

  it('⚠️ with NO organisation threaded the rail defaults CLOSED', () => {
    // A caller that forgets the prop must lose rows, never gain them. The head is
    // omitted too rather than rendering an empty identity.
    renderRail(null);
    expect(rowNames()).toEqual(['Organisation', 'Git']);
    expect(screen.queryByText('Organisation settings')).toBeNull();
  });
});

describe('the branch does not fire outside the area', () => {
  it.each([['/dashboard'], ['/settings/workspace'], ['/settings/workspace/jobs']])(
    'renders the ordinary rail at %s',
    (path) => {
      pathname = path;
      renderRail(ADMIN_ORG);
      // The bottom section is back, which is the cheapest proof the org branch
      // was not taken.
      expect(screen.queryByRole('link', { name: 'Job runs' })).toBeTruthy();
      expect(screen.queryByText('Organisation settings')).toBeNull();
    },
  );
});
