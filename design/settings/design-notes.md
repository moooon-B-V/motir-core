# Settings — design notes

Design reference for the `settings` UI area. The headline surface is the
**account settings AREA** — the per-user settings surface, redesigned (Story 7.8
· 7.8.2) from a flat 2-card page into a grouped-nav **area** that scales as it
grows. Built FROM the real design system (`app/globals.css` `--el-*` / shape
tokens + the shipped `components/ui/*` primitives), so the code subtasks compose
the same primitives — no Pencil→code gap.

| Surface                   | Asset                                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Account settings area** | **`account-settings.mock.html`** (HTML mock) | The account-settings area: the rail grouped nav + the **real** panes (Language · Notifications · Security/API tokens) + the API-token create / shown-once / revoke / empty / toast flows. Multi-panel. **Gates 7.8.3** (API tokens).                                                                                                                                                                                                                                                                                                                                    |
| **Token scope selection** | **`token-scopes.mock.html`** (HTML mock)     | EXTENDS the API-tokens surface: the create-modal **permission-scope picker** (grouped Switch toggles, default all-on except delete) + the token-LIST **granted-scope display** (summary Pill + "Can delete" chip + expandable detail). Multi-panel. **Gates 7.7.19** (token scopes).                                                                                                                                                                                                                                                                                    |
| **Appearance pane**       | **`appearance.mock.html`** (HTML mock)       | Motir dogfoods its own 3-axis design system: theme the Motir app itself — **Theme × Style × Palette × Type**. **Setting \| example two-column** (8.8.14 / MOTIR-1196): axis controls LEFT, the live example RIGHT — the example mirrors the **shipped `StyleVignette`** and re-skins instantly; collapses to a single stacked column below a tablet width. Reuses the area shell + onboarding picker language; flips the rail's "Soon" Appearance slot to active. Multi-panel (default · changed · dark · collapsed). **Gates 7.3.58 / MOTIR-1198** (the pane + route). |

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
(`--el-text-faint` uppercase) with a `--el-border` rule; rows hairline-separated.
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
  right-aligned). `thead` is the `--el-text-faint` uppercase caption with a
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
  `--el-text-faint`) head each group.
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

## Layout — setting | example, two-column (8.8.14 / MOTIR-1196)

**Reversed decision (Yue, 2026-06-20; supersedes the 7.3.57 "page IS the preview"
call below).** The pane now pairs the **setting and the example side by side — the
axis controls on the LEFT, the live example on the RIGHT** — replacing the earlier
stacked arrangement (controls, then a full-width showcase band below). The original
7.3.57 rationale was that the page itself re-skins live, so a separate preview was
redundant ("the page IS the preview — there is NO separate live-preview widget").
This subtask **reverses that toward an explicit setting↔example pairing** per the
user's dogfooding directive: pairing the control with a focused example beside it
makes the cause→effect of each pick legible without scanning the whole page, and
reads as the familiar "settings on the left, preview on the right" pattern. The
instant-apply model is unchanged — picking still re-skins the whole app live
(`localStorage` → `<html>`, the inline-edit-no-refresh contract); there is still
nothing to save. (We design to the new directive and do not re-argue the old one.)

**The two-column grid** (`.appearance-grid`, `grid-template-columns: minmax(0, 1fr)
minmax(330px, 380px)`, 24px gap, `align-items: start`) sits under the page-head:

- **Left = the SETTING** — the existing controls `Card` ("Theme & design"), the four
  `.axis-field`s, unchanged in content.
- **Right = the EXAMPLE** — the live specimen (`.showcase`, in LIVE mode: no pinned
  `data-*` axis, so it inherits the active `<html>` selection and re-skins on every
  pick). In the narrower right column the showcase's own internal `.sc-grid` stacks
  to a single column (`.example .sc-grid { grid-template-columns: minmax(0, 1fr) }`)
  so the work-item card and the side stack (search / swatches / type specimen) sit
  vertically — nothing is crushed.
- **Sticky example** — the right column is `position: sticky; top: 20px`
  (`.example`), so the example stays in view while the longer controls column
  scrolls.
- **Responsive collapse** — below a tablet width (`@media (max-width: 900px)`, and
  the `.is-stacked` modifier the mock uses to show it statically) the grid folds to
  one column: the example becomes `position: static` and drops **below** the
  controls, reclaiming the roomy `minmax(0, 1fr) 248px` internal grid (the example
  is never squeezed into an unreadable sliver). **Panel 4** demonstrates this state.
- **Widened container** — the in-app page container goes from the single-column
  `max-w-[42rem]` to a wider two-column container (≈ `max-w-[64rem]`) so both columns
  read with clean gutters; in the mock the two-column grid fills the content width.

For the implementation (MOTIR-1198) the right column reuses the shipped
`<StyleVignette />` in LIVE mode (no axis props) — and the mock's example mirrors
that exact shipped component (see "The example" below), not a stand-in.

**The controls** (one `Card`, "Theme & design"), four hairline-separated
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

