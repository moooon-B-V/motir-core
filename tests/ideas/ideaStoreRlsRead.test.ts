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

describe('the translation tables (Story MOTIR-7772 · MOTIR-7773)', () => {
  // The three tables copy the idea tables' posture (`20261009200000_idea_translations`):
  // an unconditional read arm and a write arm behind `app.platform_staff`.
  async function seedTranslations() {
    const kit = await adminDb.idea.findUniqueOrThrow({
      where: { slug: 'the-ai-transparency-kit' },
      include: { evidence: true, tags: true },
    });
    await adminDb.ideaTranslation.create({ data: { ideaId: kit.id, locale: 'ja', title: '題' } });
    if (kit.evidence[0]) {
      await adminDb.ideaEvidenceTranslation.create({
        data: { evidenceId: kit.evidence[0].id, locale: 'ja', claim: '主張' },
      });
    }
    await adminDb.ideaTagTranslation.create({
      data: { tagId: kit.tags[0]!.tagId, locale: 'ja', label: 'ラベル' },
    });
    return kit;
  }

  it('ADMITS every translation row with nothing bound', async () => {
    const kit = await seedTranslations();
    const read = await asAppRole(async (tx) => ({
      ideas: await tx.ideaTranslation.count(),
      evidence: await tx.ideaEvidenceTranslation.count(),
      tags: await tx.ideaTagTranslation.count(),
    }));
    expect(read).toEqual({ ideas: 1, evidence: kit.evidence.length > 0 ? 1 : 0, tags: 1 });
  });

  it('REFUSES a translation write with nothing bound, and ADMITS it under app.platform_staff', async () => {
    const kit = await seedTranslations();
    await expect(
      asAppRole((tx) =>
        tx.ideaTranslation.create({ data: { ideaId: kit.id, locale: 'ko', title: '제목' } }),
      ),
    ).rejects.toThrow();
    await expect(
      asAppRole((tx) =>
        tx.ideaTagTranslation.create({
          data: { tagId: kit.tags[0]!.tagId, locale: 'ko', label: '라벨' },
        }),
      ),
    ).rejects.toThrow();
    expect(await adminDb.ideaTranslation.count({ where: { locale: 'ko' } })).toBe(0);

    await asAppRole(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.platform_staff', 'true', true)`);
      await tx.ideaTranslation.create({ data: { ideaId: kit.id, locale: 'ko', title: '제목' } });
      await tx.ideaTagTranslation.create({
        data: { tagId: kit.tags[0]!.tagId, locale: 'ko', label: '라벨' },
      });
    });
    expect(await adminDb.ideaTranslation.count({ where: { locale: 'ko' } })).toBe(1);
    expect(await adminDb.ideaTagTranslation.count({ where: { locale: 'ko' } })).toBe(1);
  });
});
