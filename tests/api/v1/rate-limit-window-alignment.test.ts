import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALIGNED_WINDOW_MS,
  BOUNDARY_OVERSHOOT_MS,
  SUBPROCESS_HEADROOM_MS,
  SUBPROCESS_WINDOW_MS,
  sleep,
  waitForWindowHeadroom,
} from '../../helpers/rateLimitWindow';

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
  // not-redefining it.
  //
  // ── THIS HALF USED TO BE A LIST, AND THAT WAS THE BUG (MOTIR-2648) ─────────
  // It was an `it.each([...])` naming six files by hand. A file joined it when
  // whoever fixed that file remembered to add it — and that step was missed on
  // every occurrence after the first: MOTIR-2101 → -2224 → -2598 → -2647 each
  // re-diagnosed the same defect from scratch, and when -2647 was finally fixed
  // the sweep it prompted found the class alive in TWO more suites
  // (`tests/rateLimit/surfaceGuards.test.ts`, with 37 unpinned budgets, and
  // `tests/api-coding-convention-route.test.ts`).
  //
  // So the guard's coverage was a memory of the fires already put out. A list
  // like that cannot see the next one, because nothing walks it except a person
  // — the first half of this file works precisely because it derives its
  // subjects from the tree instead.
  //
  // What replaces it, in three derivations, none hand-maintained:
  //
  //  1. The BUDGETS come from `lib/`. A fixed-window budget is exactly a
  //     `'<NAME>_RATE_LIMIT'` string literal that has a
  //     `'<NAME>_RATE_LIMIT_WINDOW_MS'` sibling literal — that pairing IS what
  //     makes it one. A budget added to `lib/rateLimit/budgets.ts` tomorrow is
  //     therefore in scope with no edit here, and `E2E_DISABLE_RATE_LIMIT`
  //     (a boolean switch, no window) falls out by construction rather than by
  //     an exemption someone had to think of.
  //  2. The SUBJECTS come from the test tree — every file that ASSIGNS one of
  //     those budget envs.
  //  3. The VERDICT is per file: it must pin the matching `*_WINDOW_MS`, or
  //     import the shared helper.
  //
  // ⚠️ Detection is by ASSIGNMENT, never by mention. `surfaceGuards.test.ts`
  // listed all six `*_WINDOW_MS` names in its cleanup array while setting none
  // of them — "cleans up a knob it never sets" is the signature of this defect,
  // so a guard that merely grepped for the window NAME would have called that
  // file compliant and found nothing at all.
  //
  // Assignment is resolved through a local const alias too
  // (`const LIMIT_ENV = '…'; process.env[LIMIT_ENV] = '1'`), because that is the
  // form `tests/mcp/rate-limit-gate.test.ts` uses — the most recent instance of
  // the class would have been invisible to a literal-only matcher.

  /** `lib/` sources, where the budget env names are defined. */
  function libSources(): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry)) found.push(full);
      }
    };
    walk(join(REPO_ROOT, 'lib'));
    return found;
  }

  /**
   * The budget envs, derived from `lib/`: a `*_RATE_LIMIT` literal that also has
   * a `*_RATE_LIMIT_WINDOW_MS` sibling. The pair is what makes it a FIXED-WINDOW
   * budget, and so a member of this class.
   */
  function budgetEnvs(): string[] {
    const literals = new Set<string>();
    for (const file of libSources()) {
      for (const [, name] of readFileSync(file, 'utf8').matchAll(
        /'([A-Z0-9_]+_RATE_LIMIT(?:_WINDOW_MS)?)'/g,
      )) {
        if (name) literals.add(name);
      }
    }
    return [...literals]
      .filter((name) => !name.endsWith('_WINDOW_MS') && literals.has(`${name}_WINDOW_MS`))
      .sort();
  }

  /**
   * The env names a source ASSIGNS — `process.env.X =`, `process.env['X'] =`,
   * `vi.stubEnv('X', …)`, and `process.env[ALIAS] =` where `ALIAS` is a local
   * const bound to a string literal.
   *
   * Deliberately NOT "names the source mentions": a cleanup array that deletes a
   * window it never sets is the exact shape this guard exists to catch.
   */
  function assignedEnvs(source: string): Set<string> {
    const aliases = new Map<string, string>();
    for (const [, alias, value] of source.matchAll(
      /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*'([A-Z0-9_]+)'/g,
    )) {
      if (alias && value) aliases.set(alias, value);
    }

    const assigned = new Set<string>();
    for (const [, dotted, single, double] of source.matchAll(
      /process\.env(?:\.([A-Z0-9_]+)|\[\s*(?:'([A-Z0-9_]+)'|"([A-Z0-9_]+)")\s*\])\s*=[^=]/g,
    )) {
      const name = dotted ?? single ?? double;
      if (name) assigned.add(name);
    }
    // `process.env[ALIAS] = …` — resolve the alias to the literal it holds.
    for (const [, alias] of source.matchAll(/process\.env\[\s*([A-Za-z_$][\w$]*)\s*\]\s*=[^=]/g)) {
      const resolved = alias === undefined ? undefined : aliases.get(alias);
      if (resolved) assigned.add(resolved);
    }
    for (const [, name] of source.matchAll(/vi\.stubEnv\(\s*'([A-Z0-9_]+)'/g)) {
      if (name) assigned.add(name);
    }
    return assigned;
  }

  /**
   * Suites that assign a budget and legitimately pin NEITHER a window nor the
   * helper. An exemption is a decision ON THE RECORD with the reason it is one —
   * the point of the derivation is that forgetting is no longer an option, not
   * that no file may ever be exempt.
   *
   * Empty is the honest state right now: every current assigner either pins its
   * window or imports the helper. A genuinely single-call suite added later
   * belongs here WITH its reason, not silently.
   */
  const EXEMPT: ReadonlyMap<string, string> = new Map();

  it('derives the budget envs from lib/ (a guard over zero budgets proves nothing)', () => {
    const budgets = budgetEnvs();

    expect(budgets.length).toBeGreaterThanOrEqual(6);
    expect(budgets).toContain('MOTIR_API_V1_RATE_LIMIT');
    expect(budgets).toContain('MOTIR_AI_GENERATE_RATE_LIMIT');
    // A switch with no window is not a fixed-window budget, and is excluded by
    // the pairing rather than by an exemption.
    expect(budgets).not.toContain('E2E_DISABLE_RATE_LIMIT');
  });

  it('every test file that sets a budget pins its window or imports the helper', () => {
    const budgets = budgetEnvs();
    const offenders: string[] = [];

    for (const file of testSources()) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      const assigned = assignedEnvs(source);
      const set = budgets.filter((name) => assigned.has(name));
      if (set.length === 0 || EXEMPT.has(file)) continue;

      if (source.includes('helpers/rateLimitWindow')) continue;
      const unpinned = set.filter((name) => !assigned.has(`${name}_WINDOW_MS`));
      if (unpinned.length > 0) offenders.push(`${file} → ${unpinned.join(', ')}`);
    }

    expect(
      offenders,
      `these test files set a rate-limit BUDGET and leave the matching WINDOW at ` +
        `the shipped 60 s default, so calls they expect to be counted together can ` +
        `straddle an epoch-aligned boundary and reset the counter mid-test. Pin ` +
        `\`<BUDGET>_WINDOW_MS\` to \`ALIGNED_WINDOW_MS\`, and if the case asserts a ` +
        `REFUSAL that depends on earlier calls also ` +
        `\`await waitForWindowBoundary(ALIGNED_WINDOW_MS)\` — both from ${HELPER}. ` +
        `See MOTIR-2648`,
    ).toEqual([]);
  });

  // ⚠️ Same discipline as the copy-detection half above: the derivation is
  // proven by DELIBERATELY introducing the violation. A guard nobody has watched
  // fail is indistinguishable from no guard — and this half REPLACED one that
  // silently passed through four occurrences of the defect.
  it('the derivation fires on a budget set with no window pinned', () => {
    const violating = `process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = '1';`;
    const assigned = assignedEnvs(violating);

    expect(assigned.has('MOTIR_AI_GENERATE_RATE_LIMIT')).toBe(true);
    expect(assigned.has('MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS')).toBe(false);
  });

  it('the derivation is NOT satisfied by merely NAMING the window', () => {
    // The `surfaceGuards.test.ts` shape exactly: the window sits in a cleanup
    // array, so the name is present while the knob is never set. A mention-based
    // check would have passed this file for as long as it existed.
    const naming = [
      `const ENVS = ['MOTIR_AI_GENERATE_RATE_LIMIT', 'MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS'];`,
      `for (const key of ENVS) delete process.env[key];`,
      `process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = '1';`,
    ].join('\n');
    const assigned = assignedEnvs(naming);

    expect(assigned.has('MOTIR_AI_GENERATE_RATE_LIMIT')).toBe(true);
    expect(assigned.has('MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS')).toBe(false);
  });

  it('the derivation sees an assignment made through a const alias', () => {
    // `tests/mcp/rate-limit-gate.test.ts`'s form — the most recent occurrence of
    // the class, and invisible to a literal-only matcher.
    const aliased = [
      `const LIMIT_ENV = 'MOTIR_AI_GENERATE_RATE_LIMIT';`,
      `const WINDOW_ENV = 'MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS';`,
      `process.env[LIMIT_ENV] = '1';`,
      `process.env[WINDOW_ENV] = String(ALIGNED_WINDOW_MS);`,
    ].join('\n');
    const assigned = assignedEnvs(aliased);

    expect(assigned.has('MOTIR_AI_GENERATE_RATE_LIMIT')).toBe(true);
    expect(assigned.has('MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS')).toBe(true);
  });

  it('the derivation does NOT fire on a mere READ of the env', () => {
    const reading = `const budget = Number(process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] ?? '10');`;

    expect(assignedEnvs(reading).has('MOTIR_AI_GENERATE_RATE_LIMIT')).toBe(false);
  });

  it('every exemption carries a reason', () => {
    for (const [file, reason] of EXEMPT) {
      expect(testSources(), `${file} is exempted but does not exist`).toContain(file);
      expect(reason.length, `${file}'s exemption needs a reason`).toBeGreaterThan(20);
    }
  });
});

