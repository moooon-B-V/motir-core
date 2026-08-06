import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// The inventory COVERAGE guard (Story MOTIR-2255 · Subtask MOTIR-2274).
//
// `docs/decisions/permission-inventory.md` maps every user-initiated operation
// to the permission that should govern it. A document like that is true on the
// day it is written and quietly false the first time somebody adds a route —
// which is exactly how the gap it documents opened in the first place.
//
// So the document is pinned to the filesystem: every `app/api/**/route.ts` and
// every `'use server'` action must appear in it by name. Adding a route without
// deciding who may call it fails here, at the moment the route is added.
//
// ⚠️ This guard checks COVERAGE, not enforcement. "Is every operation named in
// the map?" is this file. "Does every operation actually pass a gate?" is
// MOTIR-2278, which is a different and stronger question.

const ROOT = join(__dirname, '..', '..');
const DOC = join(ROOT, 'docs', 'decisions', 'permission-inventory.md');

function walk(dir: string, hit: (p: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, hit);
    else hit(p);
  }
}

/** Every API route, as the URL path the document lists it under. */
function routeUrls(): string[] {
  const urls: string[] = [];
  walk(join(ROOT, 'app', 'api'), (p) => {
    if (!p.endsWith(`${'route'}.ts`)) return;
    const rel = relative(join(ROOT, 'app'), p).replace(/\\/g, '/');
    urls.push('/' + rel.replace(/\/route\.ts$/, ''));
  });
  return urls.sort();
}

/** Every file that declares a Server Action, as a repo-relative path. */
function serverActionFiles(): string[] {
  const files: string[] = [];
  for (const top of ['app', 'lib', 'components']) {
    walk(join(ROOT, top), (p) => {
      if (!p.endsWith('.ts') && !p.endsWith('.tsx')) return;
      const head = readFileSync(p, 'utf8').slice(0, 400);
      if (!head.includes(`'use server'`) && !head.includes(`"use server"`)) return;
      files.push(relative(ROOT, p).replace(/\\/g, '/'));
    });
  }
  return files.sort();
}

const doc = readFileSync(DOC, 'utf8');

describe('the permission inventory covers the whole operation surface', () => {
  it('names every app/api route', () => {
    const missing = routeUrls().filter((u) => !doc.includes(`\`${u}\``));
    expect(
      missing,
      `these routes are not in docs/decisions/permission-inventory.md — every operation needs a decided policy:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('names every file declaring a Server Action', () => {
    const missing = serverActionFiles().filter((f) => !doc.includes(`\`${f}\``));
    expect(
      missing,
      `these Server Action files are not in the inventory:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('enumerates a non-trivial surface (the walk is not silently matching nothing)', () => {
    // A coverage guard that walks an empty set passes for the wrong reason.
    expect(routeUrls().length).toBeGreaterThan(200);
    expect(serverActionFiles().length).toBeGreaterThan(10);
  });
});

describe('every row carries a decided policy', () => {
  /** The table rows, as `| cell | cell | … |` splits. */
  function tableRows(): string[][] {
    return doc
      .split('\n')
      .filter((l) => l.startsWith('| `/') || l.startsWith('| `app/') || l.startsWith('| `lib/'))
      .map((l) =>
        l
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim()),
      );
  }

  const DECISIONS = new Set([
    'existing',
    'new',
    'workspace-scoped',
    'user-scoped',
    'token-scoped',
    'no-gate',
    'finding',
  ]);

  // Row shape: | Operation | … | Permission | Decision | Why |
  const DECISION = -2;
  const WHY = -1;
  const PERMISSION = -3;
  const at = (cells: string[], i: number): string => cells[cells.length + i] ?? '';

  it('has a row for every operation, and every row carries a known decision', () => {
    const rows = tableRows();
    expect(rows.length).toBeGreaterThan(200);
    const bad = rows.filter((cells) => !DECISIONS.has(at(cells, DECISION)));
    expect(
      bad.map((c) => c[0]),
      // A blank decision is the failure this whole card exists to prevent.
      'every row must carry one of: ' + [...DECISIONS].join(' / '),
    ).toEqual([]);
  });

  it('every row cites a REASON, and the reason is defined in the Reasons section', () => {
    const bad: string[] = [];
    for (const cells of tableRows()) {
      const why = at(cells, WHY);
      if (!/^R\d+$/.test(why)) {
        bad.push(`${cells[0]} — no reason cited`);
        continue;
      }
      // The citation must resolve: a dangling Rn is worse than a blank one.
      if (!doc.includes(`**${why}.**`))
        bad.push(`${cells[0]} — cites ${why}, which is not defined`);
    }
    expect(bad, 'every operation must cite a defined reason').toEqual([]);
  });

  it('leaves no permission cell blank on a row decided as `new` or `existing`', () => {
    const bad = tableRows()
      .filter((c) => ['new', 'existing'].includes(at(c, DECISION)))
      .filter((c) => !at(c, PERMISSION).startsWith('`'));
    expect(
      bad.map((c) => c[0]),
      'a new/existing row must name its permission key',
    ).toEqual([]);
  });

  it('every row NOT mapped to a permission is one of the four justified non-permission answers', () => {
    const NON_PERMISSION = new Set([
      'workspace-scoped',
      'user-scoped',
      'token-scoped',
      'no-gate',
      'finding',
    ]);
    const bad = tableRows()
      .filter((c) => at(c, PERMISSION) === '—')
      .filter((c) => !NON_PERMISSION.has(at(c, DECISION)));
    expect(
      bad.map((c) => c[0]),
      'an operation with no permission must say WHY it needs none',
    ).toEqual([]);
  });
});

describe('the five surfaces this card was filed over each have a decided policy', () => {
  it.each([
    ['creating a dashboard', '/api/dashboards'],
    ['AI planning', '/api/ai/plan'],
    ['viewing a plan', '/api/plans'],
    ['the repository paths', '/api/projects/[key]/repositories'],
    ['reports', '/api/reports'],
  ])('%s — `%s` appears in the inventory', (_label, url) => {
    expect(doc).toContain(`\`${url}`);
  });

  it('records the dashboard decision explicitly rather than leaving it implied', () => {
    // The one row where "not a project permission" is the ANSWER, not an omission.
    expect(doc).toMatch(
      /dashboard is a \*\*WORKSPACE\*\* artifact|WORKSPACE artifact, not a project/i,
    );
  });
});
