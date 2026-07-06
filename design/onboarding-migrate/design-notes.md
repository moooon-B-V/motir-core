# Migrate-onboarding wizard — design notes (`design/onboarding-migrate/`)

**Subtask:** MOTIR-930 · 7.15.1 (`type: design`) · **Story:** MOTIR-815 (Migrate-existing-codebase
onboarding, Workflow B) · **Epic 7 · AI Planning Layer.**

The **wizard** for onboarding an EXISTING codebase into Motir. **Required core = Connect + Index** (link
the repos, Motir reads the code + silently derives per-repo conventions + a code-health check, auto-used,
nothing to approve). Everything after — **optional**: import your existing backlog, a light discovery
pass, a **code-aware** plan generate + review. It is the layout source of truth for the wizard UI code
subtask **7.15.5 / MOTIR-934** and the orchestration wiring **7.15.2 / MOTIR-931** (both `blocked_by`
this card), and for the state-machine scaffolding **7.15.2a / MOTIR-1499**.

> **⭐ Scope — this card designs the ORCHESTRATION SHELL + the INDEX step; it COMPOSES the rest.** The
> wizard is a stepped frame that embeds surfaces four other Stories already designed. Per `notes.html`
> mistake **#82** (a design that composes an already-designed sub-surface must GROUND in that
> sub-surface's shipped asset and say so — or it gets built twice) and **#31** (the multi-panel /
> design-reference rule), this doc **cites** each embedded surface's owner and reproduces its language;
> it does **not** re-design connect / audit / convention / discovery / generate / import. The genuinely
> new pixels here are (a) the **wizard chrome + the two-tier grouped rail** (Set up = **Connect + Index
> required** · Import & plan **optional**), (b) the **index-progress step** (§Panel 2), and (c) the
> **import/plan-or-later decision** that makes everything after set-up optional (§The spine). Product
> truths this revision bakes in (Yue, 2026-07-05): the **required core is just Connect + Index**;
> **conventions + code-health are derived SILENTLY, auto-used, with NO approval and NOT surfaced in
> onboarding** — they live on the Code-health page (§The spine, and the removed-Panel-3 §); conventions
> are **PER REPO** (§Multi-repo); **import + planning are OPTIONAL**; and the **optional import step
> composes `design/import`** (§Panel 3), embedded not redrawn.

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
  (current) → Review plan") — this rail generalises it to the migrate steps (Connect · Index + the optional tier).

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
  2026-07-05).** A legacy API and a modern web app in the same company rarely share a coding standard, so
  Motir derives a convention **per repository** (acme/web · acme/api · acme/shared, each its own grade).
  Each repo's convention is the standard Motir injects when it generates work **for that repo**.
  **⚠️ Two 7.14 corrections (see the removed-Panel-3 §): (i) per-repo, not one per project; (ii) derived +
  auto-used, NO approval, view/chat on the Code-health page — not an onboarding step.** On the 7.14 side,
  per-repo means scoping `CodingConvention` + `CodeAudit` to a `(project, repo)` pair (the audit already
  carries a `codeGraphRef`), and no-gate means dropping the approve + free-edit from the shipped MOTIR-926
  UI. The migrate wizard only **CONSUMES** the derived conventions (they never surface here), so it flags
  the model change rather than owning it.

**How each step becomes multi-repo (what the mock now draws):**

| Step                                                   | Multi-repo treatment                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connect** (Panel 1)                                  | "Connect the repositories in this project" — a **multi-select** repo list (web · api · shared, all Selected switches) + a "**3 repositories** selected" summary. The selection is the set of repos that make up this project.                                                                                                                                                |
| **Index** (Panel 2)                                    | **One code graph across all repos**, built **per repo**: a `.idx-repo` list — each repo its own progress bar + state (`Indexed` / `Indexing…` / `Queued`) — under an **aggregate meter** ("2 of 3 repositories done · 78%"). The **gate is aggregate**: Next stays disabled until **every** repo finishes. Complete state = "3 of 3 indexed · 5,412 files · 31,208 symbols". |
| **Conventions + code-health** (NOT an onboarding step) | Derived **PER REPO** from the code + a code-health check, **auto-used, NO approval, NOT surfaced in onboarding** — the Index-complete state just notes "conventions + code-health derived, nothing to approve; on the Code health page". The audit + read-only View + chat-to-revise all live on the **Code-health page (7.14)**, post-onboarding.                           |
| **Discovery** (Panel 4)                                | "I've read your **3 repositories** — a Next.js web app, a Node API and a shared package…" — the AI's code context is the whole project.                                                                                                                                                                                                                                      |
| **Generate** (Panel 5)                                 | The plan is grounded in the **whole-project code graph**; each proposed node carries a **repo tag** (`acme/api` / `acme/web`) so it's clear which repo the work lands in, and a cross-repo proposal (reminders reuse the API's notification service) reads naturally.                                                                                                        |
| **States** (Panel 6)                                   | Index failure is **per-repo** — "acme/api failed; the other 2 stay indexed · Re-run acme/api" (a scoped retry, not a full re-index). Resume names the whole set ("set up — paused before the optional import / plan steps").                                                                                                                                                 |

