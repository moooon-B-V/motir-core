import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { importRepository } from '@/lib/repositories/importRepository';
import { importedIssueRepository } from '@/lib/repositories/importedIssueRepository';
import { importEngineService } from '@/lib/import/engine/importEngineService';
import {
  importPersistService,
  type ImportRunProgress,
} from '@/lib/import/engine/importPersistService';
import { CsvConnector } from '@/lib/import/connectors/csvConnector';
import type { ImportMapping, ImportResolveContext } from '@/lib/import/engine/types';
import type {
  IssueSourceConnector,
  SourceIssue,
  SourceIssuePage,
} from '@/lib/import/connectors/types';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture, createTestUser } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// ── Story-816 (issue importer) INTEGRATION SEAM (MOTIR-944 · 7.16.8) ─────────
//
// The story-level vitest seam that locks the importer's THREE load-bearing
// properties over the ASSEMBLED pipeline — mapping → persist (workItemsService)
// → external-id map → dry-run — against a REAL Postgres. The only fakes are the
// CONNECTOR fetch boundary (an in-memory page / an inline CSV string standing
// in for a recorded source payload); the mapping, the persist, the idempotency
// map and the dry-run all run FOR REAL. `getSession()` is NOT mocked — the
// engine/persist are driven directly with a built context, exactly as the
// MOTIR-941 persist suite does.
//
// It is deliberately COMPLEMENTARY to (not a duplicate of) the per-subtask unit
// suites, which prove the pieces in isolation:
//   · importResolver.test         — the pure field mapping (payload only)
//   · importIdempotency.test      — computeSourceHash + classifyByHash (pure)
//   · importEngineService.test    — classifyIssue/preview with injected deps
//   · importPersistService.test   — the persist mechanics + run-status guard
//   · importService.test          — the service surface the routes call
//   · integration/import/repository.test — the leaf contracts + the concurrent
//                                          mapping-row race (deterministic)
// What THIS suite adds is the END-TO-END assertion: it reads the work items
// BACK out of Postgres after a real run and checks every mapped field landed,
// that a re-run neither duplicates nor clobbers, and that a dry-run writes
// nothing yet predicts the run exactly.

async function truncateAll(): Promise<void> {
  // work_item CASCADE carries away import / imported_issue rows.
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
 *  reads `.source` + `.listIssues`). */
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

async function makeDraftImport(
  fx: WorkItemFixture,
  source: IssueSourceConnector['source'] = 'jira',
): Promise<string> {
  const row = await db.$transaction((tx) =>
    importRepository.create(
      { workspaceId: fx.workspaceId, projectId: fx.projectId, source, createdById: fx.ownerId },
      tx,
    ),
  );
  return row.id;
}

function resolveCtx(fx: WorkItemFixture): Promise<ImportResolveContext> {
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

/** externalId → the plan verdict the run persisted (pass-1 item events only). */
function runPlanByExternalId(events: ImportRunProgress[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'item' && !e.error && e.workItemKey !== null) m.set(e.externalId, e.plan);
  }
  return m;
}

async function runOnce(
  fx: WorkItemFixture,
  importId: string,
  issues: SourceIssue[],
  mapping: ImportMapping,
  source: IssueSourceConnector['source'] = 'jira',
): Promise<ImportRunProgress[]> {
  return drain(
    importPersistService.runImport({
      importId,
      connector: fakeConnector(source, issues),
      mapping,
      ctx: await resolveCtx(fx),
    }),
  );
}

async function workItemCount(fx: WorkItemFixture): Promise<number> {
  return db.workItem.count({ where: { projectId: fx.projectId } });
}

async function mappingRowCount(fx: WorkItemFixture): Promise<number> {
  return db.importedIssue.count({ where: { projectId: fx.projectId } });
}

const MAPPING: ImportMapping = {
  defaultKind: 'task',
  typeToKind: { story: 'story', subtask: 'subtask', bug: 'bug', task: 'task' },
  statusToKey: { done: 'done', 'in progress': 'in_progress', todo: 'todo' },
  priorityToPriority: { high: 'high', low: 'low' },
};

// ── 1 · MAPPING CORRECTNESS — assembled, read back from Postgres ─────────────

