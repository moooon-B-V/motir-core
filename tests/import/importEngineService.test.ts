import { describe, expect, it } from 'vitest';
import {
  importEngineService,
  type ImportEngineDeps,
} from '@/lib/import/engine/importEngineService';
import type { ImportMapping, ImportResolveContext } from '@/lib/import/engine/types';
import type {
  IssueSourceConnector,
  SourceIssue,
  SourceIssuePage,
} from '@/lib/import/connectors/types';
import type { ImportedIssue } from '@prisma/client';

// Unit tests for the engine service (MOTIR-1504) with injected read seams — no
// Postgres. Covers classify CREATE/UPDATE/SKIP, streaming preview, context
// build, and connector-driven streaming.

function ctx(overrides: Partial<ImportResolveContext> = {}): ImportResolveContext {
  return {
    projectId: 'p',
    workspaceId: 'w',
    importingUserId: 'u-me',
    statusKeys: new Set(['todo', 'done']),
    initialStatusKey: 'todo',
    membersByEmail: new Map(),
    ...overrides,
  };
}

function issue(id: string, overrides: Partial<SourceIssue> = {}): SourceIssue {
  return {
    externalId: id,
    title: `Issue ${id}`,
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

const MAPPING: ImportMapping = {};

function existingRow(sourceHash: string | null): ImportedIssue {
  return {
    id: 'ii-1',
    workspaceId: 'w',
    projectId: 'p',
    importId: null,
    source: 'github',
    externalId: 'X-1',
    workItemId: 'wi-1',
    sourceHash,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as ImportedIssue;
}

describe('importEngineService.classifyIssue', () => {
  it('classifies CREATE when there is no existing mapping', async () => {
    const deps: ImportEngineDeps = { lookupExisting: async () => null };
    const row = await importEngineService.classifyIssue(
      'github',
      issue('X-1'),
      MAPPING,
      ctx(),
      deps,
    );
    expect(row.plan).toBe('create');
    expect(row.existingWorkItemId).toBeNull();
    expect(row.payload.kind).toBe('task');
  });

  it('classifies UPDATE when the stored hash differs', async () => {
    const deps: ImportEngineDeps = { lookupExisting: async () => existingRow('stale-hash') };
    const row = await importEngineService.classifyIssue(
      'github',
      issue('X-1'),
      MAPPING,
      ctx(),
      deps,
    );
    expect(row.plan).toBe('update');
    expect(row.existingWorkItemId).toBe('wi-1');
  });

  it('classifies SKIP when the stored hash matches the freshly computed one', async () => {
    // First classify to learn the hash, then feed it back as the stored hash.
    const first = await importEngineService.classifyIssue('github', issue('X-1'), MAPPING, ctx(), {
      lookupExisting: async () => null,
    });
    const deps: ImportEngineDeps = { lookupExisting: async () => existingRow(first.sourceHash) };
    const row = await importEngineService.classifyIssue(
      'github',
      issue('X-1'),
      MAPPING,
      ctx(),
      deps,
    );
    expect(row.plan).toBe('skip');
  });
});

describe('importEngineService.preview', () => {
  it('streams a plan row per issue and writes nothing (injected lookup)', async () => {
    const looked: string[] = [];
    const deps: ImportEngineDeps = {
      lookupExisting: async (_p, _s, e) => {
        looked.push(e);
        return null;
      },
    };
    const rows = await importEngineService.preview(
      'github',
      [issue('X-1'), issue('X-2')],
      MAPPING,
      ctx(),
      deps,
    );
    expect(rows.map((r) => r.externalId)).toEqual(['X-1', 'X-2']);
    expect(rows.every((r) => r.plan === 'create')).toBe(true);
    expect(looked).toEqual(['X-1', 'X-2']);
  });
});

describe('importEngineService.buildResolveContext', () => {
  it('builds status keys, initial status, and members-by-email from injected loaders', async () => {
    const deps: ImportEngineDeps = {
      loadStatuses: async () => [
        {
          id: 's1',
          projectId: 'p',
          key: 'todo',
          label: 'To Do',
          category: 'todo',
          color: null,
          position: 'a0',
          isInitial: true,
        },
        {
          id: 's2',
          projectId: 'p',
          key: 'done',
          label: 'Done',
          category: 'done',
          color: null,
          position: 'a1',
          isInitial: false,
        },
      ],
      loadMembers: async () => [
        { userId: 'u1', email: 'Dev@X.com' },
        { userId: 'u2', email: null },
      ],
    };
    const built = await importEngineService.buildResolveContext('p', 'w', 'u-me', deps);
    expect([...built.statusKeys]).toEqual(['todo', 'done']);
    expect(built.initialStatusKey).toBe('todo');
    expect(built.membersByEmail.get('dev@x.com')).toBe('u1'); // lowercased
    expect(built.membersByEmail.size).toBe(1); // null email skipped
  });
});

describe('importEngineService.previewFromConnector', () => {
  it('drives a paginated connector to exhaustion', async () => {
    const pages: Record<string, SourceIssuePage> = {
      START: { issues: [issue('X-1')], nextCursor: '2', errors: [] },
      '2': { issues: [issue('X-2')], nextCursor: null, errors: [] },
    };
    const connector: IssueSourceConnector = {
      source: 'github',
      connect: async () => ({ source: 'github', sourceRef: 'a/b', issueCount: null }),
      discoverFields: async () => ({ types: [], statuses: [], priorities: [], labels: [] }),
      listIssues: async (cursor) => pages[cursor ?? 'START']!,
    };
    const rows = [];
    for await (const row of importEngineService.previewFromConnector(connector, MAPPING, ctx(), {
      lookupExisting: async () => null,
    })) {
      rows.push(row);
    }
    expect(rows.map((r) => r.externalId)).toEqual(['X-1', 'X-2']);
  });
});
