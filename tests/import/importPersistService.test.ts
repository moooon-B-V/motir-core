import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { importRepository } from '@/lib/repositories/importRepository';
import { importedIssueRepository } from '@/lib/repositories/importedIssueRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { importEngineService } from '@/lib/import/engine/importEngineService';
import {
  importPersistService,
  type ImportRunProgress,
} from '@/lib/import/engine/importPersistService';
import type { ImportEngineDeps } from '@/lib/import/engine/importEngineService';
import type { ImportMapping, ImportResolveContext } from '@/lib/import/engine/types';
import type {
  IssueSourceConnector,
  SourceIssue,
  SourceIssuePage,
} from '@/lib/import/connectors/types';
import { UnknownStatusError, IllegalTransitionError } from '@/lib/workItems/errors';
import { truncateAuthTables } from '../helpers/db';
import { makeWorkItemFixture, createTestWorkItem } from '../fixtures';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';

// Engine-level tests for the Story-7.16 PERSIST slice (MOTIR-941): the
// write-enabled importer engine + the `setImportedStatus` extension. Real
// Postgres (no mocks), per CLAUDE.md — the source CONNECTOR is the only fake
// (an injected in-memory page); every write goes through the real
// `workItemsService` + Postgres, so these prove the AC end-to-end: sole write
// path, idempotent re-run (no dupe), the same engine as preview, the parent
// 2nd pass + matrix, batched per-issue partial failure, and reaching a
// done-category status.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe('TRUNCATE TABLE "work_item" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
}

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

// ── fixtures ────────────────────────────────────────────────────────────────

