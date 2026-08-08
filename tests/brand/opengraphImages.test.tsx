import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'next/dist/compiled/picomatch';
import { describe, expect, it, vi } from 'vitest';
import { DOCS_REDIRECTS } from '@/next.config';
import { loadOgFonts, OG_FONT_FAMILY } from '@/app/_brand/ogFonts';

// MOTIR-1150 — the two OpenGraph cards (design/brand/design-notes.md §6).
//
// ── WHY THIS TEST RENDERS THE REAL IMAGE ────────────────────────────────────
// The font wiring is the part of this card that can be wrong in production while
// looking right everywhere else. `next/og` renders through satori, OUTSIDE the
// CSS tree: it cannot read `--font-sans-source`, cannot see `next/font`'s
// output, and has no system stack to fall back on. If the `fonts` option is
// missing or its bytes fail to load, the card does not error — it renders in
// whatever face the runtime happens to have, which is what both routes shipped
// before this card and what nobody noticed. So the assertion is that the routes
// actually PRODUCE a PNG with the faces attached, not that the source mentions
// them.
//
// (`next.config.ts` is imported for the tracing entries: `readFile` under
// `process.cwd()` is invisible to Next's dependency tracer, so those entries are
// the only reason the fonts exist in the deployed function at all. They are as
// load-bearing as the code and as easy to delete by accident.)

vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => null) }));
vi.mock('@/lib/services/publicProjectsService', () => ({
  publicProjectsService: { getOverview: vi.fn(async () => ({ name: 'Zephyr' })) },
}));

const PNG_MAGIC = '89504e470d0a1a0a';

async function renderRoute(image: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<Buffer> {
  return Buffer.from(await image.arrayBuffer());
}

describe('the fonts the cards are set in (§6)', () => {
  it('loads the three weights the template uses, as parseable TTFs', async () => {
    // satori does not synthesise weight — an absent one silently snaps to the
    // nearest present face, which would quietly re-weight the design.
    const fonts = await loadOgFonts();
    expect(fonts.map((f) => f.weight).sort()).toEqual([400, 700, 800]);
    for (const font of fonts) {
      expect(font.name).toBe(OG_FONT_FAMILY);
      // 0x00010000 — the sfnt version every TrueType file opens with. satori
      // cannot decompress WOFF2, so a woff2 slipped in here would fail at render
      // time on a surface nobody looks at.
      expect(font.data.subarray(0, 4).toString('hex')).toBe('00010000');
    }
  });

  it('is carried into the deployed function by a tracing key that actually MATCHES', async () => {
    // A tracing key that matches nothing is the failure this asserts against:
    // it is silent, it looks like configuration, and its only symptom is a
    // production card in the wrong face. So the keys are run through the same
    // matcher Next uses (`collect-build-traces.js`: picomatch with
    // `contains: true`, against `normalizeAppPath(entryName)` — which strips the
    // route group and the `/route` suffix, and leaves the content hash Next
    // appends to a metadata route in place).
    //
    // ⚠️ This asserts the key WOULD match, not that it currently runs (MOTIR-2403).
    // `collect-build-traces.js` is skipped entirely under Turbopack, so on this
    // repo's build the key is inert and Turbopack's own tracer is what carries
    // the fonts — verified in the built
    // `.next/server/app/(public)/explore/opengraph-image-*/route.js.nft.json`.
    // The assertion is kept because the key is the webpack-path safety net, and
    // a net with a wrong key in it is worse than no net. Do not read a green
    // result here as evidence the fonts shipped; read the `.nft.json`.
    const { default: config } = await import('@/next.config');
    const includes = (config as { outputFileTracingIncludes?: Record<string, string[]> })
      .outputFileTracingIncludes;
    expect(includes).toBeDefined();

    const built = ['/explore/opengraph-image-1br99b', '/p/[identifier]/opengraph-image-yrf2i5'];
    for (const route of built) {
      const matching = Object.entries(includes!).filter(([key]) =>
        picomatch(key, { dot: true, contains: true })(route),
      );
      expect(matching.map(([, v]) => v).flat(), route).toContain('./app/_brand/fonts/**');
    }
    // ...and only those routes: a key broad enough to hit every page would put
    // ~1 MB of fonts into every serverless function in the app.
    for (const route of ['/dashboard', '/manifest.webmanifest', '/items/[key]']) {
      const matching = Object.keys(includes!).filter((key) =>
        picomatch(key, { dot: true, contains: true })(route),
      );
      expect(matching, route).toEqual([]);
    }
    // Sanity that we imported the real config and not an empty module.
    expect(DOCS_REDIRECTS.length).toBeGreaterThan(0);
  });
});

describe('the explore card — the SECTION layout (§6)', () => {
  it('renders a real PNG at 1200 x 630', async () => {
    const { default: route, size, alt } = await import('@/app/(public)/explore/opengraph-image');
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(alt).toBeTruthy();
    const png = await renderRoute(await route());
    expect(png.subarray(0, 8).toString('hex')).toBe(PNG_MAGIC);
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  }, 30_000);

  it('draws the real mark, not the ad-hoc M tile', async () => {
    const mod = await import('@/app/(public)/explore/opengraph-image');
    const src = readFileSync(
      join(process.cwd(), 'app/(public)/explore/opengraph-image.tsx'),
      'utf8',
    );
    expect(src).toContain('WAVE_BAND_PATH');
    // The 72px purple tile bearing a literal "M" was the placeholder this card
    // replaces; nothing should re-introduce a letterform stand-in.
    expect(src).not.toMatch(/>\s*M\s*</);
    expect(mod.default).toBeTypeOf('function');
  });
});

describe('the project card — TWO LAYOUTS, not one (§6)', () => {
  it('renders a real PNG and now exports an alt', async () => {
    const mod = await import('@/app/(public)/p/[identifier]/opengraph-image');
    // The alt is the only accessible name a social embed gets, and this route
    // had none before this card.
    expect(mod.alt).toBe('Public project on Motir');
    const png = await renderRoute(
      await mod.default({ params: Promise.resolve({ identifier: 'ZPH' }) }),
    );
    expect(png.subarray(0, 8).toString('hex')).toBe(PNG_MAGIC);
    expect(png.readUInt32BE(16)).toBe(1200);
  }, 30_000);

  it('keeps the project as the subject and moves the brand to a footer lockup', async () => {
    const src = readFileSync(
      join(process.cwd(), 'app/(public)/p/[identifier]/opengraph-image.tsx'),
      'utf8',
    );
    // The big initial tile stays — here the PROJECT is what is being shared, so
    // parameterising the explore layout would have put the two identities in
    // competition.
    expect(src).toContain('{initial}');
    expect(src).toContain('WAVE_BAND_PATH');
    expect(src).toContain('opacity: 0.85');
  });
});
