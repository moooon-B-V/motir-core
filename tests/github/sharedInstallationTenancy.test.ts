import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { ciMinutesMeterService } from '@/lib/services/ciMinutesMeterService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { ciPeriodUsageRepository } from '@/lib/repositories/ciPeriodUsageRepository';
import { listConnectedRepoNames } from '@/lib/workItems/targetRepo';
import { toProjectRepoNames } from '@/lib/projectRepos/names';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import type { NormalizedWorkflowRunEvent } from '@/lib/git/types';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-1931 — Motir's PROVISIONING-ORG mirror is PER-WORKSPACE.
//
// This is THE test that would have caught the defect the 2026-07-31 amendment to
// `docs/decisions/project-repository-set.md` records. Every project's created
// repos live in ONE Motir org behind ONE GitHub App installation, but the mirror
// bound that installation to exactly ONE workspace. So two tenants with created
// repos was not a rare edge — it is the NORMAL steady state of the product, and
// it broke four ways at once: the second tenant's establish re-bound the
// installation and PRUNED the first's repos, the first's repos went invisible
// under RLS (so `established` read false and no agent could be told where to
// build), every PR/CI/push delivery routed to whichever workspace held the row,
// and a verified Actions OIDC token authenticated into the wrong tenant.
//
// Every scenario below therefore puts TWO tenants behind ONE shared installation
// at the same time — a single-tenant version of any of these assertions passes
// against the broken code, which is exactly why it never fired.
//
// Real Postgres, real RLS contexts, no mocks beyond the GitHub HTTP boundary (the
// shipped convention for these suites).

const PASSWORD = 'hunter2hunter2';
/** The ONE installation Motir's provisioning org lives behind — shared by every
 *  tenant, bound to none (`workspace_id IS NULL`). */
const SHARED_INSTALLATION_ID = 'motir-provisioning-1';
const MOTIR_ORG = 'motir-projects';

const RUN_COMPLETED_AT = new Date('2026-07-30T12:00:00.000Z');
const JULY_2026 = new Date('2026-07-01T00:00:00.000Z');

interface Tenant {
  userId: string;
  workspaceId: string;
  organizationId: string;
  projectId: string;
  projectIdentifier: string;
  /** The mirrored repo Motir "created" for this tenant in the provisioning org. */
  githubRepoId: string;
  repoHostId: string;
  repoName: string;
  projectRepoId: string;
  ctx: { userId: string; workspaceId: string };
}

/** The shared provisioning installation — bound to NO workspace. This row is the
 *  substrate MOTIR-1931 ships; MOTIR-1781 (the creation primitive) is what will
 *  write it in production. */
