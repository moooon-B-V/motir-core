import { afterEach, describe, expect, it, vi } from 'vitest';

// THE PROVIDER FACTORY'S SAFETY PROPERTY — Story MOTIR-3878 · MOTIR-4216.
//
// The seam exists so the E2E card can drive a customer domain to `issued`
// without DNS or Fly. The danger it creates is exactly proportional to its
// usefulness: a certificate provider that reports `issued` without asking
// anyone would, in production, mark customer domains live that have no
// certificate — visitors meeting a TLS error on an address the settings pane
// calls healthy.
//
// So the flag is refused in a production build, and this file is the assertion
// that says so. An env var is a thing an operator can set by accident; the
// NODE_ENV guard is what makes that accident harmless.

const { usingFakePublicAddressProviders, dnsResolver, seedFakeTxt, resetFakeTxt } =
  await import('@/lib/publicAddresses/providers');
const { nodeDnsResolver } = await import('@/lib/publicAddresses/dnsResolver');

afterEach(() => {
  vi.unstubAllEnvs();
  resetFakeTxt();
});

describe('the fakes are OFF by default', () => {
  it('with no flag at all', () => {
    vi.stubEnv('MOTIR_E2E_FAKE_PUBLIC_ADDRESS_PROVIDERS', undefined);
    expect(usingFakePublicAddressProviders()).toBe(false);
    expect(dnsResolver()).toBe(nodeDnsResolver);
  });

  it('with the flag set to anything other than exactly `1`', () => {
    // Not truthiness: `0`, `false` and `true` are all things somebody types
    // meaning "off", and only one spelling arms a seam like this.
    for (const value of ['0', 'false', 'true', 'yes', '']) {
      vi.stubEnv('MOTIR_E2E_FAKE_PUBLIC_ADDRESS_PROVIDERS', value);
      expect(usingFakePublicAddressProviders(), value).toBe(false);
    }
  });
});

describe('the fakes arm only under the flag, and NEVER in production', () => {
  it('arm in a non-production build with the flag', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MOTIR_E2E_FAKE_PUBLIC_ADDRESS_PROVIDERS', '1');
    expect(usingFakePublicAddressProviders()).toBe(true);
    expect(dnsResolver()).not.toBe(nodeDnsResolver);
  });

  it('⚠️ REFUSE in a production build even with the flag set', () => {
    // The assertion this whole file exists for.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MOTIR_E2E_FAKE_PUBLIC_ADDRESS_PROVIDERS', '1');
    expect(usingFakePublicAddressProviders()).toBe(false);
    expect(dnsResolver()).toBe(nodeDnsResolver);
  });
});

describe('the fake resolver answers what it was seeded', () => {
  it('returns the seeded token, and [] for a name nobody seeded', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MOTIR_E2E_FAKE_PUBLIC_ADDRESS_PROVIDERS', '1');
    seedFakeTxt('_motir-verify.roadmap.acme.test', ['motir-verify-abc']);
    await expect(dnsResolver().resolveTxt('_motir-verify.roadmap.acme.test')).resolves.toEqual([
      'motir-verify-abc',
    ]);
    // Absent is `[]`, never a throw — "the customer has not created it yet" is
    // the ordinary state, not an error.
    await expect(dnsResolver().resolveTxt('_motir-verify.nobody.test')).resolves.toEqual([]);
  });
});
