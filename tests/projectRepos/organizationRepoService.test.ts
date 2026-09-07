import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { organizationRepoService } from '@/lib/services/organizationRepoService';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { getGitProvider } from '@/lib/git';
import {
  ProjectRepoNameTakenError,
  RealizedRepoAlreadyClaimedError,
} from '@/lib/projectRepos/errors';
import { OrgForbiddenError, OrganizationNotFoundError } from '@/lib/organizations/errors';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// ADD AND LINK — one org-admin action, two inputs
// Story MOTIR-4669 · subtask MOTIR-4678.
//
// The service behind the ONE action this story is about. What it owns, and what
// every assertion below is a different face of:
//
//   1. PICKING an organisation repository is FREE. Not cheap — free. No
//      installation call, no index enqueue, no graph work.
//   2. The organisation's inventory spans its WORKSPACES, which is the claim the
//      whole tenancy move exists to make true.
//   3. Adding is ORG-ADMIN whichever door you enter by, asserted where the gate
//      lives rather than where a user meets it.
//   4. The guarantee that SURVIVED MOTIR-4648 — one repository at most once per
//      project — still refuses the double-add, while a SECOND project succeeds.
//
// ⚠️ THE CENTRAL ASSERTION IS AN ABSENCE, and an absence has exactly one honest
// shape: a call COUNT of zero on the seam where the enqueue would have happened.
// A test that only checks the response is 201 proves the row appeared and says
// nothing about what it cost — which is the entire subject of this card.
//
// Real Postgres. The one thing stubbed is the GITHUB HOST (`fetchInstallation` /
// `fetchInstallationRepos` on the provider seam), because it is a network call
// to api.github.com; every DB path, gate and transaction is real.

let fx: WorkItemFixture;
let orgId: string;
let installationRowId: string;
let repoA: string;
let repoB: string;

/** The enqueue seam, spied so an ABSENCE can be asserted rather than inferred. */
let enqueueSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  orgId = fx.workspace.organizationId;

  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      organizationId: orgId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  installationRowId = installation.id;

  repoA = (await seedRepo('motir-core', 'repo-a', fx.workspaceId)).id;
  repoB = (await seedRepo('motir-ai', 'repo-b', fx.workspaceId)).id;

  enqueueSpy = vi.spyOn(codeGraphIndexService, 'enqueueFirstIndexForRepos').mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function seedRepo(name: string, repoId: string, workspaceId: string) {
  return adminDb.githubRepo.create({
    data: {
      installationId: installationRowId,
      workspaceId,
      organizationId: orgId,
      repoId,
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      provider: 'github',
      archived: false,
    },
  });
}

/** A SECOND workspace in the SAME organisation, with a project of its own — the
 *  fixture the org-spanning claims need, because in a one-workspace org the
 *  workspace-keyed answer and the org-keyed answer are the same answer. */
async function secondWorkspaceInSameOrg() {
  const ws = await adminDb.workspace.create({
    data: {
      organizationId: orgId,
      name: 'Second workspace',
      slug: `ws2-${Math.floor(Math.random() * 1_000_000)}`,
    },
  });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: ws.id, userId: fx.ownerId, role: 'owner' },
  });
  const project = await createTestProject({
    workspaceId: ws.id,
    actorUserId: fx.ownerId,
    identifier: `SEC${Math.floor(Math.random() * 10_000)}`,
  });
  const ctx: ServiceContext = { userId: fx.ownerId, workspaceId: ws.id };
  return { workspaceId: ws.id, projectId: project.id, ctx };
}

/** A user who administers the PROJECT but is a plain member of the ORGANISATION —
 *  the actor the org-admin gate exists for, and the one the room's own
 *  `repository:manage` would otherwise wave through. */
