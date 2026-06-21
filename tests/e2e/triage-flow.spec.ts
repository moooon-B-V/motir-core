// E2E: Story 6.11 — the triage inbox front door (Subtask 6.11.9). The full
// intake → triage → promote loop across both surfaces, proving the
// read-exclusion invariant AND promotion end to end in a real browser:
//
//   1. a signed-in member submits a bug via the in-app "Report" widget;
//   2. it appears in the triage inbox and is ABSENT from the issue tree, the
//      list view, the board, and the work-item search (the FilterAST-backed
//      link-candidate picker) — the exclusion-everywhere invariant 6.11.3 owns;
//   3. an admin promotes it from the inbox to the backlog;
//   4. it is now GONE from the triage queue and PRESENT in the tree, list,
//      board, and search.
//
//   + a second leg: a declined submission leaves the queue and never enters the
//     tree.
//
// The integration suite (6.11.8) pins the exclusion + action MATRIX at the
// service layer over real Postgres; this file owns the thing only a browser
// proves — the widget → inbox → promote/decline journey across the rendered
// surfaces.
//
// Setup mirrors issue-list-flow.spec.ts: sign up through the real UI
// (shell-session.signUp → auto-workspace → /dashboard), then seed the project +
// the host work item SERVER-SIDE through the shipped services (the one
// sanctioned cross-layer reach for tests). The submit, promote, and decline
// themselves go through the BROWSER — that is the surface under test.
//
// Per the E2E discipline (CLAUDE.md): every mutation (submit / promote /
// decline) is awaited on its endpoint's response BEFORE asserting the persisted
// effect, and each surface is re-navigated fresh (a full server read) rather
// than leaning on a client island's optimistic state — so no assertion races an
// in-flight write or a stale `useState(initialItems)` seed.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

interface Seed {
  ctx: ServiceContext;
  projectId: string;
  identifier: string;
}

/** Sign up through the real UI (auto-workspace), create a project server-side,
 *  and pin it active so the project-scoped routes (/items, /boards, /triage)
 *  and the shell "Report" affordance resolve it. */
async function seedProject(page: Page, email: string, identifier: string): Promise<Seed> {
  await signUp(page, email);
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Triage Flow',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return { ctx: { userId: user!.id, workspaceId: ws!.id }, projectId: project.id, identifier };
}

/** Create one normal work item through the service (returns id + identifier). */
async function mk(
  seed: Seed,
  title: string,
): Promise<{ id: string; identifier: string; title: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'task', title, parentId: null },
    seed.ctx,
  );
  return { id: dto.id, identifier: dto.identifier, title: dto.title };
}

interface Submitted {
  id: string;
  identifier: string;
}

/** Submit a bug through the in-app report widget (the 6.11.7 shell affordance),
 *  awaiting the intake POST so the created triage item is committed. Returns the
 *  new item's id + identifier (the stable testid handle the surfaces key on). */
async function submitBug(page: Page, title: string): Promise<Submitted> {
  // The shell "Report" icon button (Bug glyph) — present on any authed page with
  // an active project the actor can edit.
  await page.getByRole('button', { name: 'Report' }).first().click();

  // The widget is a Radix dialog ("Report something"); kind defaults to Bug.
  const modal = page.getByRole('dialog', { name: 'Report something' });
  await expect(modal).toBeVisible();
  await modal.getByLabel('Title').fill(title);

  // Arm the response wait BEFORE the click (CLAUDE.md E2E discipline).
  const created = page.waitForResponse(
    (r) => r.url().includes('/triage/submissions') && r.request().method() === 'POST',
  );
  await modal.getByRole('button', { name: 'Submit' }).click();
  const res = await created;
  expect(res.status(), `submit "${title}" → 201`).toBe(201);
  const body = (await res.json()) as Submitted;
  expect(body.identifier, 'submission has an identifier').toBeTruthy();

  // The widget toasts on success and closes; wait for the dialog to go so a
  // follow-on navigation isn't racing the modal's close.
  await expect(modal).toBeHidden();
  return body;
}

/** Open /triage, select the submission's queue row, and wait for its detail pane
 *  to load — so the action bar (Accept / Promote / Decline …) is mounted.
 *  Clicking the row is what triggers the detail fetch (the initial selection
 *  highlights the row but does not auto-fetch the detail). */
async function openTriageDetail(page: Page, title: string): Promise<void> {
  await page.goto('/triage');
  // The queue row is a button whose accessible name starts with the title.
  await page.getByRole('button', { name: new RegExp(title) }).click();
  // The loaded detail renders the title as an h2. A generous timeout absorbs the
  // dev server's first-hit cold compile of the triage-detail route.
  await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible({
    timeout: 30_000,
  });
}