async function seedSharedInstallation(): Promise<string> {
  const row = await db.githubInstallation.upsert({
    where: { installationId: SHARED_INSTALLATION_ID },
    create: {
      installationId: SHARED_INSTALLATION_ID,
      workspaceId: null,
      accountLogin: MOTIR_ORG,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  return row.id;
}

/**
 * A tenant whose project has ONE repo created for it in Motir's provisioning org:
 * a `github_repo` row under the SHARED installation, stamped with this tenant's
 * `workspace_id`, and a `project_repository` row realizing it.
 *
 * Deliberately NOT via `persistInstallation` — that path takes a
 * `workspaceId: string` and reconciles the installation's whole repo set, which
 * is precisely what must never happen for a shared installation (§3 of the
 * amendment). The creation primitive writes one row; so does this fixture.
 */
async function seedTenantWithCreatedRepo(opts: {
  email: string;
  identifier: string;
  repoName: string;
  repoHostId: string;
  sharedInstallationRowId: string;
}): Promise<Tenant> {
  const user = await usersService.createUser({
    email: opts.email,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${opts.identifier}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: `Project ${opts.identifier}`,
    identifier: opts.identifier,
  });

  const githubRepo = await db.githubRepo.create({
    data: {
      installationId: opts.sharedInstallationRowId,
      // The row's OWN tenancy — the whole point of the card.
      workspaceId: workspace.id,
      repoId: opts.repoHostId,
      owner: MOTIR_ORG,
      name: opts.repoName,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  const projectRepo = await db.projectRepo.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      role: 'web',
      name: opts.repoName,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: 'created',
      position: 'a0',
      githubRepoId: githubRepo.id,
    },
  });

  return {
    userId: user.id,
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
    projectIdentifier: opts.identifier,
    githubRepoId: githubRepo.id,
    repoHostId: opts.repoHostId,
    repoName: opts.repoName,
    projectRepoId: projectRepo.id,
    ctx: { userId: user.id, workspaceId: workspace.id },
  };
}

/** Both tenants, behind the one shared provisioning installation. */
async function seedTwoTenants(): Promise<{ a: Tenant; b: Tenant; installationRowId: string }> {
  const installationRowId = await seedSharedInstallation();
  const a = await seedTenantWithCreatedRepo({
    email: 'tenant-a@example.com',
    identifier: 'AAA',
    repoName: 'alpha-web',
    repoHostId: '900001',
    sharedInstallationRowId: installationRowId,
  });
  const b = await seedTenantWithCreatedRepo({
    email: 'tenant-b@example.com',
    identifier: 'BBB',
    repoName: 'bravo-web',
    repoHostId: '900002',
    sharedInstallationRowId: installationRowId,
  });
  return { a, b, installationRowId };
}

function prPayload(opts: {
  identifier: string;
  repoHostId: string;
  action?: string;
  number?: number;
  merged?: boolean;
  state?: 'open' | 'closed';
}) {
  return {
    action: opts.action ?? 'opened',
    installation: {
      id: SHARED_INSTALLATION_ID,
      account: { login: MOTIR_ORG, type: 'Organization' },
    },
    repository: { id: Number(opts.repoHostId) },
    pull_request: {
      number: opts.number ?? 7,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      title: `Some change (${opts.identifier})`,
      head: { ref: `feat/${opts.identifier}-a-change` },
      user: { id: 4242 },
    },
  };
}

/** Stub the App token mint + the workflow-jobs read (the meter's only network). */
function stubGithub(jobs = [{ id: 1, name: 'ci', minutes: 10 }]): ReturnType<typeof vi.fn> {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  const started = new Date('2026-07-30T11:00:00.000Z');
  const fetchMock = vi.fn(async (url: string): Promise<Response> => {
    const u = String(url);
    if (u.includes('/access_tokens')) {
      return new Response(
        JSON.stringify({
          token: 'ghs_x',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.includes('/actions/runs/')) {
      return new Response(
        JSON.stringify({
          total_count: jobs.length,
          jobs: jobs.map((job) => ({
            id: job.id,
            name: job.name,
            started_at: started.toISOString(),
            completed_at: new Date(started.getTime() + job.minutes * 60_000).toISOString(),
            labels: ['ubuntu-latest'],
            run_attempt: 1,
          })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch to ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function runEvent(overrides: Partial<NormalizedWorkflowRunEvent> = {}): NormalizedWorkflowRunEvent {
  return {
    providerRepoId: '900001',
    runId: '7001',
    attempt: 1,
    repoOwner: MOTIR_ORG,
    repoName: 'alpha-web',
    workflowName: 'CI',
    completedAt: RUN_COMPLETED_AT,
    ...overrides,
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('the shared provisioning installation holds SEVERAL tenants at once', () => {
  it('keeps both tenants’ repos, each visible only to its own workspace', async () => {
    const { a, b, installationRowId } = await seedTwoTenants();

    // Both rows really are on the ONE installation — this is a shared mirror, not
    // two installations that merely look alike.
    const all = await db.githubRepo.findMany({ where: { installationId: installationRowId } });
    expect(all).toHaveLength(2);
    const installation = await db.githubInstallation.findUniqueOrThrow({
      where: { id: installationRowId },
    });
    expect(installation.workspaceId).toBeNull();

    // Each tenant sees exactly its own repo through the real workspace-context
    // read — never the other's, and never nothing (which is what the shipped
    // join-through-the-installation produced for BOTH of them).
    const seenByA = await withWorkspaceContext(a.ctx, (tx) =>
      githubRepoRepository.listByWorkspace(a.workspaceId, tx),
    );
    const seenByB = await withWorkspaceContext(b.ctx, (tx) =>
      githubRepoRepository.listByWorkspace(b.workspaceId, tx),
    );
    expect(seenByA.map((r) => r.name)).toEqual(['alpha-web']);
    expect(seenByB.map((r) => r.name)).toEqual(['bravo-web']);
  });

  it('a workspace’s OWN installation does not steal the shared installation’s repos', async () => {
    const { a, b } = await seedTwoTenants();

    // Tenant B ALSO connects its own GitHub org the ordinary way. This is the
    // full-fat reconcile — the one that calls `deleteExcept` — running while
    // tenant A's created repo sits behind the shared installation.
    await githubInstallationService.persistInstallation({
      workspaceId: b.workspaceId,
      installation: {
        installationId: 'bravo-own-install',
        accountLogin: 'bravo-inc',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: '800001',
          owner: 'bravo-inc',
          name: 'legacy',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });

    // Tenant A's created repo is untouched...
    await expect(
      db.githubRepo.findUnique({ where: { id: a.githubRepoId } }),
    ).resolves.toMatchObject({ workspaceId: a.workspaceId, name: 'alpha-web' });
    // ...and the shared installation is still bound to nobody.
    const shared = await db.githubInstallation.findUniqueOrThrow({
      where: { installationId: SHARED_INSTALLATION_ID },
    });
    expect(shared.workspaceId).toBeNull();

    // Tenant B now legitimately sees BOTH: its created repo and its connected one.
    const seenByB = await withWorkspaceContext(b.ctx, (tx) =>
      githubRepoRepository.listByWorkspace(b.workspaceId, tx),
    );
    expect(seenByB.map((r) => r.name).sort()).toEqual(['bravo-web', 'legacy']);
    // And tenant A still sees only its own.
    const seenByA = await withWorkspaceContext(a.ctx, (tx) =>
      githubRepoRepository.listByWorkspace(a.workspaceId, tx),
    );
    expect(seenByA.map((r) => r.name)).toEqual(['alpha-web']);
  });
});

describe('a created repo is ESTABLISHED and DISPATCHABLE inside its own tenant', () => {
  it('reads established:true and yields a dispatchable name — for its own workspace only', async () => {
    const { a, b } = await seedTwoTenants();

    // The read the establish-step UI and the dispatch resolver both go through,
    // under the real RLS context (not a mock).
    const setA = await projectRepoSetService.listByProject(a.projectId, a.ctx);
    expect(setA).toHaveLength(1);
    expect(setA[0]).toMatchObject({ established: true, name: 'alpha-web' });

    const rowsA = await withWorkspaceContext(a.ctx, (tx) =>
      projectRepoRepository.listByProject(a.projectId, a.workspaceId, tx),
    );
    expect(toProjectRepoNames(rowsA).map((n) => n.name)).toEqual(['alpha-web']);

    // ...and tenant B's set names only ITS repo. The two never cross.
    const rowsB = await withWorkspaceContext(b.ctx, (tx) =>
      projectRepoRepository.listByProject(b.projectId, b.workspaceId, tx),
    );
    expect(toProjectRepoNames(rowsB).map((n) => n.name)).toEqual(['bravo-web']);
  });

  it('is in the workspace-scoped `targetRepo` domain (fact 7 of the amendment)', async () => {
    const { a, b } = await seedTwoTenants();

    // `listConnectedRepoNames` is the validation domain + default source for a
    // work item's `targetRepo`. A created repo was absent from it for a SECOND,
    // independent reason: `listByWorkspace` joined through the installation.
    const namesA = await listConnectedRepoNames(a.ctx);
    expect(namesA.map((n) => n.name)).toEqual(['alpha-web']);
    const namesB = await listConnectedRepoNames(b.ctx);
    expect(namesB.map((n) => n.name)).toEqual(['bravo-web']);
  });
});

describe('inbound deliveries route by REPO, not by installation', () => {
  it('syncs a PR to the work item of the workspace that OWNS the repo', async () => {
    const { a, b } = await seedTwoTenants();

    // One work item per tenant, each In Progress so `opened → in_review` is legal.
    const itemA = await workItemsService.createWorkItem(
      { projectId: a.projectId, kind: 'task', title: 'A change' },
      a.ctx,
    );
    await workItemsService.updateStatus(itemA.id, 'in_progress', a.ctx);
    const itemB = await workItemsService.createWorkItem(
      { projectId: b.projectId, kind: 'task', title: 'B change' },
      b.ctx,
    );
    await workItemsService.updateStatus(itemB.id, 'in_progress', b.ctx);

    // A delivery on TENANT B's repo, over the SHARED installation id.
    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ identifier: itemB.identifier, repoHostId: b.repoHostId }),
    );
    expect(result).toMatchObject({ outcome: 'transitioned', workItemId: itemB.id });

    // B moved; A did not. Routing by installation would have resolved the work
    // item inside whichever workspace held the installation row.
    await expect(db.workItem.findUnique({ where: { id: itemB.id } })).resolves.toMatchObject({
      status: 'in_review',
    });
    await expect(db.workItem.findUnique({ where: { id: itemA.id } })).resolves.toMatchObject({
      status: 'in_progress',
    });

    // The PR row hangs off B's repo — the only one it could, since the repo is
    // what the delivery resolved through. (Its INVISIBILITY to tenant A is proved
    // in `github-repo-rls.test.ts`, which drops to the non-BYPASSRLS
    // `prodect_app` role; asserting it here would assert nothing, because these
    // suites connect as the `prodect` superuser.)
    const prRows = await db.githubPullRequest.findMany({});
    expect(prRows).toHaveLength(1);
    expect(prRows[0]!.repoId).toBe(b.githubRepoId);
  });

  it('SKIPS reconcile for the shared installation instead of pruning a tenant’s repos', async () => {
    const { a, b, installationRowId } = await seedTwoTenants();

    // GitHub sends `installation_repositories` for the shared installation. The
    // shipped code would have fetched the org's authoritative repo set and handed
    // it to `persistInstallation` — deleting every repo not in THAT list and
    // leaking the rest into one workspace.
    const result = await githubWebhookService.handleEvent('installation_repositories', {
      action: 'added',
      installation: {
        id: SHARED_INSTALLATION_ID,
        account: { login: MOTIR_ORG, type: 'Organization' },
      },
    });
    expect(result).toEqual({
      event: 'installation_repositories',
      outcome: 'skipped_shared_installation',
    });

    // Both tenants' repos survive, still tenanted to themselves.
    const rows = await db.githubRepo.findMany({
      where: { installationId: installationRowId },
      orderBy: { name: 'asc' },
    });
    expect(rows.map((r) => [r.name, r.workspaceId])).toEqual([
      ['alpha-web', a.workspaceId],
      ['bravo-web', b.workspaceId],
    ]);
  });

  it('still reconciles a workspace’s OWN installation exactly as before', async () => {
    const { b } = await seedTwoTenants();
    await githubInstallationService.persistInstallation({
      workspaceId: b.workspaceId,
      installation: {
        installationId: 'bravo-own-install',
        accountLogin: 'bravo-inc',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: '800001',
          owner: 'bravo-inc',
          name: 'legacy',
          defaultBranch: 'main',
          archived: false,
        },
        {
          providerRepoId: '800002',
          owner: 'bravo-inc',
          name: 'dropped',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/access_tokens')) {
          return new Response(
            JSON.stringify({
              token: 'ghs_x',
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        // The authoritative set now omits `dropped`.
        return new Response(
          JSON.stringify({
            total_count: 1,
            repositories: [
              { id: 800001, name: 'legacy', default_branch: 'main', owner: { login: 'bravo-inc' } },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);

    const result = await githubWebhookService.handleEvent('installation_repositories', {
      action: 'removed',
      installation: {
        id: 'bravo-own-install',
        account: { login: 'bravo-inc', type: 'Organization' },
      },
    });
    // The user path is UNCHANGED: it syncs, and the de-selected repo is pruned.
    expect(result).toEqual({ event: 'installation_repositories', outcome: 'synced' });
    const own = await db.githubRepo.findMany({
      where: { installation: { installationId: 'bravo-own-install' } },
    });
    expect(own.map((r) => r.name)).toEqual(['legacy']);
    // The prune stamped the tenancy on the surviving row too.
    expect(own[0]!.workspaceId).toBe(b.workspaceId);
  });
});

describe('the CI meter bills the workspace that OWNS the repo', () => {
  it('attributes two tenants’ identical runs to their own pools', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'true');
    vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
    const { a, b } = await seedTwoTenants();
    stubGithub();

    const resultA = await ciMinutesMeterService.meterWorkflowRun(
      runEvent({ providerRepoId: a.repoHostId, repoName: a.repoName, runId: '7001' }),
      SHARED_INSTALLATION_ID,
    );
    const resultB = await ciMinutesMeterService.meterWorkflowRun(
      runEvent({ providerRepoId: b.repoHostId, repoName: b.repoName, runId: '7002' }),
      SHARED_INSTALLATION_ID,
    );

    expect(resultA).toMatchObject({ outcome: 'metered', organizationId: a.organizationId });
    expect(resultB).toMatchObject({ outcome: 'metered', organizationId: b.organizationId });

    // Each pool carries ITS OWN run's minutes — not both, and not zero. Before
    // MOTIR-1931 the second tenant's run resolved no `project_repository` row
    // under the wrong workspace's GUC and fell into §5.4's "charged to nobody".
    const usageA = await withWorkspaceServiceContext(a.workspaceId, (tx) =>
      ciPeriodUsageRepository.findByWorkspaceAndPeriod(a.workspaceId, JULY_2026, tx),
    );
    const usageB = await withWorkspaceServiceContext(b.workspaceId, (tx) =>
      ciPeriodUsageRepository.findByWorkspaceAndPeriod(b.workspaceId, JULY_2026, tx),
    );
    expect(usageA?.billableMinutes).toBe(10);
    expect(usageB?.billableMinutes).toBe(10);

    // And each usage row points at its own project.
    const usageRows = await db.ciWorkflowRunUsage.findMany({ orderBy: { runId: 'asc' } });
    expect(usageRows.map((r) => r.workspaceId)).toEqual([a.workspaceId, b.workspaceId]);
  });
});

describe('the explicit item→PR link affordance reaches a created repo', () => {
  it('finds and links a shared-installation PR inside its own tenant, never another’s', async () => {
    const { a, b } = await seedTwoTenants();

    // A PR lands on tenant B's created repo, via the shared installation.
    const itemB = await workItemsService.createWorkItem(
      { projectId: b.projectId, kind: 'task', title: 'B change' },
      b.ctx,
    );
    await githubWebhookService.handleEvent(
      'pull_request',
      // No `MOTIR-<n>` in the ref, so the auto-resolver leaves it unlinked — the
      // exact case the manual affordance exists for.
      prPayload({ identifier: 'nothing', repoHostId: b.repoHostId, number: 11 }),
    );
    const pr = await db.githubPullRequest.findFirstOrThrow({});

    // Two sites the TYPE CHECKER could not flag, because both compare rather than
    // assign: the candidate search's tenant filter, and `linkPullRequest`'s gate.
    // Both joined through the installation, which for a shared one is bound to no
    // workspace — so both would have failed CLOSED on every created repo.
    const candidates = await githubPullRequestService.searchLinkCandidates(
      itemB.id,
      'bravo',
      b.ctx,
    );
    expect(candidates.map((c) => c.id)).toEqual([pr.id]);

    const linked = await githubPullRequestService.linkPullRequest(itemB.id, pr.id, b.ctx);
    expect(linked).toMatchObject({
      number: 11,
      repo: `${MOTIR_ORG}/${b.repoName}`,
      linkedManually: true,
    });

    // Tenant A cannot see or link tenant B's PR — the gate still holds the line.
    const itemA = await workItemsService.createWorkItem(
      { projectId: a.projectId, kind: 'task', title: 'A change' },
      a.ctx,
    );
    await expect(
      githubPullRequestService.searchLinkCandidates(itemA.id, 'bravo', a.ctx),
    ).resolves.toEqual([]);
    await expect(
      githubPullRequestService.linkPullRequest(itemA.id, pr.id, a.ctx),
    ).rejects.toThrow();
  });
});
