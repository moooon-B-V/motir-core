// DTO types for the AI-planning Plan substrate (Story 7.21 · MOTIR-1336). The
// shape that crosses the API boundary — no Prisma row leaks (Date objects
// become ISO strings, the Prisma `PlanStatus` / `PlanItemOp` enums become
// string unions, the `proposed_fields` / `patch` JSON columns become typed
// objects). The 7.4.5 plan-detail + 7.4.13 plans-list UIs bind to these.

import type { JobStatus } from '@/lib/ai/types';
import type { WorkItemPlanningSourceDto } from '@/lib/dto/workItems';
import type { ProjectRepoRoleDto } from '@/lib/dto/projectRepos';
import type { SprintBlockerDto } from '@/lib/dto/sprints';

/** Wire form of the Prisma `PlanStatus` enum, as a VALUE — so a surface that
 *  must be total over the lifecycle (the tab strip, the per-status counts) can
 *  iterate it instead of restating it. The type below is DERIVED from this
 *  array, so the two cannot drift: adding a member here widens `PlanStatusDto`,
 *  and there is no second place to forget. */
export const PLAN_STATUS_DTO_VALUES = [
  'generating',
  'planned',
  'stale',
  'approved',
  'declined',
] as const;

/** Wire form of the Prisma `PlanStatus` enum. */
export type PlanStatusDto = (typeof PLAN_STATUS_DTO_VALUES)[number];

/**
 * WHY a `declined` plan ended (MOTIR-3189) — the three histories that one status
 * covers, recorded rather than left to be inferred from which of `plannedAt` /
 * `decidedById` happen to be null.
 *
 * `reviewed` — a person read a `planned` plan and rejected it.
 * `discarded` — a person ended a `generating` plan that never finished.
 * `abandoned` — `abandonedPlanService` terminated one whose producer was gone.
 *
 * Deliberately NOT a fourth `PlanStatusDto` member: that vocabulary is public
 * (v1's `planStatusSchema`, the MCP tool descriptions, four display switches and
 * the zh-parity gate) and every consumer of a plan's status is asking *is it
 * decided?*, which `declined` already answers. See
 * `docs/decisions/agent-authored-plans.md` AMENDMENT 6.
 *
 * `null` is not a fourth reason — it is *not recorded*, which is what every row
 * written before the column existed reads, and what an `approved` plan reads
 * always. A consumer falls back to the status.
 */
export type PlanDecisionReasonDto = 'reviewed' | 'discarded' | 'abandoned';

/**
 * The same vocabulary as a runtime list, for the schemas that need to enumerate
 * it (`mcpPlanSchema`). The `AssertTotal` beside it is what stops the two
 * drifting: adding a member to the union above without adding it here is a
 * compile error, not a value an agent quietly never sees.
 */
export const PLAN_DECISION_REASONS = [
  'reviewed',
  'discarded',
  'abandoned',
] as const satisfies readonly PlanDecisionReasonDto[];
type AssertTotalDecisionReason = [
  Exclude<PlanDecisionReasonDto, (typeof PLAN_DECISION_REASONS)[number]>,
] extends [never]
  ? true
  : never;
const _planDecisionReasonTotal: AssertTotalDecisionReason = true;
void _planDecisionReasonTotal;

/** Wire form of the Prisma `PlanItemOp` enum. */
export type PlanItemOpDto = 'add' | 'modify' | 'remove';

/**
 * Wire form of the Prisma `PlanOrigin` enum (MOTIR-916) — WHY the plan was
 * started, as opposed to `sourceJobId`'s WHICH job produced it. `user` is every
 * request-path submit (someone clicked generate / augment / expand / re-plan);
 * `cadence` is the auto-plan watcher firing on a drained ready set. The review
 * surface reads it to LABEL an auto-proposed expansion — it changes nothing
 * about how the plan is reviewed, approved, or declined.
 */
export type PlanOriginDto = 'user' | 'cadence';

/**
 * Wire form of the Prisma `WorkItemPlanningSource` enum as it appears on a PLAN
 * (Story MOTIR-2982 · MOTIR-2986) — WHO authored the plan.
 *
 * An ALIAS of {@link WorkItemPlanningSourceDto}, never a re-listing of its
 * members. The enum is REUSED rather than duplicated
 * (`docs/decisions/agent-authored-plans.md` Q3): a plan's author and the authors
 * stamped on the work items it materializes must be drawn from ONE closed
 * vocabulary or the Plans surface and the work-item detail can disagree about the
 * same fact. The alias exists only so a reader of `PlanDto` sees which vocabulary
 * the field speaks — spelling the members out here would recreate exactly the
 * second list Q3 refused (it already has FOUR members, not the three
 * `work-item-provenance.md` Decision 2 lists).
 */
export type PlanAuthorSourceDto = WorkItemPlanningSourceDto;

/**
 * The proposed fields of an `add` PlanItem — the new node's values, which live
 * HERE until materialize (no WorkItem exists yet). `kind` defaults to `task`
 * (a standalone leaf) when omitted; `parentRef` (on the PlanItem) decides the
 * tree placement. All optional except a title.
 */
