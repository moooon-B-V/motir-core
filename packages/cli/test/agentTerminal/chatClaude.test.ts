import { mkdtemp, mkdir, readFile, rm, utimes, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAT_ADAPTERS,
  HISTORY_BUDGET_BYTES,
  MAX_LISTED_SESSIONS,
  resolveChatAdapter,
  type ChatContext,
} from '../../src/agentTerminal/chat/adapter.js';
import {
  claudeChatAdapter,
  claudeProjectDir,
  createClaudeChatAdapter,
  createClaudeMapper,
} from '../../src/agentTerminal/chat/adapters/claude.js';
import type { TranscriptEvent } from '../../src/agentTerminal/chat/protocol.js';
import { createChatHub, type ChatHub } from '../../src/agentTerminal/chat/turns.js';
import { fakeChatSpawner, type FakeChatProcess, type Frame } from './harness.js';

// The Claude Code chat adapter (MOTIR-7014 · `docs/decisions/agent-chat.md`
// Q1's `claude` row, Q2 (b), Q3, Q5, Q6, Q7, Q10, Q11), against fixtures derived
// from the ADR's real 2.1.280 captures (see fixtures/chat/claude/README.md).
// No real `claude` is ever run: the probe is injected and every turn process
// is a fake that replays a fixture.

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'chat', 'claude');
const SESSION = '49c4fa44-2f7e-4f0a-9d3b-5a1c0e7b2d10';
const RESUMED = '7d0e3b52-91a4-4c6e-8f2d-0b6a93c1e5f7';
const MINTED = '11111111-2222-4333-8444-555555555555';

