import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listPullRequestFiles,
  MAX_CAPTURED_PR_PATHS,
  MAX_PULL_REQUEST_FILE_PAGES,
  PullRequestFilesReadError,
} from '@/lib/github/pullRequestFiles';

// The pull-request FILES read leaf (MOTIR-2922) — the wire contract behind the
// merge capture: WHICH endpoint is read, with WHICH credential, and what each cap
// reports. `fetch` is stubbed (the convention every sibling GitHub vitest suite
// uses — `historicalPullRequests`, `appAuth`, `githubInstallationService`); no
// database is involved, which is the point of keeping the host boundary in its
// own module.
//
// The credential assertion is not decoration. The App JWT authenticates the APP
// and cannot read a repository's contents, so a capture that reached for it would
// 403 on every private repo and read as an installation-permissions problem —
// a failure mode that costs an afternoon and is one header assertion away.

const OWNER = 'moooon-B-V';
const NAME = 'motir-core';
const NUMBER = 2059;
const TOKEN = 'ghs_installation_token';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** One row as GitHub's `GET /repos/{o}/{n}/pulls/{p}/files` returns it. */
function ghFile(filename: string): Record<string, unknown> {
  return { filename, status: 'modified', additions: 3, deletions: 1, changes: 4 };
}

function jsonPage(rows: unknown[]): Response {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** `n` distinct file rows, so a cap assertion can name exactly which survived. */
function ghFiles(n: number, offset = 0): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ghFile(`lib/generated/file-${offset + i}.ts`));
}

describe('listPullRequestFiles — the endpoint and the credential', () => {
  it('reads /pulls/{number}/files with the INSTALLATION token, never the App JWT', async () => {
    fetchMock.mockResolvedValueOnce(jsonPage([ghFile('lib/services/workflowsService.ts')]));

    const result = await listPullRequestFiles(TOKEN, OWNER, NAME, NUMBER);

    expect(result).toEqual({ paths: ['lib/services/workflowsService.ts'], truncated: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `https://api.github.com/repos/${OWNER}/${NAME}/pulls/${NUMBER}/files?per_page=100&page=1`,
    );
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // A JWT is three base64url segments; an installation token is not. The header
    // must carry the token it was HANDED, verbatim.
    expect(init.headers.authorization).not.toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(init.headers.accept).toBe('application/vnd.github+json');
  });

  it('walks pages until a SHORT one, and concatenates in host order', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonPage(ghFiles(100)))
      .mockResolvedValueOnce(jsonPage(ghFiles(2, 100)));

    const result = await listPullRequestFiles(TOKEN, OWNER, NAME, NUMBER);

    expect(result.truncated).toBe(false);
    expect(result.paths).toHaveLength(102);
    expect(result.paths[0]).toBe('lib/generated/file-0.ts');
    expect(result.paths[101]).toBe('lib/generated/file-101.ts');
    expect(fetchMock.mock.calls[1]![0]).toContain('page=2');
  });

  it('skips a row that carries no usable filename rather than defaulting it', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonPage([ghFile('a.ts'), { status: 'removed' }, { filename: '' }, null, ghFile('b.ts')]),
    );

    const result = await listPullRequestFiles(TOKEN, OWNER, NAME, NUMBER);

    expect(result).toEqual({ paths: ['a.ts', 'b.ts'], truncated: false });
  });
});

describe('listPullRequestFiles — the caps REPORT themselves', () => {
  it('stops at MAX_CAPTURED_PR_PATHS and says the list is truncated', async () => {
    // Three full pages carry 300; the fourth page's first row is the 301st file,
    // which is the one the cap refuses.
    fetchMock
      .mockResolvedValueOnce(jsonPage(ghFiles(100)))
      .mockResolvedValueOnce(jsonPage(ghFiles(100, 100)))
      .mockResolvedValueOnce(jsonPage(ghFiles(100, 200)));

    const result = await listPullRequestFiles(TOKEN, OWNER, NAME, NUMBER);

    expect(result.paths).toHaveLength(MAX_CAPTURED_PR_PATHS);
    expect(result.truncated).toBe(true);
    // The page cap holds the request count down too — it never walks past it.
    expect(fetchMock).toHaveBeenCalledTimes(MAX_PULL_REQUEST_FILE_PAGES);
  });

  it('a pull request UNDER the cap keeps every path and reports NOT truncated', async () => {
    fetchMock.mockResolvedValueOnce(jsonPage(ghFiles(7)));

    const result = await listPullRequestFiles(TOKEN, OWNER, NAME, NUMBER);

    expect(result.paths).toHaveLength(7);
    expect(result.truncated).toBe(false);
  });

  it('the PAGE cap reports truncation even when the path cap was never reached', async () => {
    // Every page full, but most rows unusable — so the walk ends on the page cap
    // with far fewer than MAX_CAPTURED_PR_PATHS paths in hand. Reporting complete
    // here is exactly the confident wrong answer the flag exists to prevent.
    const mostlyJunk = (offset: number) => [
      ghFile(`kept-${offset}.ts`),
      ...Array.from({ length: 99 }, () => ({ status: 'modified' })),
    ];
    fetchMock
      .mockResolvedValueOnce(jsonPage(mostlyJunk(1)))
      .mockResolvedValueOnce(jsonPage(mostlyJunk(2)))
      .mockResolvedValueOnce(jsonPage(mostlyJunk(3)));

    const result = await listPullRequestFiles(TOKEN, OWNER, NAME, NUMBER);

    expect(result.paths).toEqual(['kept-1.ts', 'kept-2.ts', 'kept-3.ts']);
    expect(result.paths.length).toBeLessThan(MAX_CAPTURED_PR_PATHS);
    expect(result.truncated).toBe(true);
  });
});

describe('listPullRequestFiles — failure is TYPED, not silent', () => {
  it('a non-retryable status throws with the repo, number and status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));

    await expect(listPullRequestFiles(TOKEN, OWNER, NAME, NUMBER)).rejects.toBeInstanceOf(
      PullRequestFilesReadError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a body that is not a JSON array throws rather than reading as zero files', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    // "The PR changed nothing" and "the host answered something else" must not be
    // the same result — the first is evidence, the second is the absence of it.
    await expect(listPullRequestFiles(TOKEN, OWNER, NAME, NUMBER)).rejects.toThrow(
      /expected a JSON array/,
    );
  });

  it('a transport failure exhausts the retry budget, then throws', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    const err = await listPullRequestFiles(TOKEN, OWNER, NAME, NUMBER).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PullRequestFilesReadError);
    expect((err as PullRequestFilesReadError).status).toBeNull();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('retries a 5xx and succeeds on the retry', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 502 }))
      .mockResolvedValueOnce(jsonPage([ghFile('lib/db.ts')]));

    const result = await listPullRequestFiles(TOKEN, OWNER, NAME, NUMBER);

    expect(result.paths).toEqual(['lib/db.ts']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
