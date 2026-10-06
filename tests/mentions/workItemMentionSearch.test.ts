import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchWorkItemMentions } from '@/lib/mentions/workItemMentionSearch';

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
});
