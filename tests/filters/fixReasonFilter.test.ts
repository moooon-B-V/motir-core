import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { WorkItemFixReason } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { InvalidFilterValueError } from '@/lib/filters/errors';
import { FILTER_FIELDS, filterValueEditorKind, validateFilterAst } from '@/lib/filters/registry';
import { advancedBuilderFields } from '@/lib/issues/issueListAdvancedFilter';
import { runSearchWorkItems } from '@/lib/mcp/tools/searchWorkItems';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { FIX_REASON_PRIORITY } from '@/lib/workItems/fixReason';
import {
  FIELD_EMPTY_OPERATOR_KEYS,
  FIX_REASON_VALUE_KEYS,
} from '@/app/(authed)/items/_components/advancedFilterLabels';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-6589 · MOTIR-6609 — filtering by WHY a card is stuck. The four
// operators over real rows live in the filter-builder MATRIX (its totality guard
// demands them); this file pins the field's registry entry, that its whitelist IS
// the reason tuple, its admission to the builder menu, its labels in both
// catalogues, and that a saved filter holding the condition round-trips.

const conflictedOnly: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'fixReason', operator: 'is_any_of', value: ['conflicted'] }],
};

describe('the fixReason filter field', () => {
  it('is a nullable enum with the four nullable-enum operators', () => {
    const def = FILTER_FIELDS.find((f) => f.id === 'fixReason');
    expect(def?.nullable).toBe(true);
    expect(def?.operators).toEqual(['is_any_of', 'is_none_of', 'is_empty', 'is_not_empty']);
  });

  it('whitelists EXACTLY the reason tuple, which is exactly the Prisma enum', () => {
    const def = FILTER_FIELDS.find((f) => f.id === 'fixReason');
    // One list, read — never retyped: a new reason reaches the filter on its own.
    expect(def?.valueWhitelist).toBe(FIX_REASON_PRIORITY);
    expect([...FIX_REASON_PRIORITY]).toEqual(Object.values(WorkItemFixReason));
    // A dead run ranks FIRST, so the value editor, which maps the tuple, offers it first.
    expect(FIX_REASON_PRIORITY[0]).toBe('run_died');
  });

  it('validates the reasons and refuses anything else with the typed error', () => {
    expect(() => validateFilterAst(conflictedOnly)).not.toThrow();
    expect(() =>
      validateFilterAst({
        combinator: 'and',
        conditions: [{ field: 'fixReason', operator: 'is_any_of', value: ['run_died'] }],
      }),
    ).not.toThrow();
    expect(() =>
      validateFilterAst({
        combinator: 'and',
        conditions: [{ field: 'fixReason', operator: 'is_any_of', value: ['lost_in_space'] }],
      }),
    ).toThrow(InvalidFilterValueError);
  });

  it('is admitted to the builder field menu with its own editor kind', () => {
    const field = advancedBuilderFields().find((f) => f.id === 'fixReason');
    expect(field).toBeDefined();
    expect(filterValueEditorKind(field!, 'is_any_of')).toBe('fix-reason-select');
  });

  it('labels every reason and the empty pair in BOTH catalogues', () => {
    for (const messages of [enMessages, zhMessages]) {
      const reasons = messages.workbench.toFix.reason as Record<string, string>;
      for (const reason of FIX_REASON_PRIORITY) {
        expect(reasons[FIX_REASON_VALUE_KEYS[reason]], reason).toBeTruthy();
      }
      const views = messages.issueViews as unknown as Record<string, string>;
      expect(views.advancedFieldToFix).toBeTruthy();
      for (const key of Object.values(FIELD_EMPTY_OPERATOR_KEYS.fixReason ?? {})) {
        expect(views[key!], key).toBeTruthy();
      }
    }
  });
});

describe('a saved filter over fixReason', () => {
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
    const stuck = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Conflicting one' },
      fx.ctx,
    );
    const queued = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Queue-failed one' },
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Healthy one' },
      fx.ctx,
    );
    await adminDb.workItem.update({
      where: { id: stuck.id },
      data: { fixReason: 'conflicted' },
    });
    await adminDb.workItem.update({
      where: { id: queued.id },
      data: { fixReason: 'queue_failed' },
    });

    const saved = await savedFiltersService.create(
      fx.projectIdentifier,
      {
        name: 'Conflicting cards',
        visibility: 'private',
        filterParam: encodeFilterParam(conflictedOnly),
      },
      fx.ctx,
    );
    const resolved = await savedFiltersService.resolve(fx.projectIdentifier, saved.id, fx.ctx);
    expect(resolved.astError).toBeNull();
    expect(resolved.ast).toEqual(conflictedOnly);

    const keysFor = async (ast: FilterAst) => {
      const res = await runSearchWorkItems(
        {
          projectKey: fx.projectIdentifier,
          filter: { version: 'v1', combinator: ast.combinator, conditions: ast.conditions },
        } as never,
        fx.ctx,
      );
      expect(res.isError).toBeFalsy();
      return (res.structuredContent as { items: Array<{ key: string }> }).items
        .map((i) => i.key)
        .sort();
    };
    expect(await keysFor(resolved.ast!)).toEqual([stuck.identifier]);
    // *To fix is any* — every card with a reason, and only those.
    expect(
      await keysFor({
        combinator: 'and',
        conditions: [{ field: 'fixReason', operator: 'is_not_empty', value: null }],
      }),
    ).toEqual([stuck.identifier, queued.identifier].sort());
  });
});
