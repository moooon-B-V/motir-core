import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { tokenFingerprint } from '@/lib/api/v1/bearer';
import { rateLimitKey } from '@/lib/rateLimit/keys';
import { agentWorkspaceLimb } from '@/lib/rateLimit/workspaceCeiling';
import { rateLimitCounterRepository } from '@/lib/repositories/rateLimitCounterRepository';
import { createV1Caller, withTokenFor, type V1Caller } from '@/tests/fixtures/apiV1Fixtures';
import { truncateAuthTables, truncateRateLimitCounters } from '@/tests/helpers/db';
import { pinSharedRateLimitStoreDeadline } from '@/tests/helpers/rateLimitStore';
import {
  currentWindowStart,
  SUBPROCESS_HEADROOM_MS,
  SUBPROCESS_WINDOW_MS,
  waitForWindowHeadroom,
} from '@/tests/helpers/rateLimitWindow';

// TWO-INSTANCE ENFORCEMENT (MOTIR-8605, Story MOTIR-8548 criterion 10).
//
// `tests/api/v1/shared-store.test.ts` proves the count lands in the shared table,
// but its "two machines" are two store clients inside ONE process. This suite
// runs the MCP limiter in two real OS processes — `__fixtures__/limiterInstance.ts`
// under tsx, each with its own module graph, store singleton and env budgets —
// against this worker's one database, and asserts that one agent split across
// them is refused at ONE budget. Each child runs `limitedHandler`'s sequence:
// verify the PAT, resolve the context, fingerprint it, spend the limbs.
//
// The control arm starts the same pair on the in-process `memory` store and sees
// TWO budgets — so the harness can tell one shared count from two private ones.
//
// The window is the subprocess regime from `rateLimitWindow.ts`: a 60 s window
// with 15 s of headroom, so a case's counted calls cannot straddle a boundary.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const ENTRY = join(HERE, '__fixtures__', 'limiterInstance.ts');
const TSCONFIG = join(HERE, '__fixtures__', 'tsconfig.limiterInstance.json');
const READY_TIMEOUT_MS = 90_000;

interface Answer {
  id: number;
  status: number;
  retryAfterSeconds: number | null;
  limit: number;
  remaining: number;
  instance: string;
}

/** One child "app instance", driven over newline-delimited JSON. */
class Instance {
  readonly proc: ChildProcessWithoutNullStreams;
  stderr = '';
  private nextId = 1;
  private readonly waiting = new Map<number, (a: Answer) => void>();
  readonly ready: Promise<void>;
  readonly exited: Promise<number | null>;

  constructor(
    readonly name: string,
    env: Record<string, string>,
  ) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    delete childEnv['E2E_DISABLE_RATE_LIMIT'];
    if (!('MOTIR_RATE_LIMIT_STORE' in env)) delete childEnv['MOTIR_RATE_LIMIT_STORE'];
    this.proc = spawn(TSX, ['--tsconfig', TSCONFIG, ENTRY], { cwd: ROOT, env: childEnv });
    this.proc.stderr.on('data', (chunk: Buffer) => (this.stderr += chunk.toString()));
    this.exited = new Promise((resolve) => this.proc.on('exit', (code) => resolve(code)));
    let markReady: () => void = () => {};
    let failReady: (err: Error) => void = () => {};
    this.ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    const timer = setTimeout(
      () => failReady(new Error(`${name} never said ready:\n${this.stderr}`)),
      READY_TIMEOUT_MS,
    );
    void this.exited.then((code) => {
      clearTimeout(timer);
      failReady(new Error(`${name} exited ${code} before ready:\n${this.stderr}`));
    });
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      if (line === 'ready') {
        clearTimeout(timer);
        markReady();
        return;
      }
      const answer = JSON.parse(line) as Omit<Answer, 'instance'>;
      this.waiting.get(answer.id)?.({ ...answer, instance: this.name });
      this.waiting.delete(answer.id);
    });
  }

  call(bearer: string): Promise<Answer> {
    const id = this.nextId++;
    const answered = new Promise<Answer>((resolve) => this.waiting.set(id, resolve));
    this.proc.stdin.write(`${JSON.stringify({ id, bearer })}\n`);
    return answered;
  }

  /** Close stdin (the stop signal) and report the exit code. */
  async stop(): Promise<number | null> {
    this.proc.stdin.end();
    return this.exited;
  }
}

const started: Instance[] = [];

/** Start A and B with `env`, and wait on each one's `ready` line. */
async function startPair(env: Record<string, string>): Promise<[Instance, Instance]> {
  const pair: [Instance, Instance] = [new Instance('A', env), new Instance('B', env)];
  started.push(...pair);
  await Promise.all(pair.map((i) => i.ready));
  return pair;
}

async function stopAll(): Promise<void> {
  const failures: string[] = [];
  for (const instance of started.splice(0)) {
    const code = await instance.stop();
    if (code !== 0) failures.push(`${instance.name} exited ${code}:\n${instance.stderr}`);
  }
  if (failures.length > 0) throw new Error(failures.join('\n\n'));
}

function budgets(mcp: number, ceiling: number): Record<string, string> {
  return {
    DATABASE_URL: process.env['DATABASE_URL']!,
    MOTIR_MCP_RATE_LIMIT: String(mcp),
    MOTIR_MCP_RATE_LIMIT_WINDOW_MS: String(SUBPROCESS_WINDOW_MS),
    MOTIR_AGENT_WORKSPACE_RATE_LIMIT: String(ceiling),
    MOTIR_AGENT_WORKSPACE_RATE_LIMIT_WINDOW_MS: String(SUBPROCESS_WINDOW_MS),
  };
}

