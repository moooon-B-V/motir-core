import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import manifest from '@/app/manifest';
import { BRAND_ACCENT_HEX, BRAND_PAGE_BG_HEX, WAVE_BAND_PATH } from '@/components/brand/waveBand';
import {
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
  it('renders maskable icons at 0.60 x canvas and non-maskable at 0.66', () => {
    // The band's extreme point is its BOUNDING-BOX corner — the end cap at
    // (22.992, 23.0) — so its circumradius from the centre is the full diagonal,
    // 0.648 of the glyph box. At the 0.66 the earlier rhombus mark used, a
    // maskable icon would span 2 x 0.648 x 0.66 = 0.855 of the canvas and be
    // CLIPPED by the 0.8 safe circle. This is the number the card calls out.
    expect(MASKABLE_SCALE).toBe(0.6);
    expect(NON_MASKABLE_SCALE).toBe(0.66);
    expect(2 * 0.648 * MASKABLE_SCALE).toBeLessThan(0.8);
    expect(2 * 0.648 * NON_MASKABLE_SCALE).toBeGreaterThan(0.8); // the clip it avoids
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
