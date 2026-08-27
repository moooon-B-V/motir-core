import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, adminDb, db } from './_helpers/db-reset';
import { addVirtualAuthenticator } from './_helpers/webauthn';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { WORKSPACE_COOKIE_NAME } from '@/lib/workspaces';
import type { Page } from '@playwright/test';
import { createTestPerson } from './_helpers/testPerson';

// ACCEPTANCE — an admin requires a second factor, and nobody loses their place
// (Story 8.13 · MOTIR-1215 · Subtask MOTIR-3651). The story's own
// `verification_recipe`, driven the way a person drives it, and recorded as the
// receipt Yue watches to accept the story.
//
// ⚠️ THIS IS THE RECEIPT LANE, NOT THE MERGE GATE. The regression spec is
// `two-factor-enforcement.spec.ts` (MOTIR-3650) on the main lane, running on
// every pull request at machine speed; this file runs under
// `playwright.acceptance.config.ts` with `video: 'on'`. The FILENAME is what
// routes it: `acceptance*` is this lane's `testMatch` and the main config's
// `testIgnore`, so renaming this file would put the receipt in the merge gate and
// the gate in the receipt lane. Neither file edits the other, and no correctness
// assertion is duplicated here — MOTIR-3650 carries them all.
//
// The recording, the pacing and the publish are `acceptance-passkeys.spec.ts`'s
// (Story 8.12 · MOTIR-3616), imported rather than re-derived: `chapter()` from
// `./_helpers/acceptance-video`, `acceptanceStory()` for the sidecar the uploader
// reads, and MOTIR-3615's virtual authenticator for the enrolment.
//
// ── WHAT THE CLIP HAS TO SHOW, AND WHY THE PACING IS LOAD-BEARING ─────────
// This story's whole argument is that a security policy can be switched on
// without taking anything away from the people it applies to. That claim is made
// of moments, not of states, and three of them exist nowhere but on screen:
//
//   · a person who clicked a WORK-ITEM link is stopped, and the screen names the
//     organization asking — not a generic "access denied";
//   · they set a factor up in about a minute and go STRAIGHT BACK to the work
//     item they were opening, having never been signed out;
//   · a workspace admin who opens their own switch finds it LOCKED, with the
//     reason and the responsible organization printed beside it.
//
// Every hold below sits AFTER the assertion that already proved the state — see
// `_helpers/acceptance-video.ts`'s pacing section. Delete every hold and the
// assertions are unchanged; a hold can never stand in for a wait. Driven at
// machine speed the whole walk finishes in seconds with every chapter stacked
// inside the first: a technically-passing file that shows a reviewer nothing.
//
// ── THE ORIGIN CHECK HOLDS HERE TOO ───────────────────────────────────────
// `playwright.acceptance.config.ts` sets `MOTIR_BASE_URL: BASE_URL` on its
// webServer, so `lib/baseUrl.ts` resolves THIS lane's port and the passkey
// plugin's `rpID` / `origin` follow it.

test.describe.configure({ timeout: 240_000 });

const PASSWORD = 'acceptance-2fa-enforcement-pass-123';
const OWNER = 'acceptance-2fa-owner@example.com';
const MEMBER = 'acceptance-2fa-member@example.com';
const SWITCH = 'Require two-factor authentication';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Both steps of the credentials form are a button labelled "Continue". */
async function signIn(page: Page, email: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
}

async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/sign-up');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Create a password').fill(PASSWORD);
  await page.getByRole('button', { name: /^(Create account|Creating account…)$/ }).click();
  await page.waitForURL('**/home');
}

/** A real passkey, through the shipped pane. */
async function enrolPasskey(page: Page): Promise<void> {
  const verified = page.waitForResponse(
    (r) =>
      r.url().includes('/api/auth/passkey/verify-registration') && r.request().method() === 'POST',
  );
  await page.goto('/settings/account/security');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  expect((await verified).status()).toBe(200);
}

