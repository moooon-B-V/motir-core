import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { UnknownFilterFieldError } from '@/lib/filters/errors';
import type { FilterAst } from '@/lib/filters/ast';
import type { WorkItemTreeNodeDto } from '@/lib/dto/workItems';
import { truncateAuthTables } from '../../helpers/db';
import { createTestUser } from '../../fixtures';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
  type WorkItemFixture,
} from '../../fixtures';

// The FilterAST compile path against real Postgres (Subtask 6.1.1): the
// operator matrix over seeded data (enum membership incl. the empty-bucket
// sentinels, negation, empty, comparisons, absolute + relative date windows),
// the and/or combinators, the facet+AST composition, the flat-List ↔ Tree
// match-set equivalence (one compiler, both views), behavioral injection
// safety, and the trgm-index EXPLAIN guard (finding #57). The static
// bound-parameter inspection lives in tests/filters/filterRegistry.test.ts.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item", "sprint" RESTART IDENTITY CASCADE',
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

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

function isoDate(daysOffset: number): string {
  return daysFromNow(daysOffset).toISOString().slice(0, 10);
}

interface SeededProject {
  fx: WorkItemFixture;
  /** identifiers by handle */
  ids: Record<'bug' | 'board' | 'velocity' | 'polish', string>;
  memberId: string;
  sprintId: string;
}

/**
 * Four issues spanning every filterable axis (the `polish` row nests under
 * `velocity` so the tree comparison has hierarchy):
 *
 *   bug      — bug · todo · highest · member ·  due +3 · sp 5 · est 60 · "token refresh" desc
 *   board    — task · in_progress · medium · unassigned · due −5 · sp 2 · est ∅ · ∅ desc
 *   velocity — story · done · low · owner · due ∅ · sp ∅ · est 30 · "oauth scopes" desc
 *   polish   — task (child of velocity) · todo · high · unassigned · due +10 · in the sprint
 */
async function seedProject(): Promise<SeededProject> {
  const fx = await makeFixture();
  const member = await createTestUser({ name: 'Mo' });

  const bug = await createWorkItem(fx, { kind: 'bug', title: 'OAuth login crashes' });
  const board = await createWorkItem(fx, { kind: 'task', title: 'Board drag stutter' });
  const velocity = await createWorkItem(fx, { kind: 'story', title: 'Velocity chart' });
  const polish = await createWorkItem(fx, {
    kind: 'task',
    title: 'Chart polish pass',
    parentId: velocity.id,
  });

  const sprint = await db.sprint.create({
    data: { workspaceId: fx.workspaceId, projectId: fx.projectId, name: 'Sprint 1', sequence: 1 },
  });

  await db.workItem.update({
    where: { id: bug.id },
    data: {
      status: 'todo',
      priority: 'highest',
      assigneeId: member.id,
      dueDate: daysFromNow(3),
      storyPoints: 5,
      estimateMinutes: 60,
      descriptionMd: 'Stack trace points at the token refresh path.',
    },
  });
  await db.workItem.update({
    where: { id: board.id },
    data: { status: 'in_progress', priority: 'medium', dueDate: daysFromNow(-5), storyPoints: 2 },
  });
  await db.workItem.update({
    where: { id: velocity.id },
    data: {
      status: 'done',
      priority: 'low',
      assigneeId: fx.ownerId,
      estimateMinutes: 30,
      descriptionMd: 'Needs oauth scopes documented for the chart read.',
    },
  });
  await db.workItem.update({
    where: { id: polish.id },
    data: { status: 'todo', priority: 'high', dueDate: daysFromNow(10), sprintId: sprint.id },
  });

  return {
    fx,
    ids: {
      bug: bug.identifier,
      board: board.identifier,
      velocity: velocity.identifier,
      polish: polish.identifier,
    },
    memberId: member.id,
    sprintId: sprint.id,
  };
}

