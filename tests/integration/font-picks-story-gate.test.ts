import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  LOCALE_FONT_SET,
  buildThemeInitScript,
  fontSetPickAttributes,
  resolveFontSet,
  resolveFontSetMember,
  type FontSetLocale,
  type ThemeInitFontSets,
} from '@motir/design-system';
import { appearancePreferenceService } from '@/lib/services/appearancePreferenceService';
import { accountDeletionService } from '@/lib/services/accountDeletionService';
import { accountErasureSweepService } from '@/lib/services/accountErasureSweepService';
import { userAppearancePreferenceRepository } from '@/lib/repositories/userAppearancePreferenceRepository';
import { PERSONAL_DATA_SECTIONS, readSection } from '@/lib/export/personalDataSections';
import { withUserContext } from '@/lib/workspaces/context';
import { fontSetHtmlAttrs } from '@/lib/appearance/fontPicks';
import { TYPE_IDS } from '@/lib/theme/typography';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { SEAM_BODY, SEAM_LOCALE } from '../helpers/fontPicksSeam';

// STORY INTEGRATION GATE (motir-core) — MOTIR-7900, over story MOTIR-7736 (pick
// your font per language).
//
// The five predecessors (MOTIR-7894 store, MOTIR-7896 first byte, MOTIR-7897
// setFontPick, MOTIR-7898 export and erasure, MOTIR-7899 the Typography axis)
// each proved their own layer. This file measures the layers TOGETHER, where a
// mismatch between two correct halves is the failure: the server stamping an
// attribute the client would not, a refused value half-written, a stale member
// reaching `<html>`, a pick surviving an erasure. Real Postgres throughout; the
// compliance gate is the one stub (a route test has no cookie jar), copied from
// `tests/appearance/route.test.ts`. The client half of the parity seam needs a
// DOM and lives in `tests/components/font-picks-story-gate.test.tsx`.
//
// ⚠️ No `data-font-set-*` value is written out by hand here: every expected
// attribute set is computed by `fontSetPickAttributes`, the derivation the
// client's `setFontPick` uses, so server and helper cannot drift unseen.

const { requireCompliantSession } = vi.hoisted(() => ({ requireCompliantSession: vi.fn() }));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantSession }));

const { GET, PATCH } = await import('@/app/api/appearance-preference/route');
const { createTestUser } = await import('../fixtures');

/** The three choosable (locale, non-default member) pairs the story ships. */
const PAIRS = [
  ['ja', 'm-plus-rounded-1c'],
  ['ko', 'nanum-gothic'],
  ['zh', 'lxgw-wenkai-tc'],
] as const satisfies ReadonlyArray<readonly [FontSetLocale, string]>;

const SECTION = PERSONAL_DATA_SECTIONS.find((s) => s.table === 'user_appearance_preference')!;

async function signedInUser(): Promise<string> {
  const user = await createTestUser();
  requireCompliantSession.mockResolvedValue({
    ok: true,
    session: { user: { id: user.id, email: user.email } },
  });
  return user.id;
}