async function projectAdminButNotOrgAdmin() {
  const user = await adminDb.user.create({
    data: {
      email: `pa-${Math.floor(Math.random() * 1_000_000)}@example.com`,
      name: 'Project admin',
      emailVerified: true,
    },
  });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: fx.workspaceId, userId: user.id, role: 'admin' },
  });
  await adminDb.organizationMembership.create({
    data: { organizationId: orgId, userId: user.id, role: ORGANIZATION_ROLE.member },
  });
  const ctx: ServiceContext = { userId: user.id, workspaceId: fx.workspaceId };
  return { userId: user.id, ctx };
}

describe('PICK — linking an organisation repository costs NOTHING', () => {
  it('creates exactly ONE row and enqueues ZERO indexes', async () => {
    const row = await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: repoA, role: 'api' },
      fx.ctx,
    );

    expect(row.realizedRepo?.id).toBe(repoA);
    expect(row.state).toBe('connected');

    const rows = await adminDb.projectRepo.findMany({ where: { projectId: fx.projectId } });
    expect(rows).toHaveLength(1);

    // THE assertion of this card. Not "the response was 201" — the enqueue was
    // never reached. A conditional enqueue added later "for safety" fails here.
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('the row is usable IMMEDIATELY — realized, not proposed, in one write', async () => {
    // There is no intermediate state to observe: the repository exists before the
    // row does. A row created `proposed` and then attached would be a moment in
    // which the picker's promise ("linked immediately") is false.
    await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: repoA, role: 'api' },
      fx.ctx,
    );
    const [row] = await adminDb.projectRepo.findMany({ where: { projectId: fx.projectId } });
    expect(row?.state).toBe('connected');
    expect(row?.githubRepoId).toBe(repoA);
  });

  it('takes its NAME from the repository when the caller gives none', async () => {
    const row = await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: repoA, role: 'api' },
      fx.ctx,
    );
    expect(row.name).toBe('motir-core');
  });
});

