import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-4406 — docs/styles/3d-immersive.md §4b, the CLOSURE RULE, in code.
//
// §4b says: "Every surface class the app renders is either assigned a plane
// above, or listed below as deliberately flat with a named reason. A surface
// class absent from this ladder is a spec defect, not a default." That is a rule
// about a POPULATION, and until this file nothing in the repository measured
// that population — §4b was a table somebody maintained by remembering to.
//
// ── The defect family this closes ──────────────────────────────────────────
// The same shape has now been filed four times: a promise bound to an
// ENUMERATION, with silence where the enumeration ends.
//
//   MOTIR-3522 — the physical-key rule enumerated two compiled radius
//                utilities, so 199 of 280 interactive controls stayed flat.
//   MOTIR-4230 — the immersive background was painted on `body` alone, so the
//                signed-in shell root covered it.
//   MOTIR-4234 — the same opaque shell canvas masked four more styles.
//   MOTIR-4253 — the shell chrome was never enumerated at all, so the top bar
//                and the rail rendered byte-identically to the default style's.
//
// Each was patched where it was found; the mechanism underneath survived all
// four. `tests/theme/immersive-control-depth.test.ts` is THE SAME RULE ONE TIER
// DOWN — §4a, over CONTROLS — and this file is its counterpart over SURFACES.
// It mirrors that suite deliberately: a DERIVED population, a CLASSIFICATION
// lookup, one assertion per member.
//
// ── WHEN THIS GOES RED ─────────────────────────────────────────────────────
// Add the surface's row to docs/styles/3d-immersive.md §4b — with a PLANE, or
// with a REASON — in the same change that introduced the surface. That is the
// whole rule. NEVER widen SKIP_DIRS, narrow SCAN_DIRS or exempt the file: doing
// so restores exactly the silence the four cards above were each an instance
// of.
//
// ── THE INSTRUMENT, AND HOW IT COULD FAIL OPEN ─────────────────────────────
// The classification is READ, not restated here: `classifiedIn()` parses the
// MARKDOWN TABLE ROWS of §4b — the section between the `### 4b.` heading and
// the next `##` heading — and takes the `data-surface='…'` hooks out of them,
// one set from the plane table and one from the *Deliberately FLAT* table.
//
// A Markdown parse is the one thing here that can go wrong SILENTLY and in the
// direction that stays green for ever: rename the heading, move the marker,
// restructure the tables into prose or HTML, and `classifiedIn()` returns an
// EMPTY set — at which point "is every emitted surface in the union?" is a
// question about nothing, every assertion below passes vacuously, and the guard
// reports success while measuring nothing at all. That is the same failure as
// the ladder it guards, one level up.
//
// So EVERY test below asserts BOTH arms came back NON-EMPTY *before* it asserts
// anything about membership, and the arms are checked disjoint. A check that
// cannot go red is not evidence.
//
// It asserts the CLASSIFICATION, never a COUNT — exactly as
// `immersive-control-depth.test.ts` refuses to encode 280. The size of the
// `data-surface` population is a reading of one commit and is expected to
// drift; nothing here encodes it.

const REPO = process.cwd();

/** The same roots `immersive-control-depth.test.ts` walks. */
const SCAN_DIRS = ['app', 'components', 'packages/design-system/src'];
/** The same directories `immersive-control-depth.test.ts` skips. */
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'tests', 'dist', '.next']);

/**
 * A `data-surface` value as the codebase writes it. TWO forms, and the second
 * is why this is not the card's own `grep`:
 *
 *   `data-surface="card"`        — the JSX attribute, the common case;
 *   `{ 'data-surface': 'card' }` — a props OBJECT, which is how
 *                                  `packages/design-system/src/components/ui/Card.tsx`
 *                                  emits it conditionally.
 *
 * An attribute-only pattern reads the second as absent, which is this defect
 * family exactly: a real emitter the enumeration cannot see.
 *
 * It deliberately does NOT comment-strip, and matches a selector string
 * (`closest('[data-surface="modal"]')`) as readily as an emission. Both
 * directions of error were weighed and this one is the safe one: over-matching
 * asks for a §4b row for a surface class the source mentions — which is what
 * §4b asks for anyway — while under-matching restores the silence. A closure
 * guard errs toward requiring classification.
 */
