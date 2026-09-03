import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripSourceComments } from '../../helpers/stripSourceComments';

// MOTIR-4036 — THE PUBLIC-PROJECTS CAPABILITY IS GATED IN TOTAL, and the surface
// it is total over is READ FROM THE TREE rather than remembered.
//
// `cloud-gate.test.ts` beside this one CALLS every handler in both arms. That is
// the behaviour, and it is checked against a table — a table this file compares
// to the filesystem, but still a table, and a table can only ever be as complete
// as the last person to edit it. The failure this file exists for is one nobody
// edits anything for: a route or an affordance added in six months that simply
// never learns the gate exists. The story's own acceptance criterion asks for it
// in those words — *"a test enumerates that surface from the filesystem so a
// route added later cannot escape the gate by being forgotten"* — and the idiom
// is `tests/navigation/proxy-matcher.test.ts`'s and `tests/seo/robots.test.ts`'s:
// a rule with no guard is a comment.
//
// ⚠️ AND THE STORY BODY IS THE FIXTURE FOR WHY. It says the surface is "10
// anonymous routes"; `git ls-tree origin/main app/api/public/` returns ELEVEN
// files and TWELVE handlers. The count was right when it was written on
// 2026-08-29 and `app/api/public/p/[identifier]/route.ts` landed on 2026-08-30.
// Nothing was wrong except that a number was written down.
//
// ── The bound, declared (the `contract-coverage.test.ts` convention) ────────
// A directory walk of `app/api/public` — eleven files — plus ONE `git grep -l`
// over the index for the build-in-public component names. Both are milliseconds
// and neither parses; this belongs in the ordinary sharded run rather than the
// structural-guard lane, which draws its line at whole-tree ANSWERS.

const REPO_ROOT = process.cwd();
const PUBLIC_ROOT = join(REPO_ROOT, 'app', 'api', 'public');
/**
 * ⚠️ THE SECOND ROOT (MOTIR-4114). `app/api/public-requests/*` acts on public
 * requests and is therefore part of the same CAPABILITY, but it sits in a
 * namespace that predates the public contract — so this walk did not reach it,
 * and a self-hosted build answered its two write routes for the whole window.
 *
 * `public-surface-hosts.md` AMENDMENT 4 §F decides that they STAY there — after
 * AMENDMENT 4 nothing on `motir.co` calls them, so they are application routes
 * rather than entries in the public read contract — and that they carry the
 * gate. Adding the root here is what makes the second half of that decision a
 * guard rather than a sentence: the whole point of this file is that a rule
 * living only in a comment is not one.
 *
 * They are deliberately NOT added to `contract-coverage.test.ts`: they are not
 * in the public document, and they should not be.
 */
const PUBLIC_REQUESTS_ROOT = join(REPO_ROOT, 'app', 'api', 'public-requests');
const PUBLIC_CONTRACT_ROUTE = 'app/api/openapi/public.json/route.ts';
/**
 * The static PRODUCT-DESCRIPTION documents that stay served off-cloud, and the
 * card that decided each. `public.json` is MOTIR-4042's disposition; the MCP
 * tool catalogue (MOTIR-4194) follows it rather than inventing a second policy
 * for an adjacent route — both describe the software every build ships, neither
 * publishes a project, and both are `force-static`, so a gate in the handler
 * would read the BUILDER's flag rather than the deployment's.
 */
const STATIC_PRODUCT_DOCUMENTS: ReadonlyArray<[route: string, decidedBy: string]> = [
  [PUBLIC_CONTRACT_ROUTE, 'MOTIR-4042'],
  ['app/api/docs/mcp-tools.json/route.ts', 'MOTIR-4194'],
];

/** The gate's call, as a route source has to spell it. */
const GATE_CALL = 'publicSurfaceUnavailable()';

/** Every `route.ts` under a root, repo-relative. */
function walkRoutes(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkRoutes(full, out);
    else if (entry === 'route.ts') out.push(relative(REPO_ROOT, full).split(sep).join('/'));
  }
  return out;
}

/** Every route file of the public-projects CAPABILITY, across both its roots. */
function routeFiles(): string[] {
  return [...walkRoutes(PUBLIC_ROOT), ...walkRoutes(PUBLIC_REQUESTS_ROOT)];
}

