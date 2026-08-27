import { accountDeletionService } from '@/lib/services/accountDeletionService';

/**
 * The SIGN-IN half of an account deletion (Story 8.4 · Subtask MOTIR-3700).
 *
 * `accountDeletionService.scheduleAccountDeletion` closes the account and signs
 * every device out; the erasure itself runs 30 days later (MOTIR-3702). This is
 * the way back — and the reason the window exists at all.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ WHY SIGNING IN IS THE CANCEL, RATHER THAN A BUTTON SOMEWHERE
 * ---------------------------------------------------------------------------
 * `docs/decisions/code-graph-index-fleet.md` §14.3 refuses a grace period for a
 * workspace hard-delete and says why: *"A grace period the user cannot reach is
 * not a grace period."* Deleting a workspace cascades away every surface a user
 * could have undone into, so a window there would only extend retention.
 *
 * An account deletion is the MIRROR of that case. The reader's own credentials
 * survive the whole window, so signing in IS a surface to undo into — it is the
 * one affordance that is reachable by construction, needs no navigation, and is
 * the very thing a person who has changed their mind on day nine will actually
 * do. Design DECISION 4 (`design/settings/design-notes.md` → `Data & privacy`)
 * makes it a requirement rather than a nicety for exactly that reason: *"a
 * reader who changes their mind on day nine will not think to navigate to
 * Settings › Data & privacy"*. The two DRAWN doors — the pane and the app-wide
 * banner (MOTIR-3704) — are the deliberate, explicit ones; this is the one
 * nobody has to find.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ WHY IT HANGS OFF `session.create.after` AND NOT OFF A SIGN-IN ENDPOINT
 * ---------------------------------------------------------------------------
 * The same argument `accountSuspension.ts` makes one hook over, and it is the
 * same list: Motir has more than one way in — email + password, Google, the
 * two-factor challenge, and the RFC 8628 device grant behind `motir login` —
 * and none of them shares an endpoint with the others. A cancel wired onto
 * `signInEmail` would leave a scheduled deletion standing for somebody who came
 * back through Google, and their account would be erased on day 30 after they
 * had signed in and seen it working. `session.create` is the ONE seam they all
 * funnel through, so a route added tomorrow inherits the cancel instead of
 * needing to remember it.
 *
 * `after` rather than `before`, unlike the suspension guard: the suspension has
 * to REFUSE the session, so it must run before the insert. This one is a
 * consequence of a sign-in that has SUCCEEDED, and a session row existing is
 * what "succeeded" means. Cancelling in `before` would take a deletion back for
 * an attempt that then failed its own insert.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ AND IT IS BEST-EFFORT, LIKE EVERY OTHER POST-COMMIT HOOK IN `lib/auth`
 * ---------------------------------------------------------------------------
 * Better-Auth runs `create.after` once the session is durable, so a throw here
 * cannot un-create it — it would only turn a successful sign-in into a 500 for
 * a person who is, at that moment, trying to rescue their account. The failure
 * degrades to one extra screen rather than to a lost account: the reader is
 * signed in, the deletion is still `scheduled`, and MOTIR-3704's app-wide
 * banner is on every page they land on with a `Cancel deletion` action on it.
 * Same posture, and the same reasoning, as the legal-acceptance and
 * default-workspace hooks in `lib/auth/index.ts`.
 */
export async function cancelDeletionOnSignIn(userId: string): Promise<void> {
  try {
    // Nothing is logged on the happy path, and nothing needs to be: the
    // cancelled request is the record, with `cancelledAt` stamped on it. Almost
    // every sign-in reaches this line with nothing scheduled, which is why the
    // service's `…IfScheduled` variant RETURNS rather than throws — a hook that
    // raised and swallowed an error on every successful login would bury the one
    // occurrence below that means something.
    await accountDeletionService.cancelAccountDeletionIfScheduled(userId);
  } catch (err) {
    console.error(
      `[auth] could not cancel the scheduled deletion for user ${userId} on sign-in; ` +
        `the account-deletion banner still offers Cancel deletion on every page.`,
      err,
    );
  }
}
