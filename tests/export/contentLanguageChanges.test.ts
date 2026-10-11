import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { PERSONAL_DATA_SECTIONS, readSection } from '@/lib/export/personalDataSections';
import { withUserContext } from '@/lib/workspaces/context';
import { createTestUser } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// The personal-data export carries the content-language changes a person made
// (Story MOTIR-7731). The table is organisation-scoped, so the section only reads
// through the identity context because its policy has an `app.user_id` arm on
// `changed_by_user_id` — this pins that arm, through the same `withUserContext`
// transaction the export build opens. Without the arm the read returns no rows
// and raises nothing, which is an empty section that looks like "you have none".

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const SECTION = PERSONAL_DATA_SECTIONS.find(
  (s) => s.table === 'organization_content_language_change',
)!;

describe('the organization_content_language_change export section', () => {
  it('exports the changes the reader made, and only those', async () => {
    const reader = await createTestUser();
    const other = await createTestUser();
    const org = await adminDb.organization.create({
      data: { name: 'Org cl', slug: 'cl-export-org' },
    });
    await adminDb.organizationContentLanguageChange.create({
      data: {
        organizationId: org.id,
        changedByUserId: reader.id,
        fromLanguage: 'en',
        toLanguage: 'ja',
      },
    });
    await adminDb.organizationContentLanguageChange.create({
      data: {
        organizationId: org.id,
        changedByUserId: other.id,
        fromLanguage: 'ja',
        toLanguage: 'de',
      },
    });

    const rows = (await withUserContext(reader.id, (tx) =>
      readSection(SECTION, reader.id, tx),
    )) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: org.id,
      changedByUserId: reader.id,
      fromLanguage: 'en',
      toLanguage: 'ja',
    });
  });
});
