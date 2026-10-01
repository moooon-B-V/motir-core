import { cp, mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CHAT_ADAPTERS,
  HISTORY_BUDGET_BYTES,
  MAX_LISTED_SESSIONS,
  resolveChatAdapter,
  type ChatContext,
} from '../../src/agentTerminal/chat/adapter.js';
import {
  CODEX_SANDBOX_OVERRIDE,
  codexChatAdapter,
  codexHome,
  createCodexMapper,
} from '../../src/agentTerminal/chat/adapters/codex.js';
import {
  MAX_TOOL_OUTPUT_BYTES,
  type TranscriptEvent,
} from '../../src/agentTerminal/chat/protocol.js';
import { createChatHub, type ChatHub } from '../../src/agentTerminal/chat/turns.js';
import { fakeChatSpawner, startHarness, type Frame, type Harness } from './harness.js';

// The Codex chat adapter (MOTIR-7015 · `docs/decisions/agent-chat.md` Q1's
// `codex` row, Q3, Q5, Q7, Q11). Each fixture under `fixtures/chat/codex/` is
// replayed through the REAL runner (`createChatHub`) behind a FAKE spawn, so
// what is asserted is what a socket would receive. The fixtures are
// reconstructed from the ADR's real capture and the vendor's documented schema;
// their README says how, and names the version.

const FIXTURES = join(import.meta.dirname, 'fixtures', 'chat', 'codex');
const HOME = '/home/agent';
const CWD = '/home/agent/workspace';

async function fixture(name: string): Promise<string[]> {
  const text = await readFile(join(FIXTURES, name), 'utf8');
  return text.split('\n').filter((line) => line.length > 0 && !line.startsWith('#'));
}

class Socket {
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

const hubs: ChatHub[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
});

/** A hub serving codex on a fake spawn, one socket attached. */
function rig(ctx: ChatContext = { home: HOME, cwd: CWD, env: { HOME, PATH: '/usr/bin' } }) {
  const { spawn, procs } = fakeChatSpawner();
  const logs: string[] = [];
  const hub = createChatHub({
    profile: 'codex',
    adapter: codexChatAdapter,
    ctx,
    spawn,
    readSignIn: async () => ({ profile: 'codex', state: 'signed_in' }),
    log: (line) => logs.push(line),
  });
  hubs.push(hub);
  const socket = new Socket();
  const handle = hub.accept(socket);
  const send = (frame: Frame): void => handle.message(Buffer.from(JSON.stringify(frame)), false);
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));
  return { hub, procs, logs, socket, send, settle };
}

/** Replay a fixture as one turn: open, prompt, every line, then the exit. */
async function replay(
  name: string,
  options: { exit?: number; stop?: boolean; session?: string } = {},
) {
  const r = rig();
  r.send(options.session ? { t: 'open', session: options.session } : { t: 'open' });
  r.send({ t: 'prompt', text: 'the prompt' });
  await r.settle();
  const proc = r.procs[0];
  if (!proc) throw new Error('no turn was spawned');
  for (const line of await fixture(name)) proc.line(line);
  if (options.stop) {
    r.send({ t: 'stop' });
    await r.settle();
  }
  proc.exit(options.exit ?? 0);
  await r.settle();
  return { ...r, proc };
}

describe('the registry and support (Q1, Q2)', () => {
  it('registers codex, and a codex machine answers supported: true on either sign-in', async () => {
    expect(CHAT_ADAPTERS).toContain(codexChatAdapter);
    expect(resolveChatAdapter('codex')).toBe(codexChatAdapter);
    expect(await codexChatAdapter.support({ home: HOME, cwd: CWD, env: {} })).toEqual({
      supported: true,
    });
  });

  let harness: Harness | null = null;
  afterAll(async () => {
    await harness?.terminal.close();
  });

  it('with MOTIR_SANDBOX_AGENT=codex, the server’s hello answers supported: true', async () => {
    harness = await startHarness({
      env: { HOME: '/nonexistent-home', MOTIR_SANDBOX_AGENT: 'codex' },
    });
    const client = await harness.connectChat();
    const hello = await client.frame('hello');
    expect(hello).toMatchObject({ t: 'hello', profile: 'codex', supported: true });
    expect(hello).not.toHaveProperty('reason');
    client.close();
  });
});

