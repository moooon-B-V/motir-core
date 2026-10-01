import { readFileSync } from 'node:fs';
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
  OPENCODE_FIXTURE_VERSION,
  createOpencodeAdapter,
  createOpencodeMapper,
  opencodeChatAdapter,
  parseOpencodeExport,
  type OpencodeExec,
} from '../../src/agentTerminal/chat/adapters/opencode.js';
import type { TranscriptEvent } from '../../src/agentTerminal/chat/protocol.js';
import { createChatHub, type ChatHub } from '../../src/agentTerminal/chat/turns.js';
import { fakeChatSpawner, type Frame } from './harness.js';

// The OpenCode chat adapter (MOTIR-7016 · `docs/decisions/agent-chat.md` Q1's
// `opencode` row, Q3, Q5, Q7, Q11), against the streams in
// `fixtures/chat/opencode/` — reconstructed from the ADR's real capture of
// opencode 1.18.33 and OpenCode's documented JSON output (see that README). No
// binary runs and no model is called: each fixture is replayed through the
// runner's fake process, and the session list and export through a fake exec.

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'chat', 'opencode');
const SESSION = 'ses_f0e15f2f2ffeRhqhbBfRDMXLUT';
const CTX: ChatContext = {
  home: '/home/agent',
  cwd: '/home/agent/workspace',
  env: { HOME: '/home/agent', PATH: '/usr/local/bin:/usr/bin', MOTIR_SANDBOX_AGENT: 'opencode' },
};

/** A fixture's header line, and its stream lines with the header stripped. */
function fixture(name: string): { header: string; lines: string[] } {
  const all = readFileSync(join(FIXTURES, name), 'utf8').split('\n');
  const header = all.find((line) => line.startsWith('#')) ?? '';
  return { header, lines: all.filter((line) => line.length > 0 && !line.startsWith('#')) };
}

function readText(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
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
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const hubs: ChatHub[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
});

/** The real runner, the OpenCode adapter, a fake process and a fake exec. */
function rig(exec: OpencodeExec = async () => null) {
  const adapter = createOpencodeAdapter(exec);
  const { spawn, procs } = fakeChatSpawner();
  const logs: string[] = [];
  const hub = createChatHub({
    profile: 'opencode',
    adapter,
    ctx: CTX,
    spawn,
    readSignIn: async () => ({ profile: 'opencode', state: 'signed_in' }),
    log: (line) => logs.push(line),
  });
  hubs.push(hub);
  const socket = new FakeSocket();
  const handle = hub.accept(socket);
  const send = (frame: Frame): void => handle.message(Buffer.from(JSON.stringify(frame)), false);
  return { hub, procs, logs, socket, send };
}

/** Open a chat (or resume `session`), prompt, and replay a fixture through the fake process. */
async function replay(
  name: string,
  options: { session?: string; exitCode?: number | null; stop?: boolean } = {},
) {
  const r = rig(async (args) => (args[0] === 'export' ? readText('export.json') : null));
  r.send(options.session ? { t: 'open', session: options.session } : { t: 'open' });
  await settle();
  r.send({ t: 'prompt', text: 'the prompt' });
  await settle();
  const proc = r.procs[0]!;
  for (const line of fixture(name).lines) proc.line(line);
  if (options.stop) {
    r.send({ t: 'stop' });
    await settle();
    expect(proc.signals).toEqual(['SIGINT']);
  }
  proc.exit(options.exitCode === undefined ? 0 : options.exitCode);
  await settle();
  return { ...r, proc };
}

