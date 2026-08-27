import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BRAND_ACCENT_HEX,
  BRAND_ACCENT_INK_HEX,
  BRAND_PAGE_BG_HEX,
  WAVE_BAND_PATH,
  WAVE_BAND_VIEW_BOX,
  EMAIL_MARK_CANVAS_PX,
  EMAIL_MARK_FILE,
  EMAIL_MARK_PATH,
  EMAIL_MARK_PX,
  EMAIL_MARK_SCALE,
  waveBandSvg,
} from '@/components/brand/waveBand';

// MOTIR-1150 — the guard that keeps the SHIPPED mark and the APPROVED artwork
// the same shape.
//
// `components/brand/waveBand.ts` is the one module every surface reads the path
// from, which is what makes a future mark change a single-file edit. But a
// single source of truth that is a hand-copied string is only true until someone
// "tidies" it: the path is 110 bytes of coordinates, so a wrong one renders
// something plausible rather than nothing, and no visual review would catch a
// digit. This test pins it to `design/brand/wave-band-24.svg` — the file the
// design subtask approved and the draw.io source derives — so a drift between
// the two is a red suite rather than a subtly wrong logo on every screen.
//
// It reads the design asset by PATH rather than duplicating the string here,
// because a copy in the test would just be a second thing to keep in sync.

const REPO = process.cwd();

function designAsset(name: string): string {
  return readFileSync(join(REPO, 'design', 'brand', name), 'utf8');
}

/** The `d` of the single `<path>` in a wave-band asset. */
function pathData(svg: string): string {
  const match = svg.match(/<path\s+d="([^"]+)"/);
  expect(match, 'the asset should carry exactly one <path d="…">').not.toBeNull();
  return match![1]!;
}

