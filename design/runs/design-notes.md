# `design/runs/` — watching an agent work

The design area for **agent runs**: the record of what a dispatch run did, and the surfaces a person
watches it on. New area, created by **Story MOTIR-1789 · MOTIR-1795**.

A run is the thing Motir has never been able to show. Someone hands it a whole story, eleven work
items go _In Progress_ at once and stay that way for an hour, and the complete account of which one
is being worked, which were skipped and why, and where it stopped exists in a terminal on one
machine and is gone when the window closes. These surfaces are that account, in the product.

---

## The surfaces

| Surface                            | Asset                                           | What it settles                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The run SECTION on a work item** | **`run-section.mock.html`** + `run-section.png` | The card's own run: its live timeline over the CARD-SCOPED event vocabulary, the "one of N" link-out when the run covers a set, this card's recent runs as a paged list, and the collapsed log console. Every terminal state, including the two that get improvised when undrawn — **re-planned** and **reporting-offline**. **Also carries this area's TONE TABLE** (panel 12), which every other run surface consumes. MOTIR-1795 (design). Gates MOTIR-1796. |
| **The run VIEW** (`/runs/[id]`)    | _MOTIR-3893's — not in this folder yet_         | The whole SET a scoped or batch run works: every card's disposition, the skips and their reasons, and the run's own states. It **consumes this folder's tone table** rather than defining a second one, and adds its own row to this table when it lands.                                                                                                                                                                                                       |
| **The RUNS INDEX** (`/runs`)       | _MOTIR-3893's — not in this folder yet_         | Every run the project has made, current and past, with its own primary-nav entry. It is the surface that makes a run FINDABLE at all, and it is what replaced the `/ready` strip this area used to draw (below). Same design card as the run view, same tone table.                                                                                                                                                                                             |

### ⚠️ WHAT THIS AREA DREW ONCE AND WILL NOT DRAW AGAIN — the `/ready` run STRIP

An earlier revision of this area carried a third surface: `ready-strip.mock.html`, a live-run
indicator on a `/ready` row, drawn in both states and measured to cost the row no height. **It is
deleted, and the reason is not taste — the row it decorated cannot occur.** `/ready` renders
`workItemsService.listReady`, whose `collectReadyLeaves` collects only _the ready, childless `todo`
leaves_, and `claimNextReady` / `claimScope` flip every claimed card to `in_progress` **before** the
first agent starts. A card with a live run has therefore left the list the strip lives on, by
construction — the transition that creates the state worth indicating is the transition that removes
the row.

The asset had noticed half of this and stopped one step short: its own state table said _"a finished
card has left the ready set, so no strip state exists for it"_, which is the same sentence one word
away from being true of a RUNNING card.

**What the strip was FOR is now the runs index**, which is reachable from the rail rather than from
the one page a run's cards have just left. Recorded on MOTIR-3914; the archived card is MOTIR-1797.

---

## What this area does NOT draw

Three boundaries, each because the fact already has an owner and a second drawing of it is how one
product acquires two answers to one question.

1. **Pull requests and their CI belong to the DEVELOPMENT section.** One card up the same stack,
   drawn at `design/work-items/delivery-set.mock.html`. The run section names a pull request in its
   timeline as an EVENT — _"pull request linked"_ — and draws no state for it. `run-section.mock.html`
   panel 11 draws the two adjacent so the relationship is legible; that panel is the whole of what
   this area says about a pull request.
2. **The work item's STATUS belongs to the board.** A run is not a status and must not read as one.
   This whole area exists _because_ the status column has stopped being able to answer — a scoped run
   puts eleven cards at _In Progress_ simultaneously, so the column reports the run's footprint and
   not its cursor — and a run surface that looked like a second status pill would be re-drawing the
   thing it exists to compensate for.
3. **Tokens, usage and cost are not drawn at all**, and not because they are "not yet": a BYOK run
   never touches the gateway and has no cost. See _Out of scope_ below.

## What it composes