export interface PlanItemProposedFields {
  title: string;
  kind?: string;
  descriptionMd?: string | null;
  type?: string | null;
  priority?: string | null;
  executor?: string | null;
  /**
   * Leaf sizing (MOTIR-1433) — the agile point estimate + the time estimate the
   * **estimation gate** requires on EVERY leaf (subtask / childless bug/task).
   * They live HERE until materialize maps them onto the created WorkItem. Both
   * optional/nullable (a non-leaf `add` carries neither); validated at
   * `addProposals` / `updateProposal` the SAME way the create path validates
   * them (Fibonacci-range points, non-negative integer minutes).
   */
  storyPoints?: number | null;
  estimateMinutes?: number | null;
  /**
   * AI-drafted explanation (Story 7.4 · MOTIR-850) — the "why this matters" prose
   * the `generate_tree` planner drafts when the project opts in
   * (`Project.aiGenerateExplanations`). Carried HERE through the proposal until
   * materialize maps it onto the created WorkItem's `explanationMd` /
   * `explanationSource`. `explanationSource` is normally `'ai_draft'` (the
   * generator's default); materialize also defaults it to `ai_draft` when an
   * `explanationMd` is present but no source is set. Both optional — a proposal
   * with explanations OFF carries neither. Item-link convention (Story 5.8): a
   * reference to another item in `explanationMd` is a link token
   * (`motir:<id>` / `motir-ref:<tempRef>`), resolved at materialize.
   */
  explanationMd?: string | null;
  explanationSource?: string | null;
  /**
   * Native PLANNING provenance (Story MOTIR-1685) — motir-ai attaches how it
   * planned this item so `materialize` can stamp it (docs/decisions/work-item-provenance.md,
   * Decision 5). `source`/`harness` are constants for the native seam
   * (`native`/`Motir`); `model` is resolved from the run's `PlanningRun.model`.
   * OPTIONAL by contract: an older/absent producer just omits it and materialize
   * still stamps a valid native triple (`native · Motir · null`), so the
   * motir-ai producer (MOTIR-1690) and this consumer merge in any order.
   */
  planningProvenance?: {
    source?: string;
    harness?: string | null;
    model?: string | null;
  } | null;
  /**
   * WHICH REPO this item ships in (Story MOTIR-1775 · MOTIR-1884) — the producer
   * half of the multi-repo dispatch contract. A project now carries a repository
   * SET sized by its architecture (MOTIR-1780), and `resolveDispatchRepo` only
   * falls back to "the single repo" when there is exactly one: with two or more,
   * an item that carries no pin resolves to `null` and no agent is told where to
   * build. So the PLANNER pins each proposed item (the paired motir-ai card
   * MOTIR-1885), and the pin travels here until materialize maps it onto the
   * created WorkItem's `targetRepo`.
   *
   * Either the bare repo NAME (`motir-core`) or the `owner/name` ref form —
   * normalized to the bare name at materialize, exactly as the direct-write path
   * normalizes an authored pin. VALIDATED at approve against the PROJECT's set
   * (not the workspace's connected repos), including rows that are still
   * `proposed`: naming a repository the plan has decided on but not yet created
   * is ordinary, while a typo or a sibling project's repo is rejected.
   *
   * OPTIONAL by contract — a proposal that carries no pin materializes exactly as
   * it did before this field existed, so the single-repo projects the shipped
   * fallback already serves are unaffected and the two repos' halves may merge in
   * either order.
   */
  targetRepo?: string | null;
  /**
   * WHICH ROLE of the project's repository set this item ships in (Story
   * MOTIR-1775 · MOTIR-1912) — the PORTABLE pin, and the one a fresh onboarding
   * generation can actually emit.
   *
   * ADR §5.2 calls this the load-bearing detail: at generation the repositories
   * **do not exist** (the set is DERIVED from the tree, and the user may rename
   * any row before it is created), so a NAME pinned then is stale the moment a row
   * is edited and meaningless before the row exists at all. A role is stable
   * across both.
   *
   * VALIDATED against the ROLE VOCABULARY (`PROJECT_REPO_ROLES` — `web` / `api` /
   * `mobile` / `shared` / `infra` / `other`), not against the project's set: a
   * closed enum needs no repository to exist, which is exactly what makes it
   * emittable this early. An unrecognised value is rejected at the append /
   * approve boundary (`PlanItemUnknownTargetRepoRoleError`); an explicit `null` is
   * "unpinned", not an error.
   *
   * NOT redundant with {@link targetRepo} — ADR §5.4: *"Role is the portable pin;
   * name is the settled one. Materialize accepts either."* A fresh generation
   * emits a role; a re-plan / augment / `expand_item` on a project whose repos
   * already exist may emit the name. When a proposal carries BOTH, the **name
   * wins** for `work_item.targetRepo` (it is the settled answer, and it already
   * survives the shipped set validation) and the role is still recorded, so the
   * two pins never disagree about the outcome.
   *
   * Materialize only RECORDS it (onto `work_item.targetRepoRole`); resolving a
   * role to a repo name happens later, when that role's row becomes established
   * (MOTIR-1913) — it cannot happen here, because `proposeRepositorySet` runs
   * AFTER the approve transaction commits and its rows start `proposed`.
   */
  targetRepoRole?: ProjectRepoRoleDto | null;
}

/**
 * The sparse patch of a `modify` PlanItem — only the CHANGED fields (the OLD
 * side of each diff is read live from the target at materialize). The edge
 * changes carry refs (a real work-item id or an intra-plan temp-ref).
 */
