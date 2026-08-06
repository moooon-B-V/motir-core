# `design/api-docs` — the developer documentation surface

**Story 11.4 · Subtask 11.4.2 (MOTIR-2183).** The public API reference, the
getting-started guide, the stability & deprecation policy, and the two doors that
reach them. One area, one three-file asset:

| File                 | What it is                                                     |
| -------------------- | -------------------------------------------------------------- |
| `design-notes.md`    | this spec — primitives, tokens, copy, ownership                |
| `api-docs.mock.html` | the SOURCE, built from the real design system (eleven panels)  |
| `api-docs.png`       | the full-page export a reviewer skims without opening the HTML |

Built against ADR **Amendment 4** (`docs/decisions/public-api-conventions.md`),
which pins the routes, the renderer and the spec URL. This asset draws to that
answer; it does not re-decide it.

> **⚠️ Amended 2026-08-06 — Story MOTIR-2268 · Subtask MOTIR-2270.** The area
> gains a FOURTH page, the agent sandbox guide, and with it Panels 10–11 and the
> rail's fourth entry. Built against ADR **Amendment 8**, which renamed the area
> from `/api-docs` to `/docs` (Q1), drew the page's ownership line against
> `packages/cli/sandbox/README.md` (Q2), and pinned `AGENT_PROFILES` as the
> profile table's single source (Q3). **The routes below moved; this asset's own
> folder name did not** — Amendment 8's rule is that addresses move and internal
> identifiers do not, so `design/api-docs/`, `lib/apiDocs/` and the `apiDocs`
> message namespace all keep their names. See _The agent sandbox guide_ below.

---

## ⚠️ What this design does NOT own

Stated first, because two of the nine panels draw surfaces that belong to other
designs and would otherwise read as a redesign of them.

| Element                                         | Owned by                                                                             | What THIS design does                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| The marketing top bar and footer                | `design/project-square/` (Story 6.13 · 6.13.6, Panel 1)                              | Changes ONE nav item's TREATMENT (`Docs`: label → link) and adds ONE footer link. Nothing else. |
| The API-tokens settings page header + CLI panel | `design/settings/` (`account-settings.mock.html` Panels 3–8) · `design/cli-connect/` | Places ONE link row above them. Redraws neither.                                                |
| The token manager (list, create modal, scopes)  | `design/settings/` (`account-settings.mock.html` · `token-scopes.mock.html`)         | Nothing. Drawn at 55% opacity in Panel 8 purely as position context.                            |
| The app shell / authed nav                      | `design/shell/`                                                                      | Nothing — the docs surface is PUBLIC and does not render inside the authed shell.               |
| The renderer, the routes, the spec URL          | ADR Amendment 4 (Subtask 11.4.1)                                                     | Draws to them.                                                                                  |

---

## Routes

| Route                   | Page                                      | Auth          |
| ----------------------- | ----------------------------------------- | ------------- |
| `/docs/api`             | The API reference (catalogue + operation) | none (public) |
| `/docs/getting-started` | The five-step guide                       | none (public) |
| `/docs/stability`       | The stability & deprecation policy        | none (public) |
| **`/docs/sandbox`**     | **The agent sandbox guide** (MOTIR-2268)  | none (public) |
| `/api/openapi/v1.json`  | The spec the reference renders FROM       | none (public) |

All four pages live in `app/(public)/docs/`, the route group
`app/(public)/explore/` already established for unauthenticated, indexable pages.

> **The routes were `/api-docs*` when this asset was first drawn** and moved when
> the area gained its first non-API page (ADR Amendment 8 Q1; the migration is
> **MOTIR-2286**, with permanent 308 redirects from every old path). The
> reference left the area ROOT for `/docs/api` so a growing area never has to
> re-argue which page owns `/docs`. **`/api/openapi/v1.json` did not move** — it
> is a machine address under §8, and Amendment 4 Q3 is untouched.

---

## The renderer — our OWN primitives

