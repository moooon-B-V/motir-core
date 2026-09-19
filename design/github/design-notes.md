# Design notes — GitHub integration surfaces

**Story 7.10 · MOTIR-889 (design gate, Principle #13).** The design reference for
every UI-touching subtask in the GitHub-integration Story — the connect/settings
UI + repo selection (**MOTIR-895**) and the work-item PR/CI status surface. The
GitLab sibling (**MOTIR-1472**) mirrors this layout against the `GitProvider`
seam. **Extended by MOTIR-1595 (Panel 5):** the explicit item→PR link affordance
— the manual override of the MOTIR-892 auto-resolver — built by **MOTIR-1596**
on top of the Development display surface **MOTIR-1579** ships. **Extended by
MOTIR-5007 (Panels 5d–5f):** the door back OUT — REMOVING a linked pull request
from a row, its confirm, and the copy that says the pull request is untouched;
built by **MOTIR-5005**.

- **Asset of record:** [`github.mock.html`](./github.mock.html) — the source of
  truth (built from the real design system; the `--el-*` + shape tokens are
  copied verbatim from `packages/design-system/theme.css`). Its `.png` export
  ([`github.png`](./github.png)) is the board/PR-visible face.
- **Definition of done (three files):** `design-notes.md` + `github.mock.html` +
  `github.png`. All three are committed.
- **Second sheet (MOTIR-5480, 2026-09-15):**
  [`approve-and-merge.mock.html`](./approve-and-merge.mock.html) +
  [`approve-and-merge.png`](./approve-and-merge.png) +
  [`approve-and-merge.dark.png`](./approve-and-merge.dark.png) — the approve-and-merge verbs and
  their states (Panels 12p–12w), specified in §20 _The verbs and their states_. It carries
  `github.mock.html`'s own tokens, primitives and sprite sheet verbatim.
- **Delta sheet (MOTIR-5463, 2026-09-16):**
  [`github--fix-callout.mock.html`](./github--fix-callout.mock.html) — the Development block's red
  state (Panels F1–F4), specified in §21. It amends §20 and edits no existing mock; no image export
  ships (`docs/decisions/design-result.md` AMENDMENT 4).

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
    is OWED.** The old argument — that an unlink would be undone by the next
    webhook delivery — died with the title/branch parse (MOTIR-3674): nothing
    re-resolves an unlinked pull request any more. `unlinkPullRequest` ships on
    the service, and MOTIR-3756 adds the `unlink_pull_request` MCP tool for an
    agent that mis-linked one. Correcting a mis-link means REMOVING the wrong
    delivery; linking the right card only adds a second one beside it.

    **⚠️ CORRECTED (MOTIR-5007).** Where this bullet now reads _"ships on the
    service, and MOTIR-3756 adds…"_, it carried one more clause between those
    two halves: ~~this surface's row menu reaches it~~. **That clause was FALSE
    on the day it was written, and it stayed false for two weeks.**
    There was no row menu and no remove control: `PullRequestRow` drew one
    trailing action, the GitHub link-out, and
    `githubPullRequestService.unlinkPullRequest`'s only non-test caller was
    `lib/mcp/tools/unlinkPullRequest.ts`. The struck words are kept rather than
    deleted, because this is not a claim that drifted — it is one that was never
    true, and the next reader who meets `unlinkPullRequest` in the service needs
    to know that its presence there says nothing about this surface.
    - **How it got in, which is the part worth carrying.** MOTIR-3756's
      amendment was correcting a genuine error in the ARGUMENT above it, and it
      was correct to. What rode along in the same sentence was a claim about the
      SURFACE, written from inside MCP work where `unlink_pull_request` really
      had just shipped. Two facts, one sentence, one of them reasoned about:
      `unlinkPullRequest` on the service was real, and the row menu was not.
    - **What it cost.** The completion gate holds a card and tells the reader,
      in `changeRequestStatusSync.ts`, _"if one of them does not in fact deliver
      this item, unlink it"_ — an instruction a person could not follow. The only
      move left was to override the status by hand, which records that somebody
      disagreed with a gate rather than that a pull request was wrong
      (MOTIR-5005, found on MOTIR-4789). And a `motir run` that reached
      MOTIR-5005 met this bullet's confident prose beside a Panel 5a that drew
      none of it — which is worse than an asset that says nothing: silence stops
      a runner at the design gate, a claim sends them off to invent a glyph, a
      placement, a confirm and its copy.
    - **Panels 5d–5f below are the specification this sentence stood in for.**

  (MOTIR-1596 encodes: pick allowed, no confirm dialog — unchanged, and now for a
  simpler reason than the one it was written for.)

- **Actions:** `Button` **sm primary "Link"** (disabled until a pick) +
  **sm ghost "Cancel"** (collapses the form) — `LinkAddForm`'s exact button row.
- **After Link:** the form collapses and the row appears in the card
  (`router.refresh()` — the detail page's sections are server-rendered, the
  same mechanism `AddLinkControl` uses). The new row is drawn exactly like every
  other: `repo · #number`, and nothing else.

  > **⚠️ AMENDED BY MOTIR-4894 — the pr-meta line carries NO provenance suffix.**
  > This entry specified a quiet **"linked manually"** suffix on a hand-linked
  > row, and the section caption gaining "— or linked by hand from here". Both
  > are gone. The suffix was a CONTRAST with the MOTIR-892 auto-resolver, and
  > MOTIR-3674 deleted that resolver: `resolveChangeRequestWorkItemSet` has two
  > arms — a session branch and a stored delivery — and both are declared, so
  > every row on this surface qualified for the suffix and it separated nothing.
  > It also read backwards, because the ordinary linker is now an AGENT calling
  > `link_pull_request`, and the label said "manually" about it. (MOTIR-4064 had
  > already rewritten the captions for the same reason; this is the row.) Drawing
  > provenance again needs a fact the row does not carry — WHO declared the link
  > — which is a new field and a new decision, not this one restored.

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
Organisation → Git." · `development.linkedTo` "Linked to {key}" ·
`development.linkAction` "Link" · `development.notConnected`
"GitHub isn't connected for this organisation. Connect it in Settings →
Organisation → Git." · `development.autoLinkCaption` "Link with + Link pull request here, or
with `link_pull_request` over the MCP." (cancel = the shared
`common.cancel`).

**Plus the four REMOVE keys (MOTIR-5007):** `development.unlinkAria`
"Remove the link to {target}" · `development.unlinkConfirmBefore` "Remove the
link to" · `development.unlinkConfirmAfter` "? The pull request isn't touched on
GitHub — only the link." · `development.unlinkAction` "Remove link" — their `zh`
twins are in the en/zh table under _Panels 5d–5f_ below.

**Build seam (for MOTIR-1596):** MOTIR-1579 ships the pr-row component + the
peek read path; 1596 mounts the Development `ContentSectionCard` on the detail
page (server-rendered, `router.refresh()` page-state) and adds the
door + form + Server Action. The shipped `LinkAddForm` box uses a legacy raw
`rounded-md` — the new form uses the element-semantic token (`--radius-card`,
as mocked); do not copy the raw utility forward.

### Panels 5d–5f — REMOVING a linked pull request (MOTIR-5007 → gates MOTIR-5005)

Panel 5 gave this surface a door to LINK a pull request. **Nothing ever drew the
door back out**, and the amendment above claimed one existed. These three panels
are that door, and they invent no interaction either: the gesture is the shipped
`RemoveLinkButton` — a quiet `×` opening a confirm popover — which the
relationships panel has used for exactly this since Subtask 2.4.9, and which
`PullRequestRow`'s own comment already names.

**What was RENDERED before this was drawn.** `design/work-items/delivery-set.mock.html`
carries the shipped `PullRequestRow` reused markup-for-markup, produced by
bundling and screenshotting the real `DevelopmentSectionBody` (that asset's
notes, § _What this COMPOSES_). Its class strings were diffed against
`components/github/DevelopmentSection.tsx` at `origin/main` `1c5125eec` and match
byte for byte, so it is a current render, and it — not this asset's own hand-drawn
`.pr-row` — is the pixel reality the measurements below are taken from.

#### Q1 — WHICH surface carries the control: the detail page ONLY

**This is not a new decision; it is Panel 5's decision applied to the second
write on the same surface.** The peek's shipped contract is _"Read-only — editing
lives on the full page"_ (`IssueQuickViewPanel`, whose one write path is _Open
full page_), and Panel 5 declined to put the LINK affordance there because it
_"would be a second write path — a per-surface interaction deviation of exactly
the mistake-#139 class."_ A remove is a write, and a destructive one. Every word
of that argument applies unchanged and more strongly.

- **Peek (Panels 3 / 4a): unchanged, display only.** A reader who wants to
  retract a link reaches it the way they reach every other edit — **Open full
  page**.
- **Detail page (Panel 5a): the control ships**, on every linked-PR row.

#### Q2 — WHERE it sits, and the measurement that makes it fit

**LAST in the row, after the link-out.** That is the relationships panel's own
order — the destructive action terminates the row (`links.mock.html` panel 4) —
and it leaves the link-out where readers already reach for it.

The control is the shipped one, and these are its numbers rather than an
approximation of them:

| what                | value                                         | source                                                                                                                                                                                                                       |
| ------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| box                 | **24 × 24**, `inline-flex`, centred           | `RemoveLinkButton.tsx` `h-6 w-6`                                                                                                                                                                                             |
| radius              | `--radius-control`                            | same                                                                                                                                                                                                                         |
| glyph               | lucide **`X`** — the PLAIN cross, **15 × 15** | same, `h-[15px] w-[15px]`. ⚠️ NOT lucide `CircleX`, which this mock's sprite carries under the short name `#i-x` and which the _Checks failing_ pill renders; the panels draw this control from a separate `#i-close` symbol |
| ink at rest         | `--el-text-muted`                             | same                                                                                                                                                                                                                         |
| hover               | `--el-tint-rose` fill + `--el-danger` ink     | same                                                                                                                                                                                                                         |
| focus               | 2px `--focus-ring-color` ring, no outline     | same                                                                                                                                                                                                                         |
| accessible name     | **`aria-label`, never an `sr-only` span**     | `PullRequestRow`'s own comment — an `sr-only` span is `position:absolute` and stretches the root scroller                                                                                                                    |
| gap to the link-out | the row's existing `10px`                     | `.pr-row` / shipped `gap-2.5`                                                                                                                                                                                                |

**The row does not change height, and that is why this placement is free.** The
link-out beside it is a 16px glyph in `p-1` — a 24px box — and the remove control
is a 24px box. The row's height is set by the two-line title/meta block, not by
its trailing controls.

#### Q3 — what a SECOND trailing action does to a crowded row (Panel 5f, right)

The widest a row gets today is **three pills** — `Merged` + `Not on trunk` +
`Checks passing` — plus the meta line's `· into <base>` suffix. (Those elements
are decided in `design/work-items/delivery-set.mock.html`, not here; Panel 5f
draws them only to test this control against the worst case it must survive.)

**The trailing controls and the pills never shrink; the TITLE absorbs it.** The
title/meta block is `min-w-0 flex-1` and both lines truncate, so adding ~34px of
trailing content (a 24px box plus the row gap) costs the title ~34px and nothing
reflows or wraps. That is the shipped behaviour, not a new rule — it is what
`min-w-0 flex-1` beside `shrink-0` siblings already does — and Panel 5f draws it
at the detail card's real **620px**, where the title truncates to about 170px and
stays readable.

**⚠️ Drawn at 440px it does NOT truncate — it COLLAPSES**, title and meta both to
zero width, and the remove control clips off the row's right edge. That is real
behaviour of `min-w-0 flex-1` beside five `shrink-0` siblings, and it was the
first draft of this panel. **It does not arise on any surface this control ships
on**: the detail page's Development card is 620px and the peek does not carry the
control (Q1). It is recorded because the number is not obvious from the row's
markup, and because a future surface narrower than roughly 500px would have to
answer it — by dropping a pill, not by shrinking the control.

#### Q4 — the reader who may SEE but not EDIT (Panel 5f, left)

**The control is ABSENT. Not disabled, not dimmed, not a tooltip.** The row is
byte-for-byte the read-only row that shipped before this card. A disabled control
advertises a capability the reader does not have and invites them to hunt for the
permission that unlocks it; an absent one says nothing, which is correct.

The gate is the same key the MCP tool asserts — `work_item:edit`
(`lib/mcp/toolPermissions.ts`) — so the two doors onto one service agree, and the
LINK control in the card header gates on it already.

#### Q5 — the CONFIRM, and the sentence it has to contain

Removing a delivery is a **destructive edit of the card's own record**, so the
gesture confirms. The container is the shipped one: `Popover.Content`,
**300px**, aligned to the trigger's edge, `--radius-card` on `--el-page-bg` with
`--shadow-elevated`, a 14px pad and a right-aligned action row — **ghost
`Cancel`** + **danger `Remove link`**, `sm`, exactly `RemoveLinkButton`'s row.

**The copy's job is to answer the fear the reader actually has**, which is not
_"will this delete a record?"_ but _"will this do something to my pull request on
GitHub?"_ So the sentence names the pull request, and then says what is NOT
happening to it:

> Remove the link to `moooon/motir-core · #131`? The pull request isn't touched
> on GitHub — only the link.

That is deliberately the shape of `issueViews.removeConfirmBefore/After`
(_"The work item isn't deleted — only the link."_) with the second clause
corrected for what a pull request is: **you cannot delete one, and the reader is
not worried that you might** — they are worried the link is a lever on GitHub.
Keeping the shape and fixing the noun is the point; one gesture, one language.

**⚠️ The error path is the panel's, not the control's** (`RemoveLinkButton`'s
own header): the row is dropped OPTIMISTICALLY, which unmounts the control, so a
rejected write's message is held by the panel and handed back to re-open the
popover. Nothing new is drawn for it — the rose line inside the popover is the
shipped `.inline-error` treatment.

#### Copy — the `github` i18n namespace (en + zh parity)

`development.unlinkAria` "Remove the link to {target}" ·
`development.unlinkConfirmBefore` "Remove the link to" ·
`development.unlinkConfirmAfter` "? The pull request isn't touched on GitHub —
only the link." · `development.unlinkAction` "Remove link"
(cancel = the shared `common.cancel`).

| key                   | en                                                          | zh                                                          |
| --------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| `unlinkAria`          | Remove the link to {target}                                 | 移除与 {target} 的关联                                      |
| `unlinkConfirmBefore` | Remove the link to                                          | 移除与                                                      |
| `unlinkConfirmAfter`  | ? The pull request isn't touched on GitHub — only the link. | 的关联吗？GitHub 上的拉取请求不会受到影响——只会移除此关联。 |
| `unlinkAction`        | Remove link                                                 | 移除关联                                                    |

`{target}` is the row's own identifier, `owner/repo · #n`, rendered `font-mono`
inside the sentence exactly as the relationships panel renders its work-item key.
**`unlinkAction` is the same string as `issueViews.removeLink` on purpose** — one
gesture, one label — and it is a second key rather than a cross-namespace read
because `DevelopmentSection` translates under `github`.

#### Referrers — who else renders this row

`design/work-items/repository-set.mock.html` and
`design/work-items/delivery-set.mock.html` both reuse `PullRequestRow` **verbatim**,
and both declare the Development section's own content out of scope (_"the
Development section's other content, the explicit-link affordance … untouched"_).
**Neither needs re-drawing and neither may be edited by MOTIR-5005**: they compose
the shipped component, so they inherit the control when it ships. They are named
here so that the next reader of either asset knows why its rows will not match its
committed PNG once MOTIR-5005 lands, and re-exports rather than re-designs.

#### Build seam (for MOTIR-5005)

The service is already there — `githubPullRequestService.unlinkPullRequest` /
`unlinkPullRequestByCoordinates`, with its permission, its idempotence and its
one-pair-only semantics all built and tested for the MCP tool. What MOTIR-5005
adds is **an `unlinkPullRequestAction` beside `linkPullRequestAction`** and
**this control on the row**, following `RemoveLinkButton`'s optimistic-removal
shape: the PANEL owns the write and the rollback, the control owns the popover.
Do not give the control its own `useTransition` — `RemoveLinkButton` explains why
it stopped using one.

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
- ✅ **`RemoveLinkButton` + `Popover` + `Button` (ghost / danger, `sm`)** — the
  Panels 5d–5f remove control and its confirm are the shipped relationships-panel
  gesture (2.4.9) applied to a PR row, measurement for measurement. No new
  primitive, and no new token: the hover pair is `--el-tint-rose` +
  `--el-danger`, which the tree already uses for exactly this control.

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

  | column        | content                                                                                                                                                                                                 |
  | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Repository    | repo glyph + `owner/name`, owner in `--el-text-secondary` (see the ink note below)                                                                                                                      |
  | Provider      | the provider mark + label — the inventory spans both, so the pressed Segmented does not answer this                                                                                                     |
  | _(ownership)_ | a neutral `Pill` reading **`Hosted by Motir`**, drawn ONLY for a repository under the provisioning organisation. Head cell EMPTY. See the ownership note below                                          |
  | Index         | a `Pill` in **all four** states: **Indexed** (mint, check) · **Stale** (peach, clock) · **Indexing…** (sky, dots) · **Never indexed** (neutral)                                                         |
  | Used by       | **`Used by N projects`**, drawn AT REST                                                                                                                                                                 |
  | _(actions)_   | **`Disconnect`** with the VENUE on a second line — `happens on GitHub` / `happens here` — on both providers, and **WITHHELD ENTIRELY for a repository Motir hosts**. See the withheld-action note below |

- **⚠️ THE FOURTH STATE READS `Indexed`, NOT `Current` (MOTIR-4831, amending this asset for
  MOTIR-4817).** It said `Current` when this surface was drawn, and the product no longer renders
  that word. **The argument is not here and must not be copied here:**
  `design/code-context/design-notes.md` §4.1 owns it, MOTIR-4817 carries the code half, and §4.2
  rules that this org inventory and a project surface draw the SAME pill — which is what makes this
  asset's word a matter of transcription rather than of judgement.

  What is amended is one label. `Stale` · `Indexing…` · `Never indexed` are untouched, and so is
  every tone, glyph and column beside them.

- **⚠️ WHOSE THE REPOSITORY IS, SAID ON THE ROW — the `Hosted by Motir` chip (MOTIR-4892 shipped it;
  MOTIR-4900 amends this asset to record it).** A repository MOTIR hosts is legitimately in this
  inventory — the organisation's projects dispatch into it and it carries the organisation's tenancy
  on purpose (MOTIR-1931, MOTIR-4649) — but the row drew `owner/name`, a provider, an index state
  and a usage count and nothing else, so telling it apart from a repository the organisation
  CONNECTED required knowing `provisioningOrgLogin()`'s value by heart. Under a card heading reading
  _"Every repository connected to this organisation"_, silence is a claim, and on this row the claim
  is about whose property it is.
  - **It is a neutral `Pill`, not a tint, and that is NOT re-decided here.**
    `design/repository-set/design-notes.md` **§17.3** rules it for `already indexed · shared`: a
    per-row marker of this kind is _"a **neutral chip**, not a tint: a fact about the repository,
    not a step in a flow."_ Ownership is exactly such a fact. Tones `--el-chip-bg` /
    `--el-chip-border` / `--el-text-secondary`, radius `--radius-badge`, padding `--spacing-chip-*`
    — the same treatment `Never indexed` already uses in the Index column, so no new tone and no new
    primitive.
  - **The words are the room's, verbatim.** `github.inventory.hostedByMotir` = **`Hosted by Motir`**
    (`zh`: 由 Motir 托管), the same string `repositoryTakeover.hostedHeading` uses one tier down in
    `design/repository-set/`. One noun for one fact, across both surfaces.
  - **Position: between Provider and Index**, because ownership reads ahead of freshness — _whose is
    this_ before _how current is its graph_. It has its OWN grid track with an **empty head cell**,
    the convention the actions column already uses for a per-row affordance that needs no label.
    **A track, not a shared cell, and the cost is measured, not assumed:** the row is a grid so the
    columns cannot drift (below), and a conditional chip folded into a neighbouring cell would
    either take the Index head's label or push the repository name below its floor. The sixth track
    is **108px + one 12px gap**, and the panel shell widens **1112px → 1232px** to pay for it — the
    same content column plus 120px, with the name column keeping the slack it had. The earlier
    sentence _"the inventory is a five-column table and does not shrink to make room"_ is amended by
    exactly this: it is a **six**-column table now, and it still does not shrink.
    **⚠️ AND THE BOARD'S EXPORT VIEWPORT MOVED WITH IT, 1200 → 1320.** The five-track table sat at
    exactly the tree's ~1200px render convention with nothing to spare (1112 + the board's 80px
    padding = 1192), so the sixth track could not be free: at 1200 the grid overflowed its own
    viewport and the export became a capture of a horizontally scrolling board. `github.png` is
    re-exported at **1320 × 2x** — `node scripts/render-design-mock.mjs --width 1320
design/github/github.mock.html` — and the exporter recovers that width from the committed PNG
    from here on, so a later re-export needs no flag. The measurement is the finding, not a
    footnote: **adding a column to a table already at its board's width budget costs board width**,
    and paying it in the export is honest where squeezing the repository name would not have been.
  - **It is drawn ONLY for a repository under the provisioning organisation** (`repo.hostedByMotir`).
    Every other row leaves the cell empty — the chip is a marked exception, not a column every row
    fills in.

