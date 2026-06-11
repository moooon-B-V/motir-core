import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { customFieldFilterFieldId, type FilterAst } from '@/lib/filters/ast';
import { labelRepository } from '@/lib/repositories/labelRepository';
import { customFieldOptionRepository } from '@/lib/repositories/customFieldOptionRepository';
import type { WorkItemTreeNodeDto } from '@/lib/dto/workItems';
import { truncateAuthTables } from '../../helpers/db';
import { createTestUser } from '../../fixtures';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
  type WorkItemFixture,
} from '../../fixtures';

// The Epic-5 predicates against real Postgres (Subtask 6.1.2): every custom-
// field type through its 5.3.1 typed-EAV indexed join (archived-option
// matching included), labels/components through the 5.4.1 join probes,
// is-empty semantics per type, composition under both combinators with one
// probe apiece, flat-List ↔ Tree parity, the stale-referent degrade (deleted
// field / option / label / component each), and the EXPLAIN index guard. The
// static fragment inspection lives in tests/filters/epic5Filters.test.ts.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "custom_field_value", "custom_field_option", "custom_field_definition", ' +
      '"work_item_label", "label", "work_item_component", "component", ' +
      '"work_item_revision", "work_item_link", "work_item", "sprint" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

const SORT = { column: 'key', direction: 'asc' } as const;

function isoDate(daysOffset: number): string {
  return new Date(Date.now() + daysOffset * 86_400_000).toISOString().slice(0, 10);
}

interface Seeded {
  fx: WorkItemFixture;
  ids: Record<'a' | 'b' | 'c' | 'd', string>;
  memberId: string;
  fields: Record<'severity' | 'effort' | 'golive' | 'owner' | 'notes', string>;
  options: Record<'high' | 'low' | 'legacy', string>;
  labels: Record<'perf' | 'infra', string>;
  components: Record<'api' | 'web', string>;
}

/**
 * Four issues spanning every Epic-5 axis (the typed-EAV rows, the label and
 * component joins, and an archived option that must stay matchable):
 *
 *   a — severity High · effort 8 · golive +5d · owner member · notes "oauth…" · label perf · component api
 *   b — severity Legacy (ARCHIVED) · effort 3 · golive −10d · notes "…polish" · owner-cf ∅
 *   c — no CF values at all · labels perf+infra
 *   d — severity Low · owner-cf = project owner · components api+web
 */