function patch(body: unknown): Promise<Response> {
  return PATCH(
    new Request('http://localhost:3000/api/appearance-preference', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** One `font_pick_<locale>` column, read straight from the table as the owner. */
async function pickColumn(userId: string, locale: FontSetLocale): Promise<string | null> {
  const rows = await adminDb.$queryRawUnsafe<Array<{ v: string | null }>>(
    `SELECT "font_pick_${locale}" AS v FROM "user_appearance_preference" WHERE "user_id" = $1`,
    userId,
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.v;
}

/** The WHOLE row, every column, as the owner sees it (or null). */
async function wholeRow(userId: string): Promise<Record<string, unknown> | null> {
  const rows = await adminDb.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT * FROM "user_appearance_preference" WHERE "user_id" = $1`,
    userId,
  );
  return rows[0] ?? null;
}

/**
 * Run the real init script against a fake window/document (the
 * `stampedPalette` pattern of the palette-rename gate) and return the
 * `data-font-set-*` attributes `<html>` carries afterwards. `storage` is the
 * device's localStorage, shared between runs to model one device; `preset` is
 * what `<html>` carried before the script ran.
 */
function stampedFontSets(
  script: string,
  lang: string,
  storage: Map<string, string>,
  preset: Record<string, string> = {},
): Record<string, string> {
  const attributes = new Map<string, string>(Object.entries(preset));
  attributes.set('lang', lang);
  new Function('window', 'document', script)(
    {
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
        removeItem: (k: string) => void storage.delete(k),
      },
      matchMedia: () => ({ matches: false }),
    },
    {
      documentElement: {
        getAttribute: (k: string) => attributes.get(k) ?? null,
        setAttribute: (k: string, v: string) => void attributes.set(k, v),
        removeAttribute: (k: string) => void attributes.delete(k),
      },
    },
  );
  return Object.fromEntries([...attributes].filter(([k]) => k.startsWith('data-font-set-')));
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('seam — PATCH → row → getAppliedForRequest → <html>', () => {
  it.each(PAIRS)('%s → %s', async (locale, member) => {
    const userId = await signedInUser();
    const expected = fontSetPickAttributes(locale, member);
    // The pair is a real, non-default choice: it must stamp something.
    expect(Object.keys(expected).length).toBeGreaterThan(0);

    const body = { fontPicks: { [locale]: member } };
    // The ja pair's body is the one the client half sends (the DOM gate file).
    if (locale === SEAM_LOCALE) expect(body).toEqual(SEAM_BODY);
    const res = await patch(body);
    expect(res.status).toBe(200);
    expect((await res.json()).preference.fontPicks[locale]).toBe(member);

    expect(await pickColumn(userId, locale)).toBe(member);

    const { fontSetAttrs } = await appearancePreferenceService.getAppliedForRequest(userId);
    expect(fontSetAttrs[locale]).toEqual(expected);
    // What `app/layout.tsx` spreads onto <html> for a page in that language…
    expect(fontSetHtmlAttrs(fontSetAttrs, locale)).toEqual(expected);
    // …and for a page in any other language, nothing.
    const other = PAIRS.find(([l]) => l !== locale)![0];
    expect(fontSetHtmlAttrs(fontSetAttrs, other)).toEqual({});
    expect(fontSetHtmlAttrs(fontSetAttrs, 'en')).toEqual({});
    // A region-tagged page selects the same entry; an unknown language none.
    expect(fontSetHtmlAttrs(fontSetAttrs, ` ${locale.toUpperCase()}-XX `)).toEqual(expected);
    expect(fontSetHtmlAttrs(fontSetAttrs, 'xx-YY')).toEqual({});

    // The init script on the first byte stamps exactly those attributes, caches
    // them on the device, re-applies them from that cache on the error page,
    // and a signed-out render removes them.
    const device = new Map<string, string>();
    const server: ThemeInitFontSets = { mode: 'server', byLocale: fontSetAttrs };
    expect(stampedFontSets(buildThemeInitScript(null, server), locale, device)).toEqual(expected);
    expect(stampedFontSets(buildThemeInitScript(null, { mode: 'cached' }), locale, device)).toEqual(
      expected,
    );
    expect(
      stampedFontSets(buildThemeInitScript(null, { mode: 'clear' }), locale, device, expected),
    ).toEqual({});
    // The clear also dropped the cache, so a later error page draws no pick.
    expect(stampedFontSets(buildThemeInitScript(null, { mode: 'cached' }), locale, device)).toEqual(
      {},
    );
  });
});

describe('pick only a font', () => {
  it('keeps the four device-local axes unowned: appearance null, a ja entry beside it', async () => {
    const userId = await signedInUser();
    expect((await patch({ fontPicks: { ja: 'm-plus-rounded-1c' } })).status).toBe(200);

    const applied = await appearancePreferenceService.getAppliedForRequest(userId);
    expect(applied.appearance).toBeNull();
    expect(Object.keys(applied.fontSetAttrs)).toEqual(['ja']);
    expect(applied.fontSetAttrs.ja).toEqual(fontSetPickAttributes('ja', 'm-plus-rounded-1c'));
  });
});

describe('a font pick beside a pinned axis', () => {
  it('the first byte carries both: the applied axes and the page language’s pick', async () => {
    const userId = await signedInUser();
    const typeId = TYPE_IDS[1]!;
    expect((await patch({ typeId, fontPicks: { ja: 'm-plus-rounded-1c' } })).status).toBe(200);

    const { appearance, fontSetAttrs } =
      await appearancePreferenceService.getAppliedForRequest(userId);
    expect(appearance).toMatchObject({ typeId, typePinned: true });
    const expected = fontSetPickAttributes('ja', 'm-plus-rounded-1c');
    const script = buildThemeInitScript(appearance, { mode: 'server', byLocale: fontSetAttrs });
    expect(stampedFontSets(script, 'ja', new Map())).toEqual(expected);
  });
});

describe('default pick', () => {
  it('stores the default member, and stamps nothing so the :lang() default draws', async () => {
    const userId = await signedInUser();
    const res = await patch({ fontPicks: { ja: 'noto-sans-jp' } });
    expect(res.status).toBe(200);
    expect((await res.json()).preference.fontPicks).toEqual({ ja: 'noto-sans-jp' });
    expect(await pickColumn(userId, 'ja')).toBe('noto-sans-jp');

    const { fontSetAttrs } = await appearancePreferenceService.getAppliedForRequest(userId);
    expect(fontSetAttrs).not.toHaveProperty('ja');
    expect(fontSetPickAttributes('ja', 'noto-sans-jp')).toEqual({});
  });
});

describe('refusals write nothing', () => {
  const SEEDED_TYPE = TYPE_IDS[0]!;
  const OTHER_TYPE = TYPE_IDS.find((id) => id !== SEEDED_TYPE)!;

  async function seeded(): Promise<{ userId: string; before: Record<string, unknown> }> {
    const userId = await signedInUser();
    const res = await patch({ typeId: SEEDED_TYPE, fontPicks: { ja: 'm-plus-rounded-1c' } });
    expect(res.status).toBe(200);
    const before = await wholeRow(userId);
    expect(before).toMatchObject({ type_id: SEEDED_TYPE, font_pick_ja: 'm-plus-rounded-1c' });
    return { userId, before: before! };
  }

  it.each([
    ["another locale's member", { fontPicks: { ja: 'nanum-gothic' } }],
    ['an unknown member', { fontPicks: { ja: 'no-such-font' } }],
    ['the Latin placeholder on en', { fontPicks: { en: 'type-pairing' } }],
    ['a CJK member on a Latin locale (de)', { fontPicks: { de: 'noto-sans-jp' } }],
    [
      'a valid typeId beside a bad ko pick',
      { typeId: OTHER_TYPE, fontPicks: { ko: 'noto-sans-jp' } },
    ],
  ])('refuses %s with 422 and leaves the whole row as it was', async (_label, body) => {
    expect(OTHER_TYPE).toBeDefined();
    const { userId, before } = await seeded();

    const res = await patch(body);

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('INVALID_APPEARANCE_VALUE');
    // Every column, `type_id` and `updated_at` included — a refused body is
    // refused whole, never half-written.
    expect(await wholeRow(userId)).toEqual(before);
  });

  it('accepts absence on a Latin locale — { en: null } → 200', async () => {
    const { userId } = await seeded();
    const res = await patch({ fontPicks: { en: null } });
    expect(res.status).toBe(200);
    expect(await pickColumn(userId, 'en')).toBeNull();
    expect(await pickColumn(userId, 'ja')).toBe('m-plus-rounded-1c');
  });
});

describe('refusals at the transport write nothing either', () => {
  function rawPatch(body: string): Promise<Response> {
    return PATCH(
      new Request('http://localhost:3000/api/appearance-preference', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
  }

  it.each([
    ['a body that is not JSON', '{"fontPicks":'],
    ['a JSON array', JSON.stringify([{ fontPicks: { ja: 'nanum-gothic' } }])],
    ['an unknown field beside a pick', JSON.stringify({ fontPicks: { ko: 'nanum-gothic' }, x: 1 })],
    [
      'a non-string axis beside a pick',
      JSON.stringify({ typeId: 3, fontPicks: { ko: 'nanum-gothic' } }),
    ],
    ['fontPicks: null', JSON.stringify({ fontPicks: null })],
  ])('refuses %s with 400 and leaves the whole row as it was', async (_label, body) => {
    const userId = await signedInUser();
    await patch({ fontPicks: { ja: 'm-plus-rounded-1c' } });
    const before = await wholeRow(userId);

    const res = await rawPatch(body);

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('BAD_REQUEST');
    expect(await wholeRow(userId)).toEqual(before);
  });

  it('signed out, neither verb reaches the row', async () => {
    const userId = await signedInUser();
    await patch({ fontPicks: { ja: 'm-plus-rounded-1c' } });
    const before = await wholeRow(userId);
    const refusal = Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
    requireCompliantSession.mockResolvedValue({ ok: false, response: refusal });

    expect((await patch({ fontPicks: { ja: null } })).status).toBe(401);
    expect((await GET()).status).toBe(401);
    expect(await wholeRow(userId)).toEqual(before);
  });

  it('a database failure is not dressed up as a 422 — it propagates', async () => {
    // A session whose user has no row in `user` (deleted mid-session): the
    // upsert's foreign key refuses it, and the route rethrows rather than
    // mapping an error it does not own.
    requireCompliantSession.mockResolvedValue({
      ok: true,
      session: { user: { id: 'no-such-user', email: 'ghost@example.com' } },
    });
    await expect(patch({ fontPicks: { ja: 'm-plus-rounded-1c' } })).rejects.toThrow();
    expect(await wholeRow('no-such-user')).toBeNull();
  });
});

describe('the service tolerates what the transport never sends', () => {
  it('an undefined pick and a cleared non-locale key are skipped, not written', async () => {
    const userId = await signedInUser();
    await patch({ fontPicks: { ja: 'm-plus-rounded-1c' } });
    const before = await wholeRow(userId);

    const dto = await appearancePreferenceService.update(userId, {
      fontPicks: { ja: undefined, xx: null } as unknown as Record<FontSetLocale, string | null>,
    });

    expect(dto.fontPicks).toEqual({ ja: 'm-plus-rounded-1c' });
    expect(await wholeRow(userId)).toMatchObject({
      font_pick_ja: before!.font_pick_ja,
      type_id: null,
    });
  });
});

describe('clear', () => {
  it('null clears one locale and leaves another locale on the same row untouched', async () => {
    const userId = await signedInUser();
    await patch({ fontPicks: { ja: 'm-plus-rounded-1c', ko: 'nanum-gothic' } });

    const res = await patch({ fontPicks: { ja: null } });

    expect(res.status).toBe(200);
    expect((await res.json()).preference.fontPicks).toEqual({ ko: 'nanum-gothic' });
    expect(await pickColumn(userId, 'ja')).toBeNull();
    expect(await pickColumn(userId, 'ko')).toBe('nanum-gothic');
    const { fontSetAttrs } = await appearancePreferenceService.getAppliedForRequest(userId);
    expect(fontSetAttrs).not.toHaveProperty('ja');
    expect(fontSetAttrs.ko).toEqual(fontSetPickAttributes('ko', 'nanum-gothic'));
  });
});

describe('stale member', () => {
  it('a member that left the registry reads as automatic and never reaches <html>', async () => {
    const userId = await signedInUser();
    await patch({ fontPicks: { ko: 'nanum-gothic' } });
    await adminDb.$executeRawUnsafe(
      `UPDATE "user_appearance_preference" SET "font_pick_ja" = 'retired-font' WHERE "user_id" = $1`,
      userId,
    );

    const resolved = await appearancePreferenceService.getResolved(userId);
    expect(resolved.fontPicks).not.toHaveProperty('ja');
    expect(resolved.fontPicks.ko).toBe('nanum-gothic');

    const { fontSetAttrs } = await appearancePreferenceService.getAppliedForRequest(userId);
    expect(fontSetAttrs).not.toHaveProperty('ja');
    expect(fontSetHtmlAttrs(fontSetAttrs, 'ja')).toEqual({});
    expect(fontSetAttrs.ko).toEqual(fontSetPickAttributes('ko', 'nanum-gothic'));

    // And the registry, asked for that member, answers with the role's default
    // in the page language's own set — never another set's face.
    const jaSet = resolveFontSet('ja-JP');
    expect(jaSet).toBe(resolveFontSet('ja'));
    expect(resolveFontSet('xx')).not.toBe(jaSet);
    expect(resolveFontSetMember(LOCALE_FONT_SET.ja, 'sans', 'retired-font').id).toBe(
      jaSet.roles.sans.default,
    );
    expect(resolveFontSetMember(LOCALE_FONT_SET.ja, 'sans').id).toBe(jaSet.roles.sans.default);
    expect(resolveFontSetMember(LOCALE_FONT_SET.ja, 'sans', 'm-plus-rounded-1c').id).toBe(
      'm-plus-rounded-1c',
    );
  });
});

describe('export', () => {
  it('the user_appearance_preference section carries both picks in one row', async () => {
    const userId = await signedInUser();
    expect((await patch({ fontPicks: { ja: 'm-plus-rounded-1c' } })).status).toBe(200);
    expect((await patch({ fontPicks: { ko: 'nanum-gothic' } })).status).toBe(200);

    const rows = (await withUserContext(userId, (tx) => readSection(SECTION, userId, tx))) as Array<
      Record<string, unknown>
    >;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId,
      fontPickJa: 'm-plus-rounded-1c',
      fontPickKo: 'nanum-gothic',
    });
  });
});

describe('erasure', () => {
  it('a due erasure removes the picks, and the first byte stamps nothing after it', async () => {
    const userId = await signedInUser();
    await patch({ fontPicks: { ja: 'm-plus-rounded-1c', zh: 'lxgw-wenkai-tc' } });
    expect(await userAppearancePreferenceRepository.findByUserId(userId)).not.toBeNull();

    // Schedule through the product, then age the request so it is due (the
    // `scheduleDue` fixture of `tests/account-erasure-sweep.test.ts`).
    const dto = await accountDeletionService.scheduleAccountDeletion(userId);
    const DAY_MS = 24 * 60 * 60 * 1000;
    const requestedAt = new Date(Date.now() - 31 * DAY_MS);
    await adminDb.accountDeletionRequest.update({
      where: { id: dto.id },
      data: { requestedAt, erasureDueAt: new Date(requestedAt.getTime() + 30 * DAY_MS) },
    });

    const summary = await accountErasureSweepService.sweep();

    expect(summary).toMatchObject({ erased: 1, failed: 0 });
    expect(await userAppearancePreferenceRepository.findByUserId(userId)).toBeNull();
    expect(await appearancePreferenceService.getAppliedForRequest(userId)).toEqual({
      appearance: null,
      fontSetAttrs: {},
    });
  });
});
