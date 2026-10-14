import { resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  BETTER_AUTH_RATE_LIMIT_PREFIX,
  betterAuthRateLimitKey,
  createBetterAuthRateLimitStorage,
} from '@/lib/rateLimit/betterAuthStorage';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { adminDb } from '../helpers/adminDb';
import { truncateRateLimitCounters } from '../helpers/db';
import {
  pinSharedRateLimitStoreDeadline,
  testDeadlineRateLimitStore,
} from '../helpers/rateLimitStore';
import {
  findInProcessStoreConstruction,
  findMemoryStorage,
  findModuleScopeState,
  INVENTORY_CLASSES,
  parseInventoryTable,
  pathsIn,
  readRepoFile,
  walkSources,
  type InventoryRow,
} from './scan';

// THE GUARDS THAT NO MODULE-SCOPE STATE RETURNS (Story MOTIR-8547 · MOTIR-8619,
// cases 9-14 of the story gate).
//
// The story found every in-process state in `app` and either moved it to
// Postgres or showed it safe per instance (`docs/in-process-state-inventory.md`).
// These guards keep that true after the story merges: the inventory stays
// consistent, the sites that WERE moved hold no module-scope state again,
// Better-Auth never goes back to its `memory` default, and the in-process
// limiter store is constructed only where the `memory` backend lives.
//
// ⚠️ IT TOUCHES A DATABASE, SO IT STAYS IN THE SHARDED RUN. Case 9 writes a
// moved row's state through the app's client and reads it through a second
// client; that is why `tests/helpers/structuralGuardLane.ts` declares this file
// in `DATABASE_BOUND_GUARDS` instead of the structural-guard lane.

const ROOT = resolve(__dirname, '..', '..');
const INVENTORY = 'docs/in-process-state-inventory.md';
const rows = parseInventoryTable(readRepoFile(ROOT, INVENTORY));

/**
 * The rows the sweep classed **moved** at its ref (MOTIR-8612, `f29727cea`),
 * by the first path in their `file:line` cell. Pinned rather than derived: the
 * point of the move is that the inventory no longer says "moved", so the
 * inventory alone cannot say which rows were. Only Better-Auth's limiter was,
 * and MOTIR-8613 moved it (the move card, MOTIR-8615, found nothing else).
 */
const MOVED_AT_SWEEP = ['lib/auth/index.ts'] as const;

/**
 * The four **safe per instance** rows whose bound is not a number of seconds.
 * The inventory's finding F3 raised them to the owner: each caches a value that
 * is immutable in practice (an installation id, the App's bot slug, a Sentry
 * project id, an immutable image tag), and "until restart" is the honest bound.
 * The guard pins them by site and by that exact text, tight in both directions:
 * a fifth row without a number fails, and so does one of these four gaining a
 * number without leaving this list.
 */
const UNTIL_RESTART_ROWS = [
  '`lib/agentInstances/imageCatalog.ts:90`',
  '`lib/github/repoProvisioning.ts:207`',
  '`lib/github/runGitCredential.ts:294`',
  '`lib/monitoring/sentryErrorCount.ts:76`',
] as const;
const UNTIL_RESTART_BOUND = 'until restart (F3)';

/** A row's sites: the paths in its `file:line` cell, then those in its target cell. */
function sitesOf(row: InventoryRow): string[] {
  return [...new Set([...pathsIn(row.site), ...pathsIn(row.target)])];
}

function movedRows(): InventoryRow[] {
  return MOVED_AT_SWEEP.map((path) => {
    const row = rows.find((r) => pathsIn(r.site)[0] === path);
    if (!row) throw new Error(`${INVENTORY} has no row for ${path}`);
    return row;
  });
}

