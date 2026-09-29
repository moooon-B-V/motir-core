// Planning TARGET seed (Story MOTIR-6894 · Subtask MOTIR-6900).
//
// Extends the shipped anchor tree (`planning-anchor-seed.ts`: an epic → story →
// subtasks chain beside a second epic) with what setting a target four ways needs:
//
//   · an item whose key is TWO digits — a bare number of one digit is below the
//     search's 2-character minimum and names no number (MOTIR-6896), so the tree
//     is padded until the child the spec searches for is `…-12`;
//   · a child with a MULTI-WORD title, found by two of its words after a space;
//   · a child with its own children, so its selected card offers Open as well as
//     View and Set as target.
//
// Seeded through the SHIPPED services, like the tree it extends.

import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { seedPlanningAnchorTree, type PlanningAnchorSeed } from './planning-anchor-seed';

export { PLANNING_ANCHOR_PASSWORD as PLANNING_TARGET_PASSWORD } from './planning-anchor-seed';

export interface PlanningTargetSeed extends PlanningAnchorSeed {
  /** The child a bare number finds: `…-12`, under the epic. */
  numberedKey: string;
  numberedTitle: string;
  /** The child found by two words of a multi-word title, under the epic. */
  phraseKey: string;
  phraseTitle: string;
  /** The two words typed for it, a space between them. */
  phraseQuery: string;
}

export async function seedPlanningTargetTree(email: string): Promise<PlanningTargetSeed> {
  const base = await seedPlanningAnchorTree(email);
  const owner = await db.user.findUniqueOrThrow({ where: { email } });
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: owner.id },
  });
  const project = await db.project.findFirstOrThrow({
    where: { workspaceId: membership.workspaceId, identifier: base.projectKey },
  });
  const ctx = { userId: owner.id, workspaceId: project.workspaceId };
  const epic = await db.workItem.findFirstOrThrow({
    where: { projectId: project.id, identifier: base.epicKey },
  });
  const growth = await db.workItem.findFirstOrThrow({
    where: { projectId: project.id, title: 'Growth experiments' },
  });

  // Padding under the OTHER epic, so it never crowds the level the spec is on:
  // the anchor tree ends at key 5, and the numbered child must be 12.
  for (let i = 6; i <= 11; i++) {
    await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'story', title: `Experiment ${i}`, parentId: growth.id },
      ctx,
    );
  }

  const numberedTitle = 'Import work items from a spreadsheet';
  const numbered = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: numberedTitle, parentId: epic.id },
    ctx,
  );
  const phraseTitle = 'Plan approval gate for reviewers';
  const phrase = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: phraseTitle, parentId: epic.id },
    ctx,
  );

  return {
    ...base,
    numberedKey: numbered.identifier,
    numberedTitle,
    phraseKey: phrase.identifier,
    phraseTitle,
    phraseQuery: 'approval gate',
  };
}
