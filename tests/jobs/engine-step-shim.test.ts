import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobStepRepository } from '@/lib/repositories/jobStepRepository';
import {
  createStepApi,
  isJobStepYield,
  JobStepResultNotSerializableError,
  JobStepYield,
  parseSleepMs,
} from '@/lib/jobs/engine/step';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// The `step` SHIM (Story MOTIR-3414 · Subtask MOTIR-3422), against a real
// Postgres.
//
// The card's acceptance criteria are deliberately behavioural rather than
// structural, and this file follows them literally:
//
//   * "a run that fails after step 3 and is retried re-executes only steps 4
//     onward — asserted by a test that inspects WHICH HANDLERS ACTUALLY RAN, not
//     by inspecting `job_step` rows." So every test below counts executions in a
//     local array. Reading the table back would assert that the shim wrote what
//     the shim wrote; counting executions asserts the thing the handler
//     experiences.
//   * "`step.sleep` survives a WORKER RESTART — it must genuinely restart, not
//     simulate." A restart is modelled the only way it can be in-process and
//     still be honest: the step API and every closure are DISCARDED and rebuilt
//     from nothing but the run id, exactly as a fresh process would. Nothing
//     carries over except the database. See the restart describe block.

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

let seq = 0;

/** A run to hang steps off. Returns its id and workspace, the shim's whole scope. */
async function makeRun(): Promise<{ runId: string; workspaceId: string }> {
  seq += 1;
  const user = await usersService.createUser({
    email: `shim-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Shim ${seq}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Shim WS ${seq}`,
    ownerUserId: user.id,
  });
  const run = await adminDb.jobQueueRun.create({
    data: {
      jobId: 'email.send',
      eventName: 'email.send',
      workspaceId: workspace.id,
      runAt: new Date(),
      maxAttempts: 3,
    },
  });
  return { runId: run.id, workspaceId: workspace.id };
}

