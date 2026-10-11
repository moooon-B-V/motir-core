import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { toWorkItemDto } from '@/lib/mappers/workItemMappers';
import { toWorkItemTodoDto } from '@/lib/mappers/workItemTodoMappers';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workItemsService } from '@/lib/services/workItemsService';
import { InvalidWorkItemLanguageError } from '@/lib/workItems/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-7731 · MOTIR-8096 — the app's work item and to-do writers record
// the language each text field is written in: explicit per field, else the
// call's, else the organisation's. Editing re-records only the edited field, an
// empty field records NULL, and NULL reads back as null — never `en`. Real
// Postgres.
//
// No clone writer exists to cover: `grep -rniE "clone(WorkItem|Item)|async
// clone|duplicateWorkItem|copyWorkItem" lib/services app/api` finds nothing (the
// `clones` link relation copies no text).

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

async function fixtureIn(language: string): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture();
  await adminDb.organization.update({
    where: { id: fx.workspace.organizationId },
    data: { contentLanguage: language },
  });
  return fx;
}

async function languagesOf(id: string) {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  return [row.titleLanguage, row.descriptionLanguage, row.explanationLanguage];
}

async function setLanguages(id: string, langs: (string | null)[]) {
  await adminDb.workItem.update({
    where: { id },
    data: {
      titleLanguage: langs[0],
      descriptionLanguage: langs[1],
      explanationLanguage: langs[2],
    },
  });
}

describe('createWorkItem', () => {
  it('records the org language on every written field, null on an absent body', async () => {
    const fx = await fixtureIn('ja');
    const withDesc = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Ship', descriptionMd: 'Body' },
      fx.ctx,
    );
    expect(await languagesOf(withDesc.id)).toEqual(['ja', 'ja', null]);
    expect(withDesc.languages).toEqual({ title: 'ja', description: 'ja', explanation: null });

    const both = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Ship',
        descriptionMd: 'Body',
        explanationMd: 'Why',
      },
      fx.ctx,
    );
    expect(await languagesOf(both.id)).toEqual(['ja', 'ja', 'ja']);

    const titleOnly = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Ship', descriptionMd: '' },
      fx.ctx,
    );
    expect(await languagesOf(titleOnly.id)).toEqual(['ja', null, null]);
  });

  it('an explicit language wins, and a per-field one wins over it', async () => {
    const fx = await fixtureIn('ja');
    const all = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Ship',
        descriptionMd: 'Body',
        explanationMd: 'Why',
        language: 'ko',
      },
      fx.ctx,
    );
    expect(await languagesOf(all.id)).toEqual(['ko', 'ko', 'ko']);

    const one = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Ship',
        descriptionMd: 'Body',
        explanationMd: 'Why',
        languages: { explanation: 'ko' },
      },
      fx.ctx,
    );
    expect(await languagesOf(one.id)).toEqual(['ja', 'ja', 'ko']);
  });

  it('refuses a language outside the eleven and writes nothing', async () => {
    const fx = await fixtureIn('en');
    for (const bad of [{ language: 'sv' }, { languages: { title: 'EN' } }]) {
      await expect(
        workItemsService.createWorkItem(
          // @ts-expect-error — a caller past the type system (JSON) sends a bad code
          { projectId: fx.projectId, kind: 'task', title: 'Ship', ...bad },
          fx.ctx,
        ),
      ).rejects.toBeInstanceOf(InvalidWorkItemLanguageError);
    }
    expect(await adminDb.workItem.count()).toBe(0);
  });
});

describe('updateWorkItem', () => {
  it('an explicit language on the explanation alone touches only the explanation', async () => {
    const fx = await fixtureIn('ja');
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Ship', descriptionMd: 'Body' },
      fx.ctx,
    );
    await workItemsService.updateWorkItem(
      item.id,
      { explanationMd: 'Because', languages: { explanation: 'ko' } },
      fx.ctx,
    );
    expect(await languagesOf(item.id)).toEqual(['ja', 'ja', 'ko']);
  });

  it('a resubmitted unchanged title keeps its language (null included); the changed body is re-recorded', async () => {
    const fx = await fixtureIn('ja');
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Ship', descriptionMd: 'Body' },
      fx.ctx,
    );
    await setLanguages(item.id, [null, 'de', null]);

    const dto = await workItemsService.updateWorkItem(
      item.id,
      { title: 'Ship', descriptionMd: 'New body', explanationMd: null },
      fx.ctx,
    );
    expect(await languagesOf(item.id)).toEqual([null, 'ja', null]);
    expect(dto.languages).toEqual({ title: null, description: 'ja', explanation: null });
  });

  it('on an all-null row, editing one field records only that field', async () => {
    const fx = await fixtureIn('zh');
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Ship',
        descriptionMd: 'Body',
        explanationMd: 'Why',
      },
      fx.ctx,
    );
    await setLanguages(item.id, [null, null, null]);
    await workItemsService.updateWorkItem(item.id, { title: 'Ship it' }, fx.ctx);
    expect(await languagesOf(item.id)).toEqual(['zh', null, null]);
  });

  it('clearing a body records null, and a bad language is refused', async () => {
    const fx = await fixtureIn('ja');
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Ship', descriptionMd: 'Body' },
      fx.ctx,
    );
    await workItemsService.updateWorkItem(item.id, { descriptionMd: '' }, fx.ctx);
    expect(await languagesOf(item.id)).toEqual(['ja', null, null]);

    await expect(
      // @ts-expect-error — a bad code from past the type system
      workItemsService.updateWorkItem(item.id, { title: 'X', language: 'sv' }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidWorkItemLanguageError);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).title).toBe(
      'Ship',
    );
  });

  it('re-stating the same text with an explicit language stores the language, with no revision', async () => {
    const fx = await fixtureIn('ja');
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Ship' },
      fx.ctx,
    );
    const before = await adminDb.workItemRevision.count({ where: { workItemId: item.id } });
    await workItemsService.updateWorkItem(item.id, { title: 'Ship', language: 'en' }, fx.ctx);
    expect(await languagesOf(item.id)).toEqual(['en', null, null]);
    expect(await adminDb.workItemRevision.count({ where: { workItemId: item.id } })).toBe(before);
  });
});

