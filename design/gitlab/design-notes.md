# Design notes — GitLab integration surfaces

**Story 7.23 · MOTIR-1472 (design gate, Principle #13).** The design reference for
every UI-touching subtask in the GitLab-integration Story — the connect/settings
UI + project selection (**MOTIR-1478**) and the work-item MR/pipeline status
surface. **Mirror of 7.10 (GitHub · [`design/github/`](../github/design-notes.md),
MOTIR-889):** GitLab is the **second provider behind the shared `GitProvider`
seam** (`lib/git/provider.ts` + `lib/git/types.ts`), so the two providers render
through ONE shared connect-settings surface — **provider is a variant, not a
separate look** (the card's requirement). This asset REUSES the GitHub asset's
chrome verbatim and swaps only the provider content.

- **Asset of record:** [`gitlab.mock.html`](./gitlab.mock.html) — the source of
  truth (built from the real design system; the `--el-*` + shape token block is
  copied **verbatim** from `design/github/github.mock.html` /
  `packages/design-system/theme.css`, so a `data-palette` / `data-style` swap and
  dark mode re-skin this mock exactly as they re-skin the app). Its `.png` export
  ([`gitlab.png`](./gitlab.png)) is the board/PR-visible face.
- **Definition of done (three files):** `design-notes.md` + `gitlab.mock.html` +
  `gitlab.png`. All three are committed.

---

## Designed against SHIPPED REALITY — the honest GitHub→GitLab differences

This is **not a re-skin of GitHub copy**. GitLab's connect model genuinely
differs, and the design reflects how GitLab actually works. Grounded in the 7.23
subtree (rung-2 — the plan's own decided shape, not a hunch):

| Concern               | GitHub (7.10, shipped)                                                                         | GitLab (7.23, this design)                                                                                                                   | Grounding                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Connect**           | TWO grants — OAuth identity + a separate GitHub-**App installation**                           | **ONE OAuth authorization** — the `api` scope covers identity, project API access, and webhook creation                                      | MOTIR-1473 "register the Motir GitLab **OAuth application**"; MOTIR-1474 "GitLab **OAuth identity** + project model" |
| **Project selection** | On GitHub's own install screen — the UI links out (**"Manage on GitHub"**)                     | **In-app** — the OAuth token can enumerate + webhook the user's projects, so Motir lists them and the user connects them **here** (Panel 2b) | MOTIR-1478 "connect/settings UI + **project selection**"; the OAuth `api` scope                                      |
| **Change request**    | Pull Request, `#123`                                                                           | **Merge Request (MR)**, `!123`                                                                                                               | GitLab's model; `NormalizedChangeRequest` is provider-agnostic — only the label swaps                                |
| **CI**                | "Checks" (check runs)                                                                          | **Pipeline** (passed / running / failed)                                                                                                     | MOTIR-1477 "subtask **pipeline** (CI) feedback loop"                                                                 |
| **Account**           | org / user                                                                                     | **group / namespace**                                                                                                                        | `NormalizedInstallation` — "a GitHub org/user, a GitLab group" (`lib/git/types.ts`)                                  |
| **Revoke**            | Independent grants — identity survives an App uninstall (the "identity still connected" panel) | **Single grant** — revoking the OAuth authorization removes identity AND access together; the revoked state is a whole-connection Reconnect  | GitLab OAuth is one authorization                                                                                    |

**Self-managed GitLab (a custom instance URL) is OUT OF SCOPE for this pass and
is NOT drawn.** MOTIR-1473 registers **one** OAuth application (gitlab.com); no
instance-URL field appears on the connect surface. Drawing one would invent
architecture the plan hasn't decided (the mistake-#31 class — improvising an
element the mockup shouldn't specify). It is a clean future extension (a
gitlab.com-vs-self-managed choice on Panel 1, exactly the shape Plane's
self-hosted base URL took in MOTIR-1656) — flagged here, not built. If 7.23
later decides self-managed is in scope, that is a follow-up design pass, not an
improvisation at build time.

---

## Placement — resolved from shipped reality, not assumed

Same as GitHub: the integration is **workspace-scoped** (the connection binds to
the workspace; the token store is workspace-keyed via the seam's
`NormalizedInstallation`), so it lives under **Settings → Workspace**, the shipped
settings-area shell (`app/(authed)/settings/workspace/*`).

**The shipped standalone "GitHub" nav row + `settings/workspace/github` page
become the SHARED "Git" surface** (the 7.23.7 migration). Because 7.23.7's AC is
explicit — _"the SHARED provider connect-settings component (GitHub | GitLab as
variants), **not a separate page**"_ — GitLab does **not** get its own second nav
row. Instead:

- The **rail row is "Git"** (git-branch icon), hosting the shared surface. The
  shipped GitHub connect content becomes the **GitHub variant** of it (Panel 6
  shows that variant rendering under the same shell — proof that the chrome is
  shared).
- A **provider `Segmented`** control [GitHub | GitLab] sits under the page header;
  selecting a provider swaps the connect panel below. This is the "provider
  picker where they share chrome" the card names.
- This is a **derived** placement decision (rung-2, from 7.23.7's AC), so guard
  #4 of the design-against-shipped-reality rule ("surface an undecided
  architecture choice") does **not** fire — the plan already decided a shared
  surface; the design realizes it.

### Access path (the door — drawn, not just named)

- **Settings surfaces (Panels 1–2):** the settings rail shows the **Git** row
  (git-branch icon) **active** under the **Workspace** group, breadcrumb
  `Settings › Workspace › Git`; the provider `Segmented` [GitHub | GitLab] is the
  in-page door to the GitLab variant. The reader SEES the entry affordance.
- **In-app project picker (Panel 2b):** the door is the quiet **"+ Connect a
  project"** `link-cta` in the Projects card footer, expanding the LinkAddForm
  picker — the GitLab-specific affordance that GitHub delegates to its install
  screen.
- **MR/pipeline surface (Panels 3–5a):** the **Development** section materialises
  on the work-item detail (peek) automatically once a branch/MR references the
  item's `MOTIR-<n>` id — the door is the section itself appearing on the issue.

---

## The connect model — ONE OAuth authorization (the copy must get this right)

Panel 1 explains GitLab's single grant in two rows (chrome shared with GitHub's
`grant-row`, but the meaning is honest to GitLab):

**Step 1 · Authorize — "Connect your GitLab account"** (icon: key)

> Authorize Motir on GitLab in one step. This confirms who you are and grants API
> access to the projects you're a member of — Motir reads merge requests and
> pipelines and adds webhooks only on the projects you connect next. **One grant
> covers identity and access** — there's no separate app to install.

Scope chips shown (mono `--el-code-*`): `read_user` · `read_api` · `api`. (The
final impl picks the minimal scope set MOTIR-1474 needs; `api` is shown because
webhook creation + MR/pipeline reads require it.)

**Step 2 · Projects — "Choose projects in Motir"** (icon: repo)

> After you authorize, pick which of your GitLab projects to sync — right here in
> Motir, not on a separate screen. Motir only touches the projects you connect,
> and you can disconnect any of them any time.

Card-foot helper: "You'll be sent to GitLab to authorize, then choose projects
here." Primary CTA **"Connect GitLab"** (GitLab mark).

**Why not two literal grants like GitHub?** GitHub needs the App installation as
a _second_ OAuth-independent grant because repo access on GitHub is granted at
install time on GitHub's screen. GitLab's OAuth `api` scope already conveys
project access + webhook rights in the same authorization, so faking a second
"install" step would misrepresent the flow. Step 2 is not a second _grant_ — it's
the in-app _selection_ the single grant enables.

---

## Panels & primitives (every panel — the multi-panel rule, mistake #31)

### Panel 1 — Settings → Workspace → Git, GitLab tab, NOT connected

- **Settings-area shell** (sidebar rail + content) — the shipped area layout.
  Rail groups Account / Workspace (**Git active**) / Project.
- **`Segmented`** provider picker [GitHub | GitLab], GitLab pressed
  (`aria-pressed`) — the shipped `Segmented` token mapping (track
  `--el-tabnav-track` + `--radius-btn` + 2px inset; active segment `--el-page-bg`
  raised fill + `--shadow-subtle`, active glyph `--el-tabnav-active`).
- **`Card`** ("Connect GitLab") with `card-head` + `card-body` + `card-foot`.
- Two **`grant-row`**s (key icon / repo icon), the OAuth scope chips, and the
  primary **`Button`** "Connect GitLab" (GitLab mark).

### Panel 2 — connected, the project-selection list

- **Identity `Card`:** GitLab-identity **avatar** (real `avatarUrl` `<img
object-cover>`) + `@zhuyue` + a **`Pill` (severity=success / mint)** "Verified"
  (badge-check) + caption "GitLab identity · connected as Zhu Yue". A **`Button`
  danger-ghost sm** "Disconnect". Card-foot: "Connected to **gitlab.com** · group
  `moooon`" + an **"Open GitLab"** external link (there is NO "Manage access on
  GitLab" — selection is in-app, so it links only to the account, not an install
  screen).
