import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { applyIdeaSeed } from './_helpers';

/**
 * The idea store's PUBLIC read arm (Story MOTIR-7662 · MOTIR-7677) — the evidence
 * `tests/rls/singleton-read-guard.test.ts`'s `public` verdicts cite for the
 * store's unbound reads.
 *
 * The public routes read with NO GUC bound (an anonymous visitor has no tenant
 * and no platform standing), and so do the staff reads outside a write. Every
 * one of them relies on the five tables' `<table>_read` policy admitting a row
 * with nothing set (`20261007100000_idea_store`). And the arm must be read-only:
 * a write with nothing bound is refused, because `app.platform_staff` is what
 * the write arm needs.
 */

async function asAppRole<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    // RLS is inert under the superuser (BYPASSRLS); the role switch is what
    // makes these assertions mean anything.
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  await applyIdeaSeed();
});

afterAll(async () => {
  await truncateAuthTables();
});

describe('the unbound read', () => {
  it('ADMITS ideas, their evidence and tags, the vocabulary and the run log with nothing bound', async () => {
    const owner = await createTestUser({ email: 'ops+ideas-rls@moooon.net' });
    await adminDb.ideaResearchRun.create({
      data: {
        actorUserId: owner.id,
        areasCovered: ['pets'],
        addedCount: 0,
        retiredCount: 0,
        reportMd: '# Run',
      },
    });

    const read = await asAppRole(async (tx) => ({
      ideas: await tx.idea.findMany({
        include: { evidence: true, tags: { include: { tag: true } } },
      }),
      counts: await tx.idea.groupBy({ by: ['category'], _count: { _all: true } }),
      tags: await tx.ideaTag.findMany({ include: { _count: { select: { assignments: true } } } }),
      runs: await tx.ideaResearchRun.findMany(),
    }));

    expect(read.ideas).toHaveLength(15);
    expect(
      read.ideas.filter((i) => i.kind === 'direction').every((i) => i.evidence.length === 1),
    ).toBe(true);
    expect(read.ideas.every((i) => i.tags.length > 0 && i.tags[0]!.tag.slug.length > 0)).toBe(true);
    expect(read.counts.length).toBeGreaterThan(0);
    expect(read.tags.length).toBeGreaterThanOrEqual(10);
    expect(read.runs).toHaveLength(1);
  });

  it('REFUSES a write with nothing bound — the arm is read-only', async () => {
    await expect(
      asAppRole((tx) =>
        tx.idea.update({
          where: { slug: 'the-ai-transparency-kit' },
          data: { pitch: 'Written with no standing.' },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      asAppRole((tx) => tx.ideaTag.create({ data: { slug: 'nope', label: 'Nope' } })),
    ).rejects.toThrow();
    const kit = await adminDb.idea.findUniqueOrThrow({
      where: { slug: 'the-ai-transparency-kit' },
    });
    expect(kit.pitch).not.toBe('Written with no standing.');
    expect(await adminDb.ideaTag.count({ where: { slug: 'nope' } })).toBe(0);
  });
});
