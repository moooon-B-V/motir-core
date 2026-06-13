# Public projects — design notes

Design reference for the `public-projects` UI area — **"open source project
management"**: a project made **public** for read-only VIEW by ANY signed-in
Motir account (across orgs/workspaces), where the only writes are **submit a
request** (into the 6.11 Triage), **upvote**, and **comment** (Story 6.12).
Built FROM the real design system (`app/globals.css` `--el-*` colour tokens +
`[data-display-style]` shape tokens + the shipped `components/ui/*` primitives),
so the code subtasks compose the same primitives — no Pencil→code gap.

| Surface                       | Asset                       | Gates                                                   |
| ----------------------------- | --------------------------- | ------------------------------------------------------- |
| **Public Overview / README**  | `public-projects.mock.html` | **6.12.4** (render) + **6.12.8** (the authoring editor) |
| **Public read-only view**     | `public-projects.mock.html` | **6.12.4** (board / issues, internal fields hidden)     |
| **Public roadmap**            | `public-projects.mock.html` | **6.12.7** (status-grouped, vote-counted, paginated)    |
| **Submit + duplicate detect** | `public-projects.mock.html` | **6.12.5** (the form) + **6.12.6** (the upvote target)  |
| **Request detail**            | `public-projects.mock.html` | **6.12.6** (upvote + comments on public requests)       |
| **Make-public + share link**  | `public-projects.mock.html` | **6.12.8** (the four-level Access control + the link)   |

Every UI code subtask in Story 6.12 (6.12.4 / 6.12.6 / 6.12.7 / 6.12.8) carries
`6.12.1` in `dependsOn` and is `blocked` until this asset lands.

## The locked model this UI sits on (6.12.2 / 6.12.3)

`public` is a **4th `ProjectAccessLevel`** extending 6.4 (DONE: open / limited /
private). The openness ladder is **public > open > limited > private**, and
`public` is the **ONLY** level that crosses the org boundary for READ — 6.4's
`canBrowse` returns true for ANY authenticated account on a public project,
bypassing the 6.10 org/workspace gate **for READ on public projects only**. A
public viewer is **NOT a member**, so 6.4 `canEdit` is false; the three permitted
writes — **submit-to-triage, upvote, comment** — are NEW narrow grants
(`canSubmitToTriage` / `canUpvotePublicRequest` / `canCommentPublicRequest`),
checked explicitly, never a `canEdit` relaxation.

Three invariants this asset draws and `design-notes` states in writing:

