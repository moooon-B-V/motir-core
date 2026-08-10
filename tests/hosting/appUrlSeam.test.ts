import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBaseUrl, resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { publicProjectPath, publicProjectUrl, publicSiteOrigin } from '@/lib/publicProjects/urls';
import { buildRootMetadata } from '@/lib/rootMetadata';
import { buildAuthorizeUrl, callbackUrl } from '@/lib/gitlab/gitlabOAuth';

// MOTIR-2394, job 2 — the app-URL seam, from the accessor to the links it ends
// up inside.
//
// `tests/baseUrl.test.ts` (MOTIR-2388's own card) asserts what
// `resolveBaseUrl()` RETURNS, one string at a time, and it should: that is the
// precedence, and it is where the two-rung decision lives. What it cannot assert
// is what the string DOES, because it never hands one to a consumer — and the
// failure mode MOTIR-2388 replaced is precisely a failure of the composed value,
// not of the accessor. An absolute link built from a bad origin does not throw;
// it points somewhere wrong, and everything downstream keeps working.
//
// So this suite feeds the accessor's real output to REAL absolute-link builders
// — the public-project canonical URL, the root layout's `metadataBase`, and an
// OAuth `redirect_uri` — and reads the result back through `new URL`. Every
// assertion is on a PARSED url's origin and pathname rather than on string
// equality, because "is this an absolute URL pointing at us" is the question the
// consumers actually ask.
//
// (`lib/auth/index.ts` is the fourth consumer and is deliberately absent: it
// reads the accessor at MODULE SCOPE, so its value is fixed at import and no
// per-case stub can reach it. Its behaviour is the accessor's, already pinned.)

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The forms a deployed or local environment actually presents. */
const CONFIGURED = 'https://app.motir.co';

describe('seam: the public-project canonical URL ← the app-URL accessor', () => {
  it('a configured origin yields an absolute, parseable canonical URL', () => {
    vi.stubEnv('MOTIR_BASE_URL', CONFIGURED);

    const url = new URL(publicProjectUrl('MOTIR'));
    expect(url.origin).toBe(CONFIGURED);
    expect(url.pathname).toBe('/p/MOTIR');
    // The path half is composed independently of the origin half, so the two are
    // asserted to agree rather than assumed to.
    expect(url.pathname).toBe(publicProjectPath('MOTIR'));
  });

  it('a TRAILING SLASH on the configured value does not produce a double slash', () => {
    // The reason `resolveBaseUrlTrimmed` exists at all. A canonical URL with
    // `//p/MOTIR` is a different URL to a crawler than `/p/MOTIR`, and nothing
    // downstream of here would notice.
    vi.stubEnv('MOTIR_BASE_URL', `${CONFIGURED}///`);

    const url = new URL(publicProjectUrl('MOTIR'));
    expect(url.pathname).toBe('/p/MOTIR');
    expect(publicProjectUrl('MOTIR')).toBe(`${CONFIGURED}/p/MOTIR`);
  });

  it('an identifier is percent-encoded INSIDE the composed absolute URL', () => {
    vi.stubEnv('MOTIR_BASE_URL', CONFIGURED);
    const url = new URL(publicProjectUrl('a b/c'));
    expect(url.origin).toBe(CONFIGURED);
    expect(url.pathname).toBe('/p/a%20b%2Fc');
  });

  it('UNSET falls back to the dev origin and still builds an absolute URL', () => {
    // The case every local checkout and every CI test run is in. It has to
    // remain absolute — a relative canonical is invalid, and the routes render
    // either way, so nothing else would report it.
    vi.stubEnv('MOTIR_BASE_URL', undefined);

    expect(publicSiteOrigin()).toBe('http://localhost:3000');
    const url = new URL(publicProjectUrl('MOTIR'));
    expect(url.origin).toBe('http://localhost:3000');
    expect(url.pathname).toBe('/p/MOTIR');
  });

  it('the retired Vercel variables contribute NOTHING to a built link', () => {
    // MOTIR-2388 deleted three rungs rather than re-pointing them. The unit test
    // proves the accessor ignores them; this proves no link picks them up by
    // another route.
    vi.stubEnv('MOTIR_BASE_URL', undefined);
    vi.stubEnv('VERCEL_URL', 'deployment.vercel.app');
    vi.stubEnv('VERCEL_BRANCH_URL', 'branch.vercel.app');
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'production.vercel.app');
    vi.stubEnv('BETTER_AUTH_URL', 'https://betterauth.example');

    for (const built of [publicProjectUrl('MOTIR'), callbackUrl(), publicSiteOrigin()]) {
      expect(new URL(built).origin).toBe('http://localhost:3000');
    }
  });
});

