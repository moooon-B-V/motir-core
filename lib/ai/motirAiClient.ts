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
  RawEmbeddingBatchResponse,
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
 * motir-ai's base URL as THIS PROCESS reaches it — WITHOUT the service token
 * (MOTIR-2026).
 *
 * ⚠️ IT EXISTS SO ONE CALLER CAN HAVE THE URL AND NOT THE TOKEN. {@link config}
 * refuses when `MOTIR_AI_SERVICE_TOKEN` is unset and hands the token back beside
 * the url, so a caller that needs only the address cannot use it.
 *
 * ⚠️ IT IS NOT THE ADDRESS AN INDEX CONTAINER IS GIVEN — see
 * {@link motirAiContainerBaseUrl}, directly below, and read the two together.
 * This paragraph used to say the opposite in those words ("a fleet index
 * container is handed `MOTIR_AI_BASE_URL`…"), and the dispatcher did exactly
 * what it said. **CORRECTED (MOTIR-4518):** `MOTIR_AI_URL` is the address
 * motir-core reaches motir-ai at, which in production is a PRIVATE, org-scoped
 * one (`http://motir-ai.internal:8080`); an index container runs in a DIFFERENT
 * organization, where that name does not resolve at all. Every index run died at
 * `getaddrinfo ENOTFOUND motir-ai.internal` for two weeks — after building the
 * graph, one call before it could be uploaded — because these two values were
 * one value.
 *
 * Read at CALL time, like everything else here.
 */
export function motirAiBaseUrl(): string {
  const url = process.env['MOTIR_AI_URL'];
  if (!url) throw new MotirAiConfigError('MOTIR_AI_URL is not set');
  return url.replace(/\/+$/, '');
}

/**
 * The env var carrying the address an INDEX CONTAINER is given for motir-ai.
 * Exported so the preflight and its message name the same literal the accessor
 * reads (MOTIR-4518).
 */
export const MOTIR_AI_CONTAINER_URL_ENV_VAR = 'MOTIR_AI_CONTAINER_URL';

/**
 * motir-ai's base URL AS THE INDEX CONTAINER MUST REACH IT (MOTIR-4518) — the
 * value that becomes the container's `MOTIR_AI_BASE_URL`.
 *
 * ⚠️ WHY THIS IS A SECOND ACCESSOR AND NOT A SECOND CALL TO ITS TWIN. The two
 * callers are in DIFFERENT PLACES, so they are different values, and the code
 * has to be able to say so:
 *
 * | who is calling | from where | which address |
 * | --- | --- | --- |
 * | motir-core (this process) | the `moooon` organization | {@link motirAiBaseUrl} — `MOTIR_AI_URL`, private/6PN in production |
 * | an index container | the FLEET's own organization | this accessor — `MOTIR_AI_CONTAINER_URL`, which must resolve from outside `moooon` |
 *
 * A `.internal` name is 6PN: the platform resolves it only for machines in the
 * SAME organization as the app it names. It is therefore correct for the row
 * above it and unusable for the row below it — not because one of them is
 * misconfigured, but because private-network addressing is scoped to a network
 * and the two callers are on different ones. `MOTIR_AI_URL` stays on the private
 * seam deliberately (MOTIR-3277); moving it to satisfy this consumer would undo
 * that decision for a caller it is not about.
 *
 * ⚠️ AND THERE IS NO FALLBACK TO `MOTIR_AI_URL`, DELIBERATELY. A default is what
 * turned the original mistake into two silent weeks: the container booted, ran
 * for nineteen minutes, built a 45 MB graph and threw it away at the upload
 * grant, while the ledger recorded success. Unset must be LOUD and must be loud
 * BEFORE a machine is billed — this throws inside `bootIndexContainer`'s
 * deployment gate, which releases the admission slot and records a failure
 * instead of a phantom index.
 *
 * The container's authority is unchanged and is not widened by this: it still
 * carries only a run-scoped credential, minted per (project, repo, run), and
 * motir-ai's container-facing routes are gated on it (`runCredentialAuth`) —
 * verified anonymously against the public host, which answers 401
 * `service_unauthorized` rather than serving anything.
 *
 * Read at CALL time, like everything else here.
 */
export function motirAiContainerBaseUrl(): string {
  const url = process.env[MOTIR_AI_CONTAINER_URL_ENV_VAR];
  if (!url) {
    throw new MotirAiConfigError(`${MOTIR_AI_CONTAINER_URL_ENV_VAR} is not set`);
  }
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

/**
 * The query parameter the two job reads scope themselves with — the ONE seam in
 * MOTIR-2291 that no single repo's tests can cover.
 *
 * ⚠️ IT IS A CROSS-REPO CONTRACT AND IT FAILS CLOSED AND SILENTLY. motir-ai's
 * `GET /v1/jobs/:id` requires this exact name (MOTIR-2360); a typo on either side
 * produces a `validation_error` on every job read — no type error, no test
 * failure in the repo that made it, just a product where nothing streams. Naming
 * it once here, and pinning the string in
 * `tests/permissions/memberFacingGate.integration.test.ts`, is what makes a drift
 * a red test rather than a support ticket.
 */
export const JOB_SCOPE_QUERY_PARAM = 'coreProjectId';

// GET /v1/jobs/:id — status + result, with a failed job's error mapped to a
// typed error. A 404 / transport failure throws a typed error.
//
// ⚠️ `coreProjectId` IS REQUIRED, AND MOTIR-AI DOES NOT READ IT YET (Story
// MOTIR-2291 · Subtask MOTIR-2359). Until this card, a job was readable by its
// ID ALONE on both sides of the boundary: this call sent the SERVICE token and
// nothing else, and motir-ai's `GET /v1/jobs/:id` answered `getJobView(id)` with
// no tenant filter — its `JobView` carries no owning project, so core had nothing
// to check even if it wanted to. The binding exists upstream
// (`PlanJob.aiProjectId` → `AiProject.coreProjectId`); MOTIR-2360 is the card
// that enforces it on the read.
//
// So core starts SENDING the id first. Sending one the producer does not yet
// read is harmless; requiring one the consumer does not yet send is not, which is
// why the order is this way round. The parameter is NON-OPTIONAL on purpose: a
// call site that cannot supply a project id is a call site that has not resolved
// its project, and that is the bug this whole story is about.
export async function getJob(jobId: string, coreProjectId: string): Promise<JobView> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({ [JOB_SCOPE_QUERY_PARAM]: coreProjectId });
  const res = await aiFetch(`${url}/v1/jobs/${encodeURIComponent(jobId)}?${params.toString()}`, {
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

/**
 * POST /v1/embeddings — compute vectors for the plan-tree semantic store (Story
 * MOTIR-2694 · MOTIR-2696; motir-ai's half is MOTIR-2720).
 *
 * `serviceAuth` like every other core → ai call. This repo stores embeddings and
 * does not produce them (`docs/decisions/plan-tree-embeddings.md` §6.2), so this
 * is the ONLY way a vector enters motir-core.
 *
 * BATCH: one call embeds up to `EMBEDDING_BATCH_MAX_INPUTS` texts and returns one
 * vector per input IN REQUEST ORDER — the caller pairs them positionally, so an
 * answer of the wrong length is a contract violation and is refused here rather
 * than mis-attributed to the wrong work item. That check is not defensive
 * boilerplate: a mis-paired vector is stored as if it were real and then ranks
 * the wrong card forever, with nothing failing.
 *
 * THROWS a typed error on any failure — never a partial or placeholder result.
 * Swallowing belongs at the call site, which is the layer that knows an item
 * without an embedding is simply "not yet a candidate" (ADR §6.3.5) rather than
 * an error, and that the job's retry budget will come back to it.
 */
export async function embedTexts(input: string[]): Promise<RawEmbeddingBatchResponse> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/embeddings`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify({ input }),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));

  // VALIDATED, not cast — the same reasoning as `offboardCodeGraph` above, for a
  // consequence that is quieter and worse. Every field here is written straight
  // into a durable row: a missing `model` would store `undefined` as the hard
  // ranking filter, and a short `embeddings` array would pair vectors with the
  // wrong items from that index on.
  const body = (await res.json()) as Partial<RawEmbeddingBatchResponse> | null;
  if (
    !body ||
    typeof body.model !== 'string' ||
    body.model === '' ||
    typeof body.dimensions !== 'number' ||
    !Array.isArray(body.embeddings)
  ) {
    throw new MotirAiUnavailableError(
      'motir-ai returned a malformed body from POST /v1/embeddings',
    );
  }
  if (body.embeddings.length !== input.length) {
    throw new MotirAiUnavailableError(
      `motir-ai returned ${body.embeddings.length} embeddings for ${input.length} inputs`,
    );
  }
  return { model: body.model, dimensions: body.dimensions, embeddings: body.embeddings };
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
  /**
   * Unit count for the resolved Price — the credit top-up's bundle multiplier
   * (MOTIR-2949). motir-ai reads it as an optional integer >= 1 and defaults to
   * 1; the caller (`billingService.startCheckout`) always sends an explicit
   * number, so the charge is never decided by a default two services away.
   */
  quantity?: number;
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
  /**
   * OPTIONAL (MOTIR-3252) — a single-key, GET-only pre-signed URL for the repo's
   * PREVIOUS code-graph snapshot, which the container syncs against instead of
   * re-parsing the whole tree.
   *
   * **Opaque here, exactly like `credential`.** motir-core does not know the
   * snapshot key, cannot compute it, and holds no object-storage credential — all
   * three by decision (`docs/decisions/code-graph-index-fleet.md` §4/§5). motir-ai
   * mints it because it has the coordination row and the bucket; this side carries
   * it to the container's environment and never opens it.
   *
   * **Absent is the normal answer, not a failure.** A first index has no previous
   * snapshot, and a `codegraphVersion` bump deliberately withholds it so the run
   * rebuilds — the re-index the schema promises. Either way the container does a
   * full build, which is what it did unconditionally before this existed. That is
   * also what makes the two repos' halves free to merge in any order: an older
   * motir-ai simply never returns the field.
   */
  previousSnapshotUrl?: string;
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
  // The snapshot grant is OPTIONAL and is validated only for shape — a malformed
  // one is DROPPED rather than fatal, because the run it would have accelerated
  // still succeeds without it. This is the one field here whose absence is
  // routine, so it must not learn the fatal treatment of the two above.
  const previousSnapshotUrl =
    typeof body.previousSnapshotUrl === 'string' && body.previousSnapshotUrl.length > 0
      ? body.previousSnapshotUrl
      : undefined;

  return {
    credential: body.credential,
    expiresAt: body.expiresAt,
    ...(previousSnapshotUrl ? { previousSnapshotUrl } : {}),
  };
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
// `coreProjectId` is required for the same reason as {@link getJob} — see the ⚠️
// there. The stream is the same passthrough one layer down, so it had the same
// hole and takes the same parameter.
export async function* streamJob(
  jobId: string,
  coreProjectId: string,
): AsyncGenerator<JobStreamEvent> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({ [JOB_SCOPE_QUERY_PARAM]: coreProjectId });
  const res = await aiFetch(
    `${url}/v1/jobs/${encodeURIComponent(jobId)}/stream?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${serviceToken}`, Accept: 'text/event-stream' },
    },
  );
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

// ── The per-project LESSON INSPECTION reads (Subtask MOTIR-3337 over MOTIR-3335) ──
//
// The `/v1/lessons` pair, keyed by the core identity exactly as `getCodeAudit`
// and `getConvention` are. There is no new convention here: same `config()`,
// same `authHeaders`, same `aiFetch` (which maps a transport failure and the
// 30s deadline alike to `MotirAiUnavailableError`), same
// `errorFromProblem(await readProblem(res))` on a non-2xx.
//
// ⚠️ TENANT ONLY, decided UPSTREAM. motir-ai selects `aiProjectId = <this
// project>` and never the injection clause `scope = 'global' OR aiProjectId =
// …`, so the shipped global corpus cannot reach a customer's screen
// (`motir-ai/docs/contract.md`, `GET /v1/lessons`). motir-core does not filter
// a second time and must not start: a second filter here would let the upstream
// one be removed without a failing test on either side.

/** One lesson as motir-ai returns it. Dates are ISO-8601 strings on the wire. */
export interface RawLesson {
  id: string;
  scope: string;
  aiProjectId: string | null;
  mistakeType: string;
  title: string;
  body: string;
  why: string;
  howToApply: string;
  categories?: string[];
  kinds?: string[];
  types?: string[];
  phases?: string[];
  sourceRef: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastOccurredAt: string;
  recurrenceCount?: number;
  /** Whether the planner is being told this today. */
  injected: boolean;
  /** Why not, when it is not — `disabled` | `not_recurred`, else null. */
  injectionBlock: string | null;
  /**
   * The HUMAN OVERRIDE (MOTIR-3330) — `retired` | `exempt`, else null.
   *
   * Optional here because an upstream that predates it sends none, and the
   * absence is honest: no decision has been recorded.
   */
  humanOverride?: string | null;
  /** When that decision was made (ISO-8601) and by whom (a core user id). */
  humanOverrideAt?: string | null;
  humanOverrideBy?: string | null;
  /** The retire-by-non-recurrence window, in days, THIS row was judged against. */
  retentionDays?: number;
}

export interface RawLessonPage {
  lessons: RawLesson[];
  nextCursor: string | null;
  /** Every tenant lesson — the LIBRARY's size, not this page's. */
  total: number;
  /** The subset the planner is currently being told. */
  applied: number;
  /** The instant every row on this page was labelled against (ISO-8601). */
  staleCutoff: string;
  /** The retire-by-non-recurrence window, in days. */
  retentionDays: number;
}

export interface LessonListQuery {
  coreWorkspaceId: string;
  coreProjectId: string;
  cursor?: string;
  limit?: number;
}

// GET /v1/lessons — one page of THIS project's own lessons.
export async function getLessons(query: LessonListQuery): Promise<RawLessonPage> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({
    coreWorkspaceId: query.coreWorkspaceId,
    coreProjectId: query.coreProjectId,
  });
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const res = await aiFetch(`${url}/v1/lessons?${params.toString()}`, {
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json()) as Partial<RawLessonPage>;
  // The malformed-body arm `refreshCodeAudit` and `setSeatQuantity` already use:
  // a 200 whose shape is wrong is an unavailable upstream, not a page of zero
  // lessons — which is what an unchecked `body.lessons ?? []` would render it as,
  // and an empty list is exactly the answer a real project legitimately gives.
  if (!Array.isArray(body.lessons)) {
    throw new MotirAiUnavailableError('lessons response missing `lessons`');
  }
  return {
    lessons: body.lessons,
    nextCursor: body.nextCursor ?? null,
    // ⚠️ `??` the COUNTS to the page length rather than to 0: an upstream that
    // predates them would otherwise render as "0 lessons" on a screen that is
    // visibly showing some. Falling back to what we can see is wrong by at most
    // a page; falling back to zero contradicts the rows beside it.
    total: typeof body.total === 'number' ? body.total : body.lessons.length,
    applied: typeof body.applied === 'number' ? body.applied : body.lessons.length,
    staleCutoff: body.staleCutoff ?? new Date(0).toISOString(),
    retentionDays: typeof body.retentionDays === 'number' ? body.retentionDays : 0,
  };
}

export interface LessonDetailQuery {
  coreWorkspaceId: string;
  coreProjectId: string;
  lessonId: string;
}

// GET /v1/lessons/:id — one lesson in full.
//
// An id belonging to another project raises the same upstream `not_found` as an
// unknown one, so nothing here can distinguish them either — the existence-oracle
// posture is preserved by NOT adding a check that would.
export interface CreateLessonRequest {
  coreOrganizationId: string;
  coreWorkspaceId: string;
  coreProjectId: string;
  mistakeType: string;
  title: string;
  body: string;
  why: string;
  howToApply: string;
  kinds?: string[];
  types?: string[];
  phases?: string[];
  sourceRef?: string;
}

// POST /v1/lessons — ADD one lesson to THIS project's own store (Story
// MOTIR-3331 · MOTIR-3360). The write sibling of `getLessons` / `getLesson`
// above, and shaped like them: the CORE identity in the body, the service token
// in the header, a typed error out of `errorFromProblem`.
//
// ⚠️ NO `scope` FIELD, AND THAT IS THE CONTRACT, not an omission. The route
// creates tenant rows only, and refuses a body that names `scope` rather than
// dropping it — so this type having no such member is what keeps a caller from
// ever forming the request. A lesson that applies to every project is Motir's own
// curated corpus and arrives by migration.
//
// ⚠️ THE FIELD NAMES ARE A CROSS-REPO STRING AGREEMENT (the warning beside
// `JOB_SCOPE_QUERY_PARAM`): motir-ai's `parseAddLessonBody` requires these exact
// names, and a typo on either side is a `validation_error` at runtime with no
// type error and no test failure in the repo that made it. The seam test asserts
// on the SERIALIZED body for that reason.
//
// The upstream's near-duplicate refusal (409) and its validation errors are
// mapped by `errorFromProblem` and propagate — deliberately. That refusal names
// the existing lesson's id and title, and the caller needs both: a generic
// "could not create" turns an actionable answer into a dead end.
export async function createLesson(input: CreateLessonRequest): Promise<RawLesson> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/lessons`, {
    method: 'POST',
    headers: { ...authHeaders(serviceToken), 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json()) as Partial<RawLesson>;
  // The malformed-body arm the reads above already use: a 200/201 whose shape is
  // wrong is an unavailable upstream, not a lesson.
  if (typeof body.id !== 'string') {
    throw new MotirAiUnavailableError('create-lesson response missing `id`');
  }
  return body as RawLesson;
}

// ── The TEACHING read (Subtask MOTIR-3478 over MOTIR-3477) ──────────────────
//
// `POST /v1/lessons/search`. The reads above are the INSPECTION pair and are
// tenant-only by decision; this one is the teaching read and answers across BOTH
// scopes — the shared corpus and this project's own — because a caller about to
// act should be taught by both and it does not matter which of the two a past
// mistake happens to be recorded in.
//
// ⚠️ SO THE `isTenantRow` NARROWING THAT GUARDS THE INSPECTION READS MUST NOT BE
// APPLIED TO THIS ONE. It is a second line of defence there precisely because a
// global row arriving would be a defect; here a global row is the larger half of
// the correct answer. Same store, same client, opposite filters — the reason
// each is written at its own call site rather than in a shared helper.
//
// ⚠️ NO `scope` FIELD AND NO `aiProjectId` ON THE WIRE. The acting project is
// the core identity in the body, resolved upstream, so a caller cannot name
// another project's store. Same cross-repo string agreement as `createLesson`:
// `parseSearchLessonsBody` requires these exact names.

/** One ranked lesson as the teaching read returns it — prose, not identifiers. */
export interface RawRankedLesson {
  id: string;
  title: string;
  body: string;
  howToApply: string;
  scope: string;
  kinds?: string[];
  types?: string[];
  phases?: string[];
  /** Cosine distance to the query; lower is nearer. */
  distance: number;
}

export interface SearchLessonsRequest {
  coreWorkspaceId: string;
  coreProjectId: string;
  query: string;
  kinds?: string[];
  types?: string[];
  phases?: string[];
  limit?: number;
}

export async function searchLessons(input: SearchLessonsRequest): Promise<RawRankedLesson[]> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/lessons/search`, {
    method: 'POST',
    headers: { ...authHeaders(serviceToken), 'content-type': 'application/json' },
    body: JSON.stringify({
      coreWorkspaceId: input.coreWorkspaceId,
      coreProjectId: input.coreProjectId,
      query: input.query,
      // ⚠️ SPREAD, so an axis the caller omitted is ABSENT from the JSON rather
      // than present as `null` or `[]`. The distinction survives this hop
      // because the upstream SQL depends on it: an absent axis omits its clause,
      // and an empty one renders a filter that matches nothing.
      ...(input.kinds ? { kinds: input.kinds } : {}),
      ...(input.types ? { types: input.types } : {}),
      ...(input.phases ? { phases: input.phases } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json()) as { lessons?: unknown };
  // The malformed-body arm the reads above use: a 200 whose shape is wrong is an
  // unavailable upstream, NOT a search that matched nothing — and here the two
  // are the exact pair of answers the caller must be able to tell apart.
  if (!Array.isArray(body.lessons)) {
    throw new MotirAiUnavailableError('lesson-search response missing `lessons`');
  }
  return body.lessons as RawRankedLesson[];
}

export interface ReinforceLessonRequest {
  coreWorkspaceId: string;
  coreProjectId: string;
  lessonId: string;
  /** The caller's identity for the EVENT — what makes the call idempotent. */
  occurrenceRef: string;
}

/** What the reinforce route answers with. */
export interface RawReinforcedLesson {
  id: string;
  title: string;
  scope: string;
  lastOccurredAt: string;
  recurrenceCount: number;
  /** Whether THIS call is the one that counted; `false` is a replay, not an error. */
  counted: boolean;
}

/**
 * Record that an occurrence matched a lesson (Bug MOTIR-3547 · MOTIR-3553).
 *
 * ⚠️ It reaches GLOBAL rows as well as this project's own — the upstream route
 * resolves over both scopes deliberately, because the entire curated corpus is
 * global and MOTIR-3323 established it must be reinforceable. Another tenant's
 * lesson still raises `not_found`.
 */
export async function reinforceLesson(input: ReinforceLessonRequest): Promise<RawReinforcedLesson> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/lessons/${encodeURIComponent(input.lessonId)}/reinforce`, {
    method: 'POST',
    headers: { ...authHeaders(serviceToken), 'content-type': 'application/json' },
    body: JSON.stringify({
      coreWorkspaceId: input.coreWorkspaceId,
      coreProjectId: input.coreProjectId,
      occurrenceRef: input.occurrenceRef,
    }),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json()) as Partial<RawReinforcedLesson>;
  // A 200 whose shape is wrong is an unavailable upstream, not a silent
  // success — the same arm the lesson search takes, and for the sharper reason
  // here: a caller that reads a malformed body as "recorded" stops recording.
  if (typeof body.id !== 'string' || typeof body.counted !== 'boolean') {
    throw new MotirAiUnavailableError('reinforce-lesson response missing `id` / `counted`');
  }
  return body as RawReinforcedLesson;
}

export async function getLesson(query: LessonDetailQuery): Promise<RawLesson> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({
    coreWorkspaceId: query.coreWorkspaceId,
    coreProjectId: query.coreProjectId,
  });
  const res = await aiFetch(
    `${url}/v1/lessons/${encodeURIComponent(query.lessonId)}?${params.toString()}`,
    { headers: authHeaders(serviceToken) },
  );
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json()) as Partial<RawLesson>;
  if (typeof body.id !== 'string') {
    throw new MotirAiUnavailableError('lesson response missing `id`');
  }
  return body as RawLesson;
}

// ── The lesson WRITE half (Subtask MOTIR-3345 · Story MOTIR-3330) ──
//
// Two named acts on one axis. NEITHER SENDS THE OVERRIDE VALUE: motir-ai reads
// the row to decide what `apply` means — clear the retirement on a row somebody
// switched off, exempt from the clock on a row that aged out (MOTIR-3344). Core
// says WHICH lesson and WHO is acting, and nothing else.

export interface LessonWriteQuery {
  coreWorkspaceId: string;
  coreProjectId: string;
  lessonId: string;
  /**
   * The acting core user id.
   *
   * ⚠️ Required, and threaded rather than defaulted. The detail surface promises
   * to say who switched a lesson off; the upstream can only record that if this
   * side sends it, and its absence is invisible until somebody opens that view
   * and finds an audit line saying nothing.
   */
  actorId: string;
}

async function lessonWrite(
  query: LessonWriteQuery,
  action: 'retire' | 'apply',
): Promise<RawLesson> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/lessons/${encodeURIComponent(query.lessonId)}/${action}`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify({
      coreWorkspaceId: query.coreWorkspaceId,
      coreProjectId: query.coreProjectId,
      actorId: query.actorId,
    }),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json()) as Partial<RawLesson>;
  // Same malformed-body arm the reads use: a 200 whose shape is wrong is an
  // unavailable upstream, not a lesson.
  if (typeof body.id !== 'string') {
    throw new MotirAiUnavailableError(`lesson ${action} response missing \`id\``);
  }
  return body as RawLesson;
}

// POST /v1/lessons/:id/retire — stop applying this lesson.
export function retireLesson(query: LessonWriteQuery): Promise<RawLesson> {
  return lessonWrite(query, 'retire');
}

// POST /v1/lessons/:id/apply — apply it again. Idempotent, and the upstream
// decides whether that means clearing the retirement or exempting the row.
export function applyLesson(query: LessonWriteQuery): Promise<RawLesson> {
  return lessonWrite(query, 'apply');
}