- **Projects `Card`:** `SectionLabel`-style head "Projects" + caption. Each
  **`repo-row`**: repo icon + `namespace/name` (namespace muted; GitLab paths can
  nest, e.g. `moooon/infra/runner-config`) + a **`branch-chip`** (default branch)
  - a **sync-state `Pill`** + a **`Switch`** (`role="switch"`). Sync states:
    **Synced** (mint, check), **Syncing…** (peach, pipeline-run glyph), **Paused**
    (neutral, switch off). Card-foot: "Connecting a project adds a webhook for
    merge-request and pipeline events." + the **"+ Connect a project"** `link-cta`.

### Panel 2b — the in-app project picker (the honest inverse of GitHub's install screen)

Reuses the shipped relationships-panel grammar (LinkAddForm surface-soft box +
query-driven `Combobox`), applied to GitLab projects:

- Field label **"Add a GitLab project"**, a search **`combo-input`**, and a
  **`combo-pop`** of **`pr-opt`** rows: repo icon + `namespace/name` + a meta slot
  showing the user's **role** on that project (Maintainer / Developer). An
  **already-connected** project shows a neutral **"Connected"** `Pill` in place of
  the role (annotated, non-pickable-as-new). Actions: **`Button` sm primary
  "Connect"** + **sm ghost "Cancel"**.