describe('to-dos', () => {
  async function card(fx: WorkItemFixture) {
    return (
      await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: 'Ship' },
        fx.ctx,
      )
    ).id;
  }
  async function todoLangs(id: string) {
    const row = await adminDb.workItemTodo.findUniqueOrThrow({ where: { id } });
    return [row.textLanguage, row.notesLanguage];
  }

  it('addTodo records the org language, explicit wins, no notes is null', async () => {
    const fx = await fixtureIn('ja');
    const cardId = await card(fx);
    const plain = await workItemTodosService.addTodo(cardId, { text: 'Tag it' }, fx.ctx);
    expect(await todoLangs(plain.todo.id)).toEqual(['ja', null]);
    expect([plain.todo.textLanguage, plain.todo.notesLanguage]).toEqual(['ja', null]);

    const withNotes = await workItemTodosService.addTodo(
      cardId,
      { text: 'Tag it', notesMd: 'Run the script', languages: { notes: 'ko' } },
      fx.ctx,
    );
    expect(await todoLangs(withNotes.todo.id)).toEqual(['ja', 'ko']);

    const all = await workItemTodosService.addTodo(
      cardId,
      { text: 'Tag it', notesMd: 'Run', language: 'de' },
      fx.ctx,
    );
    expect(await todoLangs(all.todo.id)).toEqual(['de', 'de']);
  });

  it('updateTodo re-records only the edited field', async () => {
    const fx = await fixtureIn('ja');
    const cardId = await card(fx);
    const { todo } = await workItemTodosService.addTodo(
      cardId,
      { text: 'Tag it', notesMd: 'Run' },
      fx.ctx,
    );
    await adminDb.workItemTodo.update({
      where: { id: todo.id },
      data: { textLanguage: null, notesLanguage: null },
    });

    await workItemTodosService.updateTodo(todo.id, { notesMd: 'Run the script' }, fx.ctx);
    expect(await todoLangs(todo.id)).toEqual([null, 'ja']);

    await workItemTodosService.updateTodo(todo.id, { text: 'Tag it' }, fx.ctx);
    expect(await todoLangs(todo.id)).toEqual([null, 'ja']);

    await workItemTodosService.updateTodo(
      todo.id,
      { text: 'Tag the build', languages: { text: 'ko' } },
      fx.ctx,
    );
    expect(await todoLangs(todo.id)).toEqual(['ko', 'ja']);

    await workItemTodosService.updateTodo(todo.id, { notesMd: '' }, fx.ctx);
    expect(await todoLangs(todo.id)).toEqual(['ko', null]);
  });
});

describe('reading an unrecorded row', () => {
  it('both mappers return null, never en', async () => {
    const fx = await fixtureIn('en');
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Ship', descriptionMd: 'Body' },
      fx.ctx,
    );
    const { todo } = await workItemTodosService.addTodo(
      item.id,
      { text: 'Tag', notesMd: 'Run' },
      fx.ctx,
    );
    await setLanguages(item.id, [null, null, null]);
    await adminDb.workItemTodo.update({
      where: { id: todo.id },
      data: { textLanguage: null, notesLanguage: null },
    });

    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(toWorkItemDto(row).languages).toEqual({
      title: null,
      description: null,
      explanation: null,
    });
    const todoRow = await adminDb.workItemTodo.findUniqueOrThrow({ where: { id: todo.id } });
    const dto = toWorkItemTodoDto(todoRow);
    expect([dto.textLanguage, dto.notesLanguage]).toEqual([null, null]);
  });
});