ADR Amendment 4 Q4 rejects Scalar, Redoc and Swagger UI, and the reason matters
for this asset specifically: a third-party reference ships its own complete
visual system, which neither the `data-palette` colour axis nor the `data-style`
shape axis reaches — and it owns its own markup, so there would be nothing for
this design to specify and nothing for a reviewer to compare the built page
against. Every element below is therefore a shipped `components/ui/*` primitive.

---

## The shell (all three pages share it)

```
┌──────────────────────────────────────────────────────────────────────┐
│  ExploreTopBar (shipped)                     Sign in · Start free    │
├───────────────┬──────────────────────────────────┬───────────────────┤
│ catalogue     │  content column                  │  on this page     │
│ 264px         │  flex, min-width 0               │  200px            │
│ ─ search      │                                  │  ─ section links  │
│ ─ Documentation                                  │  ─ spec link      │
│ ─ operations  │                                  │                   │
│   by resource │                                  │                   │
├───────────────┴──────────────────────────────────┴───────────────────┤
│  ExploreFooter (shipped)                                             │
└──────────────────────────────────────────────────────────────────────┘
```

The three pages are the **top group in the same left nav** (`Documentation`:
API reference · Getting started · Stability & deprecation), which is what makes
them read as one surface rather than three unrelated pages.

| Element             | Primitive         | Colour                                                                        | Shape                                                         |
| ------------------- | ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Catalogue rail      | `Sidebar` grammar | `--el-sidebar-bg`, border `--el-border`                                       | —                                                             |
| Search box          | `Input`           | bg `--el-page-bg`, border `--el-border-strong`, placeholder `--el-text-faint` | `--radius-input`, `--height-control`, `--spacing-control-x`   |
| `/` hint            | `<kbd>` chip      | border `--el-border`, text `--el-text-faint`                                  | `--radius-kbd`, `--spacing-kbd-x/y`                           |
| Nav group heading   | `SectionLabel`    | `--el-text-faint`                                                             | —                                                             |
| Nav row             | sidebar row       | `--el-text-secondary`; hover `--el-sidebar-item-bg-hover`                     | `--radius-control`, `--height-control`, `--spacing-control-x` |
| Nav row, active     | sidebar row       | bg `--el-sidebar-item-bg-active`, text `--el-text`                            | `--shadow-subtle`                                             |
| Right-hand contents | plain list        | `--el-text-muted`; active `--el-text`                                         | —                                                             |

**Content-column typography.** `h1` is `--font-serif` at 26px (the app's page-title
convention); `h2` is 16px semibold; `h3` is an 11–13px uppercase
`--el-text-faint` label, the same eyebrow the settings panes use. Body copy is
14px / 1.65 at `max-width: 68ch` — long-form prose, so the measure is the reading
constraint rather than the container.

---

## The HTTP method chip

