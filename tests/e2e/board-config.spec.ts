// E2E: board configuration — the column manager + status mapping (Story 3.6,
// Subtask 3.6.4 closing test).
//
// @smoke — proves the HEADLINE resolution Story 3.6 exists to deliver, driven
// end-to-end through the real shell: a custom workflow status added in Workflow
// settings lands UNMAPPED → surfaces in the board's unmapped tray on /boards
// (with the repointed "Map columns →" CTA, Subtask 3.6.3) → an owner opens Board
// settings, maps it onto a column → it now projects in that column on /boards and
// the tray is gone. Plus the other board-admin journeys 3.6 owns: a column delete
// returns its statuses to the unmapped tray WITHOUT losing work items, a column
// reorder (drag) persists across reload, and a non-owner member sees the surface
// read-only.
//
// The signed-up user is the workspace OWNER (creator = owner, finding #36), so the
// 3.6.2 `assertBoardConfigAdmin` gate admits the writes. The project is created
// server-side (projectsService) + pinned active — the same seed shape
// workflow-settings.spec.ts uses — then every config write is driven through the
// real UI against the 3.6.2 REST API. This spec does NOT re-drive the 3.2.7
// drag/board-card journeys; it owns the board-CONFIG surface only.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp, SHELL_PASSWORD } from './_helpers/shell-session';
import { getBoard, columnByStatus } from './_helpers/board';
import { createItem } from './_helpers/workflow';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';

const OWNER_EMAIL = 'e2e-board-config-owner@example.com';

// Sign-up auto-creates a fresh user + `<local>'s Workspace`; here we add the one
// project the board surfaces hang off and pin it active (so getActiveProject()
// resolves it on every settings/board render). Mirrors workflow-settings.spec.ts.
async function seedActiveProject(
  email: string,
): Promise<{ userId: string; workspaceId: string; projectId: string }> {
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user should exist after sign-up').not.toBeNull();
  expect(ws, 'auto-created workspace should exist').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Board Config Demo',
    identifier: 'BCD',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return { userId: user!.id, workspaceId: ws!.id, projectId: project.id };
}

// Add a custom workflow status through the REAL Workflow-settings UI (Story
// 2.2.5) — a status with no board column lands UNMAPPED, which is exactly the
// state Story 3.6 resolves. (The board.ts `addCustomStatus` helper does the same
// over the service; here the headline journey starts in the actual UI.)
async function addCustomStatusViaWorkflow(
  page: Page,
  status: { key: string; label: string },
): Promise<void> {
  await page.goto('/settings/project/workflow');
  await expect(page.getByRole('heading', { name: 'Workflow' })).toBeVisible();
  await page.getByRole('button', { name: 'Add status' }).click();
  await page.getByLabel('Key (machine id, lowercase)').fill(status.key);
  await page.getByLabel('Label').fill(status.label);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(status.label, { exact: true }).first()).toBeVisible();
}

async function gotoBoardSettings(page: Page): Promise<void> {
  await page.goto('/settings/project/board');
  await expect(page.getByRole('heading', { name: 'Board', level: 1 })).toBeVisible();
}

// The board-config column cards in DOM order (each SortableColumn is a listitem
// whose aria-label is "<name> column, <n> statuses").
async function columnNames(page: Page): Promise<string[]> {
  const labels = await page
    .getByTestId('board-config-columns')
    .getByRole('listitem')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  return labels.map((l) => l.replace(/ column,.*$/, ''));
}

// Map an unmapped status onto a column via that column's "Add status" picker (the
// non-drag, keyboard-operable path, finding #35), AWAITING the map PUT so the
// write has landed server-side before the test asserts persistence. The editor
// fires every config write as an OPTIMISTIC `void fetch` (reconcile-on-response),
// so a test that navigates or reads /api/board without this wait races the
// in-flight request — a `page.goto` cancels it and the map silently never lands.
async function mapStatusToColumn(page: Page, column: Locator, statusLabel: string): Promise<void> {
  await column.getByRole('button', { name: 'Add status' }).click();
  const put = page.waitForResponse(
    (r) =>
      /\/api\/board\/columns\/[^/]+\/statuses$/.test(r.url()) && r.request().method() === 'PUT',
  );
  await page.getByRole('menuitem', { name: statusLabel }).click();
  expect((await put).ok(), `map "${statusLabel}" persisted (PUT .../statuses ok)`).toBeTruthy();
}

