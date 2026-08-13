import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// The singleton-read scanner (MOTIR-2784).
//
// ── The class of bug it exists to stop ──────────────────────────────────────
// Every tenant-scoped table carries an RLS policy keyed on a per-transaction GUC
// (`app.workspace_id` / `app.user_id` / `app.organization_id`), bound by
// `withWorkspaceContext` and friends with `set_config(…, true)`. That binding is
// TRANSACTION-local. A repository method that issues its statement on the
// `@/lib/db` SINGLETON therefore runs outside any such transaction: the policy
// sees NULL, and the read returns ZERO ROWS WITHOUT RAISING. An empty result is
// an ordinary result, so the caller reports "missing" for a row that exists.
//
// That has now been found FOUR times — MOTIR-2569, MOTIR-2685, MOTIR-2774 (three
// sites, including one that made `createWorkItem` impossible under the role) and
// this card — and every time by accident, from a test run under
// TEST_DB_APP_ROLE=1 rather than from anyone reading the code. The point of this
// scanner is that the fifth is caught at commit time.
//
// ── Why a parser rather than a grep ─────────────────────────────────────────
// The verdict is a property of the ENCLOSING METHOD, not of the line. A method
// that resolves `const client = tx ?? db` is not a singleton read at all — it is
// a bindable read whose caller decides, which is the shape most of this
// repository already uses and precisely what a `grep 'db\.'` cannot distinguish
// from the unbound kind. Method boundaries, the `tx ?? db` fallback and the
// model being addressed all need the syntax tree.
//
// ── What it deliberately does NOT decide ────────────────────────────────────
// Whether an unbound read is a BUG. Three legitimate reasons to read with no
// tenant bound exist and cannot be told apart from the repository file alone:
// a deliberately public read (the public project pages, whose policy carries a
// public arm from MOTIR-2684), a genuinely actorless read (the job runtime, and
// pre-auth paths where no session exists yet), and a read whose caller simply
// forgot to open a context. Only the third is a defect, and separating them
// needs the CALL SITES.
//
// So the scanner reports, and the guard test carries the verdicts — one entry
// per site, with the reason in the value. That is the same division
// `tenant-root-creation-rls.test.ts` uses for its `DELIBERATELY_UNGUARDED` map:
// the machine enumerates, a human adjudicates, and adding a site without
// adjudicating it fails the build.

const REPO_DIR = 'lib/repositories';
const SCHEMA = 'prisma/schema.prisma';

/** The Prisma singleton, as imported by every repository. */
const SINGLETON = 'db';

export interface SingletonRead {
  /** e.g. `workItemRepository.ts` */
  file: string;
  /** the enclosing method name, e.g. `findByIds` */
  method: string;
  /** `file#method` — the allowlist key */
  key: string;
  /** the Prisma models addressed off the singleton, sorted; empty for raw SQL */
  models: string[];
  /** true when the method issues raw SQL on the singleton */
  raw: boolean;
}

/**
 * Prisma models that carry a `workspaceId` column, plus the three TENANT-ROOT
 * models. Read out of the schema rather than hardcoded, so a new tenant-scoped
 * table is in scope the moment it is added — the same reason the sibling guard
 * queries `pg_class` instead of listing tables.
 */
export function policyGatedModels(root = process.cwd()): Set<string> {
  const src = readFileSync(path.join(root, SCHEMA), 'utf8');
  const gated = new Set<string>(['organization', 'organizationMembership', 'workspace']);
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = modelRe.exec(src)) !== null) {
    const [, name, body] = m;
    if (name && body && /^\s*workspaceId\s/m.test(body)) {
      gated.add(name[0]!.toLowerCase() + name.slice(1));
    }
  }
  return gated;
}

/** Does this method resolve `<something> = tx ?? db`? Then it is bindable, not unbound. */
function hasTxFallback(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      ts.isIdentifier(n.right) &&
      n.right.text === SINGLETON
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Collect `db.<x>` accesses in this subtree: model names, and whether raw SQL. */
function singletonAccesses(node: ts.Node): { models: Set<string>; raw: boolean } {
  const models = new Set<string>();
  let raw = false;
  const visit = (n: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === SINGLETON
    ) {
      const name = n.name.text;
      if (name.startsWith('$')) {
        if (
          name === '$queryRaw' ||
          name === '$queryRawUnsafe' ||
          name === '$executeRaw' ||
          name === '$executeRawUnsafe'
        ) {
          raw = true;
        }
        // `$transaction` / `$disconnect` are not reads — ignored.
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
 * Every repository method that reads the `@/lib/db` singleton with no `tx ?? db`
 * fallback AND addresses a policy-gated model (or raw SQL, whose target the
 * parser cannot name — those are reported so the allowlist must adjudicate them).
 */
export function scanSingletonReads(root = process.cwd()): SingletonRead[] {
  const gated = policyGatedModels(root);
  const dir = path.join(root, REPO_DIR);
  const out: SingletonRead[] = [];

  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()) {
    const full = path.join(dir, file);
    const sf = ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node): void => {
      // Repositories are object literals of methods: `async findX(...) { ... }`.
      if (
        (ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) &&
        node.name &&
        ts.isIdentifier(node.name)
      ) {
        const body = ts.isMethodDeclaration(node)
          ? node.body
          : ts.isFunctionExpression(node.initializer!) || ts.isArrowFunction(node.initializer!)
            ? node.initializer.body
            : undefined;
        if (body && !hasTxFallback(body)) {
          const { models, raw } = singletonAccesses(body);
          const tenant = [...models].filter((m) => gated.has(m)).sort();
          if (tenant.length > 0 || raw) {
            const method = node.name.text;
            out.push({ file, method, key: `${file}#${method}`, models: tenant, raw });
          }
        }
        return; // do not descend into a method we have already ruled on
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}
