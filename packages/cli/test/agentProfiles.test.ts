import { describe, expect, it } from 'vitest';
import {
  AGENT_PROFILES,
  agentProfileIds,
  findAgentProfile,
  parseAgentCommand,
} from '../src/agentProfiles.js';

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
    expect(new Set(AGENT_PROFILES.map((p) => p.binary)).size).toBe(AGENT_PROFILES.length);
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
      const located =
        profile.credentialPaths('/home/tester', '/home/tester/.config').length > 0 ||
        profile.credentialEnv.length > 0;
      expect(located).toBe(profile.credentialKnown);
    }
  });

  it('pins the tier-1 credential mounts from the sandbox matrix', () => {
    const home = '/home/tester';
    const xdg = '/home/tester/.config';
    const paths = (id: string): string[] =>
      AGENT_PROFILES.find((p) => p.id === id)?.credentialPaths(home, xdg) ?? [];
    expect(paths('claude')).toEqual(['/home/tester/.claude']);
    expect(paths('codex')).toEqual(['/home/tester/.codex']);
    expect(paths('opencode')).toEqual(['/home/tester/.config/opencode']);
  });

  it('honours a relocated XDG config home', () => {
    const opencode = AGENT_PROFILES.find((p) => p.id === 'opencode');
    expect(opencode?.credentialPaths('/home/tester', '/elsewhere/cfg')).toEqual([
      '/elsewhere/cfg/opencode',
    ]);
  });

  it('leaves an unpinned credential location UNKNOWN rather than guessing', () => {
    for (const id of ['kimi', 'antigravity', 'cursor', 'aider', 'goose']) {
      const profile = AGENT_PROFILES.find((p) => p.id === id);
      expect(profile?.credentialKnown).toBe(false);
      expect(profile?.credentialPaths('/home/tester', '/home/tester/.config')).toEqual([]);
    }
  });
});
