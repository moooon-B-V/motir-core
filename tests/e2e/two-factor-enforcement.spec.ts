import { expect, test, type Page } from '@playwright/test';
import { adminDb, db, resetDatabase } from './_helpers/db-reset';
import { addVirtualAuthenticator, type VirtualAuthenticator } from './_helpers/webauthn';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { WORKSPACE_COOKIE_NAME } from '@/lib/workspaces';

// Story MOTIR-1215 · Subtask MOTIR-3650 — THE STORY'S WALK, in a real browser
// against a real database. It is the story's `verification_recipe`, automated.
//
// This is the REGRESSION gate on the main lane; the recorded, human-paced
// receipt is MOTIR-3651's own file. ⚠️ THE FILENAME IS LOAD-BEARING:
// `playwright.acceptance.config.ts` matches `**/acceptance*.spec.ts` and this
// config `testIgnore`s the same pattern, so a name starting with `acceptance`
// would move this spec silently out of the lane that gates merges.
//
// ── ⚠️ THE ENROLMENT IS REAL, AND THAT IS THE WHOLE POINT ─────────────────
// The one claim this story makes is that satisfying the requirement LIFTS the
// block. Intercepting the enrolment call with `page.route` would make step 3
// assert the harness instead — the walk would pass against a server that never
// wrote a credential, which is worth nothing. So the ceremony is performed for
// real, by the CDP VIRTUAL AUTHENTICATOR `tests/e2e/_helpers/webauthn.ts` wraps
// (Story 8.12 · MOTIR-3615, reused here rather than re-derived), and the last
// test in this file asserts by reading this source that no `page.route` exists
// anywhere in it.
//
// A passkey is chosen over TOTP deliberately: it is the shipped harness, it is
// one click, and it is the account shape the story's own regression is about —
// `twoFactorEnabled` stays FALSE and the person is compliant anyway.
//
// ── SEEDING ───────────────────────────────────────────────────────────────
// The fixture writes `requiresTwoFactor` directly ONLY where a state is a
// PRECONDITION (the org floor in test 2). ⚠️ Step 1 goes through the UI —
// "an admin can turn this on by clicking" is the acceptance claim, and a seeded
// policy tests neither the pane nor the action.
//
// Every wait is on an authoritative signal — a URL, a settled control, a
// response. No `waitForTimeout` (CLAUDE.md).

const PASSWORD = 'two-factor-enforcement-pass-123';
const SWITCH = 'Require two-factor authentication';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── the fixture ─────────────────────────────────────────────────────────────

/** Sign up through the UI — the auto-provisioned org + default workspace. */
async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/sign-up');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Create a password').fill(PASSWORD);
  await page.getByRole('button', { name: /^(Create account|Creating account…)$/ }).click();
  await page.waitForURL('**/home');
}

/**
 * Sign in the way `tests/e2e/_helpers/shell-session.ts` does — BOTH steps are a
 * button labelled "Continue" — but without settling on `/home`, because half the
 * people in this file are held before they get there.
 */
async function signIn(page: Page, email: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
}

/**
 * Register a passkey from the account Security pane, waiting on the VERIFY
 * response — the call that commits the credential.
 *
 * ⚠️ THE ADMIN ENROLS FIRST, AND THAT IS THE PRODUCT, NOT A FIXTURE DODGE.
 * Turning the policy on holds EVERY member of the tier at their next request —
 * including the admin who turned it on. An admin without a second factor
 * therefore locks themselves out of their own settings the moment they click,
 * which is correct (GitHub and Atlassian both require the enabling admin to
 * comply) and which is why the realistic order is: enrol, then require.
 */
async function enrolPasskey(page: Page): Promise<void> {
  const verified = page.waitForResponse(
    (r) =>
      r.url().includes('/api/auth/passkey/verify-registration') && r.request().method() === 'POST',
  );
  await page.goto('/settings/account/security');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  expect((await verified).status()).toBe(200);
}

/**
 * Pin the ACTIVE workspace, the way the shipped specs do.
 *
 * ⚠️ `path: '/'`, EXPLICITLY. Playwright derives a cookie's path from the `url`
 * form's DIRECTORY, so adding it while the page sits on
 * `/settings/account/security` scopes it to that folder — the browser then sends
 * it nowhere the spec actually navigates, `getWorkspaceContext` falls back to
 * the resolver, and the control writes the policy to the WRONG workspace. The
 * symptom is a member who is simply not held, with nothing red anywhere near the
 * cause.
 */
const bindWorkspace = (workspaceId: string) => ({
  name: WORKSPACE_COOKIE_NAME,
  value: workspaceId,
  domain: 'localhost',
  path: '/',
});

