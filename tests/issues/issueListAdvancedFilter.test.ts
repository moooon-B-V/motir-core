import { describe, expect, it } from 'vitest';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { FILTER_FIELDS, type FilterFieldDef } from '@/lib/filters/registry';
import { EMPTY_FILTER, type IssueFilter } from '@/lib/issues/issueListFilter';
import {
  advancedBuilderFields,
  astExceedsFacets,
  astFromRows,
  carryValueAcrossOperator,
  clearFacets,
  defaultOperator,
  isRowComplete,
  parseAdvancedFilterParam,
  rowsFromAst,
  setAdvancedParam,
  upgradeFacetsIntoAst,
  type AdvancedBuilderRow,
} from '@/lib/issues/issueListAdvancedFilter';

// The /items advanced-filter URL plumbing (Subtask 6.1.4) — pure parse /
// expressiveness / upgrade / row-model logic over the 6.1.1 substrate, unit-
// tested in isolation (no React, no DB). These lock the page-boundary
// contract: a broken param is RECOVERABLE (never a throw to the page), the
// superseded state fires exactly when the AST exceeds facet expressiveness,
// and pending rows never reach the URL.

const AST: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'status', operator: 'is_any_of', value: ['todo', 'in_progress'] }],
};

function fieldDef(id: string): FilterFieldDef {
  const def = FILTER_FIELDS.find((f) => f.id === id);
  if (!def) throw new Error(`no def: ${id}`);
  return def;
}

describe('parseAdvancedFilterParam', () => {
  it('parses an encoded AST back to active (round-trip)', () => {
    const encoded = encodeFilterParam(AST);
    const parsed = parseAdvancedFilterParam(encoded);
    expect(parsed).toEqual({ state: 'active', ast: AST, encoded });
  });

  it('absent / empty → none', () => {
    expect(parseAdvancedFilterParam(null)).toEqual({ state: 'none' });
    expect(parseAdvancedFilterParam('')).toEqual({ state: 'none' });
  });

  it('an empty condition list constrains nothing → none', () => {
    const encoded = encodeFilterParam({ combinator: 'and', conditions: [] });
    expect(parseAdvancedFilterParam(encoded)).toEqual({ state: 'none' });
  });

  it.each([
    ['garbage', 'not-a-filter'],
    ['missing version', btoa('{}')],
    ['foreign version', 'v9:abc'],
    ['non-base64 payload', 'v1:%%%%'],
    ['non-JSON payload', `v1:${Buffer.from('nope').toString('base64url')}`],
  ])('malformed param (%s) → the typed recoverable invalid state', (_name, raw) => {
    expect(parseAdvancedFilterParam(raw)).toEqual({ state: 'invalid' });
  });

  it('forged field / operator / value ids → invalid (the registry 422 surfaced as the page state)', () => {
    const forgedField = encodeFilterParam({
      combinator: 'and',
      conditions: [{ field: 'evil' as never, operator: 'is_any_of', value: ['x'] }],
    });
    const forgedOperator = encodeFilterParam({
      combinator: 'and',
      conditions: [{ field: 'status', operator: 'contains' as never, value: 'x' }],
    });
    const forgedValue = encodeFilterParam({
      combinator: 'and',
      conditions: [{ field: 'storyPoints', operator: 'gt', value: 'NaN' as never }],
    });
    expect(parseAdvancedFilterParam(forgedField)).toEqual({ state: 'invalid' });
    expect(parseAdvancedFilterParam(forgedOperator)).toEqual({ state: 'invalid' });
    expect(parseAdvancedFilterParam(forgedValue)).toEqual({ state: 'invalid' });
  });

  it('Epic-5 conditions parse ACTIVE (stale resolves at read time, not parse time)', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [
        { field: 'cf:some-deleted-field', operator: 'is_any_of', value: ['opt1'] },
        { field: 'lbl', operator: 'is_none_of', value: ['lbl1'] },
      ],
    };
    const parsed = parseAdvancedFilterParam(encodeFilterParam(ast));
    expect(parsed.state).toBe('active');
  });
});

