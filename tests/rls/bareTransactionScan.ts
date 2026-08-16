import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { policyGatedModels } from './singletonReadScan';

// The BARE-TRANSACTION scanner (MOTIR-2876) — the THIRD axis, and the one the
// other two are structurally blind to.
//
// ── The question nobody was asking ──────────────────────────────────────────
// `singletonReadScan.ts` asks: does a repository read hit the `@/lib/db`
// SINGLETON with no `tx ?? db` fallback?
// `callSiteScan.ts` asks: does a bindable read's CALLER pass a `tx`?
//
// Both are questions about PLUMBING, and at every site MOTIR-2874 found by hand
// the answer to both was *yes*. The third question is about the transaction
// itself:
//
//     the caller passes a `tx` — but what did that transaction BIND?
//
// A `db.$transaction` binds no GUC at all. A read handed one is, to both
// scanners, perfectly well-behaved: it takes a `tx`, its caller supplies one, it
// never touches the singleton. It is also dead. `membership_visible_active_or_own`
// (and every policy like it) matches nothing, and an RLS-denied SELECT RETURNS
// FEWER ROWS AND RAISES NOTHING — so the class is invisible to the instruments
// AND to the suite.
//
// ── Why BOTH existing scanners miss it, precisely ───────────────────────────
// Not a coverage gap that a wider walk would close — a POPULATION gap, and it is
// worth being exact about it because the fix is not "scan more files".
//
// All three reads MOTIR-2874 found take a REQUIRED `tx`:
//
//     async countByUser(userId: string, tx: Prisma.TransactionClient)
//     async findMembersByWorkspace(workspaceId: string, tx: Prisma.TransactionClient)
//     async findByUserAndWorkspaceWithWorkspace(…, tx: Prisma.TransactionClient)
//
//   * `singletonReadScan` never sees them: they never mention `db`. Its whole
//     subject is the method that reads the singleton, and these do not.
//   * `callSiteScan` never sees them either: `bindableGatedReads` filters on
//     `hasOptionalTxParam`, which requires `p.questionToken !== undefined`. A
//     read whose `tx` is MANDATORY is not "bindable" by that definition, so it
//     never enters the bindable set and NONE of its call sites are classified —
//     including by `callSiteScan`'s own `in-bare-transaction` position, which
//     would otherwise have named all three.
//
// So a mandatory-`tx` read — the SAFEST-looking shape in the codebase, the one
// that cannot be called wrong — was the one shape no instrument covered.
//
// ── Why the existing bare-transaction ratchet did not catch it either ───────
// `callSiteScan.bareTransactionSites()` already ENUMERATES every bare
// `db.$transaction`, and `call-site-guard.test.ts` ratchets the COUNT at
// `BARE_TRANSACTION_CEILING = 29`. All three of MOTIR-2874's sites were inside
// that 29 and the ratchet was green, because a count cannot say WHICH sites are
// benign. The prose beside the number carried the actual claim —
//
//     "What remains encloses no policy-gated statement at all — user
//      preferences, rate-limit counters, CLI device codes, the tenant bootstrap
//      that runs before a workspace exists"
//
// — and that sentence was false three times over on the day it was written. This
// scanner exists to turn that human assertion into a machine one: the
// enumeration was never the missing half, the CLASSIFICATION was.
//
// ── What it deliberately does NOT decide ────────────────────────────────────
// Whether a flagged site is a BUG. The three exemption kinds are real and only a
// human can rule between them, so the guard test carries per-site verdicts, the
// same division of labour `singletonReadScan` and `callSiteScan` established:
// the machine enumerates, a human adjudicates, and an unadjudicated site fails
// the build.
//
// ── Reads AND writes, on purpose ────────────────────────────────────────────
// The card's axis is the READ, because that is the silent half. But the detector
// flags any gated STATEMENT and does not classify the operation, and that is the
// right rule rather than a widening: MOTIR-2846's second pass found
// `importPersistService` opening three bare transactions around policy-gated
// WRITES, where `tx.import.update()` matched zero rows under `motir_app` and
// failed the import outright. Its own note draws the conclusion — *"a bare
// transaction is not 'safe if it only writes'."* Telling the two apart would add
// a branch and subtract coverage.

const REPO_DIR = 'lib/repositories';
const SCAN_ROOTS = ['lib', 'app'];
const SINGLETON = 'db';

/**
 * Why a site carrying a bare `db.$transaction` is — or is not — a finding.
 *
 * The three kinds are the ones MOTIR-2876 named, and the ORDER matters: a
 * transaction that binds inline is not a finding however gated its statements
 * are, so `binds-inline` is decided first.
 */
