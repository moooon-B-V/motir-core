// The bound on a PLANNING RUN filing a bug into its OWN tenant (Story MOTIR-4053 ·
// Subtask MOTIR-4076), as `motir-ai/docs/decisions/planner-files-tenant-bug.md`
// §3 decides it. The route `POST /api/internal/ai/log-bug` and the service
// `aiWorkItemsService.filePlannerBug` read these; nothing else does.
//
// ⚠️ KEPT AS CONSTANTS RATHER THAN CONFIG, deliberately. The ADR settles each
// axis with a VALUE so that no implementer picks one alone, and a project-level
// setting would be a second place the bound could be widened without a decision
// record. If a customer ever needs a different cap, that is an amendment to the
// ADR first and a column second.

/**
 * VOLUME — the most bugs ONE planning job may file (ADR §3). Counted on the
 * job's plan trail (`plan_revision.change_kind = 'bug_filed'`) under the plan's
 * own row lock, so two concurrent filings on the same job cannot both pass the
 * count. The sixth call is refused as `PLANNER_BUG_CAP_EXCEEDED` (409) and the
 * run CONTINUES — filing is never a gate on producing a plan.
 */
export const PLANNER_BUGS_PER_JOB = 5;

/**
 * RECORD — the revision verb a filing writes on the plan's trail. `change_kind`
 * is free text (`planRevisionsService`), so this needs no migration, and the
 * timeline renders every stored kind it has not heard of — which is what puts
 * the filed key in front of the person reviewing the plan.
 */
export const PLANNER_BUG_FILED_CHANGE_KIND = 'bug_filed' as const;

/**
 * The HARNESS half of the native planning triple a filed bug carries — the same
 * literal `plansService.materialize` stamps on a proposal it materializes, so a
 * card the planner filed directly and a card it proposed read the same author.
 */
export const NATIVE_PLANNER_HARNESS = 'Motir';
