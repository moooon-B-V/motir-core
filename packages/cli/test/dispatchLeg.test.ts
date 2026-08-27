import { describe, expect, it } from 'vitest';
import { runDispatchLeg, type DispatchLegInput } from '../src/dispatchLeg.js';
import type { DispatchTarget } from '../src/dispatch.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import type { AgentRunResult } from '../src/agentRun.js';
import type { DispatchPrompt } from '../src/client.js';

// THE DISPATCH LEG (Story MOTIR-3655 · MOTIR-3695) — the ONE implementation of
// materialize, spawn, and decide what happened, now shared by `motir run` and
// `motir batch`.
//
// Driven directly, with an injected agent and an injected git runner, because
// the four rules it carries are ORDERING rules and ordering is exactly what a
// test through either command cannot see:
//
//   * materialize BEFORE the spawn (MOTIR-3588) — a clone that cannot happen
//     must not first cost a session's tokens;
//   * echo the prompt BEFORE the spawn (MOTIR-3052);
//   * the replan read BEFORE the push check (MOTIR-3018 before MOTIR-3004) —
//     a refusing agent reverts and pushes nothing BY DESIGN, so the other order
//     reports a correctly-refused card as work that went missing.
//
// The last one is the reason this file exists: it is a rule about which of two
// true statements to report, it was written twice, and each copy explained it in
// its own words.

const ROOT = '/home/yue/work';

function target(over: Partial<DispatchTarget> = {}): DispatchTarget {
  return {
    cwd: `${ROOT}/motir-core`,
    reason: 'repo_checkout',
    targetRepo: 'motir-core',
    repoPath: `${ROOT}/motir-core`,
    verifyCheckoutAfterRun: false,
    cloneUrl: null,
    ...over,
  } as DispatchTarget;
}

const PROMPT = { prompt: 'DO THE WORK', workflowMode: 'per_item_pr' } as unknown as DispatchPrompt;

/** A git runner whose `ls-remote` says the agent pushed, unless told otherwise. */
function git(pushed: boolean): CommandRunner {
  return (_bin: string, args: string[]): CommandResult =>
    args[0] === 'ls-remote'
      ? {
          exitCode: 0,
          stdout: pushed ? 'abc123\trefs/heads/subtask/PROD-1' : '',
          stderr: '',
        }
      : { exitCode: 0, stdout: '', stderr: '' };
}

interface LegHarness {
  order: string[];
  verdict: Awaited<ReturnType<typeof runDispatchLeg>>;
}

async function leg(
  over: {
    status?: string;
    agent?: Partial<AgentRunResult>;
    pushed?: boolean;
    targets?: DispatchTarget[];
    primary?: DispatchTarget;
    run?: CommandRunner;
  } = {},
): Promise<LegHarness> {
  const order: string[] = [];
  const primary = over.primary ?? target();
  const input: DispatchLegInput = {
    client: {
      getWorkItem: async () => {
        order.push('replan-read');
        return { item: { status: over.status ?? 'in_progress' } } as never;
      },
    },
    rootDir: ROOT,
    key: 'PROD-1',
    dispatch: PROMPT,
    agent: { command: 'fake-agent', binary: 'fake-agent', args: [] },
    targets: over.targets ?? [primary],
    primary,
    sessionBranch: null,
    onMaterialization: () => order.push('materialize'),
    beforeSpawn: () => order.push('echo'),
    runAgentFn: async () => {
      order.push('spawn');
      return { exitCode: 0, signal: null, model: null, ...over.agent };
    },
    run:
      over.run ??
      (((bin: string, args: string[], cwd: string) => {
        if (args[0] === 'ls-remote') order.push('push-check');
        return git(over.pushed ?? true)(bin, args, cwd);
      }) satisfies CommandRunner),
  };
  return { order, verdict: await runDispatchLeg(input) };
}

describe('the leg runs its steps in the ONE order that is correct', () => {
  it('materializes and echoes BEFORE it spawns', async () => {
    const { order } = await leg();

    expect(order.indexOf('materialize')).toBeLessThan(order.indexOf('spawn'));
    expect(order.indexOf('echo')).toBeLessThan(order.indexOf('spawn'));
  });

  it('asks the CARD what happened before it asks GIT — the rule that was written twice', async () => {
    const { order } = await leg();

    // MOTIR-3018 before MOTIR-3004. A refusing agent reverts and pushes nothing
    // by design, so the other order would report it as work that went missing.
    expect(order.indexOf('replan-read')).toBeLessThan(order.indexOf('push-check'));
  });

  it('reports a REPLAN rather than a missing push, even though nothing was pushed', async () => {
    // Both statements are true about this run. The leg has to report the one
    // that describes what the agent DID.
    const { verdict, order } = await leg({ status: 'planning', pushed: false });

    expect(verdict.kind).toBe('replan_submitted');
    expect(order).not.toContain('push-check');
  });
});

describe('the verdicts', () => {
  it('succeeds with the agent’s self-reported model', async () => {
    const { verdict } = await leg({ agent: { model: 'claude-opus-5' } });

    expect(verdict).toEqual({ kind: 'succeeded', model: 'claude-opus-5', suspects: [] });
  });

  it('carries a NULL model for an agent that reported nothing — never a guess', async () => {
    const { verdict } = await leg();

    expect(verdict.kind === 'succeeded' && verdict.model).toBeNull();
  });

  it('fails on a non-zero exit, naming the signal when it was killed', async () => {
    const { verdict, order } = await leg({ agent: { exitCode: 137, signal: 'SIGKILL' } });

    expect(verdict).toEqual({ kind: 'agent_failed', exitCode: 137, signal: 'SIGKILL' });
    // And it asked nothing else: a failed agent's card is not interrogated.
    expect(order).not.toContain('replan-read');
    expect(order).not.toContain('push-check');
  });

  it('reports nothing_pushed when exit 0 left the remote untouched', async () => {
    const { verdict } = await leg({ pushed: false });

    expect(verdict.kind).toBe('nothing_pushed');
  });

  it('checks EVERY repository for its bootstrap checkout, not just the primary', async () => {
    // MOTIR-3133 — a card whose second half had no checkout to happen in is
    // exactly the run that otherwise exits 0 with half the work missing.
    const primary = target();
    const second = target({
      cwd: `${ROOT}/motir-ai`,
      targetRepo: 'motir-ai',
      repoPath: `${ROOT}/definitely-not-here`,
      verifyCheckoutAfterRun: true,
    });

    const { verdict } = await leg({ targets: [primary, second], primary });

    expect(verdict.kind).toBe('succeeded');
    expect(verdict.kind === 'succeeded' && verdict.suspects.map((s) => s.repoName)).toEqual([
      'motir-ai',
    ]);
  });

  it('REPORTS the suspects and does not decide — the two commands disagree on purpose', async () => {
    // `motir run` treats a missing bootstrap checkout as a warning and still
    // records the card implemented; `motir batch` treats it as a failed
    // dispatch. That difference predates the leg, so the leg hands both of them
    // a `succeeded` verdict carrying the evidence rather than choosing.
    const primary = target({
      repoPath: `${ROOT}/definitely-not-here`,
      verifyCheckoutAfterRun: true,
    });

    const { verdict } = await leg({ targets: [], primary });

    expect(verdict.kind).toBe('succeeded');
    expect(verdict.kind === 'succeeded' && verdict.suspects).toHaveLength(1);
  });
});
