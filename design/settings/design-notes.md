# Settings — design notes

Design reference for the `settings` UI area. The headline surface is the
**account settings AREA** — the per-user settings surface, redesigned (Story 7.8
· 7.8.2) from a flat 2-card page into a grouped-nav **area** that scales as it
grows. Built FROM the real design system (`app/globals.css` `--el-*` / shape
tokens + the shipped `components/ui/*` primitives), so the code subtasks compose
the same primitives — no Pencil→code gap.

| Surface                        | Asset                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Account settings area**      | **`account-settings.mock.html`** (HTML mock)           | The account-settings area: the rail grouped nav + the **real** panes (Language · Notifications · Security/API tokens) + the API-token create / shown-once / revoke / empty / toast flows. Multi-panel. **Gates 7.8.3** (API tokens).                                                                                                                                                                                                                                                                     |
| **Token permission selection** | **`token-scopes.mock.html`** (HTML mock)               | EXTENDS the API-tokens surface: the create-modal **permission-scope picker** (grouped Switch toggles, default all-on except delete) + the token-LIST **granted-scope display** (summary Pill + "Can delete" chip + expandable detail). Multi-panel. **Gates 7.7.19** (token scopes) and, as amended by **MOTIR-2578**, MOTIR-2579 / -2580 (the permission picker over the MOTIR-2254 catalog — SIX rows, five domains; see that section, which supersedes the 7.7.18 one).                               |
| **Appearance pane**            | **`appearance.mock.html`** (HTML mock)                 | Motir dogfoods its own 3-axis design system: theme the Motir app itself — **Theme × Style × Palette × Type**. Applies instantly, so the whole page re-skins — the page itself is the showcase (controls + a real Motir slice), no separate preview. Reuses the area shell + onboarding picker language; flips the rail's "Soon" Appearance slot to active. Multi-panel (default · changed · dark). **Gates 7.3.58** (the pane + route).                                                                  |
| **Connect the CLI**            | **`../cli-connect/cli-connect.mock.html`** (HTML mock) | Lives in its OWN area (`design/cli-connect/`) because it also owns the `/device` approval page, but its second surface COMPOSES INTO this area: the "Connect the CLI" panel is the first `Card` of the Security → API tokens pane, above "Your tokens". It re-specifies nothing here — the table / create modal / shown-once / revoke flows are unchanged. **Gates MOTIR-1869** (the panel); the page is MOTIR-1867.                                                                                     |
| **Profile pane**               | **`profile.mock.html`** (HTML mock)                    | The `General › Profile` personal-details pane (Linear-style Profile + Security): edit **name** (inline), **avatar** (upload / remove), **email** (change-with-confirmation), and **password** (Change-password modal for credential users · Send-a-reset-link for OAuth-only). Flips the rail's last "Soon" slot (Profile) to active. Multi-panel (resting · editing/pending/errors · change-password modal + toast · change-email + OAuth + loading · dark). **Gates the 8.8.x Profile build subtask.** |
| **Arrival frame**              | **`arrival.mock.html`** (HTML mock)                    | The settings family's PENDING drawing: the pane-only frame each of the 31 `settings/**` routes renders IN-PAGE after its own gate, the width-is-a-prop rule, and the three-tier streaming allocation for all 14 heavy panes. Applies `design/shell/design-notes.md` § _The navigation-pending grammar_ (2nd revision); adds no `loading.tsx`. Multi-panel (in situ · anatomy · widths · the two superseded skeletons · mount points · dark). **Gates MOTIR-3443 and MOTIR-3448.**                        |

## Why the whole area (the corner that was cut, then fixed)

The first pass designed **only** the API-tokens card, bolted onto the existing
flat account page. That was a corner cut: the account surface is about to hold
more personal settings, and a flat card stack does not scale. So 7.8.2 designs
the account-settings **area architecture** — but only the panes we will actually
build now (see the scope guard below).

## Architecture — an "area" with a grouped rail nav (rung 2: the shipped pattern)

Settled by **already-shipped code**, not invented: Motir's **project settings**
is an _area_ (Story 6.5) whose grouped nav swaps into the app rail (`SidebarNav`
renders it from the `lib/settings/projectSettingsNav` registry when the route is
inside the area), one page per sub-section, with a route↔registry **totality
guard** and a "Soon" placeholder slot for designed-for pages. The account
settings adopts the **same** pattern (Yue's call, 2026-06-14):

- A new **`lib/settings/accountSettingsNav`** registry — the exact shape of
  `projectSettingsNav` (typed entries with `id` / `group` / `href` / `icon` /
  `labelKey` / `access` / `placeholder`), driving (1) the rail area nav, (2) the
  command-palette deep links, (3) the totality test pairing every
  `settings/account/**/page.tsx` route 1:1 with a real (non-placeholder) entry.
- The rail's **header** shows **"← Back to Motir"** + the **user identity**
  (initial `Avatar` + name + email) + the eyebrow **"Account settings"**.
- **Groups** (rail order): **General · Preferences · Security**.
  - **General → Profile** — a reserved **"Soon"** placeholder (name / avatar /
    password later), the disabled placeholder row, like the project area's
    Automation slot.
  - **Preferences → Language** (real), **Notifications** (real), **Appearance**
    (reserved **"Soon"** — see the scope guard).
  - **Security → API tokens** — the 7.8.3 page.
- Each REAL sub-section is its own route under `app/(authed)/settings/account/…`
  (Language / Notifications / API tokens). The existing flat account page's
  `LanguageCard` / `NotificationPreferencesCard` move into their panes.

### ✅ Scope update — Appearance IS now designed (Story 7.3 · 7.3.57 / MOTIR-1074)

The scope guard below held for **7.8.2**: Appearance was a reserved **"Soon"**
slot, deliberately not mocked, because we didn't yet know how it would work.
**That future story has now arrived** — once the three design axes shipped
(`data-style` 7.3.32+, `data-palette` 7.3.48+, `data-type` 7.3.53+) the feature is
concrete, so **7.3.57 designs it for real** in a separate mock,
**`appearance.mock.html`** (the `# Appearance` section at the end of this file).
The original scope-guard reasoning is preserved verbatim below as the record of
WHY it waited.

> **(7.8.2 scope guard — Appearance is NOT designed here · Yue, 2026-06-14 — now
> SUPERSEDED by 7.3.57.)** Appearance (theme / accent / font / display style)
> appears in the nav **only as a reserved "Soon" slot**. It is deliberately
> **not** mocked as a concrete control set: **"we are not going to implement it
> like this — it's misleading."** A design that draws specific
> theme/accent/font/display-style controls we won't actually build would mislead
> the implementer. Appearance gets its **own future story** that designs it
> properly when we decide how it works. The "Soon" row keeps the area's shape
> honest without over-committing.

So the surfaces designed **in `account-settings.mock.html` (7.8.2)** are exactly:
the **area shell**, the **Language** pane, the **Notifications** pane, and the
**Security/API tokens** pane + flows. The **Appearance** pane is designed in
**`appearance.mock.html` (7.3.57)** — it flips the rail's "Soon" Appearance slot
to a real, active entry.

### ⚠️ Planning flags (surfaced, not silently absorbed)

1. **The account-settings AREA shell** — the `accountSettingsNav` registry, the
   rail-swap wiring, the `settings/account` layout, the route split (Language /
   Notifications / API tokens pages), the totality test. It is a prerequisite
   bigger than 7.8.3's original "API tokens settings UI" scope. **Recommend a new
   shell subtask under Story 7.8, with 7.8.3 `dependsOn` it** (or re-scope 7.8.3
   to "API tokens page _inside_ the new account area").
2. **Appearance** — a future personalization **story** owns it (design + build).
   Not part of 7.8; reserved as a "Soon" nav slot here. **UPDATE (7.3.57):** that
   story arrived — Story 7.3 designs (7.3.57) + builds (7.3.58) the Appearance
   pane; the design is `appearance.mock.html`, indexed below.

---

## Panel 1 — Language pane (the area shell + the shipped Language preference)

The area shell: the **rail** (`--el-sidebar-bg`, `border-(--el-sidebar-border)`)
with the back-link + user identity + grouped nav (Language active = the
canvas-inset treatment: `bg-(--el-sidebar-item-bg-active)` +
`border-(--el-sidebar-border)` + `shadow-(--shadow-subtle)` + accent icon; the
`languages` glyph), and the **content** with the serif `h2` page head + a
`max-w-[680px]` card stack.

The Language page uses the **settings-row grammar** inside a `Card` — a label +
description on the left, the control on the right, hairline-separated
(`border-(--el-border-soft)`) — the pattern that scales as region / timezone /
date-format rows land later:

- **Card "Language"** → row **"Display language"** with the shipped `Combobox`
  (input-shaped trigger + `chevron-down`), value "English". This is the existing
  `LanguageCard` (`setLocale` cookie) moved into its pane.

## Panel 2 — Notifications pane

The shipped **`NotificationPreferencesCard`** matrix inside the area — a
`grid-cols-[1fr_5rem_5rem]` of event rows × **Email / In-app** columns of
`Switch` toggles (`role="switch"`, accent track when on). Header caption
(`--el-text-secondary` uppercase) with a `--el-border` rule; rows hairline-separated.
Each switch carries an `aria-label`. No redesign — it just moves into its pane.

## Panel 3 — Security & access pane (API tokens) — the 7.8.3 surface

The human face of the **PAT substrate** (7.8.1) the MCP bearer gate (7.8.4)
consumes. A PAT is **generated once, shown once, stored only as a hash,
expiring, revocable** — the Jira / GitHub API-token shape.

**Mirror surface (rung 1, VERIFIED):** Atlassian API tokens (`id.atlassian.com`
→ Security → API tokens) — create with label + expiry, a list of label / created
/ expires / last-used, revoke per row, secret shown once. The `motir_pat_` prefix
and the shown-once monospace copy field follow GitHub's PAT shape (a greppable
prefix for secret scanners). Motir keeps its coloured personality (peach
"expiring soon" chip, accent CTA) without inventing primitives.

- **Card "Your tokens"** with a header slot: title + sub on the left, the
  **"Create token"** primary `Button` (size `sm`, `plus` glyph) on the right.
