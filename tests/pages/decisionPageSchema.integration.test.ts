import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  createPage,
  emptyState,
  markdownToUpdate,
  pageStoreFor,
  savePageUpdate,
  systemClock,
} from '@/lib/pages';
import { decisionPagePublicationRepository } from '@/lib/repositories/decisionPagePublicationRepository';
import { pageVersionRepository } from '@/lib/repositories/pageVersionRepository';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The DECISION-PAGE schema on real Postgres (Story MOTIR-5761 · MOTIR-7428;
// `docs/decisions/pages.md` AMENDMENT 3, `approval-gates.md` §8 NINTH
// AMENDMENT): the two marks on `page_version` and their CHECK, the publication
// table's cotenancy trigger, and the repository methods that seal, freeze, read
// and prune around the marks.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const inTenant = <T>(projectId: string, fn: Parameters<typeof withWorkspaceContext<T>>[1]) =>
  withWorkspaceContext({ userId: fx.ownerId, workspaceId: fx.workspaceId, projectId }, fn);

const newPage = (projectId = fx.projectId) =>
  inTenant(projectId, (tx) =>
    createPage(pageStoreFor(tx), systemClock, {
      workspaceId: fx.workspaceId,
      projectId,
      actorId: fx.ownerId,
    }),
  );

const firstVersion = (pageId: string) =>
  adminDb.pageVersion.findFirstOrThrow({ where: { pageId, number: 1 } });

async function addVersion(pageId: string, number: number) {
  const v1 = await firstVersion(pageId);
  return adminDb.pageVersion.create({
    data: {
      workspaceId: v1.workspaceId,
      projectId: v1.projectId,
      pageId,
      number,
      authorId: fx.ownerId,
      bodyState: v1.bodyState,
      bodyMarkdown: `v${number}`,
      startedAt: new Date(number * 1000),
      savedAt: new Date(number * 1000),
    },
  });
}

const decisionCard = () =>
  workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Decide', type: 'decision' },
    fx.ctx,
  );

async function gateOn(workItemId: string) {
  return adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId,
      kind: 'decision_approval',
      subjectId: workItemId,
    },
  });
}

describe('page_version marks', () => {
  it('a version written before this migration reads both marks null', async () => {
    const page = await newPage();
    const v1 = await inTenant(fx.projectId, async (tx) =>
      pageVersionRepository.findVersionById((await firstVersion(page.id)).id, tx),
    );
    expect(v1).toMatchObject({ number: 1, sealedAt: null, frozenAt: null, frozenByGateId: null });
    expect(v1!.bodyMarkdown).toBe('');
  });

  it('sealVersion stamps once and keeps the first sealed_at; it answers false for a missing id', async () => {
    const page = await newPage();
    const v1 = await firstVersion(page.id);
    const first = new Date('2026-10-03T10:00:00Z');
    expect(
      await inTenant(fx.projectId, (tx) => pageVersionRepository.sealVersion(v1.id, first, tx)),
    ).toBe(true);
    expect(
      await inTenant(fx.projectId, (tx) =>
        pageVersionRepository.sealVersion(v1.id, new Date('2026-10-04T00:00:00Z'), tx),
      ),
    ).toBe(true);
    expect((await firstVersion(page.id)).sealedAt).toEqual(first);
    expect(
      await inTenant(fx.projectId, (tx) => pageVersionRepository.sealVersion('nope', first, tx)),
    ).toBe(false);
  });

  it('freezeVersion on an UNSEALED version violates the CHECK', async () => {
    const page = await newPage();
    const v1 = await firstVersion(page.id);
    const gate = await gateOn((await decisionCard()).id);
    await expect(
      inTenant(fx.projectId, (tx) =>
        pageVersionRepository.freezeVersion(v1.id, gate.id, new Date(), tx),
      ),
    ).rejects.toThrow(/page_version_frozen_requires_sealed/);
  });

  it('freezeVersion on a sealed version records the gate, and hasFrozenVersion / anyFrozenVersion see it', async () => {
    const page = await newPage();
    const other = await newPage();
    const v1 = await firstVersion(page.id);
    const gate = await gateOn((await decisionCard()).id);
    const at = new Date('2026-10-03T11:00:00Z');
    await inTenant(fx.projectId, async (tx) => {
      await pageVersionRepository.sealVersion(v1.id, at, tx);
      await pageVersionRepository.freezeVersion(v1.id, gate.id, at, tx);
    });
    expect(await firstVersion(page.id)).toMatchObject({ frozenAt: at, frozenByGateId: gate.id });
    await inTenant(fx.projectId, async (tx) => {
      expect(await pageVersionRepository.hasFrozenVersion(page.id, tx)).toBe(true);
      expect(await pageVersionRepository.hasFrozenVersion(other.id, tx)).toBe(false);
      expect(await pageVersionRepository.anyFrozenVersion([other.id, page.id], tx)).toBe(page.id);
      expect(await pageVersionRepository.anyFrozenVersion([other.id], tx)).toBeNull();
      expect(await pageVersionRepository.anyFrozenVersion([], tx)).toBeNull();
    });
  });

  it('deleteOldestUnmarked never deletes a sealed or frozen version, and may keep more than `keep`', async () => {
    const page = await newPage();
    for (let n = 2; n <= 6; n += 1) await addVersion(page.id, n);
    const byNumber = async (n: number) =>
      adminDb.pageVersion.findFirstOrThrow({ where: { pageId: page.id, number: n } });
    const gate = await gateOn((await decisionCard()).id);
    const at = new Date();
    await inTenant(fx.projectId, async (tx) => {
      await pageVersionRepository.sealVersion((await byNumber(1)).id, at, tx);
      await pageVersionRepository.sealVersion((await byNumber(2)).id, at, tx);
      await pageVersionRepository.freezeVersion((await byNumber(2)).id, gate.id, at, tx);
    });

    // 6 versions, keep 3: the 3 oldest UNMARKED (3, 4, 5) go; 1 and 2 stay.
    await inTenant(fx.projectId, (tx) =>
      pageVersionRepository.deleteOldestUnmarked(page.id, 3, tx),
    );
    const left = await adminDb.pageVersion.findMany({
      where: { pageId: page.id },
      orderBy: { number: 'asc' },
      select: { number: true },
    });
    expect(left.map((r) => r.number)).toEqual([1, 2, 6]);

    // keep 1 with two marked: only the unmarked one can go, so two remain.
    await inTenant(fx.projectId, (tx) =>
      pageVersionRepository.deleteOldestUnmarked(page.id, 1, tx),
    );
    const after = await adminDb.pageVersion.findMany({
      where: { pageId: page.id },
      orderBy: { number: 'asc' },
      select: { number: true },
    });
    expect(after.map((r) => r.number)).toEqual([1, 2]);
  });

  it('a save after a version is marked still records through the adapter, and the row reads its marks', async () => {
    const page = await newPage();
    const v1 = await firstVersion(page.id);
    await inTenant(fx.projectId, (tx) => pageVersionRepository.sealVersion(v1.id, new Date(), tx));
    await inTenant(fx.projectId, (tx) =>
      savePageUpdate(pageStoreFor(tx), systemClock, {
        pageId: page.id,
        actorId: fx.ownerId,
        update: markdownToUpdate(emptyState(), 'after'),
      }),
    );
    const latest = await inTenant(fx.projectId, (tx) => pageStoreFor(tx).latestVersion(page.id));
    expect(latest).toHaveProperty('sealedAt');
    expect(latest).toHaveProperty('frozenAt');
  });
});

