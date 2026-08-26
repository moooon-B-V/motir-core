import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomToken } from '../helpers/random';

// Bug MOTIR-3507 · Subtask MOTIR-3515 — the Resend delivery webhook: signature
// verification is the gate and it runs BEFORE the body is parsed or the service
// is touched, and the state it writes only ever moves FORWARD. Real Postgres
// harness (the service is invoked on the happy path); no session mock — a
// webhook authenticates by HMAC signature, not a cookie.
//
// Two properties here are worth more than the happy path, because both are
// things a provider does routinely and neither is visible in a green demo:
//
//   1. EVERY reachable outcome answers 2xx, including the ones that change
//      nothing. A receiver that errors makes the provider retry, and no number
//      of retries produces a row we do not hold — it only risks Resend
//      disabling the endpoint and taking the events we DO want with it.
//   2. Events arrive out of order and more than once. A `delivery_delayed`
//      emitted during a retry can land after the delivery it preceded, and
//      un-delivering a delivered message would be a lie the operator surface
//      then shows.

const SECRET_BYTES = Buffer.from('a-test-signing-key-for-motir-3515-webhook');
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sign(id: string, timestamp: number, rawBody: string): string {
  return `v1,${createHmac('sha256', SECRET_BYTES)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64')}`;
}

/** A signed delivery, with any header overridable to exercise the gate. */
function post(rawBody: string, over: Partial<Record<string, string>> = {}): NextRequest {
  const id = over['svix-id'] ?? `msg_${randomToken()}`;
  const timestamp = over['svix-timestamp'] ?? String(nowSeconds());
  const headers: Record<string, string> = {
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': over['svix-signature'] ?? sign(id, Number(timestamp), rawBody),
    'content-type': 'application/json',
  };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete headers[key];
    else headers[key] = value;
  }
  return new NextRequest('http://localhost:3000/api/resend/webhook', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

function event(type: string, emailId: string): string {
  return JSON.stringify({
    type,
    created_at: new Date().toISOString(),
    data: { email_id: emailId, to: ['alice@example.com'] },
  });
}

async function importRoute() {
  const mod = await import('@/app/api/resend/webhook/route');
  return mod.POST;
}

/** Seed one accepted delivery and return the provider message id it carries. */
async function seedDelivery(state?: string): Promise<string> {
  const providerMessageId = `msg_${randomToken()}`;
  await adminDb.emailDelivery.create({
    data: {
      providerMessageId,
      provider: 'resend',
      recipient: 'alice@example.com',
      template: 'password-reset',
      workspaceId: null,
      ...(state === undefined ? {} : { state: state as 'accepted' }),
    },
  });
  return providerMessageId;
}

async function stateOf(providerMessageId: string): Promise<string | undefined> {
  const row = await adminDb.emailDelivery.findUnique({ where: { providerMessageId } });
  return row?.state;
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  vi.stubEnv('RESEND_WEBHOOK_SECRET', SECRET);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  // The delivery rows this file writes carry a null workspace_id, so the
  // workspace cascade never reaches them — cleared explicitly, and after.
  await truncateJobRuns();
  vi.resetModules();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('POST /api/resend/webhook — the signature gate', () => {
  it('rejects a delivery with NO signature headers 401, before touching the database', async () => {
    const POST = await importRoute();
    const messageId = await seedDelivery();

    const res = await POST(
      post(event('email.delivered', messageId), {
        'svix-id': undefined,
        'svix-timestamp': undefined,
        'svix-signature': undefined,
      }),
    );

    expect(res.status).toBe(401);
    expect(await stateOf(messageId)).toBe('accepted');
  });

  it('rejects a TAMPERED body 401 — the signature covers the bytes, not the shape', async () => {
    const POST = await importRoute();
    const messageId = await seedDelivery();
    const id = `msg_${randomToken()}`;
    const timestamp = nowSeconds();
    const honest = event('email.delivered', messageId);

    // Signed for the honest body, sent with a bounce instead.
    const res = await POST(
      post(event('email.bounced', messageId), {
        'svix-id': id,
        'svix-timestamp': String(timestamp),
        'svix-signature': sign(id, timestamp, honest),
      }),
    );

    expect(res.status).toBe(401);
    expect(await stateOf(messageId)).toBe('accepted');
  });

  it('rejects a STALE timestamp 401, so a captured delivery cannot be replayed later', async () => {
    const POST = await importRoute();
    const messageId = await seedDelivery();
    const id = `msg_${randomToken()}`;
    const stale = nowSeconds() - 60 * 60;
    const body = event('email.delivered', messageId);

    // Correctly signed FOR that timestamp — only the age is wrong, which is
    // exactly what a replayed capture looks like.
    const res = await POST(
      post(body, {
        'svix-id': id,
        'svix-timestamp': String(stale),
        'svix-signature': sign(id, stale, body),
      }),
    );

    expect(res.status).toBe(401);
    expect(await stateOf(messageId)).toBe('accepted');
  });

  it('rejects a timestamp far in the FUTURE 401 — the window is two-sided', async () => {
    const POST = await importRoute();
    const messageId = await seedDelivery();
    const id = `msg_${randomToken()}`;
    const ahead = nowSeconds() + 60 * 60;
    const body = event('email.delivered', messageId);

    const res = await POST(
      post(body, {
        'svix-id': id,
        'svix-timestamp': String(ahead),
        'svix-signature': sign(id, ahead, body),
      }),
    );

    expect(res.status).toBe(401);
  });

  it('accepts a signature offered alongside OTHERS — a rotation must not drop deliveries', async () => {
    const POST = await importRoute();
    const messageId = await seedDelivery();
    const id = `msg_${randomToken()}`;
    const timestamp = nowSeconds();
    const body = event('email.delivered', messageId);
    const good = sign(id, timestamp, body).slice('v1,'.length);

    const res = await POST(
      post(body, {
        'svix-id': id,
        'svix-timestamp': String(timestamp),
        // The old secret's signature first, then the new one — which is how a
        // rotation looks on the wire.
        'svix-signature': `v1,c2lnbmVkLXdpdGgtdGhlLW9sZC1zZWNyZXQ= v1,${good}`,
      }),
    );

    expect(res.status).toBe(200);
    expect(await stateOf(messageId)).toBe('delivered');
  });

  it('answers 500 when no secret is configured — a misconfig, not a bad signature', async () => {
    vi.stubEnv('RESEND_WEBHOOK_SECRET', '');
    const POST = await importRoute();

    const res = await POST(post(event('email.delivered', 'msg_x')));

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'RESEND_WEBHOOK_NOT_CONFIGURED' });
  });

  it('answers 400 for a malformed body that is nonetheless correctly signed', async () => {
    const POST = await importRoute();

    const res = await POST(post('this is not json'));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'RESEND_WEBHOOK_MALFORMED_BODY' });
  });
});

