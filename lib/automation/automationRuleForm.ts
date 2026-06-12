// The automation rule EDITOR form model (Story 6.6 · Subtask 6.6.5) — the pure
// bridge between the 6.6.1 wire DTO, the editor's working draft, and the
// create/update request payload. Kept React-free (like the 6.6.1 registry it
// mirrors) so it is unit-testable in isolation and the editor component holds
// only UI state. The draft is intentionally "wider" than the wire shape: a
// half-built action (no target yet) is a legal DRAFT but not a legal payload —
// `ruleDraftCompleteness` reports the gaps so the editor can gate Save and the
// 6.6.1 registries stay the single validation authority for what actually ships.

import { AUTOMATION_ACTIONS_PER_RULE_CAP, AUTOMATION_RULE_NAME_MAX_LENGTH } from './constants';
import {
  AUTOMATION_PRIORITIES,
  AUTOMATION_SET_FIELDS,
  type AutomationFieldChangedFieldId,
  type AutomationPriority,
  type AutomationSetFieldId,
} from './fields';
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_TRIGGER_TYPES,
  type AutomationActionConfig,
  type AutomationActionType,
  type AutomationTriggerConfig,
  type AutomationTriggerType,
} from './registry';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import type { AutomationRuleDto } from '@/lib/dto/automationRules';

export { AUTOMATION_ACTION_TYPES, AUTOMATION_TRIGGER_TYPES };
export { AUTOMATION_PRIORITIES, AUTOMATION_SET_FIELDS };

/** The trigger draft — every per-type slot, all nullable (a fresh trigger has
 * none chosen). Only the slots the chosen `type` reads are serialized. */
export interface TriggerDraft {
  type: AutomationTriggerType;
  /** transitioned */
  fromStatusId: string | null;
  toStatusId: string | null;
  /** field_changed */
  field: AutomationFieldChangedFieldId | null;
}

/** One action draft (a stable client `key` + every per-type slot). */
export interface ActionDraft {
  key: number;
  type: AutomationActionType;
  /** transition */
  toStatusId: string | null;
  /** set_field — the targeted field + its per-field value slot. */
  setField: AutomationSetFieldId | null;
  assignee: string | null;
  priority: AutomationPriority | null;
  dueDate: string | null;
  estimate: number | null;
  /**
   * Epic-5 action slots (the 6.6.3 registry actions: add_watcher / add_comment
   * / add_label / set_custom_field). The form model round-trips them so an
   * API-authored rule loads and re-saves losslessly; their dedicated config
   * EDITORS are a 6.6.5 follow-up (tracked below) and these types are NOT yet
   * offered in the editor's action picker, so a fresh draft never reaches them.
   */
  userId: string | null;
  bodyMd: string | null;
  labelName: string | null;
  customFieldId: string | null;
  customFieldValue: string | number | null;
}

/** The full editor draft. `condition` is the FilterAst the shared
 * `FilterConditionBuilder` produced (already pruned of pending rows); null /
 * empty = the always-match group. */
export interface RuleDraft {
  name: string;
  enabled: boolean;
  trigger: TriggerDraft;
  conditionAst: FilterAst | null;
  actions: ActionDraft[];
}

/** The create/update request body (the 6.6.1 route shape). */
export interface RuleWritePayload {
  name: string;
  triggerType: AutomationTriggerType;
  triggerConfig: Record<string, unknown>;
  /** The `?filter=v1:` param string, or null for the always-match group. */
  condition: string | null;
  actions: Record<string, unknown>[];
}

let draftKeySeq = 1;
function nextKey(): number {
  return draftKeySeq++;
}

/** A blank trigger draft (defaults to `created` — no config). */
export function emptyTriggerDraft(): TriggerDraft {
  return { type: 'created', fromStatusId: null, toStatusId: null, field: null };
}

/** A blank action draft of the given type (defaults to `transition`). */
export function emptyActionDraft(type: AutomationActionType = 'transition'): ActionDraft {
  return {
    key: nextKey(),
    type,
    toStatusId: null,
    setField: type === 'set_field' ? 'assignee' : null,
    assignee: null,
    priority: null,
    dueDate: null,
    estimate: null,
    userId: null,
    bodyMd: null,
    labelName: null,
    customFieldId: null,
    customFieldValue: null,
  };
}

