import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { publicRequestsService } from '@/lib/services/publicRequestsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { truncateAuthTables } from '../helpers/db';

// Story 6.12 · Subtask 6.12.9 — the STORY-level integration guarantees that the
// per-subtask suites don't yet lock end-to-end, against a real Postgres (the
// standing rule). The sibling suites already cover their own slice:
//   * the PURE access policy + `getPublicCapabilities` — `project-access-service.test.ts`
//   * submit-to-triage + duplicate detection — `publicProjects/publicSubmit.test.ts`
//   * upvote / comment / the vote-count queue sort — `publicRequests/upvoteComment.test.ts`
// This file fills the two remaining load-bearing gaps:
//   1. The public READ *services* (6.12.4) — the projection PAYLOAD exclusion
//      (`getBoard` / `getWorkItems` / `getOverview` strip assignee / estimate /
//      story points at the wire shape, not just the DOM), anonymous + cross-org
//      reads, and the non-public 404 through those reads. (The shipped
//      `publicProjectionStats.test.ts` only exercises the repository COUNT
//      helpers, never the read services themselves.)
//   2. The integration ACCESS MATRIX — every NORMAL write is rejected for an
//      external actor on a public project (the shared `assertCanEdit` gate every
//      write funnels through, plus concrete write SERVICES proving the wiring),
//      while READ is open; and the 6.12.5→6.12.4 / 6.12.6→6.12.4 seams (a
//      submitted public request stays invisible to the public read until
//      promoted; an upvote shows up in the Overview demand stats).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** A fixture whose project is set PUBLIC (the make-public toggle is 6.12.8, not
 *  yet wired through a service, so the test sets the column directly — the same
 *  shortcut the sibling public-project suites use). */
async function makePublicProjectFixture(name = 'Acme'): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture({ name });
  await db.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
  return fx;
}

/** An internal work item with EVERY public-hidden field populated (assignee +
 *  time estimate + story points), so the projection assertions below prove the
 *  fields are STRIPPED, not merely never-set. Returns the row id. */
async function seedItemWithInternalFields(fx: WorkItemFixture, title: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  await db.workItem.update({
    where: { id: item.id },
    // The owner is a workspace member → a legal assignee; the estimate/points are
    // internal-only fields the public projection must never surface.
    data: { assigneeId: fx.ownerId, estimateMinutes: 480, storyPoints: 8 },
  });
  return item.id;
}

/** The public-safe keys a projected card MUST carry, and the internal keys it
 *  must NEVER carry (absent from the DTO shape, so absent from the payload). */
const PUBLIC_CARD_KEYS = [
  'id',
  'identifier',
  'key',
  'title',
  'kind',
  'status',
  'statusCategory',
  'priority',
] as const;
const INTERNAL_KEYS = [
  'assignee',
  'assigneeId',
  'estimateMinutes',
  'storyPoints',
  'descriptionMd',
] as const;

function expectPublicSafe(card: Record<string, unknown>): void {
  for (const k of PUBLIC_CARD_KEYS) expect(card).toHaveProperty(k);
  for (const k of INTERNAL_KEYS) expect(card).not.toHaveProperty(k);
}

// ---------------------------------------------------------------------------
// 1. Anonymous + cross-org READ through the public read services (6.12.4)
// ---------------------------------------------------------------------------