The one element with no exact shipped precedent, so it is derived rather than
invented: a `Pill` whose **hue lives in the BACKGROUND** with `--el-text-strong`
ink, which is the AA rule every coloured chip in this codebase already follows
(finding #35). Each verb takes a different **tint slot** — never a new hue.

| Verb     | Token             |
| -------- | ----------------- |
| `GET`    | `--el-tint-sky`   |
| `POST`   | `--el-tint-mint`  |
| `PATCH`  | `--el-tint-peach` |
| `DELETE` | `--el-tint-rose`  |

Shape: `--radius-badge`, `--spacing-chip-x/y`, `--font-mono` at 10.5px, and a
`min-width: 52px` so the paths beside them align down the rail.

**Status chips reuse the same three-tint logic by CLASS, not by code**: 2xx →
`--el-tint-mint`, 4xx → `--el-tint-peach`, 5xx → `--el-tint-rose`. A reader
learns three colours, not eleven.

**The scope chip** is a `Pill` on `--el-tint-lavender` with `--el-text-strong`,
`--font-mono` — deliberately a fourth tint, because a scope is a different KIND
of fact from a verb and must not be mistaken for one.

---

## Panel-by-panel

### Panel 1 — `/api-docs`, the default view

The catalogue is the **default landing content**: an integrator arriving cold
sees what the API can do before being asked to choose. Operations are grouped by
resource (`Work items` · `Sprints` · `Projects · Backlog · Ready`), matching the
per-resource `operations.ts` modules the document is assembled from.

The right rail carries **On this page** plus a permanent **Spec** block linking
`/api/openapi/v1.json` and stating `OpenAPI 3.1 · v1.0.0` — a code generator's
first stop, and the honest place to state that `info.version` is the CONTRACT's
version rather than the app's release.

### Panel 2 — operation detail, a WRITE

Drawn on the operation with the most to say (`PATCH /api/v1/work-items/{key}`):
a request body, a conditional header, and the two statuses Story 11.2 added.
**The section order is fixed** — scope → request → body → example → responses —
so a reader who has read one operation can skim the next.

The `curl` is copy-pasteable and carries `Bearer motir_pat_<your-token>`, a
placeholder rather than a plausible-looking fake token. The `Copy` button is a
`Button` (`variant="secondary"`, `size="sm"`) pinned to the block's top-right.

Copy that must survive to the build (each is a decision a reader would otherwise
have to discover from a 404):

- 401 — _"the five token failures are deliberately undifferentiated"_
- 404 — _"No such item, **or** it is outside this token's workspace — the same answer, on purpose"_
- 500 — _"An unexpected fault — no `code`, by design"_
- The `X-Request-Id` callout, because the id is only useful if a reader knows to quote it.

### Panel 3 — the in-page FIND

At ~28 operations today the rail is already longer than a viewport, and the API
grows. Typing filters in place and **keeps the group headings of surviving
matches**, so a reader learns where an operation LIVES rather than only that it
exists. A count line (`5 of 28 operations`) is the honest signal at scale.
`/` focuses the box, `Esc` clears it — the app's existing search-shortcut
convention. Nothing navigates until a row is chosen.

### Panel 4 — getting started

The words are 11.4.8's. This panel fixes the **rhythm** they land in: a numbered
`h2`, one short paragraph, one code block, and a `callout` only where a reader
would otherwise get it wrong. Five steps, always in this order — mint → first
call → paginate → read an error → read the rate-limit headers.

Two callouts are load-bearing rather than decorative:

- **Info** (`--el-tint-sky`): _a token is bound to ONE workspace and its scopes NARROW your role — they never widen it._
- **Warning** (`--el-tint-peach`): _on a 429, back off until `X-RateLimit-Reset`. There is no `Retry-After`._

### Panel 5 — stability & deprecation

A short prose page, deliberately plainer than the reference: it is read once, in
order, and then cited. The two lists (additive / never) are the load-bearing
content and are the page's only structure. Amendment 4 Q5 requires the page be
**generated from ADR §8's lists rather than re-typed** — a second hand-written
copy of a stability promise is the same drift this story exists to prevent,
applied to prose.

The reader's own obligation gets a warning callout rather than a bullet, because
it is the one thing on the page the reader must DO: tolerate unknown fields and
unknown enum values, and never parse the human `error` sentence.

### Panel 6 — the spec-unavailable state

The reference renders from `/api/openapi/v1.json`. When that cannot be read the
page must **not** render an empty catalogue, which reads as _"this API has no
operations"_. It says what happened, offers **Try again**, and — because the spec
is public — offers the raw document. The shell and both doors stay intact, so a
reader is never stranded, and the copy names what still works: _"Getting started
and the stability policy are unaffected."_

Composition: a centred `EmptyState` — a `--el-tint-peach` glyph badge,
`--font-serif` heading, `--el-text-muted` body at `max-width: 46ch`, and two
`Button`s (primary + secondary).

### Panel 7 — THE PUBLIC DOOR

**Not a new nav pattern, and this is the panel's whole point.** The shipped
`ExploreTopBar` (`app/(public)/explore/_components/ExploreTopBar.tsx`) already
renders `Product`, `Docs` and `Pricing` — as **non-interactive labels**, for the
reason its own comment gives:

> `Explore` is the only nav item that resolves to a real page today; `Product` /
> `Docs` / `Pricing` are future marketing pages, so they render as
> non-interactive labels rather than dead links a crawler would 404 on.

This design makes **`Docs` the first of the three to resolve**, so it takes the
treatment the bar already has for a real page — the one `Explore` uses. BEFORE
and AFTER are drawn side by side because the change is a TREATMENT, not a new
element.

| State                        | Treatment                                                            |
| ---------------------------- | -------------------------------------------------------------------- |
| Label (unresolved, shipped)  | `<span>`, `--el-text-muted`, 13.5px                                  |
| Link (resolved, this design) | `<a>`, `--el-text-secondary`, 13.5px                                 |
| Current page                 | `<a aria-current="page">`, `--el-accent-on-surface`, 13.5px semibold |

The **footer's Product column** gains an `API docs` link on the same reasoning —
`ExploreFooter`'s Product/Company columns are non-interactive labels today, and
this is the first of them that resolves. It matters because the footer is the
crawl surface: a docs page nothing links to is a docs page search does not find.

### Panel 8 — THE IN-APP DOOR

The reader with the sharpest need is someone who has **just minted a PAT** and is
holding a secret with nothing to do with it. One link row on
`app/(authed)/settings/account/api-tokens/page.tsx`, placed **directly under the
page header and ABOVE the CLI panel and the token manager**.

That placement is the same argument MOTIR-1869 used to put `ConnectCliPanel`
above the token list — _the route out reads first_ — applied one line higher,
because reading the docs is a cheaper first step than either minting a token by
hand or installing a CLI.

Composition: a `Card` with an accent border (`--el-accent`) holding one settings
row — label `--el-text` 14px, description `--el-text-muted` 12.5px at
`max-width: 58ch`, and two `Button`s (`secondary` → getting started, `primary` →
the reference). Copy:

> **Build against the API**
> Every endpoint, its scopes and a copy-pasteable example — plus a five-step
> guide from a fresh token to a working call.

### Panel 9 — mobile, 390 px

- The 264px catalogue collapses to a **disclosure button** above the content
  (`API reference · 28 operations`), full width, `Button` `secondary` `sm`.
- The right-hand contents **drops entirely** — on a phone the page IS the
  contents.
- **The rule that matters:** a `curl` line is wider than any phone, so the CODE
  BLOCK scrolls inside its own container (`overflow-x: auto` on the `<pre>`,
  `overflow: hidden` on the bordered wrapper) and the **PAGE never scrolls
  sideways**. The block's caption says so (`scrolls here, not the page →`).
- The spec tables become **stacked rows** (status chip + condition) rather than
  shrinking three columns to unreadable widths.

---

## The agent sandbox guide — Panels 10–11 (Story MOTIR-2268 · Subtask MOTIR-2270)

The area's FOURTH page. Everything structural about it is already drawn: same
shell, same rail, same content column, same heading rhythm as Panel 4. **One
element is genuinely new — the profile matrix — and it is the reason this
subtask exists.** The rest of this section says what the page card implements
and, just as importantly, what it must NOT invent.

### Panel 10 — `/docs/sandbox`, full width

Sections, in reading order, and each is the FIRST-RUN half of its subject per
ADR Amendment 8 Q2 (_a fact belongs on the page when a reader needs it for their
first successful run AND a test can hold it true_):

0. **Before you start — the PRECONDITIONS.** A two-column `table.spec` (what you
   need / how to get it) with four rows, then a `callout` (info) pointing at
   `motir doctor`. It sits above everything, because each row is a thing that
   makes the `docker run` fail _later and less legibly_ if it is missing:
   **Docker** running (the images are `linux/amd64` **and** `linux/arm64`, so
   Apple Silicon is first-class and there is no build step); **a Motir token +
   server URL** (Settings → Account → API tokens, or `motir login` inside the
   container); **the agent's own sign-in, already on the host** — the mount is
   read-only, so the container can USE a sign-in and can never PERFORM one, which
   is the non-obvious one; and **a linked workspace** (`motir link` writes
   `.motir.json`; that folder is the one you run from, not a checkout inside it).
   The `motir doctor` callout is the affordance that turns all four into one
   command, and it is the same command inside the container.
   0b. **What a workspace root IS, and what `.motir.json` is.** An `h3` under the
   preconditions with a directory-tree code block and one paragraph. The page
   named `.motir.json` four times before it defined it, which is the shape of a
   document written by someone who already knows. A Motir project spans several
   repositories and `motir auto` dispatches across all of them, so what gets
   mounted is the folder that CONTAINS the checkouts — the tree makes that
   visible in a way the sentence "not a checkout inside it" does not. The
   paragraph states the file's contents (`serverUrl`, `workspace`, `project`,
   optional `repos`), that it holds **no secret** and is safe to commit, and
   that commands resolve it by walking upward — with the one exception that
   matters here: **the `docker run` must start at the root, because the root is
   what gets mounted.**
