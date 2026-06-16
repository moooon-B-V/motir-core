import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectSquareService } from '@/lib/services/projectSquareService';
import {
  InvalidProjectSquareCategoryError,
  InvalidProjectSquareCursorError,
} from '@/lib/projectSquare/errors';
import { encodeRankedCursor } from '@/lib/projectSquare/rankCursor';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// Story 6.13 · Subtask 6.13.3 — the PROJECT SQUARE search + category/tag filter.
// Both NARROW the 6.13.2 cursored directory read (composing with the 6.13.4
// rank); neither opens a second query path. Real Postgres (no DB mocks); the
// truncate helper CASCADE-resets organization → workspace → project →
// project_tag_assignment between tests.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/**
 * Create a project (its own fresh org/workspace) with an explicit project NAME +
 * access level + optional public overview, and return its id. `makeWorkItemFixture`'s
 * `name` is the WORKSPACE name, so the project name is set directly here.
 */
async function makeProject(opts: {
  name: string;
  identifier: string;
  public?: boolean;
  overview?: string;
}): Promise<string> {
  const fx = await makeWorkItemFixture({ identifier: opts.identifier });
  await db.project.update({
    where: { id: fx.projectId },
    data: {
      name: opts.name,
      ...(opts.public ? { accessLevel: 'public' } : {}),
      ...(opts.overview !== undefined ? { publicOverviewMd: opts.overview } : {}),
    },
  });
  return fx.projectId;
}

/** Assign a curated tag (by slug) to a project, materializing the shared tag row. */
async function tagProject(projectId: string, slug: string, label: string): Promise<void> {
  const tag = await db.projectTag.upsert({
    where: { slug },
    create: { slug, label },
    update: {},
  });
  await db.projectTagAssignment.create({ data: { projectId, tagId: tag.id } });
}

/** The directory identifiers for a query, sorted so the assertion is rank-agnostic. */
async function idsFor(options: {
  search?: string;
  category?: string;
  rank?: string;
}): Promise<string[]> {
  const page = await projectSquareService.listDirectory(options);
  return page.items.map((i) => i.identifier).sort();
}

describe('projectSquareService.listDirectory — search narrowing (6.13.3)', () => {
  it('matches the project NAME, case-insensitively', async () => {
    await makeProject({ name: 'Alpha Tracker', identifier: 'ALP', public: true });
    await makeProject({ name: 'Beta Board', identifier: 'BET', public: true });

    expect(await idsFor({ search: 'alpha' })).toEqual(['ALP']);
    expect(await idsFor({ search: 'ALPHA' })).toEqual(['ALP']);
    // No search → the whole directory.
    expect(await idsFor({})).toEqual(['ALP', 'BET']);
  });

  it('matches the public OVERVIEW description when the name does not', async () => {
    await makeProject({
      name: 'Zenith',
      identifier: 'ZEN',
      public: true,
      overview: 'A delightful kanban experience for teams.',
    });
    await makeProject({
      name: 'Nadir',
      identifier: 'NAD',
      public: true,
      overview: 'Plain notes app.',
    });

    expect(await idsFor({ search: 'kanban' })).toEqual(['ZEN']);
  });

  it('never surfaces a non-public project even when its name matches', async () => {
    await makeProject({ name: 'Public Kanban', identifier: 'PUB', public: true });
    await makeProject({ name: 'Private Kanban', identifier: 'PRV' }); // non-public

    expect(await idsFor({ search: 'kanban' })).toEqual(['PUB']);
  });

  it('treats a blank / whitespace search as ABSENT (no empty-pattern match-all)', async () => {
    await makeProject({ name: 'One', identifier: 'ONE', public: true });
    await makeProject({ name: 'Two', identifier: 'TWO', public: true });

    expect(await idsFor({ search: '   ' })).toEqual(['ONE', 'TWO']);
  });

  it('escapes LIKE wildcards so `_` matches a literal underscore, not any char', async () => {
    await makeProject({ name: 'a_b config', identifier: 'AUB', public: true });
    await makeProject({ name: 'axb config', identifier: 'AXB', public: true });

    // Unescaped, `a_b` would ILIKE-match `axb` too; escaped, only the literal.
    expect(await idsFor({ search: 'a_b' })).toEqual(['AUB']);
  });
});

