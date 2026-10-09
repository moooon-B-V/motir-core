import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { PERSONAL_DATA_SECTIONS, readSection } from '@/lib/export/personalDataSections';
import { withUserContext } from '@/lib/workspaces/context';
import { createTestUser } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// The personal-data export carries the font picked for each language (Story
// MOTIR-7736 · Subtask MOTIR-7898). The section reads the whole
// `user_appearance_preference` row, so the eleven `fontPick*` columns ride along
// with no redaction — this pins that, through the same `withUserContext`
// transaction the export build opens, so a later `omit` or a policy that hid the
// row from the reader would fail here rather than ship an archive missing them.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const SECTION = PERSONAL_DATA_SECTIONS.find((s) => s.table === 'user_appearance_preference')!;

describe('the user_appearance_preference export section', () => {
  it('says what it holds, font picks included', () => {
    expect(SECTION.basis).toMatch(/font picked for each language/);
    expect(SECTION.redact ?? []).toEqual([]);
  });

  it('exports the reader’s font picks, and only the reader’s row', async () => {
    const reader = await createTestUser();
    const other = await createTestUser();
    await adminDb.userAppearancePreference.create({
      data: { userId: reader.id, fontPickJa: 'm-plus-rounded-1c', fontPickKo: 'nanum-gothic' },
    });
    await adminDb.userAppearancePreference.create({
      data: { userId: other.id, fontPickZh: 'lxgw-wenkai-tc' },
    });

    const rows = (await withUserContext(reader.id, (tx) =>
      readSection(SECTION, reader.id, tx),
    )) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: reader.id,
      fontPickJa: 'm-plus-rounded-1c',
      fontPickKo: 'nanum-gothic',
      fontPickZh: null,
    });
  });
});
