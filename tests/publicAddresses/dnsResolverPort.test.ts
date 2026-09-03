import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE DNS PORT AND THE COMPOSITION ROOT (Story MOTIR-3878 · MOTIR-4223, over
// MOTIR-4216's `dnsResolver.ts` and `providers.ts`).
//
// ⚠️ THE ARM THAT MATTERS IS THE ONE THAT MUST *NOT* SAY "NO RECORD". NXDOMAIN
// and ENODATA are the ordinary "the customer has not created it yet" state and
// return `[]`; a SERVFAIL or a timeout is a lookup FAILURE, and reporting it as
// an absent record would tell a customer their correct DNS is missing and send
// them to change something that was right. The module says so; nothing asserted
// it until this gate measured the file at 12.5%.

const resolveTxtMock = vi.fn();
vi.mock('node:dns/promises', () => ({ resolveTxt: resolveTxtMock }));

const { nodeDnsResolver } = await import('@/lib/publicAddresses/dnsResolver');
const providersModule = await import('@/lib/publicAddresses/providers');

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  delete process.env['MOTIR_E2E_FAKE_PUBLIC_ADDRESS_PROVIDERS'];
  delete process.env['FLY_CERTS_TOKEN'];
  delete process.env['FLY_CERTS_APP'];
});

describe('the production resolver', () => {
  it('JOINS each record’s chunks, because a TXT record is a list of strings', async () => {
    // A long token arrives split into 255-byte pieces. A caller comparing whole
    // values would silently fail to match one that crossed the boundary — which
    // is a verification that never succeeds for exactly the customers whose
    // token is long.
    resolveTxtMock.mockResolvedValue([['motir-verify=', 'abc123'], ['unrelated']]);
    await expect(nodeDnsResolver.resolveTxt('_motir-verify.acme.test')).resolves.toEqual([
      'motir-verify=abc123',
      'unrelated',
    ]);
  });

  it('reads an ABSENT name or record type as no record, not as an error', async () => {
    for (const code of ['ENOTFOUND', 'ENODATA']) {
      resolveTxtMock.mockRejectedValue(Object.assign(new Error(code), { code }));
      await expect(nodeDnsResolver.resolveTxt('missing.acme.test')).resolves.toEqual([]);
    }
  });

  it('and RETHROWS a real lookup failure rather than calling it absence', async () => {
    // ⚠️ THE DISTINCTION THIS PORT EXISTS TO KEEP. Swallowing SERVFAIL would
    // tell a customer whose record is correct that it is missing.
    resolveTxtMock.mockRejectedValue(Object.assign(new Error('SERVFAIL'), { code: 'SERVFAIL' }));
    await expect(nodeDnsResolver.resolveTxt('acme.test')).rejects.toThrow('SERVFAIL');

    resolveTxtMock.mockRejectedValue(new Error('socket hang up'));
    await expect(nodeDnsResolver.resolveTxt('acme.test')).rejects.toThrow('socket hang up');
  });
});

describe('the composition root', () => {
  it('hands out the FAKES when they are asked for, and the fake DNS answers what it was seeded', async () => {
    process.env['MOTIR_E2E_FAKE_PUBLIC_ADDRESS_PROVIDERS'] = '1';
    const providers = await import('@/lib/publicAddresses/providers');
    expect(providers.usingFakePublicAddressProviders()).toBe(true);

    providers.resetFakeTxt();
    providers.seedFakeTxt('_motir-verify.acme.test', ['motir-verify=token']);
    await expect(providers.dnsResolver().resolveTxt('_motir-verify.acme.test')).resolves.toEqual([
      'motir-verify=token',
    ]);
    // An unseeded name is the "not created yet" state, exactly as the real one.
    await expect(providers.dnsResolver().resolveTxt('other.acme.test')).resolves.toEqual([]);

    providers.resetFakeTxt();
    await expect(providers.dnsResolver().resolveTxt('_motir-verify.acme.test')).resolves.toEqual(
      [],
    );
  });

  it('the fake certificate provider issues on request, so a lane can reach `issued`', async () => {
    process.env['MOTIR_E2E_FAKE_PUBLIC_ADDRESS_PROVIDERS'] = '1';
    const providers = await import('@/lib/publicAddresses/providers');
    const provider = await providers.certificateProvider();

    const state = await provider.request('roadmap.acme.test');
    expect(state.hostname).toBe('roadmap.acme.test');
    expect(state.issued).toBe(true);
    await expect(provider.check('roadmap.acme.test')).resolves.toMatchObject({ issued: true });
    // Removal must not throw for a hostname that is already gone — the port's
    // own contract, and the reason a teardown can be idempotent.
    await expect(provider.remove('roadmap.acme.test')).resolves.toBeUndefined();
  });

  it('reports the platform as UNCONFIGURED when its two variables are absent', async () => {
    // The pane and the lifecycle both branch on this: an unconfigured platform
    // is an OPERATOR state, and answering "configured" would make it look like
    // the customer's DNS was at fault.
    const providers = await import('@/lib/publicAddresses/providers');
    await expect(providers.certificatesConfigured()).resolves.toBe(false);
  });

  it('⚠️ REFUSES THE FAKES IN A PRODUCTION BUILD, whatever the flag says', () => {
    // The guard the module's own header calls the reason the flag is safe: a
    // provider that reports `issued` without asking anyone would, in production,
    // mark customer domains live that have no certificate — and visitors would
    // meet a TLS error on an address the pane calls healthy. An env var is a
    // thing an operator can set by accident; this is what makes that harmless.
    process.env['MOTIR_E2E_FAKE_PUBLIC_ADDRESS_PROVIDERS'] = '1';
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(providersModule.usingFakePublicAddressProviders()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
