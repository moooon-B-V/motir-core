/**
 * `pnpm db:seed:large` — seed a REAL-SCALE demo project (Subtask 2.5.16,
 * finding #57). Dev tooling only: it makes the finding-#57 scale work
 * (List pagination 2.5.12 · lazy-load + virtualization 2.5.14/2.5.15)
 * *visible* in the UI — you can't see pagination or lazy-load do anything with
 * 7 issues.
 *
 * Creates one self-contained demo tenant (a fixed user + workspace + project)
 * and a few-thousand-issue tree:
 *   - many ROOT epics (so the flat List spans many pages + roots paginate),
 *   - one epic with > the per-node page (50) of children (to exercise the Tree's
 *     "Load more children" + virtualization), and a deep branch under it,
 *   - the rest with a handful of children each.
 *
 * IDEMPOTENT: re-running clears its OWN demo workspace (by name, owned by the
 * fixed seed user) and reseeds — it never touches any other workspace's data.
 * Runs through the shipped services / repository create path (no raw inserts
 * that skip the kind-parent triggers). NOT part of the production bundle
 * (scripts/ isn't in the Next app); refuses to run under NODE_ENV=production.
 *
 * Tune the size with env: SEED_ROOTS, SEED_BIG_CHILDREN, SEED_SMALL_CHILDREN,
 * SEED_DEEP_CHILDREN (defaults below ≈ 2,000 issues).
 *
 * SEED_SHAPE=board (Subtask 3.5.1) switches to the BOARD-shaped variant: instead
 * of the tree/list shape above, it spreads the `BIG` project's issues across the
 * board's columns (every status), swimlanes (many assignees + epics + every
 * priority, each with a catch-all), and a Done-age spread in the terminal
 * columns — the at-scale fixture the Epic-3 cross-cutting board journey
 * (Stories 3.5.2 / 3.5.3) runs against. Board-shape size knobs: SEED_BOARD_MEMBERS,
 * SEED_BOARD_EPICS, SEED_BOARD_STORIES_PER_EPIC, SEED_BOARD_ROOT_STORIES,
 * SEED_BOARD_TALL_EXTRA. See scripts/seedLargeBoard.ts.
 *
 * SEED_SHAPE=scrum (Subtask 4.7.1) is the SPRINT-shaped variant: the same
 * board-shaped distribution, but the project's board is flipped to scrum and a
 * large bounded `active` sprint (with a story-point spread) holds most of the
 * issues — plus a `planned` carry-over target sprint and a backlog slice left
 * OUTSIDE the sprint. The fixture the Epic-4 at-scale Scrum journey (Stories
 * 4.7.2 / 4.7.3) runs against. Reuses the SEED_BOARD_* size knobs and adds
 * SEED_SCRUM_BACKLOG_EVERY / SEED_SCRUM_UNESTIMATED_EVERY. See
 * scripts/seedLargeBoard.ts → seedLargeScrumSprint.
 */
