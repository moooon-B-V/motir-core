// E2E: board filtering — the Story-6.15 closing journey (Subtask 6.15.4).
//
// @smoke — proves the HEADLINE Story 6.15 delivers end-to-end through the real
// shell: the board's once-dead `[Filter]` seam is now the SAME shipped /items
// filter primitives, board-scoped. A user opens the toolbar Filter, narrows the
// board by a quick KIND facet, by the 6.15.5 WORK TYPE facet, and by a saved
// filter; Clear restores the full board; and the active filter rides the URL so
// it survives a reload (shareable, reload-safe, per board).
//
//   - QUICK FILTER (kind): applying Kind = Bug re-projects EVERY column to the
//     matching cards (asserted on the board re-projection RESPONSE BODY — the
//     authoritative signal, not the optimistic popover, per CLAUDE.md), and the
//     non-matching cards leave the DOM.
//   - WORK TYPE facet (6.15.5): toggling Work type = Design re-projects the board
//     to that work type — the net-new facet the board exposes automatically by
//     reusing IssueFilterBar.
//   - SAVED FILTER: applying a saved filter from the picker narrows the board to
//     its stored predicate (the 6.2 read, board-scoped).
//   - CLEAR + URL + RELOAD: Clear restores the full board; the active filter is
//     carried in the URL and a reload re-projects to it (the `?board=` selection
//     preserved).
//
// SCOPE: the board-filter JOURNEY only. The filtered-read matrix (predicate per
// column · cap-over-filtered · unfiltered-unchanged · permission/tenant scope ·
// Scrum compose · work-type · typed saved-filter error) is proven at the
// service/integration tier (tests/boards/filtered-projection*.test.ts); the
// over-cap "Refine filter" CTA opening the board filter is proven on the real
// over-cap board in board-at-scale.spec.ts (the only lane with the cap seam) and
// at the unit tier (tests/components/board-filter.test.tsx). This spec does NOT
// re-assert those predicates — it proves them composed over the real stack, plus
// the strict a11y sweep over every filter affordance state.
//
// It mirrors the setup of board-crud.spec.ts (3.7.6): a browser sign-up (creator
// = workspace owner), one server-seeded project pinned active, work items seeded
// directly through the service (the sanctioned cross-layer reach for E2E setup),
// and the board read asserted on the projection the page fetches.

import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import type { BoardProjectionDto } from '@/lib/dto/boards';
import type { WorkItemKind, WorkItemType } from '@prisma/client';

const OWNER_EMAIL = 'e2e-board-filter-owner@example.com';

// The three seeded cards span kind × work-type × column so each facet narrows to
// a DISTINCT, asserted result: only Alpha is a bug; only Beta is type=design.
const ALPHA = 'Alpha bug';
const BETA = 'Beta design';
const GAMMA = 'Gamma task';
const ALL = [ALPHA, BETA, GAMMA];

const kindBugAst: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
};

interface Tenant {
  userId: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
}

// Sign-up auto-creates `<local>'s Workspace`; add the one project the board hangs
// off and pin it active so getActiveProject() resolves it on /boards. Identical
// shape to board-crud.spec.ts's seedActiveProject.
async function seedActiveProject(email: string): Promise<Tenant> {
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user should exist after sign-up').not.toBeNull();
  expect(ws, 'auto-created workspace should exist').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Board Filter Demo',
    identifier: 'BFL',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return {
    userId: user!.id,
    workspaceId: ws!.id,
    projectId: project.id,
    projectKey: project.identifier,
  };
}

// Create a card of `kind`/`type`, forced into `status` — the projection groups by
// these columns; the write paths are other stories' tests (the same shape the
// 6.15.2 integration fixture uses).
async function seedCard(
  t: Tenant,
  opts: { kind: WorkItemKind; type: WorkItemType | null; status: string; title: string },
): Promise<void> {
  const item = await workItemsService.createWorkItem(
    { projectId: t.projectId, kind: opts.kind, title: opts.title },
    { userId: t.userId, workspaceId: t.workspaceId },
  );
  await db.workItem.update({
    where: { id: item.id },
    data: { status: opts.status, type: opts.type },
  });
}

