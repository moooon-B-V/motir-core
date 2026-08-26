import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { resetDatabase } from './_helpers/db-reset';
import { seedGithubInstallation } from './_helpers/github-seed';
import { E2E_REPO, E2E_REPO_SECOND } from './_helpers/github-const';

// Story E2E — MOTIR-3584: `motir link` brings the code down (Subtask
// MOTIR-3591). The TERMINAL'S HALF, over real HTTP.
//
// ── WHAT THIS SPEC DRIVES, AND WHAT IT DELIBERATELY DOES NOT ────────────────
// Stated as the design rather than as a caveat. Playwright does not spawn the
// CLI, and a spec that claimed to would be asserting its own harness.
// `tests/e2e/cli-connect.spec.ts` is the shipped precedent for exactly this
// shape: it drives the terminal's half over the real HTTP surface — real routes,
// real Postgres, no stubs, no fakes — and leaves the loop's own decisions to the
// unit lane. This does the same.
//
//   IN THIS SPEC: `GET /api/v1/projects/{key}/repositories`, as a bearer-holding
//   terminal makes it. The set is seeded in more than one establish state, and
//   the spec asserts the EXACT body the CLI's clone planner consumes — the
//   checkout `name` per row, `cloneUrl`, `defaultBranch`, `state` and the derived
//   `established`, with the null-`cloneUrl` row PRESENT rather than omitted. Then
//   the two refusals, against real gates: a cross-workspace token gets 404, and a
//   token carrying only `CLI_TOKEN_GRANT` gets 200.
//
//   NOT IN THIS SPEC, and named here so nobody adds it: the clone itself, the
//   per-repository report, the never-write-into-an-existing-path invariant and
//   the dispatch resolution. Those are FILESYSTEM and PROCESS behaviour, driven
//   against the injected `CommandRunner` in `packages/cli/test/*` — the lane that
//   can reach them, with no git process and no network. A browser spec cannot
//   observe a directory, and one that faked the observation would be asserting
//   the fake.
//
// ── THE LANE, VERIFIED RATHER THAN ASSUMED ──────────────────────────────────
// The BULK lane, not the cloud one. The state this spec seeds is reachable here:
// `tests/e2e/repository-set.spec.ts` runs in this lane and seeds the very same
// installation mirror through `seedGithubInstallation`, which is a service call
// and not a cloud-gated boundary. `cloud-repository-set.spec.ts` needs the cloud
// env because it drives repository CREATION through a faked GitHub boundary
// (`E2E_TEST_GITHUB_REPOS=1`); nothing here creates a repository — the rows are
// established directly, which is the state the read is about.
//
// ── NO ACCEPTANCE VIDEO ─────────────────────────────────────────────────────
// The story's deliverables are a CLI behaviour and an HTTP endpoint — no page,
// panel, control or flow a person watches — so it is a NON-UI story and accepts
// on its tests alone, per the scoped acceptance-video rule. This file is
// deliberately NOT named `acceptance*.spec.ts` and records nothing.
//
// ── WAITS ───────────────────────────────────────────────────────────────────
// Every wait is on an authoritative signal: the route's own status and body.
// There is no optimistic surface here to race, no fixed sleep and no clock
// control.

const PASSWORD = 'hunter2hunter2';
const BASE = '/api/v1';

interface RepositoryRow {
  id: string;
  role: string;
  label: string | null;
  name: string | null;
  repoRef: string | null;
  cloneUrl: string | null;
  defaultBranch: string | null;
  archived: boolean;
  state: string;
  established: boolean;
}

interface Seed {
  projectKey: string;
  /** A bearer carrying EXACTLY `CLI_TOKEN_GRANT` — the credential the one caller
   *  this endpoint exists for actually holds. */
  cliToken: string;
  ctx: { userId: string; workspaceId: string };
  projectId: string;
}

/**
 * One user, one workspace, one project, and a bearer carrying exactly
 * `CLI_TOKEN_GRANT` — with NO repository set.
 *
 * Its own function because the cross-tenant case needs a second tenant and must
 * NOT have a set: a `github_repo` row backs at most one `project_repository`
 * row (`RealizedRepoAlreadyClaimedError`), and `seedGithubInstallation` upserts
 * ONE installation id — so a second seeded set in the same database would claim
 * mirrors the first already holds. The stranger needs a valid token in another
 * workspace, and nothing else.
 */
