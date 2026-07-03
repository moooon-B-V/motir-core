// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// Component tests for the in-place sign-in / sign-up modal (MOTIR-1558 · design
// gate MOTIR-1557). The dialog wraps the shipped two-step auth flow; here we
// assert the launch-by-mode, the email→password advance, the success path
// (close + router.refresh with the correct callbackURL, NO navigation), the
// unified wrong-password inline error, the sign-up create-account call, the
// Google-social call, and the in-place mode switch. happy-dom + mocked auth
// client (the real-DB auth flow is covered elsewhere; this is pure UI wiring).

const signInEmail = vi.fn();
const signInSocial = vi.fn();
const signUpEmail = vi.fn();
const refresh = vi.fn();

vi.mock('@/lib/auth/client', () => ({
  signIn: {
    email: (...args: unknown[]) => signInEmail(...args),
    social: (...args: unknown[]) => signInSocial(...args),
  },
  signUp: { email: (...args: unknown[]) => signUpEmail(...args) },
  signOut: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/p/MOTIR',
}));

import { PublicAuthDialog } from '@/app/(public)/_components/PublicAuthDialog';

const CALLBACK = '/p/MOTIR';

function renderDialog() {
  return renderWithIntl(<PublicAuthDialog callbackPath={CALLBACK} />);
}

beforeEach(() => {
  signInEmail.mockResolvedValue({ data: {}, error: null });
  signInSocial.mockResolvedValue({ data: {}, error: null });
  signUpEmail.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function openSignIn() {
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}
function openStartFree() {
  fireEvent.click(screen.getByRole('button', { name: 'Start free' }));
}

async function advanceToPassword(email = 'jordan@acme.co') {
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: email } });
  // The step-1 primary CTA is "Continue".
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByLabelText('Password');
}

describe('PublicAuthDialog (MOTIR-1558)', () => {
  it('is closed initially — the auth heading is not in the document', () => {
    renderDialog();
    expect(screen.queryByText('Welcome back!')).toBeNull();
    expect(screen.queryByText('Welcome to Motir!')).toBeNull();
  });

  it('opens in sign-in mode from "Sign in"', async () => {
    renderDialog();
    openSignIn();
    expect(await screen.findByText('Welcome back!')).toBeTruthy();
    expect(screen.queryByText('Welcome to Motir!')).toBeNull();
  });

  it('opens in sign-up mode from "Start free"', async () => {
    renderDialog();
    openStartFree();
    expect(await screen.findByText('Welcome to Motir!')).toBeTruthy();
    expect(screen.queryByText('Welcome back!')).toBeNull();
  });

  it('advances email → password (two-step) and recaps the email', async () => {
    renderDialog();
    openSignIn();
    await screen.findByText('Welcome back!');
    await advanceToPassword();
    // Password step: recap + Forgot password link + password field.
    expect(screen.getByText('jordan@acme.co')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('sign-in success: calls signIn.email with the callbackURL, then closes + router.refresh (no navigation)', async () => {
    renderDialog();
    openSignIn();
    await screen.findByText('Welcome back!');
    await advanceToPassword();
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(signInEmail).toHaveBeenCalledTimes(1));
    expect(signInEmail.mock.calls[0]![0]).toEqual({
      email: 'jordan@acme.co',
      password: 'hunter2pass',
      callbackURL: CALLBACK,
    });
    // Server-surface refresh (the topbar re-reads the session) — and the modal
    // closes. No push: staying on the public page is the whole point.
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('Welcome back!')).toBeNull());
  });

  it('wrong password: shows the unified inline error and does NOT navigate/refresh', async () => {
    signInEmail.mockResolvedValue({ error: { code: 'INVALID_PASSWORD', message: 'bad' } });
    renderDialog();
    openSignIn();
    await screen.findByText('Welcome back!');
    await advanceToPassword();
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrongpass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText(/Try again, or reset it\./)).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    // Still on the password step — the dialog stays open.
    expect(screen.getByText('Welcome back!')).toBeTruthy();
  });

  it('sign-up success: calls signUp.email then closes + router.refresh', async () => {
    renderDialog();
    openStartFree();
    await screen.findByText('Welcome to Motir!');
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'new@acme.co' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByLabelText('Password');
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'longenough1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(signUpEmail).toHaveBeenCalledTimes(1));
    expect(signUpEmail.mock.calls[0]![0]).toMatchObject({
      email: 'new@acme.co',
      password: 'longenough1',
      callbackURL: CALLBACK,
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('Google button calls signIn.social with { provider: "google", callbackURL }', async () => {
    renderDialog();
    openSignIn();
    await screen.findByText('Welcome back!');
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));

    await waitFor(() => expect(signInSocial).toHaveBeenCalledTimes(1));
    expect(signInSocial.mock.calls[0]![0]).toEqual({
      provider: 'google',
      callbackURL: CALLBACK,
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('cross-link switches sign-in → sign-up IN PLACE (no navigation)', async () => {
    renderDialog();
    openSignIn();
    await screen.findByText('Welcome back!');
    // "Don't have an account? Sign up"
    fireEvent.click(screen.getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByText('Welcome to Motir!')).toBeTruthy();
    expect(screen.queryByText('Welcome back!')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});
