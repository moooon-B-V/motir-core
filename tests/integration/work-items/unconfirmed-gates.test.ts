import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { activityService } from '@/lib/services/activityService';
import { estimationService } from '@/lib/services/estimationService';
import { acceptanceEvidenceService } from '@/lib/services/acceptanceEvidenceService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { createTestProject } from '../../fixtures/projectFixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The CLAIMED-BUT-UNVERIFIED sweep, work-item half (Story MOTIR-2291 · Subtask
// MOTIR-2365).
//
// Every operation here was labelled `existing` in the inventory — "already
// governed by a shipped predicate" — and the guard's static walk could not
// confirm it. The guard's whole point is that a gate which is real but invisible
// and a gate which does not exist look identical from outside, and the difference
// is a security hole. Reading the six the bucket still held found ONE of the
// first kind and FIVE of the second.
//
// The actor these cases use is a workspace member with NO project membership on a
// PRIVATE project: the shipped workspace check admitted them and nothing else
// asked about the project, which is precisely the hole. They are refused as a
// NON-BROWSER, so the shape is the 404, not a 403 — a private project must not
// confirm its own existence on the way to refusing.

const PASSWORD = 'hunter2hunter2';

interface Fixture {
  projectId: string;
  storyId: string;
  taskId: string;
  ownerCtx: ServiceContext;
  memberCtx: ServiceContext;
  outsiderCtx: ServiceContext;
}

let seq = 0;

async function makeFixture(label: string): Promise<Fixture> {
  seq += 1;
  const owner = await usersService.createUser({
    email: `unv-owner-${label}-${seq}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const ws = await workspacesService.createWorkspace({
    name: `Unv WS ${label} ${seq}`,
    ownerUserId: owner.id,
  });
  const workspaceId = ws.workspace.id;
  const project = await createTestProject({ workspaceId, actorUserId: owner.id });
  const ownerCtx: ServiceContext = { userId: owner.id, workspaceId };
  await projectMembersService.setAccessLevel({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    level: 'private',
  });

  async function actor(slug: string, role: 'member' | null): Promise<ServiceContext> {
    const u = await usersService.createUser({
      email: `unv-${slug}-${label}-${seq}@example.com`,
      password: PASSWORD,
      name: slug,
    });
    await db.workspaceMembership.create({ data: { userId: u.id, workspaceId, role: 'member' } });
    if (role) {
      await projectMembersService.addMember({
        key: project.identifier,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: u.id,
        role,
      });
    }
    return { userId: u.id, workspaceId };
  }

  const story = await workItemsService.createWorkItem(
    { projectId: project.id, title: 'A story', kind: 'story' },
    ownerCtx,
  );
  const task = await workItemsService.createWorkItem(
    { projectId: project.id, title: 'A task', kind: 'task' },
    ownerCtx,
  );

  return {
    projectId: project.id,
    storyId: story.id,
    taskId: task.id,
    ownerCtx,
    memberCtx: await actor('member', 'member'),
    outsiderCtx: await actor('outsider', null),
  };
}

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
});

describe('the five holes the bucket was hiding', () => {
  it('refuses the estimate WRITE — a work-item mutation reachable by any workspace member', async () => {
    const fx = await makeFixture('estimate');
    await expect(
      estimationService.setEstimate(fx.taskId, 5, fx.outsiderCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    // …and a project member still estimates, so the gate is not "deny everyone".
    await expect(estimationService.setEstimate(fx.taskId, 5, fx.memberCtx)).resolves.toBeTruthy();
  });

  it('refuses the parent roll-up and the activity history', async () => {
    const fx = await makeFixture('reads');
    await expect(
      estimationService.rollupForParent(fx.storyId, fx.outsiderCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      activityService.listHistory(fx.storyId, {}, fx.outsiderCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(activityService.listHistory(fx.storyId, {}, fx.memberCtx)).resolves.toBeTruthy();
  });

  it('refuses BOTH acceptance-evidence paths — including the upload-token minter', async () => {
    // The sharpest item in the list: `createUploadTokens` mints a pre-signed
    // upload token against the workspace's blob store, and its resolver asked
    // nothing about the project. A session and a story id were the whole
    // requirement.
    const fx = await makeFixture('evidence');
    await expect(
      acceptanceEvidenceService.createUploadTokens(
        { workItemId: fx.storyId, hasTrace: false },
        fx.outsiderCtx,
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      acceptanceEvidenceService.recordFromPathnames(
        {
          workItemId: fx.storyId,
          commitSha: 'abc1234',
          producedByKey: 'k',
          videoPathname: 'v.webm',
        } as never,
        fx.outsiderCtx,
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('refuses a project VIEWER the evidence WRITE while leaving them their reads', async () => {
    // `work_item:edit`, so the refusal for someone who CAN browse is the 403 that
    // names the key — the other half of the gate's shape.
    const fx = await makeFixture('evidence-viewer');
    const viewer = await usersService.createUser({
      email: `unv-viewer-${seq}@example.com`,
      password: PASSWORD,
      name: 'viewer',
    });
    await db.workspaceMembership.create({
      data: { userId: viewer.id, workspaceId: fx.ownerCtx.workspaceId, role: 'member' },
    });
    const project = await db.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    await projectMembersService.addMember({
      key: project.identifier,
      actorUserId: fx.ownerCtx.userId,
      ctx: fx.ownerCtx,
      targetUserId: viewer.id,
      role: 'viewer',
    });
    const viewerCtx: ServiceContext = {
      userId: viewer.id,
      workspaceId: fx.ownerCtx.workspaceId,
    };
    await expect(
      acceptanceEvidenceService.createUploadTokens(
        { workItemId: fx.storyId, hasTrace: false },
        viewerCtx,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    // The reads they hold are untouched.
    await expect(activityService.listHistory(fx.storyId, {}, viewerCtx)).resolves.toBeTruthy();
  });
});

describe('the one real gate the walk could not follow', () => {
  it('mention-search was already governed — it narrows to browsable projects', async () => {
    // `quickSearch` resolves every project in the workspace and filters to the
    // browsable ones BEFORE it searches, so an actor who cannot browse this
    // private project simply finds nothing in it. That is a gate, expressed in the
    // plural — the shape the walk had no name for until `filterBrowsable` joined
    // its pattern. Nothing was added here; the disposition was to see it.
    const fx = await makeFixture('mention');
    expect(await workItemsService.quickSearch('story', fx.outsiderCtx)).toEqual([]);
    const mine = await workItemsService.quickSearch('story', fx.memberCtx);
    expect(mine.map((r) => r.id)).toContain(fx.storyId);
  });
});
