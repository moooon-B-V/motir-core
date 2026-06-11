// The per-field-type operator registry (Story 6.1 · Subtask 6.1.1) — the
// single source of truth for what the filter builder can say: every built-in
// field maps to an explicit operator set, a per-(field, operator) value
// arity/validation, and a value-editor kind (the UI contract 6.1.3 / 6.1.4
// consume). TOTAL over an open input space (mistake #29): an unknown field or
// operator id, or a malformed value, is a typed rejection
// (lib/filters/errors.ts → 422 at the HTTP layer) — never a silent
// pass-through toward SQL. The SQL emission itself lives in the repository
// layer (`workItemRepository.compileFilterConditionsSql`, the 4-layer rule —
// this module stays Prisma-free so the client builder can import it), keyed
// off the SAME field defs, with a totality test enumerating every
// (field × operator) triple across validate × compile × editor.
//
// Operator semantics (the story's verified Jira basic/JQL split — the builder
// ships exactly the blacklist basic can't say, as structured rows):
//   enum-ish  → is any of / is none of (+ is empty / is not empty when the
//               column is nullable; the assignee/sprint value lists also
//               accept their empty-bucket sentinel — Jira's "Unassigned")
//   text      → contains / does not contain
//   numbers   → = ≠ < ≤ > ≥ (+ empty/not-empty — both number columns are
//               nullable)
//   dates     → on or before / on or after / between / in the last N days /
//               in the next N days (+ empty/not-empty for the nullable due
//               date; created/updated are NOT NULL so the empty pair would be
//               dead weight in their menus)
//   `ne` mirrors JQL `!=`: it does NOT match empty fields (the documented
//   Jira rule); `is_none_of` on a nullable column DOES include the empty
//   bucket unless the sentinel is in the list (an unassigned issue is
//   assigned to "none of" any member list).

import { ISSUE_TYPES } from '@/lib/issues/parentRules';
import {
  FILTER_BACKLOG_TOKEN,
  FILTER_ROW_CAP,
  FILTER_UNASSIGNED_TOKEN,
  type FilterAst,
  type FilterCondition,
  type FilterConditionValue,
  type FilterFieldId,
  type FilterOperatorId,
} from './ast';
import {
  FilterTooLargeError,
  InvalidFilterValueError,
  MalformedFilterError,
  UnknownFilterFieldError,
  UnknownFilterOperatorError,
} from './errors';

export type FilterFieldType = 'enum' | 'text' | 'number' | 'date';

/** What the builder renders for a condition's value slot (6.1.3/6.1.4). */
export type FilterValueEditorKind =
  | 'kind-select'
  | 'status-select'
  | 'priority-select'
  | 'member-select'
  | 'sprint-select'
  | 'text'
  | 'number'
  | 'date'
  | 'date-range'
  | 'days'
  | 'none';

const ENUM_LIST_OPERATORS = ['is_any_of', 'is_none_of'] as const;
const EMPTY_OPERATORS = ['is_empty', 'is_not_empty'] as const;
const TEXT_OPERATORS = ['contains', 'not_contains'] as const;
const NUMBER_COMPARE_OPERATORS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const;
const DATE_VALUE_OPERATORS = ['on_or_before', 'on_or_after', 'between'] as const;
const DATE_WINDOW_OPERATORS = ['in_last_days', 'in_next_days'] as const;

/** Bounds — sanity guards, not business rules. */
const MAX_LIST_VALUES = 50;
const MAX_TEXT_LENGTH = 200;
const MAX_NUMBER_MAGNITUDE = 1_000_000_000;
const MAX_WINDOW_DAYS = 365;

export interface FilterFieldDef {
  id: FilterFieldId;
  fieldType: FilterFieldType;
  /** Nullable column → the field offers the empty/not-empty pair. */
  nullable: boolean;
  /** The empty-bucket token its value lists may carry (assignee/sprint). */
  emptySentinel?: string;
  /** Closed value vocabulary (kind, priority); open ids stay unchecked here —
   * an unknown status key / member id simply matches nothing, which is safe
   * (the 2.5.4 rule) and is the stale-referent behaviour the story pins. */
  valueWhitelist?: readonly string[];
  /** The list-op value editor (enum fields only). */
  listEditor?: FilterValueEditorKind;
  operators: readonly FilterOperatorId[];
}

function enumField(
  id: FilterFieldId,
  listEditor: FilterValueEditorKind,
  opts: { nullable?: boolean; emptySentinel?: string; valueWhitelist?: readonly string[] } = {},
): FilterFieldDef {
  return {
    id,
    fieldType: 'enum',
    nullable: opts.nullable ?? false,
    emptySentinel: opts.emptySentinel,
    valueWhitelist: opts.valueWhitelist,
    listEditor,
    operators: opts.nullable ? [...ENUM_LIST_OPERATORS, ...EMPTY_OPERATORS] : ENUM_LIST_OPERATORS,
  };
}

function numberField(id: FilterFieldId): FilterFieldDef {
  // Both number columns (storyPoints, estimateMinutes) are nullable.
  return {
    id,
    fieldType: 'number',
    nullable: true,
    operators: [...NUMBER_COMPARE_OPERATORS, ...EMPTY_OPERATORS],
  };
}

function dateField(id: FilterFieldId, nullable: boolean): FilterFieldDef {
  return {
    id,
    fieldType: 'date',
    nullable,
    operators: nullable
      ? [...DATE_VALUE_OPERATORS, ...DATE_WINDOW_OPERATORS, ...EMPTY_OPERATORS]
      : [...DATE_VALUE_OPERATORS, ...DATE_WINDOW_OPERATORS],
  };
}

