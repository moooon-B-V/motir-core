import { defineJob } from '../defineJob';
import type {
  WorkItemCommentCreatedData,
  WorkItemCreatedData,
  WorkItemFieldChangedData,
  WorkItemTransitionedData,
} from '../types';

// The automation EXECUTION ENGINE's Inngest jobs (Story 6.6 · Subtask 6.6.2) —
// the rule-processing queue the verified Jira model runs (rules execute
// asynchronously, never inline with the triggering write). FOUR thin event
// consumers over ONE engine service (automationEngineService.runForEvent), the
// watcherNotify shape: each narrows the typed payload and runs the engine in a
// single durable step. The engine does the match → conditions → actions-as-
// owner → audit pipeline; these handlers are the trigger seam.
//
// `work-item/created` + `work-item/field.changed` are NEW events 6.6.2 emits
// from the shipped workItemsService paths; each gets its own consumer here. The
// `transitioned` + `commented` consumers (over the existing 5.4.5 / 5.1.2
// events) are the 6.6.3 extensions, added the same way. The job ids are
// distinct from the event names (the additional-consumer form) so a future
// consumer of the same event — e.g. Story 5.7's in-app bell on
// `work-item/created` — coexists.
//
// `retryPolicy: 'idempotent'`: the engine is idempotent per (event × rule) by
// construction (the 6.6.2 (rule, event) claim), so a transient DB blip is worth
// Inngest's full 5-attempt budget — a replay re-runs only the rules that didn't
// already claim this event.

export const automationEngineOnCreated = defineJob(
  {
    id: 'automation-engine/created',
    trigger: 'work-item/created',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemCreatedData;
    return ctx.step.run('run-rules', () =>
      services.automationEngine.runForEvent({
        trigger: 'created',
        workspaceId: payload.workspaceId,
        projectId: payload.projectId,
        workItemId: payload.workItemId,
        eventId: ctx.event.id ?? ctx.runId,
        ...(payload.viaAutomationRuleId
          ? { viaAutomationRuleId: payload.viaAutomationRuleId }
          : {}),
      }),
    );
  },
);

export const automationEngineOnFieldChanged = defineJob(
  {
    id: 'automation-engine/field.changed',
    trigger: 'work-item/field.changed',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemFieldChangedData;
    return ctx.step.run('run-rules', () =>
      services.automationEngine.runForEvent({
        trigger: 'field_changed',
        workspaceId: payload.workspaceId,
        projectId: payload.projectId,
        workItemId: payload.workItemId,
        eventId: ctx.event.id ?? ctx.runId,
        changedFields: payload.changedFields,
        ...(payload.viaAutomationRuleId
          ? { viaAutomationRuleId: payload.viaAutomationRuleId }
          : {}),
      }),
    );
  },
);

// The Epic-5-sourced trigger consumers (Subtask 6.6.3) — additional consumers
// over the EXISTING 5.4.5 `work-item/transitioned` and 5.1.2
// `work-item/comment.created` events (no new emit path). Distinct ids from the
// already-registered watcher/mention consumers of the same events
// (`watcher-notify/*`, `mention-notify/*`), so all coexist on Inngest. Neither
// event carries `projectId`, so the engine resolves it from the item; both
// honour the `viaAutomationRuleId` provenance skip (a rule's own transition /
// comment never re-fires a rule).

export const automationEngineOnTransitioned = defineJob(
  {
    id: 'automation-engine/transitioned',
    trigger: 'work-item/transitioned',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemTransitionedData;
    return ctx.step.run('run-rules', () =>
      services.automationEngine.runForEvent({
        trigger: 'transitioned',
        workspaceId: payload.workspaceId,
        workItemId: payload.workItemId,
        eventId: ctx.event.id ?? ctx.runId,
        fromStatusKey: payload.fromStatusKey,
        toStatusKey: payload.toStatusKey,
        ...(payload.viaAutomationRuleId
          ? { viaAutomationRuleId: payload.viaAutomationRuleId }
          : {}),
      }),
    );
  },
);

export const automationEngineOnCommented = defineJob(
  {
    id: 'automation-engine/commented',
    trigger: 'work-item/comment.created',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemCommentCreatedData;
    return ctx.step.run('run-rules', () =>
      services.automationEngine.runForEvent({
        trigger: 'commented',
        workspaceId: payload.workspaceId,
        workItemId: payload.workItemId,
        eventId: ctx.event.id ?? ctx.runId,
        ...(payload.viaAutomationRuleId
          ? { viaAutomationRuleId: payload.viaAutomationRuleId }
          : {}),
      }),
    );
  },
);

/** 04:15 every day — off-peak, clear of the 03:30 attachment-GC and the 09:00
 * health check. */
export const AUTOMATION_RETENTION_SWEEP_CRON = '15 4 * * *';

// The 90-day execution-audit retention sweep (the 1.6.4 system-job + 5.2.7
// attachment-GC pattern), cross-workspace under withSystemContext. System-
// scoped: audit rows span workspaces, the ledger row is untenanted like every
// `system.*` job; the per-run `{ deleted }` summary is the handler's return,
// persisted on the job_run row.
export const automationRetentionSweep = defineJob(
  {
    id: 'system.automation-retention-sweep',
    cron: AUTOMATION_RETENTION_SWEEP_CRON,
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('sweep', () => services.automationEngine.sweepExpiredExecutions());
  },
);