export interface PlanItemPatch {
  title?: string;
  descriptionMd?: string | null;
  /**
   * REWRITE the target's WHY (MOTIR-3111) — the `modify` mirror of the `add`
   * path's {@link PlanItemProposedFields.explanationMd}, and the second half of
   * the two-body pair `descriptionMd` opens.
   *
   * Sparse like every key here: absent (`undefined`) leaves the existing
   * explanation untouched, an explicit `null` CLEARS it. Normalized through
   * `normalizeBodyRefs` in the SAME resolve as the patched description
   * (`applyModify`), so a bare `MOTIR-<n>` in a patched explanation chips
   * exactly as it does in a patched description and as it already does on the
   * `add` path.
   *
   * ⚠️ There is deliberately NO `explanationSource` twin. That column is not the
   * caller's to set — it defaults to `user_authored` and the service path
   * auto-transitions an `ai_draft` to `user_edited` — so a patch that could write
   * it would let a plan forge provenance. `applyModify` leaves it alone whatever
   * its prior value.
   *
   * Why it exists: THE REPLAN ACTION requires the surviving card's rationale to be
   * rewritten (*"a survivor keeps its OLD `explanationMd` unless you rewrite it,
   * and a stale WHY is worse than a null one"*), and since MOTIR-3047 a run's
   * re-plan writes through the PROPOSAL door. Without this key the runbook
   * mandates a patch the proposal API cannot express.
   */
  explanationMd?: string | null;
  priority?: string | null;
  type?: string | null;
  /**
   * Leaf sizing re-scope (MOTIR-1532) — the agile point + time estimate a
   * `modify` may change on the target, mirroring the `add` path's
   * `PlanItemProposedFields` sizing. Validated at the proposal boundary the SAME
   * way (`validateStoryPoints` / `validateEstimateMinutes`); applied by
   * `applyModify` with a `work_item_revision` diff cell. Both optional (a modify
   * that doesn't touch sizing carries neither); an explicit `null` CLEARS the
   * estimate. The `modify_node` generation tool offers both, so without them a
   * proposed re-scope would never apply on approve.
   */
  storyPoints?: number | null;
  estimateMinutes?: number | null;
  /**
   * RE-PIN the target's repo (MOTIR-1884) — the `modify` mirror of the `add`
   * path's {@link PlanItemProposedFields.targetRepo}, so a re-plan that moves work
   * from one repo of the set to another can say so instead of leaving the item
   * pointed at the repo it was first planned into.
   *
   * Absent (`undefined`) leaves the pin untouched; an explicit `null` (or a blank
   * string, which normalizes to `null`) UNPINS the item. Validated at approve the
   * same way the `add` path's pin is — same project-scoped domain, same
   * normalization — so the two paths cannot disagree about what a pin means.
   */
  targetRepo?: string | null;
  /**
   * RE-PIN the target's repo ROLE (MOTIR-1912) — the `modify` mirror of the `add`
   * path's {@link PlanItemProposedFields.targetRepoRole}, so a re-plan that moves
   * work from one role of the set to another (the API half becoming a shared
   * package, say) can say so.
   *
   * Same sparse semantics as every other patch key, and deliberately identical to
   * the shipped `targetRepo` patch: absent (`undefined`) leaves the pin untouched;
   * an explicit `null` UNPINS. Validated against the role vocabulary the same way
   * the `add` path's is, so the two paths cannot disagree about what a role means.
   */
  targetRepoRole?: ProjectRepoRoleDto | null;
  /**
   * RE-PARENT the target (MOTIR-3859) — the `modify` mirror of the `add` path's
   * {@link PlanItemDto.parentRef}, and the half of D3's `SITS or SHIPS` pair the
   * patch never had.
   *
   * ⚠️ THE PAIR CAME APART BY ACCIDENT, not by decision. `agent-authored-plans.md`
   * D3 draws the deepen line as *"a deepen may change what a card SAYS and who
   * ACTS on it; it may not change where the card SITS or SHIPS"* — and SHIPS was
   * then given to the patch twice (`targetRepo`, MOTIR-1884; `targetRepoRole`,
   * MOTIR-1912) while SITS was given to it never. Nothing anywhere argued it
   * should not be; the two halves were widened by different cards and only one of
   * them ran. AMENDMENT 11 records the completion.
   *
   * Sparse like every key here: absent (`undefined`) leaves the parent untouched,
   * an explicit `null` moves the target to the PROJECT ROOT (refused by the same
   * `assertValidParent(null, kind)` arm that refuses a root-level subtask).
   *
   * ⚠️ A REAL work-item id ONLY — a `planItem:` temp-ref is REFUSED at the append
   * (`validateProposal`), and that is a decision rather than an omission. Every
   * guard this key owes — the kind-parent matrix, same-project tenancy, the
   * no-cycle walk, the depth cap and the terminal-parent refusal — is a question
   * about a LIVE row, and a proposal has none until approve. Admitting a temp-ref
   * would mean a re-parent nothing could check until the DB trigger raised a raw
   * SQLSTATE mid-materialize, which is exactly the shape this gate exists to
   * prevent. A card that must land under a card the same plan is adding is
   * expressible already: `add` it with that `parentRef` instead.
   *
   * Validated at the APPEND (`plansService.addProposals`) and again at approve
   * (`validatePlanProposals`), through ONE pure function so the two cannot
   * disagree; applied by `applyModify` with a `parentId` revision diff cell, the
   * ancestor repo-set recompute on BOTH chains, and the `work-item/child-set.changed`
   * event `moveWorkItem` emits for the same reason.
   */
  parentRef?: string | null;
  blockedByAdd?: string[];
  blockedByRemove?: string[];
}

