// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// The sign-in card's OAuth hand-off banner (Story MOTIR-7170 · Subtask MOTIR-7174),
// built to `design/auth/oauth-consent--verified-client.mock.html` Panel V3: a
// verified app leads with its host, a self-registered one is "an app calling
// itself …", and a registered one keeps the shipped line.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/auth/client', () => ({ signIn: { email: vi.fn() } }));

import { SignInCard, type SignInOAuthApp } from '@/app/(auth)/sign-in/_components/SignInCard';

afterEach(() => {
  cleanup();
});

function banner(oauthApp: SignInOAuthApp): HTMLElement {
  renderWithIntl(<SignInCard oauthApp={oauthApp} />);
  return screen.getByText('Connecting an app').parentElement!;
}

describe('the sign-in hand-off names the waiting app by who vouches for it', () => {
  it('verified by domain: the host leads, in mono, and the name is its own claim', () => {
    const el = banner({ name: 'Claude', verification: { kind: 'domain', host: 'claude.ai' } });
    expect(el.textContent).toContain(
      'claude.ai, an app calling itself “Claude” — you’ll pick a workspace and approve next.',
    );
    const host = el.querySelector('b')!;
    expect(host.textContent).toBe('claude.ai');
    expect(host.className).toContain('font-mono');
  });

  it('a document calling itself “Claude” on another host leads with THAT host', () => {
    const el = banner({ name: 'Claude', verification: { kind: 'domain', host: 'evil.example' } });
    expect(el.querySelector('b')!.textContent).toBe('evil.example');
    expect(el.textContent).toContain('an app calling itself “Claude”');
  });

  it('self-registered: never states the name as fact', () => {
    const el = banner({ name: 'Claude Code', verification: { kind: 'self' } });
    expect(el.textContent).toContain(
      'An app calling itself “Claude Code”, which Motir hasn’t verified — you’ll pick a workspace and approve next.',
    );
  });

  it('self-registered with no name: the shipped unnamed line', () => {
    const el = banner({ name: null, verification: { kind: 'self' } });
    expect(el.textContent).toContain('This app — you’ll pick a workspace and approve next.');
  });

  it('registered: the shipped line, since this deployment set the name', () => {
    const el = banner({ name: 'Claude', verification: { kind: 'registered' } });
    expect(el.textContent).toContain('Claude — you’ll pick a workspace and approve next.');
    expect(el.textContent).not.toContain('calling itself');
  });
});
