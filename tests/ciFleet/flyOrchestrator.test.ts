import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_METADATA_KEY,
  FLEET_METADATA_VALUE,
  flyOrchestrator,
} from '@/lib/orchestrator/adapters/fly';
import { flyFleetConfig, isFlyFleetConfigured } from '@/lib/orchestrator/adapters/fly/flyMachines';
import { FLEET_CONTAINER_SIZE } from '@/lib/orchestrator/rates';
import { OrchestratorNotConfiguredError } from '@/lib/orchestrator/errors';
import type { ContainerHandle, ContainerSpec, UsageAttribution } from '@/lib/orchestrator/types';

// The FLY adapter's wire (Story MOTIR-1916 · MOTIR-1921) — what the port turns
// into on `api.machines.dev`, and what each provider answer means.
//
// The assertions the card names as acceptance criteria live here: the create
// request carries the two independent single-use guarantees (§7.1's
// `auto_destroy` + `restart: no`), teardown produces exactly one usage row on
// every path, and the reaper destroys by AGE against the PROVIDER's list rather
// than against anything Motir remembers.
//
// No database. `fetch` is the only fake.

const APP = 'motir-ci-fleet';
const IMAGE = 'registry.fly.io/motir-ci-runner@sha256:abc123';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[];
let handler: (call: Call) => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Fly's machine JSON, with the events array the §5 timestamps come from. */
function machine(
  overrides: {
    id?: string;
    state?: string;
    region?: string;
    createdAt?: string | null;
    metadata?: Record<string, string> | null;
    events?: Array<{ type: string; status?: string; timestamp: number }>;
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? 'd8901ab',
    name: 'motir-runner-44001',
    state: overrides.state ?? 'started',
    region: overrides.region ?? 'iad',
    created_at:
      overrides.createdAt === null
        ? undefined
        : (overrides.createdAt ?? '2026-08-02T10:00:00.000Z'),
    updated_at: '2026-08-02T10:00:05.000Z',
    config: {
      metadata:
        overrides.metadata === null
          ? {}
          : (overrides.metadata ?? { [FLEET_METADATA_KEY]: FLEET_METADATA_VALUE }),
    },
    events: overrides.events ?? [
      { type: 'start', status: 'started', timestamp: Date.parse('2026-08-02T10:00:10.000Z') },
    ],
  };
}

const SPEC: ContainerSpec = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoFullName: 'motir-projects/acme-web',
  workflowJobId: 44001,
  image: IMAGE,
  size: FLEET_CONTAINER_SIZE,
  env: { ACTIONS_RUNNER_INPUT_JITCONFIG: 'secret-config' },
  timeoutSeconds: 3600,
  region: 'iad',
};

const ATTRIBUTION: UsageAttribution = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoFullName: 'motir-projects/acme-web',
  workflowJobId: 44001,
  size: FLEET_CONTAINER_SIZE,
  observedStartedAt: null,
};

const HANDLE: ContainerHandle = {
  provider: 'fly',
  id: 'd8901ab',
  region: 'iad',
  createdAt: new Date('2026-08-02T10:00:00.000Z'),
};