describe('MOTIR-944 seam · mapping correctness (end-to-end through persist)', () => {
  it('maps every source field to the right Motir field on a real work item', async () => {
    const fx = await makeWorkItemFixture();
    // A second WORKSPACE member so a matched assignee resolves to someone OTHER
    // than the importing user — proving the email match, not a fallback.
    const dev = await createTestUser({ email: 'dev.two@example.com', name: 'Dev Two' });
    await workspacesService.addMember({ userId: dev.id, workspaceId: fx.workspaceId });

    const importId = await makeDraftImport(fx);
    const issue = makeSourceIssue({
      externalId: 'ACME-100',
      title: 'A mapped story',
      descriptionMd: 'The body.',
      type: 'story',
      status: 'done',
      priority: 'high',
      assigneeEmail: 'DEV.TWO@example.com', // case-insensitive match
      reporterEmail: 'dev.two@example.com',
      labels: ['ux', 'api'],
      comments: [
        {
          authorEmail: null,
          authorName: 'Jane Source',
          body: 'Looks good to me',
          createdAt: '2023-01-02T00:00:00.000Z',
        },
      ],
      createdAt: '2023-01-01T00:00:00.000Z',
      closedAt: '2023-01-03T00:00:00.000Z',
    });

    const ctx = await resolveCtx(fx);

    // Preview carries the fields persist does NOT apply (reporter, source
    // timestamps) — assert them at the resolved-payload level.
    const [preview] = await importEngineService.preview('jira', [issue], MAPPING, ctx);
    expect(preview!.payload.reporterId).toBe(dev.id);
    expect(preview!.payload.reporterEmail).toBe('dev.two@example.com');
    expect(preview!.payload.createdAt).toBe('2023-01-01T00:00:00.000Z');
    expect(preview!.payload.closedAt).toBe('2023-01-03T00:00:00.000Z');

    const events = await drain(
      importPersistService.runImport({
        importId,
        connector: fakeConnector('jira', [issue]),
        mapping: MAPPING,
        ctx,
      }),
    );
    expect(summaryOf(events).counts).toMatchObject({ created: 1, failed: 0 });

    const map = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'ACME-100');
    const item = await db.workItem.findUniqueOrThrow({ where: { id: map!.workItemId } });

    // Scalar field mapping.
    expect(item.kind).toBe('story'); // type → kind
    expect(item.status).toBe('done'); // status → project workflow_status (done-category reached)
    expect(item.priority).toBe('high'); // priority → priority
    expect(item.title).toBe('A mapped story');
    expect(item.descriptionMd).toBe('The body.');
    // assignee → the matched member (NOT the importing user).
    expect(item.assigneeId).toBe(dev.id);
    // reporter is NOT settable on import — forced to the importing user (the
    // ADR degraded fallback); the source reporter rode the preview payload above.
    expect(item.reporterId).toBe(fx.ownerId);

    // Labels → find-or-create + attach.
    const labels = await db.workItemLabel.findMany({
      where: { workItemId: item.id },
      include: { label: true },
    });
    expect(labels.map((l) => l.label.name).sort()).toEqual(['api', 'ux']);

    // Comment → imported once, author + timestamp preserved in the body.
    const comments = await db.comment.findMany({ where: { workItemId: item.id } });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyMd).toContain('Jane Source');
    expect(comments[0]!.bodyMd).toContain('2023-01-02T00:00:00.000Z');
    expect(comments[0]!.bodyMd).toContain('Looks good to me');
  });

  it('follows the unmatched-user policy — unassign leaves it null + warns; importing_user assigns the importer + warns', async () => {
    const fx = await makeWorkItemFixture();

    // unassign (the default): an unmatched assignee → null + a warning.
    const impA = await makeDraftImport(fx);
    const unassignEvents = await runOnce(
      fx,
      impA,
      [makeSourceIssue({ externalId: 'U-1', title: 'Nobody here', assigneeEmail: 'ghost@x.io' })],
      { ...MAPPING, unmatchedUserPolicy: 'unassign' },
    );
    const mapA = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'U-1');
    const itemA = await db.workItem.findUniqueOrThrow({ where: { id: mapA!.workItemId } });
    expect(itemA.assigneeId).toBeNull();
    expect(
      unassignEvents.some((e) => e.type === 'item' && e.warnings.some((w) => /unset/i.test(w))),
    ).toBe(true);

    // importing_user: an unmatched assignee → the importing user + a warning.
    const impB = await makeDraftImport(fx);
    const importerEvents = await runOnce(
      fx,
      impB,
      [makeSourceIssue({ externalId: 'U-2', title: 'Falls to me', assigneeEmail: 'ghost@x.io' })],
      { ...MAPPING, unmatchedUserPolicy: 'importing_user' },
    );
    const mapB = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'U-2');
    const itemB = await db.workItem.findUniqueOrThrow({ where: { id: mapB!.workItemId } });
    expect(itemB.assigneeId).toBe(fx.ownerId);
    expect(
      importerEvents.some(
        (e) => e.type === 'item' && e.warnings.some((w) => /importing user/i.test(w)),
      ),
    ).toBe(true);
  });

  it('a subtask with no importable parent is a WARNING, not a 500 — downgraded to a task, run succeeds', async () => {
    const fx = await makeWorkItemFixture();
    const importId = await makeDraftImport(fx);
    // A subtask needs a parent; this one references none → the resolver
    // legalises it to a `task` with a warning (never throws).
    const events = await runOnce(
      fx,
      importId,
      [makeSourceIssue({ externalId: 'ORPHAN', title: 'Lonely subtask', type: 'subtask' })],
      MAPPING,
    );

    expect(summaryOf(events).counts).toMatchObject({ created: 1, failed: 0 });
    expect(
      events.some(
        (e) => e.type === 'item' && e.warnings.some((w) => /subtask needs a parent/i.test(w)),
      ),
    ).toBe(true);
    const map = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'ORPHAN');
    const item = await db.workItem.findUniqueOrThrow({ where: { id: map!.workItemId } });
    expect(item.kind).toBe('task');
    expect(item.parentId).toBeNull();
  });

  it('wires the parent AND a relationship link in the 2nd pass — even when the child imports before its parent', async () => {
    const fx = await makeWorkItemFixture();
    const importId = await makeDraftImport(fx);
    // Child (subtask) FIRST, its parent story AFTER; plus a relates-to link
    // between the two siblings — both resolved in pass 2.
    const events = await runOnce(
      fx,
      importId,
      [
        makeSourceIssue({
          externalId: 'CHILD',
          title: 'Child',
          type: 'subtask',
          parentExternalId: 'PARENT',
          links: [{ type: 'relates to', targetExternalId: 'SIB' }],
        }),
        makeSourceIssue({ externalId: 'PARENT', title: 'Parent', type: 'story' }),
        makeSourceIssue({ externalId: 'SIB', title: 'Sibling', type: 'task' }),
      ],
      MAPPING,
    );
    expect(summaryOf(events).counts).toMatchObject({ created: 3, failed: 0 });

    const parentMap = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'PARENT');
    const childMap = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'CHILD');
    const sibMap = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'SIB');
    const child = await db.workItem.findUniqueOrThrow({ where: { id: childMap!.workItemId } });
    // Restored to subtask AND parented to the story (deferred-parent path).
    expect(child.kind).toBe('subtask');
    expect(child.parentId).toBe(parentMap!.workItemId);
    // The relationship link landed as a real work_item_link edge (relates_to
    // is stored with a reciprocal, so ≥1 row connects the two either way).
    const links = await db.workItemLink.findMany({
      where: {
        OR: [
          { fromId: childMap!.workItemId, toId: sibMap!.workItemId },
          { fromId: sibMap!.workItemId, toId: childMap!.workItemId },
        ],
      },
    });
    expect(links.length).toBeGreaterThanOrEqual(1);
  });

  it('a CSV with only SOME columns present maps the present fields and leaves the rest empty (no crash)', async () => {
    const fx = await makeWorkItemFixture();
    const importId = await makeDraftImport(fx, 'csv');
    // A narrow export: only id / title / type columns exist — no status,
    // priority, assignee, labels or parent columns at all.
    const csv = new CsvConnector({
      filename: 'partial.csv',
      content: ['id,title,type', 'C-1,First row,bug', 'C-2,Second row,task'].join('\n'),
    });

    const events = await drain(
      importPersistService.runImport({
        importId,
        connector: csv,
        mapping: MAPPING,
        ctx: await resolveCtx(fx),
      }),
    );
    expect(summaryOf(events).counts).toMatchObject({ created: 2, failed: 0 });

    const items = await db.workItem.findMany({
      where: { projectId: fx.projectId },
      orderBy: { key: 'asc' },
    });
    expect(items).toHaveLength(2);
    expect(items.map((w) => w.kind).sort()).toEqual(['bug', 'task']);
    // The absent columns → schema defaults, not a crash.
    for (const w of items) {
      expect(w.priority).toBe('medium'); // no priority column → the mapping default
      expect(w.assigneeId).toBeNull(); // no assignee column
    }
    const labelCount = await db.workItemLabel.count({
      where: { workItem: { projectId: fx.projectId } },
    });
    expect(labelCount).toBe(0); // no labels column
  });
});

