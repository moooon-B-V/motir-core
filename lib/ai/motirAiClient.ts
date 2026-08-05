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
  CiOverageDebitInput,
  JobContextBag,
  JobKind,
  JobStreamEvent,
  PreplanStateQuery,
  Problem,
  RawCiOverageDebitResponse,
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

/**
 * motir-ai's base URL — WITHOUT the service token (MOTIR-2026).
 *
 * ⚠️ IT EXISTS SO ONE CALLER CAN HAVE THE URL AND NOT THE TOKEN. A fleet index
 * container is handed `MOTIR_AI_BASE_URL` and a RUN-SCOPED credential, and
 * nothing else that reaches motir-ai
 * (`docs/decisions/code-graph-index-fleet.md` §4). {@link config} cannot serve
 * that caller: it refuses when `MOTIR_AI_SERVICE_TOKEN` is unset and hands back
 * the token beside the url, which is precisely the value the container must
 * never see. Re-reading `MOTIR_AI_URL` at the dispatcher instead would put a
 * second copy of the variable name — and of the trailing-slash normalisation —
 * one module away from this one.
 *
 * Read at CALL time, like everything else here.
 */
export function motirAiBaseUrl(): string {
  const url = process.env['MOTIR_AI_URL'];
  if (!url) throw new MotirAiConfigError('MOTIR_AI_URL is not set');
  return url.replace(/\/+$/, '');
}

