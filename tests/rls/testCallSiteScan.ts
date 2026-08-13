import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { policyGatedModels } from './singletonReadScan';

// The TEST call-site classifier (MOTIR-2817).
//
// ── The class it exists to separate ─────────────────────────────────────────
// The twenty fixture batches (MOTIR-2735…2754) migrated `db.<model>.<op>(…)`
// sites in tests onto `adminDb`. A test that instead calls a REPOSITORY
// directly —
//
//   const counts = await workItemRepository.countByStatusCategory(pId, wsId);
//
// — carries no `db.` prefix anywhere on the line, so it was invisible to every
// pass of that sweep. `countByStatusCategory` is bindable (it takes an optional
// `tx`); the test passes none, so the read goes to the `@/lib/db` singleton, the
// policy sees no `app.workspace_id`, and it returns an EMPTY result while the
// rows exist. Nothing raises. A test asserting a value fails confusingly; a test
// asserting emptiness PASSES while checking nothing.
//
// ── Why the verdict cannot be read off the line ─────────────────────────────
// These four lines are indistinguishable in a diff and need four different
// treatments:
//
//   workItemRepository.countByStatusCategory(pId, wsId)  // IN SCOPE — bind it
//   githubIdentityRepository.findByUserId(userId)        // not gated — leave
//   rateLimitCounterRepository.countAllUnsafe()          // pre-auth  — leave
//   workItemRepository.findByIds(ids)                    // not bindable yet
//
// Nothing on the line says which. The verdict is a property of the METHOD being
// called — which model it addresses, and whether its signature accepts a `tx` —
// so it needs the repository's syntax tree, not a grep over the test's.
//
// ── Why an AST and not a regex, concretely ──────────────────────────────────
// A single-line regex for `tx?:` mis-classifies `countBacklog`, which declares
// its `tx?` parameter on its own line, as NOT bindable. That one error inflated
// the first measurement of this class by ~60 sites. `ts.SignatureDeclaration`'s
// `parameters` does not care how the signature is wrapped, so the classifier
// reads the structure and carries a test pinning that exact method.
//
// ── What it deliberately does NOT decide ────────────────────────────────────
// Whether an in-scope site's ASSERTION is right once bound. Binding a vacuous
// emptiness assertion may turn it RED, and that failure is a finding for the
// batch card to adjudicate — not something a scanner can rule on.

const REPO_DIR = 'lib/repositories';
const TESTS_DIR = 'tests';
const GUARD = 'tests/rls/singleton-read-guard.test.ts';
/**
 * The fixture root's stand-in for the guard. It cannot be named `*.test.ts`:
 * vitest's `include` globs every `.test.ts` under `tests/` with no `__fixtures__`
 * exclude, so a fixture under that name is COLLECTED as a real suite and fails
 * with "No test suite found". MOTIR-2784's fixture sidesteps this by containing
 * no test files at all; this one needs a VERDICTS map to parse, so it takes the
 * other exit — a name the collector ignores and this module falls back to.
 */
const GUARD_FIXTURE = 'tests/rls/singleton-read-guard.fixture.ts';

/** Client identifiers a repository method may address a model through. */
const CLIENTS = new Set(['db', 'tx', 'client', 'adminDb', 't']);

export type TestCallSiteVerdict =
  /** Gated, bindable today, and this call passes no `tx`. THE STORY'S WORK. */
  | 'in-scope'
  /** The method touches no policy-gated model — unbound is correct, LEAVE IT. */
  | 'not-gated'
  /** Adjudicated `pre-auth` by the MOTIR-2784 guard — deliberately actorless, LEAVE IT. */
  | 'pre-auth'
  /** Gated, but the method has no `tx` parameter to pass yet (MOTIR-2830). */
  | 'needs-binding-first'
  /** Gated, bindable, and this call already passes a `tx`. Nothing to do. */
  | 'already-bound';

export interface TestCallSite {
  /** repo-relative, e.g. `tests/publicProjects/publicProjectionStats.test.ts` */
  file: string;
  /** 1-based line of the call */
  line: number;
  /** e.g. `workItemRepository` */
  repository: string;
  /** e.g. `countByStatusCategory` */
  method: string;
  /** `file:line` — stable enough to pin, precise enough to find */
  key: string;
  /**
   * Does this call actually pass a `tx`? Recorded SEPARATELY from the verdict
   * because the do-not-touch guard needs it for sites whose verdict does NOT
   * change when they acquire one: a `not-gated` call given a `tx` is still
   * `not-gated`, so the verdict alone cannot tell you a batch touched it.
   */
  bound: boolean;
  verdict: TestCallSiteVerdict;
}

export interface RepositoryMethod {
  /** the repository FILE, e.g. `workItemRepository.ts` (the guard's key space) */
  file: string;
  /** does it address a policy-gated model, or raw SQL whose target is unknowable? */
  gated: boolean;
  /** 0-based index of the `tx` parameter, or null when the method has none */
  txIndex: number | null;
}

/** `<repositoryName>.<method>` → what the call site needs to know about it. */
export type RepositoryIndex = Map<string, RepositoryMethod>;

function sourceFile(full: string): ts.SourceFile {
  return ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
}