- Caption: "Only projects you're a member of on GitLab appear here — Motir can't
  see any others." (the honest scope boundary — the OAuth token only reaches the
  user's memberships).

### Panel 3 — a work item's MR/pipeline status surface (Development section)

- Issue-detail **peek header** (`type-pill` Subtask + `peek-id` MOTIR-1474) +
  title.
- **`SectionLabel`** "Development", then linked-MR **`pr-row`**s. Each: an MR glyph
  (open/merge/closed) + MR title + `pr-meta` (a small **provider mark** +
  `namespace/project · !<number>` — GitLab's `!`, `--el-text-identifier`) + an
  **MR-state `Pill`** + a **pipeline-state `Pill`** + an external-link. Three rows
  cover every state pair:
  - **!128** Open + Pipeline running → `pill-sky` + `pill-peach`
  - **!131** Merged + Pipeline passed → `pill-mint` + `pill-mint`
  - **!119** Closed + Pipeline failed → `pill-rose` + `pill-rose`
- Caption: "Linked automatically when a branch or merge request mentions
  `MOTIR-1474`."

### Panel 4 — CONSISTENCY: two providers, one Development section

The card's explicit requirement — _"the two providers render consistently."_
Shown literally: one work item (MOTIR-1476) with **both** a GitLab MR (`!140`) and
a GitHub PR (`#212`) linked in the **same** Development section, the **same**
`pr-row` + pill grammar. They are distinguished ONLY by (a) the leading
**provider mark** in the meta and (b) the `!` vs `#` number grammar — never by a
different layout. The CI pill label follows the provider ("Pipeline passed" for
GitLab, "Checks running" for GitHub) while the tone table is identical. This is
the Motir-project-spans-multiple-repos reality (a project can link repos on both
hosts).

### Panel 5 — empty + revoked error

- **5a — no linked MR:** the Development section renders the shipped
  **`EmptyState`** — MR glyph, title **"No linked merge request"**, quiet copy
  naming `MOTIR-1475`.
- **5b — settings revoked error** (OAuth authorization removed on GitLab): a
  **danger `callout`** (`callout-danger`, alert icon) —

  > **Motir's GitLab access was revoked.** The authorization was removed on
  > GitLab, so Motir can no longer read your projects or receive merge-request and
  > pipeline updates. Your synced work items keep their last-known status.
  > Reconnect to restore sync.

  The card header carries a **`Pill` rose** "Disconnected"; a **`Button` primary**
  "Reconnect GitLab". **No "identity still connected" split** (unlike GitHub Panel
  4b) — GitLab's single grant means revocation removes identity too, so the whole
  connection is gone until Reconnect.

### Panel 6 — provider is a variant (shared chrome)

The **same** shell with the **GitHub tab active** renders the shipped GitHub
variant (identity card + "Manage on GitHub" + the two-grant model), proving the
chrome is shared and only the provider content swaps. Caption states the contrast
plainly (GitHub: two-grant / Manage-on-GitHub; GitLab: one OAuth / in-app
selection).

---

## Pill MR/pipeline tone mapping (identical to the GitHub tone table — no new token)

The shipped `Pill` has **no built-in MR/pipeline tone**, and the AC forbids
inventing a design-system entry inside this Story, so states **map onto existing
semantic axes** — the SAME table `design/github` established, so the two providers
render identically:

| Surface  | State       | Pill prop              | Tint token        | Rationale                                    |
| -------- | ----------- | ---------------------- | ----------------- | -------------------------------------------- |
| MR state | **Open**    | `status="in-progress"` | `--el-tint-sky`   | in-flight, matches Motir's "In Progress" hue |
| MR state | **Merged**  | `status="done"`        | `--el-tint-mint`  | terminal success, matches "Done"             |
| MR state | **Closed**  | `severity="danger"`    | `--el-tint-rose`  | closed unmerged = abandoned                  |
| Pipeline | **passed**  | `severity="success"`   | `--el-tint-mint`  |                                              |
| Pipeline | **failed**  | `severity="danger"`    | `--el-tint-rose`  |                                              |
| Pipeline | **running** | `severity="warning"`   | `--el-tint-peach` |                                              |

Maps cleanly onto the seam's `ChangeRequestState` (`open`/`closed` + `merged`
flag) and `CiConclusion` (`success`/`failure`/`pending`/`neutral`). A merged MR
(mint) beside a passed pipeline (mint) is intentionally both-green; the two pills
stay distinguishable by leading glyph (git-merge vs check) and label. Every tint
carries the hue in the **background** with `--el-text-strong` text (finding #35 /
AA). GitLab's `canceled`/`skipped`/`pending` pipeline states (not drawn) map to
the neutral `pill-neutral` / `severity="warning"` slots the same way — no new
token.