/** A predicate matching the board's projection fetch (GET /api/board), split by
 *  whether the filter param is present — the authoritative re-projection signal
 *  to arm BEFORE a filter action (CLAUDE.md: wait on the response, not the
 *  optimistic UI). */
function boardGet(filtered: boolean) {
  return (r: { url(): string; request(): { method(): string } }): boolean => {
    if (r.request().method() !== 'GET') return false;
    const u = new URL(r.url());
    if (u.pathname !== '/api/board') return false;
    return filtered ? u.searchParams.has('filter') : !u.searchParams.has('filter');
  };
}

/** The sorted card titles in a board projection response — the cross-column,
 *  virtualization-independent assertion of WHAT the filter matched. */
async function titlesOf(res: { json(): Promise<unknown> }): Promise<string[]> {
  const board = (await res.json()) as BoardProjectionDto;
  return board.columns.flatMap((c) => c.cards.map((card) => card.title)).sort();
}

async function openBoard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/boards');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
}

test.describe('board filtering (Story 6.15)', () => {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test('@smoke narrows the board by kind, work type, and a saved filter; Clear + reload', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const t = await seedActiveProject(OWNER_EMAIL);
    await seedCard(t, { kind: 'bug', type: 'code', status: 'todo', title: ALPHA });
    await seedCard(t, { kind: 'task', type: 'design', status: 'todo', title: BETA });
    await seedCard(t, { kind: 'task', type: 'code', status: 'in_progress', title: GAMMA });
    // A board-scoped saved filter the picker will apply (the 6.2 read).
    await savedFiltersService.create(
      t.projectKey,
      { name: 'Bugs only', visibility: 'private', filterParam: encodeFilterParam(kindBugAst) },
      { userId: t.userId, workspaceId: t.workspaceId },
    );

    await openBoard(page);
    const boardRegion = page.getByTestId('board');
    // Baseline — the full board shows all three cards.
    for (const title of ALL) await expect(boardRegion.getByText(title)).toBeVisible();

    // The quick popover is CLOSED — its facet listboxes are not mounted.
    await expect(page.getByRole('listbox', { name: 'Kind' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Filter work items' });
    await expect(dialog).toBeVisible();
    // The 6.15.5 Work type facet is present on the board's reused filter bar.
    await expect(dialog.getByRole('listbox', { name: 'Work type' })).toBeVisible();

    // KIND = Bug → only the bug card, across every column (assert on the response).
    let resP = page.waitForResponse(boardGet(true));
    await dialog
      .getByRole('listbox', { name: 'Kind' })
      .getByRole('option', { name: 'Bug' })
      .click();
    let res = await resP;
    expect(res.ok(), 'filtered board re-projection').toBe(true);
    expect(await titlesOf(res)).toEqual([ALPHA]);
    await expect(page).toHaveURL(/kind=bug/);
    await expect(boardRegion.getByText(BETA)).toHaveCount(0);
    await expect(boardRegion.getByText(GAMMA)).toHaveCount(0);

    // CLEAR → the full board returns (no filter param on the fetch).
    resP = page.waitForResponse(boardGet(false));
    await dialog.getByRole('button', { name: 'Clear filters' }).click();
    res = await resP;
    expect(await titlesOf(res)).toEqual([...ALL].sort());

    // WORK TYPE = Design → only the design-typed card (the 6.15.5 facet narrows).
    resP = page.waitForResponse(boardGet(true));
    await dialog
      .getByRole('listbox', { name: 'Work type' })
      .getByRole('option', { name: 'Design' })
      .click();
    res = await resP;
    expect(await titlesOf(res)).toEqual([BETA]);
    await expect(page).toHaveURL(/type=design/);
    await expect(boardRegion.getByText(ALPHA)).toHaveCount(0);

    // Clear the facet, close the quick popover, then APPLY A SAVED FILTER.
    resP = page.waitForResponse(boardGet(false));
    await dialog.getByRole('button', { name: 'Clear filters' }).click();
    await resP;
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: /^Saved filters/ }).click();
    resP = page.waitForResponse(boardGet(true));
    await page.getByRole('button', { name: /^Bugs only/ }).click();
    res = await resP;
    expect(await titlesOf(res)).toEqual([ALPHA]);
    await expect(page).toHaveURL(/filter=v1/);

    // RELOAD — the filter rides the URL, so the board re-projects to it.
    resP = page.waitForResponse(boardGet(true));
    await page.reload();
    res = await resP;
    expect(await titlesOf(res)).toEqual([ALPHA]);
    await expect(page).toHaveURL(/filter=v1/);
    await expect(page.getByTestId('board').getByText(ALPHA)).toBeVisible();
    await expect(page.getByTestId('board').getByText(BETA)).toHaveCount(0);
  });

  test('@a11y board filter affordances pass a strict axe sweep (closed / open / saved / active / empty)', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const t = await seedActiveProject(OWNER_EMAIL);
    await seedCard(t, { kind: 'bug', type: 'code', status: 'todo', title: ALPHA });
    await seedCard(t, { kind: 'task', type: 'design', status: 'todo', title: BETA });
    // A saved filter so the applied-filter summary row (chips) renders — that bar
    // mounts only for a saved/advanced filter, never a bare facet.
    await savedFiltersService.create(
      t.projectKey,
      { name: 'Bugs only', visibility: 'private', filterParam: encodeFilterParam(kindBugAst) },
      { userId: t.userId, workspaceId: t.workspaceId },
    );

    await openBoard(page);

    // CLOSED — the filter affordances at rest. Scoped to the toolbar `header`
    // that hosts them (the card asks for a sweep "over the filter affordance",
    // not the whole board — the board columns are 3.x surfaces, out of scope).
    await expectNoAxe(page, 'header', 'board filter — closed');

    // OPEN quick popover INCL. the Work type group (the 6.15.5 facet listbox).
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Filter work items' });
    await expect(dialog.getByRole('listbox', { name: 'Work type' })).toBeVisible();
    await expectNoAxe(page, '[role="dialog"]', 'board filter — open builder');

    // FILTERED-EMPTY — a facet that matches no card shows the distinct empty state.
    const emptyP = page.waitForResponse(boardGet(true));
    await dialog
      .getByRole('listbox', { name: 'Work type' })
      .getByRole('option', { name: 'Research' })
      .click();
    await emptyP;
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('board-filtered-empty')).toBeVisible();
    await expectNoAxe(page, '[data-testid="board-filtered-empty"]', 'board filtered-empty');

    // Reset to the full board, then sweep the SAVED-FILTER picker (open).
    await page.goto('/boards');
    await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: /^Saved filters/ }).click();
    await expect(page.getByRole('textbox', { name: 'Find filters' })).toBeVisible();
    await expectNoAxe(page, '[aria-label="Saved"]', 'board saved-filter picker');

    // ACTIVE chips — applying the saved filter mounts the applied-filter summary
    // row (the saved-filter name chip + condition chips).
    const appliedP = page.waitForResponse(boardGet(true));
    await page.getByRole('button', { name: /^Bugs only/ }).click();
    await appliedP;
    await expect(page.locator('[aria-label="Applied filter"]')).toBeVisible();
    await expectNoAxe(page, '[aria-label="Applied filter"]', 'board filter — active chips');
  });
});

// ── Strict WCAG 2.1 AA sweep helper (the saved-filters.spec.ts pattern) ───────
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

interface AxeViolation {
  id: string;
  help: string;
  nodes: { target: unknown[] }[];
}

function formatViolations(label: string, violations: AxeViolation[]): string {
  if (violations.length === 0) return `no violations on ${label}`;
  const lines = violations.map(
    (v) =>
      `  • ${v.id} — ${v.help} (${v.nodes.length} node(s): ${JSON.stringify(v.nodes[0]?.target)})`,
  );
  return `axe found ${violations.length} violation(s) on ${label}:\n${lines.join('\n')}`;
}

// Strict sweep, optionally scoped to a selector (transient overlays — dialog /
// listbox — scope to themselves; the at-rest states sweep the whole page).
async function expectNoAxe(page: Page, include: string | null, label: string): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  expect(results.violations, formatViolations(label, results.violations as AxeViolation[])).toEqual(
    [],
  );
}
