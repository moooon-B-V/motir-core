import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { resolveOrganizationId } from '@/lib/github/resolveOrganizationId';
import { withSystemContext } from '@/lib/workspaces/context';

// THE REPOSITORY'S TENANCY MOVES TO THE ORGANISATION
// Story MOTIR-4669 · subtask MOTIR-4649.
//
// `github_installation` and `github_repo` gain `organization_id`. The column is
// the tier a repository is actually connected at: connected ONCE, to the
// organisation, with project membership as visibility configuration.
//
// This suite owns three things, and NOT the policies — rewriting
// `github_repo_workspace_or_system` and the two that key through it is
// MOTIR-4677's card, deliberately separate. A claim asserted in both places is a
// claim that can disagree with itself.
//
//   1. the backfill leaves ZERO rows null, across several organisations;
//   2. every WRITER stamps the column, so a row written between the deploy and
//      the backfill is not left null either — asserted on the two paths that run
//      UNATTENDED, which are the ones nobody is watching;
//   3. the ONE row that is legitimately null is the shared provisioning
//      installation, and it is null for the same reason its workspace is.
//
// Real Postgres, no mocks.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A second organisation with a workspace of its own — so "resolved through the
 *  workspace" is asserted against a fixture where the wrong answer is available. */
async function otherOrgWorkspace(): Promise<{ organizationId: string; workspaceId: string }> {
  const org = await adminDb.organization.create({
    data: { name: 'Other org', slug: `other-${Math.floor(Math.random() * 1_000_000)}` },
  });
  const ws = await adminDb.workspace.create({
    data: {
      organizationId: org.id,
      name: 'Other workspace',
      slug: `other-ws-${Math.floor(Math.random() * 1_000_000)}`,
    },
  });
  return { organizationId: org.id, workspaceId: ws.id };
}

describe('the backfill leaves ZERO rows null', () => {
  it('resolves every row through its workspace, across TWO organisations and THREE workspaces', async () => {
    // The card's own fixture shape. The migration has already run against this
    // database, so what is asserted here is the SQL's predicate rather than its
    // execution: a row inserted with a null organisation is resolved by exactly
    // the statement the migration ships.
    const orgA = { organizationId: fx.workspace.organizationId, workspaceId: fx.workspaceId };
    const orgB = await otherOrgWorkspace();
    const orgBSecond = await adminDb.workspace.create({
      data: {
        organizationId: orgB.organizationId,
        name: 'Other workspace 2',
        slug: `other-ws2-${Math.floor(Math.random() * 1_000_000)}`,
      },
    });

    const workspaces = [orgA.workspaceId, orgB.workspaceId, orgBSecond.id];
    const expected = [orgA.organizationId, orgB.organizationId, orgB.organizationId];

    for (const [i, workspaceId] of workspaces.entries()) {
      const inst = await adminDb.githubInstallation.create({
        data: {
          installationId: `inst-backfill-${i}`,
          workspaceId,
          accountLogin: 'moooon',
          accountType: 'Organization',
          provider: 'github',
        },
      });
      await adminDb.githubRepo.create({
        data: {
          installationId: inst.id,
          workspaceId,
          repoId: `repo-backfill-${i}`,
          owner: 'moooon',
          name: `repo-${i}`,
          defaultBranch: 'main',
          provider: 'github',
          archived: false,
        },
      });
    }

    // The migration's statement, verbatim in shape — idempotent on
    // `organization_id IS NULL`, joined through the workspace.
    await adminDb.$executeRawUnsafe(`
      UPDATE "github_repo" AS r SET "organization_id" = w."organizationId"
        FROM "workspace" AS w
       WHERE w."id" = r."workspace_id" AND r."organization_id" IS NULL`);
    await adminDb.$executeRawUnsafe(`
      UPDATE "github_installation" AS i SET "organization_id" = w."organizationId"
        FROM "workspace" AS w
       WHERE w."id" = i."workspace_id" AND i."organization_id" IS NULL`);

    for (const [i, workspaceId] of workspaces.entries()) {
      const repo = await adminDb.githubRepo.findFirstOrThrow({ where: { workspaceId } });
      const inst = await adminDb.githubInstallation.findFirstOrThrow({ where: { workspaceId } });
      expect(repo.organizationId, `repo ${i}`).toBe(expected[i]);
      expect(inst.organizationId, `installation ${i}`).toBe(expected[i]);
    }

    // ZERO nulls, scoped to rows that HAVE a workspace — see the shared-installation
    // case below for the one row this scoping exists for.
    expect(await adminDb.githubRepo.count({ where: { organizationId: null } })).toBe(0);
    expect(
      await adminDb.githubInstallation.count({
        where: { organizationId: null, NOT: { workspaceId: null } },
      }),
    ).toBe(0);
  });
});

