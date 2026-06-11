import {
  CUSTOM_FIELD_FILTER_PREFIX,
  customFieldIdOfFilterField,
  customFieldFilterFieldId,
} from '@/lib/filters/ast';
import { UnknownStatisticTypeError } from '@/lib/reports/errors';

// The TOTAL statistic-type registry (Story 6.3 · Subtask 6.3.2) — the closed
// vocabulary the distribution (donut) read groups by. Mirrors Jira's Pie
// Chart "Statistic Type" (verified at plan time): the finite-value fields —
// the SAME enum-ish vocabulary the 6.1 filter registry already enumerates
// (kind, status, priority, assignee, reporter, sprint, label, component,
// select / user custom fields).
//
// TOTALITY (mistake #29): every id this registry can hold maps to exactly one
// `DistributionGroupBy` descriptor the repository's group-by switch is total
// over; an id outside the vocabulary is a typed 422
// (`UnknownStatisticTypeError`), never a silent pass-through. The enumeration
// test walks `BUILTIN_STATISTIC_TYPES` plus the dynamic `cf:` family and
// fails on any registry gap.
//
// Custom fields ride the 6.1.2 `cf:<fieldId>` id form (one vocabulary, two
// consumers — the filter builder and this statistic picker). `parse` checks
// only the FORM here; the service resolves the definition (existence +
// project containment → the typed STALE state when deleted, the 6.1.2
// unknown-value precedent; a non-enum-ish field type → the typed 422).

/** The group-by strategies the repository aggregate is total over. */
export type DistributionGroupBy =
  /** A `work_item` column (enum / FK scalar — one row per item). */
  | {
      kind: 'column';
      column: 'kind' | 'status' | 'priority' | 'assignee' | 'reporter' | 'sprint';
    }
  /** A 5.4.1 join entity — one row per (item, join row); an item with N
   * labels lands in N segments (the verified Jira multi-count behaviour),
   * an item with none lands in the None segment. */
  | { kind: 'join'; entity: 'label' | 'component' }
  /** A 5.3.1 typed-EAV custom field, narrowed to the enum-ish value types. */
  | { kind: 'customField'; fieldId: string; fieldType: 'select' | 'user' };

export interface StatisticTypeDef {
  id: string;
  groupBy: DistributionGroupBy;
}

/** The static (non-custom-field) registry entries, in picker order. */
export const BUILTIN_STATISTIC_TYPES: ReadonlyArray<StatisticTypeDef> = [
  { id: 'kind', groupBy: { kind: 'column', column: 'kind' } },
  { id: 'status', groupBy: { kind: 'column', column: 'status' } },
  { id: 'priority', groupBy: { kind: 'column', column: 'priority' } },
  { id: 'assignee', groupBy: { kind: 'column', column: 'assignee' } },
  { id: 'reporter', groupBy: { kind: 'column', column: 'reporter' } },
  { id: 'sprint', groupBy: { kind: 'column', column: 'sprint' } },
  { id: 'label', groupBy: { kind: 'join', entity: 'label' } },
  { id: 'component', groupBy: { kind: 'join', entity: 'component' } },
];

const BUILTINS_BY_ID: ReadonlyMap<string, StatisticTypeDef> = new Map(
  BUILTIN_STATISTIC_TYPES.map((s) => [s.id, s]),
);

/** The custom-field value types a distribution can group by (enum-ish — a
 * closed value set per field). Free text / numbers / dates are NOT statistic
 * types (matching the mirror's finite-value rule). */
export const DISTRIBUTION_CF_FIELD_TYPES = ['select', 'user'] as const;
export type DistributionCfFieldType = (typeof DISTRIBUTION_CF_FIELD_TYPES)[number];

export function isDistributionCfFieldType(t: string): t is DistributionCfFieldType {
  return (DISTRIBUTION_CF_FIELD_TYPES as readonly string[]).includes(t);
}

/** A parsed statistic id: a builtin def, or the `cf:` form awaiting the
 * service's definition resolution (existence is a DATA question — stale, not
 * 422 — so parsing stops at the id form). */
export type ParsedStatisticType =
  | { kind: 'builtin'; def: StatisticTypeDef }
  | { kind: 'customField'; fieldId: string };

/**
 * TOTAL parse of a raw statistic id: a builtin hit, the well-formed
 * `cf:<fieldId>` family, or the typed 422 — never undefined (mistake #29).
 */
export function parseStatisticType(raw: string): ParsedStatisticType {
  const builtin = BUILTINS_BY_ID.get(raw);
  if (builtin) return { kind: 'builtin', def: builtin };
  if (raw.startsWith(CUSTOM_FIELD_FILTER_PREFIX)) {
    const fieldId = customFieldIdOfFilterField(raw);
    if (fieldId) return { kind: 'customField', fieldId };
  }
  throw new UnknownStatisticTypeError(raw);
}

/** The wire id of a custom-field statistic (`cf:<fieldId>` — the 6.1.2 form). */
export function customFieldStatisticId(fieldId: string): string {
  return customFieldFilterFieldId(fieldId);
}