**Implications for the downstream build cards (flagged, not built here):**

- **MOTIR-931 (orchestration)** indexes **N repos** into the project code graph — a fan-out over the
  selected repos (mirrors `indexRepoIntoWorkspaceProjects`), with an aggregate "all repos done" gate
  before the audit runs.
- **MOTIR-1499 (state machine)** tracks **per-repo index status** (not a single boolean) so Save & exit,
  resume, and a per-repo retry all work; the step is "done" only when every repo is indexed.
- **MOTIR-934 (wizard UI)** renders the per-repo index list + the multi-select connect list; the repo↔
  project association captured at Connect is what a future refinement uses to stop indexing a repo into
  unrelated projects.
- **Set-up = Connect + Index (REQUIRED); everything after is OPTIONAL.** The state machine (MOTIR-1499)
  must let a user **complete onboarding at the end of Index** and leave import/planning un-run — onboarding
  is "done" once the codebase is linked + read, independent of whether a plan was generated. On
  Index-complete Motir **derives per-repo conventions + a code-health check silently** (no step, no
  approval). The wizard UI (MOTIR-934) wires the **decision** after Index and the **skip / finish-later**
  outs on the optional steps; the finish-early exit lands the user in the project where the
  **always-present `PlanWithAILauncher`** (`design/ai-chat` / MOTIR-1299) is the door to plan later.
