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

> **⚠️ Reframe (Story 6.17, 2026-06-15).** The `public` access level is now
> **presented as a status — "Building in public"** — not a bare dropdown option.
> Nothing about the access MODEL changes (it is still the same 4th
> `ProjectAccessLevel = public`, the same public projection, the same
> sign-in-to-act writes); only its **presentation + discoverability** change.
> Three additions, each a UI subtask gated on this asset: **(6.17.2)** the
> make-public control + copy reframed to "Building in public" with an
> **explainer/confirm** step; **(6.17.3)** a **discoverable entry point** for
> non-public projects (a Settings → General promo card + a dismissible
> project-shell nudge — NOT a bare dropdown option); **(6.17.4)** a **"Building in
> public" status badge** on the project (authed shell header + settings) when
> access = `public`, plus the **stop/manage path** (a reverse "stop building in
> public" confirm). Panels **10–12** below; the header badge in Panels 1–2 and the
> access option in Panel 6 are reframed to match. Mirror (rung 1): the
> build-in-public posture is the GitHub "make public" + Canny / Productboard
> "public portal" flow, surfaced as an opt-in **activity** the way Vercel / Linear
> surface "make public" / "share" as a first-class action rather than a buried
> setting.

| Surface                       | Asset                          | Gates                                                                              |
| ----------------------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| **Public Overview / README**  | `public-projects.mock.html`    | **6.12.4** (render) + **6.12.8** (the authoring editor)                            |
| **Edit overview** (admin)     | `public-projects.mock.html`    | **6.12.8** (split Markdown editor + live preview)                                  |
| **Public read-only view**     | `public-projects.mock.html`    | **6.12.4** (board / work items, internal fields hidden)                            |
| **Public roadmap**            | `public-projects.mock.html`    | **6.12.7** (status-grouped, vote-counted, paginated)                               |
| **Submit + duplicate detect** | `public-projects.mock.html`    | **6.12.5** (the form) + **6.12.6** (the upvote target)                             |
| **Request detail**            | `public-projects.mock.html`    | **6.12.6** (upvote + comments on public requests)                                  |
| **Make-public + share link**  | `public-projects.mock.html`    | **6.12.8** (the four-level Access control + the link)                              |
| **Public work-item DETAIL**   | `public-item-detail.mock.html` | **6.14.11** (the page) + **6.14.6** (the private-epic child-panel placeholder)     |
| **Build-in-public reframe**   | `public-projects.mock.html`    | **6.17.2** (reframed access control + copy + explainer) — Panels 6, 11             |
| **Build-in-public entry pt**  | `public-projects.mock.html`    | **6.17.3** (Settings General promo + shell nudge → confirm → go public) — Panel 10 |
| **Build-in-public badge**     | `public-projects.mock.html`    | **6.17.4** (status badge + stop/manage path) — Panels 1, 2, 12                     |

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
   style project intro: a hero (logo + name + tagline + meta pills + at-a-glance
   stats + CTAs) + an authored Markdown body + a links / at-a-glance sidebar. The
   **default** public tab.
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
   note + **the Overview/README authoring entry point** (opens Panel 7).
7. **(7)** **Edit overview** — the dedicated authoring view: a **split Markdown
   editor (left) + live preview (right)** of the public landing; edits the
   `publicOverviewMd` body only.
8. **(8)** **states** — empty roadmap, empty request list, the paginated loading
   skeleton, the fetch-error, the rate-limited submit.
9. **(9)** **SEO + GEO scaffolding** — the fully-public page is server-rendered +
   crawlable: head meta / OpenGraph / canonical, JSON-LD (`SoftwareApplication`),
   a semantic HTML outline, and the GEO answer-engine framing (the Overview/README
   as the citable description + an FAQ). States the read-anonymous /
   write-needs-sign-in / internal-fields-stripped facts.
10. **(10)** **Build-in-public ENTRY POINT** (6.17.3) — the two discoverable
    placements for a NOT-yet-public project: a **Settings → General promo card**
    (the durable home — megaphone hero + 3 what's-shared bullets + a primary
    "Start building in public" CTA) and a **dismissible project-shell nudge** (a
    one-time admin strip in the header). Both open the explainer/confirm (panel 11);
    it is **never** a bare access-dropdown option.
11. **(11)** **EXPLAINER / CONFIRM** (6.17.2) — the "Start building in public?"
    Modal: a lead paragraph + a "What becomes public" list (board + roadmap; work
    items crawlable; sign-in only to act; internal fields stay stripped) + a
    reassurance note (stop anytime, requests kept) + a Cancel / "Start building in
    public" footer.
12. **(12)** **STATUS badge + STOP / manage path** (6.17.4) — the "Building in
    public" badge shown in the authed project-shell header + settings access row
    when access = `public`, the manage row (View public page · Stop), and the
    reverse **"Stop building in public?"** confirm Modal (warn tone — page goes
    offline, link stops working, requests/upvotes kept).

## Where it lives

```
design/public-projects/
  design-notes.md            ← this spec
  public-projects.mock.html  ← the asset SOURCE (9 panels, one self-contained file)
  public-projects.png        ← the full-page PNG export (board-visible face)
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

The README content is a new nullable project field **`publicOverviewMd`**
(Markdown). Authored by the project admin in the dedicated **Edit overview** view
(Panel 7, reached from settings), rendered read-only on this tab via the shipped
**`MarkdownView`**. It is part of the **public projection** (6.12.4) — a
public-safe field, served only when the project is public. When empty, the tab
falls back to a slim auto-intro (name + tagline + stats + CTAs, no body) — never a
blank page. **Only `publicOverviewMd` (the body) is editable** — the hero
name/stats are auto, and the Links sidebar pulls from existing project fields
(website / repo / docs); no new schema beyond `publicOverviewMd`.

### The hero (`.hero`)

A bordered `Card` with a **soft corner-wash** (two radial `--el-hero-wash-*`
tints over `--el-page-bg` — decorative only; all text sits on `--el-page-bg`, AA-
safe, NOT a page-level tint — finding #35). Holds: a 52px logo tile
(`--el-accent`), the project name in the serif display face, **meta `Pill`s**
("Vibe project" lavender / "Open source" mint / "GPL-3.0" / "MCP-native" neutral),
the **tagline** (the "vibe your whole project" framing — NOT "AI project
management"), a **CTA row** (`View the roadmap` primary · `Submit a request`
outline · `GitHub` ghost), and an **at-a-glance stat strip** (Public requests /
Upvotes / Planned / Shipped) above a hairline.

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
- **Project overview entry point** (`.ov-entry`): a row showing a one-line snippet
  of the current `publicOverviewMd` + an **"Edit overview"** button that opens the
  dedicated editor (Panel 7). The `.acct-note` states it shows on the public
  **Overview** tab (the first thing a visitor sees) and is hidden while the project
  isn't public. Project-admin-gated.

---

## Panel 7 — Edit overview (the 6.12.8 authoring view)

The dedicated authoring surface for `publicOverviewMd` — a \*\*split Markdown editor

- live preview\*\*, mirroring GitHub README editing / Canny portal editing (the
  chosen scope: full editor + preview, body-only). Not a cramped settings box.

* **`.editor-shell`** — a `Card` with a header (`.editor-head`): a back
  `.icon-btn` (← to settings), the serif **"Edit overview"** title + a subtitle
  ("Markdown — shown on your public project's Overview tab. Changes save to the
  live public page."), and the action cluster — a **"Saved"** status
  (`--el-success` check), **Cancel** (ghost), **Save** (primary).
* **`.editor-toolbar`** — the `MarkdownEditor` formatting row (heading / bold /
  italic · separator · link / list / numbered / image) + the **"Markdown"** /
  **"Preview"** pane tags.
* **`.editor-split`** (1fr / 1fr) — **left** `.editor-src`: the raw Markdown source
  in `--font-mono` (`<pre><code>`); **right** `.editor-prev`: the **live preview**
  rendered with the SAME `.md` primitives as the public Overview (headings, the
  `ol.loop`, the `ul.layers` with palette-hued icons), framed in an `--el-page-bg`
  card with a floating **"Live preview"** badge — so the admin sees exactly what
  ships.
* **Save** persists `publicOverviewMd` via a service method (the
  success-response-is-confirmation rule — no whole-tree refresh); project-admin-
  gated; the public projection re-reads it. Built with `MarkdownEditor` +
  `MarkdownView` — no new primitive.

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

A non-public project gets **two** placements — never a bare dropdown option (the
explicit anti-pattern):

- **(a) Settings → General promo card** (`.promo`) — the **durable home**. A
  bordered card with a soft decorative corner-wash (the same `--el-hero-wash-*`
  tints, text on `--el-page-bg` so AA holds — finding #35), an accent-filled
  `promo-glyph` megaphone, a serif headline + sub, a 3-row `promo-bul`
  what's-shared list, and a `promo-actions` row (**"Start building in public"**
  `btn-primary btn-lg` + a "Learn more" ghost). Always present for an admin on a
  non-public project.
- **(b) A dismissible project-shell nudge** (`.nudge`) — the **discovery**
  surface. A one-time, dismissible strip (accent left-border, `#i-rocket` lead
  glyph, title + sub, a "Start building in public" `btn-primary`, an `#i-x`
  `nudge-close`). Shows once to project admins; dismissible; not persistent
  chrome.

