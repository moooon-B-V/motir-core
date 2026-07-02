import { NextResponse } from 'next/server';
import { ideaDraftService } from '@/lib/services/ideaDraftService';
import { EmptyIdeaError } from '@/lib/ideaDraft/errors';
import { consumeRateLimit } from '@/lib/rateLimit/fixedWindow';
import { corsHeaders, isForbiddenCrossOrigin, resolveAllowedOrigin } from '@/lib/ideaDraft/cors';

// POST /api/idea-draft (Subtask 7.22.2 / MOTIR-1458) — the PUBLIC, cross-origin
// pre-auth idea receiver. The standalone motir-marketing site (motir.co) forwards
// a logged-out visitor's hero idea here; we store a short-lived anonymous draft
// and return its opaque `draftId`. The browser is then navigated to
// `/sign-in?draft=<id>` (same origin) which claims it. NOT session-gated (the
// visitor has no account yet), so there is deliberately no `getSession()` call.
//
// Contract for the motir-marketing consumer (Subtask 8.3.6 / MOTIR-1152):
//   POST /api/idea-draft   { "idea": string }   (Content-Type: application/json)
//   → 201 { "draftId": string }
//   then navigate the browser to  `${motirCoreOrigin}/sign-in?draft=<draftId>`
// The caller's origin MUST be listed in `MOTIR_MARKETING_ORIGIN` (else 403).
//
// Anti-abuse (an internet-facing write): origin-allowlisted, per-IP rate-limited,
// idea length-capped (in the service, via the shared cookie bound), and TTL'd.

// Per-IP fixed window: enough for a human retrying a couple of times, tight
// enough to blunt scripted draft-spraying. In-memory (per instance) — same class
// as the app's other limiters (see lib/rateLimit/fixedWindow.ts).
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

/** First hop of `x-forwarded-for` (the client), falling back to a shared bucket. */
function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  const first = fwd?.split(',')[0]?.trim();
  return first || 'unknown';
}

export async function OPTIONS(req: Request): Promise<Response> {
  const allowedOrigin = resolveAllowedOrigin(req);
  if (!allowedOrigin) {
    // Not an allowlisted origin — no CORS grant. 204 with no ACAO makes the
    // browser block the follow-up request (fail closed).
    return new NextResponse(null, { status: 204 });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders(allowedOrigin) });
}

export async function POST(req: Request): Promise<Response> {
  // Reject a present-but-not-allowlisted origin outright (defense in depth — the
  // browser's own CORS check would block reading the response, but we also refuse
  // to do the work / store anything for a disallowed origin).
  if (isForbiddenCrossOrigin(req)) {
    return NextResponse.json({ code: 'ORIGIN_NOT_ALLOWED' }, { status: 403 });
  }
  const allowedOrigin = resolveAllowedOrigin(req);
  const headers = allowedOrigin ? corsHeaders(allowedOrigin) : undefined;

  const limit = consumeRateLimit(
    `idea-draft:${clientIp(req)}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!limit.allowed) {
    return NextResponse.json(
      { code: 'RATE_LIMITED' },
      {
        status: 429,
        headers: { ...headers, 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400, headers },
    );
  }
  const idea = (body ?? {}) as Record<string, unknown>;

  try {
    const result = await ideaDraftService.createDraft(idea.idea);
    return NextResponse.json(result, { status: 201, headers });
  } catch (err) {
    if (err instanceof EmptyIdeaError) {
      return NextResponse.json({ code: err.code }, { status: 400, headers });
    }
    throw err;
  }
}
