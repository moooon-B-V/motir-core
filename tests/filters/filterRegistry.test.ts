import { describe, expect, it } from 'vitest';
import {
  FILTER_ROW_CAP,
  customFieldFilterFieldId,
  type FilterAst,
  type FilterCondition,
  type FilterFieldId,
  type FilterOperatorId,
} from '@/lib/filters/ast';
import {
  FILTER_FIELDS,
  filterFieldDef,
  filterValueEditorKind,
  validateFilterAst,
  validateFilterCondition,
  type ProjectFilterReferents,
} from '@/lib/filters/registry';
import {
  FilterTooLargeError,
  InvalidFilterValueError,
  MalformedFilterError,
  UnknownFilterFieldError,
  UnknownFilterOperatorError,
} from '@/lib/filters/errors';
import { compileFilterConditionsSql } from '@/lib/repositories/workItemRepository';

// The operator registry's TOTALITY (mistake #29) — the enumeration test the
// 6.1.1 card pins: every registered (field × operator) has a working
// validate × compile × editor triple, and every unknown/malformed input is a
// TYPED rejection, never a silent pass-through toward SQL. The compile side
// is asserted statically here (bound-parameter inspection of the emitted
// fragment); the behavioral matrix against real Postgres lives in
// tests/integration/work-items/filter-compiler.test.ts.

