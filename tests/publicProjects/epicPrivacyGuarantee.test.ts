import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import type { FilterAst } from '@/lib/filters/ast';
import { ProjectNotFoundError, NotProjectAdminError } from '@/lib/projects/errors';
import { PublicRequestNotFoundError } from '@/lib/publicRequests/errors';
import { NotEpicError, WorkItemNotFoundError } from '@/lib/workItems/errors';
import {
  makeWorkItemFixture,
  createTestWorkItem,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { truncateAuthTables } from '../helpers/db';

// Story 6.14 · Subtask 6.14.8 — the load-bearing GUARANTEE suite for epic
// privacy on public projects. It locks the single security promise the whole
// story exists for: a public / non-member viewer can NEVER read a PRIVATE
// epic's children — via ANY read path — while a project MEMBER can, no
// aggregate tell ever leaks, and the project-admin toggle drives that
// enforcement live. Real Postgres, no DB mocks (CLAUDE.md); the truncate helper
// CASCADE-resets between tests. Everything is asserted at the PAYLOAD level (the
// DTO the read returns), not the DOM — the guarantee is "the child is never
// SELECTed into the response", not "hidden client-side".
//
// This is the comprehensive lock that 6.14.4 (the server-side exclusion) and
// 6.14.7 (the admin write) each defer their end-to-end guarantee to. It EXTENDS
// 6.14.4's `epicPrivacyEnforcement.test.ts` (items / board / roadmap / overview)
// to the two public reads it did not cover — the 6.14.10 public TREE and the
// 6.12.12 request DETAIL — and adds the defence-in-depth proof for the
// MEMBER-ONLY internal reads (the 7.0 ready set + the 6.1 FilterAST search),
// the row-level aggregate-tell strip, and the toggle-drives-enforcement flow
// exercised through the REAL `setEpicPrivacy` write (not a direct column poke).
//
// Architecture (rung 2, the shipped reality 6.14.4 documented): the ONLY surface
// a cross-org NON-MEMBER can reach on a public project is `publicProjectsService`
// — every public read there applies the SAME exclusion predicate
// (`resolveHiddenIds` → `findPublicHiddenDescendantIds`). The internal
// `workItemsService` reads (FilterAST search, ready set, tree, detail) are
// workspace-scoped: a cross-org non-member is `ProjectNotFoundError` /
// `WorkItemNotFoundError` before any row is read, so they are members-only by
// construction and never apply (nor need) the exclusion predicate. So the
// no-leak guarantee for those paths is the membership gate itself, asserted
// here as defence-in-depth.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Set a work item's status key directly (a read test doesn't transition). The
 *  default `status` is "open" — not a default-workflow key — so the board /
 *  roadmap / overview reads need a real key ('todo' → To Do column, `todo`
 *  category). */
async function setStatus(id: string, status = 'todo'): Promise<void> {
  await db.workItem.update({ where: { id }, data: { status } });
}

/** Flip an epic's privacy flag DIRECTLY — the read-path tests that aren't
 *  exercising the write use this shortcut (the toggle's own enforcement flow
 *  goes through the real `setEpicPrivacy` service below). */
async function setPrivate(epicId: string, value: boolean): Promise<void> {
  await db.workItem.update({ where: { id: epicId }, data: { publicChildrenHidden: value } });
}

/** A fixture whose project is PUBLIC (the make-public toggle is 6.12.8; tests
 *  set the column directly, the shortcut the other public-project tests use). */
async function makePublicProjectFixture(name = 'Acme'): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture({ name });
  await db.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
  return fx;
}

/**
 * The standard tree under a public project:
 *   - privateEpic                       (marked private unless `markPrivate` is false)
 *       └ privStory └ privTask          (descendants that must be hidden)
 *   - openEpic └ openStory              (a normal subtree — must stay visible)
 * All statuses 'todo' so they land in the To Do column + the Planned bucket.
 */
async function buildTree(fx: WorkItemFixture, markPrivate = true) {
  const privateEpic = await createTestWorkItem(fx, { kind: 'epic', title: 'Private epic' });
  const privStory = await createTestWorkItem(fx, {
    kind: 'story',
    title: 'Hidden story',
    parentId: privateEpic.id,
  });
  const privTask = await createTestWorkItem(fx, {
    kind: 'task',
    title: 'Hidden task',
    parentId: privStory.id,
  });
  const openEpic = await createTestWorkItem(fx, { kind: 'epic', title: 'Open epic' });
  const openStory = await createTestWorkItem(fx, {
    kind: 'story',
    title: 'Visible story',
    parentId: openEpic.id,
  });
  for (const w of [privateEpic, privStory, privTask, openEpic, openStory]) {
    await setStatus(w.id);
  }
  if (markPrivate) await setPrivate(privateEpic.id, true);
  return { privateEpic, privStory, privTask, openEpic, openStory };
}