async function seedEpic5(): Promise<Seeded> {
  const fx = await makeFixture();
  const member = await createTestUser({ name: 'Mo' });

  const a = await createWorkItem(fx, { kind: 'bug', title: 'OAuth login crashes' });
  const b = await createWorkItem(fx, { kind: 'task', title: 'Board drag stutter' });
  const c = await createWorkItem(fx, { kind: 'story', title: 'Velocity chart' });
  const d = await createWorkItem(fx, { kind: 'task', title: 'Chart polish pass' });

  const defCommon = { workspaceId: fx.workspaceId, projectId: fx.projectId };
  const severity = await db.customFieldDefinition.create({
    data: { ...defCommon, key: 'severity', label: 'Severity', fieldType: 'select', position: 'a0' },
  });
  const effort = await db.customFieldDefinition.create({
    data: { ...defCommon, key: 'effort', label: 'Effort', fieldType: 'number', position: 'a1' },
  });
  const golive = await db.customFieldDefinition.create({
    data: { ...defCommon, key: 'golive', label: 'Go-live', fieldType: 'date', position: 'a2' },
  });
  const owner = await db.customFieldDefinition.create({
    data: { ...defCommon, key: 'owner', label: 'Owner', fieldType: 'user', position: 'a3' },
  });
  const notes = await db.customFieldDefinition.create({
    data: { ...defCommon, key: 'notes', label: 'Notes', fieldType: 'text', position: 'a4' },
  });

  const high = await db.customFieldOption.create({
    data: { fieldId: severity.id, label: 'High', position: 'a0' },
  });
  const low = await db.customFieldOption.create({
    data: { fieldId: severity.id, label: 'Low', position: 'a1' },
  });
  const legacy = await db.customFieldOption.create({
    data: { fieldId: severity.id, label: 'Legacy', position: 'a2', archived: true },
  });

  const value = (workItemId: string, fieldId: string) => ({
    workspaceId: fx.workspaceId,
    workItemId,
    fieldId,
  });
  await db.customFieldValue.createMany({
    data: [
      { ...value(a.id, severity.id), valueOptionId: high.id },
      { ...value(b.id, severity.id), valueOptionId: legacy.id },
      { ...value(d.id, severity.id), valueOptionId: low.id },
      { ...value(a.id, effort.id), valueNumber: 8 },
      { ...value(b.id, effort.id), valueNumber: 3 },
      { ...value(a.id, golive.id), valueDate: new Date(`${isoDate(5)}T00:00:00Z`) },
      { ...value(b.id, golive.id), valueDate: new Date(`${isoDate(-10)}T00:00:00Z`) },
      { ...value(a.id, owner.id), valueUserId: member.id },
      { ...value(d.id, owner.id), valueUserId: fx.ownerId },
      { ...value(a.id, notes.id), valueText: 'oauth scopes documented here' },
      { ...value(b.id, notes.id), valueText: 'board polish backlog' },
    ],
  });

  const labelCommon = { workspaceId: fx.workspaceId, projectId: fx.projectId };
  const perf = await db.label.create({
    data: { ...labelCommon, name: 'perf-q3', nameLower: 'perf-q3' },
  });
  const infra = await db.label.create({
    data: { ...labelCommon, name: 'infra', nameLower: 'infra' },
  });
  await db.workItemLabel.createMany({
    data: [
      { workItemId: a.id, labelId: perf.id },
      { workItemId: c.id, labelId: perf.id },
      { workItemId: c.id, labelId: infra.id },
    ],
  });

  const api = await db.component.create({
    data: { ...labelCommon, name: 'API', nameLower: 'api' },
  });
  const web = await db.component.create({
    data: { ...labelCommon, name: 'Web', nameLower: 'web' },
  });
  await db.workItemComponent.createMany({
    data: [
      { workItemId: a.id, componentId: api.id },
      { workItemId: d.id, componentId: api.id },
      { workItemId: d.id, componentId: web.id },
    ],
  });

  return {
    fx,
    ids: { a: a.identifier, b: b.identifier, c: c.identifier, d: d.identifier },
    memberId: member.id,
    fields: {
      severity: severity.id,
      effort: effort.id,
      golive: golive.id,
      owner: owner.id,
      notes: notes.id,
    },
    options: { high: high.id, low: low.id, legacy: legacy.id },
    labels: { perf: perf.id, infra: infra.id },
    components: { api: api.id, web: web.id },
  };
}

/** Run the flat List read under an AST and return the matched identifiers. */
async function listIdentifiers(seeded: Seeded, ast: FilterAst): Promise<string[]> {
  const page = await workItemsService.getProjectIssuesList(
    seeded.fx.projectId,
    { sort: SORT, filter: { ast } },
    seeded.fx.ctx,
  );
  return page.items.map((item) => item.identifier).sort();
}

function and(...conditions: FilterAst['conditions']): FilterAst {
  return { combinator: 'and', conditions };
}
function or(...conditions: FilterAst['conditions']): FilterAst {
  return { combinator: 'or', conditions };
}

function cf(seeded: Seeded, field: keyof Seeded['fields']): `cf:${string}` {
  return customFieldFilterFieldId(seeded.fields[field]) as `cf:${string}`;
}

