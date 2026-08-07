import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultDoctorProbe,
  doctorCommand,
  firstLine,
  probeAgentVersion,
  probeServerWith,
  resolveOnPath,
  type ReadOnlyServerClient,
} from '../src/commands/doctor.js';
import { AuthError } from '../src/errors.js';
import type { WhoamiResult } from '../src/client.js';

const WHOAMI: WhoamiResult = {
  user: { id: 'u1', name: 'Yue', email: 'yue@example.com' },
  workspace: { id: 'w1', name: 'moooon', slug: 'moooon' },
};

/** How many work items the probed project holds. A COUNT since MOTIR-2319: the
 *  probe used to run a `limit: 1` search and read its total. */
const PROJECT_COUNT = 42;

/** A read-only client that records every method the probe reaches for. */
function spyClient(over: Partial<ReadOnlyServerClient> = {}): {
  client: ReadOnlyServerClient;
  calls: string[];
} {
  const calls: string[] = [];
  const client: ReadOnlyServerClient = {
    whoami: async () => {
      calls.push('whoami');
      return WHOAMI;
    },
    countWorkItems: async () => {
      calls.push('countWorkItems');
      return PROJECT_COUNT;
    },
    ...over,
  };
  return { client, calls };
}

describe('probeServerWith — read-only by construction', () => {
  it('identifies the user and proves the project is reachable', async () => {
    const { client, calls } = spyClient();
    const result = await probeServerWith(client, 'MOTIR');
    expect(result.ok).toBe(true);
    expect(result.user).toEqual({ name: 'Yue', email: 'yue@example.com' });
    expect(result.workspace).toEqual({ name: 'moooon', slug: 'moooon' });
    expect(result.project).toEqual({ key: 'MOTIR', reachable: true, total: 42 });
    // The whole call list, pinned: two READS. No dispatch, no transition, no
    // write — `doctor` may never mutate server state. (It used to open with a
    // `connect` and a `listToolNames` and end with a `close`; all three went
    // with the MCP transport in 11.5.6, and `whoami` is now the probe.)
    expect(calls).toEqual(['whoami', 'countWorkItems']);
  });

  it('skips the project read when there is no linked project', async () => {
    const { client, calls } = spyClient();
    const result = await probeServerWith(client);
    expect(result.project).toBeUndefined();
    expect(calls).not.toContain('countWorkItems');
  });

  it('reports a token with no active workspace', async () => {
    const { client } = spyClient({
      whoami: async () => ({ user: WHOAMI.user, workspace: null }),
    });
    await expect(probeServerWith(client)).resolves.toMatchObject({ ok: true, workspace: null });
  });

  it('describes a non-Error rejection without crashing', async () => {
    const { client } = spyClient({
      whoami: async () => {
        throw 'transport exploded';
      },
    });
    await expect(probeServerWith(client)).resolves.toEqual({
      ok: false,
      error: { message: 'transport exploded' },
    });
  });

  it('reports a project the token cannot reach without failing the handshake', async () => {
    const { client } = spyClient({
      countWorkItems: async () => {
        throw new Error('PROJECT_NOT_FOUND');
      },
    });
    const result = await probeServerWith(client, 'NOPE');
    expect(result.ok).toBe(true);
    expect(result.project).toEqual({
      key: 'NOPE',
      reachable: false,
      error: 'PROJECT_NOT_FOUND',
    });
  });

  it('captures a rejected credential as a red row, carrying the CliError hint', async () => {
    const { client, calls } = spyClient({
      whoami: async () => {
        throw new AuthError();
      },
    });
    const result = await probeServerWith(client, 'MOTIR');
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('Token invalid or expired');
    expect(result.error?.hint).toContain('motir auth login');
    // Nothing was attempted after the probe failed — in particular the project
    // count, which would report a second red row about the same one problem.
    // (`whoami` itself is the OVERRIDE here, so it never reaches the recorder.)
    expect(calls).toEqual([]);
  });

  it('captures a mid-probe network failure as a red row rather than throwing', async () => {
    const { client } = spyClient({
      whoami: async () => {
        throw new Error('network reset');
      },
    });
    const result = await probeServerWith(client, 'MOTIR');
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('network reset');
  });
});

