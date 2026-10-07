import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  IdeaListCapExceededError,
  IdeaNotFoundError,
  InvalidIdeaFilterError,
} from '@/lib/ideas/errors';
import { ideasAdminService } from '@/lib/services/ideasAdminService';
import { PUBLIC_IDEA_LIST_CAP, ideasPublicService } from '@/lib/services/ideasPublicService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { directionInput, motirBuysInput, seedTags, staffActor } from './_helpers';

/**
 * The idea store's PUBLIC read service (Story MOTIR-7662 · MOTIR-7672), against
 * real Postgres: every filter alone and combined, the category counts that
 * ignore the category filter, a retired idea never surfacing anywhere, and the
 * DTO carrying no staff field.
 */

const STAFF_FIELDS = ['id', 'status', 'retiredReason', 'retiredAt', 'updatedAt'];

async function seedStore(): Promise<void> {
  await seedTags('smb', 'consumer', 'regulated');
  const actor = await staffActor('operator');
  await ideasAdminService.addIdeas(actor, [
    motirBuysInput('legal-team', { category: 'legal', tags: ['smb'] }),
    motirBuysInput('finance-team', {
      category: 'finance',
      tags: ['smb', 'regulated'],
      pitch: 'Books closed every month.',
    }),
    directionInput('store-visibility', { category: 'ecommerce', tags: ['smb'] }),
    directionInput('returns', {
      category: 'ecommerce',
      tags: ['consumer'],
      gap: 'Nobody predicts returns.',
    }),
    directionInput('pet-clinics', { category: 'pets', tags: ['regulated', 'smb'] }),
  ]);
  await ideasAdminService.addIdeas(actor, [
    directionInput('retired-one', { category: 'ecommerce', tags: ['smb', 'consumer'] }),
  ]);
  await ideasAdminService.retireIdea(actor, 'retired-one', 'Superseded by store-visibility');
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
});

