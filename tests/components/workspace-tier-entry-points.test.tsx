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
// ⚠️ `/settings/workspace/jobs` and `/settings/workspace/github` are NOT covered
// by that rule and must keep rendering at every count — they are
// workspace-SCOPED but not workspace-NAMED, and §6 reveals a tier rather than
// relocating every page beneath it. That is why every assertion below is
// anchored on the exact string `"/settings/workspace"` followed by a quote,
// which a sub-route href does not match.

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

describe('the account menu BELOW the reveal threshold', () => {
  it('renders no "Workspace settings" row', () => {
    renderWithIntl(<UserMenu name="Ada" email="ada@example.com" workspaceTierRevealed={false} />);
    openMenu();
    expect(screen.queryByText('Workspace settings')).toBeNull();
  });

  it('leaves no /settings/workspace reference anywhere in the rendered markup', () => {
    const { container } = renderWithIntl(
      <UserMenu name="Ada" email="ada@example.com" workspaceTierRevealed={false} />,
    );
    openMenu();
    // The whole document, because the menu renders through a portal.
    expect(namesTheWorkspaceArea(document.body.innerHTML)).toBe(false);
    expect(namesTheWorkspaceArea(container.innerHTML)).toBe(false);
  });

  it('is the DEFAULT — omitting the prop hides the row', () => {
    // The omission has to fail CLOSED. The other default leaks a tier the
    // product is telling the user does not exist yet, from every caller that
    // forgets to thread the count.
    renderWithIntl(<UserMenu name="Ada" email="ada@example.com" />);
    openMenu();
    expect(screen.queryByText('Workspace settings')).toBeNull();
  });

  it('still offers Account settings — settings do not become unreachable', () => {
    renderWithIntl(<UserMenu name="Ada" email="ada@example.com" workspaceTierRevealed={false} />);
    openMenu();
    expect(screen.getByText('Account settings')).toBeTruthy();
  });
});

describe('the account menu AT the reveal threshold', () => {
  it('renders the row, pointing at the workspace area', () => {
    renderWithIntl(<UserMenu name="Ada" email="ada@example.com" workspaceTierRevealed />);
    openMenu();
    expect(screen.getByText('Workspace settings')).toBeTruthy();
    expect(namesTheWorkspaceArea(document.body.innerHTML)).toBe(true);
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
