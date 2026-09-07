// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { PROJECT_SETTINGS_ROUTES } from '@/lib/settings/projectSettingsNav';

// Subtask MOTIR-2468 — ⌘K is the same door with a different handle.
//
// The palette's settings block is BUILT FROM the registry (`visibleSettingsNav`
// over `PROJECT_SETTINGS_ROUTES`), never from a hand-kept list, which is what
// stops the rail and the palette from drifting apart: re-key an entry and both
// surfaces change together, by construction. These tests pin the consequence —
// no deep link an actor cannot use — and the structural property that makes it
// hold.

const { navSearchParams } = vi.hoisted(() => ({ navSearchParams: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
  // MOTIR-4730 — the palette's planning door reads the address.
  useSearchParams: () => navSearchParams,
}));
vi.mock('@/app/(authed)/_project-actions', () => ({
  setActiveProjectAction: vi.fn(async () => undefined),
}));
vi.mock('@/app/(authed)/_actions', () => ({ switchWorkspaceAction: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/client', () => ({ signOut: vi.fn(async () => undefined) }));
vi.mock('@/app/(authed)/_components/CommandPaletteProvider', () => ({
  useCommandPalette: () => ({ open: true, setOpen: vi.fn() }),
}));
vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({ openCreateIssue: vi.fn(), canCreate: false }),
}));
vi.mock('@/app/(authed)/_components/OnboardingResumeProvider', () => ({
  useOnboardingResume: () => false,
}));
vi.mock('@/lib/contexts/theme-context', () => ({
  useTheme: () => ({ pattern: 'light', setPattern: vi.fn() }),
}));

import { AppCommandPalette } from '@/app/(authed)/_components/AppCommandPalette';

const PROJECT = {
  id: 'proj_motir',
  workspaceId: 'ws_1',
  name: 'Motir',
  identifier: 'MOTIR',
  key: 'MOTIR',
  archivedAt: null,
} as unknown as ProjectDTO;

function renderPalette(settingsPermissions?: readonly PermissionKey[]) {
  return renderWithIntl(
    <AppCommandPalette
      workspaces={[]}
      activeWorkspaceId="ws_1"
      projects={[PROJECT]}
      activeProjectId={PROJECT.id}
      hasProject
      settingsPermissions={settingsPermissions}
    />,
  );
}

/**
 * The labels inside the palette's SETTINGS group only — scoped by its heading
 * (`settings.nav.eyebrow`), because the palette also carries project-nav actions
 * that share labels with settings entries ("Boards" is both a nav destination
 * and a settings section). Matching across the whole palette would report a
 * settings leak that is really the nav row.
 */
const offered = (): string[] => {
  const heading = screen.queryByText('Project settings');
  const list = heading?.nextElementSibling;
  if (!list) return [];
  return Array.from(list.querySelectorAll('[role="option"]'))
    .map((el) => el.textContent?.trim() ?? '')
    .filter(Boolean);
};

afterEach(cleanup);

describe('⌘K settings deep links follow the registry (MOTIR-2468)', () => {
  it('an ADMIN is offered every real settings route', () => {
    renderPalette([...BUILTIN_ROLE_PERMISSIONS.admin]);
    const labels = offered();
    for (const name of ['Details', 'Members & access', 'Boards', 'Rules']) {
      expect(
        labels.some((l) => l.includes(name)),
        name,
      ).toBe(true);
    }
  });

  it('a MEMBER is offered NO settings deep link', () => {
    renderPalette([...BUILTIN_ROLE_PERMISSIONS.member]);
    const labels = offered();
    for (const name of ['Details', 'Members & access', 'Boards', 'Rules', 'Roles & permissions']) {
      expect(
        labels.some((l) => l.includes(name)),
        `${name} leaked into the palette`,
      ).toBe(false);
    }
  });

  it('a PARTIAL role is offered exactly the sections it holds', () => {
    renderPalette(['project:browse', 'board:configure']);
    const labels = offered();
    expect(labels.some((l) => l.includes('Boards'))).toBe(true);
    expect(labels.some((l) => l.includes('Members & access'))).toBe(false);
  });

  it('an ABSENT prop defaults closed — a missing value never leaks a deep link', () => {
    renderPalette(undefined);
    const labels = offered();
    for (const name of ['Details', 'Members & access', 'Boards']) {
      expect(
        labels.some((l) => l.includes(name)),
        name,
      ).toBe(false);
    }
  });

  it('holds NO second copy of the settings list — it is generated from the registry', () => {
    // The structural half. A hand-kept list would let the two surfaces drift the
    // moment an entry is added or re-keyed; this asserts the source is the
    // registry itself.
    const source = readFileSync(
      join(process.cwd(), 'app/(authed)/_components/AppCommandPalette.tsx'),
      'utf8',
    );
    // A PREFIX since MOTIR-4243: the registry took a second axis (what this
    // BUILD has), so the call grew a third argument. The claim here is that the
    // palette reads the registry rather than keeping its own list — unchanged.
    expect(source).toContain('visibleSettingsNav(held, PROJECT_SETTINGS_ROUTES, {');
    // No settings route spelled out by hand anywhere in the palette.
    for (const entry of PROJECT_SETTINGS_ROUTES) {
      expect(source, `${entry.href} is hard-coded in the palette`).not.toContain(`'${entry.href}'`);
    }
  });
});
