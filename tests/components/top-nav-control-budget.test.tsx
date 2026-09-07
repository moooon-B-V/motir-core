// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, within, type RenderResult } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ThemeProvider } from '@/lib/contexts/theme-context';

// MOTIR-2373 — the top bar's CONTROL BUDGET below `md`
// (design/shell/design-notes.md § *The top bar's control budget*, MOTIR-2374).
//
// The bar carried eight controls, two of them labelled, and nothing said how
// much room was left. Measured on `origin/main`, the right cluster alone was
// 350px private / 409px public inside a 375px viewport, so the `min-w-0` left
// cluster was squeezed to zero and the right cluster painted over the hamburger:
// `elementFromPoint` at its centre returned the build-in-public megaphone.
//
// ── WHAT THIS FILE PROVES, AND WHAT IT DELIBERATELY DOES NOT ────────────────
// happy-dom has no layout engine, so nothing here can measure a pixel. What it
// CAN do — and what no browser test in the main E2E lane can — is render the bar
// with EVERY optional slot live at once, including `showPlanWithAi`, and pin the
// four rules the geometry follows from:
//
//   1. the below-`md` slot set is exactly four, each a `--height-control` square;
//   2. every other control is `hidden md:inline-flex`, so below `md` it is
//      `display: none` and contributes ZERO width — which is why the pill's
//      absence from the E2E lane costs the proof nothing;
//   3. the right cluster is `flex-none`, so it can no longer take width from the
//      left one;
//   4. labels and their `<kbd>` chips are gated TOGETHER at `lg`, which is what
//      closes the 640–767px band.
//
// The pixel half — `document.elementFromPoint` at the hamburger's centre at
// 375×812 AND 700×812, and the drawer strip the displaced controls land in — is
// `tests/e2e/cloud-top-bar-budget.spec.ts`, in a real browser against the real CSS.
//
// `showPlanWithAi` is UNREACHABLE in the main E2E lane by standing decision
// (`tests/e2e/ai-callout-gate.spec.ts` documents it and is that decision's
// regression guard), so the crowded state that includes the pill can only be
// rendered here, from props. That is the whole reason this file exists.

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
// The bar's islands reach for the router (UserMenu's sign-out, useGoPublic's
// post-mutation refresh, the bell's per-navigation poll). None of that is under
// test here; the class strings are.
const { navSearchParams } = vi.hoisted(() => ({ navSearchParams: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/dashboard',
  // MOTIR-4730 — the header's Plan-with-AI pill reads the address.
  useSearchParams: () => navSearchParams,
}));
// The tenancy-tier nav is the left cluster's elastic element and owns none of
// the budget; stubbing it keeps this file about the right cluster.
vi.mock('@/app/(authed)/_components/ShellTierNav', () => ({
  ShellTierNav: () => <nav data-testid="tier-nav">org / workspace</nav>,
}));
vi.mock('@/components/ui/SidebarToggle', () => ({
  SidebarToggle: () => <button data-testid="hamburger">menu</button>,
}));
// Every RIGHT-cluster control renders for real — their class strings ARE the
// budget. Only the modal the create/build-in-public buttons mount is stubbed,
// since a Radix dialog portal is not what this file is about.
vi.mock('@/app/(authed)/_components/CreateIssueModal', () => ({
  CreateIssueModal: () => null,
}));
vi.mock('@/app/(authed)/settings/project/members/_components/BuildInPublicDialog', () => ({
  BuildInPublicDialog: () => null,
}));

import { TopNav, type TopNavProps } from '@/app/(authed)/_components/TopNav';
import { CommandPaletteProvider } from '@/app/(authed)/_components/CommandPaletteProvider';
import { CreateIssueProvider } from '@/app/(authed)/_components/CreateIssueProvider';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';
import { ReportProvider } from '@/app/(authed)/_components/ReportProvider';

/** The bar's widest possible state — every optional slot switched on at once.
 *  `buildingInPublic` is the PUBLIC arm of the stateful build-in-public slot,
 *  the one the render measured at 409px; `buildInPublicProjectKey` is its
 *  mutually exclusive CTA arm, covered by `crowdedProps({ … })` below. */
