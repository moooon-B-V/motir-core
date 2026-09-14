import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-3069 — the design-asset rule was stated in two places and measured in none.
// MOTIR-5490 — and the rule is now TWO files, not three.
//
// ── The rule ────────────────────────────────────────────────────────────────
// `CLAUDE.md` § *Design assets — TWO files per surface*: a design surface under
// `design/<area>/` is `design-notes.md` + `<surface>.mock.html`. The `.png`
// export this guard used to require is RETIRED (`docs/decisions/design-result.md`
// AMENDMENT 4): it existed so a design could be skimmed on its pull request, and
// the mock now renders on the card, so an export is a second copy of what the
// reviewer already sees. A `.pen` source is not accepted for a NEW surface,
// because a `.pen` can only be reviewed through the export that is gone.
//
// ── Why this is a guard and not a sentence ──────────────────────────────────
// Both halves are documents an agent READS and then acts from memory. The notes
// half was measured because seven mocks once shipped with no export for weeks and
// nothing noticed; the `.pen` half is measured for the same reason in the other
// direction — "no new Pencil files" holds only if something fails when one lands.
//
// ── What the failure message owes ───────────────────────────────────────────
// The offending FILE and the rule it breaks, so the reader knows what to do
// rather than what went wrong.

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
 * The 14 `.pen` sources on the tree when the two-file rule landed
 * (`git ls-tree -r --name-only origin/main -- design | grep -E '\.pen$'`,
 * MOTIR-5490). They are RECORDS of the moment they were drawn and stay; a `.pen`
 * can only be reviewed through an export, and exports are retired, so no NEW one
 * is accepted. Asserted tight below — a listed file that is deleted must lose its
 * row, so the list can only shrink.
 */
const LEGACY_PENS: readonly string[] = [
  'design/auth/auth-screens.pen',
  'design/projects/projects.pen',
  'design/shell/cmd-k.pen',
  'design/shell/desktop-collapsed.pen',
  'design/shell/desktop.pen',
  'design/shell/mobile-drawer.pen',
  'design/shell/shortcuts.pen',
  'design/work-items/create.pen',
  'design/work-items/detail.pen',
  'design/work-items/tree.pen',
  'design/workspaces/invite-accept.pen',
  'design/workspaces/invite-email.pen',
  'design/workspaces/settings.pen',
  'design/workspaces/switcher.pen',
];

/** Every `.pen` in the listing that is not a legacy record — a NEW Pencil source. */
function newPens(paths: string[], legacy: readonly string[] = LEGACY_PENS): string[] {
  const allowed = new Set(legacy);
  return paths
    .filter((path) => path.endsWith('.pen') && !allowed.has(path))
    .map(
      (pen) =>
        `${pen} is a new .pen source — a design surface is TWO files, design-notes.md + <surface>.mock.html; draw it as a mock`,
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

// ── The one place judgement lives, and it is now EMPTY ──────────────────────
// An area may be listed here rather than exempted by a predicate, with a reason
// and the card that closes it, and the table is asserted TIGHT in both
// directions below — an unlisted finding fails, and a listed area that has since
// gained notes fails too, so the list cannot rot into a mute button. (Same
// treatment `design-asset-addresses.test.ts` gives its `KNOWN` table, for the
// same reason.)
//
// It shipped with two rows, both of them debt this guard inherited rather than
// created: `design/auth` (a twelve-screen Pencil set) and `design/typography` (a
// type specimen), each a design-AUTHORING job rather than a render, which is why
// MOTIR-3069 filed them as MOTIR-3107 instead of folding them into a card whose
// diff was seven PNGs (`notes.html` #27). MOTIR-3107 wrote both specs, so both
// rows are gone and every one of the tree's areas now carries its notes.
//
// EMPTY IS THE INTENDED RESTING STATE. Adding a row is a deliberate act with a
// written reason and a card that removes it again — not a way to land an
// incomplete area.
const KNOWN_MISSING_NOTES: { area: string; why: string }[] = [];

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

describe('a design surface ships its TWO files (MOTIR-3069, MOTIR-5490)', () => {
  it('walks a design tree that actually has assets in it', () => {
    // Without this every assertion below passes vacuously if the walk breaks or
    // the folder moves — the failure mode a tree-walk guard is most exposed to.
    expect(TREE.filter((path) => path.endsWith(MOCK_SUFFIX)).length).toBeGreaterThan(50);
  });

  it('accepts no NEW `.pen` source', () => {
    expect(newPens(TREE)).toEqual([]);
  });

  it('holds `LEGACY_PENS` tight — a deleted legacy source loses its row', () => {
    const present = new Set(TREE);
    for (const pen of LEGACY_PENS) {
      expect(present.has(pen), `${pen} is gone — drop its row`).toBe(true);
    }
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
    // The half that stops the table becoming a mute button: an area that gains
    // its notes must lose its row in the same diff. It is what deleted both of
    // MOTIR-3107's rows, and with the table empty it is dormant rather than
    // vacuous — it fires again the moment anyone adds a row.
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

describe('the two-file check on a fixture tree', () => {
  const HEALTHY = ['design/boards/design-notes.md', 'design/boards/board.mock.html'];

  it('passes a complete area — a mock and its notes, with NO `.png`', () => {
    expect(newPens(HEALTHY)).toEqual([]);
    expect(missingNotes(HEALTHY)).toEqual([]);
  });

  it('passes a delta mock beside the surface it amends, with no export for either', () => {
    const delta = [...HEALTHY, 'design/boards/board--swimlanes.mock.html'];
    expect(newPens(delta)).toEqual([]);
    expect(missingNotes(delta)).toEqual([]);
  });

  it('fails a `.pen` that is not a legacy record, naming the two-file rule', () => {
    const pen = [...HEALTHY, 'design/boards/board.pen'];
    expect(newPens(pen)).toEqual([
      'design/boards/board.pen is a new .pen source — a design surface is TWO files, design-notes.md + <surface>.mock.html; draw it as a mock',
    ]);
  });

  it('does not report a `.pen` on the legacy list', () => {
    expect(newPens(['design/shell/desktop.pen', 'design/shell/design-notes.md'])).toEqual([]);
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
