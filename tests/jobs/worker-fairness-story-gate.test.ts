import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import type { JobQueueRun } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { defineJob } from '@/lib/jobs/defineJob';
import { executeWithLedger } from '@/lib/jobs/engine/ledger';
import { JobWorker } from '@/lib/jobs/engine/worker';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { platformHealthService } from '@/lib/services/platformHealthService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// THE STORY GATE for MOTIR-3758 — *a long job may not take the whole worker*.
//
// Each code sibling ships its own unit tests; this file is the seam between them
// and the guarantees a coverage percentage cannot see. It asserts on `job_queue`
// and `job_run` ROWS — what an operator's dashboard reads — rather than on spies,
// and the slow run is genuinely slow rather than a fake timer, because the whole
// property under test is about a run that has not finished yet.
//
// ⚠️ ONE SEAM THIS FILE DELIBERATELY DOES NOT ASSERT. The card originally asked
// for a supervision YIELD's round trip. The re-plan of MOTIR-3763 removed it: the
// supervisors do not yield, so there is no such round trip. The engine's own
// `JobStepYield` handling is a WORKER property and is covered by
// `tests/jobs/engine-worker.test.ts`'s *a JobStepYield is NOT a failure*.

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let seq = 0;

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

/** A handler gate: awaited inside a run, released by the test. */
function gate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  return { wait, release };
}

/** Poll an authoritative read until it holds — never a fixed sleep. */
async function until(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

async function makeWorkspace(): Promise<string> {
  seq += 1;
  const user = await usersService.createUser({
    email: `fairness-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Fairness ${seq}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Fairness WS ${seq}`,
    ownerUserId: user.id,
  });
  return workspace.id;
}

/** Register a throwaway job in the engine registry and enqueue one due run of it. */
async function seedJob(
  workspaceId: string,
  handler: () => unknown | Promise<unknown>,
  opts?: { dueMsAgo?: number },
): Promise<{ jobId: string; runId: string }> {
  seq += 1;
  const jobId = `fairness.probe.${seq}`;
  defineJob({ id: jobId as never }, () => handler());
  const event = await adminDb.jobEvent.create({
    data: { name: jobId, data: { workspaceId }, workspaceId },
  });
  const run = await adminDb.jobQueueRun.create({
    data: {
      jobId,
      eventId: event.id,
      eventName: jobId,
      workspaceId,
      runAt: new Date(Date.now() - (opts?.dueMsAgo ?? 1_000)),
      maxAttempts: 3,
    },
  });
  return { jobId, runId: run.id };
}

/** A worker that executes through the REAL ledger wrapper — no fake at either end. */
function ledgerWorker(id: string, timings?: { claimBatch?: number; drainTimeoutMs?: number }) {
  return new JobWorker({
    workerId: id,
    logger: silent,
    ...(timings ? { timings } : {}),
    execute: async (run: JobQueueRun) => {
      const event = run.eventId
        ? await adminDb.jobEvent.findUnique({ where: { id: run.eventId } })
        : null;
      await executeWithLedger(run, event?.data ?? {});
    },
  });
}

describe('§1 the seam — a slow run does not detain the runs claimed beside it', () => {
  it('the FAST run reaches a terminal LEDGER row while the slow one is still running', async () => {
    const ws = await makeWorkspace();
    const held = gate();
    // Oldest first, so the claim order is the enqueue order and the slow run is
    // the head of the batch — the 2026-08-28 shape exactly.
    const slow = await seedJob(ws, () => held.wait, { dueMsAgo: 3_000 });
    const fast = await seedJob(ws, () => ({ done: true }), { dueMsAgo: 2_000 });

    const w = ledgerWorker('fairness-seam');
    expect(await w.tick()).toBe(2); // ONE claim took both

    // THE assertion, on `job_run` rows rather than on a spy: the fast run is
    // finished and the slow one is not, at the same instant.
    //
    // ⚠️ WAIT ON BOTH OF THE FAST RUN'S ROWS — MOTIR-3842. `settle()` writes them
    // one `await` apart, in a fixed order: `execute()` runs `executeWithLedger`,
    // whose last step takes the LEDGER row (`job_run`) terminal, and only THEN
    // does `jobQueueRepository.markSucceeded` release the QUEUE row
    // (`job_queue_run`), in a transaction of its own. So the ledger reaching
    // `succeeded` is NOT evidence about the queue row: polling the first and
    // asserting the second reads the window between the two commits, and that
    // window is a whole round trip rather than a scheduling hiccup — which is why
    // this failed on a QUIET box on the first attempt, not once in a hundred runs.
    //
    // Waiting for the LATER of the two costs the property nothing. The slow run is
    // held open by `held.wait` until this test releases it, so "the slow one is
    // still running" is true at whatever instant the snapshot is taken — the
    // simultaneity this test is about is bounded by the gate, not by how quickly
    // we read. What must NOT be done instead is to release the claim before the
    // ledger records the outcome: that ordering is what makes a crash between the
    // two writes recoverable rather than a lost run.
    await until(async () => {
      const ledger = await adminDb.jobRun.findFirst({ where: { functionId: fast.jobId } });
      if (ledger?.status !== 'succeeded') return false;
      const queued = await adminDb.jobQueueRun.findUnique({ where: { id: fast.runId } });
      return queued?.state === 'succeeded';
    }, "the fast run's ledger row AND its queue row to reach their terminal states");

    const slowLedger = await adminDb.jobRun.findFirstOrThrow({
      where: { functionId: slow.jobId },
    });
    expect(slowLedger.status).toBe('running');
    expect(slowLedger.finishedAt).toBeNull();
    // …and the queue agrees: the slow run still holds its claim, the fast one
    // gave its own back.
    expect((await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: slow.runId } })).state).toBe(
      'running',
    );
    // Restates what the wait above already established, and deliberately so: a
    // timed-out `until` throws its own message, and this keeps the failure a
    // reader meets a named state rather than a poll deadline.
    expect((await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: fast.runId } })).state).toBe(
      'succeeded',
    );

    held.release();
    await w.settled();
  });
});