function crowdedProps(overrides: Partial<TopNavProps> = {}): TopNavProps {
  return {
    activeOrg: null,
    orgs: [],
    workspaces: [],
    activeWorkspaceId: null,
    // The project half of the context path (MOTIR-2556). Null here: neither
    // file is about the tier nav — both stub it — so the bar's widest state is
    // still the one the RIGHT cluster produces.
    activeProject: null,
    projects: [],
    aiConfigured: false,
    user: { name: 'Zhu Yue', email: 'yue@example.com' },
    initialUnreadCount: 3,
    buildInPublicProjectKey: null,
    buildingInPublic: true,
    cloudBilling: false,
    showPlanWithAi: true,
    ...overrides,
  };
}

async function renderBar(overrides: Partial<TopNavProps> = {}): Promise<RenderResult> {
  const bar = await TopNav(crowdedProps(overrides));
  return renderWithIntl(
    <ThemeProvider>
      <CommandPaletteProvider>
        <CreateIssueProvider hasProject>
          <ProjectAccessProvider permissions={['work_item:edit', 'project:administer']}>
            <ReportProvider projectKey="ACME">{bar}</ReportProvider>
          </ProjectAccessProvider>
        </CreateIssueProvider>
      </CommandPaletteProvider>
    </ThemeProvider>,
  );
}

/** The right cluster — the `<nav>`'s second child. */
function rightCluster(container: HTMLElement): HTMLElement {
  const nav = container.querySelector('nav[aria-label]')!;
  return nav.children[1] as HTMLElement;
}

/** A class list carries a utility, matched as a whole token (so `md:inline-flex`
 *  never satisfies a check for `inline-flex`). */