describe('setAdvancedParam / clearFacets', () => {
  it('sets the encoded param for a non-empty AST and clears it otherwise', () => {
    const withAst = setAdvancedParam(EMPTY_FILTER, AST);
    expect(withAst.advanced).toBe(encodeFilterParam(AST));
    expect(setAdvancedParam(withAst, null).advanced).toBeNull();
    expect(setAdvancedParam(withAst, { combinator: 'and', conditions: [] }).advanced).toBeNull();
  });

  it('clearFacets resets the facets but PRESERVES the advanced param', () => {
    const filter: IssueFilter = {
      kinds: ['bug'],
      types: ['code'],
      includeUntyped: true,
      statuses: ['todo'],
      assigneeIds: ['u1'],
      includeUnassigned: true,
      text: 'oauth',
      advanced: 'v1:abc',
    };
    expect(clearFacets(filter)).toEqual({ ...EMPTY_FILTER, advanced: 'v1:abc' });
  });
});

describe('astExceedsFacets (the superseded gate — fires EXACTLY beyond facet expressiveness)', () => {
  it('a facet-shaped AST does not exceed', () => {
    expect(
      astExceedsFacets({
        combinator: 'and',
        conditions: [
          { field: 'kind', operator: 'is_any_of', value: ['bug', 'task'] },
          // the work-type facet's is_any_of row is facet-expressible (6.15.5).
          { field: 'type', operator: 'is_any_of', value: ['code', 'design'] },
          { field: 'status', operator: 'is_any_of', value: ['todo'] },
          { field: 'assignee', operator: 'is_any_of', value: ['u1', 'unassigned'] },
          { field: 'text', operator: 'contains', value: 'oauth' },
        ],
      }),
    ).toBe(false);
    expect(astExceedsFacets({ combinator: 'and', conditions: [] })).toBe(false);
  });

  it.each<[string, FilterAst]>([
    ['OR across rows', { ...AST, combinator: 'or' }],
    [
      'negation',
      {
        combinator: 'and',
        conditions: [{ field: 'kind', operator: 'is_none_of', value: ['bug'] }],
      },
    ],
    [
      'empty operator',
      { combinator: 'and', conditions: [{ field: 'assignee', operator: 'is_empty', value: null }] },
    ],
    [
      // the work-type "Untyped" bucket maps to `type is_empty` — NOT facet-
      // expressible (the single-operator map can't hold it), so it correctly
      // supersedes rather than silently down-converting (6.15.5).
      'type is_empty (the untyped bucket)',
      { combinator: 'and', conditions: [{ field: 'type', operator: 'is_empty', value: null }] },
    ],
    [
      'comparison',
      { combinator: 'and', conditions: [{ field: 'storyPoints', operator: 'gt', value: 5 }] },
    ],
    [
      'non-facet field',
      {
        combinator: 'and',
        conditions: [{ field: 'due', operator: 'in_next_days', value: 14 }],
      },
    ],
    [
      'a repeated facet field',
      {
        combinator: 'and',
        conditions: [
          { field: 'kind', operator: 'is_any_of', value: ['bug'] },
          { field: 'kind', operator: 'is_any_of', value: ['task'] },
        ],
      },
    ],
  ])('%s exceeds', (_name, ast) => {
    expect(astExceedsFacets(ast)).toBe(true);
  });
});

describe('upgradeFacetsIntoAst (the one-way lossless upgrade)', () => {
  it('carries every facet axis in as rows', () => {
    const facets: IssueFilter = {
      kinds: ['bug', 'task'],
      types: ['code', 'design'],
      includeUntyped: true,
      statuses: ['todo'],
      assigneeIds: ['u1'],
      includeUnassigned: true,
      text: 'oauth',
      advanced: null,
    };
    expect(upgradeFacetsIntoAst(facets, null)).toEqual({
      combinator: 'and',
      conditions: [
        { field: 'kind', operator: 'is_any_of', value: ['bug', 'task'] },
        // the work-type facet → an is_any_of row for the selected types + an
        // is_empty row for the "Untyped" bucket (no registry sentinel — lossless,
        // nothing dropped).
        { field: 'type', operator: 'is_any_of', value: ['code', 'design'] },
        { field: 'type', operator: 'is_empty', value: null },
        { field: 'status', operator: 'is_any_of', value: ['todo'] },
        { field: 'assignee', operator: 'is_any_of', value: ['u1', 'unassigned'] },
        { field: 'text', operator: 'contains', value: 'oauth' },
      ],
    });
  });

  it('appends the facet rows to an existing AST (always under its combinator)', () => {
    const facets: IssueFilter = { ...EMPTY_FILTER, kinds: ['bug'] };
    const merged = upgradeFacetsIntoAst(facets, AST);
    expect(merged.combinator).toBe('and');
    expect(merged.conditions).toEqual([
      ...AST.conditions,
      { field: 'kind', operator: 'is_any_of', value: ['bug'] },
    ]);
  });
});

