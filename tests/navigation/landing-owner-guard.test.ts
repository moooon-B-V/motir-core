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
// MOTIR-4800 added the FOURTH scan, and it is about a CARRIER rather than a
// destination. Every scan above reads a string literal or a COMMENT, and
// MOTIR-4799's defect sat in the tree for the whole life of this file without
// tripping one of them: `app/(authed)/_components/TopNav.tsx` carried
// `href="/dashboard"` under `aria-label={t('topNav.brandHome')}`, and the
// surrounding comment discusses the brand slot, the width budget and the tile's
// fill — the words *home* and *landing* appear in it nowhere, at any distance.
// So a wider window for the second scan would not have found it: the intent was
// declared in the element's ACCESSIBLE NAME, which is an axis none of the three
// read. Widening the window is a change to a parameter; the defect was in the
// axis. The fourth scan reads that axis, and stays as dumb as the rest.
//
// ⚠️ It is NOT a member of the guards lane, and that is a measurement rather
// than an omission: `tests/ci-structural-guards-lane.test.ts` derives lane
// membership from "imports a scanner module and parses the tree with the
// TypeScript compiler API", which this does not do. It reads the tree with
// `readFileSync` and a handful of regexes.
//
// ⚠️ THE FILE COUNT IN THAT SENTENCE WAS ~700 AND IS NOW 2,127 (MOTIR-4800).
// The scans did not change; the tree grew under them, and each `it` walked and
// re-read the whole of it — so the "well under a second" that came with the
// count stopped being true some time before anybody re-measured it, at three
// walks. `sourceFiles()` and the per-file reads are MEMOISED below for exactly
// that reason: nothing writes to the tree while this file runs, so the four
// scans read it once between them and the fourth is close to free. Measured on
// this tree, three runs each: 2.14-2.46s of test time at three walks (the
// state on `main`, before this card), 0.69-0.90s at one walk with four scans.

const ROOT = resolve(__dirname, '..', '..');
const ROOTS = ['app', 'components', 'lib'];

/** The one file allowed to spell the destination out. */
const OWNER = join('lib', 'navigation', 'landing.ts');

/**
 * A LANDING STRING LITERAL — `'/workbench'`, `"/workbench"`, or a template
 * opening `` `/workbench?… ` ``. `/workbenches` and a `/workbench` inside prose
 * do not match; the point is the value a route or a link is built FROM.
 *
 * ⚠️ THE VALUE MOVED (MOTIR-4782, `/home` → `/workbench`) AND THE OLD ONE IS
 * STILL SCANNED, by `RETIRED_LANDING_LITERAL` below. Re-pointing this regex and
 * walking away would have retired the guard at the exact moment it was most
 * useful: a rename is when stale copies of the old answer are created, and this
 * rule exists because six defects came from stale copies of one.
 */
