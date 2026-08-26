'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Fingerprint } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { signIn } from '@/lib/auth/client';

/**
 * "Sign in with a passkey" — the sign-in card's passwordless route (Story 8.12 ·
 * Subtask MOTIR-3613), built to `design/auth/passkey-sign-in.mock.html`.
 *
 * ── ⚠️ IT LIVES ON THE EMAIL STEP, AND IT SKIPS THE OTHER TWO ─────────────
 * `SignInCard` is a three-state machine (`'email' | 'password' | 'twoFactor'`)
 * and this control short-circuits all of it. `signIn.passkey()` runs
 * generate-authenticate-options → the browser's assertion → verify-authentication,
 * and **that last call mints a session directly** (its error set carries
 * `UNABLE_TO_CREATE_SESSION`). It never answers `{ twoFactorRedirect: true }`, so
 * `setStep('twoFactor')` is unreachable from here and `TwoFactorChallenge` is
 * never rendered on this path.
 *
 * **DO NOT ADD A SECOND-FACTOR CHECK AFTER THIS.** The surrounding file is
 * entirely about a flow that asks for a password and then asks for a code, so the
 * next reader will assume symmetry — and MOTIR-3610 pins
 * `userVerification: 'required'`, which means the assertion already proved
 * possession of the device AND the person (NIST SP 800-63B). A code after it
 * would be asking for a third factor from someone who just supplied two.
 *
 * ── PEER OF THE GOOGLE BUTTON, NOT A NEW SPECIES ──────────────────────────
 * Same primitive, same size, same width — `Button variant="secondary"
 * size="lg"`, full width — because they are the two ways in that need nothing
 * typed. The design puts this directly under it and above the OR rule for that
 * reason: everything above the rule signs you in without a keyboard.
 *
 * ── NOT GATED ON THE EMAIL FIELD ──────────────────────────────────────────
 * A discoverable credential (`residentKey: 'preferred'`, MOTIR-3610) lets the
 * browser offer the accounts it holds without being told which one to look for,
 * and that is the whole reason this feels better than a password. The
 * surrounding form's habit is to gate on a filled email; this control must not.
 */
export function PasskeySignInButton({
  callbackURL,
  onError,
}: {
  /**
   * Where a successful sign-in lands — the value `SignInCard` already computed
   * with `resolvePostAuthDestination`. Passed in rather than re-derived: a
   * second answer to "where does sign-in land?" is exactly what
   * `lib/navigation/landing.ts` exists to prevent.
   */
  callbackURL: string;
  /** Raise a refusal onto the card's shared alert, or clear it with `''`. */
  onError: (message: string) => void;
}) {
  const t = useTranslations('auth');
  const [pending, setPending] = useState(false);

  async function go() {
    // The guard is the pending flag, not a disabled attribute: the button has to
    // stay focusable while the browser's sheet is open so focus returns to it
    // when the reader dismisses it.
    if (pending) return;
    setPending(true);
    onError('');
    try {
      const result = await signIn.passkey();
      const code = errorCode(result?.error);
      if (code !== undefined || result?.error) {
        // ⚠️ A DISMISSED SHEET DRAWS NOTHING. The reader changed their mind about
        // an unfamiliar prompt, which is a decision rather than a failure — and a
        // sign-in screen that turns red at it teaches people not to try again.
        // There is deliberately no i18n key for this case.
        if (code === 'AUTH_CANCELLED' || code === 'ERROR_CEREMONY_ABORTED') return;
        onError(
          code === 'CHALLENGE_NOT_FOUND' ? t('passkey.challengeExpired') : t('passkey.noMatch'),
        );
        return;
      }
      // A FULL document load, not `router.push`. The password path never
      // navigates from here — Better-Auth's redirect plugin has already started
      // one — but the passkey ceremony returns a session and no redirect, so the
      // navigation is ours. A document load is what makes the new cookie visible
      // to the server components on the other side.
      window.location.assign(callbackURL);
    } catch {
      onError(t('passkey.noMatch'));
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      variant="secondary"
      size="lg"
      className="w-full"
      loading={pending}
      onClick={() => void go()}
    >
      {pending ? (
        t('passkey.waiting')
      ) : (
        <span className="inline-flex items-center gap-2">
          <Fingerprint className="h-5 w-5" aria-hidden />
          <span>{t('passkey.signIn')}</span>
        </span>
      )}
    </Button>
  );
}

/**
 * The `code` off whatever the client handed back, or `undefined`.
 *
 * ⚠️ TWO CODE SPACES REACH THIS. A failure inside the browser ceremony is
 * surfaced with SimpleWebAuthn's `WebAuthnError.code` (`ERROR_CEREMONY_ABORTED`);
 * a failure from the server carries the plugin's own key (`AUTH_CANCELLED`,
 * `CHALLENGE_NOT_FOUND`, `PASSKEY_NOT_FOUND`). Reading only the documented set is
 * how a dismissed sheet ends up rendering an error banner. The union also has an
 * arm with no code at all — a plain transport failure — which falls through to
 * the no-match copy, because from where the reader stands the outcome is the
 * same: this did not sign them in, and the password is the way through.
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
