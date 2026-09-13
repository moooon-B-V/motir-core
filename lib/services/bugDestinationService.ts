import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  withSystemContext,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';
import { workItemsService } from '@/lib/services/workItemsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { PLANNER_BUG_HOME_STORY_TITLE } from '@/lib/ai/plannerBugHome';

// WHERE DOES A BUG GO IN THIS PROJECT? — Story MOTIR-4927 · Subtask MOTIR-4937.
//
// ONE function answers it, and every filer calls this one. Before this seam
// there were two answers: `project.bugDestinationId` (the pointer, MOTIR-4934)
// and a project-wide title match against `PLANNER_BUG_HOME_STORY_TITLE` (the
// legacy resolver in `lib/ai/plannerBugHome.ts`). Two resolvers with different
// fallbacks answering one question is the condition this card exists to end, and
// the failure it produces is invisible until the first person renames a
// container.
//
// ⚠️ A CALLER NEVER RECEIVES A `parentId` NAMING AN ARCHIVED OR DELETED ITEM,
// under any branch. That is the property the whole seam is for: a person tidying
// their board must not be able to turn filing into an outage, and a resolver
// that handed back a dangling id would push the failure into a create call that
// reports a foreign-key error nobody can act on.

/**
 * WHY the destination is what it is. A caller can tell a CHOSEN root from a
 * RECOVERED one, which is the difference between "the team wanted this" and
 * "something they pointed at went away".
 */
export type BugDestinationReason =
  /** The pointer is set and its container is healthy. The normal answer. */
  | 'configured'
  /** The pointer is set but its container is ARCHIVED — recovered to the root.
   *  Archiving is a soft remove that leaves the row, so no foreign-key action
   *  can see it; this branch is the only thing that can. */
  | 'container_archived'
  /** The pointer is null: the project root, parentless, deliberately. */
  | 'root_selected'
  /** TRANSITIONAL (see the note on `resolve`): the pointer is null and the
   *  project still carries a legacy title-matched home, so filing keeps landing
   *  where it always did until MOTIR-4936's backfill reaches this project. */
  | 'legacy_title_home';

export interface BugDestination {
  /** The container to file under, or `null` for the PROJECT ROOT. Never the id
   *  of an archived or deleted work item. */
  parentId: string | null;
  reason: BugDestinationReason;
}

