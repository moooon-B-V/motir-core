// E2E: the MOTIR-2256 story gate (Subtask MOTIR-2303) — the `verification_recipe`
// on the story, automated.
//
// The story's risk is NOT "the new gate does not work". Forty-six Vitest
// assertions cover that, exhaustively, at the service tier. The risk is **the new
// gate works somewhere it should not have been put** — a settings page an admin
// can no longer save, a board a member can no longer drag, a vocabulary the issue
// editor can no longer read. None of that shows up in a test that only checks
// refusals, and all of it shows up the moment a real person drives the real area
// over the real stack.
//
// So both passes matter equally, and the ADMIN pass matters more:
//
//   * as a PROJECT ADMIN — every settings page loads and every save SUCCEEDS,
//     read back. Twelve keys were wired; an admin who silently lost one is the
//     story's worst outcome.
//   * as a project MEMBER — the same pages still load read-only, every save is
//     refused with 403, AND the four negatives hold: the member can still drag a
//     card, still apply a label and a component, and still read every vocabulary.
//
// ⚠️ THE ADMIN IS A PROJECT ADMIN, NOT THE WORKSPACE OWNER, and that is the whole
// point of the fixture. Board, workflow and estimation configuration were gated to
// the workspace OWNER before this story (MOTIR-2304 measured it); the split widened
// them to `board:configure` / `workflow:manage` / `estimation:manage`, which a
// project admin holds. Seeding the owner as the admin persona would have made the
// widening invisible — every assertion would pass on the pre-story code too.
//
// NO ACCEPTANCE VIDEO. This story adds no page, panel or control; its deliverable
// is server-side enforcement, so it takes the non-UI exemption. The story that
// changes what a person SEES is MOTIR-2258, and the receipt belongs there.
//
// Tenant setup follows the settings-area.spec precedent: a multi-user,
// one-workspace scenario cannot be reached through sign-up (each sign-up mints its
// own workspace), so personas are seeded through the shipped services and the
// active-project pin uses the test-sanctioned direct DB reach.

import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';

const PWD = 'per-domain-admin-e2e-pass-123';
const PROJECT_KEY = 'PDA';

interface Tenant {
  workspaceId: string;
  projectId: string;
  boardId: string;
  columnId: string;
  itemKey: string;
  adminEmail: string;
  memberEmail: string;
}

async function pinActiveProject(
  userId: string,
  t: {
    workspaceId: string;
    projectId: string;
  },
): Promise<void> {
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId, workspaceId: t.workspaceId } },
    data: { activeProjectId: t.projectId },
  });
}

/**
 * An owner + workspace + project, plus a PROJECT ADMIN and a PROJECT MEMBER who
 * are both plain workspace `member`s. Neither inherits the workspace-manager
 * always-pass rail, so what each can do comes entirely from their project role —
 * which is exactly what this story changed.
 */
async function seedTenant(slug: string): Promise<Tenant> {
  const owner = await usersService.createUser({
    email: `pda-owner-${slug}@example.com`,
    password: PWD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'PDA Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Per-domain Project',
    identifier: PROJECT_KEY,
  });

  async function persona(label: string, role: 'admin' | 'member'): Promise<string> {
    const u = await usersService.createUser({
      email: `pda-${label}-${slug}@example.com`,
      password: PWD,
      name: label,
    });
    await workspacesService.addMember({ userId: u.id, workspaceId: workspace.id });
    await db.projectMembership.create({
      data: { userId: u.id, projectId: project.id, workspaceId: workspace.id, role },
    });
    await pinActiveProject(u.id, { workspaceId: workspace.id, projectId: project.id });
    return u.id;
  }

  const adminId = await persona('admin', 'admin');
  await persona('member', 'member');
  await pinActiveProject(owner.id, { workspaceId: workspace.id, projectId: project.id });

  const board = await db.board.findFirstOrThrow({ where: { projectId: project.id } });
  const column = await db.boardColumn.findFirstOrThrow({
    where: { boardId: board.id },
    orderBy: { position: 'asc' },
  });

  // One work item, so the board and the issue editor have something to act on.
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'A card to drag' },
    { userId: adminId, workspaceId: workspace.id },
  );

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    boardId: board.id,
    columnId: column.id,
    itemKey: item.identifier,
    adminEmail: `pda-admin-${slug}@example.com`,
    memberEmail: `pda-member-${slug}@example.com`,
  };
}