// The helper's own contract. `waitForWindowBoundary` is exercised by every suite
// that imports it; `waitForWindowHeadroom` (MOTIR-2648) is newer and its whole
// value is the branch — it must SKIP the sleep when the cell has room and take
// it when it does not, because a version that always slept would silently cost
// 30 s per subprocess case and one that never slept would be no guard at all.
describe('waitForWindowHeadroom', () => {
  it('returns immediately when the current cell has room to spare', async () => {
    const startedAt = Date.now();
    // A window far larger than the phase can be, so the remainder always clears
    // a 1 ms floor — the no-sleep arm, without depending on the wall clock.
    await waitForWindowHeadroom(Number.MAX_SAFE_INTEGER, 1);

    expect(Date.now() - startedAt).toBeLessThan(50);
  });

  it('sleeps to the next boundary when the cell is too far spent', async () => {
    const windowMs = 200;
    const startedAt = Date.now();
    // Demanding the WHOLE window is the total case — it can never be satisfied
    // by the remainder, so this always takes the sleeping arm, and it is exactly
    // the identity `waitForWindowBoundary(w) ≡ waitForWindowHeadroom(w, w)`.
    await waitForWindowHeadroom(windowMs, windowMs);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThan(0);
    expect(elapsed).toBeLessThanOrEqual(windowMs + BOUNDARY_OVERSHOOT_MS + 100);
  });

  // The guarantee, asserted BEHAVIOURALLY rather than by recomputing the phase:
  // once the call has returned, the cell provably holds at least `headroom`, so
  // an immediate second call with the same arguments must not sleep. Written
  // this way on purpose — spelling the phase expression out here, even to assert
  // on it, would make this file the second copy the sweep above forbids. (It
  // does: the first draft of this comment quoted the expression and the sweep
  // duly failed on its own suite, which is the guard working.)
  it('guarantees the requested headroom, whatever the phase it started in', async () => {
    const windowMs = 200;
    const headroom = 120;

    for (let i = 0; i < 6; i += 1) {
      await waitForWindowHeadroom(windowMs, headroom);

      const startedAt = Date.now();
      await waitForWindowHeadroom(windowMs, headroom);
      expect(Date.now() - startedAt, 'the headroom was not actually secured').toBeLessThan(20);

      await sleep(43); // walk the phase so the next iteration starts elsewhere
    }
  });

  it('is the generalisation of waitForWindowBoundary, not a rival to it', () => {
    // `waitForWindowBoundary(w)` ≡ `waitForWindowHeadroom(w, w)` — the arithmetic
    // still lives in exactly one function, which is what the sweep above checks.
    expect(SUBPROCESS_HEADROOM_MS).toBeLessThan(SUBPROCESS_WINDOW_MS);
    expect(ALIGNED_WINDOW_MS).toBeLessThan(SUBPROCESS_WINDOW_MS);
  });
});
