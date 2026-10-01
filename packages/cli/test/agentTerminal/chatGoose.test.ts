import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAT_ADAPTERS,
  CHAT_ENV_ADDITIONS,
  MAX_LISTED_SESSIONS,
  MAX_TITLE_CHARS,
  resolveChatAdapter,
  type ChatContext,
} from '../../src/agentTerminal/chat/adapter.js';
import {
  GOOSE_TITLE_CHARS,
  createGooseAdapter,
  createGooseMapper,
  gooseChatAdapter,
  gooseTime,
  parseGooseSessionList,
  unifiedDiff,
} from '../../src/agentTerminal/chat/adapters/goose.js';
import { MAX_TOOL_OUTPUT_BYTES } from '../../src/agentTerminal/chat/protocol.js';
import { createChatHub, type ChatHub } from '../../src/agentTerminal/chat/turns.js';
import { fakeChatSpawner, startHarness, type Client, type Frame, type Harness } from './harness.js';

// The goose chat adapter (MOTIR-7035 · `docs/decisions/agent-chat.md` Q1, Q3,
// Q5, Q6, Q7, Q10, Q11). Each fixture under `fixtures/chat/goose/` is replayed
// through the REAL runner (`createChatHub`) with a FAKE spawn, so what is
// asserted is what the tab would receive — `turn_end` included, which only the
// runner writes. The fixtures' provenance is in that directory's README.

const FIXTURES = join(import.meta.dirname, 'fixtures', 'chat', 'goose');
const CTX: ChatContext = {
  home: '/home/node',
  cwd: '/home/node/workspace',
  env: { HOME: '/home/node', PATH: '/usr/bin' },
};

