import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { relayAuthorizationHeader } from '../../src/agentTerminal/relayToken.js';
import { chatEnv, type TerminalServerOptions } from '../../src/agentTerminal/server.js';
import { Client, FakeChatAdapter, KEY, startHarness, type Frame, type Harness } from './harness.js';

// `/v1/chat` through the REAL server (MOTIR-7012 · `docs/decisions/agent-chat.md`
// Q4, Q6, Q10, Q11): the same upgrade and the same relay-token check as
// `/v1/terminal`, then the chat hub, driven by a FAKE adapter and a FAKE turn
// process. No real adapter is registered, so without a test-registered fake
// every profile answers unsupported. `chatTurns.test.ts` holds the runner's
// rules one by one; this file proves they hold behind the token, on a socket.

let harness: Harness | null = null;
const clients: Client[] = [];
const temps: string[] = [];

async function start(
  options: Partial<TerminalServerOptions> = {},
  adapter: FakeChatAdapter | null = null,
): Promise<Harness> {
  harness = await startHarness({
    ...(adapter ? { chatAdapters: [adapter] } : {}),
    ...options,
  });
  return harness;
}

async function chat(
  h: Harness,
  overrides?: Parameters<Harness['connectChat']>[0],
): Promise<Client> {
  const client = await h.connectChat(overrides);
  clients.push(client);
  return client;
}

/** A signed-in claude machine: the stat says the credential file is there. */
function signedInClaude(): Partial<TerminalServerOptions> {
  const home = mkdtempSync(join(tmpdir(), 'motir-chat-'));
  temps.push(home);
  return {
    env: {
      HOME: home,
      MOTIR_SANDBOX_AGENT: 'claude',
      CLAUDE_CONFIG_DIR: join(home, 'claude-config'),
      MOTIR_TERMINAL_KEY: KEY,
      PATH: '/usr/bin',
    },
    stat: async () => ({ isFile: () => true, size: 10 }),
  };
}

const events = (client: Client): Frame[] =>
  client.frames.filter((frame) => frame['t'] === 'event').map((frame) => frame['e'] as Frame);

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await harness?.terminal.close();
  harness = null;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the upgrade is refused EXACTLY as /v1/terminal refuses it', () => {
  it.each([
    ['no Authorization header', { authorization: null }],
    ['a different scheme', { authorization: 'Bearer abc' }],
    ['a forged signature', { authorization: relayAuthorizationHeader('eyJ9.AAAA') }],
    ['another instance', { instanceId: 'inst_other' }],
    ['another machine', { machineId: 'mach_other' }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 1 }],
  ] as const)('refuses %s, and spawns nothing', async (_label, overrides) => {
    const h = await start({}, new FakeChatAdapter('kimi'));
    await expect(h.connectChat(overrides)).rejects.toThrow('refused');
    expect(h.chatProcs).toHaveLength(0);
    expect(h.logs.some((line) => line.startsWith('agent-terminal: upgrade refused ('))).toBe(true);
    expect(h.logs.some((line) => line.startsWith('agent-chat:'))).toBe(false);
  });

  it('refuses a replayed token, and one nonce is spent across both paths', async () => {
    const h = await start({}, new FakeChatAdapter('kimi'));
    const header = relayAuthorizationHeader(h.token());
    await chat(h, { authorization: header });
    await expect(h.connectChat({ authorization: header })).rejects.toThrow('refused');
    await expect(h.connect({ authorization: header })).rejects.toThrow('refused');
    expect(
      h.logs.filter((line) => line === 'agent-terminal: upgrade refused (replayed)'),
    ).toHaveLength(2);
  });
});

