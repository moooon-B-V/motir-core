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
    });
    // Reading never creates a row — absence stays absence.
    expect(await userAppearancePreferenceRepository.findByUserId(user.id)).toBeNull();
  });
});

describe('appearancePreferenceService.getApplied', () => {
  it('resolves to all defaults for an untouched user (no row), unpinned type', async () => {
    const user = await createTestUser();

    const applied = await appearancePreferenceService.getApplied(user.id);

    expect(applied).toEqual({
      pattern: THEME_DEFAULTS.pattern,
      styleId: DEFAULT_STYLE_ID,
      paletteId: DEFAULT_PALETTE_ID,
      typeId: DEFAULT_TYPE_ID,
      typePinned: false,
    });
    expect(await userAppearancePreferenceRepository.findByUserId(user.id)).toBeNull();
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

    const first = await appearancePreferenceService.update(user.id, { paletteId: 'graphite' });
    const second = await appearancePreferenceService.update(user.id, { paletteId: 'graphite' });

    expect(second).toEqual(first);
    expect(await db.userAppearancePreference.count({ where: { userId: user.id } })).toBe(1);
  });

  it.each([
    ['pattern', { pattern: 'twilight' }],
    ['styleId', { styleId: 'no-such-style' }],
    ['paletteId', { paletteId: 'no-such-palette' }],
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
