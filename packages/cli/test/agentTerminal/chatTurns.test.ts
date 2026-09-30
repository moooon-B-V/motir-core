import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_ADAPTERS,
  HISTORY_BUDGET_BYTES,
  MAX_LISTED_SESSIONS,
  resolveChatAdapter,
  type ChatContext,
} from '../../src/agentTerminal/chat/adapter.js';
import {
  MAX_PROMPT_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  boundEvent,
  boundTail,
  isSessionId,
  parseChatClientFrame,
} from '../../src/agentTerminal/chat/protocol.js';
import {
  EventRing,
  STOP_GRACE_MS,
  createChatHub,
  spawnChatProcess,
  type ChatConnectionHandle,
  type ChatHub,
  type ChatHubOptions,
  type ChatProcessExit,
  type SpawnChat,
} from '../../src/agentTerminal/chat/turns.js';
import type { SignInState } from '../../src/agentTerminal/protocol.js';
import { FakeChatAdapter, fakeChatSpawner, type FakeChatProcess, type Frame } from './harness.js';

// The chat turn runner against a FAKE adapter and a FAKE process
// (MOTIR-7012 · `docs/decisions/agent-chat.md` Q4–Q7, Q10, Q11). No socket and
// no server: a socket is an object that records the frames written to it, so
// the runner's rules — Q6's gate order, one turn per agent, `turn_end`, Stop
// on a fake clock, the ring, takeover — are each asserted directly.
// `chat.test.ts` drives the same rules through the real server and its relay
// token.

const CTX: ChatContext = { home: '/h', cwd: '/h/workspace', env: { HOME: '/h', PATH: '/bin' } };

class FakeSocket {
  isOpen = true;
  readonly frames: Frame[] = [];
  send(text: string): void {
    this.frames.push(JSON.parse(text) as Frame);
  }
  of(t: string): Frame[] {
    return this.frames.filter((frame) => frame['t'] === t);
  }
  events(): Record<string, unknown>[] {
    return this.of('event').map((frame) => frame['e'] as Record<string, unknown>);
  }
}

interface Rig {
  hub: ChatHub;
  adapter: FakeChatAdapter;
  procs: FakeChatProcess[];
  logs: string[];
  signIn: { state: SignInState };
  connect(): { socket: FakeSocket; handle: ChatConnectionHandle; send(frame: Frame): void };
}

const hubs: ChatHub[] = [];

function rig(overrides: Partial<ChatHubOptions> = {}, adapterOn = true): Rig {
  const adapter = new FakeChatAdapter('kimi');
  const { spawn, procs } = fakeChatSpawner();
  const logs: string[] = [];
  const signIn: { state: SignInState } = { state: 'unknown' };
  const hub = createChatHub({
    profile: 'kimi',
    adapter: adapterOn ? adapter : null,
    ctx: CTX,
    spawn,
    readSignIn: async () => ({ profile: 'kimi', state: signIn.state }),
    log: (line) => logs.push(line),
    ...overrides,
  });
  hubs.push(hub);
  return {
    hub,
    adapter,
    procs,
    logs,
    signIn,
    connect() {
      const socket = new FakeSocket();
      const handle = hub.accept(socket);
      return {
        socket,
        handle,
        send: (frame) => handle.message(Buffer.from(JSON.stringify(frame)), false),
      };
    },
  };
}

