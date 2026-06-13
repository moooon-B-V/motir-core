# Create-workspace flow — design notes

Design reference for the **create-workspace flow** in the **`org-admin`** area
(Story 6.10, subtask **6.10.10**). The asset is the source of truth for the UI
that the org menu's **New workspace** row opens. Built FROM the real design
system (`app/globals.css` `--el-*` colour tokens + `[data-display-style]` shape
tokens + the shipped `components/ui/*` primitives), so the code subtask composes
the same primitives — no Pencil→code gap.

This complements the area's other surface (the org switcher / settings / members
mock from 6.10.1). The shared `design-notes.md` indexes the area; THIS file is
the per-surface spec for the create-workspace flow.

| Surface                   | Asset                                                                   | Notes                                                                                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Create-workspace flow** | **`create-workspace.mock.html`** (HTML mockup) + `create-workspace.png` | The dialog the org menu's "New workspace" row opens — name + slug preview + copy-on-create source picker + the tier-2 first-reveal + submitting/error/permission states. **Consumed by 6.10.5; visualises 6.10.9.** |

## What this surface is

6.10.1 drew **"New workspace" only as a ROW** in the always-present org menu
("Adds the workspace switcher") — it did **not** draw the surface that row
_opens_. Story 1.2 never drew it either (1.2.1's switcher mockup ends at the
membership list + "Invite teammates"). So the create-workspace flow was
**undesigned**, and the cards that build it (6.10.5 wires the org-menu entry;
**6.10.9** builds the create + config clone) would have had to improvise it —
forbidden (notes.html #31; design gate "unspecified == no design"). This card
draws it.

The flow is a **name-it `Modal`** whose new workspace is **seeded by copying a
source workspace's configuration** (the "looks-inherited" behaviour — 6.10.2 §6e
/ 6.10.9), distinct from a blank create. Creating a 2nd workspace is also the
**tier-2 first-reveal**: it takes the org from 1→2 workspaces, which is the only
event that surfaces the workspace switcher (progressive disclosure, 6.10.1).

### Mirror product (rung 1 — cited, not asserted)

- **Atlassian / Jira Cloud** — "create project" lets you **share / copy settings
  from an existing project** (the scheme-copy dialog) so the new project opens
  already configured. (Atlassian Support — "Create a project"; "Manage how
  projects share schemes".)
- **Linear** — "create team" names the team and starts it from the workspace's
  defaults; teams inherit the workspace's existing configuration. (Linear Docs —
  Teams.)

Motir draws **that** shape — a name-it dialog whose new workspace is **seeded by
copying a source workspace's config** — but **without** Jira's live shared-scheme
machinery: the copy is a **one-time snapshot at creation** (6.10.2 §6e), so after
creation the workspaces are fully independent. This is the deliberate "consistent
defaults without the two-level config machinery" simplification recorded in the
area's settings notes.

### ⚠️ Out of scope here (named, NOT drawn)

- **Billing / credit / usage.** No billing surface appears in this flow. Creating
  a workspace never prompts for payment; the org-scoped usage view is **7.12.5**
  and checkout is **Epic 8**.
- **The cross-ORG platform-staff console** (Epic 10) — unrelated; this is the
  tenant's own create flow.

---

## Decisions pinned (so 6.10.5 / 6.10.9 do NOT improvise them)

The card asked this design to PIN four decisions at design time rather than leave
them to code. Each is grounded in the shipped behaviour / the mirror, not
invented.

### (a) Slug — auto-derived, shown as a PASSIVE preview (not editable here)

The dialog shows the workspace name `Input` plus a **passive
`motir.co/{slug}` preview** (a dashed-border read-only field), **not** an
editable slug field. **Why:** the shipped `CreateWorkspaceModal`
(`app/(authed)/_components/WorkspaceSwitcher.tsx`) is **name-only** — the service
(`workspacesService.createWorkspace`) `slugify()`s the name and appends a random
4-char suffix on collision. Surfacing an editable slug at create time would
contradict that and invite a second collision surface. The slug stays
**renameable later** in workspace settings (mirrors the project `ChangeKeyModal`
pattern), where the org-settings "Organization URL" field already establishes the
`motir.co/` prefix + lowercase/hyphen grammar. So: derive-and-preview at create;
edit in settings.