describe('decision_page_publication', () => {
  it('insert + latestForWorkItem returns the newest publication', async () => {
    const page = await newPage();
    const v1 = await firstVersion(page.id);
    const v2 = await addVersion(page.id, 2);
    const card = await decisionCard();
    const row = (versionId: string, at: string) => ({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: card.id,
      pageId: page.id,
      pageVersionId: versionId,
      publishedById: fx.ownerId,
      publishedAt: new Date(at),
    });
    await inTenant(fx.projectId, async (tx) => {
      expect(await decisionPagePublicationRepository.latestForWorkItem(card.id, tx)).toBeNull();
      await decisionPagePublicationRepository.insert(row(v1.id, '2026-10-03T10:00:00Z'), tx);
      await decisionPagePublicationRepository.insert(row(v2.id, '2026-10-03T11:00:00Z'), tx);
    });
    const latest = await inTenant(fx.projectId, (tx) =>
      decisionPagePublicationRepository.latestForWorkItem(card.id, tx),
    );
    expect(latest).toMatchObject({
      pageId: page.id,
      pageVersionId: v2.id,
      publishedById: fx.ownerId,
    });
  });

  it('the trigger refuses a page from another project, and a version of another page', async () => {
    const otherProject = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Elsewhere',
      identifier: 'ELSE',
    });
    const foreignPage = await newPage(otherProject.id);
    const page = await newPage();
    const sibling = await newPage();
    const card = await decisionCard();
    const base = {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: card.id,
      publishedById: fx.ownerId,
      publishedAt: new Date(),
    };

    await expect(
      adminDb.decisionPagePublication.create({
        data: {
          ...base,
          pageId: foreignPage.id,
          pageVersionId: (await firstVersion(foreignPage.id)).id,
        },
      }),
    ).rejects.toThrow(/DECISION_PAGE_CROSS_PROJECT/);

    await expect(
      adminDb.decisionPagePublication.create({
        data: { ...base, pageId: page.id, pageVersionId: (await firstVersion(sibling.id)).id },
      }),
    ).rejects.toThrow(/DECISION_PAGE_VERSION_CROSS_PAGE/);

    await expect(
      adminDb.decisionPagePublication.create({
        data: {
          ...base,
          projectId: otherProject.id,
          pageId: foreignPage.id,
          pageVersionId: (await firstVersion(foreignPage.id)).id,
        },
      }),
    ).rejects.toThrow(/DECISION_PAGE_ITEM_CROSS_PROJECT/);
  });

  it('a published version cannot be deleted on its own, but its page delete takes both rows', async () => {
    const page = await newPage();
    const v1 = await firstVersion(page.id);
    const card = await decisionCard();
    await adminDb.decisionPagePublication.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: card.id,
        pageId: page.id,
        pageVersionId: v1.id,
        publishedById: fx.ownerId,
      },
    });
    await expect(adminDb.pageVersion.delete({ where: { id: v1.id } })).rejects.toThrow();
    await adminDb.page.delete({ where: { id: page.id } });
    expect(await adminDb.decisionPagePublication.count({ where: { pageId: page.id } })).toBe(0);
  });
});