- **⚠️ AND A REPOSITORY MOTIR HOSTS CARRIES NO REMOVAL CONTROL AT ALL — `Disconnect` is WITHHELD,
  not disabled (MOTIR-4892; recorded here by MOTIR-4900).** The `_(actions)_` row above used to read
  _"`Disconnect` on both providers"_, unqualified. That is now false, and false in the direction
  that offers an act the product cannot perform.
  - **The rule is `design/repository-set/` §16.6's, applied one tier up:** _"a control that cannot
    keep its promise is worse than its absence"_ — the same rule the room applies to a `domain`
    entry, and the reason a mirror row with no takeover to offer is subtracted from the hosted
    section rather than drawn with a dead affordance.
  - **What made the promise unkeepable.** `manageOnGithubHref` is computed ONCE for the page from
    the organisation's sole installation and handed to every row — right for an organisation-wide
    affordance, wrong for a PER-ROW act, and indistinguishable from correct for as long as every row
    belongs to the same installation. A repository Motir hosts does not: it sits under the SHARED
    provisioning installation, which names no organisation on purpose because it spans tenants. So
    `Continue on GitHub ↗` sent the reader to their own installation screen, where the repository
    does not appear and nothing they do there can disconnect it.
  - **And `Disconnect` is the WRONG ACT for this row, not merely an unreachable one.** A repository
    Motir hosts is handed over by the **TAKEOVER** (MOTIR-711), per row, from the project's own
    Repositories settings — `design/repository-set/` owns that surface. The service refuses the
    disconnect on the same grounds and names that act, so a caller that never rendered this page
    gets the same answer.
  - **Withheld, never disabled.** A disabled control is a promise the product then refuses
    (`design/repository-set/` §17.5 makes the same call for the add affordance). The cell is empty,
    and the `Hosted by Motir` chip on the same row is what turns that absence into an answer — which
    is the second reason the chip and the withheld action are one amendment rather than two.

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

  **⚠️ This table is the shape of the action WHERE THERE IS ONE.** It is read against the row above
  it, not on its own: a repository Motir hosts draws neither cell (the withheld-action note above,
  MOTIR-4892 / MOTIR-4900). The provider axis decides the venue; the OWNERSHIP axis decides whether
  the control exists at all, and the two are independent.

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
  the repository name; the grid gives the name column a floor. **⚠️ RE-MEASURED (MOTIR-4900): six
  tracks, and the shell is drawn at 1232px.** The template is
  `minmax(178px, 1fr) 80px 108px 120px 166px 146px` with a 12px gap — the ownership track is the
  108px one, third, between Provider and Index. It said **1100px** and five tracks before the
  ownership chip existed; the shell grew by exactly the new track plus its gap, so every other
  column keeps the width it was measured at and the name column keeps the same slack. It is still
  the same settings shell as Panels 1–2, measured at a desktop width, not a different one.
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

| Element                                       | Token(s)                                                                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| provider `Segmented` track / option / pressed | `--el-tabnav-track` · `--el-text-secondary` · pressed `--el-page-bg` + `--el-text-strong` + `--shadow-subtle`, glyph `--el-tabnav-active`                                                               |
| inventory head row                            | `--el-text-eyebrow` on `--el-card`, rule `--el-border-soft`                                                                                                                                             |
| inventory row · its hover tint                | `--el-card` → `--el-surface` on hover; rule `--el-border-soft`                                                                                                                                          |
| repository name · owner segment               | `--el-text` · **`--el-text-secondary`** (never `--el-text-muted` — the hover tint, above)                                                                                                               |
| ownership chip (`Hosted by Motir`)            | the neutral `Pill`: `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`, radius `--radius-badge`, padding `--spacing-chip-*` — identical to _Never indexed_, per `design/repository-set/` §17.3 |
| index-state pills                             | `--el-tint-mint` / `--el-tint-peach` / `--el-tint-sky` + `--el-text-strong`; _Never indexed_ is the neutral `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`                                 |
| `Used by N projects` control + its chevron    | `--el-text-secondary` · glyph `--el-icon-muted`                                                                                                                                                         |
| project chips (expanded)                      | `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`, radius `--radius-badge`, padding `--spacing-chip-*`                                                                                        |
| org-removal row action                        | the shipped danger-ghost: text `--el-danger` on border `--el-border`                                                                                                                                    |
| disclosure card                               | `--el-card` / `--el-border` / `--radius-card` / `--shadow-elevated`; foot `--el-surface-soft`                                                                                                           |
| disclosure fact rows                          | glyph `--el-icon-muted`, body `--el-text-secondary`, emphasis `--el-text`                                                                                                                               |
| disclosure primary action                     | fill `--el-accent` · ink `--el-accent-text`                                                                                                                                                             |

Shape flows only through element-semantic tokens (`--radius-card` / `--radius-badge` /
`--radius-control` / `--radius-btn`; `--spacing-card-padding` / `--spacing-control-*` /
`--spacing-chip-*`; `--height-btn-sm` / `--height-control`). No Tier-0 `--color-*`, no raw
`rounded-*` / `p-*` / `h-*`, no invented hue.

### Primitives composed — still no new design-system entry

`Card` · `Pill` (existing `status` / `severity` / `tone` axes only — the `Hosted by Motir` ownership
chip is `Pill tone="neutral"`, the same treatment `Never indexed` already uses) · `Button`
(`primary` / `secondary` / `ghost` / danger-ghost) · `Segmented` (via `GitSettingsShell`'s
`ProviderSwitch`) · `SectionLabel` · the settings-area shell. The inventory table is a composition
of `Card` + rows, not a new primitive; the disclosure is `Card` + `Button`s, not a new dialog
component.

# 18. MOTIR-4953 — THE PROJECT ROOM DRAWS PROJECT LINKS, NOT THE ORGANISATION INVENTORY

**Amendment (2026-09-09).** Panels 8–11 in `github.mock.html` replace the project-room reading in
`design/repository-set/` §17. That earlier amendment made the organisation tier explicit but then
layered the organisation's full inventory into the project page. The result is a room headed
_Repositories_ that answers the broader question _what can this organisation dispatch into?_ rather
than the room's question _what does this project work on?_

This amendment does not change the organisation inventory in Panel 6. It changes where that inventory
is allowed to appear from a project context: **inside Add repository, never as page rows.**

## 18.1 · The answer in one line

The project Repositories room is a view of explicit project links. The Add repository picker is the
place where the organisation's available inventory is offered, and
`See every repository in {org}` is the one navigation route to the organisation's whole inventory.

## 18.2 · Drawn against shipped reality

The real `/settings/project/repositories` page was rendered in an isolated E2E database before this
amendment was drawn. The walk established three concrete facts:

1. A new project with no `project_repository` link rendered every repository in the organisation
   under `From your organisation` and summarized them as `0 moving · 0 hosted by Motir · 6 yours`.
2. The Add repository dialog offered those same six repositories as the already-connected pick list.
3. Picking one produced a removable project-link row **and left the layered copy below it**, so the
   same `moooon-e2e/motir-demo` repository appeared twice and the summary still described the
   organisation-sized list.

The target therefore is not a cosmetic de-duplication. Panel 8 removes the layered rows from the page
contract; Panel 10 retains the organisation inventory at the moment it is useful.

## 18.3 · Placement and panels

| Panel                          | Surface                         | Contract                                                                                                                                    |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **8 · Project-scoped room**    | Project settings → Repositories | Four page rows mean four project links. Two came from the organisation; two are Motir-hosted. Nothing else in the organisation is drawn.    |
| **9 · Empty project**          | The same room, with zero links  | The summary is all zeroes and the page says the project is empty even when the organisation is not. Both Add affordances stay in this flow. |
| **10 · Add from organisation** | `Add a repository` dialog       | Unlinked organisation repositories are choices, a linked one is marked `already in this project`, and connect-new is the second segment.    |
| **11 · Organisation has none** | The same dialog                 | No search and no empty list. Connect-new is the available action and establishes the organisation connection plus project link together.    |

The project settings rail remains the permanent door. The Add action is promoted to the page header
because it applies equally when the page has organisation-owned links, hosted links, or no links.

## 18.4 · The summary counts links only

`{moving} moving · {hosted} hosted by Motir · {yours} yours` partitions the repositories linked to
the current project. The words mean:

| Count             | Meaning                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `moving`          | A Motir-hosted project link whose takeover is in progress (`requested`, `awaiting_acceptance`, `transferring`, or `awaiting_reinstall`). |
| `hosted by Motir` | A settled Motir-hosted project link that Motir still owns and pays CI for.                                                               |
| `yours`           | An organisation-owned project link, or a Motir-hosted link whose takeover completed.                                                     |

They are mutually exclusive. An organisation repository that has not been added to this project is
in none of the counts. Panel 8 intentionally shows four links as `1 moving · 1 hosted by Motir · 2
yours`; Panel 9 shows `0 · 0 · 0` even though the organisation has choices available in Panel 10.

The Motir-hosted section is retained because it is already project-scoped: its rows are the project's
hosted links and carry the takeover action. A moving row stays in that section while its summary
bucket changes from `hosted` to `moving`; on completion it counts as `yours` but remains in this
origin section, where the takeover history and its finished state stay legible.

## 18.5 · Copy contract — replacements, not parallel strings

The old pair was internally contradictory:

- `repositoryPicker.section.hint` said the rows were repositories “this project works on”.
- `repositoryPicker.section.provenance` immediately said they were connected to the organisation,
  “not to this project alone”.

Both were accurate descriptions of different collections because the page had merged those
collections. Replace them together:

| Key                                   | Replacement                                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `repositoryTakeover.lead`             | `Only the repositories {projectName} works on — whether Motir hosts them or {org} does.`                                      |
| `repositoryTakeover.leadConnected`    | **Retire.** One lead describes every non-loading state.                                                                       |
| `repositoryTakeover.empty`            | `No repositories in this project yet. Add one {org} already has, or connect a new repository.`                                |
| `repositoryPicker.section.hint`       | `Repositories from {org} that are linked to this project.`                                                                    |
| `repositoryPicker.section.provenance` | **Retire.** Organisation provenance is not a footer for a project-link list.                                                  |
| `repositoryPicker.section.seeAll`     | `See every repository in {org}` — unchanged words, moved into the standalone navigation block after both project sections.    |
| `repositoryPicker.subtitle`           | `Pick one {org} already has, or connect a new one.`                                                                           |
| `repositoryPicker.firstTimeLead`      | `{org} has no repositories connected yet. Connect the first one and it lands in {org} and in {projectName} at the same time.` |

The new lead requires `{org}` and the first-time lead requires `{projectName}`. Those values already
belong to the room/picker render context; they are not inferred client-side.

## 18.6 · `See every repository in {org}` is navigation

The link appears after both project sections in a neutral navigation block with the prompt
_“Looking for a repository that is not linked to {projectName}?”_ It points to
`/settings/organization/git`, whose inventory remains Panel 6.

It is not:

- a way to add a repository (Panels 10–11 own that action);
- provenance for the rows immediately above it;
- permission recovery copy; or
- a disclosure that expands organisation rows on this page.

This placement preserves the only route to the whole inventory without letting that inventory become
the project page's content again.

## 18.7 · Primitives, tokens and accessibility

Panels 8–11 compose shipped `Card`, `Button`, `Pill`, `SectionLabel`, `Modal`, input, listbox-option,
EmptyState and settings-shell patterns. No new design-system primitive is proposed.

- Page, card, input, option, code-chip and scrim colours use only semantic `--el-*` roles.
- Shape uses `--radius-card`, `--radius-modal`, `--radius-input`, `--radius-control`,
  `--radius-badge` and `--radius-btn`; spacing and control heights use their semantic tokens.
- The dialog is named `Add a repository`; the input is named `Search repositories`; section labels
  are headings, not visual-only captions.
- `already in this project` is text as well as a disabled treatment. `Moving` uses text plus the
  clock glyph. Neither distinction relies on colour.
- The inventory navigation is a `nav` with the accessible name `Organisation repository inventory`.
- Keyboard focus enters the search field when choices exist; when the organisation has none it lands
  on `Connect a new one on GitHub`. Escape closes either dialog and returns focus to the Add button.

The light and dark PNG exports are both required review surfaces for this amendment.

## 18.8 · Runtime boundary and follow-on

MOTIR-4954 implements these panels. This design does **not** change repository-domain resolution,
dispatch, the fallback ladder, indexing, or persistence. It changes only the project settings room's
read/display contract and the placement of inventory choices.

The workspace-rung leak is a separate runtime defect owned by MOTIR-4955. Nothing in this asset asks
MOTIR-4954 to repair or preserve that ladder behavior as a side effect; the implementation must use
the explicit project-link set for this surface while leaving the broader runtime domain untouched.

---

## 19 · The Development rows are DERIVED, not drawn (MOTIR-5008, 2026-09-11)

**Where the `.pr-row` measurements come from.** `PullRequestRow` in
`components/github/DevelopmentSection.tsx` (lines 77–160), read at `origin/main` **`7c3ae250b`**.
Every declaration in the mock's `.pr-row` / `.pr-text` / `.pr-title` / `.pr-meta` / `.pr-states` /
`.ext` block carries the component's own Tailwind class string in a comment directly above it, so the
correspondence is a **string diff** rather than a re-measurement.

**The one command that re-checks the whole block:**

```
sed -n '77,160p' components/github/DevelopmentSection.tsx
```

Read it beside the CSS block in `github.mock.html`. Each quoted class string should match the `class`
attribute on the element it sits above; anything that does not is drift, and drift in this asset is a
bug worth filing (this is the third).

> **2026-09-13 — the narrow row ships (MOTIR-5351).** `PullRequestRow` gains `@max-[30rem]:` variants
> against a `@container` on the rows' `<ul>`: below a 30rem column the pill group drops to its own line
> (`order-last basis-full flex-wrap pb-1 pl-[27px]`) and the link-out stays on line 1 (`order-2`). The
> derived `.pr-row` comment above now quotes the row's new class string, and §20's
> `.pr-row.dvb-row-narrow` rule is the narrow state of this same derived block — no longer a proposal.

### What was wrong, and what changed

The row was a hand drawing, authored by MOTIR-1595 in 2026-07 and never measured against the
component. Four things disagreed:

| element                                    | the asset drew                                                | the component renders                                                                    |
| ------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| row padding                                | `11px 12px`                                                   | `var(--spacing-control-y) var(--spacing-control-x)` — `6px 10px` under the default style |
| meta-line ink                              | `--el-text-secondary`                                         | `--el-text-identifier`                                                                   |
| link-out glyph                             | `15 × 15`, no box                                             | `16 × 16` in `p-1` — a 24px target                                                       |
| the flex structure that decides TRUNCATION | a zero-basis text block plus a separate `.spacer { flex: 1 }` | the TEXT BLOCK carries `min-w-0 flex-1 py-1`                                             |

The last one is the one that changes a picture rather than a number: a zero-basis block that cannot
grow never reaches its ellipsis, so the two structures agree at short titles and disagree at long
ones — which is precisely the case the crowding panel exists to show. `.spacer` had no other caller
in this asset and is deleted with it; the text block is now `.pr-text`.

**The ink one changes no pixel today and is the most important of the four.** `--el-text-identifier`
and `--el-text-secondary` both resolve to `--color-slate` in the base palette. What differs is which
token a builder copies out of this asset — and the identifier ink exists because the caption inks
were wrong for a monospace-ish identifier at 12px (the same lesson Panel 5b already cites for the
picker's option rows). `owner/repo · #n` is exactly that kind of string.

### The measurements are TOKEN REFERENCES, and that is the fix

`padding: 11px 12px` was not merely the wrong number — it was the wrong KIND of statement. The
component writes `px-(--spacing-control-x) py-(--spacing-control-y)`, and that token pair is
`10px / 6px` under the default style and `14px / 8px` under `soft-playful`. Any resolved pixel value
is right for one style pack and silently wrong for the other four. The `var()` is right for all five
and re-skins with a `data-style` swap the way the rest of this mock's token block already does.

**This is what makes the third drift bug different from the first two.** MOTIR-4831 and MOTIR-4900
were _the product moved and the asset did not_, each closed by drawing the new state. This one was
_the asset never matched_ — so correcting four numbers would have fixed the instance and left the
mechanism that produced it. `design/work-items/`'s assets state the alternative outright: the markup
comes from a real render and _"the mock's tokens are EXTRACTED … and its icons from the installed
`lucide-react`, so no hex and no path is hand-typed and **the asset cannot drift**."_

That asset reaches it by carrying the component's Tailwind class strings verbatim. **This asset
cannot do that**, and the reason is structural rather than a preference: `github.mock.html` contains
zero utility rules — it is semantic CSS end to end — so importing a utility island for eleven rows
would leave two CSS idioms in one board. It reaches the same guarantee the other way: token
references instead of resolved pixels, the class string quoted beside every rule, and the command
above.

### The sprite sheet is EXTRACTED, and a command proves it

A symbol's NAME is exactly the kind of thing a careful reader trusts, and in this sheet it has been
wrong three times. `#i-x` is lucide `circle-x` under a short name (MOTIR-5007 reached for it and drew
a circled ⊗ where `RemoveLinkButton` renders a plain `X`), and it was also hand-typed at `r="9"` where
the package draws `r="10"`. `#i-repo` carried lucide `book`'s drawing under a repository label, while
every repository surface in the app renders `FolderGit2`. And `#i-sliders` was drawn VERTICAL — three
column tracks — while the Details row it labels renders `SlidersHorizontal`.

Diffing every `<symbol>` against `lucide-react@1.16.0` found **19 of 30 drifted**. MOTIR-5008 took the
six the Development row draws (`#i-git-pr`, `#i-git-merge`, `#i-git-closed`, `#i-check`, `#i-x`,
`#i-dots`); **three of them were not approximations of their own icon at all** — `#i-git-pr` was a
sketch of lucide `git-pull-request`, a different icon from the `GitPullRequestArrow` the component
imports. MOTIR-5136 took the remaining thirteen.

**All 30 lucide symbols are now emitted from the installed package**, each with a provenance comment
naming the file it came from and the shipped code the glyph stands for. The resolution of a sprite is
made against **that shipped code, never against the sprite's id** — the id is the thing that has been
wrong. Six of the thirteen were settled by a nav registry outright:

| sprite          | lucide               | what resolves it                                                   |
| --------------- | -------------------- | ------------------------------------------------------------------ |
| `#i-building`   | `building-2`         | `organizationSettingsNav.ts` — the Organisation row is `Building2` |
| `#i-git-branch` | `git-branch`         | `organizationSettingsNav.ts` — the Git row is `GitBranch`          |
| `#i-users`      | `users`              | `organizationSettingsNav.ts` — the Members row is `Users`          |
| `#i-coins`      | `coins`              | `organizationSettingsNav.ts` — the Usage & cost row is `Coins`     |
| `#i-sliders`    | `sliders-horizontal` | `projectSettingsNav.ts` — the Details row is `SlidersHorizontal`   |
| `#i-repo`       | `folder-git-2`       | `projectSettingsNav.ts` — the Repositories row is `FolderGit2`     |

The same two registries independently confirm `#i-shield-check`, `#i-card` and `#i-shield`, which were
already byte-correct — which is the check on the method, not a coincidence.

**The re-check is a command, not a reading.** This is the half worth more than the thirteen fixes: the
first three bugs in this class were each found by a person rendering a panel and noticing. Run

```
node scripts/audit-mock-sprites.mjs design/github/github.mock.html --strict
```

It reads each symbol's provenance comment for the icon it DECLARES, diffs that symbol's shapes against
the icon's `__iconNode` in the installed package, and exits non-zero on any disagreement. `--strict`
also fails an UNDECLARED symbol, so a sprite added without provenance cannot pass quietly. It takes any
mock, so an asset nobody has looked at yet can be swept in one line. Run it after editing a symbol and
after a `lucide-react` bump.

`#i-github` and `#i-gitlab` are each provider's own brand mark and carry a `NOT-LUCIDE` declaration,
which is what makes the audit skip them rather than report them unverifiable. `#i-inbox`, `#i-briefcase`
and `#i-cog` are extracted and correct but are not currently drawn by any panel; they were extracted
rather than deleted because removing a sprite is a decision about the board's future panels, and this
card was a measurement.

### What did NOT change

No panel gains or loses an element. This is a measurement correction, not a redesign: the eleven
`.pr-row` instances across Panels 3, 4, 5a–5f keep their glyph, title, meta line, pill set, link-out
and — where MOTIR-5007 put one — their remove control, in that order.

## 20 · The Development block is the ONE gate — pull-request rows plus the run's HOW TO TEST (MOTIR-5327, 2026-09-13)

Story [MOTIR-4906](motir:cmtt4ogi0000dhutx1ekfm43s) · card [MOTIR-5327](motir:cmtzoqqmt00bzhvtxgxduxev2).
Board: **Panels 12a–12o** in `github.mock.html` (+ `github.png`, `github.dark.png`), and the
composed port in `design/work-items/approval-control.mock.html` Panel `U`.

> **Yue, 2026-09-13:** _"'approve to merge the PRs' is the gate, how to test is telling user how to
> validate the PRs, so they are the same gate, not 2 separated things"_ — and _"in the work item page
> the PRs and how to test should be one block … like the design result"_.

### The answer in one line

The item page's **Development block** is the gate _approve to merge the pull requests_. Its content
is the pull-request rows **and** the run's **How to test**, in **one section card**. When that gate is
awaiting, the block **is** `ApprovalGateControl`'s frame: the rows and How to test are band 2, and
band 3 is [MOTIR-4909](motir:cmtt4ogps000ghutxdx7laze2)'s **Approve and merge**. How to test is that
gate's **evidence** — it has no section, no gate row, no verb and no approval of its own.

### The no-gate / with-gate rule, and its precedent

`app/(authed)/items/[key]/_components/DesignResultSection.tsx` on `origin/main` is the precedent, and
the rule is its rule, applied to a second subject:

| state                                   | the Development card renders                                                                                                          | panel    | precedent, quoted from `DesignResultSection.tsx`                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| **no gate** (today, every card)         | the rows, then How to test below them, in the same card — exactly what the port will hold                                             | 12a, 12b | _"NO GATE ⇒ NO FRAME. A card with nothing awaiting a decision renders exactly what it renders today"_ |
| **an awaiting `pull_request_approval`** | the frame, inside the same `ContentSectionCard`: band 1 header · **band 2 = the block above, unchanged** · band 3 _Approve and merge_ | 12c, 12o | _"THE PANEL IS NOT DELETED — IT BECOMES THE PORT'S CONTENTS"_                                         |

- **The section card stays.** `LateSections.tsx` wraps `DesignResultSection` in a
  `ContentSectionCard` and the frame renders inside it; the Development card does the same, so its
  title and its _Link pull request_ door stay where they are.
- **One frame for all the run target's pull requests.** A two-repository story run has two pull
  requests and ONE gate; Panel 12c draws one frame and one _Approve and merge_ over both rows. There is
  never a frame per row.
- **Nothing moves when the gate arrives.** The block is drawn in 12a/12b as the port content, so the
  gate only adds bands 1 and 3 around it.
- **No overlay and no full-screen view is drawn.** The port's _Expand_ control is drawn at rest
  because it is part of the shipped band 2 (`PortBox`); what it opens, and any approval overlay, is
  [MOTIR-5214](motir:cmtxm4v3600edhztx2s78ff0u) / [MOTIR-5215](motir:cmtxm4v6g00efhztx79g9zyar)'s, for
  every gate. This block relies on nothing from them.
- **The frame's own bands are not redrawn.** Panel 12c re-declares `approval-control.mock.html`'s
  `.frame` / `.frameHead` / `.port` / `.frameFoot` rules under `af-` names (this board already owns a
  `.pill`), with the port ceiling at the shipped `34rem` (`PORT_CEILING` in `ApprovalGateControl.tsx`).

### The per-run rule, with its ADR pointer

`docs/decisions/approval-gates.md` §9 makes HOW TO TEST a first-class deliverable; its **per-RUN
amendment** is [MOTIR-5356](motir:cmtztp593008ahwoi5h2k6ugl). A run writes **one record**, onto the
**run target** — the item it was launched against. A **child card of a container run carries none of
its own**: its Development card shows its own rows and one line, _Tested as part of_ **ACME-12**,
linking the target by key (Panel 12m). The pull request's own row stays its link to the diff.

### Placement inside the card (top to bottom)

1. the pull-request rows — `PullRequestRow` / `AwaitingRepoRow`, **derived and unchanged** (§19);
2. the rows' caption — the shipped string, re-inked `--el-text-secondary` (see _Decisions_);
3. **How to test**, below a soft rule: the `h4` sub-heading and _Written by {run} · {time}_ → a stale
   or record-missing callout, when there is one → the agent's **body** → the per-repository sub-blocks
   Motir derives (**In the preview · Locally · What CI proved**) → _Earlier runs (n)_.

For a **single-repository** run the sub-block has **no heading** (12a). For **two or more**, each is
headed by **the same string its row's meta line carries** — `moooon/motir-core · #131` — so the two
are read together (12b); an `AwaitingRepoRow`'s sub-block is headed by the repository alone, as that
row's meta line is (12l).

### The content is RICH TEXT

- **The agent writes `bodyMd`** over MCP (`publish_test_instructions`, the same way
  `publish_design_result` carries a design note). Its sections are its own — _Precondition_, _Set up_,
  _Click-path_, one per repository, or none — and the block **imposes no section**, so a body with no
  click-path renders what it has and nothing says _missing_ (12f).
- **It renders through the ONE Markdown stack**, `components/ui/MarkdownView.tsx` →
  `lib/markdown/render.tsx`. The block passes a className that scales the agent's `##` headings down to
  card sub-headings (uppercase 12px, `--el-text-secondary`). The mock carries only `dvb-md` and restates
  the prose rules it needs, because another asset in the tree already declares `motir-prose`.
- **Every fenced code block carries a click-to-copy control** (12d). It is a `pre` override added to
  `renderMarkdown`'s components behind an **opt-in** option, so no other Markdown surface changes. The
  block gets a **bar above the code** holding the fence's language _as written_ and a ghost **Copy**
  button; the code scrolls sideways inside its own block. States: **rest** (`--el-text-secondary`),
  **hover** (`--el-muted` fill, `--el-text`), **copied** for 2s (`--el-tint-mint` + `--el-text-strong`,
  a `check` glyph, announced with `aria-live="polite"`), then back. Copy writes the block's text exactly.
- **An unknown fence language** (`nushell`, 12f) is printed as written, in one ink, and still copies.
  `rehype-highlight` emits `hljs-*` spans for known ones, but no theme for them ships, so every block
  renders in `--el-code-text` and this card adds none.
- **Inline `code` gets no control.**

### Decisions

| decision                                    | chosen                                                                                                                         | why                                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| where How to test sits                      | **inside the Development card, below the rows**, under an `h4` — never a section card or section header of its own             | it is the gate's evidence, not a second subject (Yue's _"same gate"_)                                                                                                |
| copy control position                       | **in a bar above the code**, right-aligned, never overlaid                                                                     | the long command in 12d scrolls sideways; at ~400px (12n) every block does, and an overlaid button would cover the command                                           |
| open or disclosure                          | **open**; only _Earlier runs_ is a disclosure, collapsed                                                                       | the current record is what the reviewer reads before pressing the verb; a collapsed record adds a click to every decision                                            |
| what Motir derives vs what the agent writes | the body is the agent's, verbatim; the **bordered sub-blocks** are Motir's (preview, branch fetch, checks)                     | the retired structured fields were the agent re-typing what Motir already knows; a derived fact cannot be mistyped                                                   |
| order of the derived facts                  | **In the preview · Locally · What CI proved**                                                                                  | the card's own order; the fastest path first                                                                                                                         |
| stale                                       | a **peach callout** naming the repository and both commits; the body **stays visible**; that sub-block carries **Stale** (12g) | instructions one push old are usually still right; only what the agent wrote can go stale                                                                            |
| record missing                              | a **lavender callout at the head of the part**, with `file-question-mark`, naming the owing run; no sub-blocks (12i)           | it must never read like _No preview reported_, which is a neutral pill inside one repository's preview fact (12e) — different remedy, different treatment            |
| a repository with a PR but no section       | a sub-block that SAYS so: _Not in this run's record_ + neutral **No section** (12k)                                            | a forgotten repository must not be silently absent from the evidence for a gate that merges it                                                                       |
| the rows' caption                           | the shipped string, **re-inked `--el-text-secondary`**                                                                         | the shipped caption is `--el-text-muted`, which fails AA on the port's `--el-surface` (4.17:1). A one-token change for [MOTIR-5336](motir:cmtzoqrc900cmhvtxgr8ueqjw) |
| code block surface in the port              | `--el-surface` on the card, **`--el-card` inside the port**                                                                    | the port is `--el-surface`; the same fill would make the block's edge the only cue                                                                                   |
| the diff                                    | **no link to the diff** other than each row's own link-out; the preview URL opens the **app**                                  | ADR §9: the diff is a link out, not the lead                                                                                                                         |
| the quick-view peek                         | **not drawn, unchanged** — it keeps its rows                                                                                   | its contract is read-only and compressed; _Open full page_ reaches the block. A peek How to test would be its own card                                               |
| the section gloss                           | `github.development.gloss` is **replaced**, not paralleled                                                                     | the card now holds more than status                                                                                                                                  |

