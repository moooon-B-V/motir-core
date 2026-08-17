import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { policyGatedModels } from './singletonReadScan';

// The SYSTEM-CONTEXT scanner (MOTIR-2880) — the FOURTH axis, and the first one
// that is not about plumbing at all.
//
// ── The three axes that came before, and the question none of them asks ─────
// `singletonReadScan` asks whether a read CAN be bound (does it take a `tx`?).
// `callSiteScan` asks whether its callers DO bind it (do they pass one?).
// `bareTransactionScan` asks what the transaction BOUND (`db.$transaction`
// binds nothing). All three are answered YES at every site below, and every one
// of those sites was still dead:
//
//     the transaction bound `app.system_admin` — but does any POLICY read it?
//
// `withSystemContext` binds ONE GUC, and that GUC is read by a policy ARM added
// PER TABLE for the jobs runtime and operator tooling. Measured on the migrated
// schema at the commit this landed: of the 69 tables with RLS enabled, 26 carry
// such an arm on a permissive SELECT/ALL policy and 43 do not — `work_item`,
// `workspace_membership`, `project_repository`, `sprint`, `comment` among them.
// A read of an unarmed table inside a system context returns ZERO ROWS AND
// RAISES NOTHING.
//
// ── Why the arm inventory is not enough, and this module resolves JOINS ─────
// `notes.html` #269: *a read is admitted only if EVERY table it touches is
// admitted; a policy-arm inventory describes the FROM clause, not the query.*
// Both of the sites this card could not fix by binding were found through that
// clause and not through the FROM one — `projectRepository#findLivePairs` reads
// the armed `project` and dies on a `workspace: { is: {} }` relation filter, and
// `ciContainerPeriodCostRepository#sumForPeriodByMetaSplit` reads the armed
// `ci_container_period_cost` and dies on `JOIN "organization"`. A scanner that
// only collected `tx.<model>` accesses would have reported both sites green.
//
// So {@link repositoryQueryModels} resolves, per repository method: the models
// addressed off the transaction client, PLUS the models reachable through the
// relation keys its `include` / `select` / relation-filter object literals name,
// PLUS the tables named in the FROM / JOIN clauses of its raw SQL.
//
// ── The BINDING has a position, exactly as in bareTransactionScan ──────────
// The fix for most of this class is not a policy — it is `bindWorkspaceContext`
// / `bindOrganizationContext` called the moment the tenant becomes known, which
// is additive (the system flag stays set for the connection-tier reads in the
// same transaction). That makes the verdict positional in the same way a bare
// transaction's is: a statement BEFORE the bind is still system-only, and one
// after it is tenant-bound. A whole-site boolean would report
// `changeRequestStatusSync` bound and put its blind work-item resolve straight
// back under, because that resolve runs in the same block as the bind.
//
// ── What it deliberately does NOT decide ───────────────────────────────────
// Whether a system-only read of an UNARMED table is a bug. It usually is, but
// three legitimate shapes exist and cannot be told apart from the syntax: a
// table that is in `policyGatedModels`'s deliberate OVER-approximation and
// carries no policy at all; raw SQL whose target the parser cannot name; and a
// read that is genuinely cross-tenant by design, whose table has since been
// armed. So the scanner enumerates and the guard test carries the verdicts —
// one entry per site, with the reason in the value, the division of labour
// MOTIR-2784 established.

// ⚠️ `tests` JOINED THE ROOTS IN MOTIR-2887, and the reason is that the class this
// module finds has a TEST-SIDE twin that is strictly worse. A `withSystemContext`
// block in `lib/` that reads an unarmed table makes the PRODUCT visibly wrong; the
// same block in a FIXTURE makes the TEST quietly wrong IN THE DIRECTION OF
// PASSING — `dropStatusCategory` in `githubWebhookCustomWorkflow.test.ts` deleted
// nothing, so the test measured the DEFAULT workflow while claiming to measure a
// custom one. MOTIR-2880 scoped the scan to `lib/` + `app/` to stay off the test
// tree while MOTIR-2881 / MOTIR-2882 were rewriting it; both have merged, and that
// reason has expired.
const SCAN_ROOTS = ['lib', 'app', 'tests'] as const;
const REPO_DIR = 'lib/repositories';
const SCHEMA = 'prisma/schema.prisma';
const HELPER = 'withSystemContext';

