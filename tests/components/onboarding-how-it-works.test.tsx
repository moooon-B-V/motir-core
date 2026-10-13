// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// "How Motir works" (MOTIR-8253) — the explainer behind the entrance's "See how
// Motir works" link, drawn to Panel 4 of
// `design/onboarding-entrance/onboarding-entrance--vibe-layout.mock.html`
// (design-notes.md § "2026-10-11" and Revisions 1–2). It replaced the
// `EmptyState` placeholder seam MOTIR-1462 shipped. The page is a server
// component: awaited here, then rendered with the real `en` catalogue on both
// halves (`getTranslations` through next-intl's own `createTranslator`, the
// client islands through `renderWithIntl`), so the assertions read production
// copy. Only `getSession` and `redirect` are mocked (the repo's one allowed
// session mock, and the redirect throw the workspace-security pane test uses).

const { getSession, redirect } = vi.hoisted(() => ({
  getSession: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession,
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
  };
});
// The brand bar's language control calls the `setLocale` server action.
vi.mock('@/lib/i18n/actions', () => ({ setLocale: vi.fn() }));

import OnboardingHowItWorksPage from '@/app/(onboarding)/onboarding/how-it-works/page';
import { WAVE_BAND_PATH } from '@/components/brand/waveBand';

const SESSION = { user: { id: 'u1', email: 'a@example.com', name: 'A' } };

async function renderPage() {
  const ui = await OnboardingHowItWorksPage();
  return renderWithIntl(ui);
}

beforeEach(() => {
  getSession.mockResolvedValue(SESSION);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  getSession.mockReset();
  redirect.mockClear();
});

describe('the how-it-works page', () => {
  it('sends a signed-out visitor to sign in, returning here', async () => {
    getSession.mockResolvedValue(null);
    await expect(OnboardingHowItWorksPage()).rejects.toThrow(
      'NEXT_REDIRECT:/sign-in?next=%2Fonboarding%2Fhow-it-works',
    );
    expect(redirect).toHaveBeenCalledWith('/sign-in?next=%2Fonboarding%2Fhow-it-works');
  });

  it('heads with the brand bar: the Motir lockup linked home, and the language control', async () => {
    const { container } = await renderPage();
    const bar = container.querySelector('header[data-onboarding-brand-bar]')!;
    expect(bar).not.toBeNull();
    const home = screen.getByRole('link', { name: 'Motir' });
    expect(bar.contains(home)).toBe(true);
    expect(home.getAttribute('href')).toBe('/');
    expect(home.querySelector('.brand-lockup svg path')!.getAttribute('d')).toBe(WAVE_BAND_PATH);
    expect(bar.contains(screen.getByRole('combobox'))).toBe(true);
  });

  it('renders the hero — the title as the one h1, and the body as its lede', async () => {
    const { container } = await renderPage();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe('AI does the work. You make the calls.');
    const hero = container.querySelector('section[data-onboarding-hero]')!;
    expect(hero.contains(h1s[0]!)).toBe(true);
    expect(
      hero.contains(
        screen.getByText(
          'You bring the idea. Motir asks until it understands, then makes the plan, the design, the product and the documents step by step, out in the open, and stops wherever a choice is yours.',
        ),
      ),
    ).toBe(true);
  });

  it('renders the three section bands in order, each with its wordless drawing on its own tint', async () => {
    const { container } = await renderPage();
    const bands = [...container.querySelectorAll('section[data-section-band]')];
    expect(bands.map((b) => b.querySelector('h2')!.textContent)).toEqual([
      'Say what you want',
      'Watch it take shape',
      'You decide',
    ]);
    screen.getByText('A few sentences or a messy brain dump. Motir asks until it understands.');

    const arts = bands.map((b) => b.querySelector('[data-section-art]')!);
    expect(arts.map((a) => a.getAttribute('data-section-art'))).toEqual(['say', 'watch', 'decide']);
    expect(arts.map((a) => a.getAttribute('aria-hidden'))).toEqual(['true', 'true', 'true']);
    const tints = arts.map((a) => /bg-\((--el-tint-[a-z]+)\)/.exec(a.className)?.[1]);
    expect(tints).toEqual(['--el-tint-sky', '--el-tint-lavender', '--el-tint-peach']);
    // Wordless: no text inside any drawing.
    for (const a of arts) expect(a.textContent!.trim()).toBe('');
  });

  it('links out to motir.co/how-it-works in a new tab', async () => {
    await renderPage();
    const field = screen.getByRole('region', { name: 'How Motir works, for developers' });
    expect(field.getAttribute('data-showcase')).toBe('field');
    const cta = screen.getByRole('link', { name: /read it on motir\.co/i });
    expect(field.contains(cta)).toBe(true);
    expect(cta.getAttribute('href')).toBe('https://motir.co/how-it-works');
    expect(cta.getAttribute('target')).toBe('_blank');
    expect(cta.getAttribute('rel')).toBe('noopener');
    expect(cta.textContent).toContain('(opens in a new tab)');
  });

  it('is no longer the EmptyState placeholder', async () => {
    const { container } = await renderPage();
    // The seam was `EmptyState` (a Sparkles icon, title, description) with a
    // `<Link><Button>Back</Button></Link>` action in a centred column.
    expect(container.querySelector('section[data-onboarding-hero]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to start' })).toBeNull();
    expect(container.querySelector('a button')).toBeNull();
    expect(container.querySelectorAll('.lucide-sparkles')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('max-w-[41.25rem]');
  });

  describe('Back to start', () => {
    it('links to the entrance, so it works without script', async () => {
      await renderPage();
      const back = screen.getByRole('link', { name: 'Back to start' });
      expect(back.getAttribute('href')).toBe('/onboarding');
      expect(back.hasAttribute('data-closes-tab')).toBe(true);
    });

    it('closes the tab it was opened in', async () => {
      await renderPage();
      const close = vi.spyOn(window, 'close').mockImplementation(() => {});
      vi.spyOn(window, 'closed', 'get').mockReturnValue(true);
      const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
      fireEvent.click(screen.getByRole('link', { name: 'Back to start' }));
      expect(close).toHaveBeenCalledTimes(1);
      expect(assign).not.toHaveBeenCalled();
    });

    it('navigates to the entrance when the tab cannot be closed', async () => {
      await renderPage();
      const close = vi.spyOn(window, 'close').mockImplementation(() => {});
      vi.spyOn(window, 'closed', 'get').mockReturnValue(false);
      const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
      fireEvent.click(screen.getByRole('link', { name: 'Back to start' }));
      expect(close).toHaveBeenCalledTimes(1);
      expect(assign).toHaveBeenCalledWith('/onboarding');
    });

    it('leaves a modified click (open in a new tab) to the browser', async () => {
      await renderPage();
      const close = vi.spyOn(window, 'close').mockImplementation(() => {});
      fireEvent.click(screen.getByRole('link', { name: 'Back to start' }), { metaKey: true });
      expect(close).not.toHaveBeenCalled();
    });
  });
});
