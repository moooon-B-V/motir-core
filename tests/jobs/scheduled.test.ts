import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { defineJob } from '@/lib/jobs/defineJob';
import {
  dailyHealthCheck,
  DAILY_HEALTH_CHECK_PAYLOAD,
  DAILY_HEALTH_CHECK_CRON,
} from '@/lib/jobs/definitions/dailyHealthCheck';
import { truncateJobRuns } from '../helpers/db';
import { seedHealthyJobSchedules } from '../helpers/jobs';

// Scheduled-job primitive (Story 1.6 · Subtask 1.6.4) — the replacement for the
// 1.6.2 system.ping smoke test. Drives the `system.daily-health-check` cron job
// IN-PROCESS via @inngest/test (no live scheduler / dev server / cloud) and
// asserts the contract the scheduled path provides:
//   1. the function resolves to its static payload, and
//   2. the defineJob wrapper persisted a succeeded job_run row whose event_name
//      is the SYNTHETIC `scheduled.system.daily-health-check` (not Inngest's
//      internal cron-timer event name) — so the dashboard treats scheduled +
//      event-triggered runs uniformly, and
//   3. the cron expression is wired into the Inngest function config.

beforeEach(async () => {
  await truncateJobRuns();
});

// ── Registry fixtures for the two pull paths (MOTIR-2030) ────────────────────
//
// The runner pulls from ghcr.io (public, §1) and the indexer from
// registry.fly.io (a mirror of a closed image, §5). Keeping them on DIFFERENT
// hosts is what lets a test prove which path a verdict is about — a fixture
// where both images were the same string would pass for a preflight that probed
// the runner twice, which is the bug MOTIR-2030 fixes.

const RUNNER_REPO = 'moooon-b-v/motir-ci-runner';
const RUNNER_IMAGE = `ghcr.io/${RUNNER_REPO}@sha256:446c692d`;
const INDEXER_REPO = 'motir-ci-fleet/motir-indexer';
const INDEXER_IMAGE = `registry.fly.io/${INDEXER_REPO}@sha256:9f2c1ab4`;

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The `WWW-Authenticate` a v2 registry returns for THIS manifest URL — realm,
 *  service and scope all derived from the request, so one fixture serves both
 *  registries and neither can accidentally answer for the other. */
function challengeFor(url: URL): string {
  const repo = url.pathname.replace(/^\/v2\//, '').replace(/\/manifests\/.*$/, '');
  return `Bearer realm="https://${url.host}/token",service="${url.host}",scope="repository:${repo}:pull"`;
}

/** A v2 registry that hands out an anonymous token only for `publicRepos`, then
 *  serves the manifest to a bearer — the measured GHCR flow (ADR §2.1). */
function serveManifest(rawUrl: string, init: RequestInit | undefined, publicRepos: string[]) {
  const url = new URL(String(rawUrl));
  if (url.pathname === '/token') {
    const scope = url.searchParams.get('scope') ?? '';
    return publicRepos.some((repo) => scope.includes(repo))
      ? jsonRes(200, { token: 'anon-pull-token' })
      : jsonRes(401, { errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }] });
  }
  const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
  return auth
    ? jsonRes(200, {}, { 'docker-content-digest': 'sha256:deadbeef' })
    : jsonRes(401, {}, { 'www-authenticate': challengeFor(url) });
}

function registryServing(publicRepos: string[]) {
  return vi.fn(async (rawUrl: string, init?: RequestInit) =>
    serveManifest(rawUrl, init, publicRepos),
  );
}

// The fleet-preflight tests below stub env + `fetch`; unwinding them per test
// keeps a stubbed registry from following the next one.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
});

// A cron job has NO event trigger, so we invoke it WITHOUT an `events` array:
// @inngest/test then drives it via the internal `inngest/function.invoked`
// event (the direct-invoke path), which bypasses trigger-event validation. The
// wrapper records the ledger event_name as the synthetic `scheduled.{id}`
// regardless, so the assertions below prove the override.

// As of MOTIR-1970 the health check carries a real probe (the schedule-health
// check), so it only SUCCEEDS when every registered cron job is firing. These
// tests are about the scheduled-path primitive, not the probe, so they make the
// schedules healthy first — the probe's own behaviour is covered in
// `schedule-health.test.ts`.

