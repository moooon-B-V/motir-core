import { expect, test, type Page } from '@playwright/test';
import { actionWrite } from './_helpers/authoritative-signal';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { PLANNER_BUG_HOME_MARKER } from '@/lib/ai/plannerBugHome';
import { db } from '@/lib/db';
import { resolveSystemPrincipal } from '@/lib/ai/serviceAuth';
import { aiWorkItemsService } from '@/lib/services/aiWorkItemsService';
import { foldersService } from '@/lib/services/foldersService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';

// Story MOTIR-5818 · Subtask MOTIR-5828 — a PLANNING bug, filed through the
// `@planner-bug-home` marker, appears in the `/items` tree INSIDE the folder the
// project points at, as a ROOT with no parent card. Then the ladder: with the
// planner pointer unset it follows the product bug destination, and with both
// unset it renders at the top level.
//
// ⚠️ WHY THIS STORY HAS AN E2E WHEN IT SHIPS NO CONTROL. The settings picker was
// removed by the re-plan of 2026-09-19 (the pointer has one reader, in one
// tenant — MOTIR-5832), so nothing here renders a new surface. What the story
// changes is what a person READS in `/items`: the planner's records sit in a
// folder instead of under a container that is never done. That is the assertion,
// and the tree is where it is made.
//
// ⚠️ THE FILING STEP, AND WHY IT IS NOT AN HTTP CALL. The marker filer is
// `aiWorkItemsService.fileBug`, served by `POST /api/internal/ai/work-items`
// behind the `CORE_CALLBACK_SECRET` service bearer. This lane's server holds no
// such secret — it is set in neither `.env`, `playwright.config.ts` nor the CI
// workflows — so that route answers 401 here, and stubbing it would test the
// harness. This spec therefore calls the SAME service method the route delegates
// to, as the system principal the route authenticates to, in the runner process
// against the lane's own database — exactly as its sibling
// `bug-destination.spec.ts` does, and for the same reason. Nothing is stubbed:
// the bug is created by the real filer, and where it LANDS is read back through
// the real `/items` tree.
//
// ⚠️ AND THE POINTER IS WRITTEN DIRECTLY, BECAUSE NOTHING IN THE PRODUCT WRITES
// IT. The meta tenant's own pointer is set by the data migration (MOTIR-5824);
// there is no room, no route and no service call to drive, so the seed writes the
// column the way every other `_helpers/*-seed.ts` here writes project state.

const EMAIL = 'e2e-planner-bug-destination@example.com';
const PASSWORD = 'planner-bug-destination-e2e-pass-123';

test.describe.configure({ timeout: 120_000 });

interface Seed {
  projectId: string;
  projectKey: string;
  bugsFolderId: string;
  planningFolderId: string;
}

async function seed(): Promise<Seed> {
  const owner = await usersService.createUser({
    email: EMAIL,
    password: PASSWORD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Planner bugs',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Motir',
    identifier: 'PBUG',
  });
  await projectsService.setActiveProject({
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  await seedSystemPrincipal({ workspaceId: workspace.id, projectId: project.id });

  // The project is born with its Bugs folder; the planner's own folder sits under
  // it, which is the shape the data migration adopts on the meta tenant.
  const row = await db.project.findUniqueOrThrow({ where: { id: project.id } });
  const bugsFolderId = row.bugDestinationFolderId;
  expect(bugsFolderId).not.toBeNull();
  const ctx = { userId: owner.id, workspaceId: workspace.id };
  const planning = await foldersService.createFolder(
    { projectId: project.id, parentFolderId: bugsFolderId, name: 'Planning bugs' },
    ctx,
  );
  await db.project.update({
    where: { id: project.id },
    data: { plannerBugDestinationFolderId: planning.id },
  });

  return {
    projectId: project.id,
    projectKey: project.identifier,
    bugsFolderId: bugsFolderId!,
    planningFolderId: planning.id,
  };
}

/** File one PLANNING bug through the real marker filer, as the system principal. */
async function filePlanningBug(s: Seed, title: string) {
  const system = await resolveSystemPrincipal();
  return aiWorkItemsService.fileBug(
    { projectKey: s.projectKey, title, parentKey: PLANNER_BUG_HOME_MARKER },
    system,
  );
}

/** Where a filed record actually SITS, read back from the row the filer wrote. */
async function placementOf(id: string) {
  const row = await db.workItem.findUniqueOrThrow({ where: { id } });
  return { folderId: row.folderId, parentId: row.parentId };
}

const tree = (page: Page) => page.getByRole('treegrid', { name: 'Work Items', exact: true });

/** Expand a folder by name, waiting on the read the expansion actually issues. */
async function expandFolder(page: Page, name: string, folderId: string) {
  const expand = actionWrite(page, '/items', folderId);
  await page.getByRole('button', { name: `Expand folder ${name}`, exact: true }).click();
  expect((await expand).status()).toBe(200);
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('a planning bug filed through the marker lands in the planner-bug folder, and the ladder falls back when it is unset', async ({
  page,
}) => {
  const s = await seed();
  await signIn(page, EMAIL, PASSWORD);

  // 1 · POINTED — the record renders INSIDE `Bugs ▸ Planning bugs`, nested two
  //     levels deep, and carries no parent card of its own.
  const filed = await filePlanningBug(s, 'The plan assumed a surface that does not exist');
  await page.goto('/items');
  await expect(tree(page)).toBeVisible();
  await expandFolder(page, 'Bugs', s.bugsFolderId);
  await expandFolder(page, 'Planning bugs', s.planningFolderId);
  const filedRow = tree(page).getByTestId(`issue-row-${filed.identifier}`);
  await expect(filedRow).toBeVisible();
  await expect(filedRow).toHaveAttribute('aria-level', '3'); // Bugs ▸ Planning bugs ▸ the record
  expect(await placementOf(filed.id)).toEqual({
    folderId: s.planningFolderId,
    parentId: null,
  });

  // 2 · UNSET — the ladder falls back to the PRODUCT bug destination, and the
  //     next record renders one level up, inside Bugs itself.
  await db.project.update({
    where: { id: s.projectId },
    data: { plannerBugDestinationFolderId: null },
  });
  const fallback = await filePlanningBug(s, 'The estimate was written before the design existed');
  await page.goto('/items');
  await expect(tree(page)).toBeVisible();
  await expandFolder(page, 'Bugs', s.bugsFolderId);
  const fallbackRow = tree(page).getByTestId(`issue-row-${fallback.identifier}`);
  await expect(fallbackRow).toBeVisible();
  await expect(fallbackRow).toHaveAttribute('aria-level', '2'); // Bugs ▸ the record
  expect(await placementOf(fallback.id)).toEqual({
    folderId: s.bugsFolderId,
    parentId: null,
  });

  // 3 · BOTH UNSET — the record renders at the top level of the tree, in no
  //     folder and under no card. Still a legal answer; never a 5xx.
  await db.project.update({
    where: { id: s.projectId },
    data: { bugDestinationFolderId: null },
  });
  const atRoot = await filePlanningBug(s, 'A deferral named no card');
  await page.goto('/items');
  await expect(tree(page)).toBeVisible();
  const atRootRow = tree(page).getByTestId(`issue-row-${atRoot.identifier}`);
  await expect(atRootRow).toBeVisible();
  await expect(atRootRow).toHaveAttribute('aria-level', '1');
  expect(await placementOf(atRoot.id)).toEqual({ folderId: null, parentId: null });
});
