import type { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { CUSTOM_ROLE_TIER, ROLE_GATED_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import type { HomeActorContext } from '@/lib/services/homeService';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { createTestUser } from './fixtures/userFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// THE APPROVALS ROOM's READ (Story MOTIR-5299 · MOTIR-5301), against a REAL
// Postgres.
//
// What makes each assertion here mean something:
//
//   · THE VIEW AND THE POPULATION DIFFER. Every fixture holds records the reader
//     must NOT see — another person's decision, a gate routed to somebody else, a
//     superseded question — so a read that ignored the scope returns a different
//     number from one that applied it.
//   · ABSENT FROM THE READ, NOT HIDDEN BY A COMPONENT. Every leakage assertion drives
//     the service directly, with the row present in the database.
//   · THE SCOPE FOLLOWS A PERMISSION. A custom role holding only browse + the key
//     gets the full view; a custom role holding every other role-gated key does not.

let fx: WorkItemFixture;
/** Holds `approval:view_any` — the workspace owner, through the always-pass rail. */
let ownerCtx: HomeActorContext;
/** A plain workspace member on the open project — no key. */
let memberCtx: HomeActorContext;
let memberId: string;
/** A second plain member, whose records the first must never see. */
let otherId: string;
let storyId: string;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  ownerCtx = { ...fx.ctx, projectId: fx.projectId };
  const member = await createTestUser({ email: 'member@ex.com', name: 'Mara Member' });
  await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
  memberId = member.id;
  memberCtx = { userId: member.id, workspaceId: fx.workspaceId, projectId: fx.projectId };
  const other = await createTestUser({ email: 'other@ex.com', name: 'Otto Other' });
  await workspacesService.addMember({ userId: other.id, workspaceId: fx.workspaceId });
  otherId = other.id;
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'The Approvals room' },
    fx.ctx,
  );
  storyId = story.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type GateState = 'awaiting' | 'approved' | 'changes_requested' | 'superseded' | 'overturned';

/** One card carrying one gate, with its routing and — when decided — its audit set. */
async function gate(opts: {
  title: string;
  state: GateState;
  assigneeId?: string | null;
  decidedById?: string;
  createdAt?: Date;
  decidedAt?: Date;
}) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: storyId, title: opts.title },
    fx.ctx,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: { assigneeId: opts.assigneeId ?? null },
  });
  const row = await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      kind: 'design_result',
      subjectId: `evidence-${item.id}`,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
  if (opts.state !== 'awaiting') {
    const decided = opts.state !== 'superseded';
    await adminDb.approvalGate.update({
      where: { id: row.id },
      data: {
        state: opts.state,
        ...(decided
          ? {
              decidedById: opts.decidedById ?? fx.ownerId,
              decidedAt: opts.decidedAt ?? new Date(),
              decidedByLabel: `label-of-${opts.decidedById ?? fx.ownerId}`,
              subjectVersion: `v-${opts.title}`,
            }
          : {}),
      },
    });
  }
  return { itemId: item.id, gateId: row.id };
}

const titles = (page: Awaited<ReturnType<typeof approvalGatesService.listRecords>>) => ({
  awaiting: page.sections.awaiting.items.map((r) => r.workItem.title),
  decided: page.sections.decided.items.map((r) => r.workItem.title),
});

/** Every shape a record can take, from both readers' side. */
async function seedPopulation() {
  const t0 = Date.UTC(2026, 8, 1);
  await gate({
    title: 'awaiting-me',
    state: 'awaiting',
    assigneeId: memberId,
    createdAt: new Date(t0 + 2_000),
  });
  await gate({
    title: 'awaiting-other',
    state: 'awaiting',
    assigneeId: otherId,
    createdAt: new Date(t0 + 1_000),
  });
  await gate({
    title: 'approved-by-me',
    state: 'approved',
    decidedById: memberId,
    decidedAt: new Date(t0 + 10_000),
  });
  await gate({
    title: 'changes-by-me',
    state: 'changes_requested',
    decidedById: memberId,
    decidedAt: new Date(t0 + 20_000),
  });
  await gate({
    title: 'approved-by-other',
    state: 'approved',
    decidedById: otherId,
    decidedAt: new Date(t0 + 30_000),
  });
  await gate({ title: 'superseded', state: 'superseded', assigneeId: memberId });
}

