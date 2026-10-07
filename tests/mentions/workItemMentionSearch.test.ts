import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  searchWorkItemMentions,
  toWorkItemMentionCandidate,
} from '@/lib/mentions/workItemMentionSearch';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';

// The picker's client fetcher (Subtask 5.8.5) and its one-project narrowing
// (MOTIR-7572): the URL it asks, and that `projectId` rides along only when given.

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('searchWorkItemMentions', () => {
  it('asks the workspace-wide search when no project is named', async () => {
    const fetchMock = stubFetch();
    await searchWorkItemMentions('plan gate');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/work-items/mention-search?q=plan%20gate');
  });

  it('narrows to one project when `projectId` is given', async () => {
    const fetchMock = stubFetch();
    await searchWorkItemMentions('plan', { projectId: 'proj 1' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/work-items/mention-search?q=plan&projectId=proj%201',
    );
  });

  // MOTIR-7574: the page editor's picker has a "search failed" state, so its
  // search rejects a refused request; every other host keeps "no results".
  it('resolves [] on a refused request, or rejects when asked to', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );
    await expect(searchWorkItemMentions('plan')).resolves.toEqual([]);
    await expect(searchWorkItemMentions('plan', { throwOnError: true })).rejects.toThrow(
      'Work-item search failed with HTTP 500',
    );
  });

  it('carries the status category a page chip draws its dot from', () => {
    const row = (status: string) =>
      toWorkItemMentionCandidate({
        id: 'ck1',
        identifier: 'MOTIR-1',
        title: 'T',
        kind: 'task',
        status,
      } as WorkItemSummaryDto).status;
    expect(row('in_progress')).toEqual({
      label: 'In Progress',
      tone: 'in-progress',
      category: 'in_progress',
    });
    expect(row('blocked')).toMatchObject({ tone: 'warning', category: 'todo' });
    expect(row('cancelled')).toMatchObject({ tone: 'neutral', category: 'done' });
    expect(row('my_status')).toEqual({ label: 'My Status', tone: 'neutral' });
    expect(row('')).toBeNull();
  });
});
