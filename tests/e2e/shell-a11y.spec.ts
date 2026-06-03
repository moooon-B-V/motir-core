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
  {
    // Workflow editor (Subtask 2.2.5). Swept against a fresh project's default
    // seed (the six default statuses) — STRICT, zero exclusions: the category
    // Pills (todo/in_progress/done) are AA-safe (PRODECT_FINDINGS #35 resolved),
    // the transition matrix is a semantic <table> of aria-checkbox cells, the
    // policy control is a labelled aria-pressed segmented group.
    path: '/settings/project/workflow',
    ready: async (page) =>
      expect(page.getByRole('heading', { name: 'Workflow', exact: true })).toBeVisible(),
  },
  {
    // Operator dashboard (Subtask 1.6.5). Swept in its EMPTY state (a fresh
    // workspace has no job runs). Stays in the STRICT sweep with zero rule
    // exclusions, like every other shell route — and now that the colored Pill
    // tones meet WCAG AA (PRODECT_FINDINGS #35 resolved), the populated table's
    // status pills (succeeded/failed/running) pass color-contrast too.
    path: '/settings/workspace/jobs',
    ready: async (page) =>
      expect(page.getByRole('heading', { name: 'Job runs', exact: true })).toBeVisible(),
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

  // Create-issue modal (Subtask 2.3.3) + the Type/Parent pickers (2.3.4), swept
  // in their open state. STRICT, zero exclusions: Radix wires the dialog focus
  // trap + accessible name; each field has a label; the Combobox uses the
  // WAI-ARIA listbox-combobox shape (role="combobox" trigger → role="listbox" of
  // role="option" rows, aria-activedescendant). Swept twice — modal alone, then
  // with the Type listbox expanded — so the open listbox is audited too.
  test('the create-issue modal + type/parent pickers have zero axe violations (WCAG 2.1 AA)', async ({
    page,
  }) => {
    await signUp(page, 'e2e-create-issue-a11y@example.com');
    await createFirstProject(page, 'Mobile App');
    await page.goto('/issues');

    await page.getByRole('button', { name: 'Create issue' }).click();
    await expect(page.getByRole('heading', { name: 'Create issue' })).toBeVisible();

    const modalResults = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(
      modalResults.violations,
      formatViolations('/issues (create-issue modal)', modalResults.violations as AxeViolation[]),
    ).toEqual([]);

    // Open the Type picker so the expanded listbox is in the swept DOM.
    await page.getByRole('combobox', { name: 'Type' }).click();
    await expect(page.getByRole('listbox', { name: 'Type' })).toBeVisible();

    const listboxResults = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(
      listboxResults.violations,
      formatViolations('/issues (type picker open)', listboxResults.violations as AxeViolation[]),
    ).toEqual([]);
  });

  // The issue edit route (Subtask 2.3.6). Creates a project + an issue (via the
  // create modal, reading its identifier off the success toast), then sweeps the
  // /issues/[key]/edit page. STRICT — only the vendored `.w-md-editor` chrome is
  // excluded (the same third-party subtree 2.3.5 excludes; the form's own
  // controls + the Status/Parent/Assignee comboboxes are held to full AA).
  test('the issue edit route has zero axe violations (WCAG 2.1 AA; third-party editor chrome excluded)', async ({
    page,
  }) => {
    await signUp(page, 'e2e-edit-issue-a11y@example.com');
    await createFirstProject(page, 'Mobile App');

    await page.goto('/issues');
    await page.getByRole('button', { name: 'Create issue' }).click();
    await page.getByLabel('Title').fill('Editable issue');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    const toast = page.getByText(/ created$/);
    await expect(toast).toBeVisible();
    const identifier = ((await toast.textContent()) ?? '').replace(/ created$/, '').trim();
    expect(identifier).toMatch(/^[A-Z]+-\d+$/);

    await page.goto(`/issues/${identifier}/edit`);
    await expect(page.getByRole('heading', { name: 'Edit issue' })).toBeVisible();
    // Wait for the lazy MarkdownEditor to mount — until it does, its dynamic-
    // import fallback ("Loading editor…") is on screen, and that transient
    // placeholder would be swept. Once `.w-md-editor` is present the placeholder
    // is gone (and the editor chrome itself is excluded below).
    await expect(page.locator('.w-md-editor').first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .exclude('.w-md-editor')
      .analyze();
    expect(
      results.violations,
      formatViolations('/issues/[key]/edit', results.violations as AxeViolation[]),
    ).toEqual([]);
  });

  // /tokens is the public design-system specimen — not a shell-bearing route,
  // but it's where every primitive renders together, so an axe sweep here
  // catches regressions before they reach a real surface. Scanned without a
  // session (the route is public).
  //
  // `color-contrast` is excluded on the WHOLE-page sweep — but NOT for the Pill
  // anymore (PRODECT_FINDINGS #35 is fixed; the focused test below proves the
  // Pill matrix passes color-contrast). The exclusion now covers only genuine
  // SPECIMEN-DISPLAY artifacts that aren't product UI: tinted-surface Card demos
  // rendered with body copy to show the tint tokens, the tiny mono hex micro-
  // labels under each color swatch, and the raw `<pre>` code samples. Those are
  // documentation elements, not shipped surfaces, so they aren't held to AA
  // here. Every OTHER axe rule still guards the full page.
  test('the /tokens specimen route is axe-clean (WCAG 2.1 AA; color-contrast on specimen artifacts excluded)', async ({
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

  // The MarkdownEditor primitive specimen (Subtask 2.3.5). Renders every
  // variant (min / full / read-only) + the MarkdownView render path. Public,
  // no session.
  //
  // The `.w-md-editor` subtree is EXCLUDED: it's vendored third-party DOM from
  // @uiw/react-md-editor we don't own and won't fork. Its toolbar SVG icons set
  // role="img" without a per-svg title (svg-img-alt — but each toolbar BUTTON
  // carries an aria-label, so the controls are AT-usable), and its markdown
  // PREVIEW pane strips link underlines (link-in-text-block). Everything that
  // IS our code stays in the strict sweep: the page chrome, the editor's label
  // + status notice, and the standalone MarkdownView render path (whose links
  // keep their underline and pass link-in-text-block). This mirrors the /tokens
  // precedent of holding specimen/third-party artifacts to a narrower bar than
  // shipped product UI.
  //
  // `color-contrast` is excluded on the same basis as the /tokens sweep (the
  // syntax-highlight tints in the rendered sample are specimen display).
  test('the /tokens/markdown-editor specimen is axe-clean (WCAG 2.1 AA; third-party editor chrome excluded)', async ({
    page,
  }) => {
    await page.goto('/tokens/markdown-editor');
    await expect(page.getByRole('heading', { name: 'Markdown editor', level: 1 })).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .exclude('.w-md-editor')
      .disableRules(['color-contrast'])
      .analyze();
    expect(
      results.violations,
      formatViolations('/tokens/markdown-editor', results.violations as AxeViolation[]),
    ).toEqual([]);
  });

  // The actual subject of PRODECT_FINDINGS #35: the Pill `status`/`severity`
  // matrix. Scoped color-contrast sweep over JUST the Pill specimen section,
  // with the rule ENABLED — proves every colored tone clears WCAG AA now that
  // they use adaptive charcoal text on the hued tint (~10:1 both modes), and
  // guards against a future regression to hue-on-tint text.
  test('the Pill matrix passes color-contrast (WCAG 2.1 AA) — #35 fixed', async ({ page }) => {
    await page.goto('/tokens');
    await expect(page.locator('#primitives-pill')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .include('#primitives-pill')
      .analyze();
    expect(
      results.violations,
      formatViolations('/tokens#primitives-pill', results.violations as AxeViolation[]),
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
