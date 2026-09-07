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
  // ⚠️ AMENDED BY MOTIR-4700, and the amendment is the deliverable rather than a
  // concession to it. This test used to insert `github_repo` rows with a NULL
  // organisation and assert the backfill statement resolved them. **That row is
  // no longer expressible**: `github_repo.organization_id` is NOT NULL, so
  // neither Prisma nor a raw INSERT can create one, which is exactly the
  // guarantee MOTIR-4700 ships. A constraint is strictly stronger than an
  // assertion that a repair statement works, so the repo half asserts the
  // RESOLUTION (every row lands on the right organisation, across two of them)
  // and the refusal is asserted in its own describe at the foot of this file.
  //
  // The INSTALLATION half is untouched and still runs the real predicate:
  // `github_installation.organization_id` stays nullable for the shared
  // provisioning row, so a null is still insertable there and the backfill
  // statement still has something to bite on.
  it('resolves every row through its workspace, across TWO organisations and THREE workspaces', async () => {
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
      // Stamped at insert, as every writer stamps it and as the constraint now
      // requires — the null this loop used to write is what MOTIR-4700 made
      // impossible.
      await adminDb.githubRepo.create({
        data: {
          installationId: inst.id,
          workspaceId,
          organizationId: expected[i]!,
          repoId: `repo-backfill-${i}`,
          owner: 'moooon',
          name: `repo-${i}`,
          defaultBranch: 'main',
          provider: 'github',
          archived: false,
        },
      });
    }

    // MOTIR-4700's migration re-runs this statement before the ALTER, so it is
    // still shipped and still worth exercising — it just cannot MATCH a row any
    // more. Running it here proves it is legal against the tightened column
    // (a `WHERE … IS NULL` against a NOT NULL column is valid SQL and touches
    // nothing), which is the property that lets the migration keep it as the
    // idempotent guard it is.
    const repoRowsRepaired = await adminDb.$executeRawUnsafe(`
      UPDATE "github_repo" AS r SET "organization_id" = w."organizationId"
        FROM "workspace" AS w
       WHERE w."id" = r."workspace_id" AND r."organization_id" IS NULL`);
    expect(repoRowsRepaired).toBe(0);
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

    // ZERO nulls on `github_repo` — asserted against the CATALOG rather than by
    // counting rows, because since MOTIR-4700 the count is zero for a reason no
    // fixture can influence. `is_nullable = 'NO'` is the claim; a row count would
    // pass just as well on a table that merely happens to have none.
    const columns = await adminDb.$queryRawUnsafe<{ is_nullable: string }[]>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'github_repo' AND column_name = 'organization_id'`,
    );
    expect(columns[0]?.is_nullable).toBe('NO');

    // The INSTALLATION column is still nullable, so its zero-null claim is still
    // a row count — scoped to rows that HAVE a workspace, for the
    // shared-provisioning row the scoping exists for (below).
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

// ─────────────────────────────────────────────────────────────────────────────
// MOTIR-4700 — the column is NOT NULL, and the DATABASE is what says so.
//
// MOTIR-4649 left `github_repo.organization_id` nullable for a DEPLOY WINDOW: a
// migration runs before the new pods serve, and a NOT NULL in that same
// migration would have failed every insert the OLD build attempted on the two
// unattended write paths above. That window is closed — production was read at
// `/api/health/release` and is serving MOTIR-4649's own merge commit — so the
// constraint lands.
//
// ⚠️ WHY THIS NEEDS ITS OWN ASSERTIONS AT ALL, given the writer tests above.
// Every claim made so far is a claim about CALLERS: the input type requires the
// field, `resolveOrganizationId` throws instead of returning null, and both are
// enforced by the type checker. None of them is a claim about the TABLE, and
// anything that is not a caller — a hand-run SQL fix, a restored backup, a
// future writer added without reading this file — is outside all of them. So the
// test has to reach the database WITHOUT going through the input type, which is
// what the raw statements below are for: a Prisma `create` cannot express the
// row this is about, because the client would refuse to compile it.
// ─────────────────────────────────────────────────────────────────────────────

/** An installation row to hang a raw repo insert off, so the FK is satisfied and
 *  the only thing under test is the null. */
async function installationFor(workspaceId: string, suffix: string): Promise<string> {
  const inst = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-notnull-${suffix}`,
      workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  return inst.id;
}

