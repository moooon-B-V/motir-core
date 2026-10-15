import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

// THE LIVE PATHS' REFRESH SCAN (Story MOTIR-8539 · Subtask MOTIR-8578).
//
// Pure functions behind `tests/architecture/no-refresh-on-live-paths.test.ts`,
// kept apart from it so the guard's bite fixtures drive the identical code over a
// temp tree. Three questions, three functions:
//
//   · `resolveImports(file)` — a file's first-party edges: static imports,
//     `export … from` re-exports and `import('literal')`, each resolved by the
//     TypeScript resolver itself under the repo's own compiler options (so the
//     `@/` alias, extensionless specifiers and `index` files resolve exactly as
//     the build resolves them). Type-only imports are erased by the compiler and
//     are not edges.
//   · `reachableFrom(roots)` — the closure, each file with the import chain that
//     first reached it, so a finding names the path a reviewer has to walk.
//   · `findRefreshCalls(source, fileName)` — the forbidden shapes, read from the
//     AST: a comment or a string that QUOTES `router.refresh()` is not a call.
//
// ⚠️ THE WALK'S BOUNDARY IS PART OF THE CONTRACT. It stops at anything outside
// the repository (`node_modules`, `next/*`), at `lib/navigation/coordinatedRefresh`
// (importing it is the finding, not a place to scan), and at the server-only
// `lib/services/**` and `lib/repositories/**`: a client live path reaches the
// server only through a `fetch`, and those modules cannot hold a client router.

