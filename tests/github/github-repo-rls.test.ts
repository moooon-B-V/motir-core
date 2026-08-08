import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { truncateAuthTables } from '../helpers/db';

// `github_repo` isolation — direct-DB RLS proof (MOTIR-1931), the tenancy half of
// this card's acceptance: "a repo mirrored under Motir's SHARED provisioning
// installation is visible to the workspace that owns it, and to no other."
//
// Mirrors tests/projectRepos/project-repo-rls.test.ts for the policy this card
// rewrites. The scenario is the one the shipped policy could not express: ONE
// installation, bound to NO workspace, holding TWO tenants' repos.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser, which has BYPASSRLS — RLS is inert under it regardless of FORCE ROW
// LEVEL SECURITY. Every assertion below therefore runs inside a transaction that
// `SET LOCAL ROLE prodect_app`. WITHOUT the role switch each assertion would
// assert the OPPOSITE of reality. The role reverts at txn end. `asAppRole` is
// intentionally a local copy of the helper in project-rls.test.ts /
// project-repo-rls.test.ts — see those files for why it is not hoisted yet.
//
// The policy under test (20260731160000_github_repo_workspace_tenancy):
// `github_repo_workspace_or_system`, USING + WITH CHECK both
// `system_admin OR "workspace_id" = current_setting('app.workspace_id', true)`.
// It replaces a predicate that joined through `github_installation.workspace_id`,
// which for a shared installation resolved to NULL and hid every tenant's created
// repos from everyone. So:
//   * with no GUC bound the predicate is NULL → every row hidden (the safe failure);
//   * SELECT under workspace-A's GUC hides B's row (USING) and SHOWS A's — the
//     half the old policy got wrong for a shared installation;
//   * UPDATE/DELETE of B's row from A's GUC matches zero rows → P2025;
//   * INSERT carrying workspace_id = B from A's GUC fails WITH CHECK → 42501;
//   * the `app.system_admin` escape still sees both (the webhook's read path).
// `github_pull_request` (and `github_check_run` behind it) join through the repo
// row's own `workspace_id` now, so the same isolation reaches them.

const PASSWORD = 'hunter2hunter2';
const SHARED_INSTALLATION_ID = 'motir-provisioning-rls';
const MOTIR_ORG = 'motir-projects';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface SharedMirrorFixture {
  workspaceAId: string;
  workspaceBId: string;
  repoAId: string;
  repoBId: string;
  prAId: string;
  installationRowId: string;
}

/**
 * Two independent tenants whose repos live behind ONE installation that belongs
 * to NEITHER of them — the provisioning-org shape. Setup runs as the superuser
 * (BYPASSRLS), which is fine: the assertions are what run as `prodect_app`.
 */
async function makeSharedMirror(): Promise<SharedMirrorFixture> {
  const userA = await usersService.createUser({
    email: 'rls-a@example.com',
    password: PASSWORD,
    name: 'A',
  });
  const userB = await usersService.createUser({
    email: 'rls-b@example.com',
    password: PASSWORD,
    name: 'B',
  });
  const { workspace: wsA } = await workspacesService.createWorkspace({
    name: 'Alpha',
    ownerUserId: userA.id,
  });
  const { workspace: wsB } = await workspacesService.createWorkspace({
    name: 'Bravo',
    ownerUserId: userB.id,
  });

  const installation = await db.githubInstallation.create({
    data: {
      installationId: SHARED_INSTALLATION_ID,
      // The shared provisioning installation is owned by no tenant.
      workspaceId: null,
      accountLogin: MOTIR_ORG,
      accountType: 'Organization',
      provider: 'github',
    },
  });

  const repoA = await db.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: wsA.id,
      repoId: '910001',
      owner: MOTIR_ORG,
      name: 'alpha-web',
      defaultBranch: 'main',
      archived: false,
    },
  });
  const repoB = await db.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: wsB.id,
      repoId: '910002',
      owner: MOTIR_ORG,
      name: 'bravo-web',
      defaultBranch: 'main',
      archived: false,
    },
  });
  const prA = await db.githubPullRequest.create({
    data: { repoId: repoA.id, number: 1, state: 'open', headRef: 'feat/x' },
  });

  return {
    workspaceAId: wsA.id,
    workspaceBId: wsB.id,
    repoAId: repoA.id,
    repoBId: repoB.id,
    prAId: prA.id,
    installationRowId: installation.id,
  };
}

