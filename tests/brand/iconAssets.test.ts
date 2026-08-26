import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import manifest from '@/app/manifest';
import {
  BRAND_ACCENT_HEX,
  BRAND_ACCENT_INK_HEX,
  BRAND_PAGE_BG_HEX,
  WAVE_BAND_PATH,
} from '@/components/brand/waveBand';
import {
  EMAIL_MARK_PNG,
  emailMarkSvg,
  ICO_SIZES,
  MASKABLE_SCALE,
  NON_MASKABLE_SCALE,
  TILE_RADIUS_RATIO,
  iconSvgFile,
  packIco,
  PNG_ICONS,
  tiledIconSvg,
} from '../../scripts/brand/generate-brand-icons.mjs';

// MOTIR-1150 — the favicon / app-icon set (design/brand/design-notes.md §5).
//
// The rasters are build outputs of `scripts/brand/generate-brand-icons.mts`, but
// they are COMMITTED, because Next serves them as static files. That gap is what
// this file closes: it asserts the committed bytes are still what the generator
// produces, so a hand-edited PNG or a stale re-run is a red suite rather than an
// icon that quietly disagrees with the mark everywhere else.
//
// It also pins the ONE number this card is most likely to get wrong.

const REPO = process.cwd();

/** Width + height out of a PNG's IHDR — the first chunk of every PNG. */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('the two scales, and why they differ (§5 safe zone)', () => {
  it('renders maskable icons at 0.55 x canvas and non-maskable at 0.605', () => {
    // The band's extreme point is its BOUNDING-BOX corner, so its circumradius
    // from the centre is the full diagonal of the glyph box.
    //
    // ⚠️ BOTH NUMBERS MOVED WITH THE ARTWORK (MOTIR-3181). The 24-grid asset used
    // to carry a ~1-unit margin, so its bbox was 21.984 of the 24 box and the
    // circumradius 0.648 of it. That margin is what made the vertical caps render
    // soft at most sizes; removing it makes the glyph span the FULL square, so the
    // circumradius is now root-2 / 2 = 0.7071 and the safe-circle ceiling tightens
    // to 0.8 / (2 x 0.7071) = 0.5657.
    //
    // The scales are ALSO divided by 24 / 21.984 = 1.092, so the icons render at
    // the size they already did rather than jumping 9.2% on a refinement nobody
    // asked to resize anything. 0.66 -> 0.605, and the maskable one lands on 0.55
    // — which is both the compensated size and inside the new ceiling.
    const CIRCUMRADIUS = Math.SQRT2 / 2;
    expect(MASKABLE_SCALE).toBe(0.55);
    expect(NON_MASKABLE_SCALE).toBe(0.605);
    // Inside the 0.8 safe circle — the constraint that exists at all.
    expect(2 * CIRCUMRADIUS * MASKABLE_SCALE).toBeLessThan(0.8);
    // …and the non-maskable one is deliberately outside it: it is never cropped,
    // so it reads as large as the tile allows. This is the clip the split avoids.
    expect(2 * CIRCUMRADIUS * NON_MASKABLE_SCALE).toBeGreaterThan(0.8);
    // The visible mark is the same size it was before the margin came off.
    expect(NON_MASKABLE_SCALE).toBeCloseTo(0.66 * (21.984 / 24), 3);
  });

  it('gives every maskable icon square corners and every tiled one 0.22 x canvas', () => {
    // A maskable icon is full-bleed: the OS rounds it, and rounding it twice
    // leaves a visible inset. 0.22 is --radius-lg (12) over a 56px tile.
    for (const spec of PNG_ICONS) {
      const maskable = spec.scale === MASKABLE_SCALE;
      expect(spec.radius, spec.out).toBe(
        maskable ? 0 : Math.round(spec.canvas * TILE_RADIUS_RATIO),
      );
    }
  });
});

describe('the tiled form paints the glyph out of an opaque accent field', () => {
  const svg = tiledIconSvg({ canvas: 192, scale: MASKABLE_SCALE, radius: 0 });

  it('fills the whole canvas with the accent and knocks the glyph out in its ink', () => {
    // iOS masks the corners but supplies NO background, and a browser tab has no
    // surface behind it to tint against — so the tile is opaque, never a bare
    // glyph on transparency.
    expect(svg).toContain(`<rect width="192" height="192" rx="0" fill="${BRAND_ACCENT_HEX}"/>`);
    expect(svg).toContain(`d="${WAVE_BAND_PATH}"`);
    expect(svg).toContain('fill="#ffffff"');
  });

  it('centres the glyph box on the canvas', () => {
    // Rounded to 4dp so the committed files read as the numbers they are
    // rather than as binary-float noise.
    const box = 192 * MASKABLE_SCALE;
    const offset = Number(((192 - box) / 2).toFixed(4));
    expect(svg).toContain(`translate(${offset} ${offset})`);
    expect(svg).toContain(`scale(${Number((box / 24).toFixed(4))})`);
  });
});