### (b) "Start blank" — offered, but Copy is the default

A **Segmented** (`components/ui/Segmented`) offers **Copy from a workspace**
(default, pre-selected) vs **Start blank**. **Why offer blank at all:** a
genuinely different team setup is a legitimate use, and the blank-create path
already exists in `createWorkspace` (copy-on-create is the _addition_ in 6.10.9),
so exposing it is near-zero cost and avoids trapping a user into copying an
ill-fitting config. **Why Copy is the default:** copy-on-create IS the product's
"looks-inherited" behaviour (6.10.2 §6e) — the common case is "another team like
my existing one." At **one** workspace (panel 2) the Segmented is omitted (copy is
implicit; there is nothing to pick and no reason to start blank from your only
config) — blank is a meaningful choice only once ≥2 workspaces exist (panel 3).

### (c) Post-create landing + focus

On success the dialog closes and the user **lands in the NEW (now active)
workspace** on its **"Create your first project"** empty state, with **focus on
the primary "New project" CTA**. **Why:** the clone copies **configuration**, not
**content** (6.10.9 copies workflows/fields/labels/boards/etc.; it does NOT copy
projects, work items, sprints or comments) — so the new workspace is _configured_
but _empty of work_, and the next natural action is creating a project. The
workspace switcher now renders (`Acme › Mobile App`) with the new workspace
selected, and the sidebar project switcher re-scopes to it.

### (d) Who-can-create — org owner/admin only; the row is NOT rendered for others

Creating a workspace is an **org owner/admin** action (the 6.10.5 gate). A plain
org **member's** org menu has **no "New workspace" row at all** — the control is
not rendered (panel 5c), matching 6.10.1's not-an-org-admin posture (controls are
not rendered, not merely disabled). Panel 5d documents the **considered-and-
rejected** alternative (a disabled + tooltip-explained row): advertising a control
a member can never use adds noise, so "not rendered" wins. (At the route level a
non-org-member is **404-not-403** cross-tenant, the standing guard — distinct from
this in-menu omission.)

---

## Panels (review EACH — mistake #31)

### Panel 1 — the entry point in context

Re-shows the always-present org menu from 6.10.1 with the **New workspace** row
**highlighted** (`--el-tint-lavender` bg + an `--el-accent` outline) as the launch
point, beside the one-workspace header (org only). Establishes the dialog's origin
unambiguously and notes that at one workspace this is the **only** path to tier 2
(the workspace switcher is still hidden). The menu markup is identical to 6.10.1's
(same `.menu` / `.opt` grammar) so the two assets stay consistent.

### Panel 2 — the create dialog, ONE existing workspace (the first split)

A `Modal` composing:

- **Workspace name** `Input` (focused, with caret) — the only text the user
  types.
- **Workspace URL** — the **passive slug preview** (`motir.co/mobile-app`, dashed
  read-only), with the hint "Generated from the name. You can change it later in
  workspace settings." (decision a).
- **The implicit copy affordance** — because exactly one workspace exists, the
  source is **not** a picker but a passive **copy-scope box**: "Starts with a copy
  of **Engineering**'s setup" + the **config chips** (Workflows & statuses, Custom
  fields, Labels, Components, Boards & columns, Automation, Dashboards, Saved
  filters) + the **"Not copied: work items, sprints, comments … only
  configuration"** exclusion line. This names the exact 6.10.9 copy scope so the
  user knows config is copied and content is not.
- Footer: **Cancel** (ghost) + **Create workspace** (primary).

### Panel 3 — the create dialog, ≥2 existing workspaces (the source picker)

The same `Modal`, now with the source made explicit:

- The **Copy / Start blank** `Segmented` (decision b; Copy pre-selected).
- **Copy settings from** — a `Combobox` of the org's workspaces **defaulting to
  the active workspace** (shown with an "Active" neutral pill), drawn **open** to
  show the option list (active workspace selected + a second workspace). This is
  the 6.10.9 "source workspace" choice made visible.
- The **"What gets copied from {source}"** box, here showing both the **copied**
  config chips (mint) AND the **struck-through** content chips (Work items,
  Sprints, Comments) so the config/content boundary is unmistakable.
