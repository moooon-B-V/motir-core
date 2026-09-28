import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { readyLaneItemSchema } from '@/lib/api/v1/ready/schema';
import { runListReady } from '@/lib/mcp/tools/listReady';
import { GET as GET_LEAVES } from '@/app/api/v1/projects/[projectKey]/ready/leaves/route';
import { createV1ProjectCaller, type V1ProjectCaller } from '../fixtures/apiV1Fixtures';
import { createTestWorkItem } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE STORY'S INTEGRATION GATE (Story MOTIR-6829 · MOTIR-6839) — the ready lanes
// assembled across their consumers, against the real datastore.
//
// Where each named seam lives, so this file does not repeat them:
//   • service → v1 → CLI client (the GENERATED validators, a non-null
//     container on the wire): `tests/api/v1/cli-transport-seams.test.ts`,
//     "READY LANES".
//   • v1 → a hosted run token bound to the project:
//     `tests/api/v1/run-credential-legs.test.ts` (all three lanes).
//   • the page: `tests/components/ready-list.test.tsx` and the E2E
//     `tests/e2e/ready-lanes.spec.ts`.
// What is HERE: the service → MCP seam, and the five guards.
//
// The coverage floor (≥ 90% per file over the changed surface) is the PR's own
// coverage gate — it runs the whole suite under the per-file thresholds on
// every pull request with an app change, and again in the merge queue. It is
// not re-run locally (runbook: a suite-wide number is answered by CI).

vi.setConfig({ testTimeout: 60_000 });

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Kind = 'epic' | 'story' | 'task' | 'bug' | 'subtask';

async function item(
  caller: V1ProjectCaller,
  kind: Kind,
  title: string,
  parent?: WorkItem,
  priority: 'low' | 'medium' | 'high' | 'highest' = 'medium',
): Promise<WorkItem> {
  const row = await createTestWorkItem(caller.fixture, {
    kind,
    title,
    parentId: parent?.id ?? null,
  });
  return adminDb.workItem.update({ where: { id: row.id }, data: { status: 'todo', priority } });
}

/**
 * Every tree shape the lanes distinguish: a runnable story; a story holding a
 * container (not runnable) with its own leaf; a task under an epic; a childless
 * bug; a bug with a subtask; a bug leaf under a story (bug work, its own group);
 * and a story BLOCKED by an open card (the cascade).
 */
