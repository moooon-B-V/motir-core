// Acceptance E2E — Story MOTIR-1863: connect the CLI (Subtask MOTIR-1871).
//
// Runs under playwright.acceptance.config.ts (video: 'on'), which discovers this
// file by its `acceptance*.spec.ts` name (MOTIR-1700); the bulk shards
// `testIgnore` the same pattern, so it runs ONCE, in the lane that records. The
// recorded happy path declares Story MOTIR-1863 via `acceptanceStory()`
// (MOTIR-1684), so the clip publishes to 1863 whichever PR triggered the run.
//
// It closes the Story from the user's seat, and from the terminal's at the same
// time: a person finds the CLI in Settings → Account → API tokens, a terminal
// opens a device grant and blocks, the person approves it at `/device` choosing
// a workspace, the terminal is handed a credential that really works, and
// revoking the row in that same table really disconnects it.
//
// ROUTES ARE `/api/cli/device/*`, not `/api/auth/device/*`. The card's body
// names the latter; shipped reality (`docs/decisions/cli-login.md`,
// `lib/services/cliDeviceService.ts`) is that Motir owns the CLI-facing routes
// and Better-Auth's plugin stays private. Rung 2 wins.
//
// DETERMINISM — no stubs, no fakes, no clock control. Every request in this
// spec hits a real route against real Postgres: the grant is opened over HTTP,
// the poll is the RFC 8628 request the CLI sends, and the minted bearer is
// exercised through the SAME MCP SDK client `packages/cli` uses. The one piece
// of state written directly is `expiresAt` on an already-issued grant
// (`expireGrant`), because the alternative is waiting fifteen real minutes for
// a fact the row already models.
//
// WHICH TEST CARRIES THE CAMERA: only the first. The states a happy path skips
// — signed-out arrival, deny, expired, unknown, and the confirm screen's
// loading beat — are each asserted in their own test below, deliberately not
// narrated into the video: a reviewer accepts this Story by watching it work,
// not by watching four ways it can refuse.

