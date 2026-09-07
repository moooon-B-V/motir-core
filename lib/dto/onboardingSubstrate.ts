// WHAT A PROJECT ALREADY HAS — the substrate read's shape (Story MOTIR-4753 ·
// MOTIR-4756, moved here by MOTIR-4768).
//
// ⚠️ IT LIVES IN `lib/dto/` BECAUSE IT CROSSES THE CLIENT BOUNDARY. The type was
// declared beside the service that produces it, which was right until the plan
// window had to RENDER it: `PlanningReadingState` and `PlanningWorkspaceOverlay`
// are `'use client'` islands, and `tests/planning/planChangeArchitecture.test.ts`
// refuses — correctly — to let one of those import a service module at all. A
// service is `server-only`; its DTO is not, and `CLAUDE.md`'s layer table already
// says where a DTO goes.
//
// The service re-exports both names, so no caller moved.

/**
 * ONE CONNECTED REPOSITORY, as the reading state names it (MOTIR-4768).
 *
 * ⚠️ THE REF, NOT A DISPLAY NAME. `owner/name` is what the code graph is keyed
 * on and what a session's retrieval tools are bound to, so it is also what the
 * surface should say: naming the thing Motir is actually reading is the whole
 * point of the state that renders it.
 */
export type OnboardingSubstrateRepository = {
  /** `owner/name`, as the grant mirror holds it. */
  ref: string;
  /**
   * Has THIS repository got a code graph? Narrower than "connected", and the
   * distinction is what the row's sub-line says out loud — a
   * connected-but-unindexed repository is connected and its code cannot be READ
   * yet.
   */
  indexed: boolean;
};

/** What a project already has — a statement of fact, with no verdict attached. */
export type OnboardingSubstrate = {
  /**
   * Committed work items, counted up to {@link ONBOARDING_SUBSTRATE_ITEM_CAP}.
   *
   * ⚠️ READ IT WITH {@link OnboardingSubstrate.itemCountTruncated}. On its own
   * this number cannot distinguish *"the project has 200 items"* from *"the
   * project has 200 items and more"*, and the consumer downstream is about to
   * make a COMPLETENESS judgement out of it.
   */
  itemCount: number;
  /**
   * Did the count STOP at the cap? `true` means `itemCount` is a floor and not a
   * total.
   *
   * A capped count that presents as exact is precisely the input that turns a
   * careful judgement into a confident wrong one, which is why this is a
   * first-class field rather than an implementation detail of the read. The
   * surface that renders it says `200+`, never `200` (MOTIR-4768).
   */
  itemCountTruncated: boolean;
  /**
   * The connected repositories, BY NAME, each saying whether its code can be
   * read yet (MOTIR-4768).
   *
   * ⚠️ THIS IS NOT A WIDENING OF WHAT THE READ ANSWERS. The call already
   * resolved these refs — `repositoryConnected` and `repositoryIndexed` below
   * are computed FROM them and always have been — and threw them away. The
   * reading state has to NAME what it is reading (*"reading acme/widgets and 214
   * work items"* is the sentence the whole story is arguing for), and a boolean
   * cannot be named. So the same call returns what it already had in hand; no
   * new query, and no new question answered.
   */
  repositories: OnboardingSubstrateRepository[];
  /**
   * Is a git repository connected to this project's workspace at all?
   *
   * Derived from {@link OnboardingSubstrate.repositories} rather than counted
   * separately, so the two cannot disagree. Kept as its own field because it is
   * the question the entrance router and the planner's precondition ask, and
   * neither of them wants the list.
   */
  repositoryConnected: boolean;
  /**
   * Has at least one connected repository got a code graph?
   *
   * ⚠️ NARROWER THAN `repositoryConnected`, AND THE TWO ARE NOT INTERCHANGEABLE:
   * a connected-but-unindexed repository is connected and its code cannot be
   * READ yet. Scope note inherited from the ledger read: this answers *a first
   * graph EXISTS*, never *the graph is FRESH*.
   */
  repositoryIndexed: boolean;
};

/**
 * How many committed work items one substrate read looks at.
 *
 * ⚠️ THE SAME CAP THE DISCOVERY GROUNDING ALREADY USES —
 * `migrateOnboardingService`'s `findByProject(..., { take: 200 })`. It is named
 * here rather than repeated as a literal so the two cannot drift, and so the
 * number a consumer is told about is the number the read was taken at.
 */
export const ONBOARDING_SUBSTRATE_ITEM_CAP = 200;
