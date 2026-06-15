import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { publicRequestVoteRepository } from '@/lib/repositories/publicRequestVoteRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectSquareService } from '@/lib/services/projectSquareService';
import { decodeDirectoryCursor, encodeDirectoryCursor } from '@/lib/projectSquare/cursor';
import { InvalidProjectSquareCursorError } from '@/lib/projectSquare/errors';
import { makeWorkItemFixture, createTestWorkItem } from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { truncateAuthTables } from '../helpers/db';
import type { ProjectDirectoryCursor } from '@/lib/repositories/projectRepository';

// Story 6.13 · Subtask 6.13.2 — the PROJECT SQUARE directory: the cross-org
// list of every `public` project, cursor-paginated, card-projection,
// EXCLUDING every non-public project. Real Postgres (no DB mocks); the truncate
// helper CASCADE-resets organization → workspace → project → work_item →
// public_request_vote between tests.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Make `fx`'s project `public` (optionally authoring a public overview). */
async function makePublic(projectId: string, overviewMd: string | null = null): Promise<void> {
  await db.project.update({
    where: { id: projectId },
    data: { accessLevel: 'public', publicOverviewMd: overviewMd },
  });
}

/** Record `count` upvotes on a fresh public-request work item in the project. */
async function addUpvotes(fx: Awaited<ReturnType<typeof makeWorkItemFixture>>, count: number) {
  const request = await createTestWorkItem(fx, { kind: 'task', title: 'a public request' });
  for (let i = 0; i < count; i++) {
    const voter = await createTestUser();
    await db.publicRequestVote.create({ data: { workItemId: request.id, userId: voter.id } });
  }
}

describe('projectSquareService.listDirectory — the public directory', () => {
  it('lists ONLY public projects across orgs and EXCLUDES every non-public one', async () => {
    // Org/workspace A: one public + one non-public project.
    const aPublic = await makeWorkItemFixture({ name: 'Org A', identifier: 'AAA' });
    await makePublic(aPublic.projectId, 'The A project README.');
    // A second project in org A, left at the default `open` level (non-public).
    await makeWorkItemFixture({ name: 'Org A two', identifier: 'APV' });

    // A second org/workspace (createTestWorkspace mints its own organization),
    // with another public project — proving the read is cross-org.
    const bPublic = await makeWorkItemFixture({ name: 'Org B', identifier: 'BBB' });
    await makePublic(bPublic.projectId, 'The B project README.');
    // A `limited` project in org B — also non-public, also excluded.
    const bLimited = await makeWorkItemFixture({ name: 'Org B two', identifier: 'BLM' });
    await db.project.update({
      where: { id: bLimited.projectId },
      data: { accessLevel: 'limited' },
    });

    const page = await projectSquareService.listDirectory();

    const identifiers = page.items.map((c) => c.identifier).sort();
    expect(identifiers).toEqual(['AAA', 'BBB']);
    // The non-public projects never appear, for anyone.
    expect(page.items.some((c) => c.identifier === 'APV')).toBe(false);
    expect(page.items.some((c) => c.identifier === 'BLM')).toBe(false);
    // Under the page size → a single page, no continuation.
    expect(page.nextCursor).toBeNull();
  });

  it('returns ONLY the card projection — no internal project field crosses the wire', async () => {
    const fx = await makeWorkItemFixture({ name: 'Proj Co', identifier: 'PRJ' });
    await makePublic(fx.projectId, 'Readme body.');

    const page = await projectSquareService.listDirectory();
    const card = page.items.find((c) => c.identifier === 'PRJ');
    expect(card).toBeDefined();

    // The payload carries EXACTLY the card-projection keys — no workspaceId, no
    // accessLevel, no estimation config, no internal field (asserted at the
    // payload level, not the DOM).
    expect(Object.keys(card!).sort()).toEqual([
      'description',
      'identifier',
      'name',
      'org',
      'stats',
    ]);
    expect(Object.keys(card!.org).sort()).toEqual(['name', 'slug']);
    expect(Object.keys(card!.stats).sort()).toEqual(['lastActivityAt', 'upvotes']);
    // The org (the cross-org context) is present and non-empty.
    expect(card!.org.name.length).toBeGreaterThan(0);
    expect(card!.org.slug.length).toBeGreaterThan(0);
  });

  it('surfaces the public demand stats: total upvotes + a recent-activity timestamp', async () => {
    const fx = await makeWorkItemFixture({ name: 'Stats Co', identifier: 'STS' });
    await makePublic(fx.projectId, null);
    await addUpvotes(fx, 3);

    const page = await projectSquareService.listDirectory();
    const card = page.items.find((c) => c.identifier === 'STS')!;

    expect(card.stats.upvotes).toBe(3);
    // The public-request work item gives the project recent activity → an ISO ts.
    expect(card.stats.lastActivityAt).not.toBeNull();
    expect(() => new Date(card.stats.lastActivityAt!).toISOString()).not.toThrow();
    // No overview authored → no description snippet.
    expect(card.description).toBeNull();
  });

  it('defaults stats to 0 / null for a public project with no votes or work items', async () => {
    const fx = await makeWorkItemFixture({ name: 'Quiet Co', identifier: 'QUI' });
    await makePublic(fx.projectId, '   ');
    // No work items, no votes.

    const page = await projectSquareService.listDirectory();
    const card = page.items.find((c) => c.identifier === 'QUI')!;
    expect(card.stats.upvotes).toBe(0);
    expect(card.stats.lastActivityAt).toBeNull();
    // A blank-only overview collapses to no description.
    expect(card.description).toBeNull();
  });

  it('truncates a long overview into a bounded description snippet', async () => {
    const fx = await makeWorkItemFixture({ name: 'Long Co', identifier: 'LNG' });
    const long = 'word '.repeat(100); // ~500 chars
    await makePublic(fx.projectId, long);

    const page = await projectSquareService.listDirectory();
    const card = page.items.find((c) => c.identifier === 'LNG')!;
    expect(card.description).not.toBeNull();
    expect(card.description!.length).toBeLessThanOrEqual(201); // 200 + the ellipsis
    expect(card.description!.endsWith('…')).toBe(true);
  });
});

