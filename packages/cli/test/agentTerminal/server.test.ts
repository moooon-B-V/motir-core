import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPLAY_BYTES } from '../../src/agentTerminal/outputRing.js';
import { relayAuthorizationHeader } from '../../src/agentTerminal/relayToken.js';
import { shellCwd, shellEnv } from '../../src/agentTerminal/server.js';
import { Client, INSTANCE, KEY, startHarness, type Harness } from './harness.js';

// The terminal server against a FAKE PTY (MOTIR-6938 ·
// `docs/decisions/agent-terminal.md` Q3, Q4, Q5, Q7, Q8). The fake stands
// behind the same `SpawnPty` interface node-pty is adapted to, so every rule
// here — auth before spawn, frames, sessions, replay, limit, takeover, sign-in
// and log hygiene — is exercised without a compiler; `realPty.test.ts` drives
// the real shell where node-pty is available.

let harness: Harness | null = null;
const clients: Client[] = [];
const temps: string[] = [];

async function start(options: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  harness = await startHarness(options);
  return harness;
}

async function connect(h: Harness, overrides?: Parameters<Harness['connect']>[0]): Promise<Client> {
  const client = await h.connect(overrides);
  clients.push(client);
  return client;
}

/** Open a new session and wait for its `ready`. */
async function openNew(
  h: Harness,
  cols = 80,
  rows = 24,
): Promise<{ client: Client; session: string }> {
  const client = await connect(h);
  client.sendJson({ t: 'open', cols, rows });
  const ready = await client.frame('ready');
  return { client, session: ready['session'] as string };
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await harness?.terminal.close();
  harness = null;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('authentication happens BEFORE anything exists', () => {
  it.each([
    ['no Authorization header', { authorization: null }],
    ['a different scheme', { authorization: 'Bearer abc' }],
    ['a forged signature', { authorization: relayAuthorizationHeader('eyJ9.AAAA') }],
    ['another instance', { instanceId: 'inst_other' }],
    ['another machine', { machineId: 'mach_other' }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 1 }],
  ] as const)('refuses %s, and spawns no PTY', async (_label, overrides) => {
    const h = await start();
    await expect(h.connect(overrides)).rejects.toThrow('refused');
    expect(h.ptys).toHaveLength(0);
    expect(h.terminal.sessionCount()).toBe(0);
  });

  it('refuses a replayed token (the nonce is single-use)', async () => {
    const h = await start();
    const header = relayAuthorizationHeader(h.token());
    const first = await connect(h, { authorization: header });
    expect(first).toBeDefined();
    await expect(h.connect({ authorization: header })).rejects.toThrow('refused');
    expect(h.logs).toContain('agent-terminal: upgrade refused (replayed)');
  });

  it('answers 401 with no body, and logs the reason CODE only', async () => {
    const h = await start();
    const status = await new Promise<number>((resolve) => {
      const req = request({
        port: h.port,
        host: '127.0.0.1',
        path: '/v1/terminal',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': Buffer.alloc(16, 1).toString('base64'),
          Authorization: 'Motir-Relay not-a-token',
        },
      });
      req.on('response', (res) => resolve(res.statusCode ?? 0));
      req.end();
    });
    expect(status).toBe(401);
    expect(h.logs).toEqual([
      expect.stringContaining('listening'),
      'agent-terminal: upgrade refused (malformed)',
    ]);
  });

  it('does not serve /v1/chat yet (reserved), nor plain HTTP', async () => {
    const h = await start();
    const statusOf = (path: string, upgrade: boolean): Promise<number> =>
      new Promise((resolve) => {
        const req = request({
          port: h.port,
          host: '127.0.0.1',
          path,
          headers: upgrade
            ? {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': Buffer.alloc(16, 1).toString('base64'),
                Authorization: relayAuthorizationHeader(h.token()),
              }
            : {},
        });
        req.on('response', (res) => resolve(res.statusCode ?? 0));
        req.end();
      });
    expect(await statusOf('/v1/chat', true)).toBe(404);
    expect(await statusOf('/v1/terminal', false)).toBe(426);
    expect(await statusOf('/', false)).toBe(404);
    expect(h.ptys).toHaveLength(0);
  });
});