1. **What it confines — and what it does not.** A three-row `table.spec`
   (`Filesystem` / `Network` / `Privileges`). The middle row is the one that
   earns the section: the network is **open by design**, and a guide that let a
   reader infer otherwise would be worse than no guide.
2. **Choosing a profile** — the matrix (below), plus a `callout` (info) placing
   `motir-sandbox:base` beside it. **`base` is a TAG, not a profile**, so it is
   deliberately drawn OUTSIDE the table: putting it in as a ninth row is exactly
   the confusion the callout exists to prevent.
3. **Run it.** ⚠️ **The matrix comes BEFORE the command, and that ordering is the
   fix for a real defect in the first pass.** It drew a single `docker run` under
   the heading _"The one command"_ — and that command was `claude`'s, in three
   separate places (the tag, the credential mount, and the `--agent` invocation).
   Seven of the eight profiles would have copied a command that was wrong three
   times over, from a section whose heading promised it was universal. You cannot
   write the command until you know your row, so the row is now chosen first, and
   the section is drawn as **shape → what changes → filled-in example**:
   a non-copyable `codeblock` with `<profile>` / `<credential mount>` /
   `<your agent's command>` in place; a three-row `table.spec` naming where each
   comes from; then the `claude` version with the `Copy` affordance and a caption
   that says to swap the three parts. Two notes carry the cases the placeholders
   flatten: a profile with two mounts takes two `-v` lines, one with none takes
   none.
   **The `--agent` command is the one part the page cannot source from itself.**
   Per Amendment 8 Q2's second limb the vendor auto-approve flags stay in the
   README (they drift between releases and no check on this page can refuse a
   stale one), so the table's third row points there by name rather than
   restating them — the honest form of a fact this page must not own.