/** Add a plain WORKSPACE member (no project-admin role) — the non-admin actor
 *  for the 403 gate. Returns a service ctx for that user in fx's workspace. */
async function addWorkspaceMember(fx: WorkItemFixture, email: string) {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: email });
  await workspacesService.addMember({
    userId: user.id,
    workspaceId: fx.workspaceId,
    role: 'member',
  });
  return { userId: user.id, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
}

/** A text-contains FilterAST (6.1) matching a work item's title. */
function titleContains(value: string): FilterAst {
  return { combinator: 'and', conditions: [{ field: 'text', operator: 'contains', value }] };
}

describe('6.14.8 — a NON-MEMBER cannot read a private epic’s children via ANY public read', () => {
  it('the exclusion is applied to EVERY item-transmitting public read, INCLUDING the 6.14.10 tree (parameterized — a new public read missing the predicate fails here)', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);
    const nonMember = await createTestUser(); // cross-org: not a member of fx's workspace
    const hiddenIds = [t.privStory.id, t.privTask.id];

    // Every PUBLIC read that transmits work-item rows to a non-member. Adding a
    // new public list/tree read without threading the exclusion predicate makes
    // this fail — that's the regression guard the card asks for.
    const reads: Array<{ name: string; ids: () => Promise<string[]> }> = [
      {
        name: 'items list',
        ids: async () =>
          (await publicProjectsService.getWorkItems(fx.projectIdentifier, nonMember.id)).items.map(
            (i) => i.id,
          ),
      },
      {
        name: 'board',
        ids: async () =>
          (
            await publicProjectsService.getBoard(fx.projectIdentifier, nonMember.id)
          ).columns.flatMap((c) => c.cards.map((card) => card.id)),
      },
      {
        name: 'roadmap',
        ids: async () =>
          (
            await publicProjectsService.getRoadmap(fx.projectIdentifier, nonMember.id)
          ).columns.flatMap((c) => c.cards.map((card) => card.id)),
      },
      {
        name: 'tree (roots)',
        ids: async () =>
          (
            await publicProjectsService.getProjectTreeLevel(
              fx.projectIdentifier,
              null,
              nonMember.id,
            )
          ).rows.map((r) => r.id),
      },
    ];

    for (const read of reads) {
      const ids = await read.ids();
      for (const hidden of hiddenIds) {
        expect(ids, `${read.name} must not leak ${hidden}`).not.toContain(hidden);
      }
    }
  });

  it('the public TREE: the private epic ROW is present + marked + reports no children; a direct child-level fetch of it returns [] (defence-in-depth behind the marker)', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);
    const nonMember = await createTestUser();

    const roots = await publicProjectsService.getProjectTreeLevel(
      fx.projectIdentifier,
      null,
      nonMember.id,
    );
    const rootById = new Map(roots.rows.map((r) => [r.id, r]));

    // The private epic row is the visible placeholder: present, marked, and its
    // chevron is OFF (no publicly-visible children) — the hidden subtree's size
    // never leaks via `hasChildren` either.
    const epicRow = rootById.get(t.privateEpic.id);
    expect(epicRow?.childrenHidden).toBe(true);
    expect(epicRow?.hasChildren).toBe(false);
    // The open epic is a normal node: visible, no marker, chevron ON.
    expect(rootById.get(t.openEpic.id)?.childrenHidden).toBeUndefined();
    expect(rootById.get(t.openEpic.id)?.hasChildren).toBe(true);
    // The roots level's `total` counts only roots, so both epics are there.
    expect(roots.rows.length).toBe(2);

    // Even a DIRECT request for the private epic's children returns nothing for a
    // non-member — the exclusion is server-side, not a UI courtesy.
    const childLevel = await publicProjectsService.getProjectTreeLevel(
      fx.projectIdentifier,
      t.privateEpic.id,
      nonMember.id,
    );
    expect(childLevel.rows).toEqual([]);
    expect(childLevel.total).toBe(0);
  });

  it('the public request DETAIL: a non-member 404s on a hidden descendant (no-leak), but CAN read the visible private-epic row itself', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);
    const nonMember = await createTestUser();

    // The hidden story + task are not-found for a non-member — exactly like a
    // missing item (404-not-403, no existence leak).
    await expect(
      publicProjectsService.getRequestDetail(
        fx.projectIdentifier,
        t.privStory.identifier,
        nonMember.id,
      ),
    ).rejects.toBeInstanceOf(PublicRequestNotFoundError);
    await expect(
      publicProjectsService.getRequestDetail(
        fx.projectIdentifier,
        t.privTask.identifier,
        nonMember.id,
      ),
    ).rejects.toBeInstanceOf(PublicRequestNotFoundError);

    // The private epic ROW is still publicly visible (its descendants are hidden,
    // not the epic) — the detail read resolves it.
    const detail = await publicProjectsService.getRequestDetail(
      fx.projectIdentifier,
      t.privateEpic.identifier,
      nonMember.id,
    );
    expect(detail.identifier).toBe(t.privateEpic.identifier);
  });

  it('NO aggregate-tell leak: the private epic’s public ROW carries title / kind / status + the marker, but the projection OMITS child count, progress / rollup, and point total', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);
    const nonMember = await createTestUser();

    const page = await publicProjectsService.getWorkItems(fx.projectIdentifier, nonMember.id);
    const epicRow = page.items.find((i) => i.id === t.privateEpic.id)!;

    // The visible facts + the marker.
    expect(epicRow.title).toBe('Private epic');
    expect(epicRow.kind).toBe('epic');
    expect(epicRow.status).toBe('todo');
    expect(epicRow.childrenHidden).toBe(true);

    // The aggregate tells are ABSENT from the payload (structurally, not
    // DOM-hidden): no child count, no progress / rollup, no point total — and no
    // other internal field either.
    for (const tell of [
      'childCount',
      'childrenCount',
      'progress',
      'progressPct',
      'rollup',
      'pointTotal',
      'storyPoints',
      'estimateMinutes',
      'assigneeId',
      'reporterId',
    ]) {
      expect(epicRow, `the public row must omit "${tell}"`).not.toHaveProperty(tell);
    }
  });

  it('the board / overview DENOMINATORS exclude the hidden subtree (the count is itself an aggregate tell)', async () => {
    const fx = await makePublicProjectFixture();
    await buildTree(fx);
    const nonMember = await createTestUser();

    // Visible 'todo' items = privateEpic + openEpic + openStory = 3 (the 2 hidden
    // descendants never reach the count).
    const board = await publicProjectsService.getBoard(fx.projectIdentifier, nonMember.id);
    expect(board.columns.reduce((sum, c) => sum + c.totalCount, 0)).toBe(3);

    const overview = await publicProjectsService.getOverview(fx.projectIdentifier, nonMember.id);
    expect(overview.stats.planned).toBe(3);
    expect(overview.stats.shipped).toBe(0);
  });
});

