import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The `/api/v1` route-tree analyser (Story 11.1 · Subtask 11.1.5 —
// MOTIR-1861). Source-level guards for the properties a coverage percentage
// cannot see: that a route stays a thin adapter, that it goes through the
// shared wrapper, and that it declares a scope.
//
// It lives in a helper rather than inline in one test because the guards must
// be run against TWO inputs: the real route tree (does the product hold?) and
// a deliberately-violating synthetic source (does the guard actually catch
// it?). A guard that has never been shown to fail is not a guard.
//
// Written to keep holding for routes Stories 11.2 / 11.3 add later — it walks
// the tree, so a new route is audited the moment it exists, with no list to
// update.

/** Every HTTP verb Next.js will route to a handler export. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

export interface RouteViolation {
  /** Repo-relative path of the offending file. */
  file: string;
  /** A stable identifier for the rule that was broken. */
  rule:
    | 'prisma-in-route'
    | 'transaction-in-route'
    | 'bypasses-wrapper'
    | 'no-scope-declared'
    // ── Added by Story 11.2 · Subtask 11.2.11 (MOTIR-2053) ──────────────────
    | 'imports-mcp-tools'
    | 'reaches-cascade-delete'
    | 'declares-delete-scope';
  detail: string;
}

/** Every `route.ts` under `app/api/v1`, repo-relative. */
export function v1RouteFiles(repoRoot: string): string[] {
  const root = join(repoRoot, 'app', 'api', 'v1');
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === 'route.ts' || entry === 'route.tsx') found.push(full);
    }
  };
  walk(root);
  return found.map((f) => relative(repoRoot, f)).sort();
}

/**
 * Audit ONE route source. Returns every rule it breaks (empty = clean).
 *
 * Deliberately source-level rather than runtime: the 4-layer contract is a
 * property of how the file is WRITTEN, and a runtime check would only catch a
 * violation on a code path a test happened to exercise.
 */