describe('resolveOnPath', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'motir-doctor-path-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeExecutable(name: string, body = '#!/bin/sh\necho "fake 1.2.3"\n'): string {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    return path;
  }

  it('finds an executable on PATH', () => {
    const path = writeExecutable('fake-agent');
    expect(resolveOnPath('fake-agent', { PATH: dir })).toBe(path);
  });

  it('returns null when the binary is absent', () => {
    expect(resolveOnPath('definitely-not-here', { PATH: dir })).toBeNull();
  });

  it('returns null for a non-executable file of the right name', () => {
    writeFileSync(join(dir, 'not-exec'), 'hi');
    chmodSync(join(dir, 'not-exec'), 0o644);
    expect(resolveOnPath('not-exec', { PATH: dir })).toBeNull();
  });

  it('ignores a DIRECTORY that shares the binary’s name', () => {
    mkdirSync(join(dir, 'shadow'));
    expect(resolveOnPath('shadow', { PATH: dir })).toBeNull();
  });

  it('checks an explicit path directly instead of scanning PATH', () => {
    const path = writeExecutable('direct-agent');
    expect(resolveOnPath(path, { PATH: '' })).toBe(path);
    expect(resolveOnPath(join(dir, 'missing-agent'), { PATH: dir })).toBeNull();
  });

  it('tolerates an empty / unset PATH', () => {
    expect(resolveOnPath('anything', {})).toBeNull();
  });

  it('tries each PATHEXT suffix on Windows', () => {
    // The bare name does not exist; only `<name>.CMD` does — so a hit proves
    // the extension candidates were tried.
    const path = writeExecutable('win-agent.CMD');
    expect(resolveOnPath('win-agent', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(path);
    expect(resolveOnPath('win-agent', { PATH: dir }, 'win32')).toBe(path);
    expect(resolveOnPath('win-agent', { PATH: dir }, 'linux')).toBeNull();
  });
});

describe('probeAgentVersion', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'motir-doctor-version-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function script(name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    return path;
  }

  it('takes the first line of the version output', async () => {
    const path = script('ok-agent', '#!/bin/sh\necho "fake-agent 9.9.9"\necho "extra line"\n');
    await expect(probeAgentVersion(path)).resolves.toEqual({ version: 'fake-agent 9.9.9' });
  });

  it('reads a version printed on stderr', async () => {
    const path = script('stderr-agent', '#!/bin/sh\necho "v2 (stderr)" >&2\n');
    await expect(probeAgentVersion(path)).resolves.toEqual({ version: 'v2 (stderr)' });
  });

  it('reports an error for a non-zero exit', async () => {
    const path = script('bad-agent', '#!/bin/sh\nexit 3\n');
    const result = await probeAgentVersion(path);
    expect(result.version).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  it('reports an error when the agent answers with nothing at all', async () => {
    const path = script('silent-agent', '#!/bin/sh\nexit 0\n');
    await expect(probeAgentVersion(path)).resolves.toEqual({ error: 'no output' });
  });
});

describe('firstLine', () => {
  it('returns a single-line message unchanged, trimmed', () => {
    expect(firstLine('  claude 1.4.2  ')).toBe('claude 1.4.2');
  });
  it('keeps only the first line of a chatty one', () => {
    expect(firstLine('claude 1.4.2\nupdate available\n')).toBe('claude 1.4.2');
  });
});

