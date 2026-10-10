import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { DEFAULT_TOKEN_GRANT } from '@/lib/tokens/grant';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { adminDb } from '../helpers/adminDb';
import { runAsCloudBuild } from '../helpers/cloudBuild';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-7772 · MOTIR-7778 — the ASSEMBLED seam, over a real Postgres:
// STAFF write route → ideasAdminService → translation tables →
// ideasPublicService → PUBLIC read route. Each sibling tests its own half; the
// read sibling seeds translations through the repository on purpose, so nothing
// there sees what the staff routes actually store. Here every idea and tag the
// public side reads was written through a staff route handler, and nothing in
// between is stubbed.
//
// ⚠️ THE ONE SANCTIONED MOCK (CLAUDE.md): `getSession()`. The staff routes are
// driven with a real PAT, so the session arm only ever sees `null`, and the
// public routes never read it.
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => null),
}));

runAsCloudBuild();

const CACHE = 'public, s-maxage=300, stale-while-revalidate=3300';

beforeEach(async () => {
  vi.resetModules();
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
});

async function routes() {
  const [collection, one, retire, tags, tag, pubList, pubOne, pubTags] = await Promise.all([
    import('@/app/api/platform/ideas/route'),
    import('@/app/api/platform/ideas/[slug]/route'),
    import('@/app/api/platform/ideas/[slug]/retire/route'),
    import('@/app/api/platform/ideas/tags/route'),
    import('@/app/api/platform/ideas/tags/[slug]/route'),
    import('@/app/api/public/ideas/route'),
    import('@/app/api/public/ideas/[slug]/route'),
    import('@/app/api/public/ideas/tags/route'),
  ]);
  return { collection, one, retire, tags, tag, pubList, pubOne, pubTags };
}

type Routes = Awaited<ReturnType<typeof routes>>;

/** A PAT whose owner is platform `operator` staff — the credential the skill uses. */
async function operatorToken(): Promise<string> {
  const { owner, workspace } = await createTestWorkspace({ name: 'Ideas translation gate' });
  await adminDb.user.update({ where: { id: owner.id }, data: { platformRole: 'operator' } });
  const { token } = await apiTokensService.create(owner.id, workspace.id, {
    label: 'motir-ideas',
    fixedGrant: DEFAULT_TOKEN_GRANT,
  });
  return token;
}

const slugCtx = (slug: string) => ({ params: Promise.resolve({ slug }) });

