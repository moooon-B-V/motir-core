import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// The anti-recurrence guard for MOTIR-2598 — "there is ONE counter", enforced.
//
// Subtask 8.5.9 (MOTIR-1165) landed one shared `RateLimitStore` and stated that
// the repo holds exactly one store implementation per backend. That was true of
// the STORE and not of every POLICY: `attachmentsService` and
// `publicProjectsService` each kept a module-level `Map` used as a sliding-window
// counter, so on Fly's two machines their advertised ceilings were really
// `limit x instances`. Nothing failed when that happened, and nothing would have
// failed the next time either — the defect is INVISIBLE to a single-process test
// suite, because one process is exactly where a per-process counter looks
// correct.
//
// So the check that catches it is structural, and it is written the way the
// card's acceptance criteria phrased it: a grep, run by CI instead of by hand.
// (`tests/api/v1/rate-limit-window-alignment.test.ts` is the sibling of this
// idea for the test-side defect.)

const REPO_ROOT = process.cwd();
const LIB_DIR = join(REPO_ROOT, 'lib');

/** The ONLY two files allowed to implement `RateLimitStore` (ADR §6). */
const STORE_IMPLEMENTATIONS = ['lib/api/v1/rateLimit.ts', 'lib/rateLimit/postgresStore.ts'];

/**
 * A `Map` whose values are a list of timestamps — the shape of every hand-rolled
 * sliding-window limiter, and the shape of both counters MOTIR-2598 removed.
 * Deliberately narrow: `lib/` is full of legitimate `Map`s (report buckets, a
 * `loginByUser` index), and a guard that flags those gets deleted rather than
 * obeyed.
 */
const TIMESTAMP_LOG_MAP = /new Map<[^>]*number\[\]\s*>/;

/**
 * A store FACTORY — `createInProcessRateLimitStore` / `createPostgresRateLimitStore`.
 *
 * Matching the factory rather than "any function returning `RateLimitStore`" is
 * what keeps `lib/rateLimit/store.ts` off the list: it RESOLVES which of the two
 * a deployment gets and builds neither, which is the single-seam design ADR §6
 * pins. A third factory anywhere is a third counter.
 */
const DECLARES_STORE = /export function create\w*RateLimitStore\s*\(/;

/** Every `.ts` under `lib/`, repo-relative with POSIX separators. */
function libSources(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) found.push(relative(REPO_ROOT, full).split(sep).join('/'));
    }
  };
  walk(LIB_DIR);
  return found.sort();
}

const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');

describe('there is ONE rate-limit counter, and it is the shared store', () => {
  it('finds the lib tree at all (a guard over zero files proves nothing)', () => {
    const files = libSources();

    expect(files.length).toBeGreaterThan(100);
    for (const impl of STORE_IMPLEMENTATIONS) expect(files).toContain(impl);
    expect(files).toContain('lib/services/attachmentsService.ts');
    expect(files).toContain('lib/services/publicProjectsService.ts');
  });

  it('no file under lib/ keeps a Map of timestamps as a limiter', () => {
    const offenders = libSources().filter((file) => TIMESTAMP_LOG_MAP.test(read(file)));

    expect(
      offenders,
      'these files hand-roll a per-process sliding window instead of counting through ' +
        '`consumeSharedRateLimit` — the ceiling they advertise is really `limit x instances` ' +
        '(see MOTIR-2598)',
    ).toEqual([]);
  });

  it('only the two blessed files implement RateLimitStore', () => {
    const implementations = libSources().filter((file) => DECLARES_STORE.test(read(file)));

    expect(implementations).toEqual(STORE_IMPLEMENTATIONS);
    // ...and the resolver is NOT one of them — it chooses between the two.
    expect(implementations).not.toContain('lib/rateLimit/store.ts');
  });

  // ⚠️ Proven by DELIBERATELY introducing the violation — a guard that has never
  // been shown to fail is indistinguishable from no guard.
  it('the pattern actually fires on the counters this card removed', () => {
    expect(TIMESTAMP_LOG_MAP.test('const uploadLog = new Map<string, number[]>();')).toBe(true);
    expect(TIMESTAMP_LOG_MAP.test('const submissionLog = new Map<string, number[]>();')).toBe(true);
  });

  it('does NOT fire on the ordinary Maps lib/ is full of', () => {
    expect(
      TIMESTAMP_LOG_MAP.test('const byBucket = new Map(rows.map((r) => [r.bucket, r]));'),
    ).toBe(false);
    expect(
      TIMESTAMP_LOG_MAP.test(
        'const counts = new Map<string, { windowStart: number; count: number }>();',
      ),
    ).toBe(false);
  });

  // The other half of the contract: the two converted surfaces must be counting
  // through the shared limiter, not merely not-holding-a-Map. A surface that
  // dropped its throttle entirely would pass every assertion above.
  it.each([
    ['lib/services/attachmentsService.ts', "rateLimitKey('upload'"],
    ['lib/services/publicProjectsService.ts', "rateLimitKey('public-submit'"],
  ])('%s counts through the shared store', (file, key) => {
    const source = read(file);

    expect(source).toContain('consumeSharedRateLimit');
    expect(source).toContain(key);
  });
});
