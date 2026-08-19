import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-3069 — the THREE-FILE rule was stated in two places and measured in none.
//
// ── The rule ────────────────────────────────────────────────────────────────
// `CLAUDE.md` § *Design assets — THREE files per surface*: "a design surface
// under `design/<area>/` is only complete when ALL THREE files exist together —
// none is optional", and "a design surface shipped with only notes + HTML (no
// `.png`), or HTML + PNG (no notes), is **incomplete**". `motir-meta`'s
// design-reference rule carries the same definition-of-done for the planner.
//
// ── Why neither statement held ──────────────────────────────────────────────
// Both are documents an agent READS and then acts from memory, which is the
// same failure MOTIR-3014 was filed for one token over: a constraint written
// down twice, violated anyway, because the only thing checking it was somebody
// remembering. Seven `.mock.html` files had shipped with no export — one of them
// since 2026-06-04 — and the tree walk that would have found them already
// existed twice over (`design-asset-addresses`, `design-ink-contrast` both walk
// `design/**`). What was missing was one assertion over it.
//
// `design/work-items/links.mock.html` is why this is a guard and not three
// renders: its area DOES contain an `internal-links.png`, so a reader auditing
// the folder by eye finds a plausible neighbour and moves on. A guard does not,
// which is the whole difference between a rule and a measurement.
//
// ── What the failure message owes ───────────────────────────────────────────
// The missing FILE and the command that produces it. A guard that reports
// "design/boards/board.mock.html" and stops has handed the reader a hunt: the
// renderer takes `--width` for an asset with no committed export to recover the
// viewport from, and that flag is exactly the thing nobody remembers.

const ROOT = process.cwd();
const DESIGN_DIR = join(ROOT, 'design');

/** The two halves of the rule, as the file names it uses. */
const NOTES = 'design-notes.md';
const MOCK_SUFFIX = '.mock.html';

/**
 * A file that makes a directory a design SURFACE rather than a folder that
 * happens to sit under `design/`. The `.pen` is the legacy source form the rule
 * still accepts; a bare `.png` counts because the `design/auth` set is exactly
 * that — a `.pen` plus twelve exports — and an area shipped as PNGs alone is
 * the "HTML + PNG (no notes)" half of the rule, not an exemption from it.
 */
const ASSET = /(?:\.mock\.html|\.pen|\.png)$/;

// ── The pure core ───────────────────────────────────────────────────────────
// Both checks are functions of a LISTING, so the negative case is exercised on
// a fixture rather than only by the real tree passing. A guard whose failure
// path never runs is a guard nobody knows is running (`inkContrastScan`'s own
// words, MOTIR-2459) — and this one's failure path is its entire product, since
// on a healthy tree every assertion below is a comparison against `[]`.

/** The area an asset lives in: `design/boards/board.mock.html` → `design/boards`. */
const areaOf = (path: string): string => path.slice(0, path.lastIndexOf('/'));

/**
 * Every `*.mock.html` in the listing with no same-basename `.png` beside it,
 * reported as the missing EXPORT plus the command that writes it.
 */
function missingExports(paths: string[]): string[] {
  const present = new Set(paths);
  return paths
    .filter((path) => path.endsWith(MOCK_SUFFIX))
    .map((mock) => ({ mock, png: `${mock.slice(0, -MOCK_SUFFIX.length)}.png` }))
    .filter(({ png }) => !present.has(png))
    .map(
      ({ mock, png }) =>
        `${png} is missing — export it with: node scripts/render-design-mock.mjs --width <N> ${mock}`,
    )
    .sort();
}

/**
 * Every area holding an asset but no `design-notes.md`. The other direction of
 * the same rule, and the one the near-miss above cannot be seen from: an area
 * with a mock, an export and no spec reads as complete from any single file.
 */
function missingNotes(paths: string[]): string[] {
  const present = new Set(paths);
  const areas = new Set(paths.filter((path) => ASSET.test(path)).map(areaOf));
  return [...areas]
    .filter((area) => !present.has(`${area}/${NOTES}`))
    .map((area) => `${area}/${NOTES} is missing — the area ships assets with no spec`)
    .sort();
}

// ── The one place judgement lives ───────────────────────────────────────────
// Two areas predate the rule and have never had notes. They are LISTED rather
// than exempted by a predicate, with the card that fixes them, and the table is
// asserted TIGHT in both directions below — an unlisted area fails, and a listed
// area that has since gained notes fails too, so the list cannot rot into a mute
// button. (Same treatment `design-asset-addresses.test.ts` gives its `KNOWN`
// table, for the same reason.)
//
// Writing the two specs is design authoring, not a render: `design/auth` is a
// twelve-screen Pencil set and `design/typography` a token specimen, and
// reverse-engineering either into a notes file inside this card would be a
// change nobody reviews (`notes.html` #27). MOTIR-3107 owns them.
const KNOWN_MISSING_NOTES: { area: string; why: string }[] = [
  {
    area: 'design/auth',
    why: 'The 2.0 auth set: a Pencil `.pen` source plus twelve PNG exports, drawn before the three-file rule existed. Its notes are a design deliverable, not a render — MOTIR-3107.',
  },
  {
    area: 'design/typography',
    why: 'The mono/technical type specimen (`mono-technical.mock.html` + its export), landed as a specimen rather than a surface and never given a spec — MOTIR-3107.',
  },
];

// ── The real tree ───────────────────────────────────────────────────────────

