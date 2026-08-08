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
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
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
    expect(operation?.scope).toBe(TOOL_SCOPES.dispatch_prompt);
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
