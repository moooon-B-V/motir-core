import { describe, expect, it } from 'vitest';
import {
  advancedFieldGroup,
  buildAdvancedFilterFieldDefs,
  computeAdvancedFilterStale,
  type AdvancedFilterReferents,
} from '@/lib/issues/advancedFilterFields';
import {
  advancedBuilderFields,
  astFromRows,
  isRowComplete,
} from '@/lib/issues/issueListAdvancedFilter';
import { customFieldFilterDef, FILTER_FIELDS, type FilterFieldDef } from '@/lib/filters/registry';
import type { FilterAst } from '@/lib/filters/ast';

// The Epic-5 builder field set + stale-referent detection (Subtask 6.1.5) —
// pure helpers, unit-tested in isolation (the heavier compile/E2E lives in the
// 6.1.x integration suites).

describe('buildAdvancedFilterFieldDefs', () => {
  it('appends one dynamic cf:<id> def per custom field, after the built-ins', () => {
    const defs = buildAdvancedFilterFieldDefs([
      { id: 'f-sel', fieldType: 'select' },
      { id: 'f-num', fieldType: 'number' },
    ]);
    expect(defs.slice(0, FILTER_FIELDS.length)).toEqual(FILTER_FIELDS);
    expect(defs.slice(FILTER_FIELDS.length).map((d) => d.id)).toEqual(['cf:f-sel', 'cf:f-num']);
    // …and every one is offered by the registry-driven menu (editors shipped)
    expect(advancedBuilderFields(defs).map((d) => d.id)).toContain('cf:f-sel');
    expect(advancedBuilderFields(defs).map((d) => d.id)).toContain('cf:f-num');
  });
});

describe('advancedFieldGroup', () => {
  it('classifies built-ins / custom fields / the join fields', () => {
    expect(advancedFieldGroup(FILTER_FIELDS.find((f) => f.id === 'status')!)).toBe('fields');
    expect(advancedFieldGroup(FILTER_FIELDS.find((f) => f.id === 'lbl')!)).toBe('other');
    expect(advancedFieldGroup(FILTER_FIELDS.find((f) => f.id === 'cmp')!)).toBe('other');
    expect(advancedFieldGroup(customFieldFilterDef('x', 'select'))).toBe('customFields');
  });
});

describe('computeAdvancedFilterStale (the client mirror of the server stale rule)', () => {
  const referents: AdvancedFilterReferents = {
    customFields: new Map([['cf-sev', { fieldType: 'select', optionIds: new Set(['opt-high']) }]]),
    labelIds: new Set(['lbl-keep']),
    componentIds: new Set(['cmp-keep']),
  };

  it('flags deleted select-option / label / component VALUES, leaves the live ones', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [
        { field: 'cf:cf-sev', operator: 'is_any_of', value: ['opt-high', 'opt-gone'] },
        { field: 'lbl', operator: 'is_any_of', value: ['lbl-keep', 'lbl-gone'] },
        { field: 'cmp', operator: 'is_none_of', value: ['cmp-gone'] },
      ],
    };
    const { staleValueIds, staleFields } = computeAdvancedFilterStale(ast, referents);
    expect([...staleValueIds].sort()).toEqual(['cmp-gone', 'lbl-gone', 'opt-gone']);
    expect([...staleFields]).toEqual([]);
  });

  it('flags a deleted custom FIELD (no definition) and never its values', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'cf:cf-gone', operator: 'is_any_of', value: ['whatever'] }],
    };
    const { staleValueIds, staleFields } = computeAdvancedFilterStale(ast, referents);
    expect([...staleFields]).toEqual(['cf:cf-gone']);
    expect([...staleValueIds]).toEqual([]);
  });

  it('never flags open id spaces (user-CF / members) — a deleted one just matches nothing', () => {
    const withUser: AdvancedFilterReferents = {
      ...referents,
      customFields: new Map([['cf-qa', { fieldType: 'user', optionIds: new Set() }]]),
    };
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'cf:cf-qa', operator: 'is_any_of', value: ['u-deleted'] }],
    };
    expect(computeAdvancedFilterStale(ast, withUser).staleValueIds.size).toBe(0);
  });
});

describe('the def-aware row gate (dynamic cf rows + stale-field round-trip)', () => {
  const selDef = customFieldFilterDef('cf-sev', 'select');

  it('isRowComplete validates a dynamic cf row against its resolved def', () => {
    expect(
      isRowComplete({ key: 1, field: 'cf:cf-sev', operator: 'is_any_of', value: ['o'] }, selDef),
    ).toBe(true);
    // pending (no value) and a stale FIELD (def === null) are both incomplete
    expect(
      isRowComplete({ key: 2, field: 'cf:cf-sev', operator: 'is_any_of', value: null }, selDef),
    ).toBe(false);
    expect(
      isRowComplete({ key: 3, field: 'cf:cf-gone', operator: 'is_any_of', value: ['o'] }, null),
    ).toBe(false);
  });

  it('astFromRows keeps a stale-field cf row (match-nothing) but drops a pending one', () => {
    const resolveDef = (field: string): FilterFieldDef | null =>
      field === 'cf:cf-sev' ? selDef : null;
    const ast = astFromRows(
      'and',
      [
        { key: 1, field: 'cf:cf-sev', operator: 'is_any_of', value: ['opt-high'] },
        { key: 2, field: 'cf:cf-gone', operator: 'is_any_of', value: ['opt-x'] }, // stale field — kept
        { key: 3, field: 'cf:cf-sev', operator: 'is_any_of', value: null }, // pending — dropped
      ],
      resolveDef,
    );
    expect(ast.conditions).toEqual([
      { field: 'cf:cf-sev', operator: 'is_any_of', value: ['opt-high'] },
      { field: 'cf:cf-gone', operator: 'is_any_of', value: ['opt-x'] },
    ]);
  });
});
