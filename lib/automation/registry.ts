// The automation trigger + action registries (Story 6.6 · Subtask 6.6.1) — the
// single source of truth for what a rule can SAY, mirroring the 6.1 filter
// registry's shape (6.1.1 → this is its sibling for the when/then vocabulary).
// TWO TOTAL registries over an open input space (mistake #29): an unknown
// trigger type, an unknown action type, or a malformed config is a typed
// rejection (lib/automation/errors.ts → 422 at the HTTP layer) — never a silent
// pass-through toward execution. The engine (6.6.2) and the editor UI (6.6.5)
// both read THIS module: the engine for the consumed event name + the executor
// contract, the UI for the editor kind. A registry entry added here surfaces in
// both with no other change (the 6.1.1 → 6.1.2 extension pattern; the Epic-5
// trigger/action entries land in 6.6.3 the same way).
//
// Kept PURE (no Prisma, no DB, no React) like its 6.1 sibling — unit-testable
// in isolation and importable from the client editor (6.6.5). The conditionAst
// validation is NOT here: it reuses the 6.1 FilterAST registry wholesale (the
// service runs `validateFilterAst`), so the operator registry stays the single
// predicate authority.
//
// Identifier discipline: the trigger-type ids are byte-identical to the
// `automation_trigger_type` Postgres enum (snake_case, e.g. `field_changed`) so
// no mapping layer sits between the column and the registry. Action types are
// JSON discriminants (no enum) but follow the same snake_case convention.

import {
  AUTOMATION_FIELD_CHANGED_FIELDS,
  AUTOMATION_PRIORITIES,
  AUTOMATION_SET_FIELDS,
  type AutomationFieldChangedFieldId,
  type AutomationPriority,
  type AutomationSetFieldId,
} from './fields';
import { AUTOMATION_COMMENT_BODY_MAX_LENGTH } from './constants';
import { LABEL_NAME_MAX_LENGTH } from '@/lib/labels/constants';
import {
  InvalidAutomationActionConfigError,
  InvalidAutomationTriggerConfigError,
  UnknownAutomationActionError,
  UnknownAutomationTriggerError,
} from './errors';

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** The four verified Jira issue-event triggers (rung 1). Byte-identical to the
 * `automation_trigger_type` enum. */
export type AutomationTriggerType = 'created' | 'transitioned' | 'field_changed' | 'commented';

/** The job event a trigger consumes — declared here so the engine (6.6.2) wires
 * the consumer off the registry, not a hand-kept map. `work-item/created` and
 * `work-item/field.changed` are NEW events 6.6.2 adds; `work-item/transitioned`
 * (5.4.5) and `work-item/comment.created` (5.1.2) already exist (6.6.3 wires the
 * latter two consumers). Kept as plain string literals so this module needs no
 * dependency on the jobs typed-event map. */
export type AutomationTriggerEventName =
  | 'work-item/created'
  | 'work-item/transitioned'
  | 'work-item/field.changed'
  | 'work-item/comment.created';

/** What the editor renders for a trigger's config slot (6.6.4/6.6.5). */
export type AutomationTriggerEditorKind = 'none' | 'transition' | 'field-changed';

/** The normalized, stored trigger config — a discriminated union keyed by the
 * trigger type. The discriminant is duplicated in the `automation_rule.trigger_type`
 * column (for the engine's indexed read); the JSON column stores this. */
export type AutomationTriggerConfig =
  | { type: 'created' }
  | { type: 'transitioned'; fromStatusId: string | null; toStatusId: string | null }
  | { type: 'field_changed'; field: AutomationFieldChangedFieldId }
  | { type: 'commented' };

export interface AutomationTriggerDef {
  type: AutomationTriggerType;
  event: AutomationTriggerEventName;
  editorKind: AutomationTriggerEditorKind;
  /** Parse + validate a raw config into its normalized union member — typed
   * throw (→ 422) on a malformed / unknown-field config. TOTAL: every code path
   * either returns a valid config or throws. */
  parseConfig(raw: unknown): AutomationTriggerConfig;
}

function asObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** An optional status-id narrowing slot: a non-empty string, or null when
 * absent/blank. Status ids are OPEN (a deleted status is a stale referent —
 * matched at execution, not whitelisted here; the 6.1 rule). */
function optionalStatusId(value: unknown, triggerType: string, slot: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new InvalidAutomationTriggerConfigError(
      triggerType,
      `${slot} must be a status id string`,
    );
  }
  return value;
}