describe('projectSquareService.listDirectory — cursor pagination boundary', () => {
  it('pages the full set across the page boundary with no skipped or duplicated row', async () => {
    // 26 public projects (each its own workspace/org) → more than the 24-row
    // page size, so the directory must paginate.
    for (let i = 0; i < 26; i++) {
      const fx = await makeWorkItemFixture({
        name: `Many ${i}`,
        identifier: `M${String(i).padStart(2, '0')}`,
      });
      await makePublic(fx.projectId);
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await projectSquareService.listDirectory({ cursor });
      pages++;
      for (const c of page.items) {
        expect(seen.has(c.identifier)).toBe(false); // no duplicate across pages
        seen.add(c.identifier);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      expect(pages).toBeLessThan(10); // guard against a non-terminating cursor
    }

    expect(seen.size).toBe(26); // every public project surfaced exactly once
    expect(pages).toBe(2); // 24 + 2
  });
});

describe('projectRepository.listPublicDirectory — keyset determinism', () => {
  it('keyset-walks every public project once, even on tied createdAt timestamps', async () => {
    // Five public projects; force two to share an identical createdAt so the
    // `id` tiebreak branch of the keyset is exercised.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const fx = await makeWorkItemFixture({ name: `K${i}`, identifier: `K0${i}` });
      await makePublic(fx.projectId);
      ids.push(fx.projectId);
    }
    const tied = new Date('2026-01-01T00:00:00.000Z');
    await db.project.update({ where: { id: ids[0]! }, data: { createdAt: tied } });
    await db.project.update({ where: { id: ids[1]! }, data: { createdAt: tied } });

    const seen = new Set<string>();
    let cursor: ProjectDirectoryCursor | undefined;
    for (;;) {
      const rows = await projectRepository.listPublicDirectory({ take: 1, cursor });
      if (rows.length === 0) break;
      const row = rows[0]!;
      expect(seen.has(row.id)).toBe(false);
      seen.add(row.id);
      cursor = { createdAt: row.createdAt, id: row.id };
      if (seen.size > 5) break; // guard
    }
    expect(seen.size).toBe(5);
  });
});

describe('project-square cursor codec', () => {
  it('round-trips a keyset position', () => {
    const c: ProjectDirectoryCursor = {
      createdAt: new Date('2026-06-14T12:00:00.000Z'),
      id: 'abc123',
    };
    const decoded = decodeDirectoryCursor(encodeDirectoryCursor(c));
    expect(decoded.id).toBe('abc123');
    expect(decoded.createdAt.toISOString()).toBe('2026-06-14T12:00:00.000Z');
  });

  it('throws InvalidProjectSquareCursorError on a malformed token', () => {
    expect(() => decodeDirectoryCursor('not-a-valid-cursor')).toThrow(
      InvalidProjectSquareCursorError,
    );
    // A well-formed base64url of a non-cursor string (no separator).
    const bad = Buffer.from('justtext', 'utf8').toString('base64url');
    expect(() => decodeDirectoryCursor(bad)).toThrow(InvalidProjectSquareCursorError);
    // A separator but an unparseable date.
    const badDate = Buffer.from('notadate|abc', 'utf8').toString('base64url');
    expect(() => decodeDirectoryCursor(badDate)).toThrow(InvalidProjectSquareCursorError);
  });

  it('rejects a malformed cursor at the service boundary', async () => {
    await expect(projectSquareService.listDirectory({ cursor: 'garbage' })).rejects.toBeInstanceOf(
      InvalidProjectSquareCursorError,
    );
  });
});

describe('stat-aggregate empty-input guards', () => {
  it('short-circuit to [] on an empty project-id set', async () => {
    expect(await publicRequestVoteRepository.sumUpvotesByProjects([])).toEqual([]);
    expect(await workItemRepository.maxActivityByProjects([])).toEqual([]);
  });
});
