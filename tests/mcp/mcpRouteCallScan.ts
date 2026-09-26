import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

// MOTIR-6408 — every in-process call to an `/api/mcp` route handler in a test
// is TRACKED, or it is a finding.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// The MCP SDK's `StreamableHTTPClientTransport` opens an SSE-stream GET after
// `initialize` and never awaits it. Driven in-process, that GET runs the auth
// gate and spends one `mcp:call` (a `rate_limit_counter` INSERT inside a
// transaction) before the route answers 405 — so a short test can end while it
// is still inside that transaction, and the suite-wide in-flight probe
// (`tests/helpers/inFlightProbe.ts`, MOTIR-6278) fails whichever test it lands
// in. MOTIR-6324 fixed the harness: `tests/helpers/mcpRouteFetch.ts` wraps
// every handler call in `trackServerWork` (`tests/helpers/serverWork.ts`), and
// the probe settles tracked work before it looks.
//
// That fix was applied by MIGRATING FILES, and a migration covers only the
// files that exist when its branch is cut. Two transport tests that landed 58
// minutes earlier kept a private untracked `routeFetch` and went on redding
// unrelated pull requests at random (MOTIR-6408, the fourth bug on this path).
// This scan is what stops a new test re-growing that copy.
//
// ── What counts as a call, and why it needs an AST ──────────────────────────
// The untracked shape never calls `route.GET(…)` on one line. It picks the
// handler in a ternary, binds it to a local, and calls the local:
//
//   const handler = method === 'GET' ? route.GET : method === 'DELETE' ? route.DELETE : route.POST;
//   return handler(new Request(url, { ...init, headers }) as never);
//
// while `tests/mcp/route.test.ts` REFERENCES the same three handlers without
// calling any of them (`expect(route.GET).toBe(route.POST)`). A grep cannot
// tell those apart; the syntax tree can. So every reference to a handler is
// followed to where it goes:
//
//   - CALLED (directly, or through a local it was bound to) → the call must be
//     the first argument of `trackServerWork(…)`. Nothing else discharges it —
//     not an `await`, which is correct today and is exactly the call a later
//     edit turns into a returned promise.
//   - COMPARED or TYPE-QUERIED (`expect(…)`, `.toBe(…)`, `typeof`) → inert.
//   - Anything else — stored, passed, returned — ESCAPES, and is a finding: the
//     call then happens somewhere this scan cannot see.
//
// The route MODULE handed on whole (`tests/helpers/mcpHttpServer.ts` maps it
// into a request dispatcher) is the one escape a file can discharge by
// tracking at the dispatcher, so it passes only where the file itself calls
// `trackServerWork`.
//
// It fails CLOSED: a dynamic `import()` of the route it cannot bind to a name
// is a finding, never a skip.

const TESTS_DIR = 'tests';
const HANDLERS = new Set(['GET', 'POST', 'DELETE']);
const ROUTE_SPECIFIER = /(?:^@\/|^\.{1,2}\/(?:.*\/)?)app\/api\/mcp\/route(?:\.[cm]?[tj]sx?)?$/;
const TRACKER = 'trackServerWork';
const COMPARATORS = new Set(['toBe', 'toEqual', 'toStrictEqual', 'not']);

/**
 * Untracked calls that are the POINT of the file, keyed `<file>:<enclosing function>`.
 *
 * An entry is a reviewed act with a reason, and the guard asserts each one
 * still matches a real finding, so an entry cannot outlive its call site.
 * ⚠️ This exempts a call from THIS scan only. No test is exempted from the
 * in-flight probe: an exempted test still has to leave nothing running.
 */
export const UNTRACKED_BY_DESIGN: Readonly<Record<string, string>> = {
  'tests/mcp/sdkSseGetSettled.test.ts:untrackedRouteFetch':
    "MOTIR-6324's REPRODUCTION control. It drives the pre-fix untracked harness on purpose, to show the SDK's SSE GET holding the rate-limit transaction open with pendingServerWork() at 0; the test then waits for inFlightBackends() to drain itself, so it leaves the probe nothing.",
};

