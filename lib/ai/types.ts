// The motir-core-side mirror of the boundary envelope (docs/ai-boundary.md →
// motir-ai/docs/contract.md §2/§3/§5). motir-core CANNOT import motir-ai (open-
// core boundary), so each side declares its own types against the shared
// contract. These are the shapes the client (lib/ai/motirAiClient.ts) sends and
// receives.

export const ENVELOPE_VERSION = 'v1' as const;

// The jobKind enum — only `noop` runs today (7.1.7); the rest are reserved.
export const JOB_KINDS = ['noop', 'generate_tree', 'expand_item', 'augment', 'replan'] as const;
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
