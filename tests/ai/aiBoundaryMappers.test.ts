import { describe, it, expect } from 'vitest';
import { toPlanTreeSkeleton, toSearchResultRows } from '@/lib/mappers/aiBoundaryMappers';
import type { WorkItemListItemDto, WorkItemSummaryDto } from '@/lib/dto/workItems';

function summary(over: Partial<WorkItemSummaryDto>): WorkItemSummaryDto {
  return {
    id: 'id_x',
    parentId: null,
    kind: 'story',
    key: 1,
    identifier: 'MOTIR-1',
    title: 'T',
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    position: 'a0',
    estimateMinutes: null,
    storyPoints: null,
    archivedAt: null,
    ...over,
  };
}

describe('toPlanTreeSkeleton', () => {
  it('projects to {key, id, kind, title, status, parentKey, revision} and resolves parentKey + revision', () => {
    const epic = summary({ id: 'id_e', identifier: 'MOTIR-1', kind: 'epic', parentId: null });
    const story = summary({
      id: 'id_s',
      identifier: 'MOTIR-2',
      kind: 'story',
      parentId: 'id_e',
      title: 'Story',
      status: 'in_progress',
    });
    // The batched revision map (MOTIR-1531): the epic has a latest revision, the
    // story has none → `revision: null`.
    const out = toPlanTreeSkeleton([epic, story], new Map([['id_e', 'rev_e']]));
    expect(out).toEqual([
      {
        key: 'MOTIR-1',
        id: 'id_e',
        kind: 'epic',
        title: 'T',
        status: 'todo',
        parentKey: null,
        revision: 'rev_e',
      },
      {
        key: 'MOTIR-2',
        id: 'id_s',
        kind: 'story',
        title: 'Story',
        status: 'in_progress',
        parentKey: 'MOTIR-1',
        revision: null,
      },
    ]);
  });

  it('maps an empty project to an empty skeleton', () => {
    expect(toPlanTreeSkeleton([], new Map())).toEqual([]);
  });

  it('yields parentKey=null for a parent outside the batch', () => {
    const orphan = summary({ id: 'id_o', identifier: 'MOTIR-9', parentId: 'id_missing' });
    expect(toPlanTreeSkeleton([orphan], new Map())[0]!.parentKey).toBeNull();
  });

  it('leaves revision null when the item has no entry in the batched map', () => {
    const item = summary({ id: 'id_o', identifier: 'MOTIR-9' });
    expect(toPlanTreeSkeleton([item], new Map())[0]!.revision).toBeNull();
  });
});

function listItem(over: Partial<WorkItemListItemDto>): WorkItemListItemDto {
  return {
    id: 'id_x',
    kind: 'task',
    type: 'code',
    key: 1,
    identifier: 'MOTIR-1',
    title: 'T',
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    reporterId: 'u_1',
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

describe('toSearchResultRows', () => {
  it('projects the flat List row to {key, id, kind, type, title, status, priority, revision} — no parentKey', () => {
    const rows = toSearchResultRows(
      [
        listItem({
          id: 'id_7',
          identifier: 'MOTIR-7',
          kind: 'task',
          type: 'code',
          title: 'Beta',
          status: 'in_progress',
          priority: 'high',
        }),
        listItem({
          id: 'id_8',
          identifier: 'MOTIR-8',
          kind: 'story',
          type: null,
          title: 'Gamma',
          status: 'todo',
          priority: 'low',
        }),
      ],
      new Map([['id_7', 'rev_7']]),
    );
    expect(rows).toEqual([
      {
        key: 'MOTIR-7',
        id: 'id_7',
        kind: 'task',
        type: 'code',
        title: 'Beta',
        status: 'in_progress',
        priority: 'high',
        revision: 'rev_7',
      },
      {
        key: 'MOTIR-8',
        id: 'id_8',
        kind: 'story',
        type: null,
        title: 'Gamma',
        status: 'todo',
        priority: 'low',
        revision: null,
      },
    ]);
  });

  it('maps an empty page to an empty list', () => {
    expect(toSearchResultRows([], new Map())).toEqual([]);
  });
});
