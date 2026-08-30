import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';
import { stripComments, v1RouteFiles } from '../../helpers/v1RouteAudit';

// GET /api/openapi/public.json — the served public contract (MOTIR-3946).
//
// The obligations here are `openapi-spec-route.test.ts`'s, for the same route
// SHAPE and one surface further out:
//
//   1. The document is fetchable with NO credential at all. For `v1.json` that
//      is about a prospective integrator reading before signing up. Here it is
//      stronger: the surface it describes is itself anonymous, so a document
//      behind a login would describe a door it stands behind.
//   2. The four properties that make an unauthenticated handler safe —
//      authenticates nothing, reads no database, takes no user input, spends no
//      rate-limit budget — asserted against the file's SOURCE, not its comment.
//   3. It needs no exemption from the v1 route audit, because it is not in the
//      tree that audit walks.

const REPO_ROOT = process.cwd();
const SPEC_ROUTE = join('app', 'api', 'openapi', 'public.json', 'route.ts');

const source = stripComments(readFileSync(join(REPO_ROOT, SPEC_ROUTE), 'utf8'));

describe('the public spec route is safe to serve unauthenticated', () => {
  it('is NOT among the files the v1 route audit walks — so that guard keeps its unconditional form', () => {
    expect(v1RouteFiles(REPO_ROOT)).not.toContain(SPEC_ROUTE);
  });

  it('authenticates nothing', () => {
    expect(source).not.toMatch(/withV1Route/);
    expect(source).not.toMatch(/authenticateApiToken|getSession|presentedBearerToken/);
  });

  it('reads no database', () => {
    expect(source).not.toMatch(/@\/lib\/db|\bdb\s*\.|\$transaction|Repository|Service\b/);
  });

  it('takes NO user input — the handler has no request parameter at all', () => {
    expect(source).toMatch(/export async function GET\(\)/);
    expect(source).not.toMatch(/searchParams|req\.|request\./);
  });

  it('spends no rate-limit budget', () => {
    expect(source).not.toMatch(/consumeRateLimit|rateLimitHeaders/);
  });
});

describe('GET /api/openapi/public.json', () => {
  it('serves a valid OpenAPI 3.1 document to a caller with NO Authorization header', async () => {
    const { GET } = await import('@/app/api/openapi/public.json/route');
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const document: unknown = await res.json();
    const result = await new Validator().validate(document as Record<string, unknown>);
    expect(result.errors ?? [], JSON.stringify(result.errors)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('is cacheable, because it changes only when the code does', async () => {
    const { GET } = await import('@/app/api/openapi/public.json/route');
    const res = await GET();
    expect(res.headers.get('cache-control')).toMatch(/public/);
    expect(res.headers.get('cache-control')).toMatch(/must-revalidate/);
  });

  it('serves the same bytes on every request — a consumer can cache it', async () => {
    const { GET } = await import('@/app/api/openapi/public.json/route');
    const [first, second] = await Promise.all([GET(), GET()]);
    expect(await first.text()).toBe(await second.text());
  });

  it('is served at a path of its OWN, never inside the surface it documents', async () => {
    // `/api/public/*` is the described surface; a document served from inside it
    // would be an operation the document has to describe, and the totality guard
    // ([MOTIR-3990](motir:cmtfw4bqj007khvn8k40jalss)) would then demand a
    // declaration for the declaration.
    expect(SPEC_ROUTE.startsWith(join('app', 'api', 'public'))).toBe(false);
    const { GET } = await import('@/app/api/openapi/public.json/route');
    const document = (await (await GET()).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(document.paths)).not.toContain('/api/openapi/public.json');
  });
});
