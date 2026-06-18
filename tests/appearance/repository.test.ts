import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { userAppearancePreferenceRepository } from '@/lib/repositories/userAppearancePreferenceRepository';
import { createTestUser } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// Repository-layer tests for the cross-device appearance-preference data-access
// leaf (Story 7.3 · Subtask 7.3.59): userAppearancePreferenceRepository, plus
// the schema-level guarantees the migration carries — the 1:1 `userId @unique`
// upsert target, the absence-as-default read semantics, and the user→preference
// delete cascade. Real Postgres (no mocks), per CLAUDE.md. They run as the
// dev/CI superuser via the `db` singleton; the write path is exercised through a
// real `db.$transaction` to honour the required-`tx` contract.

beforeEach(async () => {
  // truncateAuthTables truncates `user` RESTART IDENTITY CASCADE, which cascades
  // user → user_appearance_preference (the onDelete: Cascade FK), so no
  // dedicated truncate is needed.
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('userAppearancePreferenceRepository.findByUserId', () => {
  it('returns null for an untouched user (no row — absence = the default)', async () => {
    const user = await createTestUser();
    expect(await userAppearancePreferenceRepository.findByUserId(user.id)).toBeNull();
  });
});

describe('userAppearancePreferenceRepository.upsert', () => {
  async function upsert(
    userId: string,
    patch: Parameters<typeof userAppearancePreferenceRepository.upsert>[1],
  ) {
    return db.$transaction((tx) => userAppearancePreferenceRepository.upsert(userId, patch, tx));
  }

  it('creates the row on first pin, then patches the same single row', async () => {
    const user = await createTestUser();

    const created = await upsert(user.id, { pattern: 'dark', styleId: 'soft-playful' });
    expect(created.userId).toBe(user.id);
    expect(created.pattern).toBe('dark');
    expect(created.styleId).toBe('soft-playful');
    // Unpinned axes stay null — absence = the documented default.
    expect(created.paletteId).toBeNull();
    expect(created.typeId).toBeNull();

    // A second upsert patches the existing row (1:1 on userId), not a new one.
    const patched = await upsert(user.id, { paletteId: 'cobalt' });
    expect(patched.paletteId).toBe('cobalt');
    // The patch leaves already-pinned axes untouched (undefined ⇒ no change).
    expect(patched.pattern).toBe('dark');
    expect(patched.styleId).toBe('soft-playful');

    const found = await userAppearancePreferenceRepository.findByUserId(user.id);
    expect(found?.paletteId).toBe('cobalt');
    expect(found?.pattern).toBe('dark');

    // Still exactly one row for the user.
    expect(await db.userAppearancePreference.count({ where: { userId: user.id } })).toBe(1);
  });

  it('clears an axis back to its default when passed null explicitly', async () => {
    const user = await createTestUser();
    await upsert(user.id, { pattern: 'dark' });

    const cleared = await upsert(user.id, { pattern: null });
    expect(cleared.pattern).toBeNull();
  });

  it('cascades: deleting the user removes the appearance row', async () => {
    const user = await createTestUser();
    await upsert(user.id, { typeId: 'inter-system' });

    await db.$transaction((tx) => tx.user.delete({ where: { id: user.id } }));

    expect(await userAppearancePreferenceRepository.findByUserId(user.id)).toBeNull();
  });
});
