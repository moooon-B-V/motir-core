import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IdeaNotFoundError } from '@/lib/ideas/errors';
import { ideasAdminService } from '@/lib/services/ideasAdminService';
import { ideasPublicService } from '@/lib/services/ideasPublicService';
import { truncateAuthTables } from '../helpers/db';
import { directionInput, motirBuysInput, seedTags, staffActor } from './_helpers';

/**
 * The public reads in a locale (Story MOTIR-7772 · MOTIR-7775), against real
 * Postgres: per-field fallback, one untranslated claim leaving the rest in the
 * reader's language, `q` over the locale's own text, the counts under the same
 * `q`, and retired ideas absent in every locale.
 */

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
});

/** Pre-existing keys of the public DTO — the additive-only contract. */
const PUBLIC_KEYS = [
  'slug',
  'title',
  'pitch',
  'kind',
  'category',
  'tags',
  'capabilities',
  'evidence',
  'gap',
  'whyNow',
  'whyMotir',
  'whoElse',
  'addedAt',
  'lastReviewedAt',
];

async function seed() {
  const actor = await staffActor('operator');
  await seedTags('smb');
  await ideasAdminService.addTag(actor, {
    slug: 'pets',
    label: 'Pets',
    description: 'Pet businesses.',
    labelTranslations: { ja: 'ペット' },
  });
  await ideasAdminService.addIdeas(actor, [
    directionInput('clinic', {
      category: 'pets',
      tags: ['pets', 'smb'],
      evidence: [
        {
          claim: 'First claim.',
          sourceName: 'A',
          url: 'https://a.example',
          claimTranslations: { ja: '最初の主張' },
        },
        { claim: 'Second claim.', sourceName: 'B', url: 'https://b.example' },
      ],
      translations: {
        ja: { title: '動物病院の予約', capabilities: ['一つ', '二つ'], gap: 'まだ誰もいない' },
      },
    }),
    motirBuysInput('legal-team', { tags: ['smb'] }),
    directionInput('gone', { category: 'pets', translations: { ja: { title: '消えた' } } }),
  ]);
  await ideasAdminService.retireIdea(actor, 'gone', 'Merged into clinic');
}

describe('a locale on the public reads', () => {
  it('serves ja text per field, English elsewhere, and names exactly the English parts', async () => {
    await seed();
    const idea = await ideasPublicService.getBySlug('clinic', 'ja');
    expect(idea.locale).toBe('ja');
    expect(idea.title).toBe('動物病院の予約');
    expect(idea.pitch).toBe('The pitch of clinic.');
    expect(idea.capabilities).toEqual(['一つ', '二つ']);
    expect(idea.gap).toBe('まだ誰もいない');
    expect(idea.whyMotir).toBeNull();
    expect(idea.fallbackFields).toEqual(['pitch']);
    expect(idea.evidence.map((e) => [e.claim, e.claimFallback])).toEqual([
      ['最初の主張', false],
      ['Second claim.', true],
    ]);
    expect(idea.tags).toEqual([
      { slug: 'pets', label: 'ペット', labelFallback: false },
      { slug: 'smb', label: 'SMB', labelFallback: true },
    ]);
    for (const key of PUBLIC_KEYS) expect(idea).toHaveProperty(key);
    expect(idea).not.toHaveProperty('translations');
    expect(idea).not.toHaveProperty('status');

    const list = await ideasPublicService.listActive({}, 'ja');
    expect(list.locale).toBe('ja');
    expect(list.items.find((i) => i.slug === 'clinic')?.title).toBe('動物病院の予約');
    const legal = list.items.find((i) => i.slug === 'legal-team')!;
    expect(legal.title).toBe('Motir buys legal-team');
    expect(legal.fallbackFields).toEqual(['title', 'pitch', 'capabilities', 'whyMotir', 'whoElse']);
    expect(list.categories.map((c) => c.label)).toEqual(
      (await ideasPublicService.listActive()).categories.map((c) => c.label),
    );

    expect(await ideasPublicService.listTags('ja')).toEqual([
      { slug: 'pets', label: 'ペット', labelFallback: false, count: 1 },
      { slug: 'smb', label: 'SMB', labelFallback: true, count: 2 },
    ]);
  });

  it('serves English with no fallback without a locale, or under en', async () => {
    await seed();
    for (const idea of [
      await ideasPublicService.getBySlug('clinic'),
      await ideasPublicService.getBySlug('clinic', 'en'),
    ]) {
      expect(idea).toMatchObject({ locale: 'en', title: 'Direction clinic', fallbackFields: [] });
      expect(idea.evidence.every((e) => !e.claimFallback)).toBe(true);
      expect(idea.tags.every((t) => !t.labelFallback)).toBe(true);
    }
  });

  it('matches q over the locale text, and keeps the counts under the same q', async () => {
    await seed();
    const slugs = async (q: string, locale: 'ja' | 'ko' | 'en') =>
      (await ideasPublicService.listActive({ q }, locale)).items.map((i) => i.slug);

    expect(await slugs('病院', 'ja')).toEqual(['clinic']);
    expect(await slugs('誰も', 'ja')).toEqual(['clinic']);
    expect(await slugs('ペット', 'ja')).toEqual(['clinic']);
    expect(await slugs('legal-team', 'ja')).toEqual(['legal-team']);
    expect(await slugs('病院', 'ko')).toEqual([]);
    expect(await slugs('病院', 'en')).toEqual([]);
    expect(await slugs('消えた', 'ja')).toEqual([]);

    const counted = await ideasPublicService.listActive({ q: '病院' }, 'ja');
    expect(counted.categories.map((c) => [c.slug, c.count])).toEqual([['pets', 1]]);
  });

  it('keeps retired ideas out of every read in every locale', async () => {
    await seed();
    for (const locale of ['ja', 'ko', 'en'] as const) {
      const list = await ideasPublicService.listActive({}, locale);
      expect(list.items.map((i) => i.slug)).not.toContain('gone');
      await expect(ideasPublicService.getBySlug('gone', locale)).rejects.toBeInstanceOf(
        IdeaNotFoundError,
      );
    }
  });
});
