import { describe, expect, it } from 'vitest';
import {
  AGENT_PROFILES,
  AGENT_RUN_WITHHELD_ENV,
  unattendedAgentCommand,
  type ParsedAgentCommand,
} from '../src/agentProfiles.js';
import { resumeFixAgent } from '../src/commands/dispatch.js';

// `resumeFixAgent`'s decisions (MOTIR-9048): a resume command only when the launcher
// itself built the run's agent AND really resumes the id asked for.

const launched = (profile: string, env: NodeJS.ProcessEnv = {}): ParsedAgentCommand => {
  const command = unattendedAgentCommand(profile, env);
  if (!command) throw new Error(`${profile} has no unattended command`);
  return command;
};

describe('resumeFixAgent', () => {
  for (const profile of AGENT_PROFILES.filter((p) => p.agentStream && p.agentCommand)) {
    it(`resumes ${profile.id} with exactly its own resume form`, () => {
      const resumed = resumeFixAgent(launched(profile.id), 'sess-9', {});
      expect(resumed).not.toBeNull();
      expect(resumed?.args).toEqual(profile.agentStream!.resumeArgs('sess-9'));
      expect(resumed?.binary).toBe(launched(profile.id).binary);
      expect(resumed?.stream).toEqual({ profile: profile.id, sessionId: 'sess-9' });
      for (const name of AGENT_RUN_WITHHELD_ENV) expect(resumed?.env?.[name]).toBeUndefined();
    });
  }

  it('drops the withheld environment even when the launched command carried it', () => {
    const name = AGENT_RUN_WITHHELD_ENV[0]!;
    const agent = { ...launched('claude'), env: { ...process.env, [name]: 'secret' } };
    expect(resumeFixAgent(agent, 'sess-9', {})?.env?.[name]).toBeUndefined();
  });

  it('returns null for a profile with no streaming form', () => {
    const aider = launched('aider');
    expect(aider.stream).toBeUndefined();
    expect(resumeFixAgent(aider, 'sess-9', {})).toBeNull();
  });

  it('returns null under MOTIR_AGENT_OUTPUT=text', () => {
    const agent = launched('claude');
    const textual = { ...agent, env: { ...agent.env, MOTIR_AGENT_OUTPUT: 'text' } };
    expect(resumeFixAgent(textual, 'sess-9', {})).toBeNull();
  });

  it('returns null for a command no launcher built (a typed --agent)', () => {
    const typed: ParsedAgentCommand = { command: 'claude -p', binary: 'claude', args: ['-p'] };
    expect(resumeFixAgent(typed, 'sess-9', {})).toBeNull();
  });

  it('returns null for a null, empty or blank session id', () => {
    for (const id of [null, undefined, '', '   ']) {
      expect(resumeFixAgent(launched('claude'), id, {})).toBeNull();
    }
  });

  it('keeps an agent-mode run’s prompt addendum on the resumed command', () => {
    const agent = { ...launched('claude'), promptAddendum: () => 'git rules' };
    expect(resumeFixAgent(agent, 'sess-9', {})?.promptAddendum?.()).toBe('git rules');
  });
});
