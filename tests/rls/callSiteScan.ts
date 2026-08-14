import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { policyGatedModels } from './singletonReadScan';

// The CALL-SITE scanner (MOTIR-2845) — the other half of MOTIR-2784's guard.
//
// ── The blind spot this closes ──────────────────────────────────────────────
// `singletonReadScan.ts` reads `lib/repositories/` and asks whether a read is
// BINDABLE: does it resolve `const client = tx ?? db`? That question has two
// answers and only one of them is a defect it can see.
//
//   the read CANNOT take a `tx`            → the singleton scan reports it
//   the read CAN, and the CALLER passes none → invisible to it
//
// The second is the same bug with the same symptom: no GUC is bound, the policy
// sees NULL, the read returns ZERO ROWS WITHOUT RAISING, and the caller reports
// "missing" for a row that exists. It is arguably worse, because the repository
// looks correct in review — the parameter is right there, unused.
//
// MOTIR-2796 was partitioned from the singleton scan's output, so it named
// fifty-five repository METHODS and no call sites at all. Three instances were
// then hit while running that story's own cards, each found only by a red suite
// (`notes.html` #266):
//
//   * savedFilterSubscriptionsService — every scheduled delivery reported
//     `subscription_gone`; fixed under MOTIR-2805.
//   * backlogService — 49 failures in tests/integration/sprints, all
//     `WorkItemNotFoundError` / `SprintNotFoundError` for rows that exist.
//   * workItemsService.updateStatus — a bare `db.$transaction`, which binds
//     nothing at all.
//
// ── The four POSITIONS it can reach on its own ──────────────────────────────
// It classifies a call to a bindable, policy-gated read by where it sits. Only
// the first is not a finding:
//
//   `receives-tx`         a `tx` from a GUC-binding context reaches the read.
//   `in-bare-transaction` the read runs inside a bare `db.$transaction`. The
//                         most deceptive shape: the reads share a transaction,
//                         so it LOOKS bound, and no GUC is set on it.
//   `in-context`          a binding transaction is open and in lexical scope and
//                         the read does not take it — the fix is one argument.
//   `no-context`          no transaction of any kind up the chain.
//
// The guard test carries the per-site verdicts, exactly as the singleton guard
// does: the machine enumerates, a human adjudicates, and an unadjudicated site
// fails the build.
//
// ── What it deliberately does NOT decide, and cannot ────────────────────────
//  1. **Whether an unbound site is a BUG.** A public-arm read (which must run
//     UNBOUND — `work_item_public_project_read` fires only when
//     `app.workspace_id` is unset), a pre-auth path, an operator script and a
//     service that simply forgot are indistinguishable from the syntax. That is
//     the verdict list's job, and `publicProjectsService` is why the distinction
//     is not academic: binding those would BREAK the public pages.
//  2. **Transitive forwarding.** A helper that takes its own `tx?` and forwards
//     it reads as `receives-tx` even when ITS caller passes nothing — the gap
//     moves up one frame and this scanner does not follow it. Whole-program
//     dataflow would; the cost is not worth it while the direct sites are
//     unfixed, and the guard pins that limit with a fixture case rather than
//     leaving it implicit.
//  3. **Whether `tx` IS the transaction.** The check is a NAME match, plus the
//     TYPE where a local callback declares one (MOTIR-2846 — see
//     `enclosingTxParams` and `passesTx`, which also read through a `tx ?? t`).
//     Resolving the symbol needs a full program and buys little — `tx` is this
//     codebase's universal name for it, and a false `receives-tx` costs one
//     under-reported site rather than a wrong fix.
//  4. **Test call sites.** Out of scope entirely: that population is
//     MOTIR-2797's and MOTIR-2830's, and it has its own classifier.

const REPO_DIR = 'lib/repositories';
const SCAN_ROOTS = ['lib', 'app'];
const SINGLETON = 'db';

/** The wrappers that bind at least one RLS GUC on the transaction they open. */
const BINDING_CONTEXTS = new Set([
  'withWorkspaceContext',
  'withWorkspaceServiceContext',
  'withUserContext',
  'withSystemContext',
  'withOrgServiceWriteContext',
  'withOrgContext',
]);