const SURFACE_VALUE = /data-surface["']?\s*[:=]\s*["']([a-z-]+)["']/g;

const LADDER_PATH = 'docs/styles/3d-immersive.md';
const LADDER = readFileSync(join(REPO, LADDER_PATH), 'utf8');

/** §4b, from its heading to the next top-level section. */
function closureSection(): string {
  const start = LADDER.indexOf('### 4b.');
  if (start < 0) return '';
  const end = LADDER.indexOf('\n## ', start);
  return end < 0 ? LADDER.slice(start) : LADDER.slice(start, end);
}

const SECTION = closureSection();
/** The lead-in that separates §4b's two tables. */
const FLAT_MARKER = 'Deliberately FLAT';
const FLAT_AT = SECTION ? SECTION.indexOf(FLAT_MARKER) : -1;
/** Both arms go empty together when the section cannot be split — see the header. */
const PLANE_ARM = FLAT_AT < 0 ? '' : SECTION.slice(0, FLAT_AT);
const FLAT_ARM = FLAT_AT < 0 ? '' : SECTION.slice(FLAT_AT);

/**
 * The `data-surface` values classified by one arm of §4b, read from its MARKDOWN
 * TABLE ROWS only. Rows-only is what makes the parse fail CLOSED: prose that
 * mentions a surface does not classify it, and a restructure that stops emitting
 * pipe tables yields an empty set, which every test below refuses.
 */
function classifiedIn(arm: string): Set<string> {
  const found = new Set<string>();
  for (const line of arm.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    // The capture group is the only alternative in the pattern, so a match
    // always carries it — the guard is for the type, and skipping is the safe
    // arm either way: it can only make the CLASSIFIED set smaller, which the
    // non-empty assertions below then catch.
    for (const m of line.matchAll(SURFACE_VALUE)) if (m[1]) found.add(m[1]);
  }
  return found;
}

const TREATED = classifiedIn(PLANE_ARM);
const FLAT = classifiedIn(FLAT_ARM);

const LADDER_UNREADABLE = [
  `§4b of ${LADDER_PATH} did not parse into two non-empty tables.`,
  "This is the FAIL-OPEN mode named in this file's header, not a ladder gap:",
  'until it is fixed every assertion in this suite is vacuous and permanently',
  `green. Check the '### 4b.' heading and the '${FLAT_MARKER}' lead-in still`,
  'exist and that both tables are still Markdown pipe tables.',
].join('\n');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    // `.ts` as well as `.tsx`: the props-object form above is not JSX and has no
    // reason to live only in a `.tsx` file.
    else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Every `data-surface` value the codebase emits, and where it was found. */
function emittedSurfaces(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(REPO, dir))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(SURFACE_VALUE)) {
        // See `classifiedIn` — the capture always matches; skipping is the
        // safe arm. Here it would make the EMITTED set smaller, so it is the
        // one place a silent skip could hide a surface: it cannot, because the
        // regex has no alternation and no optional group to fall through.
        const surface = m[1];
        if (!surface) continue;
        const where = `${file.slice(REPO.length + 1)}:${src.slice(0, m.index ?? 0).split('\n').length}`;
        const seen = found.get(surface) ?? [];
        if (seen.length < 5) seen.push(where);
        found.set(surface, seen);
      }
    }
  }
  return found;
}