> **Note for MOTIR-1478 / MOTIR-1477:** render these with the shipped `<Pill>`
> using the props above and REUSE the shipped `PR_STATE_META` /
> `CI_STATE_META` mapping in `components/github/DevelopmentSection.tsx` — do not
> add an MR/pipeline-specific tone. If a genuinely distinct GitLab colour is later
> wanted, that is a NEW `design/` subtask that adds an `--el-*` token + Pill
> variant, never an inline hue.

---

## Per-element `--el-*` colour roles

Identical to `design/github/design-notes.md` (same primitives, same tokens); the
GitLab-specific additions:

| Element                                              | Token(s)                                                                                                                                                                                                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider `Segmented` track / active segment          | track `--el-tabnav-track` + `--el-border`; active `--el-page-bg` + `--shadow-subtle`; active glyph `--el-tabnav-active`; idle glyph `--el-text-faint`                                                                                                    |
| Page / body                                          | `--el-page-bg` · `--el-page-text`                                                                                                                                                                                                                        |
| Settings sidebar                                     | `--el-sidebar-bg` · `--el-sidebar-border` · active row `--el-sidebar-item-bg-active`                                                                                                                                                                     |
| Nav icons                                            | `--el-icon-muted` (idle) · `--el-icon-active` (active "Git" row)                                                                                                                                                                                         |
| Card surface / border                                | `--el-card` · `--el-border` · `--el-border-soft` (dividers)                                                                                                                                                                                              |
| Text (primary/secondary/muted/subtitle/eyebrow)      | `--el-text` · `--el-text-secondary` · `--el-text-muted` · `--el-text-subtitle` · `--el-text-eyebrow`                                                                                                                                                     |
| Identifier (`namespace/project · !128`, `MOTIR-<n>`) | `--el-text-identifier`                                                                                                                                                                                                                                   |
| Primary button ("Connect / Reconnect GitLab")        | fill `--el-accent` · ink `--el-accent-text`                                                                                                                                                                                                              |
| Disconnect (danger-ghost)                            | text `--el-danger` · border `--el-border`                                                                                                                                                                                                                |
| "+ Connect a project" / "Open GitLab" links          | `--el-link`                                                                                                                                                                                                                                              |
| Grant-row icon badge (key / repo)                    | `--el-card-icon-bg` / `--el-card-icon-fg`                                                                                                                                                                                                                |
| OAuth scope chips / branch chip                      | `--el-code-bg` / `--el-code-text`                                                                                                                                                                                                                        |
| MR-state / pipeline-state / sync-state pills         | tints `--el-tint-{sky,mint,rose,peach}` + `--el-text-strong`; neutral pill `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`                                                                                                                   |
| Switch (project sync)                                | track on `--el-switch-on` · off `--el-muted` + `--el-border-strong` · knob `--el-switch-knob`                                                                                                                                                            |
| MR row surface                                       | `--el-surface` + `--el-border`                                                                                                                                                                                                                           |
| Danger callout (revoked)                             | bg `--el-danger-surface` · text `--el-danger-surface-text` · left rule + icon `--el-danger`                                                                                                                                                              |
| "Verified" pill                                      | `--el-tint-mint` + `--el-text-strong`                                                                                                                                                                                                                    |
| Type pill (Subtask)                                  | `color-mix(--el-type-subtask 16%, --el-surface)` + dot `--el-type-subtask` + `--el-text-strong`                                                                                                                                                          |
| GitLab avatar fallback                               | `--el-avatar-fallback`                                                                                                                                                                                                                                   |
| Combobox search / popover / option rows (Panel 2b)   | input `--el-page-bg` + `--radius-input` + `--height-control`; popover `--el-page-bg` + `--radius-card` + `--shadow-elevated`; option `--radius-control` + `--spacing-control-*`, active `--el-option-active-bg`; option meta `--el-text-identifier` (AA) |
| **Provider mark (GitLab tanuki / GitHub octocat)**   | **`currentColor`** — monochrome, matching the shipped `GithubMark` (`fill="currentColor"`), so NO invented brand hex enters the mock                                                                                                                     |