describe('failures on the way in', () => {
  it('answers 400 to a non-WebSocket upgrade on the terminal path', async () => {
    const h = await start();
    const status = await new Promise<number>((resolve) => {
      const req = request({
        port: h.port,
        host: '127.0.0.1',
        path: '/v1/terminal?x=1',
        headers: { Connection: 'Upgrade', Upgrade: 'h2c' },
      });
      req.on('response', (res) => resolve(res.statusCode ?? 0));
      req.end();
    });
    expect(status).toBe(400);
  });

  it('closes an authenticated connection that never sends `open`', async () => {
    const h = await start({ openTimeoutMs: 50 });
    const client = await connect(h);
    expect(await client.closed()).toBe(1008);
    expect(h.ptys).toHaveLength(0);
  });

  it('closes with 1011 when the shell cannot start, logging no error text', async () => {
    const h = await start({
      spawnPty: () => {
        throw new Error('posix_spawnp failed: SECRET-PATH');
      },
    });
    const client = await connect(h);
    client.sendJson({ t: 'open', cols: 80, rows: 24 });
    expect(await client.closed()).toBe(1011);
    expect(h.logs).toContain('agent-terminal: shell failed to start');
    expect(h.logs.join('\n')).not.toContain('SECRET-PATH');
    expect(h.terminal.sessionCount()).toBe(0);
  });

  it('ignores a second `open` on an attached connection', async () => {
    const h = await start();
    const { client } = await openNew(h);
    client.sendJson({ t: 'open', cols: 80, rows: 24 });
    client.sendJson({ t: 'ping', active: true });
    await client.frame('pong');
    expect(h.ptys).toHaveLength(1);
    expect(client.frames.filter((frame) => frame['t'] === 'ready')).toHaveLength(1);
  });
});

describe('the wire protocol', () => {
  it('opens a login shell, carries bytes both ways, resizes and pongs', async () => {
    const h = await start();
    const { client, session } = await openNew(h, 120, 40);
    expect(session).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(await client.frame('ready')).toEqual({ t: 'ready', session, resumed: false });

    const [pty] = h.ptys;
    expect(pty!.options.file).toBe('bash');
    expect(pty!.options.args).toEqual(['-l']);
    expect(pty!.sizes[0]).toEqual({ cols: 120, rows: 40 });

    client.sendBytes('echo hi\r');
    await client.until(() => pty!.input === 'echo hi\r');
    pty!.emitData('hi\r\n');
    await client.until(() => client.output().includes('hi\r\n'));

    client.sendJson({ t: 'resize', cols: 100, rows: 30 });
    await client.until(() => pty!.sizes.at(-1)?.cols === 100);
    expect(pty!.sizes.at(-1)).toEqual({ cols: 100, rows: 30 });

    client.sendJson({ t: 'ping', active: true });
    expect(await client.frame('pong')).toEqual({ t: 'pong' });
  });

  it('ignores malformed and unknown control frames without answering', async () => {
    const h = await start();
    const { client } = await openNew(h);
    client.ws.send('not json');
    client.sendJson({ t: 'bogus' });
    client.sendJson({ t: 'resize', cols: 0, rows: 5 });
    client.sendJson({ t: 'ping', active: false });
    await client.frame('pong');
    expect(client.frames.map((frame) => frame['t'])).toEqual(['ready', 'signin', 'pong']);
    expect(h.ptys[0]!.sizes).toHaveLength(1);
  });

  it('sends `exit` and ends the session when the shell exits', async () => {
    const h = await start();
    const { client, session } = await openNew(h);
    h.ptys[0]!.exit(3, null);
    expect(await client.frame('exit')).toEqual({ t: 'exit', code: 3, signal: null });
    await client.closed();
    expect(h.terminal.sessionCount()).toBe(0);
    expect(h.logs).toContain(`agent-terminal: session ${session} exited (code 3)`);
  });
});

