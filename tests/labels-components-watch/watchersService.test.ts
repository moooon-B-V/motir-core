import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { watchersService, WATCHER_PAGE_SIZE } from '@/lib/services/watchersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { WatchersForbiddenError, WatcherTargetCannotViewError } from '@/lib/watchers/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestUser, createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// watchersService (Story 5.4 · Subtask 5.4.4) — the watch BUSINESS rules over
// the 5.4.1 leaves, against a REAL Postgres (no-mocks rule): the verified
// permission split (anyone with view watches THEMSELVES, the read-only
// `viewer` included; project admin / workspace owner-admin manage OTHERS),
// the typed view-access rejection (never Jira's silent drop), idempotency
// everywhere, the paged list, the getIssueDetail slot, the auto-watch hooks
// (create + comment, inside their owning transactions), and the no-revision
// rule (watching is not a field change).

beforeEach(async () => {
  // workspace TRUNCATE … CASCADE walks workspace → work_item → watcher
  // (Cascade FK chains).
  await truncateAuthTables();
  // The one external seam stubbed (the comments-suite pattern): the
  // post-commit job emit has no Inngest key in the test env, and the 5.4.5
  // watcher job is out of this subtask's scope anyway.
  vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

interface WatcherScenario {
  fx: WorkItemFixture;
  issue: WorkItem;
  /** Plain workspace member — may view + watch (open project), not manage. */
  memberCtx: ServiceContext;
  memberId: string;
  /** Workspace member holding the read-only project `viewer` role. */
  viewerCtx: ServiceContext;
  viewerId: string;
}

/** An OPEN project + one issue + a plain-member actor and a project-viewer actor. */
async function buildScenario(): Promise<WatcherScenario> {
  const fx = await makeWorkItemFixture();
  const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Watched task' });

  async function wsMember(email: string, name: string) {
    const user = await createTestUser({ email, name });
    await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
    return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
  }

  const { user: member, ctx: memberCtx } = await wsMember('member@ex.com', 'Plain Member');
  const { user: viewer, ctx: viewerCtx } = await wsMember('viewer@ex.com', 'Read Only');

  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: viewer.id,
    role: 'viewer',
  });

  return { fx, issue, memberCtx, memberId: member.id, viewerCtx, viewerId: viewer.id };
}

/** Flip the scenario project private (the comments-suite pattern). */
async function flipPrivate(s: WatcherScenario): Promise<void> {
  await projectMembersService.setAccessLevel({
    key: s.fx.projectIdentifier,
    actorUserId: s.fx.ownerId,
    ctx: s.fx.ctx,
    level: 'private',
  });
}

describe('self watch / unwatch (view access is the only gate)', () => {
  it('watches and unwatches, returning the state + count', async () => {
    const s = await buildScenario();

    const watched = await watchersService.watch(s.issue.id, s.memberCtx);
    expect(watched).toEqual({ watching: true, watcherCount: 1 });

    const second = await watchersService.watch(s.issue.id, s.fx.ctx);
    expect(second).toEqual({ watching: true, watcherCount: 2 });

    const unwatched = await watchersService.unwatch(s.issue.id, s.memberCtx);
    expect(unwatched).toEqual({ watching: false, watcherCount: 1 });
  });

  it('is idempotent both ways — re-watch absorbs, unwatch-when-not-watching no-ops', async () => {
    const s = await buildScenario();

    await watchersService.watch(s.issue.id, s.memberCtx);
    const rewatch = await watchersService.watch(s.issue.id, s.memberCtx);
    expect(rewatch).toEqual({ watching: true, watcherCount: 1 });

    await watchersService.unwatch(s.issue.id, s.memberCtx);
    const reunwatch = await watchersService.unwatch(s.issue.id, s.memberCtx);
    expect(reunwatch).toEqual({ watching: false, watcherCount: 0 });
  });

  it('lets a read-only project VIEWER watch themselves — watching is not editing', async () => {
    const s = await buildScenario();
    const state = await watchersService.watch(s.issue.id, s.viewerCtx);
    expect(state).toEqual({ watching: true, watcherCount: 1 });
  });

  it('writes NO revision rows from any watch path (watching is not a field change)', async () => {
    const s = await buildScenario();
    const before = (await workItemRevisionRepository.listByWorkItem(s.issue.id)).length;

    await watchersService.watch(s.issue.id, s.memberCtx);
    await watchersService.addWatcher(s.issue.id, s.viewerId, s.fx.ctx);
    await watchersService.removeWatcher(s.issue.id, s.viewerId, s.fx.ctx);
    await watchersService.unwatch(s.issue.id, s.memberCtx);

    const after = (await workItemRevisionRepository.listByWorkItem(s.issue.id)).length;
    expect(after).toBe(before);
  });

  it('hides a missing / cross-workspace issue as 404 on every path', async () => {
    const s = await buildScenario();
    const theirs = await makeWorkItemFixture({ name: 'Beta', identifier: 'BETA' });
    const theirIssue = await createTestWorkItem(theirs, { kind: 'task', title: 'Theirs' });

    const probes: Array<() => Promise<unknown>> = [
      () => watchersService.watch(theirIssue.id, s.memberCtx),
      () => watchersService.unwatch(theirIssue.id, s.memberCtx),
      () => watchersService.listWatchers(theirIssue.id, {}, s.memberCtx),
      () => watchersService.addWatcher(theirIssue.id, s.memberId, s.memberCtx),
      () => watchersService.removeWatcher(theirIssue.id, s.memberId, s.memberCtx),
      () => watchersService.watch('no-such-id', s.memberCtx),
    ];
    for (const probe of probes) {
      await expect(probe()).rejects.toThrow(WorkItemNotFoundError);
    }
  });

  it('hides a PRIVATE project issue from a non-member as 404 — even on self-watch', async () => {
    const s = await buildScenario();
    await flipPrivate(s);
    const outsider = await createTestUser({ email: 'late@ex.com', name: 'Late Joiner' });
    await workspacesService.addMember({ userId: outsider.id, workspaceId: s.fx.workspaceId });
    const outsiderCtx = { userId: outsider.id, workspaceId: s.fx.workspaceId };

    await expect(watchersService.watch(s.issue.id, outsiderCtx)).rejects.toThrow(
      WorkItemNotFoundError,
    );
    await expect(watchersService.listWatchers(s.issue.id, {}, outsiderCtx)).rejects.toThrow(
      WorkItemNotFoundError,
    );
  });
});

