# Story 1.3 project-UI design notes (Subtask 1.3.3 output)

This file is the canonical reference for Subtask 1.3.4 (implementation) —
which primitives compose each surface, which copy strings to use verbatim,
and the top-nav placement decision.

All surfaces are drafted in Pencil (`projects.pen`, one document, all
frames) with PNG exports for review. Open the `.pen` via Pencil to inspect
layers, variables, and annotations. The visual grammar deliberately matches
`/design/workspaces/*.png` (Subtask 1.2.1) — the project surfaces are the
direct analogue of the workspace surfaces.

---

## Files

| `.pen` source  | PNG exports                                                                  |
| -------------- | ---------------------------------------------------------------------------- |
| `projects.pen` | `create-modal.png`, `empty-state.png`, `switcher.png`, `archive-confirm.png` |

`switcher.png` is a single export holding BOTH the closed and open states
(stacked, each annotated) — matching how `/design/workspaces` documents the
workspace switcher across two states. `archive-confirm.png` holds both the
disabled (input empty) and armed (input matches) states side by side, exactly
mirroring `delete-confirm.png`.

---

## No new primitive required

Every surface composes ONLY primitives that already exist in
`components/ui/` as of Subtask 1.2.6:

- **`Modal`** (Radix-wrapped, `size="md"`) — create-project modal,
  archive-confirm modal.
- **`Input`** — name field, identifier field, typed-identifier confirm field
  (uses the `label` + `helperText` props; the identifier field uses
  `font-mono` for its value).
- **`Button`** — `variant="primary"` (Create project), `variant="ghost"`
  (Cancel), `variant="danger"` (Archive project).
- **`EmptyState`** — the empty-state surface is a near-verbatim instance of
  the shipped pattern (`Card` + lucide icon + headline + description +
  action button).
- **`Popover`** — the project switcher's open state. Popover EXISTS as of
  Subtask 1.2.6; no new primitive is needed (1.2.1 had to flag Popover as a
  NEW primitive; that gap is now closed).
- **`Card`** — implicitly via `EmptyState`.

No new component patterns are introduced.

---

## Primitives composed per surface

### Create-project modal (`create-modal.png`)

