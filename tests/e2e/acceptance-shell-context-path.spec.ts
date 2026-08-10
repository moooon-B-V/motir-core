import { expect } from '@playwright/test';
import { test } from './_helpers/acceptance-video';
import { db, resetDatabase } from './_helpers/db-reset';
import { signUp, createFirstProject, createWorkspace } from './_helpers/shell-session';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';

// Story MOTIR-2554 — the shell's context path (Subtask MOTIR-2559).
//
// THE ACCEPTANCE RECEIPT. What this story ships is a SENTENCE — `org ›
// workspace › project` — and whether it reads is the only question that
// matters about it. That is not something a screenshot settles: the path is
// worth having because it CHANGES as you move, so the receipt has to show it
// moving. Switch project and watch the last crumb follow you; add a workspace
// and watch a middle crumb appear; narrow the window and watch the ancestors
// step aside for the one tier you actually need on a phone.
//
// It is also the receipt for an ABSENCE, and an absence is the thing a
// changelog line cannot convey: the left rail no longer answers "which project
// am I in", because the bar does. The rail chapter is deliberately shot right
// after the bar chapter, so the two are legible against each other.
//
// Nothing is stubbed. A real sign-up, real projects, the real switcher, the
// real drawer.
//
// The functional assertions — every band, both absences, the 320px overflow —
// are `shell-context-path.spec.ts`. This file is the thing a person watches,
// and it deliberately walks the WIDE path only: a receipt that tried to be a
// test would be neither.

test.describe.configure({ timeout: 240_000 });

/**
 * Put the signed-up account on a PAID tier — a property of this LANE, not a
 * shortcut around the product.
 *
 * The receipt's third chapter needs a SECOND workspace, because that is what
 * makes the middle crumb appear. This lane runs cloud-on
 * (playwright.acceptance.config.ts sets MOTIR_CLOUD=true), so §4's entitlement
 * gates are live — and `free` caps an org at ONE workspace
 * (`PM_ENTITLEMENTS.free.maxWorkspaces = 1`), so `assertWithinWorkspaceCap`
 * refuses the create and the dialog just stays open. (Observed: the chapter
 * failed here with EntitlementExceededError while the same journey passed in
 * the cloud-OFF functional lane.) A multi-workspace Motir account on cloud IS a
 * paid account, so the fixture models one instead of working around the gate.
 *
 * `aiIncludedSeat` is the shipped lever for exactly that — `pmTierForOrg` reads
 * it as "a paid Motir AI plan bundles a Motir seat → caps lifted" (ADR §4,
 * amended 8.1.22), the same `scaled` outcome a purchased scaled-tracker
 * subscription gives. Set on the ROW, because that is where the shipped code
 * reads it from. Same precedent, same lane: `_helpers/cli-connect-seed.ts`.
 */
async function markAccountPaid(email: string): Promise<void> {
  const user = await db.user.findFirstOrThrow({ where: { email } });
  const membership = await db.organizationMembership.findFirstOrThrow({
    where: { userId: user.id, role: ORGANIZATION_ROLE.owner },
  });
  await db.organization.update({
    where: { id: membership.organizationId },
    data: { aiIncludedSeat: true },
  });
}

test('a person reads where they are from one row, and it follows them', async ({
  page,
  chapter,
  beat,
}) => {
  await resetDatabase();
  // 1440, not 1280: `xl` is 1280 and a classic scrollbar shortens the layout
  // viewport a media query reads, so the breakpoint's first pixel is a coin
  // flip in CI. The receipt should show the full path, not straddle it.
  await page.setViewportSize({ width: 1440, height: 812 });

  const bar = page.locator('header nav[aria-label]');
  const project = bar.getByRole('button', { name: 'Switch project' });
  const workspace = bar.getByRole('button', { name: 'Switch workspace' });

  await chapter('Where am I? The bar says: the organization, then the project', async () => {
    const email = `acceptance-context-path-${Date.now()}@example.com`;
    await signUp(page, email);
    await markAccountPaid(email);
    await createFirstProject(page, 'Mobile App');

    await expect(bar.getByRole('button', { name: 'Organization menu' })).toBeVisible();
    await expect(project).toContainText('Mobile App');
    await beat();
    // one workspace, so the middle tier is implicit — the path is not padded
    // with a name that would tell you nothing
    await expect(workspace).toHaveCount(0);
    await beat();
  });

  await chapter('The project is a control, not a label — switching moves the path', async () => {
    await project.click();
    await beat();
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByLabel('Project name').fill('Marketing Site');
    await page.getByRole('button', { name: 'Create project', exact: true }).last().click();
    await expect(page.getByText('Project created', { exact: true }).first()).toBeVisible();
    await expect(project).toContainText('Marketing Site');
    await beat();

    await project.click();
    await page.getByRole('button', { name: 'Mobile App' }).click();
    await page.waitForURL('**/items**');
    await expect(project).toContainText('Mobile App');
    await beat();
  });

  await chapter('A second workspace, and the middle crumb appears', async () => {
    await createWorkspace(page, 'Engineering');
    await page.goto('/dashboard');
    await createFirstProject(page, 'Platform');

    await expect(workspace).toContainText('Engineering');
    await expect(project).toContainText('Platform');
    await beat();
  });

  await chapter(
    'The rail is only navigation now — it stopped answering "which project"',
    async () => {
      const rail = page.getByRole('navigation', { name: 'Primary' });
      await expect(rail.getByRole('button', { name: 'Switch project' })).toHaveCount(0);
      await expect(rail.getByRole('link', { name: 'Work Items' })).toBeVisible();
      await beat();
    },
  );

  await chapter(
    'On a phone the bar keeps the tier you need, and the rest is one tap away',
    async () => {
      await page.setViewportSize({ width: 375, height: 812 });
      await expect(project).toContainText('Platform');
      await expect(bar.getByRole('button', { name: 'Organization menu' })).toBeHidden();
      await beat();

      await page.getByRole('button', { name: 'Open navigation' }).click();
      const drawer = page.getByRole('dialog');
      await expect(drawer.getByRole('button', { name: 'Switch workspace' })).toContainText(
        'Engineering',
      );
      await beat();
    },
  );
});
