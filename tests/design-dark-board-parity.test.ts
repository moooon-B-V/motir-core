import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pngSize } from '../scripts/renderDesignMockSearch.mjs';

// MOTIR-4868 — the FOURTH file nothing was watching.
//
// ── The rule ────────────────────────────────────────────────────────────────
// `CLAUDE.md` § *Design assets — THREE files per surface* is written for ONE
// PNG, and `tests/design-three-file-set.test.ts` measures exactly that. Five
// assets in this tree ship a FOURTH: `<name>.dark.png`, which
// `design/code-context/design-notes.md` § 14 defines as
//
//   > the same board with `data-theme="dark"` on the root; every ink flips
//   > because `color` is declared on the scoped containers rather than
//   > inherited from `body` alone.
//
// It is not decoration. It is the only asset-side evidence for the dark half of
// the palette, where `--el-text-inverted` flips and several ink pairings differ
// from light. An asset whose dark board silently lags is WORSE than one with no
// dark board, because a reviewer reads it as current.
//
// ── Why the fourth file had no guard ────────────────────────────────────────
// Until this card `scripts/render-design-mock.mjs` exported the light board
// only, so a mock edit re-exported with the shipped tool left the dark PNG
// drawing the OLD design at full fidelity, under an `EXACT` verdict for the half
// the tool did do. Observed on `parent/MOTIR-1754-rebuild` @ `4c9526cc8`: the
// light board re-exported to 2400x17160 while `code-context.dark.png` sat at the
// committed 2400x17392, still carrying two page-head buttons and a connect aside
// the mock no longer had. The tool half of that is fixed. This is the half that
// keeps it fixed, because the next person to export by hand re-introduces it.
//
// ── WHY THIS GUARD IS A DIMENSION COMPARISON AND NOT A DATE ─────────────────
// The card proposed the cheapest honest guard as "assert its mtime/commit is not
// older than its `*.mock.html`'s". That formulation is FALSIFIED, and measured
// rather than argued:
//
//   • mtime carries no information at all. `git checkout` stamps every file with
//     the checkout time, so in CI the ordering between a mock and its export is
//     an artefact of the clone, not of the tree.
//   • commit date is not a property this tree maintains. Measured on
//     `origin/main` @ `dd00a7620`: 33 of the 176 committed `.png` exports have a
//     LAST-COMMIT DATE OLDER than their own `.mock.html`'s, and every one of
//     them is current — because a mock edit that moves no pixels (a comment, a
//     prettier reflow, a CSS rule carried on nothing) leaves the PNG bytes
//     identical, so git records no new commit for it and the date stays behind
//     for ever. Four of the five DARK boards are in exactly that state.
//   • so the date rule is not merely noisy, it is UNSATISFIABLE on those four:
//     the only way to move a PNG's commit date is to change its bytes, and their
//     bytes do not change. A guard nobody can make green is not a guard.
//
// What IS a property of the pair is their SIZE. The dark board is the same board
// under a root attribute flip: a theme changes ink and tint, never layout. So
// the two exports must agree on dimensions, and they do — all five pairs match
// on `origin/main`, and the rendered verdicts for all ten boards are quoted in
// this card's pull request. On the reproduction branch they did not: 2400x17160
// beside 2400x17392, which is this guard going red on the exact defect.
//
// ── What it does NOT catch, said plainly ────────────────────────────────────
// A stale dark board whose mock edit changed COLOUR ONLY, or otherwise did not
// move the document's height. Catching that needs a real render at test time,
// which needs chromium — and this lane's whole premise is "an install plus a few
// seconds of Node" (`vitest.design.config.ts`'s header). The render-time check
// is the script's own, per board, and this is the cheap standing one beside it.

const ROOT = process.cwd();
const DESIGN_DIR = join(ROOT, 'design');

const DARK_SUFFIX = '.dark.png';
const MOCK_SUFFIX = '.mock.html';

/** `design/a/b.dark.png` → `design/a/b` — the basename the whole set shares. */
const baseOf = (darkPng: string): string => darkPng.slice(0, -DARK_SUFFIX.length);

// ── The pure core ───────────────────────────────────────────────────────────
// Both checks are functions of a LISTING (and, for the second, of a size
// lookup), so the negative case is exercised on a fixture rather than only by
// the real tree passing. A guard whose failure path never runs is a guard nobody
// knows is running — the same argument `design-three-file-set.test.ts` makes for
// its own fixtures.

/**
 * Every `*.dark.png` missing the mock it is an export of, or the light export it
 * is the twin of. An orphan dark board is unmaintainable by construction: the
 * renderer keys the dark board off the mock's path, so a dark PNG with no mock
 * beside it can never be regenerated by the tool.
 */
export function orphanDarkBoards(paths: string[]): string[] {
  const present = new Set(paths);
  return paths
    .filter((path) => path.endsWith(DARK_SUFFIX))
    .flatMap((dark) => {
      const base = baseOf(dark);
      const missing = [`${base}${MOCK_SUFFIX}`, `${base}.png`].filter(
        (sibling) => !present.has(sibling),
      );
      return missing.map((sibling) => `${dark} has no ${sibling} beside it`);
    })
    .sort();
}

/**
 * Every `*.dark.png` whose dimensions disagree with its light twin's.
 *
 * `size` is injected so the fixtures below can state a mismatch without writing
 * PNGs — and so the real-tree assertion reads its sizes exactly once.
 */
