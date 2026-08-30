# `design/runs/` — watching an agent work

The design area for **agent runs**: the record of what a dispatch run did, and the surfaces a person
watches it on. New area, created by **Story MOTIR-1789 · MOTIR-1795**.

A run is the thing Motir has never been able to show. Someone hands it a whole story, eleven work
items go _In Progress_ at once and stay that way for an hour, and the complete account of which one
is being worked, which were skipped and why, and where it stopped exists in a terminal on one
machine and is gone when the window closes. These surfaces are that account, in the product.

---

## ⚠️ THE NOUN IS `work item`, NEVER `card`

Every rendered string in this folder — a column head, an empty state, a sentence on a panel — says
**work item** or **item**. That is the product's noun, in its API, its documentation and its
interface; _"card"_ is the planning corpus's authoring shorthand, and it reached this area's copy
through these mocks, because **a mock is not a sketch: it is the copy, verbatim, and a code work item
transcribes it into `messages/*.json`.**

**Three senses, and only the first is wrong here.** A WORK ITEM (fix it) · a UI PANEL — `Card`,
`ContentSectionCard`, `.secCard` — which keeps its name · a quoted SOURCE SYMBOL —
`DispatchRunCard`, `DispatchCardDisposition`, `card_claimed` — because the schema is not copy and
renaming a shipped symbol is a different job. So the sweep is a disposition per occurrence, never a
substitution: a blind replace ships _"we couldn't charge your work item"_ on some other surface.

Measured at `origin/main` `2fc5d6016`, before the sweep: `design-notes.md` 55 · `run-section.mock.html`
87 · `run-view.mock.html` 81 · `runs-index.mock.html` 58. Recorded on MOTIR-3893; the rest of the
product's catalog carries the same noun in ~14 more strings and is MOTIR-3949.

**The accounting AFTER the sweep, so a later reader can re-run it rather than trust it.** Strip the
`<style>` blocks, the comments and the SVG, unescape, and grep the remaining text for `\bcards?\b`:

| asset                   | rendered hits | what they are                                                |
| ----------------------- | ------------: | ------------------------------------------------------------ |
| `run-modal.mock.html`   |         **0** | —                                                            |
| `runs-index.mock.html`  |         **0** | —                                                            |
| `run-section.mock.html` |         **1** | `Card and Pill` — the two UI primitives the section composes |

**⚠️ AND A WARNING FOR WHOEVER SWEEPS THIS FOLDER NEXT, because it cost a render to find.** A CSS
CUSTOM PROPERTY is a fourth sense of the word, and it is the one a careless sweep destroys:
`--radius-card`, `--el-card`, `--shadow-card`, `--spacing-card-padding`, `--el-card-icon-bg`,
`--el-card-icon-fg`. Rewriting those produces a file that still parses, still has every panel, and
renders **792 CSS px shorter** because no radius, shadow or padding resolves any more.

**It is invisible to the obvious check.** The probe below, written to list every occurrence with its
surrounding token, cannot match `--radius-card`: the separator is a HYPHEN and the hyphen is not in
the character class. The accounting comes back clean while the asset is broken.

