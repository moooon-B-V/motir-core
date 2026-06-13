import { describe, expect, it } from 'vitest';
import {
  FILTER_ROW_CAP,
  FILTER_UNASSIGNED_TOKEN,
  decodeFilterParam,
  encodeFilterParam,
  facetFilterToAst,
  type FilterAst,
  type FilterCondition,
  type FilterFieldId,
  type FilterOperatorId,
} from '@/lib/filters/ast';
import { FILTER_FIELDS } from '@/lib/filters/registry';
import { EMPTY_FILTER, parseIssueFilter } from '@/lib/issues/issueListFilter';

// The FilterAST URL codec (Subtask 6.1.1): the round-trip property over every
// constructible operator shape, the typed RECOVERABLE decode failures
// (malformed / foreign params yield a state object, never a throw into the
// page), and the lossless 2.5.4 facet→AST upgrade.

/** A valid sample value for every (field, operator) the registry offers. */
function sampleValue(field: FilterFieldId, operator: FilterOperatorId): FilterCondition['value'] {
  switch (operator) {
    case 'is_any_of':
    case 'is_none_of':
      if (field === 'kind') return ['bug', 'task'];
      if (field === 'priority') return ['high', 'highest'];
      if (field === 'type') return ['code', 'design'];
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
function everyConditionShape(): FilterCondition[] {
  return FILTER_FIELDS.flatMap((def) =>
    def.operators.map((operator) => ({
      field: def.id,
      operator,
      value: sampleValue(def.id, operator),
    })),
  );
}

describe('encodeFilterParam / decodeFilterParam — the round-trip property', () => {
  it('round-trips an AST containing every registered (field, operator) shape', () => {
    const all = everyConditionShape();
    // The cap is 20 — round-trip in chunks so every shape is covered.
    for (let start = 0; start < all.length; start += FILTER_ROW_CAP) {
      const ast: FilterAst = {
        combinator: start === 0 ? 'and' : 'or',
        conditions: all.slice(start, start + FILTER_ROW_CAP),
      };
      const decoded = decodeFilterParam(encodeFilterParam(ast));
      expect(decoded).toEqual({ ok: true, ast });
    }
  });

  it('round-trips the empty AST and non-ASCII / URL-hostile values', () => {
    expect(decodeFilterParam(encodeFilterParam({ combinator: 'and', conditions: [] }))).toEqual({
      ok: true,
      ast: { combinator: 'and', conditions: [] },
    });
    const hostile: FilterAst = {
      combinator: 'or',
      conditions: [
        { field: 'text', operator: 'contains', value: '50%_面板 &?=#+ "quoted" \\back' },
        { field: 'status', operator: 'is_any_of', value: ['todo', 'in_progress'] },
      ],
    };
    expect(decodeFilterParam(encodeFilterParam(hostile))).toEqual({ ok: true, ast: hostile });
  });

  it('the encoded param is URL-safe (no characters needing percent-encoding)', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'text', operator: 'contains', value: 'crash on save / 100%+ ä' }],
    };
    const param = encodeFilterParam(ast);
    expect(param).toMatch(/^v1:[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(param.slice(3))).toBe(param.slice(3));
  });
});

describe('decodeFilterParam — typed recoverable failures (never a throw)', () => {
  const cases: Array<[string, string, string]> = [
    ['no version prefix', 'garbage', 'malformed'],
    ['foreign version', `v2:${btoa('{}')}`, 'unsupported-version'],
    ['not base64url', 'v1:!!!not-base64!!!', 'malformed'],
    ['not JSON', 'v1:bm90LWpzb24', 'malformed'],
    ['not an object', `v1:${btoa('[1,2]')}`, 'invalid'],
    ['bad combinator', `v1:${btoa('{"c":"xor","f":[]}')}`, 'invalid'],
    ['rows not an array', `v1:${btoa('{"c":"and","f":{}}')}`, 'invalid'],
    ['bad row shape (2-tuple)', `v1:${btoa('{"c":"and","f":[["kind","is_any_of"]]}')}`, 'invalid'],
    ['non-string field id', `v1:${btoa('{"c":"and","f":[[7,"is_any_of",["bug"]]]}')}`, 'invalid'],
    [
      'non-wire value (object)',
      `v1:${btoa('{"c":"and","f":[["kind","is_any_of",{"a":1}]]}')}`,
      'invalid',
    ],
    [
      'non-finite number value',
      `v1:${btoa('{"c":"and","f":[["estimate","eq",1e999]]}')}`,
      'invalid',
    ],
  ];
  it.each(cases)('%s → { ok: false, reason: %s }', (_name, raw, reason) => {
    const decoded = decodeFilterParam(raw);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe(reason);
  });

  it('rejects an over-cap row set', () => {
    const rows = Array.from({ length: FILTER_ROW_CAP + 1 }, () => ['kind', 'is_any_of', ['bug']]);
    const decoded = decodeFilterParam(`v1:${btoa(JSON.stringify({ c: 'and', f: rows }))}`);
    expect(decoded).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('facetFilterToAst — the lossless 2.5.4 basic→advanced upgrade', () => {
  it('maps every facet combination to its AND rows (the degenerate all-AND case)', () => {
    const facets = parseIssueFilter({
      kind: ['bug', 'task'],
      status: ['todo', 'in_progress'],
      assignee: ['user-2', 'user-1', 'unassigned'],
      q: 'oauth',
    });
    expect(facetFilterToAst(facets)).toEqual({
      combinator: 'and',
      conditions: [
        { field: 'kind', operator: 'is_any_of', value: ['task', 'bug'] },
        { field: 'status', operator: 'is_any_of', value: ['in_progress', 'todo'] },
        {
          field: 'assignee',
          operator: 'is_any_of',
          value: ['user-1', 'user-2', FILTER_UNASSIGNED_TOKEN],
        },
        { field: 'text', operator: 'contains', value: 'oauth' },
      ],
    });
  });

  it('omits empty facets — the no-filter state upgrades to zero rows', () => {
    expect(facetFilterToAst(EMPTY_FILTER)).toEqual({ combinator: 'and', conditions: [] });
    expect(facetFilterToAst({ ...EMPTY_FILTER, includeUnassigned: true })).toEqual({
      combinator: 'and',
      conditions: [{ field: 'assignee', operator: 'is_any_of', value: [FILTER_UNASSIGNED_TOKEN] }],
    });
  });

  it('the upgraded AST survives the codec round-trip', () => {
    const facets = parseIssueFilter({ kind: 'story', assignee: 'unassigned', q: '50%_done' });
    const ast = facetFilterToAst(facets);
    expect(decodeFilterParam(encodeFilterParam(ast))).toEqual({ ok: true, ast });
  });
});
