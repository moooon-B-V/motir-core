import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// The anti-recurrence guard for MOTIR-2101 / MOTIR-2224.
//
// Both cards were the SAME defect — an assertion on a fixed-window rate
// limiter's accumulated count, with no alignment to the epoch-aligned grid the
// limiter buckets on. MOTIR-2101 root-caused it, fixed `rate-limit.test.ts`,
// and stopped there; the class survived untouched in `story-gate.test.ts` and
// was re-diagnosed from scratch a week later. What made that possible is that
// the fix was a LOCAL const in one test file, invisible to the next author.
//
// So the boundary arithmetic now lives in exactly one module, and this guard
// keeps it that way: a third copy pasted into a new suite fails here, at the
// moment it is written, instead of red-lighting unrelated PRs weeks later.

const REPO_ROOT = process.cwd();
const TESTS_DIR = join(REPO_ROOT, 'tests');

/** The one module allowed to compute a window's phase. */
const HELPER = 'tests/helpers/rateLimitWindow.ts';

/**
 * A hand-rolled grid phase: any modulo of the wall clock. Built from escapes so
 * this file's own source is not itself a match — the guard must not be the
 * second copy it exists to forbid.
 */
const GRID_PHASE = new RegExp(String.raw`Date\.now\(\)\s*%`);

/** Every `.ts` / `.tsx` under `tests/`, repo-relative with POSIX separators. */
function testSources(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) found.push(relative(REPO_ROOT, full).split(sep).join('/'));
    }
  };
  walk(TESTS_DIR);
  return found.sort();
}

describe('fixed-window alignment lives in ONE place', () => {
  it('finds the test tree at all (a guard over zero files proves nothing)', () => {
    const files = testSources();

    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(HELPER);
    expect(files).toContain('tests/api/v1/rate-limit.test.ts');
    expect(files).toContain('tests/api/v1/story-gate.test.ts');
  });

  it('no file under tests/ computes a window phase except the shared helper', () => {
    const offenders = testSources().filter(
      (file) => file !== HELPER && GRID_PHASE.test(readFileSync(join(REPO_ROOT, file), 'utf8')),
    );

    expect(
      offenders,
      `these files hand-roll the fixed-window phase instead of importing ` +
        `\`waitForWindowBoundary\` from ${HELPER} — see MOTIR-2224`,
    ).toEqual([]);
  });

  // The mirror of the assertion above: the helper must actually still be the
  // definition. Without this, deleting its body would make the sweep vacuous.
  it('the shared helper IS the definition', () => {
    expect(GRID_PHASE.test(readFileSync(join(REPO_ROOT, HELPER), 'utf8'))).toBe(true);
  });

  // ⚠️ The guard is proven by DELIBERATELY introducing the violation — a guard
  // that has never been shown to fail is indistinguishable from no guard.
  it('the guard actually fires on a hand-rolled copy', () => {
    // Interpolated rather than written out, so THIS file is not the second
    // copy — the assertion below is over the evaluated string, which is.
    const copied = `const wait = (w: number) => sleep(w - (Date.now() ${'%'} w) + 5);`;

    expect(GRID_PHASE.test(copied)).toBe(true);
  });

  it('does NOT fire on an ordinary wall-clock read', () => {
    const innocent = 'const startedAt = Date.now();\nconst elapsed = Date.now() - startedAt;';

    expect(GRID_PHASE.test(innocent)).toBe(false);
  });

  // The other half of the contract: every suite that asserts on an ACCUMULATED
  // count must be getting the alignment from the helper, not merely
  // not-redefining it. `conformance.test.ts` is on this list because it sets
  // the limiter env directly rather than through a local `budget()` helper —
  // which is exactly how it survived two sweeps that grepped for `budget(`.
  //
  // The next two arrived with MOTIR-2598, which moved the upload and
  // public-submit throttles off their per-process Maps onto the shared store:
  // that swap is what makes them accumulating fixed-window assertions, and so
  // members of this class, in a part of the tree (`tests/attachments`,
  // `tests/publicProjects`) no `/api/v1`-shaped sweep would have looked at.
  //
  // The last is MOTIR-2647 — the fourth occurrence of the class, and the first
  // to fire from `tests/mcp`. It set the budget and left the window at the
  // shipped 60 s default, so its two calls straddled a minute and the refusal it
  // asserted arrived as `PROJECT_NOT_FOUND`. Note what the file already had: the
  // window env sat in its own cleanup list, so the knob was known and simply
  // never set — which is why membership of this list is the assertion, not
  // whether the author was aware the window existed.
  it.each([
    'tests/api/v1/rate-limit.test.ts',
    'tests/api/v1/story-gate.test.ts',
    'tests/api/v1/conformance.test.ts',
    'tests/attachments/attachments-service.test.ts',
    'tests/publicProjects/publicSubmit.test.ts',
    'tests/mcp/rate-limit-gate.test.ts',
  ])('%s imports the shared helper', (file) => {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');

    expect(source).toContain('helpers/rateLimitWindow');
    expect(source).toContain('waitForWindowBoundary');
  });
});