export type UntrackedMcpRouteCall = {
  /** Repo-relative, `/`-separated. */
  file: string;
  line: number;
  column: number;
  /** `call` — an untracked invocation; `escape` — a handler or the module handed on; `unbound` — an `import()` the scan cannot follow. */
  shape: 'call' | 'escape' | 'unbound';
  /** The nearest enclosing named function, or `<module>`. */
  enclosing: string;
  text: string;
};

/** `<file>:<line>:<column> [<shape>] <text>` — the form a failure message prints. */
export function describeFinding(f: UntrackedMcpRouteCall): string {
  return `${f.file}:${f.line}:${f.column} [${f.shape}] ${f.text}`;
}

export function exemptionKey(f: UntrackedMcpRouteCall): string {
  return `${f.file}:${f.enclosing}`;
}

/** Strip the wrappers that do not change which value an expression is. */
function climb(node: ts.Node): ts.Node {
  let cur = node;
  for (;;) {
    const p = cur.parent;
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      (ts.isConditionalExpression(p) && p.condition !== cur) ||
      (ts.isBinaryExpression(p) &&
        [
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.AmpersandAmpersandToken,
        ].includes(p.operatorToken.kind))
    ) {
      cur = p;
      continue;
    }
    return cur;
  }
}

function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/** Is `call` (an invocation) the first argument of `trackServerWork(…)`? */
function isTracked(call: ts.CallExpression): boolean {
  const top = climb(call);
  const p = top.parent;
  return ts.isCallExpression(p) && calleeName(p) === TRACKER && p.arguments[0] === top;
}

/** Is the value at `top` only compared or type-queried? */
function isInert(top: ts.Node): boolean {
  const p = top.parent;
  if (ts.isTypeOfExpression(p)) return true;
  if (ts.isCallExpression(p) && p.arguments.includes(top as ts.Expression)) {
    const name = calleeName(p);
    return name === 'expect' || (name !== undefined && COMPARATORS.has(name));
  }
  return false;
}

function enclosingName(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    if (
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      ts.isVariableDeclaration(cur.parent) &&
      ts.isIdentifier(cur.parent.name)
    ) {
      return cur.parent.name.text;
    }
  }
  return '<module>';
}

/** The route module's `import('…')`, if `node` is one. */
function isRouteImportCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]!) &&
    ROUTE_SPECIFIER.test(node.arguments[0].text)
  );
}

