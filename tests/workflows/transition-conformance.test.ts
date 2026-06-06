import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { IllegalTransitionError, UnknownStatusError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { DEFAULT_STATUSES, DEFAULT_TRANSITIONS } from '@/lib/workflows/defaultWorkflow';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';

// Graph-COMPLETE conformance guard over the default workflow (Subtask 2.6.2),
// consolidating what `transition-validation.test.ts` only SAMPLES. Everything
// is driven through the shipped path — `workItemsService.updateStatus`, which
// `workflowsService.canTransition` gates — against a `createTestProject`
// project (auto-seeds the six default statuses + fifteen transitions). Real
// Postgres; runs in CI.
//
// The legal-edge and illegal-non-edge sets are DERIVED FROM the
// `defaultWorkflow.ts` constant (NOT a hardcoded copy), so adding a status or
// transition to the constant automatically extends the sweep. Because the SEED
// also reads the same constant (`seedDefaultWorkflow` iterates
// DEFAULT_TRANSITIONS at project-create time), the behavioral sweep alone moves
// in lockstep with the seed — so it is paired with an explicit **literal pin**
// (the "graph shape is locked" describe) that fails the instant the constant's
// status set or edge set changes. That pin is what makes "locally delete one
// edge from defaultWorkflow.ts → this suite fails" true (manually verified for
// the PR), forcing any workflow-graph edit to consciously update this guard.

const STATUS_KEYS: string[] = DEFAULT_STATUSES.map((s) => s.key);
const EDGES: Array<[string, string]> = DEFAULT_TRANSITIONS.map(([from, to]) => [from, to]);
const edgeKey = (from: string, to: string): string => `${from}>${to}`;
const EDGE_SET = new Set(EDGES.map(([from, to]) => edgeKey(from, to)));

// The full 6×6 grid, partitioned by membership in the default edge set.
const ALL_PAIRS: Array<[string, string]> = STATUS_KEYS.flatMap((from) =>
  STATUS_KEYS.map((to): [string, string] => [from, to]),
);
const NON_EDGES: Array<[string, string]> = ALL_PAIRS.filter(
  ([from, to]) => from !== to && !EDGE_SET.has(edgeKey(from, to)),
);

let ctx: ServiceContext;
let workspaceId: string;
let restrictedProjectId: string;
let restrictedItemId: string;
let openItemId: string;

// One shared fixture for the whole file (the sweep repositions a single item's
// status via a direct DB write between cases — see setStatus — so we don't pay
// per-pair project/seed setup). A SEPARATE open-mode project keeps the two
// policy modes isolated regardless of test order.
beforeAll(async () => {
  await truncateAuthTables();
  const user = await usersService.createUser({
    email: 'tc@example.com',
    password: 'hunter2hunter2',
    name: 'TC User',
  });
  const ws = await workspacesService.createWorkspace({ name: 'TC WS', ownerUserId: user.id });
  ctx = { userId: user.id, workspaceId: ws.workspace.id };
  workspaceId = ws.workspace.id;

  const restricted = await createTestProject({ workspaceId, actorUserId: user.id });
  restrictedProjectId = restricted.id;
  restrictedItemId = (
    await workItemsService.createWorkItem(
      { projectId: restricted.id, kind: 'task', title: 'Restricted' },
      ctx,
    )
  ).id;

  const open = await createTestProject({
    workspaceId,
    actorUserId: user.id,
    name: 'Open',
    identifier: 'OPN',
  });
  await db.project.update({ where: { id: open.id }, data: { workflowPolicyMode: 'open' } });
  openItemId = (
    await workItemsService.createWorkItem({ projectId: open.id, kind: 'task', title: 'Open' }, ctx)
  ).id;
});

afterAll(async () => {
  await db.$disconnect();
});

/** Position an item in `status` directly (test setup) — bypasses the service so
 *  reaching a `from` state never depends on the transition graph under test. A
 *  direct DB write records NO revision, so the ledger only grows from the
 *  `updateStatus` calls we assert on. */
function setStatus(itemId: string, status: string): Promise<unknown> {
  return db.workItem.update({ where: { id: itemId }, data: { status } });
}
async function revisionCount(itemId: string): Promise<number> {
  return (await workItemRevisionRepository.listByWorkItem(itemId)).length;
}

describe('default workflow — graph shape is locked (literal pin, constant-derived guard)', () => {
  // This is the guard the card's "delete one edge → suite fails" step exercises:
  // the seed and the behavioral sweep both read DEFAULT_TRANSITIONS, so only a
  // pin against literals catches an edit to the constant itself.
  it('declares exactly the six default statuses', () => {
    expect(STATUS_KEYS).toEqual([
      'todo',
      'blocked',
      'in_progress',
      'in_review',
      'done',
      'cancelled',
    ]);
  });

  it('declares exactly the fifteen default transition edges (finding #45 count)', () => {
    expect(new Set(EDGES.map(([from, to]) => edgeKey(from, to)))).toEqual(
      new Set([
        'todo>in_progress',
        'in_progress>in_review',
        'in_review>done',
        'todo>blocked',
        'in_progress>blocked',
        'blocked>todo',
        'blocked>in_progress',
        'in_review>in_progress',
        'in_progress>todo',
        'done>in_progress',
        'cancelled>todo',
        'todo>cancelled',
        'in_progress>cancelled',
        'in_review>cancelled',
        'blocked>cancelled',
      ]),
    );
    expect(EDGES).toHaveLength(15);
  });

  it('partitions the 6×6 grid into 15 edges + 6 self-loops + 15 non-edges', () => {
    expect(NON_EDGES).toHaveLength(
      STATUS_KEYS.length * STATUS_KEYS.length - EDGES.length - STATUS_KEYS.length,
    );
    expect(NON_EDGES).toHaveLength(15);
  });
});

describe('restricted mode — every default edge is accepted (the full 15-edge sweep)', () => {
  it.each(EDGES)(
    '%s → %s transitions and records exactly one "updated" revision',
    async (from, to) => {
      await setStatus(restrictedItemId, from);
      const before = await revisionCount(restrictedItemId);

      const updated = await workItemsService.updateStatus(restrictedItemId, to, ctx);
      expect(updated.status).toBe(to);

      const revs = await workItemRevisionRepository.listByWorkItem(restrictedItemId);
      expect(revs.length).toBe(before + 1);
      expect(revs[0]!.changeKind).toBe('updated');
      expect((revs[0]!.diff as Record<string, unknown>).status).toEqual({ from, to });
    },
  );
});

describe('restricted mode — every non-edge, non-self pair is rejected (IllegalTransitionError)', () => {
  it.each(NON_EDGES)('%s → %s is rejected and leaves the status unchanged', async (from, to) => {
    await setStatus(restrictedItemId, from);
    await expect(workItemsService.updateStatus(restrictedItemId, to, ctx)).rejects.toThrow(
      IllegalTransitionError,
    );
    expect((await workItemsService.getWorkItem(restrictedItemId, ctx)).status).toBe(from);
  });
});

describe('restricted mode — a no-op self-transition writes no revision (all six statuses)', () => {
  it.each(STATUS_KEYS)('%s → %s is a no-op (status held, no revision)', async (status) => {
    await setStatus(restrictedItemId, status);
    const before = await revisionCount(restrictedItemId);
    const updated = await workItemsService.updateStatus(restrictedItemId, status, ctx);
    expect(updated.status).toBe(status);
    expect(await revisionCount(restrictedItemId)).toBe(before);
  });
});

describe('open mode — the full real×real product is accepted (edge set bypassed)', () => {
  it.each(ALL_PAIRS)('open: %s → %s is accepted regardless of the edge set', async (from, to) => {
    await setStatus(openItemId, from);
    const updated = await workItemsService.updateStatus(openItemId, to, ctx);
    expect(updated.status).toBe(to);
  });

  it('still rejects an unknown target status key (UnknownStatusError)', async () => {
    await setStatus(openItemId, 'todo');
    await expect(workItemsService.updateStatus(openItemId, 'ghost', ctx)).rejects.toThrow(
      UnknownStatusError,
    );
  });
});

describe('terminal-set conformance — category=done is exactly { done, cancelled } (finding #21)', () => {
  it('the seeded terminal set matches the readiness predicate set, derived not hardcoded', async () => {
    const terminal = await workflowsService.getTerminalStatusKeys(restrictedProjectId, workspaceId);
    expect(terminal).toEqual(new Set(['done', 'cancelled']));
    // …and it equals what the constant declares (the seed faithfully wrote it).
    const fromConstant = new Set(
      DEFAULT_STATUSES.filter((s) => s.category === 'done').map((s) => s.key),
    );
    expect(terminal).toEqual(fromConstant);
  });
});
