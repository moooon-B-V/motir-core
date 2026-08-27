import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp, startSignedOut } from './_helpers/shell-session';
import { addVirtualAuthenticator } from './_helpers/webauthn';

// ACCEPTANCE — sign in with your fingerprint instead of a password
// (Story 8.12 · MOTIR-1214 · Subtask MOTIR-3616). The story's own
// `verification_recipe`, driven the way a person drives it, and recorded as the
// receipt Yue watches to accept the story.
//
// ⚠️ THIS IS THE RECEIPT LANE, NOT THE MERGE GATE. The regression spec is
// `passkeys.spec.ts` on the main lane, running on every pull request at machine
// speed; this file runs under `playwright.acceptance.config.ts`, on its own port,
// with `video: 'on'`, on a `paths:`-filtered workflow. The FILENAME is what
// routes it: `acceptance*` is this lane's `testMatch` and the main config's
// `testIgnore`, so renaming this file would put the receipt in the merge gate and
// the gate in the receipt lane. Neither file edits the other.
//
// ── WHAT THE CLIP HAS TO SHOW, and why the pacing is load-bearing ─────────
// Passkeys are the one feature in this story a reviewer cannot simply try:
// registering one binds it to their own laptop and their own fingerprint, and
// checking the sign-in half means deliberately signing out of their own account.
// So the recording is not a formality here — it is the only practical way to see
// the whole thing work.
//
// And ONE claim in this story is invisible everywhere except on screen: that a
// passkey COUNTS as protecting the account, which is what Story 8.13 will read
// when it starts requiring a second factor. In the code it is a value crossing
// between two functions. On screen it is a row appearing on the card below,
// the moment the passkey is registered, with no reload — and two seconds of
// video explains it completely. That is chapter 3, and it gets its own chapter
// for exactly that reason.
//
// ── THE HOLDS DO NOT WEAKEN THE `waitForTimeout` BAN ──────────────────────
// Every hold this lane takes sits AFTER the assertion that already proved the
// state — see `_helpers/acceptance-video.ts`'s pacing section. Delete every hold
// and the assertions below are unchanged; a hold can never stand in for a wait.
// Driven at machine speed this whole walk finishes in about four seconds with all
// five chapters stacked inside the first one: a technically-passing file that
// shows a reviewer nothing.
//
// ── THE ORIGIN CHECK HOLDS HERE TOO ───────────────────────────────────────
// `playwright.acceptance.config.ts` sets `MOTIR_BASE_URL: BASE_URL` on its
// webServer, so `lib/baseUrl.ts` resolves THIS lane's port and the plugin's
// `rpID` / `origin` follow it. The virtual-authenticator harness is MOTIR-3615's
// (`./_helpers/webauthn.ts`), imported rather than copied.

test.describe.configure({ timeout: 240_000 });

