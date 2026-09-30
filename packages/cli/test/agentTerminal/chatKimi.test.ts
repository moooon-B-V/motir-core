import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAT_ADAPTERS,
  MAX_LISTED_SESSIONS,
  MAX_TITLE_CHARS,
  resolveChatAdapter,
  type ChatContext,
} from '../../src/agentTerminal/chat/adapter.js';
import {
  createKimiMapper,
  kimiAdapter,
  parseSessionIndex,
} from '../../src/agentTerminal/chat/adapters/kimi.js';
import { MAX_TOOL_OUTPUT_BYTES } from '../../src/agentTerminal/chat/protocol.js';
import { createChatHub, type ChatHub } from '../../src/agentTerminal/chat/turns.js';
import { fakeChatSpawner, startHarness, type Frame, type Harness } from './harness.js';

// The kimi chat adapter (MOTIR-7034 · `docs/decisions/agent-chat.md` Q1's kimi
// row, Q3, Q5, Q6, Q7, Q10, Q11). Each fixture under `fixtures/chat/kimi/` is
// replayed through the REAL runner (`createChatHub`) behind a FAKE spawn, so the
// assertions are on the transcript frames the tab would receive. The fixtures
// are constructed from the ADR's recorded 2.1.1 capture (see their README).

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'chat', 'kimi');

interface Fixture {
  header: { fixture: string; cli: string; exit: number; stop?: boolean; session?: string };
  lines: string[];
}

function fixture(name: string): Fixture {
  const [head, ...lines] = readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
  return { header: JSON.parse(head as string) as Fixture['header'], lines };
}

const CTX: ChatContext = {
  home: '/home/node',
  cwd: '/home/node/workspace',
  env: { HOME: '/home/node', PATH: '/usr/bin:/bin' },
};

class FakeSocket {
  isOpen = true;
  readonly frames: Frame[] = [];
  send(text: string): void {
    this.frames.push(JSON.parse(text) as Frame);
  }
  events(): Record<string, unknown>[] {
    return this.frames.filter((f) => f['t'] === 'event').map((f) => f['e'] as Frame);
  }
}

const hubs: ChatHub[] = [];
const temps: string[] = [];
let harness: Harness | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Replay one fixture through the runner as one turn. */
async function replay(name: string, extraLines: string[] = []) {
  const fx = fixture(name);
  const { spawn, procs } = fakeChatSpawner();
  const logs: string[] = [];
  const hub = createChatHub({
    profile: 'kimi',
    adapter: kimiAdapter,
    ctx: CTX,
    spawn,
    readSignIn: async () => ({ profile: 'kimi', state: 'unknown' }),
    log: (line) => logs.push(line),
  });
  hubs.push(hub);
  const socket = new FakeSocket();
  const handle = hub.accept(socket);
  const send = (frame: Frame): void => handle.message(Buffer.from(JSON.stringify(frame)), false);
  send(fx.header.session ? { t: 'open', session: fx.header.session } : { t: 'open' });
  send({ t: 'prompt', text: 'the prompt' });
  await settle();
  const proc = procs[0]!;
  for (const line of [...extraLines, ...fx.lines]) proc.line(line);
  if (fx.header.stop) {
    send({ t: 'stop' });
    await settle();
  }
  proc.exit(fx.header.exit);
  await settle();
  return { fx, socket, proc, logs };
}

afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.close();
  await harness?.terminal.close();
  harness = null;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('registration and support', () => {
  it('cuts titles to the registry bound', () => {
    const [item] = parseSessionIndex(
      JSON.stringify({ session_id: 's', work_dir: CTX.cwd, title: 'y'.repeat(500), updated_at: 1 }),
      CTX.cwd,
      MAX_LISTED_SESSIONS,
    );
    expect(item!.title).toHaveLength(MAX_TITLE_CHARS);
  });

  it('is registered for kimi', () => {
    expect(CHAT_ADAPTERS).toContain(kimiAdapter);
    expect(resolveChatAdapter('kimi')).toBe(kimiAdapter);
  });

  it('with MOTIR_SANDBOX_AGENT=kimi, the real server answers supported: true', async () => {
    harness = await startHarness({
      env: { HOME: '/nonexistent-home', MOTIR_SANDBOX_AGENT: 'kimi' },
    });
    const client = await harness.connectChat();
    try {
      expect(await client.frame('hello')).toEqual({
        t: 'hello',
        profile: 'kimi',
        supported: true,
        signin: 'unknown',
      });
    } finally {
      client.close();
    }
  });
});

