# Auth — design notes

Design reference for the `auth` area: the signed-out surfaces served from
`app/(auth)/**` — sign-in, sign-up, password reset, and the two later screens
(`/device`, `/unsubscribe/filter-subscription`) that joined the group after this
asset was drawn.

| Surface             | Asset                                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auth 2.0**        | **`auth-screens.pen`** (Pencil source)           | Twelve artboards — five desktop screens, three desktop states, four mobile. Exported as `01-signin-desktop.png` … `12-reset-request-mobile.png`, one PNG per artboard. **Gates Story 1.1** (auth).                                                                                                                                                                                                                                                         |
| **2FA challenge**   | **`two-factor-challenge.mock.html`** (HTML mock) | The second-factor step between the password and the session (Story 8.11 · MOTIR-1216): the six-digit field, the two fallbacks, remember-this-device, and the three refusals. The area's FIRST HTML mock — built from shipped code, not from the artboards. **Gates MOTIR-1221.**                                                                                                                                                                           |
| **Passkey sign-in** | **`passkey-sign-in.mock.html`** (HTML mock)      | The one control Story 8.12 (MOTIR-1214 · MOTIR-3609) adds to the signed-out card: **Sign in with a passkey**, on the EMAIL step, beside the Google button and before the password. A passkey sign-in mints a session directly, so it never reaches the password step and never reaches `TwoFactorChallenge`. **Gates MOTIR-3613**; the account-side half is `../settings/passkeys.mock.html`.                                                              |
| **2FA required**    | **`two-factor-required.mock.html`** (HTML mock)  | The screen a member without a second factor meets once their organization or workspace starts REQUIRING one (Story 8.13 · MOTIR-3643): who is asking, the three ways to satisfy it, the mounted enrolment surface, the return to where they were going, and the way out. Signed IN but held — it wears the `(auth)` frame precisely so nothing else is reachable. **Gates MOTIR-3648**; the admin-facing half is `../org-admin/security-policy.mock.html`. |
| **Legal agreement** | **`legal-agreement.mock.html`** (HTML mock)      | Two surfaces, one agreement (Story 8.4 · MOTIR-3679): the notice at the sign-up card's FOOT — on BOTH steps, because `Continue with Google` creates an account from step 1 and never saw the old one — and the re-consent interstitial a material change holds a signed-in reader on. **Gates MOTIR-1135**; for the agreement element it SUPERSEDES `03-signup-desktop.png`, and for everything else on that screen it does not.                           |
| **OAuth consent**   | **`oauth-consent.mock.html`** (HTML mock)        | The page an MCP client’s browser redirect lands on (Story MOTIR-6973 · MOTIR-6980): the app asking and where it returns, one workspace, all projects or one, the grant in the token picker’s columns, Approve / Deny, and the signed-out, no-workspace, invalid-request, approved and denied states. **Gates MOTIR-6985.** See § OAuth consent.                                                                                                            |
| CLI hand-off        | `../cli-connect/cli-connect.mock.html`           | `/device` and the banner it adds to the sign-in card. Drawn later, in its own area — this file does not re-specify it.                                                                                                                                                                                                                                                                                                                                     |
| Brand lockup        | `../brand/brand-mark.mock.html` §7b              | The `BrandMark` the `(auth)` card renders top-left. Supersedes this asset's "P" tile (see the ledger below).                                                                                                                                                                                                                                                                                                                                               |

`auth-screens.pen` is a **legacy Pencil source** — one of the fourteen `.pen`
files still in the tree, and this area holds no HTML mock beside it. New assets
are `*.mock.html` built from the real design system; this one predates that rule
and is kept as-is, which is why this file carries a translation table rather than
a token listing lifted from the source.

---

## ⚠️ READ THIS FIRST — this asset is a RECORD OF 2026-05-24, not a spec of today

**The `.pen` and its twelve exports were drawn for Subtask 1.1.1 on 2026-05-24
(`dbb2b229`), before the design system, before the `--el-*` token layer, and
before four decisions that changed what ships. It is preserved as the record of
that moment, not corrected to match the app** — the settled call on a design
asset whose product moved underneath it (Yue, 2026-08-10; the same policy the
`KNOWN` table in `tests/design-asset-addresses.test.ts` states for stale
addresses).

**So the layout intent below is authoritative and the chrome around it is not.**
What each screen is FOR, which fields it holds, in what order, and the exact copy
of its prompts came from these artboards and still hold. The frame they sit in,
the token names, the control heights and the brand lockup have all been
superseded by shipped code, and where they disagree **the shipped route wins**.
Every disagreement is listed once, here, so nobody has to rediscover it.

### The divergence ledger

| #   | The artboards say                                                                                                      | The app ships                                                                                                                                                                                                                                                                                                                                             | Since                          |
| --- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | The twelve **PNG exports** read **"Prodect"** — wordmark, and "Use Prodect to turn any product idea into reality."     | "Motir", everywhere. The `.pen` SOURCE was swept in the rebrand (`0cd3e19b`, 2026-06-11, _"design/ mockup brand strings"_); the PNGs could not be — re-exporting them needs Pencil, which is not in this repo. **The source and its own exports disagree about the product's name.** Read the `.pen`.                                                     | 2026-06-11                     |
| 2   | A **28px `--primary` rounded tile lettered "P"** + a serif "Motir" wordmark, **centred above** the form.               | `BrandMark` (`components/brand/BrandMark.tsx`) — the wave-band glyph, no letter — at `size={28}`, **top-left inside the card**, wrapped in a `Link` to `/`. `app/(auth)/layout.tsx` renders it once for all five screens. `../brand/design-notes.md` §7b is its spec.                                                                                     | MOTIR-1150                     |
| 3   | A **bare page**: content on `$--background`, a 500px column, `[56, 80]` padding, 80px between the lockup and the form. | A **centred card**: `--el-auth-wash` page (measured `rgb(220, 236, 250)`, i.e. `--color-tint-sky`) behind a `max-w-[28rem]` = **448px** card painted `--el-page-bg` at `--radius-card` (12px) with `--shadow-elevated`. Measured in Chromium at 1280×900 against the real compiled token layer.                                                           | `app/(auth)/layout.tsx`        |
| 4   | Controls are **52px** tall (48px on mobile); inputs pad `[0, 18]`.                                                     | `--height-input` = **44px**, `--height-btn-lg` = **48px**, `--spacing-input-x` = 16px — and all three re-shape under `[data-style]`. The artboard numbers were pre-token constants; do not carry them into code.                                                                                                                                          | the shape axis                 |
| 5   | The Google button reads **"Sign in with Google"** / **"Sign up with Google"**, with a flat blue disc lettered "G".     | ONE `GoogleButton` with ONE label, **"Continue with Google"** (`auth.continueWithGoogle`), and the official four-colour Google glyph inlined as SVG. Google's branding guidelines approve the single phrasing across both flows.                                                                                                                          | `_components/GoogleButton.tsx` |
| 6   | Sign-up is **one step** and collects **Full name + Email address**.                                                    | Sign-up is **two steps** (identity → password) and **never asks for a name** — Better-Auth's schema needs one, so it is derived from the email localpart and edited later in profile settings. The page's own docstring records this as a deliberate call under `notes.html` #26 (a mockup is a layout-confirmation artifact, not a finishing-line spec). | `sign-up/page.tsx`             |

