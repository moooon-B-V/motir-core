import 'server-only';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { commentsService } from '@/lib/services/commentsService';
import { activityService } from '@/lib/services/activityService';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { acceptanceEvidenceService } from '@/lib/services/acceptanceEvidenceService';
import { acceptanceVideoEligibilityService } from '@/lib/services/acceptanceVideoEligibilityService';
import { designEvidenceService } from '@/lib/services/designEvidenceService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import type { CommentsPageDTO } from '@/lib/dto/comments';
import type { ActivityHistoryPageDto, ActivityAllPageDto } from '@/lib/dto/activity';
import type { AttachmentsPageDTO } from '@/lib/dto/attachments';
import type { DesignGateSubjectDTO } from '@/lib/dto/designEvidence';
import type { ActivityTab } from '@/lib/activity/tab';

// The item page's LATE-TIER reads, as ONE promise (Subtask MOTIR-3436).
//
// ── Why one promise and not one per section ────────────────────────────────
// `design/work-items/design-notes.md` § *THE PAGE SETTLES TWICE* decides the
// late stack arrives as a SINGLE settle. Two `<Suspense>` boundaries await this
// one promise (a tier-2 section sits between them in the page's order), so they
// resolve in the same tick and flush together — the reader sees one arrival.
// Giving each section its own promise would make the page arrive five times in
// whatever order the reads happen to finish.
//
// ⚠️ `listRepoDelivery` is NOT here, deliberately. The Development section uses
// it, but so does the rail's Repositories card — and the rail is TIER TWO. A
// value two tiers need is read once, in the earlier tier, and passed down; the
// alternative is reading it twice or making the rail late to keep them together.
//
// ── Every read here is IDENTICAL to the one it replaced ────────────────────
// Same service, same method, same arguments, same actor. This module MOVES the
// calls off the page's critical path; it does not change them, and nothing under
// `lib/` is touched by the card that introduced it.
//
// ── The try/catch containment travels WITH the read ────────────────────────
// The activity page and the attachments page resolve to `null` on failure, and
// their sections render their own ErrorState + retry — exactly as they did when
// these reads sat inline. A boundary must not convert a caught failure into a
// thrown one, so the catches live here rather than being left to an `error.tsx`
// that would replace the whole item with a failure the reader cannot act on.

export interface LateReads {
  pullRequests: Awaited<ReturnType<typeof workItemsService.listLinkedPullRequests>>;
  commentCaps: Awaited<ReturnType<typeof projectAccessService.getCommentCapabilities>>;
  attachmentCaps: Awaited<ReturnType<typeof projectAccessService.getAttachmentCapabilities>>;
  initialComments: CommentsPageDTO | null;
  initialHistory: ActivityHistoryPageDto | null;
  initialAll: ActivityAllPageDto | null;
  initialAttachments: AttachmentsPageDTO | null;
  acceptanceEligibility: Awaited<
    ReturnType<typeof acceptanceVideoEligibilityService.resolve>
  > | null;
  acceptanceEvidence: Awaited<
    ReturnType<typeof acceptanceEvidenceService.getCurrentForStory>
  > | null;
  canDecideAcceptance: boolean;
  designEvidence: Awaited<ReturnType<typeof designEvidenceService.getCurrentForWorkItem>>;
  isDesignCard: boolean;
  /**
   * The `design_result` approval gate for this card WHATEVER ITS STATE, whether
   * THIS actor may decide it, and — once it is decided — the version it was
   * decided ABOUT (Story MOTIR-4778 · Subtasks MOTIR-4792, MOTIR-5033).
   * `gate: null` when the card has never had one, which is the ordinary case
   * and renders exactly what the section rendered before the frame existed.
   *
   * ⚠️ `subject` IS READ FROM THE GATE, NOT FROM THE CARD, and that is the
   * whole of state `E`. `designEvidence` above is the CURRENT design; a decided
   * gate is about the bytes its decider was looking at, and a republish makes a
   * different row current. Feeding the port the current row would silently
   * re-point a finished decision at a version nobody approved — and the screen
   * would look completely right.
   */
  designGate: Awaited<ReturnType<typeof approvalGatesService.getForWorkItem>> & {
    subject: DesignGateSubjectDTO | null;
  };
  /**
   * This card's runs, newest first (MOTIR-1796). `null` on a failed read — the
   * section renders its own state, per this module's containment rule.
   *
   * ⚠️ THE FIRST ROW IS THE CURRENT RUN, and that is load-bearing rather than a
   * convenience: it is what lets the section decide whether to open a stream
   * BEFORE it renders anything, so an item page for a card nobody is working
   * opens no connection at all.
   */
  runs: Awaited<ReturnType<typeof dispatchRunService.listRunsForWorkItemKey>> | null;
}

