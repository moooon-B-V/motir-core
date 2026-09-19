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
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import type {
  PullRequestApprovalMemberDTO,
  PullRequestStandingExitDTO,
} from '@/lib/dto/approvalGate';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { howToTestService } from '@/lib/services/howToTestService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import type { WorkItemRepairViewDto } from '@/lib/dto/workItemRepair';
import { monitorIssueService } from '@/lib/services/monitorIssueService';
import type { MonitorIssueLinkDto } from '@/lib/dto/monitorIssueLink';
import type { CommentsPageDTO } from '@/lib/dto/comments';
import type { ActivityHistoryPageDto, ActivityAllPageDto } from '@/lib/dto/activity';
import type { AttachmentsPageDTO } from '@/lib/dto/attachments';
import type { DesignGateSubjectDTO } from '@/lib/dto/designEvidence';
import type { HowToTestDto } from '@/lib/dto/howToTest';
import type { ActivityTab } from '@/lib/activity/tab';
import type { DispatchRunListItemDto } from '@/lib/dto/dispatchRuns';

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
  /** The item's own project — the acceptance panel's Turn on flips THIS project's
   *  switch (MOTIR-5172). Already resolved for the page; carried, never re-read. */
  projectId: string;
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
  /**
   * The LATEST run this work item was the SCOPE of (Story MOTIR-5363 · design
   * MOTIR-5402 panels 1–2) — what the Run section's *Run as a scope* block shows.
   *
   * ⚠️ A DIFFERENT QUESTION FROM `runs` ABOVE. `runs` is every run that had a LEG
   * on this item; a scoped run's legs are the container's CHILDREN, so a story
   * that was run as a scope has no row there and used to read *No runs yet*.
   *
   * `null` when the item has never been a scope, when the read failed (the block
   * is simply absent — the leg history still renders), and WITHOUT A QUERY for an
   * item with no children, because only a container can be a scope.
   */
  scopeRun: DispatchRunListItemDto | null;
  /**
   * The run's HOW TO TEST for this card (Story MOTIR-4906 · MOTIR-5336) — the
   * Development block's second part, rendered inside the same card below the
   * rows. `null` on a failed read: the block then renders the rows alone, which
   * is what the card rendered before, rather than an error in a card whose rows
   * still read fine.
   */
  howToTest: HowToTestDto | null;
  /**
   * The card's approve-and-merge gate (`pull_request_approval`) WHATEVER ITS STATE, or
   * `gate: null` — read exactly as `designGate` is, the same service and the same
   * containment (Story MOTIR-4909 · MOTIR-5484). A decided gate keeps its frame: the
   * merging, queued, merged, refused and withdrawn states all come after the decision,
   * and an awaiting-only read made the frame vanish the moment it was pressed.
   *
   * `members` — once the gate is APPROVED — is what a reload still knows about each pull
   * request of its set: whether its merge gate awaits, and whether the press queued it.
   */
  mergeGate: Awaited<ReturnType<typeof approvalGatesService.getForWorkItem>> & {
    members: PullRequestApprovalMemberDTO[];
    /** An `auto` card's standing merge-queue exits, read only when there is no gate
     *  (MOTIR-5635). */
    autoQueueExits: PullRequestStandingExitDTO[];
  };
  /**
   * What the Development block says about a REPAIR (Story MOTIR-5460 ·
   * MOTIR-5466, design `design/github` § 21) — the copyable `motir fix`, who is
   * fixing the card, or that the last fix gave up. `null` on a failed read: the
   * block then renders WITHOUT the fix part, never an error, like `howToTest`.
   */
  repair: WorkItemRepairViewDto | null;
  /**
   * The card's monitor-ERROR links (Story MOTIR-4932 · MOTIR-5732, design
   * `design/monitoring` §14). `null` on a failed read — the Errors section then
   * renders its own ErrorState, and only in a project that HAS a connection.
   * Read from the store the reconciler wrote: NO provider call on page load.
   */
  monitorIssueLinks: MonitorIssueLinkDto[] | null;
  /**
   * Whether the project binds at least one monitored project (§14 Decision 5) —
   * the half of the door rule `canEdit` does not answer. `false` on a failed
   * read: an absent door is the honest fallback, never a door that searches
   * nothing.
   */
  monitorHasConnection: boolean;
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
  /** The project's key — the scoped run read is addressed by it. */
  projectKey: string;
  /**
   * Whether the item has children. Only a container can be a run's scope — the
   * CLI records one only on its `run_scope` path, which claims a container — so a
   * leaf makes no scope read at all.
   */
  hasChildren: boolean;
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
      scopeRun,
      howToTest,
      mergeGate,
      repair,
      monitorIssueLinks,
      monitorHasConnection,
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
          return {
            gate: null,
            canDecide: false,
            routedToLabel: null,
            settingsDoor: null,
            stamp: null,
            subject: null,
          };
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
      // ⚠️ ONE ROW, AND ONLY FOR A CONTAINER. The block shows the latest scoped
      // run and a door to the rest, so a page is one row; a leaf — the item
      // page's commonest case — cannot be a scope and makes no query here.
      input.hasChildren
        ? (async () => {
            try {
              const [latest] = await dispatchRunService.listRunsForProject(
                input.projectKey,
                { take: 1, scopeWorkItemKey: input.itemIdentifier },
                ctx,
              );
              return latest ?? null;
            } catch {
              return null;
            }
          })()
        : null,
      (async () => {
        try {
          return await howToTestService.getForWorkItem(itemId, ctx);
        } catch {
          return null;
        }
      })(),
      (async () => {
        try {
          const read = await approvalGatesService.getForWorkItem(
            { workItemId: itemId, kind: 'pull_request_approval' },
            ctx,
          );
          // The members are read ONLY for an APPROVED gate: before the press there is
          // nothing a merge could have done, and a withdrawn question merged nothing.
          const members =
            read.gate?.state === 'approved'
              ? await pullRequestMergeService.listApprovalMembers(
                  { workItemId: itemId, approvalGateId: read.gate.id },
                  ctx,
                )
              : [];
          // An `auto` card has no gate to read its exits through (MOTIR-5635, § 22 E5).
          const autoQueueExits = read.gate
            ? []
            : await pullRequestMergeService.listStandingQueueExits({ workItemId: itemId }, ctx);
          return { ...read, members, autoQueueExits };
        } catch {
          return {
            gate: null,
            canDecide: false,
            routedToLabel: null,
            settingsDoor: null,
            stamp: null,
            members: [],
            autoQueueExits: [],
          };
        }
      })(),
      (async () => {
        try {
          return await workItemRepairService.getRepairView(itemId, ctx);
        } catch {
          return null;
        }
      })(),
      (async () => {
        try {
          return await monitorIssueService.listForWorkItem(itemId, ctx);
        } catch {
          return null;
        }
      })(),
      (async () => {
        try {
          return await monitorIssueService.projectHasConnection(projectId, ctx);
        } catch {
          return false;
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
      projectId,
      designEvidence,
      isDesignCard: input.itemType === 'design',
      designGate,
      runs,
      scopeRun,
      howToTest,
      mergeGate,
      repair,
      monitorIssueLinks,
      monitorHasConnection,
    };
  })();
}
