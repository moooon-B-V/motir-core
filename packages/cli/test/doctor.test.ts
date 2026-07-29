import { describe, expect, it } from 'vitest';
import {
  countByStatus,
  doctorExitCode,
  renderDoctorReport,
  resolveAgentCommand,
  runDoctor,
  summarize,
  type DoctorCheck,
  type DoctorProbe,
  type DoctorReport,
  type ServerProbe,
} from '../src/doctor.js';
import { CliError } from '../src/errors.js';
import type { FoundLink } from '../src/config/linkConfig.js';

const LINK: FoundLink = {
  dir: '/work',
  path: '/work/.motir.json',
  config: { serverUrl: 'https://motir.test', workspace: 'moooon', project: 'MOTIR' },
};

const SERVER_OK: ServerProbe = {
  ok: true,
  toolCount: 28,
  user: { name: 'Yue', email: 'yue@example.com' },
  workspace: { name: 'moooon', slug: 'moooon' },
  project: { key: 'MOTIR', reachable: true, total: 42 },
};

const HOME = '/home/tester';

/** A fully-passing probe; each test overrides only the seam it exercises. */
function fakeProbe(over: Partial<DoctorProbe> = {}): DoctorProbe {
  return {
    findLink: () => LINK,
    resolveServerUrl: () => 'https://motir.test',
    hasCredential: () => true,
    probeServer: async () => SERVER_OK,
    resolveRepos: () => [],
    probeAgent: async () => ({
      onPath: true,
      resolvedPath: '/usr/local/bin/claude',
      version: 'claude 1.4.2',
    }),
    configuredAgentCommand: () => 'claude',
    agentEnvOverride: () => undefined,
    pathExists: (path) => path === `${HOME}/.claude`,
    hasEnv: () => false,
    home: () => HOME,
    xdgConfigHome: () => `${HOME}/.config`,
    xdgDataHome: () => `${HOME}/.local/share`,
    ...over,
  };
}

