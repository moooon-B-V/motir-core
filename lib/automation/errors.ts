// Typed errors for the automation domain (Story 6.6 · Subtask 6.6.1). The
// trigger/action registries are TOTAL over an open input space (mistake #29):
// an unknown trigger type, an unknown action type, a malformed config, or an
// over-cap rule is an explicit, typed rejection — never a silent pass-through
// toward execution. The route layer maps every one of these to a 422, matching
// the `readonly code` convention the filters / saved-filters domains
// established. Condition-AST forgery rides the 6.1 FilterValidationError
// (also → 422); a stale referent (deleted status/field) is NOT an error here —
// it degrades the same way the 6.1 resolver degrades (the durable rule).
//
// Permission + existence errors are NOT in this module: the service reuses the
// shipped 6.4 ProjectNotFoundError (→ 404) and NotProjectAdminError (→ 403),
// plus a domain AutomationRuleNotFoundError (→ 404) for the per-rule paths.

export type AutomationErrorTag =
  | 'UNKNOWN_AUTOMATION_TRIGGER'
  | 'UNKNOWN_AUTOMATION_ACTION'
  | 'INVALID_AUTOMATION_TRIGGER_CONFIG'
  | 'INVALID_AUTOMATION_ACTION_CONFIG'
  | 'INVALID_AUTOMATION_RULE'
  | 'AUTOMATION_RULE_LIMIT'
  | 'AUTOMATION_ACTION_LIMIT';

/** Base class for the typed 422s the registries + service raise on forged or
 * over-cap input. `code` mirrors `tag` (the house convention). */
export abstract class AutomationValidationError extends Error {
  abstract readonly tag: AutomationErrorTag;
  get code(): AutomationErrorTag {
    return this.tag;
  }
}

/** A rule names a trigger type the registry does not know. */
export class UnknownAutomationTriggerError extends AutomationValidationError {
  readonly tag = 'UNKNOWN_AUTOMATION_TRIGGER' as const;
  constructor(readonly triggerType: string) {
    super(`Unknown automation trigger: ${triggerType}`);
    this.name = 'UnknownAutomationTriggerError';
  }
}

/** An action names a type the registry does not know. */
export class UnknownAutomationActionError extends AutomationValidationError {
  readonly tag = 'UNKNOWN_AUTOMATION_ACTION' as const;
  constructor(readonly actionType: string) {
    super(`Unknown automation action: ${actionType}`);
    this.name = 'UnknownAutomationActionError';
  }
}

/** A trigger's config fails its registry validation (bad/extra/missing field,
 * unknown narrowing field id, malformed value). */
export class InvalidAutomationTriggerConfigError extends AutomationValidationError {
  readonly tag = 'INVALID_AUTOMATION_TRIGGER_CONFIG' as const;
  constructor(
    readonly triggerType: string,
    detail: string,
  ) {
    super(`Invalid config for trigger ${triggerType}: ${detail}`);
    this.name = 'InvalidAutomationTriggerConfigError';
  }
}

/** An action's config fails its registry validation. */
export class InvalidAutomationActionConfigError extends AutomationValidationError {
  readonly tag = 'INVALID_AUTOMATION_ACTION_CONFIG' as const;
  constructor(
    readonly actionType: string,
    detail: string,
  ) {
    super(`Invalid config for action ${actionType}: ${detail}`);
    this.name = 'InvalidAutomationActionConfigError';
  }
}

/** The rule's shape is malformed at the top level (bad name, actions not a
 * list, an empty action list, etc.) — distinct from a per-trigger/-action
 * config problem. */
export class InvalidAutomationRuleError extends AutomationValidationError {
  readonly tag = 'INVALID_AUTOMATION_RULE' as const;
  constructor(detail: string) {
    super(`Invalid automation rule: ${detail}`);
    this.name = 'InvalidAutomationRuleError';
  }
}

/** The per-project rule cap (100) would be exceeded. */
export class AutomationRuleLimitError extends AutomationValidationError {
  readonly tag = 'AUTOMATION_RULE_LIMIT' as const;
  constructor(readonly cap: number) {
    super(`This project is at its automation-rule limit (${cap}).`);
    this.name = 'AutomationRuleLimitError';
  }
}

/** The per-rule action cap (10) would be exceeded. */
export class AutomationActionLimitError extends AutomationValidationError {
  readonly tag = 'AUTOMATION_ACTION_LIMIT' as const;
  constructor(readonly cap: number) {
    super(`A rule may have at most ${cap} actions.`);
    this.name = 'AutomationActionLimitError';
  }
}

/** A rule id does not resolve within the (browsable) project — the per-rule
 * 404 (missing, cross-tenant, or in another project: indistinguishable). */
export class AutomationRuleNotFoundError extends Error {
  readonly code = 'AUTOMATION_RULE_NOT_FOUND' as const;
  constructor(ruleId: string) {
    super(`Automation rule ${ruleId} not found.`);
    this.name = 'AutomationRuleNotFoundError';
  }
}
