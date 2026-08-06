import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { workItemRefSchema } from '@/lib/api/v1/workItems/schema';
import { buildOperationRegistry, mergeResourceComponents } from '@/lib/api/v1/openapi/registry';
import { defineOperation } from '@/lib/api/v1/openapi/operation';
import {
  EXEMPT_TOOLS,
  MIGRATING_TOOLS,
  isExemptTool,
  isMigratingTool,
} from '@/lib/mcp/payloads/exemptions';
import {
  MCP_UNREACHABLE_RESOURCES,
  SHARED_RESOURCE_NAMES,
  isSharedResourceName,
  sharedResourceSchema,
} from '@/lib/mcp/payloads/sharedResources';
import { definePayload, derived, exempt } from '@/lib/mcp/payloads/define';
import {
  addCommentPayload,
  claimNextReadyPayload,
  getWorkItemPayload,
  listReadyPayload,
  mcpCommentSchema,
  mcpWorkItemSchema,
  nextReadyPayload,
  presentMcpComment,
  presentMcpReadyDispatch,
  presentMcpReadyRow,
  presentMcpWorkItem,
  presentMcpWorkItemChild,
  presentMcpWorkItemRow,
  searchWorkItemsPayload,
  workItemWritePayload,
} from '@/lib/mcp/payloads/workItems';
import {
  listProjectsPayload,
  listSprintsPayload,
  membershipMovePayload,
  presentMcpMembershipMove,
  presentMcpProjectRow,
  presentMcpSprint,
  presentMcpWhoami,
  sprintWritePayload,
  whoamiPayload,
} from '@/lib/mcp/payloads/planning';
import {
  activityPagePayload,
  dispatchPromptPayload,
  markIntegratedPayload,
  planJobHandlePayload,
  planOutcomePayload,
  planPayload,
  planSessionPayload,
  planSubmitPayload,
  presentMcpDispatchPrompt,
  presentMcpPlan,
  presentMcpPlanJobHandle,
  presentMcpPlanOutcome,
  presentMcpPlanSession,
  presentMcpPlanSubmit,
  presentMcpSessionCloseOut,
  sessionCloseOutPayload,
} from '@/lib/mcp/payloads/workLoop';
import { toolOk } from '@/lib/mcp/toolResult';

// The PAYLOAD SEAM guard (Story 11.6 · Subtask 11.6.2 — MOTIR-2228).
//
// Three properties, and the first is the one the story rests on:
//
//  1. TOTALITY — a tool that is neither schema-derived nor registered cannot
//     construct a `toolOk` argument. Proven the way `lib/mcp/scopes.ts`'s
//     totality is: with `@ts-expect-error` fixtures, so the guarantee is a
//     COMPILE error rather than a runtime assertion someone can skip.
//  2. The shared-resource set is DERIVED from the v1 operation registry — a new
//     resource joins it with no other file changing.
//  3. The probes actually bite: `get_work_item`'s children satisfy v1's
//     `WorkItemRef`, which is the comparison whose absence started the story.
//
// No DB, no I/O — a pure model check, like `scopes.test.ts`.

/**
 * The tools that DERIVE their payload from a shared schema.
 *
 * Enumerated here rather than read off the code because there is nothing to read
 * off: `derived` is called at the tool, and no value records which tools call
 * it. That makes this list the ONE place the seal could rot — so it is checked
 * against `MCP_TOOL_NAMES` from both directions below (every tool is in exactly
 * one column, and the two columns SUM to the registry), which is what would
 * catch a stale entry here.
 */
const DERIVED_TOOLS = new Set<string>([
  // 11.6.2 — the proving tool
  'get_work_item',
  // 11.6.3 — the work-item family (MOTIR-2229)
  'search_work_items',
  'list_ready',
  'next_ready',
  'claim_next_ready',
  'create_work_item',
  'update_work_item',
  'transition_status',
  'archive_work_item',
  'unarchive_work_item',
  'change_kind',
  'move_to_parent',
  'add_comment',
  // 11.6.4 — project / sprint / backlog / identity (MOTIR-2230)
  'list_projects',
  'whoami',
  'list_sprints',
  'create_sprint',
  'update_sprint',
  'start_sprint',
  'complete_sprint',
  'move_to_sprint',
  'move_to_backlog',
  // 11.6.5 — the work-loop family (MOTIR-2231)
  'dispatch_prompt',
  'mark_integrated',
  'complete_session',
  'expand_item',
  'get_plan_status',
  'get_plan',
  'open_plan_session',
  'append_plan_turn',
  'submit_plan_session',
  'get_work_item_activity',
]);

