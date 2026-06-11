import { describe, expect, it } from 'vitest';
import {
  customFieldFilterFieldId,
  customFieldIdOfFilterField,
  type FilterAst,
  type FilterCondition,
  type FilterFieldId,
  type FilterOperatorId,
} from '@/lib/filters/ast';
import {
  astHasEpic5Conditions,
  collectFilterReferentIds,
  customFieldFilterDef,
  filterValueEditorKind,
  resolveFilterAst,
  validateFilterAst,
  type CustomFieldFilterType,
  type ProjectFilterReferents,
} from '@/lib/filters/registry';
import {
  InvalidFilterValueError,
  UnknownFilterFieldError,
  UnknownFilterOperatorError,
} from '@/lib/filters/errors';
import { compileFilterConditionsSql } from '@/lib/repositories/workItemRepository';

// The Epic-5 extension of the registry/compiler (Subtask 6.1.2): the dynamic
// `cf:<fieldId>` entries' totality across validate × compile × editor, the
// static label/component entries' join compilation, the stale-referent
// resolution (deleted field/option/label/component → match-nothing, never an
// error), and the injection fuzz extended over the DYNAMIC ids. Behavioral
// matching against real Postgres lives in
// tests/integration/work-items/epic5-filter-predicates.test.ts.

const CF_TYPES: CustomFieldFilterType[] = ['text', 'number', 'date', 'select', 'user'];

const FIELD_ID = 'cf-def-1';
const CF = customFieldFilterFieldId(FIELD_ID);

/** Referents under which every sample condition below resolves NON-stale. */
function referentsFor(fieldType: CustomFieldFilterType): ProjectFilterReferents {
  return {
    customFields: new Map([[FIELD_ID, { fieldType, optionIds: new Set(['opt-1', 'opt-2']) }]]),
    labelIds: new Set(['label-1', 'label-2']),
    componentIds: new Set(['component-1']),
  };
}

function sampleValue(
  fieldType: CustomFieldFilterType,
  operator: FilterOperatorId,
): FilterCondition['value'] {
  switch (operator) {
    case 'is_any_of':
    case 'is_none_of':
      return fieldType === 'select' ? ['opt-1', 'opt-2'] : ['user-1'];
    case 'is_empty':
    case 'is_not_empty':
      return null;
    case 'contains':
    case 'not_contains':
      return 'oauth';
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return 3;
    case 'on_or_before':
    case 'on_or_after':
      return '2026-06-11';
    case 'between':
      return ['2026-06-01', '2026-06-30'];
    case 'in_last_days':
    case 'in_next_days':
      return 7;
  }
}

describe('the dynamic cf:<fieldId> entries are TOTAL per type (the 6.1.1 totality guard, extended)', () => {
  const triples = CF_TYPES.flatMap((fieldType) =>
    customFieldFilterDef(FIELD_ID, fieldType).operators.map(
      (operator) => [fieldType, operator] as const,
    ),
  );

  it.each(triples)('%s · %s — validate × compile × editor all hold', (fieldType, operator) => {
    const referents = referentsFor(fieldType);
    const condition: FilterCondition = {
      field: CF,
      operator,
      value: sampleValue(fieldType, operator),
    };
    // validate/resolve: the sample value passes and the condition is NOT stale.
    const resolved = resolveFilterAst({ combinator: 'and', conditions: [condition] }, referents);
    expect(resolved.conditions[0]!.stale).toBeNull();
    // editor: every pair names a value-editor kind (the 6.1.3/6.1.5 contract).
    expect(filterValueEditorKind(customFieldFilterDef(FIELD_ID, fieldType), operator)).toBeTruthy();
    // compile: the pair emits a parameterized probe over custom_field_value.
    const fragment = compileFilterConditionsSql(
      { combinator: 'and', conditions: [condition] },
      referents,
    );
    expect(fragment.text).toContain('"custom_field_value"');
    expect(fragment.text).not.toContain('(FALSE)');
    // The field id binds as a parameter, never interpolated.
    expect(fragment.text).not.toContain(FIELD_ID);
    expect(fragment.values).toContain(FIELD_ID);
  });

  it('every cf type offers the empty pair (typed-EAV: no row == empty) and its type set', () => {
    expect(customFieldFilterDef(FIELD_ID, 'select').operators).toEqual([
      'is_any_of',
      'is_none_of',
      'is_empty',
      'is_not_empty',
    ]);
    expect(customFieldFilterDef(FIELD_ID, 'user').operators).toEqual([
      'is_any_of',
      'is_none_of',
      'is_empty',
      'is_not_empty',
    ]);
    expect(customFieldFilterDef(FIELD_ID, 'number').operators).toEqual([
      'eq',
      'ne',
      'lt',
      'lte',
      'gt',
      'gte',
      'is_empty',
      'is_not_empty',
    ]);
    expect(customFieldFilterDef(FIELD_ID, 'date').operators).toEqual([
      'on_or_before',
      'on_or_after',
      'between',
      'in_last_days',
      'in_next_days',
      'is_empty',
      'is_not_empty',
    ]);
    expect(customFieldFilterDef(FIELD_ID, 'text').operators).toEqual([
      'contains',
      'not_contains',
      'is_empty',
      'is_not_empty',
    ]);
  });

  it('the per-type editors reuse the owners’ vocabulary', () => {
    expect(customFieldFilterDef(FIELD_ID, 'select').listEditor).toBe('cf-option-select');
    expect(customFieldFilterDef(FIELD_ID, 'user').listEditor).toBe('member-select');
  });

  it('forged operators / bad arities on a RESOLVED field stay typed 422s', () => {
    const referents = referentsFor('number');
    expect(() =>
      resolveFilterAst(
        { combinator: 'and', conditions: [{ field: CF, operator: 'contains', value: 'x' }] },
        referents,
      ),
    ).toThrow(UnknownFilterOperatorError);
    expect(() =>
      resolveFilterAst(
        { combinator: 'and', conditions: [{ field: CF, operator: 'gt', value: 'three' }] },
        referents,
      ),
    ).toThrow(InvalidFilterValueError);
  });
});

