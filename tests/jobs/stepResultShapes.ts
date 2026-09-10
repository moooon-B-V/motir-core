import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

// MOTIR-5022 — the SHAPE half of a memoized step's identity.
//
// ── What this scanner reads, and why it has to be types ─────────────────────
// `lib/jobs/engine/step.ts` states the memo contract in one sentence: look up
// `(run_id, id)` in `job_step`, and if a row exists return its stored result
// WITHOUT executing. A step id therefore identifies a unit of work ACROSS a
// deploy, and the stored value is only ever as current as the revision that
// wrote it. So a run that started under revision A and resumed under revision B
// replays A's RESULT into B's reader, and nothing in the type system sees it:
// the reader's static type is B's, the value is A's, and the two are the same
// type as far as `tsc` is concerned because the boundary is JSON.
//
// That is not hypothetical. MOTIR-4652 replaced `resolve-target`'s
// `projectIds: string[]` with `anchorProjectId: string` and kept the id;
// MOTIR-5020 is the production outage that followed, and its fix was to bump the
// id to `resolve-target-v2`. This scanner is what makes the next one fail a test
// instead of a deploy.
//
// ── The predicate ───────────────────────────────────────────────────────────
// For every `<something>.step.run(id, fn)` call site under the scanned roots,
// compute a STRUCTURAL fingerprint of the value the call resolves to — the
// awaited result type, expanded through every type declared in this repository
// down to primitives, with properties sorted so the string is a function of the
// SHAPE and not of the declaration order.
//
// ⚠️ EXPANDED, not printed. `checker.typeToString` names an alias rather than
// its members (`OrphanSweepSummary`, not `{ deleted: number; … }`), so a pin
// taken from it moves only when the alias is RENAMED — which is the one change
// that cannot break a replay, while every change that can is invisible to it.
// Renaming `IndexTarget` is safe; adding a field to it is the outage. So the
// fingerprint has to be the members.
//
// ── Where expansion STOPS, declared rather than discovered ──────────────────
//   • A type declared outside the repository (`node_modules`, the generated
//     Prisma client, TypeScript's own `lib.*.d.ts`) prints as its NAME. `Date`
//     has thirty-odd methods and no JSON shape worth pinning, and the boundary
//     keeps a library upgrade out of this file.
//   • Anything callable prints `<function>` — `roundTrip` in the shim strips it
//     on the way to the ledger, so it has no shape on the replay path either.
//   • `MAX_DEPTH` levels down, expansion prints `…`. Nothing in this tree is
//     close to it (the deepest live shape is 4), and a shape that reaches it
//     says so in the pin rather than silently comparing equal.
//
// ── The population, measured rather than grepped ────────────────────────────
// 67 call sites on `origin/main@d4981d354`: 61 with a literal id, 4 with a
// template id, 2 FORWARDERS inside a seam. 57 distinct ids over the 65 pinnable
// sites. `git grep 'step\.run('` answers 66, and the two numbers disagree in
// both directions — four of its hits are prose, and it misses the five
// `steps.run` seam sites, which are the ones that provision.
//
// ── No database, no generated client, no build, no fixed checkout ───────────
// This module runs in the structural-guard lane, which deliberately provisions
// neither a database nor `prisma generate` (`.github/workflows/ci.yml`, the
// `structural-guards` job) and restores a CACHED `node_modules` without
// installing. Every one of those states was measured on MOTIR-5022 rather than
// assumed, because a fingerprint that varies with its environment is a red
// check that says the SHAPE changed:
//
//   • `generated/prisma` present vs moved aside — identical. A step result is a
//     DTO or a service summary; none of them names a Prisma type.
//   • `packages/orchestrator/dist` built vs absent — identical, but ONLY
//     because of `workspacePackagePaths` below. It was NOT identical before it.
//   • run from a different absolute path — identical, but ONLY because of
//     `normalizePrinted` below. Five pins carried an absolute path before it.
//
// The guard's own `any` assertion is the standing check on the first: a shape
// that degrades because a module stopped resolving would otherwise pin a
// fingerprint that can never change again — the vacuous-pass trap this lane's
// own header warns about.

/** The roots scanned for `step.run` call sites. */
export const SCANNED_ROOTS = ['lib', 'app'] as const;

