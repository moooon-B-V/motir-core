import { adminDb } from '@/tests/helpers/adminDb';
import { workItemsService } from '@/lib/services/workItemsService';
import { seedApprovalsTab, type ApprovalsTabSeed } from './approvals-tab-seed';

// THE LIVE WORKBENCH's seed (Story MOTIR-5238 · Subtask MOTIR-5245) —
// `approvals-tab-seed.ts`'s three actors, plus ONE more design card routed to
// the same reviewer.
//
// ⚠️ THE SECOND CARD IS WHAT MAKES TWO OF THE STORY'S CLAIMS TESTABLE AT ALL,
// and neither can be made with one:
//
//   · *a subsequent frame does not remove the settled row* needs a SECOND real
//     change after the first was decided — otherwise the only frame in the walk
//     is the one that delivered the row, and "it survived a frame" is a sentence
//     about nothing.
//   · *the connection drops and catches up with no duplicated row* needs a
//     change that happens WHILE the stream is down, so the catch-up has
//     something to carry. A replay of the first would be indistinguishable from
//     a surface that simply never dropped.
//
// It is seeded here rather than in the spec because it is SHAPE, not walk: an
// assignee, a card that waits on it, and a status a publish is legal from —
// three facts the spec would otherwise re-derive, and the `in_progress` one is
// the trap (`design-approval-seed.ts`'s header: `todo → done` is not a legal
// edge, so a card has to be claimed before an approval can move it).

/** Deliberately NOT a substring of `approvals-tab-seed.ts`'s three titles — an
 *  accessible-name overlap dies on strict mode, not on anything a spec is about. */
const SECOND_DESIGN_TITLE = 'Draw the arrival chip on a row that came in live';
const SECOND_DEPENDENT_TITLE = 'Wire the arrival chip into the queue row';

export interface WorkbenchLiveSeed extends ApprovalsTabSeed {
  /** A SECOND design routed to the same reviewer — published mid-walk. */
  secondDesignKey: string;
  secondDesignTitle: string;
  secondDesignId: string;
}

export async function seedWorkbenchLive(slug: string): Promise<WorkbenchLiveSeed> {
  const base = await seedApprovalsTab(slug);

  // ⚠️ SEEDED AS THE REVIEWER, exactly as `plantFillerGates` seeds its rows. They
  // are a project `member`, so they may edit; and the base seed hands their id
  // back, which the owner's it does not. The one side effect is that
  // `createWorkItem` auto-WATCHES its creator, so these two cards also sit in the
  // reviewer's Watching tab — which changes nothing the spec asserts and is
  // truer to life than a card nobody follows.
  const ctx = { userId: base.reviewerId, workspaceId: base.workspaceId };

  const story = await adminDb.workItem.findFirstOrThrow({
    where: { projectId: base.projectId, kind: 'story' },
    select: { id: true },
  });

  const design = await workItemsService.createWorkItem(
    {
      projectId: base.projectId,
      kind: 'subtask',
      title: SECOND_DESIGN_TITLE,
      parentId: story.id,
      type: 'design',
      assigneeId: base.reviewerId,
    },
    ctx,
  );
  // AMENDMENT 4 (MOTIR-5491): a design result publishes only while an open work
  // item is `blocked_by` the design.
  const waiting = await workItemsService.createWorkItem(
    {
      projectId: base.projectId,
      kind: 'subtask',
      title: SECOND_DEPENDENT_TITLE,
      parentId: story.id,
      type: 'code',
    },
    ctx,
  );
  await workItemsService.linkWorkItems(
    { fromId: waiting.id, toId: design.id, kind: 'is_blocked_by' },
    ctx,
  );
  await workItemsService.updateStatus(design.id, 'in_progress', ctx);

  return {
    ...base,
    secondDesignKey: design.identifier,
    secondDesignTitle: SECOND_DESIGN_TITLE,
    secondDesignId: design.id,
  };
}
