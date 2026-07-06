import { describe, expect, it, vi } from 'vitest';
import { GithubConnector } from '@/lib/import/connectors/githubConnector';
import { ConnectorConfigError } from '@/lib/import/connectors/errors';
import type { RetryOptions } from '@/lib/import/connectors/http';

// Unit tests for the GitHub Issues connector (MOTIR-1501) with an injected
// fetch stub — no real network. Asserts the state=all correctness point, PR
// exclusion, field mapping, comment fetch, Link-header paging, and per-issue
// comment-error tolerance.

const RETRY: RetryOptions = {
  sleep: () => Promise.resolve(),
  random: () => 0,
  maxAttempts: 2,
  baseDelayMs: 1,
};

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

/** Build a routed fetch stub; records every requested URL. */
function makeFetch(handler: (url: string) => Response): {
  fetchImpl: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    return handler(u);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, urls };
}

function connector(fetchImpl: typeof fetch, overrides = {}) {
  return new GithubConnector({
    token: 't',
    owner: 'acme',
    repo: 'app',
    fetchImpl,
    retry: RETRY,
    ...overrides,
  });
}

describe('GithubConnector — construction', () => {
  it('requires token + owner + repo', () => {
    expect(() => new GithubConnector({ token: '', owner: 'a', repo: 'b' })).toThrow(
      ConnectorConfigError,
    );
    expect(() => new GithubConnector({ token: 't', owner: '', repo: 'b' })).toThrow(
      ConnectorConfigError,
    );
  });
});

describe('GithubConnector.connect', () => {
  it('validates against the repo endpoint and returns the ref', async () => {
    const { fetchImpl, urls } = makeFetch(() => json({ full_name: 'acme/app' }));
    const r = await connector(fetchImpl).connect();
    expect(r).toEqual({ source: 'github', sourceRef: 'acme/app', issueCount: null });
    expect(urls[0]).toContain('/repos/acme/app');
  });
});

describe('GithubConnector.listIssues', () => {
  const issue = (number: number, extra = {}) => ({
    number,
    title: `Issue ${number}`,
    body: `body ${number}`,
    state: number % 2 === 0 ? 'closed' : 'open',
    user: { login: 'reporter' },
    assignee: { login: 'dev' },
    labels: [{ name: 'bug' }, 'ui'],
    comments: 0,
    created_at: '2026-01-01T00:00:00Z',
    closed_at: number % 2 === 0 ? '2026-02-01T00:00:00Z' : null,
    ...extra,
  });

  it('passes state=all (never drops closed issues) and excludes PRs', async () => {
    const { fetchImpl, urls } = makeFetch((url) => {
      if (url.includes('/issues?')) {
        return json([
          issue(1),
          issue(2),
          { number: 3, title: 'a PR', state: 'open', pull_request: { url: 'x' } },
        ]);
      }
      return json([]);
    });
    const page = await connector(fetchImpl).listIssues();
    expect(urls[0]).toContain('state=all');
    // PR #3 excluded; two real issues mapped.
    expect(page.issues.map((i) => i.externalId)).toEqual(['acme/app#1', 'acme/app#2']);
    expect(page.issues[1]!.status).toBe('closed');
    expect(page.issues[1]!.closedAt).toBe('2026-02-01T00:00:00Z');
  });

  it('maps login names (email null), labels, and body', async () => {
    const { fetchImpl } = makeFetch(() => json([issue(1)]));
    const page = await connector(fetchImpl).listIssues();
    const i = page.issues[0];
    expect(i).toMatchObject({
      title: 'Issue 1',
      descriptionMd: 'body 1',
      status: 'open',
      assigneeEmail: null,
      assigneeName: 'dev',
      reporterEmail: null,
      reporterName: 'reporter',
      labels: ['bug', 'ui'],
      type: null,
      priority: null,
    });
  });

  it('fetches comments for an issue that has them', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/comments')) {
        return json([
          { body: 'first', user: { login: 'alice' }, created_at: '2026-01-03T00:00:00Z' },
        ]);
      }
      if (url.includes('/issues?')) {
        return json([
          issue(1, {
            comments: 1,
            comments_url: 'https://api.github.com/repos/acme/app/issues/1/comments',
          }),
        ]);
      }
      return json([]);
    });
    const page = await connector(fetchImpl).listIssues();
    expect(page.issues[0]!.comments).toEqual([
      { authorEmail: null, authorName: 'alice', body: 'first', createdAt: '2026-01-03T00:00:00Z' },
    ]);
  });

  it('collects a per-issue error when a comment fetch fails (page not aborted)', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/comments')) return new Response('boom', { status: 500 });
      if (url.includes('/issues?')) {
        return json([
          issue(1, {
            comments: 2,
            comments_url: 'https://api.github.com/repos/acme/app/issues/1/comments',
          }),
        ]);
      }
      return json([]);
    });
    const page = await connector(fetchImpl).listIssues();
    expect(page.issues).toHaveLength(1);
    expect(page.issues[0]!.comments).toEqual([]);
    expect(page.errors[0]).toMatchObject({ externalId: 'acme/app#1' });
  });

  it('pages forward via the Link header, then stops', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (/[?&]page=1(&|$)/.test(url)) {
        return json([issue(1)], {
          link: '<https://api.github.com/repos/acme/app/issues?state=all&per_page=100&page=2>; rel="next"',
        });
      }
      return json([issue(2)]); // page 2 — no Link → last
    });
    const c = connector(fetchImpl);
    const p1 = await c.listIssues();
    expect(p1.nextCursor).toBe('2');
    const p2 = await c.listIssues(p1.nextCursor);
    expect(p2.nextCursor).toBeNull();
  });
});

describe('GithubConnector.discoverFields', () => {
  it('returns sorted labels + open/closed statuses', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/labels')) return json([{ name: 'ui' }, { name: 'bug' }]);
      return json([]);
    });
    const v = await connector(fetchImpl).discoverFields();
    expect(v.statuses).toEqual(['open', 'closed']);
    expect(v.labels).toEqual(['bug', 'ui']);
    expect(v.types).toEqual([]);
  });
});
