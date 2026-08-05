import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import * as motirAiClient from '@/lib/ai/motirAiClient';
import { CODE_GRAPH_RETENTION_WINDOW_MS, OFFBOARD_ALL_REPOS } from '@/lib/codeGraph/offboarding';
import { codeGraphOffboardSweep } from '@/lib/jobs/definitions/codeGraphOffboardSweep';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { truncateAuthTables, truncateCodeGraphOffboarding, truncateJobRuns } from '../helpers/db';

// ── THE STORY SEAM (MOTIR-2193, for Story MOTIR-2192) ────────────────────────
//
// Each card in this story ships its own coverage, and all three can be green
// while the composition is broken:
//
//   MOTIR-2166 proves a row is ENQUEUED.
//   MOTIR-2168 proves a due row is DRAINED.
//   MOTIR-2165 proves the removal happens IN ORDER — in the other repo.
//
// What none of them owns is the claim the STORY makes: *a lifecycle trigger
// eventually causes a scoped removal call, exactly once, in the right order, and
// not before it is due.* A scope written in one shape and read in another, a
// `dueAt` in the wrong direction, a per-repo disconnect that enqueues the whole
// project — every one of those passes all three suites.
//
// **Real Postgres, real services, real job. motir-ai is stubbed at exactly ONE
// point: `motirAiClient`.** That is the seam this repo owns, and it is also the
// boundary the card forbids reaching past — asserting motir-ai's three deletions
// from here would be asserting the stub.

const PASSWORD = 'hunter2hunter2';

/** The client's success shape. */
function removedResponse(): motirAiClient.CodeGraphOffboardResult {
  return {
    projectFound: true,
    repos: [],
    snapshotObjectsDeleted: 0,
    localRootsRemoved: 0,
    coordinationRowsDeleted: 0,
  };
}

/** The ONE stub: motir-ai at the client boundary. Typed off the spy itself so the
 *  annotation cannot drift from the method's real signature. */
function spyOnOffboard() {
  return vi.spyOn(motirAiClient, 'offboardCodeGraph');
}
let offboard: ReturnType<typeof spyOnOffboard>;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateCodeGraphOffboarding();
  await truncateJobRuns();
  offboard = spyOnOffboard().mockResolvedValue(removedResponse());
});

afterEach(() => vi.restoreAllMocks());
afterAll(() => db.$disconnect());

async function makeWorkspace(email = 'owner@example.com', name = 'Acme') {
  const owner = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId: owner.id });
  return { owner, workspace };
}

async function queueRows() {
  return withSystemContext((tx) =>
    tx.codeGraphOffboarding.findMany({ orderBy: [{ coreProjectId: 'asc' }, { repoRef: 'asc' }] }),
  );
}

/** Drive the sweep through its REAL job handler — never the service or repository. */
async function runSweepJob() {
  const engine = new InngestTestEngine({ function: codeGraphOffboardSweep });
  const { result } = await engine.execute();
  return result as { due: number; offboarded: number; failed: number; remaining: number };
}

/** Move a row's `dueAt` into the past — the seam a test can reach, per the story's recipe step 4. */
async function makeDue(id: string) {
  await withSystemContext((tx) =>
    tx.codeGraphOffboarding.update({
      where: { id },
      data: { dueAt: new Date(Date.now() - 60_000) },
    }),
  );
}

const githubInstallation = {
  installationId: 'inst-1',
  accountLogin: 'acme',
  accountType: 'Organization',
};
const ghRepo = (name: string, id: string) => ({
  providerRepoId: id,
  owner: 'acme',
  name,
  defaultBranch: 'main',
  archived: false,
});

/** A GitLab connection with two connected projects, written directly (the OAuth exchange is not under test). */
async function seedGitlab(workspaceId: string) {
  const conn = await withSystemContext((tx) =>
    tx.githubInstallation.create({
      data: {
        installationId: `gitlab-ws-${workspaceId}`,
        workspaceId,
        accountLogin: 'acme',
        accountType: 'User',
        provider: 'gitlab',
      },
    }),
  );
  for (const [repoId, name] of [
    ['g1', 'api'],
    ['g2', 'web'],
  ] as const) {
    await withSystemContext((tx) =>
      tx.githubRepo.create({
        data: {
          installationId: conn.id,
          workspaceId,
          repoId,
          owner: 'acme',
          name,
          defaultBranch: 'main',
          provider: 'gitlab',
        },
      }),
    );
  }
  return conn;
}

// ── 1. trigger → queue, through the REAL services ────────────────────────────

