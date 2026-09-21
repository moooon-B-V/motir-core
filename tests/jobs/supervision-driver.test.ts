import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobQueueRun } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobSupervisionRepository } from '@/lib/repositories/jobSupervisionRepository';
import { isJobRunDefer, type JobRunDefer } from '@/lib/jobs/engine/defer';
import {
  advanceSupervision,
  durableSupervisionStore,
  type SupervisionHooks,
  type SupervisionPollResult,
  type SupervisionPollState,
  type SupervisionStore,
  type SupervisionTerminalReason,
} from '@/lib/jobs/supervision/driver';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// THE SUPERVISION DRIVER (Story MOTIR-3778 · Subtask MOTIR-3827), against a real
// Postgres.
//
// The machine is driven with FAKE hooks — no container, no orchestrator — which
// is the point: the driver is the shape both supervisors will run on, and what
// has to be true of it is true of the shape rather than of either fleet.
//
// ⚠️ THE ASSERTION THIS FILE EXISTS FOR IS A NEGATIVE. §15.4 recorded that a
// suspension mistaken for an exit would have torn down the container it was
// watching on the first poll. So `settles NOTHING on the defer path` is the one
// that matters most, and it is asserted by COUNTING the settle hook rather than
// by reading the code.

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

async function makeRun(): Promise<{ run: JobQueueRun; workspaceId: string }> {
  seq += 1;
  const user = await usersService.createUser({
    email: `driver-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Driver ${seq}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Driver WS ${seq}`,
    ownerUserId: user.id,
  });
  const run = await adminDb.jobQueueRun.create({
    data: {
      jobId: 'system.code-graph-index',
      eventName: 'code-graph/index.requested',
      workspaceId: workspace.id,
      runAt: new Date(),
      maxAttempts: 3,
    },
  });
  return { run, workspaceId: workspace.id };
}

/** A recorder around a scripted poll, so every assertion is about counted calls. */
interface Recorder {
  polls: SupervisionPollState[];
  settles: {
    reason: SupervisionTerminalReason;
    state: SupervisionPollState;
    verdict: string | null;
  }[];
  hooks: SupervisionHooks<string, string>;
}

function recorder(opts: {
  poll: (
    state: SupervisionPollState,
  ) => SupervisionPollResult<string> | Promise<SupervisionPollResult<string>>;
  maxPolls?: number;
  timeoutMs?: number;
  waitMs?: (n: number) => number;
  now?: () => Date;
}): Recorder {
  const polls: SupervisionPollState[] = [];
  const settles: Recorder['settles'] = [];
  return {
    polls,
    settles,
    hooks: {
      async poll(state) {
        polls.push({ ...state });
        return opts.poll(state);
      },
      async settle(reason, state, verdict) {
        settles.push({ reason, state: { ...state }, verdict });
        return `torn-down:${reason}`;
      },
      waitMs: opts.waitMs ?? ((n) => n * 1_000),
      maxPolls: opts.maxPolls ?? 500,
      timeoutMs: opts.timeoutMs ?? 1_800_000,
      ...(opts.now ? { now: opts.now } : {}),
    },
  };
}

const KEY = (bootedAt: Date, workspaceId: string | null) => ({
  kind: 'index',
  subject: 'project-a',
  workspaceId,
  bootedAt,
});

function readRow(runId: string, subject = 'project-a') {
  return withSystemContext((tx) =>
    jobSupervisionRepository.findByRunAndSubject(runId, subject, tx),
  );
}

/** Run one pass and hand back the defer it threw — or fail loudly if it settled. */
async function passDefers(
  runId: string,
  key: ReturnType<typeof KEY>,
  hooks: SupervisionHooks<string, string>,
): Promise<JobRunDefer> {
  try {
    await advanceSupervision(runId, key, hooks);
  } catch (err) {
    if (isJobRunDefer(err)) return err;
    throw err;
  }
  throw new Error('expected the pass to DEFER, and it settled');
}

