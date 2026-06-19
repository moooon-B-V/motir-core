import { describe, expect, it } from 'vitest';
import {
  resolveAxesToApplied,
  resolveAppliedAppearance,
  type LocalAppearanceSnapshot,
} from '@/lib/theme/appearance-resolution';
import type { AppliedAppearanceDto } from '@/lib/dto/appearancePreference';
import { DEFAULT_STYLE_ID } from '@/lib/theme/styles';
import { DEFAULT_PALETTE_ID } from '@/lib/theme/palettes';
import { DEFAULT_TYPE_ID } from '@/lib/theme/typography';
import { THEME_DEFAULTS } from '@/lib/theme/types';

// Subtask 7.3.61 — the registry-pure reconciliation that decides what drives the
// four <html> data-attributes. The two things under test are (1) the precedence
// between the server preference and localStorage, and (2) the type-axis rule the
// per-axis DTO mapper deferred to this subtask: an unpinned type follows the
// active STYLE's default, not the global default.

const emptyLocal: LocalAppearanceSnapshot = {
  pattern: null,
  style: null,
  palette: null,
  type: null,
};

describe('resolveAxesToApplied', () => {
  it('collapses absent / null axes to the documented defaults', () => {
    expect(resolveAxesToApplied({})).toEqual<AppliedAppearanceDto>({
      pattern: THEME_DEFAULTS.pattern,
      styleId: DEFAULT_STYLE_ID,
      paletteId: DEFAULT_PALETTE_ID,
      typeId: DEFAULT_TYPE_ID,
      typePinned: false,
    });
  });

  it('collapses stale / unknown axis values to the defaults', () => {
    expect(
      resolveAxesToApplied({
        pattern: 'ultraviolet',
        styleId: 'no-such-style',
        paletteId: 'no-such-palette',
        typeId: 'no-such-type',
      }),
    ).toEqual<AppliedAppearanceDto>({
      pattern: THEME_DEFAULTS.pattern,
      styleId: DEFAULT_STYLE_ID,
      paletteId: DEFAULT_PALETTE_ID,
      // the default style's own default type — happens to be the global default
      typeId: DEFAULT_TYPE_ID,
      typePinned: false,
    });
  });

  it('keeps a pinned, still-registered type and marks it pinned', () => {
    const applied = resolveAxesToApplied({
      pattern: 'dark',
      styleId: 'swiss-minimal-flat',
      paletteId: 'cobalt',
      typeId: 'editorial',
    });
    expect(applied).toEqual<AppliedAppearanceDto>({
      pattern: 'dark',
      styleId: 'swiss-minimal-flat',
      paletteId: 'cobalt',
      typeId: 'editorial',
      typePinned: true,
    });
  });

  it('follows the active STYLE default type when no type is pinned (NOT the global default)', () => {
    // swiss-minimal-flat's defaultTypeId is `motir-sans` (≠ global `motir`),
    // so an unpinned type must resolve to the style default, not `motir`.
    const applied = resolveAxesToApplied({
      styleId: 'swiss-minimal-flat',
      typeId: null,
    });
    expect(applied.typeId).toBe('motir-sans');
    expect(applied.typePinned).toBe(false);

    // neo-brutalism → motir-mono, same rule, different style.
    const brutal = resolveAxesToApplied({ styleId: 'neo-brutalism' });
    expect(brutal.typeId).toBe('motir-mono');
    expect(brutal.typePinned).toBe(false);
  });

  it('falls the unpinned type back to the global default for an unknown style', () => {
    const applied = resolveAxesToApplied({ styleId: 'no-such-style', typeId: undefined });
    expect(applied.styleId).toBe(DEFAULT_STYLE_ID);
    expect(applied.typeId).toBe(DEFAULT_TYPE_ID);
    expect(applied.typePinned).toBe(false);
  });
});

describe('resolveAppliedAppearance — server vs. localStorage precedence', () => {
  const server: AppliedAppearanceDto = {
    pattern: 'dark',
    styleId: 'neo-brutalism',
    paletteId: 'cobalt',
    typeId: 'mono-technical',
    typePinned: true,
  };

  it('server present → server wins (localStorage ignored)', () => {
    const local: LocalAppearanceSnapshot = {
      pattern: 'light',
      style: 'swiss-minimal-flat',
      palette: 'graphite',
      type: 'grotesk',
    };
    expect(resolveAppliedAppearance(server, local)).toEqual(server);
  });

  it('server present even with empty localStorage → still server', () => {
    expect(resolveAppliedAppearance(server, emptyLocal)).toEqual(server);
  });

  it('server absent (anonymous) → resolve from localStorage', () => {
    const local: LocalAppearanceSnapshot = {
      pattern: 'light',
      style: 'swiss-minimal-flat',
      palette: 'graphite',
      type: null, // unpinned → follows the style default (motir-sans)
    };
    expect(resolveAppliedAppearance(null, local)).toEqual<AppliedAppearanceDto>({
      pattern: 'light',
      styleId: 'swiss-minimal-flat',
      paletteId: 'graphite',
      typeId: 'motir-sans',
      typePinned: false,
    });
  });

  it('server absent + empty localStorage → all defaults', () => {
    expect(resolveAppliedAppearance(null, emptyLocal)).toEqual<AppliedAppearanceDto>({
      pattern: THEME_DEFAULTS.pattern,
      styleId: DEFAULT_STYLE_ID,
      paletteId: DEFAULT_PALETTE_ID,
      typeId: DEFAULT_TYPE_ID,
      typePinned: false,
    });
  });
});