4. **What each part is for.** A two-column `table.spec` — mount/variable → why —
   which answers the mounts-table question the card raised: **it reuses
   `table.spec` as-is** rather than introducing a second table treatment. Two
   columns of short prose is exactly what that primitive already draws, and it
   is not the case that fails at a narrow viewport.
5. **Three ways to give it a Motir credential**, as prose with the three tiers
   inline and a `callout` (info) carrying the one non-obvious constraint:
   `motir login` needs the credential mount to be ABSENT.
6. **Or set it up in VS Code** — three numbered `h3` steps with a real
   `.devcontainer/devcontainer.json` to copy (below), then a `callout` (warning)
   about which file NOT to copy, and a closing `callout` (info) handing the
   reader to `packages/cli/sandbox/README.md` for everything past the first ten
   minutes. The closing pointer is INFO tone, not warning: it is where the rest
   lives, not a hazard, and two peach blocks in a row would read as one.

The right-hand `toc` aside carries the six section links (`docs-aside toc`,
unchanged from Panels 2 and 4).

### ⚠️ The VS Code path draws the IMAGE-PINNED form, not the committed file

**Checked against the shipped artifact, and it changes what the page says.** Every
`devcontainer.json` under `packages/cli/sandbox/devcontainer/` carries a **`build`
block** — `"dockerfile": "../Dockerfile"` with `"context"` at the repository root —
so those files build the image from a **checkout**. They are _motir-core's own_ dev
containers and a checkout is exactly what they are for. Pointing a reader at them
would contradict this page's entire premise in the one section where they are most
likely to copy-paste.

