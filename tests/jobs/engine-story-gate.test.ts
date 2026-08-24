import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { defineJob } from '@/lib/jobs/defineJob';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { inngest } from '@/lib/jobs/client';
import { JobWorker } from '@/lib/jobs/engine/worker';
import { executeWithLedger } from '@/lib/jobs/engine/ledger';
import { createStepApi, JobStepYield } from '@/lib/jobs/engine/step';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { JOB_ENGINE_JOBS_ENV, routedToEngine } from '@/lib/jobs/engine/cutover';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobEngine, truncateJobRuns } from '../helpers/db';

// THE STORY GATE (Story MOTIR-3414 · Subtask MOTIR-3426).
//
// This file is NOT a third copy of the per-subtask units. It does the two things
// those cannot:
//
//   §2 THE INTEGRATION SEAMS — the writer-to-consumer paths each subtask's own
//      tests mock at one end. An event emitted through the REAL `sendEvent`,
//      traversing the REAL dispatcher into a REAL `job_queue` row and out through
//      a REAL worker claim into the handler. A key that drifts between the
//      dispatcher's write and the worker's read is exactly what unit tests on
//      both sides individually pass while the pair is broken.
//
//   §3 THE ARCHITECTURE AND CRASH GUARDS — what a coverage percentage cannot
//      see. And each one is DEMONSTRATED TO FAIL when its property is broken,
//      which is the card's own criterion: a guard nobody has watched go red is a
//      guard nobody knows is wired.
//
// Real Postgres throughout, no mocks.

const ORIGINAL_ENV = process.env[JOB_ENGINE_JOBS_ENV];
const silent = { info: () => {}, warn: () => {}, error: () => {} };

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobEngine();
  await truncateJobRuns();
  delete process.env[JOB_ENGINE_JOBS_ENV];
});

