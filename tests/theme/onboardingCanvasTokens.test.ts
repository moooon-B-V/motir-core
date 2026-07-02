import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-1277 · 1266.6 — the onboarding / canvas semantic element tokens:
// revision-diff kind chips, the discovery chat bubbles, the planning-canvas
// edges, and the station tier tile. The COMPREHENSIVE per-palette coverage /
// swap-layer matrix is owned by 1266.7; this suite pins THIS card's contract:
// the tokens exist in the Tier-3 base block mapped to the right Tier-0
// --color-* (so every palette re-skins them via its --color-* override), the
// defaults reproduce today's exact hues (zero visual change), and each cited
// consumer now references the dedicated token instead of the borrowed
// --el-tint-* / --el-accent / --el-border it used before. Per
// design/design-system/design-notes.md §H — including the card-correction that
// StationNode gets its OWN --el-station-tier-* family, NOT --el-roadmap-*.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
// The design-system token layer moved into `@motir/design-system/theme.css`
// (MOTIR-1527); app/globals.css now only `@import`s it + keeps app base styles.
// Read the UNION so these runtime-contract assertions see the full token layer.
const GLOBALS_CSS = read('app/globals.css') + read('packages/design-system/theme.css');

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

describe('onboarding / canvas element tokens map to their Tier-0 --color-* base', () => {
  // Every token defaults to today's exact value → zero visual change; mapping to
  // a --color-* is what makes a palette swap reach it (the swap-layer contract).
  const EXPECTED: Record<string, string> = {
    // Revision diff chips (RevisionDiff)
    '--el-diff-added': '--color-tint-mint',
    '--el-diff-removed': '--color-tint-rose',
    '--el-diff-moved': '--color-tint-sky',
    // Discovery chat bubbles (DiscoveryChatRail)
    '--el-chat-bubble-user': '--color-primary-fill',
    '--el-chat-bubble-ai': '--color-surface-soft',
    // Planning canvas edges (PlanningCanvas)
    '--el-canvas-edge-pending': '--color-border',
    '--el-canvas-edge-committed': '--color-hairline-strong',
    // Station tier tile (StationNode) — its OWN family, not --el-roadmap-*
    '--el-station-tier-discovery': '--color-tint-sky',
    '--el-station-tier-vision': '--color-tint-lavender',
    '--el-station-tier-feasibility': '--color-tint-mint',
    '--el-station-tier-validation': '--color-tint-peach',
  };

  it('defines every onboarding/canvas token mapped to its Tier-0 --color-* base', () => {
    for (const [token, base] of Object.entries(EXPECTED)) {
      expect(mappingOf(token), token).toBe(base);
    }
  });

  it('preserves the exact shipped hues (zero visual change vs the borrowed tokens)', () => {
    // The chat bubbles kept --el-accent / --el-surface-soft's bases…
    expect(mappingOf('--el-chat-bubble-user')).toBe(mappingOf('--el-accent'));
    expect(mappingOf('--el-chat-bubble-ai')).toBe(mappingOf('--el-surface-soft'));
    // …the edges kept --el-border / --el-border-strong's bases…
    expect(mappingOf('--el-canvas-edge-pending')).toBe(mappingOf('--el-border'));
    expect(mappingOf('--el-canvas-edge-committed')).toBe(mappingOf('--el-border-strong'));
    // …and every token maps through a --color-* (no Tier-0 leak / hex literal).
    for (const token of Object.keys(EXPECTED)) {
      expect(mappingOf(token), token).toMatch(/^--color-/);
    }
  });

  it('keeps --el-roadmap-* scoped to the public roadmap (the card-correction)', () => {
    // The station tier tokens are a SEPARATE family from the public roadmap.
    expect(mappingOf('--el-station-tier-discovery')).not.toBeNull();
    expect(BASE_BLOCK).toContain('--el-roadmap-submitted');
    expect(mappingOf('--el-station-tier-discovery')).toBe(mappingOf('--el-roadmap-progress'));
  });
});

describe('each cited consumer routes through the dedicated token', () => {
  it('RevisionDiff kind chips use --el-diff-*, never --el-tint-*', () => {
    const src = read('components/onboarding/RevisionDiff.tsx');
    const meta = src.slice(src.indexOf('const KIND_STYLE'), src.indexOf('function KindGlyph'));
    expect(meta).not.toMatch(/bg-\(--el-tint-/);
    for (const t of ['added', 'removed', 'moved']) {
      expect(meta).toContain(`bg-(--el-diff-${t})`);
    }
  });

  it('DiscoveryChatRail bubbles use --el-chat-bubble-*, never --el-accent/--el-surface-soft as the bg', () => {
    const src = read('components/onboarding/DiscoveryChatRail.tsx');
    const bubble = src.slice(src.indexOf('function Bubble'), src.indexOf('function Avatar'));
    expect(bubble).toContain('bg-(--el-chat-bubble-user)');
    expect(bubble).toContain('bg-(--el-chat-bubble-ai)');
    expect(bubble).not.toMatch(/bg-\(--el-accent\)/);
    expect(bubble).not.toMatch(/bg-\(--el-surface-soft\)/);
    // the bubble TEXT roles are unchanged (accent-text on the user fill, text on AI)
    expect(bubble).toContain('text-(--el-accent-text)');
    expect(bubble).toContain('text-(--el-text)');
  });

  it('PlanningCanvas edges use --el-canvas-edge-*, never --el-border*', () => {
    const src = read('components/planning/PlanningCanvas.tsx');
    const edges = src.slice(src.indexOf('canvas-edges'), src.indexOf('canvas-world'));
    expect(edges).toContain('stroke-(--el-canvas-edge-pending)');
    expect(edges).toContain('stroke-(--el-canvas-edge-committed)');
    expect(edges).not.toMatch(/stroke-\(--el-border/);
  });

  it('StationNode tier tile uses --el-station-tier-*, never --el-tint-* / --el-roadmap-*', () => {
    const src = read('components/onboarding/StationNode.tsx');
    const tierTint = src.slice(src.indexOf('const TIER_TINT'), src.indexOf('function isTierKind'));
    for (const tier of ['discovery', 'vision', 'feasibility', 'validation']) {
      expect(tierTint).toContain(`bg-(--el-station-tier-${tier})`);
    }
    expect(tierTint).not.toMatch(/bg-\(--el-tint-/);
    // the whole component never RENDERS the public-roadmap family (a mention in
    // an explanatory comment is fine; a `bg-(--el-roadmap-…)` utility is not)
    expect(src).not.toMatch(/\(--el-roadmap-/);
  });
});