describe('§2 the seam — the depth reading and the claim loop, in ONE process', () => {
  it('the backlog EXCLUDES what the worker is holding, and empties as it drains', async () => {
    const ws = await makeWorkspace();
    const held = gate();
    await seedJob(ws, () => held.wait, { dueMsAgo: 5_000 });
    await seedJob(ws, () => ({ ok: true }), { dueMsAgo: 4_000 });
    await seedJob(ws, () => ({ ok: true }), { dueMsAgo: 3_000 });

    // Before anything claims: three rows waiting, and the oldest is the age.
    const before = await platformHealthService.readQueueHealth();
    expect(before.depth).toBe(3);
    expect(before.oldestPendingAgeMs).toBeGreaterThanOrEqual(5_000);

    const w = ledgerWorker('fairness-depth');
    expect(await w.tick()).toBe(3);

    // ⚠️ THE READING IS ABOUT WHAT IS *WAITING*, NOT ABOUT WHAT EXISTS. All three
    // rows are claimed, so the backlog is empty even though one run is still in
    // flight — which is the property that keeps a busy worker from reading as a
    // stalled queue.
    // Wait on the authoritative signal — the two fast runs settling — rather than
    // on the claim, which empties the backlog instantly and would make the
    // assertion below true for the wrong reason.
    await until(
      async () => (await adminDb.jobQueueRun.count({ where: { state: 'running' } })) === 1,
      'the two fast runs to settle, leaving only the held one in flight',
    );
    const during = await platformHealthService.readQueueHealth();
    expect(during).toMatchObject({ state: 'healthy', depth: 0, oldestPendingAgeMs: null });

    held.release();
    await w.settled();

    const after = await platformHealthService.readQueueHealth();
    expect(after).toMatchObject({ state: 'healthy', depth: 0 });
    expect(await adminDb.jobQueueRun.count({ where: { state: 'succeeded' } })).toBe(3);
  });
});