// ── 2 · IDEMPOTENCY — the re-run-no-dupe property, assembled ─────────────────

describe('MOTIR-944 seam · idempotency (re-run creates no duplicates)', () => {
  const ISSUES = [
    makeSourceIssue({ externalId: 'ACME-1', title: 'First', status: 'todo' }),
    makeSourceIssue({ externalId: 'ACME-2', title: 'Second', status: 'todo' }),
    makeSourceIssue({ externalId: 'ACME-3', title: 'Third', status: 'todo' }),
  ];

  it('a first import creates N items + N mapping rows; an identical re-run creates ZERO (counts unchanged)', async () => {
    const fx = await makeWorkItemFixture();

    const run1 = summaryOf(await runOnce(fx, await makeDraftImport(fx), ISSUES, MAPPING));
    expect(run1.counts).toMatchObject({ created: 3, updated: 0, skipped: 0 });
    expect(await workItemCount(fx)).toBe(3);
    expect(await mappingRowCount(fx)).toBe(3);

    // A SECOND import of the identical source → every issue resolves through the
    // external-id map and SKIPs. Nothing new is written. (Were the external-id
    // map / unique constraint absent, this re-run would create 3 duplicates —
    // the count invariants below are precisely what guards idempotency.)
    const run2 = summaryOf(await runOnce(fx, await makeDraftImport(fx), ISSUES, MAPPING));
    expect(run2.counts).toMatchObject({ created: 0, updated: 0, skipped: 3 });
    expect(await workItemCount(fx)).toBe(3);
    expect(await mappingRowCount(fx)).toBe(3);
  });

  it('a source-side change UPDATEs exactly that one item in place; unchanged issues stay no-ops', async () => {
    const fx = await makeWorkItemFixture();
    await runOnce(fx, await makeDraftImport(fx), ISSUES, MAPPING);
    const before = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'ACME-1');

    const run = summaryOf(
      await runOnce(
        fx,
        await makeDraftImport(fx),
        [
          makeSourceIssue({ externalId: 'ACME-1', title: 'First (edited)', status: 'todo' }),
          ISSUES[1]!,
          ISSUES[2]!,
        ],
        MAPPING,
      ),
    );
    expect(run.counts).toMatchObject({ created: 0, updated: 1, skipped: 2 });
    expect(await workItemCount(fx)).toBe(3);
    expect(await mappingRowCount(fx)).toBe(3);

    const after = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'ACME-1');
    expect(after!.workItemId).toBe(before!.workItemId); // same work item, in place
    const edited = await db.workItem.findUniqueOrThrow({ where: { id: after!.workItemId } });
    expect(edited.title).toBe('First (edited)');
  });

  it('does NOT clobber local edits — a Motir-owned field the importer never syncs survives a re-run UPDATE', async () => {
    const fx = await makeWorkItemFixture();
    await runOnce(fx, await makeDraftImport(fx), [ISSUES[0]!], MAPPING);
    const map = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'ACME-1');

    // A local estimate/points edit — fields the importer does NOT own.
    await db.workItem.update({
      where: { id: map!.workItemId },
      data: { storyPoints: 8, estimateMinutes: 120 },
    });

    // Re-run with a CHANGED source title → the item UPDATEs (title re-synced)
    // but the local story points / estimate are left untouched.
    const run = summaryOf(
      await runOnce(
        fx,
        await makeDraftImport(fx),
        [
          makeSourceIssue({
            externalId: 'ACME-1',
            title: 'First (source moved on)',
            status: 'todo',
          }),
        ],
        MAPPING,
      ),
    );
    expect(run.counts).toMatchObject({ updated: 1 });
    const item = await db.workItem.findUniqueOrThrow({ where: { id: map!.workItemId } });
    expect(item.title).toBe('First (source moved on)'); // source field re-synced
    expect(Number(item.storyPoints)).toBe(8); // local edit survived
    expect(item.estimateMinutes).toBe(120); // local edit survived
  });

  it('the DB UNIQUE holds under a concurrent re-run — exactly ONE mapping row for the identity', async () => {
    const fx = await makeWorkItemFixture();
    // TWO distinct import runs of the SAME source issue, executed concurrently:
    // neither sees the other's mapping at classify time, so both attempt a
    // create — but the FOR UPDATE lock + `@@unique(project, source, externalId)`
    // + P2002-converge let exactly ONE mapping row exist. (The same guarantee
    // repository.test proves at the leaf; here it holds through the full engine.)
    const issue = [makeSourceIssue({ externalId: 'RACE-1', title: 'Contended' })];
    const [impA, impB, ctxA, ctxB] = await Promise.all([
      makeDraftImport(fx),
      makeDraftImport(fx),
      resolveCtx(fx),
      resolveCtx(fx),
    ]);

    const results = await Promise.allSettled([
      drain(
        importPersistService.runImport({
          importId: impA,
          connector: fakeConnector('jira', issue),
          mapping: MAPPING,
          ctx: ctxA,
        }),
      ),
      drain(
        importPersistService.runImport({
          importId: impB,
          connector: fakeConnector('jira', issue),
          mapping: MAPPING,
          ctx: ctxB,
        }),
      ),
    ]);
    // Neither run aborts — each surfaces its per-issue outcome and finishes.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    // The invariant the constraint guarantees: no duplicate mapping row.
    const rows = await db.importedIssue.count({
      where: { projectId: fx.projectId, source: 'jira', externalId: 'RACE-1' },
    });
    expect(rows).toBe(1);
  });
});

