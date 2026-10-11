import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, createTestWorkItem } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { REPO_ROOT } from '../helpers/importGraph';

// The content-language SUBSTRATE (Story MOTIR-7731 · MOTIR-8092) against a
// REAL Postgres: the organisation's `content_language` and its `en` default, the
// five NULLABLE per-field language columns on `work_item` / `work_item_todo`,
// and the `organization_content_language_change` history table. Nothing writes
// these yet — the writer cards do — so this file drives them directly.
//
// The story's invariant is that "no language recorded" (NULL) stays
// distinguishable from a real `en`. That is a property of the column having NO
// default and of the migration doing NO backfill, so both are asserted against
// the catalog and the migration file, not inferred from an insert.

const MIGRATION_DIR = path.join(REPO_ROOT, 'prisma', 'migrations');

function contentLanguageMigration(): string {
  const dir = readdirSync(MIGRATION_DIR).find((d) => d.endsWith('_content_language'));
  if (!dir) throw new Error('no *_content_language migration');
  return readFileSync(path.join(MIGRATION_DIR, dir, 'migration.sql'), 'utf8');
}

async function columnDefault(table: string, column: string) {
  const rows = await adminDb.$queryRaw<
    { column_default: string | null; is_nullable: 'YES' | 'NO' }[]
  >`SELECT column_default, is_nullable FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table} AND column_name = ${column}`;
  if (rows.length !== 1) throw new Error(`${table}.${column} not found`);
  return rows[0]!;
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_todo", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables(adminDb);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('Organization.contentLanguage', () => {
  it('is a required column whose default is en, so the migration backfills every existing organisation', async () => {
    const col = await columnDefault('organization', 'content_language');
    expect(col.is_nullable).toBe('NO');
    expect(col.column_default).toBe("'en'::text");
    // The backfill IS the default: one ADD COLUMN … NOT NULL DEFAULT 'en', no UPDATE.
    expect(contentLanguageMigration()).toMatch(
      /ADD COLUMN\s+"content_language" TEXT NOT NULL DEFAULT 'en'/,
    );
  });

  it('reads en for an organisation inserted without the column', async () => {
    const org = await adminDb.organization.create({ data: { name: 'Acme', slug: 'acme' } });
    expect(org.contentLanguage).toBe('en');
    const raw = await adminDb.$queryRaw<{ content_language: string }[]>`
      SELECT content_language FROM organization WHERE id = ${org.id}`;
    expect(raw[0]!.content_language).toBe('en');
  });

  it('stores an explicit language', async () => {
    const org = await adminDb.organization.create({
      data: { name: 'Acme', slug: 'acme', contentLanguage: 'zh' },
    });
    const back = await adminDb.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(back.contentLanguage).toBe('zh');
  });
});

describe('the five per-field language columns', () => {
  const FIELD_COLUMNS: [string, string][] = [
    ['work_item', 'title_language'],
    ['work_item', 'description_language'],
    ['work_item', 'explanation_language'],
    ['work_item_todo', 'text_language'],
    ['work_item_todo', 'notes_language'],
  ];

  it.each(FIELD_COLUMNS)('%s.%s is nullable with NO default', async (table, column) => {
    const col = await columnDefault(table, column);
    expect(col.is_nullable).toBe('YES');
    expect(col.column_default).toBeNull();
  });

  it('the migration backfills none of them', () => {
    const sql = contentLanguageMigration();
    // No UPDATE statement (the FKs' `ON UPDATE CASCADE` is not one).
    expect(sql).not.toMatch(/^\s*UPDATE\s/im);
    for (const [, column] of FIELD_COLUMNS) {
      expect(sql).toMatch(new RegExp(`"${column}" TEXT(,|;|\\s*$)`, 'm'));
      expect(sql).not.toMatch(new RegExp(`"${column}" TEXT[^,;]*DEFAULT`));
    }
  });

  it('a work item and a to-do written without a language read null — never en', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Cut the release' });
    const todo = await adminDb.workItemTodo.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: item.id,
        text: 'Tag the build',
        notesMd: 'Use the release script.',
        position: 'a0',
      },
    });

    const itemBack = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(itemBack.titleLanguage).toBeNull();
    expect(itemBack.descriptionLanguage).toBeNull();
    expect(itemBack.explanationLanguage).toBeNull();
    const todoBack = await adminDb.workItemTodo.findUniqueOrThrow({ where: { id: todo.id } });
    expect(todoBack.textLanguage).toBeNull();
    expect(todoBack.notesLanguage).toBeNull();
  });

  it('stores an explicit language in each column and reads it back', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: '发布' });
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { titleLanguage: 'zh', descriptionLanguage: 'ja', explanationLanguage: 'de' },
    });
    const todo = await adminDb.workItemTodo.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: item.id,
        text: 'Étiqueter',
        notesMd: 'Notas',
        textLanguage: 'fr',
        notesLanguage: 'es',
        position: 'a0',
      },
    });

    const itemBack = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect([
      itemBack.titleLanguage,
      itemBack.descriptionLanguage,
      itemBack.explanationLanguage,
    ]).toEqual(['zh', 'ja', 'de']);
    const todoBack = await adminDb.workItemTodo.findUniqueOrThrow({ where: { id: todo.id } });
    expect([todoBack.textLanguage, todoBack.notesLanguage]).toEqual(['fr', 'es']);
  });
});

describe('OrganizationContentLanguageChange', () => {
  it('accepts a who / from / to / when row and is removed with its organisation', async () => {
    const user = await adminDb.user.create({
      data: { email: 'lin@example.com', name: 'Lin', emailVerified: true },
    });
    const org = await adminDb.organization.create({ data: { name: 'Acme', slug: 'acme' } });
    const before = new Date();
    const row = await adminDb.organizationContentLanguageChange.create({
      data: {
        organizationId: org.id,
        changedByUserId: user.id,
        fromLanguage: 'en',
        toLanguage: 'ja',
      },
    });
    expect(row).toMatchObject({
      organizationId: org.id,
      changedByUserId: user.id,
      fromLanguage: 'en',
      toLanguage: 'ja',
    });
    expect(row.changedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);

    await adminDb.organization.delete({ where: { id: org.id } });
    expect(await adminDb.organizationContentLanguageChange.count({ where: { id: row.id } })).toBe(
      0,
    );
  });

  it('keeps the record when the person who made the change is deleted', async () => {
    const user = await adminDb.user.create({
      data: { email: 'lin@example.com', name: 'Lin', emailVerified: true },
    });
    const org = await adminDb.organization.create({ data: { name: 'Acme', slug: 'acme' } });
    const row = await adminDb.organizationContentLanguageChange.create({
      data: {
        organizationId: org.id,
        changedByUserId: user.id,
        fromLanguage: 'en',
        toLanguage: 'ko',
      },
    });

    await adminDb.user.delete({ where: { id: user.id } });
    const back = await adminDb.organizationContentLanguageChange.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(back.changedByUserId).toBeNull();
    expect([back.fromLanguage, back.toLanguage]).toEqual(['en', 'ko']);
  });

  it('is under forced row-level security, scoped to its organisation', async () => {
    const rows = await adminDb.$queryRaw<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname = 'organization_content_language_change'`;
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await adminDb.$queryRaw<{ qual: string }[]>`
      SELECT qual FROM pg_policies WHERE tablename = 'organization_content_language_change'`;
    expect(policies).toHaveLength(1);
    expect(policies[0]!.qual).toContain('app.organization_id');
  });
});
