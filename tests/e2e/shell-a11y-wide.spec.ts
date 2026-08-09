// Accessibility audit — the routes the sweep never visited, POPULATED
// (MOTIR-2482).
//
// WHY THIS FILE EXISTS. `shell-a11y.spec.ts` is strict where it looks — real
// axe, WCAG 2.1 A+AA, zero rule exclusions — and it was green while 262
// measured `--el-text-faint` / `--el-text-muted` contrast defects sat on
// `main`. Crossing the 134 files carrying one of those defects against the
// routes the sweeps actually `goto` explained it, twice over:
//
//   • 108 of the 134 sit on routes NO sweep loads — `app/(public)` (the docs
//     catalogue, `/explore`, `/p/[identifier]`), `/backlog`, `/triage`,
//     `/settings/account`, `/settings/organization`, and more;
//   • the remaining 26 sit on a swept route and STILL pass, because
//     `SHELL_ROUTES` sweeps a fresh user with an EMPTY project. The `/items`
//     entry waits for "No work items yet"; the faint ink lives on a populated
//     row's timestamp, a "Showing N of M" tail, a menu section label — DOM the
//     empty sweep never renders.
//
// So this file widens BOTH arms: the unswept areas, and a POPULATED fixture on
// every route it adds. Nothing here is a new kind of check — same `WCAG_TAGS`,
// same `formatViolations` reporting as the three sibling files. It is the same
// sweep pointed at more of the product. Two routes carry a NAMED, single-rule
// carve-out citing the card that removes it (see "WHAT WIDENING FOUND" below —
// it was three until MOTIR-2495 landed and removed its own); every other route
// runs with zero exclusions, and no rule is disabled anywhere without a bug key
// beside it.
//
// A FOURTH file rather than more entries in `shell-a11y.spec.ts`: the @a11y CI
// leg shards by FILE (see the split rationale in shell-a11y.spec.ts's header
// and ci.yml's `--grep "@a11y"` leg), so a new file keeps the leg divisible.
// Companions: shell-a11y.spec.ts (shell routes + core CRUD + aria),
// shell-a11y-tokens.spec.ts (public /tokens specimens), shell-a11y-detail.spec.ts
// (the populated issue detail/comments/activity/attachments sweeps). Shared axe
// helpers in _helpers/a11y.
//
// WHAT THIS FILE STILL DOES NOT COVER, named rather than silently omitted (the
// `.exclude('.ProseMirror')` mould — an uncovered surface should be readable
// here, not inferred from the absence of a `goto`):
//   • `(onboarding)` — its panes are reached by COMPLETING the entrance flow,
//     whose steps are a multi-turn AI conversation the a11y fixture cannot
//     stand up deterministically. It needs a fixture story of its own, not a
//     route appended here.
//   • `/code-health`, `/plans`, `/ready`, `/filters` and `components/planning`
//     — each renders only against a connected GitHub App installation, an
//     AI-planning session, or a saved-filter fixture. They are reachable, but
//     each needs its own seed; appending them to this file would make one test
//     own five unrelated fixtures.
//   • `/settings/organization/billing` — cloud-only (`MOTIR_CLOUD`), and the
//     E2E webServer runs OFF-cloud, so the route does not render here at all.
// Those are gaps, not passes. Nothing below asserts otherwise.
//
// WHAT WIDENING FOUND, and where each defect went. Six of the eight routes
// added here were red on the first run — the coverage gap was not theoretical:
//   • FIXED IN THIS PR (the `--el-text-*` contrast arm this card owns) — the
//     /explore hero list and rank tabs, the public banner's view-only note, the
//     brand lockup's "on" prefix, and the docs catalogue's nine eyebrows. Each
//     is muted-or-fainter ink on a non-white surface: the MOTIR-2477 class,
//     surviving on routes its sweep never reached. Two of them were invisible
//     to the MOTIR-2459 AST guard by construction — `.brand-pre` declares its
//     colour in `globals.css` rather than a JSX class literal, and
//     `--el-text-eyebrow` is a distinct token NAME mapped to muted's Tier-0
//     base. A guard that reads class literals cannot see either, which is
//     precisely why a rendered sweep is the second mechanism and not a
//     duplicate of the first.
//   • FILED, NOT ABSORBED (the AC's other arm) — MOTIR-2493 (/backlog's
//     `role="row"` inside `role="list"`, two CRITICAL violations), MOTIR-2494
//     (/docs code panes unreachable by keyboard), MOTIR-2495 (a disabled
//     Input's `opacity-50` compositing its affix below AA — a contrast RULE
//     whose cause is not an ink choice, so no ink fixes it). Each has a NAMED
//     carve-out below citing its card, and each of those cards removes its own
//     carve-out. A carve-out here is a tracked gap, never a silent one.
//     MOTIR-2495 has since done exactly that: the shared `Input` now expresses
//     `disabled` and `readOnly` through `--el-input-*` fills rather than an
//     opacity filter, so /settings/organization is swept with no exclusion at
//     all and only the two role/keyboard carve-outs remain.
//   • CLEAN on the first run — /triage and /settings/account.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { WCAG_TAGS, formatViolations, type AxeViolation } from './_helpers/a11y';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { triageService } from '@/lib/services/triageService';
import { signIn } from './_helpers/shell-session';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Each test seeds a real fixture then runs four axe sweeps against
// server-rendered routes — heavier than the 30s default, in the mould of the
// sibling a11y files.
test.describe.configure({ timeout: 120_000 });