describe('github_repo.organization_id is NOT NULL — refused by the DATABASE, not by the input type', () => {
  it('REFUSES a raw insert that omits the column', async () => {
    const installationId = await installationFor(fx.workspaceId, 'refused');

    // Raw, deliberately: `githubRepoRepository.upsert` could not express this row
    // (`UpsertGithubRepoInput.organizationId` is a required `string`), so going
    // through it would test the type checker a second time and the constraint not
    // at all.
    await expect(
      adminDb.$executeRawUnsafe(
        `INSERT INTO "github_repo"
           ("id", "provider", "installation_id", "workspace_id", "repo_id",
            "owner", "name", "default_branch", "archived", "updated_at")
         VALUES ($1, 'github', $2, $3, 'r-no-org', 'moooon', 'no-org', 'main', false, NOW())`,
        'ghrepo_no_org_4700',
        installationId,
        fx.workspaceId,
      ),
    ).rejects.toThrow(/organization_id/);

    expect(await adminDb.githubRepo.count({ where: { repoId: 'r-no-org' } })).toBe(0);
  });

  it('ACCEPTS the same insert once the column is supplied — so the refusal is the null, not the statement', async () => {
    // The control. Without it the test above passes for any reason the INSERT
    // might fail (a column that does not exist, a typo in a name, an FK), and a
    // constraint nobody added would read exactly the same.
    const installationId = await installationFor(fx.workspaceId, 'accepted');

    await adminDb.$executeRawUnsafe(
      `INSERT INTO "github_repo"
         ("id", "provider", "installation_id", "workspace_id", "organization_id",
          "repo_id", "owner", "name", "default_branch", "archived", "updated_at")
       VALUES ($1, 'github', $2, $3, $4, 'r-with-org', 'moooon', 'with-org', 'main', false, NOW())`,
      'ghrepo_with_org_4700',
      installationId,
      fx.workspaceId,
      fx.workspace.organizationId,
    );

    const row = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: 'r-with-org' } });
    expect(row.organizationId).toBe(fx.workspace.organizationId);
  });
});

describe('github_installation.organization_id is UNTOUCHED — and stays nullable on purpose', () => {
  it('ACCEPTS an installation row with no organisation', async () => {
    // The negative half of MOTIR-4700, and it is a claim about the CURRENT world
    // rather than a prohibition: "this card does not tighten the other column"
    // is only true if the other column is still loose, and nothing else in this
    // suite would notice a migration that tightened both.
    //
    // The row this permits is Motir's SHARED PROVISIONING INSTALLATION
    // (MOTIR-1931): it serves N tenants and is owned by none, so it can name
    // neither a workspace nor an organisation. Its `workspace_id` is null for
    // exactly the same reason, and the two columns agreeing is what makes the
    // null readable rather than suspicious.
    await adminDb.$executeRawUnsafe(
      `INSERT INTO "github_installation"
         ("id", "provider", "installation_id", "account_login", "account_type", "updated_at")
       VALUES ($1, 'github', 'inst-raw-shared-4700', 'motir-projects', 'Organization', NOW())`,
      'ghinst_raw_shared_4700',
    );

    const row = await adminDb.githubInstallation.findFirstOrThrow({
      where: { installationId: 'inst-raw-shared-4700' },
    });
    expect(row.workspaceId).toBeNull();
    expect(row.organizationId).toBeNull();
  });

  it('the SHARED PROVISIONING installation still writes NULL on both tiers through the service', async () => {
    // The same guarantee through the path that actually writes it — the raw
    // insert above proves the column permits a null, this proves the writer still
    // produces one. MOTIR-4700 tightens the repository column and this is the
    // assertion that says it stopped there.
    const repo = await githubInstallationService.persistProvisionedRepo({
      workspaceId: fx.workspaceId,
      installation: {
        installationId: 'inst-shared-provisioning-4700',
        accountLogin: 'motir-projects',
        accountType: 'Organization',
      },
      repo: {
        providerRepoId: 'r-provisioned-4700',
        owner: 'motir-projects',
        name: 'provisioned-4700',
        defaultBranch: 'main',
        archived: false,
      },
    });

    // The REPOSITORY carries both tiers — which is exactly what lets its column
    // be NOT NULL while the installation's cannot be.
    expect(repo.organizationId).toBe(fx.workspace.organizationId);
    expect(repo.workspaceId).toBe(fx.workspaceId);

    const shared = await adminDb.githubInstallation.findFirstOrThrow({
      where: { installationId: 'inst-shared-provisioning-4700' },
    });
    expect(shared.workspaceId).toBeNull();
    expect(shared.organizationId).toBeNull();
  });
});
