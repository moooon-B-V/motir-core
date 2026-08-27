import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isTwoFactorExemptPath,
  safeNextPath,
  TWO_FACTOR_EXEMPT_PATHS,
  TWO_FACTOR_FALLBACK_DESTINATION,
} from '@/lib/auth/twoFactorGate';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

// The 2FA enforcement gate (Story MOTIR-1215 · Subtask MOTIR-3648).
//
// Two halves, and the second is the one with teeth: `safeNextPath` is the only
// thing between a FORGEABLE request header and a `redirect()`.

const { resolveRequirement } = vi.hoisted(() => ({ resolveRequirement: vi.fn() }));
const currentPath = vi.hoisted(() => ({ value: '/items/MOTIR-1215' as string | null }));
const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
}));
vi.mock('next/headers', () => ({
  headers: async () => ({
    get: () => currentPath.value,
  }),
}));
vi.mock('@/lib/services/twoFactorPolicyService', () => ({
  twoFactorPolicyService: { resolveRequirement },
}));

const ORG_MANDATE = { tier: 'organization' as const, id: 'org_acme', name: 'Acme' };

async function gate() {
  const mod = await import('@/lib/auth/twoFactorGate');
  return mod.assertTwoFactorCompliance;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentPath.value = '/items/MOTIR-1215';
  resolveRequirement.mockResolvedValue({
    required: true,
    mandatedBy: ORG_MANDATE,
    compliant: false,
  });
});
afterEach(() => vi.clearAllMocks());

// ── ⚠️ The open-redirect guard ──────────────────────────────────────────────

describe('safeNextPath — the only thing between a forgeable header and a redirect', () => {
  it('accepts a same-origin relative path, search string and all', () => {
    expect(safeNextPath('/items/MOTIR-1215')).toBe('/items/MOTIR-1215');
    expect(safeNextPath('/items?status=open&assignee=me')).toBe('/items?status=open&assignee=me');
  });

  it.each([
    ['an absolute URL', 'https://evil.example/x'],
    ['a PROTOCOL-RELATIVE host — the case a naive "starts with /" check passes', '//evil.example'],
    ['a traversal', '/a/../../b'],
    ['a bare traversal segment', '/..'],
    ['a scheme hidden in the path', '/x:y'],
    ['a backslash', '/x\\evil.example'],
    ['a relative path with no leading slash', 'items/MOTIR-1215'],
    ['an empty string', ''],
    ['null — the header was absent, which is a NORMAL state off-matcher', null],
    ['undefined', undefined],
  ])('falls back to /home for %s', (_label, candidate) => {
    expect(safeNextPath(candidate)).toBe(TWO_FACTOR_FALLBACK_DESTINATION);
    // The landing is decided once, in `lib/navigation/landing.ts` — imported
    // here rather than re-typed, which `tests/navigation/landing.test.ts`
    // enforces across the tree.
    expect(TWO_FACTOR_FALLBACK_DESTINATION).toBe(AUTHED_LANDING_PATH);
  });

  it('a query string may contain a URL — it is not part of the path', () => {
    // `/x?to=https://…` is a perfectly ordinary path; the guard is about where
    // the BROWSER would navigate, which is decided before the `?`.
    expect(safeNextPath('/search?q=https://example.com')).toBe('/search?q=https://example.com');
  });
});

// ── The exemption ───────────────────────────────────────────────────────────

describe('the exemption is BY PATH, never by wildcard', () => {
  it('names exactly the account Security pane', () => {
    expect([...TWO_FACTOR_EXEMPT_PATHS]).toEqual(['/settings/account/security']);
  });

  it('exempts that pane and its query string', () => {
    expect(isTwoFactorExemptPath('/settings/account/security')).toBe(true);
    expect(isTwoFactorExemptPath('/settings/account/security?tab=passkeys')).toBe(true);
  });

  it('⚠️ does NOT exempt its siblings — a wildcard would have', () => {
    // Profile, tokens and appearance resolve nothing, so exempting them would
    // widen the hold's escape hatch for no reason.
    for (const path of [
      '/settings/account',
      '/settings/account/profile',
      '/settings/account/tokens',
      '/settings/account/security-something-else',
    ]) {
      expect(isTwoFactorExemptPath(path), path).toBe(false);
    }
  });
});

// ── The decision ────────────────────────────────────────────────────────────

describe('assertTwoFactorCompliance', () => {
  it('HOLDS a required-and-non-compliant visitor, carrying their path', async () => {
    const run = await gate();
    await expect(run('u1')).rejects.toThrow(
      `NEXT_REDIRECT:/two-factor-required?next=${encodeURIComponent('/items/MOTIR-1215')}`,
    );
  });

  it('lets a COMPLIANT visitor through even while a tier requires it', async () => {
    resolveRequirement.mockResolvedValue({
      required: true,
      mandatedBy: ORG_MANDATE,
      compliant: true,
    });
    const run = await gate();
    await expect(run('u1')).resolves.toBeUndefined();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('lets everyone through when no tier requires it', async () => {
    resolveRequirement.mockResolvedValue({ required: false, mandatedBy: null, compliant: false });
    const run = await gate();
    await expect(run('u1')).resolves.toBeUndefined();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('⚠️ does NOT hold a passkey-only account — the regression this story owns', async () => {
    // `compliant` is `methods.length > 0`, not `user.twoFactorEnabled`. A
    // passkey counts even with that flag false, and that is precisely the
    // account a naive check locks out of the product. The predicate itself is
    // asserted in `tests/twoFactorHasSecondFactor.test.ts`; this is the gate
    // honouring its answer.
    resolveRequirement.mockResolvedValue({
      required: true,
      mandatedBy: ORG_MANDATE,
      compliant: true,
    });
    const run = await gate();
    await expect(run('u1')).resolves.toBeUndefined();
  });

  it('lets a held visitor reach their own Security pane, so they can enrol', async () => {
    currentPath.value = '/settings/account/security';
    const run = await gate();
    await expect(run('u1')).resolves.toBeUndefined();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('falls back to /home when the header is absent — off-matcher is normal', async () => {
    currentPath.value = null;
    const run = await gate();
    await expect(run('u1')).rejects.toThrow(
      `NEXT_REDIRECT:/two-factor-required?next=${encodeURIComponent(AUTHED_LANDING_PATH)}`,
    );
  });

  it('⚠️ a FORGED header cannot become the redirect target', async () => {
    currentPath.value = 'https://evil.example/phish';
    const run = await gate();
    await expect(run('u1')).rejects.toThrow(
      `NEXT_REDIRECT:/two-factor-required?next=${encodeURIComponent(AUTHED_LANDING_PATH)}`,
    );
  });
});
