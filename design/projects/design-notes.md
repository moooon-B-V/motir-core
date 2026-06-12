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

Per `MOTIR.md` "Brand-mark deferral principle": no placeholder wordmark
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
for Motir's workspace→project shape).

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

---

# Custom fields — Fields admin (Story 5.3) — Subtask 5.3.4 output

Story 5.3 adds per-project **custom field definitions** (Text / Number / Date /
Select / User) managed at **Project settings → Fields**. This section is the
canonical reference for code subtask **5.3.6** (the Fields admin UI), which
carries 5.3.4 in `dependsOn`. The companion rail surface (values on the issue
detail) is **5.3.5** → `design/work-items/custom-fields.mock.html`.

Like the 6.4.1 surface above, this is an **HTML mockup** —
`fields.mock.html`, built FROM the real design system (the `app/globals.css`
token block copied 1:1 + shipped `components/ui/*` primitives), with
`fields.png` as the light-mode board render. The HTML is the source of truth;
toggle `data-theme="dark"` in it to confirm token parity.

## Files

| HTML source (truth) | PNG export   |
| ------------------- | ------------ |
| `fields.mock.html`  | `fields.png` |

The mockup is a seven-panel board (review EACH): **(0)** the settings hub with
the new Fields card; **(1)** the populated project-admin field list; **(2)**
the empty state + the 50-field cap state; **(3)** the create-field modal with
the five-type picker (Select chosen → initial options); **(4)** the edit-field
modal — immutable type + the full options editor + the 55-option cap;
**(5)** the delete-field confirm naming the value count; **(6)** the non-admin
read-only state + loading skeleton + ErrorState.

## Mirror product (rung 1, VERIFIED June 2026 — Atlassian team-managed docs)

- **Five types**, each a verified member of Jira's team-managed set: Short
  text / Number / Date / Dropdown / People → our **Text / Number / Date /
  Select / User**. Team-managed Dropdown is **single-select only** (multi is
  the separate Checkbox type — a documented extension, not a cut).
- **Caps**: 50 fields per project, 55 options per field (the documented Jira
  limits). Both drawn: Add disabled + explanatory line, count pill `N / 50`.
- **Field delete is HARD** (no trash): immediate, permanent, destroys values —
  the confirm names the value count.
- **Options**: rename + reorder freely; an **in-use option archives** (hidden
  from new selection, existing values keep rendering); **delete only when
  unused** (the verified "Optimize" rule; the DB `Restrict` backstops).

## Composing primitives (no new primitive required)

- **`Card`** — the field-list card (header + flush body) and the hub cards.
  The **hub card** reuses the `MembersSettingsCard` grammar verbatim
  (`Card p-0` + whole-row `Link` + `ChevronRight`), placed **after Estimation,
  before Access & members** (field config groups with the issue-config cards;
  Archive stays last).
- **Field rows** — the members-row grammar (avatar slot → a **tinted type
  tile**) + the board-settings **grip** reorder grammar (3.6;
  keyboard-operable via the same dnd pattern). Label stacks over the gloss
  (`Type · option count · usage`; "not used yet" at zero). Row actions =
  ghost-sm `Edit` / `Delete`.
- **`Modal`** — create / edit (size md, ghost Cancel + primary confirm — the
  create-project grammar) and the delete confirm (the archive-confirm
  heading: `TriangleAlert` in a `--el-tint-rose` circle + `danger` confirm;
  **no typed-identifier arm step** — the value count is the consequence
  statement, fetched fresh when the confirm opens).
- **Type picker** — the 6.4.1 access radio-card grammar: tile + name +
  one-liner + radio; selected = `--el-accent` border + filled radio. The
  **type is immutable after create** (edit shows a frozen tile row + helper
  "The type can't be changed after the field is created").
- **Options editor** (select fields, inside create/edit) — option rows with
  grip / inline rename (`--el-accent` focus border + Save) / `Archive` ·
  `Unarchive` / `Delete`; in-use delete is **disabled with the Tooltip**
  ("In use on N issues — archive instead"); archived rows are muted +
  `Archived` neutral pill + "hidden from new selection", lose their grip, and
  sit last. Footer: ghost-sm `Add option` + the `N / 55` cap gloss.
- **`Pill`** — count chip (`pill-neutral`, `5 / 50`), `Archived`
  (`pill-neutral`), `Read-only` (the mint chip, the 6.4 grammar).
- **`EmptyState` / `ErrorState`** — "No custom fields yet" (lucide
  `SlidersHorizontal`) and "Couldn't load fields" + Retry; the loading
  skeleton extends the settings skeleton.

## The per-type glyph map (SHARED with 5.3.5 — keep the two surfaces in sync)

| Type   | lucide glyph        | tile tint            |
| ------ | ------------------- | -------------------- |
| Text   | `Type`              | `--el-tint-sky`      |
| Number | `Hash`              | `--el-tint-peach`    |
| Date   | `Calendar`          | `--el-tint-mint`     |
| Select | `SquareChevronDown` | `--el-tint-lavender` |
| User   | `CircleUserRound`   | `--el-tint-rose`     |

Glyphs render in `--el-text-strong` on the tint background (AA-safe, finding
#35; palette beyond grey+primary, finding #54). On the rail (5.3.5) the same
glyph map applies; the tile is the admin-page presentation.

## Copy strings catalog (use verbatim in 5.3.6; i18n under `settings.customFields`)

| Surface               | String                                                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub card title        | `"Fields"`                                                                                                                                                                              |
| Hub card description  | `"Custom fields that issues in this project can carry — like severity, customer, or a go-live date."`                                                                                   |
| Page title            | `"Fields"`                                                                                                                                                                              |
| Page subtitle         | `"Custom fields that issues in {projectName} can carry, alongside the built-in ones. Fields belong to this project only."`                                                              |
| List card title       | `"Custom fields"` (+ count pill `"{n} / 50"`)                                                                                                                                           |
| Add button            | `"Add field"`                                                                                                                                                                           |
| Usage gloss           | `"used on {n} issues"` / `"not used yet"`                                                                                                                                               |
| Empty headline        | `"No custom fields yet"`                                                                                                                                                                |
| Empty description     | `"Custom fields capture project-specific details — like severity, customer, or a go-live date — on every issue in this project."`                                                       |
| Field-cap tooltip     | `"This project has reached the 50-field limit"`                                                                                                                                         |
| Field-cap info line   | `"A project can hold up to 50 custom fields. Delete a field to add another."`                                                                                                           |
| Create modal title    | `"Create field"`                                                                                                                                                                        |
| Label field           | `"Label"` + helper `"Shown on issues and in filters."`                                                                                                                                  |
| Type section          | `"Type"` + helper `"The type can't be changed after the field is created."`                                                                                                             |
| Type one-liners       | Text `"A short line of text."` · Number `"A numeric value."` · Date `"A calendar date."` · Select `"One option from a list you manage."` · User `"A person who can view this project."` |
| Description field     | `"Description (optional)"` + placeholder `"What this field is for…"`                                                                                                                    |
| Create / save buttons | `"Create field"` / `"Save changes"` / `"Cancel"`                                                                                                                                        |
| Edit modal title      | `"Edit field"`                                                                                                                                                                          |
| Options section       | `"Options"` · `"Add option"` · cap gloss `"{n} / 55"` / `"55 / 55 — a field can hold up to 55 options"`                                                                                 |
| Option archive states | `"Archive"` / `"Unarchive"` · pill `"Archived"` · gloss `"hidden from new selection"` · `"used on {n} issues"`                                                                          |
| In-use delete tooltip | `"In use on {n} issues — archive instead"`                                                                                                                                              |
| Delete confirm title  | `"Delete {Field}?"`                                                                                                                                                                     |
| Delete confirm body   | `"Deletes the field and its values on {n} issues. This can't be undone."` (zero values: `"Deletes the field. No issues hold a value for it."`)                                          |
| Delete confirm button | `"Delete field"`                                                                                                                                                                        |
| Read-only chip + line | `"Read-only"` · `"Only project admins can manage fields."`                                                                                                                              |
| Error state           | `"Couldn't load fields"` · `"Something went wrong on our side. Try again."` · `"Retry"`                                                                                                 |

## Read-only degradation (differs from the viewer's board — deliberately)

A non-admin sees the list with the mutation affordances **absent** (no Add
field, no grips, no Edit/Delete) + the `Read-only` pill + the quiet permission
line — the 6.4 members-page degradation. Unlike the viewer's board (where
disabled-with-tooltip keeps the gate legible), every control on this page IS a
mutation, so hiding is the right shape. Reads stay open to members/viewers —
the rail needs the definitions.