/** A blank rule draft (the Create flow's seed). */
export function emptyRuleDraft(): RuleDraft {
  return {
    name: '',
    enabled: true,
    trigger: emptyTriggerDraft(),
    conditionAst: null,
    actions: [],
  };
}

/** Hydrate an editor draft from a saved rule DTO (the Edit flow). */
export function ruleDraftFromDto(dto: AutomationRuleDto): RuleDraft {
  return {
    name: dto.name,
    enabled: dto.enabled,
    trigger: triggerDraftFromConfig(dto.trigger),
    conditionAst: dto.condition,
    actions: dto.actions.map(actionDraftFromConfig),
  };
}

function triggerDraftFromConfig(config: AutomationTriggerConfig): TriggerDraft {
  const base = emptyTriggerDraft();
  switch (config.type) {
    case 'transitioned':
      return {
        ...base,
        type: 'transitioned',
        fromStatusId: config.fromStatusId,
        toStatusId: config.toStatusId,
      };
    case 'field_changed':
      return { ...base, type: 'field_changed', field: config.field };
    case 'created':
    case 'commented':
      return { ...base, type: config.type };
  }
}

function actionDraftFromConfig(config: AutomationActionConfig): ActionDraft {
  const base = emptyActionDraft(config.type);
  switch (config.type) {
    case 'transition':
      return { ...base, toStatusId: config.toStatusId };
    case 'set_field': {
      // fan the value into the matching slot.
      const draft: ActionDraft = { ...base, setField: config.field };
      switch (config.field) {
        case 'assignee':
          return { ...draft, assignee: config.value };
        case 'priority':
          return { ...draft, priority: config.value };
        case 'dueDate':
          return { ...draft, dueDate: config.value };
        case 'estimate':
          return { ...draft, estimate: config.value };
      }
    }
    // The Epic-5 actions (6.6.3) — round-trip into their slots.
    case 'add_watcher':
      return { ...base, userId: config.userId };
    case 'add_comment':
      return { ...base, bodyMd: config.bodyMd };
    case 'add_label':
      return { ...base, labelName: config.name };
    case 'set_custom_field':
      return { ...base, customFieldId: config.fieldId, customFieldValue: config.value };
  }
}

/** Build the typed trigger config JSON the route forwards to the registry. */
export function triggerConfigOf(trigger: TriggerDraft): Record<string, unknown> {
  switch (trigger.type) {
    case 'transitioned':
      return { fromStatusId: trigger.fromStatusId, toStatusId: trigger.toStatusId };
    case 'field_changed':
      return { field: trigger.field };
    case 'created':
    case 'commented':
      return {};
  }
}

/** Build one action's config JSON (its `type` + per-type slots). The 6.6.1 /
 * 6.6.3 registries remain the validation authority — this only assembles the
 * shape they parse. */
export function actionConfigOf(action: ActionDraft): Record<string, unknown> {
  switch (action.type) {
    case 'transition':
      return { type: 'transition', toStatusId: action.toStatusId };
    case 'set_field': {
      const out: Record<string, unknown> = { type: 'set_field', field: action.setField };
      switch (action.setField) {
        case 'assignee':
          out.value = action.assignee;
          break;
        case 'priority':
          out.value = action.priority;
          break;
        case 'dueDate':
          out.value = action.dueDate;
          break;
        case 'estimate':
          out.value = action.estimate;
          break;
      }
      return out;
    }
    case 'add_watcher':
      return { type: 'add_watcher', userId: action.userId };
    case 'add_comment':
      return { type: 'add_comment', bodyMd: action.bodyMd };
    case 'add_label':
      return { type: 'add_label', name: action.labelName };
    case 'set_custom_field':
      return {
        type: 'set_custom_field',
        fieldId: action.customFieldId,
        value: action.customFieldValue,
      };
  }
}