const TRIGGER_DEFS: ReadonlyArray<AutomationTriggerDef> = [
  {
    type: 'created',
    event: 'work-item/created',
    editorKind: 'none',
    parseConfig() {
      return { type: 'created' };
    },
  },
  {
    type: 'transitioned',
    event: 'work-item/transitioned',
    editorKind: 'transition',
    parseConfig(raw) {
      const o = asObject(raw);
      return {
        type: 'transitioned',
        fromStatusId: optionalStatusId(o['fromStatusId'], 'transitioned', 'fromStatusId'),
        toStatusId: optionalStatusId(o['toStatusId'], 'transitioned', 'toStatusId'),
      };
    },
  },
  {
    type: 'field_changed',
    event: 'work-item/field.changed',
    editorKind: 'field-changed',
    parseConfig(raw) {
      const o = asObject(raw);
      const field = o['field'];
      if (typeof field !== 'string' || !isFieldChangedField(field)) {
        throw new InvalidAutomationTriggerConfigError(
          'field_changed',
          `field must be one of ${AUTOMATION_FIELD_CHANGED_FIELDS.join(', ')}`,
        );
      }
      return { type: 'field_changed', field };
    },
  },
  {
    type: 'commented',
    event: 'work-item/comment.created',
    editorKind: 'none',
    parseConfig() {
      return { type: 'commented' };
    },
  },
];

function isFieldChangedField(v: string): v is AutomationFieldChangedFieldId {
  return (AUTOMATION_FIELD_CHANGED_FIELDS as readonly string[]).includes(v);
}

/** Every trigger type, in editor menu order. */
export const AUTOMATION_TRIGGER_TYPES: ReadonlyArray<AutomationTriggerType> = TRIGGER_DEFS.map(
  (d) => d.type,
);

const TRIGGER_DEFS_BY_TYPE: ReadonlyMap<string, AutomationTriggerDef> = new Map(
  TRIGGER_DEFS.map((d) => [d.type, d]),
);

/** TOTAL trigger lookup: a hit, or the typed 422 — never undefined. */
export function automationTriggerDef(triggerType: string): AutomationTriggerDef {
  const def = TRIGGER_DEFS_BY_TYPE.get(triggerType);
  if (!def) throw new UnknownAutomationTriggerError(triggerType);
  return def;
}

/** Parse + validate `(triggerType, rawConfig)` into the stored config. Typed
 * throw on an unknown type (→ 422) or a malformed config (→ 422). */
