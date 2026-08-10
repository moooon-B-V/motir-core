import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The seam between the email SERVICE and the wired production provider
// (MOTIR-1127). tests/emailResendProvider.test.ts proves the provider builds
// the right request from an EmailMessage; this file proves the one thing that
// only shows up when the two halves are composed: the `idempotencyKey` the
// `email.send` event carries actually REACHES the provider, so a job retry of
// an accepted send is deduped at Resend and not just at Inngest's event
// boundary. Assert it at the provider's own layer and a service that silently
// dropped the field would still pass.
//
// No mocks: `sendEmail` is resolved EAGERLY at module load, so the only way to
// exercise the resend arm through the real emailService is to set the env and
// re-import the module graph. That is what resetModules + dynamic import do
// here — every layer below the fetch call is the shipped code.

const API_KEY = 'test-resend-key';
const FROM = 'Motir <no-reply@motir.co>';

async function loadEmailServiceWithResendProvider() {
  vi.resetModules();
  const { emailService } = await import('@/lib/services/emailService');
  return emailService;
}

describe('emailService → provider seam', () => {
  const original: Record<string, string | undefined> = {};
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const key of ['EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM']) {
      original[key] = process.env[key];
    }
    process.env['EMAIL_PROVIDER'] = 'resend';
    process.env['RESEND_API_KEY'] = API_KEY;
    process.env['EMAIL_FROM'] = FROM;
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'a3f1c2d4-0000-4000-8000-000000000002' }), {
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
    // Drop the resend-bound module graph so no later file inherits a provider
    // resolved against this file's env.
    vi.resetModules();
  });

  it("threads the event's idempotencyKey down to the provider's Idempotency-Key header", async () => {
    const emailService = await loadEmailServiceWithResendProvider();

    // Exactly the payload shape the email.send job hands the service: a
    // TransactionalEmail plus the background-job envelope (EmailSendData).
    await emailService.send({
      to: 'alice@example.com',
      template: 'password-reset',
      data: { recipientName: 'Alice', resetUrl: 'https://app.motir.co/reset-password/tok_abc123' },
      workspaceId: null,
      idempotencyKey: 'tok_abc123',
    } as Parameters<typeof emailService.send>[0]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('tok_abc123');

    // And the rendered template still arrives intact — threading the envelope
    // field must not have displaced the body the template produced.
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['to']).toBe('alice@example.com');
    expect(body['from']).toBe(FROM);
    expect(String(body['subject'])).not.toBe('');
    expect(String(body['html'])).toContain('https://app.motir.co/reset-password/tok_abc123');
    expect(String(body['text'])).toContain('https://app.motir.co/reset-password/tok_abc123');
  });

  it('sends no Idempotency-Key when a caller dispatches without the job envelope', async () => {
    const emailService = await loadEmailServiceWithResendProvider();

    await emailService.send({
      to: 'bob@example.com',
      template: 'password-reset',
      data: { recipientName: 'Bob', resetUrl: 'https://app.motir.co/reset-password/tok_def456' },
    });

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers).not.toHaveProperty('Idempotency-Key');
  });

  it('propagates the provider failure to the caller rather than swallowing it', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ statusCode: 422, name: 'invalid_from_address', message: 'no' }),
        {
          status: 422,
        },
      ),
    );
    const emailService = await loadEmailServiceWithResendProvider();

    // The job wrapper's retry/dead-letter machinery only sees failures that
    // escape the service — a swallowed one would look like a delivered email.
    await expect(
      emailService.send({
        to: 'carol@example.com',
        template: 'password-reset',
        data: {
          recipientName: 'Carol',
          resetUrl: 'https://app.motir.co/reset-password/tok_ghi789',
        },
      }),
    ).rejects.toThrowError(/invalid_from_address/);
  });
});
