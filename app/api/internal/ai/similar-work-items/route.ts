import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { EMBEDDING_DIMENSIONS } from '@/lib/repositories/workItemEmbeddingRepository';
import { ProjectNotFoundError, ProjectAccessDeniedError } from '@/lib/projects/errors';

// POST /api/internal/ai/similar-work-items (Story MOTIR-2694 · Subtask
// MOTIR-2697, `docs/decisions/plan-tree-embeddings.md` §6.1) — the SEMANTIC
// candidate-finder in the 7.5 plan-tree read family, and the answer to the
// failure GATE 1 has today: `search-work-items` is a `contains` SUBSTRING
// predicate, so a query for "persist UI preferences" cannot see a card titled
// "Board columns remember their collapsed state".
//
// Auth: the §4a service bearer + §4b job token (`authenticateAndLimitJobRequest`),
// the SAME posture as the sixteen routes beside it — never a cookie, never
// CORS-exposed. Thin transport per CLAUDE.md: authenticate → validate the request
// SHAPE → ONE service call → map typed errors.
//
// ⚠️ THE QUERY IS EMBEDDED BY THE CALLER, so this takes a VECTOR, not text
// (ADR §6.1). `motir-core` holds no provider credential and no embedding seam by
// design — the open-core split puts the AI capability on the closed side — and
// `motir-ai`, which originates this call, already owns an `embed()` seam and the
// metered gateway. Embedding here would add a `core → ai → gateway` hop to a call
// `motir-ai` itself started, and would put an LLM credential in the open repo.
//
// ⚠️ THE PROJECT IS NOT A PARAMETER AND IS REFUSED AS ONE. It is the job token's
// project, bound server-side. A body carrying `projectId` is a 400 rather than a
// silently ignored field: silently ignoring it would let a caller believe it had
// scoped a search it had not, and the failure would surface as a confusing
// result set rather than as an error at the seam.
//
// Typed errors → status:
//   JobAuthError             → 401 (bad service bearer / missing-or-expired token)
//   (bad request shape)      → 400 (non-JSON body, wrong-length or non-numeric
//                              vector, missing model, non-numeric limit/minScore,
//                              a caller-supplied project)
//   ProjectNotFoundError     → 404 (the token's user can't browse it — never 403)
//   ProjectAccessDeniedError → 404 browse / 403 edit
//
// A ranking failure is NOT in that table: an unreadable embedding store degrades
// to an empty 200 inside the service (ADR §6.1 — a planning job must never fail
// because a candidate-finder had nothing to offer).

/** ADR §6.1 — `limit` is optional, 1–50, default 10. */
const LIMIT_DEFAULT = 10;
const LIMIT_MIN = 1;
const LIMIT_MAX = 50;

function fail(code: string, error: string, status: number): NextResponse {
  return NextResponse.json({ code, error }, { status });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export async function POST(req: Request): Promise<Response> {
  // ── Authenticate: the service bearer + job token (no cookie) ──
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    /* istanbul ignore next -- `mapJobRequestError` renders every error
       `authenticateAndLimitJobRequest` is documented to throw (JobAuthError →
       401, JobRateLimitedError → 429), so this arm is reachable only if that
       function grows a third failure mode. It is kept — swallowing an unknown
       failure as one of the two above would report the wrong reason — but no
       test can reach it without mocking the auth module, and the repo's one
       sanctioned `vi.mock` is `getSession`. */
    throw err;
  }

  // ── Parse the body ──
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('SIMILAR_INVALID', 'request body must be valid JSON', 400);
  }
  if (!isRecord(body)) {
    return fail('SIMILAR_INVALID', 'request body must be an object.', 400);
  }

  // ── The project is the TOKEN's, and naming it is an error, not a no-op ──
  if (body['projectId'] !== undefined || body['projectKey'] !== undefined) {
    return fail(
      'SIMILAR_PROJECT_NOT_A_PARAMETER',
      'The project is resolved from the job token and cannot be supplied in the request.',
      400,
    );
  }

  // ── The query vector: exactly the pinned dimension, all finite numbers ──
  // A wrong-length vector is a 400 here and not a database error downstream (ADR
  // Consequences). The element check is not pedantry: a JSON `null` inside the
  // array survives `Array.isArray` + `.length` and reaches pgvector as a literal
  // it rejects mid-query, which would surface as a 500 for a request that was
  // malformed all along.
  const { queryEmbedding } = body;
  if (!Array.isArray(queryEmbedding)) {
    return fail('SIMILAR_INVALID', '`queryEmbedding` must be an array of numbers.', 400);
  }
  if (queryEmbedding.length !== EMBEDDING_DIMENSIONS) {
    return fail(
      'SIMILAR_DIMENSION_MISMATCH',
      `\`queryEmbedding\` must hold exactly ${EMBEDDING_DIMENSIONS} numbers (received ${queryEmbedding.length}).`,
      400,
    );
  }
  if (!queryEmbedding.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return fail('SIMILAR_INVALID', '`queryEmbedding` must hold only finite numbers.', 400);
  }

  // ── The model the query was embedded with — a HARD ranking filter (ADR §6.1),
  // so it is required rather than defaulted: guessing it would silently rank
  // against vectors that are not comparable to the caller's. ──
  const { model } = body;
  if (typeof model !== 'string' || model.trim() === '') {
    return fail('SIMILAR_INVALID', '`model` must be a non-empty string.', 400);
  }

  // ── `limit` is CLAMPED server-side, never refused ──
  // An over-large request is bounded like every other bounded read here, because
  // a caller asking for more candidates than the page allows has made a request
  // that is answerable — refusing it would turn a harmless over-ask into a failed
  // planning turn. A NON-NUMERIC limit is still a 400: that is a malformed
  // request, not an over-large one.
  const { limit: rawLimit } = body;
  if (rawLimit !== undefined && (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit))) {
    return fail('SIMILAR_INVALID', '`limit` must be a number.', 400);
  }
  const limit =
    rawLimit === undefined
      ? LIMIT_DEFAULT
      : Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, Math.trunc(rawLimit)));

  // ── `minScore` is optional; omitted = no threshold (ADR §6.1 pins NO default) ──
  const { minScore } = body;
  if (
    minScore !== undefined &&
    (typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < -1 || minScore > 1)
  ) {
    return fail('SIMILAR_INVALID', '`minScore` must be a number between -1 and 1.', 400);
  }

  // ── ONE service call ──
  try {
    const result = await aiBoundaryService.findSimilarWorkItems(
      auth.projectId,
      {
        queryEmbedding,
        model,
        limit,
        ...(minScore !== undefined ? { minScore } : {}),
      },
      auth.ctx,
    );
    return NextResponse.json(result);
  } catch (err) {
    // BOTH refusals are 404, and the missing 403 arm is deliberate. This route
    // asserts BROWSE and nothing else, so `ProjectAccessDeniedError` can only
    // ever carry `kind: 'browse'` here — the `'edit'` arm its siblings map to 403
    // is unreachable from a read. Writing it anyway would be a branch no test can
    // exercise and a reader would have to re-derive; 404 is also the right
    // default if this route ever does gain a write, because "forbidden" confirms
    // the project exists to someone who may not see it (finding #26).
    if (err instanceof ProjectNotFoundError || err instanceof ProjectAccessDeniedError) {
      return fail(err.code, err.message, 404);
    }
    throw err;
  }
}