describe('the wave band is the approved artwork (MOTIR-1150 · MOTIR-1140)', () => {
  it('ships the path from design/brand/wave-band-24.svg, byte for byte', () => {
    expect(WAVE_BAND_PATH).toBe(pathData(designAsset('wave-band-24.svg')));
  });

  it('is drawn on the same 24-unit grid the asset declares', () => {
    expect(designAsset('wave-band-24.svg')).toContain(`viewBox="${WAVE_BAND_VIEW_BOX}"`);
  });

  it('is ONE closed path of SIX quadratics and two straight caps', () => {
    // §2's construction claim, asserted rather than trusted: a "simplification"
    // that re-fits the curve would change these counts.
    //
    // ⚠️ SIX, not four (MOTIR-3181). Each edge's final quadratic is SPLIT at 0.75
    // so its tail can be re-aimed to meet the vertical cap tangent-vertically —
    // the corner Yue reported at the box's vertical midpoint. The two extra
    // segments are those eased tails; the shape is otherwise the same curve.
    expect(WAVE_BAND_PATH.match(/Q/g)).toHaveLength(6);
    expect(WAVE_BAND_PATH.match(/L/g)).toHaveLength(1); // the second cap is the Z
    expect(WAVE_BAND_PATH.endsWith('Z')).toBe(true);
    expect(WAVE_BAND_PATH).not.toMatch(/[Cc]/); // no cubics — nothing was traced
  });

  it('MEETS BOTH CAPS TANGENT-VERTICALLY — the corner this card removed', () => {
    // The property, asserted as itself rather than as a coordinate fixture: a
    // quadratic's end tangent is `E - C`, so "arrives vertical" is `C.x === E.x`.
    // A future edit that nudges either control off the cap's x re-introduces the
    // kink, and no visual review would catch a two-decimal change.
    const segs = [...WAVE_BAND_PATH.matchAll(/Q([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)/g)].map(
      (m) => ({ cx: Number(m[1]), ex: Number(m[3]), ey: Number(m[4]) }),
    );
    const atCap = segs.filter((s) => s.ex === 0 || s.ex === 24);
    expect(atCap, 'one eased tail per side').toHaveLength(2);
    for (const s of atCap) {
      expect(s.cx, 'the control must sit on the cap line for a vertical tangent').toBe(s.ex);
      expect(s.ey, 'the junction is the box vertical midpoint').toBe(12);
    }
  });

  it('spans the viewBox EDGE TO EDGE, so the straight caps are pixel-aligned', () => {
    // An INSET vertical edge lands on a whole device pixel only at exact multiples
    // of the grid; the viewport boundary is aligned at every scale. Measured cap
    // alpha went 84/233/211/168/166/80 -> 255 at 16/26/28/32/56/64 px. Re-adding a
    // margin here would undo that, so it is asserted rather than commented.
    expect(WAVE_BAND_PATH.startsWith('M0 0')).toBe(true);
    expect(WAVE_BAND_PATH).toContain('L24 24');
  });

  it('carries the design asset in the repo it names as the editable source', () => {
    // §2: to change the mark you edit the draw.io source and re-derive. A missing
    // source turns the next change into a trace, which is the thing §1 records as
    // having cost a 3.17% fitting error.
    expect(() => designAsset('motir-logo.drawio.svg')).not.toThrow();
  });
});

describe('the baked-colour exports (design-notes.md §2, §5, §6)', () => {
  it('names the light-theme literals of the tokens the design pins', () => {
    // These four surfaces — favicon, app icon, next/og, email — sit outside the
    // CSS tree, where `currentColor` resolves to BLACK. The literals are the
    // documented exception; their provenance is what has to stay in sync.
    expect(BRAND_ACCENT_HEX).toBe('#5645d4'); // --el-accent / --color-primary
    expect(BRAND_ACCENT_INK_HEX).toBe('#ffffff'); // --el-accent-text
    expect(BRAND_PAGE_BG_HEX).toBe('#ffffff'); // --el-page-bg
  });

  it('bakes the requested colour in and never emits currentColor', () => {
    const svg = waveBandSvg({ size: 20, fill: BRAND_ACCENT_HEX });
    expect(svg).toContain(`fill="${BRAND_ACCENT_HEX}"`);
    expect(svg).not.toContain('currentColor');
    expect(svg).toContain('width="20"');
    expect(svg).toContain('height="20"');
  });

  it('emits no SVG comment at all — a double hyphen in one is malformed XML', () => {
    // design-notes.md §2's warning: a token name written as var(--el-accent) in a
    // file header makes the whole document invalid XML. It still renders in a
    // browser and fails everywhere that parses it strictly (GitHub's diff is how
    // it was found), so the safe rule is that a GENERATED asset carries no
    // comments and the provenance lives in source.
    const svg = waveBandSvg({ size: 24, fill: BRAND_ACCENT_HEX });
    expect(svg).not.toContain('<!--');
    expect(svg).not.toContain('--');
  });

  it('exports no data-URI helper at all — email cannot take one (MOTIR-3505)', async () => {
    // This module used to export `waveBandDataUri`, and `EmailLayout` shipped its
    // output as the mark's `src`. It rendered in no mail client: Gmail drops an
    // image source it cannot FETCH through its proxy, and SVG renders in none of
    // Gmail / Outlook / Yahoo in any transport. The helper is gone rather than
    // merely unused — the only surface it was written for is the one surface it
    // cannot work on, so anything still able to emit a `data:` URI here is a
    // regression waiting to be re-wired.
    const mod: Record<string, unknown> = await import('@/components/brand/waveBand');
    expect(Object.keys(mod)).not.toContain('waveBandDataUri');
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === 'string') expect(value, name).not.toContain('data:');
    }
  });
});

describe('the email mark (§7e · MOTIR-3505)', () => {
  it('renders at 2× the displayed size, so a retina client is not soft', () => {
    // The <img> constrains to EMAIL_MARK_PX with its own width/height attributes;
    // email has no srcset worth relying on, so the extra density has to be in the
    // file itself.
    expect(EMAIL_MARK_PX).toBe(20);
    expect(EMAIL_MARK_SCALE).toBe(2);
    expect(EMAIL_MARK_CANVAS_PX).toBe(EMAIL_MARK_PX * EMAIL_MARK_SCALE);
  });

  it('names a file under public/, whose path is derived rather than repeated', () => {
    // `app/`-convention names are a trap at this size: Next's static-metadata
    // matcher takes ONE optional digit after `icon`, so `app/icon-192.png` is
    // served at no URL at all (§5). public/ is a stable root path.
    expect(EMAIL_MARK_FILE).toBe(`email-mark-${EMAIL_MARK_CANVAS_PX}.png`);
    expect(EMAIL_MARK_PATH).toBe(`/${EMAIL_MARK_FILE}`);
    expect(existsSync(join(process.cwd(), 'public', EMAIL_MARK_FILE))).toBe(true);
  });

  it('is a PNG at the declared canvas — the format is the other half of the fix', () => {
    // A hosted SVG would satisfy the transport and still render nowhere. Read the
    // IHDR rather than trusting the extension.
    const buf = readFileSync(join(process.cwd(), 'public', EMAIL_MARK_FILE));
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(buf.readUInt32BE(16)).toBe(EMAIL_MARK_CANVAS_PX);
    expect(buf.readUInt32BE(20)).toBe(EMAIL_MARK_CANVAS_PX);
  });
});

