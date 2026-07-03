import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { truncateAuthTables } from '../helpers/db';

// Story 7.10 · MOTIR-892 — the webhook ROUTE: signature verification is the gate,
// and it runs BEFORE the body is parsed or the service is touched. Real Postgres
// harness (the service is invoked on the happy path); no session mock — a webhook
// authenticates by HMAC signature, not a cookie.

const SECRET = 'test-webhook-secret';

function sign(rawBody: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
}

function post(rawBody: string, headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost:3000/api/github/webhook', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

async function importRoute() {
  const mod = await import('@/app/api/github/webhook/route');
  return mod.POST;
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('POST /api/github/webhook — signature gate', () => {
  it('rejects a MISSING signature 401 (before processing)', async () => {
    const POST = await importRoute();
    const body = JSON.stringify({ zen: 'x' });
    const res = await POST(post(body, { 'x-github-event': 'ping' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'GITHUB_WEBHOOK_INVALID_SIGNATURE' });
  });

  it('rejects a BAD signature 401', async () => {
    const POST = await importRoute();
    const body = JSON.stringify({ zen: 'x' });
    const res = await POST(
      post(body, { 'x-github-event': 'ping', 'x-hub-signature-256': 'sha256=deadbeef' }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a signature computed over a DIFFERENT body 401 (tamper)', async () => {
    const POST = await importRoute();
    const signed = sign(JSON.stringify({ a: 1 }));
    const tampered = JSON.stringify({ a: 2 });
    const res = await POST(
      post(tampered, { 'x-github-event': 'ping', 'x-hub-signature-256': signed }),
    );
    expect(res.status).toBe(401);
  });

  it('accepts a VALID signature and processes the event (200)', async () => {
    const POST = await importRoute();
    const body = JSON.stringify({ zen: 'Keep it simple' });
    const res = await POST(
      post(body, { 'x-github-event': 'ping', 'x-hub-signature-256': sign(body) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, result: { event: 'ignored' } });
  });

  it('returns 500 when the webhook secret is not configured', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', '');
    const POST = await importRoute();
    const body = JSON.stringify({ zen: 'x' });
    const res = await POST(
      post(body, { 'x-github-event': 'ping', 'x-hub-signature-256': 'sha256=abc' }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'GITHUB_WEBHOOK_NOT_CONFIGURED' });
  });

  it('returns 400 on a malformed JSON body (signature valid)', async () => {
    const POST = await importRoute();
    const body = 'not json{';
    const res = await POST(
      post(body, { 'x-github-event': 'ping', 'x-hub-signature-256': sign(body) }),
    );
    expect(res.status).toBe(400);
  });
});
