import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectRepoProvisioningService } from '@/lib/services/projectRepoProvisioningService';
import { projectRepoTakeoverService } from '@/lib/services/projectRepoTakeoverService';
import { projectsService } from '@/lib/services/projectsService';
import {
  projectRunnerGroupService,
  RunnerGroupNotProvisionedError,
} from '@/lib/services/projectRunnerGroupService';
import { runnerGroupClient, runnerGroupNameFor } from '@/lib/github/runnerGroups';
import {
  _resetProvisioningInstallationCache,
  _setReadinessPollForTests,
} from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';
import { createRunnerGroupFake, type RunnerGroupFake } from '../helpers/runnerGroupFake';
import {
  createActionsVariableFake,
  type ActionsVariableFake,
} from '../helpers/actionsVariableFake';

// The PER-PROJECT RUNNER GROUP over real Postgres (Story MOTIR-1916 · MOTIR-1972
// · `docs/decisions/ci-runner-fleet.md` §7.3).
//
// The card's own framing is the test plan, and the framing is that this is
// CORRECTNESS, not tidiness: `runs-on` resolves to a static label, so an
// org-wide group would let a runner Motir booted for project X be picked up by
// project Y's queued job — including one MOTIR-1922's admission gate DECLINED.
// So what is pinned here is the set of properties that make the label
// unambiguous, each by RUNNING the situation rather than reasoning about it:
//
//   1. Establishing a set creates EXACTLY ONE group, `visibility: selected`,
//      `allows_public_repositories: false`, with its id + name persisted.
//   2. The access list holds EVERY established repo of a MULTI-repo project —
//      the degenerate one-repo case would have hidden the whole read-derived bug.
//   3. A repo established LATER joins the existing group; a removed one leaves;
//      a re-run makes no second group.
//   4. A project with NO group id REFUSES to provision — never `Default` (id 1).
//   5. Two rows syncing CONCURRENTLY both survive, under a real interleave.
//      (Delete the row lock in `projectRunnerGroupService` and this one fails —
//      the mutation-check the card asks for.)
//   6. A GitHub-side failure leaves the repo established and the group unsynced.
//   7. Deletion runs at handoff and at project deletion, and is idempotent.
//   8. Every call carries the PROVISIONING App's installation token.
//
// Real Postgres; the ONLY fake is `fetch` (the GitHub HTTP boundary — the shipped
// convention for these suites).

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '556677';
const PROVISIONING_TOKEN = 'ghs_provisioning';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  authorization: string;
}

let calls: Call[];
let existingRepos: Map<string, number>;
let refusals: Map<string, number>;
let nextRepoId: number;
let runnerGroups: RunnerGroupFake;
let actionsVariables: ActionsVariableFake;
/** Awaited inside the access-list PUT — the concurrency seam (test 5). */
let beforeRepositoriesPut: ((groupId: number, ids: number[]) => Promise<void>) | null;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installGitHub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: u, method, body, authorization: headers['authorization'] ?? '' });

      if (u.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
        return json(200, { id: Number(INSTALLATION_ID) });
      }
      if (u.includes('/access_tokens')) {
        return json(200, {
          token: PROVISIONING_TOKEN,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      const group = await runnerGroups.handle(u, method, body);
      if (group) return group;

      // The org's FLEET RUNNER VARIABLE (MOTIR-2015) — establishing a repository
      // now ensures `MOTIR_RUNNER`, so this suite's GitHub has to know about those
      // endpoints too. The service swallows its own failures by contract, so an
      // unfaked call here would be INVISIBLE rather than loud: green, silent, and
      // no longer describing what the product does.
      const variable = actionsVariables.handle(u, method, body);
      if (variable) return variable;

      if (
        method === 'POST' &&
        (u.includes('/generate') || u.endsWith(`/orgs/${MOTIR_ORG}/repos`))
      ) {
        const name = String(body?.['name']);
        const refusal = refusals.get(name);
        if (refusal) return json(refusal, { message: 'refused' });
        const id = nextRepoId++;
        existingRepos.set(name, id);
        return json(201, { id, name, owner: { login: MOTIR_ORG } });
      }
      if (method === 'POST' && /\/repos\/[^/]+\/[^/]+\/transfer$/.test(u)) {
        return json(202, { id: 1, name: 'transferred' });
      }
      if (method === 'PUT' && u.includes('/actions/permissions')) return json(204, {});
      if (method === 'GET' && u.includes('/actions/permissions')) {
        return json(200, { enabled: true });
      }
      if (method === 'GET' && u.includes(`/repos/${MOTIR_ORG}/`)) {
        const name = u.split('/').pop()!;
        const id = existingRepos.get(name);
        if (!id) return json(404, { message: 'Not Found' });
        return json(200, { id, name, owner: { login: MOTIR_ORG }, default_branch: 'main' });
      }
      if (method === 'PUT') return json(201, { content: {} });
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }),
  );
}

