import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { GithubRepo, User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { PermissionDeniedError } from '@/lib/projects/errors';
import {
  PULL_REQUEST_LINK_PERMISSION,
  githubPullRequestService,
} from '@/lib/services/githubPullRequestService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectRoleDefinitionService } from '@/lib/services/projectRoleDefinitionService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr } from '../helpers/repairFixtures';

// MOTIR-6318 — the item page's pull-request LINK and UNLINK take the key their
// MCP twins take. `linkPullRequest` / `unlinkPullRequest` (the cuid arms the
// item page's Server Actions call) asserted no permission at all, so an actor
// on a browse-only role could attach a pull request to a card, or detach one and
// withdraw the approve-to-merge question it was waiting on, by calling the
// action directly. The UI hid both controls, which is why nobody saw it.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A workspace member on a CUSTOM project role holding the given keys only. */
async function memberWithRole(
  fx: WorkItemFixture,
  permissions: PermissionKey[],
): Promise<{ user: User; ctx: ServiceContext }> {
  const user = await usersService.createUser({
    email: `reader+${randomToken()}@example.com`,
    password: 'hunter2hunter2',
    name: 'Reader',
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  const role = await projectRoleDefinitionService.create({
    projectId: fx.projectId,
    ctx: fx.ctx,
    name: `Role ${randomToken(4)}`,
    permissions,
  });
  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: 'member',
  });
  await projectMembersService.setRole({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: role.id,
  });
  return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
}

/** A member on the stock `member` role — the everyday editor. */
async function plainMember(fx: WorkItemFixture): Promise<ServiceContext> {
  const user = await usersService.createUser({
    email: `member+${randomToken()}@example.com`,
    password: 'hunter2hunter2',
    name: 'Member',
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: 'member',
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

let prNumber = 7000;

/** An open pull request in the org's repository, delivering nothing yet. */
async function unlinkedPr(repo: GithubRepo) {
  return adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: prNumber++,
      state: 'open',
      merged: false,
      headRef: 'subtask/some-change',
      baseRef: 'main',
      title: 'A change',
    },
  });
}

async function deliveryCount(workItemId: string, pullRequestId: string): Promise<number> {
  return adminDb.workItemDelivery.count({
    where: { workItemId, githubPullRequestId: pullRequestId },
  });
}

/** An AWAITING approve-to-merge gate on the card — what an unlink would withdraw. */
async function awaitingMergeGate(fx: WorkItemFixture, workItemId: string) {
  return adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId,
      kind: 'pull_request_approval',
      subjectId: workItemId,
      state: 'awaiting',
    },
  });
}

describe('pull-request link / unlink — the permission the item page’s arms assert (MOTIR-6318)', () => {
  it('refuses a LINK from a browse-only actor, and writes no delivery row', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'card' });
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    const pr = await unlinkedPr(repo);
    const reader = await memberWithRole(fx, ['project:browse']);

    await expect(
      githubPullRequestService.linkPullRequest(card.id, pr.id, reader.ctx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await deliveryCount(card.id, pr.id)).toBe(0);
  });

  it('refuses an UNLINK from a browse-only actor: the delivery stays and the merge gate is not withdrawn', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'card' });
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    const pr = await deliveredPr(fx, card.id, repo, { headRef: 'subtask/some-change' });
    const gate = await awaitingMergeGate(fx, card.id);
    const reader = await memberWithRole(fx, ['project:browse']);

    await expect(
      githubPullRequestService.unlinkPullRequest(card.id, pr.id, reader.ctx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await deliveryCount(card.id, pr.id)).toBe(1);
    const after = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(after.state).toBe('awaiting');
  });

  it('a Member still links and unlinks', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'card' });
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    const pr = await unlinkedPr(repo);
    const member = await plainMember(fx);

    await githubPullRequestService.linkPullRequest(card.id, pr.id, member);
    expect(await deliveryCount(card.id, pr.id)).toBe(1);
    await expect(
      githubPullRequestService.unlinkPullRequest(card.id, pr.id, member),
    ).resolves.toEqual({ removed: true });
    expect(await deliveryCount(card.id, pr.id)).toBe(0);
  });

  it('a role holding exactly the declared key is enough — the gate is that key, not a role name', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'card' });
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    const pr = await unlinkedPr(repo);
    const editor = await memberWithRole(fx, ['project:browse', PULL_REQUEST_LINK_PERMISSION]);

    await githubPullRequestService.linkPullRequest(card.id, pr.id, editor.ctx);
    expect(await deliveryCount(card.id, pr.id)).toBe(1);
  });

  it('pins the item-page arms and the MCP tools to ONE key', () => {
    expect(PULL_REQUEST_LINK_PERMISSION).toBe('work_item:edit');
    expect(TOOL_PERMISSIONS.link_pull_request).toBe(PULL_REQUEST_LINK_PERMISSION);
    expect(TOOL_PERMISSIONS.unlink_pull_request).toBe(PULL_REQUEST_LINK_PERMISSION);
  });
});