function check(report: DoctorReport, id: string): DoctorCheck {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check "${id}" in report`);
  return found;
}

describe('runDoctor — the happy path', () => {
  it('passes every row and exits zero', async () => {
    const report = await runDoctor({}, fakeProbe());
    expect(report.checks.map((c) => c.id)).toEqual([
      'link',
      'auth',
      'project',
      'repos',
      'agent',
      'credential',
    ]);
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(report.ok).toBe(true);
    expect(doctorExitCode(report)).toBe(0);
    expect(check(report, 'auth').detail).toContain('yue@example.com');
    expect(check(report, 'auth').detail).toContain('28 tools');
    expect(check(report, 'project').detail).toContain('42 work items');
  });

  it('never asks the server for anything when there is no stored credential', async () => {
    let called = false;
    const report = await runDoctor(
      {},
      fakeProbe({
        hasCredential: () => false,
        probeServer: async () => {
          called = true;
          return SERVER_OK;
        },
      }),
    );
    expect(called).toBe(false);
    expect(check(report, 'auth').status).toBe('fail');
    expect(check(report, 'auth').detail).toContain('Not logged in');
    expect(check(report, 'auth').remediation).toContain('motir auth login');
    expect(doctorExitCode(report)).toBe(1);
  });
});

describe('runDoctor — link', () => {
  it('FAILS when no .motir.json resolves, and skips what depends on it', async () => {
    const report = await runDoctor({}, fakeProbe({ findLink: () => null }));
    expect(check(report, 'link').status).toBe('fail');
    expect(check(report, 'link').remediation).toContain('motir link');
    expect(check(report, 'project').status).toBe('warn');
    expect(check(report, 'project').detail).toContain('Skipped');
    expect(check(report, 'repos').status).toBe('warn');
    expect(report.ok).toBe(false);
  });
});

describe('runDoctor — auth', () => {
  it('reports the resolver’s own message + hint when the server is ambiguous', async () => {
    const report = await runDoctor(
      {},
      fakeProbe({
        resolveServerUrl: () => {
          throw new CliError('Multiple servers are configured; pass --server <url>.', {
            hint: 'Configured: a, b',
          });
        },
      }),
    );
    expect(check(report, 'auth').status).toBe('fail');
    expect(check(report, 'auth').detail).toContain('Multiple servers');
    expect(check(report, 'auth').remediation).toBe('Configured: a, b');
  });

  it('falls back to a generic message for a non-CliError resolver failure', async () => {
    const report = await runDoctor(
      {},
      fakeProbe({
        resolveServerUrl: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(check(report, 'auth').detail).toBe('boom');
    expect(check(report, 'auth').remediation).toContain('motir auth login');
  });

  it('FAILS when the handshake fails, and skips the project row', async () => {
    const report = await runDoctor(
      {},
      fakeProbe({
        probeServer: async () => ({
          ok: false,
          error: { message: 'Token invalid or expired.', hint: 'Run `motir auth login`.' },
        }),
      }),
    );
    expect(check(report, 'auth').status).toBe('fail');
    expect(check(report, 'auth').detail).toContain('Token invalid or expired.');
    expect(check(report, 'auth').remediation).toBe('Run `motir auth login`.');
    expect(check(report, 'project').status).toBe('warn');
  });

  it('handles a server that answers without a workspace or tool count', async () => {
    const report = await runDoctor(
      {},
      fakeProbe({
        probeServer: async () => ({ ok: true, workspace: null }),
      }),
    );
    expect(check(report, 'auth').status).toBe('pass');
    expect(check(report, 'auth').detail).toContain('unknown user');
    expect(check(report, 'project').status).toBe('warn');
  });
});

describe('runDoctor — project', () => {
  it('FAILS when the linked project is not reachable for this token', async () => {
    const report = await runDoctor(
      {},
      fakeProbe({
        probeServer: async () => ({
          ...SERVER_OK,
          project: { key: 'MOTIR', reachable: false, error: 'PROJECT_NOT_FOUND' },
        }),
      }),
    );
    expect(check(report, 'project').status).toBe('fail');
    expect(check(report, 'project').detail).toContain('PROJECT_NOT_FOUND');
    expect(check(report, 'project').remediation).toContain('moooon');
    expect(report.ok).toBe(false);
  });

  it('reports an unknown error when the project row carries none', async () => {
    const report = await runDoctor(
      {},
      fakeProbe({
        probeServer: async () => ({ ...SERVER_OK, project: { key: 'MOTIR', reachable: false } }),
      }),
    );
    expect(check(report, 'project').detail).toContain('unknown error');
  });

  it('WARNS (does not fail) when the token’s active workspace differs from the link', async () => {
    const report = await runDoctor(
      {},
      fakeProbe({
        probeServer: async () => ({
          ...SERVER_OK,
          workspace: { name: 'Other', slug: 'other' },
        }),
      }),
    );
    expect(check(report, 'project').status).toBe('warn');
    expect(check(report, 'project').detail).toContain('other');
    expect(report.ok).toBe(true);
  });
});

describe('runDoctor — repo checkouts', () => {
  it('passes with the convention note when the link has no overrides', async () => {
    const report = await runDoctor({}, fakeProbe());
    expect(check(report, 'repos').status).toBe('pass');
    expect(check(report, 'repos').detail).toContain('/work');
  });

  it('passes when every override exists', async () => {
    const report = await runDoctor(
      {},
      fakeProbe({
        resolveRepos: () => [
          { repoName: 'motir-core', path: '/work/core', source: 'override', exists: true },
        ],
      }),
    );
    expect(check(report, 'repos').status).toBe('pass');
    expect(check(report, 'repos').detail).toContain('motir-core → /work/core');
  });

  it('WARNS on an override path that does not exist', async () => {
    const report = await runDoctor(
      {},
      fakeProbe({
        resolveRepos: () => [
          { repoName: 'motir-core', path: '/work/core', source: 'override', exists: false },
          { repoName: 'motir-ai', path: '/work/motir-ai', source: 'convention', exists: false },
        ],
      }),
    );
    expect(check(report, 'repos').status).toBe('warn');
    expect(check(report, 'repos').detail).toContain('1 override path(s)');
    expect(check(report, 'repos').detail).toContain('(not yet)');
    // A not-yet-cloned CONVENTION path is first-class, so the run still passes.
    expect(report.ok).toBe(true);
  });
});

describe('resolveAgentCommand — precedence', () => {
  it('prefers --agent, then MOTIR_AGENT, then the config', () => {
    const probe = fakeProbe({
      agentEnvOverride: () => 'codex --full-auto',
      configuredAgentCommand: () => 'claude',
    });
    expect(resolveAgentCommand({ agent: 'goose' }, probe)).toEqual({
      command: 'goose',
      source: 'flag',
    });
    expect(resolveAgentCommand({}, probe)).toEqual({
      command: 'codex --full-auto',
      source: 'env',
    });
    expect(resolveAgentCommand({}, fakeProbe({ configuredAgentCommand: () => 'claude' }))).toEqual({
      command: 'claude',
      source: 'config',
    });
  });

  it('treats a blank value at any layer as unset', () => {
    const probe = fakeProbe({
      agentEnvOverride: () => '   ',
      configuredAgentCommand: () => '',
    });
    expect(resolveAgentCommand({ agent: '  ' }, probe)).toBeNull();
  });
});

describe('runDoctor — agent', () => {
  it('WARNS (does not fail) when no agent is configured, and skips the credential', async () => {
    const report = await runDoctor({}, fakeProbe({ configuredAgentCommand: () => undefined }));
    expect(check(report, 'agent').status).toBe('warn');
    expect(check(report, 'agent').remediation).toContain('--print');
    expect(check(report, 'credential').status).toBe('warn');
    expect(check(report, 'credential').detail).toContain('Skipped');
    // `motir next --print` works with no agent at all, so this is not a failure.
    expect(report.ok).toBe(true);
    expect(doctorExitCode(report)).toBe(0);
  });

  it('FAILS a missing binary with the profile’s install source', async () => {
    const report = await runDoctor(
      { agent: 'claude --dangerously-skip-permissions' },
      fakeProbe({ probeAgent: async () => ({ onPath: false }) }),
    );
    expect(check(report, 'agent').status).toBe('fail');
    expect(check(report, 'agent').detail).toContain('`claude`');
    expect(check(report, 'agent').detail).toContain('--agent');
    expect(check(report, 'agent').remediation).toContain(
      'npm install -g @anthropic-ai/claude-code',
    );
    expect(doctorExitCode(report)).toBe(1);
  });

  it('FAILS a missing UNLISTED binary with a generic remediation', async () => {
    const report = await runDoctor(
      { agent: 'my-own-agent --yolo' },
      fakeProbe({ probeAgent: async () => ({ onPath: false }) }),
    );
    expect(check(report, 'agent').status).toBe('fail');
    expect(check(report, 'agent').remediation).toContain('`my-own-agent`');
    expect(check(report, 'agent').remediation).toContain('on PATH');
  });

  it('WARNS when the binary is on PATH but does not answer --version', async () => {
    const report = await runDoctor(
      {},
      fakeProbe({
        probeAgent: async () => ({
          onPath: true,
          resolvedPath: '/usr/local/bin/claude',
          versionError: 'exited with code 1',
        }),
      }),
    );
    expect(check(report, 'agent').status).toBe('warn');
    expect(check(report, 'agent').detail).toContain('exited with code 1');
    expect(report.ok).toBe(true);
  });

  it('names the profile and the version on a pass', async () => {
    const report = await runDoctor({}, fakeProbe());
    expect(check(report, 'agent').detail).toContain('Claude Code');
    expect(check(report, 'agent').detail).toContain('claude 1.4.2');
    expect(check(report, 'agent').detail).toContain('via config agentCommand');
  });
});

describe('runDoctor — credential (presence only)', () => {
  it('PASSES on a present credential directory', async () => {
    const report = await runDoctor({}, fakeProbe());
    expect(check(report, 'credential').status).toBe('pass');
    expect(check(report, 'credential').detail).toContain(`${HOME}/.claude`);
    expect(check(report, 'credential').detail).toContain('never read');
  });

  it('PASSES on the env var alone, naming it without its value', async () => {
    const report = await runDoctor(
      {},
      fakeProbe({ pathExists: () => false, hasEnv: (name) => name === 'ANTHROPIC_API_KEY' }),
    );
    expect(check(report, 'credential').status).toBe('pass');
    expect(check(report, 'credential').detail).toContain('ANTHROPIC_API_KEY');
  });

  it('FAILS when neither the path nor the env var is present, naming both', async () => {
    const report = await runDoctor(
      { agent: 'codex' },
      fakeProbe({ pathExists: () => false, hasEnv: () => false }),
    );
    const credential = check(report, 'credential');
    expect(credential.status).toBe('fail');
    expect(credential.detail).toContain('Codex CLI');
    expect(credential.remediation).toContain(`${HOME}/.codex`);
    expect(credential.remediation).toContain('the OPENAI_API_KEY env var');
    expect(doctorExitCode(report)).toBe(1);
  });

  it('WARNS for an agent whose credential lives in the OS keyring', async () => {
    const report = await runDoctor({ agent: 'goose' }, fakeProbe({ pathExists: () => false }));
    expect(check(report, 'credential').status).toBe('warn');
    expect(check(report, 'credential').detail).toContain('not pinned');
    expect(report.ok).toBe(true);
  });

  it('FAILS OpenCode on a config dir with no auth.json — the former false PASS', async () => {
    // The defect this suite pins: the profile tested `~/.config/opencode`, which
    // exists on any machine that has ever RUN opencode. Reporting the credential
    // present there told a user their unattended run was ready when it would
    // stop at a sign-in prompt.
    const configDirOnly = fakeProbe({
      pathExists: (path) => path === `${HOME}/.config/opencode`,
    });
    const report = await runDoctor({ agent: 'opencode run --auto' }, configDirOnly);
    const credential = check(report, 'credential');
    expect(credential.status).toBe('fail');
    expect(credential.detail).toContain('OpenCode');
    expect(credential.remediation).toContain('opencode auth login');
    expect(credential.remediation).toContain(`${HOME}/.local/share/opencode/auth.json`);
    expect(doctorExitCode(report)).toBe(1);
  });

  it('PASSES OpenCode on the auth.json under the XDG DATA home', async () => {
    const report = await runDoctor(
      { agent: 'opencode' },
      fakeProbe({ pathExists: (path) => path === `${HOME}/.local/share/opencode/auth.json` }),
    );
    const credential = check(report, 'credential');
    expect(credential.status).toBe('pass');
    expect(credential.detail).toContain(`${HOME}/.local/share/opencode/auth.json`);
  });

  it('enriches the Cursor profile for `agent`, the binary its installer links', async () => {
    // The documented headless invocation. Before the alias list this fell to the
    // tier-3 generic path, losing both the install source and the credential
    // remediation — silently, since a tier-3 result is a plausible-looking WARN.
    const report = await runDoctor(
      { agent: 'agent -p --force' },
      fakeProbe({ probeAgent: async () => ({ onPath: false }), pathExists: () => false }),
    );
    expect(check(report, 'agent').remediation).toContain('Cursor CLI');
    expect(check(report, 'agent').remediation).toContain('cursor.com/install');
    const credential = check(report, 'credential');
    expect(credential.status).toBe('fail');
    expect(credential.detail).toContain('Cursor CLI');
    expect(credential.remediation).toContain('the CURSOR_API_KEY env var');
    expect(credential.detail).not.toContain('No credential profile');
  });

  it('PASSES Cursor on CURSOR_API_KEY alone', async () => {
    const report = await runDoctor(
      { agent: 'cursor-agent -p' },
      fakeProbe({ pathExists: () => false, hasEnv: (name) => name === 'CURSOR_API_KEY' }),
    );
    expect(check(report, 'credential').status).toBe('pass');
    expect(check(report, 'credential').detail).toContain('CURSOR_API_KEY');
  });

  it('WARNS for an agent with no profile at all (tier 3)', async () => {
    const report = await runDoctor({ agent: 'my-own-agent' }, fakeProbe());
    expect(check(report, 'credential').status).toBe('warn');
    expect(check(report, 'credential').detail).toContain('No credential profile');
    expect(check(report, 'credential').remediation).toContain('`my-own-agent`');
  });

  it('asks ONLY presence questions — it can never obtain a secret', async () => {
    // The probe seam exposes `pathExists` / `hasEnv`, both boolean. This test
    // pins the contract: the engine reaches for the credential ONLY through
    // them, with the profile's own path/name, and prints neither a value nor a
    // file's contents.
    const pathsAsked: string[] = [];
    const envAsked: string[] = [];
    const report = await runDoctor(
      { agent: 'claude' },
      fakeProbe({
        pathExists: (path) => {
          pathsAsked.push(path);
          return false;
        },
        hasEnv: (name) => {
          envAsked.push(name);
          return true;
        },
      }),
    );
    expect(pathsAsked).toEqual([`${HOME}/.claude`]);
    expect(envAsked).toEqual(['ANTHROPIC_API_KEY']);
    expect(check(report, 'credential').status).toBe('pass');
    expect(renderDoctorReport(report)).not.toMatch(/sk-|token|secret/i);
  });
});

describe('the report', () => {
  it('summarize / doctorExitCode key off a FAIL only', () => {
    const warnOnly = summarize([
      { id: 'a', label: 'A', status: 'pass', detail: 'ok' },
      { id: 'b', label: 'B', status: 'warn', detail: 'hmm' },
    ]);
    expect(warnOnly.ok).toBe(true);
    expect(doctorExitCode(warnOnly)).toBe(0);
    const failing = summarize([{ id: 'a', label: 'A', status: 'fail', detail: 'no' }]);
    expect(failing.ok).toBe(false);
    expect(doctorExitCode(failing)).toBe(1);
  });

  it('counts each status', () => {
    expect(
      countByStatus([
        { id: 'a', label: 'A', status: 'pass', detail: '' },
        { id: 'b', label: 'B', status: 'warn', detail: '' },
        { id: 'c', label: 'C', status: 'warn', detail: '' },
        { id: 'd', label: 'D', status: 'fail', detail: '' },
      ]),
    ).toEqual({ pass: 1, warn: 2, fail: 1 });
  });

  it('renders one aligned row per check with the remediation underneath', () => {
    const report = summarize([
      { id: 'auth', label: 'Auth', status: 'pass', detail: 'yue@example.com' },
      {
        id: 'agent',
        label: 'Coding agent',
        status: 'fail',
        detail: '`claude` is not on PATH.',
        remediation: 'npm install -g @anthropic-ai/claude-code',
      },
    ]);
    const text = renderDoctorReport(report);
    expect(text).toContain('motir doctor — BYOK preflight');
    expect(text).toContain('PASS  Auth          yue@example.com');
    expect(text).toContain('FAIL  Coding agent  `claude` is not on PATH.');
    expect(text).toContain('↳ npm install -g @anthropic-ai/claude-code');
    expect(text.trimEnd().endsWith('1 failed, 1 passed.')).toBe(true);
  });

  it('says so plainly when everything passed', async () => {
    const text = renderDoctorReport(await runDoctor({}, fakeProbe()));
    expect(text).toContain('All hard checks passed — 6 passed.');
  });

  it('pluralises the warning count', () => {
    const text = renderDoctorReport(
      summarize([
        { id: 'a', label: 'A', status: 'warn', detail: '' },
        { id: 'b', label: 'B', status: 'warn', detail: '' },
      ]),
    );
    expect(text).toContain('2 warnings.');
  });
});