/** The helpers that bind a TENANT GUC on an already-open transaction. */
const BIND_CALLS = new Set(['bindWorkspaceContext', 'bindOrganizationContext']);

/** The GUCs that narrow a system transaction to one tenant. `app.system_admin`
 *  is deliberately NOT one of them — it is what the site already has. */
/**
 * How deep the helper walk follows a `tx`. THREE, because the shallowest real
 * miss this scanner has been shown is at two (`sweepRepo` -> `applyOne` ->
 * `resolveChangeRequestWorkItem`), and one more is the margin that keeps a single
 * refactor from re-hiding it. A visited set makes the bound safe rather than
 * merely finite.
 */
const MAX_HELPER_HOPS = 3;

const TENANT_GUCS = ['app.workspace_id', 'app.organization_id', 'app.user_id'] as const;

export type SystemContextVerdict =
  /** At least one gated statement runs before any tenant binding. */
  | 'system-only'
  /** Every gated statement sits after a tenant binding. */
  | 'binds-tenant'
  /** The block reaches no policy-gated statement at all. */
  | 'no-gated-statement';

export interface SystemContextSite {
  /** repo-relative path, e.g. `lib/services/changeRequestStatusSync.ts` */
  file: string;
  line: number;
  /** the nearest named function/method enclosing the call */
  enclosing: string;
  /** `file#enclosing` — the allowlist key, LINE-INDEPENDENT on purpose */
  key: string;
  verdict: SystemContextVerdict;
  /**
   * Prisma models reached BEFORE any tenant binding, sorted. These are the ones
   * whose TABLE must carry a `system_admin` read arm.
   */
  systemOnlyModels: string[];
  /** Every gated model the block reaches, bound or not. */
  models: string[];
  /** True when a statement before the binding is raw SQL the parser cannot name. */
  raw: boolean;
  /** How each model was reached — `repo.method`, `helper:name`, `tx.model`. */
  via: string[];
  /**
   * Calls that were HANDED THE TRANSACTION and whose body this scan could not
   * read (MOTIR-2910) — sorted, `helper-trail -> name` where the wall sits below
   * a helper hop.
   *
   * ⚠️ THIS IS THE FIELD THAT KEEPS A VERDICT HONEST, and it exists because the
   * absence of it produced a silent false GREEN. `changeRequestStatusSync#
   * syncChangeRequestStatus` calls `resolveContext(tx)` — a FUNCTION-TYPED
   * PARAMETER, supplied by whichever provider is driving the delivery — and the
   * walk resolves callees by NAME through `reachableHelpers`, which knows local
   * declarations and imports and cannot know a parameter's runtime value. So the
   * call was dropped, and the site was classified `binds-tenant` off the
   * statements the walk COULD see (all of which do sit after the bind) while
   * `resolveGithubChangeRequestContext` — which runs BEFORE it and read
   * `workspace_membership` unbound — was invisible.
   *
   * A verdict computed over a walk that hit a wall is a verdict about part of
   * the block. Recording the wall is what lets the guard REFUSE to read such a
   * verdict as clearance (`notes.html` #268 — a partition inherits every
   * distinction its instrument cannot draw, so the instrument must state what it
   * cannot see). Resolving the callee properly would mean inverting the call
   * graph to find what every caller passes for that parameter; that is a real
   * feature and this is deliberately not it. Naming the blind spot is cheap,
   * total, and cannot itself be wrong.
   */
  unresolvedCalls: string[];
}

