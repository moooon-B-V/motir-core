// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { renderWithIntl } from '../helpers/renderWithIntl';

// MOTIR-2570 → MOTIR-4167 — THE DOCS DOOR, once the documentation lives
// somewhere else.
//
// This file was written for MOTIR-2570, when the row escaped to a GitHub README
// and the fix was to point it at the in-app documentation index. That index then
// LEFT this repository — MOTIR-3932 moved the public reading surface to
// motir-marketing — and the row kept its hard-coded app-relative path, so a
// signed-in reader who clicked **Docs** got a 404. Nothing caught it, because
// this file pinned the href to a string and no guard reads a `.tsx` href against
// the route tree; the address guard over design assets recorded the dead route
// eight times while the live row sat unexamined.
//
// So the row now takes the shape the `Legal` row beside it took for the same
// split (MOTIR-4010): it renders from `docsIndexUrl`, the operator's own ABSOLUTE
// url, and on a deployment that has configured none **there is no row at all**.
//
// ⚠️ THE ABSENT ARM IS THE ONE THIS FILE NOW EXISTS FOR. It is what every
// self-hoster sees on day one, so it is the COMMON case for the open product
// rather than an edge, and it is the floor arm
// `design/shell/rail-bottom-section.mock.html` draws beside the complete one.
// Absent, not disabled and not empty-stated: a door pointing nowhere is worse
// than no door — which is the sentence the dead row was contradicting.
//
// The prop defaults to `null`, so a caller that forgets to thread it draws no
// row — it fails closed, which is the direction that cannot mislead a reader.

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
  archivedAt: null,
} as unknown as ProjectDTO;

const USER = { name: 'Yue', email: 'yue@example.com' };

const ADMIN = [...BUILTIN_ROLE_PERMISSIONS.admin];
const VIEWER = [...BUILTIN_ROLE_PERMISSIONS.viewer];

/** The hosted arrangement's value — an absolute url on the brand host. */
const DOCS = 'https://motir.co/docs';

function renderRail({
  docsIndexUrl = DOCS,
  legalIndexUrl = null,
  permissions = ADMIN,
  project = PROJECT,
}: {
  docsIndexUrl?: string | null;
  legalIndexUrl?: string | null;
  permissions?: readonly PermissionKey[];
  project?: ProjectDTO | null;
} = {}) {
  return renderWithIntl(
    <SidebarNav
      activeProject={project}
      settingsPermissions={permissions}
      user={USER}
      docsIndexUrl={docsIndexUrl}
      legalIndexUrl={legalIndexUrl}
    />,
  );
}

const docsRow = () => screen.queryByRole('link', { name: 'Docs' });

afterEach(() => {
  cleanup();
  pathname = '/dashboard';
});

describe('the Docs door in the app shell rail', () => {
  it('points at the CONFIGURED url — an absolute url, not a path', () => {
    renderRail();
    expect(docsRow()?.getAttribute('href')).toBe(DOCS);
  });

  it('does NOT point at `/docs` — this application no longer serves it', () => {
    // The two-sided assertion this file established under MOTIR-2570, with the
    // sides swapped by history: pinning the href catches a re-point at the wrong
    // surface, and refusing the old path catches a revert to the route that
    // 404s — which is what the row was doing when MOTIR-4167 was filed.
    renderRail();
    const href = docsRow()?.getAttribute('href') ?? '';
    expect(href).not.toBe('/docs');
    expect(href.startsWith('/')).toBe(false);
    // …and not back out to the README either, the defect BEFORE that one.
    expect(href).not.toContain('github.com');
  });

  it('renders NO ROW when nothing is configured', () => {
    renderRail({ docsIndexUrl: null });
    expect(docsRow()).toBeNull();
    // Absent, not disabled: no stand-in text either.
    expect(screen.queryByText('Docs')).toBeNull();
  });

  it('renders no row when the prop is OMITTED — it fails closed', () => {
    // Rendered directly rather than through the helper, whose default would
    // configure the very prop this case leaves out.
    renderWithIntl(<SidebarNav activeProject={PROJECT} settingsPermissions={ADMIN} user={USER} />);
    expect(docsRow()).toBeNull();
  });

  it('leaves the rest of the section alone — the difference is exactly one row', () => {
    // Nothing else about the bottom section moves when the row goes: the
    // neighbouring doors keep their targets, which is what the asset's floor arm
    // draws beside the complete one.
    renderRail({ docsIndexUrl: null, legalIndexUrl: 'https://motir.co/legal' });
    expect(screen.getByRole('link', { name: 'Job runs' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Git' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Legal' }).getAttribute('href')).toBe(
      'https://motir.co/legal',
    );
  });

  it('survives every role — documentation is not permission-gated', () => {
    renderRail({ permissions: VIEWER });
    expect(docsRow()?.getAttribute('href')).toBe(DOCS);
  });

  it('survives with no active project', () => {
    renderRail({ permissions: undefined, project: null });
    expect(docsRow()?.getAttribute('href')).toBe(DOCS);
  });

  it('keeps its place in the rail footer, below Job runs and Git', () => {
    // The row's position is part of the shipped design; the re-point must not
    // relocate it.
    renderRail();
    const docs = screen.getByRole('link', { name: 'Docs' });
    for (const label of ['Settings', 'Job runs', 'Git']) {
      const row = screen.getByRole('link', { name: label });
      expect(
        row.compareDocumentPosition(docs) & Node.DOCUMENT_POSITION_FOLLOWING,
        `Docs follows ${label}`,
      ).toBeTruthy();
    }
  });

  it('carries no `aria-current`, anywhere', () => {
    // The destination is off-shell, so the rail is never on screen there — an
    // `active` arm could not fire, and adding one would be dead code that reads
    // as a feature.
    pathname = '/docs';
    renderRail();
    expect(docsRow()?.getAttribute('aria-current')).toBeNull();
  });
});
