# Audit coverage — design notes

Design reference for the **audit-coverage nudge** — the surface that tells a project admin one or
more connected repositories have never been assessed, and sends them to `/code-health` to fix it.

**Card:** MOTIR-2246 (Story MOTIR-2244 — audit coverage) · **Date:** 2026-08-05 ·
**Gates:** MOTIR-2250 (the build card), which is `blocked_by` this.
**Evidence pinned at:** `motir-core` `origin/main` @ `b82ed141`.

**Asset set:** `design-notes.md` (this file) + `audit-coverage.mock.html` (the source of truth) +
`audit-coverage.png` / `audit-coverage.dark.png` (exports rendered from it).

**This asset ADDS a surface and REDRAWS nothing.** Nothing in `design/coding-convention/` is
touched — the destination this nudge links to is drawn there, by MOTIR-2245's Panel 8.

---

## 1 · The surface, and the ACCESS PATH in both directions

The nudge renders on **`/planning`** — the universal planning workspace
(`app/(planning)/planning/page.tsx` → `PlanningWorkspaceHost`).

**How a person reaches the surface the nudge sits on:** by planning. `/planning` is what
"Plan with AI" opens on an established project (the TopNav pill, the FAB, ⌘K, the roadmap empty
state — every launcher resolves to this one route via `planningWorkspaceHref()`). There is no
separate door to the nudge and none is invented: **the nudge is found by doing the work it is
about.**

**Where the nudge's own link lands:** `/code-health`, on the **Audit** tab, arriving on the state
**MOTIR-2245's Panel 8a** draws — the repo list with a per-row _Audit this repo_ on every
un-audited row and _Audit the {n} with no report_ in its header. One click from nudge to remedy.
Panel 8 §4 owns what that arrival looks like (it does not re-order the list, and adds no deep-link
parameter); this asset owes the link's **label** and its destination, not the destination's layout.

**Why `/planning` and not a global banner.** Rung-1 evidence already checked and recorded on
MOTIR-1754: Linear surfaces integration state as a banner **on the affected object**, not a global
nag; Jira makes connected code a first-class project surface. The object affected by a missing audit
is **the plan** — the planner reads a repo's convention and audit when it decomposes code-shaped
work. `/code-health` itself gets no banner: its repo list already carries the state per row, and
MOTIR-2245 gives that row its trigger.

### Placement inside the shipped workspace

`PlanningWorkspaceHost`'s canvas column already has exactly the seam this needs: a top bar
(`Close · ⎋` + the project name), then a `min-h-0 flex-1` canvas. **The nudge is a full-width strip
BETWEEN the top bar and the panes** — above BOTH the canvas and the conversation.

Two consequences, both deliberate:

- it is **full-bleed and flush** — edge to edge, no gap above, square corners, a `--el-border-soft`
  bottom rule, so it is a band of chrome rather than an object on the plan;
- it **never scrolls away** with the tree and **never narrows** the conversation pane;
- it **does not gate planning**. It is one line above the work; the workspace is fully usable with it
  on screen, and it is on screen whenever the condition holds (§4).

The mock draws the workspace frame only far enough to place the strip. **The canvas, the rail and
the composer are not redrawn** — they are `design/ai-chat/planning-workspace.mock.html`'s
(MOTIR-1193) and stay there.

---

## 2 · The states

|        | Condition                                                         | What renders                                    |
| ------ | ----------------------------------------------------------------- | ----------------------------------------------- |
| **A**  | ≥1 connected repo with no audit **and** viewer is a project admin | The banner — one line: count, consequence, link |
| **B**  | —                                                                 | **There is no dismissed state.** See §4         |
| **C1** | Zero un-audited repos                                             | **Nothing.** No strip, no reserved gap          |
| **C2** | ≥1 un-audited repo, viewer is **not** a project admin             | **Nothing** — drawn IDENTICAL to C1             |
| **D**  | A, with MOTIR-1764's code-context element also present            | See §5                                          |