/** How far into a nested object the fingerprint expands before printing `…`. */
export const MAX_DEPTH = 8;

/** How a call site uses the value the step resolves to. */
export type StepResultConsumption =
  /** Read by later code in the same run — the class MOTIR-5020 belongs to. */
  | 'consumed'
  /** Returned from the handler: it becomes the run's ledger output. */
  | 'returned'
  /** A bare expression statement — the value is dropped. */
  | 'discarded';

/** How a call site writes its step id. */
export type StepIdKind =
  /** `step.run('resolve-target-v2', …)` — pinnable as written. */
  | 'literal'
  /** `` steps.run(`index-boot:${projectId}`, …) `` — pinned by its source text. */
  | 'expression'
  /** `ctx.step.run(id, fn)` inside a seam: the id is a parameter, so this is a FORWARDER. */
  | 'forwarded';

export interface StepRunSite {
  /** Repo-relative, forward slashes. */
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  /**
   * The pin KEY: a literal id's text, or a template's SOURCE TEXT
   * (`` `index-admit:${projectId}` ``). Both are stable strings, and editing a
   * template IS a change of id — which is the property the pin wants.
   */
  readonly stepId: string;
  /** How the id was written. A `forwarded` id is a parameter, so it names no step. */
  readonly idKind: StepIdKind;
  /** The structural fingerprint of the awaited result (see the header). */
  readonly shape: string;
  readonly consumption: StepResultConsumption;
}

export interface ScanOptions {
  /** Defaults to the repository root. */
  readonly root?: string;
  /**
   * The files to scan, repo-relative. Defaults to every tracked `.ts`/`.tsx`
   * file under {@link SCANNED_ROOTS} whose text contains `step.run(`. Supplied
   * by the control, which drives this same code over a fixture tree that is not
   * in git.
   */
  readonly files?: readonly string[];
}

const REPO_ROOT = resolve(__dirname, '..', '..');

const toPosix = (p: string): string => p.split(sep).join('/');

/** Every tracked file under the scanned roots whose text mentions `step.run(`. */
export function candidateFiles(root: string = REPO_ROOT): string[] {
  const tracked = execFileSync('git', ['ls-files', '--', ...SCANNED_ROOTS], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f));
  return tracked.filter((f) => /\bsteps?\.run\(/.test(readFileSync(join(root, f), 'utf8')));
}

/**
 * Resolve every workspace package to its SOURCE, never to its build output.
 *
 * ⚠️ WITHOUT THIS THE FINGERPRINT IS A FUNCTION OF WHETHER SOMEBODY RAN A
 * BUILD, and it was: `@motir/orchestrator` publishes `types: ./dist/index.d.ts`
 * and is linked under `node_modules`, so with `dist` present six shapes printed
 * `ContainerUsage` by NAME (a `node_modules` path is external by the rule
 * below) and with `dist` absent they resolved to nothing at all. The
 * structural-guard lane restores a CACHED `node_modules` and skips
 * `pnpm install` on a hit — and a package's `dist` is not inside `node_modules`,
 * so it is exactly the state that would not have the build. Cache hit and cache
 * miss would have pinned different strings.
 *
 * Pointing at `src` removes the variable and expands the members, which is what
 * the pin wants anyway. Measured on MOTIR-5022: with this mapping, all 65
 * shapes are byte-identical with `packages/orchestrator/dist` present and moved
 * aside.
 */
