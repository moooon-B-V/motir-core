import { describe, expect, it, vi } from 'vitest';
import { deferRun } from '@/lib/jobs/engine/defer';
import {
  driveSupervisionInProcess,
  inProcessMemoSteps,
} from '@/lib/jobs/supervision/inProcessSteps';

// THE IN-PROCESS STAND-INS (Story MOTIR-3778 · Subtask MOTIR-3828) — what
// `job_step` and the worker's claim loop are to a caller with no queue row.
//
// Pure units, no database: what they stand in for is the ENGINE, and the engine
// is not what is under test here.

describe('the step memo', () => {
  it('executes an id ONCE and replays it thereafter', async () => {
    const inner = vi.fn(async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn());
    const body = vi.fn(async () => ({ container: 'c-1' }));
    const steps = inProcessMemoSteps({ run: inner });

    const first = await steps.run('index-boot:p1', body);
    const second = await steps.run('index-boot:p1', body);

    // ⚠️ THE DEFECT THIS EXISTS FOR. Without it every pass of a
    // self-rescheduling supervision re-executed the admission AND THE BOOT —
    // measured at 502 `admit` calls for a 500-poll supervision, and a container
    // per poll had the orchestrator not been a fake.
    expect(body).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('keys by id — two ids are two executions', async () => {
    const steps = inProcessMemoSteps({
      run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn(),
    });
    expect(await steps.run('a', async () => 1)).toBe(1);
    expect(await steps.run('b', async () => 2)).toBe(2);
    expect(await steps.run('a', async () => 99)).toBe(1);
  });

  it('does NOT memoize a THROW — a retry re-executes', async () => {
    // The step shim's own rule (`lib/jobs/engine/step.ts`): persisting a failure
    // would freeze a transient error permanently, and the run could never
    // recover.
    const steps = inProcessMemoSteps({
      run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn(),
    });
    let calls = 0;
    const flaky = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return 'ok';
    };

    await expect(steps.run('boot', flaky)).rejects.toThrow('transient');
    expect(await steps.run('boot', flaky)).toBe('ok');
    expect(calls).toBe(2);
  });
});

describe('the in-process claim loop', () => {
  it('re-invokes while the attempt DEFERS, waiting out each interval on the caller’s clock', async () => {
    const slept: number[] = [];
    let pass = 0;
    const at = new Date('2026-08-28T12:00:00.000Z');

    const outcome = await driveSupervisionInProcess(
      async () => {
        pass += 1;
        if (pass <= 3) deferRun(new Date(at.getTime() + pass * 1_000), `poll ${pass}`);
        return `settled after ${pass}`;
      },
      { sleep: async (ms) => void slept.push(ms), now: () => at },
    );

    expect(outcome).toBe('settled after 4');
    expect(slept).toEqual([1_000, 2_000, 3_000]);
  });

  it('never sleeps a NEGATIVE interval — a defer already in the past is due now', async () => {
    const slept: number[] = [];
    let pass = 0;
    await driveSupervisionInProcess(
      async () => {
        pass += 1;
        if (pass === 1) deferRun(new Date(Date.now() - 60_000), 'the interval already elapsed');
        return 'done';
      },
      { sleep: async (ms) => void slept.push(ms), now: () => new Date() },
    );
    expect(slept).toEqual([0]);
  });

  it('RETHROWS anything that is not a defer — a failure is not a suspension', async () => {
    const boom = new Error('the provider went away');
    await expect(
      driveSupervisionInProcess(
        async () => {
          throw boom;
        },
        { sleep: async () => undefined, now: () => new Date() },
      ),
    ).rejects.toBe(boom);
  });
});
