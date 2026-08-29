import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STRUCTURAL_GUARD_SPECS } from './structuralGuardLane';

// The Vitest leg plan (MOTIR-3912) — file→leg membership derived from MEASURED
// per-file cost, not from Vitest's `--shard=i/8` slice.
//
// WHY this exists. Vitest's own `--shard=i/n` is cost-blind, and it is worth
// saying precisely what it does because the intuitive answer is wrong: it is NOT
// an alphabetical slice. `BaseSequencer.shard()` sorts the specs by the SHA1 of
// their path and slices that — a fixed pseudo-random partition.
//
// On run 33251966134, the first 8-shard run, that draw put **19 of the 30 most
// expensive files in the suite on leg 6**: 2562s of test time against a 1458s
// mean, and the run's critical path. The legs' FILE COUNTS were even to within
// one; only the cost was not.
//
// ⚠️ THAT IS AN IMPROBABLE DRAW, AND THE REASON TO FIX IT RATHER THAN RE-ROLL IS
// THAT IT IS FROZEN. The hash is stable, so the same partition — and the same
// long pole — recurs on every run for the same file set; nothing about it drifts
// back toward balance. Replaying the sha1 slice offline against that run's
// measurements reproduces its per-leg costs (1323/1012/1353/1324/1452/2562/
// 1359/1279s) to within rounding, which is how the mechanism was confirmed
// rather than guessed at.
//
// So membership is computed here instead: `FILE_TEST_SECONDS` records what the
// expensive files actually cost and `assignLegs` bin-packs them across the legs
// (longest-processing-time first — the standard greedy makespan heuristic,
// deterministic and total). Simulated against the same run's measurements, the
// real spread drops from 2.52x to 1.03x.
//
// ⚠️ THIS DELIBERATELY DOES NOT COPY `tests/e2e/shard-plan.ts`'s GUARD, and the
// difference is the whole design. That file's guard fails the build when a spec
// has no measured cost entry, which is right for ~80 Playwright specs added a
// few a month and WRONG for 1364 unit-test files added continuously — copied
// over, it would fail every pull request that adds a test until somebody
// hand-measured it. The dependency is inverted here:
//
//   • Membership is computed from the file list DISCOVERED ON DISK, never from
//     the cost table's keys. Totality is therefore STRUCTURAL: every file that
//     exists is packed onto exactly one leg whether or not anyone measured it.
//     A file cannot be silently skipped by being absent from a table.
//   • Cost is a lookup WITH A DEFAULT. An unmeasured file gets
//     `DEFAULT_TEST_SECONDS`, lands on a leg, and runs. It costs a little
//     balance — never a red build, and never a skipped test.
//
// Consumed by `tests/helpers/vitestShardSequencer.ts`, which `vitest.collect.config.ts`
// installs as the run's sequencer — see that file for why the membership is
// applied there and NOT by narrowing `test.include`, which is the obvious move
// and a 7x performance bug. Guarded by
// `tests/vitest-shard-plan.test.ts`, which runs in the STRUCTURAL-GUARD lane
// rather than the sharded suite — a guard that rode on a leg would be a guard
// this plan could assign away, and the plan is what it exists to check.

/** The legs, in matrix order. */
export const VITEST_LEG_IDS = ['1', '2', '3', '4', '5', '6', '7', '8'] as const;

export type VitestLegId = (typeof VITEST_LEG_IDS)[number];

/**
 * The suite's non-test per-file overhead, in seconds — what a file costs a
 * worker BESIDES running its tests.
 *
 * Derived from run 33251966134's eight leg summaries:
 * `(import 2259.6s + transform 224.0s + environment 133.7s) / 1364 files`.
 *
 * ⚠️ IT IS A FLAT CONSTANT AND THE REAL THING IS NOT FLAT. Import ran 0.87s per
 * file on leg 2 and 2.01s on leg 5, because what a file costs to import depends
 * on which modules it pulls in — and Vitest reports import per LEG, never per
 * file, so a per-file number cannot be recovered from a run at all. This
 * over-charges the light files and under-charges the heavy ones. It is a first
 * approximation, it is far better than counting files, and it is written down
 * here so the next reader does not mistake it for a measurement it is not.
 */
export const PER_FILE_OVERHEAD_SECONDS = 1.92;

/**
 * The cost assumed for a file with no entry in `FILE_TEST_SECONDS` — the mean
 * measured test time across all 1364 files on run 33251966134.
 *
 * Two populations share this default and they want different numbers, which is
 * why the higher one wins. The files deliberately OMITTED from the table below
 * (everything under 10s) average 2.14s, so 8.6 over-charges them. A file that is
 * genuinely NEW could cost anything. Over-estimating is the safe direction for a
 * bin-packer — an under-charged heavy file is exactly the imbalance this module
 * exists to remove — and it costs nothing measurable here: packing the same run
 * with a 2.14s default instead produced a 1.035x spread against 8.6's 1.034x.
 */
export const DEFAULT_TEST_SECONDS = 8.6;

