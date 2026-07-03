import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// The app-facing import surface (re-export shims that forward to the package,
// MOTIR-1527) — this is the path ~500 `@/lib/theme/…` call sites resolve.
import {
  PALETTE_IDS,
  STYLE_IDS,
  TYPE_IDS,
  DEFAULT_PALETTE_ID,
  DEFAULT_STYLE_ID,
  DEFAULT_TYPE_ID,
  STYLE_DEFAULT_TYPE,
} from '@/lib/theme/palettes';

// MOTIR-1530 — Parity guard (motir-core side).
//
// After the design system was EXTRACTED into `@motir/design-system` (1526) and
// motir-core rewired to consume it (1527), nothing but a test guarantees the
// package a consumer actually PULLS IN still carries what the shipped surfaces
// expect. This is that lightweight guard against silent drift: it reads the
// token CSS + registries THROUGH the consumption path (the node_modules copy and
// the `@/lib/theme/*` shims), not the in-repo package source, and pins them to
// the documented contract. If a later package change trimmed a contract token or
// an axis id, motir-core's build would stay green (Tailwind ignores an absent
// custom property) while surfaces silently lose their colour/shape — this fails
// loudly instead.

// The token CSS exactly as motir-core resolves it (its globals.css `@import`s
// this specifier).
const CONSUMED_THEME_CSS = readFileSync(
  join(process.cwd(), 'node_modules/@motir/design-system/theme.css'),
  'utf8',
);

describe('consumed token layer carries the documented contract', () => {
  it('defines the Tier-3 `--el-*` colour contract the primitives bind to', () => {
    // The colour half of motir-core/CLAUDE.md's frozen token map. Each of these
    // is referenced by a shipped primitive / surface; a dropped one is drift.
    const EL_CONTRACT = [
      '--el-text',
      '--el-text-strong',
      '--el-text-secondary',
      '--el-text-muted',
      '--el-text-inverted',
      '--el-accent',
      '--el-accent-text',
      '--el-accent-pressed',
      '--el-accent-on-surface',
      '--el-highlight',
      '--el-surface',
      '--el-surface-soft',
      '--el-muted',
      '--el-border',
      '--el-border-soft',
      '--el-border-strong',
      '--el-link',
      '--el-link-pressed',
      '--el-danger',
      '--el-danger-text',
      '--el-success',
      '--el-warning',
      '--el-info',
      '--el-type-epic',
      '--el-type-story',
      '--el-type-task',
      '--el-type-bug',
      '--el-type-subtask',
    ];
    for (const token of EL_CONTRACT) {
      expect(CONSUMED_THEME_CSS, `consumed theme.css must DEFINE ${token}`).toMatch(
        new RegExp(`\\${token}\\s*:`),
      );
    }
  });

  it('defines the element-semantic SHAPE contract the style axis swaps', () => {
    const SHAPE_CONTRACT = [
      '--radius-btn',
      '--radius-card',
      '--radius-input',
      '--radius-modal',
      '--radius-badge',
      '--radius-control',
      '--radius-kbd',
      '--spacing-btn-x',
      '--spacing-card-padding',
      '--spacing-control-x',
      '--spacing-chip-x',
      '--height-btn-md',
      '--height-input',
      '--height-control',
      '--shadow-subtle',
      '--shadow-card',
      '--shadow-modal',
    ];
    for (const token of SHAPE_CONTRACT) {
      expect(CONSUMED_THEME_CSS, `consumed theme.css must DEFINE ${token}`).toMatch(
        new RegExp(`\\${token}\\s*:`),
      );
    }
  });

  it('ships the three swap-axis selector layers (a consumer skins/reshapes via these)', () => {
    expect(CONSUMED_THEME_CSS).toMatch(/@theme\s*\{/);
    expect(CONSUMED_THEME_CSS).toContain('[data-palette=');
    expect(CONSUMED_THEME_CSS).toContain('[data-style=');
    expect(CONSUMED_THEME_CSS).toContain('[data-type=');
  });
});

describe('consumed registries match the app-facing contract (no divergence after extraction)', () => {
  it('exposes the frozen v1 palette set with Motir as the default', () => {
    // The exact id set motir-core's Appearance picker + init script render. A
    // trimmed/renamed id here would break those surfaces silently.
    expect(PALETTE_IDS).toEqual([
      'motir',
      'cobalt',
      'graphite',
      'evergreen',
      'spectrum',
      'amber',
      'sienna',
      'garnet',
      'citrine',
      'candy',
    ]);
    expect(DEFAULT_PALETTE_ID).toBe('motir');
    expect(PALETTE_IDS).toContain(DEFAULT_PALETTE_ID);
  });

  it('keeps the style + type axes coherent with their documented defaults', () => {
    expect(STYLE_IDS).toContain(DEFAULT_STYLE_ID);
    expect(DEFAULT_STYLE_ID).toBe('warm-editorial');
    expect(TYPE_IDS).toContain(DEFAULT_TYPE_ID);
    expect(DEFAULT_TYPE_ID).toBe('motir');
  });

  it('gives every style a registered default type (the style→type precedence source)', () => {
    for (const styleId of STYLE_IDS) {
      expect(TYPE_IDS).toContain(STYLE_DEFAULT_TYPE[styleId]);
    }
  });

  it('every non-default palette ships a `[data-palette]` override block in the consumed CSS', () => {
    // The registry id set and the CSS override blocks must agree — a palette in
    // the registry with no CSS block would render as the base palette (drift the
    // registry alone can't catch).
    for (const id of PALETTE_IDS) {
      if (id === DEFAULT_PALETTE_ID) continue; // base needs no override block
      expect(CONSUMED_THEME_CSS, `missing [data-palette='${id}'] block`).toContain(
        `[data-palette='${id}']`,
      );
    }
  });
});
