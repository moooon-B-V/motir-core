import { projectsService } from '@/lib/services/projectsService';
import { signUp } from './_helpers/shell-session';
import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';

// Story MOTIR-3908 — PUBLIC PROJECTS ARE A CLOUD CAPABILITY, watched in a
// browser: a project admin publishes a project, and the public reading surface
// answers for a stranger.
//
// ── What a person is accepting here, and why it is worth a clip ────────────
//
// The story's product change is an ABSENCE — off-cloud there is no publish
// affordance, no public API, no directory. An absence is not watchable, and the
// acceptance lane is CLOUD-ON (`playwright.acceptance.config.ts` sets
// `MOTIR_CLOUD`), so this receipt records the arm that CAN be watched: the door
// is there, it works, and what comes out the other side is a project a
// logged-out reader can read. The self-hosted arm — the one that had never
// existed before this story — is asserted every pull request by
// `public-selfhost.spec.ts` in the off-cloud main lane, and end to end over real
// Postgres by `tests/integration/publicSurfaceCloudGate.test.ts`. Together they
// are the pair; this half is the one somebody can accept by watching.
//
// ⚠️ PACED FOR A HUMAN. The interesting moment is that publishing is a
// CONFIRMED act, not a toggle — the level opens a dialog that explains what is
// about to become visible to strangers — so that dialog gets its own beat.
//
// DETERMINISM: every wait is on an authoritative signal — the access PATCH's own
// 200, then an authoritative reload, then the public route's own response.
// Never a timeout.

const EMAIL = `public-cloud-gate-${Date.now()}@example.com`;
const KEY = 'PUBG';

// The resolved copy (messages/en.json › settings.access / settings.buildInPublic).
const ACCESS_GROUP = 'Project access level';
const START_CONFIRM = 'Start building in public';
const STATUS_BADGE = 'Building in public';

/** The admin's own workspace, from the shipped route through the browser's
 *  session — no `@/lib/db` singleton statements from an E2E spec. */
async function seedProject(page: Page): Promise<{ projectId: string }> {
  const res = await page.request.get('/api/workspaces/current');
  expect(res.status(), 'the auto-created workspace resolves').toBe(200);
  const { workspace, membership } = (await res.json()) as {
    workspace: { id: string };
    membership: { userId: string };
  };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: membership.userId,
    name: 'Public capability',
    identifier: KEY,
  });
  return { projectId: project.id };
}

test('a cloud build offers the publish door, and what it opens is readable by a stranger', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-3908');

  await signUp(page, EMAIL);
  await seedProject(page);

  // ── 1 — the door is on the control, and it is one of four ─────────────────
  await chapter('The access control offers building in public', async () => {
    await page.goto('/settings/project/members');
    const levels = page.getByRole('radiogroup', { name: ACCESS_GROUP });
    await expect(levels).toBeVisible();
    await beat();

    // All four levels, on a cloud build. Off-cloud the fourth is not offered at
    // all — that is the whole product change, and it is the assertion
    // `public-selfhost.spec.ts` makes from the other side.
    await expect(levels.getByRole('radio', { name: /Building in public|Public/ })).toBeVisible();
    await expect(levels.getByRole('radio', { name: /Open/ })).toBeVisible();
    await expect(levels.getByRole('radio', { name: /Limited/ })).toBeVisible();
    await expect(levels.getByRole('radio', { name: /Private/ })).toBeVisible();
    await beat();
  });

  // ── 2 — publishing is a CONFIRMED act, not a toggle ───────────────────────
  await chapter('Publishing asks first', async () => {
    await page
      .getByRole('radiogroup', { name: ACCESS_GROUP })
      .getByRole('radio', { name: /Building in public|Public/ })
      .click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await beat();

    const written = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api/projects/${KEY}/access` &&
        r.request().method() === 'PATCH',
    );
    await dialog.getByRole('button', { name: START_CONFIRM }).click();
    expect((await written).status(), 'the project is published').toBe(200);
    await beat();
  });

  // ── 3 — the team can see that it is live ──────────────────────────────────
  await chapter('The project is building in public', async () => {
    // An authoritative server read rather than trusting the refresh race: the
    // shell's build-in-public slot is server-rendered from the access level.
    await page.goto('/settings/project/members');
    // Scoped to the manage row — the bare status string also appears as the
    // access card's own radio label, and an unscoped locator trips strict mode.
    const manageRow = page.getByRole('link', { name: 'View public page' }).locator('..');
    await expect(manageRow.getByText(STATUS_BADGE, { exact: true })).toBeVisible();
    await beat();
  });

  // ── 4 — and a stranger can read it ────────────────────────────────────────
  //
  // The point of the whole capability, and the half a settings screen cannot
  // show: the reading surface answers somebody with no account at all. Off-cloud
  // this same request is a 404 with `{ code: 'NOT_FOUND' }` — there is no door.
  await chapter('A logged-out reader can read the project', async () => {
    const anon = await page.context().browser()!.newContext();
    try {
      const res = await anon.request.get(`/api/public/p/${KEY}`);
      expect(res.status(), 'the public surface serves an anonymous reader').toBe(200);
      expect(JSON.stringify(await res.json())).toContain(KEY);
    } finally {
      await anon.close();
    }
    await beat();
  });
});
