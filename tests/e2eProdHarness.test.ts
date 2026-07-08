import { afterEach, describe, expect, it, vi } from 'vitest';
import { isE2EProdHarness, shouldUseSecureCookies } from '@/lib/e2eProdHarness';

// MOTIR-1679: the E2E production harness runs the suite against a `next build` /
// `next start` server (NODE_ENV=production) to avoid the `next dev` compiler
// flake. E2E_PROD_HARNESS=1 re-relaxes the NODE_ENV=production test seams. These
// helpers own that flag; read them dynamically so the values below take effect.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isE2EProdHarness', () => {
  it('is true only when E2E_PROD_HARNESS is exactly "1"', () => {
    vi.stubEnv('E2E_PROD_HARNESS', '1');
    expect(isE2EProdHarness()).toBe(true);
  });

  it('is false when the flag is unset', () => {
    vi.stubEnv('E2E_PROD_HARNESS', '');
    expect(isE2EProdHarness()).toBe(false);
  });

  it('is false for any value other than "1" (e.g. "0"/"true")', () => {
    vi.stubEnv('E2E_PROD_HARNESS', '0');
    expect(isE2EProdHarness()).toBe(false);
    vi.stubEnv('E2E_PROD_HARNESS', 'true');
    expect(isE2EProdHarness()).toBe(false);
  });
});

describe('shouldUseSecureCookies', () => {
  it('is true in real production (harness flag unset)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '');
    expect(shouldUseSecureCookies()).toBe(true);
  });

  it('is false in production UNDER the E2E harness (http://localhost can not send a Secure cookie)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '1');
    expect(shouldUseSecureCookies()).toBe(false);
  });

  it('is false in development regardless of the harness flag', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('E2E_PROD_HARNESS', '');
    expect(shouldUseSecureCookies()).toBe(false);
    vi.stubEnv('E2E_PROD_HARNESS', '1');
    expect(shouldUseSecureCookies()).toBe(false);
  });
});