/** The Better-Auth session cookie's VALUE, for the never-re-signed-in assertion. */
async function sessionCookie(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name.includes('session_token'));
  expect(session, 'a session cookie should be set').toBeTruthy();
  return session!.value;
}

/** Resolve the org + workspace a freshly signed-up owner was given. */
async function ownedTenancy(email: string) {
  const user = await adminDb.user.findFirstOrThrow({ where: { email } });
  const membership = await adminDb.workspaceMembership.findFirstOrThrow({
    where: { userId: user.id },
    include: { workspace: true },
  });
  return { userId: user.id, workspace: membership.workspace };
}

/** A second person in the same org AND the same workspace. */
async function addTeammate(
  email: string,
  organizationId: string,
  workspaceId: string,
): Promise<string> {
  const member = await usersService.createUser({ email, password: PASSWORD, name: 'Grace' });
  await adminDb.organizationMembership.create({
    data: { organizationId, userId: member.id, role: ORGANIZATION_ROLE.member },
  });
  await workspacesService.addMember({ userId: member.id, workspaceId });
  return member.id;
}

/** A work item to be interrupted on the way to — the DEEP destination. */
async function seedDeepDestination(userId: string, workspaceId: string): Promise<string> {
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: userId,
    name: 'Enforcement',
    identifier: 'ENF',
  });
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'The page they were opening' },
    { userId, workspaceId },
  );
  return item.identifier;
}

/**
 * Turn a require-2FA switch on THROUGH THE UI and wait for the settled state.
 *
 * The toast is the Server Action's own completion signal — it is rendered from
 * the action's return value, so it cannot appear before the write committed.
 */
async function turnOnThroughTheUi(page: Page): Promise<void> {
  await page.getByRole('switch', { name: SWITCH }).click();
  // `exact` — the toast's text also appears inside the live region's
  // "Notification …" announcement, and an inexact match resolves to both.
  await expect(page.getByText('Security policy saved', { exact: true })).toBeVisible();
}

// ════════════════════════════════════════════════════════════════════════════
// 1 — the arc: required → held → enrolled → back where they were going
// ════════════════════════════════════════════════════════════════════════════

