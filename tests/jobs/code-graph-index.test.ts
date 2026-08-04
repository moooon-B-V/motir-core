import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { codeGraphIndex } from '@/lib/jobs/definitions/codeGraphIndex';
import { codeGraphRefresh } from '@/lib/jobs/definitions/codeGraphRefresh';
import { jobServices } from '@/lib/jobs/services';
import { codeGraphIndexDispatchService } from '@/lib/services/codeGraphIndexDispatchService';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import { codeGraphIndexAdmissionService } from '@/lib/services/codeGraphIndexAdmissionService';
import { INDEX_ADMISSION_BUDGETS } from '@/lib/services/codeGraphIndexDispatchService';
import {
  DEFAULT_INDEX_IN_FLIGHT_CAP,
  indexInFlightCap,
  workspaceIndexInFlightCap,
} from '@/lib/ciFleet/limits';
import { fakeOrchestrator } from '@/lib/orchestrator/adapters/fake';
import { githubProvider } from '@/lib/git/providers/github';
import * as motirAiClient from '@/lib/ai/motirAiClient';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  containerExitsWith,
  INDEX_REPO_REF,
  INDEX_TARBALL_URL,
  indexEventFor,
  indexJobRuns,
  indexSleepSteps,
  indexStepIds,
  refreshEventFor,
  refreshJobRuns,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
  tarballBodyWasTouched,
} from '../helpers/indexFleet';

// system.code-graph-index — THE DURABLE STEP SHAPE (MOTIR-2027) — and
// system.code-graph-refresh, which drives the SAME one since MOTIR-2057.
//
// Driven IN-PROCESS via @inngest/test against a REAL Postgres, on the `fake`
// orchestrator, with only the two externals stubbed (GitHub's tarball redirect,
// motir-ai's run-credential mint).
//
// What is under test is not "does it index" — `tests/ciFleet/
// codeGraphIndexDispatch.test.ts` covers the dispatch service — but the DURABLE
// SHAPE and the LEDGER CONTRACT, because those are what production breaks on:
//
//   • The shape. An index run is minutes and `app/api/inngest/route.ts` pins
//     `maxDuration = 300`, so supervision must be a SEQUENCE OF BOUNDED STEPS
//     with `ctx.step.sleep` between them, never a loop inside one step. That is
//     the MOTIR-2007 defect applied to a second workload.
//   • The ledger. Whatever the fan-out does internally — one container per
//     (repo × project) — the JOB still writes ONE `job_run` per repo with ONE
//     `output.repoRef`, because `listSucceededCodeGraphIndexRepoRefs` and the
//     onboarding wizard's per-repo rows read exactly that
//     (`docs/decisions/code-graph-index-fleet.md` §6).
//   • And no repo tarball ever enters the function again (§2).
//
// @inngest/test hands back a mocked `ctx`, so `ctx.step.run` is a spy and the
// step ids it was called with are directly assertable — the closest thing to
// observing the executor's checkpoints from a unit test.
//
// ⚠️ `step.sleep` HANGS `InngestTestEngine` UNLESS ITS STATE IS SUPPLIED. The
// engine only records state for steps that RAN, and a sleep never "runs" — so an
// un-stubbed sleep is re-found forever and `execute()` never resolves (it fails
// as a test TIMEOUT, which reads like a slow test rather than a missing stub).
// `sleepSteps()` pre-fulfils them; supply more than the loop can use.

// The world this suite drives is the SHARED index-fleet fixture
// (`tests/helpers/indexFleet.ts`), so the seam suite that reads the ledger's
// real consumers measures the same one. The aliases below keep this file's call
// sites reading as they did when the fixture was inlined here.
const TARBALL_URL = INDEX_TARBALL_URL;
const REPO_REF = INDEX_REPO_REF;
const seedWorkspace = seedIndexWorkspace;
const stepIds = indexStepIds;
const sleepSteps = indexSleepSteps;
const indexRuns = indexJobRuns;
const indexEvent = (installationId: string, workspaceId: string) =>
  indexEventFor({ installationId, workspaceId, eventId: `evt-${installationId}` });

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  // The admission slots are real rows and no FK cascade reaches them (a slot must
  // survive the deletion of whatever it pointed at — the model comment). A file
  // that left them behind would slowly fill the index lane and start deferring
  // its own later cases.
  await db.fleetInFlightSlot.deleteMany({});
  _resetInstallationTokenCache();
  fakeOrchestrator.reset();
  resetTarballBodyTrap();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE — boot → poll(×N) → settle, per project, as separate durable steps.
// ─────────────────────────────────────────────────────────────────────────────

