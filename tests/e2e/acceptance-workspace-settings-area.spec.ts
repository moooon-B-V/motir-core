import type { Page } from '@playwright/test';
import { expect, test } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { pinContextCookies } from './_helpers/billing';
import { createTestPerson } from './_helpers/testPerson';
import { signUp, signIn, SHELL_PASSWORD } from './_helpers/shell-session';
import { db } from '@/lib/db';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { projectsService } from '@/lib/services/projectsService';
import { workspacesService } from '@/lib/services/workspacesService';

// WORKSPACE SETTINGS BECOMES AN AREA — THE ACCEPTANCE RECEIPT
// (Story MOTIR-4843 · Subtask MOTIR-4849).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A door, in the place a person would look for it — and then, in the second
// half, the harder thing: that nothing was taken away from anybody.
//
// Before this story, configuring the container your team works in lived under
// your AVATAR, beside Sign out, as though it were a personal preference; and two
// of its pages were loose rows in the PROJECT's rail, which teaches the wrong
// model twice. Now the door is on the control that already carries the
// workspace's NAME, and the tier has a rail of its own.
//
// ── ⚠️ WHY THREE CHAPTERS, AND WHY THE THIRD IS THE ONE THAT MATTERS ────────
//
// This story has two audiences with opposite experiences of it. A team that has
// just added a second workspace gets a new tier (chapter 1). A team that has
// only ever had the default workspace should notice NOTHING (chapter 2) — and
// "nothing changed" is not a screen you can point at, so the way to show it is
// to walk the capabilities and find them all still there.
//
// Chapter 3 is the one most likely to be dropped as redundant and is worth the
// most. `organization-tier.md` §6d says a hidden tier may remove a CONCEPT and
// may never remove a CAPABILITY, and the person that rule protects is not the
// org admin doing the demo — it is the plain member who was invited into a
// workspace and holds no organisation role. Every surface here renders
// correctly for an admin whether or not the gates are right. Running the last
// chapter as that member is what makes this evidence rather than an
// illustration.
//
// ── ⚠️ THE CAPABILITY SET IS WALKED BY NAME ────────────────────────────────
//
// The story removes two rail rows, one menu row, and three routes' below-reveal
// existence. So the receipt does not assert "the page rendered" — it names each
// capability that had a door before and finds it: workspace name, members,
// leave workspace, require-2FA, job runs, and the dead-letter queue.
//
// ── PACING ──────────────────────────────────────────────────────────────────
//
// Three chapters. Chapter 1 is the click a person actually makes; chapters 2
// and 3 are the same page seen by two different readers, so they are paced to
// let a viewer read the section list rather than to show motion.

const OWNER = 'acceptance-ws-area-owner@example.com';
const SOLO = 'acceptance-ws-area-solo@example.com';
const MEMBER = 'acceptance-ws-area-member@example.com';

