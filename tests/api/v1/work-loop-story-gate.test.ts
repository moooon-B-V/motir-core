import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: vi.fn(async () => ({ jobId: 'job_gate' })),
}));

import { DOMAIN_ERROR_STATUS, classifyApiV1Error } from '@/lib/api/v1/errors';
import { V1_OPERATIONS, findV1Operation } from '@/lib/api/v1/openapi/registry';
import { operationKey } from '@/lib/api/v1/openapi/operation';
import { WORK_LOOP_OPERATIONS } from '@/lib/api/v1/workLoop/operations';
import {
  dispatchPromptSchema,
  integrationResultSchema,
  planSchema,
  planSessionSchema,
  planTargetKeyResolver,
  presentActivityChange,
  presentDispatchPrompt,
  presentIntegrationResult,
  presentPlan,
  presentPlanOutcome,
  presentPlanSession,
  presentSessionCloseOut,
  planOutcomeSchema,
  sessionCloseOutSchema,
} from '@/lib/api/v1/workLoop/schema';
import {
  readinessSchema,
  workItemDetailSchema,
  workItemSummarySchema,
} from '@/lib/api/v1/workItems/schema';
import { MotirAiUnavailableError, MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import {
  EmptyPlanChangeIntentError,
  PlanChangeTurnConflictError,
  TooManyPlanChangeTargetsError,
} from '@/lib/planChange/errors';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_SCOPES, type TokenScope } from '@/lib/mcp/scopes';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { activityService } from '@/lib/services/activityService';
import { commentsService } from '@/lib/services/commentsService';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { plansService } from '@/lib/services/plansService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { buildScope } from '@/lib/planChange/scope';
import {
  auditV1RouteSource,
  declaredScopeByMethod,
  readRouteSource,
  v1RouteFiles,
} from '../../helpers/v1RouteAudit';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// The Story 11.7 GATE (Subtask 11.7.8 — MOTIR-2242).
//
// Each code card ships its own units; this suite measures what they LEFT and
// adds the checks no single card could make:
//
//   • the SERVICE → SCHEMA → RESPONSE seam, per resource, driven from a real
//     service call against real Postgres. A fixture written to match the schema
//     proves only that its author was consistent.
//   • the scope map is MIRRORED, read from `lib/mcp/scopes.ts` at test time —
//     a copied table drifts the first time either side moves.
//   • ERROR TOTALITY over the cases a happy path never reaches.
//   • the five CONTRACT GUARDS, each proven to FAIL when its property is
//     violated. A guard that has only ever been seen to pass is not a guard.
//   • "agents keep MCP", held by `git diff` over `tests/mcp/` rather than by a
//     sentence in a card.

const REPO_ROOT = process.cwd();

/** The routes this story added, discovered rather than listed. */
const WORK_LOOP_PATHS = WORK_LOOP_OPERATIONS.map((op) => op.path);

/**
 * The operation → MCP tool correspondence, as the story's own audit table states
 * it.
 *
 * Only the PAIRING is written here; the SCOPE is read from `TOOL_SCOPES` at
 * assertion time, so a change to the shared map moves the expectation with it
 * instead of contradicting it. Shared by the scope-mirroring block and by
 * GUARD 4, which asks a different question of the same ten tools.
 */
const WORK_LOOP_MIRRORS = {
  getWorkItemDispatchPrompt: 'dispatch_prompt',
  recordWorkItemIntegration: 'mark_integrated',
  completeSession: 'complete_session',
  submitWorkItemExpansion: 'expand_item',
  getPlanStatus: 'get_plan_status',
  getPlan: 'get_plan',
  openPlanSession: 'open_plan_session',
  appendPlanTurn: 'append_plan_turn',
  submitPlanSession: 'submit_plan_session',
  getWorkItemActivity: 'get_work_item_activity',
} as const;

/**
 * Work-loop operations that deliberately mirror NO MCP tool, each with the
 * reason — the same shape the drift guard uses for an operation it cannot
 * drive.
 *
 * An entry here is a claim that has to be argued, not a way to quiet the guard:
 * the pairing check below reads this set, so an operation added with no tool and
 * no reason still fails. What the guard actually protects is that nobody adds a
 * v1 operation whose scope was invented rather than mirrored, and an operation
 * with no counterpart cannot invent one either — its scope is asserted against
 * `TOOL_SCOPES` all the same.
 */
