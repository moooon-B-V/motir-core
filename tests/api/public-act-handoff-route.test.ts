import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HANDOFF_FALLBACK_PATH } from '@/lib/publicProjects/returnTarget';
import { runAsCloudBuild } from '../helpers/cloudBuild';

runAsCloudBuild();

// `GET /act` — the HAND-OFF entry (MOTIR-4114 · `public-surface-hosts.md`
// AMENDMENT 4 §D/§F).
//
// Four properties, and the first two are the ones that matter:
//
//   1. It NEVER MUTATES. A GET reached by a link is reachable by an <img> tag on
//      any page in the world, so a hand-off that acted would be a CSRF
//      primitive. It resolves and redirects; the act happens on a surface the
//      visitor arrives at with a session and a form.
//   2. The return destination is ALLOW-LISTED before it is ever put in a
//      `Location`, whether or not there is a session.
//   3. A missing session REDIRECTS to sign-in carrying itself as `next`, so the
//      hand-off resumes rather than ending on a dashboard.
//   4. It is cloud-gated: there is nothing to hand off where public projects do
//      not exist.

const routeSrc = readFileSync(join(process.cwd(), 'app/act/route.ts'), 'utf8');

const getSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth', () => ({ getSession }));

const { GET } = await import('@/app/act/route');

const PUBLIC_ORIGIN = 'https://motir.co';
const RETURN_TO = 'https://motir.co/p/ACME/roadmap';

let previousPublicSite: string | undefined;
beforeAll(() => {
  previousPublicSite = process.env['MOTIR_PUBLIC_SITE_URL'];
  process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC_ORIGIN;
});
afterAll(() => {
  if (previousPublicSite === undefined) delete process.env['MOTIR_PUBLIC_SITE_URL'];
  else process.env['MOTIR_PUBLIC_SITE_URL'] = previousPublicSite;
});
afterEach(() => vi.clearAllMocks());

const act = (query: string) => GET(new Request(`https://app.motir.co/act${query}`));
const signedIn = () => getSession.mockResolvedValue({ user: { id: 'user_1' } });

describe('GET /act — signed in', () => {
  it('303s to the subject, carrying the intent and the validated return', async () => {
    signedIn();

    const res = await act(`?intent=follow&subject=ACME&return=${encodeURIComponent(RETURN_TO)}`);

    expect(res.status).toBe(303);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/p/ACME');
    expect(location.searchParams.get('act')).toBe('follow');
    expect(location.searchParams.get('return')).toBe(RETURN_TO);
  });

  it('accepts every intent the amendment hands off, and no others', async () => {
    signedIn();

    for (const intent of ['follow', 'vote', 'upvote', 'comment', 'request']) {
      const res = await act(
        `?intent=${intent}&subject=ACME&return=${encodeURIComponent(RETURN_TO)}`,
      );
      expect(new URL(res.headers.get('location') ?? '').searchParams.get('act')).toBe(intent);
    }

    // An unknown intent is not an error page — it is a person with a broken
    // link, so they go somewhere real. What must NOT happen is the intent being
    // reflected onward.
    const bogus = await act(
      `?intent=delete-everything&subject=ACME&return=${encodeURIComponent(RETURN_TO)}`,
    );
    expect(bogus.status).toBe(303);
    expect(bogus.headers.get('location')).toBe(RETURN_TO);
  });

  it('a missing subject also falls back to the return, not to a 4xx', async () => {
    signedIn();

    const res = await act(`?intent=follow&return=${encodeURIComponent(RETURN_TO)}`);

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(RETURN_TO);
  });
});

describe('GET /act — the return destination is never reflected', () => {
  const HOSTILE = [
    'https://evil.example/',
    '//evil.example',
    'https://motir.co.evil.test/p/ACME',
    'https://motir.co@evil.test/p/ACME',
    '/../',
    'javascript:alert(1)',
  ];

  it('refuses a hostile destination and uses the fixed fallback — signed in', async () => {
    signedIn();

    for (const hostile of HOSTILE) {
      const res = await act(`?intent=follow&subject=ACME&return=${encodeURIComponent(hostile)}`);
      const location = new URL(res.headers.get('location') ?? '');

      expect(location.origin).toBe('https://app.motir.co');
      expect(location.searchParams.get('return')).toBe(HANDOFF_FALLBACK_PATH);
      // The hostile string must not survive anywhere in the Location — not in a
      // path, not in a nested parameter.
      expect(res.headers.get('location')).not.toContain('evil');
      expect(res.headers.get('location')).not.toContain('javascript:');
    }
  });

  it('refuses it BEFORE the session is read — signed OUT gets the same treatment', async () => {
    // The ordering matters: validating after the session check would leave the
    // hostile value in the sign-in `next`, where it survives the round trip and
    // is honoured on the way back.
    getSession.mockResolvedValue(null);

    const res = await act('?intent=follow&subject=ACME&return=https%3A%2F%2Fevil.example');

    expect(res.headers.get('location')).not.toContain('evil');
  });
});

describe('GET /act — signed out', () => {
  it('303s to sign-in carrying ITSELF as `next`, so the hand-off resumes', async () => {
    getSession.mockResolvedValue(null);

    const res = await act(`?intent=vote&subject=ACME&return=${encodeURIComponent(RETURN_TO)}`);

    expect(res.status).toBe(303);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/sign-in');

    const next = new URL(location.searchParams.get('next') ?? '', 'https://app.motir.co');
    expect(next.pathname).toBe('/act');
    expect(next.searchParams.get('intent')).toBe('vote');
    expect(next.searchParams.get('subject')).toBe('ACME');
    expect(next.searchParams.get('return')).toBe(RETURN_TO);
  });

  it("the sign-in `next` is a same-origin PATH — what that page's own sanitiser accepts", async () => {
    // `sanitizeNextPath` rejects anything that is not a same-origin path, so a
    // `next` carrying an absolute URL would be silently dropped and the visitor
    // would land on a dashboard having lost the hand-off.
    getSession.mockResolvedValue(null);

    const res = await act(`?intent=follow&subject=ACME&return=${encodeURIComponent(RETURN_TO)}`);
    const next = new URL(res.headers.get('location') ?? '').searchParams.get('next') ?? '';

    expect(next.startsWith('/')).toBe(true);
    expect(next.startsWith('//')).toBe(false);
    expect(next).not.toMatch(/^https?:/);
  });
});

describe('GET /act — what it structurally is', () => {
  it('exports GET and nothing else — a hand-off that could write would be a CSRF primitive', () => {
    expect(routeSrc).toMatch(/export async function GET/);
    expect(routeSrc).not.toMatch(/export (async )?function (POST|PUT|PATCH|DELETE)/);
  });

  it('performs no write — it reaches no service at all', () => {
    expect(routeSrc).not.toContain('publicProjectsService');
    expect(routeSrc).not.toContain('publicFollowService');
    expect(routeSrc).not.toContain('publicRequestsService');
  });

  it('gates on the capability before reading a session', () => {
    expect(routeSrc.indexOf('publicSurfaceUnavailable()')).toBeLessThan(
      routeSrc.indexOf('await getSession()'),
    );
  });

  it('is ABSENT off-cloud', async () => {
    const previous = process.env['MOTIR_CLOUD'];
    delete process.env['MOTIR_CLOUD'];
    try {
      signedIn();
      const res = await act(`?intent=follow&subject=ACME&return=${encodeURIComponent(RETURN_TO)}`);
      expect(res.status).not.toBe(303);
      expect(getSession).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env['MOTIR_CLOUD'];
      else process.env['MOTIR_CLOUD'] = previous;
    }
  });
});
