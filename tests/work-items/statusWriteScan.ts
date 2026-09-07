import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// The STATUS-WRITE scanner (Story MOTIR-4777 · MOTIR-4780).
//
// ── What it exists to protect ───────────────────────────────────────────────
// `work_item.completedAt` is stamped in exactly ONE place —
// `workItemsService.applyStatusTransition` — inside the same transaction and
// under the same row lock as the status write it describes. That is the right
// shape and it is not a self-enforcing one: the stamp lives beside a write, so
// a NEW write that reaches `work_item.status` by another route simply does not
// stamp, and nothing anywhere fails.
//
// The failure is silent in the way that costs the most. The card gets its new
// status, every list that keys on `status` is correct, the board moves, the
// roll-up rolls up — and the row sits in a done-category status with a null
// `completedAt`, invisible to the Workbench's Recently-finished tab and to
// every cycle-time figure computed off that column, for ever. There is no
// error, no red test and no user report; the tab is simply a little emptier
// than the truth.
//
// So the guard is a POPULATION check rather than a behavioural one: enumerate
// every site in `lib/` and `app/` that writes `status` onto a work item, and
// require that a human has ruled on each. `tests/rls/call-site-guard.test.ts`
// is the mould — the machine enumerates, a human adjudicates, and a site
// nobody has ruled on fails the build.
//
// ── The predicate, and the line it draws ────────────────────────────────────
// A SITE is a call to one of the two doors that can write this column:
//
//   * `workItemRepository.update(<id>, <patch>, tx)` — the service-layer door,
//     where `<patch>` mentions `status`;
//   * `tx.workItem.update` / `.updateMany` with a `data` object that mentions
//     `status` — the raw Prisma door, which by the 4-layer contract may only
//     appear inside `lib/repositories/`.
//
// "Mentions `status`" is read off the OBJECT LITERAL where there is one. Where
// the patch is a VARIABLE — `const update: WorkItemUpdateInput = { … };
// update.status = …`, the shape `applyStatusTransition` itself uses — the walk
// resolves it against the enclosing function's locals and clears the call only
// when that local demonstrably never receives a `status`. Anything it cannot
// follow (a parameter, a spread, a value built by a call) is reported as
// `unresolved` and adjudicated rather than guessed at. Over-reporting is the
// safe direction here — an extra verdict line costs a sentence, a missed write
// costs a column — but resolving the resolvable half is what keeps the verdict
// table short enough that a NEW entry is conspicuous, which is the property the
// guard actually trades on.
//
// ⚠️ IT DOES NOT READ THE `completedAt` HALF, deliberately. A site that writes
// `status` AND `completedAt` still has to be ruled on, because the interesting
// question is whether the two agree — a write that stamps unconditionally is as
// wrong as one that never stamps (a `done → cancelled` hop must not re-stamp).
// A scanner cannot answer that; the verdict's reason field is where the answer
// is written down.

/** One place in the tree that writes `work_item.status`. */
export interface StatusWriteSite {
  /** Repo-relative, forward slashes. */
  file: string;
  /**
   * The enclosing named function / method the call sits in, or `<module>` at
   * the top level. This is the discriminating half of the key: `workItemsService.ts`
   * holds the ONE sanctioned write and two that touch other columns, so a
   * file-level verdict would absorb a new status write into an existing ruling.
   */
  fn: string;
  /** 1-based line of the call. */
  line: number;
  /**
   * The door: `workItemRepository.update` or the raw `tx.workItem.update` /
   * `.updateMany`.
   */
  via: string;
  /**
   * `literal` — the patch is an object literal naming `status`.
   * `unresolved` — the patch is a variable this walk cannot follow (a parameter,
   * a spread, a conditional), so the site is reported on the conservative
   * reading described above rather than guessed at.
   */
  form: 'literal' | 'unresolved';
}

/** The directories a status write could live in under the 4-layer contract. */
const SCANNED_ROOTS = ['lib', 'app'] as const;

