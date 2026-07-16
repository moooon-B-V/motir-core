import 'server-only';

// The motir-core → motir-ai client: a SERVER-ONLY leaf primitive (like
// lib/email.ts). Services import it; routes never do, and the `server-only`
// import above makes bundling it into a Client Component a build error — the
// open-core invariant that browsers never reach motir-ai (docs/ai-boundary.md).
//
// It is the single seam the 7.2 chat, 7.3/7.4 generation, and the 7.8 planning
// tools call — a clean abstraction over the boundary, not endpoint glue. It
// submits jobs (minting the §4b job-scoped read-back token), polls them, and
// streams them, mapping the §5 problem+json taxonomy to motir-core typed errors.

import { mintJobToken } from './jobToken';
import {
  MotirAiConfigError,
  MotirAiUnavailableError,
  errorFromProblem,
  type JobView,
} from './errors';
import type {
  JobContextBag,
  JobKind,
  JobStreamEvent,
  PreplanStateQuery,
  Problem,
  RawJobResponse,
  RawPreplanSession,
  RawPreplanStateResponse,
  RawSubscriptionResponse,
  RawUsageResponse,
  RequestEnvelope,
  SubscriptionQuery,
  Tenant,
  UsageQuery,
} from './types';

// The actor a job runs on behalf of — the read-back token is minted for them, so
// motir-ai reads/proposes only what this user could (contract §4b).
export interface RequestActor {
  userId: string;
}

interface ClientConfig {
  url: string;
  serviceToken: string;
}

// Read + validate config at CALL time (not module load), so the module imports
// cleanly in dev/test/CI without these env vars set — and fails FAST with a
// clear error the moment a caller actually tries to reach motir-ai.
function config(): ClientConfig {
  const url = process.env['MOTIR_AI_URL'];
  const serviceToken = process.env['MOTIR_AI_SERVICE_TOKEN'];
  if (!url) throw new MotirAiConfigError('MOTIR_AI_URL is not set');
  if (!serviceToken) throw new MotirAiConfigError('MOTIR_AI_SERVICE_TOKEN is not set');
  return { url: url.replace(/\/+$/, ''), serviceToken };
}

// The AI boundary is a separate service (Fly.io) that may scale to zero — a
// cold-start fetch can take 15-30s while the machine boots. A 30s timeout gives
// one cold-start enough runway; a brief retry catches the window where the first
// request wakes the machine and the second finds it warm. Keep the timeout tight
// enough that a true outage surfaces promptly, not after 60s of retries.
const AI_FETCH_TIMEOUT_MS = 30_000;
const AI_FETCH_RETRY_MS = 3000;

async function fetchWithRetry(
  url: string,
  init: RequestInit & { retryOn?: 'cold-start' | 'always' },
): Promise<Response> {
  const { retryOn, ...fetchInit } = init;
  const doFetch = () =>
    fetch(url, { ...fetchInit, signal: AbortSignal.timeout(AI_FETCH_TIMEOUT_MS) });

  try {
    return await doFetch();
  } catch (err) {
    if (!retryOn || retryOn === 'always') throw err;
    // Cold-start retry: wait a beat for the machine to boot, then try once more.
    await new Promise((r) => setTimeout(r, AI_FETCH_RETRY_MS));
    return doFetch();
  }
}

