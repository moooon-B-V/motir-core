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

// ─────────────────────────────────────────────────────────────────────────────
// MOTIR-4089 — the LANE-WIDE half.
//
// The guard above belongs to a FILE and reads its own source, which is what
// `planTargetLockService.test.ts` does. That shape is correct and it is also
// structurally incapable of noticing the file next door: MOTIR-3736 budgeted the
// SERVICE half of the target-lock pair and its guard could not see the
// INTEGRATION half, so the heavier of the two sat on `vitest.config.ts`'s 15 s
// default for another four days and red-flagged two more unrelated pull
// requests. A per-file guard cannot end a per-file omission.
//
// So this pair answers a question about the TREE instead: which tests reset the
// database inside their OWN body — a loop — while riding the global default. That
// predicate is narrow on purpose. ~870 files under `tests/` touch a truncate
// helper, and asking all of them to declare a budget is a different (and much
// larger) change; the ones that reset PER ROUND are the population that cannot
// fit in 15 s under contention, and on `origin/main` there are exactly two.
// ─────────────────────────────────────────────────────────────────────────────

/** The database-reset helpers whose per-round use is what this scan is about. */
export const DATABASE_RESET_CALLS = ['truncateAuthTables', 'resetDatabase'] as const;

/**
 * `source` with every comment and string literal replaced by spaces, LENGTH AND
 * INDICES PRESERVED so a caller can still slice the original.
 *
 * Blanking rather than deleting is the load-bearing detail. The two guards this
 * module already serves both scan files whose PROSE discusses the very calls
 * being matched — `planTargetLockService.test.ts`'s header names
 * `truncateAuthTables` five times, and `projectSquareRanking.test.ts` carries a
 * scanner FIXTURE inside a template literal that contains a literal `it(` and a
 * truncate. A substring check over raw text reports both as offenders, which is
 * the specific way a source-scanning guard cries wolf until somebody deletes it.
 *
 * ⚠️ A template literal is blanked WHOLE, interpolations included. A `${…}` can
 * legally hold code, so this could in principle hide a reset call — it does not
 * today, and a reset issued from inside a string interpolation is a shape worth
 * failing to detect rather than one worth parsing for.
 */
export function stripCommentsAndStrings(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };

  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') j += 2;
        else if (source[j] === quote) break;
        else j += 1;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/** The span of the block opened by the first `{` at or after `from`, or null. */
function blockAfter(code: string, from: number): { start: number; end: number } | null {
  const start = code.indexOf('{', from);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return { start, end: code.length };
}

/**
 * Every `it(...)` in `source` that resets the database INSIDE a loop and declares
 * no explicit `timeout`.
 *
 * The loop is matched by BRACE, not by proximity: a test that loops over one
 * thing and truncates once after it is not this shape, and a predicate that only
 * asked whether both tokens appear in the same body would report it. The budget
 * is read from the `it(...)` OPTIONS position — everything before the callback's
 * `=>` — which is where `{ timeout: X }` sits whatever the constant is called, so
 * this scan needs no per-file knowledge of budget names.
 *
 * The return value is the offending tests' opening line, taken from the ORIGINAL
 * source so the title is readable; an empty array is the passing state.
 */
export function loopedDatabaseResetTests(
  source: string,
  resetCalls: readonly string[] = DATABASE_RESET_CALLS,
): string[] {
  const code = stripCommentsAndStrings(source);
  const marker = /\b(it|describe)(?:\.each)?\(/g;
  const starts: Array<{ index: number; kind: string }> = [];
  for (const m of code.matchAll(marker)) starts.push({ index: m.index, kind: m[1] as string });

  const offenders: string[] = [];
  for (let n = 0; n < starts.length; n += 1) {
    const here = starts[n]!;
    if (here.kind !== 'it') continue;
    const end = starts[n + 1]?.index ?? code.length;
    const chunk = code.slice(here.index, end);

    // The options position: everything ahead of the callback arrow. Strings are
    // already blanked, so a TITLE containing the word "timeout" cannot match.
    const arrow = chunk.indexOf('=>');
    const header = arrow === -1 ? chunk : chunk.slice(0, arrow);
    if (/\btimeout\s*:/.test(header)) continue;

    let looped = false;
    for (const m of chunk.matchAll(/\b(?:for|while)\s*\(/g)) {
      const body = blockAfter(chunk, m.index);
      if (!body) continue;
      const inside = chunk.slice(body.start, body.end);
      if (resetCalls.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(inside))) {
        looped = true;
        break;
      }
    }
    if (!looped) continue;

    const firstNewline = source.indexOf('\n', here.index);
    offenders.push(source.slice(here.index, firstNewline === -1 ? end : firstNewline).trim());
  }
  return offenders;
}
