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

> ⚠️ **SUPERSEDED by the MOTIR-4672 amendment below (Story MOTIR-4669),** and kept
> because the DERIVATION is still the right method while its ANSWER is now false.
> The connection is ORGANISATION-scoped (MOTIR-4649), so the surface is **Settings
> → Organisation → Git** — _"the workspace is the wrong tenant for the same reason
> the project is: it is not where the repository lives."_ The **Workspace**-group
> rail row described below is gone with it; the door is the `Git` row in the
> organisation settings nav (MOTIR-4673 panel 7), with the org menu's row (panel 6)
> beside it. Verbatim:

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

- **Settings surfaces (Panels 1–2):** ⚠️ **re-tiered by MOTIR-4672.** The door is
  the **organisation settings nav** (`Git`, in the `general` group), specified by
  MOTIR-4673 panel 7 in `design/org-admin/`, with the **org menu**'s `Git` row
  (panel 6 there) as the fast door beside it. The panels draw that rail with `Git`
  active — the GitLab arm wears the SAME chrome as the GitHub arm, because it is
  one page with a provider Segmented and a rail on one but not the other would make
  it two. Its head reads `moooon · Organisation settings`, and the provider `Segmented`
  [GitHub | GitLab] is still the in-page door to the GitLab variant. It read: _"the
  settings rail shows the **Git** row (git-branch icon) active under the
  **Workspace** group, breadcrumb `Settings › Workspace › Git`"_ — a rail that never
  existed, at a tier that no longer does.
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

### Panel 1 — Settings → Organisation → Git, GitLab tab, NOT connected

> ⚠️ Re-tiered by MOTIR-4672. The panel's layout is unchanged; its TIER is not.

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
- Caption: "Linked by `link_pull_request` over the MCP or a `motir auto` session
  branch."

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

---

## ⚠️ AMENDMENT — MOTIR-4672 (Story MOTIR-4669), 2026-09-05: the tier moves, and this asset owns the GITLAB removal

**Panels 1–6 above keep their layout and are re-read at a new tier. Nothing in them is
redrawn.** A repository is connected **ONCE, to the ORGANISATION**; which projects use it is
visibility configuration — the rule MOTIR-2029 settles for the code graph, applied to the thing
the graph is built FROM.

**What that supersedes above.** Every _"Settings → Workspace → Git"_ placement reference reads
**Settings → Organisation → Git**, and the breadcrumb with it. The single-OAuth model, the in-app
project selection, the MR/pipeline vocabulary and the shared-`GitProvider`-seam argument are
untouched — the tier moved, the provider story did not.

**The org INVENTORY is drawn ONCE, and not here.** `design/github/github.mock.html` Panel 6 owns the
inventory table, its four index states and the `Used by N projects` column, because the inventory is
provider-agnostic and two drawings of one table drift. Panel 7 below repeats two rows of it only as
the surface the dialog opens FROM.

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
with no visible door. The rail these panels carry NOW is the organisation settings nav
**MOTIR-4673 panel 7 specifies**, `Git` active. It is not a drawing of something shipped; it is a
drawing of something designed, in the asset that designs it, cited here.

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

### Panel 7 — the ORG-LEVEL removal, GitLab arm: an in-app destructive confirm

