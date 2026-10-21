import { describe, expect, it, vi } from 'vitest';
import { chooseRepairAgent, withFreshFallback } from '../src/agentResume.js';

// Which conversation a repair in the person's own agent continues (MOTIR-9052).

const env = (profile: string): NodeJS.ProcessEnv => ({ MOTIR_SANDBOX_AGENT: profile });

describe('chooseRepairAgent', () => {
  it('resumes the recorded session when the profile matches and can resume', () => {
    const c = chooseRepairAgent(
      'PROD-7',
      { profile: 'claude', sessionId: 's-1', canResume: true },
      env('claude'),
    );
    expect(c.parsed.stream?.sessionId).toBe('s-1');
    expect(c.fresh).not.toBeNull();
    expect(c.line).toMatch(/resuming the claude session/);
  });

  it.each([
    ['no earlier run', null, /no earlier agent run/],
    [
      'a different agent',
      { profile: 'codex', sessionId: 's', canResume: true },
      /last run was in codex/,
    ],
    [
      'no recorded session',
      { profile: 'claude', sessionId: null, canResume: true },
      /no session to resume/,
    ],
    [
      'a profile with no resume form',
      { profile: 'claude', sessionId: 's', canResume: false },
      /no session to resume/,
    ],
  ])('starts fresh and says why — %s', (_n, resume, line) => {
    const c = chooseRepairAgent('PROD-7', resume, env('claude'));
    expect(c.fresh).toBeNull();
    expect(c.parsed.stream?.sessionId).not.toBe('s');
    expect(c.line).toMatch(line);
  });
});

describe('withFreshFallback', () => {
  const choice = chooseRepairAgent(
    'PROD-7',
    { profile: 'claude', sessionId: 's-1', canResume: true },
    env('claude'),
  );
  function input(command = choice.parsed) {
    return { command, prompt: 'p', cwd: '/w' };
  }

  it('re-runs the first failed resumed turn once as fresh, then not again', async () => {
    const run = vi.fn(async (_i: ReturnType<typeof input>) => ({ exitCode: 1 }));
    const say = vi.fn();
    const wrapped = withFreshFallback(run, choice, say);
    await wrapped(input());
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0].command).toBe(choice.fresh);
    expect(say).toHaveBeenCalledTimes(1);
    await wrapped(input());
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('leaves a successful resume and a nothing-resumed choice alone', async () => {
    const ok = vi.fn(async (_i: ReturnType<typeof input>) => ({ exitCode: 0 }));
    await withFreshFallback(ok, choice, vi.fn())(input());
    expect(ok).toHaveBeenCalledTimes(1);
    const fresh = chooseRepairAgent('PROD-7', null, env('claude'));
    expect(withFreshFallback(ok, fresh, vi.fn())).toBe(ok);
  });
});
