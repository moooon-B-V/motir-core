import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDto } from '@/lib/dto/workItems';
import {
  GUIDE_BUGS_PER_CONVERSATION,
  type GuideAction,
  type GuideOpenBug,
} from '@/lib/ai/guideWorkItem';
import { canParent, isIssueType } from '@/lib/issues/parentRules';
import {
  GuideBugCapExceededError,
  GuideBugDuplicateError,
  PlanChangeSessionNotFoundError,
} from '@/lib/planChange/errors';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { bugDestinationService } from '@/lib/services/bugDestinationService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// A GUIDE conversation files a confirmed defect (Story MOTIR-7797 · MOTIR-7800;
// decision MOTIR-7798 Q3). `guide_work_item` writes nothing; its `file_bug`
// action is landed here AS THE PERSON whose turn it was, through the same create
// door as filing a bug by hand (`workItemsService.createWorkItem`, behind the
// `work_item:edit` gate `guideLandingService.land` already asserts). It never
// goes through the planner's job-token route: a guide session never has a plan
// for that route to count against.
//
// The bound, axis by axis (Q3's table):
//
//   KIND     — `bug`, hard-wired; the action has no kind field.
//   PROJECT  — the guided card's project; the action has no project field.
//   VOLUME   — `GUIDE_BUGS_PER_CONVERSATION`, counted on
//              `plan_change_session.guide_bugs_filed` UNDER THE SESSION'S ROW
//              LOCK, in the one transaction that checks the count, files and
//              increments. (One per TURN is the landing's own rule.)
//   RECORD   — the bug is the person's (no planning provenance), opens with
//              `**Found while:** guiding <KEY>`, and `relates_to` the guided card;
//              the turn's outcome carries its key and the reply names it.
//
// ⚠️ WHY A COLUMN, NOT A COUNT OF OUTCOMES. A turn's outcomes are written only
// when its reply is appended (`appendGuideReplyTurn`), AFTER every action has
// landed, so a count read from them cannot see a bug a concurrent landing has
// already created. The counter is written in the same transaction as the
// decision it bounds.
//
// ⚠️ THE CREATE RUNS INSIDE THE LOCKED TRANSACTION, THROUGH ITS OWN — the shape
// of `aiWorkItemsService.filePlannerBug`. `createWorkItem` is not tx-injectable:
// it owns key allocation, the insert and the links in one transaction of its
// own, with every create guard unchanged. The outer transaction only ever locks
// and bumps the session row, so the two touch disjoint rows: a second filing on
// the same conversation blocks on the session lock until this one has committed
// its increment, then counts it.

/** The `file_bug` action as the landing hands it over. */
export type FileGuideBugInput = Extract<GuideAction, { type: 'file_bug' }>;

/** What a filing returns: the key the reply names back, and the row's id. */
export interface FiledGuideBugDto {
  key: string;
  id: string;
  title: string;
}

/** The `Found while` line a guide-filed bug opens with. */
export function guideFoundWhileLine(guidedKey: string): string {
  return `**Found while:** guiding ${guidedKey} (Guide me through)`;
}

const FOUND_WHILE = /^\s*\*\*Found while:\*\*/;

