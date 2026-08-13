import { describe, expect, it } from 'vitest';
import { bareTransactionSites, scanCallSites, unboundCallSites } from './callSiteScan';

// The CALL-SITE guard (MOTIR-2845) — the second axis of the singleton-read
// guard, and the half `tests/rls/singleton-read-guard.test.ts` is structurally
// blind to.
//
// That guard asks whether a repository read CAN be bound (`tx ?? db`). This one
// asks whether its callers actually DO. Both failures have the identical
// symptom — no GUC on the transaction, the RLS policy compares against NULL, the
// read returns ZERO ROWS AND RAISES NOTHING — and only the first was ever
// detectable, which is why MOTIR-2796 was partitioned into fifty-five repository
// METHODS and named no call site at all.
//
// ⚠️ THIS GUARD EXISTS BECAUSE THE OTHER ONE GOES QUIET. The moment a read gains
// its `tx ?? db`, `singletonReadScan` stops reporting it — the capability is
// there. Nothing then watches whether anyone supplies it. Without this file,
// MOTIR-2796 empties a class rather than closing it, and the next service
// reintroduces the whole thing silently. (`notes.html` #266.)
//
// The division of labour is the one MOTIR-2784 established and
// `tenant-root-creation-rls.test.ts` before it: the machine enumerates, a human
// adjudicates, and a site nobody has ruled on fails the build.

/** Why an unbound call site is acceptable — or is not. */
type Verdict =
  /**
   * CONFIRMED unbound and confirmed BROKEN under `motir_app`: a bindable read of
   * a policy-gated table, called with no transaction. The value names the card
   * that owns the fix, because that is the unit the work is planned in.
   */
  | 'unbound-call-site'
  /**
   * MUST STAY UNBOUND. `work_item_public_project_read` and `project_public_read`
   * (MOTIR-2684) fire only when `app.workspace_id` is UNSET, so binding a public
   * page's read would DISABLE the arm that makes it work. This is the one verdict
   * where the fix would be the regression — see the structural exemption in
   * `docs/decisions/bound-read-transaction-shape.md`.
   */
  | 'public-arm'
  /** No tenant exists at read time; there is nothing to bind. */
  | 'pre-auth'
  /** Fixed: the call now receives a GUC-bound transaction. Only ever REMOVED. */
  | 'bound';

/**
 * One entry per (FILE, read) pair rather than per line, deliberately: a call
 * that moves down its file is the same adjudication, and keying on the line
 * would make every unrelated edit a re-review. A file that calls one read from
 * three places carries one entry and the scan counts three sites.
 */
