import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// ORG-OWNED REPOSITORY ISOLATION — direct-DB RLS proof
// Story MOTIR-4669 · subtask MOTIR-4677.
//
// MOTIR-4649 put `organization_id` on `github_repo`; this suite proves the
// policies that read it. A repository is connected ONCE, to the ORGANISATION, so
// a `project_repository` row in workspace W2 referencing a repository connected
// from W1 must RESOLVE — and a reader in a DIFFERENT organisation must still see
// nothing.
//
// ⚠️ THE FIXTURE IS THE SUBSTANCE, and it is what makes these assertions mean
// anything. A test whose actor happens to see the whole population cannot
// distinguish a scoped read from an unscoped one — both return the same rows and
// both pass. So org TWO has repositories of its own: an empty result for it can
// never be mistaken for an empty table.
//
// ⚠️ And the failure direction is SILENT. A refused write throws and names its
// table; a denied read NARROWS, and a smaller count stays believable. Every
// assertion below therefore compares row IDENTITY, never a count alone.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as a superuser with
// BYPASSRLS, under which RLS is inert regardless of FORCE ROW LEVEL SECURITY.
// Every assertion runs inside a transaction that `SET LOCAL ROLE motir_app`.
// Without the role switch each one would assert the OPPOSITE of reality.

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface TwoOrgFixture {
  /** Organisation ONE: two workspaces, one repository connected from the first. */
  orgOneId: string;
  wsA1Id: string;
  wsA2Id: string;
  repoOneId: string;
  prOneId: string;
  checkOneId: string;
  /** Organisation TWO: its own workspace and its OWN repository. */
  orgTwoId: string;
  wsBId: string;
  repoTwoId: string;
  prTwoId: string;
}

/**
 * TWO organisations. Org one has TWO workspaces and ONE repository, connected
 * from the first of them; org two has its own workspace and its own repository.
 *
 * The three questions this shape can answer, and no smaller one can:
 *   * can W-A2 read a repository connected from W-A1? (the story)
 *   * can W-B read it? (the isolation the whole model rests on)
 *   * is W-B's empty result an empty TABLE, or a scoped read? (org two's own row)
 */
