/**
 * `pnpm db:backfill:boards` — backfill the default Kanban board (Subtask
 * 3.1.2) onto every project that predates Story 3.1 (a project with a workflow
 * but no board). One-off operator tooling: the seed reseeds the `moooon` tenant
 * wholesale, but real projects created before this Story have no board.
 *
 * IDEMPOTENT + SAFE TO RE-RUN: it sweeps only board-LESS projects
 * (`boards: { none: {} }`), and `boardsService.backfillDefaultBoard` re-checks
 * for an existing board before seeding, so a project that gained a board
 * between the sweep query and the seed is a no-op. Every project's board is
 * persisted through the shipped repositories under its workspace context (no
 * raw inserts) — the same path `createProject` uses.
 *
 * The per-project actor is the workspace OWNER (the creator tier — roles.ts),
 * falling back to any member: `withWorkspaceContext` binds that user's GUC so
 * the FORCE-RLS board writes pass under the non-bypass prodect_app role. (Under
 * the dev/CI BYPASSRLS superuser the GUC is moot, but we bind a real member so
 * the path is production-correct.)
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { WORKSPACE_ROLE } from '@/lib/workspaces/roles';

async function resolveActorUserId(workspaceId: string): Promise<string | null> {
  const owner = await db.workspaceMembership.findFirst({
    where: { workspaceId, role: WORKSPACE_ROLE.owner },
    orderBy: { createdAt: 'asc' },
  });
  if (owner) return owner.userId;
  // No owner row (older workspaces predating the owner tier) — any member can
  // bind the GUC; the board writes gate on workspace_id, not user_id.
  const member = await db.workspaceMembership.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  });
  return member?.userId ?? null;
}

async function main() {
  const projects = await db.project.findMany({
    where: { boards: { none: {} } },
    select: { id: true, name: true, workspaceId: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`[backfill-boards] ${projects.length} board-less project(s) to consider.`);

  let created = 0;
  let skipped = 0;
  let unresolved = 0;

  for (const project of projects) {
    const actorUserId = await resolveActorUserId(project.workspaceId);
    if (!actorUserId) {
      unresolved += 1;
      console.warn(
        `[backfill-boards] SKIP ${project.id} (${project.name}) — no workspace member to act as.`,
      );
      continue;
    }
    const didSeed = await boardsService.backfillDefaultBoard(project.id, actorUserId);
    if (didSeed) {
      created += 1;
      console.log(`[backfill-boards] seeded board for ${project.id} (${project.name}).`);
    } else {
      skipped += 1;
    }
  }

  console.log(
    `[backfill-boards] done — ${created} seeded, ${skipped} already had a board, ` +
      `${unresolved} unresolved.`,
  );
}

main()
  .catch((err) => {
    console.error('[backfill-boards] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
