import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { PERSONAL_DATA_SECTIONS, readSection } from '@/lib/export/personalDataSections';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createTestUser } from '../fixtures';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// The personal-data export carries the auto-translate flips a person made on a
// project (Story MOTIR-7738 · MOTIR-8825). The table's policy keys on
// `app.workspace_id`, so the section is `tenant`-tier and is read through the
// SAME `withWorkspaceContext` transaction the export build opens, once per
// workspace. A wrong tier reads zero rows and raises nothing — an empty section
// that looks like "you have none" — so the fixture holds rows the bound view must
// exclude (another actor's, in the same workspace; the reader's own, in a
// workspace the read is not bound to) and the true population differs from the view.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const SECTION = PERSONAL_DATA_SECTIONS.find((s) => s.table === 'project_auto_translate_change')!;

describe('the project_auto_translate_change export section', () => {
  it('is registered as a tenant-tier section', () => {
    expect(SECTION).toBeDefined();
    expect(SECTION.tier).toBe('tenant');
    expect(SECTION.redact).toBeUndefined();
  });

  it("exports the reader's own flips in the bound workspace, and only those", async () => {
    const reader = await createTestUser();
    const other = await createTestUser();
    const here = await makeWorkItemFixture({ name: 'Here', identifier: 'HER' });
    const there = await makeWorkItemFixture({ name: 'There', identifier: 'THR' });
    const flip = (workspaceId: string, projectId: string, userId: string, to: boolean) =>
      adminDb.projectAutoTranslateChange.create({
        data: { workspaceId, projectId, changedByUserId: userId, fromEnabled: !to, toEnabled: to },
      });
    const mine = await flip(here.workspaceId, here.projectId, reader.id, true);
    await flip(here.workspaceId, here.projectId, other.id, false); // another actor, same workspace
    await flip(there.workspaceId, there.projectId, reader.id, true); // the reader's, another workspace

    expect(await adminDb.projectAutoTranslateChange.count()).toBe(3);

    const rows = (await withWorkspaceContext(
      { userId: reader.id, workspaceId: here.workspaceId },
      (tx) => readSection(SECTION, reader.id, tx),
    )) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: mine.id,
      projectId: here.projectId,
      changedByUserId: reader.id,
      fromEnabled: false,
      toEnabled: true,
    });
  });
});
