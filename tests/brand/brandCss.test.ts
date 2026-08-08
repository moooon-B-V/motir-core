import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-1150 — the structural guard for the brand lockup's CSS
// (`app/globals.css`'s `.brand-*` block, copied from design-notes.md §3).
//
// ── WHY THIS IS A TEST AND NOT A CODE REVIEW ────────────────────────────────
// The type pin is the one requirement on this card that LOOKS CORRECT WHEN IT
// IS WRONG. A wordmark reading `var(--font-sans)` renders in Inter under the
// default type pairing — identical to the correct code — and only re-letters
// itself once a user picks `motir-mono`, `grotesk` or `mono-technical` in
// Appearance. That is exactly how the defect got into the shipped ExploreTopBar
// and survived every design pass over that bar. No reviewer catches it by eye,
// so it gets a machine.
//
// The block is also read for the colour rule: the mark follows the theme and a
// data-palette swap only because every colour in it is a Tier-3 --el-* token.

const CSS = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');

/** The `.brand-*` rules, comments stripped — prose must not satisfy a guard. */
const BRAND_CSS = (() => {
  const start = CSS.indexOf('.brand-lockup');
  expect(start, 'app/globals.css should carry the .brand-* block').toBeGreaterThan(-1);
  return CSS.slice(start).replace(/\/\*[\s\S]*?\*\//g, '');
})();

function rule(selector: string): string {
  const match = BRAND_CSS.match(new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
  expect(match, `expected a ${selector} rule`).not.toBeNull();
  return match![1]!;
}

describe('the type pin (§3) — the raw FACE variable, never the ROLE token', () => {
  const word = rule('.brand-word');

  it('names --font-sans-source', () => {
    expect(word).toMatch(/font-family:[\s\S]*var\(--font-sans-source/);
  });

  it('never names --font-sans, which three [data-type] blocks re-point', () => {
    // `--font-sans-source` legitimately CONTAINS the substring `--font-sans`, so
    // the check is for a var() reference that ENDS there.
    expect(word).not.toMatch(/var\(--font-sans[,)\s]/);
  });

  it('is the weight and tracking the design pins', () => {
    expect(word).toMatch(/font-weight:\s*700/);
    expect(word).toMatch(/letter-spacing:\s*-0\.02em/);
  });
});

describe('every dimension derives from --brand-size (§3)', () => {
  it('computes the gap, the wordmark size and the stacked rhythm from it', () => {
    expect(rule('.brand-lockup')).toMatch(/gap:\s*calc\(var\(--brand-size[^)]*\)\s*\*\s*0\.33\)/);
    expect(rule('.brand-word')).toMatch(
      /font-size:\s*calc\(var\(--brand-size[^)]*\)\s*\*\s*0\.72\)/,
    );
    expect(rule('.brand-stacked')).toMatch(/gap:\s*calc\(var\(--brand-size[^)]*\)\s*\*\s*0\.22\)/);
  });
});

describe('colour routes through Tier-3 element tokens (§4)', () => {
  it('paints the glyph --el-accent-on-surface, not --el-accent', () => {
    // The two are the same colour in light and diverge in dark, where
    // --el-accent is the darker FILL built to carry white ink and loses 0.8 of a
    // contrast point as a glyph. This is what makes the dark variant a token
    // choice rather than a second asset.
    expect(rule('.brand-glyph')).toContain('var(--el-accent-on-surface)');
    expect(rule('.brand-glyph')).not.toMatch(/var\(--el-accent[,)\s]/);
  });

  it('reverses BOTH halves to --el-accent-text on a filled accent field', () => {
    expect(BRAND_CSS).toMatch(
      /\.brand-inv \.brand-glyph,\s*\.brand-inv \.brand-word\s*\{[^}]*var\(--el-accent-text\)/,
    );
  });

  it('never names --el-text-inverted, which disappears on the page in light mode', () => {
    // §4's third rule: --el-text-inverted is var(--color-background) — white in
    // light — so a mark painted with it vanishes on the page background. The ink
    // FOR a filled field is --el-accent-text.
    expect(BRAND_CSS).not.toContain('--el-text-inverted');
  });

  it('invents no colour — every value is a token, never a hex or a named colour', () => {
    const colours = BRAND_CSS.match(/color:\s*([^;]+);/g) ?? [];
    expect(colours.length).toBeGreaterThan(3);
    for (const decl of colours) {
      expect(decl, decl).toMatch(/var\(--el-/);
      expect(decl, decl).not.toMatch(/#[0-9a-f]{3,8}|rgb|hsl/i);
    }
  });
});
