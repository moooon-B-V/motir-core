import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';

// CROSS-ORIGIN ACCESS TO THE PUBLIC READ SURFACE (MOTIR-4114 ·
// `public-surface-hosts.md` AMENDMENT 4 §D, the ANONYMOUS-DIRECT mechanism).
//
// ⚠️ THE ASSERTION THIS FILE EXISTS FOR IS A NEGATIVE ONE:
// `Access-Control-Allow-Credentials` is never sent. Everything else here is
// plumbing; that one header is the difference between "a browser may read a
// public page's JSON" and "a browser may make an authenticated request from an
// origin that renders other people's markdown". It is asserted on every arm
// below rather than once, because it is the header a future change adds by
// reflex when something does not work.

const PUBLIC_ORIGIN = 'https://motir.co';
const APP_ORIGIN = 'https://app.motir.co';

const proxySrc = readFileSync(join(process.cwd(), 'proxy.ts'), 'utf8');
const authSrc = readFileSync(join(process.cwd(), 'lib/auth/index.ts'), 'utf8');

const request = (path: string, init?: { origin?: string; method?: string }) =>
  new NextRequest(new URL(path, APP_ORIGIN), {
    method: init?.method ?? 'GET',
    ...(init?.origin === undefined ? {} : { headers: { origin: init.origin } }),
  });

let previous: string | undefined;
beforeEach(() => {
  previous = process.env['MOTIR_PUBLIC_SITE_URL'];
  process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC_ORIGIN;
});
afterEach(() => {
  if (previous === undefined) delete process.env['MOTIR_PUBLIC_SITE_URL'];
  else process.env['MOTIR_PUBLIC_SITE_URL'] = previous;
});

describe('a request from the public site', () => {
  it('is allowed, named exactly, and varies on Origin', () => {
    const res = proxy(request('/api/public/p/ACME/items', { origin: PUBLIC_ORIGIN }));

    expect(res.headers.get('access-control-allow-origin')).toBe(PUBLIC_ORIGIN);
    // Without Vary, a shared cache can hand one origin's allow header to another.
    expect(res.headers.get('vary')).toBe('Origin');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('gets its PREFLIGHT answered here, without reaching a handler', () => {
    const res = proxy(
      request('/api/public/p/ACME/subscribe', { origin: PUBLIC_ORIGIN, method: 'OPTIONS' }),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(PUBLIC_ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('Content-Type');
    expect(res.headers.get('access-control-max-age')).toBeTruthy();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

describe('any other origin', () => {
  it("gets NO cors headers — refusal is the browser's job, not ours", () => {
    // Answering an explicit denial would be theatre: CORS is enforced in the
    // browser, and a non-browser caller sending no Origin is entitled to the
    // same public data.
    const res = proxy(request('/api/public/explore', { origin: 'https://evil.example' }));

    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('a near-miss origin is refused — the check is equality, not a prefix', () => {
    for (const origin of [
      'https://motir.co.evil.test',
      'http://motir.co',
      'https://sub.motir.co',
      'https://motir.co:8443',
    ]) {
      const res = proxy(request('/api/public/explore', { origin }));
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('a preflight from a disallowed origin answers 204 with nothing to allow', () => {
    const res = proxy(
      request('/api/public/explore', { origin: 'https://evil.example', method: 'OPTIONS' }),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-methods')).toBeNull();
  });

  it('a caller with NO Origin at all is untouched — curl, a crawler, a feed reader', () => {
    const res = proxy(request('/api/public/p/ACME/changelog.xml'));

    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.status).toBe(200);
  });
});

describe('what the CORS entry must NOT reach', () => {
  it('does not put the sign-in bounce in front of any /api path', () => {
    // The hazard the matcher entry creates. Every other /api route answers its
    // own callers — the CLI, the MCP surface, the webhooks — and a 307 to a
    // sign-in page is not something any of them can read.
    const res = proxy(request('/api/public/explore'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('the CORS branch runs BEFORE the moved-surface redirect and the session bounce', () => {
    const corsAt = proxySrc.indexOf('const cors = publicSurfaceCors(request)');
    const movedAt = proxySrc.indexOf('const moved = publicSiteRedirect(request)');
    const cookieAt = proxySrc.indexOf('const sessionCookie = getSessionCookie(request)');

    expect(corsAt).toBeGreaterThan(-1);
    expect(corsAt).toBeLessThan(movedAt);
    expect(corsAt).toBeLessThan(cookieAt);
  });
});

describe('§4 — the session cookie is not widened, and this card did not widen it', () => {
  // The condition the whole host split rests on. AMENDMENT 4 §B is why it is
  // asserted HERE as well as in the auth suite: this is the card where the
  // pressure to widen arrives, because it is the card making a button work from
  // a page that cannot see the session.
  it('the session cookie carries no Domain', () => {
    const attributes = authSrc.slice(
      authSrc.indexOf('session_token:'),
      authSrc.indexOf('session_token:') + 600,
    );

    expect(attributes).toContain('httpOnly: true');
    expect(attributes).toContain("sameSite: 'lax'");
    expect(attributes).not.toMatch(/\bdomain\s*:/i);
  });

  it('nothing in the auth configuration enables cross-subdomain cookies', () => {
    expect(authSrc).not.toContain('crossSubDomainCookies');
    expect(authSrc).not.toMatch(/domain:\s*['"`]\./);
  });

  it("and `sameSite: 'lax'` is what makes the hand-off necessary — not a preference", () => {
    // If this ever reads 'none', the hand-off in app/act/route.ts stops being
    // the only option and somebody will notice that a direct call now works.
    expect(authSrc).not.toContain("sameSite: 'none'");
  });
});
