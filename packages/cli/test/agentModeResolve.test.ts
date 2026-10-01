import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// AGENT MODE's two pure halves (MOTIR-7024, `agent-instance-run.md` §2–§3):
// WHICH agent `resolveAgent` launches when a run id arrives with
// `MOTIR_AGENT_RUN=1`, and where the run's access and checkouts come from.
// The hosted launcher is replaced by a spy that fails the test if it is ever
// reached — an agent never runs OpenCode on Motir's gateway.

const hostedOpenCodeAgent = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('the hosted OpenCode launcher was reached');
  }),
);
vi.mock('../src/hostedAgent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/hostedAgent.js')>()),
  hostedOpenCodeAgent,
}));

const { resolveAgent, agentModeAgent } = await import('../src/commands/dispatch.js');
const { AgentProfileCannotRunError } = await import('../src/errors.js');
const {
  agentRunStateDir,
  agentRunWorkspace,
  isAgentRun,
  pinAgentRunStateHome,
  readAgentRunAccess,
} = await import('../src/hostedMode.js');

/** An environment that records every name read from it. */
function recording(values: Record<string, string>): { env: NodeJS.ProcessEnv; read: string[] } {
  const read: string[] = [];
  const env = new Proxy(values as NodeJS.ProcessEnv, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') read.push(prop);
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return { env, read };
}

const tmp: string[] = [];
afterEach(() => {
  for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true });
  hostedOpenCodeAgent.mockClear();
});

describe('resolveAgent in agent mode', () => {
  it('resolves the image’s profile to its unattended command, sourced `agent`', () => {
    const { env, read } = recording({
      MOTIR_AGENT_RUN: '1',
      MOTIR_SANDBOX_AGENT: 'claude',
      MOTIR_AGENT: 'codex --yolo',
      PATH: '/bin',
    });

    const agent = resolveAgent({ runId: 'run-1' }, env, () => 'opencode');

    expect(agent?.source).toBe('agent');
    expect(agent?.parsed.command).toBe('claude -p --dangerously-skip-permissions');
    expect(agent?.parsed.promptAddendum).toBeTypeOf('function');
    // Never the hosted launcher, never its gateway pair, never a local choice.
    expect(hostedOpenCodeAgent).not.toHaveBeenCalled();
    for (const name of ['MOTIR_RUN_KEY', 'MOTIR_GATEWAY_URL', 'MOTIR_MODEL']) {
      expect(read).not.toContain(name);
    }
    expect(agent?.parsed.env?.['MOTIR_AGENT']).toBe('codex --yolo');
  });

  it('ignores --agent, MOTIR_AGENT and the config in agent mode', () => {
    const agent = resolveAgent(
      { runId: 'run-1', agent: 'aider' },
      { MOTIR_AGENT_RUN: '1', MOTIR_SANDBOX_AGENT: 'codex', MOTIR_AGENT: 'goose' },
      () => 'opencode',
    );
    expect(agent?.parsed.command).toBe('codex exec --sandbox danger-full-access -');
  });

  it('refuses a profile with no unattended command, with a typed error naming it', () => {
    const run = () =>
      resolveAgent({ runId: 'run-1' }, { MOTIR_AGENT_RUN: '1', MOTIR_SANDBOX_AGENT: 'cursor' });
    expect(run).toThrow(AgentProfileCannotRunError);
    expect(run).toThrow(/cursor agent has no unattended mode/);
    try {
      run();
    } catch (err) {
      expect(err).toMatchObject({ code: 'agent_profile_cannot_run', profile: 'cursor' });
    }
    expect(hostedOpenCodeAgent).not.toHaveBeenCalled();
  });

  it('refuses when the image names no profile, or one Motir does not know', () => {
    expect(() => agentModeAgent({})).toThrow(/needs MOTIR_SANDBOX_AGENT/);
    expect(() => agentModeAgent({ MOTIR_SANDBOX_AGENT: 'gemini' })).toThrow(
      /"gemini" is not a coding agent Motir knows/,
    );
  });

  it('without the marker, a run id is still the HOSTED run (unchanged)', () => {
    expect(() => resolveAgent({ runId: 'run-1' }, { MOTIR_AGENT_RUN: '0' })).toThrow(
      /the hosted OpenCode launcher was reached/,
    );
    expect(hostedOpenCodeAgent).toHaveBeenCalledTimes(1);
  });

  it('without a run id, the marker changes nothing — a local run resolves as always', () => {
    expect(resolveAgent({}, { MOTIR_AGENT_RUN: '1', MOTIR_AGENT: 'aider' })).toMatchObject({
      source: 'env',
    });
  });
});

