import { describe, expect, it, vi } from 'vitest';
import {
  EXIT_BLIND_READ,
  EXIT_CLEAN,
  EXIT_REFUSED,
  formatPlan,
  imageOf,
  planRepair,
  repairImageSet,
} from '../../scripts/flyImageSet.mjs';

// MOTIR-9354 — the deploy job's pre-release guard against a two-image app.
//
// On 2026-10-23 a blue-green deploy hung after `Marking green machines as ready`
// until the job's 30-minute backstop killed flyctl, and the app was left on two
// images: 20 green machines on `d7a9699dc`, 20 blue on `e31b04ce8`. flyctl's
// bluegreen pre-check then refused every later deploy with "found multiple image
// versions", and nothing shipped until a person destroyed the blues by ID.
//
// The guard does what that person did. Because what it does is DESTROY
// PRODUCTION MACHINES, most of this file is negatives: every condition under
// which the keeper cannot be trusted must refuse, and no plan may ever touch a
// machine on the image it keeps.

const NEW = 'd7a9699dc';
const OLD = 'e31b04ce8';

type Options = {
  state?: string;
  checks?: Array<{ name: string; status: string }>;
  release?: number;
  created?: string;
  standbyFor?: string[];
  digest?: string;
};

/** A `GET /v1/apps/<app>/machines` row, cut down to what the guard reads. */
function machine(id: string, group: string, tag: string, options: Options = {}) {
  const checks =
    options.checks ??
    (group === 'app' ? [{ name: 'servicecheck-00-http-8080', status: 'passing' }] : []);
  return {
    id,
    state: options.state ?? 'started',
    created_at: options.created ?? '2026-10-23T11:00:00Z',
    image_ref: {
      registry: 'registry.fly.io',
      repository: 'motir-core',
      tag,
      digest: options.digest ?? `sha256:${tag}`,
    },
    checks,
    config: {
      image: `registry.fly.io/motir-core:${tag}`,
      metadata: {
        fly_process_group: group,
        ...(options.release !== undefined ? { fly_release_version: String(options.release) } : {}),
      },
      ...(options.standbyFor ? { standbys: options.standbyFor } : {}),
    },
  };
}

/** The pool as it stood at 12:03Z: 20 green on the new image, 20 blue on the old. */
function incidentPool() {
  const pool = [];
  for (let i = 0; i < 19; i++) {
    pool.push(
      machine(`green-app-${i}`, 'app', NEW, { release: 1240, created: '2026-10-23T11:41:00Z' }),
    );
    pool.push(
      machine(`blue-app-${i}`, 'app', OLD, { release: 1239, created: '2026-10-23T09:00:00Z' }),
    );
  }
  pool.push(
    machine('green-worker', 'worker', NEW, { release: 1240, created: '2026-10-23T11:41:00Z' }),
  );
  pool.push(
    machine('blue-worker', 'worker', OLD, { release: 1239, created: '2026-10-23T09:00:00Z' }),
  );
  return pool;
}

describe('what counts as one image (MOTIR-9354)', () => {
  it('identifies an image by its digest, and labels it by its tag', () => {
    expect(imageOf(machine('m1', 'app', NEW))).toEqual({
      id: `registry.fly.io/motir-core@sha256:${NEW}`,
      label: `registry.fly.io/motir-core:${NEW}`,
    });
  });

  it('treats two tags on one digest as ONE image', () => {
    const plan = planRepair([
      machine('a', 'app', 'deployment-1', { digest: 'sha256:same' }),
      machine('b', 'app', NEW, { digest: 'sha256:same' }),
    ]);
    expect(plan.action).toBe('none');
  });

  it('falls back to config.image for a row with no image_ref', () => {
    const row = { id: 'x', state: 'started', config: { image: 'registry.fly.io/motir-core:abc' } };
    expect(imageOf(row).id).toBe('registry.fly.io/motir-core:abc');
  });
});

describe('a single-image app is left alone', () => {
  it('plans nothing when every machine runs one image', () => {
    const pool = [
      machine('a1', 'app', NEW),
      machine('a2', 'app', NEW),
      machine('w1', 'worker', NEW),
    ];
    const plan = planRepair(pool);
    expect(plan).toMatchObject({ code: EXIT_CLEAN, action: 'none', destroy: [] });
    expect(formatPlan('motir-core', plan)).toContain('runs a single image');
  });

  it('ignores a destroyed machine and the release-command machine on another image', () => {
    const plan = planRepair([
      machine('a1', 'app', NEW),
      machine('gone', 'app', OLD, { state: 'destroyed' }),
      machine('release', 'fly_app_release_command', OLD),
    ]);
    expect(plan.action).toBe('none');
  });
});