export type CallSitePosition =
  /** A `tx` from a GUC-BINDING context reaches the read. Not a finding. */
  | 'receives-tx'
  /**
   * The read runs inside a BARE `db.$transaction` — whether or not it receives
   * that `tx`. A finding, and the most deceptive one: the reads share a
   * transaction, so it LOOKS bound, and no GUC is set on it. This is the case
   * `lib/workspaces/tenantRead.ts` spells out — *"do not pass a transaction that
   * binds no GUCs"*.
   */
  | 'in-bare-transaction'
  /**
   * A GUC-binding transaction is open and in lexical scope, and the read does
   * not take it. A finding — the fix is one argument.
   */
  | 'in-context'
  /** No transaction of any kind up the chain. A finding. */
  | 'no-context';

export interface BindableRead {
  /** e.g. `workItemRepository` — the exported object the method hangs off. */
  repository: string;
  /** e.g. `findByIds` */
  method: string;
  /** `workItemRepository.findByIds` */
  key: string;
  /** the policy-gated Prisma models it addresses, sorted; empty for raw SQL */
  models: string[];
  raw: boolean;
}

export interface CallSite {
  /** repo-relative, e.g. `lib/services/backlogService.ts` */
  file: string;
  line: number;
  /** `workItemRepository.findByIds` */
  read: string;
  position: CallSitePosition;
  /** `file#repository.method` — the allowlist key (line-independent on purpose:
   *  a site that moves down the file must not need re-adjudicating). */
  key: string;
}

// ── Step 1: the bindable, policy-gated reads ────────────────────────────────

/** Does this parameter list carry an OPTIONAL `tx: Prisma.TransactionClient`? */
function hasOptionalTxParam(params: ts.NodeArray<ts.ParameterDeclaration>): boolean {
  return params.some(
    (p) =>
      ts.isIdentifier(p.name) &&
      p.name.text === 'tx' &&
      p.questionToken !== undefined &&
      p.type !== undefined &&
      p.type.getText().includes('TransactionClient'),
  );
}

/** The identifier a `const <x> = tx ?? db` binds, if the method has one. */
function txFallbackAlias(body: ts.Node): string | undefined {
  let alias: string | undefined;
  const visit = (n: ts.Node): void => {
    if (
      alias === undefined &&
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isBinaryExpression(n.initializer) &&
      n.initializer.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      ts.isIdentifier(n.initializer.right) &&
      n.initializer.right.text === SINGLETON
    ) {
      alias = n.name.text;
    }
    if (alias === undefined) ts.forEachChild(n, visit);
  };
  visit(body);
  return alias;
}

/** Models / raw-SQL addressed off `alias` (or off `tx` directly). */
function accessesOff(
  node: ts.Node,
  aliases: readonly string[],
): { models: Set<string>; raw: boolean } {
  const models = new Set<string>();
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
      } else {
        models.add(name);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return { models, raw };
}

/**
 * Every repository read that CAN be bound — it takes an optional
 * `tx: Prisma.TransactionClient` — and whose target is policy-gated.
 *
 * A read of a table with no policy is not a finding however it is called, which
 * is why the gating filter runs here rather than at the call site: `user` carries
 * no policy at all, so `userRepository.findByIds` is correct unbound.
 */
export function bindableGatedReads(root = process.cwd()): BindableRead[] {
  const gated = policyGatedModels(root);
  const dir = path.join(root, REPO_DIR);
  const out: BindableRead[] = [];

  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()) {
    const repository = file.replace(/\.ts$/, '');
    const full = path.join(dir, file);
    const sf = ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.body) {
        if (hasOptionalTxParam(node.parameters)) {
          const alias = txFallbackAlias(node.body);
          const { models, raw } = accessesOff(node.body, alias ? [alias, 'tx'] : ['tx']);
          const tenant = [...models].filter((m) => gated.has(m)).sort();
          if (tenant.length > 0 || raw) {
            const method = node.name.text;
            out.push({
              repository,
              method,
              key: `${repository}.${method}`,
              models: tenant,
              raw,
            });
          }
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

// ── Step 2: where those reads are called from ───────────────────────────────

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      yield* walk(full);
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      yield full;
    }
  }
}

