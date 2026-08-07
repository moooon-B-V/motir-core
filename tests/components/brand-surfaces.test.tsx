// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { WAVE_BAND_PATH } from '@/components/brand/waveBand';

// MOTIR-1150 — every surface the mark enters (design/brand/design-notes.md §7),
// asserted at the altitude the design's own findings live at.
//
// The three findings the 8.3.1 renders produced are the three things most likely
// to be undone by a later edit, so each gets a case that names it:
//
//   §7c  ExploreTopBar's tile + letter M becomes the real lockup, and the link
//        KEEPS its accessible name "Motir" — `tests/e2e/acceptance-api-docs.spec.ts`
//        asserts that name, so changing it turns an unrelated E2E red.
//   §7d  PublicTopBar's left tile is the PROJECT's initial and is left alone;
//        the brand gets its own quiet slot on the right.
//   §7b  The auth lockup lives in the LAYOUT, so all five screens inherit it —
//        and is suppressed on the one screen whose fold budget is measured.
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
import { ExploreTopBar } from '@/app/(public)/explore/_components/ExploreTopBar';
import { PublicTopBar } from '@/app/(public)/_components/PublicTopBar';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ExploreTopBar — the tile + letter M becomes the mark (§7c)', () => {
  it('renders the wave band and no letter-M stand-in', async () => {
    const { container } = render(await ExploreTopBar());
    expect(container.querySelector('path')!.getAttribute('d')).toBe(WAVE_BAND_PATH);
    // The old brand tile was a 7x7 --el-accent square bearing a literal "M".
    // It was a placeholder for a mark that did not exist; nothing should now
    // render a bare "M" in this bar.
    expect(screen.queryByText('M')).toBeNull();
  });

  it('keeps the home link named by its visible wordmark, with no aria-label (§8)', async () => {
    const { container } = render(await ExploreTopBar());
    const home = container.querySelector('a[href="/"]')!;
    expect(home.textContent).toBe('brand');
    // "Never both": the glyph is decorative here because the wordmark is beside
    // it, so a label on the link would announce the brand twice.
    expect(home.getAttribute('aria-label')).toBeNull();
    expect(home.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('PublicTopBar — the brand is the HOST, not the subject (§7d)', () => {
  const base = { name: 'Motir', identifier: 'MOTIR', workspaceName: 'moooon' };

  it("leaves the project's own initial tile alone", async () => {
    // The tile renders `name.charAt(0)`. Overwriting it would delete project
    // identity to gain brand, on the page whose whole job is the project.
    const { container } = renderWithIntl(
      await PublicTopBar({ ...base, name: 'Zephyr', user: null }),
    );
    expect(screen.getByText('Z')).toBeTruthy();
    // Scoped to the brand link: this bar also renders the "Building in public"
    // badge's icon, so an unscoped `svg path` would assert against a megaphone.
    expect(container.querySelector('a[href="/"] svg path')!.getAttribute('d')).toBe(WAVE_BAND_PATH);
  });

  it('adds a quiet "on Motir" lockup that reads as one phrase', async () => {
    const { container } = renderWithIntl(await PublicTopBar({ ...base, user: null }));
    const home = container.querySelector('a[href="/"]')!;
    expect(home.textContent).toBe('hostedOnPrefixbrand');
    expect(home.querySelector('.brand-quiet')).not.toBeNull();
    expect(home.getAttribute('aria-label')).toBeNull();
  });

  it('does not disturb the auth-aware slot it sits beside', async () => {
    // Regression guard: the brand slot was added INTO the right cluster, so the
    // CTAs `public-top-bar.test.tsx` pins must still be the only buttons there.
    renderWithIntl(await PublicTopBar({ ...base, user: null }));
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start free' })).toBeTruthy();
  });
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
