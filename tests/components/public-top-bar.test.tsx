// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// PublicTopBar (MOTIR-990) is an async server component with an auth-aware right
// slot: a signed-in visitor sees the account menu (design Panel 1b); a logged-out
// visitor sees Sign in / Start free. As of MOTIR-1558 those two CTAs are BUTTONS
// that open the in-place sign-in / sign-up modal (`PublicAuthDialog`) rather than
// full-page <Link>s to /sign-in · /sign-up — the visitor authenticates without
// leaving the public page. This test asserts the auth-aware branch (buttons vs.
// account menu); the modal interactions live in public-auth-dialog.test.tsx.
//
// We render the component's resolved tree directly. The server translator is
// mocked to echo keys; the client child reads the real en catalog via the intl
// provider (renderWithIntl), so its button labels are the real strings.
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

import { PublicTopBar } from '@/app/(public)/_components/PublicTopBar';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const base = { name: 'Motir', identifier: 'MOTIR', workspaceName: 'moooon' };

describe('PublicTopBar auth-aware slot (MOTIR-990 · MOTIR-1558)', () => {
  it('logged out: Sign in / Start free are in-place modal buttons, not navigation links', async () => {
    render(await PublicTopBar({ ...base, user: null }));

    // The CTAs are buttons (they open the modal in place), not <a> links to
    // /sign-in · /sign-up. Regression guard against reverting to full-page nav.
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start free' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Start free' })).toBeNull();
    // No account menu for an anonymous visitor.
    expect(screen.queryByRole('button', { name: 'Account menu' })).toBeNull();
  });

  it('signed in: shows the account menu, not Sign in / Start free', async () => {
    render(await PublicTopBar({ ...base, user: { name: 'Zhu Yue', email: 'yue@example.com' } }));

    expect(screen.getByRole('button', { name: 'Account menu' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start free' })).toBeNull();
  });
});