- `Modal` size="md", title `"Create project"` (serif heading, rendered by
  the `Modal` primitive's title slot).
- **Name field**: `Input label="Project name"`, placeholder `"Mobile App"`.
- **Identifier field**: `Input label="Identifier"`, value is auto-derived
  from the name (uppercased, truncated to 3–5 chars) but user-overridable.
  The displayed value uses `font-mono`. Below it, the `Input`'s `helperText`
  carries the LIVE KEY PREVIEW:
  `"3–5 uppercase characters. Work items will be keyed PROD-1, PROD-2, …"`
  The `PROD` substring is the live identifier value — it updates as the user
  types so the preview always reflects the current key.
- `Modal.Footer`: `Button variant="ghost"` Cancel + `Button variant="primary"`
  "Create project", right-aligned (`justifyContent: end`).

Implementation note for 1.3.4: the identifier auto-derive is a controlled
field — derive from name on each keystroke UNTIL the user manually edits the
identifier, after which it stops tracking the name (standard Linear/Jira
project-key behavior). The live preview string interpolates the current
identifier value, defaulting to the derived value.

### Empty state (`empty-state.png`)

- Rendered inside the `(authed)` top-nav + content shell. The active
  workspace has zero projects.
- `EmptyState` pattern: lucide `FolderOpen` icon (override the default
  `Inbox`), headline `"Create your first project"`, description, and a
  primary `Button leftIcon={<Plus />}` "Create project" that opens the
  create-project modal.
- The top-nav shows the workspace switcher (left) with the project switcher
  trigger immediately to its right reading `"No project"` (muted) since none
  exists yet.

### Project switcher (`switcher.png`, closed + open)

- **Closed state**: `Button variant="ghost"` trigger showing the active
  project name + lucide `ChevronDown`. Positioned in the top-nav BESIDE the
  workspace switcher — workspace-left, project-immediately-right, separated
  by a 1px hairline rule. The two-switcher layout is documented below.
- **Open state**: the existing `Popover` primitive, 320px wide, anchored
  below the trigger. Inside:
  - Section header: `"PROJECTS"` in `font-mono`, caps, `text-muted-foreground`,
    letter-spaced.
  - One row per project: lucide `Check` (`--color-primary`) on the active
    project + bold name + `--color-surface` row background; inactive rows are
    plain (no check, regular weight, transparent background).
  - Divider: `<div className="h-px bg-(--color-hairline)" />`.
  - "Create project" entry: lucide `Plus` + label — opens the create-project
    modal.
- The active trigger gets a `--color-primary` border + `--color-surface`
  fill while the popover is open (focus affordance), matching the workspace
  switcher's open-trigger treatment.

### Archive-confirm modal (`archive-confirm.png`, disabled + armed)

Reuses 1.2.1's `delete-confirm.png` typed-name double-confirmation grammar,
adapted for ARCHIVE (we archive, never hard-delete — work-item history is
preserved for Story 1.4):

- `Modal` size="md", **no `title` prop** — render a custom heading row
  inside the body: a lucide `TriangleAlert` icon in a `tint-rose` circle next
  to the heading `"Archive Mobile App?"` ({Project} interpolated).
- Body explains the consequence: items preserved, project hidden, restorable.
- `Input label="Type PROD to confirm"` — the user types the project
  IDENTIFIER (not the name) to enable the action. The displayed confirm value
  uses `font-mono` (identifiers are mono throughout).
- `Modal.Footer`: `Button variant="ghost"` Cancel + `Button variant="danger"`
  "Archive project".
- **The danger button is disabled (opacity 50, pointer-events none) until the
  typed input matches the project identifier EXACTLY** (case-sensitive, e.g.
  `PROD`). Two states are drawn: disabled (input empty) and armed (matches).

---

## Copy strings catalog (use verbatim in 1.3.4)

A consolidated list for grep convenience. If the implementation diverges
from these strings, update both the implementation AND this list so the
mockup stays the source of truth. `{Project}` = project display name,
`{IDENT}` = project identifier (e.g. `PROD`).

| Surface                        | String                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create modal title             | `"Create project"`                                                                                                                                                         |
| Create modal name label        | `"Project name"`                                                                                                                                                           |
| Create modal name placeholder  | `"Mobile App"`                                                                                                                                                             |
| Create modal identifier label  | `"Identifier"`                                                                                                                                                             |
| Create modal identifier helper | `"3–5 uppercase characters. Work items will be keyed {IDENT}-1, {IDENT}-2, …"`                                                                                             |
| Create modal Cancel button     | `"Cancel"`                                                                                                                                                                 |
| Create modal Create button     | `"Create project"`                                                                                                                                                         |
| Empty state headline           | `"Create your first project"`                                                                                                                                              |
| Empty state description        | `"Projects group your work items and give them a key like {IDENT}-1. Create one to start planning."`                                                                       |
| Empty state CTA button         | `"Create project"`                                                                                                                                                         |
| Switcher trigger placeholder   | (no placeholder when a project is active — shows the active project name; shows `"No project"` muted only when the workspace has zero projects)                            |
| Switcher no-project label      | `"No project"`                                                                                                                                                             |
| Switcher heading               | `"PROJECTS"`                                                                                                                                                               |
| Switcher: Create project entry | `"Create project"`                                                                                                                                                         |
| Archive confirm title          | `"Archive {Project}?"`                                                                                                                                                     |
| Archive confirm body           | `"Archiving hides this project from the switcher and lists. Its work items and history are preserved — you can restore the project later. This does not delete any data."` |
| Archive confirm input label    | `"Type {IDENT} to confirm"`                                                                                                                                                |
| Archive confirm Cancel button  | `"Cancel"`                                                                                                                                                                 |
| Archive confirm Archive button | `"Archive project"`                                                                                                                                                        |

Note: the empty-state description and the create-modal helper both reference
the work-item key shape. Use the literal default identifier `PROD` in the
empty-state copy (there is no project yet, so no real identifier exists);
interpolate the real `{IDENT}` in the create-modal helper as the user types.

---

## Top-nav placement — the minimal 1.3 form

Per the minimal-then-expand discipline 1.2.1 recorded for the workspace
switcher, the project switcher lands in its minimal 1.3 form: a second
`Popover`-backed switcher in the existing `(authed)` top-nav, placed
immediately to the RIGHT of the workspace switcher and separated by a 1px
hairline rule (`workspace-left, project-immediately-right`). The top-nav
order is therefore: workspace switcher → hairline → project switcher (left
cluster), user-menu avatar (right).

**This is intentionally minimal.** Story 1.5's app-shell Subtask moves
project navigation into a left sidebar (Linear/Notion-style), at which point
the top-nav project switcher is retired or demoted. Building the sidebar now
would be premature — Story 1.3 only needs project create / switch / archive,
which the two-switcher top-nav serves without inventing the full shell. This
mirrors how 1.2.1 shipped the workspace switcher in the top-nav knowing 1.5
would re-home it.

---

## Brand-mark deferral confirmation

Per `PRODECT.md` "Brand-mark deferral principle": no placeholder wordmark
appears on any of these surfaces. The top-nav (empty-state and switcher
frames) has NO logo slot — only the workspace switcher + project switcher
(left) and the user-menu avatar (right), identical to the 1.2.1 top-nav.

---

## Theme parity

Pencil variables are wired for light + dark via `--background`,
`--foreground`, `--surface`, `--muted-foreground`, `--hairline`,
`--hairline-strong`, `--primary`, `--destructive`, `--tint-rose`, etc.,
mirroring `app/globals.css`. The exported PNGs are light-mode renders (the
default theme). Dark-mode parity should be verified manually during 1.3.4's
smoke test by toggling `data-theme="dark"` and visiting each surface.

The `archive-confirm.png` warning icon uses `$--destructive` (`#e03131`)
inside a `$--tint-rose` (`#fde0ec`) circle — the same treatment as
`delete-confirm.png`, both with dark-mode overrides in `app/globals.css`.

---

## Source of truth

When a string in this doc disagrees with shipped 1.3.4 code, the code wins —
file a fix here so the mockup stays the source of truth. The `.pen` is the
layout-confirmation artifact; it is not generated from code and may drift
from pixel-exact production once the React lands.

---

# Roles & permissions (Story 6.4) — Subtask 6.4.1 output

Story 6.4 makes access **project-level** (not just workspace-level). This
section is the canonical reference for the code subtasks it gates —
**6.4.5** (project-settings Members + Access UI) and **6.4.6** (UI gating:
hidden projects, no-access state, scoped pickers, role affordances), both of
which carry **6.4.1** in `dependsOn`.

Unlike the rest of `design/projects/` (drafted in Pencil), this surface is an
**HTML mockup** — `access-members.mock.html`, built FROM the real design
system (the `app/globals.css` token block copied 1:1 + the shipped
`components/ui/*` primitives), with `access-members.png` as the light-mode
board render. The HTML is the source of truth; toggle `data-theme="dark"` in
it to confirm token parity. A coding agent should prefer it — there is no
Pencil→code translation gap.

## Files

| HTML source (truth)        | PNG export           |
| -------------------------- | -------------------- |
| `access-members.mock.html` | `access-members.png` |

The mockup is a five-panel board (review EACH): **(0)** the populated
project-admin settings view (Access + Members); **(1)** the add-member
Combobox open + a per-row role select open; **(2)** the Access control with
Private selected + the go-private note; **(3)** the no-access state;
**(4)** the role affordances (viewer disabled-with-tooltip + non-admin
read-only).

## Mirror product (rung 1, VERIFIED June 2026 — Atlassian docs, not asserted)

Jira team-managed projects gate by an **Access level**:

- **Open** — any site (workspace) member can view **and edit**.
- **Limited** — any workspace member can view **and comment**, but only
  project members can edit.
- **Private** — only people explicitly added to the project (via a project
  role) can find or open it; hidden from everyone else.

Setting a project **private keeps the people who currently have access**
(Jira seeds them as members) rather than emptying it and locking the owner
out. Assignable users on a private project are scoped to **project members**.
We mirror this three-level team-managed model (the simpler, more direct fit
for Prodect's workspace→project shape).

**Migration defaults (no lockout):** existing projects default to **open** so
every current workspace member keeps access on deploy; **workspace
owner/admin always have access** regardless of project membership.

## Composing primitives (no new primitive required)

Every surface composes primitives already in `components/ui/` — nothing new:

- **`Card`** — the Access card and the Members card (header slot + body); the
  no-access panel is the `ErrorState`/`EmptyState` family (`Card` + lucide
  icon + serif headline + muted description + action `Button`s).
- **`Combobox`** — the **add-member** picker (trigger `+ Add a member…`,
  search field, option rows showing avatar + name + email, footer note
  "Members already on the project are hidden") **and** the per-row **role
  select** (`Admin` / `Member` / `Viewer`, each with a one-line description,
  selected row shows the `--el-accent` check). Both are the shipped Combobox
  trigger (`--height-control`, `--radius-input`, `ChevronsUpDown`) + elevated
  menu (`--shadow-elevated`, `--radius-card`).
- **`Pill`** — the role chip on the owner row + the read-only views
  (`Admin` → `--el-tint-lavender`, `Member` → `--el-tint-sky`, `Viewer` →
  `--el-tint-mint`, all with `--el-text-strong` text — AA-safe per finding
  #35), the member-count chip + the `Read-only` chip (`tone="neutral"`), and
  the access-level summary chip.
- **`Button`** — `primary` (Back to projects / disabled New issue),
  `secondary` (Request access), `ghost` (Remove).
- **`Tooltip`** — the disabled-affordance explainer (`--el-text` ink bg,
  `--el-text-inverted` text); a viewer's create/edit controls stay **visible
  but disabled** with this tooltip, never absent-and-confusing.
- The **Members row** extends the shipped workspace
  `MembersCard.tsx`: same avatar (ink `--el-text` circle + inverted initial,
  matching the shipped component — guaranteed AA) + name/email + trailing
  role chip grammar, with the per-project **role select** + **Remove** added.
  The owner row shows an `Admin` Pill + a disabled `Owner` affordance (the
  owner's role is not editable).

## The Access-level control

Three stacked radio cards (`open` / `limited` / `private`), each a tinted
icon tile + title + one-line explanation + a radio. Icons take their meaning's
hue via a pastel tint (`--el-tint-mint` globe = open, `--el-tint-sky` eye =
limited, `--el-tint-lavender` lock = private) with `--el-text-strong` glyphs.
The selected card carries the `--el-accent` border + filled radio. Selecting
**Private** reveals the **go-private note** (an `--el-tint-sky` info callout):
"the N people who can currently access this project will be added as members
so no one loses access" — the visible counterpart of 6.4.4's seeding.

## Gating affordances (6.4.6)

- **Hidden projects** — the switcher/nav omits projects the user can't browse
  (a private project they're not on is absent, not shown-then-denied).
- **No-access state** — a direct link to an inaccessible project's
  board/issues renders the ErrorState-family panel ("You don't have access to
  this project", lock icon, `Request access` + `Back to projects`), driven off
  the 6.4.3 `ProjectAccessDeniedError` — never a crash.
- **Scoped pickers** — assignee/reporter pickers list only **project members**
  on a private project (workspace members on open/limited).
- **Role affordances** — a viewer (or a member on a `limited` project) is gated
  by control TYPE (PM directive, 2026-06-09 — supersedes the earlier
  "everything disabled+tooltip" line; code is the reference per the footer):
  - **In-place controls stay visible-but-disabled, as a hint** — the **Create**
    button + the **`C` / ⌘K** shortcut, the **board** (drag disabled + a
    read-only banner), and the issue-detail **inline field pickers**
    (status / assignee / priority / …). Disabled, not removed, so the viewer
    sees _that_ the action exists and _that_ they lack rights.
  - **Navigation-to-an-edit-surface is HIDDEN, and the surface itself is
    blocked** — the issue-detail **"Edit"** link (header + per-section
    Description / Explanation edit links) and the relationships **add / remove**
    controls are **not rendered** for a read-only actor, and a direct nav to
    `/issues/[key]/edit` **redirects back to the read-only detail view** (a
    viewer has no reason to land on an edit form; the server rejects the save
    regardless). A hidden Edit button + a guarded edit route is the
    mirror-product (Jira) behaviour.
  - A non-admin sees Members + Access **read-only** (a `Read-only` chip + an
    info line "Only project admins can add members or change access").

## Tokens & a11y

Colour is `--el-*` only (no Tier-0 `--color-*`); shape is the element-semantic
tokens (`--radius-card/-input/-badge/-control/-btn`, `--spacing-card-padding`
/ `-control-*` / `-chip-*` / `-btn-x`, `--height-control/-btn-*`,
`--shadow-card/-elevated`) so the `data-display-style` swap reshapes it.
Coloured chips/tiles carry the hue in the **tint background** with
`--el-text-strong` text (AA-safe, finding #35); avatars are the ink circle
from the shipped `MembersCard`. `rounded-full` is used only for the avatar
and the radio dot.

## Source of truth

When a string here disagrees with shipped 6.4.5 / 6.4.6 code, the code wins —
file a fix so the mockup stays the reference. `access-members.mock.html` is
the layout-confirmation artifact; it may drift from pixel-exact production
once the React lands.
