import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
// `components/`. `lib/navigation/landing.ts` is now the single owner; these
// assertions are what stop a seventh file from re-typing the answer, and they
// are deliberately dumb — a string scan with a named allowlist, not an AST walk.
//
// MOTIR-4403 added the THIRD scan. The module owns three destinations and only
// two were defended; `ONBOARDING_ENTRY_PATH` was already spelled twice, which is
// the ROTTED shape one step before it rots. That card also gave the scans a
// test of their own (the last describe below) — a guard asserted only by passing
// is a guard nobody has watched fire, and the two false-positive shapes the
// existing scans handle by construction were never written down as assertions.
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
 * An `/onboarding` ENTRANCE literal — `'/onboarding'`, `"/onboarding"`, or a
 * template opening `` `/onboarding?…` `` (MOTIR-4403).
 *
 * `lib/navigation/landing.ts` owns THREE destinations and the two scans above
 * defended two of them. `ONBOARDING_ENTRY_PATH` arrived in that module as a
 * neighbour rather than as a subject, so it inherited the ownership claim
 * without the enforcement — and was already spelled twice (a second
 * `export const` in `lib/onboarding/pendingIdea.ts`, which
 * `app/(onboarding)/layout.tsx` imported instead of the owner). Both copies
 * said `/onboarding`, which is exactly the pre-MOTIR-2654 state the three
 * ROTTED repairs above were in: separate copies, each correct when written.
 *
 * ⚠️ IT DELIBERATELY DOES NOT MATCH A SUB-PATH — `'/onboarding/discovery'`,
 * `'/onboarding/migrate'`, `'/onboarding/import'` and the rest are their own
 * routes, not the entrance, and `HOME_LITERAL` above draws the same line for
 * the same reason (it matches `/home` and `/home?…` and not `/home/…`). The
 * question this module answers is *where does a reader LAND*; a link between
 * two pages inside a route group is not an answer to it, and a scan that
 * claimed all seventeen of them would need an allowlist longer than the guard.
 * `lib/onboarding/resumeVisibility.ts`'s `ONBOARDING_RESUME_PATH` is a
 * sub-path constant of exactly that kind and is untouched by this rule.
 * It does not fire on `/onboardings` either — the closing quote is part of the
 * pattern, the same guard `/homepage` gets.
 */