describe('each lifecycle trigger writes the scope §14.3 gives it', () => {
  it('PROJECT ARCHIVE — whole project, windowed', async () => {
    const { owner, workspace } = await makeWorkspace();
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Core',
    });

    const before = Date.now();
    await projectsService.archiveProject({
      projectId: project.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      coreWorkspaceId: workspace.id,
      coreProjectId: project.id,
      repoRef: OFFBOARD_ALL_REPOS,
      reason: 'project_archived',
    });
    expect(rows[0]!.dueAt.getTime()).toBeGreaterThanOrEqual(
      before + CODE_GRAPH_RETENTION_WINDOW_MS,
    );
  });

  it('A PER-REPO DISCONNECT does NOT enqueue the whole project', async () => {
    // The composition bug this case exists for: a trigger that widens its own
    // scope removes graphs the user never asked to remove, and every per-card
    // suite still passes because each half is individually correct.
    const { owner, workspace } = await makeWorkspace();
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Core',
    });
    await seedGitlab(workspace.id);

    await gitlabConnectionService.disconnectProject(
      { userId: owner.id, workspaceId: workspace.id },
      'g1',
    );

    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      coreWorkspaceId: workspace.id,
      coreProjectId: project.id,
      repoRef: 'acme/api',
      reason: 'repo_disconnected',
    });
    expect(rows.map((r) => r.repoRef)).not.toContain(OFFBOARD_ALL_REPOS);
  });

  it('A CONNECTION DISCONNECT enqueues every repo on it, still windowed', async () => {
    const { owner, workspace } = await makeWorkspace();
    await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Core',
    });
    await seedGitlab(workspace.id);

    const before = Date.now();
    await gitlabConnectionService.disconnect({ userId: owner.id, workspaceId: workspace.id });

    const rows = await queueRows();
    expect(rows.map((r) => r.repoRef).sort()).toEqual(['acme/api', 'acme/web']);
    for (const row of rows) {
      expect(row.reason).toBe('connection_disconnected');
      expect(row.dueAt.getTime()).toBeGreaterThanOrEqual(before + CODE_GRAPH_RETENTION_WINDOW_MS);
    }
  });

  it('A GITHUB PRUNE enqueues the de-selected repo, per project', async () => {
    const { owner, workspace } = await makeWorkspace();
    const p1 = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Core',
    });
    const p2 = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Web',
    });

    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: githubInstallation,
      repos: [ghRepo('api', 'r1'), ghRepo('web', 'r2')],
    });
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: githubInstallation,
      repos: [ghRepo('api', 'r1')],
    });

    const rows = await queueRows();
    expect(rows.map((r) => [r.coreProjectId, r.repoRef]).sort()).toEqual(
      [
        [p1.id, 'acme/web'],
        [p2.id, 'acme/web'],
      ].sort(),
    );
  });

  it('A WORKSPACE DELETE is IMMEDIATE — no window', async () => {
    const { owner, workspace } = await makeWorkspace();
    await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Core',
    });

    const before = Date.now();
    await workspacesService.deleteWorkspace({
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });
    const after = Date.now();

    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('workspace_deleted');
    expect(rows[0]!.dueAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(rows[0]!.dueAt.getTime()).toBeLessThanOrEqual(after);
  });
});

// ── 2. ⚠️ the ordering property, through the REAL deleteWorkspace path ───────

describe('the queue row survives the real workspace cascade (§14.5)', () => {
  it('is written AND still present after deleteWorkspace returns', async () => {
    // MOTIR-2166 asserts the row survives a cascade. This asserts it survives THE
    // REAL CALL PATH, which is where the ordering bug would actually live: the
    // enumeration has to precede the delete, and only driving the shipped service
    // proves that it does. Get it wrong and the projects are gone before anything
    // can name them — permanently unreachable orphans, which is the end state §14
    // exists to prevent, produced by the code meant to prevent it.
    const { owner, workspace } = await makeWorkspace();
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Core',
    });

    await workspacesService.deleteWorkspace({
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
    expect(await db.project.findUnique({ where: { id: project.id } })).toBeNull();

    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      coreWorkspaceId: workspace.id,
      coreProjectId: project.id,
    });

    // …and it is still drainable, which is the point of surviving at all.
    await runSweepJob();
    expect(offboard).toHaveBeenCalledWith({
      coreWorkspaceId: workspace.id,
      coreProjectId: project.id,
    });
    expect(await queueRows()).toEqual([]);
  });
});

// ── 3. queue → sweep → client, end to end ────────────────────────────────────