/** One proposed operation in a plan, as the API returns it. */
export interface PlanItemDto {
  id: string;
  op: PlanItemOpDto;
  /** `null` for an un-materialized `add`; the target/created id otherwise. */
  workItemId: string | null;
  proposedFields: PlanItemProposedFields | null;
  patch: PlanItemPatch | null;
  parentRef: string | null;
  blockedByRefs: string[];
  baseRevision: string | null;
  createdAt: string;
}

/**
 * A plan as the API returns it (list row). The lifecycle timestamps + decider
 * ARE the history surface (when planned / when decided / by whom). `itemCount`
 * is the number of bundled PlanItems.
 */
export interface PlanDto {
  id: string;
  projectId: string;
  status: PlanStatusDto;
  title: string | null;
  summary: string | null;
  sourceJobId: string | null;
  /** WHY the plan was started — `user` (someone clicked) or `cadence` (the
   *  auto-plan watcher fired it). Set at submit; never changes. */
  origin: PlanOriginDto;
  /**
   * WHO ASKED for the plan (Story MOTIR-2982 · MOTIR-2986) — a THIRD party
   * beside {@link PlanDto.decidedById} (who approved it) and the authorship
   * triple below (which agent wrote it). Commonly three different people: a
   * teammate asks, an agent writes, a lead approves.
   *
   * NULL is a MEANING, not a gap: it is the `cadence` case. The auto-plan
   * watcher runs under the project OWNER's credential so its job has one, and
   * nobody clicked — so the requester is recorded ⟺ a person actually asked
   * (`origin === 'user'`), and a cadence plan is identified by its `origin`
   * rather than by a requester it would otherwise fabricate.
   */
  createdById: string | null;
  /**
   * WHO authored the plan (Story MOTIR-2982 · MOTIR-2986) — the
   * `source · harness · model` triple `docs/decisions/agent-authored-plans.md`
   * Q3 mirrors onto the plan from `work-item-provenance.md` Decision 2. Distinct
   * from `origin` (WHY it was started) and `sourceJobId` (WHICH job produced it):
   * an agent-authored plan and a Motir generation are BOTH `origin: 'user'`.
   *
   * `authorSource` is SERVER-SET at the write seam — `mcp` from the `create_plan`
   * MCP tool, never a caller field. `authorHarness` / `authorModel` are the
   * authoring agent's self-reported free text.
   *
   * All three null on every plan written by any path other than that tool,
   * INCLUDING Motir's own generator — which is deliberately not retrofitted here
   * (MOTIR-2996). So the Plans surface reads *Motir-generated* off
   * `sourceJobId != null`, and *unattributed* off both being null.
   */
  authorSource: PlanAuthorSourceDto | null;
  authorHarness: string | null;
  authorModel: string | null;
  itemCount: number;
  createdAt: string;
  plannedAt: string | null;
  decidedAt: string | null;
  decidedById: string | null;
  /**
   * WHY a `declined` plan ended (MOTIR-3189) — `reviewed`, `discarded` or
   * `abandoned`. Null on every other status, and on a `declined` row written
   * before the column existed, where it means *not recorded* rather than a
   * fourth kind of ending. See {@link PlanDecisionReasonDto}.
   */
  decisionReason: PlanDecisionReasonDto | null;
}

/** A plan plus its bundled proposal items (the detail view). */
export interface PlanWithItemsDto extends PlanDto {
  items: PlanItemDto[];
}

/** A cursor-paginated page of plans, newest first. */
export interface PlanListPageDto {
  plans: PlanDto[];
  /** Opaque cursor for the next page, or `null` when the last page is reached. */
  nextCursor: string | null;
}

/** Input to `plansService.createPlan`. */
export interface CreatePlanInput {
  title?: string | null;
  summary?: string | null;
  sourceJobId?: string | null;
  /**
   * WHO ASKED for the plan (MOTIR-2986) — see {@link PlanDto.createdById}.
   *
   * EXPLICIT, never defaulted from the acting context, and that is the whole
   * point: `createPlan` always HAS a `ctx.userId`, and on the cadence path that
   * value is the project owner's, substituted so the job has a credential. A
   * default would therefore record a request the owner never made. Producers on
   * a request path pass it; the cadence watcher does not.
   */
  createdById?: string | null;
  /**
   * WHO authored the plan (MOTIR-2986) — see {@link PlanDto.authorSource}. All
   * three OPTIONAL: every shipped producer (generation, augment, expand, replan,
   * contextual, cadence) calls `createPlan` without them and stores nulls,
   * producing a row identical to one produced before this field existed.
   *
   * `authorSource` is passed by the WRITE SEAM, not by that seam's caller — the
   * `create_plan` MCP tool fixes `'mcp'` here the same way `create_work_item`
   * fixes `source: 'mcp'`, so an agent cannot claim `native`/`manual`. The
   * service does not validate it beyond the type: it is not caller input.
   */
  authorSource?: PlanAuthorSourceDto | null;
  /** The authoring agent's self-reported harness. Trimmed; empty → null. */
  authorHarness?: string | null;
  /** The authoring agent's self-reported model. Trimmed; empty → null. */
  authorModel?: string | null;
  /** Defaults to `user` when omitted — so every existing caller (and every
   *  request-path submit) keeps recording a human-initiated plan without
   *  passing anything. Only the cadence watcher passes `cadence`. */
  origin?: PlanOriginDto;
}

