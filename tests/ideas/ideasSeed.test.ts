import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { applyIdeaSeed } from './_helpers';

/**
 * The idea store's SEED migration (Story MOTIR-7662 · MOTIR-7674) against real
 * Postgres: the 15 ideas motir.co shows today, mapped as `docs/ideas-seed.md`
 * says, and a re-run that changes nothing.
 *
 * The suites truncate the store between tests, so each case re-applies the
 * migration's own SQL — which is itself the idempotency contract under test.
 */

const MOTIR_BUYS: Record<string, string> = {
  'an-ai-legal-team-for-software-companies': 'legal',
  'an-ai-finance-team-for-startups': 'finance',
  'ai-security-and-compliance-from-the-evidence': 'security_compliance',
  'ai-support-that-knows-the-product': 'customer_support',
  'ai-localization-that-keeps-up-with-the-product': 'localization',
  'ai-growth-for-b2b-software': 'growth_marketing',
};

const DIRECTIONS: Record<string, { category: string; sourceDate: string }> = {
  'make-a-store-visible-to-ai-shoppers': { category: 'ecommerce', sourceDate: '2026-01-01' },
  'stop-returns-before-they-happen': { category: 'ecommerce', sourceDate: '2025-10-01' },
  'apis-that-update-their-customers-code': {
    category: 'ai_infrastructure',
    sourceDate: '2026-09-01',
  },
  'ai-cost-by-feature-and-by-customer': { category: 'ai_infrastructure', sourceDate: '2026-02-01' },
  'the-ai-transparency-kit': { category: 'ai_infrastructure', sourceDate: '2026-07-01' },
  'a-first-tutor-for-young-children': { category: 'personal_growth', sourceDate: '2026-09-01' },
  'a-career-coach-for-people-who-pay-for-themselves': {
    category: 'personal_growth',
    sourceDate: '2025-09-01',
  },
  'treatment-options-for-vet-clinics': { category: 'pets', sourceDate: '2025-01-01' },
  'a-care-team-app-for-families': { category: 'family_care', sourceDate: '2025-07-01' },
};

function readStore() {
  return adminDb.idea.findMany({
    orderBy: { slug: 'asc' },
    include: {
      evidence: { orderBy: { position: 'asc' } },
      tags: { include: { tag: true }, orderBy: { tagId: 'asc' } },
    },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  await applyIdeaSeed();
});

afterAll(async () => {
  await truncateAuthTables();
});

describe('the idea seed', () => {
  it('holds exactly the 15 ideas, 6 motir_buys and 9 directions, all active', async () => {
    const ideas = await readStore();
    expect(ideas).toHaveLength(15);
    expect(ideas.every((i) => i.status === 'active')).toBe(true);

    const buys = ideas.filter((i) => i.kind === 'motir_buys');
    expect(Object.fromEntries(buys.map((i) => [i.slug, i.category]))).toEqual(MOTIR_BUYS);
    const directions = ideas.filter((i) => i.kind === 'direction');
    expect(Object.fromEntries(directions.map((i) => [i.slug, i.category]))).toEqual(
      Object.fromEntries(Object.entries(DIRECTIONS).map(([slug, d]) => [slug, d.category])),
    );
  });

  it('maps a motir_buys entry: does → capabilities in order, need → whyMotir, who → whoElse, no evidence', async () => {
    const ideas = await readStore();
    for (const idea of ideas.filter((i) => i.kind === 'motir_buys')) {
      expect(idea.capabilities).toHaveLength(3);
      expect(idea.whyMotir).toBeTruthy();
      expect(idea.whoElse).toBeTruthy();
      expect([idea.gap, idea.whyNow]).toEqual([null, null]);
      expect(idea.evidence).toEqual([]);
    }
    const legal = ideas.find((i) => i.slug === 'an-ai-legal-team-for-software-companies')!;
    expect(legal.title).toBe('An AI legal team for software companies');
    expect(legal.capabilities[2]).toBe(
      'Tracks new rules, like the EU AI Act, and says what each one changes for you',
    );
    expect(legal.whoElse).toBe(
      'Every software company that handles customer data, which is all of them.',
    );
  });

  it('maps a direction: one dated https evidence row and the gap, nothing motir_buys-only', async () => {
    const ideas = await readStore();
    for (const idea of ideas.filter((i) => i.kind === 'direction')) {
      expect(idea.evidence).toHaveLength(1);
      const [row] = idea.evidence;
      expect(row!.position).toBe(0);
      expect(row!.url.startsWith('https://')).toBe(true);
      expect(row!.sourceDate?.toISOString().slice(0, 10)).toBe(DIRECTIONS[idea.slug]!.sourceDate);
      expect(idea.gap).toBeTruthy();
      expect([idea.whyMotir, idea.whoElse, idea.whyNow]).toEqual([null, null, null]);
      expect(idea.capabilities).toEqual([]);
    }
    const kit = ideas.find((i) => i.slug === 'the-ai-transparency-kit')!;
    expect(kit.evidence[0]!.claim).toContain('fines of up to €15 million');
    expect(kit.evidence[0]!.sourceName).toBe('Jones Walker, AI Law Blog, July 2026');
  });

  it('gives every idea 1–4 tags from a vocabulary whose every tag states its reason', async () => {
    const ideas = await readStore();
    for (const idea of ideas) {
      expect(idea.tags.length).toBeGreaterThanOrEqual(1);
      expect(idea.tags.length).toBeLessThanOrEqual(4);
    }
    const tags = await adminDb.ideaTag.findMany({
      include: { _count: { select: { assignments: true } } },
    });
    expect(tags.length).toBeGreaterThanOrEqual(10);
    expect(tags.length).toBeLessThanOrEqual(20);
    for (const tag of tags) {
      expect(tag.description?.trim()).toBeTruthy();
      expect(tag._count.assignments).toBeGreaterThan(0);
    }
  });

  it('changes nothing when applied again — not even an idea edited or retired since', async () => {
    await adminDb.idea.update({
      where: { slug: 'the-ai-transparency-kit' },
      data: { pitch: 'Edited in the console.' },
    });
    await adminDb.idea.update({
      where: { slug: 'stop-returns-before-they-happen' },
      data: { status: 'retired', retiredReason: 'Merged elsewhere', retiredAt: new Date() },
    });
    await adminDb.ideaEvidence.deleteMany({
      where: { idea: { slug: 'make-a-store-visible-to-ai-shoppers' } },
    });
    const before = await readStore();
    const tagsBefore = await adminDb.ideaTag.findMany({ orderBy: { slug: 'asc' } });

    await applyIdeaSeed();

    expect(await readStore()).toEqual(before);
    expect(await adminDb.ideaTag.findMany({ orderBy: { slug: 'asc' } })).toEqual(tagsBefore);
    expect(before.find((i) => i.slug === 'the-ai-transparency-kit')!.pitch).toBe(
      'Edited in the console.',
    );
  });
});
