import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedAgentCommand } from '../src/agentProfiles.js';
import type { CiWatchPhaseInput } from '../src/ciWatch.js';

// Which conversation each lane's CI watch resumes (MOTIR-9059). The watch itself is faked:
// what is pinned is the HAND-OFF — each card's own session, never another card's — and that a
// card with nothing to resume hands the watch nothing.

const watched = vi.hoisted(() => ({ inputs: [] as unknown[] }));

vi.mock('../src/ciWatch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ciWatch.js')>()),
  runCiWatchPhase: async (input: unknown) => {
    watched.inputs.push(input);
    return { kind: 'green' };
  },
}));

const { watchRunCi } = await import('../src/commands/auto.js');
const { watchCardCi } = await import('../src/commands/batch.js');
const { agentModeAgent } = await import('../src/commands/dispatch.js');

const claude = (): ParsedAgentCommand => agentModeAgent({ MOTIR_SANDBOX_AGENT: 'claude' });
const seen = () => watched.inputs as CiWatchPhaseInput[];

beforeEach(() => {
  watched.inputs.length = 0;
});

describe('motir auto — watchRunCi', () => {
  const record = (key: string, sessionId: string | null | undefined) => ({
    key,
    title: key,
    outcome: 'integrated' as const,
    durationMs: 1,
    sessionBranch: 'session/x',
    repo: 'acme/app',
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  const summary = (records: ReturnType<typeof record>[]) =>
    ({
      records,
      repos: [{ repoName: 'acme/app', cwd: '/w', keys: records.map((r) => r.key) }],
    }) as never;

  it('gives each landed card its OWN session, and none to a card that recorded none', async () => {
    const agent = { parsed: claude() } as never;
    await watchRunCi(
      summary([record('P-1', 'sess-1'), record('P-2', 'sess-2'), record('P-3', null)]),
      { client: {} } as never,
      agent,
      {} as never,
      {},
    );
    const [a, b, c] = seen();
    expect(a!.resumeAgent?.stream?.sessionId).toBe('sess-1');
    expect(b!.resumeAgent?.stream?.sessionId).toBe('sess-2');
    expect(c!.resumeAgent).toBeUndefined();
  });

  it('hands nothing for a command with no stream block — the watch keeps the command it has', async () => {
    const plain = { command: 'echo', args: [], env: undefined } as unknown as ParsedAgentCommand;
    await watchRunCi(
      summary([record('P-1', 'sess-1')]),
      { client: {} } as never,
      { parsed: plain } as never,
      {} as never,
      {},
    );
    expect(seen()[0]!.resumeAgent).toBeUndefined();
    expect(seen()[0]!.agent).toBe(plain);
  });
});

describe('motir batch — watchCardCi', () => {
  const rec = (key: string, sessionId?: string | null) => ({
    key,
    title: key,
    outcome: 'implemented' as const,
    durationMs: 1,
    repo: 'acme/app',
    ...(sessionId === undefined ? {} : { sessionId }),
  });

  it('hands each card its own session and none when the card recorded none', async () => {
    const gate = watchCardCi({
      session: { client: {} } as never,
      agent: { parsed: claude() },
      deps: {},
      keepGoing: false,
    });
    expect(await gate(rec('P-1', 'sess-1'), { cwd: '/w' })).toBe('continue');
    await gate(rec('P-2', 'sess-2'), { cwd: '/w' });
    await gate(rec('P-3', null), { cwd: '/w' });
    const [a, b, c] = seen();
    expect(a!.resumeAgent?.stream?.sessionId).toBe('sess-1');
    expect(b!.resumeAgent?.stream?.sessionId).toBe('sess-2');
    expect(c!.resumeAgent).toBeUndefined();
    expect(seen().map((i) => i.cwd)).toEqual(['/w', '/w', '/w']);
  });

  it('does not watch a card that was not built', async () => {
    const gate = watchCardCi({
      session: { client: {} } as never,
      agent: { parsed: claude() },
      deps: {},
      keepGoing: false,
    });
    expect(await gate({ ...rec('P-1', 'sess-1'), outcome: 'failed' }, { cwd: '/w' })).toBe(
      'continue',
    );
    expect(seen()).toHaveLength(0);
  });
});