/** A counter row in the current window, or null. */
async function count(key: string): Promise<number | null> {
  return rateLimitCounterRepository.findCountUnsafe(
    key,
    BigInt(currentWindowStart(SUBPROCESS_WINDOW_MS)),
  );
}

const agentKey = (c: V1Caller) =>
  rateLimitKey('mcp:call', c.workspace.id, tokenFingerprint(c.token));
const ceilingKey = (c: V1Caller) => agentWorkspaceLimb(c.workspace.id).key;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateRateLimitCounters();
  // The counting happens in the CHILDREN, and each pins its own store to the
  // test deadline (`limiterInstance.ts`). This process pins too, so no store it
  // resolves is left at the production deadline (MOTIR-3067).
  pinSharedRateLimitStoreDeadline();
});

afterEach(async () => {
  await stopAll();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('two instances on one database enforce one budget (MOTIR-8605)', () => {
  it('splits one agent across A and B and refuses at ONE per-agent budget; a second agent is unaffected; nothing failed open', async () => {
    const [a, b] = await startPair(budgets(10, 1_000));
    expect(a.proc.pid).toBeDefined();
    expect(a.proc.pid).not.toBe(b.proc.pid);
    expect(process.env['DATABASE_URL']).toBeTruthy();

    const agent = await createV1Caller();
    const other = await withTokenFor(agent.user, agent.workspace);
    await waitForWindowHeadroom(SUBPROCESS_WINDOW_MS, SUBPROCESS_HEADROOM_MS);

    // Sequential: A, B, A, B, …
    const answers: Answer[] = [];
    for (let i = 0; i < 20; i += 1) answers.push(await (i % 2 === 0 ? a : b).call(agent.token));
    expect(answers.filter((x) => x.status === 200)).toHaveLength(10);
    const refused = answers.filter((x) => x.status === 429);
    expect(refused).toHaveLength(10);
    expect(answers.slice(10).every((x) => x.status === 429)).toBe(true);
    expect(new Set(refused.map((x) => x.instance))).toEqual(new Set(['A', 'B']));
    for (const r of refused) {
      expect(typeof r.retryAfterSeconds).toBe('number');
      expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }

    // Case 3 — a second agent of the same user, same window, both instances.
    expect((await a.call(other.token)).status).toBe(200);
    expect((await b.call(other.token)).status).toBe(200);

    // Case 5 — nothing failed open: every call reached the shared table. The
    // agent's own limb counted all 20; the ceiling only what was admitted
    // (MOTIR-8610): 10 of the first agent's and the second agent's 2.
    expect(await count(agentKey(agent))).toBe(20);
    expect(await count(agentKey(other))).toBe(2);
    expect(await count(ceilingKey(agent))).toBe(12);

    // Concurrent round, on a fresh count: at most one budget across both.
    await truncateRateLimitCounters();
    const burst = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? a : b).call(agent.token)),
    );
    expect(burst.filter((x) => x.status === 200).length).toBeLessThanOrEqual(10);
    expect(burst.filter((x) => x.status === 200).length).toBeGreaterThan(0);
    expect(burst.every((x) => x.status === 200 || x.status === 429)).toBe(true);
    expect(await count(agentKey(agent))).toBe(20);
  }, 180_000);

  it('control arm: on the per-process memory store the same split admits TWO budgets', async () => {
    const [a, b] = await startPair({ ...budgets(10, 1_000), MOTIR_RATE_LIMIT_STORE: 'memory' });
    const agent = await createV1Caller();
    await waitForWindowHeadroom(SUBPROCESS_WINDOW_MS, SUBPROCESS_HEADROOM_MS);

    const answers: Answer[] = [];
    for (let i = 0; i < 20; i += 1) answers.push(await (i % 2 === 0 ? a : b).call(agent.token));
    expect(answers.filter((x) => x.status === 200)).toHaveLength(20);
    // And nothing reached the shared table — the defect the real arm rules out.
    expect(await count(agentKey(agent))).toBeNull();
  }, 180_000);

  it('holds the workspace to ONE ceiling across instances, and leaves another workspace alone', async () => {
    const [a, b] = await startPair(budgets(100, 6));
    const first = await createV1Caller();
    const agents = [first];
    for (let i = 1; i < 6; i += 1) agents.push(await withTokenFor(first.user, first.workspace));
    const elsewhere = await createV1Caller({ workspaceName: 'Elsewhere' });
    await waitForWindowHeadroom(SUBPROCESS_WINDOW_MS, SUBPROCESS_HEADROOM_MS);

    for (const [i, agent] of agents.entries()) {
      expect((await (i < 3 ? a : b).call(agent.token)).status).toBe(200);
    }
    expect((await b.call(first.token)).status).toBe(429);
    expect((await a.call(elsewhere.token)).status).toBe(200);
    expect((await b.call(elsewhere.token)).status).toBe(200);

    // Case 5 — every call counted: each agent's own row, and the ceiling's 7
    // (the seventh call was admitted by its own limb, so it reached the ceiling).
    expect(await count(agentKey(first))).toBe(2);
    for (const agent of agents.slice(1)) expect(await count(agentKey(agent))).toBe(1);
    expect(await count(ceilingKey(first))).toBe(7);
    expect(await count(ceilingKey(elsewhere))).toBe(2);
  }, 180_000);
});
