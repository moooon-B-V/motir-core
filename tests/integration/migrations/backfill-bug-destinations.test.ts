import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PLANNER_BUG_HOME_STORY_TITLE } from '@/lib/ai/plannerBugHome';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The `backfill_project_bug_destinations` data migration — Story MOTIR-4927 ·
// Subtask MOTIR-4936.
//
// MOTIR-4935 seeds a container for every NEW project; this migration reaches the
// ones that already existed, so `migrate deploy` leaves NO project in the
// *undecided* state — which is the card's load-bearing criterion and the thing a
// script alone cannot guarantee, because a script only fixes the databases
// somebody remembers to run it against.
//
// A project that predates the pointer is simulated by clearing it. That is the
// only state the migration acts on, which is also what makes it safe.

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260912010000_backfill_project_bug_destinations/migration.sql',
  ),
  'utf8',
);

/** Replay the migration's statements, comments stripped first so a `;` inside
 *  one cannot split a statement (real `migrate deploy` uses the simple protocol,
 *  which handles that natively). Mirrors `ensure-planner-bug-home.test.ts`. */
async function runMigration(): Promise<void> {
  const withoutComments = MIGRATION_SQL.split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  const statements = withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await adminDb.$executeRawUnsafe(stmt);
  }
}

let seq = 0;

async function makeProject(tag: string) {
  const n = seq++;
  const user = await usersService.createUser({
    email: `bf-mig-${tag}-${n}@example.com`,
    password: 'hunter2hunter2',
    name: `Owner ${tag}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${tag} ${n}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: `Project ${tag} ${n}`,
  });
  return {
    userId: user.id,
    workspaceId: workspace.id,
    projectId: project.id,
    ctx: { userId: user.id, workspaceId: workspace.id },
  };
}

/** A project as it stood BEFORE MOTIR-4934 — no pointer at all. */
async function asPreBackfill(projectId: string): Promise<void> {
  await adminDb.project.update({ where: { id: projectId }, data: { bugDestinationId: null } });
}

async function pointerOf(projectId: string): Promise<string | null> {
  return (await adminDb.project.findUniqueOrThrow({ where: { id: projectId } })).bugDestinationId;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ───────────────────────────────────────────────────────────────────────────

describe('backfill_project_bug_destinations', () => {
  it('leaves NO project undecided — both populations in ONE database', async () => {
    // The card's headline criterion, and it is asserted with both shapes present
    // at once rather than one per test, because the migration is a single sweep
    // and the interesting claim is that it handles them together.
    const legacy = await makeProject('legacy');
    const fresh = await makeProject('fresh');
    await asPreBackfill(legacy.projectId);
    await asPreBackfill(fresh.projectId);
    const home = await workItemsService.createWorkItem(
      { projectId: legacy.projectId, kind: 'story', title: PLANNER_BUG_HOME_STORY_TITLE },
      legacy.ctx,
    );

    await runMigration();

    expect(await adminDb.project.count({ where: { bugDestinationId: null } })).toBe(0);
    // Population 1 ADOPTED its existing home; population 2 got a new container.
    expect(await pointerOf(legacy.projectId)).toBe(home.id);
    const freshPointer = await pointerOf(fresh.projectId);
    const container = await adminDb.workItem.findUniqueOrThrow({ where: { id: freshPointer! } });
    expect(container.kind).toBe('task');
    expect(container.projectId).toBe(fresh.projectId);
  });

  it('creates NO second container for a project that already has a home, and leaves it untouched', async () => {
    const fx = await makeProject('untouched');
    await asPreBackfill(fx.projectId);
    const home = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: PLANNER_BUG_HOME_STORY_TITLE },
      fx.ctx,
    );
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: home.id } });
    const countBefore = await adminDb.workItem.count({ where: { projectId: fx.projectId } });

    await runMigration();

    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(countBefore);
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: home.id } });
    // Byte-identical on every field the card names: the legacy resolver must keep
    // resolving for the meta tenant exactly as it did.
    expect(after.title).toBe(before.title);
    expect(after.kind).toBe(before.kind);
    expect(after.parentId).toBe(before.parentId);
    expect(after.title).toBe(PLANNER_BUG_HOME_STORY_TITLE);
  });

  it('gives the seeded container a LEGAL identifier, key and status from the project itself', async () => {
    const fx = await makeProject('legal');
    await asPreBackfill(fx.projectId);

    await runMigration();

    const container = await adminDb.workItem.findUniqueOrThrow({
      where: { id: (await pointerOf(fx.projectId))! },
    });
    const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    const initial = await adminDb.workflowStatus.findFirstOrThrow({
      where: { projectId: fx.projectId, isInitial: true },
    });

    // The key is ALLOCATED off the project's counter, never guessed…
    expect(container.identifier).toBe(`${project.identifier}-${container.key}`);
    expect(project.lastWorkItemNumber).toBe(container.key);
    // …and the status is the project's OWN initial one, not a hardcoded 'todo',
    // so a customised workflow still gets a legal row.
    expect(container.status).toBe(initial.key);
    expect(container.reporterId).toBe(fx.userId);
  });

  it('is a NO-OP the second time — running it twice changes nothing', async () => {
    const fx = await makeProject('twice');
    await asPreBackfill(fx.projectId);

    await runMigration();
    const pointerAfterFirst = await pointerOf(fx.projectId);
    const countAfterFirst = await adminDb.workItem.count({ where: { projectId: fx.projectId } });

    await runMigration();

    expect(await pointerOf(fx.projectId)).toBe(pointerAfterFirst);
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(
      countAfterFirst,
    );
  });

  it('backfills an ARCHIVED project too — the card decides INCLUDE, and here is why', async () => {
    // An archive is a SOFT remove and is reversible. A restored project that came
    // back as the one project with no destination would be exactly the
    // *undecided* state this migration exists to eliminate, and it would surface
    // long after anybody remembered why. One row each is the whole cost.
    const fx = await makeProject('archived');
    await asPreBackfill(fx.projectId);
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { archivedAt: new Date() },
    });

    await runMigration();

    expect(await pointerOf(fx.projectId)).not.toBeNull();
  });

  it('never points at an ARCHIVED legacy home — it seeds a fresh container instead', async () => {
    // The mirror of the rule above, one level down: an archived WORK ITEM is not
    // a usable destination, because the resolver would fall straight back from it
    // to the root. Adopting one would look like a successful backfill and behave
    // like none at all.
    const fx = await makeProject('archived-home');
    await asPreBackfill(fx.projectId);
    const home = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: PLANNER_BUG_HOME_STORY_TITLE },
      fx.ctx,
    );
    await adminDb.workItem.update({ where: { id: home.id }, data: { archivedAt: new Date() } });

    await runMigration();

    const pointer = await pointerOf(fx.projectId);
    expect(pointer).not.toBe(home.id);
    const container = await adminDb.workItem.findUniqueOrThrow({ where: { id: pointer! } });
    expect(container.kind).toBe('task');
    expect(container.archivedAt).toBeNull();
  });

  it('does NOT overwrite a destination that is already set', async () => {
    const fx = await makeProject('set');
    const elsewhere = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Our own triage bucket' },
      fx.ctx,
    );
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { bugDestinationId: elsewhere.id },
    });

    await runMigration();

    expect(await pointerOf(fx.projectId)).toBe(elsewhere.id);
  });
});
