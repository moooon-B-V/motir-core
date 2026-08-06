import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as GET_DETAIL } from '@/app/api/v1/work-items/[key]/route';
import { GET as GET_COLLECTION } from '@/app/api/v1/projects/[projectKey]/work-items/route';
import { GET as GET_READY } from '@/app/api/v1/projects/[projectKey]/ready/route';
import type { V1ReadyItem } from '@/lib/api/v1/ready/schema';
import type { WorkItemDetail, WorkItemSummary } from '@/lib/api/v1/workItems/schema';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  assignChildWaves,
  renderChildrenSection,
  renderReadinessLine,
  renderReadyTable,
  renderSprintItems,
} from '../../../packages/cli/src/render';
import type {
  ReadyItemSummary,
  SearchItemSummary,
  WorkItemChild,
  WorkItemDetail as CliWorkItemDetail,
} from '../../../packages/cli/src/mcpClient';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// CAN THE SHIPPED RENDERERS BE FED FROM v1 ALONE? (Story 11.7 · Subtask 11.7.2 —
// MOTIR-2236.)
//
// The three field projections exist for exactly three consumers, all of them in
// `packages/cli/src/render.ts`. A test that only asserted the FIELDS would prove
// the payload has the right key names and nothing about whether the renderer can
// actually run on it — the failure mode being a field that is present, correctly
// named, and carries a value the renderer cannot use (a status the CLI's
// `isSatisfiedBlocker` does not recognise, a key in the wrong form, an edge
// pointing at an id rather than a `MOTIR-<n>`).
//
// So this suite drives the REAL renderers, imported from the CLI package, over a
// REAL v1 response read out of the real routes against real Postgres. The only
// thing written here is the ADAPTER — the field renaming Story 11.5.4 will ship
// for real — and it is deliberately tiny: if it had to invent a value rather than
// move one, that would BE the finding.
//
// ⚠️ The adapter renames; it never fabricates. Every value below comes out of the
// v1 body. A `?? []` or a synthesized status would make this suite agree with
// itself, which is the trap `tests/cli/cli-story.test.ts` records for its own
// (different) reason — it drives the built binary, so it may not import the CLI's
// source at all; this suite's whole question is about the CLI's source, so it must.

const BASE = 'http://localhost:3000/api/v1';

// ─────────────────────────────────────────────────────────────────────────────
// The adapter — v1 wire shape → the renderer's input. RENAMES ONLY.
// ─────────────────────────────────────────────────────────────────────────────

/** A v1 detail child → the CLI's `WorkItemChild`. `key` → `identifier`. */
function toCliChild(child: WorkItemDetail['children'][number]): WorkItemChild {
  return {
    identifier: child.key,
    kind: child.kind,
    title: child.title,
    status: child.status,
    dependencies: child.dependencies,
  };
}

/** A v1 collection row → the CLI's `SearchItemSummary`. */
function toCliSearchRow(row: WorkItemSummary): SearchItemSummary {
  return {
    identifier: row.key,
    kind: row.kind,
    title: row.title,
    status: row.status,
    priority: row.priority,
    dependencies: row.dependencies,
  };
}

/**
 * A v1 ready row → the CLI's `ReadyItemSummary` (Amendment 8 Q1 · MOTIR-2279).
 *
 * A RENAME of nothing at all: `key`, `kind`, `title`, `priority`, `assignee` and
 * `dependencies` are all already the names the renderer reads. That is the point
 * — before Amendment 8 this adapter could not be written, because `assignee` did
 * not exist on the row and `assigneeId` is not a name.
 */
function toCliReadyRow(row: V1ReadyItem): ReadyItemSummary {
  return {
    key: row.key,
    kind: row.kind,
    title: row.title,
    priority: row.priority,
    assignee: row.assignee,
    dependencies: row.dependencies,
  };
}

/**
 * A v1 readiness verdict → the CLI's nested one.
 *
 * The ONLY place the two shapes differ structurally: v1 publishes the ancestor
 * FLAT (`blockedByAncestorKey` + `blockedByAncestorTitle`) because
 * `blockedByAncestorKey` is already published API and §8 forbids replacing it.
 * Re-nesting is a rename of two fields — and it is only possible because the
 * TITLE is there, which is the whole of projection 3.
 */
