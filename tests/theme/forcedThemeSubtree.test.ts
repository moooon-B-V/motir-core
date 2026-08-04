import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PALETTE_IDS } from '@/lib/theme/palettes';
import {
  loadTokenLayer,
  resolveTokenInScope,
  type ElementAttributes,
  type ScopeChain,
} from './paletteCascade';

// MOTIR-2077 — a NESTED subtree that forces the OTHER theme back on.
//
// theme.css ships `[data-theme='light']` for exactly one job: letting a subtree
// render light while <html> is dark (the onboarding design step, MOTIR-1040,
// previews the user's project that way). The sibling suites only ever resolve
// the ROOT element, so nothing checked that job was actually done.
//
// ── The mechanism, and why re-asserting Tier-0 alone is not it ──────────────
// `--el-*` are declared as `--el-x: var(--color-y)`, and `var()` substitutes at
// the element where the property is DECLARED. Re-declaring `--color-*` on a
// nested element therefore changes nothing a component reads: the `--el-*` it
// consumes were already resolved at `:root` and merely inherit down. The shipped
// answer is `[data-appearance-scope]`, which re-emits the whole Tier-3 layer onto
// the scoped element so its `var()`s resolve against the LOCAL Tier-0 overrides.
// It is axis-agnostic — the same attribute is what makes a nested `data-palette`
// or `data-style` work — so this card did NOT add a light-only `--el-*` companion
// mirroring the dark one; that would duplicate ~190 tokens as a second sync
// surface while still leaving the other two axes needing the scope attribute.
//
// What WAS broken is one layer lower and reachable through the real consumer: a
// Tier-0 token the dark block declares and the light re-assertion FORGETS keeps
// its dark value in a forced-light subtree, scope attribute or not, because
// there is nothing local to override the inherited value. `--color-canvas` was
// the one such token (measured in Chromium: `--el-canvas` stayed `#0e0e0e`).
// PARITY is the invariant, so the last test here pins it for every token rather
// than re-fixing the canvas alone.

const { rules, elementTokens } = loadTokenLayer();

/** The five tokens the card names — page, surfaces, canvas, ink, borders. */
const AC_TOKENS = ['--el-page-bg', '--el-surface', '--el-canvas', '--el-text', '--el-border'];

/**
 * ROOT attributes. `light` is the implicit `@theme` base, so <html> carries NO
 * `data-theme` for it — the asymmetry the nested case exists to undo.
 */
const root = (theme: 'light' | 'dark', palette: string): ElementAttributes => ({
  'data-palette': palette,
  ...(theme === 'dark' ? { 'data-theme': 'dark' } : {}),
});

/** A nested subtree forcing `theme` back on, the way DesignStep.tsx does it. */
const scope = (theme: 'light' | 'dark', palette: string): ElementAttributes => ({
  'data-appearance-scope': '',
  'data-theme': theme,
  'data-palette': palette,
});

const resolveAll = (chain: ScopeChain, tokens: string[]) =>
  Object.fromEntries(
    tokens.map((token) => [token, resolveTokenInScope(rules, chain, token).value.toLowerCase()]),
  );

describe('a nested subtree that forces the other theme on', () => {
  // The contract: a scoped subtree resolves EXACTLY what a root of that theme
  // resolves. Comparing against the sibling root — rather than against hardcoded
  // hexes — keeps the suite true when a palette re-tints one of these tokens.
  describe.each(PALETTE_IDS)('under palette %s', (palette) => {
    it('a forced-LIGHT subtree inside a dark root resolves every element token to its light value', () => {
      const scoped = resolveAll([root('dark', palette), scope('light', palette)], elementTokens);
      expect(scoped).toEqual(resolveAll([root('light', palette)], elementTokens));
    });

    it('a forced-DARK subtree inside a light root still resolves every element token to its dark value', () => {
      const scoped = resolveAll([root('light', palette), scope('dark', palette)], elementTokens);
      expect(scoped).toEqual(resolveAll([root('dark', palette)], elementTokens));
    });
  });

  it('resolves the tokens the card names to concrete colours, not empty strings', () => {
    const scoped = resolveAll([root('dark', 'motir'), scope('light', 'motir')], AC_TOKENS);
    for (const token of AC_TOKENS) expect(scoped[token]).toMatch(/^#[0-9a-f]{3,8}$/);
  });
});

describe('the documented limit: the scope attribute is what re-skins a subtree', () => {
  // Pinned deliberately. A bare nested `data-theme` re-declares Tier-0 only, so
  // every `--el-*` keeps the ROOT's theme — the behaviour that made the light
  // block look inert. It is not a bug to fix here but the same contract
  // `data-palette` and `data-style` already have, so it is asserted rather than
  // left as folklore: whoever changes it will see this test go red and can then
  // decide the mechanism deliberately.
  it('a nested data-theme WITHOUT data-appearance-scope leaves the element tokens at the root theme', () => {
    const bare: ElementAttributes = { 'data-palette': 'motir', 'data-theme': 'light' };
    const nested = resolveAll([root('dark', 'motir'), bare], AC_TOKENS);
    expect(nested).toEqual(resolveAll([root('dark', 'motir')], AC_TOKENS));
  });

  it('but its Tier-0 sources DO flip, which is what makes the scope attribute sufficient', () => {
    const bare: ElementAttributes = { 'data-palette': 'motir', 'data-theme': 'light' };
    const chain: ScopeChain = [root('dark', 'motir'), bare];
    expect(resolveTokenInScope(rules, chain, '--color-background').value).toBe('#ffffff');
    expect(resolveTokenInScope(rules, chain, '--color-canvas').value).not.toBe('#0e0e0e');
  });
});

describe('Tier-0 light/dark block parity (the root cause)', () => {
  // A token the dark block declares and the light re-assertion omits cannot be
  // undone by ANY downstream mechanism: with nothing local to shadow it, the
  // dark value simply inherits into the forced-light subtree. That was the
  // defect (`--color-canvas`), so parity is the durable guard.
  const css = readFileSync(join(process.cwd(), 'packages/design-system/theme.css'), 'utf8');

  const tier0 = (selector: string) => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const start = stripped.indexOf(`${selector} {`);
    expect(start, `${selector} block not found`).toBeGreaterThan(-1);
    let depth = 0;
    let end = stripped.indexOf('{', start);
    const open = end;
    for (; end < stripped.length; end += 1) {
      if (stripped[end] === '{') depth += 1;
      else if (stripped[end] === '}' && (depth -= 1) === 0) break;
    }
    return new Set(
      [...stripped.slice(open + 1, end).matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name!),
    );
  };

  it('every Tier-0 token the dark block sets is re-asserted by the light block', () => {
    const dark = tier0("[data-theme='dark']");
    const light = tier0("[data-theme='light']");
    expect([...dark].filter((token) => !light.has(token))).toEqual([]);
  });

  it('and the reverse, so neither block drifts ahead of the other', () => {
    const dark = tier0("[data-theme='dark']");
    const light = tier0("[data-theme='light']");
    expect([...light].filter((token) => !dark.has(token))).toEqual([]);
  });
});