/** Run the flat List read under an AST and return the matched identifiers. */
async function listIdentifiers(seeded: SeededProject, ast: FilterAst): Promise<string[]> {
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

function and(...conditions: FilterAst['conditions']): FilterAst {
  return { combinator: 'and', conditions };
}
function or(...conditions: FilterAst['conditions']): FilterAst {
  return { combinator: 'or', conditions };
}

describe('the operator matrix compiles correctly (flat List, real Postgres)', () => {
  it('enum membership, negation-includes-empty, and the empty-bucket sentinels', async () => {
    const seeded = await seedProject();
    const { bug, board, velocity, polish } = seeded.ids;

    expect(
      await listIdentifiers(
        seeded,
        and({ field: 'status', operator: 'is_any_of', value: ['todo'] }),
      ),
    ).toEqual([bug, polish].sort());

    // none_of a member list INCLUDES the unassigned rows (the JQL-documented gap
    // the registry pins): board + polish are unassigned, velocity is the owner.
    expect(
      await listIdentifiers(
        seeded,
        and({ field: 'assignee', operator: 'is_none_of', value: [seeded.memberId] }),
      ),
    ).toEqual([board, polish, velocity].sort());

    // …but none_of WITH the sentinel excludes the empty bucket too.
    expect(
      await listIdentifiers(
        seeded,
        and({
          field: 'assignee',
          operator: 'is_none_of',
          value: [seeded.memberId, 'unassigned'],
        }),
      ),
    ).toEqual([velocity]);

    expect(
      await listIdentifiers(
        seeded,
        and({ field: 'assignee', operator: 'is_any_of', value: ['unassigned'] }),
      ),
    ).toEqual([board, polish].sort());

    expect(
      await listIdentifiers(
        seeded,
        and({ field: 'sprint', operator: 'is_any_of', value: ['backlog'] }),
      ),
    ).toEqual([board, bug, velocity].sort());
    expect(
      await listIdentifiers(
        seeded,
        and({ field: 'sprint', operator: 'is_any_of', value: [seeded.sprintId] }),
      ),
    ).toEqual([polish]);

    expect(
      await listIdentifiers(seeded, and({ field: 'assignee', operator: 'is_empty', value: null })),
    ).toEqual([board, polish].sort());
  });

  it('text contains/not_contains over title + description (NULL-safe)', async () => {
    const seeded = await seedProject();
    const { bug, board, velocity, polish } = seeded.ids;

    // 'oauth' hits the bug TITLE and the velocity DESCRIPTION.
    expect(
      await listIdentifiers(seeded, and({ field: 'text', operator: 'contains', value: 'oauth' })),
    ).toEqual([bug, velocity].sort());

    // not_contains keeps the NULL-description row (board) — NULL-safe negation.
    expect(
      await listIdentifiers(
        seeded,
        and({ field: 'text', operator: 'not_contains', value: 'oauth' }),
      ),
    ).toEqual([board, polish].sort());
  });

  it('number comparisons (ne excludes the empty bucket — the JQL != rule) and empties', async () => {
    const seeded = await seedProject();
    const { bug, board, velocity, polish } = seeded.ids;

    expect(
      await listIdentifiers(seeded, and({ field: 'storyPoints', operator: 'gte', value: 3 })),
    ).toEqual([bug]);
    expect(
      await listIdentifiers(seeded, and({ field: 'storyPoints', operator: 'ne', value: 2 })),
    ).toEqual([bug]); // velocity/polish are NULL → excluded, the documented rule
    expect(
      await listIdentifiers(
        seeded,
        and({ field: 'storyPoints', operator: 'is_empty', value: null }),
      ),
    ).toEqual([polish, velocity].sort());
    expect(
      await listIdentifiers(seeded, and({ field: 'estimate', operator: 'lt', value: 45 })),
    ).toEqual([velocity]);
    expect(
      await listIdentifiers(seeded, and({ field: 'estimate', operator: 'is_empty', value: null })),
    ).toEqual([board, polish].sort());
  });

  it('date operators: absolute, between, relative windows, empty', async () => {
    const seeded = await seedProject();
    const { bug, board, velocity, polish } = seeded.ids;

    expect(
      await listIdentifiers(
        seeded,
        and({ field: 'due', operator: 'on_or_before', value: isoDate(0) }),
      ),
    ).toEqual([board]);
    expect(
      await listIdentifiers(
        seeded,
        and({ field: 'due', operator: 'on_or_after', value: isoDate(0) }),
      ),
    ).toEqual([bug, polish].sort());
    expect(
      await listIdentifiers(
        seeded,
        and({ field: 'due', operator: 'between', value: [isoDate(-7), isoDate(5)] }),
      ),
    ).toEqual([board, bug].sort());
    expect(
      await listIdentifiers(seeded, and({ field: 'due', operator: 'in_last_days', value: 7 })),
    ).toEqual([board]);
    expect(
      await listIdentifiers(seeded, and({ field: 'due', operator: 'in_next_days', value: 7 })),
    ).toEqual([bug]);
    expect(
      await listIdentifiers(seeded, and({ field: 'due', operator: 'is_empty', value: null })),
    ).toEqual([velocity]);
    // created: everything was seeded just now.
    expect(
      await listIdentifiers(seeded, and({ field: 'created', operator: 'in_last_days', value: 1 })),
    ).toEqual([board, bug, polish, velocity].sort());
  });

  it('the and/or combinators', async () => {
    const seeded = await seedProject();
    const { bug, polish } = seeded.ids;

    expect(
      await listIdentifiers(
        seeded,
        or(
          { field: 'kind', operator: 'is_any_of', value: ['bug'] },
          { field: 'priority', operator: 'is_any_of', value: ['high'] },
        ),
      ),
    ).toEqual([bug, polish].sort());

    expect(
      await listIdentifiers(
        seeded,
        and(
          { field: 'status', operator: 'is_any_of', value: ['todo'] },
          { field: 'text', operator: 'contains', value: 'oauth' },
        ),
      ),
    ).toEqual([bug]);
  });

  it('the AST composes with the 2.5.4 facet axes (AND) and the count tracks it', async () => {
    const seeded = await seedProject();
    const page = await workItemsService.getProjectIssuesList(
      seeded.fx.projectId,
      {
        sort: SORT,
        filter: {
          kinds: ['bug', 'task'],
          ast: and({ field: 'status', operator: 'is_any_of', value: ['todo'] }),
        },
      },
      seeded.fx.ctx,
    );
    expect(page.items.map((i) => i.identifier).sort()).toEqual(
      [seeded.ids.bug, seeded.ids.polish].sort(),
    );
    expect(page.total).toBe(2);
  });
});

describe('one compiler, both views', () => {
  it('the flat List and the Tree produce identical match sets under the same AST', async () => {
    const seeded = await seedProject();
    const ast = and({ field: 'text', operator: 'contains', value: 'oauth' });

    const flat = await listIdentifiers(seeded, ast);
    const tree = await workItemsService.getProjectTree(seeded.fx.projectId, { ast }, seeded.fx.ctx);
    expect(matchedIdentifiers(tree)).toEqual(flat);
  });

  it('a deep match keeps its (unmatched, muted) ancestor chain — pruning is AST-aware', async () => {
    const seeded = await seedProject();
    // Matches ONLY the nested `polish` row (in the sprint).
    const ast = and({ field: 'sprint', operator: 'is_any_of', value: [seeded.sprintId] });
    const tree = await workItemsService.getProjectTree(seeded.fx.projectId, { ast }, seeded.fx.ctx);

    expect(matchedIdentifiers(tree)).toEqual([seeded.ids.polish]);
    // The parent survives pruning as a muted ancestor; unrelated roots are gone.
    const identifiers = tree.map((n) => n.identifier);
    expect(identifiers).toEqual([seeded.ids.velocity]);
    expect(tree[0]?.matched).toBe(false);
    expect(tree[0]?.children.map((c) => c.identifier)).toEqual([seeded.ids.polish]);
  });
});

describe('safety', () => {
  it('an unknown field/operator from the wire is a typed 422 at the service boundary', async () => {
    const seeded = await seedProject();
    await expect(
      workItemsService.getProjectIssuesList(
        seeded.fx.projectId,
        {
          sort: SORT,
          filter: {
            ast: {
              combinator: 'and',
              conditions: [{ field: 'watchers', operator: 'is_any_of', value: ['x'] }],
            } as unknown as FilterAst,
          },
        },
        seeded.fx.ctx,
      ),
    ).rejects.toThrow(UnknownFilterFieldError);
  });

  it('hostile values execute safely as bound parameters (behavioral fuzz)', async () => {
    const seeded = await seedProject();
    const payloads = [
      `'); DROP TABLE "work_item"; --`,
      `" OR 1=1 --`,
      `%' OR '%'='`,
      `$1; SELECT pg_sleep(10)`,
    ];
    for (const payload of payloads) {
      expect(
        await listIdentifiers(seeded, and({ field: 'text', operator: 'contains', value: payload })),
      ).toEqual([]);
      expect(
        await listIdentifiers(
          seeded,
          and({ field: 'status', operator: 'is_any_of', value: [payload] }),
        ),
      ).toEqual([]);
    }
    // The table is intact and the data still reads.
    expect(
      await listIdentifiers(seeded, and({ field: 'kind', operator: 'is_any_of', value: ['bug'] })),
    ).toEqual([seeded.ids.bug]);
  });

  it('a LIKE metacharacter in the text value matches literally (pattern escape)', async () => {
    const seeded = await seedProject();
    await db.workItem.update({
      where: { id: (await db.workItem.findFirst({ where: { title: 'Board drag stutter' } }))!.id },
      data: { descriptionMd: 'Reproduces 50%_of the time' },
    });
    expect(
      await listIdentifiers(seeded, and({ field: 'text', operator: 'contains', value: '50%_of' })),
    ).toEqual([seeded.ids.board]);
    expect(
      await listIdentifiers(seeded, and({ field: 'text', operator: 'contains', value: '50%x' })),
    ).toEqual([]);
  });
});

describe('the trgm index (finding #57)', () => {
  it('EXPLAIN shows the contains-match using the GIN index, not a table scan', async () => {
    const seeded = await seedProject();
    void seeded;
    const plan = await db.$transaction(async (tx) => {
      // The seeded table is tiny, so force the planner's hand — the assert is
      // "the index EXISTS and serves this predicate", not a cost decision.
      // (jit off: disabling seqscan inflates plan cost past the JIT threshold,
      // and the sandbox Postgres lacks the JIT library.)
      await tx.$executeRawUnsafe('SET LOCAL jit = off');
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN SELECT "id" FROM "work_item" w
          WHERE (w."title" ILIKE '%oauth%' OR w."descriptionMd" ILIKE '%oauth%')`,
      );
    });
    const planText = plan.map((row) => row['QUERY PLAN']).join('\n');
    expect(planText).toContain('work_item_title_descriptionMd_idx');
  });
});
