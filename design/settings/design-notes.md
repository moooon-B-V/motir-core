# Settings — design notes

Design reference for the `settings` UI area. The first surface here is the
**API tokens** management surface (Story 7.8 — the Motir MCP server). Built FROM
the real design system (`app/globals.css` `--el-*` / shape tokens + the shipped
`components/ui/*` primitives), so the code subtasks compose the same primitives —
no Pencil→code gap.

| Surface                  | Asset                                  | Notes                                                                                                                                                                                                                  |
| ------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API tokens (account)** | **`api-tokens.mock.html`** (HTML mock) | The Settings → Account "API tokens" card — list / create / shown-once / revoke / empty. No `design/settings/` asset existed; the 7.8.2 design gate produces this. Multi-panel. **Gates 7.8.3** (the settings UI code). |

The API-tokens surface is the human face of the **PAT substrate** (7.8.1) that
the MCP bearer gate (7.8.4) consumes. A personal access token is **generated
once, shown once, stored only as a hash, expiring, revocable** — the Jira /
GitHub API-token shape. This surface lets a user mint a token for each coding
agent, see what they have, and revoke one.

**Mirror surface (rung 1, VERIFIED):** Atlassian API tokens
(`id.atlassian.com` → Security → API tokens) — create with a label + expiry, a
list showing label / created / expires / last-used, revoke per row, and the
secret shown exactly once at creation. The `motir_pat_` prefix + the
shown-once monospace copy field follow GitHub's PAT shape (greppable prefix for
leaked-secret scanners). Motir keeps its **coloured-personality register** (the
less-enterprise-than-Jira standing policy) — a peach "expiring soon" chip, the
accent CTA — without inventing any new primitive.

