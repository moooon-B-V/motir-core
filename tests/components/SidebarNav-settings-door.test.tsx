// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { renderWithIntl } from '../helpers/renderWithIntl';

// Subtask MOTIR-2468 — THE AREA DOOR, and the rail behind it (design panels 1
// and 2 of `design/projects/permission-gated-ui.mock.html`).
//
// The door is the case a per-entry filter does not cover on its own: filtering
// all twelve entries away leaves a perfectly valid EMPTY rail behind a perfectly
// valid link, which is a door onto a corridor. So the row renders only when the
// area has something behind it — and when it does not, NOTHING marks the gap:
// no disabled row, no tooltip, the rows below simply close up.

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
const MEMBER = [...BUILTIN_ROLE_PERMISSIONS.member];
const VIEWER = [...BUILTIN_ROLE_PERMISSIONS.viewer];

function renderRail(permissions?: readonly PermissionKey[], project: ProjectDTO | null = PROJECT) {
  return renderWithIntl(
    <SidebarNav activeProject={project} settingsPermissions={permissions} user={USER} />,
  );
}

const settingsRow = () => screen.queryByRole('link', { name: 'Settings' });

afterEach(() => {
  cleanup();
  pathname = '/dashboard';
});

describe('the Project settings door (design panel 1)', () => {
  it('an ADMIN gets the door, pointing into the project area', () => {
    renderRail(ADMIN);
    expect(settingsRow()?.getAttribute('href')).toBe('/settings/project');
  });

  it('a MEMBER gets NO door — and nothing marks the gap', () => {
    renderRail(MEMBER);
    expect(settingsRow()).toBeNull();
    // The decided treatment: no disabled stand-in, no "ask an admin" row. The
    // footer is simply one row shorter, so the rows below close up.
    expect(screen.queryByText('Settings')).toBeNull();
    expect(screen.getByRole('link', { name: 'Job runs' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Docs' })).toBeTruthy();
  });

  it('a VIEWER gets no door either', () => {
    renderRail(VIEWER);
    expect(settingsRow()).toBeNull();
  });

  it('ONE administrative key is enough to earn the door', () => {
    renderRail(['project:browse', 'board:configure']);
    expect(settingsRow()?.getAttribute('href')).toBe('/settings/project');
  });

  it('`project:browse` alone earns NO door — every actor in this shell holds it', () => {
    renderRail(['project:browse']);
    expect(settingsRow()).toBeNull();
  });

  it('an ABSENT prop defaults closed — a missing value never leaks a door', () => {
    renderRail(undefined);
    expect(settingsRow()).toBeNull();
  });

  it('with NO active project the row survives and still targets workspace settings', () => {
    // Untouched by this story: workspace settings are governed by the workspace
    // role, and `settingsPermissions` is empty in this state anyway — gating on
    // it would hide a door this story has no business touching.
    renderRail(undefined, null);
    expect(settingsRow()?.getAttribute('href')).toBe('/settings/workspace');
  });
});

describe('the settings rail inside the area (design panel 2)', () => {
  it("an ADMIN's rail carries every entry, in its shipped groups", () => {
    pathname = '/settings/project';
    renderRail(ADMIN);
    for (const label of [
      'Details',
      'Repositories',
      'Members & access',
      'Roles & permissions',
      'Code access',
      'Workflow',
      'Boards',
      'Estimation',
      'Fields',
      'Components',
      'AI planning',
      'Rules',
    ]) {
      expect(screen.getByRole('link', { name: label }), label).toBeTruthy();
    }
  });

  it('a PARTIAL role gets only its own entries, and no heading for a group that emptied', () => {
    pathname = '/settings/project/board';
    renderRail(['project:browse', 'board:configure', 'estimation:manage']);

    expect(screen.getByRole('link', { name: 'Boards' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Estimation' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Members & access' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Details' })).toBeNull();

    // The panel-2 failure this prevents: a heading above zero rows, which reads
    // as a loading error rather than as policy.
    expect(screen.getByText('Work')).toBeTruthy();
    for (const emptied of ['General', 'Access', 'Automation']) {
      expect(screen.queryByText(emptied), emptied).toBeNull();
    }
  });
});