// ─── prisma schema: model ⇄ table, and each model's relation fields ─────────

interface SchemaMap {
  /** delegate name (`workItem`) -> table (`work_item`) */
  tableOf: Map<string, string>;
  /** delegate name -> (relation field -> related delegate name) */
  relationsOf: Map<string, Map<string, string>>;
}

const schemaCache = new Map<string, SchemaMap>();

/**
 * The delegate⇄table mapping and every model's RELATION fields.
 *
 * The relation half is what lets a JOIN be adjudicated. Prisma expresses a join
 * as a relation field name inside an object literal — `include: { installation:
 * true }`, `where: { githubRepo: { repoId } }`, `where: { workspace: { is: {} }
 * }` — so the field name is the only handle, and it has to be resolved against
 * the OWNING model rather than matched by convention: `collaborators` on
 * `ProjectRepo` is `project_repository_collaborator`, which no naming rule would
 * have produced.
 */
export function schemaMap(root = process.cwd()): SchemaMap {
  const cached = schemaCache.get(root);
  if (cached) return cached;

  const src = readFileSync(path.join(root, SCHEMA), 'utf8');
  const tableOf = new Map<string, string>();
  const relationsOf = new Map<string, Map<string, string>>();
  const modelNames = new Set<string>();
  const bodies = new Map<string, string>();

  for (const m of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, name, body] = m;
    if (!name || body === undefined) continue;
    modelNames.add(name);
    bodies.set(name, body);
    const mapped = body.match(/@@map\("([^"]+)"\)/);
    tableOf.set(delegateOf(name), mapped?.[1] ?? name);
  }

  for (const [name, body] of bodies) {
    const rel = new Map<string, string>();
    for (const line of body.split('\n')) {
      // `  installation   GithubInstallation  @relation(...)` — a relation field
      // is one whose TYPE is another model. Scalars and enums are skipped by
      // that test alone, so no list of primitive names is needed.
      const f = /^\s{2}(\w+)\s+(\w+)(\[\])?\s*\??/.exec(line);
      if (!f?.[1] || !f[2]) continue;
      if (!modelNames.has(f[2])) continue;
      rel.set(f[1], delegateOf(f[2]));
    }
    relationsOf.set(delegateOf(name), rel);
  }

  const out = { tableOf, relationsOf };
  schemaCache.set(root, out);
  return out;
}

function delegateOf(model: string): string {
  return model[0]!.toLowerCase() + model.slice(1);
}

/** Every table name in the schema, for resolving raw-SQL FROM / JOIN targets. */
function tableNames(map: SchemaMap): Set<string> {
  return new Set(map.tableOf.values());
}

// ─── repository methods: the models their QUERY touches, joins included ─────

const repoCache = new Map<string, Map<string, { models: string[]; raw: boolean }>>();

/**
 * Every repository method that issues a statement on a transaction client, keyed
 * `<repository>.<method>`, with EVERY model its query touches.
 *
 * The difference from `bareTransactionScan.repositoryStatementModels`, and the
 * reason this is a second function rather than a reuse: that one collects the
 * models addressed OFF the client (`tx.projectRepo.findFirst`), which answers
 * "what is the FROM clause". This one also walks the argument object literal for
 * relation keys and the raw SQL for FROM / JOIN targets, which answers "what is
 * the QUERY" — the distinction `notes.html` #269 exists to make, and the one
 * that found both of this card's un-bindable sites.
 */
