import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { defineJob } from '@/lib/jobs/defineJob';
import { dispatchEventToEngine } from '@/lib/jobs/engine/dispatcher';
import { JOB_ENGINE_JOBS_ENV } from '@/lib/jobs/engine/cutover';
import { parseIdempotencyTemplate, resolveIdempotencyKey } from '@/lib/jobs/engine/idempotency';
import { emailSend, EMAIL_SEND_IDEMPOTENCY } from '@/lib/jobs/definitions/emailSend';

// EVENT-LEVEL IDEMPOTENCY ON THE ENGINE (Story MOTIR-3415 · Subtask MOTIR-3459).
//
// `defineJob`'s `idempotency` option was declared by `email.send`, forwarded to
// Inngest, and dropped before `registerEngineJob` — the column existed, the value
// was written on every event, and nothing read it. Moving `email.send` to a lane
// without this would take a job whose whole point is send-exactly-once and
// quietly make it send-sometimes-twice, on the retry path nobody exercises by
// hand.
//
// Against REAL Postgres, because the guarantee is a UNIQUE CONSTRAINT and a mock
// cannot have one.

const ORIGINAL_ENV = process.env[JOB_ENGINE_JOBS_ENV];

// Two test jobs on the same event: one declaring a template, one declaring none.
// Registered at module scope, exactly as a real definition module is.
const DEDUPED_ID = 'test.idempotency-deduped';
const PLAIN_ID = 'test.idempotency-plain';

defineJob(
  {
    id: DEDUPED_ID as never,
    trigger: 'work-item/embedding.requested',
    idempotency: 'event.data.idempotencyKey',
  },
  () => ({ ok: true }),
);
defineJob({ id: PLAIN_ID as never, trigger: 'work-item/embedding.requested' }, () => ({
  ok: true,
}));

function route(...ids: string[]): void {
  process.env[JOB_ENGINE_JOBS_ENV] = ids.join(',');
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  delete process.env[JOB_ENGINE_JOBS_ENV];
});

afterEach(async () => {
  await truncateJobRuns();
  if (ORIGINAL_ENV === undefined) delete process.env[JOB_ENGINE_JOBS_ENV];
  else process.env[JOB_ENGINE_JOBS_ENV] = ORIGINAL_ENV;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const rowsFor = (jobId: string) => adminDb.jobQueueRun.findMany({ where: { jobId } });

describe('dedup by constraint', () => {
  it('collapses two same-key events to ONE queued run', async () => {
    route(DEDUPED_ID);
    const payload = { workspaceId: null, workItemId: 'wi_1', idempotencyKey: 'token-abc' };

    const first = await dispatchEventToEngine('work-item/embedding.requested', payload);
    const second = await dispatchEventToEngine('work-item/embedding.requested', payload);

    expect(first.enqueued).toEqual([DEDUPED_ID]);
    // The SECOND is reported as already-enqueued rather than failed — the
    // constraint doing its job is not an error.
    expect(second.enqueued).toEqual([]);
    expect(second.alreadyEnqueued).toEqual([DEDUPED_ID]);
    expect(second.failed).toEqual([]);

    expect(await rowsFor(DEDUPED_ID)).toHaveLength(1);
  });

  it('keeps two DIFFERENT keys as two runs', async () => {
    route(DEDUPED_ID);
    const base = { workspaceId: null, workItemId: 'wi_1' };

    await dispatchEventToEngine('work-item/embedding.requested', { ...base, idempotencyKey: 'k1' });
    await dispatchEventToEngine('work-item/embedding.requested', { ...base, idempotencyKey: 'k2' });

    const rows = await rowsFor(DEDUPED_ID);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.idempotencyKey).sort()).toEqual(['k1', 'k2']);
  });

  it('leaves a job declaring NO template completely unaffected', async () => {
    route(PLAIN_ID);
    const payload = { workspaceId: null, workItemId: 'wi_1', idempotencyKey: 'token-abc' };

    await dispatchEventToEngine('work-item/embedding.requested', payload);
    await dispatchEventToEngine('work-item/embedding.requested', payload);

    // Two identical events, two runs. The partial index excludes NULLs, so a job
    // with no template cannot be deduped by another job's key.
    const rows = await rowsFor(PLAIN_ID);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.idempotencyKey === null)).toBe(true);
  });

  it('does not dedupe an event that carries NO value for the template', async () => {
    route(DEDUPED_ID);
    const payload = { workspaceId: null, workItemId: 'wi_1' };

    await dispatchEventToEngine('work-item/embedding.requested', payload);
    await dispatchEventToEngine('work-item/embedding.requested', payload);

    // A missing value means "do not dedupe", never a synthesised placeholder —
    // which would collide every such event with every other one and drop all but
    // the first.
    expect(await rowsFor(DEDUPED_ID)).toHaveLength(2);
  });
});

