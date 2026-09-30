import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderMock, extractClassCandidates } from '../src/mock';
import { loadStylesheet } from '../src/mock/renderMock';
import { Button } from '../src/index';
import { DEFAULT_PALETTE_ID } from '../src/theme/palettes';
import { DEFAULT_STYLE_ID } from '../src/theme/styles';

// MOTIR-6966 — the edges of `renderMock` (MOTIR-6961) its own suite does not
// reach: the stylesheet resolver's two non-tailwind arms, an absent `axes`
// object, and whitespace inside a class attribute.

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('loadStylesheet', () => {
  it('resolves a RELATIVE id against its base, and reports the file it read', async () => {
    const sheet = await loadStylesheet('./theme.css', PKG_ROOT);
    expect(sheet.path).toBe(path.join(PKG_ROOT, 'theme.css'));
    expect(sheet.base).toBe(PKG_ROOT.replace(/\/$/, ''));
    expect(sheet.content).toBe(readFileSync(path.join(PKG_ROOT, 'theme.css'), 'utf8'));
  });

  it('resolves a package id that is NOT `tailwindcss` as the package file it names', async () => {
    const sheet = await loadStylesheet('tailwindcss/theme.css', PKG_ROOT);
    expect(sheet.path).toMatch(/tailwindcss[\\/]theme\.css$/);
    expect(sheet.content).toContain('--color-');
  });

  it('maps a bare `tailwindcss` to its CSS entry, not its JS main', async () => {
    const sheet = await loadStylesheet('tailwindcss', PKG_ROOT);
    expect(sheet.path).toMatch(/tailwindcss[\\/]index\.css$/);
  });
});

describe('renderMock edges', () => {
  it('an ABSENT axes object falls back on all three axes, and says so', async () => {
    const html = await renderMock({
      title: 'No axes',
      panels: [{ label: 'x', element: <Button>Go</Button> }],
      axes: undefined as never,
    });
    expect(html).toContain(`data-style="${DEFAULT_STYLE_ID}"`);
    expect(html).toContain(`data-palette="${DEFAULT_PALETTE_ID}"`);
    for (const axis of ['styleId', 'paletteId', 'typeId']) {
      expect(html).toContain(`<!-- renderMock: ${axis} missing`);
    }
  });

  it('a null axis id reads as missing, not as the string "null"', async () => {
    const html = await renderMock({
      title: 'Null axis',
      panels: [{ label: 'x', element: <Button>Go</Button> }],
      axes: { styleId: DEFAULT_STYLE_ID, paletteId: null as never, typeId: 'motir' },
    });
    expect(html).toContain('<!-- renderMock: paletteId missing');
  });
});

describe('extractClassCandidates', () => {
  it('drops the empty tokens that leading, trailing and doubled spaces make', () => {
    expect(extractClassCandidates('<p class="  a   b "></p><i class=""></i>')).toEqual(['a', 'b']);
  });

  it('reads single-quote entities as the compiler must see them', () => {
    expect(
      extractClassCandidates(`<p class="[content:&#x27;x&#x27;] [content:&#39;y&#39;]"></p>`),
    ).toEqual(["[content:'x']", "[content:'y']"]);
  });
});