- Footer as panel 2.

### Panel 4 — the tier-2 FIRST-REVEAL transition

A **before → after** pair (with an arrow between):

- **Before · 1 workspace** — header shows only `Acme`; caption notes the
  workspace switcher is hidden and Settings is one folded home.
- **After · 2 workspaces** — the header now reads `Acme › Mobile App` with the
  **workspace switcher rendered for the first time** (ringed to show it's new and
  the new workspace is active). Below it, the **landing**: the new workspace's
  **"Create your first project"** empty state with the ringed **New project** CTA
  (decision c). A foot-note records that the **Settings home has split** into a
  per-workspace area (6.10.2 §6d) with **no data moved**.

### Panel 5 — states + permission

- **(a) Submitting** — the clone is **one all-or-nothing transaction** (6.10.9),
  so the dialog **stays open** showing a pending state: a `Spinner` in a disabled
  **"Creating…"** primary button, Cancel disabled, an info `note` ("Setting up
  workflows, fields, labels and boards…"). No premature navigation (the E2E
  authoritative-signal rule: the UI waits for the create response).
- **(b) Error (tx rollback)** — a name/slug collision **or** a clone failure rolls
  the **whole** transaction back, surfaced as **one in-dialog error** (rose
  `err-note`) with the form keeping its values and the name field in a danger
  ring. The copy: "A workspace named '…' already exists in this organization. Pick
  a different name — nothing was created." — i.e. **no half-created workspace**.
- **(c) Permission — org member** — the org menu **without** the "New workspace"
  row (decision d).
- **(d) Considered & rejected** — the disabled + tooltip-explained row variant,
  shown only to document why (c) wins.

---

## Primitives composed (no hand-rolling)

Every surface composes a shipped `components/ui/*` primitive. If 6.10.5 needs a
genuinely new primitive, that is a **new `design/` subtask**, not a code
workaround.

- **`Modal`** (`components/ui/Modal.tsx` — the shipped dialog primitive, built on
  Radix `Dialog`; **there is no `Dialog.tsx`** — the card said "Dialog"
  generically). `--radius-modal`, `--shadow-modal`; head (serif `h3` + muted
  subtitle + close `x`), `Modal.Body`, `Modal.Footer`. The shipped
  `CreateWorkspaceModal` already composes `Modal` + `Input`, so 6.10.5 extends
  that, it does not introduce a new dialog.
- **`Input` + `FormField`** — the name field (`--height-input`,
  `--spacing-input-*`, `--radius-input`); the slug **preview** is a read-only
  dashed variant (NOT an `Input` — it takes no focus), with the `motir.co/`
  `--el-text-faint` prefix.
- **`Combobox`** — the "Copy settings from" source picker (trigger +
  `--shadow-elevated` menu, rows at `--spacing-control-*` / `--radius-control`),
  reusing the 6.10.1 menu grammar.
- **`Segmented`** (`components/ui/Segmented.tsx`) — the Copy / Start-blank choice
  (`--radius-btn` track, `--radius-control` thumbs, `--height-control`).
- **`Button`** — primary (Create workspace, New project), ghost (Cancel). Heights
  `--height-btn-md`; padding `--spacing-btn-x[-sm]`.
