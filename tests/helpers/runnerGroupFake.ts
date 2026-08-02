// A stateful fake of GitHub's ORG RUNNER-GROUP endpoints (Story MOTIR-1916 ·
// MOTIR-1972), shared by every suite whose flow now touches them.
//
// It is shared rather than copied because the per-project runner group is wired
// into `attachRealizedRepo` — the ONE seam every establish path goes through —
// so ANY suite that establishes a repository now makes these calls. A fake that
// only one suite knew about would leave the others throwing `unexpected fetch`
// into a swallowed side effect: green, silent, and no longer describing what the
// product does.
//
// STATEFUL on purpose. The interesting assertions are about the END STATE of a
// group's access list after a sequence of syncs (the read-derived-write race is
// invisible in a per-call log — both writers "succeed"), so the fake remembers
// what each group holds and the tests read that back.

/** One group as GitHub would hold it. */
export interface FakeRunnerGroup {
  id: number;
  name: string;
  visibility: string;
  allowsPublicRepositories: boolean;
  restrictedToWorkflows: boolean;
  /** The `selected_repository_ids` array, in the order last written. */
  repositoryIds: number[];
}

export interface RunnerGroupFake {
  /** Every group that currently exists, by id. */
  readonly groups: Map<number, FakeRunnerGroup>;
  /** Handle a runner-group request, or return null when the URL is not one —
   *  so a caller can chain it into an existing `fetch` fake by falling through.
   *  ASYNC because the access-list write awaits the concurrency gate below. */
  handle(
    url: string,
    method: string,
    body: Record<string, unknown> | null,
  ): Promise<Response | null>;
  /** The access list of the one group whose name matches, or null. */
  listByName(name: string): number[] | null;
  /** The single group, when a test has arranged for there to be exactly one. */
  onlyGroup(): FakeRunnerGroup;
  /** Make the NEXT n runner-group calls fail with `status`. Null clears it. */
  failWith(status: number | null, times?: number): void;
  /** Every runner-group request seen, in order — how a test asserts the
   *  credential each one carried, and that no second group was created. */
  readonly calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }>;
  /** Delete a group behind Motir's back — the self-healing case. */
  deleteOutOfBand(id: number): void;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function serialize(group: FakeRunnerGroup): Record<string, unknown> {
  return {
    id: group.id,
    name: group.name,
    visibility: group.visibility,
    allows_public_repositories: group.allowsPublicRepositories,
    restricted_to_workflows: group.restrictedToWorkflows,
  };
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter((n) => Number.isInteger(n)) : [];
}

/**
 * Build the fake for one org.
 *
 * `hooks.beforeRepositoriesPut` is the concurrency seam: it is awaited INSIDE the
 * access-list write, which is what lets a test hold one sync's PUT open while
 * another sync runs — the only way to observe a lost update, which is otherwise
 * indistinguishable from two successful writes.
 */
export function createRunnerGroupFake(
  org: string,
  hooks: { beforeRepositoriesPut?: (groupId: number, ids: number[]) => Promise<void> | void } = {},
): RunnerGroupFake {
  const base = `/orgs/${org}/actions/runner-groups`;
  const groups = new Map<number, FakeRunnerGroup>();
  const calls: RunnerGroupFake['calls'] = [];
  let nextId = 5_001;
  let failure: { status: number; times: number } | null = null;

  function consumeFailure(): Response | null {
    if (!failure) return null;
    failure.times -= 1;
    const status = failure.status;
    if (failure.times <= 0) failure = null;
    return json(status, { message: 'Runner group call refused by the fake' });
  }

  return {
    groups,
    calls,
    failWith(status, times = 1) {
      failure = status === null ? null : { status, times };
    },
    deleteOutOfBand(id) {
      groups.delete(id);
    },
    listByName(name) {
      for (const group of groups.values()) {
        if (group.name.toLowerCase() === name.toLowerCase()) return [...group.repositoryIds];
      }
      return null;
    },
    onlyGroup() {
      const all = [...groups.values()];
      if (all.length !== 1) {
        throw new Error(`expected exactly one runner group, found ${all.length}`);
      }
      return all[0]!;
    },
    async handle(url, method, body) {
      const path = new URL(url).pathname;
      if (!path.startsWith(base)) return null;
      calls.push({ url, method, body });

      const refusal = consumeFailure();
      if (refusal) return refusal;

      // PUT …/runner-groups/{id}/repositories — replace the whole access list.
      const repoWrite = /\/runner-groups\/(\d+)\/repositories$/.exec(path);
      if (repoWrite && method === 'PUT') {
        const id = Number(repoWrite[1]);
        const group = groups.get(id);
        if (!group) return json(404, { message: 'Not Found' });
        const ids = numbers(body?.['selected_repository_ids']);
        // The gate runs BEFORE the write lands, so a test can hold one sync's
        // access-list write open while another sync runs to completion — which
        // is the only arrangement in which a lost update is observable.
        await hooks.beforeRepositoriesPut?.(id, ids);
        group.repositoryIds = ids;
        // 204 carries NO body — `new Response(body, {status: 204})` throws.
        return new Response(null, { status: 204 });
      }

      // GET/DELETE …/runner-groups/{id}
      const single = /\/runner-groups\/(\d+)$/.exec(path);
      if (single) {
        const id = Number(single[1]);
        const group = groups.get(id);
        if (method === 'GET') {
          return group ? json(200, serialize(group)) : json(404, { message: 'Not Found' });
        }
        if (method === 'DELETE') {
          if (!group) return json(404, { message: 'Not Found' });
          groups.delete(id);
          return new Response(null, { status: 204 });
        }
      }

      // POST …/runner-groups — create.
      if (path === base && method === 'POST') {
        const name = String(body?.['name'] ?? '');
        const group: FakeRunnerGroup = {
          id: nextId++,
          name,
          visibility: String(body?.['visibility'] ?? ''),
          allowsPublicRepositories: body?.['allows_public_repositories'] === true,
          restrictedToWorkflows: body?.['restricted_to_workflows'] === true,
          repositoryIds: numbers(body?.['selected_repository_ids']),
        };
        groups.set(group.id, group);
        return json(201, serialize(group));
      }

      // GET …/runner-groups?per_page&page — the by-name lookup's list read.
      if (path === base && method === 'GET') {
        return json(200, {
          total_count: groups.size,
          runner_groups: [...groups.values()].map(serialize),
        });
      }

      return json(405, { message: `unhandled runner-group call: ${method} ${path}` });
    },
  };
}