describe('one pass = one poll', () => {
  it('the pass that OPENS a supervision waits and polls NOTHING — the cadence is boot, wait, poll', async () => {
    const { run, workspaceId } = await makeRun();
    const at = new Date('2026-08-28T12:00:00.000Z');
    const r = recorder({
      poll: () => ({ done: false, startedAt: null, consecutiveReadFailures: 0 }),
      waitMs: (n) => n * 3_000,
      now: () => at,
    });

    const defer = await passDefers(run.id, KEY(at, workspaceId), r.hooks);

    // Both loops this replaces open their body with `await sleep(waitMs(1))`,
    // and a container cannot have started in the instant after `provision`
    // returned. Polling here would be a wasted read on every supervision AND
    // would re-phase the backoff, which §16.6 forbids.
    expect(r.polls).toHaveLength(0);
    expect(defer.resumeAt.getTime()).toBe(at.getTime() + 3_000);
  });

  it('polls exactly ONCE and settles NOTHING on the defer path', async () => {
    const { run, workspaceId } = await makeRun();
    const bootedAt = new Date();
    const r = recorder({
      poll: () => ({ done: false, startedAt: null, consecutiveReadFailures: 0 }),
    });

    await passDefers(run.id, KEY(bootedAt, workspaceId), r.hooks); // the opening wait
    const defer = await passDefers(run.id, KEY(bootedAt, workspaceId), r.hooks);

    // ⚠️ THE NEGATIVE. A `finally` around the old loop would have called the
    // teardown here, on the first suspension, and destroyed the container the
    // supervision was watching (§15.4).
    expect(r.settles).toHaveLength(0);
    expect(r.polls).toHaveLength(1);
    expect(r.polls[0]).toEqual({ pollNumber: 1, startedAt: null, consecutiveReadFailures: 0 });
    expect(isJobRunDefer(defer)).toBe(true);
  });

  it('writes the advanced state and defers at `now + waitMs(pollNumber)`', async () => {
    const { run, workspaceId } = await makeRun();
    const at = new Date('2026-08-28T12:00:00.000Z');
    const observed = new Date('2026-08-28T12:00:05.000Z');
    const r = recorder({
      poll: () => ({ done: false, startedAt: observed, consecutiveReadFailures: 2 }),
      waitMs: (n) => n * 3_000,
      now: () => at,
    });

    await passDefers(run.id, KEY(at, workspaceId), r.hooks); // the opening wait
    const defer = await passDefers(run.id, KEY(at, workspaceId), r.hooks);

    // `waitMs(n)` is the wait BEFORE poll n, so a pass that has just done poll 1
    // owes `waitMs(2)`.
    expect(defer.resumeAt.getTime()).toBe(at.getTime() + 6_000);
    const row = await readRow(run.id);
    expect(row!.pollNumber).toBe(1);
    expect(row!.startedAt?.toISOString()).toBe(observed.toISOString());
    expect(row!.consecutiveReadFailures).toBe(2);
    expect(row!.nextPollAt.getTime()).toBe(at.getTime() + 6_000);
    expect(row!.state).toBe('watching');
  });

  it('carries the state ACROSS passes — the poll number climbs and the observation survives', async () => {
    const { run, workspaceId } = await makeRun();
    const bootedAt = new Date();
    const observed = new Date('2026-08-28T12:00:05.000Z');
    const r = recorder({
      poll: (state) => ({
        done: false,
        // Observe the start on the second poll only, then carry it.
        startedAt: state.pollNumber >= 2 ? observed : null,
        consecutiveReadFailures: 0,
      }),
    });

    for (let i = 0; i < 4; i += 1) {
      await passDefers(run.id, KEY(bootedAt, workspaceId), r.hooks);
    }

    // Four passes: the opening wait, then polls 1, 2 and 3.
    expect(r.polls.map((p) => p.pollNumber)).toEqual([1, 2, 3]);
    // The third pass was HANDED the second's observation — the whole reason the
    // row exists, since a defer checkpoints nothing.
    expect(r.polls[2]!.startedAt?.toISOString()).toBe(observed.toISOString());
    expect((await readRow(run.id))!.pollNumber).toBe(3);
  });
});