Four things the app has that no artboard draws are listed under
[Shipped surfaces this asset never drew](#shipped-surfaces-this-asset-never-drew).

---

## Token translation — the `.pen` variables, and what they are today

The `.pen` carries its own `variables` block, a **Tier-0-shaped** palette from
before the three-tier split. Nothing should reach for these names: they map onto
the Tier-3 `--el-*` element tokens as follows, and `--el-*` is what a component
writes (`CLAUDE.md` § "Colour flows through `--el-*` element tokens").

| `.pen` variable                        | Today                                                         | Role in these screens                                                             |
| -------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `$--background`                        | `--el-page-bg` (card) · `--el-auth-wash` (page)               | The artboard's one background splits into two roles.                              |
| `$--foreground`                        | `--el-text`                                                   | Headline, footer prompt, the read-only email value.                               |
| `$--muted-foreground`                  | `--el-text-muted`                                             | Subhead, placeholders, field glyphs, the "OR" label.                              |
| `$--primary` / `$--primary-foreground` | `--el-accent` / `--el-accent-text`                            | The Continue / Send-reset-link fill and its ink.                                  |
| `$--hairline`                          | `--el-border`                                                 | The two rules flanking "OR"; the Plan-with-AI divider.                            |
| `$--hairline-strong`                   | `--el-button-border` (buttons) · `--el-input-border` (fields) | One artboard stroke, two shipped roles.                                           |
| `$--surface-soft`                      | `--el-surface`                                                | The read-only email row on the password step.                                     |
| `$--link`                              | `--el-link` (`--el-link-pressed` on hover)                    | "Sign up", "Log in", "Forgot password?".                                          |
| `$--destructive`                       | `--el-danger`                                                 | Error ink and the invalid field's border.                                         |
| `$--tint-rose`                         | `color-mix(in srgb, var(--el-danger) 12%, transparent)`       | The `FormAlert` fill — derived from the danger token rather than a separate tint. |
| `$--radius-btn` / `$--radius-input`    | `--radius-btn` / `--radius-input`                             | Same names; both now flip under `[data-style]`.                                   |
| `$--font-serif` / `-sans` / `-mono`    | `--font-serif` / `--font-sans` / `--font-mono`                | Same role names; all three re-point under `[data-type]`.                          |
| `#4285f4` (the Google disc)            | the official multi-colour Google glyph                        | The one raw hue in the artboards, and it does not ship.                           |

Two artboard hues have no token and must not be reproduced: the `#4285f4` disc
(replaced by Google's own four-colour mark) and the `#ffffff` "G". Every other
colour on these screens comes from `--el-*` — **never invent one**.

---

## The frame every screen inherits

Drawn twelve times in the artboards; written **once** in the app, which is why no
per-screen section below repeats it.

- **`app/(auth)/layout.tsx`** — the page: `min-h-screen`, centred,
  `bg-(--el-auth-wash)`, `px-6 py-12 sm:px-10`. Inside it a `main` at
  `max-w-[28rem]`, and inside that the card: `flex flex-col gap-8`,
  `rounded-(--radius-card)`, `bg-(--el-page-bg)`, `px-6 py-10 sm:px-10`,
  `shadow-(--shadow-elevated)`. The `BrandMark` lockup is the card's first
  child, `self-start`.
  - **One screen widens it**: `/device`'s confirm step renders `data-auth-wide`,
    which takes the card to `max-w-[40rem]`, tightens the padding, and
    **suppresses the lockup** — a measured fold decision, not a taste call
    (`../cli-connect/design-notes.md`). Every other screen is byte-identical
    with or without that variant.
- **`AuthShell`** (`_components/AuthShell.tsx`) — the per-page content block:
  a `section` of `gap-8` holding a `header` of `gap-3` (the `h1` at
  `font-serif text-4xl sm:text-5xl`, `--el-text`; the subhead `p` at
  `text-base`, `--el-text-muted`) then the slotted body. **The vertical rhythm
  lives here, not on the pages.** Its `tight` mode is `/device`'s only.
- **Forms** are `flex flex-col gap-5`.

Measured against the real compiled token layer (Chromium, 1280×900, light,
`data-style` unset): card 448px wide, radius 12px, wash `rgb(220, 236, 250)`,
`h1` 48px, input row 44px, primary button 48px.

---

## 01 — Sign-in · desktop · step 1 (email)

`01-signin-desktop.png` · ships at `/sign-in`, `step === 'email'`.

The two-step Clay pattern: identify first, authenticate second. One route
throughout — the URL never changes between steps (the Story-1.1 decision).

| Element       | Primitive                                               | Copy (catalog key)                                                                                  | Tokens                                                                                                                                                      |
| ------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headline      | `AuthShell` `h1`                                        | "Welcome back!" (`auth.welcomeBack`)                                                                | `--el-text` · `--font-serif`                                                                                                                                |
| Subhead       | `AuthShell` `p`                                         | "Use Motir to turn any product idea into reality." (`auth.signInSubhead`)                           | `--el-text-muted` · `--font-sans`                                                                                                                           |
| Google button | `GoogleButton` → `Button variant="secondary" size="lg"` | "Continue with Google" (`auth.continueWithGoogle`); "Connecting…" (`auth.connecting`) while loading | fill transparent, `--el-button-border`, ink `--el-text`; `--radius-btn` · `--height-btn-lg`                                                                 |
| Divider       | `OrDivider`                                             | "OR" (`auth.or`); `aria-label` "or" (`auth.orAriaLabel`)                                            | rules `--el-border`; label `--el-text-muted`, `text-xs uppercase tracking-wider`                                                                            |
| Email field   | `Input` + `addonStart={<Mail/>}`                        | placeholder "Email address" (`auth.emailAddress`), also its `aria-label`                            | `--el-page-bg` fill, `--el-input-border`, glyph `--el-icon-field`, placeholder `--el-text-muted`; `--radius-input` · `--height-input` · `--spacing-input-x` |
| Submit        | `Button variant="primary" size="lg" className="w-full"` | "Continue" (`auth.continue`); "Checking…" (`auth.checking`) while loading                           | `--el-accent` / `--el-accent-text`; `--radius-btn` · `--height-btn-lg`                                                                                      |
| Footer link   | `FooterLink` (`p` + `Link`)                             | "Don't have an account?" (`auth.dontHaveAccount`) + "Sign up" (`auth.signUp`) → `/sign-up`          | prompt `--el-text`, link `--el-link` / `--el-link-pressed`                                                                                                  |

**Tab order is Google → email → Continue**, which is why the Google button is
first in the DOM and not merely first visually.

**The artboards do not draw the block below the footer link.** Shipped, the card
ends with a `border-t border-(--el-border) pt-6` divider, a centred
`--el-text-muted` lead — "Have a project idea?" (`auth.planWithAiLead`) — and a
full-width secondary link, "Plan with AI" (`auth.planWithAI`) with a `Sparkles`
glyph. It is the onboarding door, and this card is where it is reached from.

**⚠️ THE DOOR TARGETS `/sign-up`, NOT `/onboarding` — and it is NOT DRAWN AT ALL
on the arrival that is already serving it (MOTIR-4402).** It used to link
straight to the entrance, and the entrance is authenticated: the layout bounced
the visitor back to `/sign-in?next=/onboarding`, and this card rendered that
return identically to the arrival — same headline, same form, same door. The
lead addresses somebody who has NO account, so the door goes to account
creation carrying the intent in `?next=`, which both credential surfaces already
honour. The href is `ONBOARDING_SIGNUP_DOOR_PATH`, composed in
`lib/navigation/landing.ts` from the entrance constant that file owns — the card
spells neither route out.

**And a card that IS carrying the intent says so, in a THIRD `IdeaCarried`
banner** — the same quiet `--el-surface-soft` block as the other two, label
"Where you're headed" (`auth.onboardingCarriedLabel`) over
`auth.onboardingCarriedSignIn`. The whole block above is then suppressed: a door
onto the surface the reader is standing on is what made the original loop read
as a working control. `/sign-up` renders the same banner with
`auth.onboardingCarriedSignUp`, because that is where the door now lands.

## 02 — Sign-in · desktop · step 2 (password)

`02-signin-password-desktop.png` · ships at `/sign-in`, `step === 'password'`.

Same headline and subhead — they are stable across both steps, which is what lets
the streaming fallback render the same shell.

| Element         | Primitive                                              | Copy                                                                                                                                                             | Tokens                                                                                             |
| --------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Email recap     | hand-rolled read-only row (not `Input`)                | the entered address; `aria-label` "Signing in as {email}" (`auth.signingInAs`)                                                                                   | `bg-(--el-surface)`, ink `--el-text`, glyph `--el-text-muted`; `--radius-input` · `--height-input` |
| Change-email    | `button`                                               | "Use a different email" (`auth.useDifferentEmail`)                                                                                                               | `--el-link`, `text-xs`, `self-start`                                                               |
| Forgot password | `Link` → `/reset-password`                             | "Forgot password?" (`auth.forgotPassword`)                                                                                                                       | `--el-link`, `text-sm font-medium`, `self-start`                                                   |
| Password field  | `Input` + `Lock` addonStart + reveal `button` addonEnd | placeholder "Password" (`auth.password`); the reveal button's `aria-label` toggles "Show password" / "Hide password" (`auth.showPassword` / `auth.hidePassword`) | as 01; reveal button `--radius-control`, ink `--el-text-muted` → `--el-text` on hover              |
| Submit          | `Button variant="primary" size="lg"`                   | "Continue" (`auth.continue`); "Signing in…" (`auth.signingIn`)                                                                                                   | as 01                                                                                              |

**"Forgot password?" sits ABOVE the password field**, not below it. That is the
artboard's placement and the Clay pattern, and it is deliberate — the more common
below-field position is what a reimplementation drifts to.

**The recap row is NOT an `Input`.** It renders no control, so it takes
`--el-surface` rather than the field's `--el-page-bg` + `--el-input-border`,
which is what makes it read as settled rather than editable. The artboard drew it
as a filled field (`$--surface-soft`); the shipped row drops the border entirely.

**No account enumeration.** Step 1 never checks the email server-side — it always
advances — and step 2 returns one unified error for a bad email OR a bad password.

## 03 — Sign-up · desktop

`03-signup-desktop.png` · ships at `/sign-up`, `step === 'identity'`.

| Element       | Primitive                  | Copy                                                                                          | Tokens                               |
| ------------- | -------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------ |
| Headline      | `AuthShell` `h1`           | "Welcome to Motir!" (`auth.welcomeToMotir`)                                                   | as 01                                |
| Subhead       | `AuthShell` `p`            | "Sign up to turn any product idea into reality." (`auth.signUpSubhead`)                       | as 01                                |
| Google button | `GoogleButton`             | "Continue with Google" — the same string as sign-in                                           | as 01                                |
| Divider       | `OrDivider`                | "OR"                                                                                          | as 01                                |
| Email field   | `Input`                    | placeholder "Email address"; helper "We'll use this to sign you in." (`auth.emailHelper`)     | helper `--el-text-helper`, `text-xs` |
| Submit        | `Button variant="primary"` | "Continue" (`auth.continue`)                                                                  | as 01                                |
| Footer link   | `FooterLink`               | "Already have an account?" (`auth.alreadyHaveAccount`) + "Log in" (`auth.logIn`) → `/sign-in` | as 01                                |

**Divergence 6 lives here.** The artboard stacks a **Full name** field
(`user` glyph) above Email in a `gap-16` group and submits both at once. The
shipped page has **no name field** and splits identity from password across two
steps. Do not reintroduce the field from the artboard.

**Email-already-taken is an inline state the artboards do not draw.** The `Input`
takes `error={auth.accountExists}` — "An account with this email already exists."
— which swaps the helper for `--el-danger` ink and borders the field
`--el-danger`, and a `Link` appears beneath it: "Sign in instead →"
(`auth.signInInstead`) → `/sign-in`.

**The password step (`step === 'password'`) is likewise undrawn**: the same
read-only email recap as screen 02 with an "Edit" button (`auth.edit`), a
`New password`-shaped `Input` placeheld "Create a password"
(`auth.createPassword`) with helper "At least 8 characters." (`auth.atLeast8`) and
error "Password must be at least 8 characters." (`auth.passwordTooShort`), and a
submit reading "Create account" (`auth.createAccount`) / "Creating account…"
(`auth.creatingAccount`).

## 04 — Reset password · request · desktop

`04-reset-request-desktop.png` · ships at `/reset-password`, `state === 'request'`.

| Element     | Primitive                  | Copy                                                                                         | Tokens                                                                                                                          |
| ----------- | -------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Headline    | `AuthShell` `h1`           | "Reset your password" (`auth.resetYourPassword`)                                             | as 01                                                                                                                           |
| Subhead     | `AuthShell` `p`            | "Enter the email tied to your account and we'll send a one-time link." (`auth.resetSubhead`) | as 01                                                                                                                           |
| Email field | `Input` + `Mail`           | placeholder "Email address"                                                                  | as 01                                                                                                                           |
| Submit      | `Button variant="primary"` | "Send reset link" (`auth.sendResetLink`); "Sending…" (`auth.sending`)                        | as 01                                                                                                                           |
| Secondary   | `Link` styled as a button  | "Back to sign in" (`auth.backToSignIn`) → `/sign-in`                                         | `bg-transparent`, `border-(--el-border-strong)`, ink `--el-text`, hover `bg-(--el-surface)`; `--radius-btn` · `--height-btn-lg` |

**The secondary "Back to sign in" is a `Link`, not a `Button`** — it navigates,
so it keeps real link semantics and hand-rolls the button's visual contract.
Its border is `--el-border-strong`, one step up from the Google button's
`--el-button-border`; the artboard drew both as the same `$--hairline-strong`.

**Rate limiting is a state the artboards do not draw.** Three requests per hour
per IP; on 429 a `FormAlert` carries "Too many reset requests from this device.
Please wait an hour and try again." (`auth.tooManyRequests`). A network failure
shows "We couldn't reach the server. Check your connection and try again."
(`auth.couldntReachServer`).

**Nor is a MAIL OUTAGE (MOTIR-3583), and it is the third string in the same
`FormAlert` slot.** On 503 — the auth route's answer when a reset email could not
be QUEUED — the alert carries "We couldn't send the reset email just now. Please
try again in a moment." (`auth.couldntSendResetLink`). It is a page-scoped
failure with the same treatment as the other two, and it exists because screen 05
is a PROMISE: showing "Check your inbox" for a message that was never enqueued
leaves the reader waiting on an inbox nothing will arrive in. Every OTHER status
still folds into screen 05 unchanged, so the anti-enumeration property below
holds outside the outage window.

## 05 — Reset password · sent confirmation · desktop

`05-reset-confirmation-desktop.png` · ships at `/reset-password`,
`state === 'confirmation'`.

| Element    | Primitive                 | Copy                                                                                                                                             | Tokens                                       |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| Headline   | `AuthShell` `h1`          | "Check your inbox" (`auth.checkInbox`)                                                                                                           | as 01                                        |
| Subhead    | `AuthShell` `p`           | "If an account exists for that email, we've sent a one-time link to reset your password. The link expires in 1 hour." (`auth.checkInboxSubhead`) | as 01                                        |
| Secondary  | `Link` styled as a button | "Back to sign in" (`auth.backToSignIn`) → `/sign-in`                                                                                             | as 04                                        |
| Retry line | `p` + inline `button`     | "Didn't get it?" (`auth.didntGetIt`) + "Check spam, or try another email." (`auth.checkSpam`)                                                    | prompt `--el-text-muted`, action `--el-link` |

**The artboard renders the retry line as one flat muted sentence; shipped, the
second half is a `button` that flips the page back to the request state.** That
is the only interactive difference on this screen and it is easy to miss.

**Anti-enumeration is the reason this screen exists**: it is shown whether or not
the address has an account, so the copy is conditional ("If an account exists…")
and the outcome is never branched on.

## 06 — Sign-in · desktop · OAuth error

`06-signin-desktop-oauth-error.png` · ships at `/sign-in?error=…`, step 1.

Screen 01 with a `FormAlert` inserted directly under the header, above the Google
button.

| Element | Primitive   | Copy                                                                                       | Tokens                                                                                                                                           |
| ------- | ----------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Banner  | `FormAlert` | "Google sign-in didn't complete. Try again, or use email." (`auth.googleSignInIncomplete`) | fill `color-mix(in srgb, var(--el-danger) 12%, transparent)`, ink + glyph `--el-danger`; `--radius-input` · `--spacing-input-x` / `--spacing-sm` |

`role="alert"` + `aria-live="polite"`, with the circle-alert glyph
`aria-hidden`. The message is seeded from the `?error=` query param once, in a
`useState` lazy initializer rather than an effect — Better-Auth bounces a denied
or failed Google consent back here, and reading the param in an effect is the
cascading-render trap the `react-hooks/set-state-in-effect` rule exists for.

The same banner carries every other page-scoped failure: `auth.googleSignUpIncomplete`
on `/sign-up`, `auth.somethingWentWrong`, and the two reset-page errors above.

**The banner's fill is `color-mix`ed off `--el-danger`, not a `--el-tint-*`.**
The artboard used `$--tint-rose`; the shipped alert derives its own fill so the
tint tracks the danger hue under every palette. Either is token-routed — do not
substitute a raw hue for it.

## 07 — Sign-in · desktop · wrong password

`07-signin-password-desktop-wrong.png` · ships at `/sign-in`, step 2, after a
rejected submit.

Screen 02 with the password `Input` carrying `error`:

| Element      | Copy                                                                        | Tokens                                                           |
| ------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Field border | —                                                                           | `border-(--el-danger)` replaces `--el-input-border`              |
| Error line   | "That password isn't right. Try again, or reset it." (`auth.wrongPassword`) | `--el-danger`, `font-sans text-xs`, in `FormField`'s helper slot |

`FormField` sets `aria-invalid` and wires `aria-describedby` to the error's id;
the error **replaces** the helper text rather than stacking with it. This is
`errorVariant="text"` (the quiet danger line) — `errorVariant="box"` is the
rose-tinted variant and is not used on any auth screen.

**One error string covers both a wrong email and a wrong password** (see 02).
The artboard's copy is the shipped copy, verbatim.

## 08 — Sign-in · desktop · Continue loading

`08-signin-desktop-continue-loading.png` · ships at `/sign-in`, step 1,
`submitting === true`.

The artboard expresses the busy state by hand — 0.5 opacity on the Google button
and the email row, 0.85 on the primary, plus a hand-drawn 16px ring and the label
"Checking…". **Shipped, this is entirely `Button`'s own `loading` prop**: it
renders a `Spinner` (`size="md"` at `size="lg"`) beside the label, and the label
itself swaps to `auth.checking` (step 1) or `auth.signingIn` (step 2). Do not
reimplement the artboard's opacity scheme — pass `loading`.

`GoogleButton` carries the same contract with its own label, "Connecting…"
(`auth.connecting`), and deliberately **stays** loading on success: the browser
is already navigating to Google's consent screen, so the spinner runs until the
unload.

## 09 — Sign-in · mobile (375px) · step 1

`09-signin-mobile.png` · the same route at a narrow viewport.

The artboard re-draws the whole screen at 375px with a smaller scale: 24px
lockup, 32px headline, 14px body, 48px controls, `[32, 24]` padding, `gap-40`
between lockup and form.

**Shipped, there is no mobile artboard to implement.** One responsive rule
carries all of it: the card is `w-full max-w-[28rem]` inside a `px-6 sm:px-10`
page, and the headline is `text-4xl sm:text-5xl` — so below the `sm` breakpoint
the column is the viewport minus 48px of gutter and the headline is 36px. Every
other size is a token and does not change with the viewport.

So read screens 09–12 as **confirmation that the layout survives 375px**, which
is what they were drawn for — not as a second set of values to hard-code. The one
number they fix that the desktop artboards do not is the **page gutter at
mobile**, which ships as `px-6` (24px).

## 10 — Sign-in · mobile · password step

`10-signin-password-mobile.png` · screen 02 at 375px. Same relationship to the
shipped code as 09: no separate implementation, the same responsive card.

Worth reading for one thing: it confirms **"Forgot password?" keeps its
above-the-field position at mobile**, where the temptation to move it beside the
label is strongest.

## 11 — Sign-up · mobile (375px)

`11-signup-mobile.png` · screen 03 at 375px, carrying the same **Full name +
Email** pair the desktop artboard draws — and the same divergence 6 applies: the
shipped page has no name field.

## 12 — Reset password · request · mobile (375px)

`12-reset-request-mobile.png` · screen 04 at 375px. Both buttons stay full-width
and stacked, which is what the artboard is confirming; the confirmation state (05)
has no mobile artboard and needs none.

---

## Shipped surfaces this asset never drew

Four `(auth)` surfaces arrived after 2026-05-24. **None of them is specified
here** — the pointer is the deliverable, so nobody looks for a thirteenth
artboard that does not exist.

1. **`/reset-password/new`** — the tokenized landing the reset email links to,
   with three states: _set a new password_ (`auth.setNewPassword` /
   `auth.setNewPasswordSubhead`), _link expired_ (`auth.linkExpired` /
   `auth.linkExpiredSubhead`, offering `auth.requestNewLink` +
   `auth.backToSignIn`), and _password updated_ (`auth.passwordUpdated` /
   `auth.passwordUpdatedSubhead`, offering `auth.continueToSignIn`). Composed
   from the same `AuthShell` + `Input` + `Button` set; the page's own docstring
   records that no mockup exists and it follows the established frame. The route
   is the static `/reset-password/new` path reading a `token` query param,
   **not** the card's drafted
   `/reset-password/[token]` — Better-Auth always passes the token as a query
   param, so a dynamic segment cannot capture it.
2. **`/device`** — the CLI hand-off approval screen. Its own area:
   `../cli-connect/design-notes.md` + `cli-connect.mock.html`. It is also the
   one screen that widens this layout (`data-auth-wide`) and suppresses the
   lockup.
3. **The `IdeaCarried` banners on `/sign-in`, and one on `/sign-up`** — a quiet
   `--el-surface-soft` block with an `--el-text-secondary` uppercase label and
   an `--el-text` body, `line-clamp-4`, at `--radius-input` with an
   `--el-border` hairline. One carries an idea handed off from the marketing
   hero (`?draft=`), one the device code from the CLI hand-off, rendered
   through `CodeChip` (`--el-code-bg` / `--el-code-text`, `--radius-control`,
   `font-mono`), and the third the ONBOARDING INTENT a `?next=/onboarding`
   arrival is carrying (MOTIR-4402) — the only one of the three that also
   renders on `/sign-up`, since that is where the Plan-with-AI door now lands.
   All sit between the header and the form.
4. **`/unsubscribe/filter-subscription`** — a signed-out unsubscribe
   confirmation that inherits this card and nothing else from this asset.

---

## Token / a11y rules honoured

- **Every colour is an `--el-*`.** No screen reaches a Tier-0 `--color-*`, and
  the only literal hues in the whole area are Google's own four brand colours
  inside its glyph — a third-party mark, not an element fill.
- **Every radius, height and control padding is an element-semantic shape
  token** (`--radius-btn` / `--radius-input` / `--radius-card` /
  `--radius-control`; `--height-input` / `--height-btn-lg`;
  `--spacing-input-x`), so `[data-style]` reshapes the whole area. Only the
  layout gaps (`gap-8`, `gap-5`, `gap-3`) and the page gutters are raw, which
  the shape rule allows.
- **Ink on the card clears AA.** The card is `--el-page-bg` (white in light),
  which is the one surface `--el-text-muted` is safe on (4.54:1) — and it is
  used for exactly the subheads, placeholders and field glyphs that sit on it.
  The one muted caption that sits on a _tinted_ surface, the `IdeaCarried`
  label on `--el-surface-soft`, correctly takes `--el-text-secondary` (6.51:1)
  instead. That split is the measured table in `CLAUDE.md`, applied.
- **The brand link takes its name from its visible wordmark** and carries no
  `aria-label` — `../brand/design-notes.md` §8's "never both".
- **`OrDivider` is a labelled `role="separator"`**, so the rule is announced
  rather than read as the literal string "OR".
- **`FormAlert` is `role="alert"` + `aria-live="polite"`** with its glyph
  `aria-hidden`.
- **Every field carries an `aria-label`** (the design is placeholder-only, with
  no visible labels), and `FormField` wires `aria-invalid` +
  `aria-describedby` for the error and helper lines.
- **The password reveal button's `aria-label` toggles** between "Show password"
  and "Hide password" rather than staying fixed.

## Primitives composed (no hand-rolling)

`Button` (`primary` / `secondary`, `size="lg"`, `loading`) · `Input`
(`addonStart` / `addonEnd` / `helperText` / `error`) · `FormField` (via `Input`)
· `Spinner` (via `Button loading`) · `BrandMark` · and the four area-local
pieces in `_components/AuthShell.tsx`: `AuthShell`, `OrDivider`, `FormAlert`,
`IdeaCarried`, plus `CodeChip`.

Three things on these screens are deliberately **not** a primitive, and each has
a reason recorded above: the read-only email recap (a display row, not a
control), the "Back to sign in" secondary (a `Link` that must keep link
semantics), and the artboards' hand-drawn loading treatment (superseded by
`Button loading`).

---

# The two-factor challenge — `two-factor-challenge.mock.html`

**Story 8.11 (MOTIR-1213) · Subtask MOTIR-1216.** The step between the password
and the session: a six-digit code, two fallbacks, and the opt-in that stops
Motir asking on this browser for 30 days. **Gates MOTIR-1221.** The account pane
that sets all of it up is `../settings/two-factor.mock.html`; the two assets
cite each other and neither re-specifies the other.

**⚠️ This is the FIRST HTML mock in this area, and it does not inherit the
artboards.** `auth-screens.pen` is preserved as a record of 2026-05-24 (the
READ THIS FIRST section above), so this asset is built from the SHIPPED code and
agrees with the divergence ledger rather than with the exports: the frame is
`app/(auth)/layout.tsx`'s 28rem card on the `--el-auth-wash` page with the
`BrandMark` lockup top-left INSIDE the card (ledger rows 2 + 3), the headline
rhythm is `AuthShell`'s, and the control heights are `--height-input` 44 /
`--height-btn-lg` 48 rather than the artboards' 52 (ledger row 4).

## THE ACCESS PATH — this screen has no door, it has a RESPONSE

Panel 1 draws it, because it is the thing a build would otherwise have to
infer. There is no route to link to and no way to reach this screen
deliberately. It is the THIRD step of the shipped `SignInCard`, and it appears
when `signIn.email` answers `{ twoFactorRedirect: true }` instead of a session:

| step | surface                                          | when                                                         |
| ---- | ------------------------------------------------ | ------------------------------------------------------------ |
| 1    | `SignInCard` step `'email'`                      | always                                                       |
| 2    | `SignInCard` step `'password'`                   | always                                                       |
| 3    | **`SignInCard` step `'twoFactor'`** — this asset | ONLY on `twoFactorRedirect`; **skipped on a trusted device** |
| 4    | `resolvePostAuthDestination`                     | `?next=` when safe, else `/workbench`                        |

Two consequences worth stating: the card grows a THIRD step rather than gaining
a route (so `app/(auth)/layout.tsx`, the shell and the brand lockup are
untouched), and the reason the trust checkbox lives on step 3 rather than in
settings is that `trustDevice` is a flag on the verify CALL — there is no
"trust this browser" action to take anywhere else.

## Panels

| #   | what it draws                                                                      |
| --- | ---------------------------------------------------------------------------------- |
| 1   | **The access path** — the four-step strip above                                    |
| 2   | **At rest** — the authenticator challenge + "don't ask again on this device"       |
| 3   | **The fallbacks** — the ordered "try another way" list, and the emailed-code state |
| 4   | **A recovery code** — the ordinary case, and the LAST-code warning                 |
| 5   | **The failures** — wrong code, expired code, attempts spent                        |
| 6   | **Dark parity**                                                                    |

## Per-control map — primitive, endpoint, tokens

| element                    | primitive                    | endpoint                                  | colour                                                            | shape                              |
| -------------------------- | ---------------------------- | ----------------------------------------- | ----------------------------------------------------------------- | ---------------------------------- |
| page + card                | `app/(auth)/layout.tsx`      | —                                         | `--el-auth-wash` page, `--el-page-bg` card, `--shadow-elevated`   | `--radius-card`                    |
| brand lockup               | `BrandMark size={28}`        | —                                         | `--el-text`                                                       | —                                  |
| headline + subhead         | `AuthShell`                  | —                                         | `--el-text` / `--el-text-muted` (on the white card — AA 4.54)     | —                                  |
| "signing in as" row        | a display row, not a control | —                                         | `--el-surface` + `--el-text`; glyph `--el-text-secondary`         | `--radius-input`, `--height-input` |
| six-digit field            | `.otp` (six `Input` cells)   | `twoFactor.verifyTotp` / `verifyOtp`      | `--el-border-strong`; focus `--el-accent`; error `--el-danger`    | `--radius-input`                   |
| recovery-code field        | `Input`, mono                | `twoFactor.verifyBackupCode`              | as above                                                          | `--radius-input`, `--height-input` |
| trust checkbox             | `Checkbox`                   | the `trustDevice` flag on the verify call | on: `--el-accent` + `--el-accent-text`                            | `--radius-xs`                      |
| Verify                     | `Button primary size="lg"`   | —                                         | `--el-accent` + `--el-accent-text`                                | `--radius-btn`, `--height-btn-lg`  |
| "Try another way" rows     | `Button secondary`, stacked  | `twoFactor.sendOtp` for the email row     | `--el-border-strong`; sub-line `--el-text-secondary`              | `--radius-btn`                     |
| the error line             | `FormAlert` (`role="alert"`) | the plugin's typed refusals               | `--el-tint-rose` + `--el-text-strong`, glyph `--el-danger`        | `--radius-input`                   |
| the expiry / warning notes | `.callout`                   | `otpOptions.period` (3 min)               | info `--el-tint-sky` · warn `--el-tint-peach`, `--el-text-strong` | `--radius-card`                    |
| the foot link              | `Link`                       | —                                         | `--el-link` / `--el-link-pressed`                                 | —                                  |

## The three refusals, and why they are three

A single "that didn't work" leaves a reader with a correctly-typed code and
nothing to try. Each refusal names its own remedy:

- **Wrong code** — "…check your phone's clock is set automatically — a drifted
  clock generates codes Motir can't accept." The single commonest cause of a
  TOTP failure that is not a typo, and it is invisible to the reader.
- **Expired code** — the emailed one only. The action is a resend, so the
  primary button BECOMES "Send a new code".
- **Attempts spent** — the plugin allows five (`otpOptions.allowedAttempts`),
  and the screen says the number rather than failing silently on the sixth. It
  also says recovery codes are counted separately, because they are.

All three keep the reader on the step they are on. None bounces back to the
password, which would throw away a correct password over a mistyped code.

## The last recovery code

Spending the LAST code leaves an account with 2FA on and no way back in if the
authenticator is also gone — the state the settings pane's zero-callout
describes, arrived at from the other side. So the challenge says so BEFORE the
code is spent, and lands the reader on `/settings/account/security` afterwards
rather than at `/workbench` with the problem still true.

## The copy

**i18n keys** — one namespace, `auth.twoFactor.*`: `title` · `subtitle` ·
`signingInAs` · `verify` · `trustDevice` · `trustDeviceHelp` · `tryAnother` ·
`back` · `methods.{totp,email,backup}.{label,sub}` · `emailSent.{title,subtitle,expiry,resend,resendIn}` ·
`backup.{title,subtitle,label,helper,lastTitle,lastSubtitle,lastWarning,lastCta}` ·
`errors.{wrongCode,clockDrift,expired,attemptsSpent,attemptsHelp}` ·
`lockedOut.{title,subtitle,startAgain,contactOwner}`. Every `en` key needs its
`zh` twin (`tests/i18n-catalog.test.ts`).

## The workflow spec this design is grounded in

- **MOTIR-1217** — the methods, the digits, the periods, the attempt ceiling,
  and the fact that "don't ask again" is a `trust-device-*` `verification` row
  plus a signed cookie.
- **MOTIR-1218** — the status the settings side renders and the typed refusals.
- **MOTIR-1221** — the card that BUILDS this step.
- **`../settings/two-factor.mock.html`** — the pane that turns all of it on, and
  the only place a trusted device can be revoked.

## Accessibility

Everything the area's a11y section above already states holds here. Three
additions specific to this screen:

- **The six-digit field is ONE labelled group** (`role="group"`, "Six-digit
  code"), not six unlabelled boxes. A paste of `314159` fills all six.
- **The error line is `role="alert"`**, so a rejected code is announced rather
  than only re-coloured.
- **The trust checkbox's helper is part of its label**, not a `title` — the
  thirty days is the decision, and a decision hidden in a tooltip is not one.

## The nested-theme re-emit (a board artefact)

Identical to `../settings/design-notes.md` § _The nested-theme re-emit_: this
board puts `data-theme` on a nested `.panel`, so it re-emits the Tier-3 `--el-*`
block scoped to the attribute. It matters more on THIS screen because the wash
behind the card is itself a tint — a wash that does not flip leaves a bright
band around a dark card. In the app `data-theme` sits on `<html>`.

## Self-review

- Every icon is a lucide path at `viewBox="0 0 24 24"`, sized by CSS.
- No nested interactive elements; the fallback rows are buttons containing only
  text.
- Ink/surface pairs: `--el-text-muted` appears only on the white card
  (4.54:1); everything on `--el-surface` uses `--el-text-secondary`
  (6.18–6.80:1). The only `--el-text-faint` is an empty code cell's placeholder
  dash, marked `aria-hidden` — the labelled group carries the meaning, so the
  dash is decoration and the ink guard agrees.
- No Tier-0 `--color-*` outside the token block; no raw `rounded-*` / `p-*` /
  `h-9` on any control's own box.

---

# Sign in with a passkey — `passkey-sign-in.mock.html`

**Story 8.12 (MOTIR-1214) · Subtask MOTIR-3609, Surface B.** The ONE control this
story adds to the signed-out sign-in card, and what the card does while it is
pressed. **Gates MOTIR-3613.** The account-side half — register, rename, remove —
is `../settings/passkeys.mock.html`, and neither asset re-specifies the other.

The card's two-step Clay layout is Story 1.1's and nothing here changes it: one
button is added, in one place, and the stack around it is reproduced so the
placement is measurable rather than described.

## ⚠️ THE AFFORDANCE IS ON THE EMAIL STEP — and that is a code fact

`verifyPasskeyAuthentication` **mints a session directly** (its error set carries
`UNABLE_TO_CREATE_SESSION`), so a passkey sign-in never answers
`{ twoFactorRedirect: true }` and **`TwoFactorChallenge` is never reached**.
`two-factor-challenge.mock.html` was read to confirm the passkey does not belong
in it, and it is **not amended**.

Two consequences the build should not have to infer, and panel 1 draws both:

- **The password step is SKIPPED**, not merely optional. A passkey is not a
  second factor asked for after a password; it replaces the password.
- **The challenge step is UNREACHABLE** from this path. Wiring the passkey into
  `TwoFactorChallenge`'s method list — which the shipped component's `methods`
  prop makes trivially easy — would wire it into a step it can never arrive at.

It is also the correct product shape rather than only the correct wiring: a
UV-required credential is already two factors, so demanding a second one after it
would be theatre.

## The POSITION, and the argument for it

Directly under **Continue with Google**, above the **OR** rule.

Everything above that rule signs you in without typing anything; everything below
it is the email path. Putting the passkey button below the rule would file it as
an alternative to the email FIELD, which it is not — it is a peer of the Google
button, and the rule is what says so. Same primitive as its neighbour —
`Button variant="secondary" size="lg"`, full width — because a primary here would
demote a **Continue** that most readers still need today.

**Tab order follows the DOM: Google → passkey → email → Continue.** The
`autoFocus` on the email field is unchanged, so a reader who types straight away
is unaffected by a button they did not ask for.

## The ACCESS PATH — the door is a button, not a route

The gate asks the design to draw the door. This door **is** the affordance: there
is no route to link to, nothing to deep-link, and no nav entry. Panel 2 draws it
in its host at full width; panel 3 draws the same card at 390px, because
`09-signin-mobile.png` exists and a new control on that card owes the same check
— nothing wraps, nothing truncates, and the label fits one line at the narrowest
supported width.

## Panels

1. **The flow** — where the button sits, and the two steps a passkey sign-in
   skips.
2. **Desktop** — the shipped card with one control added.
3. **Mobile (390px)** — a width, not a second design.
4. **Pending** — the shipped `Button loading` state, plus a labelled stand-in for
   the browser's own sheet.
5. **The two refusals** — which take opposite shapes.
6. **Dark parity.**

## Per-control map

| Control                    | Primitive                                              | Call                                        |
| -------------------------- | ------------------------------------------------------ | ------------------------------------------- |
| **Sign in with a passkey** | `Button variant="secondary" size="lg"` full width      | `authClient.signIn.passkey()` (MOTIR-3610)  |
| **its pending state**      | the same `Button`, `loading` — spinner + changed label | —                                           |
| **no-match refusal**       | `FormAlert`, the card's existing danger callout        | `PASSKEY_ERROR_CODES.AUTHENTICATION_FAILED` |
| **cancelled**              | nothing                                                | `AUTH_CANCELLED`                            |

## The two refusals take OPPOSITE shapes

- **The reader dismissed the sheet** → **nothing is drawn.** They changed their
  mind, and a banner would tell them they did something wrong.
- **No passkey on this device matches a Motir account** → a real dead end, and it
  says so in the danger callout the card already uses for a wrong password. Its
  copy carries **the way out** — sign in with email and password, then add a
  passkey from account settings — because a reader stuck on this screen needs the
  next step more than the diagnosis.

## Grounded in shipped reality (rung 2)

**The card was RENDERED before anything was drawn**: a production build served at
localhost, `/sign-in` screenshotted at 1440×1000 and 390×844, both @2x. What the
render settled, and what this board therefore reproduces rather than invents:

- The `(auth)` frame — `--el-auth-wash` page, a 448px card at `--radius-card`
  with `--shadow-elevated`, the `BrandMark` + wordmark **inside** the card,
  top-left.
- The email step's stack, in shipped order: Continue with Google → OR → the email
  field → Continue → the sign-up prompt → a hairline → "Have a project idea?" +
  Plan with AI.
- **The real BrandMark and the real Google mark.** This area's older sprite
  carries an `#i-google` that is a placeholder (a plus in a circle, unused) and
  an `#i-wave` that predates the wave-band glyph. Both are replaced here with the
  shipped path data — `components/brand/waveBand.ts`'s `WAVE_BAND_PATH` and
  `GoogleButton.tsx`'s four-colour `GoogleGlyph`. Google's hues are the one raw
  hex on this board and they are correct: their branding guidelines require their
  asset.
- ⚠️ **Three tokens the copied block does NOT carry**, and their absence is not
  cosmetic: `--height-btn-lg`, `--el-input-border` and `--el-button-border`. The
  challenge mock draws no large button and no input, so it never needed them —
  and an undefined `var()` inside a `height` declaration does not fall back to
  the base rule, it computes to `auto`. A 48px button silently rendered at
  **17px** until this was found by measuring it. The three are appended with
  their `theme.css` values, and both `--el-*` are re-emitted under
  `[data-theme='dark']` for the nested-theme reason this area's other asset
  already records.

## The copy, and the `en` keys it needs

Under `auth.passkey.*`, beside the existing `auth.*` catalog. Every `en` key
needs its `zh` twin (`tests/i18n-catalog.test.ts`).

`signIn` ("Sign in with a passkey") · `waiting` ("Waiting for your browser…") ·
`noMatch` (the dead-end copy, including the way out).

**There is no `cancelled` key** — nothing is shown, so there is nothing to
translate.

## How the render was produced

1. `/sign-in` was screenshotted from a production build at both viewports before
   the board was composed.
2. The token block, the `[data-theme='dark']` block and the `(auth)` frame CSS
   are copied 1:1 from `two-factor-challenge.mock.html`; the new rules are
   APPENDED at the end of the style block.
3. The `.png` is exported with `node scripts/render-design-mock.mjs --width 1200`.

## Self-review

- The new button is a peer of the Google button in primitive, size, width and
  border token, so the two cannot diverge under a re-skin.
- Its pending state changes the LABEL as well as showing a spinner — a disabled
  button with the same words is the state a reader clicks twice.
- The refusal that draws nothing has no string and no key, so it cannot be
  "translated" into existence later.
- No Tier-0 `--color-*` outside the token block and the Google mark's own fills;
  no raw `rounded-*` / `p-*` / `h-*` on any control's own box.

---

## 2FA required — the forced-enrolment screen (Story 8.13 · 8.13.2)

**Asset:** `two-factor-required.mock.html` + `two-factor-required.png`. Gates
**MOTIR-3648** (the enforcement gate and the screen it redirects to). The
admin-facing half — the policy control both tenancy tiers render — is
**MOTIR-3642** and lives in `../org-admin/`.

### Why it is in THIS area, signed in

The person **is** signed in. They still land on a signed-OUT frame, and that is
the design decision rather than a filing convenience.

`app/(auth)/layout.tsx` is a centred card on a `--el-auth-wash` page with the
`BrandMark` lockup top-left INSIDE the card, and no app chrome at all. Drawing
this screen inside the app shell — the nav, the project switcher, the ⌘K palette
all present but inert — would be a worse screen (it advertises everything the
person cannot reach) and a worse posture (a shell that renders is a shell whose
data was loaded). So the screen joins `two-factor-challenge.mock.html` and
`passkey-sign-in.mock.html` in this area, wearing their frame, and the `(auth)`
grammar is reproduced here rather than re-specified.

### ⚠️ It MOUNTS the enrolment surfaces; it does not redraw them

8.11 shipped the authenticator, email-OTP and recovery-code flows and 8.12
shipped passkey registration, all drawn in `../settings/two-factor.mock.html`
and `../settings/passkeys.mock.html`. **Panel 5 shows the COMPOSITION and
nothing more** — the dashed outline in it is review chrome marking the mounted
region, NOT a border to build. A second drawing of a QR code and a
recovery-code sheet would be built twice and drift from the real one.

What this card genuinely owns is the **frame**: who is asking, why nothing is
reachable, what counts as satisfying it, and what happens next.

### The panels

| #   | panel                                  | what it shows                                                                     |
| --- | -------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | **Held, mandated by the ORGANIZATION** | The default. Plus the arrival drawn as a flow, because nobody clicks to get here. |
| 2   | **Held, mandated by the WORKSPACE**    | The same screen naming the workspace.                                             |
| 3   | **Held, mandated by BOTH**             | The ORGANIZATION is named — see the rule below.                                   |
| 4   | **Choosing a method**                  | Three routes, one honest trade-off each.                                          |
| 5   | **Mid-enrolment**                      | The shipped 8.11 surface mounted in this frame.                                   |
| 6   | **Satisfied**                          | The return to the route they actually asked for.                                  |
| 7   | **The way out**                        | The sign-out control, and why it is not optional.                                 |
| 8   | **Dark**                               | Held and satisfied, tokens flipped.                                               |

### The rule for panel 3 — the HIGHEST mandating tier is the one named

When both the organization and a workspace require it, **the organization is
reported**. It is the floor: naming the workspace would suggest that leaving it,
or getting its policy switched off, would help — and it would not. The body then
adds one sentence naming the workspace too, so the person is not misled about who
to ask. `twoFactorPolicyService.resolveRequirement` (MOTIR-3645) already returns
exactly this in `mandatedBy`, so the screen renders the verdict rather than
re-deriving it.

### The access path runs the OTHER way — arrival and departure, not a door

Nobody navigates here. Panel 1 therefore draws the **arrival** as a four-step
flow with a concrete case — a work-item link opened from an email — and panel 6
draws the **departure** back to that same URL.

- The path is carried from the edge as **`x-current-path`** (MOTIR-3652), because
  a Next.js layout has no supported way to learn the current URL.
- **The gate must validate it as a same-origin relative path before redirecting**
  — a leading `/`, no scheme, no `//`, no `..` — and fall back to a fixed safe
  destination otherwise. `proxy.ts` documents that at the header's definition;
  MOTIR-3648 is the consumer that has to honour it. **The destination is drawn as
  a chip showing the work item, not as a raw URL**, so the person recognises
  where they were going.
- **Never a generic dashboard.** Landing somebody on `/dashboard` after they
  clicked a specific link is the failure this whole card exists to prevent.

### ⚠️ The sign-out control is MANDATORY on every held panel

Every other route is closed to this person, so a screen with no exit is a trap:
somebody on a borrowed laptop, without their phone, or who simply does not want
to do this right now must be able to leave rather than bounce between a redirect
and a screen they cannot satisfy. It is a **ghost** `Button` in the footer —
present on every held panel, never competing with the primary action — and the
line under it (_"You can come back and set this up any time you sign in."_)
removes the fear that leaving costs them something. Panel 7 exists to make this
non-negotiable rather than a detail an implementer might drop for tidiness.

### ⚠️ NOT an error state

**No `--el-danger` fill, no red banner, no alert role, anywhere in this asset.**
Nothing has gone wrong: a policy was switched on and the person is being asked to
do a one-minute thing. The two chips carry their hue in the tint BACKGROUND with
`--el-text-strong` ink — `--el-tint-sky` for _who is asking_, `--el-tint-mint` for
_done_ — which is also what keeps them AA in both themes.

**And no copy implies a deadline.** Per rung 1 there is no grace period and no
countdown (Atlassian's authentication policy prompts at next login with no
window; GitHub blocks immediately), so no string here says "by", "within", or
"before".

### Primitives composed

| element                         | primitive                          | tokens                                                                                           |
| ------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| Page wash                       | `app/(auth)/layout.tsx`            | `--el-auth-wash`                                                                                 |
| The card                        | that layout's card                 | `--el-page-bg`, `--radius-card`, `--shadow-elevated`                                             |
| Brand lockup                    | `BrandMark`                        | `--el-accent` glyph on `--el-accent-text`, `--radius-control`                                    |
| Headline + subhead              | `AuthShell`                        | `font-serif` 32px `--el-text`; subhead `--el-text-muted`                                         |
| "Who is asking" chip            | `Pill`                             | `--el-tint-sky` background, `--el-text-strong` ink                                               |
| "Two-factor is on" chip         | `Pill`                             | `--el-tint-mint` background, `--el-text-strong` ink                                              |
| Primary action                  | `Button` primary                   | `--el-accent` / `--el-accent-text`, `--radius-btn`, `--height-btn-md`                            |
| Method rows                     | `Card` each                        | `--el-card`, `--el-border`, `--radius-card`; icon tile `--el-card-icon-bg` / `--el-card-icon-fg` |
| "Fastest" / "Least secure" tags | `Pill`                             | `--el-tint-mint` and `--el-surface`                                                              |
| Destination chip                | a bordered row                     | `--el-surface-soft`, `--radius-input`; kind glyph on `--el-tint-lavender`                        |
| Sign-out                        | `Button` ghost                     | `--el-text-secondary`, `--height-btn-sm`                                                         |
| The mounted 8.11 surface        | `../settings/two-factor.mock.html` | not re-specified                                                                                 |

No Tier-0 `--color-*` is referenced by any element rule (only the `:root` /
`[data-theme='dark']` token blocks define them), and no raw `rounded-*` / `p-*` /
`h-*` appears. `--el-text-faint` appears nowhere in this asset.

**The `--el-*` layer is re-declared inside `[data-theme='dark']`**, for the reason
`../org-admin/design-notes.md` records: a custom property is substituted at the
element it is DECLARED on, so a nested panel that flips `--color-*` inherits the
already-resolved LIGHT `--el-*` unless the layer is re-declared. Panel 8 needs it;
the app does not, because `data-theme` lives on `<html>` there.

### Copy strings (en — new `auth.twoFactorRequired.*` keys for MOTIR-3648)

`en` + `zh` ship together; `tests/i18n-catalog.test.ts` enforces the parity.

- Chip **"Required by {tier}"** — `{tier}` is the org or workspace NAME, from
  `mandatedBy.name`.
- Headline **"Set up a second factor to continue"**.
- Body, org **"{org} requires everyone in the organization to sign in with a
  second factor. It takes about a minute, and you will go straight back to what
  you were opening. Nothing has been deleted and you are still a member of every
  workspace you were in."**
- Body, workspace **"{workspace} requires everyone in the workspace to sign in
  with a second factor. It takes about a minute, and you will go straight back to
  what you were opening. Nothing has been deleted and your membership has not
  changed."**
- Body, both **"{org} requires everyone in the organization to sign in with a
  second factor, and {workspace} requires it too. Setting one up satisfies both.
  It takes about a minute, and you will go straight back to what you were
  opening."**
- Primary **"Choose how to set it up"**.
- Chooser headline **"Choose how to sign in"**; sub **"Any one of these satisfies
  what {tier} is asking for. You can add the others later."**
- Passkey **"Use a passkey"** · tag **"Fastest"** · **"Your device's fingerprint,
  face or PIN. Nothing to install, nothing to type, and it cannot be phished."**
- Authenticator **"Use an authenticator app"** · **"A six-digit code from an app
  like 1Password, Authy or Google Authenticator. Works with no signal."**
- Email **"Email me a code"** · tag **"Least secure"** · **"We email a code each
  time you sign in. Nothing to set up — but anyone who reaches your inbox reaches
  your account."**
- Satisfied chip **"Two-factor authentication is on"**; headline **"You're all
  set"**; body **"Your {method} will be asked for the next time you sign in.
  Taking you back to where you were going."**; primary **"Continue to {key}"**;
  secondary **"Save my recovery codes first"**.
- Way out **"Not now — sign out"** · **"You can come back and set this up any
  time you sign in."**
- Back, mid-enrolment **"← Choose a different method"**.

### ⚠️ Planning flags

1. **The destination chip needs the work item's TITLE, and the gate may not have
   it.** Panel 1 and panel 6 draw `MOTIR-1215` plus its title, which reads far
   better than a URL — but the gate knows only a path. Either MOTIR-3648 resolves
   the path to a label (a read the gate does not otherwise make, on the hot path)
   or the chip degrades to the path alone. **Drawn with the title, and the
   degraded form is the acceptable fallback** — not a reason to hold the card.
2. **"Save my recovery codes first" is 8.11's surface, offered from here.**
   Recovery codes are shown ONCE, and this is the only moment the person is
   guaranteed to be looking — but the button navigates INTO account settings,
   which the enforcement gate has just started allowing. If that ordering turns
   out to be awkward to build, dropping the button is safe: the codes are still
   offered by the enrolment flow itself.
3. **Nothing here covers a person with NO way to comply** — no phone, no
   security key, email delivery broken. The sign-out control is the whole answer
   today, and it is the honest one for this story. If support ever needs a
   per-user exemption, that is a new card and a new admin surface, not a clause
   smuggled into this screen.

---

## The sign-up agreement + the re-consent interstitial (Story 8.4 · 8.4.15)

**Asset:** `legal-agreement.mock.html` + `legal-agreement.png`. Gates
**MOTIR-1135** (capture acceptance at sign-up, re-consent on material change).
Filed by the `motir run MOTIR-657` parent run, which stopped at the design gate
rather than invent two surfaces on the strength of MOTIR-1135's _"No new design
asset"_ line.

### Two surfaces in one asset, and why they are not two assets

They are two halves of one question — what a person agrees to, and what happens
when it changes — and the answer to each constrains the other. Drawing them
apart is how the sign-up line and the interstitial end up asserting different
things about the same agreement.

### ⚠️ It does NOT touch `auth-screens.pen`

The sign-up screen's legacy source cannot be re-exported (divergence ledger row
1: the twelve PNGs still read "Prodect" because re-exporting them needs Pencil,
which is not in this repo). So the agreement element is specified HERE, in the
modern form, exactly as the area's three other HTML mocks were added.

**Which source wins for the sign-up screen, from now on.** For the two things
this asset draws — the agreement notice and where it sits in the card — **this
asset wins**, and screen 03's table above is the record of what the card held
before it. For every OTHER element of `/sign-up` (the headline, the Google
button, the OR rule, the email field, the two steps) screen 03 plus divergence 6
remain the reference, unchanged. The area therefore now specifies the sign-up
surface in two places, deliberately, and this paragraph is the boundary between
them.

### ⚠️ The render found a gap the code reading would have missed

`/sign-up` was served from `next dev` and screenshotted at 1440×1000 and 390×844
before anything was drawn, and the card measured in Chromium: 448px on
`--el-page-bg`, submit 48px (`--height-btn-lg`), the shipped legal line 13px in
`--el-text-secondary` (measured `rgb(93, 91, 84)`).

**What that settled: the shipped legal line renders on the PASSWORD step only.**
`SignUpCard`'s `step === 'password'` branch holds it; the identity step does not
— and `Continue with Google` sits on the identity step and creates an account
outright. **A person who signs up with Google is never shown the Terms at all**,
and Art. 13 transparency is owed at collection, which for that path is step 1.

The fix is placement, not new copy: the notice moves to the **card FOOT**, below
the footer prompt and outside the step branch, so both steps render it. Panel 1
draws both doors and marks the one that carries nothing today.

### THE DECISION: a passive statement at sign-up, an affirmative act at re-consent

The card that filed this one assumed a required checkbox and said outright that
choosing was this card's job. It is **not** a checkbox, for three reasons and one
measurement:

- **Consent is not the lawful basis.** The account is Art. 6(1)(b), performance
  of a contract. A tick-box is _evidence_, not a legal requirement — which the
  filing card already said.
- **Rung 1 is unanimous.** Linear, Vercel, Notion, GitHub and Stripe all state it
  passively at the submit control.
- **It adds a new failure mode** to the highest-value control in the product, in
  exchange for evidence a submit-time record already provides. Panel 4 draws that
  failure mode — the submit-blocked error the filing card asked for — as part of
  the REJECTED option rather than as something to build.
- **`SignUpCard.tsx`'s own docstring already said so**, at MOTIR-1134: _"MOTIR-1135
  owns capturing acceptance and turns this line into the statement that agreeing
  is what the button does."_ This asset is that sentence, drawn.

**The interstitial takes the opposite shape, and that asymmetry is the argument.**
There is no other act to attach the agreement to, and `content/legal/terms.md`
§14 promises outright that we _"will not treat silence as agreement to a material
change"_. A passive line on a hold screen would be exactly the silence that clause
disclaims. So the interstitial has a real primary button.

### Does it REPLACE MOTIR-1134's line, or keep it?

**KEEPS it — there is exactly ONE line and it is that one.** MOTIR-1134 shipped
`legal.signUpNotice` as a pure link, deliberately not claiming a record. This card
moves it to the card foot so both steps carry it, and changes one word: _an
account_ → _a Motir account_, which is what makes the same string read correctly
on step 1 where the Google button is the subject. **Do not add a second line.**

**The version is recorded, not printed.** MOTIR-1135 records the version served at
submit time; a semver string beside a sign-up button is noise to every reader and
evidence to none.

**The AUP is not a third link.** `content/legal/terms.md` §15 makes the Terms, the
AUP and the Privacy Policy the whole agreement, and `acceptable-use.md`'s own header
says it _"forms part of the Terms of Service"_ — so linking the Terms reaches it.
It IS listed by name on the interstitial when it is the document that moved, which
is the moment naming it carries information.

### ⚠️ THE RE-CONSENT SET IS THREE OF THE SEVEN — and every exclusion is published

`content/legal/` holds seven documents. Comparing all seven asks every user to
re-agree on every routing change. **In scope:**

| document                  | why it is in                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Terms of Service**      | the contract itself. §14 is the mechanism this screen implements                                                                           |
| **Privacy Policy**        | §12: _"where the change affects the terms you accepted, you will be asked to review them"_                                                 |
| **Acceptable Use Policy** | "forms part of the Terms of Service"; its own Changes section says material changes are _"notified under the Terms of Service"_ — it rides |

**Out of scope, each on a published ground rather than a judgement made here:**

| document                      | the ground                                                                                                                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cookie Policy**             | no cookie consent is sought at all (every cookie is strictly necessary or a preference the reader set, under the ePrivacy Art. 5(3) exemption). A future non-essential cookie brings a BANNER, which that document itself promises                                   |
| **Subprocessors**             | Terms §14 names _"a new sub-processor already covered by the Privacy Policy"_ as an example of a NON-material change that _"takes effect when published"_. DPA customers get DPA §6's thirty-day objection window instead — a bilateral notice, not an app-wide hold |
| **Data Processing Agreement** | a template, offered on request and signed bilaterally. Not part of what an individual accepts at sign-up, and amended with the customer who signed it through its own §6 / §11                                                                                       |
| **Model providers**           | `docs/decisions/legal-document-set.md` §7 (amended 2026-08-27): a factual roster that varies no commitment and _"carries no notice period"_                                                                                                                          |

**The subprocessor list was the one the filing card called "genuinely arguable"
and said the mock need not resolve.** It is resolved, because the shipped Terms
resolve it in as many words. Panel 9 draws all four exclusions on screen so the
decision cannot be lost in prose.

### ⚠️ THE TRIGGER IS MATERIALITY, NOT A VERSION COMPARISON

MOTIR-1135's build notes say to prompt _"when the current document version exceeds
the user's accepted version"_. **That contradicts the document it is implementing.**
Terms §14 promises that non-material changes — _"clarifications, corrections, a new
sub-processor already covered by the Privacy Policy"_ — **take effect when
published**, with no prompt. A bare `>` comparison prompts on every typo fix, which
is both a worse product and a promise broken in the direction that annoys everyone.

**The convention this asset specifies, and it needs nothing new:** the front matter
already carries semver (`version: 1.0.0` in all seven files, parsed by
`lib/legal/documents.ts`).

- **MAJOR or MINOR bump ⇒ MATERIAL.** Prompts.
- **PATCH bump ⇒ NON-MATERIAL.** Takes effect when published. Silent.

Panel 6 draws the rule working: the Acceptable Use Policy also moved in that
fixture, `1.0.0 → 1.0.1`, and is deliberately absent from the list.

### What a person can still do behind it

The product is **unreachable** — it is a hold, and it wears the `(auth)` frame for
the reason `two-factor-required.mock.html` records: drawing a hold inside the app
shell advertises everything the person cannot reach, and a shell that renders is a
shell whose data was loaded. **Two exceptions, both load-bearing:**

1. **The legal pages themselves stay reachable**, signed in or out. You cannot ask
   somebody to accept a document you will not let them open. Panel 8 shows the
   signed-out card still linking to it.
2. **Sign-out is always available.** Panel 8.

### The three exits, and they are three different things

| exit                   | what it is                       | what happens                                                                                  |
| ---------------------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| **Agree and continue** | the affirmative act §14 requires | the version + timestamp are recorded and the person lands back where they were going          |
| **Not now — sign out** | DEFERRING, not declining         | nothing is recorded, nothing changes, the same screen appears at the next sign-in             |
| **I don't accept**     | DECLINING                        | panel 7 — the consequence §14 already promises, and two routes. **Nothing is destroyed here** |

**Deferring is the ghost button in the foot**, on every held panel, never competing
with the primary action — the same shape and the same reasoning as
`two-factor-required.mock.html`'s way out. The line under it removes the fear that
leaving costs something.

**Declining is drawn whole, because it is the half most likely to be skipped and
the half a regulator reads first.** A decline path that silently does nothing is
worse than no decline path. The screen states the outcome the Terms already promise
— _"If you do not accept it, you may terminate and receive a pro-rata refund of
prepaid fees for the unused period"_ — and offers export-first then close-account,
in that order, plus **legal@motir.co** for a person who would rather talk to
someone. It is `content/legal/terms.md` §15's own notice address.

### ⚠️ It MOUNTS the export / delete surface; it does not redraw it

Panel 7's dashed outline is review chrome, not a border to build. Both decline
routes lead to the account surface that owns them — MOTIR-1136's, designed in
**8.4.16 (MOTIR-3680)** under the account-settings area. Drawing an export flow
here would build it twice and drift from the real one.

### Which documents changed, on screen

_"A person asked to re-accept is owed a link to what changed."_ Each changed
document is a row carrying its title, its version delta as a mono chip, a
one-sentence summary of what moved, and a link to the new version. **The summary
needs a front-matter key that does not exist yet** — see the planning flags.

### The arrival, and the departure

Nobody navigates here; they are held on their way somewhere. Panel 5 draws the
arrival as a four-step flow with a concrete case and the departure back to the same
URL. **The same-origin validation the 2FA-required screen's notes spell out applies
verbatim** — a leading `/`, no scheme, no `//`, no `..`, and a fixed safe fallback
otherwise. Never a generic dashboard.

### ⚠️ NOT an error state

**No `--el-danger` fill, no red banner, no alert role anywhere in this asset.**
Nothing has gone wrong: a document was updated. The pills carry their hue in the
tint BACKGROUND with `--el-text-strong` ink — `--el-tint-sky` for _takes effect_,
`--el-tint-mint` for _signed out_ — which is also what keeps them AA in both
themes. The only `--el-danger` on the board is the submit-blocked error inside
panel 4, which is drawn as the REJECTED option.

**And no copy implies a deadline** beyond the effective date the Terms themselves
carry. No string says "or else", and none counts down.

### Panels

| #   | panel                         | what it shows                                                               |
| --- | ----------------------------- | --------------------------------------------------------------------------- |
| 1   | **Where the notice goes**     | both account-creating controls, and the one carrying nothing today          |
| 2   | **Sign-up · identity step**   | the notice at the card foot — the Google path covered                       |
| 3   | **Sign-up · password step**   | MOTIR-1134's line kept, re-worded, re-placed                                |
| 4   | **The rejected tick-box**     | unchecked / checked / submit-blocked, and why it is not what ships          |
| 5   | **Re-consent · one document** | the held screen, and the arrival drawn as a flow                            |
| 6   | **Re-consent · several**      | one agreement covering all, and the PATCH change deliberately not listed    |
| 7   | **Declining**                 | the §14 consequence, and the two routes — nothing destroyed here            |
| 8   | **Deferring**                 | signed out, nothing changed, the document still readable                    |
| 9   | **What does NOT trigger it**  | the four excluded documents, each with its published ground                 |
| 10  | **Mobile (390px)**            | a width, not a second design — with one measurement that came out otherwise |
| 11  | **Dark**                      | both surfaces, tokens flipped                                               |
| 12  | **Sign-up · UNCONFIGURED**    | the notice ABSENT, and what its hairline leaving does to the card foot      |
| 13  | **Sign-up · CONFIGURED**      | the same notice with OFF-HOST links, and the external-link treatment        |
| 14  | **The rail's bottom section** | with the Legal row and without it, side by side — the difference is one row |
| 15  | **Re-consent · UNCONFIGURED** | the row with no way out, drawn as the CLOUD MISCONFIGURATION it is          |

### Per-control map — primitive, tokens

| element                  | primitive                    | colour                                                                           | shape                              |
| ------------------------ | ---------------------------- | -------------------------------------------------------------------------------- | ---------------------------------- |
| page + card              | `app/(auth)/layout.tsx`      | `--el-auth-wash` page, `--el-page-bg` card, `--shadow-elevated`                  | `--radius-card`                    |
| brand lockup             | `BrandMark size={28}`        | glyph `--el-accent`, wordmark `--el-text`                                        | —                                  |
| headline + subhead       | `AuthShell`                  | `--el-text` / `--el-text-muted` (on the white card — AA 4.54)                    | —                                  |
| **the agreement notice** | a `p`, NOT a control         | `--el-text-secondary`, links `--el-link`; a `--el-border` rule above it          | `13px`, card foot                  |
| Google button            | `GoogleButton`               | `--el-button-border`, Google's own four-colour glyph                             | `--radius-btn`, `--height-btn-lg`  |
| email / password field   | `Input` + addonStart         | `--el-input-border`; placeholder `--el-text-muted` on `--el-page-bg`             | `--radius-input`, `--height-input` |
| email recap row          | a display row, not a control | `--el-surface`; its glyph `--el-text-secondary`, NOT muted                       | `--radius-input`, `--height-input` |
| "takes effect" chip      | `Pill`                       | `--el-tint-sky` background, `--el-text-strong` ink                               | `--radius-badge`                   |
| "signed out" chip        | `Pill`                       | `--el-tint-mint` background, `--el-text-strong` ink                              | `--radius-badge`                   |
| changed-document row     | `Card`                       | `--el-card` + `--el-border`; icon tile `--el-card-icon-bg` / `--el-card-icon-fg` | `--radius-card`                    |
| the version delta chip   | a mono chip                  | `--el-code-bg` / `--el-code-text`                                                | `--radius-control`                 |
| Agree and continue       | `Button` primary             | `--el-accent` / `--el-accent-text`                                               | `--radius-btn`, `--height-btn-md`  |
| Not now — sign out       | `Button` ghost               | `--el-text-secondary`                                                            | `--height-btn-sm`                  |
| decline routes           | `Card` each                  | as the document rows                                                             | `--radius-card`                    |
| excluded-document row    | a quiet row                  | `--el-surface-soft`, ink `--el-text-secondary`                                   | `--radius-card`                    |
| the REJECTED tick-box    | `Checkbox`                   | on: `--el-accent` + `--el-accent-text`; invalid border `--el-danger`             | `--radius-xs`                      |

No Tier-0 `--color-*` is referenced by any element rule (only the `:root` /
`[data-theme='dark']` token blocks define them), and no raw `rounded-*` / `p-*` /
`h-*` appears on a control's own box. **`--el-text-faint` appears nowhere.**
`--el-text-muted` appears in exactly two rules, both resolving against
`--el-page-bg` (the white card), which is the one surface it clears AA on.

**The `--el-*` layer is re-declared inside `[data-theme='dark']`** for the reason
this area's other assets record: a custom property is substituted at the element it
is DECLARED on, so panel 11's nested board would otherwise inherit the resolved
LIGHT values. In the app `data-theme` lives on `<html>`.

### Copy strings

**Sign-up** — the existing `legal.signUpNotice`, one word changed:

- `legal.signUpNotice` — **"By creating a Motir account you agree to our
  &lt;terms&gt;Terms of Service&lt;/terms&gt; and &lt;privacy&gt;Privacy
  Policy&lt;/privacy&gt;."** (was _"an account"_.) The `zh` twin moves with it
  (`tests/i18n-catalog.test.ts`).

**Re-consent** — new `legal.reconsent.*` keys for MOTIR-1135. Every `en` key needs
its `zh` twin.

- Chip **"Takes effect {date}"**.
- Headline, one document **"We've updated our {document}"**; several **"We've
  updated {n} of our documents"**.
- Body **"We won't treat carrying on in silence as agreement, so we're asking you
  to read what changed and say yes. Nothing has been deleted, your projects and
  workspaces are untouched, and your subscription has not changed."**
- Row link **"Read the new version →"**.
- Primary **"Agree and continue"** / **"Agree to both and continue"** /
  **"Agree to all and continue"**.
- Way out **"Not now — sign out"** · **"We'll ask again the next time you sign in.
  Or {decline}."** · decline link **"tell us you don't accept"**.
- Signed-out headline **"No problem — take your time"**; body **"You've been signed
  out and nothing has changed. We'll ask again the next time you sign in, and you
  can read the new Terms whenever you like."**; link **"Read it without signing in
  →"**; primary **"Back to sign in"**.
- Decline headline **"If you don't accept, you can close your account"**; body
  **"Your Terms say that if you don't accept a material change you may end your
  agreement and get back the unused part of anything you've prepaid. That's still
  true — and nothing happens on this screen until you choose it."**
- Decline routes **"Download your data first"** / **"Your projects, work items,
  comments and attachments, as a file you keep. Do this before you close
  anything."** · **"Close my account"** / **"We'll show you exactly what goes and
  what your workspaces keep, and ask you to confirm, before anything is deleted."**
- Decline foot **"Would rather talk to a person about it? Write to legal@motir.co
  and we'll answer."** · back **"← Back"**.

### Accessibility

Everything the area's a11y section states holds. Four additions:

- **The agreement notice takes no focus of its own** — it is a paragraph, and only
  its two links are focusable. It is last in the DOM, so `autoFocus` on the email
  field is unaffected and a reader who types straight away never meets it.
- **The held screen is not an alert.** No `role="alert"`, no `aria-live`: nothing
  has gone wrong, and announcing a policy update as an error is both wrong and
  alarming. It is an ordinary page with an `h1` that says what it is.
- **One agreement, one control.** A per-document tick-box would ask for three
  decisions where the product offers one outcome, and each would need its own
  label. The button's own words carry the scope (_"Agree to both and continue"_).
- **The version delta chip is not the only carrier.** The row's title names the
  document and the summary says what moved, so a reader who never resolves
  `1.0.0 → 2.0.0` still knows what they are agreeing to.

### ⚠️ Planning flags for MOTIR-1135

1. **The materiality signal has to be WRITTEN somewhere, and today it is not.**
   The semver convention above is the cheapest form — it needs no new field, and
   `lib/legal/documents.ts` already parses `version`. But **nothing enforces that
   an author bumps the right component**, and the whole promise rides on it. Either
   MOTIR-1135 adds the check to `tests/legal/` (a version bump whose component
   disagrees with the diff's size is at least a prompt to think), or the risk is
   accepted and written down. Do not leave it implicit.
2. **The per-document "what changed" summary needs a front-matter key.**
   `changeSummary:` (or `summary:`) beside `version:` / `effectiveDate:` — a
   one-sentence, human-written line. `parseLegalDocument` is fifteen lines and
   takes another scalar for free. **Drawn with the summary; the degraded form —
   the version delta and a link, with no sentence — is an acceptable fallback**,
   not a reason to hold the card. It is the same shape as the 2FA screen's
   destination-chip flag.
3. **The gate needs the current path, and the mechanism already exists.**
   `two-factor-required.mock.html`'s notes record `x-current-path` (MOTIR-3652) as
   the carrier and the same-origin validation the consumer owes. **This screen is
   the second consumer of that header.** If the 2FA gate ships first, reuse it; if
   this one does, expect the other to.
4. **Two gates will want the same slot.** Both this and 2FA-required hold an
   authenticated reader at the app's front door, in the same `(auth)` frame, on the
   same redirect. **Order them once, deliberately** — the recommendation is 2FA
   first (it is about who is signing in) and re-consent second (it is about what
   they are agreeing to), and a person who owes both should not meet two full-page
   holds in a row without the second saying so. That ordering is a decision
   MOTIR-1135 should record, not discover.
5. **Self-host.** MOTIR-1135's own criteria already say gating keys off the CLOUD
   document version. Nothing on this screen changes for a self-hoster except that
   it should not appear at all: their operator sets their own terms, and
   ~~`content/legal/` ships as our copy of ours~~ — **⚠️ AMENDED 2026-09-01
   (MOTIR-4006): that last clause is now false.** `content/legal/` LEAVES this
   repository; `motir-core` reads a configured manifest instead, and an
   unconfigured build has no documents at all. The gate is still `MOTIR_CLOUD`-only,
   so this screen still never appears for a self-hoster — the reason is unchanged
   and the mechanism underneath it is not. See the amendment below.

### ⚠️ AMENDMENT 2026-09-01 (MOTIR-4006) — the UNCONFIGURED arm, once the documents leave

This asset drew one world: `motir-core` ships the seven legal documents and every
surface links to them. MOTIR-3909 takes the documents out and replaces them with a
**configured manifest**, so the repository gains a state it has never had — **no legal
documents at all** — and it is not an edge case. It is what every self-hosted build
shows on day one, which makes it the COMMON case for the open product.

Panels 12–15 draw the second arm of each surface. The decisions they carry are
`docs/decisions/public-surface-hosts.md` **AMENDMENT 2**'s (MOTIR-4004); this asset
draws them rather than deciding them.

#### The sign-up notice is ABSENT, not re-flowed — and that was the open question

The card that commissioned this amendment left the choice open: _"decide and draw
whether the sentence disappears entirely or re-flows to a shorter form."_ **The
record decided it, in §D: the whole paragraph does not render.**

The reason is the sentence itself. `legal.signUpNotice` is _"By creating a Motir
account you agree to our `<terms>`Terms of Service`</terms>` and
`<privacy>`Privacy Policy`</privacy>."_ — a sentence **entirely about two
documents**. Turn the links into plain text and it does not become a weaker notice;
it becomes a **false one**, asserting that the reader has agreed to documents nobody
published. A self-hoster has no Terms of Service, and the honest sign-up form is one
that does not claim otherwise.

Three consequences worth stating, because each is a thing a builder might otherwise
add:

- **No new copy string, and therefore no `zh` twin.** An absent paragraph needs no
  words. `legal.signUpNotice` survives unchanged for panel 2's case, and the
  catalogue-parity gate has nothing new to check. A card that finds itself authoring
  a string for this arm is building the superseded shape.
- **What moves is the card FOOT, not the sentence.** The notice sat under a
  `border-top` at `padding-top: 16px`, so removing it takes a hairline away as well
  as a paragraph — the card ends on _"Already have an account?"_ with the body's own
  bottom padding as its closing space. That is the entire visible change and panel 12
  is what a reviewer checks it against.
- **The assertion is the paragraph's ABSENCE.** Not "the anchor is missing", which a
  re-flowed sentence would also satisfy.

#### The links now LEAVE the application — panel 13

Panel 2's links are same-origin. After MOTIR-3909 they are **absolute URLs on
whatever host the operator publishes**, which for the hosted service is
`motir.co` — a different application. Panel 13 gives them the shipped external-link
treatment: lucide `external-link` at **13px**, inline after the label, **in the
link's own colour** so it reads as part of the link rather than as an adjacent
control. That mirrors `components/github/DevelopmentSection.tsx`, which is where it
ships today. (A second instance lived in the establish step's repository row until
MOTIR-5014 deleted the technical path with it.)

The anchors are plain `<a>`, **not** client-navigating links: a cross-origin
`next/link` looks identical until it is used. The decision is made once here rather
than three times in three components.

#### ⚠️ The rail's two arms are drawn HERE, and the reason is a defect in the other area

The card said to draw the rail's absent arm _"in whichever asset owns the rail's
bottom section — `design/shell/` if it draws it, `design/auth/` otherwise — and the
notes say which and why."_ **It is `design/auth/`, and this is the why.**

`design/shell/` owns the rail, and its sources do not draw the row. Counted over the
`.pen` files:

| asset                   | `Legal` | `Docs` | `Git` |
| ----------------------- | ------- | ------ | ----- |
| `desktop.pen`           | **0**   | 1      | **0** |
| `mobile-drawer.pen`     | **0**   | 1      | **0** |
| `desktop-collapsed.pen` | **0**   | 0      | **0** |

`desktop.pen`'s nav frames are `Dashboard · Issues · Boards · Reports · Settings ·
Docs`. **An asset that never drew the Legal row cannot draw its ABSENCE as a state** —
an absence is only specifiable against a presence — so re-specifying the rail inside
a stale source would have made the two disagree twice over. Panel 14 is therefore the
interim source for this row's two arms, and the staleness is filed as
**MOTIR-4130**, which supersedes panel 14 when it lands.

Panel 14 is **cropped to the last three rows** of that section — Git, Docs, Legal, in
`SidebarNav.tsx` declaration order — because those are the rows the change is about;
Security and Job runs sit above them and neither moves. The two rails are side by side
because the difference is exactly one row, and that is the whole specification: the
row is **absent**, not disabled and not empty-stated. Nothing else re-centres, and the
separator above the section stays. **If the section were ever to empty entirely**, the
section and its separator go with the last row — a rail does not render an empty group
under a hairline.

#### ⚠️ Panel 15 is a MISCONFIGURATION, and the label is load-bearing

The re-consent screen is reachable only on a cloud build:
`lib/legal/reconsentGate.ts`'s `isMotirCloud()` returns early otherwise, so a
self-hosted deployment never renders it. A cloud build holding a reader while its
manifest carries no `url` for that document is therefore **misconfigured** — it is not
the ordinary unconfigured state panels 12 and 14 draw, and drawing it as one would
teach a builder to treat a fault as a supported mode.

The row keeps everything that identifies the change — the name, the version delta, the
author's sentence — because all of those come from the manifest entry. What is missing
is the way OUT: no _"Read the new version →"_. **That is uncomfortable and it is
correct**: a person is being asked to agree to a change they cannot read, and the
drawing should say so rather than hide it. The row does **not** invent a fallback link
and does **not** render an "unavailable" string — a legal notice that explains our
operational problem to the reader has put the wrong thing on their screen.

Where the operator is told instead: AMENDMENT 2 §C makes this a **named condition** —
a manifest whose rejected entry is one of the three re-consent slugs is reported as
_faulted_ by the deployment's health surface, never as _unconfigured_. The reader gets
a row that still says what changed; the operator gets the alarm.

#### Measured, not asserted

Rendered with the repository's own chromium at `deviceScaleFactor: 1`:

| measurement             | 1280×800                          | 390×844                                     |
| ----------------------- | --------------------------------- | ------------------------------------------- |
| the auth card           | **448 × 563**                     | 292 × 643                                   |
| the rail                | **252 × 144**                     | 252 × 144 (unchanged — it is a fixed width) |
| a rail row              | **228 × 36** (`--height-control`) | 228 × 36                                    |
| the rail row's icon     | **18 × 18**                       | 18 × 18                                     |
| the external-link glyph | **13 × 13**                       | 13 × 13                                     |
| panel 14                | 1080 × 164                        | **342 × 316**                               |
| document height         | 11 308                            | 18 478                                      |

**The fold is the viewport height** — 800 and 844 — and this asset is a panel board
rather than a screen, so no panel is expected to fit it; each panel is read on its own
and every one is shorter than the fold except the full auth cards, which is how panels
2–11 already behave.

**One thing the measurement changed.** At 390 the two rails side by side came to
532px against a 342px panel and overflowed. `.railpair` now carries `flex-wrap: wrap`,
so they stack — panel 14 goes 164px tall to 316px — and the comparison survives at
both widths. The rail itself does **not** narrow, deliberately: 252px is its shipped
width, and at 390 the real product shows a drawer rather than a sidebar
(`design/shell/mobile-drawer.pen`), which is a different surface this panel does not
claim to draw.

AA contrast is asserted by `tests/design-ink-contrast.test.ts` over `design/**`, green
in this branch's `vitest --config vitest.design.config.ts` run (7 files, 90 tests) —
so the new panels' inks are measured by the lane rather than by this note.

#### The GIVES / TAKES sweep

Run over every `MOTIR-<n>` this asset names, bounded by MOTIR-3909's subtree rather
than by the asset's own key list.

| card                                     | GIVES                                                                              | TAKES                                                                                                                                                                       | acted on                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **MOTIR-4010** (the three link surfaces) | panels 12–14: the absent notice, the off-host glyph, the rail's one-row difference | **YES — it TAKES the new copy string.** The card said its unconfigured arm was _"the one piece of new copy here"_ and needed a `zh` twin; §D's omission means there is none | `update_work_item` — done 2026-09-01, before this asset was drawn                              |
| **MOTIR-4015** (the E2E)                 | panel 12 is what step 1 asserts against                                            | **YES — the assertion changes kind**, from _"reads as a finished sentence"_ to _"the paragraph is not in the tree"_                                                         | `update_work_item` — done 2026-09-01                                                           |
| **MOTIR-4007** (the manifest reader)     | panel 13's `url` is the field it must carry per entry                              | no                                                                                                                                                                          | —                                                                                              |
| **MOTIR-1135**                           | planning flag 5's last clause                                                      | **YES — the premise it rests on is retired** (`content/legal/` leaves)                                                                                                      | flag 5 amended above; the card is `done`, so it is amended in place here rather than re-opened |
| **MOTIR-4130**                           | panel 14, as the interim source for the rail's two arms                            | no — it is a defect this asset FOUND, not scope taken from it                                                                                                               | filed 2026-09-01                                                                               |

**Nothing else in the subtree is touched by this asset.** MOTIR-4014's clauses are
about the manifest seam and are unaffected; MOTIR-4011 is `motir-marketing`'s.

### ⚠️ Planning flags for MOTIR-4006

1. **`design/shell/`'s rail sources were short of what ships — MOTIR-4130. ✅ RESOLVED
   2026-09-02, and this flag's own count was wrong.**
   The flag said _"two rows short"_ (`Git` and `Legal`), and said a `Settings` row was
   drawn that the shipped bottom section does not carry in that position. **Both halves
   were wrong, and in opposite directions.** Re-measured at `8d80ac8db`: the section
   ships **six** rows — `Settings` · `Security` · `Job runs` · `Git` · `Docs` · `Legal` —
   so the three `.pen` assets were **four** rows short, not two; and **`Settings` IS the
   section's first row**, so the assets drawing it were right about that one. The
   miscount is filed as MOTIR-4163: this flag enumerated the rows whose provenance it
   already held rather than reading the section.
   **The toolchain question is ANSWERED: the `.pen` route is closed.** No renderer or
   exporter for `.pen` exists anywhere in the repository, and `package.json` carries no
   Pencil dependency — the only renderer is `scripts/render-design-mock.mjs`, which takes
   `*.mock.html`. So MOTIR-4130 took the `*.mock.html` route this area's siblings took,
   and edited no `.pen`.
   **The outcome:** `design/shell/rail-bottom-section.mock.html` is now the design of
   record for that section, drawing all six rows at all three widths with every
   conditional row in both arms. Its divergence ledger records which source wins.
   **Panel 14 of `legal-agreement.mock.html` is SUPERSEDED for the rail's two arms** and
   stands as this area's record of the sign-up and re-consent surfaces; a reader asking
   what the rail's bottom section carries reads `design/shell/` now.

### Self-review

- The affordance is a paragraph, not a control, so it cannot grow a validation
  state later without somebody deciding to make it one.
- The one place a tick-box IS right — the interstitial — has an affirmative button
  rather than a tick-box plus a button, which would be two acts for one decision.
- Every exclusion in the re-consent set quotes a document we are bound by, so a
  future reader can check the reasoning against the source rather than against
  this file.
- Panel 10 records a measurement that came out AGAINST what the panel note first
  claimed, and the note was corrected rather than the panel.
- Every icon is a lucide path at `viewBox="0 0 24 24"`, sized by CSS; the brand
  glyph and the Google mark are the shipped path data, not stand-ins.
- No nested interactive elements. The three affordances that change the card's own
  state rather than navigating are `button`s styled as links, not anchors with an
  address that does not exist.

---

## OAuth consent

**Asset:** `oauth-consent.mock.html` (HTML mock, 13 panels) · **Card:** MOTIR-6980 ·
**Builds it:** [Build the CONSENT screen](motir:cmunc4k9p0042hvshn0qwwipj) (MOTIR-6985) ·
**Story:** MOTIR-6973.

A **NEW surface**, and the first design of an app-authorization screen: no route of
this family exists on `origin/main` `20903a65d`, and `list_designs` held no published
design for the one precedent, the CLI's device approval (`app/(auth)/device/`). It is
the page a person's browser lands on when an MCP client (Claude Code, claude.ai, the
Claude apps, Cowork, any OAuth MCP client) asks to connect to Motir: which app is
asking and where it will return, **one** workspace, all projects or one, the grant in
the token picker's own columns and words, and Approve / Deny.

It is **composed, not redesigned**. The frame is the shipped `(auth)` layout; the
detail box, callouts, Deny composition and name-only permission rows are
`DeviceApproval`'s; the grant is the create-token modal's picker
(`CreateTokenModal.tsx`, authority `../settings/permission-columns.mock.html`); the
controls are the design-system primitives. Nothing in the mock is a new primitive.

### The route, and how it is reached

- **Route: app.motir.co/oauth/consent** (the consent page MOTIR-6982 configures on the
  provider), rendered in the `(auth)` route group — NOT `(authed)`, for the reason
  `app/(auth)/device/page.tsx` gives: the `(authed)` layout redirects, and the page
  must render its own signed-out and refused states. It is written unquoted in this
  file on purpose — `tests/design-asset-addresses.test.ts` fails an asset that quotes
  an address no route serves yet; MOTIR-6985 creates the route and may quote it.
- **Nobody navigates to it inside Motir.** No nav entry, no link, ever — the /device
  rule. Its only door is the client's browser redirect: the client discovers Motir's
  sign-in from the MCP's 401, registers itself (RFC 7591), and opens the authorize
  endpoint; **a signed-in person's valid request is redirected to the consent page
  with the request intact** (MOTIR-6982's AC). Panel 0 draws that door from both
  Claude Code (terminal → system browser) and claude.ai (Connectors → Connect → new
  tab), in browser chrome showing the URL arriving.
- **Signed out** → the authorize endpoint sends the browser to the shipped sign-in
  page (Better-Auth's `loginPage`), with the WHOLE authorize URL encoded into `next`;
  after sign-in (password, Google, passkey, 2FA as usual) it returns to authorize,
  which re-validates and redirects to consent (Panel 5).
- **The exit** is the redirect back to the client's registered `redirect_uri` — with
  `code` + `state` on Approve (Panel 9), with `error=access_denied` + `state` on Deny
  and on the no-workspace Deny (Panels 6, 10). The refused-request page (Panel 7) is
  the one state with NO exit redirect.

### Which card specifies each behaviour

| Behaviour drawn                                                                                                                                                                                                | Specified by                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| The reach choice — **All projects** (fixed `DEFAULT_TOKEN_GRANT`, no project) or **One project** (a chosen subset of `grantableFor(held in that project)`); one workspace per connection; what Approve records | [A connection IS a grant](motir:cmunc4k7k003yhvshih02on3t) (MOTIR-6983), on `docs/decisions/token-permissions.md` Amendment 1 |
| The grant's rendering — the picker's two columns, catalog domain groups, shipped `permissions.*` copy, locked rows, the irreversible key's danger card                                                         | [the token-permission picker](motir:cmta33s2l007si3phwbk1ccnc) (MOTIR-3580) → `../settings/permission-columns.mock.html`      |
| What makes a request invalid — unknown client, `redirect_uri` not registered, PKCE missing or not S256, `resource` not the MCP; and that such a request never reaches consent                                  | [The OAuth authorization server](motir:cmunc4k6j003whvshsn8ba41w) (MOTIR-6982)                                                |
| Signed-out → sign-in → back with the request intact; Deny → `access_denied`, nothing stored; no workspace → Deny only; the unverified label for a dynamically registered client                                | [Sign in with Motir from Claude](motir:cmunc4jqf0032hvsh1yfzv3ju) (MOTIR-6973, the story) and this card                       |
| The Connected apps pane the foot line points at                                                                                                                                                                | [CONNECTED APPS on Account settings](motir:cmunc4k5b003uhvsh2uh5gjcw) (MOTIR-6981) — not drawn here                           |

### Panels

| #   | State                                                                                | Primitives composed                                                                                    |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 0   | The entrance — Claude Code and claude.ai → authorize → consent                       | review chrome only (terminal stand-in, URL bars)                                                       |
| 1   | Consent · one workspace · all projects · unverified self-registered Claude Code      | `(auth)` wide frame, `AuthShell tight`, detail box, `Pill`, `Segmented`, fixed grant rows, `Button` ×2 |
| 2   | Consent · several workspaces · the picker OPEN · Claude on claude.ai                 | + `Combobox` trigger and its `Popover` listbox                                                         |
| 3   | Consent · One project · a narrowed grant (3 locked rows, 2 switched off, Delete off) | + project `Combobox`, the picker's `Switch` rows, the danger card                                      |
| 4   | The app row · unverified (dynamic registration) vs pre-registered                    | detail box only                                                                                        |
| 5   | Not signed in → the sign-in card with the carried banner → back                      | `(auth)` narrow frame + lockup, `AuthShell`, `IdeaCarried`                                             |
| 6   | No workspace · or none it could act in → Deny only (two copies)                      | `AuthShell`, warn `Callout`, Deny `Button` full width                                                  |
| 7   | Invalid request → an error page that does NOT redirect, + the four reasons' copy     | `AuthShell`, danger `Callout`, `CodeChip`, secondary `Button`                                          |
| 8   | Submitting                                                                           | `Button loading` + disabled Deny                                                                       |
| 9   | Approved + the exit redirect (loopback and claude.ai)                                | `AuthShell`, success `Callout`, secondary `Button`                                                     |
| 10  | Denied + the exit redirect                                                           | `AuthShell`, danger `Callout`                                                                          |
| 11  | Narrow viewport, 375px                                                               | Panel 1, stacked                                                                                       |
| 12  | Dark parity — Panel 3 on `data-theme="dark"`                                         | —                                                                                                      |

### The frame

- **Consent (Panels 1–3, 8, 11, 12)** renders `data-auth-wide`, exactly as the
  /device confirm step does: the `(auth)` column widens `max-w-[28rem]` →
  `max-w-[40rem]`, the page and card padding tighten (`py-8`, card `py-5 sm:px-8`),
  and the brand lockup is suppressed. Page `bg-(--el-auth-wash)`; card
  `bg-(--el-page-bg) rounded-(--radius-card) shadow-(--shadow-elevated)`.
  `AuthShell tight`: headline `font-serif text-2xl font-semibold text-(--el-text)`,
  subhead `text-sm text-(--el-text-muted)` (legal: it sits on the white card, 4.54:1).
- **Every other state (Panels 5, 6, 7, 9, 10)** is the ordinary 28rem `(auth)` card
  with the 28px lockup and the default `AuthShell` (4xl/5xl serif headline, gap-8) —
  the /device terminal-state composition (`TerminalState`), announced through a
  `role="status" aria-live="polite"` wrapper.
- **Fold.** Unlike /device, this screen does not fit 648px, and it is not asked to:
  the All-projects grant is fourteen name-only rows. The summary line directly above
  the buttons restates the whole decision, so a reader who scrolls straight to
  Approve still reads what they are approving.

### Per element — consent (Panels 1–3)

| Element                       | Primitive / markup                                                                                                                     | Colour (`--el-*`)                                                                                                                                                                             | Shape / size token                                                                                       | Copy                                                                                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Headline                      | `AuthShell tight` `h1`                                                                                                                 | `--el-text`                                                                                                                                                                                   | —                                                                                                        | **Connect {app} to Motir?**                                                                                                                                                                                  |
| Subhead                       | `AuthShell` `p`                                                                                                                        | `--el-text-muted` on the white card                                                                                                                                                           | —                                                                                                        | It will act as you, in the one workspace you choose. Check each part before you approve.                                                                                                                     |
| Detail box                    | /device `DetailColumn` ×2 + `DetailBlock`; `sm:grid-cols-2`                                                                            | border `--el-border`; inner hairlines `--el-border-soft`                                                                                                                                      | `rounded-(--radius-card)`                                                                                | —                                                                                                                                                                                                            |
| Block keys                    | `DetailBlock` label, 11px uppercase semibold                                                                                           | `--el-text-muted` (white card only)                                                                                                                                                           | —                                                                                                        | APP ASKING · RETURNS YOU TO · YOU · WORKSPACE                                                                                                                                                                |
| App tile                      | a 32px letter tile — the app name's first letter                                                                                       | bg `--el-card-icon-bg`, glyph `--el-card-icon-fg`                                                                                                                                             | `rounded-(--radius-control)`                                                                             | —                                                                                                                                                                                                            |
| App name                      | `text-sm font-medium`                                                                                                                  | `--el-text`                                                                                                                                                                                   | —                                                                                                        | the client's registered `client_name`, rendered as DATA (escaped, never markup)                                                                                                                              |
| Unverified marker             | `Pill tone="warning"` + lucide `ShieldAlert` 12px                                                                                      | bg `--el-tint-peach`, ink `--el-text-strong`                                                                                                                                                  | `rounded-(--radius-badge)`, `px-(--spacing-chip-x) py-(--spacing-chip-y)`                                | **Unverified**                                                                                                                                                                                               |
| App sub-line — dynamic        | `DetailSub`                                                                                                                            | `--el-text-muted`                                                                                                                                                                             | —                                                                                                        | It registered itself, so this name is its own claim. Motir hasn’t reviewed this app.                                                                                                                         |
| App sub-line — pre-registered | `DetailSub` (no marker)                                                                                                                | `--el-text-muted`                                                                                                                                                                             | —                                                                                                        | Registered with this Motir ahead of time — not by itself.                                                                                                                                                    |
| Returns-to value              | lucide `Laptop` (loopback) / `Globe` (https) + the redirect's HOST                                                                     | glyph `--el-text-muted`, host `--el-text`                                                                                                                                                     | —                                                                                                        | **localhost** / **claude.ai** — the host of the request's `redirect_uri`                                                                                                                                     |
| Returns-to sub — loopback     | `DetailSub`                                                                                                                            | `--el-text-muted`                                                                                                                                                                             | —                                                                                                        | An app on this computer. Approve only if you just asked {app} to connect.                                                                                                                                    |
| Returns-to sub — https        | `DetailSub`                                                                                                                            | `--el-text-muted`                                                                                                                                                                             | —                                                                                                        | You’ll be sent to {full redirect_uri}                                                                                                                                                                        |
| You                           | /device WHO block: 32px avatar (`bg-(--el-text) text-(--el-text-inverted)`), name, email                                               | name `--el-text`, email `--el-text-muted`                                                                                                                                                     | `rounded-full` (avatar)                                                                                  | Not you? **Sign out** and sign in as them. — the /device `confirm.notYou` copy; Sign out returns to sign-in with the request in `next`                                                                       |
| Workspace — one               | plain value                                                                                                                            | `--el-text`                                                                                                                                                                                   | —                                                                                                        | {org} · {workspace} / sub: Your only workspace.                                                                                                                                                              |
| Workspace — several           | `Combobox` (trigger `h-(--height-control)`, `px-(--spacing-control-x)`); options `org · workspace`; opens on the last-active workspace | trigger `--el-page-bg` / `--el-border`; open ring `--focus-ring-color`; listbox `Popover` `--el-page-bg`, `--shadow-elevated`, highlighted row `--el-surface`, check `--el-accent-on-surface` | trigger `rounded-(--radius-input)`; listbox `rounded-(--radius-card)`; rows `rounded-(--radius-control)` | accessible name: Workspace {app} can act in / sub: You belong to {n} — it acts in this one only.                                                                                                             |
| Reach label + help            | the modal's field label + helper                                                                                                       | label `--el-text`, help `--el-text-muted`                                                                                                                                                     | —                                                                                                        | **Where it can act** / All: Every project in {workspace} you can open. In each one it can also do no more than your role there allows. / One: Only the project you pick, with the permissions you switch on. |
| Reach control                 | `Segmented`, two options, `role="radiogroup"`; defaults to **All projects**                                                            | track `--el-tabnav-track`, border `--el-border`; pressed `--el-page-bg` + `--el-text-strong` + `--shadow-subtle`; idle `--el-text-secondary`                                                  | `rounded-(--radius-btn)`, segments `h-(--height-control)`                                                | **All projects** · **One project**                                                                                                                                                                           |
| Project (One project only)    | `Combobox`, options `KEY — Name`, default = the active project (MOTIR-4876), then the first                                            | as the workspace trigger                                                                                                                                                                      | as above                                                                                                 | label **Project** / sub: {app} acts in this project only.                                                                                                                                                    |
| Grant label + help — All      | field label + helper                                                                                                                   | `--el-text` / `--el-text-muted`                                                                                                                                                               | —                                                                                                        | **What it can do** / The standard permissions every new connection gets — everything except deleting.                                                                                                        |
| Grant label + help — One      | field label + helper                                                                                                                   | `--el-text` / `--el-text-muted`                                                                                                                                                               | —                                                                                                        | **What it can do** / Choose what {app} is allowed to do. You can grant less than your own access, never more. (the picker's `scopes.permissionsHelper`, with {app} for "this token")                         |
| Grant columns                 | the picker's `grid grid-cols-2 gap-x-6 gap-y-4`, `permissionColumnsForTokens()` — today 7 \| 7                                         | —                                                                                                                                                                                             | —                                                                                                        | —                                                                                                                                                                                                            |
| Domain caption                | `font-mono text-[0.625rem] uppercase tracking-wide`                                                                                    | `--el-text-secondary` (NOT faint — MOTIR-2578's correction)                                                                                                                                   | —                                                                                                        | `permissions.domain.*`: PROJECT · WORK ITEMS · COMMENTS · PLANS · AGENT RUNS · SPRINTS & BACKLOG · AI PLANNING                                                                                               |
| Row — All projects (fixed)    | /device `PermissionRow`: domain glyph + NAME only, hairline-divided, no switch                                                         | glyph `--el-text-muted`, name `--el-text`; dividers `--el-border-soft`                                                                                                                        | —                                                                                                        | the shipped `permissions.<slug>.label`                                                                                                                                                                       |
| Row — One project             | the picker row: glyph, name, description, `Switch`                                                                                     | name `--el-text`, description `--el-text-muted`                                                                                                                                               | `Switch` (h-5 w-9)                                                                                       | `permissions.<slug>.label` / `.description`                                                                                                                                                                  |
| Row — locked (One project)    | the picker's disabled row: `Switch disabled`, name + description faint, reason line                                                    | name/desc `--el-text-faint` (legal: the element carries `aria-disabled="true"`), reason `--el-text-secondary`                                                                                 | —                                                                                                        | You do not have this in this project.                                                                                                                                                                        |
| Switch                        | `Switch`                                                                                                                               | on: `--el-switch-on` / `--el-switch-on-border` / knob `--el-switch-knob`; off: `--el-muted` / `--el-switch-off-border` / knob `--el-switch-knob-off`                                          | `rounded-full`                                                                                           | `aria-label` = the permission's label                                                                                                                                                                        |
| Irreversible key              | the picker's own danger card — `grantsIrreversible` / `meta.danger`                                                                    | bg `--el-tint-rose`, border `--el-border-soft`, `Trash2` glyph `--el-danger`, name + text `--el-text-strong`, tag `--el-danger-on-surface`                                                    | `rounded-(--radius-card)`, `px-(--spacing-control-x) py-(--spacing-control-y)`                           | **Delete work items · DANGER** / All: Not included. Pick **One project** to choose it. / One: the shipped description + a Switch, OFF by default                                                             |
| Summary line                  | lucide `Info` + one sentence, top hairline                                                                                             | text `--el-text-secondary`, emphasis `--el-text`, rule `--el-border-soft`                                                                                                                     | —                                                                                                        | All: {app} gets **{n} of {total}** permissions, in every project of **{workspace}** you can open. / One: {app} gets **{n}** permissions, in **{KEY}** only.                                                  |
| Deny                          | `Button variant="secondary" size="lg"` + `CircleX`, FIRST in the DOM, 50/50 row — /device's composition                                | label `--el-text`, border + glyph `--el-danger` (never `--el-danger-text`)                                                                                                                    | `rounded-(--radius-btn)`, `h-(--height-btn-lg)`                                                          | **Deny**                                                                                                                                                                                                     |
| Approve                       | `Button variant="primary" size="lg"`; disabled when no workspace chosen or the One-project grant is empty                              | `--el-accent` / `--el-accent-text`                                                                                                                                                            | as Deny                                                                                                  | **Approve and connect**                                                                                                                                                                                      |
| Foot                          | `p text-xs`                                                                                                                            | `--el-text-muted` (white card)                                                                                                                                                                | —                                                                                                        | Disconnect it any time in Settings → Account → Connected apps.                                                                                                                                               |
| Empty grant (One project)     | the picker's `role="alert"` line + `TriangleAlert`                                                                                     | `--el-danger-on-surface` (see the delta below)                                                                                                                                                | —                                                                                                        | Grant at least one permission to connect.                                                                                                                                                                    |

### Per element — the other states

| Panel | Headline / subhead                                                                                     | Body                                                                                                                                                                                                                                                                                                      | Action · foot                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 5     | **Welcome back!** / Use Motir to turn any product idea into reality. (unchanged)                       | `IdeaCarried` — label `--el-text-secondary`, value `--el-text`, `bg-(--el-surface-soft) border-(--el-border) rounded-(--radius-input)`: **CONNECTING AN APP** / {app} — you’ll pick a workspace and approve next. Then the shipped sign-in form, unchanged.                                               | foot: Only the account you sign in as can approve this — and only its workspaces can be picked.                                           |
| 6a    | **{app} can’t connect yet** / You’re not in any Motir workspace.                                       | warn `Callout` (`--el-warning-surface` / `--el-warning-text`, `CircleAlert`): A connection acts in one workspace, and your account isn’t in any yet. Create a workspace, or ask to be invited to one, then connect again from {app}.                                                                      | Deny, full width: **Deny and return to {app}** · foot: Deny tells {app} the connection was refused. Nothing is stored.                    |
| 6b    | **{app} can’t connect yet** / None of your workspaces lets you grant it anything.                      | warn `Callout`: In **{ws A}** and **{ws B}** you can’t open any project, so there is nothing {app} could do there. Ask a workspace admin for project access, then connect again.                                                                                                                          | as 6a                                                                                                                                     |
| 7     | **This connection request can’t be used** / Nothing was connected, and you haven’t been sent anywhere. | danger `Callout` (`--el-danger-surface` / `--el-danger-surface-text`, `CircleX`) with the reason sentence (table below); then `--el-text-secondary`: Go back to the app and start connecting again. If this keeps happening, the app is set up wrong — tell whoever makes it, and quote `CodeChip`{code}. | `Button variant="secondary"` full width: **Go to Motir** (to the app root) · foot: You can close this tab. — **no Approve, no Deny**      |
| 8     | as Panel 1                                                                                             | every control read-only                                                                                                                                                                                                                                                                                   | Approve `loading` → **Connecting…**; Deny `disabled`. A failure is /device's `ErrorBanner` above the actions, on this screen.             |
| 9     | **{app} is connected** / You can close this tab.                                                       | success `Callout` (`--el-success-surface` / `--el-text-strong`, `CircleCheckBig`): {app} can now act as you in **{workspace}** — every project you can open. (One project: — in **{KEY}** only.) Then: Returning you to {app}… If nothing happens, go back to it yourself — it’s already connected.       | `Button variant="secondary"` + `KeyRound`: **View connected apps** · foot: Disconnect it any time in Settings → Account → Connected apps. |
| 10    | **{app} was not connected** / You can close this tab.                                                  | danger `Callout`: Nothing was stored. {app} will be told you declined. Then: Changed your mind? Start connecting again from {app}.                                                                                                                                                                        | foot: Nothing about your account was shared with it.                                                                                      |

**Panel 7's reasons** — the callout sentence names the problem in words; the quoted
code is for the app's maker:

| Request                       | Callout sentence                                                                    | Quoted code                        |
| ----------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------- |
| unknown `client_id`           | The app isn’t registered with Motir, or its registration has expired.               | `invalid_client`                   |
| `redirect_uri` not registered | It asked to send you back to **{host}**, an address it never registered with Motir. | `invalid_request · redirect_uri`   |
| PKCE missing, or not S256     | It left out a security check Motir requires on every connection.                    | `invalid_request · code_challenge` |
| `resource` not this MCP       | It asked for access to something other than Motir’s MCP server.                     | `invalid_target · resource`        |

### Decisions, and why

1. **The page never shows a client logo.** A self-registered client's `logo_uri` is as
   unverified as its name, and a borrowed logo is the more convincing lie. The tile is
   the name's first letter.
2. **There is no "Verified" badge**, only an "Unverified" one. Motir has no review
   process; a tick would claim one. A pre-registered client simply carries no marker
   and a line saying who registered it (Panel 4). GitHub and Linear draw the same
   asymmetry for unreviewed apps.
3. **The return host is always on screen**, for both kinds of client: the code goes
   there, so it is part of what is being approved. Loopback reads **localhost**, with
   a sub-line that ties it to "this computer".
4. **All projects shows no switches.** Its grant is fixed (`DEFAULT_TOKEN_GRANT`, per
   Amendment 1's one-arm rule, which MOTIR-6983 applies to connections): drawing
   switches would offer a choice the server ignores. It shows names only (the /device
   row), and draws **Delete work items WITHHELD** in its danger card, pointing at One
   project — so the irreversible key is flagged in both modes.
5. **One project IS the picker**, offered `grantableFor(held)` for the chosen project:
   rows the person does not hold are disabled with the picker's reason, never hidden;
   Delete is off by default and switchable. Changing the project resets the switches to
   the default grant ∩ what they hold there.
6. **The workspace list is only workspaces the person may grant something in**, as
   `org · workspace`. Empty → Panel 6b; no memberships at all → Panel 6a. Both still
   offer Deny, which redirects `access_denied`: the request was valid, and the client is
   waiting on an answer.
7. **A refused request does not redirect** (Panel 7): with an unregistered
   `redirect_uri` the only address on hand may be the attacker's. **As built by
   MOTIR-6982**, Panel 7 is reached only when the redirect cannot be trusted — an
   unknown `client_id` or an unregistered `redirect_uri`. A request whose client and
   redirect check out but which lacks PKCE, asks for `plain`, or names another
   `resource` is sent BACK to the app with `invalid_request` / `invalid_target`, as
   RFC 6749 §4.1.2.1 requires; its last two table rows stay as the copy for the day a
   refusal cannot be returned. Today the provider's error redirect lands on
   Better-Auth's `/api/auth/error`; pointing it at this page (`onAPIError.errorURL`)
   is MOTIR-6985's. The mock's URL bar shows app.motir.co/oauth/error as a
   suggestion.
8. **Approve shows its own terminal state, then redirects immediately.** For a
   loopback client the tab normally lands on the client's own page; if that listener
   has already closed, the tab stays on Motir's "is connected — you can close this
   tab", which is true, rather than a spinner that never ends.
9. **The sign-in hand-off carries the whole authorize query in `next`** (Panel 5), and
   the sign-in card gains only an `IdeaCarried` banner, the /device precedent. Proxy
   redirects that keep only the pathname would drop `state`, `code_challenge` and
   `resource`.

### The one deliberate delta from the shipped picker

The shipped picker paints its "· Danger" tag and its empty-grant error in raw
`--el-danger`, which `CLAUDE.md` names as under AA on the dark page in three palettes
and on most tints. This mock paints both in **`--el-danger-on-surface`** (≥ 4.77:1 on
`--el-tint-rose` and the page in all twenty palette × theme contexts). Everything else
about the danger card — tint, border, glyph, strong ink, position — is the picker's.
MOTIR-6985 should use `--el-danger-on-surface` on this page; bringing the create-token
modal into line is out of this card's scope.

### Accessibility

- Deny is first in the DOM; the two actions share a `role="group"` named
  "Approve or deny {app}".
- The reach control is a `radiogroup`; the grant is a `role="group"` named
  "What it can do"; every `Switch` is named by its permission's label.
- Terminal states (6, 7, 9, 10) render inside `role="status" aria-live="polite"`.
- State is never carried by colour alone: every callout has a glyph and words; the
  unverified pill has a glyph and a word; the danger card has a glyph and a tag.
- Ink: `--el-text-muted` appears only on the white card; `--el-text-faint` only on
  elements carrying `aria-disabled="true"`; no `--el-danger-text` anywhere.

### How the mock was produced

The token block is lifted from `packages/design-system/theme.css` by brace-count,
comments stripped: Tier 0, the Tier-1 dark block, the Tier-3 `--el-*` layer emitted
twice (on `:root, [data-appearance-scope]` and again as a separate `[data-theme]`
rule, so the nested dark panel resolves dark), and the Tier-3 dark lift. The grant
data is the shipped derivation read from code, not recalled: `GRANTABLE_PERMISSIONS`
= 14 keys, `DEFAULT_TOKEN_GRANT` = 13, catalog-domain groups, a 7 | 7 column split.
Panels were rendered in headless Chromium at 1240px wide to check layout; no image is
part of the asset.