describe('system.code-graph-index — durable steps, never a supervision loop', () => {
  it('drives boot → poll → settle as SEPARATE steps per project, sleeping in between', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-shape', 2);
    stubIndexFleet();
    containerExitsWith(0);
    // The in-process composition exists for scripts and the service's own suite.
    // A job that called it would rebuild the hour-long invocation MOTIR-2007
    // removed for CI — so the assertion is that the JOB never touches it.
    const inProcess = vi.spyOn(codeGraphIndexDispatchService, 'runIndexContainer');
    const boot = vi.spyOn(codeGraphIndexDispatchService, 'bootIndexContainer');

    const engine = new InngestTestEngine({ function: codeGraphIndex });
    const { result, ctx } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
      steps: sleepSteps(projectIds),
    });

    expect(result).toEqual({ indexed: true, repoRef: REPO_REF, projectsIndexed: 2 });
    expect(inProcess).not.toHaveBeenCalled();

    const ids = stepIds(ctx).filter((id) => !id.startsWith('job-run:'));
    expect(ids[0]).toBe('resolve-target');
    expect(ids[1]).toBe('assert-fleet-configured');
    // Each project's phases are DISTINCT checkpoints, in order — the property
    // that makes a step, not the run, the unit `maxDuration` applies to. The cap
    // is the first of them (MOTIR-1990): nothing may be booted before a
    // `fleet_in_flight_slot` has been taken for it.
    for (const projectId of projectIds) {
      const own = ids.filter((id) => id.endsWith(`:${projectId}`) || id.includes(`:${projectId}:`));
      expect(own[0]).toBe(`index-admit:${projectId}:1`);
      expect(own[1]).toBe(`index-boot:${projectId}`);
      expect(own[2]).toBe(`index-poll:${projectId}:1`);
      expect(own.at(-1)).toBe(`index-settle:${projectId}`);
    }

    // ⚠️ NO STEP CONTAINS A SUPERVISION LOOP. The boot step's own resolved value
    // is a SESSION awaiting supervision — not a settled outcome — so the boot
    // cannot have waited for the container inside its own step. A regression
    // that awaited the run inside `bootIndexContainer` fails right here.
    for (const call of boot.mock.results) {
      expect(await call.value).toMatchObject({ phase: 'supervising' });
    }
  }, 30_000);

  it('supervises across MANY poll steps, then settles — a container outliving one invocation', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-long', 1);
    stubIndexFleet();
    // Not terminal until the fourth poll: a container that ran for longer than
    // the supervising invocation could itself have lasted.
    const realPoll = codeGraphIndexDispatchService.pollIndexContainer.bind(
      codeGraphIndexDispatchService,
    );
    let polls = 0;
    const poll = vi
      .spyOn(codeGraphIndexDispatchService, 'pollIndexContainer')
      .mockImplementation(async (session, previous, options) => {
        polls += 1;
        if (polls >= 4) {
          for (const id of fakeOrchestrator.liveContainerIds()) {
            fakeOrchestrator.completeJob(id, { exitCode: 0 });
          }
        }
        return realPoll(session, previous, options);
      });

    const engine = new InngestTestEngine({ function: codeGraphIndex });
    const { result, ctx } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
      steps: sleepSteps(projectIds),
    });

    expect(poll).toHaveBeenCalledTimes(4);
    const projectId = projectIds[0]!;
    // Four polls means four checkpoints, each its own invocation budget — and a
    // sleep between every pair, which costs no invocation at all.
    expect(stepIds(ctx)).toEqual(
      expect.arrayContaining([
        `index-poll:${projectId}:1`,
        `index-poll:${projectId}:4`,
        `index-settle:${projectId}`,
      ]),
    );
    expect(result).toEqual({ indexed: true, repoRef: REPO_REF, projectsIndexed: 1 });
    // Teardown was reached — the guarantee the whole stepped shape exists for.
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(fakeOrchestrator.teardowns).toHaveLength(1);
  }, 30_000);

  it('NEVER materializes the repo tarball in the function', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-bytes', 2);
    stubIndexFleet();
    containerExitsWith(0);
    // The two ways bytes used to enter this process: the buffering fetch, and
    // the motir-ai upload that carried them.
    const fetchBytes = vi.spyOn(githubProvider, 'fetchRepoTarball');
    const upload = vi.spyOn(motirAiClient, 'indexCodeGraph');

    const engine = new InngestTestEngine({ function: codeGraphIndex });
    const { result } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
      steps: sleepSteps(projectIds),
    });

    expect(result).toMatchObject({ indexed: true });
    // ⚠️ THE DEFECT, INVERTED (§2). `motir-core` itself exhausted 5/5 attempts on
    // the old path because the function buffered a whole repo; the pre-signed URL
    // now goes to the container and the body is never read here at all.
    expect(tarballBodyWasTouched()).toBe(false);
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    // What the container was actually handed: the resolved URL, not a token.
    for (const spec of fakeOrchestrator.specs) {
      expect(spec.env['MOTIR_INDEX_TARBALL_URL']).toBe(TARBALL_URL);
    }
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE LEDGER CONTRACT — one `job_run` per REPO, one `output.repoRef` (§6).
// ─────────────────────────────────────────────────────────────────────────────

