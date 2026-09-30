import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_TERMINAL_MODULE_DIR,
  TERMINAL_MODULE_DIR_ENV,
  loadNodePty,
} from '../../src/agentTerminal/pty.js';
import { Client, KEY, startHarness, type Harness } from './harness.js';

// The terminal server on a REAL PTY and a real `bash -l` (MOTIR-6938).
//
// node-pty is not a dependency of `@motir/cli` (`docs/decisions/agent-terminal.md`
// Q4), so this suite runs only where one is built: inside the agent image
// (`/opt/motir-terminal`), or wherever MOTIR_TERMINAL_MODULE_DIR points — e.g.
// `npm install --prefix <dir> node-pty@1.1.0` with a C++ toolchain. Everywhere
// else it SKIPS, and `server.test.ts` covers every rule against the fake PTY.

const moduleDir = process.env[TERMINAL_MODULE_DIR_ENV]?.trim() || DEFAULT_TERMINAL_MODULE_DIR;
const spawnPty = loadNodePty(moduleDir);

describe.skipIf(spawnPty === null)('a real login shell on node-pty', () => {
  let harness: Harness;
  let home: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'motir-realpty-'));
    mkdirSync(join(home, 'workspace'));
    // Inside a Motir sandbox (where this suite is most often run) the login
    // shell's /etc/profile.d hook runs the one-time agent-config setup for a
    // HOME that has never had it — a codegraph index of /workspace that takes
    // minutes. Its own sentinel says "already done" for this throwaway HOME.
    mkdirSync(join(home, '.motir-sandbox', 'agent-config'), { recursive: true });
    writeFileSync(join(home, '.motir-sandbox', 'agent-config', '.setup-done'), '');
    harness = await startHarness({
      spawnPty: spawnPty!,
      env: {
        ...process.env,
        HOME: home,
        MOTIR_TERMINAL_KEY: KEY,
        MOTIR_SANDBOX_AGENT: 'claude',
        CLAUDE_CONFIG_DIR: join(home, 'cfg'),
      },
    });
  });

  afterAll(async () => {
    await harness?.terminal.close();
    rmSync(home, { recursive: true, force: true });
  });

  /** Type a command and wait for a unique end marker in the output. */
  async function run(client: Client, command: string, marker: string): Promise<string> {
    const before = client.output().length;
    client.sendBytes(`${command}; echo ${marker}-$((1+1))\r`);
    await client
      .until(() => client.output().slice(before).includes(`${marker}-2`), 10_000)
      .catch((err: unknown) => {
        throw new Error(
          `${String(err)}; output so far: ${JSON.stringify(client.output().slice(-400))}`,
        );
      });
    return client.output().slice(before);
  }

  it('is a login shell as this user in $HOME/workspace, without the key, that resizes and survives a drop', async () => {
    const client = await harness.connect();
    client.sendJson({ t: 'open', cols: 80, rows: 24 });
    const session = (await client.frame('ready'))['session'] as string;
    expect(await client.frame('signin')).toEqual({
      t: 'signin',
      profile: 'claude',
      state: 'signed_out',
    });

    const facts = await run(
      client,
      'pwd; id -un; shopt -q login_shell && echo IS-LOGIN; echo KEY=${MOTIR_TERMINAL_KEY:-absent} TERM=$TERM CT=$COLORTERM',
      'FACTS',
    );
    expect(facts).toContain(join(home, 'workspace'));
    expect(facts).toContain(userInfo().username);
    expect(facts).toContain('IS-LOGIN');
    expect(facts).toContain('KEY=absent TERM=xterm-256color CT=truecolor');

    client.sendJson({ t: 'resize', cols: 100, rows: 30 });
    expect(await run(client, 'stty size', 'SIZE')).toContain('30 100');

    await run(client, 'export KEPT=still-here-6938', 'SET');
    const pid = await run(client, 'echo PID=$$', 'PID');
    const shellPid = Number(/PID=(\d+)/.exec(pid)![1]);
    client.close();
    await client.closed();

    const again = await harness.connect();
    again.sendJson({ t: 'open', cols: 100, rows: 30, session });
    expect(await again.frame('ready')).toEqual({ t: 'ready', session, resumed: true });
    // The replay carries what was on screen before the drop.
    await again.until(
      () => again.output().includes('still-here') || again.output().includes('SET-2'),
    );
    expect(await run(again, 'echo VAR=$KEPT', 'VAR')).toContain('VAR=still-here-6938');
    expect(await run(again, 'echo PID=$$', 'PID2')).toContain(`PID=${shellPid}`);

    again.sendBytes('exit\r');
    expect(await again.frame('exit')).toMatchObject({ t: 'exit', code: 0 });
    expect(() => process.kill(shellPid, 0)).toThrow();
  }, 60_000);
});
