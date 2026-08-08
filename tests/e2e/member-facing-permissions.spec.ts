// E2E: the MOTIR-2291 story gate (Subtask MOTIR-2368) — the `verification_recipe`
// on the story, automated.
//
// The story's risk is NOT "the new gates do not work". Several hundred Vitest
// assertions cover that at the service tier. The risk is that a story of fifteen
// revocations took something it did not mean to — a member who can no longer rank
// a backlog, a viewer who can no longer open a report, a board that went
// read-only. None of that shows up in a spec that only checks refusals, and all of
// it shows up the moment a real person drives the real stack.
//
// So the POSITIVE half of every table below is the half that matters most, and it
// gets as many assertions as the refusals do.
//
// ⚠️ ASSERT THE REFUSAL WHERE THE USER MEETS IT — and this story builds no UI
// treatment for one (that is MOTIR-2258's). So a refused write is asserted on its
// AUTHORITATIVE POST-CONDITION: the sprint is still not started, the item is still
// in the backlog, the filter was never created. Never on a toast this story did not
// build, and never on a network response the page swallows.
//
// ⚠️ THE PERSONAS ARE PROJECT ROLES ON PLAIN WORKSPACE MEMBERS. Seeding the
// workspace owner as the admin would make every assertion pass on the pre-story
// code too — the owner rides the always-pass rail and always could do all of this.
// The fourth persona has NO project membership at all: they are the actor
// `IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS` describes, the one the UI cannot
// represent, and the one `ai:plan`-at-member is really about.
//
// NO ACCEPTANCE VIDEO. The story ships no page, panel or control; the only visible
// difference is a refusal the shipped client already renders however it renders
// it. Non-UI by the acceptance-video rule's own test, exactly as MOTIR-2256 was.

import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { encodeFilterParam } from '@/lib/filters/ast';

const PWD = 'member-facing-e2e-pass-123';
const PROJECT_KEY = 'MFP';

interface Tenant {
  workspaceId: string;
  projectId: string;
  sprintId: string;
  itemId: string;
  itemKey: string;
  adminEmail: string;
  memberEmail: string;
  viewerEmail: string;
  /** A workspace member with NO project membership — the implicit grant. */
  outsiderEmail: string;
}

async function pinActiveProject(
  userId: string,
  t: { workspaceId: string; projectId: string },
): Promise<void> {
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId, workspaceId: t.workspaceId } },
    data: { activeProjectId: t.projectId },
  });
}

/**
 * An `open` project (the default) with an admin, a member, a viewer and a
 * membership-less workspace member. `open` is deliberate: on a `private` project
 * the outsider cannot browse at all, and the assertion this spec wants from them
 * — "still edits, cannot plan" — would be unreachable.
 */
async function seedTenant(slug: string): Promise<Tenant> {
  const owner = await usersService.createUser({
    email: `mfp-owner-${slug}@example.com`,
    password: PWD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'MFP Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Member-facing Project',
    identifier: PROJECT_KEY,
  });

  async function persona(label: string, role: 'admin' | 'member' | 'viewer' | null) {
    const u = await usersService.createUser({
      email: `mfp-${label}-${slug}@example.com`,
      password: PWD,
      name: label,
    });
    await workspacesService.addMember({ userId: u.id, workspaceId: workspace.id });
    if (role) {
      await db.projectMembership.create({
        data: { userId: u.id, projectId: project.id, workspaceId: workspace.id, role },
      });
    }
    await pinActiveProject(u.id, { workspaceId: workspace.id, projectId: project.id });
    return u.id;
  }

  await persona('admin', 'admin');
  await persona('member', 'member');
  await persona('viewer', 'viewer');
  await persona('outsider', null);
  await pinActiveProject(owner.id, { workspaceId: workspace.id, projectId: project.id });

  const ownerCtx = { userId: owner.id, workspaceId: workspace.id };
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'A card to groom' },
    ownerCtx,
  );
  const sprint = await sprintsService.createSprint(project.id, { name: 'Sprint A' }, ownerCtx);

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    sprintId: sprint.id,
    itemId: item.id,
    itemKey: item.identifier,
    adminEmail: `mfp-admin-${slug}@example.com`,
    memberEmail: `mfp-member-${slug}@example.com`,
    viewerEmail: `mfp-viewer-${slug}@example.com`,
    outsiderEmail: `mfp-outsider-${slug}@example.com`,
  };
}