describe('advancedBuilderFields (the registry-driven field menu)', () => {
  it('offers every registry field, in registry order, incl. the Epic-5 join fields (6.1.5) + the 2.7.6 work-item type facet', () => {
    expect(advancedBuilderFields().map((f) => f.id)).toEqual([
      'kind',
      'status',
      'priority',
      // Story 2.7 (2.7.6): the work-item `type` facet — registry-ordered right
      // after `priority`. Its `type-select` editor is now in the builder's
      // SUPPORTED_EDITOR_KINDS allowlist, so the field reaches the menu.
      'type',
      'assignee',
      'reporter',
      'sprint',
      'text',
      'created',
      'updated',
      'due',
      'storyPoints',
      'estimate',
      'lbl',
      'cmp',
    ]);
  });

  it('a registry addition with shipped editor kinds appears with zero UI changes', () => {
    const testOnly: FilterFieldDef = {
      id: 'watchers' as never,
      fieldType: 'number',
      nullable: true,
      operators: ['eq', 'gt', 'is_empty'],
    };
    const ids = advancedBuilderFields([...FILTER_FIELDS, testOnly]).map((f) => f.id);
    expect(ids).toContain('watchers');
  });
});

describe('the builder row model (pending rows never reach the URL)', () => {
  const complete: AdvancedBuilderRow = {
    key: 1,
    field: 'status',
    operator: 'is_any_of',
    value: ['todo'],
  };
  const pending: AdvancedBuilderRow = {
    key: 2,
    field: 'status',
    operator: 'is_any_of',
    value: null,
  };

  it('isRowComplete validates per the registry arity', () => {
    expect(isRowComplete(complete)).toBe(true);
    expect(isRowComplete(pending)).toBe(false);
    expect(isRowComplete({ ...pending, value: [] })).toBe(false);
    expect(isRowComplete({ key: 3, field: 'text', operator: 'contains', value: '  ' })).toBe(false);
    expect(isRowComplete({ key: 4, field: 'assignee', operator: 'is_empty', value: null })).toBe(
      true,
    );
    expect(
      isRowComplete({ key: 5, field: 'created', operator: 'between', value: ['2026-01-01', ''] }),
    ).toBe(false);
    expect(
      isRowComplete({
        key: 6,
        field: 'created',
        operator: 'between',
        value: ['2026-01-01', '2026-06-30'],
      }),
    ).toBe(true);
  });

  it('astFromRows carries complete rows only', () => {
    expect(astFromRows('or', [complete, pending])).toEqual({
      combinator: 'or',
      conditions: [{ field: 'status', operator: 'is_any_of', value: ['todo'] }],
    });
  });

  it('rowsFromAst seeds working rows with stable positional keys', () => {
    expect(rowsFromAst(AST)).toEqual([
      { key: 1, field: 'status', operator: 'is_any_of', value: ['todo', 'in_progress'] },
    ]);
    expect(rowsFromAst(null)).toEqual([]);
  });

  it('defaultOperator is the first registry operator', () => {
    expect(defaultOperator(fieldDef('status'))).toBe('is_any_of');
    expect(defaultOperator(fieldDef('text'))).toBe('contains');
    expect(defaultOperator(fieldDef('storyPoints'))).toBe('eq');
  });

  it('carryValueAcrossOperator keeps the value within an editor kind, resets across kinds', () => {
    const status = fieldDef('status');
    expect(carryValueAcrossOperator(status, 'is_any_of', 'is_none_of', ['todo'])).toEqual(['todo']);
    const assignee = fieldDef('assignee');
    expect(carryValueAcrossOperator(assignee, 'is_any_of', 'is_empty', ['u1'])).toBeNull();
    const text = fieldDef('text');
    expect(carryValueAcrossOperator(text, 'contains', 'not_contains', 'oauth')).toBe('oauth');
    const created = fieldDef('created');
    expect(carryValueAcrossOperator(created, 'on_or_before', 'on_or_after', '2026-06-01')).toBe(
      '2026-06-01',
    );
    expect(carryValueAcrossOperator(created, 'on_or_after', 'between', '2026-06-01')).toBeNull();
  });
});