- **`Pill`** — the copy-scope chips (config = mint tone; content = neutral,
  struck-through) and the "Active" / role chips. `--radius-badge`,
  `--spacing-chip-*`; **hue in the tint BACKGROUND with `--el-text-strong` text
  (finding #35 — AA-safe), never a tinted page surface.**
- **`Spinner`** — the submitting state.
- **`EmptyState`** — the post-create first-project landing (panel 4).
- **`Tooltip`** — the disabled-row explainer in panel 5d (ink bg,
  `--el-text-inverted`).
- **The org menu / `Popover` + TopNav chrome** — reused verbatim from 6.10.1 so
  the launch context matches the shipped switcher.
- **Note / error grammar** — the dashed info `note` and the rose in-dialog error
  reuse the area's `note` / `ErrorState` tones.

## Colour roles (`--el-*` — palette, not grey-only · finding #54)

| Element                                | Token                                                              | Why                                                                             |
| -------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| **Launch row (New workspace)**         | `--el-tint-lavender` bg + `--el-accent` outline                    | Marks the flow's entry point in the org menu (brand-purple family, like owner). |
| **Copied-config chips**                | `--el-tint-mint` bg + `--el-text-strong`                           | "Config is copied" reads as a positive, present category (green).               |
| **Not-copied content chips**           | `--el-surface` + `--el-text-secondary`, struck through             | Neutral + line-through = "deliberately excluded" (content stays behind).        |
| **Workspace avatar / chips**           | `--el-tint-peach` bg + `--el-text-strong`                          | Workspace "scope" hue, distinct from the lavender org avatar (matches 6.10.1).  |
| **Org avatar**                         | `--el-tint-lavender` bg + `--el-text-strong`                       | The org tier (matches 6.10.1's org-role owner / org-avatar hue).                |
| **Primary CTAs / focus ring / active** | `--el-accent` (+ `--el-accent-text`)                               | Create / New project / the focused field + selected source.                     |
| **Submitting note**                    | `--el-surface-soft` + `--el-text-secondary` (dashed)               | Quiet, non-alarming pending message.                                            |
| **Error (tx rollback)**                | `--el-tint-rose` bg + `--el-text-strong` (`--el-danger-text` icon) | The collision / failure message + the danger field ring.                        |
| **Org-role chips (owner / member)**    | `--el-tint-lavender` / `--el-tint-mint` + `--el-text-strong`       | Reused from 6.10.1 for consistency in the menu panels.                          |
| Text / surfaces / borders              | `--el-text*`, `--el-surface*`, `--el-border*`                      | Standard element tokens — never Tier-0 `--color-*`.                             |

All shaped surfaces use the **`[data-display-style]` shape tokens**
(`--radius-{btn,card,input,modal,control,badge}`, `--spacing-{btn,input,control,
chip,card-padding}`, `--height-{btn-*,input,control}`, `--shadow-*`) — never the
inert Tier-0 radius/spacing scale or a fixed raw utility. `rounded-full`
(`9999px`) is used only for the round user avatar / spinner. Toggle the mock's
dark mode to confirm token parity (every colour flips through Tier-0 under
`--el-*`).

## Copy strings (en — the `orgAdmin` i18n namespace 6.10.5 adds)

- Launch: org-menu row **"New workspace"** / **"Adds the workspace switcher"**
  (the shipped string from 6.10.1).
- Dialog: title **"New workspace"**; subtitle **"A workspace groups related
  projects under the {org} organization."**; **"Workspace name"**; **"Workspace
  URL"** with hint **"Generated from the name. You can change it later in
  workspace settings."**
- Starting setup: **"Starting setup"**; segment **"Copy from a workspace"** /
  **"Start blank"**; hint **"Copy reuses another workspace's configuration so the
  new one opens ready to use."**; **"Copy settings from"**; **"Active"** (the
  default-source pill).
- Copy scope: **"Starts with a copy of {workspace}'s setup"** (one-workspace) /
  **"What gets copied from {workspace}"** (multi); config chips **"Workflows &
  statuses"**, **"Custom fields"**, **"Labels"**, **"Components"**, **"Boards &
  columns"**, **"Automation"**, **"Dashboards"**, **"Saved filters"**; exclusion
  **"Not copied: work items, sprints, comments and other content — only
  configuration. After this, the two workspaces are independent."**
- Actions: **"Create workspace"**, **"Cancel"**; submitting **"Creating…"** /
  **"Setting up workflows, fields, labels and boards. This usually takes a
  moment."**; error **"A workspace named '{name}' already exists in this
  organization. Pick a different name — nothing was created."**
- Landing: **"Create your first project"** / **"{workspace} is set up and ready —
  workflows, fields and boards were copied from {source}. Add a project to start
  tracking work."** / **"New project"**.
- Permission (5d, rejected variant): **"Owners & admins only"** / tooltip
  **"Only {org} owners and admins can create workspaces."**

The full string set is added to the app's locale files (en + zh, the shipped
locale set) by the 6.10.5 code subtask under the `orgAdmin` namespace.