describe('manage others — the "Manage watchers" tier', () => {
  it('lets the workspace owner and a project admin add/remove another member', async () => {
    const s = await buildScenario();

    const added = await watchersService.addWatcher(s.issue.id, s.memberId, s.fx.ctx);
    expect(added.watcher).toEqual({ userId: s.memberId, name: 'Plain Member', image: null });
    expect(added.watcherCount).toBe(1);

    // Promote the member to project admin — they may now manage others too.
    await projectMembersService.addMember({
      key: s.fx.projectIdentifier,
      actorUserId: s.fx.ownerId,
      ctx: s.fx.ctx,
      targetUserId: s.memberId,
      role: 'admin',
    });
    const byAdmin = await watchersService.addWatcher(s.issue.id, s.viewerId, s.memberCtx);
    expect(byAdmin.watcherCount).toBe(2);

    const removed = await watchersService.removeWatcher(s.issue.id, s.viewerId, s.memberCtx);
    expect(removed.watcherCount).toBe(1);
  });

  it('rejects a plain member (and a viewer) managing others with 403', async () => {
    const s = await buildScenario();
    await expect(watchersService.addWatcher(s.issue.id, s.viewerId, s.memberCtx)).rejects.toThrow(
      WatchersForbiddenError,
    );
    await expect(
      watchersService.removeWatcher(s.issue.id, s.memberId, s.viewerCtx),
    ).rejects.toThrow(WatchersForbiddenError);
  });

  it('rejects a target who cannot VIEW the issue with the typed 422 — never a silent drop', async () => {
    const s = await buildScenario();
    await flipPrivate(s);
    // A workspace member NOT on the now-private project — Jira would silently
    // drop them; we reject with the typed reason.
    const lateJoiner = await createTestUser({ email: 'noview@ex.com', name: 'No View' });
    await workspacesService.addMember({ userId: lateJoiner.id, workspaceId: s.fx.workspaceId });

    await expect(watchersService.addWatcher(s.issue.id, lateJoiner.id, s.fx.ctx)).rejects.toThrow(
      WatcherTargetCannotViewError,
    );
    expect(await watcherRepository.existsFor(s.issue.id, lateJoiner.id)).toBe(false);
  });

  it('rejects a non-workspace-member (and a nonexistent user) target the same way', async () => {
    const s = await buildScenario();
    const stranger = await createTestUser({ email: 'stranger@ex.com', name: 'Stranger' });

    await expect(watchersService.addWatcher(s.issue.id, stranger.id, s.fx.ctx)).rejects.toThrow(
      WatcherTargetCannotViewError,
    );
    await expect(watchersService.addWatcher(s.issue.id, 'no-such-user', s.fx.ctx)).rejects.toThrow(
      WatcherTargetCannotViewError,
    );
  });

  it('is idempotent: re-adding a watching target and removing a non-watching one no-op', async () => {
    const s = await buildScenario();
    await watchersService.watch(s.issue.id, s.memberCtx);

    const readd = await watchersService.addWatcher(s.issue.id, s.memberId, s.fx.ctx);
    expect(readd.watcherCount).toBe(1);

    const remove = await watchersService.removeWatcher(s.issue.id, s.viewerId, s.fx.ctx);
    expect(remove.watcherCount).toBe(1);
  });
});