describe('the OpenCode adapter is registered', () => {
  it('serves MOTIR_SANDBOX_AGENT=opencode and answers supported: true', async () => {
    expect(CHAT_ADAPTERS).toContain(opencodeChatAdapter);
    const adapter = resolveChatAdapter('opencode');
    expect(adapter).toBe(opencodeChatAdapter);
    expect(await adapter!.support(CTX)).toEqual({ supported: true });
  });

  it('says so in the hello frame', async () => {
    const r = rig();
    await settle();
    expect(r.socket.of('hello')).toEqual([
      { t: 'hello', profile: 'opencode', supported: true, signin: 'signed_in' },
    ]);
  });

  it('each fixture names the pinned version in its header', () => {
    for (const name of [
      'plain-reply.jsonl',
      'read-edit-command.jsonl',
      'stopped.jsonl',
      'failed-tool.jsonl',
      'continued-session.jsonl',
    ]) {
      expect(fixture(name).header).toContain(`opencode ${OPENCODE_FIXTURE_VERSION}`);
    }
  });
});

describe('the turn command (Q3, Q11)', () => {
  it('is exactly the ADR flags, the prompt on argv after --, stdin closed, no env added', () => {
    const command = opencodeChatAdapter.turnCommand({
      prompt: 'Say hello',
      sessionId: null,
      ctx: CTX,
    });
    expect(command).toEqual({
      file: 'opencode',
      args: ['run', '--format', 'json', '--auto', '--', 'Say hello'],
      stdin: null,
    });
    expect(command.env).toBeUndefined();
  });

  it('continues a session through --session <id>', () => {
    expect(
      opencodeChatAdapter.turnCommand({ prompt: 'again', sessionId: SESSION, ctx: CTX }).args,
    ).toEqual(['run', '--format', 'json', '--auto', '--session', SESSION, '--', 'again']);
  });

  it('never lets a prompt that starts with a dash become an option', () => {
    const { args } = opencodeChatAdapter.turnCommand({
      prompt: '--session evil',
      sessionId: null,
      ctx: CTX,
    });
    expect(args.slice(-2)).toEqual(['--', '--session evil']);
  });

  it('spawns the bare binary in the workspace with the server env and nothing added', async () => {
    const r = await replay('plain-reply.jsonl');
    expect(r.proc.options).toEqual({
      file: 'opencode',
      args: ['run', '--format', 'json', '--auto', '--', 'the prompt'],
      cwd: CTX.cwd,
      env: CTX.env,
      stdin: null,
    });
  });
});

