import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { db, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// READY WORK IN THREE LANES — THE ACCEPTANCE RECEIPT (Story MOTIR-6829 ·
// Subtask MOTIR-6836). The story's verification recipe, steps 1–3, in a real
// browser against a production build and a real database, paced for a person.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// /ready, opened from the sidebar, shows the story S as ONE collapsed row
// reading how much of it is ready — never the epic E that holds it, and never a
// bug. Expanding S reveals its three ready subtasks, indented; collapsing hides
// them. The lane switch then shows the Bugs lane in the same full-height pane:
// the childless bug B, and the bug B2, which expands to its ready subtask.
//
// ── THE WAITS ────────────────────────────────────────────────────────────────
//
// Nothing here writes: every step is a read or a client-side toggle, so each is
// asserted on the rendered state it produces, and the page is asserted MOUNTED
// (its heading and its list) before any lane assertion. Every test-id lookup is
// SCOPED to its list: the lanes stream in behind an in-page Suspense, and React
// keeps the previous subtree mounted (hidden) while it does, so an unscoped one
// matches both (CLAUDE.md § the second cost of a boundary).

// The tree is seeded through the services, never the main lane's HTTP helpers:
// those post to the main lane's origin, and this lane's server is on its own.

const EMAIL = 'acceptance-ready-lanes@example.com';
const PASSWORD = 'acceptance-ready-lanes-pw-1';

interface Seed {
  ctx: ServiceContext;
  projectId: string;
}

async function seedProject(): Promise<Seed> {
  const owner = await usersService.createUser({
    email: EMAIL,
    password: PASSWORD,
    name: 'Riley Ready',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Motir Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Motir',
    identifier: 'MOT',
  });
  await projectsService.setActiveProject({
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  return { ctx: { userId: owner.id, workspaceId: workspace.id }, projectId: project.id };
}

async function mk(
  seed: Seed,
  data: {
    title: string;
    kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask';
    priority?: 'low';
    parentId?: string;
  },
): Promise<{ id: string; identifier: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: seed.projectId, ...data, parentId: data.parentId ?? null },
    seed.ctx,
  );
  return { id: dto.id, identifier: dto.identifier };
}

const mainList = (page: Page) => page.getByRole('list', { name: 'Ready work items' });
const bugsList = (page: Page) => page.getByRole('list', { name: 'Ready bugs' });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('/ready shows a story as one expandable row over its ready leaves, never an epic, and a bug only in the Bugs lane', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6829');
  test.setTimeout(240_000);

  const seed = await seedProject();
  const E = await mk(seed, { title: 'Ready work in lanes', kind: 'epic' });
  const S = await mk(seed, {
    title: 'Group the ready list by story',
    kind: 'story',
    parentId: E.id,
  });
  const leaves = [
    await mk(seed, {
      title: 'Partition the walk',
      kind: 'subtask',
      parentId: S.id,
    }),
    await mk(seed, {
      title: 'Lane cursor codec',
      kind: 'subtask',
      parentId: S.id,
    }),
    await mk(seed, {
      title: 'Container shapes read',
      kind: 'subtask',
      parentId: S.id,
    }),
  ];
  const T = await mk(seed, {
    title: 'Reconcile the CLI changeset',
    kind: 'task',
    priority: 'low',
    parentId: E.id,
  });
  const B = await mk(seed, { title: 'Copy toast clips long keys', kind: 'bug' });
  const B2 = await mk(seed, {
    title: 'Load-more drops the last row',
    kind: 'bug',
  });
  const b1 = await mk(seed, {
    title: 'Reproduce at the page boundary',
    kind: 'subtask',
    parentId: B2.id,
  });

  await signIn(page, EMAIL, PASSWORD);

  await chapter('Open Ready from the sidebar — S is one collapsed row, E is no row', async () => {
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Ready' })
      .click();
    await expect(page).toHaveURL(/\/ready(\?|$)/);
    await expect(page.getByRole('heading', { name: 'Ready to start', level: 1 })).toBeVisible();
    await expect(mainList(page)).toBeVisible();
    await expect(mainList(page).getByTestId(`ready-container-${S.identifier}`)).toContainText(
      '3 of 3 ready',
    );
    await expect(mainList(page)).toContainText(T.identifier);
    await expect(mainList(page)).not.toContainText(E.identifier);
    for (const bug of [B, B2]) await expect(mainList(page)).not.toContainText(bug.identifier);
    await beat();
  });

  await chapter('Expand S — its three ready subtasks, indented', async () => {
    await page.getByRole('button', { name: `Expand ${S.identifier}` }).click();
    for (const leaf of leaves) await expect(mainList(page)).toContainText(leaf.identifier);
    await beat();
  });

  await chapter('Collapse S — the subtasks fold back in', async () => {
    await page.getByRole('button', { name: `Collapse ${S.identifier}` }).click();
    for (const leaf of leaves) await expect(mainList(page)).not.toContainText(leaf.identifier);
    await beat();
  });

  await chapter('Switch to Bugs — B, and B2 with its ready subtask', async () => {
    const bugs = page.getByRole('button', { name: /^Bugs/ });
    await expect(bugs).toContainText('2');
    await bugs.click();
    await expect(page).toHaveURL(/[?&]lane=bugs/);
    await expect(bugsList(page)).toBeVisible();
    await expect(bugsList(page)).toContainText(B.identifier);
    await beat();
    await page.getByRole('button', { name: `Expand ${B2.identifier}` }).click();
    await expect(bugsList(page)).toContainText(b1.identifier);
    await beat();
  });
});
