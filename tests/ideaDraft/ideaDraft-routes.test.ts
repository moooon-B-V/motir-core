import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';

// In-memory cookie store for `next/headers` — the claim route plants the
// `motir_pending_idea` cookie via setPendingIdea(), so we assert it lands here
// (mirrors tests/onboarding/pendingIdea.test.ts).
const cookieStore = new Map<string, { value: string; options?: unknown }>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const hit = cookieStore.get(name);
      return hit ? { name, value: hit.value } : undefined;
    },
    set: (name: string, value: string, options?: unknown) =>
      cookieStore.set(name, { value, options }),
    delete: (name: string) => void cookieStore.delete(name),
  }),
}));

import { truncateAuthTables } from '@/tests/helpers/db';
import { __resetRateLimitsForTest } from '@/lib/rateLimit/fixedWindow';
import { PENDING_IDEA_COOKIE } from '@/lib/onboarding/pendingIdea';

// Import the handlers AFTER the mock is registered.
const { POST, OPTIONS } = await import('@/app/api/idea-draft/route');
const claim = await import('@/app/api/idea-draft/[id]/claim/route');

const ALLOWED = 'https://motir.co';

beforeEach(async () => {
  await truncateAuthTables();
  __resetRateLimitsForTest();
  cookieStore.clear();
  process.env['MOTIR_MARKETING_ORIGIN'] = ALLOWED;
});
afterAll(async () => {
  await db.$disconnect();
});

function postReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/idea-draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/idea-draft — origin allowlist + CORS', () => {
  it('accepts an allowlisted origin and echoes ACAO', async () => {
    const res = await POST(postReq({ idea: 'an invoicing tool' }, { origin: ALLOWED }));
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('vary')).toContain('Origin');
    const body = (await res.json()) as { draftId: string };
    expect(body.draftId).toBeTruthy();
  });

  it('accepts a same-origin call (no Origin header) without CORS grant', async () => {
    const res = await POST(postReq({ idea: 'a same-origin idea' }));
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects a present-but-not-allowlisted origin with 403', async () => {
    const res = await POST(postReq({ idea: 'evil' }, { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('ORIGIN_NOT_ALLOWED');
    // Nothing stored for a forbidden origin.
    expect(await db.ideaDraft.count()).toBe(0);
  });

  it('fails closed when the allowlist env is unset', async () => {
    delete process.env['MOTIR_MARKETING_ORIGIN'];
    const res = await POST(postReq({ idea: 'x' }, { origin: ALLOWED }));
    expect(res.status).toBe(403);
  });

  it('answers an OPTIONS preflight for an allowlisted origin', async () => {
    const req = new Request('http://localhost/api/idea-draft', {
      method: 'OPTIONS',
      headers: { origin: ALLOWED },
    });
    const res = await OPTIONS(req);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('withholds CORS on an OPTIONS preflight from a foreign origin', async () => {
    const req = new Request('http://localhost/api/idea-draft', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });
    const res = await OPTIONS(req);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('POST /api/idea-draft — validation + rate limit', () => {
  it('400s a non-JSON body', async () => {
    const res = await POST(postReq('not json{', { origin: ALLOWED }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('BAD_REQUEST');
  });

  it('400s an empty idea', async () => {
    const res = await POST(postReq({ idea: '   ' }, { origin: ALLOWED }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('EMPTY_IDEA');
  });

  it('429s once the per-IP window is exhausted', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.7', origin: ALLOWED };
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) {
      last = await POST(postReq({ idea: `idea ${i}` }, ip));
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get('retry-after')).toBeTruthy();
    // The CORS grant is still present on the 429 so the marketing site can read it.
    expect(last!.headers.get('access-control-allow-origin')).toBe(ALLOWED);
  });
});

describe('POST /api/idea-draft/[id]/claim', () => {
  async function makeDraft(idea: string): Promise<string> {
    const res = await POST(postReq({ idea }, { origin: ALLOWED }));
    return ((await res.json()) as { draftId: string }).draftId;
  }

  it('claims a draft: returns the idea, plants the cookie, consumes the draft', async () => {
    const id = await makeDraft('a tool for freelancers to send invoices');

    const res = await claim.POST(new Request('http://localhost/claim', { method: 'POST' }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).idea).toBe('a tool for freelancers to send invoices');

    // The preserved-idea cookie is planted (Lax, so it survives the OAuth round-trip).
    const cookie = cookieStore.get(PENDING_IDEA_COOKIE);
    expect(cookie?.value).toBe('a tool for freelancers to send invoices');
    expect(cookie?.options).toMatchObject({ sameSite: 'lax', httpOnly: true });

    // Single-use: the draft row is gone.
    expect(await db.ideaDraft.count()).toBe(0);
  });

  it('404s a missing / forged / already-claimed id (graceful degrade)', async () => {
    const res = await claim.POST(new Request('http://localhost/claim', { method: 'POST' }), {
      params: Promise.resolve({ id: 'forged-id' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('DRAFT_NOT_FOUND');
    // No cookie planted on failure → the page falls back to a normal login.
    expect(cookieStore.has(PENDING_IDEA_COOKIE)).toBe(false);
  });

  it('does not re-claim a consumed draft', async () => {
    const id = await makeDraft('one-shot idea');
    await claim.POST(new Request('http://localhost/claim', { method: 'POST' }), {
      params: Promise.resolve({ id }),
    });
    const second = await claim.POST(new Request('http://localhost/claim', { method: 'POST' }), {
      params: Promise.resolve({ id }),
    });
    expect(second.status).toBe(404);
  });
});
