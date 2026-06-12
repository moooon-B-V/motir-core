import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { withSystemContext } from '@/lib/workspaces/context';
import { automationRuleRepository } from '@/lib/repositories/automationRuleRepository';
import { automationRuleExecutionRepository } from '@/lib/repositories/automationRuleExecutionRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemsService, loadFilterReferents } from '@/lib/services/workItemsService';
import { watchersService } from '@/lib/services/watchersService';
import { commentsService } from '@/lib/services/commentsService';
import { labelsService } from '@/lib/services/labelsService';
import { customFieldValuesService } from '@/lib/services/customFieldValuesService';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { decodeFilterEnvelope, type FilterAst } from '@/lib/filters/ast';
import {
  type AutomationActionConfig,
  type AutomationTriggerConfig,
} from '@/lib/automation/registry';
import {
  AUTOMATION_AUTO_DISABLE_THRESHOLD,
  AUTOMATION_EXECUTION_RETENTION_DAYS,
} from '@/lib/automation/constants';
import type { AutomationRuleWithOwner } from '@/lib/repositories/automationRuleRepository';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { AutomationTriggerType } from '@prisma/client';

// The automation EXECUTION ENGINE (Story 6.6 · Subtask 6.6.2) — events in,
// attributed service calls out, every run audited. The heart of the story:
// the 1.6 Inngest jobs (lib/jobs/definitions/automationEngine.ts) consume the
// post-commit `work-item/*` events and call `runForEvent`; this service owns
// the match → conditions → actions-as-owner → audit pipeline, plus the daily
// retention sweep.
//
// FIVE invariants, each verified against Atlassian cloud-automation docs
// (Story 6.6 description, rung 1) and implemented here:
//   1. LOOP PREVENTION (the Jira default, hard-shipped): an event that carries
//      `viaAutomationRuleId` provenance — i.e. it was emitted BY a rule's own
//      action — never fires a rule. Rules don't trigger rules.
//   2. CONDITIONS gate via the 6.1 compiler scoped to the triggering item (one
//      indexed read); an empty group always passes (the item still exists).
//   3. ACTIONS execute IN ORDER through the SHIPPED services AS THE RULE OWNER
//      (the recorded 6.6 deviation), so workflow legality, permissions,
//      revision rows, and downstream notifications behave exactly as a person's
//      edit would. The first failing action stops the run (Jira's behaviour)
//      and is recorded as a Failure — never a silent bypass.
//   4. IDEMPOTENT per (event × rule): the engine CLAIMS an (rule, event) pair
//      (the partial unique index from the 6.6.2 migration) before it executes a
//      rule's actions, so an Inngest replay / retry of the same event is a
//      no-op (it finds the existing execution row and skips).
//   5. FAILURE OPS: a failed run increments `consecutiveFailureCount`; at the
//      verified threshold (10) the rule AUTO-DISABLES; a success resets the
//      counter; the owner gets ONE error email on the FIRST failure after a
//      success (the verified dedupe), via the 1.6 email pipeline.
//
// CONTEXT / RLS: the engine runs OUTSIDE any HTTP request (a background job),
// on the app's BYPASSRLS connection — so, like savedFilterSubscriptionsService'
// s delivery path, it gates reads by explicit `workspaceId`/`projectId` (the
// application-layer tenant boundary) rather than threading withWorkspaceContext
// through every action service (which manages its own transactions). The ONLY
// cross-workspace path — the retention sweep — runs under withSystemContext
// (the system-admin RLS branch the 6.6.2 migration adds), the attachment-GC
// precedent.

/** The normalized event the engine acts on — one per consumed `work-item/*`
 * event, assembled by the job handler from the typed payload. */
