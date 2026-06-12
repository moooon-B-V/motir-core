// The /issues ADVANCED-filter URL plumbing (Story 6.1 · Subtask 6.1.4) — the
// thin, UI-free layer between the 6.1.1 FilterAST substrate (codec + registry,
// `lib/filters/*`) and the /issues surface. It owns:
//
//   • parsing the `?filter=v1:…` param at the page boundary into a typed,
//     RECOVERABLE three-state result (none / invalid / active) — a malformed,
//     foreign-versioned, or forged param renders the designed callout over the
//     UNFILTERED list, never a crash (the 6.1.1 contract surfaced here);
//   • the facet-expressiveness check that drives the SUPERSEDED facet-button
//     state (the one-way basic→advanced mirror rule);
//   • the lossless facet→builder upgrade ("Edit in Advanced");
//   • the builder's ROW model — the working copy that also holds PENDING
//     (incomplete) rows, which live ONLY in the client: the URL, the badge
//     count, and the result set carry complete rows exclusively (the designed
//     live-apply rule).
//
// Kept pure (no React, no Prisma) like its siblings `issueListFilter.ts` /
// `issueListView.ts` — unit-tested in isolation.

import {
  decodeFilterParam,
  encodeFilterParam,
  facetFilterToAst,
  FILTER_ROW_CAP,
  type FilterAst,
  type FilterCondition,
  type FilterConditionValue,
  type FilterFieldId,
  type FilterOperatorId,
} from '@/lib/filters/ast';
import {
  FILTER_FIELDS,
  filterValueEditorKind,
  resolveFilterAst,
  validateFilterCondition,
  type FilterFieldDef,
  type FilterValueEditorKind,
} from '@/lib/filters/registry';
import { FilterValidationError } from '@/lib/filters/errors';
import type { IssueFilter } from '@/lib/issues/issueListFilter';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';

// ---------------------------------------------------------------------------
// Parsing the `?filter=` param (the page boundary)
// ---------------------------------------------------------------------------

export type AdvancedFilterParse =
  | { state: 'none' }
  /** Malformed / foreign-version / forged param — the typed recoverable
   * state: the page renders the designed callout and applies NO filter. */
  | { state: 'invalid' }
  | { state: 'active'; ast: FilterAst; encoded: string };

/**
 * Decode + validate the raw `?filter=` param (as `parseIssueFilter` carried
 * it on `IssueFilter.advanced`). Validation runs against the STATIC registry
 * only (no project referents here — this is a pure parser): a forged built-in
 * field/operator id or a value failing its arity is `invalid`; Epic-5
 * conditions (`lbl` / `cmp` / `cf:<id>`) resolve as stale-not-error per the
 * 6.1.2 contract, so a shared URL carrying them parses `active` and the
 * service read degrades them to match-nothing. An empty condition list
 * constrains nothing and parses as `none`.
 */
export function parseAdvancedFilterParam(raw: string | null): AdvancedFilterParse {
  if (raw === null || raw.length === 0) return { state: 'none' };
  const decoded = decodeFilterParam(raw);
  if (!decoded.ok) return { state: 'invalid' };
  if (decoded.ast.conditions.length === 0) return { state: 'none' };
  try {
    resolveFilterAst(decoded.ast);
  } catch (err) {
    if (err instanceof FilterValidationError) return { state: 'invalid' };
    throw err;
  }
  return { state: 'active', ast: decoded.ast, encoded: raw };
}

/** Set (or clear, with null / an empty AST) the advanced param on a filter —
 * the single write path the builder pushes through `buildIssueListHref`. */
export function setAdvancedParam(f: IssueFilter, ast: FilterAst | null): IssueFilter {
  const advanced = ast !== null && ast.conditions.length > 0 ? encodeFilterParam(ast) : null;
  return { ...f, advanced };
}

/** Clear the FACETS only, keeping the advanced param (the facet popover's
 * "Clear filters" must not drop an active builder state). */
export function clearFacets(f: IssueFilter): IssueFilter {
  return { ...EMPTY_FILTER, advanced: f.advanced };
}

// ---------------------------------------------------------------------------
// Facet expressiveness — the SUPERSEDED state + the one-way upgrade
// ---------------------------------------------------------------------------

/** The (field, operator) pairs the 2.5.4 facet bar can say — one set per
 * field, AND-ed, plus the single text quick-filter. */
const FACET_EXPRESSIBLE: ReadonlyMap<string, FilterOperatorId> = new Map([
  ['kind', 'is_any_of'],
  ['status', 'is_any_of'],
  ['assignee', 'is_any_of'],
  ['text', 'contains'],
]);

/**
 * True when the AST says something the 2.5.4 facet bar CANNOT — OR across
 * rows, negation, empty/comparison/date operators, non-facet fields, or a
 * repeated facet field (facets hold ONE value set per field). This drives the
 * superseded facet-button state, which appears EXACTLY when this is true (the
 * 6.1.4 AC). An explicit `or` combinator counts as exceeding even with one
 * row: the wire form says `or`, and re-reading it as a facet would be the
 * silent down-conversion the mirror rule forbids — it also guarantees facets
 * are only ever editable beside an all-AND AST, which keeps the upgrade merge
 * below semantics-preserving.
 */
