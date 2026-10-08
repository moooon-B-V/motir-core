import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { pageStoreFor, savePageMarkdown, systemClock } from '@/lib/pages';
import { pagesService } from '@/lib/services/pagesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `pagesService.getPage` carries the LIVE chip data for the work items its body
// mentions (Story MOTIR-7565 · MOTIR-7572), resolved under the reader's own
// access by the same resolver a comment's chips use. Real Postgres.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'PGS' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/**
 * A work item in the workflow's initial status. The repository-edge fixture
 * leaves the column's raw default (`open`), which no workflow defines, so the
 * resolver would report no status at all.
 */
async function item(
  title: string,
  kind: 'task' | 'bug' = 'task',
  where: WorkItemFixture = fx,
): Promise<{ id: string; identifier: string }> {
  const row = await createTestWorkItem(where, { kind, title });
  await adminDb.workItem.update({ where: { id: row.id }, data: { status: 'todo' } });
  return row;
}

const mention = (w: { id: string }, label = 'K') => `[${label}](motir:${w.id})`;

async function pageWith(markdown: string): Promise<string> {
  const page = await pagesService.createPage(fx.ctx, { projectId: fx.projectId, title: 'Notes' });
  await withWorkspaceContext(
    { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
    (tx) =>
      savePageMarkdown(pageStoreFor(tx), systemClock, {
        pageId: page.id,
        actorId: fx.ownerId,
        markdown,
        expectedRevision: page.revision,
      }),
  );
  return page.id;
}

/** A plain workspace member: browses every open project, no role in a private one. */
async function member(): Promise<ServiceContext> {
  const user = await usersService.createUser({
    email: 'reader@example.com',
    password: 'hunter2hunter2',
    name: 'Reader',
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

const read = (ctx: ServiceContext, pageId: string) =>
  pagesService.getPage(ctx, { projectId: fx.projectId, pageId });

describe('pagesService.getPage — workItemRefs (MOTIR-7572)', () => {
  it('resolves a live, an archived and a no-access mention, and leaves a deleted one out', async () => {
    const live = await item('Live one');
    const archived = await item('Archived one', 'bug');
    await adminDb.workItem.update({
      where: { id: archived.id },
      data: { archivedAt: new Date() },
    });
    const priv = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'PRIV',
    });
    await projectMembersService.setAccessMode({
      key: priv.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      mode: 'members',
    });
    const hidden = await item('Secret title', 'task', {
      ...fx,
      projectId: priv.id,
      projectIdentifier: 'PRIV',
    });
    const deleted = await item('Gone');
    const pageId = await pageWith(
      `${mention(live)} ${mention(archived)} ${mention(hidden, 'PRIV-1')} ${mention(deleted)}`,
    );
    await adminDb.workItem.delete({ where: { id: deleted.id } });

    const page = await read(await member(), pageId);

    expect(page.workItemRefs[live.id]).toMatchObject({
      accessible: true,
      id: live.id,
      identifier: live.identifier,
      title: 'Live one',
      archived: false,
      status: { key: 'todo' },
    });
    expect(page.workItemRefs[archived.id]).toMatchObject({ accessible: true, archived: true });
    expect(page.workItemRefs[hidden.id]).toEqual({ accessible: false, id: hidden.id });
    expect(JSON.stringify(page.workItemRefs)).not.toContain('Secret title');
    expect(JSON.stringify(page.workItemRefs)).not.toContain(hidden.identifier);
    expect(page.workItemRefs[deleted.id]).toBeUndefined();
  });

  it('returns {} for a page with no mention', async () => {
    const pageId = await pageWith('# Just prose\n\nNo links here.');
    expect((await read(fx.ctx, pageId)).workItemRefs).toEqual({});
  });

  it('reads the current status on every read, with no page save in between', async () => {
    const a = await item('Moving');
    const pageId = await pageWith(`Track ${mention(a)}.`);
    expect((await read(fx.ctx, pageId)).workItemRefs[a.id]).toMatchObject({
      status: { key: 'todo' },
    });

    await adminDb.workItem.update({ where: { id: a.id }, data: { status: 'in_progress' } });
    const { workItemRefs, revision } = await read(fx.ctx, pageId);
    expect(workItemRefs[a.id]).toMatchObject({ status: { key: 'in_progress' } });
    expect(revision).toBe(2);
  });
});
