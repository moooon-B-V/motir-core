# Settings — design notes

Design reference for the `settings` UI area. The headline surface here is the
**account settings AREA** — the per-user settings surface, redesigned (Story 7.8
· 7.8.2) from a flat 2-card page into a grouped-nav **area** that scales as it
grows. Built FROM the real design system (`app/globals.css` `--el-*` / shape
tokens + the shipped `components/ui/*` primitives), so the code subtasks compose
the same primitives — no Pencil→code gap.

| Surface                   | Asset                                        | Notes                                                                                                                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Account settings area** | **`account-settings.mock.html`** (HTML mock) | The whole account-settings area: the rail grouped nav + the Appearance / Notifications / Security (API tokens) panes + the API-token create / shown-once / revoke / empty / toast flows. Multi-panel. **Gates 7.8.3** (API tokens) and is the architecture for the future Appearance stories. |

## Why the whole area (the corner that was cut, then fixed)

The first pass designed **only** the API-tokens card, bolted onto the existing
flat account page (`LanguageCard` + `NotificationPreferencesCard` stacked in a
`max-w-[42rem]` column). That was a corner cut: the account surface is about to
hold **many** more personal settings — theme, **colour palette / accent**,
**font**, **display style**, language — and a flat card stack does not scale to
that. Designing one card in isolation would have locked in the wrong
architecture. So 7.8.2 is the **whole account-settings redesign**, with API
tokens as one section.

## Architecture — an "area" with a grouped rail nav (rung 2: the shipped pattern)

The decision is settled by **already-shipped code**, not invented: Motir's
**project settings** is an _area_ (Story 6.5) whose grouped nav swaps into the
app rail (`SidebarNav` renders it from the `lib/settings/projectSettingsNav`
registry when the route is inside the area), one page per sub-section, with a
route↔registry **totality guard** and a "Soon" placeholder slot for designed-for
pages. The account settings adopts the **same** pattern (Yue's call,
2026-06-14):

- A new **`lib/settings/accountSettingsNav`** registry — the exact shape of
  `projectSettingsNav` (typed entries with `id` / `group` / `href` / `icon` /
  `labelKey` / `access` / `placeholder`), driving (1) the rail area nav, (2) the
  command-palette deep links, (3) the totality test pairing every
  `settings/account/**/page.tsx` route 1:1 with a registry entry.
- The rail's **header** (where project settings shows the back-link +
  ProjectSwitcher) here shows **"← Back to Motir"** + the **user identity**
  (initial `Avatar` + name + email) + the eyebrow **"Account settings"**.
- **Groups** (rail order): **General · Preferences · Security**.
  - **General → Profile** — a reserved **"Soon"** placeholder (name / avatar /
    password live here later), drawn as the disabled `Soon` row exactly like the
    project area's Automation slot, so the area's shape is legible from day one.
  - **Preferences → Appearance, Notifications** — both real pages.
  - **Security → API tokens** — the 7.8.3 page.
- Each sub-section is its own route under `app/(authed)/settings/account/…`
  (Appearance / Notifications / API tokens). The existing flat account page
  becomes the area's landing (Appearance) — the `LanguageCard` /
  `NotificationPreferencesCard` move into their panes.

### ⚠️ Planning implications (flagged, not silently absorbed)