export interface AutomationEngineEventInput {
  trigger: AutomationTriggerType;
  workspaceId: string;
  /** The triggering item's project. The `created` / `field.changed` events
   * carry it directly (one fewer read); the Epic-5-sourced `transitioned` /
   * `comment.created` events (5.4.5 / 5.1.2) DON'T, so it's optional and the
   * engine resolves it from the item (Subtask 6.6.3). */
  projectId?: string;
  workItemId: string;
  /** The job event's id — the idempotency key half (rule × event). */
  eventId: string;
  /** Provenance: when set, the WHOLE event is skipped (loop prevention). */
  viaAutomationRuleId?: string;
  /** `transitioned`-trigger narrowing (the from/to status keys of the move). */
  fromStatusKey?: string;
  toStatusKey?: string;
  /** `field_changed`-trigger narrowing — the automation field ids that changed. */
  changedFields?: string[];
}

/** The per-event run summary — the job handler's return value, persisted on
 * the job_run ledger row (the 1.6 dashboard reads it). */
export interface AutomationRunSummary {
  /** True when the event was provenance-skipped (loop prevention). */
  skipped: boolean;
  /** Rules whose trigger config matched the event. */
  matched: number;
  succeeded: number;
  failed: number;
  noActions: number;
  /** Rules already run for this event (idempotency replay skips). */
  deduped: number;
}

/** The context one action executor runs within — the triggering item + the
 * rule actor (the owner). Mirrors the registry's
 * `AutomationActionExecutionContext`. */
interface ActionExecutionContext {
  workspaceId: string;
  projectId: string;
  workItemId: string;
  ruleId: string;
  ownerId: string;
}

/** A typed runtime error for an action whose referent went stale between the
 * rule's authoring and this run (a deleted target status / assignee) — a
 * RECORDED failure, the 6.1 stale-referent rule, never a crash. */
class AutomationActionReferentError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'AutomationActionReferentError';
  }
}

/**
 * The action-executor map (Subtask 6.6.2's half of the 6.6.1 executor
 * contract). TOTAL over the shipped action set: `transition` →
 * `workItemsService.updateStatus` (the workflow gate stays the authority — an
 * illegal target throws IllegalTransitionError, a RECORDED failure, not a
 * bypass); `set_field` → `workItemsService.updateWorkItem` (built-in fields the
 * shipped patch accepts). Both run as the OWNER with `viaAutomationRuleId`
 * provenance stamped on the ServiceContext, so every event their writes emit is
 * skipped by invariant #1. The Epic-5 actions (add-watcher / add-comment /
 * add-label / set-custom-field) join this map in 6.6.3, the same way.
 */
const ACTION_EXECUTORS: {
  [K in AutomationActionConfig['type']]: (
    config: Extract<AutomationActionConfig, { type: K }>,
    ctx: ActionExecutionContext,
  ) => Promise<void>;
} = {
  async transition(config, ctx) {
    const ownerCtx = ownerServiceContext(ctx);
    // The stored `toStatusId` is the status KEY — the unit `updateStatus` takes
    // AND the unit the `work-item/transitioned` event carries, so the trigger
    // and the action speak one vocabulary (the 6.6.5 editor supplies keys). The
    // workflow gate stays the authority: an UNKNOWN key throws UnknownStatusError
    // (the stale-referent case — a deleted status), an ILLEGAL move throws
    // IllegalTransitionError, and a no-op (already in the target) returns without
    // a transition — each a recorded outcome, never a bypass.
    await workItemsService.updateStatus(ctx.workItemId, config.toStatusId, ownerCtx);
  },
  async set_field(config, ctx) {
    const ownerCtx = ownerServiceContext(ctx);
    await workItemsService.updateWorkItem(ctx.workItemId, setFieldPatch(config), ownerCtx);
  },
  // --- Epic-5 actions (Subtask 6.6.3), each through its owning shipped service
  // AS THE OWNER. Full side-effect fidelity: watcher rows, mention parsing +
  // emails, find-or-create labels, per-type CF validation + revision diffs — all
  // exactly as a person's edit would produce. A stale / ineligible referent
  // (deleted user, archived option, non-member) is the SERVICE's typed throw,
  // caught one level up as a RECORDED failure (the 6.1 stale-referent rule). ---
  async add_watcher(config, ctx) {
    // watchersService.addWatcher (5.4.4): the target's view-access validation is
    // the authority — an ineligible / deleted user throws (a recorded failure),
    // never the mirror's silent drop. Idempotent on an already-watching target.
    await watchersService.addWatcher(ctx.workItemId, config.userId, ownerServiceContext(ctx));
  },
  async add_comment(config, ctx) {
    // commentsService.addComment (5.1.2): mention parsing runs; the comment's own
    // `work-item/comment.created` event is stamped with this rule's provenance
    // (via the owner ServiceContext), so mention emails still send but no rule
    // re-fires off it (loop prevention — invariant #1).
    await commentsService.addComment(
      ctx.workItemId,
      { bodyMd: config.bodyMd },
      ownerServiceContext(ctx),
    );
  },
  async add_label(config, ctx) {
    // labelsService.addLabel (5.4.2): find-or-create, idempotent if already
    // present, records the labels revision. The per-issue label cap throws a
    // recorded failure.
    await labelsService.addLabel(ctx.workItemId, config.name, ownerServiceContext(ctx));
  },
  async set_custom_field(config, ctx) {
    // customFieldValuesService.setValue (5.3.3): per-type validation + the 1.4.6
    // revision diff apply. A deleted field / archived option / non-member user
    // is a recorded failure (stale referent), never a crash.
    await customFieldValuesService.setValue(
      ctx.workItemId,
      config.fieldId,
      config.value,
      ownerServiceContext(ctx),
    );
  },
};