const CTX: ChatContext = {
  home: '/home/agent',
  cwd: '/home/agent/workspace',
  env: { HOME: '/home/agent', PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/home/agent/.claude-x' },
};

async function fixture(name: string): Promise<string> {
  return readFile(join(FIXTURES, name), 'utf8');
}

/** A stream fixture's lines, its `# ` version header dropped. */
async function streamLines(name: string): Promise<string[]> {
  const text = await fixture(name);
  const [header, ...lines] = text.split('\n').filter((line) => line.length > 0);
  expect(header).toMatch(/^# Claude Code 2\.1\.280 stream-json/);
  return lines;
}

function probeOf(answer: string | Error): {
  calls: ChatContext[];
  probe: (ctx: ChatContext) => Promise<string>;
} {
  const calls: ChatContext[] = [];
  return {
    calls,
    probe: async (ctx) => {
      calls.push(ctx);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

class FakeSocket {
  isOpen = true;
  readonly frames: Frame[] = [];
  send(text: string): void {
    this.frames.push(JSON.parse(text) as Frame);
  }
  of(t: string): Frame[] {
    return this.frames.filter((frame) => frame['t'] === t);
  }
  events(): TranscriptEvent[] {
    return this.of('event').map((frame) => frame['e'] as TranscriptEvent);
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** Wait, on the real clock, for a condition that real I/O satisfies. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

const hubs: ChatHub[] = [];
const temps: string[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.close();
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** The runner around the REAL adapter, with an injected probe and a fake spawn. */
async function rig(authFixture: string, ctx: ChatContext = CTX) {
  const { probe } = probeOf(await fixture(authFixture));
  const adapter = createClaudeChatAdapter({ probe, newSessionId: () => MINTED });
  const { spawn, procs } = fakeChatSpawner();
  const logs: string[] = [];
  const hub = createChatHub({
    profile: 'claude',
    adapter,
    ctx,
    spawn,
    readSignIn: async () => ({ profile: 'claude', state: 'signed_in' }),
    log: (line) => logs.push(line),
  });
  hubs.push(hub);
  const socket = new FakeSocket();
  const handle = hub.accept(socket);
  const send = (frame: Frame): void => handle.message(Buffer.from(JSON.stringify(frame)), false);
  await settle();
  return { hub, adapter, procs, logs, socket, send };
}

/** Open a chat (or resume `session`), prompt, and replay a fixture through the fake process. */
async function replay(
  authFixture: string,
  streamFixture: string,
  options: { session?: string; exitCode?: number; stopBeforeEnd?: boolean } = {},
) {
  const r = await rig(authFixture);
  r.send(options.session ? { t: 'open', session: options.session } : { t: 'open' });
  await settle();
  // A resume reads the store (real I/O) before it goes live.
  if (options.session) await until(() => r.socket.of('history').length > 0);
  r.send({ t: 'prompt', text: 'the prompt SECRET-PROMPT' });
  await settle();
  const proc = r.procs[0] as FakeChatProcess;
  expect(proc).toBeDefined();
  if (options.stopBeforeEnd) {
    r.send({ t: 'stop' });
    await settle();
    expect(proc.signals).toEqual(['SIGINT']);
  }
  for (const line of await streamLines(streamFixture)) {
    if (proc.exited) break;
    proc.line(line);
  }
  proc.exit(options.exitCode ?? 0);
  await settle();
  return { ...r, proc, events: r.socket.events() };
}

describe('registration', () => {
  it('is registered for the claude profile', () => {
    expect(CHAT_ADAPTERS).toContain(claudeChatAdapter);
    expect(resolveChatAdapter('claude')).toBe(claudeChatAdapter);
    expect(claudeChatAdapter.profile).toBe('claude');
  });
});

describe('the gate — support() reads `claude auth status --json` (Q2 option b)', () => {
  it.each([
    ['auth-status-api-key.json'],
    ['auth-status-api-key-over-oauth.json'],
    ['auth-status-cloud-provider.json'],
  ])('allows %s', async (name) => {
    const { probe, calls } = probeOf(await fixture(name));
    const adapter = createClaudeChatAdapter({ probe });
    expect(await adapter.support(CTX)).toEqual({ supported: true, signedIn: true });
    expect(calls).toEqual([CTX]);
  });

  it.each([
    ['auth-status-subscription.json'],
    ['auth-status-key-source-none.json'],
    ['auth-status-signed-out.json'],
  ])('refuses %s as subscription_signin', async (name) => {
    const { probe } = probeOf(await fixture(name));
    const adapter = createClaudeChatAdapter({ probe });
    expect(await adapter.support(CTX)).toEqual({ supported: false, code: 'subscription_signin' });
  });

  it('answers unsupported — never a yes — when the probe cannot run or its answer cannot be read', async () => {
    for (const answer of [new Error('ENOENT /usr/bin/claude'), 'not json', '[]', '']) {
      const adapter = createClaudeChatAdapter({ probe: probeOf(answer).probe });
      expect(await adapter.support(CTX)).toEqual({ supported: false, code: 'unsupported' });
    }
  });

  it('on a subscription sign-in, a prompt is refused and NO process is spawned (asserted on the fake spawn)', async () => {
    const r = await rig('auth-status-subscription.json');
    expect(r.socket.of('hello')[0]).toMatchObject({
      supported: false,
      reason: 'subscription_signin',
    });
    r.send({ t: 'open' });
    await settle();
    r.send({ t: 'prompt', text: 'hello' });
    await settle();
    expect(r.socket.of('error')).toEqual([{ t: 'error', code: 'subscription_signin' }]);
    expect(r.procs).toHaveLength(0);
  });
});

describe('the backstop — `system/init` with apiKeySource "none"', () => {
  it('makes the runner kill the process and end the turn failed with subscription_signin', async () => {
    const { proc, events } = await replay('auth-status-api-key.json', 'no-key.jsonl');
    expect(proc.signals).toEqual(['SIGKILL']);
    // Nothing the killed turn would have said is drawn.
    expect(events.filter((event) => event.k === 'text')).toEqual([]);
    expect(events.at(-1)).toEqual({ k: 'turn_end', reason: 'failed', code: 'subscription_signin' });
  });

  it('draws nothing the process wrote after the init line, even when the whole stream arrives in one read', async () => {
    const r = await rig('auth-status-api-key.json');
    r.send({ t: 'open' });
    await settle();
    r.send({ t: 'prompt', text: 'p' });
    await settle();
    const proc = r.procs[0] as FakeChatProcess;
    proc.raw((await streamLines('no-key.jsonl')).join('\n') + '\n');
    await settle();
    proc.exit(0);
    await settle();
    expect(proc.signals).toEqual(['SIGKILL']);
    const events = r.socket.events();
    expect(events.filter((event) => event.k !== 'user')).toEqual([
      { k: 'turn_end', reason: 'failed', code: 'subscription_signin' },
    ]);
  });

  it('does not fire on a cloud-provider sign-in, whose init honestly carries no Anthropic key', async () => {
    const { proc, events } = await replay('auth-status-cloud-provider.json', 'no-key.jsonl');
    expect(proc.signals).toEqual([]);
    expect(events.at(-1)).toEqual({ k: 'turn_end', reason: 'completed' });
  });
});

describe('the spawn — Q3 exactly, Q11 nothing added', () => {
  it('starts a new chat with the minted --session-id, the prompt on stdin, and the environment untouched', async () => {
    const { proc } = await replay('auth-status-api-key.json', 'text-reply.jsonl');
    expect(proc.options.file).toBe('claude');
    expect(proc.options.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--session-id',
      MINTED,
      '--dangerously-skip-permissions',
    ]);
    expect(proc.options.stdin).toBe('the prompt SECRET-PROMPT');
    expect(proc.options.cwd).toBe(CTX.cwd);
    expect(proc.options.env).toEqual(CTX.env);
    expect(proc.options.args).not.toContain('--bare');
    expect(Object.keys(proc.options.env)).not.toContain('ANTHROPIC_API_KEY');
    expect(JSON.stringify(proc.options)).not.toContain('ANTHROPIC_API_KEY');
  });

  it('resumes with --resume <id> in place of --session-id', () => {
    const command = claudeChatAdapter.turnCommand({ prompt: 'p', sessionId: RESUMED, ctx: CTX });
    expect(command).toEqual({
      file: 'claude',
      args: [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--resume',
        RESUMED,
        '--dangerously-skip-permissions',
      ],
      stdin: 'p',
    });
    expect(command.env).toBeUndefined();
  });

  it('mints a fresh uuid per new chat by default', () => {
    const a = claudeChatAdapter.turnCommand({ prompt: 'p', sessionId: null, ctx: CTX }).args[6];
    const b = claudeChatAdapter.turnCommand({ prompt: 'p', sessionId: null, ctx: CTX }).args[6];
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});

describe('the mapping — each fixture replayed yields Q5’s events, in order', () => {
  it('a plain reply: text deltas once (thinking and the repeated full message dropped), completed', async () => {
    const { events, socket } = await replay('auth-status-api-key.json', 'text-reply.jsonl');
    expect(events).toEqual([
      { k: 'user', text: 'the prompt SECRET-PROMPT' },
      { k: 'text', id: 'msg_01A:1', delta: 'The directory ' },
      { k: 'text', id: 'msg_01A:1', delta: 'contains the files ' },
      { k: 'text', id: 'msg_01A:1', delta: 'listed above.' },
      { k: 'turn_end', reason: 'completed' },
    ]);
    expect(socket.of('session')).toEqual([{ t: 'session', id: SESSION }]);
    // Q10: no cost or token field reaches the browser.
    expect(JSON.stringify(socket.frames)).not.toMatch(/cost|usage|tokens/);
  });

  it('a read', async () => {
    const { events } = await replay('auth-status-api-key.json', 'read.jsonl');
    expect(events.slice(1, 3)).toEqual([
      {
        k: 'tool_call',
        id: 'toolu_02read',
        kind: 'read',
        name: 'Read',
        title: '/home/agent/workspace/README.md',
        path: '/home/agent/workspace/README.md',
      },
      {
        k: 'tool_result',
        id: 'toolu_02read',
        ok: true,
        output: '     1\t# Demo\n     2\tA small repository.\n',
        truncated: false,
      },
    ]);
    expect(
      events
        .filter((event) => event.k === 'text')
        .map((event) => event.k === 'text' && event.delta),
    ).toEqual(['README.md describes ', 'a small repository.']);
    expect(events.at(-1)).toEqual({ k: 'turn_end', reason: 'completed' });
  });

  it('an edit carries its diff', async () => {
    const { events } = await replay('auth-status-api-key.json', 'edit.jsonl');
    expect(events[1]).toEqual({
      k: 'tool_call',
      id: 'toolu_03edit',
      kind: 'edit',
      name: 'Edit',
      title: '/home/agent/workspace/src/greet.ts',
      path: '/home/agent/workspace/src/greet.ts',
      diff:
        '--- a/home/agent/workspace/src/greet.ts\n+++ b/home/agent/workspace/src/greet.ts\n' +
        "@@ -1 +1 @@\n-export const greeting = 'hi';\n+export const greeting = 'hello';\n",
    });
    expect(events[2]).toMatchObject({ k: 'tool_result', id: 'toolu_03edit', ok: true });
    expect(events.at(-1)).toEqual({ k: 'turn_end', reason: 'completed' });
  });

  it('a bash command carries its command and its output', async () => {
    const { events } = await replay('auth-status-api-key.json', 'bash.jsonl');
    expect(events.slice(1, 3)).toEqual([
      {
        k: 'tool_call',
        id: 'toolu_8101bash',
        kind: 'command',
        name: 'Bash',
        title: 'List files',
        command: 'ls',
      },
      { k: 'tool_result', id: 'toolu_8101bash', ok: true, output: 'a.txt\nb.md', truncated: false },
    ]);
    expect(events.at(-1)).toEqual({ k: 'turn_end', reason: 'completed' });
  });

  it('a failed tool call yields a failed tool result with its exit code', async () => {
    const { events } = await replay('auth-status-api-key.json', 'failed-tool.jsonl');
    expect(events[2]).toEqual({
      k: 'tool_result',
      id: 'toolu_05fail',
      ok: false,
      output: 'Exit code 1\ncat: missing.txt: No such file or directory',
      exitCode: 1,
      truncated: false,
    });
    // A failed tool does not fail the turn.
    expect(events.at(-1)).toEqual({ k: 'turn_end', reason: 'completed' });
  });

  it('a stopped turn ends `stopped`, once — the aborted_streaming result is consumed, not shown', async () => {
    const { events, proc } = await replay('auth-status-api-key.json', 'stopped.jsonl', {
      stopBeforeEnd: true,
    });
    expect(proc.signals).toEqual(['SIGINT']);
    expect(events).toEqual([
      { k: 'user', text: 'the prompt SECRET-PROMPT' },
      { k: 'text', id: 'msg_06A:0', delta: 'Here is a long ' },
      { k: 'text', id: 'msg_06A:0', delta: 'explanation of' },
      { k: 'turn_end', reason: 'stopped' },
    ]);
  });

  it('an aborted_streaming result nobody asked for is not an end marker', () => {
    const mapper = createClaudeMapper();
    mapper.onLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        terminal_reason: 'aborted_streaming',
      }),
    );
    expect(mapper.sawEnd()).toBe(false);
  });

  it('a resumed session: --resume, the session revealed from init, the reply mapped', async () => {
    const { events, proc, socket } = await replay('auth-status-api-key.json', 'resume.jsonl', {
      session: RESUMED,
    });
    expect(proc.options.args).toContain('--resume');
    expect(proc.options.args[proc.options.args.indexOf('--resume') + 1]).toBe(RESUMED);
    expect(proc.options.args).not.toContain('--session-id');
    expect(socket.of('ready')).toEqual([{ t: 'ready', session: RESUMED, resumed: true }]);
    expect(
      events
        .filter((event) => event.k === 'text')
        .map((event) => event.k === 'text' && event.delta),
    ).toEqual(['We were talking about ', 'the README.']);
    expect(events.at(-1)).toEqual({ k: 'turn_end', reason: 'completed' });
  });

  it('an error result is shown as an inline error, and the non-zero exit fails the turn', async () => {
    const r = await rig('auth-status-api-key.json');
    r.send({ t: 'open' });
    await settle();
    r.send({ t: 'prompt', text: 'p' });
    await settle();
    const proc = r.procs[0] as FakeChatProcess;
    proc.line({ type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 1 });
    proc.exit(1);
    await settle();
    expect(r.socket.events().slice(1)).toEqual([
      { k: 'error', code: 'error_max_turns' },
      { k: 'turn_end', reason: 'failed', code: 'exit_nonzero' },
    ]);
  });

  it('an unrecognised line does not end the turn and is never logged', async () => {
    const { events, logs } = await replay('auth-status-api-key.json', 'unknown-line.jsonl');
    expect(events).toEqual([
      { k: 'user', text: 'the prompt SECRET-PROMPT' },
      { k: 'other', name: 'future_event' },
      { k: 'text', id: 'msg_09A:1', delta: 'Still here.' },
      { k: 'turn_end', reason: 'completed' },
    ]);
    const logged = logs.join('\n');
    expect(logged).not.toMatch(/SECRET|future_event|Still here|README|toolu_/);
    expect(logged).not.toContain(SESSION);
  });

  it('a subagent’s own stream (parent_tool_use_id set) and thinking are dropped', () => {
    const mapper = createClaudeMapper();
    expect(
      mapper.onLine(
        JSON.stringify({
          type: 'assistant',
          parent_tool_use_id: 'toolu_task',
          message: { id: 'm', content: [{ type: 'text', text: 'inner' }] },
        }),
      ),
    ).toEqual([]);
    expect(
      mapper.onLine(
        JSON.stringify({
          type: 'assistant',
          parent_tool_use_id: null,
          message: { id: 'm2', content: [{ type: 'thinking', thinking: 'secret' }] },
        }),
      ),
    ).toEqual([]);
  });

  it('maps MultiEdit and Write to edits with diffs, and any other tool to `other`', () => {
    const mapper = createClaudeMapper();
    const events = mapper.onLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'MultiEdit',
              input: {
                file_path: 'a.ts',
                edits: [
                  { old_string: 'a', new_string: 'b' },
                  { old_string: 'c', new_string: 'd' },
                ],
              },
            },
            {
              type: 'tool_use',
              id: 't2',
              name: 'Write',
              input: { file_path: 'n.ts', content: 'x\ny\n' },
            },
            { type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'foo' } },
          ],
        },
      }),
    );
    expect(events).toEqual([
      {
        k: 'tool_call',
        id: 't1',
        kind: 'edit',
        name: 'MultiEdit',
        title: 'a.ts',
        path: 'a.ts',
        diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n@@ -1 +1 @@\n-c\n+d\n',
      },
      {
        k: 'tool_call',
        id: 't2',
        kind: 'edit',
        name: 'Write',
        title: 'n.ts',
        path: 'n.ts',
        diff: '--- a/n.ts\n+++ b/n.ts\n@@ -0 +2 @@\n+x\n+y\n',
      },
      { k: 'tool_call', id: 't3', kind: 'other', name: 'Grep', title: 'Grep' },
    ]);
  });
});