// Read + validate config at CALL time (not module load), so the module imports
// cleanly in dev/test/CI without these env vars set — and fails FAST with a
// clear error the moment a caller actually tries to reach motir-ai.
function config(): ClientConfig {
  // The url is resolved through the exported accessor rather than re-read here,
  // so both callers normalise it the same way. The ORDER is unchanged: a
  // deployment missing both variables still hears about the url first.
  const url = motirAiBaseUrl();
  const serviceToken = process.env['MOTIR_AI_SERVICE_TOKEN'];
  if (!serviceToken) throw new MotirAiConfigError('MOTIR_AI_SERVICE_TOKEN is not set');
  return { url, serviceToken };
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

// ── Request deadlines (MOTIR-1974) ──────────────────────────────────────────
//
// Every call across this boundary rides a DEADLINE. `fetch` has none of its
// own, so an unresponsive motir-ai is waited on until something ELSE kills the
// caller — and on Vercel that something is the platform, which returns a bare
// `FUNCTION_INVOCATION_TIMEOUT` 504 with no step output. That is how the whole
// `system.code-graph-index` fleet dead-lettered: Inngest never saw a
// `MotirAiUnavailableError` its retry budget could absorb, only an untyped
// invocation kill it could not distinguish from a crashed app.
//
// The deadline bounds TIME-TO-RESPONSE-HEADERS, not body consumption: the timer
// is cleared the moment `fetch` resolves. So it covers connect + request-send +
// the server's think time, while leaving a long-lived response body —
// `streamJob`'s SSE stream — free to run as long as it needs. A stream that
// never connects still fails fast.
//
// It is now the ONLY deadline on this boundary. The second, much longer one
// existed for the tarball-upload call, which shipped a whole repo and waited for
// the graph build; that call is gone (MOTIR-2138) and every remaining method is
// a JSON request whose answer is either fast or broken. A NEW slow call does not
// get an exemption here — it gets a job.
export const MOTIR_AI_REQUEST_TIMEOUT_MS = 30_000;

/**
 * `fetch` with a deadline, mapping BOTH a transport failure and a timeout to
 * `MotirAiUnavailableError` — the single typed error every caller (and every
 * job retry budget) already understands.
 */
async function aiFetch(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MOTIR_AI_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    // The abort is OURS, so report the deadline rather than the opaque
    // "This operation was aborted" the runtime throws.
    if (controller.signal.aborted) {
      throw new MotirAiUnavailableError(
        `motir-ai did not respond within ${MOTIR_AI_REQUEST_TIMEOUT_MS}ms`,
      );
    }
    throw new MotirAiUnavailableError(describe(err));
  } finally {
    clearTimeout(timer);
  }
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

  const res = await aiFetch(`${url}/v1/jobs`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(envelope),
  });
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
  const res = await aiFetch(`${url}/v1/jobs/${encodeURIComponent(jobId)}`, {
    headers: authHeaders(serviceToken),
  });
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

  const res = await aiFetch(`${url}/v1/usage?${params.toString()}`, {
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawUsageResponse;
}

// POST /v1/credits/ci-overage — charge an org's credit ledger for CI-minutes
// OVERAGE (MOTIR-1899's endpoint; `docs/decisions/ci-minutes-allowance.md` §8.6).
//
// The caller (`ciAllowanceService`) invokes this as a BEST-EFFORT side effect
// AFTER its own charge transaction commits: the debit crosses the open-core
// boundary, so it must never roll back the local record and never fail a request
// (the shipped side-effects-outside-tx rule; `notes.html` #39). This function
// still THROWS a typed error on failure — swallowing belongs at the call site,
// which is the layer that knows the write is already durable and can decide to
// retry the same `externalRef`.
//
// Idempotent on `externalRef`, and the response's `idempotent: true` is load-
// bearing rather than informational: it is the ONLY way to learn that a debit
// which timed out had in fact landed, which is what lets a retry be safe.
export async function debitCiOverage(
  input: CiOverageDebitInput,
): Promise<RawCiOverageDebitResponse> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/credits/ci-overage`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawCiOverageDebitResponse;
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
  const res = await aiFetch(`${url}/v1/stripe/subscription?${params.toString()}`, {
    headers: authHeaders(serviceToken),
  });
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
  const res = await aiFetch(`${url}/v1/stripe/checkout-session`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(input),
  });
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
  const res = await aiFetch(`${url}/v1/stripe/portal-session`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(input),
  });
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
  const res = await aiFetch(`${url}/v1/stripe/seat-quantity`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(input),
  });
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
  const res = await aiFetch(`${url}/v1/preplan?${params.toString()}`, {
    headers: authHeaders(serviceToken),
  });
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
  const res = await aiFetch(`${url}/v1/preplan`, {
    method: 'PATCH',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(input),
  });
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

// The EXACT mirror of motir-ai's `CodingConventionDto`
// (`src/services/codingConventionService.ts`). It carries NO lifecycle fields —
// MOTIR-1660/1662 deleted the `proposed → standard` approve gate, so there is no
// `status`, `approvedBy*`, `editedBy*` or `supersededByVersion` to mirror. Keep
// this type keyed to the producer's DTO, never to what a consumer wishes for
// (MOTIR-2127: the fictional shape made every read map to null).
export interface RawConvention {
  id: string;
  aiProjectId: string;
  repoKey: string;
  version: number;
  contentMd: string;
  provenance: RawConventionProvenance[];
  sourceAuditId: string | null;
  createdAt: string;
  updatedAt: string;
}

// The EXACT mirror of motir-ai's `ConventionSurface` — the body `GET /v1/convention`
// returns. `convention` is the LATEST derived convention for the requested
// (project, repoKey), or null when none exists; the surface does NOT echo the
// requested `repoKey` (each row carries its own).
export interface RawConventionSurface {
  convention: RawConvention | null;
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
  const res = await aiFetch(`${url}/v1/code-audit?${params.toString()}`, {
    headers: authHeaders(serviceToken),
  });
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
  const res = await aiFetch(`${url}/v1/code-context/refresh`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify({ envelopeVersion: 'v1', tenant, context, readBackToken }),
  });
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
  const res = await aiFetch(`${url}/v1/convention?${params.toString()}`, {
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawConventionSurface;
}

// The RUN-SCOPED CREDENTIAL a fleet index container presents to motir-ai
// (MOTIR-1989 / MOTIR-1986). `credential` is OPAQUE to motir-core: motir-ai signs
// it and motir-ai verifies it, and nothing here parses, inspects or re-signs it.
//
// ⚠️ THE RESPONSE DELIBERATELY DOES NOT CARRY `aiProjectId`, and that absence is
// the contract rather than an omission. motir-core passes the credential straight
// through to a container; motir-ai resolves the project identity FROM the
// credential on every container-facing call, so "nothing in a request body can
// name a project" (`motir-ai/docs/contract.md`). A field here would hand
// motir-core an internal identity of the closed layer that it has no use for.
export interface CodeGraphRunCredential {
  /** The bearer the container presents. Opaque; treat as a secret. */
  credential: string;
  /** ISO-8601 — when it stops working. Minutes away, by design. */
  expiresAt: string;
}

/**
 * POST /v1/code-graph/run-credential — mint ONE index run's motir-ai credential
 * (MOTIR-1989; motir-ai's half is MOTIR-1986).
 *
 * `serviceAuth`-gated: motir-core is the caller, so this is the ONE call in the
 * flow that carries `MOTIR_AI_SERVICE_TOKEN`. What comes back authorizes exactly
 * two operations (`upload-grant`, `record-pointer`) for exactly one
 * `(project, repo, run)`, for minutes — and the container-facing routes REFUSE the
 * broad service token outright, so a misconfigured dispatch that handed a
 * container the service token fails loudly instead of silently granting it every
 * project.
 *
 * ⚠️ CREDENTIAL SCOPE IS THE ISOLATION BOUNDARY
 * (`docs/decisions/code-graph-index-fleet.md` §4). The fleet org is shared with CI
 * runners that execute customer-authored code, so a container's blast radius is
 * decided entirely by what it is handed. This is the narrow thing it is handed —
 * which is only true while the caller treats a failed mint as FATAL. There is no
 * broader credential to fall back to, and reaching for one would dissolve the
 * decision that made one shared org acceptable.
 *
 * The `(org, workspace, project)` triple find-or-creates the `AiProject`, exactly
 * as a job submit does. A non-2xx maps through the §5 problem+json taxonomy to a
 * typed error; a motir-ai that never answers becomes `MotirAiUnavailableError`
 * under the standard deadline — which since MOTIR-2138 is the only one this
 * boundary has. It is a small JSON round trip, as every method here now is.
 */
export async function mintCodeGraphRunCredential(input: {
  coreOrganizationId: string;
  coreWorkspaceId: string;
  coreProjectId: string;
  repoRef: string;
  /** The dispatching run, carried for attribution; not itself an authority. */
  runId: string;
  /** Optional; motir-ai clamps it to [60, 3600]. Omit to take its default. */
  ttlSeconds?: number;
}): Promise<CodeGraphRunCredential> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/code-graph/run-credential`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify({
      coreOrganizationId: input.coreOrganizationId,
      coreWorkspaceId: input.coreWorkspaceId,
      coreProjectId: input.coreProjectId,
      repoRef: input.repoRef,
      runId: input.runId,
      ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
    }),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));

  // ⚠️ THE BODY IS VALIDATED, not cast. Everywhere else in this client a cast is
  // fine: the value lands in a DTO a human reads, and a missing field renders as
  // blank. Here it lands in a CONTAINER SPEC. A response that parsed but carried
  // no `credential` would boot a machine with an empty
  // `MOTIR_INDEX_RUN_CREDENTIAL`, which the container reports as a CONFIG failure
  // — blaming the dispatch for a defect in the response, one process away from
  // anything that could see it. So a malformed body fails HERE, before a spec
  // exists.
  const body = (await res.json()) as Partial<CodeGraphRunCredential> | null;
  if (!body || typeof body.credential !== 'string' || body.credential.length === 0) {
    throw new MotirAiUnavailableError(
      'motir-ai returned no credential from POST /v1/code-graph/run-credential',
    );
  }
  if (typeof body.expiresAt !== 'string' || body.expiresAt.length === 0) {
    throw new MotirAiUnavailableError(
      'motir-ai returned a run credential with no expiry from POST /v1/code-graph/run-credential',
    );
  }
  return { credential: body.credential, expiresAt: body.expiresAt };
}

