import { describe, expect, it, vi } from 'vitest';
import { PlaneConnector } from '@/lib/import/connectors/planeConnector';
import { ConnectorConfigError } from '@/lib/import/connectors/errors';
import type { RetryOptions } from '@/lib/import/connectors/http';

// Unit tests for the Plane connector (MOTIR-1639) with an injected fetch stub —
// no real network. Asserts X-API-Key auth, self-host base URL, cursor paging,
// state-group mapping (completed → closed), UUID externalId, per-issue
// resilience.

const RETRY: RetryOptions = {
  sleep: () => Promise.resolve(),
  random: () => 0,
  maxAttempts: 2,
  baseDelayMs: 1,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetch(handler: (url: string) => Response): {
  fetchImpl: typeof fetch;
  urls: string[];
  apiKeys: string[];
} {
  const urls: string[] = [];
  const apiKeys: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init: RequestInit) => {
    urls.push(String(url));
    apiKeys.push(String((init.headers as Record<string, string>)?.['X-API-Key'] ?? ''));
    return handler(String(url));
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, urls, apiKeys };
}

function connector(fetchImpl: typeof fetch, overrides = {}) {
  return new PlaneConnector({
    apiKey: 'plane_pat',
    workspaceSlug: 'acme',
    projectId: 'proj-uuid',
    includeComments: false,
    fetchImpl,
    retry: RETRY,
    ...overrides,
  });
}

function workItem(id: string, extra = {}) {
  return {
    id,
    name: `Item ${id}`,
    description_stripped: `desc ${id}`,
    priority: 'high',
    parent: 'parent-uuid',
    created_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-02-01T00:00:00.000Z',
    state: { name: 'Done', group: 'completed' },
    assignees: [{ email: 'dev@x.com', display_name: 'Dev' }],
    labels: [{ name: 'ui' }, { name: 'api' }],
    created_by: { email: 'pm@x.com', display_name: 'PM' },
    ...extra,
  };
}

describe('PlaneConnector — construction', () => {
  it('requires apiKey + workspaceSlug + projectId', () => {
    expect(() => new PlaneConnector({ apiKey: '', workspaceSlug: 'a', projectId: 'p' })).toThrow(
      ConnectorConfigError,
    );
    expect(() => new PlaneConnector({ apiKey: 'k', workspaceSlug: '', projectId: 'p' })).toThrow(
      ConnectorConfigError,
    );
  });
});

describe('PlaneConnector.connect', () => {
  it('hits work-items with X-API-Key and returns the total', async () => {
    const { fetchImpl, urls, apiKeys } = makeFetch(() => json({ results: [], total_count: 12 }));
    const r = await connector(fetchImpl).connect();
    expect(r).toEqual({ source: 'plane', sourceRef: 'acme/proj-uuid', issueCount: 12 });
    expect(urls[0]).toContain('/api/v1/workspaces/acme/projects/proj-uuid/work-items/');
    expect(apiKeys[0]).toBe('plane_pat');
  });

  it('uses a self-hosted base URL when provided', async () => {
    const { fetchImpl, urls } = makeFetch(() => json({ results: [], total_count: 0 }));
    await connector(fetchImpl, { baseUrl: 'https://plane.internal.acme.com/' }).connect();
    expect(urls[0]).toMatch(/^https:\/\/plane\.internal\.acme\.com\/api\/v1\//);
  });
});

describe('PlaneConnector.listIssues', () => {
  it('maps a work item (UUID externalId, completed→closed) and expands related fields', async () => {
    const { fetchImpl, urls } = makeFetch(() =>
      json({ results: [workItem('wi-1')], next_page_results: false }),
    );
    const page = await connector(fetchImpl).listIssues();
    expect(urls[0]).toContain('expand=state,assignees,labels,created_by');
    expect(page.issues[0]).toMatchObject({
      externalId: 'wi-1', // the UUID, not a display ref
      title: 'Item wi-1',
      descriptionMd: 'desc wi-1',
      status: 'Done',
      priority: 'high',
      assigneeEmail: 'dev@x.com',
      reporterEmail: 'pm@x.com',
      labels: ['ui', 'api'],
      parentExternalId: 'parent-uuid',
      closedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  it('pages while next_page_results is true', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('cursor=')) {
        return json({ results: [workItem('wi-2')], next_page_results: false, next_cursor: null });
      }
      return json({ results: [workItem('wi-1')], next_page_results: true, next_cursor: '100:1:0' });
    });
    const c = connector(fetchImpl);
    const p1 = await c.listIssues();
    expect(p1.nextCursor).toBe('100:1:0');
    const p2 = await c.listIssues(p1.nextCursor);
    expect(p2.nextCursor).toBeNull();
  });

  it('collects a per-issue error when a comment fetch fails (page not aborted)', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/comments/')) return new Response('boom', { status: 500 });
      return json({ results: [workItem('wi-1')], next_page_results: false });
    });
    const page = await connector(fetchImpl, { includeComments: true }).listIssues();
    expect(page.issues).toHaveLength(1);
    expect(page.issues[0]!.comments).toEqual([]);
    expect(page.errors[0]).toMatchObject({ externalId: 'wi-1' });
  });

  it('tolerates a malformed related field by degrading to null (never throws)', async () => {
    const malformed = { id: 'wi-7', name: 'Odd', assignees: { not: 'an array' }, labels: 5 };
    const { fetchImpl } = makeFetch(() => json({ results: [malformed], next_page_results: false }));
    const page = await connector(fetchImpl).listIssues();
    expect(page.issues[0]).toMatchObject({ externalId: 'wi-7', assigneeEmail: null, labels: [] });
  });

  it('fetches comments when includeComments is on', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/comments/')) {
        return json({
          results: [
            {
              comment_stripped: 'hi',
              actor_detail: { email: 'c@x.com', display_name: 'C' },
              created_at: '2026-01-05T00:00:00.000Z',
            },
          ],
          next_page_results: false,
        });
      }
      return json({ results: [workItem('wi-1')], next_page_results: false });
    });
    const page = await connector(fetchImpl, { includeComments: true }).listIssues();
    expect(page.issues[0]!.comments[0]).toMatchObject({ authorEmail: 'c@x.com', body: 'hi' });
  });
});

describe('PlaneConnector.discoverFields', () => {
  it('returns states + labels + the fixed priority scale', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/states/'))
        return json({
          results: [
            { name: 'Todo', group: 'unstarted' },
            { name: 'Done', group: 'completed' },
          ],
        });
      if (url.includes('/labels/')) return json({ results: [{ name: 'ui' }] });
      return json({ results: [] });
    });
    const v = await connector(fetchImpl).discoverFields();
    expect(v.statuses).toEqual(['Done', 'Todo']);
    expect(v.labels).toEqual(['ui']);
    expect(v.priorities).toEqual(['urgent', 'high', 'medium', 'low', 'none']);
    expect(v.types).toEqual([]);
  });
});