const LANDING_LITERAL = /(['"`])\/workbench(\?[^'"`]*)?\1/;

/**
 * The PREVIOUS landing, still forbidden — `'/home'`, `"/home"`, `` `/home?…` ``.
 *
 * `next.config.ts` answers it with a permanent 308 and is the one file that
 * names it, which no scan here reaches: this walks `app/`, `components/` and
 * `lib/` only. So under those three roots the string has no legitimate use at
 * all, and an appearance is either a literal that was never swept or a new one
 * typed from memory — the ROTTED shape, caught on the day it is written rather
 * than by the next reader who follows it.
 */
const RETIRED_LANDING_LITERAL = /(['"`])\/home(\?[^'"`]*)?\1/;

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
 * Files allowed to point a `/dashboard` link from an element whose accessible
 * name claims the home, each with the reason it is allowed — the same
 * `{ file, because }` shape as `ONBOARDING_LITERAL_ALLOWLIST`, for the same
 * reason: an entry whose reason has stopped being true is the thing a reader
 * can spot, and a bare list of paths gives them nothing to spot it with.
 *
 * It is EMPTY, and it is meant to stay that way. An element that says *home*
 * and goes to `/dashboard` is the MOTIR-4799 defect; the repair is to point it
 * at `AUTHED_LANDING_PATH`, not to name it here. A second site found by this
 * scan is its own bug (MOTIR-4800's scope boundary), never an entry.
 */
const DASHBOARD_NAME_ALLOWLIST: ReadonlyArray<{ file: string; because: string }> = [];

/**
 * How far a scan will look for the tag a `/dashboard` literal sits inside.
 *
 * The fixture is why this is not a tight bound: MOTIR-4799's brand mark put
 * `href="/dashboard"` on line 2 of its `<Link`, `aria-label` on line 3, and the
 * closing `>` twenty-five lines further down behind a comment about the tile's
 * fill. Those lines are BLANK by the time this reads them (`codeLinesOf`), so
 * the span costs nothing to cross — and a bound tight enough to feel careful
 * would have missed the one element this scan exists for.
 */
const ELEMENT_SPAN = 60;

/** The start of a JSX element — `<Link`, `<a`, `<Nav.Item`. */
const OPENS_AN_ELEMENT = /<[A-Za-z][\w.]*/;

/** The end of an OPENING tag — `>` or `/>`, once arrows have been removed. */
const CLOSES_AN_OPENING_TAG = /\/?>/;

/**
 * `=>` and `>=` are not tag ends, and a prop holding either (`onClick={() =>
 * …}`) is ordinary. Removing them before the test above is the whole of the
 * approximation, and it fails toward a MISS: an element this cuts short simply
 * has fewer attributes to read.
 */
function withoutArrows(line: string | undefined): string {
  return (line ?? '').replace(/=>/g, '  ').replace(/>=/g, '  ');
}

/**
 * The OPENING TAG a `/dashboard` literal sits inside, or `null` when it sits
 * in no tag at all (a `redirect('/dashboard')` in a service, a route table).
 *
 * Deliberately dumb, in the register of the rest of this file: walk BACK to the
 * nearest line that opens an element, then FORWARD to the nearest line that
 * closes an opening tag. A nested element cannot appear before that `>`, so the
 * region this returns is the attributes of ONE element — and every way it can
 * be wrong (a tag that never closes inside the span, a JSX-valued prop whose
 * own `/>` arrives first) shortens the region rather than widening it.
 */
export function openingTagAround(code: string[], index: number): string | null {
  let start = -1;
  for (let i = index; i >= 0 && index - i <= ELEMENT_SPAN; i -= 1) {
    const line = withoutArrows(code[i]);
    if (OPENS_AN_ELEMENT.test(line)) {
      start = i;
      break;
    }
    // A tag that closed ABOVE us means the literal is not in an attribute list.
    if (i !== index && CLOSES_AN_OPENING_TAG.test(line)) return null;
  }
  if (start === -1) return null;

  for (let i = start; i < code.length && i - start <= ELEMENT_SPAN; i += 1) {
    if (!CLOSES_AN_OPENING_TAG.test(withoutArrows(code[i]))) continue;
    // The tag closed before the literal — a different element's attributes.
    return i < index ? null : code.slice(start, i + 1).join('\n');
  }
  return null;
}

/**
 * An ACCESSIBLE-NAME attribute and its value. `aria-label` and `title` are the
 * two an element declares its own name with; `aria-labelledby` points at some
 * other node's text and is not readable by a string scan, so it is out of
 * scope rather than forgotten.
 */
const ACCESSIBLE_NAME_ATTR = /(?:aria-label|title)\s*=\s*(\{[^}]*\}|"[^"]*"|'[^']*')/g;

/**
 * A name that CLAIMS THE HOME. Two arms, because the claim travels in two
 * registers: as a word in the name itself (`aria-label="Home"`,
 * `title="Landing"`), and as the tail of an i18n KEY, which is how MOTIR-4799
 * carried it — `t('topNav.brandHome')`, where `\bhome\b` cannot match because
 * `brandHome` is one word. The second arm reads that camel-case tail, so a
 * `navHome` or a `goLanding` key is caught by the rule rather than by a list.
 */
const NAME_CLAIMS_THE_HOME = /\b(?:home|landing)\b/i;
const CAMEL_NAME_CLAIMS_THE_HOME = /[a-z](?:Home|Landing)\b/;

/** The first accessible-name attribute on `tag` that claims the home. */
export function nameClaimingTheHome(tag: string): string | null {
  for (const match of tag.matchAll(ACCESSIBLE_NAME_ATTR)) {
    const value = match[1] ?? '';
    if (NAME_CLAIMS_THE_HOME.test(value) || CAMEL_NAME_CLAIMS_THE_HOME.test(value)) {
      return match[0].replace(/\s+/g, ' ');
    }
  }
  return null;
}

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

/**
 * The walk and the reads are MEMOISED, and that is a cost decision rather than
 * a style one (MOTIR-4800). Four scans over ~2,100 files is four walks and four
 * full reads of the same bytes; nothing writes to the tree between them, so a
 * module-level cache is exact. It is what keeps a fourth scan close to free —
 * and what put the file back under the second its own docstring claimed.
 */
let sourceFileCache: string[] | null = null;
const rawCache = new Map<string, string>();
const lineCache = new Map<string, string[]>();
const codeLineCache = new Map<string, string[]>();

function sourceFiles(): string[] {
  if (sourceFileCache) return sourceFileCache;
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
  sourceFileCache = out;
  return out;
}

function raw(file: string): string {
  let source = rawCache.get(file);
  if (source === undefined) {
    source = readFileSync(file, 'utf8');
    rawCache.set(file, source);
  }
  return source;
}

function lines(file: string): string[] {
  let split = lineCache.get(file);
  if (!split) {
    split = raw(file).split('\n');
    lineCache.set(file, split);
  }
  return split;
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
  let blanked = codeLineCache.get(file);
  if (!blanked) {
    blanked = codeLinesOf(raw(file));
    codeLineCache.set(file, blanked);
  }
  return blanked;
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
        if (LANDING_LITERAL.test(line)) offenders.push(`${rel}:${i + 1} — ${line.trim()}`);
        if (RETIRED_LANDING_LITERAL.test(line))
          offenders.push(`${rel}:${i + 1} — ${line.trim()}  (the RETIRED /home address)`);
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
      codeLines(file).forEach((line, i) => {
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

  it('no /dashboard literal sits on an element whose ACCESSIBLE NAME claims the home (MOTIR-4800)', () => {
    const allowed = new Set(DASHBOARD_NAME_ALLOWLIST.map((entry) => entry.file));
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const rel = relative(ROOT, file).split(sep).join('/');
      if (allowed.has(rel)) continue;
      const code = codeLines(file);
      code.forEach((line, i) => {
        if (!DASHBOARD_LITERAL.test(line)) return;
        const tag = openingTagAround(code, i);
        if (!tag) return;
        const claim = nameClaimingTheHome(tag);
        if (claim) offenders.push(`${rel}:${i + 1} — ${line.trim()}\n      name: ${claim}`);
      });
    }

    expect(
      offenders,
      'An element that NAMES ITSELF the home and goes to /dashboard is the MOTIR-4799 ' +
        'defect, and it is invisible to the three scans above: they read literals and ' +
        'COMMENTS, and this claim travels in the accessible name. The brand mark carried ' +
        'href="/dashboard" under aria-label={t(\'topNav.brandHome\')} for the whole life of ' +
        'this file. Point it at AUTHED_LANDING_PATH — or rename the label, if the ' +
        'destination is genuinely the dashboard and not the landing:\n  ' +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it('every dashboard-name allowlist entry names a file that exists and says WHY (MOTIR-4800)', () => {
    for (const entry of DASHBOARD_NAME_ALLOWLIST) {
      expect(existsSync(join(ROOT, entry.file)), `${entry.file} is allowlisted and absent`).toBe(
        true,
      );
      expect(entry.because.length, `${entry.file} is allowlisted with no reason`).toBeGreaterThan(
        20,
      );
    }
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

  it('the landing scan draws the same two lines — the shape this one was copied from', () => {
    const landing = (source: string): number[] =>
      codeLinesOf(source)
        .map((line, i) => (LANDING_LITERAL.test(line) ? i + 1 : 0))
        .filter((n) => n > 0);
    expect(landing(`redirect('/workbench');`)).toEqual([1]);
    expect(landing(`redirect('/workbenches');`)).toEqual([]);
    expect(landing(`// sends the reader to '/workbench'`)).toEqual([]);
  });

  it('the RETIRED /home address is still scanned for (MOTIR-4782)', () => {
    const retired = (source: string): number[] =>
      codeLinesOf(source)
        .map((line, i) => (RETIRED_LANDING_LITERAL.test(line) ? i + 1 : 0))
        .filter((n) => n > 0);
    expect(retired(`redirect('/home');`)).toEqual([1]);
    expect(retired('const to = `/home?tab=watching`;')).toEqual([1]);
    // The same two exemptions the live scan grants: a different route, and prose.
    expect(retired(`redirect('/homepage');`)).toEqual([]);
    expect(retired(`// the old address, now a 308 to '/home'`)).toEqual([]);
  });

  // ── The FOURTH scan (MOTIR-4800) ──────────────────────────────────────────
  //
  // The one it exists for is MOTIR-4799's brand mark, so the fixture IS that
  // element — `href` and `aria-label` on their own lines, twenty-five lines of
  // comment between the last attribute and the closing `>`, which is exactly
  // the shape a tight element window would have missed.
  const named = (source: string): string[] => {
    const code = codeLinesOf(source);
    const hits: string[] = [];
    code.forEach((line, i) => {
      if (!DASHBOARD_LITERAL.test(line)) return;
      const tag = openingTagAround(code, i);
      if (!tag) return;
      const claim = nameClaimingTheHome(tag);
      if (claim) hits.push(claim);
    });
    return hits;
  };

  const TOP_NAV_TILE_COMMENT = [
    '            // The tile (MOTIR-2557 · design/shell § *The brand tile*). The box',
    '            // was always here and simply unpainted; it now takes an',
    '            // `--el-surface` field and an `--el-border` hairline, and the',
    "            // hairline DIVIDER that used to follow it is gone — the tile's own",
    '            // edge says what the divider said, and that returns 9px to a row',
    '            // measured at 69px of slack.',
    '            //',
    '            // Deliberately NOT a tint. The ORIGINAL reason was adjacency:',
    "            // OrgControl's avatar was a 20px `--el-tint-lavender` tile and",
    '            // ProjectAvatar an `--el-avatar-lavender` one, so a third lavender',
    '            // square 20px away would have read as another tier chip. MOTIR-2679',
    '            // deleted both of those squares, and the conclusion is re-affirmed',
    '            // on new grounds (MOTIR-2674, design/shell/design-notes.md § The',
    '            // brand tile): the tile is now the ONLY boxed element in the left',
    '            // cluster, so the box itself is what marks it as identity rather',
    '            // than as a control — a tint would re-introduce the very tier-chip',
    '            // reading the neutral field was chosen to avoid.',
  ].join('\n');

  const topNav = (href: string): string =>
    [
      '          <Link',
      `            href=${href}`,
      "            aria-label={t('topNav.brandHome')}",
      TOP_NAV_TILE_COMMENT,
      '            className="hidden h-8 w-8 flex-none items-center justify-center md:flex"',
      '          >',
      '            <BrandMark variant="mark" size={24} />',
      '          </Link>',
    ].join('\n');

  it("FLAGS TopNav's pre-fix brand mark — the element MOTIR-4799 fixed (MOTIR-4800)", () => {
    expect(named(topNav('"/dashboard"'))).toEqual(["aria-label={t('topNav.brandHome')}"]);
  });

  it('does NOT flag the SAME element once it points at the landing (MOTIR-4800)', () => {
    expect(named(topNav('{AUTHED_LANDING_PATH}'))).toEqual([]);
  });

  it('reads the claim off a one-line element too, in either name attribute', () => {
    expect(named(`<Link href="/dashboard" aria-label="Home">m</Link>`)).toEqual([
      'aria-label="Home"',
    ]);
    expect(named(`<a href="/dashboard" title="The landing">m</a>`)).toEqual([
      'title="The landing"',
    ]);
    expect(named(`<Link href="/dashboard" aria-label={t('nav.goHome')} />`)).toEqual([
      "aria-label={t('nav.goHome')}",
    ]);
  });

  it('does NOT flag a /dashboard link whose name says DASHBOARD — the honest case', () => {
    expect(named(`<Link href="/dashboard" aria-label={t('nav.dashboard')}>D</Link>`)).toEqual([]);
    expect(named(`<Link href="/dashboard" title="Dashboard">D</Link>`)).toEqual([]);
  });

  it('does NOT flag a /dashboard literal that sits in no element at all', () => {
    expect(named(`redirect('/dashboard');`)).toEqual([]);
    expect(named(`export const DASHBOARD = '/dashboard'; // the home of the charts`)).toEqual([]);
  });

  it('does NOT reach into a SIBLING element for its name', () => {
    expect(
      named(
        [
          '<nav>',
          '  <Link href="/dashboard">Dashboard</Link>',
          '  <Link href={AUTHED_LANDING_PATH} aria-label="Home" />',
          '</nav>',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('does NOT read a name out of a COMMENT — the axis this scan was added for', () => {
    expect(
      named(
        [
          '<Link',
          '  href="/dashboard"',
          '  // the home of the charts, and the landing before MOTIR-2654',
          '>',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('an arrow in a prop does not end the tag early', () => {
    expect(
      named(
        ['<Link', '  href="/dashboard"', '  onClick={() => go()}', '  aria-label="Home"', '>'].join(
          '\n',
        ),
      ),
    ).toEqual(['aria-label="Home"']);
  });
});
