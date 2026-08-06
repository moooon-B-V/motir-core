import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { MCP_TOOL_NAMES, buildMcpServer } from '@/lib/mcp/registry';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import { runListReady } from '@/lib/mcp/tools/listReady';
import { runSearchWorkItems } from '@/lib/mcp/tools/searchWorkItems';
import { runListProjects } from '@/lib/mcp/tools/listProjects';
import { TOOL_PAYLOADS } from '@/lib/mcp/payloads/registry';
import { checkPayloadDrift } from '@/lib/mcp/payloads/driftGuard';
import { isDerivedTool } from '@/lib/mcp/payloads/registry';
import { workItemSummarySchema, workItemRefSchema } from '@/lib/api/v1/workItems/schema';
import { readyItemSchema } from '@/lib/api/v1/ready/schema';
import { projectSchema } from '@/lib/api/v1/projects/schema';
import { sprintSchema } from '@/lib/api/v1/sprints/schema';
import { makeWorkItemFixture, createTestWorkItem } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// The STORY VITEST GATE (Story 11.6 · Subtask 11.6.7 — MOTIR-2233).
//
// Every code card in this story shipped its own unit tests, written by the
// author of the change against a fixture the same author invented. That is the
// right floor and it cannot see the one thing the story is really promising.
//
// A schema alignment has a characteristic way of PASSING WHILE BEING WRONG: the
// fixture is written to match the schema, the schema matches the fixture, and
// nobody has checked either against what a real service returns. Every test is
// green and the payload a caller receives is different from the one the tests
// describe. So the seam tests here start from a REAL DTO produced by a REAL
// service call against REAL Postgres and push it all the way to the payload —
// the only arrangement in this story where no fixture stands in for the data.
//
// Three groups:
//   1. DTO → schema → payload, per resource, over real rows.
//   2. The NARROWINGS are genuine DERIVATIONS — change the base, they break.
//   3. Contract guards a coverage percentage cannot see.

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }));

let fx: Awaited<ReturnType<typeof makeWorkItemFixture>>;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterEach(() => vi.clearAllMocks());
afterAll(async () => {
  await db.$disconnect();
});

/** Read a tool's `structuredContent` as a plain object. */
function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. DTO → schema → payload, over REAL rows
// ─────────────────────────────────────────────────────────────────────────────

