import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { appearancePreferenceService } from '@/lib/services/appearancePreferenceService';
import { createTestUser } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-6471 — `rename_palette_ids_motir_amethyst`. The monochrome palette's id
// `graphite` became `motir` and the warm palette's id `motir` became `amethyst`,
// so a stored `palette_id` names the OTHER palette after the rename. This suite
// runs the migration's real SQL against real Postgres and pins the swap from
// every side: each stored value lands on the palette its owner chose, NULL (the
// default) is untouched, and the two maps do not compose — which is what a pair
// of sequential UPDATEs would do, sending every Graphite user to Amethyst.

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260926100000_rename_palette_ids_motir_amethyst/migration.sql',
  ),
  'utf8',
);

async function seedPreference(paletteId: string | null): Promise<string> {
  const user = await createTestUser();
  await adminDb.$executeRawUnsafe(
    `INSERT INTO "user_appearance_preference" ("user_id", "palette_id", "created_at", "updated_at")
     VALUES ($1, $2, now(), now())`,
    user.id,
    paletteId,
  );
  return user.id;
}

async function storedPalette(userId: string): Promise<string | null> {
  const rows = await adminDb.$queryRawUnsafe<{ palette_id: string | null }[]>(
    `SELECT "palette_id" FROM "user_appearance_preference" WHERE "user_id" = $1`,
    userId,
  );
  return rows[0]!.palette_id;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('the palette-id rename migration', () => {
  it('carries each saved choice to the palette its owner picked, and leaves NULL alone', async () => {
    const warm = await seedPreference('motir');
    const mono = await seedPreference('graphite');
    const cobalt = await seedPreference('cobalt');
    const unset = await seedPreference(null);

    await adminDb.$executeRawUnsafe(MIGRATION_SQL);

    expect(await storedPalette(warm)).toBe('amethyst');
    expect(await storedPalette(mono)).toBe('motir');
    expect(await storedPalette(cobalt)).toBe('cobalt');
    expect(await storedPalette(unset)).toBeNull();
  });

  it('is ONE statement — the two maps never compose into graphite → amethyst', async () => {
    const mono = await seedPreference('graphite');
    await adminDb.$executeRawUnsafe(MIGRATION_SQL);
    expect(await storedPalette(mono)).toBe('motir');
  });

  it('a user with no stored palette resolves to the new default, `motir`', async () => {
    const unset = await seedPreference(null);
    await adminDb.$executeRawUnsafe(MIGRATION_SQL);
    const resolved = await appearancePreferenceService.getResolved(unset);
    expect(resolved.paletteId).toBe('motir');
  });
});
