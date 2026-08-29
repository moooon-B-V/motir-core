import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciRunnerBootService } from '@/lib/services/ciRunnerBootService';
import { ciRunnerProvisioningIntentRepository as intents } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { ciRunnerBootEvent } from '@/lib/ciFleet/bootDispatch';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { fakeOrchestrator } from '@/lib/orchestrator/adapters/fake';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { captureJobEvents, type CapturedJobEvent, spyOnJobDispatch } from '../helpers/jobs';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken, randomInt } from '../helpers/random';

// THE ADMISSION WAKE against real Postgres (MOTIR-2852) — the trigger that makes
// `system.ci-runner-provision-sweep` a backstop instead of the mechanism.
//
// The claim under test is again a LATENCY one and again not directly assertable,
// so what is asserted is what latency reduces to: when a slot frees, the boot
// event for whatever was queued behind it leaves IN THE SAME CALL that settled
// the intent, rather than waiting out a cron minute.
//
// What is real here: Postgres, the intent table and its RLS contexts, the whole
// repository read and its ordering. What is faked: the Inngest transport
// (`inngest.send`, as the whole suite already fakes it).
//
// ⚠️ ONE TEST HERE PROVES A CRITERION UNIMPLEMENTABLE RATHER THAN IMPLEMENTED —
// see `the DEFERRAL limb`. It is kept because the symmetry it refutes is the
// first thing the next reader will reach for.

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
/** ⚠️ RELATIVE to now, never a pinned calendar instant — the queue is ordered by
 *  this column, so the ORDER is what matters and the absolute value must not be
 *  able to read as the future on a machine whose clock sits early. */
const QUEUED_AT = new Date(Date.now() - 60_000);
const RUNNER_GROUP_ID = 5852;
/** Supervision, at test speed — the real loop, tiny deadlines. */
const FAST = { bootDeadlineMs: 40, jobTimeoutMs: 400, pollIntervalMs: 1 } as const;

/** One RSA key for the whole file: generating a 2048-bit pair per test costs more
 *  than every assertion in it. */
