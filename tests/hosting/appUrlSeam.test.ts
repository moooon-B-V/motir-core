import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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

// ── MOTIR-3881 — the PUBLIC SITE origin, split from the application origin ──
//
// The two questions this repository used to answer with one variable. The suite
// above feeds `MOTIR_BASE_URL` to the absolute-link builders; this one asserts
// which of them follows the PUBLIC variable and which stays on the application,
// because after the split those are different hosts and the difference is
// invisible while they happen to be equal.

const PUBLIC_SITE = 'https://motir.co';

describe('seam: the PUBLIC-SITE origin ← its own variable (MOTIR-3881)', () => {
  it('a configured public origin moves the public-project URL off the application host', () => {
    vi.stubEnv('MOTIR_BASE_URL', CONFIGURED);
    vi.stubEnv('MOTIR_PUBLIC_SITE_URL', PUBLIC_SITE);

    const url = new URL(publicProjectUrl('MOTIR'));
    expect(url.origin).toBe(PUBLIC_SITE);
    expect(url.pathname).toBe('/p/MOTIR');
    // …and the application accessor is untouched by it.
    expect(resolveBaseUrlTrimmed()).toBe(CONFIGURED);
  });

  it('⚠️ UNSET resolves to the APPLICATION origin — the ordering guarantee, not a convenience', () => {
    // This is the deployed state until `motir.co` renders these pages
    // (MOTIR-3932 / MOTIR-3877). While it holds, every canonical and sitemap
    // entry keeps naming the host that is actually serving the page. Setting the
    // variable early would point them all at a host that does not serve them
    // yet, and nothing would throw.
    vi.stubEnv('MOTIR_BASE_URL', CONFIGURED);
    vi.stubEnv('MOTIR_PUBLIC_SITE_URL', undefined);

    expect(publicSiteOrigin()).toBe(CONFIGURED);
    expect(new URL(publicProjectUrl('MOTIR')).origin).toBe(CONFIGURED);
  });

  it("an EMPTY value counts as unset — a secret cleared to '' is a misconfiguration, not an origin", () => {
    vi.stubEnv('MOTIR_BASE_URL', CONFIGURED);
    vi.stubEnv('MOTIR_PUBLIC_SITE_URL', '   ');

    expect(publicSiteOrigin()).toBe(CONFIGURED);
  });

  it('a TRAILING SLASH on the public value does not produce a double slash', () => {
    vi.stubEnv('MOTIR_BASE_URL', CONFIGURED);
    vi.stubEnv('MOTIR_PUBLIC_SITE_URL', `${PUBLIC_SITE}///`);

    expect(publicProjectUrl('MOTIR')).toBe(`${PUBLIC_SITE}/p/MOTIR`);
  });

  it('with NEITHER set, a local checkout still builds an absolute URL', () => {
    vi.stubEnv('MOTIR_BASE_URL', undefined);
    vi.stubEnv('MOTIR_PUBLIC_SITE_URL', undefined);

    const url = new URL(publicProjectUrl('MOTIR'));
    expect(url.origin).toBe('http://localhost:3000');
  });

  // ── the single-reader rule, as a tree grep ────────────────────────────────
  it('exactly ONE module reads each origin variable', () => {
    const roots = ['app', 'lib', 'components', 'packages'];
    const readers = (name: string) =>
      roots
        .flatMap((root) => sourceFilesUnder(join(process.cwd(), root)))
        .filter((file) =>
          new RegExp(`process\\.env\\[.${name}.\\]`).test(readFileSync(file, 'utf8')),
        )
        .map((file) => relative(process.cwd(), file))
        .sort();

    // A second reader is a second answer to a question each module exists to
    // answer once — the drift `lib/baseUrl.ts`'s own comment was written against.
    expect(readers('MOTIR_BASE_URL')).toEqual(['lib/baseUrl.ts']);
    expect(readers('MOTIR_PUBLIC_SITE_URL')).toEqual(['lib/publicProjects/urls.ts']);
    // The tenant BASE domain (Story MOTIR-3878 · MOTIR-4215) — the namespace
    // every customer subdomain hangs off. Same rule, and it matters more here
    // than for the two above: this value is not merely where a link points, it
    // is what HOSTNAMES ARE MINTED FROM — into the database, into DNS
    // instructions a customer follows, into a certificate request. Two readers
    // disagreeing would mint addresses under two namespaces.
    expect(readers('MOTIR_PUBLIC_TENANT_DOMAIN')).toEqual(['lib/publicAddresses/tenantDomain.ts']);
    // The records that POINT a customer hostname at us (MOTIR-4278, ADR §10
    // AMENDMENT 1). The rule bites hardest here of all four: these values are
    // not minted into anything of ours, they are COPIED BY A CUSTOMER into a
    // zone we do not control, and a second reader answering differently sends
    // one customer's domain somewhere the other reader does not know about.
    for (const name of [
      'MOTIR_PUBLIC_ADDRESS_CNAME_TARGET',
      'MOTIR_PUBLIC_ADDRESS_A_RECORDS',
      'MOTIR_PUBLIC_ADDRESS_AAAA_RECORDS',
    ]) {
      expect(readers(name), name).toEqual(['lib/publicAddresses/pointingRecords.ts']);
    }
  });
});

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

/** Every `.ts`/`.tsx` source file under `dir`, skipping build output. */
function sourceFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFilesUnder(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}