describe('the committed files still match the generator', () => {
  it('app/icon.svg is byte-identical to what the script emits', () => {
    expect(readFileSync(join(REPO, 'app/icon.svg'), 'utf8')).toBe(iconSvgFile());
  });

  it.each(PNG_ICONS)('$out is a PNG at its declared canvas', ({ out, canvas }) => {
    const buf = readFileSync(join(REPO, out));
    expect(pngSize(buf)).toEqual({ width: canvas, height: canvas });
  });

  it('keeps favicon.ico as the legacy fallback, re-cut at 16 + 32', () => {
    // §5: kept for old clients and anything requesting /favicon.ico by path —
    // re-cut from the same glyph so the two can never disagree.
    const ico = readFileSync(join(REPO, 'app/favicon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // type: icon
    expect(ico.readUInt16LE(4)).toBe(ICO_SIZES.length);
    for (const [i, size] of ICO_SIZES.entries()) {
      const entry = 6 + i * 16;
      expect(ico.readUInt8(entry)).toBe(size);
      expect(ico.readUInt8(entry + 1)).toBe(size);
      // Each payload is a whole PNG — the post-Vista form every current client
      // reads, and what keeps the packer a dozen lines instead of a DIB encoder.
      const offset = ico.readUInt32LE(entry + 12);
      expect(pngSize(ico.subarray(offset))).toEqual({ width: size, height: size });
    }
  });

  it('packs the directory so every payload offset lands inside the file', () => {
    const png = readFileSync(join(REPO, 'public/icon-192.png'));
    const ico = packIco([
      { size: 16, png },
      { size: 32, png },
    ]);
    expect(ico.readUInt32LE(6 + 12)).toBe(6 + 32);
    expect(ico.readUInt32LE(6 + 16 + 12)).toBe(6 + 32 + png.length);
    expect(ico.length).toBe(6 + 32 + png.length * 2);
  });
});

describe('the email mark is generated here too, and is NOT one of the icons', () => {
  // MOTIR-3505. `EmailLayout` needs a hosted raster because email takes the glyph
  // no other way, so the mark is a build output of this script exactly as the
  // icon set is — same generator, same committed-bytes guarantee. What it is NOT
  // is a member of PNG_ICONS: those are opaque accent TILES sized against the
  // maskable safe circle, and neither the tile nor either scale means anything
  // for a 20px glyph sitting beside grey text on a white email body.
  it('emits the bare glyph in the accent colour, with no tile behind it', () => {
    const svg = emailMarkSvg();
    expect(svg).toContain(`d="${WAVE_BAND_PATH}"`);
    expect(svg).toContain(`fill="${BRAND_ACCENT_HEX}"`);
    // The tiled form opens with a full-canvas <rect>; this one must not.
    expect(svg).not.toContain('<rect');
    expect(svg).not.toContain(BRAND_ACCENT_INK_HEX);
  });

  it('stays out of PNG_ICONS, so the safe-zone assertions do not read as its rules', () => {
    expect(PNG_ICONS.map((s) => s.out)).not.toContain(EMAIL_MARK_PNG.out);
  });

  it('is committed at its declared canvas', () => {
    const buf = readFileSync(join(REPO, EMAIL_MARK_PNG.out));
    expect(pngSize(buf)).toEqual({
      width: EMAIL_MARK_PNG.canvas,
      height: EMAIL_MARK_PNG.canvas,
    });
  });
});

describe('the manifest (§5)', () => {
  const m = manifest();

  it('declares both maskable sizes at paths that are actually served', () => {
    // Next's static-metadata matcher takes one optional DIGIT after `icon`, so
    // `app/icon-192.png` would match nothing and be served at no URL at all.
    // These live in public/, which is why the manifest can name a stable path.
    expect(m.icons).toEqual([
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
    for (const icon of m.icons!) {
      expect(PNG_ICONS.map((s) => `/${s.out.replace('public/', '')}`)).toContain(icon.src);
    }
  });

  it('carries the brand name and the two colour literals a manifest cannot resolve', () => {
    expect(m.name).toBe('Motir');
    expect(m.short_name).toBe('Motir');
    expect(m.theme_color).toBe(BRAND_ACCENT_HEX);
    expect(m.background_color).toBe(BRAND_PAGE_BG_HEX);
  });
});
