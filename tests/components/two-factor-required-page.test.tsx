// @vitest-environment happy-dom
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

// The FORCED-ENROLMENT SCREEN (Story MOTIR-1215 · Subtask MOTIR-3648), built to
// `design/auth/two-factor-required.mock.html`.
//
// ⚠️ THE GATE CANNOT PROTECT THIS PAGE — it is the page the gate redirects TO,
// and it lives in the ungated `(auth)` group so that redirect cannot loop. So
// the page carries its own three gates, and they are what this file is mostly
// about.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { resolveRequirement } = vi.hoisted(() => ({ resolveRequirement: vi.fn() }));
const { getStatus, listTrustedDevices } = vi.hoisted(() => ({
  getStatus: vi.fn(),
  listTrustedDevices: vi.fn(),
}));
const { listForUser } = vi.hoisted(() => ({ listForUser: vi.fn() }));
const { getPasswordCapability } = vi.hoisted(() => ({ getPasswordCapability: vi.fn() }));
const { signOut, push } = vi.hoisted(() => ({
  signOut: vi.fn(async () => undefined),
  push: vi.fn(),
}));
const { redirect } = vi.hoisted(() => ({
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
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => '/two-factor-required',
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
  };
});
vi.mock('@/lib/services/twoFactorPolicyService', () => ({
  twoFactorPolicyService: { resolveRequirement },
}));
vi.mock('@/lib/services/twoFactorService', () => ({
  twoFactorService: { getStatus, listTrustedDevices },
}));
vi.mock('@/lib/services/passkeyService', () => ({ passkeyService: { listForUser } }));
vi.mock('@/lib/services/usersService', () => ({ usersService: { getPasswordCapability } }));
vi.mock('@/lib/auth/client', () => ({ signOut, twoFactor: {}, passkey: {} }));

const ORG = { tier: 'organization' as const, id: 'org_acme', name: 'Acme' };
const WORKSPACE = { tier: 'workspace' as const, id: 'ws_eng', name: 'Engineering' };

// ⚠️ WARM THE MODULE GRAPH ONCE, OUTSIDE ANY CASE'S CLOCK. This page mounts
// `AccountSecurityPanes`, which reaches `TwoFactorManager` (~800 lines),
// `PasskeyManager` and the design-system package — and the FIRST transform of
// that graph costs more than the suite's 15 s per-test timeout on a cold or
// contended runner. Without this the failure lands on whichever case happens to
// run first and says nothing about that case; observed exactly once here, on a
// combined run, at 15 073 ms. `tests/platform/adminRouteGate.test.ts` warms its
// own graph for the same reason and with the same budget.
beforeAll(async () => {
  await import('@/app/(auth)/two-factor-required/page');
}, 180_000);

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: 'u1', email: 'ada@example.com' } });
  resolveRequirement.mockResolvedValue({ required: true, mandatedBy: ORG, compliant: false });
  getStatus.mockResolvedValue({
    enabled: false,
    methods: [],
    primaryMethod: null,
    backupCodesRemaining: 0,
    backupCodesTotal: 10,
  });
  getPasswordCapability.mockResolvedValue({ hasPassword: true });
  listTrustedDevices.mockResolvedValue([]);
  listForUser.mockResolvedValue([]);
});
afterEach(cleanup);

async function renderPageReturning(next?: string) {
  const mod = await import('@/app/(auth)/two-factor-required/page');
  const tree = (await mod.default({
    searchParams: Promise.resolve(next === undefined ? {} : { next }),
  })) as ReactElement;
  return render(<ToastProvider>{tree}</ToastProvider>);
}

async function renderPage(next?: string): Promise<void> {
  await renderPageReturning(next);
}

