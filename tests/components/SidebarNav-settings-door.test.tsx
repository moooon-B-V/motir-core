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
  archivedAt: null,
} as unknown as ProjectDTO;

const USER = { name: 'Yue', email: 'yue@example.com' };

const ADMIN = [...BUILTIN_ROLE_PERMISSIONS.admin];
const MEMBER = [...BUILTIN_ROLE_PERMISSIONS.member];
const VIEWER = [...BUILTIN_ROLE_PERMISSIONS.viewer];

function renderRail(
  permissions?: readonly PermissionKey[],
  project: ProjectDTO | null = PROJECT,
  workspaceTierRevealed = false,
) {
  return renderWithIntl(
    <SidebarNav
      activeProject={project}
      settingsPermissions={permissions}
      user={USER}
      workspaceTierRevealed={workspaceTierRevealed}
    />,
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
    // ⚠️ AMENDED TWICE, AND THE SECOND ONE EMPTIES THE SECTION (MOTIR-4847,
    // then MOTIR-4643). This once asserted a `Job runs` row and a `Git` row
    // survived beside the absent door. Both are gone now: the workspace rows
    // left with MOTIR-4847 — the capability is a row in the workspace area's own
    // rail above the reveal, and `JobRunsFoldInSection` on
    // `/settings/organization` below it — and `Git` left with MOTIR-4643, its
    // two actions carried to the org and the account tiers.
    //
    // So for a MEMBER the bottom section has no rows at all, and `SidebarNav`
    // renders no section rather than an empty container. Every row is asserted
    // ABSENT rather than the case being deleted, because the claim this test
    // makes — *nothing marks the gap* — is now about the whole section.
    expect(screen.queryByRole('link', { name: 'Job runs' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Git' })).toBeNull();
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

  // ⚠️ REMOVED (MOTIR-4873): 'with NO active project the row survives and
  // targets the settings HOME'. It asserted the `!hasProject` arm of the
  // settings door — `/settings/workspace` above the tier-reveal threshold,
  // `/settings/organization` at or below it (MOTIR-3502 · organization-tier
  // §6d) — for a reader with no active project.
  //
  // Every member is inside a project now (MOTIR-4870), so that arm is gone and
  // the door always deep-links to project settings. WHICH settings home a
  // workspace-tier reader reaches is unchanged and is still covered by the
  // org/workspace rows below; what this case tested was the branch, and the
  // branch is what the story removed.
  //
  // ⚠️ AND MOTIR-4843 RE-ADDED IT ON `main` WHILE THIS BRANCH WAS OPEN, in its
  // MOTIR-3502 form — `renderRail(undefined, null, true)` asserting
  // `/settings/workspace`, and `false` asserting `/settings/organization`. It is
  // dropped again HERE rather than merged, for the reason above and not because
  // of the conflict: `renderRail(..., null, ...)` passes `activeProject={null}`,
  // which is the state MOTIR-4870 removed. Keeping it would have re-armed a case
  // whose fixture the product can no longer produce. The section-absent guard
  // MOTIR-4847 added beside it is unrelated and is kept in full.

  it('⚠️ the section itself is ABSENT when its last row filters away (MOTIR-4847)', () => {
    // The empty arm `design/shell/rail-bottom-section.mock.html` draws: no
    // heading, no separator, no empty state — an empty CONTAINER is the failure
    // this guards, because `Sidebar` draws a separator between sections and one
    // above a row that is not there reads as a loading error rather than as
    // policy.
    //
    // ⚠️ AND THE ARM IS REACHABLE NOW — this case predicted its own failure and
    // was right. MOTIR-4847 left it saying: *`Git` is still an unconditional
    // member, so `bottomItems` is never empty; its removal is MOTIR-4643's, and
    // this asserts the CURRENT floor — the section present with `Git` alone —
    // which will FAIL, loudly and in the right file, on the day that row leaves
    // and the guard in `SidebarNav` starts carrying the weight it was written
    // for.*
    //
    // That day is this commit. `Git` left, a MEMBER holds no settings door, and
    // `bottomItems` is empty — so the guard fires and there is NO bottom
    // section. Re-measured to the arm the design draws, which is what the case
    // was for all along.
    const { container } = renderRail(MEMBER);
    // `Sidebar` wraps each section in its own div inside the scroll container
    // and draws the separator INSIDE that wrapper, so an empty section is
    // exactly "a wrapper with no rows" — which is what this walks for.
    const wrappers = [...(container.querySelector('.overflow-y-auto')?.children ?? [])];
    const rowsPerSection = wrappers.map((w) =>
      [...w.querySelectorAll('a')].map((a) => (a.textContent ?? '').trim()),
    );
    // No wrapper is EMPTY — the failure this guards is a container with a
    // separator and no rows…
    expect(rowsPerSection.filter((rows) => rows.length === 0)).toEqual([]);
    // …and the last section is the PRIMARY one, because the bottom section is
    // not rendered at all. `Codebase` is its final row (MOTIR-1768).
    expect(rowsPerSection.at(-1)?.at(-1)).toBe('Codebase');
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

// MOTIR-4368 — the door's `active:` predicate, driven in BOTH directions.
//
// The row is highlighted inside the settings area, EXCEPT where one of the four
// workspace-settings sub-routes that has a row of its own is current — so only
// one row ever reads current. That is five clauses (`/settings`, then a
// negation per sub-route), and a spec that only drives the positive side leaves
// four short-circuit arms unreached: the predicate would still read green with
// any one negation deleted, which is exactly the regression it exists to stop.
//
// So each case names the route AND asserts the count of current rows, because
// "this row is not current" is only half the contract — the other half is that
// the more specific row took the highlight rather than nobody having it.
describe('the settings door yields to a more specific workspace sub-route', () => {
  const current = () => settingsRow()?.getAttribute('aria-current') ?? null;

  /** Every row reading current, across the whole rail. */
  const currentRows = () =>
    screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');

  it('reads current at /settings — the settings home itself', () => {
    pathname = '/settings';
    renderRail(ADMIN, PROJECT, true);
    expect(current()).toBe('page');
    expect(currentRows()).toHaveLength(1);
  });

  it('⚠️ `/settings/workspace` no longer reaches this predicate AT ALL (MOTIR-4846)', () => {
    // ⚠️ THIS CASE WAS LEFT RED BY MOTIR-4846 AND CAUGHT HERE, ONE CARD LATE.
    // It was the second row of an `it.each` asserting the door reads CURRENT at
    // `/settings/workspace`, which was true while that route had no rail of its
    // own. MOTIR-4846 gave it one: `SidebarNav` now returns the workspace area's
    // Sidebar for any `isWorkspaceSettingsPath`, before a bottom section is
    // built — so there is no door here to read current, exactly as MOTIR-4710
    // made true for `/settings/organization` in the case below.
    //
    // It is REPLACED by its negation rather than deleted, for the reason that
    // case gives: "no bottom Settings row here" is the new contract, and
    // deleting the line would leave the change recorded nowhere. The premise it
    // lost is the same one the two `it.each` rows further down lost with
    // MOTIR-4847, which is why all three now read the same way.
    pathname = '/settings/workspace';
    renderRail(ADMIN, PROJECT, true);
    expect(settingsRow()).toBeNull();
  });

  it('⚠️ `/settings/organization` no longer reaches this predicate AT ALL (MOTIR-4710)', () => {
    // This route was a row in THIS list until organisation settings became an
    // AREA. It is now the third of three settings tiers with its own rail: the
    // door's `active` clause is never evaluated there, because `SidebarNav`
    // returns the organisation area's own Sidebar before it builds a bottom
    // section — exactly as it already did for `/settings/project*` and
    // `/settings/account*`.
    //
    // The case is REPLACED rather than deleted, because "no bottom Settings row
    // here" is the new contract and deleting the line would leave the change
    // recorded nowhere. The door's other four clauses are unaffected and still
    // exercised above and below.
    pathname = '/settings/organization';
    renderRail(ADMIN, PROJECT, true);
    expect(settingsRow()).toBeNull();
  });

  // ⚠️ THE GIT ROUTE MOVED A TIER (Story MOTIR-4669 · MOTIR-4680). It was
  // `/settings/workspace/{github,gitlab}`; both are deleted and permanently
  // redirect to `/settings/organization/git`, and the RAIL ROW follows the
  // surface rather than riding the redirect. The pair of workspace rows is
  // REPLACED by the org one rather than kept alongside it: a clause that yields
  // at a path nothing can navigate to is not a passing test, it is an untested
  // clause that still looks covered.
  // ⚠️ THE TABLE IS GONE, BECAUSE EVERY ROW IT YIELDED TO IS (MOTIR-4847, then
  // MOTIR-4643). It read `[security, Security] · [jobs, Job runs] · [org/git,
  // Git]` and asserted *the settings door stands down, and the more-specific row
  // takes the highlight*. `Security` and `Job runs` left with MOTIR-4847 — and
  // their two negation clauses left the predicate with them, deliberately:
  // `/settings/workspace/*` returns the workspace AREA's own Sidebar before this
  // section is ever built, so those clauses became doubly unreachable, and
  // MOTIR-4368's finding about this very predicate is that an unreachable clause
  // still READS as covered. `Git` left with MOTIR-4643.
  //
  // An `it.each([])` would pass while asserting nothing, so the claim is
  // re-stated as the thing that is now TRUE: there is no sub-route row left for
  // the door to yield to, and the predicate carries no clause pretending
  // otherwise.
  it('has no row left to yield to — every sub-route row left this section', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/(authed)/_components/SidebarNav.tsx', 'utf8');
    const door = src.slice(src.indexOf('const bottomItems'), src.indexOf('sections.push({ id:'));
    // The door's `active` predicate negates NOTHING now: there is nothing below
    // it in this section to be more specific than it.
    expect(door).not.toContain("!isActive(pathname, '/settings/workspace/security')");
    expect(door).not.toContain("!isActive(pathname, '/settings/workspace/jobs')");
    expect(door).not.toContain("!isActive(pathname, '/settings/organization/git')");
  });

  it.each([['/settings/workspace/security'], ['/settings/workspace/jobs']])(
    'renders no bottom section AT ALL on %s — the area branch answers first',
    (path) => {
      // The replacement for the deleted rows of the table above, and a stronger
      // claim than the one it replaces: not "the door stands down here" but
      // "this block never runs here". Driving it is what stops the deleted
      // clauses from being re-added later as a defensive extra.
      pathname = path;
      renderRail(ADMIN, PROJECT, true);
      expect(settingsRow()).toBeNull();
      expect(screen.queryByRole('link', { name: 'Git' })).toBeNull();
    },
  );

  it('reads current nowhere outside the settings area — the first clause', () => {
    pathname = '/dashboard';
    renderRail(ADMIN, PROJECT, true);
    expect(current()).toBeNull();
  });
});
