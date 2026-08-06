import { describe, expect, it } from 'vitest';
import { API_MAJOR, GENERATED_AGAINST, V1_OPERATIONS, validators } from '../src/api/index.js';

// The generated v1 client, driven (Story 11.5 · Subtask 11.5.2 — MOTIR-2210).
//
// The freshness guard in `tests/cli/generated-api-freshness.test.ts` proves the
// committed artifact matches the emitter. It does NOT prove the artifact is
// USABLE — a generator can emit a perfectly fresh file that validates nothing,
// or that rejects a legal payload. So this suite round-trips a representative
// response from each of the four shipped resource families through its real
// generated validator, then corrupts one field of each and asserts the failure
// NAMES that field.
//
// That last half is the point. `docs/decisions/cli-v1-client.md` Q1 chose Ajv
// over a zod round-trip specifically because `instancePath` IS the story's
// "a precise error naming the field" criterion. A test that only checked
// `valid === false` would leave that claim unasserted.

/** Ajv's `instancePath`s for a failed validation, as the CLI will read them. */
function failingPaths(validate: (data: unknown) => boolean, payload: unknown): string[] {
  expect(validate(payload)).toBe(false);
  const errors = (validate as { errors?: { instancePath: string }[] | null }).errors ?? [];
  return errors.map((error) => error.instancePath);
}

const WORK_ITEM_DETAIL = {
  key: 'MOTIR-1',
  kind: 'subtask',
  type: 'code',
  title: 'A subtask',
  status: 'todo',
  priority: 'high',
  assigneeId: null,
  reporterId: 'user_1',
  dueDate: null,
  estimateMinutes: 30,
  storyPoints: 2,
  createdAt: '2026-08-05T12:00:00Z',
  updatedAt: '2026-08-05T12:00:00Z',
  descriptionMd: '# Body',
  parentKey: 'MOTIR-2',
  ancestorKeys: ['MOTIR-2'],
  children: [],
  links: { blockedBy: [], blocks: [], relatesTo: [], duplicates: [], clones: [] },
  readiness: {
    ready: true,
    openBlockers: [],
    // Both halves of the blocked-ancestor projection 11.7 widened the schema
    // with (MOTIR-2236) — the KEY the schema always carried, and the TITLE it
    // used to drop on the floor while `renderReadinessLine` printed it.
    blockedByAncestorKey: null,
    blockedByAncestorTitle: null,
  },
  labels: [],
  components: [],
  commentCount: 0,
  sprintId: null,
  targetRepo: 'motir-core',
  executor: 'coding_agent',
  planningSource: 'mcp',
  planningHarness: null,
  planningModel: null,
  implementationSource: null,
  implementationHarness: null,
  implementationModel: null,
  archivedAt: null,
};

const PROJECT = {
  key: 'MOTIR',
  name: 'Motir',
  accessLevel: 'open',
  archived: false,
};

const SPRINT = {
  id: 'sprint_1',
  name: 'Sprint 1',
  goal: null,
  state: 'active',
  startDate: '2026-08-01T00:00:00Z',
  endDate: null,
  completedAt: null,
  sequence: 1,
  issueCount: 4,
  committedPoints: null,
  committedIssueCount: null,
};

const READY_SET = {
  items: [
    {
      key: 'MOTIR-1',
      kind: 'subtask',
      title: 'A subtask',
      priority: 'high',
      status: { key: 'todo', category: 'todo' },
      type: 'code',
      executor: 'coding_agent',
      assigneeId: null,
      descriptionExcerpt: null,
      dependencies: { blockedBy: [], blocks: [] },
    },
  ],
  nextCursor: null,
};

