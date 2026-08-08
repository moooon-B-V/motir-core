import { z } from 'zod/v4';
import { commentThreadSchema, workItemKeySchema } from '@/lib/api/v1/workItems/schema';
import type { V1Collection } from '@/lib/api/v1/pagination';
import type { DispatchPromptDto } from '@/lib/dto/dispatch';
import type { PlanItemProposedFields, PlanOutcomeDto, PlanWithItemsDto } from '@/lib/dto/plans';

// The v1 WORK-LOOP resources, declared once (Story 11.7 · Subtask 11.7.3 —
// MOTIR-2237). The paths, verbs, scopes and response shapes are pinned by ADR
// Amendment 6; this module is that amendment in `zod`.
//
// ── Why the shapes land AHEAD of most of their endpoints ────────────────────
// Ten endpoints returning eight resources cannot each shape their own response
// and stay coherent — that is exactly the drift Story 11.6 exists to prevent,
// and it would be perverse to introduce it in the story that supplies 11.6's
// schemas. So the shapes are declared here, once, and 11.7.4–11.7.7 arrive as
// ADAPTERS: each brings its route, its MAPPER, and its operation declaration.
//
// ⚠️ **The OPERATION DECLARATIONS travel with their ROUTES, not with these
// schemas** — the one place this card's plan met a shipped guard and lost.
// `tests/api/v1/openapi-operations-coverage.test.ts` asserts BOTH directions:
// "declares an operation for EVERY exported verb" AND "declares no operation for
// a route that does not exist". Registering all ten declarations here, with one
// route shipped, would make the second one red on every PR until 11.7.7 landed.
// So `operations.ts` declares what exists, and each endpoint card appends its
// own — which is also what keeps the emitted document describing an API a client
// can actually call.
//
// ── A v1 response is a SCHEMA's output, never a service DTO ─────────────────
// ADR Amendment 2, totalized by Amendment 5: the mapper is the seam where an
// internal DTO stops being public API, and it shapes FIELD BY FIELD — never a
// spread. A schema in this module without a mapper below it is a shape whose
// endpoint has not shipped yet; the card that ships the route brings the mapper
// and VERIFIES the shape against a real response (11.4.6's drift guard is what
// makes that verification automatic rather than a promise).

// ─────────────────────────────────────────────────────────────────────────────
// The dispatch prompt
// ─────────────────────────────────────────────────────────────────────────────

/** WHICH git workflow the prompt instructs — chosen server-side, never by the caller. */
export const dispatchWorkflowModeSchema = z.enum(['per_item_pr', 'session_lineage']);

/**
 * The advisory SEVERITY, deliberately an OPEN string rather than an enum.
 *
 * ADR §8 permits "a new enum value on a field documented as open-ended", and
 * this field is documented as exactly that. Two families ship today
 * (`advisory` / `likely-missing-edge` on a reference; `likely-ordering-violation`
 * / `likely-repo-straddle` on a shape) and the advisory channel is designed to
 * grow — MOTIR-2175 and MOTIR-2177 each added a severity to a shipped surface.
 *
 * A closed enum here would make the NEXT severity a breaking change for every
 * generated client, and — worse — would make this endpoint 500 on its own
 * response the day the server started emitting one, because 11.4.6's drift guard
 * validates real responses against these schemas. A consumer meeting a severity
 * it does not know IGNORES that advisory; it never fails on it. Advisories are
 * never a gate, so ignoring one is always safe.
 */
export const advisorySeveritySchema = z.string();

/**
 * A PROSE-vs-GRAPH reference advisory — the card's body names a not-done work
 * item it carries no `blocked_by` edge to (MOTIR-1969).
 *
 * `kind` is OPTIONAL here because it is optional on the DTO and never emitted:
 * this variant is the wire shape three shipped consumers already read, so
 * tagging it would change bytes for every one of them to buy nothing. v1 mirrors
 * the DTO rather than normalising it, which is what lets the endpoint's payload
 * be asserted field-by-field against the MCP tool's.
 */
const referenceAdvisorySchema = z.object({
  kind: z.literal('reference').optional(),
  item: workItemKeySchema,
  referenced: z.string(),
  referencedStatus: z.string(),
  severity: advisorySeveritySchema,
});

/**
 * A SHAPE advisory — the card's own acceptance criteria are mis-shaped, with no
 * second work item involved anywhere in the finding (MOTIR-2175 / MOTIR-2177).
 *
 * The per-severity extras are OPTIONAL for the same reason `severity` is open: a
 * future shape severity carries its own fields, and a schema that required
 * today's would reject tomorrow's advisory rather than pass it through.
 */
