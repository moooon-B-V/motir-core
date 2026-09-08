import { describe, expect, it } from 'vitest';
import { boardsFor, darkPngFor, exportMockBoards } from '../../scripts/renderDesignMockBoards.mjs';

// MOTIR-4868 — `scripts/render-design-mock.mjs` exported the LIGHT board only.
//
// ── The defect ──────────────────────────────────────────────────────────────
// Five assets in this tree ship a `<name>.dark.png` beside their `.png` — the
// same board with `data-theme="dark"` on the root, and the only asset-side
// evidence for the dark half of the palette. The re-export tool knew nothing
// about them: `grep -rn dark scripts/render-design-mock.mjs` returned no match.
//
// So the failure was silent in BOTH directions. On `parent/MOTIR-1754-rebuild`
// @ `4c9526cc8` a card removed two page-head buttons and a connect aside from
// `design/code-context/code-context.mock.html`, ran the script, and read
//
//   EXACT  1200x900@2x  committed=2400x17392  new=2400x17160  …code-context.mock.html
//
// while `code-context.dark.png` stayed at the committed 2400x17392, still
// drawing every removed element at full fidelity, with every guard green. A tool
// that silently does half its job is worse than one that fails, because the half
// it does report comes back green.
//
// ── What these specs assert, and why with fakes ─────────────────────────────
// The card's acceptance criterion is "regenerates the dark board whenever one
// exists beside the mock, and prints a verdict for it — asserted by editing a
// mock in a fixture and checking both files change". What that is ABOUT is which
// boards the loop resolves and which files it writes, and both are decisions the
// loop makes before a pixel exists. So they are driven here by a fake renderer
// and a fake writer — the same substitution `render-design-mock-search.test.ts`
// makes for the viewport search, and for the same reason: the runner launches
// chromium and `process.exit`s at top level, so a test cannot import it. The
// real browser is exercised by running the script, which this card did over all
// five dark-board assets and quoted in its pull request.

/**
 * A PNG-shaped buffer: everything downstream reads only the IHDR width/height at
 * bytes 16 and 20, plus the whole buffer's md5 for the EXACT verdict. `salt` is
 * what makes two same-dimension renders differ in bytes — the DIMS case.
 */
const png = (width: number, height: number, salt = 0): Buffer => {
  const buffer = Buffer.alloc(25);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer.writeUInt8(salt, 24);
  return buffer;
};

const MOCK = 'design/code-context/code-context.mock.html';
const LIGHT_PNG = 'design/code-context/code-context.png';
const DARK_PNG = 'design/code-context/code-context.dark.png';

/**
 * A renderer whose output is a function of the viewport and the THEME, which is
 * the only thing these specs need it to be. Width tracks `width * scale` so the
 * search's width test passes at the real viewport and nowhere else; height comes
 * from the per-theme table, so a spec can make one board reproduce and the other
 * reflow.
 */
const renderer = (heights: { light: number; dark: number }, salt = 0) => {
  const calls: { width: number; scale: number; theme: string }[] = [];
  const shoot = (width: number, _height: number, scale: number, theme = 'light') => {
    calls.push({ width, scale, theme });
    return Promise.resolve(png(width * scale, heights[theme as 'light' | 'dark'], salt));
  };
  return { shoot, calls };
};

/** A writer that records rather than writes, so "both files change" is assertable. */
const writer = () => {
  const written: string[] = [];
  return { written, write: (png_: string) => void written.push(png_) };
};

const verdictsOf = (lines: string[]) => lines.map((line) => line.split('\t').slice(0, 2).join(' '));

describe('which boards a mock exports (MOTIR-4868)', () => {
  it('exports the LIGHT board alone when no dark sibling is committed', () => {
    // The overwhelming majority of the tree — 171 of 176 mocks — and the shape
    // that must not change.
    expect(boardsFor(MOCK)).toEqual([{ theme: 'light', png: LIGHT_PNG }]);
  });

  it('adds the DARK board when `<name>.dark.png` exists beside the mock', () => {
    // Keyed on EXISTENCE, not on a flag: the file's presence is the asset's own
    // statement that it ships two boards, so an author cannot forget a file they
    // did not know was there.
    expect(boardsFor(MOCK, { darkExists: true })).toEqual([
      { theme: 'light', png: LIGHT_PNG },
      { theme: 'dark', png: DARK_PNG },
    ]);
  });

  it('adds the DARK board under `--dark` when none is committed yet', () => {
    // The one case existence cannot cover: CREATING a first dark board.
    expect(boardsFor(MOCK, { forceDark: true }).map((board) => board.png)).toEqual([
      LIGHT_PNG,
      DARK_PNG,
    ]);
  });

  it('names the dark export beside the mock, not in a sibling area', () => {
    expect(darkPngFor(MOCK)).toBe(DARK_PNG);
  });
});