export function parseTriggerConfig(
  triggerType: string,
  rawConfig: unknown,
): AutomationTriggerConfig {
  return automationTriggerDef(triggerType).parseConfig(rawConfig);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** The full action set. The first two (`transition` / `set_field`) are the
 * shipped-substrate entries 6.6.1 shipped; the four Epic-5 entries
 * (`add_watcher` / `add_comment` / `add_label` / `set_custom_field`) are the
 * 6.6.3 registry EXTENSIONS over the Epic-5 services — the same extension
 * pattern as 6.1.2 over 6.1.1. */
export type AutomationActionType =
  | 'transition'
  | 'set_field'
  | 'add_watcher'
  | 'add_comment'
  | 'add_label'
  | 'set_custom_field';

/** What the editor renders for an action's config slot (6.6.4/6.6.5). */
export type AutomationActionEditorKind =
  | 'transition'
  | 'set-field'
  | 'add-watcher'
  | 'add-comment'
  | 'add-label'
  | 'set-custom-field';

/** A set-field action's typed value, by the field it targets. Built-in fields
 * the shipped `workItemsService.update` accepts. Open ids (assignee user id,
 * status id) are NOT whitelisted — a deleted referent is matched at execution
 * (the 6.1 stale-referent rule), not rejected here. */
export type AutomationSetFieldValue =
  | { field: 'assignee'; value: string | null }
  | { field: 'priority'; value: AutomationPriority }
  | { field: 'dueDate'; value: string | null }
  | { field: 'estimate'; value: number | null };

/** The normalized, stored action config — a discriminated union keyed by type.
 * The four Epic-5 arms carry OPEN referent ids (user / label name / custom-field
 * id + value) — never whitelisted here; a deleted/ineligible referent is matched
 * at execution as a RECORDED failure (the 6.1 stale-referent rule), not a write
 * reject. */
export type AutomationActionConfig =
  | { type: 'transition'; toStatusId: string }
  | ({ type: 'set_field' } & AutomationSetFieldValue)
  | { type: 'add_watcher'; userId: string }
  | { type: 'add_comment'; bodyMd: string }
  | { type: 'add_label'; name: string }
  | { type: 'set_custom_field'; fieldId: string; value: string | number | null };

export interface AutomationActionDef {
  type: AutomationActionType;
  editorKind: AutomationActionEditorKind;
  /** Parse + validate a raw config into its normalized union member — typed
   * throw (→ 422) on a malformed config. TOTAL. */
  parseConfig(raw: unknown): AutomationActionConfig;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ESTIMATE_MINUTES = 1_000_000_000;

function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const parsed = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(s);
}

function parseSetFieldValue(o: Record<string, unknown>): AutomationSetFieldValue {
  const field = o['field'];
  if (typeof field !== 'string' || !isSetField(field)) {
    throw new InvalidAutomationActionConfigError(
      'set_field',
      `field must be one of ${AUTOMATION_SET_FIELDS.join(', ')}`,
    );
  }
  const value = o['value'];
  switch (field) {
    case 'assignee': {
      // null = unassign; otherwise an open user id (stale-checked at execution).
      if (value !== null && (typeof value !== 'string' || value.length === 0)) {
        throw new InvalidAutomationActionConfigError(
          'set_field',
          'assignee value must be a user id or null',
        );
      }
      return { field: 'assignee', value: value as string | null };
    }
    case 'priority': {
      if (typeof value !== 'string' || !isPriority(value)) {
        throw new InvalidAutomationActionConfigError(
          'set_field',
          `priority value must be one of ${AUTOMATION_PRIORITIES.join(', ')}`,
        );
      }
      return { field: 'priority', value };
    }
    case 'dueDate': {
      if (value !== null && (typeof value !== 'string' || !isValidIsoDate(value))) {
        throw new InvalidAutomationActionConfigError(
          'set_field',
          'dueDate value must be a YYYY-MM-DD date or null',
        );
      }
      return { field: 'dueDate', value: value as string | null };
    }
    case 'estimate': {
      if (
        value !== null &&
        (typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value < 0 ||
          value > MAX_ESTIMATE_MINUTES)
      ) {
        throw new InvalidAutomationActionConfigError(
          'set_field',
          'estimate value must be a non-negative number of minutes or null',
        );
      }
      return { field: 'estimate', value: value as number | null };
    }
  }
}

const ACTION_DEFS: ReadonlyArray<AutomationActionDef> = [
  {
    type: 'transition',
    editorKind: 'transition',
    parseConfig(raw) {
      const o = asObject(raw);
      const toStatusId = o['toStatusId'];
      // Open status id — a deleted target is a recorded failure at execution
      // (6.6.2), not a validation reject (the 6.1 stale-referent rule).
      if (typeof toStatusId !== 'string' || toStatusId.length === 0) {
        throw new InvalidAutomationActionConfigError(
          'transition',
          'toStatusId must be a status id string',
        );
      }
      return { type: 'transition', toStatusId };
    },
  },
  {
    type: 'set_field',
    editorKind: 'set-field',
    parseConfig(raw) {
      return { type: 'set_field', ...parseSetFieldValue(asObject(raw)) };
    },
  },
  // --- Epic-5 extensions (Subtask 6.6.3) — each over a shipped Epic-5 service ---
  {
    // add_watcher → watchersService.addWatcher (5.4.4). The target is an OPEN
    // user id; the service's view-access validation is the authority (an
    // ineligible / deleted user is a recorded failure at execution, the
    // stale-referent rule), so this only checks the SHAPE.
    type: 'add_watcher',
    editorKind: 'add-watcher',
    parseConfig(raw) {
      const o = asObject(raw);
      return {
        type: 'add_watcher',
        userId: requireNonEmptyString(o['userId'], 'add_watcher', 'userId'),
      };
    },
  },
  {
    // add_comment → commentsService.addComment (5.1.2). A fixed body, bounded so
    // the stored rule JSON stays bounded (the comment system enforces only
    // non-empty); mention parsing + the provenance-stamped event are the
    // service's concern at execution.
    type: 'add_comment',
    editorKind: 'add-comment',
    parseConfig(raw) {
      const o = asObject(raw);
      const bodyMd = o['bodyMd'];
      if (typeof bodyMd !== 'string' || bodyMd.trim().length === 0) {
        throw new InvalidAutomationActionConfigError(
          'add_comment',
          'bodyMd must be a non-empty string',
        );
      }
      if (bodyMd.length > AUTOMATION_COMMENT_BODY_MAX_LENGTH) {
        throw new InvalidAutomationActionConfigError(
          'add_comment',
          `bodyMd is at most ${AUTOMATION_COMMENT_BODY_MAX_LENGTH} characters`,
        );
      }
      return { type: 'add_comment', bodyMd };
    },
  },
  {
    // add_label → labelsService.addLabel (5.4.2, find-or-create). The name is
    // normalized (slugified, deduped) by the service; here we bound the raw
    // string by the same LABEL_NAME_MAX_LENGTH the service enforces, so an
    // over-long name is a typed 422 at authoring rather than an execution
    // failure.
    type: 'add_label',
    editorKind: 'add-label',
    parseConfig(raw) {
      const o = asObject(raw);
      const name = requireNonEmptyString(o['name'], 'add_label', 'name');
      if (name.length > LABEL_NAME_MAX_LENGTH) {
        throw new InvalidAutomationActionConfigError(
          'add_label',
          `name is at most ${LABEL_NAME_MAX_LENGTH} characters`,
        );
      }
      return { type: 'add_label', name };
    },
  },
  {
    // set_custom_field → customFieldValuesService.setValue (5.3.3). The registry
    // can't know the field's type without the DB, so it validates only the
    // SHAPE — a field id + a scalar value (string / number / null). The service
    // is the per-type authority at execution (select-of-this-field, member-can-
    // view for user, ISO date, decimal number); a deleted field / archived
    // option / non-member is a recorded failure, the stale-referent rule.
    type: 'set_custom_field',
    editorKind: 'set-custom-field',
    parseConfig(raw) {
      const o = asObject(raw);
      const fieldId = requireNonEmptyString(o['fieldId'], 'set_custom_field', 'fieldId');
      // Absent value (undefined) normalizes to a clear (null) — the same
      // no-tombstone clear the values service applies.
      const value = o['value'];
      if (
        value !== null &&
        value !== undefined &&
        typeof value !== 'string' &&
        typeof value !== 'number'
      ) {
        throw new InvalidAutomationActionConfigError(
          'set_custom_field',
          'value must be a string, a number, or null',
        );
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new InvalidAutomationActionConfigError(
          'set_custom_field',
          'value must be a finite number',
        );
      }
      return { type: 'set_custom_field', fieldId, value: value ?? null };
    },
  },
];

/** A non-empty trimmed string referent id (user / label / field id), or the
 * typed 422. The id stays OPEN — existence is a stale-referent check at
 * execution, never a whitelist here. */
function requireNonEmptyString(value: unknown, actionType: string, slot: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidAutomationActionConfigError(actionType, `${slot} must be a non-empty string`);
  }
  return value;
}