/** Directories with nothing to say about work-item status. */
const SKIP_DIRS = new Set(['node_modules', 'generated', '.next', 'dist', '__snapshots__']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.d\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Does this object literal assign a `status` property? */
function namesStatus(node: ts.ObjectLiteralExpression): boolean {
  return node.properties.some((p) => {
    const name = p.name;
    if (name === undefined) return false;
    if (ts.isIdentifier(name)) return name.text === 'status';
    if (ts.isStringLiteral(name)) return name.text === 'status';
    return false;
  });
}

/**
 * Does this function body ever put a `status` onto the local named `name`?
 *
 * Two shapes, which between them cover how every patch in this tree is built:
 * the declaration's own initializer (`const update = { status: … }`) and a
 * later property assignment (`update.status = …`, the shape
 * `applyStatusTransition` itself uses). Returns `null` when `name` is not a
 * local of this function at all — a parameter, an import, a closure variable —
 * because then the walk cannot see where it came from and the site must be
 * reported rather than cleared.
 */
function localWritesStatus(fn: ts.Node, name: string): boolean | null {
  let declared = false;
  let writes = false;

  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      declared = true;
      const init = n.initializer;
      if (init === undefined) {
        // `let update; … update = <expr>` — an unresolvable shape, and treating
        // it as declared-and-clean would be the one direction that loses a write.
        writes = true;
      } else if (ts.isObjectLiteralExpression(init)) {
        if (namesStatus(init)) writes = true;
        // A spread inside the initializer can carry a `status` from anywhere.
        if (init.properties.some((p) => ts.isSpreadAssignment(p))) writes = true;
      } else {
        writes = true; // built by a call / conditional — not resolvable here
      }
    }
    // `update.status = …` / `update['status'] = …`
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) &&
      ts.isIdentifier(n.left.expression) &&
      n.left.expression.text === name &&
      n.left.name.text === 'status'
    ) {
      writes = true;
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(n.left) &&
      ts.isIdentifier(n.left.expression) &&
      n.left.expression.text === name &&
      ts.isStringLiteral(n.left.argumentExpression) &&
      n.left.argumentExpression.text === 'status'
    ) {
      writes = true;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);

  if (!declared) return null;
  return writes;
}

/**
 * Classify the ARGUMENT that carries the patch, against the function it sits
 * in. An object literal is read directly. A bare identifier is resolved
 * against the enclosing function's locals — which is what keeps this guard's
 * output down to the sites that actually write a status, so a NEW one is loud
 * rather than absorbed into an existing verdict. Anything else, or a local the
 * walk cannot follow, is `unresolved` and reported.
 */
function classifyPatch(
  arg: ts.Expression | undefined,
  fn: ts.Node,
): 'literal' | 'unresolved' | null {
  if (arg === undefined) return null;
  if (ts.isObjectLiteralExpression(arg)) {
    if (namesStatus(arg)) return 'literal';
    // A spread could carry a `status` in from elsewhere — report, don't clear.
    return arg.properties.some((p) => ts.isSpreadAssignment(p)) ? 'unresolved' : null;
  }
  if (ts.isIdentifier(arg)) {
    const verdict = localWritesStatus(fn, arg.text);
    if (verdict === false) return null; // a local this function never gives a status
    return 'unresolved';
  }
  return 'unresolved';
}

/**
 * The nearest enclosing NAMED function / method, for the adjudication key —
 * plus the innermost function node, which is the scope the patch variable is
 * resolved against.
 *
 * ⚠️ The two are not always the same frame, and taking the innermost one for
 * BOTH is what made the first version of this scanner key a real call site as
 * `<anonymous>`. Almost every service write in this tree sits inside a callback
 * — `withWorkspaceContext(ctx, async (tx) => { … })` — so the innermost
 * function is an unnamed arrow and the name a human would use is one or two
 * frames up. The walk therefore continues past anonymous frames to the first
 * one that HAS a name, and reports the innermost frame separately.
 *
 * Resolving the patch against the innermost frame is deliberate and is the safe
 * direction: an inner scope sees its own locals plus, through
 * `localWritesStatus`'s `declared` check, correctly reports `unresolved` for
 * anything declared outside it.
 */