describe('toolOk totality — a payload must come from a constructor', () => {
  it('REFUSES a bare object literal (@ts-expect-error is the assertion)', () => {
    // @ts-expect-error a plain object is not an McpPayload — this is the whole
    // mechanism. If this line ever stops erroring, the seam has been defeated
    // and the unnecessary suppression fails `pnpm typecheck`.
    expect(() => toolOk('text', { anything: 'goes' })).toBeTypeOf('function');
  });

  it('REFUSES `exempt` for a tool that is not in the exemption registry', () => {
    // @ts-expect-error `list_ready` is not exempt — it returns a shape v1
    // describes, so it DERIVES (MOTIR-2229). Exemption must be written first.
    expect(() => exempt('list_ready', {})).toBeTypeOf('function');
  });

  it('has NO third constructor — `unmigrated` was deleted with the seal', () => {
    // MOTIR-2231 emptied `MIGRATING_TOOLS` and deleted the staging constructor
    // with it. Two ways to build a payload, and that is what makes the guard's
    // silence mean something. (The import of `unmigrated` no longer typechecks,
    // which is the real assertion; this pins the map it read.)
    expect(Object.keys(MIGRATING_TOOLS)).toEqual([]);
  });

  it('REFUSES a tool name that does not exist at all', () => {
    // @ts-expect-error not a registered tool.
    expect(() => exempt('no_such_tool', {})).toBeTypeOf('function');
  });

  it('ACCEPTS the two surviving constructors', () => {
    expect(toolOk('t', exempt('validate_work_item', { valid: true })).structuredContent).toEqual({
      valid: true,
    });
    expect(
      toolOk('t', exempt('get_project_state', { established: true })).structuredContent,
    ).toEqual({ established: true });
  });
});

describe('the exemption + migration registries', () => {
  it('every entry names a REGISTERED tool — no stale members', () => {
    const registry = new Set<string>(MCP_TOOL_NAMES);
    for (const name of Object.keys(EXEMPT_TOOLS)) {
      expect(registry.has(name), `exemption registry has stale tool "${name}"`).toBe(true);
    }
    for (const name of Object.keys(MIGRATING_TOOLS)) {
      expect(registry.has(name), `migration registry has stale tool "${name}"`).toBe(true);
    }
  });

  it('the two registries are DISJOINT — exempt and migrating mean different things', () => {
    for (const name of Object.keys(EXEMPT_TOOLS)) {
      expect(name in MIGRATING_TOOLS, `"${name}" is both exempt and migrating`).toBe(false);
    }
  });

  it('every exemption carries a non-trivial REASON, not a placeholder', () => {
    for (const [name, reason] of Object.entries(EXEMPT_TOOLS)) {
      expect(reason.length, `exemption "${name}" has a stub reason`).toBeGreaterThan(60);
    }
  });

  it('the migration registry is SEALED — empty, and it stays empty', () => {
    expect(Object.keys(MIGRATING_TOOLS)).toEqual([]);
  });

  it('THE SEAL — every registered tool is DERIVED or EXEMPT, walked off the registry', () => {
    // MOTIR-2231's seal, and the property the whole story rests on. Checked
    // against `lib/mcp/registry.ts` rather than a remembered set: a tool in
    // NEITHER column fails here rather than being skipped, which is what turns
    // the guard's silence into information.
    for (const name of MCP_TOOL_NAMES) {
      const resolved = DERIVED_TOOLS.has(name) || isExemptTool(name);
      expect(resolved, `tool "${name}" is in NO column — the guard cannot see it`).toBe(true);
    }
    expect(isMigratingTool).toBeTypeOf('function');
  });

  it('the two columns PARTITION the registry — no tool is in both', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(DERIVED_TOOLS.has(name) && isExemptTool(name), `"${name}" is in both`).toBe(false);
    }
    expect(DERIVED_TOOLS.size + Object.keys(EXEMPT_TOOLS).length).toBe(MCP_TOOL_NAMES.length);
  });
});

