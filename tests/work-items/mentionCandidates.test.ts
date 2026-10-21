import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User, WorkItem } from '@/generated/prisma/client';
import { userRepository } from '@/lib/repositories/userRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  toWorkItemMentionCandidateDto,
  toWorkItemRefAssigneeDto,
  toWorkItemRefSummaryDto,
} from '@/lib/mappers/workItemMappers';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The picker's candidate read carries the SAME type + assignee the ref summary
// does (one contract on two surfaces), resolved in one batched member read.

const ctx = { workspaceId: 'ws1', userId: 'u1' } as ServiceContext;

function row(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    identifier: `MOTIR-${id}`,
    title: `Title ${id}`,
    kind: 'task',
    type: 'code',
    projectId: 'p1',
    status: 'in_progress',
    assigneeId: null,
    archivedAt: null,
    ...over,
  } as WorkItem;
}

afterEach(() => vi.restoreAllMocks());

describe('searchMentionCandidates', () => {
  it('answers the candidate DTO with one member read, equal to the ref summary for the same item', async () => {
    const a = row('a', { assigneeId: 'u9' });
    const b = row('b');
    vi.spyOn(workItemsService, 'quickSearchRows').mockResolvedValue([a, b]);
    const find = vi
      .spyOn(userRepository, 'findByIds')
      .mockResolvedValue([{ id: 'u9', name: 'Ada', image: null } as User]);

    const out = await workItemsService.searchMentionCandidates('title', ctx, { limit: 8 });

    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(['u9']);
    expect(out).toEqual([
      {
        id: 'a',
        identifier: 'MOTIR-a',
        title: 'Title a',
        kind: 'task',
        status: 'in_progress',
        type: 'code',
        assignee: { id: 'u9', name: 'Ada', image: null },
      },
      expect.objectContaining({ id: 'b', status: 'in_progress', type: 'code', assignee: null }),
    ]);

    const summary = toWorkItemRefSummaryDto(
      a,
      null,
      toWorkItemRefAssigneeDto({ id: 'u9', name: 'Ada', image: null }),
    );
    expect(summary).toMatchObject({ type: out[0]!.type, assignee: out[0]!.assignee });
  });

  it('reads no member when no candidate is assigned', async () => {
    vi.spyOn(workItemsService, 'quickSearchRows').mockResolvedValue([row('a')]);
    const find = vi.spyOn(userRepository, 'findByIds').mockResolvedValue([]);
    await workItemsService.searchMentionCandidates('title', ctx);
    expect(find).toHaveBeenCalledWith([]);
  });

  it('returns [] for a short query without touching the member table', async () => {
    const find = vi.spyOn(userRepository, 'findByIds');
    expect(await workItemsService.searchMentionCandidates('a', ctx)).toEqual([]);
    expect(find).toHaveBeenCalledWith([]);
  });
});

describe('the mappers', () => {
  it('never replaces a missing type or assignee with a default', () => {
    const r = row('z', { type: null });
    expect(toWorkItemRefSummaryDto(r, null, null)).toMatchObject({ type: null, assignee: null });
    expect(toWorkItemMentionCandidateDto(r, null)).toMatchObject({ type: null, assignee: null });
  });

  it('maps a stored avatar key like the archived-by display, and a null one to null', () => {
    expect(toWorkItemRefAssigneeDto({ id: 'u', name: 'A', image: null }).image).toBeNull();
  });
});
