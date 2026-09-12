// The BUG CONTAINER a project is born with — Story MOTIR-4927 · Subtask
// MOTIR-4935. `insertProjectWithSeedsInTx` creates one beside the default
// workflow and the default board, and points `project.bugDestinationId` at it.
//
// **Why seeding at creation, and not a migration.** The planner-bug home exists
// today only because the `ensure_planner_bug_home` data migration created one,
// and `lib/ai/plannerBugHome.ts` states the consequence in its own header: *"a
// migration runs EXACTLY ONCE per database: it is a one-shot backfill, not a
// standing guarantee."* Every project created since has had no home at all, and
// `aiWorkItemsService.fileBug` raises `PlannerBugHomeNotProvisionedError` → 500
// against them. Seeding on the event that makes a project exist is the only
// shape that cannot drift.
//
// ⚠️ **THE TITLE BELOW IS A LABEL, NOT A LOOKUP KEY, AND THAT IS THE WHOLE
// POINT OF THE STORY.** The destination is a POINTER (`project.bug_destination_id`).
// Nothing may resolve this container by matching its title — a user who renames
// their container must not thereby break filing, which is exactly the fragility
// the legacy `PLANNER_BUG_HOME_STORY_TITLE` lookup has. So this constant is
// imported by the SEED and by TESTS, and by nothing that reads.
// `tests/projects/bugContainerSeed.test.ts` asserts that, by enumerating the
// importers rather than by trusting this comment.

/** The seeded container's title. A default a team is free to rename. */
export const DEFAULT_BUG_CONTAINER_TITLE = 'Bugs';

/** The seeded container's body — it says what the container is FOR, because a
 *  bucket that arrives in a fresh project with no explanation reads as clutter
 *  somebody else created. */
export const DEFAULT_BUG_CONTAINER_DESCRIPTION_MD = [
  'Filed bugs land here.',
  '',
  'This container was created with the project. You can rename it, move it, file',
  'into it by hand, or point this project somewhere else entirely — including at',
  'the project root, so incoming bugs are top-level and impossible to miss.',
  'Project settings → Bugs is where that choice lives.',
].join('\n');

/** The container's KIND, and it is a decision rather than a default
 *  (Story MOTIR-4927). A `story` is one feature along a user journey with a
 *  verification recipe; a permanent bucket for incoming defects is not that, and
 *  the legacy home is a `story` only by convention. `task → bug` is legal in the
 *  kind-parent matrix (`lib/issues/parentRules.ts`), so a `task` holds bugs
 *  correctly — and every rollup, report and journey audit that reads kinds is
 *  spared a story that is never finished because it is a bucket. */
export const DEFAULT_BUG_CONTAINER_KIND = 'task' as const;