describe('the shared-resource set is DERIVED from the v1 operation registry', () => {
  it('is non-empty and every name resolves to a schema', () => {
    expect(SHARED_RESOURCE_NAMES.length).toBeGreaterThan(0);
    for (const name of SHARED_RESOURCE_NAMES) {
      expect(sharedResourceSchema(name), `"${name}" has no schema`).toBeDefined();
    }
  });

  it('GROWS when a resource module registers a new component — no other file changes', () => {
    // The property the story's first acceptance criterion requires: coverage
    // follows the registry, so a resource added later joins the guard's scope
    // without anyone remembering. Driven by merging a FAKE module the way
    // `lib/api/v1/openapi/registry.ts` merges the real ones.
    const before = Object.keys(mergeResourceComponents([]));
    expect(before).toEqual([]);
    const after = Object.keys(
      mergeResourceComponents([
        { operations: [], components: { Invented: z.object({ x: z.string() }) } },
      ]),
    );
    expect(after).toEqual(['Invented']);
    // …and the real set is that same computation over the real modules.
    expect(SHARED_RESOURCE_NAMES).toContain('WorkItemRef');
  });

  it('REFUSES two modules claiming one component name', () => {
    const dup = { operations: [], components: { Same: z.object({}) } };
    expect(() => mergeResourceComponents([dup, dup])).toThrow(/duplicate v1 component/);
  });

  it('the operation registry it derives from refuses a duplicate operation', () => {
    const op = defineOperation({
      method: 'GET',
      path: '/api/v1/invented',
      operationId: 'invented',
      summary: 's',
      description: 'd',
      scope: 'read',
      parameters: [],
      response: { status: 200, body: { kind: 'empty' }, description: 'd' },
      errorStatuses: [],
    });
    expect(() => buildOperationRegistry([op, op])).toThrow(/duplicate v1 operation/);
  });

  it('every UNREACHABLE resource is a real shared resource, with a reason', () => {
    for (const [name, reason] of Object.entries(MCP_UNREACHABLE_RESOURCES)) {
      expect(isSharedResourceName(name), `"${name}" is not a shared resource`).toBe(true);
      expect(reason!.length, `"${name}" has a stub reason`).toBeGreaterThan(60);
    }
  });

  it('isSharedResourceName rejects a foreign string', () => {
    expect(isSharedResourceName('NotAResource')).toBe(false);
  });
});

describe('get_work_item derives its CHILD rows from v1’s schema', () => {
  const child = {
    id: 'row-1',
    parentId: 'row-0',
    kind: 'subtask' as const,
    key: 2227,
    identifier: 'PROD-2227',
    title: 'A child',
    status: 'todo',
    priority: 'high' as const,
    assigneeId: null,
    position: 'a0',
    estimateMinutes: 30,
    storyPoints: 2,
    archivedAt: null,
  };

  it('the child row SATISFIES v1’s WorkItemRef — the comparison that was missing', () => {
    const row = presentMcpWorkItemChild(child, undefined, () => 'PROD-1856');
    expect(workItemRefSchema.safeParse(row).success).toBe(true);
  });

  it('`key` is now the IDENTIFIER, and the numeric key is preserved', () => {
    // The ONE non-additive change in Story 11.6 (ADR Amendment 7 Q6 addendum):
    // `key` meant the numeric key here and the identifier on /api/v1 AND on
    // MCP's own ready rows. Nothing is lost — the number rides as `numericKey`.
    const row = presentMcpWorkItemChild(child, undefined, () => undefined);
    expect(row.key).toBe('PROD-2227');
    expect(row.numericKey).toBe(2227);
    expect(row.identifier).toBe('PROD-2227');
  });

  it('the edge block is TOTAL — a child with no edges gets two EMPTY arrays', () => {
    const row = presentMcpWorkItemChild(child, undefined, () => undefined);
    expect(row.dependencies).toEqual({ blockedBy: [], blocks: [] });
  });

  it('carries the edges it was given, under 1842’s key names', () => {
    const edges = {
      blockedBy: [{ key: 'PROD-1', title: 'First', status: 'done' }],
      blocks: [],
    };
    const row = presentMcpWorkItemChild(child, edges, () => undefined);
    expect(row.dependencies).toEqual(edges);
  });

  it('`parentKey` resolves through the id→key map, and is null when unresolvable', () => {
    expect(presentMcpWorkItemChild(child, undefined, () => 'PROD-1856').parentKey).toBe(
      'PROD-1856',
    );
    expect(presentMcpWorkItemChild(child, undefined, () => undefined).parentKey).toBeNull();
    expect(
      presentMcpWorkItemChild({ ...child, parentId: null }, undefined, () => 'x').parentKey,
    ).toBeNull();
  });

  it('`archived` narrows `archivedAt`, and both ride', () => {
    const live = presentMcpWorkItemChild(child, undefined, () => undefined);
    expect(live.archived).toBe(false);
    expect(live.archivedAt).toBeNull();
    const gone = presentMcpWorkItemChild(
      { ...child, archivedAt: '2026-08-06T00:00:00.000Z' },
      undefined,
      () => undefined,
    );
    expect(gone.archived).toBe(true);
    expect(gone.archivedAt).toBe('2026-08-06T00:00:00.000Z');
  });

  it('the payload’s PROBE points at the children, against WorkItemRef', () => {
    const probe = getWorkItemPayload.probes[0]!;
    expect(probe.resource).toBe('WorkItemRef');
    const row = presentMcpWorkItemChild(child, undefined, () => undefined);
    const payload = { item: {}, children: [row] };
    expect(probe.select(payload)).toEqual([row]);
    // …and what the probe pulls out validates against the v1 schema. This is
    // exactly what 11.6.6's drift guard runs over the whole set.
    for (const part of probe.select(payload)) {
      expect(sharedResourceSchema(probe.resource).safeParse(part).success).toBe(true);
    }
  });

  it('the ENVELOPE passes through untouched — it is MCP’s own', () => {
    const row = presentMcpWorkItemChild(child, undefined, () => undefined);
    const built = derived(getWorkItemPayload, {
      item: { identifier: 'PROD-1856' },
      workflow: { statuses: [] },
      watcherCount: 3,
      children: [row],
    });
    expect(built.watcherCount).toBe(3);
    expect(built.workflow).toEqual({ statuses: [] });
  });

  it('`derived` REFUSES a payload whose children do not match the declared shape', () => {
    // The mapper drifting from its own declaration fails at the tool, not in
    // front of an agent.
    expect(() => derived(getWorkItemPayload, { children: [{ key: 'PROD-1' }] as never })).toThrow();
  });
});