/** What motir-ai removed for ONE repo (`POST /v1/code-graph/offboard`). */
export interface CodeGraphOffboardRepoResult {
  repoRef: string;
  snapshotObjectsDeleted: number;
  localRootRemoved: boolean;
  coordinationRowsDeleted: number;
}

/** What one offboard call removed, per repo and in total. */
export interface CodeGraphOffboardResult {
  /** False when motir-ai has no `AiProject` for these ids — a success, not a 404. */
  projectFound: boolean;
  repos: CodeGraphOffboardRepoResult[];
  snapshotObjectsDeleted: number;
  localRootsRemoved: number;
  coordinationRowsDeleted: number;
}

/**
 * REMOVE a tenant's derived code graph (MOTIR-2168 ·
 * `docs/decisions/code-graph-index-fleet.md` §14.5) — the wire between
 * motir-core's offboarding queue and the three deletions motir-ai performs
 * (snapshot → local root → coordination row).
 *
 * Omit `repoRef` to cover EVERY repo of the project (the project-archive and
 * workspace-delete arms); supply it for one (the repo-disconnect arm).
 *
 * JSON only, under the single {@link MOTIR_AI_REQUEST_TIMEOUT_MS} deadline like
 * every other method here — §11's MOTIR-2138 amendment. It posts a scope and
 * reads counts; it must never grow a byte body or a deadline of its own.
 *
 * ⚠️ It does NOT treat "nothing was there" as a failure. motir-ai answers 200
 * with zero counts for an unknown project or an unindexed repo, and the SWEEP
 * depends on that: its queue rows deliberately outlive the projects they name, so
 * "not here" is the expected steady state on a re-run. Only a real transport or
 * server failure throws, which is what leaves the row due for the next tick.
 */
