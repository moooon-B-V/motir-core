// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { WAVE_BAND_PATH } from '@/components/brand/waveBand';
import { PlanWithAIFab } from '@/components/planning/PlanWithAIFab';
import { DiscoveryChatRail } from '@/components/onboarding/DiscoveryChatRail';
import type { ChatTurn } from '@/lib/onboarding/discoveryLoop';

// ⚠️ THE PLANNING DOORS READ THE ADDRESS (MOTIR-4730). Every surface that mounts
// one — and this tree mounts one — now calls `usePathname` / `useSearchParams`,
// because the workspace opens OVER the page you are on rather than navigating to
// `/planning`. Outside a router context the real hooks return `null` and the
// door throws on its first render, so the mock is no longer optional here.
const nav = vi.hoisted(() => ({
  pathname: '/dashboard',
  searchParams: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.searchParams,
}));

// MOTIR-3185 — the three product surfaces that wore a MOCK letter `M` now wear
// the real Motir mark. Every one of them COMPOSES `BrandMark variant="mark"`;
// none re-declares the path, which is why the tell asserted here is
// `WAVE_BAND_PATH` itself — a site that inlined its own `<svg>` would drift from
// this constant the next time the glyph is refined, and fail loudly.
//
// The plan-change rail's own assertion lives with its state suite
// (`plan-change-planner-turn.test.tsx`), which already owns the fixture that
// renders an assistant turn; the source guard at the bottom covers all three.

afterEach(cleanup);

const CHAT_RAIL_PROPS = {
  turns: [{ id: 't1', role: 'assistant', text: 'Who is it for?' }] as ChatTurn[],
  working: null,
  isStreaming: false,
  pendingAsk: null,
  canSkip: false,
  error: null,
  draft: '',
  onDraftChange: vi.fn(),
  onSend: vi.fn(),
  onDismissError: vi.fn(),
};

describe('the orb', () => {
  it('wears the mark at the 26px glyph box the 56px circle specifies', () => {
    const { container } = renderWithIntl(<PlanWithAIFab />);

    const svg = container.querySelector('button svg.brand-glyph')!;
    expect(svg.querySelector('path')!.getAttribute('d')).toBe(WAVE_BAND_PATH);
    expect(svg.getAttribute('width')).toBe('26');
    expect(svg.getAttribute('height')).toBe('26');
    expect(screen.queryByText('M')).toBeNull();
  });

  it('inverts the glyph, because it sits on an accent FILL', () => {
    // `.brand-glyph` carries its OWN ink (`--el-accent-on-surface`), which wins
    // over whatever the orb inherited — so without `brand-inv` the mark renders
    // accent-on-accent and effectively vanishes. This is the guard on that.
    const { container } = renderWithIntl(<PlanWithAIFab />);

    expect(container.querySelector('.brand-inv svg.brand-glyph')).not.toBeNull();
  });

  it('keeps the accessible name on the BUTTON, and the glyph decorative', () => {
    const { container } = renderWithIntl(<PlanWithAIFab />);

    // Byte-identical to what shipped: the mark is a visual swap, not a
    // relabelling — two E2E specs locate the orb by this exact name.
    expect(screen.getByRole('button', { name: 'Motir AI' })).toBeTruthy();
    expect(container.querySelector('svg.brand-glyph')!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('the discovery rail avatar', () => {
  it('wears the same mark, at the 13px box the 28px avatar specifies', () => {
    const { container } = renderWithIntl(<DiscoveryChatRail {...CHAT_RAIL_PROPS} />);

    const svg = container.querySelector('svg.brand-glyph')!;
    expect(svg.querySelector('path')!.getAttribute('d')).toBe(WAVE_BAND_PATH);
    expect(svg.getAttribute('width')).toBe('13');
    expect(svg.getAttribute('height')).toBe('13');
    expect(container.querySelector('.brand-inv svg.brand-glyph')).not.toBeNull();
    expect(screen.queryByText('M')).toBeNull();
  });

  it('no longer reads an `assistantInitial` from the catalog', () => {
    // The key is DELETED from both locales, not merely unreferenced — a
    // dangling `t('assistantInitial')` would throw here rather than render.
    renderWithIntl(<DiscoveryChatRail {...CHAT_RAIL_PROPS} />);

    for (const locale of ['en', 'zh'] as const) {
      const catalog = readFileSync(`messages/${locale}.json`, 'utf8');
      expect(catalog).not.toContain('assistantInitial');
    }
  });
});

/** `source` with its `//` and block comments removed. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('the retirement of the mock letter', () => {
  const SITES = [
    'components/planning/PlanWithAIFab.tsx',
    'components/planning/PlanChangeRail.tsx',
    'components/onboarding/DiscoveryChatRail.tsx',
  ];

  it.each(SITES)('%s composes BrandMark and renders no bare `M`', (site) => {
    const source = readFileSync(site, 'utf8');

    expect(source).toContain("from '@/components/brand/BrandMark'");
    expect(source).toContain('variant="mark"');
    // The path belongs to `waveBand.ts` alone — a second declaration of it is
    // exactly the drift this card exists to remove.
    expect(code(source)).not.toContain('<svg');
    // A JSX text node or a string literal that is just the letter. Prose is
    // stripped first, so a comment recalling the mock's history is allowed to
    // say `M` — it is what the surface RENDERS that this asserts on.
    expect(code(source)).not.toMatch(/(>M<|'M'|"M")/);
  });
});
