# Auth — design notes

Design reference for the `auth` area: the signed-out surfaces served from
`app/(auth)/**` — sign-in, sign-up, password reset, and the two later screens
(`/device`, `/unsubscribe/filter-subscription`) that joined the group after this
asset was drawn.

| Surface           | Asset                                            | Notes                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auth 2.0**      | **`auth-screens.pen`** (Pencil source)           | Twelve artboards — five desktop screens, three desktop states, four mobile. Exported as `01-signin-desktop.png` … `12-reset-request-mobile.png`, one PNG per artboard. **Gates Story 1.1** (auth).                                                                               |
| **2FA challenge** | **`two-factor-challenge.mock.html`** (HTML mock) | The second-factor step between the password and the session (Story 8.11 · MOTIR-1216): the six-digit field, the two fallbacks, remember-this-device, and the three refusals. The area's FIRST HTML mock — built from shipped code, not from the artboards. **Gates MOTIR-1221.** |
| CLI hand-off      | `../cli-connect/cli-connect.mock.html`           | `/device` and the banner it adds to the sign-in card. Drawn later, in its own area — this file does not re-specify it.                                                                                                                                                           |
| Brand lockup      | `../brand/brand-mark.mock.html` §7b              | The `BrandMark` the `(auth)` card renders top-left. Supersedes this asset's "P" tile (see the ledger below).                                                                                                                                                                     |

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
glyph, to `/onboarding`. It is the onboarding door, and this card is where it is
reached from.

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
3. **The two `IdeaCarried` banners on `/sign-in`** — a quiet
   `--el-surface-soft` block with an `--el-text-secondary` uppercase label and
   an `--el-text` body, `line-clamp-4`, at `--radius-input` with an
   `--el-border` hairline. One carries an idea handed off from the marketing
   hero (`?draft=`), the other the device code from the CLI hand-off, rendered
   through `CodeChip` (`--el-code-bg` / `--el-code-text`, `--radius-control`,
   `font-mono`). Both sit between the header and the form.
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
| 4    | `resolvePostAuthDestination`                     | `?next=` when safe, else `/home`                             |

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
rather than at `/home` with the problem still true.

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
