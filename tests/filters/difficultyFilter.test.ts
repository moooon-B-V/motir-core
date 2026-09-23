import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { InvalidFilterValueError } from '@/lib/filters/errors';
import { FILTER_FIELDS, filterValueEditorKind, validateFilterAst } from '@/lib/filters/registry';
import { advancedBuilderFields } from '@/lib/issues/issueListAdvancedFilter';
import { runSearchWorkItems } from '@/lib/mcp/tools/searchWorkItems';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-6016 · MOTIR-6100 — filtering by a leaf's DIFFICULTY. The four
// operators over real rows live in the filter-builder MATRIX (its totality
// guard demands them); this file pins the field's registry entry, the value
// whitelist, its admission to the builder menu, and that a saved filter holding
// the condition round-trips and applies with the same result.

const highOnly: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'difficulty', operator: 'is_any_of', value: ['high'] }],
};

describe('the difficulty filter field', () => {
  it('is a nullable enum with the four nullable-enum operators', () => {
    const def = FILTER_FIELDS.find((f) => f.id === 'difficulty');
    expect(def?.nullable).toBe(true);
    expect(def?.operators).toEqual(['is_any_of', 'is_none_of', 'is_empty', 'is_not_empty']);
  });

  it('validates the three members and refuses anything else with the typed error', () => {
    expect(() =>
      validateFilterAst({
        combinator: 'and',
        conditions: [{ field: 'difficulty', operator: 'is_any_of', value: ['low', 'high'] }],
      }),
    ).not.toThrow();
    expect(() =>
      validateFilterAst({
        combinator: 'and',
        conditions: [{ field: 'difficulty', operator: 'is_any_of', value: ['extreme'] }],
      }),
    ).toThrow(InvalidFilterValueError);
  });

  it('is admitted to the builder field menu with its own editor kind', () => {
    const field = advancedBuilderFields().find((f) => f.id === 'difficulty');
    expect(field).toBeDefined();
    expect(filterValueEditorKind(field!, 'is_any_of')).toBe('difficulty-select');
  });
});

describe('a saved filter over difficulty', () => {
  beforeEach(async () => {
    await adminDb.$executeRawUnsafe(
      'TRUNCATE TABLE "saved_filter", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
    );
    await truncateAuthTables();
  });

  afterAll(async () => {
    await db.$disconnect();
    await adminDb.$disconnect();
  });

  it('is saved, resolved to the same AST, and applied with the same result', async () => {
    const fx = await makeWorkItemFixture();
    const hard = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Hard one', difficulty: 'high' },
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Easy one', difficulty: 'low' },
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Unset one' },
      fx.ctx,
    );

    const saved = await savedFiltersService.create(
      fx.projectIdentifier,
      { name: 'The hard ones', visibility: 'private', filterParam: encodeFilterParam(highOnly) },
      fx.ctx,
    );
    const resolved = await savedFiltersService.resolve(fx.projectIdentifier, saved.id, fx.ctx);
    expect(resolved.astError).toBeNull();
    expect(resolved.ast).toEqual(highOnly);

    const res = await runSearchWorkItems(
      {
        projectKey: fx.projectIdentifier,
        filter: {
          version: 'v1',
          combinator: resolved.ast!.combinator,
          conditions: resolved.ast!.conditions,
        },
      } as never,
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();
    const keys = (res.structuredContent as { items: Array<{ key: string }> }).items.map(
      (i) => i.key,
    );
    expect(keys).toEqual([hard.identifier]);
  });
});