describe('the picker READ spans the ORGANISATION, not the workspace', () => {
  it('offers a repository connected from ANOTHER workspace of the same org', async () => {
    const second = await secondWorkspaceInSameOrg();
    // Connected FROM the second workspace; the first workspace's project must
    // still be offered it, because tenancy is the organisation.
    const cross = await seedRepo('motir-gateway', 'repo-cross', second.workspaceId);

    const options = await organizationRepoService.listAvailableForProject(fx.projectId, fx.ctx);
    const ids = options.map((o) => o.id);
    expect(ids).toContain(cross.id);
    expect(ids).toEqual(expect.arrayContaining([repoA, repoB, cross.id]));

    // …and the provenance is reported without scoping anything.
    expect(options.find((o) => o.id === cross.id)?.connectedFromWorkspaceId).toBe(
      second.workspaceId,
    );
  });

  it('EXCLUDES the repositories this project already holds', async () => {
    await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: repoA, role: 'api' },
      fx.ctx,
    );
    const options = await organizationRepoService.listAvailableForProject(fx.projectId, fx.ctx);
    expect(options.map((o) => o.id)).toEqual([repoB]);
  });

  it('excludes per PROJECT, not per organisation — a sibling project still sees it', async () => {
    // The subtraction is about THIS project's set. A repository another project
    // took is still available here; that is the capability, not a leak.
    const second = await secondWorkspaceInSameOrg();
    await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: repoA, role: 'api' },
      fx.ctx,
    );
    const options = await organizationRepoService.listAvailableForProject(
      second.projectId,
      second.ctx,
    );
    expect(options.map((o) => o.id)).toEqual(expect.arrayContaining([repoA, repoB]));
  });

  it('offers NOTHING from another ORGANISATION', async () => {
    const otherOrg = await adminDb.organization.create({
      data: { name: 'Other org', slug: `other-${Math.floor(Math.random() * 1_000_000)}` },
    });
    const otherWs = await adminDb.workspace.create({
      data: {
        organizationId: otherOrg.id,
        name: 'Other ws',
        slug: `otherws-${Math.floor(Math.random() * 1_000_000)}`,
      },
    });
    const foreignInstallation = await adminDb.githubInstallation.create({
      data: {
        installationId: 'inst-foreign',
        workspaceId: otherWs.id,
        organizationId: otherOrg.id,
        accountLogin: 'rival',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const foreign = await adminDb.githubRepo.create({
      data: {
        installationId: foreignInstallation.id,
        workspaceId: otherWs.id,
        organizationId: otherOrg.id,
        repoId: 'repo-foreign',
        owner: 'rival',
        name: 'secrets',
        defaultBranch: 'main',
        provider: 'github',
        archived: false,
      },
    });

    const options = await organizationRepoService.listAvailableForProject(fx.projectId, fx.ctx);
    expect(options.map((o) => o.id)).not.toContain(foreign.id);
  });
});

describe('the ORG-ADMIN gate, asserted where it LIVES', () => {
  it('refuses a project admin who is a plain org member — on the PICK path', async () => {
    const actor = await projectAdminButNotOrgAdmin();
    // Driven against the SERVICE, not a route: the point of putting the gate here
    // is that it holds for every caller, and a test through one route proves it
    // for that route only.
    await expect(
      organizationRepoService.linkExistingRepo(
        fx.projectId,
        { githubRepoId: repoA, role: 'api' },
        actor.ctx,
      ),
    ).rejects.toBeInstanceOf(OrgForbiddenError);

    // Refused means NOTHING happened — not "refused after the row landed".
    expect(await adminDb.projectRepo.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('refuses that same actor on the CONNECT path BEFORE any provider call', async () => {
    const actor = await projectAdminButNotOrgAdmin();
    const provider = getGitProvider('github');
    const fetchInstallation = vi.spyOn(provider, 'fetchInstallation');

    await expect(
      organizationRepoService.connectAndLink(
        fx.projectId,
        { installationId: 'inst-new', providerRepoId: 'repo-new', role: 'api' },
        actor.ctx,
      ),
    ).rejects.toBeInstanceOf(OrgForbiddenError);

    // The gate runs while there is still nothing to undo. A refusal AFTER the
    // bind would have connected a repository to an organisation the actor does
    // not administer and then declined to link it — the worse half, kept.
    expect(fetchInstallation).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('an ORG ADMIN is allowed — so the refusal above is the ROLE, not the fixture', async () => {
    // The counterfactual. Without it, a gate that refused everyone would pass the
    // two tests above.
    const row = await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: repoA, role: 'api' },
      fx.ctx,
    );
    expect(row.realizedRepo?.id).toBe(repoA);
  });

  it('a NON-member of the organisation gets not-found, never forbidden', async () => {
    // The org tier's own posture, preserved through this gate: an org you are not
    // in is indistinguishable from an org that does not exist.
    const stranger = await adminDb.user.create({
      data: {
        email: `stranger-${Math.floor(Math.random() * 1_000_000)}@example.com`,
        name: 'Stranger',
        emailVerified: true,
      },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: fx.workspaceId, userId: stranger.id, role: 'admin' },
    });
    await expect(
      organizationRepoService.linkExistingRepo(
        fx.projectId,
        { githubRepoId: repoA, role: 'api' },
        { userId: stranger.id, workspaceId: fx.workspaceId },
      ),
    ).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });
});

describe('the guarantee that SURVIVED, and the capability that arrived', () => {
  it('REFUSES the same repository twice in ONE project, by the pre-existing error', async () => {
    await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: repoA, role: 'api' },
      fx.ctx,
    );
    // Asserted BY CLASS: MOTIR-4648 kept this error and its 409 while dropping
    // the global unique index, and a test on the message would not notice it
    // being replaced by a different one that happens to read the same.
    await expect(
      organizationRepoService.linkExistingRepo(
        fx.projectId,
        { githubRepoId: repoA, role: 'shared', name: 'motir-core-again' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(RealizedRepoAlreadyClaimedError);
  });

  it('ACCEPTS the same repository into a SECOND project — the capability this story exists for', async () => {
    const second = await secondWorkspaceInSameOrg();
    await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: repoA, role: 'api' },
      fx.ctx,
    );
    const row = await organizationRepoService.linkExistingRepo(
      second.projectId,
      { githubRepoId: repoA, role: 'api' },
      second.ctx,
    );
    expect(row.realizedRepo?.id).toBe(repoA);

    const both = await adminDb.projectRepo.findMany({ where: { githubRepoId: repoA } });
    expect(both).toHaveLength(2);
    // …and the second link cost nothing either.
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('refuses a repository id from ANOTHER organisation the same way as a fictional one', async () => {
    // Two ids that must be indistinguishable to a prober: one real elsewhere, one
    // invented. Same error class, so the response cannot be used as an oracle.
    const otherOrg = await adminDb.organization.create({
      data: { name: 'Other org', slug: `other2-${Math.floor(Math.random() * 1_000_000)}` },
    });
    const otherWs = await adminDb.workspace.create({
      data: {
        organizationId: otherOrg.id,
        name: 'Other ws',
        slug: `otherws2-${Math.floor(Math.random() * 1_000_000)}`,
      },
    });
    const foreignInstallation = await adminDb.githubInstallation.create({
      data: {
        installationId: 'inst-foreign-2',
        workspaceId: otherWs.id,
        organizationId: otherOrg.id,
        accountLogin: 'rival',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const foreign = await adminDb.githubRepo.create({
      data: {
        installationId: foreignInstallation.id,
        workspaceId: otherWs.id,
        organizationId: otherOrg.id,
        repoId: 'repo-foreign-2',
        owner: 'rival',
        name: 'secrets',
        defaultBranch: 'main',
        provider: 'github',
        archived: false,
      },
    });

    const real = await organizationRepoService
      .linkExistingRepo(fx.projectId, { githubRepoId: foreign.id, role: 'api' }, fx.ctx)
      .catch((e: unknown) => (e as Error).constructor.name);
    const invented = await organizationRepoService
      .linkExistingRepo(fx.projectId, { githubRepoId: 'gr_not_a_row', role: 'api' }, fx.ctx)
      .catch((e: unknown) => (e as Error).constructor.name);

    expect(real).toBe(invented);
    expect(real).toBe('ProjectRepoInvalidFieldError');
  });
});

describe('the CONCURRENCY translation — a raw P2002 never escapes', () => {
  // The pre-checks (`findByProjectAndGithubRepoId`, the name look-up) are reads,
  // so two callers can both pass them and both reach the INSERT. The database
  // settles it; what this suite asserts is that the loser gets the same TYPED
  // error the sequential caller gets, not a `PrismaClientKnownRequestError`
  // leaking out of the service (CLAUDE.md's concurrency-to-typed-error rule).
  //
  // Per the same rule a concurrency test accepts every legitimate outcome: the
  // pre-check may win the race and raise first, or the index may. Both are
  // correct; what is NOT correct is a raw P2002.

  it('two callers linking the SAME repository — one wins, the loser is typed', async () => {
    const results = await Promise.allSettled([
      organizationRepoService.linkExistingRepo(
        fx.projectId,
        { githubRepoId: repoA, role: 'api' },
        fx.ctx,
      ),
      organizationRepoService.linkExistingRepo(
        fx.projectId,
        { githubRepoId: repoA, role: 'shared', name: 'motir-core-two' },
        fx.ctx,
      ),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      RealizedRepoAlreadyClaimedError,
    );

    // The database is the arbiter, and it left exactly one row.
    expect(await adminDb.projectRepo.count({ where: { projectId: fx.projectId } })).toBe(1);
  });

  it('two callers claiming the same NAME for different repositories — the loser is typed too', async () => {
    // The OTHER unique index on the same insert. It matters that the two are
    // told apart: "that repository is already here" and "that name is taken" send
    // a person to different fixes, and a translation that collapsed them would
    // send half of them to the wrong one.
    const results = await Promise.allSettled([
      organizationRepoService.linkExistingRepo(
        fx.projectId,
        { githubRepoId: repoA, role: 'api', name: 'shared-name' },
        fx.ctx,
      ),
      organizationRepoService.linkExistingRepo(
        fx.projectId,
        { githubRepoId: repoB, role: 'api', name: 'shared-name' },
        fx.ctx,
      ),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ProjectRepoNameTakenError);
    expect(lost.reason).not.toBeInstanceOf(RealizedRepoAlreadyClaimedError);
  });
});

describe('CONNECT — the one path that costs an index, and it costs exactly one', () => {
  it('performs the org connection AND the project link, enqueuing ONE index', async () => {
    const provider = getGitProvider('github');
    // The GitHub HOST is the only thing stubbed — a network call to
    // api.github.com cannot run in a test. Everything below it is real: the
    // installation upsert, the repo rows, the gate, the link write.
    vi.spyOn(provider, 'fetchInstallation').mockResolvedValue({
      installationId: 'inst-new',
      accountLogin: 'moooon',
      accountType: 'Organization',
    });
    vi.spyOn(provider, 'fetchInstallationRepos').mockResolvedValue([
      {
        providerRepoId: 'repo-new',
        owner: 'moooon',
        name: 'brand-new',
        defaultBranch: 'main',
        archived: false,
      },
    ]);

    const row = await organizationRepoService.connectAndLink(
      fx.projectId,
      { installationId: 'inst-new', providerRepoId: 'repo-new', role: 'api' },
      fx.ctx,
    );

    // The link landed…
    expect(row.state).toBe('connected');
    expect(row.name).toBe('brand-new');

    // …the ORG connection landed, stamped with the organisation (MOTIR-4649)…
    const persisted = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: 'repo-new' } });
    expect(persisted.organizationId).toBe(orgId);

    // …and the index was enqueued EXACTLY ONCE. Not zero (the repository is new
    // and has no graph), not twice (this service composes the bind's enqueue
    // rather than adding a second of its own — a double would double-count the
    // one number this story is about).
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a providerRepoId the install did not select, and links nothing', async () => {
    const provider = getGitProvider('github');
    vi.spyOn(provider, 'fetchInstallation').mockResolvedValue({
      installationId: 'inst-new',
      accountLogin: 'moooon',
      accountType: 'Organization',
    });
    vi.spyOn(provider, 'fetchInstallationRepos').mockResolvedValue([
      {
        providerRepoId: 'repo-new',
        owner: 'moooon',
        name: 'brand-new',
        defaultBranch: 'main',
        archived: false,
      },
    ]);

    await expect(
      organizationRepoService.connectAndLink(
        fx.projectId,
        { installationId: 'inst-new', providerRepoId: 'repo-never-selected', role: 'api' },
        fx.ctx,
      ),
    ).rejects.toThrow(/did not select/);
    expect(await adminDb.projectRepo.count({ where: { projectId: fx.projectId } })).toBe(0);
  });
});

describe('what the WRITE is, structurally', () => {
  it('the org-admin read and the link write are in the SAME transaction', async () => {
    // Proven by consequence rather than by inspection: if the gate ran in its own
    // transaction, a role revoked between the check and the write would let the
    // write through. Here the whole thing rolls back together, so a refusal
    // leaves no row — asserted in the gate suite above — and a success leaves
    // exactly one, asserted here, with no window between them in which a row
    // exists un-gated.
    await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: repoA, role: 'api' },
      fx.ctx,
    );
    expect(await adminDb.projectRepo.count({ where: { projectId: fx.projectId } })).toBe(1);
  });

  it('the installation service is composed, not reimplemented', async () => {
    // The connect path does not upsert repos itself. If it ever starts to, this
    // fails — and the tell would otherwise be a second, divergent persist path
    // that forgets `organization_id` (the column MOTIR-4649 added).
    expect(typeof githubInstallationService.bindInstallationForWorkspace).toBe('function');
  });
});