const WORK_LOOP_UNMIRRORED: Record<string, string> = {
  reportWorkItemImplementation:
    'MOTIR-2421 · Amendment 18 — recording provenance without asserting integration is a ' +
    'CLIENT need, not an agent one: an agent already reports its harness and model through ' +
    '`mark_integrated` when it has a branch, and the per-item-PR path this serves is the ' +
    'CLI runner’s. It takes `mark_integrated`’s scope (the same actor, the same §3 row) ' +
    'without duplicating its tool.',
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. The scope map is MIRRORED, not copied
// ─────────────────────────────────────────────────────────────────────────────

describe('every work-loop operation mirrors its MCP counterpart’s scope', () => {
  const MIRRORS = WORK_LOOP_MIRRORS;

  it('pairs EVERY operation this story declared — or names why it has no tool', () => {
    expect(WORK_LOOP_OPERATIONS.map((op) => op.operationId).sort()).toEqual(
      [...Object.keys(MIRRORS), ...Object.keys(WORK_LOOP_UNMIRRORED)].sort(),
    );
    // …and the story's own audit named ten, plus the one later operation that
    // deliberately has no counterpart. A count that drifted from the plan is
    // worth failing on.
    expect(Object.keys(MIRRORS)).toHaveLength(10);
    expect(WORK_LOOP_OPERATIONS).toHaveLength(11);
  });

  it('an unmirrored operation still needs a REASON, and still mirrors a real scope', () => {
    // The excuse proven against a violation: an empty reason is not a reason,
    // and an unmirrored operation cannot invent a scope of its own either.
    for (const [operationId, reason] of Object.entries(WORK_LOOP_UNMIRRORED)) {
      expect(reason.trim().length, `${operationId} states why it has no tool`).toBeGreaterThan(40);
      const op = WORK_LOOP_OPERATIONS.find((o) => o.operationId === operationId);
      expect(op, `${operationId} is declared`).toBeDefined();
      expect(Object.values(TOOL_SCOPES) as readonly string[]).toContain(op?.scope);
    }
  });

  it.each(Object.entries(MIRRORS))(
    '%s carries the scope `%s` holds in lib/mcp/scopes.ts',
    (operationId, tool) => {
      const op = WORK_LOOP_OPERATIONS.find((o) => o.operationId === operationId);
      expect(op, `${operationId} is declared`).toBeDefined();
      expect(op?.scope).toBe(TOOL_SCOPES[tool]);
    },
  );

  it('ENFORCES the same scope it documents — the route’s argument, not the doc', () => {
    // The document says; the route does. Asserted separately because a docs typo
    // that also changed enforcement would be a privilege bug, which is exactly
    // why the two are independent values.
    for (const file of v1RouteFiles(REPO_ROOT)) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      for (const [method, scope] of declaredScopeByMethod(source)) {
        const path = pathTemplateFor(file);
        if (!WORK_LOOP_PATHS.includes(path)) continue;
        const declared = findV1Operation(method, path);
        expect(declared?.scope, `${method} ${path}`).toBe(scope);
      }
    }
  });

  it('would FAIL if a route and its declaration disagreed', () => {
    // The check, run against a violation: a synthetic route source declaring the
    // wrong scope must not match its operation.
    const synthetic = "export const GET = withV1Route({ scope: 'sprints:write' }, async () => {});";
    const scope = declaredScopeByMethod(synthetic).get('GET');
    expect(scope).toBe('sprints:write');
    expect(findV1Operation('GET', '/api/v1/work-items/{key}/dispatch-prompt')?.scope).not.toBe(
      scope,
    );
  });
});

