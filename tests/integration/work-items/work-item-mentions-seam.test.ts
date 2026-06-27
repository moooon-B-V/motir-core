import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { parseWorkItemRefs } from '@/lib/mentions/workItemRefs';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, createTestProject } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Story 5.8 · Subtask 5.8.7 — the work-item-mention → relates_to → render
// INTEGRATION SEAM (real Postgres). The integration-seam rule: drive the REAL
// services end-to-end and read the WRITER's output (`autoRelateWorkItemMentions`
// via createWorkItem/updateWorkItem + commentsService) BACK through BOTH
// downstream CONSUMER DTOs — the relationships read (`getIssueDetail.relatesTo`,
// what `get_work_item` / the detail page renders) AND the render resolver
// (`resolveReferenceSummaries` → `WorkItemRefMap`, what the 5.8.6 chip renders) —
// so a key/shape drift between writer and consumer fails HERE, where the
// per-subtask units can't see it.
//
// This is NOT a re-derivation of the 5.8.3 link matrix (token/bare-key on every
// field, no-double-link, idempotent, non-destructive, self/cross-project/
// unviewable drop, concurrency) nor the 5.8.6 resolver-in-isolation matrix —
// both already exist. It asserts ONLY the cross-subtask seam: writer output is
// faithfully readable through the SHIPPED consumer DTOs, with the LIVE values.
//
// Items are created through `workItemsService.createWorkItem` (valid fractional
// position — the seed-position gotcha). The one stubbed seam is Inngest `send()`
// (post-commit fan-out events, irrelevant to the DTO assertions).

beforeEach(async () => {
  await truncateAuthTables();
  vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

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

describe('5.8.7 seam · writer → relationships DTO (get_work_item / detail read)', () => {
  it('a token + a bare key in the description both surface under relatesTo, each a mention-sourced edge', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeItem(fx.projectId, fx.ctx, 'Target A');
    const b = await makeItem(fx.projectId, fx.ctx, 'Target B');

    // ONE save: a `motir:` token referencing A AND a bare KEY-N referencing B.
    const source = await makeItem(fx.projectId, fx.ctx, 'Source', {
      descriptionMd: `Depends on ${token(a)} plus bare ${b.identifier}.`,
    });

    // Read the source BACK through the SHIPPED relationships read path — the
    // exact aggregate the detail page / get_work_item render from — NOT a raw
    // work_item_link peek. A writer→consumer key drift fails right here.
    const detail = await workItemsService.getIssueDetail(fx.projectId, source.identifier, fx.ctx);

    const relatedIds = detail.relatesTo.map((l) => l.item.id);
    const relatedKeys = detail.relatesTo.map((l) => l.item.identifier);
    expect(relatedIds).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(relatedKeys).toEqual(expect.arrayContaining([a.identifier, b.identifier]));
    // The DTO carries the LIVE target titles (summary), not a stale/raw snapshot.
    const titleById = new Map(detail.relatesTo.map((l) => [l.item.id, l.item.title]));
    expect(titleById.get(a.id)).toBe('Target A');
    expect(titleById.get(b.id)).toBe('Target B');

    // Provenance, followed THROUGH the DTO's own `linkId` (the edge the inline
    // remove targets) — every surfaced relates_to edge is `source = mention`,
    // i.e. it was born from the reference, not hand-linked.
    for (const l of detail.relatesTo) {
      const row = await db.workItemLink.findUnique({ where: { id: l.linkId } });
      expect(row?.source).toBe('mention');
    }
  });
});

describe('5.8.7 seam · writer → render-resolver DTO (the 5.8.6 chip read)', () => {
  it('the SAME saved body resolves to the LIVE summary, keyed by id AND current identifier', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Original title');
    const source = await makeItem(fx.projectId, fx.ctx, 'Source', {
      descriptionMd: `context from ${token(target)}`,
    });

    // Re-read the persisted body and run the EXACT 5.8.6 consumer over it.
    const detail = await workItemsService.getIssueDetail(fx.projectId, source.identifier, fx.ctx);
    const refs = parseWorkItemRefs(detail.item.descriptionMd ?? '', fx.projectIdentifier);
    const map = await workItemsService.resolveReferenceSummaries(refs, fx.projectId, fx.ctx);

    const byId = map[target.id];
    expect(byId?.accessible).toBe(true);
    if (byId?.accessible) {
      expect(byId.identifier).toBe(target.identifier);
      expect(byId.title).toBe('Original title');
      expect(byId.archived).toBe(false);
      expect(byId.status?.category).toBe('todo'); // initial status category
    }
    // Also keyed by the current identifier (the bare-key / title-linkify path).
    expect(map[target.identifier]).toEqual(byId);
  });

  it('a renamed target re-resolves to the NEW title from the unchanged body (anti-stale)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Before rename');
    const source = await makeItem(fx.projectId, fx.ctx, 'Source', {
      descriptionMd: `see ${token(target)}`,
    });
    const refs = parseWorkItemRefs(source.descriptionMd ?? '', fx.projectIdentifier);

    // Rename the target; the body's token is unchanged (it stores only the id).
    await workItemsService.updateWorkItem(target.id, { title: 'After rename' }, fx.ctx);

    const map = await workItemsService.resolveReferenceSummaries(refs, fx.projectId, fx.ctx);
    const s = map[target.id];
    expect(s?.accessible).toBe(true);
    if (s?.accessible) expect(s.title).toBe('After rename'); // LIVE, never the authored snapshot
  });
});

