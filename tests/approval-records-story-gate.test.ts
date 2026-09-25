import { execFileSync } from 'node:child_process';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { CUSTOM_ROLE_TIER } from '@/lib/permissions/builtinRoles';
import { toApprovalRecordDecidedRowDto } from '@/lib/mappers/approvalGateMappers';
import type { HomeActorContext } from '@/lib/services/homeService';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { createTestUser } from './fixtures/userFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// STORY MOTIR-5299's VITEST GATE — the Approval records room (Subtask MOTIR-5303).
//
// ⚠️ WHAT THIS FILE IS, AND WHAT IT IS NOT. `tests/approval-gate-records.test.ts`
// (MOTIR-5301) already proves the read against a plain workspace member and the
// workspace OWNER, the cross-section window, the browse floor, RLS under
// `motir_app` and the `tx`-threaded repository reads; this file does not re-walk
// those. It is the residue the story gate owes:
//
//   · the readers are the BUILT-IN project roles — two `member`s and an `admin`
//     who is NOT a workspace manager — so the full view is shown to arrive through
//     `ROLE_GATED_PERMISSIONS` and not only through the owner/admin rail;
//   · C, on a CUSTOM role, WITH and then WITHOUT `approval:view_any` in one test:
//     the key is SUFFICIENT and NECESSARY. A member-and-admin suite passes against a
//     role check and a permission check alike; only a non-admin holding the key
//     tells them apart;
//   · ordering asserted on a fixture inserted in deliberately WRONG order;
//   · the guards a percentage cannot see, run as commands over the tree.

let fx: WorkItemFixture;
let storyId: string;
const ids: Record<'a' | 'b' | 'admin' | 'c', string> = { a: '', b: '', admin: '', c: '' };
const ctxOf = (userId: string): HomeActorContext => ({
  userId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
});

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  for (const [slot, role] of [
    ['a', 'member'],
    ['b', 'member'],
    ['admin', 'admin'],
    ['c', 'member'],
  ] as const) {
    const user = await createTestUser({ email: `${slot}@ex.com`, name: `Reader ${slot}` });
    await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
    await projectMembersService.addMember({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: user.id,
      role,
    });
    ids[slot] = user.id;
  }
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Story gate' },
    fx.ctx,
  );
  storyId = story.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function gate(opts: {
  title: string;
  state: 'awaiting' | 'approved' | 'changes_requested' | 'superseded';
  assigneeId?: string;
  decidedById?: string;
  createdAt: Date;
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
      subjectId: `ev-${item.id}`,
      createdAt: opts.createdAt,
    },
  });
  if (opts.state !== 'awaiting') {
    await adminDb.approvalGate.update({
      where: { id: row.id },
      data: {
        state: opts.state,
        ...(opts.decidedById
          ? {
              decidedById: opts.decidedById,
              decidedAt: opts.decidedAt,
              decidedByLabel: `label ${opts.decidedById}`,
              subjectVersion: `v-${opts.title}`,
            }
          : {}),
      },
    });
  }
}

/**
 * Every shape the story names, INSERTED IN THE WRONG ORDER: the newest-asked
 * pending gate first, the oldest-decided record first. A read that returned
 * insertion order would pass nothing below.
 */
async function seed() {
  const t = (s: number) => new Date(Date.UTC(2026, 8, 1) + s * 1000);
  await gate({ title: 'await-b-new', state: 'awaiting', assigneeId: ids.b, createdAt: t(40) });
  await gate({ title: 'await-a-new', state: 'awaiting', assigneeId: ids.a, createdAt: t(30) });
  await gate({ title: 'await-a-old', state: 'awaiting', assigneeId: ids.a, createdAt: t(10) });
  await gate({ title: 'await-b-old', state: 'awaiting', assigneeId: ids.b, createdAt: t(20) });
  await gate({
    title: 'dec-a-old',
    state: 'approved',
    decidedById: ids.a,
    createdAt: t(1),
    decidedAt: t(100),
  });
  await gate({
    title: 'dec-b',
    state: 'approved',
    decidedById: ids.b,
    createdAt: t(2),
    decidedAt: t(200),
  });
  await gate({
    title: 'changes-a',
    state: 'changes_requested',
    decidedById: ids.a,
    createdAt: t(3),
    decidedAt: t(300),
  });
  await gate({ title: 'superseded', state: 'superseded', createdAt: t(4) });
}

async function titlesFor(userId: string) {
  const page = await approvalGatesService.listRecords(ctxOf(userId), { limit: 100 });
  return {
    fullView: page.fullView,
    awaiting: page.sections.awaiting.items.map((r) => r.workItem?.title),
    decided: page.sections.decided.items.map((r) => r.workItem?.title),
  };
}

const EVERYTHING = {
  fullView: true,
  // createdAt asc — the reverse of insertion for the two `a` rows, interleaved with `b`.
  awaiting: ['await-a-old', 'await-b-old', 'await-a-new', 'await-b-new'],
  // decidedAt desc — the reverse of insertion.
  decided: ['changes-a', 'dec-b', 'dec-a-old'],
};

/**
 * MOTIR-6328 (DECISION MOTIR-6165 Q2) gives the built-in `member` and `viewer`
 * `approval:view_any`, so a built-in member now reads the WHOLE project. The
 * own-records half is still what a reader WITHOUT the key sees, so A and B are
 * put on a custom role carrying a member's acting keys minus the view key —
 * the exact shape a team uses to close the room — and keep proving it.
 */
