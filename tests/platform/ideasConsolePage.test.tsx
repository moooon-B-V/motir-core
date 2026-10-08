// @vitest-environment happy-dom
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormatter, createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import { ideasAdminService } from '@/lib/services/ideasAdminService';
import { truncateAuthTables } from '../helpers/db';
import { renderToHtml } from '../helpers/serverPageHarness';
import { directionInput, motirBuysInput, seedTags, staffActor } from '../ideas/_helpers';

// THE CONSOLE'S IDEAS PAGE (Story MOTIR-7664 · MOTIR-7680) — the list and the
// read-only detail, rendered over the REAL idea store with the REAL `en`
// catalogue: the session is the one thing mocked (CLAUDE.md's single allowance),
// so the page gate, the service's role check and the reads all run for real.
//
// What each case pins is a state the design (`platform-admin` § Ideas) draws:
// populated, each filter, no match, empty, the error card, the pager, both
// statuses, both kinds, the support line, and the 404s.

class NotFoundSentinel extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
vi.mock('next/navigation', async () => ({
  ...(await import('../helpers/serverPageHarness')).navigationHooks(),
  notFound: () => {
    throw new NotFoundSentinel();
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as 'platformAdmin' }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

const { default: IdeasPage } = await import('@/app/(admin)/admin/ideas/page');
const { default: IdeaPage } = await import('@/app/(admin)/admin/ideas/[slug]/page');

beforeEach(async () => {
  currentSession = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
});

async function signInAs(role: 'support' | 'operator' | 'superadmin') {
  const actor = await staffActor(role, { kind: 'session' }, `${role}-viewer`);
  currentSession = { user: { id: actor.userId } };
  return actor;
}

function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function list(params: Record<string, string> = {}): Promise<string> {
  return decode(await renderToHtml(await IdeasPage({ searchParams: Promise.resolve(params) })));
}

async function detail(slug: string): Promise<string> {
  return decode(await renderToHtml(await IdeaPage({ params: Promise.resolve({ slug }) })));
}

async function seedStore() {
  await seedTags('smb', 'consumer');
  const operator = await staffActor('operator', { kind: 'session' }, 'seeder');
  await ideasAdminService.addIdeas(operator, [
    directionInput('stop-returns', {
      title: 'Stop returns before they happen',
      tags: ['smb'],
      gap: 'Nobody predicts the return.',
    }),
    directionInput('pet-sitter', { title: 'Pet sitter marketplace', category: 'pets' }),
    motirBuysInput('contract-review', { title: 'Contract review', tags: ['consumer'] }),
  ]);
  await ideasAdminService.retireIdea(operator, 'pet-sitter', 'Gap closed by a big player');
  return operator;
}

describe('the list', () => {
  it('shows the active ideas by default, newest first, with their pills and tags', async () => {
    await seedStore();
    await signInAs('support');
    const html = await list();

    expect(html).toContain('Stop returns before they happen');
    expect(html).toContain('Contract review');
    // Status defaults to Active, so the retired idea is not listed.
    expect(html).not.toContain('Pet sitter marketplace');
    expect(html).toContain('Newest first. 2 shown.');
    expect(html).toContain('Motir would buy');
    expect(html).toContain('Direction');
    expect(html).toContain('SMB');
    expect(html).toContain('href="/admin/ideas/stop-returns"');
    // The default view carries no chips.
    expect(html).not.toContain('data-testid="ideas-filter-chips"');
  });

  it('narrows by status, kind, category, tag and text, and repeats each filter as a chip', async () => {
    await seedStore();
    await signInAs('operator');

    const retired = await list({ status: 'retired' });
    expect(retired).toContain('Pet sitter marketplace');
    expect(retired).toContain('Retired');
    expect(retired).toContain('“Gap closed by a big player”');
    expect(retired).not.toContain('Contract review');
    expect(retired).toContain('data-testid="ideas-filter-chips"');

    const all = await list({ status: 'all' });
    expect(all).toContain('Newest first. 3 shown.');

    expect(await list({ kind: 'motir_buys' })).toContain('Newest first. 1 shown.');
    const ecommerce = await list({ category: 'ecommerce' });
    expect(ecommerce).toContain('Stop returns before they happen');
    expect(ecommerce).not.toContain('Contract review');
    const tagged = await list({ tag: 'consumer' });
    expect(tagged).toContain('Contract review');
    expect(tagged).not.toContain('Stop returns before they happen');
    const text = await list({ q: 'returns' });
    expect(text).toContain('Stop returns before they happen');
    expect(text).toContain('Newest first. 1 shown.');
  });

  it('ignores a kind or category the store does not know rather than erroring', async () => {
    await seedStore();
    await signInAs('support');
    const html = await list({ kind: 'nonsense', category: 'nope' });
    expect(html).toContain('Newest first. 2 shown.');
  });

  it('shows the filter-shaped empty state when nothing matches', async () => {
    await seedStore();
    await signInAs('support');
    const html = await list({ q: 'no idea says this' });
    expect(html).toContain('No ideas match these filters');
    expect(html).toContain('Clear all filters');
    expect(html).not.toContain('No ideas yet');
  });

  it('shows the empty store with where ideas come from', async () => {
    await signInAs('support');
    const html = await list();
    expect(html).toContain('No ideas yet');
    expect(html).toContain('motir-ideas research skill');
  });

  it('shows the error card, with Retry and no rows, when the store cannot be read', async () => {
    await seedStore();
    await signInAs('support');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const html = await list({ cursor: 'not-a-cursor-this-api-issued' });
    expect(html).toContain('Couldn’t load the ideas');
    expect(html).toContain('Retry');
    expect(html).not.toContain('Stop returns before they happen');
    spy.mockRestore();
  });

  it('settles the tags read before it shows the error card (MOTIR-7796)', async () => {
    // The list read rejects on the cursor; the tags read is held until it has,
    // so the page cannot finish ahead of it by luck. A page that takes the
    // error branch on the first rejection returns with the tags query still
    // running — the leftover `tests/helpers/inFlightProbe.ts` reports.
    await seedStore();
    await signInAs('support');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listForStaff = ideasAdminService.listForStaff.bind(ideasAdminService);
    const listTags = ideasAdminService.listTags.bind(ideasAdminService);
    let listSettled: Promise<unknown> = Promise.resolve();
    let tagsSettled = false;
    const listSpy = vi.spyOn(ideasAdminService, 'listForStaff').mockImplementation((...args) => {
      const read = listForStaff(...args);
      listSettled = read.catch(() => undefined);
      return read;
    });
    const tagsSpy = vi.spyOn(ideasAdminService, 'listTags').mockImplementation(async (...args) => {
      await listSettled;
      try {
        return await listTags(...args);
      } finally {
        tagsSettled = true;
      }
    });

    const html = await list({ cursor: 'not-a-cursor-this-api-issued' });

    expect(tagsSettled).toBe(true);
    expect(html).toContain('Couldn’t load the ideas');
    listSpy.mockRestore();
    tagsSpy.mockRestore();
    errors.mockRestore();
  });

  it('pages past fifty with Next page, and offers the first page back', async () => {
    const operator = await staffActor('operator', { kind: 'session' }, 'pager');
    for (let batch = 0; batch < 3; batch += 1) {
      await ideasAdminService.addIdeas(
        operator,
        Array.from({ length: batch < 2 ? 20 : 12 }, (_, i) => directionInput(`idea-${batch}-${i}`)),
      );
    }
    await signInAs('support');

    const first = await list();
    expect(first).toContain('Newest first. 50 shown.');
    expect(first).toContain('Next page');
    expect(first).not.toContain('First page');
    const next = /href="\/admin\/ideas\?cursor=([^"]+)"/.exec(first);
    expect(next).not.toBeNull();

    const second = await list({ cursor: decodeURIComponent(next![1]!) });
    expect(second).toContain('Newest first. 2 shown.');
    expect(second).toContain('First page');
    expect(second).not.toContain('Next page');
  });

  it('is the app 404 for a signed-in user who is not staff, and for nobody', async () => {
    await expect(IdeasPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(
      NotFoundSentinel,
    );
    const { createTestUser } = await import('../fixtures/userFixtures');
    const owner = await createTestUser({ email: 'owner@customer.test' });
    currentSession = { user: { id: owner.id } };
    await expect(IdeasPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(
      NotFoundSentinel,
    );
  });
});

describe('the detail', () => {
  it('reads every field of an active direction, its evidence in order and its record', async () => {
    await seedStore();
    await signInAs('operator');
    const html = await detail('stop-returns');

    expect(html).toContain('Stop returns before they happen');
    expect(html).toContain('The pitch of stop-returns.');
    expect(html).toContain('Does one thing');
    expect(html).toContain('Nobody predicts the return.');
    // Why now was never written: italic, not vanished.
    expect(html).toContain('Not written.');
    // A direction has no Motir-would-buy fields.
    expect(html).not.toContain('Why Motir would buy it');
    expect(html).toContain('A sourced claim.');
    expect(html).toContain('A source, January 2026 · Jan 1, 2026');
    expect(html).toContain('href="https://example.com/source"');
    expect(html).toContain('(opens in a new tab)');
    expect(html).toContain('1 source');
    expect(html).toContain('Yes, in E-commerce');
    expect(html).toContain('Not yet reviewed');
    // An operator gets Edit and Retire, no Delete, and no support line.
    expect(html).not.toContain('Read-only for support');
    expect(html).toContain('data-testid="idea-actions"');
    expect(html).toMatch(/>Edit<\/button>|>Edit</);
    expect(html).toContain('Retire');
    expect(html).not.toMatch(/>Delete</);
  });

  it('adds Delete for a superadmin (MOTIR-7681)', async () => {
    await seedStore();
    await signInAs('superadmin');
    const html = await detail('stop-returns');
    expect(html).toMatch(/>Delete</);
  });

  it('names who retired an idea in its Retired box (MOTIR-7681)', async () => {
    await seedStore();
    await signInAs('operator');
    const html = await detail('pet-sitter');
    expect(html).toContain('data-testid="idea-retired-box"');
    expect(html).toMatch(/ · [^<·]+ · no longer on motir\.co/);
  });

  it('adds the Motir-would-buy fields on that kind', async () => {
    await seedStore();
    await signInAs('support');
    const html = await detail('contract-review');
    expect(html).toContain('Why Motir would buy it');
    expect(html).toContain('Motir needs it.');
    expect(html).toContain('Who else needs it');
    expect(html).toContain('No evidence rows.');
  });

  it('shows a retired idea with its reason and date, and that motir.co no longer shows it', async () => {
    await seedStore();
    await signInAs('support');
    const html = await detail('pet-sitter');
    expect(html).toContain('data-testid="idea-retired-box"');
    expect(html).toContain('Retired — Gap closed by a big player');
    expect(html).toContain('no longer on motir.co');
    expect(html).toContain('No — retired');
  });

  it('gives support the read-only line instead of any control', async () => {
    await seedStore();
    await signInAs('support');
    const html = await detail('stop-returns');
    expect(html).toContain('Read-only for support.');
  });

  it('is the app 404 for an unknown slug, and for a non-staff user', async () => {
    await seedStore();
    await signInAs('support');
    await expect(IdeaPage({ params: Promise.resolve({ slug: 'missing' }) })).rejects.toBeInstanceOf(
      NotFoundSentinel,
    );
    currentSession = null;
    await expect(
      IdeaPage({ params: Promise.resolve({ slug: 'stop-returns' }) }),
    ).rejects.toBeInstanceOf(NotFoundSentinel);
  });
});
