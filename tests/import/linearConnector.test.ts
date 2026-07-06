import { describe, expect, it, vi } from 'vitest';
import { LinearConnector } from '@/lib/import/connectors/linearConnector';
import { ConnectorConfigError, ConnectorHttpError } from '@/lib/import/connectors/errors';
import type { RetryOptions } from '@/lib/import/connectors/http';

// Unit tests for the Linear GraphQL connector (MOTIR-940) with an injected fetch
// stub — no real network. Asserts auth, cursor paging, GraphQL-error handling,
// field mapping (incl. completedAt→closedAt), and per-issue resilience.

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

function makeFetch(
  handler: (body: { query: string; variables: Record<string, unknown> }) => Response,
): {
  fetchImpl: typeof fetch;
  auth: string[];
  bodies: { query: string; variables: Record<string, unknown> }[];
} {
  const auth: string[] = [];
  const bodies: { query: string; variables: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init: RequestInit) => {
    auth.push(String((init.headers as Record<string, string>)?.Authorization ?? ''));
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    return handler(body);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, auth, bodies };
}

function connector(fetchImpl: typeof fetch, overrides = {}) {
  return new LinearConnector({
    apiKey: 'lin_key',
    teamKey: 'ENG',
    fetchImpl,
    retry: RETRY,
    ...overrides,
  });
}

function node(identifier: string, extra = {}) {
  return {
    identifier,
    title: `Title ${identifier}`,
    description: `desc ${identifier}`,
    priorityLabel: 'High',
    state: { name: 'Done' },
    assignee: { email: 'dev@x.com', name: 'Dev' },
    creator: { email: 'pm@x.com', name: 'PM' },
    labels: { nodes: [{ name: 'ui' }, { name: 'api' }] },
    parent: { identifier: 'ENG-1' },
    comments: {
      nodes: [
        {
          body: 'hi',
          user: { email: 'c@x.com', name: 'C' },
          createdAt: '2026-01-05T00:00:00.000Z',
        },
      ],
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-02-01T00:00:00.000Z',
    canceledAt: null,
    archivedAt: null,
    ...extra,
  };
}

describe('LinearConnector — construction', () => {
  it('requires an apiKey', () => {
    expect(() => new LinearConnector({ apiKey: '' })).toThrow(ConnectorConfigError);
  });
});

describe('LinearConnector.connect', () => {
  it('validates via viewer with raw apiKey auth', async () => {
    const { fetchImpl, auth } = makeFetch(() => json({ data: { viewer: { id: 'u1' } } }));
    const r = await connector(fetchImpl).connect();
    expect(r).toEqual({ source: 'linear', sourceRef: 'ENG', issueCount: null });
    expect(auth[0]).toBe('lin_key'); // raw key, not Bearer
  });

  it('uses Bearer when authScheme=bearer', async () => {
    const { fetchImpl, auth } = makeFetch(() => json({ data: { viewer: { id: 'u1' } } }));
    await connector(fetchImpl, { authScheme: 'bearer' }).connect();
    expect(auth[0]).toBe('Bearer lin_key');
  });
});

describe('LinearConnector.listIssues', () => {
  it('maps a Linear node (completedAt→closedAt) and passes no state filter', async () => {
    const { fetchImpl, bodies } = makeFetch(() =>
      json({
        data: {
          issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node('ENG-10')] },
        },
      }),
    );
    const page = await connector(fetchImpl).listIssues();
    // The query filters by TEAM but never by state (whole-history scope).
    expect(bodies[0]!.query).not.toMatch(/state\s*:/);
    expect(bodies[0]!.query).toContain('team: { key: { eq: "ENG" } }');
    expect(page.issues[0]).toMatchObject({
      externalId: 'ENG-10',
      title: 'Title ENG-10',
      descriptionMd: 'desc ENG-10',
      status: 'Done',
      priority: 'High',
      assigneeEmail: 'dev@x.com',
      reporterEmail: 'pm@x.com',
      labels: ['ui', 'api'],
      parentExternalId: 'ENG-1',
      closedAt: '2026-02-01T00:00:00.000Z',
    });
    expect(page.issues[0]!.comments[0]).toMatchObject({ authorEmail: 'c@x.com', body: 'hi' });
  });

  it('pages by endCursor while hasNextPage', async () => {
    const { fetchImpl, bodies } = makeFetch((body) => {
      const after = body.variables.after;
      if (after == null) {
        return json({
          data: {
            issues: { pageInfo: { hasNextPage: true, endCursor: 'CUR2' }, nodes: [node('ENG-1')] },
          },
        });
      }
      return json({
        data: {
          issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node('ENG-2')] },
        },
      });
    });
    const c = connector(fetchImpl);
    const p1 = await c.listIssues();
    expect(p1.nextCursor).toBe('CUR2');
    const p2 = await c.listIssues(p1.nextCursor);
    expect(bodies[1]!.variables.after).toBe('CUR2');
    expect(p2.nextCursor).toBeNull();
  });

  it('throws ConnectorHttpError on a GraphQL error body (200)', async () => {
    const { fetchImpl } = makeFetch(() => json({ errors: [{ message: 'bad auth' }] }));
    await expect(connector(fetchImpl).listIssues()).rejects.toBeInstanceOf(ConnectorHttpError);
  });

  it('collects a per-issue error without aborting the page', async () => {
    const bad = { identifier: 'ENG-9', labels: { nodes: 5 } }; // labels.nodes.map throws
    const { fetchImpl } = makeFetch(() =>
      json({ data: { issues: { pageInfo: { hasNextPage: false }, nodes: [node('ENG-1'), bad] } } }),
    );
    const page = await connector(fetchImpl).listIssues();
    expect(page.issues).toHaveLength(1);
    expect(page.errors[0]).toMatchObject({ externalId: 'ENG-9' });
  });
});

describe('LinearConnector.discoverFields', () => {
  it('returns states + labels + the fixed priority scale', async () => {
    const { fetchImpl } = makeFetch(() =>
      json({
        data: {
          workflowStates: { nodes: [{ name: 'Todo' }, { name: 'Done' }] },
          issueLabels: { nodes: [{ name: 'ui' }] },
        },
      }),
    );
    const v = await connector(fetchImpl).discoverFields();
    expect(v.statuses).toEqual(['Done', 'Todo']);
    expect(v.labels).toEqual(['ui']);
    expect(v.priorities).toContain('Urgent');
    expect(v.types).toEqual([]);
  });
});