describe('step.run — memoization', () => {
  it('executes once and REPLAYS the stored result on a second call', async () => {
    const { runId, workspaceId } = await makeRun();
    const step = createStepApi({ runId, workspaceId });
    const ran: string[] = [];

    const first = await step.run('compute', () => {
      ran.push('compute');
      return { total: 41 + 1 };
    });
    const second = await step.run('compute', () => {
      ran.push('compute');
      return { total: -1 };
    });

    expect(first).toEqual({ total: 42 });
    // The second call returns the FIRST result, and the handler that would have
    // produced -1 never ran at all.
    expect(second).toEqual({ total: 42 });
    expect(ran).toEqual(['compute']);
  });

  it('a run that fails after step 3 re-executes ONLY steps 4 onward', async () => {
    const { runId, workspaceId } = await makeRun();
    const ran: string[] = [];
    let failAtFour = true;

    // The handler is written once and invoked twice, exactly as a retry invokes
    // it: same code, same step ids, no knowledge that it is a replay.
    async function handler(): Promise<string> {
      const step = createStepApi({ runId, workspaceId });
      await step.run('one', () => {
        ran.push('one');
        return 1;
      });
      await step.run('two', () => {
        ran.push('two');
        return 2;
      });
      await step.run('three', () => {
        ran.push('three');
        return 3;
      });
      await step.run('four', () => {
        ran.push('four');
        if (failAtFour) throw new Error('boom at four');
        return 4;
      });
      await step.run('five', () => {
        ran.push('five');
        return 5;
      });
      return 'done';
    }

    await expect(handler()).rejects.toThrow('boom at four');
    expect(ran).toEqual(['one', 'two', 'three', 'four']);

    ran.length = 0;
    failAtFour = false;
    await expect(handler()).resolves.toBe('done');

    // THE ASSERTION THE CARD ASKS FOR: steps 1–3 did not run again; step 4 —
    // which threw and so was not memoized — did; step 5 ran for the first time.
    expect(ran).toEqual(['four', 'five']);
  });

  it('a step that THROWS is not memoized — the retry re-executes it', async () => {
    const { runId, workspaceId } = await makeRun();
    const step = createStepApi({ runId, workspaceId });
    let attempts = 0;

    await expect(
      step.run('flaky', () => {
        attempts += 1;
        throw new Error('transient');
      }),
    ).rejects.toThrow('transient');

    // If a failure were memoized, the transient error would be frozen forever
    // and the run could never recover — which is the whole point.
    const stored = await withSystemContext((tx) =>
      jobStepRepository.findByRunAndStep(runId, 'flaky', tx),
    );
    expect(stored).toBeNull();

    const recovered = await step.run('flaky', () => {
      attempts += 1;
      return 'ok';
    });
    expect(recovered).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('scopes the memo to the RUN — a different run re-executes the same step id', async () => {
    const a = await makeRun();
    const b = await makeRun();
    const ran: string[] = [];
    const fn = () => {
      ran.push('x');
      return 'v';
    };

    await createStepApi(a).run('same-id', fn);
    await createStepApi(b).run('same-id', fn);

    // A retry is a new attempt of one run; a re-dispatch is a new run. Only the
    // first must skip.
    expect(ran).toEqual(['x', 'x']);
  });
});

describe('step.run — the JSON boundary', () => {
  it('returns a Date as a STRING on the FIRST execution, not only on replay', async () => {
    const { runId, workspaceId } = await makeRun();
    const step = createStepApi({ runId, workspaceId });
    const when = new Date('2026-08-23T12:00:00.000Z');

    const first = await step.run('stamp', () => ({ finishedAt: when }));
    const replay = await step.run('stamp', () => ({ finishedAt: new Date(0) }));

    // THIS is the criterion the card pins, and the assertion is deliberately
    // about the FIRST value. An implementation that returned the in-process
    // `Date` here would pass every local test and then throw in production the
    // first time a run resumed — the shim must not be more faithful in-process
    // than it is on resume.
    expect(typeof (first as { finishedAt: unknown }).finishedAt).toBe('string');
    // ⚠️ The double cast is not test noise — it is the finding. `step.run<T>`
    // is DECLARED to return `T`, so TypeScript believes `finishedAt` is a
    // `Date` while at runtime it is a string. That gap is inherited from
    // Inngest's own signature and is a property of the step contract rather
    // than of this shim: any step whose result is typed with a `Date` is
    // statically lying about what a replay hands back. Preserving the lie is
    // deliberate — closing it would mean changing the declared return type,
    // which would break the 58 call sites this card exists not to touch.
    expect((first as unknown as { finishedAt: string }).finishedAt).toBe(
      '2026-08-23T12:00:00.000Z',
    );
    expect(replay).toEqual(first);
  });

  it('drops `undefined` members and returns null for an undefined result — both paths alike', async () => {
    const { runId, workspaceId } = await makeRun();
    const step = createStepApi({ runId, workspaceId });

    const obj = await step.run('partial', () => ({ kept: 1, dropped: undefined }));
    expect(obj).toEqual({ kept: 1 });
    expect(Object.hasOwn(obj as object, 'dropped')).toBe(false);

    const nothing = await step.run('void', () => {
      /* returns undefined */
    });
    expect(nothing).toBeNull();
    // And the replay agrees, which is what "one behaviour, both paths" means.
    expect(await step.run('void', () => 'never runs')).toBeNull();
  });

  it('REFUSES a non-JSON-safe result, naming the step', async () => {
    const { runId, workspaceId } = await makeRun();
    const step = createStepApi({ runId, workspaceId });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    // Deliberately NOT the degrade-to-null `defineJob` applies to a run's ledger
    // output: a step result is a value the handler goes on to use, and a silent
    // null would surface only on the replay path.
    await expect(step.run('cyclic', () => cyclic)).rejects.toBeInstanceOf(
      JobStepResultNotSerializableError,
    );
    await expect(step.run('cyclic', () => cyclic)).rejects.toThrow(/cyclic/);
  });
});

describe('step.sleep — the durable yield', () => {
  it('persists a deadline and YIELDS rather than waiting in process', async () => {
    const { runId, workspaceId } = await makeRun();
    const t0 = new Date('2026-08-23T12:00:00.000Z');
    const step = createStepApi({ runId, workspaceId }, () => t0);

    const started = Date.now();
    const err = await step.sleep('wait', 30 * 60_000).then(
      () => null,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - started;

    expect(isJobStepYield(err)).toBe(true);
    expect((err as JobStepYield).resumeAt.toISOString()).toBe('2026-08-23T12:30:00.000Z');
    expect((err as JobStepYield).stepId).toBe('wait');
    // A thirty-minute sleep that returned in milliseconds is the proof it did
    // not hold the process: an in-process `await` would have blocked here.
    expect(elapsed).toBeLessThan(5_000);

    const row = await withSystemContext((tx) =>
      jobStepRepository.findByRunAndStep(runId, 'wait', tx),
    );
    expect(row?.kind).toBe('sleep');
    expect(row?.sleepUntil?.toISOString()).toBe('2026-08-23T12:30:00.000Z');
    expect(row?.result).toBeNull();
  });

  it('RETURNS once the deadline has passed, so the handler continues past it', async () => {
    const { runId, workspaceId } = await makeRun();
    const t0 = new Date('2026-08-23T12:00:00.000Z');
    let clock = t0;
    const step = createStepApi({ runId, workspaceId }, () => clock);

    await expect(step.sleep('wait', 60_000)).rejects.toBeInstanceOf(JobStepYield);

    clock = new Date(t0.getTime() + 61_000);
    await expect(step.sleep('wait', 60_000)).resolves.toBeUndefined();
  });

  it('YIELDS AGAIN on an EARLY wake rather than silently skipping the wait', async () => {
    const { runId, workspaceId } = await makeRun();
    const t0 = new Date('2026-08-23T12:00:00.000Z');
    let clock = t0;
    const step = createStepApi({ runId, workspaceId }, () => clock);

    await expect(step.sleep('wait', 60_000)).rejects.toBeInstanceOf(JobStepYield);

    // A re-enqueue that races the clock, or a lease reclaim, can hand the run
    // back before its deadline. Returning here would silently shorten a wait the
    // handler asked for — a supervisor would poll a container that has not moved.
    clock = new Date(t0.getTime() + 30_000);
    const err = await step.sleep('wait', 60_000).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isJobStepYield(err)).toBe(true);
    // And the deadline is the ORIGINAL one — a re-entry must not restart the clock.
    expect((err as JobStepYield).resumeAt.toISOString()).toBe('2026-08-23T12:01:00.000Z');
  });

  it('a sleep does not disturb the run steps around it', async () => {
    const { runId, workspaceId } = await makeRun();
    const t0 = new Date('2026-08-23T12:00:00.000Z');
    let clock = t0;
    const ran: string[] = [];

    async function handler(): Promise<string> {
      const step = createStepApi({ runId, workspaceId }, () => clock);
      await step.run('before', () => {
        ran.push('before');
        return 'b';
      });
      await step.sleep('nap', 60_000);
      await step.run('after', () => {
        ran.push('after');
        return 'a';
      });
      return 'complete';
    }

    await expect(handler()).rejects.toBeInstanceOf(JobStepYield);
    expect(ran).toEqual(['before']);

    clock = new Date(t0.getTime() + 61_000);
    await expect(handler()).resolves.toBe('complete');
    // `before` was memoized and skipped; `after` ran for the first time.
    expect(ran).toEqual(['before', 'after']);
  });
});

describe('step.sleep — surviving a WORKER RESTART', () => {
  it('resumes at the right step after the entire in-process world is discarded', async () => {
    const { runId, workspaceId } = await makeRun();
    const executed: string[] = [];

    // A "worker process" — everything in-memory a real one holds: its step API,
    // its closures, its handler instance. Nothing is shared between two calls of
    // this factory except `runId`, which is what a restarted process reads back
    // off the claimed `job_queue` row. That is the honest in-process model of a
    // restart: the ONLY thing that survives is the database.
    function bootWorkerProcess(nowMs: number) {
      const step = createStepApi({ runId, workspaceId }, () => new Date(nowMs));
      return {
        async runTheJob(): Promise<{ containerId: string; settled: boolean }> {
          const boot = await step.run('boot-container', () => {
            executed.push('boot-container');
            return { containerId: 'ctr-abc123' };
          });
          await step.sleep('supervise-wait:1', 30 * 60_000);
          const settled = await step.run('settle-container', () => {
            executed.push('settle-container');
            return { settled: true };
          });
          return { containerId: boot.containerId, settled: settled.settled };
        },
      };
    }

    const t0 = Date.parse('2026-08-23T12:00:00.000Z');

    // ── process 1 ──────────────────────────────────────────────────────────
    const p1 = bootWorkerProcess(t0);
    await expect(p1.runTheJob()).rejects.toBeInstanceOf(JobStepYield);
    expect(executed).toEqual(['boot-container']);

    // ── the process DIES here. p1, its step api and its closures are garbage.
    //    A real deploy is exactly this: the sleeping run is not in anyone's
    //    memory, and the only record that it ever booted a container is the row
    //    in `job_step`.

    // ── process 2, thirty-one minutes later, knowing only the run id ────────
    const p2 = bootWorkerProcess(t0 + 31 * 60_000);
    const result = await p2.runTheJob();

    // The memoized step was NOT re-executed — the container is not booted twice,
    // which is the failure this whole mechanism exists to prevent.
    expect(executed).toEqual(['boot-container', 'settle-container']);
    // And its value crossed the restart intact, through the database.
    expect(result).toEqual({ containerId: 'ctr-abc123', settled: true });
  });

  it('a run interrupted mid-flight leaves exactly the steps it completed', async () => {
    const { runId, workspaceId } = await makeRun();
    const step = createStepApi({ runId, workspaceId });

    await step.run('a', () => 'A');
    await step.run('b', () => 'B');
    await expect(step.sleep('c', 60_000)).rejects.toBeInstanceOf(JobStepYield);

    const rows = await withSystemContext((tx) => jobStepRepository.listByRun(runId, tx));
    expect(rows.map((r) => r.stepId)).toEqual(['a', 'b', 'c']);
    expect(rows.map((r) => r.kind)).toEqual(['run', 'run', 'sleep']);
    // The sleep checkpoint carries a deadline and no result; the two run steps
    // carry results and no deadline. `kind` is what keeps them apart.
    expect(rows[2]?.sleepUntil).not.toBeNull();
    expect(rows[2]?.result).toBeNull();
  });
});

describe('parseSleepMs', () => {
  it('takes milliseconds — the form every call site in this tree uses', () => {
    expect(parseSleepMs(0)).toBe(0);
    expect(parseSleepMs(30_000)).toBe(30_000);
    expect(parseSleepMs(1_800_000)).toBe(1_800_000);
  });

  it("takes Inngest's string durations too, so a documented call site cannot break on the swap", () => {
    expect(parseSleepMs('500ms')).toBe(500);
    expect(parseSleepMs('30s')).toBe(30_000);
    expect(parseSleepMs('5m')).toBe(300_000);
    expect(parseSleepMs('1h')).toBe(3_600_000);
    expect(parseSleepMs('2d')).toBe(172_800_000);
  });

  it('REFUSES a duration it cannot read rather than guessing one', () => {
    // A silently-misparsed duration is a wait of the wrong length, which is
    // invisible until something times out in production.
    expect(() => parseSleepMs('soon')).toThrow(/unrecognised duration/);
    expect(() => parseSleepMs('-5s')).toThrow(/unrecognised duration/);
    expect(() => parseSleepMs(-1)).toThrow(/non-negative/);
    expect(() => parseSleepMs(Number.NaN)).toThrow(/finite/);
  });
});

describe('the memoization write is race-safe', () => {
  it('two concurrent executions of one step converge on ONE stored result', async () => {
    const { runId, workspaceId } = await makeRun();
    const ran: string[] = [];
    const make = () => createStepApi({ runId, workspaceId });

    // The claim guarantees one worker per run, but a lease reclaim can overlap
    // the previous claimant's last moments. The loser must return the WINNER's
    // value, or the two would carry on with different data.
    const [a, b] = await Promise.all([
      make().run('contended', () => {
        ran.push('a');
        return { by: 'a' };
      }),
      make().run('contended', () => {
        ran.push('b');
        return { by: 'b' };
      }),
    ]);

    expect(a).toEqual(b);
    const rows = await adminDb.jobStep.findMany({ where: { runId, stepId: 'contended' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toEqual(a);
  });
});
