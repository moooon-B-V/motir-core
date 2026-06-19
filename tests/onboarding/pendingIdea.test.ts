import { describe, it, expect, vi, beforeEach } from 'vitest';

// An in-memory cookie store standing in for `next/headers` `cookies()`, so we can
// exercise the round-trip the front door relies on (write before the auth redirect,
// read + clear on the authed landing) without a request context.
const store = new Map<string, { value: string; options?: unknown }>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const hit = store.get(name);
      return hit ? { name, value: hit.value } : undefined;
    },
    set: (name: string, value: string, options?: unknown) => store.set(name, { value, options }),
    delete: (name: string) => void store.delete(name),
  }),
}));

import {
  PENDING_IDEA_COOKIE,
  MAX_PENDING_IDEA_LENGTH,
  normalizePendingIdea,
  setPendingIdea,
  readPendingIdea,
  clearPendingIdea,
} from '@/lib/onboarding/pendingIdea';

beforeEach(() => store.clear());

describe('normalizePendingIdea', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizePendingIdea('   an invoicing tool   ')).toBe('an invoicing tool');
  });

  it('clamps to the max length', () => {
    const long = 'x'.repeat(MAX_PENDING_IDEA_LENGTH + 500);
    expect(normalizePendingIdea(long)).toHaveLength(MAX_PENDING_IDEA_LENGTH);
  });

  it('returns empty string for non-string / empty input', () => {
    expect(normalizePendingIdea(undefined)).toBe('');
    expect(normalizePendingIdea(null)).toBe('');
    expect(normalizePendingIdea(42)).toBe('');
    expect(normalizePendingIdea('    ')).toBe('');
  });
});

describe('pending-idea cookie round-trip (7.3.14 → 7.3.5 seam)', () => {
  it('preserves an idea across the auth redirect, then reads + clears it', async () => {
    await setPendingIdea('  a tool for freelancers to send invoices  ');

    const stored = store.get(PENDING_IDEA_COOKIE);
    expect(stored?.value).toBe('a tool for freelancers to send invoices');
    // Lax so it survives the top-level OAuth redirect; httpOnly + path '/'.
    expect(stored?.options).toMatchObject({ sameSite: 'lax', httpOnly: true, path: '/' });

    expect(await readPendingIdea()).toBe('a tool for freelancers to send invoices');

    await clearPendingIdea();
    expect(store.has(PENDING_IDEA_COOKIE)).toBe(false);
    expect(await readPendingIdea()).toBeNull();
  });

  it('does not write a cookie for an empty idea (no stale seed)', async () => {
    await setPendingIdea('   ');
    expect(store.has(PENDING_IDEA_COOKIE)).toBe(false);
  });

  it('reads null when no idea was preserved', async () => {
    expect(await readPendingIdea()).toBeNull();
  });
});