describe('each recorded stream → the transcript (Q5)', () => {
  it('a plain reply: the text, the session revealed, completed', async () => {
    const r = await replay('plain-reply.jsonl');
    expect(r.socket.of('session')).toEqual([{ t: 'session', id: SESSION }]);
    expect(r.socket.events()).toEqual([
      { k: 'user', text: 'the prompt' },
      { k: 'text', id: 'prt_0f1ea0d1a002x2', delta: 'Hello! How can I help you today?' },
      { k: 'turn_end', reason: 'completed' },
    ]);
  });

  it('a read, an edit with its diff, a command with its output, then the reply', async () => {
    const r = await replay('read-edit-command.jsonl');
    expect(r.socket.events()).toEqual([
      { k: 'user', text: 'the prompt' },
      {
        k: 'tool_call',
        id: 'call_7c83a1b2c3d4e5f6a7b8c9d0',
        kind: 'read',
        name: 'read',
        title: 'hello.txt',
        path: '/home/agent/workspace/hello.txt',
      },
      {
        k: 'tool_result',
        id: 'call_7c83a1b2c3d4e5f6a7b8c9d0',
        ok: true,
        output: '<file>\n00001| helo world\n\n(End of file - total 1 lines)\n</file>',
        truncated: false,
      },
      {
        k: 'tool_call',
        id: 'call_8d94b2c3d4e5f6a7b8c9d0e1',
        kind: 'edit',
        name: 'edit',
        title: 'hello.txt',
        path: '/home/agent/workspace/hello.txt',
        diff:
          'Index: /home/agent/workspace/hello.txt\n' +
          '===================================================================\n' +
          '--- /home/agent/workspace/hello.txt\n' +
          '+++ /home/agent/workspace/hello.txt\n' +
          '@@ -1,1 +1,1 @@\n' +
          '-helo world\n' +
          '+hello world\n',
      },
      {
        k: 'tool_result',
        id: 'call_8d94b2c3d4e5f6a7b8c9d0e1',
        ok: true,
        output: 'Edit applied successfully.',
        truncated: false,
      },
      {
        k: 'tool_call',
        id: 'call_9ea5c3d4e5f6a7b8c9d0e1f2',
        kind: 'command',
        name: 'bash',
        title: 'ls',
        command: 'ls',
      },
      {
        k: 'tool_result',
        id: 'call_9ea5c3d4e5f6a7b8c9d0e1f2',
        ok: true,
        output: 'a.txt\nb.md\nhello.txt\nopencode.json\n',
        exitCode: 0,
        truncated: false,
      },
      {
        k: 'text',
        id: 'prt_0f1eb100000bab',
        delta:
          'I fixed the typo in hello.txt. The directory contains a.txt, b.md, hello.txt and opencode.json.',
      },
      { k: 'turn_end', reason: 'completed' },
    ]);
  });

  it('a stopped turn: SIGINT, exit 130 with no final event, ends stopped', async () => {
    const r = await replay('stopped.jsonl', { stop: true, exitCode: 130 });
    expect(r.socket.events()).toEqual([
      { k: 'user', text: 'the prompt' },
      { k: 'text', id: 'prt_0f1ec2000002c2', delta: "I'll run the test suite now." },
      { k: 'turn_end', reason: 'stopped' },
    ]);
  });

  it('a failed tool call: ok false with its error, and the turn still completes', async () => {
    const r = await replay('failed-tool.jsonl');
    expect(r.socket.events()).toEqual([
      { k: 'user', text: 'the prompt' },
      {
        k: 'tool_call',
        id: 'call_af06d4e5f6a7b8c9d0e1f2a3',
        kind: 'read',
        name: 'read',
        title: '/home/agent/workspace/missing.txt',
        path: '/home/agent/workspace/missing.txt',
      },
      {
        k: 'tool_result',
        id: 'call_af06d4e5f6a7b8c9d0e1f2a3',
        ok: false,
        output: 'Error: File not found: /home/agent/workspace/missing.txt',
        truncated: false,
      },
      {
        k: 'text',
        id: 'prt_0f1ed3000005d5',
        delta: 'missing.txt does not exist in the workspace.',
      },
      { k: 'turn_end', reason: 'completed' },
    ]);
  });

  it('a continued session: resumed with --session, the history drawn, the same id', async () => {
    const r = await replay('continued-session.jsonl', { session: SESSION });
    expect(r.proc.options.args).toEqual([
      'run',
      '--format',
      'json',
      '--auto',
      '--session',
      SESSION,
      '--',
      'the prompt',
    ]);
    expect(r.socket.of('ready')).toEqual([{ t: 'ready', session: SESSION, resumed: true }]);
    expect(r.socket.of('history')[0]!['truncated']).toBe(false);
    // Already known, so no second `session` frame.
    expect(r.socket.of('session')).toEqual([]);
    expect(r.socket.events()).toEqual([
      { k: 'user', text: 'the prompt' },
      {
        k: 'text',
        id: 'prt_0f1ee4000002e2',
        delta: 'I changed "helo world" to "hello world" in hello.txt.',
      },
      { k: 'turn_end', reason: 'completed' },
    ]);
  });

  it('a stream that exits 0 without step_finish reason "stop" fails no_end', async () => {
    const r = await replay('stopped.jsonl');
    expect(r.socket.events().at(-1)).toEqual({ k: 'turn_end', reason: 'failed', code: 'no_end' });
  });

  it('drops every token and cost field: none reaches a frame', async () => {
    const r = await replay('read-edit-command.jsonl');
    const wire = JSON.stringify(r.socket.frames);
    for (const field of ['tokens', 'cost', 'snapshot', 'reasoning']) {
      expect(wire).not.toContain(field);
    }
  });
});