interface Json {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function json(res: Response): Promise<Json> {
  return { status: res.status, body: await res.json() };
}

/** The staff side: every write and read goes through a route handler with a real PAT. */
function staff(r: Routes, token: string) {
  const req = (path: string, method = 'GET', body?: unknown) =>
    new Request(`http://localhost/api/platform/ideas${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    async addIdeas(ideas: unknown[]) {
      const res = await json(await r.collection.POST(req('', 'POST', { ideas })));
      expect(res.status).toBe(201);
      return res.body;
    },
    async addTag(body: unknown) {
      const res = await json(await r.tags.POST(req('/tags', 'POST', body)));
      expect(res.status).toBe(201);
      return res.body;
    },
    patchTag: async (slug: string, body: unknown) =>
      json(await r.tag.PATCH(req(`/tags/${slug}`, 'PATCH', body), slugCtx(slug))),
    async get(slug: string) {
      const res = await json(await r.one.GET(req(`/${slug}`), slugCtx(slug)));
      expect(res.status).toBe(200);
      return res.body;
    },
    patch: async (slug: string, body: unknown) =>
      json(await r.one.PATCH(req(`/${slug}`, 'PATCH', body), slugCtx(slug))),
    retire: async (slug: string, reason: string) =>
      json(await r.retire.POST(req(`/${slug}/retire`, 'POST', { reason }), slugCtx(slug))),
  };
}

/** The public side: anonymous, `?locale=` from the query string only. */
function pub(r: Routes) {
  const req = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://app.motir.co/api/public/ideas${path}`, { headers });
  return {
    async one(slug: string, qs = '') {
      return json(await r.pubOne.GET(req(`/${slug}${qs}`), slugCtx(slug)));
    },
    async detail(slug: string, qs = '') {
      const res = await this.one(slug, qs);
      expect(res.status).toBe(200);
      return res.body;
    },
    async list(qs = '') {
      const res = await json(await r.pubList.GET(req(qs)));
      expect(res.status).toBe(200);
      return res.body;
    },
    async tags(qs = '') {
      const res = await json(await r.pubTags.GET(req(`/tags${qs}`)));
      expect(res.status).toBe(200);
      return res.body;
    },
    raw: (slug: string, qs: string, headers: Record<string, string> = {}) =>
      r.pubOne.GET(req(`/${slug}${qs}`, headers), slugCtx(slug)),
  };
}

async function harness() {
  const r = await routes();
  return { s: staff(r, await operatorToken()), p: pub(r) };
}

const EVIDENCE = [
  {
    claim: 'Clinics book by phone.',
    sourceName: 'Clinic survey, March 2026',
    url: 'https://example.com/survey',
    sourceDate: '2026-03-01',
  },
  {
    claim: 'Most clinics run on paper.',
    sourceName: 'Trade report',
    url: 'https://example.com/report',
  },
];

/** A fully English `direction` idea with every field its kind has. */
function petClinics(extra: Record<string, unknown> = {}) {
  return {
    slug: 'pet-clinics',
    title: 'Pet clinics',
    pitch: 'Booking for small clinics.',
    kind: 'direction',
    category: 'pets',
    tags: ['smb'],
    capabilities: ['Takes bookings', 'Sends reminders'],
    evidence: EVIDENCE,
    gap: 'Nobody serves small clinics.',
    whyNow: 'Phones are too slow.',
    ...extra,
  };
}

const JA = {
  title: 'ペットクリニック',
  pitch: '小さなクリニックの予約。',
  capabilities: ['予約を受ける', 'リマインダーを送る'],
  gap: '小さなクリニックに誰も対応していない。',
  whyNow: '電話は遅すぎる。',
};

const KO = {
  title: '반려동물 병원',
  pitch: '작은 병원을 위한 예약.',
  capabilities: ['예약 받기', '알림 보내기'],
  gap: '아무도 작은 병원을 돕지 않는다.',
  whyNow: '전화는 너무 느리다.',
};

/** Fully translated in `ja` and `ko`, claims included, tag labelled in `ja`. */
async function seedTranslated(s: ReturnType<typeof staff>) {
  await s.addTag({
    slug: 'smb',
    label: 'Small business',
    description: 'Ideas for small businesses',
    labelTranslations: { ja: '中小企業', ko: '소기업' },
  });
  await s.addIdeas([
    petClinics({
      evidence: [
        {
          ...EVIDENCE[0],
          claimTranslations: { ja: 'クリニックは電話で予約する。', ko: '전화 예약.' },
        },
        { ...EVIDENCE[1], claimTranslations: { ja: '多くは紙で運営。', ko: '대부분 종이.' } },
      ],
      translations: { ja: JA, ko: KO },
    }),
  ]);
}

describe('the staff write is what the public read serves', () => {
  it('1 · a full translation round-trips exactly, with nothing falling back', async () => {
    const { s, p } = await harness();
    await seedTranslated(s);

    const ja = await p.detail('pet-clinics', '?locale=ja');
    expect(ja).toMatchObject({ locale: 'ja', fallbackFields: [], ...JA });
    expect(ja.evidence.map((e: { claim: string }) => e.claim)).toEqual([
      'クリニックは電話で予約する。',
      '多くは紙で運営。',
    ]);
    expect(ja.evidence.every((e: { claimFallback: boolean }) => !e.claimFallback)).toBe(true);
    expect(ja.tags).toEqual([{ slug: 'smb', label: '中小企業', labelFallback: false }]);

    // What is never translated equals the English row's.
    const en = await p.detail('pet-clinics');
    const untranslated = (e: Record<string, unknown>) => ({
      sourceName: e.sourceName,
      url: e.url,
      sourceDate: e.sourceDate,
    });
    expect(ja.evidence.map(untranslated)).toEqual(en.evidence.map(untranslated));
    for (const key of ['slug', 'kind', 'category', 'addedAt', 'lastReviewedAt'] as const) {
      expect(ja[key]).toEqual(en[key]);
    }
    expect(en).toMatchObject({ locale: 'en', fallbackFields: [], title: 'Pet clinics' });
  });

  it('2 · a partial translation falls back per field, and the staff and public views agree', async () => {
    const { s, p } = await harness();
    await s.addTag({ slug: 'smb', label: 'Small business', description: 'Ideas for SMBs' });
    await s.addIdeas([
      petClinics({
        whyNow: undefined,
        evidence: [
          { ...EVIDENCE[0], claimTranslations: { ja: 'クリニックは電話で予約する。' } },
          EVIDENCE[1],
        ],
        translations: { ja: { title: JA.title, pitch: JA.pitch } },
      }),
    ]);

    const ja = await p.detail('pet-clinics', '?locale=ja');
    expect(ja.title).toBe(JA.title);
    expect(ja.pitch).toBe(JA.pitch);
    expect(ja.capabilities).toEqual(['Takes bookings', 'Sends reminders']);
    expect(ja.gap).toBe('Nobody serves small clinics.');
    // The null-English `whyNow` was never missing, so it is not named.
    expect(ja.whyNow).toBeNull();
    expect(ja.fallbackFields).toEqual(['capabilities', 'gap']);
    expect(ja.evidence.map((e: { claimFallback: boolean }) => e.claimFallback)).toEqual([
      false,
      true,
    ]);

    // The SAME stored row, read by the staff door.
    const row = await s.get('pet-clinics');
    expect(row.missingLocales).toContain('ja');
    expect(row.translations.ja).toEqual({ title: JA.title, pitch: JA.pitch });
  });

  it('3 · an English edit drops the stale locales, and the public read falls back on that field only', async () => {
    const { s, p } = await harness();
    await seedTranslated(s);

    // The console's shape: English only, no translations, no stamp.
    expect((await s.patch('pet-clinics', { pitch: 'Booking for every clinic.' })).status).toBe(200);

    for (const [locale, text] of [
      ['ja', JA],
      ['ko', KO],
    ] as const) {
      const body = await p.detail('pet-clinics', `?locale=${locale}`);
      expect(body.pitch).toBe('Booking for every clinic.');
      expect(body.fallbackFields).toEqual(['pitch']);
      expect(body.title).toBe(text.title);
      expect(body.gap).toBe(text.gap);
      expect(body.capabilities).toEqual(text.capabilities);
    }

    // The old Japanese pitch is served nowhere.
    const everything = JSON.stringify([
      await p.list('?locale=ja'),
      await p.list('?locale=ko'),
      await p.detail('pet-clinics', '?locale=ja'),
    ]);
    expect(everything).not.toContain(JA.pitch);
  });

  it('4 · re-supplying the translation in the same write keeps it', async () => {
    const { s, p } = await harness();
    await seedTranslated(s);
    const { updatedAt } = await s.get('pet-clinics');

    const res = await s.patch('pet-clinics', {
      pitch: 'Booking for every clinic.',
      expectedUpdatedAt: updatedAt,
      translations: { ja: { pitch: 'すべてのクリニックの予約。' } },
    });
    expect(res.status).toBe(200);

    const ja = await p.detail('pet-clinics', '?locale=ja');
    expect(ja.pitch).toBe('すべてのクリニックの予約。');
    expect(ja.fallbackFields).toEqual([]);
    const ko = await p.detail('pet-clinics', '?locale=ko');
    expect(ko.pitch).toBe('Booking for every clinic.');
    expect(ko.fallbackFields).toEqual(['pitch']);
  });

  it('5 · re-filling a dropped field through the doors the skill uses', async () => {
    const { s, p } = await harness();
    await seedTranslated(s);
    await s.patch('pet-clinics', { pitch: 'Booking for every clinic.' });

    const before = await s.get('pet-clinics');
    expect(before.missingLocales).toEqual(expect.arrayContaining(['ja', 'ko']));

    const fill = await s.patch('pet-clinics', {
      expectedUpdatedAt: before.updatedAt,
      translations: { ja: { pitch: 'すべてのクリニックの予約。' } },
    });
    expect(fill.status).toBe(200);

    expect(await p.detail('pet-clinics', '?locale=ja')).toMatchObject({
      pitch: 'すべてのクリニックの予約。',
      fallbackFields: [],
    });
    const after = await s.get('pet-clinics');
    expect(after.missingLocales).not.toContain('ja');
    expect(after.missingLocales).toContain('ko');
  });

  it('6 · evidence replaced wholesale keeps no old claim translation', async () => {
    const { s, p } = await harness();
    await seedTranslated(s);

    const res = await s.patch('pet-clinics', {
      evidence: [
        {
          claim: 'Vets lose bookings.',
          sourceName: 'A new source',
          url: 'https://example.com/new',
          claimTranslations: { de: 'Tierärzte verlieren Buchungen.' },
        },
      ],
    });
    expect(res.status).toBe(200);

    const ja = await p.detail('pet-clinics', '?locale=ja');
    expect(ja.evidence).toEqual([
      expect.objectContaining({ claim: 'Vets lose bookings.', claimFallback: true }),
    ]);
    const de = await p.detail('pet-clinics', '?locale=de');
    expect(de.evidence).toEqual([
      expect.objectContaining({ claim: 'Tierärzte verlieren Buchungen.', claimFallback: false }),
    ]);
  });

  it('7 · a tag label written by the tag route is served by every public read', async () => {
    const { s, p } = await harness();
    await seedTranslated(s);
    expect((await s.patchTag('smb', { labelTranslations: { pl: 'Małe firmy' } })).status).toBe(200);

    const plTags = await p.tags('?locale=pl');
    expect(plTags.tags).toEqual([
      expect.objectContaining({ slug: 'smb', label: 'Małe firmy', labelFallback: false }),
    ]);
    const plList = await p.list('?locale=pl');
    for (const item of plList.items) {
      expect(item.tags).toEqual([{ slug: 'smb', label: 'Małe firmy', labelFallback: false }]);
    }
    expect((await p.detail('pet-clinics', '?locale=pl')).tags[0].label).toBe('Małe firmy');

    // A locale the tag route never wrote serves the English, marked.
    const itTags = await p.tags('?locale=it');
    expect(itTags.tags[0]).toMatchObject({ label: 'Small business', labelFallback: true });
    expect((await p.detail('pet-clinics', '?locale=it')).tags[0]).toEqual({
      slug: 'smb',
      label: 'Small business',
      labelFallback: true,
    });
    // The merge kept the label written at add time.
    expect((await p.tags('?locale=ja')).tags[0]).toMatchObject({
      label: '中小企業',
      labelFallback: false,
    });
  });

  it('8 · a grown English capabilities list drops the translated list; a wrong length is never served', async () => {
    const { s, p } = await harness();
    await seedTranslated(s);

    const res = await s.patch('pet-clinics', {
      capabilities: ['Takes bookings', 'Sends reminders', 'Takes payments'],
    });
    expect(res.status).toBe(200);

    const ja = await p.detail('pet-clinics', '?locale=ja');
    expect(ja.capabilities).toEqual(['Takes bookings', 'Sends reminders', 'Takes payments']);
    expect(ja.fallbackFields).toEqual(['capabilities']);
    expect(ja.title).toBe(JA.title);
    expect((await s.get('pet-clinics')).translations.ja.capabilities).toBeUndefined();

    // A list of the wrong length cannot even be written.
    const { updatedAt } = await s.get('pet-clinics');
    const wrong = await s.patch('pet-clinics', {
      expectedUpdatedAt: updatedAt,
      translations: { ja: { capabilities: ['一', '二'] } },
    });
    expect(wrong).toMatchObject({ status: 400, body: { code: 'TRANSLATION_SHAPE_MISMATCH' } });
    expect((await p.detail('pet-clinics', '?locale=ja')).fallbackFields).toEqual(['capabilities']);
  });

  it('9 · q matches the text the staff route wrote, in that locale only', async () => {
    const { s, p } = await harness();
    await seedTranslated(s);
    await s.addIdeas([
      petClinics({
        slug: 'phoenix',
        title: 'Rebirth',
        tags: [],
        translations: { ja: { title: '不死鳥の再生' } },
      }),
    ]);

    const slugs = async (qs: string) =>
      (await p.list(qs)).items.map((i: { slug: string }) => i.slug);
    const word = encodeURIComponent('不死鳥');
    expect(await slugs(`?locale=ja&q=${word}`)).toEqual(['phoenix']);
    expect(await slugs(`?locale=ko&q=${word}`)).toEqual([]);
    expect(await slugs(`?q=${word}`)).toEqual([]);
  });

  it('10 · the locale is the cache key; Accept-Language is not', async () => {
    const { s, p } = await harness();
    await seedTranslated(s);

    const ja = await p.raw('pet-clinics', '?locale=ja');
    const ko = await p.raw('pet-clinics', '?locale=ko');
    expect(await ja.text()).not.toBe(await ko.text());

    const asJa = await p.raw('pet-clinics', '', { 'accept-language': 'ja-JP,ja;q=0.9' });
    const asDe = await p.raw('pet-clinics', '', { 'accept-language': 'de-DE,de;q=0.9' });
    const [jaText, deText] = [await asJa.text(), await asDe.text()];
    expect(jaText).toBe(deText);
    expect(JSON.parse(jaText).locale).toBe('en');

    for (const res of [ja, ko, asJa, asDe]) {
      expect(res.headers.get('cache-control')).toBe(CACHE);
      expect(res.headers.get('vary') ?? '').not.toMatch(/accept-language/i);
    }
  });

  it('11 · retiring an idea removes it in every language', async () => {
    const { s, p } = await harness();
    await seedTranslated(s);
    expect((await s.retire('pet-clinics', 'Merged elsewhere')).status).toBe(200);

    for (const qs of ['', '?locale=ja', '?locale=ko']) {
      const list = await p.list(qs);
      expect(list.items.map((i: { slug: string }) => i.slug)).not.toContain('pet-clinics');
    }
    const retired = await p.one('pet-clinics', '?locale=ja');
    const unknown = await p.one('never-existed', '?locale=ja');
    expect(retired).toEqual({ status: 404, body: { code: 'IDEA_NOT_FOUND' } });
    expect(unknown).toEqual(retired);
  });

  it('12 · a refused write leaves the public read untouched', async () => {
    const { s, p } = await harness();
    await seedTranslated(s);
    const before = await p.detail('pet-clinics', '?locale=ja');
    const { updatedAt } = await s.get('pet-clinics');

    for (const key of ['xx', 'en']) {
      const res = await s.patch('pet-clinics', {
        expectedUpdatedAt: updatedAt,
        translations: { [key]: { pitch: 'Overwritten.' } },
      });
      expect(res).toMatchObject({ status: 400, body: { code: 'UNSUPPORTED_LOCALE' } });
    }
    const stale = await s.patch('pet-clinics', {
      expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
      translations: { ja: { pitch: 'Overwritten.' } },
    });
    expect(stale).toMatchObject({ status: 409, body: { code: 'IDEA_CHANGED' } });

    expect(await p.detail('pet-clinics', '?locale=ja')).toEqual(before);
  });
});