/** Build the owner-attributed ServiceContext for an action, stamped with the
 * rule provenance so the write's emitted events are loop-skipped. */
function ownerServiceContext(ctx: ActionExecutionContext): ServiceContext {
  return { userId: ctx.ownerId, workspaceId: ctx.workspaceId, viaAutomationRuleId: ctx.ruleId };
}

/** Translate a `set_field` action config into the sparse work-item patch the
 * shipped `updateWorkItem` accepts. The discriminated union keeps each arm's
 * value type exact. */
function setFieldPatch(config: Extract<AutomationActionConfig, { type: 'set_field' }>) {
  switch (config.field) {
    case 'assignee':
      return { assigneeId: config.value };
    case 'priority':
      return { priority: config.value };
    case 'dueDate':
      return { dueDate: config.value };
    case 'estimate':
      return { estimateMinutes: config.value };
  }
}

export const automationEngineService = {
  /**
   * Run every enabled rule a trigger event matches. Returns a per-event
   * summary. Loop-prevention (invariant #1) short-circuits a provenance-
   * carrying event before any read. Each matching rule runs independently and
   * idempotently (invariant #4) — one rule's failure never aborts the others.
   */
  async runForEvent(input: AutomationEngineEventInput): Promise<AutomationRunSummary> {
    const summary: AutomationRunSummary = {
      skipped: false,
      matched: 0,
      succeeded: 0,
      failed: 0,
      noActions: 0,
      deduped: 0,
    };

    // (1) Loop prevention — a rule never fires off another rule's action.
    // Short-circuits BEFORE any read (the `before any read` half of invariant
    // #1), which is also why the projectId resolution below sits AFTER it: a
    // provenance-carrying `comment.created` / `transitioned` event never even
    // reads the item to find its project.
    if (input.viaAutomationRuleId) {
      summary.skipped = true;
      return summary;
    }

    // The Epic-5-sourced events (5.4.5 transitioned / 5.1.2 comment.created)
    // don't carry projectId — resolve it from the item (Subtask 6.6.3). A
    // since-deleted item (gone within the async window) has no project ⇒ no
    // rules match ⇒ the run is a clean no-op, never a crash.
    const projectId = input.projectId ?? (await this.resolveProjectId(input));
    if (!projectId) return summary;

    const rules = await automationRuleRepository.listEnabledByProjectAndTrigger(
      projectId,
      input.trigger,
    );
    const matching = rules.filter((rule) => triggerMatches(rule, input));
    summary.matched = matching.length;

    for (const rule of matching) {
      const outcome = await this.runRule(rule, input);
      switch (outcome) {
        case 'success':
          summary.succeeded += 1;
          break;
        case 'failure':
          summary.failed += 1;
          break;
        case 'no_actions':
          summary.noActions += 1;
          break;
        case 'deduped':
          summary.deduped += 1;
          break;
      }
    }
    return summary;
  },

  /**
   * Resolve the triggering item's project (Subtask 6.6.3) — for the Epic-5
   * events that don't carry it. Tenant-checked against the event's workspace
   * (an item from another workspace, or a since-deleted one, yields null ⇒ the
   * caller treats the run as a clean no-op). One indexed read.
   */
  async resolveProjectId(input: AutomationEngineEventInput): Promise<string | null> {
    const item = await workItemRepository.findById(input.workItemId);
    if (!item || item.workspaceId !== input.workspaceId) return null;
    return item.projectId;
  },

  /**
   * Run ONE rule against the triggering item: idempotency claim → conditions →
   * actions-as-owner → audit + failure-ops. Never throws — an action error is
   * caught and recorded as a Failure (so the Inngest step always completes and
   * memoizes, the other half of the idempotency guarantee). Returns the audited
   * outcome.
   */
  async runRule(
    rule: AutomationRuleWithOwner,
    input: AutomationEngineEventInput,
  ): Promise<'success' | 'failure' | 'no_actions' | 'deduped'> {
    // (4) Idempotency — already ran this rule for this event? Skip before
    // re-executing any action (a replay must not re-apply side effects).
    const already = await automationRuleExecutionRepository.existsByRuleAndEvent(
      rule.id,
      input.eventId,
    );
    if (already) return 'deduped';

    const startedAt = Date.now();

    // (2) Conditions — compile the stored group scoped to the triggering item.
    const conditionsPass = await this.evaluateConditions(rule, input);
    if (!conditionsPass) {
      await this.recordNoActions(rule, input, Date.now() - startedAt);
      return 'no_actions';
    }

    // (3) Actions — in order, as the owner. The first failure stops the run.
    const actions = rule.actions as AutomationActionConfig[];
    const actionCtx: ActionExecutionContext = {
      workspaceId: rule.workspaceId,
      projectId: rule.projectId,
      workItemId: input.workItemId,
      ruleId: rule.id,
      ownerId: rule.ownerId,
    };
    let failure: string | null = null;
    for (const action of actions) {
      try {
        await runAction(action, actionCtx);
      } catch (err) {
        failure = describeActionError(err);
        break;
      }
    }

    const durationMs = Date.now() - startedAt;
    if (failure !== null) {
      await this.recordFailure(rule, input, failure, durationMs);
      return 'failure';
    }
    await this.recordSuccess(rule, input, durationMs);
    return 'success';
  },

  /**
   * Compile the rule's condition group (the stored 6.1 envelope) and test the
   * triggering item against it (invariant #2). A structurally-undecodable
   * envelope (a server invariant the 6.6.1 service prevents on write) degrades
   * to "matches nothing" — the rule simply never fires, never crashes the run.
   */
  async evaluateConditions(
    rule: AutomationRuleWithOwner,
    input: AutomationEngineEventInput,
  ): Promise<boolean> {
    const decoded = decodeFilterEnvelope(rule.conditionAst);
    if (!decoded.ok) return false;
    const ast: FilterAst = decoded.ast;
    const referents = await loadFilterReferents(rule.projectId, rule.workspaceId, ast);
    return workItemRepository.matchesAutomationCondition(input.workItemId, ast, referents);
  },

  /** Write a `no_actions` audit row (condition gated). The failure counter is
   * UNCHANGED — a gated run is neither a success (no action ran) nor a failure
   * (nothing went wrong). */
  async recordNoActions(
    rule: AutomationRuleWithOwner,
    input: AutomationEngineEventInput,
    durationMs: number,
  ): Promise<void> {
    await this.writeExecution(rule.id, {
      status: 'no_actions',
      workItemId: input.workItemId,
      eventId: input.eventId,
      durationMs,
    });
  },

  /** Write a `success` audit row AND reset the consecutive-failure counter, in
   * ONE transaction. */
  async recordSuccess(
    rule: AutomationRuleWithOwner,
    input: AutomationEngineEventInput,
    durationMs: number,
  ): Promise<void> {
    await this.writeExecution(
      rule.id,
      { status: 'success', workItemId: input.workItemId, eventId: input.eventId, durationMs },
      async (tx) => {
        const state = await automationRuleRepository.lockFailureState(rule.id, tx);
        if (state && state.consecutiveFailureCount !== 0) {
          await automationRuleRepository.update(rule.id, { consecutiveFailureCount: 0 }, tx);
        }
      },
    );
  },

  /**
   * Write a `failure` audit row, bump the consecutive-failure counter (auto-
   * disabling at the verified threshold of 10), all in ONE transaction; then,
   * post-commit, email the owner IFF this was the first failure after a success
   * (the verified dedupe — the 0→1 transition).
   */
  async recordFailure(
    rule: AutomationRuleWithOwner,
    input: AutomationEngineEventInput,
    error: string,
    durationMs: number,
  ): Promise<void> {
    let firstFailureAfterSuccess = false;
    let autoDisabled = false;
    const written = await this.writeExecution(
      rule.id,
      {
        status: 'failure',
        workItemId: input.workItemId,
        eventId: input.eventId,
        durationMs,
        error,
      },
      async (tx) => {
        const state = await automationRuleRepository.lockFailureState(rule.id, tx);
        if (!state) return; // rule deleted mid-run — nothing to update
        const nextCount = state.consecutiveFailureCount + 1;
        firstFailureAfterSuccess = nextCount === 1;
        autoDisabled = state.enabled && nextCount >= AUTOMATION_AUTO_DISABLE_THRESHOLD;
        await automationRuleRepository.update(
          rule.id,
          {
            consecutiveFailureCount: nextCount,
            ...(autoDisabled ? { enabled: false } : {}),
          },
          tx,
        );
      },
    );

    // Post-commit (never inside the tx — a rolled-back audit must not email):
    // the owner error email, deduped to the first failure after a success.
    if (written && firstFailureAfterSuccess) {
      await this.emailOwnerOnFailure(rule, input, written.id, error, autoDisabled);
    }
  },

  /**
   * The audit-write transaction: claim the (rule, event) pair by inserting the
   * execution row (the partial unique index makes the claim atomic), running
   * an optional in-tx `mutate` (the failure-counter / reset write) first. A
   * unique-violation means a concurrent run already claimed this (rule, event)
   * — treated as a benign dedupe (returns null), never a thrown run. Returns
   * the written row, or null when deduped.
   */
  async writeExecution(
    ruleId: string,
    data: {
      status: 'success' | 'failure' | 'no_actions';
      workItemId: string;
      eventId: string;
      durationMs: number;
      error?: string;
    },
    mutate?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<{ id: string } | null> {
    try {
      return await db.$transaction(async (tx) => {
        if (mutate) await mutate(tx);
        const row = await automationRuleExecutionRepository.create(
          {
            ruleId,
            status: data.status,
            workItemId: data.workItemId,
            eventId: data.eventId,
            durationMs: data.durationMs,
            error: data.error ?? null,
          },
          tx,
        );
        return { id: row.id };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return null; // a concurrent run claimed this (rule, event) first
      }
      throw err;
    }
  },

  /** Compose + enqueue the owner's failure email through the 1.6 pipeline.
   * Idempotency-keyed per execution row so an Inngest replay never double-mails.
   * A deleted owner (no user row) is a silent no-op. */
  async emailOwnerOnFailure(
    rule: AutomationRuleWithOwner,
    input: AutomationEngineEventInput,
    executionId: string,
    error: string,
    autoDisabled: boolean,
  ): Promise<void> {
    const owner = await userRepository.findById(rule.ownerId);
    if (!owner) return;
    await sendEvent('email.send', {
      to: owner.email,
      template: 'automation-rule-failed',
      data: {
        recipientName: owner.name,
        ruleName: rule.name,
        errorDetail: error,
        autoDisabled,
        rulesUrl: automationSettingsUrl(rule.projectId),
      },
      workspaceId: input.workspaceId,
      idempotencyKey: `automation-rule-failed:${executionId}`,
    });
  },

  /**
   * The 90-day retention sweep (the 1.6.4 system-job + attachment-GC pattern) —
   * delete execution rows older than the verified Jira retention, in bounded
   * batches under withSystemContext (the cross-workspace system-admin RLS
   * branch). Loops until a short batch signals drained or the per-run batch cap
   * is hit (never an unbounded DELETE); returns the count deleted.
   */
  async sweepExpiredExecutions(now: Date = new Date()): Promise<{ deleted: number }> {
    const cutoff = new Date(now.getTime() - AUTOMATION_EXECUTION_RETENTION_DAYS * DAY_MS);
    let deleted = 0;
    for (let batch = 0; batch < RETENTION_MAX_BATCHES_PER_RUN; batch += 1) {
      const n = await withSystemContext((tx) =>
        automationRuleExecutionRepository.deleteOlderThan(cutoff, RETENTION_BATCH_SIZE, tx),
      );
      deleted += n;
      if (n < RETENTION_BATCH_SIZE) break; // drained
    }
    return { deleted };
  },
};

/** Does a rule's trigger config match this event? Narrowing per trigger type:
 * `created`/`commented` — no config, always match; `transitioned` — optional
 * from/to narrowing, where the stored `fromStatusId`/`toStatusId` hold status
 * KEYS (the unit the `work-item/transitioned` event carries); `field_changed` —
 * the configured field must be among the event's changed fields (the "assigned"
 * preset is just `assignee`). Unknown future trigger types fall through to
 * no-match (a typed config the engine doesn't yet narrow can't accidentally
 * fire). NOTE: 6.6.2 EMITS only `created` + `field.changed`; the `transitioned`
 * + `commented` event consumers land in 6.6.3, but the matching is general so
 * that subtask only adds the consumers. */
function triggerMatches(rule: AutomationRuleWithOwner, input: AutomationEngineEventInput): boolean {
  const config = rule.triggerConfig as AutomationTriggerConfig;
  switch (config.type) {
    case 'created':
    case 'commented':
      return true;
    case 'transitioned':
      if (config.fromStatusId !== null && config.fromStatusId !== input.fromStatusKey) return false;
      if (config.toStatusId !== null && config.toStatusId !== input.toStatusKey) return false;
      return true;
    case 'field_changed':
      return (input.changedFields ?? []).includes(config.field);
    default:
      return false;
  }
}

/** Dispatch one action through the TOTAL executor map. An action type with no
 * executor (a registry entry whose engine half hasn't shipped) is a recorded
 * failure, never a silent skip — the totality guard. */
async function runAction(
  action: AutomationActionConfig,
  ctx: ActionExecutionContext,
): Promise<void> {
  const executor = ACTION_EXECUTORS[action.type];
  if (!executor) {
    throw new AutomationActionReferentError(`no executor for action ${action.type}`);
  }
  // The map's per-key value type is narrowed to the matching config arm; the
  // discriminant guarantees soundness, so the cast through the union member is
  // safe (TS can't correlate the indexed access with the value at runtime).
  await (executor as (c: AutomationActionConfig, x: ActionExecutionContext) => Promise<void>)(
    action,
    ctx,
  );
}

/** A short, human-readable cause for the audit row + the owner email. Prefers a
 * typed error's `code`/message; falls back to the stringified value. */
function describeActionError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

/** The deep link to a project's Automation settings (the 6.6.5 surface) — the
 * email CTA. Built from the app base URL (the 1.6 email convention: the service
 * hands the template a finished URL). */
function automationSettingsUrl(projectId: string): string {
  const base = (process.env['BETTER_AUTH_URL'] ?? '').replace(/\/$/, '');
  return `${base}/projects/${projectId}/settings/automation`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Per-batch + per-run bounds for the retention sweep (the attachment-GC
 * cursor shape — never an unbounded DELETE). */
const RETENTION_BATCH_SIZE = 500;
const RETENTION_MAX_BATCHES_PER_RUN = 100;