import { test, expect } from './_helpers/acceptance-video';
import type { Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { formatUserCode } from '@/lib/cliDevice/userCode';
import { cliTokenLabel } from '@/lib/cliDevice/constants';
import { CLI_TOKEN_SCOPES } from '@/lib/mcp/scopes';
import { escapeRegExp } from '@/lib/utils/regexp';
import {
  expireGrant,
  mcpBearerWorks,
  pollOnce,
  pollUntilResolved,
  seedCliConnect,
  startGrant,
  terminalContext,
  type CliConnectSeed,
  type DeviceGrant,
} from './_helpers/cli-connect-seed';

test.describe.configure({ timeout: 180_000 });

// The connect panel's snippets copy to the clipboard; grant it so the success
// toast fires deterministically rather than the copy-failed fallback (the
// shipped `api-tokens.spec.ts` does the same for the shown-once secret).
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

/** The machine the grant claims to come from. A fixed value, because the token
 *  label the tokens table must show is derived from it — `CLI · <hostname>`. */
const TERMINAL_HOSTNAME = 'studio-mbp';
const CLI_TOKEN_LABEL = cliTokenLabel(TERMINAL_HOSTNAME);

const TOKENS_PATH = '/settings/account/api-tokens';

// ── Page helpers ─────────────────────────────────────────────────────────────

/** The device-code field, by its shipped label (`device.code.label`). */
const codeField = (page: Page) => page.getByRole('textbox', { name: 'Device code' });

/**
 * Reach the API-tokens pane through its REAL door — the avatar menu → Account
 * → API tokens (design `cli-connect` Panel 0's access path) — so the recording
 * shows how a person actually finds the CLI rather than teleporting by URL.
 *
 * `exact` on the page heading: "API tokens" is a substring of the empty-state
 * heading "No API tokens yet", which is also a heading. Matching loosely here
 * is the superstring trap the shipped spec already documents.
 */
async function openApiTokensPane(page: Page): Promise<void> {
  await page.goto(TOKENS_PATH);
  await expect(page.getByRole('heading', { name: 'API tokens', exact: true })).toBeVisible();
}

/** The tokens-table row for a label — the surface the CLI token must appear in. */
const tokenRow = (page: Page, label: string) =>
  page.getByRole('row', { name: new RegExp(escapeRegExp(label)) });

/**
 * Sign in and land back on the `/device` hand-off rather than `/dashboard`.
 *
 * The shared `signIn` helper waits for `**\/dashboard`, which is right for every
 * other spec and wrong for exactly this flow: `DeviceSignedOut` links to
 * `/sign-in?next=/device?user_code=…`, and the whole point of the signed-out
 * state is that the return carries the code.
 */
async function signInReturningToDevice(
  page: Page,
  seed: CliConnectSeed,
  userCode: string,
): Promise<void> {
  await page.getByPlaceholder('Email address').fill(seed.email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Password').fill(seed.password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL(`**/device?user_code=${userCode}`, { timeout: 30_000 });
}

/**
 * Arrive at the verification URL and advance to the confirm screen.
 *
 * Continue is a real click, not a shortcut: `GET /api/cli/device/grant` both
 * describes AND CLAIMS the code (Better-Auth's verify read is the claim), and
 * the design deliberately makes the human check the code against their terminal
 * before that side effect fires. Waiting on that response is the authoritative
 * signal that the confirm screen's facts are the server's, not a render race.
 */
async function advanceToConfirm(page: Page, grant: DeviceGrant): Promise<void> {
  const described = page.waitForResponse(
    (r) => r.url().includes('/api/cli/device/grant') && r.request().method() === 'GET',
  );
  await page.getByRole('button', { name: 'Continue' }).click();
  expect((await described).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Connect this terminal?' })).toBeVisible();
  // The screen echoes the code the SERVER matched, in its display form.
  await expect(page.getByText(formatUserCode(grant.userCode)).first()).toBeVisible();
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ── The recorded happy path ──────────────────────────────────────────────────

test('connect the CLI — the panel, the code, the approval, and a terminal that is really connected', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-1863');
  const seed = await seedCliConnect(`cli-connect-${Date.now()}@example.com`);
  const terminal = await terminalContext();

  await signIn(page, seed.email, seed.password);

  let grant: DeviceGrant;
  let accessToken = '';

  // ── 1 — the entrance ──────────────────────────────────────────────────────
  await chapter('Find the CLI in account settings', async () => {
    await openApiTokensPane(page);
    await beat();

    // The panel is the ONLY place in the product that says the CLI exists, and
    // it reads BEFORE the tokens card — a first-time user has no tokens, so a
    // panel below the fold would walk them into minting a secret by hand.
    await expect(page.getByRole('heading', { name: 'Connect the CLI' })).toBeVisible();
    // The install snippet, by its exact text (it appears once). The sign-in
    // snippet is asserted through the CLIPBOARD below instead of by text —
    // `motir login` is also named inside the panel's two explanatory
    // paragraphs, so a text match here would be ambiguous rather than wrong.
    await expect(page.getByText('npm install -g @motir/cli')).toBeVisible();
    await beat();

    // Copy the sign-in snippet the way a person would, and assert what actually
    // landed on the clipboard — the copy affordance is the panel's whole job.
    await page.getByRole('button', { name: 'Copy sign-in command' }).click();
    await expect(page.getByText('Copied', { exact: true })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe('motir login');
    await beat();
  });

  // ── 2 — the terminal blocks ───────────────────────────────────────────────
  await chapter('Run motir login — the terminal waits', async () => {
    // The terminal half, over the real route, with NO session cookie.
    grant = await startGrant(terminal, TERMINAL_HOSTNAME);
    expect(grant.userCode).toHaveLength(8);
    expect(grant.verificationUriComplete).toContain(`/device?user_code=${grant.userCode}`);

    // It is genuinely blocked: nothing is granted until a human approves.
    const pending = await pollOnce(terminal, grant);
    expect(pending).toEqual({ kind: 'error', error: 'authorization_pending' });

    // This chapter happens entirely OFF-SCREEN — the terminal is not a browser
    // surface, so there is nothing for the camera to show but the pane the
    // reader is still on. The beat buys it enough screen time to register as a
    // step rather than a stutter between two visible ones.
    await beat();
  });

  // ── 3 — the code arrives pre-filled ───────────────────────────────────────
  await chapter('Open the link the CLI printed', async () => {
    await page.goto(grant.verificationUriComplete);
    // Pre-filled from the URL, in the grouped display form — the state the
    // design draws separately from the hand-typed variant (Panels 1 + 2).
    await expect(codeField(page)).toHaveValue(formatUserCode(grant.userCode));
    await expect(page.getByText('Filled in from the link your terminal opened.')).toBeVisible();
    await beat();

    await advanceToConfirm(page, grant);
    await beat();
  });

  // ── 4 — the four facts, then approve ──────────────────────────────────────
  await chapter('Check what is connecting, and approve it', async () => {
    // The phishing defence: WHO, WHAT, WHICH workspace, WHAT scopes. The
    // hostname is the terminal's own, carried from `start`.
    await expect(page.getByText(`Motir CLI on ${TERMINAL_HOSTNAME}`)).toBeVisible();
    await expect(page.getByText(seed.email).first()).toBeVisible();
    await beat();

    // A multi-workspace account, so the picker is rendered — and the workspace
    // chosen here is NOT the one the user is signed in to, which is what makes
    // the binding assertion later mean something.
    const picker = page.getByRole('combobox', { name: 'Workspace this terminal can see' });
    await expect(picker).toBeVisible();
    await picker.click();
    await page.getByRole('option', { name: seed.targetWorkspaceLabel }).click();
    await beat();

    const approved = page.waitForResponse(
      (r) => r.url().includes('/api/cli/device/approve') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Approve and connect' }).click();
    expect((await approved).status()).toBe(200);

    await expect(page.getByRole('heading', { name: 'Terminal connected' })).toBeVisible();
    // It names the workspace it bound to — the one just PICKED, by its full
    // `org · workspace` label, so "it connected to the right place" is what the
    // reader is shown rather than something they have to infer.
    await expect(page.getByText(seed.targetWorkspaceLabel).first()).toBeVisible();
    await beat();
  });

  // ── 5 — the terminal is unblocked, with a credential that works ───────────
  await chapter('The terminal is connected', async () => {
    const resolved = await pollUntilResolved(terminal, grant);
    expect(resolved.kind, 'the poll returns a token once the human approves').toBe('granted');
    if (resolved.kind !== 'granted') return;
    accessToken = resolved.accessToken;

    // A Motir PAT, bound to the workspace the human PICKED (not their active
    // one), carrying exactly the scopes the approval screen showed.
    expect(accessToken.startsWith('motir_pat_')).toBe(true);
    expect(resolved.workspace.id).toBe(seed.targetWorkspaceId);
    expect(resolved.scope.split(' ').sort()).toEqual([...CLI_TOKEN_SCOPES].sort());

    // And it is a working credential, not just a string: a real MCP session.
    expect(await mcpBearerWorks(accessToken), 'the granted bearer authenticates').toBe(true);
    await beat();
  });

  // ── 6 — the token is listed, and revoking it disconnects ──────────────────
  await chapter('Revoke it, and the terminal is disconnected', async () => {
    await openApiTokensPane(page);
    // The tie the panel promises: the approved terminal appears in the table
    // below, under the label the mint derived from its hostname.
    const row = tokenRow(page, CLI_TOKEN_LABEL);
    await expect(row).toBeVisible();
    await beat();

    await row.getByRole('button', { name: `Revoke token ${CLI_TOKEN_LABEL}` }).click();
    const dialog = page.getByRole('dialog');
    const revoked = page.waitForResponse(
      (r) => /\/api\/me\/api-tokens\/[^/]+$/.test(r.url()) && r.request().method() === 'DELETE',
    );
    await dialog.getByRole('button', { name: 'Revoke token', exact: true }).click();
    expect((await revoked).status()).toBe(200);
    await expect(tokenRow(page, CLI_TOKEN_LABEL).getByText('Revoked')).toBeVisible();
    await beat();

    // THE SAME bearer that just worked now does not. This is the assertion the
    // panel's "revoking it there disconnects that terminal" line is a promise
    // about, and it is only real because the token above was proven live first.
    expect(await mcpBearerWorks(accessToken), 'a revoked bearer is refused').toBe(false);
    await beat();
  });

  await terminal.dispose();
});

// ── The states the happy path skips ──────────────────────────────────────────

test('signed-out arrival — the code survives the sign-in round trip', async ({ page }) => {
  const seed = await seedCliConnect(`cli-connect-signedout-${Date.now()}@example.com`);
  const terminal = await terminalContext();
  const grant = await startGrant(terminal, TERMINAL_HOSTNAME);

  // The COMMON real case: `motir login` opens a browser with no Motir session.
  await page.goto(grant.verificationUriComplete);
  await expect(page.getByRole('heading', { name: 'Sign in to connect the CLI' })).toBeVisible();
  // It names what is waiting rather than dropping it — a state, not a redirect.
  await expect(page.getByText(formatUserCode(grant.userCode)).first()).toBeVisible();

  await page.getByRole('link', { name: 'Sign in to continue' }).click();
  await signInReturningToDevice(page, seed, grant.userCode);

  // Back on `/device`, with the SAME code still in hand — not an empty field.
  await expect(page.getByRole('heading', { name: 'Connect the Motir CLI' })).toBeVisible();
  await expect(codeField(page)).toHaveValue(formatUserCode(grant.userCode));
  await advanceToConfirm(page, grant);

  await terminal.dispose();
});

test('deny — nothing is connected, and the terminal is told', async ({ page }) => {
  const seed = await seedCliConnect(`cli-connect-deny-${Date.now()}@example.com`);
  const terminal = await terminalContext();
  const grant = await startGrant(terminal, TERMINAL_HOSTNAME);

  await signIn(page, seed.email, seed.password);
  await page.goto(grant.verificationUriComplete);
  await advanceToConfirm(page, grant);

  const denied = page.waitForResponse(
    (r) => r.url().includes('/api/auth/device/deny') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Deny' }).click();
  expect((await denied).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Request denied' })).toBeVisible();

  // The CLI side gets the RFC's own code…
  const resolved = await pollOnce(terminal, grant);
  expect(resolved).toEqual({ kind: 'error', error: 'access_denied' });
  // …and no token was minted for this user, anywhere.
  expect(await db.apiToken.count({ where: { userId: seed.userId } })).toBe(0);

  await terminal.dispose();
});

test('expired and unknown codes — each says so, and each offers a way forward', async ({
  page,
}) => {
  const seed = await seedCliConnect(`cli-connect-expired-${Date.now()}@example.com`);
  const terminal = await terminalContext();
  const grant = await startGrant(terminal, TERMINAL_HOSTNAME);

  await signIn(page, seed.email, seed.password);

  // EXPIRED — a real grant aged past its 15-minute window.
  await expireGrant(grant.userCode);
  await page.goto(grant.verificationUriComplete);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'That code has expired' })).toBeVisible();
  // The forward path out of a terminal state — a dead end would strand the CLI.
  await expect(page.getByRole('button', { name: 'Enter a new code' })).toBeVisible();

  // The terminal learns the same thing from its own poll.
  expect(await pollOnce(terminal, grant)).toEqual({ kind: 'error', error: 'expired_token' });

  // UNKNOWN — a code that never existed keeps the field, so a typo is one edit
  // away (design Panel 7: one screen, two copies).
  await page.getByRole('button', { name: 'Enter a new code' }).click();
  await codeField(page).fill('ZZZZ-ZZZZ');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'We don’t recognise that code' })).toBeVisible();
  await expect(codeField(page)).toBeVisible();

  await terminal.dispose();
});

test('the confirm screen reports that it is checking, while the code is being resolved', async ({
  page,
}) => {
  const seed = await seedCliConnect(`cli-connect-loading-${Date.now()}@example.com`);
  const terminal = await terminalContext();
  const grant = await startGrant(terminal, TERMINAL_HOSTNAME);

  await signIn(page, seed.email, seed.password);

  // HOLD the grant read open, so the in-flight state is observable rather than
  // raced for. The request is released by this test, not by a timer, and it is
  // fulfilled by the REAL route — the only thing stubbed is WHEN the response is
  // allowed to continue.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/cli/device/grant**', async (route) => {
    await held;
    await route.continue();
  });

  await page.goto(grant.verificationUriComplete);
  await page.getByRole('button', { name: 'Continue' }).click();

  // The button reports the work in progress and refuses a second submit.
  const checking = page.getByRole('button', { name: 'Checking that code…' });
  await expect(checking).toBeVisible();
  await expect(checking).toBeDisabled();

  release();
  await expect(page.getByRole('heading', { name: 'Connect this terminal?' })).toBeVisible();

  await terminal.dispose();
});