export const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** A module the walk never enters. */
export const COORDINATED_REFRESH = 'lib/navigation/coordinatedRefresh.tsx';
const SERVER_ONLY = [/^lib\/services\//, /^lib\/repositories\//];
const SOURCE = /\.(ts|tsx)$/;
const DECLARATION = /\.d\.ts$/;

export type RefreshKind =
  | 'router.refresh'
  | 'useCoordinatedRefresh'
  | 'coordinatedRefresh import'
  | 'window.location navigation';

export interface RefreshFinding {
  line: number;
  kind: RefreshKind;
  /** The nearest named enclosing function, variable, property or JSX attribute. */
  symbol: string;
}

export interface ImportEdge {
  specifier: string;
  /** Repo-relative path of the first-party module, or `null` when it is not one. */
  resolved: string | null;
}

const toPosix = (p: string) => p.split(sep).join('/');

// ── Compiler options, read from the root's own `tsconfig.json` ───────────────

const optionsCache = new Map<string, ts.CompilerOptions>();

/** `tsconfig.json`'s options (its `extends` chain followed) — never its file globs. */
function compilerOptionsFor(root: string): ts.CompilerOptions {
  const cached = optionsCache.get(root);
  if (cached) return cached;
  const configPath = join(root, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(`cannot read ${configPath}`);
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    // The include set is irrelevant to resolution; enumerating it is a whole-tree walk.
    readDirectory: () => [],
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
  };
  const parsed = ts.parseJsonConfigFileContent(read.config, host, root, undefined, configPath);
  optionsCache.set(root, parsed.options);
  return parsed.options;
}

// ── Edges ─────────────────────────────────────────────────────────────────────

function parse(source: string, fileName: string): ts.SourceFile {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

/** Every specifier the file loads at runtime. */
function specifiersOf(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
        out.push(node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        out.push(node.moduleSpecifier.text);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** `file` (repo-relative) → its runtime import edges, resolved. */
export function resolveImports(file: string, root: string = REPO_ROOT): ImportEdge[] {
  const absolute = join(root, file);
  const sf = parse(readFileSync(absolute, 'utf8'), absolute);
  const options = compilerOptionsFor(root);
  return specifiersOf(sf).map((specifier) => {
    const hit = ts.resolveModuleName(specifier, absolute, options, ts.sys).resolvedModule;
    if (!hit || hit.isExternalLibraryImport) return { specifier, resolved: null };
    const rel = toPosix(relative(root, hit.resolvedFileName));
    const firstParty =
      !rel.startsWith('..') &&
      !rel.split('/').includes('node_modules') &&
      SOURCE.test(rel) &&
      !DECLARATION.test(rel);
    return { specifier, resolved: firstParty ? rel : null };
  });
}

/** Whether the walk scans `file`, or stops at it. */
function walkable(file: string): boolean {
  return file !== COORDINATED_REFRESH && !SERVER_ONLY.some((p) => p.test(file));
}

/**
 * Every first-party file reachable from `roots`, each with the chain of files from
 * a root to it (the root first, the file last). Breadth-first, so each chain is a
 * shortest one.
 */
export function reachableFrom(
  roots: readonly string[],
  root: string = REPO_ROOT,
): Map<string, string[]> {
  const chains = new Map<string, string[]>();
  const queue: string[] = [];
  for (const r of roots) {
    if (!existsSync(join(root, r))) throw new Error(`root ${r} does not exist`);
    if (!chains.has(r)) {
      chains.set(r, [r]);
      queue.push(r);
    }
  }
  while (queue.length > 0) {
    const file = queue.shift()!;
    const chain = chains.get(file)!;
    for (const { resolved } of resolveImports(file, root)) {
      if (resolved === null || chains.has(resolved) || !walkable(resolved)) continue;
      chains.set(resolved, [...chain, resolved]);
      queue.push(resolved);
    }
  }
  return chains;
}

// ── Findings ─────────────────────────────────────────────────────────────────

const GLOBALS = new Set(['window', 'globalThis', 'self', 'document']);
const NAVIGATING = new Set(['assign', 'replace', 'reload']);
const COORDINATED_SPECIFIER = /(^|\/)navigation\/coordinatedRefresh(\.tsx?)?$/;

/** `window.location`, `document.location`, … or a bare `location`. */
function isLocation(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === 'location';
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'location' &&
    ts.isIdentifier(node.expression) &&
    GLOBALS.has(node.expression.text)
  );
}

/** A `useRouter()` call, however the hook is reached. */
function isUseRouterCall(node: ts.Node | undefined): boolean {
  return (
    node !== undefined &&
    ts.isCallExpression(node) &&
    ((ts.isIdentifier(node.expression) && node.expression.text === 'useRouter') ||
      (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'useRouter'))
  );
}

/** The nearest name a reviewer can find the node under. */
function symbolOf(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isJsxAttribute(at)) return at.name.getText();
    if (
      (ts.isFunctionDeclaration(at) ||
        ts.isMethodDeclaration(at) ||
        ts.isVariableDeclaration(at) ||
        ts.isPropertyAssignment(at) ||
        ts.isPropertyDeclaration(at)) &&
      at.name !== undefined &&
      (ts.isIdentifier(at.name) || ts.isStringLiteral(at.name))
    ) {
      return at.name.text;
    }
  }
  return '<module>';
}

/** The forbidden shapes in one source file. */
export function findRefreshCalls(source: string, fileName: string): RefreshFinding[] {
  const sf = parse(source, fileName);
  const routers = new Set<string>(['router']);
  const refreshes = new Set<string>();

  // Every name bound from `useRouter()` — `const r = useRouter()`, and
  // `const { refresh } = useRouter()` (whose bare `refresh()` is the same call).
  const bind = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && isUseRouterCall(node.initializer)) {
      if (ts.isIdentifier(node.name)) routers.add(node.name.text);
      else if (ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const key = el.propertyName ?? el.name;
          if (ts.isIdentifier(key) && key.text === 'refresh' && ts.isIdentifier(el.name)) {
            refreshes.add(el.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, bind);
  };
  bind(sf);

  const findings: RefreshFinding[] = [];
  const report = (node: ts.Node, kind: RefreshKind) =>
    findings.push({
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      kind,
      symbol: symbolOf(node),
    });

  const isRouterRef = (e: ts.Expression) =>
    (ts.isIdentifier(e) && routers.has(e.text)) ||
    (ts.isPropertyAccessExpression(e) && e.name.text === 'router') ||
    isUseRouterCall(e);

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (COORDINATED_SPECIFIER.test(node.moduleSpecifier.text)) {
        // The import IS the finding; its specifiers are not counted again.
        report(node, 'coordinatedRefresh import');
        return;
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === 'refresh' && isRouterRef(callee.expression)) {
          report(node, 'router.refresh');
        } else if (NAVIGATING.has(callee.name.text) && isLocation(callee.expression)) {
          report(node, 'window.location navigation');
        }
      } else if (ts.isIdentifier(callee) && refreshes.has(callee.text)) {
        report(node, 'router.refresh');
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = node.left;
      const assignsLocation =
        (ts.isPropertyAccessExpression(left) &&
          left.name.text === 'location' &&
          isLocation(left)) ||
        (ts.isPropertyAccessExpression(left) &&
          left.name.text === 'href' &&
          isLocation(left.expression));
      if (assignsLocation) report(node, 'window.location navigation');
    } else if (ts.isIdentifier(node) && node.text === 'useCoordinatedRefresh') {
      report(node, 'useCoordinatedRefresh');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

export interface LocatedFinding extends RefreshFinding {
  file: string;
  chain: string[];
}

/** Every finding in the closure of `roots`, with the chain that reached its file. */
export function scanLivePaths(
  roots: readonly string[],
  root: string = REPO_ROOT,
): { closure: Map<string, string[]>; findings: LocatedFinding[] } {
  const closure = reachableFrom(roots, root);
  const findings: LocatedFinding[] = [];
  for (const [file, chain] of closure) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const f of findRefreshCalls(source, file)) findings.push({ ...f, file, chain });
  }
  return { closure, findings };
}
