import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_METADATA_KEY,
  FLEET_METADATA_VALUE,
  flyOrchestrator,
} from '@/lib/orchestrator/adapters/fly';
import {
  flyFleetConfig,
  isFlyFleetConfigured,
  isPreStartState,
  isTerminalState,
  startedAtOf,
  stoppedAtOf,
  toFlyMachine,
} from '@/lib/orchestrator/adapters/fly/flyMachines';
import { FLEET_CONTAINER_SIZE } from '@/lib/orchestrator/rates';
import {
  OrchestratorApiError,
  OrchestratorImageUnpullableError,
  OrchestratorNotConfiguredError,
} from '@/lib/orchestrator/errors';
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

describe('§6.2 — an UNPULLABLE image is its own named failure, not one more 400', () => {
  // `docs/decisions/fleet-image-pull.md` §6: an unpullable digest and an
  // unreachable Fly arrive at the same `catch` as a non-2xx, and they are
  // OPPOSITE problems — one needs a human to fix a registry, the other resolves
  // itself. Before this they were the same sentence.
  //
  // ⚠️ THE FIXTURE IS FLY'S OWN BODY, MEASURED. `{"error":"failed to get manifest
  // <ref>: unauthorized"}` at HTTP 400, observed live against api.machines.dev
  // on 2026-08-02 with a private GHCR reference (ADR §2.2, re-run by
  // MOTIR-2006). Nothing here is a guess about what Fly says.
  const FLY_MANIFEST_400 = {
    error: 'failed to get manifest ghcr.io/moooon-b-v/motir-sandbox:claude: unauthorized',
  };

  it('classifies the measured manifest refusal as OrchestratorImageUnpullableError', async () => {
    handler = () => json(400, FLY_MANIFEST_400);

    const error = await flyOrchestrator.provision(SPEC).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OrchestratorImageUnpullableError);
    // It is STILL an OrchestratorApiError, so every existing catch site keeps
    // working — the subclass adds a diagnosis, it does not fork the hierarchy.
    expect(error).toBeInstanceOf(OrchestratorApiError);
    expect(error).toMatchObject({ status: 400, imageReference: IMAGE });
    // The MESSAGE is the deliverable: it lands in the intent's `failure_detail`
    // and in the operator dashboard's failure column, so it has to name the
    // image and say what happened without a log line beside it.
    expect((error as Error).message).toContain(IMAGE);
    expect((error as Error).message).toContain('could not PULL');
    expect((error as Error).message).toContain('private, absent, or the pinned digest is gone');
  });

  it.each([
    ['a manifest Fly could not resolve', { error: 'failed to resolve manifest ghcr.io/x/y' }],
    ['an unknown manifest', { error: 'manifest unknown' }],
    ['a pull that failed after resolution', { error: 'failed to pull image ghcr.io/x/y' }],
    ['an image Fly cannot find', { error: 'image not found' }],
  ])('also names %s as unpullable', async (_label, body) => {
    handler = () => json(400, body);
    await expect(flyOrchestrator.provision(SPEC)).rejects.toBeInstanceOf(
      OrchestratorImageUnpullableError,
    );
  });

  it('does NOT claim an image problem when the FLEET TOKEN is what Fly refused', async () => {
    // ⚠️ THE MIS-DIAGNOSIS THIS GUARDS AGAINST. Fly says `unauthorized` for a bad
    // `FLY_FLEET_API_TOKEN` too, and reporting that as "your image is private"
    // would send an operator to the GHCR settings page while the token rots. The
    // classifier matches the IMAGE-specific phrasing, never `unauthorized` alone.
    handler = () => json(401, { error: 'unauthorized' });

    const error = await flyOrchestrator.provision(SPEC).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OrchestratorApiError);
    expect(error).not.toBeInstanceOf(OrchestratorImageUnpullableError);
  });

  it('does NOT claim an image problem for a capacity refusal', async () => {
    handler = () => json(422, { error: 'insufficient capacity' });
    await expect(flyOrchestrator.provision(SPEC)).rejects.not.toBeInstanceOf(
      OrchestratorImageUnpullableError,
    );
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

// ── Parsing Fly's JSON, which is not a contract ─────────────────────────────

describe('toFlyMachine tolerates every shape Fly actually sends', () => {
  /**
   * Fly's machine JSON is a REST response, not a schema, and the fleet reads it
   * on the two paths that must not fail: the reaper's list, and the pre-teardown
   * read that sources the §5 timestamps. A parser that threw — or that silently
   * produced `undefined` where a Date belongs — would turn a malformed payload
   * into either a crashed sweep or a cost row nobody can audit.
   */
  it('refuses anything without a usable id — that is what "not a machine" means', () => {
    expect(toFlyMachine(null)).toBeNull();
    expect(toFlyMachine('a string')).toBeNull();
    expect(toFlyMachine([])).toBeNull();
    expect(toFlyMachine({})).toBeNull();
    expect(toFlyMachine({ id: 42 })).toBeNull();
    expect(toFlyMachine({ id: '' })).toBeNull();
  });

  it('defaults every missing string field rather than propagating undefined', () => {
    const parsed = toFlyMachine({ id: 'm1' });

    expect(parsed).toMatchObject({ id: 'm1', name: '', state: '', region: '' });
    expect(parsed?.createdAt).toBeNull();
    expect(parsed?.updatedAt).toBeNull();
    expect(parsed?.metadata).toEqual({});
    expect(parsed?.events).toEqual([]);
  });

  it('reads an events timestamp in EPOCH MILLISECONDS, the shape Fly uses there', () => {
    // ⚠️ The two timestamp dialects in one payload: the machine's own
    // `created_at` is RFC 3339, its EVENTS are epoch millis. Both land in the
    // same parser, and getting the second wrong is what makes a boot-latency
    // reading silently absurd.
    const at = Date.parse('2026-08-02T10:00:10.000Z');
    const parsed = toFlyMachine({ id: 'm1', events: [{ type: 'start', timestamp: at }] });
    expect(parsed?.events[0]?.timestamp).toEqual(new Date(at));
  });

  it('drops an UNPARSEABLE timestamp rather than producing an Invalid Date', () => {
    const parsed = toFlyMachine({
      id: 'm1',
      created_at: 'not a date',
      events: [
        { type: 'start', timestamp: 'also not a date' },
        { type: 'exit', timestamp: Number.NaN },
        { type: 'stop', timestamp: { nested: true } },
      ],
    });

    expect(parsed?.createdAt).toBeNull();
    expect(parsed?.events.map((e) => e.timestamp)).toEqual([null, null, null]);
    // An Invalid Date compares as NaN everywhere and would make `reap(olderThan)`
    // quietly skip the machine — a leak with no error.
    expect(startedAtOf(parsed!)).toBeNull();
    expect(stoppedAtOf(parsed!)).toBeNull();
  });

  it('keeps only STRING metadata, so a non-string tag cannot masquerade as one', () => {
    const parsed = toFlyMachine({
      id: 'm1',
      config: { metadata: { [FLEET_METADATA_KEY]: FLEET_METADATA_VALUE, port: 8080, on: true } },
    });
    expect(parsed?.metadata).toEqual({ [FLEET_METADATA_KEY]: FLEET_METADATA_VALUE });
  });

  it('tolerates an events value that is not an array, and entries that are not events', () => {
    expect(toFlyMachine({ id: 'm1', events: 'nope' })?.events).toEqual([]);
    expect(toFlyMachine({ id: 'm1', events: [null, 7, 'x'] })?.events).toEqual([]);
  });

  it('defaults an event’s own type/status to empty strings', () => {
    const parsed = toFlyMachine({ id: 'm1', events: [{ timestamp: 1 }] });
    expect(parsed?.events[0]).toMatchObject({ type: '', status: '' });
  });
});

describe('the machine-state predicates', () => {
  it('knows which states are TERMINAL', () => {
    expect(isTerminalState('destroyed')).toBe(true);
    expect(isTerminalState('started')).toBe(false);
  });

  it('knows which states are still ON THE WAY UP', () => {
    // The distinction a boot deadline needs: `created` is "keep waiting",
    // `started` is "it is up", and neither is "it failed".
    expect(isPreStartState('created')).toBe(true);
    expect(isPreStartState('started')).toBe(false);
    expect(isPreStartState('destroyed')).toBe(false);
  });
});

describe('the §5 instants, read from Fly’s event log', () => {
  it('takes the FIRST start event, ignoring events of other types', () => {
    const first = Date.parse('2026-08-02T10:00:10.000Z');
    const parsed = toFlyMachine({
      id: 'm1',
      events: [
        { type: 'launch', timestamp: Date.parse('2026-08-02T10:00:00.000Z') },
        { type: 'start', timestamp: first },
        { type: 'start', timestamp: Date.parse('2026-08-02T10:05:00.000Z') },
      ],
    });
    expect(startedAtOf(parsed!)).toEqual(new Date(first));
  });

  it('skips a start event that carries no usable timestamp', () => {
    const good = Date.parse('2026-08-02T10:00:10.000Z');
    const parsed = toFlyMachine({
      id: 'm1',
      events: [
        { type: 'start', timestamp: 'nonsense' },
        { type: 'start', timestamp: good },
      ],
    });
    expect(startedAtOf(parsed!)).toEqual(new Date(good));
  });

  it('takes the LATEST stop-ish event, whichever of the three types it is', () => {
    // `exit`, `stop` and `destroy` all end a machine, and Fly emits them in no
    // guaranteed order. The LAST one is when it actually stopped costing money.
    const early = Date.parse('2026-08-02T10:04:00.000Z');
    const late = Date.parse('2026-08-02T10:09:00.000Z');
    const parsed = toFlyMachine({
      id: 'm1',
      events: [
        { type: 'destroy', timestamp: late },
        { type: 'exit', timestamp: early },
        { type: 'stop', timestamp: null },
        { type: 'start', timestamp: Date.parse('2026-08-02T10:00:00.000Z') },
      ],
    });
    expect(stoppedAtOf(parsed!)).toEqual(new Date(late));
  });

  it('is null when the machine has stopped-ish events but none with an instant', () => {
    const parsed = toFlyMachine({ id: 'm1', events: [{ type: 'exit', timestamp: 'x' }] });
    expect(stoppedAtOf(parsed!)).toBeNull();
  });
});

describe('the adapter’s fallbacks when Fly answers thinly', () => {
  it('a machine with NO region or creation instant still yields a usable handle', async () => {
    // `reap(olderThan)` compares against the handle's `createdAt`, so a null
    // there would make the container invisible to the one mechanism that exists
    // to catch it — the fallback is what keeps an un-dated machine reapable.
    handler = () => json(200, { id: 'thin-1', state: 'created' });
    const before = Date.now();

    const handle = await flyOrchestrator.provision(SPEC);

    expect(handle).toMatchObject({ provider: 'fly', id: 'thin-1', region: 'iad' });
    expect(handle.createdAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('a spec with no region of its own falls back to the DEPLOYMENT’s region', async () => {
    vi.stubEnv('FLY_FLEET_REGION', 'ams');
    handler = () => json(200, { id: 'thin-2', state: 'created' });

    const handle = await flyOrchestrator.provision({ ...SPEC, region: '' });

    expect(calls[0]?.body?.['region']).toBe('ams');
    expect(handle.region).toBe('ams');
  });

  it('describe dates an un-dated machine from the HANDLE rather than reporting none', async () => {
    handler = () => json(200, machine({ createdAt: null, events: [] }));

    const status = await flyOrchestrator.describe(HANDLE);

    expect(status.createdAt).toEqual(HANDLE.createdAt);
    expect(status.startedAt).toBeNull();
    expect(status.stoppedAt).toBeNull();
  });

  it('reports a refusal whose body is not JSON by STATUS alone', async () => {
    handler = () => new Response('<html>502</html>', { status: 502 });

    await expect(flyOrchestrator.provision(SPEC)).rejects.toMatchObject({
      code: 'ORCHESTRATOR_API_FAILED',
      status: 502,
    });
  });

  it('reads Fly’s `error` key as well as `message` — it sends both', async () => {
    handler = () => json(422, { error: 'no capacity in iad' });

    await expect(flyOrchestrator.provision(SPEC)).rejects.toThrow(/no capacity in iad/);
  });

  it('normalizes a NON-ERROR transport rejection to the typed error', async () => {
    // A rejected promise that is not an `Error` (a string thrown by an agent, an
    // aborted fetch in some runtimes) must not escape as an unnamed value.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw 'socket closed';
      }),
    );

    await expect(flyOrchestrator.provision(SPEC)).rejects.toMatchObject({
      code: 'ORCHESTRATOR_API_FAILED',
      provider: 'fly',
      status: null,
    });
  });
});

describe('the reaper keeps sweeping when ONE machine refuses to die', () => {
  it('logs the refusal, skips that machine, and still destroys the rest', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const old = '2026-08-01T00:00:00.000Z';
    handler = (call) => {
      if (call.method === 'GET' && call.url.endsWith('/machines')) {
        return json(200, [
          machine({ id: 'stubborn', createdAt: old }),
          machine({ id: 'compliant', createdAt: old }),
        ]);
      }
      if (call.method === 'DELETE' && call.url.includes('stubborn')) {
        return json(500, { error: 'machine is wedged' });
      }
      return new Response(null, { status: 200 });
    };

    const usages = await flyOrchestrator.reap(
      new Date('2026-08-02T00:00:00.000Z'),
      async () => ATTRIBUTION,
    );

    // A fleet-wide leak because one destroy 500'd is the failure the sweep
    // exists to prevent, so one refusal must not abandon the others.
    expect(usages.map((u) => u.handleId)).toEqual(['compliant']);
    expect(error).toHaveBeenCalled();
  });
});
