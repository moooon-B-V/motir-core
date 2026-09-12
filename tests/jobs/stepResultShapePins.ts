// MOTIR-5022 — the PINNED result shape of every memoized step, by id.
//
// ── What a pin is, and what it buys ─────────────────────────────────────────
// A `step.run(id, fn)` result is stored in `job_step` under `(run_id, id)` and
// returned on replay WITHOUT executing the step. The id therefore identifies a
// unit of work across a DEPLOY, and the stored value is only as current as the
// revision that wrote it. Change what a step returns while keeping its id, and
// a run that resumes across the deploy replays the old JSON into the new
// reader. Nothing in the type system can see it: the reader's static type is
// the new one, and the boundary is JSON.
//
// Each entry below is that step's result shape AS OF THE ID IT CARRIES.
// `tests/jobs/step-result-shape-guard.test.ts` recomputes every one of them
// from the tree and fails on any disagreement, so the change that used to reach
// production silently now fails a test with the two shapes side by side.
//
// ── How to update this file, and the decision it is asking you for ──────────
// The guard failing is the question *did you mean to change what this step
// RETURNS?*, and it has exactly two honest answers:
//
//   • **The shape change is real** ⇒ the step needs a NEW ID. Bump it
//     (`resolve-target` → `resolve-target-v2`), move the OLD id into
//     `RETIRED_STEP_IDS` with its shape, and add the new id here. That is what
//     makes the stale row unreadable, which is the whole fix.
//   • **The shape did not really change** — a type was renamed, a field's
//     declaration moved, an alias was inlined ⇒ paste the computed shape from
//     the failure message over the old one. The diff of THIS FILE is then the
//     reviewable record that the members are the same.
//
// ⚠️ THERE IS NO THIRD ANSWER, and the tempting one is "bump the pin because
// the run needs to be green". A pin edited without the id bump records that a
// shape changed and asserts nothing about the memos already in `job_step`.
//
// ⚠️ AND BUMPING AN ID IS NOT FREE EVERYWHERE — read
// `lib/jobs/engine/step.ts`'s test before you do it. A new id means the step
// RE-EXECUTES on a resumed run. That is correct for a read (`resolve-target-v2`
// is DB reads only, which is why MOTIR-5020 could bump it) and WRONG for
// anything that provisions, claims or tears down: bumping `index-boot:` would
// bill a second container rather than re-attach to the first. Where the step
// has an external effect, the answer is to keep the id and make the REPLAYED
// value safe at the boundary — `requireCurrentIndexTarget` in
// `lib/services/codeGraphIndexService.ts` is the worked example — and to record
// that here rather than in a commit message.
//
// ── The format ──────────────────────────────────────────────────────────────
// The key is the step id AS WRITTEN: a literal's text, or a template's source
// text (`` `index-admit:${projectId}` ``). Editing a template IS a change of
// id, so pinning its source is the right granularity. The shape is the
// structural fingerprint `tests/jobs/stepResultShapes.ts` computes — members
// sorted, expanded through every type declared in this repository, stopping at
// library types by name. It is generated, not written by hand; the guard's
// failure message prints the string to paste.

/** One memoized step's result shape, as of the id it carries. */
export interface StepShapePin {
  /** Where the id is written, repo-relative. A move is a review moment, so it is asserted. */
  readonly file: string;
  /** The structural fingerprint of the awaited result. */
  readonly shape: string;
}

/** A step id that is OUT OF USE, and may never be used again with another shape. */
export interface RetiredStepId {
  /** The shape the memos written under this id carry — what a replay would hand a reader. */
  readonly shape: string;
  /** The id that replaced it. */
  readonly supersededBy: string;
  /** Why it was retired. */
  readonly reason: string;
}

/**
 * Every live memoized step, by id.
 *
 * 57 entries over 65 call sites: an id used at several sites in one handler is
 * pinned once, and the guard requires those sites to agree.
 */