describe('hello', () => {
  it('answers supported: false, reason unsupported, when no adapter is registered — and a prompt spawns nothing', async () => {
    const h = await start();
    const client = await chat(h);
    expect(await client.frame('hello')).toEqual({
      t: 'hello',
      profile: 'kimi',
      supported: false,
      reason: 'unsupported',
      signin: 'unknown',
    });
    client.sendJson({ t: 'open' });
    client.sendJson({ t: 'prompt', text: 'hi' });
    await client.frame('error', 1);
    expect(client.frames.filter((frame) => frame['t'] === 'error')).toEqual([
      { t: 'error', code: 'unsupported' },
      { t: 'error', code: 'bad_frame' },
    ]);
    expect(h.chatProcs).toHaveLength(0);
  });

  it('answers supported: true with a test-registered fake adapter', async () => {
    const h = await start(signedInClaude(), new FakeChatAdapter('claude'));
    const client = await chat(h);
    expect(await client.frame('hello')).toEqual({
      t: 'hello',
      profile: 'claude',
      supported: true,
      signin: 'signed_in',
    });
  });

  it("carries the fake's subscription_signin, and a prompt spawns nothing", async () => {
    const adapter = new FakeChatAdapter('claude');
    adapter.answer = { supported: false, code: 'subscription_signin' };
    const h = await start(signedInClaude(), adapter);
    const client = await chat(h);
    expect(await client.frame('hello')).toMatchObject({
      supported: false,
      reason: 'subscription_signin',
    });
    client.sendJson({ t: 'open' });
    await client.frame('ready');
    client.sendJson({ t: 'prompt', text: 'hi' });
    expect(await client.frame('error')).toEqual({ t: 'error', code: 'subscription_signin' });
    expect(h.chatProcs).toHaveLength(0);
  });
});

describe('a turn over the socket', () => {
  it("streams the fake's events in order and ends completed, in $HOME/workspace, without the key", async () => {
    const adapter = new FakeChatAdapter('claude');
    const h = await start(signedInClaude(), adapter);
    const client = await chat(h);
    client.sendJson({ t: 'open' });
    expect(await client.frame('ready')).toEqual({ t: 'ready', session: null, resumed: false });
    client.sendJson({ t: 'prompt', text: 'list the files' });
    const proc = await client.until(() => h.chatProcs[0]);
    proc.line({ type: 'session', id: 'ses_live' });
    proc.line({ type: 'tool', id: 't1', command: 'ls', output: 'a.txt' });
    proc.line({ type: 'text', id: 'm1', text: 'Two files.' });
    proc.line({ type: 'end' });
    proc.exit(0);
    await client.until(() => events(client).find((event) => event['k'] === 'turn_end'));
    expect(await client.frame('session')).toEqual({ t: 'session', id: 'ses_live' });
    expect(events(client).map((event) => event['k'])).toEqual([
      'user',
      'tool_call',
      'tool_result',
      'text',
      'turn_end',
    ]);
    expect(events(client).at(-1)).toEqual({ k: 'turn_end', reason: 'completed' });
    expect(proc.options.env).not.toHaveProperty('MOTIR_TERMINAL_KEY');
    expect(proc.options.env['PATH']).toBe('/usr/bin');
    expect(proc.options.stdin).toBe('list the files');
    expect(h.terminal.chatTurn()).toBeNull();
  });

  it('the chat env is the server env minus the key, with nothing added', () => {
    expect(
      chatEnv({ HOME: '/h', MOTIR_TERMINAL_KEY: 'k', X: undefined, CODEX_HOME: '/c' }),
    ).toEqual({
      HOME: '/h',
      CODEX_HOME: '/c',
    });
  });

  it('refuses not_signed_in when the stat says signed out, spawning nothing; unknown is let through', async () => {
    const signedOut = signedInClaude();
    const h = await start(
      {
        ...signedOut,
        stat: async () => {
          throw new Error('absent');
        },
      },
      new FakeChatAdapter('claude'),
    );
    const client = await chat(h);
    expect(await client.frame('hello')).toMatchObject({ signin: 'signed_out' });
    client.sendJson({ t: 'open' });
    client.sendJson({ t: 'prompt', text: 'hi' });
    expect(await client.frame('error')).toEqual({ t: 'error', code: 'not_signed_in' });
    expect(h.chatProcs).toHaveLength(0);
    await h.terminal.close();

    // kimi pins no credential file: its state is unknown, and it chats.
    const k = await start({}, new FakeChatAdapter('kimi'));
    const kimi = await chat(k);
    expect(await kimi.frame('hello')).toMatchObject({ signin: 'unknown' });
    kimi.sendJson({ t: 'open' });
    kimi.sendJson({ t: 'prompt', text: 'hi' });
    await kimi.until(() => k.chatProcs[0]);
    expect(kimi.frames.filter((frame) => frame['t'] === 'error')).toEqual([]);
  });

  it('allows one running turn per AGENT: the same session and another socket’s session are refused', async () => {
    const h = await start(signedInClaude(), new FakeChatAdapter('claude'));
    const a = await chat(h);
    const b = await chat(h);
    a.sendJson({ t: 'open' });
    a.sendJson({ t: 'prompt', text: 'one' });
    await a.until(() => h.chatProcs[0]);
    a.sendJson({ t: 'prompt', text: 'again' });
    b.sendJson({ t: 'open', session: 'ses_other' });
    await b.frame('history');
    b.sendJson({ t: 'prompt', text: 'two' });
    expect(await a.frame('error')).toEqual({ t: 'error', code: 'turn_running' });
    expect(await b.frame('error')).toEqual({ t: 'error', code: 'turn_running' });
    expect(h.chatProcs).toHaveLength(1);
    expect(h.terminal.chatTurn()).toBe(1);
  });

  it('Stop sends SIGINT, escalates to SIGKILL, and ends the turn stopped', async () => {
    const h = await start(
      { ...signedInClaude(), chatStopGraceMs: 50 },
      new FakeChatAdapter('claude'),
    );
    const client = await chat(h);
    client.sendJson({ t: 'open' });
    client.sendJson({ t: 'prompt', text: 'long job' });
    const proc = await client.until(() => h.chatProcs[0]);
    client.sendJson({ t: 'stop' });
    await client.until(() => events(client).find((event) => event['k'] === 'turn_end'));
    expect(proc.signals).toEqual(['SIGINT', 'SIGKILL']);
    expect(events(client).at(-1)).toEqual({ k: 'turn_end', reason: 'stopped' });
  });

  it('a process exiting mid-turn ends it failed', async () => {
    const h = await start(signedInClaude(), new FakeChatAdapter('claude'));
    const client = await chat(h);
    client.sendJson({ t: 'open' });
    client.sendJson({ t: 'prompt', text: 'go' });
    const proc = await client.until(() => h.chatProcs[0]);
    proc.line({ type: 'text', id: 'm', text: 'half' });
    proc.exit(137);
    const end = await client.until(() => events(client).find((event) => event['k'] === 'turn_end'));
    expect(end).toEqual({ k: 'turn_end', reason: 'failed', code: 'exit_nonzero' });
  });
});

