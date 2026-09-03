// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { WAVE_BAND_PATH } from '@/components/brand/waveBand';

// MOTIR-1150 — every surface the mark enters (design/brand/design-notes.md §7),
// asserted at the altitude the design's own findings live at.
//
// The three findings the 8.3.1 renders produced are the three things most likely
// to be undone by a later edit, so each gets a case that names it:
//
//   §7d  PublicTopBar's left tile is the PROJECT's initial and is left alone;
//        the brand gets its own quiet slot on the right.
//   §7b  The auth lockup lives in the LAYOUT, so all five screens inherit it —
//        and is suppressed on the one screen whose fold budget is measured.
//
// ── ⚠️ §7c IS NOT ASSERTED HERE ANY MORE (MOTIR-4103) ──────────────────────
// It used to be, over `ExploreTopBar` — the marketing chrome's bar, and once
// the ONLY shipped brand lockup in this repository. That component is deleted:
// it survived MOTIR-3951 solely because `app/(public)/legal/`'s layout still
// imported it, and this card deletes that layout with the rest of the legal
// route, leaving the bar with no caller at all.
//
// The case is REMOVED rather than re-pointed because its subject left the
// repository rather than moved within it. The marketing bar is
// `motir-marketing`'s `app/_components/SiteHeader.tsx`, which renders
// `<BrandMark size={26} label="Motir" />` from `@motir/brand` and is covered by
// that repository's own `tests/siteHeader.test.tsx`; the MARK itself is
// asserted against `brand.css` in `packages/brand/test/`
// (`docs/decisions/brand-asset-distribution.md`). Nothing this case guarded is
// left unguarded in the place that now ships it.
//
// §7b and §7d below are untouched: `AuthLayout` and `PublicTopBar` are both
// still this application's.
//
// The server translator is mocked to echo keys, the pattern
// `public-top-bar.test.tsx` already uses for these async server components.

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/p/MOTIR',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/auth/client', () => ({
  signOut: vi.fn(),
  signIn: { email: vi.fn(), social: vi.fn() },
  signUp: { email: vi.fn() },
}));

import AuthLayout from '@/app/(auth)/layout';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AuthLayout — one lockup, five screens, one measured exception (§7b)', () => {
  it('renders the lockup for an ordinary auth page', async () => {
    const { container } = render(await AuthLayout({ children: <div>sign in form</div> }));
    const home = container.querySelector('a[href="/"]')!;
    expect(home.getAttribute('data-brand-lockup')).not.toBeNull();
    expect(home.querySelector('path')!.getAttribute('d')).toBe(WAVE_BAND_PATH);
    expect(home.textContent).toBe('brand');
  });

  it('carries the suppression selector the wide /device screen relies on', async () => {
    // The lockup is 28px and this column's gap-8 is 32px: 60px against 26px of
    // measured headroom on /device's confirm screen. `display:none` is what
    // removes the gap too, so the wide screen stays byte-identical to what it
    // measured at — and the rule is one arbitrary selector rather than a stacked
    // has-…:[&_…] pair, so what it compiles to is not in doubt.
    const { container } = render(await AuthLayout({ children: <div data-auth-wide>confirm</div> }));
    const card = container.querySelector('[data-brand-lockup]')!.parentElement!;
    expect(card.className).toContain('[&:has([data-auth-wide])_[data-brand-lockup]]:hidden');
    expect(card.className).toContain('gap-8');
  });

  it('keeps the lockup in the LAYOUT so every auth screen inherits one', async () => {
    // §7b: not per page. A page that wanted its own would be the drift this
    // guards — the layout is the single place the brand enters the auth column.
    for (const children of [<div key="a">sign up</div>, <div key="b">reset</div>]) {
      const { container } = render(await AuthLayout({ children }));
      expect(container.querySelectorAll('[data-brand-lockup]')).toHaveLength(1);
      cleanup();
    }
  });
});
