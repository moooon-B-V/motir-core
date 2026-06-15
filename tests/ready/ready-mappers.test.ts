import { describe, expect, it } from 'vitest';
import type { User, WorkItem } from '@prisma/client';
import { toReadyItemDispatchDto, toReadyItemDto } from '@/lib/mappers/readyMappers';
import { markdownToExcerpt } from '@/lib/markdown/excerpt';
import type { ReadyAssignee } from '@/lib/mappers/readyMappers';

// PURE unit smoke (Subtask 7.0.3). The Ready mappers + the excerpt helper are
// pure functions of their inputs — no DB, no `getSession`, no Postgres. The
// service-/endpoint-level behaviour (the readiness predicate, sort, cursor,
// gates) is the DB-backed suite 7.0.7; this file only proves the DTO shapes.

const FIXED_DATE = new Date('2026-06-08T00:00:00.000Z');

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wi_1',
    workspaceId: 'ws_1',
    projectId: 'proj_1',
    parentId: null,
    kind: 'subtask',
    key: 7,
    identifier: 'PROD-7',
    title: 'Wire the ready endpoint',
    descriptionMd: 'Plain description body.',
    explanationMd: null,
    explanationSource: 'user_authored',
    status: 'open',
    priority: 'high',
    assigneeId: null,
    reporterId: 'user_reporter',
    dueDate: null,
    estimateMinutes: null,
    type: null,
    executor: null,
    storyPoints: null,
    position: 'a0',
    sprintId: null,
    backlogRank: null,
    archivedAt: null,
    triagedAt: null,
    snoozedUntil: null,
    externalSubmitterName: null,
    externalSubmitterEmail: null,
    submittedByUserId: null,
    publicChildrenHidden: false,
    sessionBranch: null,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

function makeAssignee(overrides: Partial<User> = {}): ReadyAssignee {
  return {
    id: 'user_a',
    name: 'Ada Lovelace',
    email: 'ada@motir.co',
    image: 'https://cdn.example/ada.png',
    ...(overrides as Partial<ReadyAssignee>),
  };
}

describe('toReadyItemDto', () => {
  it('maps the row to the card shape; `key` is the PROD-<n> identifier', () => {
    const dto = toReadyItemDto(makeWorkItem(), {
      statusCategory: 'todo',
      assignee: makeAssignee(),
    });

    expect(dto).toEqual({
      id: 'wi_1',
      key: 'PROD-7', // the identifier, NOT the numeric key (7)
      kind: 'subtask',
      title: 'Wire the ready endpoint',
      priority: 'high',
      status: { key: 'open', category: 'todo' },
      assignee: { id: 'user_a', name: 'Ada Lovelace', avatarUrl: 'https://cdn.example/ada.png' },
      descriptionExcerpt: 'Plain description body.',
    });
  });

  it('null assignee → null; image absent → avatarUrl null', () => {
    const dto = toReadyItemDto(makeWorkItem(), { statusCategory: 'todo', assignee: null });
    expect(dto.assignee).toBeNull();

    const dto2 = toReadyItemDto(makeWorkItem(), {
      statusCategory: 'in_progress',
      assignee: makeAssignee({ image: null }),
    });
    expect(dto2.assignee).toEqual({ id: 'user_a', name: 'Ada Lovelace', avatarUrl: null });
    expect(dto2.status.category).toBe('in_progress');
  });

  it('falls back to the email localpart when the assignee has no name', () => {
    const dto = toReadyItemDto(makeWorkItem(), {
      statusCategory: 'todo',
      assignee: makeAssignee({ name: '', email: 'grace@motir.co' }),
    });
    expect(dto.assignee?.name).toBe('grace');
  });

  it('null description → null excerpt', () => {
    const dto = toReadyItemDto(makeWorkItem({ descriptionMd: null }), {
      statusCategory: 'todo',
      assignee: null,
    });
    expect(dto.descriptionExcerpt).toBeNull();
  });
});

describe('toReadyItemDispatchDto', () => {
  it('extends the card DTO with the full agent payload', () => {
    const dto = toReadyItemDispatchDto(
      makeWorkItem({ descriptionMd: '# Heading\n\nFull **body** text.', parentId: 'wi_parent' }),
      [{ identifier: 'PROD-3' }, { identifier: 'PROD-5' }],
      {
        statusCategory: 'todo',
        assignee: null,
        parent: { identifier: 'PROD-1' },
        contextRefs: ['lib/dto/ready.ts', 'lib/mappers/readyMappers.ts'],
        sessionBranch: null,
      },
    );

    // base fields carried through
    expect(dto.key).toBe('PROD-7');
    expect(dto.status).toEqual({ key: 'open', category: 'todo' });
    // dispatch additions
    expect(dto.descriptionMd).toBe('# Heading\n\nFull **body** text.');
    expect(dto.contextRefs).toEqual(['lib/dto/ready.ts', 'lib/mappers/readyMappers.ts']);
    expect(dto.blockerKeys).toEqual(['PROD-3', 'PROD-5']);
    expect(dto.parentKey).toBe('PROD-1');
    expect(dto.runCommand).toBe('motir run PROD-7');
    expect(dto.runCommand).toMatch(/^motir run PROD-\d+$/);
  });

  it('no blockers → empty blockerKeys; no parent → null parentKey', () => {
    const dto = toReadyItemDispatchDto(makeWorkItem(), [], {
      statusCategory: 'todo',
      assignee: null,
      parent: null,
      contextRefs: [],
      sessionBranch: null,
    });
    expect(dto.blockerKeys).toEqual([]);
    expect(dto.parentKey).toBeNull();
    expect(dto.contextRefs).toEqual([]);
  });
});

describe('markdownToExcerpt', () => {
  it('returns null for null / empty / whitespace-only input', () => {
    expect(markdownToExcerpt(null)).toBeNull();
    expect(markdownToExcerpt(undefined)).toBeNull();
    expect(markdownToExcerpt('')).toBeNull();
    expect(markdownToExcerpt('   \n\n')).toBeNull();
  });

  it('strips common Markdown syntax to plain text', () => {
    const md = [
      '# Title',
      '',
      'A paragraph with **bold**, _italic_, `code`, and a [link](https://x.test).',
      '',
      '- bullet one',
      '- bullet two',
      '',
      '> a quote',
    ].join('\n');
    expect(markdownToExcerpt(md)).toBe(
      'Title A paragraph with bold, italic, code, and a link. bullet one bullet two a quote',
    );
  });

  it('drops image syntax but keeps alt text', () => {
    expect(markdownToExcerpt('See ![a diagram](/x.png) here')).toBe('See a diagram here');
  });

  it('returns short text whole with no ellipsis', () => {
    expect(markdownToExcerpt('short and sweet')).toBe('short and sweet');
  });

  it('truncates on a word boundary with an ellipsis only when content is dropped', () => {
    const long = 'word '.repeat(60).trim(); // 60 words, ~300 chars
    const out = markdownToExcerpt(long, 50)!;
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(51); // <= maxChars + the ellipsis
    expect(out).not.toContain('  '); // no double space
    // cut on a boundary: the part before the ellipsis is whole words
    expect(
      out
        .slice(0, -1)
        .trim()
        .split(' ')
        .every((w) => w === 'word'),
    ).toBe(true);
  });

  it('hard-cuts a single over-long token that has no space', () => {
    const token = 'x'.repeat(80);
    const out = markdownToExcerpt(token, 20)!;
    expect(out).toBe(`${'x'.repeat(20)}…`);
  });
});
