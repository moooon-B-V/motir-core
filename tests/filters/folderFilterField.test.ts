import { describe, expect, it } from 'vitest';
import type { FilterAst, FilterCondition, FilterOperatorId } from '@/lib/filters/ast';
import { InvalidFilterValueError, UnknownFilterOperatorError } from '@/lib/filters/errors';
import {
  EMPTY_PROJECT_FILTER_REFERENTS,
  astHasEpic5Conditions,
  collectFilterReferentIds,
  filterFieldDef,
  filterValueEditorKind,
  resolveFilterAst,
  validateFilterCondition,
  type ProjectFilterReferents,
} from '@/lib/filters/registry';
import { compileFilterConditionsSql } from '@/lib/repositories/workItemRepository';

// The FOLDER filter field (Story MOTIR-5309 · MOTIR-5376), below the database:
// its registry entry and operator set, the typed rejections, the referent
// collection that feeds `loadFilterReferents`, the stale-value resolution, and
// the compiled fragment binding every folder id as a parameter. The predicate's
// MATCH SETS live in tests/integration/work-items/folder-filter-predicate.test.ts.

const FOLDER_OPERATORS: FilterOperatorId[] = [
  'is_any_of',
  'is_none_of',
  'is_empty',
  'is_not_empty',
];

function folderReferents(...ids: string[]): ProjectFilterReferents {
  return { ...EMPTY_PROJECT_FILTER_REFERENTS, folderIds: new Set(ids) };
}

function one(condition: FilterCondition): FilterAst {
  return { combinator: 'and', conditions: [condition] };
}

describe('the folder registry entry', () => {
  it('is a nullable enum field offering exactly the four folder operators', () => {
    const def = filterFieldDef('folder');
    expect(def.fieldType).toBe('enum');
    expect(def.nullable).toBe(true);
    expect([...def.operators].sort()).toEqual([...FOLDER_OPERATORS].sort());
  });

  it('names the folder picker for the list operators and no editor for the empty pair', () => {
    const def = filterFieldDef('folder');
    expect(filterValueEditorKind(def, 'is_any_of')).toBe('folder-select');
    expect(filterValueEditorKind(def, 'is_none_of')).toBe('folder-select');
    expect(filterValueEditorKind(def, 'is_empty')).toBe('none');
    expect(filterValueEditorKind(def, 'is_not_empty')).toBe('none');
  });

  it('validates its four operators with well-formed values', () => {
    expect(() =>
      validateFilterCondition({ field: 'folder', operator: 'is_any_of', value: ['f-1', 'f-2'] }),
    ).not.toThrow();
    expect(() =>
      validateFilterCondition({ field: 'folder', operator: 'is_none_of', value: ['f-1'] }),
    ).not.toThrow();
    expect(() =>
      validateFilterCondition({ field: 'folder', operator: 'is_empty', value: null }),
    ).not.toThrow();
    expect(() =>
      validateFilterCondition({ field: 'folder', operator: 'is_not_empty', value: null }),
    ).not.toThrow();
  });

  it('rejects any other operator with UnknownFilterOperatorError', () => {
    for (const operator of ['contains', 'eq', 'between', 'on_or_after', 'in_last_days'] as const) {
      expect(() =>
        validateFilterCondition({ field: 'folder', operator, value: 'x' } as FilterCondition),
      ).toThrow(UnknownFilterOperatorError);
    }
  });

  it('rejects a malformed value with InvalidFilterValueError', () => {
    expect(() =>
      validateFilterCondition({
        field: 'folder',
        operator: 'is_any_of',
        value: 'f-1',
      } as FilterCondition),
    ).toThrow(InvalidFilterValueError);
    expect(() =>
      validateFilterCondition({
        field: 'folder',
        operator: 'is_any_of',
        value: [1, 2],
      } as unknown as FilterCondition),
    ).toThrow(InvalidFilterValueError);
  });
});

describe('folder referents', () => {
  it('a folder condition asks for referents, and its ids are collected as folder ids only', () => {
    const ast: FilterAst = {
      combinator: 'or',
      conditions: [
        { field: 'folder', operator: 'is_any_of', value: ['f-1', 'f-2'] },
        { field: 'folder', operator: 'is_none_of', value: ['f-2', 'f-3'] },
        { field: 'folder', operator: 'is_empty', value: null },
      ],
    };
    expect(astHasEpic5Conditions(ast)).toBe(true);
    const ids = collectFilterReferentIds(ast);
    expect(ids.folderIds.sort()).toEqual(['f-1', 'f-2', 'f-3']);
    expect(ids.labelIds).toEqual([]);
    expect(ids.componentIds).toEqual([]);
  });

  it('a folder id absent from the project’s folders resolves as a stale value', () => {
    const condition: FilterCondition = { field: 'folder', operator: 'is_any_of', value: ['gone'] };
    expect(resolveFilterAst(one(condition), folderReferents('f-1')).conditions[0]!.stale).toBe(
      'unknown-value',
    );
    expect(
      resolveFilterAst(one(condition), EMPTY_PROJECT_FILTER_REFERENTS).conditions[0]!.stale,
    ).toBe('unknown-value');
    const present: FilterCondition = { field: 'folder', operator: 'is_none_of', value: ['f-1'] };
    expect(resolveFilterAst(one(present), folderReferents('f-1')).conditions[0]!.stale).toBeNull();
  });

  it('the empty pair needs no referent and is never stale', () => {
    const empty: FilterCondition = { field: 'folder', operator: 'is_empty', value: null };
    expect(resolveFilterAst(one(empty)).conditions[0]!.stale).toBeNull();
  });
});

describe('the compiled folder fragment', () => {
  it('a stale folder condition compiles to FALSE, and reaches no folder SQL', () => {
    const fragment = compileFilterConditionsSql(
      one({ field: 'folder', operator: 'is_any_of', value: ['gone'] }),
      folderReferents('f-1'),
    );
    expect(fragment.text).toBe('(FALSE)');
  });

  it('binds every folder id as a parameter — a hostile id never reaches SQL text', () => {
    const hostile = `f-1"; DROP TABLE "folder"; --`;
    for (const operator of ['is_any_of', 'is_none_of'] as const) {
      const fragment = compileFilterConditionsSql(
        one({ field: 'folder', operator, value: [hostile] }),
        folderReferents(hostile),
      );
      expect(fragment.text).not.toContain(hostile);
      expect(fragment.values).toContainEqual([hostile]);
      expect(fragment.text).toContain('"parent_folder_id"');
    }
  });

  it('walks the parent chain the depth trigger allows, and reads the effective folder', () => {
    const fragment = compileFilterConditionsSql(
      one({ field: 'folder', operator: 'is_not_empty', value: null }),
    );
    expect(fragment.text).toContain('w."folderId"');
    // A root is depth 1 and the limit is 4: three parent hops reach any root.
    expect(fragment.text).toContain('"fp3"');
    expect(fragment.text).not.toContain('"fp4"');
    expect(fragment.values).toEqual([]);
  });
});
