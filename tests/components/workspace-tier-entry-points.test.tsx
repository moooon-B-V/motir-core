// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { UserMenu } from '@/app/(authed)/_components/UserMenu';
import { ShellTierNav } from '@/app/(authed)/_components/ShellTierNav';
import {
  isWorkspaceTierRevealed,
  scopeWorkspacesToActiveOrg,
  WORKSPACE_TIER_REVEAL_MIN,
} from '@/lib/workspaces/tierDisclosure';

// §6d's SETTINGS COLLAPSE, at the entry points (MOTIR-3502 ·
// `docs/decisions/organization-tier.md` §6). Below the reveal threshold the
// product has not told the user the workspace tier exists, so nothing rendered
// may NAME `/settings/workspace`.
//
// The assertions are about the MARKUP, not about visibility — deliberately, and
// for the same reason `UserMenu-platform-door.test.ts` gives: `queryByRole`
// would also pass for a row rendered `hidden`, and the posture here is that the
// route is not named at all. The card states it as "the row is ABSENT, not
// disabled", which is `SidebarNav`'s own standing rule: an entry point is a
// promise about a room, and a disabled row is a promise the product then
// refuses.
//
// ⚠️ THE CARVE-OUT THIS COMMENT USED TO CARRY IS RETIRED (Story MOTIR-4843 ·
// MOTIR-4847). It read: `/settings/workspace/jobs` and
// `/settings/workspace/github` "are NOT covered by that rule and must keep
// rendering at every count — they are workspace-SCOPED but not workspace-NAMED".
// That was MOTIR-3502's AC 6, and it was the tell rather than the exception: a
// surface exempted from a hiding rule BECAUSE IT STILL ANSWERS is a surface that
// was never given a relocation. All three are now equally absent below the
// reveal — Git moved a tier (MOTIR-4680), Security folds in via
// `WorkspaceFoldInSection` (MOTIR-3502), and Job runs gained its own gate and
// `JobRunsFoldInSection` (MOTIR-4861).
//
// The href anchor below (`"/settings/workspace"` followed by a quote) is KEPT
// anyway, because it is the tighter assertion: it asks about the AREA's own
// door, which is the thing this file is named after.
//
// ⚠️ THE ACCOUNT MENU IS NO LONGER ONE OF THE ENTRY POINTS. `UserMenu` had the
// only `Workspace settings` row in the product and no longer has any conditional
// but `platformStaff`; the door is the workspace SWITCHER's now, and
// `ShellTierNav` renders that whole control only above the reveal — so the tier
// gate moved from a ROW to the CONTROL that carries it. The arrival is
// `WorkspaceSwitcher-settings-door.test.tsx`; the cases below are the departure,
// and they assert the absence at EVERY count rather than at one.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
}));
vi.mock('@/lib/auth/client', () => ({ signOut: vi.fn(async () => undefined) }));

afterEach(cleanup);

/** The area's OWN href, never one of its sub-routes. */
function namesTheWorkspaceArea(html: string): boolean {
  return html.includes('href="/settings/workspace"');
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
}

function workspace(id: string, organizationId: string) {
  return { id, name: `Workspace ${id}`, slug: id, organizationId };
}

describe('the reveal predicate', () => {
  it('reveals at the threshold and not below it', () => {
    expect(WORKSPACE_TIER_REVEAL_MIN).toBe(2);
    expect(isWorkspaceTierRevealed(0)).toBe(false);
    expect(isWorkspaceTierRevealed(1)).toBe(false);
    expect(isWorkspaceTierRevealed(2)).toBe(true);
    expect(isWorkspaceTierRevealed(9)).toBe(true);
  });

  it('counts the ACTIVE ORG only — two orgs of one workspace each stay collapsed', () => {
    // The trap the raw `listUserWorkspaces().length` would fall into: a user in
    // two single-workspace orgs has two workspaces and a CHOICE in neither.
    const mine = [workspace('a', 'org-1'), workspace('b', 'org-2')];
    expect(isWorkspaceTierRevealed(mine.length)).toBe(true); // the wrong number
    expect(isWorkspaceTierRevealed(scopeWorkspacesToActiveOrg(mine, 'org-1').length)).toBe(false);
    expect(isWorkspaceTierRevealed(scopeWorkspacesToActiveOrg(mine, 'org-2').length)).toBe(false);
  });

  it('leaves the list alone when no org resolves', () => {
    const mine = [workspace('a', 'org-1')];
    expect(scopeWorkspacesToActiveOrg(mine, null)).toEqual(mine);
  });
});

describe('the account menu, at EVERY workspace count', () => {
  // AMENDED, not deleted (MOTIR-4847). These cases used to be split across two
  // describes — one below the threshold asserting absence, one at it asserting
  // presence — because the row was reveal-gated. There is no threshold to
  // straddle any more: the row is gone at every count, and the menu takes no
  // workspace-count prop at all. Keeping the file's departure cases as ONE
  // unconditional block is the change; deleting them would leave the strongest
  // statement this story makes about the account menu recorded nowhere.

  it('renders no "Workspace settings" row', () => {
    renderWithIntl(<UserMenu name="Ada" email="ada@example.com" />);
    openMenu();
    expect(screen.queryByText('Workspace settings')).toBeNull();
  });

  it('leaves no /settings/workspace reference anywhere in the rendered markup', () => {
    // The href assertion, not the label one: a row relabelled but still pointing
    // at the area would pass the case above and fail this.
    const { container } = renderWithIntl(<UserMenu name="Ada" email="ada@example.com" />);
    openMenu();
    // The whole document, because the menu renders through a portal.
    expect(namesTheWorkspaceArea(document.body.innerHTML)).toBe(false);
    expect(namesTheWorkspaceArea(container.innerHTML)).toBe(false);
  });

  it('is true for a PLATFORM-STAFF menu too — the one conditional left changes nothing here', () => {
    // `platformStaff` is now the menu's only branch, so this is the whole of its
    // state space: if the row survived anywhere, it would be in the arm that
    // renders the most rows.
    renderWithIntl(<UserMenu name="Ops" email="ops@moooon.net" platformStaff />);
    openMenu();
    expect(namesTheWorkspaceArea(document.body.innerHTML)).toBe(false);
  });

  it('still offers Account settings — settings do not become unreachable', () => {
    renderWithIntl(<UserMenu name="Ada" email="ada@example.com" />);
    openMenu();
    expect(screen.getByText('Account settings')).toBeTruthy();
  });
});

describe('the shell tier nav', () => {
  const org = { id: 'org-1', name: 'Acme', role: 'owner' as const };

  it('hides the workspace switcher below the threshold', () => {
    const { container } = renderWithIntl(
      <ShellTierNav
        activeOrg={org}
        orgs={[]}
        workspaces={[workspace('a', 'org-1')]}
        activeWorkspaceId="a"
        cloudBilling={false}
      />,
    );
    expect(container.innerHTML).not.toContain('Workspace a');
  });

  it('shows it at the threshold', () => {
    const { container } = renderWithIntl(
      <ShellTierNav
        activeOrg={org}
        orgs={[]}
        workspaces={[workspace('a', 'org-1'), workspace('b', 'org-1')]}
        activeWorkspaceId="a"
        cloudBilling={false}
      />,
    );
    expect(container.innerHTML).toContain('Workspace a');
  });
});
