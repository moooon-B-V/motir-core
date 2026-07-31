import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RepositorySetRequestError,
  addRepositoryRow,
  connectRepositoryRow,
  establishRepositorySet,
  fetchRepositorySet,
  moveRepositoryRow,
  patchRepositoryRow,
  removeRepositoryRow,
  replanRepositoryRow,
  skipRepositoryRow,
} from '@/lib/planning/repositorySetClient';

// The establish step's client seam (Story MOTIR-1775 · MOTIR-1782) — the one place
// a component's intent becomes a request. Asserted here rather than only through
// the step, because these are the WIRE: a wrong method, a wrong path or a
// swallowed failure would look like a working UI right up until it silently did
// nothing.
//
// Three properties, per call: the URL (project key encoded), the method + body,
// and what a non-2xx becomes.

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stub(response: { ok?: boolean; status?: number; json?: () => unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return {
        ok: response.ok ?? true,
        status: response.status ?? 200,
        json: response.json ?? (() => ({ ok: true })),
      };
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the repository-set client', () => {
  it('reads the step’s whole model from the project-scoped collection', async () => {
    const calls = stub({ json: () => ({ set: { rows: [] } }) });
    await fetchRepositorySet('MOTIR');
    expect(calls[0]!.url).toBe('/api/projects/MOTIR/repositories');
    expect(calls[0]!.method).toBe('GET');
  });

  it('ENCODES the project key, so a key with a slash cannot escape the path', async () => {
    const calls = stub({ json: () => ({}) });
    await fetchRepositorySet('a/b');
    expect(calls[0]!.url).toBe('/api/projects/a%2Fb/repositories');
  });

  it('sends each edit as its own method + body', async () => {
    const calls = stub({ json: () => ({ id: 'r1' }) });

    await addRepositoryRow('MOTIR', { role: 'api', name: 'acme-api' });
    await patchRepositoryRow('MOTIR', 'r1', { name: 'renamed' });
    await moveRepositoryRow('MOTIR', 'r1', 'up');

    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', '/api/projects/MOTIR/repositories'],
      ['PATCH', '/api/projects/MOTIR/repositories/r1'],
      ['POST', '/api/projects/MOTIR/repositories/r1/move'],
    ]);
    expect(calls[0]!.body).toEqual({ role: 'api', name: 'acme-api' });
    expect(calls[1]!.body).toEqual({ name: 'renamed' });
    expect(calls[2]!.body).toEqual({ direction: 'up' });
  });

  it('routes all three state moves through ONE endpoint, naming the target state', async () => {
    const calls = stub({ json: () => ({ id: 'r1' }) });

    await connectRepositoryRow('MOTIR', 'r1', 'gh-9');
    await skipRepositoryRow('MOTIR', 'r1');
    await replanRepositoryRow('MOTIR', 'r1');

    expect(calls.every((c) => c.url === '/api/projects/MOTIR/repositories/r1/state')).toBe(true);
    expect(calls.map((c) => c.body)).toEqual([
      { to: 'connected', githubRepoId: 'gh-9' },
      { to: 'skipped' },
      { to: 'proposed' },
    ]);
  });

  it('establishes the whole set by default and ONE row when asked', async () => {
    const calls = stub({ json: () => ({ projectId: 'p', rows: [] }) });

    await establishRepositorySet('MOTIR');
    await establishRepositorySet('MOTIR', 'r2');

    expect(calls.map((c) => c.body)).toEqual([{}, { rowId: 'r2' }]);
    expect(calls[0]!.url).toBe('/api/projects/MOTIR/repositories/establish');
  });

  it('treats a 204 as a real answer rather than trying to parse a body', async () => {
    stub({
      status: 204,
      json: () => {
        throw new Error('a 204 has no body to parse');
      },
    });
    await expect(removeRepositoryRow('MOTIR', 'r1')).resolves.toBeUndefined();
  });

  it('turns a non-2xx into a typed error carrying the status AND the server’s code', async () => {
    stub({ ok: false, status: 409, json: () => ({ code: 'PROJECT_REPO_NAME_TAKEN' }) });

    const err: unknown = await patchRepositoryRow('MOTIR', 'r1', { name: 'taken' }).catch(
      (e: unknown) => e,
    );
    if (!(err instanceof RepositorySetRequestError)) throw new Error('expected a typed error');

    expect(err).toBeInstanceOf(RepositorySetRequestError);
    expect(err.status).toBe(409);
    // The CODE is what the UI branches on — a message would be untranslated prose.
    expect(err.code).toBe('PROJECT_REPO_NAME_TAKEN');
  });

  it('still fails loudly when the error body is not JSON — a null code, never a swallowed error', async () => {
    stub({
      ok: false,
      status: 500,
      json: () => {
        throw new Error('not json');
      },
    });

    const err: unknown = await fetchRepositorySet('MOTIR').catch((e: unknown) => e);
    if (!(err instanceof RepositorySetRequestError)) throw new Error('expected a typed error');
    expect(err).toBeInstanceOf(RepositorySetRequestError);
    expect(err.status).toBe(500);
    expect(err.code).toBeNull();
  });
});