const EMAIL = 'acceptance-passkey@example.com';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('register a passkey, then sign in with no password at all', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // ⚠️ WITHOUT THIS THE CLIP HAS NOWHERE TO GO. The uploader reads the
  // `acceptance-story.json` sidecar this writes as its top-precedence target;
  // the story key in the header above is prose, and the uploader reads the
  // fixture, not the prose. `tests/e2e-acceptance-lane-membership.test.ts`
  // fails the whole lane over its absence — a spec that can never publish a
  // receipt is in the receipt lane for no reason it can serve.
  acceptanceStory('MOTIR-1214');

  const authenticator = await addVirtualAuthenticator(page.context(), page);

  try {
    // Off camera: an ordinary account, created the ordinary way. The story
    // starts at the Security pane.
    await signUp(page, EMAIL);

    await chapter('No passkeys yet', async () => {
      await page.goto('/settings/account/security');
      await expect(page.getByRole('heading', { name: 'Passkeys', exact: true })).toBeVisible();
      // The empty state spends its words on what a passkey IS, because most
      // readers have never knowingly used one — and this hold is what gives a
      // reviewer time to read it and judge whether it lands.
      await expect(page.getByText('No passkeys yet')).toBeVisible();
      await expect(page.getByText(/unlocks with your fingerprint/i)).toBeVisible();
      // And nothing claims a second factor yet.
      await expect(page.getByText('Counts as two factors')).toHaveCount(0);
    });

    await chapter('Adding a passkey', async () => {
      const registered = page.waitForResponse(
        (r) =>
          r.url().includes('/api/auth/passkey/verify-registration') &&
          r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Add a passkey' }).click();
      expect((await registered).status()).toBe(200);

      // The row arrives with the name the register flow proposed and the device
      // type in words — the two things that let a person tell two passkeys apart.
      //
      // ⚠️ THE PENDING STATE IS NOT ASSERTED HERE, and that is a fact about the
      // HARNESS rather than a gap in the walk. "Waiting for your browser…" is
      // the seconds while a person looks at their own fingerprint reader; a
      // virtual authenticator answers in milliseconds, so an assertion on it
      // would be a race. It is pinned by the component tests, which can hold the
      // promise open. What the clip shows is the transition either side of it.
      //
      // ⚠️ "This device only", not "Synced", and that is the AUTHENTICATOR
      // talking rather than a bug. A CDP virtual authenticator issues a
      // credential with the backup-eligible / backed-up flags clear, which
      // SimpleWebAuthn reports as `singleDevice`. A real iCloud- or
      // Google-synced passkey renders the other chip — which is what
      // `design/settings/passkeys.mock.html` draws, because that is the common
      // case for a person. Both are correct; the clip shows the one this lane
      // can actually produce.
      await expect(page.getByText('This device only')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Rename' })).toBeVisible();
    });

    await chapter('It counts as a second factor', async () => {
      // ⚠️ THE STORY'S NON-OBVIOUS CLAIM, and the reason this chapter exists.
      // The card BELOW the passkeys card gains a `Passkey` row — on the same
      // screen, with no reload — and two-factor authentication is still OFF.
      // That is what Story 8.13 will read when it decides whether this account
      // is protected, and it is invisible anywhere but here.
      const urlBefore = page.url();
      await expect(page.getByText('Counts as two factors')).toBeVisible();
      await expect(page.getByText('Managed above')).toBeVisible();
      await expect(page.getByText(/already counts as a second factor/i)).toBeVisible();
      expect(page.url()).toBe(urlBefore);

      // A BEAT, and this is the chapter that earns one. Everything above is
      // already proven by the assertions — the beat buys a reviewer the seconds
      // to read two sentences on the same screen and see that they agree: the
      // account holds a passkey, and the two-factor card below now says so while
      // two-factor authentication is still switched off. That is the claim
      // Story 8.13 will act on and the only place it is visible.
      await beat();
    });

    await chapter('Signing in without a password', async () => {
      await startSignedOut(page);
      await page.goto('/sign-in');

      // The field is left EMPTY on purpose: the browser offers the account it
      // holds, which is the whole reason this is better than typing anything.
      await expect(page.getByPlaceholder('Email address')).toHaveValue('');

      const signedIn = page.waitForResponse(
        (r) =>
          r.url().includes('/api/auth/passkey/verify-authentication') &&
          r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
      expect((await signedIn).status()).toBe(200);
      await page.waitForURL('**/home');

      // Shown by their ABSENCE, which is the point: a passkey mints the session
      // outright, so neither the password step nor the two-factor challenge is
      // ever presented on this path.
      await expect(page.getByPlaceholder('Password')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: /Two-factor|Confirm it's you/ })).toHaveCount(
        0,
      );
    });

    await chapter('Removing it', async () => {
      await page.goto('/settings/account/security');
      await page.getByRole('button', { name: 'Remove', exact: true }).click();

      // The confirmation names the consequence, because this is the last one:
      // removing it means going back to a password.
      await expect(page.getByText(/this is your last passkey/i)).toBeVisible();

      const removed = page.waitForResponse(
        (r) =>
          r.url().includes('/api/auth/passkey/delete-passkey') && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Remove passkey' }).click();
      expect((await removed).status()).toBe(200);

      // Back to the beginning — and the second-factor claim goes with it.
      await expect(page.getByText('No passkeys yet')).toBeVisible();
      await expect(page.getByText('Counts as two factors')).toHaveCount(0);
    });
  } finally {
    // The credential lives on the BrowserContext, so it outlives the test
    // without this.
    await authenticator.remove();
  }
});