describe('the invocation (Q3, Q11)', () => {
  const ctx: ChatContext = { home: HOME, cwd: CWD, env: {} };

  it('a new chat: exactly `codex exec --json -c sandbox_mode="workspace-write" -`, the prompt on stdin', () => {
    expect(codexChatAdapter.turnCommand({ prompt: 'hi there', sessionId: null, ctx })).toEqual({
      file: 'codex',
      args: ['exec', '--json', '-c', 'sandbox_mode="workspace-write"', '-'],
      stdin: 'hi there',
    });
    expect(CODEX_SANDBOX_OVERRIDE).toBe('sandbox_mode="workspace-write"');
  });

  it('a resume: `codex exec resume` with the same flags and the session id', () => {
    const id = '01a0f1e6-e507-7c00-a172-76c9ce46e8f1';
    expect(codexChatAdapter.turnCommand({ prompt: 'again', sessionId: id, ctx })).toEqual({
      file: 'codex',
      args: ['exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', id, '-'],
      stdin: 'again',
    });
  });

  it('adds nothing to the environment: the spawn gets the server’s own, minus MOTIR_TERMINAL_KEY', async () => {
    const env = {
      HOME,
      PATH: '/usr/bin',
      CODEX_HOME: `${HOME}/.motir-sandbox/agent-config/.codex`,
    };
    const r = rig({ home: HOME, cwd: CWD, env: { ...env, MOTIR_TERMINAL_KEY: 'k' } });
    r.send({ t: 'open' });
    r.send({ t: 'prompt', text: 'secret prompt' });
    await r.settle();
    const options = r.procs[0]?.options;
    expect(options?.env).toEqual(env);
    expect(options?.file).toBe('codex');
    expect(options?.cwd).toBe(CWD);
    expect(options?.stdin).toBe('secret prompt');
    // The prompt never reaches argv (the process table) or a log line.
    expect(options?.args.join(' ')).not.toContain('secret prompt');
    expect(r.logs.join('\n')).not.toContain('secret prompt');
  });
});