describe('system.daily-health-check scheduled job', () => {
  it('runs to completion and returns the static payload', async () => {
    await seedHealthyJobSchedules();
    const engine = new InngestTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject(DAILY_HEALTH_CHECK_PAYLOAD);
  });

  it('writes a succeeded job_run row with the synthetic scheduled event name', async () => {
    await seedHealthyJobSchedules();
    const engine = new InngestTestEngine({ function: dailyHealthCheck });
    await engine.execute();

    // Only the wrapper writes a row for THIS function (the seed skips it), so
    // there is exactly one and it is the one under test.
    const runs = await db.jobRun.findMany({ where: { functionId: 'system.daily-health-check' } });
    expect(runs).toHaveLength(1);

    const run = runs[0]!;
    expect(run.functionId).toBe('system.daily-health-check');
    // The ledger event name is the synthetic scheduled.{id}, NOT event.name.
    expect(run.eventName).toBe('scheduled.system.daily-health-check');
    expect(run.status).toBe('succeeded');
    // System job → untenanted.
    expect(run.workspaceId).toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect(run.durationMs).not.toBeNull();
    expect(run.failure).toBeNull();
  });

  it('wires the cron expression into the Inngest function config', () => {
    const spy = vi.spyOn(inngest, 'createFunction');
    try {
      defineJob(
        { id: 'system.daily-health-check', cron: DAILY_HEALTH_CHECK_CRON },
        () => undefined,
      );
      const config = spy.mock.calls.at(-1)?.[0] as
        | { triggers?: Array<{ cron?: string }> }
        | undefined;
      expect(config?.triggers).toEqual([{ cron: '0 9 * * *' }]);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── THE FLEET BOOT PREFLIGHT'S HUMAN-VISIBLE SURFACE (MOTIR-2006) ────────────
//
// §6.1 of `docs/decisions/fleet-image-pull.md` asks for a preflight that "fails
// loudly, once, naming the image reference and the registry's own error". LOUDLY
// means somewhere a person looks: this job's `retryPolicy: 'none'` sends a
// failure straight to the DLQ, whose tab in `/settings/workspace/jobs` carries a
// badge count and renders `job_run.failure` in its detail panel. So the tests
// below assert the two things that make that surface worth having — that the row
// EXISTS, and that its message is a diagnosis rather than "the fleet is
// unhealthy".
//
// MOTIR-1980 is why: the fleet shipped unbootable and nothing anywhere said so.

describe('the fleet boot preflight rides the daily health check', () => {
  it('records the verdict on a HEALTHY tick — including when there is no fleet to check', async () => {
    // An unwired deployment is not a fault (a self-hosted `motir-core` has no
    // fleet at all), but the ledger still says which state it was in. A result
    // that only appeared on failure could not tell `not_applicable` from
    // `bootable`, and those are very different deployments.
    await seedHealthyJobSchedules();
    const engine = new InngestTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject({ ok: true, fleet: { verdict: 'not_applicable' } });
  });

  it('FAILS the run with a legible message when the configured image cannot be pulled', async () => {
    // The real chain, not a stubbed verdict: env selects Fly with a digest-pinned
    // image, and the registry refuses an anonymous pull token exactly as ghcr.io
    // does for a private package (measured 2026-08-02).
    await seedHealthyJobSchedules();
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', 'ghcr.io/moooon-b-v/motir-ci-runner@sha256:446c692d');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string): Promise<Response> => {
        const url = new URL(String(rawUrl));
        const body =
          url.pathname === '/token'
            ? { errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }] }
            : {};
        return new Response(JSON.stringify(body), {
          status: 401,
          headers: {
            'content-type': 'application/json',
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:moooon-b-v/motir-ci-runner:pull"',
          },
        });
      }),
    );

    const engine = new InngestTestEngine({ function: dailyHealthCheck });
    // `@inngest/test` CAPTURES a handler throw onto `error` rather than
    // rejecting — the same shape `schedule-health.test.ts` reads.
    const { result, error } = (await engine.execute()) as {
      result?: unknown;
      error?: { message?: string };
    };

    expect(result).toBeUndefined();
    // ⚠️ THE MESSAGE IS THE WHOLE SURFACE. It becomes `job_run.failure`, which
    // the DLQ detail panel renders and nothing beside it — so the diagnosis has
    // to be IN there: which image, what happened, and where to go next.
    expect(error?.message).toContain('ghcr.io/moooon-b-v/motir-ci-runner@sha256:446c692d');
    expect(error?.message).toContain('No CI container can boot');
    expect(error?.message).toContain('MOTIR_RUNNER_IMAGE');
    expect(error?.message).toContain('registry visibility');
  });

  it('does NOT fail the run when the registry merely could not be REACHED', async () => {
    // ⚠️ The arm that keeps the row trustworthy. A DNS blip is not a statement
    // about the image, and an alarm that fires on ghcr.io's uptime is one an
    // operator learns to ignore — which is how the next real MOTIR-1980 gets
    // missed.
    await seedHealthyJobSchedules();
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', 'ghcr.io/moooon-b-v/motir-ci-runner@sha256:446c692d');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND ghcr.io');
      }),
    );

    const engine = new InngestTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    // Green, but the indeterminate verdict is ON the row — a run of consecutive
    // ones is readable; it is just not an alarm.
    expect(result).toMatchObject({ ok: true, fleet: { verdict: 'indeterminate' } });
  });
});

