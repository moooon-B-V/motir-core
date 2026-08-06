import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import {
  classifyApiV1Error,
  DOMAIN_ERROR_STATUS,
  INTERNAL_ERROR_BODY,
  InsufficientScopeError,
  InvalidRequestError,
  UnauthenticatedError,
} from '@/lib/api/v1/errors';
import { RateLimitExceededError, resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { V1_COLLECTIONS } from '@/lib/api/v1/pagination';
import {
  v1CollectionSchema,
  v1CursorSchema,
  V1_PAGE_ENVELOPE_COMPONENT,
  V1_RANKED_PAGE_ENVELOPE_COMPONENT,
  v1PageEnvelopeSchema,
  v1RankedPageEnvelopeSchema,
} from '@/lib/api/v1/openapi/envelopes';
import {
  v1ErrorBodySchema,
  v1InternalErrorBodySchema,
  V1_ERROR_BODY_COMPONENT,
  V1_INTERNAL_ERROR_BODY_COMPONENT,
} from '@/lib/api/v1/openapi/errorResponse';
import {
  V1_RATE_LIMIT_HEADERS,
  V1_REQUEST_ID_HEADER,
  V1_SHARED_RESPONSE_HEADERS,
} from '@/lib/api/v1/openapi/headers';
import {
  V1_EXPOSED_SCOPES,
  V1_SCOPE_DESCRIPTIONS,
  V1_SCOPE_EXTENSION,
  V1_SECURITY_SCHEME_NAME,
  V1_UNEXPOSED_SCOPES,
  v1SecurityScheme,
} from '@/lib/api/v1/openapi/security';
import {
  isV1ErrorStatus,
  isV1Status,
  undocumentedStatuses,
  V1_ERROR_STATUSES,
  V1_STATUS_DESCRIPTIONS,
  V1_STATUSES,
  V1_SUCCESS_STATUSES,
} from '@/lib/api/v1/openapi/statuses';
import { TOKEN_SCOPES, isTokenScope } from '@/lib/mcp/scopes';
import { createV1Caller, type V1Caller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// The SHARED v1 wire-schema layer (Story 11.4 · Subtask 11.4.3 — MOTIR-2184).
//
// Three things this suite refuses to do, each because the acceptance criteria
// name the failure it would hide:
//
//   1. It does NOT compare a schema to a fixture written from the same
//      assumption. The error schema is asserted against what
//      `classifyApiV1Error` and the SHIPPED wrapper actually produce — a real
//      401 off a real route with a real (absent) token.
//   2. It does NOT only show its guards passing. `undocumentedStatuses` is run
//      against a deliberately-violating synthetic map, the way
//      `tests/helpers/v1RouteAudit.ts` runs its rules against a violating
//      source: a guard that has only ever been shown to pass is not a guard.
//   3. It does NOT re-declare a per-resource shape. Amendment 2 gives those to
//      Stories 11.2 / 11.3; this layer is the envelope, the error, the headers
//      and the scheme, and nothing else.

describe('the v1 status vocabulary', () => {
  it('documents every status it declares, success and error alike', () => {
    for (const status of V1_STATUSES) {
      expect(V1_STATUS_DESCRIPTIONS[status], `status ${status} has no description`).toBeTruthy();
    }
    expect(Object.keys(V1_STATUS_DESCRIPTIONS).length).toBe(V1_STATUSES.length);
  });

  it('covers every status DOMAIN_ERROR_STATUS can produce', () => {
    expect(undocumentedStatuses(DOMAIN_ERROR_STATUS)).toEqual([]);
  });

  it('carries the ADR §4 table exactly — including every appended condition', () => {
    expect([...V1_ERROR_STATUSES]).toEqual([401, 402, 403, 404, 409, 412, 422, 429, 500, 503]);
    expect([...V1_SUCCESS_STATUSES]).toEqual([200, 201, 202, 204]);
    // Every status a later story APPENDED as a NEW condition (ADR §8 permits
    // that; it forbids an existing condition changing status). Named
    // explicitly, because "the list is right" is only meaningful if the rows
    // that were argued for are the rows that are there.
    expect(DOMAIN_ERROR_STATUS['DUPLICATE_LINK']).toBe(409); // 11.2.9
    expect(DOMAIN_ERROR_STATUS['STALE_WORK_ITEM']).toBe(412); // 11.2.6
    // Story 11.7: a job-submitting endpoint answers 202 (Amendment 6 Q3), an
    // exhausted balance answers 402, and an unreachable motir-ai answers 503.
    expect(DOMAIN_ERROR_STATUS['MOTIR_AI_OUT_OF_CREDITS']).toBe(402); // 11.7.5
    expect(DOMAIN_ERROR_STATUS['MOTIR_AI_UNAVAILABLE']).toBe(503); // 11.7.5
    // …and the two motir-ai codes deliberately left OUT of the map, so the
    // absence is a decision a test holds rather than an oversight: our own bad
    // request to motir-ai is §4's bare, code-less 500.
    expect(DOMAIN_ERROR_STATUS['MOTIR_AI_BAD_REQUEST']).toBeUndefined();
    expect(DOMAIN_ERROR_STATUS['MOTIR_AI_JOB_FAILED']).toBeUndefined();
  });

  it('FAILS on a status map carrying a status the vocabulary does not document', () => {
    // The guard, run against a deliberate violation. If this ever returns `[]`,
    // the check above proves nothing.
    const drifted = { ...DOMAIN_ERROR_STATUS, SOME_NEW_CONDITION: 418 };
    expect(undocumentedStatuses(drifted)).toEqual([418]);
  });

  it('reports every undocumented status, not just the first', () => {
    expect(undocumentedStatuses({ A: 418, B: 451, C: 404 })).toEqual([418, 451]);
  });

  it('splits membership between the success and error halves', () => {
    expect(isV1Status(200)).toBe(true);
    expect(isV1Status(418)).toBe(false);
    expect(isV1ErrorStatus(404)).toBe(true);
    expect(isV1ErrorStatus(200)).toBe(false);
  });

  it('carries a status the WRAPPER itself can raise, not only a domain one', () => {
    // The wrapper's own errors never pass through DOMAIN_ERROR_STATUS, so the
    // reconciliation above cannot see them.
    for (const err of [
      new UnauthenticatedError(),
      new InsufficientScopeError('read'),
      new InvalidRequestError('INVALID_CURSOR', 'nope'),
      new RateLimitExceededError(30),
    ]) {
      expect(isV1Status(err.status), `${err.name} raises undocumented ${err.status}`).toBe(true);
    }
  });
});

describe('the v1 error-response schema', () => {
  it('parses what classifyApiV1Error actually returns for a wrapper error', () => {
    const classified = classifyApiV1Error(new UnauthenticatedError());
    expect(classified).toBeDefined();
    expect(v1ErrorBodySchema.parse(classified?.body)).toEqual({
      code: 'UNAUTHENTICATED',
      error: 'Authentication required.',
    });
  });

  it('parses what classifyApiV1Error returns for a DOMAIN error', () => {
    const domainError = Object.assign(new Error('Work item not found.'), {
      code: 'WORK_ITEM_NOT_FOUND',
    });
    const classified = classifyApiV1Error(domainError);
    expect(classified?.status).toBe(404);
    expect(() => v1ErrorBodySchema.parse(classified?.body)).not.toThrow();
  });

  it('is CLOSED — an extra field is a parse failure, not a silent pass', () => {
    expect(v1ErrorBodySchema.safeParse({ code: 'X', error: 'y', detail: 'leaked' }).success).toBe(
      false,
    );
  });

  it('refuses an empty code or message', () => {
    expect(v1ErrorBodySchema.safeParse({ code: '', error: 'y' }).success).toBe(false);
    expect(v1ErrorBodySchema.safeParse({ code: 'X', error: '' }).success).toBe(false);
  });

  it('gives the 500 body its OWN schema — no code, and code is not optional', () => {
    expect(() => v1InternalErrorBodySchema.parse(INTERNAL_ERROR_BODY)).not.toThrow();
    // The 500 body must NOT satisfy the coded envelope: if it did, a client
    // could not tell "an error with a contract" from "an unexpected fault".
    expect(v1ErrorBodySchema.safeParse(INTERNAL_ERROR_BODY).success).toBe(false);
  });

  it('names its components', () => {
    expect(V1_ERROR_BODY_COMPONENT).toBe('ErrorBody');
    expect(V1_INTERNAL_ERROR_BODY_COMPONENT).toBe('InternalErrorBody');
  });
});

describe('the error schema against a REAL response off the shipped wrapper', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
  });

  it('parses the 401 an unauthenticated request actually gets', async () => {
    const { GET } = await import('@/app/api/v1/me/route');
    const res = await GET(new Request('http://localhost:3000/api/v1/me'));

    expect(res.status).toBe(401);
    expect(isV1Status(res.status)).toBe(true);
    const body: unknown = await res.json();
    expect(() => v1ErrorBodySchema.parse(body)).not.toThrow();
  });

  it('parses the 403 a scope-less token actually gets, and both headers ride it', async () => {
    // A token with a real scope that is NOT the one `/me` requires would be
    // ideal, but `/me` is `read` and `read` is the narrowest scope — so use a
    // route whose scope this caller lacks.
    const caller: V1Caller = await createV1Caller({ scopes: ['read'] });
    const { POST } = await import('@/app/api/v1/work-items/[key]/transitions/route');
    const res = await POST(
      new Request('http://localhost:3000/api/v1/work-items/MOTIR-1/transitions', {
        method: 'POST',
        headers: { ...caller.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      }),
      { params: Promise.resolve({ key: 'MOTIR-1' }) },
    );

    expect(res.status).toBe(403);
    const parsed = v1ErrorBodySchema.parse(await res.json());
    expect(parsed.code).toBe('INSUFFICIENT_SCOPE');

    // The declared shared headers are on an ERROR response, which is the
    // property that put them in the shared layer rather than on an operation.
    for (const header of V1_SHARED_RESPONSE_HEADERS) {
      const value = res.headers.get(header.wireName);
      expect(value, `${header.name} missing from a 403`).not.toBeNull();
      expect(header.schema.safeParse(value).success, `${header.name} = ${value}`).toBe(true);
    }
  });
});

