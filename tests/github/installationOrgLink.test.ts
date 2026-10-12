import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { githubInstallationOrgLinkRepository } from '@/lib/repositories/githubInstallationOrgLinkRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// ONE GITHUB ACCOUNT, MANY ORGANISATIONS — the data model (Story MOTIR-8216 ·
// MOTIR-8218), against a real Postgres.
//
// One GitHub installation can now be LINKED to several Motir organisations,
// each owning its own subset of that account's repositories, and the database
// refuses the same repository in two organisations. Every RLS assertion runs
// as the non-BYPASSRLS `motir_app` role (PRODECT_FINDINGS #5): the dev/CI
// connection is a superuser, under which RLS is inert.

const PASSWORD = 'hunter2hunter2';

const MIGRATION = path.join(
  process.cwd(),
  'prisma/migrations/20261011230000_github_installation_org_link/migration.sql',
);

/** The migration's own backfill statement, run as written — so the test proves
 *  the SQL that ships, not a paraphrase of it. */
function backfillSql(): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const match = sql.match(/INSERT INTO "github_installation_org_link"[\s\S]*?DO NOTHING;/);
  if (!match) throw new Error('backfill statement not found in the migration');
  return match[0];
}

beforeEach(async () => {
  await truncateAuthTables();
  // The shared provisioning installation has no workspace, so the workspace
  // CASCADE never reaches it.
  await adminDb.githubInstallation.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  orgOneId: string;
  wsOneId: string;
  orgTwoId: string;
  wsTwoId: string;
  /** One GitHub account's installation — owned (first) by org one. */
  installationId: string;
}

async function makeTwoOrgs(): Promise<Fixture> {
  const userOne = await usersService.createUser({
    email: 'link-one@example.com',
    password: PASSWORD,
    name: 'One',
  });
  const userTwo = await usersService.createUser({
    email: 'link-two@example.com',
    password: PASSWORD,
    name: 'Two',
  });
  const { workspace: wsOne } = await workspacesService.createWorkspace({
    name: 'One',
    ownerUserId: userOne.id,
  });
  const { workspace: wsTwo } = await workspacesService.createWorkspace({
    name: 'Two',
    ownerUserId: userTwo.id,
  });
  const orgOneId = (await adminDb.workspace.findUniqueOrThrow({ where: { id: wsOne.id } }))
    .organizationId;
  const orgTwoId = (await adminDb.workspace.findUniqueOrThrow({ where: { id: wsTwo.id } }))
    .organizationId;
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: 'link-inst-1',
      workspaceId: wsOne.id,
      organizationId: orgOneId,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  return {
    orgOneId,
    wsOneId: wsOne.id,
    orgTwoId,
    wsTwoId: wsTwo.id,
    installationId: installation.id,
  };
}

function repoData(
  installationId: string,
  workspaceId: string,
  organizationId: string,
  repoId: string,
  provider = 'github',
) {
  return {
    installationId,
    workspaceId,
    organizationId,
    repoId,
    provider,
    owner: 'acme',
    name: `repo-${repoId}`,
    defaultBranch: 'main',
  };
}

async function asAppRole<T>(
  ctx: { workspaceId?: string; organizationId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    if (ctx.organizationId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${ctx.organizationId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

describe('the backfill — every existing tenant installation keeps its organisation', () => {
  it('links a tenant installation to its own organisation, links the shared one to nobody, and is idempotent', async () => {
    const fx = await makeTwoOrgs();
    const shared = await adminDb.githubInstallation.create({
      data: {
        installationId: 'link-shared',
        workspaceId: null,
        organizationId: null,
        accountLogin: 'motir-projects',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const gitlab = await adminDb.githubInstallation.create({
      data: {
        installationId: 'link-gitlab',
        workspaceId: fx.wsTwoId,
        organizationId: fx.orgTwoId,
        accountLogin: 'acme-gl',
        accountType: 'Group',
        provider: 'gitlab',
      },
    });

    await adminDb.$executeRawUnsafe(backfillSql());
    await adminDb.$executeRawUnsafe(backfillSql());

    const links = await adminDb.githubInstallationOrgLink.findMany();
    expect(links.map((l) => [l.installationId, l.organizationId, l.workspaceId])).toEqual([
      [fx.installationId, fx.orgOneId, fx.wsOneId],
    ]);
    expect(links.map((l) => l.installationId)).not.toContain(shared.id);
    expect(links.map((l) => l.installationId)).not.toContain(gitlab.id);
  });
});

describe('one organisation per repository — enforced by the database', () => {
  it('refuses a second organisation claiming a repository another organisation owns', async () => {
    const fx = await makeTwoOrgs();
    await adminDb.githubRepo.create({
      data: repoData(fx.installationId, fx.wsOneId, fx.orgOneId, '7001'),
    });
    const other = await adminDb.githubInstallation.create({
      data: {
        installationId: 'link-inst-2',
        workspaceId: fx.wsTwoId,
        organizationId: fx.orgTwoId,
        accountLogin: 'acme',
        accountType: 'Organization',
        provider: 'github',
      },
    });

    await expect(
      adminDb.githubRepo.create({ data: repoData(other.id, fx.wsTwoId, fx.orgTwoId, '7001') }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('refuses it under the claimant tenant’s own RLS context too — the guard sees the row the caller cannot, and restores the caller’s setting', async () => {
    const fx = await makeTwoOrgs();
    await adminDb.githubRepo.create({
      data: repoData(fx.installationId, fx.wsOneId, fx.orgOneId, '7002'),
    });
    const other = await adminDb.githubInstallation.create({
      data: {
        installationId: 'link-inst-3',
        workspaceId: fx.wsTwoId,
        organizationId: fx.orgTwoId,
        accountLogin: 'acme',
        accountType: 'Organization',
        provider: 'github',
      },
    });

    await expect(
      asAppRole({ workspaceId: fx.wsTwoId }, (tx) =>
        tx.githubRepo.create({ data: repoData(other.id, fx.wsTwoId, fx.orgTwoId, '7002') }),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });

    // A successful insert leaves the caller exactly as bound: no system escape.
    const after = await asAppRole({ workspaceId: fx.wsTwoId }, async (tx) => {
      await tx.githubRepo.create({ data: repoData(other.id, fx.wsTwoId, fx.orgTwoId, '7003') });
      const [row] = await tx.$queryRaw<{ v: string | null }[]>`
        SELECT current_setting('app.system_admin', true) AS v`;
      return row?.v ?? null;
    });
    expect(after === null || after === '').toBe(true);
  });

  it('allows the same repository twice in ONE organisation — the takeover shape', async () => {
    const fx = await makeTwoOrgs();
    const shared = await adminDb.githubInstallation.create({
      data: {
        installationId: 'link-shared-2',
        workspaceId: null,
        organizationId: null,
        accountLogin: 'motir-projects',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    await adminDb.githubRepo.create({ data: repoData(shared.id, fx.wsOneId, fx.orgOneId, '7004') });
    await adminDb.githubRepo.create({
      data: repoData(fx.installationId, fx.wsOneId, fx.orgOneId, '7004'),
    });

    const rows = await withSystemContext((tx) =>
      githubRepoRepository.findByHostRepoId('github', '7004', tx),
    );
    expect(rows.map((r) => r.organizationId)).toEqual([fx.orgOneId, fx.orgOneId]);
  });

  it('refuses re-stamping a repository’s organisation in place', async () => {
    const fx = await makeTwoOrgs();
    const repo = await adminDb.githubRepo.create({
      data: repoData(fx.installationId, fx.wsOneId, fx.orgOneId, '7005'),
    });
    await expect(
      adminDb.githubRepo.update({ where: { id: repo.id }, data: { organizationId: fx.orgTwoId } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('does not guard GitLab projects, whose ids are per-instance', async () => {
    const fx = await makeTwoOrgs();
    const glOne = await adminDb.githubInstallation.create({
      data: {
        installationId: 'gl-1',
        workspaceId: fx.wsOneId,
        organizationId: fx.orgOneId,
        accountLogin: 'a',
        accountType: 'Group',
        provider: 'gitlab',
      },
    });
    const glTwo = await adminDb.githubInstallation.create({
      data: {
        installationId: 'gl-2',
        workspaceId: fx.wsTwoId,
        organizationId: fx.orgTwoId,
        accountLogin: 'b',
        accountType: 'Group',
        provider: 'gitlab',
      },
    });
    await adminDb.githubRepo.create({
      data: repoData(glOne.id, fx.wsOneId, fx.orgOneId, '7006', 'gitlab'),
    });
    await expect(
      adminDb.githubRepo.create({
        data: repoData(glTwo.id, fx.wsTwoId, fx.orgTwoId, '7006', 'gitlab'),
      }),
    ).resolves.toBeTruthy();
  });
});

describe('githubInstallationOrgLinkRepository', () => {
  it('links one installation to two organisations, idempotently, and keeps the pair unique', async () => {
    const fx = await makeTwoOrgs();
    await withSystemContext(async (tx) => {
      await githubInstallationOrgLinkRepository.upsert(
        { installationId: fx.installationId, organizationId: fx.orgOneId, workspaceId: fx.wsOneId },
        tx,
      );
      await githubInstallationOrgLinkRepository.upsert(
        { installationId: fx.installationId, organizationId: fx.orgTwoId, workspaceId: fx.wsTwoId },
        tx,
      );
      await githubInstallationOrgLinkRepository.upsert(
        { installationId: fx.installationId, organizationId: fx.orgTwoId, workspaceId: fx.wsTwoId },
        tx,
      );
    });

    const { links, count, mine } = await withSystemContext(async (tx) => ({
      links: await githubInstallationOrgLinkRepository.listByInstallationId(fx.installationId, tx),
      count: await githubInstallationOrgLinkRepository.countByInstallationId(fx.installationId, tx),
      mine: await githubInstallationOrgLinkRepository.listByOrganizationId(fx.orgTwoId, tx),
    }));
    expect(links.map((l) => l.organizationId)).toEqual([fx.orgOneId, fx.orgTwoId]);
    expect(count).toBe(2);
    expect(mine.map((l) => l.installation.installationId)).toEqual(['link-inst-1']);

    await expect(
      adminDb.githubInstallationOrgLink.create({
        data: {
          installationId: fx.installationId,
          organizationId: fx.orgOneId,
          workspaceId: fx.wsOneId,
        },
      }),
    ).rejects.toThrow();
  });

  it('a per-organisation removal takes that organisation’s link and repositories and leaves the other’s', async () => {
    const fx = await makeTwoOrgs();
    await withSystemContext(async (tx) => {
      for (const [org, ws] of [
        [fx.orgOneId, fx.wsOneId],
        [fx.orgTwoId, fx.wsTwoId],
      ] as const) {
        await githubInstallationOrgLinkRepository.upsert(
          { installationId: fx.installationId, organizationId: org, workspaceId: ws },
          tx,
        );
      }
    });
    // One account, one installation, two organisations, disjoint subsets.
    await adminDb.githubRepo.create({
      data: repoData(fx.installationId, fx.wsOneId, fx.orgOneId, '8001'),
    });
    await adminDb.githubRepo.create({
      data: repoData(fx.installationId, fx.wsTwoId, fx.orgTwoId, '8002'),
    });
    await adminDb.githubRepo.create({
      data: repoData(fx.installationId, fx.wsTwoId, fx.orgTwoId, '8003'),
    });

    const removed = await withSystemContext(async (tx) => ({
      repos: await githubRepoRepository.deleteByInstallationAndOrg(
        fx.installationId,
        fx.orgTwoId,
        tx,
      ),
      links: await githubInstallationOrgLinkRepository.deleteByInstallationAndOrg(
        fx.installationId,
        fx.orgTwoId,
        tx,
      ),
      again: await githubInstallationOrgLinkRepository.deleteByInstallationAndOrg(
        fx.installationId,
        fx.orgTwoId,
        tx,
      ),
    }));
    expect(removed).toEqual({ repos: 2, links: 1, again: 0 });

    const left = await withSystemContext(async (tx) => ({
      one: await githubRepoRepository.listByInstallationAndOrg(fx.installationId, fx.orgOneId, tx),
      two: await githubRepoRepository.listByInstallationAndOrg(fx.installationId, fx.orgTwoId, tx),
      link: await githubInstallationOrgLinkRepository.findByInstallationAndOrg(
        fx.installationId,
        fx.orgOneId,
        tx,
      ),
    }));
    expect(left.one.map((r) => r.repoId)).toEqual(['8001']);
    expect(left.two).toEqual([]);
    expect(left.link?.organizationId).toBe(fx.orgOneId);
  });

  it('deleting the installation cascades its links', async () => {
    const fx = await makeTwoOrgs();
    await withSystemContext((tx) =>
      githubInstallationOrgLinkRepository.upsert(
        { installationId: fx.installationId, organizationId: fx.orgTwoId, workspaceId: fx.wsTwoId },
        tx,
      ),
    );
    await adminDb.githubInstallation.delete({ where: { id: fx.installationId } });
    expect(await adminDb.githubInstallationOrgLink.count()).toBe(0);
  });
});

describe('github_installation_org_link — row-level security', () => {
  async function linkedBoth(fx: Fixture) {
    await withSystemContext(async (tx) => {
      await githubInstallationOrgLinkRepository.upsert(
        { installationId: fx.installationId, organizationId: fx.orgOneId, workspaceId: fx.wsOneId },
        tx,
      );
      await githubInstallationOrgLinkRepository.upsert(
        { installationId: fx.installationId, organizationId: fx.orgTwoId, workspaceId: fx.wsTwoId },
        tx,
      );
    });
  }

  it('an organisation reads its own link and never another organisation’s', async () => {
    const fx = await makeTwoOrgs();
    await linkedBoth(fx);
    const seenByTwo = await asAppRole({ organizationId: fx.orgTwoId }, (tx) =>
      tx.githubInstallationOrgLink.findMany(),
    );
    expect(seenByTwo.map((l) => l.organizationId)).toEqual([fx.orgTwoId]);
    const seenByWsOne = await asAppRole({ workspaceId: fx.wsOneId }, (tx) =>
      tx.githubInstallationOrgLink.findMany(),
    );
    expect(seenByWsOne.map((l) => l.organizationId)).toEqual([fx.orgOneId]);
  });

  it('an unbound read sees nothing, and a tenant cannot write a link', async () => {
    const fx = await makeTwoOrgs();
    await linkedBoth(fx);
    expect(await asAppRole({}, (tx) => tx.githubInstallationOrgLink.findMany())).toEqual([]);
    await expect(
      asAppRole({ workspaceId: fx.wsTwoId, organizationId: fx.orgTwoId }, (tx) =>
        tx.githubInstallationOrgLink.deleteMany({}),
      ),
    ).resolves.toEqual({ count: 0 });
    await expect(
      asAppRole({ workspaceId: fx.wsTwoId, organizationId: fx.orgTwoId }, (tx) =>
        tx.githubInstallationOrgLink.create({
          data: {
            installationId: fx.installationId,
            organizationId: fx.orgTwoId,
            workspaceId: fx.wsTwoId,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
