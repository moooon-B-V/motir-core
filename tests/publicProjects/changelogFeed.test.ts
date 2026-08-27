import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import {
  makeWorkItemFixture,
  createTestWorkItem,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story 8.9 · Subtask 8.9.6 — the feed's READ, against a real database.
//
// The DOCUMENT (validity, escaping) is asserted in `atomFeedDocument.test.ts`,
// which needs a DOM parser and so runs in the happy-dom environment. What is
// here is the half that needs Postgres: that the feed composes the SAME read as
// the page — so its privacy behaviour is identical by construction rather than
// by a second set of filters — and that it, and only it, projects the body.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the feed read shares the page read’s privacy', () => {
  async function publicFixture(): Promise<WorkItemFixture> {
    const fx = await makeWorkItemFixture({ name: 'Acme' });
    await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
    return fx;
  }

  async function ship(fx: WorkItemFixture, id: string, at: string) {
    await adminDb.workItemRevision.create({
      data: {
        workItemId: id,
        changedById: fx.ownerId,
        changedAt: new Date(at),
        changeKind: 'updated',
        diff: { status: { from: 'in_progress', to: 'done' } },
      },
    });
    await adminDb.workItem.update({ where: { id }, data: { status: 'done' } });
  }

  it('excludes a private epic’s descendants AND its own row, exactly as the page does', async () => {
    const fx = await publicFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Secret programme' });
    const child = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Hidden story',
      parentId: epic.id,
    });
    const open = await createTestWorkItem(fx, { kind: 'task', title: 'Public task' });
    await adminDb.workItem.update({
      where: { id: epic.id },
      data: { publicChildrenHidden: true },
    });
    await ship(fx, epic.id, '2026-08-26T10:00:00.000Z');
    await ship(fx, child.id, '2026-08-26T11:00:00.000Z');
    await ship(fx, open.id, '2026-08-26T12:00:00.000Z');

    const feed = await publicProjectsService.getChangelogFeed(fx.projectIdentifier, null);
    // Composing the SAME read is what makes this true by construction rather
    // than by a second set of filters that could drift from the page's.
    expect(feed.entries.map((e) => e.title)).toEqual(['Public task']);
  });

  it('projects the body for the feed, which the PAGE read does not', async () => {
    const fx = await publicFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'With a body' });
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { descriptionMd: 'The body a feed reader shows.' },
    });
    await ship(fx, item.id, '2026-08-26T10:00:00.000Z');

    const feed = await publicProjectsService.getChangelogFeed(fx.projectIdentifier, null);
    expect(feed.entries[0]?.descriptionMd).toBe('The body a feed reader shows.');

    // The page's projection stays minimal — the key is absent, not null.
    const page = await publicProjectsService.getChangelog(fx.projectIdentifier, null);
    expect(page.entries[0]).not.toHaveProperty('descriptionMd');
  });
});