function workspacePackagePaths(root: string): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  let packageDirs: string[] = [];
  try {
    packageDirs = readdirSync(join(root, 'packages'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return paths; // no `packages/` — a fixture tree, and nothing to map
  }
  for (const dir of packageDirs) {
    const manifest = join(root, 'packages', dir, 'package.json');
    const entry = join(root, 'packages', dir, 'src', 'index.ts');
    if (!existsSync(manifest) || !existsSync(entry)) continue;
    const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
    if (name) paths[name] = [entry];
  }
  return paths;
}

/** Is this type declared outside the repository — a library, or the generated client? */
function isExternallyDeclared(type: ts.Type, root: string): boolean {
  const symbol = type.getSymbol();
  // ⚠️ AN ANONYMOUS TYPE IS NEVER EXTERNAL, whatever file it was written in.
  // `Record<Workload, number>` and every inline `{ … }` carry the synthetic
  // symbol `__type`, whose declaration is `lib.es5.d.ts` — so the file test
  // alone hands them to `typeToString`, which prints them UNSORTED and may
  // truncate. They are this tree's own members and must be expanded.
  if (!symbol || symbol.name === '__type' || symbol.name === '__object') return false;
  const declarations = symbol.declarations;
  if (!declarations?.length) return false;
  return declarations.every((declaration) => {
    const file = toPosix(declaration.getSourceFile().fileName);
    if (file.includes('/node_modules/')) return true;
    if (/(^|\/)lib\.[a-z0-9.]+\.d\.ts$/.test(file)) return true;
    const rel = isAbsolute(file) ? toPosix(relative(root, file)) : file;
    return rel.startsWith('generated/') || rel.startsWith('../');
  });
}

const PRINT_FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias;

/**
 * Make a printed type CHECKOUT-INDEPENDENT.
 *
 * ⚠️ `typeToString` EMITS ABSOLUTE PATHS, and it does so for the cases this
 * fingerprint does not expand: an enum, a class, anything terminal that is not
 * in scope at the call site prints as
 * `import("/abs/path/to/lib/orchestrator/index").ContainerKind`. Five pins
 * carried one before this was noticed. A pin holding the directory it was
 * generated in fails in every OTHER directory — a second worktree, and CI,
 * where the checkout is `/home/runner/work/…` — so the guard would have gone
 * red on the first pull request that ran it and told the reader the SHAPE had
 * changed.
 */
function normalizePrinted(printed: string, root: string): string {
  let out = printed;
  const roots = new Set([toPosix(resolve(root))]);
  try {
    roots.add(toPosix(realpathSync(root)));
  } catch {
    // a fixture root that has gone away — the one form is enough
  }
  for (const r of roots) out = out.split(`${r}/`).join('');
  return out;
}

/**
 * The structural fingerprint of one type. See the header for what it expands
 * and where it stops.
 */
export function fingerprintOf(
  type: ts.Type,
  checker: ts.TypeChecker,
  at: ts.Node,
  root: string,
  depth = 0,
  onStack: Set<ts.Type> = new Set(),
): string {
  // `boolean` is a union of two literals in the checker; it is one word here.
  if (type.flags & ts.TypeFlags.Boolean) return 'boolean';

  if (type.isUnion()) {
    return [...new Set(type.types.map((t) => fingerprintOf(t, checker, at, root, depth, onStack)))]
      .sort()
      .join(' | ');
  }
  if (type.isIntersection()) {
    return [...new Set(type.types.map((t) => fingerprintOf(t, checker, at, root, depth, onStack)))]
      .sort()
      .join(' & ');
  }

  const printed = normalizePrinted(checker.typeToString(type, at, PRINT_FLAGS), root);

  const TERMINAL =
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.Never |
    ts.TypeFlags.Void |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.ESSymbolLike |
    ts.TypeFlags.EnumLike |
    ts.TypeFlags.TypeParameter |
    ts.TypeFlags.Index |
    ts.TypeFlags.IndexedAccess |
    ts.TypeFlags.Conditional |
    ts.TypeFlags.Substitution |
    ts.TypeFlags.NonPrimitive;
  if (type.flags & TERMINAL) return printed;

  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
    return '<function>';
  }

  // `readonly T[]` is `ReadonlyArray`, whose own symbol is declared in
  // `lib.es5.d.ts` — so without it here the element type falls to the external
  // branch and prints as a NAME, hiding every change inside it. `readonly` is
  // not a property of the stored JSON, so both spellings fingerprint the same.
  const symbol = type.getSymbol();
  if (symbol?.name === 'Array' || symbol?.name === 'ReadonlyArray') {
    const [element] = checker.getTypeArguments(type as ts.TypeReference);
    if (element) return `Array<${fingerprintOf(element, checker, at, root, depth + 1, onStack)}>`;
  }

  if (isExternallyDeclared(type, root)) return printed;
  if (depth >= MAX_DEPTH) return '…';
  if (onStack.has(type)) return '<circular>';

  onStack.add(type);
  try {
    const members = checker
      .getPropertiesOfType(type)
      .map((property) => {
        const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 ? '?' : '';
        const propertyType = checker.getTypeOfSymbolAtLocation(property, at);
        return `${property.name}${optional}: ${fingerprintOf(propertyType, checker, at, root, depth + 1, onStack)}`;
      })
      .sort();

    for (const [key, indexType] of [
      ['string', checker.getIndexTypeOfType(type, ts.IndexKind.String)],
      ['number', checker.getIndexTypeOfType(type, ts.IndexKind.Number)],
    ] as const) {
      if (indexType) {
        members.push(
          `[key: ${key}]: ${fingerprintOf(indexType, checker, at, root, depth + 1, onStack)}`,
        );
      }
    }

    return members.length === 0 ? '{}' : `{ ${members.join('; ')} }`;
  } finally {
    onStack.delete(type);
  }
}