describe('public READ access (6.12.9) — anonymous + cross-org, non-public 404', () => {
  it('an ANONYMOUS (null actor) and a CROSS-ORG account both read Overview / Board / Work-items', async () => {
    const fx = await makePublicProjectFixture();
    await seedItemWithInternalFields(fx, 'Public-visible task');
    const crossOrg = await createTestUser(); // a fresh account, NOT a member of fx.workspace

    for (const actor of [null, crossOrg.id]) {
      const overview = await publicProjectsService.getOverview(fx.projectIdentifier, actor);
      expect(overview.identifier).toBe('PROD');
      expect(overview.workspaceName).toBe('Acme');

      const board = await publicProjectsService.getBoard(fx.projectIdentifier, actor);
      expect(Array.isArray(board.columns)).toBe(true);
      expect(board.cap).toBeGreaterThan(0);

      const page = await publicProjectsService.getWorkItems(fx.projectIdentifier, actor);
      expect(page.items.length).toBe(1);
    }
  });

  it('getPublicCapabilities: anonymous browses + all three write grants are open on a public project', async () => {
    const fx = await makePublicProjectFixture();
    const caps = await projectAccessService.getPublicCapabilities(fx.projectId, null);
    expect(caps).toEqual({
      canBrowse: true,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    });
  });

  it('a NON-public project reads as 404 through every public read (the cross-org exception is public-only)', async () => {
    const fx = await makeWorkItemFixture({ name: 'Private Co' }); // default access — NOT public
    const crossOrg = await createTestUser();

    await expect(
      publicProjectsService.getOverview(fx.projectIdentifier, crossOrg.id),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(publicProjectsService.getBoard(fx.projectIdentifier, null)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
    await expect(
      publicProjectsService.getWorkItems(fx.projectIdentifier, crossOrg.id),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// 2. The public PROJECTION strips internal fields at the PAYLOAD level (6.12.4)
// ---------------------------------------------------------------------------

describe('public PROJECTION payload (6.12.9) — internal fields never cross the wire', () => {
  it('getWorkItems returns ONLY public-safe fields — assignee / estimate / story points absent', async () => {
    const fx = await makePublicProjectFixture();
    const itemId = await seedItemWithInternalFields(fx, 'Stripped task');

    const page = await publicProjectsService.getWorkItems(fx.projectIdentifier, null);
    const card = page.items.find((c) => c.id === itemId);
    expect(card).toBeDefined();
    expectPublicSafe(card as unknown as Record<string, unknown>);
    // The public-safe values are the real ones (not blanked).
    expect(card!.identifier).toMatch(/^PROD-\d+$/);
    expect(card!.title).toBe('Stripped task');
  });

  it('getBoard cards carry the SAME stripped projection', async () => {
    const fx = await makePublicProjectFixture();
    const itemId = await seedItemWithInternalFields(fx, 'Board task');

    const board = await publicProjectsService.getBoard(fx.projectIdentifier, null);
    const cards = board.columns.flatMap((c) => c.cards);
    // A fresh item is born in the initial `todo` status → it lands on the board.
    const card = cards.find((c) => c.id === itemId);
    expect(card).toBeDefined();
    expectPublicSafe(card as unknown as Record<string, unknown>);
  });

  it('a TRIAGE submission stays invisible to the public read until promoted (the 6.12.5 → 6.12.4 seam)', async () => {
    const fx = await makePublicProjectFixture();
    await seedItemWithInternalFields(fx, 'A real public item');
    const submitter = await createTestUser();

    // A cross-org public submission is born in triage (6.12.5).
    const submission = await publicProjectsService.submitPublicRequest(fx.projectId, submitter.id, {
      kind: 'bug',
      title: 'Crash on save',
    });

    // It is EXCLUDED from the public board + work-items list (triage-excluded read).
    const page = await publicProjectsService.getWorkItems(fx.projectIdentifier, null);
    expect(page.items.map((i) => i.id)).not.toContain(submission.id);
    const board = await publicProjectsService.getBoard(fx.projectIdentifier, null);
    expect(board.columns.flatMap((c) => c.cards).map((c) => c.id)).not.toContain(submission.id);
    // …but the normal item is still there.
    expect(page.items.length).toBe(1);
  });

  it('an upvote surfaces in the Overview demand stats (the 6.12.6 → 6.12.4 seam)', async () => {
    const fx = await makePublicProjectFixture();
    const submitter = await createTestUser();
    const voter = await createTestUser();

    const submission = await publicProjectsService.submitPublicRequest(fx.projectId, submitter.id, {
      kind: 'task',
      title: 'A requested feature',
    });

    const before = await publicProjectsService.getOverview(fx.projectIdentifier, null);
    expect(before.stats.publicRequests).toBe(1);
    expect(before.stats.upvotes).toBe(0);

    await publicRequestsService.toggleUpvote(submission.id, { userId: voter.id });

    const after = await publicProjectsService.getOverview(fx.projectIdentifier, null);
    expect(after.stats.upvotes).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. The integration ACCESS MATRIX — every normal write is blocked (6.12.3)
// ---------------------------------------------------------------------------

describe('public WRITE matrix (6.12.9) — normal writes blocked, the three grants open', () => {
  it('the shared edit gate rejects an external actor (read-only 403) while browse stays open', async () => {
    const fx = await makePublicProjectFixture();
    const crossOrg = await createTestUser();
    // The actor presents the project's workspace as context (the closest an
    // external actor can get): they are not a member, so workspaceRole is null.
    const crossOrgCtx = { userId: crossOrg.id, workspaceId: fx.workspaceId };

    // canBrowse true (the public exception), canEdit false (the null-deny rail).
    expect(await projectAccessService.getCapabilities(fx.projectId, crossOrgCtx)).toEqual({
      canBrowse: true,
      canEdit: false,
    });

    // EVERY normal write funnels through this one gate — so a single rejection
    // here is the matrix's load-bearing assertion (kind 'edit' → HTTP 403,
    // read-only; NOT 'browse'/404 — the public project is visible).
    const err = await projectAccessService.assertCanEdit(fx.projectId, crossOrgCtx).catch((e) => e);
    expect(err).toBeInstanceOf(ProjectAccessDeniedError);
    expect((err as ProjectAccessDeniedError).kind).toBe('edit');
  });

  it('concrete write SERVICES (field-edit / status / assign / move) each reject the external actor', async () => {
    const fx = await makePublicProjectFixture();
    const itemId = await seedItemWithInternalFields(fx, 'Hands off');
    const crossOrg = await createTestUser();
    const ctx = { userId: crossOrg.id, workspaceId: fx.workspaceId };

    // field-edit
    await expect(
      workItemsService.updateWorkItem(itemId, { title: 'hijacked' }, ctx),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    // status transition
    await expect(workItemsService.updateStatus(itemId, 'in_progress', ctx)).rejects.toBeInstanceOf(
      ProjectAccessDeniedError,
    );
    // assign (funnels through updateWorkItem → assertCanEdit BEFORE the
    // assignee-membership check, so it is the edit denial, not an assignee error)
    await expect(workItemsService.assignWorkItem(itemId, crossOrg.id, ctx)).rejects.toBeInstanceOf(
      ProjectAccessDeniedError,
    );
    // move / reorder (empty input still reaches the gate)
    await expect(workItemsService.moveWorkItem(itemId, {}, ctx)).rejects.toBeInstanceOf(
      ProjectAccessDeniedError,
    );

    // The item is UNCHANGED by any of the rejected writes.
    const row = await db.workItem.findUnique({ where: { id: itemId } });
    expect(row!.title).toBe('Hands off');
    expect(row!.status).toBe('todo');
  });

  it('CREATE is blocked for a non-member external actor (no work item is born)', async () => {
    const fx = await makePublicProjectFixture();
    const crossOrg = await createTestUser();
    const ctx = { userId: crossOrg.id, workspaceId: fx.workspaceId };

    await expect(
      workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title: 'x' }, ctx),
    ).rejects.toThrow();
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('the three write GRANTS each succeed for a signed-in cross-org account', async () => {
    const fx = await makePublicProjectFixture();
    const actor = await createTestUser();

    // submit — lands a triage request
    const submission = await publicProjectsService.submitPublicRequest(fx.projectId, actor.id, {
      kind: 'task',
      title: 'Please add CSV export',
    });
    expect(submission.identifier).toMatch(/^PROD-\d+$/);

    // upvote — one vote per account
    const voted = await publicRequestsService.toggleUpvote(submission.id, { userId: actor.id });
    expect(voted).toEqual({ voted: true, voteCount: 1 });

    // comment — a public-visible comment attributed to the cross-org account
    const comment = await publicRequestsService.addComment(
      submission.id,
      { bodyMd: '+1 from me' },
      { userId: actor.id },
    );
    expect(comment.author.id).toBe(actor.id);
    const row = await db.comment.findUnique({ where: { id: comment.id } });
    expect(row!.isPublic).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Public hero fields + viewerCanManage on the Overview read (6.16.3)
// ---------------------------------------------------------------------------

describe('public Overview hero (6.16.3) — authored tagline/tags + viewerCanManage', () => {
  it('surfaces the authored tagline + tags through the public Overview projection', async () => {
    const fx = await makePublicProjectFixture();
    // Author the hero via the admin write path (fx owner manages the project).
    await projectsService.setPublicOverview({
      key: fx.projectIdentifier,
      ctx: fx.ctx,
      publicTagline: 'Plan, build, ship',
      publicTags: ['agile', 'roadmap'],
    });

    const overview = await publicProjectsService.getOverview(fx.projectIdentifier, null);
    expect(overview.publicTagline).toBe('Plan, build, ship');
    expect(overview.publicTags).toEqual(['agile', 'roadmap']);
  });

  it('defaults the hero fields when never authored (null tagline, empty tags)', async () => {
    const fx = await makePublicProjectFixture();
    const overview = await publicProjectsService.getOverview(fx.projectIdentifier, null);
    expect(overview.publicTagline).toBeNull();
    expect(overview.publicTags).toEqual([]);
  });

  it('viewerCanManage is TRUE only for a managing viewer; false for anon + cross-org', async () => {
    const fx = await makePublicProjectFixture();
    const crossOrg = await createTestUser();

    // The project owner (workspace owner → manager) reads an editable hero.
    const asOwner = await publicProjectsService.getOverview(fx.projectIdentifier, fx.ownerId);
    expect(asOwner.viewerCanManage).toBe(true);

    // An anonymous reader and a cross-org account never get the edit ability.
    const asAnon = await publicProjectsService.getOverview(fx.projectIdentifier, null);
    expect(asAnon.viewerCanManage).toBe(false);
    const asCrossOrg = await publicProjectsService.getOverview(fx.projectIdentifier, crossOrg.id);
    expect(asCrossOrg.viewerCanManage).toBe(false);
  });
});