describe('the static label/component entries compile the 5.4.1 join probes', () => {
  const referents = referentsFor('select');

  it.each([
    ['lbl', '"work_item_label"', '"label_id"', ['label-1', 'label-2']],
    ['cmp', '"work_item_component"', '"component_id"', ['component-1']],
  ] as Array<[FilterFieldId, string, string, string[]]>)(
    '%s — EXISTS membership, NOT-EXISTS negation, empty pair',
    (field, table, idColumn, ids) => {
      const anyOf = compileFilterConditionsSql(
        { combinator: 'and', conditions: [{ field, operator: 'is_any_of', value: ids }] },
        referents,
      );
      expect(anyOf.text).toContain(`EXISTS (SELECT 1 FROM ${table}`);
      expect(anyOf.text).toContain(`j.${idColumn} = ANY($`);
      expect(anyOf.values).toEqual([ids]);

      const noneOf = compileFilterConditionsSql(
        { combinator: 'and', conditions: [{ field, operator: 'is_none_of', value: ids }] },
        referents,
      );
      expect(noneOf.text).toContain('NOT EXISTS');

      const empty = compileFilterConditionsSql(
        { combinator: 'and', conditions: [{ field, operator: 'is_empty', value: null }] },
        referents,
      );
      expect(empty.text).toContain(`NOT EXISTS (SELECT 1 FROM ${table}`);
      expect(empty.values).toEqual([]);

      const notEmpty = compileFilterConditionsSql(
        { combinator: 'and', conditions: [{ field, operator: 'is_not_empty', value: null }] },
        referents,
      );
      expect(notEmpty.text).toContain(`EXISTS (SELECT 1 FROM ${table}`);
    },
  );
});

describe('stale referents resolve to match-nothing, never an error (the 6.2 durability rule)', () => {
  const referents = referentsFor('select');

  it('a cf:<id> whose definition is gone → stale unknown-field, compiled FALSE', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [
        { field: customFieldFilterFieldId('deleted-def'), operator: 'is_empty', value: null },
      ],
    };
    const resolved = resolveFilterAst(ast, referents);
    expect(resolved.conditions[0]!.stale).toBe('unknown-field');
    expect(resolved.conditions[0]!.def).toBeNull();
    expect(compileFilterConditionsSql(ast, referents).text).toContain('(FALSE)');
  });

  it.each([
    ['a deleted option id', CF, ['opt-1', 'deleted-opt']],
    ['a deleted label id', 'lbl', ['deleted-label']],
    ['a deleted component id', 'cmp', ['deleted-component']],
  ] as Array<[string, FilterFieldId, string[]]>)(
    '%s → stale unknown-value, compiled FALSE',
    (_name, field, value) => {
      const ast: FilterAst = {
        combinator: 'and',
        conditions: [{ field, operator: 'is_any_of', value }],
      };
      const resolved = resolveFilterAst(ast, referents);
      expect(resolved.conditions[0]!.stale).toBe('unknown-value');
      expect(resolved.conditions[0]!.def).not.toBeNull();
      expect(compileFilterConditionsSql(ast, referents).text).toContain('(FALSE)');
    },
  );

  it('user-cf member ids are an OPEN id space — never stale (deleted users SetNull and match nothing)', () => {
    const resolved = resolveFilterAst(
      {
        combinator: 'and',
        conditions: [{ field: CF, operator: 'is_any_of', value: ['who-knows'] }],
      },
      referentsFor('user'),
    );
    expect(resolved.conditions[0]!.stale).toBeNull();
  });

  it('with NO referents (the compiler default), every Epic-5 condition is stale — built-ins unaffected', () => {
    const ast: FilterAst = {
      combinator: 'or',
      conditions: [
        { field: 'status', operator: 'is_any_of', value: ['todo'] },
        { field: 'lbl', operator: 'is_any_of', value: ['label-1'] },
      ],
    };
    const fragment = compileFilterConditionsSql(ast);
    expect(fragment.text).toContain('w."status"');
    expect(fragment.text).toContain('(FALSE)');
    // validateFilterAst accepts the same AST without throwing (stale ≠ error)…
    expect(() => validateFilterAst(ast)).not.toThrow();
    // …while a non-prefixed unknown field is still forgery (typed 422).
    expect(() =>
      validateFilterAst({
        combinator: 'and',
        conditions: [{ field: 'watchers' as FilterFieldId, operator: 'is_empty', value: null }],
      }),
    ).toThrow(UnknownFilterFieldError);
  });
});