beforeEach(() => {
  calls = [];
  handler = () => json(200, {});
  vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
  vi.stubEnv('FLY_FLEET_APP', APP);
  vi.stubEnv('MOTIR_RUNNER_IMAGE', IMAGE);
  vi.stubEnv('FLY_FLEET_REGION', 'iad');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      return handler(call);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('configuration is read at CALL time', () => {
  it('defaults the region to `iad`, where §11 fixes the fleet', () => {
    vi.stubEnv('FLY_FLEET_REGION', '');
    expect(flyFleetConfig().region).toBe('iad');
  });

  it('names every missing variable rather than failing opaquely', () => {
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    expect(() => flyFleetConfig()).toThrow(OrchestratorNotConfiguredError);
    expect(() => flyFleetConfig()).toThrow(/FLY_FLEET_API_TOKEN, MOTIR_RUNNER_IMAGE/);
  });

  it('an unwired deployment answers "not configured" without throwing', () => {
    // A self-hosted build never provisions a container and must not crash on
    // boot for want of a Fly token — `appAuth.ts`'s contract.
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    expect(isFlyFleetConfigured()).toBe(false);
  });
});

describe('provision — the two single-use guarantees are in the request body', () => {
  it('sends `auto_destroy: true` AND `restart: { policy: no }` (§7.1)', async () => {
    // Independent on purpose: `auto_destroy` alone would race a restart policy
    // that keeps bringing the runner back, and a runner that returns after its
    // ephemeral job de-registered is a machine that idles and bills until
    // something notices.
    handler = () => json(200, machine());
    await flyOrchestrator.provision(SPEC);

    const create = calls[0]!;
    expect(create.method).toBe('POST');
    expect(create.url).toBe(`https://api.machines.dev/v1/apps/${APP}/machines`);
    const config = create.body?.['config'] as Record<string, unknown>;
    expect(config['auto_destroy']).toBe(true);
    expect(config['restart']).toEqual({ policy: 'no' });
  });

  it('provisions the §M machine class — 2 DEDICATED vCPU, 8 GB', async () => {
    handler = () => json(200, machine());
    await flyOrchestrator.provision(SPEC);
    const config = calls[0]!.body?.['config'] as Record<string, unknown>;
    // `performance`, not `shared`: the customer is metered on wall clock, so CPU
    // steal costs the customer more billed minutes AND Motir more
    // container-seconds — the same slowdown paid for twice (§8).
    expect(config['guest']).toEqual({ cpu_kind: 'performance', cpus: 2, memory_mb: 8192 });
    expect(config['image']).toBe(IMAGE);
  });

  it('injects the JIT config as ENV, never bakes it into the image', async () => {
    handler = () => json(200, machine());
    await flyOrchestrator.provision(SPEC);
    const config = calls[0]!.body?.['config'] as Record<string, unknown>;
    expect(config['env']).toMatchObject({ ACTIONS_RUNNER_INPUT_JITCONFIG: 'secret-config' });
  });

  it('tags the machine so the reaper can recognise it without in-process state', async () => {
    handler = () => json(200, machine());
    await flyOrchestrator.provision(SPEC);
    const config = calls[0]!.body?.['config'] as Record<string, unknown>;
    expect(config['metadata']).toMatchObject({
      [FLEET_METADATA_KEY]: FLEET_METADATA_VALUE,
      motir_org_id: 'org-1',
      motir_project_id: 'proj-1',
    });
  });

  it('returns an opaque handle carrying the provider, id, region and creation instant', async () => {
    handler = () => json(200, machine());
    const handle = await flyOrchestrator.provision(SPEC);
    expect(handle).toEqual({
      provider: 'fly',
      id: 'd8901ab',
      region: 'iad',
      createdAt: new Date('2026-08-02T10:00:00.000Z'),
    });
  });

  it('leaves NOTHING behind when Fly refuses', async () => {
    // The port's contract: "throws a typed error; NEVER leaves an untracked
    // container". A refusal created nothing, so there is nothing to destroy —
    // proven by there being exactly one call.
    handler = () => json(422, { error: 'insufficient capacity' });
    await expect(flyOrchestrator.provision(SPEC)).rejects.toMatchObject({
      code: 'ORCHESTRATOR_API_FAILED',
      status: 422,
    });
    expect(calls).toHaveLength(1);
  });

  it('refuses a 200 whose shape has no machine id', async () => {
    handler = () => json(200, { state: 'started' });
    await expect(flyOrchestrator.provision(SPEC)).rejects.toMatchObject({
      code: 'ORCHESTRATOR_API_FAILED',
    });
  });
});

describe('describe — GONE is a real answer', () => {
  it('reports a live machine with its provider-attested start instant', async () => {
    handler = () => json(200, machine());
    const status = await flyOrchestrator.describe(HANDLE);
    expect(status).toMatchObject({
      handleId: 'd8901ab',
      exists: true,
      state: 'started',
      terminal: false,
      startedAt: new Date('2026-08-02T10:00:10.000Z'),
    });
  });

  it('reports a 404 as terminal, not as a failure — the `auto_destroy` happy path', async () => {
    handler = () => json(404, { error: 'machine not found' });
    const status = await flyOrchestrator.describe(HANDLE);
    expect(status).toMatchObject({ exists: false, state: 'destroyed', terminal: true });
  });

  it('treats `stopped` as terminal', async () => {
    handler = () =>
      json(200, {
        ...machine({ state: 'stopped' }),
        events: [
          { type: 'start', timestamp: Date.parse('2026-08-02T10:00:10.000Z') },
          { type: 'exit', timestamp: Date.parse('2026-08-02T10:04:10.000Z') },
        ],
      });
    const status = await flyOrchestrator.describe(HANDLE);
    expect(status.terminal).toBe(true);
    expect(status.stoppedAt).toEqual(new Date('2026-08-02T10:04:10.000Z'));
  });

  it('surfaces a real read failure rather than pretending the machine is gone', async () => {
    // A 500 must NOT read as "destroyed": that would let supervision conclude a
    // running container had finished and stop watching it.
    handler = () => json(500, { error: 'boom' });
    await expect(flyOrchestrator.describe(HANDLE)).rejects.toMatchObject({
      code: 'ORCHESTRATOR_API_FAILED',
      status: 500,
    });
  });
});

describe('teardown — destroys, and RETURNS what it cost', () => {
  it("reads BEFORE destroying so the row carries Fly's own timestamps (§5)", async () => {
    handler = (call) => {
      if (call.method === 'GET') {
        return json(200, {
          ...machine({ state: 'stopped' }),
          events: [
            { type: 'start', timestamp: Date.parse('2026-08-02T10:00:10.000Z') },
            { type: 'exit', timestamp: Date.parse('2026-08-02T10:05:10.000Z') },
          ],
        });
      }
      return new Response(null, { status: 200 });
    };

    const usage = await flyOrchestrator.teardown(HANDLE, 'job_completed', ATTRIBUTION);

    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
    expect(calls[1]!.url).toContain('force=true');
    expect(usage.startedAt).toEqual(new Date('2026-08-02T10:00:10.000Z'));
    expect(usage.stoppedAt).toEqual(new Date('2026-08-02T10:05:10.000Z'));
    expect(usage.billableSeconds).toBe(300);
    expect(usage.costUsd).toBe('0.0094908147');
    expect(usage.teardownReason).toBe('job_completed');
  });

  it("falls back to the CALLER's observed start when the machine self-destroyed", async () => {
    // ⚠️ THE HAPPY PATH IS THE HARD CASE. `auto_destroy` means a completed run
    // deletes its own machine, taking its event log with it — so without this
    // fallback the best-behaved containers would produce zero-second rows and
    // Motir's cost would read as near zero while the invoice did not.
    handler = (call) =>
      call.method === 'GET' ? json(404, {}) : new Response(null, { status: 200 });
    const observedStartedAt = new Date(Date.now() - 120_000);

    const usage = await flyOrchestrator.teardown(HANDLE, 'job_completed', {
      ...ATTRIBUTION,
      observedStartedAt,
    });

    expect(usage.startedAt).toEqual(observedStartedAt);
    expect(usage.billableSeconds).toBeGreaterThanOrEqual(119);
    expect(Number(usage.costUsd)).toBeGreaterThan(0);
  });

  it('still destroys and still costs when the pre-read fails', async () => {
    // A read failure must not stop a teardown: the container is what bills.
    handler = (call) =>
      call.method === 'GET' ? json(500, {}) : new Response(null, { status: 200 });
    const usage = await flyOrchestrator.teardown(HANDLE, 'job_timed_out', ATTRIBUTION);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
    expect(usage.teardownReason).toBe('job_timed_out');
  });

  it('is IDEMPOTENT — a second teardown on a destroyed machine does not throw', async () => {
    handler = (call) => (call.method === 'GET' ? json(404, {}) : json(404, { error: 'gone' }));
    await expect(flyOrchestrator.teardown(HANDLE, 'reaped', ATTRIBUTION)).resolves.toMatchObject({
      teardownReason: 'reaped',
    });
  });

  it('propagates a destroy that genuinely failed', async () => {
    // The one thing that must NOT be swallowed here: if the machine is still
    // alive, the caller has to know so the reaper keeps it in scope.
    handler = (call) =>
      call.method === 'GET' ? json(200, machine()) : json(500, { error: 'boom' });
    await expect(
      flyOrchestrator.teardown(HANDLE, 'job_completed', ATTRIBUTION),
    ).rejects.toMatchObject({ code: 'ORCHESTRATOR_API_FAILED', status: 500 });
  });
});

describe('reap — the provider is the source of truth, and AGE is the test', () => {
  const OLDER_THAN = new Date('2026-08-02T12:00:00.000Z');
  const resolveAll = async () => ATTRIBUTION;

  it('destroys a fleet machine older than the cutoff and returns its cost row', async () => {
    handler = (call) => {
      if (call.method === 'GET') {
        return json(200, [machine({ id: 'old-1', createdAt: '2026-08-02T09:00:00.000Z' })]);
      }
      return new Response(null, { status: 200 });
    };

    const usages = await flyOrchestrator.reap(OLDER_THAN, resolveAll);

    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ handleId: 'old-1', teardownReason: 'reaped' });
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('leaves a machine that is NOT old enough alone', async () => {
    handler = () => json(200, [machine({ id: 'fresh', createdAt: '2026-08-02T12:30:00.000Z' })]);
    expect(await flyOrchestrator.reap(OLDER_THAN, resolveAll)).toEqual([]);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it("ignores a machine that is not tagged as fleet — it is not the fleet's to destroy", async () => {
    handler = () =>
      json(200, [
        machine({ id: 'someone-else', createdAt: '2026-08-02T09:00:00.000Z', metadata: {} }),
      ]);
    expect(await flyOrchestrator.reap(OLDER_THAN, resolveAll)).toEqual([]);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('reports — and does NOT destroy — a fleet machine Fly describes with no creation instant', async () => {
    // Destroying on a guess could kill a container that booted a second ago.
    handler = () => json(200, [machine({ id: 'undated', createdAt: null })]);
    expect(await flyOrchestrator.reap(OLDER_THAN, resolveAll)).toEqual([]);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('destroys an UNATTRIBUTABLE orphan but emits no cost row for it', async () => {
    // Stopping the bleeding is what costs money; a row attributed to nobody would
    // pollute the meter with spend it cannot assign.
    handler = (call) =>
      call.method === 'GET'
        ? json(200, [machine({ id: 'orphan', createdAt: '2026-08-02T09:00:00.000Z' })])
        : new Response(null, { status: 200 });
    const usages = await flyOrchestrator.reap(OLDER_THAN, async () => null);
    expect(usages).toEqual([]);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it("one machine's destroy failure does not abandon the rest of the sweep", async () => {
    // The sweep is the last line; a fleet-wide leak because one DELETE 500'd is
    // the failure mode it exists to prevent.
    handler = (call) => {
      if (call.method === 'GET') {
        return json(200, [
          machine({ id: 'bad', createdAt: '2026-08-02T09:00:00.000Z' }),
          machine({ id: 'good', createdAt: '2026-08-02T09:00:00.000Z' }),
        ]);
      }
      return call.url.includes('bad')
        ? json(500, { error: 'boom' })
        : new Response(null, { status: 200 });
    };

    const usages = await flyOrchestrator.reap(OLDER_THAN, resolveAll);
    expect(usages.map((u) => u.handleId)).toEqual(['good']);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
  });

  it('tolerates a list containing entries that are not machines', async () => {
    handler = () =>
      json(200, [null, 'nope', machine({ id: 'real', createdAt: '2026-08-02T09:00:00.000Z' })]);
    const usages = await flyOrchestrator.reap(OLDER_THAN, resolveAll);
    expect(usages.map((u) => u.handleId)).toEqual(['real']);
  });

  it('surfaces a list failure rather than reporting an empty fleet', async () => {
    // "No machines" and "could not ask" must never be the same answer: the first
    // means nothing to reap, the second means the reaper did not run.
    handler = () => json(500, { error: 'boom' });
    await expect(flyOrchestrator.reap(OLDER_THAN, resolveAll)).rejects.toMatchObject({
      code: 'ORCHESTRATOR_API_FAILED',
    });
  });
});