describe('a trigger eventually causes exactly one scoped removal call', () => {
  it('drains through the REAL job with the scope the trigger wrote', async () => {
    const { owner, workspace } = await makeWorkspace();
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Core',
    });
    await seedGitlab(workspace.id);
    await gitlabConnectionService.disconnectProject(
      { userId: owner.id, workspaceId: workspace.id },
      'g1',
    );

    const [row] = await queueRows();
    await makeDue(row!.id);

    const result = await runSweepJob();

    expect(result).toMatchObject({ due: 1, offboarded: 1, failed: 0, remaining: 0 });
    expect(offboard).toHaveBeenCalledTimes(1);
    expect(offboard).toHaveBeenCalledWith({
      coreWorkspaceId: workspace.id,
      coreProjectId: project.id,
      repoRef: 'acme/api',
    });
    expect(await queueRows()).toEqual([]);
  });

  it('the scope round-trips as a SHAPE the consumer accepts, not a string', async () => {
    // The integration-seam lesson: read the writer's output back through the
    // CONSUMER's shape. A DTO-key drift here — `workspaceId` for
    // `coreWorkspaceId`, `repo` for `repoRef` — is invisible to both repos' own
    // suites, because each is internally consistent.
    const { owner, workspace } = await makeWorkspace();
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Core',
    });
    await projectsService.archiveProject({
      projectId: project.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });
    const [row] = await queueRows();
    await makeDue(row!.id);

    await runSweepJob();

    const [arg] = offboard.mock.calls[0]!;
    // Exactly the keys motir-ai's `POST /v1/code-graph/offboard` reads — and no
    // others, so an extra field cannot quietly become load-bearing on one side.
    expect(Object.keys(arg).sort()).toEqual(['coreProjectId', 'coreWorkspaceId']);
    expect(arg.coreWorkspaceId).toBe(workspace.id);
    expect(arg.coreProjectId).toBe(project.id);
    // ⚠️ The project-wide sentinel is translated to an ABSENT `repoRef`. Sending
    // `'*'` would scope the removal to a repo literally named `*`: nothing
    // deleted, and the row retired saying otherwise.
    expect(arg).not.toHaveProperty('repoRef');
    expect(row!.repoRef).toBe(OFFBOARD_ALL_REPOS);
  });

  it('a NOT-YET-DUE row is untouched — the window is real, not decorative', async () => {
    const { owner, workspace } = await makeWorkspace();
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Core',
    });
    await projectsService.archiveProject({
      projectId: project.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    const result = await runSweepJob();

    expect(result).toMatchObject({ due: 0, offboarded: 0 });
    expect(offboard).not.toHaveBeenCalled();
    expect(await queueRows()).toHaveLength(1);
  });
});

// ── 4. cancel wins ───────────────────────────────────────────────────────────

describe('re-onboarding inside the window cancels the removal', () => {
  it('a re-connect suppresses the call entirely', async () => {
    // The grace period, composed: this is the difference between a window and a
    // delay, and between a misclick and a metered re-index the user pays for.
    const { owner, workspace } = await makeWorkspace();
    await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Core',
    });

    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: githubInstallation,
      repos: [ghRepo('api', 'r1'), ghRepo('web', 'r2')],
    });
    // De-select `acme/web`…
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: githubInstallation,
      repos: [ghRepo('api', 'r1')],
    });
    const [row] = await queueRows();
    expect(row).toBeDefined();

    // …and change their mind, well inside the window.
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: githubInstallation,
      repos: [ghRepo('api', 'r1'), ghRepo('web', 'r2')],
    });

    expect(await queueRows()).toEqual([]);
    const result = await runSweepJob();
    expect(result).toMatchObject({ due: 0 });
    expect(offboard).not.toHaveBeenCalled();
  });
});

// ── 5. the failure path — the queue IS the retry ─────────────────────────────

describe('a failing motir-ai leaves the work due', () => {
  it('the row survives, stays due, and the NEXT sweep retries it', async () => {
    const { owner, workspace } = await makeWorkspace();
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Core',
    });
    await projectsService.archiveProject({
      projectId: project.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });
    const [row] = await queueRows();
    await makeDue(row!.id);

    offboard.mockRejectedValueOnce(new Error('motir-ai is unavailable'));
    const first = await runSweepJob();

    expect(first).toMatchObject({ due: 1, offboarded: 0, failed: 1, remaining: 1 });
    const survived = await queueRows();
    expect(survived).toHaveLength(1);
    expect(survived[0]!.id).toBe(row!.id);
    // STILL DUE — no backoff was written onto the row, because the queue is the
    // whole retry design. A `dueAt` pushed into the future here would be a second,
    // invisible retry policy disagreeing with the first.
    expect(survived[0]!.dueAt.getTime()).toBeLessThanOrEqual(Date.now());

    const second = await runSweepJob();
    expect(second).toMatchObject({ offboarded: 1, failed: 0 });
    expect(await queueRows()).toEqual([]);
    expect(offboard).toHaveBeenCalledTimes(2);
  });
});