/** Every file under `design/`, as a repo-relative POSIX path. */
function designTree(dir: string = DESIGN_DIR, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) designTree(path, out);
    else out.push(relative(ROOT, path).split(sep).join('/'));
  }
  return out;
}

const TREE = designTree();

describe('a design surface ships all THREE files (MOTIR-3069)', () => {
  it('walks a design tree that actually has assets in it', () => {
    // Without this every assertion below passes vacuously if the walk breaks or
    // the folder moves — the failure mode a tree-walk guard is most exposed to.
    expect(TREE.filter((path) => path.endsWith(MOCK_SUFFIX)).length).toBeGreaterThan(50);
    expect(TREE.filter((path) => path.endsWith('.png')).length).toBeGreaterThan(50);
  });

  it('exports a `.png` beside every `*.mock.html`', () => {
    // The load-bearing half. The `.png` is the board- and tenant-visible face of
    // the asset — what CI publishes onto the work item and what a reviewer skims
    // on the PR — so a mock without one is invisible at exactly the moment it is
    // meant to be reviewed.
    expect(missingExports(TREE)).toEqual([]);
  });

  it('keeps a `design-notes.md` in every area that ships an asset', () => {
    const known = new Set(KNOWN_MISSING_NOTES.map((row) => row.area));
    const unlisted = missingNotes(TREE).filter(
      (finding) => !known.has(areaOf(finding.split(' ')[0]!)),
    );
    expect(
      unlisted,
      'write the notes, or add the area to KNOWN_MISSING_NOTES with a reason',
    ).toEqual([]);
  });

  it('holds `KNOWN_MISSING_NOTES` tight — a row that no longer fires fails', () => {
    // The half that stops the table becoming a mute button: when MOTIR-3107
    // lands either notes file, its row must go with it.
    const findings = new Set(missingNotes(TREE).map((finding) => areaOf(finding.split(' ')[0]!)));
    for (const row of KNOWN_MISSING_NOTES) {
      expect(findings.has(row.area), `${row.area} now has ${NOTES} — drop its row`).toBe(true);
      expect(row.why.length, row.area).toBeGreaterThan(20);
    }
  });
});

// ── The negative cases, on fixtures ─────────────────────────────────────────
// The assertions above compare against `[]` and will do so forever if the tree
// stays healthy, which means they never demonstrate that the check can FAIL.
// These do, on listings small enough to read.

describe('the three-file check on a fixture tree', () => {
  const HEALTHY = [
    'design/boards/design-notes.md',
    'design/boards/board.mock.html',
    'design/boards/board.png',
  ];

  it('passes a complete area', () => {
    expect(missingExports(HEALTHY)).toEqual([]);
    expect(missingNotes(HEALTHY)).toEqual([]);
  });

  it('names the missing export AND the command that writes it', () => {
    const noExport = HEALTHY.filter((path) => path !== 'design/boards/board.png');
    expect(missingExports(noExport)).toEqual([
      'design/boards/board.png is missing — export it with: node scripts/render-design-mock.mjs --width <N> design/boards/board.mock.html',
    ]);
  });

  it('is not satisfied by a PLAUSIBLE NEIGHBOUR — the near-miss this card was filed for', () => {
    // `design/work-items/links.mock.html` shipped for ten weeks beside an
    // `internal-links.png`. Matching on the AREA rather than the basename is the
    // shape of the eye-audit that missed it, so the fixture states the
    // difference: a same-area export of a DIFFERENT surface is not this
    // surface's export.
    const neighbour = [
      'design/work-items/design-notes.md',
      'design/work-items/links.mock.html',
      'design/work-items/internal-links.mock.html',
      'design/work-items/internal-links.png',
    ];
    expect(missingExports(neighbour)).toEqual([
      'design/work-items/links.png is missing — export it with: node scripts/render-design-mock.mjs --width <N> design/work-items/links.mock.html',
    ]);
  });

  it('reports EVERY missing export, sorted — not just the first', () => {
    const several = [
      'design/a/design-notes.md',
      'design/a/two.mock.html',
      'design/a/one.mock.html',
      'design/a/three.mock.html',
      'design/a/three.png',
    ];
    expect(missingExports(several).map((finding) => finding.split(' ')[0])).toEqual([
      'design/a/one.png',
      'design/a/two.png',
    ]);
  });

  it('reports an area whose assets ship with no spec', () => {
    const noNotes = ['design/typography/mono.mock.html', 'design/typography/mono.png'];
    expect(missingNotes(noNotes)).toEqual([
      'design/typography/design-notes.md is missing — the area ships assets with no spec',
    ]);
  });

  it('counts a `.pen`-sourced or PNG-only area as an area that owes notes', () => {
    // `design/auth` is exactly this shape, and a check that only looked for
    // `.mock.html` would call it compliant.
    expect(missingNotes(['design/auth/auth-screens.pen', 'design/auth/01-signin.png'])).toEqual([
      'design/auth/design-notes.md is missing — the area ships assets with no spec',
    ]);
  });

  it('does not make a folder with no asset in it owe anything', () => {
    // A `design/<area>/` holding only prose, a build script or an SVG source is
    // not a surface — `design/mcp-server/build.py` and `design/brand/*.svg` sit
    // beside real assets, but a folder of nothing else must not be reported.
    expect(missingNotes(['design/scratch/README.md', 'design/scratch/build.py'])).toEqual([]);
  });
});