function isSetField(v: string): v is AutomationSetFieldId {
  return (AUTOMATION_SET_FIELDS as readonly string[]).includes(v);
}

function isPriority(v: string): v is AutomationPriority {
  return (AUTOMATION_PRIORITIES as readonly string[]).includes(v);
}

/** Every action type, in editor menu order. */
export const AUTOMATION_ACTION_TYPES: ReadonlyArray<AutomationActionType> = ACTION_DEFS.map(
  (d) => d.type,
);

const ACTION_DEFS_BY_TYPE: ReadonlyMap<string, AutomationActionDef> = new Map(
  ACTION_DEFS.map((d) => [d.type, d]),
);

/** TOTAL action lookup: a hit, or the typed 422 — never undefined. */
export function automationActionDef(actionType: string): AutomationActionDef {
  const def = ACTION_DEFS_BY_TYPE.get(actionType);
  if (!def) throw new UnknownAutomationActionError(actionType);
  return def;
}

/** Parse + validate one raw action (its `type` + config) into the stored
 * config. Typed throw on an unknown type or a malformed config (both → 422). */
export function parseAction(raw: unknown): AutomationActionConfig {
  const o = asObject(raw);
  const type = o['type'];
  if (typeof type !== 'string') {
    throw new UnknownAutomationActionError(String(type));
  }
  return automationActionDef(type).parseConfig(o);
}

// ---------------------------------------------------------------------------
// The action-executor contract (the 6.6.2 hook)
// ---------------------------------------------------------------------------
//
// 6.6.1 declares the SIGNATURE every action's executor conforms to; 6.6.2
// implements the executor map (keyed by action type) that runs the action
// through the shipped services (transition → workflowsService, set_field →
// workItemsService.update) AS THE RULE OWNER. Kept Prisma-free here (the
// concrete `tx` threading is 6.6.2's concern) so the registry stays pure.

/** The context an action executor (6.6.2) runs within — the triggering item +
 * the rule actor (the rule owner, the recorded 6.6 deviation). */
export interface AutomationActionExecutionContext {
  workspaceId: string;
  projectId: string;
  workItemId: string;
  ruleId: string;
  /** The rule owner — actions execute attributed to them. */
  actorUserId: string;
}

/** The execute fn signature each action entry promises (6.6.2 supplies the
 * implementation keyed on the action `type`). */
export type AutomationActionExecutor<C extends AutomationActionConfig = AutomationActionConfig> = (
  config: C,
  context: AutomationActionExecutionContext,
) => Promise<void>;
