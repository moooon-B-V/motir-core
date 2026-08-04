import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { DEFAULT_SORT, ISSUE_LIST_PAGE_SIZE } from '@/lib/issues/issueListView';
import { MAX_PAGE_LIMIT } from '@/lib/api/v1/pagination';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { truncateAuthTables } from '../../helpers/db';

// The KEYSET-paged project work-item read (Story 11.2 · Subtask 11.2.3 —
// MOTIR-2041), against REAL Postgres.
//
// The load-bearing assertions here are the two a static-fixture pagination test
// structurally cannot make: that the SET matches the offset read walked to
// exhaustion (the one-grammar contract, at the data layer), and that a
// CONCURRENT write during a scan neither skips nor duplicates a row. ADR §5:
// "a pagination test that only walks a static fixture has not tested pagination".

/** Walk the keyset read to exhaustion, returning every identifier seen. */
async function walkKeyset(
  fx: WorkItemFixture,
  opts: {
    limit: number;
    filter?: Parameters<typeof workItemsService.listProjectWorkItemsPage>[1]['filter'];
  },
  onPage?: (pageIndex: number) => Promise<void>,
): Promise<string[]> {
  const seen: string[] = [];
  let after: { createdAt: Date; id: string } | undefined;
  for (let page = 0; page < 200; page++) {
    const result = await workItemsService.listProjectWorkItemsPage(
      fx.projectId,
      {
        limit: opts.limit,
        ...(after ? { after } : {}),
        ...(opts.filter ? { filter: opts.filter } : {}),
      },
      fx.ctx,
    );
    seen.push(...result.items.map((i) => i.identifier));
    if (!result.hasMore) return seen;
    const last = result.items[result.items.length - 1];
    if (!last) return seen;
    after = { createdAt: last.createdAt, id: last.id };
    if (onPage) await onPage(page);
  }
  throw new Error('keyset walk did not terminate');
}

/** Walk the SHIPPED offset read to exhaustion — the set the API must match. */
async function walkOffset(
  fx: WorkItemFixture,
  filter?: Parameters<typeof workItemsService.getProjectIssuesList>[1]['filter'],
): Promise<string[]> {
  const seen: string[] = [];
  for (let page = 1; page <= 200; page++) {
    const result = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT, ...(filter ? { filter } : {}), page, pageSize: ISSUE_LIST_PAGE_SIZE },
      fx.ctx,
    );
    seen.push(...result.items.map((i) => i.identifier));
    if (page * ISSUE_LIST_PAGE_SIZE >= result.total) return seen;
  }
  throw new Error('offset walk did not terminate');
}