Shape flows only through element-semantic tokens: `--radius-card` (cards/panels),
`--radius-control` (rows, nav rows, icon badges, options), `--radius-badge`
(pills), `--radius-btn` (buttons + the Segmented track); padding via
`--spacing-card-padding` / `--spacing-control-*` / `--spacing-chip-*`; heights via
`--height-btn-*` / `--height-control`. No Tier-0 `--color-*`, no raw
`rounded-*`/`p-*`/`h-*`, no invented hex — verified (the only `#…` values in the
asset are the two non-semantic avatar-placeholder data-URIs and MR/PR numbers).
Dark-mode parity confirmed by toggling `data-theme="dark"`.

---

## Primitives composed — no hand-rolling (the 1.3.3 / 1.5.1 checklist)

Every element is a **shipped** design-system primitive; MOTIR-1478 composes these,
it does not build new ones — and it REUSES the GitHub connect components as the
provider-agnostic base (the shared surface), not a parallel copy:

- ✅ **`Card`** — connect card, identity card, projects card, EmptyState root, MR-row containers.
- ✅ **`Pill`** — MR state, pipeline state, project sync state, "Verified", "Disconnected", "Connected". Mapped onto existing `status` / `severity` / `tone` axes (table above).
- ✅ **`Button`** — `primary` (Connect / Reconnect GitLab), `danger`-ghost (Disconnect), `sm` (picker Connect / Cancel).
- ✅ **`Segmented`** — the provider picker [GitHub | GitLab] (`packages/design-system`).
- ✅ **`Switch`** (`role="switch"`) — per-project sync toggle.
- ✅ **`EmptyState`** — Panel 5a "No linked merge request".
- ✅ **`SectionLabel`** — "Projects", "Development", "Connect a project".
- ✅ **Avatar** — the GitLab identity uses the shipped `<img object-cover>` pattern (`AvatarField`) bound to the identity's `avatarUrl`; the initials disc (`MemberAvatar`) is the fallback.
- ✅ **Settings-area shell** — the shipped rail + content layout (`settings/*/layout.tsx` + `SidebarNav`).
- ✅ **`Combobox` + LinkAddForm grammar** — the Panel-2b in-app project picker reuses the shipped query-driven searchable picker + empty-listbox a11y handling.
- ✅ **`DevelopmentSection` / `PR_STATE_META` / `CI_STATE_META`** (`components/github/DevelopmentSection.tsx`) — the MR/pipeline rows REUSE this shipped component + tone mapping; MOTIR-1478/1477 make its labels provider-aware (PR↔MR, `#`↔`!`, "Open on GitHub"↔"Open on GitLab") rather than forking it.