describe('sessions survive the connection', () => {
  it('a resume re-attaches the SAME shell and replays its output before live bytes', async () => {
    const h = await start();
    const { client, session } = await openNew(h);
    const pty = h.ptys[0]!;
    pty.emitData('before-drop\r\n');
    await client.until(() => client.output().includes('before-drop'));
    client.close();
    await client.closed();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pty.killed).toBe(false);
    pty.emitData('while-detached\r\n');

    const again = await connect(h);
    again.sendJson({ t: 'open', cols: 90, rows: 20, session });
    expect(await again.frame('ready')).toEqual({ t: 'ready', session, resumed: true });
    await again.until(() => again.output().includes('while-detached'));
    pty.emitData('live\r\n');
    await again.until(() => again.output().includes('live'));

    // The replay is the FIRST binary after `ready`, and holds both chunks.
    const readyAt = again.sequence.findIndex(
      (item) => !Buffer.isBuffer(item) && item['t'] === 'ready',
    );
    const replay = again.sequence[readyAt + 1];
    expect(Buffer.isBuffer(replay)).toBe(true);
    expect((replay as Buffer).toString()).toBe('before-drop\r\nwhile-detached\r\n');
    expect(h.ptys).toHaveLength(1);
    expect(pty.sizes.at(-1)).toEqual({ cols: 90, rows: 20 });
  });

  it('bounds the replay at 256 KiB, keeping the newest bytes', async () => {
    const h = await start();
    const { client, session } = await openNew(h);
    const pty = h.ptys[0]!;
    pty.emitData(Buffer.alloc(REPLAY_BYTES, 'a'));
    pty.emitData('TAIL');
    await client.until(() => client.output().endsWith('TAIL'), 5000);
    client.close();
    await client.closed();

    const again = await connect(h);
    again.sendJson({ t: 'open', cols: 80, rows: 24, session });
    await again.frame('ready');
    const replay = await again.until(() => again.binary[0]);
    expect(replay.length).toBe(REPLAY_BYTES);
    expect(replay.subarray(-4).toString()).toBe('TAIL');
  });

  it('resumes the session a relay token names when `open` carries none', async () => {
    const h = await start();
    const { client, session } = await openNew(h);
    client.close();
    await client.closed();
    const again = await connect(h, { sessionId: session });
    again.sendJson({ t: 'open', cols: 80, rows: 24 });
    expect(await again.frame('ready')).toEqual({ t: 'ready', session, resumed: true });
  });

  it('answers unknown_session for a session it does not hold, and keeps the socket for a fresh open', async () => {
    const h = await start();
    const client = await connect(h);
    client.sendJson({ t: 'open', cols: 80, rows: 24, session: 'not-a-session' });
    expect(await client.frame('error')).toEqual({ t: 'error', code: 'unknown_session' });
    expect(h.ptys).toHaveLength(0);
    client.sendJson({ t: 'open', cols: 80, rows: 24 });
    expect((await client.frame('ready'))['resumed']).toBe(false);
  });

  it('refuses a resume of a session other than the one the token names', async () => {
    const h = await start();
    const { client, session } = await openNew(h);
    client.close();
    await client.closed();
    const again = await connect(h, { sessionId: 'another' });
    again.sendJson({ t: 'open', cols: 80, rows: 24, session });
    expect(await again.frame('error')).toEqual({ t: 'error', code: 'unknown_session' });
  });

  it('a second attach takes the session over; the first gets taken_over', async () => {
    const h = await start();
    const { client: first, session } = await openNew(h);
    const second = await connect(h);
    second.sendJson({ t: 'open', cols: 80, rows: 24, session });
    await second.frame('ready');
    expect(await first.frame('error')).toEqual({ t: 'error', code: 'taken_over' });
    await first.closed();

    h.ptys[0]!.emitData('only-to-second');
    await second.until(() => second.output().includes('only-to-second'));
    expect(first.output()).not.toContain('only-to-second');
    // The old connection's close does not detach the session from the new one.
    second.sendBytes('x');
    await second.until(() => h.ptys[0]!.input === 'x');
  });

  it('holds at most 4: a fifth open reaps the LONGEST-detached session', async () => {
    const h = await start();
    const opened = [];
    for (let i = 0; i < 4; i++) opened.push(await openNew(h));
    // Detach #2 first, then #0 — #2 is the longest-detached.
    opened[2]!.client.close();
    await opened[2]!.client.closed();
    await new Promise((resolve) => setTimeout(resolve, 20));
    opened[0]!.client.close();
    await opened[0]!.client.closed();

    const fifth = await openNew(h);
    expect(fifth.session).not.toBe(opened[2]!.session);
    expect(h.ptys[2]!.killed).toBe(true);
    expect(h.ptys[0]!.killed).toBe(false);
    expect(h.terminal.sessionCount()).toBe(4);
    expect(h.logs).toContain(
      `agent-terminal: session ${opened[2]!.session} reaped (session limit)`,
    );
  });

  it('refuses a fifth open with session_limit when all four are attached', async () => {
    const h = await start();
    for (let i = 0; i < 4; i++) await openNew(h);
    const fifth = await connect(h);
    fifth.sendJson({ t: 'open', cols: 80, rows: 24 });
    expect(await fifth.frame('error')).toEqual({ t: 'error', code: 'session_limit' });
    await fifth.closed();
    expect(h.ptys).toHaveLength(4);
  });
});