/**
 * MEASURED per-file cost, in seconds of in-file test execution.
 *
 * Source: the eight `Vitest (n/8)` job logs of run **33251966134** (2026-08-29,
 * PR #2453, green), taking each file's reported duration from the default
 * reporter's per-file line. Vitest attributes hook time to the test it runs for,
 * so this includes each file's `beforeEach` truncate and seeding, not just its
 * assertions.
 *
 * ⚠️ ONLY FILES AT OR ABOVE 10s ARE LISTED — 436 of 1364. This is a deliberate
 * truncation, not an incomplete measurement: everything below 10s takes
 * `DEFAULT_TEST_SECONDS`. The cheap files are numerous and uniform, so they
 * spread evenly whatever number they are given, and listing them would quadruple
 * this table's size and its churn for no balance. Simulated on the same run:
 *
 *   | table          | entries | resulting real spread |
 *   | -------------- | ------- | --------------------- |
 *   | every file     |    1364 |                1.001x |
 *   | >= 2s          |     731 |                1.008x |
 *   | **>= 10s**     | **436** |            **1.034x** |
 *   | >= 20s         |     174 |                1.058x |
 *
 * All four are far inside the tolerance the guard asserts, and all four are far
 * from the 2.52x this replaces. 10s is the middle of that curve: it keeps enough
 * headroom for the flat-overhead approximation above to be wrong without the
 * balance mattering.
 *
 * TO RE-MEASURE: take a green run's eight `Vitest (n/8)` logs and read the
 * per-file durations off the default reporter's lines. Re-measure whenever the
 * observed spread climbs — the guard checks this table against itself, so it
 * cannot tell you the table has gone stale. That is what the first green run of
 * any change here is for.
 */
