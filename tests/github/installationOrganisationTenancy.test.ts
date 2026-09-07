import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import type { NormalizedRepo } from '@/lib/git/types';

// THE INSTALLATION IS THE ORGANISATION'S — MOTIR-4836, the fifth arm of Story
// MOTIR-4669's tenancy move and the half that story did not ship.
//
// ⚠️ THE FIXTURE IS THE WHOLE POINT: ONE ORGANISATION, TWO WORKSPACES. Nothing
// in this file is expressible without it, and nothing that existed before this
// file could catch the defect, because until 2026-09-07 every organisation on
// the deployment had exactly one workspace — and with one workspace
// `workspace_id = app.workspace_id` and the organisation tier COINCIDE. A
// single-workspace fixture passes with the bug and without it, which is why the
// existing `github_installation RLS` suite (two workspaces in two DIFFERENT
// organisations) is green on both sides of this change and is not evidence
// about it.
//
// ⚠️ AND THERE ARE TWO INDEPENDENT CAUSES, so there are two independent halves
// below. Fixing either alone leaves the surface exactly as broken:
//
//   PART 1 · THE DATA — `github_installation` carried one policy,
//     `workspace_id = current_setting('app.workspace_id')`. NO policy on the
//     table read `app.organization_id`, so binding the organisation explicitly
//     admitted nothing either: measured on the live deployment, a sibling
//     workspace saw 0 installations and 7 of the organisation's repositories,
//     with or without the org GUC bound. That is why this needed a MIGRATION
//     and not a call-site fix.
//
//   PART 2 · THE QUERY — `getWorkspaceInstallation` is
//     `findByWorkspaceId(...)`, and the name is honest. It filters on
//     `workspace_id` in the SQL, so it would answer null from a sibling
//     workspace under ANY policy. Part 1 without Part 2 changes nothing a user
//     sees.
//
// The user-visible failure both halves produce is the reason it is a bug rather
// than a gap: Settings → Organisation → Git offered `Connect GitHub` for an
// account that is already installed. Most tenancy gaps show up as something
// ABSENT — an empty list, a count reading zero — which is confusing and honest.
// This one rendered a button, and the only way to test the claim was to accept
// the invitation and start an App installation flow for an account that has one.

const PASSWORD = 'hunter2hunter2';

const REPO_A: NormalizedRepo = {
  providerRepoId: '4836-a',
  owner: 'moooon',
  name: 'motir-core',
  defaultBranch: 'main',
  archived: false,
};

interface Fixture {
  userId: string;
  organizationId: string;
  /** The workspace the App was installed FROM. */
  installingWorkspaceId: string;
  /** Its SIBLING in the same organisation — created later, connects nothing. */
  siblingWorkspaceId: string;
}

/** One organisation, two workspaces, one owner who is a member of both. */
async function makeOrgWithTwoWorkspaces(email: string): Promise<Fixture> {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace: first } = await workspacesService.createWorkspace({
    name: 'Moooon',
    ownerUserId: user.id,
  });
  const { workspace: second } = await workspacesService.createWorkspace({
    name: 'Taq',
    ownerUserId: user.id,
    // THE ONE ARGUMENT THAT MAKES THIS FIXTURE DIFFERENT FROM EVERY OTHER ONE
    // IN THE SUITE — the second workspace joins the FIRST's organisation
    // instead of minting its own.
    organizationId: first.organizationId,
  });
  return {
    userId: user.id,
    organizationId: first.organizationId,
    installingWorkspaceId: first.id,
    siblingWorkspaceId: second.id,
  };
}

/**
 * Run `fn` as the non-bypass `motir_app` role with the request GUCs bound — the
 * role switch is what makes the policies actually bite. `organizationId` is
 * optional so both disjuncts of the new arm can be exercised separately: the
 * page's own service binds it explicitly, and `app_caller_organization_id()`
 * resolves it from the workspace when it is not bound.
 */