export function repositoryQueryModels(
  root = process.cwd(),
): Map<string, { models: string[]; raw: boolean }> {
  const cached = repoCache.get(root);
  if (cached) return cached;

  const map = schemaMap(root);
  const tables = tableNames(map);
  const out = new Map<string, { models: string[]; raw: boolean }>();
  const dir = path.join(root, REPO_DIR);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  } catch {
    repoCache.set(root, out);
    return out; // a fixture root may carry no repositories
  }

  for (const file of files.sort()) {
    const repository = file.replace(/\.ts$/, '');
    const full = path.join(dir, file);
    const sf = ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.body) {
        const takesTx = node.parameters.some(
          (p) => ts.isIdentifier(p.name) && p.name.text === 'tx',
        );
        if (takesTx) {
          const found = queryModels(node.body, ['tx', 'client', 'db', 'c'], map, tables);
          if (found.models.size > 0 || found.raw) {
            out.set(`${repository}.${node.name.text}`, {
              models: [...found.models].sort(),
              raw: found.raw,
            });
          }
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  repoCache.set(root, out);
  return out;
}

/**
 * The models a subtree's queries touch: the delegates addressed off `aliases`,
 * every model reachable through the relation keys their argument literals name,
 * and every schema table named in a FROM / JOIN of their raw SQL.
 *
 * Relation keys are resolved TRANSITIVELY over the models already collected, so
 * a nested `include: { githubRepo: { include: { installation: true } } }` reaches
 * both hops. The walk is bounded by the number of models in play, not by depth.
 */
function queryModels(
  node: ts.Node,
  aliases: readonly string[],
  map: SchemaMap,
  tables: ReadonlySet<string>,
): { models: Set<string>; raw: boolean } {
  const models = new Set<string>();
  const keys = new Set<string>();
  let raw = false;

  const visit = (n: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      aliases.includes(n.expression.text)
    ) {
      const name = n.name.text;
      if (name.startsWith('$')) {
        if (name.startsWith('$queryRaw') || name.startsWith('$executeRaw')) raw = true;
      } else if (map.tableOf.has(name)) {
        models.add(name);
      }
    }
    // Every object-literal property name in the method is a CANDIDATE relation
    // key. Collecting them all and resolving against the owning model is what
    // keeps this honest: `where: { workspace: { is: {} } }` and `include: {
    // collaborators: COLLABORATOR_COLUMNS }` are both joins and neither is
    // spelled `include: { x: true }`, so keying on the enclosing property would
    // miss them. A key that names no relation of any collected model resolves to
    // nothing, which is why the over-collection is safe.
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) keys.add(n.name.text);
    if (ts.isShorthandPropertyAssignment(n)) keys.add(n.name.text);
    // Raw SQL: the template's literal chunks carry the FROM / JOIN targets.
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      for (const hit of n.text.matchAll(/(?:FROM|JOIN|INTO|UPDATE)\s+"?([a-z_][a-z0-9_]*)"?/gi)) {
        const table = hit[1];
        if (table && tables.has(table)) {
          for (const [delegate, t] of map.tableOf) if (t === table) models.add(delegate);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);

  for (let grew = true; grew; ) {
    grew = false;
    for (const delegate of [...models]) {
      const rel = map.relationsOf.get(delegate);
      if (!rel) continue;
      for (const key of keys) {
        const target = rel.get(key);
        if (target && !models.has(target)) {
          models.add(target);
          grew = true;
        }
      }
    }
  }

  return { models, raw };
}

// ─── the scan ──────────────────────────────────────────────────────────────

/** Does this subtree bind a TENANT GUC — a helper call, or real `set_config` SQL? */
function bindsTenantInline(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    // Matched on LITERAL nodes rather than on source text, so a COMMENT
    // explaining `set_config('app.workspace_id', …)` — and several of these files
    // now carry one — can never be mistaken for the call itself.
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      if (TENANT_GUCS.some((g) => n.text.includes(`set_config('${g}'`))) found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * The functions a file can reach by NAME with a `tx` — its own module-local ones,
 * PLUS the exported functions it imports from another `lib/` module.
 *
 * ⚠️ THE IMPORTED HALF IS NOT OPTIONAL, and leaving it out cost this card a real
 * miss. `historicalPullRequestBackfillService#sweepRepo` calls
 * `resolveChangeRequestWorkItem(repo.workspaceId, cr, tx)` — imported from
 * `changeRequestStatusSync` — which reads `work_item` and `project`, neither
 * armed. A same-file-only walk reported that site as reaching `githubPullRequest`
 * alone, i.e. fully armed, while six of its tests were red under `motir_app` for
 * exactly the class this scanner exists to find.
 *
 * Resolving the module is a path join, not type resolution — `@/lib/x` and `./x`
 * both land on a file, and anything that does not is skipped. How DEEP the walk
 * then follows a `tx` is {@link MAX_HELPER_HOPS}, and the fixture pins it from
 * both sides.
 */
const helperCache = new Map<string, HelperMap>();

interface Helper {
  body: ts.Node;
  txParam?: string;
  /** the file the helper is DECLARED in — what its own imports resolve against */
  sf: ts.SourceFile;
}
type HelperMap = Map<string, Helper>;

function reachableHelpers(sf: ts.SourceFile, root: string): HelperMap {
  const cached = helperCache.get(sf.fileName);
  if (cached) return cached;
  const out = localHelpers(sf);
  helperCache.set(sf.fileName, out);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    if (!ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    const wanted = named.elements.filter((e) => !out.has(e.name.text));
    if (wanted.length === 0) continue;
    const resolved = resolveModule(spec, sf.fileName, root);
    if (!resolved) continue;
    let imported: HelperMap;
    try {
      imported = localHelpers(
        ts.createSourceFile(resolved, readFileSync(resolved, 'utf8'), ts.ScriptTarget.Latest, true),
      );
    } catch {
      continue;
    }
    for (const el of wanted) {
      const hit = imported.get((el.propertyName ?? el.name).text);
      if (hit) out.set(el.name.text, hit);
    }
  }
  return out;
}

/** `@/lib/x` / `./x` -> an existing `.ts` file, or undefined. No type resolution. */
function resolveModule(spec: string, from: string, root: string): string | undefined {
  const base = spec.startsWith('@/')
    ? path.join(root, spec.slice(2))
    : spec.startsWith('.')
      ? path.join(path.dirname(from), spec)
      : undefined;
  if (!base) return undefined;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not this one */
    }
  }
  return undefined;
}