## Deliberate non-features (the documented extension slots — do NOT build)

- No **required** flag, no **work-type layouts**, no **create-form
  placement** — the layout-config admin subsystem is 6.5's settings-hub
  extension; values are editable the moment an issue exists via the rail.
- No further types (paragraph / checkbox-multi / labels / multi-person /
  formula) — additive on the same EAV substrate, out of 5.3's scope.
- The **key** (machine slug) is generated from the label and immutable; it is
  deliberately NOT shown in this UI (an internal handle for revision diffs +
  Epic-6 predicates, not an admin concern).

## Tokens & a11y

Colour is `--el-*` only; shape via the element shape tokens
(`--radius-card/-modal/-input/-btn/-control/-badge`,
`--spacing-card-padding/-btn-x/-input-x/-chip-*/-tooltip-*`,
`--height-btn-sm/-btn-md/-input`, `--shadow-card/-elevated/-modal`).
Reorder must be keyboard-operable (the board-settings dnd precedent); the
delete confirm is focus-managed; tooltips on disabled controls need a
focusable wrapper. `rounded-full` only on the radio dot. Dark parity verified
by toggle.

## Source of truth

When a string here disagrees with shipped 5.3.6 code, the code wins — file a
fix so the mockup stays the reference. `fields.mock.html` is the
layout-confirmation artifact; it may drift from pixel-exact production once
the React lands.

---

# Components admin (Story 5.4) — Subtask 5.4.7 output

Story 5.4 adds an admin-managed **component** taxonomy (name + description +
default assignee, multi-valued per issue) managed at **Project settings →
Components**. This section is the canonical reference for code subtask
**5.4.10** (the Components admin UI), which carries 5.4.7 in `dependsOn`. The
companion issue-view surface (the Components rail card + chip picker) is
**5.4.6** → `design/work-items/labels-components-watch.mock.html`.

Like the 6.4.1 and 5.3.4 surfaces above, this is an **HTML mockup** —
`components.mock.html`, built FROM the real design system (the
`app/globals.css` token block copied 1:1 + shipped `components/ui/*`
primitives), with `components.png` as the light-mode board render. The HTML is
the source of truth; toggle `data-theme="dark"` in it to confirm token parity.

## Files

| HTML source (truth)    | PNG export       |
| ---------------------- | ---------------- |
| `components.mock.html` | `components.png` |

The mockup is an eight-panel board (review EACH): **(0)** the settings hub
with the new Components card; **(1)** the populated project-admin list;
**(2)** the empty state (+ the 5.4.6 cross-reference); **(3)** the create
modal with the default-assignee picker OPEN; **(4)** the edit modal + the
case-insensitive-unique inline 422; **(5)** the in-use delete dialog — the
move-or-remove choice, BOTH branches; **(6)** the unused delete confirm;
**(7)** the non-admin read-only state + loading skeleton + ErrorState.

## Mirror product (rung 1, VERIFIED at plan time 2026-06-10 — Atlassian docs)

**Company-managed Jira** is the shape mirror (team-managed gets Compass
components — a different product seam):

- `name` (required, **case-insensitively unique** per project — the 5.4.1
  `nameLower` unique), `description?`, `defaultAssigneeId?`; issues carry
  **multiple components**.
- **Default assignee (the verified rule):** an issue CREATED with components
  and no assignee takes the default assignee of its **first-alphabetical**
  component that has one — create-time only; later component edits never touch
  the assignee. The helper line under the picker states this.
- **Delete with issues = the verified move-or-remove choice:** move every
  association to another component, or just remove it — the work items
  themselves are untouched either way. Unused components confirm simply.

**Recorded simplification:** Jira's five-way default-assignee enum (project
default / project lead / component lead / unassigned / person) collapses to a
**nullable user** — Motir has no project-lead concept, and component _lead_
exists in Jira chiefly to feed that enum. Component lead = the documented
extension.

## Composing primitives (no new primitive required)

- **`Card`** — the component-list card (header + flush body) and the hub
  cards. The **hub card** reuses the `MembersSettingsCard` grammar verbatim
  (`Card p-0` + whole-row `Link` + `ChevronRight`), placed **after Fields**
  (the in-flight 5.3.6 card; both sit between Estimation and Access & members
  — the issue-config group; Archive stays last).
