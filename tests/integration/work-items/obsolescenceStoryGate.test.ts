import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE STORY GATE for MOTIR-6575 (Subtask MOTIR-6679) — against a REAL Postgres,
// every door a person or an agent reaches the mark through, on ONE project. Only
// the session and active-project resolvers are stubbed (the Server Actions and the
// board route read them), as every route/action suite here does; the REST v1 door
// is driven with a real PAT, and MCP through its runners.
//
// Each code card ships its own unit and door tests; this suite is the SEAM — the
// same row meeting every door, and the same answer coming back from each:
//
//   · every WRITE door refuses a mark on an unfinished card
//     (OBSOLESCENCE_REQUIRES_FINISHED) and accepts it on `done` / `cancelled`,
//     readable back on the same door;
//   · every STATUS door refuses a reopen (MARKED_CARD_CANNOT_REOPEN) with the
//     status unchanged, no revision and no `work-item/transitioned` event; a move
//     within the done category and a reopen after the mark is cleared go through;
//   · a custom done-category status (`shipped`) is finished both ways;
//   · the quick view's read carries the mark;
//   · ONE definition of the finished-card predicate.
//
// Covered elsewhere, and cited rather than repeated: the service rules
// (`obsolescenceFinishedRule.test.ts`), the background movers and the rollup job
// (`obsolescenceMovers.test.ts`, `../workflows/parentRollupMarkedParent.test.ts`),
// the board / list / tree reads and the board filter (`obsolescenceBadgeReads.test.ts`),
// the board move (`tests/boards/markedCardMove.test.ts`), the saved filter
// (`tests/filters/obsolescenceFilter.test.ts`).
const { session, activeCtx } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

import { execFileSync } from 'node:child_process';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { PATCH } from '@/app/api/v1/work-items/[key]/route';
import { POST as TRANSITION } from '@/app/api/v1/work-items/[key]/transitions/route';
import { POST as movePOST } from '@/app/api/board/move/route';
import { changeStatusAction, updateIssueAction } from '@/app/(authed)/items/[key]/edit/actions';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { runCreateWorkItem } from '@/lib/mcp/tools/createWorkItem';
import { runTransitionStatus } from '@/lib/mcp/tools/transitionStatus';
import { runUpdateWorkItem } from '@/lib/mcp/tools/updateWorkItem';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import type { WorkItemDto, WorkItemObsolescenceDto } from '@/lib/dto/workItems';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { dispatchedEvents, spyOnJobDispatch } from '../../helpers/jobs';

const DB_TEST_TIMEOUT_MS = 30_000;
const BASE = 'http://localhost:3000/api/v1';

let caller: V1ProjectCaller;
let dispatch: ReturnType<typeof spyOnJobDispatch>;

beforeEach(async () => {
  dispatch = spyOnJobDispatch();
  await truncateAuthTables();
  resetRateLimitStore();
  caller = await createV1ProjectCaller({ permissions: ['project:browse', 'work_item:edit'] });
  const fx = caller.fixture;
  session.current = { user: { id: fx.ownerId, email: fx.owner.email, name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── helpers ────────────────────────────────────────────────────────────────────

async function card(status: string, mark: WorkItemObsolescenceDto | null = null) {
  const item = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'story', title: `A ${status} story` },
    caller.ctx,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: { status, ...(mark ? { obsolescence: mark } : {}) },
  });
  return item;
}

async function row(id: string) {
  return adminDb.workItem.findUniqueOrThrow({ where: { id } });
}

async function revisions(id: string) {
  return adminDb.workItemRevision.count({ where: { workItemId: id } });
}

function transitionedEvents() {
  return dispatchedEvents(dispatch).filter((e) => e.name === 'work-item/transitioned');
}

function mcpText(res: CallToolResult): string {
  return res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

function restPatch(key: string, body: unknown) {
  return PATCH(
    new Request(`${BASE}/work-items/${key}`, {
      method: 'PATCH',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );
}

function restTransition(key: string, status: string) {
  return TRANSITION(
    new Request(`${BASE}/work-items/${key}/transitions`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
    { params: Promise.resolve({ key }) },
  );
}

async function boardMove(item: WorkItemDto, toStatus: string) {
  const statuses = await workflowsService.listStatusesByProject(
    caller.fixture.projectId,
    caller.fixture.workspaceId,
  );
  const fx = caller.fixture;
  const board = await adminDb.board.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'Board',
      type: 'kanban',
      position: 'a0',
    },
  });
  let toColumnId = '';
  for (const [n, status] of statuses.entries()) {
    const column = await adminDb.boardColumn.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        boardId: board.id,
        name: status.label,
        position: `c${n.toString(36)}`,
      },
    });
    await adminDb.boardColumnStatus.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        boardId: board.id,
        columnId: column.id,
        statusId: status.id,
      },
    });
    if (status.key === toStatus) toColumnId = column.id;
  }
  return movePOST(
    new Request('http://localhost:3000/api/board/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ boardId: board.id, workItemId: item.id, toColumnId }),
    }),
  );
}