describe('§3 the guards — the properties coverage cannot see', () => {
  it('§14.1 is INTACT: no per-job concurrency option, and no per-job predicate in the claim', () => {
    // ⚠️ NOT A BAN ON THE WORD. Two structural assertions, one per half of what
    // §14.1 refused: an OPTION a job can declare, and an ADMISSION decision taken
    // inside the claim. Three cards in this story changed how the engine picks
    // work; this is what says none of them re-opened that.
    const root = resolve(__dirname, '..', '..');
    const defineJobSrc = readFileSync(join(root, 'lib', 'jobs', 'defineJob.ts'), 'utf8');
    const sf = ts.createSourceFile('defineJob.ts', defineJobSrc, ts.ScriptTarget.Latest, true);

    const optionNames: string[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isTypeAliasDeclaration(node) && node.name.text === 'DefineJobOptions') {
        const collect = (n: ts.Node): void => {
          if (ts.isPropertySignature(n) && ts.isIdentifier(n.name)) {
            optionNames.push(n.name.text);
            return; // a property's NAME is an option; its members are not
          }
          ts.forEachChild(n, collect);
        };
        collect(node);
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);

    expect(optionNames.length).toBeGreaterThan(0); // the walk found the type at all
    expect(optionNames).not.toContain('concurrency');

    // And the claim statement still selects due work by TIME alone — no job id,
    // no key, no anti-join against the running set (§14.2.2 / §14.2.3).
    const claimSrc = readFileSync(
      join(root, 'lib', 'repositories', 'jobQueueRepository.ts'),
      'utf8',
    );
    const claim = claimSrc.slice(
      claimSrc.indexOf('async claimDueRuns('),
      claimSrc.indexOf('async reclaimExpiredLeases('),
    );
    expect(claim).toContain('ORDER BY "run_at"');
    expect(claim).toContain('FOR UPDATE SKIP LOCKED');
    expect(claim).not.toContain('"job_id" =');
  });

  it('the DRAIN releases every claim a DETACHED settle is holding, attempts refunded', async () => {
    const ws = await makeWorkspace();
    const held = gate();
    const slow = await seedJob(ws, () => held.wait, { dueMsAgo: 3_000 });
    const fast = await seedJob(ws, () => ({ ok: true }), { dueMsAgo: 2_000 });

    const w = ledgerWorker('fairness-drain', { claimBatch: 5, drainTimeoutMs: 200 });
    expect(await w.tick()).toBe(2);
    await until(async () => {
      const row = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: fast.runId } });
      return row.state === 'succeeded';
    }, 'the fast mate to settle on its own');

    await w.shutdown(); // times out on the held run and releases it anyway

    // No row left `running` with nobody holding it — the state a drain exists to
    // prevent, asserted across the whole batch rather than one run.
    const rows = await adminDb.jobQueueRun.findMany({
      where: { id: { in: [slow.runId, fast.runId] } },
    });
    expect(rows.filter((r) => r.state === 'running')).toEqual([]);
    expect(rows.every((r) => r.claimedBy === null)).toBe(true);
    // ⚠️ AND THE ATTEMPT IS REFUNDED. A deploy is routine; if a drain spent an
    // attempt, a crash-loop would exhaust a job's budget with no error to show.
    const released = rows.find((r) => r.id === slow.runId);
    expect(released?.state).toBe('pending');
    expect(released?.attempts).toBe(0);

    held.release();
    await w.settled();
  });

  it('THE CLAIM IS BOUNDED BY ITS LIMIT — through the RUNTIME connection', async () => {
    // ⚠️ THE STORY'S MOST EASILY-LOST PROPERTY (bug MOTIR-3769). The pool bound
    // in the claim loop is only real if the statement honours its limit — and it
    // did not: a `LIMIT` in a `FROM`-subquery is a planner preference, and under
    // the runtime role the sub-select was re-scanned. As the database OWNER the
    // same statement was correct, which is why the suite was green for months.
    // So this reads through `withSystemContext`, as the worker does, on purpose.
    const ws = await makeWorkspace();
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const { runId } = await seedJob(ws, () => ({ ok: true }), { dueMsAgo: 6_000 - i * 100 });
      ids.push(runId);
    }

    const claimed = await withSystemContext((tx) =>
      jobQueueRepository.claimDueRuns('story-gate-bound', 2, 60_000, tx),
    );

    expect(claimed).toHaveLength(2);
    const rest = await adminDb.jobQueueRun.findMany({
      where: { id: { in: ids }, state: 'pending' },
    });
    expect(rest).toHaveLength(4);
    // Not merely unclaimed — untouched. An over-claim spends an attempt on every
    // row it takes, so the counter is a second, independent witness.
    expect(rest.every((r) => r.attempts === 0 && r.claimedBy === null)).toBe(true);
  });
});
