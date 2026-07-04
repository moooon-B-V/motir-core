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

- **Settings surfaces (Panels 1–2):** the settings rail shows a **GitHub** row
  (github mark icon) **active** under the **Workspace** group, with the
  breadcrumb `Settings › Workspace › GitHub`. The reader SEES the entry
  affordance, not just a route named in prose.
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

### Panel 1 — Settings → Workspace → GitHub, NOT connected

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
- Caption: "Linked automatically when a branch or PR mentions `MOTIR-891`."

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
- **Already-linked PRs are listed, annotated, and pickable — the explicit
  takeover.** A PR linked elsewhere shows a neutral chip **"Linked to
  MOTIR-<n>"** in place of its state pill; picking it MOVES the link (single
  FK — `workItemId` points at one item). This IS the mis-link correction path:
  there is deliberately **no per-row unlink** — an unlinked PR would just be
  re-resolved by the next webhook event for it, so "unlink" would silently
  fight the auto-resolver; moving the link from the RIGHT item is stable.
  (MOTIR-1596 encodes: re-link allowed, no confirm dialog — the annotation makes
  the move explicit before the pick.)
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
- **No matches** — "No matching pull requests" + the hint line "Repositories
  sync in Settings → Workspace → GitHub." (`--el-text-identifier`) — the road
  to the fix when the repo was never selected on GitHub.
- **Typed error** — `LinkAddForm`'s rose banner (strong text on
  `--el-tint-rose`, alert glyph `--el-danger` — finding #35): e.g. the
  disconnected workspace ("GitHub isn't connected for this workspace. Connect
  it in Settings → Workspace → GitHub."). Loading reuses the Combobox spinner.

**Copy — the `github` i18n namespace (all locales, en+zh parity):**
`development.title` "Development" · `development.gloss` "Linked pull requests ·
live PR and CI status" · `development.linkPr` "Link pull request" ·
`development.linkPrField` "Pull request to link" · `development.searchPlaceholder`
"Search pull requests…" · `development.typeToSearch` "Type to search pull
requests" · `development.noMatches` "No matching pull requests" ·
`development.noMatchesHint` "Repositories sync in Settings → Workspace →
GitHub." · `development.linkedTo` "Linked to {key}" · `development.linkedManually`
"linked manually" · `development.linkAction` "Link" · `development.notConnected`
"GitHub isn't connected for this workspace. Connect it in Settings → Workspace →
GitHub." · `development.autoLinkCaption` "Linked automatically when a branch or
PR mentions {key} — or linked by hand from here." (cancel = the shared
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

| Element                                     | Token(s)                                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Page / body                                 | `--el-page-bg` · `--el-page-text`                                                                                                                                                          |
| Settings sidebar                            | `--el-sidebar-bg` · `--el-sidebar-border` · active row `--el-sidebar-item-bg-active`                                                                                                       |
| Nav icons                                   | `--el-icon-muted` (idle) · `--el-icon-active` (active row)                                                                                                                                 |
| Card surface / border                       | `--el-card` · `--el-border` · `--el-border-soft` (dividers)                                                                                                                                |
| Primary text / secondary / muted / subtitle | `--el-text` · `--el-text-secondary` · `--el-text-muted` · `--el-text-subtitle`                                                                                                             |
| Eyebrow / section labels                    | `--el-text-eyebrow`                                                                                                                                                                        |
| Identifier (MOTIR-891)                      | `--el-text-identifier`                                                                                                                                                                     |
| Primary button ("Connect / Reconnect")      | fill `--el-accent` · ink `--el-accent-text`                                                                                                                                                |
| Secondary button ("Manage on GitHub")       | text `--el-text` · border `--el-button-border`                                                                                                                                             |
| Disconnect (danger-ghost)                   | text `--el-danger` · border `--el-border`                                                                                                                                                  |
| Grant-row icon badge                        | `--el-card-icon-bg` / `--el-card-icon-fg`                                                                                                                                                  |
| PR-state / CI-state / sync-state pills      | tints `--el-tint-{sky,mint,rose,peach}` + `--el-text-strong`; neutral pill `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`                                                     |
| Switch (repo sync)                          | track on `--el-switch-on` · off `--el-muted` + `--el-border-strong` · knob `--el-switch-knob`                                                                                              |
| Branch chip (`main`)                        | `--el-code-bg` / `--el-code-text`                                                                                                                                                          |
| PR row surface                              | `--el-surface` + `--el-border`                                                                                                                                                             |
| Danger callout (revoked)                    | bg `--el-danger-surface` · text `--el-danger-surface-text` · left rule + icon `--el-danger`                                                                                                |
| "Verified" pill                             | `--el-tint-mint` + `--el-text-strong`                                                                                                                                                      |
| Type pill (Subtask)                         | `color-mix(--el-type-subtask 16%, --el-surface)` + dot `--el-type-subtask` + `--el-text-strong`                                                                                            |
| GitHub avatar fallback                      | `--el-avatar-fallback`                                                                                                                                                                     |
| "+ Link pull request" door (Panel 5)        | text `--el-link` · radius `--radius-control`                                                                                                                                               |
| Link form box (LinkAddForm)                 | bg `--el-surface-soft` · border `--el-border` · radius `--radius-card` · field eyebrow `--el-text-eyebrow`                                                                                 |
| Combobox search input                       | bg `--el-page-bg` · border `--el-border` · radius `--radius-input` · height `--height-control` · placeholder `--el-text-muted`                                                             |
| Combobox popover / option rows              | popover `--el-page-bg` + `--radius-card` + `--shadow-elevated`; option `--radius-control` + `--spacing-control-*`, active `--el-option-active-bg`; option meta `--el-text-identifier` (AA) |
| "Linked to MOTIR-n" takeover chip           | neutral pill `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`                                                                                                                   |
| Typed-error banner (form)                   | bg `--el-tint-rose` · text `--el-text-strong` · icon `--el-danger` (finding #35)                                                                                                           |

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