export function mismatchedDarkBoards(
  paths: string[],
  size: (path: string) => [number, number],
): string[] {
  const present = new Set(paths);
  return paths
    .filter((path) => path.endsWith(DARK_SUFFIX) && present.has(`${baseOf(path)}.png`))
    .flatMap((dark) => {
      const light = `${baseOf(dark)}.png`;
      const [darkWidth, darkHeight] = size(dark);
      const [lightWidth, lightHeight] = size(light);
      if (darkWidth === lightWidth && darkHeight === lightHeight) return [];
      return [
        `${dark} is ${darkWidth}x${darkHeight} but ${light} is ${lightWidth}x${lightHeight} — ` +
          `one of the two was exported from a different revision of ` +
          `${baseOf(dark)}${MOCK_SUFFIX}; re-export both with: ` +
          `node scripts/render-design-mock.mjs ${baseOf(dark)}${MOCK_SUFFIX}`,
      ];
    })
    .sort();
}

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
const sizeOf = (path: string): [number, number] =>
  // `pngSize` is the same IHDR read the exporter uses, from an untyped `.mjs`.
  pngSize(readFileSync(join(ROOT, path))) as [number, number];

describe('a dark board is the SAME board (MOTIR-4868)', () => {
  it('walks a design tree that actually has dark boards in it', () => {
    // Without this every assertion below passes vacuously if the walk breaks,
    // the suffix changes, or the last dark board is deleted — the failure mode a
    // tree-walk guard is most exposed to, and the one that would make this file
    // green while the defect it was written for came back.
    expect(TREE.filter((path) => path.endsWith(DARK_SUFFIX)).length).toBeGreaterThan(0);
  });

  it('keeps a mock and a light export beside every dark board', () => {
    expect(orphanDarkBoards(TREE)).toEqual([]);
  });

  it('exports both boards of a surface at the SAME dimensions', () => {
    // The load-bearing half, and the one that goes red on the defect this card
    // was filed for.
    expect(mismatchedDarkBoards(TREE, sizeOf)).toEqual([]);
  });
});

// ── The negative cases, on fixtures ─────────────────────────────────────────
// The assertions above compare against `[]` and will do so forever while the
// tree stays healthy, which means they never demonstrate that the check can
// FAIL. These do, on listings small enough to read.

describe('the dark-board checks on a fixture tree', () => {
  const HEALTHY = [
    'design/code-context/design-notes.md',
    'design/code-context/code-context.mock.html',
    'design/code-context/code-context.png',
    'design/code-context/code-context.dark.png',
  ];
  const SAME = () => [2400, 17392] as [number, number];

  it('passes a complete two-board surface', () => {
    expect(orphanDarkBoards(HEALTHY)).toEqual([]);
    expect(mismatchedDarkBoards(HEALTHY, SAME)).toEqual([]);
  });

  it('is silent about a surface that ships no dark board at all', () => {
    // 171 of the tree's 176 mocks. The dark board is opt-in per asset — the file
    // existing IS the opt-in — so its absence must never be a finding.
    const lightOnly = HEALTHY.filter((path) => !path.endsWith(DARK_SUFFIX));
    expect(orphanDarkBoards(lightOnly)).toEqual([]);
    expect(mismatchedDarkBoards(lightOnly, SAME)).toEqual([]);
  });

  it('REPORTS the stale board, with the command that re-exports both', () => {
    // The reproduction, at the numbers it was measured at on
    // `parent/MOTIR-1754-rebuild` @ `4c9526cc8`: the light board re-exported to
    // 17160 and the dark board stayed at the committed 17392.
    const size = (path: string): [number, number] =>
      path.endsWith(DARK_SUFFIX) ? [2400, 17392] : [2400, 17160];
    expect(mismatchedDarkBoards(HEALTHY, size)).toEqual([
      'design/code-context/code-context.dark.png is 2400x17392 but ' +
        'design/code-context/code-context.png is 2400x17160 — one of the two was exported from ' +
        'a different revision of design/code-context/code-context.mock.html; re-export both ' +
        'with: node scripts/render-design-mock.mjs design/code-context/code-context.mock.html',
    ]);
  });

  it('catches a WIDTH disagreement too, not only a reflowed height', () => {
    // A viewport recovered wrongly for one board and rightly for the other —
    // the MOTIR-4374 failure, arrived at through the second board.
    const size = (path: string): [number, number] =>
      path.endsWith(DARK_SUFFIX) ? [1200, 17392] : [2400, 17392];
    expect(mismatchedDarkBoards(HEALTHY, size)).toHaveLength(1);
  });

  it('reports a dark board with no mock to regenerate it from', () => {
    const orphan = HEALTHY.filter((path) => !path.endsWith(MOCK_SUFFIX));
    expect(orphanDarkBoards(orphan)).toEqual([
      'design/code-context/code-context.dark.png has no ' +
        'design/code-context/code-context.mock.html beside it',
    ]);
  });

  it('reports a dark board with no light twin — there is nothing to compare it to', () => {
    const orphan = HEALTHY.filter((path) => path !== 'design/code-context/code-context.png');
    expect(orphanDarkBoards(orphan)).toEqual([
      'design/code-context/code-context.dark.png has no design/code-context/code-context.png ' +
        'beside it',
    ]);
    // And the size check must not then compare it against nothing.
    expect(mismatchedDarkBoards(orphan, SAME)).toEqual([]);
  });

  it('reports EVERY mismatch, sorted — not just the first', () => {
    const several = [
      'design/a/one.mock.html',
      'design/a/one.png',
      'design/a/one.dark.png',
      'design/a/two.mock.html',
      'design/a/two.png',
      'design/a/two.dark.png',
    ];
    const size = (path: string): [number, number] =>
      path.endsWith(DARK_SUFFIX) ? [1200, 900] : [1200, 800];
    expect(mismatchedDarkBoards(several, size).map((finding) => finding.split(' ')[0])).toEqual([
      'design/a/one.dark.png',
      'design/a/two.dark.png',
    ]);
  });
});
