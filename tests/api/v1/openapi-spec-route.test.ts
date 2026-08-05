import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';
import { auditV1RouteSource, stripComments, v1RouteFiles } from '../../helpers/v1RouteAudit';

// GET /api/openapi/v1.json — the served specification
// (Story 11.4 · Subtask 11.4.4 — MOTIR-2185).
//
// ADR Amendment 4 Q3 put this route OUTSIDE `app/api/v1` rather than inside it
// with a named exemption in the route audit. That decision has two obligations
// this suite discharges:
//
//   1. Prove the guard needed NO exemption — i.e. that the audit's file set
//      genuinely does not contain this route, so the shipped rule keeps its
//      unconditional form. A "we didn't have to weaken it" claim is worth
//      exactly as much as the assertion behind it.
//   2. Prove the four properties that make an UNAUTHENTICATED handler safe here
//      — it authenticates nothing, reads no database, takes no user input and
//      spends no rate-limit budget — against the file's SOURCE, not against the
//      comment in it.

const REPO_ROOT = process.cwd();
const SPEC_ROUTE = join('app', 'api', 'openapi', 'v1.json', 'route.ts');
const SPEC_URL = 'http://localhost:3000/api/openapi/v1.json';

function specRouteSource(): string {
  return readFileSync(join(REPO_ROOT, SPEC_ROUTE), 'utf8');
}

describe('the spec route needs no exemption from the v1 route audit', () => {
  it('is NOT among the files the audit walks', () => {
    // `v1RouteFiles` is rooted at `app/api/v1`; this route lives beside that
    // tree, not in it. That is the whole reason the guard did not have to be
    // widened.
    expect(v1RouteFiles(REPO_ROOT)).not.toContain(SPEC_ROUTE);
  });

  it('leaves the audit’s rules unconditional — every real v1 route still passes', () => {
    for (const file of v1RouteFiles(REPO_ROOT)) {
      const violations = auditV1RouteSource(file, readFileSync(join(REPO_ROOT, file), 'utf8'));
      expect(violations, `${file}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });

  it('WOULD have been flagged had it been placed inside the v1 tree', () => {
    // The counterfactual, run rather than asserted in prose: this is what the
    // rejected placement would have cost, and it is why the exemption would have
    // been a hole rather than a formality.
    const violations = auditV1RouteSource('app/api/v1/openapi.json/route.ts', specRouteSource());
    expect(violations.map((v) => v.rule)).toContain('bypasses-wrapper');
  });
});

describe('the spec route is safe to serve unauthenticated', () => {
  // Comments STRIPPED, for the reason `auditV1RouteSource` strips them too:
  // this file's header explains the decision by naming `withV1Route` and the
  // request API it deliberately does not use, and a check that fired on its own
  // documentation would teach the next author to delete the documentation.
  const source = stripComments(specRouteSource());

  it('authenticates nothing — it does not compose the v1 wrapper or the bearer gate', () => {
    expect(source).not.toMatch(/withV1Route/);
    expect(source).not.toMatch(/authenticateApiToken|getSession|presentedBearerToken/);
  });

  it('reads no database', () => {
    expect(source).not.toMatch(/@\/lib\/db|\bdb\s*\.|\$transaction|Repository|Service\b/);
  });

  it('takes NO user input — the handler has no request parameter at all', () => {
    // The strongest form of "no user input": there is nothing to read it from.
    // A handler that accepted a `Request` could grow a query parameter later
    // without anything failing.
    expect(source).toMatch(/export async function GET\(\)/);
    expect(source).not.toMatch(/searchParams|req\.|request\./);
  });

  it('spends no rate-limit budget', () => {
    expect(source).not.toMatch(/consumeRateLimit|rateLimitHeaders/);
  });
});

describe('GET /api/openapi/v1.json', () => {
  it('serves a valid OpenAPI 3.1 document to a caller with NO Authorization header', async () => {
    const { GET } = await import('@/app/api/openapi/v1.json/route');
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const document: unknown = await res.json();
    const result = await new Validator().validate(document as Record<string, unknown>);
    expect(result.errors ?? [], JSON.stringify(result.errors)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('is cacheable, because it changes only when the code does', async () => {
    const { GET } = await import('@/app/api/openapi/v1.json/route');
    const res = await GET();
    expect(res.headers.get('cache-control')).toMatch(/public/);
    expect(res.headers.get('cache-control')).toMatch(/must-revalidate/);
  });

  it('serves the same bytes on every request — a generator can cache it', async () => {
    const { GET } = await import('@/app/api/openapi/v1.json/route');
    const [first, second] = await Promise.all([GET(), GET()]);
    expect(await first.text()).toBe(await second.text());
  });

  it('is reachable at the URL the ADR pins, and nowhere else', () => {
    // The path is public API under §8: it may gain a `v2` sibling, but it never
    // moves. The route file's location IS the URL, so asserting the file is
    // asserting the address.
    expect(new URL(SPEC_URL).pathname).toBe('/api/openapi/v1.json');
    expect(() => readFileSync(join(REPO_ROOT, SPEC_ROUTE), 'utf8')).not.toThrow();
  });
});