/* eslint-disable no-console -- a CLI dev script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import type { Prisma, WorkItemKind } from '@prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  seedLargeBoard,
  seedLargeScrumSprint,
  SEED_LARGE_BOARD_DEFAULTS,
  SEED_LARGE_OWNER_EMAIL,
  SEED_LARGE_OWNER_PASSWORD,
  type SeedLargeBoardManifest,
  type SeedLargeScrumSprintManifest,
} from './seedLargeBoard';

const SEED_EMAIL = SEED_LARGE_OWNER_EMAIL;
const SEED_PASSWORD = SEED_LARGE_OWNER_PASSWORD;
const SEED_WORKSPACE_NAME = 'Seed — Large (finding #57)';
const SEED_PROJECT_NAME = 'Large backlog';
const SEED_PROJECT_IDENTIFIER = 'BIG';

const n = (env: string, dflt: number) => {
  const v = Number(process.env[env]);
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : dflt;
};
const ROOTS = n('SEED_ROOTS', 60); // → ~2 List pages of roots, roots paginate in the tree
const BIG_CHILDREN = n('SEED_BIG_CHILDREN', 130); // epic[0] → "Load more children" (50/50/30)
const DEEP_CHILDREN = n('SEED_DEEP_CHILDREN', 90); // a story under epic[0] → nested load-more
const SMALL_CHILDREN = n('SEED_SMALL_CHILDREN', 30); // the other epics

// SEED_SHAPE=board (Subtask 3.5.1) seeds the board-shaped variant instead of the
// tree/list shape — issues spread across columns + swimlanes + a Done-age spread,
// the fixture the Epic-3 at-scale board journey (3.5.2/3.5.3) runs against.
// SEED_SHAPE=scrum (Subtask 4.7.1) seeds the SPRINT-shaped variant: the same
// board-shaped distribution, but flipped to a scrum board with a large `active`
// sprint (story-point spread) + a `planned` carry-over target — the fixture the
// Epic-4 at-scale Scrum journey (4.7.2/4.7.3) runs against.
const SEED_SHAPE = (process.env.SEED_SHAPE ?? 'tree').toLowerCase();
const BOARD_MEMBERS = n('SEED_BOARD_MEMBERS', 6); // assignee-lane pool size
// SEED_SHAPE=scrum knobs (4.7.1): every Nth board issue stays in the backlog
// (scope catch-all); every Nth in-sprint issue is left unestimated.
const SCRUM_BACKLOG_EVERY = n('SEED_SCRUM_BACKLOG_EVERY', 7);
const SCRUM_UNESTIMATED_EVERY = n('SEED_SCRUM_UNESTIMATED_EVERY', 4);

/**
 * The assignee pool for the board-shaped seed — `count` workspace members the
 * cards round-robin across (group-by Assignee lanes). Idempotent: reuses the
 * member user rows by email when present (they survive the workspace clear,
 * which only cascades their membership), and re-adds membership each run.
 */
async function ensureBoardMembers(workspaceId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const email = `seed-large-board-m${i + 1}@motir.dev`;
    const existing = await db.user.findUnique({ where: { email } });
    const user =
      existing ??
      (await usersService.createUser({
        email,
        password: SEED_PASSWORD,
        name: `Board Member ${i + 1}`,
      }));
    await workspacesService.addMember({ userId: user.id, workspaceId, role: 'member' });
    ids.push(user.id);
  }
  return ids;
}

function printBoardSummary(
  identifier: string,
  memberCount: number,
  m: SeedLargeBoardManifest,
): void {
  const perStatus = m.statusKeys.map((k) => `${k}=${m.perStatus[k]}`).join('  ');
  console.log(`\n✅ Seeded ${m.created} board-shaped issues.`);
  console.log('────────────────────────────────────────────────────────');
  console.log(`  Sign in:    ${SEED_EMAIL} / ${SEED_PASSWORD}`);
  console.log(`  Workspace:  ${SEED_WORKSPACE_NAME}`);
  console.log(`  Project:    ${SEED_PROJECT_NAME} (${identifier})`);
  console.log(`  Columns:    ${perStatus}`);
  console.log(
    `  Tall col:   ${m.tallStatusKey} (${m.perStatus[m.tallStatusKey]} cards — virtualizes)`,
  );
  console.log(
    `  Assignees:  ${m.assigneeCount}/${memberCount} used + ${m.unassignedCount} unassigned (catch-all)`,
  );
  console.log(`  Epic lanes: ${m.epicLaneCount} + ${m.noEpicCount} with no epic (catch-all)`);
  console.log(
    `  Done-age:   ${m.terminalInWindow} in-window + ${m.terminalAgedOut} aged-out (trimmed)`,
  );
  console.log('  Then open  /boards  — every column filled, swimlanes by Assignee/Epic/Priority.');
  console.log('────────────────────────────────────────────────────────');
}