export const LIVE_STEP_SHAPES: Record<string, StepShapePin> = {
  '`index-admit:${projectId}`': {
    file: 'lib/services/codeGraphIndexDispatchService.ts',
    shape:
      '{ admission: { admittedAt: string; detail: string; slotRef: string }; admittedAt: string; census: { byWorkload: { ci_runner: number; code_graph_index: number; hosted_agent: number }; total: number }; outcome: "admitted"; requestedAt: string } | { admission: { admittedAt: string; detail: string; slotRef: string }; admittedAt: string; outcome: "already_held"; requestedAt: string } | { admittedAt: string; detail: string; outcome: "deferred"; reason: "fleet_ceiling" | "gate_unavailable" | "index_cap" | "repo_index_in_flight" | "workspace_index_cap"; requestedAt: string }',
  },
  '`index-boot:${projectId}`': {
    file: 'lib/services/codeGraphIndexDispatchService.ts',
    shape:
      '{ outcome: { billableSeconds: number; containerId: string; coreTimings?: undefined | { phasesMs: { admissionWait?: number | undefined; boot?: number | undefined; pollToDetect?: number | undefined }; totalMs?: number | undefined }; costUsd: string; failureDetail: null | string; indexMode?: "rebuild" | "sync" | undefined; outcome: "settled"; reason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; usage: { billableSeconds: number; costUsd: string; cpuKind: "performance" | "shared"; cpus: number; createdAt: Date; handleId: string; memoryMb: number; orgId: string; projectId: string; provider: "arc" | "fake" | "fly" | "runs_on"; rateEffectiveFrom: Date | null; region: string; repoFullName: null | string; slices?: Array<{ projectId: string; repoFullName: string; seconds: number; sliceRef: string }> | undefined; startedAt: Date | null; stoppedAt: Date; teardownReason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; terminalState: string; usdPerSecond: string; workflowJobId: null | number; workload: "ci_runner" | "code_graph_index" | "hosted_agent"; workspaceId: string }; verdict: { detail: string; exitClass: "credential_refused" | "dispatch_malformed" | "exit_unobserved" | "graph_unbuildable" | "indexed" | "never_started" | "out_of_memory" | "pointer_unrecorded" | "repo_unfetchable" | "supervision_timed_out" | "unclassified" | "upload_failed"; exitCode: null | number; indexed: boolean; redispatchable: boolean } } | { detail: string; outcome: "admission_deferred"; reason: "fleet_ceiling" | "gate_unavailable" | "index_cap" | "repo_index_in_flight" | "workspace_index_cap" } | { detail: string; outcome: "image_unpullable" } | { detail: string; outcome: "provision_failed" } | { detail: string; outcome: "teardown_failed" }; phase: "terminal" } | { phase: "supervising"; session: { attribution: { orgId: string; projectId: string; repoFullName: string; workspaceId: string }; bootedAt: string; credentialExpiresAt: string; dispatchId: string; handle: { createdAt: string; id: string; provider: "arc" | "fake" | "fly" | "runs_on"; region: string }; repoRef: string; runId: string; slotRef: string; syncGranted?: false | true | undefined } }',
  },
  '`index-settle:${projectId}`': {
    file: 'lib/services/codeGraphIndexDispatchService.ts',
    shape:
      '{ billableSeconds: number; containerId: string; coreTimings?: undefined | { phasesMs: { admissionWait?: number | undefined; boot?: number | undefined; pollToDetect?: number | undefined }; totalMs?: number | undefined }; costUsd: string; failureDetail: null | string; indexMode?: "rebuild" | "sync" | undefined; outcome: "settled"; reason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; usage: { billableSeconds: number; costUsd: string; cpuKind: "performance" | "shared"; cpus: number; createdAt: Date; handleId: string; memoryMb: number; orgId: string; projectId: string; provider: "arc" | "fake" | "fly" | "runs_on"; rateEffectiveFrom: Date | null; region: string; repoFullName: null | string; slices?: Array<{ projectId: string; repoFullName: string; seconds: number; sliceRef: string }> | undefined; startedAt: Date | null; stoppedAt: Date; teardownReason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; terminalState: string; usdPerSecond: string; workflowJobId: null | number; workload: "ci_runner" | "code_graph_index" | "hosted_agent"; workspaceId: string }; verdict: { detail: string; exitClass: "credential_refused" | "dispatch_malformed" | "exit_unobserved" | "graph_unbuildable" | "indexed" | "never_started" | "out_of_memory" | "pointer_unrecorded" | "repo_unfetchable" | "supervision_timed_out" | "unclassified" | "upload_failed"; exitCode: null | number; indexed: boolean; redispatchable: boolean } } | { detail: string; outcome: "admission_deferred"; reason: "fleet_ceiling" | "gate_unavailable" | "index_cap" | "repo_index_in_flight" | "workspace_index_cap" } | { detail: string; outcome: "image_unpullable" } | { detail: string; outcome: "provision_failed" } | { detail: string; outcome: "teardown_failed" }',
  },
  '`recompute-parent-${i}`': {
    file: 'lib/jobs/definitions/statusDerivation.ts',
    shape:
      '{ outcome: "access_denied"; parentId: string } | { outcome: "already_there"; parentId: string; toStatus: string } | { outcome: "illegal_transition"; parentId: string; toStatus: string } | { outcome: "no_matching_status"; parentId: string } | { outcome: "no_parent" } | { outcome: "no_rung"; parentId: string } | { outcome: "rolled_back"; parentId: string; toStatus: string } | { outcome: "rolled_up"; parentId: string; toStatus: string; via?: Array<string> | undefined } | { outcome: "same_rung"; parentId: string; toStatus: string } | { outcome: "stale_backward"; parentId: string; toStatus: string } | { outcome: "toggle_off"; parentId: string } | { outcome: "unresolvable" }',
  },
  'advance-wedged-index-runs': {
    file: 'lib/jobs/definitions/migrateOnboardingSweep.ts',
    shape: '{ advanced: number; failed: number; scanned: number }',
  },
  'assert-pending': {
    file: 'lib/jobs/definitions/ciActionsGateSweep.ts',
    shape: '{ applied: number; failed: number }',
  },
  'boot-runner': {
    file: 'lib/services/ciRunnerBootService.ts',
    shape:
      '{ outcome: { billableSeconds: number; bootLatencyMs: null | number; containerId: string; costUsd: string; outcome: "settled"; reason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; usage: { billableSeconds: number; costUsd: string; cpuKind: "performance" | "shared"; cpus: number; createdAt: Date; handleId: string; memoryMb: number; orgId: string; projectId: string; provider: "arc" | "fake" | "fly" | "runs_on"; rateEffectiveFrom: Date | null; region: string; repoFullName: null | string; slices?: Array<{ projectId: string; repoFullName: string; seconds: number; sliceRef: string }> | undefined; startedAt: Date | null; stoppedAt: Date; teardownReason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; terminalState: string; usdPerSecond: string; workflowJobId: null | number; workload: "ci_runner" | "code_graph_index" | "hosted_agent"; workspaceId: string } } | { detail: string; outcome: "gate_deferred"; reason: "ci_credits_exhausted" | "fleet_ceiling" | "gate_unavailable" | "project_cap" } | { detail: string; outcome: "image_unpullable" } | { detail: string; outcome: "no_runner_group" } | { detail: string; outcome: "provision_failed" } | { outcome: "already_claimed" } | { outcome: "not_configured" } | { outcome: "rate_limited"; retryAfterSeconds: null | number } | { outcome: "unknown_intent" }; phase: "terminal" } | { phase: "supervising"; session: { attribution: { orgId: string; projectId: string; repoFullName: string; workflowJobId: number; workspaceId: string }; bootedAt: string; githubRunnerId: null | number; handle: { createdAt: string; id: string; provider: "arc" | "fake" | "fly" | "runs_on"; region: string }; intentId: string; queuedAt: string } }',
  },
  'build-archive': {
    file: 'lib/jobs/definitions/dataExportBuild.ts',
    shape:
      '{ bytes: number; counts: { [key: string]: number }; failureReason?: undefined; files: { missing: number; packaged: number }; requestId: string; status: "ready" } | { bytes?: undefined; counts?: undefined; failureReason: string; files?: undefined; requestId: string; status: "failed" }',
  },
  'cancel-offboarding': {
    file: 'lib/jobs/indexFleetSteps.ts',
    shape: '{ cancelled: number }',
  },
  'cascade-to-children': {
    file: 'lib/jobs/definitions/statusDerivation.ts',
    shape:
      '{ childIds: Array<string>; itemId: string; outcome: "cascaded"; postDatedIds?: Array<string> | undefined; toStatus: string } | { itemId: string; outcome: "access_denied" } | { itemId: string; outcome: "no_matching_status" } | { itemId: string; outcome: "no_open_children" } | { itemId: string; outcome: "post_dated_only"; postDatedIds: Array<string> } | { itemId: string; outcome: "toggle_off" } | { outcome: "not_done" } | { outcome: "unresolvable" }',
  },
  'deliver-digest': {
    file: 'lib/jobs/definitions/publicFollowDigestDeliver.ts',
    shape: '{ itemCount: number; sent: boolean }',
  },
  'deliver-subscription': {
    file: 'lib/jobs/definitions/filterSubscriptionDeliver.ts',
    shape:
      '{ count: number; recipient: string; status: "delivered"; total: number } | { reason: "filter_gone" | "filter_invalid" | "no_access" | "subscription_gone"; status: "skipped" }',
  },
  'derive-first-audit': {
    file: 'lib/jobs/definitions/codeGraphIndex.ts',
    shape:
      '{ outcomes: Array<{ projectId: string; reason?: "already_audited" | "coverage_unavailable" | "submit_failed" | undefined; status: "skipped" | "submitted" }>; repoRef: string; skipped?: "lookup_failed" | "no_owner" | "no_projects" | undefined; submitted: number }',
  },
  'dispatch-boots': {
    file: 'lib/jobs/definitions/ciRunnerFleet.ts',
    shape: '{ dispatched: number }',
  },
  'dispatch-outward-analysis': {
    file: 'lib/jobs/definitions/outwardBugTelemetry.ts',
    shape:
      '{ dispatched: boolean; jobId?: string | undefined; reason?: "ai-not-configured" | "meta-project" | "not-a-bug" | undefined }',
  },
  'drain-due-offboardings': {
    file: 'lib/jobs/definitions/codeGraphOffboardSweep.ts',
    shape:
      '{ coordinationRowsDeleted: number; due: number; failed: number; localRootsRemoved: number; offboarded: number; remaining: number; snapshotObjectsDeleted: number }',
  },
  'embed-work-item': {
    file: 'lib/jobs/definitions/workItemEmbedding.ts',
    shape:
      '{ embedded: boolean; model?: string | undefined; reason?: "ai-not-configured" | "not-found" | "unchanged" | undefined }',
  },
  'enqueue-due-deliveries': {
    file: 'lib/jobs/definitions/filterSubscriptionTick.ts',
    shape: '{ due: number; enqueued: number; hour: number; scanned: number }',
  },
  'enqueue-due-digests': {
    file: 'lib/jobs/definitions/publicFollowDigestTick.ts',
    shape: '{ enqueued: number; projects: number }',
  },
  'erase-due-accounts': {
    file: 'lib/jobs/definitions/accountErasureSweep.ts',
    shape:
      '{ blocked: number; erased: number; exportBlobFailures: Array<{ error: string; exportRequestId: string }>; exportsDeleted: number; failed: number; failures: Array<{ error: string; requestId: string }>; resumed: number; scanned: number; skipped: number; workspacesDeleted: number }',
  },
  'fleet-boot-preflight': {
    file: 'lib/jobs/definitions/dailyHealthCheck.ts',
    shape:
      '{ detail: string; reference: string; verdict: "indeterminate" } | { detail: string; reference: string; verdict: "unpullable" } | { detail: string; verdict: "not_applicable" } | { digest: null | string; reference: string; verdict: "bootable" }',
  },
  'index-allowance': {
    file: 'lib/jobs/indexFleetSteps.ts',
    shape:
      '{ outcome: null | string; proceed: true } | { outcome: string; proceed: false; reason: `paused_index_${string}` }',
  },
  'index-container-ai-address': {
    file: 'lib/jobs/definitions/dailyHealthCheck.ts',
    shape:
      '{ address: string; detail: string; verdict: "indeterminate" } | { address: string; detail: string; verdict: "private_address" } | { address: string; status: number; verdict: "reachable" } | { detail: string; verdict: "not_applicable" } | { detail: string; verdict: "unconfigured" }',
  },
  'index-rebuild-streak': {
    file: 'lib/jobs/definitions/dailyHealthCheck.ts',
    shape:
      '{ blindSpot: string; candidates: Array<string>; checkedAt: string; entries: Array<{ consecutiveRebuilds: number; modeRuns: number; repoRef: string; state: "rebuilding" | "syncing" | "unknown"; succeededRuns: number }>; offenders: Array<{ consecutiveRebuilds: number; modeRuns: number; repoRef: string; state: "rebuilding" | "syncing" | "unknown"; succeededRuns: number }>; threshold: number; unknownRepoRefs: Array<string>; verdict: "rebuilding" } | { blindSpot: string; checkedAt: string; detail: string; verdict: "not_applicable" } | { blindSpot: string; checkedAt: string; entries: Array<{ consecutiveRebuilds: number; modeRuns: number; repoRef: string; state: "rebuilding" | "syncing" | "unknown"; succeededRuns: number }>; threshold: number; unknownRepoRefs: Array<string>; verdict: "ok" }',
  },
  'index-fleet-boot-preflight': {
    file: 'lib/jobs/definitions/dailyHealthCheck.ts',
    shape:
      '{ detail: string; reference: string; verdict: "indeterminate" } | { detail: string; reference: string; verdict: "unpullable" } | { detail: string; verdict: "not_applicable" } | { digest: null | string; reference: string; verdict: "bootable" }',
  },
  'job-run:start': {
    file: 'lib/jobs/engine/ledger.ts',
    shape:
      'null | { attempt: number; delivery: null | { lastEventAt: null | string; providerMessageId: null | string; recipient: string; state: "accepted" | "bounced" | "complained" | "delayed" | "delivered"; template: string }; durationMs: null | number; eventId: string; eventName: string; failure: null | { code?: string | undefined; message: string; stack?: string | undefined }; finishedAt: null | string; functionId: string; id: string; idempotencyKey: null | string; lane: "engine" | "inngest"; output: unknown; startedAt: string; status: "abandoned" | "failed" | "running" | "succeeded"; workspaceId: null | string }',
  },
  'job-run:succeeded': {
    file: 'lib/jobs/engine/ledger.ts',
    shape:
      'null | { attempt: number; delivery: null | { lastEventAt: null | string; providerMessageId: null | string; recipient: string; state: "accepted" | "bounced" | "complained" | "delayed" | "delivered"; template: string }; durationMs: null | number; eventId: string; eventName: string; failure: null | { code?: string | undefined; message: string; stack?: string | undefined }; finishedAt: null | string; functionId: string; id: string; idempotencyKey: null | string; lane: "engine" | "inngest"; output: unknown; startedAt: string; status: "abandoned" | "failed" | "running" | "succeeded"; workspaceId: null | string }',
  },
  'list-pending-intents': {
    file: 'lib/jobs/definitions/ciRunnerFleet.ts',
    shape: 'Array<string>',
  },
  'mark-stale-for-terminal-target': {
    file: 'lib/jobs/definitions/planDrift.ts',
    shape: '{ markedStale: Array<string>; restored: Array<string>; skipped: Array<string> }',
  },
  'mention-fan-out': {
    file: 'lib/jobs/definitions/mentionNotify.ts',
    shape: '{ notifiedUserIds: Array<string> }',
  },
  'notification-fan-in': {
    file: 'lib/jobs/definitions/notificationFanIn.ts',
    shape: '{ writtenUserIds: Array<string> }',
  },
  'probe-boot': {
    file: 'lib/test-deferring-job.ts',
    shape: '{ bootedAt: string }',
  },
  'reap-abandoned-job-runs': {
    file: 'lib/jobs/definitions/jobRunReap.ts',
    shape: '{ abandoned: number; scanned: number; stillLive: number }',
  },
  'reap-orphaned-containers': {
    file: 'lib/jobs/definitions/ciRunnerFleet.ts',
    shape:
      '{ reaped: number; staleClaims: number; usages: Array<{ billableSeconds: number; costUsd: string; cpuKind: "performance" | "shared"; cpus: number; createdAt: Date; handleId: string; memoryMb: number; orgId: string; projectId: string; provider: "arc" | "fake" | "fly" | "runs_on"; rateEffectiveFrom: Date | null; region: string; repoFullName: null | string; slices?: Array<{ projectId: string; repoFullName: string; seconds: number; sliceRef: string }> | undefined; startedAt: Date | null; stoppedAt: Date; teardownReason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; terminalState: string; usdPerSecond: string; workflowJobId: null | number; workload: "ci_runner" | "code_graph_index" | "hosted_agent"; workspaceId: string }> }',
  },
  'recompute-code-graph-drift': {
    file: 'lib/jobs/definitions/codeGraphDriftSweep.ts',
    shape: '{ counted: number; indeterminate: number; scanned: number; skipped: number }',
  },
  'recompute-parent': {
    file: 'lib/jobs/definitions/statusDerivation.ts',
    shape:
      '{ outcome: "access_denied"; parentId: string } | { outcome: "already_there"; parentId: string; toStatus: string } | { outcome: "illegal_transition"; parentId: string; toStatus: string } | { outcome: "no_matching_status"; parentId: string } | { outcome: "no_parent" } | { outcome: "no_rung"; parentId: string } | { outcome: "rolled_back"; parentId: string; toStatus: string } | { outcome: "rolled_up"; parentId: string; toStatus: string; via?: Array<string> | undefined } | { outcome: "same_rung"; parentId: string; toStatus: string } | { outcome: "stale_backward"; parentId: string; toStatus: string } | { outcome: "toggle_off"; parentId: string } | { outcome: "unresolvable" }',
  },
  'reconcile-abandoned-plans': {
    file: 'lib/jobs/definitions/abandonedPlanSweep.ts',
    shape:
      '{ declined: number; outcomes: Array<{ outcome: "declined"; planId: string; projectId: string; reason: "job_gone" | "job_terminal" | "max_age" | "no_producer" } | { outcome: "left_as_is"; planId: string; projectId: string; reason: "ai_unreachable" | "job_in_flight" | "no_producer_recent" | "row_moved" }>; scanned: number }',
  },
  'reconcile-established-runs': {
    file: 'lib/jobs/definitions/migrateOnboardingSweep.ts',
    shape: '{ failed: number; scanned: number; terminated: number }',
  },
  'reconcile-fleet': {
    file: 'lib/jobs/definitions/ciMinutesReconcile.ts',
    shape:
      '{ discrepancies: Array<{ containerCount: number; containerMinutes: number; driftMinutes: number; exceedsTolerance: boolean; fleetJobCount: number; meteredMinutes: number; repoName: string }>; org: string; outcome: "reconciled"; periodStart: Date; repos: Array<{ containerCount: number; containerMinutes: number; driftMinutes: number; exceedsTolerance: boolean; fleetJobCount: number; meteredMinutes: number; repoName: string }> } | { outcome: "skipped"; reason: "metering_disabled" }',
  },
  'reconcile-github-billed': {
    file: 'lib/jobs/definitions/ciMinutesReconcile.ts',
    shape:
      '{ discrepancies: Array<{ driftMinutes: number; exceedsTolerance: boolean; meteredMinutes: number; repoName: string; reportedMinutes: number }>; month: number; org: string; outcome: "reconciled"; repos: Array<{ driftMinutes: number; exceedsTolerance: boolean; meteredMinutes: number; repoName: string; reportedMinutes: number }>; year: number } | { outcome: "skipped"; reason: "metering_disabled" | "no_billing_credential" }',
  },
  'refresh-certificates': {
    file: 'lib/jobs/definitions/publicAddressCertificateRefresh.ts',
    shape: '{ changed: number; failed: number; scanned: number; skipped: "not-configured" | null }',
  },
  'release-expired-planning-locks': {
    file: 'lib/jobs/definitions/planTargetLockSweep.ts',
    shape:
      '{ entries: Array<{ outcome: "left_as_is" | "restored" | "unattributable"; workItemId: string }>; released: number }',
  },
  'resolve-target-v2': {
    file: 'lib/jobs/indexFleetSteps.ts',
    shape:
      '{ anchorProjectId: string; indexed: true; organizationId: string; providerId: "github" | "gitlab"; repoRef: string } | { indexed: false; reason: "installation_missing" | "no_projects" | "provider_cannot_index" | "workspace_missing" }',
  },
  'restore-for-revived-target': {
    file: 'lib/jobs/definitions/planDrift.ts',
    shape: '{ markedStale: Array<string>; restored: Array<string>; skipped: Array<string> }',
  },
  'resync-disabled-orgs': {
    file: 'lib/jobs/definitions/ciActionsGateSweep.ts',
    shape: '{ organizations: number; synced: number }',
  },
  'roll-up-parent': {
    file: 'lib/jobs/definitions/statusDerivation.ts',
    shape:
      '{ outcome: "access_denied"; parentId: string } | { outcome: "already_there"; parentId: string; toStatus: string } | { outcome: "illegal_transition"; parentId: string; toStatus: string } | { outcome: "no_matching_status"; parentId: string } | { outcome: "no_parent" } | { outcome: "no_rung"; parentId: string } | { outcome: "rolled_back"; parentId: string; toStatus: string } | { outcome: "rolled_up"; parentId: string; toStatus: string; via?: Array<string> | undefined } | { outcome: "same_rung"; parentId: string; toStatus: string } | { outcome: "stale_backward"; parentId: string; toStatus: string } | { outcome: "toggle_off"; parentId: string } | { outcome: "unresolvable" }',
  },
  'run-rules': {
    file: 'lib/jobs/definitions/automationEngine.ts',
    shape:
      '{ deduped: number; failed: number; matched: number; noActions: number; skipped: boolean; succeeded: number }',
  },
  'schedule-health': {
    file: 'lib/jobs/definitions/dailyHealthCheck.ts',
    shape:
      '{ checkedAt: string; entries: Array<{ cron: string; functionId: string; judgedAgainst: null | string; lastRunAt: null | string }>; overdue: Array<{ cron: string; functionId: string; judgedAgainst: null | string; lastRunAt: null | string }> }',
  },
  send: {
    file: 'lib/jobs/definitions/emailSend.ts',
    shape:
      '{ providerMessageId: null | string; template: "automation-rule-failed" | "data-export-ready" | "email-change" | "filter-subscription" | "follow-confirm" | "follow-digest" | "mention-notification" | "password-reset" | "two-factor-otp" | "watcher-comment-notification" | "watcher-transition-notification" | "workspace-invite"; to: string }',
  },
  'settle-runner': {
    file: 'lib/services/ciRunnerBootService.ts',
    shape:
      '{ billableSeconds: number; bootLatencyMs: null | number; containerId: string; costUsd: string; outcome: "settled"; reason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; usage: { billableSeconds: number; costUsd: string; cpuKind: "performance" | "shared"; cpus: number; createdAt: Date; handleId: string; memoryMb: number; orgId: string; projectId: string; provider: "arc" | "fake" | "fly" | "runs_on"; rateEffectiveFrom: Date | null; region: string; repoFullName: null | string; slices?: Array<{ projectId: string; repoFullName: string; seconds: number; sliceRef: string }> | undefined; startedAt: Date | null; stoppedAt: Date; teardownReason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; terminalState: string; usdPerSecond: string; workflowJobId: null | number; workload: "ci_runner" | "code_graph_index" | "hosted_agent"; workspaceId: string } } | { detail: string; outcome: "gate_deferred"; reason: "ci_credits_exhausted" | "fleet_ceiling" | "gate_unavailable" | "project_cap" } | { detail: string; outcome: "image_unpullable" } | { detail: string; outcome: "no_runner_group" } | { detail: string; outcome: "provision_failed" } | { outcome: "already_claimed" } | { outcome: "not_configured" } | { outcome: "rate_limited"; retryAfterSeconds: null | number } | { outcome: "unknown_intent" }',
  },
  sweep: {
    file: 'lib/jobs/definitions/automationEngine.ts',
    shape: '{ deleted: number }',
  },
  'sweep-abandoned-supervisions': {
    file: 'lib/jobs/definitions/supervisionSweep.ts',
    shape: '{ scanned: number; settled: number; skipped: number }',
  },
  'sweep-auto-plan-projects': {
    file: 'lib/jobs/definitions/autoPlanCadenceTick.ts',
    shape:
      '{ failed: number; fired: number; outcomes: Array<{ error: string; projectId: string; status: "failed" } | { itemKey: string; jobId: string; planId: string; projectId: string; status: "fired" } | { projectId: string; reason: "code_blind" | "no_expandable_stub" | "no_owner" | "pending_proposal" | "project_gone" | "ready_set_healthy"; status: "skipped" }>; scanned: number; skipped: number }',
  },
  'sweep-dispatch-runs': {
    file: 'lib/jobs/definitions/dispatchRunSweep.ts',
    shape:
      '{ bodiesCleared: number; runsFailed: number; runsRacedByClose: number; runsReaped: number; workspacesSwept: number }',
  },
  'sweep-expired-counters': {
    file: 'lib/jobs/definitions/rateLimitSweep.ts',
    shape: '{ batches: number; deleted: number }',
  },
  'sweep-expired-exports': {
    file: 'lib/jobs/definitions/dataExportExpirySweep.ts',
    shape: '{ expired: number; failed: number; scanned: number }',
  },
  'sweep-orphans': {
    file: 'lib/jobs/definitions/attachmentGc.ts',
    shape: '{ deleted: number; failed: number; scanned: number }',
  },
  'sync-seat-quantity': {
    file: 'lib/jobs/definitions/billingSeatSync.ts',
    shape:
      '{ applied: boolean; outcome: "no_active_tracker_subscription" | "no_customer" | "org_not_found" | "unchanged" | "updated" }',
  },
  'watcher-fan-out': {
    file: 'lib/jobs/definitions/watcherNotify.ts',
    shape: '{ notifiedUserIds: Array<string> }',
  },
};

