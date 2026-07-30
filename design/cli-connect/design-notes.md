# Connect the CLI — design notes

Design reference for the **`cli-connect`** area: the two BROWSER surfaces the
`motir login` device grant needs. Asset: **`cli-connect.mock.html`** →
**`cli-connect.png`** (one full-page export, 12 panels).

| Surface                                                                        | Panels  | Built by                                |
| ------------------------------------------------------------------------------ | ------- | --------------------------------------- |
| **`/device`** — verification + approval, **all six states**                    | 0–8     | **MOTIR-1867** (`blocked_by` this card) |
| **The “Connect the CLI” panel**, composed into Settings → Account → API tokens | 0, 9–11 | **MOTIR-1869** (`blocked_by` this card) |

Story: **MOTIR-1863** — Connect the CLI (the three-tier login). Sibling specs
this design DEPICTS rather than invents: the ADR **MOTIR-1864** (tiers, what
approval exchanges, scopes, label, expiry, workspace binding) and the substrate
**MOTIR-1865** (the endpoints and the five poll states). Neither is
`blocked_by`-upstream of this card — the design reads their descriptions and
cites them, and does not wait on their code.

**Scope:** pixels and copy only. No React, no route, no restyle of the
API-tokens table / create modal / revoke dialog (`design/settings/` owns those),
and **no terminal output** — `packages/cli/src/render.ts` states the
design-system rules do not apply to terminal text, and MOTIR-1868 owns the CLI’s
wording. The terminal block in Panel 0 is labelled in the mock as illustrative
for exactly this reason.

---

## Verified before drawing (rung 2, not assumed)

- **`/device` does not exist.** `GET /device?user_code=…` on a **production
  build of `origin/main`** returns **404**; there is no `app/**/device` route.
- **Nothing in `design/` covers the CLI.** `design/settings/` holds
  `account-settings` · `profile` · `appearance` · `token-scopes`; the CLI appears
  in none of them. This is the design gate’s NONE-exists case, planned as a card
  rather than improvised at build time.
- **The host surfaces were RENDERED first, not read from source** (the
  design-against-shipped-reality rule; `notes.html` #73): the repo was built and
  served, and `/settings/account/api-tokens` (populated **and** empty) plus
  `/sign-in` were screenshotted and designed against. That is why the mock’s pane
  carries the **TopNav**, the five real rail entries, the serif page head, the
  shipped subtitle copy, and the tokens table’s **eight** shipped columns
  (Label · Token · **Scopes** · **Workspace** · Created · Expires · Last used ·
  Actions) — the 7.8.2 mock predates the last two, so mirroring _it_ would have
  drifted from the running app.
- **The mock is machine-derived where it can be.** The `<style>` token block is
  copied 1:1 from `@motir/design-system/theme.css` (Tier 0 `@theme` → `:root`,
  the Tier-1 dark block, the whole Tier-3 `--el-*` layer, and its dark lift), and
  every icon `<g>` is generated from the installed `lucide-react` v1.16 icon
  nodes. No retyped hexes, no hand-drawn paths.

## Where each behaviour comes from (no invented flow)

| Depicted behaviour                                                              | Source                                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 8-character code, shown `XXXX-XXXX`, dash + case optional                       | The installed plugin: `userCodeLength` default **8**; charset `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (**no I/O/0/1**); `userCode.replace(/-/g, '')` on verify/approve/deny.                    |
| The pre-filled arrival (`?user_code=`)                                          | `buildVerificationUris()` returns `verification_uri` + `verification_uri_complete` with `user_code` as a query param.                                                                      |
| “Codes last 30 minutes”                                                         | `expiresIn` default `'30m'` (the ADR pins the final value; the mock shows the default).                                                                                                    |
| Approve / Deny require a session, and the code must be CLAIMED first            | `deviceApprove` / `deviceDeny` 401 `AUTHENTICATION_REQUIRED` without a session, 400 `DEVICE_CODE_NOT_CLAIMED` unless `GET /device?user_code=` ran in that same session.                    |
| Denied / expired / unknown states                                               | `DEVICE_AUTHORIZATION_ERROR_CODES`: `ACCESS_DENIED`, `EXPIRED_USER_CODE`, `INVALID_USER_CODE`, `DEVICE_CODE_ALREADY_PROCESSED`.                                                            |
| “In 90 days”, the narrow scope set, the `CLI · <hostname>` label, one workspace | **MOTIR-1864** (ADR): approval mints a PAT with the narrow CLI scopes, bound to the workspace chosen here, host-labelled, finite expiry. 90 days mirrors the shipped create-modal default. |
| The three plain-language scope rows                                             | `design/settings/token-scopes.mock.html` + `scopeMeta.tsx` — “Read everything” · “Edit work items” · “Connect integrations”. Never the raw `work_items:write` string.                      |
| “Custom” scope pill on the CLI row                                              | `summarizeScopes()`: 3 of 6 scopes is neither `full` / `standard` / `readonly`, so the shipped pill reads **Custom**.                                                                      |
| The signed-out hand-off `/sign-in?next=…`                                       | The shipped `?next=` convention (`app/(auth)/sign-in/page.tsx`: `searchParams.get('next') ?? '/dashboard'`).                                                                               |
| The carried-context banner                                                      | The shipped `IdeaCarried` surface in `app/(auth)/_components/AuthShell.tsx` — already the app’s way of carrying context across the auth boundary.                                          |
| The `(auth)` card chrome                                                        | `app/(auth)/layout.tsx` — `--el-auth-wash` page, centred card, `--radius-card` + `--shadow-elevated`.                                                                                      |
| The pane, rail, TopNav, tokens card + table, empty state, toast                 | The RENDERED `/settings/account/api-tokens` + `ApiTokensManager.tsx` / `EmptyState` / `Toast`, and `lib/settings/accountSettingsNav.ts` for the rail order.                                |
| The avatar-menu door                                                            | `app/(authed)/_components/UserMenu.tsx` — identity block, **Account settings** (`UserCog`), Workspace settings, Sign out.                                                                  |

---

## Surface 1 — `/device`

### Placement + chrome (a decision, made from shipped reality)

`/device` is a **one-task page arrived at by URL**, in **both session states**, so:

- **It lives in the `(auth)` route group** — `app/(auth)/device/page.tsx` — and
  wears that group’s centred-card chrome. The shipped precedent is
  `/reset-password/new`: arrive by URL bearing a code, do one thing, leave. The
  `(authed)` group is impossible (its layout `redirect('/sign-in')`s, which would
  make state 6 undrawable), and the app shell cannot render for a signed-out
  visitor.
- **It gets NO nav entry.** Not the `#99` case (a first-class _view_ earns a rail
  entry); this is a hand-off page whose door is the CLI. Panel 0 draws that door.
