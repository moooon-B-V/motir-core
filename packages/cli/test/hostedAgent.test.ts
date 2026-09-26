import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgent } from '../src/agentRun.js';
import { resetHostedRun, setActiveHostedRun } from '../src/hostedAttribution.js';
import {
  EGRESS_DOCUMENT,
  egressConfig,
  HOSTED_AGENT_ENV_KEYS,
  hostedAgentEnv,
  hostedOpenCodeAgent,
} from '../src/hostedAgent.js';

// THE HOSTED RUN'S AGENT (MOTIR-6559) — OpenCode, launched by the CLI on the
// run's model through the gateway key, on an ALLOW-LISTED environment (AC3).

const HERE = fileURLToPath(new URL('.', import.meta.url));
const EGRESS_FILE = join(HERE, '..', 'sandbox', 'hosted', 'opencode.egress.json');

const RUN_KEY = 'rk_live_the_gateway_key';
const RUN_TOKEN = 'mrt_the_run_credential';

/** The environment a hosted container boots the CLI with, plus things that must not leak. */
function containerEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/run/bin:/usr/bin',
    HOME: '/home/agent',
    LANG: 'C.UTF-8',
    MOTIR_MODEL: 'anthropic/claude-sonnet-5',
    MOTIR_GATEWAY_URL: 'https://gateway.motir.test',
    MOTIR_RUN_KEY: RUN_KEY,
    MOTIR_RUN_TOKEN: RUN_TOKEN,
    MOTIR_API_URL: 'https://app.motir.test',
    MOTIR_DISPATCH_RUN_ID: 'run_1',
    MOTIR_AGENT: 'claude --dangerously-skip-permissions',
    GITHUB_TOKEN: 'ghs_should_never_reach_the_agent',
    GIT_CONFIG_GLOBAL: '/tmp/state/gitconfig',
    GIT_TERMINAL_PROMPT: '0',
  };
}

afterEach(() => resetHostedRun());

describe('hostedOpenCodeAgent (AC3)', () => {
  it('launches `opencode run --model <model> --auto`, the prompt on argv, stdin unconnected', () => {
    const agent = hostedOpenCodeAgent(containerEnv());
    expect(agent.binary).toBe('opencode');
    expect(agent.args).toEqual(['run', '--model', 'anthropic/claude-sonnet-5', '--auto']);
    expect(agent.promptOnStdin).toBe(false);
  });

  it('gives the agent ONLY the allow-listed environment — no run credential, no git token', () => {
    const env = hostedOpenCodeAgent(containerEnv()).env!;
    for (const key of Object.keys(env)) {
      expect(HOSTED_AGENT_ENV_KEYS as readonly string[]).toContain(key);
    }
    expect(env['MOTIR_RUN_TOKEN']).toBeUndefined();
    expect(env['MOTIR_API_URL']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['MOTIR_AGENT']).toBeUndefined();
    // No value anywhere carries the run credential.
    expect(Object.values(env).some((v) => v?.includes(RUN_TOKEN))).toBe(false);
    // The gateway key appears ONLY under the one name the egress document reads.
    const holders = Object.entries(env).filter(([, v]) => v?.includes(RUN_KEY));
    expect(holders.map(([k]) => k)).toEqual(['MOTIR_RUN_KEY']);
    // …and the run's git setup travels with it.
    expect(env['GIT_CONFIG_GLOBAL']).toBe('/tmp/state/gitconfig');
  });

  it('the egress document the CLI owns is the one the hosted image still carries (pinned until MOTIR-6560)', () => {
    expect(EGRESS_DOCUMENT).toEqual(JSON.parse(readFileSync(EGRESS_FILE, 'utf8')));
  });

  it('configures OpenCode with exactly the egress contract document', () => {
    const env = hostedAgentEnv(containerEnv());
    expect(JSON.parse(env['OPENCODE_CONFIG_CONTENT']!)).toEqual(
      JSON.parse(readFileSync(EGRESS_FILE, 'utf8')),
    );
    expect(JSON.parse(egressConfig()).provider.anthropic.options.apiKey).toBe(
      '{env:MOTIR_RUN_KEY}',
    );
    expect(env['OPENCODE_DISABLE_AUTOUPDATE']).toBe('true');
    expect(env['OPENCODE_DISABLE_MODELS_FETCH']).toBe('true');
    expect(env['OPENCODE_DISABLE_CLAUDE_CODE']).toBe('true');
  });

  it('refuses a missing run model, gateway or key, and a model outside the anthropic provider', () => {
    const env = containerEnv();
    delete env['MOTIR_RUN_KEY'];
    expect(() => hostedOpenCodeAgent(env)).toThrow(/missing MOTIR_RUN_KEY/);
    expect(() => hostedOpenCodeAgent({ ...containerEnv(), MOTIR_MODEL: 'gpt-5' })).toThrow(
      /must be "anthropic\/<model id>"/,
    );
  });
});

describe('runAgent with the hosted launcher', () => {
  /** A spawn that records what it was given and exits 0. */
  function recordingSpawn() {
    const seen: { cmd: string; args: string[]; opts: SpawnOptions }[] = [];
    const spawnFn = (cmd: string, args: string[], opts: SpawnOptions): ChildProcess => {
      seen.push({ cmd, args, opts });
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { stdin: null, stdout: null, stderr: null });
      setImmediate(() => child.emit('close', 0, null));
      return child;
    };
    return { seen, spawnFn };
  }

  it('spawns OpenCode with the prompt plus the hosted addendum, on the allow-listed env', async () => {
    setActiveHostedRun({
      runId: 'run_1',
      serverUrl: 'https://app.motir.test',
      targetKey: 'PROD-7',
      dispatchedBy: 'Yue Zhu',
      stateDir: '/tmp/state',
    });
    const { seen, spawnFn } = recordingSpawn();
    const dir = mkdtempSync(join(tmpdir(), 'motir-hosted-agent-'));
    try {
      const result = await runAgent({
        command: hostedOpenCodeAgent(containerEnv()),
        prompt: 'PROMPT PROD-7',
        cwd: dir,
        spawnFn,
        tempDirFactory: () => mkdtempSync(join(tmpdir(), 'motir-hosted-prompt-')),
      });
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const { cmd, args, opts } = seen[0]!;
    expect(cmd).toBe('opencode');
    expect(args.slice(0, 4)).toEqual(['run', '--model', 'anthropic/claude-sonnet-5', '--auto']);
    const message = args[4]!;
    expect(message.startsWith('PROMPT PROD-7')).toBe(true);
    expect(message).toContain('Dispatched by Yue Zhu');
    expect(message).toContain('https://app.motir.test/runs/run_1');
    expect((opts.stdio as unknown[])[0]).toBe('ignore');
    const env = opts.env!;
    expect(env['MOTIR_RUN_TOKEN']).toBeUndefined();
    expect(env['MOTIR_PROMPT_FILE']).toBeTruthy();
  });

  it('attaches a prompt too long for argv as a file', async () => {
    const { seen, spawnFn } = recordingSpawn();
    await runAgent({
      command: hostedOpenCodeAgent(containerEnv()),
      prompt: 'x'.repeat(200 * 1024),
      cwd: tmpdir(),
      spawnFn,
      tempDirFactory: () => mkdtempSync(join(tmpdir(), 'motir-hosted-prompt-')),
    });
    const args = seen[0]!.args;
    expect(args[4]).toBe('--file');
    expect(args[5]).toMatch(/prompt\.md$/);
    expect(args[6]).toMatch(/^Carry out the task described in the attached file\./);
  });
});