describe('the terminal transitions', () => {
  it('a `done` verdict settles once, with the verdict, and returns the outcome', async () => {
    const { run, workspaceId } = await makeRun();
    const r = recorder({ poll: () => ({ done: true, verdict: 'exit-0' }) });

    await passDefers(run.id, KEY(new Date(), workspaceId), r.hooks); // the opening wait
    const result = await advanceSupervision(run.id, KEY(new Date(), workspaceId), r.hooks);

    expect(result).toEqual({
      status: 'settled',
      reason: 'completed',
      outcome: 'torn-down:completed',
      raced: false,
      // The poll this supervision ENDED on (MOTIR-4413) — the one that observed
      // the container done. Returned so a caller can turn it into a duration
      // with its own pure `waitMs`, and named here rather than allowed for,
      // because the shape of what a settled pass reports is the contract.
      pollNumber: 1,
    });
    expect(r.settles).toHaveLength(1);
    expect(r.settles[0]!.verdict).toBe('exit-0');
    expect((await readRow(run.id))!.state).toBe('settled');
  });

  it('the DEADLINE settles BEFORE polling — a resumed pass does not watch a timed-out container afresh', async () => {
    const { run, workspaceId } = await makeRun();
    const bootedAt = new Date('2026-08-28T12:00:00.000Z');
    const r = recorder({
      poll: () => ({ done: false, startedAt: null, consecutiveReadFailures: 0 }),
      timeoutMs: 60_000,
      now: () => new Date('2026-08-28T12:01:30.000Z'),
    });

    const result = await advanceSupervision(run.id, KEY(bootedAt, workspaceId), r.hooks);

    expect(result.reason).toBe('deadline');
    // Not one provider read. §13.3(a): the clock is anchored to the SESSION, so
    // the first poll of a resumed pass settles rather than polls.
    expect(r.polls).toHaveLength(0);
    expect(r.settles.map((s) => s.reason)).toEqual(['deadline']);
  });

  it('the POLL CEILING is a TOTAL bound across passes, not a per-pass one', async () => {
    const { run, workspaceId } = await makeRun();
    const bootedAt = new Date();
    const r = recorder({
      poll: () => ({ done: false, startedAt: null, consecutiveReadFailures: 0 }),
      maxPolls: 3,
    });

    // Four passes — the opening wait plus three polls — each a SEPARATE
    // invocation, which under the old in-memory counter would have reset the
    // count every time.
    for (let i = 0; i < 4; i += 1) await passDefers(run.id, KEY(bootedAt, workspaceId), r.hooks);
    const result = await advanceSupervision(run.id, KEY(bootedAt, workspaceId), r.hooks);

    expect(r.polls).toHaveLength(3);
    expect(result.reason).toBe('poll_ceiling');
    expect(r.settles.map((s) => s.reason)).toEqual(['poll_ceiling']);
  });

  it('a THROW from the poll settles FIRST and re-throws — a provider failure leaves no container running', async () => {
    const { run, workspaceId } = await makeRun();
    const boom = new Error('the provider went away');
    const r = recorder({
      poll: () => Promise.reject(boom) as Promise<never>,
    });

    const bootedAt = new Date();
    await passDefers(run.id, KEY(bootedAt, workspaceId), r.hooks); // the opening wait
    await expect(advanceSupervision(run.id, KEY(bootedAt, workspaceId), r.hooks)).rejects.toBe(
      boom,
    );
    expect(r.settles.map((s) => s.reason)).toEqual(['failed']);
    expect((await readRow(run.id))!.state).toBe('settled');
  });

  it('does NOT own a boot deadline — a failed read at large elapsed keeps watching', async () => {
    // §13.3(b): a boot-deadline verdict may be reached only from a SUCCESSFUL
    // provider read, and the driver has no successful read to reason from. So it
    // evaluates the OVERALL timeout (which depends on `bootedAt` alone) and
    // leaves the boot deadline to the caller's `poll`. A driver that owned one
    // would classify a healthy twenty-minute container as `never_started` the
    // first time one read failed.
    const { run, workspaceId } = await makeRun();
    const bootedAt = new Date('2026-08-28T12:00:00.000Z');
    const r = recorder({
      // The caller's poll reports a read failure, not a verdict.
      poll: () => ({ done: false, startedAt: null, consecutiveReadFailures: 1 }),
      timeoutMs: 1_800_000,
      now: () => new Date('2026-08-28T12:20:00.000Z'),
    });

    await passDefers(run.id, KEY(bootedAt, workspaceId), r.hooks); // the opening wait
    await passDefers(run.id, KEY(bootedAt, workspaceId), r.hooks);

    expect(r.polls).toHaveLength(1);
    expect(r.settles).toHaveLength(0);
    expect((await readRow(run.id))!.state).toBe('watching');
  });
});

