import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// THE WRITE-DOOR GUARD, static half (Story MOTIR-6170 · MOTIR-6650).
//
// A Visitor is admitted to a project through ONE family of entrances:
// `resolveVisitor` and the helpers built on it (`resolveReadActor`,
// `memberThenVisitor`, `visitorThenMember`, `resolveActionReadActor`), the
// `motir_visitor` cookie they read, the narrowed service identity a Visitor read
// runs under (`visitorServiceContext`), and the consent write
// (`visitorRecordsService.recordConsent`). Every one of them was written for a
// READ — `lib/visitor/readActor.ts` says "ONLY GET HANDLERS CALL THIS". This file
// holds that true of every write door the app has, now and as new ones land:
// no mutating route handler and no server action may reach a Visitor entrance,
// so a Visitor on a write door is answered exactly as any non-member is.
//
// ── The population, measured, not remembered ────────────────────────────────
// At `origin/main` `cf47f2dd3` the card measured 225 route files exporting a
// mutating handler and 32 files carrying `'use server'`. Re-measured on the
// story's branch (after merging main at `9f1e0e3fe`) with:
//
//   grep -rlE "^export (async function|const) (POST|PATCH|PUT|DELETE)\b" app/api --include=route.ts | wc -l   → 227
//   grep -rlE "^export \{[^}]*\b(POST|PATCH|PUT|DELETE)\b" app/api --include=route.ts | wc -l                  → 1 (mcp)
//   grep -rlE "^['\"]use server['\"]" app lib components | wc -l                                               → 33
//
// The walk below does not trust those greps — it parses every file through the
// compiler API — and it prints its own counts, which must agree with them.
//
// ── What counts as "reaching" an entrance ───────────────────────────────────
// The check is PER HANDLER, not per file: `app/api/work-items/[id]/comments`
// serves a Visitor's GET and a member's POST from one file, and only the POST
// is a write door. For each mutating export (and for each export of a
// `'use server'` file — every one is a callable action) the walk collects every
// identifier and string literal in its body and, transitively, in every
// top-level function of the same file it references. A service method that in
// turn calls an entrance is not followed across files: the services that do
// (`projectAccessService`, `visitorRecordsService`, the read services) are read
// services, and the dynamic half (`visitorWriteRefusal.integration.test.ts`)
// drives the handlers themselves as a Visitor and proves no row changes.
//
// ── The named exceptions ────────────────────────────────────────────────────
// * The consent screen's action, whose only write is `recordConsent`.
// * The three READ actions of `app/(authed)/items/actions.ts` (the tree levels
//   and the folder level a Visitor view fetches — MOTIR-6647's data doors). A
//   server action is POST-shaped on the wire, but these three only list.
// * motir.co's act features — the `public_request:*` submit route and
//   follow / subscribe — keep their own guards (`resolvePublicBrowse` and the
//   `public_request:*` keys). None of them names a Visitor entrance, so they
//   need no allow-list entry here; the population count still includes them.
//
// ALLOWED is asserted TIGHT: an entry that stops matching fails, so it only
// shrinks.

const ROOT = resolve(__dirname, '..', '..');

const ENTRANCES = new Set([
  'resolveVisitor',
  'resolveReadActor',
  'resolveActionReadActor',
  'memberThenVisitor',
  'visitorThenMember',
  'readVisitorAddress',
  'VISITOR_ADDRESS_HEADER',
  'VISITOR_COOKIE',
  'resolvePublicInputs',
  'visitorServiceContext',
  'openVisitorRead',
  'visitorPage',
  'settleVisitor',
  'recordConsent',
]);
const ENTRANCE_STRINGS = new Set(['motir_visitor', 'x-motir-visitor']);

const ALLOWED: { file: string; handler: string; hits: string[]; why: string }[] = [
  {
    file: 'app/(auth)/p/[identifier]/consent/_actions.ts',
    handler: 'recordVisitorConsentAction',
    hits: ['recordConsent'],
    why: 'The consent screen’s Continue — its only write is the visitor record itself (MOTIR-6669).',
  },
  {
    file: 'app/(authed)/items/actions.ts',
    handler: 'listRootIssuesAction',
    hits: ['resolveActionReadActor'],
    why: 'A READ action: the root tree level a Visitor view fetches (MOTIR-6647).',
  },
  {
    file: 'app/(authed)/items/actions.ts',
    handler: 'listChildIssuesAction',
    hits: ['resolveActionReadActor'],
    why: 'A READ action: a tree drill-down a Visitor view fetches (MOTIR-6647).',
  },
  {
    file: 'app/(authed)/items/actions.ts',
    handler: 'listFolderLevelAction',
    hits: ['resolveActionReadActor'],
    why: 'A READ action: the folder level a Visitor view fetches (MOTIR-6647).',
  },
  {
    file: 'app/(authed)/plans/_actions.ts',
    handler: 'loadMoreSessionsAction',
    hits: ['resolveActionReadActor'],
    why: 'A READ action: the Plans list’s next cursor page a Visitor view fetches (MOTIR-6890).',
  },
];

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(abs);
  }
  return out;
}

const rel = (abs: string) => relative(ROOT, abs).split(sep).join('/');

interface Door {
  file: string;
  handler: string;
  hits: string[];
}

function isUseServer(sf: ts.SourceFile): boolean {
  const first = sf.statements[0];
  return (
    !!first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use server'
  );
}

