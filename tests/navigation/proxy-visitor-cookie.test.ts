import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';

// THE `motir_visitor` COOKIE SURVIVES THE VISITOR TAB'S OWN TRAFFIC (MOTIR-6888).
//
// The cookie names the public project a Visitor is reading; every Visitor data
// door (`resolveReadActor`) and the member-link safety net (`visitorLinkRedirect`)
// read it. `clearVisitorCookie` wipes it on a real navigation to a member page, so
// a reader going back to their own workspace is not served the public project —
// and it spared a PREFETCH by reading `next-router-prefetch`, a header Next 16's
// proxy adapter deletes before the proxy runs. Every prefetch the Visitor page
// made of a member route with no Visitor view (the account menu's `/settings`)
// therefore read as a navigation and cleared the cookie mid-read.
//
// What decides now is where the request was FOLLOWED FROM: a same-origin Visitor
// view of the cookie's project keeps it; anything else clears it, as before.

const APP_ORIGIN = 'https://app.motir.co';
const SESSION = 'better-auth.session_token=probe-token';

function request(
  path: string,
  init: { visitor?: string; referer?: string; headers?: Record<string, string> } = {},
) {
  const cookies = [SESSION, ...(init.visitor ? [`motir_visitor=${init.visitor}`] : [])];
  return new NextRequest(new URL(path, APP_ORIGIN), {
    headers: {
      cookie: cookies.join('; '),
      ...(init.referer ? { referer: init.referer } : {}),
      ...init.headers,
    },
  });
}

/** Whether the response wipes the cookie (a `motir_visitor=` with `Max-Age=0`). */
function clears(res: Response): boolean {
  return res.headers.getSetCookie().some((c) => /^motir_visitor=;.*Max-Age=0/i.test(c));
}

describe('a request followed from the Visitor view keeps the cookie', () => {
  it('a member route with no Visitor view, prefetched or followed from the Visitor tab', async () => {
    // The prefetch Next actually sends: the flight headers are gone by the time
    // the proxy runs, so nothing but the referer says where it came from.
    const res = await proxy(
      request('/settings/account', { visitor: 'ACME', referer: `${APP_ORIGIN}/p/ACME/approvals` }),
    );
    expect(clears(res)).toBe(false);
  });

  it('a member route that HAS a Visitor view is still sent there, cookie intact', async () => {
    const res = await proxy(
      request('/approvals?page=2', { visitor: 'ACME', referer: `${APP_ORIGIN}/p/ACME/approvals` }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${APP_ORIGIN}/p/ACME/approvals?page=2`);
    expect(clears(res)).toBe(false);
  });
});

describe('every other member request clears it, exactly as before', () => {
  it('no referer — a typed address, a bookmark, a no-referrer tab', async () => {
    expect(clears(await proxy(request('/settings/account', { visitor: 'ACME' })))).toBe(true);
  });

  it('a member page as the referer — the reader has left the Visitor view', async () => {
    const res = await proxy(
      request('/boards', { visitor: 'ACME', referer: `${APP_ORIGIN}/settings/account` }),
    );
    expect(clears(res)).toBe(true);
  });

  it('a Visitor view of ANOTHER project, or of another origin, is not this cookie’s tab', async () => {
    expect(
      clears(
        await proxy(
          request('/settings/account', { visitor: 'ACME', referer: `${APP_ORIGIN}/p/OTHER/items` }),
        ),
      ),
    ).toBe(true);
    expect(
      clears(
        await proxy(
          request('/settings/account', {
            visitor: 'ACME',
            referer: 'https://evil.example/p/ACME/items',
          }),
        ),
      ),
    ).toBe(true);
  });

  it('a prefetch the proxy CAN still see (a `sec-purpose` hint) is spared, as it always was', async () => {
    const res = await proxy(
      request('/settings/account', { visitor: 'ACME', headers: { 'sec-purpose': 'prefetch' } }),
    );
    expect(clears(res)).toBe(false);
  });

  it('no cookie, nothing to clear', async () => {
    expect(clears(await proxy(request('/settings/account')))).toBe(false);
  });
});
