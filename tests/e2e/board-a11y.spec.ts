// E2E: board accessibility — the empty-column placeholder meets WCAG AA contrast
// (Epic 3 · MOTIR-802).
//
// @a11y — a board that holds at least one card but has EMPTY columns shows the
// `emptyColumn` dashed-border placeholder in each empty column. That placeholder
// text must clear the WCAG 2.1 AA 4.5:1 minimum on the column surface. The bug
// (MOTIR-802) was `text-(--el-text-muted)` (#787671 on #f6f5f4 = 4.16:1), which a
// strict axe sweep flags as `color-contrast` — one node per empty column.
//
// This is the board-COLUMN surface the board-filter @a11y sweep explicitly scoped
// OUT ("the board columns are 3.x surfaces, out of scope"); it lives here, under
// Epic 3, instead. The fix moves the placeholder to `--el-text-secondary`
// (#5d5b54, 6.24:1), the same faint→secondary remedy MOTIR-444 applied to the
// filter popover's `FacetLabel`.
//
// Setup mirrors board-filter.spec.ts: a browser sign-up (creator = workspace
// owner), one server-seeded project pinned active. ONE card is seeded into `todo`
// so the board GRID renders (a wholly-empty board shows the board-level empty
// state instead, per BoardContainer's `isEmpty` gate) — leaving the other five
// default-workflow columns empty so each shows the placeholder under test.

import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';

const OWNER_EMAIL = 'e2e-board-a11y-owner@example.com';

interface Tenant {
  userId: string;
  workspaceId: string;
  projectId: string;
}

// Sign-up auto-creates `<local>'s Workspace`; add the one project the board hangs
// off and pin it active so getActiveProject() resolves it on /boards.
async function seedActiveProject(email: string): Promise<Tenant> {
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user should exist after sign-up').not.toBeNull();
  expect(ws, 'auto-created workspace should exist').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Board A11y Demo',
    identifier: 'BAY',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return { userId: user!.id, workspaceId: ws!.id, projectId: project.id };
}

// One card forced into `status` — enough to render the board grid (vs the
// board-level empty state), leaving every other column empty. Same shape as
// board-filter.spec.ts's seedCard.
async function seedCard(t: Tenant, title: string, status: string): Promise<void> {
  const item = await workItemsService.createWorkItem(
    { projectId: t.projectId, kind: 'task', title },
    { userId: t.userId, workspaceId: t.workspaceId },
  );
  await db.workItem.update({ where: { id: item.id }, data: { status, type: 'code' } });
}

async function openBoard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/boards');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
}

// ── Strict WCAG 2.1 AA sweep helper (the board-filter.spec.ts pattern) ────────
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

test.describe('board a11y (Epic 3)', () => {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test('@a11y a board with empty columns passes a strict color-contrast sweep — the empty-column placeholder meets AA', async ({
    page,
  }) => {
    await signUp(page, OWNER_EMAIL);
    const t = await seedActiveProject(OWNER_EMAIL);
    // One card in `todo` so the grid renders; the other five columns stay empty.
    await seedCard(t, 'Anchor card', 'todo');

    await openBoard(page);

    // The five empty columns each show the dashed-border placeholder — assert it
    // actually rendered before sweeping (otherwise the sweep would pass vacuously).
    const board = page.getByTestId('board');
    await expect(board.getByText('No work items').first()).toBeVisible();

    // Strict wcag2aa sweep over the board region; assert the bug's rule
    // (color-contrast) reports zero violations — the empty-column placeholder now
    // meets AA. (Per the card's acceptance criteria.)
    const results = await new AxeBuilder({ page })
      .include('[data-testid="board"]')
      .withTags(WCAG_TAGS)
      .analyze();
    const contrast = (results.violations as AxeViolation[]).filter(
      (v) => v.id === 'color-contrast',
    );
    expect(contrast, formatViolations('board (color-contrast)', contrast)).toEqual([]);
  });
});