describe('the session list and history — Claude Code’s own store (Q7)', () => {
  async function store(): Promise<ChatContext> {
    const home = await mkdtemp(join(tmpdir(), 'motir-chat-claude-'));
    temps.push(home);
    return {
      home,
      cwd: join(home, 'workspace'),
      env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude-private') },
    };
  }

  function session(prompt: string): string {
    return (
      [
        { type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: meta' } },
        { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
        { type: 'user', message: { role: 'user', content: prompt } },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n'
    );
  }

  it('names the project dir after the cwd, under CLAUDE_CONFIG_DIR (else ~/.claude)', () => {
    expect(claudeProjectDir(CTX)).toBe('/home/agent/.claude-x/projects/-home-agent-workspace');
    expect(claudeProjectDir({ ...CTX, env: {} })).toBe(
      '/home/agent/.claude/projects/-home-agent-workspace',
    );
  });

  it('lists only $HOME/workspace sessions, newest first, at most 50, titles cut to 120 characters', async () => {
    const ctx = await store();
    const dir = claudeProjectDir(ctx);
    await mkdir(dir, { recursive: true });
    const base = Date.parse('2026-09-01T00:00:00Z') / 1000;
    for (let i = 0; i < 55; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const path = join(dir, `${id}.jsonl`);
      await writeFile(path, session(i === 54 ? 'x'.repeat(300) : `prompt ${i}`));
      await utimes(path, base + i * 60, base + i * 60);
    }
    // Another project's session, a summary-titled one, an empty one and a stray file.
    const other = join(ctx.env['CLAUDE_CONFIG_DIR']!, 'projects', '-somewhere-else');
    await mkdir(other, { recursive: true });
    await writeFile(
      join(other, 'aaaaaaaa-0000-4000-8000-000000000000.jsonl'),
      session('elsewhere'),
    );
    await writeFile(join(dir, 'notes.txt'), 'not a session');

    const items = await claudeChatAdapter.listSessions(ctx, MAX_LISTED_SESSIONS);
    expect(items).toHaveLength(50);
    expect(items[0]).toEqual({
      id: '00000000-0000-4000-8000-000000000054',
      title: 'x'.repeat(120),
      updatedAt: new Date((base + 54 * 60) * 1000).toISOString(),
    });
    expect(items[1]!.title).toBe('prompt 53');
    expect(items.at(-1)!.title).toBe('prompt 5');
    const times = items.map((item) => Date.parse(item.updatedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(items.map((item) => item.title)).not.toContain('elsewhere');
  });

  it('prefers the store’s own summary as the title, and skips a session with no prompt', async () => {
    const ctx = await store();
    const dir = claudeProjectDir(ctx);
    await mkdir(dir, { recursive: true });
    await copyFile(join(FIXTURES, 'store', `${RESUMED}.jsonl`), join(dir, `${RESUMED}.jsonl`));
    await writeFile(
      join(dir, '22222222-0000-4000-8000-000000000000.jsonl'),
      '{"type":"summary"}\n',
    );
    expect(await claudeChatAdapter.listSessions(ctx, 50)).toEqual([
      expect.objectContaining({ id: RESUMED, title: 'Tidy the README and list the files' }),
    ]);
  });

  it('answers an empty list when the store does not exist', async () => {
    expect(await claudeChatAdapter.listSessions(await store(), 50)).toEqual([]);
  });

  it('reads a resumed session’s history: prompts, text, tool calls and results, no meta, thinking or sidechain', async () => {
    const ctx = await store();
    const dir = claudeProjectDir(ctx);
    await mkdir(dir, { recursive: true });
    await copyFile(join(FIXTURES, 'store', `${RESUMED}.jsonl`), join(dir, `${RESUMED}.jsonl`));
    const history = await claudeChatAdapter.readHistory(ctx, RESUMED, HISTORY_BUDGET_BYTES);
    expect(history).toEqual({
      truncated: false,
      events: [
        { k: 'user', text: 'What is in this directory?' },
        {
          k: 'tool_call',
          id: 'toolu_h1',
          kind: 'command',
          name: 'Bash',
          title: 'List files',
          command: 'ls',
        },
        { k: 'tool_result', id: 'toolu_h1', ok: true, output: 'a.txt\nb.md', truncated: false },
        { k: 'text', id: 'msg_h2:h0', delta: 'The directory contains a.txt and b.md.' },
        { k: 'user', text: 'Now fix the README title.' },
        {
          k: 'tool_call',
          id: 'toolu_h2',
          kind: 'edit',
          name: 'Edit',
          title: '/home/agent/workspace/README.md',
          path: '/home/agent/workspace/README.md',
          diff: '--- a/home/agent/workspace/README.md\n+++ b/home/agent/workspace/README.md\n@@ -1 +1 @@\n-# demo\n+# Demo\n',
        },
        {
          k: 'tool_result',
          id: 'toolu_h2',
          ok: true,
          output: 'The file /home/agent/workspace/README.md has been updated.',
          truncated: false,
        },
        { k: 'text', id: 'msg_h4:h0', delta: "Done: the title is now '# Demo'." },
      ],
    });
  });

  it('keeps the newest whole turns within the budget, and says it cut', async () => {
    const ctx = await store();
    const dir = claudeProjectDir(ctx);
    await mkdir(dir, { recursive: true });
    await copyFile(join(FIXTURES, 'store', `${RESUMED}.jsonl`), join(dir, `${RESUMED}.jsonl`));
    const history = await claudeChatAdapter.readHistory(ctx, RESUMED, 700);
    expect(history).toMatchObject({ truncated: true });
    if ('unavailable' in history) throw new Error('unexpected');
    expect(history.events[0]).toEqual({ k: 'user', text: 'Now fix the README title.' });
  });

  it('answers unavailable for a session it cannot read', async () => {
    const ctx = await store();
    expect(await claudeChatAdapter.readHistory(ctx, RESUMED, HISTORY_BUDGET_BYTES)).toEqual({
      unavailable: true,
    });
    expect(await claudeChatAdapter.readHistory(ctx, '../escape', HISTORY_BUDGET_BYTES)).toEqual({
      unavailable: true,
    });
  });
});
