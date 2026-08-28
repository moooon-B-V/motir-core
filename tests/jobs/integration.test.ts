import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { JobTestEngine } from '../helpers/jobs';
import { db } from '@/lib/db';
import { defineJob } from '@/lib/jobs/defineJob';
import { replayDLQ } from '@/lib/jobs/dlq';
import { EMAIL_SEND_IDEMPOTENCY } from '@/lib/jobs/definitions/emailSend';
import {
  dailyHealthCheck,
  DAILY_HEALTH_CHECK_PAYLOAD,
} from '@/lib/jobs/definitions/dailyHealthCheck';
import { jobRunsService } from '@/lib/services/jobRunsService';
import { withSystemContext } from '@/lib/workspaces/context';
import type { EmailSendData } from '@/lib/jobs/types';
import type { Prisma } from '@/generated/prisma/client';
import { captureConsoleEmails, runEmailSendJob, seedHealthyJobSchedules } from '../helpers/jobs';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// Cross-cutting jobs invariants that close Story 1.6 (Subtask 1.6.6) — the ones
// that don't surface through the browser, complementing the user-visible flow in
// tests/e2e/jobs-flow.spec.ts. The card named three: scheduled-job firing,
// idempotency dedup across duplicate sends, and the DLQ-replay ↔ idempotency-
// window interaction. Two of them had to be adapted to the truth the 1.6.6
// forced-failure E2E uncovered — documented inline:
//
//   • Idempotency dedup ("two identical sends collapse to one run") is enforced
//     by the Inngest RUNTIME, not by our code. The in-process the in-process JobTestEngine
//     harness does not run that dedup layer (same documented boundary as
//     email-send.test.ts), so a unit test CANNOT honestly show "two events → one
//     row" — it would just run the handler twice. What's unit-true is the WIRING
//     (the config carries the dedup expression) and the key threading onto the
//     ledger. The actual drop is observed against the real dev server: the
//     jobs-flow replay scenario proved it (re-emitting the UNCHANGED key was
//     dropped — PRODECT_FINDINGS #40).
//
//   • The card's "DLQ replay does NOT bypass the idempotency window (a replay
//     within 24h is a no-op)" describes the 1.6.4 behavior — which made the
//     operator's Replay button a silent no-op exactly when it's used (right after
//     fixing a transient failure). PRODECT_FINDINGS #40 REVERSED that: replay now
//     RE-SHAPES the key so it deliberately escapes the window and actually re-
//     runs. So the invariant below asserts the corrected behavior.

function emailEvent(overrides: Partial<EmailSendData> = {}): EmailSendData {
  return {
    workspaceId: null,
    idempotencyKey: 'integ-key-1',
    to: 'integ@example.com',
    template: 'password-reset',
    data: { recipientName: 'Integ User', resetUrl: 'http://localhost:3000/reset/integ' },
    ...overrides,
  } as EmailSendData;
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('scheduled job', () => {
  it('the daily-health-check cron job writes a ledger row under the synthetic scheduled event name', async () => {
    // The health check now carries the MOTIR-1970 schedule-health probe, which
    // fails the run when a cron job has stopped firing. This test is about the
    // scheduled-path LEDGER, so make the schedules healthy first; the probe's own
    // behaviour is covered in `schedule-health.test.ts`.
    await seedHealthyJobSchedules();

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();
    // `toMatchObject`, not `toEqual`: the payload also carries the schedule
    // report, which is not what this test is pinning.
    expect(result).toMatchObject(DAILY_HEALTH_CHECK_PAYLOAD);

    // The seed skips this function, so its own row is the only one.
    const runs = await adminDb.jobRun.findMany({
      where: { functionId: 'system.daily-health-check' },
    });
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.functionId).toBe('system.daily-health-check');
    // The ledger event name is the synthetic scheduled.{id} — NOT Inngest's
    // internal cron-timer event — so scheduled + event-triggered runs are uniform
    // for the dashboard.
    expect(run.eventName).toBe('scheduled.system.daily-health-check');
    expect(run.status).toBe('succeeded');
    expect(run.workspaceId).toBeNull(); // system job → untenanted
    expect(run.finishedAt).not.toBeNull();
  });
});