- **GitLab is in-app, so Motir owns the act** — the OAuth token can enumerate and detach projects
  (the same property that makes Panel 2b's picker honest). The removal is therefore an ordinary
  **destructive confirm dialog**, shown at the moment of the act.
- **It names every affected project before it runs** (_Atlas_, _Corridor_), in a labelled
  `PROJECTS THAT LOSE IT` block — not a count, and not a link to go and find out. The count was
  already on the row behind it (`Used by 2 projects`), which is what makes this a **confirmation
  rather than a revelation**.
- It states the org-wide blast radius in the first sentence — _"removed from **every project in
  moooon**, not only the one you came from"_ — because the same word (_disconnect_) at the project
  tier means something an order of magnitude smaller.
- **⚠️ It is NOT a permanence warning.** The code index is kept **30 days**; re-adding the project
  before then cancels the removal and nothing re-indexes. `CODE_GRAPH_RETENTION_WINDOW_DAYS` is
  user-facing and `repo_disconnected` is windowed, so _"this cannot be undone"_ would be false — and
  false in the direction that teaches people to click through warnings.
- **⚠️ The number is an INTERPOLATION.** The `30` is the rendered value of `{days}` bound to
  `CODE_GRAPH_RETENTION_WINDOW_DAYS` (`lib/codeGraph/offboarding.ts`, which states that rule
  itself). Never retype it.

### Why the two arms look different — the asymmetry is drawn, not smoothed

|                  | **GitLab (here)**                                                                                   | **GitHub (`design/github/` Panel 7)**                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| who performs it  | Motir, in-app                                                                                       | github.com — selection is the App's install screen                                          |
| shape            | a **confirm dialog**, modal                                                                         | a **disclosure**, then a link-out                                                           |
| primary action   | `Disconnect` — `bg-(--el-danger)` fill with `--el-danger-text` ink, the ONE place that ink is legal | `Continue on GitHub ↗` — accent fill, external glyph                                        |
| when it is shown | at the moment of the act                                                                            | **before** leaving, because once the admin is on github.com there is no dialog left to show |

The **project-level** removal is neither — a quiet row action whose copy reassures — and it belongs
to `design/repository-set/` (**MOTIR-4674**).

**⚠️ The ROW BUTTON is the same word on both arms: `Disconnect` (Yue, 2026-09-05).** The GitHub arm
briefly said `Remove on GitHub`, which reads as _"delete the repository FROM GitHub"_ — the one act
Motir cannot perform and must never appear to offer. The act is identical on both providers; only
the venue differs, so the **label names the act and a second line names the venue**
(`happens on GitHub` / `happens here`, `--el-text-secondary` 11px). See `design/github/`
design-notes § _the label names the act_.

That second line belongs to **Panel 6's mixed inventory**, which spans both providers and is where
the rows genuinely differ. This asset's single-provider `Projects` card is uniformly in-app, so it
carries no per-row caption — the card's own subtitle is the place for it if it is wanted. **The
button's word must not drift between the two assets; the caption legitimately may.**

### Per-element `--el-*` roles added by this amendment

| Element                                | Token(s)                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| modal scrim / board recess             | `--el-canvas`, radius `--radius-card`                                                                                   |
| dialog panel                           | `--el-card` / `--el-border` / `--radius-modal` / `--shadow-modal`                                                       |
| dialog alert glyph                     | `--el-danger` (a graphic beside the label, which stays on `--el-text` — graphics need 3:1)                              |
| dialog body copy · emphasis            | `--el-text-secondary` · `--el-text`                                                                                     |
| affected-projects block                | `--el-surface-soft` + `--el-border-soft`, label `--el-text-eyebrow`                                                     |
| project chips                          | `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`, `--radius-badge`, `--spacing-chip-*`                       |
| retention sentence                     | `--el-text-secondary`, emphasis `--el-text`                                                                             |
| dialog foot                            | `--el-surface-soft`, rule `--el-border-soft`                                                                            |
| **`Disconnect` (destructive primary)** | fill `--el-danger` · ink **`--el-danger-text`** — legal here and ONLY here, because the element carries the danger FILL |
| inventory row (repeated for context)   | as `design/github/` Panel 6; owner segment `--el-text-secondary`                                                        |

### Primitives composed — no new design-system entry

`Modal` (radius + shadow tokens) · `Card` · `Pill` · `Button` (`ghost` + `danger`) · `Segmented` via
`GitSettingsShell`'s `ProviderSwitch` · the settings-area shell. Nothing new is invented; the dialog
is the shipped modal grammar with a named-projects block inside it.