const { privateKey: APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(options: { withRunnerGroup?: boolean } = {}): Promise<Fixture> {
  const email = `fleet-wake-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `A${randomInt(100, 1000)}`,
  });
  if (options.withRunnerGroup) {
    await adminDb.project.update({
      where: { id: project.id },
      data: {
        runnerGroupId: RUNNER_GROUP_ID,
        runnerGroupName: `motir-project-${project.id}`,
        runnerGroupSyncedAt: new Date(),
      },
    });
  }
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

/** The per-call `jobId` counter. `runId` and `runAttempt` are FIXED for the whole
 *  file, so `@@unique([runId, runAttempt, jobId])` rests entirely on this one
 *  column — and it used to rest on `randomInt(900)`, i.e. on a birthday draw over
 *  900 values that collided at a low-single-digit rate per CI run and landed on
 *  whichever pull request was unlucky (MOTIR-3845). A counter is unique BY
 *  CONSTRUCTION, and it has the second property that matters: a failure here is
 *  now reproducible instead of arriving once a fortnight on somebody's branch. */
let jobSeq = 0;

/** One intent, exactly as MOTIR-1920's webhook handler writes it. `queuedAtMs` is
 *  an offset from {@link QUEUED_AT}, so a caller states the queue ORDER rather
 *  than a clock reading — and, per {@link jobSeq}, does not have to think about
 *  the row's IDENTITY either. */
async function seedIntent(
  fx: Fixture,
  overrides: {
    status?: string;
    projectId?: string | null;
    queuedAtMs?: number;
    jobId?: string;
  } = {},
) {
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: overrides.projectId === undefined ? fx.projectId : overrides.projectId,
      installationId: '556677',
      runId: '8001',
      runAttempt: 1,
      jobId: overrides.jobId ?? String(45_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: new Date(QUEUED_AT.getTime() + (overrides.queuedAtMs ?? 0)),
      status: overrides.status ?? 'pending',
    },
  });
}

/** The boot events captured off the transport, in order. */
function bootEvents(events: CapturedJobEvent[]): CapturedJobEvent[] {
  return events.filter((e) => e.name === 'system.ci-runner-boot');
}

let captured: { events: CapturedJobEvent[]; restore: () => void };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  fakeOrchestrator.reset();
  // Select the FAKE adapter the same way a deployment selects Fly — the wake is
  // gated on `isOrchestratorConfigured()`, exactly as the webhook's hot path is.
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', APP_PRIVATE_KEY);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string): Promise<Response> => {
      const target = String(url);
      if (target.endsWith(`/orgs/${MOTIR_ORG}/installation`)) return json(200, { id: 556677 });
      if (target.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (target.includes('generate-jitconfig')) {
        return json(201, {
          runner: { id: 9852, name: 'motir-runner', status: 'offline' },
          encoded_jit_config: 'ZW5jb2RlZC1qaXQ=',
        });
      }
      return new Response(null, { status: 204 });
    }),
  );
  captured = captureJobEvents();
});

afterEach(() => {
  captured.restore();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe("the fixture's own key space", () => {
  it('seeds twenty intents in one test without colliding on the unique index', async () => {
    // MOTIR-3845. This asserts a property of {@link seedIntent}, not of the
    // service — and it is the assertion that PROVES the fix rather than
    // restating it. `@@unique([runId, runAttempt, jobId])` with two of the three
    // columns hardcoded means the whole identity of a seeded row is `jobId`;
    // under the old `randomInt(900)` draw, twenty rows collide with roughly 20%
    // probability, so this test would have been red about one run in five. It is
    // deterministic now because a counter cannot repeat.
    const fx = await seedTenant();

    const seeded = [];
    for (let i = 0; i < 20; i += 1) seeded.push(await seedIntent(fx, { queuedAtMs: i * 1_000 }));

    const rows = await adminDb.ciRunnerProvisioningIntent.findMany({
      where: { workspaceId: fx.workspaceId },
      select: { runId: true, runAttempt: true, jobId: true },
    });
    expect(rows).toHaveLength(20);
    // `runId` / `runAttempt` are constants here, so distinct `jobId`s ARE
    // distinct keys — which is exactly why the draw was load-bearing.
    expect(new Set(rows.map((r) => `${r.runId}/${r.runAttempt}/${r.jobId}`)).size).toBe(20);
    expect(new Set(seeded.map((intent) => intent.id)).size).toBe(20);
  });
});

describe('a freed slot dispatches what was queued behind it', () => {
  it('dispatches the oldest pending intent for that project, as the shared event', async () => {
    // The whole card in one assertion: the moment a slot is free, the deferred
    // job's boot is already on the wire — no cron minute in between.
    const fx = await seedTenant();
    const older = await seedIntent(fx, { queuedAtMs: 0 });
    await seedIntent(fx, { queuedAtMs: 30_000 });

    const outcome = await ciRunnerBootService.dispatchNextPendingForProject(fx.projectId);

    expect(outcome).toBe('dispatched');
    // Byte-identical to what the webhook and the sweep send — one payload, three
    // senders, so the three cannot drift apart (`ciRunnerBootEvent`).
    expect(bootEvents(captured.events)).toEqual([ciRunnerBootEvent(older.id)]);
  });

  it('takes the queue in `queuedAt` order, not insertion order', async () => {
    // The slot goes to the job GitHub has been holding longest. A redelivered or
    // delayed webhook writes its row LAST and must not therefore be served last.
    const fx = await seedTenant();
    await seedIntent(fx, { queuedAtMs: 30_000 });
    const delayedDelivery = await seedIntent(fx, { queuedAtMs: -30_000 });

    await ciRunnerBootService.dispatchNextPendingForProject(fx.projectId);

    expect(bootEvents(captured.events)).toEqual([ciRunnerBootEvent(delayedDelivery.id)]);
  });

  it('never reaches across projects — a slot freed in one says nothing about another', async () => {
    // The per-project cap is what deferred the intent, so the freed capacity is
    // per-project too. Waking a sibling project would dispatch a boot the gate
    // has no reason to admit.
    const mine = await seedTenant();
    const theirs = await seedTenant();
    await seedIntent(theirs, { queuedAtMs: -60_000 });

    const outcome = await ciRunnerBootService.dispatchNextPendingForProject(mine.projectId);

    expect(outcome).toBe('no_pending');
    expect(bootEvents(captured.events)).toEqual([]);
  });

  it('ignores an intent that is no longer pending', async () => {
    // `provisioning` / `running` are the in-flight set, and a terminal row is
    // done. Only a `pending` row is waiting for a slot.
    const fx = await seedTenant();
    await seedIntent(fx, { status: 'running', queuedAtMs: -60_000 });
    await seedIntent(fx, { status: 'completed', queuedAtMs: -30_000 });

    expect(await ciRunnerBootService.dispatchNextPendingForProject(fx.projectId)).toBe(
      'no_pending',
    );
    expect(bootEvents(captured.events)).toEqual([]);
  });
});

describe('a real supervised COMPLETION wakes the project', () => {
  it('the queued sibling`s boot leaves in the same call that tore the container down', async () => {
    // The seam the card names, driven end to end rather than at the helper: a
    // container runs, its job finishes, `settleSupervision` records the teardown —
    // and the intent that was waiting behind it is already on the wire. Before
    // this existed, the only thing that came back for it was the minute cron.
    const fx = await seedTenant({ withRunnerGroup: true });
    const running = await seedIntent(fx, { queuedAtMs: -60_000 });
    const queued = await seedIntent(fx, { queuedAtMs: 0 });

    const outcome = await ciRunnerBootService.runIntent(running.id, {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    expect(outcome.outcome).toBe('settled');
    // The slot really did free — `provisioning`/`running` is the in-flight set the
    // per-project cap counts, and this row has left it.
    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: running.id },
    });
    expect(settled.status).toBe('completed');
    expect(bootEvents(captured.events)).toEqual([ciRunnerBootEvent(queued.id)]);
  });

  it('sends nothing when the completion leaves an empty queue', async () => {
    // The overwhelmingly common shape, and the one that must stay free: a
    // completion with nothing behind it costs one indexed read and no event.
    const fx = await seedTenant({ withRunnerGroup: true });
    const running = await seedIntent(fx, { queuedAtMs: -60_000 });

    await ciRunnerBootService.runIntent(running.id, {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    expect(bootEvents(captured.events)).toEqual([]);
  });
});