describe('5.8.7 seam · assembled cross-field flow → relationships DTO', () => {
  it('description + explanation + title + a comment each reference a different item — all four end up related', async () => {
    const fx = await makeWorkItemFixture();
    const t1 = await makeItem(fx.projectId, fx.ctx, 'Title ref');
    const t2 = await makeItem(fx.projectId, fx.ctx, 'Description ref');
    const t3 = await makeItem(fx.projectId, fx.ctx, 'Explanation ref');
    const t4 = await makeItem(fx.projectId, fx.ctx, 'Comment ref');

    // One source touching the full surface set: title (bare key), description
    // (token), explanation (bare key) on create, then a comment (token).
    const source = await makeItem(fx.projectId, fx.ctx, `Tracks ${t1.identifier}`, {
      descriptionMd: `see ${token(t2)}`,
      explanationMd: `per the plan in ${t3.identifier}`,
    });
    await commentsService.addComment(source.id, { bodyMd: `cf. ${token(t4)}` }, fx.ctx);

    const detail = await workItemsService.getIssueDetail(fx.projectId, source.identifier, fx.ctx);
    const relatedIds = detail.relatesTo.map((l) => l.item.id).sort();
    expect(relatedIds).toEqual([t1.id, t2.id, t3.id, t4.id].sort());
  });
});

describe('5.8.7 seam · render-resolver state machine the chip discriminates on', () => {
  it('an archived target resolves accessible + archived (chip muted, still linked)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Stale approach');
    const source = await makeItem(fx.projectId, fx.ctx, 'Source', {
      descriptionMd: `superseded ${token(target)}`,
    });
    const refs = parseWorkItemRefs(source.descriptionMd ?? '', fx.projectIdentifier);

    await workItemsService.archiveWorkItem(target.id, fx.ctx);

    const map = await workItemsService.resolveReferenceSummaries(refs, fx.projectId, fx.ctx);
    const s = map[target.id];
    expect(s?.accessible).toBe(true);
    if (s?.accessible) {
      expect(s.archived).toBe(true);
      expect(s.title).toBe('Stale approach');
    }
  });

  it('a hard-deleted target is OMITTED from the map (chip degrades to a struck-through bare key)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Doomed');
    const source = await makeItem(fx.projectId, fx.ctx, 'Source', {
      descriptionMd: `references ${token(target)}`,
    });
    const refs = parseWorkItemRefs(source.descriptionMd ?? '', fx.projectIdentifier);

    await workItemsService.deleteWorkItem(target.id, fx.ctx);

    const map = await workItemsService.resolveReferenceSummaries(refs, fx.projectId, fx.ctx);
    expect(map[target.id]).toBeUndefined();
  });

  it('a target in a project the author cannot browse resolves { accessible: false } — no title/status leak', async () => {
    const fx = await makeWorkItemFixture();
    // A second, PRIVATE project in the same workspace holding the target.
    const secretProject = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Secret',
      identifier: 'SEC',
    });
    const hidden = await makeItem(secretProject.id, fx.ctx, 'Hidden plan');
    await projectMembersService.setAccessLevel({
      key: 'SEC',
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      level: 'private',
    });

    // A non-owner member: edits the OPEN project, cannot browse the PRIVATE one.
    const editor = await usersService.createUser({
      email: 'editor@example.com',
      password: 'hunter2hunter2',
      name: 'Editor',
    });
    await workspacesService.addMember({ userId: editor.id, workspaceId: fx.workspaceId });
    const editorCtx: ServiceContext = { userId: editor.id, workspaceId: fx.workspaceId };

    const source = await makeItem(fx.projectId, editorCtx, 'Source', {
      descriptionMd: `peek at ${token(hidden)}`,
    });
    const refs = parseWorkItemRefs(source.descriptionMd ?? '', fx.projectIdentifier);
    const map = await workItemsService.resolveReferenceSummaries(refs, fx.projectId, editorCtx);

    const s = map[hidden.id];
    expect(s).toBeDefined();
    expect(s?.accessible).toBe(false);
    // The discriminated union carries ONLY the id when inaccessible — no leak.
    expect(s).not.toHaveProperty('title');
    expect(s).not.toHaveProperty('status');
    // And it is NOT keyed by the (hidden) identifier — only accessible targets are.
    expect(map[hidden.identifier]).toBeUndefined();
  });
});