function has(el: Element, utility: string): boolean {
  return el.className.split(/\s+/).includes(utility);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the top bar’s control budget below md (MOTIR-2373)', () => {
  it('carries exactly FOUR slots below md — palette, create, bell, avatar', async () => {
    // The budget is arithmetic: at the smallest supported viewport (320px),
    // 320 − 32 gutters − 36 hamburger − 8 − 8 gaps − 68 tier-nav floor = 168px,
    // and 168 = 4 × 36 + 3 × 8. So FOUR is the number, and it is asserted rather
    // than left to whoever adds the ninth control.
    const { container } = await renderBar();
    const visibleBelowMd = Array.from(rightCluster(container).children).filter(
      (el) => !has(el, 'hidden'),
    );

    expect(visibleBelowMd.map((el) => el.getAttribute('aria-label'))).toEqual([
      'Create work item',
      'Shortcut',
      'Notifications, 3 unread',
      'Account menu',
    ]);
  });

  it('gives each of the four slots the SAME --height-control square box', async () => {
    // Three box sizes coexisted before this — 28 / 36 / 38 — because the cluster
    // was squeezing its own fixed-`w-9` children below their height (the avatar's
    // `rounded-full` rendered as an ELLIPSE at 375px). A shape token also means
    // the square survives a `data-style` swap, which a raw `h-9` does not.
    const { container } = await renderBar();
    for (const slot of Array.from(rightCluster(container).children).filter(
      (el) => !has(el, 'hidden'),
    )) {
      expect(has(slot, 'h-(--height-control)'), `height: ${slot.getAttribute('aria-label')}`).toBe(
        true,
      );
      expect(has(slot, 'w-(--height-control)'), `width: ${slot.getAttribute('aria-label')}`).toBe(
        true,
      );
      expect(slot.className).not.toMatch(/\bh-9\b|\bw-9\b|p-\(--spacing-icon-btn\)/);
    }
  });

  it('REPLACES the display utility on every displaced control, never appends it', async () => {
    // `.hidden` and `.inline-flex` have equal specificity, so a control carrying
    // both is decided by whichever utility Tailwind emits LAST — `.hidden` comes
    // first, so it would LOSE and the control would stay in the bar. The gate has
    // to select the display utility, not add to it.
    const { container } = await renderBar();
    const displaced = Array.from(rightCluster(container).children).filter((el) =>
      has(el, 'hidden'),
    );

    expect(displaced.map((el) => el.getAttribute('aria-label'))).toEqual([
      'Plan with AI', // dropped below md — PlanWithAIFab is its phone-width door
      'Building in public — manage', // the build-in-public slot → the drawer strip
      'Report', // ReportButton → the drawer strip
      'Theme: System (light). Activate to change.', // ThemeToggle → the drawer strip
    ]);
    for (const el of displaced) {
      expect(has(el, 'md:inline-flex'), `${el.getAttribute('aria-label')} md gate`).toBe(true);
      expect(has(el, 'inline-flex'), `${el.getAttribute('aria-label')} bare display`).toBe(false);
    }
  });

  it('displaces the build-in-public CTA arm too, not just the indicator', async () => {
    // The slot is stateful in TWO dimensions now — state × breakpoint. Gating
    // only the arm the render happened to measure would leave the other one in
    // the bar, which is the same defect with a different tenant.
    const { container } = await renderBar({
      buildingInPublic: false,
      buildInPublicProjectKey: 'ACME',
    });
    const cta = within(rightCluster(container)).getByLabelText('Build in public');
    expect(has(cta, 'hidden')).toBe(true);
    expect(has(cta, 'md:inline-flex')).toBe(true);
    expect(has(cta, 'inline-flex')).toBe(false);
  });

  it('makes the right cluster flex-none, so it can no longer starve the left one', async () => {
    // This is the mechanism of the bug, not a tidy-up: the right cluster's
    // children are fixed-size boxes, so as a shrinkable flex item it took every
    // pixel it wanted and squeezed the `min-w-0` left cluster to zero — the
    // hamburger then rendered UNDERNEATH it, visible and untappable.
    const { container } = await renderBar();
    const nav = container.querySelector('nav[aria-label]')!;
    expect(has(rightCluster(container), 'flex-none')).toBe(true);
    expect(has(nav.children[0] as HTMLElement, 'min-w-0')).toBe(true);
  });

  it('gates every label and its <kbd> chip TOGETHER at lg, never at sm', async () => {
    // The 640–767px band is what this closes. At `sm` every label switched on at
    // once — the cluster jumped 350 → 656px inside a 640px viewport while the
    // hamburger was still mounted (`md:hidden` lives to 767px). Gating a label
    // without its chip is not a half-measure but a defect: an icon beside a bare
    // ⌘K chip has no label for the chip to attach to, and the chip overflows the
    // square box it no longer fits.
    const { container } = await renderBar();
    const gated = Array.from(rightCluster(container).querySelectorAll('span, kbd')).filter((el) =>
      has(el, 'hidden'),
    );

    expect(gated.length).toBeGreaterThan(0);
    for (const el of gated) {
      expect(has(el, 'lg:inline'), `${el.tagName} "${el.textContent}" gate`).toBe(true);
      expect(has(el, 'sm:inline'), `${el.tagName} "${el.textContent}" sm leftover`).toBe(false);
    }
    // Both halves of the ⌘K pair are present and both moved — a `<kbd>` left
    // behind on `sm:inline` is exactly the shape the assertion above catches.
    expect(gated.filter((el) => el.tagName === 'KBD')).toHaveLength(2);
  });

  it('leaves NO icon-only slot without an accessible name at any width', async () => {
    // Moving the label breakpoint from `sm` to `lg` widens the band in which
    // these buttons are icon-only, and their glyphs are all `aria-hidden`. A
    // control whose only name was its now-hidden label would announce as
    // "button" from 375px all the way to 1023px.
    const { container } = await renderBar();
    for (const control of rightCluster(container).children) {
      expect(control.getAttribute('aria-label'), control.outerHTML.slice(0, 120)).toBeTruthy();
    }
  });

  it('keeps the brand slot a md+ slot — MOTIR-1150’s guard is still load-bearing', async () => {
    // The budget does not give the brand a phone-width slot back: below `md` the
    // left cluster is hamburger + tier nav, and the 168px ceiling is computed
    // with no brand in it.
    const { container } = await renderBar();
    const brand = container.querySelector('a[href="/dashboard"]')!;
    expect(has(brand, 'hidden')).toBe(true);
    expect(has(brand, 'md:flex')).toBe(true);
  });

  it('records the ninth-control rule in TopNav’s own docstring', async () => {
    // The bar reached eight controls because nothing in the file said how much
    // room was left. Saying it out loud where the next control gets added is most
    // of what keeps this fixed — so the rule is pinned, not just written.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('app/(authed)/_components/TopNav.tsx', 'utf8'),
    );
    expect(source).toContain('CLOSED AT FOUR SLOTS');
    expect(source).toContain('`md`-and-up control by default');
    expect(source).toContain('utility strip — DRAWN, not cited');
  });
});