async function seedBareProject(email: string, identifier: string): Promise<Seed> {
  const owner = await usersService.createUser({ email, password: PASSWORD, name: 'Repo Reader' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Repos ${identifier}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Repos ${identifier}`,
    identifier,
  });
  const minted = await apiTokensService.create(owner.id, workspace.id, {
    label: `repo-set-e2e-${identifier}`,
    projectId: project.id,
    permissions: [...CLI_TOKEN_GRANT],
  });
  return {
    projectKey: project.identifier,
    cliToken: minted.token,
    ctx: { userId: owner.id, workspaceId: workspace.id },
    projectId: project.id,
  };
}

/**
 * That project, with a repository set in THREE distinct states.
 *
 * Seeded through the SERVICES rather than a test route: establishing a row means
 * attaching a realized repository to it, and marking one `skipped` means moving
 * it through the lifecycle — neither is expressible as a create-time argument
 * anywhere else.
 */
async function seedRepositorySetProject(email: string, identifier: string): Promise<Seed> {
  const seed = await seedBareProject(email, identifier);
  const { ctx, projectId: project } = seed;

  // The installation mirror the established rows realize against — the same
  // helper `repository-set.spec.ts` uses, with its second repository opted in.
  const installation = await seedGithubInstallation(ctx.workspaceId, [E2E_REPO_SECOND]);
  const mirrored = new Map(installation.repos.map((repo) => [repo.name, repo.id]));

  // 1 — ESTABLISHED, with coordinates: the row a clone actually acts on.
  const web = await projectRepoSetService.addRow(
    project,
    { role: 'web', name: E2E_REPO.name },
    ctx,
  );
  await projectRepoSetService.attachRealizedRepo(web.id, mirrored.get(E2E_REPO.name)!, ctx);

  // 2 — ESTABLISHED, second repository, on a DIFFERENT default branch. A
  //     fixture where both default to `main` cannot tell a real read of each
  //     row's own branch from a hard-coded one.
  const api = await projectRepoSetService.addRow(
    project,
    { role: 'api', name: E2E_REPO_SECOND.name },
    ctx,
  );
  await projectRepoSetService.attachRealizedRepo(api.id, mirrored.get(E2E_REPO_SECOND.name)!, ctx);

  // 3 — PROPOSED: a real member of the set with no repository behind it, and
  //     therefore no clone URL. This is the row the CLI reports as skipped, and
  //     the one an endpoint that filtered by "has coordinates" would drop.
  await projectRepoSetService.addRow(project, { role: 'shared', name: 'acme-shared' }, ctx);

  // 4 — SKIPPED: a settled row the establish step was told to leave alone. A
  //     THIRD state, so "at least three" is a fact rather than a coincidence of
  //     two established rows plus one proposed.
  const other = await projectRepoSetService.addRow(
    project,
    { role: 'other', name: 'acme-nothing' },
    ctx,
  );
  await projectRepoSetService.skipRow(other.id, ctx);

  return seed;
}

/** The read, as a terminal makes it: a bearer, no cookie. */
async function readRepositories(
  ctx: APIRequestContext,
  projectKey: string,
  token: string,
): Promise<{ status: number; items: RepositoryRow[]; body: string }> {
  const res = await ctx.get(`${BASE}/projects/${projectKey}/repositories`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.text();
  const items = res.status() === 200 ? (JSON.parse(body) as { items: RepositoryRow[] }).items : [];
  return { status: res.status(), items, body };
}

test.beforeEach(async () => {
  await resetDatabase();
});

test('publishes the repository set a terminal clones from, over real HTTP', async ({ request }) => {
  const seed = await seedRepositorySetProject('e2e-repo-set-api@example.com', 'RAPI');

  const { status, items, body } = await readRepositories(request, seed.projectKey, seed.cliToken);
  expect(status, body.slice(0, 400)).toBe(200);

  // FOUR rows for four rows. The unestablished ones are PRESENT — a client that
  // saw three of them could not say why the fourth was skipped, and a set the
  // reader cannot account for is worse than no answer.
  expect(items).toHaveLength(4);
  expect(items.map((r) => r.state)).toEqual(['connected', 'connected', 'proposed', 'skipped']);

  const [web, api, proposed, skipped] = items;

  // The two established rows carry everything a clone needs, each reading its
  // OWN default branch.
  expect(web).toMatchObject({
    role: 'web',
    name: E2E_REPO.name,
    cloneUrl: `https://github.com/${E2E_REPO.owner}/${E2E_REPO.name}.git`,
    defaultBranch: E2E_REPO.defaultBranch,
    established: true,
  });
  expect(api).toMatchObject({
    role: 'api',
    name: E2E_REPO_SECOND.name,
    cloneUrl: `https://github.com/${E2E_REPO_SECOND.owner}/${E2E_REPO_SECOND.name}.git`,
    defaultBranch: E2E_REPO_SECOND.defaultBranch,
    established: true,
  });
  expect(api!.defaultBranch).not.toBe(web!.defaultBranch);

  // The null-`cloneUrl` rows, present with their state and nothing invented.
  for (const row of [proposed, skipped]) {
    expect(row).toMatchObject({
      name: null,
      repoRef: null,
      cloneUrl: null,
      defaultBranch: null,
      established: false,
    });
  }

  // The row id is the value a work item's `targetRepositories` names, so the two
  // reads can be matched up. Real ids, never invented ones.
  expect(items.every((r) => typeof r.id === 'string' && r.id.length > 0)).toBe(true);
});

test('answers a token carrying exactly CLI_TOKEN_GRANT — the one caller it exists for', async ({
  request,
}) => {
  const seed = await seedRepositorySetProject('e2e-repo-set-grant@example.com', 'RGNT');

  const { status, body } = await readRepositories(request, seed.projectKey, seed.cliToken);

  // The gate every owner-authenticated test is blind to: a read the CLI's own
  // fixed grant cannot make ships dead, and looks perfect until a user runs it.
  expect(status, body.slice(0, 400)).toBe(200);
  expect(CLI_TOKEN_GRANT).toContain('project:browse');
});

test('gives a cross-workspace token the same 404 as a key that never existed', async ({
  request,
}) => {
  const owned = await seedRepositorySetProject('e2e-repo-set-owner@example.com', 'ROWN');
  const stranger = await seedBareProject('e2e-repo-set-stranger@example.com', 'RSTR');

  const foreign = await readRepositories(request, owned.projectKey, stranger.cliToken);
  const absent = await readRepositories(request, 'NOSUCH', stranger.cliToken);

  // Indistinguishable, deliberately: a 403 would confirm the key resolves to a
  // real project and let a caller enumerate which keys exist.
  expect(foreign.status).toBe(404);
  expect(absent.status).toBe(404);
  expect(foreign.items).toEqual([]);
});