// Drag the first column one slot right via a REAL pointer gesture (the dnd-kit
// PointerSensor has activationConstraint distance 8, so the gesture must clear
// 8px before it grabs), then AWAIT the reorder PATCH so the new order is
// persisted before the reload assertion. This owns the board-CONFIG reorder; it
// does not re-drive the 3.2.7 board-CARD drag journeys.
async function dragFirstColumnRight(page: Page): Promise<void> {
  const cols = page.getByTestId('board-config-columns').getByRole('listitem');
  const fromBox = (await cols
    .first()
    .getByRole('button', { name: /^Reorder / })
    .boundingBox())!;
  const toBox = (await cols.nth(1).boundingBox())!;
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  // Clear the 8px activation threshold, then settle past the 2nd column's
  // midpoint so the horizontal sortable swaps the two.
  await page.mouse.move(fromBox.x + fromBox.width / 2 + 24, fromBox.y + fromBox.height / 2, {
    steps: 6,
  });
  const patch = page.waitForResponse(
    (r) => /\/api\/board\/columns\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH',
  );
  await page.mouse.move(toBox.x + toBox.width * 0.75, toBox.y + toBox.height / 2, { steps: 12 });
  await page.mouse.up();
  expect((await patch).ok(), 'reorder persisted (PATCH .../columns/<id> ok)').toBeTruthy();
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// Give the multi-step browser journeys headroom over the 30s default — a slow
// argon2 sign-up plus several cold route compiles (workflow + board settings +
// boards) add up.
test.describe.configure({ timeout: 90_000 });

test.describe('board-config @smoke', () => {
  test('the headline: an unmapped status → mapped via Board settings → on the board, tray gone', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    await seedActiveProject(OWNER_EMAIL);

    // 1. Add a custom status in Workflow settings — it has no board column.
    await addCustomStatusViaWorkflow(page, { key: 'qa_review', label: 'QA Review' });

    // 2. On /boards it surfaces in the unmapped tray with the repointed CTA.
    await page.goto('/boards');
    const tray = page.getByTestId('board-unmapped-tray');
    await expect(tray).toBeVisible();
    await expect(tray).toContainText('QA Review');
    const trayLink = page.getByTestId('board-unmapped-link');
    await expect(trayLink).toContainText('Map columns');
    // 3.7.8: the CTA carries the viewed board (`?board=<id>`) so it opens THIS
    // board's settings, not the project default.
    await expect(trayLink).toHaveAttribute('href', /^\/settings\/project\/board\?board=/);

    // 3. Follow the CTA into Board settings — the status sits in the unmapped rail.
    await trayLink.click();
    await expect(page.getByRole('heading', { name: 'Board', level: 1 })).toBeVisible();
    const rail = page.getByTestId('board-config-unmapped');
    await expect(rail).toContainText('QA Review');

    // 4. Map it onto the first column via the per-column "Add status" picker (the
    //    keyboard / non-drag path, finding #35); the helper awaits the PUT so the
    //    map has persisted before we navigate.
    const firstColumn = page.getByTestId('board-config-columns').getByRole('listitem').first();
    const targetName = (await firstColumn.getAttribute('aria-label'))!.replace(/ column,.*$/, '');
    await mapStatusToColumn(page, firstColumn, 'QA Review');

    // The chip now lives in that column; the unmapped rail no longer holds it.
    await expect(firstColumn).toContainText('QA Review');
    await expect(rail).not.toContainText('QA Review');

    // 5. Back on /boards the tray is gone — every status is now on the board.
    await page.goto('/boards');
    await expect(page.getByTestId('board-unmapped-tray')).toHaveCount(0);

    // 6. The projection confirms it through the real API: qa_review is no longer
    //    unmapped and is one of the target column's mapped status keys.
    const board = await getBoard(page.request);
    expect(board.unmappedStatuses.map((s) => s.key)).not.toContain('qa_review');
    expect(columnByStatus(board, 'qa_review').name).toBe(targetName);
  });

  test('deleting a column returns its mapped status to the unmapped tray, losing no work item', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const { projectId } = await seedActiveProject(OWNER_EMAIL);

    // A real work item on the board, so we can prove a column delete never
    // touches work items (a card's column is DERIVED from its status, Story 3.1).
    const item = await createItem(page.request, projectId, 'survives the column delete');
    expect(item.status).toBe('todo');

    await addCustomStatusViaWorkflow(page, { key: 'qa_review', label: 'QA Review' });
    await gotoBoardSettings(page);

    // Add a fresh column. The add is optimistic (a `temp-…` id) and reconciles to
    // the real id on the POST response — await BOTH the POST and the temp→real
    // reconcile before mapping, or the map PUT fires against the temp id (404).
    await page.getByTestId('board-config-add-column').click();
    await page.getByLabel('New column name').fill('Review Lane');
    const addPost = page.waitForResponse(
      (r) => r.url().endsWith('/api/board/columns') && r.request().method() === 'POST',
    );
    await page.keyboard.press('Enter');
    expect((await addPost).ok(), 'add column persisted').toBeTruthy();
    await expect(page.locator('[data-testid^="board-config-column-temp-"]')).toHaveCount(0);

    const reviewLane = page
      .getByTestId('board-config-columns')
      .getByRole('listitem')
      .filter({ hasText: 'Review Lane' });
    await expect(reviewLane).toBeVisible();
    await mapStatusToColumn(page, reviewLane, 'QA Review');
    await expect(reviewLane).toContainText('QA Review');
    await expect(page.getByTestId('board-config-unmapped')).not.toContainText('QA Review');

    // Delete the column — it is empty (the custom status holds no cards), so the
    // normal confirm shows (not the guard); its status returns to the rail. Await
    // the DELETE so the projection assertions below see the committed state.
    await reviewLane.getByRole('button', { name: 'Delete Review Lane column' }).click();
    const del = page.waitForResponse(
      (r) => /\/api\/board\/columns\/[^/]+$/.test(r.url()) && r.request().method() === 'DELETE',
    );
    await page.getByTestId('board-config-delete-confirm').click();
    expect((await del).ok(), 'delete column persisted').toBeTruthy();

    await expect(
      page
        .getByTestId('board-config-columns')
        .getByRole('listitem')
        .filter({ hasText: 'Review Lane' }),
    ).toHaveCount(0);
    await expect(page.getByTestId('board-config-unmapped')).toContainText('QA Review');

    // The projection: qa_review is unmapped again, and the work item is still on
    // the board in its todo column — config never deleted a work item.
    const board = await getBoard(page.request);
    expect(board.unmappedStatuses.map((s) => s.key)).toContain('qa_review');
    expect(columnByStatus(board, 'todo').cards.map((c) => c.id)).toContain(item.id);
  });

  test('a column reorder (drag) persists across a reload', async ({ page }) => {
    await signUp(page, OWNER_EMAIL);
    await seedActiveProject(OWNER_EMAIL);
    await gotoBoardSettings(page);

    const before = await columnNames(page);
    expect(before.length).toBeGreaterThan(1);

    // Drag the first column one slot to the right (the helper awaits the reorder
    // PATCH), so the first two columns swap.
    await dragFirstColumnRight(page);
    const expected = [before[1], before[0], ...before.slice(2)];
    await expect.poll(() => columnNames(page)).toEqual(expected);

    // And the new order survives a full reload (it persisted server-side).
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Board', level: 1 })).toBeVisible();
    expect(await columnNames(page)).toEqual(expected);
  });

  test('a non-owner member sees the board-config surface read-only', async ({ page }) => {
    await signUp(page, OWNER_EMAIL);
    const { workspaceId, projectId } = await seedActiveProject(OWNER_EMAIL);

    // A second user, added to the owner's workspace as a plain member (not owner),
    // with the project pinned active — the 3.6.2 admin gate must deny them every
    // write, and the surface renders read-only.
    const memberEmail = 'e2e-board-config-member@example.com';
    const member = await usersService.createUser({
      email: memberEmail,
      password: SHELL_PASSWORD,
      name: 'Board Member',
    });
    await db.workspaceMembership.create({
      data: { userId: member.id, workspaceId, role: 'member', activeProjectId: projectId },
    });
    // Story 6.10.4: a workspace member must also be a member of the workspace's
    // org (org membership gates workspace access). Enrol the member so the org
    // gate — not the zero-membership self-heal fallback — resolves them onto the
    // owner's workspace with their `member` role (the read-only board-config gate).
    {
      const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
      await db.organizationMembership.create({
        data: { organizationId: ws.organizationId, userId: member.id, role: 'member' },
      });
    }

    // Sign in as the member (two-step credentials flow).
    await page.goto('/sign-in');
    await page.getByPlaceholder('Email address').fill(memberEmail);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByPlaceholder('Password').fill(SHELL_PASSWORD);
    await page.getByRole('button', { name: /^(Continue|Signing in…)$/ }).click();
    await page.waitForURL('**/dashboard');

    await gotoBoardSettings(page);

    // The read-only banner shows, and not one write affordance renders.
    await expect(page.getByText('read-only access to board settings')).toBeVisible();
    await expect(page.getByTestId('board-config-add-column')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add status' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Delete .* column$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Reorder / })).toHaveCount(0);
  });
});
