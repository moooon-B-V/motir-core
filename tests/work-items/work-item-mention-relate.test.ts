import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItemLink } from '@prisma/client';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { autoRelateWorkItemMentions } from '@/lib/workItems/autoRelateMentions';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, createTestProject } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// Auto-relate-on-mention (Story 5.8 · Subtask 5.8.3): saving a work-item text
// field or comment that REFERENCES another item (`[KEY](motir:<id>)` token or a
// bare `KEY-N`) auto-creates a `relates_to` link stamped `source = mention` —
// the link row IS the durable record (no separate mention table). ADD-only,
// idempotent, view-scoped, concurrency-safe. Real Postgres; the one external
// seam stubbed is the Inngest client's `send()` (the comment/mention events the
// hooks fan out — irrelevant to the link assertions here).
//
// Every item is created through `workItemsService.createWorkItem` (NOT the
// `createTestWorkItem` repo fixture) so each carries a VALID fractional-index
// position — a fixture-seeded padded position would break the next service
// create's sibling-append in the same project (the seed-position gotcha).

beforeEach(async () => {
  await truncateAuthTables();
  // Block the network for every post-commit event the hooks emit.
  vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Create a task via the service (valid fractional position) in a project/ctx. */
function makeItem(
  projectId: string,
  ctx: ServiceContext,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<WorkItemDto> {
  return workItemsService.createWorkItem({ projectId, kind: 'task', title, ...extra }, ctx);
}

const token = (item: Pick<WorkItemDto, 'id' | 'identifier'>) =>
  `[${item.identifier}](motir:${item.id})`;

/** Every `relates_to` out-edge of an item, with its provenance. */
function relatesOut(fromId: string): Promise<WorkItemLink[]> {
  return db.workItemLink.findMany({ where: { fromId, kind: 'relates_to' } });
}

function linkBetween(aId: string, bId: string): Promise<WorkItemLink | null> {
  return db.workItemLink.findFirst({
    where: {
      OR: [
        { fromId: aId, toId: bId },
        { fromId: bId, toId: aId },
      ],
    },
  });
}

describe('auto-relate on create', () => {
  it('a motir: token in the description creates a relates_to link (source=mention) + reciprocal', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');

    const dto = await makeItem(fx.projectId, fx.ctx, 'Source', {
      descriptionMd: `Depends on context from ${token(target)}.`,
    });

    const forward = await db.workItemLink.findUnique({
      where: { fromId_toId_kind: { fromId: dto.id, toId: target.id, kind: 'relates_to' } },
    });
    expect(forward).not.toBeNull();
    expect(forward!.source).toBe('mention');

    // The symmetric reciprocal row exists too, also stamped mention.
    const reciprocal = await db.workItemLink.findUnique({
      where: { fromId_toId_kind: { fromId: target.id, toId: dto.id, kind: 'relates_to' } },
    });
    expect(reciprocal).not.toBeNull();
    expect(reciprocal!.source).toBe('mention');
  });

  it('a bare KEY-N in the title links too', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');

    const dto = await makeItem(fx.projectId, fx.ctx, `Follow-up to ${target.identifier}`);

    const link = await linkBetween(dto.id, target.id);
    expect(link).not.toBeNull();
    expect(link!.source).toBe('mention');
  });

  it('a bare KEY-N in the explanation links too', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');

    const dto = await makeItem(fx.projectId, fx.ctx, 'With explanation', {
      explanationMd: `Implements the plan from ${target.identifier}.`,
    });

    expect(await linkBetween(dto.id, target.id)).not.toBeNull();
  });

  it('skips a self-reference', async () => {
    const fx = await makeWorkItemFixture();
    // A create can't reference its not-yet-allocated key, so drive it via update.
    const dto = await makeItem(fx.projectId, fx.ctx, 'Lonely');
    await workItemsService.updateWorkItem(
      dto.id,
      { descriptionMd: `See ${dto.identifier} (myself).` },
      fx.ctx,
    );
    expect(await relatesOut(dto.id)).toHaveLength(0);
  });
});

describe('auto-relate on update + comment', () => {
  it('a bare KEY-N added in an edited description links', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const dto = await makeItem(fx.projectId, fx.ctx, 'Source');
    expect(await relatesOut(dto.id)).toHaveLength(0);

    await workItemsService.updateWorkItem(
      dto.id,
      { descriptionMd: `Now relates to ${target.identifier}.` },
      fx.ctx,
    );
    expect(await linkBetween(dto.id, target.id)).not.toBeNull();
  });

  it('a reference in a comment links from the comment’s work item', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const host = await makeItem(fx.projectId, fx.ctx, 'Host');

    await commentsService.addComment(host.id, { bodyMd: `cf. ${token(target)}` }, fx.ctx);

    const link = await linkBetween(host.id, target.id);
    expect(link).not.toBeNull();
    expect(link!.source).toBe('mention');
  });

  it('a reference added in a comment EDIT links', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const host = await makeItem(fx.projectId, fx.ctx, 'Host');

    const comment = await commentsService.addComment(host.id, { bodyMd: 'no refs yet' }, fx.ctx);
    expect(await relatesOut(host.id)).toHaveLength(0);

    await commentsService.editComment(
      comment.id,
      { bodyMd: `actually see ${target.identifier}` },
      fx.ctx,
    );
    expect(await linkBetween(host.id, target.id)).not.toBeNull();
  });
});