```
the probe that missed it     [A-Za-z_.`]*card[A-Za-z_.`]*
what it cannot match         --radius-card   --el-card   --shadow-card
mask these FIRST             --[a-z0-9-]*card[a-z0-9-]*
```

**Mask every CSS custom property first, and verify with a pattern that includes hyphens** — then
check the RENDER. A copy-only edit must reproduce the committed height exactly, which is what
`EXACT` with `committed=2400x17114` and `new=2400x17114` on this asset now says.

---

## The surfaces

| Surface                            | Asset                                           | What it settles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The run SECTION on a work item** | **`run-section.mock.html`** + `run-section.png` | The work item's own run: its live timeline over the CARD-SCOPED event vocabulary, the "one of N" link-out when the run covers a set, this work item's recent runs as a paged list, and the collapsed log console. Every terminal state, including the two that get improvised when undrawn — **re-planned** and **reporting-offline**. **Also carries this area's TONE TABLE** (panel 12), which every other run surface consumes. MOTIR-1795 (design). Gates MOTIR-1796.                              |
| **The RUNS INDEX** (`/runs`)       | **`runs-index.mock.html`** + `runs-index.png`   | Every run the project has made, current and past, and **the rail row that reaches it**. The surface that makes a run FINDABLE at all — it is what replaced the `/ready` strip this area used to draw (below). MOTIR-3893 (design). Gates MOTIR-3923.                                                                                                                                                                                                                                                   |
| **The run MODAL** (over `/runs`)   | **`run-modal.mock.html`** + `run-modal.png`     | One run, FULL SCREEN over the list rather than at a route of its own: the header, the **reused canvas** carrying every work item the run owns with its disposition in this run, and the **log pane** carrying what the agent is saying. All three set shapes, the skips with their reasons, the run's own states, and the log pane's three distinct silences. COMPOSES `design/roadmap/`'s canvas and this folder's tone table; defines neither. MOTIR-3893 (design). Gates MOTIR-3895 and MOTIR-3962. |

### ⚠️ WHAT THIS AREA DREW ONCE AND WILL NOT DRAW AGAIN — the `/ready` run STRIP

An earlier revision of this area carried a third surface: `ready-strip.mock.html`, a live-run
indicator on a `/ready` row, drawn in both states and measured to cost the row no height. **It is
deleted, and the reason is not taste — the row it decorated cannot occur.** `/ready` renders
`workItemsService.listReady`, whose `collectReadyLeaves` collects only _the ready, childless `todo`
leaves_, and `claimNextReady` / `claimScope` flip every claimed work item to `in_progress` **before** the
first agent starts. A work item with a live run has therefore left the list the strip lives on, by
construction — the transition that creates the state worth indicating is the transition that removes
the row.

The asset had noticed half of this and stopped one step short: its own state table said _"a finished
work item has left the ready set, so no strip state exists for it"_, which is the same sentence one word
away from being true of a RUNNING work item.

**What the strip was FOR is now the runs index**, which is reachable from the rail rather than from
the one page a run's work items have just left. Recorded on MOTIR-3914; the archived work item is MOTIR-1797.

### ⚠️ AND THE SECOND — the run VIEW as a PAGE, `/runs/[id]`

`run-view.mock.html` drew one run as its own route: a header, a seven-column table of the set, and
the run's states. **It is deleted, and this time the reason is the INTERACTION rather than an
impossible state.** Yue, on reading it (2026-08-29): _"click a run to show a full screen modal,
canvas on the left to show the work item status, reuse the canvas, right side to show the log panel. it's
full screen but not a new page, close to show the run list page."_

A run is something you look INTO from the list and come back out of. A route makes that a
navigation: it loses the reader's scroll position and their current/past partition, and turns a
glance into a round trip. **The overlay keeps both** — `/runs` stays mounted behind it — and it gives
the canvas the room a seven-column table was being squeezed into.

**Where each of that asset's facts went, so nobody redraws it looking for one:**

| the page drew                                 | it now lives                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| the header (command · scope · agent · timing) | the modal's own header, unchanged                                                |
| the SET as a table                            | the modal's **canvas pane**, composed from `design/roadmap/`                     |
| a per-row DELIVERY reference                  | nowhere — a node LINKS to its work item, whose Development section owns delivery |
| the run's states                              | the modal, drawn per state                                                       |
| the way BACK to the index                     | close · `ESC` · Back, drawn as three real exits                                  |
| **nothing at all**                            | **the LOG pane** — the half that was missing, and the whole complaint            |

**It is worth recording WHY the gap was invisible.** The page was buildable, correctly sized,
correctly blocked, and every comparable product in the category ships one — a CI provider, a
deployment platform, a build service. Measured on the merged assets at `origin/main` `2fc5d6016`:
`run-section.mock.html` drew the log console **26** times and `run-view.mock.html` **none**. The
surface a person would open to watch an agent work could show that something was running and never
what it was doing. Recorded on MOTIR-3952; the re-scoped work item is this one.

---

## What this area does NOT draw

Three boundaries, each because the fact already has an owner and a second drawing of it is how one
product acquires two answers to one question.

1. **Pull requests and their CI belong to the DEVELOPMENT section.** One work item up the same stack,
   drawn at `design/work-items/delivery-set.mock.html`. The run section names a pull request in its
   timeline as an EVENT — _"pull request linked"_ — and draws no state for it. `run-section.mock.html`
   panel 11 draws the two adjacent so the relationship is legible; that panel is the whole of what
   this area says about a pull request.
2. **The work item's STATUS belongs to the board.** A run is not a status and must not read as one.
   This whole area exists _because_ the status column has stopped being able to answer — a scoped run
   puts eleven work items at _In Progress_ simultaneously, so the column reports the run's footprint and
   not its cursor — and a run surface that looked like a second status pill would be re-drawing the
   thing it exists to compensate for.
3. **Tokens, usage and cost are not drawn at all**, and not because they are "not yet": a BYOK run
   never touches the gateway and has no cost. See _Out of scope_ below.

## What it composes

| Host                                                                           | Composed how                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `design/work-items/` + `app/(authed)/items/[key]/_components/LateSections.tsx` | The run section is a **new row in the item page's tier table** (below). It is `ContentSectionCard`'s header grammar over `Card`, in the LATE STACK. The host's layout, header, rail and navigation are cited, never re-specified.                                                                                                                                                          |
| `app/(authed)/settings/workspace/jobs/_components/JobsDashboard.tsx`           | Both PAGES compose that file's shipped table grammar — a rounded, bordered, horizontally scrollable wrapper over a plain table, secondary ink in the head and body ink in the cells. Copied, not re-invented; the run tables are not a new component.                                                                                                                                      |
| `design/roadmap/` + `components/planning/ProjectRoadmapCanvas.tsx`             | The modal's LEFT pane MOUNTS the shipped project canvas. Its pan, zoom, drill, search, locate, saved layout and the work-item node's look are that area's and are CITED, never re-specified here; this folder draws only the disposition strip a RUN adds to a node. Build the level through `workItemLevel.tsx`'s adapter — a cast from the run DTO renders invisible nodes (MOTIR-3152). |
| `design/shell/` + `app/(authed)/_components/SidebarNav.tsx`                    | The rail is drawn ONLY so the access path is visible rather than described. Its rows are the shipped sidebar's shape and the entry follows that file's own convention; nothing about the rail itself is re-specified here.                                                                                                                                                                 |

---

## Placement: the run section joins the late stack, BEFORE Development

`design/work-items/design-notes.md` § _The item page at ARRIVAL, and while it STREAMS_ allocates the
page in three tiers. The run section is a **sixth late region**, and its row in that table reads:

| Region                                                   | Tier               | Its pending face                                                              |
| -------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------- |
| **Run (this work item's live run, and its recent runs)** | **AFTER the page** | **work item chrome + row-shaped pulse bars — the same face Development uses** |
| Development (linked PRs + CI)                            | **AFTER the page** | work item chrome + row-shaped pulse bars                                      |
| Acceptance                                               | **AFTER the page** | work item chrome + a two-line body pulse                                      |
| Design result                                            | **AFTER the page** | work item chrome + a thumbnail-shaped pulse                                   |
| Attachments                                              | **AFTER the page** | tile-shaped pulse skeletons                                                   |
| Activity                                                 | **AFTER the page** | comment-row-shaped pulse skeletons                                            |

**Directly BEFORE Development, and the argument is CAUSAL ORDER rather than mere adjacency.** The
run is what PRODUCES the pull request. Reading down, a person meets _an agent worked this card_ and
then _and here is what it shipped_ — the order the events actually happened in, and the order the
run's own timeline ends in, since **_pull request linked_ is its second-to-last row**. Reversed, the
page shows the artefact above the act that made it, and the reader has to scroll past a merged pull
request to find out where its branch came from. The two still share a boundary of meaning, which
panel 11 draws explicitly; what changed is which side of it comes first.

_(Yue, 2026-08-29: the first revision put the run section after Development and argued adjacency.
Adjacency was the right property and the wrong side of it — "run first, then the PRs are there".)_

**⚠️ IT FILLS WITH THE ONE SETTLE. It is not a sixth arrival.** The host decides that the page
settles TWICE — once when the first content replaces the frame, once when the late stack fills — and
that the late regions therefore share ONE `<Suspense>` promise rather than one each. A sixth
independent boundary would make the page settle three times for a region that is below the fold at
arrival: the wait it saves is a wait nobody is watching, and the cost it pays is a reader who scrolls
into a mixture of real and pending sections and cannot tell which is which. The run section's pending
face is therefore the stack's own, and its read joins `lateReads`.

_(The host's note on why "one settle" is delivered by TWO boundaries — `ChildPanel` is tier 2 and
renders between Design result and Attachments — is unchanged and is not restated here.)_

---

## The CONNECTION — SSE, and only while a run is live

**No WebSocket, anywhere in this area.** The transport is **Server-Sent Events** — one long GET on
`/api/dispatch-runs/[id]/stream`, resumable from `?since=<seq>` — chosen because the traffic is
strictly one-way (the page reads a run; it never writes to one) and because the product already has
exactly this convention in `app/api/ai/plan/generate/[jobId]/stream/route.ts`. A second streaming
mechanism would mean two heartbeat intervals, two frame formats and two sets of proxy-timeout bugs
to learn about separately.

**⚠️ AND THE SECTION OPENS NO CONNECTION AT ALL UNLESS THIS CARD HAS A LIVE RUN.** This is the rule
that decides what the panel COSTS, and it has to be written down because the obvious implementation
gets it wrong: a section that subscribes on mount opens a stream on **every item page a person
opens**, and the overwhelming majority of work items are not being worked. The item page is the most
visited surface in the product.

So, per state:

| what the work item has        | what the section does                                                |
| ----------------------------- | -------------------------------------------------------------------- |
| no run ever                   | renders the empty state. **No stream.**                              |
| only finished runs            | renders the history from the page's own read. **No stream.**         |
| a run in a NON-terminal state | opens the stream, resuming from the last `seq` it holds              |
| that run reaches terminal     | the server writes `done` and **closes**; the section does not reopen |

The server half already refuses to hold a pointless connection — an already-terminal run replays
from the cursor and closes rather than parking a socket — but that only bounds the damage after the
connection exists. **The client must not open one in the first place**, and the fact it needs is
already on the page: the history read's first row IS the current run, so whether a stream is owed is
answered by data the section has before it renders anything.

The **stream-reconnecting** state (panel 7) is what a dropped connection looks like _while a run is
still live_; it is a transport state, not a run state, and it is never shown for a work item at rest.

---

## The ACCESS PATH — `/runs` is a primary rail entry, directly after Ready

**The verdict, and the reading that settled it.** An earlier revision of the run-view work item
pre-judged this as _"the expectation is no primary-nav entry"_. That expectation was wrong, and it
was wrong for a reason worth keeping: it was made while a `/ready` strip still existed to be the
door, and when the strip turned out to be undrawable the run view was left with no general
entrance at all.

Read against `design/shell/design-notes.md` and the shipped convention in
`app/(authed)/_components/SidebarNav.tsx`: **every top-level project view is a primary entry** —
Home · Dashboard · Issues · Ready · Boards · Roadmap · Plans · Backlog · Triage · Reports — and each
carries a source comment naming the design section that grounded it (Roadmap's says its own entry is
_"drawn beside the other project nav surfaces; NOT a Board↔Roadmap toggle"_). A runs index is a peer
of those, so it takes the same first-class row.

**Position: directly after Ready.** _Ready is where you dispatch; Runs is where you watch._ The two
are one action apart, and putting Runs at the end of the rail would separate them by six rows for no
reason a reader could reconstruct.

**Glyph: `Waypoints`** — a path through ordered nodes, which is exactly what a run over a SET is, and
it is unused in the rail. Ruled out, each because it is already taken and a second meaning for one
glyph is worse than a less obvious first: `CirclePlay` (Ready), `Zap` (the epic issue type),
`Activity` (Code health), `History` (Resume onboarding).

**⚠️ The row must be REGISTERED as well as rendered.** `lib/settings/projectNavAccess.ts` carries one
row per nav href with a permission requirement and an evidence sentence, and its own header records
that `canOfferNavDestination` answers **FALSE for an href it does not carry** — so an omission does
not fail loudly, it drops the row from the rail. A page that ships, renders and passes its tests can
still be invisible. The requirement is **`browse-only`**, because the read's own gate is
`projectAccessService.assertCanBrowse`: a run history is project data, and whoever may see the
project may see what ran in it — the same answer the two sibling run reads already carry in the
permission inventory.

---

## The PAGE and the OVERLAY, and what each settles

### `/runs` — the index

**Two headed sections, not a switch and not one undivided list.** A person arrives asking one of
exactly two questions — _what is happening right now_ or _what happened_ — and the two are read
differently: the first is watched, the second is searched. Two sections answer both without a click
and without hiding either. Live runs are few by construction (bounded by how many agents are
running), so the top section is short and the page does not fight itself. **When one side is empty it
says so in a line rather than disappearing**: a section that vanishes makes a reader wonder whether
it failed.

**The row** carries the command, the scope, the agent + model, when it started, elapsed-or-duration,
the status pill, and the **leg summary** — _"9 of 11 implemented, 1 skipped, 1 not reached"_ — which
is the run's outcome in one cell. **The stop reason is deliberately NOT in the table**: it is one
sentence and it belongs on the run, where there is room to say it in words.

**Two rows a list of records has to survive, drawn in panel 4.** A run that took **no work items** (a real
outcome — a scoped run whose members were all skipped) and a run whose **scope work item was
deleted** (the row survives it; the record stores the scope LABEL beside the id precisely so a run
stays readable after its subject is gone). Neither is styled as a problem.

**The wait and the failure are separate faces** (panel 5). _We could not load this_ and _nothing has
run_ are opposite facts and must never share one. The frame is **an in-page `<Suspense>`, never a
`loading.tsx`** — a route-level boundary here would sit above `/runs/[id]`, flush the response head,
and turn that page's 404 into a 200.

### The run MODAL — full screen over `/runs`, opened from a row

**It is an OVERLAY, and the list stays mounted behind it.** Closing returns the reader to the same
scroll position and the same current/past partition, which is the whole reason it is not a route.
**Three exits, all real:** the close control, `ESC`, and Back — the last of which works because the
deep link is a `shallowPush` that keeps a history entry.

⚠️ **The canvas has its own keyboard handling** (`/` to search, zoom, locate), and a full-screen
canvas inside a dialog is exactly where two `ESC` handlers collide. The dialog's must win, and a test
must say so rather than a reader discovering it.

#### The DEEP LINK is `/runs?run=<id>`, and THREE files have to agree on it

The run SECTION on a work item points its _"one of N"_ line and every run-history row at it; the runs
INDEX writes it when a row is activated; the modal reads it. That is three files and one parameter
name, so it is recorded here rather than in whichever of them is written first.

It is a `shallowPush`, never a `router.push`: `CLAUDE.md`'s discriminator is whether the target body
needs data the browser does not have, and the modal fetches its own run client-side — so the server
has nothing to answer and re-running the page is pure cost.

#### The CANVAS pane COMPOSES `design/roadmap/` — it does not redraw it

`ProjectRoadmapCanvas` (MOTIR-1194) is the shipped foundation every planning surface mounts, and
`design/roadmap/` is where its pan, zoom, drill, search, locate, saved layout and the work-item
NODE's look are drawn. **This asset draws the node only far enough to show what a RUN adds to it: the
member's disposition in this run, on a strip below the node's own content.** A design that
re-specified the canvas would give the product two accounts of one component, and they would drift —
which is this folder's own reuse rule applied one surface over.

**The LEVEL the pane serves is the run's SET, as one synthetic level.** A run's members are not one
parent's children: `motir batch` and `motir auto` take whatever was ready, across parents. The canvas
takes a consumer-supplied `loadLevel`, and serving a synthetic level through it is the established
pattern in that component's own family — `workItemLevel.tsx` exports `ORIGIN_ID` precisely because
_"`loadLevel` intercepts this id and serves the synthetic pre-plan station level for it"_.

⚠️ **The ADAPTERS are the reuse, not the route** — bug MOTIR-3152, written into
`PlanReviewCanvas.tsx`'s own header. `DispatchRunCardDto` carries `key` / `disposition` /
`skipReason`; `ProjectCanvasNode` needs `content` / `searchText` / `drillable` / `crumbLabel`. They
share no field name, and a cast from `unknown` type-checks, so every node arrives with an undefined
`content` that renders into a zero-height box: _"the work item was not blank, it was INVISIBLE"_. Build
the level through `workItemLevel.tsx`'s adapter, and extend the adapter where a run needs something
it does not carry.

**Which of the canvas's opt-in controls are on is a DECISION, not a default.** `searchable`,
`locatable`, `fullScreenable` and `emphasis` are each absent unless passed. `fullScreenable` is
**off** here: escalating to the Fullscreen API from inside a dialog that already fills the screen is
two overlays and two `ESC` handlers, which is the collision above made worse rather than solved.

**Selecting a node is what the log pane filters to.** The selection lives in the modal and is passed
to both panes, so neither owns the other's state.

#### ⚠️ THE RUNNING EDGE — the run TRAVELS along it (Yue, 2026-08-30)

**This is why the pane is a graph rather than a table.** A table can say _this one is running_. Only
the graph can say **what becomes reachable when it lands**, and on a run that is the question a
person actually has — the order is not arbitrary, it is the dependency edges, and watching a run is
watching the frontier move along them.

**Every edge FROM the running work item TO one it BLOCKS flows**, in the running tone this area
already owns (`--el-status-in-progress`). The canvas already draws the arrow blocker → blocked, so
the motion travels the way the work does and needs no second direction cue.

**Only `running` flows.** A queued node's edges are dependencies, not travel; a finished run has
nothing in motion, so it reads as a still graph — which is the correct picture of a run that has
stopped. Nothing else on the surface animates.

**⚠️ REDUCED MOTION IS REQUIRED, NOT A COURTESY.** This surface is left open for an hour at a time,
and a looping animation with no still state is a vestibular hazard and an attention sink. Under
`prefers-reduced-motion: reduce` the edge keeps its WEIGHT and its HUE — it still reads as the live
one — and stops travelling. Drawn beside the moving face in panel 2, not described.

**⚠️ AND IT NEEDS A CAPABILITY THE FOUNDATION DOES NOT HAVE.** Verified on `origin/main`:
`CanvasEdge.variant` in `components/planning/PlanningCanvas.tsx` is a closed union — `firm` ·
`pending` · `cross` — and the CONSUMER supplies edges while the FOUNDATION renders them, so a run
pane cannot animate an edge it does not draw. Two constraints on that change, both read from the
file rather than assumed:

- **The animation must ride the SAME `<path>`.** That component keeps its arrowhead markers in a
  separate `<svg>` on purpose, so that _"the canvas-edges `<path>` count stays = the edge count"_ —
  a second element per edge breaks the guard asserting it. An animated `stroke-dashoffset` on the
  existing path satisfies both.
- **FIVE files compose this foundation** — `ProjectRoadmapCanvas`, `PlanningWorkspaceHost`,
  `PlanningWorkspaceSkeleton`, `DiscoveryOnboarding`, `StationNode` — so widening the union is a
  shared change, and the new member must be opt-in exactly as `searchable` / `locatable` /
  `fullScreenable` are. An onboarding canvas that grew a flowing edge would be a regression.

**That is a build dependency, not a note, and it has a KEY: MOTIR-3972** — `PlanningCanvas` learns
the animated variant, and [the run modal](motir:cmteb0tj2001ohvn82ijisqz7) is `blocked_by` it. It is
carved rather than folded into the modal's own card, which is already at the estimation gate's
ceiling: the design gives that card more than it was sized for, and the honest answer to that is a
split, never a bigger number.

**The split also says who owns WHICH decision.** MOTIR-3972 makes the variant available and correct
— the flowing dash, its own arrowhead marker, the reduced-motion rule, and the opt-in default that
keeps every other consumer byte-identical. It chooses no policy. **This asset and the run modal
choose the POLICY**: which edges carry it (running → blocked, and only those), and when nothing
does (a queued node, a finished run).

#### The SET arrives in three shapes, and the pane is TOTAL over all three

A claimed scope (panel 1), a frozen batch snapshot (panel 2), and a **single work item** (panel 3) —
drawn as the same canvas with one node rather than as a different picture. A set of one is the
degenerate case of the same object, and the moment it gets its own layout the two drift and the
singular case becomes the one nobody maintains.

**The In-Progress-from-t=0 consequence is drawn as copy**, not left to the terminal. It is the one
property of this design a person must be TOLD rather than discover: every work item in a claimed
scope reads _In Progress_ on the board from the moment of the claim, while only one is worked at a
time.

**Only what the RECORD holds is drawn.** A batch's `newlyReady` group — became ready during the run
and deliberately not taken — has **no column**; `not_reached` is a disposition and `blocked_in_scope`
a skip reason, and those are the shapes available. A pane that drew a group the read cannot fill
would be specifying a schema change in a mock.

**Every word of the vocabulary is the shipped one**, and the notes name the source so a later reader
can check rather than trust: the stop reasons and their sentences from `packages/cli/src/autoLoop.ts`
and `packages/cli/src/batchPlan.ts` (`STOP_LABEL`), the skip reasons from `batchPlan.ts`
(`SKIP_LABEL`), the claimed-scope split and the In-Progress warning from
`packages/cli/src/scopedRun.ts` (`renderClaimedScope`).

**⚠️ AND ONE NUMBER IN THAT VOCABULARY IS NOT WHAT THE CLI FILE SAYS.** `batchPlan.ts`'s `SKIP_LABEL`
is `Record<SnapshotSkipReason, string>` and carries **six** reasons, so anything counting from that
file gets six — and the batch panel is right to draw six, because a snapshot cannot produce more.
**The RECORD's `DispatchSkipReason` has SEVEN**: the schema says outright that it is _"the union of
`SkipRecord.reason` and `SnapshotSkipReason`"_, and the extra member is **`blocked_in_scope`**, which
only a CLAIMED SCOPE can produce (the claim takes every member in the to-do category, `blocked`
included, which is not the same as being allowed to build one out of order — so such a work item is
_skipped and NAMED, never forced_). It is drawn in the claimed-scope panel, where it can occur,
rather than in the batch panel, where it cannot.

**This was found by the CODE, not by re-reading the asset** — MOTIR-1796's
`satisfies Record<DispatchSkipReason, string>` failed to compile on six, which is the whole argument
for writing these maps as `satisfies` rather than as a `switch` with a default. Every "six" in this
story's prose came from reading the batch file, and a surface total over six of seven renders the
seventh as nothing.

**It draws NO delivery.** The page this replaced showed a per-row repository / pull-request / CI
reference; the modal does not. A node LINKS to its work item, whose Development section owns delivery
and derives the one CI verdict in the product — and a second verdict on one screen is how two
surfaces start disagreeing about whether something is green. Removing it also removed the temptation
to keep a second CI vocabulary in step.

---

## The LOG pane — and its three silences are the load-bearing part

**The console treatment is `run-section.mock.html`'s**, reused rather than designed twice. What is
new is that it is a persistent pane rather than a collapsed strip, that it can be filtered to one
member or show the whole run, and that its EMPTY states carry more weight than its full one.

**Sending log bodies is opt-in and OFF by default**, enforced on the operator's own machine —
`motir help`: _"the machine that holds the content is the machine that decides whether it leaves."_
So the ordinary run has nothing here, and the pane must say why in a way that reads as the operator's
choice rather than as a failure to record.

| what happened                               | what the pane says                                               |
| ------------------------------------------- | ---------------------------------------------------------------- |
| the operator did not pass `--report-log`    | **their choice** — naming the flag is the whole remedy           |
| the run is live and has printed nothing YET | **waiting**, which is not the same as empty                      |
| the bodies were sent and have EXPIRED       | the **30-day** retention window did its job (`dispatchRunSweep`) |

One message for all three tells a person their run failed to record when in fact they chose that, or
when the record simply aged out. Collapsing them is the defect this table exists to prevent.

**Following releases the moment the reader scrolls up**, and an explicit control resumes it. A
console that yanks you back to the bottom mid-read is the classic version of this bug. Unfiltered,
each line names its source member and the order is `seq` — the RUN's order, not arrival order. A very
long line scrolls inside the console, never the page.

⚠️ **AND THE EDGE ITSELF NEVER DREW, for as long as this area has existed (found 2026-08-30).**
`.cvEdges` was `position: absolute; inset: 0` with no `width`/`height`. An SVG is a REPLACED element:
with no width/height attribute it takes its INTRINSIC size, and `inset: 0` does not stretch it the
way it stretches a div. **Every edge SVG in the asset was resolving to 16×16**, so every path drew at
about 4×6px and no edge — the running one included — was ever visible. Measured, not guessed: six
SVGs at `16x16`, and `543x315` / `461x208` once `width: 100%; height: 100%` was added.

⚠️ **AND THE ARROWHEADS WERE MISSING TOO** (Yue, 2026-08-30: _"without the arrow we don't know
which card is blocked"_). This is not decoration: the whole claim of the running edge is that it
points FROM what an agent is working TO what becomes reachable when it lands, and a plain line states
a relationship without a direction. The notes had asserted the arrow all along — _"the arrow already
points blocker → blocked"_ — while no `marker-end` existed anywhere in the asset. Every edge now
carries one, mirroring `PlanningCanvas`'s shipped markers exactly (same `viewBox`, `refX`,
`markerWidth` and `orient="auto-start-reverse"`), in their own `<svg>` for the same reason the
component's are: marker refs are document-global, and a second element inside `.cvEdges` would break
the path-count-equals-edge-count property its guard asserts.

**The IMPLEMENTATION was already correct** — `PlanningCanvas` has had a `running` marker filled
`--el-status-in-progress` since MOTIR-3972 and applies `markerEnd` to every edge. Only the design
asset was missing them, which is the same class of gap as the invisible SVG above: the thing the
notes claimed and the thing the file did had drifted apart, and nothing compared them.

Three consequences worth keeping, because they are the reason it survived review:

- **The path geometry had never been checked against the nodes**, since nothing was on screen to
  check. Every `d` was authored blind and every one was wrong — endpoints landing inside the target
  node, and one path that ran out of `MOTIR-1792`'s right edge and back into its own left edge. They
  are now derived from MEASURED node boxes, not estimated.
- **A `viewBox` + `preserveAspectRatio="none"` cannot be used here at all.** The nodes are positioned
  in CSS px, so the SVG must map one user unit to one px; a viewBox stretches the paths to the
  stage's real width while the nodes stay put. The viewBox is gone from all six.

⚠️ **The pane had no producer when it was drawn.** `DispatchEventKind.log` existed, the flag existed,
the strip and the sweep and the help text existed — and nothing in `packages/cli/src` ever emitted a
`log` event. MOTIR-3961 is the producer; without it this pane would have rendered its first silence
for every run, for ever, and looked correct doing it.

---

## What the run PRODUCED — the bug it filed and the plan it submitted

A run does two things that are not writing code, and they are the two most valuable things an
unattended run produces: it refuses a work item and submits a plan, and it files a bug for a defect
that was not its job to fix. `run-findings-protocol.md` Q1–Q4 gave it the right to do both.
**Q5 (MOTIR-3980) is what makes them visible**, and this section draws what Q5 permits — no more.

### WHERE it lives, and why not the two other places

**Pinned above the LOG, in the right pane** (panel 9), with a marker on the node in the canvas.

- **Not a band under the modal header.** A band spans both panes, so it pushes the canvas down on
  every run in order to serve the few that have anything to say.
- **Not only on the node.** The node answers _which work item produced it_; a reader arriving at a
  finished run is asking _what did this run produce_, and should not have to hunt a canvas for the
  answer.
- **The right pane is already the run's NARRATIVE column** — what the run said and what it printed.
  A strip there collapses to nothing without moving anything else on the screen.

Both are drawn because Q5 made the events **CARD-scoped**, so the record genuinely knows which leg
produced each finding. The strip and the node are the same fact at two zooms, and the node carries a
COUNT, never the strip's copy — it is an index into the strip, not a second copy of it.

### ⚠️ THE ABSENT CASE IS THE DEFAULT CASE, so it is drawn FIRST

Most runs produce neither. **A run that produced neither grows no region at all**: no heading, no
rule, no _"no findings"_ box — the log pane simply starts at the log. A region that is present and
empty on every ordinary run teaches a reader to skip exactly the place where the rare, important
thing eventually appears, which is worse than not having drawn it.

The one exception is **reporting-offline**, which is the only state where the strip appears with no
findings in it. _Silence_ and _the machine stopped reporting_ are different answers, and only one of
them means there was nothing to say.

### The PLAN in two states — an ASK and a piece of NEWS

They are the same object and completely different news, and if they look alike the more urgent one
is the one that gets missed.

|                          | what it is                                           | how it reads                                                                        |
| ------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **submitted, waiting**   | an ASK — nothing moves until a person decides        | the accent rule in `--el-status-planning`, and copy that says it is waiting for you |
| **approved by this run** | NEWS — it already happened, to the reader's own tree | no rule, no waiting language; a named list under one heading                        |

⚠️ **THE DISCRIMINATOR IS THE RULE, NOT THE PRESENCE OF AN ACTION.** Every finding on the strip
OPENS — a bug included. An earlier draft of this section made the ask the only row with a way in,
which distinguished the two by making the other rows useless: a finding a reader cannot reach is a
notification, not a finding.

Submitted-and-waiting is the COMMON case: auto-approval is opt-in and `auto`-only. Approved-by-this-run
is the one thing a run decides while nobody is watching, so it says so in the terminal's own words —
_"your tree changed while you were away."_

**⚠️ NAMED PLAN BY PLAN, NEVER A COUNT.** Not a preference: `autoLoop.ts` already settled it, in the
comment above the block that prints exactly this — _"A count would tell an operator that their tree
moved without telling them where."_ The surface prints the terminal's shape: the plan, the work item
it was approved FOR, and how many proposals it materialized.

**A re-plan is a CORRECT OUTCOME, not a failure.** `renderReplanSubmitted`'s first line says so —
_"this is a correct outcome, not a failure"_ — and a surface that rendered it in a failure tone would
teach people to distrust the most useful thing the loop does. It reuses this area's existing
`replanned` tone, deliberately neither green nor red. **No new tone is defined by this pass.**

### The BUG — additive, never collapsed, never dropped

A filed bug blocks nothing, claims no scope and did not end the run (Q3). The row says so by what it
does NOT carry: no status transition, no blocking language, nothing asking the reader to decide.

**⚠️ ADDITIVE IS NOT UNREACHABLE.** The row carries `Open →` like every other finding, and the
target needs nothing new to reach: `bug_filed.data` already holds the `key`
(`run-findings-protocol.md` Q5). The ONE row that does not open is the one whose target is GONE
(below) — silent about it, rather than offering a link into nothing.

**Several from one run stay separate rows.** _"3 bugs"_ loses the only thing a reader wants — which
three — and repeats the count mistake the approved-plans block already refuses.

**A closed or archived bug still renders.** The run found a real defect; somebody later triaged it,
and that is history this record exists to keep.

### ⚠️ A WORK ITEM'S STATUS IS NOT A RUN TONE — two vocabularies, two shapes

The pills on these rows (`Done`, `Declined`, `Archived`) are the **work item's or plan's own status**,
not a run disposition, and they are drawn as an outlined `wiPill` rather than the filled `runPill`
this area's tone table owns. This is not decoration: giving both vocabularies one pill shape is how a
reader starts reading a work item's `Done` as a statement about the RUN. The tone table above is
unchanged and gains nothing.

### Every state the record can be in

- **A DECLINED plan** keeps the run's own event wording and carries the plan's CURRENT status beside
  it. The run said _I submitted this_ and that stayed true; a person then said no. It is the most
  informative row on the page — never re-worded into a failure, never hidden.
- **A target that is GONE** — deleted, or not visible to this reader — renders from the event's own
  `data`, the key and title it recorded, with no link. ⚠️ **It is never dropped and never becomes an
  empty state**; both would tell the reader the run found nothing when it did. Same posture
  `dispatch_run_card.workItemKey` already takes for a deleted work item.
- **Reporting-offline** says the record is incomplete, not that the run produced nothing.

### What the surface may PROMISE — quoted, because it is a privacy boundary

> The run modal may state, for any run and without a `--report-log` opt-in, that this run filed these
> bugs and submitted these plans, each as a link to the live row.
>
> — `run-findings-protocol.md` Q5

Both events are LIFECYCLE, so none of this sits behind the log-body opt-in; Q5's privacy section is
explicit that a BYOK-local run sends no additional byte to produce either. **The strip never
summarises** a plan's contents or a bug's body: the record carries a pointer and a title, and a panel
showing more than that would be a design specifying a privacy change.

---

## At scale — two different growth curves, two different answers

| surface       | what grows                                                     | drawn against | the decision                                                                                                                                                                                                           |
| ------------- | -------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/runs`       | **unbounded, forever** — run headers are append-only           | **25 a page** | **PAGE.** Cursor, not offset, so a run opened mid-read cannot shift a row across the boundary                                                                                                                          |
| the run MODAL | bounded by the SCOPE — a sprint run claims tens, not thousands | **40 nodes**  | **The canvas's own** — it pans, zooms and drills, and `design/roadmap/` already decided how it behaves past a screenful. This asset adds no second scale rule; what it owes is the stored ORDER the level is served in |

**The index grows and never shrinks**, because the retention sweep clears event BODIES after 30 days
and removes no rows: a project running `motir auto` nightly accumulates a run per night for as long
as it lives. A load-everything read there is not a shortcut, it is a page that gets slower every day.
**Paging rather than virtualization** because the live section is short by construction and the past
section is what grows, so there is one growing list with a natural stopping point — a reader looking
for last week's run pages, they do not scroll. The order is `startedAt DESC, id DESC`, **total**
because the id breaks the tie.

**The run view's set is bounded by its scope** and a reader wants the whole ordered list rather than
a scrolling window, so it pages past 40 and never virtualizes. Neither surface issues an unbounded
read: the set is fetched with the run, and the events stream separately.

---

## THE TONE VOCABULARY

**Defined once, here, and consumed by every run surface in the product.** The run view
(MOTIR-3893) reads this table rather than writing a second one — a design area with two authors and
no owner ends up with two status vocabularies for the same states, which is how one product acquires
two visual languages for _failed_.

**The shape of every tone is the same**: a tinted background carrying `--el-text-strong`, with the
hue in a **7px dot** rather than in the ink. That is the AA-safe pairing `CLAUDE.md`'s measured table
requires (a coloured chip puts the hue in the tint BACKGROUND, never in the text), and it means a
status is legible in a compact chip and in a table row without a second treatment.

| Status                | Background           | Dot                       | Why this tone                                                                                           |
| --------------------- | -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| **queued**            | `--el-muted`         | `--el-status-todo`        | Owned by a run, not started. Neutral because nothing has happened yet.                                  |
| **running**           | `--el-tint-sky`      | `--el-status-in-progress` | The product's existing In-Progress hue, so a run in flight reads like work in flight.                   |
| **integrated**        | `--el-tint-mint`     | `--el-status-done`        | On a session branch. Success tone; the delivery section says whether it merged.                         |
| **implemented**       | `--el-tint-mint`     | `--el-status-done`        | Its own pull request is open. Shares integrated's tone: to a reader both mean _the agent finished_.     |
| **failed**            | `--el-tint-rose`     | `--el-danger`             | **The only danger tone in the set.** Reserve it — everything else here is a legitimate ending.          |
| **re-planned**        | `--el-tint-lavender` | `--el-status-planning`    | The Planning hue. Neither green nor red, which is the entire point of the row.                          |
| **skipped**           | `--el-muted`         | `--el-text-tertiary`      | A decision the run made. **Always shown WITH its reason**; a bare "skipped" says nothing.               |
| **cancelled**         | `--el-muted`         | `--el-status-cancelled`   | Somebody pressed Ctrl-C. A decision, not a fault.                                                       |
| **timed out**         | `--el-tint-peach`    | `--el-warning`            | Written by the server's reap, never by a client. Warning rather than danger: _unknown_ is not _failed_. |
| **reporting-offline** | `--el-tint-peach`    | `--el-text-tertiary`      | The RECORD is incomplete, not the run. Warning ground, NEUTRAL dot — deliberately not danger.           |

**Ten statuses, five backgrounds, and the collisions are deliberate.** `integrated` / `implemented`
are one outcome to a reader; `queued` / `skipped` / `cancelled` are all "nothing ran", told apart by
their dot and their label rather than by a sixth tint nobody could name. Inventing five more hues
would make the palette carry a distinction the reader does not need and the token layer cannot swap
coherently.

**Two rules the table encodes, and both are refusals:**

- **Never invent a hue.** Every dot above is an existing `--el-*` token. A run state is not a reason
  to add a colour.
- **Never signal a run state with a border style.** No dashed, dotted or doubled border anywhere in
  this area. A border style is not a state signal — it is invisible at a glance, it collides with
  the dashed rings and outlines the product already uses for other meanings, and it survives no
  palette.

### The two states that get improvised if nobody draws them

- **RE-PLANNED.** The agent read the work item, found its premise false, reverted, submitted a plan and
  exited **0**. It is neither a success nor a failure and will be drawn as one of them by whichever
  work item passes through it first. Its body says what to do next, because a state whose entire content
  is _somebody must look at this_ is useless without the link.
- **REPORTING-OFFLINE.** The run happened; the record did not. Reporting is best-effort by design —
  a 500, an expired token or a dead network must never break a run — so what reaches Motir is a run
  that opened and then went quiet. **It must not read as a failed run**: the work may have shipped
  perfectly. A hosted run can never be in this state, which is exactly why it is the one most likely
  to be missed.

---

## Every state, and where it is drawn

| State                              | `run-section.mock.html` | Note                                                                                                                      |
| ---------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| empty — "nothing has run"          | panel 8                 | **Must not read as an error**: muted glyph, one sentence of fact, the command that changes it.                            |
| running                            | panel 1                 | The live timeline, one row per card-scoped event, with the "one of N" line when the run covers a set.                     |
| succeeded (implemented)            | panel 2                 | The terminal disposition, and the log console is deliberately absent.                                                     |
| failed                             | panel 4                 | The body says the work item stays In Progress and nothing was reverted.                                                   |
| re-planned                         | panel 3                 | Links to the plan.                                                                                                        |
| cancelled                          | panel 5                 | Neutral tone: a decision, not a fault.                                                                                    |
| timed out                          | panel 5                 | Warning tone. The copy says what is unknown, not what failed.                                                             |
| **reporting-offline**              | panel 6                 | The notice names which of the two facts is missing and points at Development for what shipped.                            |
| stream-reconnecting                | panel 7                 | **A transport state, not a run state**: the notice sits above the timeline and the run's own pill keeps saying _Running_. |
| **skipped — this work item's leg** | panel 9                 | A run owned this work item and decided not to work it. **A skipped row is a real row**, always carrying its reason.       |
| queued (in a run)                  | panel 12 (tone)         | Only meaningful where a run owns a work item it has not reached.                                                          |

**The two PAGES have their own states, and the overlap is smaller than it looks** — the section is a
panel about ONE work item, so most of its states are about that work item's leg; a page is about a RUN, so most
of its states are about the run and the list.

| State                              | `runs-index.mock.html` | `run-modal.mock.html` | Note                                                                                             |
| ---------------------------------- | ---------------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| nothing has run at all             | panel 3                | —                     | Muted glyph, one sentence, the command that changes it. **Never an error face.**                 |
| one side of the partition empty    | panel 2                | —                     | The live section states the fact and keeps its shape rather than disappearing.                   |
| a live run                         | panel 1                | panel 1               | The index shows one row; the view shows the whole set around it.                                 |
| a run with NO work items           | panel 4                | panel 6               | A real outcome, in the neutral tone — never an error.                                            |
| a run whose SCOPE item was deleted | panel 4                | —                     | The row survives it: the record stores the scope LABEL beside the id.                            |
| a LEG whose work item was deleted  | —                      | panel 8               | The leg keeps its key, disposition and duration; only the link is absent.                        |
| loading                            | panel 5                | —                     | An in-page `<Suspense>`, **never a `loading.tsx`** — see the index section above.                |
| a failed read                      | panel 5                | —                     | Says what failed and offers the retry; must not share a face with the empty state.               |
| queued — claimed, nothing started  | —                      | panel 6               | The moment a person is most likely to press Ctrl-C, so it must be readable at t=0.               |
| finished, once per stop reason     | —                      | panel 7               | `halted` and `drained` are opposite news. **`replanned` is a SUCCESS** — the agent was right.    |
| interrupted                        | —                      | panel 7               | Cancelled tone: a decision, not a fault.                                                         |
| timed out                          | —                      | panel 7               | Written by the server's reap, never by a client. Warning, not danger: _unknown_ is not _failed_. |
| **reporting-offline**              | —                      | panel 8               | The record is incomplete, not the run. Points at each work item's Development section.           |
| stream-reconnecting                | —                      | panel 8               | A TRANSPORT state: the notice sits above the table and the run's pill keeps saying _Running_.    |
| at scale                           | panel 6                | panel 9               | 25 rows a page · 40 rows before the set pages. See _At scale_ above.                             |
| **produced NEITHER** — the default | —                      | panel 9               | **No region at all.** The log pane starts at the log. Drawn first, because it is most runs.      |
| a plan SUBMITTED, waiting          | —                      | panel 10              | An ASK: the accent rule and the strip's only action. `replanned` tone — a success, not a fault.  |
| plans APPROVED by this run         | —                      | panel 10              | NEWS, named plan by plan. **Never a count** — `autoLoop.ts` settled that and the surface obeys.  |
| a bug FILED — one, or several      | —                      | panel 11              | Separate rows always, each with `Open →`. Additive ≠ unreachable: nothing moved, but you can go. |
| a bug since CLOSED or ARCHIVED     | —                      | panel 11              | Still renders, with the WORK ITEM's own status pill — not a run tone.                            |
| a plan since DECLINED              | —                      | panel 12              | The run's wording is kept and the plan's current status rides beside it. Never hidden.           |
| a finding whose TARGET is gone     | —                      | panel 12              | Drawn from the event's `data` alone, unlinked. **Never dropped, never an empty state.**          |
| reporting-offline, with findings   | —                      | panel 12              | The only state where the strip appears carrying none: incomplete ≠ produced nothing.             |

---

## The log console

Present **only** when the run was started with `--report-log`
(`docs/decisions/dispatch-run-record.md` Q4). Drawn in `run-section.mock.html` panel 10, in both
faces:

- **Collapsed by default, never an always-expanded wall of text.** The item page is where a person
  reads the CARD; a live log is the loudest thing on any page it appears on.
- **Open, it follows the tail** inside a capped scroll region (`max-height: 190px`), and the
  _following_ chip is a state rather than a control.
- **Closed and empty is the ORDINARY case**, and it states the promise — _"Your agent's output
  stayed on your machine"_ — rather than showing a blank box, because a blank box reads as a failure
  to record.
- The footer states the **30-day** retention, because that is the half of the promise the flag makes.

**The opt-in control is not on this surface, and that is where the decision put it.** `--report-log`
is a CLI flag (and a `reportLogBodies` config key); there is deliberately no server-side setting,
because the machine that holds the content is the machine that decides whether it leaves. The
surfaces therefore STATE the boundary and never offer to change it — a workspace admin flipping a
switch that exfiltrates somebody else's laptop is the exact shape the decision refuses.

---

## Primitives and tokens

**Primitives composed** (nothing hand-rolled that a primitive owns):

| Primitive                              | Used for                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| `ContentSectionCard` + `Card`          | the section's chrome, header row and body padding — the late stack's own grammar |
| `Pill`                                 | every run-status chip                                                            |
| `Button` (ghost, `sm`)                 | "Show more" on the recent-runs list                                              |
| the shipped `TableShell` / `Th` / `Td` | both pages' tables — the jobs dashboard's grammar, composed rather than rebuilt  |
| the shipped `Sidebar` row              | the rail entry in the index's access-path panel                                  |

**Shape tokens** — every surface's own box, nothing raw:

| Element                      | Tokens                                                                   |
| ---------------------------- | ------------------------------------------------------------------------ |
| the section card             | `--radius-card` · `--spacing-card-padding` · `--shadow-card`             |
| every run-status pill        | `--radius-badge` · `--spacing-chip-x` / `--spacing-chip-y`               |
| the log console              | `--radius-control` · `--spacing-control-x` / `--spacing-control-y`       |
| a table cell (both pages)    | `--spacing-control-x` / `--spacing-control-y`, on `--radius-card` chrome |
| a rail row                   | `--radius-control` · `--spacing-control-x` / `--spacing-control-y`       |
| the "Show more" button       | `--radius-btn` · `--height-btn-sm` · `--spacing-btn-x-sm`                |
| the timeline / list dividers | `--el-border-soft`                                                       |

**Ink**: body text is `--el-text`; every secondary line is **`--el-text-secondary`**, which clears AA
on all four surfaces in both themes. `--el-text-muted` is used **nowhere** in this area — it fails AA
on `--el-surface`, `--el-surface-soft` and `--el-muted`, and both the section body and the console
head sit on `--el-surface-soft`. `--el-text-faint` is used nowhere at all.

---

## Where each behaviour came from

| Behaviour drawn here                                                            | Decided by                                                                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| the CARD-SCOPED event vocabulary the timeline renders                           | `docs/decisions/dispatch-run-record.md` **Q2** (MOTIR-1790)                                             |
| the disposition vocabulary the tone table covers                                | the same decision's `DispatchCardDisposition` and `DispatchStopReason`                                  |
| a run covers a SET, so a work item can be "4 of 11"                             | the same decision's **Q1**                                                                              |
| the pull request and CI are NOT the run's                                       | the same decision's **Q3**, boundary 1                                                                  |
| the log console, its opt-in, and the 30-day retention                           | the same decision's **Q4**                                                                              |
| reporting is best-effort, hence _reporting-offline_ as a first-class state      | MOTIR-1794 (the CLI reporter) — the emissions this visualises                                           |
| ordering by `seq`, hence a resumable stream and the reconnecting notice         | MOTIR-1791 (`@@unique([dispatchRunId, seq])`) and MOTIR-1793 (the `?since=` cursor)                     |
| SSE rather than a WebSocket, and the terminal `done` frame that closes it       | MOTIR-1793's stream route, which mirrors the shipped plan-generation stream                             |
| the three SET shapes, and that a single work item is the degenerate case of one | `packages/cli/src/scopedRun.ts` (`renderClaimedScope`) and `packages/cli/src/batchPlan.ts` (`Snapshot`) |
| every stop reason and its sentence                                              | `packages/cli/src/autoLoop.ts` + `packages/cli/src/batchPlan.ts` (`STOP_LABEL`)                         |
| the six skip reasons and their sentences                                        | `packages/cli/src/batchPlan.ts` (`SKIP_LABEL`)                                                          |
| the In-Progress-from-t=0 warning, in the words the terminal prints              | `packages/cli/src/scopedRun.ts`                                                                         |
| the rail convention every top-level view follows                                | `app/(authed)/_components/SidebarNav.tsx` + `design/shell/design-notes.md`                              |
| the nav row's registration, and that omitting it hides the page silently        | `lib/settings/projectNavAccess.ts` and its own header                                                   |
| the table grammar the two pages compose                                         | `app/(authed)/settings/workspace/jobs/_components/JobsDashboard.tsx` (`TableShell` / `Th` / `Td`)       |
| the run history is "every run that carried a leg for this work item"            | MOTIR-1793's read                                                                                       |
| the late stack's ONE settle                                                     | `design/work-items/design-notes.md` § _The item page at ARRIVAL_ (MOTIR-3432, amended by MOTIR-3465)    |

---

## Out of scope — a deliberate later AMENDMENT, not a second surface

**MOTIR-691 (9.1.1) amends THESE surfaces; it does not draw new ones.** The hosted mode adds:

- a **"Run hosted"** kick-off control,
- an **agent selector**,
- a **cancel** control,
- and a **token-usage / credit-cost** block.

None of them is drawn here, and the cost block in particular is not a gap: **a BYOK run has no
credit cost**, because it never touches the gateway. Room is left for the first three in the
section's header (`.secRight` currently carries only the status pill) and for the cost block below
the meta row.

Also out of scope: **the design-approval gate** (MOTIR-693 / 9.2) and **cross-project run rollups**
(Epic 10 / MOTIR-732), both of which have their own homes.