The asset is **multi-panel** (review EACH, not just the first — mistake #31):

- **(1)** the populated Settings → Account page — the **"API tokens"** `Card`
  with the token table (a live token, an expiring-soon token, a revoked token).
- **(2)** the **create modal** — a label `Input` + an expiry `Combobox` (90-day
  default) + the create CTA.
- **(3)** the **shown-once state** — the same `Modal` after create: the full
  secret in a read-only monospace field with a Copy button, and the one-time
  warning callout.
- **(4)** the **revoke confirm** — a destructive `Modal` (sm) naming the token
  label, with a danger callout + danger Button.
- **(5)** the **empty state** — the `EmptyState` primitive (key glyph + a docs
  link to `docs/mcp.md` + the create action).
- **(6)** the **copy-confirmation toast** — the `Toast` primitive (success).

---

## Where it lives

A new card on the existing **`app/(authed)/settings/account/page.tsx`** — the
per-user account-settings page, which already stacks the `LanguageCard` and
`NotificationPreferencesCard` inside `mx-auto max-w-[42rem] flex flex-col gap-6`.
The API-tokens card is the third card in that stack. **Account-scoped, not
workspace/project-scoped:** a PAT belongs to a USER (it acts as that user across
every workspace they're a member of), so it lives beside Language — the user's
other personal preferences — not under a workspace/project settings tree. This
mirrors Atlassian (API tokens live under the personal Atlassian account, not a
site).

The list itself is a **client island** (`'use client'`): create / revoke are
optimistic mutations that mutate the row list in place (the
`page-state-after-mutation` contract — the list owns its state via
`useState(initialTokens)`, so it does its own optimistic insert on create /
remove-or-mark-revoked on revoke, NOT a `router.refresh()` it can't see). The
page server-reads the initial token list via `apiTokensService.listForUser`.

## Layout (panel 1 — the card)

- **Card** (`components/ui/Card.tsx`) with a **header slot**: a flex row with the
  title block on the left and the **"Create token"** primary `Button` (size `sm`,
  leading lucide `plus`) on the right.
  - **Title** — `font-sans text-base font-semibold text-(--el-text)` reading
    **"API tokens"** (the `Card` header convention — `LanguageCard` grammar).
  - **Description** — `text-(--el-text-muted) text-sm` under the title: "Personal
    access tokens let your coding agents reach Motir over the MCP server. Each
    token acts as you — give every agent its own." Frames the security model
    (a token = the user) and the one-token-per-agent guidance up front.
- **The table** — a borderless row list (the org-members roster grammar), NOT a
  new primitive. Columns: **Label · Token · Created · Expires · Last used ·
  Actions** (the last right-aligned). `thead th` is the mono-ish uppercase
  caption (`text-[11px] font-semibold uppercase tracking-[0.05em]
text-(--el-text-faint)`, a `--el-border` bottom rule); each `tbody tr` is a
  `--el-border-soft` hairline-separated row.
  - **Label** — `font-sans text-sm font-medium text-(--el-text)`.
  - **Token** — the `tokenPrefix` in an inline **code chip** (`font-mono text-xs`
    on `--el-code-bg` / `--el-code-text`, `rounded-(--radius-control)`),
    rendering `motir_pat_AbC1…` (prefix + ellipsis; the full secret is never in
    the list).
  - **Created / Last used** — relative/short dates in
    `text-(--el-text-secondary)` (`text-sm`). Last-used falls back to a muted
    "—" / "Never" when null.
  - **Expires** — short date in `text-(--el-text-secondary)`; within ~7 days it
    becomes a **`Pill severity="warning"`** ("in 5 days", peach tint +
    `--el-text-strong`, AA per finding #35) so an about-to-break token is
    visible; a never-expiring token reads "Never".
  - **Actions** — a square icon `Button` (ghost, `--spacing-icon-btn` padding,
    `rounded-(--radius-control)`, 16px lucide `trash-2` in
    `text-(--el-text-muted)`, hover → `--el-danger`) with an explicit
    `aria-label` **"Revoke token {label}"**. It opens the panel-4 confirm.
  - **Revoked row** — shown muted (`text-(--el-text-faint)` cells) with a
    **`Pill tone="neutral"`** reading **"Revoked"** in the Actions column
    instead of the revoke button (the row stays for the audit trail; 7.8.1's
    soft-revoke `revokedAt`). Sorted after live tokens.

## Create modal (panel 2)

A `Modal` (`size="md"`, `title="Create API token"`,
`description="The token will be shown once, right after you create it. Store it
somewhere safe."`):

- **Label `Input`** (`components/ui/Input.tsx` + `FormField`) — label "Label",
  `helperText` "A name to recognise this token by — e.g. the agent or machine
  using it." Autofocus.
- **Expiry `Combobox`** (`components/ui/Combobox.tsx`, input-shaped trigger) —
  label "Expires", options **30 days / 90 days / 365 days / Never**, default
  **90 days**. `helperText` "After this, the token stops working and agents must
  be re-issued one."
- **Footer** (`Modal.Footer`) — a ghost **"Cancel"** + a primary **"Create
  token"**. The primary is disabled until a non-empty label is entered (and
  `loading` while the create POST is in flight).

## Shown-once state (panel 3)

The SAME modal, swapped to the post-create state (the create POST returns the
plaintext exactly once — 7.8.1's `create` return value):

- **Title** → **"Token created"**, **description** → "Copy your token now — for
  security, Motir won't show it again."
- **Secret field** — a read-only, full-width **monospace field** (input-shaped:
  `h-(--height-input)`, `rounded-(--radius-input)`, `--el-border-strong`, on
  `--el-surface` to read as read-only) holding the FULL `motir_pat_…` secret,
  with a secondary **"Copy"** `Button` (leading lucide `copy`) beside it. Copy
  writes the plaintext to the clipboard and fires the panel-6 toast.
- **One-time warning callout** — a **peach-tint** box (`--el-tint-peach`,
  `--el-text-strong` text — AA, finding #35; `rounded-(--radius-card)`) with a
  lucide `triangle-alert` in `--el-warning`: "This is the only time you'll see
  this token. If you lose it, revoke it and create a new one."
- **Footer** — a single primary **"Done"** that closes the modal. There is no
  going back to the secret once closed.

## Revoke confirm (panel 4)

A destructive `Modal` (`size="sm"`, `title='Revoke "{label}"?'`):

- **Danger callout** — a **rose-tint** box (`--el-tint-rose`, `--el-text-strong`
  text — AA; `rounded-(--radius-card)`) with a lucide `triangle-alert` in
  `--el-danger`: "Any agent using this token loses access to Motir immediately.
  This can't be undone — you'll need to create a new token to reconnect."
- **Footer** — a ghost **"Cancel"** + a **`Button variant="danger"`** "Revoke
  token" (leading lucide `trash-2`). On confirm the row optimistically flips to
  the muted revoked state (panel 1).

## Empty state (panel 5)

The shipped **`EmptyState`** primitive (Card + icon + title + description +
action), shown when the user has no tokens:

- **Icon** — lucide **`key-round`** (the API-token glyph) passed as the `icon`
  prop, `text-(--el-text-muted)`, 48px (overrides the primitive's default
  `Inbox` — a key reads as "credentials").
- **Title** — **"No API tokens yet"**.
- **Description** — "API tokens let your coding agents talk to Motir over the MCP
  server — list ready work, open work items, move them, and comment, all as you.
  **Read the MCP setup guide** to connect your first agent." The "MCP setup
  guide" is a link to `docs/mcp.md` (the 7.8.8 doc).
- **Action** — a primary **"Create token"** `Button` (leading lucide `plus`),
  opening the panel-2 modal.

## Copy-confirmation toast (panel 6)

The shipped **`Toast`** primitive, `variant="success"` (left `--el-success`
border, `CheckCircle2` icon in `--el-success`), bottom-right:

- **Title** — **"Token copied"**.
- **Description** — "Paste it into your agent's MCP config now — it won't be
  shown again."
- Fired via `useToast()` from the shown-once Copy handler.

## i18n

- **new `settings.apiTokens` namespace** — `heading` ("API tokens"),
  `description`, `create` ("Create token"), `columns.{label,token,created,
expires,lastUsed,actions}`, `expiresIn` ("in {n} days"), `expiresNever`
  ("Never"), `lastUsedNever` ("Never"), `revoked` ("Revoked"), `revokeAria`
  ("Revoke token {label}"), `create.{title,description,labelField,labelHelper,
expiresField,expiresHelper,submit,cancel}`, `expiry.{d30,d90,d365,never}`,
  `created.{title,description,secretLabel,copy,warning,done}`,
  `revokeConfirm.{title,body,confirm,cancel}`, `empty.{title,body,guideLink}`,
  `toast.{title,body}`. Same locale set the rest of the app ships.

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the accent CTA + the
  shown-once "Done"; the `--el-tint-peach` "expiring soon" chip + warning
  callout; the `--el-tint-rose` revoke callout; the `--el-danger` revoke
  button + trash-hover; the `--el-success` toast; the `--el-code-bg` token
  prefix chips. No Tier-0 `--color-*` and no Tailwind Tier-0 utilities. Every
  tint carries its hue in the BACKGROUND with `--el-text-strong` text (finding
  #35, AA — verified in both light and dark); no page-level surface is tinted.
- **Shape** via element-semantic tokens only (`--radius-card` / `-input` /
  `-btn` / `-badge` / `-control` / `-modal`, `--shadow-subtle` / `-modal` /
  `-elevated`, `--spacing-card-padding` / `-input-*` / `-chip-*` / `-icon-btn`,
  `--height-input` / `-btn-*`) — no generic Tier-0 scale, no raw `rounded-md` /
  `p-1` / `h-9`.
- **Not colour-alone** (finding #35): the expiring chip + the revoked chip carry
  TEXT, not just a hue; the warning/danger callouts pair the tint with a
  `triangle-alert` icon + copy; the revoke button is icon + `aria-label`.
- **A11y**: the create / shown-once / revoke surfaces are `Modal` (Radix Dialog —
  focus trap, ESC, labelled title/description); the secret field is read-only;
  the revoke icon button has an explicit `aria-label`; the toast is a
  `role="status"`; the shown-once secret is the ONLY place the plaintext ever
  appears (never logged, never in a DTO — 7.8.1).
- **Dark mode** confirmed (toggle in the mock): all surfaces/text/tints/chips
  flip via the token layer; the warning + revoked chips stay AA in dark.

## Primitives composed (no hand-rolling)

| Element                 | Shipped primitive                                                        |
| ----------------------- | ------------------------------------------------------------------------ |
| card / empty            | `components/ui/Card.tsx` · `components/ui/EmptyState.tsx`                |
| create / revoke / shown | `components/ui/Modal.tsx` (Radix Dialog)                                 |
| label field             | `components/ui/Input.tsx` + `components/ui/FormField.tsx`                |
| expiry select           | `components/ui/Combobox.tsx`                                             |
| expiring / revoked chip | `components/ui/Pill.tsx` (`severity="warning"` / `tone="neutral"`)       |
| create / copy / revoke  | `components/ui/Button.tsx` (primary / secondary / ghost / danger / icon) |
| token-prefix code chip  | inline `--el-code-bg` / `--el-code-text` code grammar                    |
| copy confirmation       | `components/ui/Toast.tsx` (`useToast`, `variant="success"`)              |

No new design-system entry is invented for this surface. If a future need arises
that a shipped primitive can't cover, that is a NEW `design/` subtask, not a code
workaround.
