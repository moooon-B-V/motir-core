# ADR: signing in does NOT cancel a scheduled account deletion — the two drawn doors are the cancel path

- **Status.** Accepted (2026-08-28) · Story 8.4 · MOTIR-3742
- **Supersedes.** The `session.create.after` cancel hook shipped by MOTIR-3700
  (`lib/auth/accountDeletionCancellation.ts`), and the _"Signing in before then
  cancels it"_ clause of `design/settings/design-notes.md` → `Data & privacy` →
  DECISION 4.
- **Does not touch.** The 30-day window itself, the post-commit sign-out
  (`revokeEverySession`), the erasure sweep (MOTIR-3702), or either cancel
  surface (MOTIR-3704). Those all stand; what changes is which of them a reader
  actually reaches.

## Context — two shipped behaviours that compose into no flow

Both were deliberate, both were argued in prose, and each is pinned by a green
test in `tests/account-deletion-schedule.test.ts`:

1. **Scheduling signs the reader out of everything.**
   `accountDeletionService.scheduleAccountDeletion` calls `revokeEverySession`
   after the commit, so the request that confirms the deletion is the last one
   that session serves; the next navigation is redirected to `/sign-in` by
   `app/(authed)/layout.tsx`.
2. **The next sign-in cancelled the deletion, before any page rendered.**
   `cancelDeletionOnSignIn` hung off Better-Auth's `session.create.after`.

**Compose them and the steady state disappears.** A signed-in reader holding an
open `scheduled` request existed in exactly ONE situation: when
`cancelDeletionOnSignIn`'s `catch` arm had fired — i.e. when the cancel itself
had failed. That module's own comment said so, and named MOTIR-3704's app-wide
banner as the thing that rescues it. **That is a correct fallback and it is not a
flow.** Panel 5 of `design/settings/account-data.mock.html` — a signed-in shell,
a countdown, a scheduled card and a banner with `Cancel deletion` on it — drew a
state the product reached only after an error.

DECISION 4 therefore held two claims that cannot both be right:

- _"Signing in before then cancels it."_
- _"A grace period is only reachable if the reader can find it… A reader who
  changes their mind on day nine will not think to navigate to Settings › Data &
  privacy to do it"_ — which is the entire warrant for the app-wide banner.

If signing in cancels, **the day-nine reader the banner exists for never sees a
banner.**

**And the auto-cancel carried a second defect of its own.** Somebody who has
decided to leave, and signs in once before the erasure, silently lost their
deletion. Nothing told them. They would discover it on day 31, with the account
still there. This is not hypothetical inside this very story: MOTIR-3703 delivers
the personal-data export through an **authenticated** download route, and
MOTIR-3732 established that the erasure deletes that export — so the documented
sequence _export → schedule deletion → sign in to download the file before it
goes_ revoked the deletion as a side effect of the reader collecting their own
data.

## Decision

**`cancelDeletionOnSignIn` is removed, and with it the `session.create.after`
hook.** Signing in during the grace window opens an ordinary session and leaves
the request `scheduled`. The reader lands on a page carrying MOTIR-3704's
app-wide banner, and cancels — from that banner or from the pane — by pressing
`Cancel deletion`. Cancelling becomes the deliberate act the design draws, and
panel 5 becomes the primary path rather than an error path.

### Why (a) — remove the auto-cancel — rather than (b), correct the design to match it

The alternative was to keep the auto-cancel and re-document the two drawn doors
as a failed-cancel fallback. It was cheaper and it was rejected, on the
decision-authority ladder:

- **Rung 1, the mirror products, split — and they split on the KIND of flow.**
  Where signing in silently reverses a pending deletion, the flow is a
  _deactivation_: the account is hidden and coming back IS the intent signal.
  Where the flow is an explicit erasure request behind a typed confirmation — a
  ledger of what is deleted, a sole-owner block, a published erasure deadline —
  the cancel is an explicit act and returning does not revoke it. Motir's flow is
  the second kind in every particular, so rung 1 answers (a).
- **Rung 2, the shipped code, answers (a) too.** MOTIR-3704 built the pane's
  scheduled state and the app-wide banner, and they are on `main`. (b) would
  leave both reachable only through a `catch` arm — deliberately-built surfaces
  demoted to error handling — while (a) makes them the path they were drawn as.
- **(b) leaves DECISION 4's day-nine argument, which is the banner's entire
  warrant, without a case.** It would have to be deleted rather than restated,
  and the §14.3 doctrine the whole window rests on (_"a grace period the user
  cannot reach is not a grace period"_) would then argue against the window.
- **The stated cost of (a) turned out not to exist.** The card noted that
  `content/legal/privacy.md` must be re-read for whether it promises the
  auto-cancel. It does not: §6's only claim is _"After you delete it, we erase or
  anonymise within **30 days**"_, which (a) leaves exactly true. **No legal copy
  changes.** The residual cost is one click, which is the point rather than the
  price.

### What replaces the placement argument

`accountDeletionCancellation.ts` argued at length that the cancel belonged on
`session.create.after` because it is the ONE seam every sign-in path funnels
through — email + password, Google, the two-factor challenge, and the RFC 8628
device grant behind `motir login`. **That argument was sound and it is now
moot**, because there is no per-path behaviour left to place: nothing happens on
sign-in. The equivalent guarantee for the new path is that the banner is mounted
**once, in `app/(authed)/layout.tsx`** — so it is on every authed page by
construction, whichever door the reader came in through, exactly as the seam
argument wanted. `assertAccountNotSuspended` keeps `session.create.before` and is
untouched; a scheduled deletion is not a suspension and never was.

## Consequences

- **A reader who signs in during the window keeps using the product**, with the
  banner on every page until they cancel or the erasure runs. This is what panel
  5 already drew and what its own copy already said — _"Until then nothing has
  changed: you are signed in, your workspaces are open, and your team sees no
  difference."_
- **DECISION 4's "the account closes immediately… and stops being usable" is
  amended** to what actually ships: scheduling signs every device out, and the
  reader may sign back in and keep working. The account is not suspended; it is
  scheduled.
- **MOTIR-3706's journey test can now drive `schedule → cancel` through a door a
  reader can actually reach** — sign in, read the banner, press `Cancel
deletion` — instead of having to induce a failed cancel to reach the state.
- **The `catch` arm that this window's only steady state used to depend on is
  gone with the hook.** The banner is no longer a rescue from an error; it is the
  path.
- **One behaviour is genuinely lost**: a reader who changes their mind, signs in
  and never looks at the banner now has their account erased on day 30. That is
  the deletion they asked for being honoured, and the banner is on every page
  they load until it happens.

## References

- `design/settings/design-notes.md` → `Data & privacy` → DECISION 4 (amended by
  this record) and `account-data.mock.html` panel 5.
- `docs/decisions/code-graph-index-fleet.md` §14.3 — _"a grace period the user
  cannot reach is not a grace period"_, the doctrine both options argue from.
- `content/legal/privacy.md` §6 — the 30-day promise, unchanged.
- `tests/account-deletion-schedule.test.ts` → _the SEAM: signing in leaves it
  standing_ — the amended assertions, kept on the record rather than deleted.
- MOTIR-3700 (the hook this removes) · MOTIR-3704 (the two doors) · MOTIR-3703 /
  MOTIR-3732 (the authenticated export download that made the silent revocation
  reachable) · MOTIR-3706 (the journey test this unblocks).