async function addRow(fx: WorkItemFixture, role: 'web' | 'api', name: string): Promise<string> {
  const row = await projectRepoSetService.addRow(fx.projectId, { role, name }, fx.ctx);
  return row.id;
}

async function readProject(projectId: string) {
  return db.project.findUniqueOrThrow({ where: { id: projectId } });
}

/** The GitHub repo id the fake minted for a name — what must be in the list. */
function repoId(name: string): number {
  const id = existingRepos.get(name);
  if (id === undefined) throw new Error(`no repo named ${name} was created`);
  return id;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  await truncateAuthTables();
  calls = [];
  existingRepos = new Map();
  refusals = new Map();
  nextRepoId = 910_001;
  beforeRepositoriesPut = null;
  actionsVariables = createActionsVariableFake(MOTIR_ORG);
  runnerGroups = createRunnerGroupFake(MOTIR_ORG, {
    beforeRepositoriesPut: (groupId, ids) => beforeRepositoriesPut?.(groupId, ids),
  });
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  _setReadinessPollForTests({ attempts: 2, delayMs: 0 });
  installGitHub();
  vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _setReadinessPollForTests(null);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('establishing a set provisions the project its OWN group', () => {
  it('creates exactly one group, selected + not public-fork-visible, and persists it', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // EXACTLY ONE — the establish run ensures the group up front and every row
    // re-syncs it, so the adopt path is exercised on the very first project.
    const group = runnerGroups.onlyGroup();
    expect(group).toMatchObject({
      name: runnerGroupNameFor(fx.projectId),
      visibility: 'selected',
      // §7 treats the container as hostile: a fork's PR must never reach a
      // self-hosted runner.
      allowsPublicRepositories: false,
      restrictedToWorkflows: false,
    });
    expect(group.repositoryIds).toEqual([repoId('acme-web')]);

    const project = await readProject(fx.projectId);
    expect(project).toMatchObject({
      runnerGroupId: group.id,
      runnerGroupName: runnerGroupNameFor(fx.projectId),
      runnerGroupSyncPending: false,
    });
    expect(project.runnerGroupSyncedAt).toBeInstanceOf(Date);
  });

  it('creates the group BEFORE the first repository exists — the queued-job race', async () => {
    // Creating a repository makes a surface CI can fire on immediately: an
    // initialised row gets a CI-stub commit, which is a push, which queues a
    // job. A group that landed AFTER that would leave the first job's
    // provisioning with no `runner_group_id` and forced to refuse — a visible
    // failure on a brand-new project. So the ORDER is the guarantee, and it is
    // asserted rather than assumed.
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    const groupCreate = calls.findIndex(
      (c) => c.method === 'POST' && c.url.endsWith('/actions/runner-groups'),
    );
    const repoCreate = calls.findIndex(
      (c) =>
        c.method === 'POST' &&
        (c.url.includes('/generate') || c.url.endsWith(`/orgs/${MOTIR_ORG}/repos`)),
    );
    expect(groupCreate).toBeGreaterThanOrEqual(0);
    expect(repoCreate).toBeGreaterThanOrEqual(0);
    expect(groupCreate).toBeLessThan(repoCreate);
    // …and it is created EMPTY, which is the safe direction: it grants nothing
    // until the repository it is for actually exists.
    const createBody = runnerGroups.calls.find((c) => c.method === 'POST')!.body;
    expect(createBody).toMatchObject({ selected_repository_ids: [] });
  });

  it('access-lists the project’s WHOLE repo SET, not just one repository', async () => {
    // The degenerate one-row case would pass with an access list that only ever
    // holds the row being settled — this is the case that would not.
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');
    await addRow(fx, 'api', 'acme-api');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(runnerGroups.onlyGroup().repositoryIds.sort()).toEqual(
      [repoId('acme-web'), repoId('acme-api')].sort(),
    );
  });

  it('adds a repo established LATER to the SAME group, and makes no second one', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');
    refusals.set('acme-api', 403);
    await addRow(fx, 'api', 'acme-api');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    const firstGroupId = runnerGroups.onlyGroup().id;
    expect(runnerGroups.onlyGroup().repositoryIds).toEqual([repoId('acme-web')]);

    // GitHub recovers and the failed row is retried — rows establish
    // independently and asynchronously (ADR §4.1), which is exactly why the sync
    // is per-row and re-entrant rather than a one-shot at create time.
    refusals.clear();
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(runnerGroups.groups.size).toBe(1);
    expect(runnerGroups.onlyGroup().id).toBe(firstGroupId);
    expect(runnerGroups.onlyGroup().repositoryIds.sort()).toEqual(
      [repoId('acme-web'), repoId('acme-api')].sort(),
    );
  });

  it('removes a repo from the access list when its row is removed', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');
    const apiRow = await addRow(fx, 'api', 'acme-api');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    await projectRepoSetService.removeRow(apiRow, fx.ctx);

    expect(runnerGroups.onlyGroup().repositoryIds).toEqual([repoId('acme-web')]);
  });

  it('never creates a second group when establishment is re-run', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(runnerGroups.groups.size).toBe(1);
    const creates = runnerGroups.calls.filter(
      (c) => c.method === 'POST' && c.url.endsWith('/runner-groups'),
    );
    expect(creates).toHaveLength(1);
  });

  it('RE-CREATES a group deleted out of band, and persists the new id', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    const original = runnerGroups.onlyGroup().id;

    // An operator tidies the org. The persisted id now 404s.
    runnerGroups.deleteOutOfBand(original);

    await projectRunnerGroupService.syncForProject({
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
    });

    const recreated = runnerGroups.onlyGroup();
    expect(recreated.id).not.toBe(original);
    expect(recreated.repositoryIds).toEqual([repoId('acme-web')]);
    expect(await readProject(fx.projectId)).toMatchObject({ runnerGroupId: recreated.id });
  });

  it('ADOPTS a group left behind by a crashed run rather than creating a second', async () => {
    // The crash this covers: GitHub made the group, the transaction that would
    // have persisted its id never committed. Without the by-name adopt, every
    // retry makes another group, each access-listing live repositories.
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    const orphanId = runnerGroups.onlyGroup().id;
    await db.project.update({
      where: { id: fx.projectId },
      data: { runnerGroupId: null, runnerGroupName: null },
    });

    await projectRunnerGroupService.syncForProject({
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
    });

    expect(runnerGroups.groups.size).toBe(1);
    expect(await readProject(fx.projectId)).toMatchObject({ runnerGroupId: orphanId });
  });

  it('mints every runner-group call with the PROVISIONING App installation token', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    const groupCalls = calls.filter((c) => c.url.includes('/actions/runner-groups'));
    expect(groupCalls.length).toBeGreaterThan(0);
    for (const call of groupCalls) {
      expect(call.authorization).toBe(`Bearer ${PROVISIONING_TOKEN}`);
    }
    // The token itself came from the App-JWT → installation-token exchange, not
    // from a PAT or a user token: the only credential minted in this flow is the
    // installation one, and it is minted against the resolved installation id.
    expect(
      calls.some((c) => c.url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)),
    ).toBe(true);
  });
});