describe('idempotency', () => {
  it('threads the idempotency key from the event onto the ledger row, and the dedup expression is wired', async () => {
    const emails = captureConsoleEmails();
    try {
      await runEmailSendJob(emailEvent({ idempotencyKey: 'thread-me' }));
    } finally {
      emails.restore();
    }
    // The handler ran once and recorded the key — this is the correlation the
    // operator dashboard shows and the value the runtime dedups ON.
    const run = (await adminDb.jobRun.findMany())[0]!;
    expect(run.idempotencyKey).toBe('thread-me');

    // The dedup itself is enforced by Inngest (config expression), not our code.
    expect(EMAIL_SEND_IDEMPOTENCY).toBe('event.data.idempotencyKey');
    const def = defineJob(
      { id: 'email.send', idempotency: EMAIL_SEND_IDEMPOTENCY },
      () => undefined,
    );
    expect(def.idempotency).toBe('event.data.idempotencyKey');
  });

  it('the in-process harness does NOT dedup (so the runtime drop is an E2E concern, not a unit one)', async () => {
    // Documents the boundary honestly: running the same-key event twice in-process
    // produces TWO rows, because the in-process JobTestEngine bypasses the runtime dedup layer.
    // The REAL drop (two events → one run) is an Inngest-platform behavior, proven
    // against the dev server in jobs-flow.spec.ts. We assert the boundary so a
    // future reader doesn't mistake "two rows here" for a dedup bug.
    const emails = captureConsoleEmails();
    try {
      await runEmailSendJob(emailEvent({ idempotencyKey: 'dup-key' }));
      await runEmailSendJob(emailEvent({ idempotencyKey: 'dup-key' }));
    } finally {
      emails.restore();
    }
    const jobRunCount = await adminDb.jobRun.count();
    expect(jobRunCount).toBe(2);
  });
});

describe('DLQ replay ↔ idempotency window (finding #40)', () => {
  it('replay re-shapes the idempotency key so it escapes the dedup window and actually re-runs', async () => {
    // Seed a dead-lettered email.send (idempotency-keyed) via the real terminal-
    // failure path.
    await jobRunsService.recordStart({
      workspaceId: null,
      functionId: 'email.send',
      eventName: 'email.send',
      eventId: 'evt-replay-window',
      lane: 'engine',
      attempt: 0,
      idempotencyKey: 'window-key',
    });
    await jobRunsService.recordTerminalFailure({
      functionId: 'email.send',
      eventId: 'evt-replay-window',
      lane: 'engine',
      eventName: 'email.send',
      workspaceId: null,
      failure: { message: 'transient boom' },
      eventData: emailEvent({ idempotencyKey: 'window-key' }) as unknown as Prisma.InputJsonValue,
      attempts: 3,
    });
    const dlqId = (await adminDb.jobRunDlq.findFirst())!.id;

    await withSystemContext((tx) => replayDLQ(dlqId, tx));

    // ⚠️ READ OFF THE ROW, NOT OFF A SPY (MOTIR-3418). This used to spy the vendor
    // transport, because a replay was a re-`send`. A replay is now a `job_event` +
    // `job_queue` pair written straight into the queue, so the durable row IS the
    // observation — a strictly better one, since it is also what the dedup index
    // is enforced against.
    const replayed = await adminDb.jobEvent.findFirstOrThrow({
      where: { name: 'email.send' },
      orderBy: { receivedAt: 'desc' },
    });
    const sent = replayed.data as { idempotencyKey?: string };
    // The re-emit carries a DISTINCT key (original + a dlq-row-scoped suffix), so
    // the `(job_id, idempotency_key)` partial unique index does NOT swallow it —
    // the operator's explicit replay overrides idempotency, which is the corrected
    // 1.6.6 behaviour. (1.6.4 re-emitted `window-key` unchanged and it was
    // silently dropped.)
    expect(sent.idempotencyKey).toBe(`window-key:replay:${dlqId}`);
    expect(sent.idempotencyKey).not.toBe('window-key');
    // …and the queue row it created carries the same key, which is the half the
    // index actually reads.
    const queued = await adminDb.jobQueueRun.findFirstOrThrow({
      where: { eventId: replayed.id },
    });
    expect(queued.idempotencyKey).toBe(`window-key:replay:${dlqId}`);
  });
});