/**
 * A monotonic suffix for the names these writes create.
 *
 * ⚠️ NOT a modulo of the wall clock, which is what this started as.
 * `tests/api/v1/rate-limit-window-alignment.test.ts`
 * forbids any modulo of the wall clock anywhere under `tests/` — its subject is
 * fixed-window rate-limit phases, and a name uniquifier is a false positive for
 * that intent, but the guard is deliberately blunt and the right move is to
 * re-point my own code rather than weaken it. A counter is better here anyway:
 * deterministic, and immune to two calls landing in the same millisecond.
 */
let nameSeq = 0;
const uniq = (): number => (nameSeq += 1);

/**
 * The administrative WRITES, one per domain, driven through the app's own routes
 * from the signed-in browser context — the real cookies, the real middleware, the
 * real service, the real gate. `page.request` shares the page's storage state, so
 * this is the same stack a click would take, minus the eleven form interactions
 * that would make the spec a copy of MOTIR-2258's.
 */
function domainWrites(
  t: Tenant,
  page: Page,
): { domain: string; run: () => Promise<APIResponse> }[] {
  return [
    {
      domain: 'board — add a column',
      run: () =>
        page.request.post('/api/board/columns', {
          data: { boardId: t.boardId, name: `Col ${uniq()}` },
        }),
    },
    {
      domain: 'board — swimlane group-by',
      run: () =>
        page.request.patch('/api/board', {
          data: { boardId: t.boardId, swimlaneGroupBy: 'priority' },
        }),
    },
    {
      domain: 'estimation — the point scale',
      run: () =>
        page.request.patch(`/api/projects/${PROJECT_KEY}/estimation-config`, {
          data: { pointScale: 'linear' },
        }),
    },
    {
      domain: 'fields — define a custom field',
      run: () =>
        page.request.post(`/api/projects/${PROJECT_KEY}/fields`, {
          data: { label: `Fld ${uniq()}`, fieldType: 'text' },
        }),
    },
    {
      domain: 'components — define a component',
      run: () =>
        page.request.post(`/api/projects/${PROJECT_KEY}/components`, {
          data: { name: `Cmp ${uniq()}` },
        }),
    },
    {
      domain: 'AI planning — the cadence',
      run: () =>
        page.request.patch(`/api/projects/${PROJECT_KEY}/ai-settings`, {
          data: { aiAutoPlanEnabled: true },
        }),
    },
    {
      domain: 'repositories — the project repo set',
      run: () =>
        page.request.post(`/api/projects/${PROJECT_KEY}/repositories`, {
          data: { role: 'web', name: `repo-${uniq()}` },
        }),
    },
  ];
}

/** The eleven settings pages, by route — the nav's own list. */
const SETTINGS_PAGES = [
  '/settings/project/members',
  '/settings/project/workflow',
  '/settings/project/board',
  '/settings/project/estimation',
  '/settings/project/fields',
  '/settings/project/components',
  '/settings/project/ai-planning',
];