describe('POST /api/resend/webhook — the delivery events', () => {
  it.each([
    ['email.delivered', 'delivered'],
    ['email.bounced', 'bounced'],
    ['email.complained', 'complained'],
    ['email.delivery_delayed', 'delayed'],
  ])('moves the message to its state on %s', async (type, expected) => {
    const POST = await importRoute();
    const messageId = await seedDelivery();

    const res = await POST(post(event(type, messageId)));

    expect(res.status).toBe(200);
    expect(await stateOf(messageId)).toBe(expected);
  });

  it('stamps lastEventAt when it applies a transition', async () => {
    const POST = await importRoute();
    const messageId = await seedDelivery();

    await POST(post(event('email.delivered', messageId)));

    const row = await adminDb.emailDelivery.findUnique({
      where: { providerMessageId: messageId },
    });
    expect(row?.lastEventAt).toBeInstanceOf(Date);
  });

  it('ACKS an event for a message we hold no row for — never 404, never an error', async () => {
    const POST = await importRoute();

    // Every message sent before the delivery record shipped looks like this,
    // and so does every send through a provider that issues no id. Answering
    // an error would make Resend retry something no retry can fix.
    const res = await POST(post(event('email.delivered', `msg_${randomToken()}`)));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: { outcome: 'unknown_message' } });
  });

  it('ignores an event type we do not subscribe to', async () => {
    const POST = await importRoute();
    const messageId = await seedDelivery();

    const res = await POST(post(event('email.opened', messageId)));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: { outcome: 'ignored' } });
    expect(await stateOf(messageId)).toBe('accepted');
  });

  it('ignores a body carrying no message id rather than throwing', async () => {
    const POST = await importRoute();

    const res = await POST(post(JSON.stringify({ type: 'email.delivered', data: {} })));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: { outcome: 'ignored' } });
  });
});

describe('POST /api/resend/webhook — order and repetition', () => {
  it('is a no-op on a DUPLICATE of the same event', async () => {
    const POST = await importRoute();
    const messageId = await seedDelivery();

    await POST(post(event('email.delivered', messageId)));
    const second = await POST(post(event('email.delivered', messageId)));

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ result: { outcome: 'not_newer' } });
    expect(await stateOf(messageId)).toBe('delivered');
  });

  it('does NOT un-deliver a message when a late delivery_delayed arrives after it', async () => {
    const POST = await importRoute();
    const messageId = await seedDelivery();

    await POST(post(event('email.delivered', messageId)));
    await POST(post(event('email.delivery_delayed', messageId)));

    // The delay was emitted while Resend was still retrying; it says nothing
    // about a message that has since landed.
    expect(await stateOf(messageId)).toBe('delivered');
  });

  it('does NOT reopen a bounced message with a later delivered event', async () => {
    const POST = await importRoute();
    const messageId = await seedDelivery();

    await POST(post(event('email.bounced', messageId)));
    await POST(post(event('email.delivered', messageId)));

    expect(await stateOf(messageId)).toBe('bounced');
  });

  it('DOES record a complaint that follows a delivery — the normal sequence', async () => {
    const POST = await importRoute();
    const messageId = await seedDelivery();

    // A recipient has to open the mail to mark it as spam, so this pair always
    // arrives in this order and the complaint is the more important fact.
    await POST(post(event('email.delivered', messageId)));
    await POST(post(event('email.complained', messageId)));

    expect(await stateOf(messageId)).toBe('complained');
  });

  it('lets a delayed message go on to be delivered', async () => {
    const POST = await importRoute();
    const messageId = await seedDelivery();

    await POST(post(event('email.delivery_delayed', messageId)));
    await POST(post(event('email.delivered', messageId)));

    expect(await stateOf(messageId)).toBe('delivered');
  });
});