### The narrow row — drawn for MOTIR-5351 to build to (12n)

At a ~400px column the shipped `PullRequestRow` shows one or two characters of its title, because its
pill group is `shrink-0` ([MOTIR-5351](motir:cmtzsio9b01cjhvoirkfuxmxl)). Panel 12n draws the **fixed
row**: below a `30rem` container the row wraps; glyph · title · link-out stay on line 1 and the pill
group drops to line 2, indented under the title (`order-last basis-full pl-[27px]`). The desktop row
is unchanged, so **§19's derived `.pr-row` block is not edited**: the narrow variant is a separate
`.pr-row.dvb-row-narrow` rule with its intended class strings quoted above it. When MOTIR-5351 ships,
that rule folds into the derived block, per §19 (done, 2026-09-13). The block itself needs nothing new at that width:
facts wrap their pill under the label and every code block scrolls inside itself.

### Fields read

The read is [MOTIR-5333](motir:cmtzoqr5000cghvtxnaytfoe0)'s `HowToTestDto` (re-planned 2026-09-13 to
carry `bodyMd`). The rows' own fields stay `PullRequestRow`'s (`LinkedPullRequestDto`); the frame's gate
fields are `ApprovalGateDTO`'s.

| rendered element                      | field(s) read                                                                                                                                                                                                             | panel    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| which part renders                    | `state` ∈ `record` · `record_missing` · `tested_via_ancestor`                                                                                                                                                             | all      |
| _Written by {run} · {time}_           | `record.run` → `{ runId, label }`, `record.createdAt`                                                                                                                                                                     | 12a      |
| the body                              | `record.bodyMd`, rendered by `MarkdownView`                                                                                                                                                                               | 12d, 12f |
| the preview URL                       | `repos[].preview.url` (the deployment URL joined with `record.previewPath`)                                                                                                                                               | 12a, 12e |
| repository sub-heading                | `repos[].repoName` + `repos[].pullRequest` — shown only when `repos.length > 1`; matched to its row by `repoName`                                                                                                         | 12b      |
| **Stale** pill + stale callout        | `repos[].stale`; the callout's two shas are `repos[].commitSha` and `repos[].pullRequest.headSha`                                                                                                                         | 12g      |
| _In the preview_ pill + sentence      | `repos[].preview` → `status` ∈ `available` · `deployment_not_ready` · `no_deployment_reported`; `state` ∈ `queued` · `pending` · `in_progress` · `success` · `failure` · `error` · `inactive` · `canceled`; `environment` | 12e      |
| _Locally_ code block                  | `repos[].fetchCommand` (composed from the pull request's `headRef`, shell-quoted by the read); `null` ⇒ _No branch to fetch_                                                                                              | 12a, 12l |
| _What CI proved_                      | `repos[].ci` → `status` ∈ `available` · `no_checks_reported`; `checks[]` → `{ name, conclusion }`, `neutral` listed and not counted                                                                                       | 12h      |
| record-missing callout                | `owedBy` → `{ runId, label }` (null ⇒ _No run is recorded for this item._)                                                                                                                                                | 12i      |
| _Earlier runs (n)_                    | `history[]` → `{ recordId, run, createdAt }`, newest first                                                                                                                                                                | 12j      |
| a repository with a PR but no section | derived: a row's repository with no `repos[].repoName` match — no new field                                                                                                                                               | 12k      |
| the child pointer                     | `runTarget` → `{ key }` for `tested_via_ancestor`                                                                                                                                                                         | 12m      |
| the frame (12c)                       | `ApprovalGateDTO` — `state`, `subjectVersion`, the routed-to label; verbs and consequence supplied by MOTIR-4909's kind                                                                                                   | 12c      |

### Tone table (the shipped `Pill` axes — no new variant)

| value                                               | pill                                                                | glyph (lucide)                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| preview `success`                                   | severity success (mint) · _Ready_                                   | `circle-check`                                                   |
| preview `queued` / `pending`                        | severity warning (peach) · _Queued_ / _Pending_                     | `clock`                                                          |
| preview `in_progress`                               | severity warning (peach) · _Deploying_                              | `circle-ellipsis`                                                |
| preview `failure` / `error`                         | severity danger (rose) · _Deploy failed_ / _Deploy errored_         | `circle-x`                                                       |
| preview `inactive` / `canceled`                     | tone neutral · _Inactive_ / _Canceled_                              | `circle-slash` / `ban`                                           |
| no deployment · no checks · no branch               | tone neutral                                                        | `circle-dashed`                                                  |
| check `success` / `failure` / `pending` / `neutral` | mint _Passed_ / rose _Failed_ / peach _Running_ / neutral _Neutral_ | `circle-check` / `circle-x` / `circle-ellipsis` / `circle-minus` |
| no section in the record                            | tone neutral · _No section_                                         | `circle-minus`                                                   |
| stale                                               | severity warning (peach) · _Stale_                                  | `history`                                                        |

**Tokens.** `--el-*` colour and element-semantic shape tokens only. The block's inks are `--el-text`,
`--el-text-secondary` and `--el-text-identifier`, because it renders on `--el-card` **and** on the
port's `--el-surface`, where `--el-text-muted` measures 4.17:1. Callouts are tint + `--el-text-strong`
(stale) and `--el-callout-bg` + `--el-callout-text` (missing). Every new rule carries the class string
MOTIR-5336 builds it from, directly above it. The twelve new sprites are extracted from
`lucide-react@1.16.0` (`node scripts/audit-mock-sprites.mjs design/github/github.mock.html --strict`:
44 symbols, 0 drifted, 0 undeclared).

### Copy — `en` + `zh`

One namespace, **`github.development.howToTest`**, beside the rows' own `github.development.*`. The
frame's kind label, consequence and verbs are MOTIR-4909's and are not keyed here.

| key                                   | en                                                                                                                                                    | zh                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `github.development.gloss` (REPLACES) | Pull requests and how to test them · live PR and CI status                                                                                            | 拉取请求及其测试方法 · 实时 PR 与 CI 状态                                                 |
| `title`                               | How to test                                                                                                                                           | 如何测试                                                                                  |
| `writtenBy`                           | Written by {run} · {time}                                                                                                                             | 由 {run} 编写 · {time}                                                                    |
| `latestRun`                           | Latest run {run} · finished {time}                                                                                                                    | 最近一次运行 {run} · 完成于 {time}                                                        |
| `code.copy`                           | Copy                                                                                                                                                  | 复制                                                                                      |
| `code.copyAria`                       | Copy code                                                                                                                                             | 复制代码                                                                                  |
| `code.copied`                         | Copied                                                                                                                                                | 已复制                                                                                    |
| `code.copyFailed`                     | Couldn't copy — select the text instead                                                                                                               | 无法复制——请手动选择文本                                                                  |
| `stale.title`                         | Written for {recordSha} — {repo} is now at {headSha}.                                                                                                 | 针对 {recordSha} 编写——{repo} 现在位于 {headSha}。                                        |
| `stale.body`                          | The instructions below may be out of date. The preview and CI follow the new head.                                                                    | 以下说明可能已过时。预览和 CI 跟随最新提交。                                              |
| `stale.pill`                          | Stale                                                                                                                                                 | 已过时                                                                                    |
| `preview.title`                       | In the preview                                                                                                                                        | 在预览环境中                                                                              |
| `preview.state.success`               | Ready                                                                                                                                                 | 就绪                                                                                      |
| `preview.state.queued`                | Queued                                                                                                                                                | 排队中                                                                                    |
| `preview.state.pending`               | Pending                                                                                                                                               | 等待中                                                                                    |
| `preview.state.in_progress`           | Deploying                                                                                                                                             | 部署中                                                                                    |
| `preview.state.failure`               | Deploy failed                                                                                                                                         | 部署失败                                                                                  |
| `preview.state.error`                 | Deploy errored                                                                                                                                        | 部署出错                                                                                  |
| `preview.state.inactive`              | Inactive                                                                                                                                              | 已停用                                                                                    |
| `preview.state.canceled`              | Canceled                                                                                                                                              | 已取消                                                                                    |
| `preview.notReady`                    | The {environment} deployment for this head is {state}. Its link appears here when it succeeds.                                                        | 此提交的 {environment} 部署状态为{state}。部署成功后，链接会显示在这里。                  |
| `preview.failed`                      | The {environment} deployment for this head did not succeed, so there is no preview to open. Test it locally, or wait for the next push.               | 此提交的 {environment} 部署未成功，因此没有可打开的预览。请在本地测试，或等待下一次推送。 |
| `preview.inactive`                    | The {environment} deployment for this head is no longer active — a newer deployment replaced it.                                                      | 此提交的 {environment} 部署已不再活跃——已被更新的部署取代。                               |
| `preview.canceled`                    | The {environment} deployment for this head was canceled before it finished.                                                                           | 此提交的 {environment} 部署在完成前已被取消。                                             |
| `preview.none`                        | No preview reported                                                                                                                                   | 未报告预览                                                                                |
| `preview.noneBody`                    | This repository's CI reported no deployment for this head. Motir does not create previews.                                                            | 此仓库的 CI 未为此提交报告任何部署。Motir 不会创建预览。                                  |
| `local.title`                         | Locally                                                                                                                                               | 在本地                                                                                    |
| `local.noBranch`                      | No branch to fetch                                                                                                                                    | 没有可获取的分支                                                                          |
| `local.noBranchBody`                  | No pull request carries this repository's branch yet, so there is nothing to fetch.                                                                   | 尚无拉取请求包含此仓库的分支，因此没有可获取的内容。                                      |
| `ci.title`                            | What CI proved                                                                                                                                        | CI 已验证的内容                                                                           |
| `ci.summary`                          | {passed} of {total} checks passed                                                                                                                     | {total} 项检查中 {passed} 项通过                                                          |
| `ci.conclusion.success`               | Passed                                                                                                                                                | 通过                                                                                      |
| `ci.conclusion.failure`               | Failed                                                                                                                                                | 失败                                                                                      |
| `ci.conclusion.pending`               | Running                                                                                                                                               | 运行中                                                                                    |
| `ci.conclusion.neutral`               | Neutral                                                                                                                                               | 中性                                                                                      |
| `ci.none`                             | No checks reported                                                                                                                                    | 未报告检查                                                                                |
| `ci.noneBody`                         | No checks have reported for this head yet, so CI has proven nothing here.                                                                             | 此提交尚未报告任何检查，因此 CI 尚未验证任何内容。                                        |
| `noSection.title`                     | Not in this run's record                                                                                                                              | 不在本次运行的记录中                                                                      |
| `noSection.pill`                      | No section                                                                                                                                            | 无对应部分                                                                                |
| `noSection.body`                      | {run} wrote no section for this repository, so its pull request is not covered by the instructions above. Its row still carries its PR and CI status. | {run} 未为此仓库编写对应部分，因此上方说明不涵盖其拉取请求。其行仍显示 PR 与 CI 状态。    |
| `missing.title`                       | No run has written how to test this item.                                                                                                             | 尚无运行为此工作项编写测试说明。                                                          |
| `missing.owedBy`                      | Owed by {run} (finished {time}). The pull requests above still carry their own status.                                                                | 应由 {run} 编写（完成于 {time}）。上方的拉取请求仍显示各自的状态。                        |
| `missing.noRun`                       | No run is recorded for this item.                                                                                                                     | 此工作项没有记录的运行。                                                                  |
| `earlier.toggle`                      | Earlier runs ({count})                                                                                                                                | 更早的运行（{count}）                                                                     |
| `child.pointer`                       | Tested as part of {key}                                                                                                                               | 作为 {key} 的一部分进行测试                                                               |
| `aria.part` / `aria.repo`             | How to test / {repo}                                                                                                                                  | 如何测试 / {repo}                                                                         |

### Scope

**Drawn:** the combined block with and without a gate, the rich-text body with click-to-copy commands,
every state on the card's checklist, the child pointer, narrow and dark, the copy and the Fields-read
table. **Not drawn, and whose it is:** the component — [MOTIR-5336](motir:cmtzoqrc900cmhvtxgr8ueqjw);
the data — [MOTIR-5333](motir:cmtzoqr5000cghvtxnaytfoe0); the gate kind and its verbs —
[MOTIR-4909](motir:cmtt4ogps000ghutxdx7laze2); any overlay or full-screen view —
[MOTIR-5214](motir:cmtxm4v3600edhztx2s78ff0u) / [MOTIR-5215](motir:cmtxm4v6g00efhztx79g9zyar); the
frame's bands (composed, not redrawn); a diff inside Motir; a Motir-created preview —
[MOTIR-4527](motir:cmtnee40x0000hvn8ruhq31go).

### GIVES / TAKES

| key                                                                                           | GIVES / TAKES                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [MOTIR-4909](motir:cmtt4ogps000ghutxdx7laze2)                                                 | **GIVES** the port for the ONE approve-and-merge gate — this block, covering all the run target's pull requests. **TAKES** its _Approve and merge_, kind label and consequence line |
| [MOTIR-5214](motir:cmtxm4v3600edhztx2s78ff0u) / [MOTIR-5215](motir:cmtxm4v6g00efhztx79g9zyar) | **nothing either way** — the overlay is theirs, for every gate, later                                                                                                               |
| [MOTIR-4881](motir:cmtrwx33s0054hxphinsoyt0f)                                                 | **nothing either way** — the block draws no review or diff link                                                                                                                     |
| [MOTIR-5351](motir:cmtzsio9b01cjhvoirkfuxmxl)                                                 | **GIVES** the narrow row (12n) and the rule it folds into §19's derived block                                                                                                       |
| [MOTIR-5336](motir:cmtzoqrc900cmhvtxgr8ueqjw)                                                 | **GIVES** the block, both states, every state panel, the copyable code block, the caption re-ink and the copy                                                                       |
| [MOTIR-5333](motir:cmtzoqr5000cghvtxnaytfoe0)                                                 | **GIVES** the Fields-read table above as the shape to build to. **TAKES** `HowToTestDto`                                                                                            |
| [MOTIR-5356](motir:cmtztp593008ahwoi5h2k6ugl)                                                 | **TAKES** the per-run rule (the ADR §9 amendment)                                                                                                                                   |
| [MOTIR-4527](motir:cmtnee40x0000hvn8ruhq31go)                                                 | **nothing either way** — the excluded Motir-hosted preview                                                                                                                          |
| [MOTIR-4906](motir:cmtt4ogi0000dhutx1ekfm43s)                                                 | the parent story                                                                                                                                                                    |

Fixture items on the board use `ACME-n` keys and `acme-n-…` branches, so they link to nothing. Every
other `MOTIR-n` in the two amended mocks is provenance the asset already carried, and GIVES or TAKES
nothing here.

### The verbs and their states — MOTIR-5480 (2026-09-15)

Story [MOTIR-4909](motir:cmtt4ogps000ghutxdx7laze2) · card
[MOTIR-5480](motir:cmu1aj15k00gchyoidbhlbomo). Board: **Panels 12p–12w** in
**`approve-and-merge.mock.html`** (+ `approve-and-merge.png`, `approve-and-merge.dark.png`), one row
per state: **desktop · dark · ~400px**.

**The contract these panels draw** is `docs/decisions/approval-gates.md` §8's amendment
([MOTIR-5479](motir:cmu1aj13z00gahyoip0mfmjqw)), decisions 3–5: the gate is raised only on an
all-green set in a `manual` project; a moved head withdraws it; _Approve and merge_ commits the
approval FIRST, then merges or enqueues each pull request outside the transaction, and a refused one
writes no decision. **In `prMergeMode` `auto` no gate is raised, and the card renders Panel 12a.**

**Why a second sheet.** `github.mock.html` was already 42,482px tall at 2×. With these 27 panels
added it measured 65,948px, and the full-page export came out **blank below ~48,000px**: both columns
cut off at the same height, mid-Panel 12r, while the file wrote without an error. A state nobody can
see in the PNG is not drawn, so the states moved to their own sheet. It carries `github.mock.html`'s
tokens, primitives and sprite sheet verbatim (`audit-mock-sprites --strict`: 44 symbols, 0 drifted),
at a 1740px viewport so each state's three variants sit in one row. `github.mock.html` keeps a
pointer after Panel 12o.

**One correction to the older sheet.** Panels 12c and 12o drew the second pull request's checks as
_running_ under an awaiting gate. Under decision 3 that cannot happen, so both now draw it green
(_Checks passing_, _3 of 3 checks passed_). 12b, which has no gate, is unchanged.

**The fixture.** One story run, two pull requests: `moooon/motir-core · #131` merges now, and
`moooon/motir-ai · #88`'s repository has a merge queue. The port abbreviates How to test to its head
line; Panel 12b draws it in full, and nothing in it changes with these states.

#### No card inside a card — the frame sits FLUSH in the Development card (Yue, 2026-09-15)

The first cut drew the approval frame as a bordered, rounded, shadowed card inside the Development
section card, itself inside the card body's padding. **A container does not go inside a container.**
The Development card is the container, so every frame on both sheets (12c, 12o, 12p–12w) now sits
flush in it:

| element                                                | before                                                    | now                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| the frame's box                                        | `overflow-hidden rounded-(--radius-card) border` + shadow | **no border, no radius, no shadow, no fill** — `flex flex-col overflow-hidden`   |
| the card body around the frame                         | `--spacing-card-padding` on every side                    | **no padding** — band 1 starts directly under the card head's divider            |
| the bands (header, port, foot, confirm, record, alert) | inside the inner card                                     | **edge to edge in the section card**, separated by their own dividers, unchanged |
| the port                                               | floor, `34rem` ceiling, its own scroll, Expand            | **unchanged** — a page card is not the viewport, so the ceiling and Expand stay  |

**The component contract.** `ApprovalGateControl` has `layout: 'inline' | 'fill'`. `inline` draws
the boxed card; `fill` (the overlay, § 22 in `design/workbench/design-notes.md`) drops the box but
also drops the port's floor, ceiling and Expand, because there the viewport is the box. Neither fits a
frame inside a section card. So the frame gains a third value, **`layout: 'flush'`**: `fill`'s box
(no chrome) with `inline`'s port. It is a presentational input like `fill` — no state, verb, band or
decide path — and `DevelopmentGateFrame` passes it, with the section card rendering the frame with no
body padding. This is a TAKES on [MOTIR-5484](motir:cmu1aj1bj00gkhyoi0iuds6xy), amended on that
card.

**Not changed here:** the pull-request rows keep the shipped `PullRequestRow` treatment (§19), and
the Design result section's own frame (`DesignResultSection`) is outside this card.

#### The panels, and the card that implements each

| panel | state                                                                                   | implemented by                                                               |
| ----- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 12p   | **rest** — _Approve and merge_ · _Request changes_, and the consequence line            | [MOTIR-5484](motir:cmu1aj1bj00gkhyoi0iuds6xy)                                |
| 12q   | **confirm** — state `C`: every pull request, and whether it merges now or joins a queue | MOTIR-5484                                                                   |
| 12r   | **merging** — approval recorded (card _Approved_), each row on its way                  | [MOTIR-5483](motir:cmu1aj19x00gihyoi0b6lixcm) (outcomes) · MOTIR-5484 (rows) |
| 12s   | **queued to merge** — one merged, one _Queued to merge_, the card stays _Approved_      | MOTIR-5483 · MOTIR-5484                                                      |
| 12t   | **all merged** — the card waits for the host's webhook                                  | MOTIR-5484                                                                   |
| 12u   | **one refused** — the approval stands, the refusal in place, _Retry merge_ on that row  | MOTIR-5483 · MOTIR-5484                                                      |
| 12u′  | **one refused, after a reload** — _Not merged yet_ with _Retry merge_ and no reason     | MOTIR-5484                                                                   |
| 12v   | **withdrawn by a push** — state `G`, naming the pull request whose head moved           | [MOTIR-5482](motir:cmu1aj18f00gghyoik41ycibt) (withdraw) · MOTIR-5484        |
| 12w   | **bystander** — state `B`: the port live, no verbs, who it waits on                     | MOTIR-5484                                                                   |

#### Decisions

| decision                             | chosen                                                                                                                                                                                                                                                                         | why                                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| where a row's outcome shows          | in the row's **second pill slot**, beside its derived state pill. It carries _Merging_ / _Joining the merge queue_ / _Queued to merge_ / _Not merged_ while the press has one to report; once the host says merged, the derived state pill reads _Merged_ and the slot empties | every member was green by construction, so the CI pill has nothing left to say after the press; the row stays `PullRequestRow`, derived and unchanged (§19)                         |
| the consequence line                 | **names each pull request for one or two, and counts them for three or more**: _Approving merges 2 pull requests and adds 1 to a merge queue, then moves {key} to Approved._ The confirm step **always** lists every one                                                       | band 3 is one line; an unbounded list pushes the verbs off the frame. The confirm step is where the full list is read, one last time, before the press. TAKES on MOTIR-5484 (below) |
| which member queues                  | **read before the press** and stated in the confirm step, per member                                                                                                                                                                                                           | the person approves knowing what will happen to each; the answer is 4882's (the repository's rules)                                                                                 |
| after the press                      | the **decided record band** (state `E`) replaces the verbs, with a progress line while members are in flight                                                                                                                                                                   | the approval is already committed (decision 5(a)), so there is nothing left to press but a Retry                                                                                    |
| a refusal                            | a **rose alert band** (state `H`) naming the pull request, its words a **labelled slot**, then _Your approval stands, and {other} merged._                                                                                                                                     | the approval must not look undone by one refusal, and a refusal must not look like success                                                                                          |
| a refusal after a reload             | **_Not merged yet_** (neutral) with _Retry merge_, **no reason**                                                                                                                                                                                                               | the press does not persist the reason, so the page must never show one it no longer has                                                                                             |
| the refusal's words                  | **not written here** — the slot shows `mergeConflict` as an example and cites MOTIR-4882's union (`lib/approvalGates/refusals.ts`)                                                                                                                                             | one vocabulary of failures; `refusals.ts`'s header forbids a second                                                                                                                 |
| the card's status beside the title   | **In Review** until the press, **Approved** from the press until the webhook writes Done                                                                                                                                                                                       | `approved` is `in_progress`-category (ADR §6b); nothing here writes Done                                                                                                            |
| a member with no awaiting merge gate | **its row is unchanged** — no outcome pill                                                                                                                                                                                                                                     | MOTIR-5483 returns `no_merge_gate` for it; there was no press to report on                                                                                                          |