export const FILE_TEST_SECONDS: Readonly<Record<string, number>> = {
  'tests/acceptance-evidence-publish-route.test.ts': 12.3,
  'tests/account-deletion-schedule.test.ts': 37.2,
  'tests/account-erasure-preview.test.ts': 22.9,
  'tests/account-erasure-sweep.test.ts': 21.2,
  'tests/ai/askGate.test.ts': 16.8,
  'tests/ai/askRoutes.test.ts': 28.0,
  'tests/ai/contextualPlanningRoutes.test.ts': 16.3,
  'tests/ai/contextualPlanningService.test.ts': 36.9,
  'tests/ai/planChangePlannerTurn.test.ts': 18.1,
  'tests/ai/planChangeSessionsCoverage.test.ts': 10.8,
  'tests/ai/planChangeSessionsService.test.ts': 15.7,
  'tests/ai/planChangeTurnIntent.test.ts': 13.9,
  'tests/ai/projectRepoContext.test.ts': 11.6,
  'tests/ai/serviceAuth.test.ts': 12.1,
  'tests/ai/work-items-route.test.ts': 20.9,
  'tests/aiConventionService.test.ts': 20.5,
  'tests/api-ai-plan-sprint-route.test.ts': 11.4,
  'tests/api-coding-convention-route.test.ts': 29.0,
  'tests/api-tokens/api-tokens-routes.test.ts': 16.3,
  'tests/api-tokens/apiTokensService.test.ts': 43.5,
  'tests/api/live-projects-route.test.ts': 14.9,
  'tests/api/twoFactorApiRefusal.test.ts': 13.3,
  'tests/api/v1/activity-route.test.ts': 19.9,
  'tests/api/v1/attachments-route.test.ts': 13.8,
  'tests/api/v1/cli-renderers-from-v1.test.ts': 16.1,
  'tests/api/v1/cli-transport-seams.test.ts': 15.4,
  'tests/api/v1/dispatch-prompt-repo-set.test.ts': 11.4,
  'tests/api/v1/dispatch-prompt-route.test.ts': 23.1,
  'tests/api/v1/plan-routes.test.ts': 18.5,
  'tests/api/v1/plan-session-routes.test.ts': 19.9,
  'tests/api/v1/planning-coverage-topup.test.ts': 11.8,
  'tests/api/v1/project-repositories-route.test.ts': 26.8,
  'tests/api/v1/projects-route.test.ts': 18.8,
  'tests/api/v1/ranked-collections-routes.test.ts': 11.7,
  'tests/api/v1/rate-limit.test.ts': 14.5,
  'tests/api/v1/ready-route.test.ts': 24.4,
  'tests/api/v1/scope-claim-route.test.ts': 18.6,
  'tests/api/v1/session-close-out-routes.test.ts': 27.7,
  'tests/api/v1/shared-store.test.ts': 26.2,
  'tests/api/v1/sprint-lifecycle-routes.test.ts': 24.8,
  'tests/api/v1/sprint-membership-routes.test.ts': 16.0,
  'tests/api/v1/sprint-write-routes.test.ts': 18.0,
  'tests/api/v1/sprints-route.test.ts': 17.9,
  'tests/api/v1/story-gate.test.ts': 13.0,
  'tests/api/v1/work-item-archive-route.test.ts': 10.1,
  'tests/api/v1/work-item-collection-route.test.ts': 24.4,
  'tests/api/v1/work-item-comments-route.test.ts': 20.2,
  'tests/api/v1/work-item-conformance.test.ts': 18.7,
  'tests/api/v1/work-item-detail-route.test.ts': 10.4,
  'tests/api/v1/work-item-edge-projections.test.ts': 16.3,
  'tests/api/v1/work-item-links-route.test.ts': 15.6,
  'tests/api/v1/work-item-plan-approval-route.test.ts': 12.6,
  'tests/api/v1/work-item-story-gate.test.ts': 14.9,
  'tests/api/v1/work-item-write-routes.test.ts': 24.6,
  'tests/api/v1/work-loop-conformance.test.ts': 18.8,
  'tests/api/v1/work-loop-story-gate.test.ts': 16.7,
  'tests/api/v1/workspaces-route.test.ts': 11.9,
  'tests/api/v1/wrapper.test.ts': 14.8,
  'tests/app-role-bound-context-reads.test.ts': 49.2,
  'tests/appearance/service.test.ts': 10.1,
  'tests/attachments/acceptance-evidence-service.test.ts': 10.3,
  'tests/attachments/attachment-repository.test.ts': 20.0,
  'tests/attachments/attachments-management.test.ts': 24.5,
  'tests/attachments/attachments-service.test.ts': 11.6,
  'tests/attachments/design-evidence-service.test.ts': 28.6,
  'tests/attachments/link-on-write.test.ts': 24.0,
  'tests/auth/passkey-plugin.test.ts': 12.1,
  'tests/auth/session-request-memo.test.ts': 18.8,
  'tests/authEmailStrictEnqueue.test.ts': 11.0,
  'tests/automation/automation-engine.test.ts': 26.3,
  'tests/automation/automation-epic5.test.ts': 11.5,
  'tests/automation/automation-events.test.ts': 14.3,
  'tests/automation/automation-rules-service.test.ts': 29.7,
  'tests/automation/automation-story.test.ts': 21.1,
  'tests/billingService.test.ts': 86.8,
  'tests/boards/at-scale-scrum-fixture.test.ts': 10.8,
  'tests/boards/board-config-service.test.ts': 16.5,
  'tests/boards/board-crud-routes.test.ts': 15.2,
  'tests/boards/board-crud-service.test.ts': 13.0,
  'tests/boards/board-routes.test.ts': 14.4,
  'tests/boards/column-config-routes.test.ts': 22.7,
  'tests/boards/column-config-service.test.ts': 19.6,
  'tests/boards/filtered-projection.test.ts': 10.5,
  'tests/boards/move-card.test.ts': 12.5,
  'tests/boards/projection.test.ts': 14.3,
  'tests/boards/repositories.test.ts': 13.3,
  'tests/boards/scrum-projection.test.ts': 11.3,
  'tests/ci-e2e-setup-timeout.test.ts': 11.2,
  'tests/ciFleet/ciFleetCostMeterService.test.ts': 42.1,
  'tests/ciFleet/ciRunnerAdmissionService.test.ts': 24.8,
  'tests/ciFleet/ciRunnerAdmissionWake.test.ts': 12.7,
  'tests/ciFleet/ciRunnerBootService.test.ts': 44.7,
  'tests/ciFleet/ciRunnerHotPathTrigger.test.ts': 12.7,
  'tests/ciFleet/ciRunnerProvisioningService.test.ts': 16.6,
  'tests/ciFleet/codeGraphIndexAdmission.test.ts': 44.7,
  'tests/ciFleet/fleetCeiling.test.ts': 25.5,
  'tests/ciFleet/fleetStoryGate.test.ts': 44.7,
  'tests/ciFleet/projectRunnerGroupService.test.ts': 26.3,
  'tests/ciMetering/ci-minutes-meter-rls.test.ts': 12.3,
  'tests/ciMetering/ciActionsGateService.test.ts': 14.8,
  'tests/ciMetering/ciAllowanceService.test.ts': 23.7,
  'tests/ciMetering/ciFleetReconciliation.test.ts': 12.6,
  'tests/ciMetering/ciMinutesMeterService.test.ts': 32.6,
  'tests/cli/cli-connect-story.test.ts': 17.9,
  'tests/cli/cli-device-routes.test.ts': 18.4,
  'tests/cli/cli-findings-story.test.ts': 91.7,
  'tests/cli/cli-multi-repo-story.test.ts': 20.1,
  'tests/cli/cli-story.test.ts': 123.4,
  'tests/cli/cli-v1-story.test.ts': 17.3,
  'tests/cli/cliDeviceService.test.ts': 29.9,
  'tests/cli/generated-api-freshness.test.ts': 15.8,
  'tests/code-health-page.test.ts': 13.1,
  'tests/codeGraphOffboardingQueue.test.ts': 20.9,
  'tests/comments/commentsService.test.ts': 30.8,
  'tests/comments/repositories.test.ts': 13.5,
  'tests/custom-fields/definitionsService.test.ts': 27.9,
  'tests/custom-fields/repositories.test.ts': 17.6,
  'tests/design-evidence-routes.test.ts': 36.4,
  'tests/dispatch/dispatchAdvisories.test.ts': 54.4,
  'tests/dispatch/dispatchPrompt.test.ts': 47.7,
  'tests/dispatch/subsumptionAdvisory.test.ts': 59.4,
  'tests/email-change.test.ts': 17.3,
  'tests/embeddings/workItemEmbeddingRanking.test.ts': 43.6,
  'tests/embeddings/workItemEmbeddingRls.test.ts': 10.6,
  'tests/embeddings/workItemEmbeddingsService.test.ts': 20.2,
  'tests/entitlementsService.test.ts': 38.2,
  'tests/export/dataExportService.test.ts': 12.7,
  'tests/github/cancelledSuiteSupersession.test.ts': 10.9,
  'tests/github/changeRequestArtifactEvidenceGate.test.ts': 12.5,
  'tests/github/changeRequestDeliverySetGate.test.ts': 13.9,
  'tests/github/changeRequestRepoSetGate.test.ts': 16.8,
  'tests/github/changeRequestSessionCloseOut.test.ts': 14.1,
  'tests/github/changeRequestTrunkGate.test.ts': 10.6,
  'tests/github/ciFeedbackCommentPerCard.test.ts': 12.6,
  'tests/github/ciGreenPromotion.test.ts': 30.9,
  'tests/github/codeGraphFirstIndexRecovery.test.ts': 12.6,
  'tests/github/deliveryReaderMigration.test.ts': 18.1,
  'tests/github/deliverySetStory.test.ts': 10.1,
  'tests/github/explicitLinkStory.test.ts': 12.1,
  'tests/github/explicitPrLink.test.ts': 14.5,
  'tests/github/githubCiFeedback.test.ts': 23.1,
  'tests/github/githubIdentityService.test.ts': 13.0,
  'tests/github/githubInstallationService.test.ts': 13.0,
  'tests/github/githubWebhookEdges.test.ts': 29.2,
  'tests/github/githubWebhookService.test.ts': 28.6,
  'tests/github/mergedPullRequestCapture.test.ts': 27.0,
  'tests/github/sharedInstallationTenancy.test.ts': 11.0,
  'tests/github/unlinkedPullRequestCheck.test.ts': 21.3,
  'tests/gitlab/gitlabWebhookEdges.test.ts': 19.1,
  'tests/gitlab/gitlabWebhookService.test.ts': 25.4,
  'tests/hosting/blobSeam.test.ts': 13.7,
  'tests/import/importPersistService.test.ts': 13.1,
  'tests/import/importService.test.ts': 66.0,
  'tests/import/jira-oauth-routes.test.ts': 17.7,
  'tests/import/linear-oauth-routes.test.ts': 14.1,
  'tests/import/plane-oauth-routes.test.ts': 15.5,
  'tests/integration/acceptance-flow.test.ts': 11.1,
  'tests/integration/acceptance-freeze-seam.test.ts': 12.1,
  'tests/integration/ai/abandonedPlanSweep.test.ts': 83.3,
  'tests/integration/ai/aiSprintPlanReview.test.ts': 13.2,
  'tests/integration/ai/aiSprintPlanning.test.ts': 24.4,
  'tests/integration/ai/autoPlanCadence.test.ts': 79.0,
  'tests/integration/ai/generationProposals.test.ts': 20.9,
  'tests/integration/ai/planEditProposals.test.ts': 16.7,
  'tests/integration/ai/planPermissionGate.test.ts': 16.0,
  'tests/integration/ai/planRevisionRoutes.test.ts': 26.1,
  'tests/integration/ai/projectAiSettings.test.ts': 20.1,
  'tests/integration/ai/projectAiSettingsRoutes.test.ts': 15.4,
  'tests/integration/ai/readbackDepth.test.ts': 19.2,
  'tests/integration/ai/readbackDepthRoutes.test.ts': 16.9,
  'tests/integration/ai/searchWorkItemsRoute.test.ts': 15.7,
  'tests/integration/ai/semanticSearchStoryGate.test.ts': 11.1,
  'tests/integration/ai/similarWorkItemsRoute.test.ts': 25.0,
  'tests/integration/ai/story713CoverageGate.test.ts': 20.5,
  'tests/integration/ai/submitRevise.test.ts': 12.0,
  'tests/integration/ai/validatePlanRoutes.test.ts': 15.5,
  'tests/integration/auditCoverageStory.test.ts': 10.5,
  'tests/integration/backlog/filter.test.ts': 14.6,
  'tests/integration/code-graph-offboarding-seam.test.ts': 11.2,
  'tests/integration/dashboards/dashboards.test.ts': 31.4,
  'tests/integration/epic6-at-scale.test.ts': 30.6,
  'tests/integration/epic6-journey.test.ts': 21.0,
  'tests/integration/estimation/service.test.ts': 25.1,
  'tests/integration/github/historical-pr-backfill.test.ts': 10.4,
  'tests/integration/github/pr-base-ref-backfill.test.ts': 25.6,
  'tests/integration/home/personal-reads.test.ts': 38.6,
  'tests/integration/home/story-seams.test.ts': 12.6,
  'tests/integration/implemented-lifecycle.test.ts': 13.3,
  'tests/integration/import/importSeam.test.ts': 25.1,
  'tests/integration/import/repository.test.ts': 12.0,
  'tests/integration/linkClonesCheckoutsStoryGate.test.ts': 10.4,
  'tests/integration/migrations/clear-cancelled-manual-provenance.test.ts': 17.7,
  'tests/integration/migrations/retire-spurious-project-repo-rows.test.ts': 16.4,
  'tests/integration/notifications-journey.test.ts': 22.2,
  'tests/integration/plan-seed/onboarding-marker.test.ts': 11.5,
  'tests/integration/planning/contextualPlanningConfirmGate.test.ts': 32.7,
  'tests/integration/planning/planChangeSeams.test.ts': 18.9,
  'tests/integration/planning/planChangeSessionRls.test.ts': 12.9,
  'tests/integration/planning/planningTargetLockGate.test.ts': 20.2,
  'tests/integration/plans/agentAuthoredPlanSeams.test.ts': 11.8,
  'tests/integration/plans/approvePersistGate.test.ts': 27.6,
  'tests/integration/plans/approvePlanTargetRepo.test.ts': 19.8,
  'tests/integration/plans/approvePlanTargetRepoRole.test.ts': 19.5,
  'tests/integration/plans/approveTransactionBudget.test.ts': 10.0,
  'tests/integration/plans/authoringGates.test.ts': 16.2,
  'tests/integration/plans/correctAndWithdrawProposal.test.ts': 24.0,
  'tests/integration/plans/modifyReparent.test.ts': 18.2,
  'tests/integration/plans/planAuthorship.test.ts': 12.6,
  'tests/integration/plans/planDrift.test.ts': 15.1,
  'tests/integration/plans/planReviewService.test.ts': 39.7,
  'tests/integration/plans/planRevisions.test.ts': 20.7,
  'tests/integration/plans/planRowView.test.ts': 13.4,
  'tests/integration/plans/planStalenessService.test.ts': 23.9,
  'tests/integration/plans/planStatusStale.test.ts': 12.7,
  'tests/integration/plans/planTimelineMerge.test.ts': 10.9,
  'tests/integration/plans/planValidityService.test.ts': 44.7,
  'tests/integration/plans/plansService.test.ts': 125.8,
  'tests/integration/plans/plansSurfaceStorySeams.test.ts': 15.1,
  'tests/integration/plans/proposalTypeEnum.test.ts': 10.5,
  'tests/integration/plans/revisionLease.test.ts': 13.6,
  'tests/integration/projectImageUploadRoute.test.ts': 14.8,
  'tests/integration/projectRepos/repositorySetRoutes.test.ts': 27.0,
  'tests/integration/projectRepos/repositorySetStoryGate.test.ts': 12.1,
  'tests/integration/reports/velocity.test.ts': 16.8,
  'tests/integration/reports/widget-gating.test.ts': 12.5,
  'tests/integration/repositoryReferenceStoryGate.test.ts': 13.6,
  'tests/integration/repositorySetStoryGate.test.ts': 11.0,
  'tests/integration/run-findings/policy-round-trip.test.ts': 19.6,
  'tests/integration/saved-filters/saved-filters.test.ts': 81.7,
  'tests/integration/saved-filters/subscriptions.test.ts': 13.3,
  'tests/integration/sprints/backlog.test.ts': 18.3,
  'tests/integration/sprints/bulk.test.ts': 18.8,
  'tests/integration/sprints/complete-sprint.test.ts': 14.9,
  'tests/integration/sprints/data-model.test.ts': 11.2,
  'tests/integration/sprints/permission-gate.test.ts': 28.8,
  'tests/integration/sprints/repository.test.ts': 25.4,
  'tests/integration/sprints/service.test.ts': 14.6,
  'tests/integration/sprints/sprint-filter.test.ts': 12.1,
  'tests/integration/sprints/sprint-report.test.ts': 10.4,
  'tests/integration/sprints/start-sprint.test.ts': 13.8,
  'tests/integration/twoFactorEnforcementStoryGate.test.ts': 19.9,
  'tests/integration/twoFactorSeam.test.ts': 13.8,
  'tests/integration/work-items/activity-all.test.ts': 13.7,
  'tests/integration/work-items/activity.test.ts': 28.2,
  'tests/integration/work-items/archived-list.test.ts': 12.9,
  'tests/integration/work-items/custom-field-values.test.ts': 49.5,
  'tests/integration/work-items/delete.test.ts': 19.0,
  'tests/integration/work-items/epic5-filter-predicates.test.ts': 21.7,
  'tests/integration/work-items/filter-compiler.test.ts': 18.2,
  'tests/integration/work-items/issue-detail.test.ts': 17.8,
  'tests/integration/work-items/issue-list-view.test.ts': 22.3,
  'tests/integration/work-items/keyset-list-read.test.ts': 17.6,
  'tests/integration/work-items/kind-parent-matrix.test.ts': 38.1,
  'tests/integration/work-items/link-repository.test.ts': 49.2,
  'tests/integration/work-items/project-roadmap.test.ts': 25.8,
  'tests/integration/work-items/project-tree.test.ts': 21.8,
  'tests/integration/work-items/provenance-backfill-gate.test.ts': 13.6,
  'tests/integration/work-items/provenance-backfill.test.ts': 16.6,
  'tests/integration/work-items/provenance-seams.test.ts': 13.7,
  'tests/integration/work-items/quick-search.test.ts': 21.9,
  'tests/integration/work-items/repository.test.ts': 25.6,
  'tests/integration/work-items/revisions.test.ts': 28.2,
  'tests/integration/work-items/roadmap-sprint-scope-seam.test.ts': 12.9,
  'tests/integration/work-items/roadmap-sprint-scope.test.ts': 15.4,
  'tests/integration/work-items/service-edge-cases.test.ts': 28.2,
  'tests/integration/work-items/service.test.ts': 71.1,
  'tests/integration/work-items/tree-lazy-read.test.ts': 12.8,
  'tests/integration/work-items/work-item-todos.test.ts': 46.0,
  'tests/integration/work-items/work-item-type-executor.test.ts': 14.4,
  'tests/integration/work-items/work-item-type-story-gate.test.ts': 13.8,
  'tests/integration/work-items/workspace-scoped-reads.test.ts': 15.0,
  'tests/integration/workflows/childStatusCascade.test.ts': 47.4,
  'tests/integration/workflows/parentStatusRollup.test.ts': 68.2,
  'tests/integration/workflows/projectStatusAutomation.test.ts': 12.4,
  'tests/integration/workflows/statusDerivation.test.ts': 74.0,
  'tests/jobs/attachment-gc.test.ts': 12.3,
  'tests/jobs/ci-runner-fleet.test.ts': 18.8,
  'tests/jobs/ci-runner-self-rescheduling.test.ts': 10.5,
  'tests/jobs/code-graph-index-first-audit.test.ts': 13.1,
  'tests/jobs/code-graph-index-self-rescheduling.test.ts': 13.8,
  'tests/jobs/code-graph-index.test.ts': 41.1,
  'tests/jobs/emit-seam.test.ts': 23.4,
  'tests/jobs/engine-debounce.test.ts': 15.8,
  'tests/jobs/engine-defer.test.ts': 12.6,
  'tests/jobs/engine-ledger.test.ts': 10.4,
  'tests/jobs/engine-scheduler.test.ts': 13.8,
  'tests/jobs/engine-schema.test.ts': 19.6,
  'tests/jobs/engine-step-shim.test.ts': 15.1,
  'tests/jobs/engine-story-gate.test.ts': 12.1,
  'tests/jobs/engine-units.test.ts': 38.8,
  'tests/jobs/engine-worker.test.ts': 51.2,
  'tests/jobs/event-cutover-story-gate.test.ts': 20.5,
  'tests/jobs/job-supervision-repository.test.ts': 21.4,
  'tests/jobs/mention-notify.test.ts': 20.2,
  'tests/jobs/notification-fan-in.test.ts': 23.8,
  'tests/jobs/rls.test.ts': 11.9,
  'tests/jobs/self-rescheduling-supervision-story-gate.test.ts': 15.0,
  'tests/jobs/status-derivation.test.ts': 13.5,
  'tests/jobs/supervision-driver.test.ts': 12.5,
  'tests/jobs/supervision-sweep.test.ts': 22.2,
  'tests/jobs/supervisor-cutover-story-gate.test.ts': 13.2,
  'tests/jobs/watcher-notify.test.ts': 26.2,
  'tests/labels-components-watch/componentsService.test.ts': 37.9,
  'tests/labels-components-watch/labelsService.test.ts': 33.6,
  'tests/labels-components-watch/repositories.test.ts': 13.0,
  'tests/labels-components-watch/watchersService.test.ts': 30.8,
  'tests/last-active-project.test.ts': 19.8,
  'tests/mcp/attachFileTool.test.ts': 12.4,
  'tests/mcp/author-plan.test.ts': 38.5,
  'tests/mcp/comment-counts.test.ts': 31.2,
  'tests/mcp/correct-plan-proposal.test.ts': 12.7,
  'tests/mcp/dependency-edges.test.ts': 36.5,
  'tests/mcp/expand-item.test.ts': 25.9,
  'tests/mcp/get-plan.test.ts': 29.3,
  'tests/mcp/get-project-state.test.ts': 16.7,
  'tests/mcp/get-work-item-activity.test.ts': 17.1,
  'tests/mcp/integration-state.test.ts': 19.6,
  'tests/mcp/link-tools.test.ts': 11.6,
  'tests/mcp/linkPullRequest.test.ts': 25.4,
  'tests/mcp/move-to-parent.test.ts': 11.3,
  'tests/mcp/payload-seams.test.ts': 15.6,
  'tests/mcp/permission-gate.test.ts': 10.2,
  'tests/mcp/plan-projection-gate.test.ts': 11.6,
  'tests/mcp/plan-session.test.ts': 33.8,
  'tests/mcp/projected-reads.test.ts': 17.3,
  'tests/mcp/publishDesignResultTool.test.ts': 21.3,
  'tests/mcp/publishDesignResultTransport.test.ts': 13.9,
  'tests/mcp/rate-limit-gate.test.ts': 16.8,
  'tests/mcp/reinforceLessonTool.test.ts': 10.4,
  'tests/mcp/reinforceLessonTransport.test.ts': 11.9,
  'tests/mcp/search-work-items-semantic.test.ts': 11.7,
  'tests/mcp/search.test.ts': 10.9,
  'tests/mcp/searchLessonsTransport.test.ts': 16.2,
  'tests/mcp/story-roundtrip.test.ts': 24.2,
  'tests/mcp/tool-coverage.test.ts': 16.7,
  'tests/mcp/two-surface-conformance.test.ts': 27.0,
  'tests/mcp/unlinkPullRequest.test.ts': 12.1,
  'tests/mcp/validate-plan.test.ts': 32.9,
  'tests/mcp/validate-sprint.test.ts': 26.6,
  'tests/mcp/validate-work-item.test.ts': 62.5,
  'tests/mcp/write-tools.test.ts': 18.2,
  'tests/migrate-onboarding/migrate-index-sweep.test.ts': 13.0,
  'tests/migrate-onboarding/migrate-onboarding-service.test.ts': 52.5,
  'tests/migrate-onboarding/migrate-terminal-reconciliation.test.ts': 24.6,
  'tests/notifications/notification-preferences.test.ts': 10.7,
  'tests/notifications/notificationsService.test.ts': 14.9,
  'tests/notifications/repositories.test.ts': 20.6,
  'tests/organization-rls.test.ts': 15.2,
  'tests/organizations-service.test.ts': 16.2,
  'tests/organizations-tier.test.ts': 12.0,
  'tests/passkeyBoundaryContract.test.ts': 11.6,
  'tests/permissions/assertPermission.integration.test.ts': 26.1,
  'tests/permissions/customRolesStoryGate.integration.test.tsx': 12.2,
  'tests/permissions/getPermissions.integration.test.ts': 43.4,
  'tests/permissions/lessonSeam.integration.test.ts': 22.8,
  'tests/permissions/memberFacingGate.integration.test.ts': 17.1,
  'tests/permissions/membershipGate.test.ts': 26.8,
  'tests/permissions/projectRoleDefinitionService.test.ts': 33.4,
  'tests/permissions/publicProjectAccess.test.ts': 30.6,
  'tests/permissions/roleDefinitionRoutes.test.ts': 24.6,
  'tests/permissions/rolesStoryGate.integration.test.ts': 17.3,
  'tests/permissions/storyGate.integration.test.ts': 51.9,
  'tests/permissions/tenantRead.test.ts': 10.1,
  'tests/permissions/userlessTenantRead.test.ts': 16.4,
  'tests/planning/planTargetLockService.test.ts': 35.4,
  'tests/platform/platformAuditLog.test.ts': 10.5,
  'tests/platform/platformHealthService.test.ts': 22.1,
  'tests/platform/platformSupportService.test.ts': 15.4,
  'tests/profile-service.test.ts': 11.7,
  'tests/project-access-service.test.ts': 66.9,
  'tests/project-alias-resolution.test.ts': 14.7,
  'tests/project-details-service.test.ts': 28.0,
  'tests/project-members-service.test.ts': 27.9,
  'tests/project-membership-rls.test.ts': 10.3,
  'tests/project-role-definition-rls.test.ts': 17.3,
  'tests/projectRepos/effectiveRepoDomain.test.ts': 11.8,
  'tests/projectRepos/projectRepoAccessService.test.ts': 17.4,
  'tests/projectRepos/projectRepoEstablishView.test.ts': 22.2,
  'tests/projectRepos/projectRepoProposalService.test.ts': 22.5,
  'tests/projectRepos/projectRepoProvisioningService.test.ts': 26.2,
  'tests/projectRepos/projectRepoSetService.test.ts': 38.6,
  'tests/projectRepos/projectRepoTakeoverService.test.ts': 25.9,
  'tests/projectRepos/projectRepoTeamAccess.test.ts': 26.3,
  'tests/projectRepos/takeoverRoom.test.ts': 21.5,
  'tests/projectSquare/projectSquareDirectory.test.ts': 14.4,
  'tests/projectSquare/projectSquareGuarantees.test.ts': 33.4,
  'tests/projectSquare/projectSquareRanking.test.ts': 14.1,
  'tests/projectSquare/projectSquareSearchFilter.test.ts': 11.2,
  'tests/projectSquare/projectTagsService.test.ts': 12.8,
  'tests/projects-service.test.ts': 29.5,
  'tests/publicProjects/epicPrivacyEnforcement.test.ts': 11.5,
  'tests/publicProjects/epicPrivacyGuarantee.test.ts': 14.7,
  'tests/publicProjects/publicAccessAndProjection.test.ts': 15.3,
  'tests/publicProjects/publicChangelog.test.ts': 17.6,
  'tests/publicProjects/publicFollowDigest.test.ts': 12.2,
  'tests/publicProjects/publicFollowSchema.test.ts': 12.0,
  'tests/publicProjects/publicFollowService.test.ts': 20.0,
  'tests/publicProjects/publicSubmit.test.ts': 17.8,
  'tests/ready/claimNextReady.test.ts': 14.4,
  'tests/ready/claimScope.test.ts': 31.9,
  'tests/ready/claimWorkItem.test.ts': 47.1,
  'tests/ready/dispatchTargetRepo.test.ts': 21.9,
  'tests/ready/expansionNudge.test.ts': 17.1,
  'tests/ready/listReady.test.ts': 48.1,
  'tests/ready/projectScopedDispatchRepo.test.ts': 53.9,
  'tests/ready/ready-routes.test.ts': 21.1,
  'tests/ready/readyScopeFacets.test.ts': 17.3,
  'tests/resend/resendWebhookRoute.test.ts': 17.0,
  'tests/rls/other-context-arm-guard.test.ts': 19.0,
  'tests/rls/shared-read-seams.test.ts': 23.0,
  'tests/rls/tx-fallback-arm.test.ts': 19.9,
  'tests/settings/settings-area-access-matrix.test.ts': 104.8,
  'tests/tokens/story-gate.test.ts': 10.6,
  'tests/triage/triageActions.test.ts': 12.0,
  'tests/twoFactorPolicy.test.ts': 28.5,
  'tests/twoFactorService.test.ts': 17.2,
  'tests/users-service.test.ts': 14.3,
  'tests/users/dataSubjectRequests.test.ts': 14.0,
  'tests/work-item-rls.test.ts': 32.1,
  'tests/work-item-todo-actions.test.ts': 21.6,
  'tests/work-items/quick-view-story-gate.test.ts': 11.1,
  'tests/work-items/work-item-mention-relate.test.ts': 31.0,
  'tests/workItems/repoReferenceWritePath.test.ts': 22.0,
  'tests/workItems/repoRollup.test.ts': 20.3,
  'tests/workItems/repositorySetReadSeams.test.ts': 14.7,
  'tests/workItems/targetRepoSetWritePath.test.ts': 15.5,
  'tests/workflows/container-completeness-gate.test.ts': 17.7,
  'tests/workflows/default-workflow.test.ts': 16.1,
  'tests/workflows/implemented-status.test.ts': 26.0,
  'tests/workflows/management.test.ts': 17.7,
  'tests/workflows/planning-status.test.ts': 27.6,
  'tests/workflows/read-api.test.ts': 20.1,
  'tests/workflows/readiness.test.ts': 22.8,
  'tests/workflows/rls.test.ts': 12.3,
  'tests/workflows/transition-validation.test.ts': 10.2,
  'tests/workspaces-service.test.ts': 19.3,
};