/**
 * FORWARDING HELPERS — the blind spot one frame up (MOTIR-2846, second pass).
 *
 * A service factors its tenant gate into a module-local helper that takes its own
 * `tx?: Prisma.TransactionClient`, hands it to a bindable read, and — when the
 * caller supplies none — falls through to the `@/lib/db` singleton:
 *
 *   async function resolveComponent(id, ctx, tx?: Prisma.TransactionClient) {
 *     const component = await componentRepository.findById(id, tx);   // <- forwards
 *     …
 *   }
 *
 * Reading only the direct call sites, that inner line looks BOUND — the `tx` is
 * right there. It is bound exactly when the caller passed one, and every caller
 * that did not has the full defect: the read returns nothing and the helper
 * raises `…NotFoundError` for a row that exists. `backlogService.loadItem`,
 * `bulkAssignToSprint`'s sprint resolve and `componentsService.resolveComponent`
 * were all this shape, and between them they accounted for the bulk of the
 * `TEST_DB_APP_ROLE=1` failures that survived binding every direct site.
 *
 * So a helper of this shape is itself treated as a bindable gated read, keyed
 * `<file>#<name>`, and its own call sites are classified like any other. That
 * moves the scan up exactly ONE frame — a helper calling a helper is still out of
 * reach, and the guard's fixture pins that limit rather than leaving it implicit.
 */
function forwardingHelpers(root: string, reads: Map<string, BindableRead>): BindableRead[] {
  const out: BindableRead[] = [];

  for (const scanRoot of SCAN_ROOTS) {
    const abs = path.join(root, scanRoot);
    try {
      statSync(abs);
    } catch {
      continue;
    }
    for (const full of walk(abs)) {
      const rel = path.relative(root, full);
      if (rel.startsWith(REPO_DIR)) continue;
      const sf = ts.createSourceFile(
        full,
        readFileSync(full, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );

      const consider = (
        name: string,
        params: ts.NodeArray<ts.ParameterDeclaration>,
        body: ts.Node,
      ): void => {
        if (!hasOptionalTxParam(params)) return;
        // A helper that opens a BINDING CONTEXT of its own has handled the
        // undefined-`tx` case — the shape is `tx ? read(…, tx) : withXContext(…)`
        // — so it is not a gap and its callers owe nothing. Without this, fixing a
        // helper would leave its every call site reported forever.
        let bindsItself = false;
        const seekBinding = (n: ts.Node): void => {
          if (
            !bindsItself &&
            ts.isCallExpression(n) &&
            ts.isIdentifier(n.expression) &&
            BINDING_CONTEXTS.has(n.expression.text)
          ) {
            bindsItself = true;
          }
          if (!bindsItself) ts.forEachChild(n, seekBinding);
        };
        seekBinding(body);
        if (bindsItself) return;

        // Does it FORWARD that `tx` into a bindable gated read?
        let forwards = false;
        const seek = (n: ts.Node): void => {
          if (
            !forwards &&
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            ts.isIdentifier(n.expression.expression) &&
            reads.has(`${n.expression.expression.text}.${n.expression.name.text}`) &&
            n.arguments.some((a) => ts.isIdentifier(a) && a.text === 'tx')
          ) {
            forwards = true;
          }
          if (!forwards) ts.forEachChild(n, seek);
        };
        seek(body);
        if (!forwards) return;
        out.push({ repository: rel, method: name, key: `${rel}.${name}`, models: [], raw: false });
      };

      const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name && node.body) {
          consider(node.name.text, node.parameters, node.body);
        } else if (
          ts.isMethodDeclaration(node) &&
          node.name &&
          ts.isIdentifier(node.name) &&
          node.body
        ) {
          consider(node.name.text, node.parameters, node.body);
        } else if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
          node.initializer.body
        ) {
          consider(node.name.text, node.initializer.parameters, node.initializer.body);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return out;
}

/**
 * The parameter names of every enclosing binding-context callback, innermost
 * first. Empty when the node sits in no bound transaction.
 *
 * A bare `db.$transaction` contributes its parameter too — the reads inside it
 * genuinely DO share a transaction — but the caller is told which kind it was
 * so it can report the GUC-less case separately.
 */
function enclosingContexts(node: ts.Node): Array<{ param: string | undefined; binding: boolean }> {
  const found: Array<{ param: string | undefined; binding: boolean }> = [];
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (!ts.isArrowFunction(n) && !ts.isFunctionExpression(n)) continue;
    const call = n.parent;
    if (!ts.isCallExpression(call)) continue;
    const callee = call.expression;
    let name: string | undefined;
    let binding = false;
    if (ts.isIdentifier(callee) && BINDING_CONTEXTS.has(callee.text)) {
      name = callee.text;
      binding = true;
    } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === '$transaction') {
      name = '$transaction';
      binding = false;
    }
    if (!name) continue;
    const p = n.parameters[0];
    found.push({
      param: p && ts.isIdentifier(p.name) ? p.name.text : undefined,
      binding,
    });
  }
  return found;
}