/** A single proposed operation appended via `plansService.addProposals`. */
export interface ProposalInput {
  op: PlanItemOpDto;
  /** `modify` / `remove`: the existing target work-item id. Omitted for `add`. */
  workItemId?: string | null;
  /** `add` only. */
  proposedFields?: PlanItemProposedFields | null;
  /** `modify` only. */
  patch?: PlanItemPatch | null;
  /**
   * `add` / edge changes: the parent ref — a real work-item id, or an
   * intra-plan temp-ref `planItem:<planItemId>` pointing at another `add` in
   * this same plan (resolved at materialize).
   */
  parentRef?: string | null;
  /** `add` / edge changes: blocked-by refs (real ids or intra-plan temp-refs). */
  blockedByRefs?: string[];
  /** `modify` / `remove`: the target's revision the change was computed against. */
  baseRevision?: string | null;
}

/**
 * The editable fields of a proposed `add` (the proposal-edit path, 7.21.6 ·
 * MOTIR-1370). A sparse patch over the `add`'s `proposedFields`: only the keys
 * present are changed; the rest (incl. `executor`) are left untouched. Only an
 * `add` proposal is editable — `modify`/`remove` target existing items. `title`,
 * when present, must be non-empty (the same invariant `addProposals` enforces).
 */
export interface UpdateProposalInput {
  title?: string;
  kind?: string;
  descriptionMd?: string | null;
  type?: string | null;
  priority?: string | null;
  /** Leaf sizing (MOTIR-1433) — patchable on the proposal-edit / deepen path
   *  exactly like the other proposed fields; an explicit `null` clears the
   *  estimate, the same sparse-merge semantics the rest of this input uses. */
  storyPoints?: number | null;
  estimateMinutes?: number | null;
  /** AI-drafted explanation (Story 7.4 · MOTIR-850) — deepenable on the
   *  proposal-edit / generation deepen path exactly like `descriptionMd`; an
   *  explicit `null` clears it. Sparse-merged into the `add`'s `proposedFields`
   *  (`mergeProposedFields`). `explanationSource` is not deepened here —
   *  materialize defaults it to `ai_draft` when an explanation is present. */
  explanationMd?: string | null;
  /**
   * WHO executes the leaf (`coding_agent` / `human`) — the ONE field the deepen
   * turn added to this set (`agent-authored-plans.md` AMENDMENT 4 D3a,
   * MOTIR-3089). It is here because `type` is deepenable and `executor` is
   * DERIVED from it, while `plansService.materialize` writes
   * `pf.executor ?? null` and never consults `defaultExecutorForType` — so a
   * titles-first proposal that gains its type on the deepen turn would otherwise
   * materialize unassignable. An explicit `null` clears it.
   *
   * ⚠️ The value is validated at the TRANSPORT, exactly as on the append path:
   * `add_plan_items` constrains `executor` with a zod enum in its own argument
   * schema and `validateProposal` does not check it, so the deepen tool
   * constrains it identically rather than growing a service-level rule the
   * append path does not have.
   *
   * The human review route (`PATCH /api/plans/[id]/items/[itemId]`) ENUMERATES
   * the keys it accepts and does not pick this one up — the same way it already
   * does not pick up `explanationMd` — so widening this interface leaves that
   * surface byte-identical (AMENDMENT 4 D3a).
   */
  executor?: string | null;
}

/**
 * The fields an explicit CORRECTION may change (Story MOTIR-3533 · Subtask
 * MOTIR-3540) — `UpdateProposalInput` plus the STRUCTURAL columns the deepen
 * turn excludes, and a `modify`'s `patch`.
 *
 * ⚠️ A SEPARATE INTERFACE, deliberately, and NOT a widening of
 * `UpdateProposalInput`. `agent-authored-plans.md` AMENDMENT 3 D3 fixed the
 * deepen turn's editable set with a rule — *a deepen may change what a card SAYS
 * and who ACTS on it, never where it SITS or SHIPS* — and that rule is still
 * right for a deepen. AMENDMENT 7 amends it for a CORRECTION, which is a
 * different act with a different trigger: the author has just discovered that
 * the structure it appended is wrong, and its only alternative is a whole new
 * plan. Two inputs is what keeps both true at once; widening the one would have
 * silently re-opened structure on the deepen path as well.
 *
 * Sparse, like its parent: an omitted key is left alone, an explicit `null`
 * clears. `blockedByRefs` is the one exception and cannot be otherwise — it is a
 * LIST, so a partial edit has no meaning; supplying it REPLACES the set, and
 * `[]` clears it.
 */