describe('case 10 — the inventory is consistent', () => {
  it('parses a real table — the guard is not vacuous', () => {
    expect(rows.length).toBeGreaterThanOrEqual(30);
  });

  it('every row has exactly one of the three classes, and none is still "moved"', () => {
    for (const row of rows) {
      expect(INVENTORY_CLASSES, `${row.site} has class "${row.cls}"`).toContain(row.cls);
    }
    expect(rows.filter((r) => r.cls === 'moved').map((r) => r.site)).toEqual([]);
  });

  it('every safe-per-instance row carries a numeric bound in seconds, F3 rows aside', () => {
    const safe = rows.filter((r) => r.cls === 'safe per instance');
    expect(safe.length).toBeGreaterThan(0);
    const unnumbered = safe.filter((r) => !/^\d+$/.test(r.bound));
    expect(unnumbered.map((r) => r.site).sort()).toEqual([...UNTIL_RESTART_ROWS].sort());
    for (const row of unnumbered) expect(row.bound).toBe(UNTIL_RESTART_BOUND);
  });

  it('every row the sweep classed moved now reads shared, and names its store', () => {
    for (const row of movedRows()) {
      expect(row.cls, row.site).toBe('shared');
      expect(row.target, `${row.site} names no store`).toMatch(/rate_limit_counter/);
    }
  });
});

describe('case 9 — every moved row, on a shared store', () => {
  // The move card (MOTIR-8615) moved nothing: the only moved row was
  // Better-Auth's limiter, which MOTIR-8613 owned. So the move card's own list is
  // empty — asserted above as "no row is classed moved" — and the one row the
  // story moved gets its two-client and concurrency arms here.
  //
  // Its own tests (`tests/rateLimit/betterAuthStorage.test.ts`) count through two
  // ADAPTERS on one client. What they leave is the second CLIENT: a write through
  // the app's Prisma client must be visible through another connection to the
  // same database, which is what a second machine is.
  const HOUR = { window: 3600, max: 3 };
  const T = 1_000 * 3600 * 600 + 900_000; // 15 minutes into an hour window

  beforeEach(async () => {
    await truncateRateLimitCounters();
    pinSharedRateLimitStoreDeadline();
  });
  afterEach(() => __resetSharedRateLimitStoreForTest());
  afterAll(async () => {
    await db.$disconnect();
  });

  it('the list is exactly Better-Auth’s limiter', () => {
    expect(movedRows().map((r) => sitesOf(r))).toEqual([
      ['lib/auth/index.ts', 'lib/rateLimit/betterAuthStorage.ts'],
    ]);
  });

  it('a write through the app client is read through a second client', async () => {
    const storage = createBetterAuthRateLimitStorage(undefined, { now: () => T });
    await storage.consume('198.51.100.7|/sign-in/email', HOUR);
    await storage.consume('198.51.100.7|/sign-in/email', HOUR);

    const seen = await adminDb.rateLimitCounter.findMany({
      where: { key: { startsWith: BETTER_AUTH_RATE_LIMIT_PREFIX } },
    });
    expect(seen.map((r) => ({ key: r.key, count: r.count }))).toEqual([
      { key: betterAuthRateLimitKey('198.51.100.7|/sign-in/email'), count: 2 },
    ]);
  });

  it('10 simultaneous callers on two adapters: exactly 3 allowed, a count of 10', async () => {
    const machines = [
      createBetterAuthRateLimitStorage(testDeadlineRateLimitStore(), { now: () => T }),
      createBetterAuthRateLimitStorage(testDeadlineRateLimitStore(), { now: () => T }),
    ];
    const key = '198.51.100.8|/request-password-reset';
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => machines[i % 2]!.consume(key, HOUR)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    for (const refused of results.filter((r) => !r.allowed)) {
      expect(refused.retryAfter).toBe(2700);
    }
    const row = await adminDb.rateLimitCounter.findFirst({
      where: { key: betterAuthRateLimitKey(key) },
    });
    expect(row?.count).toBe(10);
  });
});

describe('case 11 — the moved sites hold no module-scope state', () => {
  it('each site of each moved row is free of module-scope Map / Set / WeakMap / let', () => {
    const checked: string[] = [];
    for (const row of movedRows()) {
      const bound = /^\d+$/.test(row.bound) ? Number(row.bound) : null;
      for (const file of sitesOf(row)) {
        expect(findModuleScopeState(readRepoFile(ROOT, file), bound), file).toEqual([]);
        checked.push(file);
      }
    }
    expect(checked).toContain('lib/auth/index.ts');
  });
});

