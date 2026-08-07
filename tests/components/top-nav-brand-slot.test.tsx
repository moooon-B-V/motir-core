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
    expect(order[1]!.getAttribute('aria-hidden')).toBe('true'); // the divider
    expect(order[2]!.querySelector('[data-testid="hamburger"]')).not.toBeNull();
    expect(order[3]!.getAttribute('data-testid')).toBe('tier-nav');
  });
});
