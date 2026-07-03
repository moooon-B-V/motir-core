# Public projects — design notes

Design reference for the `public-projects` UI area — **"open source project
management"**: a project made **public** for read-only VIEW by **anyone on the
web (no sign-in)**, where the only writes are **submit a request** (into the
6.11 Triage), **upvote**, and **comment** (Story 6.12) — and those three writes
require sign-in. Built FROM the real design system (`app/globals.css` `--el-*`
colour tokens + `[data-display-style]` shape tokens + the shipped
`components/ui/*` primitives), so the code subtasks compose the same primitives —
no Pencil→code gap.

> **⚠️ Model revision (Yue, 2026-06-14).** A public project page is now **fully
> public — anyone can VIEW it with no sign-in**, and it is **server-rendered +
> crawlable, optimised for SEO + GEO**. Only the three **writes** (submit a bug /
> feature request, upvote, comment) still require sign-in ("sign-in-to-act" — the
> GitHub / Canny standard); anonymous _writes_ stay out of scope (they need the
> deferred abuse / anonymous-identity model). This supersedes the earlier
> "account-required, not anonymous" framing for READ, mirrors the 6.13
> project-square revision, and resolves its anonymous click-through knock-on.

> **⚠️ Model revision (Yue, 2026-06-15 — Story 6.16).** The public hero is now
> **fully authorable** and overview editing moves **onto the public page itself**
> (in place, WYSIWYG). Two new project fields back it: **`publicTagline`** (the
> hero subtitle — unset → the generic i18n line) and **`publicTags`** (the hero
> meta pills — replacing the four hardcoded i18n pills). A signed-in project admin
> (`viewerCanManage`) viewing their own public page sees an **"Edit page"**
> affordance and edits the tagline, tags, and README (`publicOverviewMd`, via the
> shipped `MarkdownEditor`) right on the page; a **sticky Save / Cancel** bar
> tracks unsaved changes. **The in-settings editor is REMOVED** — Settings keeps
> only the access concerns (make-public toggle + share link) and shows an **"Edit
> on the public page →"** link instead. Motir's own "Vibe your whole project…"
> line moves OUT of the README body and INTO `publicTagline`. This supersedes the
> 6.12.8 "Edit overview" split-editor framing below (Panels 6/7) — see the
> **"In-place public-page editing (Story 6.16)"** section. Mirror (rung 1):
> Notion / GitHub-profile / Canny in-place "edit this page" authoring; Linear &
> Productboard public pages edit on the page, not in a buried settings sub-view.

