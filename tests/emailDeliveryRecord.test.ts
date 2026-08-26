import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailDeliveryService } from '@/lib/services/emailDeliveryService';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from './helpers/db';
import { randomToken } from './helpers/random';

// The transactional-mail DELIVERY record (Bug MOTIR-3507 · Subtask MOTIR-3513),
// against a real Postgres — the motir-core convention, no mocks below the
// provider's own fetch.
//
// What this file is for: `job_run` says whether the SEND succeeded, which for a
// real provider means only "the provider accepted the POST". A `succeeded` run
// next to a bounced invitation is what hid MOTIR-3507 for a day. These tests
// pin the other half — that every accepted message leaves exactly one row,
// keyed on the provider's own id, so the delivery events MOTIR-3515 ingests
// have something to land on.
//
// The single most important property here is a NEGATIVE one: nothing in the
// recording path may ever fail a send. By the time a row is written the
// provider has already taken the message, so an error escaping would fail a job
// whose email is on its way and the retry would deliver it twice. Several cases
// below exist only to hold that line.

const API_KEY = 'test-resend-key';
const FROM = 'Motir <no-reply@motir.co>';
const MESSAGE_ID = 'a3f1c2d4-0000-4000-8000-0000000003513';

/** The payload shape the `email.send` job hands the service. */
function payload(over: Record<string, unknown> = {}) {
  return {
    to: 'alice@example.com',
    template: 'password-reset' as const,
    data: { recipientName: 'Alice', resetUrl: 'https://app.motir.co/reset-password/tok_abc' },
    workspaceId: null,
    idempotencyKey: `tok_${randomToken()}`,
    ...over,
  };
}

describe('the delivery record (MOTIR-3513)', () => {
  const original: Record<string, string | undefined> = {};
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await truncateAuthTables();
    await truncateJobRuns();
    for (const key of ['EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM']) {
      original[key] = process.env[key];
    }
    process.env['EMAIL_PROVIDER'] = 'resend';
    process.env['RESEND_API_KEY'] = API_KEY;
    process.env['EMAIL_FROM'] = FROM;
    // ⚠️ A FRESH Response PER CALL, never one shared object. A Response body is
    // a stream that can be read ONCE, so `mockResolvedValue(new Response(…))`
    // hands every call the same already-consumed body and the second send sees
    // an empty one. That silently turns a two-send test into "one id and one
    // null" — which is how this file's dedup case first passed for the wrong
    // reason. (It also demonstrated the guard doing its job: the unreadable
    // body yielded a null id and a successful send rather than a throw.)
    fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ id: MESSAGE_ID }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // `email_delivery` rows for a SYSTEM email carry a null workspace_id, so
    // the workspace cascade never reaches them — the same property `job_run`
    // has. Clear them explicitly, and AFTER the test rather than before, so a
    // row this file wrote cannot leak into the next one.
    await truncateJobRuns();
    vi.resetModules();
  });

  /**
   * `sendEmail` is resolved EAGERLY at module load, so the only way to drive
   * the real resend arm through the real service is to reset the module graph
   * and re-import it under this file's env — the same technique
   * tests/emailServiceProviderSeam.test.ts uses. Every layer below the stubbed
   * fetch is the shipped code.
   */
  async function loadEmailService() {
    vi.resetModules();
    const { emailService } = await import('@/lib/services/emailService');
    return emailService;
  }

  it('writes exactly ONE row at `accepted`, carrying the provider id and the correlation', async () => {
    const emailService = await loadEmailService();
    const msg = payload({ runId: 'run_abc123', eventId: 'evt_abc123' });

    const result = await emailService.send(msg as Parameters<typeof emailService.send>[0]);

    expect(result.providerMessageId).toBe(MESSAGE_ID);
    const rows = await adminDb.emailDelivery.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerMessageId: MESSAGE_ID,
      provider: 'resend',
      recipient: 'alice@example.com',
      template: 'password-reset',
      state: 'accepted',
      workspaceId: null,
      idempotencyKey: msg.idempotencyKey,
      runId: 'run_abc123',
      eventId: 'evt_abc123',
    });
    // Nothing has been heard from the provider yet — that is MOTIR-3515's job.
    expect(rows[0]?.lastEventAt).toBeNull();
  });

  it('does NOT write a second row when a retried send is deduped to the same message', async () => {
    const emailService = await loadEmailService();

    // Two sends, both answered with the SAME id — which is exactly what Resend
    // does for a repeat carrying the same Idempotency-Key.
    await emailService.send(payload() as Parameters<typeof emailService.send>[0]);
    await emailService.send(payload() as Parameters<typeof emailService.send>[0]);

    const rows = await adminDb.emailDelivery.findMany();
    expect(rows).toHaveLength(1);
  });

  it('records an accepted send whose body carried no id, rather than dropping it', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 202 }));
    const emailService = await loadEmailService();

    const result = await emailService.send(payload() as Parameters<typeof emailService.send>[0]);

    expect(result.providerMessageId).toBeNull();
    const rows = await adminDb.emailDelivery.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerMessageId).toBeNull();
    expect(rows[0]?.state).toBe('accepted');
  });

  it('gives each id-less send its OWN row — the unique index admits many nulls', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 202 }));
    const emailService = await loadEmailService();

    await emailService.send(payload() as Parameters<typeof emailService.send>[0]);
    await emailService.send(payload() as Parameters<typeof emailService.send>[0]);

    expect(await adminDb.emailDelivery.count()).toBe(2);
  });

  it('writes NO row when the provider REJECTED the send', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ statusCode: 422, name: 'validation_error', message: 'bad' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const emailService = await loadEmailService();

    await expect(
      emailService.send(payload() as Parameters<typeof emailService.send>[0]),
    ).rejects.toThrow();

    expect(await adminDb.emailDelivery.count()).toBe(0);
  });

  describe('recording never fails a send', () => {
    it('returns null instead of throwing when the owning workspace has vanished', async () => {
      // A workspace id that no longer exists — production's hard tenant
      // deletion, and the E2E harness's between-test TRUNCATE, both look like
      // this to a job that was already in flight. The FK trips, and the send is
      // still a send.
      const row = await emailDeliveryService.recordAccepted({
        providerMessageId: `msg_${randomToken()}`,
        provider: 'resend',
        recipient: 'alice@example.com',
        template: 'password-reset',
        workspaceId: 'ws_that_never_existed',
      });

      expect(row).toBeNull();
      expect(await adminDb.emailDelivery.count()).toBe(0);
    });

    it('returns the EXISTING row when the same provider id is recorded twice', async () => {
      const providerMessageId = `msg_${randomToken()}`;
      const first = await emailDeliveryService.recordAccepted({
        providerMessageId,
        provider: 'resend',
        recipient: 'alice@example.com',
        template: 'password-reset',
        workspaceId: null,
      });
      const second = await emailDeliveryService.recordAccepted({
        providerMessageId,
        provider: 'resend',
        recipient: 'alice@example.com',
        template: 'password-reset',
        workspaceId: null,
      });

      expect(first?.id).toBeDefined();
      expect(second?.id).toBe(first?.id);
      expect(await adminDb.emailDelivery.count()).toBe(1);
    });
  });
});