describe('a two-image app is put back on the newest healthy image', () => {
  it('reproduces the incident: keeps the 20 green machines and destroys the 20 blue ones', () => {
    const plan = planRepair(incidentPool());
    expect(plan.code).toBe(EXIT_CLEAN);
    expect(plan.action).toBe('destroy');
    expect(plan.keep).toBe(`registry.fly.io/motir-core@sha256:${NEW}`);
    expect(plan.destroy).toHaveLength(20);
    expect(plan.destroy.every((id) => id.startsWith('blue-'))).toBe(true);
  });

  it('names both images in the log, with their machine counts', () => {
    const text = formatPlan('motir-core', planRepair(incidentPool()));
    expect(text).toContain(`registry.fly.io/motir-core:${NEW}: 20 machine(s)`);
    expect(text).toContain(`registry.fly.io/motir-core:${OLD}: 20 machine(s)`);
    expect(text).toContain('destroying 20 machine(s)');
  });

  it('keeps the OLDER image when the newer one is not healthy — and destroys the new one', () => {
    const pool = [
      machine('green-app', 'app', NEW, {
        release: 1240,
        checks: [{ name: 'http', status: 'critical' }],
      }),
      machine('green-worker', 'worker', NEW, { release: 1240 }),
      machine('blue-app', 'app', OLD, { release: 1239 }),
      machine('blue-worker', 'worker', OLD, { release: 1239 }),
    ];
    const plan = planRepair(pool);
    expect(plan.keep).toBe(`registry.fly.io/motir-core@sha256:${OLD}`);
    expect(plan.destroy.sort()).toEqual(['green-app', 'green-worker']);
  });

  it('orders by release version, and by creation time when no version is recorded', () => {
    const byRelease = planRepair([
      machine('a', 'app', NEW, { release: 9, created: '2026-01-01T00:00:00Z' }),
      machine('b', 'app', OLD, { release: 10, created: '2026-12-01T00:00:00Z' }),
    ]);
    expect(byRelease.keep).toContain(OLD);

    const byCreated = planRepair([
      machine('a', 'app', NEW, { created: '2026-10-23T11:41:00Z' }),
      machine('b', 'app', OLD, { created: '2026-10-23T09:00:00Z' }),
    ]);
    expect(byCreated.keep).toContain(NEW);
  });

  it('destroys a stopped spare and a standby on the old image too — bluegreen needs every machine on one', () => {
    const plan = planRepair([
      machine('green-app', 'app', NEW, { release: 2 }),
      machine('green-worker', 'worker', NEW, { release: 2 }),
      machine('blue-spare', 'app', OLD, { release: 1, state: 'stopped' }),
      machine('blue-standby', 'worker', OLD, { release: 1, state: 'stopped', standbyFor: ['x'] }),
    ]);
    expect(plan.destroy.sort()).toEqual(['blue-spare', 'blue-standby']);
  });
});

describe('it refuses rather than guesses', () => {
  it('NEVER plans to destroy a machine on the image it keeps', () => {
    for (const pool of [incidentPool(), incidentPool().reverse()]) {
      const plan = planRepair(pool);
      const kept = new Set(pool.filter((m) => imageOf(m).id === plan.keep).map((m) => m.id));
      expect(kept.size).toBeGreaterThan(0);
      expect(plan.destroy.filter((id) => kept.has(id))).toEqual([]);
    }
  });

  it('refuses when no image is healthy', () => {
    const failing = [{ name: 'http', status: 'critical' }];
    const plan = planRepair([
      machine('a', 'app', NEW, { checks: failing }),
      machine('b', 'app', OLD, { state: 'stopped' }),
    ]);
    expect(plan).toMatchObject({ code: EXIT_REFUSED, action: 'refuse', destroy: [] });
    expect(plan.findings[0]).toMatch(/No image is both healthy/);
  });

  it('refuses when the only healthy machine of an image is a check-less worker', () => {
    // The web tier proves itself through its HTTP check. An image whose only
    // started machine has no check has not proven the tier that serves traffic.
    const plan = planRepair([
      machine('green-app', 'app', NEW, { release: 2, state: 'stopped' }),
      machine('green-worker', 'worker', NEW, { release: 2 }),
      machine('blue-app', 'app', OLD, {
        release: 1,
        checks: [{ name: 'http', status: 'critical' }],
      }),
      machine('blue-worker', 'worker', OLD, { release: 1 }),
    ]);
    expect(plan.action).toBe('refuse');
  });

  it('refuses to keep an image that is missing a process group — that would empty the group', () => {
    const plan = planRepair([
      machine('green-app', 'app', NEW, { release: 2 }),
      machine('blue-app', 'app', OLD, { release: 1 }),
      machine('blue-worker', 'worker', OLD, { release: 1 }),
    ]);
    // The newer image has no worker, so the older one — which covers both — is kept.
    expect(plan.keep).toContain(OLD);
    expect(plan.destroy).toEqual(['green-app']);

    const neither = planRepair([
      machine('green-app', 'app', NEW, { release: 2 }),
      machine('blue-worker', 'worker', OLD, { release: 1 }),
    ]);
    expect(neither.action).toBe('refuse');
  });

  it('refuses while a machine is mid-transition — somebody else is changing the app', () => {
    const pool = incidentPool();
    pool[0] = machine('green-app-0', 'app', NEW, { release: 1240, state: 'replacing' });
    const plan = planRepair(pool);
    expect(plan.action).toBe('refuse');
    expect(plan.findings[0]).toMatch(/mid-transition.*green-app-0 replacing/);
  });

  it('treats an empty or missing machine list as a blind read', () => {
    expect(planRepair([]).code).toBe(EXIT_BLIND_READ);
    expect(planRepair(null as unknown as []).code).toBe(EXIT_BLIND_READ);
  });
});