describe('the spawn (Q3, Q11)', () => {
  it('is exactly `kimi -p <prompt> --output-format stream-json`, no stdin, no env', () => {
    expect(kimiAdapter.turnCommand({ prompt: 'hi there', sessionId: null, ctx: CTX })).toEqual({
      file: 'kimi',
      args: ['-p', 'hi there', '--output-format', 'stream-json'],
      stdin: null,
    });
  });

  it('adds only `--session <id>` on a resume', () => {
    const command = kimiAdapter.turnCommand({
      prompt: 'go on',
      sessionId: 'session_abc',
      ctx: CTX,
    });
    expect(command.args).toEqual([
      '-p',
      'go on',
      '--output-format',
      'stream-json',
      '--session',
      'session_abc',
    ]);
    expect(command.env).toBeUndefined();
  });

  it('the runner spawns it with the server environment and nothing added', async () => {
    const { proc } = await replay('plain-reply');
    expect(proc.options.file).toBe('kimi');
    expect(proc.options.args).toEqual(['-p', 'the prompt', '--output-format', 'stream-json']);
    expect(proc.options.env).toEqual(CTX.env);
    expect(proc.options.cwd).toBe(CTX.cwd);
    expect(proc.options.stdin).toBeNull();
  });
});

describe('each fixture, replayed (Q5, Q6)', () => {
  it('headers name the CLI version', () => {
    for (const name of ['plain-reply', 'tools', 'stopped', 'failed-tool', 'resumed']) {
      expect(fixture(name).header.cli).toBe('kimi-code 2.1.1');
    }
  });

  it('a plain reply: the prompt, one whole text, completed; the session revealed at the end', async () => {
    const { socket } = await replay('plain-reply');
    expect(socket.events()).toEqual([
      { k: 'user', text: 'the prompt' },
      {
        k: 'text',
        id: 'kimi-msg-1',
        delta: 'Hello! How can I help you with this repository today?',
      },
      { k: 'turn_end', reason: 'completed' },
    ]);
    expect(socket.frames.filter((f) => f['t'] === 'session')).toEqual([
      { t: 'session', id: 'session_0d6f2a61-3b1e-4c1b-9a53-2f7de1c4a9b0' },
    ]);
  });

  it('a read, an edit with its diff and a shell command with its output, in order', async () => {
    const { socket } = await replay('tools');
    expect(socket.events()).toEqual([
      { k: 'user', text: 'the prompt' },
      { k: 'text', id: 'kimi-msg-1', delta: "I'll read the README first." },
      {
        k: 'tool_call',
        id: 'call_1a2b3c4d5e6f',
        kind: 'read',
        name: 'ReadFile',
        title: 'README.md',
        path: 'README.md',
      },
      {
        k: 'tool_result',
        id: 'call_1a2b3c4d5e6f',
        ok: true,
        output: '# demo\nHello wrold\n',
        truncated: false,
      },
      {
        k: 'tool_call',
        id: 'call_2b3c4d5e6f7a',
        kind: 'edit',
        name: 'StrReplaceFile',
        title: 'README.md',
        path: 'README.md',
        diff: '--- a/README.md\n+++ b/README.md\n@@ @@\n-Hello wrold\n+Hello world\n',
      },
      { k: 'tool_result', id: 'call_2b3c4d5e6f7a', ok: true, truncated: false },
      {
        k: 'tool_call',
        id: 'call_43b39d940437',
        kind: 'command',
        name: 'Bash',
        title: 'ls',
        command: 'ls',
      },
      {
        k: 'tool_result',
        id: 'call_43b39d940437',
        ok: true,
        output: 'a.txt\nb.md\n',
        truncated: false,
      },
      {
        k: 'text',
        id: 'kimi-msg-2',
        delta: 'I fixed the typo in README.md. The directory contains the files listed above.',
      },
      { k: 'turn_end', reason: 'completed' },
    ]);
  });

  it('a stopped turn keeps its partial reply and ends stopped (SIGINT, exit 130, no hint)', async () => {
    const { socket, proc } = await replay('stopped');
    expect(proc.signals).toEqual(['SIGINT']);
    expect(socket.events()).toEqual([
      { k: 'user', text: 'the prompt' },
      {
        k: 'text',
        id: 'kimi-msg-1',
        delta: 'Let me walk through the test suite. First, the unit tests',
      },
      { k: 'turn_end', reason: 'stopped' },
    ]);
    // No resume hint: no session frame for a new chat stopped before its end.
    expect(socket.frames.filter((f) => f['t'] === 'session')).toEqual([]);
  });

  it('a failed tool call yields a failed tool result with its exit code, and the turn continues', async () => {
    const { socket } = await replay('failed-tool');
    const events = socket.events();
    expect(events[1]).toEqual({
      k: 'tool_call',
      id: 'call_5e6f7a8b9c0d',
      kind: 'command',
      name: 'Bash',
      title: 'ls missing',
      command: 'ls missing',
    });
    expect(events[2]).toEqual({
      k: 'tool_result',
      id: 'call_5e6f7a8b9c0d',
      ok: false,
      output: "ls: cannot access 'missing': No such file or directory\n",
      exitCode: 2,
      truncated: false,
    });
    expect(events.at(-1)).toEqual({ k: 'turn_end', reason: 'completed' });
  });

  it('a resumed session passes --session, draws no earlier turns (unavailable), and completes', async () => {
    const { socket, proc, fx } = await replay('resumed');
    const session = fx.header.session as string;
    expect(proc.options.args).toEqual([
      '-p',
      'the prompt',
      '--output-format',
      'stream-json',
      '--session',
      session,
    ]);
    expect(socket.frames[1]).toEqual({ t: 'ready', session, resumed: true });
    expect(socket.frames[2]).toEqual({ t: 'history', events: [], truncated: true });
    expect(socket.events().at(-1)).toEqual({ k: 'turn_end', reason: 'completed' });
  });

  it('an unrecognised line does not end the turn and is never logged (Q5, Q10)', async () => {
    const secret = 'SECRET-CONTENT-7034';
    const { socket, logs } = await replay('plain-reply', [
      `not json ${secret}`,
      JSON.stringify({ type: 'progress.tick', note: secret }),
      JSON.stringify({ role: 'meta', type: 'status.update', note: secret }),
      JSON.stringify({ note: secret }),
    ]);
    const events = socket.events();
    expect(events).toEqual([
      { k: 'user', text: 'the prompt' },
      { k: 'other', name: 'progress.tick' },
      { k: 'other', name: 'status.update' },
      {
        k: 'text',
        id: 'kimi-msg-1',
        delta: 'Hello! How can I help you with this repository today?',
      },
      { k: 'turn_end', reason: 'completed' },
    ]);
    expect(logs.join('\n')).not.toContain(secret);
    expect(logs.join('\n')).not.toContain('the prompt');
  });
});

