// Bounded everywhere (Story 6.6, finding #57) — the real-product caps Jira
// enforces, each surfaced as a typed 422 with a designed state, never a silent
// truncation. Kept in their own pure module so the service, the registry
// validation, and the tests share ONE source of truth.

/** Max rules per project (the Jira number). The 101st create is a typed 422. */
export const AUTOMATION_RULES_PER_PROJECT_CAP = 100;

/** Max actions in one rule's ordered list. The 11th action is a typed 422. */
export const AUTOMATION_ACTIONS_PER_RULE_CAP = 10;

/** Max condition rows — the 6.1 FILTER_ROW_CAP, re-pinned here so the
 * automation surface reads its own constant (the condition group reuses the
 * 6.1 AST + its 20-row cap wholesale). */
export const AUTOMATION_CONDITION_ROW_CAP = 20;

/** Rule-name length bound (the saved-filter name cap precedent). */
export const AUTOMATION_RULE_NAME_MAX_LENGTH = 120;

/** The consecutive-failure count that auto-disables a rule (the verified Jira
 * number). The engine (6.6.2) enforces it; 6.6.1 ships the column + the
 * enable-resets-the-counter rule. */
export const AUTOMATION_AUTO_DISABLE_THRESHOLD = 10;