**C is drawn rather than described** because an absence that is only written down is an absence the
build improvises. C1 and C2 are rendered side by side, identical, so the rule is visible.

---

## 3 · Anatomy — the shipped `SettingsBanner`, one line, FULL-BLEED

**It is a BANNER, not a card.** It spans the workspace **edge to edge** and sits **FLUSH** against
the top bar — no gutter either side, no gap above. The measured height is **41 px** (one text line
plus its bottom rule), and that number is the design, not an incidental outcome of it (§4).

The box is the shipped `SettingsBanner`
(`app/(authed)/settings/workspace/_components/gitSettingsPrimitives.tsx`), reused whole:

| Element    | Token / primitive                                                                      | Note                                                                                              |
| ---------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| container  | `role="status"` · `--radius-card` · `px-(--spacing-card-padding)` · `py-3` · `text-sm` | the shipped `SettingsBanner` box, verbatim                                                        |
| fill + ink | `--el-callout-bg` / `--el-callout-text`                                                | its **info** tone — the hue is in the fill with strong ink (finding #35 / AA)                     |
| lead glyph | lucide `folder-git-2`, 16 px, `currentColor`                                           | the same glyph `/code-health`'s **not-audited** row uses, so the signal and its destination match |
| message    | one sentence: **bold** count clause + plain consequence clause                         |                                                                                                   |
| link       | inline, `currentColor`, underlined, semibold, trailing                                 | `Review code health`                                                                              |

**The ONE deviation from `SettingsBanner`: the dropped `--radius-card`.** It follows from the full
bleed — a rounded corner only reads as a corner when there is margin outside it, and at full width
there is none. Everything else is `SettingsBanner`'s unchanged: the `role="status"`, the
`--el-callout-bg` / `--el-callout-text` pair, `py-3`, `text-sm`. The `--el-border-soft` bottom rule is
borrowed from the workspace's own top bar, so the banner reads as **one more band of workspace
chrome** rather than a floating object placed on the plan. That is the point of the full bleed: a
chrome band is easier to read past than a card, which is what "ignorable" has to mean here.

**What a banner cannot carry, and where it went instead.** The earlier draft of this asset was a
`DeepenAuditCard`-style aside with a heading, a paragraph and a Pill per repository. **The repo NAMES
are the one thing that did not survive the compression** — five `owner/name` chips cannot sit on one
line. That is an accepted trade, not an oversight: the banner carries the **count**, and the
destination it links to lists the repositories by name, per row, with their triggers (MOTIR-2245
Panel 8). A person who wants to know _which_ is one click from the page that answers it properly.

**No heading, no card, no glyph column, no repo list, no dismiss.** Every one of those was in the
first draft and every one is gone; what is left is a sentence and a link.

**No invented colour, no raw shape.** The mock inlines the real token layer from the shipped
`design/coding-convention/convention.mock.html`, so every value resolves through Tier-3 `--el-*` and
the element-semantic shape tokens.

---

## 4 · It is ALWAYS present, and there is NO dismiss (Yue, 2026-08-05)

> **The rule: the banner renders on EVERY visit to `/planning` for as long as a connected repository
> has no audit. There is no ×, no dismissed state, and nothing persisted.**

This **supersedes** this asset's first draft, which specified a session-scoped dismissal with a
collapsed one-line re-open (following `DeepenAuditCard`). Yue's direction: _"it should be a banner
not blocking the planning surface, the user can ignore that and continue planning. it should show
everytime in the planning surface if audit is not done."_

**The non-blockingness is SIZE, not dismissibility.** The reason a person may ignore this is that it
is one quiet line above the work — not that they are handed a control to make it go away. That
reframing is what makes the dismiss unnecessary rather than merely optional, and it is why §3's 41 px
is a load-bearing number: **any growth in this banner's height is a regression against this
decision.**

Three consequences worth stating, because they are why the earlier decision was worse:

1. **A dismiss on a SELF-CLEARING signal only ever hides a true statement.** The state it would
   persist — _"this person has seen it"_ — has no bearing on whether the plans being made right now
   are being made without the repository's recorded standards, which is the fact the line reports.
   **The remedy IS the dismissal:** audit the repositories and the banner is gone, one click away in
   the link it already carries.
2. **It removes a whole class of bug.** A persisted dismissal keyed on anything coarser than the
   exact repo set silences a _different_ problem later — connect a new repository next month and the
   banner about IT is suppressed by a click from today. That is precisely the complexity
   `ExpansionNudgeBanner`'s state-derived `localStorage` key exists to manage. With no dismiss, none
   of it is built and none of it can go wrong.
3. **The "two shipped precedents disagree" question dissolves.** The first draft had to arbitrate
   between `ExpansionNudgeBanner`'s persisted dismissal and `DeepenAuditCard`'s session one. Neither
   applies: this is not an aside with a dismissal lifetime, it is a status line with a condition. It
   follows `SettingsBanner` — which has no dismiss either — and no third pattern is invented.

**For the build card:** no preference, no `localStorage` key, no migration, no `useState` for
visibility. The component renders iff `canManage && notAuditedCount > 0`.

---

## 5 · The shared region — the allocation, and how small the overlap actually is

MOTIR-1764 is drawing a code-context affordance for the **same** strip on `/planning`
(built by MOTIR-1768). The two signals are genuinely different — _no repo connected_ / _the graph is
behind_ versus _a connected repo was never assessed_ — and the failure mode is two stacked banners.

**Read against MOTIR-1764's card body (its asset is not drawn yet — verified: there is no
`design/code-context/` on `origin/main`), three of its five states can NEVER co-occur with this
banner. They are logically exclusive, not merely unlikely:**