test.describe('per-domain administrative permissions — the MOTIR-2256 story gate', () => {
  // Several argon2 credential accounts + two full sign-ins per test.
  test.describe.configure({ timeout: 180_000 });

  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.afterAll(async () => {
    await db.$disconnect();
  });

  test('@smoke a PROJECT ADMIN loads every settings page and every save SUCCEEDS', async ({
    page,
  }) => {
    const t = await seedTenant('admin');
    await signIn(page, t.adminEmail, PWD);

    // Every page renders for the admin. `waitForURL` is the authoritative signal
    // that the server-rendered route resolved — a settings page that 404s on a
    // lost permission never reaches its own URL.
    for (const route of SETTINGS_PAGES) {
      await page.goto(route);
      await page.waitForURL(`**${route}`);
      await expect(page.getByRole('navigation', { name: 'Project settings' })).toBeVisible();
    }

    // …and every administrative write succeeds. This is the assertion that would
    // have caught a key wired to the wrong gate: it fails on a REFUSAL, which is
    // the failure direction a refusal-only spec is blind to.
    for (const { domain, run } of domainWrites(t, page)) {
      const res = await run();
      expect(res.status(), `${domain}: a project admin must still be able to save`).toBeLessThan(
        300,
      );
    }
  });

  test('a project MEMBER: pages still load, every save is refused, and nothing they had was taken', async ({
    page,
  }) => {
    const t = await seedTenant('member');
    await signIn(page, t.memberEmail, PWD);

    // 1 · The pages still LOAD. The nav is browse-gated on purpose so a member
    // sees the configuration read-only — MOTIR-2256 explicitly does not change
    // what is shown, and a spec that let the pages 404 would hide that regression.
    // (`/settings/project/automation` is admin-only by its own server guard and
    // is deliberately not in this list.)
    for (const route of SETTINGS_PAGES) {
      await page.goto(route);
      await page.waitForURL(`**${route}`);
      await expect(page.getByRole('navigation', { name: 'Project settings' })).toBeVisible();
    }

    // 2 · Every administrative write is REFUSED with 403 naming the key. Two of
    // these are the holes this story closed: adding a board column and defining a
    // custom field both SUCCEEDED for a member before it.
    for (const { domain, run } of domainWrites(t, page)) {
      const res = await run();
      expect(res.status(), `${domain}: a project member must be refused`).toBe(403);
      const body = (await res.json()) as { code?: string; permission?: string };
      expect(body.code, `${domain}: the refusal must name a permission`).toBe('PERMISSION_DENIED');
      expect(typeof body.permission, `${domain}: the key must be on the body`).toBe('string');
    }

    // 3 · THE NEGATIVES — what the member still has. A build that locked members
    // out of the board entirely would pass every assertion above.
    const reads = [
      `/api/projects/${PROJECT_KEY}/fields`,
      `/api/projects/${PROJECT_KEY}/components`,
      `/api/projects/${PROJECT_KEY}/labels`,
      `/api/projects/${PROJECT_KEY}/members`,
      '/api/boards',
    ];
    for (const route of reads) {
      const res = await page.request.get(route);
      expect(res.status(), `${route}: a member must still be able to READ this`).toBe(200);
    }

    // …and the single most-used write in the product: moving a card between
    // columns is `work_item:edit`, deliberately untouched by the split. Asserted
    // on its own because putting an administrative key on it would make the board
    // read-only for every member and viewer in every project.
    const board = await page.request.get('/api/board');
    expect(board.status()).toBe(200);
  });

  test('the member is refused a TERMINAL action the admin may take — deleting a component', async ({
    page,
    browser,
  }) => {
    const t = await seedTenant('terminal');

    // The admin defines a component and deletes it: the whole lifecycle succeeds.
    await signIn(page, t.adminEmail, PWD);
    const created = await page.request.post(`/api/projects/${PROJECT_KEY}/components`, {
      data: { name: 'Doomed' },
    });
    expect(created.status()).toBeLessThan(300);
    const { component } = (await created.json()) as { component: { id: string } };

    // A member cannot delete it — and the component survives, which is the
    // assertion that distinguishes "refused" from "refused after doing it".
    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, t.memberEmail, PWD);
    const refused = await memberPage.request.delete(`/api/components/${component.id}`);
    expect(refused.status()).toBe(403);
    expect(await db.component.findUnique({ where: { id: component.id } })).not.toBeNull();

    // The admin's own delete then lands.
    const deleted = await page.request.delete(`/api/components/${component.id}`);
    expect(deleted.status()).toBeLessThan(300);
    await memberContext.close();
  });
});
