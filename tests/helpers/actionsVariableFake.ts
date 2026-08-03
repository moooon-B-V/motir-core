// A stateful fake of GitHub's ORG ACTIONS-VARIABLE endpoints (Story MOTIR-1916 ·
// MOTIR-2015), shared by every suite whose flow now touches them.
//
// It is shared rather than copied for exactly the reason `runnerGroupFake.ts` is:
// the ensure is wired into `establishSet` — the ONE seam every establish path goes
// through — so ANY suite that establishes a repository now makes these calls. A
// fake only one suite knew about would leave the others throwing `unexpected
// fetch` into a swallowed side effect: green, silent, and no longer describing
// what the product does. (The service swallows its own failures by contract, which
// is precisely what makes an unfaked call invisible rather than loud.)
//
// STATEFUL on purpose. The interesting assertions are about what the org ENDS UP
// holding after a sequence of ensures — created once, then unchanged, and restored
// after an out-of-band delete — none of which a per-call log can answer.

/** One organization variable as GitHub would hold it. */
export interface FakeOrgVariable {
  name: string;
  value: string;
  visibility: string;
}

export interface ActionsVariableFake {
  /** Every variable that currently exists, by name. */
  readonly variables: Map<string, FakeOrgVariable>;
  /** Handle an Actions-variable request, or return null when the URL is not one —
   *  so a caller can chain it into an existing `fetch` fake by falling through. */
  handle(url: string, method: string, body: Record<string, unknown> | null): Response | null;
  /** Every Actions-variable request seen, in order — how a test asserts the body
   *  each one carried, and that a second ensure wrote nothing. */
  readonly calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }>;
  /** Requests that were WRITES (POST/PATCH) — the "did it write again?" assertion
   *  without every test re-deriving the filter. */
  writeCalls(): Array<{ url: string; method: string; body: Record<string, unknown> | null }>;
  /** Make the NEXT n Actions-variable calls fail with `status`. Null clears it. */
  failWith(status: number | null, times?: number): void;
  /** Seed a variable as if it already existed — the drift and unchanged cases. */
  seed(variable: FakeOrgVariable): void;
  /** Delete a variable behind Motir's back — the self-healing case. */
  deleteOutOfBand(name: string): void;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function serialize(variable: FakeOrgVariable): Record<string, unknown> {
  return {
    name: variable.name,
    value: variable.value,
    visibility: variable.visibility,
    created_at: '2026-08-02T00:00:00Z',
    updated_at: '2026-08-02T00:00:00Z',
  };
}

/** Build the fake for one org. */
export function createActionsVariableFake(org: string): ActionsVariableFake {
  const base = `/orgs/${org}/actions/variables`;
  const variables = new Map<string, FakeOrgVariable>();
  const calls: ActionsVariableFake['calls'] = [];
  let failure: { status: number; times: number } | null = null;

  function consumeFailure(): Response | null {
    if (!failure) return null;
    failure.times -= 1;
    const status = failure.status;
    if (failure.times <= 0) failure = null;
    return json(status, { message: 'Actions-variable call refused by the fake' });
  }

  return {
    variables,
    calls,
    writeCalls() {
      return calls.filter((c) => c.method === 'POST' || c.method === 'PATCH');
    },
    failWith(status, times = 1) {
      failure = status === null ? null : { status, times };
    },
    seed(variable) {
      variables.set(variable.name, { ...variable });
    },
    deleteOutOfBand(name) {
      variables.delete(name);
    },
    handle(url, method, body) {
      const path = new URL(url).pathname;
      if (!path.startsWith(base)) return null;
      calls.push({ url, method, body });

      const refusal = consumeFailure();
      if (refusal) return refusal;

      // GET/PATCH/DELETE …/variables/{name}
      const single = /\/actions\/variables\/([^/]+)$/.exec(path);
      if (single) {
        const name = decodeURIComponent(single[1]!);
        const existing = variables.get(name);
        if (method === 'GET') {
          return existing ? json(200, serialize(existing)) : json(404, { message: 'Not Found' });
        }
        if (method === 'PATCH') {
          // GitHub 404s a PATCH of a variable that does not exist — the branch that
          // makes a blind-write implementation wrong half the time.
          if (!existing) return json(404, { message: 'Not Found' });
          variables.set(name, {
            name,
            value: String(body?.['value'] ?? ''),
            visibility: String(body?.['visibility'] ?? existing.visibility),
          });
          return new Response(null, { status: 204 });
        }
        if (method === 'DELETE') {
          if (!existing) return json(404, { message: 'Not Found' });
          variables.delete(name);
          return new Response(null, { status: 204 });
        }
      }

      // POST …/variables — create. GitHub 409s when the name is taken, which is the
      // lost create race the client converges past.
      if (path === base && method === 'POST') {
        const name = String(body?.['name'] ?? '');
        if (variables.has(name)) return json(409, { message: 'Variable already exists' });
        variables.set(name, {
          name,
          value: String(body?.['value'] ?? ''),
          visibility: String(body?.['visibility'] ?? ''),
        });
        return new Response(null, { status: 201 });
      }

      // GET …/variables — the list read (nothing in the product uses it; present so
      // an accidental call is visible as data rather than as a 405).
      if (path === base && method === 'GET') {
        return json(200, {
          total_count: variables.size,
          variables: [...variables.values()].map(serialize),
        });
      }

      return json(405, { message: `unhandled Actions-variable call: ${method} ${path}` });
    },
  };
}
