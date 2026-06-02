import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
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
import type { Prisma } from '@prisma/client';
import { captureConsoleEmails, runEmailSendJob } from '../helpers/jobs';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// Cross-cutting jobs invariants that close Story 1.6 (Subtask 1.6.6) — the ones
// that don't surface through the browser, complementing the user-visible flow in
// tests/e2e/jobs-flow.spec.ts. The card named three: scheduled-job firing,
// idempotency dedup across duplicate sends, and the DLQ-replay ↔ idempotency-
// window interaction. Two of them had to be adapted to the truth the 1.6.6
// forced-failure E2E uncovered — documented inline:
//
//   • Idempotency dedup ("two identical sends collapse to one run") is enforced
//     by the Inngest RUNTIME, not by our code. The in-process @inngest/test
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
});

describe('scheduled job', () => {
  it('the daily-health-check cron job writes a ledger row under the synthetic scheduled event name', async () => {
    const engine = new InngestTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();
    expect(result).toEqual(DAILY_HEALTH_CHECK_PAYLOAD);

    const runs = await db.jobRun.findMany();
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
    const run = (await db.jobRun.findMany())[0]!;
    expect(run.idempotencyKey).toBe('thread-me');

    // The dedup itself is enforced by Inngest (config expression), not our code.
    expect(EMAIL_SEND_IDEMPOTENCY).toBe('event.data.idempotencyKey');
    const spy = vi.spyOn(inngest, 'createFunction');
    try {
      defineJob({ id: 'email.send', idempotency: EMAIL_SEND_IDEMPOTENCY }, () => undefined);
      const config = spy.mock.calls.at(-1)?.[0] as { idempotency?: string } | undefined;
      expect(config?.idempotency).toBe('event.data.idempotencyKey');
    } finally {
      spy.mockRestore();
    }
  });

  it('the in-process harness does NOT dedup (so the runtime drop is an E2E concern, not a unit one)', async () => {
    // Documents the boundary honestly: running the same-key event twice in-process
    // produces TWO rows, because @inngest/test bypasses the runtime dedup layer.
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
    expect(await db.jobRun.count()).toBe(2);
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
      attempt: 0,
      idempotencyKey: 'window-key',
    });
    await jobRunsService.recordTerminalFailure({
      functionId: 'email.send',
      eventId: 'evt-replay-window',
      eventName: 'email.send',
      workspaceId: null,
      failure: { message: 'transient boom' },
      eventData: emailEvent({ idempotencyKey: 'window-key' }) as unknown as Prisma.InputJsonValue,
      attempts: 3,
    });
    const dlqId = (await db.jobRunDlq.findFirst())!.id;

    const sendSpy = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
    await withSystemContext((tx) => replayDLQ(dlqId, tx));
    // Capture the call BEFORE restoring — mockRestore() resets mock.calls.
    const sent = sendSpy.mock.calls[0]![0] as { data: { idempotencyKey?: string } };
    sendSpy.mockRestore();
    // The re-emit carries a DISTINCT key (original + a dlq-row-scoped suffix), so
    // Inngest's same-key dedup does NOT drop it — the operator's explicit replay
    // overrides idempotency, which is the corrected 1.6.6 behavior. (1.6.4 re-
    // emitted `window-key` unchanged and the runtime silently dropped it.)
    expect(sent.data.idempotencyKey).toBe(`window-key:replay:${dlqId}`);
    expect(sent.data.idempotencyKey).not.toBe('window-key');
  });
});