function toCliReadiness(readiness: WorkItemDetail['readiness']): CliWorkItemDetail['readiness'] {
  return {
    ready: readiness.ready,
    openBlockers: readiness.openBlockers.map((blocker) => ({
      identifier: blocker.key,
      kind: blocker.kind,
      title: blocker.title,
      status: blocker.status,
    })),
    blockedByAncestor:
      readiness.blockedByAncestorKey === null || readiness.blockedByAncestorTitle === null
        ? null
        : {
            identifier: readiness.blockedByAncestorKey,
            title: readiness.blockedByAncestorTitle,
            // The readiness LINE renders the key and the title and nothing else;
            // the two below are on the CLI's shared summary type and are not read
            // on this path, so they carry the values v1 does publish about the
            // ancestor: none. Marked here so a future reader does not mistake
            // them for data the projection forgot.
            kind: '',
            status: '',
          },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function detailReq(caller: V1ProjectCaller, key: string): Promise<Response> {
  return GET_DETAIL(new Request(`${BASE}/work-items/${key}`, { headers: caller.headers }), {
    params: Promise.resolve({ key }),
  });
}

async function readDetail(caller: V1ProjectCaller, key: string): Promise<WorkItemDetail> {
  const res = await detailReq(caller, key);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkItemDetail;
}

async function readCollection(caller: V1ProjectCaller): Promise<WorkItemSummary[]> {
  const key = caller.projectKey;
  const res = await GET_COLLECTION(
    new Request(`${BASE}/projects/${key}/work-items`, { headers: caller.headers }),
    { params: Promise.resolve({ projectKey: key }) },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: WorkItemSummary[] }).items;
}

async function readReady(caller: V1ProjectCaller): Promise<V1ReadyItem[]> {
  const key = caller.projectKey;
  const res = await GET_READY(
    new Request(`${BASE}/projects/${key}/ready`, { headers: caller.headers }),
    { params: Promise.resolve({ projectKey: key }) },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: V1ReadyItem[] }).items;
}

async function makeItem(
  caller: V1ProjectCaller,
  title: string,
  extra: { parentId?: string; kind?: 'task' | 'subtask' | 'story' } = {},
) {
  return workItemsService.createWorkItem(
    {
      projectId: caller.fixture.projectId,
      kind: extra.kind ?? 'task',
      title,
      ...(extra.parentId ? { parentId: extra.parentId } : {}),
    },
    caller.ctx,
  );
}

function blockedBy(caller: V1ProjectCaller, fromId: string, toId: string) {
  return workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, caller.ctx);
}

async function markDone(caller: V1ProjectCaller, id: string) {
  await workItemsService.updateStatus(id, 'in_progress', caller.ctx);
  await workItemsService.updateStatus(id, 'in_review', caller.ctx);
  await workItemsService.updateStatus(id, 'done', caller.ctx);
}

