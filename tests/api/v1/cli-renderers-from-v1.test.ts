import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as GET_DETAIL } from '@/app/api/v1/work-items/[key]/route';
import { GET as GET_COLLECTION } from '@/app/api/v1/projects/[projectKey]/work-items/route';
import type { WorkItemDetail, WorkItemSummary } from '@/lib/api/v1/workItems/schema';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  assignChildWaves,
  renderChildrenSection,
  renderReadinessLine,
  renderSprintItems,
} from '../../../packages/cli/src/render';
import type {
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
