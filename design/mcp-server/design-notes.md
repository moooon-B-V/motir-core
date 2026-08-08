# Design — the MCP server documentation

**Area:** `design/mcp-server/` · **Story** [MOTIR-2309](https://app.motir.co) ·
**Subtask** MOTIR-2323 · **Routes:** `/docs/mcp` and `/docs/mcp/tools`

| File                   | What it is                                                                   |
| ---------------------- | ---------------------------------------------------------------------------- |
| `mcp-server.mock.html` | The asset SOURCE — seven panels, built from the real design system           |
| `mcp-server.png`       | Full-page export of the mock, light theme, `deviceScaleFactor: 2`, 1240 wide |
| `build.py`             | Regenerates the mock; the catalogue's rows are derived, not typed            |
| `design-notes.md`      | This file — the spec                                                         |

---

## What this asset does NOT own

Stated first, because most of what is visible in the panels belongs to somebody
else and this asset must not be read as re-deciding any of it.

- **The two-tier rail is `design/api-docs/`'s** (MOTIR-2311, shipped by
  MOTIR-2312). This asset shows the rail with the MCP's row present and with the
  MCP sub-area's second tier populated. It does **not** redesign the rail, its
  tiers, their headings, the active-row treatment or the operation index.
- **The docs shell chrome is 11.4's** — the `(public)/docs` layout, the shipped
  `ExploreTopBar` and `ExploreFooter`, `DocBlocks`, `CodeBlock`. Unchanged.
- **The API-token minting flow is `design/settings/`'s.** Panel 7 draws the
  empty state as it ships today and changes one link's destination. It does not
  redraw the create modal, the token list, or anything else on that surface.
- **The route set, the page count and the derivation are
  ADR Amendment 13's** (MOTIR-2321). This asset is drawn _to_ them; it does not
  re-open them.

## Drawn against SHIPPED REALITY, rendered not remembered

Before anything here was drawn, the running app was rendered from a local dev
server and screenshotted: `/docs/api` and `/docs/sandbox` at **1440×900**, and
`/docs/sandbox` at **375×800**. The shell, the two-tier rail, the top bar, the
block rhythm and the type scale in the panels below are what the app actually
shows on `origin/main` today — not a reconstruction from source.

Two things that reading the `.tsx` alone would have got wrong, and the render
caught:

1. **The rail's operation count reads `38 operations`, not `~28`.** ADR
   Amendment 11 recorded 28 and was correct when written; Story 11.7's ten
   work-loop operations have landed since. The count matters here because
   Amendment 13 Q1's argument compares the size of the two indexes — and at
   39 tools against 38 operations they are the same size, which is a stronger
   version of the argument than the one the card carried.
2. **A page outside the API sub-area gets no search box and no operation
   count** — `/docs/sandbox` renders the rail as two rows and nothing else. The
   MCP's wiring page will look the same way plus its own second tier, which is
   what Panel 6's left card draws.

The token block in the mock is copied **1:1 at build time** from
`design/agent-sandbox/agent-sandbox.mock.html`, which took it from
`design/api-docs/`, which took it from `app/globals.css`. Toggle
`data-theme="dark"` on `<html>` to confirm token parity.

---

## The panels

### Panel 1 — `/docs/mcp`, the wiring page

The sub-area's index. A reader arrives here from the rail or from Settings, and
leaves with a wired agent.

| Element        | Primitive / shipped class                     | Tokens                                                                                   |
| -------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Page title     | `h1` in `.doc`                                | `--font-serif`, `--el-text`                                                              |
| Lede           | `p.lede`                                      | `--el-text-muted`, max-width `68ch`                                                      |
| The fork table | `table.spec` — `DocBlocks`' `table` kind      | header `--el-text-faint` / body `--el-text-secondary`, `--el-border`, `--el-border-soft` |
| Both callouts  | `DocBlocks`' `callout`                        | info `--el-tint-sky`, warning `--el-tint-peach`, ink `--el-text-strong`, `--radius-card` |
| Step headings  | `h2` + `.stepnum`                             | ordinal in `--font-mono` / `--el-text-faint`, matching the shipped `StepHeading`         |
| Code samples   | `CodeBlock` — `.codeblock` + `.cap` + `.copy` | `--el-code-bg`, `--el-code-text`, `--radius-card`, caption `--el-text-faint`             |
| Client heading | `h3.client-h`                                 | `--el-text-secondary`, uppercase — a label above a block, not a section start            |
| Client meta    | `p.clientmeta`                                | `--el-text-faint`; carries the vendor link and the `format checked` date                 |
| Inline code    | `.doc code`                                   | `--el-code-bg` / `--el-code-text`, `--radius-kbd`                                        |