export interface CorrectProposalInput extends UpdateProposalInput {
  /** `add` only — a real work-item id, an intra-plan `planItem:` temp-ref, or
   *  `null` to make the proposal top-level. Re-validated by the same check the
   *  append runs, so a correction cannot introduce an unresolvable ref. */
  parentRef?: string | null;
  /** REPLACES the blocked-by set (see the note above); `[]` clears it. */
  blockedByRefs?: string[];
  /** `add` only — the repo pin, re-validated against the project's connected
   *  repositories exactly as approve does; `null` unpins. */
  targetRepo?: string | null;
  /**
   * `add` only — RE-PIN the proposal's repo ROLE (MOTIR-3865), the portable half
   * of the pin beside {@link targetRepo}'s settled one. `null` unpins.
   *
   * It is here because a correction that could re-pin the repository NAME and not
   * its ROLE could not correct an ONBOARDING plan's pin at all: at generation the
   * repositories do not exist yet, so a fresh plan pins a ROLE and nothing else
   * (ADR §5.4 · `PlanItemProposedFields.targetRepoRole`). A `modify` proposal's
   * own patch has carried it since MOTIR-1912; the top-level correction did not,
   * so the one shape that always carries a role was the one a correction could
   * not reach.
   *
   * Validated against the closed role VOCABULARY (`PROJECT_REPO_ROLES`), not the
   * project's repository set — the same check the append and a `modify`'s patch
   * run, and the reason a role is emittable before any row exists.
   */
  targetRepoRole?: ProjectRepoRoleDto | null;
  /** `modify` only — REPLACES the patch. The op that carries a dependency edit,
   *  and the one no door could touch at all before this. */
  patch?: PlanItemPatch | null;
}

/**
 * The keys {@link UpdateProposalInput} declares — THE SINGLE DECLARED SOURCE
 * every transport onto the deepen / correction service derives from (MOTIR-3865).
 *
 * ⚠️ It exists because a key declared on an input type and read by NO transport
 * is invisible from both ends: the request succeeds, the response is a `200`, and
 * the proposal simply keeps the value it had. That happened three times to one
 * contract — `explanationMd` reached `PlanItemPatch` and not `modify_node`
 * (MOTIR-3860), then reached `UpdateProposalInput` and not the internal
 * correction route (this card) — each time in a change that was locally complete
 * and correct, because nothing anywhere compared the two lists.
 *
 * So every layer that has to agree DERIVES the set from here rather than
 * re-typing it: the compile-time assertion below holds the INTERFACES to it, and
 * `tests/integration/ai/planRevisionRoutes.test.ts` holds the internal route's
 * parser to it. A key added to either input with no transport carrying it fails
 * in the pull request that adds it. (The same guard shape as `MODIFY_PATCH_KEYS`
 * in motir-ai `src/llm/treeGeneration.ts`.)
 */
export const UPDATE_PROPOSAL_KEYS = [
  'title',
  'kind',
  'descriptionMd',
  'type',
  'priority',
  'storyPoints',
  'estimateMinutes',
  'explanationMd',
  'executor',
] as const;

export type UpdateProposalKey = (typeof UPDATE_PROPOSAL_KEYS)[number];

/**
 * The keys {@link CorrectProposalInput} declares — {@link UPDATE_PROPOSAL_KEYS}
 * plus the STRUCTURAL members a correction adds. Same guard, same reason.
 */
export const CORRECT_PROPOSAL_KEYS = [
  ...UPDATE_PROPOSAL_KEYS,
  'parentRef',
  'blockedByRefs',
  'targetRepo',
  'targetRepoRole',
  'patch',
] as const;

export type CorrectProposalKey = (typeof CORRECT_PROPOSAL_KEYS)[number];

/**
 * The COMPILE-TIME half of the drift guard: each input's keys and its constant
 * are the same set, in BOTH directions.
 *
 * A runtime test cannot enumerate an interface's keys, so this is where the TYPE
 * is held to the constant — adding a field to either input without adding it to
 * its constant (or the reverse) fails `tsc`, before any test runs. The route test
 * then holds the TRANSPORT to the same constant, which is the half that was
 * missing: the interfaces and the parser were each internally consistent and had
 * never been compared.
 */
type UpdateKeyMissingFromConstant = Exclude<keyof UpdateProposalInput, UpdateProposalKey>;
type UpdateKeyMissingFromInterface = Exclude<UpdateProposalKey, keyof UpdateProposalInput>;
type CorrectKeyMissingFromConstant = Exclude<keyof CorrectProposalInput, CorrectProposalKey>;
type CorrectKeyMissingFromInterface = Exclude<CorrectProposalKey, keyof CorrectProposalInput>;
const _proposalInputKeysAreExhaustive: [
  UpdateKeyMissingFromConstant,
  UpdateKeyMissingFromInterface,
  CorrectKeyMissingFromConstant,
  CorrectKeyMissingFromInterface,
] extends [never, never, never, never]
  ? true
  : never = true;
void _proposalInputKeysAreExhaustive;

/** Options for `plansService.listPlans`. */
export interface ListPlansOptions {
  cursor?: string | null;
  limit?: number;
  /**
   * Narrow the page to ONE lifecycle status — the tabbed Plans list
   * (MOTIR-3241) asks for exactly one tab at a time. **Omit it for the whole
   * project**, which is what every caller predating the tabs does and what
   * keeps their pages byte-identical.
   *
   * Applied as a `where` predicate in the repository, never after the read: a
   * caller-side filter would take the cursor page and then shrink it, so a
   * `planned` page would come back short while `nextCursor` claimed there was
   * more.
   */
  status?: PlanStatusDto | null;
}

/** How many plans a project holds in EACH lifecycle status — the counts the
 *  tab strip renders beside its labels (MOTIR-3241).
 *
 *  TOTAL over `PlanStatusDto` by construction: a status with no rows reads `0`,
 *  never an absent key, so a caller cannot render `undefined` for the tab a
 *  project happens to have nothing in. */
