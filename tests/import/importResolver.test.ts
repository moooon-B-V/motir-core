import { describe, expect, it } from 'vitest';
import { resolveIssue } from '@/lib/import/engine/importResolver';
import type { ImportMapping, ImportResolveContext } from '@/lib/import/engine/types';
import type { SourceIssue } from '@/lib/import/connectors/types';

// Unit tests for the pure mapping resolver (MOTIR-1504). No DB.

function ctx(overrides: Partial<ImportResolveContext> = {}): ImportResolveContext {
  return {
    projectId: 'p',
    workspaceId: 'w',
    importingUserId: 'u-me',
    statusKeys: new Set(['todo', 'in_progress', 'done']),
    initialStatusKey: 'todo',
    membersByEmail: new Map([['dev@x.com', 'u-dev']]),
    ...overrides,
  };
}

function issue(overrides: Partial<SourceIssue> = {}): SourceIssue {
  return {
    externalId: 'PROJ-1',
    title: 'A task',
    descriptionMd: 'body',
    type: 'Bug',
    status: 'Done',
    priority: 'High',
    assigneeEmail: 'dev@x.com',
    assigneeName: 'Dev',
    reporterEmail: 'dev@x.com',
    reporterName: 'Dev',
    labels: ['ui'],
    comments: [
      {
        authorEmail: 'dev@x.com',
        authorName: 'Dev',
        body: 'hi',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
    attachments: [],
    parentExternalId: null,
    links: [],
    createdAt: '2026-01-01T00:00:00Z',
    closedAt: '2026-02-01T00:00:00Z',
    ...overrides,
  };
}

const MAPPING: ImportMapping = {
  typeToKind: { Bug: 'bug', Story: 'story', Sub: 'subtask', Epic: 'epic' },
  statusToKey: { 'In Progress': 'in_progress', Done: 'done' },
  priorityToPriority: { High: 'high', Low: 'low' },
  unmatchedUserPolicy: 'unassign',
};

describe('resolveIssue — mapping', () => {
  it('maps type/status/priority/assignee/labels/comments', () => {
    const { payload, warnings } = resolveIssue(issue(), MAPPING, ctx());
    expect(payload).toMatchObject({
      kind: 'bug',
      title: 'A task',
      priority: 'high',
      statusKey: 'done',
      assigneeId: 'u-dev',
      reporterId: 'u-dev',
      labels: ['ui'],
    });
    expect(payload.comments[0]).toMatchObject({ authorId: 'u-dev', body: 'hi' });
    expect(warnings).toEqual([]);
  });

  it('falls back to the default kind (task) + warns on an unmapped type', () => {
    const { payload, warnings } = resolveIssue(issue({ type: 'Weird' }), MAPPING, ctx());
    expect(payload.kind).toBe('task');
    expect(warnings.some((w) => /unmapped type "Weird"/.test(w))).toBe(true);
  });

  it('legalises a parentless subtask to a task', () => {
    const { payload, warnings } = resolveIssue(
      issue({ type: 'Sub', parentExternalId: null }),
      MAPPING,
      ctx(),
    );
    expect(payload.kind).toBe('task');
    expect(warnings.some((w) => /subtask needs a parent/.test(w))).toBe(true);
  });

  it('keeps a subtask that has a parent', () => {
    const { payload } = resolveIssue(
      issue({ type: 'Sub', parentExternalId: 'PROJ-9' }),
      MAPPING,
      ctx(),
    );
    expect(payload.kind).toBe('subtask');
    expect(payload.parentExternalId).toBe('PROJ-9');
  });

  it('drops the parent of an epic (must be root)', () => {
    const { payload, warnings } = resolveIssue(
      issue({ type: 'Epic', parentExternalId: 'PROJ-9' }),
      MAPPING,
      ctx(),
    );
    expect(payload.kind).toBe('epic');
    expect(payload.parentExternalId).toBeNull();
    expect(warnings.some((w) => /epic must be top-level/.test(w))).toBe(true);
  });
});

describe('resolveIssue — status', () => {
  it('falls back to the initial status + warns on an unmapped status', () => {
    const { payload, warnings } = resolveIssue(issue({ status: 'Frozen' }), MAPPING, ctx());
    expect(payload.statusKey).toBe('todo');
    expect(warnings.some((w) => /unmapped status "Frozen"/.test(w))).toBe(true);
  });

  it('uses the configured default status when set', () => {
    const { payload } = resolveIssue(
      issue({ status: 'Frozen' }),
      { ...MAPPING, defaultStatusKey: 'in_progress' },
      ctx(),
    );
    expect(payload.statusKey).toBe('in_progress');
  });

  it('falls back when the mapped key is not a real project status', () => {
    const { payload, warnings } = resolveIssue(
      issue({ status: 'Done' }),
      { ...MAPPING, statusToKey: { Done: 'nonexistent' } },
      ctx(),
    );
    expect(payload.statusKey).toBe('todo');
    expect(warnings.some((w) => /not a project status/.test(w))).toBe(true);
  });
});

describe('resolveIssue — priority', () => {
  it('defaults an unmapped priority to medium', () => {
    const { payload, warnings } = resolveIssue(issue({ priority: 'Blocker' }), MAPPING, ctx());
    expect(payload.priority).toBe('medium');
    expect(warnings.some((w) => /unmapped priority "Blocker" → medium/.test(w))).toBe(true);
  });
});

describe('resolveIssue — users', () => {
  it('unassign policy leaves an unmatched assignee unset + warns', () => {
    const { payload, warnings } = resolveIssue(
      issue({ assigneeEmail: 'ghost@x.com' }),
      MAPPING,
      ctx(),
    );
    expect(payload.assigneeId).toBeNull();
    expect(warnings.some((w) => /assignee ghost@x.com — left unset/.test(w))).toBe(true);
  });

  it('importing_user policy assigns an unmatched assignee to the importer', () => {
    const { payload } = resolveIssue(
      issue({ assigneeEmail: 'ghost@x.com' }),
      { ...MAPPING, unmatchedUserPolicy: 'importing_user' },
      ctx(),
    );
    expect(payload.assigneeId).toBe('u-me');
  });

  it('an unmatched reporter falls back (id null) with a warning', () => {
    const { payload, warnings } = resolveIssue(
      issue({ reporterEmail: 'ghost@x.com' }),
      MAPPING,
      ctx(),
    );
    expect(payload.reporterId).toBeNull();
    expect(payload.reporterEmail).toBe('ghost@x.com');
    expect(warnings.some((w) => /reporter ghost@x.com/.test(w))).toBe(true);
  });
});

describe('resolveIssue — title', () => {
  it('placeholders an empty title with a warning', () => {
    const { payload, warnings } = resolveIssue(issue({ title: '  ' }), MAPPING, ctx());
    expect(payload.title).toBe('(untitled PROJ-1)');
    expect(warnings.some((w) => /no title/.test(w))).toBe(true);
  });
});
