import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { AssigneeNotInWorkspaceError } from '@/lib/workItems/errors';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { runClaimNextReady } from '@/lib/mcp/tools/claimNextReady';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
// Shared with `claimWorkItem.test.ts` (MOTIR-2961): one warm-up, one raw
// statement — see `tests/helpers/warmPool.ts` for why it is not copied.
import { warmPool } from '../helpers/warmPool';

// `claim_next_ready` (MOTIR-1330) — the ATOMIC, race-safe dispatch claim over
// real Postgres. The behaviour: pick the highest-ranked ready item in the ACTIVE
// sprint and flip it to in_progress IN ONE transaction (FOR UPDATE SKIP LOCKED),
// so two concurrent `motir run` sessions can NEVER claim the same item. The
// concurrency tests warm the pool first so the two racers each get their own
// physical connection — otherwise a cold pool serialises them and masks a race.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  // The assignment tests below spy on the repository seam (MOTIR-4996); a spy
  // left standing would leak into the next file's run.
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Priority = 'lowest' | 'low' | 'medium' | 'high' | 'highest';

async function makeReady(fx: WorkItemFixture, title: string, priority?: Priority) {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title,
      priority,
      assigneeId: null,
      descriptionMd: null,
    },
    fx.ctx,
  );
}

/** Create a sprint, drop the given items into it, and START it (→ active). */
async function activeSprintWith(fx: WorkItemFixture, itemIds: string[]): Promise<string> {
  const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Active' }, fx.ctx);
  if (itemIds.length > 0) {
    await adminDb.workItem.updateMany({
      where: { id: { in: itemIds } },
      data: { sprintId: sprint.id },
    });
  }
  await sprintsService.startSprint(sprint.id, {}, fx.ctx);
  return sprint.id;
}

async function statusOf(id: string): Promise<string> {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  return row.status;
}

async function rowOf(id: string) {
  return adminDb.workItem.findUniqueOrThrow({ where: { id } });
}

/** A SECOND workspace member — a real other claimant, and a real other assignee. */
async function otherMember(fx: WorkItemFixture): Promise<{ user: User; ctx: ServiceContext }> {
  const user = await usersService.createUser({
    email: `rival+${randomToken()}@example.com`,
    password: 'hunter2hunter2',
    name: 'Rival Runner',
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
}

/**
 * Did the claim write an ASSIGNEE? Read off the repository seam rather than off
 * the row, because the row cannot tell an assignment apart from its absence when
 * the value being written is the one already there — which is exactly the case
 * the no-op skip is about. `applyStatusTransition` writes the status through the
 * same method, so the question is per-CALL, not "was it called".
 */
function assignedThrough(spy: MockInstance<typeof workItemRepository.update>): boolean {
  return spy.mock.calls.some(([, patch]) => 'assigneeId' in patch);
}

describe('claimNextReady — atomic dispatch claim', () => {
  it('claims the highest-ranked ready item in the active sprint and flips it to in_progress', async () => {
    const fx = await makeWorkItemFixture();
    const top = await makeReady(fx, 'top', 'highest');
    const low = await makeReady(fx, 'low', 'low');
    const sprintId = await activeSprintWith(fx, [top.id, low.id]);

    const claimed = await workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx);
    expect(claimed?.key).toBe(top.identifier);
    expect(claimed?.status.category).toBe('in_progress');
    expect(await statusOf(top.id)).toBe('in_progress');
    expect(await statusOf(low.id)).toBe('todo'); // the lower-ranked item is untouched
  });

  it('a second claim returns the NEXT item; a third (none left) returns null', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeReady(fx, 'a', 'highest');
    const b = await makeReady(fx, 'b', 'high');
    const sprintId = await activeSprintWith(fx, [a.id, b.id]);

    const first = await workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx);
    const second = await workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx);
    const third = await workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx);

    expect(first?.key).toBe(a.identifier);
    expect(second?.key).toBe(b.identifier);
    expect(third).toBeNull();
  });

  it('ignores ready items that are NOT in the active sprint', async () => {
    const fx = await makeWorkItemFixture();
    const inSprint = await makeReady(fx, 'in', 'medium');
    const backlog = await makeReady(fx, 'backlog', 'highest'); // higher rank, but unsprinted
    const sprintId = await activeSprintWith(fx, [inSprint.id]); // backlog item left out

    const claimed = await workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx);
    expect(claimed?.key).toBe(inSprint.identifier);
    expect(await statusOf(backlog.id)).toBe('todo'); // never claimed
  });

  it('returns null when the active sprint has no ready item', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await activeSprintWith(fx, []);
    expect(await workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx)).toBeNull();
  });

  it('with NO sprint scope (null), claims across the whole project — no sprint required', async () => {
    const fx = await makeWorkItemFixture();
    const top = await makeReady(fx, 'top', 'highest');
    await makeReady(fx, 'low', 'low');

    const claimed = await workItemsService.claimNextReady(fx.projectId, null, fx.ctx);
    expect(claimed?.key).toBe(top.identifier);
    expect(claimed?.status.category).toBe('in_progress');
    expect(await statusOf(top.id)).toBe('in_progress');
  });

  it('two concurrent claims take TWO DIFFERENT items — never double-claim (warm pool)', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeReady(fx, 'a', 'highest');
    const b = await makeReady(fx, 'b', 'high');
    const sprintId = await activeSprintWith(fx, [a.id, b.id]);

    await warmPool();
    const [r1, r2] = await Promise.all([
      workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx),
      workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx),
    ]);

    expect(r1?.key).not.toBe(r2?.key); // distinct — no double-claim
    expect([r1?.key, r2?.key].sort()).toEqual([a.identifier, b.identifier].sort());
    expect(await statusOf(a.id)).toBe('in_progress');
    expect(await statusOf(b.id)).toBe('in_progress');
  });

  it('with ONE ready item, two concurrent claims: exactly one wins, the other gets null (warm pool)', async () => {
    const fx = await makeWorkItemFixture();
    const only = await makeReady(fx, 'only', 'highest');
    const sprintId = await activeSprintWith(fx, [only.id]);

    await warmPool();
    const results = await Promise.all([
      workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx),
      workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.find((r) => r !== null)?.key).toBe(only.identifier);
    expect(await statusOf(only.id)).toBe('in_progress');
  });
});