| Host                                                                           | Composed how                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design/work-items/` + `app/(authed)/items/[key]/_components/LateSections.tsx` | The run section is a **new row in the item page's tier table** (below). It is `ContentSectionCard`'s header grammar over `Card`, in the LATE STACK. The host's layout, header, rail and navigation are cited, never re-specified. |

---

## Placement: the run section joins the late stack, after Development

`design/work-items/design-notes.md` § _The item page at ARRIVAL, and while it STREAMS_ allocates the
page in three tiers. The run section is a **sixth late region**, and its row in that table reads:

| Region                                              | Tier               | Its pending face                                                         |
| --------------------------------------------------- | ------------------ | ------------------------------------------------------------------------ |
| Development (linked PRs + CI)                       | **AFTER the page** | card chrome + row-shaped pulse bars                                      |
| **Run (this card's live run, and its recent runs)** | **AFTER the page** | **card chrome + row-shaped pulse bars — the same face Development uses** |
| Acceptance                                          | **AFTER the page** | card chrome + a two-line body pulse                                      |
| Design result                                       | **AFTER the page** | card chrome + a thumbnail-shaped pulse                                   |
| Attachments                                         | **AFTER the page** | tile-shaped pulse skeletons                                              |
| Activity                                            | **AFTER the page** | comment-row-shaped pulse skeletons                                       |

**Directly after Development, and adjacency is the argument.** Development answers _did it ship_;
the run answers _what happened while it was being made_. A reader who has just read one wants the
other without scrolling past Acceptance and Design result to find it — and the two share a boundary
of meaning that panel 11 draws explicitly.

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

- **RE-PLANNED.** The agent read the card, found its premise false, reverted, submitted a plan and
  exited **0**. It is neither a success nor a failure and will be drawn as one of them by whichever
  card passes through it first. Its body says what to do next, because a state whose entire content
  is _somebody must look at this_ is useless without the link.
- **REPORTING-OFFLINE.** The run happened; the record did not. Reporting is best-effort by design —
  a 500, an expired token or a dead network must never break a run — so what reaches Motir is a run
  that opened and then went quiet. **It must not read as a failed run**: the work may have shipped
  perfectly. A hosted run can never be in this state, which is exactly why it is the one most likely
  to be missed.

---

## Every state, and where it is drawn

| State                         | `run-section.mock.html` | Note                                                                                                                      |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| empty — "nothing has run"     | panel 8                 | **Must not read as an error**: muted glyph, one sentence of fact, the command that changes it.                            |
| running                       | panel 1                 | The live timeline, one row per card-scoped event, with the "one of N" line when the run covers a set.                     |
| succeeded (implemented)       | panel 2                 | The terminal disposition, and the log console is deliberately absent.                                                     |
| failed                        | panel 4                 | The body says the card stays In Progress and nothing was reverted.                                                        |
| re-planned                    | panel 3                 | Links to the plan.                                                                                                        |
| cancelled                     | panel 5                 | Neutral tone: a decision, not a fault.                                                                                    |
| timed out                     | panel 5                 | Warning tone. The copy says what is unknown, not what failed.                                                             |
| **reporting-offline**         | panel 6                 | The notice names which of the two facts is missing and points at Development for what shipped.                            |
| stream-reconnecting           | panel 7                 | **A transport state, not a run state**: the notice sits above the timeline and the run's own pill keeps saying _Running_. |
| **skipped — this card's leg** | panel 9                 | A run owned this card and decided not to work it. **A skipped row is a real row**, always carrying its reason.            |
| queued (in a run)             | panel 12 (tone)         | Only meaningful where a run owns a card it has not reached.                                                               |

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

| Primitive                     | Used for                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `ContentSectionCard` + `Card` | the section's chrome, header row and body padding — the late stack's own grammar |
| `Pill`                        | every run-status chip                                                            |
| `Button` (ghost, `sm`)        | "Show more" on the recent-runs list                                              |

**Shape tokens** — every surface's own box, nothing raw:

| Element                      | Tokens                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| the section card             | `--radius-card` · `--spacing-card-padding` · `--shadow-card`       |
| every run-status pill        | `--radius-badge` · `--spacing-chip-x` / `--spacing-chip-y`         |
| the log console              | `--radius-control` · `--spacing-control-x` / `--spacing-control-y` |
| the "Show more" button       | `--radius-btn` · `--height-btn-sm` · `--spacing-btn-x-sm`          |
| the timeline / list dividers | `--el-border-soft`                                                 |

**Ink**: body text is `--el-text`; every secondary line is **`--el-text-secondary`**, which clears AA
on all four surfaces in both themes. `--el-text-muted` is used **nowhere** in this area — it fails AA
on `--el-surface`, `--el-surface-soft` and `--el-muted`, and both the section body and the console
head sit on `--el-surface-soft`. `--el-text-faint` is used nowhere at all.

---

## Where each behaviour came from

| Behaviour drawn here                                                       | Decided by                                                                                           |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| the CARD-SCOPED event vocabulary the timeline renders                      | `docs/decisions/dispatch-run-record.md` **Q2** (MOTIR-1790)                                          |
| the disposition vocabulary the tone table covers                           | the same decision's `DispatchCardDisposition` and `DispatchStopReason`                               |
| a run covers a SET, so a card can be "4 of 11"                             | the same decision's **Q1**                                                                           |
| the pull request and CI are NOT the run's                                  | the same decision's **Q3**, boundary 1                                                               |
| the log console, its opt-in, and the 30-day retention                      | the same decision's **Q4**                                                                           |
| reporting is best-effort, hence _reporting-offline_ as a first-class state | MOTIR-1794 (the CLI reporter) — the emissions this visualises                                        |
| ordering by `seq`, hence a resumable stream and the reconnecting notice    | MOTIR-1791 (`@@unique([dispatchRunId, seq])`) and MOTIR-1793 (the `?since=` cursor)                  |
| the run history is "every run that carried a leg for this card"            | MOTIR-1793's read                                                                                    |
| the late stack's ONE settle                                                | `design/work-items/design-notes.md` § _The item page at ARRIVAL_ (MOTIR-3432, amended by MOTIR-3465) |

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