export type BareTransactionVerdict =
  /**
   * FINDING. The body reaches a statement against a policy-gated table (or raw
   * SQL, whose target the parser cannot name) and the transaction binds no GUC.
   * Under `motir_app` the policy compares against NULL: a SELECT returns fewer
   * rows and raises nothing, a write matches nothing and raises nothing.
   */
  | 'gated-statement'
  /**
   * NOT a finding — the transaction binds its OWN GUCs inline, with a
   * `set_config('app.…')` in the body or in a same-file helper it hands the `tx`
   * to. This is the shape `withWorkspaceContext` and friends use internally, and
   * the shape `workspacesService.createWorkspace` (via `insertWorkspaceWithOwner`)
   * and `workspaceInvitesService`'s invite-accept (MOTIR-2777) use directly.
   *
   * ⚠️ Detected STRUCTURALLY rather than by filename, deliberately. A filename
   * list would exempt a file, not a transaction, so the next bare transaction
   * added to an already-listed file would inherit the exemption silently. It
   * also means the binding contexts in `lib/workspaces/context.ts` need no skip
   * entry — they are recognised by what they do.
   */
  | 'binds-inline'
  /**
   * NOT a finding — the body reaches no policy-gated table at all. This is what
   * the `BARE_TRANSACTION_CEILING` survivors were ASSERTED to be; this verdict is
   * the machine checking that assertion per site instead of in prose.
   */
  | 'no-gated-statement';

export interface BareTransactionSite {
  /** repo-relative, e.g. `lib/services/workspacesService.ts` */
  file: string;
  line: number;
  /** the enclosing function / method name, or `<module>` at top level */
  enclosing: string;
  /**
   * `file#enclosing` — LINE-INDEPENDENT on purpose, exactly as `callSiteScan`
   * keys its sites: a transaction that moves down its file is the same
   * adjudication, and keying on the line would make every unrelated edit a
   * re-review. A function opening two bare transactions carries one key and the
   * scan counts two sites.
   */
  key: string;
  verdict: BareTransactionVerdict;
  /** the policy-gated Prisma models the body reaches, sorted */
  models: string[];
  /** true when the body issues raw SQL whose target the parser cannot name */
  raw: boolean;
  /**
   * How each gated statement was reached — `tx.workspaceMembership`,
   * `workspaceMembershipRepository.countByUser`, `helper:insertWorkspaceWithOwner`.
   * Carried so a verdict can be re-checked without re-deriving the scan.
   */
  via: string[];
}

// ── Reaching the statements: the three hops ─────────────────────────────────

/** Models / raw-SQL addressed directly off one of `aliases`. */
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
 * Every repository method that issues a statement on a transaction client, keyed
 * `<repository>.<method>` — REGARDLESS of whether its `tx` is optional.
 *
 * ⚠️ That last clause is the entire point of this module, and the reason this
 * does not simply call `callSiteScan.bindableGatedReads()`. That function filters
 * on `hasOptionalTxParam`, because its question ("did the caller pass one?") only
 * makes sense where the caller had a choice. Here the caller always passes a
 * `tx` — the question is what the `tx` bound — so a MANDATORY `tx` is in scope,
 * and mandatory is exactly what all three of MOTIR-2874's reads were.
 */