describe('claimNextReady — the claim ASSIGNS (MOTIR-4996)', () => {
  it('assigns the claimed item to the caller as well as flipping it to in_progress', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeReady(fx, 'unowned', 'highest');
    const sprintId = await activeSprintWith(fx, [item.id]);

    const claimed = await workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx);

    expect(claimed?.key).toBe(item.identifier);
    // BOTH writes landed. Until MOTIR-4996 only the second one did, and the card
    // read In Progress with nobody on it on every call of the only door an MCP
    // client has.
    const row = await rowOf(item.id);
    expect(row.status).toBe('in_progress');
    expect(row.assigneeId).toBe(fx.ownerId);
  });

  it('rolls the assignment back when the flip fails — ONE transaction, not two writes', async () => {
    // The assignment sits inside the same `withWorkspaceContext` transaction as
    // the transition, which is only observable when one half fails: a card left
    // assigned to a caller that never got it is the state a second, unlocked
    // write would produce.
    const fx = await makeWorkItemFixture();
    const item = await makeReady(fx, 'flip explodes', 'highest');
    const sprintId = await activeSprintWith(fx, [item.id]);
    vi.spyOn(workItemsService, 'applyStatusTransition').mockRejectedValue(new Error('boom'));

    await expect(workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx)).rejects.toThrow(
      'boom',
    );

    const row = await rowOf(item.id);
    expect(row.assigneeId).toBeNull();
    expect(row.status).toBe('todo');
  });

  it('writes NO assignment when the card is already assigned to the caller (the no-op skip)', async () => {
    // An update that changes nothing still bumps `updatedAt`, and `updatedAt` is
    // what a rollback test reads — the reason `claimWorkItem` and `assignManyTo`
    // both skip. A card sitting at `todo` while assigned to its future claimant
    // is ordinary: an assignment is a LABEL, and a planner can write one long
    // before anybody starts.
    const fx = await makeWorkItemFixture();
    const item = await makeReady(fx, 'pre-assigned', 'highest');
    await workItemsService.updateWorkItem(item.id, { assigneeId: fx.ownerId }, fx.ctx);
    const sprintId = await activeSprintWith(fx, [item.id]);
    const updateSpy = vi.spyOn(workItemRepository, 'update');

    const claimed = await workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx);

    expect(claimed?.key).toBe(item.identifier);
    expect(assignedThrough(updateSpy)).toBe(false);
    const row = await rowOf(item.id);
    expect(row.assigneeId).toBe(fx.ownerId);
    expect(row.status).toBe('in_progress');
  });

  it('TAKES a card assigned to somebody else — the assignee is a label, not a lock', async () => {
    // Deliberate, and pinned here so a later reader does not "fix" it into a
    // refusal: taking a card off a teammate is a thing a person is allowed to
    // decide, and the claim's job is to make sure the board says who has it now.
    const fx = await makeWorkItemFixture();
    const rival = await otherMember(fx);
    const item = await makeReady(fx, "somebody else's", 'highest');
    await workItemsService.updateWorkItem(item.id, { assigneeId: rival.user.id }, fx.ctx);
    const sprintId = await activeSprintWith(fx, [item.id]);

    const claimed = await workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx);

    expect(claimed?.key).toBe(item.identifier);
    expect((await rowOf(item.id)).assigneeId).toBe(fx.ownerId);
  });

  it('refuses a non-member caller BEFORE the claim transaction — no candidate is locked', async () => {
    // The member pre-flight runs ahead of the transaction, so a refusal never
    // takes a lock (and never pays for the ready-set computation either). The
    // ORDERING is the assertion: the refusal alone would pass with the check
    // anywhere.
    const fx = await makeWorkItemFixture();
    const item = await makeReady(fx, 'never reached', 'highest');
    const sprintId = await activeSprintWith(fx, [item.id]);
    // The membership read the gate makes, forced to "not a member". Nothing
    // earlier in the method reads a membership row, so this narrows to the gate.
    vi.spyOn(workspaceMembershipRepository, 'findByUserAndWorkspaceInTx').mockResolvedValue(null);
    const candidateSpy = vi.spyOn(workItemRepository, 'claimNextReadyCandidate');

    await expect(
      workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx),
    ).rejects.toBeInstanceOf(AssigneeNotInWorkspaceError);

    expect(candidateSpy).not.toHaveBeenCalled();
    expect(await statusOf(item.id)).toBe('todo');
  });

  it('two concurrent claimers take two DIFFERENT items, each assigned to ITS OWN caller (warm pool)', async () => {
    const fx = await makeWorkItemFixture();
    const rival = await otherMember(fx);
    const a = await makeReady(fx, 'a', 'highest');
    const b = await makeReady(fx, 'b', 'high');
    const sprintId = await activeSprintWith(fx, [a.id, b.id]);

    await warmPool();
    const [mine, theirs] = await Promise.all([
      workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx),
      workItemsService.claimNextReady(fx.projectId, sprintId, rival.ctx),
    ]);

    expect(mine?.key).not.toBe(theirs?.key);
    const idOf = (key: string | undefined) => (key === a.identifier ? a.id : b.id);
    // Each row carries the caller that actually took it — not whichever claim
    // committed last.
    expect((await rowOf(idOf(mine?.key))).assigneeId).toBe(fx.ownerId);
    expect((await rowOf(idOf(theirs?.key))).assigneeId).toBe(rival.user.id);
  });

  it('the returned dispatch payload names the CLAIMER, not the pre-claim assignee', async () => {
    // The candidate row is read before the claim, so its assignee columns hold
    // the value the claim just overwrote. Reporting that would make the one
    // response proving the claim assigned say it did not.
    const fx = await makeWorkItemFixture();
    const item = await makeReady(fx, 'payload truth', 'highest');
    const sprintId = await activeSprintWith(fx, [item.id]);

    const claimed = await workItemsService.claimNextReady(fx.projectId, sprintId, fx.ctx);

    expect(claimed?.assignee?.id).toBe(fx.ownerId);
    expect(claimed?.assignee?.name).toBe(fx.owner.name);
  });
});

