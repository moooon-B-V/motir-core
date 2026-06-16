import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectSquareService } from '@/lib/services/projectSquareService';
import { GET as exploreRoute } from '@/app/api/public/explore/route';
import { makeWorkItemFixture, createTestWorkItem } from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { truncateAuthTables } from '../helpers/db';
import type { ProjectSquareCardDto } from '@/lib/dto/projectSquare';

// Story 6.13 · Subtask 6.13.7 — the PROJECT SQUARE comprehensive guarantee
// suite. The per-subtask tests (6.13.2 directory, 6.13.3 search/tag, 6.13.4
// ranking, 6.13.5 tag-facet) each lock their own slice; THIS file locks the
// four LOAD-BEARING guarantees end-to-end, deliberately covering the
// cross-cutting properties the per-subtask tests leave at their seams:
//
//   1. the directory lists ONLY public projects, cross-org, and is FULLY PUBLIC
//      (an unauthenticated request through the real `/explore` route succeeds);
//   2. each rank is a DETERMINISTIC total order — the SAME input yields the SAME
//      order twice, with a stable id tiebreak on tied scores;
//   3. search + category/tag + the rank tab COMPOSE under one read, and a user
//      search string never reaches SQL unparameterized (the 6.1.1 posture);
//   4. cursor pagination skips/duplicates NO row, on EVERY rank, past the page
//      boundary.
//
// Real Postgres (the no-mocks rule); the truncate helper CASCADE-resets
// organization → workspace → project → work_item → public_request_vote between
// tests. `project_tag` rows are shared/system-level (no tenant FK) so they are
// cleared explicitly.

beforeEach(async () => {
  await truncateAuthTables();
  await db.projectTagAssignment.deleteMany();
  await db.projectTag.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

type WorkItemFx = Awaited<ReturnType<typeof makeWorkItemFixture>>;

/** Promote a project to `public`, optionally pinning the recency timestamps. */
async function makePublic(
  projectId: string,
  pins: { madePublicAt?: Date | null; createdAt?: Date } = {},
): Promise<void> {
  await db.project.update({
    where: { id: projectId },
    data: {
      accessLevel: 'public',
      ...(pins.madePublicAt !== undefined ? { madePublicAt: pins.madePublicAt } : {}),
      ...(pins.createdAt !== undefined ? { createdAt: pins.createdAt } : {}),
    },
  });
}

/**
 * A project (its OWN fresh org/workspace, so every call is a distinct org →
 * cross-org coverage) with an explicit project NAME + access level + optional
 * overview. `makeWorkItemFixture`'s `name` is the WORKSPACE name, so the project
 * name is set directly here.
 */
async function makeProject(opts: {
  name: string;
  identifier: string;
  access?: 'public' | 'open' | 'limited' | 'private';
  overview?: string;
}): Promise<WorkItemFx> {
  const fx = await makeWorkItemFixture({ identifier: opts.identifier });
  await db.project.update({
    where: { id: fx.projectId },
    data: {
      name: opts.name,
      accessLevel: opts.access ?? 'open',
      ...(opts.overview !== undefined ? { publicOverviewMd: opts.overview } : {}),
    },
  });
  return fx;
}

/** Record `count` upvotes (each a distinct voter) on a fresh request, stamped at `at`. */
async function addVotesAt(fx: WorkItemFx, count: number, at: Date): Promise<void> {
  const request = await createTestWorkItem(fx, { kind: 'task', title: 'a public request' });
  for (let i = 0; i < count; i++) {
    const voter = await createTestUser();
    await db.publicRequestVote.create({
      data: { workItemId: request.id, userId: voter.id, createdAt: at },
    });
  }
}

/** Assign a curated tag (by slug) to a project, materializing the shared tag row. */
async function tagProject(projectId: string, slug: string, label: string): Promise<void> {
  const tag = await db.projectTag.upsert({ where: { slug }, create: { slug, label }, update: {} });
  await db.projectTagAssignment.create({ data: { projectId, tagId: tag.id } });
}

const NOW = Date.now();
const days = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000);

/** Walk EVERY page of a rank over the keyset cursor, returning the identifiers in order. */
async function walkAllPages(rank: string): Promise<string[]> {
  const ordered: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await projectSquareService.listDirectory({ rank, cursor });
    expect(page.items.length).toBeLessThanOrEqual(24); // bounded read — never load-all
    ordered.push(...page.items.map((c) => c.identifier));
    pages++;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
    expect(pages).toBeLessThan(20); // guard against a non-terminating cursor
  }
  return ordered;
}

