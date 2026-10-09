import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { appearancePreferenceService } from '@/lib/services/appearancePreferenceService';
import { InvalidAppearanceValueError } from '@/lib/appearance/errors';
import { THEME_DEFAULTS } from '@/lib/theme/types';
import { DEFAULT_STYLE_ID } from '@/lib/theme/styles';
import { DEFAULT_PALETTE_ID } from '@/lib/theme/palettes';
import { DEFAULT_TYPE_ID } from '@/lib/theme/typography';
import { userAppearancePreferenceRepository } from '@/lib/repositories/userAppearancePreferenceRepository';
import { createTestUser } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// Service-layer tests for the cross-device appearance-preference business logic
// (Story 7.3 · Subtask 7.3.60): appearancePreferenceService.getResolved /
// update — default resolution for an untouched user, partial-update persistence
// + sibling preservation, registry validation of incoming ids, and the
// single-transaction upsert idempotency. Real Postgres (no mocks), per
// CLAUDE.md; truncateAuthTables cascades user → user_appearance_preference.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('appearancePreferenceService.getResolved', () => {
  it('resolves all four axes to their defaults for an untouched user (no row)', async () => {
    const user = await createTestUser();

    const dto = await appearancePreferenceService.getResolved(user.id);

    expect(dto).toEqual({
      pattern: THEME_DEFAULTS.pattern,
      styleId: DEFAULT_STYLE_ID,
      paletteId: DEFAULT_PALETTE_ID,
      typeId: DEFAULT_TYPE_ID,
      fontPicks: {},
    });
    // Reading never creates a row — absence stays absence.
    expect(await userAppearancePreferenceRepository.findByUserId(user.id)).toBeNull();
  });
});

describe('appearancePreferenceService.getApplied', () => {
  it('returns null for an untouched user (no row) — no server value to honour', async () => {
    const user = await createTestUser();

    // No stored preference → null, so the caller uses the localStorage path
    // (anonymous behaviour); a present-but-empty server pref must not clobber a
    // signed-in user's device-local choice.
    expect(await appearancePreferenceService.getApplied(user.id)).toBeNull();
    expect(await userAppearancePreferenceRepository.findByUserId(user.id)).toBeNull();
  });

  it('returns null when every axis has been cleared back to default (row all-null)', async () => {
    const user = await createTestUser();
    await appearancePreferenceService.update(user.id, { pattern: 'dark' });
    await appearancePreferenceService.update(user.id, { pattern: null });

    // The row exists but carries no real choice → treated as no preference.
    expect(await userAppearancePreferenceRepository.findByUserId(user.id)).not.toBeNull();
    expect(await appearancePreferenceService.getApplied(user.id)).toBeNull();
  });

  it('follows the active STYLE default type when the user pinned no type', async () => {
    const user = await createTestUser();
    // swiss-minimal-flat's defaultTypeId is `motir-sans` (≠ the global default),
    // so an unpinned type must apply the STYLE default, not `motir` — the
    // precedence 7.3.60 deferred to this subtask.
    await appearancePreferenceService.update(user.id, { styleId: 'swiss-minimal-flat' });

    const applied = await appearancePreferenceService.getApplied(user.id);

    expect(applied).toEqual({
      pattern: THEME_DEFAULTS.pattern,
      styleId: 'swiss-minimal-flat',
      paletteId: DEFAULT_PALETTE_ID,
      typeId: 'motir-sans',
      typePinned: false,
    });
  });

  it('keeps an explicitly pinned type and marks it pinned', async () => {
    const user = await createTestUser();
    await appearancePreferenceService.update(user.id, {
      pattern: 'dark',
      styleId: 'swiss-minimal-flat',
      typeId: 'editorial',
    });

    const applied = await appearancePreferenceService.getApplied(user.id);

    expect(applied).toEqual({
      pattern: 'dark',
      styleId: 'swiss-minimal-flat',
      paletteId: DEFAULT_PALETTE_ID,
      typeId: 'editorial',
      typePinned: true,
    });
  });
});