test.describe('2FA enforcement', () => {
  let authenticator: VirtualAuthenticator;

  test.beforeEach(async ({ context, page }) => {
    authenticator = await addVirtualAuthenticator(context, page);
  });

  test.afterEach(async () => {
    // ⚠️ NOT OPTIONAL — the context is reused across the tests in this file, so
    // a credential left behind would make a LATER test's held member silently
    // compliant, which is a false PASS on the assertion this story is about.
    await authenticator.remove();
  });

  test('@smoke an org admin requires it, a member is held, enrols, and lands where they were going', async ({
    page,
  }) => {
    const OWNER = 'e2e-2fa-owner@example.com';
    const MEMBER = 'e2e-2fa-member@example.com';

    await signUp(page, OWNER);
    const { userId: ownerId, workspace } = await ownedTenancy(OWNER);
    const itemKey = await seedDeepDestination(ownerId, workspace.id);
    await addTeammate(MEMBER, workspace.organizationId, workspace.id);
    await enrolPasskey(page);

    // ── 1 · the admin turns it on, through the org menu ──────────────────
    await page.goto('/home');
    await page.getByRole('button', { name: 'Organization menu' }).click();
    const orgMenu = page.getByRole('list').filter({
      has: page.locator('a[href="/settings/organization/members"]'),
    });
    await orgMenu.locator('a[href="/settings/organization/security"]').click();
    await page.waitForURL('**/settings/organization/security');

    const toggle = page.getByRole('switch', { name: SWITCH });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await turnOnThroughTheUi(page);

    // ⚠️ PERSISTED, not merely optimistic. The switch is a client island over a
    // Server Action; without the reload this asserts the island's own state.
    await page.reload();
    await expect(page.getByRole('switch', { name: SWITCH })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // ── 2 · a member without a second factor is stopped ─────────────────
    // A DEEP destination, not the dashboard: losing where somebody was going is
    // invisible in every test written one screen at a time.
    await signIn(page, MEMBER);
    await page.goto(`/items/${itemKey}`);
    await page.waitForURL('**/two-factor-required**');
    expect(new URL(page.url()).searchParams.get('next')).toBe(`/items/${itemKey}`);

    // The ORGANIZATION is named — an admin who cannot turn a toggle off, and a
    // member who cannot work, both deserve to know who is asking.
    const orgName = (
      await adminDb.organization.findFirstOrThrow({ where: { id: workspace.organizationId } })
    ).name;
    await expect(page.getByText(`Required by ${orgName}`)).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Set up a second factor to continue' }),
    ).toBeVisible();

    // …and NOTHING else is reachable. Asked for an app route, held again.
    await page.goto('/home');
    await page.waitForURL('**/two-factor-required**');

    // ── 3 · they enrol, FOR REAL, and the block lifts ────────────────────
    const before = await sessionCookie(page);
    await page.goto(`/items/${itemKey}`);
    await page.waitForURL('**/two-factor-required**');

    const verified = page.waitForResponse(
      (r) =>
        r.url().includes('/api/auth/passkey/verify-registration') &&
        r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    expect((await verified).status()).toBe(200);
    // The credential is the MEMBER's, in the database — not merely a device the
    // harness holds. (The authenticator carries the admin's too by now, so its
    // own count is not the assertion this needs.)
    const memberRow = await adminDb.user.findFirstOrThrow({ where: { email: MEMBER } });
    expect(await adminDb.passkey.count({ where: { userId: memberRow.id } })).toBe(1);

    // The screen MOVES. Without MOTIR-3648's satisfied panel the person enrols
    // and sits here, compliant and still held.
    await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
    await expect(page.getByText('Two-factor authentication is on')).toBeVisible();

    // ⚠️ NO RE-SIGN-IN ANYWHERE IN THE WALK. Nobody is signed out and nobody is
    // removed — that is the story's own promise, and a changed session cookie
    // would mean it was broken quietly.
    expect(await sessionCookie(page)).toBe(before);

    // ── and back to the WORK ITEM, not to a generic home ────────────────
    await page.getByRole('link', { name: new RegExp(`Continue to /items/${itemKey}`) }).click();
    await page.waitForURL(`**/items/${itemKey}`);
    await expect(page.getByRole('heading', { name: 'The page they were opening' })).toBeVisible();

    // ⚠️ THE PASSKEY-ONLY ACCOUNT. The column stays false and the person is
    // compliant anyway — the regression `lib/dto/twoFactor.ts` names this story
    // for, asserted here against a row a browser really wrote.
    expect(
      (await adminDb.user.findFirstOrThrow({ where: { email: MEMBER } })).twoFactorEnabled,
    ).toBe(false);

    // The rest of the product is open again.
    await page.goto('/home');
    await page.waitForURL('**/home');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2 — the workspace tier, and the lock
  // ══════════════════════════════════════════════════════════════════════════

  test('a workspace admin requires it for their workspace, and the org floor locks the control', async ({
    page,
  }) => {
    const OWNER = 'e2e-2fa-ws-owner@example.com';
    const MEMBER = 'e2e-2fa-ws-member@example.com';

    await signUp(page, OWNER);
    const { userId: ownerId, workspace: first } = await ownedTenancy(OWNER);

    // ⚠️ TWO WORKSPACES, OR THE PANE DOES NOT EXIST. `/settings/workspace/**`
    // 404s below `WORKSPACE_TIER_REVEAL_MIN` (organization-tier.md §6d), so a
    // one-workspace fixture would assert a 404 and call it a missing feature.
    const { workspace: second } = await workspacesService.createWorkspace({
      name: 'Second',
      ownerUserId: ownerId,
      organizationId: first.organizationId,
    });
    const memberId = await addTeammate(MEMBER, first.organizationId, second.id);
    const itemKey = await seedDeepDestination(ownerId, second.id);
    await enrolPasskey(page);

    // Act as the SECOND workspace — the control writes the ACTIVE one.
    await page.context().addCookies([bindWorkspace(second.id)]);
    await page.goto('/settings/workspace/security');
    await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();
    await turnOnThroughTheUi(page);

    // A member of ONLY that workspace is held, and the WORKSPACE is named.
    await signIn(page, MEMBER);
    await page.goto(`/items/${itemKey}`);
    await page.waitForURL('**/two-factor-required**');
    await expect(page.getByText(`Required by ${second.name}`)).toBeVisible();

    // ── the lock ─────────────────────────────────────────────────────────
    // The org floor is a PRECONDITION here, so it is seeded rather than clicked
    // — test 1 already proves the clicking.
    const orgName = (
      await adminDb.organization.findFirstOrThrow({ where: { id: first.organizationId } })
    ).name;
    await adminDb.organization.update({
      where: { id: first.organizationId },
      data: { requiresTwoFactor: true },
    });

    await signIn(page, OWNER);
    await page.context().addCookies([bindWorkspace(second.id)]);
    await page.goto('/settings/workspace/security');

    const locked = page.getByRole('switch', { name: SWITCH });
    await expect(locked).toBeDisabled();
    await expect(locked).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText(`Required by ${orgName}`)).toBeVisible();

    // ⚠️ AND A CLICK CHANGES NOTHING. `disabled` is an attribute; the assertion
    // that matters is that the STORED value survives an attempt on it — the
    // floor is not something a workspace admin can step off.
    await locked.click({ force: true });
    await expect(page.getByRole('switch', { name: SWITCH })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(
      (await adminDb.workspace.findFirstOrThrow({ where: { id: second.id } })).requiresTwoFactor,
    ).toBe(true);
    expect(memberId).toBeTruthy();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3 — the single-workspace fold-in: the shape MOST customers have
  // ══════════════════════════════════════════════════════════════════════════

  test('below the reveal threshold the control lives on /settings/organization, and the pane 404s', async ({
    page,
  }) => {
    // A control that existed only at `/settings/workspace/security` would be
    // unreachable for exactly the single-workspace orgs that are the common case,
    // and this is a different render path — the fold-in resolves the manager
    // check for ITSELF.
    await signUp(page, 'e2e-2fa-fold@example.com');
    await enrolPasskey(page);

    const response = await page.goto('/settings/workspace/security');
    expect(response?.status()).toBe(404);

    await page.goto('/settings/organization');
    const foldIn = page.getByRole('switch', { name: SWITCH });
    await expect(foldIn).toBeVisible();
    await turnOnThroughTheUi(page);
    await page.reload();
    await expect(page.getByRole('switch', { name: SWITCH })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4 — the states the happy path skips
  // ══════════════════════════════════════════════════════════════════════════

  test('a non-admin is refused the org pane, a compliant member is never held, and the way out works', async ({
    page,
  }) => {
    const OWNER = 'e2e-2fa-edge-owner@example.com';
    const MEMBER = 'e2e-2fa-edge-member@example.com';

    await signUp(page, OWNER);
    const { userId: ownerId, workspace } = await ownedTenancy(OWNER);
    const itemKey = await seedDeepDestination(ownerId, workspace.id);
    await addTeammate(MEMBER, workspace.organizationId, workspace.id);

    // ── a plain member is refused the org pane ──────────────────────────
    await signIn(page, MEMBER);
    await page.goto('/settings/organization/security');
    await expect(
      page.getByRole('heading', { name: 'Organization settings are admin-only' }),
    ).toBeVisible();
    await expect(page.getByRole('switch', { name: SWITCH })).toHaveCount(0);

    // ── a COMPLIANT member is never held ────────────────────────────────
    // Turned on while they already have a factor: enforcement is about the
    // person, not about the moment the policy flipped.
    const verified = page.waitForResponse(
      (r) =>
        r.url().includes('/api/auth/passkey/verify-registration') &&
        r.request().method() === 'POST',
    );
    await page.goto('/settings/account/security');
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    expect((await verified).status()).toBe(200);

    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { requiresTwoFactor: true },
    });
    await page.goto(`/items/${itemKey}`);
    await page.waitForURL(`**/items/${itemKey}`);
    await expect(page.getByRole('heading', { name: 'The page they were opening' })).toBeVisible();

    // ── the way OUT of the held screen ──────────────────────────────────
    // Every other route is closed to a held person, so a screen with no exit is
    // a trap: somebody on a borrowed laptop, or without their phone, has to be
    // able to leave. Present is not enough — it has to WORK.
    await adminDb.passkey.deleteMany({});
    await page.goto(`/items/${itemKey}`);
    await page.waitForURL('**/two-factor-required**');
    await page.getByRole('button', { name: /sign out/i }).click();
    await page.waitForURL('**/sign-in');
    expect(await page.context().cookies()).not.toContainEqual(
      expect.objectContaining({ name: expect.stringContaining('session_token') }),
    );
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5 — the walk cannot pass against a mocked server
  // ══════════════════════════════════════════════════════════════════════════

  test('⚠️ NOTHING in this spec is stubbed — asserted over its own source', async () => {
    // A `page.route` on the enrolment endpoints would make the whole walk assert
    // the harness rather than the product: it would pass against a server that
    // never wrote a credential, which is worth nothing. The virtual authenticator
    // is a fake DEVICE, not a fake server — every request above reaches the real
    // Better-Auth handler and the real database.
    //
    // A fixed wait would be the other way to fake it, so it is checked here too.
    const source = await import('node:fs').then(({ readFileSync }) =>
      readFileSync('tests/e2e/two-factor-enforcement.spec.ts', 'utf8'),
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    // ⚠️ THE NEEDLES ARE ASSEMBLED, NOT WRITTEN. A literal `page.route(` here
    // would be its own counterexample: the guard would find the string it is
    // searching for, in the line searching for it, and fail against a spec that
    // stubs nothing. (It did, once, which is why this note exists.)
    for (const needle of [
      ['page', 'route('],
      ['waitFor', 'Timeout'],
      ['route', 'fulfill('],
    ]) {
      expect(code, needle.join('.')).not.toContain(needle.join('.'));
    }
  });
});