/**
 * Step ids that are out of use — and are held here so they cannot come BACK
 * carrying a different shape.
 *
 * ⚠️ THIS IS THE HALF THAT SURVIVES A REVERT. Bumping an id fixes the outage
 * only while the bump stands: revert `resolve-target-v2` to `resolve-target`
 * and the tree type-checks, the tests that know about `IndexTarget` pass, and
 * every `job_step` row written before MOTIR-4652 becomes readable again by a
 * reader that expects `anchorProjectId`. The guard refuses a retired id by
 * name, which is the only mechanism in the tree that notices.
 *
 * A retired id is never deleted from this list. The memos are still in the
 * table.
 */
export const RETIRED_STEP_IDS: Record<string, RetiredStepId> = {
  'resolve-target': {
    shape:
      '{ indexed: false; reason: "installation_missing" | "no_projects" | "provider_cannot_index" | "workspace_missing" } | { indexed: true; organizationId: string; projectIds: Array<string>; providerId: "github" | "gitlab"; repoRef: string }',
    supersededBy: 'resolve-target-v2',
    reason:
      "MOTIR-4652 replaced `projectIds: string[]` with `anchorProjectId: string` and kept the id. A run that resumed across that deploy replayed the old row into the new reader, `JSON.stringify` dropped the absent field, and motir-ai refused the credential mint with `'coreProjectId' must be a non-empty string` — every code-graph refresh in the estate, reported as `succeeded` (MOTIR-5020).",
  },
};

/**
 * The seams that FORWARD an id rather than naming one — `ctx.step.run(id, fn)`
 * inside a `SupervisionSteps` adapter. They are not steps and have no shape of
 * their own: the ids they carry are the `index-*` / `*-runner` entries above,
 * written at the supervision's own call sites.
 *
 * Declared rather than skipped, because a scanner that silently ignores what it
 * cannot pin is a scanner whose green means nothing. A forwarding site in a
 * file that is not listed here fails the guard.
 */
export const FORWARDING_SEAMS: Record<string, string> = {
  'lib/jobs/definitions/ciRunnerFleet.ts':
    "`stepSeam` — adapts `ctx.step` to `RunnerSupervisionSteps` for `ciRunnerBootService`, whose own `steps.run('boot-runner' | 'settle-runner', …)` sites are pinned above.",
  'lib/jobs/indexFleetSteps.ts':
    '`stepSeam` — adapts `ctx.step` to `SupervisionSteps` for `codeGraphIndexDispatchService`, whose own `steps.run(`index-admit:` | `index-boot:` | `index-settle:`, …)` sites are pinned above.',
};
