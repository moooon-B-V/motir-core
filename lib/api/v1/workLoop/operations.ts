import { z } from 'zod/v4';
import type { ZodType } from 'zod/v4';
import { defineOperation, type V1Operation } from '@/lib/api/v1/openapi/operation';
import {
  dispatchPromptSchema,
  implementationReportBodySchema,
  implementationReportSchema,
  integrationBodySchema,
  integrationResultSchema,
  planJobHandleSchema,
  planOutcomeSchema,
  planSchema,
  planSessionSchema,
  planSessionScopeBodySchema,
  planTurnBodySchema,
  workItemClaimSchema,
  scopeClaimBodySchema,
  scopeClaimSchema,
  ACTIVITY_VIEWS,
  activityEntrySchema,
  activityTotalsSchema,
  sessionCloseOutBodySchema,
  sessionCloseOutSchema,
} from '@/lib/api/v1/workLoop/schema';

// The WORK-LOOP operation declarations (Story 11.7 · Subtask 11.7.3 —
// MOTIR-2237). Paths, verbs and scopes come from ADR Amendment 6 Q1/Q2; the
// scope of each was read off the SHIPPED `lib/mcp/scopes.ts` entry its MCP
// counterpart carries, never re-derived from the HTTP verb.
//
// ⚠️ **A DECLARATION TRAVELS WITH ITS ROUTE.**
// `tests/api/v1/openapi-operations-coverage.test.ts` asserts both directions —
// every exported verb is documented, AND no operation names a route that does
// not exist. So this module grows one entry per endpoint card (11.7.4–11.7.7)
// rather than being written out in full here: an operation with no route would
// put a path in the published document that answers 404, which is worse for a
// client than a document that is still filling in.
//
// The schemas those cards return into are ALREADY declared, in
// `./schema.ts` — that is what makes them adapters rather than designers, and it
// is the half of "declare ahead" that has no such constraint.

