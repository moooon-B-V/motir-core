/**
 * `pnpm db:backfill:bug-destinations` — give every EXISTING project a bug
 * destination (Story MOTIR-4927 · Subtask MOTIR-4936).
 *
 * `insertProjectWithSeedsInTx` seeds a container for every project created from
 * MOTIR-4935 onward. This is the other half: the projects that already existed.
 * Together they are what turns `ensure_planner_bug_home`'s ONE-SHOT data
 * migration into a standing invariant — that migration's own header says "a
 * migration runs EXACTLY ONCE per database: it is a one-shot backfill, not a
 * standing guarantee", and every project created after it ran has had no home at
 * all, with `aiWorkItemsService.fileBug` raising a 500 against them.
 *
 * TWO OUTCOMES per project, decided by what it already has:
 *   * it already carries the LEGACY title-matched home  -> POINT AT THAT HOME.
 *     Nothing is created, renamed, re-kinded or moved. This is the meta tenant,
 *     and `PLANNER_BUG_HOME_STORY_TITLE` keeps meaning exactly what it meant.
 *   * anything else                                     -> SEED a container and
 *     point at it, through the same seam `createProject` uses.
 *
 * IDEMPOTENT + SAFE TO RE-RUN: it sweeps only projects with a NULL pointer, and
 * `backfillDestination` re-checks inside the tenant transaction, so a project
 * that gained one between the query and the write is a no-op.
 *
 * ⚠️ **RUN IT BEFORE MOTIR-4938 SHIPS THE DESTINATION PICKER.** `null` is a
 * MEANINGFUL value — it means the project ROOT — so once a person can choose the
 * root, a null pointer stops being evidence of "not configured yet" and this
 * sweep can no longer tell a team's deliberate choice from a project it never
 * reached. Until the picker exists that ambiguity cannot arise, which is the
 * whole reason this is an operator script run once rather than a reconciler on a
 * timer. After the picker ships: do not run it again.
 *
 * The per-project actor is the workspace OWNER, falling back to any member —
 * `withWorkspaceContext` binds that user's GUC so the FORCE-RLS writes pass
 * under the non-bypass `motir_app` role, and the seeded container needs a real
 * `reporterId` (NOT NULL, `onDelete: Restrict`).
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { bugDestinationService } from '@/lib/services/bugDestinationService';
import { WORKSPACE_ROLE } from '@/lib/workspaces/roles';

async function resolveActorUserId(workspaceId: string): Promise<string | null> {
  const owner = await db.workspaceMembership.findFirst({
    where: { workspaceId, role: WORKSPACE_ROLE.owner },
    orderBy: { createdAt: 'asc' },
  });
  if (owner) return owner.userId;
  const member = await db.workspaceMembership.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  });
  return member?.userId ?? null;
}

async function main() {
  const projects = await db.project.findMany({
    where: { bugDestinationId: null },
    select: { id: true, name: true, workspaceId: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`[backfill-bug-destinations] ${projects.length} project(s) with no destination.`);

  let seeded = 0;
  let adopted = 0;
  let skipped = 0;
  let unresolved = 0;

  for (const project of projects) {
    const actorUserId = await resolveActorUserId(project.workspaceId);
    if (!actorUserId) {
      unresolved += 1;
      console.warn(
        `[backfill-bug-destinations] SKIP ${project.id} (${project.name}) — no workspace member to act as.`,
      );
      continue;
    }

    const outcome = await bugDestinationService.backfillDestination(project.id, actorUserId);
    switch (outcome) {
      case 'seeded_container':
        seeded += 1;
        console.log(
          `[backfill-bug-destinations] seeded a container for ${project.id} (${project.name}).`,
        );
        break;
      case 'pointed_at_legacy_home':
        adopted += 1;
        console.log(
          `[backfill-bug-destinations] pointed ${project.id} (${project.name}) at its EXISTING home.`,
        );
        break;
      case 'already_pointed':
        skipped += 1;
        break;
    }
  }

  console.log(
    `[backfill-bug-destinations] done — ${seeded} seeded, ${adopted} pointed at an existing home, ` +
      `${skipped} already pointed, ${unresolved} unresolved.`,
  );
}

main()
  .catch((err) => {
    console.error('[backfill-bug-destinations] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