describe('the mapper, line by line', () => {
  it('drops thinking parts and keeps text parts of a list content', () => {
    const mapper = createKimiMapper();
    expect(
      mapper.onLine(
        JSON.stringify({
          role: 'assistant',
          content: [
            { type: 'think', think: 'private reasoning' },
            { type: 'text', text: 'Visible.' },
          ],
        }),
      ),
    ).toEqual([{ k: 'text', id: 'kimi-msg-1', delta: 'Visible.' }]);
    expect(mapper.sawEnd()).toBe(false);
    expect(mapper.killCode()).toBeNull();
  });

  it('draws a whole-file write as an all-added diff, and an unknown tool as other', () => {
    const mapper = createKimiMapper();
    const [write, other] = mapper.onLine(
      JSON.stringify({
        role: 'assistant',
        tool_calls: [
          {
            type: 'function',
            id: 'c1',
            function: { name: 'WriteFile', arguments: '{"path":"n.txt","content":"a\\nb\\n"}' },
          },
          { type: 'function', id: 'c2', function: { name: 'SearchWeb', arguments: '{bad' } },
        ],
      }),
    );
    expect(write).toMatchObject({
      kind: 'edit',
      path: 'n.txt',
      diff: '--- a/n.txt\n+++ b/n.txt\n@@ @@\n+a\n+b\n',
    });
    expect(other).toEqual({
      k: 'tool_call',
      id: 'c2',
      kind: 'other',
      name: 'SearchWeb',
      title: 'SearchWeb',
    });
  });

  it('bounds a tool output to its last 64 KiB', () => {
    const mapper = createKimiMapper();
    const [result] = mapper.onLine(
      JSON.stringify({
        role: 'tool',
        tool_call_id: 'c1',
        content: 'x'.repeat(MAX_TOOL_OUTPUT_BYTES + 10),
      }),
    );
    expect(result).toMatchObject({ k: 'tool_result', ok: true, truncated: true });
    expect((result as { output: string }).output).toHaveLength(MAX_TOOL_OUTPUT_BYTES);
  });
});