/** The models a method body addresses, through ANY client — `db`, `tx`, `client`. */
function addressedModels(body: ts.Node): { models: Set<string>; raw: boolean } {
  const models = new Set<string>();
  let raw = false;
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
      const head = n.expression.text;
      const name = n.name.text;
      if (CLIENTS.has(head)) {
        if (name.startsWith('$')) {
          if (name.startsWith('$queryRaw') || name.startsWith('$executeRaw')) raw = true;
        } else {
          models.add(name);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return { models, raw };
}

/** The 0-based index of a `tx` parameter. AST, so a wrapped signature is fine. */
function txParameterIndex(params: readonly ts.ParameterDeclaration[]): number | null {
  const i = params.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === 'tx');
  return i === -1 ? null : i;
}

/**
 * Parse `lib/repositories/*.ts` into the map the call sites are classified against.
 * A repository is an object literal of methods assigned to an exported const whose
 * name ends in `Repository` — the same shape `singletonReadScan` walks.
 */
export function repositoryIndex(root = process.cwd()): RepositoryIndex {
  const gatedModels = policyGatedModels(root);
  const dir = path.join(root, REPO_DIR);
  const index: RepositoryIndex = new Map();

  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()) {
    const sf = sourceFile(path.join(dir, file));

    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text.endsWith('Repository') &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        const repository = node.name.text;
        for (const member of node.initializer.properties) {
          if (!member.name || !ts.isIdentifier(member.name)) continue;
          let params: readonly ts.ParameterDeclaration[] | undefined;
          let body: ts.Node | undefined;
          if (ts.isMethodDeclaration(member)) {
            params = member.parameters;
            body = member.body;
          } else if (
            ts.isPropertyAssignment(member) &&
            (ts.isFunctionExpression(member.initializer) || ts.isArrowFunction(member.initializer))
          ) {
            params = member.initializer.parameters;
            body = member.initializer.body;
          }
          if (!params || !body) continue;

          const { models, raw } = addressedModels(body);
          const gated = raw || [...models].some((m) => gatedModels.has(m));
          index.set(`${repository}.${member.name.text}`, {
            file,
            gated,
            txIndex: txParameterIndex(params),
          });
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return index;
}

/**
 * The `pre-auth` keys the MOTIR-2784 guard has already adjudicated, read out of
 * its `VERDICTS` map by parsing it.
 *
 * Parsed rather than imported because that file is a `.test.ts` and this module
 * is imported BY tests — and because MOTIR-2817 must touch no existing test. The
 * cost is a coupling to the map's NAME, which `test-call-site-guard.test.ts`
 * pins with a non-empty assertion so a rename fails loudly instead of silently
 * returning an empty set and re-opening two adjudicated sites.
 */
export function preAuthKeys(root = process.cwd()): Set<string> {
  const out = new Set<string>();
  const real = path.join(root, GUARD);
  const sf = sourceFile(existsSync(real) ? real : path.join(root, GUARD_FIXTURE));
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'VERDICTS' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const p of node.initializer.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isStringLiteralLike(p.name)) continue;
        if (!ts.isArrayLiteralExpression(p.initializer)) continue;
        const [verdict] = p.initializer.elements;
        if (verdict && ts.isStringLiteralLike(verdict) && verdict.text === 'pre-auth') {
          out.add(p.name.text);
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__fixtures__' || entry === 'node_modules') continue;
      walk(full, acc);
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      acc.push(full);
    }
  }
  return acc;
}

/** An argument that is literally `undefined` does not bind anything. */
function bindsSomething(arg: ts.Expression | undefined): boolean {
  if (!arg) return false;
  return !(ts.isIdentifier(arg) && arg.text === 'undefined');
}

/**
 * Every `<x>Repository.<method>(…)` call under `tests/`, classified.
 *
 * A call whose method is absent from the repository index is NOT silently
 * dropped and NOT defaulted to `in-scope` — it is returned in `unclassifiable`
 * so the guard can fail on it. A shape this scanner cannot rule on must stop the
 * build, because the alternative is a call site nobody ever looks at again.
 */
export function scanTestCallSites(root = process.cwd()): {
  sites: TestCallSite[];
  unclassifiable: { file: string; line: number; callee: string }[];
} {
  const index = repositoryIndex(root);
  const preAuth = preAuthKeys(root);
  const sites: TestCallSite[] = [];
  const unclassifiable: { file: string; line: number; callee: string }[] = [];

  for (const full of walk(path.join(root, TESTS_DIR))) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    const sf = sourceFile(full);

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text.endsWith('Repository')
      ) {
        const repository = node.expression.expression.text;
        const method = node.expression.name.text;
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const entry = index.get(`${repository}.${method}`);

        if (!entry) {
          unclassifiable.push({ file: rel, line, callee: `${repository}.${method}` });
        } else {
          const bound = entry.txIndex !== null && bindsSomething(node.arguments[entry.txIndex]);
          const verdict: TestCallSiteVerdict = !entry.gated
            ? 'not-gated'
            : preAuth.has(`${entry.file}#${method}`)
              ? 'pre-auth'
              : entry.txIndex === null
                ? 'needs-binding-first'
                : bound
                  ? 'already-bound'
                  : 'in-scope';
          sites.push({
            file: rel,
            line,
            repository,
            method,
            key: `${rel}:${line}`,
            bound,
            verdict,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  sites.sort((a, b) => a.key.localeCompare(b.key));
  return { sites, unclassifiable };
}

/** Count by verdict — what the ratchet and the story's table are stated in. */
export function countByVerdict(sites: TestCallSite[]): Record<TestCallSiteVerdict, number> {
  const counts: Record<TestCallSiteVerdict, number> = {
    'in-scope': 0,
    'not-gated': 0,
    'pre-auth': 0,
    'needs-binding-first': 0,
    'already-bound': 0,
  };
  for (const s of sites) counts[s.verdict] += 1;
  return counts;
}