describe('listActive', () => {
  it('returns every active idea, motir_buys first, never a retired one', async () => {
    await seedStore();
    const list = await ideasPublicService.listActive();

    const slugs = list.items.map((i) => i.slug);
    expect(slugs).toHaveLength(5);
    expect(slugs).not.toContain('retired-one');
    expect(list.total).toBe(5);
    expect(list.items.slice(0, 2).every((i) => i.kind === 'motir_buys')).toBe(true);
    expect(list.items.slice(2).every((i) => i.kind === 'direction')).toBe(true);
  });

  it('carries no staff field on any item', async () => {
    await seedStore();
    const list = await ideasPublicService.listActive();
    for (const item of list.items) {
      for (const field of STAFF_FIELDS) expect(item).not.toHaveProperty(field);
    }
    const one = await ideasPublicService.getBySlug('returns');
    for (const field of STAFF_FIELDS) expect(one).not.toHaveProperty(field);
    expect(one.category).toEqual({ slug: 'ecommerce', label: expect.any(String) });
    expect(one.evidence[0]!.sourceDate).toBe('2026-01-01');
  });

  it('filters by category, with counts that ignore the category filter', async () => {
    await seedStore();
    const list = await ideasPublicService.listActive({ category: 'ecommerce' });

    expect(list.items.map((i) => i.slug).sort()).toEqual(['returns', 'store-visibility']);
    const counts = Object.fromEntries(list.categories.map((c) => [c.slug, c.count]));
    // The retired ecommerce idea counts nowhere; every category stays choosable.
    expect(counts).toEqual({ legal: 1, finance: 1, ecommerce: 2, pets: 1 });
  });

  it('filters by kind', async () => {
    await seedStore();
    const list = await ideasPublicService.listActive({ kind: 'motir_buys' });
    expect(list.items.map((i) => i.slug).sort()).toEqual(['finance-team', 'legal-team']);
    expect(list.categories.map((c) => c.slug)).toEqual(['legal', 'finance']);
  });

  it('AND-combines tags', async () => {
    await seedStore();
    const one = await ideasPublicService.listActive({ tags: ['smb'] });
    expect(one.items.map((i) => i.slug).sort()).toEqual([
      'finance-team',
      'legal-team',
      'pet-clinics',
      'store-visibility',
    ]);
    const both = await ideasPublicService.listActive({ tags: ['smb', 'regulated'] });
    expect(both.items.map((i) => i.slug).sort()).toEqual(['finance-team', 'pet-clinics']);
  });

  it('matches text case-insensitively across title, pitch, gap and tag label', async () => {
    await seedStore();
    expect(
      (await ideasPublicService.listActive({ q: 'BOOKS closed' })).items.map((i) => i.slug),
    ).toEqual(['finance-team']);
    expect(
      (await ideasPublicService.listActive({ q: 'predicts' })).items.map((i) => i.slug),
    ).toEqual(['returns']);
    expect(
      (await ideasPublicService.listActive({ q: 'consumer' })).items.map((i) => i.slug),
    ).toEqual(['returns']);
    expect((await ideasPublicService.listActive({ q: 'no-idea-says-this' })).items).toEqual([]);
  });

  it('combines every filter at once', async () => {
    await seedStore();
    const list = await ideasPublicService.listActive({
      category: 'pets',
      kind: 'direction',
      tags: ['regulated'],
      q: 'pet-clinics',
    });
    expect(list.items.map((i) => i.slug)).toEqual(['pet-clinics']);
    expect(list.categories).toEqual([{ slug: 'pets', label: expect.any(String), count: 1 }]);
  });

  it('refuses an unknown category or kind, and matches nothing for an unknown tag', async () => {
    await seedStore();
    await expect(ideasPublicService.listActive({ category: 'astrology' })).rejects.toBeInstanceOf(
      InvalidIdeaFilterError,
    );
    await expect(ideasPublicService.listActive({ kind: 'maybe' })).rejects.toBeInstanceOf(
      InvalidIdeaFilterError,
    );
    const none = await ideasPublicService.listActive({ tags: ['no-such-tag'] });
    expect(none).toEqual({ items: [], categories: [], total: 0 });
  });

  it('throws rather than truncate once the cap is passed', async () => {
    await adminDb.idea.createMany({
      data: Array.from({ length: PUBLIC_IDEA_LIST_CAP + 1 }, (_, n) => ({
        slug: `bulk-${n}`,
        title: `Bulk ${n}`,
        pitch: 'Bulk.',
        kind: 'direction' as const,
        category: 'operations' as const,
      })),
    });
    await expect(ideasPublicService.listActive()).rejects.toBeInstanceOf(IdeaListCapExceededError);
    await adminDb.idea.deleteMany({ where: { slug: 'bulk-0' } });
    expect((await ideasPublicService.listActive()).total).toBe(PUBLIC_IDEA_LIST_CAP);
  });
});

describe('listTags', () => {
  it('counts active ideas only and omits a tag used solely by retired ideas', async () => {
    await seedStore();
    await seedTags('orphan');
    const actor = await staffActor('operator', { kind: 'session' }, 'second');
    await ideasAdminService.addIdeas(actor, [directionInput('gone-soon', { tags: ['orphan'] })]);
    await ideasAdminService.retireIdea(actor, 'gone-soon', 'Merged elsewhere');

    const tags = await ideasPublicService.listTags();
    expect(tags).toEqual([
      { slug: 'consumer', label: 'CONSUMER', count: 1 },
      { slug: 'regulated', label: 'REGULATED', count: 2 },
      { slug: 'smb', label: 'SMB', count: 4 },
    ]);
  });
});

describe('getBySlug', () => {
  it('reads an active idea and refuses a retired one exactly like an unknown one', async () => {
    await seedStore();
    expect((await ideasPublicService.getBySlug('legal-team')).title).toBe('Motir buys legal-team');
    await expect(ideasPublicService.getBySlug('retired-one')).rejects.toBeInstanceOf(
      IdeaNotFoundError,
    );
    await expect(ideasPublicService.getBySlug('never-was')).rejects.toBeInstanceOf(
      IdeaNotFoundError,
    );
  });
});
