// @vitest-environment happy-dom
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormatter, createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import { getSession } from '@/lib/auth';
import type { IdeaCategory, IdeaKind, PlatformRole } from '@/generated/prisma/client';
import {
  ideaListHref,
  readIdeaListView,
  toIdeaListQuery,
  type IdeaListView,
  type IdeaStatusView,
} from '@/app/(admin)/admin/ideas/_components/ideaListQuery';
import { ideasAdminService } from '@/lib/services/ideasAdminService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { renderToHtml } from '../helpers/serverPageHarness';
import {
  directionInput,
  ideaAuditRows,
  motirBuysInput,
  seedTags,
  staffActor,
} from '../ideas/_helpers';

/**
 * STORY GATE — Story MOTIR-7664 · MOTIR-7682. The console's Ideas page held
 * together: its two loaders (`/admin/ideas`, `/admin/ideas/[slug]`) and its
 * three Server Actions over `ideasAdminService` and the audit log, against the
 * real Postgres. Each card shipped its own unit tests; this is the suite that
 * would catch a ROLE LEAK neither of them can see on its own — support able to
 * retire, an operator able to delete, a tenant reaching the page.
 *
 * The session is the one thing mocked (CLAUDE.md's single allowance), so the
 * page gate, the actions' gate, the service's level check, the conditional
 * retire and the audit rows all run for real.
 */

class NotFoundSentinel extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

type Session = { user: { id: string; email: string; name: string } };
let currentSession: Session | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
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
const { updateIdeaAction, retireIdeaAction, deleteIdeaAction } =
  await import('@/app/(admin)/admin/ideas/actions');

beforeEach(async () => {
  currentSession = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
});

function sessionOf(actor: { userId: string; email: string }, name: string): Session {
  return { user: { id: actor.userId, email: actor.email, name } };
}