**The fork is the first thing on the page below the lede, and it is a table.**
A reader arriving at this surface is choosing between two programmatic surfaces
and the page's first job is to let them settle that in one look rather than
read three paragraphs. The four rows are the four axes that actually differ:
endpoint, who it is built for, stability, and shape — with **Auth** as the row
that says the choice costs them nothing to reverse.

⚠️ **No path goes in a `th`.** `table.spec th` uppercases, which renders
`/api/mcp` as `/API/MCP`. The header row carries the two surface NAMES and the
endpoints are the first body row. Worth knowing before adding a column here.

**Step 2 wires FIVE clients, and the shape is the argument.** ADR Amendment 13
**Q3a** replaced _"one wired client"_ with a client matrix, for two reasons — one
factual (`docs/mcp.md` holds no other client either, so the original allocation
pointed nowhere) and one about the product (Motir does not ship the agent; the
reader brings their own, so wiring one vendor tells everyone else they are
unsupported). The panel draws the containment Q3a requires:

1. **The four transport facts are stated ONCE**, in a `table.spec` above the
   blocks — URL, transport, header, token shape. These are Motir's, a test can
   pin them, and every block below is one of them transcribed. A stale block is
   then wrong about a vendor's _syntax_, never about Motir.
2. **Each block is captioned with the vendor's file path** (`.mcp.json`,
   `~/.cursor/mcp.json`, `.vscode/mcp.json`, `~/.codex/config.toml`) — the
   shipped `CodeBlock`'s `caption` doing the work, so the reader knows _where_ the
   snippet goes without a sentence saying so.
3. **Each block carries `format checked <date>` and a vendor documentation
   link**, in `.clientmeta`. This is the honest marker on a fact no test of ours
   can hold true.
4. **Each block prefers the vendor's own secret indirection** over a pasted PAT —
   VS Code's `inputs` + `${input:…}` prompt, Cursor's `${env:…}`, Codex's
   `bearer_token_env_var`. The info callout above the blocks says why in one
   sentence. A guide that opens by telling a reader to paste a live credential
   into a tracked file has taught the wrong habit in the first five minutes.
5. **The generic block is last and is a first-class block**, not a consolation
   paragraph — it is the one that actually covers the tail (Windsurf, Zed, Cline,
   Goose, a bespoke agent).

The blocks are **stacked, not tabbed.** A tab strip hides four of five options
behind an interaction, on a page a reader arrives at _already knowing which
client they use_ — so tabs would cost a click for every reader and save length
only for the ones who scroll past. Stacked also survives Ctrl-F, printing, and
the 375px width with no extra treatment.

**The procedure is four steps and ends in a real call.** Mint → point → check →
do one real thing. Step 3 is `whoami` on purpose: it takes no arguments and
returns the user, the workspace and the granted scopes, so one call confirms all
three things that can be wrong. The 401 callout is a warning tone because it is
the failure a reader actually meets, and it says the five causes are
deliberately not distinguished — otherwise a reader debugs an expired token as a
typo.

### Panel 2 — `/docs/mcp/tools`, the catalogue

The sub-area's second-tier resource index (Amendment 13 Q1). **Drawn at its real
size: all 39 rows, in six groups.**

| Element              | Primitive / class      | Tokens                                                                                                      |
| -------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| Anchor bar           | `.anchorbar a`         | `--el-surface`, `--el-border-soft`, `--radius-badge`, `--spacing-chip-x/y`                                  |
| Group heading        | `.cat-group-head h3`   | `--el-text`, uppercase (see below)                                                                          |
| Scope pill           | `.scope-pill`          | `--el-tint-lavender` + `--el-text-strong`, `--radius-badge`; the off-by-default one takes `--el-tint-peach` |
| Group count          | `.cat-count`           | `--font-mono`, `--el-text-faint`                                                                            |
| What the scope gates | `.cat-gates`           | `--el-text-secondary`, max-width `68ch`                                                                     |
| The rows             | `table.spec.cat-table` | as Panel 1's table; first column fixed at `15.5rem`, `nowrap`                                               |

