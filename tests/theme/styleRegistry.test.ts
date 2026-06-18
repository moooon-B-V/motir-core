import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STYLE_ID,
  STYLE_DIMENSIONS,
  STYLE_IDS,
  STYLE_REGISTRY,
  isStyleId,
  resolveStyle,
} from '@/lib/theme/styles';

// Subtask 7.3.32 — the named-style registry is the single source of truth for
// the `data-style` axis: the runtime contract, the `/tokens` toggle, the init
// script's validation list, and every later "Style: …" subtask read from it.
// This suite pins the contract the foundation must hold: the two existing
// styles are registered, the style→DESIGN.md mapping resolves to a real file,
// each style is total over the feel-bearing dimensions, and the style axis is
// kept disjoint from the colour (palette) axis in globals.css.

const GLOBALS_CSS = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');

describe('style registry', () => {
  it('registers the two existing styles (Warm Editorial + Soft / Playful)', () => {
    expect(STYLE_IDS).toEqual(['warm-editorial', 'soft-playful']);
    expect(STYLE_REGISTRY['warm-editorial'].name).toBe('Warm Editorial');
    expect(STYLE_REGISTRY['soft-playful'].name).toBe('Soft / Playful');
  });

  it('keeps every entry self-consistent (key === id) and STYLE_IDS in sync', () => {
    expect(STYLE_IDS).toEqual(Object.keys(STYLE_REGISTRY));
    for (const id of STYLE_IDS) {
      expect(STYLE_REGISTRY[id].id).toBe(id);
    }
  });

  it('resolves the default to a registered style', () => {
    expect(STYLE_IDS).toContain(DEFAULT_STYLE_ID);
    expect(DEFAULT_STYLE_ID).toBe('warm-editorial');
  });

  it('characterizes every feel-bearing dimension for every style (totality)', () => {
    const dimensionKeys = STYLE_DIMENSIONS.map((d) => d.key);
    for (const id of STYLE_IDS) {
      const dims = STYLE_REGISTRY[id].dimensions;
      expect(Object.keys(dims).sort()).toEqual([...dimensionKeys].sort());
      for (const key of dimensionKeys) {
        expect(dims[key].length).toBeGreaterThan(0);
      }
    }
  });

  it('maps every style to a DESIGN.md that exists on disk', () => {
    for (const id of STYLE_IDS) {
      const doc = STYLE_REGISTRY[id].designDoc;
      expect(doc).toBe(`docs/styles/${id}.md`);
      expect(existsSync(join(process.cwd(), doc))).toBe(true);
    }
  });
});

describe('isStyleId / resolveStyle', () => {
  it('accepts registered ids and rejects unknown / legacy values', () => {
    expect(isStyleId('warm-editorial')).toBe(true);
    expect(isStyleId('soft-playful')).toBe(true);
    // The pre-7.3.32 display-style values are no longer valid style ids.
    expect(isStyleId('default')).toBe(false);
    expect(isStyleId('soft')).toBe(false);
    expect(isStyleId('')).toBe(false);
    expect(isStyleId(null)).toBe(false);
    expect(isStyleId(undefined)).toBe(false);
  });

  it('resolves a stale / unknown value to the default style', () => {
    expect(resolveStyle('default').id).toBe(DEFAULT_STYLE_ID);
    expect(resolveStyle('nope').id).toBe(DEFAULT_STYLE_ID);
    expect(resolveStyle('soft-playful').id).toBe('soft-playful');
  });
});

describe('runtime contract in globals.css', () => {
  it('ships a [data-style] block for every non-default style', () => {
    for (const id of STYLE_IDS) {
      if (id === DEFAULT_STYLE_ID) continue; // the base needs no override block
      expect(GLOBALS_CSS).toContain(`[data-style='${id}']`);
    }
  });

  it('keeps the style axis disjoint from colour — no colour token in a [data-style] block', () => {
    // Extract each `[data-style='…'] { … }` block and assert it sets only
    // shape/feel tokens, never a `--color-*` / `--el-*` colour token (that is
    // the independent data-palette axis's job — the acceptance criterion).
    const blockRe = /\[data-style='[^']+'\]\s*\{([^}]*)\}/g;
    let match: RegExpExecArray | null;
    let blocksChecked = 0;
    while ((match = blockRe.exec(GLOBALS_CSS)) !== null) {
      const body = match[1];
      blocksChecked += 1;
      expect(body).not.toMatch(/--color-/);
      expect(body).not.toMatch(/--el-/);
    }
    expect(blocksChecked).toBeGreaterThanOrEqual(STYLE_IDS.length - 1);
  });
});