- **The table** — a borderless row list (org-members roster grammar). Columns:
  **Label · Token · Created · Expires · Last used · Actions** (last
  right-aligned). `thead` is the `--el-text-secondary` uppercase caption with a
  `--el-border` rule; rows hairline-separated (`--el-border-soft`).
  - **Label** — `text-sm font-medium`.
  - **Token** — the `tokenPrefix` in an inline **code chip** (`font-mono text-xs`
    on `--el-code-bg`/`--el-code-text`, `rounded-(--radius-control)`):
    `motir_pat_AbC1…` (the full secret is never in the list).
  - **Created / Last used** — short/relative dates in `--el-text-secondary`;
    last-used falls back to a muted "Never".
  - **Expires** — short date; within ~7 days a **`Pill severity="warning"`**
    (peach, `--el-text-strong`, AA — finding #35); never-expiring reads "Never".
  - **Actions** — a square icon `Button` (ghost, `trash-2`, hover →
    `--el-danger`) with `aria-label` "Revoke token {label}", opening panel 6.
  - **Revoked row** — muted cells (`--el-text-faint`) + a `Pill tone="neutral"`
    "Revoked" instead of the revoke button (the soft-revoke row stays for audit;
    7.8.1's `revokedAt`). Sorted after live tokens.

The list is a **client island** (`'use client'`): create / revoke are optimistic
in-place mutations (the page-state-after-mutation contract — the island owns its
state via `useState(initialTokens)`, doing its own optimistic insert / mark-
revoked, NOT a `router.refresh()` it can't see). The page server-reads the
initial list via `apiTokensService.listForUser`.

## Panel 4 — Create modal

A `Modal` (`size="md"`, `title="Create API token"`, description "The token will
be shown once…"): a label `Input` (`helperText` "A name to recognise this token
by…", autofocus) + an expiry `Combobox` ("Expires" — 30 / 90 / 365 days / Never,
default **90 days**). Footer: ghost **Cancel** + primary **Create token**
(disabled until a non-empty label; `loading` while the POST is in flight).

## Panel 5 — Shown-once state

The SAME modal post-create (the create POST returns the plaintext exactly once —
7.8.1): title → **"Token created"**; a read-only, full-width **monospace secret
field** (`--el-surface` fill to read read-only) holding the full `motir_pat_…`
secret + a secondary **Copy** `Button` (`copy` glyph); a **peach-tint warning
callout** (`--el-tint-peach`, `--el-text-strong`, AA; `triangle-alert` in
`--el-warning`) — "This is the only time you'll see this token…"; footer a single
primary **Done**.

## Panel 6 — Revoke confirm

A destructive `Modal` (`size="sm"`, `title='Revoke "{label}"?'`): a **rose-tint
danger callout** (`--el-tint-rose`, `--el-text-strong`; `triangle-alert` in
`--el-danger`) — "Any agent using this token loses access… can't be undone."
Footer: ghost **Cancel** + **`Button variant="danger"`** "Revoke token"
(`trash-2`). On confirm the row optimistically flips to the muted revoked state.

## Panel 7 — Empty state

The shipped **`EmptyState`** (Card + icon + title + description + action): lucide
**`key-round`** (48px, `--el-text-muted`) via the `icon` prop; title **"No API
tokens yet"**; description explaining what tokens do + a link to the **MCP setup
guide** (`docs/mcp.md`, the 7.8.8 doc); a primary **"Create token"** action.

## Panel 8 — Copy-confirmation toast

The shipped **`Toast`** (`variant="success"`, `--el-success` border +
`CheckCircle2`): title **"Token copied"**, body "Paste it into your agent's MCP
config now — it won't be shown again." Fired from the shown-once Copy handler.

## i18n

- **new `settings.account` namespace** — `eyebrow` ("Account settings"),
  `back` ("Back to Motir"), `nav.group.{general,preferences,security}`,
  `nav.{profile,language,notifications,appearance,apiTokens}`, `nav.soon`
  ("Soon").
- **`settings.language`** — `heading` ("Language & region"), `subtitle`,
  `card.title`, `card.subtitle`, `displayLanguage.{label,desc}`. (The Combobox
  options reuse the existing locale labels.)
- **`settings.apiTokens`** — `heading`, `subtitle`, `card.{title,subtitle}`,
  `create` ("Create token"), `columns.{label,token,created,expires,lastUsed,
actions}`, `expiresIn` ("in {n} days"), `expiresNever`, `lastUsedNever`,
  `revoked`, `revokeAria`, `create.{title,description,labelField,labelHelper,
expiresField,expiresHelper,submit,cancel}`, `expiry.{d30,d90,d365,never}`,
  `created.{title,description,secretLabel,copy,warning,done}`,
  `revokeConfirm.{title,body,confirm,cancel}`, `empty.{title,body,guideLink}`,
  `toast.{title,body}`.
- Notifications keeps its shipped `settings` keys (5.7.6). Same locale set.

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the accent on the active nav
  row glyph; the CTAs + on-Switch track; the `--el-tint-peach` expiring chip +
  warning callout; the `--el-tint-rose` revoke callout; `--el-danger` revoke;
  `--el-success` toast; `--el-code-bg` token chips; the `--el-tint-yellow` "Soon"
  chips. No Tier-0 `--color-*` / Tailwind Tier-0 utilities. Tints carry the hue
  in the BACKGROUND with `--el-text-strong` text (finding #35, AA — verified
  light **and** dark).
- **Shape** via element-semantic tokens only (`--radius-card` / `-input` / `-btn`
  / `-badge` / `-control` / `-modal`, `--shadow-subtle` / `-card` / `-modal` /
  `-elevated`, `--spacing-card-padding` / `-control-*` / `-input-*` / `-chip-*` /
  `-icon-btn`, `--height-control` / `-input` / `-btn-*`) — no Tier-0 scale, no raw
  `rounded-md` / `p-1` / `h-9`. `rounded-full` only on the avatar / switch track.
- **Not colour-alone** (finding #35): the expiring / revoked chips carry text;
  callouts pair tint + icon + copy; the revoke button is icon + `aria-label`; the
  "Soon" nav rows carry a text chip, not just muting.
- **A11y**: the rail nav is grouped `SidebarSection`s; switches = `role="switch"`
  - `aria-label`; the create / shown-once / revoke surfaces are `Modal` (Radix
    focus trap, ESC, labelled); the secret field is read-only and the ONLY place
    the plaintext appears (never logged / in a DTO — 7.8.1); the toast is
    `role="status"`.
- **Dark mode** confirmed (toggle in the mock): every surface / text / tint /
  chip flips via the token layer and stays AA.

## Primitives composed (no hand-rolling)

| Element                      | Shipped primitive                                                        |
| ---------------------------- | ------------------------------------------------------------------------ |
| area shell (rail + content)  | `app/(authed)` rail + `SidebarNav` (the 6.5 settings-area shape)         |
| grouped nav registry         | `lib/settings/accountSettingsNav` (new — mirrors `projectSettingsNav`)   |
| card / empty                 | `components/ui/Card.tsx` · `components/ui/EmptyState.tsx`                |
| notification toggles         | `components/ui/Switch.tsx`                                               |
| language / expiry select     | `components/ui/Combobox.tsx`                                             |
| create / revoke / shown-once | `components/ui/Modal.tsx` (Radix Dialog)                                 |
| label field                  | `components/ui/Input.tsx` + `components/ui/FormField.tsx`                |
| chips                        | `components/ui/Pill.tsx` (`severity="warning"` / `tone="neutral"`)       |
| buttons                      | `components/ui/Button.tsx` (primary / secondary / ghost / danger / icon) |
| token-prefix chip            | inline `--el-code-bg` / `--el-code-text` code grammar                    |
| copy confirmation            | `components/ui/Toast.tsx` (`useToast`, `variant="success"`)              |

No new design-system primitive is invented for this surface. If a future need
arises that a shipped primitive can't cover, that is a NEW `design/` subtask, not
a code workaround.

---

# Token PERMISSION selection — `token-scopes.mock.html` (MOTIR-2578)

> **⚠️ THIS SECTION SUPERSEDES the 7.7.18 one below it**, which designed a picker
> over the six retired `TokenScope` values. Story MOTIR-2572 replaced those with
> the MOTIR-2254 permission catalog (`docs/decisions/token-permissions.md`), so the
> vocabulary the picker grants CHANGED. The old section is kept, unedited, as the
> record of what the shipped component was built to — read it to understand the
> code you are replacing, never as the target.

**Rendered before drawing** (the design-against-shipped-reality gate): the asset
was rendered with `scripts/render-token-scopes.mjs` (chromium, light, ×2, 1200px)
and the measurements below are that render's, not estimates. The composition was
amended against those pixels. The shipped `CreateTokenModal.tsx` cites this asset
as its source, and its markup was read alongside — the copy here is now the
SHIPPED `permissions.*` i18n strings, so the mock and the component resolve the
same words.

## ⚠️ THE COUNT — six rows, five groups. Measured, and it changes the answer.

**`GRANTABLE_PERMISSIONS` is SIX keys across FIVE domains**, derived from the
operation maps (`lib/tokens/grant.ts`): a permission is grantable because some
token-reachable operation asserts it.

| Domain (group label) | Permission key     | Label (shipped)   | Default                      |
| -------------------- | ------------------ | ----------------- | ---------------------------- |
| Project              | `project:browse`   | View project      | **on**                       |
| Work items           | `work_item:edit`   | Edit work items   | **on**                       |
| Work items           | `work_item:delete` | Delete work items | **off** — the one danger row |
| Comments             | `comment:add`      | Add comments      | **on**                       |
| Sprints & backlog    | `sprint:manage`    | Manage sprints    | **on**                       |
| AI planning          | `ai:plan`          | Run AI planning   | **on**                       |

Six of the catalog's 31 keys. The other 25 govern UI-administration surfaces no
API caller can reach; offering one would be a switch that gates nothing — the
lie `lib/permissions/catalog.ts` opens by forbidding.

**MOTIR-2578's brief assumed "twenty-plus rows across sixteen domains" and asked
which of a scrolling list / collapsing sections / a rail-and-pane / presets should
replace the two-column grid. At six rows the honest answer is NONE OF THEM.** Six
is the same row count the six retired scopes had. Adding a collapse to a panel
that does not need one, or presets over six switches, would be complexity bought
with nothing. **Rejected, with the reason: not enough rows.**

## THE MEASUREMENT — the number, not an adjective

Modal panel heights, natural (unclipped), from the render script:

| Panel | Shape                                                                                                                                | Height    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| 1     | resting, single-org account + the optional Project picker                                                                            | **836px** |
| 1b    | **tallest reachable**: ≥2 orgs + ≥2 workspaces (discloses the Organization Combobox) + the Project picker + every permission granted | **938px** |
| 1c    | a viewer's capped offer — two grantable rows, four locked                                                                            | 646px     |

Against the shipped `max-h-[90vh]` ceiling:

| Viewport             | Ceiling | 938px verdict                |
| -------------------- | ------- | ---------------------------- |
| 720px (short window) | 648px   | scrolls                      |
| 800px (13" laptop)   | 720px   | scrolls                      |
| 900px (15" laptop)   | 810px   | scrolls                      |
| 1080px               | 972px   | **fits, with 34px to spare** |

⚠️ **The Project picker cost 102px, not 34.** It is a third field in a
`1fr 1fr` metadata grid, so it does not slot in beside Workspace — it WRAPS the
grid onto a second row. Worth knowing before anyone adds a fourth field: the
next one is free, the one after that costs another row.

**Decision: the body SCROLLS at the tallest shape, and that is the shipped
contract working, not a failure.** MOTIR-2488 already moved the fields into
`Modal.Body` with the footer PINNED beside it, precisely so a tall form scrolls
its body while Cancel / Create token stay reachable. The pre-change modal was
718px resting and already over the 13" ceiling at the two-org shape, so scrolling
is not a regression the new vocabulary introduces. What the vocabulary itself
costs is 16px (five domain groups carry one more label than the old four); the
Project picker costs the other 102px, and that is a binding-axis decision
(MOTIR-2605), not a picker one.

**What the code card must therefore check** (MOTIR-2580): at the ≥2-org /
≥2-workspace shape, with every permission on, BOTH footer buttons are visible and
reachable and the scroll is inside `Modal.Body`. That is the shape the
single-tenant fixture never renders — and the one the clipped-footer bug appeared
on.

## ⚠️ THE OFFER IS PER-ACTOR — and the token may bind to a PROJECT (Yue, 2026-08-10)

**This amends the section above, and overturns story MOTIR-2572's own scope
boundary** (_"a token is still BOUND to one workspace and the binding picker is
untouched"_). Recorded, not implied. The decision is MOTIR-2605's ADR section;
this is what it means for the pixels.

**What was wrong with the first pass.** The picker offered the same six rows to
everyone, and `apiTokensService.create` validates only against the STATIC
grantable set. So a viewer could tick _Delete work items_, mint the token, and
hold a grant they cannot exercise anywhere — the switch-that-gates-nothing lie,
one level up, on a screen that promises _"You can grant less than your own
access, never more."_

**Why it needed a decision and not a filter.** Permissions resolve **per
project** (`lib/permissions/resolve.ts`: `accessLevel` + `workspaceRole` +
`projectRole` + custom role) while a token binds to a **workspace**. There is no
single "the user's role" — an admin in project A can be a viewer in project B of
the same workspace.

**The decision: the project binding is REQUIRED where the GRANT IS CHOSEN, and
absent where it is fixed.**

| Credential                           | Grant                                             | Binding                           |
| ------------------------------------ | ------------------------------------------------- | --------------------------------- |
| Hand-minted (the create-token modal) | **chosen** from that project's set for that actor | **project** — required            |
| Device (`motir login` → `/device`)   | **fixed** `CLI_TOKEN_GRANT`, unconfigurable       | **workspace** — `project_id` NULL |

The incoherence was never the binding; it was the PICKER. A chosen grant on a
workspace-bound token asks _"may this token edit work items?"_ with no project to
answer for — permissions resolve per project, so the switch means nothing until
one is named. A FIXED grant asks nothing: `motir login`'s screen shows
`CLI_TOKEN_GRANT` and cannot edit it, so `grant ∩ role` resolves per project at
dispatch and there is no question on screen to be wrong.

`api_token.project_id` is therefore **nullable, and NULL is a MEANING** — the
device-credential shape — not a tolerance. Write it that way in the schema: a
column documented as "optional" becomes `NOT NULL` in six months with no correct
backfill; one documented as a shape does not.

**Two things this rules OUT, because earlier revisions of this note said
otherwise:** `list_projects` is NOT retired (it serves the device credential, and
`motir link` / `autoLinkAfterLogin` call it to bind a folder), and there is no
`NOT NULL` migration and no token cutover.

### What the picker draws

- **The Project picker sits beside Workspace**, labelled _The token acts in this
  project only_ — REQUIRED, because this modal is where the grant is chosen.
  Panels 1 and 1b.
- **A row the actor cannot confer is DISABLED with its reason** (`.scope-row.locked`
  - `.locked-why`), never hidden. A vanished row reads as a missing feature and
    sends someone hunting; a disabled one teaches the composition rule the helper
    text already states. At six rows this is never a wall — which is the second
    time the row COUNT decides the design.
- **The danger row stays rose even when locked.** The row a viewer most needs to
  understand they cannot grant is the destructive one.
- **Faint ink is correct here and only here.** `.scope-row.locked` uses
  `--el-text-faint`, which 1.4.3 exempts for disabled controls, and the REASON
  beside it carries the meaning at `--el-text-secondary`. This is the one place
  in the asset where faint on informational-looking text is right, and it is
  right because the control is disabled.
- **The offer RECOMPUTES when the Project picker changes.** A different project
  is a different set. Panel 1c pins this for MOTIR-2580.
- **A workspace owner sees no locked rows at all** — `resolvePermissions` layer 2
  hands them the whole role-gated catalog in every project. So this panel never
  appears for most people who mint tokens, and everything for members and
  viewers. Say it out loud, or the next reader will think the filtering is dead
  code.

### GIVES / TAKES for the binding

- **TAKES from [MOTIR-2605]** the required-where-chosen rule and the refusal shape.
- **GIVES to [MOTIR-2606]** the requirement that ONE service read feeds both the
  offer and `create`'s validation — two implementations would agree the day they
  are written and drift the first time an access level changed.
- **GIVES to [MOTIR-2580]** the recompute-on-project-change and the locked-row
  treatment.

## What CHANGED from the 7.7.18 design, and what did not

**Unchanged** — the wide (~42rem) modal, the two-column grid, `Switch` rows of
`icon + name + description`, the rose `.scope-danger` block for the irreversible
key, the list's summary Pill + persistent "Can delete" chip, the chevron
disclosure, and the binding-scope picker.

**Changed:**

1. **Grouping is the catalog's DOMAINS**, not invented buckets — `Project`,
   `Work items`, `Comments`, `Sprints & backlog`, `AI planning`, read from
   `permissions.domain.*`. Column split is 3 rows / 3 rows so neither column
   drives the height alone.
2. **Copy is the SHIPPED `permissions.<slug>.label` / `.description`** — the same
   strings the Roles & permissions screen renders. This asset authors NO copy for
   the rows, which is the point: one capability, one sentence, everywhere.
3. **The archive row is GONE.** `work_items:archive` and `work_items:delete` were
   two scopes and two rows; `archiveWorkItem` / `unarchiveWorkItem` /
   `deleteWorkItem` all assert `work_item:delete`. Two rows over one key would be
   two switches that cannot move independently. **One row**, and the caption names
   both acts — otherwise someone flips it expecting only the recoverable half.
4. **The default grant therefore no longer includes archiving.** "All but the
   irreversible one" now withholds archive too. Drawn: the danger row is the only
   one off in Panel 1.
5. **AI planning is its own row.** It used to ride inside _edit work items_, which
   meant a token wired to file issues could also spend the workspace's AI credits.
6. **No raw `resource:action` key is drawn anywhere.** An earlier revision of this
   asset put the key under each row so a 403 naming `work_item:edit` could be
   traced to its switch. **Removed** — MOTIR-2579's acceptance criteria forbid
   displaying a raw key to a reader, and a design that contradicts a sibling
   card's AC is a design that will not be built. The label is the surface; the
   shared presenter is what maps a key to it. (It also cost 63px of height.)
7. **"Create API token" → "Create token"**, and the pane is **Tokens** at
   `/settings/account/tokens` (MOTIR-2532's shipped copy).

## The panels

1. **Create token, resting** — single-org shape, default grant applied, with the
   optional Project picker. 836px.
   1b. **Dense / tallest** — ≥2 orgs, ≥2 workspaces, the Project picker, every
   permission on. **938px.** The panel the height decision is made against.
   1c. **A viewer's capped offer** — the same modal for someone holding only
   `project:browse` and `comment:add` in the bound project: four rows DISABLED
   with their reason. See § THE OFFER IS PER-ACTOR.
2. **The Work items group, Delete ON** — the danger close-up. Rose
   `--el-tint-rose` block, `· Danger` tag, trash icon, and the cascade caption
   that now names archiving too.
3. **Empty / invalid** — nothing granted; inline `.scope-error` + disabled CTA.
   The refusal is the SURFACE's: the service accepts an empty grant and mints a
   do-nothing token, so nothing below the UI would stop you.
4. **Token list** — the columns are now **Permissions** and **Acts in**. The
   second is what makes the two credential shapes legible side by side: a
   hand-minted token names its PROJECT, the `motir login` credential names its
   WORKSPACE and adds _"Every project your roles reach"_. Without that line the
   column reads as an inconsistency rather than two kinds of credential — and
   every pre-change token is the workspace shape, so the revoked legacy row
   reads correctly too. Summary Pill (Full access /
   Standard / Read only / Custom) and the "Can delete" chip are **kept, not
   re-decided**: at six keys a cell could nearly list them, but a cell that grows
   with the catalog breaks the day the catalog grows, and the four words read
   correctly over the new set.
5. **A row expanded** — the granted permissions as chips, by shipped label.
6. **`/device` approval** — the CLI's FIXED grant, four permissions
   (`project:browse`, `work_item:edit`, `comment:add`, `ai:plan`). Names only,
   one-screen fit preserved. **What it CANNOT do is drawn**, because the two
   withheld keys (delete/archive, sprints) are exactly what someone approving a
   remote machine needs to know, and an omission is invisible unless stated.
7. **THE ACCESS PATH** — avatar menu → Settings → the Account rail →
   **Tokens** → the **Create token** button in the "Your tokens" card header,
   ringed with `--el-accent-on-surface`. There is no other route to the picker.

## Colour + contrast

Every colour is an `--el-*` token; every radius/spacing a shape token. Fixed in
this pass, because the AC asks for it and the AST ink guard cannot see CSS:

- `.scope-grp-label`, `.grp-label`, `.settings-eyebrow`, `.ttable thead th` moved
  `--el-text-faint` → `--el-text-secondary`. Faint measures **2.61** on the white
  modal and these are all INFORMATIONAL text (a domain heading, a nav section, an
  area eyebrow, a column heading), not decoration. Faint survives only on
  `.panel-label` (asset chrome, not product UI), `.nav-row.soon` and
  `.ttable tr.revoked` (disabled / inactive, which 1.4.3 exempts).
- `.scope-desc` stays `--el-text-muted` — **4.54 on the white modal panel**, which
  is where it renders. Inside `.scope-danger` it is already overridden to
  `--el-text-strong` on the rose tint.
- `.sw.on .kn` was a raw `#fff`; now `--el-text-inverted`, so the knob flips with
  the theme.

## GIVES / TAKES

- **GIVES to [MOTIR-2579]** — the group order, the summary vocabulary, the danger
  treatment, and the rule that no raw key is rendered.
- **GIVES to [MOTIR-2580]** — the composition, the default grant, and the 938px /
  ≥2-org footer-reachability check.
- **GIVES to [MOTIR-2586]** — the access path to walk, and the empty-grant refusal
  to assert.
- **TAKES from [MOTIR-2573]** the grantable set and which key is irreversible;
  **TAKES from [MOTIR-2532]** the "Tokens" label and the `/settings/account/tokens`
  address.

---

# Token scope selection — `token-scopes.mock.html` (Story 7.7 · 7.7.18)

The reference the **7.7.19** code subtask builds against. It EXTENDS the
API-tokens surface designed in 7.7.2 (Panels 3–8 of `account-settings.mock.html`,
which cover list / create / shown-once / revoke / empty) by adding the one thing
that design lacked: **permission-scope selection**. Nothing else in the
create→shown-once→revoke flow changes. Built from the SAME token block + shipped
primitives as `account-settings.mock.html`, so 7.7.19 composes identical
primitives — no Pencil→code gap.

### ⚠️ Two senses of "scope" — do not conflate

- **Binding scope** (bug 7.21, already shipped in 7.7.2 / `CreateTokenModal`) —
  the **org → workspace** a token is bound to (the "Workspace" field, reading
  `Default` for a lone workspace). **Unchanged here.**
- **Permission scope** (THIS asset, the 7.7.16 scope list) — **what the token may
  DO**. New. Rendered as the create-modal "Permissions" picker + the list's
  "Scopes" column.

The 7.7.16 canonical scope list is the source of truth for the scope KEYS; this
asset owns their **plain-language labels/descriptions** (written for Yue's
non-developer acceptance — Principle #18 — never the raw `work_items:write`
string) and their **grouping + default state**.

## The 6 scopes — labels, copy, group, default, icon

The picker renders the 6 scopes (7.7.16) as grouped, plain-language **`Switch`**
toggles (`role="switch"`, accent track when on). Default state: **ALL on EXCEPT
delete.** Each row is `icon + name + one-line description` on the left, the
`Switch` on the right, hairline-separated within a group.

| Scope key (7.7.16)   | Group (column)                     | Label (plain)        | Description                                                                  | Default | lucide icon  |
| -------------------- | ---------------------------------- | -------------------- | ---------------------------------------------------------------------------- | ------- | ------------ |
| `read`               | Read (left)                        | Read everything      | View work items, boards, sprints, comments, and reports.                     | **on**  | `eye`        |
| `sprints:write`      | Sprints (left)                     | Manage sprints       | Create sprints and move work items in and out of them.                       | **on**  | `zap`        |
| `integration`        | Integrations (left)                | Connect integrations | Link external tools and post activity back to Motir.                         | **on**  | `plug`       |
| `work_items:write`   | Work items (right)                 | Edit work items      | Create and update work items, comments, links, and attachments.              | **on**  | `square-pen` |
| `work_items:archive` | Work items (right)                 | Archive work items   | Archive and restore work items. This can be undone.                          | **on**  | `archive`    |
| `work_items:delete`  | Work items (right, **danger row**) | Delete work items    | Permanently delete a work item and its entire subtree. This can't be undone. | **OFF** | `trash-2`    |

> The exact scope-key spelling above mirrors what 7.7.16 ships; if 7.7.16's final
> keys differ, 7.7.19 maps label→key by the **group + meaning**, not the literal
> string. The labels/descriptions/grouping/default here are the binding spec.

## Panel 1 — create modal with the Permissions picker (default)

### ⚠️ Width, not scroll (Yue, 2026-06-16) — show all scopes at once

A scrolled picker hides options: the user can't tell more scopes exist below the
fold. So the create modal **uses its width** instead. It **WIDENS** and lays the
fields out so all six scopes are visible without any scroll region:

- **The modal widens** from the 7.7.2 `size="md"` (28rem) to **~42rem**. 7.7.19
  applies a `max-w-[42rem]` className to the shipped `Modal` (or adds a size token
  if we want it reusable) — the size-variant rems are the swap-safe knob; a one-off
  `max-w-[…]` className is the same pattern the peek/lightbox modals already use.
- **Metadata pairs up:** Label is full-width; **Workspace + Expires sit side by
  side** in a 2-column row (`.meta-cols`) — using the width and saving a row.
- **The permission picker is a 2-COLUMN grid** (`.scope-cols`), capability groups
  split across the columns so the whole set fits:
  - **Left column:** **Read** (Read everything) · **Sprints** (Manage sprints) ·
    **Integrations** (Connect integrations).
  - **Right column:** **Work items** — Edit work items · Archive work items ·
    then the **Delete danger row**.
- Each **scope row** (`.scope-row`): a 16px lucide glyph in `--el-text-muted`, the
  name (`text-sm font-medium --el-text`), the one-line description (`text-xs
--el-text-muted`), and a `Switch` on the right. Hairline `--el-border-soft` between
  rows inside a group; `grp-label` captions (`--font-mono`, uppercase,
  `--el-text-secondary`) head each group.
- **Default render:** Read / Manage sprints / Connect integrations / Edit /
  Archive all **on** (accent track); **Delete off**.

No scroll, no hidden overflow — the whole capability set reads at a glance, and the
Cancel / Create footer sits directly below the grid. (If a future scope count grows
the grid beyond the 90vh cap, the shipped `Modal` still caps at `max-h-[90vh]` and a
`Modal.Body` wrapper would scroll as the fallback — but at six scopes the width
layout fits comfortably and is the intended shape.)

## The Delete danger row (distinct treatment, off by default)

`work_items:delete` is the LAST row of the **Work items** group (right column),
rendered as its **own rose danger row** (`.scope-danger`: `bg-(--el-tint-rose)`,
`border-(--el-border-soft)`, `rounded-(--radius-card)`), set apart from the safe
scopes so granting deletion is a **deliberate, visible act**:

- The scope name carries a small **"· Danger"** `tag` in **`--el-danger`**
  (`--font-mono`, uppercase) — colour-plus-text, never colour alone (finding #35).
- The scope glyph (`trash-2`) is `--el-danger`; the name is `--el-text-strong`;
  the "This can't be undone" caption is `--el-text-strong` (AA on the rose tint).
- The `Switch` is **OFF** by default. Flipping it on is shown in **Panel 2** — the
  rose row, tag, icon, and caption stay; only the track turns accent. (Confirmed AA
  in light AND dark — Panel 2 + the dark toggle on the wide modal.)

## Panel 2 — Work-items group with Delete turned ON (the deliberate grant)

A close-up of the right column's **Work items** group with the delete `Switch`
flipped **on**: Edit / Archive as plain rows above, then the rose danger row with
its accent track now on. Confirms the danger treatment in its granted state — the
distinct rose styling persists, so an on delete scope still reads as dangerous.

## Panel 3 — disabled / error state (every scope off)

A token must grant **at least one** permission. With every toggle off:

- An inline **`.scope-error`** ("Grant at least one permission to create a token.")
  in `--el-danger` with an `alert` glyph appears under the picker.
- The **"Create token" CTA is disabled** (the existing `disabled`/`loading` CTA
  grammar — 7.7.2 already disables it on an empty label; this adds the empty-scope
  condition). The binding `workspaceId` check from 7.7.2 is unchanged.

This is the only NEW validation state; create / shown-once / revoke / empty are
exactly 7.7.2.

## Panel 4 — token-list granted-scope display (the "Scopes" column)

The list (`ApiTokensManager`, Panel 3 of 7.7.2) gains a **Scopes** column between
**Token** and **Workspace** — compact, **no row bloat**:

- A single **summary `Pill`** classifies the grant, semantic not numeric (Yue
  reads meaning, not `5 of 6`):
  - **Full access** — all 6 (incl. delete) → `Pill` **mint** tone
    (`--el-tint-mint`, `--el-text-strong`).
  - **Standard** — the default set (all minus delete) → `Pill` **neutral**.
  - **Read only** — `read` alone → `Pill` **neutral**.
  - **Custom** — any other subset → `Pill` **neutral**.
- **`work_items:delete` is never hidden behind a summary.** Whenever delete is
  granted, a **persistent rose `Pill` "Can delete"** (`--el-tint-rose`,
  `--el-text-strong`, `trash-2` glyph) rides beside the summary — the dangerous
  capability is always visible at a glance, mirroring the create-modal's
  danger-zone emphasis.
- A **chevron `disclose` button** (`chevron-down`, `--radius-control`,
  `aria-expanded`) expands the row.
- **Revoked rows** show the muted summary only (no chevron) — consistent with the
  7.7.2 revoked-row muting.

## Panel 5 — expanded scope detail

The chevron opens a **detail sub-row** (`.scope-detail` → a `td colspan`),
a `--el-surface-soft` card holding a "This token can:" lead + one **chip per
granted scope** (icon + plain label). The **Delete** chip reads as a rose
**`.scope-chip.danger`** (`--el-tint-rose`, `--el-text-strong`). Plain names
only — never the raw `work_items:*` keys. The chevron flips to point up
(`.disclose.open`).

## Token / a11y rules honoured (additions to the 7.7.2 list)

- **Colour** strictly via `--el-*`: the accent Switch track; `--el-tint-rose` +
  `--el-danger` for the delete danger row / "Can delete" chip; `--el-tint-mint`
  for the Full access pill; `--el-text-muted` scope glyphs; `--el-text-strong` on
  every tint (AA — finding #35, verified light + dark). No Tier-0 `--color-*`.
- **Shape** via element-semantic tokens only — `--radius-card` (danger row,
  detail card, summary `--radius-badge`), `--radius-control` (disclose button),
  `--spacing-chip-*` (chips), `--spacing-control-*`. No raw `rounded-md` / `p-1`.
- **Not colour-alone** (finding #35): the delete danger row pairs rose tint + the
  `trash-2` icon + the "can't be undone" copy + a "· Danger" text tag; the delete
  grant in the list carries the text chip "Can delete", not a bare colour; every
  scope toggle has a text label and `aria-label`.
- **A11y:** scope toggles are `role="switch"` + `aria-checked` + `aria-label`,
  wrapped in a `role="group"` labelled by the "Permissions" heading; the disclose
  control is a real `<button>` with `aria-expanded` + a descriptive `aria-label`
  ("Show scopes for {label}"); the empty-scope error is inline form text. The
  detail sub-row is plain table markup.
- **Dark mode** confirmed (toggle in the mock): the rose delete row, mint/rose
  pills, and accent switches all flip via the token layer and stay AA.

## Primitives composed (additions — no hand-rolling)

| Element                          | Shipped primitive                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| scope toggles                    | `components/ui/Switch.tsx` (`role="switch"`)                                                  |
| summary / "Can delete" / chips   | `components/ui/Pill.tsx` (mint / rose / neutral tones)                                        |
| Permissions section + danger row | `components/ui/Card.tsx` callout grammar + the `field` form row                               |
| 2-column scope grid              | layout-only CSS grid (`.scope-cols`) — gaps are layout, not shape                             |
| disclose / expand                | a ghost icon `button` (the existing `icon-btn` grammar) + `chevron`                           |
| modal / CTA / inputs             | unchanged from 7.7.2 (`Modal` / `Button` / `Input` / `Combobox`), the modal widened to ~42rem |

No new primitive is invented. The "Can delete" rose pill and mint "Full access"
pill are existing `Pill` tones; the delete danger row is the callout grammar
already used by the shown-once warning + revoke confirm. The 2-column grid is
layout-only (sibling gaps, not a control's own shape), so it stays raw per the
shape-token rule.

---

# Appearance pane — `appearance.mock.html` (Story 7.3 · 7.3.57 / MOTIR-1074)

**The meta concept made concrete.** Motir is built on a **three-axis design
system** — Colour (`data-palette`) · Type (`data-type`) · Shape/feel
(`data-style`), plus a light/dark base (`data-theme`) — that re-skins / re-types /
re-shapes the **whole** app at runtime from the `<html>` element. The Appearance
pane is **that system turned on itself**: it lets the signed-in user theme **the
Motir app itself**, and SHOWCASES the design ability by re-rendering live as they
choose. This is the account-settings face of the system the onboarding _design
wizard_ (7.3.27 / 7.3.44) introduced for the user's _own product_ — same axes,
same picker language, now pointed at Motir.

**This flips the reserved "Soon" slot to a real entry.** The pane lives at the
`appearance` slot in `lib/settings/accountSettingsNav.ts` (group `preferences`,
`Palette` icon) — 7.3.58 sets its `href`/removes `placeholder`. Until then the
rail shows it as "Soon" (the 7.8.2 state).

## What it reuses (no new vocabulary — the precondition checks)

- **The area shell** — rail + content + `Card` grammar — is **`account-settings.mock.html`**
  (7.8.2) verbatim: the back-link + user identity + grouped nav (General /
  Preferences / Security), the serif `h2` page-head, the hairline-separated cards.
- **The axis pickers** — the `.pick` **chip rows** — and the **showcase specimens**
  (the live card / type specimen / palette swatches) are the onboarding
  design-wizard's language (7.3.27 / 7.3.44 / 7.3.37,
  `design/ai-chat/onboarding.mock.html`), adapted to a settings-pane layout.
- **The three axis registries** drive the option sets, 1:1 with shipped code:
  **Style** `lib/theme/styles.ts` (6 styles: Warm Editorial, Soft / Playful,
  Swiss / Minimal-Flat, Neo-Brutalism, Glassmorphism, Cybercore / Y2K); **Palette**
  `lib/theme/palettes.ts` (5: Motir, Cobalt, Graphite, Evergreen, Spectrum);
  **Type** `lib/theme/typography.ts` (6: Motir, Motir Sans, Motir Mono, Grotesk,
  Editorial, Mono-Technical). **Theme** is the existing `ThemePattern` (Light /
  Dark / System; `THEME_STORAGE_KEYS`).
- **Authentic rendering.** The mock's `<style>` copies the `:root` tokens, the
  `[data-theme=dark]` block, and **every** `[data-style]` / `[data-palette]` /
  `[data-type]` axis block + the nested-palette specimen fix 1:1 from
  `app/globals.css` (via the onboarding mock), and loads the six real next/font
  faces — so each panel re-skins / re-shapes / re-types EXACTLY as the running app
  will. Component CSS references ONLY `--el-*` colour + element-semantic shape
  tokens (the colour + shape rules).

## Layout — the page IS the preview (no separate "live preview" widget)

**Key decision (Yue, 2026-06-19).** The three axes apply to **Motir itself**, and
they apply **instantly** (`localStorage` → `<html>`, the inline-edit-no-refresh
preference contract — like every theme toggle: Linear / GitHub / Notion all switch
immediately, the mirror-product standard). So the moment you pick, **the whole page
re-skins — this page included.** A separate "live preview" card would be redundant:
it would show "Motir in this selection" while you are already looking at exactly
that. The earlier v1 had such a preview rail; it was **removed**.

Instead the page is deliberately **design-rich** so that picking ANY axis visibly
transforms it — the Appearance page doubles as the **design-system showcase**
(which is the meta concept: showcase Motir's design ability on Motir itself). Single
column, two regions:

**1 — The controls** (one `Card`, "Theme & design"), four hairline-separated
`.axis-field`s (name + helper + control + a live registry `.axis-note`):

- **Theme** — a **segmented control** (`.segmented` / `.seg`): Light (`sun`) · Dark
  (`moon`) · System (`monitor`); active = `--el-page-bg` fill + `--shadow-subtle` +
  accent icon. (The shipped `ThemeToggle` pattern — the one new composition.)
  Picking Dark flips the **whole app chrome — the left rail included** (the rail is
  `--el-sidebar-bg`, which is `[data-theme=dark]`-driven), not just the content;
  Panel 3 shows the dark rail. This is the dogfood: Theme sits on `<html>`, so it
  themes everything.
- **Style** — a `.pick` **chip row** of the 6 styles; active = accent border +
  `--el-tint-lavender` fill + `--el-accent-on-surface` text + a `check`.
- **Palette** — chip row of the 5 palettes, each with an 11px **swatch dot** in the
  palette's accent hue.
- **Typography** — chip row of the 6 pairings, **each label set in its own headline
  face** (Source Serif 4 / Inter / JetBrains Mono / Space Grotesk / Fraunces / IBM
  Plex Mono) so the chips themselves preview the type. **Labelled "Typography", not
  "Type" (Yue, 2026-06-19):** `type` is the internal axis name (`data-type`,
  `typography.ts`, `TypeId`) and is correct designer jargon, but as a user-facing
  label next to Style / Palette it reads ambiguously to non-designers (= "kind"),
  so the UI says **Typography** (unambiguous, matches `typography.ts`). The
  `data-type` attribute / registry id stay `type`.

The card sub-copy + the page-head ("the whole app re-skins live… there's nothing to
save") state the instant-apply, no-Save model.

**2 — The showcase band** (`.showcase`, eyebrow "Your look — live across Motir") — a
real Motir slice that exercises EVERY axis, so each pick ripples visibly:

- a **work-item card** (`.sc-item`) — a `square-check` kind + `PROD-128` (mono), an
  **accent status `Pill`** ("In review"), a **serif/headline title** ("Rebuild the
  billing flow"), body copy (body face), a **label row of tinted `Pill`s**
  (`--el-tint-sky` / `-peach` / `-rose`, AA `--el-text-strong`), mono meta, and a
  **primary `Button`** ("Comment") + secondary ("Assign") + ghost icon-button;
- a **side stack** — a `Card` with a search `Input` + list rows (accent dots +
  muted bars), the **palette-role swatch strip**, and a **type specimen** ("Ag" +
  serif headline + body + mono meta).

So colour shows in the accent pill/button/dots + the tinted labels; shape shows in
the card/button/input/pill radii + elevation; type shows in the title, body, mono
meta and the "Ag" specimen — all token-driven, all re-rendering on every pick.

## The access path (mistake-#31 — DRAW the door)

Every panel draws the **account-settings rail** with **Appearance ACTIVE** under
**Preferences** (between Notifications and Security) — the "Soon" placeholder
flipped to the canvas-inset active treatment (`--el-sidebar-item-bg-active` +
`--el-sidebar-border` + `--shadow-subtle` + accent `palette` glyph). That IS the
entry affordance: how the user reaches the pane (Account settings → Preferences →
Appearance), drawn, not just named.

## Panels

- **Panel 1 — Default / factory.** Theme **System** · Style **Warm Editorial** ·
  Palette **Motir** · Type **Motir** — the base look. Shows the four controls, the
  showcase band, and the access path (rail Appearance active). The "empty/default"
  state.
- **Panel 2 — A changed state (light).** Theme **Light** · **Swiss / Minimal-Flat**
  · **Cobalt** · **Grotesk**. The **dogfooding moment**: because the choice applies
  to Motir _itself_, the WHOLE page — rail, cards, chips, buttons, pills AND the
  showcase — re-skins (cool Cobalt), re-shapes (flatter, sharper Swiss geometry) and
  re-types (Space Grotesk headlines) live. `data-style` / `data-palette` /
  `data-type` sit on the `.stage` (whole shell), exactly as they sit on `<html>`
  in-app.
- **Panel 3 — Dark + a changed state.** Theme **Dark** · **Soft / Playful** ·
  **Evergreen** · **Editorial**. Dark-mode parity across the whole area; rounded
  Soft/Playful geometry, an emerald Evergreen palette, Fraunces display headlines.
  Confirms light + dark both hold AA via the token layer.

## Token / a11y rules honoured

- **Colour** is `--el-*` only (text on tints → `--el-text-strong`; active chips put
  the accent in border + `--el-tint-lavender` background with
  `--el-accent-on-surface` text, AA in both themes — finding #35). No Tier-0
  `--color-*`, no page-level tint.
- **Shape** is element-semantic tokens only (`--radius-card` / `-btn` / `-input` /
  `-badge`, `--spacing-card-padding`, `--height-control` / `-input`,
  `--shadow-subtle`) — so a `data-style` swap actually reshapes the pane (visible
  across panels). The segmented active radius is `calc(--radius-btn - 2px)`; chip
  swatch dots are `rounded-full` (genuinely circular — allowed).
- **a11y** — the rail `nav` has `aria-label`; the active row carries
  `aria-current="page"`. The theme segmented is a `role="group"`; each axis chip
  row is a `role="radiogroup"` with an `aria-label`. Every icon-only `<svg use>`
  carries `viewBox="0 0 24 24"` (no clipping). The "Soon" → active flip is a real
  navigable row, not a disabled one.
- **Dark mode** confirmed (Panel 3): rail, cards, chips, segmented, the showcase
  card / pills / buttons / type specimen and swatches all flip via the token layer
  and stay AA.

## Primitives composed (no hand-rolling)

| Element                          | Source                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| area shell (rail + content)      | `account-settings.mock.html` (7.8.2) — `Card` / settings-row / nav grammar            |
| axis chips (`.pick`)             | the onboarding design-wizard chip language (7.3.44)                                   |
| showcase card / type / swatches  | the onboarding live specimens (`.vg-*` / `.type-spec` / `.pal-swatches`, 7.3.37)      |
| status / label pills             | `components/ui/Pill.tsx` (accent + tinted tones, AA `--el-text-strong`)               |
| buttons + search input           | `components/ui/Button.tsx` · the `Input` / `Combobox` trigger grammar                 |
| Theme segmented control          | a token-driven segmented toggle (the `ThemeToggle` pattern) — the one new composition |
| option sets (style/palette/type) | the shipped registries `lib/theme/{styles,palettes,typography}.ts`                    |

The only new composition is the **Theme segmented control**; everything else reuses
the area shell, the onboarding picker chips + specimens, and the shipped `Pill` /
`Button` / `Input` primitives. The axis options come straight from the registries,
so the pane never drifts from what the app can actually wear.

## Build dependency (for 7.3.58)

7.3.58 implements this pane + its `settings/account/appearance` route: a **client
island** (the selections live in `localStorage` via `THEME_STORAGE_KEYS` and are
applied to `<html>` by the existing theme bootstrap, so picking re-skins instantly
with no server write — no separate preview to wire), rendering the four pickers from
the registries + the showcase slice, and flipping the `accountSettingsNav`
`appearance` entry from a placeholder to a real route (which keeps the
route↔registry totality test green by construction). No new colour/shape primitive
is required.

---

# Profile pane (Story 8.8 · 8.8.20 / MOTIR-1205)

Asset: **`profile.mock.html`** → **`profile.png`**. Flips the **last reserved
"Soon" slot** — `General › Profile` (`accountSettingsNav` `placeholder: true`,
icon `User`, route `/settings/account/profile`) — into a real personal-details
surface. It is the standard **Linear-style Profile + Security split** (verified
linear.app/docs/profile): the photo / name / sign-in email you present to the
team, plus the password you sign in with. Item #11 of the 8.8 launch-readiness
pass; password change/reset is the explicitly-requested setting (Yue).

## Grounded in shipped reality (NOT invented) — per-behaviour source

The pane reuses the **shipped account-settings area** verbatim (rail + identity
header + grouped nav + `Card` panes + the `.srow` settings-row grammar from the
Language pane). The behaviours it depicts are sourced as follows — and, per the
design-against-shipped-reality rule, the mock is **honest about which backend is
already wired vs. which the follow-on build subtask must add** (this card has no
linked sibling subtasks, so the "specs" it cites ARE shipped code + the named
standard, which is richer than a phantom sibling spec would be):

| Behaviour in the mock                                                                         | Source / grounding                                                                                                                                                                                                                        | Backend state today                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Password — change (credential user)**                                                       | Better-Auth `emailAndPassword` default `/api/auth/change-password` (current → new); the **8-char minimum** mirrors the shipped `/reset-password/new` rule (`lib/auth/index.ts`).                                                          | **Shipped** (endpoint mounted by Better-Auth).                                                                                                                                                           |
| **Password — "Send a reset link" (OAuth-only user)**                                          | The **fully-shipped reset flow**: `sendResetPassword` → `/reset-password` → `/reset-password/new`, 1-hour token (`lib/auth/index.ts` ll. 93–134; `lib/emailTemplates/passwordReset.tsx`).                                                 | **Shipped.** Reused as-is so a Google-only user can SET a password.                                                                                                                                      |
| **Credential vs OAuth-only branch**                                                           | The real schema distinction: `Account.provider === 'credential'` (has a password) vs `'google'` only (`accountRepository` / `userRepository where: { providerId: 'credential' }`). Google OAuth is configured (`socialProviders.google`). | **Shipped** (the data to branch on exists).                                                                                                                                                              |
| **Avatar — upload / remove**                                                                  | `lib/blob/uploader.ts` `putAttachment()` (Vercel Blob, returns `{ url }`) + `deleteAttachmentBlob()`. The `User.image` field exists.                                                                                                      | **Primitive shipped; no avatar route/UI yet** — the build subtask adds the upload route + `updateUser(image)`.                                                                                           |
| **Name — inline edit**                                                                        | `User.name` exists; standard inline-edit grammar (the page-state inline-edit contract: success response = confirmation, no tree refresh).                                                                                                 | **No `updateUser(name)` route yet** — build subtask adds it.                                                                                                                                             |
| **Email — change-with-confirmation (link to the NEW address; pending state until confirmed)** | The card's own decision (confirmation sent to the new address); mechanism mirrors Better-Auth's `changeEmail` (verify-before-apply). The pending-state + email-taken error follow the standard.                                           | **NOT wired** — the `changeEmail` plugin is **off** (`requireEmailVerification: false`, no plugin). The build subtask must enable `changeEmail` + a confirmation email template (`lib/emailTemplates/`). |

> **Planning flag (surfaced, not silently absorbed — notes.html #27/#30 shape):**
> the **email-change**, **name update**, and **avatar update** write-backends do
> NOT exist yet (only the blob-uploader primitive does). Design-before-code
> (Principle #13) lets this pane _specify_ those flows, but the **8.8.x Profile
> build subtask must include** (a) `updateUser(name, image)` route(s) through the
> 4-layer stack, (b) an avatar-upload route over `putAttachment`, and (c)
> Better-Auth `changeEmail` + a new confirmation-email template. The
> change-password and reset-link branches need **no** new backend. The planner
> should ensure the build subtask's scope (and `dependsOn`) reflects this — it is
> not a one-file UI bolt-on.

## Layout — two Cards inside the shipped area shell

`page-head` (serif `h2` "Profile" + muted `.sub`), then a `.stack` (max-width
680px) of two `Card`s, each `card-head` (title + `hsub`) over a `card-body` of
`.srow` rows (label/desc left via `.sl .name`/`.desc`, control right via `.sc`,
hairline `--el-border-soft` between rows, none on the last):

**Card 1 — "Profile"** (General):

- **Photo** row — `Avatar` (circular; **initials fallback** `--el-text` fill /
  `--el-text-inverted` text when no image, OR the uploaded image) + **Change**
  (`Button` secondary sm, `camera` glyph) + **Remove** (`Button` danger-ghost sm,
  `trash` glyph — only when an image is set; revert-to-initials, per Linear).
- **Name** row — value + **Edit** (ghost sm, `pencil`). Edit mode: an `Input`
  (`--height-input`, focus ring `--el-accent`) + **Save** (primary sm) / **Cancel**
  (ghost sm); empty → `.err-text` "Name can't be empty." + `--el-danger` border.
- **Email** row — value + **Change email** (ghost sm, `mail`). Pending state:
  old email struck (`--el-text-muted`, line-through) + a **`Pill`** (`pill-warn`,
  peach tint + `--el-text-strong`, `clock` glyph) "Pending → newaddr" + helper
  "Confirmation sent. Applies once confirmed." + **Resend** / **Cancel** links.

**Card 2 — "Password & security"** (Security):

- **Password** row, by account type:
  - **Credential** → "Last changed …" desc + **Change password** (`Button`
    secondary sm, `lock`).
  - **OAuth-only** → a **`callout`** (sky tint, `--el-info`) "You sign in with
    **Google**. Send yourself a reset link to set a password…" + **Send a
    password-reset link** (secondary sm, `mail`).

## States drawn (panels)

1. **Resting** (credential, light) — the access path: rail **General › Profile
   ACTIVE** (canvas-inset active treatment, accent icon); all rows at rest,
   avatar = initials.
2. **Editing / pending / errors** — avatar uploaded (Change + Remove); Name in
   edit mode with the empty-name validation error; Email pending-confirmation.
3. **Change-password modal** (`Modal`, Radix Dialog grammar) — Current / New
   (`helper` "At least 8 characters") / Confirm, each `Input` with an `eye`
   show/hide; footer **Cancel** + **Update** showing the **saving spinner**; a
   success **`Toast`** ("Password updated").
4. **Change-email modal** with the **email-taken** error box (`--el-tint-rose` +
   `--el-danger`); the **OAuth-only** Password card variant; the **loading
   skeleton** (shimmer `.sk` rows + circular avatar placeholder).
5. **Dark parity** — the resting pane on `data-theme="dark"`.

## Token discipline

Colour only via `--el-*` (text `--el-text`/`-secondary`/`-muted`/`-faint`/
`-strong`/`-inverted`; accent `--el-accent`/`-text`/`-on-surface`; status
`--el-danger`/`-text`, `--el-success`, `--el-warning`, `--el-info`; tints
`--el-tint-{peach,rose,sky,mint}`; surfaces `--el-page-bg`/`-surface`/`-muted`;
borders `--el-border`/`-soft`/`-strong`; links `--el-link`). Shape only via
element-semantic tokens (`--radius-card`/`-input`/`-modal`/`-btn`/`-badge`/
`-control`; `--spacing-card-padding`/`-input-x`/`-btn-x`/`-chip-*`; `--height-
input`/`-btn-sm`/`-btn-md`; `--shadow-subtle`/`-modal`/`-elevated`). No Tier-0
`--color-*`, no raw `rounded-*`/`p-*`/`h-*` (avatar/spinner circles use
`border-radius: 9999px`, the sanctioned exception for genuinely circular things).

## Build dependency (for the 8.8.x Profile build subtask)

Implements this pane + the `settings/account/profile` route, flipping the
`accountSettingsNav` `profile` entry from `placeholder: true` to a real route
(keeps the route↔registry totality test green by construction, exactly as 7.8.3
did for API tokens and 7.3.58 for Appearance). Backend to add, per the table
above: `updateUser(name, image)` + avatar-upload route (over `putAttachment`) +
Better-Auth `changeEmail` enablement + a confirmation-email template; the
password change/reset paths reuse shipped Better-Auth. The name/email inline
edits follow the **inline-edit no-tree-refresh** page-state contract (success
response = confirmation), and the rail identity header (`.me`) re-reads the
updated name/avatar on a server refresh.

---

# Settings at ARRIVAL — the family frame (MOTIR-3441)

**Asset ·** `arrival.mock.html` / `arrival.png`. **Story ·**
[MOTIR-3440](motir:cmt8s085i003li1ph06u469kx) — the 24 heavy authed surfaces stop blocking on their
slowest read. **Grammar ·** `design/shell/design-notes.md` § _The navigation-pending grammar_, second
revision. This section applies that grammar to the settings family; it re-specifies none of it.

Settings is **31 of the 58** `app/(authed)` routes and **14 of the 26** heavy ones — over half the
story's population — and they share one body shape. That sameness is what makes a family answer right
here where the rest of the story needs a decision per surface.

## The frame is the PANE. The rail is not in it, and that is a fact rather than a preference

The card asked which of two readings the frame takes — _the whole surface_ or _the pane only_ — and
said the answer changes what the code card builds. **It is the pane only, and the reason is
structural: the rail is not the page's to draw.**

- `SidebarNav variant="rail"` is mounted in **`app/(authed)/layout.tsx`**, in `AppLayout`'s
  `sidebar` slot. It is a sibling of `{children}`, not a descendant, at every route in the app.
- The family has exactly **two** layouts — `settings/project/layout.tsx` and
  `settings/account/layout.tsx` (`git ls-tree -r origin/main --name-only | grep -E
'^app/\(authed\)/settings/.*layout\.tsx$'`) — and **neither renders a rail**. Both are guard-only:
  the project one returns the no-project / no-access states, the account one re-checks the session.
  Their own comments say where the nav lives: _"the grouped settings NAV itself lives in the app rail
  — SidebarNav swaps to it when the route is inside this area … the App Router keeps the rail in the
  parent (authed) layout, not a nested one under `<main>`."_
- The swap is a **client** read of `usePathname()`, so on a soft navigation the rail exchanges its
  item set in the same frame as the click; on a hard navigation it is server-rendered with the shell.

So the rail is never pending, at any width, from any entry point. A frame that drew it as ghost blocks
would put a skeleton over a rail that is already on screen and already correct — which is the flicker
the reveal delay exists to remove, arriving from the other direction. **The family shape survives as
_rail (untouched) + pane frame_.** Panel A draws both states with the rail held identical, because the
absence of a change is the thing to see.

**What this implies for the two navigations the card names:**

| navigation                                            | the rail                                                                                        | the pane                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **settings → settings** (Details → Automation)        | unchanged — same item set, the active mark moves                                                | the only region that exchanges: the frame, then the content |
| **into settings from outside** (Work Items → Details) | the item set swaps, instantly on a soft navigation (client) and with the document on a hard one | the frame, then the content                                 |
| **out of settings**                                   | swaps back the same way                                                                         | the destination's own frame, which is not this family's     |

## Which routes the frame is correct for — read from the layouts, not assumed

The card required this be read rather than assumed, and reading it changes one answer.

| group                      | routes | rail                                                                                                             | frame    |
| -------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- | -------- |
| `settings/project/**`      | 17     | the **project-settings rail** — `SidebarNav` swaps to `lib/settings/projectSettingsNav`, filtered per permission | this one |
| `settings/account/**`      | 6      | the **account-settings rail** — the same swap over `lib/settings/accountSettingsNav`                             | this one |
| `settings/workspace/**`    | 4      | **no settings rail.** The ordinary project rail, with Jobs and Git as bottom-nav rows                            | this one |
| `settings/organization/**` | 4      | **no settings rail.** The ordinary project rail                                                                  | this one |

**So the answer to _"do workspace and organization settings carry a rail?"_ is NO** — eight of the 31
routes render inside the app's ordinary rail, and only the 23 under `project/` and `account/` get a
swapped one. **It does not change the frame**, because the frame never contained the rail in the first
place; what it changes is the claim that may be made about the frame. The frame is correct for a pane
with an ordinary rail beside it exactly as for one with a settings rail beside it, and it is correct
because it draws neither.

## What the frame draws — and the one place it departs from the generic one

```
mx-auto flex max-w-[Wrem] flex-col gap-6      the pane wrapper — the page's own, W from the route
  header  flex flex-col gap-1                 THE REAL HEADER: <h1> + <p>. Not a placeholder.
  <Suspense fallback=…>                       the boundary, BELOW the gate
    animate-pulse                             one pulse for the region, so the blocks are in phase
      rounded-(--radius-card) border          the card stand-in: label bar + action bar + 3 rows
```

**The header is real, and that is the family's substantive difference from `PageSkeleton`'s generic
body.** Rule 2 of _WHICH SURFACES EARN A FRAME_ says a frame only ever covers a region that has
nothing to show yet. A settings pane's title is `t('<pane>.title')` and its subtitle interpolates the
project or organization name — **both already resolved by the gate**, because `getActiveProject()` is
what the guard runs on. A generic page draws a title block because a generic page's title is not
knowable before its read; here it is knowable before the read is even issued, so drawing a grey bar
over it would be a frame covering a region that has something to show.

**This is a requirement on `PageSkeleton`, and it is stated here because that primitive does not exist
yet** (`design/shell/design-notes.md` § _What this asset SPECIFIES that no card owns_, item 1):
`PageSkeleton` must let a caller supply a real header, or omit the header block, rather than always
drawing one. The settings frame composes its **wrapper and its reveal**; it does not take its header
block.

**The card stand-in is not a new drawing.** It is the composition that shipped as the Fields pane's
own route-level skeleton until MOTIR-3558 deleted it, and it now lives in
`components/settings/SettingsPaneFrame.tsx` — a `rounded-(--radius-card)` bordered box at `p-(--spacing-card-padding)`, a
`mb-4 flex items-center justify-between` row carrying an `h-4` label bar and an `h-7` action bar, then
three `flex items-center gap-3` rows of an `size-8` square and an `h-3.5` bar at 40 / 48 / 56% —
**with its two header placeholders removed**. Three rows is a screenful for a 42–46rem pane and is not
a count of anything.

## The WIDTH axis — the one thing the shell's no-shift claim does not reach

`design/shell/design-notes.md` § _THE NO-SHIFT CLAIM_ is _heights and gaps, never widths_, and its
reason is stated: _"the frame and the arriving page both fill `<main>`'s width."_ **On this family that
premise is false.** Every settings pane is a CENTRED column — `mx-auto max-w-[Wrem]` — so a frame whose
W differs from its page's moves the content horizontally on settle. Measured over all 31 routes, the
family uses **eight distinct W**:

| W       | routes                                                                                                                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `34rem` | `account/appearance`                                                                                                                                                                                                                                                                                               |
| `42rem` | `project` · `project/fields` · `project/components` · `project/estimation` · `project/members` · `project/code-access` · `project/roles` · `project/roles/new` · `project/ai-planning` · `project/ai-planning/lessons/[lessonId]` · `account/language` · `account/notifications` · `account/profile` · `workspace` |
| `45rem` | `organization`                                                                                                                                                                                                                                                                                                     |
| `46rem` | `project/automation` · `project/repositories` · `workspace/github` · `workspace/gitlab` (the last two via `GitSettingsShell`)                                                                                                                                                                                      |
| `48rem` | `project/workflow` · `organization/billing` · `organization/members` · `organization/usage`                                                                                                                                                                                                                        |
| `52rem` | `project/board` · `project/ai-planning/lessons`                                                                                                                                                                                                                                                                    |
| `60rem` | `workspace/jobs`                                                                                                                                                                                                                                                                                                   |
| `64rem` | `account/tokens`                                                                                                                                                                                                                                                                                                   |

**So W is a prop and each route passes its own** — the same literal its own wrapper carries, so the two
cannot disagree. A frame fixed at 42rem in front of the 60rem Job-runs pane settles by **144px on each
side**. Panel C draws 42 / 48 / 60 in the same stage so the movement is visible rather than argued.

**Two routes have no `max-w` of their own** and take it from a shell they render:
`workspace/github` and `workspace/gitlab` are `GitSettingsShell`'s `46rem`. `account` and
`project/roles/[roleKey]` are covered below.

## The allocation — all 14 heavy panes, with the honest rows written

Three tiers, per `design/work-items/design-notes.md` § _The item page at ARRIVAL_'s method: **with the
frame** = painted from the gate, above the boundary · **with the first content** = behind the
boundary · **after the page** = a second, later boundary. The gate is the reads that decide whether
this reader may see this page — nothing may be flushed until it has run.

Every project-settings pane shares the same gate prefix: `getSession` → `getTranslations` →
`getActiveProject` → `guardSettingsPage('<entry>')`.

| #   | route                                             | awaits | with the frame                                                         | with the first content                                                                  | after the page                              | what actually changes                                                                                                                                     |
| --- | ------------------------------------------------- | ------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `settings/project`                                | 6      | header                                                                 | `Promise.all([getDetails, getManageCapabilities])`, then `getFormatter`                 | —                                           | **the frame only.** The two reads are already one wave                                                                                                    |
| 2   | `settings/project/board`                          | 8      | `<h1>` + subtitle (see the breadcrumb note below)                      | `getBoard` ∥ `listStatusesByProject`                                                    | —                                           | **serial → concurrent.** The two are independent; `statusByKey` merely joins them                                                                         |
| 3   | `settings/project/workflow`                       | 6      | header                                                                 | `getWorkflow` ∥ `getStatusAutomation`                                                   | —                                           | **serial → concurrent.** Independent; two editors, one each                                                                                               |
| 4   | `settings/project/automation`                     | 6      | header                                                                 | `automationRulesService.list`, then the six-way `Promise.all`                           | —                                           | **the frame only.** The second wave needs the label ids the first returns, so it genuinely stays two waves                                                |
| 5   | `settings/project/repositories`                   | 6      | `<h1>` only                                                            | `getRoomView` → the lead line, the summary line, the CI-paused banner and the rows      | —                                           | **the frame only.** One read; nothing to make concurrent. **The lead line is tier 2**, because which of two strings it uses depends on `view.rows.length` |
| 6   | `settings/project/ai-planning`                    | 6      | header                                                                 | the five-way `Promise.all` (capabilities, settings, pause, formatter, `canViewLessons`) | `listLessons` — the lesson-library preview  | **a second boundary.** The preview is the one settings region that is genuinely late: it cannot start until `canViewLessons` returns                      |
| 7   | `settings/project/ai-planning/lessons`            | 6      | back-link + header                                                     | the three-way `Promise.all` (page, formatter, `mayManage`)                              | —                                           | **the frame only.** Already one wave                                                                                                                      |
| 8   | `settings/project/ai-planning/lessons/[lessonId]` | 7      | back-link + header                                                     | — **nothing**                                                                           | —                                           | **NOTHING STREAMS.** `getLesson` decides the `notFound()`, so it is a gate read — and once it returns the body has everything                             |
| 9   | `settings/project/roles/[roleKey]`                | 6      | — **nothing**                                                          | — **nothing**                                                                           | —                                           | **NOTHING STREAMS.** `getRoleCatalog` decides the 404 AND supplies `RoleDetail`'s own `<h1>`                                                              |
| 10  | `settings/project/roles/[roleKey]/edit`           | 6      | — **nothing**                                                          | — **nothing**                                                                           | —                                           | **NOTHING STREAMS.** The same catalog read, the same 404, `RoleEditor`'s header inside it                                                                 |
| 11  | `settings/workspace/jobs`                         | 9      | header                                                                 | `getMemberRole` → the tab strip, then `countDLQ` ∥ the selected tab's list              | —                                           | **serial → concurrent** on the second wave. The role selects which list is fetched, so it precedes them                                                   |
| 12  | `settings/workspace/gitlab`                       | 7      | the whole `GitSettingsShell` header — title, subtitle, provider switch | `getConnectionForWorkspace` → the connected / not-connected panel                       | —                                           | **the frame only.** One read, and the shell above it is pure `t('git')`                                                                                   |
| 13  | `settings/organization`                           | 7      | header                                                                 | `listUserWorkspaces` ∥ `listMembers` ∥ `getAiAccess`                                    | —                                           | **three serial → one wave.** The largest single win in the family                                                                                         |
| 14  | `settings/organization/billing`                   | 6      | the `sr-only` title                                                    | `listMembers` → `BillingClient`                                                         | `BillingClient`'s own screens (client-side) | **the frame only**, and a small one: the client island already owns its per-screen states                                                                 |

**Three of the fourteen have no allocation at all, and writing that down is the point.** Rows 8–10 are
`notFound()` deciders whose deciding read IS the read that fills the page. There is nothing left to put
behind a boundary, and a `<Suspense>` added there would wrap a value already in hand — the padding the
card said must not happen. Row 9 and row 10 do not even paint a header, because `RoleDetail` and
`RoleEditor` own theirs and both need `role`.

**Row 2's breadcrumb is the family's one no-shift hazard.** `BoardSettingsHeader` renders a
`text-xs` breadcrumb line above the `<h1>` **only when `boardName` is present**, and `boardName` comes
from the tier-2 `getBoard`. So the header grows by one line plus its `gap-2` when the content arrives.
**The frame reserves that line** — an `h-4` block in the same position — so the title does not jump.
This is the only settings pane where a tier-1 region changes height on settle.

**And row 6 is the only second boundary in the family.** Everywhere else the third tier is empty, which
is the expected shape for a pane that is one card of fields over two reads.

## The two shipped settings skeletons — SUPERSEDED

The Fields and Components panes each carried a route-level `loading.tsx` — the only two in the family.
They are drawn in Panel D as they rendered.

**Verdict: both are deleted, in the same commit that lands the shared component in those two routes.**

> ✅ **DONE — MOTIR-3558 (`2a27a1a2`).** Both files are gone and both panes mount
> `components/settings/SettingsPaneFrame.tsx` in-page instead, in that one commit. Their paths are
> deliberately no longer written out above: a design asset names the file an agent should MIRROR, and
> a path that resolves to nothing sends them looking for it — which is what
> `tests/design-asset-addresses.test.ts` caught on the story's own pull request.

- **Not because a boundary is illegal there.** Neither page calls `notFound()`, so both are legal
  under `motir-core/CLAUDE.md` § _A `loading.tsx` may NOT sit above a route that decides existence_.
- **Because they are the same drawing twice, from a second source, and have already drifted:** the
  title bar is `w-32` in one and `w-40` in the other; the action bar `w-24` and `w-28`. Neither number
  stands for anything — the real titles are _Fields_ and _Components_, which the family frame paints
  instead of approximating. Two hand-rolled copies of one drawing is precisely the drift rule 4 of
  _WHICH SURFACES EARN A FRAME_ names, and `IssueTreeSkeleton` is what it looks like after eighty days.
- **Because a route boundary that survives beside an in-page frame shows the same pending state
  twice for one navigation** — the route fallback while the page function runs, then the page's own
  fallback while its body resolves.

**Nothing else under `app/` is touched.** `app/(planning)/loading.tsx` and
`app/(public)/explore/(square)/loading.tsx` are outside this family and outside this story.

## Token / a11y rules honoured

- Every fill is `--el-muted`; every edge `--el-border`; the arrived card `--el-card` /
  `--shadow-(--shadow-card)`. **No Tier-0 `--color-*`, no invented hue.**
- Every radius is `--radius-card` / `--radius-control` / `--radius-btn`; padding is
  `--spacing-card-padding`; the action bar is `h-7`, matching the shipped skeletons. No raw
  `rounded-md` / `p-2`.
- Header ink is `--el-text`; subtitle `--el-text-muted` **on the page surface only**, where it is
  4.54:1 — the pane's wrapper paints no surface of its own, so the caveat in
  `motir-core/CLAUDE.md`'s contrast table does not bite. The board's own annotation ink is
  `--el-text-secondary`.
- `aria-busy="true"` on the frame region; the blocks are decorative and carry no text. The region is
  announced once, not per block.
- The reveal is `design/shell/`'s `nav-pending-reveal` keyframe at 120ms, **referenced, never
  re-declared** — one declaration governs the shell's mark and every page's frame.
- Dark is the same tokens re-emitted (Panel F). The mock's dark panel carries
  `data-appearance-scope` beside `data-theme="dark"` and declares `color` on the container, so the
  Tier-3 layer resolves on the subtree.

## Primitives composed (no hand-rolling)

| element              | primitive / token                                                                 | note                                                                  |
| -------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| the pane wrapper     | `mx-auto flex max-w-[Wrem] flex-col gap-6`                                        | the page's own wrapper, with W passed in — not a copy                 |
| the header           | the page's real `<h1>` + `<p>`                                                    | painted from the gate; the frame does not draw it                     |
| the wrapper + reveal | `PageSkeleton` (MOTIR-3433's, reverted — see the GIVES/TAKES below)               | composed, with the header block omitted                               |
| the card stand-in    | `rounded-(--radius-card)` · `border-(--el-border)` · `p-(--spacing-card-padding)` | `settings/project/fields/loading.tsx`'s composition, minus its header |
| the pulse            | `animate-pulse` on the region                                                     | one animation, so the blocks are in phase                             |
| the rail             | `SidebarNav variant="rail"` — **unchanged, and outside the frame**                | rendered in the asset from the real component, not redrawn            |

## The design-allocation sweep — what this asset GIVES and TAKES

| card                                                                                | GIVES / TAKES | what                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[MOTIR-3443](motir:cmt8s08bg003oi1phhs0qf51a)** — settings opens on its own frame | **GIVES**     | the frame's composition, the pane-only decision with its evidence, the W-is-a-prop rule and the eight-width table, rows 1–10 of the allocation, the breadcrumb reservation, and the delete-both-`loading.tsx` verdict                                                                                         |
| **[MOTIR-3448](motir:cmt8s08ik003ti1phu26fxgo9)** — workspace + organization panes  | **GIVES**     | rows 11–14, and the finding that these eight routes carry **no** settings rail — so the card must not reach for one                                                                                                                                                                                           |
| **[MOTIR-3442](motir:cmt8s088r003ni1phat3x1o9q)** — the remaining ten surfaces      | **GIVES**     | nothing to build, and one thing to know: the CENTRED-column caveat on the no-shift claim generalises to any surface that is `mx-auto max-w-[…]` rather than full-width                                                                                                                                        |
| **[MOTIR-3449](motir:cmt8s08js003ui1ph9dawc83l)** — the vitest gate                 | **GIVES**     | three assertions this asset makes checkable: no `loading.tsx` exists under `app/(authed)/settings/`, the frame's W equals its page's, and the two deleted files stay deleted                                                                                                                                  |
| **MOTIR-3433's `PageSkeleton`**                                                     | **TAKES**     | a requirement it does not yet have: the header block must be **omittable**, because this family paints a real header above the boundary. `PageSkeleton` was reverted with MOTIR-3433 and no card owns rebuilding it — named in `design/shell/design-notes.md` § _What this asset SPECIFIES that no card owns_ |
| **`design/shell/design-notes.md`** § _THE NO-SHIFT CLAIM_                           | **TAKES**     | its scope, not its content: _heights and gaps, never widths_ holds for a full-width `<main>` and not for a centred column. Stated here rather than edited there, because the shell asset's own subject is full-width                                                                                          |

## How the render was produced

Generated, not hand-drawn, so the asset cannot drift from the app:

1. **The rail is the real `SidebarNav variant="rail"`** in its project-settings state, dumped through
   the repository's own vitest + React-Testing-Library setup with the real `messages/en.json` and the
   admin permission set — the same technique `design/shell/navigation-pending.mock.html` § _How the
   render was produced_ describes. It is the settings rail the app renders, including its active mark.
2. **The two shipped settings skeletons are the real components**, rendered the same way — Panel D is
   their output, not a redraw of it.
3. **Every string is the real `en` catalog's** — `settings.automation.*`, `settings.details.*`,
   `settings.workflow.*`, `settings.jobs.*`.
4. **The stylesheet is Tailwind's own output** over this markup, with
   `@motir/design-system/theme.css`, so the token layers are the build's rather than a retyped block.
5. The `.png` is exported with `node scripts/render-design-mock.mjs`.

Two board artefacts, named so they are not read as design: the shell stage is held at a fixed
**820px** (the app's shell is `h-dvh`), and the frames showing a revealed state force the reveal
animation's end state, because a board is a still.