function enclosingName(node: ts.Node, sf: ts.SourceFile): { name: string; fn: ts.Node } {
  let innermost: ts.Node | null = null;

  const nameOf = (n: ts.Node): string | null => {
    const named = n as ts.FunctionLikeDeclaration;
    if (named.name && ts.isIdentifier(named.name)) return named.name.text;
    // An arrow / function expression bound to a name — `foo: async (…) => …`
    // (an object-literal method, how every service in this tree spells one) or
    // `const foo = async (…) => …`.
    const parent = n.parent;
    if (parent && ts.isPropertyAssignment(parent) && parent.name) return parent.name.getText(sf);
    if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    return null;
  };

  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n)
    ) {
      innermost ??= n;
      const name = nameOf(n);
      if (name !== null) return { name, fn: innermost };
    }
  }
  return { name: '<module>', fn: innermost ?? sf };
}

/**
 * Every site in `lib/` and `app/` that writes `work_item.status`.
 *
 * Pure over the tree at `root`, so the guard's own synthetic control can drive
 * it against a fixture directory rather than re-implementing the predicate (the
 * reasoning `tests/hosting/abandonedPathGuard.ts` is split out for).
 */
export function scanStatusWrites(root = process.cwd()): StatusWriteSite[] {
  const sites: StatusWriteSite[] = [];

  for (const dirName of SCANNED_ROOTS) {
    const dir = path.join(root, dirName);
    let files: string[];
    try {
      files = walk(dir);
    } catch {
      continue; // the root does not exist in this tree — a fixture, not the repo
    }

    for (const full of files) {
      const source = readFileSync(full, 'utf8');
      // Cheap pre-filter: a file that never mentions `status` cannot contain a
      // site, and skipping the parse keeps the whole-tree walk in seconds.
      if (!source.includes('status')) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      const sf = ts.createSourceFile(full, source, ts.ScriptTarget.Latest, true);

      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const callee = node.expression;
          const method = callee.name.text;
          const receiver = callee.expression.getText(sf);

          // Door 1 — the service-layer repository call. Its patch is argument 2.
          if (receiver === 'workItemRepository' && method === 'update') {
            const enclosing = enclosingName(node, sf);
            const form = classifyPatch(node.arguments[1], enclosing.fn);
            if (form) {
              sites.push({
                file: rel,
                fn: enclosing.name,
                line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
                via: 'workItemRepository.update',
                form,
              });
            }
          }

          // Door 2 — raw Prisma on the `workItem` delegate. The patch rides the
          // `data` property of the single options object.
          if (/\bworkItem$/.test(receiver) && (method === 'update' || method === 'updateMany')) {
            const options = node.arguments[0];
            if (options && ts.isObjectLiteralExpression(options)) {
              const data = options.properties.find(
                (p) => p.name !== undefined && p.name.getText(sf) === 'data',
              );
              const initializer =
                data && ts.isPropertyAssignment(data) ? data.initializer : undefined;
              const enclosing = enclosingName(node, sf);
              const form = classifyPatch(initializer, enclosing.fn);
              if (form) {
                sites.push({
                  file: rel,
                  fn: enclosing.name,
                  line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
                  via: `workItem.${method}`,
                  form,
                });
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };

      ts.forEachChild(sf, visit);
    }
  }

  return sites;
}

/**
 * The adjudication key for a site — one entry per (FILE, FUNCTION, door)
 * triple, deliberately not per LINE: a call that moves down its file is the
 * same adjudication, and keying on the line would make every unrelated edit a
 * re-review. Keying on the FUNCTION rather than the file alone is what stops a
 * new status write inside `workItemsService.ts` from being absorbed by the
 * verdict that clears `applyStatusTransition`.
 */
export function statusWriteKey(site: StatusWriteSite): string {
  return `${site.file}#${site.fn}#${site.via}`;
}