describe('the recorded streams, replayed through the runner (Q5, Q6)', () => {
  it('a plain reply: the text, reasoning and usage dropped, the turn completed, the session revealed', async () => {
    const r = await replay('message.jsonl');
    expect(r.socket.events()).toEqual([
      { k: 'user', text: 'the prompt' },
      { k: 'text', id: 'item_1', delta: 'Hello! How can I help with this workspace?' },
      { k: 'turn_end', reason: 'completed' },
    ]);
    expect(r.socket.of('session')).toEqual([
      { t: 'session', id: '01a0f1e6-e507-7c00-a172-76c9ce46e8f1' },
    ]);
    expect(JSON.stringify(r.socket.frames)).not.toMatch(/tokens|usage|Answering a greeting/);
  });

  it('a command: a command tool_call, then its output and exit code, then the reply', async () => {
    const r = await replay('command.jsonl');
    expect(r.socket.events()).toEqual([
      { k: 'user', text: 'the prompt' },
      {
        k: 'tool_call',
        id: 'item_1',
        kind: 'command',
        name: 'command_execution',
        title: '/bin/bash -lc ls',
        command: '/bin/bash -lc ls',
      },
      {
        k: 'tool_result',
        id: 'item_1',
        ok: true,
        output: 'a.txt\nb.md\n',
        exitCode: 0,
        truncated: false,
      },
      { k: 'text', id: 'item_2', delta: 'The directory contains the files listed above.' },
      { k: 'turn_end', reason: 'completed' },
    ]);
  });

  it('a file change: an edit row per changed path (Codex names paths, not a diff)', async () => {
    const r = await replay('file-change.jsonl');
    expect(r.socket.events()).toEqual([
      { k: 'user', text: 'the prompt' },
      {
        k: 'tool_call',
        id: 'item_1',
        kind: 'edit',
        name: 'file_change',
        title: 'add /home/agent/workspace/notes.md',
        path: '/home/agent/workspace/notes.md',
      },
      { k: 'tool_result', id: 'item_1', ok: true, truncated: false },
      {
        k: 'tool_call',
        id: 'item_2:0',
        kind: 'edit',
        name: 'file_change',
        title: 'update /home/agent/workspace/a.txt',
        path: '/home/agent/workspace/a.txt',
      },
      { k: 'tool_result', id: 'item_2:0', ok: true, truncated: false },
      {
        k: 'tool_call',
        id: 'item_2:1',
        kind: 'edit',
        name: 'file_change',
        title: 'delete /home/agent/workspace/b.md',
        path: '/home/agent/workspace/b.md',
      },
      { k: 'tool_result', id: 'item_2:1', ok: true, truncated: false },
      { k: 'text', id: 'item_3', delta: 'I added notes.md, updated a.txt and removed b.md.' },
      { k: 'turn_end', reason: 'completed' },
    ]);
  });

  it('a failed command: a failed tool result with its exit code, and the turn still completes', async () => {
    const r = await replay('failed-command.jsonl');
    const events = r.socket.events();
    expect(events).toContainEqual({
      k: 'tool_result',
      id: 'item_1',
      ok: false,
      output: 'cat: missing.txt: No such file or directory\n',
      exitCode: 1,
      truncated: false,
    });
    expect(events.at(-1)).toEqual({ k: 'turn_end', reason: 'completed' });
  });

  it('a stopped turn: SIGINT, codex exits 1 with no final event, and the turn ends stopped', async () => {
    const r = await replay('interrupted.jsonl', { stop: true, exit: 1 });
    expect(r.proc.signals).toEqual(['SIGINT']);
    const events = r.socket.events();
    expect(events.map((event) => event.k)).toEqual(['user', 'tool_call', 'turn_end']);
    expect(events.at(-1)).toEqual({ k: 'turn_end', reason: 'stopped' });
  });

  it('a resumed session: `codex exec resume <id>`, the same thread id, the earlier turn remembered', async () => {
    const id = '01a0f1e6-e507-7c00-a172-76c9ce46e8f1';
    const r = await replay('resume.jsonl', { session: id });
    expect(r.proc.options.args).toEqual([
      'exec',
      'resume',
      '--json',
      '-c',
      'sandbox_mode="workspace-write"',
      id,
      '-',
    ]);
    // The session was already known, so no new `session` frame is needed.
    expect(r.socket.of('session')).toEqual([]);
    expect(r.socket.events()).toContainEqual({
      k: 'text',
      id: 'item_0',
      delta: 'Earlier you asked me to list the files: a.txt and b.md.',
    });
    expect(r.socket.events().at(-1)).toEqual({ k: 'turn_end', reason: 'completed' });
  });

  it('turn.failed: an inline error, no end marker, so the non-zero exit fails the turn', async () => {
    const r = await replay('turn-failed.jsonl', { exit: 1 });
    expect(r.socket.events()).toEqual([
      { k: 'user', text: 'the prompt' },
      { k: 'error', code: 'codex_error', message: 'stream disconnected before completion' },
      { k: 'error', code: 'turn_failed', message: 'stream disconnected before completion' },
      { k: 'turn_end', reason: 'failed', code: 'exit_nonzero' },
    ]);
  });

  it('other events: tool rows for MCP and web search, errors that do not end the turn, `other` for the rest — never logged', async () => {
    const r = await replay('other-events.jsonl');
    expect(r.socket.events()).toEqual([
      { k: 'user', text: 'the prompt' },
      { k: 'other', name: 'todo_list' },
      {
        k: 'tool_call',
        id: 'item_1',
        kind: 'other',
        name: 'web_search',
        title: 'codex exec json events',
      },
      { k: 'tool_result', id: 'item_1', ok: true, truncated: false },
      {
        k: 'tool_call',
        id: 'item_2',
        kind: 'other',
        name: 'motir.get_work_item',
        title: 'motir.get_work_item',
      },
      { k: 'tool_result', id: 'item_2', ok: true, output: 'MOTIR-1 · done', truncated: false },
      { k: 'error', code: 'codex_error', message: 'Reconnecting... 1/5' },
      { k: 'error', code: 'codex_error', message: 'model rerouted' },
      { k: 'other', name: 'session.configured' },
      { k: 'text', id: 'item_4', delta: 'MOTIR-1 is done.' },
      { k: 'turn_end', reason: 'completed' },
    ]);
    const logged = r.logs.join('\n');
    expect(logged).not.toMatch(/session\.configured|gpt-5|MOTIR-1|Reconnecting|todo/);
  });

  it('an unrecognised or malformed line does not end the turn and is not logged', async () => {
    const r = rig();
    r.send({ t: 'open' });
    r.send({ t: 'prompt', text: 'p' });
    await r.settle();
    const proc = r.procs[0]!;
    proc.line({ type: 'thread.started', thread_id: 'abc' });
    proc.line({ type: 'vendor.new_thing', secret: 'do-not-log-me' });
    proc.line('not json at all do-not-log-me');
    proc.line('[1,2,3]');
    proc.line({ no_type: 'do-not-log-me' });
    proc.line({ type: 'item.completed' });
    proc.line({ type: 'item.completed', item: { id: 'x' } });
    proc.line({ type: 'item.started', item: { id: 'y', type: 'reasoning' } });
    proc.line({ type: 'item.updated', item: { id: 'y', type: 'reasoning' } });
    await r.settle();
    expect(r.hub.runningTurn()).toBe(1);
    proc.line({ type: 'turn.completed', usage: { input_tokens: 1 } });
    proc.exit(0);
    await r.settle();
    expect(r.socket.events()).toEqual([
      { k: 'user', text: 'p' },
      { k: 'other', name: 'vendor.new_thing' },
      { k: 'other', name: 'item.completed' },
      { k: 'turn_end', reason: 'completed' },
    ]);
    expect(r.logs.join('\n')).not.toMatch(/do-not-log-me|vendor\.new_thing/);
  });
});