export type PlanStatusCountsDto = Record<PlanStatusDto, number>;

// --- Plan staleness (Story 7.21 · MOTIR-1340) -------------------------------
// Computed at REVIEW time from the CURRENT work-item tree + the plan's
// `plannedAt`. The committed tree can change between when a plan is generated
// and when the user reviews it, so a proposed item can DRIFT: its parent was
// archived, a blocker it references was removed, or — for modify/remove — the
// target changed since the patch's `baseRevision`. A PURE READ that WARNS; it
// NEVER blocks approve. The 7.4.5 plan-detail (MOTIR-847) + 7.21.1 plans-list
// (MOTIR-1338) UIs bind to these.

/** The reason a proposed PlanItem is flagged stale. A REASON LIST (not a
 *  boolean) so a single item can carry several, and the set is EXTENSIBLE as
 *  the rule set grows — `add` items get the structural reasons; `modify`/`remove`
 *  items get `base_revision_drift`.
 *
 *  ⚠️ EVERY MEMBER IS KEYED ON SOMETHING THE PROPOSAL ITSELF NAMED (MOTIR-3777):
 *  its parent, its declared blockers, its modify/remove target. `siblings_added`
 *  — *the parent gained a child after `plannedAt`* — was the one member that was
 *  not, and it is RETIRED: it read the parent's child count rather than the
 *  proposal, so on a busy parent it fired within minutes of every plan, for
 *  reasons that were always about somebody else's work. A proposal that named
 *  nothing is self-contained, and nothing that happens beside it can make it
 *  wrong. A new member is welcome here — one keyed on the parent's traffic is
 *  not. */
export type StaleReasonCode = 'parent_removed' | 'blocker_removed' | 'base_revision_drift';

/** One staleness reason, carrying the specifics the review UI shows. */
export type StaleReason =
  /** `add`: the proposal's (real) parent is archived/deleted — it would be
   *  orphaned on approve. */
  | { code: 'parent_removed'; parentId: string }
  /** `add`: these (real) `blocked_by` targets of the proposal are now
   *  archived/deleted — a dangling dependency. */
  | { code: 'blocker_removed'; blockerIds: string[] }
  /** `modify`/`remove`: the target changed since the patch's `baseRevision`
   *  (`edited`), was `archived`, or is `missing` (hard-deleted) — applying the
   *  patch may conflict with a newer edit. */
  | { code: 'base_revision_drift'; change: 'edited' | 'archived' | 'missing' };

/** One proposed PlanItem's staleness verdict. `stale === reasons.length > 0`. */
export interface PlanItemStalenessDto {
  /** The PlanItem this verdict concerns — the stable key (an un-materialized
   *  `add` has no `workItemId`). */
  planItemId: string;
  /** The work item the verdict concerns; `null` only for an `add` that has not
   *  been materialized yet — a `modify` / `remove` always has a target, and an
   *  approved `add` names the card it became (MOTIR-3165). */
  workItemId: string | null;
  stale: boolean;
  reasons: StaleReason[];
}

/** A plan's staleness verdict — per-item reasons + a roll-up `stale` flag. A
 *  plan whose tree is unchanged since `plannedAt` returns all-clear
 *  (`stale: false`, every item with no reasons). */
export interface PlanStalenessDto {
  planId: string;
  stale: boolean;
  items: PlanItemStalenessDto[];
}

/**
 * Whether a WHOLE plan is finishable once it materializes (Subtask MOTIR-1550) —
 * the FOREST analogue of {@link import('./workItems').WorkItemValidityDto} (the
 * single-subtree rule) and {@link import('./sprints').SprintValidityDto} (the
 * sprint rule). The containing set is the ENTIRE projection (every projected node
 * under any projected root — real roots + `add`s with a null parentRef), so a
 * `blocked_by` edge that crosses two sibling roots (a story under epic B gated by
 * a story under epic A, both materializing together) is SATISFIED — the single-
 * subtree rule iterated per-root would false-positive it. VALID ⟺ for every
 * not-done node in the projected forest, every `blocked_by` dependency is IN the
 * forest, or (under `loose`) `done`; `blockers` names each residual gate — in
 * practice an out-of-projection (e.g. cross-project) not-done blocker, or a
 * `done`-but-out-of-forest one under `tight`. The `generate_tree` /replan worker
 * (MOTIR-1398) runs this as its pre-commit post-condition over the multi-root
 * epic forest it proposes.
 */
/**
 * One reason the approve button would REFUSE this plan (MOTIR-3575) — the
 * APPROVABILITY half of a plan's verdict, beside `blockers`' FINISHABILITY half.
 *
 * ⚠️ AT MOST ONE, and that is a property of the gate rather than of this type.
 * `validatePlanProposals` is FAIL-FAST by design: it runs before a write and
 * stops at the first reason, so a plan with two defects reports the more
 * specific one and the next is found after that one is fixed. Modelled as an
 * ARRAY anyway, so a caller writes the same loop whether the gate stays
 * fail-fast or is one day taught to collect.
 */
