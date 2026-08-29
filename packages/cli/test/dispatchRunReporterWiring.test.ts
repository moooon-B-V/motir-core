import { describe, expect, it } from 'vitest';
import { runDispatchLeg, type DispatchLegInput } from '../src/dispatchLeg.js';
import { dispatchOne, type DispatchOneInput } from '../src/commands/auto.js';
import type { DispatchRunReporter } from '../src/dispatchRunReporter.js';
import type { DispatchTarget } from '../src/dispatch.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import type { DispatchItem, DispatchPrompt, DispatchRunEventInput } from '../src/client.js';

// THE REPORTER'S WIRING (Story MOTIR-1789 · MOTIR-1794).
//
// ⚠️ THE CLI HAS **TWO** PER-CARD PIPELINES, AND BOTH ARE HOOKED. `dispatchLeg`
// serves `motir next` / `motir run <KEY>` / `motir batch`; `auto.ts`'s
// `dispatchOne` serves `motir auto` AND the scoped drain, which reuses it
// verbatim. Hooking one and not the other would leave half the commands
// reporting nothing — and it would look fine, because each half's own tests
// would pass.
//
// So the claim under test is that a card dispatched through EITHER pipeline
// produces the same event sequence. That is asserted by driving both and
// comparing, rather than by two independent expectations that could drift apart
// the way the pipelines themselves once could.

const ROOT = '/home/yue/work';

function target(over: Partial<DispatchTarget> = {}): DispatchTarget {
  return {
    cwd: `${ROOT}/motir-core`,
    reason: 'repo_checkout',
    targetRepo: 'motir-core',
    repoPath: `${ROOT}/motir-core`,
    repoSource: 'convention',
    verifyCheckoutAfterRun: false,
    cloneUrl: null,
    ...over,
  } as DispatchTarget;
}

const PROMPT = {
  key: 'PROD-1',
  prompt: 'DO THE WORK',
  parentKey: null,
  targetRepo: 'motir-core',
  workflowMode: 'per_item_pr',
  sessionBranch: null,
} as unknown as DispatchPrompt;

function git(pushed: boolean): CommandRunner {
  return (_bin: string, args: string[]): CommandResult =>
    args[0] === 'ls-remote'
      ? { exitCode: 0, stdout: pushed ? 'abc\trefs/heads/x' : '', stderr: '' }
      : { exitCode: 0, stdout: '', stderr: '' };
}

/** A reporter that records what it was told, and nothing else. */
function recorder(): DispatchRunReporter & { events: DispatchRunEventInput[] } {
  const events: DispatchRunEventInput[] = [];
  return {
    events,
    async open() {},
    async addCard() {},
    event(e) {
      events.push(e);
    },
    async flush() {},
    async close() {},
    offline: false,
    runId: 'run_1',
  };
}

async function throughLeg(over: { status?: string; pushed?: boolean; exitCode?: number } = {}) {
  const reporter = recorder();
  const primary = target();
  const input: DispatchLegInput = {
    client: {
      getWorkItem: async () => ({ item: { status: over.status ?? 'in_progress' } }) as never,
    },
    rootDir: ROOT,
    key: 'PROD-1',
    dispatch: PROMPT,
    agent: { command: 'fake-agent', binary: 'fake-agent', args: [] },
    targets: [primary],
    primary,
    sessionBranch: null,
    onMaterialization: () => {},
    beforeSpawn: () => {},
    runAgentFn: async () => ({
      exitCode: over.exitCode ?? 0,
      signal: null,
      model: 'claude-opus-5',
    }),
    run: git(over.pushed ?? true),
    reporter,
  };
  const verdict = await runDispatchLeg(input);
  return { reporter, verdict };
}

function item(key: string): DispatchItem {
  return {
    key,
    kind: 'subtask',
    title: `Item ${key}`,
    priority: 'medium',
    status: { key: 'in_progress', category: 'in_progress' },
    assigneeId: 'user_me',
    type: 'code',
    executor: 'coding_agent',
    inheritedSessionBranch: null,
  } as DispatchItem;
}

async function throughDispatchOne(
  over: { status?: string; pushed?: boolean; exitCode?: number } = {},
) {
  const reporter = recorder();
  const primary = target();
  const input: DispatchOneInput = {
    client: {
      claimWorkItem: async () => ({ outcome: 'claimed', claimed: true }) as never,
      getWorkItem: async () => ({ item: { status: over.status ?? 'in_review' } }) as never,
      transitionStatus: async () => {},
      markIntegrated: async () => ({}) as never,
    } as never,
    item: item('PROD-1'),
    dispatch: PROMPT,
    target: primary,
    repos: ['motir-core'],
    targets: [primary],
    agent: { parsed: { command: 'fake-agent', binary: 'fake-agent', args: [] }, source: 'flag' },
    clock: () => 0,
    runAgentFn: async () => ({
      exitCode: over.exitCode ?? 0,
      signal: null,
      model: 'claude-opus-5',
    }),
    opts: {},
    onIntegrated: () => {},
    run: git(over.pushed ?? true),
    reporter,
  } as unknown as DispatchOneInput;
  const outcome = await dispatchOne(input);
  return { reporter, outcome };
}

