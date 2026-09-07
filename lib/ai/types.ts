// The motir-core-side mirror of the boundary envelope (docs/ai-boundary.md →
// motir-ai/docs/contract.md §2/§3/§5). motir-core CANNOT import motir-ai (open-
// core boundary), so each side declares its own types against the shared
// contract. These are the shapes the client (lib/ai/motirAiClient.ts) sends and
// receives.

export const ENVELOPE_VERSION = 'v1' as const;

// The jobKind enum. `noop` is the 7.1.7 walking skeleton; `discovery` is the
// 7.3 onboarding interview the chat front door submits (aiChatService) — its
// user turns ride in `JobContextBag.prompt` and the drafted direction docs in
// `JobContextBag.discovery`; the rest are reserved for the 7.4+ generation jobs.
export const JOB_KINDS = [
  'noop',
  'discovery',
  'generate_explanation',
  // `analyze_bug` (Story 7.6 — MOTIR-967 handler / MOTIR-1481 trigger) — the
  // OUTWARD self-improving loop: motir-core's `work-item/created` trigger
  // dispatches a user-project `kind: bug` here so motir-ai classifies its root
  // cause and, when Motir is at fault, files a SANITIZED meta-bug into MOTIR +
  // captures the lesson (it writes NO plan delta). This is the motir-core mirror
  // of the closed enum in motir-ai/src/envelope.ts — each side declares its own
  // types against the shared contract (the open-core boundary).
  'analyze_bug',
  // `propose_convention` (Story 7.14 — MOTIR-1601 handler) — the coding-convention
  // engine. The FRESH establish-only path this trigger (7.3.10 · MOTIR-839) fires
  // at onboarding completion: motir-ai derives a convention FROM THE CHOSEN STACK
  // ALONE (no repo, no audit) and records it `status: proposed` via the 7.14.3
  // store, so a fresh project reaches the 7.14.5 adopt→standard surface with a
  // proposal to adopt. The stack hint rides `context.code.stack`; the motir-ai
  // handler auto-selects fresh-vs-migrate off the project's indexed code graph.
  // Mirror of the closed motir-ai enum (the open-core boundary).
  'propose_convention',
  // `plan_sprint` (Story 7.13 — MOTIR-917 handler / MOTIR-918 consumer) — the
  // SPRINT PACKING job. Over the project's schedulable open leaves + their
  // `is_blocked_by` edges (read back over the 7.1.6 token) it packs a
  // dependency-correct, capacity-bounded sequence of SHORT agent-cadence sprints
  // and returns the versioned sprint-assignment delta on its result
  // (`sprintAssignment`, below). Its schedule is DETERMINISTIC — a pure
  // scheduler, never model-invented. It writes NOTHING: no plan delta
  // (`operations: []`) and no sprint. THIS repo persists the proposal through
  // the Epic-4 sprint services behind a human approve
  // (`aiSprintPlanningService.approveSprintPlan`). Mirror of the closed motir-ai
  // enum (the open-core boundary) — adding it here closes the drift motir-ai's
  // envelope.ts documented while its consumer was unbuilt.
  'plan_sprint',
  // `ask_project` (Story MOTIR-1343 — MOTIR-1817 handler / MOTIR-1819 consumer)
  // — the ANSWERING job behind "Ask about this project": a question answered from
  // the plan tree + code graph with CITATIONS, writing no plan delta and changing
  // no work item. Adding it HERE closes the drift motir-ai's envelope documented
  // while this consumer was unbuilt.
  //
  // ⚠️ It is also the CONVERSATION'S DOOR (`docs/decisions/conversation-turn-intent.md`
  // §2): the person types into one composer with no mode to pick, so EVERY user
  // turn is submitted as this kind, and the handler's first turn decides whether
  // to answer it or hand it back as `intent: 'plan_change'` — at which point core
  // dispatches the SHIPPED plan-change submit for the same turn. Mirror of the
  // closed motir-ai enum (the open-core boundary).
  'ask_project',
  // `plan` (Story MOTIR-3943 · MOTIR-4304 — ADR `motir-ai/docs/decisions/session-model.md`
  // §6 step 2) — THE ONE PLANNING KIND. Every planning submit in the product sends
  // it: `startGeneration`, `submitAugment`, `submitContextual`, `submitExpand`,
  // `submitReplan` and `submitRevise`, plus the auto-plan cadence trigger, which
  // reaches the wire only through `submitExpand` and so inherits the switch.
  //
  // ⚠️ IT REPLACES A DISTINCTION NOTHING CONSUMED. The five planning kinds above
  // all route through one walk on the far side (MOTIR-3940), so the kind was
  // transport carrying an operation name — and an operation is derivable from
  // what the request already says, which is why naming it added no information
  // and created a second place for the answer to drift. What motir-ai resolves
  // the run from is the CONTEXT: `context.planId` names a plan, `rootItemKey` /
  // `targetKeys` a work item, and NEITHER means plan the project.
  //
  // ⚠️ THE FIVE ARE GONE (MOTIR-4308). motir-ai stopped ACCEPTING them in
  // MOTIR-4306, so a copy here would name values the other side refuses — which
  // is the one thing a mirror must never do. This is the last card of ADR §6's
  // three-step sequence, and it runs last for a reason: while motir-core still
  // declared them the switch (MOTIR-4304) stayed revertible on its own.
  'plan',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface Tenant {
  // The org the job runs within — the billing entity (6.10). motir-core resolves
  // a project's workspace's org and sends it (Subtask 7.2.16); motir-ai keys its
  // org-level credit ledger (7.2.6) to it. Required on every submit.
  organizationId: string;
  // Whether the org is the META org (moooon B.V., `Organization.isMeta`).
  // Propagated so motir-ai's credit gate (out-of-credits) bypasses it — the meta
  // org is never billed. Defaults to false for any non-meta / self-host caller.
  isMeta: boolean;
  // Whether the org is charged exactly like a CUSTOMER and then made whole
  // (`Organization.internalBilling`, MOTIR-4565). motir-ai pairs every debit
  // such an org incurs with an offsetting `internal_offset` credit in the SAME
  // transaction, so the balance nets to zero while both entries stay visible
  // (`docs/decisions/internal-billing-classification.md` §2–§3).
  //
  // ⚠️ IT IS NOT `isMeta` ABOVE, AND IT IS ALMOST THE OPPOSITE OF IT. `isMeta`
  // makes the far side SKIP a charge; this makes it charge in full and then
  // credit. The two are true together on exactly one org today and that
  // coincidence is not identity — §9.1 of `code-graph-index-fleet.md` warns in
  // writing against overloading the first flag, which is why this is a second.
  //
  // ⚠️ OPTIONAL, AND THAT IS THE WIRE CONTRACT RATHER THAN A CONVENIENCE.
  // Absent means `false`, and the consumer (motir-ai MOTIR-4569) parses it that
  // way — which is what makes merge order between the two repositories FREE in
  // both directions: an older motir-ai reading a newer envelope ignores the
  // field, and a newer motir-ai reading an older one reads `false`. Typing it
  // REQUIRED here would assert something stronger than the wire does, and would
  // make an envelope built without it (an older caller, a fixture, a replayed
  // payload) unrepresentable while it is in fact legal and correctly read.
  //
  // Every SHIPPED construction site sets it — `resolveTenantOrg` returns it
  // non-optionally, so a site that has the org has the flag. The optionality is
  // about what a RECEIVER must tolerate, not about what a producer may skip.
  internalBilling?: boolean;
  workspaceId: string;
  projectId: string;
  projectKey: string;
}

// ── analyze_bug context (Story 7.6 — MOTIR-967 handler / MOTIR-1481 trigger) ──
// motir-core's mirror of the `context.bugAnalysis` unit motir-ai's analyze_bug
// handler parses (motir-ai/src/jobs/handlers/analyzeBug.ts `parseAnalyzeBugInput`
// + llm/bugRootCause.ts `BugRootCauseContext`). Each side declares its own types
// against the shared contract (the open-core boundary — motir-core cannot import
// motir-ai). Assembled by the trigger over the 7.1.6 read-back and sent INLINE:
// motir-ai does NOT re-read the bug, so every field it reasons over ships here.

/** One plan-tree node around the bug, tagged with its role relative to it. */
export interface BugAnalysisPlanNode {
  key: string;
  kind: string;
  title: string;
  role: 'owning_epic' | 'owning_story' | 'implicated_subtask' | 'sibling';
  type?: string | null;
  status?: string | null;
  descriptionMd?: string | null;
}

/** The dispatch / PR signal that tells a coding-agent mistake from a planning
 *  one. Absent for a user-filed bug (only Motir's own dispatched work carries
 *  it, and those are skipped); kept for parity with the handler contract. */
export interface BugAnalysisDispatchSignal {
  subtaskKey: string;
  dispatchPromptExcerpt?: string | null;
  prStatus?: string | null;
}

/** The full analysis unit the trigger assembles and motir-ai classifies over. */
export interface BugAnalysisContext {
  /** The user bug's human key (e.g. `ACME-42`) — REQUIRED by the handler. */
  bugKey: string;
  /** The bug text — `title` + `descriptionMd` are REQUIRED by the handler;
   *  `comments` are structurally empty at create time (the trigger fires on
   *  `work-item/created`), carried for contract parity. */
  bug: { title: string; descriptionMd: string; comments?: string[] };
  planNeighborhood: BugAnalysisPlanNode[];
  dispatch?: BugAnalysisDispatchSignal | null;
  implicatedPlanningPhase?: 'onboarding_planning' | 'regular_planning' | null;
  /** Extra terms motir-ai's sanitization backstop must never emit verbatim.
   *  motir-ai adds `tenant.projectKey` itself, so this is usually empty. */
  confidentialTerms?: string[];
}

export interface JobContextBag {
  prompt?: string | null;
  rootItemKey?: string | null;
  // The PLAN a `revise_plan` job is revising (Story MOTIR-3595 · MOTIR-3599
  // producer ↔ MOTIR-3600 consumer). Beside `rootItemKey`, never instead of it:
  // every other plan-edit job names a work ITEM and this one names a PLAN, which
  // is the whole reason it is a fourth kind rather than a fourth caller of the
  // three. A proposal on an unapproved plan has no `MOTIR-<n>`, so `rootItemKey`
  // could never have addressed one.
  //
  // The handler reads that plan's OWN proposals through core and seeds its
  // registry from them BEFORE the model's first turn — the difference between
  // revising and re-planning.
  planId?: string | null;
  // The CONTEXTUAL-PLANNING anchor SET (7.12.3 · MOTIR-909 producer ↔ 7.12.2 /
  // MOTIR-908 consumer) — the work-item IDENTIFIERS a chat turn is anchored at.
  // PRESENT ⇒ the submit is a contextual turn: motir-ai classifies the intent from
  // `prompt` (the turn text — the re-plan "reason" IS that message, never a
  // separate param), resolves which of the three shipped 7.11 kinds the turn really
  // is, and pushes the UNION of every anchor's item + parent + siblings + children
  // as grounding. ABSENT ⇒ not a contextual turn: `rootItemKey` drives the single
  // anchor exactly as before. Introduces NO new `jobKind` — the submitted kind is
  // only the fallback when the text carries no signal. Core sends the set only
  // after resolving and view-gating every anchor.
  targetKeys?: string[];
  discovery?: unknown;
  // The workspace's connected repo SET — the PLURAL cross-repo contract with
  // motir-ai's multi-repo code-graph reads (7.10.15/MOTIR-1598 producer ↔
  // 7.10.16/MOTIR-1599 consumer): `{ repos: [{ provider, repoRef,
  // defaultBranch }] }` (`JobCodeContext`, lib/ai/codeContext.ts), one entry
  // per repo granted on the workspace's installation (the 7.10.3 mirror — a
  // workspace is ONE PRODUCT and connects MANY repos). Populated at
  // planning-job submit by `resolveCodeContext`; ABSENT (not empty) when the
  // workspace has no installation or no granted repos. Loosely typed here by
  // design (the reserved-hole convention, like `discovery`) — each side
  // declares its own types against the shared contract.
  code?: unknown;
  // The PROJECT's repository SET (Story MOTIR-2732 · MOTIR-3044 producer ↔
  // MOTIR-3045 consumer) — `{ repos: [{ ref, name, role, label, state }] }`
  // (`JobProjectRepoContext`, lib/ai/projectRepoContext.ts), one entry per
  // `project_repository` row, in set order.
  //
  // ⚠️ BESIDE `code` above, deliberately, and not merged into it. That field is
  // the WORKSPACE's connected grant list and exists for code-graph reads; this one
  // is the PROJECT's own set. They differ in scope, in shape and in what they can
  // express: a grant list has no role, no establish state, and no entry at all for
  // a repository the plan is about to ask for — which is most of them at the
  // moment a tree is generated. Collapsing them is the confusion MOTIR-3044 exists
  // to end.
  //
  // The `ref` is the load-bearing field: a role MAY REPEAT (`ProjectRepo.role`'s
  // own comment — two services are two `api` rows), so a role pin on such a
  // project resolves to null and the planner cannot mean the billing API rather
  // than the search API. The row's identity is what makes it sayable.
  //
  // ABSENT (not empty) when the project records no repositories — the reserved-hole
  // convention, so "this project has none" and "nobody asked" stay tellable apart.
  // Loosely typed here by design, like `discovery` and `code`: each side declares
  // its own types against the shared contract. Optional in BOTH directions, so the
  // two repositories' halves merge in either order.
  repositories?: unknown;
  // The bug-analysis unit an `analyze_bug` job carries — the user bug + its
  // plan-tree neighborhood the OUTWARD classifier reasons over, assembled by the
  // trigger (MOTIR-1481) and sent inline (see BugAnalysisContext above).
  bugAnalysis?: BugAnalysisContext;
  // The work-item context a `generate_explanation` job (8.8.11) drafts an
  // explanation FROM — the title / description / type / parent the "Draft with
  // AI" affordance (8.8.12) sends. Loosely typed (the reserved-hole convention,
  // like `discovery`); the motir-ai handler parses it into an ExplanationInput.
  explanation?: unknown;
  // The AI-drafted-explanations opt-in (Story 7.4 · MOTIR-850), read from
  // `Project.aiGenerateExplanations`. When true, motir-ai's generator drafts a
  // "why this matters" `explanationMd` (`explanationSource = ai_draft`) per
  // proposed item (MOTIR-1468). Absent/false ⇒ proposals carry no explanation.
  // The flag rides the envelope so motir-ai never reads motir-core config
  // directly — which is also why every producer must send it: a submit that
  // omits it cannot be compensated for on the far side.
  //
  // Sent by BOTH planning producers: `aiGenerationService` on a `generate_tree`
  // submit, and `aiPlanEditsService` on every plan EDIT — `augment` /
  // `expand_item` / `replan`, contextual turns included (MOTIR-2110; the
  // consumer half is the motir-ai re-plan handler). It was generation-only
  // before, so the project setting read as global while applying to a plan's
  // first pass alone. Always present (`false` when off), never omitted.
  generateExplanations?: boolean;
  // WHETHER THIS PROJECT'S PLANNER MAY RECORD WHAT IT GOT WRONG (Story
  // MOTIR-3331 · MOTIR-3350 producer ↔ MOTIR-3351 consumer) — the wire form of
  // `Project.aiRecordPlanningMistakes`. Same discipline as `generateExplanations`
  // directly above: motir-ai reads the setting ONLY from here and never from
  // motir-core config, so a submit that omits it cannot be compensated for on the
  // far side.
  //
  // ⚠️ ABSENT IS NOT `false`, and the difference is load-bearing. `false` means
  // *this project switched capture off*; ABSENT means *the producer predates this
  // field*, which the consumer must read as ON — otherwise a deploy in which
  // motir-ai ships first would silently switch capture off for every tenant whose
  // jobs were submitted by the older motir-core. So every producer that can
  // capture sends it UNCONDITIONALLY (`false` when off), and the consumer's
  // fallback exists for version skew alone.
  //
  // Sent by the two producers whose job kinds can reach motir-ai's capture path:
  // `aiPlanEditsService` on the shared plan-EDIT submit (`augment` / `expand_item`
  // / `replan`, contextual turns included) and `aiBugTelemetryService` on
  // `analyze_bug`. `generate_tree` does NOT send it — its handler has no lesson
  // capture at all — and adding it there would claim a gate that does not exist.
  //
  // The KEY is spelled once, in `RECORD_PLANNING_MISTAKES_CONTEXT_FIELD`
  // (`lib/ai/lessonCapture.ts`); the call sites use it as a computed key so this
  // string has exactly one home on this side of the boundary.
  recordPlanningMistakes?: boolean;
  // Is this the project's FIRST plan? Mirrors `Project.onboardingRanAt == null`
  // (the immutable onboarding marker of Subtask 7.4 / MOTIR-1264, stamped by
  // `plansService.approvePlan`) — MOTIR-4736 producer ↔ MOTIR-4737 consumer.
  //
  // ⚠️ ONBOARDING IS A FACT ABOUT HISTORY, NOT ABOUT THE TREE. motir-ai used to
  // infer it from an EMPTY committed tree (`mayPlanTheFirstTree`, MOTIR-4178),
  // which is correct for the start-fresh path and wrong for the migrate wizard —
  // the one onboarding journey that DELIBERATELY has work items before its first
  // plan, because its optional import step (MOTIR-934 / MOTIR-1643) writes a
  // Jira / Linear / GitHub / Plane / CSV backlog first and only then generates.
  // Such a run was read as continued planning, so it got the anchored arm and the
  // continued-planning lesson bucket instead of the onboarding framing.
  //
  // ⚠️ ABSENT IS NOT `false`. `false` means *this project has already had a plan
  // approved*; ABSENT means *the producer predates this field* and the consumer
  // falls back to its own inference — so every planning submit sends it
  // UNCONDITIONALLY, never spread-conditionally like `code` and `repositories`,
  // whose absence means "this workspace/project has none".
  //
  // The KEY is spelled once, in `ONBOARDING_CONTEXT_FIELD`
  // (`lib/ai/onboardingContext.ts`), and the answer once in
  // `onboardingContextFor`; the call sites use the constant as a computed key so
  // this string has exactly one home on this side of the boundary.
  onboarding?: boolean;
  // The project's existing work-item tree summary (MOTIR-1259) — the items the
  // user already has in the project, passed to motir-ai's discovery handler so
  // tier drafting is grounded in what already exists, not a blank slate. Each
  // entry carries the key, title, kind, status, and parentKey — enough to
  // understand the tree's shape and complement it. Absent/empty ⇒ a blank-slate
  // project (the start-fresh path). Loosely typed (the reserved-hole convention,
  // like `discovery`); the motir-ai handler parses it.
  existingWorkItems?: ExistingWorkItemRef[];
  // The sprint-planning settings a `plan_sprint` job (7.13.4 · MOTIR-917) packs
  // with. `aiSprintPlanningService` sets `sprintLengthDays` from the project's
  // `aiSprintLengthDays` column (MOTIR-915), so motir-ai reads the cadence ONLY
  // from the envelope and never from motir-core config directly — the same
  // discipline as `generateExplanations`. `agentMinutesPerDay` / `maxItems` are
  // left to the scheduler's documented defaults today; they are part of the
  // contract hole so a per-project override needs no envelope change. Parsed
  // DEFENSIVELY on the far side (`parseSprintPlanningInput`) — a malformed hole
  // falls back to defaults rather than failing the job.
  sprintPlanning?: SprintPlanningContext;
  // WHAT THIS RUN IS BUILDING (Story MOTIR-3942 · MOTIR-4140 shape ↔ MOTIR-4082
  // consumer ↔ MOTIR-4172 producer) — the six-field requirement PART 1 settled,
  // never prose. motir-ai's `readSuppliedPart1` is what reads it: a present,
  // well-formed value SATISFIES PART 1, so the run enters at PART 2 instead of
  // opening a conversation to ask a question whose answer already existed.
  //
  // ⚠️ ABSENT MEANS NOBODY SUPPLIED ONE — the reserved-hole convention `code`,
  // `repositories` and `planId` use, and deliberately NOT the `generateExplanations`
  // / `recordPlanningMistakes` discipline directly above. Those two are SETTINGS
  // whose absence the consumer must read as a default, so they are always sent;
  // this one is a VALUE the caller either had or did not, and the consumer's
  // answer to absence — open the conversation — is exactly right. So it is
  // spread conditionally at the producer and never sent as `null` or `{}`.
  //
  // ⚠️ AND THE PRODUCER DOES NOT VALIDATE IT. Every key is optional here and on
  // the MCP surface that fills it, because refusing a card must never become
  // conditional on composing the WHAT well: a partial requirement is a legal
  // submit that simply does not settle PART 1. motir-ai's `buildRequirement` is
  // the only validator, and it runs where a half-answer can open a conversation
  // rather than fail a call.
  requirement?: SubmittedRequirement;
}

/**
 * The `context.requirement` hole a plan-edit submit may fill — motir-ai's
 * `SettledRequirement` (`src/jobs/conversation.ts`) as a PRODUCER states it.
 *
 * The six fields are in CANONICAL ORDER, the order a requirements document
 * states them, and that order is part of the contract: it is what the tool's
 * per-field descriptions teach an agent to compose in.
 *
 * ⚠️ EVERY FIELD IS OPTIONAL HERE AND REQUIRED THERE, and that asymmetry is the
 * design rather than a gap. Three of them — `outcome`, `behaviour`, `acceptance`
 * — must be present and non-empty for the far side to accept the requirement at
 * all; the other three may be the empty string, which says *considered, and
 * there is none* and is a different answer from never having asked. Neither
 * check runs on this side.
 *
 * Typed structurally rather than as `unknown` (which is how motir-ai declares
 * the hole) for the same reason `sprintPlanning` is: motir-core is the PRODUCER
 * here, and the field names are the thing a producer can get wrong.
 */
export interface SubmittedRequirement {
  /** Who it is for, and what becomes possible that is not possible today. */
  outcome?: string;
  /** The observable rules — input → result, and the states that are not the happy path. */
  behaviour?: string;
  /** What is deliberately NOT included. May be blank; blank is an answer. */
  scopeEdge?: string;
  /** What BINDS the shape and is already decided. May be blank. */
  constraints?: string;
  /** How somebody will know it is done, as an observation rather than a test name. */
  acceptance?: string;
  /** What was concluded that nobody confirmed. May be blank. */
  assumptions?: string;
}

/** The `context.sprintPlanning` hole a `plan_sprint` submit fills (7.13.4). */
export interface SprintPlanningContext {
  sprintLengthDays?: number;
  agentMinutesPerDay?: number;
  /** Cap on how many schedulable items one packing run reads back and packs. */
  maxItems?: number;
}

/** A lightweight summary of one committed work item in the project (MOTIR-1259),
 *  the minimum shape motir-ai's discovery handler needs to ground tier drafting
 *  in what already exists. */
export interface ExistingWorkItemRef {
  key: string;
  kind: string;
  title: string;
  status: string;
  parentKey: string | null;
}

export interface RequestEnvelope {
  envelopeVersion: typeof ENVELOPE_VERSION;
  jobKind: JobKind;
  tenant: Tenant;
  context: JobContextBag;
  readBackToken: string;
}

/**
 * The sprint-assignment delta's OWN version, independent of `envelopeVersion`
 * (contract §3.2): the persist side switches on it, so the packing shape can
 * evolve without a whole-envelope bump. Mirrors motir-ai's
 * `SPRINT_ASSIGNMENT_DELTA_VERSION`.
 */
export const SPRINT_ASSIGNMENT_DELTA_VERSION = 'v1' as const;
export type SprintAssignmentDeltaVersion = typeof SPRINT_ASSIGNMENT_DELTA_VERSION;

/**
 * ONE proposed sprint. `tempId` is a temp-ref (`sprint:<n>`) in the same spirit
 * as the tree-delta's `planItem:<id>` refs: it names a sprint that does not
 * exist yet, so the persist resolves it to a real sprint id as it creates them
 * IN ORDER. `itemKeys` are REAL work-item identifiers — this delta proposes
 * their sprint MEMBERSHIP only, never their existence — listed in dependency
 * (topological) order within the sprint.
 */
export interface ProposedSprint {
  /** `sprint:1`, `sprint:2`, … — position in the ordered sequence, 1-based. */
  tempId: string;
  name: string;
  lengthDays: number;
  itemKeys: string[];
  totalEstimateMinutes: number;
  capacityMinutes: number;
  /** Members whose OWN estimate exceeds one sprint's capacity (they sprint alone). */
  oversizedKeys: string[];
  /** Deterministically derived explanation of this sprint's composition. */
  rationale: string;
}

/**
 * The versioned sprint-assignment proposal a `plan_sprint` job returns. It
 * carries NO WRITE AUTHORITY: motir-core decides whether to commit it, creating
 * the sprints and assigning members through the Epic-4 sprint services behind a
 * human approve. The motir-core mirror of motir-ai's `SprintAssignmentDelta`.
 */
export interface SprintAssignmentDelta {
  deltaVersion: SprintAssignmentDeltaVersion;
  /** The cadence the packing used (from `context.sprintPlanning.sprintLengthDays`). */
  sprintLengthDays: number;
  /** `sprintLengthDays × agentMinutesPerDay` — the per-sprint estimate budget. */
  capacityMinutes: number;
  agentMinutesPerDay: number;
  /** The proposed sprints, in the order they must run. */
  sprints: ProposedSprint[];
  itemCount: number;
  totalEstimateMinutes: number;
  /** Members with no `estimateMinutes` — charged the default, surfaced not hidden. */
  unestimatedKeys: string[];
  /** Members too big for one sprint — each got its own sprint, flagged not dropped. */
  oversizedKeys: string[];
}

export interface ResultEnvelope {
  envelopeVersion: typeof ENVELOPE_VERSION;
  jobKind: JobKind;
  // ⚠️ NO `planDelta` (MOTIR-1747). motir-ai still SENDS one — every plan-edit
  // handler returns a hardcoded `planDelta: { operations: [] }` — but it has
  // never carried a proposal: the planners write their output as `PlanItem`
  // rows through the Plan substrate, and that Plan is the only thing core
  // reviews or approves. Results are read loosely, so the wire field is simply
  // ignored here; retiring it from the ENVELOPE is a motir-ai change (a
  // versioned boundary bump), deliberately not made from this side.
  summary: string;
  usage: { model: string | null; inputTokens: number; outputTokens: number };
  // The versioned sprint-assignment proposal (7.13.4 · MOTIR-917) — `plan_sprint`
  // ONLY: the ordered sprints the deterministic scheduler packed, each carrying a
  // `sprint:<n>` temp-ref + its real member keys. Absent for every other kind.
  // Purely additive; results are read loosely, and the approve path re-parses
  // this from scratch rather than trusting the shape (see lib/ai/sprintAssignment.ts).
  sprintAssignment?: SprintAssignmentDelta | null;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

// RFC 9457 problem+json — the shared error taxonomy (contract §5).
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  jobId?: string;
}

// The raw GET /v1/jobs/:id wire body (contract §2.4). The client maps this into
// a JobView (lib/ai/errors.ts) whose `error` is a motir-core typed error.
export interface RawJobResponse {
  jobId: string;
  status: JobStatus;
  result: ResultEnvelope | null;
  error: Problem | null;
}

// An SSE frame from GET /v1/jobs/:id/stream (contract §2.4): `event` is
// status|done|error, `data` the parsed JSON payload.
export interface JobStreamEvent {
  event: string;
  data: unknown;
}

// ── GET /v1/usage — the org cost dashboard read (Subtask 7.2.11) ──────────────
// The drill level the cost view is scoped to. motir-core narrows a non-admin
// member to `project` server-side; it never trusts a client-sent scope.
export type UsageScope = 'org' | 'workspace' | 'project';

// The query motir-core sends motir-ai (over the service-credential boundary).
// Ids are motir-core's own (org/workspace/project) — motir-ai keys its
// AiOrganization/AiProject to them (Subtask 7.2.16).
export interface UsageQuery {
  coreOrganizationId: string;
  scope: UsageScope;
  coreWorkspaceId?: string | null;
  coreProjectId?: string | null;
  page?: number;
  pageSize?: number;
}

// The raw GET /v1/usage wire body (motir-ai's usageService.UsageResponseDto).
// `balance` + `tier` are ALWAYS org-level (one ledger per org); spend +
// breakdown + runs follow the active drill scope. Credits are an internal usage
// unit, never a currency. The motir-core read-through service enriches the
// ws/project ids with names before it reaches the browser.
export interface RawUsageRun {
  jobId: string;
  jobKind: string;
  model: string | null;
  coreWorkspaceId: string;
  coreProjectId: string;
  inputTokens: number;
  outputTokens: number;
  credits: number;
  startedAt: string; // ISO
}

/**
 * `GET /v1/usage` — the ORG-LEVEL web-search spend block (motir-ai
 * `docs/contract.md`, `docs/credit-model.md` §4b).
 *
 * Scope-INDEPENDENT: it counts every search the org made, attributed or not, and
 * does NOT narrow when the drill moves to a workspace or a project. The AI spend
 * figures beside it all join `PlanningTurn` and therefore exclude these rows by
 * construction, which is what lets the billing panel render Motir Search as its
 * own line rather than folding it into the AI number.
 */
export interface RawUsageSearch {
  totalSpend: number;
  monthSpend: number;
}

/** One run's search spend. `jobId` is the SAME key `RawUsageRun` carries. */
export interface RawUsageSearchRun {
  jobId: string;
  credits: number;
  lastSearchAt: string; // ISO
}

/**
 * `GET /v1/usage` — the PER-RUN half of search spend (motir-ai MOTIR-4552,
 * `docs/credit-model.md` §4b.1). Reported ALONGSIDE `search`, never inside it.
 *
 * ⚠️ THE TWO HALVES ARE SCOPED DIFFERENTLY, and a consumer that cannot tell will
 * render an org number under a project heading:
 *
 * - `runs` / `total` FOLLOW THE DRILL SCOPE. A search carries its run and a run
 *   carries a project, so attributed spend narrows the way the AI figures do.
 * - `attributedSpend` / `unattributedSpend` are ORG-LEVEL, all-time, measured
 *   over the same population as `search.totalSpend` — so
 *   `attributedSpend + unattributedSpend === search.totalSpend`, always, however
 *   the reader has drilled.
 *
 * `unattributedSpend` is NOT an error figure. `MOTIR-2778` §4 makes a search
 * outside any run, and a search from an untrusted token, both legitimate and both
 * fully charged, so the remainder is a real quantity to render — showing it is
 * what stops the gap between a total and its rows reading as a bug in the number.
 */
export interface RawUsageSearchRuns {
  runs: RawUsageSearchRun[];
  page: number;
  pageSize: number;
  total: number;
  attributedSpend: number;
  unattributedSpend: number;
}

export interface RawUsageResponse {
  scope: UsageScope;
  coreOrganizationId: string;
  coreWorkspaceId: string | null;
  coreProjectId: string | null;
  balance: number;
  tier: { key: string; name: string; monthlyCreditAllotment: number } | null;
  totalSpend: number;
  monthSpend: number;
  monthlyHistory: { yearMonth: string; credits: number }[];
  perModel: { model: string; inputTokens: number; outputTokens: number; credits: number }[];
  recentRuns: { runs: RawUsageRun[]; page: number; pageSize: number; total: number };
  /**
   * Web-search spend. motir-ai sends BOTH blocks on every response
   * (`usageService.UsageResponseDto`), so the wire shape is not optional —
   * they are OPTIONAL HERE for one reason only: a ROLLING DEPLOY, where
   * motir-core has shipped and the motir-ai half has not (or has rolled back).
   *
   * ⚠️ `undefined` therefore means UNAVAILABLE, never zero, and the two must not
   * collapse: a customer told they spent nothing on search when the figure could
   * not be fetched is worse off than one told nothing at all. The DTO layer
   * carries that distinction as `null` vs a populated object; see
   * `lib/dto/aiUsage.ts`, and `ciFigures.ts`'s `balanceUnavailable` for the
   * shipped precedent one billed line over.
   */
  search?: RawUsageSearch;
  searchRuns?: RawUsageSearchRuns;
}

// POST /v1/credits/ci-overage (MOTIR-1899 · motir-ai `docs/contract.md` §2.4) —
// charge an org's ledger for CI-minutes OVERAGE, the ledger's first NON-AI debit
// source.
//
// The whole minutes side stays in motir-core (`docs/decisions/ci-minutes-allowance.md`
// §8.1, because the pool derives from org MEMBERSHIP, which only motir-core
// holds): motir-ai never learns what a minute is, and receives WHOLE CREDITS
// already converted at §2's rate.
export interface CiOverageDebitInput {
  coreOrganizationId: string;
  /** Whole credits of overage (integer ≥ 1), already converted. */
  credits: number;
  /**
   * The caller's own token for the metering state that produced this charge — the
   * IDEMPOTENCY key. motir-ai stores it namespaced (`ci_overage:<token>`) on a
   * globally-unique column, so a redelivered report debits exactly once and a
   * future non-AI source cannot collide. It is deliberately NOT a
   * `planningTurnId`: that hook is AI-turn-shaped and a CI charge has no turn.
   */
  externalRef: string;
  /** Optional free text recorded with the transaction. */
  reason?: string;
}

export interface RawCiOverageDebitResponse {
  transactionId: string;
  aiOrganizationId: string;
  /** Signed, as stored on the ledger (negative for a debit). */
  credits: number;
  balanceAfter: number;
  /**
   * `balanceAfter <= 0` — the SHARED exhaustion threshold. This endpoint refuses
   * nothing itself and invents no second threshold; it reports the state so
   * motir-core's dispatch gate can refuse the NEXT dispatch (§6.2).
   */
  exhausted: boolean;
  /** True when this matched an existing debit and wrote nothing — the signal a
   *  retried, previously-timed-out debit had in fact landed. */
  idempotent: boolean;
}

// ── Embeddings (Story MOTIR-2694 · Subtask MOTIR-2696) ───────────────────────
//
// `POST /v1/embeddings` — motir-ai computes vectors FOR motir-core (MOTIR-2720).
// motir-core STORES plan-tree embeddings and cannot produce them: it holds no
// provider credential, no gateway token and no embedding seam, and it is not
// getting one. Giving the open repo a credential was rejected on two counts —
// it would put an LLM key in the open-source half, and it would create a SECOND
// metering identity for one tenant's spend (`docs/decisions/plan-tree-embeddings.md`
// §6.2). So the vector comes from the service that already owns the gateway
// token and the one `CreditLedger`.
//
// BATCH by design, so a backfill is a handful of round-trips rather than one per
// row. motir-ai caps a request at 64 inputs / 512 000 characters and refuses an
// over-sized batch as a 400 BEFORE any gateway call — a cap this side respects
// by chunking rather than discovering.
export interface RawEmbeddingBatchResponse {
  /**
   * The model the call ACTUALLY used, honouring motir-ai's `EMBEDDING_MODEL`
   * override — not a constant either side assumes. Stored per row, because ADR
   * §6.1 makes it the hard comparability filter: a channel swap that changed the
   * model silently would corrupt every ranking that spans the swap.
   */
  model: string;
  dimensions: number;
  /** One vector per input, IN REQUEST ORDER. */
  embeddings: number[][];
}

// ── Stripe AI-subscription lifecycle read (Subtask 8.1.13) ───────────────────
// The raw GET /v1/stripe/subscription wire body (motir-ai's
// stripeBillingService.SubscriptionDto). `status` is the Stripe lifecycle value
// (decision §5). EVERY field is nullable: a free / never-transacted org resolves
// to the EMPTY shape (`status: null`), NOT a 404 — "no AI subscription yet" is a
// normal state. `currentPeriodEnd` is ISO-8601 (or null before a period is known).
export type StripeSubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid';

export interface SubscriptionQuery {
  coreOrganizationId: string;
}

export interface RawSubscriptionResponse {
  status: StripeSubscriptionStatus | null;
  currentPeriodEnd: string | null; // ISO-8601
  priceId: string | null;
  planTier: { key: string; name: string; monthlyCreditAllotment: number } | null;
}

// ── Pre-plan read surface (Subtask 7.3.25) ───────────────────────────────────
// The resumable pre-plan state motir-core fetches over GET /v1/preplan to resume
// the onboarding loop and render each artifact's revision diffs at the gate
// (7.3.5). Mirrors motir-ai's preplanSessionService PreplanStateDto. Keyed by the
// core (workspace, project) — motir-ai resolves its AiProject from them, READ-ONLY,
// returning the empty state ({ session: null, docs: [] }) for a not-yet-started
// project (never a 404). Versioning is forward-only — no rollback.

export interface PreplanStateQuery {
  coreWorkspaceId: string;
  coreProjectId: string;
}

// The session-persistent decisions + resume essentials (one per project). Dates
// are ISO strings on the wire (motir-ai serializes its DateTime columns to JSON).
export interface RawPreplanSession {
  aiProjectId: string;
  classification: string | null;
  platform: string | null;
  docSkipSet: string[];
  designStarter: string | null;
  // The persisted onboarding design choice (Subtask 7.3.80/MOTIR-1254 added the
  // column + write endpoint; 7.3.81 consumes it). motir-ai stores it OPAQUELY —
  // the style/palette/type registries live in motir-core — so on the wire the
  // three axes are plain strings; the motir-core service validated them before
  // the write, and re-validates/casts on read.
  designChoice: { styleId: string; paletteId: string; typeId: string } | null;
  validationTiming: string | null;
  currentGate: string | null;
  conversation: unknown;
  status: string;
  createdAt: string;
  updatedAt: string;
}

// One entry of an artifact's forward revision log: when/why/what for a version.
// `diff` is the structured doc diff (motir-ai docDiff.ts) the gate renders, or
// null for the first (created) version.
export interface RawPreplanRevisionEntry {
  version: number;
  changeReason: string | null;
  changeKind: string | null;
  diff: unknown;
  createdAt: string;
}

// One labelled key→value finding in a tier's structured SUMMARY (MOTIR-1392 →
// MOTIR-1225) — the at-a-glance breakdown the canvas captured-findings renders.
// `tone` is the design's visual treatment: `positive` (a captured fact),
// `neutral` (the deliberate negative space — the muted "Out" row), `caution` (a
// still-to-prove finding). motir-ai derives these from the structured tier docs.
export interface RawPreplanFinding {
  label: string;
  value: string;
  tone: 'positive' | 'neutral' | 'caution';
}

// `currentBody` / `currentVersion` are the latest version's rendered Markdown
// body + its number (the fields 7.3.72/MOTIR-1188 added to the motir-ai docs[]
// entry) — what the 7.3.5 gate's `DirectionDocView` renders for the read-only
// tier review. A kind only appears in `docs` once it has ≥1 version, so motir-ai
// always populates both (defensively `''` / fallback in its no-current-doc
// guard); forward-only revision diffs stay in `versions`. `summary` is the
// structured per-tier breakdown (MOTIR-1392) the canvas captured-findings
// renders — `[]` when motir-ai has a rendered body but no structured doc yet (an
// older Markdown-only session).
export interface RawPreplanArtifactLog {
  kind: 'discovery' | 'vision' | 'feasibility' | 'validation';
  currentBody: string;
  currentVersion: number;
  summary: RawPreplanFinding[];
  versions: RawPreplanRevisionEntry[];
}

// The structured feature catalog as it crosses the wire (mirrors motir-ai's
// `FeatureCatalogDto`, the fields 7.3.78/MOTIR-1243 added to GET /v1/preplan).
// A phased feature universe (categories → features) + a concept glossary
// (groups → concepts). `phase`/`status` are the motir-ai enum literals; the
// per-node `id`s are kept (the consumer keys its list render on them). The
// catalog is FOLDED INTO the vision tier on the consumer side, so it rides as a
// sibling field, NOT a `docs[]` entry.
export interface RawPreplanCatalogFeature {
  id: string;
  name: string;
  descriptionMd: string;
  phase: 'mvp' | 'v1' | 'v2' | 'ai';
  status: 'todo' | 'in_progress' | 'done';
}

export interface RawPreplanCatalogCategory {
  id: string;
  title: string;
  features: RawPreplanCatalogFeature[];
}

export interface RawPreplanGlossaryConcept {
  id: string;
  term: string;
  aka: string | null;
  descriptionMd: string;
  example: string | null;
}

export interface RawPreplanGlossaryGroup {
  id: string;
  title: string;
  concepts: RawPreplanGlossaryConcept[];
}

export interface RawPreplanCatalog {
  // motir-ai-internal identity (`id` / `aiProjectId`) + timestamps also ride the
  // wire; the mapper drops them (never leaked to the browser), so they are not
  // typed as consumed fields here.
  categories: RawPreplanCatalogCategory[];
  glossary: RawPreplanGlossaryGroup[];
}

// The raw GET /v1/preplan wire body. All three are empty/null for a project that
// never started a pre-plan (a fresh resume, not an error).
export interface RawPreplanStateResponse {
  session: RawPreplanSession | null;
  docs: RawPreplanArtifactLog[];
  catalog: RawPreplanCatalog | null;
}