describe('auto-relate guards', () => {
  it('does NOT add a relates_to when the pair is already linked is_blocked_by', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Blocker');
    const source = await makeItem(fx.projectId, fx.ctx, 'Source');
    await workItemsService.linkWorkItems(
      { fromId: source.id, toId: target.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    await workItemsService.updateWorkItem(
      source.id,
      { descriptionMd: `relates? ${target.identifier}` },
      fx.ctx,
    );

    // The existing block is untouched; no relates_to edge was added.
    expect(await relatesOut(source.id)).toHaveLength(0);
    expect(
      await db.workItemLink.findUnique({
        where: { fromId_toId_kind: { fromId: source.id, toId: target.id, kind: 'is_blocked_by' } },
      }),
    ).not.toBeNull();
  });

  it('is idempotent: re-saving the same reference adds no duplicate', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const dto = await makeItem(fx.projectId, fx.ctx, 'Source', {
      descriptionMd: `see ${target.identifier}`,
    });
    expect(await relatesOut(dto.id)).toHaveLength(1);

    // Edit the description to a DIFFERENT body that still references the same key.
    await workItemsService.updateWorkItem(
      dto.id,
      { descriptionMd: `still see ${target.identifier}, more text` },
      fx.ctx,
    );
    expect(await relatesOut(dto.id)).toHaveLength(1);
  });

  it('is non-destructive: removing the reference leaves the link', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const dto = await makeItem(fx.projectId, fx.ctx, 'Source', {
      descriptionMd: `see ${target.identifier}`,
    });
    expect(await linkBetween(dto.id, target.id)).not.toBeNull();

    await workItemsService.updateWorkItem(
      dto.id,
      { descriptionMd: 'no more references here' },
      fx.ctx,
    );
    // The link survives the reference's removal.
    expect(await linkBetween(dto.id, target.id)).not.toBeNull();
  });

  it('silently drops unresolved + cross-workspace references', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTH' });
    const foreign = await makeItem(other.projectId, other.ctx, 'Foreign');

    const dto = await makeItem(fx.projectId, fx.ctx, 'Source', {
      // A dangling token id AND a cross-workspace token id — both dropped.
      descriptionMd: `ghost [PROD-999](motir:does-not-exist) and ${token(foreign)}`,
    });

    expect(await relatesOut(dto.id)).toHaveLength(0);
    expect(await linkBetween(dto.id, foreign.id)).toBeNull();
  });

  it('silently drops a reference to a project the author cannot browse', async () => {
    const fx = await makeWorkItemFixture();
    // A second, PRIVATE project in the same workspace, with a target item.
    const secretProject = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Secret',
      identifier: 'SEC',
    });
    const hidden = await makeItem(secretProject.id, fx.ctx, 'Hidden');
    await projectMembersService.setAccessLevel({
      key: 'SEC',
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      level: 'private',
    });

    // A non-owner workspace member: can edit the OPEN source project, cannot
    // browse the PRIVATE target project (added after the flip, no membership).
    const editor = await usersService.createUser({
      email: 'editor@example.com',
      password: 'hunter2hunter2',
      name: 'Editor',
    });
    await workspacesService.addMember({ userId: editor.id, workspaceId: fx.workspaceId });
    const editorCtx: ServiceContext = { userId: editor.id, workspaceId: fx.workspaceId };

    const dto = await makeItem(fx.projectId, editorCtx, 'Source', {
      descriptionMd: `peek at ${token(hidden)}`,
    });

    expect(await linkBetween(dto.id, hidden.id)).toBeNull();
  });
});

describe('auto-relate concurrency', () => {
  it('two near-simultaneous writes referencing the same target yield exactly ONE link', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Target');
    const source = await makeItem(fx.projectId, fx.ctx, 'Source');

    const refText = `see ${token(target)}`;
    const run = () =>
      db.$transaction((tx) =>
        autoRelateWorkItemMentions(
          {
            source: {
              id: source.id,
              workspaceId: fx.workspaceId,
              projectId: fx.projectId,
              projectIdentifier: fx.projectIdentifier,
            },
            text: refText,
            ctx: fx.ctx,
          },
          tx,
        ),
      );

    // Either winner is fine — the @@unique serialises the race; neither throws.
    await Promise.all([run(), run()]);

    const forward = await workItemLinkRepository.findByFromItem(source.id, 'relates_to');
    const toTarget = forward.filter((l) => l.toId === target.id);
    expect(toTarget).toHaveLength(1);
    expect(toTarget[0]!.source).toBe('mention');
  });
});