describe('doctorCommand', () => {
  const savedExitCode = process.exitCode;
  let stdout: string;
  let write: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = '';
    write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
  });
  afterEach(() => {
    write.mockRestore();
    process.exitCode = savedExitCode;
  });

  /** The minimum probe shape: everything red, so the exit code is exercised. */
  function emptyProbe() {
    return {
      findLink: () => null,
      resolveServerUrl: () => 'https://motir.test',
      credentialOrigin: () => null,
      probeServer: async () => ({ ok: false as const }),
      resolveRepos: () => [],
      probeAgent: async () => ({ onPath: false }),
      configuredAgentCommand: () => undefined,
      agentEnvOverride: () => undefined,
      pathExists: () => false,
      hasEnv: () => false,
      home: () => '/home/tester',
      xdgConfigHome: () => '/home/tester/.config',
      xdgDataHome: () => '/home/tester/.local/share',
    };
  }

  it('prints the human report and sets a non-zero exit code on a failure', async () => {
    await doctorCommand({}, emptyProbe());
    expect(stdout).toContain('motir doctor — BYOK preflight');
    expect(stdout).toContain('FAIL  Project link');
    expect(process.exitCode).toBe(1);
  });

  it('emits the same result machine-readably with --json', async () => {
    await doctorCommand({ json: true }, emptyProbe());
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      checks: { id: string; status: string; remediation?: string }[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.map((c) => c.id)).toEqual([
      'link',
      'auth',
      'project',
      'repos',
      'agent',
      'credential',
    ]);
    // Every non-passing row carries something actionable.
    for (const check of parsed.checks.filter((c) => c.status !== 'pass')) {
      expect(check.remediation).toBeTruthy();
    }
    expect(stdout).not.toContain('BYOK preflight');
  });

  it('--json names the credential SOURCE and never carries the token (MOTIR-1876)', async () => {
    await doctorCommand(
      { json: true },
      {
        ...emptyProbe(),
        credentialOrigin: () => 'environment (MOTIR_TOKEN)',
        probeServer: async () => ({
          ok: true as const,
          toolCount: 1,
          user: { name: 'Yue', email: 'yue@example.com' },
        }),
      },
    );

    const parsed = JSON.parse(stdout) as { checks: { id: string; detail?: string }[] };
    const auth = parsed.checks.find((c) => c.id === 'auth');
    expect(auth?.detail).toContain('via environment (MOTIR_TOKEN)');
    // The probe returns an ORIGIN, never a value — so no token can reach the
    // machine-readable output even by accident.
    expect(stdout).not.toContain('pat_');
  });

  it('leaves the exit code at zero when only warnings are reported', async () => {
    await doctorCommand(
      {},
      {
        ...emptyProbe(),
        findLink: () => ({
          dir: '/work',
          path: '/work/.motir.json',
          config: { serverUrl: 'https://motir.test', workspace: 'moooon', project: 'MOTIR' },
        }),
        credentialOrigin: () => '/home/tester/.config/motir/config.json',
        probeServer: async () => ({
          ok: true as const,
          toolCount: 1,
          user: { name: 'Yue', email: 'yue@example.com' },
          workspace: { name: 'moooon', slug: 'moooon' },
          project: { key: 'MOTIR', reachable: true, total: 1 },
        }),
      },
    );
    expect(stdout).toContain('WARN  Coding agent');
    expect(process.exitCode).toBe(0);
  });
});

