import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OutputRing, REPLAY_BYTES } from '../../src/agentTerminal/outputRing.js';
import { encodeServerFrame, parseClientFrame } from '../../src/agentTerminal/protocol.js';
import { checkSignIn, credentialDirsFromEnv } from '../../src/agentTerminal/signIn.js';
import { loadNodePty } from '../../src/agentTerminal/pty.js';

// The terminal server's pure parts (MOTIR-6938): the replay ring, the control
// frame codec, the sign-in check per profile, and the node-pty loader's
// absent-module answer.

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'motir-signin-'));
  temps.push(home);
  return home;
}

describe('OutputRing', () => {
  it('is 256 KiB by default', () => {
    expect(REPLAY_BYTES).toBe(262144);
  });

  it('holds everything until full, then the newest bytes in order', () => {
    const ring = new OutputRing(8);
    ring.push(Buffer.from('abc'));
    expect(ring.snapshot().toString()).toBe('abc');
    ring.push(Buffer.from('defgh'));
    expect(ring.snapshot().toString()).toBe('abcdefgh');
    ring.push(Buffer.from('ij'));
    expect(ring.snapshot().toString()).toBe('cdefghij');
    ring.push(Buffer.from('klmno'));
    expect(ring.snapshot().toString()).toBe('hijklmno');
    expect(ring.size).toBe(8);
  });

  it('wraps a chunk that straddles the end of the buffer', () => {
    const ring = new OutputRing(4);
    ring.push(Buffer.from('abc'));
    ring.push(Buffer.from('de'));
    expect(ring.snapshot().toString()).toBe('bcde');
    ring.push(Buffer.from('fgh'));
    expect(ring.snapshot().toString()).toBe('efgh');
  });

  it('keeps only the tail of a chunk larger than itself', () => {
    const ring = new OutputRing(4);
    ring.push(Buffer.from('x'));
    ring.push(Buffer.from('123456'));
    expect(ring.snapshot().toString()).toBe('3456');
    ring.push(Buffer.from('7'));
    expect(ring.snapshot().toString()).toBe('4567');
  });

  it('is empty before any output', () => {
    expect(new OutputRing(4).snapshot()).toHaveLength(0);
  });
});

describe('the control frame codec', () => {
  it.each([
    ['{"t":"open","cols":80,"rows":24}', { t: 'open', cols: 80, rows: 24 }],
    [
      '{"t":"open","cols":80,"rows":24,"session":"s"}',
      { t: 'open', cols: 80, rows: 24, session: 's' },
    ],
    ['{"t":"open","cols":80,"rows":24,"session":null}', { t: 'open', cols: 80, rows: 24 }],
    ['{"t":"open","cols":80,"rows":24,"session":""}', { t: 'open', cols: 80, rows: 24 }],
    ['{"t":"resize","cols":1,"rows":1000}', { t: 'resize', cols: 1, rows: 1000 }],
    ['{"t":"ping","active":true}', { t: 'ping', active: true }],
    ['{"t":"ping"}', { t: 'ping', active: false }],
  ])('parses %s', (text, frame) => {
    expect(parseClientFrame(text)).toEqual(frame);
  });

  it.each([
    'nope',
    'null',
    '[]',
    '{"t":"auth","ticket":"x"}',
    '{"t":"open","cols":0,"rows":24}',
    '{"t":"open","cols":80.5,"rows":24}',
    '{"t":"open","cols":80,"rows":1001}',
    '{"t":"open","cols":80,"rows":24,"session":5}',
    '{"t":"resize","cols":"80","rows":24}',
  ])('rejects %s', (text) => {
    expect(parseClientFrame(text)).toBeNull();
  });

  it('encodes server frames as compact JSON', () => {
    expect(encodeServerFrame({ t: 'ready', session: 's', resumed: false })).toBe(
      '{"t":"ready","session":"s","resumed":false}',
    );
  });
});