export function repositoryStatementModels(
  root = process.cwd(),
): Map<string, { models: string[]; raw: boolean }> {
  const out = new Map<string, { models: string[]; raw: boolean }>();
  const dir = path.join(root, REPO_DIR);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  } catch {
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
          const { models, raw } = accessesOff(node.body, ['tx']);
          if (models.size > 0 || raw) {
            out.set(`${repository}.${node.name.text}`, { models: [...models].sort(), raw });
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

/** Does this subtree bind a GUC — a `set_config('app.…')` in real SQL? */
function bindsGucInline(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    // Matched on LITERAL nodes rather than on the subtree's source text, so a
    // COMMENT explaining `set_config(…, true)` — and several of these files
    // carry one — can never be mistaken for the call itself.
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      if (n.text.includes("set_config('app.")) found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** The module-local functions of a file, by name, with their `tx` parameter. */
function localHelpers(sf: ts.SourceFile): Map<string, { body: ts.Node; txParam?: string }> {
  const out = new Map<string, { body: ts.Node; txParam?: string }>();
  const record = (name: string, params: ts.NodeArray<ts.ParameterDeclaration>, body: ts.Node) => {
    // `tx` is this codebase's universal name for a transaction client; `t` is the
    // only other spelling in use (the local-callback form `callSiteScan` reads
    // through). Preferred in that order.
    const tx =
      params.find((p) => ts.isIdentifier(p.name) && p.name.text === 'tx') ??
      params.find((p) => ts.isIdentifier(p.name) && p.name.text === 't');
    out.set(name, {
      body,
      txParam: tx && ts.isIdentifier(tx.name) ? tx.name.text : undefined,
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
  }
  return '<module>';
}

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
 * Memoised per root, for the reason `callSiteScan` documents: the guard calls
 * these exports from several tests, and under `vitest run --coverage` the v8
 * provider instruments the compiler-API walk heavily enough that an unmemoised
 * re-scan blows the repo's 15 s `testTimeout`.
 */
const cache = new Map<string, BareTransactionSite[]>();

/**
 * Every bare `db.$transaction` in `lib/` + `app/`, classified by what its body
 * actually reaches.
 */
export function scanBareTransactions(root = process.cwd()): BareTransactionSite[] {
  const cached = cache.get(root);
  if (cached) return cached;

  const gated = policyGatedModels(root);
  const repoModels = repositoryStatementModels(root);
  const out: BareTransactionSite[] = [];

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
      const helpers = localHelpers(sf);

      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === SINGLETON &&
          node.expression.name.text === '$transaction'
        ) {
          out.push(classify(node, sf, rel, gated, repoModels, helpers));
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
  gated: Set<string>,
  repoModels: Map<string, { models: string[]; raw: boolean }>,
  helpers: Map<string, { body: ts.Node; txParam?: string }>,
): BareTransactionSite {
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const enclosing = enclosingName(node);
  const models = new Set<string>();
  const via = new Set<string>();
  let raw = false;

  const [arg] = node.arguments;
  // `db.$transaction(cb)` — the callback form, which is all but one of them; the
  // ARRAY form `db.$transaction([db.a.find(), …])` builds its promises off the
  // singleton, so those accesses are collected off `db` instead.
  const cb = arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) ? arg : undefined;
  const txName =
    cb && cb.parameters[0] && ts.isIdentifier(cb.parameters[0].name)
      ? cb.parameters[0].name.text
      : undefined;
  const body: ts.Node = cb ? cb.body : node;
  const aliases = txName ? [txName] : [SINGLETON];

  // ── Where the transaction starts binding ──────────────────────────────────
  //
  // ⚠️ A BOOLEAN HERE IS WRONG, and getting it wrong hides the exact defect this
  // scanner was built for. `workspacesService.ensureDefaultWorkspace` binds
  // `app.user_id` — inside `insertWorkspaceWithOwner`, which it calls on the
  // CREATE path, AFTER the `countByUser` that needed it has already run. A
  // whole-site "does this transaction bind?" flag reports that site as bound and
  // MOTIR-2874's duplicate-default-workspace bug goes straight back under.
  // MOTIR-2874's own note says so in as many words: *"Ordering alone would NOT
  // have been enough: that binding happens on the CREATE path, after the count
  // that needed it has already run."*
  //
  // So the binding has a POSITION, and a gated statement is exempt only when it
  // sits after one. `bindPos` is the earliest of:
  //   * a `set_config('app.…')` written directly in the body, and
  //   * the CALL to a same-file helper that binds inline — the binding takes
  //     effect where the call is, not where the helper is declared.
  //
  // ⚠️ LEXICAL, not control-flow. A `set_config` inside one arm of an `if` reads
  // as binding everything below it. Tightening that needs a CFG, which is a
  // different card; the limit is pinned by a fixture case rather than left
  // implicit, and it errs toward under-reporting exactly once — on a conditional
  // bind, which this codebase does not currently write.
  let bindPos: number | undefined;
  const noteBind = (pos: number): void => {
    if (bindPos === undefined || pos < bindPos) bindPos = pos;
  };
  if (bindsGucInline(body)) {
    const visitBinds = (n: ts.Node): void => {
      if (
        (ts.isStringLiteral(n) ||
          ts.isNoSubstitutionTemplateLiteral(n) ||
          ts.isTemplateHead(n) ||
          ts.isTemplateMiddle(n) ||
          ts.isTemplateTail(n)) &&
        n.text.includes("set_config('app.")
      ) {
        noteBind(n.getStart(sf));
      }
      ts.forEachChild(n, visitBinds);
    };
    visitBinds(body);
  }
  // A helper that binds inline binds AT ITS CALL SITE.
  const visitHelperBinds = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.arguments.some((a) => ts.isIdentifier(a) && aliases.includes(a.text))
    ) {
      const helper = helpers.get(n.expression.text);
      if (helper && bindsGucInline(helper.body)) noteBind(n.getStart(sf));
    }
    ts.forEachChild(n, visitHelperBinds);
  };
  visitHelperBinds(body);

  // ── The gated statements, each with the position that decides it ──────────
  let anyUnbound = false;
  const record = (pos: number, model: string, label: string, isRaw: boolean): void => {
    models.add(model);
    via.add(label);
    if (isRaw) raw = true;
    if (bindPos === undefined || pos < bindPos) anyUnbound = true;
  };

  // Hop 1 — statements issued directly on the transaction client.
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
          !bindsGucInline(n.parent)
        ) {
          record(pos, '', `${aliases[0]}.${name}`, true);
        }
      } else if (gated.has(name)) {
        record(pos, name, `${aliases[0]}.${name}`, false);
      }
    }
    ts.forEachChild(n, visitDirect);
  };
  visitDirect(body);

  // Hops 2 and 3 — one call deep, into a repository method or a same-file helper,
  // and only where the transaction client is actually handed over. Deeper is a
  // call graph, which is a different card.
  const visitCalls = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const passesTx = n.arguments.some((a) => ts.isIdentifier(a) && aliases.includes(a.text));
      if (passesTx) {
        const pos = n.getStart(sf);
        // `workspaceMembershipRepository.countByUser(userId, tx)`
        if (
          ts.isPropertyAccessExpression(n.expression) &&
          ts.isIdentifier(n.expression.expression)
        ) {
          const key = `${n.expression.expression.text}.${n.expression.name.text}`;
          const hit = repoModels.get(key);
          if (hit) {
            for (const m of hit.models) if (gated.has(m)) record(pos, m, key, false);
            if (hit.raw) record(pos, '', key, true);
          }
        }
        // `insertWorkspaceWithOwner(input, tx)` — a same-file helper. When the
        // helper binds inline it binds BEFORE its own statements, so those are
        // bound whatever the call's position: pass `bindPos`'s own value.
        if (ts.isIdentifier(n.expression)) {
          const name = n.expression.text;
          const helper = helpers.get(name);
          if (helper) {
            const selfBinding = bindsGucInline(helper.body);
            const at = selfBinding ? Number.MAX_SAFE_INTEGER : pos;
            const helperTx = helper.txParam ? [helper.txParam] : ['tx'];
            const inner = accessesOff(helper.body, helperTx);
            for (const m of inner.models) {
              if (gated.has(m)) record(at, m, `helper:${name}`, false);
            }
            if (inner.raw && !selfBinding) record(at, '', `helper:${name}`, true);

            // …and the REPOSITORY calls the helper forwards its `tx` to. Looking
            // up a repository method is a table read, not a graph walk, so this
            // stays within the documented one-hop depth — but omitting it would
            // make `db.$transaction((tx) => loadThing(id, tx))` dark whenever the
            // helper delegates instead of querying inline, which is the ordinary
            // way a service factors a gate out. A helper calling a HELPER is still
            // out of reach, and the fixture pins that.
            const visitHelperCalls = (h: ts.Node): void => {
              if (
                ts.isCallExpression(h) &&
                ts.isPropertyAccessExpression(h.expression) &&
                ts.isIdentifier(h.expression.expression) &&
                h.arguments.some((a) => ts.isIdentifier(a) && helperTx.includes(a.text))
              ) {
                const k = `${h.expression.expression.text}.${h.expression.name.text}`;
                const got = repoModels.get(k);
                if (got) {
                  for (const m of got.models) {
                    if (gated.has(m)) record(at, m, `helper:${name} -> ${k}`, false);
                  }
                  if (got.raw && !selfBinding) record(at, '', `helper:${name} -> ${k}`, true);
                }
              }
              ts.forEachChild(h, visitHelperCalls);
            };
            visitHelperCalls(helper.body);
          }
        }
      }
    }
    ts.forEachChild(n, visitCalls);
  };
  visitCalls(body);

  models.delete(''); // the raw-SQL placeholder is not a model name

  const verdict: BareTransactionVerdict = anyUnbound
    ? 'gated-statement'
    : bindPos !== undefined
      ? 'binds-inline'
      : 'no-gated-statement';

  return {
    file,
    line,
    enclosing,
    key: `${file}#${enclosing}`,
    verdict,
    models: [...models].sort(),
    raw,
    via: [...via].sort(),
  };
}

/** The findings — a bare transaction enclosing a policy-gated statement. */
export function gatedBareTransactions(root = process.cwd()): BareTransactionSite[] {
  return scanBareTransactions(root).filter((s) => s.verdict === 'gated-statement');
}