This redesign is bigger than the original 7.8.3 ("API tokens settings UI") scope.
Two items need OWNING subtasks/stories (the no-V1-tier / orphaned-deferral rule —
don't fold them into 7.8.3):

1. **The account-settings AREA shell** — the `accountSettingsNav` registry, the
   rail-swap wiring, the `settings/account` layout, the route split, the totality
   test. A prerequisite for the API-tokens page living in the area. Should be its
   own subtask under Story 7.8 (sibling of 7.8.3), with 7.8.3 `dependsOn` it; or
   7.8.3 is re-scoped to "API tokens page **inside** the new account area" and a
   new 7.8.x owns the shell. **Recommend: a new shell subtask + retarget 7.8.3's
   dependsOn.**
2. **Appearance: accent palette + font** — these controls are **designed-ahead**
   here but DO NOT exist yet (`lib/theme/types.ts` ships only `pattern` +
   `displayStyle`; `THEME_STORAGE_KEYS` has no accent/font). They are not part of
   7.8 at all — they belong to a future **Appearance** story (personalization).
   The mock marks them with a **"Soon"** tag so the area is honest about what's
   live. Logged as a planning gap to seed a story for.

## Shipped vs. designed-ahead (so 7.8.3 builds only what's real)

| Control                        | State today                                                                 | In the mock                         |
| ------------------------------ | --------------------------------------------------------------------------- | ----------------------------------- |
| Theme (system / light / dark)  | **Shipped** — `theme-context` + `ThemeToggle`, `THEME_STORAGE_KEYS.pattern` | live Segmented                      |
| Display style (default / soft) | **Shipped** — `THEME_STORAGE_KEYS.displayStyle` (flat / pill are future)    | live Segmented (flat/pill disabled) |
| Language                       | **Shipped** — `setLocale` cookie (`LanguageCard`)                           | live Combobox                       |
| Notifications matrix           | **Shipped** — `NotificationPreferencesCard` (5.7.6)                         | live Switch matrix                  |
| **Accent colour**              | **Not built** — future Appearance story                                     | `Soon`-tagged swatches              |
| **Font**                       | **Not built** — future Appearance story                                     | `Soon`-tagged Segmented             |
| API tokens                     | substrate 7.8.1 (in progress); page is **7.8.3**                            | full table + flows                  |

---

## Panel 1 — Appearance pane (the area shell + the Appearance page)

The area shell: the **rail** (`--el-sidebar-bg`, `border-(--el-sidebar-border)`)
with the back-link + user identity + grouped nav (Appearance active = the
canvas-inset treatment: `bg-(--el-sidebar-item-bg-active)` +
`border-(--el-sidebar-border)` + `shadow-(--shadow-subtle)` + accent icon), and
the **content** with the serif `h2` page head + a `max-w-[680px]` card stack.

The Appearance page uses a **settings-row grammar** inside `Card`s — a label +
description on the left, the control on the right, hairline-separated
(`border-(--el-border-soft)`) — the pattern that scales as more rows land:

- **Card "Theme & display"**:
  - **Theme** — a `Segmented` (System / Light / Dark) with lucide `monitor` /
    `sun` / `moon` leading glyphs (active glyph takes `--el-accent`).
  - **Accent colour** (`Soon`) — a `ColorSwatchPicker` (radiogroup of
    `rounded-full` swatches; selected = the double-ring `--el-text` halo). The
    palette draws from the Tier-0 hues (primary / pink / teal / green / blue /
    amber).
  - **Font** (`Soon`) — a `Segmented` (System / Inter / Serif), `type` glyph.
  - **Display style** — a `Segmented` (Default / Soft; Flat / Pill drawn
    present-but-disabled with a "Coming soon" `title`, the Segmented `disabled`
    option seam).
- **Card "Language & region"**:
  - **Language** — the shipped `Combobox` (input-shaped trigger, `chevron-down`).

## Panel 2 — Notifications pane

The shipped **`NotificationPreferencesCard`** matrix inside the area — a
`grid-cols-[1fr_5rem_5rem]` of event rows × **Email / In-app** columns of
`Switch` toggles (`role="switch"`, accent track when on). Header row caption
(`--el-text-faint` uppercase) with a `--el-border` rule; rows hairline-separated.
Each switch carries an `aria-label` ("{channel} for {event}"). No redesign of the
matrix itself — it just moves into its pane.

## Panel 3 — Security & access pane (API tokens) — the 7.8.3 surface

The human face of the **PAT substrate** (7.8.1) the MCP bearer gate (7.8.4)
consumes. A PAT is **generated once, shown once, stored only as a hash,
expiring, revocable** — the Jira / GitHub API-token shape.

**Mirror surface (rung 1, VERIFIED):** Atlassian API tokens (`id.atlassian.com`
→ Security → API tokens) — create with label + expiry, a list of label / created
/ expires / last-used, revoke per row, secret shown once. The `motir_pat_` prefix

- shown-once monospace copy field follow GitHub's PAT shape (greppable prefix for
  secret scanners). Motir keeps its coloured personality (peach "expiring soon"
  chip, accent CTA) without inventing primitives.

* **Card "Your tokens"** with a header slot: title + sub on the left, the
  **"Create token"** primary `Button` (size `sm`, `plus` glyph) on the right.
* **The table** — a borderless row list (org-members roster grammar). Columns:
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
  `nav.{profile,appearance,notifications,apiTokens}`.