describe('the ledger stays per REPO however many containers the fan-out boots', () => {
  it.each([1, 2])(
    'writes ONE succeeded run with ONE repoRef for a workspace with %i project(s)',
    async (projectCount) => {
      const { workspaceId, projectIds, installationId } = await seedWorkspace(
        `cgf-ledger${projectCount}`,
        projectCount,
      );
      stubIndexFleet();
      containerExitsWith(0);

      const engine = new InngestTestEngine({ function: codeGraphIndex });
      const { result } = await engine.execute({
        events: [indexEvent(installationId, workspaceId)],
        steps: sleepSteps(projectIds),
      });

      // One container PER (repo × project) — the fan-out really did widen.
      expect(fakeOrchestrator.provisioned).toHaveLength(projectCount);
      expect(result).toEqual({
        indexed: true,
        repoRef: REPO_REF,
        projectsIndexed: projectCount,
      });

      // ⚠️ AND THE LEDGER DID NOT. Two projects must not become two rows or two
      // repoRefs: `listSucceededCodeGraphIndexRepoRefs` builds the indexed SET
      // from these rows, and the wizard's per-repo rows and `allIndexed` gate on
      // it. This is the case that proves the ledger did not become per-project.
      const runs = await indexRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe('succeeded');
      expect(runs[0]!.output).toEqual({
        indexed: true,
        repoRef: REPO_REF,
        projectsIndexed: projectCount,
      });
    },
    30_000,
  );

  it('the enqueue gate reads the run back as exactly one indexed repoRef', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-gate', 2);
    stubIndexFleet();
    containerExitsWith(0);

    const engine = new InngestTestEngine({ function: codeGraphIndex });
    await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
      steps: sleepSteps(projectIds),
    });

    // Read BACK through the consumer, not through the row: the contract is what
    // the gate and the onboarding wizard see, and a shape change that still
    // stored "something" would pass a row assertion and fail here.
    const { withSystemContext } = await import('@/lib/workspaces/context');
    const { jobRunRepository } = await import('@/lib/repositories/jobRunRepository');
    const refs = await withSystemContext((tx) =>
      jobRunRepository.listSucceededCodeGraphIndexRepoRefs(workspaceId, tx),
    );
    expect(refs).toEqual([REPO_REF]);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE THREE NO-OP VERDICTS — the shipped contract that the job never throws on
// a tenant that went away, and the ledger records WHY nothing was indexed.
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveIndexTarget’s no-op verdicts still reach the ledger unchanged', () => {
  it('installation_missing: resolves in ONE step, boots nothing, and records the reason', async () => {
    const { workspaceId } = await seedWorkspace('cgf-noinst', 1);
    stubIndexFleet();

    const engine = new InngestTestEngine({ function: codeGraphIndex });
    const { result, ctx } = await engine.execute({
      events: [indexEvent('inst-gone', workspaceId)],
    });

    expect(result).toEqual({ indexed: false, reason: 'installation_missing' });
    const runs = await indexRuns();
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.output).toEqual({ indexed: false, reason: 'installation_missing' });
    // Nothing was spent: not the config gate, not a container.
    expect(stepIds(ctx)).not.toContain('assert-fleet-configured');
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });

  it('no_projects: a workspace with nothing to index boots nothing and records the reason', async () => {
    const { workspaceId, installationId } = await seedWorkspace('cgf-noproj', 0);
    stubIndexFleet();

    const engine = new InngestTestEngine({ function: codeGraphIndex });
    const { result, ctx } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    });

    expect(result).toEqual({ indexed: false, reason: 'no_projects' });
    const runs = await indexRuns();
    expect(runs[0]!.output).toEqual({ indexed: false, reason: 'no_projects' });
    expect(stepIds(ctx)).not.toContain('assert-fleet-configured');
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });

  it('workspace_missing: a vanished tenant is a clean no-op, never a throw', async () => {
    const { installationId } = await seedWorkspace('cgf-nows', 1);
    stubIndexFleet();

    const engine = new InngestTestEngine({ function: codeGraphIndex });
    const { result, error, ctx } = (await engine.execute({
      events: [indexEvent(installationId, 'ws-gone')],
    })) as { result?: unknown; error?: unknown; ctx: Parameters<typeof stepIds>[0] };

    expect(error).toBeUndefined();
    expect(result).toEqual({ indexed: false, reason: 'workspace_missing' });
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(stepIds(ctx)).not.toContain('assert-fleet-configured');
    // ⚠️ THIS VERDICT ALONE HAS NO LEDGER ROW, and that is `job_run.workspaceId`'s
    // FK rather than a gap here: `recordStart` catches the P2003 for a tenant that
    // is already gone (MOTIR-1545) and returns null, so there is no row to flip.
    // The verdict is still the run's RESULT, which is what the assertion above
    // pins — and a workspace that exists (the two cases above) does get the row.
    expect(await indexRuns()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP IDS ARE KEYED BY projectId — what Inngest memoizes against.
// ─────────────────────────────────────────────────────────────────────────────

describe('step ids identify the SAME unit of work on every replay', () => {
  it('keys boot / poll / settle by project id, never by loop position', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-keys', 2);
    stubIndexFleet();
    containerExitsWith(0);

    const engine = new InngestTestEngine({ function: codeGraphIndex });
    const { ctx } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
      steps: sleepSteps(projectIds),
    });

    const ids = stepIds(ctx);
    for (const projectId of projectIds) {
      expect(ids).toContain(`index-boot:${projectId}`);
      expect(ids).toContain(`index-poll:${projectId}:1`);
      expect(ids).toContain(`index-settle:${projectId}`);
    }
    // A positional id would re-point at a DIFFERENT project if the workspace's
    // project list changed between attempts. None exists.
    expect(ids.filter((id) => /^index-(boot|settle):\d+$/.test(id))).toEqual([]);
  }, 30_000);

  it('a replay after the project list changed resumes the MEMOIZED project', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-replay', 1);
    stubIndexFleet();
    containerExitsWith(0);
    const memoizedProjectId = projectIds[0]!;

    // The replay: `resolve-target` comes back from Inngest's memo, and the
    // workspace has since gained a project the memo never saw. A run that
    // re-derived its fan-out from the live list would now index the NEW project.
    const resolved = await codeGraphIndexService.resolveIndexTarget({
      installationId,
      workspaceId,
      repoOwner: 'moooon',
      repoName: 'motir-core',
      defaultBranch: 'main',
    });
    const drifted = await projectsService.createProject({
      workspaceId,
      actorUserId: (await db.user.findFirstOrThrow()).id,
      name: 'Added between attempts',
      identifier: 'DRIFT',
    });
    const boot = vi.spyOn(codeGraphIndexDispatchService, 'bootIndexContainer');

    const engine = new InngestTestEngine({ function: codeGraphIndex });
    const { result, ctx } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
      steps: [
        { id: 'resolve-target', handler: () => resolved },
        ...sleepSteps([memoizedProjectId, drifted.id]),
      ],
    });

    // It resumed the SAME project's work. The drifted project is not indexed by
    // this run — it belongs to the next one, which will resolve it for itself.
    expect(stepIds(ctx)).toContain(`index-boot:${memoizedProjectId}`);
    expect(stepIds(ctx)).not.toContain(`index-boot:${drifted.id}`);
    expect(boot.mock.calls.map((call) => call[0]!.projectId)).toEqual([memoizedProjectId]);
    expect(result).toEqual({ indexed: true, repoRef: REPO_REF, projectsIndexed: 1 });
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// FAILURE — the run FAILS, loudly and by name, rather than claiming a repo.
// ─────────────────────────────────────────────────────────────────────────────

describe('a container that did not index FAILS the run', () => {
  it.each([
    [30, 'graph_unbuildable'],
    [137, 'out_of_memory'],
    [50, 'credential_refused'],
    [null, 'exit_unobserved'],
  ] as const)(
    'exit %s surfaces the NAMED class %s, and records no success',
    async (code, name) => {
      const { workspaceId, projectIds, installationId } = await seedWorkspace(
        `cgf-x${code ?? 'null'}`,
        1,
      );
      stubIndexFleet();
      containerExitsWith(code);

      const engine = new InngestTestEngine({ function: codeGraphIndex });
      // `@inngest/test` CAPTURES a handler throw onto `error` (serialized, so the
      // subclass name flattens to `Error`) rather than rejecting `execute()`.
      const { result, error } = (await engine.execute({
        events: [indexEvent(installationId, workspaceId)],
        steps: sleepSteps(projectIds),
      })) as { result?: unknown; error?: { message?: string } };

      expect(result).toBeUndefined();
      // The exit code is the container's entire diagnostic channel, so the run
      // reports what happened by NAME — "the parser died on this tree" and "the
      // kernel killed it" are different on-call responses.
      expect(error?.message).toContain(name);
      expect(error?.message).toContain(REPO_REF);

      // ⚠️ AND NOTHING CLAIMS THE REPO. A `succeeded` row carrying an
      // `output.repoRef` would tell the enqueue gate and the wizard that this repo
      // has a code graph, forever — for a container that did not build one.
      const runs = await indexRuns();
      expect(runs.filter((run) => run.status === 'succeeded')).toEqual([]);
      expect(runs.every((run) => run.output === null)).toBe(true);
      // The container was still torn down: failure is not a leak.
      expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    },
    30_000,
  );

  it('stops at the FIRST failing project rather than booting the rest', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-firstfail', 3);
    stubIndexFleet();
    containerExitsWith(30);

    const engine = new InngestTestEngine({ function: codeGraphIndex });
    await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
      steps: sleepSteps(projectIds),
    });

    // One container, not three. A retry RESUMES from the memoized steps, so
    // failing fast costs nothing and spends nothing.
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  }, 30_000);

  it('a container that never STARTED fails as never_started, carrying supervision’s own detail', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-nostart', 1);
    stubIndexFleet();
    // The boot deadline firing is a wall-clock event (120s), so it is driven at
    // the poll rather than by waiting: the provider reported a machine, and it
    // never reached a running state.
    vi.spyOn(codeGraphIndexDispatchService, 'pollIndexContainer').mockResolvedValue({
      done: true,
      reason: 'provision_failed',
      startedAt: null,
      exitCode: null,
      failureDetail: 'the container never started',
    });

    const engine = new InngestTestEngine({ function: codeGraphIndex });
    const { result, error } = (await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
      steps: sleepSteps(projectIds),
    })) as { result?: unknown; error?: { message?: string } };

    expect(result).toBeUndefined();
    // A boot that never happened is its OWN class — not `graph_unbuildable`,
    // which would send an operator looking at the repo instead of the fleet —
    // and the run reports supervision's own detail rather than the exit's.
    expect(error?.message).toContain('never_started');
    expect(error?.message).toContain('the container never started');
    // It was still torn down: a machine nothing destroys is billed until the reaper.
    expect(fakeOrchestrator.teardowns).toHaveLength(1);
    expect((await indexRuns()).filter((run) => run.status === 'succeeded')).toEqual([]);
  }, 30_000);

  it('a provider that refuses to boot fails the run — no container, no success', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-noboot', 1);
    stubIndexFleet();
    fakeOrchestrator.failNextProvision('no capacity in iad');

    const engine = new InngestTestEngine({ function: codeGraphIndex });
    const { result, error } = (await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
      steps: sleepSteps(projectIds),
    })) as { result?: unknown; error?: { message?: string } };

    expect(result).toBeUndefined();
    expect(error?.message).toContain('provision_failed');
    expect((await indexRuns()).filter((run) => run.status === 'succeeded')).toEqual([]);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CONFIG GATE — unconfigured must be LOUD, never a silent `succeeded` row.