describe('a project with NO group refuses to provision', () => {
  it('throws rather than falling back to the Default group', async () => {
    // THE failure this whole card exists to prevent: `Default` is id 1 with
    // `visibility: all`, so a lenient fallback would silently restore the
    // org-wide group §7.3 forbids.
    const fx = await makeWorkItemFixture();
    expect(await readProject(fx.projectId)).toMatchObject({ runnerGroupId: null });

    const target = { projectId: fx.projectId, workspaceId: fx.workspaceId };
    await expect(projectRunnerGroupService.requireRunnerGroupId(target)).rejects.toThrow(
      RunnerGroupNotProvisionedError,
    );
    await expect(projectRunnerGroupService.requireRunnerGroupId(target)).rejects.toMatchObject({
      code: 'RUNNER_GROUP_NOT_PROVISIONED',
    });
  });

  it('returns the project’s OWN id once it has one — never a shared one', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    const id = await projectRunnerGroupService.requireRunnerGroupId({
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
    });
    expect(id).toBe(runnerGroups.onlyGroup().id);
    expect(id).not.toBe(1);
  });

  it('two projects get two DIFFERENT groups', async () => {
    const alpha = await makeWorkItemFixture({ identifier: 'ALPHA' });
    const beta = await makeWorkItemFixture({ identifier: 'BETA' });
    await addRow(alpha, 'web', 'alpha-web');
    await addRow(beta, 'web', 'beta-web');

    await projectRepoProvisioningService.establishSet(alpha.projectId, alpha.ctx);
    await projectRepoProvisioningService.establishSet(beta.projectId, beta.ctx);

    const alphaId = (await readProject(alpha.projectId)).runnerGroupId;
    const betaId = (await readProject(beta.projectId)).runnerGroupId;
    expect(alphaId).not.toBeNull();
    expect(alphaId).not.toBe(betaId);
    // And neither group can serve the other's repository — the property the
    // whole card is for.
    expect(runnerGroups.groups.get(alphaId!)!.repositoryIds).toEqual([repoId('alpha-web')]);
    expect(runnerGroups.groups.get(betaId!)!.repositoryIds).toEqual([repoId('beta-web')]);
  });
});