test('@smoke a submitted bug lands in triage, is excluded from tree/list/board/search, then promote surfaces it everywhere', async ({
  page,
}) => {
  const seed = await seedProject(page, 'e2e-triage-promote@example.com', 'TRG');
  // A normal work item that IS visible everywhere — both a control (proves each
  // surface actually loaded) and the host whose link picker is the search probe.
  const host = await mk(seed, 'host work item always visible');

  const bugTitle = 'aardvark triage exclusion beacon';

  // ── submit via the in-app report widget ────────────────────────────────────
  await page.goto('/items');
  await expect(page.getByRole('treegrid', { name: 'Work Items', exact: true })).toBeVisible();
  await expect(page.getByTestId(`issue-row-${host.identifier}`)).toBeVisible();

  const submitted = await submitBug(page, bugTitle);

  // ── it appears in the triage inbox ─────────────────────────────────────────
  await page.goto('/triage');
  await expect(page.getByText(bugTitle)).toBeVisible();

  // ── and is EXCLUDED from every normal read (before promotion) ──────────────
  // Tree: the host root is present (the tree loaded); the triage item is not.
  await page.goto('/items');
  await expect(page.getByTestId(`issue-row-${host.identifier}`)).toBeVisible();
  await expect(page.getByTestId(`issue-row-${submitted.identifier}`)).toHaveCount(0);

  // List view: same exclusion on the flat list read.
  await page.goto('/items?view=list');
  await expect(page.getByTestId(`issue-row-${host.identifier}`)).toBeVisible();
  await expect(page.getByTestId(`issue-row-${submitted.identifier}`)).toHaveCount(0);

  // Board: the projection read excludes it (no card), though the board rendered.
  await page.goto('/boards');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`board-card-${submitted.identifier}`)).toHaveCount(0);

  // Search: the FilterAST-backed work-item search (the link-candidate picker)
  // does not surface a triage item — it is not a linkable candidate.
  await page.goto(`/items/${host.identifier}`);
  await page.getByRole('button', { name: 'Link work item' }).click();
  await page.getByRole('combobox', { name: 'Work item to link' }).click();
  await page.getByRole('combobox', { name: /Search by identifier or title/ }).fill('aardvark');
  await expect(page.getByText('No matching work items.')).toBeVisible();
  await expect(page.getByRole('option', { name: /aardvark/ })).toHaveCount(0);

  // ── promote it from the inbox to the backlog ───────────────────────────────
  await openTriageDetail(page, bugTitle);
  // `exact: true` — a substring "Promote" also matches the queue row button
  // (its name carries the submitter email, …-triage-promote).
  await page.getByRole('button', { name: 'Promote', exact: true }).click();
  const promoted = page.waitForResponse(
    (r) =>
      r.url().includes(`/work-items/${submitted.id}/triage/promote`) &&
      r.request().method() === 'POST',
  );
  // The Promote popover's "Backlog" target row ("Backlog · Unparented, default
  // status") commits immediately; anchor on the leading word so the "Position in
  // backlog" control can't match.
  await page.getByRole('button', { name: /^Backlog/ }).click();
  expect((await promoted).status(), 'promote → backlog returns 200').toBe(200);

  // ── it is GONE from the triage queue ───────────────────────────────────────
  await page.goto('/triage');
  await expect(page.getByText(bugTitle)).toHaveCount(0);

  // ── and now PRESENT in every normal read ───────────────────────────────────
  // Tree: a backlog (unparented) item is a top-level root.
  await page.goto('/items');
  await expect(page.getByTestId(`issue-row-${submitted.identifier}`)).toBeVisible();

  // List view.
  await page.goto('/items?view=list');
  await expect(page.getByTestId(`issue-row-${submitted.identifier}`)).toBeVisible();

  // Board: default status → the first column.
  await page.goto('/boards');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`board-card-${submitted.identifier}`)).toBeVisible();

  // Search: now a normal item, it is a search candidate.
  await page.goto(`/items/${host.identifier}`);
  await page.getByRole('button', { name: 'Link work item' }).click();
  await page.getByRole('combobox', { name: 'Work item to link' }).click();
  await page.getByRole('combobox', { name: /Search by identifier or title/ }).fill('aardvark');
  await expect(page.getByRole('option', { name: new RegExp(bugTitle) })).toBeVisible();
});

test('@smoke a declined submission leaves the queue and never enters the tree', async ({
  page,
}) => {
  const seed = await seedProject(page, 'e2e-triage-decline@example.com', 'TDC');
  // A control root so /items renders the treegrid (an empty project would show
  // the empty state instead) — the loaded-tree signal for the absence check.
  const host = await mk(seed, 'host work item always visible');
  const declineTitle = 'wombat decline beacon';

  // Submit a bug, then decline it from the inbox.
  await page.goto('/items');
  await expect(page.getByRole('treegrid', { name: 'Work Items', exact: true })).toBeVisible();
  await expect(page.getByTestId(`issue-row-${host.identifier}`)).toBeVisible();
  const submitted = await submitBug(page, declineTitle);

  await openTriageDetail(page, declineTitle);

  // The Decline trigger opens a confirm popover ("Decline this submission?");
  // the confirm button (portaled, so last in the DOM) commits it. `exact: true`
  // is required — a plain substring "Decline" also matches the queue row button
  // (its name carries the title + submitter email), which would re-select the
  // row instead of opening the popover. Both trigger and confirm are exactly
  // "Decline", so the trigger is `.first()` (the confirm doesn't exist yet) and
  // the portaled confirm is `.last()` once the popover is open.
  const declineExact = page.getByRole('button', { name: 'Decline', exact: true });
  await declineExact.first().click();
  await expect(page.getByText('Decline this submission?')).toBeVisible();
  const declined = page.waitForResponse(
    (r) =>
      r.url().includes(`/work-items/${submitted.id}/triage/decline`) &&
      r.request().method() === 'POST',
  );
  await declineExact.last().click();
  expect((await declined).status(), 'decline returns 200').toBe(200);

  // It leaves the queue …
  await page.goto('/triage');
  await expect(page.getByText(declineTitle)).toHaveCount(0);

  // … and never appears in the tree (a declined item is canceled, not promoted).
  await page.goto('/items');
  await expect(page.getByTestId(`issue-row-${host.identifier}`)).toBeVisible();
  await expect(page.getByTestId(`issue-row-${submitted.identifier}`)).toHaveCount(0);
});