function sampleValue(field: FilterFieldId, operator: FilterOperatorId): FilterCondition['value'] {
  switch (operator) {
    case 'is_any_of':
    case 'is_none_of': {
      const def = filterFieldDef(field);
      if (def.valueWhitelist) return [...def.valueWhitelist.slice(0, 2)];
      if (def.emptySentinel) return ['some-id', def.emptySentinel];
      return ['some-id'];
    }
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

describe('the registry is TOTAL over every (field × operator)', () => {
  const triples = FILTER_FIELDS.flatMap((def) =>
    def.operators.map((operator) => [def.id, operator] as const),
  );

  it.each(triples)('%s · %s — validate × compile × editor all hold', (field, operator) => {
    const condition: FilterCondition = { field, operator, value: sampleValue(field, operator) };
    // validate: the sample value passes its (field, operator) arity.
    expect(() => validateFilterCondition(condition)).not.toThrow();
    // editor: every pair names a value-editor kind (the 6.1.3/6.1.4 contract).
    expect(filterValueEditorKind(filterFieldDef(field), operator)).toBeTruthy();
    // compile: the pair emits a parameterized fragment.
    const fragment = compileFilterConditionsSql({ combinator: 'and', conditions: [condition] });
    expect(fragment.text.length).toBeGreaterThan(0);
  });

  it('every field declares the empty pair iff its column is nullable', () => {
    for (const def of FILTER_FIELDS) {
      expect(def.operators.includes('is_empty')).toBe(def.nullable);
      expect(def.operators.includes('is_not_empty')).toBe(def.nullable);
    }
  });
});

describe('unknown / malformed input → typed 422s (never pass-through)', () => {
  const condition = (over: Partial<FilterCondition>): FilterCondition =>
    ({ field: 'status', operator: 'is_any_of', value: ['todo'], ...over }) as FilterCondition;

  it('unknown field id — including injection-shaped ids', () => {
    for (const field of ['watchers', 'w"."id" = "id" OR 1=1 --', 'customFields.x']) {
      expect(() => validateFilterCondition(condition({ field: field as FilterFieldId }))).toThrow(
        UnknownFilterFieldError,
      );
    }
  });

  it('operator outside the field set — including injection-shaped ids', () => {
    // `kind` is NOT NULL → no empty pair in its set.
    expect(() =>
      validateFilterCondition({ field: 'kind', operator: 'is_empty', value: null }),
    ).toThrow(UnknownFilterOperatorError);
    expect(() =>
      validateFilterCondition({ field: 'text', operator: 'eq' as FilterOperatorId, value: 1 }),
    ).toThrow(UnknownFilterOperatorError);
    expect(() =>
      validateFilterCondition(
        condition({ operator: '= ANY(SELECT id FROM "user") --' as FilterOperatorId }),
      ),
    ).toThrow(UnknownFilterOperatorError);
  });

  it.each([
    ['empty value list', condition({ value: [] })],
    ['non-list for a list op', condition({ value: 'todo' })],
    ['whitelist miss (kind)', { field: 'kind', operator: 'is_any_of', value: ['banana'] }],
    ['whitelist miss (priority)', { field: 'priority', operator: 'is_any_of', value: ['urgent'] }],
    ['value on a zero-arity op', { field: 'assignee', operator: 'is_empty', value: ['x'] }],
    ['blank text', { field: 'text', operator: 'contains', value: '   ' }],
    ['non-number comparison', { field: 'estimate', operator: 'gt', value: '3' }],
    ['out-of-range number', { field: 'estimate', operator: 'gt', value: 1e12 }],
    ['malformed date', { field: 'due', operator: 'on_or_before', value: '11/06/2026' }],
    ['impossible date', { field: 'due', operator: 'on_or_before', value: '2026-02-31' }],
    [
      'inverted between',
      { field: 'due', operator: 'between', value: ['2026-06-30', '2026-06-01'] },
    ],
    ['fractional day window', { field: 'created', operator: 'in_last_days', value: 1.5 }],
    ['oversize day window', { field: 'created', operator: 'in_last_days', value: 9999 }],
  ] as Array<[string, FilterCondition]>)('invalid value: %s', (_name, bad) => {
    expect(() => validateFilterCondition(bad)).toThrow(InvalidFilterValueError);
  });

  it('the row cap and a malformed combinator are typed', () => {
    const rows = Array.from({ length: FILTER_ROW_CAP + 1 }, () => condition({}));
    expect(() => validateFilterAst({ combinator: 'and', conditions: rows })).toThrow(
      FilterTooLargeError,
    );
    expect(() =>
      validateFilterAst({ combinator: 'xor', conditions: [] } as unknown as FilterAst),
    ).toThrow(MalformedFilterError);
  });

  it('the compiler re-validates (defence in depth) — no unvalidated AST reaches SQL', () => {
    expect(() =>
      compileFilterConditionsSql({
        combinator: 'and',
        conditions: [condition({ field: 'watchers' as FilterFieldId })],
      }),
    ).toThrow(UnknownFilterFieldError);
  });
});

describe('compiled fragments are parameterized-only (the injection AC)', () => {
  const PAYLOADS = [
    `'); DROP TABLE "work_item"; --`,
    `" OR 1=1 --`,
    `\\'); DELETE FROM "user"; --`,
    `$1; SELECT pg_sleep(10)`,
    `%' OR '%'='`,
  ];

  it('hostile list values never reach the SQL text', () => {
    for (const payload of PAYLOADS) {
      const fragment = compileFilterConditionsSql({
        combinator: 'or',
        conditions: [
          { field: 'status', operator: 'is_any_of', value: [payload] },
          { field: 'assignee', operator: 'is_none_of', value: [payload] },
        ],
      });
      expect(fragment.text).not.toContain(payload);
      expect(fragment.text).not.toContain('DROP');
      expect(JSON.stringify(fragment.values)).toContain(JSON.stringify(payload).slice(1, -1));
    }
  });

  it('hostile text-search values bind as escaped LIKE patterns, never as SQL', () => {
    for (const payload of PAYLOADS) {
      const fragment = compileFilterConditionsSql({
        combinator: 'and',
        conditions: [{ field: 'text', operator: 'contains', value: payload }],
      });
      expect(fragment.text).not.toContain(payload);
      expect(fragment.text).not.toContain('DROP');
      // The pattern parameter carries the payload (LIKE-escaped) as a VALUE.
      const patterns = fragment.values.filter((v): v is string => typeof v === 'string');
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns[0]).toContain(payload.replace(/[\\%_]/g, (ch) => `\\${ch}`));
    }
  });

  it('field/operator ids resolve to fixed column literals — never interpolated', () => {
    const fragment = compileFilterConditionsSql({
      combinator: 'and',
      conditions: [
        { field: 'storyPoints', operator: 'gte', value: 3 },
        { field: 'due', operator: 'in_next_days', value: 7 },
      ],
    });
    // Only whitelisted column references appear; the values ride placeholders.
    expect(fragment.text).toContain('w."storyPoints" >= $');
    expect(fragment.text).toContain('w."dueDate"::date');
    expect(fragment.values).toEqual([3, 7]);
  });

  // MOTIR-2056 — the standing guard. `CURRENT_DATE` is evaluated in the
  // Postgres SESSION timezone, so measuring a relative window from it while
  // comparing against a naive-UTC column made the window off by one day on
  // every non-UTC session. The compiled text must never contain it again: the
  // boundary is `(now() AT TIME ZONE 'UTC')::date`. This is the enumerated
  // form of the card's grep criterion — it covers every registered date
  // field, built-in and custom, so a new date operator cannot reintroduce the
  // skew without turning this red.
  it('no date operator measures from a session-local CURRENT_DATE', () => {
    const DATE_OPERATORS: FilterOperatorId[] = [
      'on_or_before',
      'on_or_after',
      'between',
      'in_last_days',
      'in_next_days',
    ];
    const CF_DATE_ID = 'cf-date-field-id';
    const referents: ProjectFilterReferents = {
      customFields: new Map([
        [CF_DATE_ID, { fieldType: 'date' as const, optionIds: new Set<string>() }],
      ]),
      labelIds: new Set<string>(),
      componentIds: new Set<string>(),
    };

    const compile = (field: FilterFieldId, operator: FilterOperatorId): string =>
      compileFilterConditionsSql(
        {
          combinator: 'and',
          conditions: [{ field, operator, value: sampleValue(field, operator) } as FilterCondition],
        },
        referents,
      ).text;

    // Every registered date field × its date operators — built-ins from the
    // registry, plus the custom-field date arm, which is a separate compiler
    // (`customFieldConditionSql`) that carried the identical defect.
    const compiled = [
      ...FILTER_FIELDS.flatMap((def) =>
        def.operators
          .filter((operator) => DATE_OPERATORS.includes(operator))
          .map((operator) => ({ label: `${def.id} ${operator}`, text: compile(def.id, operator) })),
      ),
      ...DATE_OPERATORS.map((operator) => ({
        label: `cf:date ${operator}`,
        text: compile(customFieldFilterFieldId(CF_DATE_ID), operator),
      })),
    ];

    // Guard the guard: a vacuous enumeration (a renamed operator, a field that
    // stopped resolving) would let the assertion below pass while checking
    // nothing, so require that the UTC anchor is actually present somewhere.
    expect(compiled.length).toBeGreaterThan(0);
    expect(
      compiled.filter(({ text }) => text.includes("(now() AT TIME ZONE 'UTC')::date")).length,
    ).toBeGreaterThan(0);

    for (const { label, text } of compiled) {
      expect(text, `${label} must not read CURRENT_DATE`).not.toContain('CURRENT_DATE');
    }
  });
});
