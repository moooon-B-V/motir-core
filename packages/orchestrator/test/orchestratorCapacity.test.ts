import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_CONTAINER_SIZE,
  FLY_CAPACITY_CODES,
  FLY_MACHINE_LIMIT_MESSAGE,
  OrchestratorApiError,
  OrchestratorCapacityError,
  fakeOrchestrator,
  flyCapacityRefusal,
  flyMachinesClient,
  type ContainerSpec,
} from '../src/index';

// The typed capacity refusal (MOTIR-8973): the error itself, the Fly wire
// mapping that produces it, and the fake's control. The port-level guarantee —
// every adapter refuses this way and leaves nothing behind — is case 14 of the
// shared contract suite.

const APP = 'motir-ci-fleet';
const IMAGE = 'registry.fly.io/motir-ci-runner@sha256:abc123';

describe('OrchestratorCapacityError', () => {
  it('is a provider refusal every existing catch still accepts, carrying why it is full', () => {
    const err = new OrchestratorCapacityError('fly', 422, 'quota_exceeded', 'iad', 'machine_limit');

    expect(err).toBeInstanceOf(OrchestratorApiError);
    expect(err).toMatchObject({
      name: 'OrchestratorCapacityError',
      code: 'ORCHESTRATOR_API_FAILED',
      provider: 'fly',
      status: 422,
      reason: 'quota_exceeded',
      zone: 'iad',
      providerCode: 'machine_limit',
      retryable: true,
    });
    expect(err.message).toBe(
      'The fly orchestrator has no capacity (quota_exceeded in iad, HTTP 422: machine_limit).',
    );
  });

  it('defaults zone and provider code to null, and reads without a status', () => {
    const err = new OrchestratorCapacityError('fake', null, 'out_of_stock');

    expect(err.zone).toBeNull();
    expect(err.providerCode).toBeNull();
    expect(err.message).toBe('The fake orchestrator has no capacity (out_of_stock).');
  });
});

describe('flyCapacityRefusal — only the machine limit and throttling are "full"', () => {
  it('types the machine-limit 422 as quota_exceeded', () => {
    const err = flyCapacityRefusal(422, 'Your organization has reached its machine limit');
    expect(err).toMatchObject({ reason: 'quota_exceeded', status: 422 });
    expect(err?.providerCode).toBe(FLY_CAPACITY_CODES.machineLimit);
  });

  it('matches the documented substring, whatever its case', () => {
    expect(flyCapacityRefusal(422, FLY_MACHINE_LIMIT_MESSAGE.toUpperCase())).not.toBeNull();
  });

  it('types a 429 as throttled', () => {
    expect(flyCapacityRefusal(429, '')).toMatchObject({
      reason: 'throttled',
      providerCode: FLY_CAPACITY_CODES.rateLimited,
    });
  });

  it('leaves every other refusal untyped — a 422 with another message, or the limit text on a 400', () => {
    expect(flyCapacityRefusal(422, 'invalid guest config')).toBeNull();
    expect(flyCapacityRefusal(400, 'Your organization has reached its machine limit')).toBeNull();
    expect(flyCapacityRefusal(500, '')).toBeNull();
  });
});

describe('the Fly machine create, on the wire', () => {
  let answer: { status: number; body: unknown };

  beforeEach(() => {
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', APP);
    vi.stubEnv('MOTIR_RUNNER_IMAGE', IMAGE);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(answer.body), {
            status: answer.status,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const create = () =>
    flyMachinesClient
      .createMachine({
        name: 'motir-runner-1',
        region: 'iad',
        image: IMAGE,
        cpuKind: 'shared',
        cpus: 2,
        memoryMb: 4096,
        env: {},
        metadata: {},
      })
      .then(
        () => null,
        (err: unknown) => err,
      );

  it('throws quota_exceeded for the 422 machine-limit answer', async () => {
    answer = { status: 422, body: { error: 'Your organization has reached its machine limit' } };
    const err = await create();
    expect(err).toBeInstanceOf(OrchestratorCapacityError);
    expect(err).toMatchObject({ provider: 'fly', status: 422, reason: 'quota_exceeded' });
  });

  it('throws throttled for a 429', async () => {
    answer = { status: 429, body: { error: 'rate limit exceeded' } };
    expect(await create()).toMatchObject({ reason: 'throttled', status: 429 });
  });

  it('throws a plain OrchestratorApiError, NOT a capacity error, for any other 422', async () => {
    answer = { status: 422, body: { error: 'invalid guest config' } };
    const err = await create();
    expect(err).toBeInstanceOf(OrchestratorApiError);
    expect(err).not.toBeInstanceOf(OrchestratorCapacityError);
  });
});

describe("the fake's capacity control", () => {
  const SPEC: ContainerSpec = {
    orgId: 'org-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    repoFullName: 'motir-projects/acme-web',
    workload: 'ci_runner',
    workflowJobId: 44001,
    image: 'motir/ci-runner@sha256:abc',
    size: FLEET_CONTAINER_SIZE,
    env: {},
    timeoutSeconds: 3600,
    region: 'iad',
  };

  beforeEach(() => fakeOrchestrator.reset());

  it('carries the zone it was given, and fires once', async () => {
    fakeOrchestrator.failNextProvisionForCapacity('out_of_stock', 'us-east-1a');
    await expect(fakeOrchestrator.provision(SPEC)).rejects.toMatchObject({
      reason: 'out_of_stock',
      zone: 'us-east-1a',
    });
    await expect(fakeOrchestrator.provision(SPEC)).resolves.toMatchObject({ provider: 'fake' });
  });

  it('is cleared by reset', async () => {
    fakeOrchestrator.failNextProvisionForCapacity('throttled');
    fakeOrchestrator.reset();
    await expect(fakeOrchestrator.provision(SPEC)).resolves.toMatchObject({ provider: 'fake' });
  });
});