/** The repository root, resolved from this module rather than `process.cwd()`. */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Every test file the sharded suite can run, as repo-relative POSIX paths,
 * sorted.
 *
 * ⚠️ THIS GLOB AND ITS EXCLUSION MUST MATCH `vitest.config.ts`'s `include` /
 * `exclude` EXACTLY, and `tests/vitest-shard-plan.test.ts` asserts that they do.
 * They are the same statement made twice: the config decides what the suite
 * runs, this decides how it is divided, and a file the division cannot see is a
 * file that never runs on any leg — silently, because a leg that was given
 * fewer files still passes.
 */
export function discoverTestFiles(root: string = REPO_ROOT): string[] {
  const guards = new Set<string>(STRUCTURAL_GUARD_SPECS);
  return globSync('tests/**/*.test.{ts,tsx}', { cwd: root })
    .map((f) => f.split('\\').join('/'))
    .filter((f) => !guards.has(f))
    .sort();
}

/** What a file is assumed to cost a worker, in seconds — tests plus overhead. */
export function costSeconds(file: string): number {
  return (FILE_TEST_SECONDS[file] ?? DEFAULT_TEST_SECONDS) + PER_FILE_OVERHEAD_SECONDS;
}

/**
 * Bin-pack the files across the legs by cost — longest-processing-time first:
 * walk them from most to least expensive and hand each to the leg with the
 * least load so far.
 *
 * Deterministic by construction: the sort tie-breaks on the file name and the
 * leg choice tie-breaks on matrix order, so the same inputs always yield the
 * same assignment. That is load-bearing rather than tidy — all eight legs
 * compute this INDEPENDENTLY, on their own runner, and a non-deterministic
 * packer would silently drop or double-run files with every leg still green.
 */