describe('the sign-in state (stat only, pushed on attach and on change)', () => {
  function claudeEnv(): { env: NodeJS.ProcessEnv; credential: string } {
    const home = mkdtempSync(join(tmpdir(), 'motir-term-'));
    temps.push(home);
    const configDir = join(home, 'claude-config');
    mkdirSync(configDir);
    return {
      env: { HOME: home, MOTIR_SANDBOX_AGENT: 'claude', CLAUDE_CONFIG_DIR: configDir },
      credential: join(configDir, '.credentials.json'),
    };
  }

  it('pushes signed_out on attach, then signed_in once the file appears — without a reload', async () => {
    const { env, credential } = claudeEnv();
    const h = await start({ env, signInIntervalMs: 50 });
    const { client } = await openNew(h);
    expect(await client.frame('signin')).toEqual({
      t: 'signin',
      profile: 'claude',
      state: 'signed_out',
    });
    writeFileSync(credential, '{"x":1}');
    expect(await client.frame('signin', 1)).toEqual({
      t: 'signin',
      profile: 'claude',
      state: 'signed_in',
    });
    // Only on CHANGE: a further tick with the same state pushes nothing.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.frames.filter((frame) => frame['t'] === 'signin')).toHaveLength(2);
  });

  it('never opens the credential: the check is a stat', async () => {
    const { env } = claudeEnv();
    const seen: string[] = [];
    const h = await start({
      env,
      stat: async (path) => {
        seen.push(path);
        return { isFile: () => true, size: 10 };
      },
    });
    const { client } = await openNew(h);
    expect(await client.frame('signin')).toEqual({
      t: 'signin',
      profile: 'claude',
      state: 'signed_in',
    });
    expect(seen).toEqual([join(env['CLAUDE_CONFIG_DIR']!, '.credentials.json')]);
  });

  it('answers unknown for a profile with no credential file', async () => {
    const h = await start({ env: { HOME: '/nonexistent', MOTIR_SANDBOX_AGENT: 'goose' } });
    const { client } = await openNew(h);
    expect(await client.frame('signin')).toEqual({
      t: 'signin',
      profile: 'goose',
      state: 'unknown',
    });
  });

  it('stops polling when nothing is attached', async () => {
    let calls = 0;
    const h = await start({
      signInIntervalMs: 20,
      stat: async () => {
        calls++;
        throw new Error('absent');
      },
      env: { HOME: '/h', MOTIR_SANDBOX_AGENT: 'codex' },
    });
    const { client } = await openNew(h);
    await client.frame('signin');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBeGreaterThan(1);
    client.close();
    await client.closed();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = calls;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBe(after);
  });
});