describe('the /two-factor-required screen', () => {
  it('paints its landmark heading and names the ORGANIZATION', async () => {
    await renderPage('/items/MOTIR-1215');
    expect(
      screen.getByRole('heading', { name: 'Set up a second factor to continue', level: 1 }),
    ).toBeTruthy();
    expect(screen.getByText('Required by Acme')).toBeTruthy();
    expect(
      screen.getByText(
        /Acme requires everyone in the organization to sign in with a second factor/,
      ),
    ).toBeTruthy();
  });

  it('names the WORKSPACE when only a workspace requires it', async () => {
    resolveRequirement.mockResolvedValue({
      required: true,
      mandatedBy: WORKSPACE,
      compliant: false,
    });
    await renderPage(AUTHED_LANDING_PATH);
    expect(screen.getByText('Required by Engineering')).toBeTruthy();
    expect(
      screen.getByText(/Engineering requires everyone in the workspace to sign in/),
    ).toBeTruthy();
  });

  it('carries the sign-out control — the way out is not optional', async () => {
    await renderPage(AUTHED_LANDING_PATH);
    expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy();
    expect(
      screen.getByText('You can come back and set this up any time you sign in.'),
    ).toBeTruthy();
  });

  it('the sign-out control WORKS — it signs out and lands on /sign-in', async () => {
    // Present is not enough: the whole reason this control exists is that every
    // other route is closed, so a button that did nothing would leave the person
    // exactly as trapped as no button at all.
    await renderPage(AUTHED_LANDING_PATH);
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(signOut).toHaveBeenCalled());
    await waitFor(() => expect(push).toHaveBeenCalledWith('/sign-in'));
  });

  it('mounts the shipped enrolment surface rather than a rebuilt one', async () => {
    // `AccountSecurityPanes` is the state OWNER `settings/account/security`
    // renders. Mounting the OWNER rather than its two children is what keeps the
    // `methods`-from-passkeys derivation intact (MOTIR-3612) instead of
    // re-deriving it here.
    const { container } = await renderPageReturning(AUTHED_LANDING_PATH);
    expect(getStatus).toHaveBeenCalledWith('u1');
    expect(listForUser).toHaveBeenCalledWith('u1');
    expect(getPasswordCapability).toHaveBeenCalledWith('u1');
    expect(listTrustedDevices).toHaveBeenCalledWith('u1');
    // The panes really rendered: more than the page's own sign-out control is
    // on screen, and the passkey island's own copy is present.
    expect(screen.getAllByRole('button').length).toBeGreaterThan(1);
    expect(container.textContent).toMatch(/passkey/i);
  });

  it('redirects an ANONYMOUS visitor to /sign-in — the (auth) layout will not', async () => {
    getSession.mockResolvedValue(null);
    const mod = await import('@/app/(auth)/two-factor-required/page');
    await expect(mod.default({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_REDIRECT:/sign-in',
    );
  });

  it('redirects a COMPLIANT visitor onward — nobody sits on a dead screen', async () => {
    // Somebody who types the URL, or who enrolled in another tab.
    resolveRequirement.mockResolvedValue({ required: true, mandatedBy: ORG, compliant: true });
    const mod = await import('@/app/(auth)/two-factor-required/page');
    await expect(
      mod.default({ searchParams: Promise.resolve({ next: '/items/MOTIR-1215' }) }),
    ).rejects.toThrow('NEXT_REDIRECT:/items/MOTIR-1215');
  });

  it('redirects a visitor nobody is asking anything of', async () => {
    resolveRequirement.mockResolvedValue({ required: false, mandatedBy: null, compliant: false });
    const mod = await import('@/app/(auth)/two-factor-required/page');
    await expect(mod.default({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      `NEXT_REDIRECT:${AUTHED_LANDING_PATH}`,
    );
  });

  it('⚠️ VALIDATES `next` before redirecting to it — a query string is editable', async () => {
    // The value reached the gate from a forgeable header and then rode a query
    // string a person can retype. Both are untrusted.
    resolveRequirement.mockResolvedValue({ required: true, mandatedBy: ORG, compliant: true });
    const mod = await import('@/app/(auth)/two-factor-required/page');
    for (const hostile of ['https://evil.example/x', '//evil.example', '/a/../../b']) {
      await expect(
        mod.default({ searchParams: Promise.resolve({ next: hostile }) }),
        hostile,
      ).rejects.toThrow(`NEXT_REDIRECT:${AUTHED_LANDING_PATH}`);
    }
  });
});

describe('the enrolment components are MOUNTED, not forked', () => {
  it('each exists exactly once in the tree', () => {
    // A forked enrolment flow is the failure the card's portability paragraph
    // exists to prevent: two QR flows drift, and the one nobody is looking at
    // drifts first.
    for (const name of ['TwoFactorManager.tsx', 'PasskeyManager.tsx', 'AccountSecurityPanes.tsx']) {
      const found: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const p = join(dir, entry);
          if (statSync(p).isDirectory()) walk(p);
          else if (entry === name) found.push(p);
        }
      };
      walk(join(process.cwd(), 'app'));
      expect(found, name).toHaveLength(1);
      expect(found[0]!.includes('settings/account/_components/'), name).toBe(true);
    }
  });
});