const shapeAdvisorySchema = z.object({
  kind: z.literal('shape'),
  item: workItemKeySchema,
  severity: advisorySeveritySchema,
  criterionIndex: z.number().int(),
  /** `likely-ordering-violation`: the gate-14 phrase that matched. */
  phrase: z.string().optional(),
  /** `likely-repo-straddle`: the repo-qualified path the criterion names. */
  path: z.string().optional(),
  /** `likely-repo-straddle`: the repo that path resolves to. */
  repo: z.string().optional(),
  /** `likely-repo-straddle`: `contradiction` or `unpinnable`. */
  reason: z.string().optional(),
});

/**
 * ONE advisory. A plain union rather than a discriminated one, because the
 * discriminant is absent on the reference variant — narrow with
 * `'kind' in a && a.kind === 'shape'`; the else branch is a reference.
 */
export const dispatchAdvisorySchema = z.union([shapeAdvisorySchema, referenceAdvisorySchema]);
export type V1DispatchAdvisory = z.infer<typeof dispatchAdvisorySchema>;

/**
 * The assembled coding-agent prompt plus the facts a client routes on.
 *
 * ⚠️ `advisories` is NEVER A GATE and the schema must not read like one. The
 * prompt, the `workflowMode` and the item's readiness are byte-identical whether
 * the array is empty or not: an advisory changes what a caller is TOLD, never
 * what it may do. It is always PRESENT — `[]` when there are none — so a client
 * never branches on absence.
 */
export const dispatchPromptSchema = z.object({
  key: workItemKeySchema,
  /** The full multi-section prompt text, ready to hand to a coding agent. */
  prompt: z.string(),
  /**
   * The item's PARENT key, or `null` for a top-level item (MOTIR-2445).
   *
   * The prompt already NAMES it, in the CONTEXT section's `- Parent:` line; this
   * is that fact as a field, so a client does not have to parse prose the server
   * may reword. Additive under §8.
   */
  parentKey: workItemKeySchema.nullable(),
  /** The RESOLVED bare repo name, or `null` when Motir cannot say. */
  targetRepo: z.string().nullable(),
  /** Its HTTPS clone URL, or `null` when Motir does not know one. */
  targetRepoCloneUrl: z.string().nullable(),
  /** The resolved repo's default branch — never guessed as `"main"`. */
  targetRepoDefaultBranch: z.string().nullable(),
  workflowMode: dispatchWorkflowModeSchema,
  /** The session branch the prompt instructs, or `null` in `per_item_pr` mode. */
  sessionBranch: z.string().nullable(),
  advisories: z.array(dispatchAdvisorySchema),
});
export type V1DispatchPrompt = z.infer<typeof dispatchPromptSchema>;

/**
 * Map the dispatch payload to the wire — field by field, never a spread.
 *
 * The advisory objects are re-shaped per variant rather than passed through, so
 * a field added to `WorkItemProseAdvisoryDto` for an internal consumer cannot
 * become public API by accident. That is the whole job of this seam.
 */
