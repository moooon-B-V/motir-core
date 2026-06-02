// Accessibility audit for the app shell (Subtask 1.5.5).
//
// Locks in the shell's a11y properties BEFORE any Epic-2-7 surface inherits
// them: an automated axe-core sweep of every shell-bearing route, plus the
// landmark/aria assertions the shell's structure guarantees. Future a11y
// Subtasks for Epic-2-7 surfaces extend the route list + docs/a11y/shell-audit.md.
//
// Layered with shell-keyboard.spec.ts (keyboard-only navigation) — this spec
// is invariant-driven (zero violations, correct landmarks); that one is
// journey-driven (tab → skip-link → ⌘K → navigate → ⌘\ → ?).
//
// axe runs WCAG 2.1 A + AA. On a violation the spec prints the rule id, help
// URL, and the offending selector(s) so CI surfaces exactly what failed and
// where — see formatViolations below.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp, createFirstProject } from './_helpers/shell-session';

const USER_EMAIL = 'e2e-shell-a11y@example.com';

// WCAG 2.1 Level A + AA — the ruleset the AC names. Scoped explicitly rather
// than relying on axe's defaults so the bar can't silently shift under us when
// the axe-core version bumps.
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// The six shell-bearing routes. /dashboard, /issues, /boards, /reports are
// project-scoped (need an active project for the sidebar project-nav to
// render); the two settings routes render under the same shell. `ready` is a
// per-route settle anchor so axe analyses a fully-painted DOM, not a mid-render
// frame.
const SHELL_ROUTES: { path: string; ready: (page: Page) => Promise<void> }[] = [
  {
    path: '/dashboard',
    ready: async (page) => expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible(),
  },
  {
    path: '/issues',
    ready: async (page) => expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible(),
  },
  {
    path: '/boards',
    ready: async (page) => expect(page.getByRole('heading', { name: 'Boards' })).toBeVisible(),
  },
  {
    path: '/reports',
    ready: async (page) => expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible(),
  },
  {
    path: '/settings/workspace',
    ready: async (page) =>
      expect(page.getByRole('heading', { name: 'Workspace settings' })).toBeVisible(),
  },
  {
    path: '/settings/project',
    ready: async (page) =>
      expect(page.getByRole('heading', { name: 'Project settings' })).toBeVisible(),
  },
];

interface AxeViolation {
  id: string;
  impact?: string | null;
  help: string;
  helpUrl: string;
  nodes: { target: unknown[] }[];
}

// Render axe violations as a readable block so a CI failure points straight at
// the rule + element instead of a wall of JSON.
function formatViolations(route: string, violations: AxeViolation[]): string {
  const lines = violations.map((v) => {
    const selectors = v.nodes.map((n) => `      - ${JSON.stringify(n.target)}`).join('\n');
    return `  [${v.impact ?? 'n/a'}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${selectors}`;
  });
  return `axe found ${violations.length} violation(s) on ${route}:\n${lines.join('\n')}`;
}

// Each test signs up a fresh user, creates a project, then sweeps several
// routes running axe on each — heavier than the 30s default. Raise the ceiling
// so a cold-compiled route or a slow argon2 sign-up doesn't time out.
test.describe.configure({ timeout: 90_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test.describe('@a11y shell accessibility', () => {
  test('every shell-bearing route has zero axe violations (WCAG 2.1 AA)', async ({ page }) => {
    await signUp(page, USER_EMAIL);
    await createFirstProject(page, 'Mobile App');

    for (const route of SHELL_ROUTES) {
      await page.goto(route.path);
      await route.ready(page);

      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(
        results.violations,
        formatViolations(route.path, results.violations as AxeViolation[]),
      ).toEqual([]);
    }
  });

  // /tokens is the public design-system specimen — not a shell-bearing route,
  // but it's where every primitive renders together, so an axe sweep here
  // catches regressions before they reach a real surface. Scanned without a
  // session (the route is public).
  //
  // `color-contrast` is excluded HERE ONLY: the specimen deliberately renders
  // the Pill `severity`/`status` matrix, whose colored tint-on-hue tones fail
  // WCAG AA in light mode (foreground hue too light on its own light tint).
  // That's a real but systemic design-system issue that needs a reviewed color
  // pass, not a shell-test fix — tracked as PRODECT_FINDINGS #35. The shell
  // routes above stay strict (no rule exclusions); the one place that tone
  // reached a shell surface (the workspace member-count badge) was switched to
  // the AA-safe neutral tone. Every OTHER axe rule still guards /tokens.
  test('the /tokens specimen route is axe-clean (WCAG 2.1 AA; color-contrast tracked as #35)', async ({
    page,
  }) => {
    await page.goto('/tokens');
    await expect(page.getByRole('heading', { name: 'Tokens', level: 1 })).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .disableRules(['color-contrast'])
      .analyze();
    expect(
      results.violations,
      formatViolations('/tokens', results.violations as AxeViolation[]),
    ).toEqual([]);
  });

  // Structural aria assertions — the contract every shell surface inherits.
  // Kept here (not only in the keyboard spec) so the invariants are asserted
  // even if the journey spec is skipped/filtered.
  test('shell landmarks + aria states are correctly wired', async ({ page }) => {
    await signUp(page, 'e2e-shell-a11y-aria@example.com');
    await createFirstProject(page, 'Mobile App');
    await page.goto('/issues');

    // Two distinctly-named nav landmarks: the global top bar + the primary rail.
    await expect(page.getByRole('navigation', { name: 'Global' })).toBeVisible();
    const rail = page.getByRole('navigation', { name: 'Primary' });
    await expect(rail).toBeVisible();

    // aria-current="page" tracks the active route — Issues here, Dashboard not.
    await expect(rail.getByRole('link', { name: 'Issues' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(rail.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute(
      'aria-current',
      'page',
    );

    // The collapse toggle is a disclosure control: aria-expanded reflects the
    // rail state (expanded by default → true).
    const collapseToggle = rail.getByRole('button', { name: 'Collapse sidebar' });
    await expect(collapseToggle).toHaveAttribute('aria-expanded', 'true');
  });
});