/** Run `fn` with the app GUCs bound and the non-BYPASSRLS role in force. */
async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string; systemAdmin?: boolean },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    if (ctx.systemAdmin) {
      await tx.$executeRaw`SELECT set_config('app.system_admin', 'true', true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

describe('github_repo RLS — a shared installation, two tenants', () => {
  it('shows each workspace its OWN created repo and hides the other’s', async () => {
    const fx = await makeSharedMirror();

    const seenByA = await asAppRole({ workspaceId: fx.workspaceAId }, (tx) =>
      tx.githubRepo.findMany({ orderBy: { name: 'asc' } }),
    );
    // The half the OLD policy got wrong: A's own created repo was invisible to A,
    // because the policy joined through an installation bound to nobody.
    expect(seenByA.map((r) => r.name)).toEqual(['alpha-web']);

    const seenByB = await asAppRole({ workspaceId: fx.workspaceBId }, (tx) =>
      tx.githubRepo.findMany({ orderBy: { name: 'asc' } }),
    );
    expect(seenByB.map((r) => r.name)).toEqual(['bravo-web']);
  });

  it('hides every row when no workspace GUC is bound (the safe failure)', async () => {
    await makeSharedMirror();
    const seen = await asAppRole({}, (tx) => tx.githubRepo.findMany({}));
    expect(seen).toEqual([]);
  });

  it('lets the system escape see both — the webhook’s read path', async () => {
    await makeSharedMirror();
    const seen = await asAppRole({ systemAdmin: true }, (tx) =>
      tx.githubRepo.findMany({ orderBy: { name: 'asc' } }),
    );
    expect(seen.map((r) => r.name)).toEqual(['alpha-web', 'bravo-web']);
  });

  it('refuses to UPDATE or DELETE another tenant’s repo row', async () => {
    const fx = await makeSharedMirror();

    await expect(
      asAppRole({ workspaceId: fx.workspaceAId }, (tx) =>
        tx.githubRepo.update({ where: { id: fx.repoBId }, data: { name: 'stolen' } }),
      ),
    ).rejects.toMatchObject({ code: 'P2025' });

    await expect(
      asAppRole({ workspaceId: fx.workspaceAId }, (tx) =>
        tx.githubRepo.delete({ where: { id: fx.repoBId } }),
      ),
    ).rejects.toMatchObject({ code: 'P2025' });

    // B's row is intact.
    await expect(db.githubRepo.findUnique({ where: { id: fx.repoBId } })).resolves.toMatchObject({
      name: 'bravo-web',
    });
  });

  it('refuses an INSERT that tenants a row to another workspace (WITH CHECK)', async () => {
    const fx = await makeSharedMirror();

    await expect(
      asAppRole({ workspaceId: fx.workspaceAId }, (tx) =>
        tx.githubRepo.create({
          data: {
            installationId: fx.installationRowId,
            workspaceId: fx.workspaceBId,
            repoId: '910003',
            owner: MOTIR_ORG,
            name: 'planted',
            defaultBranch: 'main',
            archived: false,
          },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('refuses to RE-TENANT one’s own row to another workspace (WITH CHECK)', async () => {
    const fx = await makeSharedMirror();

    await expect(
      asAppRole({ workspaceId: fx.workspaceAId }, (tx) =>
        tx.githubRepo.update({
          where: { id: fx.repoAId },
          data: { workspaceId: fx.workspaceBId },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('github_pull_request RLS follows the repo row, not the installation', () => {
  it('shows the PR to the repo’s owning workspace and hides it from the other', async () => {
    const fx = await makeSharedMirror();

    const seenByA = await asAppRole({ workspaceId: fx.workspaceAId }, (tx) =>
      tx.githubPullRequest.findMany({}),
    );
    expect(seenByA.map((p) => p.id)).toEqual([fx.prAId]);

    const seenByB = await asAppRole({ workspaceId: fx.workspaceBId }, (tx) =>
      tx.githubPullRequest.findMany({}),
    );
    expect(seenByB).toEqual([]);
  });
});

describe('github_installation RLS — the shared row belongs to no tenant', () => {
  it('is invisible to every workspace and visible only under the system escape', async () => {
    const fx = await makeSharedMirror();

    // No policy change was needed here: `NULL = current_setting(...)` is NULL, so
    // the shared row simply never matches a tenant predicate. Asserted because
    // that posture is load-bearing, not incidental.
    const seenByA = await asAppRole({ workspaceId: fx.workspaceAId }, (tx) =>
      tx.githubInstallation.findMany({}),
    );
    expect(seenByA).toEqual([]);

    const seenBySystem = await asAppRole({ systemAdmin: true }, (tx) =>
      tx.githubInstallation.findMany({}),
    );
    expect(seenBySystem.map((i) => i.installationId)).toEqual([SHARED_INSTALLATION_ID]);
  });
});
