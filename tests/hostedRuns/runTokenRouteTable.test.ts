import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FOLDER_OPERATIONS } from '@/lib/api/v1/folders/operations';
import { PLANNING_OPERATIONS } from '@/lib/api/v1/planning/operations';
import { WORK_ITEM_OPERATIONS } from '@/lib/api/v1/workItems/operations';
import { WORK_LOOP_OPERATIONS } from '@/lib/api/v1/workLoop/operations';
import { RUN_TOKEN_DENIED_CLI_OPERATIONS, RUN_TOKEN_ROUTES } from '@/lib/hostedRuns/runTokenRoutes';

// THE RUN-TOKEN TABLE IS THE ONE LIST, pinned three ways (MOTIR-6557):
//
//   1. against the `/api/v1` operation registry — every entry names a real
//      operation at its real method and path;
//   2. against the ROUTE TREE, both directions — every entry's route opts in
//      (`acceptsRunToken: true`) and no route outside the table does;
//   3. against the CLI — the operations the CLI client calls on a `motir run`
//      path are exactly the table's CLI entries plus the named denials. A new
//      call the CLI makes on those paths fails here until someone decides
//      whether a run token may make it.

const ROOT = join(__dirname, '..', '..');
const V1 = join(ROOT, 'app', 'api', 'v1');

const OPERATIONS = [
  ...WORK_ITEM_OPERATIONS,
  ...PLANNING_OPERATIONS,
  ...WORK_LOOP_OPERATIONS,
  ...FOLDER_OPERATIONS,
];

/** `/api/v1/work-items/{key}/claim` → `app/api/v1/work-items/[key]/claim/route.ts`. */
function routeFileOf(path: string): string {
  return join(ROOT, 'app', path.replace(/^\//, '').replace(/\{(\w+)\}/g, '[$1]'), 'route.ts');
}

/** The methods a route file's `withV1Route` exports admit a run token on. */
function optedInMethods(file: string): Set<string> {
  const src = readFileSync(file, 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(
    /export const (GET|POST|PATCH|PUT|DELETE) = withV1Route(?:<[^>]*>)?\(\s*\{([^}]*)\}/g,
  )) {
    if (/acceptsRunToken:\s*true/.test(m[2]!)) out.add(m[1]!);
  }
  return out;
}

function walkRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkRouteFiles(full));
    else if (name === 'route.ts') out.push(full);
  }
  return out;
}

/** `app/api/v1/work-items/[key]/route.ts` → `/api/v1/work-items/{key}`. */
function pathOf(file: string): string {
  const rel = relative(join(ROOT, 'app'), file).replace(/\/route\.ts$/, '');
  return `/${rel.replace(/\[(\w+)\]/g, '{$1}')}`;
}

describe('the run-token route table (MOTIR-6557)', () => {
  it('names real operations at their real method and path', () => {
    for (const route of RUN_TOKEN_ROUTES) {
      if (route.operationId === null) continue;
      const op = OPERATIONS.find((o) => o.operationId === route.operationId);
      expect(op, route.operationId).toBeDefined();
      expect(`${op!.method} ${op!.path}`, route.operationId).toBe(`${route.method} ${route.path}`);
    }
  });

  it('every entry’s route opts in; a PENDING entry’s route does not exist yet', () => {
    for (const route of RUN_TOKEN_ROUTES) {
      const file = routeFileOf(route.path);
      if (route.pendingCard) {
        // Built by its card, which must drop `pendingCard` when it lands.
        expect(existsSync(file), `${route.path} exists — remove pendingCard`).toBe(false);
        continue;
      }
      expect(optedInMethods(file).has(route.method), `${route.method} ${route.path}`).toBe(true);
    }
  });

  it('no route outside the table admits a run token', () => {
    const table = new Set(RUN_TOKEN_ROUTES.map((r) => `${r.method} ${r.path}`));
    const opted: string[] = [];
    for (const file of walkRouteFiles(V1)) {
      for (const method of optedInMethods(file)) opted.push(`${method} ${pathOf(file)}`);
    }
    expect(opted.filter((r) => !table.has(r))).toEqual([]);
    expect(opted.length).toBe(RUN_TOKEN_ROUTES.filter((r) => !r.pendingCard).length);
  });

  it('holds no operation twice, and every binding is one the services enforce', () => {
    const keys = RUN_TOKEN_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of RUN_TOKEN_ROUTES) {
      expect(['own_run', 'run_cards', 'run_scope_claim', 'project', 'self']).toContain(r.binding);
      if (r.path.includes('{id}')) expect(r.binding, r.path).toBe('own_run');
      if (r.path.includes('{key}')) expect(r.binding, r.path).toBe('run_cards');
    }
  });
});

