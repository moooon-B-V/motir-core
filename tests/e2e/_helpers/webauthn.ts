import type { BrowserContext, CDPSession, Page } from '@playwright/test';

// A CDP VIRTUAL AUTHENTICATOR — the harness that lets a spec complete a real
// WebAuthn ceremony (Story 8.12 · Subtask MOTIR-3615).
//
// ── WHY THIS FILE HAD TO BE WRITTEN ───────────────────────────────────────
// Nothing in this repository had ever driven WebAuthn before this story:
// `git grep -l 'newCDPSession\|CDPSession' -- tests/` returned nothing. There is
// no real fingerprint reader on a CI runner, so the browser has to be given a
// FAKE authenticator it fully controls — which Chrome exposes over the DevTools
// Protocol's `WebAuthn` domain and Playwright reaches with
// `context.newCDPSession(page)`.
//
// ── ⚠️ CHROMIUM ONLY, AND THAT IS SAFE HERE ───────────────────────────────
// CDP is a Chromium protocol; there is no Firefox or WebKit equivalent, so a
// spec using this helper cannot run on those engines. `playwright.config.ts`'s
// `projects` array has exactly ONE entry (`chromium`), so nothing in this repo
// can strand such a spec on an engine it cannot use. If a second project is ever
// added, every spec importing this file needs a `browserName` guard.
//
// ── ⚠️ THE OPTIONS ARE NOT DEFAULTS — TWO OF THEM ARE LOAD-BEARING ────────
// `lib/auth/index.ts` registers the passkey plugin with
// `authenticatorSelection.userVerification: 'required'` (MOTIR-3610), because
// that is what makes a passkey multi-factor on its own. An authenticator that
// cannot verify the user is therefore REFUSED rather than merely degraded, so:
//
//   * `hasUserVerification: true`  — the authenticator is CAPABLE of it, and
//   * `isUserVerified: true`       — it currently reports the user AS verified.
//
// Both are required. Setting only the first produces assertions with the UV flag
// clear, which the server rejects — and the failure reads as "the passkey did
// not work" rather than as a misconfigured fixture.
//
// `hasResidentKey: true` is what makes the credential DISCOVERABLE, which is
// what the sign-in path depends on: the reader clicks "Sign in with a passkey"
// with the email field EMPTY, so the browser has to be able to offer the account
// without being told which one to look for.
//
// ── THE ORIGIN CHECK PASSES BECAUSE THE LANE SAYS WHERE IT IS ─────────────
// WebAuthn refuses an assertion whose origin does not match the relying party.
// `playwright.config.ts` sets `MOTIR_BASE_URL: BASE_URL` on the webServer, so
// `lib/baseUrl.ts` resolves the lane's OWN origin and the plugin's `rpID` /
// `origin` follow the port the browser is actually on — including a custom
// `E2E_BASE_URL`. Without that env the ceremony would fail on origin, and the
// error would point at the passkey code rather than at the lane.

/** A live virtual authenticator, and the way to take it away again. */
export interface VirtualAuthenticator {
  /** The CDP id, for the state-changing commands below. */
  authenticatorId: string;
  /**
   * Report the user as verified or not.
   *
   * Flipping this to `false` is how a spec drives the REFUSAL arm for real: the
   * ceremony still completes in the browser, and the SERVER rejects the
   * assertion because user verification was required and not performed.
   */
  setUserVerified(isUserVerified: boolean): Promise<void>;
  /** How many credentials the authenticator currently holds. */
  credentialCount(): Promise<number>;
  /**
   * Remove the authenticator.
   *
   * ⚠️ CALL IT IN TEARDOWN. A virtual authenticator lives on its BrowserContext,
   * and Playwright reuses a context across tests in a file — so a credential
   * registered by one test would still be offerable to the next, and a spec
   * asserting a zero state would pass or fail depending on what ran before it.
   */
  remove(): Promise<void>;
}

/**
 * Attach a virtual platform authenticator to `page`'s context.
 *
 * Defaults describe a modern platform authenticator — a laptop's fingerprint
 * reader — because that is the device the story's copy talks about and the one
 * whose credentials are synced (`deviceType: 'multiDevice'`).
 */
export async function addVirtualAuthenticator(
  context: BrowserContext,
  page: Page,
): Promise<VirtualAuthenticator> {
  const cdp: CDPSession = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');

  const { authenticatorId } = (await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasUserVerification: true,
      hasResidentKey: true,
      isUserVerified: true,
      // Answer the "touch your key" prompt without a human. Without it every
      // ceremony hangs until the spec times out, which reads as a product bug.
      automaticPresenceSimulation: true,
    },
  })) as { authenticatorId: string };

  return {
    authenticatorId,
    async setUserVerified(isUserVerified: boolean) {
      await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified });
    },
    async credentialCount() {
      const { credentials } = (await cdp.send('WebAuthn.getCredentials', {
        authenticatorId,
      })) as { credentials: unknown[] };
      return credentials.length;
    },
    async remove() {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
      await cdp.detach();
    },
  };
}
