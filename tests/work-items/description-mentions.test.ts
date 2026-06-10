import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import type { WorkItemMentionedData } from '@/lib/jobs/types';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// Description-mention parity (Story 5.1 · Subtask 5.1.6): mentions in a work
// item's DESCRIPTION notify too — `workItemsService.createWorkItem` and a
// description-changing `updateWorkItem` parse with the same
// lib/mentions/parse.ts helper, view-validate, diff against the prior body
// (edits notify ONLY newly-added ids), and emit `work-item/mentioned` AFTER
// the transaction commits, carrying the revision id as the idempotency scope.
// Description mentions are notification-only: NO stored mention rows (the
// queryable substrate stays comment-scoped — the recorded 5.1.6 scope line).
//
// Real Postgres; the one external seam stubbed is the Inngest client's
// `send()`, doubling as the event assertion surface.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Capture every `work-item/mentioned` publish (and block the network). */
function captureMentionedEvents(): WorkItemMentionedData[] {
  const events: WorkItemMentionedData[] = [];
  vi.spyOn(inngest, 'send').mockImplementation((async (payload: unknown) => {
    const list = Array.isArray(payload) ? payload : [payload];
    for (const entry of list) {
      const evt = entry as { name?: string; data?: WorkItemMentionedData };
      if (evt?.name === 'work-item/mentioned' && evt.data) events.push(evt.data);
    }
    return { ids: [] as string[] };
  }) as typeof inngest.send);
  return events;
}

const mentionToken = (u: User) => `[@${u.name}](mention:${u.id})`;

interface Scenario {
  fx: WorkItemFixture;
  member: User;
}

async function buildScenario(): Promise<Scenario> {
  const fx = await makeWorkItemFixture();
  const member = await usersService.createUser({
    email: 'mentionee@example.com',
    password: 'hunter2hunter2',
    name: 'Mention Target',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
  return { fx, member };
}

describe('createWorkItem — description mentions', () => {
  it('emits work-item/mentioned post-commit with the validated ids and the created revision id', async () => {
    const s = await buildScenario();
    const events = captureMentionedEvents();

    const dto = await workItemsService.createWorkItem(
      {
        projectId: s.fx.projectId,
        kind: 'task',
        title: 'Mention on create',
        descriptionMd: `Owner: ${mentionToken(s.member)} please pick this up.`,
      },
      s.fx.ctx,
    );

    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.workspaceId).toBe(s.fx.workspaceId);
    expect(evt.workItemId).toBe(dto.id);
    expect(evt.authorId).toBe(s.fx.ownerId);
    expect(evt.mentionedUserIds).toEqual([s.member.id]);

    const revision = await db.workItemRevision.findFirst({
      where: { workItemId: dto.id, changeKind: 'created' },
    });
    expect(revision).not.toBeNull();
    expect(evt.revisionId).toBe(revision!.id);

    // Notification-only: NO comment_mention substrate for description mentions.
    expect(await db.commentMention.count()).toBe(0);
  });

  it('silently drops non-member ids and emits nothing when none survive', async () => {
    const s = await buildScenario();
    const events = captureMentionedEvents();

    await workItemsService.createWorkItem(
      {
        projectId: s.fx.projectId,
        kind: 'task',
        title: 'Ghost mention',
        descriptionMd: 'Ping [@Nobody](mention:not-a-member-id).',
      },
      s.fx.ctx,
    );

    expect(events).toHaveLength(0);
  });

  it('emits nothing for a mention-free description', async () => {
    const s = await buildScenario();
    const events = captureMentionedEvents();

    await workItemsService.createWorkItem(
      { projectId: s.fx.projectId, kind: 'task', title: 'Plain', descriptionMd: 'No tags here.' },
      s.fx.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: s.fx.projectId, kind: 'task', title: 'No description' },
      s.fx.ctx,
    );

    expect(events).toHaveLength(0);
  });

  it('drops a mention of a user who cannot view a private project', async () => {
    const s = await buildScenario();
    await projectMembersService.setAccessLevel({
      key: s.fx.projectIdentifier,
      actorUserId: s.fx.ownerId,
      ctx: s.fx.ctx,
      level: 'private',
    });
    // Added AFTER the private flip → workspace member, no project membership.
    const outsider = await usersService.createUser({
      email: 'outsider@example.com',
      password: 'hunter2hunter2',
      name: 'Outsider',
    });
    await workspacesService.addMember({ userId: outsider.id, workspaceId: s.fx.workspaceId });
    const events = captureMentionedEvents();

    await workItemsService.createWorkItem(
      {
        projectId: s.fx.projectId,
        kind: 'task',
        title: 'Private mention',
        descriptionMd: `${mentionToken(outsider)} and ${mentionToken(s.member)}`,
      },
      s.fx.ctx,
    );

    // The auto-enrolled member survives; the outsider is dropped silently.
    expect(events).toHaveLength(1);
    expect(events[0]!.mentionedUserIds).toEqual([s.member.id]);
  });
});

