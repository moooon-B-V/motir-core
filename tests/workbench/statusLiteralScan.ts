import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// The STATUS-KEY-LITERAL scanner (Story MOTIR-4777 · MOTIR-4784).
//
// ── What it exists to protect ───────────────────────────────────────────────
// The Workbench's three work tabs partition ONE membership set on
// `workflow_status.CATEGORY`, never on a status KEY. That is the decision the
// whole story rests on, and it is invisible in our own tree: Motir's project
// uses the default status names, so a predicate written against `'in_progress'`
// or `'done'` passes every test anybody here would naturally write.
//
// It fails for the first customer who renames a column — and it fails the way
// this story keeps finding: silently. No error, no empty page, just a tab that
// is missing work, on a workflow we cannot see. `workbench-reads.test.ts`
// covers the case with a renamed column, and a test covers the code that
// EXISTS. This covers the code nobody has written yet, which is where the next
// literal will be typed.
//
// ── The predicate, and the line it draws ────────────────────────────────────
// A VIOLATION is a status-KEY literal used as a comparison:
//
//   * `{ status: 'done' }` — a Prisma equality filter;
//   * `{ status: { in: ['done', 'cancelled'] } }` / `notIn` / `equals` / `not`;
//   * `row.status === 'in_review'` and its three siblings;
//   * `someStatusThing.has('done')` / `.includes('done')`.
//
// ⚠️ A CATEGORY LITERAL IS NOT A VIOLATION, and telling the two apart is the
// whole difficulty — `'in_progress'`, `'done'` and `'todo'` are BOTH default
// status keys AND the three `StatusCategoryDto` values. So the scanner does not
// look at the string; it looks at what the string is compared TO. A literal
// reached through a property named `status` is a key comparison; a literal
// assigned to `statusCategory`, listed in a `HomeCategorySlice`, or used as the
// property name of `statusKeysByCategory` is the category axis working exactly
// as designed, and none of those passes through a `status` comparison.
//
// That is also why the scanner is worth more than a grep: `git grep "'done'"`
// over this surface returns the category slices, the DTO unions and the
// scanner's own vocabulary, and a guard whose output is mostly noise is a guard
// people stop reading.

/** One status-KEY literal comparison in the Workbench surface. */
export interface StatusLiteralSite {
  /** Repo-relative, forward slashes. */
  file: string;
  /** The enclosing named function / declaration, or `<module>`. */
  fn: string;
  /** 1-based line. */
  line: number;
  /** The literal itself — `'done'`, `'in_review'`, … */
  key: string;
  /** How it was written, so a verdict can name the shape rather than the line. */
  via: 'prisma-filter' | 'comparison' | 'membership';
}

/**
 * THE SURFACE, by name.
 *
 * A directory entry is scanned whole. A FILE entry paired with a symbol filter
 * is scanned only inside declarations whose name matches — because
 * `workItemRepository.ts` and `watcherRepository.ts` are shared files whose
 * non-Workbench half legitimately compares a status key (`countByStatus`,
 * `findByStatus`), and a guard that fired on those would be a guard somebody
 * disables.
 */
export const WORKBENCH_SURFACE: ReadonlyArray<{ path: string; only?: RegExp }> = [
  { path: 'lib/workbench' },
  { path: 'lib/services/homeService.ts' },
  { path: 'lib/mappers/homeMappers.ts' },
  { path: 'app/(authed)/workbench' },
  { path: 'lib/repositories/workItemRepository.ts', only: /home|workbench/i },
  { path: 'lib/repositories/watcherRepository.ts', only: /home|workbench|listByUser/i },
];

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

/** The nearest enclosing NAMED declaration, for the verdict key and the filter. */
function enclosingName(node: ts.Node, sf: ts.SourceFile): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isVariableDeclaration(n)
    ) {
      const named = n as { name?: ts.Node };
      if (named.name && ts.isIdentifier(named.name as ts.Node)) {
        return (named.name as ts.Identifier).text;
      }
      const parent = n.parent;
      if (parent && ts.isPropertyAssignment(parent) && parent.name) return parent.name.getText(sf);
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
    }
  }
  return '<module>';
}