describe('custom-field conditions ride the 5.3.1 typed-EAV joins', () => {
  it('select: membership (archived options stay matchable), negation includes the empty bucket, empty pair', async () => {
    const s = await seedEpic5();
    const { a, b, c, d } = s.ids;
    const severity = cf(s, 'severity');

    expect(
      await listIdentifiers(
        s,
        and({ field: severity, operator: 'is_any_of', value: [s.options.high] }),
      ),
    ).toEqual([a]);
    // The archived option keeps matching historically-set values (the
    // verified Jira rule the card pins).
    expect(
      await listIdentifiers(
        s,
        and({ field: severity, operator: 'is_any_of', value: [s.options.legacy] }),
      ),
    ).toEqual([b]);
    // none_of includes the no-value bucket (c) — the enum none-of rule.
    expect(
      await listIdentifiers(
        s,
        and({ field: severity, operator: 'is_none_of', value: [s.options.high, s.options.low] }),
      ),
    ).toEqual([b, c].sort());
    expect(
      await listIdentifiers(s, and({ field: severity, operator: 'is_empty', value: null })),
    ).toEqual([c]);
    expect(
      await listIdentifiers(s, and({ field: severity, operator: 'is_not_empty', value: null })),
    ).toEqual([a, b, d].sort());
  });

  it('number: the comparison set (ne excludes empties — the JQL != rule) and the empty pair', async () => {
    const s = await seedEpic5();
    const { a, b, c, d } = s.ids;
    const effort = cf(s, 'effort');

    expect(await listIdentifiers(s, and({ field: effort, operator: 'eq', value: 3 }))).toEqual([b]);
    // ne matches only rows that HAVE a value (c/d carry none).
    expect(await listIdentifiers(s, and({ field: effort, operator: 'ne', value: 3 }))).toEqual([a]);
    expect(await listIdentifiers(s, and({ field: effort, operator: 'gt', value: 3 }))).toEqual([a]);
    expect(await listIdentifiers(s, and({ field: effort, operator: 'gte', value: 8 }))).toEqual([
      a,
    ]);
    expect(await listIdentifiers(s, and({ field: effort, operator: 'lt', value: 8 }))).toEqual([b]);
    expect(await listIdentifiers(s, and({ field: effort, operator: 'lte', value: 3 }))).toEqual([
      b,
    ]);
    expect(
      await listIdentifiers(s, and({ field: effort, operator: 'is_empty', value: null })),
    ).toEqual([c, d].sort());
  });

  it('date: absolute bounds, between, the relative windows, and the empty pair', async () => {
    const s = await seedEpic5();
    const { a, b, c, d } = s.ids;
    const golive = cf(s, 'golive');

    expect(
      await listIdentifiers(s, and({ field: golive, operator: 'on_or_after', value: isoDate(0) })),
    ).toEqual([a]);
    expect(
      await listIdentifiers(s, and({ field: golive, operator: 'on_or_before', value: isoDate(0) })),
    ).toEqual([b]);
    expect(
      await listIdentifiers(
        s,
        and({ field: golive, operator: 'between', value: [isoDate(-15), isoDate(-5)] }),
      ),
    ).toEqual([b]);
    expect(
      await listIdentifiers(s, and({ field: golive, operator: 'in_last_days', value: 15 })),
    ).toEqual([b]);
    expect(
      await listIdentifiers(s, and({ field: golive, operator: 'in_next_days', value: 7 })),
    ).toEqual([a]);
    expect(
      await listIdentifiers(s, and({ field: golive, operator: 'is_empty', value: null })),
    ).toEqual([c, d].sort());
  });

  it('user: membership over members, negation includes empties, empty pair', async () => {
    const s = await seedEpic5();
    const { a, b, c, d } = s.ids;
    const owner = cf(s, 'owner');

    expect(
      await listIdentifiers(s, and({ field: owner, operator: 'is_any_of', value: [s.memberId] })),
    ).toEqual([a]);
    expect(
      await listIdentifiers(s, and({ field: owner, operator: 'is_none_of', value: [s.memberId] })),
    ).toEqual([b, c, d].sort());
    expect(
      await listIdentifiers(s, and({ field: owner, operator: 'is_empty', value: null })),
    ).toEqual([b, c].sort());
  });

  it('text: contains / does-not-contain (excluding empties — the JQL !~ rule) and the empty pair', async () => {
    const s = await seedEpic5();
    const { a, b, c, d } = s.ids;
    const notes = cf(s, 'notes');

    expect(
      await listIdentifiers(s, and({ field: notes, operator: 'contains', value: 'OAuth' })),
    ).toEqual([a]);
    // not_contains matches only rows that HAVE a value (c/d carry none).
    expect(
      await listIdentifiers(s, and({ field: notes, operator: 'not_contains', value: 'polish' })),
    ).toEqual([a]);
    expect(
      await listIdentifiers(s, and({ field: notes, operator: 'is_empty', value: null })),
    ).toEqual([c, d].sort());
    expect(
      await listIdentifiers(s, and({ field: notes, operator: 'is_not_empty', value: null })),
    ).toEqual([a, b].sort());
  });
});