describe('the injection fuzz, extended over the dynamic ids (the 6.1.2 AC)', () => {
  const PAYLOADS = [
    `'); DROP TABLE "custom_field_value"; --`,
    `" OR 1=1 --`,
    `$1; SELECT pg_sleep(10)`,
  ];

  it('hostile cf field ids resolve stale — none of their text reaches SQL', () => {
    for (const payload of PAYLOADS) {
      const fragment = compileFilterConditionsSql(
        {
          combinator: 'and',
          conditions: [
            {
              field: customFieldFilterFieldId(payload),
              operator: 'is_any_of',
              value: ['opt-1'],
            },
          ],
        },
        referentsFor('select'),
      );
      expect(fragment.text).toBe('(FALSE)');
      expect(fragment.values).toEqual([]);
    }
  });

  it('hostile ids that DO exist as referents bind as parameters, never as SQL text', () => {
    for (const payload of PAYLOADS) {
      const referents: ProjectFilterReferents = {
        customFields: new Map([[payload, { fieldType: 'select', optionIds: new Set([payload]) }]]),
        labelIds: new Set([payload]),
        componentIds: new Set(),
      };
      const fragment = compileFilterConditionsSql(
        {
          combinator: 'or',
          conditions: [
            { field: customFieldFilterFieldId(payload), operator: 'is_any_of', value: [payload] },
            { field: 'lbl', operator: 'is_any_of', value: [payload] },
          ],
        },
        referents,
      );
      expect(fragment.text).not.toContain(payload);
      expect(fragment.text).not.toContain('DROP');
      expect(fragment.values).toContainEqual([payload]);
      expect(fragment.values).toContain(payload);
    }
  });

  it('hostile cf text-search values bind as escaped LIKE patterns', () => {
    const payload = `%' OR '%'='`;
    const fragment = compileFilterConditionsSql(
      {
        combinator: 'and',
        conditions: [{ field: CF, operator: 'contains', value: payload }],
      },
      referentsFor('text'),
    );
    expect(fragment.text).not.toContain(payload);
    const patterns = fragment.values.filter((v): v is string => typeof v === 'string');
    expect(patterns.some((p) => p.includes(payload.replace(/[\\%_]/g, (ch) => `\\${ch}`)))).toBe(
      true,
    );
  });
});

describe('the referent-collection helpers (the service’s bounded-read plan)', () => {
  it('astHasEpic5Conditions spots labels, components, and cf rows — not built-ins', () => {
    expect(
      astHasEpic5Conditions({
        combinator: 'and',
        conditions: [{ field: 'status', operator: 'is_any_of', value: ['todo'] }],
      }),
    ).toBe(false);
    for (const field of ['lbl', 'cmp', CF] as FilterFieldId[]) {
      expect(
        astHasEpic5Conditions({
          combinator: 'and',
          conditions: [{ field, operator: 'is_empty', value: null }],
        }),
      ).toBe(true);
    }
  });

  it('collectFilterReferentIds dedupes ids per bucket and skips non-list values', () => {
    const ids = collectFilterReferentIds({
      combinator: 'or',
      conditions: [
        { field: CF, operator: 'is_any_of', value: ['opt-1', 'opt-1', 'opt-2'] },
        { field: customFieldFilterFieldId('cf-def-2'), operator: 'gt', value: 3 },
        { field: 'lbl', operator: 'is_any_of', value: ['label-1'] },
        { field: 'lbl', operator: 'is_none_of', value: ['label-1', 'label-2'] },
        { field: 'cmp', operator: 'is_empty', value: null },
        { field: 'status', operator: 'is_any_of', value: ['todo'] },
      ],
    });
    expect(ids.customFieldIds.sort()).toEqual([FIELD_ID, 'cf-def-2']);
    expect(ids.customFieldValueIds.sort()).toEqual(['opt-1', 'opt-2']);
    expect(ids.labelIds.sort()).toEqual(['label-1', 'label-2']);
    expect(ids.componentIds).toEqual([]);
  });

  it('the cf:<fieldId> key helpers round-trip', () => {
    expect(customFieldFilterFieldId('abc')).toBe('cf:abc');
    expect(customFieldIdOfFilterField('cf:abc')).toBe('abc');
    expect(customFieldIdOfFilterField('lbl')).toBeNull();
    expect(customFieldIdOfFilterField('status')).toBeNull();
  });
});
