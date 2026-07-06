import { describe, expect, it, vi } from 'vitest';
import { JiraConnector, adfToText } from '@/lib/import/connectors/jiraConnector';
import { ConnectorConfigError } from '@/lib/import/connectors/errors';
import type { RetryOptions } from '@/lib/import/connectors/http';

// Unit tests for the Jira connector (MOTIR-940) with an injected fetch stub —
// no real network. Asserts auth, the all-states JQL, offset paging, ADF→text,
// field mapping, and per-issue resilience.

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

function makeFetch(handler: (url: string, init: RequestInit) => Response): {
  fetchImpl: typeof fetch;
  urls: string[];
  auth: string[];
} {
  const urls: string[] = [];
  const auth: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init: RequestInit) => {
    urls.push(String(url));
    auth.push(String((init.headers as Record<string, string>)?.Authorization ?? ''));
    return handler(String(url), init);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, urls, auth };
}

function connector(fetchImpl: typeof fetch, overrides = {}) {
  return new JiraConnector({
    baseUrl: 'https://acme.atlassian.net',
    apiToken: 'tok',
    email: 'me@acme.com',
    projectKey: 'ENG',
    fetchImpl,
    retry: RETRY,
    ...overrides,
  });
}

const adfDoc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
};

function jiraIssue(key: string, extra = {}) {
  return {
    key,
    fields: {
      summary: `Summary ${key}`,
      description: adfDoc,
      issuetype: { name: 'Bug' },
      status: { name: 'Done' },
      priority: { name: 'High' },
      assignee: { emailAddress: 'dev@acme.com', displayName: 'Dev' },
      reporter: { emailAddress: 'pm@acme.com', displayName: 'PM' },
      labels: ['backend', 'urgent'],
      parent: { key: 'ENG-1' },
      issuelinks: [{ type: { name: 'Blocks' }, outwardIssue: { key: 'ENG-2' } }],
      created: '2026-01-01T00:00:00.000Z',
      resolutiondate: '2026-02-01T00:00:00.000Z',
      comment: {
        comments: [
          {
            author: { emailAddress: 'x@acme.com', displayName: 'X' },
            body: adfDoc,
            created: '2026-01-05T00:00:00.000Z',
          },
        ],
      },
      attachment: [
        { filename: 'log.txt', content: 'https://acme/att/1', mimeType: 'text/plain', size: 42 },
      ],
      ...extra,
    },
  };
}

describe('adfToText', () => {
  it('flattens an ADF doc to plain text', () => {
    expect(adfToText(adfDoc)).toBe('Hello world');
  });
  it('passes a plain string through and null on empty', () => {
    expect(adfToText('hi')).toBe('hi');
    expect(adfToText(null)).toBeNull();
    expect(adfToText({ type: 'doc', content: [] })).toBeNull();
  });
});

describe('JiraConnector — construction', () => {
  it('requires baseUrl + apiToken', () => {
    expect(() => new JiraConnector({ baseUrl: '', apiToken: 't' })).toThrow(ConnectorConfigError);
    expect(() => new JiraConnector({ baseUrl: 'https://x', apiToken: '' })).toThrow(
      ConnectorConfigError,
    );
  });
});

describe('JiraConnector.connect', () => {
  it('validates via /myself and returns the project ref + total', async () => {
    const { fetchImpl, urls, auth } = makeFetch((url) => {
      if (url.includes('/myself')) return json({ accountId: 'a1' });
      if (url.includes('/search')) return json({ total: 7, issues: [] });
      return json({});
    });
    const r = await connector(fetchImpl).connect();
    expect(r).toEqual({ source: 'jira', sourceRef: 'ENG', issueCount: 7 });
    expect(urls.some((u) => u.includes('/rest/api/3/myself'))).toBe(true);
    // Basic auth from email:token.
    expect(auth[0]).toMatch(/^Basic /);
  });

  it('uses Bearer auth when no email is set', async () => {
    const { fetchImpl, auth } = makeFetch((url) =>
      url.includes('/search') ? json({ total: 0, issues: [] }) : json({}),
    );
    await connector(fetchImpl, { email: undefined }).connect();
    expect(auth[0]).toMatch(/^Bearer tok$/);
  });
});

describe('JiraConnector.listIssues', () => {
  it('queries all states (no status clause) and maps a Jira issue', async () => {
    const { fetchImpl, urls } = makeFetch(() =>
      json({ total: 1, startAt: 0, maxResults: 100, issues: [jiraIssue('ENG-10')] }),
    );
    const page = await connector(fetchImpl).listIssues();
    const searchUrl = decodeURIComponent(urls[0]!);
    expect(searchUrl).toContain('project = "ENG"');
    expect(searchUrl).not.toMatch(/status\s*=/i); // never an open-only filter
    expect(searchUrl).toContain('ORDER BY created ASC');
    expect(page.issues[0]).toMatchObject({
      externalId: 'ENG-10',
      title: 'Summary ENG-10',
      descriptionMd: 'Hello world',
      type: 'Bug',
      status: 'Done',
      priority: 'High',
      assigneeEmail: 'dev@acme.com',
      reporterEmail: 'pm@acme.com',
      labels: ['backend', 'urgent'],
      parentExternalId: 'ENG-1',
      closedAt: '2026-02-01T00:00:00.000Z',
    });
    expect(page.issues[0]!.links).toEqual([{ type: 'Blocks', targetExternalId: 'ENG-2' }]);
    expect(page.issues[0]!.comments[0]).toMatchObject({
      authorEmail: 'x@acme.com',
      body: 'Hello world',
    });
    expect(page.issues[0]!.attachments[0]).toMatchObject({ filename: 'log.txt', byteSize: 42 });
  });

  it('pages by startAt and stops at the total', async () => {
    const { fetchImpl } = makeFetch((url) => {
      const startAt = Number(new URL(url).searchParams.get('startAt') ?? '0');
      const issues =
        startAt === 0 ? [jiraIssue('ENG-0'), jiraIssue('ENG-1')] : [jiraIssue('ENG-2')];
      return json({ total: 3, startAt, maxResults: 2, issues });
    });
    const c = connector(fetchImpl, { pageSize: 2 });
    const p1 = await c.listIssues();
    expect(p1.issues.map((i) => i.externalId)).toEqual(['ENG-0', 'ENG-1']);
    expect(p1.nextCursor).toBe('2');
    const p2 = await c.listIssues(p1.nextCursor);
    expect(p2.issues.map((i) => i.externalId)).toEqual(['ENG-2']);
    expect(p2.nextCursor).toBeNull();
  });

  it('collects a per-issue error without aborting the page', async () => {
    // `issuelinks` as a non-array makes the map throw inside mapIssue — a
    // JSON-serialisable malformed shape (a throwing getter would break the stub).
    const bad = { key: 'ENG-9', fields: { summary: 'x', issuelinks: 5 } };
    const { fetchImpl } = makeFetch(() =>
      json({ total: 2, startAt: 0, issues: [jiraIssue('ENG-1'), bad] }),
    );
    const page = await connector(fetchImpl).listIssues();
    expect(page.issues).toHaveLength(1);
    expect(page.errors[0]).toMatchObject({ externalId: 'ENG-9' });
  });
});