export function astExceedsFacets(ast: FilterAst): boolean {
  if (ast.conditions.length === 0) return false;
  if (ast.combinator === 'or') return true;
  const seen = new Set<string>();
  for (const c of ast.conditions) {
    if (FACET_EXPRESSIBLE.get(c.field) !== c.operator) return true;
    if (seen.has(c.field)) return true;
    seen.add(c.field);
  }
  return false;
}

/**
 * The one-way "Edit in Advanced" upgrade: every facet selection becomes a
 * builder row (LOSSLESS — the 6.1.1 `facetFilterToAst` map), APPENDED to any
 * rows the builder already holds. The merge is always under `and`: facets are
 * read-only while a beyond-facet AST is active (and an `or` AST counts as
 * beyond, see {@link astExceedsFacets}), so an editable facet state can only
 * coexist with an all-AND AST — appending AND-rows preserves both meanings.
 */
export function upgradeFacetsIntoAst(facets: IssueFilter, existing: FilterAst | null): FilterAst {
  const upgraded = facetFilterToAst(facets);
  if (existing === null || existing.conditions.length === 0) return upgraded;
  return {
    combinator: existing.combinator,
    conditions: [...existing.conditions, ...upgraded.conditions],
  };
}

// ---------------------------------------------------------------------------
// The builder's row model (pending rows live here, never in the URL)
// ---------------------------------------------------------------------------

/** A working builder row. `value: null` (or an empty list / blank string /
 * half-filled range) = the PENDING state — drawn dashed, excluded from the
 * badge count, the URL, and the result set until it validates. */
export interface AdvancedBuilderRow {
  /** Stable client-side key (NOT the row's position — rows are removable). */
  key: number;
  field: FilterFieldId;
  operator: FilterOperatorId;
  value: FilterConditionValue | null;
}

/** The value-editor kinds Subtask 6.1.4 ships (built-in fields). The Epic-5
 * editors — label / component / CF-option pickers — are Subtask 6.1.5's rows;
 * until it lands, a URL carrying such a condition renders a degraded
 * read-only row (still filtering through the 6.1.2 compile path). */
const BUILT_IN_EDITOR_KINDS: ReadonlySet<FilterValueEditorKind> = new Set([
  'kind-select',
  'status-select',
  'priority-select',
  'member-select',
  'sprint-select',
  'text',
  'number',
  'date',
  'date-range',
  'days',
  'none',
]);

/** The field defs the 6.1.4 builder offers in its field menu — the registry's
 * built-in entries (every def whose editors this subtask ships), in registry
 * (= menu) order. Parameterized for the registry-driven AC: a test (or 6.1.5)
 * passes an extended list and the rows render it with zero UI changes. */
export function advancedBuilderFields(
  fields: ReadonlyArray<FilterFieldDef> = FILTER_FIELDS,
): FilterFieldDef[] {
  return fields.filter((def) =>
    def.operators.every((op) => BUILT_IN_EDITOR_KINDS.has(filterValueEditorKind(def, op))),
  );
}

/** A row's condition shape (pending rows carry `value: null` here — only
 * meaningful for validation / complete rows). */
export function rowCondition(row: AdvancedBuilderRow): FilterCondition {
  return { field: row.field, operator: row.operator, value: row.value };
}

/** True when the row validates against the registry for its (field, operator)
 * pair — the live-apply gate. Pending shapes (null / empty list / blank text /
 * half-filled range) all fail validation, which is exactly the designed
 * pending semantics; zero-arity operators (is empty / is not empty) are
 * complete with no value. */
export function isRowComplete(row: AdvancedBuilderRow): boolean {
  try {
    validateFilterCondition(rowCondition(row));
    return true;
  } catch (err) {
    if (err instanceof FilterValidationError) return false;
    throw err;
  }
}

/** The AST the builder's complete rows currently say — what live-apply
 * writes to the URL (pending rows excluded). */
export function astFromRows(
  combinator: FilterAst['combinator'],
  rows: AdvancedBuilderRow[],
): FilterAst {
  return {
    combinator,
    conditions: rows.filter(isRowComplete).map(rowCondition),
  };
}

/** Seed working rows from an applied AST (keys are positional — stable for a
 * one-shot seed; subsequent edits mint fresh keys). */
export function rowsFromAst(ast: FilterAst | null): AdvancedBuilderRow[] {
  if (ast === null) return [];
  return ast.conditions.map((c, i) => ({ key: i + 1, ...c }));
}

/** A field's default operator — the first in its registry set. */
export function defaultOperator(def: FilterFieldDef): FilterOperatorId {
  return def.operators[0]!;
}

/** Carry a row's value across an operator change when the value editor stays
 * the same kind (is any of ↔ is none of keeps the list; contains ↔ does not
 * contain keeps the text; comparisons keep the number; on-or-before ↔
 * on-or-after keeps the date); otherwise reset to pending. */
export function carryValueAcrossOperator(
  def: FilterFieldDef,
  prev: FilterOperatorId,
  next: FilterOperatorId,
  value: FilterConditionValue | null,
): FilterConditionValue | null {
  return filterValueEditorKind(def, prev) === filterValueEditorKind(def, next) ? value : null;
}

export { FILTER_ROW_CAP };
