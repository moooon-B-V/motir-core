import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptToken, decryptToken } from '@/lib/github/tokenCrypto';

// Story 7.10 · MOTIR-1498 — the at-rest encryption for the GitHub user token.
// Pure unit tests (no DB): the token must be RECOVERABLE (reversible, unlike the
// hashed API-token secret) yet never stored plaintext, and a tampered or
// wrong-key payload must fail loudly rather than decode to garbage.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('tokenCrypto', () => {
  it('round-trips a token and never stores it plaintext', () => {
    const enc = encryptToken('gho_secret_token_123');
    expect(enc).not.toContain('gho_secret_token_123');
    expect(enc.startsWith('v1.')).toBe(true);
    expect(decryptToken(enc)).toBe('gho_secret_token_123');
  });

  it('produces a different ciphertext each call (fresh random IV)', () => {
    expect(encryptToken('same-plaintext')).not.toBe(encryptToken('same-plaintext'));
  });

  it('throws on a tampered ciphertext (auth-tag check)', () => {
    const parts = encryptToken('tok').split('.');
    const ct = parts[3]!;
    parts[3] = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    expect(() => decryptToken(parts.join('.'))).toThrow();
  });

  it('throws on an unknown version or malformed payload', () => {
    expect(() => decryptToken('v2.a.b.c')).toThrow(/unsupported/i);
    expect(() => decryptToken('garbage')).toThrow(/malformed/i);
  });

  it('cannot decrypt with a different key', () => {
    const enc = encryptToken('tok'); // encrypted under the default test key
    vi.stubEnv(
      'GITHUB_TOKEN_ENCRYPTION_KEY',
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    );
    expect(() => decryptToken(enc)).toThrow();
  });

  it('rejects a wrong-length key', () => {
    vi.stubEnv('GITHUB_TOKEN_ENCRYPTION_KEY', 'tooshort');
    expect(() => encryptToken('x')).toThrow(/32 bytes/);
  });

  it('throws a clear error when the key is unset', () => {
    vi.stubEnv('GITHUB_TOKEN_ENCRYPTION_KEY', '');
    expect(() => encryptToken('x')).toThrow(/is not set/);
  });
});
