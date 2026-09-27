import { expect, type Page } from '@playwright/test';
import { adminDb } from './db-reset';
import { actionWrite } from './authoritative-signal';
import { signIn } from './shell-session';
import { PA_PASSWORD, type ProjectAccessSeed } from './project-access-seed';
import { INVITE_IDENTIFIER_PREFIX } from '@/lib/services/workspaceInvitesService';

// The steps of Story MOTIR-6169's recipe (Subtask MOTIR-6553), shared by the
// main-lane spec (`project-access-contractor.spec.ts`) and the paced receipt
// (`acceptance-project-access.spec.ts`), so the two cannot drift apart.
//
// Every step waits on an AUTHORITATIVE signal (CLAUDE.md § E2E): the write's own
// response, armed BEFORE the press, and — where a later read depends on it — the
// committed row, polled from the database.

export async function signInAs(
  page: Page,
  email: string,
  landing: 'workbench' | 'no-project' = 'workbench',
): Promise<void> {
  await page.context().clearCookies();
  await signIn(page, email, PA_PASSWORD, { landing });
}

/** Send a Limited invite for `projectName` from Workspace settings → Members; returns its token. */
export async function inviteLimited(
  page: Page,
  seed: ProjectAccessSeed,
  projectName: string,
): Promise<string> {
  await page.goto('/settings/workspace');
  await expect(page.getByRole('heading', { name: 'Members', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Email address').fill(seed.contractor.email);
  await dialog.getByRole('radio', { name: /^Limited/ }).click();
  const picker = dialog.getByRole('combobox', { name: 'Projects to join' });
  await picker.click();
  await dialog.getByRole('option', { name: new RegExp(`^${projectName} · `) }).click();
  // The pick is a chip, removable — the picker's committed state.
  await expect(
    dialog.getByRole('button', { name: new RegExp(`^Remove ${projectName} · `) }),
  ).toBeVisible();
  const sent = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/workspaces/${seed.workspaceId}/invites` &&
      r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Send invite' }).click();
  expect((await sent).status(), 'the invite').toBe(200);
  const row = await adminDb.verification.findFirstOrThrow({
    where: {
      identifier: { startsWith: INVITE_IDENTIFIER_PREFIX },
      value: { contains: seed.contractor.email },
    },
  });
  return row.identifier.slice(INVITE_IDENTIFIER_PREFIX.length);
}

/** Accept the invite as the signed-in contractor; settle on the joined workspace's landing. */
export async function acceptInvite(page: Page, token: string): Promise<void> {
  await page.goto(`/invite/accept?token=${encodeURIComponent(token)}`);
  const accepted = page.waitForResponse(
    (r) =>
      /\/api\/invites\/[^/]+\/accept$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Accept invite' }).click();
  expect((await accepted).status(), 'the accept').toBe(200);
  await page.waitForURL(/\/workbench/, { timeout: 30_000 });
}

/** Open the project switcher and return its popover. */
export async function openSwitcher(page: Page) {
  await page.getByRole('button', { name: 'Switch project' }).click();
  // The open popover, told apart by its PROJECTS label (as project-access.spec does).
  const popover = page.locator('[data-state=open]').filter({ hasText: 'Projects' });
  await expect(popover).toBeVisible();
  return popover;
}

/** The switcher lists exactly `present`, and none of `absent`. */
export async function expectSwitcher(page: Page, present: string[], absent: string[]) {
  const popover = await openSwitcher(page);
  for (const name of present) await expect(popover.getByText(name, { exact: true })).toBeVisible();
  for (const name of absent) await expect(popover.getByText(name, { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
}

async function mod(page: Page): Promise<'Meta' | 'Control'> {
  const isMac = await page.evaluate(() => /mac|iphone|ipad|ipod/i.test(navigator.platform));
  return isMac ? 'Meta' : 'Control';
}

/** ⌘K, typed `query`: the palette offers a switch to each of `present`, to none of `absent`. */
export async function expectPalette(
  page: Page,
  query: string,
  present: string[],
  absent: string[],
) {
  await page.keyboard.press(`${await mod(page)}+k`);
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type(query);
  for (const name of present) {
    await expect(
      palette.getByRole('option', { name: new RegExp(`(Switch to )?${name}\\b`) }),
    ).toBeVisible();
  }
  for (const name of absent) {
    await expect(palette.getByRole('option', { name: new RegExp(`\\b${name}\\b`) })).toHaveCount(0);
  }
  await page.keyboard.press('Escape');
}

/** The address renders the not-found page — never the project, never a 403. */
export async function expectNotFound(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
}

/** Edit an item's title on its edit page; the committed row is the signal. */
export async function editTitle(page: Page, itemKey: string, itemId: string, title: string) {
  await page.goto(`/items/${itemKey}/edit`);
  const field = page.getByRole('textbox', { name: 'Title' });
  await expect(field).toBeVisible();
  await field.fill(title);
  const saved = actionWrite(page, `/items/${itemKey}/edit`, itemId);
  await page.getByRole('button', { name: 'Save' }).click();
  expect((await saved).status(), 'the title save').toBe(200);
  await expect
    .poll(async () => (await adminDb.workItem.findUniqueOrThrow({ where: { id: itemId } })).title)
    .toBe(title);
}

/** Switch the active project through the switcher; settle once it reads `name`. */
export async function switchProject(page: Page, name: string) {
  const popover = await openSwitcher(page);
  await popover.getByRole('button', { name }).click();
  await expect(page.getByRole('button', { name: 'Switch project' })).toContainText(name, {
    timeout: 30_000,
  });
}

/**
 * On the active project's Access & members page, choose Members only; the
 * confirm must list exactly `losing` (or say nobody loses access), then commit.
 */
export async function makeMembersOnly(page: Page, projectName: string, losing: string[]) {
  await page.goto('/settings/project/members');
  await expect(page.getByRole('heading', { name: 'Access & members' })).toBeVisible();
  const preview = page.waitForResponse((r) => /\/access\/preview/.test(r.url()));
  await page.getByRole('radio', { name: /^Members only/ }).click();
  expect((await preview).status(), 'the preview').toBe(200);
  const confirm = page.getByRole('dialog', { name: `Make ${projectName} members only?` });
  await expect(confirm).toBeVisible();
  if (losing.length === 0) {
    await expect(confirm.getByText(/^Nobody loses access/)).toBeVisible();
  } else {
    for (const name of losing) await expect(confirm.getByText(name, { exact: true })).toBeVisible();
  }
  const written = page.waitForResponse(
    (r) => new URL(r.url()).pathname.endsWith('/access') && r.request().method() === 'PATCH',
  );
  await confirm.getByRole('button', { name: 'Make members only' }).click();
  expect((await written).status(), 'the mode write').toBe(200);
  await expect(page.getByRole('radio', { name: /^Members only/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
}

/** Add a person on the Access & members page; their row appears. */
export async function addPerson(page: Page, name: string) {
  const added = page.waitForResponse(
    (r) => new URL(r.url()).pathname.endsWith('/members') && r.request().method() === 'POST',
  );
  await page.getByRole('combobox', { name: 'Add a project member' }).click();
  await page.getByRole('option', { name: new RegExp(`^${name}`) }).click();
  expect((await added).status(), 'the add').toBe(201);
  await expect(
    page.getByRole('listitem').filter({ hasText: name }).getByRole('button', { name: 'Remove' }),
  ).toBeVisible();
}