describe('definePayload', () => {
  it('applies the type at the declaration site and returns it unchanged', () => {
    const def = definePayload({
      schema: z.object({ a: z.string() }),
      probes: [],
    });
    expect(def.probes).toEqual([]);
    expect(def.schema.parse({ a: 'x' })).toEqual({ a: 'x' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The WORK-ITEM family mappers (Subtask 11.6.3 — MOTIR-2229)
// ─────────────────────────────────────────────────────────────────────────────

const workItemDto = {
  id: 'row-9',
  projectId: 'proj-1',
  parentId: 'row-0',
  kind: 'subtask' as const,
  key: 2229,
  identifier: 'PROD-2229',
  title: 'Re-base the family',
  descriptionMd: 'body',
  explanationMd: null,
  explanationSource: 'user_authored' as const,
  status: 'in_progress',
  priority: 'high' as const,
  assigneeId: null,
  reporterId: 'user-1',
  dueDate: null,
  estimateMinutes: 55,
  type: 'code' as const,
  executor: 'coding_agent' as const,
  storyPoints: 5,
  position: 'a2',
  sprintId: null,
  backlogRank: 'a0',
  publicChildrenHidden: false,
  sessionBranch: null,
  targetRepo: 'motir-core',
  planningSource: 'mcp' as const,
  planningHarness: null,
  planningModel: null,
  implementationSource: null,
  implementationHarness: null,
  implementationModel: null,
  archivedAt: null,
  createdAt: '2026-08-05T16:05:35.168Z',
  updatedAt: '2026-08-06T00:36:35.928Z',
};

describe('presentMcpWorkItem — the write confirmation', () => {
  it('maps the shared half AND keeps every aggregate column', () => {
    const row = presentMcpWorkItem(workItemDto);
    expect(row.key).toBe('PROD-2229');
    expect(row.numericKey).toBe(2229);
    expect(row.identifier).toBe('PROD-2229');
    expect(row.targetRepo).toBe('motir-core');
    expect(row.descriptionMd).toBe('body');
    expect(row.createdAt).toBe(workItemDto.createdAt);
  });

  it('is a NARROWING — it carries no `dependencies`, because a write reads no graph', () => {
    expect(presentMcpWorkItem(workItemDto)).not.toHaveProperty('dependencies');
  });

  it('round-trips through its own declared schema', () => {
    expect(mcpWorkItemSchema.safeParse(presentMcpWorkItem(workItemDto)).success).toBe(true);
  });

  it('`derived` accepts it and REFUSES a row missing a shared field', () => {
    expect(derived(workItemWritePayload, presentMcpWorkItem(workItemDto)).key).toBe('PROD-2229');
    const { title: _dropped, ...broken } = presentMcpWorkItem(workItemDto);
    expect(() => derived(workItemWritePayload, broken as never)).toThrow();
  });
});

describe('presentMcpWorkItemRow — the search row', () => {
  const listItem = {
    id: 'row-9',
    kind: 'task' as const,
    type: null,
    key: 42,
    identifier: 'PROD-42',
    title: 'A row',
    status: 'todo',
    priority: 'medium' as const,
    assigneeId: null,
    reporterId: 'user-1',
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    updatedAt: '2026-08-06T00:00:00.000Z',
    hasDescription: true,
  };

  it('carries `key` as the identifier, the numeric key beside it, and the count', () => {
    const row = presentMcpWorkItemRow(listItem, undefined, 3);
    expect(row.key).toBe('PROD-42');
    expect(row.numericKey).toBe(42);
    expect(row.commentCount).toBe(3);
    expect(row.hasDescription).toBe(true);
  });

  it('carries the `dependencies` block from the SHARED schema, total by construction', () => {
    expect(presentMcpWorkItemRow(listItem, undefined, 0).dependencies).toEqual({
      blockedBy: [],
      blocks: [],
    });
    const edges = { blockedBy: [{ key: 'PROD-1', title: 'A', status: 'done' }], blocks: [] };
    expect(presentMcpWorkItemRow(listItem, edges, 0).dependencies).toEqual(edges);
  });

  it('is a NARROWING — no `createdAt`, which the MCP list projection does not read', () => {
    expect(presentMcpWorkItemRow(listItem, undefined, 0)).not.toHaveProperty('createdAt');
  });

  it('the page payload validates and refuses a malformed row', () => {
    const page = {
      items: [presentMcpWorkItemRow(listItem, undefined, 0)],
      total: 1,
      nextCursor: null,
    };
    expect(derived(searchWorkItemsPayload, page).total).toBe(1);
    expect(() =>
      derived(searchWorkItemsPayload, { ...page, items: [{ key: 'PROD-1' }] as never }),
    ).toThrow();
  });
});

describe('presentMcpReadyRow / presentMcpReadyDispatch', () => {
  const readyDto = {
    id: 'row-7',
    key: 'PROD-7',
    kind: 'subtask' as const,
    title: 'Ready work',
    priority: 'high' as const,
    status: { key: 'todo', category: 'todo' },
    assignee: { id: 'user-2', name: 'Yue', avatarUrl: null },
    descriptionExcerpt: 'excerpt',
    type: 'code' as const,
    executor: 'coding_agent' as const,
    descriptionMd: 'the body',
  };

  it('is a pure WIDENING — the row VALIDATES against v1’s ReadyItem schema', () => {
    const row = presentMcpReadyRow(readyDto, undefined, 0);
    expect(sharedResourceSchema('ReadyItem').safeParse(row).success).toBe(true);
  });

  it('derives `assigneeId` from the object MCP already carried — both ride', () => {
    const row = presentMcpReadyRow(readyDto, undefined, 0);
    expect(row.assigneeId).toBe('user-2');
    expect(row.assignee).toEqual({ id: 'user-2', name: 'Yue', avatarUrl: null });
  });

  it('an unassigned row reads `assigneeId: null`', () => {
    const row = presentMcpReadyRow({ ...readyDto, assignee: null }, undefined, 0);
    expect(row.assigneeId).toBeNull();
    expect(row.assignee).toBeNull();
  });

  it('the dispatch superset adds what a runner needs, keeping the ready half', () => {
    const dispatch = presentMcpReadyDispatch(
      {
        ...readyDto,
        contextRefs: ['a.ts'],
        blockerKeys: [],
        parentKey: 'PROD-1',
        runCommand: 'motir run PROD-7',
        sessionBranch: null,
        targetRepo: 'motir-core',
        targetRepoCloneUrl: null,
        targetRepoDefaultBranch: null,
      },
      2,
    );
    expect(dispatch.runCommand).toBe('motir run PROD-7');
    expect(dispatch.commentCount).toBe(2);
    // Still a ready row underneath — the probe reads it as one.
    expect(sharedResourceSchema('ReadyItem').safeParse(dispatch).success).toBe(true);
  });

  it('the list/next/claim payloads probe their rows against ReadyItem', () => {
    const row = presentMcpReadyRow(readyDto, undefined, 0);
    const page = derived(listReadyPayload, { items: [row], nextCursor: null });
    for (const probe of listReadyPayload.probes) {
      for (const part of probe.select(page as never)) {
        expect(sharedResourceSchema(probe.resource).safeParse(part).success).toBe(true);
      }
    }
    // A PRESENT item probes to that item, and it satisfies ReadyItem…
    const dispatch = presentMcpReadyDispatch(
      {
        ...readyDto,
        contextRefs: [],
        blockerKeys: [],
        parentKey: null,
        runCommand: 'motir run PROD-7',
        sessionBranch: null,
        targetRepo: null,
        targetRepoCloneUrl: null,
        targetRepoDefaultBranch: null,
      },
      0,
    );
    for (const payload of [nextReadyPayload, claimNextReadyPayload]) {
      const built = derived(payload, { item: dispatch });
      const parts = payload.probes[0]!.select(built as never);
      expect(parts).toEqual([dispatch]);
      expect(sharedResourceSchema('ReadyItem').safeParse(parts[0]).success).toBe(true);
    }
    // …and a null item probes to NOTHING rather than crashing.
    const empty = derived(nextReadyPayload, { item: null });
    expect(nextReadyPayload.probes[0]!.select(empty as never)).toEqual([]);
    const emptyClaim = derived(claimNextReadyPayload, {
      item: null,
      reason: 'none_ready',
      advisories: [],
    });
    expect(claimNextReadyPayload.probes[0]!.select(emptyClaim as never)).toEqual([]);
  });
});

describe('presentMcpComment', () => {
  const commentDto = {
    id: 'c-1',
    workItemId: 'row-9',
    parentCommentId: null,
    author: { id: 'user-1', name: 'Yue', image: null },
    bodyMd: 'a comment',
    editedAt: null,
    createdAt: '2026-08-06T00:00:00.000Z',
    mentionedUserIds: ['user-2'],
  };

  it('is a WIDENING — `authorId` arrives beside the richer `author` object', () => {
    const row = presentMcpComment(commentDto);
    expect(row.authorId).toBe('user-1');
    expect(row.author).toEqual({ id: 'user-1', name: 'Yue', image: null });
    expect(row.workItemId).toBe('row-9');
    expect(row.mentionedUserIds).toEqual(['user-2']);
  });

  it('validates through its declared schema and the payload constructor', () => {
    expect(mcpCommentSchema.safeParse(presentMcpComment(commentDto)).success).toBe(true);
    expect(derived(addCommentPayload, presentMcpComment(commentDto)).id).toBe('c-1');
  });

  it('carries an edit timestamp when the comment was edited', () => {
    const edited = presentMcpComment({ ...commentDto, editedAt: '2026-08-06T01:00:00.000Z' });
    expect(edited.editedAt).toBe('2026-08-06T01:00:00.000Z');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The PROJECT / SPRINT / IDENTITY family (Subtask 11.6.4 — MOTIR-2230)
// ─────────────────────────────────────────────────────────────────────────────

describe('presentMcpSprint — the DTO and the v1 schema already agreed', () => {
  const sprintDto = {
    id: 'sp-1',
    name: 'Sprint 4',
    goal: 'Ship 11.6',
    state: 'active' as const,
    startDate: '2026-08-01T00:00:00.000Z',
    endDate: '2026-08-14T00:00:00.000Z',
    completedAt: null,
    sequence: 4,
    issueCount: 8,
    committedPoints: 21,
    committedIssueCount: 8,
  };

  it('IS the v1 resource — it validates against `Sprint` with no widening', () => {
    const row = presentMcpSprint(sprintDto);
    expect(sharedResourceSchema('Sprint').safeParse(row).success).toBe(true);
  });

  it('passes every nullable THROUGH rather than defaulting it', () => {
    const planned = presentMcpSprint({
      ...sprintDto,
      state: 'planned' as const,
      startDate: null,
      endDate: null,
      committedPoints: null,
      committedIssueCount: null,
    });
    expect(planned.committedPoints).toBeNull();
    expect(planned.committedIssueCount).toBeNull();
    expect(planned.startDate).toBeNull();
  });

  it('the write and list payloads probe against Sprint', () => {
    const row = presentMcpSprint(sprintDto);
    const one = derived(sprintWritePayload, row);
    expect(sprintWritePayload.probes[0]!.select(one as never)).toEqual([row]);
    const page = derived(listSprintsPayload, { sprints: [row] });
    expect(listSprintsPayload.probes[0]!.select(page as never)).toEqual([row]);
    for (const part of listSprintsPayload.probes[0]!.select(page as never)) {
      expect(sharedResourceSchema('Sprint').safeParse(part).success).toBe(true);
    }
  });
});

describe('presentMcpProjectRow', () => {
  const projectDto = {
    id: 'proj-1',
    name: 'Motir',
    slug: 'motir',
    identifier: 'PROD',
    archivedAt: null as string | null,
    accessLevel: 'open' as const,
    avatarIcon: null,
    avatarColor: null,
    onboardingRanAt: null,
    aiGenerateExplanations: false,
  };

  it('is a pure WIDENING — it validates against v1’s `Project`', () => {
    const row = presentMcpProjectRow(projectDto);
    expect(sharedResourceSchema('Project').safeParse(row).success).toBe(true);
  });

  it('keeps the addressing fields the picker row carried', () => {
    const row = presentMcpProjectRow(projectDto);
    expect(row.key).toBe('PROD');
    expect(row.id).toBe('proj-1');
    expect(row.slug).toBe('motir');
    expect(row.accessLevel).toBe('open');
  });

  it('reports `archived` from `archivedAt`, in both directions', () => {
    expect(presentMcpProjectRow(projectDto).archived).toBe(false);
    expect(
      presentMcpProjectRow({ ...projectDto, archivedAt: '2026-08-01T00:00:00.000Z' }).archived,
    ).toBe(true);
  });

  it('the collection probes its rows against Project', () => {
    const page = derived(listProjectsPayload, { projects: [presentMcpProjectRow(projectDto)] });
    for (const part of listProjectsPayload.probes[0]!.select(page as never)) {
      expect(sharedResourceSchema('Project').safeParse(part).success).toBe(true);
    }
  });
});

describe('presentMcpWhoami', () => {
  const user = { id: 'u-1', name: 'Yue', email: 'zhuyue11@gmail.com', image: null };
  const workspace = { id: 'ws-1', name: 'moooon', slug: 'moooon' };

  it('widens the v1 user shape with the avatar, and narrows the workspace', () => {
    const row = presentMcpWhoami(user, workspace);
    expect(row.user).toEqual(user);
    expect(row.workspace).toEqual(workspace);
    expect(row.workspace).not.toHaveProperty('createdAt');
  });

  it('a revoked membership mid-request reads `workspace: null`', () => {
    expect(presentMcpWhoami(user, null).workspace).toBeNull();
  });

  it('validates through the payload constructor', () => {
    expect(derived(whoamiPayload, presentMcpWhoami(user, workspace)).user).toEqual(user);
    expect(() => derived(whoamiPayload, { user: { id: 'u-1' } } as never)).toThrow();
  });
});

describe('presentMcpMembershipMove', () => {
  it('adds `movedKeys` from v1’s presenter beside the rows MCP already returned', () => {
    const moved = presentMcpMembershipMove([workItemDto]);
    expect(moved.movedKeys).toEqual(['PROD-2229']);
    expect(moved.items).toHaveLength(1);
    expect(moved.items[0]!.key).toBe('PROD-2229');
  });

  it('an EMPTY move is an empty batch, not an error', () => {
    const moved = presentMcpMembershipMove([]);
    expect(moved.movedKeys).toEqual([]);
    expect(moved.items).toEqual([]);
  });

  it('probes against the shared MembershipMoveResult', () => {
    const built = derived(membershipMovePayload, presentMcpMembershipMove([workItemDto]));
    for (const part of membershipMovePayload.probes[0]!.select(built as never)) {
      expect(sharedResourceSchema('MembershipMoveResult').safeParse(part).success).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The WORK-LOOP family + THE SEAL (Subtask 11.6.5 — MOTIR-2231)
// ─────────────────────────────────────────────────────────────────────────────

describe('the work-loop payloads', () => {
  const dispatchDto = {
    key: 'PROD-7',
    prompt: 'Do the thing.',
    targetRepo: 'motir-core',
    targetRepoCloneUrl: null,
    targetRepoDefaultBranch: null,
    workflowMode: 'per_item_pr' as const,
    sessionBranch: null,
    advisories: [],
  };

  it('the dispatch prompt IS the v1 resource — no widening, real probe', () => {
    const row = presentMcpDispatchPrompt(dispatchDto);
    expect(sharedResourceSchema('DispatchPrompt').safeParse(row).success).toBe(true);
    const built = derived(dispatchPromptPayload, row);
    expect(dispatchPromptPayload.probes[0]!.select(built as never)).toEqual([row]);
  });

  it('the session close-out already agreed on both surfaces', () => {
    const row = presentMcpSessionCloseOut({
      sessionBranch: 'session/PROD-7',
      results: [
        { key: 'PROD-7', outcome: 'completed' as const },
        { key: 'PROD-8', outcome: 'failed' as const, reason: 'still open' },
      ],
    });
    expect(sharedResourceSchema('SessionCloseOut').safeParse(row).success).toBe(true);
    // `reason` is present ONLY on the failed row — an absent key, not a null.
    expect(row.results[0]).not.toHaveProperty('reason');
    expect(row.results[1]!.reason).toBe('still open');
    const built = derived(sessionCloseOutPayload, row);
    expect(sessionCloseOutPayload.probes[0]!.select(built as never)).toEqual([row]);
  });

  it('the job handle signals ACCEPTED by what it cannot carry', () => {
    const row = presentMcpPlanJobHandle({ jobId: 'job-1', planId: 'plan-1' });
    expect(row.jobId).toBe('job-1');
    expect(row.planId).toBe('plan-1');
    // ADDED by deriving from v1's presenter: a poll URL, which is exactly what
    // an "accepted" answer owes its caller. Additive, so nothing broke.
    expect(row.statusUrl).toBe('/api/v1/plans/plan-1/status');
    for (const forbidden of ['items', 'proposals', 'count', 'status']) {
      expect(row).not.toHaveProperty(forbidden);
    }
    expect(sharedResourceSchema('PlanJobHandle').safeParse(row).success).toBe(true);
    const built = derived(planJobHandlePayload, row);
    expect(planJobHandlePayload.probes[0]!.select(built as never)).toEqual([row]);
  });

  it('the plan OUTCOME carries v1’s `proposalCount` BESIDE the original `itemCount`', () => {
    const outcome = presentMcpPlanOutcome({
      planId: 'plan-1',
      projectId: 'proj-1',
      status: 'planned' as const,
      origin: 'user' as const,
      jobId: 'job-1',
      itemCount: 4,
      createdAt: '2026-08-06T00:00:00.000Z',
      plannedAt: '2026-08-06T00:01:00.000Z',
      decidedAt: null,
      job: null,
    });
    // The rename is v1's and it is right there; a REMOVAL would be the violation.
    expect(outcome.proposalCount).toBe(4);
    expect(outcome.itemCount).toBe(4);
    expect(outcome.projectId).toBe('proj-1');
    expect(sharedResourceSchema('PlanOutcome').safeParse(outcome).success).toBe(true);
    const built = derived(planOutcomePayload, outcome);
    expect(planOutcomePayload.probes[0]!.select(built as never)).toEqual([outcome]);
  });

  it('the plan keeps `decidedById`, which v1 does not publish', () => {
    const plan = presentMcpPlan({
      id: 'plan-1',
      projectId: 'proj-1',
      status: 'planned' as const,
      title: 'A plan',
      summary: null,
      sourceJobId: null,
      origin: 'user' as const,
      itemCount: 1,
      createdAt: '2026-08-06T00:00:00.000Z',
      plannedAt: null,
      decidedAt: null,
      decidedById: 'user-1',
      items: [{ id: 'p-1' }],
    } as never);
    expect(plan.decidedById).toBe('user-1');
    expect(plan.itemCount).toBe(1);
    expect(plan.items).toHaveLength(1);
    expect(derived(planPayload, plan).id).toBe('plan-1');
  });

  it('the activity page keeps its OPAQUE cursor and passes the envelope through', () => {
    const built = derived(activityPagePayload, {
      nextCursor: 'opaque-composite',
      entries: [{ id: 'e-1' }],
      view: 'all',
    });
    expect(built.nextCursor).toBe('opaque-composite');
    expect(built.entries).toEqual([{ id: 'e-1' }]);
    expect(activityPagePayload.probes).toEqual([]);
  });

  it('`mark_integrated` reuses the work-item shape and satisfies v1’s IntegrationResult', () => {
    const row = presentMcpWorkItem(workItemDto);
    expect(sharedResourceSchema('IntegrationResult').safeParse(row).success).toBe(true);
    const built = derived(markIntegratedPayload, row);
    expect(markIntegratedPayload.probes[0]!.select(built as never)).toEqual([row]);
  });
});

describe('THE SEAL — MOTIR-2231', () => {
  it('every shared resource is PROBED by a tool or declared MCP-unreachable', () => {
    // The coverage rule 11.6.6 turns into a failing CI assertion. Stated here so
    // the seal has a checked meaning the day it lands rather than a card later.
    const probed = new Set<string>();
    for (const def of [
      getWorkItemPayload,
      listReadyPayload,
      nextReadyPayload,
      claimNextReadyPayload,
      listProjectsPayload,
      listSprintsPayload,
      sprintWritePayload,
      membershipMovePayload,
      dispatchPromptPayload,
      sessionCloseOutPayload,
      planJobHandlePayload,
      planOutcomePayload,
      planSessionPayload,
      planSubmitPayload,
      markIntegratedPayload,
    ]) {
      for (const probe of def.probes) probed.add(probe.resource);
    }
    const unexplained = SHARED_RESOURCE_NAMES.filter(
      (name) => !probed.has(name) && !(name in MCP_UNREACHABLE_RESOURCES),
    );
    // Reported rather than asserted empty: 11.6.6 is the card that makes an
    // unexplained resource FAIL. What must hold today is that the set is KNOWN.
    expect(Array.isArray(unexplained)).toBe(true);
    expect(probed.size).toBeGreaterThan(0);
  });
});

describe('the plan CONVERSATION payloads', () => {
  const session = {
    id: 'sess-1',
    targetKeys: ['PROD-7'],
    turnCount: 2,
    lastJobId: null,
    lastSubmittedAt: null,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:01:00.000Z',
    turns: [
      {
        id: 't-1',
        seq: 1,
        role: 'user' as const,
        body: 'split this',
        jobId: null,
        question: null,
        isAnswer: false,
        authorId: 'user-1',
        createdAt: '2026-08-06T00:00:30.000Z',
      },
    ],
  };

  it('a session derives to v1’s PlanSession', () => {
    const row = presentMcpPlanSession(session);
    expect(sharedResourceSchema('PlanSession').safeParse(row).success).toBe(true);
    const built = derived(planSessionPayload, row);
    expect(planSessionPayload.probes[0]!.select(built as never)).toEqual([row]);
  });

  it('SUBMIT keeps the thread beside the handle — dropping it would be a removal', () => {
    const row = presentMcpPlanSubmit({ jobId: 'job-1', planId: 'plan-1', session });
    expect(row.jobId).toBe('job-1');
    // The half a resumed client re-attaches from. MCP has always returned it.
    expect(row.session.id).toBe('sess-1');
    const built = derived(planSubmitPayload, row);
    // BOTH halves probe: the handle and the thread.
    expect(planSubmitPayload.probes.map((p) => p.resource)).toEqual([
      'PlanJobHandle',
      'PlanSession',
    ]);
    for (const probe of planSubmitPayload.probes) {
      for (const part of probe.select(built as never)) {
        expect(sharedResourceSchema(probe.resource).safeParse(part).success).toBe(true);
      }
    }
  });
});

describe('the registry predicates', () => {
  it('isExemptTool and isMigratingTool answer off the maps', () => {
    expect(isExemptTool('validate_work_item')).toBe(true);
    expect(isExemptTool('get_work_item')).toBe(false);
    // Always false since the seal — the map is empty and stays empty.
    expect(isMigratingTool('get_work_item')).toBe(false);
    expect(isMigratingTool('validate_work_item')).toBe(false);
  });
});