describe('what the mapper does with the unexpected', () => {
  it('an unrecognised typed event becomes other, does not end the turn, and is never logged', async () => {
    const r = rig();
    r.send({ t: 'open' });
    await settle();
    r.send({ t: 'prompt', text: 'the prompt' });
    await settle();
    const proc = r.procs[0]!;
    const { lines } = fixture('plain-reply.jsonl');
    proc.line(lines[0]!);
    proc.line({ type: 'future_event', sessionID: SESSION, secret: 'top-secret-content' });
    await settle();
    expect(r.hub.runningTurn()).not.toBeNull();
    for (const line of lines.slice(1)) proc.line(line);
    proc.exit(0);
    await settle();
    expect(r.socket.events()).toEqual([
      { k: 'user', text: 'the prompt' },
      { k: 'other', name: 'future_event' },
      { k: 'text', id: 'prt_0f1ea0d1a002x2', delta: 'Hello! How can I help you today?' },
      { k: 'turn_end', reason: 'completed' },
    ]);
    const logged = r.logs.join('\n');
    for (const word of ['future_event', 'top-secret-content', 'Hello', 'the prompt', SESSION]) {
      expect(logged).not.toContain(word);
    }
  });

  it('drops a line that is not JSON, not an object, or has no type — and never throws', () => {
    const mapper = createOpencodeMapper();
    for (const line of ['not json', '[1,2]', 'null', '42', '"text"', '{"part":{}}', '{"type":7}']) {
      expect(mapper.onLine(line)).toEqual([]);
    }
    expect(mapper.sessionId()).toBeNull();
    expect(mapper.sawEnd()).toBe(false);
    expect(mapper.killCode()).toBeNull();
  });

  it('survives a tool_use with no state, and an error event, as an inline notice', () => {
    const mapper = createOpencodeMapper();
    expect(mapper.onLine('{"type":"tool_use","part":{"tool":"webfetch","callID":"c1"}}')).toEqual([
      { k: 'tool_call', id: 'c1', kind: 'other', name: 'webfetch', title: 'webfetch' },
    ]);
    expect(
      mapper.onLine(
        '{"type":"error","error":{"name":"ProviderAuthError","data":{"message":"no key"}}}',
      ),
    ).toEqual([{ k: 'error', code: 'ProviderAuthError', message: 'no key' }]);
  });

  it('draws a command that exited non-zero as failed, with its exit code', () => {
    const mapper = createOpencodeMapper();
    const events = mapper.onLine(
      JSON.stringify({
        type: 'tool_use',
        part: {
          tool: 'bash',
          callID: 'c2',
          state: {
            status: 'completed',
            input: { command: 'false' },
            output: '',
            title: 'false',
            metadata: { exit: 1 },
          },
        },
      }),
    );
    expect(events[1]).toEqual({
      k: 'tool_result',
      id: 'c2',
      ok: false,
      output: '',
      exitCode: 1,
      truncated: false,
    });
  });

  it('never reveals a session id that could be an option or a path', () => {
    const mapper = createOpencodeMapper();
    mapper.onLine('{"type":"step_start","sessionID":"--evil"}');
    expect(mapper.sessionId()).toBeNull();
    mapper.onLine(`{"type":"step_start","sessionID":"${SESSION}"}`);
    expect(mapper.sessionId()).toBe(SESSION);
  });
});