So the page draws the form the README's own _"To use one for your own workspace"_
paragraph prescribes: **drop the `build` block and pin the published image**. The
drawn JSON keeps the committed file's other keys verbatim — `workspaceFolder`,
`workspaceMount`, `mounts`, `remoteUser`, `overrideCommand`, `remoteEnv` (which
forwards `MOTIR_TOKEN` / `MOTIR_SERVER` from the local environment, so a machine
that never ran a host login still resolves a credential) — and changes
`postAttachCommand` from `motir --version` to **`motir doctor`**, so the
preconditions section's own check runs on the way in rather than a version string.
The warning callout names the committed files explicitly, because "there is a
`devcontainer.json` in the repo" is what a reader will find first.

The three steps are drawn as `h3`s rather than a numbered list: they are
procedure, and each carries a paragraph and (for step 2) a code block, which a
`<li>` rhythm does not hold. The JSON block scrolls inside its own container like
every other code block on the surface — `workspaceMount` is the line that proves
it.

### ⚠️ The PROFILE MATRIX — the decision the page card implements

**Wide: a FOUR-column `table.spec`, not five.** The card framed this as
five columns × eight rows, and five is the version that fails. The `binary` fact
folds into column 1 as the spec table's **existing `.nm` / `.ty` two-line cell**
— the same treatment the parameter tables already use for `name` + `type` — so
the table keeps four columns of real width:

| Column                    | Content                                                    |
| ------------------------- | ---------------------------------------------------------- |
| **Profile · binary**      | `.nm` = the profile id · `.ty` = the binary it installs as |
| **Tier**                  | `pill--tier1` / `pill--tier2`                              |
| **Installed from**        | prose + `code` for the package name                        |
| **Credential mount (ro)** | one `.mount` chip per path, stacked                        |

- **`pill--tier1` = `--el-tint-mint`, `pill--tier2` = `--el-tint-yellow`** — two
  tint SLOTS rather than two shades of one hue, so the distinction survives a
  palette swap and reads without a legend. Both carry `--el-text-strong` on the
  tint for AA, and the tier is in the TEXT, never colour alone.
- **A mount is a PATH, so each is its own `.mount` chip** (`--el-code-bg` /
  `--el-code-text`, `--radius-kbd`), stacked when a profile has several.
  `opencode` has two; wrapping them as one line would read as one path.
- **The empty case is `.mount--none`** — an em dash plus the reason (`— OS
keyring`), in `--el-text-faint`, non-mono. A blank cell reads as "we forgot".
- **Eight rows.** `AGENT_PROFILES`, `sandbox/smoke/profiles.json` and the
  README's own prose all say eight; `base` is the agent-less image tag.

**Narrow (below the docs breakpoint): one CARD per profile — `.pcard`.** Drawn
in Panel 11 at 390 px. A `.pcard-head` (profile id + tier pill) over a two-column
`<dl>` with `78px` label column: BINARY / INSTALLED / MOUNTS. Not a horizontally
scrolling table and **not hidden columns** — every fact a reader is choosing on
stays visible, and a reader deciding whether to trust a container with their
credentials is exactly the person reading this on a phone first.

