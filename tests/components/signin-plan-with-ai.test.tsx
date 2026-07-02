// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// Subtask 7.22.1 / MOTIR-1457 — the "Plan with AI" onboarding door on the login
// surface. A logged-out visitor enters the start-fresh AI planning flow from
// here (the front-door role the relocated marketing hero used to hold). We
// assert the control exists on /sign-in and routes to /onboarding.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// The sign-in form imports the Better-Auth client; stub the piece it calls so the
// component renders in a plain jsdom-less env without real auth wiring.
vi.mock('@/lib/auth/client', () => ({ signIn: { email: vi.fn() } }));

import SignInPage from '@/app/(auth)/sign-in/page';

afterEach(() => {
  cleanup();
});

describe('sign-in "Plan with AI" door (7.22.1)', () => {
  it('renders a "Plan with AI" control that links to /onboarding', () => {
    renderWithIntl(<SignInPage />);

    const link = screen.getByRole('link', { name: /plan with ai/i });
    expect(link.getAttribute('href')).toBe('/onboarding');
  });
});