> **⚠️ Reframe (Story 6.17, 2026-06-15).** The `public` access level is now
> **presented as a status — "Building in public"** — not a bare dropdown option.
> Nothing about the access MODEL changes (it is still the same 4th
> `ProjectAccessLevel = public`, the same public projection, the same
> sign-in-to-act writes); only its **presentation + discoverability** change.
> Three additions, each a UI subtask gated on this asset: **(6.17.2)** the
> make-public control + copy reframed to "Building in public" with an
> **explainer/confirm** step; **(6.17.3)** a **promoted, discoverable entry
> point** for non-public projects (PRIMARY: a persistent "Build in public" button
> in the project-shell header, not buried in settings; plus a dismissible nudge +
> a Settings → General card — NOT a bare dropdown option); **(6.17.4)** a **"Building in
> public" status badge** on the project (authed shell header + settings) when
> access = `public`, plus the **stop/manage path** (a reverse "stop building in
> public" confirm). Panels **10–12** below; the header badge in Panels 1–2 and the
> access option in Panel 6 are reframed to match. Mirror (rung 1): the
> build-in-public posture is the GitHub "make public" + Canny / Productboard
> "public portal" flow, surfaced as an opt-in **activity** the way Vercel / Linear
> surface "make public" / "share" as a first-class action rather than a buried
> setting.

> **Note (6.16 ↔ 6.17 interplay):** 6.16's authorable-hero / in-place editing and
> 6.17's build-in-public reframe are orthogonal and both land on this asset. The
> 6.16 **admin "Edit page" affordance** (Panels 1b/1c) and the 6.17 **"Build in
> public" / status badge** both live in the public-page topbar — they coexist
> (badge + Edit-page button for an admin viewing a public project), and the 6.16
> in-place editor replaces 6.12.8's settings split editor in BOTH framings.

| Surface                          | Asset                           | Gates                                                                                                      |
| -------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Public Overview / README**     | `public-projects.mock.html`     | **6.12.4** (render) + **6.16.4** (authorable tagline + tags)                                               |
| **Admin "Edit page" affordance** | `public-projects.mock.html`     | **6.16.5** (`viewerCanManage` only)                                                                        |
| **In-place edit mode**           | `public-projects.mock.html`     | **6.16.5** (tagline + tags + README via `MarkdownEditor` + sticky Save bar)                                |
| **Public read-only view**        | `public-projects.mock.html`     | **6.12.4** (board / work items, internal fields hidden)                                                    |
| **Public roadmap**               | `public-projects.mock.html`     | **6.12.7** (status-grouped, vote-counted, paginated)                                                       |
| **Submit + duplicate detect**    | `public-projects.mock.html`     | **6.12.5** (the form) + **6.12.6** (the upvote target)                                                     |
| **Request detail**               | `public-projects.mock.html`     | **6.12.6** (upvote + comments on public requests)                                                          |
| **Make-public + share link**     | `public-projects.mock.html`     | **6.12.8** (Access control + link) + **6.16.6** (drop editor → on-page link)                               |
| **Public work-item DETAIL**      | `public-item-detail.mock.html`  | **6.14.11** (the page) + **6.14.6** (the private-epic child-panel placeholder)                             |
| **Build-in-public reframe**      | `public-projects.mock.html`     | **6.17.2** (reframed access control + copy + explainer) — Panels 6, 11                                     |
| **Build-in-public entry pt**     | `public-projects.mock.html`     | **6.17.3** (PRIMARY: persistent header button; + nudge + Settings card → confirm) — Panel 10               |
| **Build-in-public badge**        | `public-projects.mock.html`     | **6.17.4** (status badge + stop/manage path) — Panels 1, 2, 12                                             |
| **Public-state header slot**     | `public-projects.mock.html`     | **6.17.6** (active "Building in public" indicator, linked to settings — design gate for 6.17.7) — Panel 12 |
| **In-place sign-in / sign-up**   | `public-signin-modal.mock.html` | **MOTIR-1557** (this asset — design gate) → **MOTIR-1558** (build the modal). Panels 1–7                   |

Every UI code subtask in Story 6.12 (6.12.4 / 6.12.6 / 6.12.7 / 6.12.8) carries
`6.12.1` in `dependsOn` and is `blocked` until this asset lands. The
**public work-item DETAIL page** is a LATER addition (Story 6.14 — see the
dedicated section below): `public-projects.mock.html` deferred it as "a later
card" (cards were drawn navigable to a read-only work item that was never built),
and 6.14.6 (the private-epic child-panel placeholder) needs it. Its asset is
**`public-item-detail.mock.html`** (gate **6.14.12**); the code is **6.14.11**.

## The locked model this UI sits on (6.12.2 / 6.12.3)

`public` is a **4th `ProjectAccessLevel`** extending 6.4 (DONE: open / limited /
private). The openness ladder is **public > open > limited > private**, and
`public` is the **ONLY** level that crosses the org boundary for READ — for a
public project `canBrowse` returns true **for ANYONE, including no session at
all** (the READ is anonymous + crawlable), bypassing the 6.10 org/workspace gate
**for READ on public projects only**. A public viewer is **NOT a member**, so 6.4
`canEdit` is false; the three permitted writes — **submit-to-triage, upvote,
comment** — are NEW narrow grants (`canSubmitToTriage` / `canUpvotePublicRequest`
/ `canCommentPublicRequest`) that **require a signed-in account** (sign-in-to-act),
checked explicitly, never a `canEdit` relaxation.

Three invariants this asset draws and `design-notes` states in writing:

1. **Internal fields are ABSENT** from the public view — **assignees, estimates,
   and internal work-item comments** are stripped by a public PROJECTION at the read
   layer (NOT fetched-then-hidden). The public board card is the shipped board
   card (`design/boards/board.mock.html`) **minus the assignee avatar + the
   story-point estimate + the drag grip**. (Public-_request_ comments from
   Panel 4 ARE public — distinct from a work item's internal discussion.)
2. **NO edit affordances** anywhere on the public surface — no create / move /
   assign / status / drag. The only interactive elements are Submit-a-request,
   Upvote, and Comment.
3. **Fully public READ — anonymous + crawlable; sign-in only to ACT.** Anyone
   on the web can view a public project with no sign-in, and the page is
   server-rendered + indexable (SEO/GEO — see Panel 9). The three writes (submit
   a bug / feature request, upvote, comment) require sign-in: a logged-out write
   surface shows a "Sign in to act" prompt. Anonymous _writes_ stay out of scope
   (they'd need the deferred abuse / anonymous-identity model).

**Verified mirror (rung 1, cited 2026-06-12):** OpenProject / Plane / GitHub
public-repo visibility for the public-project + public-roadmap posture; Canny /
Productboard / Featurebase for the submit + upvote + comment + status-roadmap +
duplicate-detection portal set.

---

## The asset is multi-panel (review EACH — mistake #31)

1. **(1)** the public **Overview / README** landing — a modern, GitHub-README-
   style project intro: a hero (logo + name + authored **`publicTagline`** +
   authored **`publicTags`** meta pills + at-a-glance stats + CTAs) + an authored
   Markdown body + a links / at-a-glance sidebar. The **default** public tab. This
   panel is the ANONYMOUS / non-admin viewer read state.
   1b. **(1b)** the **admin "Edit page" affordance** (Story 6.16) — the same Overview
   page as a signed-in project admin (`viewerCanManage`) sees it: the topbar swaps
   the logged-out "Sign in / Start free" CTAs for the admin's identity + an
   **"Edit page"** button (top-right), plus a quiet hint band. Anonymous / non-admin
   viewers never see it.
   1c. **(1c)** **edit mode — in place** (Story 6.16) — entering edit makes the page
   itself the editor (WYSIWYG): the tagline becomes a multi-line input (placeholder
   "Add a tagline…"), the tags become removable chips + an "Add tag" input
   (max-count + empty states), and the README body becomes the shipped
   `MarkdownEditor`. A **sticky Save / Cancel** bar tracks unsaved changes; the
   topbar shows an **"Editing"** pill.
   1d. **(1d)** **edit-mode states** (Story 6.16) — empty tagline (→ generic i18n
   fallback), zero tags, save-in-flight, save error, and the unsaved-changes guard
   dialog.
2. **(2)** the public read-only project view (**Board** tab) — the read-only
   **board** (To Do / In Progress / In Review / Done) as an anonymous (logged-out)
   visitor sees it: NO edit affordances, INTERNAL fields absent, the public-project
   BANNER ("anyone can view — no account needed; sign in to act") + a Sign-in /
   Start-free CTA in the top bar (no signed-in identity), a read-only Overview /
   Board / Work items / Roadmap nav.
3. **(3)** the public **roadmap** — status-grouped columns (submitted → planned →
   in progress → done) with vote counts + per-column pagination.
4. **(4)** **submit a request + DUPLICATE DETECTION** — the form (type toggle,
   title, description), the dedupe "upvote this instead" state, submit-as-new,
   the confirmation.
5. **(5)** a public **request detail** — the body, the upvote control + count
   (voted state), the public comment thread + composer.
6. **(6)** project **settings** — the four-level Access control (the Public
   option now reads "anyone can view, no account, indexable by search engines") +
   the shareable public link (copy / disable / rotate) + the no-sign-in-to-view
   note + **an "Edit on the public page →" link** (Story 6.16 — the embedded
   editor is REMOVED; editing now happens in place on the public page, Panels
   1b/1c).
7. **(7)** ~~**Edit overview** — the dedicated authoring split editor~~ —
   **RETIRED (Story 6.16).** Overview/hero editing is now in place on the public
   page (Panels 1b/1c); this dedicated settings sub-view no longer exists.
8. **(8)** **states** — empty roadmap, empty request list, the paginated loading
   skeleton, the fetch-error, the rate-limited submit.
9. **(9)** **SEO + GEO scaffolding** — the fully-public page is server-rendered +
   crawlable: head meta / OpenGraph / canonical, JSON-LD (`SoftwareApplication`),
   a semantic HTML outline, and the GEO answer-engine framing (the Overview/README
   as the citable description + an FAQ). States the read-anonymous /
   write-needs-sign-in / internal-fields-stripped facts.
10. **(10)** **Build-in-public ENTRY POINT** (6.17.3) — the **promoted** entry for
    a NOT-yet-public project. **PRIMARY: a persistent "Build in public" button in
    the project-shell header** (`.btn-build`, build-tinted, always visible to
    admins — the same slot that becomes the status badge once public). Secondary:
    a **dismissible project-shell nudge** (one-time reinforcement) and a **Settings
    → General promo card** (durable home — megaphone hero + 3 what's-shared bullets
    - a primary "Start building in public" CTA). All open the explainer/confirm
      (panel 11); it is **never** a bare access-dropdown option.
11. **(11)** **EXPLAINER / CONFIRM** (6.17.2) — the "Start building in public?"
    Modal: a lead paragraph + a "What becomes public" list (board + roadmap; work
    items crawlable; sign-in only to act; internal fields stay stripped) + a
    reassurance note (stop anytime, requests kept) + a Cancel / "Start building in
    public" footer.
12. **(12)** **STATUS badge + STOP / manage path** (6.17.4) **+ the PUBLIC-STATE
    HEADER SLOT** (6.17.6) — the "Building in public" badge shown in the authed
    project-shell header + settings access row when access = `public`, the manage
    row (View public page · Stop), and the reverse **"Stop building in public?"**
    confirm Modal (warn tone — page goes offline, link stops working,
    requests/upvotes kept). The header slot is drawn as the **single stateful
    slot** (6.17.6): the promoted "Build in public" CTA when not public (6.17.3),
    and once public the SAME slot becomes a **clickable** "Building in public"
    status indicator that links to the settings manage/stop home — never both,
    never empty.

## Where it lives

```
design/public-projects/
  design-notes.md              ← this spec (indexes every surface in the area)
  public-projects.mock.html    ← the public read/roadmap/submit/settings + build-in-public asset
  public-projects.png          ← its full-page PNG export
  public-item-detail.mock.html ← the public work-item DETAIL page asset (Story 6.14)
  public-item-detail.png       ← its PNG export
  public-signin-modal.mock.html← the in-place (modal) sign-in / sign-up asset (MOTIR-1557)
  public-signin-modal.png      ← its PNG export (7 panels, one full-page image)
```

---

## Panel 1 — the Overview / README landing (the 6.12.4 render + 6.12.8 authoring)

The public landing leads with a **modern, GitHub-README-style** project intro —
"introduce the project, like a GitHub README but more modern" (Yue). It is the
**default** public tab (GitHub puts the README on the repo home; Canny /
Productboard portals and Plane / OpenProject public projects all open on an
about/overview, not the raw board). Mirror, modernised: a hero band + an authored
rich body + a links/stats sidebar, all in the design system.

### The data — a new project field

The README content is a nullable project field **`publicOverviewMd`** (Markdown),
rendered read-only on this tab via the shipped **`MarkdownView`**. **Story 6.16
adds two more authorable hero fields** — **`publicTagline`** (string, the hero
subtitle) and **`publicTags`** (string array, the hero meta pills) — and moves
authoring **onto the public page itself** (in place, WYSIWYG; see the **In-place
public-page editing** section). All three are part of the **public projection**
(6.12.4 / 6.16.3) — public-safe, served only when the project is public, and
threaded with a **`viewerCanManage`** flag (true only for a signed-in project
admin) that gates the edit affordance. Fallbacks (never a blank surface):
`publicTagline` unset → the generic i18n line; `publicTags` empty → the meta-pill
row is omitted; `publicOverviewMd` empty → a slim auto-intro (name + tagline +
stats + CTAs, no body). The hero name/stats stay auto, and the Links sidebar pulls
from existing project fields (website / repo / docs).

### The hero (`.hero`)

A bordered `Card` with a **soft corner-wash** (two radial `--el-hero-wash-*`
tints over `--el-page-bg` — decorative only; all text sits on `--el-page-bg`, AA-
safe, NOT a page-level tint — finding #35). Holds: a 52px logo tile
(`--el-accent`), the project name in the serif display face, the **authored
`publicTags`** rendered as **meta `Pill`s** (Motir seeds "Vibe project" lavender /
"Open source" mint / "GPL-3.0" / "MCP-native" neutral — but they are now authored,
not hardcoded), the **authored `publicTagline`** subtitle (Motir's "vibe your
whole project" framing — NOT "AI project management"; unset → generic i18n line), a
**CTA row** (`View the roadmap` primary · `Submit a request` outline · `GitHub`
ghost), and an **at-a-glance stat strip** (Public requests / Upvotes / Planned /
Shipped) above a hairline.

### The body + sidebar (`.ov-grid`, 1fr + 312px)

Motir is framed as **three layers, end to end** (NOT "AI project management"):
**(1)** an AI planner, **(2)** an AI-native project manager (MCP-native)
(`motir-core`), **(3)** a hosted AI coding agent — the unique end-to-end pipeline.
The README carries that in two beats:

- **Main** — the authored README (`.md`, the `MarkdownView` render):
  - **Part 1 — the self-improving loop** ("You're looking at Motir, inside Motir"
    - "A self-improving loop — and you're in it"), a **numbered loop** (`ol.loop`,
      accent number badges: submit → triage → plan → agent PR → ships as Done).
  - **Part 2 — "Vibe project"** (the headline idea, by analogy to _vibe coding_):
    a vibe project is the WHOLE project, not just code — **design, marketing,
    legal, research, engineering**; you bring the intent, Motir's **three layers**
    carry it idea→shipped, drawn as a `ul.layers` list with per-layer palette-hued
    icons — AI planner (`--el-type-story` route; plans work items of every kind),
    AI-native project manager (`--el-type-task` columns; MCP-native), hosted coding
    agent (`--el-accent` github; ships the engineering work items) — closing on
    "Motir plans, tracks, and ships the whole thing — code and everything around
    it. That's a vibe project."
  - a **product-screenshot** placeholder (browser-chrome frame + tinted panes) and
    a **"Contribute"** section linking to submit. (Motir's own project seeds this
    exact copy as `publicOverviewMd`; see the Copy index.)
- **Sidebar** (`.ov-side`) — a **Links** `side-card` (Website / Docs / Source /
  Changelog, each an external-link row), an **At a glance** stat grid, and a
  **CTA card** ("Have an idea? → Submit a request") with the same accent wash.

No edit affordances on the public render; the only actions are the CTAs (submit /
roadmap / external links). The authoring editor lives in Panel 6 (settings).

---

## Panel 2 — the public read-only view (the 6.12.4 surface)

### The public chrome

- **Top bar** (`.pub-topbar`, `--el-surface-soft`): the project logo tile
  (`.pub-logo`, `--el-accent` fill + `--el-accent-text`), the project name + a
  **`Pill` `pill-public`** (`globe` lucide, `--el-public-banner-bg` /
  `--el-public-banner-text`), the project key + workspace, and on the right a
  **Sign in (`btn-ghost`) + Start free (`btn-primary`) CTA** — the logged-out
  state (no signed-in identity), since the page is anonymous to view.
- **Public banner** (`.pub-banner`, full-width `--el-public-banner-bg`): the
  explicit framing — _"You're viewing a public project. Anyone can view it — no
  account needed. Sign in to submit, upvote, or comment on requests."_ + a
  `lock`-glyph
  **"View-only — you can't edit work items"** note.
- **Sub-bar nav** (`.seg`, a read-only `Segmented`): **Board / Work items / Roadmap**
  (Board active) + the primary **"Submit a request"** button (`globe`/`plus`).
  The nav switches read views only — it is not an edit affordance.

### The board (the public PROJECTION)

Mirrors `design/boards/board.mock.html` — same `.col` / `.col-head` /
`.col-count` / `.bcard` grammar — but each card carries **only**
`IssueTypeIcon` (kind hue) + the work item key + the title + the priority `Pill`.
**No assignee Avatar, no `pts` estimate, no `grip` drag handle.** The cards are
`<a>` (navigable to the read-only work item), never draggable. A bottom note states
the omissions are a read-layer projection (not DOM-hidden). 6.12.4 renders this
projection paginated / lazy (the at-scale rule).

---

## Panel 3 — the public roadmap (the 6.12.7 surface)

Four `.rm-col` columns, each a status bucket with a tinted header
(`.rm-head` + `.ct` count) and a `.rm-body`:

- **Submitted** → `--el-roadmap-submitted` (peach) · **Planned** →
  `--el-roadmap-planned` (lavender) · **In progress** → `--el-roadmap-progress`
  (sky) · **Done** → `--el-roadmap-done` (mint). The four public buckets are a
  mapping FROM the project's real workflow statuses (6.12.7 decides the mapping;
  non-public statuses — canceled / triage — are not shown).
- Each `.rm-card` is a **div** (not an anchor) holding the **upvote control**
  (`.vote`, a `<button>`) + a body with the title as an `<a class="tt">` link +
  the kind. **The vote button and the title link are SIBLINGS — never a button
  nested in an anchor** (avoids the axe `nested-interactive` violation; the real
  6.12.7 component must keep them separate too).
- **Pagination is per column** — a `.rm-more` "Load N more →" link, NOT load-all
  (the at-scale rule; 6.12.7 cursor-pages each column).

### The upvote control (`.vote`)

A Canny-style vertical control: an up-chevron over the count. Resting =
`--el-page-bg` + `--el-border`, hover = `--el-accent` border. **Voted** =
`--el-vote-active-bg` (accent fill) + `--el-vote-active-text`. One vote per
account (6.12.6, server-enforced); a second click toggles it off (no double
count). A `.lg` size renders on the request detail. When the count is shown as a
read-only display (in the dedupe match), it is a `<span role="img">`, not a
button.

---

## Panel 4 — submit a request + duplicate detection (the 6.12.5 surface)

- **Type toggle** (`.type-toggle`, a 2-option `Segmented`/radiogroup):
  **Feature** (`square-check-big`, `--el-type-task`) | **Bug** (`bug`,
  `--el-type-bug`). Feature default.
- **Title** `Input` + **Description** `Textarea` (`FormField`). The hint states
  the submission is attributed to the signed-in account: _"Submitted as {name}
  ({org}) — your account is attached for follow-up."_
- **Duplicate detection** (`.dedupe`, fires as the title is typed, BEFORE
  create): a `copy-check`/`warning` header _"N existing requests look similar —
  upvote one instead of creating a duplicate?"_ then `.match` rows, each with the
  existing request's vote count (read-only display), title, status `Pill`, and an
  **"Upvote this"** outline button (the Canny behaviour — joins the existing
  request, creates NO new item). An **"Not the same? Continue and submit as
  new →"** link is the escape hatch.
- **Confirmation** (`.confirm`, after submit-as-new): a mint success badge
  (`check-check`), _"Thanks — we got it"_, the triage-queue explanation + a
  "View roadmap" / "Submit another" pair.

The submit button is disabled until title is non-empty (mockup shows the
disabled resting state).

---

## Panel 5 — the public request detail (the 6.12.6 surface)

- **`.req-head`**: the large upvote control (`.vote.lg`, voted state) + the
  status `Pill` + the title + a meta row (kind `IssueTypeIcon`, "opened by
  {name}", the submitter's org `Pill`, age).
- **`.req-body`**: the request description.
- **Comments** (`.comment` rows): each an Avatar + author + **org label** (the
  cross-org attribution) + relative time + the body. These are **public-request
  comments** (visible) — distinct from a work item's internal comments (hidden by
  the Panel-1 projection).
- **Composer** (`.composer`): the viewer's Avatar + a `Textarea` + a primary
  **"Comment"** button. Gated by `canCommentPublicRequest`.

---

## Panel 6 — make-public toggle + share link (the 6.12.8 surface)

- **Access control** (`.access-opt` radio cards) extends 6.4's three-level
  control to **four**, in openness order **public > open > limited > private**,
  each with an icon (`globe` / `users` / `eye` / `lock`) + one-line copy. The
  selected option (Public) takes `--el-accent` border + a faint accent tint
  (`color-mix … 7%`) + a filled radio. Project-admin-gated (non-admins see it
  read-only). Setting Public calls the 6.4 `setAccessLevel` service with the new
  enum value (6.12.8 — extend, don't fork).
- **Public link** (`.sharelink`): a mono link field + **Copy** / **Rotate** /
  **Disable** (`btn-danger`, rose tint). The `.acct-note` states the link opens
  with **no sign-in** (the page is public + crawlable), that visitors sign in only
  to submit / upvote / comment, and that rotating issues a new link without
  changing the project key.
- **Page content → on-page editor link** (`.ov-link-row`, Story 6.16): a row —
  **"Hero & overview"** + the copy "Edit the tagline, tags, and README right on the
  public page — what you change is what visitors see" + an **"Edit on the public
  page →"** link (`.go`, `--el-link`, `i-arrow-right`). **The embedded editor /
  the old `.ov-entry` "Edit overview" button are REMOVED** — Settings keeps only
  the access concerns; editing happens in place (the In-place section). The
  `.acct-note` states the link opens the public Overview with the on-page editor
  and is hidden while the project isn't public. Project-admin-gated.

---

## Panel 7 — RETIRED (Story 6.16)

The dedicated in-settings **"Edit overview"** split editor (left Markdown source /
right live preview) is **gone**. Editing the hero (`publicTagline` + `publicTags`)
and the README (`publicOverviewMd`) now happens **in place on the public page**
(the In-place section + Panels 1b/1c) — the page itself IS the preview, so a
separate preview pane is redundant. 6.16.6 deletes the `EditOverview` sub-view; its
CSS (`.editor-shell` / `.editor-split` / `.editor-src` / `.editor-prev` /
`.prev-badge` / `.md-prev` / `.ov-editor` / `.ov-entry` / `.pane-tag`) is dropped
from this asset. (The `.editor-toolbar` / `.tb` toolbar grammar survives — reused
by the in-place `MarkdownEditor`.)

---

## In-place public-page editing (Story 6.16) — Panels 1b / 1c / 1d

The authorable hero + on-page overview editing. **`viewerCanManage`** (6.16.3) is
true only for a signed-in **project admin**; everything below is gated on it and is
absent for anonymous / non-admin viewers (who see Panel 1).

### Panel 1b — the "Edit page" affordance (the 6.16.5 surface)

- The public chrome is unchanged EXCEPT the topbar right side: instead of the
  logged-out **Sign in / Start free** CTAs, an admin sees their **identity** (an
  initial-letter `Avatar` + "Name · Admin", `.viewer-admin .who`) + an **"Edit
  page"** button (`.btn.btn-outline.btn-edit-page`, `i-edit` in
  `--el-accent-on-surface`), top-right near the CTA row.
- A quiet **`.admin-hint`** band (a faint `color-mix(--el-accent 7%)` callout)
  under the public banner: "You manage this project. Hit **Edit page** to change
  the tagline, tags, and overview right here — what you edit is what visitors see
  (WYSIWYG). Only you (and other admins) see this." The hero below is identical to
  Panel 1's authored hero.

### Panel 1c — edit mode, in place (the 6.16.5 surface)

The page becomes the editor (WYSIWYG — no separate preview). The topbar **"Public"**
chip is replaced by a light **"Editing"** mode chip (`.pill-editing` — a faint
`color-mix(--el-accent 9%)` tint + accent border + a live **pulsing accent dot**,
not a heavy filled pill) and the banner reads "Editing the public page. Changes show
live as you type…". The hero takes a dashed **`.hero.editing`** affordance ring, and
three regions become editable:

- **Tagline → a MULTI-LINE input** (`.tagline-input`, `--radius-input` +
  `--spacing-input-*`; `min-height` ≈ 2–3 lines so the tagline wraps — it is a short
  paragraph, not a one-liner). Focused state = `--el-accent` border + a 3px accent
  ring + a blinking inline `.caret`. Placeholder **"Add a tagline…"** when empty.
  Above it a `.field-label` "Tagline".
- **Tags → removable chips + a "+ Add tag" button.** Each authored tag is a
  `.tag-chip` (the same tint tones as the read pills) with a circular **`.tag-x`**
  remove control (`i-x`; a `<span>`, NOT a nested button — no `nested-interactive`).
  Adding a tag is a **two-state** affordance, NOT a persistent input box: the resting
  state is a compact dashed **`.tag-add` "+ Add tag" `<button>`**; clicking it swaps
  it for a **small fixed-width inline input** (`.tag-add.input`, ~150px, accent ring
  - blinking `.caret`) where you type a tag and press Enter to add (Esc cancels) —
    the chip then appears and the control reverts to the "+ Add tag" button. (No
    full-width input bar — the default surface is just the + button.) A **`.tag-meta`**
    count ("4 / 8 tags") states the max; empty → a **`.tag-empty`** "No tags yet" hint.
- **README body → the shipped `MarkdownEditor`** (`.md-edit`): the `.editor-toolbar`
  formatting row (heading / bold / italic · sep · link / list / numbered / image)
  over a `--font-mono` source `<pre class="ta">`. (Body-only editing, as before —
  the live page below is the preview.)
- **Sticky Save / Cancel bar** (`.editbar`, `position: sticky; bottom: 0`,
  `--shadow-elevated`): a **status** ("● Unsaved changes", `--el-warning` dot) +
  **Cancel** (ghost) + **Save changes** (primary, `i-check-check`). Save persists
  all three fields via a service method (success-response-is-confirmation — no
  whole-tree refresh; the page state IS the optimistic value); `viewerCanManage`-
  gated; the public projection re-reads.

### Panel 1d — edit-mode states (the 6.16.5 / 6.16.4 surfaces)

- **Empty tagline → fallback** — the input shows the "Add a tagline…" placeholder;
  the note states the public hero falls back to the generic i18n line, never a blank
  subtitle.
- **Zero tags** — `.tag-empty` "No tags yet" + the "+ Add tag" button; the public
  hero omits the meta-pill row entirely.
- **Adding a tag** — the "+ Add tag" button has been clicked → a small inline input
  (`.tag-add.input`) with a caret; type + Enter adds the chip, Esc cancels.
- **Saving…** — the Save button shows a `.spin` spinner + "Saving…", both buttons
  disabled (the in-flight, race-guarded write — `CLAUDE.md` E2E-signal rule).
- **Save error** — a rose **`.save-error`** banner ("Couldn't save your changes. …
  your edits are kept", `i-alert` in `--el-danger`) above the bar, with **Cancel** +
  **Retry** (`i-rotate`). Never a raw 500 — a graceful typed error.
- **Unsaved-changes guard** — a **`.guard-dialog`** modal (over a `.guard-scrim`)
  fired on Cancel / navigate-away with pending edits: "Discard unsaved changes?" +
  **Keep editing** (ghost) / **Discard** (`btn-danger`).

---

## Panel 8 — states

- **Empty roadmap** / **empty request list** — the `EmptyState` primitive (glyph
  tile + heading + copy; the list adds a "Submit a request" CTA).
- **Loading skeleton** — `.sk` shimmer cards matching the roadmap-card shape
  (vote block + two text lines), shown while a paginated fetch is in flight.
- **Fetch error** — the `ErrorState` primitive (rose glyph + `triangle-alert` +
  "Couldn't load this project" + a Retry).
- **Rate-limited submit** — a yellow `.rl-banner` (`alarm` glyph, warning hue):
  _"You're submitting a little too fast…"_ + a disabled submit — a graceful typed
  error, **never a raw 500** (6.12.5 throttle precedent from 6.11.4).

---

## Build in public (Story 6.17 · gate 6.17.1) — Panels 10–12

A **presentation + discoverability** layer over the existing `public` access
level (Story 6.12). The model is unchanged: `setAccessLevel('public')` is still
the single mutation, the public projection still strips internal fields, and the
three writes still require sign-in. Story 6.17 only changes how that level is
**named, discovered, confirmed, and signposted**. Three code subtasks, all gated
on this asset (`dependsOn: 6.17.1`, `blocked` until it lands):

### The reframe — "Building in public", not "Public" (6.17.2 · Panels 6 + 11)

- **The make-public control** (Panel 6) renames the first `access-opt` from
  "Public" to **"Building in public"** (`#i-megaphone`, `--el-build-glyph` accent
  glyph), carries a **"Live"** `pill-building` status chip on the selected option,
  and reframes the copy to the build-in-public framing — explicitly noting it is
  "the same `public` access level, presented as a status you can start and stop
  anytime." The other three options (Open / Limited / Private) are unchanged.
  6.17.2 keeps calling the shipped 6.4 `setAccessLevel` with the `public` enum
  value — **reframe the label, never fork the model**.
- **The explainer / confirm** (Panel 11) is a `Modal` (size md) opened from the
  control AND from either entry point (Panel 10). It does NOT flip access on
  open — the mutation fires only on the footer confirm. Body: a lead paragraph
  - a **"What becomes public"** `vis-list` whose rows carry distinct semantic
    glyphs (`yes` = `--el-success` check, `gate` = `--el-info` lock for
    sign-in-to-act, `strip` = `--el-text-faint` eye-off for stays-private), a
    `modal-note` (stop-anytime / requests-kept reassurance), and a Cancel /
    "Start building in public" `btn-primary` footer.

### The discoverable entry point (6.17.3 · Panel 10)

A non-public project gets a **promoted PRIMARY entry** plus two secondary
reinforcements — never a bare dropdown option (the explicit anti-pattern). The
point of 6.17.3 is that turning a project public is a **promoted action, not a
buried setting** (mirror rung 1: Linear / Notion / Vercel surface "Share" /
"Publish" as a persistent top-right header action; GitHub puts repo visibility
front-and-centre — none bury it three clicks into settings).

- **(a) PRIMARY — a persistent project-shell HEADER button** (`.btn-build`). A
  build-tinted action (`--el-build-bg` lavender + `--el-text-strong` + accent
  `#i-megaphone` glyph) in the project header's action row, **always visible to
  admins on every project view** (board / items / roadmap) while the project is
  not public. This is the obvious, promoted home. **It is the SAME header slot
  that shows the "Building in public" status badge once public (6.17.4 · Panel 12)** — so the affordance is stateful (non-public → "Build in public" action;
  public → "Building in public" badge + manage), never buried and never
  duplicated. One click opens the Panel-11 confirm.
- **(b) A dismissible project-shell nudge** (`.nudge`) — a **richer one-time
  prompt** that reinforces the header button with context. A dismissible strip
  (accent left-border, `#i-rocket` lead glyph, title + sub, a "Start building in
  public" `btn-primary`, an `#i-x` `nudge-close`). Shows once to admins; the
  persistent header button (a) remains after it's dismissed.
- **(c) Settings → General promo card** (`.promo`) — the **durable home** for
  details + manage. A bordered card with a soft decorative corner-wash (the same
  `--el-hero-wash-*` tints, text on `--el-page-bg` so AA holds — finding #35), an
  accent-filled `promo-glyph` megaphone, a serif headline + sub, a 3-row
  `promo-bul` what's-shared list, and a `promo-actions` row (**"Start building in
  public"** `btn-primary btn-lg` + a "Learn more" ghost).

All three open the Panel-11 confirm → on confirm, `setAccessLevel('public')` and
the project goes public. (Each placement is rendered inside a dashed `ctx-strip` /
`ctx-wrap` frame in the mock — that frame is mock-only context labelling, NOT a
shipped element.)

### The status badge + stop / manage path (6.17.4 · Panels 1, 2, 12)

- **The badge** is a `pill-building` (lavender `--el-build-bg` + AA-safe
  `--el-build-text` + accent `--el-build-glyph` megaphone) reading **"Building in
  public"**. It appears wherever the project is identified to its team while
  access = `public`: the **authed project-shell header** (Panel 12) and the
  **settings access row** (Panel 12), and the **public visitor chrome** top bar
  (Panels 1–2, reframed from the old "Public" globe chip). It disappears the
  moment building-in-public is stopped.
- **The manage row** (Panel 12) pairs the badge with the live public URL, a
  **"View public page"** outline (`#i-external-link`), and a **"Stop"**
  `btn-danger`.
- **The reverse confirm** (Panel 12) is a warn-toned `Modal` (`modal-glyph.warn`
  yellow `#i-eye-off`): a `vis-list` of what happens (page goes offline · link
  stops working · requests / upvotes / comments **kept** — nothing deleted) + a
  `modal-note.warn` (can restart anytime) + a Cancel / "Stop building in public"
  `btn-danger` footer. Stopping reverts to the project's previous access level.

### The public-state header slot (6.17.6 · Panel 12) — the active "Building in public" indicator, linked to settings

**The bug this closes.** The project-shell header has a single build-in-public
**slot** (the right cluster of `app/(authed)/_components/TopNav.tsx:82`). It
renders the 6.17.3 `BuildInPublicButton` "Build in public" CTA **only when the
project is NOT public** — `app/(authed)/layout.tsx:122-125` nulls
`buildInPublicProjectKey` once `accessLevel === 'public'`. So once a project IS
building in public the slot goes **empty**: the 6.17.3a / 6.17.4 intent (the
SAME slot becomes the status indicator once public) was specified but **never
shipped**. 6.17.6 designs that public state; 6.17.7 builds it.

**The slot is a SINGLE stateful slot — exactly one state, never both, never
empty:**

| Project state          | Slot content                                                     | Who sees it                                                  | Action                               |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------ |
| **not public**         | `.btn-build` **"Build in public"** CTA (6.17.3a)                 | project **admins** (`canManage && accessLevel !== 'public'`) | opens the Panel-11 confirm           |
| **building in public** | the clickable **"Building in public"** status indicator (6.17.6) | **all** team members (`accessLevel === 'public'`)            | links to `/settings/project/members` |

**(a) Reads as a live status first.** The indicator reuses the shipped
`BuildingInPublicBadge` / `pill-building` visual language verbatim: a lavender
`--el-build-bg` chip, AA-safe `--el-build-text` label, accent `--el-build-glyph`
megaphone, `--radius-badge` shape — so the team instantly recognises the same
chip they see in Settings and the public visitor chrome. Status primacy is
deliberate: in the header the first read must be "this project is building in
public **right now**", not "here is a button".

**(b) Is a LINK to the build-in-public settings — form = badge-as-link, not a
button.** The chip is rendered as an `<a href="/settings/project/members">`
(the `BuildInPublicManageRow` home — View public page / Stop). Chosen over a
`btn-build`-style button wrapping the badge because a full button reads as an
_action_ first and would visually compete with the sibling header buttons
(`New`, Create, etc.); a badge-link keeps the **status** reading primary while
still being unambiguously interactive. Interactive affordances on the
`a.pill-building`:

- **trailing settings-gear glyph** (`#i-settings` / lucide `Settings`, muted
  `--el-build-text` at ~0.55 opacity) — signals the click goes to _settings_
  (not the public page; that's the separate `#i-external-link` "View public
  page" affordance in the manage row).
- **hover** — bg shifts toward the accent
  (`color-mix(in srgb, var(--el-accent) 16%, var(--el-build-bg))`), mirroring
  `.btn-build:hover`, with `cursor: pointer`.
- **focus-visible** — a 2px `--focus-ring-color` outline at `2px` offset (the
  app focus-ring token), so keyboard users get the same ring as every control.
- **accessible name** — `aria-label="Building in public — manage"` (visible
  text "Building in public" + the gear's intent spoken once). The gear `<svg>`
  is `aria-hidden`.

**Copy.** Visible label **"Building in public"** (unchanged from 6.17.4 — the
same string the badge already uses). Accessible name **"Building in public —
manage"**. No new visible string; the en/zh `settings.buildInPublic.statusBadge`
key already supplies the label, and the "— manage" suffix is an
`aria-label`-only addition (6.17.7 wires it, e.g. a
`settings.buildInPublic.manageAriaLabel` or composed from the existing label).

**(c) Visibility / admin-gating decision — ALL team members see the indicator
and ALL get the link; the destructive control stays admin-only IN settings.**
Unlike the non-public CTA (gated `canManage` server-side, because only an admin
can turn a project public), the public-state indicator is shown to **every team
member who can see the shell while `accessLevel === 'public'`** — no `canManage`
read in the header — and the link routes everyone to
`/settings/project/members`. The manage/stop page is itself role-aware: it
already shows non-admins the badge + "View public page" **read-only** and gates
only **Stop** behind `assertCanManage` (`ProjectMembersSettings.tsx`
`BuildInPublicManageRow`, `canManage ? <Stop/> : null`). So a non-admin clicking
the indicator lands on a legible read-only manage view, never a permission wall.

- _Mirror justification (rung 1)._ GitHub surfaces a repo's **Public** badge to
  every collaborator in the repo header and links visibility management from
  Settings (where the change-visibility control is itself permission-gated);
  Linear and Notion show a **Published / public** status indicator to the whole
  workspace in the top bar and route any member's click to the share/visibility
  settings, where the destructive un-publish is role-gated. None hide the
  _status_ by role; all gate the _control_ at the destination. Motir matches:
  status visible to the team, control gated in settings. This also keeps the
  header gating simpler than the CTA's — a pure `accessLevel === 'public'`
  check, no capability read.

**For 6.17.7 (the code subtask this gates).** The slot logic moves from
"render the CTA only when `buildInPublicProjectKey`" to a two-state slot:
`layout.tsx` should additionally pass the public-state signal (e.g. the active
project's key when `accessLevel === 'public'`, ungated by `canManage`) so
`TopNav` renders the linked indicator; the CTA path (admin + non-public) is
unchanged. The indicator is a plain `<a>` (no client state) so it can stay in
the server-rendered `TopNav`. Reuse `BuildingInPublicBadge` for the visual,
wrapping it in the link + gear (or add a small `BuildingInPublicHeaderLink`
that composes it).

## Public work-item DETAIL page (Story 6.14 · gate 6.14.12) — `public-item-detail.mock.html`

The read-only PUBLIC work-item detail page at `/p/[identifier]/items/[key]` — the
page a public/non-member viewer lands on from a board card, an items-list row, or
a tree node. **A separate asset** (`public-item-detail.mock.html`) because it is a
later addition: `public-projects.mock.html` drew its cards as "navigable to the
read-only work item" but never built that destination (`PublicWorkItemList.tsx`
left the rows as non-links — "6.12.4 has no public work-item DETAIL route (that's
a later card)"). It reuses **the same public chrome** (`.pub-topbar` /
`.pub-banner` / `.seg` sub-bar nav — incl. the **Tree** tab added by 6.14.10) and
the **same stripped public projection** (NO assignee / estimate / story points /
internal comments) as the rest of this area, and it reconciles with the
just-shipped **6.14.10 public tree** (the child-row grammar matches
`PublicWorkItemTree` / `PublicWorkItemList`). The detail/child-panel/sidebar
layout + the privacy placeholder reuse `design/epic-privacy/` (panels 3 + 5)
verbatim.

It is the host surface for two code subtasks: **6.14.11** (build the page) and
**6.14.6** (the private-epic child-panel placeholder, rendered on it).

### Panel 1 — normal EPIC detail (public viewer)

- Public chrome on top. **Header:** `IssueTypeIcon` (epic, `--el-type-epic`, lucide
  `zap`) + the mono identifier + serif title + a status `Pill`. **No edit
  affordances** (read-only) — the distinguishing difference from the authed
  `/issues/[key]` detail page.
- **Body:** a public-safe description (`.motir-prose`); the public projection
  strips internal fields, so no assignee / estimate / points anywhere.
- **Child issues panel** (`Card` + `SectionLabel`): a list of public-safe child
  rows, each an `<a>` navigable to its OWN `/p/.../items/<key>` detail —
  `IssueTypeIcon` (kind hue) + key + title + status `Pill`, the SAME stripped row
  grammar as the public board/list/tree. No nested interactive (the row is the
  only control).
- **Sidebar** (`Card`): Status, Type = Epic, Children = N (a plain count — for a
  NON-private epic the child set is public, so the count is public-safe).

### Panel 2 — private EPIC detail (public / non-member viewer) — the 6.14.6 target

- Same chrome + header, but the header carries the lavender **"Not public"**
  `Pill` (lock glyph; `--el-tint-lavender` / `--el-text-strong`, the AA recipe).
- **Child issues panel → the centered `EmptyState`** (lucide `eye-off` ~40px,
  `--el-text-muted`): title **"This epic is not public"**, subtext **"The project
  admin has kept this epic's contents private."** (exact copy shared 1:1 with
  `design/epic-privacy/` panels 2/3). **No child rows in the DOM** — the 6.14.4
  server projection has already excluded them (no-leak), so the UI renders the
  placeholder off the `childrenHidden` marker with no child in the payload.
- **Sidebar:** Children → **"Hidden"**, Progress → **"Hidden"** (italic
  `--el-text-secondary`) — the stripped aggregate tells.

### Panel 3 — non-epic (story) detail (public viewer)

- Same shape with a story `IssueTypeIcon` (`--el-type-story`); sidebar shows
  Type = Story and a **Parent** link back to its epic's detail. A non-epic with
  children renders the same child-issues panel — the placeholder/marker logic is
  epic-only (privacy is an epic-level flag), so a story always shows its children.

### Panel 4 — states

- **Empty** — an epic with zero (real, non-private) children → an `EmptyState`
  (lucide `inbox`) with title **"No child issues yet"** / **"This epic has no
  stories or tasks yet."** — deliberately DISTINCT copy + glyph from the private
  `eye-off` placeholder, so "private" never reads as "empty".
- **Loading** — `.sk` shimmer skeleton (header + a few child rows).
- **Error** — the `ErrorState` shape (lucide `triangle-alert`, `--el-danger`):
  **"Couldn't load this item. Try again."** + a Retry button.
- **Not found / not public** — a centered `EmptyState` (lucide `lock`): **"This
  item isn't available"** / **"It may be private or may not exist."** A non-public
  item/project 404s (no existence leak), so the page degrades to this, never a raw
  error.

---

## In-place (modal) sign-in / sign-up (MOTIR-1557 · gate for MOTIR-1558) — `public-signin-modal.mock.html`

**The model change this asset designs.** Today the public project page authenticates by a
**full-page navigation to `/sign-in`** (the shipped "sign-in-to-act" model — the sign-in-to-act
copy above + the full-page auth screens in `design/auth/`). **MOTIR-1558** wants to authenticate
**without leaving the public page** — an **in-place modal** launched from the existing `PublicTopBar`
CTAs. An in-place modal is a **MODEL change** from the designed full-page flow, and **no design
depicted a public-page sign-in modal**, so this design pass runs BEFORE the code (design gate;
`notes.html` #31; design-against-shipped-reality). It is carved out of **MOTIR-990** ("Better UX for
sign-in in public project page", problem #2). Its own asset (`public-signin-modal.mock.html`) rather
than a panel bolted onto `public-projects.mock.html`, because it composes the **auth** area, not the
public-project chrome — the same separate-asset pattern as `public-item-detail.mock.html`.

**Designed against shipped reality (`notes.html` #31 / MOTIR-1196 — reuse the real component, never a
stand-in).** The modal does NOT redraw a stylized auth form. It wraps the **REAL shipped auth
content**, mirrored 1:1 (markup, primitives, tokens, copy) from the already-shipped screens — I read
each before drawing, and grounded the panels in the shipped `design/auth/` renders:

- `app/(auth)/sign-in/page.tsx` — the **two-step** email→password flow (step `email`: Google + email
  - Continue; step `password`: read-only email recap with **"Use a different email"**, **"Forgot
    password?"** ABOVE the field per the Clay pattern, password `Input` with a show/hide eye addon,
    Continue). The wrong-password inline error is `Input`'s `error` state (Panel 6a).
- `app/(auth)/sign-up/page.tsx` — the two-step identity→create-password flow (email helper **"We'll
  use this to sign you in."**; the create-password field's **"At least 8 characters."** helper; the
  email-exists inline path; recap **"Edit"** on step 2).
- `app/(auth)/_components/AuthShell.tsx` — the serif headline + subhead header, and the `OrDivider`
  - `FormAlert` primitives (reused verbatim; `FormAlert` is the top-of-form alert for an OAuth/Google
    failure).
- `app/(auth)/_components/GoogleButton.tsx` — **"Continue with Google"** (a `Button` `secondary`
  `lg`, full-width) with the **official multi-colour Google G** brand glyph inlined (the shipped
  component inlines the same trademark paths — the one raw-hex exception, a third-party logo, not a
  UI element colour).
- `components/ui/Modal.tsx` (`@motir/design-system`) — the shell. **Radix-portaled**, so the dialog
  escapes the public shell card's `overflow-hidden`; `contentVariants` **size `md`**
  (`max-w-[28rem]`), `rounded-(--radius-modal)`, `bg-(--el-page-bg)`, `shadow-(--shadow-modal)`,
  border, `p-(--spacing-card-padding)`, the corner `×` close, `max-h-[90vh]` + scroll. The auth
  headline renders INSIDE the dialog body (not via the `title` prop) with `srTitle` for the
  accessible name — the same pattern the 2.5.19 quick-view peek uses.

**Access path (draw the door).** The entry affordance is the **existing `PublicTopBar` "Sign in"
(ghost) / "Start free" (primary)** buttons — they now **open the modal in place** instead of
navigating (`<Link href="/sign-in">` → an on-click that opens the dialog). Panel 1 draws the topbar
with both CTAs ringed. "Sign in" opens the sign-in modal; "Start free" opens the sign-up modal.

**Behaviour specified.**

- **Email + password authenticates IN PLACE**, then **closes the modal + `router.refresh()`** — the
  visitor STAYS on the public project page, now able to upvote / comment / submit. No full-page
  navigation. (Page-state: the public page is server-rendered; a `router.refresh()` re-reads it with
  the new session so the sign-in-to-act prompts flip to the live controls — the CLAUDE.md
  page-state-after-mutation contract, server-surface branch.)
- **Google OAuth inherently REDIRECTS** (Better-Auth → Google consent → `/api/auth/callback/google`
  → back). It **cannot be fully in-place**; the code sets **`callbackURL` to the CURRENT public path**
  so the visitor lands back on the same public page. This caveat is stated in the notes, not hidden —
  only the email/password path is truly in-place.
- **Sign in ↔ Start free** swap the modal **content in place** (the cross-links inside the modal —
  "Don't have an account? Sign up" / "Already have an account? Log in" — flip the dialog's mode, no
  navigation).
- **Mobile** (Panel 7): the **same centered Radix dialog**, near-full-width via the shipped Modal's
  `w-[90vw]`, sitting low on the tall viewport. **Decision: a centered dialog, NOT a new bottom-sheet
  variant** — the shipped `Modal` already caps at `max-h-[90vh]` and scrolls, so no new primitive is
  needed; a bottom-sheet would fork the Modal for one call site.
- **States** (Panel 6): (a) wrong password → `Input` danger + the inline **"That password isn't
  right. Try again, or reset it."** (no account enumeration); (b) Google **"Connecting…"** / email
  step **"Checking…"** → the `Button` `loading` spinner; a Google/OAuth failure surfaces as the
  top-of-form `FormAlert`; (c) **already-signed-in** edge → the modal shows the identity + a single
  Continue (no auth form).

**Decisions I made (no design subtask asks the user — resolved from the ladder; flagged for review at
the design-approval gate):**

1. **The "Plan with AI" onboarding door is OMITTED from the modal.** The shipped `/sign-in` page
   carries a "Have a project idea? → Plan with AI" secondary footer that navigates to `/onboarding`
   (the start-fresh front door). In a modal whose entire purpose is **sign-in-to-act on THIS public
   project**, a control that navigates AWAY to onboarding contradicts the in-place intent — so the
   modal is scoped to authentication, and the onboarding front door stays on the full `/sign-in`
   page. (Rung-1 mirror: GitHub / Canny / Linear in-context auth modals show only auth, never a
   "start a new project" door.)
2. **The full-page `/sign-in` + `/sign-up` routes REMAIN.** The modal is **additive** — deep links,
   the onboarding front door, and Better-Auth's `?error=` OAuth bounce-back all still land on the
   full pages. MOTIR-1558 adds the in-place path for the public page; it does not remove the routes.
3. **Headline scale.** `AuthShell`'s headline is `text-4xl/5xl` on the full page; inside a compact
   `md` dialog it renders at a modal-appropriate serif size (~27px desktop / ~23px mobile) — the one
   deliberate adaptation from the full-page markup, so the headline doesn't dominate the 448px panel.

**Panels (review EACH — mistake #31):** (1) the **access path** — `PublicTopBar` Sign in / Start
free; (2) **sign-in · step 1** (email) over the dimmed page; (3) **sign-in · step 2** (password —
recap + Forgot + show/hide); (4) **sign-up · step 1** (identity); (5) **sign-up · step 2** (create
password); (6) **states** (wrong-password / connecting-submitting / already-signed-in); (7)
**mobile** (centered dialog at phone width).

**Copy (the real `messages/en.json` → `auth.*`; en + zh both already ship — MOTIR-1558 adds no new
strings):** **"Welcome back!"** / **"Use Motir to turn any product idea into reality."** ·
**"Continue with Google"** / **"Connecting…"** · **"OR"** · **"Email address"** / **"Continue"** /
**"Checking…"** · **"Don't have an account?" "Sign up"** · **"Signing in as {email}"** / **"Use a
different email"** · **"Forgot password?"** / **"Password"** / **"Show password" / "Hide password"** /
**"Signing in…"** · wrong password **"That password isn't right. Try again, or reset it."** ·
**"Welcome to Motir!"** / **"Sign up to turn any product idea into reality."** · **"We'll use this to
sign you in."** · **"Create a password"** / **"At least 8 characters."** / **"Create account"** /
**"Creating account…"** · **"Already have an account?" "Log in"** · **"An account with this email
already exists." "Sign in instead →"** · Google failure (`FormAlert`) **"Google sign-in didn't
complete. Try again, or use email."**

**Colour + shape roles (all via `--el-*` / shape tokens — no Tier-0, no invented hue except the
Google brand G):** the dialog panel = `--el-page-bg` + `--el-border` + `--shadow-modal` +
`--radius-modal`; the Radix overlay scrim = **`--el-overlay-scrim`**; the serif headline `--el-text`,
subhead `--el-text-muted`; the primary CTA = `--el-accent` / `--el-accent-text` (`--radius-btn`,
`--height-btn-lg`); the Google button = `secondary` (`--el-button-border` border,
`--el-text`); `Input` = `--el-input-border` + `--el-page-bg`, focus ring `--focus-ring-color`, addon
icon `--el-icon-field`, danger `--el-danger`; the email recap box = `--el-surface`; `OrDivider` line
`--el-border` / label `--el-text-muted`; `FormAlert` = `color-mix(--el-danger 12%, transparent)` bg +
`--el-danger` text/glyph; cross-links `--el-link`; the close `×` = `--el-icon-muted`; the
already-signed-in avatar = `--el-tint-lavender` + `--el-text-strong` (the AA recipe). **No new
`--el-*` tokens** — the modal reuses the shipped auth + Modal tokens verbatim.

**Primitives composed (no hand-rolling):** `Modal` (the shipped `components/ui/Modal.tsx`, size `md`)
· `Button` (primary / secondary + the `loading` state) · `Input` (email / password, addon icons +
show/hide eye + error) · the `AuthShell` header / `OrDivider` / `FormAlert` · `GoogleButton` · the
initial-letter `Avatar` (signed-in state). The only NEW arrangement is the **composition** of these
into a dialog — not a new primitive.

---

## Colour roles (every colour via `--el-*` — no Tier-0 `--color-*`)

| Element                                    | Token                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Public chip / banner background            | `--el-public-banner-bg` (→ `--color-tint-sky`)                                                                               |
| Public chip / banner text                  | `--el-public-banner-text` (→ `--color-charcoal`, AA ~10:1 on the sky tint)                                                   |
| Public-chip / banner glyph                 | `--el-info`                                                                                                                  |
| Upvote control (resting)                   | `--el-page-bg` + `--el-border`; count text `--el-text-strong`                                                                |
| Upvote control (voted)                     | `--el-vote-active-bg` (→ `--color-primary`) + `--el-vote-active-text`                                                        |
| Roadmap status headers                     | `--el-roadmap-{submitted,planned,progress,done}` (→ peach / lavender / sky / mint)                                           |
| Status header / org text                   | `--el-text-strong` on the tint (AA-safe)                                                                                     |
| Work-item type icon (board/kind)           | `--el-type-{task,bug,story,epic}`                                                                                            |
| Priority pills                             | rose (`--el-tint-rose`+`--el-danger` glyph) / yellow / neutral, text `-strong`                                               |
| Selected access option                     | `--el-accent` border + `color-mix(--el-accent 7%)` tint                                                                      |
| Disable link button                        | `btn-danger` (`--el-tint-rose` bg + `--el-text-strong`, `--el-danger` glyph)                                                 |
| Rate-limit banner                          | `--el-tint-yellow` + `--el-text-strong`, `--el-warning` glyph                                                                |
| Success confirmation badge                 | `--el-tint-mint` + `--el-success`                                                                                            |
| Error glyph                                | `--el-tint-rose` + `--el-danger`                                                                                             |
| Overview hero corner washes                | `--el-hero-wash-a` (→ lavender) + `--el-hero-wash-b` (→ sky), over `--el-page-bg`                                            |
| Hero logo / CTA card accent                | `--el-accent` + `--el-accent-text`; stats text `--el-text` (serif)                                                           |
| README feature-list ticks                  | `--el-success`; links `--el-link`                                                                                            |
| "Building in public" badge (6.17)          | `--el-build-bg` (→ lavender) + `--el-build-text` (charcoal, AA), `--el-build-glyph` (accent) megaphone                       |
| Promoted header button `.btn-build` (6.17) | `--el-build-bg` + `--el-text-strong`, `--el-build-glyph` megaphone; hover `color-mix(--el-accent 18%)`                       |
| Entry-point promo glyph / CTA (6.17)       | `--el-accent` fill + `--el-accent-text`; promo wash = `--el-hero-wash-*` over `--el-page-bg`                                 |
| Shell nudge accent (6.17)                  | `--el-accent` left-border + lead glyph, on `--el-surface-soft`                                                               |
| Explainer "becomes public" list (6.17)     | `yes` `--el-success` · `gate` `--el-info` · `strip` `--el-text-faint` glyphs                                                 |
| Stop-confirm warn glyph / note (6.17)      | `--el-tint-yellow` + `--el-warning` (`modal-glyph.warn`, `modal-note.warn`)                                                  |
| Edit-page affordance glyph (6.16)          | `--el-accent-on-surface` on a `btn-outline`                                                                                  |
| Admin hint band (6.16)                     | `color-mix(--el-accent 7%, --el-page-bg)` bg + `--el-border`, text `--el-text-secondary`                                     |
| "Editing" mode chip (6.16)                 | `color-mix(--el-accent 9%)` bg + `color-mix(--el-accent 32%)` border + `--el-accent-on-surface` text; live dot `--el-accent` |
| Tagline input focus ring (6.16)            | `--el-accent` border + `color-mix(--el-accent 18%)` ring                                                                     |
| Editable tag chip + remove ✕ (6.16)        | tint bg + `--el-text-strong`; `.tag-x` = `color-mix(--el-text-strong 12%)`                                                   |
| Unsaved-changes status dot (6.16)          | `--el-warning`                                                                                                               |
| Save-error banner (6.16)                   | `--el-tint-rose` bg + `--el-text-strong`, glyph `--el-danger` (finding #35)                                                  |
| Unsaved-guard scrim / dialog (6.16)        | `color-mix(--el-text 28%)` scrim; dialog `--el-page-bg` + `--shadow-modal`                                                   |

**Palette, not grey-only (finding #54):** the roadmap uses four distinct status
tints, the upvote uses the accent, kinds use their type hues, the Overview hero +
CTA cards use the accent washes + mint/neutral meta pills — the screen is not
collapsed to grey + primary. The hero washes are **decorative**: all text sits on
`--el-page-bg`, never on the wash, so AA holds (finding #35 — no page-tint text).

**New `--el-*` tokens 6.12.4 / 6.12.6 / 6.12.7 must ADD to `globals.css` Tier 3**
(each mapped to an existing Tier-0 value, per the per-component token-growth
pattern, mistake #20): `--el-public-banner-bg`, `--el-public-banner-text`,
`--el-vote-bg`, `--el-vote-active-bg`, `--el-vote-active-text`,
`--el-roadmap-submitted`, `--el-roadmap-planned`, `--el-roadmap-progress`,
`--el-roadmap-done`, **`--el-hero-wash-a`, `--el-hero-wash-b`**. Consume the
`--el-*` token, never the Tier-0 value directly. **Story 6.17 adds three more**
(6.17.2/6.17.4): **`--el-build-bg`** (→ `--color-tint-lavender`),
**`--el-build-text`** (→ `--color-charcoal`, AA ~10:1 on the lavender tint), and
**`--el-build-glyph`** (→ `--color-primary`, the megaphone accent) — the
"Building in public" status badge + the reframed access option. Same growth rule:
add to Tier 3, consume via `--el-*`. **Story 6.17.6 adds NO new tokens** — the
public-state header indicator reuses the same three build tokens (`--el-build-bg`
chip / `--el-build-text` label + trailing gear at ~0.55 opacity / `--el-build-glyph`
megaphone), `color-mix(--el-accent 16%, --el-build-bg)` for hover (mirroring
`.btn-build:hover`), and `--focus-ring-color` for the focus ring — all already in
the swap layer; shape is `--radius-badge` (it IS the badge).

**Story 6.16 adds NO new `--el-*` tokens** — the in-place editing surfaces reuse
existing tokens (`--el-accent` / `--el-accent-on-surface`, `--el-tint-lavender/mint/rose`,
`--el-warning` / `--el-danger`, `--el-border-strong`), with `color-mix(… --el-* …)`
for the accent-tint hint band, focus ring, and scrim — so the swap layer still
governs them and no Tier-0 leaks in.

## Shape roles (every shaped surface via the `[data-display-style]` tokens)

- **Cards** (board card, roadmap card, request card, access option, state box,
  dedupe block): `--radius-card` + `--shadow-subtle`/`-card`; card padding
  `--spacing-card-padding`.
- **Buttons**: `--radius-btn`, `--height-btn-sm`/`-md`, `--spacing-btn-x/y`.
- **Pills / chips**: `--radius-badge`, `--spacing-chip-x/y`.
- **Inputs / textarea / link field**: `--radius-input`, `--height-input`,
  `--spacing-input-x/y`.
- **Upvote control, segmented options, status header, editor toolbar buttons**:
  `--radius-control`.
- **Hero / overview sidebar cards / CTA card / editor**: `--radius-card` (editor
  `--radius-input`) + `--shadow-card`/`-subtle`.
- **In-place edit (6.16)**: tagline input `--radius-input` + `--spacing-input-*`
  (multi-line, `min-height` ≈ 1.7×`--height-input`); editable tag chips + "Add tag" `--radius-badge` +
  `--spacing-chip-y`; in-place `MarkdownEditor` `--radius-input`; the sticky
  `.editbar` `--radius-card` + `--shadow-elevated`; the unsaved-guard dialog
  `--radius-modal` + `--shadow-modal`; the `.tag-x` remove control is genuinely
  circular (`rounded-full`).
- **Avatars / radio / status dots**: `rounded-full` (genuinely circular — allowed).

No raw `rounded-*` / `p-*` / `h-*` / `shadow-md` on any shaped surface (the shape
swap layer must reach every element).

## Copy index (the strings 6.12.4–6.12.8 wire to i18n; en + zh both)

- Public chip: **"Public"** · banner: **"You're viewing a public project. Anyone
  signed in to Motir can view it and submit, upvote, or comment on requests."** ·
  **"View-only — you can't edit work items"**.
- Nav: **"Overview" / "Board" / "Work items" / "Roadmap"** · **"Submit a request"**.
- Overview: meta pills **"Vibe project" / "Open source" / "GPL-3.0" /
  "MCP-native"** · CTAs **"View the roadmap" / "Submit a request" / "GitHub"** ·
  stat labels **"Public requests" / "Upvotes" / "Planned" / "Shipped"** · sidebar
  **"Links"** (**"Website" / "Documentation" / "Source (GPL-3.0)" / "Changelog"**)
  · **"At a glance"** · CTA card **"Have an idea?"** / **"Tell us what to build
  next. It takes a minute and goes straight to the team."** The body is the
  admin-authored `publicOverviewMd` (not fixed product copy) — but **Motir's OWN
  project seeds a canonical README** with two beats. **Tagline:** _"Vibe your
  whole project. Bring an idea — Motir's three AI layers plan it, track it, and
  ship it, end to end. You're looking at Motir, built in Motir."_ **Part 1 (the
  self-improving loop):** _"You're looking at Motir, inside Motir"_ + _"A
  self-improving loop — and you're in it"_ + the 4-step loop
  [submit → triage → plan → agent PR → ships as Done]. **Part 2 ("Vibe project" —
  the headline idea, by analogy to vibe coding):** _"You've heard of vibe coding —
  describe what you want, and the AI writes the code. A vibe project takes that to
  the whole project: not just the code, but the design, the marketing, the legal,
  the research — everything it takes to ship…"_ + the three layers (**An AI
  planner** → chat to a structured plan, work items of every kind (design /
  marketing / legal / engineering); **An AI-native project manager** →
  boards/sprints/system of record, **MCP-native** so your agents read/write Motir
  directly; **A hosted coding agent** → picks up the engineering work items and
  ships the code) + _"Motir plans, tracks, and ships the whole thing — code and
  everything around it. That's a vibe project."_ Then **"Contribute"**. NOT framed as "AI project
  management" — it's the three-layer, end-to-end pipeline. This canonical copy is
  seeded onto the `motir` project's `publicOverviewMd` (see story-6.12.ts § 6.12.4
  - the seed loader), so the live tenant renders it. **Story 6.16: Motir's "Vibe
    your whole project…" line is seeded into `publicTagline` (not the body top), and
    its tags into `publicTags`** (6.16.7).
- **In-place editing (6.16)** — Settings "Page content" row:
  **"Hero & overview"** · **"Edit the tagline, tags, and README right on the public
  page — what you change is what visitors see."** · **"Edit on the public page →"** ·
  _"Opens the public Overview with the on-page editor. Available while the project is
  public; the link is hidden otherwise."_ · admin affordance: **"Edit page"** + hint
  _"You manage this project. Hit **Edit page** to change the tagline, tags, and
  overview right here on the public page — what you edit is what visitors see."_ ·
  edit mode: **"Editing"** (pill) · banner **"Editing the public page. Changes show
  live as you type…"** · field labels **"Tagline" / "Tags" / "Overview (README ·
  Markdown)"** · tagline placeholder **"Add a tagline…"** · tags **"Add tag" / "No
  tags yet" / "N / 8 tags"** · save bar **"Unsaved changes" / "Cancel" / "Save
  changes"** · saving **"Saving…"** · save error **"Couldn't save your changes.
  Check your connection and try again — your edits are kept." / "Retry"** · fallback
  tagline (unset) **"Track work, plan sprints, and ship — the open project
  manager."** · unsaved guard **"Discard unsaved changes?" / "You've edited the
  tagline, tags, or overview but haven't saved. Leaving now discards those
  changes." / "Keep editing" / "Discard"**.
- Roadmap buckets: **"Submitted" / "Planned" / "In progress" / "Done"** ·
  **"Load N more →"**.
- Submit: **"Submit a request"** · **"Tell the Motir team about a bug or a feature
  you'd like."** · type **"Feature" / "Bug"** · **"Title"** / **"Description"**
  (placeholder **"What should it do, and why does it matter to you?"**) ·
  **"Submitted as {name} ({org}) — your account is attached for follow-up."** ·
  **"Submit request"**.
- Dedupe: **"N existing requests look similar — upvote one instead of creating a
  duplicate?"** · **"Upvote this"** · **"Not the same? Continue and submit as
  new →"**.
- Confirmation: **"Thanks — we got it"** · **"Your request landed in the team's
  triage queue. You'll see it on the public roadmap once they review it. We'll
  attribute it to your account."** · **"View roadmap" / "Submit another"**.
- Request detail: **"opened by {name}"** · **"N comments"** · composer placeholder
  **"Add a comment…"** · **"Comment"**.
- Access levels: **"Building in public"** (reframed from "Public" by 6.17.2;
  badge label **"Live"**) — _"Publish the project to the web as a build-in-public
  page — anyone can follow the board, roadmap, and work items (no account needed,
  indexable by search engines). Visitors sign in only to submit, upvote, or
  comment; they can't edit anything else. This is the same `public` access level,
  presented as a status you can start and stop anytime."_ · **"Open"** —
  _"Any member of this workspace can view and edit."_ · **"Limited"** — _"Any
  member of this workspace can view and comment, but not edit."_ · **"Private"** —
  _"Only people added to this project can see it."_
- Share link: **"Public link"** · **"Copy" / "Rotate" / "Disable"** · note: _"The
  link points to the public project — anyone can open it with no sign-in, and the
  page is server-rendered + crawlable (SEO/GEO). Visitors sign in only to submit,
  upvote, or comment. Rotating issues a new link and retires the old one; the
  project key (PROD) doesn't change."_
- Sign-in-to-act (logged-out write surfaces): **"Sign in to comment"** /
  **"Sign in to upvote"** / **"Sign in to submit a request"** — _"reading is open
  to everyone; posting needs a Motir account."_ + **"Sign in"**.
- SEO/GEO panel (9): **"Built to be found — by search engines and by AI"**; facts —
  **"Fully public — no sign-in to read; crawlable by Googlebot, Bingbot, GPTBot."**
  / **"Sign-in is needed ONLY to submit / upvote / comment."** / **"Internal
  fields stay stripped by the public projection."**
- States: **"Nothing on the roadmap yet"** / **"No requests yet"** / **"Be the
  first — submit a bug or feature request for this project."** / **"Couldn't load
  this project"** / **"You're submitting a little too fast. … Your draft is
  saved."** / **"Retry" / "Keep editing"**.
- Build in public — status badge (6.17.4): **"Building in public"** (+ short form
  **"Live"** on the access option). Public-state header indicator (6.17.6): same
  visible label **"Building in public"**, accessible name **"Building in public —
  manage"** (the slot links to `/settings/project/members`). Promoted header
  button (6.17.3): **"Build in public"** (compact label on the persistent
  project-header `.btn-build`).
  Entry-point promo (6.17.3):
  **"Build this project in public"** · **"Turn the project into a public
  build-in-public page."** · bullets **"Share your board, roadmap, and work items
  with anyone — no account needed, indexable by search engines."** / **"Let people
  submit, upvote, and comment on requests (they sign in only to act)."** /
  **"Internal fields stay private — assignees, estimates, and internal comments
  are never shown."** · **"Start building in public"** (CTA) · **"Learn more"**.
  Shell nudge: **"Want eyes on your work?"** · **"Build this project in public —
  share the roadmap and collect requests."** · **"Start building in public"**.
  Start explainer (6.17.2): **"Start building in public?"** · _"Your project
  becomes a public page anyone on the web can open — no account needed, and search
  engines can index it. Here's exactly what changes:"_ · **"What becomes public"**
  · **"Your board and roadmap — status, progress, and what's shipping."** /
  **"Your work items — titles, types, and descriptions, crawlable by search
  engines."** / **"Visitors sign in only to submit a request, upvote, or comment —
  they can't edit anything."** / **"Stays private: assignees, estimates, and
  internal comments are never shown."** · _"You can stop building in public
  anytime — the page goes offline and the public link stops working. Submitted
  requests and upvotes are kept."_ · **"Cancel" / "Start building in public"**.
  Manage / stop (6.17.4): **"View public page" / "View" / "Stop"** · Stop confirm:
  **"Stop building in public?"** · _"The project goes back to its previous access.
  Here's what happens:"_ · **"The public page goes offline — visitors and search
  engines can no longer open it."** / **"The public link stops working until you
  build in public again."** / **"Submitted requests, upvotes, and comments are
  kept — nothing is deleted."** · _"You can start building in public again anytime
  from Settings."_ · **"Cancel" / "Stop building in public"**.

## Primitives composed (no hand-rolling)

`Card` · `Button` (primary / outline / ghost / danger-tinted) · `Pill` (neutral +
tint tones + the public chip + the "Building in public" `pill-building` status
chip) · `Modal` (the build-in-public start + stop confirm/explainer dialogs — the
shipped `components/ui/Modal.tsx`, size md, no new primitive) · `IssueTypeIcon`
(kind hue via `--el-type-*`) ·
`Avatar` (initial-letter) · `Segmented` (the view nav + the type toggle) ·
`FormField` + `Input` + `Textarea` (the submit form + comment composer) ·
`MarkdownView` (the Overview README render) · `MarkdownEditor` (the **in-place**
README editor, Story 6.16) · `Input` (the tagline inline input + the add-tag
input) · `EmptyState` / `ErrorState` (the state panels) · the loading
`Spinner`/skeleton · the board `.col`/`.bcard` grammar from `design/boards`. The
upvote control is the one NEW composite (a bordered `--radius-control`
chevron+count) — it is not a new primitive vocabulary, just an arrangement of an
icon + a number + the tokens; it maps to a small `components/ui` control 6.12.6
adds. The Overview hero is likewise a NEW arrangement (logo + serif heading +
pills + CTA row + stat strip), not a new primitive. Story 6.16's editable tag
chips (a `Pill` + a circular remove control) and the sticky `.editbar` are
arrangements of existing primitives, not new vocabulary. The build-in-public
entry-point **promo card** and **shell nudge** (6.17.3) are likewise arrangements
of existing primitives (`Card` + accent glyph + serif heading + bullet list +
`Button`s; an accent-bordered strip + glyph + `Button` + close), not new
primitive vocabulary.

## Planning delta (this design iteration adds scope — reflected in the seed)

The Overview/README is new product scope, so the plan seed (Story 6.12) is updated
alongside this asset so the design is not orphaned:

- **`publicOverviewMd` — a new nullable `project` Markdown field.** Lands in
  **6.12.3** (the schema + access card) so the migration is coherent; it is a
  public-safe field in the public projection.
- **Render** the Overview tab as the default public landing — **6.12.4** (uses
  `MarkdownView`; empty → the auto-intro fallback).
- **Author** it in project settings via `MarkdownEditor` — **6.12.8** (alongside
  the make-public toggle + share link; project-admin-gated, inline-save).
- No new subtask is required — the three existing UI/schema cards absorb it; the
  story's scope line + model gain the Overview. (Mirror rung 1: GitHub repo README
  on the repo home; Canny / Productboard / Plane / OpenProject public overviews.)

**Story 6.16 — authorable hero + in-place editing (this iteration).** The plan is
already seeded; this asset is its design gate. The owning subtasks:

- **`publicTagline` (string) + `publicTags` (string[]) — new nullable `project`
  fields.** Schema + migration in **6.16.2**; threaded through the read projection +
  the write path + a **`viewerCanManage`** flag in **6.16.3**.
- **Render** the authorable tagline + tags (i18n / empty fallbacks) in the hero —
  **6.16.4** (this asset, Panel 1).
- **The on-page admin "Edit page" affordance + in-place edit** (tagline + add/remove
  tags + README body via `MarkdownEditor`, sticky Save/Cancel, all states) —
  **6.16.5** (Panels 1b/1c/1d).
- **Remove the in-settings Overview editor → link to the on-page editor** — **6.16.6**
  (Panel 6; retires Panel 7).
- **Seed** Motir's tagline + tags into the fields; drop the "Vibe…" line from the
  body — **6.16.7**. **E2E** — **6.16.8**.
  (Mirror rung 1: Notion / GitHub-profile / Canny / Linear / Productboard edit their
  public pages IN PLACE, not in a buried settings sub-view.)

## Context refs

- `scripts/plan-seed/data/story-6.12.ts` — the locked model + the subtask DAG.
- `scripts/plan-seed/data/story-6.16.ts` (MOTIR-774 · 6.16.1–6.16.8) — the
  authorable-hero + in-place-editing DAG this asset gates.
- `app/(public)/_components/PublicOverviewHero.tsx` — the shipped hero this redesign
  makes authorable (today: hardcoded `autoIntroTagline` + four i18n pills).
- `components/ui/MarkdownEditor.tsx` · `components/ui/Input.tsx` · `components/ui/Pill.tsx` ·
  `components/ui/Button.tsx` — the primitives the in-place editor composes.
- `scripts/plan-seed/data/story-7.0.ts` § 7.0.1 — the multi-panel design-card
  shape mirrored.
- `scripts/plan-seed/data/story-6.11.ts` § 6.11.1 (`design/triage/`) — the triage
  submission-surface design the submit form composes with.
- `design/boards/board.mock.html` + `design/boards/design-notes.md` — the board
  card the public board projects (minus assignee / estimate / grip).
- `scripts/plan-seed/data/story-6.4.ts` — the shipped `ProjectAccessLevel` +
  `projectAccessService` the four-level control extends.
- Canny (https://canny.io/use-cases/feature-request-management) — the
  status-column roadmap + vote count + "upvote the existing request" + dedupe.
- Productboard portal
  (https://support.productboard.com/hc/en-us/articles/360056315454) — the public
  portal + share-link + status-roadmap shape.
- `components/ui/*`, `app/globals.css` (the `--el-*` + `[data-display-style]`
  token layers), `motir-core/CLAUDE.md` § colour + shape tokens.
- **In-place sign-in modal (MOTIR-1557):** `app/(auth)/sign-in/page.tsx` ·
  `app/(auth)/sign-up/page.tsx` · `app/(auth)/_components/AuthShell.tsx`
  (`OrDivider` / `FormAlert`) · `app/(auth)/_components/GoogleButton.tsx` ·
  `components/ui/Modal.tsx` (`@motir/design-system`, Radix-portaled) ·
  `app/(public)/_components/PublicTopBar.tsx` (the Sign in / Start free door) ·
  `design/auth/` (the shipped full-page auth renders this modal reuses) —
  the sources the modal composes 1:1. MOTIR-990 problem #2 is the origin.
