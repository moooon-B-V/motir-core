import { NextResponse } from 'next/server';
import { authenticateJobRequest, JobAuthError } from '@/lib/ai/jobAuth';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import {
  decodeFilterEnvelope,
  type FilterConditionValue,
  type FilterDecodeResult,
} from '@/lib/filters/ast';
import { FilterValidationError } from '@/lib/filters/errors';
import { InvalidSearchCursorError } from '@/lib/mcp/searchCursor';
import { ProjectNotFoundError, ProjectAccessDeniedError } from '@/lib/projects/errors';

// POST /api/internal/ai/search-work-items (Subtask 7.5.2) — the on-demand SEARCH
// tool in the 7.5 graph-traversal family: "find the work items related to X"
// without transmitting the whole tree. Body is the SHIPPED 6.1.1 versioned
// FilterAST in its self-documenting expanded form (`{ version, combinator,
// conditions }`, the same shape the `search_work_items` MCP tool takes) plus an
// opaque page `cursor` + a `limit`. It rides the EXACT `/items` List read
// (`getProjectIssuesList`) — one predicate grammar, never a parallel query path.
//
// Auth: the §4a service bearer + §4b job token (`authenticateJobRequest`), the
// SAME job-scoped-token posture as the rest of the 7.5.1 family — never a cookie
// session, never CORS-exposed. The project is the TOKEN's project (no
// caller-supplied project), so a token only ever searches its own tenant.
// Thin transport per CLAUDE.md: authenticate → decode the envelope → ONE service
// call → map typed errors.
//
// Typed errors → status:
//   JobAuthError            → 401 (bad service bearer / missing-or-expired token)
//   (bad request shape)     → 400 (non-JSON body, filter not an object,
//                             conditions not a list, non-string cursor, bad limit)
//   FilterDecodeResult      → 422 (malformed / old-version / structurally-bad
//                             FilterAST — the codec's typed verdict)
//   InvalidSearchCursorError→ 400 (a cursor that isn't a well-formed page token)
//   FilterValidationError   → 422 (a structurally-valid AST that fails registry
//                             validation — unknown field/operator, bad value)
//   ProjectNotFoundError    → 404 (the token's user can't browse it — never 403)
//   ProjectAccessDeniedError→ 404 browse / 403 edit

// The codec's version/structure verdict → a stable wire code, one per `reason`
// (identical to the `search_work_items` MCP carrier's FILTER_DECODE_CODES, so
// the two carriers speak the same taxonomy).
const FILTER_DECODE_CODES: Record<Exclude<FilterDecodeResult, { ok: true }>['reason'], string> = {
  malformed: 'MALFORMED_FILTER',
  'unsupported-version': 'UNSUPPORTED_FILTER_VERSION',
  invalid: 'INVALID_FILTER',
};

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
    auth = authenticateJobRequest(req);
  } catch (err) {
    if (err instanceof JobAuthError) {
      return fail(err.code, err.message, err.httpStatus);
    }
    throw err;
  }

  // ── Parse the body ──
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('SEARCH_INVALID', 'request body must be valid JSON', 400);
  }
  const b = isRecord(body) ? body : {};

  // ── Decode the FilterAST envelope through the SHARED 6.1.1 codec ──
  // The expanded `{ version, combinator, conditions }` maps 1:1 to the stored
  // envelope `{ v, c, f }` the codec validates. An absent `filter` searches the
  // whole project. Structure/version failures surface as the codec's typed
  // verdict (never a throw); registry-level validation (unknown field/operator,
  // bad value arity) runs next INSIDE the service.
  let ast;
  const { filter } = b;
  if (filter !== undefined) {
    if (!isRecord(filter)) {
      return fail('SEARCH_INVALID', '`filter` must be an object.', 400);
    }
    if (filter['conditions'] !== undefined && !Array.isArray(filter['conditions'])) {
      return fail('SEARCH_INVALID', '`filter.conditions` must be an array.', 400);
    }
    const rows = Array.isArray(filter['conditions']) ? filter['conditions'] : [];
    const decoded = decodeFilterEnvelope({
      v: filter['version'],
      c: filter['combinator'],
      f: rows.map((c) => {
        const cc = isRecord(c) ? c : {};
        return [cc['field'], cc['operator'], cc['value']] as [
          unknown,
          unknown,
          FilterConditionValue,
        ];
      }),
    });
    if (!decoded.ok) {
      return fail(FILTER_DECODE_CODES[decoded.reason], decoded.detail, 422);
    }
    ast = decoded.ast;
  }

  // ── Validate the pagination args (request shape) ──
  const { cursor, limit } = b;
  if (cursor !== undefined && typeof cursor !== 'string') {
    return fail('SEARCH_INVALID', '`cursor` must be a string.', 400);
  }
  if (
    limit !== undefined &&
    (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50)
  ) {
    return fail('SEARCH_INVALID', '`limit` must be an integer between 1 and 50.', 400);
  }

  // ── ONE service call ──
  try {
    const result = await aiBoundaryService.searchWorkItems(
      auth.projectId,
      {
        ...(ast ? { ast } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
      auth.ctx,
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof InvalidSearchCursorError) {
      return fail(err.code, err.message, 400);
    }
    if (err instanceof FilterValidationError) {
      return fail(err.code, err.message, 422);
    }
    if (err instanceof ProjectNotFoundError) {
      return fail(err.code, err.message, 404);
    }
    if (err instanceof ProjectAccessDeniedError) {
      return fail(err.code, err.message, err.kind === 'browse' ? 404 : 403);
    }
    throw err;
  }
}