describe('an OVERTURN is a decision the room lists (MOTIR-5956)', () => {
  it('lists an overturned gate among the decided rows, with its state', async () => {
    await gate({
      title: 'overturned-by-me',
      state: 'overturned',
      decidedById: memberId,
      decidedAt: new Date(),
    });
    const page = await approvalGatesService.listRecords(memberCtx, { limit: 100 });
    expect(titles(page).decided).toEqual(['overturned-by-me']);
    expect(page.sections.decided.items[0]!.state).toBe('overturned');
    expect(page.sections.decided.total).toBe(1);
  });
});

describe('a reader WITHOUT `approval:view_any` — their own records only', () => {
  it('sees what is routed to them and awaiting, and what they decided — nothing else', async () => {
    await seedPopulation();
    const page = await approvalGatesService.listRecords(memberCtx);
    expect(page.fullView).toBe(false);
    expect(titles(page)).toEqual({
      awaiting: ['awaiting-me'],
      // `changes_requested` IS a decision, and it is theirs.
      decided: ['changes-by-me', 'approved-by-me'],
    });
    expect(page.sections.awaiting.total).toBe(1);
    expect(page.sections.decided.total).toBe(2);
    expect(page.total).toBe(3);
  });

  it('a record decided by somebody else is ABSENT from the read — the row exists, the read omits it', async () => {
    await seedPopulation();
    expect(
      await adminDb.approvalGate.count({ where: { decidedById: otherId, state: 'approved' } }),
    ).toBe(1);
    const page = await approvalGatesService.listRecords(memberCtx, { limit: 100 });
    const everyTitle = [...titles(page).awaiting, ...titles(page).decided];
    expect(everyTitle).not.toContain('approved-by-other');
    expect(everyTitle).not.toContain('awaiting-other');
  });

  it('`superseded` is in neither section — nobody decided it', async () => {
    await seedPopulation();
    const page = await approvalGatesService.listRecords(memberCtx);
    expect([...titles(page).awaiting, ...titles(page).decided]).not.toContain('superseded');
  });

  it('no argument widens the scope — the view is not a parameter', async () => {
    await seedPopulation();
    const smuggled = { limit: 100, fullView: true, scope: 'project' } as unknown as Parameters<
      typeof approvalGatesService.listRecords
    >[1];
    const page = await approvalGatesService.listRecords(memberCtx, smuggled);
    expect(page.fullView).toBe(false);
    expect([...titles(page).awaiting, ...titles(page).decided]).not.toContain('approved-by-other');
  });
});

describe('a reader HOLDING `approval:view_any` — every record of the project', () => {
  it('sees other people`s pending and decided records, and still no superseded one', async () => {
    await seedPopulation();
    const page = await approvalGatesService.listRecords(ownerCtx);
    expect(page.fullView).toBe(true);
    expect(titles(page)).toEqual({
      // `createdAt asc`: the other's gate was asked first.
      awaiting: ['awaiting-other', 'awaiting-me'],
      // `decidedAt desc`: most recently decided first.
      decided: ['approved-by-other', 'changes-by-me', 'approved-by-me'],
    });
    expect(page.total).toBe(5);
  });

  it('a decided row carries the record — who, when, and on which bytes', async () => {
    await seedPopulation();
    const page = await approvalGatesService.listRecords(ownerCtx);
    const row = page.sections.decided.items.find((r) => r.workItem.title === 'approved-by-other');
    expect(row).toMatchObject({
      state: 'approved',
      decidedByLabel: `label-of-${otherId}`,
      subjectVersion: 'v-approved-by-other',
      decidedAt: new Date(Date.UTC(2026, 8, 1) + 30_000).toISOString(),
    });
  });
});

describe('the view follows the PERMISSION, never a role name', () => {
  async function putOnCustomRole(userId: string, name: string, permissions: string[]) {
    await projectMembersService.addMember({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: userId,
      role: 'member',
    });
    const definition = await adminDb.projectRoleDefinition.create({
      data: { workspaceId: fx.workspaceId, projectId: fx.projectId, name, permissions },
    });
    await adminDb.$transaction((tx) =>
      projectMembershipRepository.setRoleDefinition(
        userId,
        fx.projectId,
        { roleDefinitionId: definition.id, role: CUSTOM_ROLE_TIER },
        tx,
      ),
    );
  }

  it('a custom role holding ONLY browse + `approval:view_any` gets the full view', async () => {
    await seedPopulation();
    await putOnCustomRole(memberId, 'Approvals lead', ['project:browse', 'approval:view_any']);
    const page = await approvalGatesService.listRecords(memberCtx, { limit: 100 });
    expect(page.fullView).toBe(true);
    expect(titles(page).decided).toContain('approved-by-other');
  });

  it('a custom role holding EVERY other role-gated key, but not `approval:view_any`, does not', async () => {
    await seedPopulation();
    await putOnCustomRole(
      memberId,
      'Everything but the room',
      ROLE_GATED_PERMISSIONS.filter((key) => key !== 'approval:view_any'),
    );
    const page = await approvalGatesService.listRecords(memberCtx, { limit: 100 });
    expect(page.fullView).toBe(false);
    expect(titles(page).decided).not.toContain('approved-by-other');
    expect(titles(page).decided).toEqual(['changes-by-me', 'approved-by-me']);
  });
});