describe('projectSquareService.listDirectory — category/tag narrowing (6.13.3)', () => {
  it('narrows to the public projects carrying the tag', async () => {
    const x = await makeProject({ name: 'ML Studio', identifier: 'MLS', public: true });
    await tagProject(x, 'ai-ml', 'AI & Machine Learning');
    const y = await makeProject({ name: 'Insight', identifier: 'INS', public: true });
    await tagProject(y, 'ai-ml', 'AI & Machine Learning');
    const z = await makeProject({ name: 'Dashboards', identifier: 'DSH', public: true });
    await tagProject(z, 'analytics', 'Analytics');

    expect(await idsFor({ category: 'ai-ml' })).toEqual(['INS', 'MLS']);
    expect(await idsFor({ category: 'analytics' })).toEqual(['DSH']);
  });

  it('never surfaces a non-public project even when it carries the tag', async () => {
    const pub = await makeProject({ name: 'Public AI', identifier: 'PAI', public: true });
    await tagProject(pub, 'ai-ml', 'AI & Machine Learning');
    const priv = await makeProject({ name: 'Private AI', identifier: 'PRA' }); // not public
    await tagProject(priv, 'ai-ml', 'AI & Machine Learning');

    expect(await idsFor({ category: 'ai-ml' })).toEqual(['PAI']);
  });

  it('rejects a category outside the curated vocabulary with a 400-mapped error', async () => {
    await expect(
      projectSquareService.listDirectory({ category: 'not-a-real-topic' }),
    ).rejects.toBeInstanceOf(InvalidProjectSquareCategoryError);
  });
});

describe('projectSquareService.listDirectory — search + category COMPOSE under one read', () => {
  it('applies both predicates together', async () => {
    const hit = await makeProject({ name: 'Kanban AI', identifier: 'KAI', public: true });
    await tagProject(hit, 'ai-ml', 'AI & Machine Learning');

    // Matches the name but NOT the tag.
    const nameOnly = await makeProject({ name: 'Kanban Classic', identifier: 'KCL', public: true });
    await tagProject(nameOnly, 'analytics', 'Analytics');

    // Carries the tag but does NOT match the name.
    const tagOnly = await makeProject({ name: 'Vision Lab', identifier: 'VLB', public: true });
    await tagProject(tagOnly, 'ai-ml', 'AI & Machine Learning');

    expect(await idsFor({ search: 'kanban', category: 'ai-ml' })).toEqual(['KAI']);
  });
});

describe('projectSquareService.listDirectory — cursor pins the narrowing (6.13.3)', () => {
  it('rejects a cursor minted under a DIFFERENT search (changing the search restarts paging)', async () => {
    const cursor = encodeRankedCursor({
      rank: 'trending',
      window: 'week',
      score: 0,
      ts: null,
      id: 'abc123',
      search: 'foo',
      category: null,
    });
    await expect(
      projectSquareService.listDirectory({ rank: 'trending', search: 'bar', cursor }),
    ).rejects.toBeInstanceOf(InvalidProjectSquareCursorError);
  });

  it('rejects a cursor minted under a DIFFERENT category', async () => {
    const cursor = encodeRankedCursor({
      rank: 'trending',
      window: 'week',
      score: 0,
      ts: null,
      id: 'abc123',
      search: null,
      category: 'ai-ml',
    });
    await expect(
      projectSquareService.listDirectory({ rank: 'trending', category: 'analytics', cursor }),
    ).rejects.toBeInstanceOf(InvalidProjectSquareCursorError);
  });
});
