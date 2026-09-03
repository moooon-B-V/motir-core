// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ProjectDTO } from '@/lib/dto/projects';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { renderWithIntl } from '../helpers/renderWithIntl';

// MOTIR-4010 — THE LEGAL DOOR, once the documents live somewhere else.
//
// The row used to point at `/legal`, a page this application served. The
// documents left (MOTIR-3909), so the row now points at the operator's own
// published index — and on a deployment that has published none, **there is no
// row at all**.
//
// ⚠️ THE ABSENT ARM IS THE ONE THIS FILE EXISTS FOR. It is what every
// self-hoster sees on day one, so it is the COMMON case for the open product
// rather than an edge, and it is the arm
// `design/auth/legal-agreement.mock.html` panel 14 draws beside its configured
// twin. Absent, not disabled and not empty-stated: a door pointing nowhere is
// worse than no door.
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

function renderRail(legalIndexUrl?: string | null) {
  return renderWithIntl(
    <SidebarNav
      activeProject={PROJECT}
      settingsPermissions={ADMIN}
      user={USER}
      legalIndexUrl={legalIndexUrl}
      // The Docs row is the CONTROL for the last case below, and since MOTIR-4167
      // it is conditional too — configured here so its presence is a fact about
      // the Legal row's absence and not about its own.
      docsIndexUrl="https://motir.co/docs"
    />,
  );
}

const legalRow = () => screen.queryByRole('link', { name: 'Legal' });
const docsRow = () => screen.queryByRole('link', { name: 'Docs' });

afterEach(() => {
  cleanup();
  pathname = '/dashboard';
});

describe('the Legal door in the app shell rail', () => {
  it('points at the CONFIGURED index — an absolute url, not a path', () => {
    renderRail('https://motir.co/legal');
    expect(legalRow()?.getAttribute('href')).toBe('https://motir.co/legal');
  });

  it('does NOT point at `/legal` — this application no longer serves it', () => {
    // The two-sided assertion the Docs door's test established: pinning the href
    // catches a re-point at the wrong surface, and refusing the old path catches
    // a revert to a route that will 404 the moment the deletion card lands.
    renderRail('https://motir.co/legal');
    expect(legalRow()?.getAttribute('href')).not.toBe('/legal');
  });

  it('renders NO ROW when nothing is configured', () => {
    renderRail(null);
    expect(legalRow()).toBeNull();
  });

  it('renders no row when the prop is OMITTED — it fails closed', () => {
    renderRail();
    expect(legalRow()).toBeNull();
  });

  it('leaves the rest of the section alone — the difference is exactly one row', () => {
    // Nothing else about the bottom section moves when the row goes: the
    // neighbouring doors keep their targets, which is what panel 14 draws by
    // putting the two rails side by side.
    renderRail(null);
    expect(docsRow()?.getAttribute('href')).toBe('https://motir.co/docs');
    expect(screen.getByRole('link', { name: 'Git' })).toBeTruthy();
  });
});
