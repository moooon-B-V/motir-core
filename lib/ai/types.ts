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
  'generate_tree',
  'expand_item',
  'augment',
  'replan',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface Tenant {
  // The org the job runs within — the billing entity (6.10). motir-core resolves
  // a project's workspace's org and sends it (Subtask 7.2.16); motir-ai keys its
  // org-level credit ledger (7.2.6) to it. Required on every submit.
  organizationId: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
}

export interface JobContextBag {
  prompt?: string | null;
  rootItemKey?: string | null;
  discovery?: unknown;
  code?: unknown;
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

export interface RawPreplanArtifactLog {
  kind: 'discovery' | 'vision' | 'feasibility' | 'validation';
  versions: RawPreplanRevisionEntry[];
}

// The raw GET /v1/preplan wire body. Both halves are empty/null for a project
// that never started a pre-plan (a fresh resume, not an error).
export interface RawPreplanStateResponse {
  session: RawPreplanSession | null;
  docs: RawPreplanArtifactLog[];
}