describe('sessions across sockets', () => {
  it('a dropped socket does not stop the turn; a re-open gets history, then the ring, then live events', async () => {
    const adapter = new FakeChatAdapter('claude');
    adapter.history = { events: [{ k: 'user', text: 'yesterday' }], truncated: false };
    const h = await start(signedInClaude(), adapter);
    const first = await chat(h);
    first.sendJson({ t: 'open' });
    first.sendJson({ t: 'prompt', text: 'go' });
    const proc = await first.until(() => h.chatProcs[0]);
    proc.line({ type: 'session', id: 'ses_drop' });
    proc.line({ type: 'text', id: 'm1', text: 'before' });
    await first.until(() => events(first).length === 2);
    first.close();
    await first.closed();
    await first.until(() =>
      h.logs.some((line) => line.startsWith('agent-chat: connection closed')),
    );
    proc.line({ type: 'text', id: 'm2', text: 'while away' });
    expect(proc.signals).toEqual([]);

    const second = await chat(h);
    second.sendJson({ t: 'open', session: 'ses_drop' });
    await second.until(() => events(second).length === 3);
    proc.line({ type: 'text', id: 'm3', text: 'live' });
    proc.line({ type: 'end' });
    proc.exit(0);
    await second.until(() => events(second).find((event) => event['k'] === 'turn_end'));
    expect(second.frames.map((frame) => frame['t'])).toEqual([
      'hello',
      'ready',
      'history',
      'event',
      'event',
      'event',
      'event',
      'event',
    ]);
    expect(second.frames[2]).toEqual({
      t: 'history',
      events: [{ k: 'user', text: 'yesterday' }],
      truncated: false,
    });
    expect(events(second).map((event) => event['delta'] ?? event['k'])).toEqual([
      'user',
      'before',
      'while away',
      'live',
      'turn_end',
    ]);
  });

  it('a later open of a held session sends taken_over to the earlier socket', async () => {
    const h = await start(signedInClaude(), new FakeChatAdapter('claude'));
    const first = await chat(h);
    first.sendJson({ t: 'open', session: 'ses_held' });
    await first.frame('history');
    const second = await chat(h);
    second.sendJson({ t: 'open', session: 'ses_held' });
    expect(await first.frame('error')).toEqual({ t: 'error', code: 'taken_over' });
    expect(await second.frame('ready')).toEqual({ t: 'ready', session: 'ses_held', resumed: true });
  });

  it("reaches the adapter's listSessions and returns the Q4 sessions frame", async () => {
    const adapter = new FakeChatAdapter('claude');
    adapter.sessions = [{ id: 'ses_a', title: 'Fix the build', updatedAt: '2026-09-30T09:00:00Z' }];
    const h = await start(signedInClaude(), adapter);
    const client = await chat(h);
    client.sendJson({ t: 'list' });
    expect(await client.frame('sessions')).toEqual({
      t: 'sessions',
      items: [{ id: 'ses_a', title: 'Fix the build', updatedAt: '2026-09-30T09:00:00Z' }],
    });
  });

  it('pushes a sign-in change to a chat socket, as the terminal does', async () => {
    let signedIn = false;
    const h = await start(
      {
        ...signedInClaude(),
        signInIntervalMs: 30,
        stat: async () => {
          if (!signedIn) throw new Error('absent');
          return { isFile: () => true, size: 10 };
        },
      },
      new FakeChatAdapter('claude'),
    );
    const client = await chat(h);
    expect(await client.frame('hello')).toMatchObject({ signin: 'signed_out' });
    signedIn = true;
    expect(await client.until(() => client.frames.find((f) => f['state'] === 'signed_in'))).toEqual(
      { t: 'signin', profile: 'claude', state: 'signed_in' },
    );
  });
});

