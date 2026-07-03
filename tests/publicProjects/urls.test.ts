import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicProjectPath, publicProjectUrl } from '@/lib/publicProjects/urls';

// The site-relative path helper backs the `?next=` return-to-this-page wiring in
// PublicTopBar (MOTIR-990 #3) and the absolute canonical/OpenGraph URL.

describe('publicProjectPath', () => {
  it('is the site-relative /p/<identifier> path', () => {
    expect(publicProjectPath('MOTIR')).toBe('/p/MOTIR');
  });

  it('URL-encodes the identifier so it is a safe path segment', () => {
    expect(publicProjectPath('a b/c')).toBe('/p/a%20b%2Fc');
  });
});

describe('publicProjectUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefixes the configured site origin to the public path (no double slash)', () => {
    vi.stubEnv('BETTER_AUTH_URL', 'https://motir.co/');
    expect(publicProjectUrl('MOTIR')).toBe('https://motir.co/p/MOTIR');
  });

  it('composes from the same path helper (identifier stays encoded)', () => {
    vi.stubEnv('BETTER_AUTH_URL', 'https://motir.co');
    expect(publicProjectUrl('a b')).toBe(`https://motir.co${publicProjectPath('a b')}`);
  });
});
