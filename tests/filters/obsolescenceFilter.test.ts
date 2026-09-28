import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { decodeFilterParam, encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { InvalidFilterValueError } from '@/lib/filters/errors';
import { FILTER_FIELDS, filterValueEditorKind, validateFilterAst } from '@/lib/filters/registry';
import { WORK_ITEM_OBSOLESCENCES } from '@/lib/issues/obsolescence';
import { advancedBuilderFields } from '@/lib/issues/issueListAdvancedFilter';
import { runSearchWorkItems } from '@/lib/mcp/tools/searchWorkItems';
import { compileFilterConditionsSql } from '@/lib/repositories/workItemRepository';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-6574 · MOTIR-6583 — filtering by a card's OBSOLESCENCE mark. The
// four operators over the shared seed live in the filter-builder MATRIX (its
// totality guard demands them); this file pins the registry entry, the value
// whitelist, the compiled SQL binding every value, its admission to the builder
// menu, and the doors a person and an agent use — `search_work_items`, the
// `/items?filter=v1:…` URL and a saved filter — against real rows.

function only(
  operator: 'is_any_of' | 'is_none_of' | 'is_empty' | 'is_not_empty',
  value: string[] | null,
): FilterAst {
  return { combinator: 'and', conditions: [{ field: 'obsolescence', operator, value }] };
}

describe('the obsolescence filter field', () => {
  it('is a nullable enum over WORK_ITEM_OBSOLESCENCES with the four nullable-enum operators', () => {
    const def = FILTER_FIELDS.find((f) => f.id === 'obsolescence');
    expect(def?.fieldType).toBe('enum');
    expect(def?.nullable).toBe(true);
    expect(def?.valueWhitelist).toBe(WORK_ITEM_OBSOLESCENCES);
    expect(def?.operators).toEqual(['is_any_of', 'is_none_of', 'is_empty', 'is_not_empty']);
  });

  it('validates both members and refuses anything else with the registry’s typed error', () => {
    expect(() => validateFilterAst(only('is_any_of', ['outdated', 'deprecated']))).not.toThrow();
    expect(() => validateFilterAst(only('is_any_of', ['obsolete']))).toThrow(
      InvalidFilterValueError,
    );
    expect(() => validateFilterAst(only('is_none_of', ['outdated', 'stale']))).toThrow(
      InvalidFilterValueError,
    );
  });

  it('is admitted to the builder field menu with its own editor kind', () => {
    const field = advancedBuilderFields().find((f) => f.id === 'obsolescence');
    expect(field).toBeDefined();
    expect(filterValueEditorKind(field!, 'is_any_of')).toBe('obsolescence-select');
    expect(filterValueEditorKind(field!, 'is_empty')).toBe('none');
  });
});

describe('the compiled obsolescence predicate', () => {
  it('is_any_of binds the values as parameters against the fixed column', () => {
    const fragment = compileFilterConditionsSql(only('is_any_of', ['outdated']));
    expect(fragment.text).toContain('w."obsolescence"::text');
    expect(fragment.text).not.toContain('outdated');
    expect(JSON.stringify(fragment.values)).toContain('outdated');
  });

  it('is_none_of binds the values as parameters and never names them in the text', () => {
    const fragment = compileFilterConditionsSql(only('is_none_of', ['outdated', 'deprecated']));
    expect(fragment.text).toContain('w."obsolescence"::text');
    expect(fragment.text).not.toContain('outdated');
    expect(fragment.text).not.toContain('deprecated');
    expect(JSON.stringify(fragment.values)).toContain('deprecated');
  });

  it('the empty pair compiles to IS NULL / IS NOT NULL with no values', () => {
    const empty = compileFilterConditionsSql(only('is_empty', null));
    expect(empty.text).toContain('w."obsolescence"::text IS NULL');
    expect(empty.values).toEqual([]);
    const notEmpty = compileFilterConditionsSql(only('is_not_empty', null));
    expect(notEmpty.text).toContain('w."obsolescence"::text IS NOT NULL');
    expect(notEmpty.values).toEqual([]);
  });
});

describe('filtering real rows by obsolescence', () => {
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

  /** One card per bucket — the mark rides any kind (a story here too). */
  async function seed(): Promise<{
    fx: WorkItemFixture;
    outdated: string;
    deprecated: string;
    unmarked: string;
  }> {
    const fx = await makeWorkItemFixture();
    // A mark is a FINISHED card's state (MOTIR-6672): create, finish, then mark.
    const markFinished = async (
      kind: 'task' | 'story',
      title: string,
      obsolescence: 'outdated' | 'deprecated',
    ) => {
      const item = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind, title },
        fx.ctx,
      );
      await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'done' } });
      return workItemsService.updateWorkItem(item.id, { obsolescence }, fx.ctx);
    };
    const outdated = await markFinished('task', 'Stale text', 'outdated');
    const deprecated = await markFinished('story', 'Retired', 'deprecated');
    const unmarked = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Still true' },
      fx.ctx,
    );
    return {
      fx,
      outdated: outdated.identifier,
      deprecated: deprecated.identifier,
      unmarked: unmarked.identifier,
    };
  }

  async function search(fx: WorkItemFixture, ast?: FilterAst): Promise<string[]> {
    const res = await runSearchWorkItems(
      {
        projectKey: fx.projectIdentifier,
        ...(ast
          ? { filter: { version: 'v1', combinator: ast.combinator, conditions: ast.conditions } }
          : {}),
      } as never,
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();
    return (res.structuredContent as { items: Array<{ key: string }> }).items
      .map((i) => i.key)
      .sort();
  }

  it('search_work_items selects each bucket per operator — and no filter drops nothing', async () => {
    const s = await seed();
    expect(await search(s.fx, only('is_any_of', ['outdated']))).toEqual([s.outdated]);
    expect(await search(s.fx, only('is_none_of', ['outdated']))).toEqual(
      [s.deprecated, s.unmarked].sort(),
    );
    expect(await search(s.fx, only('is_empty', null))).toEqual([s.unmarked]);
    expect(await search(s.fx, only('is_not_empty', null))).toEqual(
      [s.outdated, s.deprecated].sort(),
    );
    // No condition, no narrowing: a marked card is never excluded by default.
    expect(await search(s.fx)).toEqual([s.outdated, s.deprecated, s.unmarked].sort());
  });

  it('refuses an off-enum value with the registry’s own error, never compiling it', async () => {
    const s = await seed();
    await expect(
      runSearchWorkItems(
        {
          projectKey: s.fx.projectIdentifier,
          filter: {
            version: 'v1',
            combinator: 'and',
            conditions: [{ field: 'obsolescence', operator: 'is_any_of', value: ['obsolete'] }],
          },
        } as never,
        s.fx.ctx,
      ),
    ).rejects.toThrow(InvalidFilterValueError);
  });

  it('the /items ?filter=v1:… URL decodes and applies, the row carrying its mark', async () => {
    const s = await seed();
    const decoded = decodeFilterParam(encodeFilterParam(only('is_any_of', ['outdated'])));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const page = await workItemsService.getProjectIssuesList(
      s.fx.projectId,
      { sort: { column: 'key', direction: 'asc' }, filter: { ast: decoded.ast } },
      s.fx.ctx,
    );
    expect(page.items.map((i) => [i.identifier, i.obsolescence])).toEqual([
      [s.outdated, 'outdated'],
    ]);
  });

  it('a saved filter keeps the condition and applies with the same result', async () => {
    const s = await seed();
    const ast = only('is_none_of', ['outdated']);
    const saved = await savedFiltersService.create(
      s.fx.projectIdentifier,
      { name: 'Not outdated', visibility: 'private', filterParam: encodeFilterParam(ast) },
      s.fx.ctx,
    );
    const resolved = await savedFiltersService.resolve(s.fx.projectIdentifier, saved.id, s.fx.ctx);
    expect(resolved.astError).toBeNull();
    expect(resolved.ast).toEqual(ast);
    expect(await search(s.fx, resolved.ast!)).toEqual([s.deprecated, s.unmarked].sort());
  });
});
