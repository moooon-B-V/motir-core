import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostedAgentEnv } from '../../src/hostedAgent.js';
// @ts-expect-error — a plain .mjs module with no type declarations
import { startProbeGateway } from './providerProbeGateway.mjs';

// THE OFFLINE PROVIDER PROBE (Story MOTIR-7205 · MOTIR-7208).
//
// The REAL OpenCode, configured ONLY by what the CLI ships (`hostedAgentEnv` →
// `OPENCODE_CONFIG_CONTENT` = the egress contract's §2 document), runs one turn
// on each enabled provider's model — DeepSeek, GLM (`z-ai`), Qwen and Anthropic
// (MOTIR-7244 added the middle two) — against a stub gateway, and the
// stub records what arrived. `smoke.test.ts` drives a FAKE OpenCode, so it cannot
// see a provider OpenCode fails to load; this is the check that can.
//
// What each run must show (motir-gateway `docs/hosted-run-egress.md` §2–§3):
//   - `deepseek/<id>`, `z-ai/<id>`, `qwen/<id>` → `POST /v1/chat/completions` carrying
//     `Authorization: Bearer <run key>`;
//   - `anthropic/<id>` → `POST /v1/messages` carrying `x-api-key: <run key>`;
//   - no request on any other route, and the run exits 0.
//
// Two layers, like the smoke test:
//   1. PROCESS — the binary named by `OPENCODE_BIN`, against an in-process stub.
//      Skipped when unset.
//   2. IMAGE — the BUILT image's own `opencode`, with the stub as a second
//      container from the same image, both on an `--internal` Docker network: the
//      container can reach the stub and NOTHING else, so a run that needed any
//      other outbound request (a catalog fetch, a provider package download)
//      fails here. Runs when `MOTIR_HOSTED_AGENT_IMAGE` names a built image
//      (`hosted-agent-image.yml`, before the publish step).

const HERE = dirname(fileURLToPath(import.meta.url));
const OPENCODE_BIN = process.env.OPENCODE_BIN?.trim() || null;
const IMAGE = process.env.MOTIR_HOSTED_AGENT_IMAGE?.trim() || null;
const RUN_KEY = 'sk-probe-run-key';
const PROMPT = 'Reply with the single word ok.';

interface ProbeRequest {
  method: string;
  path: string;
  apiKey: string | null;
  authorization: string | null;
  model: string | null;
}

/** The route and the credential header each enabled provider must use (contract §2–§3). */
const PROVIDERS = [
  {
    model: 'deepseek/deepseek-v4-pro',
    bare: 'deepseek-v4-pro',
    route: '/v1/chat/completions',
    credentialOf: (r: ProbeRequest) => r.authorization,
    credential: `Bearer ${RUN_KEY}`,
  },
  // GLM and Qwen (MOTIR-7244): CUSTOM providers on `@ai-sdk/openai-compatible`,
  // loadable only because the CLI writes the run's model into their block.
  {
    model: 'z-ai/glm-4.6',
    bare: 'glm-4.6',
    route: '/v1/chat/completions',
    credentialOf: (r: ProbeRequest) => r.authorization,
    credential: `Bearer ${RUN_KEY}`,
  },
  {
    model: 'qwen/qwen-plus',
    bare: 'qwen-plus',
    route: '/v1/chat/completions',
    credentialOf: (r: ProbeRequest) => r.authorization,
    credential: `Bearer ${RUN_KEY}`,
  },
  {
    model: 'anthropic/claude-sonnet-4-5',
    bare: 'claude-sonnet-4-5',
    route: '/v1/messages',
    credentialOf: (r: ProbeRequest) => r.apiKey,
    credential: RUN_KEY,
  },
] as const;

/** The two routes the contract names; anything else is a request it does not allow. */
const CONTRACT_ROUTES = new Set<string>(PROVIDERS.map((p) => p.route));

/**
 * Runs a process WITHOUT blocking the event loop — the in-process stub gateway has
 * to answer while OpenCode waits on it, which `spawnSync` would starve.
 */
function runAsync(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stderr });
    });
  });
}

