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
import { definePayload, derived, exempt, unmigrated } from '@/lib/mcp/payloads/define';
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

  it('REFUSES `unmigrated` for a tool that is not staged for a family card', () => {
    // @ts-expect-error `validate_work_item` is exempt, not migrating. The two
    // mean different things and trading one for the other is the invisible
    // opt-out the mechanism removes.
    expect(() => unmigrated('validate_work_item', {})).toBeTypeOf('function');
  });

  it('REFUSES a tool name that does not exist at all', () => {
    // @ts-expect-error not a registered tool.
    expect(() => exempt('no_such_tool', {})).toBeTypeOf('function');
  });

  it('ACCEPTS each of the three constructors', () => {
    expect(toolOk('t', exempt('validate_work_item', { valid: true })).structuredContent).toEqual({
      valid: true,
    });
    expect(toolOk('t', unmigrated('list_projects', { projects: [] })).structuredContent).toEqual({
      projects: [],
    });
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

  it('every migrating entry names the card that removes it', () => {
    for (const [name, card] of Object.entries(MIGRATING_TOOLS)) {
      expect(card, `migrating tool "${name}" names no card`).toMatch(/^MOTIR-\d+$/);
    }
  });

  it('EVERY registered tool resolves to derived, exempt or migrating — none is invisible', () => {
    // The tools that DERIVE so far; every other must be registered.
    // MOTIR-2231 (11.6.5) empties `MIGRATING_TOOLS`, at which point this
    // assertion is the seal: derived-or-exempt, nothing in between.
    const derivedTools = new Set([
      // 11.6.2's proving tool …
      'get_work_item',
      // … and 11.6.3's work-item family (MOTIR-2229).
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
    ]);
    for (const name of MCP_TOOL_NAMES) {
      const resolved = derivedTools.has(name) || isExemptTool(name) || isMigratingTool(name);
      expect(resolved, `tool "${name}" is in NO column — the guard cannot see it`).toBe(true);
    }
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
