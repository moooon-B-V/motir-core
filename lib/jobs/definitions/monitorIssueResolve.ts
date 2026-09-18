import { defineJob } from '../defineJob';
import type { WorkItemTransitionedData } from '../types';

// RESOLVE BACK (Story MOTIR-4931 · Subtask MOTIR-5703) — when a bug linked to one
// or more monitor issues reaches a done-category status, resolve each linked
// issue at the provider, EXACTLY ONCE. The policy is all in
// `monitorSyncService`; this file is the TRIGGER and the FAILURE PATH.
//
// A consumer of `work-item/transitioned` (the `watcherNotifyOnTransitioned`
// shape): it takes its own id and names the shared event through `trigger`.
//
// ── The asynchronous-work obligations ─────────────────────────────────────
//   · COMMIT-THEN-EFFECT — the event is emitted AFTER the status write commits,
//     so the provider call can never roll back, or hang, a completion a person
//     made. A provider failure leaves the bug done and the connection carrying
//     the failure.
//   · IDEMPOTENCY — not on the event: the event is at-least-once and the poll's
//     backstop sweep runs as well. It is the LINK'S CLAIM
//     (`monitorIssueRepository.claimResolve`, one conditional UPDATE): only its
//     winner calls the provider, and a `resolved` or `gone` link is never
//     claimed again. So a replay, a retry and the sweep together still call
//     `resolveIssue` once per issue.
//   · FAILURE — a provider REFUSAL is RECORDED on the link and the connection and
//     RETURNED, so it does not spend this job's retries; the sweep retries a
//     `failed` link on the next poll. An UNEXPECTED error throws, so the
//     `transient` policy retries it and the engine dead-letters it; the claim is
//     left `pending`, and the sweep re-claims it once it is stale
//     (`MONITOR_RESOLVE_STALE_MS`). The sweep is the recovery for anything that
//     dead-letters here.
//   · ORDERING — none assumed. The resolve may land before or after the next
//     poll; the reconciler's loop guard (MOTIR-5704) makes resolve → poll safe in
//     either order.
//
// ⚠️ THE FIRST SWEEP AFTER THE DEPLOY RESOLVES EVERY LINK WHOSE BUG IS ALREADY
// DONE, with the switch on by default. That is intended — those bugs were fixed
// and the monitor still calls them unresolved — and it is why the switch is per
// connection: a team that does not want it turns `resolveOnDone` off before the
// first poll.

export const monitorIssueResolveOnTransitioned = defineJob(
  {
    id: 'monitor-issue-resolve',
    trigger: 'work-item/transitioned',
    retryPolicy: 'transient',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemTransitionedData;
    return ctx.step.run('resolve-linked-issues', () =>
      services.monitorSync.resolveLinkedIssues(payload.workItemId, payload.toStatusKey),
    );
  },
);
