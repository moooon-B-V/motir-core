// E2E fixtures for the Story-5.5 activity specs (Subtask 5.5.5).
//
// Builds on the 5.1.7 comments fixture (the PM + Bo + one task, signed in
// through the real browser): the journey spec manufactures the REST of the
// issue's history server-side through the shipped services (the sanctioned
// test cross-layer reach — each call records its `work_item_revision` through
// the real 1.4.6 path), while the field edits / transition / link / comment
// lifecycle run through the browser UI in the spec itself.
//
// The AT-SCALE fixture (seedScaleActivity) writes revisions + comments
// straight through Prisma, same rationale as seedScaleComments: the surface
// under test is the cursor-paged READ (finding #57), not the write paths the
// journey already drives, and 200+ service calls would burn seconds and
// publish hundreds of pointless Inngest events. Comments are spaced ~4.4s
// against the revisions' 1s grid so the two sources INTERLEAVE on the very
// first All page (the merge assertion needs both grammars above the fold).

import { db } from './db-reset';
import type { CommentsFixture } from './comments-seed';
import { workItemsService } from '@/lib/services/workItemsService';
import { labelsService } from '@/lib/services/labelsService';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { customFieldValuesService } from '@/lib/services/customFieldValuesService';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';

export interface ManufacturedHistory {
  /** The second issue, for the UI link step (and the rank leapfrog). */
  blocker: { id: string; identifier: string };
  sprintName: string;
  fieldKey: string;
  optionLabel: string;
  labelName: string;
  attachmentName: string;
}

/**
 * Server-side history manufacture, in chronological order BEFORE the spec's
 * UI actions: the rank-reorder noise (suppressed writes the feed must hide),
 * a label add, a select custom-field set (the diff stores the option LABEL —
 * the write-time resolution 5.3.3 ships), a sprint move (whose backlogRank
 * half is suppressed from the rendered entry), and an attachment revision.
 *
 * The attachment row is INJECTED rather than uploaded: the real upload path
 * needs the Vercel Blob store and belongs to the Story-5.2 specs (in flight
 * as 5.2.8); the History row under test renders the recorded diff shape,
 * which is exactly what the 5.2 services write.
 */
export async function manufactureServerSideHistory(
  fx: CommentsFixture,
): Promise<ManufacturedHistory> {
  const ctx = { userId: fx.pm.id, workspaceId: fx.workspaceId };

  const blocker = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Blocker issue' },
    ctx,
  );

  // Pure-rank reorder noise (both items in the backlog at this point). The
  // leapfrog guarantees strictly-new keys, so the trail gains rank-only
  // revisions the feed (and its count) must suppress.
  await backlogService.rankIssue(fx.issue.id, { beforeId: blocker.id }, ctx);
  await backlogService.rankIssue(blocker.id, { beforeId: fx.issue.id }, ctx);
  await backlogService.rankIssue(fx.issue.id, { beforeId: blocker.id }, ctx);

  await labelsService.addLabel(fx.issue.id, 'design', ctx);

  const field = await customFieldsService.createField({
    key: fx.projectIdentifier,
    actorUserId: fx.pm.id,
    ctx,
    label: 'Severity',
    fieldType: 'select',
    options: ['Critical', 'Minor'],
  });
  const critical = field.options.find((o) => o.label === 'Critical');
  if (!critical) throw new Error('seeded option missing');
  await customFieldValuesService.setValue(fx.issue.id, field.id, critical.id, ctx);

  const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Sprint 1' }, ctx);
  await backlogService.assignToSprint(fx.issue.id, sprint.id, undefined, ctx);

  await db.workItemRevision.create({
    data: {
      workItemId: fx.issue.id,
      changedById: fx.pm.id,
      changeKind: 'updated',
      diff: {
        attachments: {
          added: [{ attachmentId: 'att_e2e_1', name: 'drag-repro.mp4', source: 'panel' }],
        },
      },
    },
  });

  return {
    blocker: { id: blocker.id, identifier: blocker.identifier },
    sprintName: 'Sprint 1',
    fieldKey: field.key,
    optionLabel: 'Critical',
    labelName: 'design',
    attachmentName: 'drag-repro.mp4',
  };
}

/**
 * The finding-#57 fixture: `revisionCount` displayable title revisions
 * (`pass i` → `pass i+1`, 1s apart) interleaved with `commentCount` root
 * comments (`comment j`, 4.4s apart) inside the same past window — all OLDER
 * than the issue's own `created` revision, which stays the newest entry.
 */
export async function seedScaleActivity(
  fx: CommentsFixture,
  revisionCount: number,
  commentCount: number,
): Promise<void> {
  const base = Date.now() - (revisionCount + 60) * 1000;
  await db.workItemRevision.createMany({
    data: Array.from({ length: revisionCount }, (_, i) => ({
      workItemId: fx.issue.id,
      changedById: fx.pm.id,
      changeKind: 'updated',
      changedAt: new Date(base + i * 1000),
      diff: { title: { from: `pass ${i}`, to: `pass ${i + 1}` } },
    })),
  });
  await db.comment.createMany({
    data: Array.from({ length: commentCount }, (_, j) => ({
      workspaceId: fx.workspaceId,
      workItemId: fx.issue.id,
      authorId: fx.pm.id,
      bodyMd: `comment ${j + 1}`,
      createdAt: new Date(base + Math.round(j * 4400)),
    })),
  });
}