// ── 3. The CLI's calls ──────────────────────────────────────────────────────

const CLI_SRC = join(ROOT, 'packages', 'cli', 'src');

/**
 * The CLI files a `motir run` (leaf or scope) executes, whose client calls a
 * hosted run makes. `commands/auto.ts` is in because the scope drain runs its
 * `dispatchOne`, `RepoSessions` and `ensureRepoPullRequest`; the `motir auto`
 * -only calls it also makes are the named denials.
 */
const RUN_PATH_FILES = [
  'commands/dispatch.ts',
  'commands/scope.ts',
  'commands/scopeDrain.ts',
  'commands/auto.ts',
  'dispatch.ts',
  'dispatchLeg.ts',
  'dispatchRunReporter.ts',
  'closeOutHowToTest.ts',
  'ciWatch.ts',
  'session.ts',
];

/** Client method → the operations it calls, following `this.<method>` hops. */
function clientOperationsByMethod(): Map<string, Set<string>> {
  const src = readFileSync(join(CLI_SRC, 'client.ts'), 'utf8');
  const heads = [...src.matchAll(/\n {2}(?:private )?(?:async )?\*?(\w+)(?:<[^>]*>)?\(/g)];
  const direct = new Map<string, { ops: Set<string>; calls: Set<string> }>();
  heads.forEach((h, i) => {
    const body = src.slice(h.index!, heads[i + 1]?.index ?? src.length);
    direct.set(h[1]!, {
      ops: new Set([...body.matchAll(/request\(\s*'(\w+)'/g)].map((m) => m[1]!)),
      calls: new Set([...body.matchAll(/this\.(\w+)\(/g)].map((m) => m[1]!)),
    });
  });
  const resolved = new Map<string, Set<string>>();
  const resolve = (name: string, seen: Set<string>): Set<string> => {
    const entry = direct.get(name);
    if (!entry || seen.has(name)) return new Set();
    seen.add(name);
    const ops = new Set(entry.ops);
    for (const c of entry.calls) for (const op of resolve(c, seen)) ops.add(op);
    return ops;
  };
  for (const name of direct.keys()) resolved.set(name, resolve(name, new Set()));
  return resolved;
}

describe('the run-token table matches what `motir run` calls (MOTIR-6557 AC2)', () => {
  const byMethod = clientOperationsByMethod();
  const called = new Set<string>();
  for (const file of RUN_PATH_FILES) {
    const src = readFileSync(join(CLI_SRC, file), 'utf8');
    for (const m of src.matchAll(/\bclient\.(\w+)\(/g)) {
      for (const op of byMethod.get(m[1]!) ?? []) called.add(op);
    }
  }

  it('the run paths reach the client at all (the scan is not vacuous)', () => {
    expect(called.size).toBeGreaterThan(10);
  });

  it('every operation the run paths call is in the table or a named denial', () => {
    const table = new Set(RUN_TOKEN_ROUTES.map((r) => r.operationId));
    const denied = new Set(Object.keys(RUN_TOKEN_DENIED_CLI_OPERATIONS));
    expect([...called].filter((op) => !table.has(op) && !denied.has(op)).sort()).toEqual([]);
  });

  it('every CLI entry of the table, and every denial, is still called — no stale rows', () => {
    const cliEntries = RUN_TOKEN_ROUTES.filter((r) => r.calledBy === 'cli').map(
      (r) => r.operationId!,
    );
    expect(cliEntries.filter((op) => !called.has(op))).toEqual([]);
    expect(Object.keys(RUN_TOKEN_DENIED_CLI_OPERATIONS).filter((op) => !called.has(op))).toEqual(
      [],
    );
  });
});
