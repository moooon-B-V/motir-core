// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WAVE_BAND_PATH } from '@/components/brand/waveBand';

// MOTIR-1150 — the app shell's brand slot (design/brand/design-notes.md §7a).
//
// This is the ONE slot in the product where the mark stands alone, and that
// makes it the one slot where §8 files it as INFORMATIVE: with no wordmark
// beside it, the link's `aria-label` is the brand's only accessible name. Get
// that wrong and the shell's first focusable element announces as "link" — a
// defect nothing else on this card can catch, because every other surface has
// visible text to fall back on.
//
// TopNav's right cluster is a stack of client islands that each need their own
// provider (`useCreateIssue`, the notification poller, the command palette), so
// they are stubbed: this test is about the slot that was ADDED, its position and
// its name, not about re-testing the eight components beside it.

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock('@/app/(authed)/_components/ShellTierNav', () => ({
  ShellTierNav: () => <nav data-testid="tier-nav">org / workspace</nav>,
}));
vi.mock('@/components/ui/SidebarToggle', () => ({
  SidebarToggle: () => <button data-testid="hamburger">menu</button>,
}));
vi.mock('@/app/(authed)/_components/UserMenu', () => ({ UserMenu: () => <div /> }));
vi.mock('@/app/(authed)/_components/ThemeToggle', () => ({ ThemeToggle: () => <div /> }));
vi.mock('@/app/(authed)/_components/NotificationBell', () => ({ NotificationBell: () => <div /> }));
vi.mock('@/app/(authed)/_components/CommandPaletteTrigger', () => ({
  CommandPaletteTrigger: () => <div />,
}));
vi.mock('@/app/(authed)/_components/CreateIssueButton', () => ({
  CreateIssueButton: () => <div />,
}));
vi.mock('@/app/(authed)/_components/ReportButton', () => ({ ReportButton: () => <div /> }));
vi.mock('@/components/planning/PlanWithAILauncher', () => ({ PlanWithAILauncher: () => <div /> }));
vi.mock('@/app/(authed)/_components/build-in-public/BuildInPublicButton', () => ({
  BuildInPublicButton: () => <div />,
}));
vi.mock('@/app/(authed)/_components/build-in-public/BuildingInPublicHeaderLink', () => ({
  BuildingInPublicHeaderLink: () => <div />,
}));

import { TopNav } from '@/app/(authed)/_components/TopNav';

const props = {
  activeOrg: null,
  orgs: [],
  workspaces: [],
  activeWorkspaceId: null,
  // The project half of the context path (MOTIR-2556). Null here: this file is
  // about the BRAND slot, and the tier nav is stubbed.
  activeProject: null,
  projects: [],
  aiConfigured: false,
  user: { name: 'Zhu Yue', email: 'yue@example.com' },
  initialUnreadCount: null,
  buildInPublicProjectKey: null,
  buildingInPublic: false,
  cloudBilling: false,
  showPlanWithAi: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the shell brand slot (§7a)', () => {
  it('fills the slot this file’s docstring reserved, with the real mark', async () => {
    const { container } = render(await TopNav(props));
    const brand = container.querySelector('a[href="/dashboard"]')!;
    expect(brand.querySelector('path')!.getAttribute('d')).toBe(WAVE_BAND_PATH);
  });

  it('is MARK ONLY — a wordmark would read as a fourth level of context', async () => {
    // The left cluster already carries org › workspace as text. The brand sits
    // OUTSIDE that hierarchy, which is what the hairline divider says.
    const { container } = render(await TopNav(props));
    const brand = container.querySelector('a[href="/dashboard"]')!;
    expect(brand.textContent).toBe('');
    expect(container.querySelector('.brand-lockup')).toBeNull();
    expect(brand.querySelector('svg')!.getAttribute('width')).toBe('24');
  });

  it('carries the accessible name, because nothing else here can (§8)', async () => {
    const { container } = render(await TopNav(props));
    const brand = container.querySelector('a[href="/dashboard"]')!;
    expect(brand.getAttribute('aria-label')).toBe('topNav.brandHome');
    // The glyph stays hidden even though it is the only content: the LINK is
    // what carries the name, so exposing the svg as well would double it.
    expect(brand.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('link', { name: 'topNav.brandHome' })).toBeTruthy();
  });

  it('sits at the extreme left — before the mobile hamburger, not after it', async () => {
    // A NEW slot, not a substitution: `SidebarHeader` is project context and the
    // 8.3.1 renders established it has no room. Order is the whole point of §7a,
    // so it is asserted rather than eyeballed.
    const { container } = render(await TopNav(props));
    const cluster = container.querySelector('a[href="/dashboard"]')!.parentElement!;
    const order = Array.from(cluster.children);
    expect(order[0]!.tagName).toBe('A');
    // The hairline divider that used to sit here is GONE (MOTIR-2557): the
    // tile's own edge says what it said, and the 9px went back to a row that
    // measured 69px of slack. So the hamburger follows the mark directly.
    expect(order[1]!.querySelector('[data-testid="hamburger"]')).not.toBeNull();
    expect(order[2]!.getAttribute('data-testid')).toBe('tier-nav');
  });

  it('YIELDS to the hamburger below md — the slot is desktop-only', async () => {
    // Measured, not preferred — and STILL measured after MOTIR-2373 closed the
    // overflow this guard was originally written against. The bar's below-`md`
    // budget is four right-cluster slots against a 320px floor:
    // 320 − 32 gutters − 36 hamburger − 8 − 8 gaps − 68 tier-nav = 168px, with
    // no brand in the sum (design/shell design-notes.md § *The budget*). So the
    // left cluster below `md` is hamburger + tier nav, and the brand is a `md`+
    // slot by design rather than by deferral: deleting these two `md:` variants
    // spends 57px the budget has not allocated, pushing the hamburger from
    // x=16–52 to x=73–109 and re-breaking `shell-flows` and `settings-area` at
    // narrow width. Pinned here, not left as styling.
    //
    // The budget itself — the four slots, the `hidden md:inline-flex` gates on
    // the displaced controls, the `lg` label breakpoint — is
    // `top-nav-control-budget.test.tsx`; the hit-test is
    // `tests/e2e/top-bar-budget.spec.ts`.
    const { container } = render(await TopNav(props));
    const brand = container.querySelector('a[href="/dashboard"]')!;
    expect(brand.className).toContain('hidden');
    expect(brand.className).toContain('md:flex');
    // …and it is now a painted TILE rather than a bare glyph (MOTIR-2557). The
    // fill and its hairline ride the same element, so they inherit the same
    // `md` gate for free — there is no second element left to gate.
    expect(brand.className).toContain('bg-(--el-surface)');
    expect(brand.className).toContain('border-(--el-border)');
    // The hamburger keeps its own mirror-image breakpoint, so exactly one of the
    // two leads the cluster at any width.
    const hamburgerWrapper = container.querySelector('[data-testid="hamburger"]')!.parentElement!;
    expect(hamburgerWrapper.className).toContain('md:hidden');
  });
});