export async function offboardCodeGraph(input: {
  coreWorkspaceId: string;
  coreProjectId: string;
  repoRef?: string;
}): Promise<CodeGraphOffboardResult> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/code-graph/offboard`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify({
      coreWorkspaceId: input.coreWorkspaceId,
      coreProjectId: input.coreProjectId,
      ...(input.repoRef === undefined ? {} : { repoRef: input.repoRef }),
    }),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));

  // VALIDATED, not cast — the same reasoning as `mintCodeGraphRunCredential`, for
  // a different consequence. This value decides whether the sweep DELETES its
  // queue row. A response that parsed but carried no counts would read as a
  // successful removal and retire the only record that anything was owed, turning
  // a malformed reply into permanent retention with nothing left to retry.
  const body = (await res.json()) as Partial<CodeGraphOffboardResult> | null;
  if (!body || typeof body.coordinationRowsDeleted !== 'number' || !Array.isArray(body.repos)) {
    throw new MotirAiUnavailableError(
      'motir-ai returned no offboarding counts from POST /v1/code-graph/offboard',
    );
  }
  return {
    projectFound: body.projectFound === true,
    repos: body.repos as CodeGraphOffboardRepoResult[],
    snapshotObjectsDeleted: body.snapshotObjectsDeleted ?? 0,
    localRootsRemoved: body.localRootsRemoved ?? 0,
    coordinationRowsDeleted: body.coordinationRowsDeleted,
  };
}

// ⚠️ THE BYTE-UPLOAD METHOD IS GONE, AND MUST NOT COME BACK (MOTIR-2138). This
// client used to carry the boundary's ONE binary method — a POST of a repo's raw
// gzipped tarball to motir-ai's ingest route (MOTIR-1500), under a 180 s deadline
// of its own — and MOTIR-2027 / MOTIR-2057 moved BOTH code-graph jobs off it onto
// the container fleet without removing it. It then sat here for weeks with no
// caller: exported, tested, and one import away from re-creating the defect
// MOTIR-2057 fixed — `motir-core`'s whole-tree parse does not fit in 180 s, so
// the abandoned path failed ~68% of refreshes for three days before anyone
// connected the symptom to it.
//
// Anything that wants a graph built dispatches a CONTAINER: the pre-signed
// tarball URL is resolved above (`mintCodeGraphRunCredential` +
// `codeGraphIndexDispatchService` in `lib/jobs/indexFleetSteps.ts`) and the
// container fetches the repo itself, so the bytes never enter a Vercel function.
// This boundary is JSON-only, and every method on it now rides the single
// `MOTIR_AI_REQUEST_TIMEOUT_MS` deadline. Retiring the motir-ai ROUTE this used
// to call is MOTIR-2139, in the other repo
// (`docs/decisions/code-graph-index-fleet.md` §11).

// GET /v1/jobs/:id/stream — yield SSE frames (status / done / error) as they
// arrive; the generator ends when the stream closes (motir-ai closes it on a
// terminal state). A transport failure throws a typed error before the first
// yield.
export async function* streamJob(jobId: string): AsyncGenerator<JobStreamEvent> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/jobs/${encodeURIComponent(jobId)}/stream`, {
    headers: { Authorization: `Bearer ${serviceToken}`, Accept: 'text/event-stream' },
  });
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