**It is a SHARED `table` block kind in `_components/DocBlocks.tsx`, not a
page-local component.** This is the sentence the page card implements.
`DocBlocks` today branches on `prose` (`:43`) and `code` (`:50`) only, and the
`table.spec` markup this matrix uses is already shipped inside
`_components/OperationSection.tsx` — so the choice is not _"invent a table"_ but
_"which of the two existing homes does the second caller live in"_. Promoting it
into `DocBlocks` gives the whole docs surface one table treatment; leaving it
page-local guarantees the next documentation page draws a second one slightly
differently. The block declares `{ kind: 'table', caption?, columns, rows }`,
renders `table.spec` at width and the `.pcard` stack below the breakpoint, and
the mounts table (section 3) is its first other consumer.

### Panel 11 — the matrix at 390 px

- The rail collapses to the same disclosure button Panel 9 uses, labelled
  `Agent sandbox`.
- The `docker run` **scrolls inside its own container**; the page does not
  scroll sideways. Same rule, same caption treatment as Panel 9.
- Four of the eight profiles are drawn, chosen for the cells that break a naive
  layout: `opencode` (two mounts), `antigravity` (no mount at all), `cursor`
  (the longest path in the set, `~/.local/share/cursor-agent`) and `claude` (the
  ordinary case). The remaining four repeat one of these shapes.

### Ownership — GIVES / TAKES

| `MOTIR-` key                         | GIVES / TAKES | What                                                                                                                             |
| ------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-2270** (this card)           | GIVES         | Panels 10–11, the rail's fourth entry, the matrix presentation, `.pcard` / `.mount` / `pill--tier*`                              |
| **MOTIR-2271** (the page)            | TAKES         | builds Panel 10, the `table` block kind in `DocBlocks`, and the rail's fourth entry — its criteria carry the derivation contract |
| **MOTIR-2286** (the route migration) | TAKES         | moves `/api-docs*` → `/docs*`; this asset draws the destination, not the migration                                               |
| **MOTIR-2269** (the decision)        | GIVES         | ADR Amendment 8 — the route, the ownership rule, the derivation source. Drawn to, not re-decided                                 |
| **MOTIR-2188** (11.4.7, `done`)      | —             | owns the shell, the rail component and `table.spec`. This design MOUNTS into them and changes the rail's ENTRY LIST only         |
| **MOTIR-2189** (11.4.8, `done`)      | —             | owns `DocBlocks`' `prose` / `code` / `callout` kinds. The `table` kind is ADDED beside them, changing none                       |

**Nothing is TAKEN from a card that is not already amended.** MOTIR-2271's
acceptance criteria carry the `table` block kind, the eight-row matrix and the
`sandboxMounts` derivation; MOTIR-2286 carries the route move. No criterion on a
`done` card changes.

### What this design does NOT own, restated for this page

- **The sandbox itself.** Not the `Dockerfile`, `entrypoint.sh`,
  `install-agent.sh`, the compose file, the devcontainer variants or the smoke
  suite. Every fact drawn here is READ from the shipped artifact.
- **The README's territory.** Digest tables, the confinement proof, the
  validation harness and the tier-3 escape hatch are deliberately absent from
  the drawing — Amendment 8 Q2's second limb keeps facts the page cannot test
  off the page.
- **The three Motir credential tiers are NOT the profile table's credential
  mount.** Different secrets, different failure modes; the page keeps them in
  separate sections and the drawing never puts them in one table.

---

## Light and dark

Every colour resolves to an `--el-*` token, so dark mode is the token layer's
job and not a second design. The mock's toggle flips `data-theme` on `<html>`;
review both. Two things worth checking on the flip:

- The four verb tints stay mutually distinguishable in the dark ramp (they are
  the four `--el-tint-*` slots the palette author keeps distinct).
- The code block's `--el-code-bg` sits ABOVE `--el-page-bg` in dark, so a block
  reads as raised rather than as a hole.