function expectContractTraffic(
  provider: (typeof PROVIDERS)[number],
  requests: ProbeRequest[],
): void {
  expect(requests.length, 'OpenCode made no model call').toBeGreaterThan(0);
  for (const r of requests) {
    expect(CONTRACT_ROUTES.has(r.path), `a request on ${r.method} ${r.path}`).toBe(true);
    expect(r.method).toBe('POST');
  }
  const main = requests.filter((r) => r.model === provider.bare);
  expect(main.length, `no request for ${provider.bare}`).toBeGreaterThan(0);
  for (const r of main) {
    expect(r.path).toBe(provider.route);
    expect(provider.credentialOf(r)).toBe(provider.credential);
  }
}

describe.skipIf(!OPENCODE_BIN)('provider probe — PROCESS (OPENCODE_BIN)', () => {
  let server: Server;
  let url = '';
  const seen: ProbeRequest[] = [];

  beforeAll(async () => {
    server = await startProbeGateway(0, (r: ProbeRequest) => seen.push(r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());

  for (const provider of PROVIDERS) {
    it(`${provider.model} → ${provider.route} with the run key`, async () => {
      seen.length = 0;
      const home = mkdtempSync(join(tmpdir(), 'probe-home-'));
      const project = mkdtempSync(join(tmpdir(), 'probe-project-'));
      try {
        const env = hostedAgentEnv({
          PATH: process.env.PATH,
          HOME: home,
          MOTIR_GATEWAY_URL: url,
          MOTIR_RUN_KEY: RUN_KEY,
          // The run's model, which the CLI writes into a custom provider's block.
          MOTIR_MODEL: provider.model,
        });
        const run = await runAsync(OPENCODE_BIN!, ['run', '--model', provider.model, PROMPT], {
          cwd: project,
          env,
          timeoutMs: 120_000,
        });
        expect(run.status, `opencode exited ${run.status}: ${run.stderr}`).toBe(0);
        expectContractTraffic(provider, [...seen]);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(project, { recursive: true, force: true });
      }
    }, 150_000);
  }
});

describe.skipIf(!IMAGE)('provider probe — IMAGE (MOTIR_HOSTED_AGENT_IMAGE, offline)', () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const network = `motir-probe-${suffix}`;
  const gateway = `motir-probe-gw-${suffix}`;

  const docker = (args: string[], timeout = 120_000) =>
    spawnSync('docker', args, { encoding: 'utf8', timeout });

  function gatewayRequests(): ProbeRequest[] {
    const logs = docker(['logs', gateway]);
    return `${logs.stdout}`
      .split('\n')
      .filter((l) => l.startsWith('PROBE_REQUEST '))
      .map((l) => JSON.parse(l.slice('PROBE_REQUEST '.length)) as ProbeRequest);
  }

  beforeAll(() => {
    // `--internal`: no route off the network. The agent can reach the stub and nothing else.
    expect(docker(['network', 'create', '--internal', network]).status).toBe(0);
    const started = docker([
      'run',
      '-d',
      '--name',
      gateway,
      '--network',
      network,
      '-v',
      `${join(HERE, 'providerProbeGateway.mjs')}:/probe/providerProbeGateway.mjs:ro`,
      '--entrypoint',
      'node',
      IMAGE!,
      '/probe/providerProbeGateway.mjs',
      '8080',
    ]);
    expect(started.status, started.stderr).toBe(0);
    const deadline = Date.now() + 30_000;
    while (!docker(['logs', gateway]).stdout.includes('PROBE_READY')) {
      if (Date.now() > deadline) throw new Error('the probe gateway did not start');
      spawnSync('sleep', ['0.5']);
    }
  }, 60_000);

  afterAll(() => {
    docker(['rm', '-f', gateway]);
    docker(['network', 'rm', network]);
  });

  for (const provider of PROVIDERS) {
    it(`${provider.model} → ${provider.route} with the run key, and no other request`, () => {
      const before = gatewayRequests().length;
      const env = hostedAgentEnv({
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: '/home/node',
        MOTIR_GATEWAY_URL: `http://${gateway}:8080`,
        MOTIR_RUN_KEY: RUN_KEY,
        MOTIR_MODEL: provider.model,
      });
      const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v ?? ''}`]);
      const run = docker(
        [
          'run',
          '--rm',
          '--network',
          network,
          ...envArgs,
          '--entrypoint',
          'opencode',
          IMAGE!,
          'run',
          '--model',
          provider.model,
          PROMPT,
        ],
        180_000,
      );
      expect(run.status, `opencode in the image exited ${run.status}: ${run.stderr}`).toBe(0);
      expectContractTraffic(provider, gatewayRequests().slice(before));
    }, 200_000);
  }
});