describe('one window over two sections', () => {
  it('windows awaiting-then-decided as one list, and clamps a page past the end', async () => {
    const t0 = Date.UTC(2026, 8, 1);
    for (let i = 0; i < 3; i++) {
      await gate({
        title: `a${i}`,
        state: 'awaiting',
        assigneeId: memberId,
        createdAt: new Date(t0 + i),
      });
    }
    for (let i = 0; i < 2; i++) {
      await gate({
        title: `d${i}`,
        state: 'approved',
        decidedById: memberId,
        decidedAt: new Date(t0 + 100 + i),
      });
    }
    const at = (page: number) => approvalGatesService.listRecords(memberCtx, { limit: 2, page });

    const p1 = await at(1);
    expect(titles(p1)).toEqual({ awaiting: ['a0', 'a1'], decided: [] });
    const p2 = await at(2);
    expect(titles(p2)).toEqual({ awaiting: ['a2'], decided: ['d1'] });
    const p3 = await at(3);
    expect(titles(p3)).toEqual({ awaiting: [], decided: ['d0'] });

    // The section totals are over EVERY page, and they sum to the denominator.
    for (const page of [p1, p2, p3]) {
      expect(page.sections.awaiting.total).toBe(3);
      expect(page.sections.decided.total).toBe(2);
      expect(page.total).toBe(5);
    }
    const past = await at(99);
    expect(past.page).toBe(3);
    expect(titles(past)).toEqual(titles(p3));
  });

  it('a reader with no records gets two empty sections and page one — not an error', async () => {
    const page = await approvalGatesService.listRecords(memberCtx);
    expect(page).toMatchObject({ total: 0, page: 1, fullView: false });
    expect(page.sections.awaiting).toEqual({ items: [], total: 0 });
    expect(page.sections.decided).toEqual({ items: [], total: 0 });
  });
});

describe('the browse floor', () => {
  it('a reader who may not browse the active project reads nothing, and no full view', async () => {
    await seedPopulation();
    await projectMembersService.setAccessLevel({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      level: 'private',
    });
    // Going private seeds the then-current workspace members as project members;
    // take this reader's away, so they genuinely may not browse it.
    await adminDb.projectMembership.deleteMany({
      where: { userId: memberId, projectId: fx.projectId },
    });
    const page = await approvalGatesService.listRecords(memberCtx, { limit: 100 });
    expect(page.fullView).toBe(false);
    expect(page.total).toBe(0);
  });
});

describe('the repository reads take `tx` and hold under RLS', () => {
  it('both reads answer under `withWorkspaceContext`', async () => {
    await seedPopulation();
    const scope = { projectIds: [fx.projectId], userId: memberId, fullView: false };
    const [awaiting, decided] = await withWorkspaceContext(fx.ctx, async (tx) => [
      await approvalGateRepository.findRecordsAwaiting(scope, { skip: 0, take: 50 }, tx),
      await approvalGateRepository.findRecordsDecided(scope, { skip: 0, take: 50 }, tx),
    ]);
    expect(awaiting.map((r) => r.workItem!.title)).toEqual(['awaiting-me']);
    expect(decided.map((r) => r.workItem!.title)).toEqual(['changes-by-me', 'approved-by-me']);
  });

  it('as `motir_app` bound to ANOTHER workspace, a full-view read of this project returns nothing', async () => {
    await seedPopulation();
    const foreign = await makeWorkItemFixture({ name: 'Bravo', identifier: 'BRAVO' });
    const scope = { projectIds: [fx.projectId], userId: fx.ownerId, fullView: true };
    const read = (workspaceId: string) =>
      db.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${fx.ownerId}, true)`;
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
        await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
        return {
          awaiting: await approvalGateRepository.countRecordsAwaiting(scope, tx),
          decided: await approvalGateRepository.countRecordsDecided(scope, tx),
        };
      });
    // Control: the same read bound to the right workspace sees the population.
    expect(await read(fx.workspaceId)).toEqual({ awaiting: 2, decided: 3 });
    expect(await read(foreign.workspaceId)).toEqual({ awaiting: 0, decided: 0 });
  });
});
