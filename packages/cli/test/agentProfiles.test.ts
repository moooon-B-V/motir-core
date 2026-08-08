import { describe, expect, it } from 'vitest';
import {
  AGENT_PROFILES,
  agentProfileIds,
  deriveAgentHarness,
  findAgentProfile,
  parseAgentCommand,
} from '../src/agentProfiles.js';
import { CLI_VERSION } from '../src/version.js';

describe('parseAgentCommand', () => {
  it('returns null for an absent or blank command', () => {
    expect(parseAgentCommand(undefined)).toBeNull();
    expect(parseAgentCommand('')).toBeNull();
    expect(parseAgentCommand('   ')).toBeNull();
  });

  it('takes the FIRST token as the binary and the rest as flags', () => {
    expect(parseAgentCommand('claude --dangerously-skip-permissions')).toEqual({
      command: 'claude --dangerously-skip-permissions',
      binary: 'claude',
      args: ['--dangerously-skip-permissions'],
    });
  });

  it('trims and collapses whitespace', () => {
    expect(parseAgentCommand('  codex   --full-auto  ')).toEqual({
      command: 'codex   --full-auto',
      binary: 'codex',
      args: ['--full-auto'],
    });
  });

  it('handles a bare binary with no flags', () => {
    expect(parseAgentCommand('goose')).toEqual({ command: 'goose', binary: 'goose', args: [] });
  });
});

describe('findAgentProfile', () => {
  it('matches a tier-1 binary', () => {
    expect(findAgentProfile('claude')?.label).toBe('Claude Code');
    expect(findAgentProfile('codex')?.label).toBe('Codex CLI');
    expect(findAgentProfile('opencode')?.label).toBe('OpenCode');
    expect(findAgentProfile('kimi')?.label).toBe('Kimi Code CLI');
  });

  it('resolves Cursor by EVERY name its installer links, plus the profile id', () => {
    // The installer symlinks the executable as `agent` and keeps `cursor-agent`
    // as the legacy alias, so the documented headless invocation is
    // `agent -p --force`. Matching only `cursor` sent exactly that user to the
    // tier-3 generic path with no remediation hint.
    expect(findAgentProfile('agent')?.id).toBe('cursor');
    expect(findAgentProfile('cursor-agent')?.id).toBe('cursor');
    expect(findAgentProfile('cursor')?.id).toBe('cursor');
    expect(findAgentProfile('/usr/local/bin/agent')?.id).toBe('cursor');
  });

  it('resolves Antigravity by `agy`, the binary its installer actually links', () => {
    expect(findAgentProfile('agy')?.id).toBe('antigravity');
    expect(findAgentProfile('antigravity')?.id).toBe('antigravity');
  });

  it('matches on the basename, so an absolute path still resolves', () => {
    expect(findAgentProfile('/usr/local/bin/codex')?.id).toBe('codex');
  });

  it('ignores case and a Windows executable suffix', () => {
    expect(findAgentProfile('CLAUDE.EXE')?.id).toBe('claude');
    expect(findAgentProfile('Aider.cmd')?.id).toBe('aider');
  });

  it('returns null for an unlisted agent (the tier-3 escape hatch)', () => {
    expect(findAgentProfile('my-own-agent')).toBeNull();
  });
});

// The harness half of the implementation provenance triple (MOTIR-2419). The
// value recorded on every item a run integrates, so what matters is that it
// DISTINGUISHES: a harness that reads the same for every agent is the bug.
describe('deriveAgentHarness', () => {
  it('names the AGENT, never the CLI that launched it', () => {
    expect(deriveAgentHarness('claude')).toBe('claude');
    expect(deriveAgentHarness('codex')).toBe('codex');
    // The regression this card exists for: every BYOK card recorded this.
    for (const binary of ['claude', 'codex', 'opencode', 'my-own-agent']) {
      expect(deriveAgentHarness(binary)).not.toBe(`motir-cli/${CLI_VERSION}`);
      expect(deriveAgentHarness(binary)).not.toContain('motir-cli');
    }
  });

  it('collapses a profile’s aliases onto ONE id, so one agent is one value', () => {
    expect(deriveAgentHarness('agent')).toBe('cursor');
    expect(deriveAgentHarness('cursor-agent')).toBe('cursor');
    expect(deriveAgentHarness('/usr/local/bin/agent')).toBe('cursor');
    expect(deriveAgentHarness('CLAUDE.EXE')).toBe('claude');
  });

  it('still answers truthfully for an UNLISTED agent (tier 3)', () => {
    // Motir is agent-agnostic: falling back to something generic here would put
    // every tier-3 run straight back into the undistinguishable state.
    expect(deriveAgentHarness('/opt/bin/My-Own-Agent.exe')).toBe('my-own-agent');
  });

  it('is derived from the command alone — no I/O, no agent cooperation', () => {
    // Load-bearing: the loop must be able to record a harness for an agent that
    // reported nothing and for one that died. It never fails to produce a value.
    for (const binary of ['claude', 'x', '/a/b/c']) {
      expect(deriveAgentHarness(binary).length).toBeGreaterThan(0);
    }
  });
});

