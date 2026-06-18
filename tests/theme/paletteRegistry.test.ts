import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PALETTE_ID,
  PALETTE_IDS,
  PALETTE_REGISTRY,
  isPaletteId,
  resolvePalette,
} from '@/lib/theme/palettes';
import { THEME_DEFAULTS, THEME_STORAGE_KEYS } from '@/lib/theme/types';
import { themeInitScript } from '@/lib/theme/init-script';

// Subtask 7.3.48 — the named-palette registry is the single source of truth for
// the `data-palette` axis (the COLOUR half of the two-axis contract 7.3.32 wrote
// but did not implement): the runtime contract, the init script's validation
// list, and every later "Palette: …" subtask read from it. This suite pins the
// contract the foundation must hold: v1 registers Motir's own palette, the
// palette→doc mapping resolves to a real file, the default resolves, and the
// palette axis is kept disjoint from the shape (style) axis in globals.css.

const GLOBALS_CSS = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');

describe('palette registry', () => {
  it('registers the v1 palette set (Motir — the house palette — plus Graphite, Evergreen, Spectrum)', () => {
    expect(PALETTE_IDS).toEqual(['motir', 'graphite', 'evergreen', 'spectrum']);
    expect(PALETTE_REGISTRY['motir'].name).toBe('Motir');
    expect(PALETTE_REGISTRY['graphite'].name).toBe('Graphite');
    expect(PALETTE_REGISTRY['evergreen'].name).toBe('Evergreen');
    expect(PALETTE_REGISTRY['spectrum'].name).toBe('Spectrum');
  });

  it('keeps every entry self-consistent (key === id) and PALETTE_IDS in sync', () => {
    expect(PALETTE_IDS).toEqual(Object.keys(PALETTE_REGISTRY));
    for (const id of PALETTE_IDS) {
      expect(PALETTE_REGISTRY[id].id).toBe(id);
    }
  });

  it('resolves the default to a registered palette', () => {
    expect(PALETTE_IDS).toContain(DEFAULT_PALETTE_ID);
    expect(DEFAULT_PALETTE_ID).toBe('motir');
  });

  it('characterizes every entry (non-empty name / tagline / inspiration)', () => {
    for (const id of PALETTE_IDS) {
      const p = PALETTE_REGISTRY[id];
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.tagline.length).toBeGreaterThan(0);
      expect(p.inspiration.length).toBeGreaterThan(0);
    }
  });

  it('maps every palette to a doc that exists on disk', () => {
    for (const id of PALETTE_IDS) {
      const doc = PALETTE_REGISTRY[id].designDoc;
      expect(doc).toBe(`docs/palettes/${id}.md`);
      expect(existsSync(join(process.cwd(), doc))).toBe(true);
    }
  });
});

describe('isPaletteId / resolvePalette', () => {
  it('accepts registered ids and rejects unknown values', () => {
    expect(isPaletteId('motir')).toBe(true);
    expect(isPaletteId('ocean')).toBe(false);
    expect(isPaletteId('')).toBe(false);
    expect(isPaletteId(null)).toBe(false);
    expect(isPaletteId(undefined)).toBe(false);
  });

  it('resolves a stale / unknown value to the default palette', () => {
    expect(resolvePalette('nope').id).toBe(DEFAULT_PALETTE_ID);
    expect(resolvePalette(null).id).toBe(DEFAULT_PALETTE_ID);
    expect(resolvePalette('motir').id).toBe('motir');
  });
});

describe('theme wiring', () => {
  it('exposes a distinct storage key + default for the palette axis', () => {
    expect(THEME_STORAGE_KEYS.palette).toBe('motir.theme.palette');
    expect(THEME_DEFAULTS.palette).toBe(DEFAULT_PALETTE_ID);
    // The three axes use distinct storage keys (no collision).
    const keys = [THEME_STORAGE_KEYS.pattern, THEME_STORAGE_KEYS.style, THEME_STORAGE_KEYS.palette];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('applies data-palette pre-hydration in the FOUC init script', () => {
    // The init script reads the palette key, validates it against the baked-in
    // id list, and sets the attribute — so a refresh has no colour flash.
    expect(themeInitScript).toContain('data-palette');
    expect(themeInitScript).toContain(THEME_STORAGE_KEYS.palette);
    expect(themeInitScript).toContain(JSON.stringify(PALETTE_IDS));
  });
});

describe('runtime contract in globals.css', () => {
  it('documents the data-palette axis section', () => {
    expect(GLOBALS_CSS).toContain('AXIS 1 (COLOUR) — data-palette overrides');
  });

  it('ships a [data-palette] block for every non-default palette', () => {
    for (const id of PALETTE_IDS) {
      if (id === DEFAULT_PALETTE_ID) continue; // the base needs no override block
      expect(GLOBALS_CSS).toContain(`[data-palette='${id}']`);
    }
  });

  it('keeps the palette axis disjoint from shape — no shape/feel token in a [data-palette] block', () => {
    // Extract each `[data-palette='…'] { … }` block and assert it sets only
    // colour tokens (--el-* / --color-*), never a shape/feel token (radius /
    // spacing / shadow / sizing / motion / type) — that is the independent
    // data-style axis's job (the acceptance criterion, mirrored from the
    // style-axis guard in styleRegistry.test.ts).
    //
    // Strip CSS comments first so the documentation's literal
    // `[data-palette='<id>']` examples can't be mistaken for real rules, and
    // match selector chars with `[^{}]*` (supports a compound
    // `[data-palette='x'][data-theme='dark']` selector without crossing a `}`).
    const css = GLOBALS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const blockRe = /\[data-palette='[^']+'\][^{}]*\{([^}]*)\}/g;
    let match: RegExpExecArray | null;
    let blocksChecked = 0;
    while ((match = blockRe.exec(css)) !== null) {
      const body = match[1];
      blocksChecked += 1;
      expect(body).not.toMatch(/--radius-|--spacing-|--shadow-|--height-|--transition-/);
    }
    // v1 has only the base palette (no block), so this is vacuous now and
    // becomes load-bearing as palettes are added.
    expect(blocksChecked).toBeGreaterThanOrEqual(PALETTE_IDS.length - 1);
  });
});