const isStr = (n: ts.Node): n is ts.StringLiteralLike =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

/** Every string literal a Prisma status filter can carry, flattened. */
function filterLiterals(node: ts.Expression): string[] {
  if (isStr(node)) return [node.text];
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(filterLiterals);
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.flatMap((p) => {
      if (!ts.isPropertyAssignment(p) || p.name === undefined) return [];
      // `in` / `notIn` / `equals` / `not` — the four Prisma operators that can
      // put a status KEY in a `where`. Anything else under `status` is not a
      // key comparison (there is nothing else it could be).
      return /^(in|notIn|equals|not)$/.test(p.name.getText()) ? filterLiterals(p.initializer) : [];
    });
  }
  return [];
}

/**
 * Every status-KEY literal comparison in the Workbench surface.
 *
 * Pure over the tree at `root`, so the guard's own control can drive it against
 * a fixture directory rather than re-implementing the predicate — the shape
 * `tests/work-items/statusWriteScan.ts` and `tests/hosting/abandonedPathGuard.ts`
 * both take, for the reason the second one records: a guard asserted only by
 * passing is a guard nobody has watched fire.
 */
export function scanStatusLiterals(root = process.cwd()): StatusLiteralSite[] {
  const sites: StatusLiteralSite[] = [];

  for (const entry of WORKBENCH_SURFACE) {
    const target = path.join(root, entry.path);
    let files: string[];
    try {
      files = statSync(target).isDirectory() ? walk(target) : [target];
    } catch {
      continue; // absent in this tree — a fixture, not the repo
    }

    for (const full of files) {
      const source = readFileSync(full, 'utf8');
      if (!source.includes('status')) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      const sf = ts.createSourceFile(full, source, ts.ScriptTarget.Latest, true);

      const report = (node: ts.Node, key: string, via: StatusLiteralSite['via']): void => {
        const fn = enclosingName(node, sf);
        if (entry.only && !entry.only.test(fn)) return;
        sites.push({
          file: rel,
          fn,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          key,
          via,
        });
      };

      const visit = (node: ts.Node): void => {
        // 1 — a Prisma filter reached through a property literally named `status`.
        if (
          ts.isPropertyAssignment(node) &&
          node.name !== undefined &&
          node.name.getText(sf) === 'status'
        ) {
          for (const key of filterLiterals(node.initializer)) {
            report(node, key, 'prisma-filter');
          }
        }

        // 2 — `<expr>.status === '<key>'` and its three siblings.
        if (
          ts.isBinaryExpression(node) &&
          [
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
          ].includes(node.operatorToken.kind)
        ) {
          const [a, b] = [node.left, node.right];
          const touchesStatus = (n: ts.Expression) =>
            ts.isPropertyAccessExpression(n) && n.name.text === 'status';
          if (touchesStatus(a) && isStr(b)) report(node, b.text, 'comparison');
          if (touchesStatus(b) && isStr(a)) report(node, a.text, 'comparison');
        }

        // 3 — `<something status-ish>.has('<key>')` / `.includes('<key>')`.
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          /^(has|includes)$/.test(node.expression.name.text) &&
          /status/i.test(node.expression.expression.getText(sf)) &&
          node.arguments.length === 1 &&
          node.arguments[0] !== undefined &&
          isStr(node.arguments[0])
        ) {
          report(node, (node.arguments[0] as ts.StringLiteralLike).text, 'membership');
        }

        ts.forEachChild(node, visit);
      };

      ts.forEachChild(sf, visit);
    }
  }

  return sites;
}

/** A stable identity for one site, for the adjudication table. */
export function statusLiteralKey(site: StatusLiteralSite): string {
  return `${site.file}::${site.fn}::${site.key}`;
}
