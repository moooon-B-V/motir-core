import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { handlerFor, isRegisteredGateKind } from '@/lib/approvalGates/registry';
import {
  MERGE_MODE_SETTINGS_DOOR,
  pullRequestMergeGateHandler,
} from '@/lib/approvalGates/pullRequestMergeHandler';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { PERMISSION_CATALOG } from '@/lib/permissions/catalog';
import {
  BUILTIN_ROLE_PERMISSIONS,
  IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS,
} from '@/lib/permissions/builtinRoles';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { createTestUser } from './fixtures/userFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// THE `pull_request_merge` KIND, REGISTERED (Story MOTIR-4882 · MOTIR-4793), against a
// REAL Postgres. The handler over one pull request, the `work_item:merge_pull_request`
// floor, the kind's settings door, and — the one that matters most — that deciding a
// merge gate writes NO status: `done` has one writer, the merge webhook.

const HEAD = '9840d00ea1b2c3d4e5f60718293a4b5c6d7e8f90';

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

/** A plain workspace member seated on the fixture project with a built-in role. */
async function seatedOn(role: 'member' | 'viewer') {
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

/** A card in review, its pull request with one green check at HEAD, and an awaiting merge gate. */
async function cardWithMergeGate(opts: { assigneeId: string | null; reporterId?: string }) {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Merge the seam' },
    fx.ctx,
  );
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'The merge seam' },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      assigneeId: opts.assigneeId,
      ...(opts.reporterId !== undefined ? { reporterId: opts.reporterId } : {}),
    },
  });

  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-4793-${item.id}`,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      installationId: installation.id,
      repoId: `repo-4793-${item.id}`,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: 7,
      title: 'The merge seam',
      state: 'open',
      headRef: 'parent/MOTIR-4882-merge-seam',
      baseRef: 'main',
      provider: 'github',
    },
  });
  await adminDb.githubCheckRun.create({
    data: { pullRequestId: pr.id, commitSha: HEAD, checkName: 'Vitest', conclusion: 'success' },
  });
  const gate = await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: 'pull_request_merge',
        subjectId: pr.id,
      },
      tx,
    ),
  );
  return { item, pr, gate };
}

describe('the kind is REGISTERED, carrying the full contract (MOTIR-4793)', () => {
  it('dispatches to the merge handler, and no longer refuses the kind as unregistered', () => {
    expect(isRegisteredGateKind('pull_request_merge')).toBe(true);
    const handler = handlerFor('pull_request_merge');
    expect(handler).toBe(pullRequestMergeGateHandler);
    // ADR §1's table: the floor, no owned transition, the kind's door.
    expect(handler.permission).toBe('work_item:merge_pull_request');
    expect(handler.statusIntent).toBeNull();
    expect(handler.settingsDoor).toEqual(MERGE_MODE_SETTINGS_DOOR);
    expect(handler.settingsDoor?.href).toBe('/settings/project/approvals#merge-mode');
  });

  it('routes to the assignee, and to the reporter when there is none', () => {
    const route = (assigneeId: string | null) =>
      pullRequestMergeGateHandler.routeTo({
        item: { assigneeId, reporterId: 'reporter-1' } as WorkItem,
        ctx: fx.ctx,
        tx: undefined as never,
      });
    expect(route('assignee-1')).toBe('assignee-1');
    expect(route(null)).toBe('reporter-1');
  });
});

describe('deciding a merge gate writes NO status — the merge webhook is the one writer of done', () => {
  it('APPROVE records the decision and the head it was taken on, and leaves the card where it is', async () => {
    const assignee = await seatedOn('member');
    const { item, gate } = await cardWithMergeGate({ assigneeId: assignee.user.id });

    const result = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui' },
      assignee.ctx,
    );

    expect(result.gate.state).toBe('approved');
    // A merge gate's outcome is not a status key (§4 second amendment, decision 4).
    expect(result.gate.outcomeRef).toBeNull();
    const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(row.subjectVersion).toBe(`acme/web#7@${HEAD}`);
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe('in_review');
  });

  it('REQUEST CHANGES records and moves nothing', async () => {
    const assignee = await seatedOn('member');
    const { item, gate } = await cardWithMergeGate({ assigneeId: assignee.user.id });

    const result = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'request_changes', source: 'ui' },
      assignee.ctx,
    );

    expect(result.gate.state).toBe('changes_requested');
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe('in_review');
  });

  it('a project VIEWER who is the assignee is refused at the floor, and the gate stays awaiting', async () => {
    const viewer = await seatedOn('viewer');
    const { gate } = await cardWithMergeGate({
      assigneeId: viewer.user.id,
      reporterId: (await seatedOn('member')).user.id,
    });

    await expect(
      approvalGatesService.decide(
        { gateId: gate.id, decision: 'approve', source: 'ui' },
        viewer.ctx,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(row.state).toBe('awaiting');
  });
});

describe('the Approvals queue names the pull request a merge gate asks about', () => {
  it('summarises the subject as owner/name#number and the head its checks ran on', async () => {
    const assignee = await seatedOn('member');
    const { pr, gate } = await cardWithMergeGate({ assigneeId: assignee.user.id });

    const page = await approvalGatesService.listAwaitingMe({
      ...assignee.ctx,
      projectId: fx.projectId,
    });
    const row = page.items.find((r) => r.gateId === gate.id);

    expect(row?.subject).toEqual({
      kind: 'pull_request_merge',
      pullRequestId: pr.id,
      repo: 'acme/web',
      number: 7,
      title: 'The merge seam',
      headSha: HEAD,
    });
  });
});

describe('the permission key (decision 10)', () => {
  it('exists in the catalog, enforced, in the work_item domain', () => {
    expect(PERMISSION_CATALOG['work_item:merge_pull_request']).toMatchObject({
      domain: 'work_item',
      enforcement: 'enforced',
    });
  });

  it('is held by EVERY built-in role that holds work_item:edit — and by nothing that does not', () => {
    for (const [role, held] of Object.entries(BUILTIN_ROLE_PERMISSIONS)) {
      expect(held.has('work_item:merge_pull_request'), role).toBe(held.has('work_item:edit'));
    }
    // The implicit workspace-member grant is NOT a role, and merging onto a repository
    // is an act of ownership on a project nobody put them on.
    expect(IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS.has('work_item:merge_pull_request')).toBe(false);
  });
});

describe('no module under lib/approvalGates reaches a Git host', () => {
  it('imports neither a provider implementation nor the App credential, and calls no fetch', () => {
    const dir = path.join(process.cwd(), 'lib', 'approvalGates');
    const offenders: string[] = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const code = fs
        .readFileSync(path.join(dir, file), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      if (/from '@\/lib\/git\/providers\//.test(code)) offenders.push(`${file}: git provider`);
      if (/from '@\/lib\/github\/appAuth'/.test(code)) offenders.push(`${file}: appAuth`);
      if (/\bfetch\(/.test(code)) offenders.push(`${file}: fetch`);
    }
    expect(offenders).toEqual([]);
  });
});