describe('the real probe, against a temp home', () => {
  // Restore the touched keys INDIVIDUALLY — reassigning `process.env` wholesale
  // detaches it from the native environment, and `os.homedir()` reads that, so
  // the next test would keep seeing a stale HOME.
  const TOUCHED = [
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'MOTIR_CONFIG_HOME',
    'PATH',
    'MOTIR_AGENT',
  ] as const;
  const savedEnv = new Map(TOUCHED.map((key) => [key, process.env[key]]));
  const savedExitCode = process.exitCode;
  let home: string;
  let bin: string;
  let stdout: string;
  let write: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'motir-doctor-home-'));
    bin = join(home, 'bin');
    mkdirSync(bin);
    // A credential directory holding a secret the report must never surface.
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', 'credentials.json'), '{"key":"sk-do-not-print-me"}');
    const agent = join(bin, 'claude');
    writeFileSync(agent, '#!/bin/sh\necho "claude 1.4.2"\n');
    chmodSync(agent, 0o755);
    process.env['HOME'] = home;
    process.env['XDG_CONFIG_HOME'] = join(home, '.config');
    process.env['MOTIR_CONFIG_HOME'] = join(home, '.config');
    process.env['PATH'] = bin;
    process.env['MOTIR_AGENT'] = 'claude --dangerously-skip-permissions';
    stdout = '';
    write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    write.mockRestore();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.exitCode = savedExitCode;
    rmSync(home, { recursive: true, force: true });
  });

  it('reads the credential store + repo overrides through the real config layer', async () => {
    const probe = defaultDoctorProbe();
    const configDir = join(home, '.config', 'motir');
    mkdirSync(configDir, { recursive: true });

    expect(probe.credentialOrigin('https://motir.test')).toBeNull();
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        tokens: { 'https://motir.test': { token: 'pat-secret' } },
        agentCommand: 'codex --full-auto',
      }),
    );
    // Present, and NAMED by its origin — the real config path, so the doctor row
    // can say where the credential came from without ever opening it.
    expect(probe.credentialOrigin('https://motir.test/')).toBe(join(configDir, 'config.json'));
    expect(probe.configuredAgentCommand()).toBe('codex --full-auto');

    // A repo override resolves relative to the link root; a convention repo is
    // not listed (only overrides are enumerated).
    expect(
      probe.resolveRepos({
        dir: home,
        path: join(home, '.motir.json'),
        config: {
          serverUrl: 'https://motir.test',
          workspace: 'moooon',
          project: 'MOTIR',
          repos: { 'motir-core': 'checkouts/core' },
        },
      }),
    ).toEqual([
      {
        repoName: 'motir-core',
        path: join(home, 'checkouts', 'core'),
        source: 'override',
        exists: false,
      },
    ]);
  });

  it('reports an unreachable server as a red row rather than throwing', async () => {
    const probe = defaultDoctorProbe();
    const configDir = join(home, '.config', 'motir');
    mkdirSync(configDir, { recursive: true });

    // No stored token → the probe answers without opening a connection at all.
    await expect(probe.probeServer({ serverUrl: 'https://motir.test' })).resolves.toEqual({
      ok: false,
      error: { message: 'Not logged in to https://motir.test.' },
    });

    // With a token, it really tries — and a dead endpoint is a captured error.
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ tokens: { 'http://127.0.0.1:1': { token: 'pat' } } }),
    );
    const result = await probe.probeServer({
      serverUrl: 'http://127.0.0.1:1',
      projectKey: 'MOTIR',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('127.0.0.1:1');
  });

  it('finds the real agent binary + credential dir, and prints NO secret', async () => {
    const probe = defaultDoctorProbe();
    expect(probe.home()).toBe(home);
    expect(probe.agentEnvOverride()).toBe('claude --dangerously-skip-permissions');
    expect(probe.configuredAgentCommand()).toBeUndefined();
    expect(probe.hasEnv('MOTIR_AGENT')).toBe(true);
    expect(probe.hasEnv('DEFINITELY_UNSET_VAR')).toBe(false);
    expect(probe.pathExists(join(home, '.claude'))).toBe(true);

    // Report against the real filesystem probe (no server: the temp config home
    // holds no token, so the auth row fails without a network call).
    await doctorCommand({}, probe);
    expect(stdout).toContain('PASS  Coding agent');
    expect(stdout).toContain('claude 1.4.2');
    expect(stdout).toContain('PASS  Agent credential');
    expect(stdout).toContain(join(home, '.claude'));
    expect(stdout).not.toContain('sk-do-not-print-me');
    expect(stdout).toContain('FAIL  Auth');
  });

  it('WARNS on a real binary that refuses --version', async () => {
    const broken = join(bin, 'grumpy-agent');
    writeFileSync(broken, '#!/bin/sh\nexit 7\n');
    chmodSync(broken, 0o755);
    process.env['MOTIR_AGENT'] = 'grumpy-agent';
    await doctorCommand({}, defaultDoctorProbe());
    expect(stdout).toContain('WARN  Coding agent');
    expect(stdout).toContain('did not answer --version');
  });

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    delete process.env['XDG_CONFIG_HOME'];
    expect(defaultDoctorProbe().xdgConfigHome()).toBe(join(home, '.config'));
  });

  it('resolves the XDG DATA home, honouring an override', () => {
    // Where OpenCode signs in (auth.json) — a different dir from the config
    // home, which is the distinction the profile table used to miss.
    delete process.env['XDG_DATA_HOME'];
    expect(defaultDoctorProbe().xdgDataHome()).toBe(join(home, '.local', 'share'));
    process.env['XDG_DATA_HOME'] = join(home, 'relocated-data');
    expect(defaultDoctorProbe().xdgDataHome()).toBe(join(home, 'relocated-data'));
  });
});
