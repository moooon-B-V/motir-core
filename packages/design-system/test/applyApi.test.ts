import { describe, it, expect } from 'vitest';
import {
  resolveAxesToApplied,
  resolveAppliedAppearance,
  buildThemeInitScript,
  themeInitScript,
  STYLE_IDS,
  PALETTE_IDS,
  TYPE_IDS,
  DEFAULT_STYLE_ID,
  DEFAULT_PALETTE_ID,
  STYLE_DEFAULT_TYPE,
  type AppliedAppearanceDto,
} from '../src/index';

// The theme-apply API (ADR §4) — the stable seam a consumer (motir-core, the
// starter, the scaffold agent) calls to APPLY a stored {styleId,paletteId,typeId}
// choice. These assert it produces the expected applied `[data-*]` set.
describe('theme-apply API', () => {
  // Pick concrete non-default ids where possible so the assertions prove the
  // input actually flows through (not just the defaults leaking).
  const styleId = STYLE_IDS.find((s) => s !== DEFAULT_STYLE_ID) ?? DEFAULT_STYLE_ID;
  const paletteId = PALETTE_IDS.find((p) => p !== DEFAULT_PALETTE_ID) ?? DEFAULT_PALETTE_ID;
  const typeId = TYPE_IDS[0]!;

  it('resolveAxesToApplied maps a full pinned choice to the four applied ids', () => {
    const applied = resolveAxesToApplied({ pattern: 'dark', styleId, paletteId, typeId });
    expect(applied).toEqual<AppliedAppearanceDto>({
      pattern: 'dark',
      styleId,
      paletteId,
      typeId,
      typePinned: true,
    });
  });

  it('collapses unknown axis values to the documented defaults', () => {
    const applied = resolveAxesToApplied({
      pattern: 'banana',
      styleId: 'nope',
      paletteId: 'nope',
      typeId: 'nope',
    });
    expect(applied.pattern).toBe('system');
    expect(applied.styleId).toBe(DEFAULT_STYLE_ID);
    expect(applied.paletteId).toBe(DEFAULT_PALETTE_ID);
    expect(applied.typePinned).toBe(false);
    // An unpinned type follows the ACTIVE style's default, not a global one.
    expect(applied.typeId).toBe(STYLE_DEFAULT_TYPE[DEFAULT_STYLE_ID]);
  });

  it('an unpinned type follows the chosen style default', () => {
    const applied = resolveAxesToApplied({ styleId, paletteId });
    expect(applied.typePinned).toBe(false);
    expect(applied.typeId).toBe(STYLE_DEFAULT_TYPE[styleId]);
  });

  it('resolveAppliedAppearance prefers a present server pref over localStorage', () => {
    const server = resolveAxesToApplied({ pattern: 'light', styleId, paletteId, typeId });
    const applied = resolveAppliedAppearance(server, {
      pattern: 'dark',
      style: DEFAULT_STYLE_ID,
      palette: DEFAULT_PALETTE_ID,
      type: null,
    });
    expect(applied).toBe(server); // server wins verbatim
  });

  it('buildThemeInitScript embeds the applied choice and sets the four data-* attributes', () => {
    const applied = resolveAxesToApplied({ pattern: 'dark', styleId, paletteId, typeId });
    const script = buildThemeInitScript(applied);
    // The four attributes the applied state drives (ADR §4).
    expect(script).toContain("d.setAttribute('data-theme',resolved)");
    expect(script).toContain("d.setAttribute('data-style',style)");
    expect(script).toContain("d.setAttribute('data-palette',palette)");
    expect(script).toContain("d.setAttribute('data-type',type)");
    // The server pref is embedded so the pre-hydration script applies exactly it.
    expect(script).toContain(`"styleId":"${styleId}"`);
    expect(script).toContain(`"paletteId":"${paletteId}"`);
    expect(script).toContain(`"typeId":"${typeId}"`);
  });

  it('the anonymous baseline script embeds no server pref', () => {
    expect(themeInitScript).toBe(buildThemeInitScript(null));
    expect(themeInitScript).toContain('var server=null');
  });
});
