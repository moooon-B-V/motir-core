import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { IdeaCategory } from '@/generated/prisma/client';
import {
  IDEA_CATEGORIES,
  IDEA_CATEGORY_LABELS,
  IDEA_CATEGORY_TRANSLATIONS,
} from '@/lib/ideas/categories';
import { InvalidIdeaInputError } from '@/lib/ideas/errors';
import { resolvePublicIdeaLocale } from '@/lib/ideas/publicLocale';
import { addIdeasBodySchema } from '@/lib/ideas/schemas';
import { IDEA_TRANSLATION_LOCALES } from '@/lib/ideas/translatableFields';
import { ideasAdminService } from '@/lib/services/ideasAdminService';
import { ideasPublicService } from '@/lib/services/ideasPublicService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { directionInput, staffActor } from './_helpers';

/**
 * The nine idea categories of Story MOTIR-8273 (MOTIR-8277), end to end inside
 * motir-core against real Postgres: their grouped order and labels, every
 * translation column, the staff write path accepting each and still refusing an
 * unknown slug, the public reads labelling each in all eleven locales, and no
 * existing idea moving category.
 */

const NEW_VERTICALS = [
  'entertainment_media',
  'hospitality_travel',
  'mobility',
  'energy_climate',
  'manufacturing',
  'local_services',
] as const satisfies readonly IdeaCategory[];

const NEW_CONSUMER = [
  'social_community',
  'silver_economy',
  'independent_work',
] as const satisfies readonly IdeaCategory[];

const NINE: readonly IdeaCategory[] = [...NEW_VERTICALS, ...NEW_CONSUMER];

const ENGLISH: Record<(typeof NEW_VERTICALS)[number] | (typeof NEW_CONSUMER)[number], string> = {
  entertainment_media: 'Entertainment & media',
  hospitality_travel: 'Hospitality & travel',
  mobility: 'Mobility & automotive',
  energy_climate: 'Energy & climate',
  manufacturing: 'Manufacturing',
  local_services: 'Local services',
  social_community: 'Social & community',
  silver_economy: 'Silver economy',
  independent_work: 'Independent work',
};

/** A batch-add body with one direction in `category`. */
function bodyWith(category: string) {
  return { ideas: [{ ...directionInput('one-idea'), category }] };
}

/** The slug each new category's seeded idea gets. */
function slugFor(category: string): string {
  return `idea-${category.replace(/_/g, '-')}`;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
});

describe('order, labels and translations', () => {
  it('lists 34 unique categories with the nine at their grouped positions', () => {
    expect(IDEA_CATEGORIES).toHaveLength(34);
    expect(new Set(IDEA_CATEGORIES).size).toBe(34);
    const afterPublicSector = IDEA_CATEGORIES.indexOf('public_sector') + 1;
    expect(
      IDEA_CATEGORIES.slice(afterPublicSector, afterPublicSector + NEW_VERTICALS.length),
    ).toEqual(NEW_VERTICALS);
    const afterHealth = IDEA_CATEGORIES.indexOf('health_wellness') + 1;
    expect(IDEA_CATEGORIES.slice(afterHealth, afterHealth + NEW_CONSUMER.length)).toEqual(
      NEW_CONSUMER,
    );
    expect(IDEA_CATEGORIES[afterHealth + NEW_CONSUMER.length]).toBe('ai_infrastructure');
  });

  it('labels the nine in English exactly, with no gloss', () => {
    for (const slug of NINE) {
      expect(IDEA_CATEGORY_LABELS[slug]).toBe(ENGLISH[slug as keyof typeof ENGLISH]);
    }
  });

  it('labels the nine in every translation column, and CJK never copies English', () => {
    for (const locale of IDEA_TRANSLATION_LOCALES) {
      for (const slug of NINE) {
        const label = IDEA_CATEGORY_TRANSLATIONS[locale][slug];
        expect(label?.trim(), `${locale}.${slug}`).toBeTruthy();
        if (locale === 'zh' || locale === 'ja' || locale === 'ko') {
          expect(label, `${locale}.${slug}`).not.toBe(IDEA_CATEGORY_LABELS[slug]);
        }
      }
    }
  });
});