test('an organization requires a second factor, and nobody loses their place', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // ⚠️ WITHOUT THIS THE CLIP HAS NOWHERE TO GO. The uploader reads the
  // `acceptance-story.json` sidecar this writes as its top-precedence target;
  // the story key in the header above is prose, and the uploader reads the
  // fixture, not the prose.
  acceptanceStory('MOTIR-1215');

  const authenticator = await addVirtualAuthenticator(page.context(), page);

  try {
    // ── Off camera ──────────────────────────────────────────────────────
    // An ordinary account, created the ordinary way, with a work item to be
    // interrupted on the way to and a teammate to be interrupted.
    //
    // ⚠️ THE ADMIN SETS UP THEIR OWN FACTOR FIRST, and that is the product
    // rather than a fixture convenience: turning the policy on holds every
    // member of the tier at their next request, the admin who clicked included.
    await signUp(page, OWNER);
    const owner = await adminDb.user.findFirstOrThrow({ where: { email: OWNER } });
    const membership = await adminDb.workspaceMembership.findFirstOrThrow({
      where: { userId: owner.id },
      include: { workspace: true },
    });
    const workspace = membership.workspace;
    // ⚠️ THE ORGANIZATION GETS A HUMAN NAME, and that is a decision about the
    // RECEIPT rather than a fixture nicety. Sign-up auto-provisions an org named
    // after the account — "acceptance-2fa-owner's Workspace" — and this story's
    // two load-bearing frames are the two that print the tier's NAME. A reviewer
    // reading "Required by acceptance-2fa-owner's Workspace" is reading the test
    // harness; reading "Required by Northwind" is reading the product.
    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { name: 'Northwind' },
    });
    const org = await adminDb.organization.findFirstOrThrow({
      where: { id: workspace.organizationId },
    });

    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Enforcement',
      identifier: 'ENF',
    });
    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'Ship the pricing page' },
      { userId: owner.id, workspaceId: workspace.id },
    );

    const member = await createTestPerson({
      email: MEMBER,
      password: PASSWORD,
      name: 'Grace Hopper',
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: org.id, userId: member.id, role: ORGANIZATION_ROLE.member },
    });
    await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });

    await enrolPasskey(page);

    // ── 1 ───────────────────────────────────────────────────────────────
    await chapter('Where the setting lives', async () => {
      // The door, taken the way an admin takes it. The organization menu is the
      // permanent top-left anchor, and Security is a row in it — a reviewer
      // needs to see that it is findable, not just that it exists.
      await page.goto('/home');
      await page.getByRole('button', { name: 'Organization menu' }).click();
      const orgMenu = page.getByRole('list').filter({
        has: page.locator('a[href="/settings/organization/members"]'),
      });
      const security = orgMenu.locator('a[href="/settings/organization/security"]');
      await expect(security).toBeVisible();
      await beat();

      await security.click();
      await page.waitForURL('**/settings/organization/security');
      await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();
      await expect(
        page.getByText(`Sign-in requirements for everyone in ${org.name}.`),
      ).toBeVisible();
    });

    // ── 2 ───────────────────────────────────────────────────────────────
    await chapter('Requiring a second factor', async () => {
      // ⚠️ THE SENTENCE BESIDE THE SWITCH IS THE FEATURE. It is what tells an
      // admin that switching this on costs their team a minute and not their
      // afternoon — nobody signed out, nobody removed, any method counts. A
      // reviewer has to be able to READ it, which is what this hold buys.
      await expect(page.getByText(/Nobody is signed out and nobody is removed/)).toBeVisible();
      await expect(page.getByText('Not required')).toBeVisible();
      await beat();

      await page.getByRole('switch', { name: SWITCH }).click();
      await expect(page.getByText('Security policy saved', { exact: true })).toBeVisible();
      // The state label changes with it, and it names who it now applies to.
      await expect(page.getByText(`Required for every member of ${org.name}`)).toBeVisible();
      await beat();
    });

    // ── 3 ───────────────────────────────────────────────────────────────
    await chapter('A teammate is stopped on the way to their work', async () => {
      // Not the dashboard — a WORK-ITEM link, the way somebody actually arrives.
      // Everything after this beat is about not losing it.
      await signIn(page, MEMBER);
      await page.goto(`/items/${item.identifier}`);
      await page.waitForURL('**/two-factor-required**');

      // ⚠️ THE ORGANIZATION IS NAMED. This is the frame that has to be legible:
      // a person stopped mid-task is owed the name of whoever is asking, and
      // "access denied" would not be that.
      await expect(page.getByText(`Required by ${org.name}`)).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Set up a second factor to continue' }),
      ).toBeVisible();
      await expect(page.getByText(/It takes about a minute/)).toBeVisible();
      await beat();

      // And the way out is there — this screen is not a trap.
      await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
      await beat();
    });

    // ── 4 ───────────────────────────────────────────────────────────────
    await chapter('They set one up, right there', async () => {
      // A REAL ceremony — a fake device, never a fake server. The whole claim of
      // the story is that satisfying the requirement lifts the block, and an
      // intercepted call would record the interception.
      const verified = page.waitForResponse(
        (r) =>
          r.url().includes('/api/auth/passkey/verify-registration') &&
          r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Add a passkey' }).click();
      expect((await verified).status()).toBe(200);

      await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
      await expect(page.getByText('Two-factor authentication is on')).toBeVisible();
      await beat();
    });

    // ── 5 ───────────────────────────────────────────────────────────────
    await chapter('And go straight back to where they were going', async () => {
      // ⚠️ THE BEAT THAT SHOWS NOTHING WAS LOST. Being returned to the work item
      // you clicked, rather than dumped on a home page, is invisible in every
      // test written one screen at a time — and it is the difference between a
      // policy that costs a minute and one that costs your place.
      const onward = page.getByRole('link', {
        name: new RegExp(`Continue to /items/${item.identifier}`),
      });
      await expect(onward).toBeVisible();
      await beat();

      await onward.click();
      await page.waitForURL(`**/items/${item.identifier}`);
      await expect(page.getByRole('heading', { name: 'Ship the pricing page' })).toBeVisible();
      await beat();
    });

    // ── 6 ───────────────────────────────────────────────────────────────
    await chapter('The same switch, where most teams will find it', async () => {
      // ⚠️ THE SHAPE MOST CUSTOMERS HAVE. Below two workspaces Motir hides the
      // workspace tier entirely and folds its settings onto the organization
      // page, so for most orgs the workspace-level switch lives HERE. A receipt
      // that only showed the standalone pane would show a screen most reviewers
      // will never see.
      await signIn(page, OWNER);
      await page.goto('/settings/organization');
      const foldIn = page.getByRole('switch', { name: SWITCH }).first();
      // ⚠️ SCROLLED INTO VIEW BEFORE THE HOLD. `toBeVisible()` scrolls to make
      // its own assertion, so the ASSERTION passes either way — but the frame a
      // viewer sees is whatever was on screen when the hold started, and the
      // fold-in sits well below the fold on this page. Without this the receipt
      // holds for four seconds on the top of Organization settings and never
      // shows the control the chapter is named after.
      await foldIn.scrollIntoViewIfNeeded();
      await expect(foldIn).toBeVisible();
      await expect(
        page.getByText(/Additionally require a second factor for everyone in this workspace/),
      ).toBeVisible();
      await beat();
    });

    // ── 7 ───────────────────────────────────────────────────────────────
    await chapter('A workspace cannot lower the organization’s floor', async () => {
      // A second workspace, off camera — that is what reveals the workspace tier
      // and gives it a Security pane of its own.
      // ⚠️ AN ORG ON A PLAN, OFF CAMERA — a fact about the LANE, not about this
      // story. This lane runs CLOUD-ON (`playwright.acceptance.config.ts`'s
      // header), where the free tier's `maxWorkspaces` is 1 — so a second
      // workspace is refused with `EntitlementExceededError` before the tier
      // this chapter is about can exist at all. `aiIncludedSeat` is the column
      // `pmTierForOrg` reads to mean "a paid Motir AI plan bundles a seat, caps
      // lifted" (ADR §4), which is the state any customer with two workspaces is
      // in. It changes nothing the viewer sees.
      await adminDb.organization.update({
        where: { id: org.id },
        data: { aiIncludedSeat: true },
      });
      const { workspace: second } = await workspacesService.createWorkspace({
        name: 'Platform',
        ownerUserId: owner.id,
        organizationId: org.id,
      });
      // ⚠️ `path: '/'` SPELLED OUT — Playwright derives a cookie's path from the
      // `url` form's directory, which would scope this to the current folder and
      // silently leave the OTHER workspace active.
      await page
        .context()
        .addCookies([
          { name: WORKSPACE_COOKIE_NAME, value: second.id, domain: 'localhost', path: '/' },
        ]);

      await page.goto('/settings/workspace/security');
      await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();

      // ⚠️ WAIT FOR THE PREVIOUS PAGE TO BE GONE, not merely for this one to
      // arrive. React keeps the OUTGOING subtree mounted (hidden) while the new
      // one streams, so for a moment BOTH are in the DOM — and the chapter
      // before this one was `/settings/organization`, whose fold-in renders the
      // very same "Required by {org}" chip. A text query sees both copies and
      // strict mode refuses; `getByRole` would not, because the accessibility
      // tree excludes the hidden one, which is why the switch assertion below
      // never noticed. Observed once on CI, green on the run before it.
      //
      // The wait has to be TEXT-based for the same reason: a role query resolves
      // against the a11y tree and would report the old page gone while its DOM
      // is still there. `CLAUDE.md` records the class under the loading-boundary
      // rule.
      await expect(page.getByText('Organization settings')).toHaveCount(0);

      // ⚠️ THE OTHER FRAME THAT HAS TO BE LEGIBLE. The organization requires it,
      // so this workspace's own switch is LOCKED — and it says so, and it says
      // WHO. An admin denied a control is owed the name of whoever holds it, and
      // a hidden control would have told them nothing at all.
      const locked = page.getByRole('switch', { name: SWITCH });
      await expect(locked).toBeDisabled();
      await expect(page.getByText(`Required by ${org.name}`)).toBeVisible();
      await expect(
        page.getByText(new RegExp(`${org.name} requires two-factor authentication`)),
      ).toBeVisible();
      await beat();
    });
  } finally {
    await authenticator.remove();
  }
});