describe('the access list is READ-DERIVED, so the sync holds the project row lock', () => {
  it('two CONCURRENT syncs leave BOTH repositories in the list', async () => {
    // ⚠️ THE MUTATION-CHECK TEST. Delete the `projectRepository.lockById` call
    // from `projectRunnerGroupService.syncForProject` and this test FAILS: the
    // first sync's PUT — computed from a set that held only `acme-web` — lands
    // AFTER the second sync's, erasing `acme-api` from a group whose repository
    // is established and looks fine. That is the lost update the lock prevents,
    // and it is invisible in a call log because both writes "succeed".
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');
    const apiRow = await addRow(fx, 'api', 'acme-api');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    const target = { projectId: fx.projectId, workspaceId: fx.workspaceId };

    // Put the api row back to `proposed` with its repository still mirrored, so
    // this test can settle it MID-SYNC. Done at the DB edge rather than through
    // the establish service on purpose: `establishSet` takes the project's own
    // row lock for its sync, so driving it while sync #1 deliberately holds that
    // lock would deadlock the ARRANGEMENT, not exercise the guard.
    const apiRepoId = repoId('acme-api');
    await db.projectRepo.update({
      where: { id: apiRow },
      data: { state: 'proposed', githubRepoId: null },
    });
    const apiMirrorId = (await db.githubRepo.findFirstOrThrow({ where: { name: 'acme-api' } })).id;
    await projectRunnerGroupService.syncForProject(target);
    expect(runnerGroups.onlyGroup().repositoryIds).toEqual([repoId('acme-web')]);

    // Sync #1 reads the set as it stands NOW (one repository) and is held open
    // at its access-list write.
    const firstPutIssued = deferred();
    const firstPutAllowed = deferred();
    let gated = false;
    beforeRepositoriesPut = async () => {
      if (gated) return;
      gated = true;
      firstPutIssued.resolve();
      await firstPutAllowed.promise;
    };
    const first = projectRunnerGroupService.syncForProject(target);
    await firstPutIssued.promise;

    // …and only THEN does the second repository become established. A sync
    // started now sees both. Without the row lock it races ahead and writes
    // both, and sync #1's stale array then overwrites it.
    await db.projectRepo.update({
      where: { id: apiRow },
      data: { state: 'created', githubRepoId: apiMirrorId },
    });
    const second = projectRunnerGroupService.syncForProject(target);

    // Give the second sync a real chance to reach GitHub. WITH the lock it
    // cannot — it is blocked on the project row — so this window elapses; that
    // is the bound, not a synchronisation mechanism. WITHOUT the lock it gets
    // there immediately and the assertion below fails, which is the point.
    await new Promise((resolve) => setTimeout(resolve, 300));
    firstPutAllowed.resolve();
    await Promise.all([first, second]);

    expect(runnerGroups.onlyGroup().repositoryIds.sort()).toEqual(
      [repoId('acme-web'), apiRepoId].sort(),
    );
  }, 20_000);
});

