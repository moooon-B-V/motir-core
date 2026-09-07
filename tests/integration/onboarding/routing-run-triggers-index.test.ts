import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import { randomToken } from '../../helpers/random';

// THE INDEX IS TRIGGERED, AND ITS STATE REACHES THE PLANNER
// (Story MOTIR-4753 · MOTIR-4826), against a REAL Postgres.
//
// A repository can be CONNECTED and have no code graph — an index that did not
// finish, one still running, or somebody who connected their repository and
// opened the plan window a minute later. The routing verdict is then about to be
// told there is nothing to read; telling it and doing nothing would leave that
// person waiting for a graph nobody asked for.
//
// ⚠️ WHAT THIS SUITE ASSERTS, AND THE ONE THING IT ASSERTS THE ABSENCE OF.
// `motir-core` supplies a FACT and repairs a CAUSE. It must not read `indexed`
// back to choose a destination — that is the planner's (MOTIR-4828), and a
// branch here would put the routing decision back where five of this story's
// cards took it out of. The last describe is that absence, read off the source.

const sweep = vi.fn(async (..._a: unknown[]) => ({
  dryRun: false,
  scanned: 0,
  alreadyIndexed: 0,
  missing: [],
  enqueued: 0,
}));
vi.mock('@/lib/services/codeGraphIndexService', () => ({
  codeGraphIndexService: { sweepReposMissingFirstIndex: (...a: unknown[]) => sweep(...a) },
}));

const submitJob = vi.fn(async (..._a: unknown[]) => ({ jobId: 'job-routing-1' }));
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: (...a: unknown[]) => submitJob(...a),
}));

const { aiGenerationService } = await import('@/lib/services/aiGenerationService');
const { resolveCodeContext } = await import('@/lib/ai/codeContext');
const { projectsService } = await import('@/lib/services/projectsService');
const { toProjectDTO } = await import('@/lib/mappers/projectMappers');
import type { ProjectContext } from '@/lib/projects';

/**
 * A connected GitHub repo, so `resolveCodeContext` resolves it.
 *
 * ⚠️ ONE INSTALLATION PER WORKSPACE, REUSED. `resolveCodeContext` reads
 * `findByWorkspaceId` and then lists that ONE installation's repos, so seeding a
 * second installation would hide the second repository rather than add it — the
 * mixed-set case would have passed for the wrong reason.
 */
async function seedConnectedRepo(fx: WorkItemFixture, owner = 'acme', name = 'widgets') {
  const rand = randomToken(6);
  const inst =
    (await adminDb.githubInstallation.findFirst({ where: { workspaceId: fx.workspaceId } })) ??
    (await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-${rand}`,
        workspaceId: fx.workspaceId,
        accountLogin: owner,
        accountType: 'Organization',
      },
    }));
  await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: `repo-${rand}`,
      owner,
      name,
      defaultBranch: 'main',
      archived: false,
    },
  });
  return `${owner}/${name}`;
}

/** A SUCCEEDED `system.code-graph-index` run — what "has a graph" MEANS here. */
async function seedSucceededIndexJob(fx: WorkItemFixture, repoRef: string) {
  await adminDb.jobRun.create({
    data: {
      workspaceId: fx.workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-${randomToken()}`,
      lane: 'engine',
      attempt: 0,
      status: 'succeeded',
      finishedAt: new Date(),
      output: { indexed: true, repoRef, projectsIndexed: 1 },
    },
  });
}

async function projectCtx(fx: WorkItemFixture): Promise<ProjectContext> {
  const project = await projectsService.assertProjectInWorkspace(fx.projectId, fx.workspaceId);
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: toProjectDTO(project),
  };
}

const runRouting = async (fx: WorkItemFixture) =>
  aiGenerationService.startRoutingRun(await projectCtx(fx));

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateJobRuns();
  await truncateAuthTables();
});

describe('the FACT reaches the planner, per repository', () => {
  it('an UNINDEXED repository rides the wire as `indexed: false`', async () => {
    const fx = await makeWorkItemFixture();
    const ref = await seedConnectedRepo(fx);
    const code = await resolveCodeContext({ userId: fx.ownerId, workspaceId: fx.workspaceId });
    expect(code?.repos).toEqual([
      { provider: 'github', repoRef: ref, defaultBranch: 'main', indexed: false },
    ]);
  });

  it('and an INDEXED one as `indexed: true` — the same ledger the substrate read uses', async () => {
    const fx = await makeWorkItemFixture();
    const ref = await seedConnectedRepo(fx);
    await seedSucceededIndexJob(fx, ref);
    const code = await resolveCodeContext({ userId: fx.ownerId, workspaceId: fx.workspaceId });
    expect(code?.repos[0]!.indexed).toBe(true);
  });

  it('per REPOSITORY, not per workspace — a mixed set is reported mixed', async () => {
    const fx = await makeWorkItemFixture();
    await seedConnectedRepo(fx, 'acme', 'widgets');
    const apiRef = await seedConnectedRepo(fx, 'acme', 'api');
    await seedSucceededIndexJob(fx, apiRef);
    const code = await resolveCodeContext({ userId: fx.ownerId, workspaceId: fx.workspaceId });
    const byRef = Object.fromEntries(code!.repos.map((r) => [r.repoRef, r.indexed]));
    expect(byRef['acme/widgets']).toBe(false);
    expect(byRef['acme/api']).toBe(true);
  });

  it('the routing dispatch SENDS it, in the shape motir-ai parses', async () => {
    const fx = await makeWorkItemFixture();
    const ref = await seedConnectedRepo(fx);
    await runRouting(fx);
    const context = submitJob.mock.calls[0]![2] as {
      code?: { repos: { repoRef: string; indexed: boolean }[] };
    };
    const repos = context.code?.repos;
    expect(repos).toEqual([expect.objectContaining({ repoRef: ref, indexed: false })]);
  });
});