// ── the WRITE doors ────────────────────────────────────────────────────────────

/** Each write door, as `(item, mark) → the door's own refusal code or null`. */
const WRITE_DOORS: Record<
  string,
  (item: WorkItemDto, mark: WorkItemObsolescenceDto) => Promise<string | null>
> = {
  // The item page and the quick view share this one action.
  'updateIssueAction (item page · quick view)': async (item, mark) => {
    const res = await updateIssueAction({ id: item.id, obsolescence: mark });
    return res.ok ? null : (res.code ?? res.error);
  },
  'MCP update_work_item': async (item, mark) => {
    const res = await runUpdateWorkItem({ key: item.identifier, obsolescence: mark }, caller.ctx);
    if (!res.isError) return null;
    return mcpText(res).includes('OBSOLESCENCE_REQUIRES_FINISHED')
      ? 'OBSOLESCENCE_REQUIRES_FINISHED'
      : mcpText(res);
  },
  'REST v1 PATCH': async (item, mark) => {
    const res = await restPatch(item.identifier, { obsolescence: mark });
    if (res.status === 200) return null;
    return ((await res.json()) as { code: string }).code;
  },
};

describe('every WRITE door answers the finished-card rule the same way', () => {
  for (const [door, write] of Object.entries(WRITE_DOORS)) {
    it.each(['todo', 'in_progress'])(
      `${door}: a mark on a \`%s\` card is OBSOLESCENCE_REQUIRES_FINISHED and writes nothing`,
      { timeout: DB_TEST_TIMEOUT_MS },
      async (status) => {
        const item = await card(status);
        expect(await write(item, 'outdated')).toBe('OBSOLESCENCE_REQUIRES_FINISHED');
        expect((await row(item.id)).obsolescence).toBeNull();
      },
    );
    it.each(['done', 'cancelled'])(
      `${door}: a mark on a \`%s\` card is accepted and reads back`,
      { timeout: DB_TEST_TIMEOUT_MS },
      async (status) => {
        const item = await card(status);
        expect(await write(item, 'deprecated')).toBeNull();
        expect((await row(item.id)).obsolescence).toBe('deprecated');
      },
    );
  }

  it(
    'MCP create_work_item refuses a mark at creation — the initial status is unfinished (REST v1 POST: `tests/api/v1/work-item-obsolescence-route.test.ts`)',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const before = await adminDb.workItem.count({
        where: { projectId: caller.fixture.projectId },
      });
      const mcp = await runCreateWorkItem(
        {
          projectKey: caller.projectKey,
          kind: 'task',
          title: 'Born marked',
          obsolescence: 'outdated',
        } as Parameters<typeof runCreateWorkItem>[0],
        caller.ctx,
      );
      expect(mcp.isError).toBe(true);
      expect(mcpText(mcp)).toContain('OBSOLESCENCE_REQUIRES_FINISHED');
      expect(await adminDb.workItem.count({ where: { projectId: caller.fixture.projectId } })).toBe(
        before,
      );
    },
  );

  it(
    'the quick view read carries the mark the door just wrote',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const item = await card('done');
      await updateIssueAction({
        id: item.id,
        obsolescence: 'outdated',
        obsolescenceNoteMd: 'See PROD-9.',
      });
      const view = await workItemsService.getQuickView(
        caller.fixture.projectId,
        item.identifier,
        'workspace',
        caller.ctx,
        'en',
      );
      expect(view).toMatchObject({ obsolescence: 'outdated', obsolescenceNoteMd: 'See PROD-9.' });
    },
  );
});

// ── the STATUS doors ───────────────────────────────────────────────────────────