describe('seam: the root layout’s metadataBase ← the app-URL accessor', () => {
  /** `Metadata['metadataBase']` is typed `string | URL | null`; the accessor's
   *  consumer builds a real `URL`, and every case below depends on that. */
  function metadataBaseOf(): URL {
    const { metadataBase } = buildRootMetadata();
    expect(metadataBase).toBeInstanceOf(URL);
    return metadataBase as URL;
  }

  it('constructs a URL from the resolved origin — the strictest consumer there is', () => {
    vi.stubEnv('MOTIR_BASE_URL', CONFIGURED);

    // `new URL(...)` THROWS on a value the other consumers would merely
    // concatenate wrong, so this is the one place a malformed origin is loud.
    expect(metadataBaseOf().origin).toBe(CONFIGURED);
  });

  it('survives every accepted form of the variable — trailing slash, padding, unset', () => {
    for (const [configured, expected] of [
      [`${CONFIGURED}/`, CONFIGURED],
      [`  ${CONFIGURED}  `, CONFIGURED],
      ['', 'http://localhost:3000'],
      ['   ', 'http://localhost:3000'],
      [undefined, 'http://localhost:3000'],
    ] as const) {
      vi.stubEnv('MOTIR_BASE_URL', configured);
      expect(() => buildRootMetadata(), String(configured)).not.toThrow();
      expect(metadataBaseOf().origin, String(configured)).toBe(expected);
    }
  });

  it('every relative asset resolves against the configured origin, not localhost', () => {
    vi.stubEnv('MOTIR_BASE_URL', CONFIGURED);
    // What `metadataBase` is FOR: Next resolves every relative OpenGraph /
    // canonical value against it. A silent revert to the fallback would ship
    // `http://localhost:3000/opengraph-image` into production's page head.
    expect(new URL('/opengraph-image', metadataBaseOf()).toString()).toBe(
      `${CONFIGURED}/opengraph-image`,
    );
  });
});

describe('seam: an OAuth redirect_uri ← the app-URL accessor', () => {
  it('the callback URL is absolute, on the configured origin, at the registered path', () => {
    vi.stubEnv('MOTIR_BASE_URL', CONFIGURED);
    const url = new URL(callbackUrl());
    expect(url.origin).toBe(CONFIGURED);
    expect(url.pathname).toBe('/api/gitlab/oauth/callback');
  });

  it('it survives being carried INSIDE another URL’s query, byte for byte', () => {
    // The consumer that punishes a wrong origin hardest: the provider compares
    // `redirect_uri` against the registered value and refuses the whole grant on
    // a mismatch, with an error the user sees and we cannot read. So the
    // assertion follows the value through the encode/decode round trip rather
    // than stopping at the builder.
    vi.stubEnv('MOTIR_BASE_URL', `${CONFIGURED}/`);
    vi.stubEnv('GITLAB_APP_CLIENT_ID', 'client-id');
    vi.stubEnv('GITLAB_APP_CLIENT_SECRET', 'client-secret');

    const authorize = new URL(buildAuthorizeUrl('state-token'));
    const redirect = authorize.searchParams.get('redirect_uri');

    expect(redirect).toBe(`${CONFIGURED}/api/gitlab/oauth/callback`);
    expect(redirect).not.toContain('//api/');
    expect(new URL(redirect!).origin).toBe(CONFIGURED);
  });
});

describe('the two accessors differ by exactly one thing, and consumers pick deliberately', () => {
  it('resolveBaseUrl is verbatim; resolveBaseUrlTrimmed is what concatenates safely', () => {
    vi.stubEnv('MOTIR_BASE_URL', `${CONFIGURED}/`);
    // Not a restatement of the unit test: it pins that the trailing slash the
    // untrimmed accessor preserves is exactly the difference the link builders
    // above depend on, so removing "the redundant one" would break them.
    expect(resolveBaseUrl()).toBe(`${CONFIGURED}/`);
    expect(resolveBaseUrlTrimmed()).toBe(CONFIGURED);
    expect(publicSiteOrigin()).toBe(resolveBaseUrlTrimmed());
  });
});