async function withoutViewAny(userId: string) {
  const role = await adminDb.projectRoleDefinition.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: `No full view ${userId}`,
      permissions: ['project:browse', 'work_item:edit', 'comment:add'],
    },
  });
  await adminDb.$transaction((tx) =>
    projectMembershipRepository.setRoleDefinition(
      userId,
      fx.projectId,
      { roleDefinitionId: role.id, role: CUSTOM_ROLE_TIER },
      tx,
    ),
  );
}

describe('the built-in roles', () => {
  it('a built-in MEMBER reads everything but the superseded row (MOTIR-6328)', async () => {
    await seed();
    expect(await titlesFor(ids.a)).toEqual(EVERYTHING);
  });

  it('member A without the key reads only their own records — B’s decision is in the database and absent from the read', async () => {
    await seed();
    await withoutViewAny(ids.a);
    expect(await adminDb.approvalGate.count({ where: { decidedById: ids.b } })).toBe(1);
    expect(await titlesFor(ids.a)).toEqual({
      fullView: false,
      awaiting: ['await-a-old', 'await-a-new'],
      decided: ['changes-a', 'dec-a-old'],
    });
  });

  it('member B without the key reads only theirs — the fixture is symmetric, so neither view is an accident of seeding', async () => {
    await seed();
    await withoutViewAny(ids.b);
    expect(await titlesFor(ids.b)).toEqual({
      fullView: false,
      awaiting: ['await-b-old', 'await-b-new'],
      decided: ['dec-b'],
    });
  });

  it('the built-in project ADMIN — not a workspace manager — reads everything but the superseded row', async () => {
    await seed();
    const membership = await adminDb.workspaceMembership.findFirst({
      where: { userId: ids.admin, workspaceId: fx.workspaceId },
    });
    expect(membership?.role).toBe('member');
    expect(await titlesFor(ids.admin)).toEqual(EVERYTHING);
  });
});

describe('the view follows `approval:view_any` — sufficient AND necessary, on a custom role', () => {
  it('C with browse + the key reads everything; the same C with the key removed reads only their own', async () => {
    await seed();
    const role = await adminDb.projectRoleDefinition.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'Approvals lead',
        permissions: ['project:browse', 'approval:view_any'],
      },
    });
    await adminDb.$transaction((tx) =>
      projectMembershipRepository.setRoleDefinition(
        ids.c,
        fx.projectId,
        { roleDefinitionId: role.id, role: CUSTOM_ROLE_TIER },
        tx,
      ),
    );
    expect(await titlesFor(ids.c)).toEqual(EVERYTHING);

    await adminDb.projectRoleDefinition.update({
      where: { id: role.id },
      data: { permissions: ['project:browse'] },
    });
    // C has no records of their own, so the collapsed view is EMPTY — the whole
    // project was reachable through the key and through nothing else.
    expect(await titlesFor(ids.c)).toEqual({ fullView: false, awaiting: [], decided: [] });
  });
});

describe('the guards a percentage cannot see', () => {
  const git = (args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' });
    } catch {
      return '';
    }
  };

  it('no role is consulted by the read, the room or the nav entry', () => {
    const out = git([
      'grep',
      '--untracked',
      '-n',
      '-e',
      'isWorkspaceManager',
      '-e',
      'workspaceRole',
      '-e',
      'role ===',
      '--',
      'app/(authed)/approvals',
      'components/approvals/ApprovalRow.tsx',
      'lib/repositories/approvalGateRepository.ts',
    ]);
    expect(out).toBe('');
  });

  it('ONE routing predicate: the assignee-or-unassigned-reporter clause is written once', () => {
    const hits = git([
      'grep',
      '-n',
      'assigneeId: null, reporterId',
      '--',
      'lib/repositories/approvalGateRepository.ts',
    ])
      .split('\n')
      .filter(Boolean);
    expect(hits).toHaveLength(1);
  });

  it('the service reads the key in exactly one place — `listRecords`', () => {
    const hits = git(['grep', '-n', "'approval:view_any'", '--', 'lib/services', 'app'])
      .split('\n')
      .filter(Boolean);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^lib\/services\/approvalGatesService\.ts:/);
  });
});

describe('the decided-row mapper refuses a row that is not a decision', () => {
  // The read selects only `approved` / `changes_requested`, so these arms are the
  // mapper catching a PREDICATE defect upstream rather than drawing it — a
  // `superseded` row in the Decided section is exactly what the design forbids.
  const base = {
    id: 'g',
    kind: 'design_result' as const,
    subjectId: 's',
    createdAt: new Date(),
    decidedAt: new Date() as Date | null,
    decidedByLabel: null,
    subjectVersion: null,
    workItem: {
      id: 'w',
      key: 1,
      identifier: 'MOTIR-1',
      title: 't',
      kind: 'subtask' as const,
      type: 'design' as const,
      assigneeId: null,
      reporterId: null,
    },
  };

  it('throws on a superseded (or awaiting) row', () => {
    for (const state of ['superseded', 'awaiting'] as const) {
      expect(() => toApprovalRecordDecidedRowDto({ ...base, state } as never, null)).toThrow(
        /not a decision/,
      );
    }
  });

  it('throws on a decision with no `decidedAt`', () => {
    expect(() =>
      toApprovalRecordDecidedRowDto({ ...base, state: 'approved', decidedAt: null } as never, null),
    ).toThrow(/no decidedAt/);
  });
});