describe('6.14.8 — a project MEMBER bypasses the exclusion entirely', () => {
  it('a member reads the hidden children + the real rollups via every public read, with NO marker', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);

    // The owner is a workspace member → full visibility on the same public surface.
    const page = await publicProjectsService.getWorkItems(fx.projectIdentifier, fx.ownerId);
    const byId = new Map(page.items.map((i) => [i.id, i]));
    expect(byId.has(t.privStory.id)).toBe(true);
    expect(byId.has(t.privTask.id)).toBe(true);
    expect(byId.get(t.privateEpic.id)?.childrenHidden).toBeUndefined();

    // The tree: the private epic now reports children + carries no marker.
    const roots = await publicProjectsService.getProjectTreeLevel(
      fx.projectIdentifier,
      null,
      fx.ownerId,
    );
    const epicRow = roots.rows.find((r) => r.id === t.privateEpic.id);
    expect(epicRow?.childrenHidden).toBeUndefined();
    expect(epicRow?.hasChildren).toBe(true);

    // The aggregate counts are the REAL totals: all 5 'todo' items.
    const overview = await publicProjectsService.getOverview(fx.projectIdentifier, fx.ownerId);
    expect(overview.stats.planned).toBe(5);

    // And the request detail of a child resolves for a member.
    const detail = await publicProjectsService.getRequestDetail(
      fx.projectIdentifier,
      t.privTask.identifier,
      fx.ownerId,
    );
    expect(detail.identifier).toBe(t.privTask.identifier);
  });
});

