import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { importService } from '@/lib/services/importService';
import type { ImportConnectionConfig } from '@/lib/dto/import';
import type { ImportMapping } from '@/lib/import/engine/types';
import {
  ImportConnectionConfigError,
  ImportNotFoundError,
  ImportSourceNotConnectedError,
} from '@/lib/import/errors';
import { usersService } from '@/lib/services/usersService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { truncateAuthTables } from '../helpers/db';
import { makeWorkItemFixture } from '../fixtures';

// Service-layer tests for the import RUN surface (MOTIR-941) — the ONE service
// the API routes call. Real Postgres; the CSV connector (credential-free) gives
// full create-draft → preview → run coverage end-to-end without live-source
// plumbing. The live-source path's credential gate is covered via its typed
// error.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe('TRUNCATE TABLE "work_item" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
}
beforeEach(truncateAll);
afterAll(() => db.$disconnect());

const CSV_HEADER = 'Issue key,Summary,Type,Status,Priority,Assignee,Labels,Parent,Created';
function csvConnection(...rows: string[]): ImportConnectionConfig {
  return { source: 'csv', filename: 'export.csv', content: [CSV_HEADER, ...rows].join('\n') };
}
const CSV_MAPPING: ImportMapping = {
  defaultKind: 'task',
  typeToKind: { bug: 'bug', task: 'task' },
  statusToKey: { open: 'todo', done: 'done' },
};

