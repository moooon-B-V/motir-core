// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// Story 8.12 · Subtask MOTIR-3613 — "Sign in with a passkey" on the sign-in
// card's EMAIL step.
//
// The three claims worth pinning, all of which a screenshot review misses:
//
//   1. It is on the EMAIL step and it never reaches the other two. A passkey
//      sign-in mints a session outright, so `step` must never become
//      `'twoFactor'` from this path — and the surrounding file is entirely about
//      a flow that does the opposite, so the symmetric mistake is the likely one.
//   2. It is NOT gated on a filled email field. A discoverable credential is what
//      makes this better than a password, and the form's habit is to gate.
//   3. A dismissed sheet draws NOTHING. Same rule as the settings card, and the
//      natural implementation makes it an alert.

const signInPasskey = vi.fn();
const push = vi.fn();
let search = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => search,
}));

vi.mock('@/lib/auth/client', () => ({
  signIn: {
    email: vi.fn(),
    social: vi.fn(),
    passkey: (...a: unknown[]) => signInPasskey(...a),
  },
}));

import { SignInCard } from '@/app/(auth)/sign-in/_components/SignInCard';

/**
 * `window.location.assign` is what the handler calls on success — a full
 * document load, because the passkey ceremony returns a session and no redirect,
 * and the new cookie has to be visible to the server on the other side.
 */
let assigned: string[] = [];

