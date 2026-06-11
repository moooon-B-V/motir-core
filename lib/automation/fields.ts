// The built-in field vocabularies the automation registry's field-changed
// trigger + set-field action draw from (Story 6.6 · Subtask 6.6.1). Kept in
// their own pure module so the registry, the editor UI (6.6.5), and the tests
// share one source of truth. These are exactly the built-in fields the shipped
// `workItemsService.update` accepts as simple settable values (rung 2 — the
// already-shipped code outranks the card's "story points" prose: the shipped
// update path exposes assignee / priority / due date / estimate, so those are
// the fields a rule can both watch and set today). The Epic-5 custom-field
// targets are 6.6.3 extensions (the 5.3 customFieldsService path).

/** The built-in fields a `field_changed` trigger can watch. `assignee` is the
 * verified "assigned" preset. */
export const AUTOMATION_FIELD_CHANGED_FIELDS = [
  'assignee',
  'priority',
  'dueDate',
  'estimate',
] as const;

export type AutomationFieldChangedFieldId = (typeof AUTOMATION_FIELD_CHANGED_FIELDS)[number];

/** The built-in fields a `set_field` action can write — the same settable set
 * the shipped `workItemsService.update` accepts. */
export const AUTOMATION_SET_FIELDS = ['assignee', 'priority', 'dueDate', 'estimate'] as const;

export type AutomationSetFieldId = (typeof AUTOMATION_SET_FIELDS)[number];

/** The work-item priority vocabulary (the closed enum the 6.1 filter registry
 * also pins) — the only whitelisted set-field value space; assignee + status
 * ids stay open (stale-referent at execution). */
export const AUTOMATION_PRIORITIES = ['lowest', 'low', 'medium', 'high', 'highest'] as const;

export type AutomationPriority = (typeof AUTOMATION_PRIORITIES)[number];