/** The module-local functions of a file, by name, with their `tx` parameter. */
function localHelpers(sf: ts.SourceFile): HelperMap {
  const out: HelperMap = new Map();
  const record = (
    name: string,
    params: ts.NodeArray<ts.ParameterDeclaration>,
    body: ts.Node,
  ): void => {
    const tx =
      params.find((p) => ts.isIdentifier(p.name) && p.name.text === 'tx') ??
      params.find((p) => ts.isIdentifier(p.name) && p.name.text === 't');
    out.set(name, {
      body,
      sf,
      ...(tx && ts.isIdentifier(tx.name) ? { txParam: tx.name.text } : {}),
    });
  };
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) {
      record(st.name.text, st.parameters, st.body);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          record(d.name.text, d.initializer.parameters, d.initializer.body);
        }
      }
    }
  }
  return out;
}

/** The nearest named function/method enclosing a node, for the site key. */
function enclosingName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (
      (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) &&
      n.name &&
      ts.isIdentifier(n.name)
    ) {
      return n.name.text;
    }
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) return n.name.text;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      return n.name.text;
    }
    // A TEST callback (MOTIR-2887). In `lib/` every site sits in a named function
    // or a named const, so the four cases above are total; in `tests/` the
    // commonest enclosing scope by far is an ANONYMOUS arrow handed to `it(…)` /
    // `beforeEach(…)`, which none of them names — every such site would key as
    // `<module>` and collapse onto one another. The test's own TITLE is the
    // line-independent name the sibling guards' keys are built for.
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      n.parent &&
      ts.isCallExpression(n.parent) &&
      ts.isIdentifier(n.parent.expression)
    ) {
      const fn = n.parent.expression.text;
      const [first] = n.parent.arguments;
      return first && ts.isStringLiteralLike(first) ? `${fn}:${first.text}` : fn;
    }
  }
  return '<module>';
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      // The scanner's OWN negative fixture is a separate root with its own cache
      // key (see `scanSystemContexts`), so walking it from the repo root would
      // report its deliberately-broken sites as real findings.
      if (entry === '__fixtures__') continue;
      yield* walk(full);
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      yield full;
    }
  }
}

