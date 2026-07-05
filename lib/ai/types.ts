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
  'generate_tree',
  'expand_item',
  'augment',
  'replan',
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
  // `Project.aiGenerateExplanations` and set by `aiGenerationService` on a
  // `generate_tree` submit. When true, motir-ai's generator drafts a "why this
  // matters" `explanationMd` (`explanationSource = ai_draft`) per proposed item
  // (MOTIR-1468). Absent/false ⇒ proposals carry no explanation. The flag rides
  // the envelope so motir-ai never reads motir-core config directly.
  generateExplanations?: boolean;
}

export interface RequestEnvelope {
  envelopeVersion: typeof ENVELOPE_VERSION;
  jobKind: JobKind;
  tenant: Tenant;
  context: JobContextBag;
  readBackToken: string;
}

export interface PlanDelta {
  operations: unknown[];
}

export interface ResultEnvelope {
  envelopeVersion: typeof ENVELOPE_VERSION;
  jobKind: JobKind;
  planDelta: PlanDelta;
  summary: string;
  usage: { model: string | null; inputTokens: number; outputTokens: number };
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
