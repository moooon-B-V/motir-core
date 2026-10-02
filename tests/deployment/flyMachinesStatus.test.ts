import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEPLOYMENT_STATUS_TIMEOUT_MS } from '@/lib/deployment/deploymentStatus';
import {
  flyDeploymentStatusProvider,
  foldMachines,
} from '@/lib/deployment/adapters/fly/flyMachinesStatus';

// THE DEPLOYMENT-STATUS PORT'S FLY ADAPTER (MOTIR-7332). `fetch` is the seam.
//
// The recorded body is `GET /v1/apps/motir-core/machines`, trimmed to the fields
// the adapter reads, in the shape `scripts/machinePool.mjs` reads in CI: two web
// machines, one worker, and the worker's Fly-made STANDBY (stopped, carrying a
// non-empty `standbys` list), all on one image.

const IMAGE = {
  registry: 'registry.fly.io',
  repository: 'motir-core',
  tag: 'deployment-01K6HXQ8',
  digest: 'sha256:aaaa',
};

function machine(over: {
  id: string;
  group: string;
  state?: string;
  tag?: string | null;
  digest?: string;
  updatedAt?: string;
  standbys?: string[];
}) {
  return {
    id: over.id,
    state: over.state ?? 'started',
    region: 'iad',
    updated_at: over.updatedAt ?? '2026-10-02T10:00:00Z',
    image_ref: {
      ...IMAGE,
      tag: over.tag === null ? '' : (over.tag ?? IMAGE.tag),
      digest: over.digest ?? IMAGE.digest,
    },
    config: {
      metadata: { fly_process_group: over.group },
      ...(over.standbys ? { standbys: over.standbys } : {}),
    },
  };
}

const RECORDED = [
  machine({ id: 'web1', group: 'app' }),
  machine({ id: 'web2', group: 'app' }),
  machine({ id: 'wrk1', group: 'worker' }),
  machine({ id: 'wrk2', group: 'worker', state: 'stopped', standbys: ['wrk1'] }),
];

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function configure() {
  vi.stubEnv('FLY_DEPLOYMENT_READ_TOKEN', 'fo1_read');
  vi.stubEnv('FLY_APP_NAME', 'motir-core');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('flyDeploymentStatusProvider.read', () => {
  it('counts each group against its expectation and does not count the standby', async () => {
    configure();
    const fetchMock = vi.fn(async () => answer(RECORDED));
    vi.stubGlobal('fetch', fetchMock);

    const status = await flyDeploymentStatusProvider.read();

    expect(status.groups).toEqual([
      { name: 'app', started: 2, total: 2, expected: 2 },
      { name: 'worker', started: 1, total: 1, expected: 1 },
    ]);
    expect(status.releases).toEqual(['deployment-01K6HXQ8']);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.machines.dev/v1/apps/motir-core/machines');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fo1_read');
  });

  it('sends GET and nothing else, with a bounded timeout', async () => {
    configure();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn(async () => answer(RECORDED));
    vi.stubGlobal('fetch', fetchMock);

    await flyDeploymentStatusProvider.read();

    for (const call of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(call[1].method).toBe('GET');
      expect(call[1].body).toBeUndefined();
    }
    expect(timeout).toHaveBeenCalledWith(DEPLOYMENT_STATUS_TIMEOUT_MS);
    expect(DEPLOYMENT_STATUS_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });

  it.each([401, 403, 500, 503])(
    'throws on %i rather than reporting an empty fleet',
    async (code) => {
      configure();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => answer({ error: 'unauthorized' }, code)),
      );
      await expect(flyDeploymentStatusProvider.read()).rejects.toThrow(String(code));
    },
  );

  it('throws on a body that is not a machine list', async () => {
    configure();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer({ error: 'not found' })),
    );
    await expect(flyDeploymentStatusProvider.read()).rejects.toThrow(/not an array/);
  });

  it('throws on a row that is not an object', async () => {
    configure();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer([null])),
    );
    await expect(flyDeploymentStatusProvider.read()).rejects.toThrow(/not an object/);
  });

  it('throws when the request times out', async () => {
    configure();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
    );
    await expect(flyDeploymentStatusProvider.read()).rejects.toThrow(/timeout/);
  });

  it('throws without calling Fly when the token is unset', async () => {
    vi.stubEnv('FLY_DEPLOYMENT_READ_TOKEN', '');
    vi.stubEnv('FLY_APP_NAME', 'motir-core');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(flyDeploymentStatusProvider.read()).rejects.toThrow(/unset/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('flyDeploymentStatusProvider.configured', () => {
  it('needs both the read token and the app name', () => {
    configure();
    expect(flyDeploymentStatusProvider.configured()).toBe(true);
    vi.stubEnv('FLY_DEPLOYMENT_READ_TOKEN', '');
    expect(flyDeploymentStatusProvider.configured()).toBe(false);
    configure();
    vi.stubEnv('FLY_APP_NAME', '');
    expect(flyDeploymentStatusProvider.configured()).toBe(false);
  });
});

describe('foldMachines', () => {
  it('reports a group with no machines at all as 0 started, not as missing', () => {
    const status = foldMachines([machine({ id: 'web1', group: 'app' })]);
    expect(status.groups).toContainEqual({ name: 'worker', started: 0, total: 0, expected: 1 });
    expect(status.groups).toContainEqual({ name: 'app', started: 1, total: 1, expected: 2 });
  });

  it('counts a stopped non-standby machine in total but not in started', () => {
    const status = foldMachines([
      machine({ id: 'web1', group: 'app' }),
      machine({ id: 'web2', group: 'app', state: 'stopped' }),
    ]);
    expect(status.groups).toContainEqual({ name: 'app', started: 1, total: 2, expected: 2 });
  });

  it('lists distinct releases of RUNNING machines, newest first', () => {
    const status = foldMachines([
      machine({
        id: 'web1',
        group: 'app',
        tag: 'deployment-old',
        updatedAt: '2026-10-01T00:00:00Z',
      }),
      machine({
        id: 'web2',
        group: 'app',
        tag: 'deployment-new',
        updatedAt: '2026-10-02T00:00:00Z',
      }),
      machine({ id: 'wrk1', group: 'worker', tag: 'deployment-new' }),
      // A stopped machine on a third image is not a deploy that stopped part-way.
      machine({ id: 'web3', group: 'app', state: 'stopped', tag: 'deployment-ancient' }),
    ]);
    expect(status.releases).toEqual(['deployment-new', 'deployment-old']);
  });

  it('falls back to the digest when an image has no tag', () => {
    const status = foldMachines([
      machine({ id: 'web1', group: 'app', tag: null, digest: 'sha256:bbbb' }),
    ]);
    expect(status.releases).toEqual(['sha256:bbbb']);
  });

  it('skips machines being destroyed or replaced', () => {
    const status = foldMachines([
      machine({ id: 'web1', group: 'app' }),
      machine({ id: 'rel1', group: 'app', state: 'destroying' }),
      machine({ id: 'web2', group: 'app', state: 'replacing' }),
    ]);
    expect(status.groups).toContainEqual({ name: 'app', started: 1, total: 1, expected: 2 });
  });

  it('reports a group nobody expected with an expectation of 0', () => {
    const status = foldMachines([{ state: 'started', config: { metadata: {} } }]);
    expect(status.groups).toContainEqual({
      name: '(ungrouped)',
      started: 1,
      total: 1,
      expected: 0,
    });
    expect(status.releases).toEqual([]);
  });
});
