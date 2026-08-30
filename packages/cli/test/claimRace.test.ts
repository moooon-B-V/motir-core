import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MotirClient, WorkItemClaim } from '../src/client.js';
import { resolveFakeClaim } from './helpers/fakeClaim.js';

// TWO `motir run` INVOCATIONS AT ONE CARD — exactly one dispatches (MOTIR-3048).
//
// ⚠️ THIS IS THE ONE PROPERTY THAT IS ONLY VISIBLE WHEN TWO RUNS RACE, and it is
// the property the advisory assignment never had. Everything else this card
// changed is observable from a single invocation: the outcomes, the messages,
// the skip reasons. Not this one. `client.ts`'s old comment on `isPickable` said
// so in as many words — *"two runs starting together both read the same page,
// both see the row unassigned, both take it. That race is ACCEPTED"* — because
// closing it needed a conditional write the server did not offer. It does now,
// so the race has a test instead of a paragraph explaining itself.
//
// ── What makes this a RACE and not a sequence ───────────────────────────────
// Both invocations reach the claim before EITHER of them resolves: the fake
// holds the first arrival at a barrier until the second arrives, so the two are
// genuinely in flight together — the read-to-write gap the old pair fell into.
// Only then does each resolve, against the ONE shared row, by the server's own
// rule. That is the single-process analogue of `SELECT … FOR UPDATE`: the
// decision and the write are one step, so the loser sees the winner's row.
//
// ── Why the two runs are two DIFFERENT owners ───────────────────────────────
// Two runs by the SAME token owner at one card is not a collision, it is the
// documented RESUME: the second gets `mine` and proceeds, which is what lets a
// killed run be re-run. The failure this closes is two AGENTS on one card, and
// that needs two operators. The same-owner case is asserted in
// `dispatchCommand.test.ts` ("MINE — proceeds").

const { sessionQueue } = vi.hoisted(() => ({ sessionQueue: { pending: [] as unknown[] } }));

vi.mock('../src/agentRun.js', () => ({ runAgent: vi.fn() }));

// Each `runCommand` opens exactly one session, in call order — so two
// concurrent invocations take the two sessions in the order they were queued.
vi.mock('../src/session.js', () => ({
  withProjectSession: async (fn: (s: unknown) => Promise<unknown>) =>
    fn(sessionQueue.pending.shift()),
}));

const { runCommand } = await import('../src/commands/dispatch.js');

const SERVER = 'https://app.motir.co';
const NAMES: Record<string, string> = { user_a: 'Ada', user_b: 'Bo' };

/** The ONE row both runs are pointed at. */
interface Row {
  key: string;
  title: string;
  status: string;
  assigneeId: string | null;
}

/**
 * A barrier that releases once N waiters have arrived.
 *
 * Without it the first `runCommand` would complete its claim before the second
 * had made one, and the test would assert a SEQUENCE — which the old two-write
 * pair also passes.
 */
function barrier(count: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= count) release();
    await open;
  };
}

interface Recorded {
  owner: string;
  tool: string;
  key: string;
}

/** One CLI client, standing for one operator's `motir run` process. */
function clientFor(
  owner: string,
  row: Row,
  calls: Recorded[],
  gate: () => Promise<void>,
): MotirClient {
  const fake = {
    whoami: async () => ({
      user: { id: owner, name: NAMES[owner] ?? owner, email: `${owner}@motir.test` },
      workspace: null,
    }),
    getWorkItem: async (key: string) => {
      calls.push({ owner, tool: 'get_work_item', key });
      return {
        item: {
          identifier: row.key,
          kind: 'subtask',
          title: row.title,
          status: row.status,
          priority: 'high',
          assigneeId: row.assigneeId,
          type: 'code',
          executor: 'coding_agent',
          storyPoints: 3,
          estimateMinutes: 40,
          targetRepo: 'motir-core',
          sprintId: null,
          descriptionMd: null,
        },
        ancestors: [],
        children: [],
        blockedBy: [],
        blocks: [],
        relatesTo: [],
        readiness: { ready: true, openBlockers: [], blockedByAncestor: null },
      };
    },
    claimWorkItem: async (args: { key: string }): Promise<WorkItemClaim> => {
      // ⚠️ BOTH RUNS ARE HERE BEFORE EITHER RESOLVES. Everything after the await
      // is one synchronous step against the shared row — the lock, modelled.
      await gate();
      calls.push({ owner, tool: 'claim', key: args.key });
      const { claim, apply } = resolveFakeClaim(
        row,
        { id: owner, name: NAMES[owner] ?? owner },
        (id) => NAMES[id] ?? id,
      );
      if (apply) {
        row.status = apply.status;
        row.assigneeId = apply.assigneeId;
      }
      return claim;
    },
    transitionStatus: async (args: { key: string; status: string }) => {
      calls.push({ owner, tool: 'transition_status', key: args.key });
      return {};
    },
    dispatchPrompt: async (key: string) => {
      calls.push({ owner, tool: 'dispatch_prompt', key });
      return {
        key,
        prompt: `PROMPT ${key}\n`,
        parentKey: null,
        targetRepo: 'motir-core',
        workflowMode: 'per_item_pr' as const,
        sessionBranch: null,
      };
    },
  };
  return fake as unknown as MotirClient;
}

let root: string;
let home: string;
let stderr: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'motir-race-'));
  mkdirSync(join(root, 'motir-core'));
  home = mkdtempSync(join(tmpdir(), 'motir-race-cfg-'));
  process.env['MOTIR_CONFIG_HOME'] = home;
  sessionQueue.pending = [];
  stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['MOTIR_CONFIG_HOME'];
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('two concurrent `motir run` invocations at ONE card', () => {
  it('exactly one dispatches, and the loser can NAME the winner', async () => {
    const row: Row = { key: 'PROD-7', title: 'Add the thing', status: 'todo', assigneeId: null };
    const calls: Recorded[] = [];
    const gate = barrier(2);

    for (const owner of ['user_a', 'user_b']) {
      sessionQueue.pending.push({
        client: clientFor(owner, row, calls, gate),
        serverUrl: SERVER,
        projectKey: 'PROD',
        link: {
          dir: root,
          path: join(root, '.motir.json'),
          config: { serverUrl: SERVER, workspace: 'moooon', project: 'PROD' },
        },
      });
    }

    await Promise.all([
      runCommand('PROD-7', { print: true }),
      runCommand('PROD-7', { print: true }),
    ]);

    // BOTH claimed — that is what makes this a race and not a sequence.
    expect(calls.filter((c) => c.tool === 'claim')).toHaveLength(2);

    // …and exactly ONE of them went on to fetch a prompt. This is the assertion
    // the whole card is for: under the old assign-then-transition pair both
    // would have, because an unconditional assignment cannot lose.
    const dispatchers = calls.filter((c) => c.tool === 'dispatch_prompt');
    expect(dispatchers).toHaveLength(1);

    const winner = dispatchers[0]!.owner;
    const loser = winner === 'user_a' ? 'user_b' : 'user_a';
    expect(row.assigneeId).toBe(winner);
    expect(row.status).toBe('in_progress');

    // The loser names the holder rather than reporting a bare "could not claim
    // it" — the discrimination this card exists to preserve.
    expect(stderr).toContain(`already claimed by ${NAMES[winner]}`);
    expect(stderr).toContain('Two agents on one work item');
    expect(loser).not.toBe(winner);

    // A lost race is not a failed run: the loser exits cleanly, having changed
    // nothing and started nothing.
    expect(process.exitCode).toBeUndefined();
    expect(calls.filter((c) => c.tool === 'transition_status')).toEqual([]);
  });
});