const CALL_SITE_VERDICTS: Record<string, readonly [Verdict, string]> = {
  'app/(onboarding)/onboarding/discovery/page.tsx#workItemRepository.countProjectIssues': [
    'unbound-call-site',
    'MOTIR-2846 · page',
  ],
  'app/(onboarding)/onboarding/page.tsx#workItemRepository.countProjectIssues': [
    'unbound-call-site',
    'MOTIR-2846 · page',
  ],
  'lib/github/oidcAuth.ts#workspaceMembershipRepository.findOwnerByWorkspace': [
    'unbound-call-site',
    'MOTIR-2809 · oidcAuth',
  ],
  'lib/import/engine/importEngineService.ts#importedIssueRepository.findBySourceId': [
    'unbound-call-site',
    'MOTIR-2846 · importEngineService',
  ],
  'lib/import/engine/importPersistService.ts#importRepository.findById': [
    'unbound-call-site',
    'MOTIR-2846 · importPersistService',
  ],
  'lib/import/engine/importPersistService.ts#importedIssueRepository.findBySourceId': [
    'unbound-call-site',
    'MOTIR-2846 · importPersistService',
  ],
  'lib/services/acceptanceEvidenceService.ts#workspaceRepository.findById': [
    'unbound-call-site',
    'MOTIR-2846 · acceptanceEvidenceService',
  ],
  'lib/services/activityService.ts#workflowsRepository.findStatuses': [
    'unbound-call-site',
    'MOTIR-2806 · activityService',
  ],
  'lib/services/aiPlanEditsService.ts#workItemRepository.findByIdentifier': [
    'unbound-call-site',
    'MOTIR-2846 · aiPlanEditsService',
  ],
  'lib/services/aiSprintPlanningService.ts#workItemRepository.findByIdentifiers': [
    'unbound-call-site',
    'MOTIR-2846 · aiSprintPlanningService',
  ],
  'lib/services/attachmentsService.ts#attachmentRepository.countByWorkItem': [
    'unbound-call-site',
    'MOTIR-2846 · attachmentsService',
  ],
  'lib/services/attachmentsService.ts#attachmentRepository.listByWorkItem': [
    'unbound-call-site',
    'MOTIR-2846 · attachmentsService',
  ],
  'lib/services/attachmentsService.ts#workspaceRepository.findById': [
    'unbound-call-site',
    'MOTIR-2846 · attachmentsService',
  ],
  'lib/services/autoPlanCadenceService.ts#planItemRepository.countByPlan': [
    'unbound-call-site',
    'MOTIR-2846 · autoPlanCadenceService',
  ],
  'lib/services/autoPlanCadenceService.ts#workspaceMembershipRepository.findOwnerByWorkspace': [
    'unbound-call-site',
    'MOTIR-2846 · autoPlanCadenceService',
  ],
  'lib/services/backlogService.ts#sprintRepository.findById': [
    'unbound-call-site',
    'MOTIR-2846 · backlogService',
  ],
  'lib/services/backlogService.ts#workItemRepository.countBacklog': [
    'unbound-call-site',
    'MOTIR-2846 · backlogService',
  ],
  'lib/services/backlogService.ts#workItemRepository.countSprintIssues': [
    'unbound-call-site',
    'MOTIR-2846 · backlogService',
  ],
  'lib/services/backlogService.ts#workItemRepository.findBacklogPage': [
    'unbound-call-site',
    'MOTIR-2846 · backlogService',
  ],
  'lib/services/backlogService.ts#workItemRepository.findBacklogRankByIds': [
    'unbound-call-site',
    'MOTIR-2846 · backlogService',
  ],
  'lib/services/backlogService.ts#workItemRepository.findBoundaryBacklogRank': [
    'unbound-call-site',
    'MOTIR-2846 · backlogService',
  ],
  'lib/services/backlogService.ts#workItemRepository.findSprintIssues': [
    'unbound-call-site',
    'MOTIR-2846 · backlogService',
  ],
  'lib/services/backlogService.ts#workflowsRepository.findStatuses': [
    'unbound-call-site',
    'MOTIR-2846 · backlogService',
  ],
  'lib/services/boardsService.ts#boardColumnRepository.findByBoard': [
    'unbound-call-site',
    'MOTIR-2801 · boardsService',
  ],
  'lib/services/boardsService.ts#boardColumnRepository.findById': [
    'unbound-call-site',
    'MOTIR-2801 · boardsService',
  ],
  'lib/services/boardsService.ts#boardColumnStatusRepository.findByBoard': [
    'unbound-call-site',
    'MOTIR-2801 · boardsService',
  ],
  'lib/services/boardsService.ts#boardRepository.findById': [
    'unbound-call-site',
    'MOTIR-2801 · boardsService',
  ],
  'lib/services/boardsService.ts#boardRepository.findByProjectByPosition': [
    'unbound-call-site',
    'MOTIR-2801 · boardsService',
  ],
  'lib/services/boardsService.ts#boardRepository.findDefaultForProject': [
    'unbound-call-site',
    'MOTIR-2801 · boardsService',
  ],
  'lib/services/boardsService.ts#sprintRepository.findActiveByProject': [
    'unbound-call-site',
    'MOTIR-2801 · boardsService',
  ],
  'lib/services/boardsService.ts#workItemRepository.countProjectIssues': [
    'unbound-call-site',
    'MOTIR-2801 · boardsService',
  ],
  'lib/services/boardsService.ts#workItemRepository.findColumnCards': [
    'unbound-call-site',
    'MOTIR-2801 · boardsService',
  ],
  'lib/services/boardsService.ts#workflowsRepository.findStatusById': [
    'unbound-call-site',
    'MOTIR-2801 · boardsService',
  ],
  'lib/services/commentsService.ts#commentRepository.countByWorkItem': [
    'unbound-call-site',
    'MOTIR-2846 · commentsService',
  ],
  'lib/services/commentsService.ts#commentRepository.countByWorkItemIds': [
    'unbound-call-site',
    'MOTIR-2846 · commentsService',
  ],
  'lib/services/commentsService.ts#commentRepository.listThreadsByWorkItem': [
    'unbound-call-site',
    'MOTIR-2846 · commentsService',
  ],
  'lib/services/componentsService.ts#componentRepository.listByWorkItem': [
    'unbound-call-site',
    'MOTIR-2809 · componentsService',
  ],
  'lib/services/customFieldValuesService.ts#customFieldDefinitionRepository.findById': [
    'unbound-call-site',
    'MOTIR-2846 · customFieldValuesService',
  ],
  'lib/services/dashboardsService.ts#dashboardRepository.findByIdWithFacts': [
    'unbound-call-site',
    'MOTIR-2809 · dashboardsService',
  ],
  'lib/services/designEvidenceService.ts#workspaceRepository.findById': [
    'unbound-call-site',
    'MOTIR-2846 · designEvidenceService',
  ],
  'lib/services/dispatchPromptService.ts#workItemRepository.findById': [
    'unbound-call-site',
    'MOTIR-2809 · dispatchPromptService',
  ],
  'lib/services/entitlementsService.ts#attachmentRepository.sumSizeByOrganization': [
    'unbound-call-site',
    'MOTIR-2809 · entitlementsService',
  ],
  'lib/services/importService.ts#importRepository.findById': [
    'unbound-call-site',
    'MOTIR-2846 · importService',
  ],
  'lib/services/labelsService.ts#labelRepository.listByWorkItem': [
    'unbound-call-site',
    'MOTIR-2809 · labelsService',
  ],
  'lib/services/mentionNotificationsService.ts#commentRepository.findById': [
    'unbound-call-site',
    'MOTIR-2846 · mentionNotificationsService',
  ],
  'lib/services/migrateOnboardingService.ts#migrateOnboardingRepository.findById': [
    'unbound-call-site',
    'MOTIR-2810 · migrateOnboardingService',
  ],
  'lib/services/migrateOnboardingService.ts#migrateOnboardingRepository.findByProjectId': [
    'unbound-call-site',
    'MOTIR-2810 · migrateOnboardingService',
  ],
  'lib/services/migrateOnboardingService.ts#workItemRepository.findByProject': [
    'unbound-call-site',
    'MOTIR-2810 · migrateOnboardingService',
  ],
  'lib/services/notificationFanInService.ts#commentRepository.findById': [
    'unbound-call-site',
    'MOTIR-2846 · notificationFanInService',
  ],
  'lib/services/planChangeSessionsService.ts#planChangeSessionRepository.findByProjectAndScope': [
    'unbound-call-site',
    'MOTIR-2846 · planChangeSessionsService',
  ],
  'lib/services/planChangeSessionsService.ts#planChangeTurnRepository.listBySessionId': [
    'unbound-call-site',
    'MOTIR-2846 · planChangeSessionsService',
  ],
  'lib/services/planReviewService.ts#workItemRepository.findByIdsInWorkspace': [
    'unbound-call-site',
    'MOTIR-2846 · planReviewService',
  ],
  'lib/services/planStalenessService.ts#planItemRepository.findByPlan': [
    'unbound-call-site',
    'MOTIR-2808 · planStalenessService',
  ],
  'lib/services/planStalenessService.ts#planRepository.findById': [
    'unbound-call-site',
    'MOTIR-2808 · planStalenessService',
  ],
  'lib/services/planStalenessService.ts#workItemRepository.findByIdsInWorkspace': [
    'unbound-call-site',
    'MOTIR-2808 · planStalenessService',
  ],
  'lib/services/planValidityService.ts#sprintRepository.findActiveByProject': [
    'unbound-call-site',
    'MOTIR-2808 · planValidityService',
  ],
  'lib/services/planValidityService.ts#workItemRepository.findByIdsInWorkspace': [
    'unbound-call-site',
    'MOTIR-2808 · planValidityService',
  ],
  'lib/services/plansService.ts#planItemRepository.countByPlanIds': [
    'unbound-call-site',
    'MOTIR-2846 · plansService',
  ],
  'lib/services/plansService.ts#planItemRepository.findByPlan': [
    'unbound-call-site',
    'MOTIR-2846 · plansService',
  ],
  'lib/services/plansService.ts#planRepository.findById': [
    'unbound-call-site',
    'MOTIR-2846 · plansService',
  ],
  'lib/services/plansService.ts#planRepository.listByProject': [
    'unbound-call-site',
    'MOTIR-2846 · plansService',
  ],
  'lib/services/projectAccessService.ts#projectMembershipRepository.countByRole': [
    'unbound-call-site',
    'MOTIR-2846 · projectAccessService',
  ],
  'lib/services/projectAccessService.ts#projectMembershipRepository.countByRoleDefinition': [
    'unbound-call-site',
    'MOTIR-2846 · projectAccessService',
  ],
  'lib/services/projectRepoSetService.ts#projectRepoRepository.findById': [
    'unbound-call-site',
    'MOTIR-2846 · projectRepoSetService',
  ],
  'lib/services/projectRepoTakeoverService.ts#projectRepoRepository.findById': [
    'unbound-call-site',
    'MOTIR-2846 · projectRepoTakeoverService',
  ],
  'lib/services/projectStateService.ts#migrateOnboardingRepository.findByProjectId': [
    'unbound-call-site',
    'MOTIR-2846 · projectStateService',
  ],
  'lib/services/proseGraphAdvisoryService.ts#projectRepository.findByWorkspace': [
    'unbound-call-site',
    'MOTIR-2846 · proseGraphAdvisoryService',
  ],
  'lib/services/proseGraphAdvisoryService.ts#workItemRepository.findAncestors': [
    'unbound-call-site',
    'MOTIR-2846 · proseGraphAdvisoryService',
  ],
  'lib/services/proseGraphAdvisoryService.ts#workItemRepository.findByIdsInWorkspace': [
    'unbound-call-site',
    'MOTIR-2846 · proseGraphAdvisoryService',
  ],
  'lib/services/publicProjectsService.ts#projectRepository.findById': [
    'public-arm',
    'the public pages read with app.workspace_id UNSET',
  ],
  'lib/services/publicProjectsService.ts#workItemRepository.countProjectIssues': [
    'public-arm',
    'the public pages read with app.workspace_id UNSET',
  ],
  'lib/services/publicProjectsService.ts#workItemRepository.countPublicProjectTreeLevel': [
    'public-arm',
    'the public pages read with app.workspace_id UNSET',
  ],
  'lib/services/publicProjectsService.ts#workItemRepository.findByIdentifier': [
    'public-arm',
    'the public pages read with app.workspace_id UNSET',
  ],
  'lib/services/publicProjectsService.ts#workItemRepository.findByProject': [
    'public-arm',
    'the public pages read with app.workspace_id UNSET',
  ],
  'lib/services/publicProjectsService.ts#workItemRepository.findColumnCards': [
    'public-arm',
    'the public pages read with app.workspace_id UNSET',
  ],
  'lib/services/publicProjectsService.ts#workItemRepository.findPublicHiddenDescendantIds': [
    'public-arm',
    'the public pages read with app.workspace_id UNSET',
  ],
  'lib/services/publicProjectsService.ts#workItemRepository.findPublicProjectTreeLevel': [
    'public-arm',
    'the public pages read with app.workspace_id UNSET',
  ],
  'lib/services/publicRequestsService.ts#workItemRepository.findById': [
    'unbound-call-site',
    'MOTIR-2846 · publicRequestsService',
  ],
  'lib/services/sprintsService.ts#sprintRepository.findActiveByProject': [
    'unbound-call-site',
    'MOTIR-2804 · sprintsService',
  ],
  'lib/services/sprintsService.ts#sprintRepository.listByProject': [
    'unbound-call-site',
    'MOTIR-2804 · sprintsService',
  ],
  'lib/services/sprintsService.ts#sprintRepository.maxSequenceForProject': [
    'unbound-call-site',
    'MOTIR-2804 · sprintsService',
  ],
  'lib/services/sprintsService.ts#workItemRepository.countSprintIssues': [
    'unbound-call-site',
    'MOTIR-2804 · sprintsService',
  ],
  'lib/services/sprintsService.ts#workItemRepository.countSprintIssuesByDoneMembership': [
    'unbound-call-site',
    'MOTIR-2804 · sprintsService',
  ],
  'lib/services/sprintsService.ts#workItemRepository.findSprintIssuesByDoneMembership': [
    'unbound-call-site',
    'MOTIR-2804 · sprintsService',
  ],
  'lib/services/sprintsService.ts#workItemRepository.findSprintIssuesExcludingStatuses': [
    'unbound-call-site',
    'MOTIR-2804 · sprintsService',
  ],
  'lib/services/triageService.ts#workItemRepository.findById': [
    'unbound-call-site',
    'MOTIR-2846 · triageService',
  ],
  'lib/services/triageService.ts#workItemRepository.findTriageQueue': [
    'unbound-call-site',
    'MOTIR-2846 · triageService',
  ],
  'lib/services/watcherNotificationsService.ts#commentRepository.findById': [
    'unbound-call-site',
    'MOTIR-2846 · watcherNotificationsService',
  ],
  'lib/services/workItemsService.ts#componentRepository.findByIds': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#componentRepository.listByWorkItem': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#customFieldDefinitionRepository.listByProject': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#labelRepository.listByWorkItem': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#projectRepository.findByWorkspace': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#sprintRepository.findActiveByProject': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#sprintRepository.findById': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#sprintRepository.listByProject': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemLinkRepository.findById': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.countArchivedByProject': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.countLiveDescendantsByKind': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.countProjectIssues': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.countProjectTreeLevel': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.countRoadmapProgress': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.findAncestors': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.findArchivedByProject': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.findById': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.findByIdentifier': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.findByIdentifiers': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.findByProjectAndKinds': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.findByProjectFiltered': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.findByProjectKindAndTitle': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.findChildren': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.findProjectForest': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.findProjectIssuesFlat': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.findProjectIssuesKeyset': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.findProjectTreeLevel': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workItemsService.ts#workItemRepository.findSubtree': [
    'unbound-call-site',
    'MOTIR-2802/2803 · workItemsService',
  ],
  'lib/services/workflowsService.ts#workflowsRepository.findStatusById': [
    'unbound-call-site',
    'MOTIR-2846 · workflowsService',
  ],
  'lib/services/workflowsService.ts#workflowsRepository.findStatusByKey': [
    'unbound-call-site',
    'MOTIR-2846 · workflowsService',
  ],
  'lib/services/workflowsService.ts#workflowsRepository.findStatuses': [
    'unbound-call-site',
    'MOTIR-2846 · workflowsService',
  ],
  'lib/services/workflowsService.ts#workflowsRepository.findStatusesByProjects': [
    'unbound-call-site',
    'MOTIR-2846 · workflowsService',
  ],
  'lib/services/workflowsService.ts#workflowsRepository.findTransition': [
    'unbound-call-site',
    'MOTIR-2846 · workflowsService',
  ],
  'lib/services/workflowsService.ts#workflowsRepository.findTransitionById': [
    'unbound-call-site',
    'MOTIR-2846 · workflowsService',
  ],
  'lib/services/workflowsService.ts#workflowsRepository.findTransitions': [
    'unbound-call-site',
    'MOTIR-2846 · workflowsService',
  ],
  'lib/workItems/resolveWorkItemRefs.ts#projectRepository.findByWorkspace': [
    'unbound-call-site',
    'MOTIR-2846 · resolveWorkItemRefs',
  ],
  'lib/workItems/resolveWorkItemRefs.ts#workItemRepository.findByIdentifiers': [
    'unbound-call-site',
    'MOTIR-2846 · resolveWorkItemRefs',
  ],
  'lib/workItems/resolveWorkItemRefs.ts#workItemRepository.findByIdsInWorkspace': [
    'unbound-call-site',
    'MOTIR-2846 · resolveWorkItemRefs',
  ],
};

