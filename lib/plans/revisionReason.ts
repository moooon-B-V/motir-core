// WHY a plan that is not yet approved had to change — the classification
// vocabulary, and the one list of change kinds a tenant may NOT see
// (Story MOTIR-5543 · Subtask MOTIR-6083).
//
// ⚠️ WHY THIS IS ITS OWN MODULE RATHER THAN PART OF `planRevisionsService`.
// The tenant-visibility exclusion has to be applied at the QUERY, which means
// `planRevisionRepository` needs it — and a repository importing a service is the
// layering rule backwards, as well as an import cycle (`planRevisionsService`
// already imports that repository). A shared leaf both layers may depend on is
// the shape that has neither problem, and it is what `lib/plans/` is for.
//
// Pure data and pure predicates: no Prisma, no repository, no service, no I/O.

/**
 * The four answers to *why does this plan need to change?*, in the order
 * `SHARED_PLANNING_RULES` (motir-ai) and `prompts/plan-rules/core.md`
 * (motir-meta) both state them. MOTIR-6084 settles the words; this is the
 * machine-readable half.
 *
 * The split that matters is not four ways but two. `new_ask` and
 * `different_solution` are about the PERSON — something they now want, or an
 * answer they prefer — and say nothing about planning quality.
 * `rule_gap` and `rule_not_followed` are about the PLANNER, and only they file a
 * planning bug. Filing on every re-plan instead is exactly what made the
 * planner-bug home unreadable, and telling the two pairs apart is the whole
 * reason the branch is recorded.
 *
 * ⚠️ A TUPLE, not a database enum. `plan_revision.change_kind` is plain text for
 * the reason its own schema comment gives, and the branch rides `diff.branch`,
 * so a fifth answer is a code change rather than a migration. This constant is
 * the AUTHORITY for the set — every validator reads it rather than re-listing
 * the four.
 */
export const REVISION_REASON_BRANCHES = [
  'new_ask',
  'different_solution',
  'rule_gap',
  'rule_not_followed',
] as const;

export type RevisionReasonBranch = (typeof REVISION_REASON_BRANCHES)[number];

/**
 * The two branches that are about the PLANNER, and so the two that owe a
 * planning bug.
 *
 * `satisfies` rather than a bare annotation: it keeps the literal types for
 * `RuleRevisionReasonBranch` while still failing to compile if either member
 * stops being a branch — so the pair cannot drift from the four above.
 */
export const RULE_REVISION_REASON_BRANCHES = [
  'rule_gap',
  'rule_not_followed',
] as const satisfies readonly RevisionReasonBranch[];

export type RuleRevisionReasonBranch = (typeof RULE_REVISION_REASON_BRANCHES)[number];

/** Whether `value` is one of the four branches — the runtime guard a door uses. */
export function isRevisionReasonBranch(value: unknown): value is RevisionReasonBranch {
  return (
    typeof value === 'string' && (REVISION_REASON_BRANCHES as readonly string[]).includes(value)
  );
}

/**
 * Whether a branch is one of the two that FILE a planning bug.
 *
 * Derived from the tuple above rather than re-listed at each call site, so the
 * "which branches file?" question has exactly one answer in the codebase.
 */
export function isRuleRevisionReasonBranch(
  branch: RevisionReasonBranch,
): branch is RuleRevisionReasonBranch {
  return (RULE_REVISION_REASON_BRANCHES as readonly string[]).includes(branch);
}

/**
 * The change kinds a TENANT may NEVER see.
 *
 * ⚠️ ONE PLACE, ON PURPOSE. `reason_classified` is Motir's own planner-quality
 * data: a reviewer's request classified as a preference, or as a check the
 * planner should have made, is a judgement about OUR planner and not something a
 * customer asked to read. Epic 10 (Platform administration & operations) is the
 * eventual reader; until then the only read is internal.
 *
 * Every tenant-facing read excludes this set at the QUERY, through
 * `planRevisionRepository`'s `TENANT_VISIBLE_PLAN_REVISION_WHERE`. A future
 * internal kind joins THIS array and is excluded everywhere by construction —
 * which is the property a per-reader filter cannot give.
 *
 * Declared as a LITERAL tuple rather than annotated `readonly string[]`: the
 * service's `PlanRevisionChangeKind` union lives one layer up, so pinning
 * membership here would re-create the cycle this module exists to avoid — but
 * keeping the literal types lets `planRevisionsService` assert the relationship
 * with a `satisfies`, which fails to compile if a kind listed here is not a real
 * change kind. The check ends up where the union is, and nothing is lost.
 */
export const REASON_CLASSIFIED_KIND = 'reason_classified';

export const INTERNAL_PLAN_REVISION_CHANGE_KINDS = [REASON_CLASSIFIED_KIND] as const;

/**
 * The longest evidence a classification may carry.
 *
 * Bounded because it is free text written by an agent into an append-only trail:
 * unbounded prose on a row nobody renders is how a table grows without anyone
 * noticing. 4 000 characters is room for the quoted turn and the quoted rule
 * search that the two rule branches owe, and not room for a transcript.
 */
export const REVISION_REASON_EVIDENCE_MAX = 4000;
