// The "M" AI callout's GATE — with Motir AI not configured, the orb is absent
// entirely (Subtask MOTIR-1814, Story MOTIR-1342).
//
// This is the second half of the story's acceptance flow. The first half — orb →
// menu → the planning workspace, plus both dismissals — is
// `acceptance-ai-callout.spec.ts`, which runs in the acceptance-video lane
// because it records the story's acceptance clip.
//
// ⚠️ WHY THE GATED CASE LIVES IN A SEPARATE FILE, IN THE MAIN LANE.
// `showPlanWithAi` (app/(authed)/layout.tsx) is
// `isMotirAiConfigured() && Boolean(activeProject)`, and `isMotirAiConfigured()`
// (lib/ai/availability.ts) is a SERVER-side read of MOTIR_AI_URL +
// MOTIR_AI_SERVICE_TOKEN — process-wide, resolved per render, with no per-test
// override and no client seam a `page.route` could reach. The acceptance lane
// sets both vars on its webServer (playwright.acceptance.config.ts), so inside
// that lane the gate is true for every test and the absence is unassertable.
//
// The MAIN lane deliberately leaves the MOTIR_AI pair unset — that is a standing
// decision, not an oversight: setting it there mounts the shell's AI affordances
// across every authed spec and has already broken the mobile settings drawer at
// 375px (the orb intercepted the hamburger). So this lane is where "AI is not
// configured" is the app's REAL state, and asserting the absence here exercises
// the shipped gate rather than a mock. It doubles as the regression guard for
// that standing decision: if the pair is ever added to playwright.config.ts, this
// spec goes red first.
//
// The assertion is made only AFTER the shell is proven rendered — an absence
// assertion on a page that never loaded passes vacuously.

import { test, expect } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';

const PASSWORD = 'ai-callout-gate-e2e-pass-7';

/** The gate's OTHER input satisfied in full: a signed-in user with an ACTIVE
 *  project. So the only thing left holding the orb back is the AI config. */
async function seedActiveProject(email: string): Promise<void> {
  const owner = await usersService.createUser({ email, password: PASSWORD, name: 'Callout Gate' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Callout Gate E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Callout Gate',
    identifier: 'CGT',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('with Motir AI not configured there is no orb and no callout', async ({ page }) => {
  const email = `ai-callout-gate-${Date.now()}@example.com`;
  await seedActiveProject(email);

  await signIn(page, email, PASSWORD);

  // The shell RENDERED — everything below is a meaningful absence, not a blank
  // page passing by default.
  await expect(page.getByRole('heading', { name: 'Dashboards', level: 1 })).toBeVisible();

  // No orb: no trigger to click, so no orphan control and no way to reach an
  // empty menu. Addressed by the callout's own accessible name (MOTIR-1812).
  await expect(page.getByRole('button', { name: 'Motir AI' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Motir AI' })).toHaveCount(0);

  // The same `showPlanWithAi` gate holds back the TopNav hero pill, so the page
  // carries NO "Plan with AI" affordance at all — neither door is half-shipped.
  // The regex catches BOTH namings: the pill's exact `aria-label` and the menu
  // row's longer contents-derived name.
  await expect(page.getByRole('link', { name: /Plan with AI/ })).toHaveCount(0);
});
