# Settings — design notes

Design reference for the `settings` UI area. The headline surface is the
**account settings AREA** — the per-user settings surface, redesigned (Story 7.8
· 7.8.2) from a flat 2-card page into a grouped-nav **area** that scales as it
grows. Built FROM the real design system (`app/globals.css` `--el-*` / shape
tokens + the shipped `components/ui/*` primitives), so the code subtasks compose
the same primitives — no Pencil→code gap.

| Surface                   | Asset                                        | Notes                                                                                                                                                                                                                                                                                |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Account settings area** | **`account-settings.mock.html`** (HTML mock) | The account-settings area: the rail grouped nav + the **real** panes (Language · Notifications · Security/API tokens) + the API-token create / shown-once / revoke / empty / toast flows. Multi-panel. **Gates 7.8.3** (API tokens).                                                 |
| **Token scope selection** | **`token-scopes.mock.html`** (HTML mock)     | EXTENDS the API-tokens surface: the create-modal **permission-scope picker** (grouped Switch toggles, default all-on except delete) + the token-LIST **granted-scope display** (summary Pill + "Can delete" chip + expandable detail). Multi-panel. **Gates 7.7.19** (token scopes). |

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

### ⚠️ Scope guard — Appearance is NOT designed here (Yue, 2026-06-14)

Appearance (theme / accent / font / display style) appears in the nav **only as a
reserved "Soon" slot**. It is deliberately **not** mocked as a concrete control
set: **"we are not going to implement it like this — it's misleading."** A design
that draws specific theme/accent/font/display-style controls we won't actually
build would mislead the implementer. Appearance gets its **own future story**
that designs it properly when we decide how it works. The "Soon" row keeps the
area's shape honest without over-committing. (Theme + display-style do exist today
as the shell `ThemeToggle` / `THEME_STORAGE_KEYS`, but where/how they surface in
settings is that future story's call, not this asset's.)

So the **designed** surfaces here are exactly: the **area shell**, the **Language**
pane, the **Notifications** pane, and the **Security/API tokens** pane + flows.

### ⚠️ Planning flags (surfaced, not silently absorbed)

1. **The account-settings AREA shell** — the `accountSettingsNav` registry, the
   rail-swap wiring, the `settings/account` layout, the route split (Language /
   Notifications / API tokens pages), the totality test. It is a prerequisite
   bigger than 7.8.3's original "API tokens settings UI" scope. **Recommend a new
   shell subtask under Story 7.8, with 7.8.3 `dependsOn` it** (or re-scope 7.8.3
   to "API tokens page _inside_ the new account area").
2. **Appearance** — a future personalization **story** owns it (design + build).
   Not part of 7.8; reserved as a "Soon" nav slot here.

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

| Scope key (7.7.16)   | Group           | Label (plain)        | Description                                                                  | Default | lucide icon  |
| -------------------- | --------------- | -------------------- | ---------------------------------------------------------------------------- | ------- | ------------ |
| `read`               | Read            | Read everything      | View work items, boards, sprints, comments, and reports.                     | **on**  | `eye`        |
| `work_items:write`   | Create & change | Edit work items      | Create and update work items, comments, links, and attachments.              | **on**  | `square-pen` |
| `sprints:write`      | Create & change | Manage sprints       | Create sprints and move work items in and out of them.                       | **on**  | `zap`        |
| `work_items:archive` | Create & change | Archive work items   | Archive and restore work items. This can be undone.                          | **on**  | `archive`    |
| `integration`        | Integrations    | Connect integrations | Link external tools and post activity back to Motir.                         | **on**  | `plug`       |
| `work_items:delete`  | **Danger zone** | Delete work items    | Permanently delete a work item and its entire subtree. This can't be undone. | **OFF** | `trash-2`    |

> The exact scope-key spelling above mirrors what 7.7.16 ships; if 7.7.16's final
> keys differ, 7.7.19 maps label→key by the **group + meaning**, not the literal
> string. The labels/descriptions/grouping/default here are the binding spec.