/** Let the per-connection queue drain (every handler is a few awaits at most). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
  vi.useRealTimers();
});

describe('the pure protocol', () => {
  it('parses every client frame, and refuses a malformed one as bad_frame', () => {
    expect(parseChatClientFrame('{"t":"list"}')).toEqual({ ok: true, frame: { t: 'list' } });
    expect(parseChatClientFrame('{"t":"stop"}')).toEqual({ ok: true, frame: { t: 'stop' } });
    expect(parseChatClientFrame('{"t":"ping","active":true}')).toEqual({
      ok: true,
      frame: { t: 'ping', active: true },
    });
    expect(parseChatClientFrame('{"t":"open"}')).toEqual({ ok: true, frame: { t: 'open' } });
    expect(parseChatClientFrame('{"t":"open","session":null}')).toEqual({
      ok: true,
      frame: { t: 'open' },
    });
    expect(parseChatClientFrame('{"t":"open","session":"s1"}')).toEqual({
      ok: true,
      frame: { t: 'open', session: 's1' },
    });
    expect(parseChatClientFrame('{"t":"prompt","text":"hi"}')).toEqual({
      ok: true,
      frame: { t: 'prompt', text: 'hi' },
    });
    for (const bad of [
      'not json',
      '[]',
      'null',
      '{"t":"nope"}',
      '{"t":"open","session":""}',
      '{"t":"open","session":7}',
      '{"t":"prompt","text":""}',
      '{"t":"prompt"}',
    ]) {
      expect(parseChatClientFrame(bad)).toEqual({ ok: false, code: 'bad_frame' });
    }
  });

  it('caps a prompt at 64 KiB of UTF-8, not of characters', () => {
    const exact = 'a'.repeat(MAX_PROMPT_BYTES);
    expect(parseChatClientFrame(JSON.stringify({ t: 'prompt', text: exact })).ok).toBe(true);
    const over = 'é'.repeat(MAX_PROMPT_BYTES / 2 + 1); // 2 bytes each
    expect(parseChatClientFrame(JSON.stringify({ t: 'prompt', text: over }))).toEqual({
      ok: false,
      code: 'too_large',
    });
  });

  it('holds a session id to what a CLI id looks like — never an option or a path', () => {
    for (const good of ['49c4fa44-aaaa', 'ses_f0e1', 'session_542c', '01a0f1e6.x:y']) {
      expect(isSessionId(good)).toBe(true);
    }
    for (const bad of [
      '-rf',
      '--resume',
      '../etc',
      'a/b',
      'a..b',
      '.hidden',
      '',
      'x'.repeat(200),
    ]) {
      expect(isSessionId(bad)).toBe(false);
    }
  });

  it('cuts a tool output and a diff to their last 64 KiB, on a character boundary', () => {
    expect(boundTail('short')).toEqual({ text: 'short', truncated: false });
    const long = 'é'.repeat(MAX_TOOL_OUTPUT_BYTES); // 128 KiB
    const cut = boundTail(`x${long}`);
    expect(cut.truncated).toBe(true);
    expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
    expect(cut.text).toMatch(/^é+$/);
    expect(
      boundEvent({ k: 'tool_result', id: 't', ok: true, output: long, truncated: false }),
    ).toMatchObject({ truncated: true });
    const diff = boundEvent({
      k: 'tool_call',
      id: 't',
      kind: 'edit',
      name: 'Edit',
      title: 'a',
      diff: long,
    });
    expect(Buffer.byteLength((diff as { diff: string }).diff)).toBeLessThanOrEqual(
      MAX_TOOL_OUTPUT_BYTES,
    );
    const small = { k: 'tool_result', id: 't', ok: true, output: 'x', truncated: false } as const;
    expect(boundEvent(small)).toBe(small);
    const smallDiff = {
      k: 'tool_call',
      id: 't',
      kind: 'edit',
      name: 'E',
      title: 'a',
      diff: 'd',
    } as const;
    expect(boundEvent(smallDiff)).toBe(smallDiff);
    const text = { k: 'text', id: 'm', delta: 'hi' } as const;
    expect(boundEvent(text)).toBe(text);
  });

  it('bounds the per-turn ring, dropping the oldest frames', () => {
    const ring = new EventRing(10);
    ring.push('aaaa');
    ring.push('bbbb');
    expect(ring.snapshot()).toEqual(['aaaa', 'bbbb']);
    ring.push('cccc');
    expect(ring.snapshot()).toEqual(['bbbb', 'cccc']);
    expect(ring.size).toBe(8);
  });
});

describe('the adapter registry', () => {
  it('registers one adapter per supported profile, and none for aider (Q1)', () => {
    const profiles = CHAT_ADAPTERS.map((adapter) => adapter.profile);
    expect([...profiles].sort()).toEqual(['claude', 'codex', 'goose', 'kimi', 'opencode']);
    for (const adapter of CHAT_ADAPTERS) expect(resolveChatAdapter(adapter.profile)).toBe(adapter);
    // Q1: aider has no machine-readable output for a chat to follow.
    expect(resolveChatAdapter('aider')).toBeNull();
    expect(resolveChatAdapter(null)).toBeNull();
  });

  it('keys on the MOTIR_SANDBOX_AGENT id', () => {
    const fake = new FakeChatAdapter('codex');
    expect(resolveChatAdapter('codex', [fake])).toBe(fake);
    expect(resolveChatAdapter('claude', [fake])).toBeNull();
  });
});

describe('hello', () => {
  it('answers supported: false with the unsupported reason when no adapter serves the profile', async () => {
    const r = rig({}, false);
    const { socket } = r.connect();
    await settle();
    expect(socket.frames[0]).toEqual({
      t: 'hello',
      profile: 'kimi',
      supported: false,
      reason: 'unsupported',
      signin: 'unknown',
    });
  });

  it('answers supported: true with an adapter, and carries the sign-in state', async () => {
    const r = rig();
    r.signIn.state = 'signed_in';
    const { socket } = r.connect();
    await settle();
    expect(socket.frames[0]).toEqual({
      t: 'hello',
      profile: 'kimi',
      supported: true,
      signin: 'signed_in',
    });
  });

  it("carries the adapter's subscription_signin refusal (Q2)", async () => {
    const r = rig();
    r.adapter.answer = { supported: false, code: 'subscription_signin' };
    const { socket } = r.connect();
    await settle();
    expect(socket.frames[0]).toMatchObject({ supported: false, reason: 'subscription_signin' });
  });

  it('answers unsupported when the probe throws, and unknown when the sign-in read throws', async () => {
    const r = rig({
      readSignIn: async () => {
        throw new Error('/secret/path');
      },
    });
    r.adapter.support = async () => {
      throw new Error('/secret/path');
    };
    const { socket } = r.connect();
    await settle();
    expect(socket.frames[0]).toMatchObject({
      supported: false,
      reason: 'unsupported',
      signin: 'unknown',
    });
    expect(r.logs.join('\n')).not.toContain('/secret/path');
  });

  it('is the first frame even when the client speaks first', async () => {
    const r = rig();
    const { socket, send } = r.connect();
    send({ t: 'ping', active: true });
    await settle();
    expect(socket.frames.map((frame) => frame['t'])).toEqual(['hello', 'pong']);
  });
});

describe('a turn', () => {
  it("streams the fake's events in order, after the prompt, and ends completed", async () => {
    const r = rig();
    const { socket, send } = r.connect();
    send({ t: 'open' });
    send({ t: 'prompt', text: 'list the files' });
    await settle();
    expect(socket.of('ready')).toEqual([{ t: 'ready', session: null, resumed: false }]);
    expect(r.procs).toHaveLength(1);
    const proc = r.procs[0]!;
    expect(proc.options).toMatchObject({
      file: 'fake-agent',
      args: [],
      cwd: '/h/workspace',
      stdin: 'list the files',
    });
    proc.line({ type: 'session', id: 'ses_1' });
    proc.line({ type: 'tool', id: 't1', command: 'ls', output: 'a.txt' });
    proc.line('not json at all');
    proc.line({ type: 'weird' });
    proc.raw('{"type":"text","id":"m1",');
    proc.raw(Buffer.from('"text":"done ✓"}\r\n{"type":"end"}'));
    proc.exit(0);
    expect(socket.of('session')).toEqual([{ t: 'session', id: 'ses_1' }]);
    expect(socket.events()).toEqual([
      { k: 'user', text: 'list the files' },
      { k: 'tool_call', id: 't1', kind: 'command', name: 'Bash', title: 'ls', command: 'ls' },
      { k: 'tool_result', id: 't1', ok: true, output: 'a.txt', exitCode: 0, truncated: false },
      { k: 'other', name: 'weird' },
      { k: 'text', id: 'm1', delta: 'done ✓' },
      { k: 'turn_end', reason: 'completed' },
    ]);
    expect(socket.of('event').every((frame) => frame['turn'] === 1)).toBe(true);
    expect(r.hub.runningTurn()).toBeNull();
  });

  it('resumes the session the stream revealed on the next prompt', async () => {
    const r = rig();
    const { send } = r.connect();
    send({ t: 'open' });
    send({ t: 'prompt', text: 'one' });
    await settle();
    r.procs[0]!.line({ type: 'session', id: 'ses_9' });
    r.procs[0]!.line({ type: 'end' });
    r.procs[0]!.exit(0);
    send({ t: 'prompt', text: 'two' });
    await settle();
    expect(r.adapter.commands).toEqual([
      { prompt: 'one', sessionId: null },
      { prompt: 'two', sessionId: 'ses_9' },
    ]);
    expect(r.procs[1]!.options.args).toEqual(['--resume', 'ses_9']);
  });

  it('ends failed on a non-zero exit, and on exit 0 without the end marker', async () => {
    const r = rig();
    const { socket, send } = r.connect();
    send({ t: 'open' });
    send({ t: 'prompt', text: 'a' });
    await settle();
    r.procs[0]!.line({ type: 'text', id: 'm', text: 'half' });
    r.procs[0]!.exit(1); // the process exited mid-turn
    send({ t: 'prompt', text: 'b' });
    await settle();
    r.procs[1]!.exit(0);
    const ends = socket.events().filter((event) => event['k'] === 'turn_end');
    expect(ends).toEqual([
      { k: 'turn_end', reason: 'failed', code: 'exit_nonzero' },
      { k: 'turn_end', reason: 'failed', code: 'no_end' },
    ]);
  });

  it("an adapter-requested kill (Q2's backstop) SIGKILLs at once and ends failed with its code", async () => {
    const r = rig();
    const { socket, send } = r.connect();
    send({ t: 'open' });
    send({ t: 'prompt', text: 'a' });
    await settle();
    r.procs[0]!.line({ type: 'no_key' });
    expect(r.procs[0]!.signals).toEqual(['SIGKILL']);
    expect(socket.events().at(-1)).toEqual({
      k: 'turn_end',
      reason: 'failed',
      code: 'subscription_signin',
    });
    expect(r.logs).toContain('agent-chat: turn 1 killed by its adapter (subscription_signin)');
  });

  it('ends failed spawn_failed when the process cannot start, and frees the agent', async () => {
    const r = rig({
      spawn: () => {
        throw new Error('ENOENT /usr/bin/fake-agent');
      },
    });
    const { socket, send } = r.connect();
    send({ t: 'open' });
    send({ t: 'prompt', text: 'a' });
    await settle();
    expect(socket.events()).toEqual([
      { k: 'user', text: 'a' },
      { k: 'turn_end', reason: 'failed', code: 'spawn_failed' },
    ]);
    expect(r.hub.runningTurn()).toBeNull();
    expect(r.logs.join('\n')).not.toContain('ENOENT');
  });

  it('ends failed spawn_failed when the binary is not on PATH (the exit says so)', async () => {
    const fail: SpawnChat = () => ({
      pid: -1,
      onStdout: () => {},
      onExit: (listener: (exit: ChatProcessExit) => void) =>
        listener({ code: null, signal: null, failedToStart: true }),
      signal: () => {},
    });
    const r = rig({ spawn: fail });
    const { socket, send } = r.connect();
    send({ t: 'open' });
    send({ t: 'prompt', text: 'a' });
    await settle();
    expect(socket.events().at(-1)).toEqual({
      k: 'turn_end',
      reason: 'failed',
      code: 'spawn_failed',
    });
  });

  it('holds the command to Q11: a bare binary, and no env addition but GOOSE_MODE', async () => {
    const r = rig();
    const { socket, send } = r.connect();
    send({ t: 'open' });
    r.adapter.command = { file: '/bin/sh' };
    send({ t: 'prompt', text: 'a' });
    await settle();
    r.adapter.command = { env: { ANTHROPIC_API_KEY: 'sk-nope' } };
    send({ t: 'prompt', text: 'b' });
    await settle();
    expect(r.procs).toHaveLength(0);
    expect(
      socket
        .events()
        .filter((event) => event['k'] === 'turn_end')
        .map((event) => event['code']),
    ).toEqual(['spawn_failed', 'spawn_failed']);
    r.adapter.command = { env: { GOOSE_MODE: 'auto' } };
    send({ t: 'prompt', text: 'c' });
    await settle();
    expect(r.procs[0]!.options.env).toEqual({ HOME: '/h', PATH: '/bin', GOOSE_MODE: 'auto' });
  });

  it('never lets the key reach the process, even if the context carried it', async () => {
    const r = rig({ ctx: { ...CTX, env: { ...CTX.env, MOTIR_TERMINAL_KEY: 'k' } } });
    const { send } = r.connect();
    send({ t: 'open' });
    send({ t: 'prompt', text: 'a' });
    await settle();
    expect(r.procs[0]!.options.env).not.toHaveProperty('MOTIR_TERMINAL_KEY');
  });

  it('bounds a tool output the adapter did not', async () => {
    const r = rig();
    const { socket, send } = r.connect();
    send({ t: 'open' });
    send({ t: 'prompt', text: 'a' });
    await settle();
    r.procs[0]!.line({ type: 'tool', id: 't', command: 'cat', output: 'x'.repeat(200_000) });
    const result = socket.events().find((event) => event['k'] === 'tool_result')!;
    expect((result['output'] as string).length).toBe(MAX_TOOL_OUTPUT_BYTES);
    expect(result['truncated']).toBe(true);
  });

  it('survives a mapper that throws', async () => {
    const r = rig();
    r.adapter.createMapper = () => ({
      onLine: () => {
        throw new Error('boom');
      },
      sessionId: () => {
        throw new Error('boom');
      },
      sawEnd: () => {
        throw new Error('boom');
      },
      killCode: () => {
        throw new Error('boom');
      },
    });
    const { socket, send } = r.connect();
    send({ t: 'open' });
    send({ t: 'prompt', text: 'a' });
    await settle();
    r.procs[0]!.line({ type: 'text', id: 'm', text: 'x' });
    r.procs[0]!.exit(0);
    expect(socket.events().at(-1)).toEqual({ k: 'turn_end', reason: 'failed', code: 'no_end' });
  });
});

describe('the gates, in Q6 order — a refusal spawns nothing', () => {
  it('refuses unsupported with no adapter (and list / open too)', async () => {
    const r = rig({}, false);
    const { socket, send } = r.connect();
    send({ t: 'list' });
    send({ t: 'open' });
    send({ t: 'prompt', text: 'a' });
    await settle();
    expect(socket.of('error')).toEqual([
      { t: 'error', code: 'unsupported' },
      { t: 'error', code: 'unsupported' },
      { t: 'error', code: 'bad_frame' }, // a prompt before any `open`
    ]);
    expect(r.procs).toHaveLength(0);
  });

  it('refuses subscription_signin before looking at the sign-in state', async () => {
    const r = rig();
    const { socket, send } = r.connect();
    send({ t: 'open' });
    await settle();
    r.adapter.answer = { supported: false, code: 'subscription_signin' };
    r.signIn.state = 'signed_out';
    send({ t: 'prompt', text: 'a' });
    await settle();
    expect(socket.of('error')).toEqual([{ t: 'error', code: 'subscription_signin' }]);
    expect(r.procs).toHaveLength(0);
  });

  it('refuses not_signed_in when the check says signed out; unknown is let through', async () => {
    const r = rig();
    const { socket, send } = r.connect();
    send({ t: 'open' });
    r.signIn.state = 'signed_out';
    send({ t: 'prompt', text: 'a' });
    await settle();
    expect(socket.of('error')).toEqual([{ t: 'error', code: 'not_signed_in' }]);
    expect(r.procs).toHaveLength(0);
    r.signIn.state = 'unknown';
    send({ t: 'prompt', text: 'a' });
    await settle();
    expect(r.procs).toHaveLength(1);
  });

  it('skips the file stat when the adapter confirmed the sign-in itself (Claude Code on an API key)', async () => {
    const r = rig();
    r.adapter.answer = { supported: true, signedIn: true };
    r.signIn.state = 'signed_out';
    const { socket, send } = r.connect();
    send({ t: 'open' });
    await settle();
    expect(socket.of('hello')[0]).toMatchObject({ supported: true, signin: 'signed_in' });
    send({ t: 'prompt', text: 'a' });
    await settle();
    expect(socket.of('error')).toEqual([]);
    expect(r.procs).toHaveLength(1);
  });

  it('allows ONE running turn per agent: the same session and a different one are both refused', async () => {
    const r = rig();
    const first = r.connect();
    const second = r.connect();
    first.send({ t: 'open' });
    first.send({ t: 'prompt', text: 'a' });
    await settle();
    first.send({ t: 'prompt', text: 'again' });
    second.send({ t: 'open', session: 'other_session' });
    second.send({ t: 'prompt', text: 'b' });
    await settle();
    expect(first.socket.of('error')).toEqual([{ t: 'error', code: 'turn_running' }]);
    expect(second.socket.of('error')).toEqual([{ t: 'error', code: 'turn_running' }]);
    expect(r.procs).toHaveLength(1);
    expect(r.hub.runningTurn()).toBe(1);
  });

  it('refuses two simultaneous prompts from two sockets to ONE spawn', async () => {
    const r = rig();
    const a = r.connect();
    const b = r.connect();
    a.send({ t: 'open' });
    b.send({ t: 'open' });
    await settle();
    a.send({ t: 'prompt', text: 'a' });
    b.send({ t: 'prompt', text: 'b' });
    await settle();
    expect(r.procs).toHaveLength(1);
    expect([...a.socket.of('error'), ...b.socket.of('error')]).toEqual([
      { t: 'error', code: 'turn_running' },
    ]);
  });
});

describe('Stop', () => {
  it('sends SIGINT, escalates to SIGKILL after 5 s, and ends the turn stopped', async () => {
    vi.useFakeTimers();
    const r = rig();
    const { socket, send } = r.connect();
    send({ t: 'open' });
    send({ t: 'prompt', text: 'a' });
    await settle();
    const proc = r.procs[0]!;
    send({ t: 'stop' });
    send({ t: 'stop' }); // a second stop while stopping is a no-op
    await settle();
    expect(proc.signals).toEqual(['SIGINT']);
    vi.advanceTimersByTime(STOP_GRACE_MS - 1);
    expect(proc.signals).toEqual(['SIGINT']);
    vi.advanceTimersByTime(1);
    expect(proc.signals).toEqual(['SIGINT', 'SIGKILL']);
    expect(socket.events().at(-1)).toEqual({ k: 'turn_end', reason: 'stopped' });
    expect(socket.of('error')).toEqual([]);
  });

  it('ends stopped when the process exits on the SIGINT, whatever it printed', async () => {
    vi.useFakeTimers();
    const r = rig();
    const { socket, send } = r.connect();
    send({ t: 'open' });
    send({ t: 'prompt', text: 'a' });
    await settle();
    send({ t: 'stop' });
    await settle();
    r.procs[0]!.line({ type: 'end' });
    r.procs[0]!.exit(0);
    expect(socket.events().at(-1)).toEqual({ k: 'turn_end', reason: 'stopped' });
    vi.advanceTimersByTime(STOP_GRACE_MS);
    expect(r.procs[0]!.signals).toEqual(['SIGINT']); // the timer was cleared
  });

  it('answers no_turn with nothing running, or for a turn on another session', async () => {
    const r = rig();
    const a = r.connect();
    const b = r.connect();
    a.send({ t: 'stop' });
    a.send({ t: 'open' });
    a.send({ t: 'prompt', text: 'a' });
    b.send({ t: 'open', session: 'elsewhere' });
    await settle();
    b.send({ t: 'stop' });
    await settle();
    expect(a.socket.of('error')).toEqual([{ t: 'error', code: 'no_turn' }]);
    expect(b.socket.of('error')).toEqual([{ t: 'error', code: 'no_turn' }]);
    expect(r.procs[0]!.signals).toEqual([]);
  });
});

describe('a dropped socket, a resume, a takeover', () => {
  it('a dropped socket does not stop the turn; a re-open gets history, then the ring, then live events', async () => {
    const r = rig();
    const first = r.connect();
    first.send({ t: 'open' });
    first.send({ t: 'prompt', text: 'a' });
    await settle();
    const proc = r.procs[0]!;
    proc.line({ type: 'session', id: 'ses_drop' });
    proc.line({ type: 'text', id: 'm1', text: 'before' });
    first.socket.isOpen = false;
    first.handle.closed();
    proc.line({ type: 'text', id: 'm2', text: 'while away' });
    expect(proc.signals).toEqual([]);
    expect(r.hub.runningTurn()).toBe(1);

    r.adapter.history = { events: [{ k: 'user', text: 'earlier' }], truncated: false };
    const second = r.connect();
    second.send({ t: 'open', session: 'ses_drop' });
    await settle();
    proc.line({ type: 'text', id: 'm3', text: 'live' });
    proc.line({ type: 'end' });
    proc.exit(0);
    const kinds = second.socket.frames.map((frame) => frame['t']);
    expect(kinds.slice(0, 3)).toEqual(['hello', 'ready', 'history']);
    expect(second.socket.of('ready')).toEqual([{ t: 'ready', session: 'ses_drop', resumed: true }]);
    expect(second.socket.of('history')).toEqual([
      { t: 'history', events: [{ k: 'user', text: 'earlier' }], truncated: false },
    ]);
    expect(second.socket.events()).toEqual([
      { k: 'user', text: 'a' },
      { k: 'text', id: 'm1', delta: 'before' },
      { k: 'text', id: 'm2', delta: 'while away' },
      { k: 'text', id: 'm3', delta: 'live' },
      { k: 'turn_end', reason: 'completed' },
    ]);
    expect(r.adapter.histories).toEqual([
      { sessionId: 'ses_drop', budgetBytes: HISTORY_BUDGET_BYTES },
    ]);
  });

  it('holds live events back until the history is sent', async () => {
    const r = rig();
    const first = r.connect();
    first.send({ t: 'open', session: 'ses_x' });
    await settle();
    first.send({ t: 'prompt', text: 'a' });
    await settle();
    first.handle.closed();
    let release!: () => void;
    r.adapter.historyGate = new Promise((resolve) => (release = resolve));
    const second = r.connect();
    second.send({ t: 'open', session: 'ses_x' });
    await settle();
    r.procs[0]!.line({ type: 'text', id: 'm', text: 'during the read' });
    expect(second.socket.of('event')).toEqual([]);
    release();
    await settle();
    expect(second.socket.frames.map((frame) => frame['t'])).toEqual([
      'hello',
      'ready',
      'history',
      'event',
      'event',
    ]);
  });

  it('answers history unavailable as no events, truncated; a throwing read the same', async () => {
    const r = rig();
    r.adapter.history = { unavailable: true };
    const a = r.connect();
    a.send({ t: 'open', session: 'ses_u' });
    await settle();
    r.adapter.readHistory = async () => {
      throw new Error('/home/x/.store');
    };
    a.send({ t: 'open', session: 'ses_v' });
    await settle();
    expect(a.socket.of('history')).toEqual([
      { t: 'history', events: [], truncated: true },
      { t: 'history', events: [], truncated: true },
    ]);
  });

  it('a later open of a held session sends taken_over to the earlier socket, and streams to the new one', async () => {
    const r = rig();
    const first = r.connect();
    first.send({ t: 'open', session: 'ses_t' });
    await settle();
    first.send({ t: 'prompt', text: 'a' });
    await settle();
    const second = r.connect();
    second.send({ t: 'open', session: 'ses_t' });
    await settle();
    expect(first.socket.of('error')).toEqual([{ t: 'error', code: 'taken_over' }]);
    r.procs[0]!.line({ type: 'text', id: 'm', text: 'after' });
    expect(first.socket.events()).toEqual([{ k: 'user', text: 'a' }]);
    expect(second.socket.events().at(-1)).toEqual({ k: 'text', id: 'm', delta: 'after' });
    // The earlier socket no longer holds a turn to stop.
    first.send({ t: 'stop' });
    await settle();
    expect(first.socket.of('error').at(-1)).toEqual({ t: 'error', code: 'no_turn' });
  });

  it('a takeover during a slow history read goes to the later socket only', async () => {
    const r = rig();
    let release!: () => void;
    r.adapter.historyGate = new Promise((resolve) => (release = resolve));
    const first = r.connect();
    const second = r.connect();
    first.send({ t: 'open', session: 'ses_s' });
    await settle();
    second.send({ t: 'open', session: 'ses_s' });
    await settle();
    release();
    await settle();
    expect(first.socket.of('error')).toEqual([{ t: 'error', code: 'taken_over' }]);
    expect(first.socket.of('history')).toEqual([]);
    expect(second.socket.of('history')).toHaveLength(1);
  });

  it('refuses an open of an id that is not a session id', async () => {
    const r = rig();
    const { socket, send } = r.connect();
    send({ t: 'open', session: '--dangerously' });
    await settle();
    expect(socket.of('error')).toEqual([{ t: 'error', code: 'unknown_session' }]);
    expect(r.adapter.histories).toEqual([]);
  });

  it('frees a session nothing holds once its turn ends', async () => {
    const r = rig();
    const a = r.connect();
    a.send({ t: 'open', session: 'ses_f' });
    await settle();
    a.send({ t: 'prompt', text: 'a' });
    await settle();
    a.handle.closed();
    r.procs[0]!.exit(0);
    // A fresh open of it reads the store again, with no ring to replay.
    const b = r.connect();
    b.send({ t: 'open', session: 'ses_f' });
    await settle();
    expect(b.socket.of('event')).toEqual([]);
  });

  it('re-opening on the same socket switches its session', async () => {
    const r = rig();
    const { socket, send } = r.connect();
    send({ t: 'open', session: 'ses_1' });
    send({ t: 'open' });
    await settle();
    expect(socket.of('ready')).toEqual([
      { t: 'ready', session: 'ses_1', resumed: true },
      { t: 'ready', session: null, resumed: false },
    ]);
    expect(socket.of('error')).toEqual([]);
  });
});

describe('the session list', () => {
  it("returns the adapter's list in the Q4 frame, at most 50, titles cut to 120 characters", async () => {
    const r = rig();
    r.adapter.sessions = Array.from({ length: 60 }, (_, i) => ({
      id: `s${i}`,
      title: i === 0 ? '✓'.repeat(200) : `t${i}`,
      updatedAt: '2026-09-30T10:00:00.000Z',
    }));
    const { socket, send } = r.connect();
    send({ t: 'list' });
    await settle();
    const [frame] = socket.of('sessions');
    const items = frame!['items'] as { id: string; title: string; updatedAt: string }[];
    expect(items).toHaveLength(MAX_LISTED_SESSIONS);
    expect(Array.from(items[0]!.title)).toHaveLength(120);
    expect(items[1]).toEqual({ id: 's1', title: 't1', updatedAt: '2026-09-30T10:00:00.000Z' });
    expect(r.adapter.listed).toEqual([MAX_LISTED_SESSIONS]);
  });

  it('lists nothing when the store cannot be read', async () => {
    const r = rig();
    r.adapter.listSessions = async () => {
      throw new Error('/home/x');
    };
    const { socket, send } = r.connect();
    send({ t: 'list' });
    await settle();
    expect(socket.of('sessions')).toEqual([{ t: 'sessions', items: [] }]);
  });
});

describe('frames the chat refuses, and the hub’s lifecycle', () => {
  it('answers bad_frame to a malformed or binary frame and too_large to an oversize prompt', async () => {
    const r = rig();
    const { socket, handle } = r.connect();
    handle.message(Buffer.from('{nope'), false);
    handle.message(Buffer.from([1, 2, 3]), true);
    handle.message(
      Buffer.from(JSON.stringify({ t: 'prompt', text: 'x'.repeat(MAX_PROMPT_BYTES + 1) })),
      false,
    );
    await settle();
    expect(socket.of('error')).toEqual([
      { t: 'error', code: 'bad_frame' },
      { t: 'error', code: 'bad_frame' },
      { t: 'error', code: 'too_large' },
    ]);
  });

  it('pushes a sign-in change to every open socket, and nothing to a closed one', async () => {
    const r = rig();
    const a = r.connect();
    const b = r.connect();
    b.socket.isOpen = false;
    r.hub.pushSignIn({ profile: 'kimi', state: 'signed_in' });
    expect(a.socket.of('signin')).toEqual([{ t: 'signin', profile: 'kimi', state: 'signed_in' }]);
    expect(b.socket.of('signin')).toEqual([]);
    expect(r.hub.connectionCount()).toBe(2);
    b.handle.closed();
    expect(r.hub.connectionCount()).toBe(1);
  });

  it('close() kills the running turn, which ends failed shutdown; a prompt after it spawns nothing', async () => {
    const r = rig();
    const { socket, send } = r.connect();
    send({ t: 'open' });
    send({ t: 'prompt', text: 'a' });
    await settle();
    r.hub.close();
    expect(r.procs[0]!.signals).toEqual(['SIGKILL']);
    expect(socket.events().at(-1)).toEqual({ k: 'turn_end', reason: 'failed', code: 'shutdown' });
    send({ t: 'prompt', text: 'b' });
    await settle();
    expect(r.procs).toHaveLength(1);
  });

  it('logs the lifecycle only — never the prompt, a delta or a tool output', async () => {
    vi.useFakeTimers();
    const r = rig();
    const { send } = r.connect();
    send({ t: 'open', session: 'ses_marker_id' });
    send({ t: 'prompt', text: 'PROMPT-MARKER' });
    await settle();
    const proc = r.procs[0]!;
    proc.line({ type: 'session', id: 'ses_marker_id' });
    proc.line({ type: 'text', id: 'm', text: 'DELTA-MARKER' });
    proc.line({ type: 'tool', id: 't', command: 'COMMAND-MARKER', output: 'OUTPUT-MARKER' });
    proc.line('RAW-LINE-MARKER');
    send({ t: 'stop' });
    await settle();
    vi.advanceTimersByTime(STOP_GRACE_MS);
    send({ t: 'prompt', text: 'x'.repeat(10) + 'SECOND-PROMPT-MARKER' });
    send({ t: 'list' });
    await settle();
    const all = r.logs.join('\n');
    expect(r.logs.length).toBeGreaterThan(3);
    for (const marker of [
      'PROMPT-MARKER',
      'DELTA-MARKER',
      'COMMAND-MARKER',
      'OUTPUT-MARKER',
      'RAW-LINE-MARKER',
      'ses_marker_id',
    ]) {
      expect(all).not.toContain(marker);
    }
    expect(r.logs).toContain('agent-chat: turn 1 started (pid 2000)');
    expect(r.logs.some((line) => /^agent-chat: turn 1 ended \(stopped, \d+ ms\)$/.test(line))).toBe(
      true,
    );
  });
});

describe('the real process spawn', () => {
  it('runs the binary directly with the prompt on stdin, reads stdout, discards stderr', async () => {
    const proc = spawnChatProcess({
      file: process.execPath,
      args: [
        '-e',
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stderr.write('noise');" +
          'console.log(JSON.stringify({got:s,env:process.env.CHAT_T}))})',
      ],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '', CHAT_T: 'yes' },
      stdin: 'hello over stdin',
    });
    const out: Buffer[] = [];
    proc.onStdout((chunk) => out.push(chunk));
    const exit = await new Promise<ChatProcessExit>((resolve) => proc.onExit(resolve));
    expect(exit).toEqual({ code: 0, signal: null });
    expect(JSON.parse(Buffer.concat(out).toString('utf8'))).toEqual({
      got: 'hello over stdin',
      env: 'yes',
    });
    // Once exited, a listener still hears it and a signal is a no-op.
    const again = await new Promise<ChatProcessExit>((resolve) => proc.onExit(resolve));
    expect(again.code).toBe(0);
    proc.signal('SIGINT');
  });

  it('signals the process GROUP', async () => {
    const proc = spawnChatProcess({
      file: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      stdin: null,
    });
    expect(proc.pid).toBeGreaterThan(0);
    const exited = new Promise<ChatProcessExit>((resolve) => proc.onExit(resolve));
    proc.signal('SIGINT');
    expect((await exited).signal).toBe('SIGINT');
  });

  it('reports a binary that cannot start', async () => {
    const proc = spawnChatProcess({
      file: 'motir-no-such-binary-7012',
      args: [],
      cwd: process.cwd(),
      env: { PATH: '/nonexistent' },
      stdin: 'x',
    });
    const exit = await new Promise<ChatProcessExit>((resolve) => proc.onExit(resolve));
    expect(exit.failedToStart).toBe(true);
    proc.signal('SIGKILL'); // nothing to signal
  });
});