/**
 * Memoised per root, for the reason `callSiteScan` documents: the guard calls
 * these exports from several tests, and under `vitest run --coverage` the v8
 * provider instruments the compiler-API walk heavily enough that an unmemoised
 * re-scan blows the repo's 15 s `testTimeout`.
 */
const cache = new Map<string, SystemContextSite[]>();

/** Every `withSystemContext` block in `lib/` + `app/` + `tests/`, classified by what it reaches. */
export function scanSystemContexts(root = process.cwd()): SystemContextSite[] {
  const cached = cache.get(root);
  if (cached) return cached;

  const gated = policyGatedModels(root);
  const repoModels = repositoryQueryModels(root);
  const map = schemaMap(root);
  const tables = tableNames(map);
  const out: SystemContextSite[] = [];

  for (const scanRoot of SCAN_ROOTS) {
    const abs = path.join(root, scanRoot);
    try {
      statSync(abs);
    } catch {
      continue;
    }
    for (const full of walk(abs)) {
      const rel = path.relative(root, full);
      // The helper's own definition binds the GUC it is named for; scanning it
      // would report the file that DEFINES the context as a site.
      if (rel === path.join('lib', 'workspaces', 'context.ts')) continue;
      const sf = ts.createSourceFile(
        full,
        readFileSync(full, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      if (!sf.text.includes(`${HELPER}(`)) continue;
      const helpers = reachableHelpers(sf, root);

      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === HELPER
        ) {
          out.push(classify(node, sf, rel, gated, repoModels, helpers, root, map, tables));
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }

  out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  cache.set(root, out);
  return out;
}

function classify(
  node: ts.CallExpression,
  sf: ts.SourceFile,
  file: string,
  gated: ReadonlySet<string>,
  repoModels: ReadonlyMap<string, { models: string[]; raw: boolean }>,
  helpers: HelperMap,
  root: string,
  map: SchemaMap,
  tables: ReadonlySet<string>,
): SystemContextSite {
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const enclosing = enclosingName(node);
  const models = new Set<string>();
  const systemOnly = new Set<string>();
  const via = new Set<string>();
  const unresolved = new Set<string>();
  let raw = false;

  const [arg] = node.arguments;
  const cb = arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) ? arg : undefined;
  const txName =
    cb?.parameters[0] && ts.isIdentifier(cb.parameters[0].name)
      ? cb.parameters[0].name.text
      : undefined;
  const body: ts.Node = cb ? cb.body : node;
  const aliases = txName ? [txName] : ['tx'];

  // ── Where the transaction starts being TENANT-bound ───────────────────────
  //
  // ⚠️ A BOOLEAN HERE IS WRONG, for the reason `bareTransactionScan` spells out
  // one axis over: the fix for this whole class is a bind placed MID-BLOCK, so
  // every fixed site would report "bound" while its pre-bind reads stayed dead.
  // `changeRequestStatusSync` is the fixture — it binds `repo.workspaceId` after
  // the connection-tier resolve and before the work-item resolve, and the two
  // statements on either side of that line have opposite verdicts.
  //
  // ⚠️ LEXICAL, not control-flow — the same documented limit as the sibling
  // scanner. A bind inside one arm of an `if` reads as binding everything below
  // it; tightening that needs a CFG.
  let bindPos: number | undefined;
  const noteBind = (pos: number): void => {
    if (bindPos === undefined || pos < bindPos) bindPos = pos;
  };
  const visitBinds = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      BIND_CALLS.has(n.expression.text) &&
      n.arguments.some((a) => ts.isIdentifier(a) && aliases.includes(a.text))
    ) {
      noteBind(n.getStart(sf));
    }
    ts.forEachChild(n, visitBinds);
  };
  visitBinds(body);
  if (bindsTenantInline(body)) {
    const visitRaw = (n: ts.Node): void => {
      if (
        (ts.isStringLiteral(n) ||
          ts.isNoSubstitutionTemplateLiteral(n) ||
          ts.isTemplateHead(n) ||
          ts.isTemplateMiddle(n) ||
          ts.isTemplateTail(n)) &&
        TENANT_GUCS.some((g) => n.text.includes(`set_config('${g}'`))
      ) {
        noteBind(n.getStart(sf));
      }
      ts.forEachChild(n, visitRaw);
    };
    visitRaw(body);
  }

  const record = (pos: number, model: string, label: string, isRaw: boolean): void => {
    if (model) models.add(model);
    via.add(label);
    const beforeBind = bindPos === undefined || pos < bindPos;
    if (beforeBind) {
      if (model) systemOnly.add(model);
      if (isRaw) raw = true;
    }
  };

  // Hop 1 — statements issued directly on the transaction client, with their
  // relation joins.
  const visitDirect = (n: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      aliases.includes(n.expression.text)
    ) {
      const name = n.name.text;
      const pos = n.getStart(sf);
      if (name.startsWith('$')) {
        // A `set_config` binding is the binding, not a statement to adjudicate.
        if (
          (name.startsWith('$queryRaw') || name.startsWith('$executeRaw')) &&
          !bindsTenantInline(n.parent)
        ) {
          const found = queryModels(n.parent, aliases, map, tables);
          for (const m of found.models)
            if (gated.has(m)) record(pos, m, `${aliases[0]}.${name}`, true);
          if (found.models.size === 0) record(pos, '', `${aliases[0]}.${name}`, true);
        }
      } else if (map.tableOf.has(name)) {
        const found = queryModels(n.parent.parent ?? n.parent, aliases, map, tables);
        for (const m of found.models)
          if (gated.has(m)) record(pos, m, `${aliases[0]}.${name}`, false);
      }
    }
    ts.forEachChild(n, visitDirect);
  };
  visitDirect(body);

  // Hops 2+ — into a repository method, or into a helper the file can reach by
  // name (its own, or one it imports from another `lib/` module), and only where
  // the transaction client is actually handed over.
  //
  // ⚠️ THE WALK IS RECURSIVE, BOUNDED BY {@link MAX_HELPER_HOPS}, AND THAT IS NOT
  // GOLD-PLATING. `bareTransactionScan` stops at one hop and says so; this one
  // cannot, because a real instance of exactly this class sits at TWO:
  // `historicalPullRequestBackfillService#sweepRepo` calls the same-file
  // `applyOne`, which calls the IMPORTED `resolveChangeRequestWorkItem`, which
  // reads `work_item` and `project`. At one hop the site reports
  // `githubPullRequest` alone — fully armed — while six of its tests were red
  // under `motir_app` for precisely this. A depth cap plus a visited set keeps it
  // terminating on the mutual recursion these services do write.
  //
  // A helper's position is its CALL SITE's, not its declaration's: the binding it
  // sits before or after is the caller's.
  const seen = new Set<string>();
  const walkCalls = (
    node: ts.Node,
    currentAliases: string[],
    at: number | undefined,
    file: ts.SourceFile,
    scope: HelperMap,
    depth: number,
    trail: string,
  ): void => {
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const passesTx = n.arguments.some(
          (a) => ts.isIdentifier(a) && currentAliases.includes(a.text),
        );
        if (passesTx) {
          const pos = at ?? n.getStart(sf);
          if (
            ts.isPropertyAccessExpression(n.expression) &&
            ts.isIdentifier(n.expression.expression)
          ) {
            const key = `${n.expression.expression.text}.${n.expression.name.text}`;
            const hit = repoModels.get(key) ?? repoModels.get(aliasedRepoKey(file, key));
            if (hit) {
              const label = trail ? `${trail} -> ${key}` : key;
              for (const m of hit.models) if (gated.has(m)) record(pos, m, label, false);
              if (hit.raw && hit.models.length === 0) record(pos, '', label, true);
            }
          }
          if (ts.isIdentifier(n.expression) && depth < MAX_HELPER_HOPS) {
            const name = n.expression.text;
            const helper = scope.get(name);
            // The wall (MOTIR-2910). The transaction was handed to a callee this
            // scan cannot resolve by name — a function-typed PARAMETER, or any
            // other value-level indirection. Everything below it is unread, so
            // record it instead of stepping over it silently.
            //
            // A BIND_CALLS member is never a wall: the scan models it explicitly
            // (that is what moves `bindPos`), so an unresolved DECLARATION for it
            // costs nothing. Reporting it would be noise that trains a reader to
            // skim the one list that must stay worth reading.
            if (!helper && !BIND_CALLS.has(name)) {
              unresolved.add(trail ? `${trail} -> ${name}` : name);
            }
            const mark = `${helper?.sf.fileName ?? file.fileName}#${name}`;
            if (helper && !seen.has(mark)) {
              seen.add(mark);
              const helperTx = helper.txParam ? [helper.txParam] : ['tx'];
              const label = trail ? `${trail} -> helper:${name}` : `helper:${name}`;
              const inner = queryModels(helper.body, helperTx, map, tables);
              for (const m of inner.models) if (gated.has(m)) record(pos, m, label, false);
              walkCalls(
                helper.body,
                helperTx,
                pos,
                helper.sf,
                helper.sf === file ? scope : reachableHelpers(helper.sf, root),
                depth + 1,
                label,
              );
              seen.delete(mark);
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  };
  walkCalls(body, aliases, undefined, sf, helpers, 0, '');

  const verdict: SystemContextVerdict =
    systemOnly.size > 0 || raw
      ? 'system-only'
      : bindPos !== undefined
        ? 'binds-tenant'
        : models.size > 0
          ? 'binds-tenant'
          : 'no-gated-statement';

  return {
    file,
    line,
    enclosing,
    key: `${file}#${enclosing}`,
    verdict: models.size === 0 && !raw ? 'no-gated-statement' : verdict,
    systemOnlyModels: [...systemOnly].sort(),
    models: [...models].sort(),
    raw,
    via: [...via].sort(),
    unresolvedCalls: [...unresolved].sort(),
  };
}

/**
 * Several of these services import a repository UNDER AN ALIAS —
 * `import { ciRunnerProvisioningIntentRepository as intents }` — because the real
 * names are long enough to wrap every call site. The alias is local to the file,
 * so it is resolved here rather than in the repository map.
 */
const aliasCache = new Map<ts.SourceFile, Map<string, string>>();
function aliasedRepoKey(sf: ts.SourceFile, key: string): string {
  let aliases = aliasCache.get(sf);
  if (!aliases) {
    aliases = new Map<string, string>();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st)) continue;
      const named = st.importClause?.namedBindings;
      if (!named || !ts.isNamedImports(named)) continue;
      for (const el of named.elements) {
        if (el.propertyName) aliases.set(el.name.text, el.propertyName.text);
      }
    }
    aliasCache.set(sf, aliases);
  }
  const [object, method] = key.split('.');
  const real = object ? aliases.get(object) : undefined;
  return real && method ? `${real}.${method}` : key;
}

/** The findings — a system context reaching a gated table before any tenant binding. */
export function systemOnlyReads(root = process.cwd()): SystemContextSite[] {
  return scanSystemContexts(root).filter((s) => s.verdict === 'system-only');
}
