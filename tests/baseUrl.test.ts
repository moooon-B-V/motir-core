import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBaseUrl, resolveBaseUrlTrimmed } from '@/lib/baseUrl';

// MOTIR-2388 — the app-URL contract. `lib/baseUrl.ts` is the ONE place the
// precedence for the application's own origin lives
// (docs/decisions/application-hosting.md §4 / Q3), so the precedence is asserted
// here rather than at each of the five call sites that used to answer it
// themselves. The unset case is the one that matters most: it is what every
// local checkout and every test run hits, and the failure it guards against is
// silent — an absolute link built from an undefined variable does not throw,
// it just points nowhere.

describe('resolveBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rung 1: returns MOTIR_BASE_URL when it is set', () => {
    vi.stubEnv('MOTIR_BASE_URL', 'https://app.motir.co');
    expect(resolveBaseUrl()).toBe('https://app.motir.co');
  });

  it('rung 2: falls back to the dev origin when MOTIR_BASE_URL is UNSET', () => {
    vi.stubEnv('MOTIR_BASE_URL', undefined);
    expect(resolveBaseUrl()).toBe('http://localhost:3000');
  });

  it('treats an EMPTY value as unset — a cleared secret must not yield a relative link', () => {
    vi.stubEnv('MOTIR_BASE_URL', '');
    expect(resolveBaseUrl()).toBe('http://localhost:3000');
  });

  it('treats a whitespace-only value as unset', () => {
    vi.stubEnv('MOTIR_BASE_URL', '   ');
    expect(resolveBaseUrl()).toBe('http://localhost:3000');
  });

  it('trims surrounding whitespace off a configured origin', () => {
    vi.stubEnv('MOTIR_BASE_URL', '  https://app.motir.co  ');
    expect(resolveBaseUrl()).toBe('https://app.motir.co');
  });

  it('preserves a configured trailing slash (the untrimmed accessor is verbatim)', () => {
    vi.stubEnv('MOTIR_BASE_URL', 'https://app.motir.co/');
    expect(resolveBaseUrl()).toBe('https://app.motir.co/');
  });

  it('reads NONE of the retired Vercel variables', () => {
    vi.stubEnv('MOTIR_BASE_URL', undefined);
    vi.stubEnv('BETTER_AUTH_URL', 'https://betterauth.example');
    vi.stubEnv('VERCEL_URL', 'deployment.vercel.app');
    vi.stubEnv('VERCEL_BRANCH_URL', 'branch.vercel.app');
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'production.vercel.app');
    expect(resolveBaseUrl()).toBe('http://localhost:3000');
  });
});

describe('resolveBaseUrlTrimmed', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('strips a trailing slash so a path can be concatenated directly', () => {
    vi.stubEnv('MOTIR_BASE_URL', 'https://app.motir.co/');
    expect(resolveBaseUrlTrimmed()).toBe('https://app.motir.co');
    expect(`${resolveBaseUrlTrimmed()}/items/MOTIR-1`).toBe('https://app.motir.co/items/MOTIR-1');
  });

  it('strips repeated trailing slashes', () => {
    vi.stubEnv('MOTIR_BASE_URL', 'https://app.motir.co///');
    expect(resolveBaseUrlTrimmed()).toBe('https://app.motir.co');
  });

  it('leaves an origin without a trailing slash untouched', () => {
    vi.stubEnv('MOTIR_BASE_URL', 'https://app.motir.co');
    expect(resolveBaseUrlTrimmed()).toBe('https://app.motir.co');
  });

  it('returns the dev origin, unchanged, when the variable is unset', () => {
    vi.stubEnv('MOTIR_BASE_URL', undefined);
    expect(resolveBaseUrlTrimmed()).toBe('http://localhost:3000');
  });
});