describe('the session list (Q7)', () => {
  it('reads `opencode session list --format json`: this directory, newest first, bounded', async () => {
    const calls: { args: string[]; ctx: ChatContext }[] = [];
    const adapter = createOpencodeAdapter(async (args, ctx) => {
      calls.push({ args, ctx });
      return readText('session-list.json');
    });
    const sessions = await adapter.listSessions(CTX, MAX_LISTED_SESSIONS);
    expect(calls).toEqual([{ args: ['session', 'list', '--format', 'json'], ctx: CTX }]);
    expect(sessions).toEqual([
      {
        id: SESSION,
        title: 'Fix greeting typo in hello.txt',
        updatedAt: new Date(1790762800850).toISOString(),
      },
      {
        id: 'ses_0f1b1c2d3ffeMnOpQrStUvWxYz',
        title: 'New session - 2026-09-29T08:00:00.000Z',
        updatedAt: new Date(1790719200000).toISOString(),
      },
      {
        id: 'ses_0f1a0b2c3ffeAbCdEfGhIjKlMn',
        title: 'Set up the project README',
        updatedAt: new Date(1790676000000).toISOString(),
      },
    ]);
    expect((await adapter.listSessions(CTX, 2)).map((s) => s.id)).toEqual([
      SESSION,
      'ses_0f1b1c2d3ffeMnOpQrStUvWxYz',
    ]);
  });

  it('lists nothing when the helper fails or prints something unreadable', async () => {
    expect(await createOpencodeAdapter(async () => null).listSessions(CTX, 50)).toEqual([]);
    expect(await createOpencodeAdapter(async () => 'garbage').listSessions(CTX, 50)).toEqual([]);
    expect(await createOpencodeAdapter(async () => '').listSessions(CTX, 50)).toEqual([]);
  });

  it('answers the list frame through the runner', async () => {
    const r = rig(async () => readText('session-list.json'));
    r.send({ t: 'list' });
    await settle();
    const items = r.socket.of('sessions')[0]!['items'] as { id: string }[];
    expect(items.map((item) => item.id)[0]).toBe(SESSION);
  });
});

describe("a resume's history (Q7)", () => {
  it('reads `opencode export <id>`: each turn, its tools, and how it ended', async () => {
    const calls: string[][] = [];
    const adapter = createOpencodeAdapter(async (args) => {
      calls.push(args);
      return readText('export.json');
    });
    const history = await adapter.readHistory(CTX, SESSION, HISTORY_BUDGET_BYTES);
    expect(calls).toEqual([['export', SESSION]]);
    expect(history).toEqual({
      truncated: false,
      events: [
        { k: 'user', text: 'Fix the greeting in hello.txt and list the directory' },
        {
          k: 'tool_call',
          id: 'call_7c83a1b2c3d4e5f6a7b8c9d0',
          kind: 'read',
          name: 'read',
          title: 'hello.txt',
          path: '/home/agent/workspace/hello.txt',
        },
        {
          k: 'tool_result',
          id: 'call_7c83a1b2c3d4e5f6a7b8c9d0',
          ok: true,
          output: '<file>\n00001| helo world\n\n(End of file - total 1 lines)\n</file>',
          truncated: false,
        },
        { k: 'text', id: 'prt_0f1eb100000bab', delta: 'I fixed the typo in hello.txt.' },
        { k: 'turn_end', reason: 'completed' },
        { k: 'user', text: 'Run the test suite' },
        { k: 'text', id: 'prt_0f1ec2000002c2', delta: "I'll run the test suite now." },
        { k: 'turn_end', reason: 'stopped' },
      ],
    });
  });

  it('keeps the newest turns within the budget', () => {
    const cut = parseOpencodeExport(readText('export.json'), 300);
    expect(cut?.truncated).toBe(true);
    expect(cut?.events[0]).toEqual({ k: 'user', text: 'Run the test suite' });
  });

  it('answers unavailable when the export fails or is unreadable', async () => {
    expect(await createOpencodeAdapter(async () => null).readHistory(CTX, SESSION, 1024)).toEqual({
      unavailable: true,
    });
    expect(await createOpencodeAdapter(async () => '{}').readHistory(CTX, SESSION, 1024)).toEqual({
      unavailable: true,
    });
    expect(
      await createOpencodeAdapter(async () => {
        throw new Error('must not be reached');
      }).readHistory(CTX, '--evil', 1024),
    ).toEqual({ unavailable: true });
  });
});
