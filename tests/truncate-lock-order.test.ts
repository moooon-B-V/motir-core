import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-3066 — every `TRUNCATE TABLE` in this repo must name the tables it
// SHARES with any other `TRUNCATE TABLE` in the same relative order.
//
// ── What this does and does NOT guard ───────────────────────────────────────
// This is a DEFENSIVE guard, and the PR that added it says so plainly, because
// the flake that produced this file was NOT a truncate-vs-truncate collision.
// Postgres named both transactions of the real deadlock, and the other side was
// an ordinary bound SELECT whose lock order comes from the query PLAN — which no
// convention among truncate helpers can constrain. That leak is fixed at its
// source (`lib/async/allSettledOrThrow.ts`), and asserted by
// `tests/work-items/quick-view-refused-peek.test.ts`.
//
// What remains true is that two truncates naming an overlapping table set in
// DIFFERENT orders would deadlock if they ever ran concurrently on one database,
// and that the suite is one worker-database away from that being possible. Two
// files were out of step when this guard was written (`delete.test.ts` and
// `ciFleetCostMeterService.test.ts`); both were reordered to the majority order.
// The cost of keeping them in step is one sorted list; the cost of finding out
// the hard way is a `40P01` in a file that did nothing wrong.
//
// ── Why a source scan ───────────────────────────────────────────────────────
// The statements are string literals scattered across ~80 call sites, most of
// them a suite-local `beforeEach` rather than a shared helper. There is no
// runtime object to assert on, and "reviewers will keep them in order" is the
// review promise this repo has already watched fail. So the assertion reads the
// source, the way `tests/design-asset-addresses.test.ts` does.
//
// ⚠️ Within ONE statement Postgres locks the NAMED relations in list order and
// then the CASCADE-reachable ones in an order it chooses. This guard can only
// see the named half. That is a real limit, not an oversight — it is also why
// the named half is worth keeping consistent rather than treated as arbitrary.

const ROOT = join(__dirname, '..');

/** Directories worth scanning: our source, never vendored or generated trees. */
const SCAN_ROOTS = ['tests', 'lib', 'app', 'scripts', 'packages'];

const SKIP_DIRS = new Set(['node_modules', '.next', 'generated', 'dist', '.turbo']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

interface TruncateSite {
  file: string;
  line: number;
  tables: string[];
}

// A TRUNCATE's table list, allowing the `'…' + '…'` concatenation a few of the
// longer literals use to stay under the line limit.
const TRUNCATE = /TRUNCATE\s+TABLE\s+((?:"[a-z_]+"\s*,?\s*(?:'\s*\+\s*'\s*)?)+)/gi;

function truncateSites(): TruncateSite[] {
  const sites: TruncateSite[] = [];
  for (const root of SCAN_ROOTS) {
    let files: string[];
    try {
      files = walk(join(ROOT, root));
    } catch {
      continue; // an optional workspace root that is not checked out
    }
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (!/TRUNCATE\s+TABLE/i.test(source)) continue;
      TRUNCATE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = TRUNCATE.exec(source)) !== null) {
        const tables = [...match[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
        if (tables.length < 2) continue; // a single-table truncate cannot disagree
        sites.push({
          file: relative(ROOT, file).split(sep).join('/'),
          line: source.slice(0, match.index).split('\n').length,
          tables,
        });
      }
    }
  }
  return sites;
}

describe('every TRUNCATE names its shared tables in one order (MOTIR-3066)', () => {
  it('finds the truncate sites at all — the scan must not silently match nothing', () => {
    // A source-scanning guard whose regex stops matching passes vacuously and
    // reads exactly like a clean repo. Pin a floor so a broken scan is a failure.
    expect(truncateSites().length).toBeGreaterThan(50);
  });

  it('no two truncates order their shared tables differently', () => {
    const sites = truncateSites();
    const conflicts: string[] = [];

    for (let i = 0; i < sites.length; i++) {
      for (let j = i + 1; j < sites.length; j++) {
        const a = sites[i]!;
        const b = sites[j]!;
        const shared = new Set(a.tables.filter((t) => b.tables.includes(t)));
        if (shared.size < 2) continue;
        const orderA = a.tables.filter((t) => shared.has(t));
        const orderB = b.tables.filter((t) => shared.has(t));
        if (orderA.join() === orderB.join()) continue;
        conflicts.push(
          `${a.file}:${a.line} takes [${orderA.join(', ')}]\n` +
            `  but ${b.file}:${b.line} takes [${orderB.join(', ')}]`,
        );
      }
    }

    expect(
      conflicts,
      `Two TRUNCATE statements acquire shared tables in opposite orders, which is a\n` +
        `deadlock (40P01) the moment they run against one database. Reorder the\n` +
        `outlier to match its siblings.\n\n${conflicts.join('\n\n')}`,
    ).toEqual([]);
  });
});