/** Serialize a draft into the create/update payload. The condition encodes via
 * the shared 6.1 codec; an empty group sends null (always-match). */
export function ruleWritePayload(draft: RuleDraft): RuleWritePayload {
  const condition =
    draft.conditionAst && draft.conditionAst.conditions.length > 0
      ? encodeFilterParam(draft.conditionAst)
      : null;
  return {
    name: draft.name.trim(),
    triggerType: draft.trigger.type,
    triggerConfig: triggerConfigOf(draft.trigger),
    condition,
    actions: draft.actions.map(actionConfigOf),
  };
}

// ---------------------------------------------------------------------------
// Completeness (the editor's Save gate — the registries remain authoritative)
// ---------------------------------------------------------------------------

/** Why an action draft can't ship yet — a typed reason the editor maps to copy
 * and pins on the offending row (never a generic toast). */
export type ActionDraftProblem = 'no-target-status' | 'no-field' | 'no-value';

/** Null when the action is shippable, else the first blocking problem. The
 * Epic-5 actions reuse the generic `no-value` reason (their dedicated editors —
 * and any finer-grained copy — are the 6.6.5 follow-up; they aren't reachable
 * from the picker yet, so this only guards an API-authored rule opened here). */
export function actionDraftProblem(action: ActionDraft): ActionDraftProblem | null {
  switch (action.type) {
    case 'transition':
      return action.toStatusId ? null : 'no-target-status';
    case 'set_field': {
      if (!action.setField) return 'no-field';
      switch (action.setField) {
        case 'assignee':
          // null = "Unassign" — a legitimate value, so assignee never blocks.
          return null;
        case 'priority':
          return action.priority ? null : 'no-value';
        case 'dueDate':
          // null = "Clear due date" — legitimate.
          return null;
        case 'estimate':
          // null = "Clear estimate" — legitimate.
          return null;
      }
      return null;
    }
    case 'add_watcher':
      return action.userId ? null : 'no-value';
    case 'add_comment':
      return action.bodyMd && action.bodyMd.trim().length > 0 ? null : 'no-value';
    case 'add_label':
      return action.labelName && action.labelName.trim().length > 0 ? null : 'no-value';
    case 'set_custom_field':
      // null value = a legitimate clear; only the target field is required.
      return action.customFieldId ? null : 'no-value';
  }
}

/** Why a trigger draft can't ship yet. `transitioned` from/to are OPTIONAL
 * (blank = any status), so only `field_changed` (needs a field) can block. */
export type TriggerDraftProblem = 'no-field';

export function triggerDraftProblem(trigger: TriggerDraft): TriggerDraftProblem | null {
  if (trigger.type === 'field_changed' && !trigger.field) return 'no-field';
  return null;
}

export interface RuleDraftCompleteness {
  nameOk: boolean;
  nameTooLong: boolean;
  trigger: TriggerDraftProblem | null;
  /** Per-action problems, keyed by the action's client `key`. */
  actions: Map<number, ActionDraftProblem>;
  hasActions: boolean;
  /** True when the whole draft is shippable. */
  ok: boolean;
}

/** The editor's Save gate — every blocking gap, surfaced together. */
export function ruleDraftCompleteness(draft: RuleDraft): RuleDraftCompleteness {
  const name = draft.name.trim();
  const nameOk = name.length > 0;
  const nameTooLong = name.length > AUTOMATION_RULE_NAME_MAX_LENGTH;
  const trigger = triggerDraftProblem(draft.trigger);
  const actions = new Map<number, ActionDraftProblem>();
  for (const a of draft.actions) {
    const problem = actionDraftProblem(a);
    if (problem) actions.set(a.key, problem);
  }
  const hasActions = draft.actions.length > 0;
  const ok = nameOk && !nameTooLong && trigger === null && actions.size === 0 && hasActions;
  return { nameOk, nameTooLong, trigger, actions, hasActions, ok };
}

/** Whether another action may be appended (the 10-action cap). */
export function canAddAction(draft: RuleDraft): boolean {
  return draft.actions.length < AUTOMATION_ACTIONS_PER_RULE_CAP;
}