/** Walk up past the wrappers that do not decide whether a value is USED. */
function effectiveParent(node: ts.Node): ts.Node | undefined {
  let current: ts.Node = node;
  let parent = current.parent;
  while (
    parent &&
    (ts.isAwaitExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent))
  ) {
    current = parent;
    parent = current.parent;
  }
  return parent;
}

function consumptionOf(node: ts.Node): StepResultConsumption {
  const parent = effectiveParent(node);
  if (!parent || ts.isExpressionStatement(parent)) return 'discarded';
  // A concise arrow body is a return in disguise: `() => step.run(…)`.
  if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) return 'returned';
  return 'consumed';
}

/**
 * Is this call a memoized step invocation?
 *
 * ⚠️ `steps` AS WELL AS `step`, AND THE PLURAL IS WHERE THE STAKES ARE. A
 * handler reaches the shim as `ctx.step.run(…)`, but a SUPERVISION reaches it
 * through a seam it was handed — `SupervisionSteps` / `RunnerSupervisionSteps`,
 * whose one method forwards to `ctx.step.run` — and calls it `steps.run(…)`.
 * Those five sites are the ones that PROVISION: `index-admit:`, `index-boot:`,
 * `index-settle:`, `boot-runner`, `settle-runner`. A predicate written against
 * the singular reads as complete, matches 62 sites, and omits precisely the
 * memos whose replay bills a second container.
 */
function isStepRunCall(node: ts.Node, source: ts.SourceFile): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'run' &&
    node.arguments.length === 2 &&
    /(^|\.)steps?$/.test(node.expression.expression.getText(source))
  );
}

/**
 * Every `step.run` call site under the scanned roots, with the structural
 * fingerprint of the value it resolves to.
 */
export function scanStepRunSites(options: ScanOptions = {}): StepRunSite[] {
  const root = options.root ?? REPO_ROOT;
  const files = options.files ?? candidateFiles(root);

  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  const config = configPath
    ? ts.parseJsonConfigFileContent(
        ts.readConfigFile(configPath, ts.sys.readFile).config,
        ts.sys,
        root,
      )
    : undefined;

  const program = ts.createProgram(
    files.map((f) => join(root, f)),
    {
      ...(config?.options ?? {}),
      noEmit: true,
      skipLibCheck: true,
      paths: { ...(config?.options.paths ?? {}), ...workspacePackagePaths(root) },
    },
  );
  const checker = program.getTypeChecker();

  const sites: StepRunSite[] = [];
  for (const file of files) {
    const source = program.getSourceFile(join(root, file));
    if (!source) throw new Error(`stepResultShapes: ${file} is not in the program`);

    const visit = (node: ts.Node): void => {
      if (isStepRunCall(node, source)) {
        // `isStepRunCall` has already required two arguments; this narrows the
        // indexed access for the checker rather than asserting past it.
        const [first] = node.arguments;
        if (!first) return;
        const type = checker.getTypeAtLocation(node);
        const awaited = checker.getAwaitedType(type) ?? type;
        const idKind: StepIdKind = ts.isStringLiteralLike(first)
          ? 'literal'
          : ts.isIdentifier(first)
            ? 'forwarded'
            : 'expression';
        sites.push({
          file: toPosix(file),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          stepId: ts.isStringLiteral(first) ? first.text : first.getText(source),
          idKind,
          shape: fingerprintOf(awaited, checker, node, root),
          consumption: consumptionOf(node),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
