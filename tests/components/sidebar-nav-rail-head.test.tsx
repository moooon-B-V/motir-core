// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ProjectDTO } from '@/lib/dto/projects';
import { renderWithIntl } from '../helpers/renderWithIntl';

// MOTIR-2556 — the rail's head gave the project up
// (`design/shell/design-notes.md` § *The rail head, after the project leaves*).
//
// This is the half of a MOVE that nothing else can see. The bar gaining a
// project tier is asserted by `shell-tier-nav.test.tsx`; that the rail STOPPED
// drawing one is asserted only here, and it is the assertion that matters
// later: if a future change re-adds a project header to the rail, everything
// still compiles, every other test still passes, and the product quietly draws
// the same control twice, in two visual languages, a hundred pixels apart —
// which is the state this story exists to end.
//
// So: the project control has exactly ONE host, and this file is the guard that
// says so from the side that no longer holds it.

let pathname = '/dashboard';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

import { SidebarNav } from '@/app/(authed)/_components/SidebarNav';

const PROJECT = {
  id: 'p1',
  identifier: 'MOTIR',
  name: 'Motir',
  archivedAt: null,
} as unknown as ProjectDTO;

const USER = { name: 'Yue', email: 'yue@example.com' };

afterEach(() => {
  cleanup();
  pathname = '/dashboard';
});

describe('the rail head, after the project left it (MOTIR-2556)', () => {
  it.each([
    ['rail', 'rail' as const],
    ['drawer', 'drawer' as const],
  ])('renders no project switcher in the %s', (_name, variant) => {
    renderWithIntl(<SidebarNav activeProject={PROJECT} variant={variant} user={USER} />);
    expect(screen.queryByRole('button', { name: 'Switch project' })).toBeNull();
  });

  it('renders no create-first door either — that state moved with the control', () => {
    renderWithIntl(<SidebarNav activeProject={null} user={USER} />);
    expect(screen.queryByRole('button', { name: 'Create your first project' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Switch project' })).toBeNull();
  });

  it('still renders the project-scoped nav — the rail kept its own job', () => {
    renderWithIntl(<SidebarNav activeProject={PROJECT} user={USER} />);
    expect(screen.getByRole('link', { name: 'Work Items' })).toBeTruthy();
  });

  it('keeps the SETTINGS area’s own header — only the project one left', () => {
    pathname = '/settings/project';
    renderWithIntl(
      <SidebarNav
        activeProject={PROJECT}
        settingsPermissions={['project:administer']}
        user={USER}
      />,
    );
    // the settings header names the project it is scoped to; it is a different
    // component (SettingsSidebarHeader) and this story does not touch it
    expect(screen.getAllByText('Motir').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Switch project' })).toBeNull();
  });
});
