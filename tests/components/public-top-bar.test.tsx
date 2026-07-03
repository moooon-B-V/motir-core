// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// PublicTopBar (MOTIR-990) is an async server component with an auth-aware right
// slot: a signed-in visitor sees the account menu (design Panel 1b); a logged-out
// visitor sees Sign in / Start free, each carrying `?next=` back to THIS public
// page so authenticating returns them here instead of /dashboard (#3 + #4).
//
// We render the component's resolved tree directly. The server translator is
// mocked to echo keys (we assert on hrefs + the account affordance, not copy);
// UserMenu is a client island, so its runtime deps are stubbed.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/p/MOTIR',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/auth/client', () => ({ signOut: vi.fn() }));

import { PublicTopBar } from '@/app/(public)/_components/PublicTopBar';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const base = { name: 'Motir', identifier: 'MOTIR', workspaceName: 'moooon' };

describe('PublicTopBar auth-aware slot (MOTIR-990)', () => {
  it('logged out: Sign in / Start free carry ?next back to this public page', async () => {
    render(await PublicTopBar({ ...base, user: null }));

    const signIn = screen.getByRole('link', { name: 'signIn' });
    const startFree = screen.getByRole('link', { name: 'startFree' });
    // Return-to-this-page: ?next=/p/MOTIR (encoded). Regression guard: sign in →
    // /sign-in, start free → /sign-up (not the login page).
    expect(signIn.getAttribute('href')).toBe('/sign-in?next=%2Fp%2FMOTIR');
    expect(startFree.getAttribute('href')).toBe('/sign-up?next=%2Fp%2FMOTIR');
    // No account menu for an anonymous visitor.
    expect(screen.queryByRole('button', { name: 'Account menu' })).toBeNull();
  });

  it('signed in: shows the account menu, not Sign in / Start free', async () => {
    render(await PublicTopBar({ ...base, user: { name: 'Zhu Yue', email: 'yue@example.com' } }));

    expect(screen.getByRole('button', { name: 'Account menu' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'signIn' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'startFree' })).toBeNull();
  });
});