**No new design-system entry is required.** If MOTIR-1478 finds it needs one
(e.g. a distinct pipeline colour, or a self-managed-instance field), that is a NEW
`design/` subtask — not a code workaround.

---

## Build seam notes (for MOTIR-1478 / MOTIR-1474 / MOTIR-1477)

- **The connect surface is the SHARED provider surface.** 7.23.7 refactors the
  shipped `settings/workspace/github` page into a provider-parameterised surface
  (the rail row becomes "Git"; a `Segmented` selects GitHub | GitLab; each renders
  its provider's connect state). The GitHub content is the existing page, moved
  under the shared shell — not duplicated.
- **Project selection is a real in-app write**, not a link-out: connecting a
  project (Panel 2b's Connect) registers the MR + pipeline webhook (MOTIR-1475);
  disconnecting (Panel 2's Switch off / row remove) removes it. Follow the
  page-state-after-mutation contract — the projects list is a server-rendered
  surface, so `router.refresh()` after connect/disconnect; if the picker is a
  client island, bump a tick.
- **Terminology swaps by provider, layout does not.** The Development section is
  provider-agnostic (one `pr-row`/pill component); only labels (`PR`↔`MR`,
  `#`↔`!`, "Checks"↔"Pipeline", "Open on GitHub"↔"Open on GitLab") vary. Thread the
  provider through the DTO so the same component renders both (Panel 4).
- **Self-managed GitLab is deferred** (see the honest-differences section) — do
  not add an instance-URL field unless a later design pass adds it.
