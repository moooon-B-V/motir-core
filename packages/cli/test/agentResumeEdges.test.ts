import { describe, expect, it, vi } from 'vitest';

const refuse = vi.hoisted(() => ({ on: false }));
vi.mock('../src/commands/dispatch.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/commands/dispatch.js')>();
  return {
    ...real,
    resumeFixAgent: (...a: Parameters<typeof real.resumeFixAgent>) =>
      refuse.on ? null : real.resumeFixAgent(...a),
  };
});

import { chooseRepairAgent, withFreshFallback } from '../src/agentResume.js';

// The edges of the resume choice (MOTIR-9057): an agent that has no stream form at
// all, and a resume the launcher itself declines to build.

describe('chooseRepairAgent — the edges', () => {
  it('names "another" agent when this one has no streaming form', () => {
    const c = chooseRepairAgent(
      'PROD-7',
      { profile: 'claude', sessionId: 's', canResume: true },
      { MOTIR_SANDBOX_AGENT: 'aider' },
    );
    expect(c.fresh).toBeNull();
    expect(c.line).toMatch(/this agent is another/);
  });

  it('starts fresh and says the agent cannot resume when the launcher declines to build one', () => {
    refuse.on = true;
    try {
      const c = chooseRepairAgent(
        'PROD-7',
        { profile: 'claude', sessionId: 's', canResume: true },
        { MOTIR_SANDBOX_AGENT: 'claude' },
      );
      expect(c.fresh).toBeNull();
      expect(c.line).toMatch(/claude cannot resume a session here/);
    } finally {
      refuse.on = false;
    }
  });
});

describe('withFreshFallback — a resumed command with no stream label', () => {
  it('still says so, naming "The agent"', async () => {
    const resumed = { command: 'r', binary: 'r', args: [] };
    const fresh = { command: 'f', binary: 'f', args: [] };
    const say = vi.fn();
    const run = vi.fn(async () => ({ exitCode: 1 }));
    await withFreshFallback(
      run,
      { parsed: resumed, fresh, line: '' },
      say,
    )({
      command: resumed,
      prompt: 'p',
      cwd: '/w',
    });
    expect(say.mock.calls[0]?.[0]).toMatch(/^The agent could not resume/);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
