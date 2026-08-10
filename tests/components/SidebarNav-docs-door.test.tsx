// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { renderWithIntl } from '../helpers/renderWithIntl';

// Bug MOTIR-2570 — THE DOCS DOOR.
//
// The rail's Docs row used to carry a hardcoded GitHub README URL, on a comment
// that said there was no in-app docs route. There has been one since
// `/docs/api` shipped, and the area now has a front door at `/docs`. Nothing
// asserted the row's destination, which is why an entrance that pointed OUT of
// the product survived three separate sweeps of the in-app doors: each of them
// searched for the docs ROUTE, and this row never named it.
//
// So the assertion is deliberately two-sided. Pinning the href to `/docs`
// catches a re-point at the wrong surface; asserting the row does not name
// `github.com` catches a revert to an external URL, which a positive-only test
// would let pass quietly the moment someone reinstated the constant.

let pathname = '/dashboard';
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

const ADMIN = [...BUILTIN_ROLE_PERMISSIONS.admin];
const VIEWER = [...BUILTIN_ROLE_PERMISSIONS.viewer];

function renderRail(permissions?: readonly PermissionKey[], project: ProjectDTO | null = PROJECT) {
  return renderWithIntl(
    // No `projects` prop: MOTIR-2554 moved the project SWITCHER out of the rail
    // and into the top bar, so the rail no longer takes the project LIST. It
    // still takes `activeProject` — the settings door and its permission gate
    // read it — which is what the "no active project" case below exercises.
    <SidebarNav activeProject={project} settingsPermissions={permissions} user={USER} />,
  );
}

const docsRow = () => screen.queryByRole('link', { name: 'Docs' });

afterEach(() => {
  cleanup();
  pathname = '/dashboard';
});

describe('the Docs door in the app shell rail', () => {
  it('points INTO the product, at the documentation area front door', () => {
    renderRail(ADMIN);
    expect(docsRow()?.getAttribute('href')).toBe('/docs');
  });

  it('does NOT link to github.com — leaving the product is the defect', () => {
    renderRail(ADMIN);
    const href = docsRow()?.getAttribute('href') ?? '';
    expect(href).not.toContain('github.com');
    // An internal route, not an absolute URL to anywhere else either.
    expect(href.startsWith('/')).toBe(true);
  });

  it('is not the API reference — `/docs`, not `/docs/api`', () => {
    // Re-pointing the rail at one room of the area would re-introduce, one
    // surface over, the very defect the index story exists to fix.
    renderRail(ADMIN);
    expect(docsRow()?.getAttribute('href')).not.toBe('/docs/api');
  });

  it('survives every role — documentation is not permission-gated', () => {
    renderRail(VIEWER);
    expect(docsRow()?.getAttribute('href')).toBe('/docs');
  });

  it('survives with no active project', () => {
    renderRail(undefined, null);
    expect(docsRow()?.getAttribute('href')).toBe('/docs');
  });

  it('keeps its place in the rail footer, below Job runs and Git', () => {
    // The row's position is part of the shipped design; a re-point must not
    // relocate it.
    renderRail(ADMIN);
    const docs = screen.getByRole('link', { name: 'Docs' });
    for (const label of ['Settings', 'Job runs', 'Git']) {
      const row = screen.getByRole('link', { name: label });
      expect(
        row.compareDocumentPosition(docs) & Node.DOCUMENT_POSITION_FOLLOWING,
        `Docs follows ${label}`,
      ).toBeTruthy();
    }
  });

  it('carries no `aria-current`, on `/docs` as anywhere else', () => {
    // `/docs` renders in the `(public)` group outside this shell, so the rail
    // is never on screen there — an `active` arm could not fire, and adding one
    // would be dead code that reads as a feature.
    pathname = '/docs';
    renderRail(ADMIN);
    expect(docsRow()?.getAttribute('aria-current')).toBeNull();
  });
});