The card sub-copy + the page-head ("set the axes on the left; the live example on
the right re-skins the instant you choose… there's nothing to save") state the
instant-apply, no-Save model.

**The example** (the right column, eyebrow "Your look — live across Motir") **is the
SHIPPED `StyleVignette`, mirrored 1:1 — not a bespoke showcase.** This is the
MOTIR-1196 correction: the pane renders `<StyleVignette />` (LIVE mode) as its
preview, so the mock's example reproduces that component's **exact** shipped
structure (`components/theme/StyleVignette.tsx`, 7.3.37 / MOTIR-1050), translated
from its Tailwind into the same `--el-*` / shape tokens — so the asset shows the
**real** preview the user will see, never a prettier stand-in that drifts from the
implementation. The earlier asset redrew a different `.sc-item` + side-stack
composition; that was the "designed-from-source, never-rendered" miss
(`notes.html` #73). The mirrored vignette is a composed mini-surface that exercises
every axis:

- a **nav rail** (`data-surface="sidebar"`) — accent dot, serif "Acme", an accent
  "Board" chip, muted "Backlog" / "Reports", an avatar;
- a **work-item card** (`Card`, `data-surface="card"`) — a `square-check` story-hue
  icon (`--el-type-story`), a **serif title** ("Ship the billing flow"), an **accent
  status `Pill`** ("In progress"), three status rows (success / warning / info dots +
  labels + chips), and two progress bars (one accent);
- a **floating modal** (`data-surface="modal"`, `--radius-modal` + `--shadow-modal` +
  a scrim) — "New invoice", two bars, a **primary `Button`** ("Create") + ghost
  ("Cancel");
- a **search input** (`data-surface="input"`) and a **button row** — primary "New
  work item" + ghost "Filter" (sliders icon).

So colour shows in the accent dot / Board chip / pill / bar + the status-dot hues;
shape shows in the nav / card / modal / input / button radii + elevation; type shows
in the serif titles and the row/meta faces — all token-driven, all re-rendering on
every pick. Every surface carries its `data-surface` tag, so material styles
(glassmorphism / cybercore) frost it exactly as in the running app. In the narrow
right column the vignette's internal `card | modal` grid stacks to one column; when
the layout collapses (Panel 4) it reclaims the side-by-side `1.4fr 1fr`.

## The access path (mistake-#31 — DRAW the door)

Every panel draws the **account-settings rail** with **Appearance ACTIVE** under
**Preferences** (between Notifications and Security) — the "Soon" placeholder
flipped to the canvas-inset active treatment (`--el-sidebar-item-bg-active` +
`--el-sidebar-border` + `--shadow-subtle` + accent `palette` glyph). That IS the
entry affordance: how the user reaches the pane (Account settings → Preferences →
Appearance), drawn, not just named.

## Panels

- **Panel 1 — Default / factory (two-column).** Theme **System** · Style **Warm
  Editorial** · Palette **Motir** · Type **Motir** — the base look. Shows the
  setting | example two-column layout (controls LEFT, live example RIGHT, the example
  sticky) and the access path (rail Appearance active). The "empty/default" state.
- **Panel 2 — A changed state (light, two-column).** Theme **Light** · **Swiss /
  Minimal-Flat** · **Cobalt** · **Grotesk**. The **dogfooding moment**: because the
  choice applies to Motir _itself_, the WHOLE page — rail, cards, chips, buttons,
  pills AND the example — re-skins (cool Cobalt), re-shapes (flatter, sharper Swiss
  geometry) and re-types (Space Grotesk headlines) live. `data-style` /
  `data-palette` / `data-type` sit on the `.stage` (whole shell), exactly as they
  sit on `<html>` in-app.
- **Panel 3 — Dark + a changed state (two-column).** Theme **Dark** · **Soft /
  Playful** · **Evergreen** · **Editorial**. Dark-mode parity across the whole area;
  rounded Soft/Playful geometry, an emerald Evergreen palette, Fraunces display
  headlines. Confirms light + dark both hold AA via the token layer.
- **Panel 4 — Responsive collapse (single column).** The default look at a tablet /
  narrow-window content width (`.panel.narrow` + `.appearance-grid.is-stacked`): the
  grid folds to one column, the controls first and the **live example below** them,
  reclaiming the roomy internal grid. Demonstrates the breakpoint behaviour the
  `@media (max-width: 900px)` rule drives in the running app.

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
- **Layout vs. shape** — the two-column `.appearance-grid` (track sizing, the 24px
  gap), the `.example` sticky offset (`top: 20px`), and the responsive breakpoint are
  **layout-only** spacing/positioning between siblings, which the shape rule
  explicitly allows to stay raw (only a surface's OWN box radius/padding/height is
  shape, and those still route through the element-semantic tokens above). The grid
  changes where the controls and example sit; it does not introduce a Tier-0 token.
- **Dark mode** confirmed (Panel 3): rail, cards, chips, segmented, the showcase
  card / pills / buttons / type specimen and swatches all flip via the token layer
  and stay AA.

## Primitives composed (no hand-rolling)

| Element                          | Source                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| area shell (rail + content)      | `account-settings.mock.html` (7.8.2) — `Card` / settings-row / nav grammar               |
| axis chips (`.pick`)             | the onboarding design-wizard chip language (7.3.44)                                      |
| live example (right column)      | the **shipped** `components/theme/StyleVignette.tsx` (7.3.37 / MOTIR-1050), mirrored 1:1 |
| status / label pills             | `components/ui/Pill.tsx` (accent + tinted tones, AA `--el-text-strong`)                  |
| buttons + search input           | `components/ui/Button.tsx` · the `Input` / `Combobox` trigger grammar                    |
| Theme segmented control          | a token-driven segmented toggle (the `ThemeToggle` pattern) — the one new composition    |
| option sets (style/palette/type) | the shipped registries `lib/theme/{styles,palettes,typography}.ts`                       |

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

**Update (8.8.14 / MOTIR-1196) — two-column layout, implemented by MOTIR-1198.** The
setting | example two-column layout above (controls left, sticky live example right,
responsive single-column collapse below the tablet breakpoint, widened page
container) is a **layout-only** change to the shipped `AppearanceCard` /
`appearance/page.tsx`: wrap the controls `Card` + the `<StyleVignette />` (kept in
LIVE mode) in the two-column grid, make the example column sticky, collapse it at the
breakpoint, and widen the page container from `max-w-[42rem]`. No axis content, no
registry, and no colour/shape token changes — `StyleVignette` and the four pickers
are reused as-is.