// MOTIR-3508 — the guard that keeps the design ASSET drawing the approved mark.
//
// The describes above pin the shipped constant to `design/brand/wave-band-24.svg`.
// Nothing pinned the MOCK, and `design/brand/brand-mark.mock.html` is what
// `design-notes.md` calls the layout source of truth for every slot the mark
// occupies — so it is the file an implementer opens. Its panel 7e (the
// transactional-email frame) drew the LATTICE, the candidate §1 records as
// "chosen and then set aside", as a third inline copy of that artwork in a
// `data:` URI, while every other panel drew the wave band. It shipped that way
// from the asset's first commit.
//
// Nothing caught it because nothing reads a mock's ARTWORK:
// `design-asset-addresses` rules on the addresses an asset cites,
// `design-ink-contrast` on its inks, `design-three-file-set` on the presence of
// the three files. This block is the missing axis, and it is deliberately narrow
// — §1's alternatives board is SUPPOSED to draw the lattice, so a guard reading
// "the lattice appears nowhere" would delete the record the asset exists to keep.
describe('the brand mock draws the approved mark (MOTIR-3508)', () => {
  const MOCK = 'brand-mark.mock.html';

  /** `<defs>` … `</defs>` — the one block in the mock that may hold path data. */
  function defsBlock(mock: string): string {
    const open = mock.indexOf('<defs>');
    const close = mock.indexOf('</defs>');
    expect(open, 'the mock declares a <defs> sprite').toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    return mock.slice(open, close);
  }

  it("the mock's own #mark-a symbol carries WAVE_BAND_PATH, byte for byte", () => {
    // The mock is a self-contained document, so its symbol is a COPY of the
    // shipped path by construction. A copy is only true until someone tidies it,
    // and 110 bytes of coordinates render something plausible when they are
    // wrong — the same argument the wave-band-24.svg pin above is made from.
    const symbol = designAsset(MOCK).match(/<g id="mark-a">\s*<path\s+d="([^"]+)"/);
    expect(symbol, 'the mock declares a #mark-a symbol with one <path d="…">').not.toBeNull();
    expect(symbol![1]).toBe(WAVE_BAND_PATH);
  });

  it('draws every mark by <use> reference — no inline artwork outside the <defs>', () => {
    // This is the property that failed, stated as itself. Panel 7e carried its
    // own copy of a glyph in an <img src="data:image/svg+xml,…">, so a change to
    // the mark could not reach it and no reviewer would see the difference in a
    // 6500-line file. Every mark in the asset now resolves through a symbol, and
    // the symbols are the only place path data lives.
    const mock = designAsset(MOCK);
    const defs = defsBlock(mock);
    expect(mock).not.toMatch(/data:image\//);

    // `<path` followed by whitespace is the ELEMENT; the file's header comment
    // also mentions a bare `<path>` in prose, which is not one.
    const total = mock.match(/<path\s/g)?.length ?? 0;
    const inDefs = defs.match(/<path\s/g)?.length ?? 0;
    expect(total, 'the mock draws paths at all').toBeGreaterThan(0);
    expect(inDefs, 'every <path> element belongs to the <defs> sprite').toBe(total);
  });

  it('draws the set-aside LATTICE exactly once — in §1s own symbol, on the record', () => {
    // The narrow half, and the one that needs saying: §1 keeps the rejected
    // candidates precisely so the decision stays legible, and MOTIR-1140's
    // approval is only readable beside what it turned down. So the lattice is
    // not forbidden — a SECOND copy of it is, because that is a copy nobody
    // approved and nobody re-reads.
    const mock = designAsset(MOCK);
    const LATTICE_OUTER = 'M12 3.6L20.4 12L12 20.4L3.6 12Z';
    expect(mock.match(new RegExp(LATTICE_OUTER.replace(/\./g, '\\.'), 'g'))).toHaveLength(1);

    const symbol = mock.match(/<g id="mark-lattice">[\s\S]*?\n {8}<\/g>/);
    expect(symbol, 'the mock declares a #mark-lattice symbol').not.toBeNull();
    expect(symbol![0]).toContain(LATTICE_OUTER);
  });
});
