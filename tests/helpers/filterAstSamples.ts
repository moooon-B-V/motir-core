import {
  FILTER_UNASSIGNED_TOKEN,
  type FilterCondition,
  type FilterFieldId,
  type FilterOperatorId,
} from '@/lib/filters/ast';
import { FILTER_FIELDS } from '@/lib/filters/registry';

// The 6.1.1 condition generators, extracted as a shared helper so the 6.2
// persistence suites can fuzz the STORED path with the same shapes the codec
// suites fuzz the URL path with (tests/filters/filterAst.test.ts +
// filterRegistry.test.ts keep their local copies — this module is the
// import surface for NEW suites).

/** A valid sample value for every (field, operator) the registry offers. */
export function sampleValue(
  field: FilterFieldId,
  operator: FilterOperatorId,
): FilterCondition['value'] {
  switch (operator) {
    case 'is_any_of':
    case 'is_none_of':
      if (field === 'kind') return ['bug', 'task'];
      if (field === 'priority') return ['high', 'highest'];
      if (field === 'assignee') return ['user-1', FILTER_UNASSIGNED_TOKEN];
      if (field === 'sprint') return ['sprint-1', 'backlog'];
      return ['todo', 'in_progress'];
    case 'is_empty':
    case 'is_not_empty':
      return null;
    case 'contains':
    case 'not_contains':
      return 'oauth callback';
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return 5;
    case 'on_or_before':
    case 'on_or_after':
      return '2026-06-11';
    case 'between':
      return ['2026-06-01', '2026-06-30'];
    case 'in_last_days':
    case 'in_next_days':
      return 14;
  }
}

/** Every (field, operator) pair the registry exposes, as one condition each. */
export function everyConditionShape(): FilterCondition[] {
  return FILTER_FIELDS.flatMap((def) =>
    def.operators.map((operator) => ({
      field: def.id,
      operator,
      value: sampleValue(def.id, operator),
    })),
  );
}
