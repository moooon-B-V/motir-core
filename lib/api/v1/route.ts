import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { authenticateApiToken } from '@/lib/apiTokens/routeAuth';
import type { TokenScope } from '@/lib/mcp/scopes';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { presentedBearerToken, tokenFingerprint } from '@/lib/api/v1/bearer';
import {
  classifyApiV1Error,
  INTERNAL_ERROR_BODY,
  InsufficientScopeError,
  UnauthenticatedError,
} from '@/lib/api/v1/errors';
import {
  consumeRateLimit,
  rateLimitHeaders,
  RateLimitExceededError,
  retryAfterSeconds,
} from '@/lib/api/v1/rateLimit';

// The shared `/api/v1` route wrapper (Story 11.1 · Subtask 11.1.2 —
// MOTIR-1858). EVERY public endpoint composes this one helper, which is what
// makes "did this route follow the conventions?" answerable by "did it use the
// wrapper?" — a question MOTIR-1861 checks mechanically instead of by review.
//
// It owns, in this order:
//
//   1. AUTH — delegates to the shipped `authenticateApiToken(req, scope)`;
//      `unauthenticated` → 401 (undifferentiated), `forbidden` → 403.
//   2. RATE LIMITING — per token, with `X-RateLimit-*` on every response and a
//      429 when the budget is spent (MOTIR-1860).
//   3. The `ServiceContext` the services expect, built from the resolved
//      `{ userId, workspaceId }`, so the route's single service call runs as
//      the token owner and the product's own access checks apply unchanged.
//   4. ERROR MAPPING — a typed service error becomes `{ code, error }` + its
//      status; anything unrecognised becomes a bare 500 that leaks nothing.
//   5. A REQUEST ID on every response, success and failure alike.
//
// Ordering is a contract, not an implementation detail: auth runs BEFORE the
// limiter and before the handler does any parsing or reading, so an
// unauthenticated request neither spends a real token's budget nor reaches a
// cursor parser or the database. MOTIR-1861 asserts that ordering rather than
// assuming it.
//
// Conventions pinned in `docs/decisions/public-api-conventions.md`.

/** Correlation id echoed on every v1 response, for support conversations. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** A client-supplied request id we are willing to echo (id-shaped, bounded). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Echo the caller's `x-request-id` when it is id-shaped, else mint one.
 * Echoing lets a client correlate its own logs with ours; the shape check
 * keeps an arbitrary header value from being reflected into our response.
 */
function resolveRequestId(req: Request): string {
  const supplied = req.headers.get(REQUEST_ID_HEADER);
  return supplied && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();
}

/** What a v1 handler is given. */
export interface V1RouteContext<P> {
  /** The raw request — for query parsing (`new URL(ctx.req.url)`). */
  req: Request;
  /** The resolved dynamic route params (`{}` for a static route). */
  params: P;
  /** The token owner. */
  userId: string;
  /** The workspace the token is BOUND to. v1 never widens past it. */
  workspaceId: string;
  /** Ready-made context for the single service call the route makes. */
  service: ServiceContext;
  /** The id stamped on this response. */
  requestId: string;
  /**
   * The bearer secret this request presented. Present because the gate
   * already accepted it. Routes that need the token's own metadata (its
   * granted scopes) pass this to `apiTokensService.verify`; see
   * `lib/api/v1/bearer.ts` for why the wrapper reads it at all.
   */
  presentedToken: string;
  /**
   * Response headers every exit path carries — success, mapped error and
   * 500 alike. The seam MOTIR-1860's rate-limit headers stamp into, so they
   * cannot be dropped on an error path.
   */
  responseHeaders: Headers;
}

export interface V1RouteOptions {
  /**
   * The scope this route REQUIRES. Declared, never inferred: the ADR's
   * operation → scope table (§3) is implemented here, at the route's
   * definition, and a route that declares none fails MOTIR-1861's guard.
   */
  scope: TokenScope;
}

type V1Handler<P> = (ctx: V1RouteContext<P>) => Promise<Response> | Response;

/** What Next.js hands a route handler as its second argument. */
type NextRouteArgs<P> = { params: Promise<P> } | undefined;

/**
 * Wrap a handler as a `/api/v1` route.
 *
 * ```ts
 * export const GET = withV1Route({ scope: 'read' }, async (ctx) => {
 *   const dto = await someService.read(ctx.service);
 *   return NextResponse.json(dto);
 * });
 * ```
 *
 * The handler does exactly what the 4-layer contract allows a route to do:
 * parse, call ONE service method, return. No `db.*`, no `$transaction`, no
 * business logic — asserted by MOTIR-1861's architecture guard.
 */
export function withV1Route<P = Record<string, never>>(
  options: V1RouteOptions,
  handler: V1Handler<P>,
): (req: Request, args?: NextRouteArgs<P>) => Promise<Response> {
  return async function v1Route(req: Request, args?: NextRouteArgs<P>): Promise<Response> {
    const requestId = resolveRequestId(req);
    const responseHeaders = new Headers({ [REQUEST_ID_HEADER]: requestId });

    try {
      // ── 1. Authenticate, BEFORE any parsing or reading ──────────────────
      const presentedToken = presentedBearerToken(req);
      const auth = await authenticateApiToken(req, options.scope);
      if (!auth.ok) {
        throw auth.reason === 'forbidden'
          ? new InsufficientScopeError(options.scope)
          : new UnauthenticatedError();
      }
      // `authenticateApiToken` only returns ok for a token it read off this
      // request, so the header parse above cannot have missed it.
      /* v8 ignore next */
      if (!presentedToken) throw new UnauthenticatedError();

      // ── 2. Rate-limit, per TOKEN ────────────────────────────────────────
      // AFTER auth, so an unauthenticated flood cannot spend a real token's
      // budget (an attacker who knew a token id could otherwise exhaust it
      // without holding the secret) — and BEFORE the handler, so no work is
      // done for a request that will be refused.
      //
      // The headers go into `responseHeaders`, which every exit path stamps,
      // so they survive a 429, a mapped error and a 500 alike.
      const decision = await consumeRateLimit(tokenFingerprint(presentedToken));
      for (const [header, value] of Object.entries(rateLimitHeaders(decision))) {
        responseHeaders.set(header, value);
      }
      if (!decision.allowed) throw new RateLimitExceededError(retryAfterSeconds(decision));

      // ── 3. Run the handler ──────────────────────────────────────────────
      const params = ((await args?.params) ?? {}) as P;
      const response = await handler({
        req,
        params,
        userId: auth.userId,
        workspaceId: auth.workspaceId,
        service: { userId: auth.userId, workspaceId: auth.workspaceId },
        requestId,
        presentedToken,
        responseHeaders,
      });
      return stamp(response, responseHeaders);
    } catch (err) {
      const classified = classifyApiV1Error(err);
      if (classified) {
        return stamp(
          NextResponse.json(classified.body, { status: classified.status }),
          responseHeaders,
        );
      }
      // Unrecognised: a raw Error, a Prisma fault, a domain error whose code
      // is not in the v1 map. Log it server-side, return nothing about it.
      console.error(`[api/v1] unhandled error (requestId=${requestId})`, err);
      return stamp(NextResponse.json(INTERNAL_ERROR_BODY, { status: 500 }), responseHeaders);
    }
  };
}

/** Copy the accumulated headers onto whatever the exit path produced. */
function stamp(response: Response, headers: Headers): Response {
  headers.forEach((value, key) => response.headers.set(key, value));
  return response;
}