- **Conventions + code-health: derive + auto-use, NO gate, on the Code-health page — a 7.14 re-scope.**
  The migrate wizard CONSUMES the derived per-repo conventions; it never surfaces or approves them. The
  7.14 story owner must: scope `CodingConvention` + `CodeAudit` to `(project, repo)` (7.14.3 / MOTIR-924);
  **drop the approval gate + free-edit**; show the convention **read-only** on the Code-health page with a
  **"refine with Motir"** entry that opens the **UNIVERSAL AI chat** (`PlanWithAILauncher` / the "M"
  callout → `PlanningWorkspace`, MOTIR-1193 / 1299) — **NOT a new convention-chat seam** (Yue). **Recommend
  a 7.14 re-plan** (out of this card's scope to execute) — no new AI capability, it reuses the universal
  chat.
- **All AI conversation rides ONE surface (Yue).** Planning (the migrate wizard's Generate/Review composes
  it via 7.3.1), the convention refine, project Q&A, task help — every AI chat is the **universal
  `PlanningWorkspace` / "Plan with AI" launcher** (the always-present top-bar pill + floating-"M" callout,
  "the home of ALL AI"). This card invents NO bespoke chat: the migrate wizard's discovery + generate
  compose the shared surfaces, and the top-bar Plan-with-AI is that one universal entrance.

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

1. **Two tiers, one grouped rail.** The rail is split into **"Set up your codebase"
   (required)** — **just `Connect · Index`** — and **"Import & plan · optional"** —
   **`Import work items · Discovery · Generate · Review`**. Each step's state: **done** (mint check),
   **current** (accent marker + an `--el-accent-on-surface` ring row), **upcoming** (quiet outline
   marker), **optional** (a **dashed** marker — reachable, not forced). A `.rail-group` header carries the
   tier name; the optional tier's header carries an `optional` chip. The **Import work items** step uses an
   **icon marker** (a download glyph), not a number; the numbered steps are `Connect 1 · Index 2` then the
   optional `Discovery 3 · Generate 4 · Review 5`.
2. **★ The required core is just Connect + Index; conventions + code-health are derived SILENTLY, not an
   onboarding step (Yue, 2026-07-05).** Linking + reading the code must NOT force any commitment or
   "worry". Once the code is indexed, Motir **derives per-repo coding conventions + a code-health check
   from the code and uses them automatically** — **nothing to approve, nothing surfaced in onboarding**.
   (A user shouldn't have to evaluate a Node-layering rule; the conventions are grounded in the _real
   code_, which is the curation the ETH-Zurich "no blind auto-gen" caveat actually wanted — a non-expert
   rubber-stamp is not.) The Index-complete state carries a one-line pointer ("conventions + a code-health
   check derived — nothing to approve; on the _Code health_ page"); the audit report + the read-only
   **View** + **chat-to-revise** all live on the **Code-health page (7.14), post-onboarding** — reachable
   by whoever wants them, never a wizard step.
3. **★ Import + planning are OPTIONAL — the import/plan-or-later DECISION.** After set-up (Connect +
   Index) the user hits a **`.decision`** — **"Bring in your work or plan now?"** with **"Continue"**
   (into the optional tier) and **"Finish — I'll do it later"**. The optional tier: **Import work items**
   (skippable), Discovery, Generate, Review (each with skip / finish-later outs). **"Plan with AI" is in
   the top bar on every panel** (the always-present launcher, `design/ai-chat` — composed, cited), so
   finishing at set-up loses nothing. The finish-early exit is drawn in the states panel ("Your codebase
   is in Motir · Plan with AI"). (This REPLACES the earlier locked-Generate gate AND the per-repo
   convention approve-step — both are gone.)
4. **The index gate (Cursor mirror) — aggregate across repos.** `Next` on step 2 is **disabled** (a
   `.btn.disabled`) until the code graph is built for **every** repo — Motir derives conventions + a
   code-health check (and any plan) from the whole project. Drawn in an **in-flight** state (per-repo
   `.idx-repo` rows + an aggregate `.idx-meter` at 78% + "2 of 3 repositories done" + Next disabled) and a
   **complete** state ("3 of 3 indexed" pill + "conventions + code-health derived, nothing to approve" +
   Next enabled).
5. **Resumable — Save & exit / resume.** The brand bar carries a **Save & exit** control (lucide
   `History`, the exit half of the save→resume loop, MOTIR-1488 vocabulary). Every step persists its
   result (MOTIR-1499's `MigrateOnboarding` state machine + MOTIR-931's resumable routes), so a drop or
   a deliberate exit **returns the user to the exact saved step** — drawn as the **Resume** state in the
   states panel ("Welcome back … set up — paused before the optional import / plan steps").
6. **A Back / Next footer** on every step (`--el-border` top hairline; Back secondary, the forward CTA
   primary — named per step, e.g. "Next: index the code", "You're set up", "Add 4 items to
   your backlog").

---

## Panels (inspect EVERY panel — the multi-panel rule, mistake #31)

### Panel 0 — the wizard chrome + the grouped rail (Set up vs Plan · optional)

The whole frame: **brand bar** (Motir wordmark · "Import an existing project" flow label · **"Plan with
AI"** launcher · **Save & exit** · avatar) over the `[260px rail | content]` grid. The rail is
**grouped into two tiers** with `.rail-group` headers: **"Set up your codebase"** (`Connect ✓ · Index ✓`
— **just those two**) and **"Import & plan"** + an `optional` chip (`Import work items · Discovery ·
Generate · Review`, each a **dashed** `.step.optional` marker — reachable, not padlocked). Drawn at the
**decision moment**: eyebrow **"Set up · the decision point"**, H1 **"Your codebase is in Motir — bring in
your work, plan, or finish"**, a lead that Motir **silently set up per-repo conventions + a code-health
check — nothing to approve, on the _Code health_ page**, then the **`.decision`** block — **"Bring in your
work or plan now?"** with **"Continue"** + **"Finish — I'll do it later"** and the Plan-with-AI note.
Footer: "Set-up (Connect + Index) is complete · import & plan are optional". This panel answers "what is
this / where am I / what's required vs optional / how do I plan later".

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
index feeds the whole-project code graph that the silent conventions + code-health derivation, and any plan, read (the `codeGraphRef`).

### Conventions + code-health are NOT an onboarding step — derived silently (the removed "Panel 3")

An earlier draft made "Audit & conventions" a **required** onboarding step (per-repo review + **approve**).
**Removed (Yue, 2026-07-05): the user shouldn't have to worry about, approve, or even see the coding
convention during onboarding.** Once the code is indexed, Motir **derives per-repo conventions + a
code-health check from the code and uses them automatically** — **no approve, no view, no chat in
onboarding**. The Index-complete state (§Panel 2) carries only a one-line pointer ("conventions + a
code-health check derived — nothing to approve; on the _Code health_ page"). The audit report + the
read-only **View** + **chat-to-revise** all live on the **Code-health page (7.14), post-onboarding** —
discoverable by whoever wants them, never a wizard step. This is grounded in the _real code_, which is the
curation the ETH-Zurich "no-blind-auto-gen" caveat actually wanted (a non-expert rubber-stamp is not); it
also matches how chat-first builders (Lovable / Bolt / Replit) treat code style — invisibly.

⚠️ **This re-scopes the 7.14 coding-convention story (flagged, not owned here — the migrate wizard only
CONSUMES the derived conventions).** The 7.14.5 review/approve UI (MOTIR-926, the `/code-health` page)
**ships today** with a **free-edit Textarea + an Approve gate** (`design/coding-convention`). The new
model is: **derive + auto-use (NO approval gate); read-only VIEW; refine via the UNIVERSAL AI chat.** On
the 7.14 side that needs: **(1)** drop the approval gate (the convention is used automatically);
**(2)** on the Code-health page, show the convention **read-only** with a **"refine with Motir"** entry
that **opens the EXISTING universal AI surface** — the `PlanWithAILauncher` / floating-"M" callout →
`PlanningWorkspace` chat (`design/ai-chat` / MOTIR-1193 / MOTIR-1299, "the home of ALL AI": _Plan with AI_
· _Ask about this project_ · _Help with a task_), scoped to that convention. **Do NOT invent a new
convention-chat seam (Yue)** — refining a convention is just another intent of the universal AI chat, like
planning or asking; **(3)** a **design amendment** to `design/coding-convention` (remove approve +
Textarea; add read-only View + the universal-chat entry); **(4)** a **code change** to MOTIR-926.
Also still open from §Multi-repo: conventions are **per repo**, not one per project. **Recommend a 7.14
re-plan.** (No new AI capability to build — it reuses the universal chat surface.)

### Panel 3 — Import work items (**OPTIONAL**) — **composes `design/import` (7.16.1 / MOTIR-937), embedded not redrawn**

The **optional import step** — bring an existing backlog (Jira / Linear / GitHub / Plane / CSV) into the
project. Eyebrow "Optional · Import & plan", H1 **"Bring in your existing backlog"**, lead frames it as
optional + names the reconcile. **This step COMPOSES the shipped import-wizard design
[`design/import`](../import/design-notes.md) (7.16.1 / MOTIR-937), embedded — NOT redrawn** (#82): the
migrate wizard owns the _embedding_ (the import wizard's own design-notes explicitly assigns "composed
into onboarding as step 2 … owned by the onboarding side, MOTIR-930/934"). Drawn as: a `.substeps`
sub-rail of the importer's own four steps (**Connect → Map → Preview → Import**, Connect current) + the
note "the full flow runs here — **nothing is written until you confirm the dry-run preview**"; a
`.src-grid` source picker (five `.src` tiles — Jira `--el-tint-sky` · Linear `--el-tint-lavender` ·
GitHub `--el-tint-mint` · Plane `--el-tint-rose` · CSV `--el-tint-peach`, the exact tint slots
`design/import` assigns, Jira selected); and an accent **`.callout.info-accent` reconcile** note:
"**Imported items reconcile with your plan** — when you generate next, Motir de-dupes against the
imported backlog; an imported ticket wins, generation only adds the gaps your code implies." Footer: Back
· **"Skip — no backlog to import"** · **"Finish — plan later"** · "Next: discovery". The step is wired by
[MOTIR-1643] (the import-step state machine + reconcile) and built by [MOTIR-934]; the importer engine +
its standalone wizard are [MOTIR-816] / [MOTIR-942]. **The importer's Connect/Map/Preview/Import internals
are OWNED by `design/import` — cited, not re-specified here.**

### Panel 4 — Light discovery (optional, **OPTIONAL · skippable**) — **composes 7.2.1 (`design/ai-chat/`)**

A SHORT, **optional** discovery pass, migrate-framed. Eyebrow "Step 4 of 6 · Plan (optional)", H1 **"We
read your code — now tell us your goals"**, lead "A short, optional conversation … Skip it and Motir
plans from the code alone — or finish here and plan later." The 7.2 chat surface embedded as a compact
`Card` (AI / user `.bubble`s + a `.composer`) — the AI opens with what it learned across the **3
repositories** and points work at the right repo (reminders → `acme/api`, report → `acme/web`). Footer
carries the **skip outs**: **"Finish — plan later"** + **"Skip discovery"** alongside "Next: generate".
**Owned by 7.2.1** — cited, not re-designed.

### Panel 5 — Code-aware generate + review (optional, **OPTIONAL**) — **composes 7.3.1 (`design/ai-planning/`)**

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
import (3 repositories) is set up — paused before the optional import / plan · Resume — import or plan / Go to project"). A
footer note ties resume + per-repo index status + per-repo convention approval to MOTIR-1499's
`MigrateOnboarding` state machine + MOTIR-931's resumable routes, and states the finish-early-plan-later
contract.

---

## Which Story owns each embedded surface (compose + cite, don't duplicate)

| Step / surface                                  | Owner (design → build)                                                                                                 | This card |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------- |
| **Wizard chrome + step rail + gate**            | **MOTIR-930 (this design) → MOTIR-934 (UI) + MOTIR-931 (wiring) + MOTIR-1499 (state)**                                 | designs   |
| **Index-progress step**                         | **MOTIR-930 (this design)** — the NEW step it owns                                                                     | designs   |
| Connect GitHub (step 1)                         | **7.7.1** — `design/github/` (build MOTIR-895)                                                                         | composes  |
| Conventions + code-health (derived, NOT a step) | **7.14.1** — `design/coding-convention/` (audit + view + chat-to-revise live on the Code-health page, post-onboarding) | consumes  |
| **Import work items (optional)**                | **7.16.1 / MOTIR-937** — `design/import/` (importer MOTIR-816; wired MOTIR-1643)                                       | composes  |
| Light discovery (step 4)                        | **7.2.1** — `design/ai-chat/` (build MOTIR-804)                                                                        | composes  |
| Code-aware generate + review (5–6)              | **7.3.1** — `design/ai-planning/` + `design/ai-chat/planning-workspace` (7.4)                                          | composes  |
| The `/onboarding/import` host route             | **7.22.4 / MOTIR-1462** (placeholder the wizard replaces in place)                                                     | replaces  |

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
      backlog / Next), secondary (Back / Set from defaults), ghost (Cancel / Skip / View), and the
      **disabled** state (the index gate's Next); sizes md + sm.
- [x] **Pill** (`components/ui/Pill.tsx`) — provenance (Adopted `success` / Proposed `status=planned`),
      sync/selection/progress (`Selected` mint, `61%` sky, `Not selected` neutral), and the `N proposed`
      lavender count. No custom tone invented — all are shipped `Pill` variants.
- [x] **Switch** (`components/ui/Switch.tsx`, `role="switch"`) — the per-repo sync toggle (Panel 1).
- [x] **EmptyState** (`components/ui/EmptyState.tsx`) — the connect-failed + resume states (Panel 6):
      Card root, centred icon tile + serif title + `--el-text-subtitle` desc + action.
- [x] **Input / composer** grammar — the discovery chat composer AND the **convention chat-to-revise**
      composer ("Tell Motir what to change…"). The convention is **read-only** (a **View**, not a Textarea
      free-edit) — revised via chat, mirroring the onboarding read-only-doc + react-in-chat model (the
      `design/ai-chat` "no inline editing" rule). Approve is the only write the user performs.
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
- [x] **The optional import step composes `design/import`, embedded not redrawn** (#82) — the `.substeps`
      sub-rail (Connect → Map → Preview → Import) + the `.src-grid` source picker (5 `.src` tiles on the
      exact `--el-tint-*` slots `design/import` assigns) are a compact EMBED that cites the importer's own
      asset; its Connect/Map/Preview/Import internals are NOT re-specified here. New arrangement of `Card` +
      tile grammar; no new primitive.
- [x] **The embedded surfaces compose their OWN primitives** — Connect = 7.7.1's grant-rows + repo-rows (a **multi-select** repo set) + Switch; Audit/conventions = 7.14.1's grade tile + provenance pills, composed **once per repo**; Import = `design/import`'s wizard (embedded); Discovery = 7.2.1's
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