#### Tokens

`--el-*` and element-semantic shape tokens only, each rule quoting the class string it maps to.
Header pills: _Awaiting you_ `--el-tint-yellow` · _Approved_ `--el-tint-mint` · _Withdrawn_
`--el-muted` + `--el-text-secondary`, all with `--el-text-strong` on a tint. Confirm band
`--el-tint-lavender`. Record band `--el-surface-soft`, ink `--el-text-secondary`. Alert band
`--el-danger-surface`, ink `--el-danger-on-surface`, its next-action line `--el-text-secondary`, the
slot a dashed `--el-border-strong` box. Withdrawn port `--el-muted` + `--el-text-secondary`. Row
outcome pills: _Merging_ / _Joining the merge queue_ sky + `dots` · _Queued to merge_ peach + `clock`
· _Merged_ mint + `git-merge` · _Not merged_ rose + `x` · _Not merged yet_ neutral + `git-pr`.

#### Copy — `en` + `zh`

The kind's words, keyed under `approvalGate.pullRequestApproval` for
[MOTIR-5484](motir:cmu1aj1bj00gkhyoi0iuds6xy) to ship. _Cancel_, _Yes, {verb}_, _Approving this will:_,
_Awaiting you_, _Awaiting_, _Approved_, _Withdrawn_, _Waiting on {name}._ and every refusal are the
frame's shipped `approvalGate.*` strings and are not re-keyed.

| key                         | en                                                                                                                | zh                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `kindLabel`                 | Pull requests                                                                                                     | 拉取请求                                                                                            |
| `meta.delivered`            | {count} pull requests · delivered by {run}                                                                        | {count} 个拉取请求 · 由 {run} 交付                                                                  |
| `meta.approved`             | Approved by {name} · {count} pull requests                                                                        | 由 {name} 批准 · {count} 个拉取请求                                                                 |
| `meta.approvedByYou`        | Approved by you just now · {count} pull requests                                                                  | 刚刚由你批准 · {count} 个拉取请求                                                                   |
| `meta.withdrawn`            | {count} pull requests · the head of {pr} moved                                                                    | {count} 个拉取请求 · {pr} 的最新提交已变更                                                          |
| `verb.approveAndMerge`      | Approve and merge                                                                                                 | 批准并合并                                                                                          |
| `consequence.named`         | Approving merges {merged} and adds {queued} to its merge queue, then moves {key} to Approved.                     | 批准后将合并 {merged}，并将 {queued} 加入其合并队列，然后将 {key} 标记为已批准。                    |
| `consequence.namedAllMerge` | Approving merges {prs}, then moves {key} to Approved.                                                             | 批准后将合并 {prs}，然后将 {key} 标记为已批准。                                                     |
| `consequence.counted`       | Approving merges {mergeCount} pull requests and adds {queueCount} to a merge queue, then moves {key} to Approved. | 批准后将合并 {mergeCount} 个拉取请求，并将 {queueCount} 个加入合并队列，然后将 {key} 标记为已批准。 |
| `confirm.records`           | record that you approved these {count} commits, with the time;                                                    | 记录你已批准这 {count} 个提交，连同时间；                                                           |
| `confirm.mergeNow`          | merge {pr} now;                                                                                                   | 立即合并 {pr}；                                                                                     |
| `confirm.joinQueue`         | add {pr} to its repository's merge queue, which merges it when the queue's checks pass;                           | 将 {pr} 加入其仓库的合并队列，队列检查通过后由其合并；                                              |
| `confirm.movesToApproved`   | move {key} to Approved. It moves to Done when every merge lands.                                                  | 将 {key} 标记为已批准。所有合并完成后将标记为已完成。                                               |
| `record.approved`           | Approved by {name} · {time} · {count} commits                                                                     | 由 {name} 批准 · {time} · {count} 个提交                                                            |
| `progress`                  | Merging {merged} and adding {queued} to its merge queue…                                                          | 正在合并 {merged}，并将 {queued} 加入其合并队列…                                                    |
| `queued.why`                | {key} stays Approved until the merge queue lands {pr}.                                                            | 在合并队列合入 {pr} 之前，{key} 保持已批准状态。                                                    |
| `merged.why`                | Every pull request merged. {key} moves to Done when {host} reports the merges.                                    | 所有拉取请求均已合并。{host} 报告合并后，{key} 将标记为已完成。                                     |
| `outcome.merging`           | Merging                                                                                                           | 合并中                                                                                              |
| `outcome.joiningQueue`      | Joining the merge queue                                                                                           | 正在加入合并队列                                                                                    |
| `outcome.queued`            | Queued to merge                                                                                                   | 已加入合并队列                                                                                      |
| `outcome.refused`           | Not merged                                                                                                        | 未合并                                                                                              |
| `outcome.notMergedYet`      | Not merged yet                                                                                                    | 尚未合并                                                                                            |
| `outcome.retry`             | Retry merge                                                                                                       | 重试合并                                                                                            |
| `refused.title`             | {pr} was not merged.                                                                                              | {pr} 未合并。                                                                                       |
| `refused.stands`            | Your approval stands, and {other} merged.                                                                         | 你的批准仍然有效，{other} 已合并。                                                                  |
| `notMergedYet.why`          | {pr} has not merged yet. Retry it, or open it on {host} to see why.                                               | {pr} 尚未合并。请重试，或在 {host} 上打开查看原因。                                                 |
| `withdrawn.port`            | A push moved the head of {pr}, so this question was withdrawn.                                                    | 一次推送变更了 {pr} 的最新提交，因此该问题已被撤回。                                                |
| `withdrawn.portCite`        | Nobody decided it. Motir asks again when every check is green.                                                    | 没有人对它做出决定。所有检查通过后，Motir 会再次请求审批。                                          |

#### GIVES / TAKES

Scope: every `MOTIR-n` this card's text introduces into an asset it edits, measured with
`grep -o 'MOTIR-[0-9]*' <asset> | sort -u` against `HEAD`. `approve-and-merge.mock.html` carries 26
keys: six are this card's (MOTIR-4882, 5479, 5480, 5482, 5483, 5484), and the other twenty are
`github.mock.html`'s own sprite and token provenance, carried verbatim and GIVING or TAKING nothing.
`github.mock.html` gains MOTIR-5480 only (41 → 42), and `approvals-row.mock.html` gains MOTIR-5437
and MOTIR-5480 (19 → 21).

| key                                           | GIVES / TAKES                                                                                                                                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [MOTIR-5484](motir:cmu1aj1bj00gkhyoi0iuds6xy) | **GIVES** every panel above, the copy and the flush frame. **TAKES** its first criterion's _"the consequence line … names each `owner/name · #n`"_ for three or more, and its _"`ApprovalGateControl.tsx` is unchanged"_ (the frame gains `layout: 'flush'`) — **both amended on the card, 2026-09-15** |
| [MOTIR-5483](motir:cmu1aj19x00gihyoi0b6lixcm) | **GIVES** the four outcomes it returns a drawing each (`merged` 12s/12t · `enqueued` 12s · `refused` 12u · `no_merge_gate` a row left unchanged). **TAKES** nothing                                                                                                                                     |
| [MOTIR-5482](motir:cmu1aj18f00gghyoik41ycibt) | **GIVES** the withdrawn state (12v). **TAKES** nothing                                                                                                                                                                                                                                                  |
| [MOTIR-5479](motir:cmu1aj13z00gahyoip0mfmjqw) | **TAKES** decisions 3–5, which these panels draw. Nothing either way beyond that                                                                                                                                                                                                                        |
| [MOTIR-4882](motir:cmtrwx3580055hxph0vfamj1l) | **TAKES** its refusal union, cited in 12u's slot and not re-worded, and which member queues. Nothing given                                                                                                                                                                                              |
| [MOTIR-5437](motir:cmu118c1q0007hytx0tt38vq4) | **GIVES** these states for its overlay to compose, and the To-approve row it later gives a _Review_ door (workbench § 23). **TAKES** nothing                                                                                                                                                            |
| [MOTIR-5327](motir:cmtzoqqmt00bzhvtxgxduxev2) | done; its Panels 12c and 12o are **corrected on the sheet** (the running row turned green). No criterion of its changes                                                                                                                                                                                 |
| MOTIR-5461 (the ejection story)               | **nothing either way** — what a row shows after a queue EJECTS its pull request is its own design                                                                                                                                                                                                       |

## 21 · The Development block's RED state — a copyable `motir fix`, a fix in progress, a fix that gave up (MOTIR-5463, 2026-09-16)

