import { describe, expect, it } from 'vitest';
import { AGENT_PROFILES, agentProfileById, unattendedAgentCommand } from '../src/agentProfiles.js';
import { CHAT_ADAPTERS } from '../src/agentTerminal/chat/adapter.js';

// Each profile's STREAMING run form (MOTIR-8980). It must be the stream the Chat tab's
// adapter parses, so the tests below read the adapter's own `turnCommand` and hold the
// run's argv to the same stream flags.

/** The tokens that select a stream rather than grant permission, per adapter. */
const STREAM_FLAGS: Record<string, string[][]> = {
  claude: [['--output-format', 'stream-json'], ['--verbose']],
  codex: [['--json']],
  opencode: [['--format', 'json']],
  kimi: [['--output-format', 'stream-json']],
  goose: [['--output-format', 'stream-json']],
};

function containsRun(args: readonly string[], run: readonly string[]): boolean {
  return args.some((_, i) => run.every((token, j) => args[i + j] === token));
}

describe('agentStream — the same stream the chat adapters parse', () => {
  it('every profile with an adapter has a stream form, and none without one does', () => {
    const adapted = new Set(CHAT_ADAPTERS.map((a) => a.profile));
    for (const p of AGENT_PROFILES) {
      expect(p.agentStream !== null, p.id).toBe(adapted.has(p.id));
    }
    expect(agentProfileById('aider')!.agentStream).toBeNull();
    expect(agentProfileById('cursor')!.agentStream).toBeNull();
  });

  it('carries the adapter’s own stream flags — on a fresh run and on a resume', () => {
    for (const adapter of CHAT_ADAPTERS) {
      const form = agentProfileById(adapter.profile)!.agentStream!;
      const chat = adapter.turnCommand({
        prompt: 'P',
        sessionId: null,
        ctx: { home: '/h', cwd: '/h/w', env: {} },
      });
      for (const flag of STREAM_FLAGS[adapter.profile]!) {
        expect(containsRun(chat.args, flag), `${adapter.profile} chat ${flag}`).toBe(true);
        expect(containsRun(form.args, flag), `${adapter.profile} run ${flag}`).toBe(true);
        expect(
          containsRun(form.resumeArgs('sid-1'), flag),
          `${adapter.profile} resume ${flag}`,
        ).toBe(true);
      }
    }
  });

  it('resumes the way the chat adapter resumes', () => {
    for (const adapter of CHAT_ADAPTERS) {
      const form = agentProfileById(adapter.profile)!.agentStream!;
      const chat = adapter.turnCommand({
        prompt: 'P',
        sessionId: 'sid-1',
        ctx: { home: '/h', cwd: '/h/w', env: {} },
      }).args;
      const resumeToken = chat.filter((a) => ['--resume', '--session', 'resume'].includes(a));
      const run = form.resumeArgs('sid-1');
      expect(run, adapter.profile).toContain('sid-1');
      for (const token of resumeToken) expect(run, `${adapter.profile} ${token}`).toContain(token);
    }
  });

  it('keeps the unattended permission flags the plain form had', () => {
    const permission: Record<string, string> = {
      claude: '--dangerously-skip-permissions',
      codex: 'danger-full-access',
      opencode: '--auto',
    };
    for (const [id, flag] of Object.entries(permission)) {
      const form = agentProfileById(id)!.agentStream!;
      expect(form.args.join(' '), id).toContain(flag);
      expect(form.resumeArgs('sid-1').join(' '), id).toContain(flag);
    }
    // goose's approval mode is the variable, which the profile still sets.
    expect(agentProfileById('goose')!.agentEnv).toEqual({ GOOSE_MODE: 'auto' });
  });
});

describe('unattendedAgentCommand — the streaming launcher', () => {
  it('chooses claude’s session id and says so on the command', () => {
    const cmd = unattendedAgentCommand(
      'claude',
      { PATH: '/bin' },
      { newSessionId: () => 'sid-9' },
    )!;
    expect(cmd.args.slice(-2)).toEqual(['--session-id', 'sid-9']);
    expect(cmd.stream).toEqual({ profile: 'claude', sessionId: 'sid-9' });
    expect(cmd.promptOnStdin).toBeUndefined();
  });

  it('mints a real, distinct id by default', () => {
    const a = unattendedAgentCommand('claude', {})!.stream!.sessionId!;
    const b = unattendedAgentCommand('claude', {})!.stream!.sessionId!;
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it('leaves the id to the agent where the agent picks its own', () => {
    for (const id of ['codex', 'opencode', 'kimi', 'goose']) {
      expect(unattendedAgentCommand(id, {})!.stream, id).toEqual({ profile: id, sessionId: null });
    }
  });

  it('resumes the named session instead of starting one', () => {
    const claude = unattendedAgentCommand('claude', {}, { resumeSessionId: 'old-1' })!;
    expect(claude.args).toContain('--resume');
    expect(claude.args).not.toContain('--session-id');
    expect(claude.stream).toEqual({ profile: 'claude', sessionId: 'old-1' });
    const codex = unattendedAgentCommand('codex', {}, { resumeSessionId: 'th-1' })!;
    expect(codex.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(codex.stream!.sessionId).toBe('th-1');
  });

  it('delivers the prompt the way each stream form takes it', () => {
    // stdin: claude, codex, goose. argv, last: opencode, kimi.
    for (const id of ['claude', 'codex', 'goose']) {
      const cmd = unattendedAgentCommand(id, {})!;
      expect(cmd.promptOnStdin, id).toBeUndefined();
      expect(cmd.promptArgs, id).toBeUndefined();
    }
    for (const id of ['opencode', 'kimi']) {
      const cmd = unattendedAgentCommand(id, {})!;
      expect(cmd.promptOnStdin, id).toBe(false);
      expect(cmd.promptArgs!('do it', '/tmp/p.md'), id).toEqual(['do it']);
    }
    // kimi's `-p` takes the prompt as its value, so it is the last flag.
    expect(unattendedAgentCommand('kimi', {})!.args.at(-1)).toBe('-p');
  });

  it('keeps aider on its plain form — it has no stream', () => {
    const cmd = unattendedAgentCommand('aider', {})!;
    expect(cmd.stream).toBeUndefined();
    expect(cmd.args).toEqual(['--yes-always', '--message']);
  });

  it('MOTIR_AGENT_OUTPUT=text forces the plain form for a CLI that refuses the stream flags', () => {
    const cmd = unattendedAgentCommand('claude', { MOTIR_AGENT_OUTPUT: 'text' })!;
    expect(cmd.args).toEqual(['-p', '--dangerously-skip-permissions']);
    expect(cmd.stream).toBeUndefined();
    expect(
      unattendedAgentCommand('claude', { MOTIR_AGENT_OUTPUT: 'stream' })!.stream,
    ).toBeDefined();
  });

  it('still withholds every Motir and git credential from the streaming form', () => {
    const cmd = unattendedAgentCommand('codex', { PATH: '/bin', MOTIR_TOKEN: 'secret' })!;
    expect(cmd.env).toEqual({ PATH: '/bin' });
  });
});