/** A fetch double that answers the list from a queue and records every DELETE. */
function fakeFly(lists: unknown[], { failDelete = false } = {}) {
  const deleted: string[] = [];
  const queue = [...lists];
  const request = vi.fn(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'DELETE') {
      const id = /machines\/([^?]+)\?force=true$/.exec(url)?.[1] ?? '?';
      deleted.push(id);
      return { ok: !failDelete, status: failDelete ? 500 : 200, json: async () => ({ ok: true }) };
    }
    const body = queue.length > 1 ? queue.shift() : queue[0];
    return { ok: true, status: 200, json: async () => body };
  });
  return { request: request as unknown as typeof fetch, deleted };
}

describe('the runner acts on the plan and proves the result', () => {
  const sleep = async () => {};

  it('destroys the old machines, re-reads, and exits clean on a single image', async () => {
    const after = incidentPool().filter((m) => m.id.startsWith('green-'));
    const fly = fakeFly([incidentPool(), after]);
    const lines: string[] = [];
    const code = await repairImageSet({
      app: 'motir-core',
      token: 't',
      fetch: fly.request,
      sleep,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(EXIT_CLEAN);
    expect(fly.deleted).toHaveLength(20);
    expect(fly.deleted.every((id) => id.startsWith('blue-'))).toBe(true);
    expect(lines.join('\n')).toContain('back on a single image');
  });

  it('changes nothing with --report-only, and still names both images', async () => {
    const fly = fakeFly([incidentPool()]);
    const lines: string[] = [];
    const code = await repairImageSet({
      app: 'motir-core',
      token: 't',
      reportOnly: true,
      fetch: fly.request,
      sleep,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(EXIT_CLEAN);
    expect(fly.deleted).toEqual([]);
    expect(lines.join('\n')).toContain(OLD);
    expect(lines.join('\n')).toContain(NEW);
  });

  it('fails when the app still runs two images after the destroys', async () => {
    const fly = fakeFly([incidentPool(), incidentPool()]);
    const code = await repairImageSet({
      app: 'motir-core',
      token: 't',
      fetch: fly.request,
      sleep,
      log: () => {},
    });
    expect(code).toBe(EXIT_REFUSED);
  });

  it('stops at the first failed destroy', async () => {
    const fly = fakeFly([incidentPool()], { failDelete: true });
    const code = await repairImageSet({
      app: 'motir-core',
      token: 't',
      fetch: fly.request,
      sleep,
      log: () => {},
    });
    expect(code).toBe(EXIT_REFUSED);
    expect(fly.deleted).toHaveLength(1);
  });

  it('waits for a mid-transition app to settle, then repairs it', async () => {
    const busy = incidentPool();
    busy[0] = machine('green-app-0', 'app', NEW, { release: 1240, state: 'starting' });
    const after = incidentPool().filter((m) => m.id.startsWith('green-'));
    const fly = fakeFly([busy, incidentPool(), after]);
    const waits: number[] = [];
    const code = await repairImageSet({
      app: 'motir-core',
      token: 't',
      fetch: fly.request,
      sleep: async (ms) => {
        waits.push(ms);
      },
      log: () => {},
      settleDelayMs: 5,
    });
    expect(code).toBe(EXIT_CLEAN);
    expect(waits).toEqual([5]);
    expect(fly.deleted).toHaveLength(20);
  });

  it('gives up, destroying nothing, when the app never settles', async () => {
    const busy = incidentPool();
    busy[0] = machine('green-app-0', 'app', NEW, { release: 1240, state: 'starting' });
    const fly = fakeFly([busy]);
    const code = await repairImageSet({
      app: 'motir-core',
      token: 't',
      fetch: fly.request,
      sleep,
      log: () => {},
      settleAttempts: 3,
    });
    expect(code).toBe(EXIT_REFUSED);
    expect(fly.deleted).toEqual([]);
  });

  it('reports a blind read when Fly answers an error', async () => {
    const request = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    const code = await repairImageSet({
      app: 'motir-core',
      token: 't',
      fetch: request as unknown as typeof fetch,
      sleep,
      log: () => {},
    });
    expect(code).toBe(EXIT_BLIND_READ);
  });
});