describe('the shipped CLI renderers, driven from a v1 response', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.restoreAllMocks();
  });

  it('assignChildWaves computes the real build order from `GET /work-items/{key}`', async () => {
    // A → B → C, plus a D nothing gates. The wave view's whole claim is that
    // this order is derivable from ONE call.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const parent = await makeItem(caller, 'the parent', { kind: 'story' });
    const a = await makeItem(caller, 'a', { parentId: parent.id, kind: 'subtask' });
    const b = await makeItem(caller, 'b', { parentId: parent.id, kind: 'subtask' });
    const c = await makeItem(caller, 'c', { parentId: parent.id, kind: 'subtask' });
    const d = await makeItem(caller, 'd', { parentId: parent.id, kind: 'subtask' });
    await blockedBy(caller, b.id, a.id);
    await blockedBy(caller, c.id, b.id);

    const detail = await readDetail(caller, parent.identifier);
    const waves = assignChildWaves(detail.children.map(toCliChild));

    const waveOf = new Map(waves.map((entry) => [entry.child.identifier, entry.wave]));
    expect(waveOf.get(a.identifier)).toBe(1);
    expect(waveOf.get(b.identifier)).toBe(2);
    expect(waveOf.get(c.identifier)).toBe(3);
    expect(waveOf.get(d.identifier)).toBe(1);
    // Nothing was left unplaced: a v1 payload the renderer could not read would
    // surface as a phantom cycle, not as an exception.
    expect(waves.every((entry) => entry.wave !== null)).toBe(true);
  });

  it('classifies a SATISFIED blocker from the status v1 publishes, not from a guess', async () => {
    // The CLI decides "satisfied" from the edge's raw workflow status key. If v1
    // published a display label, or the category, this would silently classify a
    // done blocker as still blocking and push every dependent a wave down.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const parent = await makeItem(caller, 'the parent', { kind: 'story' });
    const done = await makeItem(caller, 'already done', { parentId: parent.id, kind: 'subtask' });
    const after = await makeItem(caller, 'after', { parentId: parent.id, kind: 'subtask' });
    await blockedBy(caller, after.id, done.id);
    await markDone(caller, done.id);

    const detail = await readDetail(caller, parent.identifier);
    const waves = assignChildWaves(detail.children.map(toCliChild));

    const entry = waves.find((w) => w.child.identifier === after.identifier);
    expect(entry?.satisfiedBlockers).toEqual([done.identifier]);
    expect(entry?.siblingBlockers).toEqual([]);
    // A satisfied blocker does not hold a wave: nothing gates this child now.
    expect(entry?.wave).toBe(1);
  });

  it('renderChildrenSection prints the WAVE view, not the degraded table', async () => {
    // `hasEdges` is what chooses between the two forms, and it reads the
    // `dependencies` block. Without projection 1 the v1-fed section would fall
    // back to the pre-7.9.16b table — correct output for the wrong reason.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const parent = await makeItem(caller, 'the parent', { kind: 'story' });
    const a = await makeItem(caller, 'a', { parentId: parent.id, kind: 'subtask' });
    const b = await makeItem(caller, 'b', { parentId: parent.id, kind: 'subtask' });
    await blockedBy(caller, b.id, a.id);

    const detail = await readDetail(caller, parent.identifier);
    const section = renderChildrenSection(detail.children.map(toCliChild));

    expect(section).toContain('build order');
    expect(section).toContain(a.identifier);
    expect(section).toContain(b.identifier);
  });

  it('renderSprintItems prints the BLOCKED BY / BLOCKS columns from the collection read', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const first = await makeItem(caller, 'do me first');
    const second = await makeItem(caller, 'waits on the first');
    await blockedBy(caller, second.id, first.id);

    const rows = (await readCollection(caller)).map(toCliSearchRow);
    const table = renderSprintItems(rows, rows.length);

    // The edge columns appear ONLY when the payload carries the block — the
    // renderer omits them wholesale "against a server with no edge projection".
    expect(table).toContain('BLOCKED BY');
    expect(table).toContain('BLOCKS');
    const blockedRow = table.split('\n').find((line) => line.includes(second.identifier));
    expect(blockedRow).toContain(first.identifier);
  });

  it('renderReadyTable prints the ASSIGNEE NAME from `GET …/ready` (Amendment 8 Q1)', async () => {
    // The regression this whole card exists to prevent. Before Amendment 8 the
    // v1 row carried `assigneeId` and no name, so this table printed
    // "unassigned" for an item that plainly has an assignee — silently, because
    // a blank ASSIGNEE column looks exactly like unassigned work.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'an assigned task');
    await workItemsService.updateWorkItem(item.id, { assigneeId: caller.user.id }, caller.ctx);

    const rows = await readReady(caller);
    const row = rows.find((r) => r.key === item.identifier);
    expect(row, 'the assigned item should be ready').toBeDefined();

    // The wire carries BOTH, and they are the same person.
    expect(row?.assignee).toEqual({ id: caller.user.id, name: caller.user.name });
    expect(row?.assigneeId).toBe(row?.assignee?.id);

    const table = renderReadyTable(rows.map(toCliReadyRow));
    expect(table).toContain(caller.user.name);
    expect(table).not.toContain('unassigned');
  });

  it('renderReadyTable prints `unassigned` when the row genuinely has no assignee', async () => {
    // The other half: `null` must survive the projection as `null`, so the
    // renderer's own fallback fires for the real reason rather than because a
    // field went missing.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    await makeItem(caller, 'nobody owns this');

    const rows = await readReady(caller);
    expect(rows.every((r) => r.assignee === null && r.assigneeId === null)).toBe(true);
    expect(renderReadyTable(rows.map(toCliReadyRow))).toContain('unassigned');
  });

  it('adds NO query — the assignee comes off the page the route already read', async () => {
    // Amendment 8 permits the widening because it is a mapper change. An N+1
    // here would be invisible until a 50-row page, so it is asserted rather
    // than reasoned about: two service calls for the whole page, whatever its
    // size (`listReady`, then the bounded edge projection).
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    for (let i = 0; i < 5; i += 1) {
      const made = await makeItem(caller, `assigned ${i}`);
      await workItemsService.updateWorkItem(made.id, { assigneeId: caller.user.id }, caller.ctx);
    }

    const listReady = vi.spyOn(workItemsService, 'listReady');
    const edges = vi.spyOn(workItemsService, 'getDependencyEdgesForItems');

    const rows = await readReady(caller);

    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(listReady).toHaveBeenCalledTimes(1);
    expect(edges).toHaveBeenCalledTimes(1);
    expect(rows.every((r) => r.assignee?.name === caller.user.name)).toBe(true);
  });

  it('renderReadinessLine prints `<key> — <title>` for a cascade-blocked item', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const blocker = await makeItem(caller, 'the thing in the way');
    const parent = await makeItem(caller, 'the parent story', { kind: 'story' });
    const child = await makeItem(caller, 'the child', { parentId: parent.id, kind: 'subtask' });
    await blockedBy(caller, parent.id, blocker.id);

    const detail = await readDetail(caller, child.identifier);
    const line = renderReadinessLine(toCliReadiness(detail.readiness));

    // Both halves, from v1 alone. Before projection 3 the title was dropped at
    // the schema and this line could only have been rendered half-empty.
    expect(line).toBe(`blocked by ancestor ${parent.identifier} — the parent story`);
  });

  it('renderReadinessLine still says plain `ready` when nothing blocks the item', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'unblocked');

    const detail = await readDetail(caller, item.identifier);

    expect(renderReadinessLine(toCliReadiness(detail.readiness))).toBe('ready');
  });
});