/** Turn a route FILE path into the OpenAPI path template it serves. */
function pathTemplateFor(routeFile: string): string {
  const segments = routeFile
    .replace(/^app[\\/]/, '')
    .split(/[\\/]/)
    .slice(0, -1)
    .map((segment) => (segment.startsWith('[') ? `{${segment.slice(1, -1)}}` : segment));
  return `/${segments.join('/')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Service → schema → response, per resource
// ─────────────────────────────────────────────────────────────────────────────

describe('service → schema → response, per resource, against real Postgres', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    vi.clearAllMocks();
    caller = await createV1ProjectCaller({
      scopes: ['read', 'work_items:write', 'integration'],
    });
  });

  async function story(title = 'a container') {
    return workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'story', title },
      caller.ctx,
    );
  }

  async function projectContext() {
    const project = await projectsService.getByKey(caller.projectKey, caller.ctx);
    return {
      userId: caller.ctx.userId,
      workspaceId: caller.ctx.workspaceId,
      projectId: project.id,
      project,
    };
  }

  it('the DISPATCH PROMPT maps from the real service output', async () => {
    const item = await story('dispatch me');
    const dto = await dispatchPromptService.getDispatchPrompt(
      caller.fixture.projectId,
      item.identifier,
      caller.ctx,
      {},
    );

    const mapped = presentDispatchPrompt(dto);

    expect(() => dispatchPromptSchema.parse(mapped)).not.toThrow();
    expect(mapped.key).toBe(dto.key);
    expect(mapped.prompt).toBe(dto.prompt);
  });

  it('the INTEGRATION result maps from the real service output', async () => {
    const item = await story('integrate me');
    await workItemsService.updateStatus(item.id, 'in_progress', caller.ctx);
    const dto = await workItemsService.markIntegrated(item.id, 'session/seam', caller.ctx);

    const mapped = presentIntegrationResult(dto);

    expect(() => integrationResultSchema.parse(mapped)).not.toThrow();
    expect(mapped.key).toBe(dto.identifier);
    expect(mapped.sessionBranch).toBe('session/seam');
  });

  it('the SESSION CLOSE-OUT maps from the real service output', async () => {
    const item = await story('close me');
    await workItemsService.updateStatus(item.id, 'in_progress', caller.ctx);
    await workItemsService.markIntegrated(item.id, 'session/seam', caller.ctx);
    const dto = await workItemsService.completeSession('session/seam', caller.ctx);

    const mapped = presentSessionCloseOut(dto);

    expect(() => sessionCloseOutSchema.parse(mapped)).not.toThrow();
    expect(mapped.results.map((r) => r.key)).toEqual(dto.results.map((r) => r.key));
  });

  it('the PLAN and its STATUS map from the real service output', async () => {
    const item = await story('expand me');
    const pctx = await projectContext();
    const submitted = await aiPlanEditsService.submitExpand(item.identifier, pctx);
    await plansService.addProposals(
      submitted.planId,
      [{ op: 'add', proposedFields: { title: 'a proposal', kind: 'subtask' } }],
      caller.ctx,
    );

    const plan = await plansService.getPlan(submitted.planId, caller.ctx);
    const mappedPlan = presentPlan(plan, planTargetKeyResolver({}));
    expect(() => planSchema.parse(mappedPlan)).not.toThrow();
    expect(mappedPlan.proposalCount).toBe(plan.itemCount);

    const outcome = await aiPlanEditsService.getOutcome({ planId: submitted.planId }, caller.ctx);
    const mappedOutcome = presentPlanOutcome(outcome);
    expect(() => planOutcomeSchema.parse(mappedOutcome)).not.toThrow();
    expect(mappedOutcome.proposalCount).toBe(outcome.itemCount);
  });

  it('the PLAN SESSION maps from the real service output', async () => {
    const pctx = await projectContext();
    await planChangeSessionsService.getOrCreateForScope(pctx, buildScope([]));
    const dto = await planChangeSessionsService.appendTurn('a turn', pctx);

    const mapped = presentPlanSession(dto);

    expect(() => planSessionSchema.parse(mapped)).not.toThrow();
    expect(mapped.turns.map((t) => t.body)).toEqual(dto.turns.map((t) => t.body));
  });

  it('the ACTIVITY entry maps from the real service output', async () => {
    const item = await story('talked about');
    await commentsService.addComment(item.id, { bodyMd: 'hello' }, caller.ctx);
    await workItemsService.updateStatus(item.id, 'in_progress', caller.ctx);
    const history = await activityService.listHistory(item.id, {}, caller.ctx);

    expect(history.entries.length).toBeGreaterThan(0);
    for (const entry of history.entries) {
      const mapped = presentActivityChange(entry);
      expect(mapped.id).toBe(entry.id);
      expect(mapped.parts).toHaveLength(entry.parts.length);
    }
  });

  it('the WIDENED work-item shapes map from the real service output', async () => {
    // 11.7.2's three projections, at the same seam as the rest.
    const parent = await story('the parent');
    const child = await workItemsService.createWorkItem(
      {
        projectId: caller.fixture.projectId,
        kind: 'subtask',
        title: 'a child',
        parentId: parent.id,
      },
      caller.ctx,
    );
    const detail = await workItemsService.getIssueDetail(
      caller.fixture.projectId,
      parent.identifier,
      caller.ctx,
    );
    const edges = await workItemsService.getDependencyEdgesForItems([child.id], caller.ctx);

    const { presentWorkItemDetail } = await import('@/lib/api/v1/workItems/schema');
    const mapped = presentWorkItemDetail(detail, 0, edges);

    expect(() => workItemDetailSchema.parse(mapped)).not.toThrow();
    expect(mapped.children[0]?.dependencies).toEqual({ blockedBy: [], blocks: [] });
    expect(() => readinessSchema.parse(mapped.readiness)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Error totality — driven, not inspected
// ─────────────────────────────────────────────────────────────────────────────

describe('every error these services raise resolves to a deliberate v1 status', () => {
  it.each([
    ['motir-ai unreachable', new MotirAiUnavailableError('connect ECONNREFUSED'), 503],
    ['credits exhausted', new MotirAiOutOfCreditsError('balance 0'), 402],
    ['a turn conflict', new PlanChangeTurnConflictError('sess_1', 3), 409],
    ['an empty thread', new EmptyPlanChangeIntentError('nothing to send'), 422],
    ['too many targets', new TooManyPlanChangeTargetsError(21, 20), 422],
  ])('%s → %i, through the real classifier', (_label, error, status) => {
    // Driven through `classifyApiV1Error` — the function the wrapper actually
    // calls — rather than read off the map, so a code that stopped matching its
    // error class would fail here.
    const classified = classifyApiV1Error(error);
    expect(classified?.status).toBe(status);
    expect(typeof classified?.body.code).toBe('string');
    expect(typeof classified?.body.error).toBe('string');
  });

  it('leaves an UNMAPPED motir-ai fault as a bare 500 — no code on the wire', () => {
    // The deliberate ABSENCE, held by a test: our own bad request to motir-ai is
    // our bug, and §4's 500 carries no `code` to branch on.
    expect(DOMAIN_ERROR_STATUS['MOTIR_AI_BAD_REQUEST']).toBeUndefined();
    expect(classifyApiV1Error({ code: 'MOTIR_AI_BAD_REQUEST', message: 'x' })).toBeUndefined();
  });

  it('every status these operations DECLARE is one the vocabulary documents', () => {
    const declared = new Set(WORK_LOOP_OPERATIONS.flatMap((op) => op.errorStatuses));
    for (const status of declared) {
      expect(
        Object.values(DOMAIN_ERROR_STATUS).includes(status) ||
          [401, 403, 429, 500].includes(status),
        `status ${status} is reachable`,
      ).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3b. Paging — every NEW collection, walked to exhaustion
// ─────────────────────────────────────────────────────────────────────────────

describe('every collection this story added pages to exhaustion exactly once', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    caller = await createV1ProjectCaller({ scopes: ['read'] });
  });

  // The activity read is the ONLY new collection here — every other work-loop
  // endpoint returns a single object or a job handle. Its THREE views each page
  // over a different source, so each is walked separately: a walk of `all` alone
  // would leave the two narrow cursors untested.
  it.each(['all', 'comments', 'history'] as const)(
    'the `%s` view returns every row exactly once',
    async (view) => {
      const { GET } = await import('@/app/api/v1/work-items/[key]/activity/route');
      const item = await workItemsService.createWorkItem(
        { projectId: caller.fixture.projectId, kind: 'task', title: 'a paged item' },
        caller.ctx,
      );
      for (let i = 0; i < 25; i += 1) {
        await commentsService.addComment(item.id, { bodyMd: `c${i}` }, caller.ctx);
      }
      // Past the change trail's own page size too, so `history` really pages.
      for (let i = 0; i < 13; i += 1) {
        await workItemsService.updateStatus(item.id, 'in_progress', caller.ctx);
        await workItemsService.updateStatus(item.id, 'todo', caller.ctx);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string =
          `?view=${view}` + (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
        const res: Response = await GET(
          new Request(
            `http://localhost:3000/api/v1/work-items/${item.identifier}/activity${query}`,
            {
              headers: caller.headers,
            },
          ),
          { params: Promise.resolve({ key: item.identifier }) },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          items: { type: string; comment?: { id: string }; change?: { id: string } }[];
          nextCursor: string | null;
        };
        for (const entry of body.items) {
          seen.push(entry.type === 'comment' ? `c:${entry.comment?.id}` : `h:${entry.change?.id}`);
        }
        cursor = body.nextCursor;
        pages += 1;
        expect(pages, 'the walk terminates').toBeLessThan(40);
      } while (cursor !== null);

      // More than one page really happened — an exhaustion test over a single
      // page proves nothing about the cursor.
      expect(pages).toBeGreaterThan(1);
      expect(new Set(seen).size).toBe(seen.length);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The five contract guards, each proven against a violation
