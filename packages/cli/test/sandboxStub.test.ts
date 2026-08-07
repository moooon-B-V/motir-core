import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain `.mjs` fixture module with no types, deliberately:
// it runs under the bare `node` inside the sandbox image, where nothing compiles
// TypeScript. What it must be is CORRECT, and that is what this file checks.
import { __fixtures } from '../sandbox/smoke/stub-server.mjs';
import { validators } from '../src/api/index.js';

// THE SANDBOX STUB'S BODIES, AGAINST THE GENERATED VALIDATORS (MOTIR-2436).
//
// `sandbox/smoke/stub-server.mjs` is what the built `motir` binary talks to
// inside the sandbox image. It used to speak MCP, where a tool result was an
// opaque blob the client cast to a type — so an APPROXIMATE body passed, and the
// stub could be written by eye.
//
// It cannot any more, and that is an improvement rather than a burden: the v1
// client validates every response against its generated Ajv validator before an
// adapter sees it. A body that is nearly right is rejected by the CLI itself.
//
// The catch is WHERE that rejection surfaces. Without this file, a wrong field
// fails inside a Docker matrix twenty minutes into CI, as an opaque `motir auto`
// failure that reads like a CLI bug. With it, the same mistake fails here in
// milliseconds, naming the field — and, because the validators are generated
// from the server's own document, a body that passes here is a body the real
// server could have sent.
//
// ⚠️ It also means the stub is now a SECOND consumer of the generated client. If
// a schema changes and the client is regenerated, this file goes red alongside
// `api-validators.test.ts` — which is the point: the smoke stub is exactly the
// kind of fixture that rots silently, and 11.5.6 proved it by leaving it
// speaking a protocol nothing spoke any more.

/**
 * The stub's pure builders, typed for this file.
 *
 * Hand-written rather than inferred because the module is `.mjs` with no types —
 * which is deliberate: it runs under the bare `node` inside the sandbox image,
 * where nothing compiles TypeScript. What it must be is CORRECT, and that is
 * what the assertions below check.
 */
interface StubFixtures {
  me: () => unknown;
  workspaces: () => unknown;
  projects: () => unknown;
  readySet: () => { items: { key: string }[] };
  workItemDetail: (key: string) => unknown;
  dispatchPrompt: (key: string, query: URLSearchParams) => unknown;
  transition: (key: string, body: { status: string }) => unknown;
  integration: (key: string, body: Record<string, unknown>) => unknown;
  matchRoute: (method: string, path: string) => { params: Record<string, string> } | null;
  ITEMS: unknown[];
}

const fixtures = __fixtures as StubFixtures;
const { me, workspaces, projects, readySet, workItemDetail, dispatchPrompt, integration } =
  fixtures;

/** The generated validator for an operation, and the fields it complains about. */
function validate(operationId: string, build: () => unknown): { ok: boolean; paths: string[] } {
  const table = validators as unknown as Record<string, ((data: unknown) => boolean) | undefined>;
  const validator = table[`operation_${operationId}`];
  expect(validator, `no generated validator for ${operationId}`).toBeTypeOf('function');
  const ok = validator!(build());
  const errors = (validator as unknown as { errors?: { instancePath?: string }[] | null }).errors;
  return { ok, paths: (errors ?? []).map((e) => e.instancePath ?? '') };
}

/** A `URLSearchParams` stand-in for the two query-reading fixtures. */
const query = (init: Record<string, string> = {}): URLSearchParams => new URLSearchParams(init);

