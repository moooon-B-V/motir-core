import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-1273 · 1266.2 — the new status / priority / semantic-surface element
// tokens, plus the StatusPicker swap-layer fix. The COMPREHENSIVE per-palette
// coverage / swap-layer matrix is owned by 1266.7; this suite pins THIS card's
// contract: the tokens exist in the Tier-3 base block mapped to the right
// Tier-0 --color-* (so every palette re-skins them via its --color-* override),
// and the one true Tier-0 swap-layer violation (StatusPicker) is gone.

const GLOBALS_CSS = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
const STATUS_PICKER = readFileSync(
  join(process.cwd(), 'components/issues/StatusPicker.tsx'),
  'utf8',
);

// The Tier-3 base block (the only place a new --el-* is defined; palettes
// override the underlying --color-*, not the --el-*). It's a flat declaration
// block, so it runs from its selector's `{` to the first `}`.
const BASE_BLOCK = (() => {
  const m = GLOBALS_CSS.match(/:root,\s*\[data-appearance-scope\]\s*\{/);
  expect(m?.index).toBeGreaterThanOrEqual(0);
  const open = m!.index! + m![0].length;
  const close = GLOBALS_CSS.indexOf('}', open);
  expect(close).toBeGreaterThan(open);
  return GLOBALS_CSS.slice(open, close);
})();

function mappingOf(token: string): string | null {
  const m = BASE_BLOCK.match(
    new RegExp(`${token.replace(/[-]/g, '\\-')}:\\s*var\\((--color-[a-z-]+)\\)`),
  );
  return m?.[1] ?? null;
}

describe('status element tokens', () => {
  const EXPECTED: Record<string, string> = {
    '--el-status-todo': '--color-stone',
    '--el-status-in-progress': '--color-info',
    '--el-status-in-review': '--color-primary',
    '--el-status-done': '--color-success',
    '--el-status-blocked': '--color-warning',
    '--el-status-cancelled': '--color-steel',
  };
  it('defines each status token mapped to its Tier-0 --color-* base', () => {
    for (const [token, base] of Object.entries(EXPECTED)) {
      expect(mappingOf(token)).toBe(base);
    }
  });
  it('gives in_review / blocked / cancelled their OWN base (differentiated from their category-mate)', () => {
    expect(mappingOf('--el-status-in-review')).not.toBe(mappingOf('--el-status-in-progress'));
    expect(mappingOf('--el-status-blocked')).not.toBe(mappingOf('--el-status-todo'));
    expect(mappingOf('--el-status-cancelled')).not.toBe(mappingOf('--el-status-done'));
  });
});

describe('priority element tokens', () => {
  const EXPECTED: Record<string, string> = {
    '--el-priority-highest': '--color-destructive',
    '--el-priority-high': '--color-warning',
    '--el-priority-medium': '--color-slate',
    '--el-priority-low': '--color-info',
    '--el-priority-lowest': '--color-stone',
  };
  it('defines each priority token mapped to its Tier-0 --color-* base', () => {
    for (const [token, base] of Object.entries(EXPECTED)) {
      expect(mappingOf(token)).toBe(base);
    }
  });
  it('maps medium and lowest to DISTINCT grey bases (the un-collapse)', () => {
    expect(mappingOf('--el-priority-medium')).toBe('--color-slate');
    expect(mappingOf('--el-priority-lowest')).toBe('--color-stone');
    expect(mappingOf('--el-priority-medium')).not.toBe(mappingOf('--el-priority-lowest'));
  });
});

describe('semantic-surface element tokens', () => {
  const EXPECTED: Record<string, string> = {
    '--el-danger-surface': '--color-tint-rose',
    '--el-danger-surface-text': '--color-charcoal',
    '--el-warning-surface': '--color-tint-peach',
    '--el-warning-text': '--color-charcoal',
    '--el-success-surface': '--color-tint-mint',
    '--el-notice-info-bg': '--color-tint-sky',
    '--el-notice-info-border': '--color-info',
    '--el-callout-bg': '--color-tint-lavender',
    '--el-callout-text': '--color-charcoal',
  };
  it('defines each surface token mapped to its Tier-0 --color-* base', () => {
    for (const [token, base] of Object.entries(EXPECTED)) {
      expect(mappingOf(token)).toBe(base);
    }
  });
});

describe('StatusPicker swap-layer fix (the only true Tier-0 violation)', () => {
  it('no longer references any Tier-0 --color-* token', () => {
    expect(STATUS_PICKER).not.toMatch(/--color-/);
  });
  it('routes the dot through the shared statusDotColor helper', () => {
    expect(STATUS_PICKER).toMatch(/statusDotColor/);
    expect(STATUS_PICKER).not.toMatch(/CATEGORY_VAR/);
  });
});
