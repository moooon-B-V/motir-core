import { beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/v1/work-items/[key]/dispatch-prompt/route';
import {
  dispatchPromptSchema,
  planJobHandleSchema,
  planStatusUrl,
  presentDispatchPrompt,
  type V1DispatchPrompt,
} from '@/lib/api/v1/workLoop/schema';
import { WORK_LOOP_OPERATIONS } from '@/lib/api/v1/workLoop/operations';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { runDispatchPrompt } from '@/lib/mcp/tools/dispatchPrompt';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// GET /api/v1/work-items/{key}/dispatch-prompt (Story 11.7 · Subtask 11.7.3 —
// MOTIR-2237) against real Postgres.
//
// Three assertions here are the reason this endpoint is not just another read:
//
//   • It MUST NOT MUTATE. The row is compared byte-for-byte before and after,
//     including for an item already `in_progress` — an orchestrator that could
//     not preview work without taking it would have no safe way to choose.
//   • A `sessionBranch` seed MUST NOT REDIRECT a live lineage. That is the one
//     way this endpoint could corrupt state: an integrated chain stranded across
//     two branches.
//   • The payload must MATCH the MCP tool's, field by field. Two transports, one
//     service — asserted, not asserted-in-a-comment.

const BASE = 'http://localhost:3000/api/v1';

function req(caller: V1ProjectCaller, key: string, query = ''): Promise<Response> {
  return GET(
    new Request(`${BASE}/work-items/${key}/dispatch-prompt${query}`, { headers: caller.headers }),
    { params: Promise.resolve({ key }) },
  );
}

async function prompt(caller: V1ProjectCaller, key: string, query = ''): Promise<V1DispatchPrompt> {
  const res = await req(caller, key, query);
  expect(res.status).toBe(200);
  return (await res.json()) as V1DispatchPrompt;
}

async function makeItem(caller: V1ProjectCaller, title: string, kind: 'task' | 'subtask' = 'task') {
  return workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind, title },
    caller.ctx,
  );
}

/** Everything about the row this endpoint could conceivably move. */
async function stateOf(caller: V1ProjectCaller, id: string) {
  const item = await workItemsService.getWorkItem(id, caller.ctx);
  return {
    status: item.status,
    sessionBranch: item.sessionBranch,
    assigneeId: item.assigneeId,
    updatedAt: item.updatedAt,
  };
}