describe('the mapper, line by line', () => {
  it('writes a command’s call once, even when only item.completed arrives', () => {
    const mapper = createCodexMapper();
    const done = {
      type: 'item.completed',
      item: {
        id: 'c',
        type: 'command_execution',
        command: 'ls',
        aggregated_output: '',
        exit_code: 0,
        status: 'completed',
      },
    };
    expect(mapper.onLine(JSON.stringify(done)).map((event) => event.k)).toEqual([
      'tool_call',
      'tool_result',
    ]);
    expect(mapper.sawEnd()).toBe(false);
    expect(mapper.killCode()).toBeNull();
    expect(mapper.sessionId()).toBeNull();
  });

  it('marks a declined command, a failed file change and a failed MCP call failed', () => {
    const mapper = createCodexMapper();
    const line = (item: Record<string, unknown>): TranscriptEvent[] =>
      mapper.onLine(JSON.stringify({ type: 'item.completed', item }));
    expect(
      line({ id: 'a', type: 'command_execution', command: 'rm -rf /', status: 'declined' }).at(-1),
    ).toMatchObject({ k: 'tool_result', ok: false });
    expect(
      line({
        id: 'b',
        type: 'file_change',
        changes: [{ path: 'x', kind: 'update' }, { nope: 1 }],
        status: 'failed',
      }),
    ).toEqual([
      {
        k: 'tool_call',
        id: 'b:0',
        kind: 'edit',
        name: 'file_change',
        title: 'update x',
        path: 'x',
      },
      { k: 'tool_result', id: 'b:0', ok: false, truncated: false },
    ]);
    expect(
      line({
        id: 'c',
        type: 'mcp_tool_call',
        tool: 't',
        status: 'failed',
        error: { message: 'boom' },
      }),
    ).toEqual([
      { k: 'tool_call', id: 'c', kind: 'other', name: 't', title: 't' },
      { k: 'tool_result', id: 'c', ok: false, output: 'boom', truncated: false },
    ]);
    expect(line({ id: 'd', type: 'agent_message', text: '' })).toEqual([]);
    expect(line({ id: 'e', type: 'error' })).toEqual([{ k: 'error', code: 'codex_error' }]);
  });

  it('bounds a command’s output to its last 64 KiB', () => {
    const mapper = createCodexMapper();
    const output = `${'x'.repeat(MAX_TOOL_OUTPUT_BYTES)}TAIL`;
    const events = mapper.onLine(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'c',
          type: 'command_execution',
          command: 'yes',
          aggregated_output: output,
          exit_code: 0,
        },
      }),
    );
    const result = events.at(-1) as Extract<TranscriptEvent, { k: 'tool_result' }>;
    expect(result.truncated).toBe(true);
    expect(result.output?.endsWith('TAIL')).toBe(true);
    expect(Buffer.byteLength(result.output ?? '', 'utf8')).toBe(MAX_TOOL_OUTPUT_BYTES);
  });
});