describe('listWatchers — paged, view-gated, manage flag', () => {
  it('pages through the roster oldest-first with a stable cursor walk', async () => {
    const s = await buildScenario();
    const total = WATCHER_PAGE_SIZE + 2;

    // Arrange the roster directly at the repo layer (the sanctioned test
    // reach) — listWatchers itself never re-gates each target.
    await db.$transaction(async (tx) => {
      for (let i = 0; i < total; i += 1) {
        const u = await createTestUser({ email: `w${i}@ex.com`, name: `Watcher ${i}` });
        await watcherRepository.add(s.issue.id, u.id, tx);
      }
    });

    const first = await watchersService.listWatchers(s.issue.id, {}, s.fx.ctx);
    expect(first.watchers).toHaveLength(WATCHER_PAGE_SIZE);
    expect(first.totalCount).toBe(total);
    expect(first.nextCursor).not.toBeNull();
    expect(first.canManage).toBe(true);

    const second = await watchersService.listWatchers(
      s.issue.id,
      { cursor: first.nextCursor! },
      s.fx.ctx,
    );
    expect(second.watchers).toHaveLength(2);
    expect(second.nextCursor).toBeNull();

    const seen = [...first.watchers, ...second.watchers].map((w) => w.userId);
    expect(new Set(seen).size).toBe(total);
  });

  it('reports canManage=false for a plain member and a viewer (the popover affordance gate)', async () => {
    const s = await buildScenario();
    await watchersService.watch(s.issue.id, s.memberCtx);

    const asMember = await watchersService.listWatchers(s.issue.id, {}, s.memberCtx);
    expect(asMember.canManage).toBe(false);
    expect(asMember.watchers.map((w) => w.userId)).toEqual([s.memberId]);

    const asViewer = await watchersService.listWatchers(s.issue.id, {}, s.viewerCtx);
    expect(asViewer.canManage).toBe(false);
  });
});

describe('getIssueDetail carries the watch state (the parallel-fetch slot)', () => {
  it('returns watcherCount + viewerIsWatching without a second service call', async () => {
    const s = await buildScenario();
    await watchersService.watch(s.issue.id, s.memberCtx);

    const asMember = await workItemsService.getIssueDetail(
      s.fx.projectId,
      s.issue.identifier,
      s.memberCtx,
    );
    expect(asMember.watcherCount).toBe(1);
    expect(asMember.viewerIsWatching).toBe(true);

    const asOwner = await workItemsService.getIssueDetail(
      s.fx.projectId,
      s.issue.identifier,
      s.fx.ctx,
    );
    expect(asOwner.watcherCount).toBe(1);
    expect(asOwner.viewerIsWatching).toBe(false);
  });
});

describe('auto-watch hooks (the verified create-or-comment rule, constant-on)', () => {
  it('creating an issue auto-watches the creator, inside the create transaction', async () => {
    // A fresh fixture with NO repo-created siblings: createTestWorkItem's
    // padded positions aren't valid fractional-index keys, and a service
    // create in the same scope would trip on them (the known seed-position
    // gotcha). Everything here goes through the service.
    const fx = await makeWorkItemFixture();
    const dto = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Born watched' },
      fx.ctx,
    );
    expect(await watcherRepository.existsFor(dto.id, fx.ownerId)).toBe(true);
    expect(await watcherRepository.countByWorkItem(dto.id)).toBe(1);
  });

  it('commenting auto-watches the commenter, idempotently across comments', async () => {
    const s = await buildScenario();

    await commentsService.addComment(s.issue.id, { bodyMd: 'First!' }, s.memberCtx);
    expect(await watcherRepository.existsFor(s.issue.id, s.memberId)).toBe(true);

    // A second comment by the same author absorbs into the existing row.
    await commentsService.addComment(s.issue.id, { bodyMd: 'Again.' }, s.memberCtx);
    expect(await watcherRepository.countByWorkItem(s.issue.id)).toBe(1);
  });

  it('a rolled-back create leaves no watcher row (the hook rides the owning tx)', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Not a legal parent of an epic' },
      fx.ctx,
    );
    const before = await db.watcher.count();
    // An illegal parent aborts createWorkItem INSIDE its flow — nothing,
    // watcher row included, may survive.
    await expect(
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'epic', parentId: parent.id, title: 'Bad parent' },
        fx.ctx,
      ),
    ).rejects.toThrow();
    expect(await db.watcher.count()).toBe(before);
  });
});