// ─────────────────────────────────────────────────────────────────────────────

describe('the contract guards, and each one proven to FAIL', () => {
  /** Only this story's route files. */
  function workLoopRouteFiles(): string[] {
    return v1RouteFiles(REPO_ROOT).filter((file) =>
      WORK_LOOP_PATHS.includes(pathTemplateFor(file)),
    );
  }

  it('found this story’s routes at all — the walk is not vacuously empty', () => {
    expect(workLoopRouteFiles()).toHaveLength(WORK_LOOP_PATHS.length);
  });

  it('GUARD 1 — no work-loop route imports from lib/mcp/', () => {
    const found = workLoopRouteFiles().flatMap((file) =>
      auditV1RouteSource(file, readRouteSource(REPO_ROOT, file)),
    );
    expect(found.filter((v) => v.rule === 'imports-mcp-tools')).toEqual([]);
    // …and the audit finds NOTHING else wrong with them either.
    expect(found, JSON.stringify(found)).toEqual([]);
  });

  it('GUARD 1 FAILS on a route that reaches into the tool layer', () => {
    const found = auditV1RouteSource(
      'app/api/v1/fake/route.ts',
      "import { runGetPlan } from '@/lib/mcp/tools/getPlan';\n" +
        "export const GET = withV1Route({ scope: 'read' }, async () => {});",
    );
    expect(found.map((v) => v.rule)).toContain('imports-mcp-tools');
  });

  it('GUARD 2 — no work-loop route calls Prisma or opens a transaction', () => {
    // Through the SHIPPED audit, not a hand-rolled regex: it strips comments and
    // strings first, so a route whose prose mentions a transaction is not a
    // violation and a route that opens one is. Re-deriving that here would be
    // hand-rolling a check the code already provides — and getting it wrong in
    // exactly the way a raw regex over raw source gets it wrong.
    const found = workLoopRouteFiles().flatMap((file) =>
      auditV1RouteSource(file, readRouteSource(REPO_ROOT, file)),
    );
    expect(found.filter((v) => v.rule === 'prisma-in-route')).toEqual([]);
    expect(found.filter((v) => v.rule === 'transaction-in-route')).toEqual([]);
  });

  it('GUARD 2 FAILS on a route that opens one', () => {
    const found = auditV1RouteSource(
      'app/api/v1/fake/route.ts',
      "export const GET = withV1Route({ scope: 'read' }, async () => {\n" +
        '  await db.$transaction(async () => {});\n});',
    );
    expect(found.length).toBeGreaterThan(0);
  });

  it('GUARD 3 — every work-loop route method has an operation declaration', () => {
    for (const file of workLoopRouteFiles()) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      const path = pathTemplateFor(file);
      const methods = [...declaredScopeByMethod(source).keys()];
      expect(methods.length, `${file} exports a verb`).toBeGreaterThan(0);
      for (const method of methods) {
        expect(findV1Operation(method, path), `${method} ${path} undocumented`).toBeDefined();
      }
    }
  });

  it('GUARD 3 FAILS for a method the registry does not declare', () => {
    expect(findV1Operation('DELETE', '/api/v1/work-items/{key}/dispatch-prompt')).toBeUndefined();
  });

  it('GUARD 4 — every MCP tool this story mirrors is STILL REGISTERED, under the same scope', () => {
    // "Agents keep MCP", as a property that holds at any commit.
    //
    // ⚠️ This was first written as `git diff --name-only <merge-base> -- tests/mcp`,
    // and that was WRONG — not weak, wrong: the CI checkout is shallow and has
    // no `origin/main`, so the guard threw on every run while passing locally. A
    // check that only works in the author's worktree is worse than none, because
    // it reads as coverage. "The diff does not touch these files" is a REVIEW
    // property the pull request shows; what a test can hold is the property that
    // diff was standing in for — the tools are still there, still named the
    // same, and still gated the same.
    //
    // The other two halves are held elsewhere and together they are stronger
    // than the diff was: the shipped `tests/mcp/` suites run in this same CI and
    // prove the tools still BEHAVE identically, and GUARD 1 proves no v1 route
    // reaches into the tool layer to make that true.
    const registered = new Set<string>(MCP_TOOL_NAMES);
    for (const [operationId, tool] of Object.entries(WORK_LOOP_MIRRORS)) {
      expect(registered, `${tool} (mirrored by ${operationId})`).toContain(tool);
      // …and gated exactly as it was: v1 MIRRORS this entry, so a change here
      // would silently move the public API's gate too.
      expect(TOOL_SCOPES[tool], `${tool}'s scope`).toBeDefined();
    }
  });

  it('GUARD 4 FAILS on a tool that left the registry', () => {
    // The check, run against a violation: a registry missing one of the ten
    // must not satisfy it.
    const withoutOne = new Set<string>(MCP_TOOL_NAMES);
    withoutOne.delete('dispatch_prompt');
    expect(withoutOne.has('dispatch_prompt')).toBe(false);
    expect(new Set<string>(MCP_TOOL_NAMES).has('dispatch_prompt')).toBe(true);
  });

  it('GUARD 5 — no published field was removed or retyped by the widenings', () => {
    // §8 is additive-only, and 11.7.2 widened three SHIPPED shapes. Every field
    // that was on them before is still there, with the same optionality.
    const summaryKeys = Object.keys(workItemSummarySchema.shape);
    for (const field of [
      'key',
      'kind',
      'type',
      'title',
      'status',
      'priority',
      'assigneeId',
      'reporterId',
      'dueDate',
      'estimateMinutes',
      'storyPoints',
      'createdAt',
      'updatedAt',
    ]) {
      expect(summaryKeys, `workItemSummarySchema.${field}`).toContain(field);
    }
    // The addition, and ONLY the addition.
    expect(summaryKeys).toContain('dependencies');

    const readinessKeys = Object.keys(readinessSchema.shape);
    expect(readinessKeys).toContain('ready');
    expect(readinessKeys).toContain('openBlockers');
    // ⚠️ The published field the title arrived BESIDE, never instead of.
    expect(readinessKeys).toContain('blockedByAncestorKey');
    expect(readinessKeys).toContain('blockedByAncestorTitle');

    const detailKeys = Object.keys(workItemDetailSchema.shape);
    for (const field of ['descriptionMd', 'parentKey', 'ancestorKeys', 'children', 'links']) {
      expect(detailKeys, `workItemDetailSchema.${field}`).toContain(field);
    }
    // …and the detail did NOT quietly inherit a second edge block beside `links`.
    expect(detailKeys).not.toContain('dependencies');
  });

  it('GUARD 5 FAILS on a schema that dropped a published field', () => {
    const dropped = workItemSummarySchema.omit({ storyPoints: true });
    expect(Object.keys(dropped.shape)).not.toContain('storyPoints');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The registry stays coherent as the story lands
// ─────────────────────────────────────────────────────────────────────────────

describe('the merged operation registry', () => {
  it('declares each work-loop operation exactly once', () => {
    const keys = WORK_LOOP_OPERATIONS.map(operationKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every work-loop operation a UNIQUE operationId across the whole API', () => {
    // A code generator names its methods after these.
    const all = V1_OPERATIONS.map((op) => op.operationId);
    expect(new Set(all).size).toBe(all.length);
  });

  it('gates every work-loop operation on a REAL scope', () => {
    const scopes: readonly TokenScope[] = Object.values(TOOL_SCOPES);
    for (const op of WORK_LOOP_OPERATIONS) {
      expect(scopes, `${op.operationId}`).toContain(op.scope);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The mapper branches a happy path never reaches
// ─────────────────────────────────────────────────────────────────────────────

describe('the mappers’ unreached branches', () => {
  it('resolves a plan target through its THREE ref states', () => {
    const resolve = planTargetKeyResolver({
      known: { accessible: true, identifier: 'PROD-7' },
      // Exists, in a project this caller may not browse — the arm a route-level
      // closure would leave untested, and the one that must NOT leak the id.
      hidden: { accessible: false },
    });

    expect(resolve('known')).toBe('PROD-7');
    expect(resolve('hidden')).toBeUndefined();
    expect(resolve('deleted')).toBeUndefined();
  });

  it('renders every activity VALUE type, named and unnamed', () => {
    const mapped = presentActivityChange({
      id: 'rev',
      changeKind: 'updated',
      changedAt: '2026-08-05T00:00:00.000Z',
      actor: { userId: 'u1', name: null },
      parts: [
        {
          kind: 'field',
          field: 'dueDate',
          from: { type: 'none' },
          to: { type: 'date', date: '2026-09-01' },
        },
        {
          kind: 'field',
          field: 'sprint',
          from: { type: 'sprint', sprintId: 's1', name: 'Sprint 1' },
          to: { type: 'sprint', sprintId: 's2', name: null },
        },
        {
          kind: 'field',
          field: 'assignee',
          from: { type: 'user', userId: 'u1', name: 'Yue' },
          to: { type: 'user', userId: 'u2', name: null },
        },
        {
          kind: 'field',
          field: 'status',
          from: { type: 'status', key: 'todo', label: 'To Do' },
          to: { type: 'status', key: 'done', label: null },
        },
      ],
    });

    expect(mapped.parts).toEqual([
      {
        kind: 'field',
        field: 'dueDate',
        from: { type: 'none' },
        to: { type: 'date', date: '2026-09-01' },
      },
      {
        kind: 'field',
        field: 'sprint',
        from: { type: 'sprint', sprintId: 's1', name: 'Sprint 1' },
        to: { type: 'sprint', sprintId: 's2', name: null },
      },
      {
        kind: 'field',
        field: 'assignee',
        from: { type: 'user', userId: 'u1', name: 'Yue' },
        to: { type: 'user', userId: 'u2', name: null },
      },
      {
        kind: 'field',
        field: 'status',
        from: { type: 'status', key: 'todo', label: 'To Do' },
        to: { type: 'status', key: 'done', label: null },
      },
    ]);
  });

  it('handles a `collection` part with a REMOVED op and no items', () => {
    const mapped = presentActivityChange({
      id: 'rev',
      changeKind: 'updated',
      changedAt: '2026-08-05T00:00:00.000Z',
      actor: { userId: 'u1', name: 'Yue' },
      parts: [
        { kind: 'collection', field: 'labels', op: 'removed', items: undefined },
        { kind: 'link', op: 'removed', linkKind: 'blocks', target: { type: 'issue' } },
        { kind: 'commentDeleted', author: { type: 'user', userId: 'u1' } },
      ],
    });

    expect(mapped.parts[0]).toEqual({
      kind: 'collection',
      field: 'labels',
      op: 'removed',
      items: [],
    });
    expect(mapped.parts[1]).toEqual({
      kind: 'link',
      op: 'removed',
      linkKind: 'blocks',
      target: { type: 'issue', workItemKey: null },
    });
    expect(mapped.parts[2]).toEqual({
      kind: 'commentDeleted',
      author: { type: 'user', userId: 'u1', name: null },
      replyCount: 0,
    });
  });
});