describe('a GitHub-side failure degrades instead of failing the establishment', () => {
  it('leaves the repository established and marks the group unsynced', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');
    // Every runner-group call this run makes is refused; the repository create
    // path is untouched.
    runnerGroups.failWith(500, 50);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // The request STILL SUCCEEDS and the repository is real — a created repo is
    // an artifact that cannot be rolled back (ADR §4.2), and the group is the
    // side effect, not the deliverable.
    expect(result.rows[0]).toMatchObject({ outcome: 'created' });
    expect(await db.githubRepo.count()).toBe(1);

    const project = await readProject(fx.projectId);
    expect(project).toMatchObject({ runnerGroupId: null, runnerGroupSyncPending: true });
    expect(runnerGroups.groups.size).toBe(0);
  });

  it('a LATER sync clears the pending flag and lands the whole set', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');
    runnerGroups.failWith(500, 50);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect(await readProject(fx.projectId)).toMatchObject({ runnerGroupSyncPending: true });

    runnerGroups.failWith(null);
    await projectRunnerGroupService.syncForProject({
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
    });

    expect(await readProject(fx.projectId)).toMatchObject({ runnerGroupSyncPending: false });
    expect(runnerGroups.onlyGroup().repositoryIds).toEqual([repoId('acme-web')]);
  });
});

describe('the group is deleted when the project no longer owns anything', () => {
  it('a HANDOFF that transfers the last repository takes the group with it', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    const groupId = runnerGroups.onlyGroup().id;

    // The `repository` `transferred` delivery: the repo now belongs to the user.
    await projectRepoTakeoverService.applyTransferred({
      providerRepoId: String(repoId('acme-web')),
      newOwner: 'someone-else',
      repoName: 'acme-web',
    });

    expect(runnerGroups.groups.has(groupId)).toBe(false);
    expect(await readProject(fx.projectId)).toMatchObject({
      runnerGroupId: null,
      runnerGroupName: null,
      runnerGroupSyncPending: false,
    });
  });

  it('a handoff of ONE of two repositories only removes that one', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');
    await addRow(fx, 'api', 'acme-api');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    const groupId = runnerGroups.onlyGroup().id;

    await projectRepoTakeoverService.applyTransferred({
      providerRepoId: String(repoId('acme-web')),
      newOwner: 'someone-else',
      repoName: 'acme-web',
    });

    // The group survives — the project still owns a repository in Motir's org —
    // and the transferred repo is gone from the access list, so a runner booted
    // for this project can no longer serve it.
    expect(runnerGroups.groups.has(groupId)).toBe(true);
    expect(runnerGroups.groups.get(groupId)!.repositoryIds).toEqual([repoId('acme-api')]);
  });

  it('project deletion deletes the group, and is idempotent against an already-deleted one', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    const groupId = runnerGroups.onlyGroup().id;

    // The group is already gone on GitHub's side — a 404 on DELETE is the
    // desired end state reached by someone else, not a failure.
    runnerGroups.deleteOutOfBand(groupId);

    await projectsService.archiveProject({
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
    });

    expect(await readProject(fx.projectId)).toMatchObject({
      runnerGroupId: null,
      runnerGroupName: null,
      runnerGroupSyncedAt: null,
    });
  });

  it('a delete GitHub refuses leaves the columns in place so a retry can find it', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    const groupId = runnerGroups.onlyGroup().id;
    runnerGroups.failWith(503);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await projectRunnerGroupService.deleteForProject({
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
    });

    expect(outcome).toMatchObject({ outcome: 'delete_failed', runnerGroupId: groupId });
    // Clearing the columns here would strand a LIVE group in Motir's org with
    // nothing pointing at it — strictly worse than a delete that can be retried.
    expect(await readProject(fx.projectId)).toMatchObject({ runnerGroupId: groupId });

    runnerGroups.failWith(null);
    await projectRunnerGroupService.deleteForProject({
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
    });
    expect(runnerGroups.groups.size).toBe(0);
  });
});