const DIRS = {
  home: '/home/tester',
  xdgConfigHome: '/home/tester/.config',
  xdgDataHome: '/home/tester/.local/share',
};

describe('AGENT_PROFILES', () => {
  it('exposes the sandbox matrix agents, ids unique', () => {
    const ids = agentProfileIds();
    expect(ids).toEqual([
      'claude',
      'codex',
      'opencode',
      'kimi',
      'antigravity',
      'cursor',
      'aider',
      'goose',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    // Every binary name resolves to exactly ONE profile — an alias shared by two
    // profiles would make `findAgentProfile` order-dependent.
    const binaries = AGENT_PROFILES.flatMap((p) => [...p.binaries]);
    expect(new Set(binaries).size).toBe(binaries.length);
    for (const profile of AGENT_PROFILES) {
      expect(profile.binaries.length, `binaries for ${profile.id}`).toBeGreaterThan(0);
      for (const name of profile.binaries) expect(name).toBe(name.toLowerCase());
    }
  });

  it('always carries an install source and a credential hint (the remediation lines)', () => {
    for (const profile of AGENT_PROFILES) {
      expect(profile.installSource.length).toBeGreaterThan(0);
      expect(profile.credentialHint.length).toBeGreaterThan(0);
    }
  });

  it('claims credentialKnown EXACTLY when it pins a path or an env var', () => {
    // The invariant that keeps `doctor` honest: a profile may not claim to know
    // where a credential lives without naming somewhere to look — otherwise the
    // credential check would FAIL a correctly-configured machine.
    for (const profile of AGENT_PROFILES) {
      const located = profile.credentialPaths(DIRS).length > 0 || profile.credentialEnv.length > 0;
      expect(located, profile.id).toBe(profile.credentialKnown);
    }
  });

  it('pins each credential from the sandbox matrix — auth FILE where a dir is not proof', () => {
    const paths = (id: string): string[] =>
      AGENT_PROFILES.find((p) => p.id === id)?.credentialPaths(DIRS) ?? [];
    expect(paths('claude')).toEqual(['/home/tester/.claude']);
    expect(paths('codex')).toEqual(['/home/tester/.codex']);
    expect(paths('kimi')).toEqual(['/home/tester/.kimi-code']);
    // The bug this suite exists for: OpenCode's config dir is NOT its
    // credential. `~/.config/opencode` holds configuration; the credential is
    // auth.json under the XDG DATA home.
    expect(paths('opencode')).toEqual(['/home/tester/.local/share/opencode/auth.json']);
    expect(paths('opencode')[0]).not.toContain('/.config/');
  });

  it('honours a relocated XDG data home for the OpenCode credential', () => {
    const opencode = AGENT_PROFILES.find((p) => p.id === 'opencode');
    expect(opencode?.credentialPaths({ ...DIRS, xdgDataHome: '/elsewhere/data' })).toEqual([
      '/elsewhere/data/opencode/auth.json',
    ]);
    // The config home moving must NOT move the credential — conflating the two
    // is the original defect.
    expect(opencode?.credentialPaths({ ...DIRS, xdgConfigHome: '/elsewhere/cfg' })).toEqual([
      '/home/tester/.local/share/opencode/auth.json',
    ]);
  });

  it('tests an ENV key where the matrix mount proves installation, not sign-in', () => {
    // Cursor's `~/.local/share/cursor-agent` mount is also where the installer
    // unpacks the CLI, and Aider's `~/.aider.conf.yml` is created (possibly
    // empty) just so docker can bind it. Both would PASS on a machine that
    // never signed in, so neither is tested as a path.
    for (const id of ['cursor', 'aider']) {
      const profile = AGENT_PROFILES.find((p) => p.id === id);
      expect(profile?.credentialPaths(DIRS), id).toEqual([]);
      expect(profile?.credentialEnv.length, id).toBeGreaterThan(0);
      expect(profile?.credentialKnown, id).toBe(true);
    }
    expect(AGENT_PROFILES.find((p) => p.id === 'cursor')?.credentialEnv).toEqual([
      'CURSOR_API_KEY',
    ]);
  });

  it('leaves a KEYRING-backed credential UNKNOWN rather than guessing', () => {
    // The two agents that keep their secret in the OS keyring: there is no file
    // to look for, and inventing one would FAIL a working machine.
    for (const id of ['antigravity', 'goose']) {
      const profile = AGENT_PROFILES.find((p) => p.id === id);
      expect(profile?.credentialKnown, id).toBe(false);
      expect(profile?.credentialPaths(DIRS), id).toEqual([]);
      expect(profile?.credentialEnv, id).toEqual([]);
    }
  });
});