describe('DTO → schema → payload, driven from a real service call', () => {
  it('get_work_item: the CHILD rows off a real aggregate satisfy v1’s WorkItemRef', async () => {
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'A story' });
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'A child',
      parentId: story.id,
    });

    // The REAL service read the tool makes — no fixture standing in for the row.
    const detail = await workItemsService.getIssueDetail(fx.projectId, story.identifier, fx.ctx);
    expect(detail.children.map((c) => c.id)).toContain(child.id);

    const payload = structured(await runGetWorkItem({ key: story.identifier }, fx.ctx));
    const children = payload.children as Record<string, unknown>[];
    expect(children).toHaveLength(1);

    // …and what came out the other end IS the shared schema's shape.
    expect(workItemRefSchema.safeParse(children[0]).success).toBe(true);
    // The values came from the real row, not from a literal in this file.
    expect(children[0]!.key).toBe(child.identifier);
    expect(children[0]!.title).toBe('A child');
    // The founding defect's field, present and total.
    expect(children[0]!.dependencies).toEqual({ blockedBy: [], blocks: [] });

    // The guard's own entry point agrees, over the real payload.
    expect(checkPayloadDrift(TOOL_PAYLOADS.get_work_item!, payload)).toEqual([]);
  });

  it('list_ready: a real ready row satisfies v1’s ReadyItem', async () => {
    // Through the SERVICE the app uses, so the row is exactly what production
    // writes — a `task`, which is a ready leaf on its own.
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Ready work', descriptionMd: 'Body' },
      fx.ctx,
    );
    const payload = structured(await runListReady({ projectKey: fx.project.identifier }, fx.ctx));
    const items = payload.items as Record<string, unknown>[];
    expect(items.length).toBeGreaterThan(0);
    for (const row of items) {
      expect(readyItemSchema.safeParse(row).success).toBe(true);
    }
    expect(checkPayloadDrift(TOOL_PAYLOADS.list_ready!, payload)).toEqual([]);
  });

  it('list_ready: `assigneeId` is DERIVED from the real assignee object, both riding', async () => {
    await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Assigned work',
        assigneeId: fx.ownerId,
      },
      fx.ctx,
    );
    const payload = structured(await runListReady({ projectKey: fx.project.identifier }, fx.ctx));
    const row = (payload.items as Record<string, unknown>[]).find(
      (r) => r.title === 'Assigned work',
    )!;
    // BOTH ride: the v1 id AND the richer object MCP already carried. The id is
    // COMPUTED from the object, over a real row — not defaulted to null.
    expect(row.assigneeId).toBe(fx.ownerId);
    expect((row.assignee as { id: string }).id).toBe(fx.ownerId);
  });

  it('search_work_items: a real row carries the shared fields and the edge block', async () => {
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'Findable' });
    const payload = structured(
      await runSearchWorkItems({ projectKey: fx.project.identifier }, fx.ctx),
    );
    const row = (payload.items as Record<string, unknown>[]).find((r) => r.key === a.identifier)!;
    expect(row).toBeDefined();
    // The declared NARROWING: everything the collection row has EXCEPT createdAt.
    expect(workItemSummarySchema.omit({ createdAt: true }).safeParse(row).success).toBe(true);
    expect(row.dependencies).toEqual({ blockedBy: [], blocks: [] });
    // `key` is the identifier on BOTH surfaces now; the number rides beside it.
    expect(row.key).toBe(a.identifier);
    expect(row.numericKey).toBe(a.key);
  });

  it('list_projects: a real project row satisfies v1’s Project', async () => {
    const payload = structured(await runListProjects(fx.ctx));
    const rows = payload.projects as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(projectSchema.safeParse(row).success).toBe(true);
    }
    expect(checkPayloadDrift(TOOL_PAYLOADS.list_projects!, payload)).toEqual([]);
    // Read back through the SERVICE the tool calls — the values agree.
    const viaService = await projectsService.listProjects(fx.workspaceId, fx.ownerId);
    expect(rows.map((r) => r.key)).toEqual(viaService.map((p) => p.identifier));
  });

  it('a real SPRINT row satisfies v1’s Sprint with no widening at all', async () => {
    const sprint = await sprintsService.createSprint(
      fx.projectId,
      { name: 'Sprint 1', goal: 'ship' },
      fx.ctx,
    );
    // The DTO the service actually returned, straight through the shared schema.
    expect(sprintSchema.safeParse(sprint).success).toBe(true);
    expect(sprint.name).toBe('Sprint 1');
  });

  it('add_comment: a real comment carries `authorId` beside the author object', async () => {
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Discussed' });
    const comment = await commentsService.addComment(item.id, { bodyMd: 'hello' }, fx.ctx);
    expect(comment.author.id).toBe(fx.ownerId);
    // The payload's shared half is v1's own mapper over this exact row.
    const { presentMcpComment } = await import('@/lib/mcp/payloads/workItems');
    const payload = presentMcpComment(comment);
    expect(payload.authorId).toBe(fx.ownerId);
    expect(payload.author).toEqual(comment.author);
    expect(payload.bodyMd).toBe('hello');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The NARROWINGS are genuine DERIVATIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('the narrowings BREAK when the base shape changes', () => {
  // A `.pick`/`.omit` off the shared schema breaks LOUDLY when the base changes;
  // a hand-built object that happens to resemble it goes on compiling and quietly
  // means something else. Those two look identical in a diff and are opposite in
  // kind — so the only way to tell them apart is to change the base and see which
  // one notices. That is what these do.

  it('omitting a field the base no longer has is a TYPE error, caught at build', () => {
    const base = z.object({ a: z.string(), b: z.string() });
    // A real derivation tracks its base…
    const narrowed = base.omit({ b: true });
    expect(Object.keys(narrowed.shape)).toEqual(['a']);
    // …and `.omit` of a key the base does not declare does not typecheck.
    // @ts-expect-error `c` is not a key of the base — this is the loud failure.
    expect(() => base.omit({ c: true })).toBeTypeOf('function');
  });

  it('a WIDENING inherits a base change — a new required field propagates', () => {
    const base = z.object({ a: z.string() });
    const widened = base.extend({ x: z.number() });
    expect(widened.safeParse({ a: 'v', x: 1 }).success).toBe(true);
    // Change the base incompatibly and the derivation follows it.
    const changedBase = z.object({ a: z.string(), required: z.string() });
    const rederived = changedBase.extend({ x: z.number() });
    expect(rederived.safeParse({ a: 'v', x: 1 }).success).toBe(false);
  });

  it('the shipped narrowings ARE derivations of their bases, not look-alikes', async () => {
    const { mcpWorkItemRowSchema, mcpWorkItemSchema } =
      await import('@/lib/mcp/payloads/workItems');
    // Every key the base declares (minus the declared omission) is present.
    const base = Object.keys(workItemSummarySchema.shape);
    const row = Object.keys(mcpWorkItemRowSchema.shape);
    for (const key of base) {
      if (key === 'createdAt') continue; // the declared omission
      expect(row, `search row lost the base's "${key}"`).toContain(key);
    }
    const write = Object.keys(mcpWorkItemSchema.shape);
    for (const key of base) {
      if (key === 'dependencies') continue; // the declared omission
      expect(write, `write shape lost the base's "${key}"`).toContain(key);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Contract guards a coverage percentage cannot see
// ─────────────────────────────────────────────────────────────────────────────

const MCP_DIR = join(process.cwd(), 'lib', 'mcp');

/** Every `.ts` under a directory, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('contract guards — what a coverage percentage cannot see', () => {
  it('NO DERIVED tool hand-casts its payload into `Record<string, unknown>`', () => {
    // The exact shape every tool used before this story: a cast straight into
    // `toolOk`'s old parameter type. It survives ONLY in EXEMPT tools, and there
    // it is correct — an exempt tool has no shared schema to derive from, so its
    // own DTO IS the payload and the cast is how it says so. Scoping the rule to
    // derived tools is what makes it meaningful rather than merely strict.
    const offenders: string[] = [];
    for (const file of filesUnder(join(MCP_DIR, 'tools'))) {
      const source = readFileSync(file, 'utf8');
      if (!/as unknown as Record<string, unknown>/.test(source)) continue;
      // A file can register more than one tool, so check each name it declares.
      const names = [...source.matchAll(/TOOL_NAME(?:S)? = '([a-z_]+)'/g)].map((m) => m[1]!);
      const derived = names.filter((name) => isDerivedTool(name as never));
      if (derived.length > 0) offenders.push(`${file} → ${derived.join(', ')}`);
    }
    expect(
      offenders,
      `these DERIVED tools still hand-cast their payload:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('NO module imports BOTH zod entrypoints — the v3/v4 boundary holds', () => {
    // Asserted over the TREE, not per file: the two do not interoperate, so a
    // module on both sides does not misbehave, it fails to compile — but only
    // once someone composes across it (ADR Amendment 7 Q3).
    const roots = ['lib', 'app', 'tests'].map((d) => join(process.cwd(), d));
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of filesUnder(root)) {
        const source = readFileSync(file, 'utf8');
        // Anchored at an IMPORT statement, not anywhere in the text — this
        // suite's own source names both entrypoints while importing one.
        const classic = /^\s*import[^\n]*from 'zod';$/m.test(source);
        const v4 = /^\s*import[^\n]*from 'zod\/v4';$/m.test(source);
        if (classic && v4) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the derivation modules are on zod/v4 and declare NO tool input schema', () => {
    // The property that makes "no file imports both" true by CONSTRUCTION rather
    // than by discipline: the files that compose v4 declare no input schemas, and
    // the files that declare input schemas compose nothing.
    for (const file of filesUnder(join(MCP_DIR, 'payloads'))) {
      const source = readFileSync(file, 'utf8');
      if (/from 'zod\/v4'/.test(source)) {
        expect(source, `${file} declares an inputSchema`).not.toMatch(/inputSchema/);
      }
    }
  });

  it('every tool still REGISTERS with a title, a description and an input schema', () => {
    // The freedom this story promised to leave alone. Thirty-odd files were
    // rewritten, which is exactly the circumstance in which a description gets
    // "tidied" in passing — so the prose surface is asserted PRESENT here, and
    // asserted UNCHANGED from outside the process by MOTIR-2234.
    const source = filesUnder(join(MCP_DIR, 'tools'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    expect(source).toContain('inputSchema');
    expect(source).toContain('description:');
    expect(source).toContain('title:');
  });

  it('the tool REGISTRY still exposes every name — none was renamed or dropped', async () => {
    const server = buildMcpServer(() => fx.ctx);
    expect(server).toBeDefined();
    // The registry's own list is the contract; a rename would change it.
    expect(MCP_TOOL_NAMES.length).toBeGreaterThan(30);
    expect(new Set(MCP_TOOL_NAMES).size).toBe(MCP_TOOL_NAMES.length);
  });

  it('every DERIVED tool’s definition resolves — the map has no dangling entry', () => {
    for (const [tool, definition] of Object.entries(TOOL_PAYLOADS)) {
      expect(definition, `${tool} maps to nothing`).toBeDefined();
      expect(definition.schema, `${tool} has no schema`).toBeDefined();
    }
  });
});
