import { describe, it, expect } from 'vitest';
import {
  STYLE_IDS,
  PALETTE_IDS,
  TYPE_IDS,
  DEFAULT_STYLE_ID,
  DEFAULT_PALETTE_ID,
  DEFAULT_TYPE_ID,
  STYLE_DEFAULT_TYPE,
  isStyleId,
  isPaletteId,
  isTypeId,
  resolveStyle,
  resolvePalette,
  resolveType,
  defaultTypeForStyle,
} from '../src/index';

// The registries load through the PUBLIC package entry (the barrel) — proving
// the `.` export resolves and the three-axis data is present + coherent.
describe('axis registries', () => {
  it('expose non-empty id lists whose defaults are members', () => {
    expect(STYLE_IDS.length).toBeGreaterThan(0);
    expect(PALETTE_IDS.length).toBeGreaterThan(0);
    expect(TYPE_IDS.length).toBeGreaterThan(0);
    expect(STYLE_IDS).toContain(DEFAULT_STYLE_ID);
    expect(PALETTE_IDS).toContain(DEFAULT_PALETTE_ID);
    expect(TYPE_IDS).toContain(DEFAULT_TYPE_ID);
  });

  it('guards accept real ids and reject junk', () => {
    expect(isStyleId(DEFAULT_STYLE_ID)).toBe(true);
    expect(isPaletteId(DEFAULT_PALETTE_ID)).toBe(true);
    expect(isTypeId(DEFAULT_TYPE_ID)).toBe(true);
    expect(isStyleId('not-a-style')).toBe(false);
    expect(isPaletteId(null)).toBe(false);
    expect(isTypeId(42)).toBe(false);
  });

  it('resolvers collapse unknown values to the documented defaults', () => {
    expect(resolveStyle('nope').id).toBe(DEFAULT_STYLE_ID);
    expect(resolvePalette(undefined).id).toBe(DEFAULT_PALETTE_ID);
    expect(resolveType(null).id).toBe(DEFAULT_TYPE_ID);
  });

  it('every style has a registered default type, reachable via defaultTypeForStyle', () => {
    for (const styleId of STYLE_IDS) {
      const dflt = STYLE_DEFAULT_TYPE[styleId];
      expect(TYPE_IDS).toContain(dflt);
      expect(defaultTypeForStyle(styleId)).toBe(dflt);
    }
    // An unknown style still resolves to a valid (global-default) type.
    expect(TYPE_IDS).toContain(defaultTypeForStyle('unknown-style'));
  });
});