describe('the staff write path', () => {
  it('the batch-add schema accepts each of the nine', () => {
    for (const slug of NINE) {
      expect(addIdeasBodySchema.safeParse(bodyWith(slug)).success, slug).toBe(true);
    }
  });

  it.each(['space_travel', 'silver-economy'])(
    'the batch-add schema refuses %s on ideas.0.category',
    (category) => {
      const parsed = addIdeasBodySchema.safeParse(bodyWith(category));
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((i) => i.path.join('.'))).toContain('ideas.0.category');
    },
  );

  it('addIdeas stores an idea in each of the nine', async () => {
    const actor = await staffActor('operator');
    const result = await ideasAdminService.addIdeas(
      actor,
      NINE.map((category) => directionInput(slugFor(category), { category })),
    );
    expect([...result.slugs].sort()).toEqual(NINE.map(slugFor).sort());
    const rows = await adminDb.idea.findMany({ select: { slug: true, category: true } });
    expect(Object.fromEntries(rows.map((r) => [r.slug, r.category]))).toEqual(
      Object.fromEntries(NINE.map((c) => [slugFor(c), c])),
    );
  });

  it('addIdeas refuses an unknown category on `category` and rolls back the whole batch', async () => {
    const actor = await staffActor('operator');
    const err = await ideasAdminService
      .addIdeas(actor, [
        directionInput('valid-sibling', { category: 'silver_economy' }),
        directionInput('space-idea', { category: 'space_travel' as IdeaCategory }),
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidIdeaInputError);
    const issues = (err as InvalidIdeaInputError).issues;
    expect(issues).toContainEqual(
      expect.objectContaining({ slug: 'space-idea', field: 'category' }),
    );
    expect(await adminDb.idea.count()).toBe(0);
  });

  it('the PATCH path moves an idea into local_services, then silver_economy, and refuses space_travel', async () => {
    const actor = await staffActor('operator');
    await ideasAdminService.addIdeas(actor, [directionInput('to-move', { category: 'legal' })]);

    const read = async () =>
      (await adminDb.idea.findUniqueOrThrow({ where: { slug: 'to-move' } })).category;

    await ideasAdminService.updateIdea(actor, 'to-move', { category: 'local_services' });
    expect(await read()).toBe('local_services');
    await ideasAdminService.updateIdea(actor, 'to-move', { category: 'silver_economy' });
    expect(await read()).toBe('silver_economy');

    await expect(
      ideasAdminService.updateIdea(actor, 'to-move', {
        category: 'space_travel' as IdeaCategory,
      }),
    ).rejects.toBeInstanceOf(InvalidIdeaInputError);
    expect(await read()).toBe('silver_economy');
  });
});

describe('the public reads', () => {
  async function seedNine() {
    const actor = await staffActor('operator');
    await ideasAdminService.addIdeas(actor, [
      ...NINE.map((category) => directionInput(slugFor(category), { category })),
      directionInput('retired-factory', { category: 'manufacturing' }),
    ]);
    await ideasAdminService.retireIdea(actor, 'retired-factory', 'Superseded');
  }

  it('lists each new category in English with count 1, the retired idea uncounted', async () => {
    await seedNine();
    const list = await ideasPublicService.listActive({}, 'en');
    expect(list.categories).toEqual(
      NINE.map((slug) => ({ slug, label: IDEA_CATEGORY_LABELS[slug], count: 1 })),
    );
    expect(list.total).toBe(NINE.length);
  });

  it('labels each new category from its translation column in all ten locales', async () => {
    await seedNine();
    for (const locale of IDEA_TRANSLATION_LOCALES) {
      const list = await ideasPublicService.listActive({}, locale);
      expect(list.categories.map((c) => c.slug)).toEqual([...NINE]);
      for (const c of list.categories) {
        expect(c.label, `${locale}.${c.slug}`).toBe(IDEA_CATEGORY_TRANSLATIONS[locale][c.slug]);
      }
      for (const item of list.items) {
        expect(item.category.label).toBe(
          IDEA_CATEGORY_TRANSLATIONS[locale][item.category.slug as IdeaCategory],
        );
      }
      const silver = await ideasPublicService.getBySlug(slugFor('silver_economy'), locale);
      expect(silver.category).toEqual({
        slug: 'silver_economy',
        label: IDEA_CATEGORY_TRANSLATIONS[locale].silver_economy,
      });
    }
  });

  it('an unknown locale resolves to English and serves the English labels', async () => {
    await seedNine();
    const locale = resolvePublicIdeaLocale('xx');
    expect(locale).toBe('en');
    const list = await ideasPublicService.listActive({}, locale);
    expect(list.categories.find((c) => c.slug === 'silver_economy')?.label).toBe('Silver economy');
  });

  it('?category=local_services filters to its one idea', async () => {
    await seedNine();
    const list = await ideasPublicService.listActive({ category: 'local_services' }, 'ja');
    expect(list.total).toBe(1);
    expect(list.items.map((i) => i.slug)).toEqual([slugFor('local_services')]);
    expect(list.items[0]?.category.label).toBe(IDEA_CATEGORY_TRANSLATIONS.ja.local_services);
  });
});

describe('no existing idea changes category', () => {
  it('ideas in the neighbouring categories keep theirs after a batch in the new ones', async () => {
    const actor = await staffActor('operator');
    const existing: IdeaCategory[] = [
      'public_sector',
      'health_wellness',
      'ai_infrastructure',
      'legal',
      'family_care',
    ];
    await ideasAdminService.addIdeas(
      actor,
      existing.map((category) => directionInput(slugFor(category), { category })),
    );
    await ideasAdminService.addIdeas(
      actor,
      NINE.map((category) => directionInput(`new-${slugFor(category)}`, { category })),
    );
    const rows = await adminDb.idea.findMany({
      where: { slug: { in: existing.map(slugFor) } },
      select: { slug: true, category: true },
    });
    expect(Object.fromEntries(rows.map((r) => [r.slug, r.category]))).toEqual(
      Object.fromEntries(existing.map((c) => [slugFor(c), c])),
    );
  });

  it('the nine-value migration only adds enum values', () => {
    const dir = path.join(process.cwd(), 'prisma/migrations');
    const files = readdirSync(dir)
      .map((d) => path.join(dir, d, 'migration.sql'))
      .filter((f) => {
        try {
          return readFileSync(f, 'utf8').includes("'silver_economy'");
        } catch {
          return false;
        }
      });
    expect(files).toHaveLength(1);
    const sql = readFileSync(files[0]!, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql.match(/\bADD VALUE\b/g)).toHaveLength(9);
  });
});
