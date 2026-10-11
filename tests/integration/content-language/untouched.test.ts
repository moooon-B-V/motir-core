import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as v1Read } from '@/app/api/v1/work-items/[key]/route';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { db } from '@/lib/db';
import { importRepository } from '@/lib/repositories/importRepository';
import { importEngineService } from '@/lib/import/engine/importEngineService';
import {
  importPersistService,
  type ImportRunProgress,
} from '@/lib/import/engine/importPersistService';
import type { IssueSourceConnector, SourceIssue } from '@/lib/import/connectors/types';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import {
  callMcp,
  mcpOk,
  orgIn,
  setOrgLanguage,
  storedLanguages,
  unrecordedItem,
} from './_fixtures';

// Story MOTIR-7731 (MOTIR-8099) — what a write does NOT touch: an edit
// re-records only the field it edits; a row written before content languages
// reads null (never en) on every door and stays null where it is not edited; a
// language with nothing to apply it to is an empty patch; and imported text
// records no language, on create and on re-sync. Real Postgres.

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Languages = { title: string | null; description: string | null; explanation: string | null };
const NONE: Languages = { title: null, description: null, explanation: null };

describe('an edit re-records only the field it edits', () => {
  it('editing the description leaves the title’s language', async () => {
    const fx = await orgIn('ja');
    const dto = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Titre', language: 'fr' },
      fx.ctx,
    );
    await workItemsService.updateWorkItem(dto.id, { descriptionMd: '本文' }, fx.ctx);
    expect(await storedLanguages(dto.id)).toEqual(['fr', 'ja', null]);
  });

  it('editing a to-do’s notes leaves its text’s language', async () => {
    const fx = await orgIn('ja');
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'T' },
      fx.ctx,
    );
    const { todo } = await workItemTodosService.addTodo(
      item.id,
      { text: 'Étape', language: 'fr' },
      fx.ctx,
    );
    const { todo: edited } = await workItemTodosService.updateTodo(
      todo.id,
      { notesMd: 'メモ' },
      fx.ctx,
    );
    expect([edited.textLanguage, edited.notesLanguage]).toEqual(['fr', 'ja']);
  });
});

describe('a row written before content languages', () => {
  it('reads null through the service, MCP and REST', async () => {
    const caller = await createV1ProjectCaller({
      permissions: ['project:browse', 'work_item:edit'],
    });
    const fx = caller.fixture;
    await setOrgLanguage(fx.workspace.organizationId, 'ja');
    const old = await unrecordedItem(fx, 'Old');

    const dto = await workItemsService.getWorkItem(old.id, fx.ctx);
    expect(dto.languages).toEqual(NONE);

    const viaMcp = mcpOk<{ item: { languages: Languages } }>(
      await callMcp(fx.ctx, 'get_work_item', { key: old.identifier }),
    );
    expect(viaMcp.item.languages).toEqual(NONE);

    const res = await v1Read(
      new Request(`http://localhost:3000/api/v1/work-items/${old.identifier}`, {
        headers: caller.headers,
      }),
      { params: Promise.resolve({ key: old.identifier }) },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { languages: Languages }).languages).toEqual(NONE);
  });

  it('editing its title records ja there and leaves the other two null', async () => {
    const fx = await orgIn('ja');
    const old = await unrecordedItem(fx, 'Old');
    await workItemsService.updateWorkItem(old.id, { title: '新しい' }, fx.ctx);
    expect(await storedLanguages(old.id)).toEqual(['ja', null, null]);
  });

  it('a key and a language alone is NO_FIELDS_TO_PATCH, and records nothing', async () => {
    const fx = await orgIn('ja');
    const old = await unrecordedItem(fx, 'Old');
    const res = await callMcp(fx.ctx, 'update_work_item', { key: old.identifier, language: 'ko' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('NO_FIELDS_TO_PATCH');
    expect(await storedLanguages(old.id)).toEqual([null, null, null]);
  });
});

describe('imported text records no language', () => {
  function issue(descriptionMd: string): SourceIssue {
    return {
      externalId: 'ACME-1',
      title: 'Imported',
      descriptionMd,
      type: null,
      status: null,
      priority: null,
      assigneeEmail: null,
      assigneeName: null,
      reporterEmail: null,
      reporterName: null,
      labels: [],
      comments: [],
      attachments: [],
      parentExternalId: null,
      links: [],
      createdAt: null,
      closedAt: null,
    };
  }

  function connectorOf(issues: SourceIssue[]): IssueSourceConnector {
    return {
      source: 'jira',
      async connect() {
        return { source: 'jira', sourceRef: 'FAKE', issueCount: issues.length };
      },
      async discoverFields() {
        return { types: [], statuses: [], priorities: [], labels: [] };
      },
      async listIssues() {
        return { issues, nextCursor: null, errors: [] };
      },
    };
  }

  async function runImport(fx: WorkItemFixture, importId: string, issues: SourceIssue[]) {
    const events: ImportRunProgress[] = [];
    for await (const e of importPersistService.runImport({
      importId,
      connector: connectorOf(issues),
      mapping: { defaultKind: 'task', typeToKind: {}, statusToKey: {} },
      ctx: await importEngineService.buildResolveContext(fx.projectId, fx.workspaceId, fx.ownerId),
    })) {
      events.push(e);
    }
    const summary = events.find((e) => e.type === 'summary');
    if (!summary || summary.type !== 'summary') throw new Error('no summary event');
    return summary;
  }

  it('stays null on create and on a re-sync that changes the body', async () => {
    const fx = await orgIn('ja');
    const { id: importId } = await adminDb.$transaction((tx) =>
      importRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          source: 'jira',
          createdById: fx.ownerId,
        },
        tx,
      ),
    );
    expect((await runImport(fx, importId, [issue('One')])).counts).toMatchObject({ created: 1 });
    const row = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Imported' } });
    expect(await storedLanguages(row.id)).toEqual([null, null, null]);

    expect((await runImport(fx, importId, [issue('Two')])).counts).toMatchObject({ updated: 1 });
    expect(await storedLanguages(row.id)).toEqual([null, null, null]);
  });
});