- **The card width is per-state:** `max-w-[28rem]` for the single-field states
  (code entry, approved, denied, expired — the shipped sign-in width) and
  **`max-w-[40rem]` for the confirm screen**, whose two-column detail block is what
  keeps it on one screen (below). A one-off `max-w-[…]` on the container is the same
  knob the peek/lightbox modals already use.
- **⚠️ Do NOT add `/device` to `proxy.ts`’s matcher.** The proxy bounces to
  `/sign-in` with `next` set to `request.nextUrl.pathname` **only** — it drops the
  query string, so a proxy bounce would silently lose `?user_code=`. The page owns
  its signed-out hand-off instead (Panel 8), linking to
  `/sign-in?next=%2Fdevice%3Fuser_code%3D<CODE>` with path **and** query encoded.

### The six states

| #   | Panel | State                  | What it must do                                                                                                   |
| --- | ----- | ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | 1 + 2 | **Code entry**         | Hand-typed (the sandbox / SSH path — **not** an edge case) **and** the pre-filled variant, drawn separately.      |
| 2   | 3 + 4 | **Confirm**            | The phishing defence — see below. Multi-workspace (picker) and single-workspace (picker absent) both drawn.       |
| 3   | 5     | **Approved**           | “Go back to your terminal”, names the workspace, names the token that now exists, offers **View API tokens**.     |
| 4   | 6     | **Denied**             | States that nothing was connected and **no token was created**, and how to start over.                            |
| 5   | 7     | **Expired / unknown**  | One screen, two copies. Expired names the 30-minute lifetime; unknown keeps the field so a typo is one edit away. |
| 6   | 8     | **Signed-out arrival** | Carries the code across sign-in and comes BACK to the confirm step — never a dropped flow, never a re-entry.      |

Every state ends in a **forward path**, because the terminal is blocked on this
page: a dead end here strands the user with a spinning CLI.

### It MUST fit one screen — measured, not assumed

The confirm screen is the one surface in this design where content below the fold
is actively dangerous: if Approve sits off-screen, the reader scrolls **past** the
four facts to reach it, which defeats the whole point of the check.