async function tree(caller: V1ProjectCaller) {
  const E = await item(caller, 'epic', 'E');
  const S = await item(caller, 'story', 'S', E);
  const s1 = await item(caller, 'subtask', 's1', S, 'high');
  const s2 = await item(caller, 'subtask', 's2', S);
  const sBug = await item(caller, 'bug', 'bug under S', S);
  const DEEP = await item(caller, 'story', 'DEEP', E);
  const inner = await item(caller, 'task', 'inner', DEEP);
  const i1 = await item(caller, 'subtask', 'i1', inner);
  const d1 = await item(caller, 'task', 'd1', DEEP);
  const T = await item(caller, 'task', 'T', E);
  const B = await item(caller, 'bug', 'B', undefined, 'highest');
  const B2 = await item(caller, 'bug', 'B2');
  const b1 = await item(caller, 'subtask', 'b1', B2);
  const BLOCKED = await item(caller, 'story', 'BLOCKED');
  const blockedLeaf = await item(caller, 'subtask', 'blocked leaf', BLOCKED);
  const gate = await item(caller, 'task', 'gate');
  await workItemsService.linkWorkItems(
    { fromId: BLOCKED.id, toId: gate.id, kind: 'is_blocked_by' },
    caller.ctx,
  );
  return { E, S, s1, s2, sBug, DEEP, inner, i1, d1, T, B, B2, b1, BLOCKED, blockedLeaf, gate };
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
const ALL = { limit: 200 } as const;

describe('the partition guard — leaves ∪ bugs is the old ready set', () => {
  it('holds for every tree shape, disjointly, with and without a facet and allowSoftBlock', async () => {
    const caller = await createV1ProjectCaller();
    await tree(caller);
    const pid = caller.fixture.projectId;
    for (const filter of [
      ALL,
      { ...ALL, allowSoftBlock: true },
      { ...ALL, priority: ['medium' as const] },
    ]) {
      const flat = await workItemsService.listReady(pid, filter, caller.ctx);
      const leaves = await workItemsService.listReadyLeaves(pid, filter, caller.ctx);
      const bugs = await workItemsService.listReadyBugs(pid, filter, caller.ctx);
      const l = new Set(ids(leaves.items));
      expect(ids(bugs.items).filter((id) => l.has(id))).toEqual([]);
      expect(ids([...leaves.items, ...bugs.items])).toEqual(ids(flat.items));
    }
  });
});

describe('the containers guard', () => {
  it('every containers-lane row is a container some leaves-lane row names — and nothing else', async () => {
    const caller = await createV1ProjectCaller();
    const t = await tree(caller);
    const pid = caller.fixture.projectId;
    const leaves = await workItemsService.listReadyLeaves(pid, ALL, caller.ctx);
    const containers = await workItemsService.listReadyContainers(pid, ALL, caller.ctx);
    const named = new Set(leaves.items.flatMap((r) => (r.container ? [r.container.key] : [])));
    expect(containers.items.map((c) => c.key).sort()).toEqual([...named].sort());
    // The shapes that are not runnable are never containers.
    for (const k of [t.E, t.DEEP, t.B2]) {
      expect(containers.items.map((c) => c.key)).not.toContain(k.identifier);
    }
  });
});

describe('the cascade is kept', () => {
  it('a leaf under a blocked story is in no lane — and appears with allowSoftBlock exactly as listReady shows it', async () => {
    const caller = await createV1ProjectCaller();
    const t = await tree(caller);
    const pid = caller.fixture.projectId;
    const lanes = async (filter: object) => [
      ...(await workItemsService.listReadyLeaves(pid, filter, caller.ctx)).items,
      ...(await workItemsService.listReadyBugs(pid, filter, caller.ctx)).items,
    ];
    expect((await lanes(ALL)).map((r) => r.key)).not.toContain(t.blockedLeaf.identifier);
    const soft = await lanes({ ...ALL, allowSoftBlock: true });
    const flatSoft = await workItemsService.listReady(
      pid,
      { ...ALL, allowSoftBlock: true },
      caller.ctx,
    );
    expect(soft.map((r) => r.key)).toContain(t.blockedLeaf.identifier);
    expect(flatSoft.items.map((r) => r.key)).toContain(t.blockedLeaf.identifier);
  });
});

describe('scoped-run completeness', () => {
  it("a story's scope read — leaves ∪ bugs under it — holds all its ready children, its bug included", async () => {
    // What `claimScopeForRun` lists through `listReadyForDispatch` (the CLI
    // walks both lanes with the same `ancestor` facet — pinned by the seam in
    // cli-transport-seams). Here: the server half, over every child of S.
    const caller = await createV1ProjectCaller();
    const t = await tree(caller);
    const pid = caller.fixture.projectId;
    const scope = { ...ALL, ancestorKeys: [t.S.identifier] };
    const scoped = [
      ...(await workItemsService.listReadyLeaves(pid, scope, caller.ctx)).items,
      ...(await workItemsService.listReadyBugs(pid, scope, caller.ctx)).items,
    ];
    expect(scoped.map((r) => r.key).sort()).toEqual(
      [t.s1, t.s2, t.sBug].map((w) => w.identifier).sort(),
    );
  });
});

describe('the service → MCP seam', () => {
  it("list_ready's rows are the v1 lane rows for the same items (two-surface conformance)", async () => {
    const caller = await createV1ProjectCaller();
    await tree(caller);
    const res = await GET_LEAVES(
      new Request(`http://localhost/api/v1/projects/${caller.projectKey}/ready/leaves?limit=100`, {
        headers: caller.headers,
      }),
      { params: Promise.resolve({ projectKey: caller.projectKey }) },
    );
    expect(res.status).toBe(200);
    const v1 = (await res.json()) as { items: unknown[] };
    const mcp = (await runListReady({ projectKey: caller.projectKey, limit: 100 }, caller.ctx))
      .structuredContent as { items: unknown[] };
    // The MCP row is a WIDENING of the v1 row (Amendment 7): read through the v1
    // schema, the two surfaces must say the same thing, row for row, in order.
    expect(mcp.items.map((row) => readyLaneItemSchema.parse(row))).toEqual(v1.items);
  });
});

// ─── the no-re-derivation guard ───────────────────────────────────────────────
//
// A lane's order is the SERVICE's (`lib/workItems/readyFilter.ts`). A route, the
// CLI and the MCP tools consume it; none may rank again. So none of their files
// may IMPORT the ranking (`READY_KIND_RANK` or its comparators), and none of the
// ready-row transports may call `.sort` / `.toSorted` at all. An AST walk, not a
// grep for words: a comment naming a comparator is not a use of it.

const ROOT = process.cwd();
const RANKING = new Set([
  'READY_KIND_RANK',
  'READY_PRIORITY_ASC',
  'compareReadyRows',
  'compareReadyPosition',
  'groupRank',
]);

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return filesUnder(full);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [full] : [];
  });
}

