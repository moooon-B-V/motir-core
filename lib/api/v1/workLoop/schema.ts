import { z } from 'zod/v4';
import { workItemKeySchema } from '@/lib/api/v1/workItems/schema';
import type { DispatchPromptDto } from '@/lib/dto/dispatch';

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
