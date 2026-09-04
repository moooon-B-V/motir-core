import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard for MOTIR-4423: a Playwright config MUST bound a navigation itself.
//
// Playwright's default `navigationTimeout` is `0` — no timeout — so `page.goto`,
// `page.goBack` and `page.waitForURL` fall through to whatever the TEST has left
// on its clock. That makes every per-spec ceiling a navigation budget too, and
// this repository raises that ceiling in 126 specs (`test.describe.configure({
// timeout: … })`, 90s–300s in the main lane, 900s in the cloud one). Those
// ceilings are correct where they are — `cloud-plans-surface.spec.ts` explains
// its own at length: the budget is a 22-plan SEED, and a green run pays nothing
// for headroom. What is not correct is a bare `waitForURL` inheriting it.
//
// ⚠️ THE FAILURE THIS PREVENTS IS NOT A RED CHECK, which is why nothing else in
// the repo would notice it. On merge-group run `33856167486` one hung
// `waitForURL` (`cloud-plans-surface.spec.ts:344`) spent the full 900s and then
// PASSED ON RETRY: `billing-cloud` reported success, `CI complete` went green,
// and the only trace was the lane taking 23.3 minutes against a 7.5-minute
// baseline — which held one of the merge queue's three build slots for the
// difference. A guard is the only thing that can see it.
//
// Same mould, and the same no-parser constraint, as `tests/ci-complete-gate.test.ts`:
// the config is read as TEXT rather than imported, because importing it would
// execute a module that spawns a webServer command and reads the environment.

const CONFIGS = ['playwright.config.ts', 'playwright.cloud.config.ts'] as const;

/** The numeric literal for `key`, with `_` separators removed. */
function numeric(source: string, key: string): number | null {
  const m = new RegExp(`^\\s*${key}:\\s*([0-9_]+),`, 'm').exec(source);
  return m ? Number(m[1]!.replaceAll('_', '')) : null;
}

/**
 * The body of the config's TOP-LEVEL `use:` block — two spaces of indentation,
 * closed by a `},` at the same depth. Scoped deliberately: `projects: [{ …, use:
 * { …devices } }]` carries a `use` of its own at deeper indentation, and a
 * project-level value would NOT cover the lane's own defaults.
 */
function topLevelUse(source: string): string | null {
  const m = /^ {2}use: \{\n([\s\S]*?)^ {2}\},$/m.exec(source);
  return m ? m[1]! : null;
}

describe('a Playwright config bounds a navigation itself (MOTIR-4423)', () => {
  it.each(CONFIGS)('%s declares a top-level `use` block', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    expect(topLevelUse(source), `${file} has a top-level use: block`).not.toBeNull();
  });

  it.each(CONFIGS)('%s sets navigationTimeout in it', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    const use = topLevelUse(source)!;
    expect(
      numeric(use, 'navigationTimeout'),
      `${file} must set use.navigationTimeout — without it a navigation is bounded only by the ` +
        `test's own ceiling, which specs raise to as much as 900_000ms`,
    ).toBeGreaterThan(0);
  });

  it.each(CONFIGS)('%s keeps that bound at or under its own test ceiling', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    const ceiling = numeric(source, 'timeout');
    const navigation = numeric(topLevelUse(source)!, 'navigationTimeout')!;
    // A navigation bound ABOVE the ceiling can never fire: the test dies first,
    // which is the state this card found and exactly what the setting is for.
    expect(ceiling, `${file} declares a top-level timeout`).not.toBeNull();
    expect(
      navigation,
      `${file}: navigationTimeout must be ≤ its timeout (${ceiling}ms)`,
    ).toBeLessThanOrEqual(ceiling!);
  });

  // ── Deliberate negatives: the assertions above must be able to FAIL ─────────
  it('fails when navigationTimeout is absent', () => {
    const withoutIt = "  use: {\n    baseURL: BASE_URL,\n    trace: 'retain-on-failure',\n  },";
    expect(numeric(topLevelUse(withoutIt)!, 'navigationTimeout')).toBeNull();
  });

  it('reads the TOP-LEVEL use, not a project-level one', () => {
    const projectOnly =
      '  use: {\n    baseURL: BASE_URL,\n  },\n' +
      '  projects: [{ name: 1, use: { navigationTimeout: 30_000 } }],';
    expect(numeric(topLevelUse(projectOnly)!, 'navigationTimeout')).toBeNull();
  });
});