function fixtureLines(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

class FakeSocket {
  isOpen = true;
  readonly frames: Frame[] = [];
  send(text: string): void {
    this.frames.push(JSON.parse(text) as Frame);
  }
  events(): Frame[] {
    return this.frames.filter((f) => f['t'] === 'event').map((f) => f['e'] as Frame);
  }
}

const hubs: ChatHub[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

interface Replay {
  events: Frame[];
  frames: Frame[];
  logs: string[];
  spawned: ReturnType<typeof fakeChatSpawner>['procs'];
}

/**
 * One turn: open (a new chat, or `session`), prompt, replay the fixture's lines
 * as the process's stdout, optionally Stop first, then exit with `code`.
 */
async function replay(
  fixture: string,
  options: { code?: number; stopAfter?: number; session?: string } = {},
): Promise<Replay> {
  const { spawn, procs } = fakeChatSpawner();
  const logs: string[] = [];
  const hub = createChatHub({
    profile: 'goose',
    adapter: gooseChatAdapter,
    ctx: CTX,
    spawn,
    readSignIn: async () => ({ profile: 'goose', state: 'unknown' }),
    log: (line) => logs.push(line),
  });
  hubs.push(hub);
  const socket = new FakeSocket();
  const handle = hub.accept(socket);
  const send = (frame: Frame): void => handle.message(Buffer.from(JSON.stringify(frame)), false);
  send(options.session ? { t: 'open', session: options.session } : { t: 'open' });
  send({ t: 'prompt', text: 'the prompt' });
  await settle();
  const proc = procs[0]!;
  const lines = fixtureLines(fixture);
  lines.forEach((line, index) => {
    proc.line(line);
    if (options.stopAfter === index) send({ t: 'stop' });
  });
  await settle();
  proc.exit(options.code ?? 0);
  await settle();
  return { events: socket.events(), frames: socket.frames, logs, spawned: procs };
}

describe('the registry and support (Q1)', () => {
  it('registers goose, and a goose machine answers supported: true', async () => {
    expect(CHAT_ADAPTERS).toContain(gooseChatAdapter);
    expect(resolveChatAdapter('goose')).toBe(gooseChatAdapter);
    expect(await gooseChatAdapter.support(CTX)).toEqual({ supported: true });
  });

  it('answers the hello with supported: true behind the real server, with MOTIR_SANDBOX_AGENT=goose', async () => {
    let harness: Harness | null = null;
    let client: Client | null = null;
    try {
      harness = await startHarness({
        env: { HOME: '/nonexistent-home', MOTIR_SANDBOX_AGENT: 'goose' },
      });
      client = await harness.connectChat();
      // goose's sign-in is not a file to stat, so the terminal's check says unknown.
      expect(await client.frame('hello')).toEqual({
        t: 'hello',
        profile: 'goose',
        supported: true,
        signin: 'unknown',
      });
    } finally {
      client?.close();
      await harness?.terminal.close();
    }
  });

  it('restates the title bound adapter.ts owns', () => {
    expect(GOOSE_TITLE_CHARS).toBe(MAX_TITLE_CHARS);
  });
});

describe('the turn command (Q3, Q11)', () => {
  it('is exactly Q3’s argv, the prompt on stdin, and GOOSE_MODE=auto the only env addition', () => {
    const command = gooseChatAdapter.turnCommand({ prompt: 'list', sessionId: null, ctx: CTX });
    expect(command).toEqual({
      file: 'goose',
      args: ['run', '-q', '--output-format', 'stream-json', '-i', '-'],
      stdin: 'list',
      env: { GOOSE_MODE: 'auto' },
    });
    for (const name of Object.keys(command.env ?? {})) {
      expect(CHAT_ENV_ADDITIONS.has(name)).toBe(true);
    }
  });

  it('adds --resume --session-id <id> on a resume, and nothing else', () => {
    const command = gooseChatAdapter.turnCommand({
      prompt: 'again',
      sessionId: '20260930_3',
      ctx: CTX,
    });
    expect(command.args).toEqual([
      'run',
      '-q',
      '--output-format',
      'stream-json',
      '-i',
      '-',
      '--resume',
      '--session-id',
      '20260930_3',
    ]);
    expect(command.env).toEqual({ GOOSE_MODE: 'auto' });
    expect(command.stdin).toBe('again');
  });

  it('is what the runner spawns: the server env plus GOOSE_MODE, in $HOME/workspace', async () => {
    const { spawned } = await replay('plain-reply.jsonl');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.options).toEqual({
      file: 'goose',
      args: ['run', '-q', '--output-format', 'stream-json', '-i', '-'],
      cwd: '/home/node/workspace',
      env: { HOME: '/home/node', PATH: '/usr/bin', GOOSE_MODE: 'auto' },
      stdin: 'the prompt',
    });
  });
});

describe('the recorded streams → transcript events (Q5, Q6)', () => {
  it('a plain reply: chunks of one message are deltas of one id, then completed', async () => {
    const { events } = await replay('plain-reply.jsonl');
    expect(events).toEqual([
      { k: 'user', text: 'the prompt' },
      { k: 'text', id: 'chatcmpl-a2c9f0', delta: 'Hello! ' },
      { k: 'text', id: 'chatcmpl-a2c9f0', delta: 'How can I help ' },
      { k: 'text', id: 'chatcmpl-a2c9f0', delta: 'today?' },
      { k: 'turn_end', reason: 'completed' },
    ]);
  });

  it('a shell call yields a command with its output; a text_editor edit yields an edit with its diff', async () => {
    const { events } = await replay('shell-and-edit.jsonl');
    expect(events).toEqual([
      { k: 'user', text: 'the prompt' },
      {
        k: 'tool_call',
        id: 'call_63cb01',
        kind: 'command',
        name: 'shell',
        title: 'ls',
        command: 'ls',
      },
      {
        k: 'tool_result',
        id: 'call_63cb01',
        ok: true,
        output: 'a.txt\nb.md',
        exitCode: 0,
        truncated: false,
      },
      {
        k: 'tool_call',
        id: 'call_63cb02',
        kind: 'edit',
        name: 'text_editor',
        title: '/home/node/workspace/a.txt',
        path: '/home/node/workspace/a.txt',
        diff: [
          '--- /home/node/workspace/a.txt',
          '+++ /home/node/workspace/a.txt',
          '@@ -1,1 +1,1 @@',
          '-hello',
          '+hello, goose',
          '',
        ].join('\n'),
      },
      {
        k: 'tool_result',
        id: 'call_63cb02',
        ok: true,
        output: 'The file /home/node/workspace/a.txt has been edited.',
        truncated: false,
      },
      { k: 'text', id: 'chatcmpl-5d10ac', delta: 'The directory ' },
      { k: 'text', id: 'chatcmpl-5d10ac', delta: 'listed above.' },
      { k: 'turn_end', reason: 'completed' },
    ]);
  });

  it('a stopped turn ends stopped, and goose’s interrupt line is consumed rather than shown twice', async () => {
    // Stop after the second chunk; goose answers SIGINT with its line, then exit 1.
    const { events, spawned } = await replay('stopped.jsonl', { stopAfter: 2, code: 1 });
    expect(spawned[0]!.signals).toEqual(['SIGINT']);
    expect(events).toEqual([
      { k: 'user', text: 'the prompt' },
      { k: 'text', id: 'chatcmpl-7e44b0', delta: 'Let me think about ' },
      { k: 'text', id: 'chatcmpl-7e44b0', delta: 'that for a ' },
      { k: 'turn_end', reason: 'stopped' },
    ]);
    expect(events.filter((event) => event['k'] === 'error')).toEqual([]);
  });

  it('a failed tool call yields a failed result: a non-zero command and a tool error', async () => {
    const { events } = await replay('failed-tool.jsonl');
    expect(events).toEqual([
      { k: 'user', text: 'the prompt' },
      {
        k: 'tool_call',
        id: 'call_91aa01',
        kind: 'command',
        name: 'shell',
        title: 'cat missing.txt',
        command: 'cat missing.txt',
      },
      {
        k: 'tool_result',
        id: 'call_91aa01',
        ok: false,
        output: 'cat: missing.txt: No such file or directory',
        exitCode: 1,
        truncated: false,
      },
      {
        k: 'tool_call',
        id: 'call_91aa02',
        kind: 'read',
        name: 'text_editor',
        title: '/home/node/workspace/missing.txt',
        path: '/home/node/workspace/missing.txt',
      },
      {
        k: 'tool_result',
        id: 'call_91aa02',
        ok: false,
        output: "The path '/home/node/workspace/missing.txt' does not exist or is not accessible.",
        truncated: false,
      },
      { k: 'text', id: 'chatcmpl-90f1c2', delta: 'missing.txt does not exist.' },
      { k: 'turn_end', reason: 'completed' },
    ]);
  });

  it('a resumed session: spawned with --resume --session-id, history unavailable, the turn completes', async () => {
    const { events, frames, spawned } = await replay('resumed.jsonl', { session: '20260930_3' });
    expect(spawned[0]!.options.args.slice(-3)).toEqual(['--resume', '--session-id', '20260930_3']);
    expect(frames.find((frame) => frame['t'] === 'ready')).toEqual({
      t: 'ready',
      session: '20260930_3',
      resumed: true,
    });
    // Q7: goose's store is not read, so the tab draws no earlier turns and says there were some.
    expect(frames.find((frame) => frame['t'] === 'history')).toEqual({
      t: 'history',
      events: [],
      truncated: true,
    });
    expect(events).toEqual([
      { k: 'user', text: 'the prompt' },
      { k: 'text', id: 'chatcmpl-c3d8e0', delta: 'As I said above, ' },
      { k: 'text', id: 'chatcmpl-c3d8e0', delta: 'the directory holds a.txt and b.md.' },
      { k: 'turn_end', reason: 'completed' },
    ]);
  });

  it('a turn that exits 0 without `complete` fails no_end; a crash fails exit_nonzero', async () => {
    const lines = fixtureLines('plain-reply.jsonl').filter((line) => !line.includes('"complete"'));
    const mapper = createGooseMapper();
    for (const line of lines) mapper.onLine(line);
    expect(mapper.sawEnd()).toBe(false);
    const crashed = await replay('stopped.jsonl', { code: 1 });
    expect(crashed.events.at(-1)).toEqual({
      k: 'turn_end',
      reason: 'failed',
      code: 'exit_nonzero',
    });
  });
});

describe('unrecognised and dropped lines (Q5, Q10)', () => {
  it('an unrecognised line never ends the turn: typed JSON is `other`, anything else is dropped', () => {
    const mapper = createGooseMapper();
    expect(mapper.onLine('not json at all {')).toEqual([]);
    expect(mapper.onLine('[1,2,3]')).toEqual([]);
    expect(mapper.onLine('{"no_type":true}')).toEqual([]);
    expect(mapper.onLine('{"type":"brand_new_event","secret":"x"}')).toEqual([
      { k: 'other', name: 'brand_new_event' },
    ]);
    expect(
      mapper.onLine(
        '{"type":"message","message":{"role":"assistant","content":[{"type":"image","data":"…"}]}}',
      ),
    ).toEqual([{ k: 'other', name: 'image' }]);
    expect(mapper.sawEnd()).toBe(false);
    expect(mapper.killCode()).toBeNull();
  });

  it('drops reasoning, notifications, model changes, user echoes and the complete counts', () => {
    const mapper = createGooseMapper();
    const dropped = [
      '{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm","signature":"s"}]}}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"redactedThinking","data":"x"}]}}',
      '{"type":"notification","extension_id":"developer","log":{"message":"running"}}',
      '{"type":"model_change","model":"m","mode":"auto"}',
      '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"the prompt"}]}}',
      '{"type":"complete","total_tokens":1234}',
    ];
    for (const line of dropped) expect(mapper.onLine(line)).toEqual([]);
    expect(mapper.sawEnd()).toBe(true);
  });

  it('shows any other goose error as an inline error that does not end the turn', () => {
    const mapper = createGooseMapper();
    expect(mapper.onLine('{"type":"error","error":"rate limited, retrying"}')).toEqual([
      { k: 'error', code: 'goose_error', message: 'rate limited, retrying' },
    ]);
    expect(mapper.sawEnd()).toBe(false);
  });

  it('logs no line of a turn: not the prompt, not a reply, not a tool output or an unknown line', async () => {
    const { logs } = await replay('shell-and-edit.jsonl');
    const unknown = await replay('plain-reply.jsonl');
    const all = [...logs, ...unknown.logs].join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [
      'the prompt',
      'a.txt',
      'hello, goose',
      'The directory',
      'call_63cb01',
      'chatcmpl',
      '/home/node',
      'Hello!',
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  it('holds a huge tool output to its last 64 KiB, marked truncated', () => {
    const mapper = createGooseMapper();
    const big = 'x'.repeat(MAX_TOOL_OUTPUT_BYTES + 100);
    const line = JSON.stringify({
      type: 'message',
      message: {
        role: 'user',
        content: [
          {
            type: 'toolResponse',
            id: 'c1',
            toolResult: {
              status: 'success',
              value: { structuredContent: { stdout: big, exit_code: 0 }, isError: false },
            },
          },
        ],
      },
    });
    const [event] = mapper.onLine(line);
    expect(event).toMatchObject({ k: 'tool_result', ok: true, truncated: true });
    expect((event as { output: string }).output).toHaveLength(MAX_TOOL_OUTPUT_BYTES);
  });

  it('maps extension-prefixed tool names and a whole-file write', () => {
    const mapper = createGooseMapper();
    const line = JSON.stringify({
      type: 'message',
      message: {
        id: 'm1',
        role: 'assistant',
        content: [
          {
            type: 'toolRequest',
            id: 'w1',
            toolCall: {
              status: 'success',
              value: {
                name: 'developer__text_editor',
                arguments: { command: 'write', path: 'b.md', file_text: 'one\ntwo\n' },
              },
            },
          },
          {
            type: 'toolRequest',
            id: 'x1',
            toolCall: { status: 'error', error: 'could not parse the tool call' },
          },
        ],
      },
    });
    expect(mapper.onLine(line)).toEqual([
      {
        k: 'tool_call',
        id: 'w1',
        kind: 'edit',
        name: 'text_editor',
        title: 'b.md',
        path: 'b.md',
        diff: unifiedDiff('b.md', null, 'one\ntwo\n'),
      },
      { k: 'tool_call', id: 'x1', kind: 'other', name: 'tool', title: 'tool' },
    ]);
    expect(unifiedDiff('b.md', null, 'one\ntwo\n')).toBe(
      '--- /dev/null\n+++ b.md\n@@ -0,0 +1,2 @@\n+one\n+two\n',
    );
  });

  it('reveals a session id only when a line carries one; goose 1.52.0’s recorded stream does not', () => {
    const mapper = createGooseMapper();
    for (const line of fixtureLines('shell-and-edit.jsonl')) mapper.onLine(line);
    expect(mapper.sessionId()).toBeNull();
    mapper.onLine('{"type":"complete","session_id":"20260930_9"}');
    expect(mapper.sessionId()).toBe('20260930_9');
    mapper.onLine('{"type":"complete","session_id":"../etc"}');
    expect(mapper.sessionId()).toBe('20260930_9');
  });
});

describe('the session list (Q7)', () => {
  const listing = readFileSync(join(FIXTURES, 'session-list.json'), 'utf8');

  it('runs `goose session list --format json` and keeps $HOME/workspace only, newest first', async () => {
    const seen: ChatContext[] = [];
    const adapter = createGooseAdapter({
      listSessions: async (ctx) => {
        seen.push(ctx);
        return listing;
      },
    });
    const items = await adapter.listSessions(CTX, MAX_LISTED_SESSIONS);
    expect(seen).toEqual([CTX]);
    expect(items.map((item) => item.id)).toEqual(['20260930_3', '20260930_1', '20260929_7']);
    expect(items[0]!.updatedAt).toBe('2026-09-30T11:30:00.000Z');
    expect(Array.from(items[0]!.title)).toHaveLength(MAX_TITLE_CHARS);
    expect(items[1]!.title).toBe('list the files');
    // A session with no name is titled by its id.
    expect(items[2]!.title).toBe('20260929_7');
  });

  it('returns at most 50', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: `20260901_${i}`,
      name: `s${i}`,
      working_dir: '/home/node/workspace',
      updated_at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
    }));
    const items = parseGooseSessionList(JSON.stringify(rows), CTX.cwd, MAX_LISTED_SESSIONS);
    expect(items).toHaveLength(50);
    expect(items[0]!.id).toBe('20260901_59');
    expect(items[49]!.id).toBe('20260901_10');
  });

  it('reads the older listing shape and answers nothing for output it cannot parse', () => {
    const older = JSON.stringify([
      {
        id: '20250305_113223',
        path: '/home/node/.local/share/goose/sessions/20250305_113223.jsonl',
        modified: '2025-03-05 11:35:43 UTC',
        metadata: { working_dir: '/home/node/workspace', description: 'old one' },
      },
    ]);
    expect(parseGooseSessionList(older, CTX.cwd, 50)).toEqual([
      { id: '20250305_113223', title: 'old one', updatedAt: '2025-03-05T11:35:43.000Z' },
    ]);
    expect(parseGooseSessionList('No sessions found', CTX.cwd, 50)).toEqual([]);
    expect(parseGooseSessionList('{"sessions":[]}', CTX.cwd, 50)).toEqual([]);
  });

  it('parses goose’s times', () => {
    expect(gooseTime('2026-09-30 09:05:00')).toBe('2026-09-30T09:05:00.000Z');
    expect(gooseTime('2026-09-30T09:05:00Z')).toBe('2026-09-30T09:05:00.000Z');
    expect(gooseTime(1790762400)).toBe(new Date(1790762400 * 1000).toISOString());
    expect(gooseTime('soon')).toBeNull();
    expect(gooseTime(null)).toBeNull();
  });

  it('answers readHistory unavailable: goose’s store has no documented export', async () => {
    expect(await gooseChatAdapter.readHistory(CTX, '20260930_3', 1024)).toEqual({
      unavailable: true,
    });
  });
});