describe('agent mode’s state, access and workspace', () => {
  function state(runJson: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'motir-run-'));
    tmp.push(dir);
    writeFileSync(join(dir, 'run.json'), JSON.stringify(runJson));
    return dir;
  }

  it('is on only for an exact 1', () => {
    expect(isAgentRun({ MOTIR_AGENT_RUN: '1' })).toBe(true);
    expect(isAgentRun({ MOTIR_AGENT_RUN: ' 1 ' })).toBe(true);
    expect(isAgentRun({ MOTIR_AGENT_RUN: 'true' })).toBe(false);
    expect(isAgentRun({})).toBe(false);
  });

  it('reads the run’s access from run.json in its state directory — never a token env var', () => {
    const dir = state({ apiUrl: 'https://motir.test', runId: 'run-1', token: 'mrt_1' });
    expect(
      readAgentRunAccess('run-1', { MOTIR_HOSTED_STATE: dir, MOTIR_TOKEN: 'mtk_developer' }),
    ).toEqual({ apiUrl: 'https://motir.test', runId: 'run-1', token: 'mrt_1', stateDir: dir });
  });

  it('refuses a missing state directory, a missing run.json, and one for another run', () => {
    expect(() => agentRunStateDir({})).toThrow(/needs MOTIR_HOSTED_STATE/);
    const empty = mkdtempSync(join(tmpdir(), 'motir-run-'));
    tmp.push(empty);
    expect(() => readAgentRunAccess('run-1', { MOTIR_HOSTED_STATE: empty })).toThrow(
      /No hosted run is set up/,
    );
    const other = state({ apiUrl: 'https://motir.test', runId: 'run-2', token: 'mrt_2' });
    expect(() => readAgentRunAccess('run-1', { MOTIR_HOSTED_STATE: other })).toThrow(
      /is for run run-2, not run-1/,
    );
  });

  it('puts the checkouts under ~/.motir/runs/<id> unless the launcher named a workspace', () => {
    expect(agentRunWorkspace('run-1', {}, '/home/node')).toBe('/home/node/.motir/runs/run-1');
    expect(agentRunWorkspace('run-1', { MOTIR_WORKSPACE: '/w' }, '/home/node')).toBe('/w');
  });

  it('pins the CLI’s own state into the run’s directory — only in agent mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'motir-run-'));
    tmp.push(dir);
    mkdirSync(dir, { recursive: true });
    const local: NodeJS.ProcessEnv = { MOTIR_HOSTED_STATE: dir };
    pinAgentRunStateHome(local);
    expect(local['MOTIR_STATE_HOME']).toBeUndefined();
    const agent: NodeJS.ProcessEnv = { MOTIR_AGENT_RUN: '1', MOTIR_HOSTED_STATE: dir };
    pinAgentRunStateHome(agent);
    expect(agent['MOTIR_STATE_HOME']).toBe(join(dir, 'cli-state'));
    const noState: NodeJS.ProcessEnv = { MOTIR_AGENT_RUN: '1' };
    pinAgentRunStateHome(noState);
    expect(noState['MOTIR_STATE_HOME']).toBeUndefined();
  });
});