The first draft failed this badly — a single-column detail list with a 122 px key
column made the card **1106 px** tall, overflowing every laptop by 242–522 px. It
was rebuilt as **two columns at `max-w-[40rem]`** with captions above their values.
Measured in Chromium inside the shipped `(auth)` frame (`min-h-screen` ·
`items-center` · `py-12`), card height **541 px**:

| Screen (minus ~120 px browser chrome) | Page scrolls? | Facts end | Buttons end |
| ------------------------------------- | ------------- | --------- | ----------- |
| 1366×768 → 648                        | no            | 419       | 575         |
| 1280×800 → 680                        | no            | 435       | 591         |
| 1440×900 → 780                        | no            | 485       | 641         |
| 1512×982 → 862                        | no            | 526       | 682         |

**The invariant for MOTIR-1867 to hold:** the four facts and BOTH buttons are
simultaneously visible at a 648 px viewport height. Three consequences worth
keeping:

- **Width, not height, absorbs new content** — the same call
  `token-scopes.mock.html` made for the scope picker (Yue, 2026-06-16: "a scrolled
  picker hides options"). If a fact is added later, widen or re-balance the two
  columns; do not let the card grow past ~560 px.
- **The scope rows are NAMES only** on this screen — "Read everything" · "Edit work
  items" · "Connect integrations" — plus the one-line **Not:** exclusion. The
  per-scope descriptions live in the API-tokens scopes UI that owns them
  (`token-scopes.mock.html`). Fewer words on a security screen people skim is the
  point, and it is what bought the last 50 px.
- **Never put the CTAs in a sticky footer.** A pinned Approve could sit on screen
  while the facts are still unread — the exact failure this layout exists to
  prevent. Buttons stay last in the flow.

### The confirm screen IS the mitigation — the four facts

A device grant’s known weakness is a code entered under someone else’s
instruction. The ADR accepts that trade-off **because this screen makes an
illegitimate approval visibly wrong**, so it is built as a single reviewable
block (the settings-row grammar inside one bordered box), not scattered prose:

1. **WHO** — avatar + name + email of the session, with _“Not you? Sign out and
   sign in as someone else”_ (a real path, not a dead statement).
2. **WHAT** — `Motir CLI on <hostname>`, the code, and how long ago it was asked
   for. (See planning flag 1: the hostname needs a carrier.)
3. **WHICH WORKSPACE** — the `Combobox` picker when the user belongs to more than
   one, with _“The terminal sees only this workspace”_; **absent** at exactly one
   workspace, where the workspace is simply stated (“Your only workspace”). No
   choice to make ⇒ no control to render.
4. **WHAT SCOPES** — the three plain-language grants, plus an explicit **can’t**
   line (“It can’t archive or delete work items, and it can’t change members or
   billing”). Read-only: the ADR’s recommendation is the narrow set with no
   widening on this screen. If the ADR lands “the screen may widen”, drop in the
   `token-scopes.mock.html` Panel-1 picker grammar — nothing else changes.
5. Plus **Expires** — the finite lifetime, and that revoking is the only kill
   switch (so the reader knows the exit before taking the action).

Then a **peach `shield-alert` callout** in plain language: _approve only if you
just ran `motir login` yourself; if someone sent you this code — in a chat, an
email, a support ticket — deny it, because approving hands THEIR terminal
everything listed above, as you._

**Deny has real visual weight** — same size, same row, 50/50 with Approve, with a
`--el-danger` border and a `circle-x` glyph. It is **not** a muted link, and it is
**not** the solid `danger` fill either (denying destroys nothing; the fill is for
destructive acts).

> **Why the danger hue is in the border + glyph, not the label** (measured, and
> the `notes.html` MOTIR-1553 bug class): `--el-danger` (#e03131) as TEXT is
> **4.51:1** on the light card but only **4.25:1** on the dark one — under AA for
> a 16 px label. As a border/glyph it is a graphic (3:1 needed) and passes in both
> themes, while the label keeps `--el-text` (17.4:1 light, 17.4:1 dark). Do not
> “fix” this by switching the label to `--el-danger-text`: that token is the ink
> FOR a danger fill and is `#ffffff` in the light palette.

---

## Surface 2 — the “Connect the CLI” panel

The entrance that makes the CLI **exist** for a user who never read the repo.

**It COMPOSES the shipped pane; it does not redraw it.** The panel is the **first
`Card` of the existing Security → API tokens pane** (`page.tsx` +
`ApiTokensManager.tsx`), above “Your tokens”. Ground it in
`design/settings/account-settings.mock.html` (Panels 3–8) and the render of the
live pane. **The tokens table, create modal, shown-once state and revoke dialog
are NOT re-specified here** — they are unchanged, and the mock deliberately adds
no new row state to the list (an earlier draft tinted the newly-minted row; it was
removed as an unrequested change to a surface this card doesn’t own).

**Access path (drawn, not described — Panel 0):** the **avatar menu → Account
settings** hop from the shipped `UserMenu`, then the account rail with **Security
→ API tokens** active. **No new primary-nav entry, no new route, no new pane.**

- **The rail label stays “API tokens.”** Renaming it (e.g. “API tokens & CLI”)
  would churn the `accountSettingsNav` registry, its i18n keys and the
  route↔registry totality test for no user gain. The panel carries the CLI naming
  inside the pane.
- **Panel order matters, and the empty case is why:** a first-time user has NO
  tokens, so the pane is the shipped `EmptyState`. The CLI route must read
  **before** “Create token”, or the person who could have run two commands is
  instead walked into minting and pasting a secret by hand (Panel 10).

**Contents** — two copyable snippets, then what happens, then the escape hatches:

| Element               | Copy                                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card title / sub      | “Connect the CLI” (`terminal` glyph) · “Run Motir from your terminal — `motir next`, `motir run`, `motir auto`.”                                                                                   |
| 1 · Install           | `npm install -g @motir/cli` + a copy icon-button (`aria-label` “Copy install command”).                                                                                                            |
| 2 · Sign in           | `motir login` + a copy icon-button (`aria-label` “Copy sign-in command”).                                                                                                                          |
| What happens next     | “`motir login` shows a short code and opens Motir in your browser. Approve it there and the terminal is connected — there is no token to copy by hand.”                                            |
| Headless / unattended | “No browser on that machine? `motir login` prints the code and the URL to open anywhere, so SSH sessions and containers use the same command. For an unattended agent, set `MOTIR_TOKEN` instead.” |
| Docs link             | “Read the CLI guide” (`book-open`) → `docs/cli.md`, using the shipped absolute-GitHub-docs convention (`MCP_GUIDE_HREF` in `ApiTokensManager.tsx`).                                                |
| Tie to the list below | “An approved terminal appears below as `CLI · <hostname>` — revoking it there disconnects that terminal.” (Future tense in the empty variant.)                                                     |
| Copy toast            | `Toast variant="success"`: **“Copied”** · “Paste it into your terminal and press enter.”                                                                                                           |

---

## ⚠️ Planning flags (surfaced, not silently absorbed)

**1 — The grant carries no HOSTNAME today, and two cards depend on one.** The
confirm screen’s WHAT line (`Motir CLI on studio-mbp`) and the ADR’s
`CLI · <hostname>` token label both need a hostname, but the installed plugin
cannot supply one: `POST /device/code` accepts only `client_id` and `scope`, and
the `deviceCode` model’s fields are `deviceCode · userCode · userId · expiresAt ·
status · lastPolledAt · pollingInterval · clientId · scope`. So the hostname must
be carried **deliberately** — the CLI encoding it in `client_id` (e.g.
`motir-cli/studio-mbp`), or the substrate extending the plugin schema (the plugin
does expose a `schema` merge option), or it riding in `scope`. **MOTIR-1865
(substrate) + MOTIR-1868 (CLI) must pin exactly one**, and MOTIR-1867 renders
whatever they pin. Left unpinned, the approval screen cannot show WHAT is
connecting — which is the very mitigation the ADR’s Q0 leans on — and the token
label is unbuildable. Not a blocker for this design; a contract to pin before
1867 builds.

**2 — `npm install -g @motir/cli` is not true yet.** `docs/cli.md` § Install says
the package is **not on npm** and gives a build-from-checkout recipe;
**MOTIR-669** (in progress) is the publish card. The panel’s copy is drawn as the
card specifies, i.e. for the post-669 world. **MOTIR-1869 should land after
MOTIR-669**, or ship the interim build-from-checkout copy and change it back —
worth an explicit ordering edge rather than a copy bug in the first thing a new
user reads.

**3 — Depicted-but-not-specified.** The sign-in card in Panel 8 is the shipped
surface shown for continuity; the only change this design asks of it is the
carried banner. Its Google button is drawn without the Google brand mark (a brand
asset, not a design-system element) — the shipped `GoogleButton` is unchanged.

---

## Token + a11y discipline

- **Colour** is `--el-*` only — no Tier-0 `--color-*`, and **no invented hue
  anywhere**, including the terminal illustration (which uses `--el-code-bg` /
  `--el-code-text`). Callout tints put the hue in the BACKGROUND with
  `--el-text-strong` ink: peach warn **10.4:1**, mint success **10.4:1**, rose
  danger **10.0:1** (light) and 10.9 / 11.3 / 11.8:1 (dark) — all AA and above.
- **`--el-text-faint` is decorative only.** Measured **2.61:1** on white, so it
  stays where the shipped surfaces already use it (table `thead` captions, rail
  group labels). The confirm screen’s five row keys and the panel’s step captions
  carry meaning, so they use `--el-text-muted` (**4.54:1** light / **7.35:1**
  dark).
- **Shape** is element-semantic tokens only — `--radius-card` / `-input` / `-btn`
  / `-badge` / `-control` / `-kbd`, `--spacing-card-padding` / `-input-*` /
  `-btn-*` / `-chip-*` / `-control-*` / `-icon-btn` / `-kbd-*`, `--height-input` /
  `-control` / `-btn-{sm,md,lg}`, `--shadow-subtle` / `-card` / `-elevated`. No
  Tier-0 radius scale, no raw `rounded-md` / `p-2` / `h-9`. `9999px` only on the
  avatar (genuinely circular). Focus is the shipped Input treatment — an OFFSET
  ring (`--focus-ring-offset` + `--focus-ring-width` + `--focus-ring-color`), not
  a recoloured border.
- **Never colour alone:** each callout pairs tint + icon + copy; Deny pairs a
  border, a glyph and the word; the code chips are text.
- **a11y for the build cards:** the code field is a labelled `Input`
  (`inputMode="text"`, `autocomplete="off"`, autofocus, dash/case-insensitive on
  submit); Approve/Deny are real `<button>`s in a labelled group with Deny FIRST
  in DOM order so the destructive-of-nothing option is reachable without passing
  through Approve; the copy buttons carry `aria-label`s; the toast is
  `role="status"`; each terminal state announces via a live region so a screen
  reader hears the result without re-reading the card.
- **Dark mode** confirmed (Panel 11). Note for the build: a nested subtree needs
  `data-appearance-scope` beside `data-theme` to re-emit the Tier-3 layer — the
  mock’s dark panel does, and the first render without it came out light.

## Primitives composed (no hand-rolling)

| Element                                 | Shipped primitive                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| the `/device` page frame                | `app/(auth)/layout.tsx` + `AuthShell` (serif headline + subhead + slotted body)     |
| carried-context banner                  | `AuthShell.IdeaCarried`                                                             |
| code field · workspace picker           | `components/ui/Input.tsx` + `FormField` · `components/ui/Combobox.tsx`              |
| Approve · Deny · Continue · copy        | `components/ui/Button.tsx` (`primary` / `secondary` + danger border / icon-button)  |
| state callouts                          | the shipped callout grammar (shown-once warning + revoke confirm), tinted           |
| the connect panel + the pane it sits in | `components/ui/Card.tsx` (header slot + body) inside the account-settings area      |
| the token list, empty state, toast      | `ApiTokensManager.tsx` · `components/ui/EmptyState.tsx` · `components/ui/Toast.tsx` |
| the rail + its entries                  | `SidebarNav` driven by `lib/settings/accountSettingsNav.ts`                         |
| the door                                | `app/(authed)/_components/UserMenu.tsx` (`Popover`)                                 |

No new design-system primitive is invented. The one new **composition** is the
Deny button (secondary + danger border/glyph); if it recurs, promote it to a
`Button` variant rather than re-deriving it per surface.

## i18n

A new **`device`** namespace — `heading.{entry,confirm,approved,denied,expired,unknown,signedOut}`,
`subhead.*`, `code.{label,placeholder,helper,helperPrefilled,helperTypo}`,
`continue`, `confirm.{you,notYou,connecting,askedAgo,workspace,workspaceOnly,workspaceHelp,itCan,cant,expires,expiresHelp}`,
`confirm.warning.{line1,line2}`, `approve`, `deny`, `approved.{body,tokenNote,viewTokens,close}`,
`denied.{body,retry,another}`, `expired.{body,newCode,terminalNote}`, `unknown.{body,retry}`,
`signedOut.{carried,body,cta}`, `foot.notYou` — plus the three scope
labels/descriptions reused from `settings.apiTokens.scopes.*` (do not duplicate
them). Extends **`settings.apiTokens`** with `cli.{title,subtitle,step1,step2,next,headless,guide,tie,tieEmpty}`
and `cli.toast.{title,body}`. Every string in the mock is real copy a translator
could lift — no lorem — and every new `en.json` key needs its `zh.json` twin or
the i18n-catalog parity test fails.
