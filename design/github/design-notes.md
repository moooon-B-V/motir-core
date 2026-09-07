# Design notes — GitHub integration surfaces

**Story 7.10 · MOTIR-889 (design gate, Principle #13).** The design reference for
every UI-touching subtask in the GitHub-integration Story — the connect/settings
UI + repo selection (**MOTIR-895**) and the work-item PR/CI status surface. The
GitLab sibling (**MOTIR-1472**) mirrors this layout against the `GitProvider`
seam. **Extended by MOTIR-1595 (Panel 5):** the explicit item→PR link affordance
— the manual override of the MOTIR-892 auto-resolver — built by **MOTIR-1596**
on top of the Development display surface **MOTIR-1579** ships.

- **Asset of record:** [`github.mock.html`](./github.mock.html) — the source of
  truth (built from the real design system; the `--el-*` + shape tokens are
  copied verbatim from `packages/design-system/theme.css`). Its `.png` export
  ([`github.png`](./github.png)) is the board/PR-visible face.
- **Definition of done (three files):** `design-notes.md` + `github.mock.html` +
  `github.png`. All three are committed.

---

## Placement — resolved from shipped reality, not assumed

> ⚠️ **SUPERSEDED by the MOTIR-4672 amendment below (Story MOTIR-4669).** This
> section is kept because its DERIVATION is still the right method — the placement
> was read off the schema rather than chosen — and because a reader meeting the new
> tier should be able to see what it replaced. Its ANSWER is now false: the
> installation and the repository are ORGANISATION-scoped, so the surface is
> **Settings → Organisation → Git**, and _"the workspace is the wrong tenant for
> the same reason the project is: it is not where the repository lives."_ The
> **Workspace**-group rail row it describes is gone too — the door is the `Git` row
> in the organisation settings nav (MOTIR-4673 panel 7), with the org menu's row
> (panel 6) beside it.

The GitHub integration lives under **Settings → Workspace → GitHub**
(`app/(authed)/settings/workspace/github`, the shipped settings-area shell that
already hosts **Jobs**). This is **derived, not a free choice** — so guard #4 of
the design-against-shipped-reality rule ("surface an undecided architecture
choice") does **not** fire:

- The installation entity is `GithubInstallation { workspaceId, … }` (MOTIR-891)
  and repo selection is workspace-wide → the surface is **workspace-scoped**.
- The per-user identity binding (`GithubIdentity { userId }`, MOTIR-1498) is
  **surfaced on this same workspace page**: the admin who connects binds their
  own GitHub identity as step 1. It is not a separate personal-account surface —
  connecting the workspace and binding the connecting user's identity are one
  flow.

A new `settings/workspace/github` route + a workspace-settings nav entry is what
MOTIR-895 adds (mirroring the typed nav-registry pattern in
`lib/settings/projectSettingsNav.ts` — a totality-guarded registry entry per
settings page).

### Access path (the door — drawn, not just named)

- **Settings surfaces (Panels 1–2):** ⚠️ **re-tiered by MOTIR-4672.** The door is
  the **organisation settings nav** (`Git`, in the `general` group), specified by
  MOTIR-4673 panel 7 in `design/org-admin/`, with the **org menu**'s `Git` row
  (panel 6 there) as the fast door beside it. The panels draw that rail with `Git`
  active; its head reads `moooon · Organisation settings`. It read: _"the settings
  rail shows a **GitHub** row (github mark icon) active under the **Workspace**
  group, with the breadcrumb `Settings › Workspace › GitHub`"_ — a rail that never
  existed, at a tier that no longer does. The rule it states is still right and is
  why the door has a card of its own: the reader must SEE the entry affordance,
  not just a route named in prose.
- **PR/CI surface (Panels 3–4a):** the **Development** section appears on the
  work-item detail (peek) automatically once a branch/PR references the item's
  `MOTIR-<n>` id — the door is the section itself materialising on the issue.
- **Explicit link (Panel 5):** the door is the quiet **"+ Link pull request"**
  control in the header of the **full detail page's** Development card (drawn
  in 5a). The peek carries NO door — it stays read-only; its path to the
  affordance is the existing **"Open full page"**.

---

## The two grants — the verified GitHub-App model (the copy must get this right)

Grounded in **MOTIR-1498** (Grant 1) + **MOTIR-891** (Grant 2) and GitHub's
"Differences between GitHub Apps and OAuth apps". The two grants are
**independent** — an identity with no installation is a valid state the UI shows
(Panel 4's revoked case). Panel 1 makes identity-vs-repo-access legible as two
distinct, eyebrow-labelled `grant-row`s:

**Step 1 · Identity — "Verify your GitHub identity"**

> Authorize Motir to confirm who you are on GitHub — your username and avatar.
> This reads your public profile only. **It grants no access to any code.**

**Step 2 · Repository access — "Install the Motir GitHub App"**

> Choose which repositories Motir may read — you pick the exact repos on GitHub's
> install screen. Motir never sees the rest, and you can change the selection any
> time.

Repo selection is **ultimately changed on GitHub** (the App install screen). The
UI mirrors that honestly with a **"Manage on GitHub"** link-out (external-link
icon) rather than faking in-app repo granting.

---

## Panels & primitives (every panel — the multi-panel rule, mistake #31)

### Panel 1 — Settings → Organisation → Git, NOT connected

> ⚠️ Re-tiered by MOTIR-4672. It read _"Settings → Workspace → GitHub"_; the
> panel's layout is unchanged, its TIER is not.

- **Settings-area shell** (sidebar rail + content) — the shipped area layout.
  Rail groups Account / Workspace / **GitHub (active)** / Project.
- **`Card`** ("Connect GitHub") with `card-head` + `card-body` + `card-foot`.
- Two **`grant-row`**s, each a `grant-ic` badge + `grant-eyebrow` + `<h4>` + copy.
  Step-1 icon = badge-check (identity); Step-2 icon = repo (repository access).
- **`Button` variant=primary** — "Connect GitHub" (github-mark left icon).
- Helper line (card-foot): "You'll be sent to GitHub to authorize, then to pick
  repositories."

### Panel 2 — connected, the repo-selection list

- **Identity `Card`:** GitHub-identity **avatar (real `avatar_url` image)** +
  `@zhuyue` login + a **`Pill` (severity=success / mint)** "Verified" (badge-check
  icon) + caption "GitHub identity · connected as Zhu Yue". A **`Button`
  variant=danger-ghost size=sm** "Disconnect". Card-foot: "Motir App installed on
  **moooon** · organization" + **`Button` secondary** "Manage on GitHub".
- **Repositories `Card`:** `SectionLabel` "Repositories" + caption "Only the
  repositories you selected on GitHub. Motir reads these — it can't see any
  others." Each **`repo-row`**: repo icon + `owner/name` (owner muted) +
  **`branch-chip`** (`main`, code-token styling) + a **sync-state `Pill`** + a
  **`Switch`** (`role="switch"`) toggling active sync for that repo.
  - Sync states shown: **Synced** (`Pill` mint, check icon), **Syncing…** (`Pill`
    peach, dots icon), **Not synced** (`Pill` neutral). Switches: on / on / on /
    off respectively.
  - Card-foot: "To add or remove repositories, update the Motir App's access on
    GitHub." + "Manage on GitHub".

### Panel 3 — a work item's PR/CI status surface (issue-detail Development section)

- Issue-detail **peek header** (`type-pill` Subtask + `peek-id` MOTIR-891) +
  title.
- **`SectionLabel`** "Development", then linked-PR **`pr-row`**s. Each row: a PR
  glyph (open/merge/closed) + PR title + `pr-meta` (`owner/repo · #<number>`) +
  a **PR-state `Pill`** + a **CI-state `Pill`** + an external-link affordance.
  Three rows demonstrate every state pair:
  - **#128** Open + Checks running → `pill-sky` + `pill-peach`
  - **#131** Merged + Checks passing → `pill-mint` + `pill-mint`
  - **#119** Closed + Checks failing → `pill-rose` + `pill-rose`
- Caption: "Linked by `link_pull_request` over the MCP or a `motir auto` session branch."

### Panel 4 — empty + error states

- **4a — no linked PR:** the Development section renders the shipped
  **`EmptyState`** (`Card` root, centered) — git-pr icon, title **"No linked pull
  request"**, description "Open a PR from a branch that mentions `MOTIR-892` and
  it'll show up here with live PR and CI status." (quiet copy).
- **4b — settings revoked error** (App uninstalled on GitHub out-of-band): a
  **danger `callout`** (`callout-danger`, alert icon) —

  > **The Motir GitHub App was uninstalled on GitHub.** Motir can no longer read
  > your repositories or receive PR and CI updates. Your synced work items keep
  > their last-known status. Reconnect to restore sync.

  The card header carries a **`Pill` rose** "Disconnected". Because the grants are
  independent, the **identity stays bound** — the still-verified `@zhuyue` row
  shows with caption "Identity still connected · repository access revoked" — and
  a **`Button` primary** "Reconnect GitHub" restores the installation.

### Panel 5 — the explicit item→PR link affordance (MOTIR-1595 → built by MOTIR-1596)

The **manual override** of the MOTIR-892 auto-resolver: link an already-ingested
`GithubPullRequest` whose branch/PR title never named the item's key (so the
resolver skipped it) by setting `workItemId`. Grounded in the shipped link
grammar — this panel invents NO new interaction: it is the relationships panel's
**`AddLinkControl` + `LinkAddForm` + searchable `Combobox`** pattern
(2.4.9 / 6.9.2, `design/work-items/links.mock.html`) applied to PRs.

**Where the door is — the peek stays read-only (resolved, not assumed).** The
shipped peek's contract is "Read-only — editing lives on the full page"
(`IssueQuickViewPanel`; its ONE write path is _Open full page_). A link
affordance on the peek would be a second write path — a per-surface interaction
deviation of exactly the mistake-#139 class. So:

- **Peek (Panels 3 / 4a): display only** — rows + pills, unchanged. A user in
  the peek reaches the affordance the same way they reach every edit: **Open
  full page**.
- **Full detail page (`/items/[key]`): the Development section card** — a
  `ContentSectionCard` ("Development" + gloss) in the left column, the same
  card grammar as Description / Relationships / Activity. The rows are the
  SAME pr-rows as Panel 3 (one shared component — MOTIR-1579's). The door is a
  quiet **"+ Link pull request"** control in the card header's right slot —
  `--el-link` text + plus glyph, the exact `AddLinkControl` entry-point
  treatment ("+ Link issue"). _(5a draws the door; naming the route is not
  enough.)_
- **Detail-page empty state**: the Panel-4a `EmptyState` renders inside the
  Development card (same copy), keeping the two Development surfaces visually
  continuous.

**The picker (5b) — `LinkAddForm` grammar, one field.** Clicking the door
expands the surface-soft inline form (no modal — matching the shipped control;
this also avoids the combobox-in-dialog clipping class entirely):

- An eyebrow field label **"Pull request to link"**, then a **query-driven
  searchable Combobox** (debounced server search, per-keystroke — the 6.9.2
  pattern; the empty/short query fetches nothing). Reuse the shipped `Combobox`
  including its empty-listbox a11y handling (`role="status"` swap — the
  aria-required-children fix) and its option markup.
- **Option rows in the pr-row grammar, condensed:** PR glyph (open/merge/closed,
  `--el-icon-muted`) + title + `owner/repo · #<n>` meta (**`--el-text-identifier`**,
  NOT `-muted` — the AA sidebar-caption lesson at 12px) + the PR-state `Pill`
  (same tone table as Panel 3). Candidates = the workspace's ingested PRs
  across its selected repos, searched by title / number / repo.
- **PRs that already deliver other cards are listed, annotated, and pickable.**
  A candidate already delivering work shows a neutral chip in place of its state
  pill, on the LENGTH of its delivery set: **exactly one** → **"Linked to
  MOTIR-<n>"** (unchanged copy, unchanged `development.linkedTo` key);
  **two or more** → **"Delivers <n> work items"** (`development.deliversN`).
  Zero → the PR-state `Pill`, unchanged. Not a LIST — an unbounded string in a
  fixed-width Combobox row is a layout problem dressed as a copy decision — and
  not a cap, which is a list with a truncation rule that buys nothing a count
  does not. The chip's job is to say _this pull request is already spoken for_,
  and a count says that at every n.

  **⚠️ AMENDED (MOTIR-3756). This bullet used to read: _"picking it MOVES the
  link (single FK — `workItemId` points at one item). This IS the mis-link
  correction path: there is deliberately no per-row unlink — an unlinked PR would
  just be re-resolved by the next webhook event for it."_ BOTH halves of that
  argument are now false, and the old text is quoted rather than deleted because
  a mock whose prose argues from a retired mechanism is how the next reader
  re-derives the retired mechanism.**
  - **Picking it ADDS, it does not move.** The association is a row in
    `work_item_delivery`, not a scalar FK, so a pick records a second delivery
    and leaves the first standing. **The chip therefore stops being a takeover
    WARNING and becomes INFORMATION**: one pull request delivering several cards
    is the ordinary shape of a `motir auto` run, not a collision. Nothing is
    taken from another card by picking, so there is nothing to warn about — which
    is also why the chip needed no confirm step before and needs none now.
  - **Re-linking is consequently NOT the correction path, and a per-row unlink
    EXISTS.** The old argument — that an unlink would be undone by the next
    webhook delivery — died with the title/branch parse (MOTIR-3674): nothing
    re-resolves an unlinked pull request any more. `unlinkPullRequest` ships on
    the service, this surface's row menu reaches it, and MOTIR-3756 adds the
    `unlink_pull_request` MCP tool for an agent that mis-linked one. Correcting a
    mis-link means REMOVING the wrong delivery; linking the right card only adds
    a second one beside it.

  (MOTIR-1596 encodes: pick allowed, no confirm dialog — unchanged, and now for a
  simpler reason than the one it was written for.)

- **Actions:** `Button` **sm primary "Link"** (disabled until a pick) +
  **sm ghost "Cancel"** (collapses the form) — `LinkAddForm`'s exact button row.
- **After Link:** the form collapses and the row appears in the card
  (`router.refresh()` — the detail page's sections are server-rendered, the
  same mechanism `AddLinkControl` uses). The manually-linked row carries a
  quiet **"linked manually"** suffix in its `pr-meta` (provenance at a glance;
  the section caption gains "— or linked by hand from here").

**States (5c):**

- **Type-to-search** — listbox shows the centered prompt "Type to search pull
  requests" (`--el-text-secondary`).
- **No matches** — "No matching pull requests" + the hint line "Repositories are
  connected in Settings → Organisation → Git." (`--el-text-identifier`) — the road
  to the fix when the repo was never connected. **⚠️ Re-pointed by MOTIR-4672:** it
  read _"Repositories sync in Settings → Workspace → GitHub"_, and that
  destination is deleted by this story.
- **Typed error** — `LinkAddForm`'s rose banner (strong text on
  `--el-tint-rose`, alert glyph `--el-danger` — finding #35): e.g. the
  disconnected organisation ("GitHub isn't connected for this organisation.
  Connect it in Settings → Organisation → Git."). **⚠️ Re-pointed by MOTIR-4672**,
  same reason. Loading reuses the Combobox spinner.

**Copy — the `github` i18n namespace (all locales, en+zh parity):**
`development.title` "Development" · `development.gloss` "Linked pull requests ·
live PR and CI status" · `development.linkPr` "Link pull request" ·
`development.linkPrField` "Pull request to link" · `development.searchPlaceholder`
"Search pull requests…" · `development.typeToSearch` "Type to search pull
requests" · `development.noMatches` "No matching pull requests" ·
`development.noMatchesHint` "Repositories are connected in Settings →
Organisation → Git." · `development.linkedTo` "Linked to {key}" · `development.linkedManually`
"linked manually" · `development.linkAction` "Link" · `development.notConnected`
"GitHub isn't connected for this organisation. Connect it in Settings →
Organisation → Git." · `development.autoLinkCaption` "Link with + Link pull request here, or
with `link_pull_request` over the MCP." (cancel = the shared
`common.cancel`).

**Build seam (for MOTIR-1596):** MOTIR-1579 ships the pr-row component + the
peek read path; 1596 mounts the Development `ContentSectionCard` on the detail
page (server-rendered, `router.refresh()` page-state) and adds the
door + form + Server Action. The shipped `LinkAddForm` box uses a legacy raw
`rounded-md` — the new form uses the element-semantic token (`--radius-card`,
as mocked); do not copy the raw utility forward.

---

## Pill PR/CI tone mapping (why — the no-new-primitive constraint)

The shipped `Pill` has **no built-in open/merged/closed or passing/failing/running
tone** (its axes are `status` / `severity` / `priority` / `memberRole` / `orgRole`
/ `tone`). The AC forbids inventing a new design-system entry inside this Story,
so PR/CI states **map onto existing semantic axes** — no new `--el-*` token, no
new Pill variant:

| Surface  | State       | Pill prop the code uses | Tint token        | Rationale                                                                                                                            |
| -------- | ----------- | ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| PR state | **Open**    | `status="in-progress"`  | `--el-tint-sky`   | in-flight, matches Motir's own "In Progress" hue                                                                                     |
| PR state | **Merged**  | `status="done"`         | `--el-tint-mint`  | terminal success, matches "Done" (GitHub's merged-purple has no palette token — using it would need an invented `--el-*`, forbidden) |
| PR state | **Closed**  | `severity="danger"`     | `--el-tint-rose`  | closed unmerged = abandoned                                                                                                          |
| CI state | **passing** | `severity="success"`    | `--el-tint-mint`  |                                                                                                                                      |
| CI state | **failing** | `severity="danger"`     | `--el-tint-rose`  |                                                                                                                                      |
| CI state | **running** | `severity="warning"`    | `--el-tint-peach` |                                                                                                                                      |

A merged PR (mint) next to passing CI (mint) is intentionally both-green ("all
good"); the two pills stay distinguishable by their leading glyph (git-merge vs
check) and label. Every tint carries the hue in the **background** with
`--el-text-strong` text (finding #35 / AA).

> **Note for MOTIR-895:** render these with the shipped `<Pill>` primitive using
> the props above — do **not** add a PR/CI-specific tone. If a genuinely distinct
> PR-merged colour is later wanted, that is a NEW `design/` subtask that adds an
> `--el-*` token + Pill variant, never an inline hue.

---

## Per-element `--el-*` colour roles

| Element                                                       | Token(s)                                                                                                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Page / body                                                   | `--el-page-bg` · `--el-page-text`                                                                                                                                                          |
| Settings sidebar                                              | `--el-sidebar-bg` · `--el-sidebar-border` · active row `--el-sidebar-item-bg-active`                                                                                                       |
| Nav icons                                                     | `--el-icon-muted` (idle) · `--el-icon-active` (active row)                                                                                                                                 |
| Card surface / border                                         | `--el-card` · `--el-border` · `--el-border-soft` (dividers)                                                                                                                                |
| Primary text / secondary / muted / subtitle                   | `--el-text` · `--el-text-secondary` · `--el-text-muted` · `--el-text-subtitle`                                                                                                             |
| Eyebrow / section labels                                      | `--el-text-eyebrow`                                                                                                                                                                        |
| Identifier (MOTIR-891)                                        | `--el-text-identifier`                                                                                                                                                                     |
| Primary button ("Connect / Reconnect")                        | fill `--el-accent` · ink `--el-accent-text`                                                                                                                                                |
| Secondary button ("Manage on GitHub")                         | text `--el-text` · border `--el-button-border`                                                                                                                                             |
| Disconnect (danger-ghost)                                     | text `--el-danger` · border `--el-border`                                                                                                                                                  |
| Grant-row icon badge                                          | `--el-card-icon-bg` / `--el-card-icon-fg`                                                                                                                                                  |
| PR-state / CI-state / sync-state pills                        | tints `--el-tint-{sky,mint,rose,peach}` + `--el-text-strong`; neutral pill `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`                                                     |
| Switch (repo sync)                                            | track on `--el-switch-on` · off `--el-muted` + `--el-border-strong` · knob `--el-switch-knob`                                                                                              |
| Branch chip (`main`)                                          | `--el-code-bg` / `--el-code-text`                                                                                                                                                          |
| PR row surface                                                | `--el-surface` + `--el-border`                                                                                                                                                             |
| Danger callout (revoked)                                      | bg `--el-danger-surface` · text `--el-danger-surface-text` · left rule + icon `--el-danger`                                                                                                |
| "Verified" pill                                               | `--el-tint-mint` + `--el-text-strong`                                                                                                                                                      |
| Type pill (Subtask)                                           | `color-mix(--el-type-subtask 16%, --el-surface)` + dot `--el-type-subtask` + `--el-text-strong`                                                                                            |
| GitHub avatar fallback                                        | `--el-avatar-fallback`                                                                                                                                                                     |
| "+ Link pull request" door (Panel 5)                          | text `--el-link` · radius `--radius-control`                                                                                                                                               |
| Link form box (LinkAddForm)                                   | bg `--el-surface-soft` · border `--el-border` · radius `--radius-card` · field eyebrow `--el-text-eyebrow`                                                                                 |
| Combobox search input                                         | bg `--el-page-bg` · border `--el-border` · radius `--radius-input` · height `--height-control` · placeholder `--el-text-muted`                                                             |
| Combobox popover / option rows                                | popover `--el-page-bg` + `--radius-card` + `--shadow-elevated`; option `--radius-control` + `--spacing-control-*`, active `--el-option-active-bg`; option meta `--el-text-identifier` (AA) |
| Delivery chip ("Linked to MOTIR-n" · "Delivers n work items") | neutral pill `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary` — ONE grammar for both arms, which is why the count arm needs no new token and no re-export                       |
| Typed-error banner (form)                                     | bg `--el-tint-rose` · text `--el-text-strong` · icon `--el-danger` (finding #35)                                                                                                           |

Shape flows only through element-semantic tokens: `--radius-card` (cards/panels),
`--radius-control` (repo/PR rows, nav rows, icon badges), `--radius-badge`
(pills), `--radius-btn` (buttons); padding via `--spacing-card-padding` /
`--spacing-control-*` / `--spacing-chip-*`; heights via `--height-btn-*`. No
Tier-0 `--color-*`, no raw `rounded-*` / `p-*` / `h-*`, no invented hex — verified
(the only `#…` values in the asset are the two non-semantic avatar-placeholder
data-URIs and PR numbers). Dark-mode parity confirmed by toggling
`data-theme="dark"`.

---

## Primitives composed — no hand-rolling (the 1.3.3 / 1.5.1 checklist)

Every element below is a **shipped** design-system primitive; MOTIR-895 composes
these, it does not build new ones:

- ✅ **`Card`** (`@motir/design-system`) — connect card, identity card, repo card,
  EmptyState root, PR-row containers.
- ✅ **`Pill`** — PR state, CI state, repo sync state, "Verified", "Disconnected".
  Mapped onto existing `status` / `severity` / `tone` axes (see table above).
- ✅ **`Button`** — variants `primary` (Connect / Reconnect), `secondary` (Manage
  on GitHub), `danger`/danger-ghost (Disconnect); sizes `md` / `sm`.
- ✅ **`EmptyState`** — Panel 4a "No linked pull request".
- ✅ **`Switch`** (`role="switch"`) — per-repo sync toggle.
- ✅ **`SectionLabel`** — "Repositories", "Development".
- ✅ **Avatar** — the GitHub identity uses the shipped **`<img object-cover>`**
  pattern (`AvatarField`) bound to `GithubIdentity.avatarUrl`; the initials-disc
  pattern (`MemberAvatar`) is the fallback. No new avatar component.
- ✅ **Settings-area shell** — the shipped rail + content layout
  (`settings/*/layout.tsx` + `SidebarNav`).
- ✅ **`ContentSectionCard`** — the detail-page Development card (Panel 5),
  the same section-card grammar as Description / Relationships / Activity.
- ✅ **`AddLinkControl` + `LinkAddForm` + `Combobox`** — the Panel-5 door +
  inline form + query-driven picker are the shipped link-adding pattern
  (2.4.9 / 6.9.2) applied to PRs, including the Combobox's empty-listbox a11y
  handling. No new picker primitive.

**No new design-system entry is required.** If MOTIR-895 finds it needs one
(e.g. a distinct merged-PR colour), that is a NEW `design/` subtask — not a code
workaround.

---

## ⚠️ AMENDMENT — MOTIR-4672 (Story MOTIR-4669), 2026-09-05: the tier moves to the ORGANISATION

**Panels 1–5 above keep their layout and are re-read at a new tier. Nothing in them is
redrawn.** A repository is connected **ONCE, to the ORGANISATION**; which projects use it is
visibility configuration — the rule MOTIR-2029 settles for the code graph, applied to the thing
the graph is built FROM. The surface was right; the tier was not.

**What that supersedes above, precisely.** The _Placement_ section's derivation —
_"the installation entity is `GithubInstallation { workspaceId }` and repo selection is
workspace-wide → the surface is workspace-scoped"_ — was correct about the schema it read and is
superseded by the schema MOTIR-4649 writes: `GithubInstallation` and `GithubRepo` become
organisation-scoped. So the route is **Settings → Organisation → Git**, the breadcrumb reads
`Settings › Organisation › Git`, and the page's heading, empty state and copy say _organisation_,
never _workspace_. The _two grants_ model, the identity binding, the PR/CI surfaces and the Panel-5
link affordance are untouched.

**⚠️ REVERSED — the panels DO draw a rail, and it is `Git` active in the organisation settings
nav.** This section read:

> The DOOR is the ORG MENU, and Panel 6 draws NO RAIL — that is a reading of shipped reality, not a
> simplification. `/settings/organization/*` has **no area layout and no settings rail** — unlike
> `settings/project/` and `settings/account/`, each of which has one. Its only navigation is the
> **org menu** behind the organisation name (`app/(authed)/_components/OrgControl.tsx`), whose rows
> are Settings · Security · Members · Usage · Billing, plus the command palette. So Panel 6 draws
> the **content column** with its breadcrumb and names its door rather than inventing an
> "Organisation" rail group the app does not render.

Every fact in it is still true of the shipped tree; the inference was not, and Yue read the
consequence straight off the asset: drawn without a rail, this page shows a person no way to have
arrived and no way onward. The org menu is a pop-over you must already know to open, it closes
behind you, and it highlights nothing. A tier that is the only one of three without a settings nav
is a **gap**, and drawing the page as if the gap were the convention designs it in permanently.

**MOTIR-4673 panel 7 now specifies the organisation settings NAV** — a registry sibling of
`projectSettingsNav.ts` / `accountSettingsNav.ts`, groups `general / access / billing`, with `Git`
in `general`. **Panels 1, 2 and 6 all draw it with `Git` active**, on all three so the page does not
change chrome between its own states. The rail's breadcrumb (`moooon · Organisation settings`)
replaces the content-column one.

**MOTIR-4640 is untouched by that.** It removes `Git` from the SHELL rail's bottom section; this is
the settings AREA rail, which the project and account areas each already have. Two different rails,
and the move is unaffected. The **org menu keeps its `Git` row** (MOTIR-4673 panel 6) as the fast
door beside the durable one.

**⚠️ The row's gate has a consequence for the `Used by N projects` column.** MOTIR-4673 gates the
`Git` ROW on org membership, not org admin — §6 of `docs/decisions/organization-tier.md` forbids a
relocation that narrows an audience, and `/settings/workspace/github` checks no role at all today.
So a plain member reads this inventory, and **the count and the expansion must read the same
access-filtered project set** — never a count that reveals a project the viewer may not name. The
page's WRITE controls (Connect · Disconnect · Remove) carry the owner/admin gate.

### ⚠️ CORRECTED ON REVIEW — there is no WORKSPACE tier for git, and these panels drew one

**Caught by Yue, and it is this amendment's own subject rather than a detail.** The
first pass added Panels 6–7 at the organisation tier and left the surviving panels
saying **Settings → Workspace**, reading the card's _"does not redraw the panels
that survive"_ as _"do not touch them"_. That is the wrong reading: the card's
FIRST item is _"the page is the ORGANISATION's — its heading, its empty state and
its copy say organisation, not workspace"_. A panel's tier is not its layout.

**The story settles it in one line:** _"The `Git` row leaves the project rail, and
it does NOT go to Settings → Workspace. The workspace is the wrong tenant for the
same reason the project is: it is not where the repository lives."_ Three tenants,
and workspace is not one of them — **ORG** (the connection and the inventory),
**PROJECT** (which of the org's repositories this project works on), **USER** (your
own git account).

So every surviving panel is re-tiered: the heading is the shared shell's `Git`, the
copy is the organisation's, and the revoked panel's caption follows. Two pointers
that sent a reader to `Settings → Workspace → GitHub` — the Panel-5c no-matches
hint and its disconnected-error banner — now name the organisation, because the
destination they pointed at is deleted by this very story.

**And the RAIL went through three states, which is worth recording as three.** (1) A fictional
_Account / Workspace / Project_ grouping — invented, and caught by Yue. (2) A faithful drawing of
what `/settings/workspace/github` renders today — true, and still wrong, because it drew the surface
this story removes. (3) **No rail at all** — also wrong, in the third direction: it left the page
with no visible door, which is what Yue read off it. The rail these panels carry NOW is the
organisation settings nav **MOTIR-4673 panel 7 specifies**, `Git` active. It is not a drawing of
something shipped; it is a drawing of something designed, in the asset that designs it, cited here.

For the record, since two passes got this wrong in opposite directions — the
grouping never existed either: only `settings/project/` and `settings/account/`
have an area `layout.tsx`, only `projectSettingsNav.ts` and `accountSettingsNav.ts`
exist, and `SidebarNav` swaps to an area rail on exactly two predicates
(`isAccountSettingsPath`, `isProjectSettingsPath`), neither of which
`/settings/workspace/github` matches.

**The tell was in this run's own output.** The sibling amendment (MOTIR-4675) drew
the ACCOUNT settings rail straight from `accountSettingsNav.ts`, which has no
_Workspace_ group — so two assets touched in one pass disagreed about whether the
grouping existed, and nothing looked at them together.

**Three surviving panels were re-tiered, not merely re-labelled**, because the
four-tenants table sorts every surface and two of them were sorted wrong:

| what it drew                                                                           | why it moved                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Panel 2's **bound identity card** — avatar, `@login`, _Verified_, Disconnect           | `GithubIdentity` is `userId @unique`; it is the **USER** tenant. Drawing a personal credential on the ORGANISATION's page is this story's own tier confusion, pointed the other way. It is MOTIR-4675's, in `design/settings/`               |
| Panel 2's **Repositories card** (per-repo sync `Switch` + sync `Pill`)                 | Panel 6 IS the organisation's repository inventory, with each row's index state and `Used by N projects`. Two drawings of one list on one board is exactly the drift these assets exist to prevent — so this panel points at Panel 6 instead |
| Panel 4b's **identity row** (_"Identity still connected · repository access revoked"_) | Same tenant error. The FACT it existed to make legible — the grants are independent — is kept as a sentence, which is what the organisation's page owes; the ROW belongs to the account surface, where MOTIR-4675 draws exactly that state   |

**GitLab took the same treatment, and it is the harder half.** GitLab authorises
through ONE OAuth grant whose token is stored on the connection row itself
(`accessTokenEncrypted`), so the person who connected and the connection are more
entangled than GitHub's two independent grants. That makes _who authorised it_
part of the connection's own record — kept as a caption — and it does not make the
member's ACCOUNT the organisation's to manage.

### ⚠️ CORRECTED — the settings RAIL these panels drew does not exist

**Caught by Yue on review of this amendment, and it is the amendment's own subject.**
The surviving panels drew a settings sidebar grouped **Account / Workspace /
Project**, with the git surface active under _Workspace_. **There is no such
rail**, and the grouping asserted a TIER STRUCTURE the app does not have — which
matters here more than anywhere, because the tier is exactly what this amendment
moves.

Read off shipped reality rather than inherited:

| claim                                         | reality                                                                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a _Workspace_ settings area with its own rail | only `settings/project/` and `settings/account/` have an area `layout.tsx`; `settings/workspace/` has none                                                                                         |
| a workspace settings nav                      | only `projectSettingsNav.ts` and `accountSettingsNav.ts` exist; there is no workspace registry                                                                                                     |
| the rail swaps for this route                 | `SidebarNav` swaps on exactly two predicates — `isAccountSettingsPath` (`/settings/account*`) and `isProjectSettingsPath` (`/settings/project*`). **`/settings/workspace/github` matches neither** |

**The ROUTE is real; the RAIL was not.** `/settings/workspace/github` genuinely
exists, and it is under `workspace/` because `GithubInstallation { workspaceId }`
was workspace-scoped (MOTIR-891 · MOTIR-1931) — the very tier this amendment
moves. What renders there is the ORDINARY rail: the shell's primary rows, then
its **bottom section**, where the `Git` row is the door.

So the panels now draw that, and the bottom section is **cited, not
re-specified** — its design of record is
`design/shell/rail-bottom-section.mock.html`, and **MOTIR-4640** is the card that
removes the `Git` row from it once this story completes the tier move.

**How it got through, recorded because the reason is reusable.** The card says
this amendment _"does not redraw the panels that survive"_, and that was read as
covering the rail. It should not have: a panel's rail is a claim about the TIER,
and the tier is this card's subject. The tell was available in this run's own
output — the sibling amendment (MOTIR-4675) drew the ACCOUNT settings rail
straight from `accountSettingsNav.ts`, which has no _Workspace_ group, so two
assets touched in one pass disagreed about whether the grouping existed.

### Panel 6 — Settings → Organisation → Git: the INVENTORY

- **Shared chrome, composed not re-specified.** The provider `Segmented` (GitHub | GitLab) is
  `GitSettingsShell` + `ProviderSwitch`, and its markup and `.seg` rules are copied verbatim from
  `design/gitlab/gitlab.mock.html` so the two assets cannot drift.
- **The connection card** carries the organisation connection's lifecycle: the installed App, who
  installed it and when, a `Pill` (mint, badge-check) reading **Connected**, and the
  **Manage on GitHub** link-out. It is the org's, not a member's — the member's own
  `GithubIdentity` moved to the account tier (MOTIR-4675, `design/settings/`).
- **The inventory table** is the substantive addition — one row per connected repository:

  | column      | content                                                                                                                                         |
  | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
  | Repository  | repo glyph + `owner/name`, owner in `--el-text-secondary` (see the ink note below)                                                              |
  | Provider    | the provider mark + label — the inventory spans both, so the pressed Segmented does not answer this                                             |
  | Index       | a `Pill` in **all four** states: **Current** (mint, check) · **Stale** (peach, clock) · **Indexing…** (sky, dots) · **Never indexed** (neutral) |
  | Used by     | **`Used by N projects`**, drawn AT REST                                                                                                         |
  | _(actions)_ | **`Disconnect`** on both providers, with the VENUE on a second line — `happens on GitHub` / `happens here`                                      |

- **⚠️ THE LABEL NAMES THE ACT; A SECOND LINE NAMES THE VENUE. `Remove on GitHub` was WRONG, and
  wrong in the dangerous direction (Yue, 2026-09-05).** It reads as _"delete the repository FROM
  GitHub"_ — the destructive act Motir cannot perform and must never appear to offer. Two jobs were
  packed into one label, and the venue half won the reading.

  The fix is to split them: the button is **`Disconnect`** — the same word, on both providers,
  because **the act is the same and only the venue differs** — and the venue rides underneath in
  `--el-text-secondary` at 11px:

  | provider   | button         | second line         |
  | ---------- | -------------- | ------------------- |
  | **GitHub** | `Disconnect` ↗ | `happens on GitHub` |
  | **GitLab** | `Disconnect`   | `happens here`      |

  Three things follow, and each is a reason the split is better than a re-word:
  - **`happens on GitHub` cannot be misread as an object.** "Happens" names where the ACT occurs;
    `on GitHub` alone, stacked under `Disconnect`, would re-form the same sentence and the same
    misreading.
  - **GitLab gets a line too, and it is not filler.** `happens here` is the information a person
    actually wants before clicking: this one is immediate and in-app, that one takes you out. Drawn
    as a pair, the two rows teach the difference; drawn with only one annotated, the blank reads as
    an oversight.
  - **The external-link glyph stays on the GitHub button** — the conventional out-of-app signal,
    now reinforced rather than carrying the whole weight.

  **The caption belongs to the MIXED table only.** It exists to disambiguate, so it earns its place
  where the rows actually differ — Panel 6's inventory, which spans both providers. On the
  GitLab-arm's single-provider `Projects` card (`design/gitlab/` Panel 7) every row is in-app, so a
  `happens here` on each would be uniform noise; the card's own subtitle is the right place for it
  there if it is wanted at all. **Same word on the button in both assets either way** — that is the
  half that must not drift.

  The same rename lands on **Panel 7's disclosure head**: `Remove moooon/motir-ai on GitHub` →
  **`Disconnect moooon/motir-ai from the organisation`**, which is also what GitLab's confirm
  already said (`Disconnect moooon/motir-gateway from the organisation?`). The two arms now name
  one act and differ only in the affordance the venue forces.

- **⚠️ `Used by N projects` is a COLUMN, not a sentence, and it is the whole disclosure
  mechanism.** A warning inside a dialog is read past; a count that was on screen all along is not,
  and the dialog naming _Atlas, Beacon_ is then a confirmation rather than a revelation. It is drawn
  **collapsed** (chevron-right, rows 1 / 3) and **expanded** (chevron-down, row 2 — the project
  names as neutral chips, in place, not a link out of the page).
- **A repository used by ZERO projects is drawn** (`design-system`, _Used by no project yet_). That
  is a **legal state**: the repository belongs to the organisation, stays in the inventory and keeps
  its index, so the next project that adds it pays nothing. The card foot says so. An asset that
  omitted this row would invite the _"nothing uses it, drop the graph"_ optimisation the story
  forbids.
- **Layout.** The row is a **CSS grid**, not a flex row, and the head shares the same template. A
  flex item's `min-width` is `auto`, so an over-long button in a later column silently steals from
  the repository name; the grid gives the name column a floor. The shell is drawn at **1100px** —
  the same settings shell as Panels 1–2 measured at a desktop width, not a different one.
- **⚠️ Ink — the one place this amendment deliberately differs from Panel 2.** The inventory row's
  owner segment is **`--el-text-secondary`**, where `repo-row .r-owner` two panels up is
  `--el-text-muted`. The difference is the **hover tint**, not a style choice: the inventory row
  tints to `--el-surface`, on which `--el-text-muted` measures **4.17:1** and fails AA, while the
  resting-only Panel-2 row keeps its muted ink on the white card at 4.54:1. `--el-text-secondary` is
  6.24–6.80:1 on both, so it is right in either state.
  **And an override under the `:hover` selector does NOT satisfy the guard** —
  `tests/design-state-ink-contrast.test.ts` resolves the ink from the RESTING rule and the surface
  from the state, so the resting declaration is the one that has to be safe.

### Panel 7 — the ORG-LEVEL removal, GitHub arm: the disclosure comes BEFORE the link-out

- **Motir cannot remove a GitHub repository.** Selection is the App's install screen, and
  `github.repos.foot` already says so. Once the admin is on github.com there is no dialog left to
  show them — **so the org-wide consequence is stated on the way out**, in an in-app disclosure whose
  primary action is `Continue on GitHub ↗`.
- It **names every affected project** (_Atlas_, _Beacon_) and states the retention truthfully: the
  code index is kept **30 days**, re-selecting the repository before then cancels the removal, and
  only after that is it swept.
- **⚠️ It is NOT a permanence warning.** `CODE_GRAPH_RETENTION_WINDOW_DAYS` is user-facing,
  `repo_disconnected` is windowed, and the shipped copy already promises that re-selecting cancels
  the removal. A screen saying _"this cannot be undone"_ would be **false**, and false in the
  direction that teaches people to click through warnings.
- **⚠️ The number is an INTERPOLATION and must never be retyped.** The `30` in the mock is the
  rendered value of `{days}` bound to `CODE_GRAPH_RETENTION_WINDOW_DAYS`
  (`lib/codeGraph/offboarding.ts`, which states that rule itself) — exactly as the shipped
  `github.repos.codeIndex` string already binds it.
- **The two removals are visibly different affordances**, and that is the point:

  |                  | **GitHub (Panel 7, here)**                           | **GitLab (`design/gitlab/` Panel 7)**      |
  | ---------------- | ---------------------------------------------------- | ------------------------------------------ |
  | who performs it  | github.com                                           | Motir, in-app                              |
  | shape            | a **disclosure** — facts, then a link-out            | an ordinary **destructive confirm** dialog |
  | primary action   | `Continue on GitHub ↗` (accent fill, external glyph) | `Disconnect` (danger fill)                 |
  | when it is shown | **before** leaving, because there is no later moment | at the moment of the act                   |

  The **project-level** removal is neither of these — it is a quiet row action whose copy reassures
  (_"Removes it from this project only…"_) — and it belongs to `design/repository-set/`
  (**MOTIR-4674**), not here.

### Per-element `--el-*` roles added by this amendment

| Element                                       | Token(s)                                                                                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| provider `Segmented` track / option / pressed | `--el-tabnav-track` · `--el-text-secondary` · pressed `--el-page-bg` + `--el-text-strong` + `--shadow-subtle`, glyph `--el-tabnav-active`                               |
| inventory head row                            | `--el-text-eyebrow` on `--el-card`, rule `--el-border-soft`                                                                                                             |
| inventory row · its hover tint                | `--el-card` → `--el-surface` on hover; rule `--el-border-soft`                                                                                                          |
| repository name · owner segment               | `--el-text` · **`--el-text-secondary`** (never `--el-text-muted` — the hover tint, above)                                                                               |
| index-state pills                             | `--el-tint-mint` / `--el-tint-peach` / `--el-tint-sky` + `--el-text-strong`; _Never indexed_ is the neutral `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary` |
| `Used by N projects` control + its chevron    | `--el-text-secondary` · glyph `--el-icon-muted`                                                                                                                         |
| project chips (expanded)                      | `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`, radius `--radius-badge`, padding `--spacing-chip-*`                                                        |
| org-removal row action                        | the shipped danger-ghost: text `--el-danger` on border `--el-border`                                                                                                    |
| disclosure card                               | `--el-card` / `--el-border` / `--radius-card` / `--shadow-elevated`; foot `--el-surface-soft`                                                                           |
| disclosure fact rows                          | glyph `--el-icon-muted`, body `--el-text-secondary`, emphasis `--el-text`                                                                                               |
| disclosure primary action                     | fill `--el-accent` · ink `--el-accent-text`                                                                                                                             |

Shape flows only through element-semantic tokens (`--radius-card` / `--radius-badge` /
`--radius-control` / `--radius-btn`; `--spacing-card-padding` / `--spacing-control-*` /
`--spacing-chip-*`; `--height-btn-sm` / `--height-control`). No Tier-0 `--color-*`, no raw
`rounded-*` / `p-*` / `h-*`, no invented hue.

### Primitives composed — still no new design-system entry

`Card` · `Pill` (existing `status` / `severity` / `tone` axes only) · `Button`
(`primary` / `secondary` / `ghost` / danger-ghost) · `Segmented` (via `GitSettingsShell`'s
`ProviderSwitch`) · `SectionLabel` · the settings-area shell. The inventory table is a composition
of `Card` + rows, not a new primitive; the disclosure is `Card` + `Button`s, not a new dialog
component.