describe('the session store (Q7)', () => {
  let home: string;
  let ctx: ChatContext;
  const A = '01a0f1e6-e507-7c00-a172-76c9ce46e8f1';
  const B = '01a0f1e7-2b10-7d31-9c2e-3f5b0a4c6d18';
  const C = '01a0f1e9-4c21-7b55-8a0d-2e6f9b3c1a74';
  const OTHER = '01a0f1ec-5b2a-7f60-9d31-4a8e0c7b2f16';

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'motir-codex-chat-'));
    const codex = join(home, '.motir-sandbox', 'agent-config', '.codex');
    await cp(join(FIXTURES, 'store'), codex, { recursive: true });
    const day = (d: string, file: string): string => join(codex, 'sessions', '2026', '09', d, file);
    // Last activity: A was resumed most recently, so it leads despite its older day.
    const mtimes: [string, string][] = [
      [day('28', `rollout-2026-09-28T10-00-00-${A}.jsonl`), '2026-09-30T12:00:00.000Z'],
      [day('29', `rollout-2026-09-29T09-00-00-${B}.jsonl`), '2026-09-29T09:00:03.000Z'],
      [day('30', `rollout-2026-09-30T08-00-00-${C}.jsonl`), '2026-09-30T08:00:03.000Z'],
      [day('30', `rollout-2026-09-30T09-00-00-${OTHER}.jsonl`), '2026-09-30T13:00:00.000Z'],
    ];
    for (const [path, at] of mtimes) await utimes(path, new Date(at), new Date(at));
    ctx = {
      home: HOME,
      cwd: CWD,
      env: { HOME, CODEX_HOME: codex },
    };
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('reads $CODEX_HOME, falling back to ~/.codex', () => {
    expect(codexHome(ctx)).toBe(ctx.env['CODEX_HOME']);
    expect(codexHome({ home: '/h', cwd: '/h/workspace', env: {} })).toBe('/h/.codex');
  });

  it('lists the workspace’s sessions newest first by last activity, each with its first prompt and time', async () => {
    expect(await codexChatAdapter.listSessions(ctx, MAX_LISTED_SESSIONS)).toEqual([
      { id: A, title: 'List the files in this directory', updatedAt: '2026-09-30T12:00:00.000Z' },
      { id: C, title: 'Run a long command', updatedAt: '2026-09-30T08:00:03.000Z' },
      { id: B, title: 'Add a notes file', updatedAt: '2026-09-29T09:00:03.000Z' },
    ]);
  });

  it('is bounded by the limit', async () => {
    expect((await codexChatAdapter.listSessions(ctx, 2)).map((item) => item.id)).toEqual([A, C]);
  });

  it('lists nothing when the store does not exist', async () => {
    expect(
      await codexChatAdapter.listSessions({ ...ctx, env: { CODEX_HOME: join(home, 'none') } }, 50),
    ).toEqual([]);
  });

  it('reads a resumed session’s earlier turns from its rollout', async () => {
    expect(await codexChatAdapter.readHistory(ctx, A, HISTORY_BUDGET_BYTES)).toEqual({
      truncated: false,
      events: [
        { k: 'user', text: 'List the files in this directory' },
        {
          k: 'tool_call',
          id: 'call_Ls01',
          kind: 'command',
          name: 'shell',
          title: 'bash -lc ls',
          command: 'bash -lc ls',
        },
        {
          k: 'tool_result',
          id: 'call_Ls01',
          ok: true,
          output: 'a.txt\nb.md\n',
          exitCode: 0,
          truncated: false,
        },
        { k: 'text', id: 'history-1', delta: 'The directory contains the files listed above.' },
        { k: 'turn_end', reason: 'completed' },
        { k: 'user', text: 'What did I ask you before?' },
        {
          k: 'text',
          id: 'history-2',
          delta: 'Earlier you asked me to list the files: a.txt and b.md.',
        },
        { k: 'turn_end', reason: 'completed' },
      ],
    });
  });

  it('draws an apply_patch as an edit with its patch, and turn_aborted as a stopped turn', async () => {
    const edit = await codexChatAdapter.readHistory(ctx, B, HISTORY_BUDGET_BYTES);
    expect(edit).toMatchObject({
      events: [
        { k: 'user', text: 'Add a notes file' },
        {
          k: 'tool_call',
          id: 'call_Ap01',
          kind: 'edit',
          name: 'apply_patch',
          path: 'notes.md',
          diff: '*** Begin Patch\n*** Add File: notes.md\n+# Notes\n*** End Patch\n',
        },
        { k: 'tool_result', id: 'call_Ap01', ok: true, exitCode: 0 },
        { k: 'text', delta: 'I added notes.md.' },
        { k: 'turn_end', reason: 'completed' },
      ],
    });
    const aborted = await codexChatAdapter.readHistory(ctx, C, HISTORY_BUDGET_BYTES);
    expect(aborted).toEqual({
      truncated: false,
      events: [
        { k: 'user', text: 'Run a long command' },
        {
          k: 'tool_call',
          id: 'call_Sl01',
          kind: 'command',
          name: 'shell',
          title: 'bash -lc sleep 60',
          command: 'bash -lc sleep 60',
        },
        { k: 'turn_end', reason: 'stopped' },
      ],
    });
  });

  it('keeps the newest turns within the budget', async () => {
    const history = await codexChatAdapter.readHistory(ctx, A, 300);
    expect(history).toEqual({
      truncated: true,
      events: [
        { k: 'user', text: 'What did I ask you before?' },
        {
          k: 'text',
          id: 'history-2',
          delta: 'Earlier you asked me to list the files: a.txt and b.md.',
        },
        { k: 'turn_end', reason: 'completed' },
      ],
    });
  });

  it('answers unavailable for a session that is not in the store, or not in the workspace', async () => {
    expect(await codexChatAdapter.readHistory(ctx, 'no-such-thread', HISTORY_BUDGET_BYTES)).toEqual(
      {
        unavailable: true,
      },
    );
    expect(await codexChatAdapter.readHistory(ctx, OTHER, HISTORY_BUDGET_BYTES)).toEqual({
      unavailable: true,
    });
  });
});
