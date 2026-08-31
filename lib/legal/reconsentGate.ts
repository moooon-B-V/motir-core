import { headers } from 'next/headers';
import { isCloud } from '@/lib/billing/availability';
import { sanitizeNextPath } from '@/lib/navigation/nextDestination';
import { legalAcceptanceService } from '@/lib/services/legalAcceptanceService';

// THE RE-CONSENT GATE (Story 8.4 · Subtask MOTIR-1135 · design
// `design/auth/legal-agreement.mock.html`, panel 5).
//
// A signed-in person whose accepted version of the Terms, the Privacy Policy or
// the Acceptable Use Policy is materially behind what is published is held at
// `/re-consent` until they say yes — because `content/legal/terms.md` §14
// promises outright that we *"will not treat silence as agreement to a material
// change"*, and carrying on into the product IS silence.
//
// ── ⚠️ HOW THIS COMPOSES, AND WHY IT IS TWO FUNCTIONS ───────────────────────
// The gate is split into a RESOLVE (which reads) and an ENFORCE (which
// redirects) rather than being one call that throws, and that split is the
// recorded answer to a design flag, not a style choice:
//
//   *"Two gates will want the same slot. Both this and 2FA-required hold an
//    authenticated reader at the app's front door, in the same `(auth)` frame, on
//    the same redirect. Order them once, deliberately — the recommendation is 2FA
//    first (it is about who is signing in) and re-consent second (it is about what
//    they are agreeing to). That ordering is a decision MOTIR-1135 should record,
//    not discover."* (`design/auth/design-notes.md`, planning flag 4)
//
// **THE ORDERING, RECORDED: 2FA FIRST, RE-CONSENT SECOND.** The split is what
// makes it hold without this file knowing anything about 2FA. The RESOLVE joins
// the layout's existing concurrent wave, so it costs no extra round trip; the
// ENFORCE runs AFTER the wave has settled. A gate that throws Next's redirect
// sentinel from INSIDE the wave therefore wins by construction — the rejection
// propagates out of the `Promise.all` before the enforce line is ever reached —
// and that is precisely the shape Story MOTIR-1215's 2FA gate takes. Two gates
// that both threw from inside one `Promise.all` would race, and the loser's
// screen would be reached by whichever promise happened to settle first.
//
// So: when MOTIR-1215 lands, nothing here changes and nothing there changes. If
// a THIRD hold is ever added, it joins this pattern — resolve in the wave,
// enforce after it, in a written order — rather than inventing a fourth.

/**
 * The screen a held visitor is sent to. It lives in the `(auth)` route group,
 * NOT in `(authed)`, so the gate can never redirect a reader into itself.
 */
export const RECONSENT_PATH = '/re-consent';

/**
 * The path the request asked for, forwarded from the edge by `proxy.ts`.
 *
 * ⚠️ ADVISORY, ABSENT OFF-MATCHER, AND FORGEABLE — every consumer must treat it
 * so, and this one does: the value goes through `sanitizeNextPath`, the shipped
 * same-origin validator (MOTIR-3372), before it is ever put in a URL. An
 * unvalidated redirect target taken from a request header is an open redirect,
 * and it is the one way this gate could ship a vulnerability.
 *
 * ⚠️ THE HEADER IS NOT SET ON `main` YET, and this file is written to be correct
 * either way. `proxy.ts` gains it in **MOTIR-3652**, under Story MOTIR-1215,
 * which is `implemented` and unmerged as this card ships. Until it lands the
 * header is simply absent, `sanitizeNextPath` answers `null`, and a held reader
 * is returned to the signed-in landing instead of to the page they asked for —
 * the degraded arm the header's own contract already requires for every path off
 * the matcher. Nothing here defines or sets the header: this is a CONSUMER, so
 * the two cards can merge in either order without either rebuilding the other's
 * half. `design/auth/design-notes.md` planning flag 3 anticipates exactly this
 * (*"If the 2FA gate ships first, reuse it; if this one does, expect the other
 * to"*).
 *
 * When MOTIR-3652 merges, replace the literal below with its exported
 * `CURRENT_PATH_HEADER` constant so there is one spelling of the name.
 */
const CURRENT_PATH_HEADER = 'x-current-path';

/**
 * True only on a Motir cloud build.
 *
 * ⚠️ A SELF-HOSTER IS NEVER HELD, and that is the card's own acceptance
 * criterion (*"gating keys off the cloud document version — self-hosters set
 * their own"*). `content/legal/` ships as moooon B.V.'s copy of OUR terms for
 * the hosted service; a self-hoster is their own controller and their own
 * counterparty, so holding their users at a screen asking them to accept our
 * Terms would be both wrong and unclearable. `/legal` still renders for them —
 * it describes our service, which is what its own index copy already says.
 *
 * Deliberately NOT `isCloudBilling()`: that function answers *"does this build
 * have a commercial layer?"*, this one answers *"is moooon B.V. the counterparty
 * to these documents?"*, and the two are the same flag today for a reason that
 * is a coincidence of deployment rather than a fact about either question. That
 * distinction is ADR `docs/decisions/billing-tiering.md` §6's, and it is kept.
 *
 * ⚠️ What CHANGED (MOTIR-4033): the distinction is a NAME, not a second read of
 * the environment. This wrapper used to inline
 * `process.env['MOTIR_CLOUD'] === 'true'`, which made it the tree's second
 * reader of the flag — so a build that later decides `MOTIR_CLOUD` is not the
 * whole answer would have had to be found here, by grep, by whoever thought to
 * look. It now delegates to `isCloud()`, the cloud-vs-self-host predicate that
 * exists for exactly this class of question, and keeps its own name and its own
 * paragraph explaining what it is asking.
 * `tests/hosting/cloudBuildFlag.test.ts` holds the single-reader rule.
 */
function isMotirCloud(): boolean {
  return isCloud();
}

/** What the gate learned. `null` means nobody is held — the common answer. */
export interface ReconsentVerdict {
  /** Where to send the reader, already sanitized and ready to `redirect()`. */
  destination: string;
}

/**
 * THE RESOLVE HALF — read-only, safe to run as one arm of a layout's existing
 * `Promise.all`. Returns `null` when the reader may carry on.
 *
 * Never throws for a reason the reader caused: a failure to read the acceptance
 * table answers `null` (carry on) rather than holding the whole signed-in
 * product on a database hiccup. The record is still owed, and the next page load
 * asks again — which is the same self-healing arm the sign-up hook relies on.
 */
export async function resolveReconsentHold(userId: string): Promise<ReconsentVerdict | null> {
  if (!isMotirCloud()) return null;

  let outstanding;
  try {
    outstanding = await legalAcceptanceService.resolveOutstanding(userId);
  } catch (err) {
    console.error(
      `[legal] re-consent check failed for user ${userId}; letting the request through. ` +
        `The next page load will ask again.`,
      err,
    );
    return null;
  }
  if (outstanding.length === 0) return null;

  const currentPath = sanitizeNextPath((await headers()).get(CURRENT_PATH_HEADER) ?? undefined);
  const destination = currentPath
    ? `${RECONSENT_PATH}?next=${encodeURIComponent(currentPath)}`
    : RECONSENT_PATH;
  return { destination };
}