beforeEach(() => {
  assigned = [];
  search = new URLSearchParams();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign: (url: string) => assigned.push(url) },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function control() {
  return screen.getByRole('button', { name: /sign in with a passkey/i });
}

describe('where the control sits', () => {
  it('renders on the EMAIL step, under the Google button', () => {
    renderWithIntl(<SignInCard />);

    const buttons = screen.getAllByRole('button');
    const google = buttons.findIndex((b) => /continue with google/i.test(b.textContent ?? ''));
    const passkey = buttons.findIndex((b) => /sign in with a passkey/i.test(b.textContent ?? ''));

    expect(google).toBeGreaterThanOrEqual(0);
    expect(passkey).toBe(google + 1);
  });

  it('is enabled with the email field EMPTY', () => {
    renderWithIntl(<SignInCard />);

    // A discoverable credential lets the browser offer the accounts it holds
    // without being told which one to look for. Gating this on a filled field
    // would throw that away for the sake of consistency with the form below it.
    const email = screen.getByLabelText(/email address/i) as HTMLInputElement;
    expect(email.value).toBe('');
    expect((control() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('signing in', () => {
  it('lands at the default destination and never reaches the challenge step', async () => {
    signInPasskey.mockResolvedValue({ data: { session: {}, user: {} }, error: null });
    renderWithIntl(<SignInCard />);

    fireEvent.click(control());

    await waitFor(() => expect(assigned).toEqual(['/home']));
    // The card is still on its email step — no password field, no challenge.
    expect(screen.queryByLabelText(/^password$/i)).toBeNull();
    expect(screen.queryByText(/two-factor/i)).toBeNull();
  });

  it('honours `?next=` — the CLI-connect return', async () => {
    search = new URLSearchParams('next=/device?user_code=ABCD-EFGH');
    signInPasskey.mockResolvedValue({ data: { session: {}, user: {} }, error: null });
    renderWithIntl(<SignInCard />);

    fireEvent.click(control());

    // Read off the `callbackURL` the card already computed — no second
    // destination derivation lives in the passkey path.
    await waitFor(() => expect(assigned).toEqual(['/device?user_code=ABCD-EFGH']));
  });

  it('honours `?draft=` — the onboarding hand-off', async () => {
    search = new URLSearchParams('draft=abc123');
    // The card CLAIMS the draft on mount (a POST to /api/idea-draft/…/claim).
    // Stubbed so this suite makes no network attempt of its own — an unhandled
    // one is noise here and a flake on a CI runner.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    signInPasskey.mockResolvedValue({ data: { session: {}, user: {} }, error: null });
    renderWithIntl(<SignInCard />);

    fireEvent.click(control());

    await waitFor(() => expect(assigned[0]).toContain('/onboarding'));
  });

  it('shows a pending label while the browser sheet is open, and cannot be double-fired', async () => {
    let release: (v: unknown) => void = () => {};
    signInPasskey.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    renderWithIntl(<SignInCard />);

    fireEvent.click(control());

    // A CHANGED label, not just a spinner: a disabled button with the same words
    // is the state a reader clicks twice.
    await waitFor(() => expect(screen.getByText(/waiting for your browser/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /waiting for your browser/i }));
    expect(signInPasskey).toHaveBeenCalledTimes(1);

    release({ data: { session: {}, user: {} }, error: null });
  });
});

describe('the two refusals take opposite shapes', () => {
  it('draws NOTHING when the reader dismisses the sheet', async () => {
    signInPasskey.mockResolvedValue({
      data: null,
      error: { code: 'AUTH_CANCELLED', message: 'x', status: 400, statusText: 'x' },
    });
    renderWithIntl(<SignInCard />);

    fireEvent.click(control());

    await waitFor(() => expect(signInPasskey).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(assigned).toEqual([]);
  });

  it('draws nothing for the ceremony-level cancel code either', async () => {
    // The other code space: SimpleWebAuthn's, surfaced verbatim by the plugin's
    // client. Reading only `AUTH_CANCELLED` is how this arm turns red.
    signInPasskey.mockResolvedValue({
      data: null,
      error: { code: 'ERROR_CEREMONY_ABORTED', message: 'x', status: 400, statusText: 'x' },
    });
    renderWithIntl(<SignInCard />);

    fireEvent.click(control());

    await waitFor(() => expect(signInPasskey).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names the way THROUGH when no passkey here matches an account', async () => {
    signInPasskey.mockResolvedValue({
      data: null,
      error: { code: 'PASSKEY_NOT_FOUND', message: 'x', status: 404, statusText: 'x' },
    });
    renderWithIntl(<SignInCard />);

    fireEvent.click(control());

    const alert = await screen.findByRole('alert');
    // A reader stuck on this screen needs the next step more than the diagnosis.
    expect(alert.textContent).toMatch(/email and password/i);
    expect(assigned).toEqual([]);
  });

  it('says to try again when the challenge window lapsed', async () => {
    signInPasskey.mockResolvedValue({
      data: null,
      error: { code: 'CHALLENGE_NOT_FOUND', message: 'x', status: 400, statusText: 'x' },
    });
    renderWithIntl(<SignInCard />);

    fireEvent.click(control());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/started over/i);
  });

  it('falls through to the no-match copy when the failure carries no code', async () => {
    signInPasskey.mockResolvedValue({ data: null, error: { message: 'network', status: 500 } });
    renderWithIntl(<SignInCard />);

    fireEvent.click(control());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/email and password/i);
  });

  it('RECOVERS after every refusal — the button must not stay pending', async () => {
    // ⚠️ THE REGRESSION THIS PINS SHIPPED ONCE. An early `return` on the refusal
    // path left the control reading "Waiting for your browser…" for ever, so a
    // reader who dismissed the sheet could never try again. The
    // cannot-be-double-fired test above was GREEN throughout, because a
    // permanently-pending button cannot be fired at all — it took the E2E to
    // catch it. Both refusal shapes are driven here so neither can regress
    // alone.
    for (const error of [
      { code: 'AUTH_CANCELLED', message: 'x', status: 400, statusText: 'x' },
      { code: 'PASSKEY_NOT_FOUND', message: 'x', status: 404, statusText: 'x' },
    ]) {
      signInPasskey.mockResolvedValue({ data: null, error });
      const view = renderWithIntl(<SignInCard />);

      fireEvent.click(control());

      await waitFor(() => expect(signInPasskey).toHaveBeenCalled());
      // Back to its idle LABEL, which is what a reader sees, and clickable again.
      await waitFor(() => expect(screen.getByText(/sign in with a passkey/i)).toBeTruthy());
      expect(screen.queryByText(/waiting for your browser/i)).toBeNull();

      signInPasskey.mockClear();
      fireEvent.click(control());
      await waitFor(() => expect(signInPasskey).toHaveBeenCalledTimes(1));

      view.unmount();
      vi.clearAllMocks();
    }
  });

  it('survives a thrown ceremony and stays clickable', async () => {
    signInPasskey.mockRejectedValue(new Error('boom'));
    renderWithIntl(<SignInCard />);

    fireEvent.click(control());

    await screen.findByRole('alert');
    // The pending flag is released on the throw, so a second attempt is possible.
    expect((control() as HTMLButtonElement).disabled).toBe(false);
  });
});