/**
 * The ratchet, MEASURED by the scan on the commit that shipped this guard — not
 * transcribed from a card. Counts SITES, not entries, because a file that calls
 * one read from three places has three things to fix.
 *
 * ⚠️ May only ever go DOWN. If a change makes this fail, bind the call — never
 * raise the ceiling. MOTIR-2846 drives it to zero.
 *
 * 205 = 183 `no-context` + 22 `in-bare-transaction`. The second number is the
 * sharper one: those reads DO share a transaction, so they look bound in review,
 * and it binds no GUCs.
 */
const UNBOUND_CALL_SITE_CEILING = 205;

/**
 * Service functions opening a bare `db.$transaction`, which binds nothing.
 *
 * Tracked separately from the sites above because it is the CAUSE rather than an
 * instance: one bare transaction darkens every read inside it, and a `tx` handed
 * from one into `readProject` / `readProjectByIdentifier` is precisely what
 * `lib/workspaces/tenantRead.ts` warns against — *"Do not pass a transaction that
 * binds no GUCs … the read would see NULL context and return the same false miss
 * this function exists to remove."*
 *
 * Not every one is a defect: a transaction over non-gated tables is fine. The
 * number is pinned so the population cannot GROW while MOTIR-2846 works through
 * it.
 */
const BARE_TRANSACTION_CEILING = 60;