const SEED_PASSWORD = 'a11y-wide-spec-pass-123';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

interface Tenant {
  ctx: ServiceContext;
  projectId: string;
  projectKey: string;
  ownerId: string;
}

/** Stand a tenant up SERVER-SIDE through the shipped services (the sanctioned
 *  test cross-layer reach, as backlog-seed / roles-permissions-seed do) and pin
 *  the project active — every route swept below is active-project-scoped or
 *  reads the project by key. Server-side because the fixture is a PRECONDITION
 *  here, not the surface under test; the browser's only job is to render. */
async function seedTenant(input: {
  email: string;
  name: string;
  workspaceName: string;
  projectName: string;
  projectKey: string;
}): Promise<Tenant> {
  const owner = await usersService.createUser({
    email: input.email,
    password: SEED_PASSWORD,
    name: input.name,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: input.workspaceName,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: input.projectName,
    identifier: input.projectKey,
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return {
    ctx: { userId: owner.id, workspaceId: workspace.id },
    projectId: project.id,
    projectKey: project.identifier,
    ownerId: owner.id,
  };
}

/** Sweep one route STRICT — the same `WCAG_TAGS` `SHELL_ROUTES` uses, zero
 *  exclusions unless a `carveOut` naming its bug card is passed, reported
 *  through the shared formatter.
 *
 *  COLLECTS rather than asserts, and the test asserts the collection at the end
 *  (`expectClean`). `SHELL_ROUTES` asserts per route inside its loop, which
 *  stops at the FIRST red route and hides every route after it — the same
 *  shape of partial signal this card exists to remove, one level down. A run
 *  here reports every route it swept, so one red route never masks four
 *  unmeasured ones. The route label still rides each message, so a CI failure
 *  still names exactly which route and which rule. */
async function sweep(
  page: Page,
  label: string,
  into: string[],
  /** A NAMED carve-out for a defect this sweep found and filed as its own bug
   *  (the AC: a defect that is not an `--el-text-*` contrast failure is logged,
   *  not absorbed). Each entry MUST cite the card that removes it — that key is
   *  what turns a rule exclusion from an unexplained gap into a tracked one. */
  carveOut?: { disableRules?: string[]; excludeSelectors?: string[] },
): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (carveOut?.disableRules) builder = builder.disableRules(carveOut.disableRules);
  for (const selector of carveOut?.excludeSelectors ?? []) builder = builder.exclude(selector);
  const results = await builder.analyze();
  if (results.violations.length > 0) {
    into.push(formatViolations(label, results.violations as AxeViolation[]));
  }
}

/** Assert every route swept in this test was clean, reporting all of them. */
function expectClean(reports: string[]): void {
  expect(reports, `\n${reports.join('\n\n')}`).toEqual([]);
}

test.describe('@a11y widened route coverage', () => {
  // The AUTHED areas no sweep has ever loaded — /backlog, /triage,
  // /settings/account, /settings/organization — each against a POPULATED
  // fixture rather than a fresh project. The population is the point, not a
  // nicety: /backlog's ranked rows and /triage's queue both render a relative
  // TIMESTAMP per row (`issueCellPrimitives` / `TriageRow`) and /triage groups
  // its queue under `SectionLabel` section labels (`TriageQueue`) — the three
  // shapes named in the finding as the DOM an empty sweep never renders.
  test('the unswept authed routes are axe-clean with a POPULATED project (WCAG 2.1 AA; strict)', async ({
    page,
  }) => {
    const email = 'e2e-a11y-wide-authed@example.com';
    const tenant = await seedTenant({
      email,
      name: 'Ada Wide',
      workspaceName: 'Wide Sweep Workspace',
      projectName: 'Wide Sweep',
      projectKey: 'WIDE',
    });

    // A backlog with real content: a parent epic + children across kinds,
    // statuses, assignee and due date, so the rows carry colored status Pills,
    // an avatar, an estimate and a relative timestamp — not an empty state.
    const epic = await workItemsService.createWorkItem(
      { projectId: tenant.projectId, kind: 'epic', title: 'Checkout revamp' },
      tenant.ctx,
    );
    await workItemsService.createWorkItem(
      {
        projectId: tenant.projectId,
        kind: 'story',
        title: 'Guest checkout',
        parentId: epic.id,
        assigneeId: tenant.ownerId,
      },
      tenant.ctx,
    );
    const task = await workItemsService.createWorkItem(
      { projectId: tenant.projectId, kind: 'task', title: 'Wire the payment intent' },
      tenant.ctx,
    );
    await workItemsService.updateStatus(task.id, 'in_progress', tenant.ctx);
    await workItemsService.updateWorkItem(
      task.id,
      { priority: 'high', assigneeId: tenant.ownerId, dueDate: '2026-09-01T00:00:00.000Z' },
      tenant.ctx,
    );
    const bug = await workItemsService.createWorkItem(
      { projectId: tenant.projectId, kind: 'bug', title: 'Totals round the wrong way' },
      tenant.ctx,
    );
    await workItemsService.updateWorkItem(bug.id, { priority: 'lowest' }, tenant.ctx);

    // A populated TRIAGE queue — two submissions through the shipped intake
    // service, so the queue renders its grouped rows (section label + per-row
    // relative timestamp + submitter attribution) instead of its empty state.
    await triageService.createSubmission(
      {
        projectKey: tenant.projectKey,
        kind: 'bug',
        title: 'Cannot upload an avatar over 2 MB',
        descriptionMd: 'The upload spins and never resolves.',
      },
      tenant.ctx,
    );
    await triageService.createSubmission(
      { projectKey: tenant.projectKey, kind: 'task', title: 'Add a dark-mode toggle' },
      tenant.ctx,
    );

    await signIn(page, email, SEED_PASSWORD);
    const reports: string[] = [];

    // ── /backlog — populated, ranked rows ────────────────────────────────────
    await page.goto('/backlog');
    await expect(page.getByRole('heading', { name: 'Backlog', level: 1 })).toBeVisible();
    // The backlog region is a CLIENT island fetching /api/backlog; wait for a
    // seeded row so axe analyses the populated list, not the loading frame.
    await expect(page.getByText('Wire the payment intent')).toBeVisible();
    // CARVE-OUT — MOTIR-2493. Every backlog row is `role="row"` inside a
    // `role="list"` viewport, so `aria-required-children` and
    // `aria-required-parent` both fail CRITICAL on a populated backlog. It is
    // not an `--el-text-*` contrast failure, so it is filed rather than
    // absorbed here; MOTIR-2493 fixes the role composition and DELETES these
    // two lines. Everything else on the route — contrast included — is swept.
    await sweep(page, '/backlog (populated)', reports, {
      disableRules: ['aria-required-children', 'aria-required-parent'],
    });

    // ── /triage — populated queue ────────────────────────────────────────────
    await page.goto('/triage');
    await expect(page.getByRole('heading', { name: 'Triage', level: 1 })).toBeVisible();
    await expect(page.getByText('Cannot upload an avatar over 2 MB')).toBeVisible();
    await sweep(page, '/triage (populated)', reports);

    // ── /settings/account — the area root REDIRECTS to its first pane
    //    (Language & region); `goto` follows it, and the anchor is the pane's
    //    own heading. ───────────────────────────────────────────────────────
    await page.goto('/settings/account');
    await page.waitForURL('**/settings/account/language');
    await expect(page.getByRole('heading', { name: 'Language & region' })).toBeVisible();
    await sweep(page, '/settings/account (→ /language)', reports);

    // ── /settings/organization ───────────────────────────────────────────────
    await page.goto('/settings/organization');
    await expect(
      page.getByRole('heading', { name: 'Organization settings', level: 1 }),
    ).toBeVisible();
    // Zero exclusions since MOTIR-2495 — the org-URL field is `readOnly` rather
    // than `disabled`, and the shared `Input` draws both non-editable states
    // with `--el-input-*` fills instead of an opacity filter, so its
    // `motir.co/` affix is measured against a real pair again.
    await sweep(page, '/settings/organization', reports);

    expectClean(reports);
  });

  // The PUBLIC surfaces — swept with NO session at all, which is how a visitor
  // and a crawler reach them, and populated so the square's cards and the
  // public work-item tree render real content (a card's relative "active"
  // timestamp, the tree's "Showing N of M" tail) rather than empty states.
  // The fixture is seeded entirely server-side, so this browser context never
  // signs in and the pages are audited exactly as an anonymous visitor gets
  // them.
  test('the public routes are axe-clean with no session and a POPULATED square (WCAG 2.1 AA; strict)', async ({
    page,
  }) => {
    const tenant = await seedTenant({
      email: 'e2e-a11y-wide-public@example.com',
      name: 'Bo Wide',
      workspaceName: 'Public Sweep Workspace',
      projectName: 'Open Roadmap',
      projectKey: 'OPEN',
    });

    const reports: string[] = [];

    // Flip the project PUBLIC — the ONE filter the square and the /p/[key]
    // portal read (`accessLevel = 'public'`). Written directly because the
    // make-public JOURNEY is public-project-flow.spec.ts's subject; here it is
    // fixture state, and driving the confirm dialog would add a surface this
    // test does not audit.
    await db.project.update({
      where: { id: tenant.projectId },
      data: { accessLevel: 'public', publicTagline: 'What we are building, in the open.' },
    });

    // Enough items that the portal's tree renders rows AND its count tail.
    for (const title of [
      'Dark mode for the dashboard',
      'Export the board to CSV',
      'Keyboard shortcuts for navigation',
    ]) {
      await workItemsService.createWorkItem(
        { projectId: tenant.projectId, kind: 'task', title },
        tenant.ctx,
      );
    }

    // ── /explore — the project square, populated gallery ─────────────────────
    await page.goto('/explore');
    await expect(
      page.getByRole('heading', { name: /^Explore public project plans/ }),
    ).toBeVisible();
    await expect(page.getByText('Open Roadmap').first()).toBeVisible();
    await sweep(page, '/explore (populated square)', reports);

    // ── /docs — a PERMANENT redirect to /docs/api (next.config.ts), which is
    //    the catalogue's entry pane; `goto` follows it. ────────────────────
    await page.goto('/docs');
    await page.waitForURL('**/docs/api');
    await expect(page.getByRole('heading', { name: 'API reference', level: 1 })).toBeVisible();
    // CARVE-OUT — MOTIR-2494. Every code pane in the reference is a scrollable
    // region with nothing focusable in it, so `scrollable-region-focusable`
    // fails on 20+ nodes. Not a contrast failure, so filed rather than
    // absorbed; MOTIR-2494 fixes the shared code block and DELETES this line.
    // The catalogue's eyebrow contrast — the other defect this route surfaced
    // — WAS an `--el-text-*` failure and is fixed in this PR, so
    // `color-contrast` stays on here.
    await sweep(page, '/docs (→ /docs/api)', reports, {
      disableRules: ['scrollable-region-focusable'],
    });

    // ── /p/[identifier] — the public project overview ────────────────────────
    await page.goto(`/p/${tenant.projectKey}`);
    await expect(page.getByRole('heading', { name: 'Open Roadmap', level: 1 })).toBeVisible();
    await sweep(page, '/p/[identifier] (overview)', reports);

    // ── /p/[identifier]/items — the public work-item projection, whose tail is
    //    the literal "Showing N of M" the finding named. ────────────────────
    await page.goto(`/p/${tenant.projectKey}/items`);
    await expect(page.getByRole('heading', { name: 'Work items', level: 1 })).toBeVisible();
    await expect(page.getByText('Export the board to CSV').first()).toBeVisible();
    await sweep(page, '/p/[identifier]/items (populated)', reports);

    expectClean(reports);
  });
});