// ── THE SECOND PULL PATH RIDES THE SAME SURFACE (MOTIR-2030) ─────────────────
//
// §5's third constraint on the indexer's mirror: "It is a second pull path. The
// fleet then has two, and each needs §6's preflight independently." The tests
// above cover the RUNNER's path and are unchanged; these cover the INDEXER's,
// and the thing they most need to pin is that the two verdicts stay TOLD APART
// — on the ledger row and, when it fails, in the message an operator reads.

describe("the INDEXER image's preflight rides the same health check", () => {
  /** A cloud deployment wired for CI, with the indexer optionally wired too. */
  function stubFleet(indexerImage?: string) {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', RUNNER_IMAGE);
    vi.stubEnv('MOTIR_INDEXER_IMAGE', indexerImage ?? '');
  }

  it('records BOTH verdicts on a healthy tick, and they can differ', async () => {
    // The ordinary cloud state today: CI is wired and indexing is not. A single
    // merged verdict could not express it — and "the fleet is fine" would be
    // true of a deployment that cannot index at all.
    await seedHealthyJobSchedules();
    stubFleet();
    vi.stubGlobal('fetch', registryServing([RUNNER_REPO]));

    const engine = new InngestTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject({
      ok: true,
      fleet: { verdict: 'bootable', reference: RUNNER_IMAGE },
      indexFleet: { verdict: 'not_applicable' },
    });
  });

  it('FAILS the run naming the INDEXER image when its registry refuses — with CI perfectly healthy', async () => {
    // ⚠️ THE CARD'S CENTRAL ASSERTION. The runner image is pullable throughout,
    // so a preflight that still probed only one image would report a GREEN run
    // while no index container could boot — the MOTIR-1980 shape, one workload
    // over. The message must name the INDEXER's reference, because it is the
    // whole of what the DLQ detail panel renders.
    await seedHealthyJobSchedules();
    stubFleet(INDEXER_IMAGE);
    // Fly's registry has collected the mirrored digest (§5.2); ghcr.io still
    // serves the runner.
    vi.stubGlobal('fetch', registryServing([RUNNER_REPO]));

    const engine = new InngestTestEngine({ function: dailyHealthCheck });
    const { result, error } = (await engine.execute()) as {
      result?: unknown;
      error?: { message?: string };
    };

    expect(result).toBeUndefined();
    expect(error?.message).toContain(INDEXER_IMAGE);
    expect(error?.message).toContain('MOTIR_INDEXER_IMAGE');
    // It names the INDEXER's failure and its likeliest cause — not the runner's
    // image, and not GHCR visibility, which would send the fix to the wrong
    // registry entirely.
    expect(error?.message).not.toContain(RUNNER_IMAGE);
    expect(error?.message).toContain('garbage-collects');
    expect(error?.message).toContain('CI is unaffected');
  });

  it('does NOT fail the run when the indexer registry merely could not be REACHED', async () => {
    // Same boundary the runner's path holds: a transport failure is not a claim
    // about the image, and an alarm on registry uptime is one an operator learns
    // to ignore.
    await seedHealthyJobSchedules();
    stubFleet(INDEXER_IMAGE);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string, init?: RequestInit): Promise<Response> => {
        // The runner resolves; only Fly's registry is unreachable.
        if (String(rawUrl).includes('registry.fly.io')) {
          throw new Error('getaddrinfo ENOTFOUND registry.fly.io');
        }
        return serveManifest(rawUrl, init, [RUNNER_REPO]);
      }),
    );

    const engine = new InngestTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject({
      ok: true,
      fleet: { verdict: 'bootable' },
      indexFleet: { verdict: 'indeterminate', reference: INDEXER_IMAGE },
    });
  });
});