// ─────────────────────────────────────────────────────────────────────────────

describe('an unconfigured index fleet fails the run loudly', () => {
  it('gates BEFORE the fan-out and writes no succeeded row with a repoRef', async () => {
    const { workspaceId, installationId } = await seedWorkspace('cgf-unconfigured', 2);
    stubIndexFleet();
    // Select the REAL adapter on a deployment that has none of its variables —
    // exactly a self-hosted build, or a cloud one that lost its secrets.
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    for (const name of [
      'FLY_FLEET_API_TOKEN',
      'FLY_FLEET_APP',
      'MOTIR_RUNNER_IMAGE',
      'MOTIR_INDEXER_IMAGE',
    ]) {
      vi.stubEnv(name, undefined);
    }
    const boot = vi.spyOn(codeGraphIndexDispatchService, 'bootIndexContainer');

    const engine = new InngestTestEngine({ function: codeGraphIndex });
    const { result, error, ctx } = (await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    })) as { result?: unknown; error?: { message?: string }; ctx: Parameters<typeof stepIds>[0] };

    // LOUD: the run fails, naming what to set — never a quiet "nothing to do".
    expect(result).toBeUndefined();
    expect(error?.message).toMatch(/set /i);
    expect(stepIds(ctx)).toContain('assert-fleet-configured');
    // Nothing was attempted or billed.
    expect(boot).not.toHaveBeenCalled();
    expect(fakeOrchestrator.provisioned).toEqual([]);

    // ⚠️ THE ROW THAT MUST NOT EXIST. A `succeeded` run carrying an
    // `output.repoRef` in this state is indistinguishable from a real index
    // everywhere downstream — the enqueue gate skips the repo and the wizard
    // ticks it — for a deployment that cannot index anything at all.
    const runs = await indexRuns();
    expect(runs.filter((run) => run.status === 'succeeded')).toEqual([]);
    expect(runs.some((run) => run.output !== null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ADMISSION CAP, as durable steps — over the cap means WAIT (MOTIR-1990).
// ─────────────────────────────────────────────────────────────────────────────

describe('the admission cap queues in STEPS, and nothing is dropped', () => {
  // ⚠️ THE SHAPE THE CARD TURNS ON. A deferral must produce ANOTHER attempt under
  // a DIFFERENT step id, with `ctx.step.sleep` between them. One shared id would
  // let Inngest memoize the first `deferred` answer for the life of the run, and
  // an index that waits could then never be admitted — "wait" would silently
  // become "drop".
  it('asks again under a NEW step id after a deferral, and boots once admitted', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-queue', 1);
    stubIndexFleet();
    containerExitsWith(0);
    // ⚠️ Bind the REAL method BEFORE spying, or the fall-through below re-enters
    // the spy and recurses forever.
    const real = codeGraphIndexAdmissionService.admit.bind(codeGraphIndexAdmissionService);
    const admit = vi.spyOn(codeGraphIndexAdmissionService, 'admit');
    admit
      .mockResolvedValueOnce({
        outcome: 'deferred',
        reason: 'index_cap',
        detail: 'indexing is at its global cap (6/6)',
      })
      .mockResolvedValueOnce({
        outcome: 'deferred',
        reason: 'workspace_index_cap',
        detail: 'the workspace is at its index cap (3/3, half of the global 6)',
      })
      .mockImplementation(real);

    const engine = new InngestTestEngine({ function: codeGraphIndex });
    const { result, ctx } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
      steps: sleepSteps(projectIds),
    });

    // It waited twice and then indexed. NOTHING was dropped.
    expect(result).toEqual({ indexed: true, repoRef: REPO_REF, projectsIndexed: 1 });
    const projectId = projectIds[0]!;
    const ids = stepIds(ctx);
    expect(ids).toContain(`index-admit:${projectId}:1`);
    expect(ids).toContain(`index-admit:${projectId}:2`);
    expect(ids).toContain(`index-admit:${projectId}:3`);
    // Every attempt is its own checkpoint, so none of them is memoized into the
    // previous one's answer.
    expect(new Set(ids).size).toBe(ids.length);
    // The WAITING is a sleep — it costs a checkpoint, never an invocation.
    const sleeps = (
      ctx as unknown as { step: { sleep: { mock: { calls: unknown[][] } } } }
    ).step.sleep.mock.calls.map((call) => String(call[0]));
    expect(sleeps).toContain(`index-admit-wait:${projectId}:1`);
    expect(sleeps).toContain(`index-admit-wait:${projectId}:2`);
  }, 30_000);

  // The cap is STRUCTURAL on this path, not conventional: `bootIndexContainer`
  // requires the ticket, so a boot with no admission is a type error — and this
  // is the runtime half, that the ticket a boot receives is the one the gate
  // actually granted.
  it('boots on the ticket the gate granted, and never before it', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-ticket', 1);
    stubIndexFleet();
    containerExitsWith(0);
    const boot = vi.spyOn(codeGraphIndexDispatchService, 'bootIndexContainer');

    const engine = new InngestTestEngine({ function: codeGraphIndex });
    await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
      steps: sleepSteps(projectIds),
    });

    expect(boot).toHaveBeenCalledTimes(1);
    const admission = boot.mock.calls[0]![1];
    expect(admission.slotRef).toBe(`${projectIds[0]}:${REPO_REF}`);
    // And the slot really was taken and then given back — the container is gone,
    // so the capacity is free.
    expect(await db.fleetInFlightSlot.count()).toBe(0);
  }, 30_000);

  // ⚠️ THE LEDGER CONTRACT UNDER A REFUSAL (§6). A run that could not get
  // capacity must FAIL, never record a `succeeded` row carrying an
  // `output.repoRef` — that row is a permanent claim, to every reader, that the
  // repo has a code graph.
  it('FAILS the run when admission is never granted — it never claims the repo', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-starved', 1);
    stubIndexFleet();
    vi.spyOn(codeGraphIndexAdmissionService, 'admit').mockResolvedValue({
      outcome: 'deferred',
      reason: 'fleet_ceiling',
      detail: 'the fleet is at its in-flight ceiling (24/24: CI runners 24)',
    });

    const engine = new InngestTestEngine({ function: codeGraphIndex });
    const { error } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
      // Enough sleeps for the whole waiting budget.
      steps: sleepSteps(projectIds, INDEX_ADMISSION_BUDGETS.maxAttempts),
    });

    // The named failure, not a bare throw: the operator reads the reason off it.
    expect((error as Error).message).toContain('admission_deferred');
    expect((error as Error).message).toContain('fleet_ceiling');
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
    // The ledger recorded a FAILED run, not a success with an `output.repoRef`.
    const runs = await indexRuns();
    expect(runs.at(-1)?.status).not.toBe('succeeded');
    expect(runs.at(-1)?.output).toBeNull();
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE DEFINITION — the cap is NOT here, and must never come back (MOTIR-1990).
// ─────────────────────────────────────────────────────────────────────────────