| MOTIR-1764 state                           | Requires             | Co-occurs? |
| ------------------------------------------ | -------------------- | ---------- |
| **A** — no repo connected, work shipped    | zero connected repos | **Never**  |
| **B** — no repo connected, nothing shipped | zero connected repos | **Never**  |
| **C** — connected and current              | ≥1 connected repo    | **Yes**    |
| **D** — connected but stale                | ≥1 connected repo    | **Yes**    |
| **E** — planning without code context      | no code context      | **Never**  |

This banner requires **≥1 connected repository with no audit**. A, B and E all require **zero**
connected repositories. You cannot have both.

**So the whole worry reduces to ONE case: C / D beside this banner** — a repository can be indexed,
current, and never assessed. And there the two are different KINDS of element: C/D is a per-repo
**status line** (repo · short sha · indexed when), this is a **banner** carrying a consequence and a
link.

> **The rule: at most ONE banner in the strip at a time**, and the strip's total height stays **one
> banner plus one status line**. A status line does not count against the banner budget. Order:
> status line above banner (state before prompt), which is what the mock's panel D draws.

### The allocation table, element by element (`notes.html` #214)

| Element                            | Owner                   | This asset                                                                                    |
| ---------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| The connect prompt (A/B)           | MOTIR-1764 / 1768       | **gives** — declared mutually exclusive, so it never has to share                             |
| Per-repo index freshness (C/D)     | MOTIR-1764 / 1768       | **gives** — the one-banner rule + the status-above-banner order + the strip's height budget   |
| The code-blind planning signal (E) | MOTIR-1764 / 1768       | **gives** — declared mutually exclusive                                                       |
| The strip itself (the region)      | shared                  | **gives** — its placement (between top bar and panes) and the height budget, stated once here |
| The audit-coverage banner          | this asset / MOTIR-2250 | —                                                                                             |
| The arrival at `/code-health`      | MOTIR-2245 Panel 8      | **takes nothing** — this asset owes the link's label and destination only                     |
| The repo NAMES                     | MOTIR-2245 Panel 8      | **gives** — §3 hands the naming job to the destination, which already lists them per row      |

