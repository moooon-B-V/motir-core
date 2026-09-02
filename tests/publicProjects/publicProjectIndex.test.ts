import { afterEach, describe, expect, it, vi } from 'vitest';

// `publicProjectsService.listPublicIndex` (MOTIR-4111) — the PAGING half of the
// crawl enumeration.
//
// ⚠️ WHY THE REPOSITORY IS MOCKED HERE, stated rather than left to be inferred.
// The repository read is one `findMany` with a `where`, an `orderBy` and a
// keyset `cursor`, and the property that matters about it — that the walk is
// ordered by `id` so it cannot reshuffle under a crawler — is a property of the
// QUERY, asserted against the source in
// `tests/api/public-crawl-surface-routes.test.ts`. What lives in the SERVICE and
// nowhere else is the over-fetch-and-trim: fetching `pageSize + 1` rows to learn
// whether a next page exists, trimming back, and choosing the cursor. That logic
// has three boundaries a real-database fixture would need three seeded
// populations to reach, and it is the same at every scale.
//
// The service methods around it that own real reads are tested against real
// Postgres in this same directory; this one owns none.

const listPublicIndexPage = vi.hoisted(() => vi.fn());

vi.mock('@/lib/repositories/projectRepository', () => ({
  projectRepository: { listPublicIndexPage },
}));

const { publicProjectsService } = await import('@/lib/services/publicProjectsService');

/** The page size the service asks for, minus the over-fetch row. */
const PAGE_SIZE = 200;

const row = (n: number) => ({
  id: `cmt_${String(n).padStart(4, '0')}`,
  identifier: `P${n}`,
  updatedAt: new Date('2026-08-30T00:00:00.000Z'),
});

afterEach(() => vi.clearAllMocks());

describe('listPublicIndex', () => {
  it('over-fetches by exactly one row', async () => {
    listPublicIndexPage.mockResolvedValue([]);

    await publicProjectsService.listPublicIndex();

    expect(listPublicIndexPage).toHaveBeenCalledWith({
      take: PAGE_SIZE + 1,
      cursor: undefined,
    });
  });

  it('a SHORT page is the last page — no cursor, nothing trimmed', async () => {
    listPublicIndexPage.mockResolvedValue([row(1), row(2)]);

    const page = await publicProjectsService.listPublicIndex();

    expect(page.projects).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
    expect(page.projects[0]).toEqual({
      identifier: 'P1',
      updatedAt: '2026-08-30T00:00:00.000Z',
    });
  });

  it('an EXACTLY-FULL page is still the last page — the off-by-one that matters', async () => {
    // `pageSize` rows came back when `pageSize + 1` were asked for, so there is
    // no next page. Reporting a cursor here would send the crawler round again
    // for an empty page every single time it walked the set.
    listPublicIndexPage.mockResolvedValue(
      Array.from({ length: PAGE_SIZE }, (_unused, i) => row(i)),
    );

    const page = await publicProjectsService.listPublicIndex();

    expect(page.projects).toHaveLength(PAGE_SIZE);
    expect(page.nextCursor).toBeNull();
  });

  it('an OVER-FULL page trims the extra row and cursors on the LAST KEPT one', async () => {
    // The trimmed row must not be reported, and the cursor must name the last
    // row the caller actually received — cursoring on the over-fetched row
    // would skip it on the next page, losing one project per page, silently.
    listPublicIndexPage.mockResolvedValue(
      Array.from({ length: PAGE_SIZE + 1 }, (_unused, i) => row(i)),
    );

    const page = await publicProjectsService.listPublicIndex();

    expect(page.projects).toHaveLength(PAGE_SIZE);
    expect(page.nextCursor).toBe(`cmt_${String(PAGE_SIZE - 1).padStart(4, '0')}`);
    expect(page.projects.at(-1)?.identifier).toBe(`P${PAGE_SIZE - 1}`);
  });

  it('passes a supplied cursor straight through', async () => {
    listPublicIndexPage.mockResolvedValue([]);

    await publicProjectsService.listPublicIndex('cmt_0042');

    expect(listPublicIndexPage).toHaveBeenCalledWith({
      take: PAGE_SIZE + 1,
      cursor: 'cmt_0042',
    });
  });

  it('serialises `updatedAt` as an ISO string — a Date does not survive the wire', async () => {
    listPublicIndexPage.mockResolvedValue([
      { id: 'cmt_1', identifier: 'P1', updatedAt: new Date('2026-01-02T03:04:05.678Z') },
    ]);

    const page = await publicProjectsService.listPublicIndex();

    expect(page.projects[0]?.updatedAt).toBe('2026-01-02T03:04:05.678Z');
  });

  it('never leaks the internal id into a ROW — it is the cursor, not a field', async () => {
    listPublicIndexPage.mockResolvedValue([row(1)]);

    const page = await publicProjectsService.listPublicIndex();

    expect(Object.keys(page.projects[0] ?? {}).sort()).toEqual(['identifier', 'updatedAt']);
  });
});