describe('the two v1 page envelopes', () => {
  const row = z.object({ key: z.string() });

  it('accepts a plain page and rejects one carrying totalCount', () => {
    const plain = v1PageEnvelopeSchema(row);
    expect(plain.parse({ items: [{ key: 'MOTIR-1' }], nextCursor: null })).toEqual({
      items: [{ key: 'MOTIR-1' }],
      nextCursor: null,
    });
    // The collapsed shape the ADR rejected by name: a plain collection that
    // starts reporting a count is a DIFFERENT envelope, and this is where that
    // becomes visible rather than silently tolerated.
    expect(plain.safeParse({ items: [], nextCursor: null, totalCount: 0 }).success).toBe(false);
  });

  it('requires totalCount on the ranked page — it is never optional', () => {
    const ranked = v1RankedPageEnvelopeSchema(row);
    expect(ranked.safeParse({ items: [], nextCursor: null }).success).toBe(false);
    expect(ranked.parse({ items: [], nextCursor: null, totalCount: 7 }).totalCount).toBe(7);
    expect(ranked.safeParse({ items: [], nextCursor: null, totalCount: -1 }).success).toBe(false);
    expect(ranked.safeParse({ items: [], nextCursor: null, totalCount: 1.5 }).success).toBe(false);
  });

  it('keeps nextCursor NULL on the last page — never absent', () => {
    const plain = v1PageEnvelopeSchema(row);
    expect(plain.safeParse({ items: [] }).success).toBe(false);
    expect(plain.parse({ items: [], nextCursor: 'abc' }).nextCursor).toBe('abc');
  });

  it('validates the ITEM schema it was composed with', () => {
    expect(
      v1PageEnvelopeSchema(row).safeParse({ items: [{ nope: 1 }], nextCursor: null }).success,
    ).toBe(false);
  });

  it('emits two DISTINCT component names', () => {
    expect(V1_PAGE_ENVELOPE_COMPONENT).not.toBe(V1_RANKED_PAGE_ENVELOPE_COMPONENT);
  });

  it('keeps V1_COLLECTIONS as the cursor’s scope vocabulary', () => {
    expect(v1CollectionSchema.options).toEqual([...V1_COLLECTIONS]);
    expect(v1CollectionSchema.safeParse('backlog').success).toBe(true);
    expect(v1CollectionSchema.safeParse('not-a-collection').success).toBe(false);
  });

  it('leaves the cursor OPAQUE — the document describes no payload', () => {
    expect(v1CursorSchema.safeParse('any-signed-blob').success).toBe(true);
    expect(v1CursorSchema.safeParse('').success).toBe(false);
  });
});