async function signInAs(role: PlatformRole, label: string = role) {
  const actor = await staffActor(role, { kind: 'session' }, `${label}-story`);
  currentSession = sessionOf(actor, label);
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

async function listPage(params: Record<string, string> = {}): Promise<string> {
  return decode(await renderToHtml(await IdeasPage({ searchParams: Promise.resolve(params) })));
}

async function detailPage(slug: string): Promise<string> {
  return decode(await renderToHtml(await IdeaPage({ params: Promise.resolve({ slug }) })));
}

async function seedStore() {
  await seedTags('smb', 'consumer');
  const seeder = await staffActor('operator', { kind: 'session' }, 'story-seeder');
  await ideasAdminService.addIdeas(seeder, [
    directionInput('stop-returns', { title: 'Stop returns early', tags: ['smb'] }),
    motirBuysInput('contract-review', { title: 'Contract review', tags: ['consumer'] }),
  ]);
}

const stored = (slug: string) => adminDb.idea.findUnique({ where: { slug } });

describe('the role ladder', () => {
  it('support reads the list and the detail, and every action is not_permitted', async () => {
    await seedStore();
    await signInAs('support');
    const before = (await ideaAuditRows()).length;

    expect(await listPage()).toContain('Stop returns early');
    const detail = await detailPage('stop-returns');
    expect(detail).toContain('data-testid="idea-read-only"');
    expect(detail).not.toContain('data-testid="idea-actions"');

    const refused = { ok: false, code: 'not_permitted' };
    expect(await updateIdeaAction('stop-returns', { title: 'Leak' })).toEqual(refused);
    expect(await retireIdeaAction('stop-returns', 'Leak')).toEqual(refused);
    expect(await deleteIdeaAction('stop-returns', 'Leak')).toEqual(refused);

    const row = await stored('stop-returns');
    expect(row).toMatchObject({ title: 'Stop returns early', status: 'active' });
    expect(await ideaAuditRows()).toHaveLength(before);
  });

  it('an operator edits and retires, and delete is not_permitted', async () => {
    await seedStore();
    await signInAs('operator');

    const detail = await detailPage('stop-returns');
    expect(detail).toContain('data-testid="idea-actions"');
    expect(detail).not.toContain('data-testid="idea-read-only"');
    // The Delete button is a superadmin's alone — absent, not disabled.
    expect(detail).not.toContain('>Delete<');

    expect((await updateIdeaAction('stop-returns', { pitch: 'Sharper.' })).ok).toBe(true);
    expect((await retireIdeaAction('contract-review', 'A vendor ships it')).ok).toBe(true);
    expect(await deleteIdeaAction('stop-returns', 'Because')).toEqual({
      ok: false,
      code: 'not_permitted',
    });
    expect(await stored('stop-returns')).not.toBeNull();
  });

  it('a superadmin sees Delete and deletes', async () => {
    await seedStore();
    await signInAs('superadmin');
    expect(await detailPage('contract-review')).toContain('Delete');
    expect(await deleteIdeaAction('contract-review', 'Added by mistake')).toEqual({ ok: true });
    expect(await stored('contract-review')).toBeNull();
    await expect(detailPage('contract-review')).rejects.toBeInstanceOf(NotFoundSentinel);
  });

  it('a tenant session, and no session, get the 404 on both routes', async () => {
    await seedStore();
    const owner = await createTestUser({ email: 'owner@customer.test' });
    for (const session of [
      { user: { id: owner.id, email: owner.email, name: 'owner' } },
      null,
    ] satisfies (Session | null)[]) {
      currentSession = session;
      await expect(listPage()).rejects.toBeInstanceOf(NotFoundSentinel);
      await expect(detailPage('stop-returns')).rejects.toBeInstanceOf(NotFoundSentinel);
    }
  });
});

describe('the loaders under a failing read', () => {
  it('the detail says when without who if the retirer cannot be read', async () => {
    await seedStore();
    const operator = await signInAs('operator');
    await ideasAdminService.retireIdea(operator, 'stop-returns', 'Gap closed');
    const spy = vi.spyOn(ideasAdminService, 'retiredBy').mockRejectedValueOnce(new Error('down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const html = await detailPage('stop-returns');
    expect(html).toContain('Gap closed');
    expect(html).toContain('no longer on motir.co');
    expect(logged).toHaveBeenCalled();
    spy.mockRestore();
    logged.mockRestore();
  });

  it('the detail lets an unexpected store failure through rather than calling it a 404', async () => {
    await seedStore();
    await signInAs('support');
    const boom = new Error('store down');
    const spy = vi.spyOn(ideasAdminService, 'getForStaff').mockRejectedValueOnce(boom);
    await expect(detailPage('stop-returns')).rejects.toBe(boom);
    spy.mockRestore();
  });

  it('the list shows three tags and counts the rest', async () => {
    await seedTags('smb', 'consumer', 'b2b', 'ai');
    const seeder = await staffActor('operator', { kind: 'session' }, 'tags-seeder');
    await ideasAdminService.addIdeas(seeder, [
      directionInput('many-tags', { tags: ['smb', 'consumer', 'b2b', 'ai'] }),
    ]);
    await signInAs('support');
    expect(await listPage()).toContain('+1');
  });
});

describe('the lifecycle of one idea', () => {
  it('edit → retire with a reason → listed under Retired with it → a second retire is not_active', async () => {
    await seedStore();
    const operator = await signInAs('operator');

    const edited = await updateIdeaAction('stop-returns', {
      title: 'Stop returns before they happen',
      reviewed: true,
    });
    expect(edited.ok).toBe(true);

    const retired = await retireIdeaAction('stop-returns', '  Gap closed by a big player ');
    expect(retired.ok).toBe(true);

    // The list's Retired filter returns it, with the stated reason.
    const retiredList = await listPage({ status: 'retired' });
    expect(retiredList).toContain('Stop returns before they happen');
    expect(retiredList).toContain('“Gap closed by a big player”');
    expect(retiredList).not.toContain('Contract review');
    // …and the default Active view no longer does.
    expect(await listPage()).not.toContain('Stop returns before they happen');

    // The detail names who retired it, read back from the audit log.
    const who = await adminDb.user.findUniqueOrThrow({ where: { id: operator.userId } });
    const detail = await detailPage('stop-returns');
    expect(detail).toContain('Gap closed by a big player');
    expect(detail).toContain(who.name || who.email);
    // A retired idea offers no second Retire.
    expect(detail).not.toContain('>Retire<');

    expect(await retireIdeaAction('stop-returns', 'Again')).toEqual({
      ok: false,
      code: 'not_active',
    });
    expect((await stored('stop-returns'))!.retiredReason).toBe('Gap closed by a big player');

    const rows = (await ideaAuditRows()).filter((r) => r.actorUserId === operator.userId);
    // Naming the retirer is itself an audited read of the log (`estate.read`).
    expect(rows.map((r) => r.action)).toEqual(['idea.update', 'idea.retire', 'estate.read']);
  });
});

describe('two operators retire the same idea at once', () => {
  it('exactly one succeeds, the other sees not_active, and one audit row is written', async () => {
    await seedStore();
    const first = await staffActor('operator', { kind: 'session' }, 'race-a');
    const second = await staffActor('operator', { kind: 'session' }, 'race-b');
    const before = (await ideaAuditRows()).length;

    // Each action reads the session once; hand them out in call order.
    vi.mocked(getSession)
      .mockResolvedValueOnce(sessionOf(first, 'race-a') as never)
      .mockResolvedValueOnce(sessionOf(second, 'race-b') as never);

    const results = await Promise.all([
      retireIdeaAction('stop-returns', 'Reason A'),
      retireIdeaAction('stop-returns', 'Reason B'),
    ]);

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toEqual([{ ok: false, code: 'not_active' }]);

    const rows = (await ideaAuditRows()).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('idea.retire');
    expect([first.userId, second.userId]).toContain(rows[0]!.actorUserId);

    const row = await stored('stop-returns');
    expect(row!.status).toBe('retired');
    // The stored reason is the winner's, and the audit row agrees with it.
    expect(['Reason A', 'Reason B']).toContain(row!.retiredReason);
    expect(rows[0]!.reason).toBe(row!.retiredReason);
  });
});

describe('the audit trail', () => {
  it('every console action writes a row naming its operator and credential: session', async () => {
    await seedStore();
    const operator = await signInAs('operator');
    await updateIdeaAction('stop-returns', { pitch: 'Sharper.' });
    await retireIdeaAction('stop-returns', 'Done with it');
    const superadmin = await signInAs('superadmin');
    await deleteIdeaAction('contract-review', 'Added by mistake');

    const rows = (await ideaAuditRows()).filter((r) =>
      [operator.userId, superadmin.userId].includes(r.actorUserId ?? ''),
    );
    expect(rows.map((r) => [r.action, r.actorUserId])).toEqual([
      ['idea.update', operator.userId],
      ['idea.retire', operator.userId],
      ['idea.delete', superadmin.userId],
    ]);
    for (const row of rows) {
      expect(row.metadata).toMatchObject({ credential: { kind: 'session' } });
    }
  });
});

describe('the URL model', () => {
  const STATUSES: IdeaStatusView[] = ['active', 'retired', 'all'];
  const KINDS: (IdeaKind | undefined)[] = [undefined, 'direction', 'motir_buys'];
  const CATEGORIES: (IdeaCategory | undefined)[] = [undefined, 'ecommerce', 'legal'];
  const TAGS: (string | undefined)[] = [undefined, 'smb'];
  const QS: (string | undefined)[] = [undefined, 'returns'];

  const views: IdeaListView[] = [];
  for (const status of STATUSES)
    for (const kind of KINDS)
      for (const category of CATEGORIES)
        for (const tag of TAGS)
          for (const q of QS)
            views.push({
              status,
              ...(kind ? { kind } : {}),
              ...(category ? { category } : {}),
              ...(tag ? { tag } : {}),
              ...(q ? { q } : {}),
            });

  function paramsOf(href: string): Record<string, string> {
    return Object.fromEntries(new URL(href, 'https://motir.test').searchParams);
  }

  it(`round-trips every one of the ${views.length} filter combinations through the URL`, () => {
    for (const view of views) {
      expect(readIdeaListView(paramsOf(ideaListHref(view)))).toEqual(view);
    }
  });

  it('maps every combination to a service filter whose answer honours each filter', async () => {
    await seedStore();
    const seeder = await staffActor('operator', { kind: 'session' }, 'url-seeder');
    await ideasAdminService.addIdeas(seeder, [
      directionInput('returns-legal', { title: 'Returns for lawyers', category: 'legal' }),
      motirBuysInput('returns-shop', {
        title: 'Returns desk',
        category: 'ecommerce',
        tags: ['smb'],
      }),
    ]);
    await ideasAdminService.retireIdea(seeder, 'returns-shop', 'Retired for the matrix');
    const reader = await staffActor('support', { kind: 'session' }, 'url-reader');

    const all = await ideasAdminService.listForStaff(reader, {});
    expect(all.items).toHaveLength(4);

    let nonEmpty = 0;
    for (const view of views) {
      const query = toIdeaListQuery(view);
      const { items } = await ideasAdminService.listForStaff(reader, query);
      const expected = all.items.filter(
        (idea) =>
          (view.status === 'all' || idea.status === view.status) &&
          (!view.kind || idea.kind === view.kind) &&
          (!view.category || idea.category.slug === view.category) &&
          (!view.tag || idea.tags.some((t) => t.slug === view.tag)) &&
          (!view.q || /returns/i.test(`${idea.title} ${idea.pitch}`)),
      );
      expect(items.map((i) => i.slug).sort(), ideaListHref(view)).toEqual(
        expected.map((i) => i.slug).sort(),
      );
      if (items.length > 0) nonEmpty += 1;
    }
    // The matrix is not vacuous: plenty of combinations return something.
    expect(nonEmpty).toBeGreaterThan(10);
  });
});