afterEach(async () => {
  await truncateJobEngine();
  await truncateJobRuns();
  if (ORIGINAL_ENV === undefined) delete process.env[JOB_ENGINE_JOBS_ENV];
  else process.env[JOB_ENGINE_JOBS_ENV] = ORIGINAL_ENV;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
async function makeWorkspace(): Promise<string> {
  seq += 1;
  const user = await usersService.createUser({
    email: `gate-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Gate ${seq}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Gate WS ${seq}`,
    ownerUserId: user.id,
  });
  return workspace.id;
}

// ═══════════════════════════════════════════════════════════════════════════
// §2 — THE INTEGRATION SEAM
// ═══════════════════════════════════════════════════════════════════════════

describe('§2 the seam — sendEvent → dispatcher → job_queue → worker → handler', () => {
  it('carries an event end to end with NO fake at either end', async () => {
    const ws = await makeWorkspace();
    seq += 1;
    const jobId = `seam.end-to-end.${seq}`;
    const seen: unknown[] = [];
    defineJob({ id: jobId as never }, (ctx) => {
      seen.push(ctx.event.data);
      return { handled: true };
    });
    process.env[JOB_ENGINE_JOBS_ENV] = jobId;

    // The REAL emit surface every service calls. Not the dispatcher directly.
    await sendEvent(jobId as never, { workspaceId: ws, subject: 'hello' } as never);

    // The REAL claim loop, executing through the REAL ledger wrapper.
    const w = new JobWorker({
      workerId: 'seam-worker',
      logger: silent,
      execute: async (run) => {
        const event = await withSystemContext((tx) =>
          tx.jobEvent.findUnique({ where: { id: run.eventId! } }),
        );
        await executeWithLedger(run, event?.data ?? {});
      },
    });
    expect(await w.tick()).toBe(1);

    // The payload survived every hop: sendEvent → job_event.data → the worker's
    // lookup → buildEngineContext → ctx.event.data. A key that drifted anywhere
    // along that chain would show up HERE and nowhere else.
    expect(seen).toEqual([{ workspaceId: ws, subject: 'hello' }]);

    const run = await adminDb.jobQueueRun.findFirstOrThrow({ where: { jobId } });
    expect(run.state).toBe('succeeded');
    expect(run.workspaceId).toBe(ws);
    const ledger = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.output).toEqual({ handled: true });
  });

  it('the seam FAILS when the dispatcher and the worker disagree about the key', async () => {
    // Demonstrating the guard goes red — the card's criterion. The break is the
    // realistic one: the dispatcher writes the run under one job id and the
    // registry knows it under another, which is what a rename touching one side
    // produces.
    const ws = await makeWorkspace();
    seq += 1;
    const jobId = `seam.drift.${seq}`;
    defineJob({ id: jobId as never }, () => ({ ok: true }));
    process.env[JOB_ENGINE_JOBS_ENV] = jobId;

    await withSystemContext((tx) =>
      jobQueueRepository.create(
        {
          jobId: `${jobId}-renamed`, // the drift
          eventName: jobId,
          workspaceId: ws,
          runAt: new Date(),
          maxAttempts: 1,
        },
        tx,
      ),
    );

    const w = new JobWorker({
      workerId: 'seam-drift',
      logger: silent,
      execute: async (run) => {
        await executeWithLedger(run, {});
      },
    });
    await w.tick();

    // The run does not quietly succeed: it fails, terminally, naming the id it
    // could not resolve.
    const run = await adminDb.jobQueueRun.findFirstOrThrow({
      where: { jobId: `${jobId}-renamed` },
    });
    expect(run.state).toBe('failed');
    expect(run.lastError).toMatchObject({ message: expect.stringContaining('engine registry') });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §3 — THE ARCHITECTURE AND CRASH GUARDS
// ═══════════════════════════════════════════════════════════════════════════

describe('§3a two workers never execute one job_queue row', () => {
  it('holds under genuine concurrency against a real Postgres', async () => {
    const ws = await makeWorkspace();
    const ids: string[] = [];
    for (let i = 0; i < 16; i++) {
      seq += 1;
      const row = await adminDb.jobQueueRun.create({
        data: {
          jobId: `race.${seq}`,
          eventName: 'race',
          workspaceId: ws,
          runAt: new Date(),
          maxAttempts: 1,
        },
      });
      ids.push(row.id);
    }

    const executions: string[] = [];
    const mk = (n: string) =>
      new JobWorker({
        workerId: n,
        logger: silent,
        timings: { claimBatch: 4 },
        execute: async (run) => {
          executions.push(run.id);
          await new Promise((r) => setTimeout(r, 3));
        },
      });
    const [a, b, c] = [mk('race-a'), mk('race-b'), mk('race-c')];
    for (let i = 0; i < 12; i++) {
      const claimed = await Promise.all([a.tick(), b.tick(), c.tick()]);
      if (claimed.every((n) => n === 0)) break;
    }

    expect(executions).toHaveLength(new Set(executions).size);
    expect(new Set(executions)).toEqual(new Set(ids));
  });

  it('the guard GOES RED against a claim without SKIP LOCKED — proved by racing one', async () => {
    // The demonstration the card asks for. A claim written as a plain
    // read-then-write — the shape a reasonable person writes first — hands the
    // same row to both racers. Asserting that here is what proves the guard above
    // is measuring something rather than passing vacuously.
    const ws = await makeWorkspace();
    const row = await adminDb.jobQueueRun.create({
      data: {
        jobId: 'unsafe.claim',
        eventName: 'race',
        workspaceId: ws,
        runAt: new Date(),
        maxAttempts: 1,
      },
    });

    /** The naive claim: read what is due, then write a claim based on it. */
    async function unsafeClaim(workerId: string): Promise<string[]> {
      return withSystemContext(async (tx) => {
        const due = await tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT "id" FROM "job_queue" WHERE "state" = 'pending' AND "run_at" <= (now() AT TIME ZONE 'UTC')`,
        );
        // The window every read-derived write has, made visible.
        await new Promise((r) => setTimeout(r, 20));
        for (const d of due) {
          await tx.$executeRawUnsafe(
            `UPDATE "job_queue" SET "state" = 'running', "claimed_by" = $1 WHERE "id" = $2`,
            workerId,
            d.id,
          );
        }
        return due.map((d) => d.id);
      });
    }

    const [x, y] = await Promise.all([unsafeClaim('naive-a'), unsafeClaim('naive-b')]);

    // BOTH saw it. That is the defect, and it is why the real claim is
    // `FOR UPDATE SKIP LOCKED` with the state write in the same statement.
    expect(x).toEqual([row.id]);
    expect(y).toEqual([row.id]);
  });
});

describe('§3b a run resumes after the worker is killed mid-step', () => {
  it('re-executes the UN-memoized steps and not the memoized ones', async () => {
    const ws = await makeWorkspace();
    seq += 1;
    const jobId = `crash.resume.${seq}`;
    const executed: string[] = [];

    const run = await adminDb.jobQueueRun.create({
      data: { jobId, eventName: jobId, workspaceId: ws, runAt: new Date(), maxAttempts: 5 },
    });

    // A "process": its step api and closures are rebuilt from nothing but the run
    // id, so killing it means discarding everything except the database.
    const bootProcess = (killAfter: string | null) => async () => {
      const step = createStepApi({ runId: run.id, workspaceId: ws });
      for (const id of ['alpha', 'beta', 'gamma', 'delta']) {
        await step.run(id, () => {
          executed.push(id);
          return { step: id };
        });
        if (killAfter === id) throw new Error('SIGKILL');
      }
      return 'complete';
    };

    await expect(bootProcess('beta')()).rejects.toThrow('SIGKILL');
    expect(executed).toEqual(['alpha', 'beta']);

    executed.length = 0;
    await expect(bootProcess(null)()).resolves.toBe('complete');
    // alpha and beta were memoized and skipped; gamma and delta ran for the
    // first time. A percentage cannot see this; only running it can.
    expect(executed).toEqual(['gamma', 'delta']);
  });

  it('the guard GOES RED when the memo is discarded — proved by discarding it', async () => {
    const ws = await makeWorkspace();
    seq += 1;
    const jobId = `crash.nomemo.${seq}`;
    const executed: string[] = [];
    const run = await adminDb.jobQueueRun.create({
      data: { jobId, eventName: jobId, workspaceId: ws, runAt: new Date(), maxAttempts: 5 },
    });
    const step = createStepApi({ runId: run.id, workspaceId: ws });

    await step.run('alpha', () => {
      executed.push('alpha');
      return 1;
    });
    // What a retry would do if it "reset" the run — the reflex the shim's header
    // warns against. `deleteByRun` exists for teardown, not for retries.
    await adminDb.jobStep.deleteMany({ where: { runId: run.id } });
    await step.run('alpha', () => {
      executed.push('alpha');
      return 1;
    });

    // Executed twice. For a step that boots a container, that is a second
    // container nobody is watching.
    expect(executed).toEqual(['alpha', 'alpha']);
  });

  it('a sleeping run survives a restart and does not re-execute what completed', async () => {
    const ws = await makeWorkspace();
    seq += 1;
    const jobId = `crash.sleep.${seq}`;
    const executed: string[] = [];
    const row = await adminDb.jobQueueRun.create({
      data: { jobId, eventName: jobId, workspaceId: ws, runAt: new Date(), maxAttempts: 5 },
    });

    const boot = (nowMs: number) => async () => {
      const step = createStepApi({ runId: row.id, workspaceId: ws }, () => new Date(nowMs));
      await step.run('boot', () => {
        executed.push('boot');
        return { container: 'c1' };
      });
      await step.sleep('supervise', 30 * 60_000);
      await step.run('settle', () => {
        executed.push('settle');
        return { done: true };
      });
      return 'done';
    };

    const t0 = Date.parse('2026-08-23T12:00:00.000Z');
    await expect(boot(t0)()).rejects.toBeInstanceOf(JobStepYield);
    expect(executed).toEqual(['boot']);
    await expect(boot(t0 + 31 * 60_000)()).resolves.toBe('done');
    expect(executed).toEqual(['boot', 'settle']);
  });
});

describe('§3c the engine stays behind the seam (import boundary)', () => {
  /**
   * Every source file under `lib/` and `app/`, paired with its text.
   *
   * A direct scan rather than a spawned ESLint run: the repo's other structural
   * guards read the tree themselves for the same reasons — it is deterministic,
   * it costs milliseconds instead of a lint of the whole project, and it does not
   * depend on a binary shim resolving inside the Vitest worker.
   *
   * The ESLint rule (`JOB_ENGINE_RESTRICTION` in `eslint.config.mjs`) is the
   * DEVELOPER-facing enforcement — it fails the editor and `pnpm lint`. This is
   * the assertion the card asks for, and the two agree by construction because
   * they test the same property against the same tree.
   */
  async function sourceFiles(roots: string[]): Promise<Array<{ path: string; text: string }>> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const out: Array<{ path: string; text: string }> = [];
    async function walk(dir: string): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === '.next') continue;
          await walk(full);
        } else if (/\.(ts|tsx)$/.test(e.name)) {
          out.push({ path: full, text: await fs.readFile(full, 'utf8') });
        }
      }
    }
    for (const r of roots) await walk(r);
    return out;
  }

  /** Does this file text import the engine's internals? */
  function importsEngine(text: string): boolean {
    return /from\s+['"](?:@\/lib\/jobs\/engine|\.\/engine|\.\.\/engine)['"/]/.test(text);
  }

  /** The two surfaces allowed to reach it: the jobs runtime, and the process that RUNS it. */
  function isAllowed(file: string): boolean {
    return file.startsWith('lib/jobs/') || file === 'scripts/worker.ts';
  }

  it('NOTHING outside lib/jobs/** or scripts/worker.ts imports the engine', async () => {
    const files = await sourceFiles(['lib', 'app', 'scripts']);
    // The scan must actually be looking at something — a walk that found nothing
    // would pass this test while asserting the empty set.
    expect(files.length).toBeGreaterThan(200);

    const violations = files.filter((f) => importsEngine(f.text) && !isAllowed(f.path));
    expect(violations.map((v) => v.path)).toEqual([]);

    // And the allowed side is non-empty, so the rule is not vacuous: if nothing
    // imported the engine at all, the assertion above would be trivially true.
    const allowed = files.filter((f) => importsEngine(f.text) && isAllowed(f.path));
    expect(allowed.length).toBeGreaterThan(0);
    expect(allowed.map((a) => a.path)).toContain('scripts/worker.ts');
  });

  it('the guard GOES RED for a file outside the runtime — proved against one', () => {
    // The demonstration the card asks for. Without it the assertion above would
    // pass just as happily against a matcher that matches nothing.
    const offender = "import { JobWorker } from '@/lib/jobs/engine/worker';";
    expect(importsEngine(offender)).toBe(true);
    expect(isAllowed('lib/services/someService.ts')).toBe(false);
    // …so a real file at that path carrying that import IS a violation.
    expect(importsEngine(offender) && !isAllowed('lib/services/someService.ts')).toBe(true);

    // And the relative forms a file inside lib/jobs would use are matched too —
    // an offender could not evade the guard by writing `../engine/worker`.
    expect(importsEngine("import { x } from './engine/step';")).toBe(true);
    expect(importsEngine("import { x } from '../engine/step';")).toBe(true);

    // A near-miss that must NOT be flagged: the public door.
    expect(importsEngine("import { sendEvent } from '@/lib/jobs/sendEvent';")).toBe(false);
  });

  it('ESLint carries the same boundary, so it fails at the keyboard too', async () => {
    const fs = await import('node:fs/promises');
    const config = await fs.readFile('eslint.config.mjs', 'utf8');
    // Not a duplicate of the scan: this asserts the DEVELOPER-facing half exists,
    // which is what stops a violation from being written in the first place
    // rather than caught in CI.
    expect(config).toContain('JOB_ENGINE_RESTRICTION');
    expect(config).toContain('@/lib/jobs/engine');
    expect(config).toContain('scripts/worker.ts');
  });
});

describe('§3d a job absent from the cutover configuration still routes to Inngest', () => {
  it('protects the 23 jobs this story does not move', async () => {
    delete process.env[JOB_ENGINE_JOBS_ENV];
    const ws = await makeWorkspace();
    seq += 1;
    const jobId = `default.lane.${seq}`;
    defineJob({ id: jobId as never }, () => ({ ok: true }));

    const sent: string[] = [];
    const original = inngest.send.bind(inngest);
    // Spying on the transport is the only way to observe WHICH lane an emit took
    // without a live Inngest; the assertion is about routing, not delivery.
    (inngest as unknown as { send: unknown }).send = async (e: { name: string }) => {
      sent.push(e.name);
      return { ids: [] };
    };
    try {
      await sendEvent(jobId as never, { workspaceId: ws } as never);
    } finally {
      (inngest as unknown as { send: unknown }).send = original;
    }

    expect(routedToEngine(jobId)).toBe(false);
    // It went to Inngest…
    expect(sent).toEqual([jobId]);
    // …and NOT onto the new engine. No queue row, no event row.
    expect(await adminDb.jobQueueRun.count({ where: { jobId } })).toBe(0);
    expect(await adminDb.jobEvent.count({ where: { name: jobId } })).toBe(0);
  });

  it('the guard GOES RED once the id IS routed — the same assertion, inverted', async () => {
    const ws = await makeWorkspace();
    seq += 1;
    const jobId = `moved.lane.${seq}`;
    defineJob({ id: jobId as never }, () => ({ ok: true }));
    process.env[JOB_ENGINE_JOBS_ENV] = jobId;

    const sent: string[] = [];
    const original = inngest.send.bind(inngest);
    (inngest as unknown as { send: unknown }).send = async (e: { name: string }) => {
      sent.push(e.name);
      return { ids: [] };
    };
    try {
      await sendEvent(jobId as never, { workspaceId: ws } as never);
    } finally {
      (inngest as unknown as { send: unknown }).send = original;
    }

    // Now on the engine, and the Inngest transport is skipped entirely because
    // this event has no subscriber left on that lane.
    expect(await adminDb.jobQueueRun.count({ where: { jobId } })).toBe(1);
    expect(sent).toEqual([]);
  });
});