export const bugDestinationService = {
  /**
   * Resolve the project's bug destination.
   *
   * ```
   * pointer set   + container healthy   -> that container   ('configured')
   * pointer set   + container ARCHIVED  -> the ROOT         ('container_archived')
   * pointer null  + a legacy home       -> that home        ('legacy_title_home')  [transitional]
   * pointer null  + no legacy home      -> the ROOT         ('root_selected')
   * ```
   *
   * ⚠️ **A DELETED container arrives here as `null`, not as a dangling id, and
   * that is by construction rather than by omission.** MOTIR-4934 gave the
   * foreign key `ON DELETE SET NULL` precisely so the truth lands IN the column
   * — so by the time this function runs, "the container was deleted" and "the
   * pointer is null" are the same state and no branch can tell them apart. The
   * card's branch 2 names ARCHIVED *and* DELETED together; only the archived
   * limb is reachable, and the deleted limb is discharged one layer down by the
   * FK. The outcome the story asks for is identical either way: the root, and
   * never a dangling id.
   *
   * ⚠️ **`legacy_title_home` IS TRANSITIONAL AND HAS A REMOVAL CARD.** It exists
   * so this seam is safe to ship BEFORE MOTIR-4936's backfill has run
   * everywhere: a project the backfill has not reached has a null pointer that
   * means "not configured yet" rather than "the team chose the root", and
   * falling through to the legacy lookup is what keeps the meta tenant filing
   * during that window. Once every project carries a pointer, this branch is
   * dead and the story's own boundary says retiring the title lookup is a
   * separate forward card. **Do not build anything new on this branch.**
   *
   * Its cost while it lives, stated rather than discovered: in a project that
   * BOTH carries a legacy-titled story AND has deliberately chosen the root, the
   * legacy home wins. That window closes at the backfill, and it cannot be
   * entered before MOTIR-4938 ships the picker, since until then nothing can
   * choose the root.
   */
  async resolve(projectId: string, workspaceId: string): Promise<BugDestination> {
    return withWorkspaceServiceContext(workspaceId, async (tx) => {
      const project = await projectRepository.findById(projectId, tx);
      if (!project) throw new ProjectNotFoundError(projectId);

      if (project.bugDestinationId != null) {
        const container = await workItemRepository.findById(project.bugDestinationId, tx);
        // A pointer whose row is not readable here is treated exactly like an
        // archived one — the root, with a reason. It cannot be a cross-tenant
        // row (the database refuses that, `trg_project_bug_destination_tenancy`)
        // and it cannot be a deleted one (the FK nulled it), so in practice this
        // is the archived case; the `!container` arm is the belt to its braces
        // and must never become a throw.
        if (container && container.archivedAt === null) {
          return { parentId: container.id, reason: 'configured' as const };
        }
        return { parentId: null, reason: 'container_archived' as const };
      }

      // TRANSITIONAL — see the note above. `findByProjectKindAndTitle` already
      // excludes archived rows, so this cannot resurrect an archived home.
      const legacy = await workItemRepository.findByProjectKindAndTitle(
        projectId,
        'story',
        PLANNER_BUG_HOME_STORY_TITLE,
        tx,
      );
      if (legacy) return { parentId: legacy.id, reason: 'legacy_title_home' as const };

      return { parentId: null, reason: 'root_selected' as const };
    });
  },

  /**
   * ONE-TIME BACKFILL of a project that predates the pointer — Subtask
   * MOTIR-4936. Gives every existing project a destination, so no project is
   * left without one and `resolve`'s transitional branch can eventually be
   * retired.
   *
   * Two outcomes, and which one applies is decided by what the project ALREADY
   * has:
   *
   *   * a project that already carries a LEGACY title-matched home gets a
   *     POINTER AT THAT HOME — it is not given a second container, and the
   *     existing one is not renamed, re-kinded or moved. This is the meta
   *     tenant's case, and `PLANNER_BUG_HOME_STORY_TITLE` keeps meaning exactly
   *     what it meant;
   *   * any other project gets a freshly seeded container and a pointer at it.
   *
   * ⚠️ **IT MUST NEVER FILL A NULL THAT SOMEBODY CHOSE**, and that is the one
   * way this method could do real damage: `null` is the ROOT, a first-class
   * choice, so a sweep that "tidies" every null would silently move a team's
   * incoming bugs out of the place they deliberately put them. Two things keep
   * that safe, and both are load-bearing:
   *
   *   1. **It is a no-op for any project that ALREADY has a pointer** — so
   *      re-running it is free, which is what makes it safe as operator tooling.
   *   2. ⚠️ **IT MUST RUN BEFORE MOTIR-4938 SHIPS THE PICKER.** Until a person
   *      can choose the root, a null pointer can only mean *not configured yet*,
   *      and the ambiguity this method cannot resolve does not exist. After the
   *      picker ships, a null is no longer evidence of anything and this sweep
   *      must not be run again. That ordering is the reason it is a script an
   *      operator runs once rather than a reconciler on a timer.
   *
   * Returns what it did, so the sweep can report rather than guess.
   */
  async backfillDestination(
    projectId: string,
    actorUserId: string,
  ): Promise<'already_pointed' | 'pointed_at_legacy_home' | 'seeded_container'> {
    // The OPENING read is the one context nothing can supply: the sweep hands
    // this a bare projectId and the workspace is what the read RESOLVES. That is
    // exactly the case `project_workspace_or_system_read`'s `app.system_admin`
    // arm exists for, and it is how `boardsService.backfillDefaultBoard` does
    // the same thing. Everything after runs tenant-scoped.
    const project = await withSystemContext((tx) => projectRepository.findById(projectId, tx));
    if (!project) throw new ProjectNotFoundError(projectId);

    return withWorkspaceContext(
      { userId: actorUserId, workspaceId: project.workspaceId },
      async (tx) => {
        // Re-read INSIDE the tenant transaction rather than trusting the system
        // read above: a project that gained a pointer between the sweep's query
        // and this call must be a no-op, which is what makes re-running free.
        const current = await projectRepository.findById(projectId, tx);
        if (!current) throw new ProjectNotFoundError(projectId);
        if (current.bugDestinationId != null) return 'already_pointed' as const;

        const legacy = await workItemRepository.findByProjectKindAndTitle(
          projectId,
          'story',
          PLANNER_BUG_HOME_STORY_TITLE,
          tx,
        );
        if (legacy) {
          await projectRepository.updateBugDestination(projectId, legacy.id, tx);
          return 'pointed_at_legacy_home' as const;
        }

        const container = await workItemsService.seedBugContainer(
          projectId,
          project.workspaceId,
          actorUserId,
          tx,
        );
        await projectRepository.updateBugDestination(projectId, container.id, tx);
        return 'seeded_container' as const;
      },
    );
  },
};