function scan(file: string): { imports: string[]; sorts: number } {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  let sorts = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
      const bindings = node.importClause.namedBindings;
      if (ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) imports.push((el.propertyName ?? el.name).text);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['sort', 'toSorted'].includes(node.expression.name.text)
    ) {
      sorts += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return { imports, sorts };
}

describe('no re-derivation of the lane order', () => {
  const ROUTES = filesUnder(join(ROOT, 'app/api/v1/projects/[projectKey]/ready'));
  const CLI = filesUnder(join(ROOT, 'packages/cli/src')).filter((f) => !f.includes('/api/'));
  // The files that carry READY ROWS end to end — each must pass them through in
  // the order it received them.
  const TRANSPORTS = [
    ...ROUTES,
    join(ROOT, 'lib/api/v1/ready/schema.ts'),
    join(ROOT, 'lib/api/v1/ready/lanes.ts'),
    join(ROOT, 'lib/mcp/tools/listReady.ts'),
    join(ROOT, 'lib/mcp/tools/nextReady.ts'),
    join(ROOT, 'packages/cli/src/client.ts'),
    join(ROOT, 'packages/cli/src/session.ts'),
    join(ROOT, 'packages/cli/src/commands/read.ts'),
    join(ROOT, 'app/(authed)/ready/_components/ReadyList.tsx'),
    join(ROOT, 'app/(authed)/ready/_components/ReadyLanes.tsx'),
  ];

  it('the scan is not vacuous', () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(4);
    expect(CLI.length).toBeGreaterThan(20);
  });

  it('no route under …/ready and no CLI source imports the ready ranking', () => {
    const offenders = [...ROUTES, ...CLI].flatMap((file) =>
      scan(file)
        .imports.filter((name) => RANKING.has(name))
        .map((name) => `${relative(ROOT, file)} imports ${name}`),
    );
    expect(offenders).toEqual([]);
  });

  it('no ready-row transport sorts', () => {
    const offenders = TRANSPORTS.filter((file) => scan(file).sorts > 0).map((f) =>
      relative(ROOT, f),
    );
    expect(offenders).toEqual([]);
  });

  it('the guard bites — a sort and a ranking import are both found', () => {
    const probe = join(ROOT, 'lib/services/workItemsService.ts');
    const { imports, sorts } = scan(probe);
    expect(imports.some((name) => RANKING.has(name))).toBe(true);
    expect(sorts).toBeGreaterThan(0);
  });
});