describe('call sites of bindable tenant reads are all accounted for', () => {
  it('every unbound site has a verdict, and every verdict names a real site', () => {
    const scanned = [...new Set(unboundCallSites().map((c) => c.key))].sort();
    const declared = Object.keys(CALL_SITE_VERDICTS).sort();

    const undeclared = scanned.filter((k) => !declared.includes(k));
    const stale = declared.filter((k) => !scanned.includes(k));

    // Two messages, because the two failures need opposite fixes.
    expect(
      undeclared,
      'A service calls a BINDABLE read of a policy-gated table without giving it a ' +
        'transaction. Under the non-bypass role that read returns ZERO ROWS AND RAISES ' +
        'NOTHING, so the caller reports "missing" for a row that exists. Either pass the ' +
        '`tx` (the fix is usually one argument) or add an entry here saying why the read ' +
        'must stay unbound.',
    ).toEqual([]);
    expect(
      stale,
      'CALL_SITE_VERDICTS names a site the scanner no longer finds. If you bound or ' +
        'deleted the call, delete its entry too — a stale allowlist hides the next one.',
    ).toEqual([]);
  });

  it('the unbound call-site count only ever falls', () => {
    const sites = unboundCallSites();
    expect(
      sites.length,
      `${sites.length} call sites invoke a bindable gated read with no bound transaction ` +
        `(ceiling ${UNBOUND_CALL_SITE_CEILING}). If this ROSE, a new caller joined the ` +
        'class — pass the `tx` rather than adding an entry. If it FELL, lower the ceiling ' +
        'in the same commit.',
    ).toBeLessThanOrEqual(UNBOUND_CALL_SITE_CEILING);
  });

  it('the bare-transaction count only ever falls', () => {
    const bare = bareTransactionSites();
    expect(
      bare.length,
      `${bare.length} service functions open a bare \`db.$transaction\` (ceiling ` +
        `${BARE_TRANSACTION_CEILING}). It binds no GUCs, so every gated read inside one ` +
        'is dark while LOOKING bound. Use withWorkspaceContext / ' +
        'withWorkspaceServiceContext instead.',
    ).toBeLessThanOrEqual(BARE_TRANSACTION_CEILING);
  });

  it('every unbound-call-site verdict names the card that owns the fix', () => {
    // The value is the unit of work, not a comment: MOTIR-2846 is planned
    // against it, and a verdict reading `?` would quietly drop the site.
    const nameless = Object.entries(CALL_SITE_VERDICTS)
      .filter(([, [verdict]]) => verdict === 'unbound-call-site')
      .filter(([, [, reason]]) => !/^MOTIR-\d+(\/\d+)? · \w+$/.test(reason))
      .map(([key, [, reason]]) => `${key} -> "${reason}"`);

    expect(
      nameless,
      'An `unbound-call-site` verdict must name the owning card and service ' +
        '(e.g. `MOTIR-2801 · boardsService`), because that is the unit the binding ' +
        'work is planned in.',
    ).toEqual([]);
  });

  it('the public-arm sites are exactly publicProjectsService', () => {
    // The one verdict where BINDING would be the regression. Pinned to the file,
    // so a `public-arm` verdict cannot quietly spread to a tenant path as a way
    // of making this guard pass.
    const elsewhere = Object.entries(CALL_SITE_VERDICTS)
      .filter(([, [verdict]]) => verdict === 'public-arm')
      .filter(([key]) => !key.startsWith('lib/services/publicProjectsService.ts#'));

    expect(
      elsewhere.map(([k]) => k),
      '`public-arm` means the read MUST run with `app.workspace_id` unset, which is ' +
        'true of the public project pages and nothing else yet. Adding it elsewhere ' +
        'needs the policy to actually carry a public arm — check `pg_policies` first.',
    ).toEqual([]);
  });

  it('the scanner rules correctly on a fixture carrying every position', () => {
    // THE NEGATIVE CASE, as a permanent test rather than a one-off check, and run
    // against a fixture ROOT so proving the detector works can never leave a
    // stray unbound read in a real service.
    const root = 'tests/rls/__fixtures__/callSites';
    const byPosition = new Map(
      scanCallSites(root).map((c) => [`${c.read}@${c.line}`, c.position] as const),
    );
    const positions = [...byPosition.values()];

    // Pinned INDIVIDUALLY. One `toEqual` over the set would pass for the wrong
    // reason the day the scan returns nothing at all.
    expect(positions.filter((p) => p === 'receives-tx')).toHaveLength(2);
    expect(positions.filter((p) => p === 'in-context')).toHaveLength(1);
    expect(positions.filter((p) => p === 'in-bare-transaction')).toHaveLength(1);
    expect(positions.filter((p) => p === 'no-context')).toHaveLength(2);

    // And the three shapes that must NOT be reported at all:
    const reads = [...byPosition.keys()].map((k) => k.split('@')[0]);
    expect(reads, 'a read of a non-gated model has no policy to be blind to').not.toContain(
      'fixtureRepository.findGlobalSetting',
    );
    expect(reads, 'an UNBINDABLE read is the singleton scan`s class, not this one').not.toContain(
      'fixtureRepository.findWidgetUnbindable',
    );
    expect(bareTransactionSites(root)).toHaveLength(1);
  });

  it('the scanner actually finds the reads it is pointed at (a live negative)', () => {
    // A scanner that silently returns nothing passes forever. Pin that it walks
    // the repositories, resolves the schema, and finds known sites.
    const all = scanCallSites();
    expect(all.length).toBeGreaterThan(200);
    expect(all.some((c) => c.position === 'receives-tx')).toBe(true);
    expect(all.some((c) => c.position === 'no-context')).toBe(true);
  });

  it('is calibrated against the three defects that were found by hand', () => {
    // A detector that misses a bug we already know about is not calibrated.
    // These three were each discovered by a red suite during MOTIR-2796's run,
    // before this scanner existed (`notes.html` #266).
    const declared = new Set(Object.keys(CALL_SITE_VERDICTS));

    // (1) backlogService — its gate reads sit outside its own withWorkspaceContext.
    expect(
      [...declared].filter((k) => k.startsWith('lib/services/backlogService.ts#')).length,
      'backlogService accounted for 49 failures in tests/integration/sprints on its own',
    ).toBeGreaterThan(0);

    // (2) workItemsService.updateStatus — a bare `db.$transaction`.
    expect(
      bareTransactionSites().some((s) => s.file === 'lib/services/workItemsService.ts'),
      'workItemsService opens bare transactions that bind no GUCs',
    ).toBe(true);

    // (3) savedFilterSubscriptionsService — ALREADY FIXED under MOTIR-2805, so the
    //     calibration here is the inverse: the scan must now report it CLEAN.
    //     A scanner that still flagged a repaired file would be measuring the file
    //     rather than the defect.
    expect(
      [...declared].filter((k) => k.startsWith('lib/services/savedFilterSubscriptionsService.ts#')),
      'MOTIR-2805 bound this file; the scan should no longer report it',
    ).toEqual([]);
  });
});