// ─────────────────────────────────────────────────────────────────────────────
// Guarantee 1 — lists ONLY public projects, cross-org, and is FULLY PUBLIC.
// ─────────────────────────────────────────────────────────────────────────────
describe('Project square · Guarantee 1 — public-only, cross-org, fully public', () => {
  it('lists every PUBLIC project across orgs and excludes EVERY non-public level', async () => {
    // Four distinct orgs (each fixture mints its own organization/workspace):
    // two public, plus one each of the three non-public levels.
    await makeProject({ name: 'Alpha', identifier: 'PUA', access: 'public' });
    await makeProject({ name: 'Bravo', identifier: 'PUB', access: 'public' });
    await makeProject({ name: 'Charlie', identifier: 'OPN', access: 'open' });
    await makeProject({ name: 'Delta', identifier: 'LIM', access: 'limited' });
    await makeProject({ name: 'Echo', identifier: 'PRV', access: 'private' });

    const page = await projectSquareService.listDirectory();
    const ids = page.items.map((c) => c.identifier).sort();

    // Both public projects appear — from DIFFERENT orgs, with no membership in
    // either (the read takes no actor; it is a system-level cross-org index).
    expect(ids).toEqual(['PUA', 'PUB']);
    // None of open / limited / private ever leaks, for anyone.
    for (const hidden of ['OPN', 'LIM', 'PRV']) {
      expect(page.items.some((c) => c.identifier === hidden)).toBe(false);
    }
  });

  it('returns ONLY the card projection — no internal project field crosses the wire', async () => {
    const fx = await makeProject({
      name: 'Projection Co',
      identifier: 'PRJ',
      access: 'public',
      overview: 'Readme.',
    });

    const page = await projectSquareService.listDirectory();
    const card = page.items.find((c) => c.identifier === 'PRJ')!;
    expect(card).toBeDefined();
    // EXACTLY the card-projection keys — the DTO structurally lacks workspaceId,
    // accessLevel, estimation config, and every other internal field. Asserted
    // at the payload level (the structural guarantee), not the DOM.
    expect(Object.keys(card as ProjectSquareCardDto).sort()).toEqual([
      'description',
      'identifier',
      'name',
      'org',
      'stats',
    ]);
    expect(Object.keys(card.org).sort()).toEqual(['name', 'slug']);
    expect(Object.keys(card.stats).sort()).toEqual(['lastActivityAt', 'upvotes']);
    // No reference to the seeding fixture's internal ids anywhere in the payload.
    expect(JSON.stringify(card)).not.toContain(fx.projectId);
    expect(JSON.stringify(card)).not.toContain(fx.workspaceId);
  });

  it('an UNAUTHENTICATED request to /explore succeeds and returns the same public list', async () => {
    await makeProject({ name: 'Open Source One', identifier: 'OS1', access: 'public' });
    await makeProject({ name: 'Open Source Two', identifier: 'OS2', access: 'public' });
    await makeProject({ name: 'Closed', identifier: 'CLS', access: 'limited' });

    // The route has NO getSession() call — a logged-out visitor / crawler reads
    // it. A bare Request with no cookies must succeed (no account gate to
    // reject it), and the page is identical to the service's public list.
    const res = await exploreRoute(new Request('http://localhost/api/public/explore'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: ProjectSquareCardDto[]; nextCursor: string | null };
    const ids = body.items.map((c) => c.identifier).sort();
    expect(ids).toEqual(['OS1', 'OS2']);
    expect(body.items.some((c) => c.identifier === 'CLS')).toBe(false);
  });

  it('an EMPTY directory (no public projects) returns an empty page, not an error', async () => {
    // Only non-public projects exist.
    await makeProject({ name: 'Hidden', identifier: 'HID', access: 'private' });

    const page = await projectSquareService.listDirectory();
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guarantee 2 — each rank is a DETERMINISTIC total order (same input twice).
// ─────────────────────────────────────────────────────────────────────────────
describe('Project square · Guarantee 2 — deterministic total order per rank', () => {
  it.each(['popular', 'recent', 'trending'] as const)(
    'the %s rank yields an IDENTICAL order across two reads, with a stable id tiebreak',
    async (rank) => {
      // Five public projects: TWO share a tied rank key (zero votes / same
      // made-public time) so the secondary `id` tiebreak decides their order —
      // and must decide it the SAME way every read.
      const tiedTs = new Date('2026-04-01T00:00:00.000Z');
      const a = await makeProject({ name: 'A', identifier: 'AAA', access: 'public' });
      await makePublic(a.projectId, { madePublicAt: tiedTs });
      const b = await makeProject({ name: 'B', identifier: 'BBB', access: 'public' });
      await makePublic(b.projectId, { madePublicAt: tiedTs }); // tied with A on `recent`
      const c = await makeProject({ name: 'C', identifier: 'CCC', access: 'public' });
      await makePublic(c.projectId, { madePublicAt: new Date('2026-05-01T00:00:00.000Z') });
      await addVotesAt(c, 3, days(0));
      const d = await makeProject({ name: 'D', identifier: 'DDD', access: 'public' });
      await makePublic(d.projectId, { madePublicAt: new Date('2026-03-01T00:00:00.000Z') });
      await addVotesAt(d, 3, days(0)); // tied with C on `popular`/`trending` (both 3)
      const e = await makeProject({ name: 'E', identifier: 'EEE', access: 'public' });
      await makePublic(e.projectId, { madePublicAt: new Date('2026-02-01T00:00:00.000Z') });
      await addVotesAt(e, 1, days(0));

      const first = (await projectSquareService.listDirectory({ rank })).items.map(
        (i) => i.identifier,
      );
      const second = (await projectSquareService.listDirectory({ rank })).items.map(
        (i) => i.identifier,
      );

      // A TOTAL order: every project, once.
      expect(first).toHaveLength(5);
      expect([...first].sort()).toEqual(['AAA', 'BBB', 'CCC', 'DDD', 'EEE']);
      // DETERMINISTIC: byte-for-byte identical across the two independent reads,
      // including how the tied pair was broken.
      expect(second).toEqual(first);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Guarantee 3 — search + category + rank COMPOSE; search is injection-safe.
// ─────────────────────────────────────────────────────────────────────────────
describe('Project square · Guarantee 3 — search + category + rank compose, safely', () => {
  it('search + category + the rank tab compose under one read, and the rank still orders', async () => {
    // Three public projects that match BOTH the name search and the tag, with
    // distinct vote totals so the `popular` rank imposes a known order.
    const hi = await makeProject({ name: 'Kanban High', identifier: 'KHI', access: 'public' });
    await tagProject(hi.projectId, 'ai-ml', 'AI & Machine Learning');
    await addVotesAt(hi, 3, days(0));
    const mid = await makeProject({ name: 'Kanban Mid', identifier: 'KMI', access: 'public' });
    await tagProject(mid.projectId, 'ai-ml', 'AI & Machine Learning');
    await addVotesAt(mid, 2, days(0));
    const lo = await makeProject({ name: 'Kanban Low', identifier: 'KLO', access: 'public' });
    await tagProject(lo.projectId, 'ai-ml', 'AI & Machine Learning');
    await addVotesAt(lo, 1, days(0));

    // Decoys that each fail exactly one predicate — none may survive the compose.
    const wrongTag = await makeProject({ name: 'Kanban X', identifier: 'KWT', access: 'public' });
    await tagProject(wrongTag.projectId, 'analytics', 'Analytics'); // matches name + public, wrong tag
    const wrongName = await makeProject({ name: 'Other', identifier: 'KWN', access: 'public' });
    await tagProject(wrongName.projectId, 'ai-ml', 'AI & Machine Learning'); // matches tag + public, wrong name
    const nonPublic = await makeProject({
      name: 'Kanban Hidden',
      identifier: 'KNP',
      access: 'limited',
    });
    await tagProject(nonPublic.projectId, 'ai-ml', 'AI & Machine Learning'); // matches name + tag, NOT public

    const page = await projectSquareService.listDirectory({
      search: 'kanban',
      category: 'ai-ml',
      rank: 'popular',
    });

    // Only the three that satisfy ALL of {name search, tag, public}, and the
    // `popular` rank still orders the narrowed set by lifetime upvotes desc.
    expect(page.items.map((i) => i.identifier)).toEqual(['KHI', 'KMI', 'KLO']);
    expect(page.items.map((i) => i.stats.upvotes)).toEqual([3, 2, 1]);
  });

  it('a blank search and an absent category narrow NOTHING (empty-search / empty-category)', async () => {
    await makeProject({ name: 'One', identifier: 'ON1', access: 'public' });
    await makeProject({ name: 'Two', identifier: 'TW2', access: 'public' });

    // A whitespace-only search must NOT compile an empty `ILIKE '%%'` match-all
    // narrowing — it is treated as ABSENT, so the whole directory returns.
    const blankSearch = await projectSquareService.listDirectory({ search: '   ' });
    expect(blankSearch.items.map((i) => i.identifier).sort()).toEqual(['ON1', 'TW2']);

    // An absent category likewise narrows nothing.
    const noCategory = await projectSquareService.listDirectory({ category: '  ' });
    expect(noCategory.items.map((i) => i.identifier).sort()).toEqual(['ON1', 'TW2']);
  });

  it('a search full of SQL / LIKE metacharacters is parameterized — matches literally, never errors or matches-all', async () => {
    // A project whose name contains the literal metacharacters, plus an innocent
    // bystander that must NOT be swept in by an unescaped wildcard.
    await makeProject({
      name: `Bobby '; DROP TABLE project; --`,
      identifier: 'INJ',
      access: 'public',
    });
    await makeProject({ name: 'Innocent Bystander', identifier: 'BYS', access: 'public' });

    // The exact metacharacter string is bound as a parameter (not concatenated),
    // so it matches its literal owner only — and the table obviously survives.
    const literal = await projectSquareService.listDirectory({
      search: `'; DROP TABLE project; --`,
    });
    expect(literal.items.map((i) => i.identifier)).toEqual(['INJ']);

    // A lone `%` is escaped to a literal percent — it matches NEITHER name (no
    // literal `%` in them), it does NOT behave as a match-all wildcard.
    const percent = await projectSquareService.listDirectory({ search: '%' });
    expect(percent.items).toEqual([]);

    // The directory is intact afterwards — no injection took effect.
    const all = await projectSquareService.listDirectory();
    expect(all.items.map((i) => i.identifier).sort()).toEqual(['BYS', 'INJ']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guarantee 4 — cursor pagination skips / duplicates NO row, on every rank.
// ─────────────────────────────────────────────────────────────────────────────
describe('Project square · Guarantee 4 — cursor pagination, no skip / no dupe, per rank', () => {
  it.each(['popular', 'recent', 'trending'] as const)(
    'walks every public project EXACTLY once past the page boundary on the %s rank',
    async (rank) => {
      // 27 public projects (> the 24-row page size → at least two pages). Each
      // gets a distinct made-public time AND a small, TIED-on-purpose vote total
      // (i % 4 → 0..3) so the score-keyset `id` tiebreak is exercised across the
      // boundary on the numeric ranks while the timestamp rank stays total.
      const COUNT = 27;
      const expected: string[] = [];
      for (let i = 0; i < COUNT; i++) {
        const id = `P${String(i).padStart(2, '0')}`;
        expected.push(id);
        const fx = await makeProject({ name: `Project ${i}`, identifier: id, access: 'public' });
        await makePublic(fx.projectId, { madePublicAt: days(i) });
        const votes = i % 4;
        if (votes > 0) await addVotesAt(fx, votes, days(0));
      }

      const ordered = await walkAllPages(rank);

      // Every public project surfaced EXACTLY once — no skip, no duplicate.
      expect(ordered).toHaveLength(COUNT);
      expect(new Set(ordered).size).toBe(COUNT);
      expect([...ordered].sort()).toEqual([...expected].sort());
    },
  );
});
