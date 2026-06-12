// Label resolution for the advanced filter builder (Subtask 6.1.4) — the
// field / operator display names and the per-condition value text shared by
// the builder rows and the applied summary chips. Pure functions over a
// next-intl `t` so both client components reuse one vocabulary.
//
// Field labels resolve through a KNOWN-KEYS map with the registry id itself
// as the fallback — that's what keeps the UI registry-driven (the 6.1.4 AC):
// a brand-new registry entry renders immediately (its raw id as the label
// until copy lands), with zero changes here.

import type { FilterFieldId, FilterOperatorId } from '@/lib/filters/ast';

type Translate = (key: string, values?: Record<string, string | number | Date>) => string;

/** issueViews.* keys for the built-in registry field ids (+ the Epic-5
 * static fields, which a shared URL can carry ahead of 6.1.5's editors). */
const FIELD_LABEL_KEYS: Partial<Record<FilterFieldId, string>> = {
  kind: 'filterKind',
  status: 'status',
  priority: 'advancedFieldPriority',
  assignee: 'assignee',
  reporter: 'advancedFieldReporter',
  sprint: 'advancedFieldSprint',
  text: 'advancedFieldText',
  created: 'advancedFieldCreated',
  updated: 'advancedFieldUpdated',
  due: 'advancedFieldDue',
  storyPoints: 'advancedFieldStoryPoints',
  estimate: 'advancedFieldEstimate',
  lbl: 'labelsField',
  cmp: 'componentsField',
};

export function advancedFieldLabel(t: Translate, field: FilterFieldId): string {
  const key = FIELD_LABEL_KEYS[field];
  return key ? t(key) : field;
}

const OPERATOR_LABEL_KEYS: Record<FilterOperatorId, string> = {
  is_any_of: 'advancedOpIsAnyOf',
  is_none_of: 'advancedOpIsNoneOf',
  is_empty: 'advancedOpIsEmpty',
  is_not_empty: 'advancedOpIsNotEmpty',
  contains: 'advancedOpContains',
  not_contains: 'advancedOpNotContains',
  eq: 'advancedOpEq',
  ne: 'advancedOpNe',
  lt: 'advancedOpLt',
  lte: 'advancedOpLte',
  gt: 'advancedOpGt',
  gte: 'advancedOpGte',
  on_or_before: 'advancedOpOnOrBefore',
  on_or_after: 'advancedOpOnOrAfter',
  between: 'advancedOpBetween',
  in_last_days: 'advancedOpInLastDays',
  in_next_days: 'advancedOpInNextDays',
};

export function advancedOperatorLabel(t: Translate, operator: FilterOperatorId): string {
  return t(OPERATOR_LABEL_KEYS[operator]);
}
