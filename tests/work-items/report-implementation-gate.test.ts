import { beforeEach, describe, expect, it } from 'vitest';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// `workItemsService.reportImplementation` gates on `work_item:edit` (MOTIR-2603).
//
// It used to gate on `project:browse` alone — `getWorkItem`, then a provenance
// write — which is a READ permission standing in front of a WRITE. Every sibling
// write on this service reaches `assertCanEdit`: `markIntegrated` and
// `completeSession` get there through `applyStatusTransition`, and this one had
// no transition to inherit it from, so it inherited nothing. The consequence was
// silent and total: any actor who could SEE an item could stamp
// `implementationSource` / `harness` / `model` on it, and the stamp is what the
// board and the provenance rail present as fact about who built the work.
//
// The token half of the gate is asserted at the route
// (`tests/api/v1/session-close-out-routes.test.ts` — a browse-only TOKEN is
// refused by the operation's declaration). This file asserts the other half, the
// one the declaration cannot reach: the ACTOR's project role. The two are
// independent — a token holding `work_item:edit` still cannot confer edit on an
// owner whose role is read-only, which is the composition rule the ADR calls
// `granted ∩ role`.
//
// Real Postgres, no mocks, per CLAUDE.md.

/** The fixture owner's actor-scoped input, for the member-management calls. */
function actorInput(fx: WorkItemFixture) {
  return { key: fx.projectIdentifier, actorUserId: fx.ownerId, ctx: fx.ctx };
}

/** A fresh workspace member given `role` on the fixture's project. */
async function memberWithProjectRole(fx: WorkItemFixture, email: string, role: string) {
  const user = await usersService.createUser({
    email,
    password: 'hunter2hunter2',
    name: email,
  });
  await workspacesService.addMember({
    userId: user.id,
    workspaceId: fx.workspaceId,
    role: 'member',
  });
  await projectMembersService.addMember({ ...actorInput(fx), targetUserId: user.id, role });
  return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
}

async function makeItem(fx: WorkItemFixture, title: string) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

describe('reportImplementation gates the provenance write on work_item:edit', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('refuses a BROWSE-ONLY actor, and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'not yours to stamp');
    // An explicit project `viewer` is read-only on every access level, so this
    // is the browse-yes / edit-no actor regardless of how the project is
    // configured — not an artefact of the fixture's default.
    const viewer = await memberWithProjectRole(fx, 'impl-viewer@example.com', 'viewer');

    // The viewer really can SEE it — otherwise the refusal below would prove
    // only that the browse gate works, which was never in question.
    await expect(workItemsService.getWorkItem(item.id, viewer.ctx)).resolves.toMatchObject({
      id: item.id,
    });

    const denial = workItemsService.reportImplementation(item.id, viewer.ctx, {
      source: 'byok',
      harness: 'claude-code',
      model: 'claude-opus-5',
    });

    await expect(denial).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    await expect(denial).rejects.toMatchObject({ kind: 'edit' });

    // Refused as `edit`, not as `browse`: a read-only member gets the 403 shape,
    // not the 404 that hides a project from someone who cannot see it at all.
    const after = await workItemsService.getWorkItem(item.id, fx.ctx);
    expect(after.implementationSource).toBeNull();
    expect(after.implementationHarness).toBeNull();
    expect(after.implementationModel).toBeNull();
  });

  it('admits an EDITOR who is not the owner', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'stamp me');
    const editor = await memberWithProjectRole(fx, 'impl-editor@example.com', 'member');

    const dto = await workItemsService.reportImplementation(item.id, editor.ctx, {
      source: 'byok',
      harness: 'claude-code',
      model: 'claude-opus-5',
    });

    expect(dto.implementationSource).toBe('byok');
    expect(dto.implementationHarness).toBe('claude-code');
    expect(dto.implementationModel).toBe('claude-opus-5');
    // The gate is the ONLY thing that changed — it still moves no status and
    // still never touches the session branch (MOTIR-2421).
    expect(dto.status).toBe(item.status);
    expect(dto.sessionBranch).toBeNull();
  });

  it('404s a cross-tenant key BEFORE the edit gate can 403 it', async () => {
    // Ordering matters: `getWorkItem` runs first, so an actor probing another
    // tenant's key learns nothing about whether it exists. Adding the edit
    // assert must not turn that 404 into a 403.
    const mine = await makeWorkItemFixture();
    const theirs = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const hidden = await makeItem(theirs, 'not visible');

    await expect(
      workItemsService.reportImplementation(hidden.id, mine.ctx, { source: 'byok' }),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);

    const still = await workItemsService.getWorkItem(hidden.id, theirs.ctx);
    expect(still.implementationSource).toBeNull();
  });
});