// ── 3 · DRY-RUN — writes nothing, and predicts the run exactly ───────────────

describe('MOTIR-944 seam · dry-run (preview writes nothing + matches the run)', () => {
  it('preview classifies every issue and WRITES NOTHING — work-item + mapping counts stay zero', async () => {
    const fx = await makeWorkItemFixture();
    const ctx = await resolveCtx(fx);
    const issues = [
      makeSourceIssue({ externalId: 'P-1', title: 'One', type: 'bug', status: 'done' }),
      makeSourceIssue({ externalId: 'P-2', title: 'Two', status: 'todo' }),
    ];

    const rows = await importEngineService.preview('jira', issues, MAPPING, ctx);
    expect(rows.map((r) => r.plan)).toEqual(['create', 'create']);
    // The preview is write-free: not one work item, not one mapping row.
    expect(await workItemCount(fx)).toBe(0);
    expect(await mappingRowCount(fx)).toBe(0);
  });

  it('the preview plan MATCHES the subsequent real run — CREATE / UPDATE / SKIP align per issue', async () => {
    const fx = await makeWorkItemFixture();
    // Seed a prior run so a mixed re-import spans all three verdicts.
    await runOnce(
      fx,
      await makeDraftImport(fx),
      [
        makeSourceIssue({ externalId: 'M-A', title: 'Alpha', status: 'todo' }),
        makeSourceIssue({ externalId: 'M-B', title: 'Bravo', status: 'todo' }),
      ],
      MAPPING,
    );

    // The batch: A unchanged (→skip), B changed (→update), C brand new (→create).
    const batch = [
      makeSourceIssue({ externalId: 'M-A', title: 'Alpha', status: 'todo' }),
      makeSourceIssue({ externalId: 'M-B', title: 'Bravo (edited)', status: 'todo' }),
      makeSourceIssue({ externalId: 'M-C', title: 'Charlie', status: 'todo' }),
    ];

    // Dry-run FIRST (writes nothing), then the real run.
    const previewRows = await importEngineService.preview(
      'jira',
      batch,
      MAPPING,
      await resolveCtx(fx),
    );
    const previewPlan = new Map(previewRows.map((r) => [r.externalId, r.plan]));
    expect(previewPlan).toEqual(
      new Map([
        ['M-A', 'skip'],
        ['M-B', 'update'],
        ['M-C', 'create'],
      ]),
    );

    const runEvents = await runOnce(fx, await makeDraftImport(fx), batch, MAPPING);
    // The run's actual verdicts equal what the preview predicted — same engine.
    expect(runPlanByExternalId(runEvents)).toEqual(previewPlan);
    expect(summaryOf(runEvents).counts).toMatchObject({ created: 1, updated: 1, skipped: 1 });
  });
});