describe('the CAUSE is repaired — the index is enqueued', () => {
  it('a connected, UNINDEXED repository triggers the first-index sweep', async () => {
    const fx = await makeWorkItemFixture();
    await seedConnectedRepo(fx);
    await runRouting(fx);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledWith({ workspaceId: fx.workspaceId });
  });

  it('an ALREADY-INDEXED repository enqueues nothing', async () => {
    const fx = await makeWorkItemFixture();
    const ref = await seedConnectedRepo(fx);
    await seedSucceededIndexJob(fx, ref);
    await runRouting(fx);
    expect(sweep).not.toHaveBeenCalled();
  });

  it('a project with NO repository enqueues nothing', async () => {
    const fx = await makeWorkItemFixture();
    await runRouting(fx);
    expect(sweep).not.toHaveBeenCalled();
  });

  it('an index ALREADY IN FLIGHT adds nothing extra — the shipped idempotency, not a second guard', async () => {
    // A running (not succeeded) index leaves the repository reading `indexed:
    // false`, so the sweep IS called — and the sweep itself is what refuses to
    // enqueue twice, by reading the ledger. Asserting a second guard here would
    // duplicate a decision that already has one home.
    const fx = await makeWorkItemFixture();
    const ref = await seedConnectedRepo(fx);
    await adminDb.jobRun.create({
      data: {
        workspaceId: fx.workspaceId,
        functionId: 'system.code-graph-index',
        eventName: 'system.code-graph-index',
        eventId: `evt-${randomToken()}`,
        lane: 'engine',
        attempt: 0,
        status: 'running',
        output: { repoRef: ref },
      },
    });
    await runRouting(fx);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('a sweep that THROWS does not fail the routing run', async () => {
    // It repairs a cause; it is not what the caller asked for. The verdict is
    // still worth having, and the person still needs an answer.
    const fx = await makeWorkItemFixture();
    await seedConnectedRepo(fx);
    sweep.mockRejectedValueOnce(new Error('inngest is down'));
    await expect(runRouting(fx)).resolves.toEqual({ jobId: 'job-routing-1' });
    expect(submitJob).toHaveBeenCalledTimes(1);
  });
});

describe('⚠️ motir-core has NO OPINION about the route', () => {
  const source = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('no read of `indexed` chooses a DESTINATION — the two that exist choose other things', () => {
    // ⚠️ AMENDED 2026-09-07 (MOTIR-4829), AND THE AMENDMENT NARROWS IT TO WHAT IT
    // MEANT. The first version of this guard counted `.indexed` reads and allowed
    // exactly one — the enqueue trigger. That was right when the only consumer
    // was the dispatch, and it went wrong the moment the WINDOW had to render the
    // wait: naming which repositories are still being indexed is a read that
    // decides what is DISPLAYED, and forbidding it would have been forbidding the
    // surface from telling somebody which repository they are waiting on.
    //
    // The claim was never about the COUNT. It is that no read of this fact
    // decides WHERE A PERSON GOES — that is the planner's (MOTIR-4828), and a
    // branch here would put the routing decision back where five of this story's
    // cards took it out of. So each site is named with what it decides, and the
    // destination-choosing shapes are asserted absent.
    const ALLOWED: Record<string, string> = {
      'lib/services/aiGenerationService.ts':
        'the ENQUEUE trigger — repairs a cause, chooses nothing',
      'components/planning/PlanningWorkspaceOverlay.tsx':
        'NAMES the repositories still being indexed, for the banner to say',
    };
    for (const path of [
      'lib/services/aiGenerationService.ts',
      'lib/planning/onboardingRoutingClient.ts',
      'lib/dto/onboardingRouting.ts',
      'components/planning/PlanningWorkspaceOverlay.tsx',
    ]) {
      const code = source(path)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/[^\n]*$/gm, '');
      const reads = [...code.matchAll(/\.indexed\b/g)].length;
      if (!(path in ALLOWED)) {
        expect(reads, `${path} reads .indexed ${reads} time(s) and is not on the named list`).toBe(
          0,
        );
        continue;
      }
      // ⚠️ THE SHAPE, NOT THE COUNT. Wherever `indexed` is read, it may not sit
      // in the same expression as a navigation or an outcome — the two ways a
      // destination gets chosen in this tree.
      for (const line of code.split('\n')) {
        if (!line.includes('.indexed')) continue;
        expect(line, `${path}: ${ALLOWED[path]}`).not.toMatch(
          /router\.push|handoffDestination|outcome\s*[=:]|ONBOARDING_ROUTING/,
        );
      }
    }
  });

  it('and no routing OUTCOME is named in motir-core’s dispatch path', () => {
    const code = source('lib/services/aiGenerationService.ts');
    expect(code).not.toContain('wait_for_index');
    expect(code).not.toContain('onboard_new_project');
    expect(code).not.toContain('onboard_existing_project');
  });
});
