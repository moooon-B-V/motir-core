import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { importRepository } from '@/lib/repositories/importRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { importEngineService } from '@/lib/import/engine/importEngineService';
import {
  importPersistService,
  type ImportRunProgress,
} from '@/lib/import/engine/importPersistService';
import type { ImportMapping } from '@/lib/import/engine/types';
import type {
  IssueSourceConnector,
  SourceIssue,
  SourceIssuePage,
} from '@/lib/import/connectors/types';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';

// Story MOTIR-7731 · MOTIR-8097 — imported text records NO language. Motir
// cannot vouch for what an imported issue was written in, and the story never
// fakes "no language" as a real value — so the importer opts out of the work
// item service's default (the organisation's content language) with
// `languageRecording: 'unrecorded'`, on create and on re-sync. The import path
// writes no to-dos (`grep -rn Todo lib/import` finds nothing). Real Postgres;
// the connector is the only fake.

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(() => db.$disconnect());

function sourceIssue(overrides: Partial<SourceIssue>): SourceIssue {
  return {
    externalId: 'EXT-1',
    title: 'A source issue',
    descriptionMd: null,
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
    ...overrides,
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
    async listIssues(): Promise<SourceIssuePage> {
      return { issues, nextCursor: null, errors: [] };
    },
  };
}

const MAPPING: ImportMapping = { defaultKind: 'task', typeToKind: {}, statusToKey: {} };

async function fixtureIn(language: string): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture();
  await adminDb.organization.update({
    where: { id: fx.workspace.organizationId },
    data: { contentLanguage: language },
  });
  return fx;
}

async function runImport(fx: WorkItemFixture, importId: string, issues: SourceIssue[]) {
  const events: ImportRunProgress[] = [];
  for await (const e of importPersistService.runImport({
    importId,
    connector: connectorOf(issues),
    mapping: MAPPING,
    ctx: await importEngineService.buildResolveContext(fx.projectId, fx.workspaceId, fx.ownerId),
  })) {
    events.push(e);
  }
  const summary = events.find((e) => e.type === 'summary');
  if (!summary || summary.type !== 'summary') throw new Error('no summary event');
  return summary;
}

describe('an import records no language', () => {
  it('leaves the title and description language NULL on create, and on a re-sync that edits the body', async () => {
    const fx = await fixtureIn('ja');
    const importId = (
      await adminDb.$transaction((tx) =>
        importRepository.create(
          {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            source: 'jira',
            createdById: fx.ownerId,
          },
          tx,
        ),
      )
    ).id;

    const run1 = await runImport(fx, importId, [
      sourceIssue({ externalId: 'ACME-1', title: 'Imported', descriptionMd: 'Body one' }),
    ]);
    expect(run1.counts).toMatchObject({ created: 1, failed: 0 });
    const created = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Imported' } });
    expect([created.titleLanguage, created.descriptionLanguage]).toEqual([null, null]);

    // Somehow recorded before the re-sync — the re-synced body still records none.
    await adminDb.workItem.update({
      where: { id: created.id },
      data: { titleLanguage: 'ja', descriptionLanguage: 'ja' },
    });
    const run2 = await runImport(fx, importId, [
      sourceIssue({ externalId: 'ACME-1', title: 'Imported', descriptionMd: 'Body two' }),
    ]);
    expect(run2.counts).toMatchObject({ updated: 1, failed: 0 });
    const resynced = await adminDb.workItem.findUniqueOrThrow({ where: { id: created.id } });
    expect(resynced.descriptionMd).toBe('Body two');
    expect(resynced.descriptionLanguage).toBeNull();
    // The title did not change, so its recorded language is left as it was.
    expect(resynced.titleLanguage).toBe('ja');
  });
});

describe("languageRecording: 'unrecorded'", () => {
  it('stores NULL on create even with an explicit language', async () => {
    const fx = await fixtureIn('ja');
    const dto = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: '제목',
        descriptionMd: '본문',
        language: 'ko',
        languageRecording: 'unrecorded',
      },
      fx.ctx,
    );
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: dto.id } });
    expect([row.titleLanguage, row.descriptionLanguage, row.explanationLanguage]).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('stores NULL on each edited field and leaves the others', async () => {
    const fx = await fixtureIn('ja');
    const dto = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'T', descriptionMd: 'B' },
      fx.ctx,
    );
    await workItemsService.updateWorkItem(
      dto.id,
      { descriptionMd: 'B2', language: 'ko', languageRecording: 'unrecorded' },
      fx.ctx,
    );
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: dto.id } });
    expect([row.titleLanguage, row.descriptionLanguage]).toEqual(['ja', null]);
  });
});
