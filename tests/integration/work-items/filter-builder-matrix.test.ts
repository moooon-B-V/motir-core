import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { customFieldFilterFieldId, type FilterAst, type FilterCondition } from '@/lib/filters/ast';
import {
  FILTER_FIELDS,
  customFieldFilterDef,
  type CustomFieldFilterType,
} from '@/lib/filters/registry';
import type { WorkItemTreeNodeDto } from '@/lib/dto/workItems';
import { truncateAuthTables } from '../../helpers/db';
import { createTestUser } from '../../fixtures';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
  type WorkItemFixture,
} from '../../fixtures';

// Story 6.1 · Subtask 6.1.6 — the STORY-CLOSING compile-correctness matrix.
//
// The per-cell correctness of individual operators already has integration
// coverage (tests/integration/work-items/filter-compiler.test.ts for the
// built-ins, epic5-filter-predicates.test.ts for the Epic-5 joins). What this
// file adds — and what the Story 6.1 verification recipe pins — is the
// TOTALITY GUARD over the WHOLE registry: a single matrix, DRIVEN FROM the
// registry, with one expected-set case per (field × operator) cell, plus a
// meta-test asserting the case set EQUALS the registry's cell set. A future
// registry addition — a new field, a new operator on a field, a new
// custom-field type — that ships without a matrix case FAILS the suite (the
// 5.5.1 / 6.1.1 totality-guard pattern, mistake #29: an enum-keyed map must be
// total over every value it can hold). Every cell runs under BOTH combinators
// (a single-row filter must be combinator-invariant), and a closing block
// re-asserts multi-row and/or composition + flat↔Tree parity over a mixed
// built-in + Epic-5 AST so the story-level claim ("one compiler, both views,
// every cell") is verified end to end through the shipped service.

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
function dueDate(daysOffset: number): Date {
  return new Date(Date.now() + daysOffset * 86_400_000);
}

interface Seeded {
  fx: WorkItemFixture;
  /** identifiers by handle (d nests under c — the Tree parity hierarchy). */
  ids: Record<'a' | 'b' | 'c' | 'd', string>;
  memberId: string;
  sprintId: string;
  fields: Record<'severity' | 'effort' | 'golive' | 'owner' | 'notes', string>;
  options: Record<'high' | 'low' | 'legacy', string>;
  labels: Record<'perf' | 'infra', string>;
  components: Record<'api' | 'web', string>;
}

/**
 * Four issues spanning EVERY filterable axis at once — the built-in columns,
 * the typed-EAV custom fields (one of each of the five types, incl. an
 * archived select option that must stay matchable), the label and component
 * joins — with `d` nested under `c` so the Tree comparison has hierarchy:
 *
 *   a — bug · todo · highest · assignee+reporter member · Sprint 1 · due +3 ·
 *       sp 5 · est 60 · "OAuth…/token refresh" · sev High · effort 8 ·
 *       golive +5 · owner-cf member · notes "oauth…" · label perf · comp api
 *   b — task · in_progress · medium · UNassigned · reporter owner · backlog ·
 *       due −5 · sp 2 · est ∅ · ∅ desc · sev Legacy(archived) · effort 3 ·
 *       golive −10 · owner-cf ∅ · notes "board polish" · no label · no comp
 *   c — story · done · low · assignee owner · reporter member · backlog ·
 *       due ∅ · sp ∅ · est 30 · "…oauth scopes" · NO cf values · labels
 *       perf+infra · no comp
 *   d — task (child of c) · todo · high · UNassigned · reporter owner ·
 *       Sprint 1 · due +10 · sp ∅ · est ∅ · sev Low · owner-cf owner ·
 *       comps api+web · no label
 */