describe('appearancePreferenceService.update', () => {
  it('persists a partial patch, resolves the rest to defaults, and returns the DTO', async () => {
    const user = await createTestUser();

    const returned = await appearancePreferenceService.update(user.id, {
      pattern: 'dark',
      styleId: 'soft-playful',
    });

    // The two pinned axes take the given value; the unpinned two resolve to
    // their defaults in the DTO.
    expect(returned).toEqual({
      pattern: 'dark',
      styleId: 'soft-playful',
      paletteId: DEFAULT_PALETTE_ID,
      typeId: DEFAULT_TYPE_ID,
      fontPicks: {},
    });
    // A fresh read returns the same resolved shape (it persisted).
    expect(await appearancePreferenceService.getResolved(user.id)).toEqual(returned);
  });

  it('leaves already-pinned sibling axes untouched on a later partial patch', async () => {
    const user = await createTestUser();
    await appearancePreferenceService.update(user.id, { pattern: 'dark', styleId: 'soft-playful' });

    const after = await appearancePreferenceService.update(user.id, { paletteId: 'cobalt' });

    expect(after).toEqual({
      pattern: 'dark',
      styleId: 'soft-playful',
      paletteId: 'cobalt',
      typeId: DEFAULT_TYPE_ID,
      fontPicks: {},
    });
    // Still exactly one row for the user (upsert patched, didn't insert anew).
    expect(await db.userAppearancePreference.count({ where: { userId: user.id } })).toBe(1);
  });

  it('clears an axis back to its default when passed null explicitly', async () => {
    const user = await createTestUser();
    await appearancePreferenceService.update(user.id, { pattern: 'dark' });

    const cleared = await appearancePreferenceService.update(user.id, { pattern: null });

    expect(cleared.pattern).toBe(THEME_DEFAULTS.pattern);
    const row = await userAppearancePreferenceRepository.findByUserId(user.id);
    expect(row?.pattern).toBeNull();
  });

  it('is idempotent: re-applying the same patch keeps one row and the same DTO', async () => {
    const user = await createTestUser();

    const first = await appearancePreferenceService.update(user.id, { paletteId: 'motir' });
    const second = await appearancePreferenceService.update(user.id, { paletteId: 'motir' });

    expect(second).toEqual(first);
    expect(await db.userAppearancePreference.count({ where: { userId: user.id } })).toBe(1);
  });

  it.each([
    ['pattern', { pattern: 'twilight' }],
    ['styleId', { styleId: 'no-such-style' }],
    ['paletteId', { paletteId: 'no-such-palette' }],
    // MOTIR-6471 retired the id; its palette is `motir` now, and the stored rows
    // were migrated, so a write still spelling it is a stale client.
    ['paletteId', { paletteId: 'graphite' }],
    ['typeId', { typeId: 'inter-system' }],
  ])('rejects an unknown %s with a typed error and writes nothing', async (_axis, patch) => {
    const user = await createTestUser();

    await expect(appearancePreferenceService.update(user.id, patch)).rejects.toBeInstanceOf(
      InvalidAppearanceValueError,
    );
    // The transaction never opened — no row was created.
    expect(await userAppearancePreferenceRepository.findByUserId(user.id)).toBeNull();
  });
});

// MOTIR-7894 — the per-locale font pick, the preference's fifth axis.
describe('appearancePreferenceService.update — fontPicks', () => {
  it('round-trips a pick: stored, returned and read back', async () => {
    const user = await createTestUser();

    const returned = await appearancePreferenceService.update(user.id, {
      fontPicks: { ja: 'm-plus-rounded-1c' },
    });

    expect(returned.fontPicks).toEqual({ ja: 'm-plus-rounded-1c' });
    expect((await appearancePreferenceService.getResolved(user.id)).fontPicks).toEqual({
      ja: 'm-plus-rounded-1c',
    });
    const row = await userAppearancePreferenceRepository.findByUserId(user.id);
    expect(row?.fontPickJa).toBe('m-plus-rounded-1c');
  });

  it('clears one locale with null and leaves an omitted locale untouched', async () => {
    const user = await createTestUser();
    await appearancePreferenceService.update(user.id, {
      fontPicks: { ja: 'm-plus-rounded-1c', ko: 'nanum-gothic' },
    });

    const after = await appearancePreferenceService.update(user.id, { fontPicks: { ja: null } });

    expect(after.fontPicks).toEqual({ ko: 'nanum-gothic' });
    const row = await userAppearancePreferenceRepository.findByUserId(user.id);
    expect(row?.fontPickJa).toBeNull();
    expect(row?.fontPickKo).toBe('nanum-gothic');
  });

  it('leaves the picks untouched when a patch names another axis only', async () => {
    const user = await createTestUser();
    await appearancePreferenceService.update(user.id, { fontPicks: { zh: 'lxgw-wenkai-tc' } });

    const after = await appearancePreferenceService.update(user.id, { pattern: 'dark' });

    expect(after.fontPicks).toEqual({ zh: 'lxgw-wenkai-tc' });
  });

  it.each([
    ["another locale's member", { ja: 'noto-sans-kr' }],
    ['an unknown member', { ja: 'comic-sans' }],
    ['a Latin locale (accepts nothing)', { en: 'type-pairing' }],
    ['an unknown locale', { xx: 'noto-sans-jp' }],
  ])('refuses %s with a typed error and changes nothing', async (_label, fontPicks) => {
    const user = await createTestUser();
    await appearancePreferenceService.update(user.id, { fontPicks: { ko: 'nanum-gothic' } });
    const before = await userAppearancePreferenceRepository.findByUserId(user.id);

    await expect(
      appearancePreferenceService.update(user.id, {
        fontPicks: fontPicks as Record<string, string>,
      }),
    ).rejects.toBeInstanceOf(InvalidAppearanceValueError);

    expect(await userAppearancePreferenceRepository.findByUserId(user.id)).toEqual(before);
  });

  it('reads a stored pick the registry no longer has as absent (automatic)', async () => {
    const user = await createTestUser();
    await appearancePreferenceService.update(user.id, { fontPicks: { ja: 'm-plus-rounded-1c' } });
    // A member removed from the registry after it was stored.
    await db.userAppearancePreference.update({
      where: { userId: user.id },
      data: { fontPickJa: 'retired-face' },
    });

    expect((await appearancePreferenceService.getResolved(user.id)).fontPicks).toEqual({});
  });

  it('keeps both of two concurrent saves for different locales', async () => {
    const user = await createTestUser();

    await Promise.all([
      appearancePreferenceService.update(user.id, { fontPicks: { ja: 'm-plus-rounded-1c' } }),
      appearancePreferenceService.update(user.id, { fontPicks: { ko: 'nanum-gothic' } }),
    ]);

    expect((await appearancePreferenceService.getResolved(user.id)).fontPicks).toEqual({
      ja: 'm-plus-rounded-1c',
      ko: 'nanum-gothic',
    });
    expect(await db.userAppearancePreference.count({ where: { userId: user.id } })).toBe(1);
  });
});
