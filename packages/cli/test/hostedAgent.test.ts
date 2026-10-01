import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * The gateway's egress contract §2 (`motir-gateway` `docs/hosted-run-egress.md`),
 * pinned HERE as well as in the CLI — so an edit to `EGRESS_DOCUMENT` is a
 * visible, deliberate change to the security boundary rather than a silent one.
 * (The hosted image carried its own copy until MOTIR-6560; the CLI now owns the
 * only one, and this literal is what holds it to the contract.)
 *
 * Pinned to §2 as amended by MOTIR-7207 (story MOTIR-7205) — motir-gateway commit
 * `7d96eda` on `parent/MOTIR-7205-hosted-deepseek`: `anthropic` AND `deepseek`, both
 * at the gateway on the run key.
 */
const EGRESS_CONTRACT_SECTION_2 = {
  $schema: 'https://opencode.ai/config.json',
  enabled_providers: ['anthropic', 'deepseek'],
  provider: {
    anthropic: {
      options: {
        baseURL: '{env:MOTIR_GATEWAY_URL}/v1',
        apiKey: '{env:MOTIR_RUN_KEY}',
      },
    },
    deepseek: {
      options: {
        baseURL: '{env:MOTIR_GATEWAY_URL}/v1',
        apiKey: '{env:MOTIR_RUN_KEY}',
      },
    },
  },
  share: 'disabled',
  autoupdate: false,
};

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

  it('the egress document the CLI owns is the egress contract §2, verbatim', () => {
    expect(EGRESS_DOCUMENT).toEqual(EGRESS_CONTRACT_SECTION_2);
  });

  it('configures OpenCode with exactly the egress contract document', () => {
    const env = hostedAgentEnv(containerEnv());
    expect(JSON.parse(env['OPENCODE_CONFIG_CONTENT']!)).toEqual(EGRESS_CONTRACT_SECTION_2);
    expect(JSON.parse(egressConfig()).provider.anthropic.options.apiKey).toBe(
      '{env:MOTIR_RUN_KEY}',
    );
    expect(JSON.parse(egressConfig()).provider.deepseek.options.apiKey).toBe('{env:MOTIR_RUN_KEY}');
    expect(env['OPENCODE_DISABLE_AUTOUPDATE']).toBe('true');
    expect(env['OPENCODE_DISABLE_MODELS_FETCH']).toBe('true');
    expect(env['OPENCODE_DISABLE_CLAUDE_CODE']).toBe('true');
  });

  it('refuses a missing run model, gateway or key, and a model outside the enabled providers', () => {
    const env = containerEnv();
    delete env['MOTIR_RUN_KEY'];
    expect(() => hostedOpenCodeAgent(env)).toThrow(/missing MOTIR_RUN_KEY/);
    for (const model of ['gpt-5', 'openai/gpt-5', 'deepseek/', '/deepseek-v4-pro']) {
      expect(() => hostedOpenCodeAgent({ ...containerEnv(), MOTIR_MODEL: model })).toThrow(
        /must be "<provider>\/<model id>" with provider one of anthropic, deepseek/,
      );
    }
  });

  it('launches a DeepSeek model with both providers configured (MOTIR-7208)', () => {
    const agent = hostedOpenCodeAgent({
      ...containerEnv(),
      MOTIR_MODEL: 'deepseek/deepseek-v4-pro',
    });
    expect(agent.args).toEqual(['run', '--model', 'deepseek/deepseek-v4-pro', '--auto']);
    const config = JSON.parse(agent.env!['OPENCODE_CONFIG_CONTENT']!);
    expect(config.enabled_providers).toEqual(['anthropic', 'deepseek']);
    expect(Object.keys(config.provider)).toEqual(['anthropic', 'deepseek']);
  });

  it('leaves an Anthropic model exactly as it was (MOTIR-7208)', () => {
    expect(hostedOpenCodeAgent(containerEnv()).args).toEqual([
      'run',
      '--model',
      'anthropic/claude-sonnet-5',
      '--auto',
    ]);
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
