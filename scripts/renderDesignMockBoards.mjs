/**
 * The BOARD half of `scripts/render-design-mock.mjs` (MOTIR-4868).
 *
 * WHY IT IS SPLIT OUT. The same reason `renderDesignMockSearch.mjs` is: the
 * runner launches chromium, writes PNGs, prints to stdout and `process.exit`s at
 * top level, so a module that imports it cannot be called by a test. Everything
 * here is pure or injected — `shootTarget` / `shootBaseline` are
 * `async (width, height, scale, theme) => Buffer`, `readCommitted` and `write`
 * are the only two file operations and both arrive as arguments, and nothing in
 * this file opens a browser, reads a file, touches the network or exits.
 *
 * ── WHAT A BOARD IS ─────────────────────────────────────────────────────────
 * A design asset's `.mock.html` is exported to a `.png`. Five assets in this
 * tree also ship a `<name>.dark.png` — the SAME board with `data-theme="dark"`
 * on the root, which is the only asset-side evidence for the dark half of the
 * palette (`design/code-context/design-notes.md` § 14, and the four twins beside
 * it). So one mock has one or two BOARDS, each with its own committed PNG.
 *
 * ── THE DEFECT THIS SPLIT EXISTS FOR ────────────────────────────────────────
 * Until MOTIR-4868 the runner exported the light board only, and said nothing at
 * all about the other one. On `parent/MOTIR-1754-rebuild` @ `4c9526cc8` a card
 * removed two page-head buttons and a connect aside from
 * `design/code-context/code-context.mock.html`, ran the script, and read
 * `EXACT` — while `code-context.dark.png` sat at the committed 2400x17392 still
 * drawing every removed element. A tool that silently does half its job is worse
 * than one that fails, because the half it does report comes back green.
 *
 * So the board loop is here, where it can be driven by a fake renderer and a
 * fake writer, and asserted to write BOTH files from one edit.
 */

import {
  DEVICE_SCALE_FACTORS,
  HEIGHTS,
  heightsFor,
  pngSize,
  searchRenderSettings,
} from './renderDesignMockSearch.mjs';

/** @typedef {{ theme: 'light' | 'dark', png: string }} Board */

/**
 * The boards one mock exports.
 *
 * The light board is unconditional. The dark board is added when
 * `<name>.dark.png` is ALREADY COMMITTED beside the mock — which is the whole
 * point of keying on existence rather than on a flag: an author cannot forget a
 * file they did not know was there, and the file's presence is the asset's own
 * statement that it ships two boards.
 *
 * `forceDark` is the one case existence cannot cover — CREATING a dark board
 * that does not exist yet. It needs `--width` for the same reason a new light
 * asset does: there is no committed export to recover the viewport from.
 *
 * @param {string} mock
 * @param {{ darkExists?: boolean, forceDark?: boolean }} [options]
 * @returns {Board[]}
 */
export function boardsFor(mock, { darkExists = false, forceDark = false } = {}) {
  const base = mock.replace(/\.mock\.html$/, '');
  const boards = [{ theme: 'light', png: `${base}.png` }];
  if (darkExists || forceDark) boards.push({ theme: 'dark', png: `${base}.dark.png` });
  return boards;
}

/** The `<name>.dark.png` a mock's dark board would be written to. */
export const darkPngFor = (mock) => `${mock.replace(/\.mock\.html$/, '')}.dark.png`;

/** `+5334px (+182%)` — the chosen candidate's distance from the committed height. */
export const formatDelta = (heightDelta, committedHeight) => {
  const sign = heightDelta > 0 ? '+' : '';
  const percent = committedHeight > 0 ? Math.round((heightDelta / committedHeight) * 100) : 0;
  return `Δbaseline=${sign}${heightDelta}px (${sign}${percent}%)`;
};

