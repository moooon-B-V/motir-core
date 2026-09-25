import { describe, expect, it } from 'vitest';
import {
  APPROVED_SHAPE_IGNORED_KEYS,
  APPROVED_SHAPE_KEYS,
  classifyRevision,
  isCustomFieldKey,
  shapeChangingKeys,
} from '@/lib/plans/approvedShapeChange';

// THE CHANGE PREDICATE (Story MOTIR-5544 · Subtask MOTIR-6225), pure. The key
// spellings are the WRITERS' — every key below is one a real
// `workItemRevisionsService.recordRevision` call site emits.

const cell = (to: unknown, from: unknown = null) => ({ from, to });

describe('classifyRevision — the right column is ignored', () => {
  it.each([
    ['status', { status: cell('done', 'todo') }],
    ['sprintId', { sprintId: cell('s1') }],
    ['sprintId + backlogRank (a sprint move)', { sprintId: cell('s1'), backlogRank: cell('a0') }],
    ['assigneeId', { assigneeId: cell('u1') }],
    ['dueDate', { dueDate: cell('2026-10-01T00:00:00.000Z') }],
    ['position (a reorder)', { position: cell('a1', 'a0') }],
    ['labels', { labels: { added: ['x'] } }],
    ['todos', { todos: { added: [{ id: 't', text: 'x' }] } }],
    ['a custom field', { 'customFields.risk': cell('high') }],
    ['a comment deletion', { comment: cell(null, { commentId: 'c' }) }],
    ['an empty diff', {}],
    ['a relates_to link (a mention)', { links: { added: [{ toId: 'x', kind: 'relates_to' }] } }],
    ['an UNARCHIVE', { archivedAt: cell(null, '2026-09-01T00:00:00.000Z') }],
  ])('%s → ignored', (_label, diff) => {
    expect(classifyRevision(diff)).toBe('ignored');
  });

  it('a non-object diff is ignored, never a throw', () => {
    expect(classifyRevision(null)).toBe('ignored');
    expect(classifyRevision([])).toBe('ignored');
  });
});

describe('classifyRevision — one left-column key makes it a shape change', () => {
  it.each([
    ['descriptionMd', { descriptionMd: cell('new', 'old') }],
    ['targetRepo', { targetRepo: cell('motir-ai', 'motir-core') }],
    ['parentId', { parentId: cell('p2', 'p1') }],
    ['title', { title: cell('B', 'A') }],
    ['folderId', { folderId: cell('f2', 'f1') }],
    ['kind', { kind: cell('story', 'task') }],
    ['storyPoints', { storyPoints: cell(5, 3) }],
    ['targetRepos', { targetRepos: cell(['a'], ['b']) }],
    ['deleted (a child destroyed)', { deleted: cell(null, 'MOTIR-1: x') }],
    ['an ARCHIVE', { archivedAt: cell('2026-09-01T00:00:00.000Z') }],
    ['a blocked_by edge added', { links: { added: [{ toId: 'x', kind: 'is_blocked_by' }] } }],
    ['a blocked_by edge removed', { links: { removed: [{ toId: 'x', kind: 'is_blocked_by' }] } }],
  ])('%s → shape', (_label, diff) => {
    expect(classifyRevision(diff)).toBe('shape');
  });

  it('mixed with ignored keys it is still a shape change, and names only the shape keys', () => {
    const diff = { status: cell('done'), descriptionMd: cell('x'), sprintId: cell('s') };
    expect(classifyRevision(diff)).toBe('shape');
    expect(shapeChangingKeys(diff)).toEqual(['descriptionMd']);
  });

  it('when the plan REMOVED the card, the unarchive is the departure and a re-archive is not', () => {
    const opts = { approvedArchived: true };
    expect(classifyRevision({ archivedAt: cell(null, '2026-09-01T00:00:00.000Z') }, opts)).toBe(
      'shape',
    );
    expect(classifyRevision({ archivedAt: cell('2026-09-02T00:00:00.000Z') }, opts)).toBe(
      'ignored',
    );
  });
});

describe('the two key sets', () => {
  it('are disjoint', () => {
    for (const key of APPROVED_SHAPE_KEYS) expect(APPROVED_SHAPE_IGNORED_KEYS.has(key)).toBe(false);
  });

  // Every key a revision writer emits today, read off the call sites
  // (workItemsService create/update/transition/archive/move/file/link/delete,
  // estimationService, backlogService, sprintsService, workflowsService,
  // triageService, foldersService, labels/components/todos/attachments/comments/
  // customFieldValues services, autoRelateMentions, plansService materialize).
  // A new writer key lands in one set or the other on purpose.
  const WRITTEN_KEYS = [
    'projectId', 'parentId', 'kind', 'key', 'identifier', 'title', 'descriptionMd',
    'explanationMd', 'explanationSource', 'status', 'priority', 'assigneeId', 'reporterId',
    'dueDate', 'estimateMinutes', 'storyPoints', 'type', 'executor', 'difficulty',
    'targetRepo', 'targetRepos', 'sprintId', 'folderId', 'position', 'backlogRank',
    'archivedAt', 'links', 'attachments', 'labels', 'components', 'todos', 'comment',
    'deleted', 'reason', 'customFields.anything',
  ]; // prettier-ignore

  it.each(WRITTEN_KEYS)('%s is classified in exactly one set', (key) => {
    const inShape = APPROVED_SHAPE_KEYS.has(key);
    const inIgnored = APPROVED_SHAPE_IGNORED_KEYS.has(key) || isCustomFieldKey(key);
    expect(inShape !== inIgnored).toBe(true);
  });
});
