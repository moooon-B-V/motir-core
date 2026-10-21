import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { VISITOR_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { pageWorkItemLinkRepository } from '@/lib/repositories/pageWorkItemLinkRepository';
import { pagesService } from '@/lib/services/pagesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { resolveWorkItemRefSummaries } from '@/lib/workItems/resolveWorkItemRefs';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createTestProject } from '../../fixtures/projectFixtures';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// STORY MOTIR-7566's READ GATE (MOTIR-9183): the five facts a card draws are
// resolved LIVE, per reader, on every page read — never stored in the body.
// Real Postgres, real services; the reader's standing is changed through the
// real access-mode door, not faked.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ name: 'Embed gate', identifier: 'EGT' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const item = (title: string, where: WorkItemFixture = fx) =>
  createTestWorkItem(where, { kind: 'task', title });

const card = (w: { id: string; identifier: string }) => `![${w.identifier}](motir:${w.id})`;

const newPage = () =>
  pagesService.createPage(fx.ctx, { projectId: fx.projectId, title: 'Gate page' });

async function writeMarkdown(pageId: string, markdown: string) {
  const { revision } = await adminDb.page.findUniqueOrThrow({ where: { id: pageId } });
  return pagesService.savePageMarkdown(fx.ctx, {
    projectId: fx.projectId,
    pageId,
    markdown,
    expectedRevision: revision,
  });
}

const read = (pageId: string, ctx: ServiceContext = fx.ctx) =>
  pagesService.getPage(ctx, { projectId: fx.projectId, pageId });

async function member(email: string): Promise<ServiceContext> {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: email });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

describe('the five facts are resolved live on every read', () => {
  it('carries identifier, title, type and status, then follows a status and an assignee change with no page save', async () => {
    const a = await item('Embedded task');
    const page = await newPage();
    await writeMarkdown(page.id, card(a));
    const { revision } = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });

    const first = (await read(page.id)).workItemRefs[a.id];
    expect(first).toMatchObject({
      accessible: true,
      id: a.id,
      identifier: a.identifier,
      title: 'Embedded task',
      kind: 'task',
      archived: false,
      assignee: null,
    });
    expect(first).toHaveProperty('type');
    expect(first).toHaveProperty('status');
    const statusBefore = (first as { status: unknown }).status;

    await workItemsService.setImportedStatus(a.id, 'in_progress', fx.ctx);
    await workItemsService.assignWorkItem(a.id, fx.ownerId, fx.ctx);

    const second = (await read(page.id)).workItemRefs[a.id] as {
      status: unknown;
      assignee: { id: string } | null;
    };
    expect(second.status).not.toEqual(statusBefore);
    expect(second.assignee?.id).toBe(fx.ownerId);
    // Nothing was written to the page to make that true.
    expect((await adminDb.page.findUniqueOrThrow({ where: { id: page.id } })).revision).toBe(
      revision,
    );
  });
});

describe('a reader who cannot browse the embedded item’s project', () => {
  it('gets { accessible: false, id } only, and the derived row is unaffected for the writer', async () => {
    const priv = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'PRV',
    });
    await projectMembersService.setAccessMode({
      key: priv.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      mode: 'members',
    });
    const hidden = await item('Secret item title', {
      ...fx,
      projectId: priv.id,
      projectIdentifier: 'PRV',
    });
    const page = await newPage();
    await writeMarkdown(page.id, card(hidden));
    const reader = await member('plain-reader@example.com');

    const refs = (await read(page.id, reader)).workItemRefs;
    expect(refs[hidden.id]).toEqual({ accessible: false, id: hidden.id });
    expect(JSON.stringify(refs)).not.toContain('Secret item title');
    expect(JSON.stringify(refs)).not.toContain(hidden.identifier);
    // No derived row for an item in another project (the cotenancy rule).
    expect(await adminDb.pageWorkItemLink.count({ where: { pageId: page.id } })).toBe(0);
  });
});

describe('a Visitor’s ref resolution', () => {
  async function visitor(hiddenIds: string[] = []): Promise<VisitorReadContext> {
    const stranger = await usersService.createUser({
      email: 'visitor@example.com',
      password: 'hunter2hunter2',
      name: 'Visitor',
    });
    return {
      kind: 'visitor',
      project: await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } }),
      actorUserId: stranger.id,
      permissions: VISITOR_PERMISSIONS,
      hiddenIds: new Set(hiddenIds),
    };
  }

  it('returns no entry — under neither key — for a hidden item or one in another project', async () => {
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTH',
    });
    const foreign = await item('Elsewhere', {
      ...fx,
      projectId: other.id,
      projectIdentifier: 'OTH',
    });
    const secret = await item('Hidden by epic privacy');
    const shown = await item('Shown');
    const ctx = await visitor([secret.id]);

    const map = await resolveWorkItemRefSummaries(
      {
        ids: [foreign.id, secret.id, shown.id],
        keys: [foreign.identifier, secret.identifier],
      },
      fx.projectId,
      ctx,
    );

    expect(Object.keys(map).sort()).toEqual([shown.id, shown.identifier].sort());
    for (const w of [foreign, secret]) {
      expect(map).not.toHaveProperty(w.id);
      expect(map).not.toHaveProperty(w.identifier);
    }
    expect(map[shown.id]).toMatchObject({ accessible: true, title: 'Shown' });
  });
});

describe('a page with no card', () => {
  it('has an empty ref map and no derived rows', async () => {
    const page = await newPage();
    await writeMarkdown(page.id, 'Just prose, no embedded work item.');

    expect((await read(page.id)).workItemRefs).toEqual({});
    expect(await adminDb.pageWorkItemLink.count({ where: { pageId: page.id } })).toBe(0);
  });
});

describe('row-level security on the derived embed rows', () => {
  it('hides a page’s rows under another workspace and shows them under its own', async () => {
    const a = await item('A');
    const page = await newPage();
    await writeMarkdown(page.id, card(a));
    const theirs = await makeWorkItemFixture({ name: 'Theirs', identifier: 'THR' });

    const scoped = (f: WorkItemFixture) =>
      withWorkspaceContext(
        { userId: f.ownerId, workspaceId: f.workspaceId, projectId: f.projectId },
        async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
          return pageWorkItemLinkRepository.findDerivedByPage(page.id, tx);
        },
      );

    expect(await scoped(theirs)).toEqual([]);
    const own = await scoped(fx);
    expect(own.map((r) => [r.source, r.workItemId])).toEqual([['embed', a.id]]);
  });
});