export interface PlanApprovabilityRejectionDto {
  /** The stable code the approve path raises — what a caller branches on. */
  code: 'INVALID_PLAN_REF_GRAPH' | 'PLAN_GRAMMAR_VIOLATION' | 'PLAN_TARGET_IMMUTABLE';
  /** The narrower reason where the code has one (`dangling` / `duplicate` /
   *  `cycle` / `illegal_parent` / `unknown_kind`); `null` for immutability,
   *  which has exactly one shape. */
  reason: string | null;
  /** The offending proposal, as `planItem:<id>` — the same form the blockers
   *  array uses for a proposed node, so both halves address a proposal alike. */
  item: string;
  /** The refusal in the words the approve path would use. */
  message: string;
}

/**
 * A plan's whole verdict. TWO independent questions, and a caller reading only
 * `valid` gets both:
 *
 *   * `blockers` — FINISHABILITY: can every item in the projected forest be
 *     finished once this plan materializes?
 *   * `rejections` — APPROVABILITY: would the approve button accept it at all?
 *
 * Before MOTIR-3575 only the first was asked, and `valid: true` was returned for
 * plans the button then refused — which is what made a bad plan safe to close.
 */
export interface PlanValidityDto {
  planId: string;
  /** True only when BOTH questions pass. */
  valid: boolean;
  blockers: SprintBlockerDto[];
  rejections: PlanApprovabilityRejectionDto[];
}

// --- Auto-plan PAUSE state (Story 7.13 · MOTIR-1740) ------------------------
// The indicator half of MOTIR-916's pending-proposal gate. The cadence watcher
// SKIPS a project whose plan is still undecided, and nothing expires a plan
// (`declinePlan` is an explicit human act), so auto-plan can stay silent
// indefinitely. This is what the AI-planning settings page reads to SAY SO —
// the same predicate the trigger gates on, projected for the reader.

/**
 * Is auto-planning PAUSED for a project, and is the plan it is waiting on out of
 * date? Flat (not a union) so a caller reads `pending` and the rest follows: when
 * `pending` is false every other field is at its empty value.
 *
 * `stale` is the ROLLED-UP verdict of the shipped `planStalenessService`
 * (MOTIR-1340) — the indicator shows the count, never the per-item reason list
 * (that lives on the plan detail). Staleness WARNS; it gates nothing here.
 */
export interface AutoPlanPauseDto {
  /** True ⟺ the project has an undecided plan (`generating` / `planned`) — i.e.
   *  exactly when the cadence sweep skips it with `pending_proposal`. */
  pending: boolean;
  /** The waiting plan, so the indicator can LINK to it (`/plans/{id}`). */
  planId: string | null;
  /** When it finished generating; `null` while it is still `generating`. */
  plannedAt: string | null;
  /** How many items it proposes — the meta line's `aiPlanning.itemCount`. */
  itemCount: number;
  /** Whether ANY proposed item has drifted since the plan was drafted. */
  stale: boolean;
  /** How many have — the drift sentence's count. `0` when not stale. */
  staleCount: number;
}

// --- Plan-job OUTCOME (Story 7.9 · MOTIR-1825) ------------------------------
// The read a NON-INTERACTIVE client needs after it FIRES a plan-edit job and
// walks away. The browser surfaces stream the job (`usePlanEditsJob`) and watch
// the plan appear; a CLI or agent has no stream to hold open — it submits,
// returns, and comes back later asking "what became of it?". These shapes are
// that answer.

/** Why a plan's job did not (or may not) finish — the service's typed error
 *  code + message, verbatim. */
export interface PlanJobFailureDto {
  code: string;
  message: string;
}

/**
 * The motir-ai job behind a plan, resolved ONLY while the plan is still
 * `generating` — a `planned` / `approved` / `declined` plan's job is already
 * known to have delivered, so there is nothing to ask.
 *
 * `reachable` disambiguates the two ways `failure` can be non-null: `true` means
 * the job itself failed (and `failure` is ITS error), `false` means motir-ai
 * could not be asked (and `failure` describes THAT). Without the flag a caller
 * cannot tell "your expansion died" from "we couldn't check".
 */
export interface PlanJobStateDto {
  /** The job's own state, or `null` when motir-ai could not be reached. */
  status: JobStatus | null;
  /** False ⟺ motir-ai could not be asked; `failure` then describes the outage. */
  reachable: boolean;
  failure: PlanJobFailureDto | null;
}

/**
 * What became of a submitted plan job — the companion read to every
 * `{ jobId, planId }` submit (`aiPlanEditsService.submitExpand` and friends).
 *
 * `status` is the PLAN's own status, verbatim — there is no synthetic "failed"
 * plan state, because a failed job leaves its plan sitting at `generating`
 * forever. That distinction lives in {@link PlanJobStateDto} instead, so the
 * plan substrate's four-state enum is not widened by a transport concern.
 *
 * `itemCount` is how many PROPOSALS the plan bundles — NOT how many work items
 * exist. Nothing here has touched the tree: `plansService.approvePlan` is the
 * only path from a proposal to a row.
 */
export interface PlanOutcomeDto {
  planId: string;
  projectId: string;
  status: PlanStatusDto;
  origin: PlanOriginDto;
  /** The motir-ai job that produced it (a plan is always bound to one here). */
  jobId: string | null;
  /** Proposals bundled in the plan — proposals, not created work items. */
  itemCount: number;
  createdAt: string;
  /** When generation finished; `null` while still `generating`. */
  plannedAt: string | null;
  /** When it was approved / declined; `null` while undecided. */
  decidedAt: string | null;
  /** The job's state — present ONLY while `status === 'generating'`. */
  job: PlanJobStateDto | null;
}
