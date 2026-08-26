// E2E: the Settings → Account → Tokens pane (Story 7.8 · Subtask 7.8.3) —
// the human half of the PAT lifecycle, proven end-to-end over the real stack.
// It drives the acceptance recipe: create → shown-once copy → revoke → the
// muted revoked-state render, plus the secret-never-reappears guarantee.
//
// ⚠️ A TOKEN NEEDS A PROJECT (Story MOTIR-2572 · Subtask MOTIR-2606). The pane
// is still personal, but a hand-minted token BINDS to a project, because
// permissions resolve per project — so every test that mints one now creates a
// project first. Before that change a freshly signed-up user could mint from a
// zero-project workspace; now the modal's submit guard refuses, silently, and
// the `waitForResponse` below would hang rather than fail with a reason.
//
// Every mutation waits on its route response (the authoritative signal — never
// the optimistic UI alone, per the E2E discipline).

import { expect, test, type Locator } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { createFirstProject, signUp } from './_helpers/shell-session';
import { organizationsService } from '@/lib/services/organizationsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';

test.describe.configure({ timeout: 120_000 });

// The shown-once Copy affordance writes to the clipboard — grant it so the
// success toast ("Token copied") fires deterministically rather than the
// copy-failed fallback.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

// Assert an element's content fits INSIDE its own box — no horizontally
// clipped remainder (MOTIR-3545). The shown-once secret is the case this
// exists for: a `textContent` read cannot see a clip, so a field that shows
// 48 of a token's 53 characters passes every string assertion in this file.
// The measurement is a plain layout read of an element already awaited
// visible, so there is nothing eventually-consistent to race.
async function expectFullyVisible(el: Locator, what: string) {
  const box = await el.evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    text: node.textContent ?? '',
  }));
  expect(
    box.scrollWidth,
    `${what}: ${box.text.length} chars laid out to ${box.scrollWidth}px inside a ${box.clientWidth}px field — the remainder is clipped out of view`,
  ).toBeLessThanOrEqual(box.clientWidth);
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('create → shown-once copy → revoke → the row is GONE', async ({ page }) => {
  await signUp(page, 'tokens-e2e@example.com');
  await createFirstProject(page, 'Tokens E2E');

  await page.goto('/settings/account/tokens');
  // `exact` — "Tokens" is a substring of the empty-state heading "No tokens
  // yet", which is also an <h2>; the page-head is the exact match. (The
  // substring hazard survived the MOTIR-2532 rename: it was "API tokens"
  // inside "No API tokens yet" before, and is "Tokens" inside "No tokens yet"
  // now — so the matcher stays exact.)
  await expect(page.getByRole('heading', { name: 'Tokens', exact: true })).toBeVisible();

  // Empty state — no tokens yet.
  await expect(page.getByRole('heading', { name: 'No tokens yet' })).toBeVisible();

  // CREATE — open the modal from the empty state, name the token, submit.
  await page.getByRole('button', { name: 'Create token' }).first().click();
  const createDialog = page.getByRole('dialog');
  await expect(createDialog.getByRole('heading', { name: 'Create token' })).toBeVisible();
  await createDialog.getByLabel('Label').fill('claude-code');

  const createResp = page.waitForResponse(
    (r) => r.url().endsWith('/api/me/api-tokens') && r.request().method() === 'POST',
  );
  await createDialog.getByRole('button', { name: 'Create token', exact: true }).click();
  expect((await createResp).status()).toBe(201);

  // SHOWN-ONCE — the full secret appears exactly once with a Copy button.
  await expect(createDialog.getByRole('heading', { name: 'Token created' })).toBeVisible();
  const secret = createDialog.getByTestId('api-token-secret');
  await expect(secret).toBeVisible();
  const secretText = ((await secret.textContent()) ?? '').trim();
  expect(secretText.startsWith('motir_pat_')).toBe(true);

  // ── The secret must be SHOWN, not merely PRESENT (MOTIR-3545) ──────────
  // Every assertion above this line reads `textContent`, and `textContent` was
  // always complete while the rendered box CLIPPED the string — which is how a
  // one-time reveal shipped for months missing characters with all of its
  // tests green. The DOM text is not the deliverable here; the pixels are. So
  // measure the BOX.
  //
  // `motir_pat_` (10) + base64url(32 bytes) (43) — a secret is ALWAYS 53
  // characters, so the length is an invariant and not a sample.
  expect(secretText).toHaveLength(53);
  await expectFullyVisible(secret, 'the minted secret, desktop');

  // The panel is `w-[90vw]` UNDER its `max-w`, so width alone cannot carry
  // this: a narrow viewport shrinks the field regardless of the cap. Assert at
  // the phone width, where the fix has to be the wrapping rule.
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(secret).toBeVisible();
  await expectFullyVisible(secret, 'the minted secret, 390px viewport');

  // A minted secret carries a `-` only about half the time (one in 64 chars,
  // 43 of them), and the hyphen is the WORST case rather than the mild one:
  // it is base64url's only line-break opportunity, so the string wraps after
  // it and the over-long run BEFORE it is clipped — a token that reads as
  // neatly wrapped and complete while characters are missing. Leaving that to
  // the mint would make this assertion a coin flip, so drive the shipped
  // element with a pinned worst-case string instead. The swap is restored
  // inside the same synchronous evaluate, so React never observes it.
  const pinned = await secret.evaluate((node) => {
    const real = node.textContent;
    node.textContent = 'motir_pat_neCbhDWPEHQneyjNrgWLSnz2_eXYz9-VEAEdkAaCkl4';
    const box = { scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
    node.textContent = real;
    return box;
  });
  expect(
    pinned.scrollWidth,
    `a hyphen-bearing secret laid out to ${pinned.scrollWidth}px in a ${pinned.clientWidth}px field`,
  ).toBeLessThanOrEqual(pinned.clientWidth);

  if (desktopViewport) await page.setViewportSize(desktopViewport);
  await expect(secret).toBeVisible();

  // Copy → success toast.
  await createDialog.getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByText('Token copied', { exact: true })).toBeVisible();

  // Done closes the modal; the row now shows only the truncated PREFIX.
  await createDialog.getByRole('button', { name: 'Done' }).click();
  await expect(createDialog).toBeHidden();

  const row = page.getByRole('row', { name: /claude-code/ });
  await expect(row).toBeVisible();
  await expect(row.getByText(/^motir_pat_.+…$/)).toBeVisible();
  // The full secret is irretrievable after close — only the prefix remains.
  await expect(page.getByText(secretText, { exact: true })).toHaveCount(0);

  // REVOKE — confirm, wait on the DELETE, then the row LEAVES the table.
  await row.getByRole('button', { name: 'Revoke token claude-code' }).click();
  const revokeDialog = page.getByRole('dialog');
  await expect(revokeDialog.getByRole('heading', { name: 'Revoke "claude-code"?' })).toBeVisible();

  const revokeResp = page.waitForResponse(
    (r) => /\/api\/me\/api-tokens\/[^/]+$/.test(r.url()) && r.request().method() === 'DELETE',
  );
  await revokeDialog.getByRole('button', { name: 'Revoke token', exact: true }).click();
  expect((await revokeResp).status()).toBe(204);

  // ── The row is REMOVED, not muted (MOTIR-3546) ────────────────────────────
  // This is the assertion that fails against the pre-fix build, where the row
  // stayed with a neutral "Revoked" pill in place of its delete button — and
  // stayed for ever, because that pill took the only control that could have
  // removed it. `toHaveCount(0)` is the whole point: a revoked credential is
  // not a credential in another state, it is not a credential.
  await expect(page.getByRole('row', { name: /claude-code/ })).toHaveCount(0);
  await expect(page.getByText('Revoked')).toHaveCount(0);

  // And it is gone from the SERVER, not just spliced out of the island's own
  // state — a reload re-reads `listForUser`, so an optimistic-only removal
  // would put the row back here.
  await page.reload();
  await expect(page.getByRole('row', { name: /claude-code/ })).toHaveCount(0);
  // The empty state returns: this account has no other token.
  await expect(page.getByRole('heading', { name: 'No tokens yet' })).toBeVisible();
});

