import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { defineJob } from '@/lib/jobs/defineJob';
import { dispatchEventToEngine } from '@/lib/jobs/engine/dispatcher';
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

// Two test jobs, one declaring a template and one declaring none. Registered at
// module scope, exactly as a real definition module is.
//
// ⚠️ ONE TRIGGER EACH, NOT ONE SHARED (MOTIR-3418). They used to subscribe to a
// single real event and be selected between by the per-job cutover switch, so a
// dispatch enqueued only the routed one and `enqueued` named exactly the job under
// test. With one lane a dispatch enqueues EVERY subscriber, so a shared trigger
// returns both probes plus the real consumers of that event. The isolation the
// switch used to provide is now the trigger's job.
const DEDUPED_ID = 'test.idempotency-deduped';
const PLAIN_ID = 'test.idempotency-plain';
const DEDUPED_TRIGGER = 'test/idempotency-deduped.requested';
const PLAIN_TRIGGER = 'test/idempotency-plain.requested';

defineJob(
  {
    id: DEDUPED_ID as never,
    trigger: DEDUPED_TRIGGER as never,
    idempotency: 'event.data.idempotencyKey',
  },
  () => ({ ok: true }),
);
defineJob({ id: PLAIN_ID as never, trigger: PLAIN_TRIGGER as never }, () => ({
  ok: true,
}));

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterEach(async () => {
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const rowsFor = (jobId: string) => adminDb.jobQueueRun.findMany({ where: { jobId } });

describe('dedup by constraint', () => {
  it('collapses two same-key events to ONE queued run', async () => {
    const payload = { workspaceId: null, workItemId: 'wi_1', idempotencyKey: 'token-abc' };

    const first = await dispatchEventToEngine(DEDUPED_TRIGGER, payload);
    const second = await dispatchEventToEngine(DEDUPED_TRIGGER, payload);

    expect(first.enqueued).toEqual([DEDUPED_ID]);
    // The SECOND is reported as already-enqueued rather than failed — the
    // constraint doing its job is not an error.
    expect(second.enqueued).toEqual([]);
    expect(second.alreadyEnqueued).toEqual([DEDUPED_ID]);
    expect(second.failed).toEqual([]);

    expect(await rowsFor(DEDUPED_ID)).toHaveLength(1);
  });

  it('keeps two DIFFERENT keys as two runs', async () => {
    const base = { workspaceId: null, workItemId: 'wi_1' };

    await dispatchEventToEngine(DEDUPED_TRIGGER, { ...base, idempotencyKey: 'k1' });
    await dispatchEventToEngine(DEDUPED_TRIGGER, { ...base, idempotencyKey: 'k2' });

    const rows = await rowsFor(DEDUPED_ID);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.idempotencyKey).sort()).toEqual(['k1', 'k2']);
  });

  it('leaves a job declaring NO template completely unaffected', async () => {
    const payload = { workspaceId: null, workItemId: 'wi_1', idempotencyKey: 'token-abc' };

    await dispatchEventToEngine(PLAIN_TRIGGER, payload);
    await dispatchEventToEngine(PLAIN_TRIGGER, payload);

    // Two identical events, two runs. The partial index excludes NULLs, so a job
    // with no template cannot be deduped by another job's key.
    const rows = await rowsFor(PLAIN_ID);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.idempotencyKey === null)).toBe(true);
  });

  it('does not dedupe an event that carries NO value for the template', async () => {
    const payload = { workspaceId: null, workItemId: 'wi_1' };

    await dispatchEventToEngine(DEDUPED_TRIGGER, payload);
    await dispatchEventToEngine(DEDUPED_TRIGGER, payload);

    // A missing value means "do not dedupe", never a synthesised placeholder —
    // which would collide every such event with every other one and drop all but
    // the first.
    expect(await rowsFor(DEDUPED_ID)).toHaveLength(2);
  });
});

describe('the CONCURRENT duplicate — the race the constraint exists for', () => {
  it('yields one row and a swallowed P2002, never two rows and never a throw', async () => {
    const payload = { workspaceId: null, workItemId: 'wi_1', idempotencyKey: 'racing-token' };

    // Genuinely concurrent against a warm pool. A check-then-insert would let
    // both reads see "no prior row" and both insert; this is the case a serial
    // test cannot see, and the reason the dedup is a constraint at all.
    const results = await Promise.all([
      dispatchEventToEngine(DEDUPED_TRIGGER, payload),
      dispatchEventToEngine(DEDUPED_TRIGGER, payload),
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

describe("email.send's declared idempotency is untouched", () => {
  it('still carries the same idempotency config, read off the registered definition', () => {
    // MOTIR-3413's boundary is that no job's observable behaviour changes. This
    // assertion is the byte-for-byte statement of that for the one job in the tree
    // carrying an `idempotency` template, and MOTIR-3418 did not touch it — only
    // where it is READ from. It used to come off the vendor function object's
    // `opts`, which was what the SDK KEPT after construction rather than what we
    // passed in; there is no construction now, so the declaration and the
    // registration are the same object.
    expect(emailSend.idempotency).toBe(EMAIL_SEND_IDEMPOTENCY);
    expect(emailSend.idempotency).toBe('event.data.idempotencyKey');
  });

  it('declares a template the engine can actually evaluate', () => {
    // The one job in the tree with an `idempotency` option — if the engine could
    // not parse it, registration would already have thrown at import.
    expect(parseIdempotencyTemplate('email.send', EMAIL_SEND_IDEMPOTENCY)).toBe('idempotencyKey');
  });
});
