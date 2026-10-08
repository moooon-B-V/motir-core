import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The idea store's SCHEMA (Story MOTIR-7662 · MOTIR-7670) — the constraints the
 * services lean on, proven against real Postgres rather than assumed from the
 * datamodel: the retired-fields CHECK in both directions, the two uniques, the
 * cascades from an idea, and the Restrict that keeps a tag in use alive.
 */

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
});

function idea(slug: string, extra: Record<string, unknown> = {}) {
  return adminDb.idea.create({
    data: {
      slug,
      title: `Idea ${slug}`,
      pitch: 'A pitch.',
      kind: 'direction',
      category: 'ecommerce',
      capabilities: ['one', 'two'],
      ...extra,
    },
  });
}

describe('the retired-fields CHECK', () => {
  it('refuses a retired idea with no reason', async () => {
    await expect(
      idea('retired-no-reason', { status: 'retired', retiredAt: new Date() }),
    ).rejects.toThrow(/idea_retired_fields_check/);
  });

  it('refuses a retired idea with no retirement moment', async () => {
    await expect(
      idea('retired-no-moment', { status: 'retired', retiredReason: 'Superseded' }),
    ).rejects.toThrow(/idea_retired_fields_check/);
  });

  it('refuses an active idea that carries a reason', async () => {
    await expect(idea('active-with-reason', { retiredReason: 'Stale' })).rejects.toThrow(
      /idea_retired_fields_check/,
    );
  });

  it('accepts an active idea with neither and a retired one with both', async () => {
    await idea('plain-active');
    const retired = await idea('properly-retired', {
      status: 'retired',
      retiredReason: 'The market moved',
      retiredAt: new Date(),
    });
    expect(retired.status).toBe('retired');
    expect(await adminDb.idea.count()).toBe(2);
  });
});

describe('uniqueness', () => {
  it('holds the slug unique', async () => {
    await idea('same-slug');
    await expect(idea('same-slug')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('holds (ideaId, position) unique on evidence', async () => {
    const row = await idea('with-evidence');
    const evidence = {
      ideaId: row.id,
      position: 0,
      claim: 'A claim.',
      sourceName: 'A source',
      url: 'https://example.com/a',
    };
    await adminDb.ideaEvidence.create({ data: evidence });
    await expect(adminDb.ideaEvidence.create({ data: evidence })).rejects.toMatchObject({
      code: 'P2002',
    });
  });
});

describe('delete rules', () => {
  it('cascades an idea delete to its evidence and tag assignments', async () => {
    const row = await idea('to-delete');
    const tag = await adminDb.ideaTag.create({ data: { slug: 'smb', label: 'SMB' } });
    await adminDb.ideaEvidence.create({
      data: { ideaId: row.id, position: 0, claim: 'c', sourceName: 's', url: 'https://x.test' },
    });
    await adminDb.ideaTagAssignment.create({ data: { ideaId: row.id, tagId: tag.id } });

    await adminDb.idea.delete({ where: { id: row.id } });

    expect(await adminDb.ideaEvidence.count()).toBe(0);
    expect(await adminDb.ideaTagAssignment.count()).toBe(0);
    expect(await adminDb.ideaTag.count()).toBe(1);
  });

  it('refuses to delete a tag that is still in use', async () => {
    const row = await idea('tagged');
    const tag = await adminDb.ideaTag.create({ data: { slug: 'consumer', label: 'Consumer' } });
    await adminDb.ideaTagAssignment.create({ data: { ideaId: row.id, tagId: tag.id } });

    await expect(adminDb.ideaTag.delete({ where: { id: tag.id } })).rejects.toThrow();
    expect(await adminDb.ideaTag.count()).toBe(1);
  });

  it('accepts `idea` as a platform audit target kind', async () => {
    // Writing a row proves the migration added the value to the DATABASE
    // enum, not just to the datamodel. Truncated with `user` after the test.
    const actor = await adminDb.user.create({
      data: { email: 'ops+schema@moooon.net', name: 'Ops', platformRole: 'operator' },
    });
    const row = await adminDb.platformAuditLog.create({
      data: {
        seq: 1,
        entryHash: 'x'.repeat(64),
        actorUserId: actor.id,
        actorRole: 'operator',
        action: 'idea.add',
        targetKind: 'idea',
        targetId: 'idea-id',
        createdAt: new Date(),
      },
    });
    expect(row.targetKind).toBe('idea');
  });
});