function printScrumSummary(
  identifier: string,
  memberCount: number,
  m: SeedLargeScrumSprintManifest,
): void {
  const perStatus = m.statusKeys.map((k) => `${k}=${m.perStatus[k]}`).join('  ');
  console.log(`\n✅ Seeded ${m.created} board-shaped issues into a large active sprint.`);
  console.log('────────────────────────────────────────────────────────');
  console.log(`  Sign in:    ${SEED_EMAIL} / ${SEED_PASSWORD}`);
  console.log(`  Workspace:  ${SEED_WORKSPACE_NAME}`);
  console.log(`  Project:    ${SEED_PROJECT_NAME} (${identifier}) — board flipped to SCRUM`);
  console.log(`  Sprint:     "${m.activeSprintName}" (active) — ${m.sprintIssueCount} issues`);
  console.log(`  Backlog:    ${m.backlogIssueCount} issues OUT of the sprint (scope catch-all)`);
  console.log(
    `  Points:     ${m.estimatedSprintIssueCount} estimated (${m.committedPoints} committed) + ` +
      `${m.sprintIssueCount - m.estimatedSprintIssueCount} unestimated`,
  );
  console.log(`  Carry-over: "${m.targetSprintName}" (planned target)`);
  console.log(`  Columns:    ${perStatus}`);
  console.log(
    `  Tall col:   ${m.tallStatusKey} (${m.perStatus[m.tallStatusKey]} cards — virtualizes)`,
  );
  console.log(
    `  Done-age:   ${m.terminalInWindow} in-window + ${m.terminalAgedOut} aged-out (trimmed)`,
  );
  console.log(
    `  Assignees:  ${m.assigneeCount}/${memberCount} used + ${m.unassignedCount} unassigned`,
  );
  console.log('  Then open  /boards  — the Scrum board over a large active sprint.');
  console.log('────────────────────────────────────────────────────────');
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:seed:large is a DEV tool — refusing to run under NODE_ENV=production.');
  }

  // ── Idempotent clear: drop this seed user's prior demo workspace(s) ────────
  const existingUser = await db.user.findUnique({ where: { email: SEED_EMAIL } });
  if (existingUser) {
    const memberships = await db.workspaceMembership.findMany({
      where: { userId: existingUser.id },
      include: { workspace: true },
    });
    for (const m of memberships) {
      if (m.workspace.name === SEED_WORKSPACE_NAME) {
        // Delete the work_items first (the self-FK parent is onDelete:NoAction,
        // so clear the set in one statement), then the workspace cascades the
        // project + memberships.
        await db.workItem.deleteMany({ where: { workspaceId: m.workspaceId } });
        await db.workspace.delete({ where: { id: m.workspaceId } });
      }
    }
  }

  // ── Tenant: a fixed user (reused if present) + a fresh workspace + project ──
  const owner =
    existingUser ??
    (await usersService.createUser({
      email: SEED_EMAIL,
      password: SEED_PASSWORD,
      name: 'Seed Owner',
    }));
  const { workspace } = await workspacesService.createWorkspace({
    name: SEED_WORKSPACE_NAME,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: SEED_PROJECT_NAME,
    identifier: SEED_PROJECT_IDENTIFIER,
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });

  // ── SEED_SHAPE=board (Subtask 3.5.1): the board-shaped at-scale fixture ─────
  if (SEED_SHAPE === 'board') {
    const memberIds = await ensureBoardMembers(workspace.id, BOARD_MEMBERS);
    console.log(`Seeding board-shaped issues across ${memberIds.length} assignees…`);
    const manifest = await seedLargeBoard(
      {
        workspaceId: workspace.id,
        projectId: project.id,
        projectIdentifier: project.identifier,
        ownerId: owner.id,
        memberIds,
      },
      // Full-size by default; tunable via SEED_BOARD_* envs.
      {
        epics: n('SEED_BOARD_EPICS', SEED_LARGE_BOARD_DEFAULTS.epics),
        storiesPerEpic: n('SEED_BOARD_STORIES_PER_EPIC', SEED_LARGE_BOARD_DEFAULTS.storiesPerEpic),
        rootStories: n('SEED_BOARD_ROOT_STORIES', SEED_LARGE_BOARD_DEFAULTS.rootStories),
        tallColumnExtra: n('SEED_BOARD_TALL_EXTRA', SEED_LARGE_BOARD_DEFAULTS.tallColumnExtra),
      },
    );
    // Pin the project active for the owner so the active-project-scoped /boards
    // route resolves it on sign-in (manual eyeballing + the at-scale E2E specs).
    await db.workspaceMembership.update({
      where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
    printBoardSummary(project.identifier, memberIds.length, manifest);
    return;
  }

  // ── SEED_SHAPE=scrum (Subtask 4.7.1): the sprint-shaped at-scale fixture ────
  if (SEED_SHAPE === 'scrum') {
    const memberIds = await ensureBoardMembers(workspace.id, BOARD_MEMBERS);
    console.log(`Seeding sprint-shaped issues across ${memberIds.length} assignees…`);
    const manifest = await seedLargeScrumSprint(
      {
        workspaceId: workspace.id,
        projectId: project.id,
        projectIdentifier: project.identifier,
        ownerId: owner.id,
        memberIds,
      },
      // Full-size by default; reuses the SEED_BOARD_* size knobs + adds the two
      // scrum knobs (SEED_SCRUM_BACKLOG_EVERY / SEED_SCRUM_UNESTIMATED_EVERY).
      {
        epics: n('SEED_BOARD_EPICS', SEED_LARGE_BOARD_DEFAULTS.epics),
        storiesPerEpic: n('SEED_BOARD_STORIES_PER_EPIC', SEED_LARGE_BOARD_DEFAULTS.storiesPerEpic),
        rootStories: n('SEED_BOARD_ROOT_STORIES', SEED_LARGE_BOARD_DEFAULTS.rootStories),
        tallColumnExtra: n('SEED_BOARD_TALL_EXTRA', SEED_LARGE_BOARD_DEFAULTS.tallColumnExtra),
        backlogSliceEvery: SCRUM_BACKLOG_EVERY,
        unestimatedEvery: SCRUM_UNESTIMATED_EVERY,
      },
    );
    // Pin the project active for the owner so the active-project-scoped /boards
    // route resolves it on sign-in (manual eyeballing + the at-scale E2E specs).
    await db.workspaceMembership.update({
      where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
    printScrumSummary(project.identifier, memberIds.length, manifest);
    return;
  }

  // ── Bulk create through the shipped allocate-key + repo.create dance ───────
  let created = 0;
  const tick = () => {
    created++;
    if (created % 250 === 0) process.stdout.write(`  …${created} issues\n`);
  };

  async function createItem(
    kind: WorkItemKind,
    title: string,
    parentId: string | null,
  ): Promise<string> {
    const id = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const key = await projectRepository.allocateWorkItemNumber(project.id, tx);
      const row = await workItemRepository.create(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          parentId,
          kind,
          key,
          identifier: `${project.identifier}-${key}`,
          title,
          reporterId: owner.id,
          position: String(key).padStart(8, '0'),
        },
        tx,
      );
      return row.id;
    });
    tick();
    return id;
  }

  console.log(`Seeding ${ROOTS} root epics…`);
  for (let r = 0; r < ROOTS; r++) {
    const epicId = await createItem('epic', `Epic ${r + 1}`, null);

    // The FIRST epic is the "big" one: many children (load-more) + a deep branch.
    if (r === 0) {
      for (let c = 0; c < BIG_CHILDREN; c++) {
        const storyId = await createItem('story', `Story ${r + 1}.${c + 1}`, epicId);
        if (c === 0) {
          for (let d = 0; d < DEEP_CHILDREN; d++) {
            const taskId = await createItem('task', `Task ${r + 1}.${c + 1}.${d + 1}`, storyId);
            if (d % 10 === 0)
              await createItem('subtask', `Subtask of ${r + 1}.${c + 1}.${d + 1}`, taskId);
          }
        }
      }
      continue;
    }

    // The rest: a handful of stories, a couple with a task or bug, for variety.
    for (let c = 0; c < SMALL_CHILDREN; c++) {
      const storyId = await createItem('story', `Story ${r + 1}.${c + 1}`, epicId);
      if (c % 7 === 0) await createItem('task', `Task ${r + 1}.${c + 1}.1`, storyId);
      if (c % 11 === 0) await createItem('bug', `Bug under ${r + 1}.${c + 1}`, storyId);
    }
  }

  console.log(`\n✅ Seeded ${created} issues.`);
  console.log('────────────────────────────────────────────────────────');
  console.log(`  Sign in:   ${SEED_EMAIL} / ${SEED_PASSWORD}`);
  console.log(`  Workspace: ${SEED_WORKSPACE_NAME}`);
  console.log(`  Project:   ${SEED_PROJECT_NAME} (${project.identifier})`);
  console.log('  Then open  /issues  — switch Tree ↔ List, expand nodes, page through.');
  console.log('────────────────────────────────────────────────────────');
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exitCode = 1;
  });