/**
 * Parameter names, of any enclosing function, that are ANNOTATED as a
 * transaction client — `(t: Prisma.TransactionClient) => …`.
 *
 * A service often factors its write half into a local `const write = async (t:
 * Prisma.TransactionClient) => { … }` and hands that to `withWorkspaceContext`
 * (or to a caller-supplied `tx`). A read inside it that is given `t` IS bound —
 * by whichever transaction the local was invoked with — so classifying it
 * `no-context` reports a defect that does not exist. The TYPE is the evidence:
 * nothing but a transaction client can be passed for that parameter, and the
 * obligation to bind moves to the local's call sites, which this scanner sees
 * on their own.
 */
function enclosingTxParams(node: ts.Node): string[] {
  const names: string[] = [];
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (
      !ts.isArrowFunction(n) &&
      !ts.isFunctionExpression(n) &&
      !ts.isFunctionDeclaration(n) &&
      !ts.isMethodDeclaration(n)
    ) {
      continue;
    }
    for (const p of n.parameters) {
      if (!ts.isIdentifier(p.name) || !p.type) continue;
      if (/\bTransactionClient\b/.test(p.type.getText())) names.push(p.name.text);
    }
  }
  return names;
}

/** Is this call the helper calling ITSELF? Recursion is not a fresh call site. */
function isDeclarationOf(node: ts.Node, name: string): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) return true;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Does this argument list carry something that could BE the transaction?
 *
 * A NAME match, deliberately — resolving the symbol would need a full program
 * and buys little: `tx` is the codebase's universal name for it, and the
 * consequence of a false `receives-tx` is one under-reported site rather than a
 * wrong fix. `as` casts are unwrapped because a `tx as never` at a fixture
 * boundary is still the transaction.
 */
function passesTx(args: ts.NodeArray<ts.Expression>, candidates: readonly string[]): boolean {
  const unwrap = (e: ts.Expression): ts.Expression =>
    ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isParenthesizedExpression(e)
      ? unwrap(e.expression)
      : e;
  const isTx = (raw: ts.Expression): boolean => {
    const a = unwrap(raw);
    if (ts.isIdentifier(a)) return a.text === 'tx' || candidates.includes(a.text);
    // `opts.tx`, `this.tx` — the property name is what matters.
    if (ts.isPropertyAccessExpression(a)) return a.name.text === 'tx';
    // `tx ?? t` — the shipped shape for "join the caller's transaction, else the
    // one this method opened". BOTH arms must be a transaction for the argument
    // to be one, which is exactly what the operator guarantees here.
    if (ts.isBinaryExpression(a) && a.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return isTx(a.left) && isTx(a.right);
    }
    return false;
  };
  return args.some(isTx);
}

/**
 * Every production call site of a bindable, policy-gated read, classified by
 * whether it binds. Test files are OUT of scope — that population is
 * MOTIR-2797's and MOTIR-2830's, measured by their own classifier.
 */