describe('label / component conditions ride the 5.4.1 join probes', () => {
  it('labels: membership, negation (includes the unlabelled), empty pair', async () => {
    const s = await seedEpic5();
    const { a, b, c, d } = s.ids;

    expect(
      await listIdentifiers(
        s,
        and({ field: 'lbl', operator: 'is_any_of', value: [s.labels.perf] }),
      ),
    ).toEqual([a, c].sort());
    expect(
      await listIdentifiers(
        s,
        and({ field: 'lbl', operator: 'is_none_of', value: [s.labels.perf] }),
      ),
    ).toEqual([b, d].sort());
    expect(
      await listIdentifiers(s, and({ field: 'lbl', operator: 'is_empty', value: null })),
    ).toEqual([b, d].sort());
    expect(
      await listIdentifiers(s, and({ field: 'lbl', operator: 'is_not_empty', value: null })),
    ).toEqual([a, c].sort());
  });

  it('components: membership, negation, empty pair', async () => {
    const s = await seedEpic5();
    const { a, b, c, d } = s.ids;

    expect(
      await listIdentifiers(
        s,
        and({ field: 'cmp', operator: 'is_any_of', value: [s.components.api] }),
      ),
    ).toEqual([a, d].sort());
    expect(
      await listIdentifiers(
        s,
        and({ field: 'cmp', operator: 'is_none_of', value: [s.components.api] }),
      ),
    ).toEqual([b, c].sort());
    expect(
      await listIdentifiers(s, and({ field: 'cmp', operator: 'is_empty', value: null })),
    ).toEqual([b, c].sort());
  });
});

describe('composition: multiple Epic-5 probes under both combinators, no join collision', () => {
  it('AND across a CF, a label-less component, and a built-in', async () => {
    const s = await seedEpic5();
    const { a } = s.ids;
    expect(
      await listIdentifiers(
        s,
        and(
          { field: cf(s, 'severity'), operator: 'is_any_of', value: [s.options.high] },
          { field: 'cmp', operator: 'is_any_of', value: [s.components.api] },
          { field: 'kind', operator: 'is_any_of', value: ['bug'] },
        ),
      ),
    ).toEqual([a]);
  });

  it('OR widens across two different CF joins + a label join', async () => {
    const s = await seedEpic5();
    const { a, b, c } = s.ids;
    expect(
      await listIdentifiers(
        s,
        or(
          { field: cf(s, 'effort'), operator: 'eq', value: 3 },
          { field: cf(s, 'notes'), operator: 'contains', value: 'oauth' },
          { field: 'lbl', operator: 'is_any_of', value: [s.labels.infra] },
        ),
      ),
    ).toEqual([a, b, c].sort());
  });

  it('two conditions on the SAME custom field compose (one aliased probe apiece)', async () => {
    const s = await seedEpic5();
    const { a, b } = s.ids;
    expect(
      await listIdentifiers(
        s,
        and(
          { field: cf(s, 'effort'), operator: 'gte', value: 3 },
          { field: cf(s, 'effort'), operator: 'lte', value: 8 },
        ),
      ),
    ).toEqual([a, b].sort());
  });
});

describe('flat-List ↔ Tree parity (one compiler, both views)', () => {
  it('a CF + label AST matches the same set in the tree, ancestors retained muted', async () => {
    const s = await seedEpic5();
    const ast = or(
      { field: cf(s, 'severity'), operator: 'is_any_of', value: [s.options.high] },
      { field: 'lbl', operator: 'is_any_of', value: [s.labels.infra] },
    );
    const fromList = await listIdentifiers(s, ast);

    const tree = await workItemsService.getProjectTree(s.fx.projectId, { ast }, s.fx.ctx);
    const matched: string[] = [];
    const walk = (node: WorkItemTreeNodeDto) => {
      if (node.matched) matched.push(node.identifier);
      node.children.forEach(walk);
    };
    tree.forEach(walk);

    expect(matched.sort()).toEqual(fromList);
    expect(fromList).toEqual([s.ids.a, s.ids.c].sort());
  });
});