1. **Internal fields are ABSENT** from the public view — **assignees, estimates,
   and internal issue comments** are stripped by a public PROJECTION at the read
   layer (NOT fetched-then-hidden). The public board card is the shipped board
   card (`design/boards/board.mock.html`) **minus the assignee avatar + the
   story-point estimate + the drag grip**. (Public-_request_ comments from
   Panel 4 ARE public — distinct from an issue's internal discussion.)
2. **NO edit affordances** anywhere on the public surface — no create / move /
   assign / status / drag. The only interactive elements are Submit-a-request,
   Upvote, and Comment.
3. **Account-required, NOT anonymous.** A viewer must be a signed-in Motir
   account (any org). The share link is a pointer that still requires sign-in;
   anonymous/logged-out access is explicitly FUTURE (out of scope).

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
   **board** (To Do / In Progress / In Review / Done) as a NON-member cross-org
   viewer sees it: NO edit affordances, INTERNAL fields absent, the public-project
   BANNER + the signed-in cross-org viewer identity, a read-only Overview / Board
   / Issues / Roadmap nav.
3. **(3)** the public **roadmap** — status-grouped columns (submitted → planned →
   in progress → done) with vote counts + per-column pagination.
4. **(4)** **submit a request + DUPLICATE DETECTION** — the form (type toggle,
   title, description), the dedupe "upvote this instead" state, submit-as-new,
   the confirmation.
5. **(5)** a public **request detail** — the body, the upvote control + count
   (voted state), the public comment thread + composer.
6. **(6)** project **settings** — the four-level Access control + the shareable
   public link (copy / disable / rotate) + the account-required note + **the
   Overview/README authoring editor**.
7. **(7)** **states** — empty roadmap, empty request list, the paginated loading
   skeleton, the fetch-error, the rate-limited submit.

## Where it lives

```
design/public-projects/
  design-notes.md            ← this spec
  public-projects.mock.html  ← the asset SOURCE (7 panels, one self-contained file)
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
(Markdown). Authored by the project admin (Panel 6 editor), rendered read-only on
this tab via the shipped **`MarkdownView`**. It is part of the **public
projection** (6.12.4) — a public-safe field, served only when the project is
public. When empty, the tab falls back to a slim auto-intro (name + tagline +
stats + CTAs, no body) — never a blank page.

### The hero (`.hero`)

A bordered `Card` with a **soft corner-wash** (two radial `--el-hero-wash-*`
tints over `--el-page-bg` — decorative only; all text sits on `--el-page-bg`, AA-
safe, NOT a page-level tint — finding #35). Holds: a 52px logo tile
(`--el-accent`), the project name in the serif display face, **meta `Pill`s**
("Open source" mint / "GPL-3.0" / "Project management" neutral), the **tagline**,
a **CTA row** (`View the roadmap` primary · `Submit a request` outline · `GitHub`
ghost), and an **at-a-glance stat strip** (Public requests / Upvotes / Planned /
Shipped) above a hairline.

### The body + sidebar (`.ov-grid`, 1fr + 312px)

- **Main** — the authored README (`.md`, the `MarkdownView` render): `h3`
  sections, paragraphs, a **check-marked feature list** (`--el-success` ticks), a
  **product-screenshot** placeholder (a browser-chrome frame + tinted panes), and
  a "How to contribute" section linking to submit.
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
  `--el-public-banner-text`), the project key + workspace, and on the right the
  **signed-in cross-org viewer** identity (name + "signed in · {org}" + an
  initial Avatar). This makes the authenticated-not-anonymous fact visible.
- **Public banner** (`.pub-banner`, full-width `--el-public-banner-bg`): the
  explicit framing — _"You're viewing a public project. Anyone signed in to Motir
  can view it and submit, upvote, or comment on requests."_ + a `lock`-glyph
  **"View-only — you can't edit issues"** note.
- **Sub-bar nav** (`.seg`, a read-only `Segmented`): **Board / Issues / Roadmap**
  (Board active) + the primary **"Submit a request"** button (`globe`/`plus`).
  The nav switches read views only — it is not an edit affordance.

### The board (the public PROJECTION)

Mirrors `design/boards/board.mock.html` — same `.col` / `.col-head` /
`.col-count` / `.bcard` grammar — but each card carries **only**
`IssueTypeIcon` (kind hue) + the issue key + the title + the priority `Pill`.
**No assignee Avatar, no `pts` estimate, no `grip` drag handle.** The cards are
`<a>` (navigable to the read-only issue), never draggable. A bottom note states
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
  comments** (visible) — distinct from an issue's internal comments (hidden by
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
  **Disable** (`btn-danger`, rose tint). The `.acct-note` states the link is a
  pointer that still requires sign-in, anonymous access is unsupported, and
  rotating issues a new link without changing the project key.
- **Project overview editor** (`.ov-editor`): the **`MarkdownEditor`** authoring
  the `publicOverviewMd` field that renders on the Panel-1 Overview tab — a
  toolbar (heading / bold / italic / link / list / image) over a Markdown body.
  A note states it shows on the public **Overview** tab (the first thing a
  visitor sees) and is hidden while the project isn't public. Project-admin-gated;
  inline-save (success-response-is-confirmation).

---

## Panel 7 — states

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

## Colour roles (every colour via `--el-*` — no Tier-0 `--color-*`)

| Element                         | Token                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| Public chip / banner background | `--el-public-banner-bg` (→ `--color-tint-sky`)                                     |
| Public chip / banner text       | `--el-public-banner-text` (→ `--color-charcoal`, AA ~10:1 on the sky tint)         |
| Public-chip / banner glyph      | `--el-info`                                                                        |
| Upvote control (resting)        | `--el-page-bg` + `--el-border`; count text `--el-text-strong`                      |
| Upvote control (voted)          | `--el-vote-active-bg` (→ `--color-primary`) + `--el-vote-active-text`              |
| Roadmap status headers          | `--el-roadmap-{submitted,planned,progress,done}` (→ peach / lavender / sky / mint) |
| Status header / org text        | `--el-text-strong` on the tint (AA-safe)                                           |
| Issue-type icon (board / kind)  | `--el-type-{task,bug,story,epic}`                                                  |
| Priority pills                  | rose (`--el-tint-rose`+`--el-danger` glyph) / yellow / neutral, text `-strong`     |
| Selected access option          | `--el-accent` border + `color-mix(--el-accent 7%)` tint                            |
| Disable link button             | `btn-danger` (`--el-tint-rose` bg + `--el-text-strong`, `--el-danger` glyph)       |
| Rate-limit banner               | `--el-tint-yellow` + `--el-text-strong`, `--el-warning` glyph                      |
| Success confirmation badge      | `--el-tint-mint` + `--el-success`                                                  |
| Error glyph                     | `--el-tint-rose` + `--el-danger`                                                   |
| Overview hero corner washes     | `--el-hero-wash-a` (→ lavender) + `--el-hero-wash-b` (→ sky), over `--el-page-bg`  |
| Hero logo / CTA card accent     | `--el-accent` + `--el-accent-text`; stats text `--el-text` (serif)                 |
| README feature-list ticks       | `--el-success`; links `--el-link`                                                  |

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
`--el-*` token, never the Tier-0 value directly.

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
  **"View-only — you can't edit issues"**.
- Nav: **"Overview" / "Board" / "Issues" / "Roadmap"** · **"Submit a request"**.
- Overview: meta pills **"Open source" / "GPL-3.0" / "Project management"** ·
  CTAs **"View the roadmap" / "Submit a request" / "GitHub"** · stat labels
  **"Public requests" / "Upvotes" / "Planned" / "Shipped"** · sidebar
  **"Links"** (**"Website" / "Documentation" / "Source (GPL-3.0)" / "Changelog"**)
  · **"At a glance"** · CTA card **"Have an idea?"** / **"Tell us what to build
  next. It takes a minute and goes straight to the team."** The body is the
  admin-authored `publicOverviewMd` (not fixed product copy) — but **Motir's OWN
  project seeds a canonical README** with the self-improving twist (tagline _"The
  AI-native project manager — planned, tracked, and shipped inside itself. You're
  looking at Motir, in Motir: every bug and idea here is picked up by Motir to
  build the next version of Motir."_; sections _"You're looking at Motir, inside
  Motir"_, _"A self-improving loop — and you're in it"_ + the 4-step loop
  [submit → triage → plan → agent PR → ships as Done], _"Contribute"_). This
  canonical copy is seeded onto the `motir` project's `publicOverviewMd` (see
  story-6.12.ts § 6.12.4 + the seed loader), so the live tenant renders it.
  Settings editor:
  **"Project overview (public landing)"** · **"A README-style intro shown on the
  project's public Overview tab. Markdown — headings, lists, links, and images."**
  · **"This shows on the public Overview tab — the first thing a visitor sees.
  It's hidden while the project isn't public."**
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
- Access levels: **"Public"** — _"Any signed-in Motir account — across orgs and
  workspaces — can view this project and submit, upvote, and comment on requests.
  They can't edit anything else."_ · **"Open"** — _"Any member of this workspace
  can view and edit."_ · **"Limited"** — _"Any member of this workspace can view
  and comment, but not edit."_ · **"Private"** — _"Only people added to this
  project can see it."_
- Share link: **"Public link"** · **"Copy" / "Rotate" / "Disable"** · note: _"The
  link is a pointer to the public project — visitors still sign in to Motir to
  view it. Anonymous, logged-out access isn't supported. Rotating issues a new
  link and retires the old one; the project key (PROD) doesn't change."_
- States: **"Nothing on the roadmap yet"** / **"No requests yet"** / **"Be the
  first — submit a bug or feature request for this project."** / **"Couldn't load
  this project"** / **"You're submitting a little too fast. … Your draft is
  saved."** / **"Retry" / "Keep editing"**.

## Primitives composed (no hand-rolling)

`Card` · `Button` (primary / outline / ghost / danger-tinted) · `Pill` (neutral +
tint tones + the public chip) · `IssueTypeIcon` (kind hue via `--el-type-*`) ·
`Avatar` (initial-letter) · `Segmented` (the view nav + the type toggle) ·
`FormField` + `Input` + `Textarea` (the submit form + comment composer) ·
`MarkdownView` (the Overview README render) · `MarkdownEditor` (the settings
authoring editor) · `EmptyState` / `ErrorState` (the state panels) · the loading
`Spinner`/skeleton · the board `.col`/`.bcard` grammar from `design/boards`. The
upvote control is the one NEW composite (a bordered `--radius-control`
chevron+count) — it is not a new primitive vocabulary, just an arrangement of an
icon + a number + the tokens; it maps to a small `components/ui` control 6.12.6
adds. The Overview hero is likewise a NEW arrangement (logo + serif heading +
pills + CTA row + stat strip), not a new primitive.

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
