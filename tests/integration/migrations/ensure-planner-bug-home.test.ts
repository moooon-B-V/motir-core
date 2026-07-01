import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { PLANNER_BUG_HOME_EPIC_TITLE, PLANNER_BUG_HOME_STORY_TITLE } from '@/lib/ai/plannerBugHome';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-1466 (follow-up) — the `ensure_planner_bug_home` data migration is the
// NON-DESTRUCTIVE, idempotent backfill that provisions the planner-bug home into
// the deployed meta tenant on `migrate deploy` (replacing the db:seed helper; a
// reseed must never run against the live tenant). Real Postgres. We run the
// migration's raw SQL against a constructed meta tenant and assert it: creates
// the Epic + Story when absent, is idempotent, adopts an existing epic (adds only
// the missing story), and no-ops when the meta tenant doesn't exist.

const PASSWORD = 'hunter2hunter2';

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'prisma/migrations/20260701130000_ensure_planner_bug_home/migration.sql'),
  'utf8',
);

/** Run each `;`-terminated statement in the migration file. Strips `--` line
 *  comments first so a `;` inside a comment can't split a statement (real
 *  `migrate deploy` uses the simple protocol, which handles that natively). */
async function runMigration(): Promise<void> {
  const withoutComments = MIGRATION_SQL.split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  const statements = withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => /\binsert\b/i.test(s)); // each of the two statements ends in an INSERT
  for (const stmt of statements) {
    await db.$executeRawUnsafe(stmt);
  }
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** A META tenant: `moooon` org with isMeta=true, a `motir` project, + the system
 *  principal (the migration's reporter + guard target). */
async function makeMetaTenant() {
  const owner = await usersService.createUser({
    email: 'owner@example.com',
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'moooon',
    ownerUserId: owner.id,
  });
  await db.$transaction((tx: Prisma.TransactionClient) =>
    organizationRepository.update(workspace.organizationId, { isMeta: true }, tx),
  );
  const project = await projectsService.createProject({
    name: 'motir',
    identifier: 'MOTIR',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await seedSystemPrincipal({ workspaceId: workspace.id, projectId: project.id });
  return { owner, workspace, project };
}

async function homeItems(projectId: string) {
  const epic = await db.workItem.findFirst({
    where: { projectId, kind: 'epic', title: PLANNER_BUG_HOME_EPIC_TITLE },
  });
  const stories = await db.workItem.findMany({
    where: { projectId, kind: 'story', ...(epic ? { parentId: epic.id } : {}) },
    orderBy: { key: 'asc' },
  });
  return { epic, stories };
}

describe('ensure_planner_bug_home migration (MOTIR-1466)', () => {
  it('creates the Epic + child Story in the meta tenant when absent', async () => {
    const { project } = await makeMetaTenant();
    await runMigration();

    const { epic, stories } = await homeItems(project.id);
    expect(epic).not.toBeNull();
    expect(epic!.parentId).toBeNull(); // root epic
    expect(stories).toHaveLength(1);
    expect(stories[0]!.title).toBe(PLANNER_BUG_HOME_STORY_TITLE);
    expect(stories[0]!.parentId).toBe(epic!.id);
    // Valid, distinct fractional-index positions (never a padded/head-'0' key).
    expect(epic!.position.startsWith('0')).toBe(false);
    expect(stories[0]!.position > epic!.position).toBe(true);
    // Identifiers derived from the project key + allocated number.
    expect(epic!.identifier).toMatch(/^MOTIR-\d+$/);
    // Reporter is the seeded system principal.
    const sysUser = await db.user.findUnique({ where: { email: 'system@motir.internal' } });
    expect(epic!.reporterId).toBe(sysUser!.id);
  });

  it('is idempotent — a second run creates no duplicates', async () => {
    const { project } = await makeMetaTenant();
    await runMigration();
    await runMigration();

    const { stories } = await homeItems(project.id);
    const epics = await db.workItem.count({
      where: { projectId: project.id, kind: 'epic', title: PLANNER_BUG_HOME_EPIC_TITLE },
    });
    expect(epics).toBe(1);
    expect(stories).toHaveLength(1);
  });

  it('adopts an existing home epic — adds only the missing story, no duplicate epic', async () => {
    const { owner, workspace, project } = await makeMetaTenant();
    // Simulate the live tenant's MCP-created epic (present, but no story child yet).
    const ctx = { userId: owner.id, workspaceId: workspace.id };
    const { workItemsService } = await import('@/lib/services/workItemsService');
    const epic = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'epic', title: PLANNER_BUG_HOME_EPIC_TITLE },
      ctx,
    );

    await runMigration();

    const epics = await db.workItem.count({
      where: { projectId: project.id, kind: 'epic', title: PLANNER_BUG_HOME_EPIC_TITLE },
    });
    expect(epics).toBe(1); // adopted, not duplicated
    const stories = await db.workItem.findMany({
      where: { projectId: project.id, kind: 'story', parentId: epic.id },
    });
    expect(stories).toHaveLength(1);
    expect(stories[0]!.title).toBe(PLANNER_BUG_HOME_STORY_TITLE);
  });

  it('adopts an existing epic WITH a differently-titled story child — no new story (the live 1465 case)', async () => {
    const { owner, workspace, project } = await makeMetaTenant();
    const ctx = { userId: owner.id, workspaceId: workspace.id };
    const { workItemsService } = await import('@/lib/services/workItemsService');
    const epic = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'epic', title: PLANNER_BUG_HOME_EPIC_TITLE },
      ctx,
    );
    // The restored live story carries a parenthetical suffix — still the epic's
    // story child, so the migration must NOT add another.
    await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: 'story',
        title: 'Captured planning-mistake bugs (the 7.6.8 inward loop)',
        parentId: epic.id,
      },
      ctx,
    );

    await runMigration();

    const stories = await db.workItem.findMany({
      where: { projectId: project.id, kind: 'story', parentId: epic.id },
    });
    expect(stories).toHaveLength(1); // the existing child is adopted; none created
  });

  it('no-ops when the meta tenant does not exist (fresh / CI / preview DB)', async () => {
    // A non-meta tenant only — the guard (org.isMeta + project name=motir) misses.
    const owner = await usersService.createUser({
      email: 'other@example.com',
      password: PASSWORD,
      name: 'Other',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'acme',
      ownerUserId: owner.id,
    });
    const project = await projectsService.createProject({
      name: 'acme-app',
      identifier: 'ACME',
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    await runMigration(); // must not throw

    const count = await db.workItem.count({ where: { projectId: project.id } });
    expect(count).toBe(0);
  });
});