describe('GET /api/v1/work-items/{key}/dispatch-prompt', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('returns the assembled prompt and the facts a client routes on', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'build the thing');

    const body = await prompt(caller, item.identifier);

    expect(() => dispatchPromptSchema.parse(body)).not.toThrow();
    expect(body.key).toBe(item.identifier);
    expect(body.prompt.length).toBeGreaterThan(0);
    expect(body.prompt).toContain(item.identifier);
    expect(body.workflowMode).toBe('per_item_pr');
    expect(body.sessionBranch).toBeNull();
    // Always PRESENT — `[]` when there are none, so a client never branches on
    // absence.
    expect(body.advisories).toEqual([]);
  });

  it('does NOT claim the item, move its status or touch its branch', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'do not take me');
    const before = await stateOf(caller, item.id);

    await prompt(caller, item.identifier);

    expect(await stateOf(caller, item.id)).toEqual(before);
  });

  it('does not mutate an item already IN PROGRESS either', async () => {
    // The case that matters: re-fetching the prompt mid-run is exactly what a
    // resumed session does, and it must be free.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'already running');
    await workItemsService.updateStatus(item.id, 'in_progress', caller.ctx);
    const before = await stateOf(caller, item.id);

    const body = await prompt(caller, item.identifier);

    expect(body.key).toBe(item.identifier);
    expect(await stateOf(caller, item.id)).toEqual(before);
  });

  it('accepts a `sessionBranch` SEED for an item with no lineage of its own', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'seed me');

    const body = await prompt(caller, item.identifier, '?sessionBranch=session/MOTIR-1-run');

    expect(body.sessionBranch).toBe('session/MOTIR-1-run');
    expect(body.workflowMode).toBe('session_lineage');
    // Reading the prompt is still a read: the seed reached the PROMPT, not the row.
    expect((await stateOf(caller, item.id)).sessionBranch).toBeNull();
  });

  it('does NOT redirect an item that already carries a lineage', async () => {
    // The one way this endpoint could corrupt state. The item's own branch wins;
    // the caller's seed is ignored entirely.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'already on a branch');
    // `markIntegrated` moves the item to `in_review`, which is only legal from
    // `in_progress` on the default workflow.
    await workItemsService.updateStatus(item.id, 'in_progress', caller.ctx);
    await workItemsService.markIntegrated(item.id, 'session/OWN-branch', caller.ctx);
    const before = await stateOf(caller, item.id);

    const body = await prompt(caller, item.identifier, '?sessionBranch=session/HIJACK');

    expect(body.sessionBranch).not.toBe('session/HIJACK');
    expect(await stateOf(caller, item.id)).toEqual(before);
  });

  it('treats an EMPTY `sessionBranch` as no seed rather than as a bad request', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'no seed');

    const body = await prompt(caller, item.identifier, '?sessionBranch=');

    expect(body.sessionBranch).toBeNull();
    expect(body.workflowMode).toBe('per_item_pr');
  });

  it.each([
    ['a shell metacharacter', 'main;rm -rf /'],
    ['whitespace', 'my branch'],
    ['a leading dash', '-oProxyCommand=x'],
    ['an over-long name', 'a'.repeat(201)],
  ])('422s an unsafe branch name — %s', async (_label, branch) => {
    // The seed is interpolated into prompt text instructing an agent to run
    // `git … origin/<branch>`, so refusing is cheaper than escaping — and it is
    // refused BEFORE the read.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'safe');

    const res = await req(caller, item.identifier, `?sessionBranch=${encodeURIComponent(branch)}`);

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_SESSION_BRANCH');
  });

  it('matches the MCP tool’s payload field by field', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'one item, two transports');

    const body = await prompt(caller, item.identifier);
    const tool = await runDispatchPrompt({ key: item.identifier }, caller.ctx);
    const payload = tool.structuredContent as Record<string, unknown>;

    // Every field of the v1 body, compared to the SAME field of the MCP payload.
    // The prompt is a pure function of server state, so the text is byte-equal.
    for (const [field, value] of Object.entries(body)) {
      expect(payload[field], `field ${field}`).toEqual(value);
    }
  });

  it('is gated on the scope its MCP counterpart carries, not on a copy of it', async () => {
    // Read off the shipped map rather than hard-coded: ADR Amendment 6 Q2 —
    // one capability model, two transports.
    const operation = WORK_LOOP_OPERATIONS.find(
      (op) => op.operationId === 'getWorkItemDispatchPrompt',
    );
    expect(operation?.permission).toBe(TOOL_PERMISSIONS.dispatch_prompt);
  });

  it('refuses a token without `read` with 403', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['work_items:write'] });
    const item = await makeItem(caller, 'not for you');

    const res = await req(caller, item.identifier);

    expect(res.status).toBe(403);
  });

  it('answers 404 for a key in ANOTHER workspace — never 403', async () => {
    // The existence oracle §4 forbids: 403 would confirm the item exists.
    const mine = await createV1ProjectCaller({ scopes: ['read'] });
    const theirs = await createV1ProjectCaller({ scopes: ['read'] });
    const hidden = await makeItem(theirs, 'someone else’s work');

    const res = await req(mine, hidden.identifier);

    expect(res.status).toBe(404);
  });

  it('422s a malformed key before any read', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    const res = await req(caller, 'not-a-key');

    expect(res.status).toBe(422);
  });
});