describe('updateWorkItem — description-mention diff', () => {
  it('notifies ONLY newly-added mentions on a description edit, scoped to the update revision', async () => {
    const s = await buildScenario();
    const second = await usersService.createUser({
      email: 'second@example.com',
      password: 'hunter2hunter2',
      name: 'Second Target',
    });
    await workspacesService.addMember({ userId: second.id, workspaceId: s.fx.workspaceId });

    const events = captureMentionedEvents();
    const dto = await workItemsService.createWorkItem(
      {
        projectId: s.fx.projectId,
        kind: 'task',
        title: 'Edit diff',
        descriptionMd: `cc ${mentionToken(s.member)}`,
      },
      s.fx.ctx,
    );
    events.length = 0;

    await workItemsService.updateWorkItem(
      dto.id,
      { descriptionMd: `cc ${mentionToken(s.member)} and now ${mentionToken(second)}` },
      s.fx.ctx,
    );

    // Only the NEW mention rides the event — the kept one is not re-notified.
    expect(events).toHaveLength(1);
    expect(events[0]!.mentionedUserIds).toEqual([second.id]);

    const updateRevision = await db.workItemRevision.findFirst({
      where: { workItemId: dto.id, changeKind: 'updated' },
    });
    expect(events[0]!.revisionId).toBe(updateRevision!.id);
  });

  it('emits nothing when the description is unchanged or the patch touches other fields', async () => {
    const s = await buildScenario();
    const events = captureMentionedEvents();
    const body = `cc ${mentionToken(s.member)}`;
    const dto = await workItemsService.createWorkItem(
      { projectId: s.fx.projectId, kind: 'task', title: 'Stable', descriptionMd: body },
      s.fx.ctx,
    );
    events.length = 0;

    // Identical body → no diff → no event.
    await workItemsService.updateWorkItem(dto.id, { descriptionMd: body }, s.fx.ctx);
    // Unrelated field → no description diff → no event.
    await workItemsService.updateWorkItem(dto.id, { title: 'Stable v2' }, s.fx.ctx);

    expect(events).toHaveLength(0);
  });

  it('includes a self-mention on the event (the consumer skips the author at send time)', async () => {
    const s = await buildScenario();
    const events = captureMentionedEvents();

    await workItemsService.createWorkItem(
      {
        projectId: s.fx.projectId,
        kind: 'task',
        title: 'Self cc',
        descriptionMd: `note to self ${mentionToken(s.fx.owner)}`,
      },
      s.fx.ctx,
    );

    // Parity with comment mentions: the write path records/emits the validated
    // set including the author; the never-self-notify rule is the JOB's.
    expect(events).toHaveLength(1);
    expect(events[0]!.mentionedUserIds).toEqual([s.fx.ownerId]);
  });
});
