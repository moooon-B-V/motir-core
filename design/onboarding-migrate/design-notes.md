# Migrate-onboarding wizard — design notes (`design/onboarding-migrate/`)

**Subtask:** MOTIR-930 · 7.15.1 (`type: design`) · **Story:** MOTIR-815 (Migrate-existing-codebase
onboarding, Workflow B) · **Epic 7 · AI Planning Layer.**

The guided, gated **wizard** for onboarding an EXISTING codebase into Motir: connect the repo → index
it → review the code-health audit and **approve a coding convention** → a short discovery pass →
a **code-aware** plan generate + review. It is the layout source of truth for the wizard UI code
subtask **7.15.5 / MOTIR-934** and the orchestration wiring **7.15.2 / MOTIR-931** (both `blocked_by`
this card), and for the state-machine scaffolding **7.15.2a / MOTIR-1499**.

> **⭐ Scope — this card designs the ORCHESTRATION SHELL + the INDEX step; it COMPOSES the rest.** The
> wizard is a stepped frame that embeds surfaces four other Stories already designed. Per `notes.html`
> mistake **#82** (a design that composes an already-designed sub-surface must GROUND in that
> sub-surface's shipped asset and say so — or it gets built twice) and **#31** (the multi-panel /
> design-reference rule), this doc **cites** each embedded surface's owner and reproduces its language;
> it does **not** re-design connect / audit / convention / discovery / generate. The genuinely new
> pixels here are (a) the **wizard chrome + the two-tier grouped rail** (Set up 1–3 **required** · Plan
> 4–6 **optional**), (b) the **index-progress step** (§Panel 2), and (c) the **plan-now-or-later
> decision** that makes planning optional (§The spine). Two product truths this revision bakes in
> (Yue, 2026-07-05): **conventions are PER REPO** (not one per project — §Multi-repo) and **planning is
> OPTIONAL** (§The spine).

**Asset files (three, shared basename):** `design-notes.md` (this file) ·
`onboarding-migrate.mock.html` (source of truth, standalone — re-states the real
`packages/design-system/theme.css` Tier-0 `--color-*` + shape scale, the Tier-3 `--el-*` layer, and
the `[data-theme='dark']` overrides 1:1 so it paints without the Tailwind build, exactly as
`design/coding-convention/convention.mock.html` does) · `onboarding-migrate.png` (full-page export,
light theme, Playwright chromium, `deviceScaleFactor: 2`, 1200px wide). Dark parity was verified by
toggling `data-theme="dark"` in the mock header.

---

## Designed against SHIPPED REALITY (design-against-shipped-reality)

Read the real surfaces this wizard lands in / replaces before drawing — the mock fits and extends the
implemented app, it does not invent a host:

