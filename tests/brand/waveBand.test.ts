import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BRAND_ACCENT_HEX,
  BRAND_ACCENT_INK_HEX,
  BRAND_PAGE_BG_HEX,
  WAVE_BAND_PATH,
  WAVE_BAND_VIEW_BOX,
  waveBandDataUri,
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

  it('is ONE closed path of six segments — four quadratics and two straight caps', () => {
    // §2's construction claim, asserted rather than trusted: a "simplification"
    // that re-fits the curve would change these counts.
    expect(WAVE_BAND_PATH.match(/Q/g)).toHaveLength(4);
    expect(WAVE_BAND_PATH.match(/L/g)).toHaveLength(1); // the second cap is the Z
    expect(WAVE_BAND_PATH.endsWith('Z')).toBe(true);
    expect(WAVE_BAND_PATH).not.toMatch(/[Cc]/); // no cubics — nothing was traced
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

  it('percent-encodes the data URI so an email client can parse it', () => {
    const uri = waveBandDataUri({ size: 20, fill: BRAND_ACCENT_HEX });
    expect(uri.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    // A raw '#' would terminate the URL at the fill colour and a raw '"' would
    // close the src attribute — both are silent, both produce a broken header.
    expect(uri).not.toContain('#');
    expect(uri).not.toContain('"');
    expect(decodeURIComponent(uri.slice('data:image/svg+xml;utf8,'.length))).toContain(
      WAVE_BAND_PATH,
    );
  });
});