describe('the wake declines cheaply', () => {
  it('an empty queue is a no-op — the ordinary case, and why this is cheap', async () => {
    // One indexed read per teardown replaces one read per minute forever. The
    // read has to happen; what must not is a dispatch.
    const fx = await seedTenant();

    expect(await ciRunnerBootService.dispatchNextPendingForProject(fx.projectId)).toBe(
      'no_pending',
    );
    expect(bootEvents(captured.events)).toEqual([]);
  });

  it('a slot that belonged to no project reads nothing at all', async () => {
    // `admit` skips the per-project cap for a null-project intent, so nothing was
    // ever queued behind this slot — and there is no project to scope a read to.
    const fx = await seedTenant();
    await seedIntent(fx, { queuedAtMs: -60_000 });

    expect(await ciRunnerBootService.dispatchNextPendingForProject(null)).toBe('no_project');
    expect(bootEvents(captured.events)).toEqual([]);
  });

  it('an unconfigured deployment dispatches nothing — the same gate the hot path applies', async () => {
    // A deployment that cannot provision a container should not emit an event
    // whose only possible outcome is `not_configured`.
    const fx = await seedTenant();
    await seedIntent(fx, { queuedAtMs: -60_000 });
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');

    expect(await ciRunnerBootService.dispatchNextPendingForProject(fx.projectId)).toBe(
      'not_configured',
    );
    expect(bootEvents(captured.events)).toEqual([]);
  });
});