/** The one work-loop endpoint that has shipped so far. */
export const WORK_LOOP_OPERATIONS: readonly V1Operation[] = [
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}/dispatch-prompt',
    operationId: 'getWorkItemDispatchPrompt',
    summary: 'Read the canonical coding-agent prompt for a work item',
    description:
      'Return the server-assembled prompt for one work item — the CONTEXT / WHAT TO DO / ' +
      'ACCEPTANCE CRITERIA / GIT WORKFLOW sections built from the item, its parent, its ' +
      'dependencies and its repo — plus the repo to run it in and which git workflow it ' +
      'carries. A PURE READ: it does not claim the item, move its status, or change its ' +
      'recorded session branch, so fetching a prompt to look at it is always safe. The text ' +
      'is deliberately identical for every agent harness; do not rewrite it. `advisories` is ' +
      'never a gate — it changes what you are told, never what you may do.',
    permission: 'project:browse',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item’s `MOTIR-<n>` key (case-insensitive).',
        schema: z.string(),
      },
      {
        name: 'sessionBranch',
        in: 'query',
        required: false,
        description:
          'A session branch to FALL BACK to when this item carries no lineage of its own — ' +
          'the unattended-run seed. It never overrides: an item whose dependencies are ' +
          'already integrated, or that is itself integrated, keeps its own branch, so a ' +
          'caller cannot redirect a live lineage.',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: dispatchPromptSchema },
      description: 'The assembled prompt and the facts a client routes on.',
    },
    // 404 covers both "no such item" and "outside your workspace" (§4); 422 is a
    // malformed key or an unsafe `sessionBranch`.
    errorStatuses: [404, 422],
  }),

  // ── The keyed CLAIM (MOTIR-2961) ────────────────────────────────────────
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/claim',
    operationId: 'claimWorkItem',
    summary: 'Atomically claim one work item by key',
    description:
      'CLAIM one work item, named by key, so that concurrent dispatchers cannot both start it. ' +
      'In ONE transaction the row is locked, its status is re-checked against the TO-DO ' +
      'category, and — if it holds — the item is assigned to the caller AND moved to ' +
      '\u201cIn progress\u201d. The to-do category is `todo` AND `blocked`, so a deliberately ' +
      'forced dispatch of an item whose dependencies are unmet still works. ' +
      '\u26a0\ufe0f A refusal is a 200 with an `outcome`, not an error, because three of the ' +
      'four outcomes are ordinary: `claimed` (it is yours), `mine` (already yours \u2014 resume ' +
      'your own interrupted run), `taken` (somebody else holds it, and they are named), ' +
      '`not_claimable` (finished, under review, or otherwise outside the to-do category). ' +
      'Claiming is IDEMPOTENT for the holder and never re-opens finished work. ' +
      'The claim IS the dispatch status flip \u2014 do not also POST a transition afterwards.',
    permission: 'work_item:edit',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item\u2019s `MOTIR-<n>` key (case-insensitive).',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: workItemClaimSchema },
      description: 'What the claim resolved to, and who holds the item.',
    },
    // 404 for an unknown or cross-workspace key (no existence leak); 422 for a
    // malformed key. A LOST claim is not an error status \u2014 see `outcome`.
    errorStatuses: [404, 422],
  }),

  // ── The SCOPE claim (MOTIR-3049) ────────────────────────────────────────
  defineOperation({
    method: 'POST',
    path: '/api/v1/scope-claims',
    operationId: 'claimScope',
    summary: 'Atomically claim a whole story or sprint, all or nothing',
    description:
      'CLAIM an entire SCOPE — a container work item and its children, or a project’s ACTIVE ' +
      'sprint — so a scoped run owns the whole set before its first agent starts. In ONE ' +
      'transaction the scope is validated, every row is locked in a deterministic order, every ' +
      'row’s status is re-checked against the TO-DO category, and — if all of them hold ' +
      '— every row is assigned to the caller AND moved to “In progress”. ' +
      '⚠️ ALL OR NOTHING: if ANY member is un-claimable the whole claim rolls back and ' +
      'NOTHING is written, because a partially-claimed scope is the one outcome with no good ' +
      'handling — you can neither finish it nor cleanly abandon it. ' +
      '⚠️ EVERY WORK ITEM IN A CLAIMED SCOPE READS “In progress” FOR THE WHOLE ' +
      'RUN, while only one of them is being worked at a time. That is deliberate and it changes ' +
      'what the status MEANS: from “an agent is on this right now” to “this run ' +
      'owns it”. The board therefore shows the run’s FOOTPRINT rather than its cursor ' +
      '— the price of exclusive ownership, which is what lets a scoped run promise to ' +
      'finish what it started. ' +
      'A refusal is a 200 with an `outcome`: `claimed`, `mine` (already yours — resume), ' +
      '`taken` (a member is held by somebody else, and they are named), `not_claimable` (a ' +
      'member is finished or under review), `wrong_shape` (a work-item scope whose child is ' +
      'itself a container — re-plan it, do not retry), `not_finishable` (work OUTSIDE the ' +
      'scope gates work inside it). ' +
      'A STORY scope is ONE LAYER and that is checked; a SPRINT scope may span many layers and ' +
      'no shape check applies, because `validate_sprint` has already guaranteed its membership ' +
      'is closed. A sprint’s scope is exactly the items whose OWN `sprintId` matches — ' +
      'an item under an in-sprint parent but not itself in the sprint is NOT claimed. ' +
      'The claim IS the dispatch status flip — do not also POST a transition afterwards.',
    permission: 'work_item:edit',
    parameters: [],
    requestBody: {
      schema: scopeClaimBodySchema,
      description:
        'The scope to claim: `{ "kind": "work_item", "key": "MOTIR-42" }` for a container and ' +
        'its children, or `{ "kind": "sprint", "projectKey": "MOTIR" }` for that project’s ' +
        'active sprint.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: scopeClaimSchema },
      description: 'What the claim resolved to, and — on a refusal — why.',
    },
    // 404 for an unknown or cross-workspace key/project (no existence leak); 409
    // when the named project has no ACTIVE sprint; 422 for a malformed key or
    // body. A LOST or REFUSED claim is not an error status — see `outcome`.
    errorStatuses: [404, 409, 422],
  }),

  // ── Session close-out (Subtask 11.7.4 — MOTIR-2238) ─────────────────────
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/integration',
    operationId: 'recordWorkItemIntegration',
    summary: 'Record a work item as integrated on a session branch',
    description:
      'Record that a work item’s work has been integrated onto a session branch: it moves to ' +
      '“In review” and records the branch, in ONE transaction, which unblocks its dependents ' +
      'while the session pull request awaits a human merge. Optionally self-report the ' +
      'implementation harness and model (`implementationSource` defaults to `byok`); omit all ' +
      'three to leave the item’s recorded provenance untouched. Honors the project’s workflow ' +
      'rules — an item with no legal path to “In review” is refused and its branch is left ' +
      'unchanged.',
    permission: 'work_item:edit',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item’s `MOTIR-<n>` key (case-insensitive).',
        schema: z.string(),
      },
    ],
    requestBody: {
      schema: integrationBodySchema,
      description: 'The session branch the work was integrated onto, and optional provenance.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: integrationResultSchema },
      description: 'The item’s new status, its recorded branch and its provenance.',
    },
    // 422 covers a malformed key, a failed body validation, and the workflow's
    // own refusal (`ILLEGAL_TRANSITION`).
    errorStatuses: [404, 422],
  }),

  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/implementation',
    operationId: 'reportWorkItemImplementation',
    summary: 'Record what BUILT a work item',
    description:
      'Record implementation provenance — the harness and model an agent ran as, and whether ' +
      'the run was `byok` or `manual` — WITHOUT asserting anything about where the work is ' +
      'integrated. Use this on the per-item pull-request path, where there is no session ' +
      'branch to report; use `POST …/integration` when there is one. It moves NO status and ' +
      'leaves the item’s session branch untouched, both of which are echoed back so a client ' +
      'can see it. A field you omit is left exactly as it is — omitting all of them changes ' +
      'nothing.',
    permission: 'work_item:edit',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item’s `MOTIR-<n>` key (case-insensitive).',
        schema: z.string(),
      },
    ],
    requestBody: {
      schema: implementationReportBodySchema,
      description:
        'The provenance to record. `sessionBranch` is NOT accepted here — send it to ' +
        '`POST …/integration`, which is the operation that asserts integration.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: implementationReportSchema },
      description: 'The item’s recorded provenance, with its unchanged status and branch.',
    },
    errorStatuses: [404, 422],
  }),

  defineOperation({
    method: 'POST',
    path: '/api/v1/sessions/complete',
    operationId: 'completeSession',
    summary: 'Close out a merged session branch',
    description:
      'Close out a session branch after its pull request is merged: every work item recorded ' +
      'on the branch moves to “Done” and its recorded branch is cleared. Returns a PER-ITEM ' +
      'outcome (`completed` / `already_done` / `failed`) — a partial close-out is a real ' +
      'result, not an error: the items that could close DID, and the ones that could not are ' +
      'named with a reason. Read the results; do not infer an outcome from their count. A ' +
      'branch nothing is recorded on returns an empty list, not a 404. The branch travels in ' +
      'the BODY because a git ref routinely contains `/`.',
    permission: 'work_item:edit',
    parameters: [],
    requestBody: {
      schema: sessionCloseOutBodySchema,
      description: 'The merged session branch, and optional provenance for every item closed.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: sessionCloseOutSchema },
      description: 'The branch and one outcome per item that was recorded on it.',
    },
    errorStatuses: [422],
  }),

  // ── Expansion + the two plan reads (Subtask 11.7.5 — MOTIR-2239) ────────
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/expansions',
    operationId: 'submitWorkItemExpansion',
    summary: 'Submit an AI expansion of a container work item',
    description:
      'Submit an AI expansion of one CONTAINER work item (epic / story / task / bug): the ' +
      'planner drafts the children it should have. Returns `202` with `{ jobId, planId, ' +
      'statusUrl }` the moment the job is ACCEPTED — it does not wait for the planner, and ' +
      'the body carries no result because there is none yet. ' +
      '⚠️ IMPORTANT: this does NOT create work items. The job produces a PLAN of proposals, ' +
      'and approving that plan in Motir is the only thing that turns a proposal into a work ' +
      'item. Do not report expanded children as created. ' +
      '⚠️ A submit SPENDS the token owner’s AI credits, so wrapping this call in a blind ' +
      'retry-on-timeout costs real money — poll `statusUrl` instead of resubmitting. A leaf ' +
      '(subtask) cannot be expanded.',
    permission: 'ai:plan',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The container work item’s `MOTIR-<n>` key (case-insensitive).',
        schema: z.string(),
      },
    ],
    response: {
      status: 202,
      body: { kind: 'object', schema: planJobHandleSchema },
      description:
        'The job was accepted. Nothing has been planned yet — poll `statusUrl` for the outcome.',
    },
    // 422: a malformed key, or a target that is not a container. 402: the
    // owner's AI credits are exhausted. 503: motir-ai could not be reached.
    errorStatuses: [402, 404, 422, 503],
  }),

  defineOperation({
    method: 'GET',
    path: '/api/v1/plans/{planId}/status',
    operationId: 'getPlanStatus',
    summary: 'Read what became of a submitted planning job',
    description:
      'Read a plan’s status (`generating` / `planned` / `approved` / `declined`), how many ' +
      'PROPOSALS it bundles, and — while it is still generating — whether the producing job ' +
      'is alive or already FAILED. That last distinction is the point of this endpoint: a ' +
      'failed job writes no terminal plan state of its own — a background reconciler declines ' +
      'an empty one within the hour, so the plan status alone cannot tell you to stop polling ' +
      'NOW. `job.reachable: false` means motir-ai could not be asked, not ' +
      'that the job died. A pure read; the proposal count is NOT a count of created work items.',
    permission: 'project:browse',
    parameters: [
      {
        name: 'planId',
        in: 'path',
        required: true,
        description: 'The plan id an expansion or plan-session submit returned.',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: planOutcomeSchema },
      description: 'The plan’s status, its proposal count, and the job’s liveness.',
    },
    errorStatuses: [404],
  }),

  defineOperation({
    method: 'GET',
    path: '/api/v1/plans/{planId}',
    operationId: 'getPlan',
    summary: 'Read a plan with the proposals it bundles',
    description:
      'Read a plan WITH its proposals — what a planning pass actually proposed, not just how ' +
      'many. Each proposal carries its `op` (`add` / `modify` / `remove`), the ' +
      '`proposedFields` of an `add`, the `patch` of a `modify`, and the `parentRef` / ' +
      '`blockedByRefs` that let you rebuild the proposed tree and its dependency edges. ' +
      '⚠️ These are PROPOSALS, not work items: an `add`’s `workItemKey` is `null` and stays ' +
      'null until the plan is approved in Motir, which is the only path from a proposal to a ' +
      'work item. A plan still generating returns the proposals that have arrived so far.',
    permission: 'project:browse',
    parameters: [
      {
        name: 'planId',
        in: 'path',
        required: true,
        description: 'The plan id.',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: planSchema },
      description: 'The plan and its proposals.',
    },
    errorStatuses: [404],
  }),

  // ── Automatic plan approval (MOTIR-3021 / MOTIR-3023) ───────────────────
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/plan-approval',
    operationId: 'approveWorkItemPlan',
    summary: 'Approve the plan this work item produced',
    description:
      'APPROVE the plan a work item’s own re-plan produced, without a browser session — the ' +
      'entrance `motir auto --auto-approve-replan` drives. Its proposals become work items: an ' +
      '`add` creates, a `modify` applies to the same item, a `remove` archives. ⚠️ IT IS ' +
      'ADDRESSED BY THE WORK ITEM, and that is the bound: the server resolves the plan from the ' +
      'planning conversation ANCHORED at this key, so there is no way to name a plan the item ' +
      'did not produce. Every other plan — a cadence plan, an onboarding generation, one ' +
      'submitted from the project-wide panel — is refused here and keeps the human decision it ' +
      'was written under. It calls the same service the in-app approve does, so the ' +
      'confirmation gate, the re-validation and the one-shot concurrency guard are identical; a ' +
      'plan that has already been approved or declined answers 409, exactly as it does in the app.',
    // `ai:decide_plan` since MOTIR-3188 — the key `approvePlan` asserts. It was
    // `ai:view_plan` when this operation shipped; that key gated no view and held
    // AUTHOR and DECIDE together, and the decisions moved to the new one. The
    // operation's shape, statuses and error codes are untouched, and both keys
    // resolve to exactly the same actors under every built-in role.
    permission: 'ai:decide_plan',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item whose plan is approved (case-insensitive).',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: planSchema },
      description:
        'The approved plan and its proposals, each now carrying the `workItemKey` it ' +
        'materialized into. The plan’s own id is on the body, which is how a caller that never ' +
        'knew it can report what was approved.',
    },
    // 404: no such work item, or one in another tenant. 422: no plan anchored to
    // the card, or a proposal the confirmation gate rejected before any write —
    // including the malformed-set refusals the browser route answers 400 for,
    // which take 422 here because this API's status vocabulary is closed and has
    // no 400 (`lib/api/v1/errors.ts` says why on the row). 409: already decided,
    // or a target that moved under the proposal.
    errorStatuses: [404, 409, 422],
  }),

  // ── The planning conversation (Subtask 11.7.6 — MOTIR-2240) ─────────────
  defineOperation({
    method: 'POST',
    path: '/api/v1/projects/{projectKey}/plan-session',
    operationId: 'openPlanSession',
    summary: 'Open or resume the planning conversation for a scope',
    description:
      'Open — or RESUME — the planning conversation for a project, and read its thread. ' +
      'Changing a plan in Motir is a multi-turn CONVERSATION: add turns, then send the ' +
      'accumulated intent. There is ONE thread per project per anchor set, so calling this ' +
      'again returns the SAME conversation, with every turn already on it — including the one ' +
      'the Motir web app shows. Pass `targetKeys` to anchor the conversation at specific work ' +
      'items ("re-plan these two"); omit it for the project-wide thread. The anchor set is ' +
      'the thread’s identity: order and duplicates do not matter. ' +
      'Opening submits nothing and costs nothing — which is why it is `read`-scoped despite ' +
      'being a POST (a GET that creates a row would not be safe).',
    permission: 'ai:plan',
    parameters: [
      {
        name: 'projectKey',
        in: 'path',
        required: true,
        description: 'The project key, e.g. `MOTIR`.',
        schema: z.string(),
      },
    ],
    requestBody: {
      schema: planSessionScopeBodySchema,
      description: 'The optional anchor set. Omit for the project-wide thread.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: planSessionSchema },
      description: 'The thread, with every turn on it.',
    },
    errorStatuses: [404, 422],
  }),

  defineOperation({
    method: 'POST',
    path: '/api/v1/projects/{projectKey}/plan-session/turns',
    operationId: 'appendPlanTurn',
    summary: 'Add one turn to the planning conversation',
    description:
      'Add ONE turn — what you want changed about the plan. ' +
      '⚠️ IMPORTANT: appending does NOT submit. The turn is persisted immediately, but no ' +
      'job starts, no credits are spent and no work item changes; turns ACCUMULATE until you ' +
      'post a submission, which is what sends them to the planner. That separation is the ' +
      'point — a later turn REFINES the earlier ones rather than replacing them, so "add auth ' +
      'to the billing epic" then "keep them under 3 points" go out as ONE coherent change. ' +
      'Addresses the thread by scope, so it always extends the same conversation.',
    permission: 'ai:plan',
    parameters: [
      {
        name: 'projectKey',
        in: 'path',
        required: true,
        description: 'The project key, e.g. `MOTIR`.',
        schema: z.string(),
      },
    ],
    requestBody: {
      schema: planTurnBodySchema,
      description: 'What to say in this turn, and the optional anchor set it belongs to.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: planSessionSchema },
      description: 'The thread, with the new turn appended.',
    },
    errorStatuses: [404, 409, 422],
  }),

  defineOperation({
    method: 'POST',
    path: '/api/v1/projects/{projectKey}/plan-session/submissions',
    operationId: 'submitPlanSession',
    summary: 'Send the thread’s accumulated intent to the planner',
    description:
      'Send this conversation’s accumulated intent to the planner: every turn on the thread, ' +
      'in order, as ONE change. Returns `202` with `{ jobId, planId, statusUrl }` the moment ' +
      'the job is accepted — it does not wait, and the body carries no result because there ' +
      'is none yet. The thread stays INTACT and can be refined with another turn. ' +
      '⚠️ This is the act that SPENDS the token owner’s AI credits, and it produces a PLAN of ' +
      'proposals: approving that plan in Motir is the only thing that turns a proposal into a ' +
      'work item. Submitting a thread with no turns is refused.',
    permission: 'ai:plan',
    parameters: [
      {
        name: 'projectKey',
        in: 'path',
        required: true,
        description: 'The project key, e.g. `MOTIR`.',
        schema: z.string(),
      },
    ],
    requestBody: {
      schema: planSessionScopeBodySchema,
      description: 'The optional anchor set naming which thread to submit.',
    },
    response: {
      status: 202,
      body: { kind: 'object', schema: planJobHandleSchema },
      description:
        'The job was accepted. Nothing has been planned yet — poll `statusUrl` for the outcome.',
    },
    errorStatuses: [402, 404, 422, 503],
  }),

  // ── The activity read (Subtask 11.7.7 — MOTIR-2241) ─────────────────────
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}/activity',
    operationId: 'getWorkItemActivity',
    summary: 'Read a work item’s activity — changes, comments, or both',
    description:
      'Read a work item’s activity in one of three views: `all` (default — comments and the ' +
      'change trail interleaved in timestamp order), `comments` (the discussion), or ' +
      '`history` (the change trail only). Every entry carries a `type` so one renderer serves ' +
      'all three. ' +
      'The `cursor` is OPAQUE and SCOPED TO ITS VIEW: echo it back verbatim, never construct ' +
      'or parse one, and never hand a cursor from one view to another — that is a 422, not a ' +
      'silent restart. A page may be SHORTER than you expect while more remains (the change ' +
      'scan is noise-filtered and a comment page drags whole reply threads along), so walk ' +
      'until `nextCursor` is `null`, never until a page looks short. ' +
      '`GET /api/v1/work-items/{key}/comments` still exists and is unchanged — this view is ' +
      'the same data through the same read, offered so one code path can walk all three.',
    permission: 'project:browse',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item’s `MOTIR-<n>` key (case-insensitive).',
        schema: z.string(),
      },
      {
        name: 'view',
        in: 'query',
        required: false,
        description: 'Which stream to read. Defaults to `all`.',
        schema: z.enum(ACTIVITY_VIEWS),
      },
      {
        name: 'order',
        in: 'query',
        required: false,
        description:
          'Page-walk direction. Omit for each view’s shipped default — `desc` (newest first) ' +
          'for `all` and `history`, `asc` for `comments`.',
        schema: z.enum(['asc', 'desc']),
      },
      {
        name: 'cursor',
        in: 'query',
        required: false,
        description:
          'An opaque page cursor from a previous response’s `nextCursor`. Omit for the first ' +
          'page. Scoped to its own VIEW — one issued elsewhere is a 422, never a silent reset.',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'rankedPage', item: activityEntrySchema, extend: activityTotalsSchema },
      description:
        'One page of activity entries. `totalCount` is the number of entries in this view; ' +
        '`totalComments` / `totalChanges` break that down for the merged `all` view, and each ' +
        'is null on a view that did not count that source.',
    },
    errorStatuses: [404, 422],
  }),
];

/** The named component schemas this resource contributes to the document. */
export const WORK_LOOP_COMPONENTS: Readonly<Record<string, ZodType>> = {
  DispatchPrompt: dispatchPromptSchema,
  WorkItemClaim: workItemClaimSchema,
  ScopeClaim: scopeClaimSchema,
  IntegrationResult: integrationResultSchema,
  SessionCloseOut: sessionCloseOutSchema,
  PlanJobHandle: planJobHandleSchema,
  PlanOutcome: planOutcomeSchema,
  Plan: planSchema,
  PlanSession: planSessionSchema,
  ActivityEntry: activityEntrySchema,
};