describe('the CONCURRENT duplicate — the race the constraint exists for', () => {
  it('yields one row and a swallowed P2002, never two rows and never a throw', async () => {
    route(DEDUPED_ID);
    const payload = { workspaceId: null, workItemId: 'wi_1', idempotencyKey: 'racing-token' };

    // Genuinely concurrent against a warm pool. A check-then-insert would let
    // both reads see "no prior row" and both insert; this is the case a serial
    // test cannot see, and the reason the dedup is a constraint at all.
    const results = await Promise.all([
      dispatchEventToEngine('work-item/embedding.requested', payload),
      dispatchEventToEngine('work-item/embedding.requested', payload),
    ]);

    // Neither call threw — the constraint violation never reaches the caller.
    const enqueued = results.flatMap((r) => r.enqueued);
    const already = results.flatMap((r) => r.alreadyEnqueued);
    const failed = results.flatMap((r) => r.failed);

    expect(failed, 'a P2002 escaped as a failure').toEqual([]);
    // Exactly one winner, whichever it was.
    expect(enqueued).toEqual([DEDUPED_ID]);
    expect(already).toEqual([DEDUPED_ID]);
    expect(await rowsFor(DEDUPED_ID)).toHaveLength(1);
  });
});

describe('the resolver is TOTAL', () => {
  it('THROWS at registration on a template it cannot evaluate', () => {
    // The silent arm this forbids: keeping the option, returning null, and
    // quietly not deduplicating.
    expect(() =>
      defineJob(
        {
          id: 'test.idempotency-bad' as never,
          trigger: 'work-item/embedding.requested',
          idempotency: 'event.data.user.id',
        },
        () => ({ ok: true }),
      ),
    ).toThrow(/cannot evaluate/);
  });

  it('names the job and the supported form, so the failure is actionable', () => {
    expect(() => parseIdempotencyTemplate('some.job', 'event.ts')).toThrow(/some\.job/);
    expect(() => parseIdempotencyTemplate('some.job', 'event.ts')).toThrow(/event\.data\.<field>/);
  });

  it('accepts the one form in use, and tolerates surrounding whitespace', () => {
    expect(parseIdempotencyTemplate('j', 'event.data.idempotencyKey')).toBe('idempotencyKey');
    expect(parseIdempotencyTemplate('j', '  event.data.token  ')).toBe('token');
  });

  it('resolves null for no template, and for a non-string value', () => {
    expect(resolveIdempotencyKey(undefined, { idempotencyKey: 'k' }, 'j')).toBeNull();
    expect(
      resolveIdempotencyKey('event.data.idempotencyKey', { idempotencyKey: 7 }, 'j'),
    ).toBeNull();
    expect(
      resolveIdempotencyKey('event.data.idempotencyKey', { idempotencyKey: '' }, 'j'),
    ).toBeNull();
    expect(resolveIdempotencyKey('event.data.idempotencyKey', { idempotencyKey: 'k' }, 'j')).toBe(
      'k',
    );
  });
});

describe("email.send's Inngest behaviour is untouched", () => {
  it('still carries the same idempotency config, read off fn.opts', () => {
    // MOTIR-3413's boundary is that no job's observable behaviour changes. This
    // card adds an ENGINE reader for the option; the Inngest side must be
    // byte-identical, and `fn.opts` is what Inngest KEPT after construction
    // rather than what we passed in.
    const opts = (emailSend as unknown as { opts: Record<string, unknown> }).opts;
    expect(opts['idempotency']).toBe(EMAIL_SEND_IDEMPOTENCY);
    expect(opts['idempotency']).toBe('event.data.idempotencyKey');
  });

  it('declares a template the engine can actually evaluate', () => {
    // The one job in the tree with an `idempotency` option — if the engine could
    // not parse it, registration would already have thrown at import.
    expect(parseIdempotencyTemplate('email.send', EMAIL_SEND_IDEMPOTENCY)).toBe('idempotencyKey');
  });
});