describe('listProjectWorkItemsPage — the keyset read', () => {
  let fx: WorkItemFixture;

  beforeEach(async () => {
    await truncateAuthTables();
    fx = await makeWorkItemFixture();
  });

  async function seed(count: number, prefix = 'Item'): Promise<void> {
    for (let i = 0; i < count; i++) {
      await createTestWorkItem(fx, { kind: 'task', title: `${prefix} ${i}` });
    }
  }

  it('returns the SAME SET as the offset read walked to exhaustion (one grammar)', async () => {
    await seed(12);

    const keyset = await walkKeyset(fx, { limit: 5 });
    const offset = await walkOffset(fx);

    expect(keyset).toHaveLength(12);
    // SETS, not sequences — the two reads order differently ON PURPOSE, and it
    // is the membership that is the contract.
    expect([...keyset].sort()).toEqual([...offset].sort());
  });

  it('matches the offset read for an AST filter too, across a built-in and a label axis', async () => {
    const bug = await createTestWorkItem(fx, { kind: 'bug', title: 'A bug' });
    await createTestWorkItem(fx, { kind: 'task', title: 'A task' });
    await createTestWorkItem(fx, { kind: 'story', title: 'A story' });

    const filter = {
      ast: {
        combinator: 'and' as const,
        conditions: [{ field: 'kind' as const, operator: 'is_any_of' as const, value: ['bug'] }],
      },
    };

    const keyset = await walkKeyset(fx, { limit: 1, filter });
    const offset = await walkOffset(fx, filter);

    expect(keyset).toEqual([bug.identifier]);
    expect([...keyset].sort()).toEqual([...offset].sort());
  });

  // ⚠️ THE assertion ADR §5 exists for.
  it('a CONCURRENT INSERT mid-scan never skips or duplicates an original row', async () => {
    await seed(9, 'Original');
    const originals = (await walkKeyset(fx, { limit: 100 })).slice();
    expect(originals).toHaveLength(9);

    let inserted = 0;
    const seen = await walkKeyset(fx, { limit: 3 }, async () => {
      // Insert a row whose position sorts BEFORE the cursor — the case that
      // makes an OFFSET pager skip a row, because every later page shifts by one.
      if (inserted >= 2) return;
      const row = await createTestWorkItem(fx, { kind: 'task', title: `Injected ${inserted}` });
      await db.workItem.update({
        where: { id: row.id },
        data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
      });
      inserted += 1;
    });

    expect(inserted).toBe(2);
    // Every ORIGINAL row seen EXACTLY once. (The injected rows sort before the
    // cursor, so they are legitimately not seen — they were never on an earlier
    // page under this order.)
    for (const identifier of originals) {
      expect(
        seen.filter((s) => s === identifier),
        `${identifier} must be seen exactly once`,
      ).toHaveLength(1);
    }
    expect(new Set(seen).size, 'no duplicates at all').toBe(seen.length);
  });

  it('a DELETE mid-scan does not shift a later page onto rows already seen', async () => {
    await seed(9, 'Row');
    const all = await walkKeyset(fx, { limit: 100 });

    let removed = 0;
    const seen = await walkKeyset(fx, { limit: 3 }, async () => {
      if (removed > 0) return;
      // Remove a row from the FIRST page — an offset pager would slide the
      // whole tail forward and re-show a row that was already returned.
      const victim = all[0] as string;
      await db.workItem.deleteMany({ where: { identifier: victim, projectId: fx.projectId } });
      removed += 1;
    });

    expect(removed).toBe(1);
    expect(new Set(seen).size, 'no row is returned twice').toBe(seen.length);
  });

  it('reports "no more" on the last page — no extra empty round trip', async () => {
    await seed(6);

    const page = await workItemsService.listProjectWorkItemsPage(
      fx.projectId,
      { limit: 6 },
      fx.ctx,
    );

    expect(page.items).toHaveLength(6);
    expect(page.hasMore, 'a full-but-final page must not claim more').toBe(false);
  });

  it('a cursor PAST THE TAIL is an empty page, not an error', async () => {
    await seed(3);

    const page = await workItemsService.listProjectWorkItemsPage(
      fx.projectId,
      { limit: 10, after: { createdAt: new Date(Date.now() + 86_400_000), id: 'zzzz' } },
      fx.ctx,
    );

    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('an empty project is an empty page, never an error', async () => {
    const page = await workItemsService.listProjectWorkItemsPage(
      fx.projectId,
      { limit: 10 },
      fx.ctx,
    );
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  // ── The ceiling: 100, NOT the List's 50 ───────────────────────────────────
  it('honours a limit ABOVE the List cap — the read is not capped at 50', async () => {
    await seed(60);

    const page = await workItemsService.listProjectWorkItemsPage(
      fx.projectId,
      { limit: 100 },
      fx.ctx,
    );

    expect(ISSUE_LIST_PAGE_SIZE).toBe(50); // the cap this read deliberately ignores
    expect(page.items.length, 'a 100-row page must not be clamped to 50').toBe(60);
    expect(page.hasMore).toBe(false);
  });

  it('clamps a limit above the v1 ceiling rather than erroring', async () => {
    await seed(3);

    const page = await workItemsService.listProjectWorkItemsPage(
      fx.projectId,
      { limit: MAX_PAGE_LIMIT + 500 },
      fx.ctx,
    );

    expect(page.items).toHaveLength(3);
  });

  it('leaves the List view UNCHANGED — the 50-row clamp still applies there', async () => {
    await seed(60);

    const list = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT, pageSize: 100 },
      fx.ctx,
    );

    // This card raises NO existing cap: asking the shipped read for 100 still
    // yields 50, exactly as before.
    expect(list.items).toHaveLength(ISSUE_LIST_PAGE_SIZE);
    expect(list.pageSize).toBe(ISSUE_LIST_PAGE_SIZE);
  });

  // ── The gates this method carries itself ──────────────────────────────────
  it('a cross-workspace projectId raises ProjectNotFoundError (no existence leak)', async () => {
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });

    await expect(
      workItemsService.listProjectWorkItemsPage(other.projectId, { limit: 10 }, fx.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('a caller who cannot browse the project is refused', async () => {
    const stranger = await createTestUser();

    await expect(
      workItemsService.listProjectWorkItemsPage(
        fx.projectId,
        { limit: 10 },
        {
          userId: stranger.id,
          workspaceId: fx.workspaceId,
        },
      ),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
  });

  it('never returns an ARCHIVED or TRIAGE row — the same exclusions as the List', async () => {
    const live = await createTestWorkItem(fx, { kind: 'task', title: 'Live' });
    const archived = await createTestWorkItem(fx, { kind: 'task', title: 'Archived' });
    const triaged = await createTestWorkItem(fx, { kind: 'task', title: 'In triage' });
    await db.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    await db.workItem.update({ where: { id: triaged.id }, data: { triagedAt: new Date() } });

    const seen = await walkKeyset(fx, { limit: 50 });

    expect(seen).toEqual([live.identifier]);
  });

  it('binds a filter VALUE as a parameter — an injection probe matches nothing', async () => {
    await createTestWorkItem(fx, { kind: 'task', title: 'Real row' });

    const seen = await walkKeyset(fx, {
      limit: 50,
      filter: { text: "' OR 1=1 --" },
    });

    // Bound, not interpolated: the probe is matched as literal text, so it finds
    // nothing rather than returning the whole table.
    expect(seen).toEqual([]);
  });
});

describe('findProjectIssuesKeyset — the repository read', () => {
  let fx: WorkItemFixture;

  beforeEach(async () => {
    await truncateAuthTables();
    fx = await makeWorkItemFixture();
  });

  it('fetches limit + 1 rows, so "has more" needs no COUNT', async () => {
    for (let i = 0; i < 5; i++) {
      await createTestWorkItem(fx, { kind: 'task', title: `T${i}` });
    }

    const rows = await workItemRepository.findProjectIssuesKeyset(
      fx.projectId,
      fx.workspaceId,
      {},
      { limit: 3 },
    );

    expect(rows).toHaveLength(4); // 3 + the probe row
  });

  it('orders by (createdAt, id) — a TOTAL order, unambiguous when stamps collide', async () => {
    const collide = new Date('2026-08-03T10:00:00.000Z');
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createTestWorkItem(fx, { kind: 'task', title: 'C' });
    await db.workItem.updateMany({
      where: { id: { in: [a.id, b.id, c.id] } },
      data: { createdAt: collide },
    });

    const rows = await workItemRepository.findProjectIssuesKeyset(
      fx.projectId,
      fx.workspaceId,
      {},
      { limit: 10 },
    );

    // Identical timestamps, so `id` decides — and the order is stable.
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([...ids].sort());

    // Paging through the collision must still see each row exactly once.
    const first = await workItemRepository.findProjectIssuesKeyset(
      fx.projectId,
      fx.workspaceId,
      {},
      { limit: 1 },
    );
    const head = first[0];
    expect(head).toBeDefined();
    const rest = await workItemRepository.findProjectIssuesKeyset(
      fx.projectId,
      fx.workspaceId,
      {},
      { limit: 10, after: { createdAt: head!.createdAt, id: head!.id } },
    );
    expect(rest.map((r) => r.id)).not.toContain(head!.id);
    expect(rest).toHaveLength(2);
  });

  it('shares its predicate with the flat read — one compiled WHERE, not two', async () => {
    // Structural: both reads route through `projectIssuesScopeSql`, so a
    // condition added to the shared builder changes BOTH. Asserted at the source
    // because "these two queries agree" is a claim about which code exists —
    // and the behavioural half is the set-parity test above.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(`${process.cwd()}/lib/repositories/workItemRepository.ts`, 'utf8');

    const usages = source.match(/projectIssuesScopeSql\(projectId, workspaceId, filter\)/g) ?? [];
    expect(usages.length, 'both the flat and keyset reads use the shared predicate').toBe(2);
    // And neither re-expresses the tenant gate inline.
    const keysetBody = source.slice(
      source.indexOf('async findProjectIssuesKeyset('),
      source.indexOf('\n  },', source.indexOf('async findProjectIssuesKeyset(')),
    );
    expect(keysetBody).not.toContain('w."archivedAt" IS NULL');
  });
});
