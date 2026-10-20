import { describe, expect, it } from 'vitest';
import { agentProfileById, type ParsedAgentCommand } from '../src/agentProfiles.js';
import { chooseRepairAgent } from '../src/agentResume.js';
import { CI_FIX_ATTEMPTS, renderFixPrompt, runCiWatchPhase } from '../src/ciWatch.js';
import type { WorkItemDelivery } from '../src/client.js';

// THE STORY GATE — THE SAME AGENT STAYS ON ITS PULL REQUEST (Story MOTIR-8981 · MOTIR-9057).
//
// The CLI half of the seam: the choice `chooseRepairAgent` makes from what the server
// recorded (`repair.resume`) is the command `runCiWatchPhase` hands its agent runner.
// Each child proved one side with the other mocked; here the REAL chooser feeds the
// REAL phase, and the only stub is the process boundary — `runAgentFn`, the seam the
// shipped phase already exposes. No process is spawned and nothing reaches a network.
//
// Which flags are a vendor's true resume form is MOTIR-9055's; this file asserts the
// SELECTION — the resumed command when the profile has one and the session is in that
// agent, the plain command otherwise.

const env = (profile: string): NodeJS.ProcessEnv => ({ MOTIR_SANDBOX_AGENT: profile });

function delivery(ci: WorkItemDelivery['ci']): WorkItemDelivery {
  return {
    repo: 'moooon/motir-core',
    number: 7,
    title: 'a change',
    url: 'https://github.com/moooon/motir-core/pull/7',
    state: 'open',
    ci,
    baseRef: 'main',
    defaultBranch: 'main',
  };
}

interface Call {
  command: ParsedAgentCommand;
  prompt: string;
  cwd: string;
}

/** Red for `reds` reads, then green — one read per watch iteration. */
async function watch(opts: {
  choice: ReturnType<typeof chooseRepairAgent>;
  reds: number;
  exitCode?: number;
}) {
  const calls: Call[] = [];
  let reads = 0;
  const outcome = await runCiWatchPhase({
    client: {
      getWorkItem: async () => {
        reads += 1;
        return { deliveries: [delivery(reads <= opts.reds ? 'failing' : 'passing')] } as never;
      },
    },
    key: 'PROD-7',
    title: 'the card',
    // Exactly the wiring `motir fix` uses: the chosen command resumes, `fresh` stands behind it.
    agent: opts.choice.fresh ?? opts.choice.parsed,
    ...(opts.choice.fresh ? { resumeAgent: opts.choice.parsed } : {}),
    cwd: '/work/checkout',
    report: () => {},
    wait: async () => {},
    runAgentFn: async (input) => {
      calls.push({ command: input.command, prompt: input.prompt, cwd: input.cwd });
      return { exitCode: opts.exitCode ?? 0, signal: null, model: null };
    },
  });
  return { outcome, calls };
}

describe('a recorded session is the session a fix resumes', () => {
  it('hands the agent runner the command carrying the recorded session, with the attempt’s own prompt', async () => {
    const choice = chooseRepairAgent(
      'PROD-7',
      { profile: 'claude', sessionId: 'S-1', canResume: true },
      env('claude'),
    );
    const { outcome, calls } = await watch({ choice, reds: 1 });

    expect(outcome).toEqual({ kind: 'green', attempts: 1 });
    expect(calls).toHaveLength(1);
    const command = calls[0]!.command;
    expect(command.stream?.sessionId).toBe('S-1');
    expect(command.args).toEqual(agentProfileById('claude')!.agentStream!.resumeArgs('S-1'));
    expect(command).not.toBe(choice.fresh);
    expect(calls[0]!.cwd).toBe('/work/checkout');
    expect(calls[0]!.prompt).toBe(
      renderFixPrompt({
        key: 'PROD-7',
        title: 'the card',
        failing: [delivery('failing')],
        attempt: 1,
      }),
    );
  });
});

/** A fresh claude run mints its own session id per build; mask it to compare the forms. */
const unminted = (args: readonly string[]): string[] =>
  args.map((a) =>
    a.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>'),
  );

describe('the resume falls back rather than failing', () => {
  const plain = (profile: string) => chooseRepairAgent('PROD-7', null, env(profile)).parsed;

  it.each([
    ['no session was recorded', { profile: 'claude', sessionId: null, canResume: true }, 'claude'],
    [
      'the session is in another agent',
      { profile: 'codex', sessionId: 'S', canResume: true },
      'claude',
    ],
    [
      'the agent has no resume form',
      { profile: 'claude', sessionId: 'S', canResume: false },
      'claude',
    ],
    ['there was no earlier run', null, 'claude'],
  ])('runs the agent once, unchanged, when %s', async (_why, resume, profile) => {
    const choice = chooseRepairAgent('PROD-7', resume, env(profile));
    expect(choice.fresh).toBeNull();

    const { outcome, calls } = await watch({ choice, reds: 1 });

    expect(outcome).toEqual({ kind: 'green', attempts: 1 });
    // The fallback is TAKEN, not refused: one launch for the one red, and it is the
    // plain command — `command` and `args` as the profile builds them.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command.binary).toBe(plain(profile).binary);
    expect(unminted(calls[0]!.command.args)).toEqual(unminted(plain(profile).args));
    expect(calls[0]!.command.stream?.sessionId).not.toBe('S');
  });

  it('ends fix_failed with the exit code, and does not re-run a failed resumed attempt fresh', async () => {
    const choice = chooseRepairAgent(
      'PROD-7',
      { profile: 'claude', sessionId: 'S-1', canResume: true },
      env('claude'),
    );
    const { outcome, calls } = await watch({ choice, reds: 5, exitCode: 3 });

    expect(outcome).toEqual({ kind: 'fix_failed', attempts: 1, detail: 'exit 3' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command.stream?.sessionId).toBe('S-1');
  });

  it('spends one of the five attempts per red — resumed attempts have no second budget', async () => {
    const choice = chooseRepairAgent(
      'PROD-7',
      { profile: 'claude', sessionId: 'S-1', canResume: true },
      env('claude'),
    );
    const { outcome, calls } = await watch({ choice, reds: 100 });

    expect(CI_FIX_ATTEMPTS).toBe(5);
    expect(calls).toHaveLength(CI_FIX_ATTEMPTS);
    expect(calls.every((c) => c.command.stream?.sessionId === 'S-1')).toBe(true);
    expect(outcome.kind).toBe('gave_up');
    expect(outcome.kind === 'gave_up' && outcome.attempts).toBe(CI_FIX_ATTEMPTS);
  });
});