export interface LateReadsInput {
  itemId: string;
  itemType: string | null;
  itemStatus: string;
  itemKind: string;
  projectId: string;
  ctx: { userId: string; workspaceId: string };
  /** The full dispatch context the repo-delivery + PR reads take verbatim. */
  fullCtx: Parameters<typeof workItemsService.listLinkedPullRequests>[1];
  activityTab: ActivityTab;
  canEdit: boolean;
  /** The card's `MOTIR-<n>`, which the run history is keyed by. */
  itemIdentifier: string;
}

/** One page of a card's run history — the same default the route serves. */
export const RUN_HISTORY_PAGE = 20;

export function readLateSections(input: LateReadsInput): Promise<LateReads> {
  const { itemId, ctx, projectId, activityTab } = input;
  // A story at in_review / done is the only shape that has an acceptance panel.
  // The ternaries stay: skipping a query is cheaper than parallelising it.
  const showAcceptance =
    input.itemKind === 'story' && (input.itemStatus === 'in_review' || input.itemStatus === 'done');

  return (async (): Promise<LateReads> => {
    const [
      pullRequests,
      commentCaps,
      activity,
      attachmentCaps,
      initialAttachments,
      acceptanceEligibility,
      acceptanceEvidence,
      designEvidence,
      designGate,
      runs,
    ] = await Promise.all([
      workItemsService.listLinkedPullRequests(itemId, input.fullCtx),
      projectAccessService.getCommentCapabilities(projectId, ctx),
      (async () => {
        try {
          if (activityTab === 'comments') {
            return {
              comments: await commentsService.listComments(itemId, { order: 'desc' }, ctx),
              history: null,
              all: null,
            };
          }
          if (activityTab === 'history') {
            return {
              comments: null,
              history: await activityService.listHistory(itemId, { order: 'desc' }, ctx),
              all: null,
            };
          }
          return {
            comments: null,
            history: null,
            all: await activityService.listAll(itemId, { order: 'desc' }, ctx),
          };
        } catch {
          return { comments: null, history: null, all: null };
        }
      })(),
      projectAccessService.getAttachmentCapabilities(projectId, ctx),
      (async () => {
        try {
          return await attachmentsService.listForWorkItem(itemId, {}, ctx);
        } catch {
          return null;
        }
      })(),
      showAcceptance
        ? acceptanceVideoEligibilityService.resolve({
            actorUserId: ctx.userId,
            workspaceId: ctx.workspaceId,
            // The gate is the STORY'S OWN project's (MOTIR-5168) — `projectId` is
            // the item's, already resolved for this page's other reads.
            projectId,
          })
        : null,
      showAcceptance ? acceptanceEvidenceService.getCurrentForStory(itemId, ctx) : null,
      designEvidenceService.getCurrentForWorkItem(itemId, ctx),
      // Contained like its neighbours: a failed gate read must not take the
      // whole late stack down, and "nothing awaiting" is the honest fallback —
      // it renders the section without verbs rather than an error the reader
      // cannot act on.
      (async () => {
        try {
          const read = await approvalGatesService.getForWorkItem(
            { workItemId: itemId, kind: 'design_result' },
            ctx,
          );
          // The subject is read ONLY for a DECIDED gate, and the two states it
          // is skipped for are skipped for opposite reasons. `awaiting` renders
          // the CURRENT design as its port — that is the question — so the
          // pinned row would be the same row and the read is waste.
          // `superseded` renders a DEAD port that shows no subject at all, so
          // fetching one would be a query for something nothing draws.
          const decided =
            read.gate?.state === 'approved' || read.gate?.state === 'changes_requested';
          const subject =
            decided && read.gate
              ? await designEvidenceService.getForGateSubject(
                  { workItemId: itemId, subjectId: read.gate.subjectId },
                  ctx,
                )
              : null;
          return { ...read, subject };
        } catch {
          return { gate: null, canDecide: false, routedToLabel: null, subject: null };
        }
      })(),
      (async () => {
        try {
          return await dispatchRunService.listRunsForWorkItemKey(
            input.itemIdentifier,
            { take: RUN_HISTORY_PAGE },
            ctx,
          );
        } catch {
          return null;
        }
      })(),
    ]);

    return {
      pullRequests,
      commentCaps,
      attachmentCaps,
      initialComments: activity.comments,
      initialHistory: activity.history,
      initialAll: activity.all,
      initialAttachments,
      acceptanceEligibility,
      acceptanceEvidence,
      canDecideAcceptance: input.canEdit && input.itemStatus === 'in_review',
      designEvidence,
      isDesignCard: input.itemType === 'design',
      designGate,
      runs,
    };
  })();
}