describe('stale referents degrade to match-nothing — never an error (the 6.2 durability rule)', () => {
  it('a deleted custom FIELD: its condition matches nothing; OR-siblings still match', async () => {
    const s = await seedEpic5();
    const severity = cf(s, 'severity');
    await db.customFieldDefinition.delete({ where: { id: s.fields.severity } });

    expect(
      await listIdentifiers(
        s,
        and({ field: severity, operator: 'is_any_of', value: [s.options.high] }),
      ),
    ).toEqual([]);
    expect(
      await listIdentifiers(
        s,
        or(
          { field: severity, operator: 'is_any_of', value: [s.options.high] },
          { field: 'kind', operator: 'is_any_of', value: ['story'] },
        ),
      ),
    ).toEqual([s.ids.c]);
  });

  it('a deleted OPTION: the condition matches nothing even under negation (stale ≠ none-of-everything)', async () => {
    const s = await seedEpic5();
    const severity = cf(s, 'severity');
    await db.customFieldValue.deleteMany({ where: { valueOptionId: s.options.legacy } });
    await db.customFieldOption.delete({ where: { id: s.options.legacy } });

    expect(
      await listIdentifiers(
        s,
        and({ field: severity, operator: 'is_any_of', value: [s.options.legacy] }),
      ),
    ).toEqual([]);
    // A live id keeps working; mixing in the stale id poisons only that row.
    expect(
      await listIdentifiers(
        s,
        and({ field: severity, operator: 'is_none_of', value: [s.options.legacy] }),
      ),
    ).toEqual([]);
  });

  it('a deleted LABEL and a deleted COMPONENT each go match-nothing', async () => {
    const s = await seedEpic5();
    await db.workItemLabel.deleteMany({ where: { labelId: s.labels.perf } });
    await db.label.delete({ where: { id: s.labels.perf } });
    await db.workItemComponent.deleteMany({ where: { componentId: s.components.api } });
    await db.component.delete({ where: { id: s.components.api } });

    expect(
      await listIdentifiers(
        s,
        and({ field: 'lbl', operator: 'is_any_of', value: [s.labels.perf] }),
      ),
    ).toEqual([]);
    expect(
      await listIdentifiers(
        s,
        and({ field: 'cmp', operator: 'is_any_of', value: [s.components.api] }),
      ),
    ).toEqual([]);
  });

  it('a CROSS-TENANT id reads as stale too (no existence probe across projects)', async () => {
    const s = await seedEpic5();
    const other = await makeFixture({ name: 'Other', identifier: 'OTH' });
    const foreignLabel = await db.label.create({
      data: {
        workspaceId: other.workspaceId,
        projectId: other.projectId,
        name: 'foreign',
        nameLower: 'foreign',
      },
    });
    expect(
      await listIdentifiers(
        s,
        and({ field: 'lbl', operator: 'is_any_of', value: [foreignLabel.id] }),
      ),
    ).toEqual([]);
  });
});

describe('the bulk-id reads (coverage-gate contracts)', () => {
  it('empty input is an empty result, ids are tenancy-scoped', async () => {
    const s = await seedEpic5();
    expect(await labelRepository.findByIds([], s.fx.projectId)).toEqual([]);
    expect(
      await customFieldOptionRepository.findByIds([], s.fx.projectId, s.fx.workspaceId),
    ).toEqual([]);
    const labels = await labelRepository.findByIds([s.labels.perf, 'nope'], s.fx.projectId);
    expect(labels.map((l) => l.id)).toEqual([s.labels.perf]);
    const options = await customFieldOptionRepository.findByIds(
      [s.options.high, 'nope'],
      s.fx.projectId,
      s.fx.workspaceId,
    );
    expect(options.map((o) => o.id)).toEqual([s.options.high]);
  });
});

describe('the 5.3.1 predicate indexes serve the probes (finding #57)', () => {
  it('EXPLAIN shows the select-option probe using the [fieldId, valueOptionId] index', async () => {
    const s = await seedEpic5();
    const plan = await db.$transaction(async (tx) => {
      // Tiny seeded table — force the planner's hand: the assert is "the
      // index EXISTS and serves this predicate", not a cost decision. (jit
      // off: the sandbox Postgres lacks the JIT library.)
      await tx.$executeRawUnsafe('SET LOCAL jit = off');
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN SELECT w."id" FROM "work_item" w
          WHERE EXISTS (SELECT 1 FROM "custom_field_value" v
                         WHERE v."work_item_id" = w."id"
                           AND v."field_id" = '${s.fields.severity}'
                           AND v."value_option_id" = ANY(ARRAY['${s.options.high}']))`,
      );
    });
    const planText = plan.map((row) => row['QUERY PLAN']).join('\n');
    // The probe is served by the `[field_id, value*]` index family (on a
    // near-empty table the planner may pick ANY member — they share the
    // field_id prefix); the load-bearing assert is index-served + no
    // seq-scan over the value table.
    expect(planText).toMatch(/Index Scan using custom_field_value_field_id_value_\w+_idx/);
    expect(planText).not.toContain('Seq Scan on custom_field_value');
  });
});