**TAKES from a sibling card: none.** This asset removes no element from MOTIR-1764 or MOTIR-1768 and
narrows no criterion of theirs — the mutual exclusivity means it never competes for what they own,
and the one-banner rule constrains the region rather than reassigning anything in it.

**TAKES from its OWN card and its build card: yes, and both are swept in this pass.** MOTIR-2246's
criteria required a _dismissed_ state and a recorded _dismissal decision following a precedent_, and
MOTIR-2250's required _"Dismissal behaves as the design records, including how the nudge returns."_
§4 removes dismissal entirely, so both were amended to require the opposite: the banner is always
present while the condition holds, and no preference or persisted state is built.

> **The seam, named so it is a deliberate choice rather than discovered drift.** If MOTIR-1764's
> design pass later draws C/D as a **banner** rather than a status line, that is a second banner in
> one strip and **it must adopt the one-banner rule above** — deciding which of the two wins when
> both apply. It reads this section first, exactly as Panel 7 §9 asked it to read that panel's row
> anatomy.

---

## 6 · Admin-only is drawn as a RULE

**A viewer without project-manage capability sees NOTHING** — not a disabled control, not a
read-only variant, not the collapsed line, not a reserved gap. C2 is drawn identical to C1 for
exactly that reason.

**Why:** the remedy behind the nudge — `aiConventionService.reaudit` — is gated by
`projectAccessService.assertCanManage`. A nudge shown to a member names a problem, offers a door,
and the door is locked: it is an invitation to a 403. The honest design for most viewers is absence.

**Where the gate lives:** the client gate already ships as `useProjectAccess().canManage`, and the
read behind the count (MOTIR-2248's `/api/ai/coding-convention/audit-coverage`) carries the same
`assertCanManage` on the **server** — so the capability is never enforced only in a component that
could be bypassed by calling the endpoint directly.

---

## 7 · Copy — new keys (each needs its `zh.json` twin)

| Key                         | Copy                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `auditCoverage.count`       | {count, plural, one {# repository has no code-health audit.} other {# repositories have no code-health audit.}} |
| `auditCoverage.consequence` | Plans that touch them are made without their recorded standards.                                                |
| `auditCoverage.action`      | Review code health                                                                                              |

Three keys, because the banner is three things: a count, a consequence, a link. There is no eyebrow,
no title, no dismiss label and no re-open label — §4 removed all four.

The action reads **"Review code health"**, not "Audit them now": the banner's job is to take an admin
somewhere they can see the state and choose, and the deciding press lives on the destination where
the per-repo and bulk triggers are (Panel 8). A nudge that fires derivations directly would spend
money from a surface that never showed which repositories it was about to spend it on — and this
banner deliberately does not name them (§3).

---

## 8 · Designed against shipped reality (`notes.html` #73)

- **The banner's box is the shipped `SettingsBanner`, read from source** — `role="status"`,
  `--radius-card`, `px-(--spacing-card-padding) py-3`, `text-sm`, and the info tone's
  `--el-callout-bg` / `--el-callout-text` pair. Not a redraw and not a new grammar.
- **Its geometry was MEASURED, not estimated** — 41 px tall at a 1200 px viewport, message on a single
  client rect, **0 px gap under the top bar**, and 1 px insets either side that are the frame's own
  border rather than a gutter. §4 makes the height load-bearing, so it had to be a measurement.
- **The host's seam was READ, not imagined.** `PlanningWorkspaceHost` renders a canvas column of
  `[top bar] → [min-h-0 flex-1 canvas]`; the strip goes between them, which is why §1 can name the
  insertion point rather than describe a region.
- **The workspace panes are drawn as placeholders on purpose** — they belong to
  `design/ai-chat/planning-workspace.mock.html` and redrawing them here would create a second,
  drifting copy of a surface that already has an asset.