describe('case 12 — Better-Auth never goes back to its memory storage', () => {
  const files = walkSources(ROOT, ['lib', 'app']);

  it('walks a real tree', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('lib/auth/index.ts');
  });

  it("no file under lib/ or app/ sets storage: 'memory'", () => {
    const hits = files.flatMap((f) =>
      findMemoryStorage(readRepoFile(ROOT, f)).map((h) => `${f}:${h.line} ${h.text}`),
    );
    expect(hits).toEqual([]);
  });

  it('authOptions.rateLimit names customStorage', () => {
    const source = readRepoFile(ROOT, 'lib/auth/index.ts');
    const block = /\n {2}rateLimit: \{\n([\s\S]*?)\n {2}\},\n/.exec(source);
    expect(block, 'no top-level rateLimit block in authOptions').not.toBeNull();
    expect(block![1]).toMatch(/^\s+customStorage: createBetterAuthRateLimitStorage\(\),$/m);
    expect(block![1]).not.toMatch(/\bstorage:/);
  });
});

describe('case 13 — only the memory backend constructs the in-process store', () => {
  it('createInProcessRateLimitStore( appears outside tests/ only where it is allowed', () => {
    const files = walkSources(ROOT, ['lib', 'app', 'components', 'packages', 'scripts']);
    const sites = files.filter((f) => findInProcessStoreConstruction(readRepoFile(ROOT, f)).length);
    expect(sites.sort()).toEqual(['lib/api/v1/rateLimit.ts', 'lib/rateLimit/store.ts']);
  });

  it('in store.ts it is the memory branch, and nowhere else', () => {
    const source = readRepoFile(ROOT, 'lib/rateLimit/store.ts');
    const hits = findInProcessStoreConstruction(source);
    expect(hits).toHaveLength(1);
    const lines = source.split('\n');
    // `resolveRateLimitBackend() === 'postgres' ? <postgres> : <in-process>`
    expect(lines[hits[0]!.line - 3]).toMatch(/resolveRateLimitBackend\(\) === 'postgres'/);
    expect(hits[0]!.text).toMatch(/^: createInProcessRateLimitStore\(\);$/);
  });
});

describe('case 14 — control: the scanners flag what they exist to flag', () => {
  const PLANTED_MAP = [
    "import { x } from './x';",
    'const buckets = new Map<string, number>();',
    'export function consume(key: string) {',
    '  const local = new Map();',
    '  return local.size;',
    '}',
  ].join('\n');
  const PLANTED_STORAGE = [
    'export const authOptions = {',
    '  rateLimit: {',
    "    storage: 'memory',",
    '  },',
    '};',
  ].join('\n');

  it('a planted module-scope new Map() is flagged; the one inside a function is not', () => {
    expect(findModuleScopeState(PLANTED_MAP, null)).toEqual([
      { line: 2, text: 'const buckets = new Map<string, number>();', why: 'module-scope new Map(' },
    ]);
  });

  it('module-scope Set, WeakMap and let are flagged too', () => {
    const hits = findModuleScopeState(
      [
        'const seen = new Set();',
        'export const refs = new WeakMap();',
        'let counter = 0;',
        '// let commented = 1;',
      ].join('\n'),
      null,
    );
    expect(hits.map((h) => h.why)).toEqual([
      'module-scope new Set(',
      'module-scope new WeakMap(',
      'module-scope mutable let/var',
    ]);
  });

  it('a read-through cache marker excuses a line only within the recorded bound', () => {
    const line = 'const cache = new Map(); // read-through cache, TTL 30s';
    expect(findModuleScopeState(line, 60)).toEqual([]);
    expect(findModuleScopeState(line, 10)).toHaveLength(1);
    expect(findModuleScopeState(line, null)).toHaveLength(1);
  });

  it("a planted storage: 'memory' is flagged, in any quote", () => {
    expect(findMemoryStorage(PLANTED_STORAGE)).toEqual([
      { line: 3, text: "storage: 'memory',", why: "storage: 'memory'" },
    ]);
    expect(findMemoryStorage('rateLimit: { storage: "memory" }')).toHaveLength(1);
    expect(findMemoryStorage('// storage: "memory" was the default')).toEqual([]);
  });

  it('a planted in-process store construction is flagged', () => {
    expect(
      findInProcessStoreConstruction('const s = createInProcessRateLimitStore();'),
    ).toHaveLength(1);
  });
});
