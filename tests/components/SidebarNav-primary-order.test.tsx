// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';
import { renderWithIntl } from '../helpers/renderWithIntl';

// THE PRIMARY RAIL'S ROW ORDER (MOTIR-4799).
//
// The order was decided in code, one comment per row — "sits after Backlog",
// "between Boards and Reports", "the FIRST primary entry, above Dashboard" — and
// asserted nowhere. So when MOTIR-4799 moved `Dashboard` below `Backlog` on
// Yue's instruction ("dashboard is not important"), three of those comments
// became false and nothing went red.
//
// This file is the guard that was missing. It asserts the WHOLE ordered list off
// the RENDERED rail rather than off `primaryItems`, for the reason
// `tests/components/OnboardingExit.test.tsx` demonstrated one repair earlier: a
// test that reads the same array the component reads cannot see a row that
// renders in the wrong place, and a test that pins a literal without saying why
// that literal is the answer goes stale exactly as a comment does.
//
// ⚠️ IT IS DELIBERATELY A WHOLE-LIST EQUALITY, not a set of pairwise
// `indexOf(a) < indexOf(b)` checks. A pairwise assertion is satisfied by a rail
// that has silently LOST a row — `indexOf` returns -1 and -1 is less than
// everything — which is the failure mode `projectNavAccess.ts`'s own header
// warns about (an href missing from the gating map drops its row in silence).

let pathname = AUTHED_LANDING_PATH;
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
  avatarIcon: null,
  avatarColor: null,
  archivedAt: null,
} as unknown as ProjectDTO;

const USER = { name: 'Yue', email: 'yue@example.com' };

// The four keys the primary rail's non-`browse-only` rows require, read from
// `PROJECT_NAV_ACCESS`'s own evidence lines rather than guessed from row names.
// Without them `canOfferNavDestination` drops Plans, Triage, Reports and Code
// health, and the list under test would be the browse-only subset — which is a
// real rail, but not the one whose order this card changed.
const ALL_PRIMARY_KEYS: PermissionKey[] = [
  'ai:view_plan',
  'work_item:triage',
  'report:view',
  'ai:configure',
];

// The order as MOTIR-4799 leaves it. `Dashboard` sits between `Backlog` and
// `Triage`: Yue was offered "immediately after Backlog" against "last in the
// list" and chose the former.
const EXPECTED_PRIMARY_ORDER = [
  AUTHED_LANDING_PATH,
  '/items',
  '/ready',
  '/runs',
  '/boards',
  '/roadmap',
  '/plans',
  '/backlog',
  '/dashboard',
  '/triage',
  '/reports',
  '/code-health',
];

afterEach(() => {
  cleanup();
  pathname = AUTHED_LANDING_PATH;
});

describe('SidebarNav — the primary section renders in the decided order', () => {
  it('renders every primary row, once, in order, ahead of the bottom section', () => {
    renderWithIntl(
      <SidebarNav activeProject={PROJECT} user={USER} settingsPermissions={ALL_PRIMARY_KEYS} />,
    );
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    // The primary section is pushed first, so it leads the rail's link list; the
    // slice is what asserts that as well as the order within it.
    expect(links.slice(0, EXPECTED_PRIMARY_ORDER.length)).toEqual(EXPECTED_PRIMARY_ORDER);
  });

  it('puts Dashboard AFTER Backlog and BEFORE Triage — the change itself', () => {
    // Stated on its own as well as inside the whole-list equality above, so a
    // future reader who breaks it is told WHICH property they broke rather than
    // being handed a twelve-element diff.
    renderWithIntl(
      <SidebarNav activeProject={PROJECT} user={USER} settingsPermissions={ALL_PRIMARY_KEYS} />,
    );
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links.indexOf('/dashboard')).toBe(links.indexOf('/backlog') + 1);
    expect(links.indexOf('/triage')).toBe(links.indexOf('/dashboard') + 1);
  });

  it('leaves Home leading the rail — the demotion moved Dashboard, nothing else', () => {
    // MOTIR-2654's own guard (`SidebarNav-home-door.test.tsx`) asserts
    // `indexOf('/home') < indexOf('/dashboard')` and still passes UNAMENDED
    // through this change, because Dashboard only moved further down. Restated
    // here so the two files agree in the open rather than by coincidence.
    renderWithIntl(
      <SidebarNav activeProject={PROJECT} user={USER} settingsPermissions={ALL_PRIMARY_KEYS} />,
    );
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links[0]).toBe(AUTHED_LANDING_PATH);
    expect(links.indexOf(AUTHED_LANDING_PATH)).toBeLessThan(links.indexOf('/dashboard'));
  });
});