describe('the sign-in check — stat only, three states', () => {
  it('claude: $CLAUDE_CONFIG_DIR/.credentials.json', async () => {
    const home = tempHome();
    const dir = join(home, 'cfg');
    mkdirSync(dir);
    const env = { HOME: home, MOTIR_SANDBOX_AGENT: 'claude', CLAUDE_CONFIG_DIR: dir };
    expect(await checkSignIn(env)).toEqual({ profile: 'claude', state: 'signed_out' });
    writeFileSync(join(dir, '.credentials.json'), '');
    // An EMPTY file is not a sign-in.
    expect(await checkSignIn(env)).toEqual({ profile: 'claude', state: 'signed_out' });
    writeFileSync(join(dir, '.credentials.json'), '{}');
    expect(await checkSignIn(env)).toEqual({ profile: 'claude', state: 'signed_in' });
  });

  it('codex: $CODEX_HOME/auth.json — and a DIRECTORY there is not a sign-in', async () => {
    const home = tempHome();
    const env = { HOME: home, MOTIR_SANDBOX_AGENT: 'codex', CODEX_HOME: join(home, 'cx') };
    mkdirSync(join(home, 'cx', 'auth.json'), { recursive: true });
    expect(await checkSignIn(env)).toEqual({ profile: 'codex', state: 'signed_out' });
    rmSync(join(home, 'cx', 'auth.json'), { recursive: true });
    writeFileSync(join(home, 'cx', 'auth.json'), '{}');
    expect(await checkSignIn(env)).toEqual({ profile: 'codex', state: 'signed_in' });
  });

  it('opencode: $XDG_DATA_HOME/opencode/auth.json, defaulting to ~/.local/share', async () => {
    const home = tempHome();
    const env = { HOME: home, MOTIR_SANDBOX_AGENT: 'opencode' };
    expect(await checkSignIn(env)).toEqual({ profile: 'opencode', state: 'signed_out' });
    mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.local', 'share', 'opencode', 'auth.json'), '{}');
    expect(await checkSignIn(env)).toEqual({ profile: 'opencode', state: 'signed_in' });
    expect(await checkSignIn({ ...env, XDG_DATA_HOME: join(home, 'elsewhere') })).toEqual({
      profile: 'opencode',
      state: 'signed_out',
    });
  });

  // MOTIR-7053: an API-key sign-in leaves no credential file, so the header
  // read "Not signed in" while the agent's Chat worked on that same key.
  it('claude: a set ANTHROPIC_API_KEY is a sign-in with no credentials file', async () => {
    const env = { HOME: tempHome(), MOTIR_SANDBOX_AGENT: 'claude' };
    expect(await checkSignIn({ ...env, ANTHROPIC_API_KEY: 'sk-test-not-real' })).toEqual({
      profile: 'claude',
      state: 'signed_in',
    });
    // An EMPTY variable is not a sign-in, exactly as an empty file is not.
    expect(await checkSignIn({ ...env, ANTHROPIC_API_KEY: '' })).toEqual({
      profile: 'claude',
      state: 'signed_out',
    });
  });

  it('codex: a set OPENAI_API_KEY is a sign-in with no auth.json', async () => {
    const env = { HOME: tempHome(), MOTIR_SANDBOX_AGENT: 'codex', OPENAI_API_KEY: 'sk-x' };
    expect(await checkSignIn(env)).toEqual({ profile: 'codex', state: 'signed_in' });
  });

  it('a profile whose only credential is a variable: signed in when it is set', async () => {
    const home = tempHome();
    expect(
      await checkSignIn({ HOME: home, MOTIR_SANDBOX_AGENT: 'aider', OPENAI_API_KEY: 'k' }),
    ).toEqual({ profile: 'aider', state: 'signed_in' });
    expect(
      await checkSignIn({ HOME: home, MOTIR_SANDBOX_AGENT: 'cursor', CURSOR_API_KEY: 'k' }),
    ).toEqual({ profile: 'cursor', state: 'signed_in' });
  });

  it('a set variable answers without a stat — the check never reaches the disk', async () => {
    const stat = (): never => {
      throw new Error('stat must not be called');
    };
    expect(
      await checkSignIn(
        { HOME: '/h', MOTIR_SANDBOX_AGENT: 'claude', ANTHROPIC_API_KEY: 'k' },
        stat,
      ),
    ).toEqual({ profile: 'claude', state: 'signed_in' });
  });

  it.each(['kimi', 'aider', 'goose'])('%s pins no file: unknown (can’t tell)', async (profile) => {
    expect(await checkSignIn({ HOME: tempHome(), MOTIR_SANDBOX_AGENT: profile })).toEqual({
      profile,
      state: 'unknown',
    });
  });

  it('no profile, or one Motir does not know: unknown', async () => {
    expect(await checkSignIn({ HOME: '/h' })).toEqual({ profile: null, state: 'unknown' });
    expect(await checkSignIn({ HOME: '/h', MOTIR_SANDBOX_AGENT: 'base' })).toEqual({
      profile: 'base',
      state: 'unknown',
    });
  });

  it('resolves the credential dirs from the environment', () => {
    const dirs = credentialDirsFromEnv({ HOME: '/h', XDG_CONFIG_HOME: '/x', CODEX_HOME: '/c' });
    expect(dirs.home).toBe('/h');
    expect(dirs.xdgConfigHome).toBe('/x');
    expect(dirs.xdgDataHome).toBe('/h/.local/share');
    expect(dirs.configHome('CODEX_HOME')).toBe('/c');
    expect(dirs.configHome('CLAUDE_CONFIG_DIR')).toBeUndefined();
  });
});

describe('loadNodePty', () => {
  it('answers null where the image directory is absent', () => {
    expect(loadNodePty(join(tmpdir(), 'no-such-motir-terminal'))).toBeNull();
  });

  it('answers null where the module is present but cannot load', () => {
    const dir = tempHome();
    mkdirSync(join(dir, 'node_modules', 'node-pty'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'node-pty', 'package.json'), '{"main":"missing.js"}');
    expect(loadNodePty(dir)).toBeNull();
  });
});