describe('what the shell gets', () => {
  it('the server env minus MOTIR_TERMINAL_KEY, with the terminal type — and nothing added about sign-in', () => {
    const env = shellEnv({
      HOME: '/home/node',
      MOTIR_TERMINAL_KEY: KEY,
      MOTIR_INSTANCE_ID: INSTANCE,
      CLAUDE_CONFIG_DIR: '/c',
      TERM: 'dumb',
    });
    expect(env).toEqual({
      HOME: '/home/node',
      MOTIR_INSTANCE_ID: INSTANCE,
      CLAUDE_CONFIG_DIR: '/c',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    });
    expect(Object.keys(env)).not.toContain('ANTHROPIC_API_KEY');
  });

  it('starts in $HOME/workspace, or $HOME before the workspace exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'motir-home-'));
    temps.push(home);
    expect(shellCwd({ HOME: home })).toBe(home);
    mkdirSync(join(home, 'workspace'));
    expect(shellCwd({ HOME: home })).toBe(join(home, 'workspace'));
  });

  it('spawns with that env and cwd', async () => {
    const home = mkdtempSync(join(tmpdir(), 'motir-home-'));
    temps.push(home);
    mkdirSync(join(home, 'workspace'));
    const h = await start({ env: { HOME: home, MOTIR_TERMINAL_KEY: KEY } });
    await openNew(h);
    expect(h.ptys[0]!.options.cwd).toBe(join(home, 'workspace'));
    expect(h.ptys[0]!.options.env['MOTIR_TERMINAL_KEY']).toBeUndefined();
  });
});

describe('the WebSocket layer refuses protocol violations', () => {
  it('closes with 1002 on an UNMASKED client frame', async () => {
    const h = await start();
    const socket = netConnect(h.port, '127.0.0.1');
    const received: Buffer[] = [];
    socket.on('data', (chunk) => received.push(chunk));
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(
      [
        'GET /v1/terminal HTTP/1.1',
        'Host: x',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${Buffer.alloc(16, 2).toString('base64')}`,
        `Authorization: ${relayAuthorizationHeader(h.token())}`,
        '',
        '',
      ].join('\r\n'),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.write(Buffer.from([0x82, 0x02, 0x41, 0x42])); // binary, unmasked
    await new Promise((resolve) => socket.once('close', resolve));
    const all = Buffer.concat(received);
    const head = all.indexOf('\r\n\r\n') + 4;
    expect(all.subarray(0, 12).toString()).toBe('HTTP/1.1 101');
    // A close frame carrying 1002.
    expect([...all.subarray(head, head + 4)]).toEqual([0x88, 0x02, 0x03, 0xea]);
    expect(h.ptys).toHaveLength(0);
  });
});

describe('no stream byte reaches the logs (Q8)', () => {
  it('a marker typed, echoed, replayed and exited through the PTY never appears in the log lines', async () => {
    const MARKER = 'MARKER-6938-do-not-log';
    const h = await start({
      env: { HOME: '/h', MOTIR_TERMINAL_KEY: KEY, MOTIR_SANDBOX_AGENT: 'claude' },
    });
    const { client, session } = await openNew(h);
    client.sendBytes(`echo ${MARKER}\r`);
    await client.until(() => client.output().includes(MARKER));
    client.sendJson({ t: 'resize', cols: 81, rows: 25, marker: MARKER });
    client.ws.send(`{"t":"${MARKER}"}`);
    client.close();
    await client.closed();
    const again = await connect(h);
    again.sendJson({ t: 'open', cols: 80, rows: 24, session });
    await again.until(() => again.output().includes(MARKER));
    h.ptys[0]!.emitData(MARKER);
    h.ptys[0]!.exit(0, null);
    await again.frame('exit');
    const token = h.token();
    await expect(h.connect({ authorization: `Motir-Relay ${token}x` })).rejects.toThrow();

    const logged = h.logs.join('\n');
    expect(h.logs.length).toBeGreaterThan(5);
    expect(logged).not.toContain(MARKER);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(KEY);
  });
});