async function asAppRole<T>(
  ctx: { userId: string; workspaceId: string; organizationId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    if (ctx.organizationId) {
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${ctx.organizationId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

/** Every `github_installation` row the bound caller can SELECT. */
async function visibleInstallationIds(ctx: {
  userId: string;
  workspaceId: string;
  organizationId?: string;
}): Promise<string[]> {
  return asAppRole(ctx, async (tx) => {
    const rows = await tx.$queryRaw<{ installation_id: string }[]>`
      SELECT "installation_id" FROM "github_installation" ORDER BY "installation_id"
    `;
    return rows.map((r) => r.installation_id);
  });
}

let fx: Fixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeOrgWithTwoWorkspaces('org-tenancy-4836@example.com');
  await githubInstallationService.persistInstallation({
    workspaceId: fx.installingWorkspaceId,
    installation: {
      installationId: 'inst-4836-moooon',
      accountLogin: 'moooon-B-V',
      accountType: 'Organization',
    },
    repos: [REPO_A],
  });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── PART 1 · THE DATA — `github_installation_org_read` ───────────────────────

describe('the POLICY: a sibling workspace of the same organisation can READ the installation', () => {
  it('the installing workspace sees it — unchanged, and the control for everything below', () => {
    return expect(
      visibleInstallationIds({ userId: fx.userId, workspaceId: fx.installingWorkspaceId }),
    ).resolves.toEqual(['inst-4836-moooon']);
  });

  it('⚠️ the SIBLING workspace sees it — the defect, stated as the thing that is now false', async () => {
    // THIS IS THE REPRODUCTION. Before `github_installation_org_read` this
    // returned `[]`, because the table's only policy compared `workspace_id`
    // against the bound workspace and the sibling is a different workspace of
    // the same organisation. `app_caller_organization_id()` resolves the
    // organisation FROM the bound workspace, so this arm answers even with no
    // org GUC bound at all.
    await expect(
      visibleInstallationIds({ userId: fx.userId, workspaceId: fx.siblingWorkspaceId }),
    ).resolves.toEqual(['inst-4836-moooon']);
  });

  it('⚠️ …and with `app.organization_id` bound EXPLICITLY, which admitted nothing before', async () => {
    // The measurement that made this a migration rather than a call-site fix:
    // on the live deployment, binding the organisation explicitly still showed
    // the sibling ZERO installations, because no policy on this table read the
    // GUC. Both disjuncts of the arm are exercised, because the service binds
    // the organisation and the raw request context does not.
    await expect(
      visibleInstallationIds({
        userId: fx.userId,
        workspaceId: fx.siblingWorkspaceId,
        organizationId: fx.organizationId,
      }),
    ).resolves.toEqual(['inst-4836-moooon']);
  });

  it('⚠️ the SHARED PROVISIONING row stays invisible — MOTIR-1931`s disposition is preserved', async () => {
    // The half of `20260905214500`'s reasoning that was RIGHT, and it is right
    // still. `motir-projects` serves N tenants and is owned by none, so it
    // carries NULL on both tiers — and `NULL = anything` is NULL, so the org arm
    // refuses it exactly as the workspace policy did. The migration's mistake
    // was generalising from this row to the whole table, not describing it.
    await adminDb.$executeRawUnsafe(
      `INSERT INTO "github_installation"
         ("id", "provider", "installation_id", "account_login", "account_type", "updated_at")
       VALUES ($1, 'github', 'inst-4836-shared', 'motir-projects', 'Organization', NOW())`,
      'ghinst_shared_4836',
    );

    await expect(
      visibleInstallationIds({
        userId: fx.userId,
        workspaceId: fx.siblingWorkspaceId,
        organizationId: fx.organizationId,
      }),
    ).resolves.toEqual(['inst-4836-moooon']);
  });

  it('⚠️ ANOTHER organisation`s installation stays invisible — the arm widens by one tier, not two', async () => {
    // The arm's boundary, asserted rather than assumed: it admits the
    // ORGANISATION's rows and nothing beyond them. Without this the test above
    // would also pass under a policy that admitted everything.
    const other = await makeOrgWithTwoWorkspaces('other-org-4836@example.com');
    await githubInstallationService.persistInstallation({
      workspaceId: other.installingWorkspaceId,
      installation: {
        installationId: 'inst-4836-other',
        accountLogin: 'someone-else',
        accountType: 'Organization',
      },
      repos: [],
    });

    await expect(
      visibleInstallationIds({
        userId: fx.userId,
        workspaceId: fx.siblingWorkspaceId,
        organizationId: fx.organizationId,
      }),
    ).resolves.toEqual(['inst-4836-moooon']);
  });

  it('⚠️ the arm is FOR SELECT — a sibling workspace may READ the connection, never DELETE it', async () => {
    // `USING` authorises DELETE, so an org arm written `FOR ALL` would hand
    // every sibling workspace the ability to remove the organisation's GitHub
    // access. The row IS the connection, which is why this matters more here
    // than on the four tables armed before it. The `FOR ALL` policy still
    // compares `workspace_id`, so the delete matches nothing and removes
    // nothing — RLS narrows a DELETE rather than raising on it.
    const deleted = await asAppRole(
      { userId: fx.userId, workspaceId: fx.siblingWorkspaceId, organizationId: fx.organizationId },
      (tx) => tx.$executeRawUnsafe(`DELETE FROM "github_installation"`),
    );
    expect(deleted).toBe(0);

    const survivor = await adminDb.githubInstallation.findFirst({
      where: { installationId: 'inst-4836-moooon' },
    });
    expect(survivor).not.toBeNull();
  });
});

// ── PART 2 · THE QUERY — `listOrganizationInstallations` ─────────────────────

describe('the QUERY: the organisation surface asks the ORGANISATION`s question', () => {
  it('⚠️ `getWorkspaceInstallation` answers null from the sibling — honestly, and that is the point', async () => {
    // Pinned deliberately rather than deleted. The workspace read is not the
    // bug: it does exactly what its name says, and other callers legitimately
    // want it (a workspace's OWN grant). The bug was an ORGANISATION surface
    // asking it — so the fix is a second read, not a widened first one, and
    // this assertion is what keeps the two questions distinguishable.
    await expect(
      githubInstallationService.getWorkspaceInstallation({
        userId: fx.userId,
        workspaceId: fx.siblingWorkspaceId,
      }),
    ).resolves.toBeNull();
  });

  it('⚠️ `listOrganizationInstallations` finds it from the SIBLING — the call-site repro', async () => {
    const installations = await githubInstallationService.listOrganizationInstallations({
      userId: fx.userId,
      workspaceId: fx.siblingWorkspaceId,
    });

    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({
      installationId: 'inst-4836-moooon',
      accountLogin: 'moooon-B-V',
      accountType: 'Organization',
    });
    // The repositories come with it, which is what the page's connection card
    // and the `Manage on GitHub` link are built from.
    expect(installations[0]!.repos.map((r) => r.name)).toEqual(['motir-core']);
  });

  it('reads the same set from the INSTALLING workspace — the tier, not a redirection', async () => {
    const installations = await githubInstallationService.listOrganizationInstallations({
      userId: fx.userId,
      workspaceId: fx.installingWorkspaceId,
    });
    expect(installations.map((i) => i.installationId)).toEqual(['inst-4836-moooon']);
  });

  it('⚠️ returns BOTH when the organisation has two connections — it does not pick one', async () => {
    // The N > 1 disposition, which is reachable rather than theoretical: nothing
    // forbids two workspaces of one organisation each installing the App on a
    // DIFFERENT GitHub account, and `upsert` keys on `installation_id`. The
    // honest answer to "which one is the organisation's connection?" is then all
    // of them, so the read hands the caller the set and the page renders one row
    // per connection — the same row, repeated, never `rows[0]`.
    await githubInstallationService.persistInstallation({
      workspaceId: fx.siblingWorkspaceId,
      installation: {
        installationId: 'inst-4836-taq',
        accountLogin: 'taq-org',
        accountType: 'Organization',
      },
      repos: [],
    });

    const installations = await githubInstallationService.listOrganizationInstallations({
      userId: fx.userId,
      workspaceId: fx.siblingWorkspaceId,
    });
    expect(installations.map((i) => i.accountLogin)).toEqual(['moooon-B-V', 'taq-org']);
  });

  it('answers an EMPTY LIST for an organisation with no connection — the `Connect GitHub` state', async () => {
    // The state the page SHOULD have been in, and the one it wrongly showed.
    // Distinguishable from the defect only in a fixture where the organisation
    // genuinely has nothing.
    const bare = await makeOrgWithTwoWorkspaces('bare-org-4836@example.com');
    await expect(
      githubInstallationService.listOrganizationInstallations({
        userId: bare.userId,
        workspaceId: bare.siblingWorkspaceId,
      }),
    ).resolves.toEqual([]);
  });

  it('a GITLAB connection on the organisation never leaks into the GitHub read', async () => {
    // The same filter `findByWorkspaceId` carries, for the same reason: a GitLab
    // connection lives in this table too (MOTIR-1474), and the connection card
    // this feeds is the GitHub one.
    await adminDb.$executeRawUnsafe(
      `INSERT INTO "github_installation"
         ("id", "provider", "installation_id", "workspace_id", "organization_id",
          "account_login", "account_type", "updated_at")
       VALUES ($1, 'gitlab', 'conn-4836-gitlab', $2, $3, 'a-gitlab-group', 'Organization', NOW())`,
      'ghinst_gitlab_4836',
      fx.siblingWorkspaceId,
      fx.organizationId,
    );

    const installations = await githubInstallationService.listOrganizationInstallations({
      userId: fx.userId,
      workspaceId: fx.siblingWorkspaceId,
    });
    expect(installations.map((i) => i.installationId)).toEqual(['inst-4836-moooon']);
  });

  it('the repository read is deterministic — `created_at`, then `id`, carrying no preference', async () => {
    // A stable order is what keeps the connection card from reshuffling between
    // two reads of the same page. It is NOT a ranking: the oldest connection is
    // not the "real" one, it is merely first, and nothing downstream may treat
    // position as authority.
    const ids = await asAppRole(
      { userId: fx.userId, workspaceId: fx.siblingWorkspaceId, organizationId: fx.organizationId },
      async (tx) => {
        const rows = await githubInstallationRepository.listByOrganizationId(fx.organizationId, tx);
        return rows.map((r) => r.installationId);
      },
    );
    expect(ids).toEqual(['inst-4836-moooon']);
  });
});
