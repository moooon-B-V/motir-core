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

### The sprite sheet — EXTRACTED vs APPROXIMATE

A symbol's NAME is exactly the kind of thing a careful reader trusts, and in this sheet it has been
wrong twice: `#i-x` is lucide `circle-x` under a short name (MOTIR-5007 reached for it and drew a
circled ⊗ where `RemoveLinkButton` renders a plain `X`), and it was also hand-typed at `r="9"` where
the package draws `r="10"`.

Diffing every `<symbol>` against `lucide-react@1.16.0` found **19 of 30 drifted**. The six the
Development row draws — `#i-git-pr`, `#i-git-merge`, `#i-git-closed`, `#i-check`, `#i-x`, `#i-dots` —
are now emitted from the package, each with a comment naming the file it came from and the
`PR_STATE_META` / `CI_STATE_META` entry it stands for. **Three of them were not approximations of
their own icon at all**: `#i-git-pr` was a sketch of lucide `git-pull-request`, a different icon from
the `GitPullRequestArrow` the component imports.

The remaining thirteen are listed as APPROXIMATE in the sprite sheet's own header, and extracting
them — plus turning this diff into a reusable predicate — is **MOTIR-5136**. `#i-github` and
`#i-gitlab` are brand marks and are outside the audit. Re-check any one sprite in one command:

```
grep -oE '\["(circle|path|line|polyline|rect)".*' \
  node_modules/lucide-react/dist/esm/icons/circle-x.mjs
```

### What did NOT change

No panel gains or loses an element. This is a measurement correction, not a redesign: the eleven
`.pr-row` instances across Panels 3, 4, 5a–5f keep their glyph, title, meta line, pill set, link-out
and — where MOTIR-5007 put one — their remove control, in that order.