Both open the Panel-11 confirm → on confirm, `setAccessLevel('public')` and the
project goes public. (Both placements are rendered inside a dashed `ctx-strip` /
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

## Colour roles (every colour via `--el-*` — no Tier-0 `--color-*`)

| Element                          | Token                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Public chip / banner background  | `--el-public-banner-bg` (→ `--color-tint-sky`)                                                         |
| Public chip / banner text        | `--el-public-banner-text` (→ `--color-charcoal`, AA ~10:1 on the sky tint)                             |
| Public-chip / banner glyph       | `--el-info`                                                                                            |
| Upvote control (resting)         | `--el-page-bg` + `--el-border`; count text `--el-text-strong`                                          |
| Upvote control (voted)           | `--el-vote-active-bg` (→ `--color-primary`) + `--el-vote-active-text`                                  |
| Roadmap status headers           | `--el-roadmap-{submitted,planned,progress,done}` (→ peach / lavender / sky / mint)                     |
| Status header / org text         | `--el-text-strong` on the tint (AA-safe)                                                               |
| Work-item type icon (board/kind) | `--el-type-{task,bug,story,epic}`                                                                      |
| Priority pills                   | rose (`--el-tint-rose`+`--el-danger` glyph) / yellow / neutral, text `-strong`                         |
| Selected access option           | `--el-accent` border + `color-mix(--el-accent 7%)` tint                                                |
| Disable link button              | `btn-danger` (`--el-tint-rose` bg + `--el-text-strong`, `--el-danger` glyph)                           |
| Rate-limit banner                | `--el-tint-yellow` + `--el-text-strong`, `--el-warning` glyph                                          |
| Success confirmation badge       | `--el-tint-mint` + `--el-success`                                                                      |
| Error glyph                      | `--el-tint-rose` + `--el-danger`                                                                       |
| Overview hero corner washes      | `--el-hero-wash-a` (→ lavender) + `--el-hero-wash-b` (→ sky), over `--el-page-bg`                      |
| Hero logo / CTA card accent      | `--el-accent` + `--el-accent-text`; stats text `--el-text` (serif)                                     |
| README feature-list ticks        | `--el-success`; links `--el-link`                                                                      |
| "Building in public" badge       | `--el-build-bg` (→ lavender) + `--el-build-text` (charcoal, AA), `--el-build-glyph` (accent) megaphone |
| Entry-point promo glyph / CTA    | `--el-accent` fill + `--el-accent-text`; promo wash = `--el-hero-wash-*` over `--el-page-bg`           |
| Shell nudge accent               | `--el-accent` left-border + lead glyph, on `--el-surface-soft`                                         |
| Explainer "becomes public" list  | `yes` `--el-success` · `gate` `--el-info` · `strip` `--el-text-faint` glyphs                           |
| Stop-confirm warn glyph / note   | `--el-tint-yellow` + `--el-warning` (`modal-glyph.warn`, `modal-note.warn`)                            |

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
add to Tier 3, consume via `--el-*`.

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
  - the seed loader), so the live tenant renders it. Settings entry point:
    **"Project overview (public landing)"** · **"README-style intro for the public
    Overview tab"** · **"Edit overview"** (button) · **"This shows on the public
    Overview tab — the first thing a visitor sees. It's hidden while the project
    isn't public."** Edit-overview view: **"Edit overview"** · **"Markdown — shown
    on your public project's Overview tab. Changes save to the live public page."**
    · **"Markdown" / "Preview" / "Live preview"** · **"Saved" / "Cancel" /
    "Save"**.
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
  **"Live"** on the access option). Entry-point promo (6.17.3):
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
`MarkdownView` (the Overview README render) · `MarkdownEditor` (the settings
authoring editor) · `EmptyState` / `ErrorState` (the state panels) · the loading
`Spinner`/skeleton · the board `.col`/`.bcard` grammar from `design/boards`. The
upvote control is the one NEW composite (a bordered `--radius-control`
chevron+count) — it is not a new primitive vocabulary, just an arrangement of an
icon + a number + the tokens; it maps to a small `components/ui` control 6.12.6
adds. The Overview hero is likewise a NEW arrangement (logo + serif heading +
pills + CTA row + stat strip), not a new primitive. The build-in-public
entry-point **promo card** and **shell nudge** (6.17.3) are also arrangements of
existing primitives (`Card` + accent glyph + serif heading + bullet list +
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

## Context refs

- `scripts/plan-seed/data/story-6.12.ts` — the locked model + the subtask DAG.
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