- **Component rows** — the members-row grammar with the avatar slot holding a
  **neutral component tile** (lucide `component` glyph in
  `--el-text-secondary` on `--el-surface`, `--radius-control`) — matching
  5.4.6's recorded decision that components stay NEUTRAL so the labels'
  name-hash tints read as meaningful (the two surfaces share one identity;
  finding #54 is satisfied by avatars + state grammars, not an invented
  component hue). Row = tile · name · description gloss (truncating) ·
  **default-assignee cluster** (28px ink avatar + name + the 11px "Default
  assignee" sublabel; a dashed empty avatar + muted "None" when unset) ·
  usage (`N issues` / `not used yet`) · ghost-sm `Edit` / `Delete`. **NO
  grip** — components are name-ordered (`listComponents` sorts by name), never
  manually reordered (unlike fields). The count pill is a plain count (no cap
  — the mirror has none; the read is bounded server-side).
- **`Modal`** — create / edit (size md, ghost Cancel + primary confirm — the
  create-project grammar) and the delete dialog (the archive-confirm heading:
  `TriangleAlert` in a `--el-tint-rose` circle + `danger` confirm; no
  typed-identifier arm step — the live count is the consequence statement,
  fetched when the dialog opens).
- **Default-assignee picker** — the 6.4.1 add-member **`Combobox`** grammar
  (trigger `--height-control`/`--radius-input` + elevated menu + avatar option
  rows + search), scoped via `assignableMembersService` ("Only people who can
  view this project are listed."), with an explicit **"None"** row (dashed
  empty avatar, gloss "No automatic assignment") so clearing the default is a
  first-class choice. The trigger shows the chosen member's 22px avatar +
  name, or muted "None".
- **Move-or-remove choice** — the 6.4.1 access **radio-card** grammar: two
  stacked cards (title + one-line consequence + radio; selected =
  `--el-accent` border + filled radio). The MOVE card embeds a component
  `Combobox` (component glyph + name) **excluding the component being
  deleted**; the picker collapses while the card is unselected.
- **`Pill`** — the count chip (`pill-neutral`) + `Read-only` (the mint chip,
  the 6.4 grammar).
- **`Input`** — name (helper "Unique within this project."), description; the
  unique-collision 422 uses the Input **error grammar** (`--el-danger` border
  - message) and names the EXISTING casing.
- **`EmptyState` / `ErrorState`** — "No components yet" (lucide `Component`
  icon) and "Couldn't load components" + Retry; the loading skeleton extends
  the settings skeleton.

## Copy strings catalog (use verbatim in 5.4.10; i18n under `settings.components`)

| Surface                   | String                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub card title            | `"Components"`                                                                                                                                                      |
| Hub card description      | `"The parts of the product issues belong to — like API, Web, or Billing — each with an optional default assignee."`                                                 |
| Page title                | `"Components"`                                                                                                                                                      |
| Page subtitle             | `"The parts of {projectName} that issues can belong to. An issue can carry several components; components belong to this project only."`                            |
| List card title           | `"Components"` (+ a plain count pill)                                                                                                                               |
| Add button                | `"Add component"`                                                                                                                                                   |
| Default-assignee sublabel | `"Default assignee"` (+ muted `"None"` when unset)                                                                                                                  |
| Usage gloss               | `"{n} issues"` / `"not used yet"`                                                                                                                                   |
| Empty headline            | `"No components yet"`                                                                                                                                               |
| Empty description         | `"Components group issues by part of the product — like API, Web, or Billing. New issues created with a component can pick up its default assignee automatically."` |
| Create modal title        | `"Create component"`                                                                                                                                                |
| Name field                | `"Name"` + helper `"Unique within this project."`                                                                                                                   |
| Description field         | `"Description (optional)"` + placeholder `"What part of the product this covers…"`                                                                                  |
| Default-assignee field    | `"Default assignee"` + helper `"New issues created with this component and no assignee are assigned to this person. Existing issues are never changed."`            |
| Picker None row           | `"None"` + gloss `"No automatic assignment"`                                                                                                                        |
| Picker scope note         | `"Only people who can view this project are listed."`                                                                                                               |
| Unique-name 422           | `"A component named “{Existing}” already exists in this project."`                                                                                                  |
| Create / save buttons     | `"Create component"` / `"Save changes"` / `"Cancel"`                                                                                                                |
| Edit modal title          | `"Edit component"`                                                                                                                                                  |
| Delete confirm title      | `"Delete {Component}?"`                                                                                                                                             |
| Delete in-use body        | `"{Component} is on {n} work items. Choose what happens to them — the work items themselves are untouched."`                                                        |
| Move choice               | `"Move {n} work items to…"` + gloss `"Their {Component} association is replaced. Items already carrying the target keep one."`                                      |
| Remove choice             | `"Remove the component from {n} work items"` + gloss `"They keep their other components."`                                                                          |
| Delete unused body        | `"No work items carry this component. This removes it from the project."`                                                                                           |
| Delete confirm button     | `"Delete component"`                                                                                                                                                |
| Read-only chip + line     | `"Read-only"` · `"Only project admins can manage components."`                                                                                                      |
| Error state               | `"Couldn't load components"` · `"Something went wrong on our side. Try again."` · `"Retry"`                                                                         |

## Read-only degradation (the 6.4 / 5.3 shape)

A non-admin sees the list with the mutation affordances **absent** (no Add
component, no Edit/Delete) + the `Read-only` pill + the quiet permission line
— the members-page / fields-page degradation: every control on this page IS a
mutation, so hiding is the right shape. Reads stay open to members/viewers —
the issue-view rail picker needs the component list.

## Deliberate non-features (the documented extension slots — do NOT build)

- **Component lead** + Jira's five-way default-assignee enum — the nullable
  user covers the use case (no project-lead concept; recorded simplification).
- **No manual reorder** — components are name-ordered, matching the mirror.
- **No per-project component cap** — the mirror has none; the admin read is
  bounded server-side (finding #57 honoured without inventing a limit).

## Tokens & a11y

Colour is `--el-*` only; shape via the element shape tokens
(`--radius-card/-modal/-input/-btn/-control/-badge`,
`--spacing-card-padding/-btn-x/-input-x/-control-*/-chip-*`,
`--height-btn-sm/-btn-md/-input/-control`, `--shadow-card/-elevated/-modal`).
The move-or-remove dialog is focus-managed with the radio group labelled; the
default-assignee picker is the shipped Combobox a11y bar; the dashed "None"
avatar conveys absence with text ("None"), never colour alone. `rounded-full`
only on avatars and radio dots. Dark parity verified by toggle.

## Source of truth

When a string here disagrees with shipped 5.4.10 code, the code wins — file a
fix so the mockup stays the reference. `components.mock.html` is the
layout-confirmation artifact; it may drift from pixel-exact production once
the React lands.

---

# Project settings AREA (Story 6.5) — Subtask 6.5.1 output

Story 6.5 turns the flat **card hub** at `/settings/project` into the
Jira-shaped project-settings **AREA**: ONE chrome wrapping every per-project
admin page behind a grouped settings navigation, **landing on a read-only
Details page**. It is a **composition** story — every section already exists
(Workflow 2.2.5, Boards 3.6/3.7, Estimation 4.3.5, Members & access 6.4.5,
Fields 5.3.6, Components 5.4.10); 6.5 ships the **area shell**, the
**settings-nav registry**, and the **Details landing**. It re-houses; it does
not rebuild.

This section is the canonical reference for the UI code subtasks **6.5.2**
(settings-nav registry + area `layout.tsx`) and **6.5.3** (the Details
landing) — both carry 6.5.1 in `dependsOn` and seed `'blocked'`. Like the
6.4.1 / 5.3.4 / 5.4.7 surfaces above, the asset is an **HTML mockup** —
`settings-area.mock.html`, built FROM the real design system (the
`app/globals.css` token block copied 1:1 — incl. the `--el-sidebar-*` shell
tokens — + shipped `components/ui/*` primitives), with `settings-area.png` as
the light-mode render. The HTML is the source of truth; toggle
`data-theme="dark"` in it to confirm token parity.

## Files

| HTML source (truth)       | PNG export          |
| ------------------------- | ------------------- |
| `settings-area.mock.html` | `settings-area.png` |

The mockup is a five-panel board (review EACH): **(0)** THE AREA — entry +
chrome + the Details landing (rail = grouped settings nav with the
project-identity header + back-to-project; content = Details, read-only
identity + Archive danger zone), the hero panel; **(1)** the grouped nav
close-up + the nav-entry ↔ registry mapping table (incl. the Automation
slot); **(2)** a re-housed page (Workflow exemplar) inside the area chrome;
**(3)** role states — the non-admin member view + the 6.4.4 no-access state;
**(4)** narrow viewport (the nav collapses to a "Settings menu" disclosure +
sheet) + the no-active-project empty state.

## Entry + chrome decision — the area REPLACES the project nav in the SAME rail

The load-bearing layout decision (the card called for "pick one and draw
it"): entering settings **swaps the app-shell rail's project-nav sections**
(Dashboard / Issues / Ready / Boards / Backlog / Reports) **for the grouped
settings nav**, and swaps the rail header (the `ProjectSwitcher`) for a **"←
Back to {project}"** link + a static **project-identity block** (avatar +
name + key). It does **NOT** nest a second rail beside the app rail.

- **Why replace, not nest (rung 1).** Jira's verified team-managed shape is
  exactly this: opening project settings turns the left sidebar INTO the
  settings nav, with a way back to the project. One rail, no double chrome.
  Nesting a second rail would burn horizontal space and invent a
  two-sidebar pattern the app does not otherwise have — complexity for
  nothing.
- **Primitive reuse.** The rail stays the shipped `Sidebar`
  (`components/ui/Sidebar.tsx`): groups are `SidebarSection`s with a
  `label` (the `SectionLabel` caption), rows are `SidebarNavItem`s (the
  inset active treatment — `--el-sidebar-item-bg-active` +
  `--el-sidebar-border` + `--shadow-subtle` + accent icon — and
  `aria-current="page"`). 6.5.2 renders the rail from the **registry**, not a
  hand-kept list. The "Back to {project}" + identity block sit in the
  Sidebar `header` slot (replacing the `SidebarHeader`/`ProjectSwitcher` while
  in the area).
- **Landing rule.** `/settings/project` **IS** the Details page (6.5.3) — it
  is no longer a hub. Entering settings from the app sidebar lands here with
  the `Details` nav entry active.

## The settings-nav registry (the 6.5.2 contract)

One typed entry per project-settings page drives the nav, the
command-palette deep links, AND the totality test:

```ts
{
  (id, group, href, icon, labelKey, access);
}
```

| Group · entry                 | `href` (route preserved)       | icon (lucide)       |
| ----------------------------- | ------------------------------ | ------------------- |
| **General** · Details         | `/settings/project`            | `SlidersHorizontal` |
| **Access** · Members & access | `/settings/project/members`    | `Users`             |
| **Work** · Workflow           | `/settings/project/workflow`   | `Workflow`          |
| **Work** · Boards             | `/settings/project/board`      | `Columns3`          |
| **Work** · Estimation         | `/settings/project/estimation` | `Gauge`             |
| **Work** · Fields             | `/settings/project/fields`     | `Tag`               |
| **Work** · Components         | `/settings/project/components` | `Box`               |
| **Automation** · Rules        | _reserved_ (6.6)               | `Bot`               |

- **Routes are preserved** — every existing settings URL resolves unchanged
  inside the chrome (zero deep-link breakage, no redirects). Only the landing
  moves (`/settings/project` → Details) and the per-page back-crumbs drop.
- **`icon`** uses the named lucide glyphs above (the `Columns3` boards glyph
  matches the app-nav Boards icon — keep them in sync; `Workflow` is the
  three-box connected glyph, NOT `GitBranch`).
- **`access`** rides the **shipped 6.4.3 policy** (`lib/projects/access.ts`
  - `projectAccessService`) — never a second role check. Admin manages;
    member sees the page's shipped read-only state; a role without browse
    access sees **neither the nav entry nor the page** (the 6.4.4 no-access
    state on direct nav).
- **Totality (mistake #29).** A unit test enumerates
  `app/(authed)/settings/project/**/page.tsx` and fails unless each route has
  **exactly one** registry entry (and vice versa) — drift is a red suite, not
  a silent gap. The reserved Automation slot is NOT a route entry until 6.6
  ships its page; it renders as a disabled "Soon" row, excluded from the
  route↔entry assertion.

## Groups & the Automation slot

Four groups, in rail order: **General** (Details), **Access** (Members &
access), **Work** (Workflow, Boards, Estimation, Fields, Components),
**Automation** (the 6.6 slot). The Automation **Rules** row is drawn as a
**designed-for "Soon" entry** — present (so the area's shape is legible from
day one) but disabled, with a `--el-tint-yellow` "Soon" chip and
`--el-text-faint` ink; it is NOT a registry route entry until Story 6.6 adds
its page. This is the "draw the slot, don't build the page" convention.

## Composing primitives (no new primitive required)

- **`Sidebar` / `SidebarNav` vocabulary** — the rail: grouped sections, the
  inset active row, the hover lift (`--el-sidebar-item-bg-hover`), the
  back-link + identity header in the `header` slot. Icons at 18px in
  `--el-text-muted` (active → `--el-accent`).
- **The serif page-title grammar** — KEPT from every shipped settings page
  (`<h1 class="font-serif text-3xl">` + the muted `text-sm` sub). Re-housed
  pages keep their `<header>` exactly; only the back-crumb is removed.
- **`Card`** — the Details **Project details** card (identity rows) and the
  **Danger zone** card (the re-homed `ArchiveProjectCard` — `border-2
border-(--el-danger)`, the `Archive…` `danger` Button + its modal, UNCHANGED
  — a move, not a rebuild).
- **Identity rows** — label-and-value rows (a 132px muted label with a 15px
  lucide glyph + the value); the Key value is mono; the Avatar row holds a
  40px project tile (issue-type-task hue square, `--radius-control`). A quiet
  `--el-surface` **seam note** states "editing arrives with project-details
  editing" — the 6.8 seam (6.8 swaps these rows for edit forms + the
  key-change flow; **no edit affordances are improvised here**).
- **`Pill`** — the `Admin` chip (lavender tint, the 6.4 role grammar) and the
  member view's `Read-only` chip (mint tint, `--el-text-strong` — AA per
  finding #35).
- **`Button`** — `danger` (Archive…), `ghost`/`primary` (the no-access
  actions).
- **`EmptyState`** — the no-active-project state (kept from the hub; the
  route still resolves, no 404; the create CTA lives on the dashboard).
- **`ErrorState` family** — the 6.4.4 no-access panel, **referenced verbatim**
  (off `ProjectAccessDeniedError`), not redrawn here.
- **Command palette** — `AppCommandPalette` grows **per-section** entries
  generated FROM the registry (replacing today's single "Go to settings"
  action); each deep-links to its `href`.

## Role states

- **Member (non-admin)** — the SAME grouped nav (members can VIEW every
  section); each re-housed page renders its **shipped read-only state** (the
  5.4 / 6.4 degradation grammar); the **Details page shows NO danger zone** —
  archive is admin-gated (the 1.3.4 rule), so the member sees identity rows +
  a `Read-only` pill, no Archive.
- **No browse access** — a non-member who follows a direct
  `/settings/project*` link to a private project hits the **6.4.4
  ErrorState** ("You don't have access to this project" + Request access /
  Back to projects). The nav never leaks — the registry's `access` predicate
  filters the whole area away.

## Narrow viewport + empty state

- **Mobile (< md).** The rail collapses to a **"Settings menu" disclosure**
  in a top bar showing the current section; tapping opens the grouped nav
  **inline as a sheet** (same groups, same active state) — reachable, not
  clipped. (Parallels the app shell's `SidebarDrawer`.)
- **No active project.** Kept from the retiring hub: the `EmptyState`
  ("No project selected") renders on the route so it never 404s.

## Copy strings catalog (use verbatim in 6.5.2 / 6.5.3; i18n under `settings`)

| Surface                      | String                                                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rail back link               | `"Back to {projectName}"`                                                                                                                                                                                                    |
| Rail eyebrow                 | `"Project settings"`                                                                                                                                                                                                         |
| Group labels                 | `"General"` · `"Access"` · `"Work"` · `"Automation"`                                                                                                                                                                         |
| Nav entries                  | `"Details"` · `"Members & access"` · `"Workflow"` · `"Boards"` · `"Estimation"` · `"Fields"` · `"Components"` · `"Rules"`                                                                                                    |
| Automation slot chip         | `"Soon"`                                                                                                                                                                                                                     |
| Details page title           | `"Details"`                                                                                                                                                                                                                  |
| Details page subtitle        | `"Project name, key and avatar. Workspace owners and admins can edit these — editing arrives with project-details editing."`                                                                                                 |
| Details card title           | `"Project details"`                                                                                                                                                                                                          |
| Identity row labels          | `"Avatar"` · `"Name"` · `"Key"` · `"Workspace"` · `"Created"`                                                                                                                                                                |
| 6.8 seam note                | `"Editing name, key and avatar — plus changing the project key with old-key redirects — arrives with project-details editing. For now these are read-only."`                                                                 |
| Danger zone heading          | `"Danger zone"` (the shipped `settings.danger.heading`)                                                                                                                                                                      |
| Archive row                  | `"Archive this project"` · `"Hide {projectName} from the project list and stop new work. You can restore it later."` · `"Archive…"` (shipped `settings.archive.*`)                                                           |
| Member read-only chip + line | `"Read-only"` · `"Only project admins can manage project settings."`                                                                                                                                                         |
| No-access state              | `"You don't have access to this project"` · `"{projectName} is a private project. Ask a project admin to add you, or pick another project to keep working."` · `"Request access"` · `"Back to projects"` (the 6.4.1 strings) |
| No-active-project empty      | `"No project selected"` · `"Choose a project from the switcher, or create one from the dashboard, to manage its settings."`                                                                                                  |
| Mobile disclosure            | `"{currentSection}"` (the active entry's label)                                                                                                                                                                              |

Details / Archive strings that already ship (`settings.project.*`,
`settings.danger.*`, `settings.archive.*`) are **reused** — 6.5.3 keeps the
existing keys; only the page LAYOUT changes (hub → Details landing).

## Recorded deviations from the mirror (justified — no complexity for nothing)

Verified against the Atlassian project-settings-sidebar + team-managed docs
at plan time (2026-06-10):

- **No Features toggle page** — Jira's kanban-vs-scrum / feature-flags axis is
  owned in Motir by board **TYPE** (3.7 multi-board CRUD + 4.5 Scrum board); a
  per-project toggle would duplicate it.
- **No project-level Notifications admin** — notification preferences are
  **per-USER** in Motir's event-driven model (the 5.7 surface); an
  admin-owned scheme has no stated use case.
- **No Apps page** — no marketplace.
- **No settings search box** — Jira ships one at site-admin scale; ~8 bounded
  entries do not earn it (finding #57: the nav is bounded, not a scale
  surface).

## Extension slots (reserved — do NOT build here)

- **Automation rules** — Story 6.6 (the reserved Automation slot; mounts by
  adding a registry entry).
- **Details editing + project-key change with old-key redirects** — Story
  6.8 (grows the 6.5.3 Details page; keep the seam aligned with its
  description).
- **Per-work-type field layouts** — the 5.3 documented extension; the
  registry reserves a slot, it is NOT an entry here.

## Tokens & a11y

Colour is `--el-*` only (incl. the `--el-sidebar-*` shell tokens + the
`--el-type-task` project tile + the `--el-tint-*` pill/chip backgrounds —
finding #54: not grey + primary alone); shape via the element shape tokens
(`--radius-card/-input/-btn/-control/-badge/-modal`,
`--spacing-card-padding/-control-*/-chip-*/-btn-x`,
`--height-control/-btn-md`, `--shadow-subtle/-card`). The settings nav is a
labelled `navigation` landmark with `aria-current="page"` on the active row
and is fully keyboard-operable; the "Soon" row is `aria-disabled` and conveys
its state with the chip text, not colour alone; `rounded-full` only on the
avatar dots. AA holds on every tint chip (hue in the background,
`--el-text-strong` text). Dark parity verified by toggle.

## Source of truth

When a string here disagrees with shipped 6.5.2 / 6.5.3 code, the code wins —
file a fix so the mockup stays the reference. `settings-area.mock.html` is the
layout-confirmation artifact; it may drift from pixel-exact production once
the React lands.

---

# Automation rules (Story 6.6) — Subtask 6.6.4 output

The design asset for the whole **project automation** surface — the when/then
rule engine's authoring + observability UI. Nothing under `design/` covered
automation (the design-gate NONE-exists case: `projects/` held only
Members/Access + Fields + Components + the 6.5 settings area), so this asset is
the prerequisite that **gates the UI code subtasks 6.6.5** (rule list +
when/if/then editor) **and 6.6.6** (audit-log UI + last-run + auto-disabled
banner) — both carry 6.6.4 in `dependsOn` and seed `'blocked'` (Principle #13).

## Files

- `design/projects/automation.mock.html` — the source of truth (8 panels;
  toggle dark to confirm token parity).
- `design/projects/automation.png` — light full-page export for the board.
- This section.

## Mirror product (rung 1, VERIFIED at plan time 2026-06-10 — Atlassian docs)

Jira's automation **rule builder**: a rule = **trigger → conditions →
actions**, one trigger per rule, shown as a three-block editor ("When / If /
Then"); a per-rule **audit log** (success / failure / no-actions, per-step
detail, 90-day retention); rules run **as a configurable actor**;
**auto-disable** at 10 consecutive failures. Adopted 1:1 in shape. The Story
6.6 description records the verified core sets + the deviations (rule runs as
the **owner**, not a synthetic app user; loop prevention is the Jira default
only). This asset draws exactly that surface — it invents no rule-engine UI
beyond the verified anatomy.

## Entry + chrome — mounts INSIDE the 6.5 settings area (no second frame)

The surface is **one page in the 6.5 settings AREA**, not a new shell. It
mounts in the **reserved "Automation › Rules" nav slot** Story 6.5 drew as a
disabled "Soon" entry (`settings-area.mock.html` panel 1 / "Groups & the
Automation slot"). 6.6.4 **lights that slot up**: the row becomes an active
route entry (`aria-current="page"`, the inset treatment, accent icon), the
`Soon` chip drops. The rail, the back-to-project header, the serif page-title
grammar, and the `Card` are the 6.5 chrome verbatim — this asset designs the
**page bodies inside** it (the list, the editor, the audit log), never a frame.

## The settings-nav registry entry (extends the 6.5.2 contract)

The 6.5.2 registry reserved the slot without a route; 6.6.5 fills it with a
real entry, and the route↔entry totality test now includes it:

| Group · entry          | `href`                         | icon (lucide) |
| ---------------------- | ------------------------------ | ------------- |
| **Automation** · Rules | `/settings/project/automation` | `Bot`         |

`access` rides the **shipped 6.4.3 admin predicate** (`projectAccessService`,
the `manage-project` permission) — never a second role check. Automation is
**admin-only** end to end: the nav entry, the page, and every route 403/404 for
non-admins (no member/viewer read-only variant — unlike Fields/Components,
there is no useful read-only automation view, matching Jira).

## The editor-kind ↔ registry mapping (the 6.6.1 / 6.6.3 UI contract)

The editor is **registry-driven** — the trigger picker, its per-kind config
editor, the action picker, and its per-action config editor are ALL rendered
FROM the 6.6.1 + 6.6.3 registries (the 6.1.4 "rows render from the registry"
pattern; a new entry appears with zero editor changes, asserted in 6.6.5 with a
test-only entry). The editor NEVER hard-codes a trigger/action/field list.

**Triggers (the "When" block — one per rule):**

| Trigger (registry id) | Config editor kind                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `created`             | none ("No further configuration")                                                              |
| `transitioned`        | optional **from → to** status `Combobox`s (the 6.6.1 status-id narrowing)                      |
| `field-changed`       | built-in / CF **field picker** `Combobox`; **Assignee** surfaced first (the "assigned" preset) |
| `commented` (6.6.3)   | none                                                                                           |

**Actions (the "Then" block — ordered, max 10):**

| Action (registry id)       | Config editor kind                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `transition`               | status-target `Combobox`                                                                                                                      |
| `set-field` (built-ins)    | field `Combobox` + value editor per built-in: assignee (member) / priority (option) / due date (`DatePicker`) / story points (number `Input`) |
| `set-field` (custom 6.6.3) | field `Combobox` + value editor per 5.3 CF type: select (option) / user (member) / number / date / text                                       |
| `add-watcher` (6.6.3)      | member `MultiSelectPicker`                                                                                                                    |
| `add-comment` (6.6.3)      | body `Input`                                                                                                                                  |
| `add-label` (6.6.3)        | type-to-create `MultiSelectPicker` (the 5.4.2 find-or-create semantics)                                                                       |

**Conditions (the "If" block) — REUSE 6.1.3, do not fork.** The condition group
is the **6.1.3 filter-builder `.cond` row verbatim** (field `Combobox` ·
operator `Combobox` · value editor · remove ×) under the **Match all / any**
`Segmented` combinator, with the 6.1 **20-row cap** and the
`.chip.stale` stale-referent treatment + `role="status"` row notice. 6.6.5
reuses the **6.1.4 condition-row components** scoped to the rule editor — there
is exactly **one predicate UI in the product**. Empty group = "always".

## Composing primitives (no new primitive required)

- **The 6.5 settings-area chrome** — rail (`Sidebar`), serif page title, `Card`
  — verbatim; Automation is a page inside it.
- **The 6.1.3 condition rows** — `.cond` grid, `Segmented` combinator,
  `MultiSelectPicker` box, `.chip` / `.chip.tinted` / `.chip.stale`, the
  `addrow` add button, the cap + `stale-note` states — verbatim.
- **`Combobox`** — every trigger / action / field / operator / status target
  picker (the `.cb` trigger + the `.menu` listbox, the field-picker shown open
  with the Assignee preset + grouped built-in / custom sections).
- **`MultiSelectPicker`** — member (watcher / assignee), enum (kind / status /
  priority), and type-to-create (label) value editors.
- **`Input` / `DatePicker`** — comment body, number values, due date.
- **`Switch`** — the per-rule enable toggle (list rows + editor header),
  optimistic.
- **`Pill`** — the trigger summary chip on list rows, and the audit-log status
  pills: **Success** (mint, `check-circle`) · **Failure** (rose, `alert-
triangle`) · **No actions** (neutral, `minus-circle`) — AA per finding #35
  (hue in the tint bg, `--el-text-strong` text).
- **`Button`** — `primary` (Create rule / Save), `ghost` (Cancel / Re-enable),
  `danger` (Delete in the overflow).
- **`Avatar`** — the rule owner on list rows.
- **`EmptyState`** — "No rules yet" (list) and "No runs yet" (audit log).
- **Icon-button overflow menu** — Edit · Disable · Delete · View log per rule.
- **The drag `grip`** — keyboard-operable action reorder (↑/↓ when focused).

## The last-run glyph vocabulary (list + audit log share it)

| State         | glyph            | colour            | copy                          |
| ------------- | ---------------- | ----------------- | ----------------------------- |
| Success       | `check-circle`   | `--el-success`    | "Ran {time} ago"              |
| Failure       | `alert-triangle` | `--el-danger`     | "Failed · {time} ago"         |
| No actions    | `minus-circle`   | `--el-text-faint` | "No actions · {time} ago"     |
| Never run     | — (text only)    | `--el-text-faint` | "Never run"                   |
| Auto-disabled | `alert-triangle` | `--el-danger`     | "Auto-disabled · 10 failures" |

## Real-product operations (finding #57 — bounded, drawn)

- **Audit log pagination** — reads page over the indexed `[ruleId, createdAt]`
  log (the 6.6.1 index); the foot shows "Showing 1–N of M" + a pager. **No
  load-all** (the finding-#57 tell, avoided).
- **Deleted triggering item** — renders the `tomb` tombstone (struck-through
  key, no link), not a dead link.
- **Failure detail** — a failure row expands (on a quiet `--el-surface-soft`
  band) to a rose-tinted `errbox` callout: a leading `alert-triangle`, the
  message in `--el-text-strong`, and the typed error as a mono `--el-page-bg`
  code chip (the finding-#35 hue-in-background grammar, shared with the
  auto-disabled banner — NOT a grey box with a danger stripe) + a per-step list
  (which action failed, which were skipped).
- **Auto-disable banner** — at 10 consecutive failures the rule switches off; a
  rose banner (AA, `--el-text-strong`) on the list + editor names the count and
  offers **Re-enable** (wired to the 6.6.1 counter reset).
- **90-day retention** — a quiet footer line states the cron-swept window
  (6.6.2).
- **Caps** — 100 rules / project, 10 actions / rule, 20 conditions / rule —
  each a disabled add affordance + an inline note, and a **typed 422** surfaced
  **per row** (danger outline + `role="alert"` message) on bypass, never a
  silent truncation or a detached toast.

## Copy strings catalog (use verbatim in 6.6.5 / 6.6.6; i18n under `settings.automation`)

| Surface                 | String                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nav entry               | `"Rules"` (group `"Automation"`)                                                                                                                                               |
| Page title · subtitle   | `"Automation"` · `"When something happens in {projectName}, run actions automatically. Rules run as their owner — only project admins can manage them."`                       |
| Create CTA              | `"Create rule"`                                                                                                                                                                |
| When / If / Then labels | `"When"` · `"If"` · `"Then"`                                                                                                                                                   |
| When block sub          | `"the trigger — one per rule"`                                                                                                                                                 |
| If block sub            | `"conditions on the triggering item — optional"`                                                                                                                               |
| Then block sub          | `"actions run in order, as the rule owner"`                                                                                                                                    |
| Combinator              | `"Match"` · `"all"` / `"any"` · `"of the following conditions:"`                                                                                                               |
| Trigger options         | `"Item created"` · `"Item transitioned"` · `"Field value changed"` · `"Item commented"`                                                                                        |
| Transitioned config     | `"from"` · `"to"` (status `Combobox`s; placeholder `"Any status"`)                                                                                                             |
| Field-changed config    | `"field"` + the field picker (preset `"Assignee"`)                                                                                                                             |
| Action options          | `"Transition"` · `"Set field"` · `"Add watcher"` · `"Add comment"` · `"Add label"`                                                                                             |
| Add affordances         | `"Add condition"` · `"Add action"`                                                                                                                                             |
| Editor foot             | `"Runs as {owner} (rule owner) · {n} of 10 actions"` · `"Cancel"` · `"Save rule"`                                                                                              |
| List meta               | `"{n} of {n} rules"` · `"100 rules per project"`                                                                                                                               |
| Last-run                | see the glyph vocabulary table above                                                                                                                                           |
| Empty (list)            | `"No rules yet"` · `"Automate repetitive work — transition items, set fields, add watchers or comments when something happens. Rules run as their owner."`                     |
| Auto-disabled banner    | `"{ruleName} was disabled automatically after 10 consecutive failures. Fix the rule and re-enable it — re-enabling resets the failure count."` · `"Re-enable"`                 |
| Cap (rules)             | `"100 of 100 rules — delete a rule to add another."`                                                                                                                           |
| Cap (conditions)        | `"20 of 20 conditions — the maximum for one rule."`                                                                                                                            |
| Audit log title         | `"Run history — {ruleName}"`                                                                                                                                                   |
| Audit status pills      | `"Success"` · `"Failure"` · `"No actions"`                                                                                                                                     |
| Audit no-actions reason | `"Condition not met — {summary}"`                                                                                                                                              |
| Audit tombstone         | `"{n} actions — triggering item since deleted"`                                                                                                                                |
| Audit pager · retention | `"Showing {a}–{b} of {total}"` · `"Run history is kept for 90 days."`                                                                                                          |
| Empty (audit)           | `"No runs yet"` · `"This rule hasn’t fired. When an item matches its trigger and conditions, each run appears here with its result, duration and the item that triggered it."` |
| Stale-referent (cond)   | `"“{value}” was removed from {field}. Remove it, or pick a current option."`                                                                                                   |
| Invalid action (422)    | `"{user} is no longer a member of this project — they can’t be a watcher. (422)"` (the per-referent shape)                                                                     |

## Recorded deviations from the mirror (justified — no complexity for nothing)

- **Runs as the rule OWNER, not a synthetic "Automation" actor** — the Story
  6.6 recorded deviation; the editor foot states "Runs as {owner}". A synthetic
  per-workspace user would leak into every member-bounded picker for no use
  case.
- **No "Soon"/disabled triggers or actions drawn** — only the verified core
  sets ship; the documented extension slots (scheduled triggers, branches,
  send-email/webhook actions, the chaining opt-in) are NOT drawn — drawing a
  disabled control implies a near-term page (the 6.5 "Soon" convention is for a
  reserved nav SLOT, not for unowned features).
- **Admin-only, no read-only variant** — unlike Fields/Components there's no
  useful viewer view of automation; the 6.4 gate hides the whole surface.

## Extension slots (reserved — do NOT build here)

Scheduled/cron triggers (need the 6.2 saved-filter item-selection substrate);
branches + smart values; global / multi-project rules; the "Allow rule trigger"
chaining opt-in; send-email / webhook / create-item actions; a manual "run now"
trigger; monthly usage quotas (Epic 8.1 metering). Each is an additive registry
entry when a use case lands — the registries (6.6.1/6.6.3) are the growth seam.

## Tokens & a11y

Colour is `--el-*` only — the `--el-tint-{sky,lavender,mint}` block wedges
(When/If/Then), the `--el-tint-{mint,rose}` status pills + banner (hue in the
bg, `--el-text-strong` text — finding #35, AA holds), the `--el-type-bug` /
`--el-success` / `--el-info` / `--el-warning` issue + status hues (finding #54:
not grey + primary alone), the `--el-danger` validation outline + error text.
Shape via the element shape tokens (`--radius-card/-input/-btn/-control/-badge`,
`--spacing-card-padding/-control-*/-chip-*/-input-*/-btn-x`,
`--height-control/-input/-btn-*`, `--shadow-subtle/-card/-elevated`); `rounded-
full` only on the avatar / status dots / the `Switch` knob. The When/If/Then
columns are labelled groups; every picker is a keyboard-complete `Combobox`;
the `Switch` + last-run status are announced; action reorder is keyboard-
operable (the `grip` + ↑/↓); validation is `role="alert"` on the offending row,
condition staleness `role="status"`; the audit log is a list with the failure
detail in an expandable region. Extends the settings strict axe sweep. Dark
parity verified by toggle.

## Source of truth

When a string here disagrees with shipped 6.6.5 / 6.6.6 code, the code wins —
file a fix so the mockup stays the reference. `automation.mock.html` is the
layout-confirmation artifact; it may drift from pixel-exact production once the
React lands.

---

# Editable project Details (Story 6.8) — Subtask 6.8.3 output

Story 6.8 grows the **6.5.3 read-only Details landing** (the identity page the
6.5 settings **AREA** lands on) into the **editable** surface: the project
**name**, **avatar** (preset icon + colour swatch), and — the load-bearing
piece — a **project-key change with old-key redirects** (PROD → NIF, every
issue identifier re-renders with its number preserved, old links keep working
forever via the `project_key_alias` table). It also lists **previous keys** with
a release control. The backend already shipped in **6.8.1** (schema + the locked
atomic `changeKey` tx + alias reservation/release + admin-gated PATCH) and
**6.8.2** (alias-aware resolution everywhere the key is addressed); this asset is
the **design gate** for the UI code subtask **6.8.4**.

This section is the canonical reference for **6.8.4** (the editable Details page),
which carries **6.8.3 + 6.5.3** in `dependsOn` and seeds `'blocked'` (Principle
#13). The asset is an **HTML mockup** — `details.mock.html`, built FROM the real
design system (the `app/globals.css` token block copied 1:1 — incl. the
`--el-sidebar-*` shell tokens — + shipped `components/ui/*` primitives), with
`details.png` as the light-mode render. The HTML is the source of truth; toggle
`data-theme="dark"` in it to confirm token parity.

**This EXTENDS the 6.5.1 area asset — it does NOT redraw the chrome.** The rail
(grouped settings nav + the project-identity header + back-to-project), the
serif page-title grammar, the Details landing's outer Card, and the re-homed
Archive danger zone are all the 6.5.1 drawing, reused whole. 6.8 changes only the
**content** of the Details card — the read-only identity rows become editable
controls — and adds three new things: the **avatar picker** (Popover), the
**change-key modal**, and the **previous-keys** rows + **release confirm**.

## Files

| Source of truth (HTML)              | Render (PNG)                          |
| ----------------------------------- | ------------------------------------- |
| `design/projects/details.mock.html` | `design/projects/details.png` (light) |

`details.mock.html` is one multi-panel review page (panels 0–5); `details.png`
is the full-page light render. Dark parity is in-file (the `Toggle dark` button).
Avatar-registry + key-error contracts come from the shipped 6.8.1 code, not the
mock — see the catalog below.

## Mirror product (rung 1, VERIFIED at plan time 2026-06-10 — Atlassian docs)

Jira Cloud **project details** + the **"Previous project keys"** details-page
feature (the same sources the Story 6.8 seed cites — checked, not asserted, per
`notes.html` mistake #33):

- **Details owns name / key / avatar.** Adopted 1:1. The key is **not a
  free-typing field** — it shows as a read-only value with a guarded "change key"
  flow (Jira routes the rename through a confirmation, not an inline edit).
- **Old keys keep working + stay reserved.** After PROD → NIF: old `PROD-`
  issue links **redirect** to the new key, REST calls on the old key **resolve**
  (no redirect), and PROD **stays reserved** against other projects. Link text is
  never rewritten. The Details page lists **"Previous project keys"** with a
  **remove** that un-reserves the key and **breaks its old links** — drawn as the
  release-with-confirm row.
- **Re-key is one operation.** Jira runs a background re-index here; ours is
  structurally cheaper (search reads the denormalized `work_item.identifier`
  column), so the bulk `UPDATE` **is** the re-index — synchronous + atomic. The
  modal's in-flight state reflects that (one commit, "won't leave issues
  half-renamed"), not a progress bar over a background job.

## Composing primitives (no new primitive required)

Everything is a shipped `components/ui/*` primitive — the mock's classes name
the primitive each block maps to:

- **`Sidebar` / area chrome** — the 6.5.1 settings nav + rail header, REUSED
  whole. The rail's project chip now renders the **avatar** (preset icon over the
  tint, or the mono key-letters fallback) instead of a flat letter tile.
- **`Card`** — the Details card (`card` + `card-head` + `card-body`), the
  Previous-keys card, and the re-homed **Danger zone** (`card.danger` —
  `border-2` `--el-danger`, the `Archive…` `danger` Button + its modal,
  UNCHANGED from 6.5.1). Each editable row is a labelled `field`.
- **`Input`** — the **name** field (text), the **change-key** field
  (`font-mono`, `letter-spacing`). The error state is the Input **error
  grammar** (`--el-danger` border + an `--el-danger-text` message with an
  `alert` glyph); the success state is the `--el-success` "Available" line. The
  read-only **key** value is a `key-val` (mono, `--el-surface` fill, no border
  emphasis) — a display, not an input.
- **`Button`** — `primary` (Save changes / Change key), `ghost` (Cancel / Change
  avatar / Change key… / Release), `danger` (Archive… / Release key). Sizes via
  `--height-btn-md` / `-sm`.
- **`Pill`** — `Admin` (`--el-tint-lavender`) / `Read-only` (`--el-tint-mint`),
  AA-safe (hue in the tint bg, `--el-text-strong` text — finding #35). The
  `Soon` automation chip is the 6.5.1 drawing.
- **`Popover`** — the **avatar picker** (the 18-icon grid + the 6 colour swatches
  - a live preview + "None") AND the **project switcher** open state (redrawn
    from the 1.3.4 frames with the avatar chip; the active row keeps its `Check`).
- **`Modal`** — the **change-key** modal (no `title` prop; a custom heading row:
  a `Key` glyph in an `--el-tint-lavender` circle + the serif title) and the
  **release** confirm (the **archive-confirm danger grammar**: `TriangleAlert` in
  an `--el-tint-rose` circle + a `danger` Button). `Modal.Footer` = ghost Cancel
  - the action button.
- **`Toast`** — the change-key success feedback (inverted surface, `--el-success`
  check), naming the consequence.
- The **save bar** is the card footer action row (`save-bar`) with a
  dirty/saving/saved status region on the left.

## The avatar contract (the 6.8.1 registry — `lib/projects/avatar.ts`)

The picker renders from the SAME two key sets the `updateDetails` service
validates against — the mock does not invent its own:

- **18 preset ICON keys** (the grid, in registry order): `folder`, `rocket`,
  `layers`, `box`, `compass`, `flag`, `star`, `target`, `zap`, `bug`, `code`,
  `sparkles`, `hexagon`, `briefcase`, `beaker`, `palette`, `globe`, `bookmark`.
  The keys are opaque STRINGS server-side; **6.8.4 owns the key → lucide-component
  map** (the picker imports `lucide-react`; the service must not — the same
  UI-free split `issueTypes.ts` → `parentRules.ts` uses).
- **6 COLOUR keys**, aligned 1:1 to `--el-tint-*`: `peach`, `rose`, `mint`,
  `lavender`, `sky`, `yellow`. Each swatch is `bg-(--el-tint-<key>)` — colour
  stays on the swap layer, never a raw `--color-*`. The chip puts the glyph in
  `--el-text-strong` over the tint (AA, finding #35).
- **`null` avatar = the shipped MONO rendering** — the chip shows the project's
  key letters on `--el-type-task` (the existing tile). "None" in the picker
  restores it. Drawn on the switcher's "Apex" row (`AP`).
- **NO image upload** (recorded deviation — Jira's own default avatars are a
  preset library; the 2.3.7 upload primitive is issue-attachment-scoped; an
  arbitrary user image as workspace chrome would need crop/moderation infra).
  Adding an icon key is append-only-safe; removing one orphans existing rows.

## The change-key flow (the 6.8.1 service + errors contract)

The key is a **read-only `font-mono` value + a "Change key…" affordance** on the
card (never a free-typing field — the mirror shape, and a guard against an
accidental re-key of every issue). The affordance opens the modal. Validation is
**STRICT** — the field rejects a malformed key, it does **not** pad/truncate the
way the create-time `normalizeIdentifier` coerces (an admin re-key is surprising
to silently mutate). Live shape: `/^[A-Z0-9]{3,5}$/`. The **six modal states**
(panel 3) map 1:1 to the shipped errors:

| Modal state              | Source (`lib/projects/errors.ts`) | Surface                                                          |
| ------------------------ | --------------------------------- | ---------------------------------------------------------------- |
| Clean (valid, available) | — (passes)                        | green "Available" + the verbatim consequence; Change key enabled |
| Format invalid           | `InvalidIdentifierError` → 400    | Input error grammar; Change key disabled                         |
| Collision — live key     | `IdentifierTakenError` → 409      | "Another project … already uses the key …" (distinct copy)       |
| Collision — reserved     | `IdentifierReservedError` → 409   | "… is reserved by another project's previous key." (distinct)    |
| In-flight                | (the atomic tx committing)        | inputs locked + spinner; "won't leave issues half-renamed"       |
| Success                  | (resolves)                        | modal closes → Toast; card now lists the old key under Previous  |

The two collision states get **distinct copy** because they have distinct
remedies (a live key is taken now; a reserved key is freed only by releasing the
other project's alias or deleting it) — that's exactly why 6.8.1 split
`IdentifierTakenError` from `IdentifierReservedError`. `IdentifierUnchangedError`
(new == current) is a typed no-op the field prevents (Change key stays disabled
when the value equals the current key), so it has no error panel.

## Previous keys + release

The **Previous keys** row appears in the card only when `previousKeys.length > 0`
(panel 5 right shows the zero-aliases case — the row is **absent**, not an empty
box). Each row = a `Key` glyph + the mono key + its retired-date + a `ghost`
**Release** button. Chained renames each get their OWN row (PROD-row + NIFR-row
on the NIF project — they resolve flat, matching 6.8.2's no-chain-walk rule).
Release opens the **danger confirm** (archive-confirm grammar) naming the
consequence; **no typed-identifier arm step** — releasing is recoverable only by
a fresh rename back to that key, and the broken-links consequence is the gate
(parity with the components/automation delete confirms, which also drop the
arm-step when a consequence statement suffices).

## Save states (panel 1)

The card footer is the **save bar**: **clean** (Save disabled, no status),
**dirty** (amber dot + "Unsaved changes", Save enabled), **saving** (spinner,
both buttons locked), **saved** (`--el-success` check + "Saved", auto-clears).
Name + avatar edits batch through this single Save (one `updateDetails` PATCH);
the **key change is its own modal flow** (a separate, guarded mutation) and does
NOT ride the save bar — re-keying every issue is too consequential to fold into a
generic "Save changes".

## Gated state (panel 5 left — the 6.4.6 grammar)

A non-admin **member** sees the values but **no controls**: no Save bar, no
"Change avatar" / "Change key" affordances, no Danger zone — the `Read-only` Pill
replaces the `Admin` Pill (the same degradation 6.5.1 drew for the read-only
Details landing). The actions also **reject server-side** (the 6.8.1
admin-gated PATCH/DELETE → typed 403) — hiding is presentation, the gate is the
service. This is the 6.4.6 read-only grammar 5.4 / 6.4 / 6.5 all share.

## Copy strings catalog (use verbatim in 6.8.4; i18n under `settings.details`)

`{Project}` = display name, `{IDENT}`/`{NEW}`/`{OLD}` = project keys (mono).

| Surface                       | String                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Page title / sub              | `"Details"` / `"Your project's name, avatar and key. Changing the key re-keys every issue and keeps old links working. Only project admins can edit these."`                                                                         |
| Card title                    | `"Project details"`                                                                                                                                                                                                                  |
| Avatar field label / help     | `"Avatar"` / `"A preset icon and colour, shown on the project switcher and lists. Choose \"None\" to fall back to the key letters."`                                                                                                 |
| Change-avatar button          | `"Change avatar"`                                                                                                                                                                                                                    |
| Avatar picker sections / None | `"Icon"` · `"Colour"` · `"Preview"` · `"None"`                                                                                                                                                                                       |
| Name field label / help       | `"Name"` / `"The display name across the app. The URL slug is not affected."`                                                                                                                                                        |
| Key field label / help        | `"Key"` / `"Issues are keyed {IDENT}-1, {IDENT}-2, … Changing it re-keys every issue and keeps old links working."`                                                                                                                  |
| Change-key affordance         | `"Change key…"`                                                                                                                                                                                                                      |
| Save bar (clean→saved)        | `"Unsaved changes"` · `"Saving…"` · `"Saved"` · buttons `"Cancel"` / `"Save changes"`                                                                                                                                                |
| Change-key modal title / lede | `"Change project key"` / `"The key prefixes every issue ID in {Project}. Pick a new one — 3–5 uppercase letters or digits."`                                                                                                         |
| Change-key field label        | `"New key"`                                                                                                                                                                                                                          |
| Available / consequence (go)  | `"Available"` · `"Every issue identifier becomes {NEW}-1, {NEW}-2, … — the numbers stay the same."` · `"Old {OLD}- links keep working — they redirect to the new key."`                                                              |
| Format error                  | `"\"{value}\" is not a valid project key (use 3–5 uppercase letters or digits)."` (≡ `InvalidIdentifierError`)                                                                                                                       |
| Collision — live key          | `"Another project in this workspace already uses the key \"{value}\"."` (≡ `IdentifierTakenError`)                                                                                                                                   |
| Collision — reserved          | `"The key \"{value}\" is reserved by another project's previous key."` (≡ `IdentifierReservedError`)                                                                                                                                 |
| In-flight lede / button       | `"Re-keying every issue to {NEW}-. This is one atomic change — it won't leave issues half-renamed."` · `"Changing key…"`                                                                                                             |
| Change-key buttons            | `"Cancel"` / `"Change key"`                                                                                                                                                                                                          |
| Success toast                 | `"Project key changed to {NEW}. Every issue is now {NEW}-<n>, and old {OLD} links keep working."`                                                                                                                                    |
| Previous keys label / row     | `"Previous keys"` · `"retired {date}"` · button `"Release"`                                                                                                                                                                          |
| Previous keys help            | `"Old links to these keys redirect to {IDENT}."`                                                                                                                                                                                     |
| Release confirm title / body  | `"Release {IDENT}?"` / `"Releasing {IDENT} frees it for other projects and breaks old {IDENT} links — they'll stop redirecting and start returning \"not found\". This can't be undone except by changing the key back to {IDENT}."` |
| Release confirm buttons       | `"Cancel"` / `"Release key"`                                                                                                                                                                                                         |

The change-key error strings are the SAME text the 6.8.1 `errors.ts` constructors
build — keep them in lock-step (the route returns the typed `code`; 6.8.4 maps
`code` → the i18n string above, so the wording lives once in the catalog).

## Recorded deviations from the mirror (justified — no complexity for nothing)

- **No image upload** for the avatar — preset icon + tint only (above). Jira's
  own default avatars ARE a preset library; upload is the documented extension.
- **No description / category / lead / default-assignee** fields — absent from
  the shipped `Project` model (rung 2); component default-assignees (5.4) cover
  the default-assignee need. Each is a documented extension slot.
- **`slug` is not regenerated** on rename — it's a create-time artifact no URL
  consumes; touching it would break nothing and help nothing.
- **Key change is its own modal**, not an inline save-bar field — matches Jira's
  guarded flow and protects against an accidental whole-project re-key.

## Extension slots (reserved — do NOT build here)

- Avatar **image upload** (crop/moderation infra) — when a use case lands.
- **Project description / category / lead** — when the model grows the fields.
- A workspace-level **"reserved keys" admin view** — deletion already cascades
  the aliases (the 6.8.1 `onDelete: Cascade`), so there's no orphan to manage yet.

## Tokens & a11y

Colour is `--el-*` only — `--el-tint-{peach,rose,mint,lavender,sky,yellow}` for
the avatar swatches/chips + the modal-icon circles (hue in the bg,
`--el-text-strong` glyph — finding #35, AA holds), `--el-success` (Available +
Saved), `--el-warning` (the dirty dot), `--el-danger` + `--el-danger-text` (the
Input error outline + message + the release danger button), `--el-accent` (the
picker selection ring + Save / Change-key primary), `--el-type-task` (the mono
avatar fallback). No grey-+-primary collapse (finding #54): the picker, chips,
and modal icons carry real hue. Shape via the element shape tokens
(`--radius-card/-input/-modal/-btn/-control/-badge`,
`--spacing-card-padding/-input-*/-control-*/-chip-*/-btn-x`,
`--height-input/-btn-*/-control`, `--shadow-card/-elevated/-modal/-subtle`);
`rounded-full` only on the colour swatches / the dirty dot / the spinner / the
modal-icon circles. A11y: each editable row is a labelled `field`; the avatar
picker is a keyboard-complete `Popover` (the icon grid is a roving-tabindex
listbox, the swatches a radiogroup); the change-key field validation is
`role="alert"` on the message + the success line `role="status"`; both modals are
focus-trapped, ESC-closable, and the danger confirm's action is reachable without
a typed arm step; the Toast is `role="status"`. Extends the settings strict axe
sweep. Dark parity verified by toggle.

## Source of truth

When a string here disagrees with shipped 6.8.4 code, the code wins — file a fix
so the mockup stays the reference (and keep the change-key error strings in
lock-step with `lib/projects/errors.ts`). `details.mock.html` is the
layout-confirmation artifact; it may drift from pixel-exact production once the
React lands.