describe('3D / Immersive — the §4b surface ladder is CLOSED', () => {
  it("reads both of §4b's tables — the classification read cannot fail open", () => {
    expect(SECTION.length, `'### 4b.' was not found in ${LADDER_PATH}`).toBeGreaterThan(0);
    expect(FLAT_AT, LADDER_UNREADABLE).toBeGreaterThan(-1);
    expect(TREATED.size, LADDER_UNREADABLE).toBeGreaterThan(0);
    expect(FLAT.size, LADDER_UNREADABLE).toBeGreaterThan(0);
  });

  it('keeps the two arms disjoint — a surface is treated or flat, never both', () => {
    expect(TREATED.size, LADDER_UNREADABLE).toBeGreaterThan(0);
    expect(FLAT.size, LADDER_UNREADABLE).toBeGreaterThan(0);

    const both = [...TREATED].filter((s) => FLAT.has(s));
    expect(
      both,
      [
        "A surface class is classified in BOTH of §4b's tables, so the ladder",
        'says it is given a plane AND that it deliberately takes none:',
        ...both.map((s) => `  data-surface="${s}"`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('classifies every data-surface value the codebase emits', () => {
    const emitted = emittedSurfaces();
    expect(
      emitted.size,
      `the scan found no data-surface anywhere under ${SCAN_DIRS.join(', ')} — the WALK is broken, not the ladder`,
    ).toBeGreaterThan(0);
    expect(TREATED.size, LADDER_UNREADABLE).toBeGreaterThan(0);
    expect(FLAT.size, LADDER_UNREADABLE).toBeGreaterThan(0);

    const unclassified = [...emitted.entries()]
      .filter(([surface]) => !TREATED.has(surface) && !FLAT.has(surface))
      .map(([surface, sites]) => `  data-surface="${surface}" — ${sites.join(', ')}`);

    expect(
      unclassified,
      [
        'A surface class reached main with no row in the ladder, which §4b calls',
        'a spec defect rather than a default:',
        ...unclassified,
        '',
        `Add a row to ${LADDER_PATH} §4b — either in the plane table (give it a`,
        'plane) or in the *Deliberately FLAT* table (give it a named reason).',
        'Do NOT widen SKIP_DIRS or narrow SCAN_DIRS in this file to make it pass.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('resolves a TREATED surface through the plane arm', () => {
    expect(TREATED.size, LADDER_UNREADABLE).toBeGreaterThan(0);
    expect(FLAT.size, LADDER_UNREADABLE).toBeGreaterThan(0);

    // The modal is §4's highest float and the card its reference 3D object.
    // Asserting the ARM, not merely membership, is what proves the plane table
    // is the thing that matched them.
    for (const surface of ['modal', 'card']) {
      expect(
        TREATED.has(surface),
        `[data-surface='${surface}'] must be assigned a plane in §4b's plane table`,
      ).toBe(true);
      expect(
        FLAT.has(surface),
        `[data-surface='${surface}'] is a treated surface and must not sit in §4b's FLAT table`,
      ).toBe(false);
    }
  });

  it('resolves the deliberately-FLAT surfaces through the FLAT arm, not merely somewhere', () => {
    expect(TREATED.size, LADDER_UNREADABLE).toBeGreaterThan(0);
    expect(FLAT.size, LADDER_UNREADABLE).toBeGreaterThan(0);

    // The scrim and the /tokens specimen frame are the two surfaces §4b declares
    // flat WITH A REASON. Checking only that they are classified somewhere would
    // pass on a ladder that had silently dropped them into the flat table with no
    // reason at all — which is the class of defect this suite exists to end — so
    // the arm is what is asserted.
    for (const surface of ['overlay', 'page']) {
      expect(
        FLAT.has(surface),
        `[data-surface='${surface}'] must sit in §4b's *${FLAT_MARKER}* table, with its reason`,
      ).toBe(true);
      expect(
        TREATED.has(surface),
        `[data-surface='${surface}'] takes no plane (§4b) and must not appear in the plane table`,
      ).toBe(false);
    }
  });
});