describe('6.14.8 — defence-in-depth: the MEMBER-ONLY internal reads (7.0 ready set · 6.1 FilterAST search · detail) never leak to a cross-org non-member, but a member reads the child', () => {
  it('the 6.1 FilterAST SEARCH: a cross-org non-member is ProjectNotFound (can’t reach the project); a member’s title search returns the hidden child', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);
    const crossOrg = await makeWorkItemFixture({ name: 'Outsider Co', identifier: 'OUT' });

    // A cross-org viewer can't even target fx's project on the internal,
    // workspace-scoped search — it 404s before any row is evaluated. The
    // exclusion predicate never has to run on this path because the path is
    // members-only by construction.
    await expect(
      workItemsService.getProjectIssuesList(
        fx.projectId,
        { sort: DEFAULT_SORT, filter: { ast: titleContains('Hidden task') } },
        crossOrg.ctx,
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    // A MEMBER's FilterAST search DOES return the child — the privacy flag is a
    // public-projection concern only; it does not (and must not) blind a member's
    // internal search.
    const { items } = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT, filter: { ast: titleContains('Hidden task') } },
      fx.ctx,
    );
    expect(items.map((i) => i.identifier)).toContain(t.privTask.identifier);
  });

  it('the 7.0 READY SET: a cross-org non-member is ProjectNotFound', async () => {
    const fx = await makePublicProjectFixture();
    await buildTree(fx);
    const crossOrg = await makeWorkItemFixture({ name: 'Outsider Co', identifier: 'OUT' });

    await expect(workItemsService.listReady(fx.projectId, {}, crossOrg.ctx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('the internal DETAIL: a cross-org non-member is WorkItemNotFound on a hidden descendant', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx);
    const crossOrg = await makeWorkItemFixture({ name: 'Outsider Co', identifier: 'OUT' });

    await expect(
      workItemsService.getIssueDetail(fx.projectId, t.privTask.identifier, crossOrg.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});

describe('6.14.8 — the admin toggle drives enforcement live (through the real setEpicPrivacy write)', () => {
  it('setting the flag HIDES the children from a non-member; unsetting it RESTORES them (end-to-end, write → public read)', async () => {
    const fx = await makePublicProjectFixture();
    const t = await buildTree(fx, /* markPrivate */ false);
    const nonMember = await createTestUser();

    // Before any toggle: the children are public.
    let ids = (
      await publicProjectsService.getWorkItems(fx.projectIdentifier, nonMember.id)
    ).items.map((i) => i.id);
    expect(ids).toContain(t.privStory.id);
    expect(ids).toContain(t.privTask.id);

    // The project admin SETS privacy (the real 6.14.7 write) → the same
    // non-member loses the children and the epic row is marked.
    await workItemsService.setEpicPrivacy(t.privateEpic.id, true, fx.ctx);
    let page = await publicProjectsService.getWorkItems(fx.projectIdentifier, nonMember.id);
    ids = page.items.map((i) => i.id);
    expect(ids).not.toContain(t.privStory.id);
    expect(ids).not.toContain(t.privTask.id);
    expect(page.items.find((i) => i.id === t.privateEpic.id)?.childrenHidden).toBe(true);

    // The admin UNSETS it → the children come back, marker gone.
    await workItemsService.setEpicPrivacy(t.privateEpic.id, false, fx.ctx);
    page = await publicProjectsService.getWorkItems(fx.projectIdentifier, nonMember.id);
    ids = page.items.map((i) => i.id);
    expect(ids).toContain(t.privStory.id);
    expect(ids).toContain(t.privTask.id);
    expect(page.items.find((i) => i.id === t.privateEpic.id)?.childrenHidden).toBeUndefined();
  });

  it('the epic-kind guard: setEpicPrivacy on a NON-EPIC is rejected (NotEpicError) and writes nothing', async () => {
    const fx = await makePublicProjectFixture();
    const task = await createTestWorkItem(fx, { kind: 'task', title: 'Not an epic' });

    await expect(workItemsService.setEpicPrivacy(task.id, true, fx.ctx)).rejects.toBeInstanceOf(
      NotEpicError,
    );
    expect((await workItemRepository.findById(task.id))?.publicChildrenHidden).toBe(false);
  });

  it('the admin guard: a NON-ADMIN (plain workspace member) is rejected (403 / NotProjectAdminError) and writes nothing', async () => {
    const fx = await makePublicProjectFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Platform' });
    const member = await addWorkspaceMember(fx, 'member@example.com');

    await expect(workItemsService.setEpicPrivacy(epic.id, true, member.ctx)).rejects.toBeInstanceOf(
      NotProjectAdminError,
    );
    expect((await workItemRepository.findById(epic.id))?.publicChildrenHidden).toBe(false);
  });

  it('the already-set guard: a redundant set is an idempotent no-op (no updatedAt bump)', async () => {
    const fx = await makePublicProjectFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Platform' });

    const first = await workItemsService.setEpicPrivacy(epic.id, true, fx.ctx);
    const again = await workItemsService.setEpicPrivacy(epic.id, true, fx.ctx);
    expect(again.publicChildrenHidden).toBe(true);
    expect(again.updatedAt).toBe(first.updatedAt);
  });
});

describe('6.14.8 — the flag is a no-op off the public surface', () => {
  it('a NON-PUBLIC project is unreachable by a non-member (404) — the flag is inert there', async () => {
    const fx = await makeWorkItemFixture({ name: 'Private Co' }); // NOT public
    const t = await buildTree(fx);
    await setPrivate(t.privateEpic.id, true);
    const nonMember = await createTestUser();

    await expect(
      publicProjectsService.getWorkItems(fx.projectIdentifier, nonMember.id),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