describe('the shared response headers', () => {
  it('declares the request id and the three rate-limit headers', () => {
    expect(V1_SHARED_RESPONSE_HEADERS.map((h) => h.name)).toEqual([
      'X-Request-Id',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ]);
  });

  it('pairs each display name with the lower-case name the wrapper writes', () => {
    for (const header of V1_SHARED_RESPONSE_HEADERS) {
      expect(header.wireName).toBe(header.name.toLowerCase());
      expect(header.description.length).toBeGreaterThan(0);
    }
  });

  it('types the rate-limit values as the digit strings they are on the wire', () => {
    for (const header of V1_RATE_LIMIT_HEADERS) {
      expect(header.schema.safeParse('42').success).toBe(true);
      expect(header.schema.safeParse('not-a-number').success).toBe(false);
    }
    expect(V1_REQUEST_ID_HEADER.schema.safeParse('req-1').success).toBe(true);
  });
});

describe('the v1 security scheme', () => {
  it('is the bearer PAT and nothing else', () => {
    expect(V1_SECURITY_SCHEME_NAME).toBe('bearerPat');
    expect(v1SecurityScheme.type).toBe('http');
    expect(v1SecurityScheme.scheme).toBe('bearer');
    expect(v1SecurityScheme.bearerFormat).toContain('motir_pat_');
  });

  it('describes EVERY token scope — the totality guard, at runtime', () => {
    for (const scope of TOKEN_SCOPES) {
      expect(V1_SCOPE_DESCRIPTIONS[scope], `scope "${scope}" has no description`).toBeTruthy();
    }
    expect(Object.keys(V1_SCOPE_DESCRIPTIONS).length).toBe(TOKEN_SCOPES.length);
  });

  it('has no description for a scope the vocabulary does not define', () => {
    for (const described of Object.keys(V1_SCOPE_DESCRIPTIONS)) {
      expect(isTokenScope(described), `stale scope "${described}"`).toBe(true);
    }
  });

  it('exposes every scope EXCEPT the irreversible delete', () => {
    expect(V1_UNEXPOSED_SCOPES).toEqual(['work_items:delete']);
    expect(V1_EXPOSED_SCOPES).not.toContain('work_items:delete');
    expect(V1_EXPOSED_SCOPES.length + V1_UNEXPOSED_SCOPES.length).toBe(TOKEN_SCOPES.length);
  });

  it('names the extension an operation carries its scope on', () => {
    expect(V1_SCOPE_EXTENSION.startsWith('x-')).toBe(true);
  });
});
