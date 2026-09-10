import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RepositorySetRequestError,
  establishRepositorySet,
  fetchRepositorySet,
  refreshRepositoryAccess,
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

  /* ⚠️ TWO CASES WERE REMOVED HERE, NOT SKIPPED (MOTIR-5014 · Story MOTIR-5010).
     They drove `addRepositoryRow` / `patchRepositoryRow` / `moveRepositoryRow` and
     `connectRepositoryRow` / `skipRepositoryRow` / `replanRepositoryRow`, whose only
     production caller was the step's `set` mode — the technical path, which left for
     onboarding. The seven functions went with it, so there is no wire left for these
     to assert. The ROUTES they called are untouched and still serve the repositories
     room; what is gone is this client's way of reaching them. */
  it('establishes the whole set by default and ONE row when asked', async () => {
    const calls = stub({ json: () => ({ projectId: 'p', rows: [] }) });

    await establishRepositorySet('MOTIR');
    await establishRepositorySet('MOTIR', 'r2');

    expect(calls.map((c) => c.body)).toEqual([{}, { rowId: 'r2' }]);
    expect(calls[0]!.url).toBe('/api/projects/MOTIR/repositories/establish');
  });

  // ⚠️ Driven through `establishRepositorySet` since MOTIR-5014: the case is about
  // `send`, the SHARED helper, and its previous driver (`removeRepositoryRow`) went
  // with the technical path. The behaviour is unchanged and still covered — what
  // moved is which surviving caller exercises it.
  it('treats a 204 as a real answer rather than trying to parse a body', async () => {
    stub({
      status: 204,
      json: () => {
        throw new Error('a 204 has no body to parse');
      },
    });
    await expect(establishRepositorySet('MOTIR')).resolves.toBeUndefined();
  });

  it('turns a non-2xx into a typed error carrying the status AND the server’s code', async () => {
    stub({ ok: false, status: 409, json: () => ({ code: 'PROJECT_REPO_NAME_TAKEN' }) });

    const err: unknown = await establishRepositorySet('MOTIR').catch((e: unknown) => e);
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

// ── COLLABORATOR ACCESS (MOTIR-1900) ────────────────────────────────────────
//
// Same three properties, and one more that matters here: the access calls are
// what stand between a user and their own code, so a swallowed failure would
// look like "we invited you" while nothing was sent.

describe('the collaborator-access client', () => {
  /* ⚠️ FOUR CASES WERE REMOVED HERE, NOT SKIPPED (MOTIR-5015 · Story MOTIR-5010).
     They drove `grantRepositoryAccess`, the access step's POST — a request no
     client makes any more, because the invitation is sent SERVER-SIDE at
     establish and has been since MOTIR-1900
     (`projectRepoSetService.attachRealizedRepo` → `inviteAfterEstablish`).

     The behaviours are pinned where they now live, over real Postgres:
     `tests/projectRepos/projectRepoAccessService.test.ts` asserts the invite per
     created row, the no-identity arm, the refusal that does not damage the
     repository, and the accepted-record skip. The ROUTE is untouched and still
     serves `/settings/project/code-access`, which fetches it directly. */

  it('refreshes the pending invitations with a GET, and returns the rows', async () => {
    const calls = stub({ json: () => [{ id: 'row-1' }] });

    const rows = await refreshRepositoryAccess('MOTIR');

    expect(calls[0]!.url).toBe('/api/projects/MOTIR/repositories/access');
    expect(calls[0]!.method).toBe('GET');
    // A bare ARRAY, not an establish view — the step folds this straight into
    // `view.set.rows`, so the shape is load-bearing.
    expect(rows).toEqual([{ id: 'row-1' }]);
  });

  it('throws the typed error when the refresh is refused — never a silent empty set', async () => {
    stub({ ok: false, status: 500, json: () => ({}) });

    // Returning `[]` here would blank every row the user could see.
    const err = await refreshRepositoryAccess('MOTIR').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepositorySetRequestError);
    expect((err as RepositorySetRequestError).status).toBe(500);
    expect((err as RepositorySetRequestError).code).toBeNull();
  });
});