describe('runClaimNextReady — the MCP tool', () => {
  it('no active sprint → claims the top ready item project-wide (Kanban, no sprint required)', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeReady(fx, 'kanban', 'highest'); // ready, in the backlog, no sprint
    const res = await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx);
    const sc = res.structuredContent as {
      item: { key: string; status: { category: string } } | null;
    };
    expect(sc.item?.key).toBe(item.identifier);
    expect(sc.item?.status.category).toBe('in_progress');
    expect(await statusOf(item.id)).toBe('in_progress');
  });

  it('claims and returns the dispatch payload (status now in_progress) through the tool', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeReady(fx, 'claimable', 'highest');
    await activeSprintWith(fx, [item.id]);
    const res = await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx);
    const sc = res.structuredContent as {
      item: {
        key: string;
        status: { category: string };
        runCommand: string;
        assigneeId: string | null;
      } | null;
    };
    expect(sc.item?.key).toBe(item.identifier);
    expect(sc.item?.status.category).toBe('in_progress');
    expect(sc.item?.runCommand).toBe(`motir run ${item.identifier}`);
    // MOTIR-4996 — the caller's own claim, readable in the payload it gets back.
    expect(sc.item?.assigneeId).toBe(fx.ownerId);
    expect(res.content[0]).toMatchObject({
      text: expect.stringContaining('assigned to you'),
    });
  });

  it('active sprint but nothing ready → empty result with reason "none_ready"', async () => {
    const fx = await makeWorkItemFixture();
    await activeSprintWith(fx, []);
    const res = await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx);
    const sc = res.structuredContent as { item: unknown; reason?: string };
    expect(sc.item).toBeNull();
    expect(sc.reason).toBe('none_ready');
  });
});