describe('BOTH per-card pipelines report, and they report the same thing', () => {
  it('a SUCCESSFUL card produces the same event kinds through either pipeline', async () => {
    const leg = await throughLeg();
    const one = await throughDispatchOne();

    const legKinds = leg.reporter.events.map((e) => e.kind);
    const oneKinds = one.reporter.events.map((e) => e.kind);

    // Both spawn and both report the spawn, the exit and the settlement. The
    // LEG additionally reports its own two structural moments (`checkout_ready`
    // and the typed `leg_verdict`), which `dispatchOne` does not have because it
    // materializes elsewhere — so the shared core is compared rather than the
    // full sequence, and the shared core is what a card's timeline is made of.
    const shared = ['prompt_issued', 'agent_started', 'agent_exited'];
    expect(legKinds.filter((k) => shared.includes(k))).toEqual(shared);
    expect(oneKinds.filter((k) => shared.includes(k))).toEqual(shared);

    // And both end on a terminal statement about the card.
    expect(legKinds.at(-1)).toBe('leg_verdict');
    expect(oneKinds.at(-1)).toBe('card_settled');
  });

  it('reports the agent’s SELF-REPORTED model, and never a guess', async () => {
    const { reporter } = await throughLeg();
    const exited = reporter.events.find((e) => e.kind === 'agent_exited');
    expect((exited?.data as { model: string | null }).model).toBe('claude-opus-5');
    expect(exited?.exitCode).toBe(0);
  });

  it('reports a null model when the agent made no report — never an invention', async () => {
    const reporter = recorder();
    const primary = target();
    await runDispatchLeg({
      client: { getWorkItem: async () => ({ item: { status: 'in_review' } }) as never },
      rootDir: ROOT,
      key: 'PROD-1',
      dispatch: PROMPT,
      agent: { command: 'fake-agent', binary: 'fake-agent', args: [] },
      targets: [primary],
      primary,
      sessionBranch: null,
      onMaterialization: () => {},
      beforeSpawn: () => {},
      // No `model` at all — the agent wrote no self-report.
      runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      run: git(true),
      reporter,
    } as DispatchLegInput);

    const exited = reporter.events.find((e) => e.kind === 'agent_exited');
    expect((exited?.data as { model: string | null }).model).toBeNull();
  });
});

describe('a REFUSED card is reported as replanned, not as a failure', () => {
  it('through the leg', async () => {
    const { reporter, verdict } = await throughLeg({ status: 'planning', pushed: false });
    expect(verdict.kind).toBe('replan_submitted');
    // ⚠️ `replanned`, not `failed`. The agent read its card, found the premise
    // false and exited 0 — a correct outcome. A run page that drew it as a
    // failure would teach an operator to ignore failures.
    expect(reporter.events.at(-1)).toMatchObject({
      kind: 'leg_verdict',
      disposition: 'replanned',
    });
  });

  it('through dispatchOne', async () => {
    const { reporter, outcome } = await throughDispatchOne({ status: 'planning', pushed: false });
    expect(outcome.kind).toBe('record');
    expect(reporter.events.at(-1)).toMatchObject({
      kind: 'card_settled',
      disposition: 'replanned',
    });
  });
});

describe('a FAILED agent is reported as failed, through either pipeline', () => {
  it('through the leg', async () => {
    const { reporter, verdict } = await throughLeg({ exitCode: 3 });
    expect(verdict.kind).toBe('agent_failed');
    expect(reporter.events.find((e) => e.kind === 'agent_exited')?.exitCode).toBe(3);
    expect(reporter.events.at(-1)).toMatchObject({ kind: 'leg_verdict', disposition: 'failed' });
  });

  it('through dispatchOne', async () => {
    const { reporter } = await throughDispatchOne({ exitCode: 3 });
    expect(reporter.events.at(-1)).toMatchObject({
      kind: 'card_settled',
      disposition: 'failed',
    });
  });
});

describe('the pipelines default to the NULL reporter', () => {
  it('the leg runs unchanged with no reporter at all', async () => {
    const primary = target();
    const verdict = await runDispatchLeg({
      client: { getWorkItem: async () => ({ item: { status: 'in_review' } }) as never },
      rootDir: ROOT,
      key: 'PROD-1',
      dispatch: PROMPT,
      agent: { command: 'fake-agent', binary: 'fake-agent', args: [] },
      targets: [primary],
      primary,
      sessionBranch: null,
      onMaterialization: () => {},
      beforeSpawn: () => {},
      runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      run: git(true),
    } as DispatchLegInput);

    // Wiring the reporter in was NOT a behaviour change: with none supplied the
    // verdict is exactly what it was, which is why every pre-existing caller and
    // every pre-existing spec keeps working.
    expect(verdict.kind).toBe('succeeded');
  });
});
