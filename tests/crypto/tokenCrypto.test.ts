import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenCrypto } from '@/lib/crypto/tokenCrypto';

// Story 7.16 · MOTIR-1653 — the generic AES-256-GCM token crypto extracted from
// the GitHub-only module so the import-source OAuth store can reuse it. The core
// round-trip / tamper / malformed / key-length / unset-key behaviours are
// covered by tests/github/tokenCrypto.test.ts (which now runs THROUGH this
// factory). Here we cover the factory-specific surface: the ordered env-var
// candidate list (a domain prefers its own key, falling back to a shared one).

const KEY_A = 'a1'.repeat(32); // 64 hex → 32 bytes
const KEY_B = 'b2'.repeat(32);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createTokenCrypto — env-var candidate resolution', () => {
  it('round-trips through a custom env key', () => {
    vi.stubEnv('CUSTOM_TOKEN_KEY', KEY_A);
    const crypto = createTokenCrypto('CUSTOM_TOKEN_KEY');
    const enc = crypto.encryptToken('secret-tok');
    expect(enc).not.toContain('secret-tok');
    expect(enc.startsWith('v1.')).toBe(true);
    expect(crypto.decryptToken(enc)).toBe('secret-tok');
  });

  it('prefers the FIRST env var that is set', () => {
    vi.stubEnv('PRIMARY_KEY', KEY_A);
    vi.stubEnv('SHARED_KEY', KEY_B);
    const enc = createTokenCrypto(['PRIMARY_KEY', 'SHARED_KEY']).encryptToken('tok');
    // Encrypted under KEY_A (the primary), so a KEY_A-only instance decrypts it
    // and a KEY_B-only instance cannot — proving the primary won.
    expect(createTokenCrypto('PRIMARY_KEY').decryptToken(enc)).toBe('tok');
    expect(() => createTokenCrypto('SHARED_KEY').decryptToken(enc)).toThrow();
  });

  it('falls back to a later env var when earlier ones are unset', () => {
    vi.stubEnv('MISSING_PRIMARY', ''); // empty is treated as unset
    vi.stubEnv('SHARED_KEY', KEY_B);
    const enc = createTokenCrypto(['MISSING_PRIMARY', 'SHARED_KEY']).encryptToken('tok');
    // Encrypted under the fallback KEY_B.
    expect(createTokenCrypto('SHARED_KEY').decryptToken(enc)).toBe('tok');
  });

  it('names the primary env var when no candidate is set', () => {
    const crypto = createTokenCrypto(['UNSET_A', 'UNSET_B']);
    expect(() => crypto.encryptToken('x')).toThrow(/UNSET_A is not set/);
  });

  it('throws when created with no env-var names', () => {
    expect(() => createTokenCrypto([])).toThrow(/at least one env-var name/);
  });
});
