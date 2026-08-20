// MOTIR-3167 — the scan behind the per-file "no test rides the global timeout"
// guard.
//
// It lives here rather than inside one spec because it has TWO readers that must
// stay identical: `tests/projectSquare/projectSquareRanking.test.ts` and
// `tests/projectSquare/projectSquareGuarantees.test.ts`. The shape is lifted
// from `packages/cli/test/releaseCli.test.ts` (MOTIR-2016/2017), which wrote the
// same guard inline for the one file it had; a second file is the point at which
// copying it would start to drift.
//
// ⚠️ WRITTEN AS A SCAN, NOT AS A COUNT — MOTIR-2017's lesson, and the whole
// reason this module exists. "The thirteen tests in this file carry a budget" is
// true today and says nothing about the fourteenth, and the fourteenth is
// exactly how `projectSquareRanking.test.ts` ended up with a 15 s timer around a
// real-Postgres keyset walk. The assertion is over whatever is in the source
// now, so a test added tomorrow inherits the guard instead of quietly escaping
// it.

/**
 * Every `it(...)` in `source` that names none of `budgetNames`.
 *
 * The return value is the offending tests' opening text (title included), which
 * is what a reader needs to find them; an empty array is the passing state.
 *
 * The chunking cuts at BOTH `it(` and `describe(`, and that detail is load
 * bearing rather than incidental — MOTIR-2017 recorded getting it wrong. Cutting
 * at `it(` alone lets a helper defined at the top of a `describe` trail the
 * PREVIOUS test's chunk, so the scan then blames a test that does not contain
 * the text at all. Ending each chunk at its enclosing block keeps every match
 * inside the test it belongs to.
 *
 * `it.each(...)` is matched too. Its budget rides the third argument of the
 * returned call rather than the second, which is a different position for the
 * same thing — and a scan that missed the form would silently exempt the two
 * most expensive tests in `projectSquareGuarantees.test.ts`.
 */
export function testsRidingTheDefaultTimeout(
  source: string,
  budgetNames: readonly string[],
): string[] {
  const marker = /\b(it|describe)(?:\.each)?\(/g;
  const chunks: Array<{ kind: string; body: string }> = [];

  let match = marker.exec(source);
  while (match !== null) {
    const next = marker.exec(source);
    chunks.push({
      kind: match[1] as string,
      body: source.slice(match.index, next?.index ?? source.length),
    });
    match = next;
  }

  return chunks
    .filter((c) => c.kind === 'it')
    .filter((c) => !budgetNames.some((name) => c.body.includes(name)))
    .map((c) => c.body.slice(0, Math.max(c.body.indexOf('\n'), 0) || c.body.length).trim());
}

/** How many `it(...)`s the scan saw — so a guard can prove it did not pass vacuously. */
export function scannedTestCount(source: string): number {
  return source.split(/\bit(?:\.each)?\(/).length - 1;
}