async function makeTwoOrgs(): Promise<TwoOrgFixture> {
  const userA = await usersService.createUser({
    email: 'org-rls-a@example.com',
    password: PASSWORD,
    name: 'A',
  });
  const userB = await usersService.createUser({
    email: 'org-rls-b@example.com',
    password: PASSWORD,
    name: 'B',
  });

  // Org ONE — the first workspace mints it; the second joins it explicitly.
  const { workspace: wsA1 } = await workspacesService.createWorkspace({
    name: 'Alpha one',
    ownerUserId: userA.id,
  });
  const orgOneId = (await adminDb.workspace.findUniqueOrThrow({ where: { id: wsA1.id } }))
    .organizationId;
  const { workspace: wsA2 } = await workspacesService.createWorkspace({
    name: 'Alpha two',
    ownerUserId: userA.id,
    organizationId: orgOneId,
  });

  // Org TWO — an independent tenant.
  const { workspace: wsB } = await workspacesService.createWorkspace({
    name: 'Bravo',
    ownerUserId: userB.id,
  });
  const orgTwoId = (await adminDb.workspace.findUniqueOrThrow({ where: { id: wsB.id } }))
    .organizationId;

  const instOne = await adminDb.githubInstallation.create({
    data: {
      installationId: 'org-rls-inst-one',
      workspaceId: wsA1.id,
      organizationId: orgOneId,
      accountLogin: 'alpha',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const instTwo = await adminDb.githubInstallation.create({
    data: {
      installationId: 'org-rls-inst-two',
      workspaceId: wsB.id,
      organizationId: orgTwoId,
      accountLogin: 'bravo',
      accountType: 'Organization',
      provider: 'github',
    },
  });

  const repoOne = await adminDb.githubRepo.create({
    data: {
      installationId: instOne.id,
      workspaceId: wsA1.id,
      organizationId: orgOneId,
      repoId: '920001',
      owner: 'alpha',
      name: 'alpha-shared',
      defaultBranch: 'main',
      archived: false,
    },
  });
  const repoTwo = await adminDb.githubRepo.create({
    data: {
      installationId: instTwo.id,
      workspaceId: wsB.id,
      organizationId: orgTwoId,
      repoId: '920002',
      owner: 'bravo',
      name: 'bravo-own',
      defaultBranch: 'main',
      archived: false,
    },
  });

  const prOne = await adminDb.githubPullRequest.create({
    data: { repoId: repoOne.id, number: 1, state: 'open', headRef: 'feat/alpha' },
  });
  const prTwo = await adminDb.githubPullRequest.create({
    data: { repoId: repoTwo.id, number: 1, state: 'open', headRef: 'feat/bravo' },
  });
  const checkOne = await adminDb.githubCheckRun.create({
    data: {
      pullRequestId: prOne.id,
      commitSha: 'a'.repeat(40),
      checkName: 'build',
      conclusion: 'success',
    },
  });

  return {
    orgOneId,
    wsA1Id: wsA1.id,
    wsA2Id: wsA2.id,
    repoOneId: repoOne.id,
    prOneId: prOne.id,
    checkOneId: checkOne.id,
    orgTwoId,
    wsBId: wsB.id,
    repoTwoId: repoTwo.id,
    prTwoId: prTwo.id,
  };
}

/** Run `fn` with the app GUCs bound and the non-BYPASSRLS role in force. */
async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string; organizationId?: string; systemAdmin?: boolean },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    if (ctx.organizationId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${ctx.organizationId}, true)`;
    }
    if (ctx.systemAdmin) {
      await tx.$executeRaw`SELECT set_config('app.system_admin', 'true', true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

describe('github_repo — the ORGANISATION can read, a different one cannot', () => {
  it('a SECOND workspace of the same organisation READS the repository', async () => {
    const fx = await makeTwoOrgs();
    // The story, in one assertion: W-A2 never connected this repository and holds
    // no row of its own for it. Before the org arm this returned nothing.
    const seen = await asAppRole({ workspaceId: fx.wsA2Id }, (tx) =>
      tx.githubRepo.findMany({ orderBy: { name: 'asc' } }),
    );
    expect(seen.map((r) => r.id)).toEqual([fx.repoOneId]);
  });

  it('a DIFFERENT organisation reads NOTHING of it — and its own row proves the table is not empty', async () => {
    const fx = await makeTwoOrgs();
    const seen = await asAppRole({ workspaceId: fx.wsBId }, (tx) =>
      tx.githubRepo.findMany({ orderBy: { name: 'asc' } }),
    );
    // Identity, not a count: org two sees exactly its OWN repository and not org
    // one's. An assertion of `length === 1` would pass on the wrong row.
    expect(seen.map((r) => r.id)).toEqual([fx.repoTwoId]);
    expect(seen.map((r) => r.id)).not.toContain(fx.repoOneId);
  });

  it('the connecting workspace still reads it — nothing admitted before is admitted less', async () => {
    const fx = await makeTwoOrgs();
    const seen = await asAppRole({ workspaceId: fx.wsA1Id }, (tx) => tx.githubRepo.findMany({}));
    expect(seen.map((r) => r.id)).toEqual([fx.repoOneId]);
  });

  it('an ORG-bound reader with no workspace sees the organisation’s repositories', async () => {
    const fx = await makeTwoOrgs();
    // `withOrgContext` binds no `app.workspace_id`, so this arm is the one that
    // carries it — and it is scoped just as tightly.
    const seenByOne = await asAppRole({ organizationId: fx.orgOneId }, (tx) =>
      tx.githubRepo.findMany({}),
    );
    expect(seenByOne.map((r) => r.id)).toEqual([fx.repoOneId]);

    const seenByTwo = await asAppRole({ organizationId: fx.orgTwoId }, (tx) =>
      tx.githubRepo.findMany({}),
    );
    expect(seenByTwo.map((r) => r.id)).toEqual([fx.repoTwoId]);
  });

  it('binds NOTHING → sees nothing (no USING clause falls back to permissive)', async () => {
    await makeTwoOrgs();
    const seen = await asAppRole({}, (tx) => tx.githubRepo.findMany({}));
    expect(seen).toEqual([]);
  });
});

describe('WRITES are unchanged — the org arm is FOR SELECT and nothing else', () => {
  // ⚠️ The reason this matters more than it looks: DELETE is authorised by
  // `USING` alone. Widening the existing `FOR ALL` policy in place would have
  // read as a read-only change and would have let a sibling workspace delete the
  // row. The arm is a separate `FOR SELECT` policy precisely so these three stay
  // refused.

  it('a sibling workspace of the SAME organisation cannot DELETE the repository', async () => {
    const fx = await makeTwoOrgs();
    const deleted = await asAppRole({ workspaceId: fx.wsA2Id }, (tx) =>
      tx.githubRepo.deleteMany({ where: { id: fx.repoOneId } }),
    );
    expect(deleted.count).toBe(0);
    // …and the row is still there, read back under a context that may see it.
    const still = await asAppRole({ workspaceId: fx.wsA1Id }, (tx) =>
      tx.githubRepo.findMany({ where: { id: fx.repoOneId } }),
    );
    expect(still).toHaveLength(1);
  });

  it('a sibling workspace cannot UPDATE it', async () => {
    const fx = await makeTwoOrgs();
    const updated = await asAppRole({ workspaceId: fx.wsA2Id }, (tx) =>
      tx.githubRepo.updateMany({ where: { id: fx.repoOneId }, data: { name: 'renamed' } }),
    );
    expect(updated.count).toBe(0);
    const still = await asAppRole({ workspaceId: fx.wsA1Id }, (tx) =>
      tx.githubRepo.findUniqueOrThrow({ where: { id: fx.repoOneId } }),
    );
    expect(still.name).toBe('alpha-shared');
  });

  it('a sibling workspace cannot INSERT a row carrying the OTHER workspace’s id', async () => {
    const fx = await makeTwoOrgs();
    const { installationId } = await adminDb.githubRepo.findUniqueOrThrow({
      where: { id: fx.repoOneId },
    });
    await expect(
      asAppRole({ workspaceId: fx.wsA2Id }, (tx) =>
        tx.githubRepo.create({
          data: {
            installationId,
            workspaceId: fx.wsA1Id,
            organizationId: fx.orgOneId,
            repoId: '920003',
            owner: 'alpha',
            name: 'smuggled',
            defaultBranch: 'main',
            archived: false,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('a DIFFERENT organisation cannot delete or update it either', async () => {
    const fx = await makeTwoOrgs();
    const deleted = await asAppRole({ workspaceId: fx.wsBId }, (tx) =>
      tx.githubRepo.deleteMany({ where: { id: fx.repoOneId } }),
    );
    const updated = await asAppRole({ workspaceId: fx.wsBId }, (tx) =>
      tx.githubRepo.updateMany({ where: { id: fx.repoOneId }, data: { name: 'x' } }),
    );
    expect(deleted.count).toBe(0);
    expect(updated.count).toBe(0);
  });
});

describe('the two policies that key THROUGH the repository', () => {
  it('github_pull_request — a sibling workspace reads the repository’s pull requests', async () => {
    const fx = await makeTwoOrgs();
    const seen = await asAppRole({ workspaceId: fx.wsA2Id }, (tx) =>
      tx.githubPullRequest.findMany({}),
    );
    // Without this arm the repository is visible and its pull requests are not —
    // a half-delivered model whose symptom is an empty Development panel.
    expect(seen.map((p) => p.id)).toEqual([fx.prOneId]);
  });

  it('github_pull_request — a different organisation sees only its OWN', async () => {
    const fx = await makeTwoOrgs();
    const seen = await asAppRole({ workspaceId: fx.wsBId }, (tx) =>
      tx.githubPullRequest.findMany({}),
    );
    expect(seen.map((p) => p.id)).toEqual([fx.prTwoId]);
    expect(seen.map((p) => p.id)).not.toContain(fx.prOneId);
  });

  it('github_check_run — a sibling workspace reads the CI verdict', async () => {
    const fx = await makeTwoOrgs();
    const seen = await asAppRole({ workspaceId: fx.wsA2Id }, (tx) =>
      tx.githubCheckRun.findMany({}),
    );
    expect(seen.map((c) => c.id)).toEqual([fx.checkOneId]);
  });

  it('github_check_run — a different organisation sees nothing of it', async () => {
    const fx = await makeTwoOrgs();
    const seen = await asAppRole({ workspaceId: fx.wsBId }, (tx) => tx.githubCheckRun.findMany({}));
    expect(seen.map((c) => c.id)).not.toContain(fx.checkOneId);
  });

  it('both fail closed with nothing bound', async () => {
    await makeTwoOrgs();
    expect(await asAppRole({}, (tx) => tx.githubPullRequest.findMany({}))).toEqual([]);
    expect(await asAppRole({}, (tx) => tx.githubCheckRun.findMany({}))).toEqual([]);
  });
});