export function scanCallSites(root = process.cwd()): CallSite[] {
  const reads = new Map(bindableGatedReads(root).map((r) => [r.key, r]));
  // …plus the module-local helpers that FORWARD a `tx?` into one of those reads,
  // grouped by the file that declares them: they are called as a bare identifier,
  // not off an object, so the visitor below matches them separately.
  const helpersByFile = new Map<string, Set<string>>();
  for (const h of forwardingHelpers(root, reads)) {
    const set = helpersByFile.get(h.repository);
    if (set) set.add(h.method);
    else helpersByFile.set(h.repository, new Set([h.method]));
  }
  const out: CallSite[] = [];

  for (const scanRoot of SCAN_ROOTS) {
    const abs = path.join(root, scanRoot);
    let exists = true;
    try {
      statSync(abs);
    } catch {
      exists = false;
    }
    if (!exists) continue;

    for (const full of walk(abs)) {
      const rel = path.relative(root, full);
      if (rel.startsWith(REPO_DIR)) continue;
      const sf = ts.createSourceFile(
        full,
        readFileSync(full, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );

      const localHelpers = helpersByFile.get(rel) ?? new Set<string>();

      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const name = node.expression.text;
          // A call to one of THIS file's forwarding helpers. Position is decided
          // exactly as for a repository read: does a bound `tx` reach it?
          if (localHelpers.has(name) && !isDeclarationOf(node, name)) {
            const contexts = enclosingContexts(node);
            const params = [
              ...contexts.map((c) => c.param).filter((p): p is string => p !== undefined),
              ...enclosingTxParams(node),
            ];
            const innermost = contexts[0];
            let position: CallSitePosition;
            if (innermost && !innermost.binding) position = 'in-bare-transaction';
            else if (passesTx(node.arguments, params)) position = 'receives-tx';
            else if (contexts.length > 0) position = 'in-context';
            else position = 'no-context';
            out.push({
              file: rel,
              line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
              read: name,
              position,
              key: `${rel}#${name}`,
            });
          }
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression)
        ) {
          const key = `${node.expression.expression.text}.${node.expression.name.text}`;
          if (reads.has(key)) {
            const contexts = enclosingContexts(node);
            const params = [
              ...contexts.map((c) => c.param).filter((p): p is string => p !== undefined),
              ...enclosingTxParams(node),
            ];
            // The INNERMOST enclosing transaction decides, because that is the
            // one whose `tx` is in scope at the call. A bound context wrapping a
            // bare `$transaction` does not rescue a read inside the inner one:
            // the inner transaction is a different connection with no GUCs.
            const innermost = contexts[0];
            let position: CallSitePosition;
            if (innermost && !innermost.binding) {
              position = 'in-bare-transaction';
            } else if (passesTx(node.arguments, params)) {
              position = 'receives-tx';
            } else if (contexts.length > 0) {
              position = 'in-context';
            } else {
              position = 'no-context';
            }
            out.push({
              file: rel,
              line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
              read: key,
              position,
              key: `${rel}#${key}`,
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key) || a.line - b.line);
}

/** The unbound sites — everything the guard has to carry a verdict for. */
export function unboundCallSites(root = process.cwd()): CallSite[] {
  return scanCallSites(root).filter((c) => c.position !== 'receives-tx');
}

/**
 * Service functions that open a BARE `db.$transaction` — a transaction that
 * binds no GUCs at all.
 *
 * Reported separately because it is a distinct and sharper defect: the reads
 * inside share a snapshot, so they look bound, and a `tx` handed from one into
 * `readProject` / `readProjectByIdentifier` is exactly the case
 * `lib/workspaces/tenantRead.ts` warns about — the read sees NULL context and
 * reports the row missing. Repositories are excluded (a repository never opens
 * a transaction, per CLAUDE.md), as is `lib/workspaces/context.ts` itself,
 * which is where the bound wrappers are DEFINED.
 */
export function bareTransactionSites(root = process.cwd()): Array<{ file: string; line: number }> {
  const out: Array<{ file: string; line: number }> = [];
  const skip = new Set(['lib/workspaces/context.ts', 'lib/organizations/context.ts']);

  for (const scanRoot of SCAN_ROOTS) {
    const abs = path.join(root, scanRoot);
    try {
      statSync(abs);
    } catch {
      continue;
    }
    for (const full of walk(abs)) {
      const rel = path.relative(root, full);
      if (rel.startsWith(REPO_DIR) || skip.has(rel)) continue;
      const sf = ts.createSourceFile(
        full,
        readFileSync(full, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === SINGLETON &&
          node.expression.name.text === '$transaction'
        ) {
          out.push({
            file: rel,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