/** A title compared for the duplicate check: trimmed and case-insensitive. */
function sameTitle(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The not-done bugs among `relates_to` neighbours, one per bug, in link order. */
function openOf(
  related: ReadonlyArray<{ id: string; identifier: string; title: string; status: string }>,
  terminal: ReadonlySet<string>,
): Array<GuideOpenBug & { id: string }> {
  const seen = new Set<string>();
  const out: Array<GuideOpenBug & { id: string }> = [];
  for (const b of related) {
    if (seen.has(b.id) || terminal.has(b.status)) continue;
    seen.add(b.id);
    out.push({ id: b.id, key: b.identifier, title: b.title, status: b.status });
  }
  return out;
}

export const guideBugFilingService = {
  /**
   * The not-done bugs of the guided card's project linked `relates_to` it — the
   * guide context's `card.openBugs`, read as the person under the bound read.
   */
  async listOpenBugs(card: WorkItemDto, ctx: ProjectContext): Promise<GuideOpenBug[]> {
    const terminal = await workflowsService.getTerminalStatusKeys(card.projectId, ctx.workspaceId);
    const related = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemLinkRepository.findRelatedBugs(card.id, card.projectId, tx),
    );
    return openOf(related, terminal).map(({ key, title, status }) => ({ key, title, status }));
  },

  /**
   * File ONE bug from a guide turn, as the person. In one transaction holding
   * the session's row lock:
   *
   *  1. the conversation's count against {@link GUIDE_BUGS_PER_CONVERSATION}
   *     → `GuideBugCapExceededError`;
   *  2. a not-done bug linked `relates_to` the guided card with the same title
   *     → `GuideBugDuplicateError` naming its key;
   *  3. placement (`log-bug.md` § Placement): a bug that BLOCKS the guided card
   *     goes under the guided card's parent when that parent exists, is not in
   *     the done category and admits a `bug` child; every other bug goes to the
   *     project's bug destination. Never a planner-bug folder, and never under a
   *     done card;
   *  4. the create, `kind: bug`, with the `relates_to` link (and, when it blocks,
   *     the guided card `blocked_by` it) written atomically with the row;
   *  5. the counter's increment.
   *
   * Every refusal writes nothing. A guard of the create itself (the kind–parent
   * matrix, the edit gate) throws its own typed error out of here unchanged.
   */
  async fileGuideBug(
    input: FileGuideBugInput,
    session: { id: string },
    card: WorkItemDto,
    ctx: ProjectContext,
  ): Promise<FiledGuideBugDto> {
    const actor: ServiceContext = { userId: ctx.userId, workspaceId: ctx.workspaceId };
    // The workflow's done category: project configuration, not a row this
    // filing races, so it is read before the lock is taken.
    const terminal = await workflowsService.getTerminalStatusKeys(card.projectId, ctx.workspaceId);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: card.projectId },
      async (tx) => {
        const locked = await planChangeSessionRepository.lockById(session.id, tx);
        if (!locked) throw new PlanChangeSessionNotFoundError(ctx.projectId);
        const row = await planChangeSessionRepository.findById(session.id, ctx.workspaceId, tx);
        if (!row) throw new PlanChangeSessionNotFoundError(ctx.projectId);
        if (row.guideBugsFiled >= GUIDE_BUGS_PER_CONVERSATION) {
          throw new GuideBugCapExceededError(
            session.id,
            GUIDE_BUGS_PER_CONVERSATION,
            row.guideBugsFiled,
          );
        }

        const related = await workItemLinkRepository.findRelatedBugs(card.id, card.projectId, tx);
        const duplicate = openOf(related, terminal).find((b) => sameTitle(b.title, input.title));
        if (duplicate) throw new GuideBugDuplicateError(duplicate.key);

        let parentId: string | null = null;
        if (input.blocksGuidedCard && card.parentId) {
          const parent = await workItemRepository.findById(card.parentId, tx);
          if (
            parent &&
            parent.archivedAt === null &&
            !terminal.has(parent.status) &&
            isIssueType(parent.kind) &&
            canParent(parent.kind, 'bug')
          ) {
            parentId = parent.id;
          }
        }
        const folderId =
          parentId === null
            ? (await bugDestinationService.resolve(card.projectId, tx)).folderId
            : null;

        const descriptionMd = FOUND_WHILE.test(input.descriptionMd)
          ? input.descriptionMd
          : `${guideFoundWhileLine(card.identifier)}\n\n${input.descriptionMd}`;

        const dto = await workItemsService.createWorkItem(
          {
            projectId: card.projectId,
            kind: 'bug',
            title: input.title,
            parentId,
            folderId,
            descriptionMd,
            ...(input.explanationMd !== null
              ? { explanationMd: input.explanationMd, explanationSource: 'ai_draft' as const }
              : {}),
            links: [
              { targetId: card.id, relationship: 'relates_to' as const },
              ...(input.blocksGuidedCard
                ? [{ targetId: card.id, relationship: 'blocks' as const }]
                : []),
            ],
          },
          actor,
        );

        await planChangeSessionRepository.incrementGuideBugsFiled(session.id, tx);
        return { key: dto.identifier, id: dto.id, title: dto.title };
      },
    );
  },
};