export function assignLegs(
  files: readonly string[] = discoverTestFiles(),
  legIds: readonly string[] = VITEST_LEG_IDS,
): Record<string, string[]> {
  const assignment: Record<string, string[]> = {};
  const load: number[] = [];
  for (const id of legIds) {
    assignment[id] = [];
    load.push(0);
  }
  const ordered = [...files].sort((a, b) => {
    const delta = costSeconds(b) - costSeconds(a);
    return delta !== 0 ? delta : a.localeCompare(b);
  });
  for (const file of ordered) {
    let pick = 0;
    for (let i = 1; i < legIds.length; i++) {
      if ((load[i] ?? 0) < (load[pick] ?? 0)) pick = i;
    }
    assignment[legIds[pick] as string]?.push(file);
    load[pick] = (load[pick] ?? 0) + costSeconds(file);
  }
  for (const id of legIds) assignment[id]?.sort();
  return assignment;
}

/** The test files assigned to `legId`, or `null` when it is not a leg. */
export function filesForLeg(legId: string): string[] | null {
  return assignLegs()[legId] ?? null;
}

/** The total assumed cost of a leg, in seconds. */
export function legCostSeconds(legId: string): number {
  return (filesForLeg(legId) ?? []).reduce((sum, f) => sum + costSeconds(f), 0);
}