- **`settings.appearance`** — `heading`, `subtitle`, `theme.{label,desc,
system,light,dark}`, `accent.{label,desc}`, `font.{label,desc,system,inter,
serif}`, `display.{label,desc,default,soft,flat,pill}`, `language.{label,
desc}`, `soon` ("Soon").
- **`settings.apiTokens`** — `heading`, `subtitle`, `card.{title,subtitle}`,
  `create` ("Create token"), `columns.{label,token,created,expires,lastUsed,
actions}`, `expiresIn` ("in {n} days"), `expiresNever`, `lastUsedNever`,
  `revoked`, `revokeAria`, `create.{title,description,labelField,labelHelper,
expiresField,expiresHelper,submit,cancel}`, `expiry.{d30,d90,d365,never}`,
  `created.{title,description,secretLabel,copy,warning,done}`,
  `revokeConfirm.{title,body,confirm,cancel}`, `empty.{title,body,guideLink}`,
  `toast.{title,body}`.
- Same locale set the rest of the app ships.

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the accent on the active nav
  row + selected Segmented glyphs + the accent swatch + the CTAs + the on-Switch
  track; the `--el-tint-peach` expiring chip + warning callout; the
  `--el-tint-rose` revoke callout; `--el-danger` revoke; `--el-success` toast;
  `--el-code-bg` token chips; the `--el-tint-yellow` "Soon" chips. No Tier-0
  `--color-*` / Tailwind Tier-0 utilities. Tints carry the hue in the BACKGROUND
  with `--el-text-strong` text (finding #35, AA — verified light **and** dark).
- **Shape** via element-semantic tokens only (`--radius-card` / `-input` / `-btn`
  / `-badge` / `-control` / `-modal`, `--shadow-subtle` / `-card` / `-modal` /
  `-elevated`, `--spacing-card-padding` / `-control-*` / `-input-*` / `-chip-*` /
  `-icon-btn`, `--height-control` / `-input` / `-btn-*`) — no Tier-0 scale, no raw
  `rounded-md` / `p-1` / `h-9`. `rounded-full` only on the avatar / swatches /
  switch track.
- **Not colour-alone** (finding #35): Segmented active = raised fill + shadow +
  glyph hue (not hue alone); the expiring / revoked chips carry text; callouts
  pair tint + icon + copy; the revoke button is icon + `aria-label`.
- **A11y**: the rail nav is grouped `SidebarSection`s; Segmented = labelled
  `role="group"` of `aria-pressed` buttons; swatches = `role="radiogroup"`;
  switches = `role="switch"` + `aria-label`; the create / shown-once / revoke
  surfaces are `Modal` (Radix focus trap, ESC, labelled); the secret field is
  read-only and the ONLY place the plaintext appears (never logged / in a DTO —
  7.8.1); the toast is `role="status"`.
- **Dark mode** confirmed (toggle in the mock): every surface / text / tint /
  chip flips via the token layer and stays AA.

## Primitives composed (no hand-rolling)

| Element                       | Shipped primitive                                                        |
| ----------------------------- | ------------------------------------------------------------------------ |
| area shell (rail + content)   | `app/(authed)` rail + `SidebarNav` (the 6.5 settings-area shape)         |
| grouped nav registry          | `lib/settings/accountSettingsNav` (new — mirrors `projectSettingsNav`)   |
| card / empty                  | `components/ui/Card.tsx` · `components/ui/EmptyState.tsx`                |
| theme / font / display toggle | `components/ui/Segmented.tsx`                                            |
| accent swatches               | `components/ui/ColorSwatchPicker.tsx`                                    |
| notification toggles          | `components/ui/Switch.tsx`                                               |
| language / expiry select      | `components/ui/Combobox.tsx`                                             |
| create / revoke / shown-once  | `components/ui/Modal.tsx` (Radix Dialog)                                 |
| label field                   | `components/ui/Input.tsx` + `components/ui/FormField.tsx`                |
| chips                         | `components/ui/Pill.tsx` (`severity="warning"` / `tone="neutral"`)       |
| buttons                       | `components/ui/Button.tsx` (primary / secondary / ghost / danger / icon) |
| token-prefix chip             | inline `--el-code-bg` / `--el-code-text` code grammar                    |
| copy confirmation             | `components/ui/Toast.tsx` (`useToast`, `variant="success"`)              |

No new design-system primitive is invented for this surface. If a future need
arises that a shipped primitive can't cover, that is a NEW `design/` subtask, not
a code workaround.
