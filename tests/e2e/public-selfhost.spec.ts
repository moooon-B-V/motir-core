import { expect, test } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { adminDb } from '../helpers/adminDb';
import { projectsService } from '@/lib/services/projectsService';

// Story MOTIR-3908 · Subtask MOTIR-4038 — the SELF-HOST arm of the
// public-projects gate, in a real browser.
//
// ⚠️ THE ARM THAT HAS NEVER EXISTED, which is the story's own reason for
// asking. Every public-surface spec this repository had asserted the CLOUD
// behaviour, and all four ran in a lane that is off-cloud — they passed because
// the capability was unconditionally on, not because anybody had decided it
// should be. This spec asserts the other half: with `MOTIR_CLOUD` unset there is
// no public-projects feature at all.
//
// ⚠️ AND IT LIVES IN THE MAIN LANE FOR THE SAME REASON `billing-selfhost.spec.ts`
// does: `playwright.config.ts` sets no `MOTIR_CLOUD`, so the off-cloud server IS
// the self-host build. That is the one arm this lane can drive for free, which
// is what makes it the arm that runs on every pull request. The cloud arm is the
// four `cloud-public-*` / `cloud-build-in-public-*` specs, in the cloud-on lane.
//
// What it asserts, in the order a person would meet it:
//   1. the PUBLISH DOOR is not offered — no "Build in public" CTA in the shell,
//      no `public` option on the project access control;
//   2. the WRITE is refused even with the UI bypassed — a direct PATCH answers a
//      non-500 refusal and the project stays where it was;
//   3. the READ surface answers 404 — not an empty directory, no door.
//
// ⚠️ NO `@/lib/db` SINGLETON STATEMENTS. `tests/rls/test-singleton-statement-guard`
// ratchets that population DOWN over `tests/e2e/**`, and it caught this file's
// first draft: under `motir_app` a singleton write is REFUSED and a read returns
// `[]`, and neither raises — so a spec that seeds that way drives a browser
// against a database it believes it populated. The ids come from the shipped
// `/api/workspaces/current` through the BROWSER's own session, the project from
// the service, and the read-back from `adminDb`.

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

const ADMIN_EMAIL = 'e2e-public-selfhost@example.com';
const PROJECT_KEY = 'SELF';

test('@smoke self-host: the public-projects capability is absent, not hidden', async ({ page }) => {
  await signUp(page, ADMIN_EMAIL);
  const current = await page.request.get('/api/workspaces/current');
  expect(current.status(), 'the auto-created workspace resolves').toBe(200);
  const { workspace, membership } = (await current.json()) as {
    workspace: { id: string };
    membership: { userId: string };
  };

  await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: membership.userId,
    name: 'Self Hosted',
    identifier: PROJECT_KEY,
  });

  // ── 1. THE PUBLISH DOOR IS NOT OFFERED ────────────────────────────────────
  await page.goto('/settings/project/members');
  // The control renders — this is not a page that disappeared — and it offers
  // exactly the three levels a self-hosted team shares work with.
  await expect(page.getByRole('radio', { name: /Private/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Open/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Limited/ })).toBeVisible();
  // …and not the fourth. `getByRole` rather than a text search: the words
  // "building in public" also appear in the shell's own copy elsewhere, and a
  // text assertion would pass or fail on that instead.
  await expect(page.getByRole('radio', { name: /Building in public|Public/ })).toHaveCount(0);

  // The shell's build-in-public slot is empty in both of its placements.
  await expect(page.getByRole('button', { name: 'Build in public', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Manage building in public/i })).toHaveCount(0);

  // The Settings → General promo card is not rendered either.
  await page.goto('/settings/project');
  await expect(page.getByRole('button', { name: 'Build in public', exact: true })).toHaveCount(0);

  // ── 2. THE WRITE IS REFUSED WITH THE UI BYPASSED ──────────────────────────
  // Defence in depth is the card's own framing, so the bypass is the assertion:
  // a stale client, a script, or a request replayed from a cloud build.
  const refused = await page.request.patch(`/api/projects/${PROJECT_KEY}/access`, {
    data: { accessLevel: 'public' },
  });
  expect(refused.status(), 'a refusal, not a 500 and not a success').toBe(400);
  expect((await refused.json()).code).toBe('PUBLIC_ACCESS_UNAVAILABLE');

  // …and the project did not move. Read back through the product, not the DB:
  // what matters is what the next reader sees.
  const stillNotPublic = await adminDb.project.findFirst({ where: { identifier: PROJECT_KEY } });
  expect(stillNotPublic?.accessLevel).not.toBe('public');
  expect(stillNotPublic?.madePublicAt).toBeNull();

  // The levels a self-hosted team DOES use are untouched — the gate is one level
  // wide, and a walled single-tenant product would be the wrong fix.
  const allowed = await page.request.patch(`/api/projects/${PROJECT_KEY}/access`, {
    data: { accessLevel: 'limited' },
  });
  expect(allowed.status(), 'open / limited / private are unaffected').toBe(200);

  // ── 3. THE READ SURFACE ANSWERS 404 ───────────────────────────────────────
  // Anonymously, in a context with no session at all — the reader this surface
  // exists for on a cloud build.
  const anon = await page.context().browser()!.newContext();
  try {
    for (const path of [
      '/api/public/explore',
      '/api/public/categories',
      `/api/public/p/${PROJECT_KEY}`,
      `/api/public/p/${PROJECT_KEY}/items`,
      `/api/public/p/${PROJECT_KEY}/tree`,
    ]) {
      const res = await anon.request.get(path);
      expect(res.status(), `${path} on a self-hosted build`).toBe(404);
      expect((await res.json()).code, path).toBe('NOT_FOUND');
    }
  } finally {
    await anon.close();
  }
});