const ONBOARDING_LITERAL = /(['"`])\/onboarding(\?[^'"`]*)?\1/;

/**
 * Files allowed to spell the onboarding ENTRANCE out, each with the reason it
 * is allowed. A named allowlist rather than a bare list of paths: an entry
 * whose reason has stopped being true is the thing a reader can spot, and the
 * `.png` note in `lib/workItems/proseVsGraph.ts` is the register.
 *
 * There is exactly one, and that is the point of the rule.
 */
const ONBOARDING_LITERAL_ALLOWLIST: ReadonlyArray<{ file: string; because: string }> = [
  {
    file: 'lib/navigation/landing.ts',
    because:
      'THE OWNER — `ONBOARDING_ENTRY_PATH` is declared here, and ' +
      '`ONBOARDING_SIGNUP_DOOR_PATH` is composed from it rather than written out.',
  },
];

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
  return codeLinesOf(readFileSync(file, 'utf8'));
}

/**
 * The same blanking, over SOURCE TEXT rather than a path — so the scans can be
 * exercised against synthetic files that are not in the tree (MOTIR-4403). A
 * guard asserted only by passing is a guard nobody has seen fire.
 */
export function codeLinesOf(source: string): string[] {
  let inBlock = false;
  return source.split('\n').map((raw) => {
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

  it('no file outside the named allowlist spells the onboarding ENTRANCE out (MOTIR-4403)', () => {
    const allowed = new Set(ONBOARDING_LITERAL_ALLOWLIST.map((entry) => entry.file));
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const rel = relative(ROOT, file).split(sep).join('/');
      if (allowed.has(rel)) continue;
      codeLinesOf(readFileSync(file, 'utf8')).forEach((line, i) => {
        if (ONBOARDING_LITERAL.test(line)) offenders.push(`${rel}:${i + 1} — ${line.trim()}`);
      });
    }

    expect(
      offenders,
      'The onboarding ENTRANCE is decided ONCE, in lib/navigation/landing.ts. Import ' +
        'ONBOARDING_ENTRY_PATH — or isOnboardingDestination / resolvePostAuthDestination ' +
        'where the question is whether a resolved destination IS the entrance — rather ' +
        'than re-typing the route. A second copy is how lib/onboarding/pendingIdea.ts came ' +
        'to declare it too (MOTIR-4403), which is the state MOTIR-2921 / MOTIR-3171 / ' +
        'MOTIR-3173 were each a separate repair of. A sub-path (/onboarding/discovery and ' +
        'friends) is a different route and does not match:\n  ' +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it('every onboarding allowlist entry names a file that exists and says WHY', () => {
    for (const entry of ONBOARDING_LITERAL_ALLOWLIST) {
      expect(existsSync(join(ROOT, entry.file)), `${entry.file} is allowlisted and absent`).toBe(
        true,
      );
      expect(entry.because.length, `${entry.file} is allowlisted with no reason`).toBeGreaterThan(
        20,
      );
    }
  });
});

/**
 * THE SCANS, EXERCISED (MOTIR-4403).
 *
 * Everything above asserts an EMPTY offender list over the real tree, so it
 * passes identically whether the regex works or matches nothing at all. These
 * run the same two functions over synthetic sources: one that must be caught,
 * and the two shapes that must not be.
 */
describe('the onboarding scan itself (MOTIR-4403)', () => {
  const scan = (source: string): number[] =>
    codeLinesOf(source)
      .map((line, i) => (ONBOARDING_LITERAL.test(line) ? i + 1 : 0))
      .filter((n) => n > 0);

  it('fires on an /onboarding literal introduced in code', () => {
    expect(scan(`export const X = '/onboarding';`)).toEqual([1]);
    expect(scan(`<Link href="/onboarding">go</Link>`)).toEqual([1]);
    expect(scan('const to = `/onboarding?seed=1`;')).toEqual([1]);
    expect(scan(`redirect('/onboarding');`)).toEqual([1]);
  });

  it('does NOT fire on /onboardings — the closing quote is part of the pattern', () => {
    expect(scan(`export const X = '/onboardings';`)).toEqual([]);
    expect(scan(`<Link href="/onboardingsomething">go</Link>`)).toEqual([]);
  });

  it('does NOT fire on /onboarding inside a comment, in either comment form', () => {
    expect(scan(`// the entrance is '/onboarding', imported from the owner`)).toEqual([]);
    expect(scan(`const a = 1; // bounced to "/onboarding" after auth`)).toEqual([]);
    expect(scan(['/**', " * lands on '/onboarding' (MOTIR-1458).", ' */'].join('\n'))).toEqual([]);
    expect(scan(`/* inline "/onboarding" */ const a = 1;`)).toEqual([]);
  });

  it('does NOT fire on a SUB-PATH — those are their own routes', () => {
    expect(scan(`redirect('/onboarding/discovery');`)).toEqual([]);
    expect(scan(`<Link href="/onboarding/migrate">go</Link>`)).toEqual([]);
    expect(scan('href={`/onboarding/direction/${tier}`}')).toEqual([]);
  });

  it('the /home scan draws the same two lines — the shape this one was copied from', () => {
    const home = (source: string): number[] =>
      codeLinesOf(source)
        .map((line, i) => (HOME_LITERAL.test(line) ? i + 1 : 0))
        .filter((n) => n > 0);
    expect(home(`redirect('/home');`)).toEqual([1]);
    expect(home(`redirect('/homepage');`)).toEqual([]);
    expect(home(`// sends the reader to '/home'`)).toEqual([]);
  });
});