/** The reads every browsing actor keeps — the regression half, per key. */
function readsEveryBrowserKeeps(t: Tenant): string[] {
  return [
    '/api/board',
    '/api/backlog',
    '/api/sprints',
    `/api/sprints/${t.sprintId}/issues`,
    `/api/projects/${PROJECT_KEY}/velocity`,
    `/api/projects/${PROJECT_KEY}/roadmap`,
    `/api/projects/${PROJECT_KEY}/saved-filters`,
  ];
}

let filterSeq = 0;

/** The writes this story moved, one per key, driven through the real stack. */
function gatedWrites(t: Tenant, page: Page): { name: string; run: () => Promise<APIResponse> }[] {
  return [
    {
      name: 'sprint:manage — start the sprint',
      run: () => page.request.post(`/api/sprints/${t.sprintId}/start`, { data: {} }),
    },
    {
      name: 'sprint:manage — move the item into the sprint',
      run: () =>
        page.request.post(`/api/work-items/${t.itemId}/sprint`, { data: { sprintId: t.sprintId } }),
    },
    {
      // ⚠️ A REAL encoded filter, not the `'v1:'` stub this started as — an
      // invalid AST is rejected at 400 before the gate is ever consulted, so the
      // stub made the ADMIN row fail and would have made every REFUSAL row pass
      // for the wrong reason.
      name: 'saved_filter:manage — author a filter',
      run: () =>
        page.request.post(`/api/projects/${PROJECT_KEY}/saved-filters`, {
          data: {
            name: `Filter ${(filterSeq += 1)}`,
            visibility: 'private',
            filterParam: encodeFilterParam({
              combinator: 'and',
              conditions: [{ field: 'priority', operator: 'is_any_of', value: ['high'] }],
            }),
          },
        }),
    },
    {
      name: 'ai:plan — open a plan-change session',
      run: () => page.request.post('/api/ai/plan-change/session', { data: {} }),
    },
    {
      name: 'work_item:triage — read the moderation queue',
      run: () => page.request.get(`/api/projects/${PROJECT_KEY}/triage/queue`),
    },
  ];
}