describe('the session list (Q7)', () => {
  const index = (): string => readFileSync(join(FIXTURES, 'session_index.jsonl'), 'utf8');

  it('returns only $HOME/workspace sessions, newest first, at most 50, titles cut to 120', () => {
    const items = parseSessionIndex(index(), CTX.cwd, MAX_LISTED_SESSIONS);
    expect(items).toHaveLength(50);
    expect(items.map((item) => item.id)).not.toContain(
      'session_aaaaaaaa-0000-4000-8000-000000000001',
    );
    expect(items.map((item) => item.id)).not.toContain(
      'session_aaaaaaaa-0000-4000-8000-000000000002',
    );
    // Newest: the long-titled one (epoch seconds), then session 0's re-appended row.
    expect(items[0]!.id).toBe('session_bbbbbbbb-0000-4000-8000-000000000001');
    expect(items[0]!.updatedAt).toBe('2026-09-30T11:00:00.000Z');
    expect(Array.from(items[0]!.title)).toHaveLength(120);
    expect(items[1]).toEqual({
      id: 'session_00000000-0000-4000-8000-000000000000',
      title: 'workspace session 0',
      updatedAt: '2026-09-30T10:00:00.000Z',
    });
    expect(items[2]!.title).toBe('workspace session 54');
    const times = items.map((item) => Date.parse(item.updatedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // One row per session even though session 0 appears twice.
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  it('reads the index from $KIMI_CODE_HOME/sessions, and lists nothing without one', async () => {
    const kimiHome = mkdtempSync(join(tmpdir(), 'motir-kimi-'));
    temps.push(kimiHome);
    const ctx: ChatContext = { ...CTX, env: { ...CTX.env, KIMI_CODE_HOME: kimiHome } };
    expect(await kimiAdapter.listSessions(ctx, MAX_LISTED_SESSIONS)).toEqual([]);
    mkdirSync(join(kimiHome, 'sessions'));
    writeFileSync(join(kimiHome, 'sessions', 'session_index.jsonl'), index());
    const items = await kimiAdapter.listSessions(ctx, 5);
    expect(items).toHaveLength(5);
    expect(items[0]!.id).toBe('session_bbbbbbbb-0000-4000-8000-000000000001');
  });

  it('defaults to ~/.kimi-code', async () => {
    const home = mkdtempSync(join(tmpdir(), 'motir-kimi-home-'));
    temps.push(home);
    const cwd = join(home, 'workspace');
    mkdirSync(join(home, '.kimi-code', 'sessions'), { recursive: true });
    writeFileSync(
      join(home, '.kimi-code', 'sessions', 'session_index.jsonl'),
      `${JSON.stringify({ session_id: 'session_x', work_dir: cwd, title: 'hi', updated_at: '2026-09-30T00:00:00Z' })}\n`,
    );
    const ctx: ChatContext = { home, cwd, env: { HOME: home } };
    expect(await kimiAdapter.listSessions(ctx, MAX_LISTED_SESSIONS)).toEqual([
      { id: 'session_x', title: 'hi', updatedAt: '2026-09-30T00:00:00.000Z' },
    ]);
  });

  it('answers history unavailable: the wire log shape is undocumented', async () => {
    expect(await kimiAdapter.readHistory(CTX, 'session_x', 1024)).toEqual({ unavailable: true });
  });
});
