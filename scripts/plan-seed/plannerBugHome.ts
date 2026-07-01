import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { keyForAppend } from '@/lib/workItems/positioning';
import {
  PLANNER_BUG_HOME_EPIC_TITLE,
  PLANNER_BUG_HOME_MARKER,
  PLANNER_BUG_HOME_STORY_TITLE,
} from '@/lib/ai/plannerBugHome';

// Seed the PLANNER-BUG HOME (MOTIR-1466) — a root Epic + a child Story into the
// `motir` project, so the AI self-learning loop (MOTIR-965 inward / MOTIR-967
// outward, via the MOTIR-1450 route) has a DURABLE parent to file `kind: bug`s
// under. A THIRD seed helper alongside `seedSystemPrincipal` / `seedGeneration
// TestProject` (mirroring their shape), split out so it is unit-testable without
// running the whole self-invoking `seed.ts`.
//
// **Why this exists.** The home was previously MCP-CREATED (Epic MOTIR-1464 /
// Story MOTIR-1465), so it was NOT durable: `pnpm db:seed` clear-and-rebuilds the
// `moooon` workspace and drops every MCP-created item, and a fresh env / CI DB
// never had it at all — leaving the configured parent key dangling and auto-bugs
// falling back to project-root. Seeding it (the same way MOTIR-1451 seeds the
// system principal) makes it exist in EVERY environment and survive reseeds.
//
// **Stable resolution, not a fixed key.** Seed keys are reallocated on every
// reseed, so the home is targeted by a stable MARKER (`PLANNER_BUG_HOME_MARKER`),
// resolved by the home story's TITLE — see `lib/ai/plannerBugHome.ts`. This
// helper only has to guarantee the titled Epic + Story exist; it deliberately
// does NOT try to pin a numeric key.
//
// **Idempotent across reseeds** the same way the tree pass is: the clear pass
// drops the whole `moooon` workspace (cascading its work items), so a plain
// create re-provisions the home cleanly each run — no upsert needed. The key
// differs each reseed (which is exactly why resolution is marker-based).

export interface SeedPlannerBugHomeInput {
  /** The meta workspace (`moooon`) the home is created in. */
  workspaceId: string;
  /** The meta project (`motir`) the Epic + Story live in. */
  projectId: string;
  /** The reporter for the two container items (the seed owner / project manager). */
  reporterId: string;
  /**
   * The last `position` fractional-index key the tree pass minted, so the home's
   * Epic + Story continue the SINGLE global ascending chain `seed.ts` maintains
   * (a globally-unique, valid fractional-index `position` per item — never a
   * shared or padded key, which would break board drag/move). Pass `null` to
   * start a fresh chain (a standalone seed / a test).
   */
  afterPosition: string | null;
}

export interface SeedPlannerBugHomeResult {
  /** The created home Epic's work_item id. */
  epicId: string;
  /** The created home Story's work_item id (the bug parent the marker resolves to). */
  storyId: string;
  /** The home Story's allocated `MOTIR-<n>` identifier (informational — NOT a
   *  stable handle; it drifts across reseeds, which is why resolution is by marker). */
  storyIdentifier: string;
  /** The last `position` minted (the Story's), so the caller can continue the chain. */
  lastPosition: string;
}

/**
 * Create the planner-bug home Epic + Story in the `motir` project and return
 * their ids. Both are created through the shipped `projectRepository`
 * (key allocation) + `workItemRepository` (create) path — the same create path
 * the tree pass uses — so the kind-parent triggers, key allocation, and
 * denormalized identifier all run unbypassed. The Story parents under the Epic
 * (story → epic is matrix-legal), and `kind: bug` under the Story is matrix-legal
 * — so the auto-bug's create succeeds once the marker resolves to this story.
 */
export async function seedPlannerBugHome(
  input: SeedPlannerBugHomeInput,
): Promise<SeedPlannerBugHomeResult> {
  const epicPosition = keyForAppend(input.afterPosition);
  const storyPosition = keyForAppend(epicPosition);

  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const project = await projectRepository.findById(input.projectId, tx);
    if (!project) throw new Error(`seedPlannerBugHome: project ${input.projectId} not found`);

    const epicKey = await projectRepository.allocateWorkItemNumber(project.id, tx);
    const epic = await workItemRepository.create(
      {
        workspaceId: input.workspaceId,
        projectId: project.id,
        parentId: null,
        kind: 'epic',
        key: epicKey,
        identifier: `${project.identifier}-${epicKey}`,
        title: PLANNER_BUG_HOME_EPIC_TITLE,
        status: 'todo',
        reporterId: input.reporterId,
        position: epicPosition,
      },
      tx,
    );

    const storyKey = await projectRepository.allocateWorkItemNumber(project.id, tx);
    const story = await workItemRepository.create(
      {
        workspaceId: input.workspaceId,
        projectId: project.id,
        parentId: epic.id,
        kind: 'story',
        key: storyKey,
        identifier: `${project.identifier}-${storyKey}`,
        title: PLANNER_BUG_HOME_STORY_TITLE,
        status: 'todo',
        reporterId: input.reporterId,
        position: storyPosition,
      },
      tx,
    );

    return {
      epicId: epic.id,
      storyId: story.id,
      storyIdentifier: story.identifier,
      lastPosition: storyPosition,
    };
  });
}

// Re-export the marker for callers that seed + reconcile config in one place.
export { PLANNER_BUG_HOME_MARKER };