interface Handler {
  file: string;
  method: string;
  /** The handler's body, from its opening brace to the end of the file. */
  body: string;
}

/**
 * Every exported verb under `app/api/public`, with the code that follows it.
 *
 * The same `export (async )?function VERB` shape `contract-coverage.test.ts`
 * reads, deliberately — a wrapper form (`export const GET = withGate(...)`)
 * would be invisible to BOTH, and the two agreeing is what makes either
 * trustworthy.
 */
function handlers(): Handler[] {
  const found: Handler[] = [];
  for (const file of routeFiles()) {
    const source = stripSourceComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
    const pattern = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
    for (const match of source.matchAll(pattern)) {
      const method = match[1];
      if (method !== undefined) {
        found.push({ method, file, body: source.slice(match.index ?? 0) });
      }
    }
  }
  return found;
}

/**
 * The first executable statement of a handler body, as text.
 *
 * ⚠️ It finds the brace that opens the BODY, not the first brace in the string:
 * every one of these handlers destructures in its parameter list
 * (`{ params }: { params: Promise<…> }`), so `indexOf('{')` lands inside the
 * signature and reports the signature as the first statement — for ten of the
 * twelve, which reads as a real failure and is a broken reader.
 */
function firstStatement(body: string): string {
  const signature = /^export\s+(?:async\s+)?function\s+\w+\s*\([\s\S]*?\)\s*(?::\s*[^{]*?)?\{/.exec(
    body,
  );
  const open = signature === null ? body.indexOf('{') : signature[0].length - 1;
  return body
    .slice(open + 1)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 1)
    .join(' ');
}

describe('every route on the public surface carries the gate', () => {
  it.each(STATIC_PRODUCT_DOCUMENTS)(
    'deliberately leaves the static product document %s available off-cloud (%s)',
    (route) => {
      // These routes are OUTSIDE PUBLIC_ROOT and therefore outside the derived
      // population below. Pin each exclusion here so that it is a reviewed
      // product decision, not a path the filesystem walk happened not to see.
      const source = stripSourceComments(readFileSync(join(REPO_ROOT, route), 'utf8'));

      expect(source).toContain("export const dynamic = 'force-static'");
      expect(source).not.toContain("from '@/lib/publicProjects/cloudGate'");
      expect(source).not.toContain(GATE_CALL);
    },
  );

  it('finds routes at all — a walk that returned nothing would pass everything below', () => {
    // The vacuous-pass trap of any discovery-based check, asserted first.
    expect(routeFiles().length).toBeGreaterThanOrEqual(8);
    expect(handlers().length).toBeGreaterThanOrEqual(10);
  });

  it('EVERY exported handler calls the gate', () => {
    const ungated = handlers()
      .filter((h) => !h.body.includes(GATE_CALL))
      .map((h) => `${h.method} ${h.file}`);
    expect(
      ungated,
      `public handlers with no cloud gate: ${ungated.join(', ')} — call ` +
        '`publicSurfaceUnavailable()` first, or this route serves a capability ' +
        'a self-hosted build does not have',
    ).toEqual([]);
  });

  it('…as its FIRST statement, before the rate limit and the session read', () => {
    // Not decoration. A gate placed after the rate-limit guard spends a per-IP
    // budget for a capability that does not exist; placed after the session
    // read, a route that answers 401 first tells an anonymous caller it is
    // there. Both are still "gated", and both are wrong.
    const misplaced = handlers()
      .filter((h) => !firstStatement(h.body).includes(GATE_CALL))
      .map((h) => `${h.method} ${h.file} starts with: ${firstStatement(h.body)}`);
    expect(misplaced, misplaced.join('; ')).toEqual([]);
  });

  it('the predicate can FAIL — the counterfactual, run rather than asserted in prose', () => {
    // A check whose detector is broken passes everything, and looks identical
    // from here. So it is driven over a route that does not have the gate.
    const ungated = `
      export async function GET(req: Request): Promise<Response> {
        const limited = await enforcePublicWriteRateLimit(req);
        return NextResponse.json({});
      }`;
    const late = `
      export async function GET(req: Request): Promise<Response> {
        const limited = await enforcePublicWriteRateLimit(req);
        const absent = publicSurfaceUnavailable();
        if (absent) return absent;
      }`;
    expect(ungated.includes(GATE_CALL)).toBe(false);
    expect(late.includes(GATE_CALL)).toBe(true);
    expect(firstStatement(late).includes(GATE_CALL)).toBe(false);
  });
});

// ── THE PUBLISH PATH ────────────────────────────────────────────────────────
//
// The other half of the capability, and it is not a route tree — so it is not
// enumerated the same way. What CAN be enumerated is its two chokepoints: the
// one write that can set `accessLevel = 'public'`, and every render site of the
// go-public components. An affordance added later fails one of the two.

const AUTHED = 'app/(authed)';

/** Repo-relative files whose CODE matches `pattern`, via one indexed git grep. */
function filesMatching(pattern: string, ...paths: string[]): string[] {
  try {
    return execFileSync('git', ['grep', '-l', '-F', '-e', pattern, '--', ...paths], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .sort();
  } catch {
    // `git grep` exits 1 for no match, which is an ANSWER, not a failure.
    return [];
  }
}

describe('the publish path cannot be reached without the gate', () => {
  it('exactly ONE service method writes the public access level, and it is gated', () => {
    // The repository write is the narrow waist: everything that can publish a
    // project goes through it. A second caller added later lands here.
    const writers = filesMatching('projectRepository.setAccessLevel(', 'app', 'lib');
    expect(writers).toEqual(['lib/services/projectMembersService.ts']);

    const service = stripSourceComments(
      readFileSync(join(REPO_ROOT, 'lib/services/projectMembersService.ts'), 'utf8'),
    );
    expect(service).toContain("level === 'public' && !isCloud()");
    expect(service).toContain('PublicAccessUnavailableError');
  });

  it('every importer of a go-public component is a DECLARED, gated render site', () => {
    // The components are client islands and cannot read `MOTIR_CLOUD`, so the
    // gate lives at the SERVER site that renders them — which is not always the
    // importing file: `BuildInPublicPromoCard` imports the hook and is itself
    // rendered behind the gate one level up. Where the gate SITS is a judgement,
    // so it is declared; WHO imports one is not, so it is derived and the two
    // are compared BOTH ways. A new importer fails here until somebody says
    // where its gate is.
    const gatedIn: Readonly<Record<string, readonly [file: string, gate: string]>> = {
      [`${AUTHED}/layout.tsx`]: [`${AUTHED}/layout.tsx`, 'publicProjectsAvailable = isCloud()'],
      // TopNav renders the slot from two booleans the layout computes; both are
      // false off-cloud, so the slot is simply empty.
      [`${AUTHED}/_components/TopNav.tsx`]: [
        `${AUTHED}/layout.tsx`,
        'publicProjectsAvailable && canManage',
      ],
      [`${AUTHED}/settings/project/_components/BuildInPublicPromoCard.tsx`]: [
        `${AUTHED}/settings/project/page.tsx`,
        'isCloud() && caps.canManage',
      ],
    };

    const importers = filesMatching('build-in-public/', 'app').filter(
      (file) => !file.startsWith(`${AUTHED}/_components/build-in-public/`),
    );
    expect(importers.length).toBeGreaterThanOrEqual(3);
    expect(importers, 'a go-public component is rendered from an undeclared site').toEqual(
      Object.keys(gatedIn).sort(),
    );

    const ungated = Object.entries(gatedIn).filter(([, [file, gate]]) => {
      const source = stripSourceComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
      return !source.includes(gate);
    });
    expect(
      ungated.map(([importer, [file]]) => `${importer} (gate claimed in ${file})`),
      'a declared gate is no longer in the file that claims it',
    ).toEqual([]);
  });

  it('the selector offers the level from a gated set, not from the constant', () => {
    const selector = stripSourceComments(
      readFileSync(
        join(
          REPO_ROOT,
          `${AUTHED}/settings/project/members/_components/ProjectMembersSettings.tsx`,
        ),
        'utf8',
      ),
    );
    // Rendering straight from ACCESS_LEVELS is exactly the regression this
    // guards: it puts `public` back on the control on every build.
    expect(selector).not.toContain('ACCESS_LEVELS.map(');
    expect(selector).toContain('offeredLevels.map(');
    expect(selector).toContain('publicAccessAvailable');
  });
});