/**
 * A BARRIER for `parties` callers: each call resolves only once all of them have
 * arrived.
 *
 * ⚠️ IT IS WHAT MAKES A RACE TEST A RACE (MOTIR-5589). `poll` runs after `open`
 * has read the row and before the advance writes it, so a pass parked here has
 * READ its poll number and not yet written one. Holding BOTH passes here is the
 * only way to guarantee they read the same number. A `setTimeout` in `poll` only
 * makes that likely: on a loaded CI shard the second pass's `open` waits for a
 * pooled connection past the first pass's whole poll-and-commit, reads the
 * advanced row, and correctly polls 2. That is a SEQUENTIAL pass, and it failed
 * `expected 2 to be 1` three times in CI.
 */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((res) => (release = res));
  return () => {
    arrived += 1;
    if (arrived === parties) release();
    return all;
  };
}

/**
 * A store whose `open` waits for `gate` first — a pass whose first statement
 * reaches the database late, as a pool wait on a loaded runner makes it.
 */
function lateOpen(gate: Promise<unknown>): SupervisionStore {
  return {
    ...durableSupervisionStore,
    async open(...args) {
      await gate;
      return durableSupervisionStore.open(...args);
    },
  };
}

describe('two passes racing on one supervision', () => {
  it('do not BOTH advance — the loser observes the winner and declines', async () => {
    const { run, workspaceId } = await makeRun();
    const bootedAt = new Date();
    // Both passes read `pollNumber: 0`, both poll, and both try to write 1. The
    // `FOR UPDATE` re-read is what makes the second one see 1 and stop. The
    // overlap is real: `reclaimExpiredLeases` hands a run to a second worker
    // while the first is inside a provider call it has not returned from.
    // The BARRIER guarantees it here — see `barrier` for why a timer cannot.
    const bothPolling = barrier(2);
    const r = recorder({
      poll: async () => {
        await bothPolling();
        return { done: false, startedAt: null, consecutiveReadFailures: 0 };
      },
    });

    await passDefers(run.id, KEY(bootedAt, workspaceId), r.hooks); // the opening wait
    const results = await Promise.allSettled([
      advanceSupervision(run.id, KEY(bootedAt, workspaceId), r.hooks),
      advanceSupervision(run.id, KEY(bootedAt, workspaceId), r.hooks),
    ]);

    // Both SUSPEND — neither is a failure and neither settles anything.
    expect(results.every((x) => x.status === 'rejected' && isJobRunDefer(x.reason))).toBe(true);
    expect(r.settles).toHaveLength(0);
    // Both passes READ the same row, which is what makes this a race rather than
    // two passes in a row. `[1, 2]` here would mean they did not overlap.
    expect(r.polls.map((p) => p.pollNumber)).toEqual([1, 1]);
    // One advance, not two. Without the lock both would have written 1 and the
    // count would silently stop bounding anything.
    expect((await readRow(run.id))!.pollNumber).toBe(1);
  });

  it('still declines when one pass reaches the database LATE — the flake’s own condition, held to a race', async () => {
    // MOTIR-5589's reproduction, made deterministic: pass B's `open` is held back
    // well past pass A's poll (a pool wait on a loaded runner). With the old
    // timer this let A poll, advance and commit before B read anything, so B
    // advanced to 2. The barrier keeps A parked in its poll until B has read,
    // so the late pass is still a racer and the lock still decides.
    const { run, workspaceId } = await makeRun();
    const bootedAt = new Date();
    const bothPolling = barrier(2);
    const r = recorder({
      poll: async () => {
        await bothPolling();
        return { done: false, startedAt: null, consecutiveReadFailures: 0 };
      },
    });
    const late = lateOpen(new Promise((res) => setTimeout(res, 250)));

    await passDefers(run.id, KEY(bootedAt, workspaceId), r.hooks); // the opening wait
    const results = await Promise.allSettled([
      advanceSupervision(run.id, KEY(bootedAt, workspaceId), r.hooks),
      advanceSupervision(run.id, KEY(bootedAt, workspaceId), { ...r.hooks, store: late }),
    ]);

    expect(results.every((x) => x.status === 'rejected' && isJobRunDefer(x.reason))).toBe(true);
    expect(r.polls.map((p) => p.pollNumber)).toEqual([1, 1]);
    expect((await readRow(run.id))!.pollNumber).toBe(1);
  });

  it('a pass that reads AFTER the other committed is SEQUENTIAL — it polls the next number and advances', async () => {
    // The shape the three CI failures actually were, pinned as CORRECT: the
    // driver has no business declining a pass that read the committed row. It
    // is handed poll 2 and records it. This is why `expected 2 to be 1` was a
    // defect in the test's premise and not in the lock.
    const { run, workspaceId } = await makeRun();
    const bootedAt = new Date();
    const r = recorder({
      poll: () => ({ done: false, startedAt: null, consecutiveReadFailures: 0 }),
    });

    await passDefers(run.id, KEY(bootedAt, workspaceId), r.hooks); // the opening wait
    const first = passDefers(run.id, KEY(bootedAt, workspaceId), r.hooks);
    const second = passDefers(run.id, KEY(bootedAt, workspaceId), {
      ...r.hooks,
      store: lateOpen(first),
    });
    await Promise.all([first, second]);

    expect(r.polls.map((p) => p.pollNumber)).toEqual([1, 2]);
    expect((await readRow(run.id))!.pollNumber).toBe(2);
  });

  it('do not BOTH tear down — the loser reports `raced` and leans on the caller memo', async () => {
    const { run, workspaceId } = await makeRun();
    const bootedAt = new Date();
    // The barrier again: without it the second pass can arrive after the first
    // SETTLED and report `raced` through the replay arm, which proves nothing
    // about the `watching → settling` claim this test is about.
    const bothPolling = barrier(2);
    const r = recorder({
      poll: async () => {
        await bothPolling();
        return { done: true, verdict: 'exit-0' };
      },
    });

    await passDefers(run.id, KEY(bootedAt, workspaceId), r.hooks); // the opening wait
    const [a, b] = await Promise.all([
      advanceSupervision(run.id, KEY(bootedAt, workspaceId), r.hooks),
      advanceSupervision(run.id, KEY(bootedAt, workspaceId), r.hooks),
    ]);

    // Exactly one of them WON the `watching → settling` transition; the other
    // still calls the hook, because in production that hook is a memoized
    // `step.run` and the memo is what makes a second call free and correct.
    expect([a.raced, b.raced].sort()).toEqual([false, true]);
    // Both OBSERVED the container done — neither came in through the replay arm.
    expect([a.reason, b.reason]).toEqual(['completed', 'completed']);
    expect((await readRow(run.id))!.state).toBe('settled');
  });
});

