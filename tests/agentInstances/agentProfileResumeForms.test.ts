import { describe, expect, it } from 'vitest';
import { RESUMABLE_AGENT_PROFILE_IDS, profileCanResume } from '@/lib/agentInstances/profiles';
import { AGENT_PROFILES } from '@/packages/cli/src/agentProfiles';

// The `lib` mirror of "which profile has a resume form" is held equal to the CLI's
// own table (MOTIR-8981 · MOTIR-9046): a profile gaining or losing a resume form
// fails here instead of drifting.

describe('RESUMABLE_AGENT_PROFILE_IDS', () => {
  it('is exactly the profiles whose agentStream.resumeArgs is non-null', () => {
    const fromCli = AGENT_PROFILES.filter((p) => p.agentStream?.resumeArgs != null)
      .map((p) => p.id)
      .sort();
    expect([...RESUMABLE_AGENT_PROFILE_IDS].sort()).toEqual(fromCli);
    expect(fromCli).toEqual(['claude', 'codex', 'goose', 'kimi', 'opencode']);
  });

  it('answers false for aider and for a profile it does not know', () => {
    expect(profileCanResume('claude')).toBe(true);
    expect(profileCanResume('aider')).toBe(false);
    expect(profileCanResume('nope')).toBe(false);
  });
});