describe('every stubbed body is one the real API could have sent', () => {
  const CASES: [operationId: string, build: () => unknown][] = [
    ['getMe', () => me()],
    ['listWorkspaces', () => workspaces()],
    ['listProjects', () => projects()],
    ['getProjectReadySet', () => readySet()],
    ['getWorkItem', () => workItemDetail('SMOKE-1')],
    [
      'getWorkItemDispatchPrompt',
      () => dispatchPrompt('SMOKE-1', query({ sessionBranch: 'motir/auto-1' })),
    ],
    [
      'recordWorkItemIntegration',
      () =>
        integration('SMOKE-1', {
          sessionBranch: 'motir/auto-1',
          implementationHarness: 'motir-cli/0.1.0',
        }),
    ],
  ];

  it.each(CASES)('%s', (operationId, build) => {
    const { ok, paths } = validate(operationId, build);
    expect(ok, `${operationId} rejected at ${JSON.stringify(paths)}`).toBe(true);
  });

  it('the transition answers a full WorkItemDetail, not a thin acknowledgement', () => {
    // The operation declares `WorkItemDetail`, and the CLI validates it even
    // though `transitionStatus` returns void. The MCP stub answered
    // `{ key, status }` and that was fine; here it would fail the run.
    const body = fixtures.transition('SMOKE-1', { status: 'in_progress' });
    const { ok, paths } = validate('transitionWorkItem', () => body);
    expect(ok, `rejected at ${JSON.stringify(paths)}`).toBe(true);
  });

  it('the validators REJECT a thin body — the check is not vacuous', () => {
    // Exactly what the MCP-era stub used to return for a transition.
    expect(
      validate('transitionWorkItem', () => ({ key: 'SMOKE-1', status: 'in_progress' })).ok,
    ).toBe(false);
    expect(
      validate('getProjectReadySet', () => ({ items: [{ key: 'SMOKE-1' }], nextCursor: null })).ok,
    ).toBe(false);
  });
});

describe('the ready set drains the way the real server does', () => {
  it('an item leaves once it is no longer in the TODO category', () => {
    // The rule `workItemsService.listReady` implements: childless leaves in the
    // todo category. `motir auto` flips an item to in_progress before fetching
    // its prompt, and THAT is what drops it out — not a cursor the stub advances
    // on its own. A stub that used a counter would let a loop which never
    // transitioned anything still drain the set, which is the exact regression
    // `assert-run.mjs` exists to catch.
    //
    // ⚠️ Asserted RELATIVELY. The stub holds its statuses in module state and
    // vitest imports the module once, so an absolute count would depend on
    // which tests above it happened to run — a passing-by-accident shape, and
    // one this file would be the wrong place to discover.
    const before = fixtures.readySet().items.map((row) => row.key);
    const target = before[before.length - 1];
    expect(target, 'no item left in the ready set to drain').toBeDefined();

    fixtures.transition(target as string, { status: 'in_progress' });

    const after = fixtures.readySet().items.map((row) => row.key);
    expect(after).not.toContain(target);
    expect(after).toHaveLength(before.length - 1);
  });
});

describe('the route table resolves the paths the CLI addresses', () => {
  const { matchRoute } = fixtures;

  it('extracts a dynamic segment by name', () => {
    expect(matchRoute('GET', '/api/v1/work-items/SMOKE-1')?.params).toEqual({ key: 'SMOKE-1' });
    expect(matchRoute('GET', '/api/v1/projects/SMOKE/ready')?.params).toEqual({
      projectKey: 'SMOKE',
    });
  });

  it('a LITERAL beats a dynamic segment — the sub-resource wins', () => {
    // `…/work-items/{key}` and `…/work-items/{key}/dispatch-prompt` differ by a
    // trailing literal; a prefix match would serve the detail route here.
    expect(matchRoute('GET', '/api/v1/work-items/SMOKE-1/dispatch-prompt')?.params).toEqual({
      key: 'SMOKE-1',
    });
  });

  it('METHOD is part of the match', () => {
    // `POST …/transitions` exists; `GET` on the same path does not, and must not
    // fall through to some other row.
    expect(matchRoute('POST', '/api/v1/work-items/SMOKE-1/transitions')).not.toBeNull();
    expect(matchRoute('GET', '/api/v1/work-items/SMOKE-1/transitions')).toBeNull();
  });

  it('an unrouted path matches NOTHING — the stub is not a catch-all', () => {
    expect(matchRoute('GET', '/api/v1/invented')).toBeNull();
    expect(matchRoute('GET', '/api/v1/work-items/SMOKE-1/not-a-sub-resource')).toBeNull();
  });
});