describe('a write that is NOT a lost race', () => {
  it('rethrows — only a UNIQUE violation is a normal outcome of opening a supervision', async () => {
    const { run } = await makeRun();
    const r = recorder({
      poll: () => ({ done: false, startedAt: null, consecutiveReadFailures: 0 }),
    });

    // A `workspace_id` naming no workspace fails the FK, not the unique. The
    // tolerance in `open` is scoped to P2002 precisely so a real write failure
    // is not swallowed into a supervision that then reads a row nothing wrote.
    await expect(
      advanceSupervision(
        run.id,
        { ...KEY(new Date(), 'workspace-that-does-not-exist'), subject: 'p1' },
        r.hooks,
      ),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(r.polls).toHaveLength(0);
    expect(r.settles).toHaveLength(0);
  });
});

describe('the fan-out', () => {
  it('two subjects of ONE run are two independent machines', async () => {
    const { run, workspaceId } = await makeRun();
    const bootedAt = new Date();
    const r = recorder({
      poll: () => ({ done: false, startedAt: null, consecutiveReadFailures: 0 }),
    });

    for (let i = 0; i < 3; i += 1) {
      await passDefers(run.id, { ...KEY(bootedAt, workspaceId), subject: 'project-a' }, r.hooks);
    }
    for (let i = 0; i < 2; i += 1) {
      await passDefers(run.id, { ...KEY(bootedAt, workspaceId), subject: 'project-b' }, r.hooks);
    }

    // Each subject pays its own opening wait, then polls independently.
    expect((await readRow(run.id, 'project-a'))!.pollNumber).toBe(2);
    expect((await readRow(run.id, 'project-b'))!.pollNumber).toBe(1);
  });
});
