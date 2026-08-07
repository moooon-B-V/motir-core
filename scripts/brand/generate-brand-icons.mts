/**
 * Renders the favicon / app-icon set from the ONE brand path (MOTIR-1150 ·
 * `design/brand/design-notes.md` §5).
 *
 *   pnpm tsx scripts/brand/generate-brand-icons.mts
 *
 * The rasters are BUILD OUTPUTS, committed because Next.js serves them as static
 * files — but they are outputs, so this script is what defines them and
 * `tests/brand/iconAssets.test.ts` asserts the committed files still match what
 * it would produce. Editing a PNG by hand puts the two out of agreement and the
 * suite says so.
 *
 * Playwright's chromium is the rasteriser: it is already a devDependency, it is
 * the same engine the design PNGs are exported with (`motir-core/CLAUDE.md`'s
 * design-asset rule), and it renders the real SVG rather than a reimplementation
 * of its geometry.
 *
 * ── THE TWO SCALES, AND WHY THEY DIFFER ─────────────────────────────────────
 * A MASKABLE icon is cropped to an arbitrary OS shape, so the glyph must sit
 * inside the centred circle of diameter 0.8 x canvas. The wave band's extreme
 * point is its BOUNDING-BOX CORNER (the end cap at 22.992, 23.0 on the 24-grid),
 * so its circumradius is the full diagonal: 0.648 of the glyph box. It pays the
 * root-2 penalty the earlier rhombus mark avoided, and at the 0.66 that mark
 * used the glyph would span 2 x 0.648 x 0.66 = 0.855 of the canvas and be
 * CLIPPED. The arithmetic ceiling is 0.617; 0.60 is the round number below it.
 * A non-maskable icon is not cropped, so it keeps 0.66 and reads as large as the
 * tile allows.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import {
  BRAND_ACCENT_HEX,
  BRAND_ACCENT_INK_HEX,
  WAVE_BAND_PATH,
} from '../../components/brand/waveBand.js';

/** Glyph box as a fraction of the canvas, by whether the OS will crop it. */
export const NON_MASKABLE_SCALE = 0.66;
export const MASKABLE_SCALE = 0.6;
/** 0.22 is `--radius-lg` (12) over a 56px tile — the app's own container ratio. */
export const TILE_RADIUS_RATIO = 0.22;

export interface IconSpec {
  /** Repo-relative output path. */
  out: string;
  canvas: number;
  /** Fraction of the canvas the glyph box occupies. */
  scale: number;
  /** Corner radius in px. Maskable icons are square: the OS rounds them. */
  radius: number;
}

export const PNG_ICONS: IconSpec[] = [
  {
    out: 'app/apple-icon.png',
    canvas: 180,
    scale: NON_MASKABLE_SCALE,
    radius: Math.round(180 * TILE_RADIUS_RATIO),
  },
  { out: 'public/icon-192.png', canvas: 192, scale: MASKABLE_SCALE, radius: 0 },
  { out: 'public/icon-512.png', canvas: 512, scale: MASKABLE_SCALE, radius: 0 },
];

/** The two sizes packed into the legacy `app/favicon.ico`. */
export const ICO_SIZES = [16, 32];

/** Trims binary-float noise so the committed files read as the numbers they are. */
const round = (n: number) => Number(n.toFixed(4));

/**
 * The tiled form: the glyph knocked out of an opaque accent field. Every icon
 * uses it — a browser tab has no surface behind it to tint against, and iOS
 * masks the corners but supplies NO background, so the tile must be opaque.
 */
export function tiledIconSvg({ canvas, scale, radius }: Omit<IconSpec, 'out'>): string {
  const box = canvas * scale;
  const offset = round((canvas - box) / 2);
  const unit = round(box / 24);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" ` +
    `viewBox="0 0 ${canvas} ${canvas}">` +
    `<rect width="${canvas}" height="${canvas}" rx="${radius}" fill="${BRAND_ACCENT_HEX}"/>` +
    `<g transform="translate(${offset} ${offset}) scale(${unit})">` +
    `<path d="${WAVE_BAND_PATH}" fill="${BRAND_ACCENT_INK_HEX}"/>` +
    `</g></svg>`
  );
}

/** `app/icon.svg` — resolution-free, so it ships as source rather than a raster. */
export function iconSvgFile(): string {
  const canvas = 32;
  const box = canvas * NON_MASKABLE_SCALE;
  const offset = round((canvas - box) / 2);
  const unit = round(box / 24);
  // No SVG comment here: XML forbids a double hyphen inside one, so a token name
  // written as var() in a file header makes the whole document malformed
  // (design-notes.md section 2). Provenance lives in components/brand/waveBand.ts.
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}" role="img" aria-label="Motir">`,
    `  <rect width="${canvas}" height="${canvas}" rx="${Math.round(canvas * TILE_RADIUS_RATIO)}" fill="${BRAND_ACCENT_HEX}"/>`,
    `  <g transform="translate(${offset} ${offset}) scale(${unit})">`,
    `    <path d="${WAVE_BAND_PATH}" fill="${BRAND_ACCENT_INK_HEX}"/>`,
    `  </g>`,
    `</svg>`,
    '',
  ].join('\n');
}

/**
 * Packs PNGs into an .ico. The format is a 6-byte header plus one 16-byte
 * directory entry per image plus the payloads; since Vista a payload may be a
 * whole PNG rather than a DIB, which is what every current client reads and what
 * keeps this a dozen lines instead of a bitmap encoder.
 */
export function packIco(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries: Buffer[] = [];
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    // 0 means 256 in this field; every size we ship is below that.
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette colours
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

async function main() {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const browser = await chromium.launch();
  const page = await browser.newPage();

  async function rasterise(spec: Omit<IconSpec, 'out'>): Promise<Buffer> {
    const svg = tiledIconSvg(spec);
    await page.setViewportSize({ width: spec.canvas, height: spec.canvas });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`,
    );
    // The tile is opaque, so nothing rides on transparency — but omitting the
    // background keeps any sub-pixel edge outside the rounded corners clear
    // rather than white, which is what a rounded favicon needs.
    return page.screenshot({ omitBackground: true, type: 'png' });
  }

  await writeFile(path.join(root, 'app/icon.svg'), iconSvgFile(), 'utf8');
  console.warn('wrote app/icon.svg');

  for (const spec of PNG_ICONS) {
    const png = await rasterise(spec);
    const dest = path.join(root, spec.out);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, png);
    console.warn(`wrote ${spec.out} (${spec.canvas}px, glyph ${spec.scale} x canvas)`);
  }

  // The legacy fallback, re-cut from the same glyph so the two can never
  // disagree. Kept for old clients and for anything requesting /favicon.ico by
  // path (design-notes.md §5).
  const icoImages = [];
  for (const size of ICO_SIZES) {
    icoImages.push({
      size,
      png: await rasterise({
        canvas: size,
        scale: NON_MASKABLE_SCALE,
        radius: Math.round(size * TILE_RADIUS_RATIO),
      }),
    });
  }
  await writeFile(path.join(root, 'app/favicon.ico'), packIco(icoImages));
  console.warn(`wrote app/favicon.ico (${ICO_SIZES.join(' + ')})`);

  await browser.close();
}

// Guarded so the test can import the pure helpers without launching a browser.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
