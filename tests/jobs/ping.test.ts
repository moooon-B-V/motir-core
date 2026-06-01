import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import { systemPing, SYSTEM_PING_PAYLOAD } from '@/lib/jobs/definitions/systemPing';
import { truncateJobRuns } from '../helpers/db';

// Smoke test for the background-jobs runtime (Story 1.6 · Subtask 1.6.2). Runs
// the `system.ping` function IN-PROCESS via @inngest/test's InngestTestEngine —
// no live dev server, no cloud (the CI-harness surface validated in 1.6.1,
// finding #30). Asserts the durable contract the wrapper provides:
//   1. the function resolves to its static payload, and
//   2. the defineJob wrapper persisted a job_run row flipped to `succeeded`,
//      with the bookkeeping fields populated.

beforeEach(async () => {
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
});

// Drive the function with its REAL triggering event. Without an explicit
// `events`, @inngest/test mocks a synthetic `inngest/function.invoked` event
// (finding #30 sharp edge #7), which would make the recorded event name wrong.
const PING_EVENT = { name: 'system.ping', data: {} } as const;

describe('system.ping smoke job', () => {
  it('runs to completion and returns the static payload', async () => {
    const engine = new InngestTestEngine({ function: systemPing, events: [PING_EVENT] });
    const { result } = await engine.execute();

    expect(result).toEqual(SYSTEM_PING_PAYLOAD);
  });

  it('writes a succeeded job_run row via the defineJob wrapper', async () => {
    const engine = new InngestTestEngine({ function: systemPing, events: [PING_EVENT] });
    await engine.execute();

    const runs = await db.jobRun.findMany();
    expect(runs).toHaveLength(1);

    const run = runs[0]!;
    expect(run.functionId).toBe('system.ping');
    expect(run.eventName).toBe('system.ping');
    expect(run.status).toBe('succeeded');
    // System job → untenanted.
    expect(run.workspaceId).toBeNull();
    // Lifecycle fields filled by recordSuccess.
    expect(run.finishedAt).not.toBeNull();
    expect(run.durationMs).not.toBeNull();
    expect(run.durationMs!).toBeGreaterThanOrEqual(0);
    expect(run.failure).toBeNull();
    // eventId falls back to the runId when the synthetic event has no id.
    expect(run.eventId.length).toBeGreaterThan(0);
  });
});