/**
 * Export every board of ONE mock, and report a line per board.
 *
 * The verdict VOCABULARY is unchanged and applies PER BOARD — `EXACT` / `DIMS` /
 * `DRIFT` / `REFLOW` mean exactly what `renderDesignMockSearch.mjs` documents,
 * asked separately of each board against its own committed PNG. A `REFLOW` on
 * one board writes nothing FOR THAT BOARD and leaves the other alone, which is
 * the property the two-board shape has to preserve: refusing to write a
 * plausible, wrong dark image must not also withhold a correct light one.
 *
 * @param {{
 *   mock: string,
 *   boards: Board[],
 *   shootTarget: (w: number, h: number, s: number, theme: string) => Promise<Buffer>,
 *   shootBaseline: (w: number, h: number, s: number, theme: string) => Promise<Buffer>,
 *   readCommitted: (png: string) => Buffer | null,
 *   write: (png: string, buffer: Buffer) => void,
 *   forcedWidth?: number | null,
 *   forcedHeight?: number | null,
 * }} options
 * @returns {Promise<{ lines: string[], written: string[], failed: number }>}
 */
export async function exportMockBoards({
  mock,
  boards,
  shootTarget,
  shootBaseline,
  readCommitted,
  write,
  forcedWidth = null,
  forcedHeight = null,
}) {
  const lines = [];
  const written = [];
  let failed = 0;

  for (const { theme, png } of boards) {
    const committed = readCommitted(png);

    if (committed === null) {
      if (!forcedWidth) {
        lines.push(`NEW\t${theme}\t—\t${mock} — no committed ${png}; pass --width to export it`);
        failed += 1;
        continue;
      }
      const buffer = await shootTarget(
        forcedWidth,
        forcedHeight ?? HEIGHTS[0],
        DEVICE_SCALE_FACTORS[0],
        theme,
      );
      write(png, buffer);
      written.push(png);
      lines.push(`NEW\t${theme}\t${forcedWidth}\t${pngSize(buffer).join('x')}\t${mock}`);
      continue;
    }

    const [committedWidth, committedHeight] = pngSize(committed);

    // The baseline: the same mock as it stands at HEAD, rendered in THIS board's
    // theme. Anything this render does NOT reproduce is the environment's doing,
    // not the working tree's — and the dark board gets its own baseline for the
    // same reason it gets its own committed PNG, because the two were exported
    // on different days by different renderer builds.
    const { settings, verdict, heightDelta } = await searchRenderSettings({
      shoot: (width, height, scale) => shootBaseline(width, height, scale, theme),
      committed,
      forcedWidth,
      heights: heightsFor(forcedHeight),
    });

    if (!settings) {
      lines.push(`FAIL\t${theme}\t—\tno viewport reproduces ${committedWidth}px wide\t${mock}`);
      failed += 1;
      continue;
    }

    const chosen = `${settings.width}x${settings.height}@${settings.scale}x`;
    const against = `committed=${committedWidth}x${committedHeight}`;
    const delta = heightDelta === 0 ? '' : `\t${formatDelta(heightDelta, committedHeight)}`;

    // A REFLOW the search had to CHOOSE is a refusal: writing at these settings
    // produces a plausible image of a document that reflowed, which is precisely
    // the failure MOTIR-4374 was filed for. Settings the operator STATED are
    // written anyway — `--width` is an assertion, not a guess.
    if (verdict === 'REFLOW' && !forcedWidth) {
      lines.push(
        `REFLOW\t${theme}\t${chosen}\t${against}${delta}\t${mock} — the nearest viewport still ` +
          `reflows the document; nothing written. Re-run with --width <the viewport it was ` +
          `exported at> if this delta is real.`,
      );
      failed += 1;
      continue;
    }

    const buffer = await shootTarget(settings.width, settings.height, settings.scale, theme);
    write(png, buffer);
    written.push(png);
    lines.push(
      `${verdict}\t${theme}\t${chosen}\t${against}\tnew=${pngSize(buffer).join('x')}${delta}\t${mock}`,
    );
  }

  return { lines, written, failed };
}
