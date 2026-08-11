// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ProjectDTO } from '@/lib/dto/projects';
import zhMessages from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';

// The Home DOOR (Story MOTIR-2649 · Subtask MOTIR-2654, design/home/ Panel A) —
// the rail entry that makes `/home` reachable. A page nobody lands on is a page
// nobody has, so this is the half of the story that has to be asserted rather
// than assumed.
//
// Two of these cover traps rather than behaviour: the row is dropped SILENTLY if
// `/home` is missing from the nav-access map (`canOfferNavDestination` answers
// false for an href it does not carry), and it would be absent for a reader with
// no active project, who is exactly the reader most likely to have just signed
// in and landed there.

let pathname = '/home';
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

afterEach(() => {
  cleanup();
  pathname = '/home';
});

describe('SidebarNav — the Home entry', () => {
  it('renders a Home link to /home', () => {
    renderWithIntl(<SidebarNav activeProject={PROJECT} user={USER} />);
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/home');
  });

  it('places Home ABOVE Dashboard, and leaves Dashboard its own row', () => {
    renderWithIntl(<SidebarNav activeProject={PROJECT} user={USER} />);
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    // Nothing is re-homed: /dashboard keeps its route AND its entry.
    expect(links).toContain('/dashboard');
    expect(links.indexOf('/home')).toBeLessThan(links.indexOf('/dashboard'));
    // And Home leads the primary nav.
    expect(links.indexOf('/home')).toBe(0);
  });

  it('marks Home current on /home and nowhere else', () => {
    renderWithIntl(<SidebarNav activeProject={PROJECT} user={USER} />);
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe('page');

    cleanup();
    pathname = '/dashboard';
    renderWithIntl(<SidebarNav activeProject={PROJECT} user={USER} />);
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('is STILL OFFERED with no active project — the state a fresh sign-in lands in', () => {
    // Every other primary entry is project-scoped and correctly absent here.
    // Home is workspace-scoped and is where signing in now lands, so a reader
    // without a project would otherwise have no row back to the page they
    // arrived on.
    renderWithIntl(<SidebarNav activeProject={null} user={USER} />);
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/home');
    expect(screen.queryByRole('link', { name: 'Boards' })).toBeNull();
  });

  it('survives the nav-access gate — the row is not silently dropped', () => {
    // `canOfferNavDestination` answers FALSE for an href the map does not carry,
    // and `primaryItems` is filtered through it. So an omission from
    // PROJECT_NAV_ACCESS does not fail loudly; it just removes the row. This
    // asserts the row is there for an actor holding NO permissions at all —
    // which is the case the map's `browse-only` answer is claiming.
    renderWithIntl(<SidebarNav activeProject={PROJECT} user={USER} settingsPermissions={[]} />);
    expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy();
  });

  it('labels the row from the zh catalog too', () => {
    renderWithIntl(<SidebarNav activeProject={PROJECT} user={USER} />, { messages: zhMessages });
    expect(screen.getByRole('link', { name: '主页' }).getAttribute('href')).toBe('/home');
  });
});