## Panel 1 — create modal with the Permissions picker (default)

The shipped create `Modal` (`size="md"`, Panel 4 of 7.7.2) gains a **Permissions**
`field` between the Workspace (binding) field and the Expires field. A
section label + helper ("Choose what this token is allowed to do. You can grant
less than your own access, never more.") sits above the grouped toggle list:

- **Group labels** reuse the `grp-label` grammar — `--font-mono`, uppercase,
  `--el-text-faint`. Groups in order: **Read · Create & change · Integrations**,
  then the **Danger zone**.
- Each **scope row** (`.scope-row`): a 16px lucide glyph in `--el-text-muted`, the
  name (`text-sm font-medium --el-text`), the description (`text-xs
--el-text-muted`), and a `Switch` on the right. Hairline `--el-border-soft`
  between rows inside a group.
- **Default render:** Read / Edit / Manage sprints / Archive / Connect
  integrations all **on** (accent track); **Delete off**.

## The Danger-zone delete toggle (distinct treatment, off by default)

`work_items:delete` lives in its **own rose box** (`.scope-danger`:
`bg-(--el-tint-rose)`, `border-(--el-border-soft)`, `rounded-(--radius-card)`,
`p-3.5`), set apart from the safe scopes so granting deletion is a **deliberate,
visible act**:

- The group label reads **"Danger zone"** in **`--el-danger`** with a
  `shield-alert` glyph.
- The scope glyph (`trash-2`) is `--el-danger`; the name is `--el-text-strong`;
  the "This can't be undone" caption is `--el-text-strong` (AA on the rose tint —
  finding #35).
- The `Switch` is **OFF** by default. Flipping it on is shown in **Panel 2** — the
  box, icon, and caption stay; only the track turns accent. (Confirmed AA in light
  AND dark — Panel 2 + the dark toggle.)

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
  `--el-danger` for the danger zone / delete chips; `--el-tint-mint` for the Full
  access pill; `--el-text-muted` scope glyphs; `--el-text-strong` on every tint
  (AA — finding #35, verified light + dark). No Tier-0 `--color-*`.
- **Shape** via element-semantic tokens only — `--radius-card` (danger box,
  detail card, summary `--radius-badge`), `--radius-control` (disclose button),
  `--spacing-chip-*` (chips), `--spacing-control-*`. No raw `rounded-md` / `p-1`.
- **Not colour-alone** (finding #35): the danger zone pairs rose tint + icon +
  "can't be undone" copy + a "Danger zone" label; the delete grant carries the
  text chip "Can delete", not a bare colour; every scope toggle has a text label
  and `aria-label`.
- **A11y:** scope toggles are `role="switch"` + `aria-checked` + `aria-label`,
  wrapped in a `role="group"` labelled by the "Permissions" heading; the disclose
  control is a real `<button>` with `aria-expanded` + a descriptive `aria-label`
  ("Show scopes for {label}"); the empty-scope error is inline form text. The
  detail sub-row is plain table markup.
- **Dark mode** confirmed (toggle in the mock): the rose danger box, mint/rose
  pills, and accent switches all flip via the token layer and stay AA.

## Primitives composed (additions — no hand-rolling)

| Element                          | Shipped primitive                                                   |
| -------------------------------- | ------------------------------------------------------------------- |
| scope toggles                    | `components/ui/Switch.tsx` (`role="switch"`)                        |
| summary / "Can delete" / chips   | `components/ui/Pill.tsx` (mint / rose / neutral tones)              |
| Permissions section + danger box | `components/ui/Card.tsx` callout grammar + the `field` form row     |
| disclose / expand                | a ghost icon `button` (the existing `icon-btn` grammar) + `chevron` |
| modal / CTA / inputs             | unchanged from 7.7.2 (`Modal` / `Button` / `Input` / `Combobox`)    |

No new primitive is invented. The "Can delete" rose pill and mint "Full access"
pill are existing `Pill` tones; the danger box is the callout grammar already used
by the shown-once warning + revoke confirm.