describe('every WRITER stamps the column — a row written between deploy and backfill is not null', () => {
  it('the installation RECONCILE stamps both rows', async () => {
    // The unattended path: the App's `installation_repositories` delivery lands
    // here with no human watching, and it is the one most likely to insert during
    // a deploy window.
    await githubInstallationService.persistInstallation({
      workspaceId: fx.workspaceId,
      installation: {
        installationId: 'inst-reconcile',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: 'r-1',
          owner: 'moooon',
          name: 'reconciled',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });

    const inst = await adminDb.githubInstallation.findFirstOrThrow({
      where: { installationId: 'inst-reconcile' },
    });
    const repo = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: 'r-1' } });
    expect(inst.organizationId).toBe(fx.workspace.organizationId);
    expect(repo.organizationId).toBe(fx.workspace.organizationId);
  });

  it('the PROVISIONED-repo path stamps the repo, and leaves the SHARED installation null', async () => {
    // The second unattended writer, and the one that carries the exception. Motir's
    // shared provisioning installation serves N tenants and is owned by none of
    // them — it can name neither a workspace nor an organisation, and its NULL is
    // the honest value rather than a backfill gap. The REPOSITORY it holds still
    // carries both.
    const repo = await githubInstallationService.persistProvisionedRepo({
      workspaceId: fx.workspaceId,
      installation: {
        installationId: 'inst-shared-provisioning',
        accountLogin: 'motir-projects',
        accountType: 'Organization',
      },
      repo: {
        providerRepoId: 'r-provisioned',
        owner: 'motir-projects',
        name: 'provisioned',
        defaultBranch: 'main',
        archived: false,
      },
    });

    expect(repo.organizationId).toBe(fx.workspace.organizationId);
    expect(repo.workspaceId).toBe(fx.workspaceId);

    const shared = await adminDb.githubInstallation.findFirstOrThrow({
      where: { installationId: 'inst-shared-provisioning' },
    });
    // Both tiers null, together — the two columns say the same thing about this
    // row, which is what makes the null readable rather than suspicious.
    expect(shared.workspaceId).toBeNull();
    expect(shared.organizationId).toBeNull();
  });
});

describe('resolveOrganizationId', () => {
  it('resolves through the workspace', async () => {
    const resolved = await withSystemContext((tx) => resolveOrganizationId(fx.workspaceId, tx));
    expect(resolved).toBe(fx.workspace.organizationId);
  });

  it('resolves the RIGHT organisation when two exist', async () => {
    const other = await otherOrgWorkspace();
    const resolved = await withSystemContext((tx) => resolveOrganizationId(other.workspaceId, tx));
    expect(resolved).toBe(other.organizationId);
    expect(resolved).not.toBe(fx.workspace.organizationId);
  });

  it('THROWS on an unknown workspace rather than returning null', async () => {
    // Returning null here would let a mirror row be written with a null tenancy —
    // the state the column's nullability exists to permit for ONE row and no
    // other. A caller error must not be able to manufacture it.
    await expect(
      withSystemContext((tx) => resolveOrganizationId('ws_does_not_exist', tx)),
    ).rejects.toThrow(/no such workspace/);
  });
});

describe('what this card deliberately did NOT do', () => {
  it('leaves workspace_id in place and non-null on github_repo', async () => {
    // The tier a repository is connected FROM, and what the shipped RLS policies
    // still key on. MOTIR-4677 rewrites those; a card that moved the column AND
    // the policies would be untestable in the way that matters.
    await githubInstallationService.persistInstallation({
      workspaceId: fx.workspaceId,
      installation: {
        installationId: 'inst-keep-ws',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: 'r-keep',
          owner: 'moooon',
          name: 'keep',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    const repo = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: 'r-keep' } });
    expect(repo.workspaceId).toBe(fx.workspaceId);
    expect(repo.organizationId).toBe(fx.workspace.organizationId);
  });
});
