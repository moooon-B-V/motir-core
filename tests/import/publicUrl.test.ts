import { describe, expect, it, vi } from 'vitest';
import { ConnectorConfigError } from '@/lib/import/connectors/errors';
import { fetchWithRetry, trimTrailingSlashes } from '@/lib/import/connectors/http';
import { assertPublicHttpUrl, isNonPublicAddress } from '@/lib/import/connectors/publicUrl';

// MOTIR-7816 — the SSRF guard a live connector runs before it reaches a base URL
// the member supplied (CodeQL js/request-forgery on `fetchWithRetry`).

const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address }));

describe('isNonPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.5',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:a9fe:a9fe',
    'not-an-ip',
  ])('refuses %s', (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each(['140.82.112.6', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'admits %s',
    (address) => {
      expect(isNonPublicAddress(address)).toBe(false);
    },
  );
});

describe('assertPublicHttpUrl', () => {
  it('admits a host that resolves only to public addresses', async () => {
    await expect(
      assertPublicHttpUrl('https://ghe.acme.test/api/v3', 'github', resolvesTo('203.0.114.7')),
    ).resolves.toBeUndefined();
  });

  it('refuses a host when ANY of its addresses is private', async () => {
    await expect(
      assertPublicHttpUrl(
        'https://plane.acme.test',
        'plane',
        resolvesTo('203.0.114.7', '10.0.0.4'),
      ),
    ).rejects.toBeInstanceOf(ConnectorConfigError);
  });

  it('refuses a private IP literal without resolving it', async () => {
    const resolve = vi.fn();
    await expect(
      assertPublicHttpUrl('http://169.254.169.254/latest/meta-data', 'github', resolve),
    ).rejects.toThrow(/not a public address/);
    await expect(assertPublicHttpUrl('http://[::1]:8080/', 'github', resolve)).rejects.toThrow(
      /not a public address/,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses a scheme other than http(s), and a host that does not resolve', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow(/http or https/);
    await expect(
      assertPublicHttpUrl('https://nowhere.acme.test', 'plane', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).rejects.toThrow(/could not be resolved/);
  });

  it('skips the lookup for the fixed SaaS API hosts', async () => {
    const resolve = vi.fn();
    await assertPublicHttpUrl('https://api.github.com/repos/a/b', 'github', resolve);
    await assertPublicHttpUrl('https://acme.atlassian.net/rest/api/3', 'jira', resolve);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('fetchWithRetry on the real network', () => {
  it('refuses a private target before any request is made', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(
        fetchWithRetry('http://127.0.0.1:5433/', {}, { source: 'github' }),
      ).rejects.toBeInstanceOf(ConnectorConfigError);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('trimTrailingSlashes', () => {
  it('drops every trailing slash and nothing else', () => {
    expect(trimTrailingSlashes('https://ghe.acme.test/api/v3///')).toBe(
      'https://ghe.acme.test/api/v3',
    );
    expect(trimTrailingSlashes('https://x.test/a')).toBe('https://x.test/a');
    expect(trimTrailingSlashes('///')).toBe('');
  });

  it('stays linear on a long run of slashes', () => {
    const input = `https://x.test${'/'.repeat(200_000)}a${'/'.repeat(200_000)}`;
    const started = performance.now();
    expect(trimTrailingSlashes(input)).toBe(`https://x.test${'/'.repeat(200_000)}a`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