test.describe('MOTIR-2291 — the member-facing permissions, end to end', () => {
  test.beforeAll(async () => {
    await resetDatabase();
  });

  test.afterAll(async () => {
    await db.$disconnect();
  });

  test('@smoke a project ADMIN can still do everything the story touched', async ({ page }) => {
    // The assertion that would catch an over-tightened gate: it fails on a
    // REFUSAL, which is the direction a refusal-only spec is blind to.
    const t = await seedTenant('admin');
    await signIn(page, t.adminEmail, PWD);

    for (const route of readsEveryBrowserKeeps(t)) {
      const res = await page.request.get(route);
      expect(res.status(), `${route}: an admin must still read this`).toBe(200);
    }
    for (const { name, run } of gatedWrites(t, page)) {
      const res = await run();
      expect(res.status(), `${name}: an admin must still be able to do this`).toBeLessThan(300);
    }
    // …and the two ADMIN-ONLY keys, which nobody below may use.
    const importDraft = await page.request.post('/api/import', {
      data: { projectId: t.projectId, source: 'csv' },
    });
    expect(importDraft.status(), 'import:run — an admin runs importers').toBeLessThan(300);
    const archived = await page.request.post(`/api/work-items/${t.itemId}/archive`, { data: {} });
    expect(archived.status(), 'work_item:delete — an admin archives').toBeLessThan(300);
  });

  test('a project MEMBER keeps the everyday work and loses the two admin keys', async ({
    page,
  }) => {
    const t = await seedTenant('member');
    await signIn(page, t.memberEmail, PWD);

    // 1 · Everything a member does all day still works. This is the half that
    // catches the story taking too much.
    for (const route of readsEveryBrowserKeeps(t)) {
      const res = await page.request.get(route);
      expect(res.status(), `${route}: a member must still read this`).toBe(200);
    }
    for (const { name, run } of gatedWrites(t, page)) {
      const res = await run();
      expect(res.status(), `${name}: a member must still be able to do this`).toBeLessThan(300);
    }
    // Ranking the backlog is the single most-used grooming write.
    const ranked = await page.request.post(`/api/work-items/${t.itemId}/rank`, { data: {} });
    expect(ranked.status(), 'sprint:manage — a member still ranks the backlog').toBeLessThan(300);

    // 2 · The two the decision record takes from them, each asserted on its
    // AUTHORITATIVE POST-CONDITION rather than on a status alone.
    const importRefused = await page.request.post('/api/import', {
      data: { projectId: t.projectId, source: 'csv' },
    });
    expect(importRefused.status(), 'import:run is admin-only').toBe(403);
    expect(await db.import.count({ where: { projectId: t.projectId } })).toBe(0);

    const archiveRefused = await page.request.post(`/api/work-items/${t.itemId}/archive`, {
      data: {},
    });
    expect(archiveRefused.status(), 'work_item:delete is admin-only').toBe(403);
    const item = await db.workItem.findUniqueOrThrow({ where: { id: t.itemId } });
    expect(item.archivedAt, 'the refused archive changed nothing').toBeNull();
  });

  test('a project VIEWER browses everything and writes nothing', async ({ page }) => {
    const t = await seedTenant('viewer');
    await signIn(page, t.viewerEmail, PWD);

    // 1 · A viewer is a READER, and the story must not have broken that. The
    // reports in particular: `report:view` is browse-wide by decision, so a
    // viewer who lost a chart is a bug in the decision's implementation.
    for (const route of readsEveryBrowserKeeps(t).filter(
      (r) => !r.includes('/triage/'), // the queue moved to `work_item:triage` on purpose
    )) {
      const res = await page.request.get(route);
      expect(res.status(), `${route}: a viewer must still read this`).toBe(200);
    }

    // 2 · Every gated write is refused, and the STATE is what proves it.
    for (const { name, run } of gatedWrites(t, page)) {
      const res = await run();
      expect(res.status(), `${name}: a viewer must be refused`).toBeGreaterThanOrEqual(400);
    }
    const sprint = await db.sprint.findUniqueOrThrow({ where: { id: t.sprintId } });
    expect(sprint.state, 'the refused start left the sprint planned').toBe('planned');
    const item = await db.workItem.findUniqueOrThrow({ where: { id: t.itemId } });
    expect(item.sprintId, 'the refused move left the item in the backlog').toBeNull();
    expect(
      await db.savedFilter.count({ where: { projectId: t.projectId } }),
      'the refused save created no filter',
    ).toBe(0);
    expect(
      await db.planChangeSession.count({ where: { projectId: t.projectId } }),
      'the refused planning turn opened no thread',
    ).toBe(0);
  });

  test('a WORKSPACE MEMBER with no project membership still edits, and cannot plan', async ({
    page,
  }) => {
    // The actor the UI cannot represent and the decision record's §2 is about.
    // They hold `work_item:edit` through the implicit grant — which is what these
    // AI paths used to ask for — and deliberately NOT `ai:plan`, so they could
    // spend the workspace's credits on a project nobody put them on.
    const t = await seedTenant('outsider');
    await signIn(page, t.outsiderEmail, PWD);

    // Still a full participant on an `open` project…
    const board = await page.request.get('/api/board');
    expect(board.status(), 'the implicit grant still browses').toBe(200);
    // `work_item:edit`, through the route that actually carries it: authoring an
    // issue into the backlog. (A field edit is a Server Action, not a REST PATCH —
    // `PATCH /api/work-items/[id]` is a 405, which is what this assertion first
    // caught about its own request rather than about the product.)
    const authored = await page.request.post('/api/backlog', {
      data: { title: 'Authored by a non-member', kind: 'task' },
    });
    expect(authored.status(), 'the implicit grant still holds work_item:edit').toBeLessThan(300);
    const charts = await page.request.get(`/api/projects/${PROJECT_KEY}/velocity`);
    expect(charts.status(), 'report:view is the ONE of the eight they take').toBe(200);

    // …and cannot run the planner.
    const planning = await page.request.post('/api/ai/plan-change/session', { data: {} });
    expect(planning.status(), 'ai:plan is NOT in the implicit grant').toBe(403);
    expect(
      await db.planChangeSession.count({ where: { projectId: t.projectId } }),
      'no thread was opened',
    ).toBe(0);
  });
});