function makeSourceIssue(overrides: Partial<SourceIssue> = {}): SourceIssue {
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

/** A minimal connector that yields the given issues as ONE page (runImport only
 *  uses `.source` + `.listIssues`). */
function fakeConnector(
  source: IssueSourceConnector['source'],
  issues: SourceIssue[],
): IssueSourceConnector {
  return {
    source,
    async connect() {
      return { source, sourceRef: 'FAKE', issueCount: issues.length };
    },
    async discoverFields() {
      return { types: [], statuses: [], priorities: [], labels: [] };
    },
    async listIssues(): Promise<SourceIssuePage> {
      return { issues, nextCursor: null, errors: [] };
    },
  };
}

async function makeDraftImport(fx: WorkItemFixture, source = 'jira' as const): Promise<string> {
  const row = await db.$transaction((tx) =>
    importRepository.create(
      { workspaceId: fx.workspaceId, projectId: fx.projectId, source, createdById: fx.ownerId },
      tx,
    ),
  );
  return row.id;
}

async function resolveCtx(fx: WorkItemFixture): Promise<ImportResolveContext> {
  return importEngineService.buildResolveContext(fx.projectId, fx.workspaceId, fx.ownerId);
}

async function drain(gen: AsyncGenerator<ImportRunProgress>): Promise<ImportRunProgress[]> {
  const out: ImportRunProgress[] = [];
  for await (const p of gen) out.push(p);
  return out;
}

function summaryOf(events: ImportRunProgress[]) {
  const s = events.find((e) => e.type === 'summary');
  if (!s || s.type !== 'summary') throw new Error('no summary event');
  return s;
}

const MAPPING: ImportMapping = {
  defaultKind: 'task',
  typeToKind: { story: 'story', subtask: 'subtask', bug: 'bug' },
  statusToKey: { done: 'done', 'in progress': 'in_progress', todo: 'todo' },
};

// ── the persist engine ──────────────────────────────────────────────────────

describe('importPersistService.runImport', () => {
  it('CREATEs each issue through workItemsService, records the map + counts, and applies a done-category status', async () => {
    const fx = await makeWorkItemFixture();
    const importId = await makeDraftImport(fx);
    const connector = fakeConnector('jira', [
      makeSourceIssue({
        externalId: 'ACME-1',
        title: 'Open task',
        status: 'todo',
        labels: ['imported', 'ux'],
      }),
      makeSourceIssue({ externalId: 'ACME-2', title: 'Closed bug', type: 'bug', status: 'done' }),
    ]);

    const events = await drain(
      importPersistService.runImport({
        importId,
        connector,
        mapping: MAPPING,
        ctx: await resolveCtx(fx),
      }),
    );

    const summary = summaryOf(events);
    expect(summary.counts).toEqual({ created: 2, updated: 0, skipped: 0, failed: 0 });
    expect(summary.status).toBe('succeeded');

    // Both items exist — through the real service (so tenant + validation ran).
    const items = await db.workItem.findMany({
      where: { projectId: fx.projectId },
      orderBy: { key: 'asc' },
    });
    expect(items).toHaveLength(2);
    const closed = items.find((w) => w.title === 'Closed bug')!;
    expect(closed.kind).toBe('bug');
    // The mapped done-category status was reached DIRECTLY (no legal edge from todo).
    expect(closed.status).toBe('done');

    // The idempotency map has a row per issue.
    const map1 = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'ACME-1');
    const map2 = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'ACME-2');
    expect(map1?.workItemId).toBeTruthy();
    expect(map2?.sourceHash).toBeTruthy();

    // The Import row carries the final counts + status.
    const imp = await importRepository.findById(importId);
    expect(imp?.status).toBe('succeeded');
    expect(imp?.createdCount).toBe(2);

    // Labels were applied via the sibling service.
    const labels = await db.label.findMany({ where: { workspaceId: fx.workspaceId } });
    expect(labels.map((l) => l.name).sort()).toEqual(['imported', 'ux']);
  });

  it('is IDEMPOTENT — a re-run of unchanged issues SKIPs (no duplicates); a changed issue UPDATEs in place', async () => {
    const fx = await makeWorkItemFixture();
    const importId = await makeDraftImport(fx);
    const issues = [
      makeSourceIssue({ externalId: 'ACME-1', title: 'First', status: 'todo' }),
      makeSourceIssue({ externalId: 'ACME-2', title: 'Second', status: 'todo' }),
    ];

    // First run — two creates.
    const run1 = summaryOf(
      await drain(
        importPersistService.runImport({
          importId,
          connector: fakeConnector('jira', issues),
          mapping: MAPPING,
          ctx: await resolveCtx(fx),
        }),
      ),
    );
    expect(run1.counts).toMatchObject({ created: 2, updated: 0 });
    const afterFirst = await db.workItem.count({ where: { projectId: fx.projectId } });
    expect(afterFirst).toBe(2);

    // Second run, IDENTICAL issues — all skip, zero new work items.
    const run2 = summaryOf(
      await drain(
        importPersistService.runImport({
          importId,
          connector: fakeConnector('jira', issues),
          mapping: MAPPING,
          ctx: await resolveCtx(fx),
        }),
      ),
    );
    expect(run2.counts).toMatchObject({ created: 0, updated: 0, skipped: 2 });
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(2);

    // Third run — ACME-1 changed at source → UPDATE the SAME work item, still no dupe.
    const mapBefore = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'ACME-1');
    const run3 = summaryOf(
      await drain(
        importPersistService.runImport({
          importId,
          connector: fakeConnector('jira', [
            makeSourceIssue({ externalId: 'ACME-1', title: 'First (edited)', status: 'todo' }),
            makeSourceIssue({ externalId: 'ACME-2', title: 'Second', status: 'todo' }),
          ]),
          mapping: MAPPING,
          ctx: await resolveCtx(fx),
        }),
      ),
    );
    expect(run3.counts).toMatchObject({ created: 0, updated: 1, skipped: 1 });
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(2);
    const mapAfter = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'ACME-1');
    // Same mapped work item; the edited title is now on it.
    expect(mapAfter?.workItemId).toBe(mapBefore?.workItemId);
    const edited = await db.workItem.findUnique({ where: { id: mapAfter!.workItemId } });
    expect(edited?.title).toBe('First (edited)');
  });

  it('resolves the PARENT edge in a 2nd pass even when the child imports BEFORE its parent (subtask restored)', async () => {
    const fx = await makeWorkItemFixture();
    const importId = await makeDraftImport(fx);
    // Child (a subtask) comes FIRST; its parent story comes after.
    const connector = fakeConnector('jira', [
      makeSourceIssue({
        externalId: 'CHILD',
        title: 'Child',
        type: 'subtask',
        parentExternalId: 'PARENT',
      }),
      makeSourceIssue({ externalId: 'PARENT', title: 'Parent', type: 'story' }),
    ]);

    const events = await drain(
      importPersistService.runImport({
        importId,
        connector,
        mapping: MAPPING,
        ctx: await resolveCtx(fx),
      }),
    );
    expect(summaryOf(events).counts).toMatchObject({ created: 2, failed: 0 });

    const parentMap = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'PARENT');
    const childMap = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'CHILD');
    const child = await db.workItem.findUnique({ where: { id: childMap!.workItemId } });
    // Restored to subtask AND parented to the story (the deferred-parent path).
    expect(child?.kind).toBe('subtask');
    expect(child?.parentId).toBe(parentMap!.workItemId);
  });

  it('honours the kind-parent matrix — an illegal parent edge is a WARNING, not a throw', async () => {
    const fx = await makeWorkItemFixture();
    const importId = await makeDraftImport(fx);
    // A subtask cannot parent anything → the child edge is illegal.
    const connector = fakeConnector('jira', [
      makeSourceIssue({
        externalId: 'P',
        title: 'A subtask parent',
        type: 'subtask',
        parentExternalId: 'GP',
      }),
      makeSourceIssue({ externalId: 'GP', title: 'Grandparent', type: 'story' }),
      makeSourceIssue({
        externalId: 'C',
        title: 'Child of a subtask',
        type: 'task',
        parentExternalId: 'P',
      }),
    ]);

    const events = await drain(
      importPersistService.runImport({
        importId,
        connector,
        mapping: MAPPING,
        ctx: await resolveCtx(fx),
      }),
    );
    // No throw; all three created; the illegal edge surfaced a warning.
    expect(summaryOf(events).counts).toMatchObject({ created: 3, failed: 0 });
    const warned = events.some(
      (e) => e.type === 'item' && e.warnings.some((w) => /cannot parent/.test(w)),
    );
    expect(warned).toBe(true);
    // The child of the (illegal) subtask parent was left unparented (not 500'd).
    const cMap = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'C');
    const c = await db.workItem.findUnique({ where: { id: cMap!.workItemId } });
    expect(c?.parentId).toBeNull();
  });

  it('records a per-issue PARTIAL failure and COMMITS the rest of the run', async () => {
    const fx = await makeWorkItemFixture();
    const importId = await makeDraftImport(fx);
    const connector = fakeConnector('jira', [
      makeSourceIssue({ externalId: 'OK-1', title: 'Fine' }),
      makeSourceIssue({ externalId: 'BAD', title: 'Boom' }),
      makeSourceIssue({ externalId: 'OK-2', title: 'Also fine' }),
    ]);
    // Force ONLY the BAD issue's classify to throw (the idempotency-lookup seam).
    const deps: ImportEngineDeps = {
      lookupExisting: async (p, s, externalId) => {
        if (externalId === 'BAD') throw new Error('lookup blew up');
        return importedIssueRepository.findBySourceId(p, s, externalId);
      },
    };

    const events = await drain(
      importPersistService.runImport(
        { importId, connector, mapping: MAPPING, ctx: await resolveCtx(fx) },
        deps,
      ),
    );

    const summary = summaryOf(events);
    expect(summary.counts).toMatchObject({ created: 2, failed: 1 });
    expect(summary.status).toBe('partially_failed');
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(2);
    const failed = events.find((e) => e.type === 'item' && e.error);
    expect(failed && failed.type === 'item' && failed.externalId).toBe('BAD');
  });

  it('is the SAME engine as the preview — preview classifies CREATE, the run persists, a re-preview classifies SKIP', async () => {
    const fx = await makeWorkItemFixture();
    const importId = await makeDraftImport(fx);
    const issues = [makeSourceIssue({ externalId: 'ACME-9', title: 'Once', status: 'todo' })];
    const ctx = await resolveCtx(fx);

    const before = await importEngineService.preview('jira', issues, MAPPING, ctx);
    expect(before[0]!.plan).toBe('create');

    await drain(
      importPersistService.runImport({
        importId,
        connector: fakeConnector('jira', issues),
        mapping: MAPPING,
        ctx,
      }),
    );

    // The identical classify path now sees the mapping row → SKIP (unchanged).
    const after = await importEngineService.preview('jira', issues, MAPPING, await resolveCtx(fx));
    expect(after[0]!.plan).toBe('skip');
  });

  it('rejects a second CONCURRENT run of the same import (the run-status guard)', async () => {
    const fx = await makeWorkItemFixture();
    const importId = await makeDraftImport(fx);
    // Mark it running out-of-band to simulate an in-flight run.
    await db.$transaction((tx) => importRepository.update(importId, { status: 'running' }, tx));

    const gen = importPersistService.runImport({
      importId,
      connector: fakeConnector('jira', [makeSourceIssue()]),
      mapping: MAPPING,
      ctx: await resolveCtx(fx),
    });
    await expect(drain(gen)).rejects.toThrow(/already running/i);
  });
});

// ── the status-on-import extension ──────────────────────────────────────────

describe('workItemsService.setImportedStatus (system-context)', () => {
  it('reaches a done-category status DIRECTLY, bypassing the interactive legal edges', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'x' });

    // The ordinary transition path forbids todo → done (no legal edge).
    await expect(workItemsService.updateStatus(item.id, 'done', fx.ctx)).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );

    // The system/import path reaches it.
    const moved = await workItemsService.setImportedStatus(item.id, 'done', fx.ctx);
    expect(moved.status).toBe('done');
  });

  it('still validates the target is a REAL project status', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'y' });
    await expect(
      workItemsService.setImportedStatus(item.id, 'not_a_status', fx.ctx),
    ).rejects.toBeInstanceOf(UnknownStatusError);
  });
});