function authHeaders(serviceToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${serviceToken}`,
    'content-type': 'application/json',
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Best-effort parse of a non-2xx body into a Problem (contract §5); falls back
// to a synthetic problem when the body isn't problem+json.
async function readProblem(res: Response): Promise<Problem> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && typeof (body as Problem).code === 'string') {
      return body as Problem;
    }
  } catch {
    // not JSON — fall through
  }
  return {
    type: 'about:blank',
    title: res.statusText || 'request failed',
    status: res.status,
    code: 'internal_error',
  };
}

// POST /v1/jobs — mint the read-back token, post a valid v1 envelope, return the
// jobId. Never blocks on execution (motir-ai returns 202 immediately).
export async function submitJob(
  kind: JobKind,
  tenant: Tenant,
  context: JobContextBag,
  actor: RequestActor,
): Promise<{ jobId: string }> {
  const { url, serviceToken } = config();
  const readBackToken = mintJobToken({
    userId: actor.userId,
    workspaceId: tenant.workspaceId,
    projectId: tenant.projectId,
  });
  const envelope: RequestEnvelope = {
    envelopeVersion: 'v1',
    jobKind: kind,
    tenant,
    context,
    readBackToken,
  };

  let res: Response;
  try {
    res = await fetch(`${url}/v1/jobs`, {
      method: 'POST',
      headers: authHeaders(serviceToken),
      body: JSON.stringify(envelope),
    });
  } catch (err) {
    throw new MotirAiUnavailableError(describe(err));
  }
  if (!res.ok) throw errorFromProblem(await readProblem(res));

  const body: unknown = await res.json();
  const jobId = (body as { jobId?: unknown })?.jobId;
  if (typeof jobId !== 'string' || !jobId) {
    throw new MotirAiUnavailableError('submit response missing a jobId');
  }
  return { jobId };
}

// GET /v1/jobs/:id — status + result, with a failed job's error mapped to a
// typed error. A 404 / transport failure throws a typed error.
export async function getJob(jobId: string): Promise<JobView> {
  const { url, serviceToken } = config();
  let res: Response;
  try {
    res = await fetch(`${url}/v1/jobs/${encodeURIComponent(jobId)}`, {
      headers: authHeaders(serviceToken),
    });
  } catch (err) {
    throw new MotirAiUnavailableError(describe(err));
  }
  if (!res.ok) throw errorFromProblem(await readProblem(res));

  const body = (await res.json()) as RawJobResponse;
  return {
    jobId: body.jobId,
    status: body.status,
    result: body.result ?? null,
    error: body.error ? errorFromProblem(body.error) : null,
  };
}

// GET /v1/usage — the org cost rollup for the cost dashboard (Subtask 7.2.11),
// at a drill level (org / workspace / project). Read-through: the caller is the
// aiUsageService, which has already gated the actor and narrowed the scope. A
// transport failure / non-2xx maps to a typed error the dashboard renders as
// the error/retry state (never a misleading zero balance).
export async function getOrgUsage(query: UsageQuery): Promise<RawUsageResponse> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({
    coreOrganizationId: query.coreOrganizationId,
    scope: query.scope,
  });
  if (query.coreWorkspaceId) params.set('coreWorkspaceId', query.coreWorkspaceId);
  if (query.coreProjectId) params.set('coreProjectId', query.coreProjectId);
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));

  let res: Response;
  try {
    res = await fetch(`${url}/v1/usage?${params.toString()}`, {
      headers: authHeaders(serviceToken),
    });
  } catch (err) {
    throw new MotirAiUnavailableError(describe(err));
  }
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawUsageResponse;
}

// GET /v1/stripe/subscription — the org's AI-pool Stripe subscription lifecycle
// (status + renewal + resolved tier) the billing panel renders (Subtask 8.1.13 →
// the 8.1.5 store). Read-through: the caller (billingService) has already gated
// the actor + the cloud build. motir-ai returns the EMPTY shape (`status: null`)
// for a free / never-transacted org — NOT a 404 — so this never throws on "no
// subscription"; only a transport failure / non-2xx maps to a typed error.
export async function getOrgSubscription(
  query: SubscriptionQuery,
): Promise<RawSubscriptionResponse> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({ coreOrganizationId: query.coreOrganizationId });
  let res: Response;
  try {
    res = await fetch(`${url}/v1/stripe/subscription?${params.toString()}`, {
      headers: authHeaders(serviceToken),
    });
  } catch (err) {
    throw new MotirAiUnavailableError(describe(err));
  }
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawSubscriptionResponse;
}

// POST /v1/stripe/checkout-session — start a subscription-mode, Stripe-hosted
// Checkout Session for an org + a selected price, returning the hosted URL the
// caller redirects to (Subtask 8.1.6 → the 8.1.5 endpoint). The Stripe SECRET
// never crosses this boundary — motir-ai owns the SDK and the customer; motir-core
// only initiates and gets back a URL (the open-core invariant). The caller
// (billingService) has already gated the actor (org owner) + the cloud build. A
// transport failure / non-2xx maps to a typed error.
export async function createCheckoutSession(input: {
  coreOrganizationId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey?: string;
}): Promise<{ url: string }> {
  const { url, serviceToken } = config();
  let res: Response;
  try {
    res = await fetch(`${url}/v1/stripe/checkout-session`, {
      method: 'POST',
      headers: authHeaders(serviceToken),
      body: JSON.stringify(input),
    });
  } catch (err) {
    throw new MotirAiUnavailableError(describe(err));
  }
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return readSessionUrl(res);
}

// POST /v1/stripe/portal-session — open a short-lived Billing Portal session for
// an org that already has a Stripe Customer, returning its URL (the client
// redirects immediately — the portal session expires in ~5 min). A 404 (the org
// has no customer yet) maps to MotirAiJobNotFoundError via the §5 `not_found`
// code. The caller has already gated the actor (org owner) + the cloud build.
export async function createPortalSession(input: {
  coreOrganizationId: string;
  returnUrl: string;
}): Promise<{ url: string }> {
  const { url, serviceToken } = config();
  let res: Response;
  try {
    res = await fetch(`${url}/v1/stripe/portal-session`, {
      method: 'POST',
      headers: authHeaders(serviceToken),
      body: JSON.stringify(input),
    });
  } catch (err) {
    throw new MotirAiUnavailableError(describe(err));
  }
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return readSessionUrl(res);
}

// Both Stripe session endpoints return `{ url }` (contract §2.4); a 2xx body
// missing the URL is an unexpected upstream response, not a client condition.
async function readSessionUrl(res: Response): Promise<{ url: string }> {
  const body: unknown = await res.json();
  const sessionUrl = (body as { url?: unknown })?.url;
  if (typeof sessionUrl !== 'string' || !sessionUrl) {
    throw new MotirAiUnavailableError('stripe session response missing a url');
  }
  return { url: sessionUrl };
}

// The motir-ai seat-sync response (Subtask 8.1.12): whether a Stripe write was
// applied + why. The caller (the seat-sync job) uses it only for logging — the
// durable effect is on the Stripe side.
export interface SeatQuantityResult {
  applied: boolean;
  outcome:
    | 'org_not_found'
    | 'no_customer'
    | 'no_active_tracker_subscription'
    | 'unchanged'
    | 'updated';
}

// POST /v1/stripe/seat-quantity — set the org's scaled-tracker seat `quantity` to
// an ABSOLUTE target (the recomputed active-member count), prorated + invoiced
// promptly (Subtask 8.1.12 → the 8.1.5/8.1.12 endpoint). motir-ai owns the Stripe
// SDK + secret and resolves the tracker line itself; motir-core only passes the
// org + count. A non-scaled org is a benign no-op `200` (never a 404), so the
// caller fires this on any membership change. A transport failure / non-2xx maps
// to a typed error the seat-sync job's retry budget absorbs.
export async function setSeatQuantity(input: {
  coreOrganizationId: string;
  quantity: number;
}): Promise<SeatQuantityResult> {
  const { url, serviceToken } = config();
  let res: Response;
  try {
    res = await fetch(`${url}/v1/stripe/seat-quantity`, {
      method: 'POST',
      headers: authHeaders(serviceToken),
      body: JSON.stringify(input),
    });
  } catch (err) {
    throw new MotirAiUnavailableError(describe(err));
  }
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as SeatQuantityResult;
}

// GET /v1/preplan — the resumable pre-plan read surface (Subtask 7.3.25): the
// session decisions/position/transcript + each artifact's forward revision log /
// diffs. Read-through: the caller (the 7.3.5 gate / 7.3.9 resume) has already
// gated the actor + resolved the core ids. Keyed by (coreWorkspaceId,
// coreProjectId); motir-ai resolves its AiProject READ-ONLY and returns the empty
// state for a not-yet-started project (never a 404). A transport failure / non-2xx
// maps to a typed error the caller renders as the error/retry state.
export async function getPreplanState(query: PreplanStateQuery): Promise<RawPreplanStateResponse> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({
    coreWorkspaceId: query.coreWorkspaceId,
    coreProjectId: query.coreProjectId,
  });
  let res: Response;
  try {
    res = await fetch(`${url}/v1/preplan?${params.toString()}`, {
      headers: authHeaders(serviceToken),
    });
  } catch (err) {
    throw new MotirAiUnavailableError(describe(err));
  }
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawPreplanStateResponse;
}

// PATCH /v1/preplan — the pre-plan WRITE seam (Subtask 7.3.81): persist the
// onboarding design choice the user picked in the design step (MOTIR-1040). Unlike
// the read above, a write FIND-OR-CREATES the AiProject + its org spine, so the
// body carries the `coreOrganizationId` too (the caller — aiPreplanService — has
// resolved it). `designChoice` is Motir's three axes `{ styleId, paletteId, typeId }`,
// validated against the motir-core registries BEFORE this call (motir-ai stores it
// opaquely); `designStarter` is the distinct with-design-vs-bare starter flag.
// motir-ai returns the updated session DTO (same shape GET's `session` carries),
// so the choice can be echoed back. A transport failure / non-2xx maps to a typed
// error the caller degrades on (the choice is kept optimistically in the UI).
export interface SaveDesignChoiceInput {
  coreOrganizationId: string;
  coreWorkspaceId: string;
  coreProjectId: string;
  designChoice: { styleId: string; paletteId: string; typeId: string };
  designStarter: string;
}

export async function saveDesignChoice(input: SaveDesignChoiceInput): Promise<RawPreplanSession> {
  const { url, serviceToken } = config();
  let res: Response;
  try {
    res = await fetch(`${url}/v1/preplan`, {
      method: 'PATCH',
      headers: authHeaders(serviceToken),
      body: JSON.stringify(input),
    });
  } catch (err) {
    throw new MotirAiUnavailableError(describe(err));
  }
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawPreplanSession;
}

// ── Coding convention + code-health audit (Story 7.14 / MOTIR-926) ───────────
// The read seam the Code-health page reads over the boundary. Reads are keyed by
// (coreWorkspaceId, coreProjectId, repoKey) query params — per-repo scope per
// MOTIR-1662. The convention is DERIVED + AUTO-USED (no approve/edit write path;
// MOTIR-1660 / MOTIR-1663).

export interface RawConventionProvenance {
  ruleId: string;
  category: string;
  source: 'adopted' | 'proposed';
  evidence?: Record<string, unknown>;
  confidence?: number;
}

export interface RawConvention {
  id: string;
  aiProjectId: string;
  status: 'proposed' | 'standard' | 'superseded';
  version: number;
  contentMd: string;
  provenance: RawConventionProvenance[];
  sourceAuditId: string | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
  supersededByVersion: number | null;
  editedByUserId: string | null;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RawConventionSurface {
  repoKey: string | null;
  proposed: RawConvention | null;
  standard: RawConvention | null;
  versions: RawConvention[];
  nextCursor: string | null;
}

export interface RawCodeAuditSummary {
  id: string;
  aiProjectId: string;
  healthSummary: unknown;
  codeGraphRef: string | null;
  repoKey: string | null;
  jobId: string | null;
  createdAt: string;
}

// The §10.3 external-scanner state motir-ai stamps on the latest audit and hoists
// onto the read-back surface (MOTIR-1610). Loosely mirrored here (like
// `healthSummary`); the service maps it defensively into the DTO.
export interface RawExternalScannerState {
  detected: string[];
  ingested: {
    source: string;
    analyses: number;
    tools: string[];
    findingCount: number;
  } | null;
  noExternalScanner: boolean;
  suggestion: 'github_code_scanning' | 'sonarqube' | null;
}

export interface RawCodeAuditSurface {
  audit: RawCodeAuditSummary | null;
  findings: unknown[];
  total: number;
  nextOffset: number | null;
  // The latest audit's §10.3 scanner state (MOTIR-1610), or null for the empty
  // surface / an audit recorded before the column existed.
  scanner?: RawExternalScannerState | null;
}

export interface CodeAuditQuery {
  coreWorkspaceId: string;
  coreProjectId: string;
  repoKey?: string;
  findingsOffset?: number;
  findingsLimit?: number;
}

// GET /v1/code-audit — latest audit summary + its first findings page.
export async function getCodeAudit(query: CodeAuditQuery): Promise<RawCodeAuditSurface> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({
    coreWorkspaceId: query.coreWorkspaceId,
    coreProjectId: query.coreProjectId,
  });
  if (query.repoKey) params.set('repoKey', query.repoKey);
  if (query.findingsOffset !== undefined)
    params.set('findingsOffset', String(query.findingsOffset));
  if (query.findingsLimit !== undefined) params.set('findingsLimit', String(query.findingsLimit));
  let res: Response;
  try {
    res = await fetchWithRetry(`${url}/v1/code-audit?${params.toString()}`, {
      headers: authHeaders(serviceToken),
      retryOn: 'cold-start',
    });
  } catch (err) {
    throw new MotirAiUnavailableError(describe(err));
  }
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawCodeAuditSurface;
}

export interface RefreshCodeAuditResult {
  auditJobId: string;
  conventionJobId: string;
}

// POST /v1/code-context/refresh — the 7.14.7 RE-AUDIT / REFRESH trigger (MOTIR-928).
// Re-submits `code_audit` + `propose_convention` for the project so a freshly
// configured external scanner is detected + ingested and the report refreshes (the
// "Deepen this audit" → "Re-audit now" action, MOTIR-1592). Mints the §4b read-back
// token the same way `submitJob` does (the audit job reads private-repo code
// scanning through motir-core's proxy, MOTIR-1605). motir-ai queues both jobs and
// returns their ids (202); the durable effect is the new CodeAudit + proposed
// version the worker writes.
export async function refreshCodeAudit(
  tenant: Tenant,
  context: JobContextBag,
  actor: RequestActor,
): Promise<RefreshCodeAuditResult> {
  const { url, serviceToken } = config();
  const readBackToken = mintJobToken({
    userId: actor.userId,
    workspaceId: tenant.workspaceId,
    projectId: tenant.projectId,
  });
  let res: Response;
  try {
    res = await fetchWithRetry(`${url}/v1/code-context/refresh`, {
      method: 'POST',
      headers: authHeaders(serviceToken),
      body: JSON.stringify({ envelopeVersion: 'v1', tenant, context, readBackToken }),
      retryOn: 'cold-start',
    });
  } catch (err) {
    throw new MotirAiUnavailableError(describe(err));
  }
  if (!res.ok) throw errorFromProblem(await readProblem(res));

  const body = (await res.json()) as Partial<RefreshCodeAuditResult>;
  if (typeof body.auditJobId !== 'string' || typeof body.conventionJobId !== 'string') {
    throw new MotirAiUnavailableError('refresh response missing a job id');
  }
  return { auditJobId: body.auditJobId, conventionJobId: body.conventionJobId };
}

export interface ConventionQuery {
  coreWorkspaceId: string;
  coreProjectId: string;
  repoKey?: string;
  versionsCursor?: string;
  versionsLimit?: number;
}

// GET /v1/convention — latest derived convention + version history (per-repo
// scope per MOTIR-1662; derived = auto-used, no approve gate).
export async function getConvention(query: ConventionQuery): Promise<RawConventionSurface> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({
    coreWorkspaceId: query.coreWorkspaceId,
    coreProjectId: query.coreProjectId,
  });
  if (query.repoKey) params.set('repoKey', query.repoKey);
  if (query.versionsCursor) params.set('versionsCursor', query.versionsCursor);
  if (query.versionsLimit !== undefined) params.set('versionsLimit', String(query.versionsLimit));
  let res: Response;
  try {
    res = await fetchWithRetry(`${url}/v1/convention?${params.toString()}`, {
      headers: authHeaders(serviceToken),
      retryOn: 'cold-start',
    });
  } catch (err) {
    throw new MotirAiUnavailableError(describe(err));
  }
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawConventionSurface;
}

// The motir-ai code-graph index response (MOTIR-1500) — a summary of what the
// index run produced for one project's code-graph store. Read only for the
// job-run ledger / logging; the durable effect is on the motir-ai side.
export interface CodeGraphIndexResult {
  status: string;
  repoRef: string;
  filesIndexed: number;
  nodesChanged: number;
  edgesChanged: number;
  commitSha: string;
}

// POST /v1/code-graph/index — hand a repo's raw gzipped-tarball BYTES to motir-ai
// to build/refresh a project's code graph (MOTIR-1500, the producer half). This
// is the ONE binary method on the boundary: unlike every JSON method above, the
// body is the tarball itself (`content-type: application/gzip`, NOT a JSON
// envelope), and the tenant tuple + repo ref ride as `x-core-*` / `x-repo-ref`
// headers. The GitHub installation token + the tarball fetch stay in motir-core;
// motir-ai receives BYTES, never a host credential (the open-core invariant). The
// caller (the `system.code-graph-index` job) has already resolved the tenant and
// minted the token. A transport failure / non-2xx (problem+json) maps to a typed
// error the job's retry budget absorbs.
export async function indexCodeGraph(input: {
  coreOrganizationId: string;
  coreWorkspaceId: string;
  coreProjectId: string;
  repoRef: string;
  bytes: ArrayBuffer | Uint8Array;
}): Promise<CodeGraphIndexResult> {
  const { url, serviceToken } = config();
  // Normalize to a Buffer so `fetch` sends the raw bytes verbatim (never a JSON
  // stringify). Buffer.from(Uint8Array) copies; Buffer.from(ArrayBuffer) via a
  // Uint8Array view — either way the exact tarball bytes cross the wire.
  const body = Buffer.from(
    input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes),
  );
  let res: Response;
  try {
    res = await fetch(`${url}/v1/code-graph/index`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        'content-type': 'application/gzip',
        'x-core-organization-id': input.coreOrganizationId,
        'x-core-workspace-id': input.coreWorkspaceId,
        'x-core-project-id': input.coreProjectId,
        'x-repo-ref': input.repoRef,
      },
      body,
    });
  } catch (err) {
    throw new MotirAiUnavailableError(describe(err));
  }
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as CodeGraphIndexResult;
}

// GET /v1/jobs/:id/stream — yield SSE frames (status / done / error) as they
// arrive; the generator ends when the stream closes (motir-ai closes it on a
// terminal state). A transport failure throws a typed error before the first
// yield.
export async function* streamJob(jobId: string): AsyncGenerator<JobStreamEvent> {
  const { url, serviceToken } = config();
  let res: Response;
  try {
    res = await fetch(`${url}/v1/jobs/${encodeURIComponent(jobId)}/stream`, {
      headers: { Authorization: `Bearer ${serviceToken}`, Accept: 'text/event-stream' },
    });
  } catch (err) {
    throw new MotirAiUnavailableError(describe(err));
  }
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  if (!res.body) throw new MotirAiUnavailableError('stream response had no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseSseFrame(frame);
        if (parsed) yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Parse one SSE frame ("event: x\ndata: {...}") into a JobStreamEvent. Returns
// null for a comment-only / dataless frame. Exported for unit testing.
export function parseSseFrame(frame: string): JobStreamEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // comment
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  let data: unknown = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    // leave as raw string
  }
  return { event, data };
}