describe('the dispatch-prompt schema', () => {
  it('accepts an UNKNOWN advisory severity rather than failing a shipped client', () => {
    // ADR §8 permits a new value on a field documented as open-ended, and the
    // advisory channel has grown twice already (MOTIR-2175, MOTIR-2177). A closed
    // enum here would 500 this endpoint on its OWN response the day the server
    // emitted the next severity — the drift guard validates real responses
    // against this schema.
    const withFutureSeverity = {
      key: 'PROD-1',
      prompt: 'text',
      parentKey: 'PROD-9',
      targetRepo: null,
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      // MOTIR-3131 — the presenter maps the repository SET too; these fixtures
      // exercise the ADVISORY branch and carry an empty one.
      targetRepos: [],
      workflowMode: 'per_item_pr',
      sessionBranch: null,
      advisories: [
        {
          item: 'PROD-1',
          referenced: 'PROD-2',
          referencedStatus: 'todo',
          severity: 'not-yet-invented',
        },
        { kind: 'shape', item: 'PROD-1', severity: 'a-future-shape-defect', criterionIndex: 3 },
      ],
    };

    expect(() => dispatchPromptSchema.parse(withFutureSeverity)).not.toThrow();
  });

  it('shapes each advisory FIELD BY FIELD — an internal addition does not reach the wire', () => {
    const mapped = presentDispatchPrompt({
      key: 'PROD-1',
      prompt: 'text',
      parentKey: 'PROD-9',
      targetRepo: null,
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      // MOTIR-3131 — the presenter maps the repository SET too; these fixtures
      // exercise the ADVISORY branch and carry an empty one.
      targetRepos: [],
      workflowMode: 'per_item_pr',
      sessionBranch: null,
      advisories: [
        {
          item: 'PROD-1',
          referenced: 'PROD-2',
          referencedStatus: 'todo',
          severity: 'likely-missing-edge',
          internalOnly: 'do-not-ship',
        },
      ],
    } as unknown as Parameters<typeof presentDispatchPrompt>[0]);

    expect(JSON.stringify(mapped)).not.toContain('do-not-ship');
    expect(mapped.advisories[0]).toEqual({
      item: 'PROD-1',
      referenced: 'PROD-2',
      referencedStatus: 'todo',
      severity: 'likely-missing-edge',
    });
  });

  it('carries a SHAPE advisory’s per-severity fields, and only its own', () => {
    const mapped = presentDispatchPrompt({
      key: 'PROD-1',
      prompt: 'text',
      parentKey: 'PROD-9',
      targetRepo: null,
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      // MOTIR-3131 — the presenter maps the repository SET too; these fixtures
      // exercise the ADVISORY branch and carry an empty one.
      targetRepos: [],
      workflowMode: 'per_item_pr',
      sessionBranch: null,
      advisories: [
        {
          kind: 'shape',
          item: 'PROD-1',
          severity: 'likely-ordering-violation',
          criterionIndex: 2,
          phrase: 'after this merges',
        },
        {
          kind: 'shape',
          item: 'PROD-1',
          severity: 'likely-repo-straddle',
          criterionIndex: 4,
          path: 'lib/x.ts',
          repo: 'motir-ai',
          reason: 'contradiction',
        },
      ],
    } as unknown as Parameters<typeof presentDispatchPrompt>[0]);

    expect(mapped.advisories[0]).toEqual({
      kind: 'shape',
      item: 'PROD-1',
      severity: 'likely-ordering-violation',
      criterionIndex: 2,
      phrase: 'after this merges',
    });
    expect(mapped.advisories[1]).toEqual({
      kind: 'shape',
      item: 'PROD-1',
      severity: 'likely-repo-straddle',
      criterionIndex: 4,
      path: 'lib/x.ts',
      repo: 'motir-ai',
      reason: 'contradiction',
    });
    expect(() => dispatchPromptSchema.parse(mapped)).not.toThrow();
  });

  it('carries a SUBSUMPTION advisory field-for-field, and only its own (MOTIR-2903)', () => {
    // The seam's whole job: a field added to `WorkItemProseAdvisoryDto` for an
    // internal consumer must not become public API by accident, and a NEW family
    // must not be mapped through another family's branch. Before MOTIR-2903 the
    // presenter's `else` swept everything not tagged `shape` into the reference
    // shape, so this entry would have crossed the wire as
    // `{ referenced: undefined, referencedStatus: undefined }`.
    const mapped = presentDispatchPrompt({
      key: 'PROD-1',
      prompt: 'text',
      parentKey: null,
      targetRepo: 'motir-core',
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      // MOTIR-3131 — the presenter maps the repository SET too; these fixtures
      // exercise the ADVISORY branch and carry an empty one.
      targetRepos: [],
      workflowMode: 'per_item_pr',
      sessionBranch: null,
      advisories: [
        {
          kind: 'subsumption',
          item: 'PROD-1',
          severity: 'likely-already-shipped',
          path: 'lib/services/workflowsService.ts',
          pullRequest: 'moooon-B-V/motir-core#2059',
          pullRequestTitle: 'Bind the READ surface for motir_app',
          mergedAt: '2026-08-15T14:00:00.000Z',
        },
      ],
    } as unknown as Parameters<typeof presentDispatchPrompt>[0]);

    expect(mapped.advisories[0]).toEqual({
      kind: 'subsumption',
      item: 'PROD-1',
      severity: 'likely-already-shipped',
      path: 'lib/services/workflowsService.ts',
      pullRequest: 'moooon-B-V/motir-core#2059',
      pullRequestTitle: 'Bind the READ surface for motir_app',
      mergedAt: '2026-08-15T14:00:00.000Z',
    });
    expect(() => dispatchPromptSchema.parse(mapped)).not.toThrow();
  });

  it('carries a SIZING advisory field-for-field, with NO criterionIndex (MOTIR-3110)', () => {
    // The second `kind: 'shape'` variant, and the reason it is a variant rather
    // than a third severity inside the existing one: it has no criterion to
    // point at, and loosening `criterionIndex` to optional on the shipped shape
    // schema would be a nullability change ADR §8 forbids. So the union grew
    // instead — additive, on a field clients must already tolerate unknown
    // members of.
    const mapped = presentDispatchPrompt({
      key: 'PROD-1',
      prompt: 'text',
      parentKey: null,
      targetRepo: 'motir-core',
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      // MOTIR-3131 — the presenter maps the repository SET too; this fixture
      // exercises the ADVISORY branch and carries an empty one.
      targetRepos: [],
      workflowMode: 'per_item_pr',
      sessionBranch: null,
      advisories: [
        {
          kind: 'shape',
          item: 'PROD-1',
          severity: 'likely-over-gate-sizing',
          threshold: 'both',
          storyPoints: 13,
          estimateMinutes: 600,
        },
      ],
    } as unknown as Parameters<typeof presentDispatchPrompt>[0]);

    expect(mapped.advisories[0]).toEqual({
      kind: 'shape',
      item: 'PROD-1',
      severity: 'likely-over-gate-sizing',
      threshold: 'both',
      storyPoints: 13,
      estimateMinutes: 600,
    });
    // The point of the field-by-field mapper: no `criterionIndex` is invented on
    // the way out, and no other member's fields ride along.
    expect(mapped.advisories[0]).not.toHaveProperty('criterionIndex');
    expect(mapped.advisories[0]).not.toHaveProperty('phrase');
    expect(() => dispatchPromptSchema.parse(mapped)).not.toThrow();
  });

  it('an UNESTIMATED column crosses the wire as null, not as absent or zero', () => {
    // A card over one ceiling with the other column empty is the ordinary shape
    // — the gate's "every leaf carries an estimate" limb is a different finding
    // — so `null` has to survive the mapper AND the schema.
    const mapped = presentDispatchPrompt({
      key: 'PROD-1',
      prompt: 'text',
      parentKey: null,
      targetRepo: 'motir-core',
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      targetRepos: [],
      workflowMode: 'per_item_pr',
      sessionBranch: null,
      advisories: [
        {
          kind: 'shape',
          item: 'PROD-1',
          severity: 'likely-over-gate-sizing',
          threshold: 'story_points',
          storyPoints: 21,
          estimateMinutes: null,
        },
      ],
    } as unknown as Parameters<typeof presentDispatchPrompt>[0]);

    expect(mapped.advisories[0]).toMatchObject({ storyPoints: 21, estimateMinutes: null });
    expect(() => dispatchPromptSchema.parse(mapped)).not.toThrow();
  });

  it('the two `kind: "shape"` variants stay DISJOINT — neither parses as the other', () => {
    // The union is plain, not discriminated, so the guarantee that a sizing
    // advisory does not silently validate as a criterion one (and lose its
    // fields) rests on their REQUIRED fields being disjoint. Asserted directly,
    // because the day it stops holding the failure is a stripped payload rather
    // than an error.
    const sizing = {
      kind: 'shape' as const,
      item: 'PROD-1',
      severity: 'likely-over-gate-sizing',
      threshold: 'both',
      storyPoints: 13,
      estimateMinutes: 600,
    };
    const ordering = {
      kind: 'shape' as const,
      item: 'PROD-1',
      severity: 'likely-ordering-violation',
      criterionIndex: 2,
      phrase: 'once it lands',
    };
    const envelope = (advisories: unknown[]) => ({
      key: 'PROD-1',
      prompt: 'text',
      parentKey: null,
      targetRepo: null,
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      targetRepos: [],
      workflowMode: 'per_item_pr' as const,
      sessionBranch: null,
      advisories,
    });

    expect(dispatchPromptSchema.parse(envelope([sizing])).advisories[0]).toEqual(sizing);
    expect(dispatchPromptSchema.parse(envelope([ordering])).advisories[0]).toEqual(ordering);
  });

  it('carries a SELF-BLOCKING-DESIGN advisory field-for-field, with BOTH indices (MOTIR-3178)', () => {
    // The third `kind: 'shape'` variant, and a variant for the same §8 reason the
    // sizing one is: it carries no `criterionIndex` at all — a PAIR of named
    // indices instead, because its remedy LIFTS the design criterion onto its own
    // card rather than cutting the list at a line.
    const mapped = presentDispatchPrompt({
      key: 'PROD-1',
      prompt: 'text',
      parentKey: null,
      targetRepo: 'motir-core',
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      targetRepos: [],
      workflowMode: 'per_item_pr',
      sessionBranch: null,
      advisories: [
        {
          kind: 'shape',
          item: 'PROD-1',
          severity: 'likely-self-blocking-design',
          designCriterionIndex: 1,
          surfaceCriterionIndex: 4,
        },
      ],
    } as unknown as Parameters<typeof presentDispatchPrompt>[0]);

    expect(mapped.advisories[0]).toEqual({
      kind: 'shape',
      item: 'PROD-1',
      severity: 'likely-self-blocking-design',
      designCriterionIndex: 1,
      surfaceCriterionIndex: 4,
    });
    // No `criterionIndex` is invented on the way out, and no other member's
    // fields ride along — the point of the field-by-field mapper.
    expect(mapped.advisories[0]).not.toHaveProperty('criterionIndex');
    expect(mapped.advisories[0]).not.toHaveProperty('threshold');
    expect(() => dispatchPromptSchema.parse(mapped)).not.toThrow();
  });

  it('all THREE `kind: "shape"` variants stay disjoint — none parses as another', () => {
    // The union is plain, not discriminated, so this guarantee rests entirely on
    // the three variants' REQUIRED fields being disjoint: `criterionIndex` /
    // `threshold` / the index PAIR. Asserted directly, because the day it stops
    // holding the failure is a silently stripped payload rather than an error.
    const selfBlocking = {
      kind: 'shape' as const,
      item: 'PROD-1',
      severity: 'likely-self-blocking-design',
      designCriterionIndex: 1,
      surfaceCriterionIndex: 4,
    };
    const sizing = {
      kind: 'shape' as const,
      item: 'PROD-1',
      severity: 'likely-over-gate-sizing',
      threshold: 'both',
      storyPoints: 13,
      estimateMinutes: 600,
    };
    const straddle = {
      kind: 'shape' as const,
      item: 'PROD-1',
      severity: 'likely-repo-straddle',
      criterionIndex: 2,
      path: 'motir-ai/src/x.ts',
      repo: 'motir-ai',
      reason: 'contradiction',
    };
    const envelope = (advisories: unknown[]) => ({
      key: 'PROD-1',
      prompt: 'text',
      parentKey: null,
      targetRepo: null,
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      targetRepos: [],
      workflowMode: 'per_item_pr' as const,
      sessionBranch: null,
      advisories,
    });

    expect(dispatchPromptSchema.parse(envelope([selfBlocking])).advisories[0]).toEqual(
      selfBlocking,
    );
    expect(dispatchPromptSchema.parse(envelope([sizing])).advisories[0]).toEqual(sizing);
    expect(dispatchPromptSchema.parse(envelope([straddle])).advisories[0]).toEqual(straddle);
    // …and all three together, in one array, since that is how a card carrying
    // several defects actually arrives.
    expect(
      dispatchPromptSchema.parse(envelope([selfBlocking, sizing, straddle])).advisories,
    ).toEqual([selfBlocking, sizing, straddle]);
  });
});

describe('the work-loop job handle (ADR Amendment 6 Q3)', () => {
  it('has no field a RESULT could arrive in — that is how it signals "accepted"', () => {
    // The schema's shape IS the signal: no `items`, no `proposals`, no `count`,
    // no `status`. A client cannot read an outcome out of it, only an address to
    // come back to. Pinned here, ahead of the two endpoints that return it, so
    // neither can widen it into something that reads like a finished result.
    expect(Object.keys(planJobHandleSchema.shape).sort()).toEqual(['jobId', 'planId', 'statusUrl']);
  });

  it('builds the poll address in ONE place, so the two 202 endpoints agree', () => {
    expect(planStatusUrl('plan_123')).toBe('/api/v1/plans/plan_123/status');
  });
});
