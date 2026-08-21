import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// MOTIR-3373 — the guard that keeps "where does a reader land" owned by one file.
//
// ── What this exists to prevent ─────────────────────────────────────────────
// Six defects under Epic 8 were about the signed-in landing, in two shapes:
//
//   ROTTED  — MOTIR-2921 / MOTIR-3171 / MOTIR-3173: a destination that was right
//             when written and still said `/dashboard` after MOTIR-2654 moved
//             the home, each under a comment asserting the old world as fact.
//   SILENT  — MOTIR-3367 / MOTIR-3372: a route that never asked the question, so
//             a sweep for the OLD literal could not have found it.
//
// Each repair enumerated the population by hand, and MOTIR-3171's own sweep
// missed a site because it searched `app/` while the constant lived under
// `components/`. `lib/navigation/landing.ts` is now the single owner; these two
// assertions are what stop a seventh file from re-typing the answer, and they
// are deliberately dumb — a string scan with a named allowlist, not an AST walk.
//
// ⚠️ It is NOT a member of the guards lane, and that is a measurement rather
// than an omission: `tests/ci-structural-guards-lane.test.ts` derives lane
// membership from "imports a scanner module and parses the tree with the
// TypeScript compiler API", which this does not do. It reads ~700 files with
// `readFileSync` and two regexes, in well under a second.

const ROOT = resolve(__dirname, '..', '..');
const ROOTS = ['app', 'components', 'lib'];

/** The one file allowed to spell the destination out. */
const OWNER = join('lib', 'navigation', 'landing.ts');

/**
 * A `/home` STRING LITERAL — `'/home'`, `"/home"`, or a template opening
 * `` `/home?… ` ``. `/homepage` and a `/home` inside prose do not match; the
 * point is the value a route or a link is built FROM.
 */
const HOME_LITERAL = /(['"`])\/home(\?[^'"`]*)?\1/;

/** A `/dashboard` string literal, same shape. */
const DASHBOARD_LITERAL = /(['"`])\/dashboard(\/[^'"`]*)?\1/;

/**
 * The claim that made three repairs necessary: a comment calling something the
 * home, the landing, or the post-auth destination. MOTIR-3173's diagnosis, in a
 * regex — *"the three that mattered are the three sitting under a sentence
 * containing the word home or landing"*.
 *
 * `NO LONGER` / `NOT` guards the negations, which are the honest comments this
 * rule must leave alone: `app/(authed)/dashboard/page.tsx` says `/dashboard` IS
 * NO LONGER a post-auth landing, and that sentence is the opposite of the defect.
 */
const CLAIMS_TO_BE_THE_HOME =
  /\b(the\s+)?(app'?s\s+)?(default\s+)?(authed\s+)?(post-auth\s+)?(home|landing)\b/i;
const NEGATED = /\b(no longer|not|never|isn'?t|instead of)\b/i;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
  };
  for (const root of ROOTS) walk(join(ROOT, root));
  return out;
}

function lines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n');
}

/**
 * The same lines with COMMENTS BLANKED OUT — because both rules below are about
 * what the code DOES, and a comment quoting a route in backticks (which every
 * one of these files does, at length) is prose, not a destination. Deliberately
 * approximate: a `//` inside a string literal truncates that line early, which
 * can only ever cause a MISS, never a false accusation. Nothing here is worth an
 * AST walk — the rules are about literals, and the cost of a miss is one more
 * hand-swept site, which is the state this whole card is leaving behind.
 */
function codeLines(file: string): string[] {
  let inBlock = false;
  return lines(file).map((raw) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) return '';
      line = line.slice(end + 2);
      inBlock = false;
    }
    // Inline block comments, then an unterminated one.
    line = line.replace(/\/\*.*?\*\//g, ' ');
    const open = line.indexOf('/*');
    if (open !== -1) {
      inBlock = true;
      line = line.slice(0, open);
    }
    const slash = line.indexOf('//');
    return slash === -1 ? line : line.slice(0, slash);
  });
}

describe('the landing has ONE owner (MOTIR-3373)', () => {
  it('no file outside lib/navigation/landing.ts spells the landing route out', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const rel = relative(ROOT, file).split(sep).join('/');
      if (rel === OWNER.split(sep).join('/')) continue;
      codeLines(file).forEach((line, i) => {
        if (HOME_LITERAL.test(line)) offenders.push(`${rel}:${i + 1} — ${line.trim()}`);
      });
    }

    expect(
      offenders,
      'The signed-in landing is decided ONCE, in lib/navigation/landing.ts ' +
        '(docs/decisions/home-scope.md §2.3). Import AUTHED_LANDING_PATH — or ' +
        'resolvePostAuthDestination where a ?next= / ?draft= precedence is involved — ' +
        'rather than re-typing the route. A literal here is how MOTIR-2921, MOTIR-3171 ' +
        'and MOTIR-3173 each came to be a separate repair:\n  ' +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it('no /dashboard literal sits under a comment CLAIMING to be the home', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const rel = relative(ROOT, file).split(sep).join('/');
      const all = lines(file);
      codeLines(file).forEach((line, i) => {
        if (!DASHBOARD_LITERAL.test(line)) return;
        // The three lines either side — a constant's explanation sits above it,
        // and an inline note sits beside or below.
        const window = all.slice(Math.max(0, i - 3), i + 4);
        const claim = window.find(
          (l) => /^\s*(\/\/|\*)/.test(l) && CLAIMS_TO_BE_THE_HOME.test(l) && !NEGATED.test(l),
        );
        if (claim) offenders.push(`${rel}:${i + 1} — ${line.trim()}\n      claim: ${claim.trim()}`);
      });
    }

    expect(
      offenders,
      '/dashboard is a real route with a real nav entry, and navigating to it is fine. ' +
        'What is not fine is a /dashboard destination under a comment calling itself the ' +
        'home or the landing — that sentence was true before MOTIR-2654 and is what made ' +
        'MOTIR-3171 and MOTIR-3173 necessary, because the next reader takes it as the ' +
        "product's position and copies it:\n  " +
        offenders.join('\n  '),
    ).toEqual([]);
  });
});
