import { z } from 'zod/v4';

// The v1 SHARED RESPONSE HEADERS, declared as components (Story 11.4 · Subtask
// 11.4.3 — MOTIR-2184).
//
// These belong to the shared layer rather than to any operation because the
// wrapper sets them on EVERY exit path — success, a mapped domain error, a 403,
// a 429 and a bare 500 alike (`lib/api/v1/route.ts` stamps them into
// `responseHeaders`, which every return goes through). A header emitted per
// operation would be a list of N copies of one fact.
//
// ⚠️ CASING. The wrapper writes them lowercase (`rateLimitHeaders()` returns
// `x-ratelimit-limit`, and `REQUEST_ID_HEADER` is `x-request-id`) because HTTP
// header names are case-insensitive and `fetch`/`Headers` normalises them
// anyway. The DOCUMENT uses the canonical display casing, which is what every
// mirror publishes and what a developer greps for. The two are the same header;
// the test asserts that by reading the wrapper's own output through these names.

/** One declared response header: what it is, and the type of its value. */
export interface V1HeaderComponent {
  /** The canonical display name, as the emitted document carries it. */
  name: string;
  /** The name the wrapper actually writes (lower-case; same header). */
  wireName: string;
  /** What the header means, for the reference page. */
  description: string;
  /** The value's shape. Header values are strings on the wire. */
  schema: z.ZodType;
}

/**
 * The correlation id stamped on every response — ADR §4's *"every response
 * carries a request id header, success and failure alike, so a developer can
 * quote one identifier in a support conversation"*.
 *
 * Echoed from the caller's own `x-request-id` when it is id-shaped, else minted.
 */
export const V1_REQUEST_ID_HEADER: V1HeaderComponent = {
  name: 'X-Request-Id',
  wireName: 'x-request-id',
  description:
    'A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike.',
  schema: z.string().min(1),
};

/**
 * The CONTRACT version that served this response — ADR §8's additive list, via
 * MOTIR-2275.
 *
 * ⚠️ It ADVERTISES the contract version; it does not NEGOTIATE one. ADR §1
 * rejected header VERSIONING (a REQUEST header selecting which contract to
 * serve) and that rejection stands — `/api/v1` is still the only thing that
 * picks a contract. This is a RESPONSE header, never read off a request, and
 * what it buys is that a client learns the number from a call it was already
 * making instead of downloading a specification to read one string.
 *
 * The value is the CONTRACT's `MAJOR.MINOR.PATCH` (ADR Amendment 4 Q6) — the
 * same number `info.version` carries — and NOT the deployment's release
 * number, which would churn on every unrelated deploy and tell a client
 * nothing it can act on.
 */
export const V1_API_VERSION_HEADER: V1HeaderComponent = {
  name: 'X-Motir-Api-Version',
  wireName: 'x-motir-api-version',
  description:
    "The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document.",
  schema: z.string().regex(/^\d+\.\d+\.\d+$/),
};

/**
 * The per-token rate-limit budget headers — ADR §6. On every response,
 * including the 429 that reports the budget is spent and the 403 that was
 * metered anyway.
 */
export const V1_RATE_LIMIT_HEADERS: readonly V1HeaderComponent[] = [
  {
    name: 'X-RateLimit-Limit',
    wireName: 'x-ratelimit-limit',
    description: 'The number of requests this token may make in the current window.',
    schema: z.string().regex(/^\d+$/),
  },
  {
    name: 'X-RateLimit-Remaining',
    wireName: 'x-ratelimit-remaining',
    description: 'Requests left in the current window. Reaches `0` before a 429 is returned.',
    schema: z.string().regex(/^\d+$/),
  },
  {
    name: 'X-RateLimit-Reset',
    wireName: 'x-ratelimit-reset',
    description:
      'Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can.',
    schema: z.string().regex(/^\d+$/),
  },
];

/**
 * Every header the shared layer declares, in document order.
 *
 * The list an operation references wholesale: because the wrapper stamps all of
 * them on all exits, an operation never picks a subset.
 */
export const V1_SHARED_RESPONSE_HEADERS: readonly V1HeaderComponent[] = [
  V1_REQUEST_ID_HEADER,
  V1_API_VERSION_HEADER,
  ...V1_RATE_LIMIT_HEADERS,
];