**No invented colour.** Every value in the mock is an `--el-*` token or the
Tier-0 `--color-*` block copied 1:1 from `@motir/design-system/theme.css` (via
`app/globals.css`). The only non-token values are the review-page chrome — the
panel labels and the `NEW` annotation badges — which are not part of the design.

---

## Accessibility

- Verb, status and scope chips carry their meaning in **text**, never in colour
  alone; the tint is redundant reinforcement.
- The catalogue is a `<nav aria-label="API reference">`; the current page carries
  `aria-current="page"`, matching `ExploreTopBar`'s shipped treatment.
- Code blocks are `<pre>` inside a labelled container, so a screen reader
  announces the caption before the content.
- Every tint chip pairs its hue background with `--el-text-strong` for AA.
- The search box is a real `<input>` with a visible label affordance and the
  `/` hint exposed as text, not as a tooltip.

---

## Deviations from this asset, and why

Recorded here per 11.4.7's acceptance criterion — _"any deliberate deviation is
recorded in `design/api-docs/design-notes.md` with its reason."_

| Drawn                                                            | Built                                                                                               | Why                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The scope chip on `--el-tint-lavender`                           | `Pill tone="neutral"` + `font-mono`                                                                 | The shipped `Pill` has no lavender tone that is not already semantically claimed (`status="planned"`, `tone="private"`), and adding one is a `packages/design-system` change outside 11.4.7's boundary. `neutral` still keeps the scope chip distinct from all four verb tints — the property the lavender was for — and the monospace face carries the rest. Revisit if a `tone="scope"` ever earns its place in the shared primitive. |
| `DELETE` in the verb chip                                        | `DEL` visible, `DELETE` in the accessible name                                                      | Every verb fits one 52 px chip so the paths align down the rail. The full verb stays in the accessible tree via `sr-only`, so a screen reader is not handed a truncation.                                                                                                                                                                                                                                                               |
| Panel 1's catalogue rail beside a persistent right-hand contents | The rail collapses ABOVE the content below `lg`, and the right-hand contents is not built in 11.4.7 | The in-page contents is per-PAGE navigation and the reference is one long page of anchored sections, so the catalogue already serves that role; a second list of the same anchors would be two things to keep in step. The mobile treatment (Panel 9) is what ships at every width below `lg`.                                                                                                                                          |

### Panel 6 (spec-unavailable) is asserted by a UNIT render, not by the E2E

Not a design deviation — a testing one, recorded here because the panel exists in
this asset and a reader will look for its browser coverage.

The reference reads the document from the emitter IN-PROCESS rather than fetching
`/api/openapi/v1.json` (ADR Amendment 4; Subtask 11.4.7), which is what makes the
page independent of the app being up to describe the app. That same property
leaves **no seam a browser can reach in to make the build fail**, so Subtask
11.4.10's E2E cannot drive this panel without a test-only switch in production
code — which its scope boundary forbids. It is asserted instead by Subtask
11.4.9's story gate, which renders the real page with a throwing builder and
checks the message, the retry and the still-reachable sibling pages.

---

## What the code cards build from this

| Card                     | Builds                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **11.4.7** (MOTIR-2188)  | the docs shell, the reference (Panels 1–3, 6), and BOTH doors (7, 8)                                                  |
| **11.4.8** (MOTIR-2189)  | the getting-started and stability pages' COPY, into Panels 4–5's rhythm                                               |
| **11.4.10** (MOTIR-2191) | the E2E: a developer finds the reference, reads an operation, follows getting-started, and reaches it from both doors |
| **MOTIR-2286**           | the `/api-docs` → `/docs` route migration + the 308 redirect map (ADR Amendment 8 Q1)                                 |
| **MOTIR-2271**           | Panel 10, the shared `table` block kind, and the rail's fourth entry                                                  |
| **MOTIR-2273**           | the E2E: a reader with no session finds the sandbox guide from the rail and leaves with a runnable `docker run`       |
