// The advanced-filter FIELD set the builder offers (Story 6.1 · Subtask
// 6.1.5) — the registry's built-in fields PLUS the project's DYNAMIC Epic-5
// entries (one `cf:<id>` def per custom-field definition, built off the 6.1.2
// `customFieldFilterDef`), and the grouping the field menu renders them under
// (design/work-items/filter-builder.mock.html panel 2: "Fields" · "Custom
// fields" · "Other"). Pure + client-safe (no React, no Prisma) so both the
// builder and its tests compose one source of truth — the registry-driven
// rule (a new custom field appears as a row with zero UI changes).

import { customFieldIdOfFilterField, type FilterAst, type FilterFieldId } from '@/lib/filters/ast';
import {
  customFieldFilterDef,
  FILTER_FIELDS,
  type CustomFieldFilterType,
  type FilterFieldDef,
} from '@/lib/filters/registry';

/** The minimal custom-field shape the builder needs to mint a `cf:<id>` def —
 * the definition's id + its type (the per-type operator set follows). The
 * page passes the full `CustomFieldDefinitionDTO`, which is a superset. */
export interface AdvancedFilterCustomField {
  id: string;
  fieldType: CustomFieldFilterType;
}

/** The field-menu group a def renders under (panel 2's `mgroup` headers). */
export type AdvancedFieldGroup = 'fields' | 'customFields' | 'other';

/**
 * The full field-def list the builder's field menu offers, in menu order:
 * the built-in registry fields first (kind … estimate, then the Epic-5
 * join-backed `lbl`/`cmp`), then one dynamic `cf:<id>` def per custom-field
 * definition — appended in the project's definition order. The dynamic defs
 * carry the `customField` marker the compiler + the stale-referent resolution
 * key off.
 */
export function buildAdvancedFilterFieldDefs(
  customFields: ReadonlyArray<AdvancedFilterCustomField>,
): FilterFieldDef[] {
  return [...FILTER_FIELDS, ...customFields.map((cf) => customFieldFilterDef(cf.id, cf.fieldType))];
}

/** Classify a field def into its menu group — custom fields under "Custom
 * fields", the join-backed label/component fields under "Other", everything
 * else (the core columns) under "Fields". */
export function advancedFieldGroup(def: FilterFieldDef): AdvancedFieldGroup {
  if (def.customField) return 'customFields';
  if (def.id === 'lbl' || def.id === 'cmp') return 'other';
  return 'fields';
}

// ---------------------------------------------------------------------------
// Stale-referent detection for the builder UI (Subtask 6.1.5)
// ---------------------------------------------------------------------------

/** The project's currently-known Epic-5 referents — the same shape the
 * server's `loadFilterReferents` resolves, built CLIENT-side from the loaded
 * custom-field definitions / components / referenced labels. `optionIds` is
 * the select field's managed option ids (archived included — historical
 * matching); it stays empty for non-select types (they have no stale-checked
 * value space, matching the server's `staleCheckedIdSet`). */
export interface AdvancedFilterReferents {
  customFields: ReadonlyMap<
    string,
    { fieldType: CustomFieldFilterType; optionIds: ReadonlySet<string> }
  >;
  labelIds: ReadonlySet<string>;
  componentIds: ReadonlySet<string>;
}

/** What the builder renders as stale: the value ids that no longer resolve
 * (the "unknown value" chip + per-row notice) and the whole `cf:<id>` fields
 * whose definition is gone (the "unknown field" row). */
export interface AdvancedFilterStale {
  staleValueIds: Set<string>;
  staleFields: Set<FilterFieldId>;
}

/**
 * Determine which of an applied AST's Epic-5 referents are STALE against the
 * project's currently-known referents — the client mirror of the server's
 * `resolveFilterAst` stale rule (Subtask 6.1.5), so the builder marks exactly
 * what the compiler turns into match-nothing. Pure + never throws (it's UI
 * presentation, not validation): a `cf:<id>` with no definition is a stale
 * FIELD; a select-CF option / label / component id absent from its known set
 * is a stale VALUE; open id spaces (user-CF, members, sprints) are never
 * flagged — a deleted one simply matches nothing (the 2.5.4 open-id rule).
 */
export function computeAdvancedFilterStale(
  ast: FilterAst,
  referents: AdvancedFilterReferents,
): AdvancedFilterStale {
  const staleValueIds = new Set<string>();
  const staleFields = new Set<FilterFieldId>();
  for (const { field, value } of ast.conditions) {
    const values = Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : [];
    const cfId = customFieldIdOfFilterField(field);
    if (cfId !== null) {
      const def = referents.customFields.get(cfId);
      if (!def) {
        staleFields.add(field);
        continue;
      }
      if (def.fieldType === 'select') {
        for (const v of values) if (!def.optionIds.has(v)) staleValueIds.add(v);
      }
    } else if (field === 'lbl') {
      for (const v of values) if (!referents.labelIds.has(v)) staleValueIds.add(v);
    } else if (field === 'cmp') {
      for (const v of values) if (!referents.componentIds.has(v)) staleValueIds.add(v);
    }
  }
  return { staleValueIds, staleFields };
}