// The expiry half of the create flow (Story 7.7 · Subtask 7.7.12, the
// story-closing settings check): a token minted with a CHOSEN expiry (not the
// 90-day default) lists that expiry as a relative "in N days", proving the
// label + expiry → list-shows-expiry path the card calls out.
test('create with a chosen expiry → the list shows the expiry', async ({ page }) => {
  await signUp(page, 'tokens-expiry-e2e@example.com');
  await createFirstProject(page, 'Expiry E2E');

  await page.goto('/settings/account/tokens');
  await expect(page.getByRole('heading', { name: 'Tokens', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Create token' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Create token' })).toBeVisible();
  await dialog.getByLabel('Label').fill('ci-token');

  // Pick a non-default expiry via the Expires combobox (default is 90 days).
  await dialog.getByRole('combobox', { name: 'Expires' }).click();
  await dialog.getByRole('option', { name: '30 days' }).click();

  const createResp = page.waitForResponse(
    (r) => r.url().endsWith('/api/me/api-tokens') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Create token', exact: true }).click();
  expect((await createResp).status()).toBe(201);

  await expect(dialog.getByRole('heading', { name: 'Token created' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();

  // The row carries the truncated prefix AND the chosen expiry as "in N days".
  const row = page.getByRole('row', { name: /ci-token/ });
  await expect(row).toBeVisible();
  await expect(row.getByText(/^motir_pat_.+…$/)).toBeVisible();
  await expect(row.getByText(/in \d+ days/)).toBeVisible();
});

// Permission-scope selection (Story 7.8 · Subtask 7.8.20, over the 7.7.19 UI):
// the human half of the scope contract proven end-to-end — create a token with
// a CUSTOM permission selection, confirm the shown-once secret, and confirm the
// list surfaces the granted permissions (the "Custom" summary + the per-
// permission detail chips, with the withheld ones absent and no "Can delete"
// pill). The names are the CATALOG's (Story MOTIR-2572) — the shipped
// `permissions.*` copy the Roles & permissions screen also renders.
test('create with a custom scope selection → shown-once + the list shows the granted scopes', async ({
  page,
}) => {
  await signUp(page, 'tokens-scopes-e2e@example.com');
  await createFirstProject(page, 'Grant E2E');

  await page.goto('/settings/account/tokens');
  await expect(page.getByRole('heading', { name: 'Tokens', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Create token' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Create token' })).toBeVisible();
  await dialog.getByLabel('Label').fill('scoped-custom');

  // The Permissions picker opens on the default grant (all-on-except-delete):
  // a work-item write is on, the irreversible delete is off.
  await expect(dialog.getByRole('switch', { name: 'Edit work items', exact: true })).toBeChecked();
  await expect(
    dialog.getByRole('switch', { name: 'Delete work items', exact: true }),
  ).not.toBeChecked();

  // Narrow to a CUSTOM subset: turn OFF Manage sprints + Run AI planning,
  // keeping View project + Edit work items + Add comments. Not the default set,
  // not read-only, not full → the list will summarise it as "Custom".
  await dialog.getByRole('switch', { name: 'Manage sprints', exact: true }).click();
  await dialog.getByRole('switch', { name: 'Run AI planning', exact: true }).click();
  await expect(
    dialog.getByRole('switch', { name: 'Manage sprints', exact: true }),
  ).not.toBeChecked();

  const createResp = page.waitForResponse(
    (r) => r.url().endsWith('/api/me/api-tokens') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Create token', exact: true }).click();
  expect((await createResp).status()).toBe(201);

  // SHOWN-ONCE — the full secret appears with its motir_pat_ prefix.
  await expect(dialog.getByRole('heading', { name: 'Token created' })).toBeVisible();
  const secret = dialog.getByTestId('api-token-secret');
  await expect(secret).toBeVisible();
  expect(((await secret.textContent()) ?? '').trim().startsWith('motir_pat_')).toBe(true);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();

  // The row summarises the grant as "Custom" and carries NO "Can delete" pill.
  const row = page.getByRole('row', { name: /scoped-custom/ });
  await expect(row).toBeVisible();
  await expect(row.getByText('Custom', { exact: true })).toBeVisible();
  await expect(row.getByText('Can delete')).toHaveCount(0);

  // Disclosing the detail lists exactly the granted permissions — the kept
  // three present, the toggled-off two and delete absent.
  await row.getByRole('button', { name: 'Show scopes for scoped-custom' }).click();
  await expect(page.getByText('View project', { exact: true })).toBeVisible();
  await expect(page.getByText('Edit work items', { exact: true })).toBeVisible();
  await expect(page.getByText('Add comments', { exact: true })).toBeVisible();
  await expect(page.getByText('Manage sprints', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Run AI planning', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Delete work items', { exact: true })).toHaveCount(0);
});

// The DEFAULT grant (all-minus-delete): creating without touching the picker
// yields a "Standard" token with delete OFF — the user's "enable all but
// disable delete" requirement, proven through the modal + list.
test('create a default token → "Standard", and delete is off', async ({ page }) => {
  await signUp(page, 'tokens-default-e2e@example.com');
  await createFirstProject(page, 'Default E2E');

  await page.goto('/settings/account/tokens');
  await expect(page.getByRole('heading', { name: 'Tokens', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Create token' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Create token' })).toBeVisible();
  await dialog.getByLabel('Label').fill('scoped-default');

  // Delete is off by default — the deliberate one-scope opt-in.
  await expect(
    dialog.getByRole('switch', { name: 'Delete work items', exact: true }),
  ).not.toBeChecked();

  const createResp = page.waitForResponse(
    (r) => r.url().endsWith('/api/me/api-tokens') && r.request().method() === 'POST',
  );
  // Submit WITHOUT changing scopes → the default all-minus-delete grant.
  await dialog.getByRole('button', { name: 'Create token', exact: true }).click();
  expect((await createResp).status()).toBe(201);

  await expect(dialog.getByRole('heading', { name: 'Token created' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();

  // The row reads "Standard" with NO "Can delete" pill, and the disclosed detail
  // omits the delete scope.
  const row = page.getByRole('row', { name: /scoped-default/ });
  await expect(row).toBeVisible();
  await expect(row.getByText('Standard', { exact: true })).toBeVisible();
  await expect(row.getByText('Can delete')).toHaveCount(0);

  await row.getByRole('button', { name: 'Show scopes for scoped-default' }).click();
  await expect(page.getByText('View project', { exact: true })).toBeVisible();
  await expect(page.getByText('Delete work items', { exact: true })).toHaveCount(0);
});

// MOTIR-2488 — the create modal's footer must stay INSIDE the dialog panel.
//
// The panel is `max-h-[90vh] overflow-hidden`, so its child has to own the
// scroll (`Modal.Body`) or the overflow is clipped with no scrollbar anywhere:
// Cancel and Create token get painted outside the panel and become unreachable
// by any means. The regression is invisible to the rest of this file because
// every other test signs up fresh — ONE org, ONE workspace — which renders the
// SHORTEST variant of the form at Playwright's default 1280x720. Two things
// have to be wrong at once to see it, so the test breaks both:
//
//   * a ≥2-org account, which reveals the extra Organization row (the binding
//     picker is progressively disclosed), and
//   * a SHORT viewport, the axis no other spec varies.
//
// Asserted with `toBeInViewport`, not `toBeVisible`: a clipped element still
// has a bounding box and still passes every role/visibility query, which is
// precisely why unit and E2E coverage both stayed green while the surface was
// unusable. Then the token is actually created, so the fix is proven to keep
// the submit path working rather than merely to put pixels on screen.
test('the Create button stays reachable on a multi-org account in a short viewport', async ({
  page,
}) => {
  const email = 'tokens-tall-modal-e2e@example.com';
  await signUp(page, email);
  await createFirstProject(page, 'Tall Modal E2E');

  // A second org, server-side — a single-org account has no UI path to org #2.
  // It needs a workspace of its own: the binding picker reads ORGS THAT HAVE a
  // workspace the user belongs to, so a bare org never reaches `scopeOrgs` and
  // the Organization row stays hidden.
  const user = await db.user.findFirstOrThrow({ where: { email } });
  const beacon = await organizationsService.createOrganization({
    name: 'Beacon',
    actorUserId: user.id,
  });
  await workspacesService.createWorkspace({
    name: 'Crew',
    ownerUserId: user.id,
    organizationId: beacon.id,
  });

  // Shorter than the 720 default and than any laptop the suite has run on.
  await page.setViewportSize({ width: 1280, height: 700 });

  await page.goto('/settings/account/tokens');
  await expect(page.getByRole('heading', { name: 'Tokens', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Create token' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Create token' })).toBeVisible();

  // THE TALLEST SHAPE THE MODAL HAS. Three things stack here, and each was
  // added by a different card: the Organization picker (≥2 orgs only), the
  // Project picker (MOTIR-2606's required binding), and the permission grid
  // (MOTIR-2580). Asserting all three are present is what makes the footer
  // assertion below a test of the WORST case rather than of whichever case
  // happens to render today.
  //
  // ⚠️ The grid's SIZE is derived, not written down (MOTIR-2988). It was `6`,
  // and it became 7 the moment `ai:view_plan` gained its first token-reachable
  // operation — `GRANTABLE_PERMISSIONS` is COMPUTED, so any story that gives an
  // existing catalog key an operation grows this modal without touching it. A
  // literal here turns that into a red build on an unrelated branch; reading the
  // same derived set the picker reads keeps this a test of the modal's HEIGHT,
  // which is what it is for.
  //
  // ⚠️ It is EIGHT since MOTIR-3188, by a mechanism this note did not describe.
  // The sentence above said the set is computed from `TOOL_PERMISSIONS`; it is
  // computed from three sources, and the third — `V1_ONLY_PERMISSIONS`, keys
  // reachable through `/api/v1` and no MCP tool — held nothing until
  // `ai:decide_plan` arrived. So a key can now grow this grid without any tool
  // existing for it at all.
  await expect(dialog.getByRole('combobox', { name: 'Organization' })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Project' })).toBeVisible();
  await expect(dialog.getByRole('group', { name: 'Permissions' }).getByRole('switch')).toHaveCount(
    GRANTABLE_PERMISSIONS.length,
  );

  // The panel obeys its own cap — it grows no further than 90vh (630px here).
  const panel = await dialog.boundingBox();
  expect(panel).not.toBeNull();
  expect(panel!.height).toBeLessThanOrEqual(700 * 0.9 + 1);

  // THE REGRESSION: both footer buttons are inside the viewport, not clipped
  // outside the panel. Fails before MOTIR-2488's fix; passes after.
  const submit = dialog.getByRole('button', { name: 'Create token', exact: true });
  await expect(submit).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();

  // And it still submits — the footer stayed inside the <form>.
  await dialog.getByLabel('Label').fill('short-viewport');
  const createResp = page.waitForResponse(
    (r) => r.url().endsWith('/api/me/api-tokens') && r.request().method() === 'POST',
  );
  await submit.click();
  expect((await createResp).status()).toBe(201);

  await expect(dialog.getByRole('heading', { name: 'Token created' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: /short-viewport/ })).toBeVisible();
});

// The EMPTY grant (Story MOTIR-2572 · Subtask MOTIR-2586): a token that grants
// nothing is not a token. The CTA goes dead and the modal says why, rather than
// minting a credential every call would then refuse. Asserted here as well as in
// the acceptance clip, because the bulk lane is what runs on every PR.
/**
 * Turn OFF every permission switch that is currently on.
 *
 * Written as a sweep rather than as a list of labels because the grant is
 * DERIVED (`GRANTABLE_PERMISSIONS` is computed from `TOOL_PERMISSIONS`): a story
 * that gives an existing catalog key its first tool adds a switch to this modal
 * and to the default grant. A list would then miss it, leave one permission on,
 * and turn "the empty grant is refused" into a test that asserts nothing —
 * failing loudly here is better than that, but not needing to change at all is
 * better still.
 */
async function turnEveryPermissionOff(dialog: Locator): Promise<void> {
  const switches = dialog.getByRole('group', { name: 'Permissions' }).getByRole('switch');
  const count = await switches.count();
  expect(count, 'the permission grid rendered no switches').toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const toggle = switches.nth(i);
    if (await toggle.isChecked()) await toggle.click();
  }
  // The sweep really did empty it — otherwise a switch that failed to toggle
  // would leave this helper silently doing nothing.
  for (let i = 0; i < count; i += 1) {
    await expect(switches.nth(i)).not.toBeChecked();
  }
}

test('a grant with nothing selected refuses submission, with its reason', async ({ page }) => {
  await signUp(page, 'tokens-empty-grant-e2e@example.com');
  await createFirstProject(page, 'Empty Grant E2E');

  await page.goto('/settings/account/tokens');
  await page.getByRole('button', { name: 'Create token' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Create token' })).toBeVisible();
  await dialog.getByLabel('Label').fill('grants-nothing');

  // Everything the DEFAULT grant turned on, turned back off. Driven off what is
  // CHECKED rather than a written list of names (MOTIR-2988): the default grant
  // is derived from the grantable set, so a story that makes another catalog key
  // token-reachable adds a switch here — and a hard-coded list would then leave
  // one on and silently stop testing the refusal it exists for.
  await turnEveryPermissionOff(dialog);

  await expect(dialog.getByRole('alert')).toContainText(
    'Grant at least one permission to create a token.',
  );
  const submit = dialog.getByRole('button', { name: 'Create token', exact: true });
  await expect(submit).toBeDisabled();

  // Turning one back on revives it — the refusal is about the grant, not a
  // form the modal has got stuck in.
  await dialog.getByRole('switch', { name: 'View project', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(submit).toBeEnabled();
});

// ── The MOTIR-2532 rename: the DOOR and the old address (Subtask MOTIR-2541) ──
//
// Everything above reaches the pane with `page.goto`, which is the right shape
// for testing the pane. It is the wrong shape for testing a RENAME: what
// MOTIR-2532 changed is the way IN — a row in the account rail — and the
// address that row points at. A spec that jumps straight to the URL exercises
// the room and skips the door.

test('the account rail says Tokens, and the row opens the pane', async ({ page }) => {
  await signUp(page, 'tokens-rail-e2e@example.com');

  // In through the shell, the way a person gets here. The avatar button carries
  // the only door to account settings — it is a Popover, not a menu, so the
  // trigger is a `button` labelled "Account menu" and the item inside is a
  // plain `link`, not a `menuitem` (`app/(authed)/_components/UserMenu.tsx`).
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('link', { name: 'Account settings' }).click();

  // The rail is the `<nav aria-label="Account settings">` landmark; scoping to
  // it keeps the row assertion off the page content, which repeats the label
  // (the same collision `profile.spec.ts` scopes around).
  const rail = page.getByRole('navigation', { name: 'Account settings' });
  const railRow = rail.getByRole('link', { name: 'Tokens', exact: true });
  await expect(railRow).toBeVisible();

  await railRow.click();
  await expect(page).toHaveURL(/\/settings\/account\/tokens$/);
  await expect(page.getByRole('heading', { name: 'Tokens', exact: true })).toBeVisible();
});

test('the OLD address still lands on the pane — the redirect is a promise to strangers', async ({
  page,
}) => {
  await signUp(page, 'tokens-redirect-e2e@example.com');

  // `/settings/account/api-tokens` is quoted in shipped docs, in a published
  // @motir/cli's help text, in two design assets kept as point-in-time records,
  // and in whatever readers bookmarked. MOTIR-2534's permanent redirect is what
  // keeps every one of those working — asserted here through a REAL request,
  // because the redirect map's own unit test proves the configuration and not
  // the outcome.
  const response = await page.goto('/settings/account/api-tokens');

  await expect(page).toHaveURL(/\/settings\/account\/tokens$/);
  await expect(page.getByRole('heading', { name: 'Tokens', exact: true })).toBeVisible();

  // The chain really was a redirect, and a PERMANENT one: a 307 would tell a
  // crawler and a bookmark to keep asking the old address forever.
  const chain = response?.request().redirectedFrom();
  expect(chain).not.toBeNull();
  expect((await chain!.response())?.status()).toBe(308);
});
