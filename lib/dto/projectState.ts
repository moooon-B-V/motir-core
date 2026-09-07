import type { MigrateIndexStatusDto, MigrateOnboardingDto } from '@/lib/dto/migrateOnboarding';
import type { ProjectRepoDto } from '@/lib/dto/projectRepos';

// The project's PLANNING PRECONDITIONS as one read (MOTIR-1968) — the
// configuration state an agent planning over the MCP must be able to VERIFY
// instead of assert.
//
// Every field is a projection of something the app already computes: the
// established-project verdict is `resolvePlanningHostGate`'s, the per-repo index
// state is the migrate wizard's `MigrateIndexStatusDto`, the repository set is
// `projectRepoSetService`'s, the onboarding run is `MigrateOnboardingDto`. No
// shape is invented here and none is widened — a consumer that already knows one
// of those shapes reads this one for free, and a change to any of them lands here
// automatically rather than drifting from a private copy.
//
// EVERY field is always present. A project with nothing configured reports
// `installed: false`, an empty index status, an empty `repoSet` and a null
// `onboarding` — never an omitted key and never an error, because a planner has
// to be able to tell "there is no code" from "I could not look".

/** The project the state belongs to — enough to confirm you read the right one. */
export interface ProjectStateProjectDto {
  /** The project KEY — exactly what `projectKey` takes elsewhere. */
  key: string;
  /** The opaque project id. */
  id: string;
  name: string;
  /**
   * The immutable onboarding-ran marker (Subtask 7.4 / MOTIR-1264) — the ISO
   * timestamp the project's first plan was approved + materialized, or null when
   * the project NEVER onboarded. Carried alongside the derived gate so a reader
   * can see the INPUT the verdict came from, not just the verdict.
   */
  onboardingRanAt: string | null;
}

/** Is code connected to the workspace, and is it INDEXED? */
export interface ProjectCodeStateDto {
  /**
   * Whether the workspace has a GitHub App installation at all. Distinct from
   * `index.total === 0`: an installation whose grant covers no repos is a
   * DIFFERENT state from no installation, and the two need different fixes
   * (widen the grant vs. install the App). `resolveCodeContext` collapses both
   * to `undefined`, which is why this flag is carried explicitly.
   */
  installed: boolean;
  /**
   * The connected repo set with each repo's index state — the SHIPPED
   * `MigrateIndexStatusDto` (the migrate wizard's Index step polls the same
   * shape), including its honest aggregate `hasRunning`: the ledger cannot tie a
   * RUNNING index row to one repo, so in-flight is a set-level fact.
   *
   * `pending` means "no succeeded index run matches this repo's ref" — which is
   * exactly the MOTIR-1961 state a repo connected before the index feature
   * shipped sits in, and the state that was twice asserted away.
   */
  index: MigrateIndexStatusDto;
}

/**
 * Whether a project has ever had a plan APPROVED — `onboarding` for one that has
 * not, `workspace` for one that has.
 *
 * ⚠️ THIS IS NO LONGER `resolvePlanningHostGate`'s VERDICT, AND THE CHANGE IS THE
 * POINT (MOTIR-4765). The two questions shared one function and one type until
 * that card, and the sharing is what produced the defect the story exists for:
 *
 *   | question                          | answered by                    |
 *   | --------------------------------- | ------------------------------ |
 *   | *may this actor open the window?* | `resolvePlanningHostGate`      |
 *   | *has this project a plan yet?*    | THIS — read off the marker     |
 *
 * The host gate has no `onboarding` verdict any more: a never-onboarded project
 * opens the workspace like any other, because whether it can be PLANNED is the
 * planner's judgement (MOTIR-4767) rather than a marker's. This report keeps
 * answering the second question — an agent asking `get_project_state` genuinely
 * wants to know whether a project has been planned — so it now reads
 * `project.onboardingRanAt` directly instead of borrowing a verdict that no
 * longer exists. **The field name, both values and every consumer's shape are
 * unchanged**; what changed is that the answer is derived where it is meant.
 */
export type ProjectPlanningGateDto = 'onboarding' | 'workspace';

/** A project's planning preconditions, as `get_project_state` reports them. */
export interface ProjectStateDto {
  project: ProjectStateProjectDto;
  /**
   * Established? See {@link ProjectPlanningGateDto}. Both values are reachable:
   * the two access questions that used to precede them are already answered by
   * the time this runs — the project was resolved by key (so there IS one) and
   * browse access was asserted (so the caller may see it), and a failure of
   * either surfaces as a not-found tool error rather than a verdict.
   */
  planningGate: ProjectPlanningGateDto;
  code: ProjectCodeStateDto;
  /**
   * The PROJECT's repository set (MOTIR-1780) — deliberately distinct from
   * `code.index.repos`, which is the WORKSPACE's connected set. An empty list is
   * the honest answer for a project that never ran the establish step, not an
   * error.
   */
  repoSet: ProjectRepoDto[];
  /**
   * The project's migrate-onboarding run — where onboarding stopped — or `null`
   * when the project never had one, which is itself the answer for a project
   * seeded outside the wizard.
   */
  onboarding: MigrateOnboardingDto | null;
}