async function seedMatrix(): Promise<Seeded> {
  const fx = await makeFixture();
  const member = await createTestUser({ name: 'Mo' });

  const a = await createWorkItem(fx, { kind: 'bug', title: 'OAuth login crashes' });
  const b = await createWorkItem(fx, { kind: 'task', title: 'Board drag stutter' });
  const c = await createWorkItem(fx, { kind: 'story', title: 'Velocity chart' });
  const d = await createWorkItem(fx, { kind: 'task', title: 'Chart polish pass', parentId: c.id });

  const sprint = await db.sprint.create({
    data: { workspaceId: fx.workspaceId, projectId: fx.projectId, name: 'Sprint 1', sequence: 1 },
  });

  await db.workItem.update({
    where: { id: a.id },
    data: {
      status: 'todo',
      priority: 'highest',
      assigneeId: member.id,
      reporterId: member.id,
      sprintId: sprint.id,
      dueDate: dueDate(3),
      storyPoints: 5,
      estimateMinutes: 60,
      descriptionMd: 'Stack trace points at the token refresh path.',
      type: 'code',
    },
  });
  await db.workItem.update({
    where: { id: b.id },
    data: {
      status: 'in_progress',
      priority: 'medium',
      assigneeId: null,
      reporterId: fx.ownerId,
      sprintId: null,
      dueDate: dueDate(-5),
      storyPoints: 2,
      estimateMinutes: null,
      type: 'manual',
    },
  });
  await db.workItem.update({
    where: { id: c.id },
    data: {
      status: 'done',
      priority: 'low',
      assigneeId: fx.ownerId,
      reporterId: member.id,
      sprintId: null,
      dueDate: null,
      storyPoints: null,
      estimateMinutes: 30,
      descriptionMd: 'Needs oauth scopes documented for the chart read.',
    },
  });
  await db.workItem.update({
    where: { id: d.id },
    data: {
      status: 'todo',
      priority: 'high',
      assigneeId: null,
      reporterId: fx.ownerId,
      sprintId: sprint.id,
      dueDate: dueDate(10),
      storyPoints: null,
      estimateMinutes: null,
    },
  });

  // ── Custom fields — one of every type (5.3.1 typed-EAV) ──────────────────
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

  // ── Labels + components — the 5.4.1 join probes ──────────────────────────
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
    sprintId: sprint.id,
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

async function listIdentifiers(seeded: Seeded, ast: FilterAst): Promise<string[]> {
  const page = await workItemsService.getProjectIssuesList(
    seeded.fx.projectId,
    { sort: SORT, filter: { ast } },
    seeded.fx.ctx,
  );
  return page.items.map((item) => item.identifier).sort();
}

function matchedIdentifiers(nodes: WorkItemTreeNodeDto[]): string[] {
  const out: string[] = [];
  const walk = (node: WorkItemTreeNodeDto) => {
    if (node.matched) out.push(node.identifier);
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out.sort();
}

function cfId(seeded: Seeded, field: keyof Seeded['fields']): `cf:${string}` {
  return customFieldFilterFieldId(seeded.fields[field]) as `cf:${string}`;
}

// ── The matrix: one case per registry (field × operator) cell ───────────────
//
// `cell` is the registry key — `${fieldId}|${operator}` for built-ins (incl.
// lbl/cmp), `cf:${type}|${operator}` for the dynamic custom-field types. The
// totality test below asserts the set of `cell`s equals the set the registry
// declares, so a registry change without a matching case fails. `build` maps
// the cell to a concrete one-condition AST against the seed; `expected` names
// the handles it must match.

type Handle = 'a' | 'b' | 'c' | 'd';
interface MatrixCase {
  cell: string;
  build: (s: Seeded) => FilterCondition;
  expected: Handle[];
}

/** Helper: a built-in condition + its registry cell key. */
function builtin(
  field: FilterCondition['field'],
  operator: FilterCondition['operator'],
  value: FilterCondition['value'],
  expected: Handle[],
  valueFor?: (s: Seeded) => FilterCondition['value'],
): MatrixCase {
  return {
    cell: `${field}|${operator}`,
    build: (s) => ({ field, operator, value: valueFor ? valueFor(s) : value }),
    expected,
  };
}

/** Helper: a custom-field condition keyed by the seed field + its CF-type cell. */
function cf(
  type: CustomFieldFilterType,
  field: keyof Seeded['fields'],
  operator: FilterCondition['operator'],
  value: FilterCondition['value'],
  expected: Handle[],
  valueFor?: (s: Seeded) => FilterCondition['value'],
): MatrixCase {
  return {
    cell: `cf:${type}|${operator}`,
    build: (s) => ({ field: cfId(s, field), operator, value: valueFor ? valueFor(s) : value }),
    expected,
  };
}

const CASES: MatrixCase[] = [
  // kind (enum, not nullable)
  builtin('kind', 'is_any_of', ['task'], ['b', 'd']),
  builtin('kind', 'is_none_of', ['task'], ['a', 'c']),
  // status (enum, not nullable)
  builtin('status', 'is_any_of', ['todo'], ['a', 'd']),
  builtin('status', 'is_none_of', ['todo'], ['b', 'c']),
  // priority (enum, not nullable)
  builtin('priority', 'is_any_of', ['high'], ['d']),
  builtin('priority', 'is_none_of', ['high'], ['a', 'b', 'c']),
  // type (enum, nullable — leaf-only: a=code, b=manual, c/d untyped → the
  // empty pair is the "untyped" bucket; is_none_of includes the NULLs per the
  // Jira rule, mirroring the assignee/sprint nullable-enum cases below)
  builtin('type', 'is_any_of', ['code'], ['a']),
  builtin('type', 'is_none_of', ['code'], ['b', 'c', 'd']),
  builtin('type', 'is_empty', null, ['c', 'd']),
  builtin('type', 'is_not_empty', null, ['a', 'b']),
  // assignee (enum, nullable — empty pair + the unassigned sentinel rules)
  builtin('assignee', 'is_any_of', [], ['a'], (s) => [s.memberId]),
  builtin('assignee', 'is_none_of', [], ['b', 'c', 'd'], (s) => [s.memberId]),
  builtin('assignee', 'is_empty', null, ['b', 'd']),
  builtin('assignee', 'is_not_empty', null, ['a', 'c']),
  // reporter (enum, not nullable)
  builtin('reporter', 'is_any_of', [], ['a', 'c'], (s) => [s.memberId]),
  builtin('reporter', 'is_none_of', [], ['b', 'd'], (s) => [s.memberId]),
  // sprint (enum, nullable — the backlog sentinel)
  builtin('sprint', 'is_any_of', [], ['a', 'd'], (s) => [s.sprintId]),
  builtin('sprint', 'is_none_of', [], ['b', 'c'], (s) => [s.sprintId]),
  builtin('sprint', 'is_empty', null, ['b', 'c']),
  builtin('sprint', 'is_not_empty', null, ['a', 'd']),
  // text (title + description contains; NULL-safe negation)
  builtin('text', 'contains', 'oauth', ['a', 'c']),
  builtin('text', 'not_contains', 'oauth', ['b', 'd']),
  // created (NOT NULL — seeded "now", so every window includes today → all)
  builtin('created', 'on_or_before', '', ['a', 'b', 'c', 'd'], () => isoDate(0)),
  builtin('created', 'on_or_after', '', ['a', 'b', 'c', 'd'], () => isoDate(0)),
  builtin('created', 'between', ['', ''], ['a', 'b', 'c', 'd'], () => [isoDate(-1), isoDate(1)]),
  builtin('created', 'in_last_days', 7, ['a', 'b', 'c', 'd']),
  builtin('created', 'in_next_days', 7, ['a', 'b', 'c', 'd']),
  // updated (NOT NULL — bumped by the seed updates → all today)
  builtin('updated', 'on_or_before', '', ['a', 'b', 'c', 'd'], () => isoDate(0)),
  builtin('updated', 'on_or_after', '', ['a', 'b', 'c', 'd'], () => isoDate(0)),
  builtin('updated', 'between', ['', ''], ['a', 'b', 'c', 'd'], () => [isoDate(-1), isoDate(1)]),
  builtin('updated', 'in_last_days', 7, ['a', 'b', 'c', 'd']),
  builtin('updated', 'in_next_days', 7, ['a', 'b', 'c', 'd']),
  // due (nullable — the discriminating date column + empty pair)
  builtin('due', 'on_or_before', '', ['b'], () => isoDate(0)),
  builtin('due', 'on_or_after', '', ['a', 'd'], () => isoDate(0)),
  builtin('due', 'between', ['', ''], ['a', 'b'], () => [isoDate(-7), isoDate(5)]),
  builtin('due', 'in_last_days', 7, ['b']),
  builtin('due', 'in_next_days', 7, ['a']),
  builtin('due', 'is_empty', null, ['c']),
  builtin('due', 'is_not_empty', null, ['a', 'b', 'd']),
  // storyPoints (number, nullable)
  builtin('storyPoints', 'eq', 5, ['a']),
  builtin('storyPoints', 'ne', 2, ['a']), // NULL rows excluded — the JQL != rule
  builtin('storyPoints', 'lt', 5, ['b']),
  builtin('storyPoints', 'lte', 2, ['b']),
  builtin('storyPoints', 'gt', 2, ['a']),
  builtin('storyPoints', 'gte', 5, ['a']),
  builtin('storyPoints', 'is_empty', null, ['c', 'd']),
  builtin('storyPoints', 'is_not_empty', null, ['a', 'b']),
  // estimate (number, nullable)
  builtin('estimate', 'eq', 60, ['a']),
  builtin('estimate', 'ne', 30, ['a']),
  builtin('estimate', 'lt', 45, ['c']),
  builtin('estimate', 'lte', 30, ['c']),
  builtin('estimate', 'gt', 45, ['a']),
  builtin('estimate', 'gte', 60, ['a']),
  builtin('estimate', 'is_empty', null, ['b', 'd']),
  builtin('estimate', 'is_not_empty', null, ['a', 'c']),
  // lbl (join, nullable)
  builtin('lbl', 'is_any_of', [], ['a', 'c'], (s) => [s.labels.perf]),
  builtin('lbl', 'is_none_of', [], ['b', 'd'], (s) => [s.labels.perf]),
  builtin('lbl', 'is_empty', null, ['b', 'd']),
  builtin('lbl', 'is_not_empty', null, ['a', 'c']),
  // cmp (join, nullable)
  builtin('cmp', 'is_any_of', [], ['a', 'd'], (s) => [s.components.api]),
  builtin('cmp', 'is_none_of', [], ['b', 'c'], (s) => [s.components.api]),
  builtin('cmp', 'is_empty', null, ['b', 'c']),
  builtin('cmp', 'is_not_empty', null, ['a', 'd']),
  // cf:select (Severity — archived option included in the option set)
  cf('select', 'severity', 'is_any_of', [], ['a'], (s) => [s.options.high]),
  cf('select', 'severity', 'is_none_of', [], ['b', 'c', 'd'], (s) => [s.options.high]),
  cf('select', 'severity', 'is_empty', null, ['c']),
  cf('select', 'severity', 'is_not_empty', null, ['a', 'b', 'd']),
  // cf:number (Effort)
  cf('number', 'effort', 'eq', 8, ['a']),
  cf('number', 'effort', 'ne', 3, ['a']),
  cf('number', 'effort', 'lt', 8, ['b']),
  cf('number', 'effort', 'lte', 3, ['b']),
  cf('number', 'effort', 'gt', 3, ['a']),
  cf('number', 'effort', 'gte', 8, ['a']),
  cf('number', 'effort', 'is_empty', null, ['c', 'd']),
  cf('number', 'effort', 'is_not_empty', null, ['a', 'b']),
  // cf:date (Go-live)
  cf('date', 'golive', 'on_or_before', '', ['b'], () => isoDate(0)),
  cf('date', 'golive', 'on_or_after', '', ['a'], () => isoDate(0)),
  cf('date', 'golive', 'between', ['', ''], ['b'], () => [isoDate(-15), isoDate(0)]),
  cf('date', 'golive', 'in_last_days', 14, ['b']),
  cf('date', 'golive', 'in_next_days', 14, ['a']),
  cf('date', 'golive', 'is_empty', null, ['c', 'd']),
  cf('date', 'golive', 'is_not_empty', null, ['a', 'b']),
  // cf:user (Owner)
  cf('user', 'owner', 'is_any_of', [], ['a'], (s) => [s.memberId]),
  cf('user', 'owner', 'is_none_of', [], ['b', 'c', 'd'], (s) => [s.memberId]),
  cf('user', 'owner', 'is_empty', null, ['b', 'c']),
  cf('user', 'owner', 'is_not_empty', null, ['a', 'd']),
  // cf:text (Notes — EAV not_contains excludes the empty bucket)
  cf('text', 'notes', 'contains', 'oauth', ['a']),
  cf('text', 'notes', 'not_contains', 'oauth', ['b']),
  cf('text', 'notes', 'is_empty', null, ['c', 'd']),
  cf('text', 'notes', 'is_not_empty', null, ['a', 'b']),
];

/** The cell keys the registry declares — built-ins (incl. lbl/cmp) from
 * FILTER_FIELDS, plus one dynamic def per custom-field type. */
function registryCells(): Set<string> {
  const cells = new Set<string>();
  for (const def of FILTER_FIELDS) {
    for (const op of def.operators) cells.add(`${def.id}|${op}`);
  }
  const CF_TYPES: CustomFieldFilterType[] = ['select', 'number', 'date', 'user', 'text'];
  for (const type of CF_TYPES) {
    for (const op of customFieldFilterDef('probe', type).operators) cells.add(`cf:${type}|${op}`);
  }
  return cells;
}

describe('the filter-builder matrix covers the WHOLE registry (totality guard)', () => {
  it('every registry (field × operator) cell has exactly one matrix case', () => {
    const registry = registryCells();
    const covered = CASES.map((c) => c.cell);
    const coveredSet = new Set(covered);

    // No duplicate cases (each cell appears once).
    expect(covered.length, 'a cell is covered more than once').toBe(coveredSet.size);
    // No case points at a cell the registry doesn't declare (stale case).
    const stale = [...coveredSet].filter((cell) => !registry.has(cell));
    expect(stale, 'matrix cases for cells the registry no longer declares').toEqual([]);
    // Every registry cell has a case — a new field/operator/CF-type without a
    // matrix case fails HERE (the totality guard, mistake #29 / 5.5.1).
    const missing = [...registry].filter((cell) => !coveredSet.has(cell)).sort();
    expect(missing, 'registry cells with no matrix case').toEqual([]);
  });
});

describe('every registry cell compiles to the right match set, under both combinators', () => {
  it('runs the full matrix as `and` and as `or` (a one-row filter is combinator-invariant)', async () => {
    const seeded = await seedMatrix();
    const expand = (handles: Handle[]) => handles.map((h) => seeded.ids[h]).sort();

    const failures: string[] = [];
    for (const matrixCase of CASES) {
      const condition = matrixCase.build(seeded);
      const want = expand(matrixCase.expected);
      for (const combinator of ['and', 'or'] as const) {
        const got = await listIdentifiers(seeded, { combinator, conditions: [condition] });
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          failures.push(
            `${matrixCase.cell} [${combinator}]: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
          );
        }
      }
    }
    expect(failures, `matrix cells with the wrong match set:\n${failures.join('\n')}`).toEqual([]);
  });
});

describe('multi-row and/or composition + flat↔Tree parity over a mixed AST', () => {
  it('AND narrows and OR widens across built-in + Epic-5 rows', async () => {
    const seeded = await seedMatrix();
    const { a, c, d } = seeded.ids;

    // AND: a built-in row AND a CF row AND a label row — only `a` carries all.
    expect(
      await listIdentifiers(seeded, {
        combinator: 'and',
        conditions: [
          { field: 'status', operator: 'is_any_of', value: ['todo'] },
          { field: cfId(seeded, 'severity'), operator: 'is_any_of', value: [seeded.options.high] },
          { field: 'lbl', operator: 'is_any_of', value: [seeded.labels.perf] },
        ],
      }),
    ).toEqual([a].sort());

    // OR: a CF-number row OR a label row OR a built-in priority row — widens.
    expect(
      await listIdentifiers(seeded, {
        combinator: 'or',
        conditions: [
          { field: cfId(seeded, 'effort'), operator: 'gte', value: 8 }, // a
          { field: 'lbl', operator: 'is_any_of', value: [seeded.labels.infra] }, // c
          { field: 'priority', operator: 'is_any_of', value: ['high'] }, // d
        ],
      }),
    ).toEqual([a, c, d].sort());
  });

  it('the same compiled predicate matches identically in the flat List and the Tree, keeping muted ancestors', async () => {
    const seeded = await seedMatrix();
    // Matches ONLY the nested child `d` (severity Low) — its parent `c` has no
    // CF value, so the Tree must retain it as a muted, non-matching ancestor.
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [
        { field: cfId(seeded, 'severity'), operator: 'is_any_of', value: [seeded.options.low] },
      ],
    };

    const flat = await listIdentifiers(seeded, ast);
    expect(flat).toEqual([seeded.ids.d]);

    const tree = await workItemsService.getProjectTree(seeded.fx.projectId, { ast }, seeded.fx.ctx);
    expect(matchedIdentifiers(tree)).toEqual(flat);
    expect(tree.map((n) => n.identifier)).toEqual([seeded.ids.c]); // ancestor retained
    expect(tree[0]?.matched).toBe(false);
    expect(tree[0]?.children.map((child) => child.identifier)).toEqual([seeded.ids.d]);
  });
});