describe('the wake cannot fail the teardown it hangs off', () => {
  it('a send that throws is swallowed, and reported rather than only logged', async () => {
    // Every caller is a teardown, and a teardown that throws leaves a container's
    // bookkeeping half-written — the exact failure the settle path exists to
    // prevent. So the transport's failure resolves to an outcome.
    const fx = await seedTenant();
    await seedIntent(fx, { queuedAtMs: -60_000 });
    spyOnJobDispatch().mockRejectedValue(new Error('the event stream is unreachable'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ciRunnerBootService.dispatchNextPendingForProject(fx.projectId)).resolves.toBe(
      'send_failed',
    );
    expect(logged).toHaveBeenCalled();
  });

  it('a queue read that throws is swallowed too', async () => {
    // The read is as much a failure surface as the send, and it fails FIRST — so
    // covering only the send would leave the teardown exposed to the likelier of
    // the two (a suspended database's first query back).
    const fx = await seedTenant();
    vi.spyOn(intents, 'findNextPendingForProject').mockRejectedValue(new Error('P1001'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ciRunnerBootService.dispatchNextPendingForProject(fx.projectId)).resolves.toBe(
      'read_failed',
    );
    expect(logged).toHaveBeenCalled();
  });
});

describe('racing the sweep stays safe', () => {
  it('two dispatches for one intent leave the compare-and-set to decide', async () => {
    // The wake does not claim: it reads a `pending` row and sends. The sweep, the
    // webhook and another wake may all be looking at the same row, and
    // `claimPending` is what settles it — exactly one caller sees `true`, and the
    // loser boots nothing.
    const fx = await seedTenant();
    const queued = await seedIntent(fx, { queuedAtMs: -60_000 });

    await ciRunnerBootService.dispatchNextPendingForProject(fx.projectId);
    await ciRunnerBootService.dispatchNextPendingForProject(fx.projectId);

    // Two events for one intent — which is by design, and harmless:
    expect(bootEvents(captured.events)).toEqual([
      ciRunnerBootEvent(queued.id),
      ciRunnerBootEvent(queued.id),
    ]);
    const claims = await Promise.all([
      withSystemContext((tx) => intents.claimPending(queued.id, tx)),
      withSystemContext((tx) => intents.claimPending(queued.id, tx)),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});

describe('the DEFERRAL limb of the card — why it is NOT implemented', () => {
  it('would re-select the very intent that just deferred, which is turn one of a loop', async () => {
    // ⚠️ THIS TEST DEMONSTRATES A DEFECT IN THE CARD, NOT IN THE CODE. The card's
    // acceptance criterion 1 asked for a dispatch on `gate_deferred` as well as on
    // a freed slot. A deferral takes NO claim, so the deferring intent is still
    // `pending` and — whenever the queue is served in order, which includes every
    // case where it is the only queued intent — it is the row the queue read hands
    // back. Dispatching it re-enters a gate whose caps have not moved, defers
    // again, and dispatches again, with no wait in between.
    //
    // Excluding the trigger does not rescue it: two queued intents then trade the
    // dispatch between them, which is the same loop with one more step. The
    // criterion is amended on the record on MOTIR-2852.
    const fx = await seedTenant();
    const deferred = await seedIntent(fx, { queuedAtMs: 0 });
    await seedIntent(fx, { queuedAtMs: 30_000 });

    // What "dispatch on a deferral" would resolve to, at the moment of deferring:
    const next = await withSystemContext((tx) =>
      intents.findNextPendingForProject(fx.projectId, tx),
    );

    expect(next?.id).toBe(deferred.id);
  });
});