- **`app/(onboarding)/onboarding/import/page.tsx`** — the shipped **hand-off placeholder** (7.22.4 /
  MOTIR-1462). The entrance's "I have an existing project — import it" row routes to `/onboarding/import`,
  which today renders a "coming soon" `EmptyState`. **This wizard replaces that placeholder IN PLACE**
  (MOTIR-1462's own comment says "the 7.15 wizard replaces this surface"). The provisional route
  `/onboarding/import` is the host.
- **`app/(onboarding)/layout.tsx`** — the onboarding route group renders **OUTSIDE** the `(authed)`
  `AppLayout` (no top nav, no project sidebar) but is still **authenticated** (bounces a signed-out
  visitor to `/sign-in`). So the wizard **owns the whole viewport** with only a minimal brand bar —
  matched exactly, mirroring `design/onboarding-entrance`. (Onboarding is the one full-page first-run
  _route_, not the dismissable planning overlay — per `design/ai-chat`.)
- **`components/onboarding/OnboardingEntrance.tsx`** — the inbound door: the entrance's secondary
  import row (the `GitBranch` "I have an existing project — import it" button) → `/onboarding/import`.
  The wizard's brand bar continues the entrance's exact chrome (the `Sparkles` logo tile on
  `--el-tint-lavender`, the signed-in avatar).
- No wizard / stepper primitive ships in `components/ui/` — the **step rail is a NEW ARRANGEMENT** of
  shipped primitives (the same way `design/ai-chat`'s canvas roadmap and `design/coding-convention`'s
  onboarding step-strip are new arrangements). The precedent for a wizard step-strip is
  `design/coding-convention` Panel 5 ("Discovery ✓ → Design system ✓ → **Establish convention**
  (current) → Review plan") — this rail generalises it to the six migrate steps.

---

## ⭐ Multi-repo — a project spans several repositories (Yue, 2026-07-05)

**A real existing codebase usually spans more than one repository** (a web app + an API + a shared
package). The first draft collapsed the flow to a single repo (`acme/web@a1b9f30`, one code graph, one
plan); this is corrected so the WHOLE wizard is multi-repo. Grounded in **shipped reality** (rung 2 —
read on disk this session, not assumed):

- **`GithubInstallation` is WORKSPACE-scoped and owns many `GithubRepo`s** (`prisma/schema.prisma`:
  `GithubInstallation { workspaceId } → repos GithubRepo[]`). Repo selection is a set, per workspace —
  a project is not "one repo."
- **The code graph is PROJECT-scoped and aggregates repos.**
  `lib/services/codeGraphIndexService.ts` → `indexRepoIntoWorkspaceProjects` fetches each repo's tarball
  and indexes it **into each of the workspace's projects' code-graph stores** ("A repo installed at a
  workspace is therefore indexed into each of that workspace's projects' code-graph stores"). So a
  project's code graph is **built from multiple repos**; the audit and the plan read that whole-project
  graph. (The service's own comment flags that a _precise_ repo↔project association — so a repo only
  indexes into the projects it belongs to — is a **future refinement, deliberately not built yet**; the
  wizard's per-project repo selection is exactly where that association gets captured.)
- **The coding convention is PER REPO — one standard per repository, NOT one per project (Yue,
  2026-07-05).** A legacy API and a modern web app in the same company rarely share a coding standard,
  so step 3 reviews + approves a convention **for each repository** (acme/web · acme/api · acme/shared,
  each its own draft + Approve + grade). Each repo's approved convention is the standard Motir injects
  when it generates work **for that repo**. ⚠️ **This CORRECTS the 7.14 model.**
  `design/coding-convention` currently states "exactly ONE `standard` per project" and the 7.14.3 store
  scopes `CodingConvention` to the project — that must become **per-repo** (scope the convention +
  audit to a `(project, repo)` pair; the audit already carries a `codeGraphRef`, so per-repo is a
  natural extension). **This is an upstream design change for the 7.14 story owner** (7.14.1 design +
  7.14.2 decision + 7.14.3 store: MOTIR-922 / 923 / 924, and the review/approve UI MOTIR-926) — the
  migrate wizard only **composes** 7.14's convention surface, once per repo, so it flags the model
  change rather than owning it.

**How each step becomes multi-repo (what the mock now draws):**

| Step                              | Multi-repo treatment                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connect** (Panel 1)             | "Connect the repositories in this project" — a **multi-select** repo list (web · api · shared, all Selected switches) + a "**3 repositories** selected" summary. The selection is the set of repos that make up this project.                                                                                                                                                |
| **Index** (Panel 2)               | **One code graph across all repos**, built **per repo**: a `.idx-repo` list — each repo its own progress bar + state (`Indexed` / `Indexing…` / `Queued`) — under an **aggregate meter** ("2 of 3 repositories done · 78%"). The **gate is aggregate**: Next stays disabled until **every** repo finishes. Complete state = "3 of 3 indexed · 5,412 files · 31,208 symbols". |
| **Audit + conventions** (Panel 3) | The audit is **measured across all 3 repositories** (a per-repo grade line — acme/web B · acme/api A− · acme/shared A), and conventions are **PER REPO** — a `.conv-repo` list, each repo its own draft + grade + Edit/Approve (acme/web Approved · acme/api & acme/shared proposed) + one expanded example. Each is the standard for work Motir plans in that repo.         |
| **Discovery** (Panel 4)           | "I've read your **3 repositories** — a Next.js web app, a Node API and a shared package…" — the AI's code context is the whole project.                                                                                                                                                                                                                                      |
| **Generate** (Panel 5)            | The plan is grounded in the **whole-project code graph**; each proposed node carries a **repo tag** (`acme/api` / `acme/web`) so it's clear which repo the work lands in, and a cross-repo proposal (reminders reuse the API's notification service) reads naturally.                                                                                                        |
| **States** (Panel 6)              | Index failure is **per-repo** — "acme/api failed; the other 2 stay indexed · Re-run acme/api" (a scoped retry, not a full re-index). Resume names the whole set ("Your import (3 repositories) is paused at step 3").                                                                                                                                                        |

**Implications for the downstream build cards (flagged, not built here):**

- **MOTIR-931 (orchestration)** indexes **N repos** into the project code graph — a fan-out over the
  selected repos (mirrors `indexRepoIntoWorkspaceProjects`), with an aggregate "all repos done" gate
  before the audit runs.
- **MOTIR-1499 (state machine)** tracks **per-repo index status** (not a single boolean) so Save & exit,
  resume, and a per-repo retry all work; the step is "done" only when every repo is indexed.
- **MOTIR-934 (wizard UI)** renders the per-repo index list + the multi-select connect list; the repo↔
  project association captured at Connect is what a future refinement uses to stop indexing a repo into
  unrelated projects.
- **Set-up (Connect · Index · Audit & conventions) is the REQUIRED core; Plan (Discovery · Generate ·
  Review) is OPTIONAL.** The state machine (MOTIR-1499) must let a user **complete onboarding at the end
  of set-up** and leave planning un-run — onboarding is "done" once the codebase is set up, independent
  of whether a plan was generated. The wizard UI (MOTIR-934) wires the **decision** after step 3 and the
  **skip / finish-later** outs on 4–6; the finish-early exit lands the user in the project where the
  **always-present `PlanWithAILauncher`** (`design/ai-chat` / MOTIR-1299) is the door to plan later — so
  the migrate wizard does NOT need its own "plan now" gate beyond the decision.
- **Conventions are PER REPO** — the 7.14 model change (§Multi-repo) is a **prerequisite** for step 3 to
  approve per-repo: scope `CodingConvention` + `CodeAudit` to `(project, repo)` in 7.14.3 (MOTIR-924),
  update the 7.14.2 decision (MOTIR-923) + the 7.14.1 design + review/approve UI (MOTIR-926). Until that
  lands, the migrate wizard's step 3 is `blocked_by` the per-repo convention model. **Surface this as a
  finding/comment on the 7.14 story** (out of this card's scope to re-plan).

---

## Mirror grounding (rung-1, VERIFIED this session — cited, not asserted)

The card names these; drawn as THAT guided, gated wizard:

- **CodeRabbit — connect-your-repo onboarding.** Install the GitHub App, pick "all" or "only select
  repositories"; it then reads the repo in full context. Grounds **Panel 1** (the two-grant connect +
  repo selection) and the "you pick the exact repos on GitHub" honesty. —
  https://docs.coderabbit.ai/platforms/github-com
- **Cursor — codebase-indexing PROGRESS + a completion gate.** Cursor shows an indexing progress
  indicator and code-dependent capability is unavailable until the index completes. Grounds **Panel 2**
  (the index-progress step with **Next DISABLED until the index is ready**). —
  https://cursor.com/docs/context/codebase-indexing
- **Plane — the Jira-import WIZARD.** A stepped connect → configure → map → **review + Confirm** flow
  that writes nothing until the final confirm. Grounds the overall **stepped, gated wizard** shape and
  the confirm-to-persist generate/review end (**Panel 5**). — https://docs.plane.so/importers/jira

(The audit/convention step additionally inherits the 7.14.1 mirror set — CodeScene CodeHealth™,
CodeRabbit `code-guidelines`, the ETH-Zurich auto-gen caveat that justifies the **Approve** gate — from
`design/coding-convention/design-notes.md`, cited there, not re-argued here.)

---

## The spine — a two-tier, resumable wizard (the model this draws)

1. **Six steps in TWO tiers, one grouped rail.** The rail is split into **"Set up your codebase"
   (required)** — `Connect · Index · Audit & conventions` — and **"Plan your project · optional"** —
   `Discovery · Generate · Review`. Each step's state: **done** (mint check), **current** (accent marker
   - an `--el-accent-on-surface` ring row), **upcoming** (quiet outline marker), **optional** (a
     **dashed** marker — reachable, not forced). A `.rail-group` header carries the tier name; the optional
     tier's header carries an `optional` chip.
2. **★ Planning is OPTIONAL — the plan-now-or-later DECISION (Yue, 2026-07-05).** Linking + reading the
   code must NOT force a planning commitment. The required core ends at **Audit & conventions (step 3)**;
   after it the user hits a **`.decision`** block — **"Plan your project now?"** with **"Plan my project
   now"** (primary) and **"Finish — I'll plan later"** (secondary). Steps 4–6 are the optional planning
   tier: Discovery carries **"Skip discovery"** + **"Finish — plan later"**, Generate carries **"Finish —
   plan later"**. **"Plan with AI" is drawn in the top bar on every panel** (the always-present launcher,
   `design/ai-chat` — composed, cited), so finishing at set-up loses nothing: the user plans anytime
   later. The finish-early exit is drawn in Panel 6 ("Your codebase is in Motir · Plan with AI"). This
   REPLACES the earlier "Generate is LOCKED until convention approved" framing: conventions are approved
   in the required set-up tier, so by the time (optional) generation runs they're already the standard —
   there is no locked-then-forced step; the convention→generation relationship is stated as copy ("Motir
   uses each repo's approved convention when it plans"), and the optional steps are dashed, not padlocked.
3. **The index gate (Cursor mirror) — aggregate across repos.** `Next` on step 2 is **disabled** (a
   `.btn.disabled`) until the code graph is built for **every** repo — the audit and any plan need the
   whole project indexed. Drawn in an **in-flight** state (per-repo `.idx-repo` rows + an aggregate
   `.idx-meter` at 78% + "2 of 3 repositories done" + Next disabled) and a **complete** state ("3 of 3
   indexed" pill + Next enabled).
4. **Resumable — Save & exit / resume.** The brand bar carries a **Save & exit** control (lucide
   `History`, the exit half of the save→resume loop, MOTIR-1488 vocabulary). Every step persists its
   result (MOTIR-1499's `MigrateOnboarding` state machine + MOTIR-931's resumable routes), so a drop or
   a deliberate exit **returns the user to the exact saved step** — drawn as the **Resume** state in
   Panel 6 ("Welcome back — pick up where you left off · paused at Audit & convention, step 3 of 6").
5. **A Back / Next footer** on every step (`--el-border` top hairline; Back secondary, the forward CTA
   primary — named per step, e.g. "Next: index the code", "Approve & set as standard", "Add 4 items to
   your backlog").

---

## Panels (inspect EVERY panel — the multi-panel rule, mistake #31)

### Panel 0 — the wizard chrome + the grouped rail (Set up vs Plan · optional)

The whole frame: **brand bar** (Motir wordmark · "Import an existing project" flow label · **"Plan with
AI"** launcher · **Save & exit** · avatar) over the `[260px rail | content]` grid. The rail is
**grouped into two tiers** with `.rail-group` headers: **"Set up your codebase"** (`Connect ✓ · Index ✓ ·
Audit & conventions ●`) and **"Plan your project"** + an `optional` chip (`Discovery · Generate ·
Review`, each a **dashed** `.step.optional` marker — reachable, not padlocked). Drawn at the **decision
moment**: eyebrow **"Step 3 of 3 · Set up · the decision point"**, H1 **"Your codebase is set up — plan
now, or finish and plan later"**, then the **`.decision`** block — **"Plan your project now?"** with
**"Plan my project now"** (primary) + **"Finish — I'll plan later"** (secondary) and a note that **Plan
with AI is always in the top bar**. Footer: "Required set-up is complete · steps 4–6 are optional". This
panel answers "what is this / where am I / what's required vs optional / how do I plan later".

### Panel 1 — Connect GitHub (step 1) — **composes 7.7.1 (`design/github/`)**

The 7.7 connect surface as step 1, drawn as a COMPOSITION of 7.7.1, not a new connect screen — and
framed as **multi-repo** (§Multi-repo above). H1 **"Connect the repositories in this project"**, lead
"A project usually spans more than one repository — a web app, an API, a shared package. Select every
repo that makes up this project…". Two independent `.grant-row`s — **Step 1 · Identity** ("Verify your
GitHub identity" · reads public profile only, grants no code access) and **Step 2 · Repository access**
("Install the Motir GitHub App" · you pick the exact repos on GitHub) — the **"Connect GitHub"** primary
`Button` (github-mark), and the **multi-select repo list** (`repo-row`s: repo icon + `owner/name` + a
`main` branch `code` chip + a **Selected** `Pill` + a `Switch` — **acme/web · acme/api · acme/shared**
all on) with a "**3 repositories** selected for this project" summary. Copy honesty: "you pick the exact
repos on GitHub" + "To add or remove repositories, update the Motir App's access on GitHub" (the "Manage
on GitHub" out lives in the 7.7.1 settings surface; here it's the first-run selection). **Owned by 7.7.1
— cited, not re-designed.**

### Panel 2 — Index progress (step 2) — **NEW (the step this card owns)**

The code-graph indexing step (Cursor mirror), drawn **multi-repo** (§Multi-repo above). Eyebrow "Step 2
of 6", H1 **"Indexing your codebase"**, lead "Motir builds **one code graph for the project across all
three repositories** — files, symbols and how they reference each other, **including across repos** …".
An **in-flight** card: a `.spin` ring + "Building the code graph…" + "**2 of 3 repositories done** · you
can leave this step…" + a sky `78%` pill + the aggregate `.idx-meter`, then a **per-repo `.idx-repo`
list** — each repo a row with its own mini progress bar + state `Pill`: **acme/web** `Indexed` (mint,
100%, "2,104 files · 14,318 symbols") · **acme/api** `Indexing…` (sky, 62%) · **acme/shared** `Queued`
(neutral, 0%). An info `.callout`: **"Next stays disabled until every repository finishes"** and the
forward CTA drawn as `.btn.disabled` (the **aggregate** gate). Then a **complete** state (mint "**3 of 3
indexed**" pill · "Code graph built · 3 repositories · 5,412 files · 31,208 symbols" · Next enabled). The
index feeds the whole-project code graph the 7.14 audit + the plan read (the `codeGraphRef`).

### Panel 3 — Audit + PER-REPO conventions → the plan-now-or-later decision — **composes 7.14.1 (`design/coding-convention/`)**

The last **required** set-up step. Eyebrow "Step 3 of 3 · Set up", H1 **"Your code health & a coding
convention per repository"**, lead "Motir drafted a convention **for each repository** — conventions
differ per repo (a legacy API and a modern web app rarely share a standard)." The **Code health** card
(grade **B** tile on `--el-success-surface` · "78% of your code already meets its repo's convention" · a
**per-repo grade line** acme/web B · acme/api A− · acme/shared A, "across 3 repositories"). Then the
**Coding conventions** card — **PER REPO** (§Multi-repo above): a `.conv-repo` list, each repo a row with
its own grade tile + name + one-line convention summary (Next.js/React · Node service · TS library) +
**Edit** + **Approve** — drawn as **acme/web Approved** (mint) and **acme/api / acme/shared v1 ·
proposed** (approve each), plus **one expanded** acme/api convention (Adopted/Proposed rules) to show the
detail. Then the **`.decision`** block ("You're set up — plan your project now?" · Plan my project now /
Finish — I'll plan later · Plan-with-AI note); footer note "Approving each convention is optional now —
you can approve when you plan". **The convention SURFACE (audit + per-repo review/approve) is owned by
7.14.1** — this panel composes it once per repo. ⚠️ The **per-repo model** (one standard per repo, not
per project) is an **upstream correction for the 7.14 story** (§Multi-repo) — flagged, not owned here.

### Panel 4 — Light discovery (step 4, **OPTIONAL · skippable**) — **composes 7.2.1 (`design/ai-chat/`)**

A SHORT, **optional** discovery pass, migrate-framed. Eyebrow "Step 4 of 6 · Plan (optional)", H1 **"We
read your code — now tell us your goals"**, lead "A short, optional conversation … Skip it and Motir
plans from the code alone — or finish here and plan later." The 7.2 chat surface embedded as a compact
`Card` (AI / user `.bubble`s + a `.composer`) — the AI opens with what it learned across the **3
repositories** and points work at the right repo (reminders → `acme/api`, report → `acme/web`). Footer
carries the **skip outs**: **"Finish — plan later"** + **"Skip discovery"** alongside "Next: generate".
**Owned by 7.2.1** — cited, not re-designed.

### Panel 5 — Code-aware generate + review (steps 5–6, **OPTIONAL**) — **composes 7.3.1 (`design/ai-planning/`)**

The 7.3/7.4 generate → review → approve surface embedded, **migrate-specific** and **optional**. Eyebrow
"Steps 5–6 of 6 · Plan (optional)", H1 **"A plan grounded in your code"**. A **success-tinted** callout:
**"This plan reflects your existing code — across all 3 repositories. Each proposed item is tagged with
the repo it lands in and honours that repo's approved convention …"**. The canvas (`--el-canvas` dot-grid)
shows a firm Story node + dashed-accent **`Subtask · add`** proposed nodes, **each carrying a `.n-repo`
repo tag** (`acme/api` / `acme/web`) so cross-repo work is legible — over the **confirm-to-persist** bar
("4 proposed · Nothing saved yet" · Discard · **"Add 4 items to your backlog"**). Footer carries **"Finish
— plan later"** (a plan left unconfirmed is just a draft). **Owned by 7.3.1 / 7.4** — cited, not
re-designed.

### Panel 6 — finished-early / error / resume states

Four states in a `.states-grid`: the ★ **finish-at-set-up exit** — a mint `EmptyState` **"Your codebase
is in Motir"** ("3 repositories connected, indexed and conventions reviewed. You didn't have to plan
anything — start whenever with **Plan with AI**") with a **"Plan with AI"** + "Go to project" — the
concrete payoff of optional planning; **Index failed — one repo, per-repo retry** ("acme/api failed; the
other 2 stay indexed · Re-run acme/api" — a scoped retry via `.callout.danger`); **Connect failed**
("Couldn't reach GitHub · your place is saved · Retry connect"); and **Resume** ("Welcome back … Your
import (3 repositories) is paused at Audit & conventions (step 3) · Resume at step 3 / Start over"). A
footer note ties resume + per-repo index status + per-repo convention approval to MOTIR-1499's
`MigrateOnboarding` state machine + MOTIR-931's resumable routes, and states the finish-early-plan-later
contract.

---

## Which Story owns each embedded surface (compose + cite, don't duplicate)

| Step / surface                       | Owner (design → build)                                                                 | This card |
| ------------------------------------ | -------------------------------------------------------------------------------------- | --------- |
| **Wizard chrome + step rail + gate** | **MOTIR-930 (this design) → MOTIR-934 (UI) + MOTIR-931 (wiring) + MOTIR-1499 (state)** | designs   |
| **Index-progress step**              | **MOTIR-930 (this design)** — the NEW step it owns                                     | designs   |
| Connect GitHub (step 1)              | **7.7.1** — `design/github/` (build MOTIR-895)                                         | composes  |
| Audit + convention (step 3, ★ gate)  | **7.14.1** — `design/coding-convention/` (build MOTIR-926)                             | composes  |
| Light discovery (step 4)             | **7.2.1** — `design/ai-chat/` (build MOTIR-804)                                        | composes  |
| Code-aware generate + review (5–6)   | **7.3.1** — `design/ai-planning/` + `design/ai-chat/planning-workspace` (7.4)          | composes  |
| The `/onboarding/import` host route  | **7.22.4 / MOTIR-1462** (placeholder the wizard replaces in place)                     | replaces  |

If a step needs a design-system entry none of the above owns, that is a **NEW `design/` subtask**, not
a code workaround (the AC). None is introduced here — the rail, the chrome, and the index step compose
only shipped primitives.

---

## Per-element `--el-*` colour role (the token map)

Colour flows through Tier-3 `--el-*` ONLY — no Tier-0 `--color-*` in product UI, no invented hue (the
`motir-core/CLAUDE.md` colour rule; mistake #54). Every coloured chip carries the hue in the TINT
background with `--el-text-strong` ink, AA-safe in both themes (finding #35).

| Element                                    | Token(s)                                                                                                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page / wizard frame                        | `--el-page-bg` bg · `--el-border` edge · `--shadow-card`; brand bar `--el-surface-soft`                                                                                                 |
| Brand tile · avatar                        | `--el-tint-lavender` / `--el-tint-mint` fill + `--el-text-strong` ink                                                                                                                   |
| Save & exit control                        | `--el-text-secondary` (lucide `History`)                                                                                                                                                |
| Rail — **done** step                       | marker `--el-success-surface` bg + `--el-success` check; connector spine `--el-success`; name `--el-text-strong`                                                                        |
| Rail — **current** step                    | row `--el-surface-soft` + a `--el-accent-on-surface` outline; marker `--el-accent` + `--el-accent-text`                                                                                 |
| Rail — **upcoming** step                   | marker `--el-page-bg` + `--el-border-strong` outline + `--el-text-faint`; name `--el-text-secondary`                                                                                    |
| Rail — **optional** step                   | marker `--el-page-bg` + a **dashed** `--el-border-strong` outline + `--el-text-muted`; name `--el-text-secondary` (reachable, not padlocked)                                            |
| Rail group headers                         | `.rail-group` `--el-text-faint` (mono); the `optional` chip `--el-accent-on-surface` on `--el-callout-bg`                                                                               |
| Decision block (`.decision`)               | `--el-surface-soft` fill + an `--el-accent-on-surface` border; the "Plan with AI" `.ai-pill` = `--el-accent` fill + `--el-accent-text` (matches the top-bar launcher)                   |
| "Plan with AI" launcher (`.plan-ai`)       | `--el-accent` fill + `--el-accent-text` pill in the top bar — the always-present entrance (composes `design/ai-chat` / MOTIR-1299)                                                      |
| Step eyebrow · H1 · lead                   | `--el-text-eyebrow` (mono) · serif `--el-text` · `--el-text-secondary`                                                                                                                  |
| "Composes N" cite chip                     | `.cite` → `--el-callout-text` on `--el-callout-bg` (lavender = the compose/reference identity)                                                                                          |
| Card surface + edge                        | `--el-card` bg · `--el-border` · `--shadow-subtle`; a quiet aside is `.card.soft` on `--el-surface-soft`                                                                                |
| Primary / secondary / ghost / disabled CTA | `--el-accent`+`--el-accent-text` · `--el-page-bg`+`--el-button-border` · `--el-text` · `--el-muted`+`--el-text-faint`                                                                   |
| Index meter                                | track `--el-muted` · fill `--el-accent`; the spinner ring `--el-border-strong` + head `--el-accent-on-surface`                                                                          |
| Index stat tiles                           | `--el-surface-soft` + `--el-border`; number serif `--el-text-strong`, label `--el-text-muted`                                                                                           |
| Per-repo index row (`.idx-repo`)           | `--el-border` + `--radius-control`; per-repo bar track `--el-muted` + fill `--el-accent` (done → `--el-success`); state `Pill` mint `Indexed` / sky `Indexing…` / neutral `Queued`      |
| Info callout / progress note               | `--el-surface-soft` + `--el-border`; icon `--el-info`                                                                                                                                   |
| Grade tile (audit)                         | `--el-success-surface` bg + `--el-text-strong` (a B grade; a poor grade falls to `--el-warning`/`--el-danger`-surface)                                                                  |
| Category dots                              | `--el-success` (ok) · `--el-warning` (watch) · `--el-danger` (gap) — each paired with a redundant text label                                                                            |
| Provenance — Adopted / Proposed            | `Pill` `--el-tint-mint` (Adopted) / `--el-tint-lavender` (Proposed), `--el-text-strong` ink                                                                                             |
| Sync / selection / status pills            | tints `--el-tint-{mint,sky,peach,rose,lavender}` + `--el-text-strong`; neutral `--el-chip-bg`/`-border`                                                                                 |
| Grant-row icon badge                       | `--el-card-icon-bg` (lavender) + `--el-card-icon-fg`                                                                                                                                    |
| Branch / code chip                         | `--el-code-bg` + `--el-code-text` (mono)                                                                                                                                                |
| Switch (repo sync)                         | on `--el-switch-on` · off `--el-muted`+`--el-border-strong` · knob `--el-switch-knob`                                                                                                   |
| Chat — AI / user bubble                    | AI `--el-surface-soft`+`--el-border`+`--el-text`; user `--el-accent`+`--el-accent-text`; composer field `--el-input-border`                                                             |
| Canvas + proposed node                     | canvas `--el-canvas` (+ a `--el-border-strong` dot-grid, non-semantic); node `--el-card`; **proposed** = dashed `--el-accent-on-surface` on `--el-surface-soft`                         |
| Confirm-to-persist bar                     | `--el-surface-soft` + an `--el-accent-on-surface` border; "N proposed" `--el-tint-lavender` pill                                                                                        |
| Danger callout / error icon                | `.callout.danger` → `--el-danger-surface` fill + `--el-text-strong` ink + `--el-danger` icon                                                                                            |
| EmptyState (error / resume)                | icon tile `--el-muted`/`--el-icon-muted` (danger → `--el-danger-surface`/`--el-danger`; resume → `--el-tint-lavender`/`--el-accent-on-surface`); serif title; `--el-text-subtitle` desc |

**Shape** flows through element-semantic shape tokens ONLY (no raw `rounded-*`/`p-*`/`h-*`; the
`motir-core/CLAUDE.md` shape rule — the layer a `[data-style]`/`[data-display-style]` block overrides):
cards `--radius-card` + `--spacing-card-padding`; buttons `--radius-btn` + `--height-btn-{sm,md}` +
`--spacing-btn-x`; pills `--radius-badge` + `--spacing-chip-{x,y}`; rail rows / repo rows / stat tiles /
code chips `--radius-control`; inputs `--radius-input` + `--height-control` + `--spacing-input-{x,y}`;
elevation `--shadow-{subtle,card}`. `rounded-full` (`--radius-badge`) only on markers / dots / avatar /
switch knob.

---

## Primitives composed (no hand-rolling) — the checklist (1.3.3 / 1.5.1 / 7.0.1)

Every element maps to a shipped `components/ui/*` primitive; the mock hand-writes CSS reproducing each
primitive's shipped classes/tokens (annotated). No new design-system entry is invented in this Story —
if one were needed, that is a NEW `design/` subtask, not a code workaround.

- [x] **Card** (`components/ui/Card.tsx`) — every step's content cards, the connect/repo/index/audit/
      convention cards, the EmptyState roots, the chat card, the confirm bar container.
- [x] **Button** (`components/ui/Button.tsx`) — primary (Connect / Approve & set as standard / Add N to
      backlog / Next), secondary (Back / Set from defaults), ghost (Cancel / Save draft / Edit), and the
      **disabled** state (the index gate's Next); sizes md + sm.
- [x] **Pill** (`components/ui/Pill.tsx`) — provenance (Adopted `success` / Proposed `status=planned`),
      sync/selection/progress (`Selected` mint, `61%` sky, `Not selected` neutral), and the `N proposed`
      lavender count. No custom tone invented — all are shipped `Pill` variants.
- [x] **Switch** (`components/ui/Switch.tsx`, `role="switch"`) — the per-repo sync toggle (Panel 1).
- [x] **EmptyState** (`components/ui/EmptyState.tsx`) — the connect-failed + resume states (Panel 6):
      Card root, centred icon tile + serif title + `--el-text-subtitle` desc + action.
- [x] **Textarea / Input** grammar — the chat composer field + the convention editor door (`Edit` opens
      the 7.14.1 `Textarea` edit mode, owned there).
- [x] **Spinner** (`components/ui/Spinner.tsx`) — the index `.spin` ring + the "Reading your codebase…"
      generating state (annotated, not re-implemented).
- [x] **The two-tier step rail** — a NEW ARRANGEMENT of `Card`/list-row grammar + tint marker tiles +
      `.rail-group` tier headers + lucide `check`, generalising the `design/coding-convention` Panel 5
      wizard step-strip. Done/current/upcoming/**optional** states pair a glyph or a dashed marker + a
      label + a tint (never colour-alone — finding #35).
- [x] **The per-repo index list** (`.idx-repo`) + **the per-repo convention list** (`.conv-repo`) — NEW
      ARRANGEMENTS of list-row grammar + a progress bar / grade tile + shipped `Pill` tones, so a
      **multi-repo** project indexes with per-repo status (aggregate gate) and reviews **one convention
      per repo**. No new primitive.
- [x] **The decision block** (`.decision`) + the **"Plan with AI" launcher** (`.plan-ai`) — a `Card`-grammar
      accent-bordered panel with `Button`s, and the always-present top-bar launcher (composes
      `design/ai-chat` / MOTIR-1299). No new primitive.
- [x] **The embedded surfaces compose their OWN primitives** — Connect = 7.7.1's grant-rows + repo-rows (a **multi-select** repo set) + Switch; Audit/conventions = 7.14.1's grade tile + provenance pills, composed **once per repo**; Discovery = 7.2.1's
      chat bubbles + composer; Generate = 7.3.1's canvas node + confirm-to-persist. Reproduced from their
      shipped assets, **not re-designed**.
- [x] Icons are **lucide** (`Sparkles`, `History`, `check`, `github`, `badge-check`, `layout-grid`,
      `database`, `info`, `send`, `circle-check`, `triangle-alert`, `refresh-cw`, `arrow-left`,
      `arrow-right`, `pencil`) at `viewBox="0 0 24 24"`, stroke 2, round caps — matching the shipped
      surfaces.

### Token / a11y rules honoured

- Colour strictly via `--el-*` (incl. `--el-tint-*`); no Tier-0 `--color-*` in product UI, no invented
  hex/rgb/named colour, no `color-mix` over a raw hue (mistake #54). The only raw values are the
  non-semantic elevation shadows, the `--el-overlay-scrim`, and the canvas dot-grid texture — never a
  card/pill/state fill, border, or text colour.
- Shape strictly via element-semantic shape tokens; no raw `rounded-*`/`p-*`/`h-*` for a surface's own
  box (the shape rule) — so a `[data-style]`/`[data-display-style]` swap re-shapes the whole wizard.
- **Not colour-alone** — every rail state pairs a glyph (check / number) or a **dashed** marker + a
  label + a tint; the optional steps sit under a labelled `.rail-group` ("optional" chip); per-repo
  index/convention states pair a `Pill` word + a tint; the disabled Next carries `aria-disabled`; the
  rail is an `aria-label`led `nav` and the current step is `aria-current="step"`.
- **AA holds** — every coloured chip/tile carries the hue in the tint background with `--el-text-strong`
  ink; dark parity verified by toggling `data-theme="dark"` (every `--el-*` re-skins through the
  `[data-theme='dark']` `--color-*` overrides).
