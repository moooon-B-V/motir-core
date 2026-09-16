import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { settingsDoorFor } from '@/lib/approvalGates/settingsDoor';
import { handlerFor } from '@/lib/approvalGates/registry';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { createTestUser } from './fixtures/userFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// THE SETTINGS DOOR IS GATED BY THE SERVER READ (Story MOTIR-4882 · MOTIR-5513),
// against a REAL Postgres.
//
// The door lands in the Approvals room, which is behind `workflow:manage` and has
// no read-only form (Yue, 2026-09-13) — so a door handed to anyone else leads to a
// refusal. The frame renders exactly what it is given, which makes
// `approvalGatesService.getForWorkItem` the ONE place the door is withheld. Both
// viewers below sit in the SAME project, on the SAME gate, and differ only in the
// key: that is what makes the pair evidence about the gate rather than about two
// fixtures.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A plain workspace member seated on the fixture project with a BUILT-IN role. */
async function seatedOn(role: 'admin' | 'member') {
  const user = await createTestUser();
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: fx.workspaceId, role: 'member' },
  });
  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role,
  });
  return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
}

/** A work item carrying an `awaiting` gate of `kind`. */
async function itemWithGate(kind: 'pull_request_approval' | 'design_result') {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Merge the seam' },
    fx.ctx,
  );
  await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind,
        subjectId: `subject-${item.id}`,
      },
      tx,
    ),
  );
  return item;
}

describe('getForWorkItem hands the settings door ONLY to a workflow:manage holder (MOTIR-5513)', () => {
  it('in ONE project, on ONE merge gate: the manager gets the door and the member gets none', async () => {
    const manager = await seatedOn('admin');
    const member = await seatedOn('member');

    // The premise, ASSERTED rather than assumed: the two viewers differ in the key.
    const managerHeld = await projectAccessService.getPermissions(fx.projectId, manager.ctx);
    const memberHeld = await projectAccessService.getPermissions(fx.projectId, member.ctx);
    expect(managerHeld.has('workflow:manage')).toBe(true);
    expect(memberHeld.has('workflow:manage')).toBe(false);

    const item = await itemWithGate('pull_request_approval');
    const input = { workItemId: item.id, kind: 'pull_request_approval' as const };

    const asManager = await approvalGatesService.getForWorkItem(input, manager.ctx);
    const asMember = await approvalGatesService.getForWorkItem(input, member.ctx);

    // Both viewers read the SAME gate — only the door differs.
    expect(asManager.gate?.id).toBeTruthy();
    expect(asMember.gate?.id).toBe(asManager.gate?.id);

    expect(asManager.settingsDoor).toEqual({
      href: '/settings/project/approvals#merge-mode',
      labelKey: 'mergeMode',
    });
    expect(asMember.settingsDoor).toBeNull();

    // The awaiting-only read carries the same answer through.
    const awaiting = await approvalGatesService.getAwaitingForWorkItem(input, manager.ctx);
    expect(awaiting.settingsDoor).toEqual(asManager.settingsDoor);
  });

  it('a kind with no project setting hands out no door, even to a manager', async () => {
    const manager = await seatedOn('admin');
    const item = await itemWithGate('design_result');

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      manager.ctx,
    );
    expect(read.gate?.kind).toBe('design_result');
    expect(read.settingsDoor).toBeNull();
  });

  it('no gate, no door', async () => {
    const manager = await seatedOn('admin');
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Nothing to decide' },
      fx.ctx,
    );

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'pull_request_approval' },
      manager.ctx,
    );
    expect(read).toEqual({
      gate: null,
      canDecide: false,
      routedToLabel: null,
      settingsDoor: null,
    });
  });
});

describe('the door lands where the room says it does', () => {
  it('the merge door targets the Approvals page anchor that PrMergeModeCard renders', () => {
    const card = readFileSync(
      path.join(
        process.cwd(),
        'app/(authed)/settings/project/approvals/_components/PrMergeModeCard.tsx',
      ),
      'utf8',
    );
    const anchor = card.match(/export const MERGE_MODE_ANCHOR = '([^']+)'/)?.[1];
    expect(anchor).toBe('merge-mode');
    expect(card).toMatch(/id=\{MERGE_MODE_ANCHOR\}/);
    expect(handlerFor('pull_request_approval').settingsDoor?.href).toBe(
      `/settings/project/approvals#${anchor}`,
    );
  });

  it('settingsDoorFor is the key check and nothing else', () => {
    const mergeModeDoor = handlerFor('pull_request_approval').settingsDoor;
    expect(mergeModeDoor).toBeDefined();
    expect(settingsDoorFor(mergeModeDoor, new Set())).toBeNull();
    expect(settingsDoorFor(mergeModeDoor, new Set(['workflow:manage']))).toEqual(mergeModeDoor);
    // A kind that supplies no door hands out none, whatever the viewer holds.
    expect(
      settingsDoorFor(handlerFor('design_result').settingsDoor, new Set(['workflow:manage'])),
    ).toBeNull();
  });
});