**Grouped by SCOPE, and the grouping is derived** (Amendment 13 Q2). Each tool's
group is its own `TOOL_SCOPES` entry; only the six labels and their order
(`TOKEN_SCOPES` order) are authored. Two consequences worth naming:

- The reader has just been told, one page back, that a token carries scopes and
  that a call is refused when the tool's scope is not granted. A catalogue on the
  same axis answers the next question — _"so what do I lose if I leave this
  one off?"_ — without a second organising idea to learn.
- `work_items:delete` is the one scope **off by default on a new token**, so its
  pill takes the peach tint and its group carries a single row. That asymmetry is
  the point: a reader scanning for what their token cannot do finds it in one
  place.

**The group headings are uppercase deliberately**, matching the rail's own group
headings — a catalogue group and a rail group name the same six scopes, so they
should read as one vocabulary rather than two.

**Copy note.** The lede says the grouping's reason out loud (_"because that is
the choice you make when you mint the token"_). The callout under it states that
these are summaries and the arguments live in `docs/mcp.md` — Amendment 13 Q3's
boundary, said once, where the reader would otherwise go looking.

### Panel 3 — the catalogue at the tablet width

The rail moves above the content (the shipped `lg:` breakpoint on
`.docs`) and **the table keeps both columns**. A tool name plus one line still
fits at this width, so nothing is dropped and nothing becomes a card yet.

### Panel 4 — the catalogue at 375 px

**One card per row, and each cell keeps its column name as its label.** This is
not a new treatment — it is exactly what `DocBlocks`' `DocTable` already ships
below `md:`, applied here rather than invented, using the same `.pcard` /
`dl` / `dt` / `dd` structure at `78px 1fr`.

The alternative — a two-column table squeezed to 375 px — was rejected for the
reason the shipped component already records: a tool name is a long unbreakable
`snake_case` token, so the summary column collapses to two words per line, and
dropping the summary column hides the fact the reader is choosing on.

**No horizontal overflow at any panel width** — asserted in the render step, see
below.

### Panel 5 — the derived catalogue yields nothing

`.empty` — glyph, an `h2`, prose, and two links out. The page **says the
catalogue is unavailable** rather than rendering a heading over a blank column,
and it keeps the reader moving: back to the wiring page, or on to `docs/mcp.md`.

A derived surface owes this state. It is drawn here because the derivation
(`TOOL_SCOPES`) is a module import — so this is a build-time failure, not a
runtime one, and the honest copy says the page could not build its list rather
than implying the server has no tools.

### Panel 6 — THE ACCESS PATH ①: the rail, both tiers

Two cards side by side, because the difference between them IS the design:

- **Left — on any docs page.** Tier 1 only: the MCP is a third row in
  `Documentation`, beside `API reference` and `Agent sandbox`. Rendered on every
  page in the area, so a reader on either sibling surface is one click away.
- **Right — inside `/docs/mcp/*`.** Tier 2 appears, headed `MCP server`, listing
  the sub-area's pages **minus its index** (that is the tier-1 row; listing it
  twice would be two rows to one place). `Tools` carries the active treatment.

**Tier 2 is gated on the ROUTE PREFIX**, exactly as the API sub-area's is
(Amendment 11 Q2) — never a per-page prop. The mock's generator enforces this:
`rail()` emits tier 2 only for `mcp` / `tools`, so the left card shows what a
reader on another surface really sees.

### Panel 7 — THE ACCESS PATH ②: the in-app door

Settings → Account → API tokens, empty state, as it ships. **One thing changes:
where _"Read the MCP setup guide"_ goes.**

It points at **`/docs/mcp`** — the wiring page, not the catalogue. This reader
has just minted a credential and has no client yet; the catalogue is the wrong
first thing to hand them. Re-pointing the link is MOTIR-2328's; this asset draws
where it lands so that card has a destination rather than a judgement call.

---

## How this file was produced

```
python3 design/mcp-server/build.py                                  # regenerate
pnpm exec prettier --write design/mcp-server/mcp-server.mock.html   # CI checks this
```

