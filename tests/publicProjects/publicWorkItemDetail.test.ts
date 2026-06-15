import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { PublicWorkItemNotFoundError } from '@/lib/publicProjects/errors';
import {
  makeWorkItemFixture,
  createTestWorkItem,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { truncateAuthTables } from '../helpers/db';

// Public work-item DETAIL read (Story 6.14 · Subtask 6.14.11) — the read behind
// the public `/p/<project>/items/<key>` page. Real Postgres (the standing rule).
// It must: render anonymously + cross-org through the public projection (no
// internal fields), carry the resolved status label + the immediate parent + the
// first page of public-safe children, 404 a non-public project / a missing /
// archived / triage item (404-not-403, no existence leak), AND honour the 6.14.4
// epic-privacy predicate — a non-member viewing a private epic gets the
// `childrenHidden` marker with NO descendant in the payload, while a member reads
// the full child set.

async function setStatus(id: string, status = 'todo'): Promise<void> {
  await db.workItem.update({ where: { id }, data: { status } });
}

async function setPrivate(epicId: string, value: boolean): Promise<void> {
  await db.workItem.update({ where: { id: epicId }, data: { publicChildrenHidden: value } });
}

async function makePublicProjectFixture(name = 'Acme'): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture({ name });
  await db.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
  return fx;
}

describe('publicProjectsService.getWorkItemDetail (6.14.11)', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('renders anonymously + cross-org with the public projection (no internal fields), parent + children', async () => {
    const fx = await makePublicProjectFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Q3 launch' });
    const story = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Passwordless sign-in',
      parentId: epic.id,
    });
    const task = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'Magic-link email',
      parentId: story.id,
    });
    for (const w of [epic, story, task]) await setStatus(w.id);
    // Internal fields set, so the projection assertions prove they are STRIPPED.
    await db.workItem.update({
      where: { id: story.id },
      data: { assigneeId: fx.ownerId, estimateMinutes: 240, storyPoints: 5 },
    });
    const crossOrg = await createTestUser();

    for (const actor of [null, crossOrg.id]) {
      const detail = await publicProjectsService.getWorkItemDetail(
        fx.projectIdentifier,
        story.identifier,
        actor,
      );
      expect(detail.id).toBe(story.id);
      expect(detail.identifier).toBe(story.identifier);
      expect(detail.title).toBe('Passwordless sign-in');
      expect(detail.kind).toBe('story');
      expect(detail.statusCategory).toBe('todo');
      // The immediate parent is the epic (the breadcrumb + sidebar Parent link).
      expect(detail.parent?.identifier).toBe(epic.identifier);
      expect(detail.parent?.title).toBe('Q3 launch');
      // The first page of public-safe direct children — the one task.
      expect(detail.childCount).toBe(1);
      expect(detail.children.map((c) => c.id)).toEqual([task.id]);
      expect(detail.childrenHasMore).toBe(false);
      expect(detail.childrenHidden).toBe(false);
      // Internal fields are absent from the DTO shape (structural projection).
      const asRecord = detail as unknown as Record<string, unknown>;
      for (const k of ['assignee', 'assigneeId', 'estimateMinutes', 'storyPoints']) {
        expect(asRecord).not.toHaveProperty(k);
      }
      const child = detail.children[0] as unknown as Record<string, unknown>;
      for (const k of ['assignee', 'assigneeId', 'estimateMinutes', 'storyPoints']) {
        expect(child).not.toHaveProperty(k);
      }
    }
  });

  it('a root item (an epic) has no parent', async () => {
    const fx = await makePublicProjectFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Standalone epic' });
    await setStatus(epic.id);
    const detail = await publicProjectsService.getWorkItemDetail(
      fx.projectIdentifier,
      epic.identifier,
      null,
    );
    expect(detail.parent).toBeNull();
    expect(detail.childCount).toBe(0);
    expect(detail.children).toHaveLength(0);
  });

  it('a NON-MEMBER viewing a PRIVATE epic gets the marker + NO descendant; a MEMBER reads the children', async () => {
    const fx = await makePublicProjectFixture();
    const privateEpic = await createTestWorkItem(fx, { kind: 'epic', title: 'Billing' });
    const hiddenStory = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Hidden story',
      parentId: privateEpic.id,
    });
    for (const w of [privateEpic, hiddenStory]) await setStatus(w.id);
    await setPrivate(privateEpic.id, true);
    const nonMember = await createTestUser();

    // Non-member: the private epic ROW is reachable, but it carries the marker
    // and NONE of its descendants cross the wire (excluded server-side).
    for (const actor of [null, nonMember.id]) {
      const detail = await publicProjectsService.getWorkItemDetail(
        fx.projectIdentifier,
        privateEpic.identifier,
        actor,
      );
      expect(detail.id).toBe(privateEpic.id);
      expect(detail.childrenHidden).toBe(true);
      expect(detail.children).toHaveLength(0);
      expect(detail.childCount).toBe(0);
    }

    // The hidden descendant itself is NOT reachable by a non-member (404-not-403).
    await expect(
      publicProjectsService.getWorkItemDetail(fx.projectIdentifier, hiddenStory.identifier, null),
    ).rejects.toBeInstanceOf(PublicWorkItemNotFoundError);

    // A MEMBER (the owner) reads the private epic's real children, no marker.
    const asMember = await publicProjectsService.getWorkItemDetail(
      fx.projectIdentifier,
      privateEpic.identifier,
      fx.ownerId,
    );
    expect(asMember.childrenHidden).toBe(false);
    expect(asMember.childCount).toBe(1);
    expect(asMember.children.map((c) => c.id)).toEqual([hiddenStory.id]);
    // The member can also open the descendant directly.
    const memberChild = await publicProjectsService.getWorkItemDetail(
      fx.projectIdentifier,
      hiddenStory.identifier,
      fx.ownerId,
    );
    expect(memberChild.id).toBe(hiddenStory.id);
  });

  it('404s a non-public project, an unknown / archived / triage item (404-not-403)', async () => {
    // A non-public project → ProjectNotFoundError through the browse gate.
    const priv = await makeWorkItemFixture({ name: 'Private Co' });
    const secret = await createTestWorkItem(priv, { kind: 'task', title: 'Secret' });
    await expect(
      publicProjectsService.getWorkItemDetail(priv.projectIdentifier, secret.identifier, null),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    // A public project but an unknown identifier → PublicWorkItemNotFoundError.
    const fx = await makePublicProjectFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Real item' });
    await setStatus(item.id);
    await expect(
      publicProjectsService.getWorkItemDetail(fx.projectIdentifier, 'PROD-9999', null),
    ).rejects.toBeInstanceOf(PublicWorkItemNotFoundError);

    // An archived item → not found.
    await db.workItem.update({ where: { id: item.id }, data: { archivedAt: new Date() } });
    await expect(
      publicProjectsService.getWorkItemDetail(fx.projectIdentifier, item.identifier, null),
    ).rejects.toBeInstanceOf(PublicWorkItemNotFoundError);

    // A TRIAGE item (its public surface is the request detail, not this one) →
    // not found on the work-item detail page.
    const triaged = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'A request' },
      fx.ctx,
    );
    await db.workItem.update({
      where: { id: triaged.id },
      data: { triagedAt: new Date() },
    });
    await expect(
      publicProjectsService.getWorkItemDetail(fx.projectIdentifier, triaged.identifier, null),
    ).rejects.toBeInstanceOf(PublicWorkItemNotFoundError);
  });
});