/** Every untracked `/api/mcp` handler call in one source file. Pure: parses the text it is handed. */
export function scanSource(file: string, source: string): UntrackedMcpRouteCall[] {
  if (!source.includes('api/mcp/route')) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const modules = new Set<string>();
  const handlers = new Set<string>();
  const findings: UntrackedMcpRouteCall[] = [];

  const report = (node: ts.Node, shape: UntrackedMcpRouteCall['shape']) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({
      file,
      line: line + 1,
      column: character + 1,
      shape,
      enclosing: enclosingName(node),
      text: node.getText(sf).split('\n')[0]!.trim(),
    });
  };

  const bindPattern = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) modules.add(name.text);
    else if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) {
        const key = el.propertyName ?? el.name;
        if (ts.isIdentifier(key) && HANDLERS.has(key.text) && ts.isIdentifier(el.name)) {
          handlers.add(el.name.text);
        }
      }
    }
  };

  // Pass 1 — the names the route module and its handlers are bound to.
  const bind = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      ROUTE_SPECIFIER.test(node.moduleSpecifier.text) &&
      node.importClause &&
      !node.importClause.isTypeOnly
    ) {
      const { name, namedBindings } = node.importClause;
      if (name) modules.add(name.text);
      if (namedBindings && ts.isNamespaceImport(namedBindings))
        modules.add(namedBindings.name.text);
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const el of namedBindings.elements) {
          if (!el.isTypeOnly && HANDLERS.has((el.propertyName ?? el.name).text)) {
            handlers.add(el.name.text);
          }
        }
      }
    }
    if (isRouteImportCall(node)) {
      let top: ts.Node = climb(node);
      if (ts.isAwaitExpression(top.parent)) top = climb(top.parent);
      if (ts.isVariableDeclaration(top.parent) && top.parent.initializer === top) {
        bindPattern(top.parent.name);
      } else {
        report(node, 'unbound');
      }
    }
    ts.forEachChild(node, bind);
  };
  bind(sf);
  if (modules.size === 0 && handlers.size === 0) return findings;

  const tracksAnything = new RegExp(`\\b${TRACKER}\\s*\\(`).test(source);
  const aliases = new Map<string, ts.Node>();

  /** Follow one reference to a handler (or a local bound to one) to where it goes. */
  const follow = (ref: ts.Node) => {
    const top = climb(ref);
    const p = top.parent;
    if (ts.isCallExpression(p) && p.expression === top) {
      if (!isTracked(p)) report(p, 'call');
      return;
    }
    if (isInert(top)) return;
    // Bound to a local — every branch of a ternary lands here, once per handler.
    if (ts.isVariableDeclaration(p) && p.initializer === top && ts.isIdentifier(p.name)) {
      aliases.set(p.name.text, p);
      return;
    }
    report(top, 'escape');
  };

  const isDeclarationName = (id: ts.Identifier) =>
    (ts.isVariableDeclaration(id.parent) ||
      ts.isImportSpecifier(id.parent) ||
      ts.isNamespaceImport(id.parent) ||
      ts.isImportClause(id.parent) ||
      ts.isBindingElement(id.parent) ||
      ts.isParameter(id.parent)) &&
    (id.parent as { name?: ts.Node }).name === id;

  // Pass 2 — every reference to the module or a handler.
  const refs = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isDeclarationName(node)) {
      const p = node.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(p) && p.name === node) ||
        (ts.isPropertyAssignment(p) && p.name === node);
      if (!isPropertyName && modules.has(node.text)) {
        if (ts.isPropertyAccessExpression(p) && p.expression === node) {
          if (HANDLERS.has(p.name.text)) follow(p);
        } else if (ts.isElementAccessExpression(p) && p.expression === node) {
          const arg = p.argumentExpression;
          if (!ts.isStringLiteralLike(arg)) report(p, 'escape');
          else if (HANDLERS.has(arg.text)) follow(p);
        } else if (
          !ts.isTypeOfExpression(climb(node).parent) &&
          !ts.isTypeQueryNode(p) &&
          !ts.isQualifiedName(p) &&
          !tracksAnything
        ) {
          report(node, 'escape');
        }
      } else if (!isPropertyName && handlers.has(node.text)) {
        follow(node);
      }
    }
    ts.forEachChild(node, refs);
  };
  refs(sf);

  // Pass 3 — every use of a local a handler was bound to. Iterated, because a
  // local can be re-bound to another local.
  const seen = new Set<string>();
  while (aliases.size > seen.size) {
    const pending = [...aliases.keys()].filter((a) => !seen.has(a));
    for (const name of pending) seen.add(name);
    const uses = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && pending.includes(node.text) && !isDeclarationName(node)) {
        const p = node.parent;
        const isPropertyName = ts.isPropertyAccessExpression(p) && p.name === node;
        if (!isPropertyName) follow(node);
      }
      ts.forEachChild(node, uses);
    };
    uses(sf);
  }

  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.[cm]?tsx?$/.test(entry) && !/\.d\.[cm]?tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every untracked `/api/mcp` handler call under `tests/`, exemptions NOT applied. */
export function scanTests(root: string): UntrackedMcpRouteCall[] {
  return walk(join(root, TESTS_DIR), []).flatMap((full) =>
    scanSource(relative(root, full).split(sep).join('/'), readFileSync(full, 'utf8')),
  );
}