describe('exporting both boards of one mock (MOTIR-4868)', () => {
  const committed: Record<string, Buffer> = {
    [LIGHT_PNG]: png(1200, 2000, 1),
    [DARK_PNG]: png(1200, 2000, 2),
  };
  const readCommitted = (path: string) => committed[path] ?? null;

  it('WRITES BOTH FILES from one mock, and prints a verdict for each', async () => {
    // The card's headline criterion. Before this change the dark row did not
    // exist at all — not as a write, and not as a line of output.
    const { shoot } = renderer({ light: 2000, dark: 2000 });
    const { written, write } = writer();

    const { lines, failed } = await exportMockBoards({
      mock: MOCK,
      boards: boardsFor(MOCK, { darkExists: true }),
      shootTarget: shoot,
      shootBaseline: shoot,
      readCommitted,
      write,
    });

    expect(written).toEqual([LIGHT_PNG, DARK_PNG]);
    expect(failed).toBe(0);
    expect(lines).toHaveLength(2);
    expect(verdictsOf(lines)).toEqual(['DIMS light', 'DIMS dark']);
  });

  it('renders the dark board in the DARK theme — not a second light render', async () => {
    // The whole defect in one assertion: a loop that ran twice and passed
    // `light` both times would satisfy every other spec in this file.
    const { shoot, calls } = renderer({ light: 2000, dark: 2000 });
    await exportMockBoards({
      mock: MOCK,
      boards: boardsFor(MOCK, { darkExists: true }),
      shootTarget: shoot,
      shootBaseline: shoot,
      readCommitted,
      write: writer().write,
    });

    expect(new Set(calls.map((call) => call.theme))).toEqual(new Set(['light', 'dark']));
  });

  it('gives each board its OWN verdict against its OWN committed export', async () => {
    // The dark board of four of the five assets was exported weeks before its
    // light sibling, by a different renderer build. One verdict for the pair
    // would have to be the worse of the two, which is how a real DIMS on one
    // board would mask an EXACT on the other — and vice versa.
    const { shoot } = renderer({ light: 2000, dark: 2000 }, 1);
    const { lines } = await exportMockBoards({
      mock: MOCK,
      boards: boardsFor(MOCK, { darkExists: true }),
      shootTarget: shoot,
      shootBaseline: shoot,
      readCommitted,
      write: writer().write,
    });

    // Salt 1 reproduces the LIGHT committed bytes exactly; the dark committed
    // buffer carries salt 2, so the same render is DIMS against it.
    expect(verdictsOf(lines)).toEqual(['EXACT light', 'DIMS dark']);
  });

  it('a REFLOW on the DARK board writes nothing for it and still writes the light one', async () => {
    // The property the two-board shape has to preserve. Refusing to write a
    // plausible, wrong dark image must not also withhold a correct light one —
    // the refusal is per board, and so is the non-zero exit it contributes.
    const { shoot } = renderer({ light: 2000, dark: 8000 }, 1);
    const { written, write } = writer();

    const { lines, failed } = await exportMockBoards({
      mock: MOCK,
      boards: boardsFor(MOCK, { darkExists: true }),
      shootTarget: shoot,
      shootBaseline: shoot,
      readCommitted,
      write,
    });

    expect(written).toEqual([LIGHT_PNG]);
    expect(failed).toBe(1);
    expect(verdictsOf(lines)).toEqual(['EXACT light', 'REFLOW dark']);
    expect(lines[1]).toContain('nothing written');
  });

  it('leaves a light-only mock at exactly one line and one write', async () => {
    const { shoot } = renderer({ light: 2000, dark: 2000 }, 1);
    const { written, write } = writer();

    const { lines } = await exportMockBoards({
      mock: MOCK,
      boards: boardsFor(MOCK),
      shootTarget: shoot,
      shootBaseline: shoot,
      readCommitted,
      write,
    });

    expect(written).toEqual([LIGHT_PNG]);
    expect(verdictsOf(lines)).toEqual(['EXACT light']);
  });
});

describe('a dark board that does not exist yet (MOTIR-4868)', () => {
  const committed: Record<string, Buffer> = { [LIGHT_PNG]: png(1200, 2000, 1) };
  const readCommitted = (path: string) => committed[path] ?? null;

  it('refuses to invent a viewport, and says which flag supplies one', async () => {
    // Same rule the light board has always had: a board with no committed
    // export has no baseline to recover settings from, so the settings have to
    // be STATED. The message names the file rather than only the mock, because
    // the two boards of one mock are otherwise indistinguishable in the output.
    const { shoot } = renderer({ light: 2000, dark: 2000 }, 1);
    const { written, write } = writer();

    const { lines, failed } = await exportMockBoards({
      mock: MOCK,
      boards: boardsFor(MOCK, { forceDark: true }),
      shootTarget: shoot,
      shootBaseline: shoot,
      readCommitted,
      write,
    });

    expect(written).toEqual([LIGHT_PNG]);
    expect(failed).toBe(1);
    expect(verdictsOf(lines)).toEqual(['EXACT light', 'NEW dark']);
    expect(lines[1]).toContain(DARK_PNG);
    expect(lines[1]).toContain('--width');
  });

  it('writes a first dark board when `--width` states the viewport', async () => {
    const { shoot } = renderer({ light: 2000, dark: 2000 }, 1);
    const { written, write } = writer();

    const { failed } = await exportMockBoards({
      mock: MOCK,
      boards: boardsFor(MOCK, { forceDark: true }),
      shootTarget: shoot,
      shootBaseline: shoot,
      readCommitted,
      write,
      forcedWidth: 600,
    });

    expect(written).toEqual([LIGHT_PNG, DARK_PNG]);
    expect(failed).toBe(0);
  });
});
