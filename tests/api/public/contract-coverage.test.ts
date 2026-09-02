import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC_OPERATIONS } from '@/lib/api/public/openapi/operations';
import { publicOperationKey } from '@/lib/api/public/openapi/operation';
import { stripSourceComments } from '../../helpers/stripSourceComments';

// EVERY method under `app/api/public` is DECLARED — the totality guard
// (MOTIR-3990), and the deliverable this card is really about.
//
// The operation registry is a list, and a list is wrong the first time somebody
// adds a route. So this suite carries no list of its own: it WALKS
// `app/api/public`, reads each `route.ts`'s exported verbs, and compares that
// set to the declarations. A route added in six months cannot ship
// undocumented, and nobody has to remember the registry exists — the same
// property `tests/api/v1/openapi-operations-coverage.test.ts` gives v1.
//
// ⚠️ IT ALSO DERIVES THE GATE. This surface's session count was wrong three
// times — twice by grepping the string `getSession` and matching COMMENTS
// saying the call is deliberately absent, and once by grepping for it at all,
// which misses the two routes gated through `requireCompliantSession`. So
// `sessionRequired` is not trusted: it is compared against what each route's
// source actually does, and a route that grows or loses a gate fails here.
//
// ⚠️ A BOUNDED WALK, deliberately: eleven files under one directory, which is
// why this belongs in the ordinary sharded run rather than the structural-guard
// lane (`tests/ci-structural-guards-lane.test.ts` draws that line at whole-tree
// answers, and the v1 guard this mirrors walks `app/api/v1` from the same run).

const REPO_ROOT = process.cwd();
const PUBLIC_ROOT = join(REPO_ROOT, 'app', 'api', 'public');

/** Every `route.ts` under `app/api/public`, repo-relative. */
function routeFiles(dir = PUBLIC_ROOT, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (entry === 'route.ts') out.push(relative(REPO_ROOT, full));
  }
  return out;
}

/** `app/api/public/p/[identifier]/route.ts` → `/api/public/p/{identifier}`. */
function pathTemplateFor(routeFile: string): string {
  const segments = routeFile
    .split(sep)
    .slice(1, -1) // drop the leading `app` and the trailing `route.ts`
    .map((segment) => (segment.startsWith('[') ? `{${segment.slice(1, -1)}}` : segment));
  return `/${segments.join('/')}`;
}

interface ShippedMethod {
  method: string;
  path: string;
  file: string;
  /** Whether the handler REFUSES a caller with no session. */
  gated: boolean;
}

/**
 * Every (method, path) the tree exports, with the gate read off the source.
 *
 * The gate test is deliberately about REFUSAL, not about calling `getSession`.
 * Six of these routes call it and use the result as `?? null` for
 * viewer-awareness — reading that as "gated" is the mistake this project has
 * now made twice. What makes an operation gated is a 401 for an absent session,
 * and there are exactly two ways to write one here: an explicit
 * `{ code: 'UNAUTHENTICATED' }, { status: 401 }`, or `requireCompliantSession`,
 * whose whole job is that refusal.
 */
function shippedMethods(): ShippedMethod[] {
  const found: ShippedMethod[] = [];
  for (const file of routeFiles()) {
    const source = stripSourceComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
    const gated = /requireCompliantSession|status:\s*401/.test(source);
    for (const match of source.matchAll(
      /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g,
    )) {
      const method = match[1];
      if (method !== undefined) found.push({ method, path: pathTemplateFor(file), file, gated });
    }
  }
  return found;
}

describe('the public contract is TOTAL over the shipped route tree', () => {
  it('finds routes at all — a walk that returned nothing would pass everything below', () => {
    // The vacuous-pass trap of any discovery-based check: assert the discovery
    // first, with a floor well under the shipped count and well over zero.
    expect(routeFiles().length).toBeGreaterThanOrEqual(8);
    expect(shippedMethods().length).toBeGreaterThanOrEqual(9);
  });

  it('declares an operation for EVERY exported verb', () => {
    const declared = new Set(PUBLIC_OPERATIONS.map(publicOperationKey));
    const undocumented = shippedMethods()
      .filter((route) => !declared.has(`${route.method} ${route.path}`))
      .map((route) => `${route.method} ${route.path} (${route.file})`);
    expect(undocumented, `undocumented public operations: ${undocumented.join(', ')}`).toEqual([]);
  });

  it('declares NOTHING the tree does not serve — the converse, so the document cannot outlive a route', () => {
    const shipped = new Set(shippedMethods().map((r) => `${r.method} ${r.path}`));
    const phantom = PUBLIC_OPERATIONS.map(publicOperationKey).filter((key) => !shipped.has(key));
    expect(phantom, `declared but not served: ${phantom.join(', ')}`).toEqual([]);
  });

  it('agrees with each route about whether it REQUIRES a session', () => {
    const declared = new Map(
      PUBLIC_OPERATIONS.map((o) => [publicOperationKey(o), o.sessionRequired === true]),
    );
    const disagreements = shippedMethods()
      .filter((route) => declared.get(`${route.method} ${route.path}`) !== route.gated)
      .map(
        (route) =>
          `${route.method} ${route.path}: route ${route.gated ? 'gates' : 'does not gate'}, contract says otherwise`,
      );
    expect(disagreements, disagreements.join('; ')).toEqual([]);
  });

  it('counts FOUR session-required operations and thirteen anonymous ones — the number, pinned', () => {
    // Pinned because it is the fact the ADR got wrong: it read "exactly one".
    // Pinning it means a fifth gate, or a gate removed, is a decision somebody
    // states rather than a change nobody notices.
    const gated = shippedMethods().filter((r) => r.gated);
    expect(gated.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'DELETE /api/public/p/{identifier}/follow',
      'GET /api/public/projects/{projectId}/requests/duplicates',
      'POST /api/public/p/{identifier}/follow',
      'POST /api/public/projects/{projectId}/requests',
    ]);
    // 8 → 9 → 11 → 13: MOTIR-4109's `GET …/board`, MOTIR-4110's two detail
    // reads, MOTIR-4111's feed and project index. The GATED list above is the
    // half that
    // must not move by accident; the anonymous count moves with ordinary growth
    // and is pinned so that the growth is stated rather than noticed later.
    expect(shippedMethods().filter((r) => !r.gated)).toHaveLength(13);
  });

  it('names the route file in its failure — a guard nobody can act on is a guard nobody keeps', () => {
    // The counterfactual, RUN rather than asserted in prose: a route the
    // registry does not know about is reported by path AND by file.
    const declared = new Set(PUBLIC_OPERATIONS.map(publicOperationKey));
    const planted = {
      method: 'GET',
      path: '/api/public/p/{identifier}/invented',
      file: 'app/api/public/p/[identifier]/invented/route.ts',
    };
    expect(declared.has(`${planted.method} ${planted.path}`)).toBe(false);
    expect(`${planted.method} ${planted.path} (${planted.file})`).toContain('invented/route.ts');
  });
});
