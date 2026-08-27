import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A TERMINALLY FAILED JOB REACHES A PERSON (MOTIR-3606).
//
// ⚠️ WHAT THIS FILE IS ACTUALLY ASSERTING, because it is easy to read it as
// "captureException was called". `system.daily-health-check` dead-lettered every
// morning from 2026-08-04 to 2026-08-26 — 23 consecutive days — and nobody found
// out, because the only surfaces its verdict reached were `job_run` and the DLQ
// tab, both of which a person has to decide to go and look at. The probe was
// right; it had no consumer. So the property under test is that a terminal
// failure produces a signal that LEAVES the database, with enough on it for an
// alert rule to route it and for a reader to tell two faults on one job apart.
//
// The DELIVERY half — that an envelope really goes out over the wire — is
// `jobFailureDelivery.test.ts`, which runs the real SDK against a real socket.
// This file is about the CONTENTS.

const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

const { alertTerminalJobFailure } = await import('@/lib/monitoring/jobFailureAlert');

/** The error the health check actually threw, every night, for 23 nights. */
class IndexFleetImageUnpullableError extends Error {
  constructor() {
    super(
      "The fleet's INDEXER image cannot be pulled: registry.fly.io/motir-index-runners@sha256:0b4d…",
    );
    this.name = 'IndexFleetImageUnpullableError';
  }
}

function alertFor(error: unknown, overrides: Record<string, unknown> = {}) {
  alertTerminalJobFailure({
    functionId: 'system.daily-health-check',
    eventName: 'scheduled.system.daily-health-check',
    workspaceId: null,
    attempts: 1,
    engine: 'engine',
    error,
    ...overrides,
  } as Parameters<typeof alertTerminalJobFailure>[0]);
  return captureException.mock.calls[0] as [unknown, Record<string, unknown>];
}

beforeEach(() => {
  captureException.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('alertTerminalJobFailure — the signal that leaves the database', () => {
  it('reports the real error object, so the issue carries a stack rather than a string', () => {
    const error = new IndexFleetImageUnpullableError();
    const [reported] = alertFor(error);
    // ⚠️ THE ERROR ITSELF, not `serializeFailure(error)`. The ledger stores a
    // `{ message, stack, code }` shape because a JSON column is what it has; an
    // error reporter given that shape produces an issue titled `[object Object]`
    // with no frames. The two call sites hold the real throw — passing it on is
    // free and is the whole difference between a usable issue and a useless one.
    expect(reported).toBe(error);
  });

  it('tags the JOB ID, which is what an alert rule filters on', () => {
    const [, options] = alertFor(new IndexFleetImageUnpullableError());
    expect(options['tags']).toMatchObject({
      job_id: 'system.daily-health-check',
      job_engine: 'engine',
      job_terminal_failure: 'true',
    });
    expect(options['level']).toBe('error');
  });

  it('names the ENGINE, because the two lanes fail for different reasons', () => {
    // Mid-cutover a job can run on either lane, and "it only fails on the engine"
    // is the first thing worth knowing about a failure that started this week.
    const [, options] = alertFor(new Error('boom'), { engine: 'inngest' });
    expect((options['tags'] as Record<string, string>)['job_engine']).toBe('inngest');
  });

  it('collapses a RECURRING failure of one job into ONE issue', () => {
    // 23 identical failures are one problem. Sentry's default grouping splits on
    // stack frames, which would have produced 23 issues — a mailbox a person
    // learns to filter, which is the failure mode this card is about wearing
    // different clothes.
    const first = alertFor(new IndexFleetImageUnpullableError())[1];
    captureException.mockReset();
    const second = alertFor(new IndexFleetImageUnpullableError())[1];
    expect(first['fingerprint']).toEqual(second['fingerprint']);
    expect(first['fingerprint']).toEqual([
      'job-terminal-failure',
      'system.daily-health-check',
      'IndexFleetImageUnpullableError',
    ]);
  });

  it('does NOT collapse two DIFFERENT faults on the same job', () => {
    // `ScheduledJobsOverdueError` and `IndexFleetImageUnpullableError` both come
    // out of the daily health check and are unrelated. Folding them together
    // because they share a job id would hide the second behind the first for as
    // long as the first took to fix — and on 2026-08-22 the check caught a
    // genuinely overdue cron while it was already red for the image. That verdict
    // is exactly the one that must not be swallowed.
    const overdue = new Error('1 scheduled job(s) have not run since their previous tick');
    overdue.name = 'ScheduledJobsOverdueError';
    const a = alertFor(new IndexFleetImageUnpullableError())[1];
    captureException.mockReset();
    const b = alertFor(overdue)[1];
    expect(a['fingerprint']).not.toEqual(b['fingerprint']);
  });

  it('carries the event name, workspace and attempt count as context', () => {
    const [, options] = alertFor(new Error('boom'), {
      workspaceId: 'ws_123',
      attempts: 4,
    });
    expect(options['extra']).toEqual({
      eventName: 'scheduled.system.daily-health-check',
      workspaceId: 'ws_123',
      attempts: 4,
    });
  });

  it('fingerprints a NON-Error throw without crashing on it', () => {
    const [reported, options] = alertFor('a string was thrown');
    expect(reported).toBe('a string was thrown');
    expect(options['fingerprint']).toEqual([
      'job-terminal-failure',
      'system.daily-health-check',
      'UnknownError',
    ]);
  });

  it('SWALLOWS a transport failure — a notification may not fail a ledger write', () => {
    // ⚠️ THE POST-COMMIT RULE, and the one assertion here whose absence would be
    // a real regression rather than a worse issue title. `recordEngineTerminalFailure`
    // calls this on the path whose entire job is to survive a failure; a throw
    // here would take out the durable record of the very failure being reported.
    captureException.mockImplementation(() => {
      throw new Error('sentry transport exploded');
    });
    expect(() =>
      alertTerminalJobFailure({
        functionId: 'system.daily-health-check',
        eventName: 'scheduled.system.daily-health-check',
        workspaceId: null,
        attempts: 1,
        engine: 'engine',
        error: new Error('boom'),
      }),
    ).not.toThrow();
  });
});
