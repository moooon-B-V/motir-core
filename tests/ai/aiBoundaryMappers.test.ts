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
  it('projects to {key, kind, title, status, parentKey} and resolves parentKey from parentId', () => {
    const epic = summary({ id: 'id_e', identifier: 'MOTIR-1', kind: 'epic', parentId: null });
    const story = summary({
      id: 'id_s',
      identifier: 'MOTIR-2',
      kind: 'story',
      parentId: 'id_e',
      title: 'Story',
      status: 'in_progress',
    });
    const out = toPlanTreeSkeleton([epic, story]);
    expect(out).toEqual([
      { key: 'MOTIR-1', kind: 'epic', title: 'T', status: 'todo', parentKey: null },
      {
        key: 'MOTIR-2',
        kind: 'story',
        title: 'Story',
        status: 'in_progress',
        parentKey: 'MOTIR-1',
      },
    ]);
  });

  it('maps an empty project to an empty skeleton', () => {
    expect(toPlanTreeSkeleton([])).toEqual([]);
  });

  it('yields parentKey=null for a parent outside the batch', () => {
    const orphan = summary({ id: 'id_o', identifier: 'MOTIR-9', parentId: 'id_missing' });
    expect(toPlanTreeSkeleton([orphan])[0]!.parentKey).toBeNull();
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
  it('projects the flat List row to {key, kind, type, title, status, priority} — no parentKey', () => {
    const rows = toSearchResultRows([
      listItem({
        identifier: 'MOTIR-7',
        kind: 'task',
        type: 'code',
        title: 'Beta',
        status: 'in_progress',
        priority: 'high',
      }),
      listItem({
        identifier: 'MOTIR-8',
        kind: 'story',
        type: null,
        title: 'Gamma',
        status: 'todo',
        priority: 'low',
      }),
    ]);
    expect(rows).toEqual([
      {
        key: 'MOTIR-7',
        kind: 'task',
        type: 'code',
        title: 'Beta',
        status: 'in_progress',
        priority: 'high',
      },
      {
        key: 'MOTIR-8',
        kind: 'story',
        type: null,
        title: 'Gamma',
        status: 'todo',
        priority: 'low',
      },
    ]);
  });

  it('maps an empty page to an empty list', () => {
    expect(toSearchResultRows([])).toEqual([]);
  });
});