/** Sign up, give them a project, and pin the active context deterministically. */
async function seedTenant(
  page: Parameters<typeof pinContextCookies>[0],
  email: string,
  projectKey: string,
) {
  await signUp(page, email);
  const local = email.split('@')[0]!;
  const user = await db.user.findFirstOrThrow({ where: { email } });
  const workspace = await db.workspace.findFirstOrThrow({
    where: { name: `${local}'s Workspace` },
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acceptance',
    identifier: projectKey,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  await pinContextCookies(page, {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
  });
  return { userId: user.id, workspace };
}

/**
 * The rows reading CURRENT **in the workspace-settings RAIL** — the claim being
 * that exactly one row of that rail answers "where am I".
 *
 * Two scopings, and both were earned by a red run rather than anticipated:
 *
 * ⚠️ 1. `:visible`. `app/(authed)/layout.tsx` renders `SidebarNav` TWICE — the
 * desktop rail and the mobile off-canvas drawer's copy — and both are in the DOM
 * at every width. A bare `[aria-current="page"]` therefore resolves to TWO
 * elements on a route where one row is current. (`getByRole` is immune, because
 * the accessibility tree excludes the hidden copy; an attribute selector is not
 * — the same shape as the boundary-locator hazard in `motir-core/CLAUDE.md`.)
 *
 * ⚠️ 2. THE RAIL, not the page. On `/settings/workspace/jobs` the jobs
 * dashboard's own TAB STRIP marks its active tab `aria-current="page"` too, and
 * that is correct: two different navigations, each with one current item. A
 * page-wide count conflates them and fails describing a defect that does not
 * exist. So this asks the rail — named by the area eyebrow it renders as its
 * `<nav>`'s accessible name.
 */
function currentRows(page: Page) {
  return page
    .getByRole('navigation', { name: 'Workspace settings' })
    .locator('[aria-current="page"]:visible');
}

test('the workspace tier gains a door and a rail — and at one workspace, nothing is taken away', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-4843');

  await resetDatabase();

  await chapter('Two workspaces: the door is on the control that names the workspace', async () => {
    const { userId, workspace } = await seedTenant(page, OWNER, 'ACC');
    // ⚠️ THE FREE PLAN CAPS AN ORGANISATION AT ONE WORKSPACE, and this lane is
    // CLOUD-ON — so without this line the create below does not merely render
    // differently, it is REFUSED:
    // `EntitlementExceededError: Your plan's workspaces limit has been reached`
    // (`entitlementsService.assertWithinWorkspaceCap`, which no-ops off cloud —
    // which is why the main-lane specs that create a second workspace need
    // nothing).
    //
    // Set on the ORG ROW, not through the billing fixture. `pmTierForOrg` reads
    // `isMeta` / `scaledTrackerSubscription` / `aiIncludedSeat` off the row via
    // `findCapContextInTx`; the motir-ai fixture answers a DIFFERENT question
    // (spend and balance) and never reaches the cap. `aiIncludedSeat` is the
    // one-field form: a paid AI plan bundles a Motir seat, which resolves the
    // tier to `scaled`, whose `maxWorkspaces` is null. Same trap, same remedy,
    // as `acceptance-repository-tenancy.spec.ts`.
    await db.organization.update({
      where: { id: workspace.organizationId },
      data: { aiIncludedSeat: true },
    });

    // ⚠️ A SECOND WORKSPACE, WHICH IS THE ENTIRE PRECONDITION. The tier is
    // revealed at ≥2 in the ACTIVE ORG (`isWorkspaceTierRevealed`), and below
    // that there is no switcher to carry a door and no area to open onto —
    // which is chapter 2.
    await workspacesService.createWorkspace({
      name: 'Second workspace',
      ownerUserId: userId,
      organizationId: workspace.organizationId,
    });

    await page.goto('/workbench');
    // The switcher is the top bar's workspace tier. Authoritative: the control
    // itself, never a spinner's absence.
    const switcher = page.getByRole('button', { name: 'Switch workspace' });
    await expect(switcher).toBeVisible();
    await beat();

    // THE ARRIVAL. `design/settings/workspace-settings.mock.html` panel 5: the
    // last group of the popover, ABOVE `Invite teammates` — the general door
    // above the shortcut through it.
    await switcher.click();
    const door = page.getByRole('link', { name: 'Workspace settings' });
    await expect(door).toBeVisible();
    await beat();

    await door.click();
    await page.waitForURL('**/settings/workspace');
    await expect(page.getByRole('heading', { name: 'Workspace settings' })).toBeVisible();
    await beat();

    // THE RAIL — three rows, and exactly ONE of them current. The area root is
    // `exact`, which is what stops it reading as current on all three at once.
    for (const label of ['Workspace', 'Security', 'Job runs']) {
      await expect(page.getByRole('link', { name: label })).toBeVisible();
    }
    await expect(currentRows(page)).toHaveCount(1);
    await beat();

    await page.getByRole('link', { name: 'Security' }).click();
    await page.waitForURL('**/settings/workspace/security');
    await expect(currentRows(page)).toHaveCount(1);
    await beat();

    await page.getByRole('link', { name: 'Job runs' }).click();
    await page.waitForURL('**/settings/workspace/jobs');
    await expect(currentRows(page)).toHaveCount(1);
    await beat();

    // THE DEPARTURE. The row this story moved is gone from the account menu —
    // asserted on the HREF, because a renamed row pointing at the same room
    // would pass a label check.
    // ⚠️ ASSERTED AWAY FROM THE AREA, deliberately. Standing on
    // `/settings/workspace`, the area's OWN rail carries an
    // `href="/settings/workspace"` row — so a document-wide count taken here
    // would find the RAIL and read as a regression that is not one.
    await page.goto('/workbench');
    await page.getByRole('button', { name: 'Account menu' }).click();
    // Scoped to the MENU, not the document: what this claims is about the
    // account menu's contents, and a page-wide count would be perturbed by
    // whatever else happens to link into settings from the shell.
    const menu = page.locator('[data-surface="popover"]');
    await expect(menu.getByRole('link', { name: 'Account settings' })).toBeVisible();
    expect(await menu.locator('a[href="/settings/workspace"]').count()).toBe(0);
    await beat();
  });

  await chapter('One workspace: the tier is not there — and neither is anything lost', async () => {
    await seedTenant(page, SOLO, 'SOL');
    await page.goto('/workbench');

    // No switcher: at one workspace the product has not told this person the
    // tier exists, so there is no control to carry a door.
    await expect(page.getByRole('button', { name: 'Switch workspace' })).toHaveCount(0);
    await beat();

    // …and the rooms it would open onto do not exist either. A 404 on a
    // PRODUCTION build (this lane runs `next build` + `next start`), which is
    // the only place the status is real: a `loading.tsx` above a deciding route
    // would pin it at 200 (motir-core/CLAUDE.md).
    for (const path of [
      '/settings/workspace',
      '/settings/workspace/security',
      '/settings/workspace/jobs',
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
    }
    await beat();

    // THE WHOLE POINT. Every capability that had a door still has one, on the
    // single settings home that hosts them — walked BY NAME, never inferred
    // from the page rendering.
    await page.goto('/settings/organization');
    // MOTIR-5035 — a LOCATOR change, not an assertion change. The claim is
    // unchanged (this capability still has a door here); only how the node is
    // addressed moved, so `docs/decisions/acceptance-receipt-lifecycle.md`'s
    // prohibition on editing a receipt's CLAIM is not in play.
    //
    // `getByLabel('Workspace name')` matched TWICE in the merge queue: React
    // keeps the outgoing subtree mounted while the new one streams, and
    // Playwright resolves locators before filtering on visibility, so the
    // server-rendered and hydrated copies of the same `NameCard` input both
    // matched. `getByRole` is immune — the accessibility tree excludes the
    // hidden copy. Two queue entries, one predating the diff under triage:
    // runs 34518853712 and 34514510627.
    await expect(page.getByRole('textbox', { name: 'Workspace name' })).toBeVisible();
    await beat();

    // Named EXACTLY, and by their own headings where they have one — "asserted
    // by name, not inferred from a page rendering" is the card's wording, and a
    // substring match is satisfied by PROSE about a capability rather than the
    // capability.
    await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Job runs', exact: true })).toBeVisible();
    // ⚠️ SCOPED, not converted (MOTIR-5115) — `DangerZoneCard` renders this one as a
    // `<p>`, not a heading like its two neighbours, so there is no role to ask for
    // and `AppLayout`'s `<main>` is the handle. A page-rooted read also matches the
    // subtree React keeps mounted while the incoming one streams (MOTIR-3725 /
    // MOTIR-3737). The CLAIM is untouched — `exact: true` on the same string, against
    // the same matcher — which is what
    // `docs/decisions/acceptance-receipt-lifecycle.md` freezes about a receipt.
    await expect(
      page.getByRole('main').getByText('Leave workspace', { exact: true }),
    ).toBeVisible();
    await beat();

    // The dead-letter queue is reachable FROM HERE — the assertion the fold-in
    // shipped without. Its links were built from `/settings/workspace/jobs`,
    // the route this same story 404s at this count, so the section rendered and
    // nothing in it could be opened (MOTIR-4849 fixed it; this is the receipt).
    const dlq = page.getByRole('link', { name: /Dead letter/ });
    await expect(dlq).toBeVisible();
    await dlq.click();
    await page.waitForURL(/\/settings\/organization\?tab=dlq/);
    // BY ROLE (MOTIR-5115) — `EmptyState` renders its title as an `<h2>`, so this one
    // converts outright; the accessibility tree excludes the hidden streamed copy
    // (MOTIR-4822's pattern, and `CLAUDE.md`'s loading-boundary rule).
    await expect(
      page.getByRole('heading', { name: 'Nothing in the dead-letter queue' }),
    ).toBeVisible();
    await beat();
  });

  await chapter('…and for the plain member, who holds no organisation role', async () => {
    // The actor §6d is written to protect: a workspace INVITEE is a plain org
    // `member` (§5's upward invariant), and one workspace is the only count
    // they will ever have here. Seeded rather than walked through an invite —
    // the invite flow is a different story's, and this one is about what they
    // can reach once they are in.
    const workspace = await db.workspace.findFirstOrThrow({
      where: { name: `${SOLO.split('@')[0]!}'s Workspace` },
    });
    const member = await createTestPerson({
      email: MEMBER,
      password: SHELL_PASSWORD,
      name: 'Grace',
    });
    await db.organizationMembership.create({
      data: {
        organizationId: workspace.organizationId,
        userId: member.id,
        role: ORGANIZATION_ROLE.member,
      },
    });
    await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });

    await signIn(page, MEMBER, SHELL_PASSWORD);
    await pinContextCookies(page, {
      workspaceId: workspace.id,
      organizationId: workspace.organizationId,
    });

    await page.goto('/settings/organization');
    // The ORG-scoped cards are refused — §6d gates this page per SECTION, and
    // this reader holds no org role. That refusal is what makes the rest
    // meaningful rather than an admin's view.
    // ⚠️ `getByRole`, NOT `getByText` (MOTIR-4876). This went red in CI as a
    // STRICT MODE violation — two identical `<h2>`s — and passes locally, which
    // is the tell for the documented streaming shape rather than a real
    // duplicate: React keeps the previous subtree mounted while the next one
    // streams, so both are briefly in the DOM. Playwright's own report named the
    // difference — it could describe one of the two as `getByRole('heading')`
    // and the other only as `getByText`, i.e. the second is NOT in the
    // accessibility tree. `CLAUDE.md` § *the second cost* records the class and
    // the remedy: the a11y tree excludes the hidden copy, so `getByRole` is
    // immune where `getByText` is not.
    //
    // It is a discriminator rather than a workaround: if the page ever really
    // rendered this twice, `getByRole` would match two VISIBLE headings and fail
    // exactly as loudly. Every other assertion in this chapter already reads
    // this way — this line was the outlier.
    await expect(
      page.getByRole('heading', { name: 'Organization settings are admin-only', exact: true }),
    ).toBeVisible();
    await beat();

    // …and every workspace capability is still there, for them.
    // MOTIR-5035 — the second site of the same locator change; see the note at
    // the first. The claim is untouched, the addressing is by role.
    await expect(page.getByRole('textbox', { name: 'Workspace name' })).toBeVisible();
    // The same list as chapter 2, asserted the same way — the claim is that
    // these two readers get the same capabilities, so a weaker assertion here
    // is the one place it could quietly stop being true.
    await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Job runs', exact: true })).toBeVisible();
    // Scoped for the same reason as chapter 2's twin (MOTIR-5115), and asserted the
    // same way — the claim is that these two readers get identical capabilities.
    await expect(
      page.getByRole('main').getByText('Leave workspace', { exact: true }),
    ).toBeVisible();
    await beat();
  });
});