describe('the degraded and defensive edges', () => {
  it('reports unknown_project when the project is gone', async () => {
    const fx = await makeWorkItemFixture();
    const gone = { projectId: 'cnot-a-real-project', workspaceId: fx.workspaceId };

    await expect(projectRunnerGroupService.syncForProject(gone)).resolves.toEqual({
      outcome: 'unknown_project',
    });
    await expect(projectRunnerGroupService.deleteForProject(gone)).resolves.toEqual({
      outcome: 'unknown_project',
    });
  });

  it('reports no_group for a project that never had one', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      projectRunnerGroupService.deleteForProject({
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
      }),
    ).resolves.toEqual({ outcome: 'no_group' });
  });

  it('falls back to the deterministic name when GitHub echoes none', async () => {
    // The name is what the ADOPT path looks a crashed run's orphan up by, so a
    // blank one persisted here would make the group unfindable and the next run
    // would create a second.
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');
    vi.spyOn(runnerGroupClient, 'createGroup').mockResolvedValue({
      id: 4321,
      name: '',
      visibility: 'selected',
      allowsPublicRepositories: false,
    });

    await projectRunnerGroupService.syncForProject({
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
    });

    expect(await readProject(fx.projectId)).toMatchObject({
      runnerGroupId: 4321,
      runnerGroupName: runnerGroupNameFor(fx.projectId),
    });
  });

  it('marks the sync pending even when the failure is not an Error', async () => {
    const fx = await makeWorkItemFixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(runnerGroupClient, 'findGroupByName').mockImplementation(() => {
      throw 'a bare string, as a badly-behaved library might';
    });

    const result = await projectRunnerGroupService.syncForProject({
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
    });

    expect(result).toEqual({ outcome: 'sync_pending', detail: 'unknown' });
    expect(await readProject(fx.projectId)).toMatchObject({ runnerGroupSyncPending: true });
  });

  it('the quiet wrappers swallow an unexpected throw — never failing their caller', async () => {
    // The contract the establish / handoff / archive call sites depend on: the
    // repository is created, the transfer has happened, the project is archived.
    // None of those may be reported as failed because a group could not be kept.
    const fx = await makeWorkItemFixture();
    const target = { projectId: fx.projectId, workspaceId: fx.workspaceId };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const syncSpy = vi
      .spyOn(projectRunnerGroupService, 'syncForProject')
      .mockRejectedValue(new Error('the database went away'));
    const deleteSpy = vi
      .spyOn(projectRunnerGroupService, 'deleteForProject')
      .mockRejectedValue(new Error('the database went away'));

    await expect(projectRunnerGroupService.syncQuietly(target)).resolves.toBeUndefined();
    await expect(projectRunnerGroupService.deleteQuietly(target)).resolves.toBeUndefined();
    await expect(projectRunnerGroupService.syncAfterHandoff(target)).resolves.toBeUndefined();
    expect(syncSpy).toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalled();
  });
});

describe('a deployment that does not provision repositories has no group at all', () => {
  it('no-ops when the provisioning org / Studio App is unwired (self-hosted)', async () => {
    const fx = await makeWorkItemFixture();
    vi.stubEnv('GITHUB_FALLBACK_ORG', '');

    const result = await projectRunnerGroupService.syncForProject({
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
    });

    expect(result).toEqual({ outcome: 'not_configured' });
    expect(runnerGroups.groups.size).toBe(0);
    // Not an error and not a pending sync — off-cloud there is no fleet, so
    // there is nothing owed.
    expect(await readProject(fx.projectId)).toMatchObject({ runnerGroupSyncPending: false });
  });
});