/** Each status door, as `(item, to) → the door's refusal code, or null`. */
const STATUS_DOORS: Record<string, (item: WorkItemDto, to: string) => Promise<string | null>> = {
  'MCP transition_status': async (item, to) => {
    const res = await runTransitionStatus({ key: item.identifier, status: to }, caller.ctx);
    if (!res.isError) return null;
    return mcpText(res).includes('MARKED_CARD_CANNOT_REOPEN')
      ? 'MARKED_CARD_CANNOT_REOPEN'
      : mcpText(res);
  },
  'REST v1 transitions': async (item, to) => {
    const res = await restTransition(item.identifier, to);
    if (res.status === 200) return null;
    return ((await res.json()) as { code: string }).code;
  },
  changeStatusAction: async (item, to) => {
    const res = await changeStatusAction({ id: item.id, toStatusKey: to });
    return res.ok ? null : (res.code ?? res.error);
  },
  'POST /api/board/move': async (item, to) => {
    const res = await boardMove(item, to);
    if (res.status === 200) return null;
    return ((await res.json()) as { code: string }).code;
  },
};

describe('every STATUS door refuses to reopen a marked card', () => {
  for (const [door, move] of Object.entries(STATUS_DOORS)) {
    it.each(['outdated', 'deprecated'] as const)(
      `${door}: a \`%s\` card to todo is MARKED_CARD_CANNOT_REOPEN — no move, no revision, no event`,
      { timeout: DB_TEST_TIMEOUT_MS },
      async (mark) => {
        const item = await card('done', mark);
        const revs = await revisions(item.id);
        dispatch.mockClear();

        expect(await move(item, 'todo')).toBe('MARKED_CARD_CANNOT_REOPEN');

        expect((await row(item.id)).status).toBe('done');
        expect(await revisions(item.id)).toBe(revs);
        expect(transitionedEvents()).toEqual([]);
      },
    );

    it(
      `${door}: once the mark is cleared, the same reopen goes through`,
      { timeout: DB_TEST_TIMEOUT_MS },
      async () => {
        const item = await card('done', 'outdated');
        await updateIssueAction({ id: item.id, obsolescence: null });
        // `done → in_progress` is an edge of the default workflow; `done → todo` is not.
        expect(await move(item, 'in_progress')).toBeNull();
        expect((await row(item.id)).status).toBe('in_progress');
      },
    );
  }

  it(
    'a move WITHIN the done category is not a reopen (on a workflow that draws the edge)',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const fx = caller.fixture;
      const statuses = await workflowsService.listStatusesByProject(fx.projectId, fx.workspaceId);
      const byKey = new Map(statuses.map((s) => [s.key, s.id]));
      await adminDb.workflowTransition.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          fromStatusId: byKey.get('done')!,
          toStatusId: byKey.get('cancelled')!,
        },
      });
      for (const move of Object.values(STATUS_DOORS)) {
        const item = await card('done', 'outdated');
        expect(await move(item, 'cancelled')).toBeNull();
        expect((await row(item.id)).status).toBe('cancelled');
      }
    },
  );
});

// ── a CUSTOM done category ─────────────────────────────────────────────────────

describe('a custom done-category status (`shipped`) is finished both ways', () => {
  beforeEach(async () => {
    const fx = caller.fixture;
    const shipped = await adminDb.workflowStatus.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'shipped',
        label: 'Shipped',
        category: 'done',
        position: 'z9',
      },
    });
    const statuses = await workflowsService.listStatusesByProject(fx.projectId, fx.workspaceId);
    const inProgress = statuses.find((s) => s.key === 'in_progress')!;
    await adminDb.workflowTransition.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        fromStatusId: shipped.id,
        toStatusId: inProgress.id,
      },
    });
  });

  it('accepts a mark at `shipped`', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const item = await card('shipped');
    const res = await updateIssueAction({ id: item.id, obsolescence: 'outdated' });
    expect(res.ok).toBe(true);
    expect((await row(item.id)).obsolescence).toBe('outdated');
  });

  it(
    'refuses a reopen FROM `shipped` on a legal edge',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const item = await card('shipped', 'deprecated');
      const res = await changeStatusAction({ id: item.id, toStatusKey: 'in_progress' });
      expect(res).toMatchObject({
        ok: false,
        code: 'MARKED_CARD_CANNOT_REOPEN',
        mark: 'deprecated',
      });
      expect((await row(item.id)).status).toBe('shipped');
    },
  );
});

// ── the architecture guard ─────────────────────────────────────────────────────

describe('ONE finished-card predicate', () => {
  it('`function canCarryObsolescence` is defined exactly once, in lib/issues/obsolescence.ts', () => {
    const out = execFileSync(
      'git',
      ['grep', '-n', 'function canCarryObsolescence', '--', 'lib', 'app', 'components'],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(
      /^lib\/issues\/obsolescence\.ts:\d+:export function canCarryObsolescence/,
    );
  });
});