**AMENDS § 20** — Panels 12a / 12b (the block), 12d (the copyable code block) and 12m (the child
pointer) in `design/github/github.mock.html` — in the delta
**[`github--fix-callout.mock.html`](./github--fix-callout.mock.html)**, Panels **F1–F4**, each at
desktop, dark and ~400px. Card MOTIR-5463. **No existing mock is edited** and no image export ships
(`docs/decisions/design-result.md` AMENDMENT 4; `CLAUDE.md` § "Design assets — TWO files per
surface"). The component that builds every panel is **MOTIR-5466**.

**Why it is owed.** On an Implemented card whose run has ended, a red pull request shows the
_Checks failing_ pill (§ 20's tone table: `severity="danger"`, `--el-tint-rose`, lucide `circle-x`)
and nothing to do about it. The product has no hosted dispatch, so what the card hands over is a
**command**: `motir fix <key>`.

**Access path.** The item page → the **Development card** (Panels 12a / 12b). No new entry point:
the new **fix part** sits inside that card, below the rows' caption and above How to test. Every
panel draws the card on its item page (key, title, status) so the reader sees where it lives.

### Rendered against shipped reality, not redrawn

`DevelopmentSectionBody` was rendered at `origin/main` `3205ae235` with the shipped fixtures
(`tests/helpers/howToTestFixtures`) and a row's `ci` set to `failing`: the rows, the caption, How to
test's `Part` (`mt-4 flex min-w-0 flex-col gap-3 border-t border-(--el-border-soft) pt-4` with an
`h4`) and the child pointer are that output. The code block is
`components/markdown/CopyableCodeBlock.tsx` (Panel 12d): the delta's `.dvb-code*` / `.dvb-copy` rules
are `github.mock.html`'s byte for byte, and the fix part **composes** that component with
`language="shell"` — exactly what How to test's _Locally_ fact already does
(`<CopyableCodeBlock language="shell" code={repo.fetchCommand} />`). No second code block is drawn.

### The panels, and the card that builds each

| panel | state                                                                                                                                                                                    | shown when (the repair claim's answer, MOTIR-5464)                                                                                         | built by   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| F1    | **Red, nobody fixing it** — the failing set named `owner/name · #n`, `motir fix ACME-12` in Panel 12d's code block with its _Copy_ control, one sentence on what the agent does          | `implemented`, ≥ 1 row failing, none running, **no open `fix` run** → `claimed`. A `fix` run that was **stopped** (interrupted) lands here | MOTIR-5466 |
| F2    | **A fix in progress** — _Being fixed by Mara S. · started 4 min ago_, a sky _Fixing_ pill, **no code block and no Copy control**                                                         | an **open** `fix` dispatch run → `taken` (or `mine` for the viewer: _Being fixed by you_)                                                  | MOTIR-5466 |
| F3    | **The last fix gave up** — a danger callout _The last fix gave up after 5 attempts · 20 min ago_, a rose _Gave up_ pill, and the command **offered again**                               | the latest `fix` run is **failed**, and nothing is open                                                                                    | MOTIR-5466 |
| F4    | **A child of a container run** — names its own failing pull request, then _Run the fix from ACME-12 — …_; **no command**. Panel 12m's _Tested as part of ACME-12_ stays below, unchanged | `not_repairable` / `repair_on_run_target`, which names the run-target key                                                                  | MOTIR-5466 |

**Not shown (state 5 — a note, not a panel).** The part renders **nothing**, and the card is exactly
Panel 12a / 12b, when any check is **running**, when every check is **passing**, when **no check**
reported, when the card has **no pull request**, or when the card is **not `implemented`** — the
claim's `ci_running`, `not_failing`, `no_pull_requests` and `not_implemented`. The part and the claim
read **one predicate**; the part never shows a command the claim would refuse.

**With an approve-and-merge gate.** MOTIR-4909's frame is not redrawn. On a card with both a red pull
request and a gate the fix part keeps the same place — **inside band 2 (the port), below the rows'
caption, above How to test** — and the port's `[data-port]` rule lifts its code block to
`--el-card`, as for every code block in the port. (Under § 20's decision 3 a gate is raised only on an
all-green set, and a push withdraws it, so this pairing is rare: a check that turns red on an
unchanged head.)

### Decisions

| decision                  | chosen                                                                                                                                                                                      | why                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the "callout"'s container | **a flush part** of the Development card — a soft rule and an `h4` (_Fix the checks_), the grammar How to test uses; **not** a box                                                          | a container does not go inside the card that already names it (§ 20, _No card inside a card_); a boxed callout would also nest Panel 12d's bordered code block inside a second box |
| where it sits             | **below the rows' caption, above How to test**                                                                                                                                              | it acts on the rows just read; How to test is evidence for a green set and reads after the repair                                                                                  |
| naming the failing set    | the **same string the row's meta line carries** (`moooon/motir-core · #131`), bold, never broken; one or more joined by the locale's list format (`Intl.ListFormat`, `type: 'conjunction'`) | read together with the rows, as § 20's repository sub-headings are                                                                                                                 |
| the command               | **`motir fix {key}`**, the card's own key, in `CopyableCodeBlock language="shell"`; the copy writes exactly that string                                                                     | one control the product already ships, with its rest / hover / copied / failed states                                                                                              |
| in progress               | **no command at all**, not a disabled one                                                                                                                                                   | a second person must not start a second repair; the claim would refuse it anyway (`taken`)                                                                                         |
| the time                  | **relative** (`Intl.RelativeTimeFormat`, minutes then hours then days) with `formatRunInstant` in `title`, on a `<time datetime>`                                                           | the card's wording (_started 4 min ago_); `ApprovalRow`'s relative label is the precedent. The absolute run time stays one hover away, in the run area's one format                |
| gave up                   | the shipped callout shape (`.dvb-callout`) on **`--el-danger-surface`**, then the command again                                                                                             | a terminal state owes its own drawing, and its next move is to run it again                                                                                                        |
| the attempt count         | **data** — the `attempts` field of the failed run's `ci_gave_up` event (`CiWatchOutcome` in `packages/cli/src/ciWatch.ts`)                                                                  | the cap is `CI_FIX_ATTEMPTS` (5 today) and is meant to become a setting; a literal 5 would lie the day it changes                                                                  |
| stopped                   | a `fix` run that ended **stopped** (stop reason `interrupted`) draws **F1**, with no history line                                                                                           | nothing is running and nothing gave up; the person who stopped it knows why                                                                                                        |
| the child                 | **names its own failing row**, then points at the run target by key; **no command**                                                                                                         | the repair runs on the run target (`repair_on_run_target`), where every pull request of the run is fixed together                                                                  |

### Fields read

| rendered element           | field(s) read                                                                                                                                          | panel |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| whether the part renders   | the card's status (`implemented`) and each row's `ci` — the same predicate as the repair claim's `not_repairable` reasons                              | all   |
| the failing set            | the rows with `ci === 'failing'` → `repo` + `number` (the claim's failing PRs carry `{ repo, number, url, headRef, baseRef, ci }`)                     | F1–F4 |
| the command                | the card's own key → `motir fix {key}`                                                                                                                 | F1 F3 |
| the holder and start       | the **open** dispatch run with `command = fix` scoped to the card → its user's display name (`createdBy`) and `startedAt`; _you_ when it is the viewer | F2    |
| the attempt count and time | the **latest** `fix` run with `status = failed` → the `attempts` of its `ci_gave_up` event's `data`, and the run's `endedAt`                           | F3    |
| the run target             | `repair_on_run_target`'s run-target key (the same key § 20's `runTarget` gives the child pointer)                                                      | F4    |

### Tone and tokens

`--el-*` colour and element-semantic shape tokens only; each `fx-` rule in the delta quotes the class
string MOTIR-5466 builds it from. The part: `border-(--el-border-soft)` rule, `h4` in `--el-text`. The
failing line: `--el-text`, its `circle-x` glyph in `--el-danger-on-surface`. The holder and child lines:
`--el-text-secondary`, the name in `--el-text`, the glyph `--el-icon-muted`. The sentence under the
command: `--el-text-secondary`. The gave-up callout: `--el-danger-surface` + `--el-danger-surface-text`
(tint + strong ink, finding #35), `rounded-(--radius-card)`. Pills ride the shipped `Pill` axes, no new
variant: _Fixing_ `status="in-progress"` (sky) + `circle-ellipsis`; _Gave up_ `severity="danger"` (rose)

- `triangle-alert`. No new sprite: `audit-mock-sprites --strict` on the delta — 44 symbols, 0 drifted,
  0 undeclared.

### Copy — `en` + `zh`

One namespace, **`github.development.fix`**, beside `github.development.howToTest`. The code block's
_Copy_ / _Copied_ / failure strings are `github.development.howToTest.code.*`, shipped and not
re-keyed. The fence label `shell` is not translated. The CLI's own refusal text is not this card's.

| key             | en                                                                                          | zh                                                                          |
| --------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `title`         | Fix the checks                                                                              | 修复检查                                                                    |
| `aria.part`     | Fix the checks                                                                              | 修复检查                                                                    |
| `failingOn`     | Checks are failing on {prs}.                                                                | {prs} 的检查未通过。                                                        |
| `lead`          | Hand the repair to an agent from your terminal:                                             | 在终端中将修复交给智能体：                                                  |
| `how`           | An agent works on the pull request's own branch, pushes, and the checks run again.          | 智能体在该拉取请求自己的分支上工作并推送，然后检查会重新运行。              |
| `howMany`       | An agent works on each pull request's own branch, pushes, and the checks run again.         | 智能体在每个拉取请求自己的分支上工作并推送，然后检查会重新运行。            |
| `fixing.pill`   | Fixing                                                                                      | 修复中                                                                      |
| `fixing.by`     | Being fixed by {name} · started {time}                                                      | {name} 正在修复 · {time}开始                                                |
| `fixing.byYou`  | Being fixed by you · started {time}                                                         | 你正在修复 · {time}开始                                                     |
| `fixing.why`    | Only one fix runs at a time. The checks run again when the agent pushes.                    | 同一时间只运行一个修复。智能体推送后，检查会重新运行。                      |
| `gaveUp.pill`   | Gave up                                                                                     | 已放弃                                                                      |
| `gaveUp.title`  | The last fix gave up after {attempts, plural, one {# attempt} other {# attempts}}           | 上一次修复在尝试 {attempts} 次后放弃                                        |
| `gaveUp.body`   | The checks are still red. Run it again, or open the pull request to see which check fails.  | 检查仍未通过。请再次运行，或打开拉取请求查看是哪项检查失败。                |
| `child.pointer` | Run the fix from {key} — this card was built as part of that run, so its repair runs there. | 请从 {key} 运行修复——此工作项是作为该运行的一部分构建的，修复也在那里运行。 |

`{time}` is the relative label (_4 min ago_ / _4分钟前_) and `gaveUp.title` is followed by
` · {time}.` in both locales; `{prs}` is the list-formatted failing set (_A and B_ / _A和B_).

### Scope

**Drawn:** the fix part in its four states, each at desktop, dark and ~400px; the not-shown rule; the
place under a gate. **Not drawn, and whose it is:** the component — MOTIR-5466; the claim and its
outcomes — MOTIR-5464; `motir fix` and its terminal output, including every refusal — MOTIR-5465; the
approve-and-merge frame — MOTIR-4909 (§ 20, _The verbs and their states_); the acceptance video —
MOTIR-5468. How to test (Panel 12b) is unchanged and abbreviated on the sheet.

### GIVES / TAKES

Scope: `grep -o 'MOTIR-[0-9]*' <asset> | sort -u` over the two edited assets.
`github--fix-callout.mock.html` carries **26** keys: four are this section's (MOTIR-5463, 5464, 5465,
5466); the other 22 (among them MOTIR-4909, cited again in the sheet's gate note) are
`approve-and-merge.mock.html`'s stylesheet and sprite provenance, carried verbatim, and GIVE or TAKE
nothing here. This notes file gains MOTIR-5463, 5464, 5465, 5466 and 5468.

| key        | GIVES / TAKES                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOTIR-5466 | **GIVES** every panel (F1–F4), the not-shown rule, the copy and the tokens above — it builds the fix part. **TAKES** nothing it does not already own                                                                                                                                                                                                                                                              |
| MOTIR-5464 | **GIVES** each outcome a drawing (`claimed` F1 · `taken` / `mine` F2 · `repair_on_run_target` F4 · the other `not_repairable` reasons the not-shown rule). **TAKES** the read the panels need: the open `fix` run's **holder display name and `startedAt`**, and the **latest ended `fix` run** (status, `endedAt`, and its `ci_gave_up` `attempts`) — a read beside the claim, not only the claim's own response |
| MOTIR-5465 | **TAKES** that a gave-up `motir fix` records its **attempt count as data** on the run — the `ci_gave_up` event's `attempts`, as `motir run`'s CI watch already writes it — and closes the run with `status = failed` and `endedAt`; a green fix ends with stop reason `completed`, an interrupt with `interrupted`. **GIVES** nothing drawn: its terminal output is not this card's                               |
| MOTIR-4909 | **nothing either way** — its frame is not redrawn; the fix part keeps its place inside band 2                                                                                                                                                                                                                                                                                                                     |
| MOTIR-5468 | **GIVES** the four states as the acceptance video's script (F1 → F2 → F3, and F4 on a child). **TAKES** nothing                                                                                                                                                                                                                                                                                                   |
| MOTIR-5463 | this card                                                                                                                                                                                                                                                                                                                                                                                                         |

Fixture items use `ACME-n` keys (the card's `MOTIR-123` placeholder is drawn as `ACME-12`, as the
rest of this area does), so they link to nothing.

## 22 · The Development frame after a merge-queue EJECTION — _Left the queue_, the reason in words and its failing check, _Queue again_ on the card's own approval (MOTIR-5631, 2026-09-16)

**AMENDS § 20** — _The verbs and their states_ (MOTIR-5480), Panels **12s** (_Queued to merge_),
**12u / 12u′** (one refused, RETRY in place) and **12v** (withdrawn by a push) in
`design/github/approve-and-merge.mock.html` — and the ONE-gate delta
`design/workbench/approvals-row--one-gate.mock.html` (`design/workbench/design-notes.md` § 25,
MOTIR-5612), which drew RETRY on the card's own gate. The delta is
**[`approve-and-merge--ejected.mock.html`](./approve-and-merge--ejected.mock.html)**, Panels
**E1–E7** (plus E2′, the press answered), each at desktop, dark and ~400px. Card MOTIR-5631, Story
MOTIR-5461. **No existing mock is edited** and no image export ships (`docs/decisions/design-result.md`
AMENDMENT 4). The behaviour drawn is `docs/decisions/approval-gates.md` § 4 **THIRD AMENDMENT**
(MOTIR-5629); each panel cites its decision. The component that builds every panel is **MOTIR-5635**.

**Why it is owed.** `MergeOutcomeSlot` knows `merging` · `merged` · `queued` · `refused` ·
`notMergedYet`. It has no picture for _the queue threw this out_, so an ejected pull request would
read _Queued to merge_ for ever. The one distinction the frame must make at a glance: **the approved
code is unchanged** → one press puts it back and nobody is asked again; **new commits arrived** → the
old approval no longer covers them, and the card asks again on green.

### Access path

- The item page → the **Development block** (§ 20, Panels 12a / 12c), reached from any board card,
  list row or Workbench row that opens the card. The ejected row is one of the frame's own rows; no
  new entry point.
- The same frame inside the **full-screen approval overlay** (MOTIR-5437), opened from the item
  page's _Review & approve_ control — it renders the Development block as its port, so every panel
  here reads the same there.
- **An ejected card is NOT in _To approve_.** Its `pull_request_approval` gate is **decided**
  (approved), and _To approve_ lists awaiting gates only; the ejection raises no gate (decision 5),
  so nothing new appears in the queue. The card is found through its own surfaces — and, once built,
  the card badge (a sibling story's, not drawn here). A card whose head moved (E3) comes back to
  _To approve_ only when the fresh gate is raised on green (decision 6, Panel 12p).

### Rendered against shipped reality, not redrawn

The frame (`components/github/DevelopmentGateFrame.tsx` — `outcomeFor`, `recordDetail`), the row
(`PullRequestRow` with the outcome slot beside the host pill), the record band, the refusal band
(12u) and How to test are composed from `approve-and-merge.mock.html`'s stylesheet and sprite,
carried verbatim at `origin/main` `58bb046d0`. New rules are the `ej-` block only, each quoting the
class string MOTIR-5635 builds it from. **No panel shows a second gate or a per-pull-request approval
control**: every frame has ONE record band, _Approved by Ada L._, and no verb row.

### The panels, the decision each depicts, and the card that builds it

| panel | state                                                                                                                                                                                                                                                                                                                                              | status rail | decision | built by   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------- | ---------- |
| E1    | **Ejected, heads unchanged, `manual`** — the row's slot reads **Left the queue** (rose) and offers **Queue again** exactly where _Retry merge_ sits in 12u′; the record band keeps _Approved by_ and adds the exit: reason in words, _Failing check: {name}_ as a link, and _your approval still covers these commits_. The sibling keeps _Merged_ | Implemented | 3, 5, 8  | MOTIR-5635 |
| E2    | **Queue again pressed** — `MergeOutcomeSlot`'s shipped `retrying` treatment: the row keeps _Left the queue_, the button is disabled (`disabled:opacity-50`), the record band shows the progress line                                                                                                                                               | Implemented | 5        | MOTIR-5635 |
| E2′   | **The press answered** — the row is 12s again (_Queued to merge_, peach) and the rail reads **Approved**, written through the decided gate's own path; the exit line is gone, its row stays on the pull request for the audit                                                                                                                      | Approved    | 5        | MOTIR-5635 |
| E3    | **Ejected, then a push moved the head** — no _Queue again_; the slot reads **New commits since approval** (neutral); the frame keeps the decided record and draws no verbs (12v's grammar, composed). On green the card is promoted to In Review with ONE fresh question (12p)                                                                     | Implemented | 6        | MOTIR-5635 |
| E4    | **Neutral removal** (`MANUAL`, `QUEUE_CLEARED`, `ROLL_BACK`, unknown) — **Removed from the queue** (neutral, `circle-minus`), the reason in words, **Queue again** offered, no check line                                                                                                                                                          | Approved    | 4, 5     | MOTIR-5635 |
| E5    | **`auto` mode** — no gate, so no frame: § 20's Panel 12a with the exit as a **flush part** (§ 21's grammar: a soft rule and an `h4` _Merge queue_) between the rows' caption and How to test; **Queue again** is offered to anyone who may edit the card                                                                                           | Implemented | 3, 5     | MOTIR-5635 |
| E6    | **No failing check known** — `MERGE_CONFLICT` has no merge group; a check the product could not tie back is the same case. The reason line stands alone, nothing invented                                                                                                                                                                          | Implemented | 8        | MOTIR-5635 |
| E7    | **Queue again refused** — 12u's rose band in place, _{pr} was not queued again._, the refusal copy from the one vocabulary (drawn: `mergeAlreadyRequeued`; also `APPROVAL_GATE_SUPERSEDED` and the host's `MERGE_*` members), _Your approval stands._                                                                                              | Implemented | 5, 6     | MOTIR-5635 |

### New `MergeOutcomeSlot` kinds

| kind               | pill                                                           | offers        | shown when (fields below)                                                                  |
| ------------------ | -------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------ |
| `leftQueue`        | _Left the queue_ · `severity="danger"` (rose) · `circle-x`     | _Queue again_ | latest exit is `failure`, not requeued, and the pull request's head equals the exit's head |
| `removedFromQueue` | _Removed from the queue_ · `tone="neutral"` · `circle-minus`   | _Queue again_ | latest exit is `neutral`, not requeued, head unchanged                                     |
| `newCommits`       | _New commits since approval_ · `tone="neutral"` · `git-branch` | nothing       | latest exit not requeued, and the head has moved since the exit                            |

`requeueable` from `listApprovalMembers` (MOTIR-5634) is the one predicate for _offers Queue again_;
the slot never offers a press the server would refuse as `head_moved` or `no_exit`. The pressed
state reuses the shipped `retrying` sub-state; a requeued exit (`requeuedAt` set) falls back to the
row's ordinary outcome (`queued`, E2′).

### The reason map, in words

One string per **raw reason** (decision 2's table, exact match). A failure reads under _left the
merge queue_, a neutral under _was removed from the merge queue_. An unrecognised string renders the
`unknown` sentence — never the raw value.

### Fields read

| rendered element          | field(s) read                                                                                                                                              | panel          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| which kind the slot shows | the member's `exit` (`PullRequestQueueExitDTO`: `rawReason`, `disposition`, `headSha`, `exitedAt`, `requeuedAt`), the PR's current head, and `requeueable` | E1–E7          |
| the reason sentence       | `exit.rawReason` → `exit.reason.*`                                                                                                                         | E1, E3–E7      |
| the failing check         | the exit's failing-check name and URL (decision 8; MOTIR-5633) — absent → no line                                                                          | E1, E3, E5, E7 |
| the record band           | the decided gate's `decidedBy` / `decidedAt` / commit count — unchanged from § 20                                                                          | E1–E4, E6, E7  |
| the rail                  | the card's status (`implemented` after a failure; unchanged after a neutral)                                                                               | all            |
| the refusal               | the press's refusal tag through `lib/approvalGates/refusals.ts`                                                                                            | E7             |

### Tone and tokens

`--el-*` colour and element-semantic shape tokens only. The exit line: `--el-text`, repository ·
number bold and unbroken; its glyph `--el-danger-on-surface` for a failure, `--el-icon-muted` for a
neutral. The follow-on lines (_Failing check_, _your approval still covers…_, the auto sentence):
`--el-text-secondary`, indented to the text column. The check link: `--el-link`, underlined, with the
shipped external glyph. The auto part: `border-(--el-border-soft)` rule, `h4` in `--el-text`. Pills
ride the shipped `Pill` axes, no new variant. The refusal band is 12u's
(`--el-danger-surface` + `--el-danger-on-surface`). No new sprite symbol: `audit-mock-sprites
--strict` on the delta — 44 symbols, 0 drifted, 0 undeclared.

### Copy — `en` + `zh`

Under **`approvalGate.pullRequestApproval`**, beside `outcome.queued`. The refusal body is the
shipped `approvalGate.refusal.mergeAlreadyRequeued` (MOTIR-5634), not re-keyed. `{pr}` is the row's
`owner/name · #n`.

| key                                | en                                                                                                                | zh                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `outcome.leftQueue`                | Left the queue                                                                                                    | 已离开合并队列                                                                     |
| `outcome.removedFromQueue`         | Removed from the queue                                                                                            | 已从合并队列中移除                                                                 |
| `outcome.newCommits`               | New commits since approval                                                                                        | 批准后有新提交                                                                     |
| `outcome.queueAgain`               | Queue again                                                                                                       | 重新排队                                                                           |
| `exit.left`                        | {pr} left the merge queue: {reason}                                                                               | {pr} 已离开合并队列：{reason}                                                      |
| `exit.removed`                     | {pr} was removed from the merge queue: {reason}                                                                   | {pr} 已被移出合并队列：{reason}                                                    |
| `exit.reason.CI_FAILURE`           | its checks failed in the merge queue.                                                                             | 它的检查在合并队列中未通过。                                                       |
| `exit.reason.CI_TIMEOUT`           | its checks timed out in the merge queue.                                                                          | 它的检查在合并队列中超时。                                                         |
| `exit.reason.MERGE_CONFLICT`       | it no longer merges cleanly with the changes ahead of it.                                                         | 它与排在前面的更改无法再干净地合并。                                               |
| `exit.reason.INVALID_MERGE_COMMIT` | the queue could not build a merge commit for it.                                                                  | 合并队列无法为它生成合并提交。                                                     |
| `exit.reason.GIT_TREE_INVALID`     | the queue could not build its tree.                                                                               | 合并队列无法为它生成文件树。                                                       |
| `exit.reason.BRANCH_PROTECTIONS`   | a branch protection rule stopped it.                                                                              | 分支保护规则阻止了它。                                                             |
| `exit.reason.MANUAL`               | someone took it out.                                                                                              | 有人把它移出了队列。                                                               |
| `exit.reason.QUEUE_CLEARED`        | the merge queue was cleared.                                                                                      | 合并队列已被清空。                                                                 |
| `exit.reason.ROLL_BACK`            | it was taken out for a roll-back.                                                                                 | 因回滚而被移出。                                                                   |
| `exit.reason.unknown`              | GitHub did not say why.                                                                                           | GitHub 未说明原因。                                                                |
| `exit.failingCheck`                | Failing check: {check}                                                                                            | 未通过的检查：{check}                                                              |
| `exit.unchanged`                   | Your approval still covers these commits, so **Queue again** puts it back with no new approval.                   | 你的批准仍覆盖这些提交，**重新排队**即可放回队列，无需再次批准。                   |
| `exit.newCommits`                  | It has new commits since your approval. Motir asks again when every check is green.                               | 你批准后它有了新提交。所有检查通过后，Motir 会再次征求批准。                       |
| `exit.auto`                        | Motir merges this project’s pull requests when they are green. **Queue again** sends it back at the same commits. | Motir 会在检查通过后合并本项目的拉取请求。**重新排队**会以相同的提交将它放回队列。 |
| `exit.partTitle`                   | Merge queue                                                                                                       | 合并队列                                                                           |
| `requeue.progress`                 | Adding {pr} back to its merge queue…                                                                              | 正在将 {pr} 放回合并队列…                                                          |
| `requeue.refusedTitle`             | {pr} was not queued again.                                                                                        | {pr} 未能重新排队。                                                                |

After E2′ the record band reads the shipped `queued.why`; after E7 the band closes with the shipped
`refused.standsAlone`.

### Scope

**Drawn:** the ejected row in its three kinds, the press and its answer, the refusal, the exit in the
record band (`manual`) and as a flush part (`auto`), each at desktop, dark and ~400px. **Not drawn,
and whose it is:** the reason map and data shape — MOTIR-5629 / MOTIR-5632; the requeue route and its
refusals — MOTIR-5634; the failing-check capture — MOTIR-5633 (behind the grant MOTIR-5638); the card
BADGE on boards and lists — the sibling story's; the component — MOTIR-5635. How to test is unchanged and
abbreviated on the sheet.

### GIVES / TAKES

Scope: `grep -o 'MOTIR-[0-9]*' <asset> | sort -u`. `approve-and-merge--ejected.mock.html` carries
**25** keys: four are this section's (MOTIR-5461, 5629, 5631, 5635); the other 21 are the base
mock's stylesheet and sprite provenance, carried verbatim, and GIVE or TAKE nothing here.

| key        | GIVES / TAKES                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOTIR-5635 | **GIVES** every panel, the three slot kinds, the copy and the tokens above — it builds them. **TAKES** nothing it does not already own                              |
| MOTIR-5632 | **TAKES** that the member read carries the latest exit (`PullRequestQueueExitDTO`) and the PR's current head, so the slot can tell E1 from E3 without a second read |
| MOTIR-5634 | **TAKES** that `requeueable` is the single predicate for drawing _Queue again_, and that a refused press answers with a tag in the one refusal vocabulary (E7)      |
| MOTIR-5633 | **TAKES** the failing check's **name and URL** on the exit; absent, the frame draws E6's lone reason                                                                |
| MOTIR-5629 | **GIVES** decisions 2–8, cited per panel. **TAKES** nothing                                                                                                         |
| MOTIR-5631 | this card                                                                                                                                                           |

Fixture items use `ACME-n` keys, so they link to nothing.

## 23 · A decision made ON GITHUB — the review chip while the gate waits, the record band that names an unmapped reviewer, and the merge that follows (MOTIR-5592, 2026-09-17)

**AMENDS § 20** — the Development block as the ONE gate (MOTIR-5327) — and its _The verbs and their
states_ subsection (MOTIR-5480), in `design/github/approve-and-merge.mock.html`. The delta is
**[`approve-and-merge--github-review.mock.html`](./approve-and-merge--github-review.mock.html)**,
Panels **G1–G8**: the six frame states at desktop, dark and ~400px, and the two other surfaces a
decision reaches (G7 the Approvals room, G8 the Workbench's _To approve_ tab) at desktop and dark.
Card MOTIR-5592, Story MOTIR-4910. **No existing mock is edited** and no image export ships
(`docs/decisions/design-result.md` AMENDMENT 4). The behaviour drawn is
`docs/decisions/approval-gates.md` § 8 **FOURTH AMENDMENT** (MOTIR-5590); each panel cites its
decision. The surfaces that build these panels are **MOTIR-5599** (the frame, the band and the room)
and **MOTIR-5602** (the chip's data).

> **⚠️ NUMBERED 23, NOT 21.** MOTIR-5592's card asks for a `## 21`. Sections 21 (the RED state,
> MOTIR-5463) and 22 (the merge-queue ejection, MOTIR-5631) landed between that card being authored
> and this run, so 21 was taken. The shipped file outranks the card's prose; the section takes the
> next free number and the card's other criteria are unaffected.

**Why it is owed.** A team that reviews on GitHub approves a pull request there and never opens
Motir. Without a drawing, the frame has two ways to be wrong at a glance, and both are worse than
nothing: it can show an approval that **does not count** as though the gate were satisfied, or it can
show a card **Approved** while its pull requests sit unmerged, which is the state the two-gate model
used to produce and MOTIR-5609 retired. Everything below exists to make the one-gate answer legible:
_every member, at its current head, or the gate still waits_ — and _deciding it merged them_.

### Access path

- The item page → the **Development block** (§ 20, Panels 12a / 12c), reached from any board card,
  list row or Workbench row that opens the card. The review chip is a state of one of the frame's
  own rows; **no new entry point, and no new verb.**
- The same frame inside the **full-screen approval overlay** (MOTIR-5437), opened from the item
  page's _Review & approve_ control — it renders the Development block as its port, so every panel
  here reads the same there.
- The **Approvals room** (G7) and the Workbench's **To approve** tab (G8), both unchanged as
  destinations; only what their cells say is new.

### Rendered against shipped reality, not redrawn

The frame (`components/github/DevelopmentGateFrame.tsx`), the row (`PullRequestRow` with
`components/github/MergeOutcomeSlot.tsx` in its second slot), the record band
(`components/approvals/ApprovalGateControl.tsx`) and the room's person column
(`app/(authed)/approvals/_components/ApprovalRecordsList.tsx`) are composed from
`approve-and-merge.mock.html`'s stylesheet and sprite, carried verbatim at `origin/main`
`6471cac0f`. New rules are the `ghr-` block only, each quoting the class string MOTIR-5599 builds it
from.

**⚠️ THE REVIEW CHIP REPLACES THE CI PILL, IT DOES NOT SIT BESIDE IT.** This is
`MergeOutcomeSlot`'s own shipped rule, and it holds here for the same reason it holds there: the
gate is raised only on an all-green set, so on a row that carries a review, _Checks passing_ has
nothing left to say. It is also the only thing that fits — drawn as a third pill, the row's title
collapses to two characters at 1400px, which is how this was found. **A row with no review keeps its
CI pill**, so G1 reads as _this one has been reviewed, that one is merely green_.

> **⚠️ AMENDED AT DESIGN REVIEW (Yue, 2026-09-17), and the first cut is kept visible because it
> was wrong in a way worth remembering.** The chip first read
> ~~_Approved on GitHub · @ada-l_~~. Three corrections — two about words, one about layout:
>
> **1. THE ROW DOES NOT NAME THE HOST.** _Approved_ is enough. The row IS a GitHub pull request
> — its meta line reads `moooon/motir-core · #131` and its link-out goes there — and the pill
> beside it says _Checks passing_, never _Checks passing on GitHub_. A chip that named the host
> would be the only element on the row that felt the need to. **Provenance is still stated where
> it is load-bearing**: the record band (G4–G6) says _Approved on GitHub by…_, because there the
> question is which DOOR decided the card's gate, and `decisionSource` is the audit's own field.
>
> **2. THE ROW DOES NOT NAME A REVIEWER.** ~~`· @login`~~ is gone. **A pull request can carry
> SEVERAL reviewers**, so one login on the row is a claim the row cannot make: it would show
> whichever countable review happened to be latest and read as though that person were _the_
> reviewer. The chip is about the pull request's STATE. The DECISION has exactly one decider —
> the review that completed the set — and the record band names them; the row does not.
>
> **3. THE PILL MUST NOT EVICT THE ROW AT ~400px.** It did — **in the first cut of this sheet,
> and only there.** The block below is the correction, and it corrects THIS ASSET rather than
> the product.

### ⚠️ THE NARROW PANELS WERE WRONG, AND THE PRODUCT WAS NOT — a correction

**The first cut of this sheet drew its narrow panels with the row EVICTED**: at ~400px the title,
the repo meta and the link-out were all gone, leaving a glyph and two pills. That was real, and it
was reported at design review. **It was a fault in THIS ASSET, not in the shipped surface** — and
the first cut's § 23 said the opposite, naming `.pr-text { min-width: 0 }` and
`.pr-states { flex: none }` and asserting a live defect on `main`. **That claim was false and is
withdrawn.** It is recorded rather than deleted because the way it went wrong is the lesson.

**What actually ships.** `PullRequestRow` already wraps, and has since **MOTIR-5351 (Panel 12n)** —
see _The narrow row_ earlier in this file, which specified it. The row is `@max-[30rem]:flex-wrap`
inside a `<ul className="@container">`, and its pill group is
`@max-[30rem]:order-last @max-[30rem]:basis-full @max-[30rem]:pl-[27px]`, so below a 30rem COLUMN
the glyph, title and link-out keep line 1 and the pills drop to line 2 indented under the title.
This sheet carries the same thing as `.pr-row.dvb-row-narrow`.

**What went wrong here.** A mock's `.pr-row` is a HAND-WRITTEN rendering of the component, and this
delta's narrow panels used the plain `.pr-row` — the DESKTOP row — at 400px. The class that makes it
a narrow row was in this sheet's own stylesheet, copied verbatim with everything else, and simply
never applied. The panels drew a row the product does not draw, and the eviction was an artefact of
the drawing. **They now carry `.pr-row.dvb-row-narrow`** and render as 12n does.

**The rule this is worth keeping for:** a mock REPRODUCES the shipped component, so a layout defect
visible only in a mock is a defect in the mock until it has been reproduced against the component.
Read the component's own classes before writing down that the product is broken. This sheet did not
— it filed a bug (**MOTIR-5654**, withdrawn) and put a false fact about `main` into a design of
record.

### The panels, the decision each depicts, and the card that builds it

| panel | state                                                                                                                                                                                                                         | status rail | gate                | decision | built by   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------- | -------- | ---------- |
| G1    | **One of two approved on GitHub** — row A carries _Approved_ (mint) in place of its CI pill, row B keeps _Checks passing_. The frame keeps **Approve and merge**: a person in Motir may still decide the set                  | In Review   | `awaiting`          | 1        | MOTIR-5599 |
| G2    | **An approval at an EARLIER commit** — _Approved an earlier commit_, **neutral, never rose**. Nothing went wrong; it simply does not count. The same treatment covers a reviewer without write access and a dismissed review  | In Review   | `awaiting`          | 2        | MOTIR-5599 |
| G3    | **Changes requested on GitHub** — the first countable one on any member decides; the band reads _Changes requested on GitHub by {name}_ and **the card stays In Review** (a gate's state is not a work item's status, § 6b)   | In Review   | `changes_requested` | 1        | MOTIR-5599 |
| G4    | **Approved on GitHub by a member, and MERGING** — the band names them with their login and commit count; the rows are already _Merging_ / _Queued to merge_. **No _Ready to merge_ press: the merge was not left for anyone** | Approved    | `approved`          | 3, 6     | MOTIR-5599 |
| G5    | **One member REFUSED by the host** — that row keeps the shipped _Not merged yet · Retry merge_, honest here because a merge was attempted; the sibling shows _Merged_ and the band still reads Approved                       | Approved    | `approved`          | 6        | MOTIR-5599 |
| G6    | **Approved by someone who is NOT a Motir member** — _Approved on GitHub by @login_, with **_Not a Motir member_ on a line of its own**. The merge follows identically                                                         | Approved    | `approved`          | 3        | MOTIR-5599 |
| G7    | **The Approvals room's decided row** — the _Decided by_ cell reads _{name} · on GitHub_ or _@login · on GitHub_, truncating at 144px as it already does                                                                       | —           | `approved`          | 3        | MOTIR-5599 |
| G8    | **The To-approve tab** — the card's one gate is decided, so its row **settles in place** (the shipped decided-row treatment) and the strip's count drops by one. **No second row follows it**                                 | —           | `approved`          | 1, 6     | MOTIR-5599 |

### What this delta does NOT draw, and why each absence is deliberate

- **No second gate, anywhere.** Under MOTIR-5609 the card has one approve-to-merge gate. A panel
  showing a merge gate left `awaiting` after a synced approval would draw the model this story was
  re-authored to remove.
- **No _Ready to merge_ affordance, and no `ready-to-merge` copy key.** G4 reuses the shipped
  merging / queued / merged words and G5 the shipped `outcome.retry` / `notMergedYet.why`; a new key
  here would be a second vocabulary for a state that already has one.
- **No new verb and no new entrance.** Every control on this sheet is one the frame already has.
- **Nothing posted back to GitHub** is not drawable — it is an absence in the product, asserted by
  MOTIR-5600's guard, not by a panel.
- **`auto` mode** raises no gate, so there is no frame to draw: a review is recorded and decides
  nothing (decision 10).

### Copy — keyed under `approvalGate.pullRequestApproval.github`

| key                       | `en`                                              | `zh`                                            | where                       |
| ------------------------- | ------------------------------------------------- | ----------------------------------------------- | --------------------------- |
| `chip.approved`           | Approved                                          | 已批准                                          | G1 · the row's second slot  |
| `chip.changesRequested`   | Changes requested                                 | 已请求修改                                      | G3 · the row's second slot  |
| `chip.earlierCommit`      | Approved an earlier commit                        | 批准的是较早的提交                              | G2 · the row's second slot  |
| `record.approved`         | Approved on GitHub by {name} · {time} · {commits} | 由 {name} 在 GitHub 上批准 · {time} · {commits} | G4 / G6 · the record band   |
| `record.changesRequested` | Changes requested on GitHub by {name}             | 由 {name} 在 GitHub 上请求修改                  | G3 · the record band        |
| `record.notMember`        | Not a Motir member                                | 不是 Motir 成员                                 | G6 · the band's second line |
| `decidedByOnGithub`       | {label} · on GitHub                               | {label} · 在 GitHub 上                          | G7 · the room's person cell |

`{name}` is the member's display name where Motir resolved the reviewer, and the bare `@login`
where it did not — one key, two labels, because the sentence is the same sentence. `{commits}` reuses
the shipped `record.commits` plural.

**A handle appears in exactly two places, and a ROW is not one of them** (Yue, 2026-09-17): the
record band, which names the one person who decided the card's gate, and the Approvals room's
person cell, which is the same fact in a table. Where it appears it is monospace (`.ghr-login`),
as every login in the product is. The chips carry no handle at all — a pull request can have
several reviewers, and the row is about the pull request's state.

### Primitives, tokens and accessibility

| element                     | primitive / class                                               | token                                                                   |
| --------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| review chip, counting       | `Pill` `tone="mint"` · `.ghr-chip`                              | the mint tint's fill with `--el-text-strong`, as every counting pill    |
| review chip, does not count | `Pill` `tone="neutral"` · `.ghr-stale`                          | `--el-text-secondary` — **AA on all four surfaces in both themes**      |
| review chip, changes        | `Pill` `tone="peach"` · `.ghr-chip`                             | the peach tint, the same one _Not merged yet_ uses                      |
| the GitHub mark             | `#i-github`                                                     | `currentColor`, inheriting the chip's or the band's ink                 |
| the reviewer's handle       | `.ghr-login` — record band and room cell ONLY, never a row chip | `--font-mono`, 11px                                                     |
| _Not a Motir member_        | `.ghr-sub`                                                      | `--el-text-secondary`, indented under the line it qualifies             |
| the room's person cell      | `.ghr-room-person`                                              | `--el-text-secondary`, `text-xs`, truncates at 144px                    |
| the settled To-approve row  | `.ghr-ta-settled`                                               | `opacity: 0.7` — the shipped decided-row treatment, not a colour change |

**No `--el-text-muted` and no `--el-text-faint` carries text on this sheet**, in either layer: every
secondary string is `--el-text-secondary`, which is 6.18–6.80:1 on the page, `--el-surface`,
`--el-surface-soft` and `--el-muted` in both themes. **No `--el-danger-text`** — nothing here sits on
a danger fill. A stale review is **neutral rather than rose**, which is a meaning decision before it
is a colour one: rose would say something went wrong, and nothing did.

### GIVES / TAKES

| key        | GIVES / TAKES                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOTIR-5599 | **GIVES** every panel, the chip, the record band's two line forms, the room cell and the settled row — it builds them, in `en` and `zh`. **TAKES** that the chip **replaces** the row's CI pill rather than joining it; that the chip names **neither the host nor a reviewer**; and that _Not a Motir member_ is a line, never a dimmed name. It takes NOTHING about narrow width — the row already wraps (12n / MOTIR-5351) and the chip inherits it                                                                                         |
| MOTIR-5602 | **TAKES** that the read carries, per member, the **latest countable review's STATE** and **whether it stands at the current head** — and nothing about a person. ⚠️ AMENDED 2026-09-17: it previously also took the reviewer's login and member name. The row no longer names a reviewer, so a per-row reviewer identity is both unrendered and the WRONG SHAPE — it is one field where a pull request may have several reviewers. It must still mark a review that does NOT count, so G2 can be drawn at all rather than rendering as nothing |
| MOTIR-5590 | **GIVES** decisions 1–6 and 10, cited per panel. **TAKES** nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| MOTIR-5608 | **TAKES** that the merge runs **after the decision commits**, so G4 is the state a reader lands on — a panel showing an approved card with un-attempted merges would contradict it                                                                                                                                                                                                                                                                                                                                                             |
| MOTIR-5601 | **GIVES** G1 → G4 → G6 as the acceptance video's script. **TAKES** nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| MOTIR-5609 | **GIVES** the one-gate model every panel assumes. **TAKES** nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## 24 · A person WRITES and EDITS How to test — the Add and Edit doors, the form, and _Written by {person}_ (MOTIR-5452, 2026-09-17)

**AMENDS § 20** — Panels **12a** (the part with a record), **12i** (record missing) and **12m** (a
child's pointer) — for ONE change: the How-to-test part gains WRITE doors, so a person holding
`work_item:edit` can **add** a record where there is none and **edit** the current one.

**Asset:** `design/github/github--how-to-test-form.mock.html`, a delta mock beside
`github.mock.html`. It holds only the panels that change; `github.mock.html` is a record of what
shipped and is not edited.

> **⚠️ Panels 13a–13h, and § 24 — not the 12p–12w and § 21 MOTIR-5452 reserved.** The card was
> authored 2026-09-14, when both ranges were free. § 20's verbs delta (MOTIR-5480) took 12p–12w on
> 2026-09-15 and §§ 21–23 landed on 2026-09-16/17. § 21 and § 22 now cite `12p`, `12s`, `12t`, `12u`
> and `12v` BY NUMBER, so reusing the range would silently re-point those citations at a different
> drawing. 13a–13h is the next free contiguous block. The panels, their order and their contents are
> the card's, unchanged; only the labels moved. Recorded on the card.

### The rule it draws — PARITY

`docs/decisions/approval-gates.md` § 9's **2026-09-17 amendment**, point 2: _"a person may add
everything an agent may add … Anything a person cannot set that an agent can is a defect against this
point."_ So this is **not a lighter, human-flavoured field**. Every control on the sheet exists
because one `publish` input needs a door, and the parity table below maps them one to one. There is
one record, one writer (`testInstructionsService.publish`) and two author kinds.

Point 3 is the other half: **suggested, never forced.** The form opens filled in from what Motir
already knows, and every value stays editable.

### Access path

Item page (`/items/{key}`) → the **Development** card → the **How to test** part. Both doors live
inside that part:

- **Add how to test** — under the missing callout (13a), when the item is a RUN TARGET with no
  current record.
- **Edit** — in the part's head, opposite the author line (13a), when a record exists.

The card head keeps **+ Link pull request** and gains nothing: the two are different objects, and the
head belongs to the pull requests.

### The panels, and the card that builds each

| panel   | what it depicts                                                                                  | built by   |
| ------- | ------------------------------------------------------------------------------------------------ | ---------- |
| **13a** | the doors — **Add** under the owed-by callout, **Add** with no run to name, **Edit** in the head | MOTIR-5455 |
| **13b** | the form filled in, desktop and dark — **body · preview path · Save / Cancel**, and nothing else | MOTIR-5455 |
| **13d** | dirty · saving · every refusal `publish` can return, each beside its field                       | MOTIR-5455 |
| **13e** | no linked pull request — legal and NOT an error; no repository section, body only                | MOTIR-5455 |
| **13f** | after save — _Written by {person}_, and _Earlier versions_ holding both kinds                    | MOTIR-5455 |
| **13g** | ~400px — the form, and the saved state                                                           | MOTIR-5455 |
| **13h** | no door — a viewer without `work_item:edit`, a child of a container run, the approval port       | MOTIR-5455 |

### The PARITY table — one row per `publish` input

Read this as the checklist point 2 asks for: a `publish` input with no control is the defect.

| `publish` input     | the control that sets it                                                                                                                                                              | where it is suggested from               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `bodyMd`            | the **Body** field — the shipped `MarkdownEditor` at `size="full"`, including a code block's **language** field                                                                       | the current record on Edit; empty on Add |
| `previewPath`       | the **Preview path** input, optional, hint _a path such as /items/ACME-7_                                                                                                             | the current record on Edit; empty on Add |
| `repos[].repo`      | **no control — and none is owed.** Motir derives it from the linked pull requests, which the Development rows directly above the part already show. `+ Link pull request` is the door | derived; never typed                     |
| `repos[].commitSha` | **no control — and none is owed.** The bound pull request's live head (`liveHeadSha`). A person would have to go and look up a SHA Motir already holds                                | derived; never typed                     |

`attributeToRunningDispatch` has no control, deliberately: it is how the SERVICE distinguishes the
two author kinds, and a person's save leaves it false. It is not a field a person sets.

### The code block's LANGUAGE is the parity row that needed a component change

The rendered block prints each fence's language above the code (§ 20, _The content is RICH TEXT_).
The shipped editor's **Code block** button calls `toggleCodeBlock()` and sets none, and no control
shows or changes one — so without this, a person's rich text would be strictly poorer than an
agent's, which point 2 forbids. **13b** draws the field on a focused code block: a small monospace
input in the block's own bar, showing the current language, typed or cleared. **MOTIR-5458 owns how
it behaves** (the input rule, serialisation, the load → edit → save round trip); this section owns
only where it sits and what it looks like.

### Decisions

| #   | decision                                                                                                   | why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Add sits under the missing callout, not in the card head**                                               | the head is the pull requests' (`+ Link pull request`); the callout is where a reader learns the record is missing, so it is where the remedy belongs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2   | **The missing callout STAYS when the door is shown**                                                       | a person writing one by hand does not make the run's omission untrue, and the _owed by_ line is the only record of which run skipped it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3   | **Edit sits in the part head, opposite the author line**                                                   | that line is already about what the record IS rather than what it says; the verb belongs beside it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 4   | **A person may edit a RUN's record**                                                                       | the amendment's own reason: _"a wrong agent record can only be fixed by starting another run"_. The run's text is not destroyed — the save makes a new version and this one becomes history                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 5   | **Refusals are `publish`'s own strings, inline beside their field**                                        | one service refuses both authors, so a second human-facing phrasing would be a second contract to keep in step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 6   | **A refusal keeps the draft**                                                                              | the body is the expensive part of the input; clearing it to report a bad commit is the worst possible trade                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 7   | **An unknown commit is empty and required, with the reason in the row**                                    | the head is only known once a check reports one; inventing a value for a field `publish` validates would be worse than asking, and without the reason it reads as a bug                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 8   | **No linked pull request is a legal starting state, and the form opens with no repository section at all** | **Motir does not decide how a team works** (Yue, 2026-09-17): _"a human developing team may not have the regulation to link the PR in the work item — they can manage the PR in github and manage the task in motir and add how to test in motir."_ Requiring a link before the door opens would make Motir's own convention a precondition for describing your work. **⚠️ Build dependency: `publish` must accept ZERO sections**, which it does not today — it refuses with _"give one entry per repository the run pushed to — at least one."_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 8b  | **THERE IS NO REPOSITORY SECTION IN THE FORM AT ALL — no picker, no commit field, not even read-only**     | The question this panel set kept inviting — _why offer_ + Add repository _when the pull request is linked and names its own repository?_ — has a one-line answer (Yue, 2026-09-17): **_"the team can still add repo/PR, they can just use the link PR feature, which is there in the card already."_** `+ Link pull request` sits in the same Development block, and a picker inside the form is a SECOND DOOR onto the same fact. **The same argument retires the COMMIT field, and then the read-only row too** (Yue, 2026-09-17: _"why read-only? they are simply not needed, link a PR shows the PR in the development panel"_) — the commit is the bound pull request's `liveHeadSha`, so a person would be typing a value Motir holds, and the rows directly above the part already display both facts. Drawing them inside the form is the same fact a third time. The linked door is also the better one: it yields a section with a `git fetch`, a preview and CI checks, where a hand-named repository renders `fetchCommand: null`, `no_deployment_reported` and `no_checks_reported` — a name and a commit with all three derived facts empty. **Removing the control removes its failure modes too**: the _repository not in the project_ and _same repository twice_ refusals are unreachable, and with decision 8's dependency the _at least one section_ refusal goes as well — three of the six this panel set used to draw |

| 9 | **The shipped _Earlier runs (n)_ string is REPLACED by _Earlier versions (n)_, not paralleled** | once a person can write one, _runs_ is the wrong noun for the list; two strings for one disclosure is how two author kinds start to look like two features |
| 10 | **No door in the approval port or the quick-view peek** | the port is where a person is asked to DECIDE on this evidence; a control to change the evidence inside the question stops it being a gate. The item page is one click away |
| 11 | **No door on a child of a container run** | the record belongs to the run target and a child is not one; two places to write one record is the second write path point 1 forbids |

### Fields read

Additions to § 20's Fields-read table — everything else it lists is unchanged.

| field                                | from                        | drawn in                                                                           |
| ------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------- |
| `record.author` / `history[].author` | `HowToTestDto` (MOTIR-5454) | 13f                                                                                |
| ~~`sections[]`~~                     | ~~`HowToTestDraftDTO`~~     | **RETIRED with the repository section** — the form consumes no section data at all |
| ~~`projectRepos[]`~~                 | ~~`HowToTestDraftDTO`~~     | **RETIRED** — decision 8b; it existed only to populate the picker                  |

`author.kind` is what the line reads from: `run` renders the run's label as § 20 already draws it,
`person` renders the display name. A deleted publisher reads **Former member** — the product's
standing string for an attribution whose referent is gone, and the same literal an erased profile
carries — never a blank.

### Primitives, tokens and accessibility

**Composed, not drawn:** `PullRequestRow` and the caption (§ 19); the part grammar (`Part` /
`PartHead`); the rendered body and `CopyableCodeBlock` (Panels 12a / 12d); the missing callout
(12i); the child pointer (12m); `Button` in its primary / secondary / ghost variants at `sm`;
the text input; `MarkdownEditor` at `size="full"`, whose toolbar
set and order are the component's own.

**Added by this sheet** — the `htf-` block: the form shell, the field / label / hint rhythm, the
code block's language field, the repository rows, the inline refusal, the saving state, and the
~400px stacking.

**Ink.** Every hint, provenance line and caption on a tinted or soft surface is
`--el-text-secondary`, never `--el-text-muted` (4.12–4.34:1 on `--el-surface` / `--el-surface-soft`
/ `--el-muted`) and never `--el-text-faint` (AA on nothing). A refusal is
**`--el-danger-on-surface`**, never `--el-danger-text` — that token is the ink FOR a danger fill and
renders white on a page in every light palette.

**Shape.** `--radius-card` for the form and the rows, `--radius-input` for the editor and inputs,
`--radius-control` for the toolbar and icon buttons; `--spacing-card-padding`, `--spacing-input-x`,
`--height-input`, `--height-btn-sm`. No raw radius, padding or height anywhere in the additions.

**Accessibility.** The form is a `role="group"` labelled _How to test_; the editor keeps the
component's `role="toolbar"` / `aria-label="Formatting"` and its per-button `aria-label`; every
commit input is labelled by its repository; each refusal sits next to the control it is about; the
The saving state disables every control including Cancel. There is no repository picker (decision 8b).

### Copy — `en` + `zh`

| key                                | en                                                                                 | zh                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `howToTest.add`                    | Add how to test                                                                    | 添加测试方法                                         |
| `howToTest.edit`                   | Edit                                                                               | 编辑                                                 |
| `howToTest.form.label`             | How to test                                                                        | 测试方法                                             |
| `howToTest.form.body`              | Body                                                                               | 正文                                                 |
| `howToTest.form.previewPath`       | Preview path                                                                       | 预览路径                                             |
| `howToTest.form.optional`          | optional                                                                           | 可选                                                 |
| `howToTest.form.previewPathHint`   | a path such as /items/ACME-7                                                       | 形如 /items/ACME-7 的路径                            |
| `howToTest.form.repos`             | Repositories                                                                       | 代码库                                               |
| `howToTest.form.removeRepo`        | Remove {repo}                                                                      | 移除 {repo}                                          |
| `howToTest.form.commitLabel`       | Commit for {repo}                                                                  | {repo} 的提交                                        |
| `howToTest.form.commitPlaceholder` | paste the commit                                                                   | 粘贴提交号                                           |
| `howToTest.form.fromPr`            | from pull request #{number}                                                        | 来自拉取请求 #{number}                               |
| `howToTest.form.fromRecord`        | from the current version                                                           | 来自当前版本                                         |
| `howToTest.form.fromYou`           | added by you                                                                       | 由你添加                                             |
| `howToTest.form.noHeadYet`         | CI has not reported a head for this pull request yet — paste the commit you tested | CI 尚未报告此拉取请求的头部提交 — 请粘贴你测试的提交 |
| `howToTest.form.dirty`             | Unsaved changes                                                                    | 有未保存的更改                                       |
| `howToTest.form.saving`            | Saving…                                                                            | 保存中…                                              |
| `howToTest.form.save`              | Save                                                                               | 保存                                                 |
| `howToTest.form.cancel`            | Cancel                                                                             | 取消                                                 |
| `howToTest.form.codeLanguage`      | Language                                                                           | 语言                                                 |
| `howToTest.writtenByPerson`        | Written by {name}                                                                  | 由 {name} 编写                                       |
| `howToTest.earlierVersions`        | Earlier versions ({count})                                                         | 早前版本（{count}）                                  |

**The product's own nouns**: _work item_, _pull request_, _repository_. No _card_ and no _issue_ as
product copy anywhere on the sheet. `howToTest.earlierVersions` **replaces** the shipped
`howToTest.earlierRuns` (decision 9); the refusal strings are `publish`'s and are not re-keyed.

### Scope

**Drawn:** the two doors, the form in every state parity requires, the refusals, the saved record
with its author, history of both kinds, ~400px, and the three places that get NO door. **Not drawn,
and whose it is:** the Server Actions, the form component and the catalog entries — MOTIR-5455; the
editor's language behaviour — MOTIR-5458; the draft read — MOTIR-5453; the author on the read —
MOTIR-5454; the parity vitest — MOTIR-5456; the E2E and its acceptance video — MOTIR-5457. Panels
12a / 12i / 12m are unchanged and composed or abbreviated on the sheet; the approval port
(MOTIR-5438) is shown only to draw its absence of a door.

### GIVES / TAKES

Scope: `grep -o 'MOTIR-[0-9]*' design/github/github--how-to-test-form.mock.html | sort -u`. The keys
the sheet carries beyond this section's are `github--fix-callout.mock.html`'s stylesheet and sprite
provenance, carried verbatim, and GIVE or TAKE nothing here.

| key        | GIVES / TAKES                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOTIR-5455 | **GIVES** every panel, the copy table, the decisions and the tokens above — it builds the doors and the form. **TAKES** decision 9: it RETIRES the shipped `howToTest.earlierRuns` string rather than adding a second one, in both catalogs                                                                                                           |
| MOTIR-5458 | **GIVES** the language field its place and its look (13b, 13g). **TAKES** that the field must be reachable **on a focused code block** and must round-trip an unknown language — the drawing assumes both                                                                                                                                             |
| MOTIR-5453 | **TAKES a SHRINK, and it is most of that card.** The form reads only `bodyMd` and `previewPath`, so the draft read sheds `sections[]` (with `source` and the nullable `commitSha`) AND `projectRepos[]` — both existed to feed controls this form no longer has. What survives is the current record's body and preview path. **GIVES** nothing drawn |
| MOTIR-5454 | **GIVES** `author` the line it renders in (13f). **TAKES** that a deleted publisher's label is non-blank, which is what lets the line be drawn without an empty-author state                                                                                                                                                                          |
| MOTIR-5456 | **GIVES** the refusal set (13d) as its assertion list. **TAKES** nothing                                                                                                                                                                                                                                                                              |
| MOTIR-5457 | **GIVES** 13a → 13b → 13f → 13d → 13h as its script. **TAKES** nothing                                                                                                                                                                                                                                                                                |
| MOTIR-5438 | **nothing either way** — the port is not redrawn; decision 10 only records that it draws no door                                                                                                                                                                                                                                                      |
| MOTIR-5452 | this card                                                                                                                                                                                                                                                                                                                                             |

Fixture items use `ACME-n` keys, as the rest of this area does, so they link to nothing.

## 25 · How to test is the INSTRUCTIONS — the repository sub-block is RETIRED, and _stale_ is one line in the part (MOTIR-5694, 2026-09-18)

Task [MOTIR-5694](motir:cmu71l7k0009chvoik3uv99dz) · built by
[MOTIR-5691](motir:cmu6xvom400p3hvoi9vu64qis).

**AMENDS § 20** — Panels **12a** (a run's record), **12g** (stale) and **12k** (a repository with no
section) — and **§ 24** — Panels **13e** (its caption), **13f** and **13g** (a person's saved
record, desktop and ~400px). ONE change: the bordered per-repository sub-block that § 20 drew under
the body — **In the preview · Locally · What CI proved** — comes out of How to test.

**Asset:** `design/github/github--how-to-test-no-repo-blocks.mock.html` (+ its `.png`), a delta
mock beside the two bases, holding only the panels that change, each light and dark.
`github.mock.html` and `github--how-to-test-form.mock.html` are records of what was decided and are
not edited.

### The decision, and the requester's reasoning

> **Yue, 2026-09-18:** _"why do we need the block? for a technical user who wants to pull the code
> locally knows well how to pull the code. the PR is linked. for a non-technical user that
> information is useless anyway. and how to test steps should be the same doesn't matter it's local
> or online in the preview."_

| the sub-block drew                                         | whose fact                    | already reachable                                                                                                                  |
| ---------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| _Locally_ — `git fetch origin <ref> && git checkout <ref>` | the pull request              | the row one line above links out to the host, which shows the branch and its own checkout instructions                             |
| _In the preview_                                           | the deployment at that head   | a preview is **per system** — one configured environment for every work item — not a per-head derivation. Motir reports none today |
| _What CI proved_                                           | the pull request's check runs | the row already carries a CI pill, and the host has the full list a click away                                                     |

The third sentence of the quote is the one that decides it: **the steps read the same locally or on
a deployed environment, so they never branch on environment — and the environment therefore does
not belong inside the instructions.** The first two dispose of the only readers the block had: one
who needs no help checking out a branch, and one who cannot use the command at all.

### The rule, going forward

**How to test is the INSTRUCTIONS; a pull request's facts belong to the pull request.** The part is
the `h4`, the author line, the body (with its copyable code blocks) and _Earlier versions (n)_ —
free text that a run or a person writes, owned by whoever wrote it. Anything that is true of a pull
request (its branch, its head, its deployment, its checks) is drawn on or behind that pull request's
row, never repeated inside the instructions. A later card that wants one of those facts on the
page asks for it **on the row**, as its own § 20 pass with its own argument — which is a different
proposition from this one, and not something this section proposes.

### What this RETIRES — so a later reader finds a decision, not an unexplained absence

The per-repository facts look useful, were designed carefully, and nothing in the code will say why
they went. So, explicitly:

- **§ 20 Panels 12a–12h** — the sub-block they all carry (12a's single-repository box, 12b's headed
  boxes, 12e's preview states, 12g's stale pill on the box, 12h's check list), and **12k** in full.
  12l's awaiting-row box goes with them. **Still standing from § 20:** the placement inside the
  Development card, the rich-text body and its copy control (12d, 12f), the record-missing callout
  (12i), _Earlier versions_ (12j), the child pointer (12m), the narrow row (12n) and the frame
  (12c, 12o).
- **§ 20's _Decisions_ rows** _what Motir derives vs what the agent writes_, _order of the derived
  facts_ and _a repository with a PR but no section_; its **Fields-read** rows for the preview URL,
  the repository sub-heading, _In the preview_, _Locally_, _What CI proved_ and the no-section
  derivation; and its **tone table** rows for preview, check and no-section values.
- **§ 24, decision 8b's closing argument** — that a linked pull request is the better door because
  _"it yields a section with a `git fetch`, a preview and CI checks"_. The conclusion stands (the
  form has no repository control); that reason for it no longer exists, and the one that remains is
  the first: `+ Link pull request` is the door for a pull request, and one door is enough.
- **Shipped work:** [MOTIR-5333](motir:cmtzoqr5000cghvtxnaytfoe0) (the read's per-repository half —
  fetch line, preview, checks) and [MOTIR-5336](motir:cmtzoqrc900cmhvtxgr8ueqjw) (the block's
  sub-blocks). Both were right for the premise they were built on; the premise is what changed.
- **Narrows** [MOTIR-4906](motir:cmtt4ogi0000dhutx1ekfm43s): How to test is still the run's
  deliverable, written onto the run target and rendered where the decision is made — it is simply
  the instructions and no longer the instructions plus a derived delivery report.

### _Stale_ — where it lives, and what it costs

_"Written for `a1b2c3d` — `moooon/motir-core` is now at `e4f5a6b`"_ is the one signal the box
carried that exists **nowhere else**: it is a relation between the RECORD and the pull request, not
a fact of either alone. The three candidate homes:

| home                                                   | verdict                | why                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **in the part, as ONE line**                           | **CHOSEN** (Panel 12g) | it qualifies the RECORD — _these steps were written against an earlier push_ — so it belongs with the record, and it costs one line. Placed directly under _Written by_ rather than after the body, so it is read **before** the steps it qualifies; it is the author line's second half, not a footnote                                                                                                                        |
| on the pull-request row, beside the state and CI pills | rejected               | the row is `PullRequestRow`, **derived and unchanged** (§ 19) and shared with every surface that lists pull requests; a pill reading _Stale_ there says the PULL REQUEST is stale, which is false — the pull request is current, the instructions are not. It would also make a row depend on the How-to-test record, the coupling this section retires                                                                         |
| dropped with the rest                                  | rejected               | defensible only if every body were prose about a feature. Agent bodies routinely name a migration, a seed or a flag from the head they were written at, and a moved head is the one case where the reader is owed a warning nothing else on the page gives. The approval gate is withdrawn by a push and raised again on green (§ 20, 12v), so the re-raised gate would otherwise show one-push-old evidence with no sign of it |

**The line.** A peach _Stale_ `Pill` (severity warning, `history`) and the shipped `stale.title`
sentence, in `--el-text-secondary`, one line per repository whose head moved. It **replaces** the
peach callout and the sub-block's pill. `stale.body` — _"… The preview and CI follow the new head."_
— names two of the retired facts and **is retired with them**; `stale.title` and `stale.pill` are
kept, in both catalogs.

**What it costs — said plainly.**

- **It is an AGENT-record concept only.** A person's save names no repository and no commit
  (`approval-gates.md` § 9, 2026-09-17 amendment, points 2–3; § 24 decision 8b), so there is nothing
  for a head to have moved past. **A person's record can never be stale**, and 13f draws no line. A
  home that implied otherwise — a slot or an empty state on every record — would draw a state that
  cannot occur; the line therefore renders only when the read says so, and has no empty state.
- **The read keeps a sliver of what [MOTIR-5691](motir:cmu6xvom400p3hvoi9vu64qis) deletes.** The
  stored sections (`test_instructions_repo` — repository + `commitSha`) and each bound pull
  request's live head are still needed to compute it. What the block needs from the DTO shrinks from
  `repos[]` (with preview, fetch line and checks) to **one list of stale pairs** — repository name,
  the record's commit, the head it moved to — derived by the rule `assemble.ts` already uses (an
  abbreviated sha of the head is not stale). The deployment reads, the fetch composition and the
  check listing go entirely.

### The caption correction — Panel 13e

13e's caption read _"legal, and the picker is where focus lands"_ — naming a control § 24's
decision 8b removed, so the caption described a form the product does not have. It now reads **"no
linked pull request — legal, and focus lands in the Body"**, the first control of the form as it
actually is. Nothing else on the panel changed.

### Panels, and the card that builds each

| panel   | depicts                                                                                                     | built by                  |
| ------- | ----------------------------------------------------------------------------------------------------------- | ------------------------- |
| **12a** | a run's record — the head, the author line, the rendered body, _Earlier versions_ (collapsed). Nothing else | MOTIR-5691                |
| **12g** | stale — ONE line under the author line                                                                      | MOTIR-5691                |
| **12k** | RETIRED — two pull requests, a record that covers one: **nothing is added**; the rows speak for themselves  | MOTIR-5691                |
| **13e** | the form with no linked pull request — caption corrected, form unchanged                                    | — (shipped by MOTIR-5455) |
| **13f** | a person's saved record — no box, no stale line                                                             | MOTIR-5691                |
| **13g** | ~400px — the form, and the saved record                                                                     | MOTIR-5691                |

### Fields read — after this section

| rendered element               | field(s) read                                                           | panel    |
| ------------------------------ | ----------------------------------------------------------------------- | -------- |
| which part renders             | `state` — unchanged                                                     | all      |
| _Written by {run \| person}_   | `record.author` / `record.run`, `record.createdAt` — unchanged          | 12a, 13f |
| the body                       | `record.bodyMd` — unchanged                                             | 12a, 13f |
| the stale line                 | the stale pairs: `{ repoName, recordSha, headSha }[]` — empty ⇒ no line | 12g      |
| _Earlier versions (n)_         | `history[]` — unchanged                                                 | 12a, 13f |
| ~~everything under `repos[]`~~ | **RETIRED** — preview, fetch line, checks, sub-heading, no-section      | —        |

### Copy — `en` + `zh`

**Kept:** `github.development.howToTest.stale.title` and `stale.pill`, and every key the part head,
body, callout, disclosure and child pointer already use. **Retired, in both catalogs:** `stale.body`,
and the `preview.*`, `local.*`, `ci.*` and `noSection.*` namespaces. No key is added.

### Primitives, tokens and accessibility

Composed, not drawn: `PullRequestRow` and its caption (§ 19), the part grammar, `MarkdownView` with
`CopyableCodeBlock`, the disclosure, the § 24 form and editor, and the shipped peach `Pill`. The one
addition is the stale line's `.nrb-stale` rule, whose class string is quoted above it in the mock:
`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-(--el-text-secondary)`. It is a
`role="status"` line, so a screen reader hears it once with the part. `--el-text-secondary` holds AA
on the card's `--el-card` and on the approval port's `--el-surface`; `--el-text-muted` would not on
the second (§ 20, _Tokens_).

**Drawn against shipped reality.** Before a panel was drawn, `components/howToTest/HowToTestBlock.tsx`
at `origin/main` `c6ba2709d` was bundled and rendered headless with a fresh and a stale run record:
the part's head, body, copy control and disclosure on this sheet are that render's structure, and
the stale callout and sub-block pill it showed are what 12g replaces.

### GIVES / TAKES

Scope: `grep -o 'MOTIR-[0-9]*' design/github/github--how-to-test-no-repo-blocks.mock.html | sort -u`.
The keys beyond this section's are the form mock's stylesheet and sprite provenance, carried
verbatim, and GIVE or TAKE nothing here.

| key                                                                                           | GIVES / TAKES                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [MOTIR-5691](motir:cmu6xvom400p3hvoi9vu64qis)                                                 | **GIVES** every panel above and the Fields-read / Copy tables. **TAKES** a narrower deletion than its _What to delete_ reads on one point: **_stale_ HAS a home**, so the read keeps the stale pairs (stored sections + each bound pull request's live head) and the block keeps `stale.title` / `stale.pill`; the stale callout and `stale.body` go. Its AC 5 already defers to this section |
| [MOTIR-5450](motir:cmu19273o0002i0txwqqo9t2a)                                                 | § 24's 13f / 13g drew the box on a person's record; **superseded here**. Nothing it builds changes — the form never had the box                                                                                                                                                                                                                                                               |
| [MOTIR-5333](motir:cmtzoqr5000cghvtxnaytfoe0) / [MOTIR-5336](motir:cmtzoqrc900cmhvtxgr8ueqjw) | done; their per-repository half is **retired** (above). No criterion of theirs is reopened                                                                                                                                                                                                                                                                                                    |
| [MOTIR-4906](motir:cmtt4ogi0000dhutx1ekfm43s)                                                 | **narrowed** — How to test is the instructions                                                                                                                                                                                                                                                                                                                                                |
| [MOTIR-5690](motir:cmu6v9h2l00g0hvtxyly7d5v2)                                                 | nothing either way — the planning record of how the box outlived its premise                                                                                                                                                                                                                                                                                                                  |

Fixture items use `ACME-n` keys, as the rest of this area does, so they link to nothing.

## 26 · `motir fix` BESIDE _Queue again_ on an ejected card — which one to use (MOTIR-5718, 2026-09-18)

**AMENDS § 21** (the fix part, Panels F1–F4 in `github--fix-callout.mock.html`) **and § 22** (the
ejected frame, Panels E1–E7 in `approve-and-merge--ejected.mock.html`), in the delta
**[`github--fix-callout--ejected.mock.html`](./github--fix-callout--ejected.mock.html)**, Panels
**X1–X5**, each at desktop, dark and ~400px. Card MOTIR-5718, Story MOTIR-5628. **Neither base mock is
edited**, and no image export ships (`docs/decisions/design-result.md` AMENDMENT 4). The component
change is **MOTIR-5721**'s; the claim that admits the card is **MOTIR-5719**'s.

**Why it is owed.** Once the repair claim admits an ejected card (MOTIR-5719), the Development block
offers two controls that were never drawn together: § 22's **Queue again** on the row, which retries
the same commits, and § 21's **`motir fix`**, which sends an agent to change them. They answer
different situations — a flaky or timed-out check needs a retry; a real failure or a conflict needs new
commits, and a retry fails the same way — and nothing on the page said which is which.

### Access path

None is new. The item page → the **Development block** (§ 20, Panels 12a / 12c), reached from any
board card, list row or Workbench row that opens the card — now also through the _Checks: Failing_
filter and the red badge, which find an ejected card (§ _The badge_ below) — and the same frame inside
the **full-screen approval overlay**, which renders the Development block as its port (§ 22's access
path).

### Rendered against shipped reality, not redrawn

Both bases carry ONE stylesheet and ONE sprite sheet byte for byte and each adds its own block (`ej-`,
then `fx-`); the delta carries both blocks unchanged at `origin/main` `bbbe8d9b0`, and adds no rule
that product UI draws. Two placements come from the shipped body rather than from either sheet:

- **The fix part sits INSIDE the rows part.** `DevelopmentSectionBody` renders rows → caption →
  `RepairFixPart` as one unit (`rowsPart`), so under a gate it is in **band 2, the port**, with the
  caption — which § 22's sheet abbreviated away and every X panel draws.
- **In `auto` the fix part comes BEFORE the Merge queue part.** `QueueExitAutoPart` renders
  `{rows}` (that same `rowsPart`) and then its own part. X3 draws that order. The card's brief said
  _E5's part, then F1_; the shipped order is kept because the fix part acts on the rows directly above
  it and the which-to-use sentence carries its own reason, so the order needs no component change.

### The panels, and the card that builds each

| panel | state                                                                                                                                                                                                                                                      | composes | built by               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------- |
| X1    | **Ejected for failed checks, `manual`, heads unchanged** — the row's _Left the queue_ + **Queue again**; in the port, the fix part with the left-the-queue line, the command and the **which-to-use** sentence; the record band's reason and failing check | E1 + F1  | MOTIR-5721             |
| X2    | **Ejected for a merge conflict** — E6's lone reason, no check; the sentence recommends `motir fix` and says Queue again will fail the same way. Queue again stays offered (the server does not refuse it)                                                  | E6 + F1  | MOTIR-5721             |
| X3    | **`auto` mode** — no frame: rows, caption, the fix part, then E5's _Merge queue_ part, then How to test                                                                                                                                                    | E5 + F1  | MOTIR-5721             |
| X4    | **A repair in progress on an ejected card** — F2's _Fixing_ pill and holder, no command and **no which-to-use sentence**; **Queue again** still on the row                                                                                                 | E1 + F2  | MOTIR-5721             |
| X5    | **Ejected, then the head moved** — E3's _New commits since approval_, the new head's own _Checks running_, and **no fix part**: the exit no longer holds at the head                                                                                       | E3       | MOTIR-5717, MOTIR-5721 |

### The show-when rule, and the field it reads

The fix part's own rule is unchanged (§ 21: shown when the repair claim would answer `claimed`,
`taken` / `mine`, or the pointer). What this section adds is **per failing member**, read off the page's
repair view (`WorkItemRepairViewDto.failing[]`, `getRepairView`):

- **A member whose own `ci` is NOT `failing` and which carries a standing `queueExit`** is failing
  BECAUSE of its exit. It is named on the **left-the-queue line** (`fix.leftQueueOn`) instead of in
  _Checks are failing on …_ — its own checks are green, so that sentence would be false. A member whose
  own checks fail stays on § 21's line; a set holding both draws both lines, own-failing first.
- **The which-to-use sentence** renders under the command's `how` line, in the **`offer` state only**,
  when at least one member is failing because of its exit. It switches on that exit's `rawReason`:
  `MERGE_CONFLICT` → `which.conflict`; `CI_FAILURE` / `CI_TIMEOUT` → `which.checks`; any other failure
  reason → `which.other`. With several ejected members, a conflict wins — Queue again cannot land that
  member, whatever the others need.
- **Not in `in_progress`** (X4): nothing is to be chosen while an agent holds the repair. **Not in the
  pointer state**: the child names no command.
- **A standing exit** is exactly the fold's rule (MOTIR-5717's shared predicate): latest exit
  `disposition = 'failure'`, `requeuedAt = null`, `headSha` = the member's current head. X5 is its
  negative.

### Decisions

| decision                         | chosen                                                                   | why                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| where the sentence sits          | under the command, after `how`                                           | it compares the command just offered with the row's button; placed above the command it would ask a question before either control is on screen                                                 |
| a new container or pill          | **none** — `.fx-line` and `.fx-note`, the part's own two line treatments | § 21's _No card inside a card_; the part already owns this grammar                                                                                                                              |
| the ejected member's line        | **_{pr} left the merge queue._**, `circle-x` in `--el-danger-on-surface` | _Checks are failing_ is false for a member whose own checks are green; the reason in full is already in the record band (manual) or the Merge queue part (auto), so the line does not repeat it |
| Queue again during a repair (X4) | **still offered**                                                        | the server does not refuse it, and a person who knows nothing changed may still retry; hiding it would invent a rule the server does not have                                                   |
| Queue again on a conflict (X2)   | **still offered**, and the sentence says it will fail                    | the conflict ahead may have been reverted; the sentence informs, it does not decide                                                                                                             |

### Copy — `en` + `zh`

Under **`github.development.fix`**, beside § 21's keys. `<prs></prs>` is the list-formatted set, as in
`failingOn`; `<b>` and `<code>` are rich-text tags (`<code>` is the shipped inline-code treatment,
`.dvb-mono`). **Queue again** is the shipped `approvalGate.pullRequestApproval.outcome.queueAgain`
string, repeated in words, not re-keyed. Final wording, drafted on the sheet:

| key              | en                                                                                                                                                          | zh                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `leftQueueOn`    | `<prs></prs>` left the merge queue.                                                                                                                         | `<prs></prs>` 已离开合并队列。                                                                                       |
| `which.checks`   | Nothing changed on your side? **Queue again** tries the same commits once more. If the failing check points at real code, `motir fix` hands it to an agent. | 你这边没有改动？**重新排队**会再试一次相同的提交。如果未通过的检查指向真实的代码问题，`motir fix` 会把它交给智能体。 |
| `which.conflict` | A conflict needs new commits. `motir fix` hands it to an agent; **Queue again** will fail the same way until it is resolved.                                | 冲突需要新的提交。`motir fix` 会把它交给智能体；在冲突解决之前，**重新排队**会以同样的方式失败。                     |
| `which.other`    | **Queue again** tries the same commits once more. If it leaves the queue the same way, `motir fix` hands it to an agent.                                    | **重新排队**会再试一次相同的提交。如果它以同样的方式离开队列，`motir fix` 会把它交给智能体。                         |

### Tone and tokens

Nothing new: the left-the-queue line is § 21's failing line (`--el-text`, glyph
`--el-danger-on-surface`); the sentence is § 21's `fx-note` (`text-xs`, `--el-text-secondary`), its
bold in `--el-text`, its `motir fix` in the shipped inline-code treatment. `audit-mock-sprites --strict`
on the delta — 44 symbols, 0 drifted, 0 undeclared.

### The badge — recorded in `design/boards/design-notes.md`, not drawn

An ejected card shows the shipped **_Checks failing_** badge; no new value, no new pixels. The amendment,
with GitHub's own marking checked first, is in `design/boards/design-notes.md` § _The CI badge
(MOTIR-5471)_.

### Scope

**Drawn:** the two controls together in five states, each at desktop, dark and ~400px; the
left-the-queue line; the which-to-use sentence in its three variants (two drawn). **Not drawn, and whose
it is:** the fold that makes the badge red — MOTIR-5717; the claim and the repair view's `queueExit` —
MOTIR-5719; `motir fix`'s prompt and watch — MOTIR-5720; the component change — MOTIR-5721; the
acceptance video — MOTIR-5723. How to test is unchanged and abbreviated on the sheet.

### GIVES / TAKES

Scope: `grep -o 'MOTIR-[0-9]*' github--fix-callout--ejected.mock.html | sort -u` — **29** keys. Five
are this section's (MOTIR-5628, 5717, 5718, 5719, 5721). Three ride the two carried blocks (MOTIR-5463
and 5466 in the `fx-` block, MOTIR-5631 in the `ej-` block), and 21 are the shared base stylesheet and
sprite provenance (MOTIR-123, 757, 1273–1277, 1595, 2680, 4672, 4882, 4892, 4900, 4953, 5007, 5008,
5136, 5327, 5336, 5351, 5480); all 24 are carried verbatim and GIVE or TAKE nothing here.

| key                                  | GIVES / TAKES                                                                                                                                                                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOTIR-5721                           | **GIVES** X1–X5, the show-when rule, the four keys and their placement. **TAKES** that the repair view names, per failing member, its own `ci` and its standing `queueExit` (`rawReason`), so the part can pick the line and the sentence without a second read |
| MOTIR-5719                           | **TAKES** that `WorkItemRepairViewDto.failing[]` carries `queueExit: { rawReason, failingCheckName } \| null` for a member failing because of a standing exit, beside its own `ci` — the field this section reads. **GIVES** nothing drawn                      |
| MOTIR-5717                           | **TAKES** the one predicate for _standing_ (failure, not re-queued, at the current head); X5 is its negative. **GIVES** nothing drawn                                                                                                                           |
| MOTIR-5718                           | this card                                                                                                                                                                                                                                                       |
| MOTIR-5628                           | the story; its verification recipe's steps 1–4 walk X1, X2 and X5                                                                                                                                                                                               |
| MOTIR-5463 / MOTIR-5466 / MOTIR-5631 | **nothing either way** — their panels are composed, not redrawn                                                                                                                                                                                                 |

Fixture items use `ACME-n` keys, as the rest of this area does, so they link to nothing.

## 27 · The DECISION port — an agent's decision document as the PRIMARY question above the merge (MOTIR-5673, 2026-09-19)

**Asset:** `design/github/approve-and-merge--decision.mock.html` — a NEW delta mock. It amends
`design/github/approve-and-merge.mock.html` (§ 20, Panels 12p–12w) and is not an edit of it. The
To-approve row for the same kind is `design/workbench/approvals-row--decision.mock.html`, noted in
`design/workbench/design-notes.md` § 27.

**Drawn to:** `docs/decisions/approval-gates.md` § 8's FIFTH AMENDMENT (MOTIR-5672), which decides
every behaviour below. This section decides only what it looks like.

### What the card is

A `type: decision` + `executor: coding_agent` card ships its decision as ONE
`docs/decisions/<slug>.md` file in its pull request. It holds two questions — _is this decision
right?_ (PRIMARY, `decision_approval`) and _do these commits land?_ (the approve-to-merge gate) — and
ONE press answers both. **It is the design card's arrangement with a document where the mock goes.**

### Composed, never redrawn — every surface this asset uses

| card       | asset it composes (published `sourcePath`)                       | what it contributes here                                      |
| ---------- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| MOTIR-5327 | `design/github/github.mock.html`                                 | the Development block as the ONE gate frame (§ 20)            |
| MOTIR-5480 | `design/github/approve-and-merge.mock.html`                      | band 3's _Approve and merge_ and every decided / refused band |
| MOTIR-5222 | `design/workbench/approval-overlay.mock.html`                    | the full-screen overlay's container and exit row              |
| MOTIR-5438 | `design/workbench/approval-overlay--pull-request-gate.mock.html` | band 2 of the overlay = the Development block                 |
| MOTIR-5228 | `design/work-items/approval-cta.mock.html`                       | the item page's single _Review & approve_ door                |
| MOTIR-5147 | `design/workbench/approvals-row.mock.html`                       | the To-approve row (drawn in the workbench delta)             |
| MOTIR-5612 | `design/workbench/approvals-row--one-gate.mock.html`             | one row per decision, never per object                        |

The token block, the lucide sprites and every class are spliced 1:1 from
`approval-overlay--pull-request-gate.mock.html`. **The only new rules are the decision slot's
(`.dd-slot`, `.dd-meta`, `.dd-link`, `.dd-held`, `.dd-held-band`) and the disabled verb
(`.af-btn[disabled]`, the shipped Button's `disabled:opacity-50`).** Three lucide sprites are added,
extracted from the installed `lucide-react@1.16.0`: `scale` (the decision TYPE's mark,
`lib/issues/workItemTypeMeta.ts`), `file-x` and `files`.

### The slot, and where it sits

The document sits **FIRST in band 2**, exactly where a design card's result sits — the shipped
`DevelopmentSection` order for a primary: _the subject, then How to test, then the pull requests_. It
is composed from the How-to-test part: its head row (`dvb-htt-head`, titled **Decision document**), a
meta line — the file's path, its short **blob** sha _at_ the short head sha it was read at, and
**View on GitHub** — and the file rendered as Markdown with the block's own `dvb-md` styles. Band 1's
kind reads **Decision** and its meta leads with the path; the kind label follows the GATE, exactly as
`DevelopmentGateFrame` already does for a design (MOTIR-5667).

### Panels — one per state the record defines

| panel             | state                                                              | what is on it                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (+dark, ~400px) | awaiting, routed to you                                            | the document PRIMARY; How to test and the pull request beneath; _Request changes_ · _Approve and merge_                                                                           |
| 2                 | awaiting, not yours                                                | the same port, live; no verbs; _Waiting on {name}._                                                                                                                               |
| 3a–3d             | UNRESOLVABLE: none · several · gone at the head · host unreachable | the slot carries the block's missing-state callout with the reason; **Approve disabled** with its reason in words; Request changes enabled; the green pull request does not merge |
| 4                 | approved, merge held until green                                   | record band: _Decision accepted by …_ and _merges when its checks pass — no second press_; **no verb anywhere**                                                                   |
| 5a                | superseded by a push that CHANGED the document                     | the frame's withdrawn port with the per-kind cause line, and _Show the current version_                                                                                           |
| 5b                | a push that did NOT change the document                            | the decision's answer stands (a line in the slot); the merge question, re-asked alone, leads with the plain approve-and-merge band                                                |
| 6a / 6b           | decided: approved · changes requested                              | the record band — the accepted blob named; the reviewer's note                                                                                                                    |
| 7                 | the approval overlay                                               | band 2 is Panel 1's block, band 3 its verbs; dialog title _Decision approval for {key}_                                                                                           |
| 8a                | the ACCESS PATH on the item page                                   | the shipped status-held notice's _Review & approve_ opens Panel 7; the frame's _Expand ⤢_ does too                                                                                |

The To-approve row (the card's Panel 7) and the row's door (Panel 8b) are in the workbench delta.

### Copy — every string, `en` and `zh`

Existing keys are cited, not repeated. New keys are the port's (MOTIR-5678) under
`approvalGate.decision.*`.

| key                                                  | en                                                                                                                                             | zh                                                                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `decision.kindLabel`                                 | Decision                                                                                                                                       | 决策                                                                                                      |
| `decision.portTitle`                                 | Decision document                                                                                                                              | 决策文档                                                                                                  |
| `decision.meta`                                      | blob {blob} at {head}                                                                                                                          | 文件版本 {blob}，提交 {head}                                                                              |
| `decision.viewOnHost`                                | View on GitHub                                                                                                                                 | 在 GitHub 上查看                                                                                          |
| `decision.headMeta.one`                              | {path} · {count, plural, =1 {# pull request} other {# pull requests}} · delivered by {run}                                                     | {path} · {count} 个拉取请求 · 由 {run} 交付                                                               |
| `decision.headMeta.none`                             | No decision document · {count, plural, =1 {# pull request} other {# pull requests}} · delivered by {run}                                       | 无决策文档 · {count} 个拉取请求 · 由 {run} 交付                                                           |
| `decision.headMeta.several`                          | {docs} decision documents · {count, plural, =1 {# pull request} other {# pull requests}} · delivered by {run}                                  | {docs} 份决策文档 · {count} 个拉取请求 · 由 {run} 交付                                                    |
| `decision.consequence`                               | Approving accepts this decision and merges {prs}, then moves {key} to Approved.                                                                | 批准即接受此决策并合并 {prs}，随后将 {key} 移至“已批准”。                                                 |
| `decision.blocked`                                   | Nothing can be approved until the pull request carries exactly one decision document. Nothing merges until then.                               | 拉取请求中恰好有一份决策文档后才能批准，在此之前不会合并任何内容。                                        |
| `decision.unresolvable.none`                         | **This pull request adds no decision document.** A decision is one file under docs/decisions/. Send it back to the agent with Request changes. | **此拉取请求未添加决策文档。**一个决策对应 docs/decisions/ 下的一个文件。请用“要求修改”将其退回给智能体。 |
| `decision.unresolvable.several`                      | **This pull request changes {count} files under docs/decisions/** — {paths}. A decision has exactly one document.                              | **此拉取请求修改了 docs/decisions/ 下的 {count} 个文件** — {paths}。一个决策只有一份文档。                |
| `decision.unresolvable.gone_at_head`                 | **The decision document is no longer at this pull request's head.** A push removed or renamed it.                                              | **决策文档已不在此拉取请求的最新提交中。**某次推送删除或重命名了它。                                      |
| `decision.unresolvable.host_unreachable`             | **Motir could not reach GitHub to show the decision document.** Nothing can be approved until it can be read. Try again in a moment.           | **Motir 无法连接 GitHub 以显示决策文档。**在能够读取之前无法批准。请稍后再试。                            |
| `decision.unresolvable.too_large`                    | **The decision document is too large to show here.** Open it on GitHub; it cannot be approved from Motir.                                      | **决策文档过大，无法在此显示。**请在 GitHub 上打开；无法在 Motir 中批准。                                 |
| `decision.unresolvable.not_connected`                | **This repository is not connected to Motir,** so the decision document cannot be shown.                                                       | **此仓库未连接到 Motir，**因此无法显示决策文档。                                                          |
| `decision.accepted`                                  | Decision accepted by {name} · {when}                                                                                                           | {name} 于 {when} 接受了此决策                                                                             |
| `decision.acceptedUnchanged`                         | Decision accepted by {name} · {when} — unchanged at the new head                                                                               | {name} 于 {when} 接受了此决策 — 新提交中未改变                                                            |
| `decision.mergeHeld`                                 | The pull request merges when its checks pass — no second press.                                                                                | 拉取请求在检查通过后自动合并，无需再次点击。                                                              |
| `withdrawn.causeByKind.decision_approval.head_moved` | A push changed the decision document, so this question was withdrawn.                                                                          | 推送修改了决策文档，因此该问题已撤回。                                                                    |
| `decision.withdrawnNext`                             | Nobody decided it. The new version is asked in its place.                                                                                      | 没有人对它做出决定。新版本已取而代之。                                                                    |

**Reason → copy mapping, total over what can arrive:** the CAPTURE's `none` / `several` /
`unreadable` (MOTIR-5674) and the READ's `gone_at_head` / `too_large` / `host_unreachable` /
`not_connected` (`DecisionDocumentReadReason`, MOTIR-5676). `unreadable` renders the
`host_unreachable` line — both mean _Motir could not look_. The door's own refusal lines
(`approvalGate.refusal.decisionUnresolvable`, `.decisionPending`, shipped by MOTIR-5676 / MOTIR-5677)
are unchanged: they render only if a stale page presses anyway.

**Reused, not new:** `approvalGate.waitingOn`, the `Approve and merge` / `Request changes` verbs,
`approvalGate.withdrawn.record` and `.at`, `approvalOverlay.dialogTitle` (with the kind name
`workbench.approvals.kind.decision_approval`, _Decision approval_ / _决策审批_), and the status-held
notice's `workItems.statusHeld.decision` + `decisionNoun.decision_approval` + `reviewAndApprove`.

### Decisions this asset made, with their reason

- **The document LEADS, the pull requests follow.** The shipped order for a primary; a second order
  would be a second visual language for one act.
- **Unresolvable is drawn in the slot, not as a refusal.** The reason is a fact about the pull request
  a reviewer should read before pressing anything; the refusal line is for a press that races a push.
- **The head names the blob AND the head sha.** The blob is what the gate asks about (clause 4); the
  head says which commit that blob was read at, so a reviewer can open exactly that file.
- **5b hands the lead to the merge question.** With the decision answered, the only open question is
  the commits, so the frame is the plain approve-and-merge frame and the decision is a line, not a
  second band.
- **A per-kind withdrawn cause, not a reworded shared one.** The shared `head_moved` line is still true
  for a code card; the decision kind's writes only when the document changed and says so.

### GIVES / TAKES

Scope: `grep -o 'MOTIR-[0-9]*' approve-and-merge--decision.mock.html | sort -u` — 29 keys. Eight are
this section's own (MOTIR-4907, 5222, 5438, 5480, 5672, 5673, 5678, 5679); the other 21 are the base
stylesheet and sprite provenance carried verbatim (MOTIR-123, 757, 1273–1277, 1595, 2680, 4672, 4882,
4892, 4900, 4953, 5007, 5008, 5136, 5327, 5336, 5351, 5494), which GIVE or TAKE nothing.

| key                      | GIVES / TAKES                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MOTIR-5678               | **GIVES** Panels 1–7 and 8a, the slot, the copy table above. **TAKES** the port's read — `decisionDocumentService.readForWorkItem` (identity in a transaction, content outside it) — and the per-kind withdrawn cause line; both amended onto the card |
| MOTIR-5679               | **GIVES** nothing from this asset — its row is the workbench delta                                                                                                                                                                                     |
| MOTIR-5672               | the record every panel draws to; **nothing either way**                                                                                                                                                                                                |
| MOTIR-5480 / 5438 / 5222 | **nothing either way** — composed, not redrawn                                                                                                                                                                                                         |
| MOTIR-4907               | the story; its verification recipe's steps 1–3 walk Panels 1, 4 and 3a                                                                                                                                                                                 |
| MOTIR-5673               | this card                                                                                                                                                                                                                                              |

Fixture items use `ACME-n` keys, as the rest of this area does, so they link to nothing.
