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
import { isTypeId } from '@/lib/theme/typography';

// Subtask 7.3.32 — the named-style registry is the single source of truth for
// the `data-style` axis: the runtime contract, the `/tokens` toggle, the init
// script's validation list, and every later "Style: …" subtask read from it.
// This suite pins the contract the foundation must hold: the two existing
// styles are registered, the style→DESIGN.md mapping resolves to a real file,
// each style is total over the feel-bearing dimensions, and the style axis is
// kept disjoint from the colour (palette) axis in globals.css.

const GLOBALS_CSS = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');

describe('style registry', () => {
  it('registers the styles in gallery order (Warm Editorial + Soft / Playful + Swiss / Minimal-Flat + Neo-Brutalism + Glassmorphism + Cybercore / Y2K + Aurora + 3D / Immersive + Neumorphism + Hand-Drawn / Indie + Retrofuturism)', () => {
    expect(STYLE_IDS).toEqual([
      'warm-editorial',
      'soft-playful',
      'swiss-minimal-flat',
      'neo-brutalism',
      'glassmorphism',
      'cybercore-y2k',
      'aurora',
      '3d-immersive',
      'neumorphism',
      'hand-drawn-indie',
      'retrofuturism',
    ]);
    expect(STYLE_REGISTRY['warm-editorial'].name).toBe('Warm Editorial');
    expect(STYLE_REGISTRY['soft-playful'].name).toBe('Soft / Playful');
    expect(STYLE_REGISTRY['swiss-minimal-flat'].name).toBe('Swiss / Minimal-Flat');
    expect(STYLE_REGISTRY['neo-brutalism'].name).toBe('Neo-Brutalism');
    expect(STYLE_REGISTRY['glassmorphism'].name).toBe('Glassmorphism');
    expect(STYLE_REGISTRY['cybercore-y2k'].name).toBe('Cybercore / Y2K');
    expect(STYLE_REGISTRY['aurora'].name).toBe('Aurora');
    expect(STYLE_REGISTRY['3d-immersive'].name).toBe('3D / Immersive');
    expect(STYLE_REGISTRY['neumorphism'].name).toBe('Neumorphism');
    expect(STYLE_REGISTRY['hand-drawn-indie'].name).toBe('Hand-Drawn / Indie');
    expect(STYLE_REGISTRY['retrofuturism'].name).toBe('Retrofuturism');
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

  it('keeps the style axis disjoint from colour AND type — no colour or font token in a [data-style] token block', () => {
    // Extract each bare `[data-style='…'] { … }` TOKEN block and assert it sets
    // only shape/feel tokens, never a `--color-*` / `--el-*` colour token (the
    // independent data-palette axis) NOR a `--font-*` role token (the
    // independent data-type axis, 7.3.53 — type used to live here and moved out).
    // Descendant-scoped material rules (`[data-style='id'] [data-surface] { … }`)
    // are NOT token blocks and are checked separately below.
    // Strip CSS comments first so a comment that merely MENTIONS a token (e.g.
    // "sets no --font-* token") can't be mistaken for a real declaration.
    const css = GLOBALS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const blockRe = /\[data-style='[^']+'\]\s*\{([^}]*)\}/g;
    let match: RegExpExecArray | null;
    let blocksChecked = 0;
    while ((match = blockRe.exec(css)) !== null) {
      const body = match[1];
      blocksChecked += 1;
      expect(body).not.toMatch(/--color-/);
      expect(body).not.toMatch(/--el-/);
      expect(body).not.toMatch(/--font-/);
    }
    expect(blocksChecked).toBeGreaterThanOrEqual(STYLE_IDS.length - 1);
  });
});

describe('style → type axis integration (7.3.53)', () => {
  it('every style declares a valid defaultTypeId (a registered type pairing)', () => {
    for (const id of STYLE_IDS) {
      expect(isTypeId(STYLE_REGISTRY[id].defaultTypeId)).toBe(true);
    }
  });

  it('preserves the migrated styles’ out-of-the-box type feel', () => {
    // The per-style `--font-serif` overrides moved to the data-type axis; the
    // styles keep their look via defaultTypeId (zero visual regression).
    expect(STYLE_REGISTRY['swiss-minimal-flat'].defaultTypeId).toBe('motir-sans');
    expect(STYLE_REGISTRY['neo-brutalism'].defaultTypeId).toBe('motir-mono');
    expect(STYLE_REGISTRY['cybercore-y2k'].defaultTypeId).toBe('motir-mono');
    // Retrofuturism ships the wide geometric grotesque as its retro-display read.
    expect(STYLE_REGISTRY['retrofuturism'].defaultTypeId).toBe('grotesk');
    // Styles that never overrode type stay on the base pairing.
    expect(STYLE_REGISTRY['warm-editorial'].defaultTypeId).toBe('motir');
    expect(STYLE_REGISTRY['glassmorphism'].defaultTypeId).toBe('motir');
  });
});

describe('surface-material layer in globals.css (the 7.3.35 contract extension)', () => {
  // A SURFACE-MATERIAL style (glassmorphism, and later cybercore / aurora / …)
  // may own its surface — translucency, a gradient canvas, frosted
  // backdrop-blur, light borders — that the shape-only token block cannot
  // express. It does so via STYLE-SCOPED component rules
  // `[data-style='id'] <selector> { … }` (distinct from the bare token block,
  // which stays colour-free above). To keep the style axis disjoint from the
  // palette axis, that material MUST be PALETTE-DERIVED: every colour comes from
  // `color-mix()` / `var(--color-*|--el-*)` over the ACTIVE palette — NEVER a
  // raw hue. So a palette swap re-tints the glass; a style swap leaves hues be.

  // Descendant-scoped style rules: `[data-style='id'] <selector> { … }` — the
  // `[^{};]+` after the attribute is the descendant selector, which excludes
  // the bare token block (`[data-style='id'] {` has nothing before its brace).
  const materialRe = /\[data-style='[^']+'\]\s+[^{};]+\{([^}]*)\}/g;

  it('derives every material colour from the active palette — color-mix/var, never a raw hue', () => {
    let match: RegExpExecArray | null;
    let materialRulesChecked = 0;
    while ((match = materialRe.exec(GLOBALS_CSS)) !== null) {
      const body = match[1] ?? '';
      // Only assert on rules that actually paint a colour-bearing surface.
      if (!/(?:background|background-color|background-image|border-color|color)\s*:/.test(body)) {
        continue;
      }
      materialRulesChecked += 1;
      // Palette-derived: the rule must take its colour from the active palette —
      // either a palette token (`var(--color-*|--el-*)`, e.g. glassmorphism's
      // frosted surfaces + washes) or `currentColor` (the inherited palette hue,
      // e.g. cybercore-y2k's glow grid). Both pin NO hue of their own.
      expect(body).toMatch(/var\(--(?:color|el)-|currentColor/i);
      // …and must NOT hardcode a raw hue (a hex colour literal). Shadow ink
      // (rgba(15,15,15,…)) lives in the token block, not in a material rule.
      expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
    // Glassmorphism ships the canvas + frosted card/popover/modal/sidebar/input
    // material rules; guard that the matcher actually found them.
    expect(materialRulesChecked).toBeGreaterThanOrEqual(4);
  });
});
