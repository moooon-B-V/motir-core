import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { truncateAuthTables } from '../helpers/db';

// Story 7.23 · MOTIR-1475 — the GitLab webhook ROUTE: the `X-Gitlab-Token` gate
// runs BEFORE the body is parsed or the service is touched. Unlike GitHub (an HMAC
// over the raw body), GitLab echoes the hook's configured secret verbatim, so the
// route constant-time-compares the header against `GITLAB_WEBHOOK_SECRET`. Real
// Postgres harness (the service is reached on the happy path); no session mock — a
// webhook authenticates by its token, not a cookie.

const SECRET = 'test-gitlab-webhook-secret';

function post(rawBody: string, headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost:3000/api/gitlab/webhook', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

async function importRoute() {
  const mod = await import('@/app/api/gitlab/webhook/route');
  return mod.POST;
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('GITLAB_WEBHOOK_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('POST /api/gitlab/webhook — token gate', () => {
  it('rejects a MISSING token 401 (before processing)', async () => {
    const POST = await importRoute();
    const res = await POST(
      post(JSON.stringify({ object_kind: 'push' }), { 'x-gitlab-event': 'Push Hook' }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'GITLAB_WEBHOOK_INVALID_SIGNATURE' });
  });

  it('rejects a WRONG token 401', async () => {
    const POST = await importRoute();
    const res = await POST(
      post(JSON.stringify({ object_kind: 'push' }), {
        'x-gitlab-event': 'Push Hook',
        'x-gitlab-token': 'not-the-secret',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('accepts a VALID token and processes the event (200)', async () => {
    const POST = await importRoute();
    const res = await POST(
      post(JSON.stringify({ object_kind: 'push', project: { id: 1 }, ref: 'refs/heads/main' }), {
        'x-gitlab-event': 'Push Hook',
        'x-gitlab-token': SECRET,
      }),
    );
    expect(res.status).toBe(200);
    // A push hook is DISPATCHED (the code-graph feed, MOTIR-1476); an unconnected
    // project is a clean `unknown_repo` no-op — the route still acks 200.
    expect(await res.json()).toMatchObject({
      ok: true,
      result: { event: 'push', outcome: 'unknown_repo' },
    });
  });

  it('returns 500 when the webhook secret is not configured', async () => {
    vi.stubEnv('GITLAB_WEBHOOK_SECRET', '');
    const POST = await importRoute();
    const res = await POST(
      post(JSON.stringify({ object_kind: 'push' }), {
        'x-gitlab-event': 'Push Hook',
        'x-gitlab-token': 'anything',
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'GITLAB_WEBHOOK_NOT_CONFIGURED' });
  });

  it('returns 400 on a malformed JSON body (token valid)', async () => {
    const POST = await importRoute();
    const res = await POST(
      post('not json{', { 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': SECRET }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'GITLAB_WEBHOOK_MALFORMED_BODY' });
  });
});