export function presentDispatchPrompt(dto: DispatchPromptDto): V1DispatchPrompt {
  return {
    key: dto.key,
    prompt: dto.prompt,
    parentKey: dto.parentKey,
    targetRepo: dto.targetRepo,
    targetRepoCloneUrl: dto.targetRepoCloneUrl,
    targetRepoDefaultBranch: dto.targetRepoDefaultBranch,
    workflowMode: dto.workflowMode,
    sessionBranch: dto.sessionBranch,
    advisories: dto.advisories.map((advisory) =>
      advisory.kind === 'shape'
        ? {
            kind: 'shape' as const,
            item: advisory.item,
            severity: advisory.severity,
            criterionIndex: advisory.criterionIndex,
            ...(advisory.severity === 'likely-ordering-violation'
              ? { phrase: advisory.phrase }
              : { path: advisory.path, repo: advisory.repo, reason: advisory.reason }),
          }
        : {
            item: advisory.item,
            referenced: advisory.referenced,
            referencedStatus: advisory.referencedStatus,
            severity: advisory.severity,
          },
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session close-out — the two `integration`-scoped writes (11.7.4)
// ─────────────────────────────────────────────────────────────────────────────

/** Self-reported implementation provenance, applied by both close-out writes. */
export const implementationProvenanceSchema = z.object({
  implementationSource: z.enum(['byok', 'manual']).nullable(),
  implementationHarness: z.string().nullable(),
  implementationModel: z.string().nullable(),
});

/**
 * What recording ONE item as integrated returns.
 *
 * Deliberately NOT the whole work item: the operation answers "did the
 * integration land, and where?", and the caller that needs the item's fields has
 * `GET /api/v1/work-items/{key}` for that. A second full work-item shape here
 * would be a second place for the resource to drift.
 */
export const integrationResultSchema = z
  .object({
    key: workItemKeySchema,
    /** The status the workflow moved it to — `in_review` on the shipped default. */
    status: z.string(),
    /** The branch the work was integrated onto. */
    sessionBranch: z.string().nullable(),
    updatedAt: z.string(),
  })
  .extend(implementationProvenanceSchema.shape);

/** How ONE item on a closed session branch fared. */
export const sessionCloseOutItemSchema = z.object({
  key: workItemKeySchema,
  outcome: z.enum(['completed', 'already_done', 'failed']),
  /** Present only on `failed` — the typed error's message. */
  reason: z.string().optional(),
});

/**
 * The bulk close-out result.
 *
 * PER-ITEM outcomes rather than a single verdict, because the underlying write
 * deliberately does not roll back the items that DID complete when one cannot
 * reach `done`. A client that only read a status code would believe a partial
 * close-out was a total one.
 */
export const sessionCloseOutSchema = z.object({
  sessionBranch: z.string(),
  results: z.array(sessionCloseOutItemSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// The job handle — ADR Amendment 6 Q3
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a JOB-SUBMITTING endpoint returns: an expansion, or a plan-session
 * submit. Both answer 202.
 *
 * ⚠️ **This shape signals "accepted" by what it CANNOT carry.** There is no
 * `items`, no `proposals`, no `count` and no `status` — a client cannot read an
 * outcome out of it at all, only an address to come back to. That is stronger
 * than a `status: "accepted"` literal, which is a label a reader skims past and
 * which would collide with the PLAN's own status vocabulary. Nothing has been
 * planned when this is returned, and what eventually arrives is a plan of
 * PROPOSALS that only a human approving in Motir turns into work items.
 */
export const planJobHandleSchema = z.object({
  /** The motir-ai job. Nothing is waiting on it. */
  jobId: z.string(),
  /** The plan it will fill with proposals. */
  planId: z.string(),
  /** Where to read what became of it — a path, since the server behind a proxy
   *  cannot know its own public origin. */
  statusUrl: z.string(),
});
export type V1PlanJobHandle = z.infer<typeof planJobHandleSchema>;

/** Build the handle's poll address. ONE place, so the two 202 endpoints cannot
 *  hand back different URLs for the same read. */
export function planStatusUrl(planId: string): string {
  return `/api/v1/plans/${planId}/status`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plans — the two reads (11.7.5)
// ─────────────────────────────────────────────────────────────────────────────

/** A plan's own lifecycle state. There is deliberately no synthetic `failed`:
 *  a failed job leaves its plan `generating` forever, which is what `job` below
 *  is for. */
export const planStatusSchema = z.enum(['generating', 'planned', 'approved', 'declined']);

/** WHY the plan was started — someone clicked, or the cadence watcher fired. */
export const planOriginSchema = z.enum(['user', 'cadence']);

/** The producing job's liveness, present ONLY while the plan is `generating`. */
export const planJobStateSchema = z.object({
  status: z.string().nullable(),
  /** `false` ⟺ motir-ai could not be asked; `failure` then describes the outage. */
  reachable: z.boolean(),
  failure: z.object({ code: z.string(), message: z.string() }).nullable(),
});

/**
 * What became of a submitted planning job — the companion read to every handle.
 *
 * `proposalCount` is named for what it counts. The DTO calls it `itemCount`, and
 * "item" is the word this API uses for a WORK ITEM everywhere else; a client
 * reading `itemCount` off a plan would reasonably believe work items exist. None
 * do until the plan is approved.
 */
export const planOutcomeSchema = z.object({
  planId: z.string(),
  status: planStatusSchema,
  origin: planOriginSchema,
  jobId: z.string().nullable(),
  proposalCount: z.number().int(),
  createdAt: z.string(),
  plannedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  job: planJobStateSchema.nullable(),
});

/** What an `add` proposal would create. Every field but the title is optional —
 *  a proposal is a draft, not a validated work item. */
export const planProposalFieldsSchema = z.object({
  title: z.string(),
  kind: z.string().nullable(),
  type: z.string().nullable(),
  priority: z.string().nullable(),
  executor: z.string().nullable(),
  storyPoints: z.number().nullable(),
  estimateMinutes: z.number().int().nullable(),
  descriptionMd: z.string().nullable(),
  targetRepo: z.string().nullable(),
});

/**
 * ONE proposal.
 *
 * ⚠️ `workItemKey` is `null` for an un-materialized `add`, and that null IS the
 * contract: it is how a client can tell a proposal from a work item without
 * reading prose. `parentRef` / `blockedByRefs` are the PROPOSED tree, carried as
 * refs precisely because the nodes they name may not exist.
 */
export const planProposalSchema = z.object({
  id: z.string(),
  op: z.enum(['add', 'modify', 'remove']),
  /** The `MOTIR-<n>` this proposal targets or created — `null` until approval. */
  workItemKey: workItemKeySchema.nullable(),
  proposedFields: planProposalFieldsSchema.nullable(),
  patch: z.record(z.string(), z.unknown()).nullable(),
  parentRef: z.string().nullable(),
  blockedByRefs: z.array(z.string()),
});

/** A plan WITH the proposals it bundles. */
export const planSchema = z.object({
  id: z.string(),
  status: planStatusSchema,
  origin: planOriginSchema,
  title: z.string().nullable(),
  summary: z.string().nullable(),
  sourceJobId: z.string().nullable(),
  proposalCount: z.number().int(),
  createdAt: z.string(),
  plannedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  proposals: z.array(planProposalSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// The planning conversation (11.7.6)
// ─────────────────────────────────────────────────────────────────────────────

/** Who spoke. `system` marks the submit that sent the thread to the planner. */
export const planTurnRoleSchema = z.enum(['user', 'system', 'assistant']);

/** One turn, in `seq` order (0-based, gapless). */
export const planTurnSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  role: planTurnRoleSchema,
  body: z.string(),
  /** Set on the `system` turn a submit writes — the job it fired. */
  jobId: z.string().nullable(),
  question: z.string().nullable(),
  isAnswer: z.boolean(),
  authorId: z.string().nullable(),
  createdAt: z.string(),
});

/**
 * The planning thread, addressed by SCOPE and never by id.
 *
 * `id` is reported because a client may want to correlate two reads, and
 * deliberately NOT accepted anywhere: every operation addresses the thread by
 * `projectKey` + `targetKeys`, which is what makes re-opening the same anchor set
 * RESUME the same conversation the web app is looking at rather than fork a
 * second one. `targetKeys` is the anchor SET — order and duplicates do not
 * matter, and an empty array is the project-wide thread.
 */
export const planSessionSchema = z.object({
  id: z.string(),
  targetKeys: z.array(workItemKeySchema),
  turnCount: z.number().int(),
  lastJobId: z.string().nullable(),
  lastSubmittedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  turns: z.array(planTurnSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// The activity stream (11.7.7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One side of a change, in its DISPLAY form.
 *
 * The service ships DATA, not prose — a typed value the client turns into a
 * sentence — which is why the web app and the terminal can word the same change
 * differently without the server knowing either wording.
 */
export const activityValueSchema = z.union([
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('status'), key: z.string(), label: z.string().nullable() }),
  z.object({ type: z.literal('user'), userId: z.string(), name: z.string().nullable() }),
  z.object({ type: z.literal('date'), date: z.string() }),
  z.object({ type: z.literal('sprint'), sprintId: z.string(), name: z.string().nullable() }),
  z.object({ type: z.literal('issue'), workItemKey: workItemKeySchema.nullable() }),
]);

/** One renderable piece of a history entry. */
export const activityPartSchema = z.union([
  z.object({ kind: z.literal('created') }),
  z.object({ kind: z.literal('archived') }),
  z.object({ kind: z.literal('unarchived') }),
  z.object({
    kind: z.literal('field'),
    field: z.string(),
    from: activityValueSchema,
    to: activityValueSchema,
  }),
  /** The trail records THAT a body field changed, never its text. */
  z.object({ kind: z.literal('fieldEdited'), field: z.string() }),
  z.object({
    kind: z.literal('link'),
    op: z.enum(['added', 'removed']),
    linkKind: z.string(),
    target: activityValueSchema,
  }),
  z.object({
    kind: z.literal('collection'),
    field: z.string(),
    op: z.enum(['added', 'removed']),
    items: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('commentDeleted'),
    author: activityValueSchema,
    replyCount: z.number().int(),
  }),
  z.object({
    kind: z.literal('generic'),
    key: z.string(),
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
]);

/** One CHANGE-trail entry. `parts` is always ≥1 — a revision whose every diff
 *  key is suppressed produces no entry at all. */
export const activityChangeSchema = z.object({
  id: z.string(),
  changeKind: z.string(),
  changedAt: z.string(),
  actor: z.object({ userId: z.string(), name: z.string().nullable() }),
  parts: z.array(activityPartSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// The close-out mappers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The body BOTH close-out writes accept.
 *
 * `sessionBranch` rides in the body on both, and on the bulk close that is a
 * DECISION rather than a convention (ADR Amendment 6 Q1): a session branch is a
 * git ref and routinely contains `/`, a Next.js `[param]` segment does not match
 * one, and `%2F` is normalised away by proxies before the route ever sees it. A
 * body field carries the ref exactly as the caller wrote it.
 *
 * The provenance triple is a SELF-REPORT, so `source` admits only the two
 * self-reportable values — `hosted` is never accepted on this seam.
 */
export const closeOutProvenanceBodySchema = z.object({
  implementationSource: z.enum(['byok', 'manual']).optional(),
  implementationHarness: z.string().min(1).optional(),
  implementationModel: z.string().min(1).optional(),
});

/** `POST /api/v1/work-items/{key}/integration`. */
export const integrationBodySchema = z
  .object({ sessionBranch: z.string().min(1).max(200) })
  .extend(closeOutProvenanceBodySchema.shape)
  .strict();

/** `POST /api/v1/sessions/complete`. */
export const sessionCloseOutBodySchema = z
  .object({ sessionBranch: z.string().min(1).max(200) })
  .extend(closeOutProvenanceBodySchema.shape)
  .strict();

/**
 * The provenance triple as the SERVICE takes it, or `undefined` when the caller
 * reported none.
 *
 * The `undefined` is load-bearing and is why this is a function rather than a
 * spread at each route: passing a half-built object would stamp `byok` over a
 * hosted run's own record. Omitted → the item's recorded provenance is left
 * exactly as it is.
 *
 * The SAME distinction runs per FIELD (MOTIR-2447): an absent `implementation-
 * Harness` stays absent here rather than becoming an explicit `null`, so the
 * service can tell "I do not know" from "there is none" and leave a field a
 * previous report filled in. Writing `?? null` here is what let the close-out —
 * which knows only that the work was BYOK — erase the agent and model the run
 * had already recorded.
 */
export function toProvenanceInput(body: {
  implementationSource?: 'byok' | 'manual';
  implementationHarness?: string;
  implementationModel?: string;
}): { source?: 'byok' | 'manual'; harness?: string | null; model?: string | null } | undefined {
  if (
    body.implementationSource === undefined &&
    body.implementationHarness === undefined &&
    body.implementationModel === undefined
  ) {
    return undefined;
  }
  return {
    ...(body.implementationSource === undefined ? {} : { source: body.implementationSource }),
    ...(body.implementationHarness === undefined ? {} : { harness: body.implementationHarness }),
    ...(body.implementationModel === undefined ? {} : { model: body.implementationModel }),
  };
}

export type V1IntegrationResult = z.infer<typeof integrationResultSchema>;
export type V1SessionCloseOut = z.infer<typeof sessionCloseOutSchema>;

/** What `markIntegrated` returns, shaped for the wire — field by field. */
export function presentIntegrationResult(item: {
  identifier: string;
  status: string;
  sessionBranch: string | null;
  updatedAt: string;
  implementationSource: 'hosted' | 'byok' | 'manual' | null;
  implementationHarness: string | null;
  implementationModel: string | null;
}): V1IntegrationResult {
  return {
    key: item.identifier,
    status: item.status,
    sessionBranch: item.sessionBranch,
    updatedAt: item.updatedAt,
    // `hosted` cannot be reported on this seam, but it CAN already be on the row
    // (a hosted run stamped it), so the wire shape has to be able to say so. The
    // BODY's enum is the narrow one; this is the read-back.
    implementationSource: item.implementationSource === 'hosted' ? null : item.implementationSource,
    implementationHarness: item.implementationHarness,
    implementationModel: item.implementationModel,
  };
}

/**
 * What the bulk close returns — the per-item outcomes, verbatim.
 *
 * ⚠️ The per-item result IS the payload. A branch with a dozen items can
 * legitimately close nine and skip three, and that is neither a failure nor a
 * uniform success: the underlying write deliberately does not roll back the nine.
 * Nothing here collapses the list into a count or a boolean, and a client reports
 * what came back rather than re-deriving an outcome from a length.
 */
export function presentSessionCloseOut(result: {
  sessionBranch: string;
  results: { key: string; outcome: 'completed' | 'already_done' | 'failed'; reason?: string }[];
}): V1SessionCloseOut {
  return {
    sessionBranch: result.sessionBranch,
    results: result.results.map((item) => ({
      key: item.key,
      outcome: item.outcome,
      // Present only on `failed` — an `undefined` here is an absent key on the
      // wire, which is what the schema declares.
      ...(item.reason === undefined ? {} : { reason: item.reason }),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The plan mappers (11.7.5)
// ─────────────────────────────────────────────────────────────────────────────

export type V1PlanOutcome = z.infer<typeof planOutcomeSchema>;

/**
 * Turn the page's resolved references into the `keyOfId` {@link presentPlan}
 * takes.
 *
 * A tiny function rather than a closure in the route, because its THREE states
 * are the whole §7 story and each deserves a test: an id the read returned
 * nothing for (deleted, or cross-workspace), one it returned as NOT accessible
 * (it exists, in a project this caller may not browse), and one it resolved. The
 * first two both become `undefined` → `null` on the wire; neither ever leaks the
 * cuid, and the second is the arm a route-level closure would leave untested.
 */
export function planTargetKeyResolver(
  refs: Readonly<Record<string, { accessible: boolean; identifier?: string }>>,
): (id: string) => string | undefined {
  return (id) => {
    const ref = refs[id];
    if (ref === undefined || !ref.accessible) return undefined;
    return ref.identifier;
  };
}
export type V1Plan = z.infer<typeof planSchema>;

/** The job handle both 202 endpoints return. */
export function presentPlanJobHandle(result: { jobId: string; planId: string }): V1PlanJobHandle {
  return {
    jobId: result.jobId,
    planId: result.planId,
    statusUrl: planStatusUrl(result.planId),
  };
}

/**
 * What became of a submitted job — field by field.
 *
 * `projectId` is DROPPED rather than mapped: it is an internal cuid, and §7's
 * rule is that an identifier on the wire is the one a user sees. A caller who
 * asked about this plan already knows which project it asked in.
 */
export function presentPlanOutcome(outcome: PlanOutcomeDto): V1PlanOutcome {
  return {
    planId: outcome.planId,
    status: outcome.status,
    origin: outcome.origin,
    jobId: outcome.jobId,
    // RENAMED from the DTO's `itemCount`: "item" means WORK ITEM everywhere else
    // on this API, and a client reading `itemCount` off a plan would reasonably
    // believe that many work items exist. None do until the plan is approved.
    proposalCount: outcome.itemCount,
    createdAt: outcome.createdAt,
    plannedAt: outcome.plannedAt,
    decidedAt: outcome.decidedAt,
    job:
      outcome.job === null
        ? null
        : {
            status: outcome.job.status,
            reachable: outcome.job.reachable,
            failure:
              outcome.job.failure === null
                ? null
                : { code: outcome.job.failure.code, message: outcome.job.failure.message },
          },
  };
}

/**
 * A plan WITH its proposals — field by field, and NEVER a cuid.
 *
 * `workItemId` on a `modify` / `remove` is the internal id, which §7 forbids on
 * the wire; `keyOfId` resolves it to the `MOTIR-<n>` a client can act on. An id
 * that does not resolve — a deleted target, or one in a project this caller may
 * not browse — becomes `null` rather than leaking the cuid, exactly as
 * `presentWorkItemRef` degrades an unresolvable parent.
 *
 * An `add`'s target is `null` because no work item exists yet, and THAT null is
 * the contract: it is how a client tells a proposal from a work item without
 * reading prose.
 */
export function presentPlan(
  plan: PlanWithItemsDto,
  keyOfId: (id: string) => string | undefined,
): V1Plan {
  return {
    id: plan.id,
    status: plan.status,
    origin: plan.origin,
    title: plan.title,
    summary: plan.summary,
    sourceJobId: plan.sourceJobId,
    proposalCount: plan.itemCount,
    createdAt: plan.createdAt,
    plannedAt: plan.plannedAt,
    decidedAt: plan.decidedAt,
    proposals: plan.items.map((item) => ({
      id: item.id,
      op: item.op,
      workItemKey: item.workItemId === null ? null : (keyOfId(item.workItemId) ?? null),
      proposedFields:
        item.proposedFields === null ? null : presentProposedFields(item.proposedFields),
      patch: item.patch === null ? null : { ...item.patch },
      parentRef: item.parentRef,
      blockedByRefs: item.blockedByRefs,
    })),
  };
}

/** An `add`'s proposed values — shaped explicitly, so a field the planner starts
 *  sending for an internal reason does not become public API by accident. */
function presentProposedFields(
  fields: PlanItemProposedFields,
): z.infer<typeof planProposalFieldsSchema> {
  return {
    title: fields.title,
    kind: fields.kind ?? null,
    type: fields.type ?? null,
    priority: fields.priority ?? null,
    executor: fields.executor ?? null,
    storyPoints: fields.storyPoints ?? null,
    estimateMinutes: fields.estimateMinutes ?? null,
    descriptionMd: fields.descriptionMd ?? null,
    targetRepo: fields.targetRepo ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The planning conversation (11.7.6)
// ─────────────────────────────────────────────────────────────────────────────

export type V1PlanSession = z.infer<typeof planSessionSchema>;

/**
 * The optional ANCHOR SET, on all three conversation endpoints.
 *
 * It rides in the BODY (ADR Amendment 6 Q1) because it is a SET whose order and
 * duplicates do not matter — `buildScope` dedupes and sorts before deriving the
 * thread's key — and a repeated query parameter would encode it as an ordered
 * list, so two spellings of one thread would look different at the edge before
 * the service normalised them.
 *
 * Omitted or empty means the PROJECT-WIDE thread. There is deliberately no
 * session id here or anywhere else on this resource: a thread's identity is
 * `(project, anchor set)`, and handing a client an id is exactly how a second
 * conversation about one anchor set gets forked.
 */
export const planSessionScopeBodySchema = z
  .object({ targetKeys: z.array(z.string().min(1)).optional() })
  .strict();

/** `POST …/plan-session/turns` — the scope, plus what to say. */
export const planTurnBodySchema = z
  .object({
    targetKeys: z.array(z.string().min(1)).optional(),
    /** What you want changed about the plan. */
    body: z.string().min(1),
  })
  .strict();

/** Map the thread to the wire — field by field, never a spread. */
export function presentPlanSession(session: {
  id: string;
  targetKeys: string[];
  turnCount: number;
  lastJobId: string | null;
  lastSubmittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  turns: {
    id: string;
    seq: number;
    role: 'user' | 'system' | 'assistant';
    body: string;
    jobId: string | null;
    question: string | null;
    isAnswer: boolean;
    authorId: string | null;
    createdAt: string;
  }[];
}): V1PlanSession {
  return {
    id: session.id,
    targetKeys: session.targetKeys,
    turnCount: session.turnCount,
    lastJobId: session.lastJobId,
    lastSubmittedAt: session.lastSubmittedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turns: session.turns.map((turn) => ({
      id: turn.id,
      seq: turn.seq,
      role: turn.role,
      body: turn.body,
      jobId: turn.jobId,
      question: turn.question,
      isAnswer: turn.isAnswer,
      authorId: turn.authorId,
      createdAt: turn.createdAt,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The activity stream (11.7.7)
// ─────────────────────────────────────────────────────────────────────────────

/** The three views, mirroring the product's own Activity tabs. */
export const ACTIVITY_VIEWS = ['all', 'comments', 'history'] as const;
export type V1ActivityView = (typeof ACTIVITY_VIEWS)[number];

/** Which collection an activity cursor is scoped to — ONE PER VIEW. */
export const ACTIVITY_COLLECTION: Record<V1ActivityView, V1Collection> = {
  all: 'workItemActivityAll',
  comments: 'workItemActivityComments',
  history: 'workItemActivityHistory',
};

/**
 * ONE entry, in ONE representation, whichever view produced it.
 *
 * The three views are not three endpoints and not three shapes: `comments`
 * yields only `comment` entries, `history` only `change` entries, and `all` both
 * INTERLEAVED — so a client writes one renderer and switches on `type`, exactly
 * as the product's own Activity section does.
 *
 * The comment side reuses 11.2's `commentThreadSchema` verbatim rather than
 * declaring a second comment shape: `GET …/comments` and `?view=comments` read
 * the same service, and one declaration is what stops them from ever disagreeing.
 */
export const activityEntrySchema = z.union([
  z.object({ type: z.literal('comment'), comment: commentThreadSchema }),
  z.object({ type: z.literal('change'), change: activityChangeSchema }),
]);
export type V1ActivityEntry = z.infer<typeof activityEntrySchema>;

/**
 * The activity page's PER-SOURCE totals, beside the envelope's `totalCount`
 * (ADR Amendment 15).
 *
 * The `all` view merges two streams, and "how many are there" has two answers
 * for it. `totalCount` keeps meaning what it means on every other ranked page —
 * the whole view's size, here the sum — and these two say what it is made of.
 *
 * ⚠️ NULLABLE, and the null is load-bearing: it means **this view did not count
 * that source**, which is different from counting it and finding none. The
 * single-kind views each populate the one they actually counted and null the
 * other — `comments` knows its comment total and nothing about changes, and
 * `history` the reverse. Reporting `0` there would state, falsely, that the
 * item has no changes.
 */
export const activityTotalsSchema = z.object({
  /** Every comment on the item, replies included — `null` on the `history` view. */
  totalComments: z.number().int().nonnegative().nullable(),
  /** Displayable revisions in the whole trail — `null` on the `comments` view. */
  totalChanges: z.number().int().nonnegative().nullable(),
});
export type V1ActivityTotals = z.infer<typeof activityTotalsSchema>;

/** Map ONE history entry to the wire — field by field, never a spread. */
export function presentActivityChange(entry: {
  id: string;
  changeKind: string;
  changedAt: string;
  actor: { userId: string; name: string | null };
  parts: unknown[];
}): z.infer<typeof activityChangeSchema> {
  return {
    id: entry.id,
    changeKind: entry.changeKind,
    changedAt: entry.changedAt,
    actor: { userId: entry.actor.userId, name: entry.actor.name },
    parts: entry.parts.map(presentActivityPart),
  };
}

/**
 * ONE renderable piece of a change.
 *
 * ⚠️ LOOSE ON PURPOSE, and this is the card's real constraint. A published
 * client meets NEWER servers: a part kind — or a value type inside one — that
 * this schema does not know must come back in its GENERIC form rather than fail
 * the read, because a client that 500s on a part it has never seen cannot be
 * fixed by upgrading the server. So an unrecognised kind is projected onto
 * `generic`, which every client already has to render.
 */
function presentActivityPart(part: unknown): z.infer<typeof activityPartSchema> {
  const p = part as Record<string, unknown>;
  switch (p['kind']) {
    case 'created':
    case 'archived':
    case 'unarchived':
      return { kind: p['kind'] };
    case 'field':
      return {
        kind: 'field',
        field: String(p['field']),
        from: presentActivityValue(p['from']),
        to: presentActivityValue(p['to']),
      };
    case 'fieldEdited':
      return { kind: 'fieldEdited', field: String(p['field']) };
    case 'link':
      return {
        kind: 'link',
        op: p['op'] === 'removed' ? 'removed' : 'added',
        linkKind: String(p['linkKind']),
        target: presentActivityValue(p['target']),
      };
    case 'collection':
      return {
        kind: 'collection',
        field: String(p['field']),
        op: p['op'] === 'removed' ? 'removed' : 'added',
        items: Array.isArray(p['items']) ? p['items'].map(String) : [],
      };
    case 'commentDeleted':
      return {
        kind: 'commentDeleted',
        author: presentActivityValue(p['author']),
        replyCount: typeof p['replyCount'] === 'number' ? p['replyCount'] : 0,
      };
    default:
      // Every unknown kind, INCLUDING the DTO's own `generic`, lands here — the
      // one branch a client is guaranteed to be able to render.
      return {
        kind: 'generic',
        key: typeof p['key'] === 'string' ? p['key'] : String(p['kind'] ?? 'unknown'),
        from: typeof p['from'] === 'string' ? p['from'] : null,
        to: typeof p['to'] === 'string' ? p['to'] : null,
      };
  }
}

/** One side of a change, in its display form — same loose contract. */
function presentActivityValue(value: unknown): z.infer<typeof activityValueSchema> {
  const v = (value ?? {}) as Record<string, unknown>;
  switch (v['type']) {
    case 'text':
      return { type: 'text', text: String(v['text']) };
    case 'status':
      return {
        type: 'status',
        key: String(v['key']),
        label: typeof v['label'] === 'string' ? v['label'] : null,
      };
    case 'user':
      return {
        type: 'user',
        userId: String(v['userId']),
        name: typeof v['name'] === 'string' ? v['name'] : null,
      };
    case 'date':
      return { type: 'date', date: String(v['date']) };
    case 'sprint':
      return {
        type: 'sprint',
        sprintId: String(v['sprintId']),
        name: typeof v['name'] === 'string' ? v['name'] : null,
      };
    case 'issue':
      // §7: a work item is named by its KEY. The DTO also carries the internal
      // `workItemId`, which is DROPPED — an identifier the read could not
      // resolve becomes `null` rather than a cuid on the wire.
      return {
        type: 'issue',
        workItemKey: typeof v['identifier'] === 'string' ? v['identifier'] : null,
      };
    default:
      // An unknown value type degrades to `none`, the empty side every renderer
      // already handles — never a validation failure.
      return { type: 'none' };
  }
}
