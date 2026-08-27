import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hashFollowToken,
  looksLikeEmail,
  mintFollowToken,
  normalizeFollowEmail,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from '@/lib/publicProjects/followTokens';

// Story 8.9 · Subtask 8.9.8 — the token primitives, at unit level.
//
// The service tests drive these through the follow flow; these cover the
// properties that are easiest to break silently in a refactor and hardest to
// notice from the outside: that a stored value is never the token, that a
// signature is actually checked, and that the secret is REQUIRED rather than
// defaulted to something empty.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the confirm token', () => {
  it('is high-entropy, URL-safe, and never equals its stored form', () => {
    const a = mintFollowToken();
    const b = mintFollowToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThan(30);
    // The database holds the hash. If these were ever equal, a leaked backup
    // would be a set of working confirmation links.
    expect(hashFollowToken(a)).not.toBe(a);
    expect(hashFollowToken(a)).toBe(hashFollowToken(a));
  });
});

describe('the unsubscribe token', () => {
  it('round-trips to the follow id it was signed for', () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'a-secret');
    const token = signUnsubscribeToken('follow-123');
    expect(verifyUnsubscribeToken(token)).toBe('follow-123');
  });

  it('is DETERMINISTIC — which is what makes a two-year-old link still work', () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'a-secret');
    expect(signUnsubscribeToken('follow-123')).toBe(signUnsubscribeToken('follow-123'));
  });

  it('rejects a forged signature, a swapped id, and a malformed token', () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'a-secret');
    const token = signUnsubscribeToken('follow-123');
    const signature = token.slice(token.lastIndexOf('.') + 1);

    expect(verifyUnsubscribeToken('follow-123.forged')).toBeNull();
    // The signature covers the id, so lifting one row's signature onto another
    // row's id must not verify — otherwise one valid link would unsubscribe
    // anybody whose id you could guess.
    expect(verifyUnsubscribeToken(`follow-456.${signature}`)).toBeNull();
    expect(verifyUnsubscribeToken('no-dot-at-all')).toBeNull();
    expect(verifyUnsubscribeToken('.leading-dot')).toBeNull();
  });

  it('does NOT verify under a different secret', () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'first-secret');
    const token = signUnsubscribeToken('follow-123');
    vi.stubEnv('BETTER_AUTH_SECRET', 'second-secret');
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it('THROWS when the secret is unset, rather than signing with nothing', () => {
    vi.stubEnv('BETTER_AUTH_SECRET', '');
    // The failure mode this prevents is the quiet one: an empty key still
    // produces a valid-looking HMAC, so every token would verify against every
    // other deployment's.
    expect(() => signUnsubscribeToken('follow-123')).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => verifyUnsubscribeToken('follow-123.x')).toThrow(/BETTER_AUTH_SECRET/);
  });
});

describe('address normalization', () => {
  it('lowercases and trims, so one person cannot become two follows', () => {
    expect(normalizeFollowEmail('  Reader@Example.COM ')).toBe('reader@example.com');
  });

  it('accepts a plausible address and rejects the obvious non-addresses', () => {
    expect(looksLikeEmail('reader@example.com')).toBe(true);
    expect(looksLikeEmail('reader+tag@sub.example.co.uk')).toBe(true);
    expect(looksLikeEmail('not-an-address')).toBe(false);
    expect(looksLikeEmail('no@tld')).toBe(false);
    expect(looksLikeEmail('two spaces@example.com')).toBe(false);
    // Bounded: the real proof an address exists is the confirmation link, but
    // the field is still not an unbounded write.
    expect(looksLikeEmail(`${'x'.repeat(250)}@example.com`)).toBe(false);
  });
});