describe('the shared shutdown, and what is never logged (Q10)', () => {
  it('close() kills the running turn and drops the chat sockets', async () => {
    const h = await start(signedInClaude(), new FakeChatAdapter('claude'));
    const client = await chat(h);
    client.sendJson({ t: 'open' });
    client.sendJson({ t: 'prompt', text: 'go' });
    const proc = await client.until(() => h.chatProcs[0]);
    await h.terminal.close();
    harness = null;
    expect(proc.signals).toEqual(['SIGKILL']);
    await client.closed();
  });

  it('no log line carries the prompt, a text delta or a tool output', async () => {
    const adapter = new FakeChatAdapter('claude');
    adapter.sessions = [{ id: 'ses_l', title: 'TITLE-MARKER', updatedAt: '2026-09-30T09:00:00Z' }];
    adapter.history = { events: [{ k: 'user', text: 'HISTORY-MARKER' }], truncated: false };
    const h = await start({ ...signedInClaude(), chatStopGraceMs: 20 }, adapter);
    const client = await chat(h);
    client.sendJson({ t: 'list' });
    client.sendJson({ t: 'open', session: 'ses_l' });
    client.sendJson({ t: 'prompt', text: 'PROMPT-MARKER' });
    const proc = await client.until(() => h.chatProcs[0]);
    proc.line({ type: 'text', id: 'm', text: 'DELTA-MARKER' });
    proc.line({ type: 'tool', id: 't', command: 'COMMAND-MARKER', output: 'OUTPUT-MARKER' });
    proc.line('NOT-JSON-MARKER');
    proc.line({ type: 'end' });
    proc.exit(0);
    await client.until(() => events(client).find((event) => event['k'] === 'turn_end'));
    client.sendJson({ t: 'prompt', text: 'SECOND-MARKER' });
    const second = await client.until(() => h.chatProcs[1]);
    client.sendJson({ t: 'stop' });
    await client.until(() => events(client).filter((event) => event['k'] === 'turn_end')[1]);
    expect(second.signals).toContain('SIGINT');
    client.sendJson({ t: 'prompt', text: 'x'.repeat(70_000) });
    await client.frame('error');
    client.close();
    await client.closed();
    await client.until(() =>
      h.logs.some((line) => line.startsWith('agent-chat: connection closed')),
    );

    const all = h.logs.join('\n');
    expect(h.logs.filter((line) => line.startsWith('agent-chat:')).length).toBeGreaterThan(5);
    for (const marker of [
      'PROMPT-MARKER',
      'SECOND-MARKER',
      'DELTA-MARKER',
      'COMMAND-MARKER',
      'OUTPUT-MARKER',
      'NOT-JSON-MARKER',
      'TITLE-MARKER',
      'HISTORY-MARKER',
      'ses_l',
      KEY,
    ]) {
      expect(all).not.toContain(marker);
    }
  });
});