describe('importService', () => {
  it('createDraft creates a draft import and getImport reads it back (status + zero counts)', async () => {
    const fx = await makeWorkItemFixture();
    const draft = await importService.createDraft(
      { projectId: fx.projectId, source: 'csv', sourceRef: 'export.csv' },
      fx.ctx,
    );
    expect(draft.status).toBe('draft');
    expect(draft.counts).toEqual({ created: 0, updated: 0, skipped: 0, failed: 0 });

    const read = await importService.getImport(draft.id, fx.ctx);
    expect(read.id).toBe(draft.id);
    expect(read.source).toBe('csv');
    expect(read.sourceRef).toBe('export.csv');
  });

  it('getImport is tenant-scoped — a foreign workspace id is a 404 (ImportNotFoundError)', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ identifier: 'OTHER', name: 'Other' });
    const draft = await importService.createDraft(
      { projectId: fx.projectId, source: 'csv' },
      fx.ctx,
    );
    await expect(importService.getImport(draft.id, other.ctx)).rejects.toBeInstanceOf(
      ImportNotFoundError,
    );
  });

  it('preview classifies with no writes, then stores the mapping + a previewed status', async () => {
    const fx = await makeWorkItemFixture();
    const draft = await importService.createDraft(
      { projectId: fx.projectId, source: 'csv' },
      fx.ctx,
    );
    const conn = csvConnection('ACME-1,First,Task,Open,,,,,', 'ACME-2,Second,Bug,Done,,,,,');

    const result = await importService.preview(
      draft.id,
      { mapping: CSV_MAPPING, connection: conn },
      fx.ctx,
    );
    expect(result.counts).toEqual({ create: 2, update: 0, skip: 0 });
    // No writes happened.
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);

    const after = await importService.getImport(draft.id, fx.ctx);
    expect(after.status).toBe('previewed');
    expect(after.mapping).toMatchObject({ statusToKey: { open: 'todo', done: 'done' } });
  });

  it('run wires the connector into the persist engine — CSV rows become work items end-to-end', async () => {
    const fx = await makeWorkItemFixture();
    const draft = await importService.createDraft(
      { projectId: fx.projectId, source: 'csv' },
      fx.ctx,
    );
    const conn = csvConnection('ACME-1,First,Task,Open,,,,,', 'ACME-2,Second,Bug,Done,,,,,');

    const gen = await importService.run(
      draft.id,
      { mapping: CSV_MAPPING, connection: conn },
      fx.ctx,
    );
    let summary: { created: number } | null = null;
    for await (const p of gen) if (p.type === 'summary') summary = p.counts;
    expect(summary?.created).toBe(2);

    const items = await db.workItem.findMany({ where: { projectId: fx.projectId } });
    expect(items).toHaveLength(2);
    const finished = await importService.getImport(draft.id, fx.ctx);
    expect(finished.status).toBe('succeeded');
    expect(finished.counts.created).toBe(2);
  });

  it('run rejects when no mapping is supplied and none was stored', async () => {
    const fx = await makeWorkItemFixture();
    const draft = await importService.createDraft(
      { projectId: fx.projectId, source: 'csv' },
      fx.ctx,
    );
    await expect(
      importService.run(
        draft.id,
        { connection: csvConnection('ACME-1,First,Task,Open,,,,,') },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ImportConnectionConfigError);
  });

  it('discoverFields — probes reachability and returns the field vocabulary (CSV, no writes)', async () => {
    const fx = await makeWorkItemFixture();
    const draft = await importService.createDraft(
      { projectId: fx.projectId, source: 'csv' },
      fx.ctx,
    );
    const conn = csvConnection(
      'ACME-1,First,Task,Open,Medium,,,',
      'ACME-2,Second,Bug,Done,High,alice,,',
    );

    const result = await importService.discoverFields(draft.id, { connection: conn }, fx.ctx);

    expect(result.connect.sourceRef).toBe('export.csv');
    expect(result.connect.issueCount).toBe(2);
    expect(result.vocabulary.types).toContain('Task');
    expect(result.vocabulary.types).toContain('Bug');
    expect(result.vocabulary.statuses).toContain('Open');
    expect(result.vocabulary.statuses).toContain('Done');
    expect(result.vocabulary.priorities).toContain('Medium');
    expect(result.vocabulary.priorities).toContain('High');
    // No writes happened (read-only probe).
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('a live source with no connected identity is rejected (ImportSourceNotConnectedError)', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      importService.buildConnector(
        'jira',
        { source: 'jira', baseUrl: 'https://x.atlassian.net' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ImportSourceNotConnectedError);
  });
});

// The `import:run` GATE (Story MOTIR-2291 · Subtask MOTIR-2353) — the largest
// single revocation in the story: four of these five operations asserted
// `assertCanEdit`, so every project MEMBER could pull an entire external backlog
// into a project, and the fifth (`getImport`) asked nothing at all. Both mirrors
// put imports behind administration, so the key is admin-only. The member refusal
// IS the deliverable, so it is asserted rather than implied.
describe('importService — the import:run gate', () => {
  interface Actors {
    projectId: string;
    adminCtx: ServiceContext;
    memberCtx: ServiceContext;
    foreignCtx: ServiceContext;
  }

  let gateSeq = 0;
  async function makeActors(): Promise<Actors> {
    gateSeq += 1;
    const fx = await makeWorkItemFixture({ identifier: `IG${gateSeq}` });
    async function enroll(slug: string, role: 'admin' | 'member'): Promise<ServiceContext> {
      const user = await usersService.createUser({
        email: `import-${slug}-${gateSeq}@example.com`,
        password: 'hunter2hunter2',
        name: slug,
      });
      await db.workspaceMembership.create({
        data: { userId: user.id, workspaceId: fx.workspaceId, role: 'member' },
      });
      await projectMembersService.addMember({
        key: fx.projectIdentifier,
        actorUserId: fx.ownerId,
        ctx: fx.ctx,
        targetUserId: user.id,
        role,
      });
      return { userId: user.id, workspaceId: fx.workspaceId };
    }
    const foreign = await makeWorkItemFixture({ identifier: `IF${gateSeq}`, name: 'Foreign' });
    return {
      projectId: fx.projectId,
      adminCtx: await enroll('admin', 'admin'),
      memberCtx: await enroll('member', 'member'),
      foreignCtx: foreign.ctx,
    };
  }

  it('refuses a project MEMBER every one of the five — the revocation, stated', async () => {
    const a = await makeActors();
    // create is refused outright…
    await expect(
      importService.createDraft({ projectId: a.projectId, source: 'csv' }, a.memberCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    // …and so is every operation on a draft an admin made.
    const draft = await importService.createDraft(
      { projectId: a.projectId, source: 'csv' },
      a.adminCtx,
    );
    const connection = csvConnection('K-1,One,task,open,,,,,2026-01-01');
    await expect(importService.getImport(draft.id, a.memberCtx)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(
      importService.discoverFields(draft.id, { connection }, a.memberCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      importService.preview(draft.id, { connection, mapping: CSV_MAPPING }, a.memberCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      importService.run(draft.id, { connection, mapping: CSV_MAPPING }, a.memberCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('admits a project ADMIN through the whole wizard', async () => {
    const a = await makeActors();
    const draft = await importService.createDraft(
      { projectId: a.projectId, source: 'csv' },
      a.adminCtx,
    );
    const connection = csvConnection('K-1,One,task,open,,,,,2026-01-01');
    await expect(importService.getImport(draft.id, a.adminCtx)).resolves.toBeTruthy();
    await expect(
      importService.preview(draft.id, { connection, mapping: CSV_MAPPING }, a.adminCtx),
    ).resolves.toBeTruthy();
  });

  it('keeps the non-browser refusal shaped as a 404, never a 403', async () => {
    // `createDraft` resolves the project itself, so a foreign id is
    // ProjectNotFoundError before the key is ever tested — the no-existence-leak
    // ordering, unchanged by this card.
    const a = await makeActors();
    await expect(
      importService.createDraft({ projectId: a.projectId, source: 'csv' }, a.foreignCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
