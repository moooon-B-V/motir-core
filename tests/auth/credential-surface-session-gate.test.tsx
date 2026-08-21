import { afterEach, describe, expect, it, vi } from 'vitest';

// MOTIR-3372 — the credential surfaces answer the SIGNED-IN visitor too.
//
// `/sign-in` and `/sign-up` were client components with no session read anywhere
// above them, so a reader who was already signed in met a login form for the
// account they were in — and the CLI hand-off (`?next=/device?user_code=…`)
// asked them for a password to reach a page they were already entitled to.
// Both are now server shells over the client card.
//
// Tested the way `tests/onboarding/entry-rework.test.tsx` tests the root route:
// no DOM, no rendering — we call the shell and inspect the `redirect()` it made
// or the element it returned. The card itself is exercised by its own component
// test and by the E2E specs.

class RedirectError extends Error {
  constructor(public to: string) {
    super(`REDIRECT:${to}`);
  }
}
const redirect = vi.fn((to: string) => {
  throw new RedirectError(to);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

const getSession = vi.fn();
vi.mock('@/lib/auth', () => ({ getSession: () => getSession() }));

// Sentinels for the two client islands, so we can assert the shell returned the
// card without rendering a form that reads translations and Better-Auth.
function SignInCardStub() {
  return null;
}
function SignUpCardStub() {
  return null;
}
vi.mock('@/app/(auth)/sign-in/_components/SignInCard', () => ({ SignInCard: SignInCardStub }));
vi.mock('@/app/(auth)/sign-up/_components/SignUpCard', () => ({ SignUpCard: SignUpCardStub }));

import SignInPage from '@/app/(auth)/sign-in/page';
import SignUpPage from '@/app/(auth)/sign-up/page';
import { sanitizeNextPath } from '@/lib/navigation/nextDestination';

const SESSION = { user: { id: 'u1', name: 'Yue', email: 'yue@example.com' } };

afterEach(() => {
  vi.clearAllMocks();
});

describe('/sign-in shell (MOTIR-3372)', () => {
  it('renders the card for a reader with NO session', async () => {
    getSession.mockResolvedValue(null);

    const result = await SignInPage({ searchParams: Promise.resolve({}) });

    expect(result).toMatchObject({ type: SignInCardStub });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('sends a SIGNED-IN reader to /home instead of the form', async () => {
    getSession.mockResolvedValue(SESSION);

    await expect(SignInPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(RedirectError);
    expect(redirect).toHaveBeenCalledWith('/home');
  });

  it('follows ?next= for a signed-in reader — the CLI hand-off costs no re-authentication', async () => {
    getSession.mockResolvedValue(SESSION);

    await expect(
      SignInPage({ searchParams: Promise.resolve({ next: '/device?user_code=ABCD-1234' }) }),
    ).rejects.toThrow(RedirectError);
    expect(redirect).toHaveBeenCalledWith('/device?user_code=ABCD-1234');
  });

  it('refuses an off-origin ?next= and falls back to /home — not an open redirect', async () => {
    getSession.mockResolvedValue(SESSION);

    await expect(
      SignInPage({ searchParams: Promise.resolve({ next: 'https://evil.example/steal' }) }),
    ).rejects.toThrow(RedirectError);
    expect(redirect).toHaveBeenCalledWith('/home');
  });

  it('RENDERS for a signed-in reader when ?draft= is present, so the claim can plant its cookie', async () => {
    getSession.mockResolvedValue(SESSION);

    const result = await SignInPage({
      searchParams: Promise.resolve({ draft: 'draft-abc' }),
    });

    // The card is told a session is active, which is how it knows to move on to
    // /onboarding once the claim settles rather than sit on a login form.
    expect(result).toMatchObject({ type: SignInCardStub, props: { sessionActive: true } });
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe('/sign-up shell (MOTIR-3372)', () => {
  it('renders the card for a reader with NO session', async () => {
    getSession.mockResolvedValue(null);

    const result = await SignUpPage({ searchParams: Promise.resolve({}) });

    expect(result).toMatchObject({ type: SignUpCardStub });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('sends a SIGNED-IN reader to /home — the same destination sign-in uses', async () => {
    getSession.mockResolvedValue(SESSION);

    await expect(SignUpPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(RedirectError);
    expect(redirect).toHaveBeenCalledWith('/home');
  });

  it('follows a safe ?next= and refuses an unsafe one', async () => {
    getSession.mockResolvedValue(SESSION);

    await expect(SignUpPage({ searchParams: Promise.resolve({ next: '/items' }) })).rejects.toThrow(
      RedirectError,
    );
    expect(redirect).toHaveBeenLastCalledWith('/items');

    await expect(
      SignUpPage({ searchParams: Promise.resolve({ next: '//evil.example' }) }),
    ).rejects.toThrow(RedirectError);
    expect(redirect).toHaveBeenLastCalledWith('/home');
  });
});

describe('sanitizeNextPath', () => {
  it('accepts a same-origin path, with or without a query string', () => {
    expect(sanitizeNextPath('/items')).toBe('/items');
    expect(sanitizeNextPath('/device?user_code=ABCD-1234')).toBe('/device?user_code=ABCD-1234');
  });

  it('takes the first value when the key is repeated', () => {
    expect(sanitizeNextPath(['/items', '/boards'])).toBe('/items');
  });

  it('rejects everything that could leave this origin', () => {
    // Absolute, scheme-bearing, and both spellings of protocol-relative — the
    // backslash form matters because browsers normalise it to `//`.
    for (const hostile of [
      'https://evil.example',
      'javascript:alert(1)',
      'mailto:someone@evil.example',
      '//evil.example',
      '/\\evil.example',
      'items',
      '',
    ]) {
      expect(sanitizeNextPath(hostile), hostile).toBeNull();
    }
  });

  it('rejects a value carrying control characters rather than stripping them', () => {
    expect(sanitizeNextPath('/items\nLocation: https://evil.example')).toBeNull();
  });

  it('returns null for a missing param, which means "use the default"', () => {
    expect(sanitizeNextPath(undefined)).toBeNull();
    expect(sanitizeNextPath([])).toBeNull();
  });
});