describe('the generated validators accept a real response from each family', () => {
  it('WorkItemDetail — `getWorkItem`', () => {
    expect(validators.operation_getWorkItem(WORK_ITEM_DETAIL)).toBe(true);
  });

  it('Project — `getProject`', () => {
    expect(validators.operation_getProject(PROJECT)).toBe(true);
  });

  it('Sprint — `getSprint`', () => {
    expect(validators.operation_getSprint(SPRINT)).toBe(true);
  });

  it('ReadyItem, inside its PAGE envelope — `getProjectReadySet`', () => {
    // Deliberately the PAGED shape rather than a bare row. The emitter composes
    // it as `allOf: [$ref PageEnvelope, { items: … }]`, so this is the
    // assertion that the generator's "one Ajv instance, everything registered"
    // rule actually resolved the envelope reference — a validator compiled in
    // isolation would have thrown at generation time or passed anything here.
    expect(validators.operation_getProjectReadySet(READY_SET)).toBe(true);
  });
});

describe('a malformed response NAMES the field, rather than blanking a cell', () => {
  it('WorkItemDetail — a renamed `title`', () => {
    // The MCP-era failure mode this replaces: `structuredContent as T` accepted
    // this silently and `render.ts` printed an empty cell.
    const { title: _renamed, ...withoutTitle } = WORK_ITEM_DETAIL;
    expect(failingPaths(validators.operation_getWorkItem, withoutTitle)).toContainEqual('');
    const errors = (validators.operation_getWorkItem as { errors?: { params: unknown }[] | null })
      .errors;
    expect(JSON.stringify(errors)).toContain('title');
  });

  it('Project — a `key` that is not a project key', () => {
    expect(
      failingPaths(validators.operation_getProject, { ...PROJECT, key: 'not a key' }),
    ).toContainEqual('/key');
  });

  it('Sprint — a `state` outside the enum', () => {
    expect(
      failingPaths(validators.operation_getSprint, { ...SPRINT, state: 'paused' }),
    ).toContainEqual('/state');
  });

  it('ReadyItem — a bad field on a row INSIDE the page', () => {
    // The path points into the array, which is what makes the message
    // actionable on a 50-row page rather than merely true.
    const corrupted = {
      ...READY_SET,
      items: [{ ...READY_SET.items[0], priority: 'urgent' }],
    };
    expect(failingPaths(validators.operation_getProjectReadySet, corrupted)).toContainEqual(
      '/items/0/priority',
    );
  });

  it('an unexpected EXTRA field is rejected too — the schemas are closed', () => {
    // `additionalProperties: false` throughout, because the server's schemas are
    // `.strict()`. Worth asserting: it is how a client learns that a server has
    // grown a field it does not know about, which is the skew gate's trigger.
    expect(
      failingPaths(validators.operation_getProject, { ...PROJECT, surprise: true }),
    ).toContainEqual('');
  });
});

describe('the operation table the transport will read', () => {
  it('carries the scope for every operation, so a 403 need not parse prose', () => {
    for (const [id, row] of Object.entries(V1_OPERATIONS)) {
      expect(row.scope, `${id} has no scope`).toBeTruthy();
      expect(row.method).toMatch(/^(GET|POST|PATCH|PUT|DELETE)$/);
      expect(row.path.startsWith('/api/v1/'), `${id}: ${row.path}`).toBe(true);
      expect(row.successStatus).toBeGreaterThanOrEqual(200);
      expect(row.successStatus).toBeLessThan(300);
    }
  });

  it('has a validator for every operation that returns a body, and none for a 204', () => {
    for (const [id, row] of Object.entries(V1_OPERATIONS)) {
      const validator = (validators as Record<string, unknown>)[`operation_${id}`];
      if (row.successStatus === 204) {
        expect(validator, `${id} returns 204 but has a validator`).toBeUndefined();
      } else {
        expect(validator, `${id} returns a body but has no validator`).toBeTypeOf('function');
      }
    }
  });

  it('pins the contract version this client was generated against', () => {
    expect(API_MAJOR).toBe(1);
    expect(GENERATED_AGAINST).toMatch(/^\d+\.\d+\.\d+$/);
    expect(GENERATED_AGAINST.startsWith(`${API_MAJOR}.`)).toBe(true);
  });
});