const PRIORITIES = ['lowest', 'low', 'medium', 'high', 'highest'] as const;

/** The registry — every built-in field, in the builder's menu order. */
export const FILTER_FIELDS: ReadonlyArray<FilterFieldDef> = [
  enumField('kind', 'kind-select', { valueWhitelist: ISSUE_TYPES }),
  enumField('status', 'status-select'),
  enumField('priority', 'priority-select', { valueWhitelist: PRIORITIES }),
  enumField('assignee', 'member-select', {
    nullable: true,
    emptySentinel: FILTER_UNASSIGNED_TOKEN,
  }),
  enumField('reporter', 'member-select'),
  enumField('sprint', 'sprint-select', { nullable: true, emptySentinel: FILTER_BACKLOG_TOKEN }),
  { id: 'text', fieldType: 'text', nullable: false, operators: [...TEXT_OPERATORS] },
  dateField('created', false),
  dateField('updated', false),
  dateField('due', true),
  numberField('storyPoints'),
  numberField('estimate'),
];

const FIELDS_BY_ID: ReadonlyMap<string, FilterFieldDef> = new Map(
  FILTER_FIELDS.map((f) => [f.id, f]),
);

/** TOTAL field lookup: a hit, or the typed 422 — never undefined. */
export function filterFieldDef(field: string): FilterFieldDef {
  const def = FIELDS_BY_ID.get(field);
  if (!def) throw new UnknownFilterFieldError(field);
  return def;
}

/** The value editor a (field, operator) pair needs — total by construction. */
export function filterValueEditorKind(
  def: FilterFieldDef,
  operator: FilterOperatorId,
): FilterValueEditorKind {
  switch (operator) {
    case 'is_any_of':
    case 'is_none_of':
      return def.listEditor ?? 'text';
    case 'is_empty':
    case 'is_not_empty':
      return 'none';
    case 'contains':
    case 'not_contains':
      return 'text';
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return 'number';
    case 'on_or_before':
    case 'on_or_after':
      return 'date';
    case 'between':
      return 'date-range';
    case 'in_last_days':
    case 'in_next_days':
      return 'days';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const parsed = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(s);
}

/** A validation failure reason, or null when the value fits the pair. */
function valueProblem(
  def: FilterFieldDef,
  operator: FilterOperatorId,
  value: FilterConditionValue,
): string | null {
  switch (operator) {
    case 'is_any_of':
    case 'is_none_of': {
      if (!Array.isArray(value)) return 'expected a value list';
      if (value.length === 0) return 'expected at least one value';
      if (value.length > MAX_LIST_VALUES) return `over the ${MAX_LIST_VALUES}-value cap`;
      for (const v of value) {
        if (typeof v !== 'string' || v.length === 0) return 'expected non-empty string values';
        if (v.length > MAX_TEXT_LENGTH) return 'value too long';
        if (def.valueWhitelist && !def.valueWhitelist.includes(v)) return `unknown value: ${v}`;
      }
      return null;
    }
    case 'is_empty':
    case 'is_not_empty':
      return value === null ? null : 'expected no value';
    case 'contains':
    case 'not_contains': {
      if (typeof value !== 'string') return 'expected a string';
      if (value.trim().length === 0) return 'expected a non-empty string';
      if (value.length > MAX_TEXT_LENGTH) return 'value too long';
      return null;
    }
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'expected a number';
      if (Math.abs(value) > MAX_NUMBER_MAGNITUDE) return 'number out of range';
      return null;
    }
    case 'on_or_before':
    case 'on_or_after': {
      if (typeof value !== 'string' || !isValidIsoDate(value)) return 'expected a YYYY-MM-DD date';
      return null;
    }
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2) return 'expected a [from, to] date pair';
      const [from, to] = value;
      if (typeof from !== 'string' || !isValidIsoDate(from)) return 'expected a YYYY-MM-DD from';
      if (typeof to !== 'string' || !isValidIsoDate(to)) return 'expected a YYYY-MM-DD to';
      if (from > to) return 'from is after to';
      return null;
    }
    case 'in_last_days':
    case 'in_next_days': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return 'expected a day count';
      if (value < 1 || value > MAX_WINDOW_DAYS) return `expected 1–${MAX_WINDOW_DAYS} days`;
      return null;
    }
  }
}

/**
 * Validate one condition against the registry — typed throws on an unknown
 * field, an operator outside the field's set, or a value that fails the
 * (field, operator) arity. Returns the field def so compile paths chain off
 * one lookup.
 */
export function validateFilterCondition(condition: FilterCondition): FilterFieldDef {
  const def = filterFieldDef(condition.field);
  if (!def.operators.includes(condition.operator)) {
    throw new UnknownFilterOperatorError(condition.field, condition.operator);
  }
  const problem = valueProblem(def, condition.operator, condition.value);
  if (problem) throw new InvalidFilterValueError(condition.field, condition.operator, problem);
  return def;
}

/**
 * Validate a whole AST: structure, the row cap, and every condition. The
 * service read path runs this before the repository compiles (defence in
 * depth: the compiler re-runs it, so no unvalidated AST can reach SQL even
 * through a future second caller).
 */
export function validateFilterAst(ast: FilterAst): void {
  if (ast.combinator !== 'and' && ast.combinator !== 'or') {
    throw new MalformedFilterError(`bad combinator: ${String(ast.combinator)}`);
  }
  if (!Array.isArray(ast.conditions)) throw new MalformedFilterError('conditions not an array');
  if (ast.conditions.length > FILTER_ROW_CAP) {
    throw new FilterTooLargeError(ast.conditions.length, FILTER_ROW_CAP);
  }
  for (const condition of ast.conditions) validateFilterCondition(condition);
}