function hasExport(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/**
 * The write doors a source file declares, each with the Visitor entrances it
 * reaches. Pure over (path, text) so the guard can be watched failing on a
 * synthetic file.
 */
function doorsOf(file: string, text: string, kind: 'route' | 'action'): Door[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // Top-level callables by name.
  const bodies = new Map<string, ts.Node>();
  // Exported name → local name.
  const exported = new Map<string, string>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) {
      bodies.set(st.name.text, st);
      if (hasExport(st)) exported.set(st.name.text, st.name.text);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        bodies.set(d.name.text, d.initializer);
        if (hasExport(st)) exported.set(d.name.text, d.name.text);
      }
    } else if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause) {
      if (ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          exported.set(el.name.text, (el.propertyName ?? el.name).text);
        }
      }
    }
  }
  const entries = [...exported.entries()].filter(([name]) =>
    kind === 'route' ? MUTATING.has(name) : true,
  );
  const doors: Door[] = [];
  for (const [name, local] of entries) {
    const hits = new Set<string>();
    const seen = new Set<string>();
    const queue = [local];
    while (queue.length) {
      const fn = queue.pop()!;
      if (seen.has(fn)) continue;
      seen.add(fn);
      const body = bodies.get(fn);
      if (!body) continue;
      const visit = (n: ts.Node) => {
        if (ts.isIdentifier(n)) {
          if (ENTRANCES.has(n.text)) hits.add(n.text);
          if (bodies.has(n.text) && !seen.has(n.text)) queue.push(n.text);
        } else if (ts.isStringLiteralLike(n) && ENTRANCE_STRINGS.has(n.text)) {
          hits.add(n.text);
        }
        ts.forEachChild(n, visit);
      };
      visit(body);
    }
    doors.push({ file, handler: name, hits: [...hits].sort() });
  }
  return doors;
}

function population() {
  const routeFiles = walk(join(ROOT, 'app', 'api')).filter((f) => /\/route\.ts$/.test(f));
  const actionFiles = ['app', 'lib', 'components']
    .flatMap((d) => walk(join(ROOT, d)))
    .filter((f) => /^['"]use server['"]/m.test(readFileSync(f, 'utf8')));
  const routeDoors = routeFiles.flatMap((f) => doorsOf(rel(f), readFileSync(f, 'utf8'), 'route'));
  const actionDoors = actionFiles.flatMap((f) => {
    const text = readFileSync(f, 'utf8');
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    return isUseServer(sf) ? doorsOf(rel(f), text, 'action') : [];
  });
  return {
    routeFiles: new Set(routeDoors.map((d) => d.file)),
    actionFiles: new Set(actionDoors.map((d) => d.file)),
    doors: [...routeDoors, ...actionDoors],
  };
}

const POP = population();

describe('no write door reaches a Visitor entrance', () => {
  it('measures the population it guards', () => {
    // Compare with the greps in the header: 228 route files, 33 files, 370 doors
    // when this was written.
    // Floors, not exact numbers: new doors are welcome, a walk that silently
    // found nothing is not.
    expect(POP.routeFiles.size).toBeGreaterThanOrEqual(225);
    expect(POP.actionFiles.size).toBeGreaterThanOrEqual(32);
    expect(POP.routeFiles.has('app/api/mcp/route.ts'), 'the re-exported handler form').toBe(true);
  });

  it('only the named exceptions reach one — and each still does (tight both ways)', () => {
    const offenders = POP.doors.filter((d) => d.hits.length > 0);
    const key = (d: { file: string; handler: string }) => `${d.file}#${d.handler}`;
    const allowed = new Map(ALLOWED.map((a) => [key(a), a]));
    const unexpected = offenders
      .filter((d) => {
        const a = allowed.get(key(d));
        return !a || d.hits.some((h) => !a.hits.includes(h));
      })
      .map((d) => `${key(d)} → ${d.hits.join(', ')}`);
    expect(unexpected, 'a write door reaches a Visitor entrance').toEqual([]);
    for (const a of ALLOWED) {
      const door = POP.doors.find((d) => key(d) === key(a));
      expect(door, `${key(a)} is allow-listed but no longer exists`).toBeDefined();
      expect(door!.hits, `${key(a)} no longer reaches ${a.hits.join(', ')}`).toEqual(a.hits);
    }
  });
});

describe('the scanner, watched failing', () => {
  it('sees a POST that reads the Visitor through a same-file helper', () => {
    const doors = doorsOf(
      'app/api/x/route.ts',
      `import { resolveReadActor } from '@/lib/visitor/readActor';
       async function who(req: Request) { return resolveReadActor(req); }
       export async function GET(req: Request) { return who(req); }
       export async function POST(req: Request) { await who(req); return new Response(); }`,
      'route',
    );
    expect(doors).toEqual([
      { file: 'app/api/x/route.ts', handler: 'POST', hits: ['resolveReadActor'] },
    ]);
  });

  it('sees the cookie by name, a const handler and a re-exported one', () => {
    const doors = doorsOf(
      'app/api/y/route.ts',
      `const handler = async (req: Request) => req.headers.get('cookie')?.includes('motir_visitor');
       export const PATCH = async () => new Response();
       export { handler as DELETE };`,
      'route',
    );
    expect(doors.map((d) => [d.handler, d.hits])).toEqual([
      ['PATCH', []],
      ['DELETE', ['motir_visitor']],
    ]);
  });

  it('treats every export of a use-server file as a door', () => {
    const doors = doorsOf(
      'app/z/actions.ts',
      `'use server';
       export async function save() { return visitorRecordsService.recordConsent({}); }
       export async function other() { return 1; }`,
      'action',
    );
    expect(doors.map((d) => [d.handler, d.hits])).toEqual([
      ['save', ['recordConsent']],
      ['other', []],
    ]);
  });
});