describe('the job definition carries NO concurrency number', () => {
  // ⚠️ A REGRESSION GUARD, not a tautology. `concurrency: 2` lived here until
  // MOTIR-1990 and the temptation to put a number back is exactly what §7
  // forbids. Two reasons it must stay absent, both fatal:
  //   • It would make the CONFIGURED cap a lie. A stepped supervision loop holds
  //     its Inngest slot for the CONTAINER'S WHOLE LIFE, so a limit of 2 beside a
  //     configured cap of six means two, whatever an operator sets.
  //   • It is UNKEYED, which is the starvation it was meant to prevent — one
  //     tenant's five repos ahead of another's first index. A per-tenant limit
  //     here would need a KEYED concurrency, which `defineJob` discards entirely
  //     (MOTIR-1982) — the bug this card deliberately does not wait on.
  it('leaves concurrency to the orchestrator’s admission cap, and keeps the retry policy', () => {
    // Read off the SHIPPED function object — the config Inngest was actually
    // constructed with — rather than re-invoking `defineJob` with the options a
    // test believes the definition passes.
    const config = (codeGraphIndex as unknown as { opts: Record<string, unknown> }).opts as {
      id?: string;
      retries?: number;
      concurrency?: { limit: number };
    };

    expect(config.id).toBe('system.code-graph-index');
    expect(config.concurrency).toBeUndefined();
    // `idempotent` = 5 attempts = 4 Inngest retries. Re-indexing converges: a
    // re-dispatched container rebuilds the same graph over the same key.
    expect(config.retries).toBe(4);
  });

  // Where the number went. Both are read from config so an operator can move
  // them against the fleet spend cap with no deploy, and the per-tenant one is
  // DERIVED from the global so the two cannot drift apart.
  it('puts the numbers in config, with the per-workspace one derived', () => {
    expect(indexInFlightCap()).toBe(DEFAULT_INDEX_IN_FLIGHT_CAP);
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '10');
    expect(indexInFlightCap()).toBe(10);
    expect(workspaceIndexInFlightCap(indexInFlightCap())).toBe(5);
  });

  it('exposes the dispatch service on the job DI seam', () => {
    // The 4-layer seam: `defineJob` hands the handler `jobServices`, so the step
    // shape drives the real singleton rather than importing it ad hoc.
    expect(jobServices.codeGraphIndexDispatch).toBe(codeGraphIndexDispatchService);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REFRESH — THE SAME FLEET PATH AS THE FIRST INDEX (MOTIR-2057).
//
// MOTIR-2027 left this job on the in-process shape (§11: "Still building
// in-process, unchanged") and production then ran the abandoned path at a ~68%
// failure rate for three days: `motir-core`'s whole-tree parse does not fit in
// the 180 s `MOTIR_AI_INDEX_TIMEOUT_MS` client deadline, and its five idempotent
// retries starved every other repo's refresh against motir-ai's one parse
// permit. So what these cases pin is that a PUSH refresh dispatches containers,
// that its per-repo debounce survived the move, and that the first-index path
// did not change — not one of which is safe to read off the diff.
// ─────────────────────────────────────────────────────────────────────────────

describe('system.code-graph-refresh runs on the INDEX FLEET', () => {
  it('drives boot → poll → settle per project, and NEVER fetches bytes in-process', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgj-refresh', 2);
    stubIndexFleet();
    containerExitsWith(0);
    // The two ways bytes used to enter this process on a push: the buffering
    // fetch, and the motir-ai upload that carried them under the 180 s deadline.
    const fetchBytes = vi.spyOn(githubProvider, 'fetchRepoTarball');
    const upload = vi.spyOn(motirAiClient, 'indexCodeGraph');

    const engine = new InngestTestEngine({ function: codeGraphRefresh });
    const { result, ctx } = await engine.execute({
      events: [refreshEventFor({ installationId, workspaceId })],
      steps: sleepSteps(projectIds),
    });

    // The ledger row a refresh writes is unchanged in SHAPE — one per repo, one
    // repoRef — which is what makes this a path swap and not a contract change.
    expect(result).toEqual({ indexed: true, repoRef: REPO_REF, projectsIndexed: 2 });

    const ids = stepIds(ctx).filter((id) => !id.startsWith('job-run:'));
    expect(ids[0]).toBe('resolve-target');
    expect(ids[1]).toBe('assert-fleet-configured');
    for (const projectId of projectIds) {
      const own = ids.filter((id) => id.endsWith(`:${projectId}`) || id.includes(`:${projectId}:`));
      expect(own[0]).toBe(`index-admit:${projectId}:1`);
      expect(own[1]).toBe(`index-boot:${projectId}`);
      expect(own[2]).toBe(`index-poll:${projectId}:1`);
      expect(own.at(-1)).toBe(`index-settle:${projectId}`);
    }

    // ⚠️ THE DEFECT, INVERTED. A push used to buffer `motir-core`'s whole tree
    // into this function and POST it; one container per (repo × project) now
    // fetches it from the pre-signed URL instead, and the body is never read here.
    expect(tarballBodyWasTouched()).toBe(false);
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(fakeOrchestrator.provisioned).toHaveLength(2);
    for (const spec of fakeOrchestrator.specs) {
      expect(spec.env['MOTIR_INDEX_TARBALL_URL']).toBe(TARBALL_URL);
    }
  }, 30_000);

  it('fails the run and claims nothing when a refresh container dies', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgj-refresh-x', 1);
    stubIndexFleet();
    containerExitsWith(30);

    const engine = new InngestTestEngine({ function: codeGraphRefresh });
    const { result, error } = (await engine.execute({
      events: [refreshEventFor({ installationId, workspaceId })],
      steps: sleepSteps(projectIds),
    })) as { result?: unknown; error?: { message?: string } };

    expect(result).toBeUndefined();
    expect(error?.message).toContain('graph_unbuildable');
    expect(error?.message).toContain(REPO_REF);
    // A stale graph must never read as fresh: no `succeeded` row, no output, and
    // the failure is what the DLQ and MOTIR-2105's staleness signal see.
    const runs = await refreshJobRuns();
    expect(runs.filter((run) => run.status === 'succeeded')).toEqual([]);
    expect(runs.every((run) => run.output === null)).toBe(true);
    // Teardown still happened — a failed refresh is not a billed leak.
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(fakeOrchestrator.teardowns).toHaveLength(1);
  }, 30_000);

  it('keeps the per-repo DEBOUNCE, and carries no concurrency number', () => {
    // Read off the SHIPPED function object — the config Inngest was actually
    // constructed with. A debounce is executor-side (Inngest holds the run), so
    // coalescing itself cannot be driven in-process; what a test CAN pin is that
    // the config survived the move, which is exactly what a path swap risks
    // dropping.
    const config = (codeGraphRefresh as unknown as { opts: Record<string, unknown> }).opts as {
      id?: string;
      retries?: number;
      concurrency?: { limit: number };
      debounce?: { key: string; period: string; timeout?: string };
    };

    expect(config.id).toBe('system.code-graph-refresh');
    // A push storm still coalesces: same key (installation + repo), same 2m
    // window, same 15m cap on the total deferral.
    expect(config.debounce).toEqual({
      key: "event.data.installationId + '/' + event.data.repoOwner + '/' + event.data.repoName",
      period: '2m',
      timeout: '15m',
    });
    // `concurrency: 2` is GONE (MOTIR-2057), for MOTIR-1990's three reasons — a
    // stepped supervisor holds its slot for the container's whole life, an
    // unkeyed limit IS the starvation this job suffered, and its scale-to-zero
    // premise moved to the containers. The cap lives in admission control now.
    expect(config.concurrency).toBeUndefined();
    expect(config.retries).toBe(4);
  });

  it('leaves the first index UNCHANGED — same step sequence, and no debounce on it', async () => {
    // The healthy path is not collateral: refresh adopting this shape must not
    // reshape it. Driving both jobs over ONE seeded world and comparing the step
    // sequences is the direct form of "they share one path, and it is the index
    // job's own" — a copied-and-edited shape fails here even when both are green
    // in isolation.
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgj-parity', 2);
    stubIndexFleet();
    containerExitsWith(0);

    const indexRun = await new InngestTestEngine({ function: codeGraphIndex }).execute({
      events: [indexEventFor({ installationId, workspaceId, eventId: 'evt-parity-index' })],
      steps: sleepSteps(projectIds),
    });
    const refreshRun = await new InngestTestEngine({ function: codeGraphRefresh }).execute({
      events: [refreshEventFor({ installationId, workspaceId, eventId: 'evt-parity-refresh' })],
      steps: sleepSteps(projectIds),
    });

    expect(indexRun.result).toEqual({ indexed: true, repoRef: REPO_REF, projectsIndexed: 2 });
    expect(refreshRun.result).toEqual(indexRun.result);
    const shapeOf = (ctx: Parameters<typeof stepIds>[0]) =>
      stepIds(ctx).filter((id) => !id.startsWith('job-run:'));
    expect(shapeOf(refreshRun.ctx)).toEqual(shapeOf(indexRun.ctx));

    // And the difference between them stays exactly one thing: the first index
    // must run PROMPTLY on install, so it must never grow a debounce window.
    const indexConfig = (codeGraphIndex as unknown as { opts: Record<string, unknown> }).opts;
    expect(indexConfig['debounce']).toBeUndefined();
  }, 30_000);
});