export function auditV1RouteSource(file: string, source: string): RouteViolation[] {
  const violations: RouteViolation[] = [];
  const code = stripCommentsAndStrings(source);

  // ── The 4-layer contract: a route is a thin adapter ──────────────────────
  if (/\bdb\s*\./.test(code) || /@\/lib\/db/.test(source)) {
    violations.push({
      file,
      rule: 'prisma-in-route',
      detail: 'a v1 route reaches for the Prisma client; the missing piece is a service method',
    });
  }
  if (/\$transaction\s*\(/.test(code)) {
    violations.push({
      file,
      rule: 'transaction-in-route',
      detail: 'a v1 route opens a transaction; transactions belong to the service layer',
    });
  }

  // ── Every handler export goes through the shared wrapper ─────────────────
  // The wrapper is where auth, the scope gate, the error envelope, the request
  // id and the rate limiter live, so a route that hand-rolls an export escapes
  // ALL of them at once.
  for (const method of HTTP_METHODS) {
    const declaresFunction = new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`).test(
      code,
    );
    const declaresConst = new RegExp(`export\\s+const\\s+${method}\\s*=`).test(code);
    if (!declaresFunction && !declaresConst) continue;

    const throughWrapper = new RegExp(
      `export\\s+const\\s+${method}\\s*=\\s*withV1Route\\s*[<(]`,
    ).test(code);
    if (!throughWrapper) {
      violations.push({
        file,
        rule: 'bypasses-wrapper',
        detail: `${method} is exported without withV1Route`,
      });
    }
  }

  // ── The two surfaces align through SCHEMAS, never through IMPORTS ────────
  // A public route reaching into `lib/mcp/tools/**` couples a STABLE contract to
  // a deliberately fluid one, and it is the direction the epic explicitly
  // rejects: MCP tools are not re-pointed at HTTP, and HTTP does not reach into
  // MCP. (Story 11.6 pins the alignment through the response schemas instead.)
  if (/from\s+['"]@\/lib\/mcp\/tools\//.test(source)) {
    violations.push({
      file,
      rule: 'imports-mcp-tools',
      detail: 'a v1 route imports from lib/mcp/tools — the two surfaces align through schemas',
    });
  }

  // ── The irreversible cascade delete stays UNREACHABLE ────────────────────
  // ADR §3 leaves it out of v1's first cut, and its own condition for doing so
  // is that the omission be asserted — otherwise it can be undone by a single
  // later edit that nobody reads as a contract change.
  if (/\bdeleteWorkItem\s*\(/.test(code)) {
    violations.push({
      file,
      rule: 'reaches-cascade-delete',
      detail: 'a v1 route reaches deleteWorkItem — the irreversible subtree delete is not exposed',
    });
  }
  if (/scope\s*:\s*['"]work_items:delete['"]/.test(source)) {
    violations.push({
      file,
      rule: 'declares-delete-scope',
      detail: 'a v1 route declares work_items:delete, a scope v1 does not expose',
    });
  }

  // ── Every route DECLARES its required scope ──────────────────────────────
  const wrapperCalls = code.match(/withV1Route\s*[<(]/g)?.length ?? 0;
  const scopeDeclarations = source.match(/scope\s*:\s*['"][a-z_:]+['"]/g)?.length ?? 0;
  if (wrapperCalls > 0 && scopeDeclarations < wrapperCalls) {
    violations.push({
      file,
      rule: 'no-scope-declared',
      detail: `${wrapperCalls} wrapper call(s) but only ${scopeDeclarations} scope declaration(s)`,
    });
  }

  return violations;
}

/** Every scope literal a route declares, in source order. */
export function declaredScopes(source: string): string[] {
  return (source.match(/scope\s*:\s*['"]([a-z_:]+)['"]/g) ?? []).map((m) =>
    m.replace(/.*['"]([a-z_:]+)['"].*/, '$1'),
  );
}

/**
 * The scope each exported VERB declares, keyed by method (Subtask 11.2.11).
 *
 * Per-verb rather than per-file, because the ADR's §3 map is per OPERATION: one
 * module legitimately exports a `read` GET beside a `work_items:write` POST, and
 * a file-level check cannot tell a correct pairing from a wrong one.
 *
 * A verb whose scope cannot be read maps to `undefined` rather than being
 * dropped, so the caller can FAIL on it — silently skipping an unparseable route
 * is a hole in a guard that still reads as coverage.
 */
export function declaredScopeByMethod(source: string): Map<string, string | undefined> {
  const found = new Map<string, string | undefined>();
  for (const method of HTTP_METHODS) {
    const declaration = new RegExp(
      `export\\s+const\\s+${method}\\s*=\\s*withV1Route\\s*(?:<[^>]*>)?\\s*\\(\\s*\\{[^}]*?scope\\s*:\\s*['"]([a-z_:]+)['"]`,
    ).exec(source);
    if (declaration) {
      found.set(method, declaration[1]);
      continue;
    }
    // Exported but unreadable — record it as present-with-unknown-scope.
    if (new RegExp(`export\\s+const\\s+${method}\\s*=`).test(source)) {
      found.set(method, undefined);
    }
  }
  return found;
}

/** Read a route file's source, repo-relative. */
export function readRouteSource(repoRoot: string, file: string): string {
  return readFileSync(join(repoRoot, file), 'utf8');
}

/**
 * A route handler as Next.js calls it: the request, plus the resolved dynamic
 * params for a parameterised segment. The second argument is OPTIONAL because a
 * static route ignores it — but it must be in the TYPE, or a sweep over the tree
 * cannot drive `app/api/v1/work-items/[key]/route.ts` at all (Story 11.2).
 */
export type V1RouteHandler = (
  req: Request,
  args?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

/** The App-Router handler exports a route module can carry. */
export interface V1RouteModule {
  GET?: V1RouteHandler;
  POST?: V1RouteHandler;
  PUT?: V1RouteHandler;
  PATCH?: V1RouteHandler;
  DELETE?: V1RouteHandler;
}

/**
 * Every v1 route module, keyed by the PATHNAME Next.js serves it from
 * (`app/api/v1/me/route.ts` → `/api/v1/me`).
 *
 * Uses `import.meta.glob` rather than a templated `import()`: the glob is
 * statically analysable, so the module graph is known at build time (a
 * variable specifier is not, and Vite warns that it cannot resolve one). It
 * still DISCOVERS the tree, so a route added by Stories 11.2 / 11.3 is picked
 * up with no list to maintain.
 */
export async function loadV1RouteModules(): Promise<Map<string, V1RouteModule>> {
  // ⚠️ `import.meta.glob(...)` must be written out IN FULL: it is a build-time
  // transform on the literal call expression, not a runtime function, so
  // aliasing it throws "statically replaced during file transformation".
  // (Typed by `tests/vite-env.d.ts`.)
  const loaders = import.meta.glob('../../app/api/v1/**/route.ts');
  const modules = new Map<string, V1RouteModule>();
  for (const [key, load] of Object.entries(loaders)) {
    const pathname = key.replace(/^.*\/app\//, '/').replace(/\/route\.tsx?$/, '');
    modules.set(pathname, (await load()) as V1RouteModule);
  }
  return modules;
}

/**
 * Blank out comments and string literals so a rule cannot fire on prose.
 * (Without this, the file-header comment explaining "no `db.*` in a route"
 * would itself trip the `db.` guard — a guard that flags its own
 * documentation teaches people to delete the documentation.)
 */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}