The catalogue's 39 rows are **derived, not typed** — `build.py` parses
`lib/mcp/scopes.ts`'s `TOOL_SCOPES` for every tool name and its scope, and the
`server.registerTool(...)` calls in `lib/mcp/tools/*.ts` for titles. It exits
non-zero if a tool has no authored summary, or if `SUMMARIES` carries a tool the
registry no longer has, so an asset regenerated after the registry grows is
either correct or a hard error.

That is the same split Amendment 13 Q2 decided for `lib/apiDocs/mcp.ts`, applied
one layer up: the mock cannot show a stale tool list, and the 39 one-line
summaries in `build.py`'s `SUMMARIES` are **the draft MOTIR-2325 inherits**. The
mechanism that keeps those summaries true against the shipped `tools/list` is
that card's and MOTIR-2330's, not this asset's — a design mock is not a truth
gate.

**The PNG** is exported with Playwright chromium at viewport **1240 × 1000**,
`deviceScaleFactor: 2`, `fullPage: true`, light theme, from the `file://` URL of
the mock. The same script asserts **zero page errors** and
`document.documentElement.scrollWidth <= clientWidth` — the no-horizontal-overflow
check, which is what makes Panel 4's claim a measurement rather than a hope.

---

## ⚠️ Planning flags (surfaced, not silently absorbed)

1. **`CatalogueNav`'s second tier is hard-coded to the API's pages — MOTIR-2327
   must generalise it.** `apiPages` is a literal array and the tier is gated on
   `isInApiArea`, so the component supports exactly one sub-area with a second
   tier. Drawing the MCP's second tier makes this real work, and MOTIR-2327's
   boundary previously read _"this card adds one surface to it and changes
   nothing about how it works"_ — which the sub-area decision made wrong.
   **Already amended onto MOTIR-2327** (boundary corrected + an acceptance
   criterion for the tier rendering inside `/docs/mcp/*` and nowhere else), in
   the same pass as the decision. The component's own header already anticipated
   this: _"a future sub-area gets its own tier by adding a route, not a prop."_

2. **The 39 summaries in `build.py` are MOTIR-2325's content, drafted here.**
   Drawing the catalogue at its real size is impossible without them, so they
   exist; they are a draft, not a spec. MOTIR-2325 owns the final wording and the
   `Record<McpToolName, …>` totality; MOTIR-2330 owns the fingerprint pin that
   holds each one to the shipped `tools/list`.

3. **Chrome strings are new, and owe a `zh.json` twin — MOTIR-2327's.** The page
   titles, ledes, the fork table's headers, the group labels and the empty
   state's copy are chrome and belong in the `apiDocs` namespace in **both**
   catalogs. The long-form prose stays in the content module in English
   (Amendment 4 Q4).

4. **MOTIR-2315 (the `/docs` area root) is reopened by its own trigger.** The MCP
   is the first `/docs` sub-area that is neither the API reference nor a single
   page, which is verbatim the condition Amendment 11 recorded. Recorded in
   Amendment 13 Q1's consequences. Nothing in this asset decides it — but note
   that Panel 1 and Panel 2's top bars still send `Docs` to `/docs/api`, which is
   that card's whole complaint.

5. **`docs/mcp.md` and the shipped tool descriptions still use `PROD-<n>` as
   their example key — filed as [MOTIR-2342](https://app.motir.co), not fixed
   here.** Found while writing the summaries. The page hands readers to that
   reference, so it is worth fixing; it is a change to the tool surface, which
   this story's boundary excludes. ⚠️ It also collides with flag 2's fingerprint
   pin — whichever of MOTIR-2342 and MOTIR-2330 lands second re-pins, and
   MOTIR-2342's criteria say so.

6. **Q3a's client matrix adds obligations to three cards, recorded in the
   amendment's own consequences and amended onto the cards in the same pass.**
   MOTIR-2325 carries the client blocks as data — each declaring the vendor file
   path, its `checkedOn` date and its documentation URL — with the four transport
   facts held once and interpolated in, so a block cannot disagree with the
   endpoint. MOTIR-2330 asserts exactly that (a block hard-coding its own URL is a
   red build) plus the presence of every date and link. MOTIR-2327 renders them.

**No element is TAKEN from a sibling card by this asset.** The two cards whose
scope this design touches — MOTIR-2327 (the rail's second tier) and MOTIR-2323's
own summaries feeding MOTIR-2325 — were amended in the same pass, per flags 1
and 2.
