# Migrate-onboarding wizard — design notes (`design/onboarding-migrate/`)

**Subtask:** MOTIR-930 · 7.15.1 (`type: design`) · **Story:** MOTIR-815 (Migrate-existing-codebase
onboarding, Workflow B) · **Epic 7 · AI Planning Layer.**

The **wizard** for onboarding an EXISTING codebase into Motir. **Required core = Connect + Index** (link
the repos, Motir reads the code + silently derives per-repo conventions + a code-health check, auto-used,
nothing to approve). Everything after — **optional**: import your existing backlog, then plan in the
**existing universal plan screen** (`PlanningWorkspace`, MOTIR-1193/1299 — already built, NOT designed
here; the wizard just opens it after import). It is the layout source of truth for the wizard UI code
subtask **7.15.5 / MOTIR-934** and the orchestration wiring **7.15.2 / MOTIR-931** (both `blocked_by`
this card), and for the state-machine scaffolding **7.15.2a / MOTIR-1499**.

> **⭐ Scope — this card designs the ORCHESTRATION SHELL + the INDEX step; it COMPOSES the rest.** The
> wizard is a stepped frame that embeds surfaces four other Stories already designed. Per `notes.html`
> mistake **#82** (a design that composes an already-designed sub-surface must GROUND in that
> sub-surface's shipped asset and say so — or it gets built twice) and **#31** (the multi-panel /
> design-reference rule), this doc **cites** each embedded surface's owner and reproduces its language;
> it does **not** re-design connect / import / the plan screen. The genuinely new pixels here are (a) the
> **set-up wizard chrome + rail** (Connect · Index required · Import optional) and (b) the **index-progress
> step** (§Panel 2). ~~(c) **THE LANDING** (§Panel 0)~~ — **REMOVED 2026-09-06 (MOTIR-4766, Yue):** what
> the wizard opens at the end is the **regular planning session**, which arrives with the context and
> **waits to be told what to plan**. Nothing about it is migrate-specific, so this asset draws none of it;
> see §Panel 0. Product truths this revision bakes
> in (Yue, 2026-07): the **required core is just Connect + Index**;
> **conventions + code-health are derived SILENTLY, auto-used, with NO approval and NOT surfaced in
> onboarding** — they live on the Code-health page (§The spine, and the removed-Panel-3 §); conventions
> are **PER REPO** (§Multi-repo); **import + planning are OPTIONAL**; and the **optional import step
> composes `design/import`** (§Panel 3), embedded not redrawn.

**Asset files (three, shared basename):** `design-notes.md` (this file) ·
`onboarding-migrate.mock.html` (source of truth, standalone — re-states the real
`packages/design-system/theme.css` Tier-0 `--color-*` + shape scale, the Tier-3 `--el-*` layer, and
the `[data-theme='dark']` overrides 1:1 so it paints without the Tailwind build, exactly as
`design/coding-convention/convention.mock.html` does) · `onboarding-migrate.png` (full-page export,
light theme, Playwright chromium, `deviceScaleFactor: 1` (dropped from 2 only to keep the pack
pushable over a slow link — re-render at 2 when connectivity is healthy), 1200px wide). Dark parity was
verified by
toggling `data-theme="dark"` in the mock header.

---

## Designed against SHIPPED REALITY (design-against-shipped-reality)

Read the real surfaces this wizard lands in / replaces before drawing — the mock fits and extends the
implemented app, it does not invent a host:

- **`app/(onboarding)/onboarding/migrate/page.tsx`** — the wizard's **OWN route**, and its host.
  > **⚠️ Route amended 2026-07-27 (MOTIR-1710).** This section originally named the provisional
  > `/onboarding/import` hand-off placeholder (7.22.4 / MOTIR-1462) as the host, which "this wizard
  > replaces IN PLACE." That is **no longer true**: `/onboarding/import` is now the shipped **issue
  > importer** (7.16.6 / MOTIR-942 — `ImportWizard`, Connect → Map → Preview → Run), so the migrate
  > wizard took a route of its own. Verified on `origin/main` (rung 2): the wizard ships at
  > `app/(onboarding)/onboarding/migrate/page.tsx` + `_components/MigrateWizard.tsx` (7.15.5 /
  > MOTIR-934), and `app/(onboarding)/onboarding/import/` holds the importer. Everything else this
  > section specifies about the host still holds — only the route changed. (The importer is not
  > displaced by this: the wizard **composes** it as the optional Import step, §Panel 3.)
- **`app/(onboarding)/layout.tsx`** — the onboarding route group renders **OUTSIDE** the `(authed)`
  `AppLayout` (no top nav, no project sidebar) but is still **authenticated** (bounces a signed-out
  visitor to `/sign-in`). So the wizard **owns the whole viewport** with only a minimal brand bar —
  matched exactly, mirroring `design/onboarding-entrance`. (Onboarding is the one full-page first-run
  _route_, not the dismissable planning overlay — per `design/ai-chat`.)
- **`components/onboarding/OnboardingEntrance.tsx`** — the inbound door: the entrance's secondary
  import row (the `GitBranch` "I have an existing project — import it" button) → **`/onboarding/migrate`**
  (verified on `origin/main`; amended with the route above — MOTIR-1710).
  The wizard's brand bar continues the entrance's exact chrome (the `Sparkles` logo tile on
  `--el-tint-lavender`, the signed-in avatar).
- No wizard / stepper primitive ships in `components/ui/` — the **step rail is a NEW ARRANGEMENT** of
  shipped primitives (the same way `design/ai-chat`'s canvas roadmap and `design/coding-convention`'s
  onboarding step-strip are new arrangements). The precedent for a wizard step-strip is
  `design/coding-convention` Panel 5 ("Discovery ✓ → Design system ✓ → **Establish convention**
  (current) → Review plan") — this rail generalises it to the migrate steps (Connect · Index + the optional tier).

---

## ⭐ Multi-repo + multi-provider — a project spans several repositories, on GitHub OR GitLab (Yue)

**A real existing codebase usually spans more than one repository** (a web app + an API + a shared
package) — **and those repos can live on GitHub OR GitLab** (a project may span both, Yue 2026-07-09).
The first draft collapsed the flow to a single GitHub repo (`acme/web@a1b9f30`, one code graph, one plan);
this is corrected so the WHOLE wizard is **multi-repo and multi-provider**. Grounded in **shipped reality**
(rung 2 — read on disk this session, not assumed):

- **Multi-provider is ARCHITECTED, not invented — the `GitProvider` seam (`lib/git`, MOTIR-891 / 7.10).**
  Both `GithubInstallation` and `GithubRepo` carry a **`provider` discriminator** (`@default("github")`),
  and the schema comment is explicit: _"every downstream read goes through the GitProvider seam (`lib/git`),
  so GitLab/Bitbucket is purely additive (MOTIR-1470 implements the same seam under `provider: 'gitlab'`)."_
  `lib/git/` ships `provider.ts` (the ONE `GitProvider` interface), `registry.ts` (dispatch by the stored
  discriminator), and `providers/github.ts` (the first impl). So the Connect step offers **GitHub App +
  GitLab OAuth**, persists each repo with its `provider`, and every consumer (index, audit, plan) reads a
  provider-agnostic `NormalizedRepo` through the seam. **The GitLab provider itself (connect / OAuth /
  fetch / webhook) is Story MOTIR-1470 "GitLab integration"** (To Do) — this design draws the
  multi-provider Connect surface + flags MOTIR-1470 as the runtime dependency; it does NOT build the GitLab
  client. **GitHub is the day-one connect path; the GitLab affordance is feature-gated until MOTIR-1470
  ships** (so the wizard never renders a dead "Connect GitLab" button — build note on MOTIR-934, modeled
  `relates_to` not `blocked_by` so GitHub isn't delayed). Each Connect repo-row + the landing done-card are
  **provider-tagged**.
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

| Step                                                          | Multi-repo treatment                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Connect** (Panel 1)                                         | "Connect the repositories in this project" — **multi-provider**: a **GitHub** card (Motir App) + a **GitLab** card (OAuth), then a **multi-select** repo list (acme/web · GitHub, acme/api · GitLab, acme/shared · GitHub — each provider-tagged) + a "**3 repositories** selected (2 GitHub · 1 GitLab)" summary. Reads through the `GitProvider` seam; GitLab client = MOTIR-1470. |
| **Index** (Panel 2)                                           | **One code graph across all repos**, built **per repo**: a `.idx-repo` list — each repo its own progress bar + state (`Indexed` / `Indexing…` / `Queued`) — under an **aggregate meter** ("2 of 3 repositories done · 78%"). The **gate is aggregate**: Next stays disabled until **every** repo finishes. Complete state = "3 of 3 indexed · 5,412 files · 31,208 symbols".         |
| **Conventions + code-health** (NOT an onboarding step)        | Derived **PER REPO** from the code + a code-health check, **auto-used, NO approval, NOT surfaced in onboarding** — the Index-complete state just notes "conventions + code-health derived, nothing to approve; on the Code health page". The audit + read-only View + chat-to-revise all live on the **Code-health page (7.14)**, post-onboarding.                                   |
| **Planning** (the universal plan screen — not a wizard panel) | Reached after the optional import step; grounded in the **whole-project code graph** across all repos — each proposed item carries a **repo tag** (`acme/api` / `acme/web`) and honours that repo's convention; cross-repo proposals (reminders reuse the API's service) read naturally. NOT designed here — the existing `PlanningWorkspace` (MOTIR-1193/1299).                     |
| **States** (Panel 4)                                          | Index failure is **per-repo** — "acme/api failed; the other 2 stay indexed · Re-run acme/api" (a scoped retry, not a full re-index). Resume names the whole set ("set up — paused before the optional import / plan steps").                                                                                                                                                         |

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
  "the home of ALL AI"). This card invents NO bespoke chat and NO planning panel: the migrate wizard
  **opens** the shared planning screen (after the import step, and via the top-bar Plan-with-AI) — it does
  not re-draw it.

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

## The spine — a set-up wizard, then a full-screen plan screen (the model this draws)

1. **A grouped rail during SET-UP; then a full-screen plan screen with NO left nav.** The set-up wizard's
   rail is split into **"Set up your codebase" (required)** — **`Connect · Index`** — and **"Import your
   work · optional"** — **`Import work items`**. Each step's state: **done** (mint check), **current**
   (accent marker + an `--el-accent-on-surface` ring row), **upcoming** (quiet outline marker), **optional**
   (a **dashed** marker). A `.rail-group` header carries the tier name; the optional tier's header carries
   an `optional` chip. The required steps are numbered (`Connect 1 · Index 2`); **Import work items** uses a
   **download-icon** marker. **★ After the (optional) import step the user LEAVES the rail entirely** — they
   land on the **full-screen universal plan screen** (§Panel 0), which has **NO left nav**; the finished
   set-up steps re-appear there as **done-cards** (Yue, 2026-07-07).
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
3. **★ Import is optional; then you LAND on the full-screen plan screen (Yue, 2026-07-07).** After Connect
   - Index, the **Import work items** step is skippable ("Skip — no backlog to import"). Whether the user
     imports or skips, the forward CTA (**"Open planning workspace"**) drops them onto the **full-screen
     universal plan screen** (§Panel 0) — the EXISTING `PlanningWorkspace` (MOTIR-1193/1299), **no left nav**
     — where the finished steps show as **done-cards** (Connected · Indexed · Imported) and Motir proposes a
     code-aware plan **reconciled with the import**. Finishing without planning ("Finish — plan later" /
     Save & exit) drops the user into the project instead; **"Plan with AI"** in the top bar reopens the plan
     screen any time. (This REPLACES the earlier locked-Generate gate, the convention approve-step, AND the
     bespoke discovery/generate panels — all gone; planning is the one existing plan screen.)
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

### Panel 0 — REMOVED: the wizard's ending is a REGULAR PLANNING SESSION, and it is not drawn here

**Superseded 2026-09-06 (MOTIR-4766), at Yue's direction.** The panel drew a bespoke landing —
finished-step done-cards, a `.plan-lead` reading _"**Your codebase is in Motir.** Here's a plan grounded
in your code…"_, a `.canvas` already full of dashed **proposed** subtask nodes, and a confirm bar reading
_"6 proposed · nothing saved yet"_. That depicts **a planner that had read the repository and handed over a
plan nobody asked for**, and that is not what a planning session is.

**A REGULAR session arrives with the context and WAITS to be told what to plan.** The code graph, the
imported backlog and the direction are what it has; the user's ask is what it acts on. It asks; it does not
propose a tree unprompted. That is the same behaviour `motir-ai`'s routing verdict names for its
`continue` outcome (**MOTIR-4767**: _the session asks and plans exactly as a regular session does_), and it
is what a person doing a planning pass by hand actually experiences.

**So there is nothing migrate-specific to draw at the end of this wizard.** Set-up finishes, the universal
plan window opens, and the session begins the way every session begins — on this project, on any project,
on any day. The design of record is `design/ai-chat/planning-workspace.mock.html` (MOTIR-1193 / MOTIR-1299)
and, for a project arriving with never-approved onboarding, `design/ai-chat/reading-and-handoff.mock.html`
(MOTIR-4766). The panel's slot in the mock is now a NOTE saying this, rather than an absence: a panel
removed with no reason attached is one the next card re-draws.

**This document's own model said so before the panel contradicted it** — §The spine already reads _"Planning
is NOT designed here — it is the EXISTING universal plan screen"_. Where earlier sections below still speak
of _"the landing"_, _"the done-cards"_ or _"§Panel 0"_ as drawn surfaces, they are describing this removed
panel; the mechanism they describe (set-up finishes → the plan window opens) is unchanged, the **pixels are
not this asset's**. The `.plan-screen` / `.done-card*` / `.plan-lead` / `.plan-body` / `.canvas` / `.node` /
`.confirm-bar` / `.chat` / `.bubble` / `.composer` rules went with the markup rather than being left as a
set a later panel could quietly re-adopt.

### Panel 1 — Connect repos (step 1) — MULTI-PROVIDER (GitHub + GitLab) — **composes 7.7.1 (`design/github/`) via the `GitProvider` seam**

The connect surface as step 1, framed as **multi-repo + multi-provider** (§Multi-repo above). H1
**"Connect the repositories in this project"**, lead "A project usually spans more than one repository —
and they can live on **GitHub or GitLab** (a project may span both). Connect the host(s) your repos are
on…". The cite reads "Composes 7.7.1 · design/github/ · reads through the **GitProvider seam (`lib/git`)**
— GitLab is provider MOTIR-1470". **Two provider cards:**

- **GitHub — the Motir App** (`seclabel` "GitHub"): the composed 7.7.1 two-step grant — two `.grant-row`s
  (**Step 1 · Identity** "Verify your GitHub identity" · public profile only, no code access; **Step 2 ·
  Repository access** "Install the Motir GitHub App" · you pick the exact repos) + the **"Connect GitHub"**
  primary `Button` (github-mark). Owned by 7.7.1 — cited, not re-designed.
- **GitLab** (`seclabel` "GitLab"): a parallel provider card — one `.grant-row` (**OAuth · you pick the
  projects** "Authorize Motir on GitLab" · gitlab.com or self-managed; "same provider seam as GitHub —
  repos from both hosts join one project") + a **"Connect GitLab"** secondary `Button` (gitlab tanuki
  mark). This is the NEW multi-provider affordance; the runtime GitLab client is **Story MOTIR-1470**.

Then the **multi-select repo list** (`repo-row`s: repo icon + `owner/name` + a `main` branch `code` chip +
a **provider `Pill`** (`GitHub` / `GitLab`) + a **Selected** `Pill` + a `Switch`) — **acme/web (GitHub) ·
acme/api (GitLab) · acme/shared (GitHub)**, showing a project that spans BOTH hosts — with a "**3
repositories** selected (2 GitHub · 1 GitLab)" summary + the honest out ("update the Motir App's access on
GitHub, or your GitLab project authorization"). Each repo persists with its `provider` discriminator;
index / audit / plan read it provider-agnostically through the seam.

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
"**Imported items reconcile with your plan** — when you plan next in your workspace, Motir de-dupes
against the imported backlog; an imported ticket wins, generation only adds the gaps your code implies."
Footer: Back · **"Skip — no backlog to import"** · **"Finish — plan later"** · the primary
**"Open planning workspace"** (sparkle) — which opens the existing plan screen. The step is wired by
[MOTIR-1643] (the import-step state machine + reconcile) and built by [MOTIR-934]; the importer engine +
its standalone wizard are [MOTIR-816] / [MOTIR-942]. **The importer's Connect/Map/Preview/Import internals
are OWNED by `design/import` — cited, not re-specified here.**

### Planning is the EXISTING full-screen plan screen — you LAND on it, no left nav (Yue, 2026-07-07)

The migrate flow designs **no discovery / generate / review panels**. Planning is the **universal plan
screen that is already implemented** — the `PlanWithAILauncher` → `PlanningWorkspace` (MOTIR-1193 /
MOTIR-1299, `design/ai-chat/planning-workspace`), the ONE surface every AI-planning flow already uses. It
is **full-screen with NO left nav**. So this card does **not** re-draw the plan screen (compose-don't-redraw,
#82); it draws **the LANDING on it** (§Panel 0) — which is where the migrate-NEW work lives: the
**finished-step done-cards** (Connected · Indexed · Imported, so progress shows as cards, not a rail) + the
**reconcile framing** (the plan de-dupes against the imported backlog). ⚠️ Two earlier drafts were wrong
here — (a) a rail-handoff "Plan your project" step, and (b) a bespoke "chat"/generate panel; **neither is
the universal plan screen. You LAND on the real full-screen screen (no left nav), with the finished steps
as cards.**

**How it's reached.** After the (optional) **Import work items** step (import OR skip), the forward CTA
**"Open planning workspace"** drops the user onto Panel 0 — the full-screen plan screen. It is also
reachable any time from **Plan with AI** in the top bar. There is **no "Plan your project" rail step** — the
set-up rail ends at Import; the plan screen is a separate full-screen surface you transition to.

**Nothing to design/build here for the plan screen itself** — the wizard UI subtask (MOTIR-934) transitions
the user onto the shipped `PlanningWorkspace` after import and renders the migrate-specific done-cards on
it; it does not build a planning surface.

### Panel 4 — finished-early / error / resume states

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

| Step / surface                                  | Owner (design → build)                                                                                                                                             | This card                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| **Wizard chrome + step rail + gate**            | **MOTIR-930 (this design) → MOTIR-934 (UI) + MOTIR-931 (wiring) + MOTIR-1499 (state)**                                                                             | designs                                                             |
| **Index-progress step**                         | **MOTIR-930 (this design)** — the NEW step it owns                                                                                                                 | designs                                                             |
| Connect repos (step 1, GitHub + GitLab)         | **7.7.1** — `design/github/` (GitHub, build MOTIR-895) · **GitProvider seam** `lib/git` (MOTIR-891) · **GitLab provider = MOTIR-1470**                             | composes GitHub; draws the multi-provider surface, flags MOTIR-1470 |
| Conventions + code-health (derived, NOT a step) | **7.14.1** — `design/coding-convention/` (audit + view + chat-to-revise live on the Code-health page, post-onboarding)                                             | consumes                                                            |
| **Import work items (optional)**                | **7.16.1 / MOTIR-937** — `design/import/` (importer MOTIR-816; wired MOTIR-1643)                                                                                   | composes                                                            |
| Planning (discovery / generate / review)        | **The EXISTING universal plan screen** — `PlanWithAILauncher` → `PlanningWorkspace` (MOTIR-1193 / 1299), already built                                             | opens (not designed here)                                           |
| The `/onboarding/migrate` host route            | **MOTIR-930 (this design) → MOTIR-934 (UI)** — the wizard's OWN route in the `(onboarding)` group (`/onboarding/import` is the issue importer, 7.16.6 / MOTIR-942) | owns (route amended — MOTIR-1710)                                   |

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
| Rail group headers                         | `.rail-group` `--el-text-secondary` (mono); the `optional` chip `--el-accent-on-surface` on `--el-callout-bg`                                                                           |
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
- [x] **The set-up step rail** (Connect · Index required · Import optional) — a NEW ARRANGEMENT of
      `Card`/list-row grammar + tint marker tiles + `.rail-group` tier headers + lucide `check`,
      generalising the `design/coding-convention` Panel 5 wizard step-strip. Done/current/upcoming/**optional**
      states pair a glyph or a dashed marker + a label + a tint (never colour-alone — finding #35). The rail
      exists ONLY during set-up; the landing (§Panel 0) has no rail.
- [x] **The per-repo index list** (`.idx-repo`) + **the per-repo convention list** (`.conv-repo`) — NEW
      ARRANGEMENTS of list-row grammar + a progress bar / grade tile + shipped `Pill` tones, so a
      **multi-repo** project indexes with per-repo status (aggregate gate) and reviews **one convention
      per repo**. No new primitive.
- [x] **The landing done-cards** (`.done-cards` / `.done-card`) — the finished set-up steps (Connected ·
      Indexed · Imported) shown as `Card`-grammar cards with a mint-check tile, on the full-screen plan
      screen (§Panel 0); + the always-present top-bar **"Plan with AI"** launcher (`.plan-ai`, composes
      `design/ai-chat` / MOTIR-1299). No new primitive.
- [x] **The optional import step composes `design/import`, embedded not redrawn** (#82) — the `.substeps`
      sub-rail (Connect → Map → Preview → Import) + the `.src-grid` source picker (5 `.src` tiles on the
      exact `--el-tint-*` slots `design/import` assigns) are a compact EMBED that cites the importer's own
      asset; its Connect/Map/Preview/Import internals are NOT re-specified here. New arrangement of `Card` +
      tile grammar; no new primitive.
- [x] **The embedded surfaces compose their OWN primitives** — Connect = 7.7.1's grant-rows + repo-rows (a **multi-select** repo set) + Switch; Import = `design/import`'s wizard (embedded); Planning = the LANDING (§Panel 0) — after import the user transitions onto the existing full-screen `PlanningWorkspace` (MOTIR-1193/1299, NO left nav), where this card adds the migrate-specific **done-cards**; the canvas/chat is the shipped surface, not re-designed. Reproduced from their
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

---

## AMENDMENT (2026-09-06 · MOTIR-4755) — a step SATISFIED BY THE SUBSTRATE, not by the user

**Story:** [MOTIR-4753] _The DEPTH of onboarding is a judgement about the project's SUBSTRATE._
**Panel added:** **Panel 5**. Everything above is unchanged.

### The premise this card was written on, AMENDED ON THE RECORD

The card opens: _"The migrate wizard's asset draws its step rail with `Discovery (step 4, 7.2.1)` as
an unconditional row, and it draws exactly one way for a step not to run: import's SKIP."_ **Both
halves are false, and both were checkable in one read at plan time.** Verified (rung 2) before
drawing:

- **The asset draws NO discovery row at all.** `grep -n 'Discovery' onboarding-migrate.mock.html`
  returns exactly one line — `/* ---- Discovery (step 4, 7.2.1) ---- */`, a **CSS section comment**,
  left from an earlier revision. All three rails in the asset draw Connect · Index · Import work
  items and stop.
- **And that is FAITHFUL to the shipped wizard**, which is why nobody noticed. `MigrateWizard.tsx`'s
  `Rail` renders exactly those three `RailStep`s and pushes to `/onboarding/discovery` from the
  discovery step onward — the direction tiers are a different route, drawn nowhere in this rail.
- **The rail draws no SKIPPED state either.** `RailStep`'s state union is
  `'done' | 'current' | 'upcoming' | 'optional'`, and a skipped import takes **`done`** (`rank > 2`),
  so today it is drawn identically to one the user completed. Import's skip is real as **copy** — an
  `onboardingMigrate.import.skip` button and _"Skip this if you have no backlog to bring in"_ — and
  the card quotes that correctly; what it does not have is a rail treatment to contrast against.

**The deliverable is unchanged and is if anything clearer**: this panel does not amend a row, it
ADDS one, in three states, and it has to DESIGN the user-skipped treatment rather than reproduce it.
The card's own _"draw the import row's skipped state beside it"_ already asked for exactly that.

### What Panel 5 depicts, and where each behaviour came from

**GROUNDED, NOT INVENTED.** Every behaviour below is read off a sibling card's `descriptionMd`; this
asset decides how it LOOKS and nothing about what it DOES.

| depicted                                                           | grounded in                                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| A direction row that does not run because the substrate answers it | **MOTIR-4759** — _`discovery` becomes a SATISFIABLE migrate step, not a mandatory one_                             |
| That the wizard ADVANCES past it rather than the user skipping it  | MOTIR-4759's _"the wizard advances past it when the substrate read says the repository and the backlog answer it"_ |
| The FLOOR — no repository and no backlog ⇒ the questions asked     | MOTIR-4759's _"the floor case still walks the tiers"_, and **MOTIR-4758**'s guaranteed floor (motir-ai)            |
| That the run RECORDS which way it went, so the surface can say so  | MOTIR-4759's _"the run records which way it went"_ — the provenance line is that record, rendered                  |
| That the entrance routes a repo-carrying project here by DEFAULT   | **MOTIR-4756** — the substrate read + `shouldRouteToMigrateWizard` deciding on both inputs                         |
| The two questions the satisfied row claims are answered            | **MOTIR-4758** — the test is the floor tiers' own questions (What/Who · In-v1/Out)                                 |

### The three states, and why none of them is the `done` tick

A step can fail to run for two opposite reasons. **SKIPPED is the user's** — they were offered a
thing and declined it. **SATISFIED is Motir's** — it read their repository and their backlog and did
not need to ask. Dressing the second in the first's clothes tells a user they passed on something
they were never shown; dressing either in the **done** tick says they did the step.

| row state                                      | marker fill                                                         | glyph             | name                           | meta line                                  |
| ---------------------------------------------- | ------------------------------------------------------------------- | ----------------- | ------------------------------ | ------------------------------------------ |
| `pending` (`.step.current`)                    | `--el-accent` on `--el-surface-soft`, ring `--el-accent-on-surface` | **question mark** | _"A few questions"_            | _"What you're building, and who for"_      |
| `user-skipped` (`.step.skipped`, NEW)          | `--el-muted`, border `--el-border`                                  | **dash**          | the step's own name            | _"You skipped this"_ — whose choice it was |
| `substrate-satisfied` (`.step.satisfied`, NEW) | `--el-tint-sky`, border `--el-border`                               | **book / read**   | _"Answered from your project"_ | _"Your code and your backlog said it"_     |
| `done` (unchanged)                             | `--el-success-surface`                                              | check             | the step's own name            | —                                          |

**Not colour-alone** (the standing rule): each of the three pairs a distinct GLYPH and a distinct
NAME-or-META with its tint, so the states are separable in greyscale and to a screen reader.

**And the pending marker is a QUESTION MARK, not a numeral.** Revision 1 numbered it `3`, which
invents a global sequence: the rail numbers Connect `1` and Index `2`, and Import carries a glyph, so
a `3` on the fourth row implies a step count that skips one. It also asserts a position this row does
not have — the direction stage is not the third of four steps, it is a stage that may not run at all.
A question mark says what the row is in the one character the marker has. (The SHIPPED `RailStep`
renders no glyph at all for `current` — an empty accent dot — so the numerals are this mock's own
flourish and were free to drop.)

### ⚠️ ONE ROW, AND IT NEVER NAMES A TIER (Yue, 2026-09-06)

**An earlier revision of this panel drew the direction stage as FOUR rows — Discovery, Vision,
Feasibility, Validation — and that was wrong for the same reason "Pre-plan" was wrong.** Those are
the planner's identifiers (`DirectionDocKind`, `producibleTiers`) for questions the user is simply
being asked. A rail that lists them by name teaches a stranger four words before it tells them
anything, and it does it on the first surface they ever see. **This is MOTIR-4757's rule one surface
over** — internal vocabulary travelling out of the rule corpus into user-facing text, written in
good faith by somebody who had just been reading the corpus — and a design asset is exactly where
that gets laundered into looking decided.

So the rail carries **one row** for the whole direction stage:

- **pending** — named _"A few questions"_, meta _"What you're building, and who for"_. The user is
  told what the step IS and what it is about; which four documents it produces is the planner's
  business.
- **satisfied** — the NAME carries the outcome, _"Answered from your project"_, because a row the
  user never saw has to explain itself in the one place they meet it. The meta line says which part
  of the project answered.

**And the FLOOR rail collapses with it.** It used to draw all four tiers to make the point that they
are all walked; it now draws the one row in its pending state, which makes the same point without
the vocabulary. Nothing about the floor's BEHAVIOUR changed — every question is still asked, and no
state above is reachable from there.

**⚠️ AND THE FLOOR'S SET-UP ROWS ARE `upcoming` / `optional`, NOT `skipped`.** A first draft drew
Connect with a dash and the meta line _"No repository"_, which reads as _the user skipped connect_ —
and **connect and index have no skip control**, so that is a state the machine cannot produce. A
design asset that draws one is worse than useless: the next person builds it. `skipped` is a thing
the user PRESSED, and the only step that offers it is import.

**What the consuming card owes is therefore SMALLER than the first revision implied:** one rail row,
not a four-row group. MOTIR-4759's sizing is amended accordingly.

**The board CHROME still says "discovery"** — the panel label, the state captions, this note. That is
deliberate and is the distinction the whole section is about: chrome is addressed to whoever builds
the surface, and the rail is addressed to whoever uses it. Only one of the two is a place the
planner's own nouns may appear.

### The PROVENANCE line — a statement, never a gate

Drawn in the hand-off panel, on the surface the user lands on:

> _Motir planned from **acme/widgets** and **214 imported work items**, so it did not ask you the
> direction questions. Everything below is a proposal — change anything before you add it._

- **It is not a question and not a confirmation**, and the flow does not wait on it. The depth
  decision is the planner's (MOTIR-4758) and what the user reviews is the PLAN it produced, so this
  is provenance, not an approval.
- **The escape beside it is a button, not a gate**: _"Answer the questions anyway"_. A plan that came
  out thin from a run that never asked anything needs the user able to see why and to reach the
  interview; it does not need the interview made mandatory again.
- Ink is **`--el-text-secondary`** on **`--el-surface-soft`** (6.51:1). `--el-text-muted` there is
  4.34:1 and would fail AA — the standing pair-not-ink rule, which is why the annotation ink in this
  panel is `--el-text-secondary` throughout.

### The ACCESS PATH

The existing-project tile on `/onboarding` (composes `design/onboarding-entrance/`), drawn at board
scale so a reader sees the door and not only the room. **It is no longer the only way in** — per
MOTIR-4756 the entrance now routes a project with a connected repository here by DEFAULT.

**Its copy is the SHIPPED copy, verbatim** — `onboarding.entrance.importTitle` / `importDesc` — and
**this card amends no entrance string**. An earlier draft of this panel rewrote the tile's body to
promise that Motir reads first; that promise is already in the shipped copy (_"Connect your
repository and Motir reads your code, then plans on top of what's already there"_), and inventing a
second wording would have left an unowned deliverable in a design asset with no card to build it —
the deferral-is-a-card shape, one layer over. Drawn as it ships, the door already makes the promise
the rail below keeps.

### Vocabulary

**No panel, label or annotation in this asset uses "Pre-plan"** — it is corpus vocabulary, not the
product's, and the sibling **MOTIR-4757** is retiring it from the two onboarding topbar strings. The
product's own noun is used throughout: **your direction**.

### Tokens this amendment adds to the asset (no new colours)

`.step.satisfied` · `.step.skipped` · `.provenance` · `.door` · `.rail-mini` · `.triptych` — composed
entirely from tokens the asset already declares: `--el-tint-sky`, `--el-muted`, `--el-surface`,
`--el-surface-soft`, `--el-card`, `--el-card-icon-bg` / `--el-card-icon-fg`, `--el-border`,
`--el-text-strong`, `--el-text-secondary`, and the shape tokens `--radius-card` / `--radius-control` /
`--radius-badge`. **No raw hex, no Tier-0 `--color-*`, no raw `rounded-*` / `p-*` / `h-*` on a
surface's own box.**

---

## AMENDMENT (2026-09-06 · MOTIR-4766) — the PLANNER-DECIDED step set: a rail SHORTER than the full one

**Panel 6 of `onboarding-migrate.mock.html`.** MOTIR-4755 (the amendment above) gave ONE step that
did not run its own state. This amendment is what happens when SEVERAL of them do not run, because
the planner now returns which steps to KEEP.

### Where each depicted behaviour comes from (grounding, not invention)

| Behaviour drawn                                                  | Grounded in                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| The kept-step set exists at all, and is the PLANNER's answer     | **MOTIR-4767** — the routing verdict. On `onboard_existing_project` it carries THE KEPT STEPS and WHAT IS MISSING.       |
| The set travels to the wizard with the move                      | **MOTIR-4769** — "carrying the KEPT STEPS and the missing-list… `motir-core` does not second-guess the verdict."         |
| The wizard renders exactly that set                              | **MOTIR-4759** — `discovery` becomes a SATISFIABLE step; the run records which way it went.                              |
| A step may be satisfied by the substrate rather than by the user | **MOTIR-4755** (the amendment above) — the `satisfied` state, its sky tint and its read glyph. Reused here, not redrawn. |
| A kept step naming something the wizard does not have is refused | **MOTIR-4767 AC6** — validated upstream, so the rail never has to draw one.                                              |

### The decision — COLLAPSE, do not delete

The failure this panel is avoiding is MOTIR-4755's, at scale. That amendment established that a step
which silently vanishes reads as something taken from the user. With one step, the remedy was to
give the row its own state. **With three, giving each of them a `satisfied` row produces the
opposite problem**: a rail whose subject is the list of things the user did not do, sitting beside
the one thing they did.

So the steps that are not kept **collapse into ONE row, in the `satisfied` treatment, and that row
names them**:

```
YOUR DIRECTION                         →  ALREADY ANSWERED BY YOUR PROJECT
                                          [read] Connect, Index and Import
                                                 Read from acme/widgets and your 214 work items
```

The rail gets shorter; nothing vanishes. The group heading carries the sentence (_Already answered by
your project_) and the meta line says WHAT answered it — the same claim the provenance line makes at
the end of the flow, so the two cannot drift.

### Three states drawn, and why each is needed

1. **The FULL set** — no repository and no backlog, so the planner keeps everything and there is
   nothing to collapse. The rail is exactly the one that shipped. This is the floor, unchanged from
   MOTIR-4755's Panel 5, and it is here so the shortened rails have something to be shorter THAN.
2. **Planner kept ONE** — three steps collapse into a single row; `A few questions` is the only live
   step.
3. **Planner kept TWO** — a repository that is real but thin. **Connect and Index are satisfied and
   Import is not**, so the collapsed row sits ABOVE a live step it does not precede in the shipped
   step order. This case is drawn deliberately: it is the proof that the kept set is **not a prefix,
   a suffix or a count**, so the rail must render whatever the planner returns rather than "the last
   N steps".

### What the user is told at the end

The provenance line from MOTIR-4755 gains **one clause and no new mechanism**:

> Motir planned from **acme/widgets** and **214 imported work items**, and from the two answers you
> gave. **Connect, Index and Import** were already answered by your project, so it did not ask you
> about them. Everything below is a proposal — change anything before you add it.

It stays a STATEMENT, not a gate: the escape back to the interview is the same
_Answer the questions anyway_ button, and the flow does not wait on it.

### The four rules this panel holds itself to

1. **A step that is not kept is COLLAPSED, never deleted.**
2. **One collapsed row, not N satisfied rows** — the single-row treatment is right for one step and
   wrong for four.
3. **No row names a tier.** `discovery` / `vision` / `feasibility` / `validation` are the identifiers
   a kept-step set travels as (MOTIR-4767 validates against them) and they stay identifiers; the
   rail says _A few questions_ and _Your direction_, exactly as MOTIR-4755 revision 2 settled after
   Yue's note. **No string in this panel contains "Pre-plan".**
4. **The rail renders the verdict; it does not audit it.** No count, no threshold and no
   re-derivation from the substrate decides what is drawn (MOTIR-4769's own boundary).

### Primitives and tokens (nothing new)

`Rail` / `RailStep` as shipped in `app/(onboarding)/onboarding/migrate/_components/MigrateWizard.tsx`
— the `.step` / `.marker` / `.s-name` / `.s-meta` structure, the `.rail-group` heading with its
`.opt` chip, and the `.step.satisfied` / `.step.current` / `.step.upcoming` / `.step.optional`
states. Panel 6 adds **no class, no colour and no shape token**: it is `--el-tint-sky` +
`--el-text-strong` + `--el-border` on the collapsed marker (the `satisfied` recipe verbatim),
`--el-surface` / `--el-surface-soft` / `--el-card` grounds, `--el-text-secondary` for every meta and
annotation line, and `--radius-card` / `--radius-control` / `--radius-badge` for shape. No raw hex,
no Tier-0 `--color-*`, no raw `rounded-*` / `p-*` / `h-*` on a surface's own box.

### Also in this pass — Panel 0 was REMOVED (Yue, 2026-09-06)

Not part of the kept-step work, but landed under the same card because the same mistake was in both
assets: Panel 0 drew a bespoke landing in which the planner had read the repository and handed over a
plan nobody asked for. **A regular planning session arrives with the context and WAITS to be told what
to plan.** Nothing about the end of this wizard is migrate-specific, so there is nothing here to draw;
the panel's slot is now a note saying why, and `design/ai-chat/`'s Panel 5 (the RETURN) was corrected
in the same pass for the same reason. Full record in §Panel 0 above.

### The other half of this design lives in `design/ai-chat/`

The hand-off that SENDS a user here — and shows them the kept set before they commit to it — is
`design/ai-chat/reading-and-handoff.mock.html` Panel 4, published under the same card. The two
assets share the `satisfied` vocabulary on purpose: the chip strip in the hand-off and the collapsed
row in the rail are the same fact, said once before the journey and once during it.

## 2026-10-12 — the vibe layout on the migrate wizard: the lockup in the bar, a hero and a work band (MOTIR-8251)

**Amends:** MOTIR-930's wizard (§ _Panels_, the `BrandBar` and every step panel, and § _Per-element
`--el-*` colour role_) and the MOTIR-4759 amendment above (the resume panel and the collapsed rail).
**Delta mock:**
[`onboarding-migrate--vibe-layout.mock.html`](./onboarding-migrate--vibe-layout.mock.html).
`onboarding-migrate.mock.html` is a record and is **not edited**. Story MOTIR-8238; sibling sections:
[`design/import/design-notes.md` § 2026-10-12](../import/design-notes.md) (the importer) and
[`design/ai-chat/design-notes.md` § 2026-10-12](../ai-chat/design-notes.md) (the discovery top bar,
the chat rail and the direction-doc page).

**Composes, never re-draws:** MOTIR-8250's Pattern panel —
`design/onboarding-entrance/onboarding-entrance--vibe-layout.mock.html` **Panel 6** (A the lockup ·
B the hero · C one section band) and
[`design/onboarding-entrance/design-notes.md` § 2026-10-11](../onboarding-entrance/design-notes.md).
`OnboardingHero`, `HeroWaves` and `OnboardingSection` are that card's product-local parts, built by
MOTIR-8252. This section adds one **variant** (the compact hero) and one composition (the work band),
and nothing else.

**Design system — files read:** root `package.json` (`"@motir/design-system": "workspace:*"`),
`app/globals.css` (line 13 `@import '@motir/design-system/theme.css'`, line 25
`@import '@motir/brand/brand.css'`), `packages/design-system/package.json` (**`0.13.0`**, exports
`./mock`), `app/layout.tsx`. No `DESIGN.md`. **Verdict: ON MOTIR DESIGN — branch (a).** The mock is
built with `renderMock` from the package's real `Button`, `Card`, `Pill`, `Spinner` and
`buttonVariants`; `BrandMark` (`lockup`, `glyph`) and `WAVE_BAND_PATH` come from `@motir/brand`
with `brand.css`'s lockup rules inlined. Axes are the `:root` defaults —
`data-style="warm-editorial"` · `data-palette="motir"` · `data-type="motir"` — and every frame is a
`[data-appearance-scope]` carrying `data-theme` and the axes. `--focus-ring-color` is re-pointed to
`--el-accent-on-surface` per frame, as MOTIR-8250 finding F4 did. Nothing is proposed for the package.

**Shipped reality read** at the branch head: `app/(onboarding)/onboarding/migrate/_components/MigrateWizard.tsx` (the
`BrandBar`, `Rail`, `StepHead`, `PanelFoot` and the six panels), `messages/en.json` as MOTIR-8248 left
it. Every string drawn is read by key; none is typed. **motir.co, read and never imported** —
`motir-marketing` at `origin/main` **`06c0411`** (only ideas files changed since MOTIR-8250 read
`0c2e37b`): `motir-marketing/app/_components/SiteHeader.tsx` (no fill, no rule, `BrandTile` 28) and
`motir-marketing/app/_components/LanguageSwitcher.tsx` (the globe is the bar's LAST control).

### Panels (light AND dark)

| #   | Panel                                                                                                                                                   | frame   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 0   | Access path — the entrance's import section door ("We can vibe it too") → `/onboarding/migrate`                                                         | 640 × 2 |
| 1a  | Arrival with only the default project — Start skipped, the wizard opens on **Connect** with the **full** hero — Revision 3                              | 1280    |
| 1b  | Start — only when the workspace has two or more projects: the bar, the **full** hero, the rail and the project choice (Revision 4)                      | 1280    |
| 2a  | Connect — compact hero, **Checking** (on arrival) — Revision 1                                                                                          | 1280    |
| 2b  | Connect — **Not connected yet** (Connect GitHub ↗ in a new tab, no Next) — Revision 1                                                                   | 1280    |
| 2c  | Connect — **Waiting for GitHub** (re-checks on focus and every ~5 s) — Revision 1                                                                       | 1280    |
| 2d  | Connect — **Connected** (detected repositories, Continue) — Revision 1                                                                                  | 1280    |
| 3a  | After Connect — straight on to Import, the indexing chip in the bar, Index as a background rail row — Revision 2                                        | 1280    |
| 3b  | The indexing chip opened — the per-repository detail popover over the step — Revision 2                                                                 | 1280    |
| 3c  | Reading failed — the chip and detail in their failed state, on Decision — Revision 2                                                                    | 1280    |
| 4   | Import — optional, with Skip (the chip at the moment reading finishes — Revision 2)                                                                     | 1280    |
| 5   | Decision — Plan now / Finish later, while the code is still being read (Revision 2)                                                                     | 1280    |
| 6   | Resume — a run in progress (MOTIR-4759)                                                                                                                 | 1280    |
| 7   | Error — the typed error alert inside the panel (drawn over 2b)                                                                                          | 1280    |
| 8   | Collapsed rail — the planner-decided set (discovery + import kept, MOTIR-4766)                                                                          | 1280    |
| 9   | Close-ups — 9a planAi / Save & exit rest·hover·focus · 9b language pending·failed·open · 9c indexing chip states (Revision 2) · 9d planNow rest·pending | 640 × 2 |
| 10  | Narrow — arrival on Connect (default project only), and Import with the code being read (chip closed, then opened) — Revision 3                         | 390 × 2 |
| 11  | Narrow — Connect 2b and 2d — Revision 1                                                                                                                 | 390 × 2 |

### What changes, and what does not

- **The bar.** The lavender tile with the AI glyph and the word "Motir" are TAKEN; the `BrandMark`
  **lockup** (22 px) takes their place as a non-link span — this bar has its own exits, and a third
  one on the logo would compete with Save & exit. Then `· {flowName}`, then, trailing: the planAi link
  (`secondary` sm, **its AI glyph TAKEN**, a trailing `ArrowRight`), Save & exit (`ghost` sm), the
  **language control** (MOTIR-8286, the same `AuthLanguageControl` as
  `design/auth/auth-frame--language-control.mock.html`), and the decorative user initial, which keeps
  the far edge. The bar has no fill and no rule, as motir.co's header.
- **The hero.** The **full** hero (H1 96 px, `pt-[56px] pb-[88px]`, waves) shows only on the ARRIVAL screen —
  Start with no run. Every later step gets the **compact** hero (H1 56 px, `pt-6 pb-12`, lede 17 px,
  the same waves) so the panel stays above the fold. Measured from the frame top at 1280: Start
  band 382 / heading 456 / last control 638; compact steps band 257 / heading 330; last control
  Connect 629, Index 918 (the repo list is tall), Import 624, Decision 495, Resume 463. The heading and
  the card start above a 768 px fold on every step.
- **The work band.** `OnboardingSection`'s band (`border-t --el-border`, `--el-page-bg`,
  `px-[38px] py-[48px]`) holds the existing rail + panel grid unchanged. There is no outer centred
  card any more; the panel card is the one card.
- **`StepHead`.** The heading moves to the section scale's floor, serif 34 (28 narrow). The eyebrow
  keeps its function and drops its accent look: mono 11, uppercase, 0.1 em, `--el-text-secondary`.
- **The Decision panel's planNow button loses its AI glyph** too (the card named only the bar).
- **Behaviour is unchanged on every step except Connect** (changed by Revision 1 below): the same routes, the same `PanelFoot` (still no Back —
  the shipped wizard never passes `onBack`, and the mock does not invent one), the same rail logic,
  the same error alert in `--el-tint-rose`.

### Per-element `--el-*` and shape role

| element                 | colour                                                                  | shape / size                               |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| bar                     | none (transparent on the hero's `--el-surface`)                         | `px-(--spacing-card-padding) py-4`         |
| lockup                  | `brand.css` (glyph + word in `--el-text`)                               | 22 px                                      |
| `· flowName`            | `--el-text-secondary`                                                   | 14 px                                      |
| planAi                  | `Button secondary sm`; **hover** `--el-page-bg` + `--el-border-strong`  | `--radius-btn`, `--height-btn-sm`          |
| Save & exit             | `Button ghost sm`; **hover** `--el-page-bg`                             | `--radius-btn`, `--height-btn-sm`          |
| language control        | package `Combobox` trigger, `--el-text-secondary` glyph                 | `--radius-input`, `--height-control`       |
| user initial            | `--el-tint-sky` fill, `--el-text-strong` letter, aria-hidden            | `rounded-full` 28 px                       |
| hero ground · H1 · lede | `--el-surface` · `--el-text` · `--el-accent-on-surface` (as MOTIR-8250) | serif 96 / 56 compact; lede `max-w-[62ch]` |
| waves                   | `--el-showcase-wave-1..3`, aria-hidden                                  | 1 px strokes                               |
| work band               | `--el-page-bg`, `border-t --el-border`                                  | `px-[38px] py-[48px]`                      |
| eyebrow                 | `--el-text-secondary`                                                   | mono 11 uppercase                          |
| step heading · body     | `--el-text` · `--el-text-secondary`                                     | serif 34 · 15                              |
| panel card              | `Card` (`--el-card-bg`, `--el-border`)                                  | `--radius-card`, `--spacing-card-padding`  |
| error alert             | `--el-tint-rose`, `--el-danger-on-surface` title                        | `--radius-card`                            |
| focus ring              | `--el-accent-on-surface`                                                | `ring-2`                                   |

### Slot → key

| slot                                        | key                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| hero H1 · lede                              | `onboardingMigrate.hero.headline` · `onboardingMigrate.hero.lede`                   |
| flow name                                   | `onboardingMigrate.brandBar.flowName`                                               |
| planAi                                      | `onboardingMigrate.brandBar.planAi`                                                 |
| Save & exit                                 | `onboardingMigrate.common.saveExit`                                                 |
| language trigger · pending · failed · retry | `auth.language.{label,switching,failed,retry}` + the `localeLabel` endonyms         |
| step eyebrow · heading · body · cta         | `onboardingMigrate.{start,connect,index,import,decision,resume}.*` (unchanged keys) |
| rail                                        | `onboardingMigrate.rail.*` (unchanged keys)                                         |
| error                                       | `onboardingMigrate.common.error`                                                    |
| access-path door (Panel 0)                  | `onboarding.entrance.{importTitle,importDesc,importCta}`                            |

Fixtures (the project name, repository names, counts) are illustrative data, not product copy.

### Findings

- **F1 — the shipped wizard paints its captions in `--el-text-muted`** (14 sites in
  `MigrateWizard.tsx`, among them the bar's `·` separator at line 229 and the panel notes at 510,
  543, 677, 679, 719). On today's white page and card that is 4.54:1 and passes with 0.04 to spare;
  the bar now sits on the hero's `--el-surface`, where muted is 4.17:1 and fails. The mock draws the
  separator, the flow name and every caption in `--el-text-secondary` (6.24:1 on `--el-surface`), and
  MOTIR-8254 should do the same rather than move muted ink onto the new ground.
- **F2 — the package `Button`'s `secondary` and `ghost` hover fill is `--el-surface`**, which is the
  hero's own ground, so the hover is invisible in this bar. The mock overrides hover to
  `--el-page-bg` (planAi also raises its border to `--el-border-strong`), drawn in Panel 9a. It is a
  local override; whether the package should grow an on-surface hover is a question for the design
  system, not this card.
- **F3 — the Decision panel's planNow glyph** is also taken; the card's criteria named only the bar.
- **F4 — MOTIR-8286's premise** says the wizard renders `OnboardingTopBar`; it does not, it has its
  own `BrandBar`. This design gives the wizard's bar its own trailing language control, at the same
  place in the order as MOTIR-8250's.

### Chinese-length risks (for MOTIR-8249 / MOTIR-8258)

The 96 px H1 (wraps to three lines at 1280 if the string is long — the compact 56 px step hero is
safer); the flow name in the bar (truncates with an ellipsis on narrow, row 2); the planAi label
(`secondary sm` has no max width — on narrow it takes its own row 3, so it may wrap there).

### Narrow (390)

The bar becomes three rows: lockup … language · initial; then the flow name; then planAi … Save &
exit. The full hero's H1 is 48 px, the compact one 34 px. The rail collapses above the panel as it
does today.

### GIVES / TAKES

- **TAKES** the lavender AI-glyph tile and the word "Motir" from `BrandBar`, the AI glyph from the
  planAi link and from the Decision panel's planNow button.
- **GIVES MOTIR-8254** the build of this frame: the bar, the full/compact hero, the work band, the
  `StepHead` restyle, the caption ink (F1), the hover override (F2).
- **GIVES MOTIR-8252** nothing beyond the primitives it already owns — the compact hero is a variant
  prop of `OnboardingHero`, and the work band is `OnboardingSection`'s band with no head.
- **GIVES MOTIR-8241** (GitHub connect) and **MOTIR-8246** (non-blocking index) the restyled frame
  their panels sit in; their content is theirs — except the Connect panel's four detection states,
  which Revision 1 below draws and MOTIR-8241 builds on.
- **GIVES MOTIR-8286** the language control in this bar (rest, open, pending, failed — Panel 9b).
- **GIVES MOTIR-8256** the pairs to gate: secondary on `--el-surface`, the hover override, the
  focus ring on `--el-surface`; **MOTIR-8249 / MOTIR-8258** the CJK risks above; **MOTIR-8257** the
  E2E context — the route and the step order are unchanged; the Connect keys change per Revision 1 below.
- **Premises taken from** MOTIR-930, MOTIR-4759, MOTIR-4766, MOTIR-8248 and MOTIR-8250.

### Revision 1 (2026-10-12) — the connect step detects GitHub by itself

**The reviewer's note, verbatim (on the published design):** _"Can the github connected status be
auto detected? that's the confusing part. check how other application do that"_

**What was confusing.** The shipped `ConnectPanel` (`MigrateWizard.tsx`) asks the person to report
on themselves: a link to `/settings/organization/git`, the GitLab note, and a Next labelled
`connect.next` ("I've connected my repos"). Press it with nothing connected and the advance 409s
(`CONNECT.checkExit` finds no repo set) and the wizard only `router.refresh()`es, so **nothing
visible happens**. The server already knows the answer, so the person should never have to tell it.

**Detection needs no new data source.** `CONNECT.checkExit` in `lib/services/migrateOnboardingService.ts`
reads `resolveWorkspaceConnectedRepos`, and `getIndexStatus`
(`GET /api/onboarding/migrate/[id]/index-status`, which the Index step already polls every 3 s)
returns that same set as `repos: MigrateIndexRepoDto[]` (`provider`, `repoRef`), empty when nothing
is connected. The Connect panel reads that route; `repos.length > 0` is "connected".

#### How other products do it (research)

| product                    | what it does                                                                                                                                                                                                                      | source                                                                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel                     | The import screen lists the repositories the GitHub App can reach. A missing one is fixed through "Configure GitHub App"; you come back to the import screen and the repository appears. No confirm step anywhere.                | https://vercel.com/kb/guide/unable-to-find-github-repository                                                                                                                                                                                   |
| Netlify                    | Choosing GitHub prompts the app install only if it is not already installed; otherwise the repo list shows at once. "Configure the Netlify app on GitHub" sits under the list for adding access.                                  | https://docs.netlify.com/github-permissions/ · https://answers.netlify.com/t/no-longer-able-to-link-with-github-repositories/73357                                                                                                             |
| Render                     | Connecting sends you to GitHub and back to the dashboard with your repository list; a missing repository points to the app's Repository access settings.                                                                          | https://render.com/docs/github · https://render.com/docs/git-provider                                                                                                                                                                          |
| Codecov                    | After sign-up "you will be brought to a page with a list of repositories"; "it may take a few moments for your repositories to sync"; non-admins may need an org admin to approve.                                                | https://docs.codecov.com/docs/github-2-getting-a-codecov-account-and-uploading-coverage                                                                                                                                                        |
| CircleCI                   | Moved its GitHub App install to a redirect that lands on a loading screen, then "users will be automatically redirected to continue with their setup".                                                                            | https://circleci.com/changelog/minor-modification-to-github-app-installation-flow                                                                                                                                                              |
| Sentry · Linear            | The install starts from the product's own settings (Sentry: "begin the installation from Sentry"); GitHub returns to it and the integration shows as installed, with an org owner needed for org-wide access.                     | https://docs.sentry.io/organization/integrations/source-code-mgmt/github/ · https://linear.app/docs/github-integration                                                                                                                         |
| GitHub (the platform)      | After an install GitHub redirects to the app's **Setup URL** with `installation_id`, and optionally again when the installation is **updated** (repos added or removed). The id must not be trusted alone; verify it server-side. | https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url                                                                                                                                              |
| Popup hand-backs (caution) | `window.opener.postMessage` from a popup is unreliable: `opener` comes back null under extensions and desktop shells, and popups get stranded. Teams fall back to a server-side callback or a re-read.                            | https://forum.asana.com/t/app-installation-callback-failures/235883 · https://community.shopify.dev/t/shopify-oauth-popup-cannot-auto-close-after-successful-install-when-initiated-from-admin-shopify-com-admin-shell-reclaiming-window/28862 |
| The browser                | `visibilitychange` fires when the person switches tabs or comes back to one, the hook for "re-check when you return".                                                                                                             | https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event                                                                                                                                                               |

**The common pattern:** (1) no product asks the person to say they have connected; the screen
**reads** the connection and shows it; (2) the screen shows the **detected account / repository
list**, which doubles as the confirmation and as the "is the right repo in there?" check; (3) a
quiet **"configure / adjust access on GitHub"** link stays next to the list; (4) the return trip is
a **server-side callback** (the Setup URL) as the authority, with a **re-read on return** (focus /
visibility) and a short **poll while waiting** as the fallback, never a popup message alone.
Motir takes (1)–(3) now and the re-read half of (4). The callback half is MOTIR-8241's (below).

#### The four states (Panels 2a–2d, light and dark; narrow 2b and 2d in Panel 11)

Every state keeps the compact hero, the rail (Connect current), the eyebrow, heading and body. The
card is the package `Card` (`--el-card-bg`, `--el-border`, `--radius-card`,
`--spacing-card-padding`). In 2a–2c its body holds one minimum height (`min-h-[148px]`), so the
swaps between them happen in place; only 2d grows, with its list. Each state's status line and hint
sit in one `role="status"` region, so the change is announced politely.

| state                      | element                                   | colour role                                                               | shape / size                                                  |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **a · Checking**           | spinner (aria-hidden wrapper)             | `--el-accent-on-surface`                                                  | `Spinner sm` (`rounded-full`)                                 |
|                            | "Checking for connected repositories…"    | `--el-text-secondary` on the card                                         | 14 px                                                         |
|                            | (no control)                              | —                                                                         | —                                                             |
| **b · Not connected yet**  | glyph `GitBranch` (aria-hidden)           | `--el-text-secondary`                                                     | 16 px                                                         |
|                            | title "No repositories connected yet"     | `--el-text`, semibold                                                     | 14 px                                                         |
|                            | hint (one line: Motir notices by itself)  | `--el-text-secondary`                                                     | 14 px, `max-w-[60ch]`                                         |
|                            | **Connect GitHub ↗** (new tab)            | `Button primary md` (`--el-accent` / `--el-accent-text`)                  | `--radius-btn`, `--height-btn-md`, `--spacing-btn-x/y`, w-fit |
|                            | sr-only "(opens in a new tab)"            | —                                                                         | —                                                             |
|                            | GitLab note                               | `--el-text-secondary` (F1)                                                | 12 px                                                         |
| **c · Waiting for GitHub** | spinner (aria-hidden wrapper)             | `--el-accent-on-surface`                                                  | `Spinner sm`                                                  |
|                            | title "Waiting for GitHub" · hint         | `--el-text` semibold · `--el-text-secondary`                              | 14 px                                                         |
|                            | **Open GitHub settings again ↗**          | `Button secondary md` (`--el-border`, `--el-text`)                        | `--radius-btn`, `--height-btn-md`, w-fit                      |
|                            | GitLab note                               | `--el-text-secondary`                                                     | 12 px                                                         |
| **d · Connected**          | glyph `CheckCircle2` (aria-hidden)        | `--el-success` (a graphic on the card, ≥ 3:1 since MOTIR-3991)            | 16 px                                                         |
|                            | "3 repositories are connected"            | `--el-text`, semibold — the hue is in the glyph, never the label          | 14 px                                                         |
|                            | hint                                      | `--el-text-secondary`                                                     | 14 px                                                         |
|                            | repo row (`owner/name`, mono)             | border `--el-border-soft`; owner `--el-text-secondary`, name `--el-text`  | `--radius-control`, `--spacing-control-x`, py-2.5, mono 13    |
|                            | row tick `Check` (aria-hidden)            | `--el-success`                                                            | 16 px                                                         |
|                            | Manage repositories on GitHub ↗ (new tab) | `--el-text-secondary`, underlined; focus outline `--el-accent-on-surface` | `--radius-control` (focus box)                                |
|                            | **Continue →**                            | `Button primary md`                                                       | `--radius-btn`, `--height-btn-md`; `ml-auto` (trailing edge)  |

"Connected" covers both cases: just connected (from 2c) and already connected on arrival (2a →
2d directly, with no 2b in between). No `--el-text-muted` sits on a tint or `--el-surface`, no
`--el-text-faint` carries text, no `--el-danger-text` appears, and nothing is a raw colour.

#### The detection mechanism (for MOTIR-8254)

1. **Read on mount.** The panel fetches `GET /api/onboarding/migrate/[id]/index-status` (the same
   route and DTO the Index step polls) and shows 2a until it answers: `repos.length > 0` → 2d,
   otherwise → 2b.
2. **Re-read on return.** While the panel is mounted and not in 2d, a `focus` on `window` and a
   `visibilitychange` to `visible` each trigger one read (de-duplicated: one in flight at a time,
   seq-guarded so an older answer never overwrites a newer one).
3. **Poll only while waiting.** Pressing Connect GitHub (or Open GitHub settings again) moves the
   panel to 2c and starts a ~5 s poll. It stops on the first non-empty answer (→ 2d) or when the
   person leaves the step (unmount). 2b does not poll; it re-reads on return only.
4. **A failed read** shows the existing error alert (Panel 7, drawn over 2b) and keeps the state
   it had; the next focus or poll retries it. No new error copy.
5. **Continue** calls the existing advance (`connect` → `index`). It is drawn only in 2d, so it is
   pressed only when `checkExit` will pass — **Next is never a silent no-op any more.** If the set
   empties between the read and the press (someone removed access), the 409 now lands the panel back
   on 2b through a re-read, not on a bare `router.refresh()`.

#### Slot → key (Revision 1)

All copy is proposed for `onboardingMigrate.connect.*`; `messages/` is **not** edited here
(MOTIR-8254 adds the keys and their ten translations).

| slot                                | key                            | status      | English                                                                                                      |
| ----------------------------------- | ------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------ |
| eyebrow · heading                   | `connect.eyebrow` · `.heading` | unchanged   | (as shipped)                                                                                                 |
| body                                | `connect.body`                 | **CHANGED** | Motir reads the repositories you connect on GitHub and builds one map of the code across the project.        |
| 2a status                           | `connect.checking`             | **NEW**     | Checking for connected repositories…                                                                         |
| 2b title                            | `connect.missingTitle`         | **NEW**     | No repositories connected yet                                                                                |
| 2b hint                             | `connect.missingHint`          | **NEW**     | Connect GitHub in a new tab. Motir notices the connection by itself, so there is nothing to confirm here.    |
| 2b primary                          | `connect.connectCta`           | **NEW**     | Connect GitHub                                                                                               |
| sr-only after every new-tab control | `connect.newTab`               | **NEW**     | (opens in a new tab)                                                                                         |
| 2c title                            | `connect.waitingTitle`         | **NEW**     | Waiting for GitHub                                                                                           |
| 2c hint                             | `connect.waitingHint`          | **NEW**     | Finish connecting in the other tab. Motir checks again when you come back, and every few seconds until then. |
| 2c secondary                        | `connect.reopenCta`            | **NEW**     | Open GitHub settings again                                                                                   |
| 2d success line                     | `connect.detected`             | **NEW**     | `{count, plural, one {# repository is connected} other {# repositories are connected}}`                      |
| 2d hint                             | `connect.detectedHint`         | **NEW**     | These are the repositories Motir can read. Indexing starts when you continue.                                |
| 2d list `aria-label`                | `connect.listLabel`            | **NEW**     | Connected repositories                                                                                       |
| 2d primary                          | `connect.continue`             | **NEW**     | Continue                                                                                                     |
| 2d quiet link                       | `connect.manage`               | **NEW**     | Manage repositories on GitHub                                                                                |
| GitLab note                         | `connect.gitlabNote`           | unchanged   | GitLab connect is coming soon.                                                                               |
| —                                   | `connect.next`                 | **DELETE**  | ("I've connected my repos" — no longer read)                                                                 |
| —                                   | `connect.cta`                  | **DELETE**  | ("Open GitHub settings" — replaced by `connectCta` / `reopenCta`)                                            |

`connect.body` changes because the shipped one says "workspace settings" (the connect surface is
organisation-tier since MOTIR-4680) and names an internal seam ("the GitProvider seam"). Repository
names on the board (`acme/web`, `acme/api`, `acme/infra`) are fixtures.

#### GIVES / LEAVES

- **GIVES MOTIR-8254** these four states, the detection mechanism above and the key table. Its
  acceptance criterion that the **connect flow is unchanged is amended by this revision**: the
  Connect panel's controls and copy change as drawn here; the route, the step order and the advance
  call stay.
- **LEAVES MOTIR-8241** the full GitHub round trip: starting the install from onboarding with its
  own signed state, the Setup-URL return to **this** step instead of to Settings, and the
  install-cancelled, no-repositories-selected, waiting-for-an-org-owner and error states. It draws
  them **on top of** 2a–2d (the callback lands on 2a, which reads and resolves as above), and the
  re-read and poll here stay as its fallback.
- **GIVES MOTIR-8256** the new pairs to gate: `--el-success` glyph on `--el-card-bg` in both
  themes; `--el-text-secondary` link and hint on the card; and **MOTIR-8257** the new E2E surface
  (Continue appears only after detection; the Connect GitHub link has `target="_blank"`).

### Revision 2 (2026-10-12) — the code index never holds onboarding

Published as evidence `cmv53f83v00yqhyshnxkzzqq9` (commit `478dc22`) and republished from the commit
that adds this line; it supersedes Revision 1's `cmv527yiv00qlhxoi3hiys1q2`.

**The reviewer's note, verbatim (on Revision 1):** _"The user should not be blocked on the index
step. the index can take a long time, the user should be go forward. the index only blocks
planning, not onboarding"_

**What was wrong.** Revision 1 kept Panel 3 "as it ships today": after Connect the person landed on
an Index screen whose only job was to wait (spinner, per-repo list, a disabled Next, and a callout
saying Next stays disabled until every repository finishes). On a large codebase that is minutes of
watching a bar, and a failed index never ends it (`INDEX.checkExit` and `runIndexSweep` only look
for a _succeeded_ index).

**Why this is a redraw and not a replan.** The behaviour the note asks for is already planned, in
detail, by the sibling story **MOTIR-8246** ("Onboarding moves on while the code index builds"):
the `index` exit becomes "an index exists in any state", generation waits in the background through
a widened `runIndexSweep`, the convention is derived once the graph exists, MOTIR-933's "no plan
from unread code" stands, and a failure undoes nothing. MOTIR-8246 owes a design subtask that draws
those states "in the restyled onboarding look". This revision draws them now, in this frame, so the
reviewer decides the restyle and the non-blocking index together, and MOTIR-8246's design work
composes these panels instead of starting over. No card's scope moves: the **build** stays with
MOTIR-8246 (it needs service, sweep and generate changes no restyle card owns).

#### What changes on the board

| panel    | before (Revision 1)                       | now                                                                                                                                                                                                                                  |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2d       | Continue → Index                          | Continue → **Import** directly. The hint says reading starts and the person will not have to wait.                                                                                                                                   |
| 3        | Index — the waiting screen, Next disabled | **Removed.** There is no Index panel.                                                                                                                                                                                                |
| 3a (new) | —                                         | Import, arrived straight from Connect: the **indexing chip** in the bar reads _Reading your code · 33%_; the rail's Index row is a **background row**.                                                                               |
| 3b (new) | —                                         | The chip opened: a popover with what the old Index panel showed (aggregate line, bar, per-repository rows), plus one line saying only drafting the plan waits.                                                                       |
| 3c (new) | —                                         | Reading failed, surfaced on whatever step the person reached (drawn on Decision): chip and rail in the failed state, the detail naming the repository, **Try again** and **Check the connection**.                                   |
| 4        | Import                                    | Import at the moment reading finishes: the chip says _Your code is read_, announced once, then leaves the bar; the rail's Index row becomes an ordinary done row.                                                                    |
| 5        | Decision                                  | Decision while reading still runs: both buttons stay enabled; a sky-tint note says the plan is drafted as soon as reading finishes and the person is told. With reading done the note is absent (as before). Failed: a sibling note. |
| 9c (new) | —                                         | The chip's five looks: queued · reading · focus-visible · read · failed.                                                                                                                                                             |
| 10       | Narrow — Start and Index                  | Narrow — Start, and Import with the chip (closed, then opened: the detail drops full-width under the hero instead of floating).                                                                                                      |

#### The indexing chip and its detail — per element

| element                                                            | colour role                                                                                                                                                                                   | shape / size                                                                            |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| chip (a `button`, `aria-expanded`, `aria-controls="index-detail"`) | `Button secondary sm` on `--el-page-bg`; label `--el-text`                                                                                                                                    | `--radius-btn`, `--height-btn-sm`, `--spacing-btn-x/y-sm`                               |
| chip glyph — queued / reading                                      | `Spinner sm`, `--el-accent-on-surface` (aria-hidden)                                                                                                                                          | `rounded-full`                                                                          |
| chip glyph — read                                                  | `CheckCircle2`, `--el-success` (a graphic, ≥ 3:1)                                                                                                                                             | 14 px                                                                                   |
| chip — failed                                                      | border `--el-danger`, glyph `CircleAlert` `--el-danger-on-surface`; label stays `--el-text`                                                                                                   | as above                                                                                |
| chip label                                                         | inside an `aria-live="polite"` span, so a state change is announced, never focused                                                                                                            | 12–13 px                                                                                |
| chip focus-visible                                                 | `--focus-ring-color` ring, offset on `--el-surface`                                                                                                                                           | ring-2                                                                                  |
| detail popover (`role="dialog"`, `data-surface="popover"`)         | `--el-page-bg`, border `--el-border`, `--shadow-elevated`                                                                                                                                     | `--radius-card`, `--spacing-card-padding`; 380 px, full-width at 390                    |
| title · Close                                                      | `--el-text` semibold · `Button ghost sm`                                                                                                                                                      | —                                                                                       |
| body / failed body · aggregate line                                | `--el-text-secondary` on `--el-page-bg`                                                                                                                                                       | 14 px · 12 px                                                                           |
| progress bar                                                       | track `--el-muted`, fill `--el-accent`                                                                                                                                                        | `rounded-full`, 6 px                                                                    |
| repo rows                                                          | border `--el-border-soft`; owner `--el-text-secondary`, name `--el-text`, mono; chips as shipped (`--el-tint-mint` + `--el-text-strong` indexed, `--el-muted` + `--el-text-secondary` queued) | `--radius-control`, `--spacing-control-x`; chips `--radius-badge`, `--spacing-chip-x/y` |
| failed row                                                         | border `--el-danger`; glyph and "Could not read the code" `--el-danger-on-surface`                                                                                                            | as above                                                                                |
| Try again · Check the connection                                   | `Button primary sm` with `RotateCcw` · `Button ghost sm` → `/settings/organization/git`                                                                                                       | `--radius-btn`, `--height-btn-sm`                                                       |
| rail background row — marker                                       | reading: `Spinner sm` in a `--el-border` ring, `--el-accent-on-surface`; failed: `CircleAlert` `--el-danger-on-surface`                                                                       | `size-5`, `rounded-full`                                                                |
| rail background row — label · meta                                 | `--el-text` · `--el-text-secondary` (12 px). Never `aria-current`; the current step stays the step the person is on.                                                                          | `--radius-control`, `--spacing-control-x`                                               |
| Decision note (reading / failed)                                   | `--el-tint-sky` with `--el-text-strong`; `Spinner sm` / `CircleAlert` glyph                                                                                                                   | `--radius-card`, `--spacing-card-padding`                                               |

No `--el-text-muted` on a surface or tint, no `--el-text-faint` text, no `--el-danger-text`, no raw
colour. Chip placement: first in the bar's control group (before _Start from an idea instead_); at
390 px it takes the flow-name row's trailing edge.

#### Behaviour the board depicts (built by MOTIR-8246, not by MOTIR-8254)

1. **Connect → Import.** The `index` exit becomes "an index exists for this run's repository in
   any state", so the advance from Connect passes straight through (MOTIR-8246 §1). The rail keeps
   its Index row; it is never the current step.
2. **One read, two places.** The chip and the rail row read the same
   `GET /api/onboarding/migrate/[id]/index-status` the old panel polled, on the same cadence, for the
   rest of onboarding; it stops once every repository is indexed (the chip shows _read_ for a few
   seconds, then leaves).
3. **Opening the detail changes nothing.** The popover closes on Close, Escape or an outside click
   and returns focus to the chip; the step underneath is never re-rendered or advanced.
4. **The plan waits, the person does not.** Plan my project now and Finish later stay enabled;
   generation is started by the widened sweep when the graph succeeds (MOTIR-8246 §3). This board
   draws only the Decision note; the discovery canvas's own "your plan will be drafted when
   indexing finishes" state and the "your plan is ready" notice are MOTIR-8246's to draw in the
   ai-chat frame (`design/ai-chat/onboarding--vibe-lockup.mock.html`).
5. **Failure undoes nothing.** Every completed step stays done; Try again uses the index's existing
   re-enqueue (MOTIR-8246 §4 and its HOW 5); Check the connection opens the git settings.

#### Slot → key (Revision 2, proposed — `messages/` is not edited here)

| slot                                         | key                                                                                                                           | status                                                                        | English                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rail sub-line                                | `rail.sub`                                                                                                                    | **CHANGED**                                                                   | Reading your code runs in the background. Nothing here waits for it.                                                                                                                                                                                     |
| rail Index meta (reading)                    | `rail.indexBackground`                                                                                                        | **NEW**                                                                       | In the background · {pct}%                                                                                                                                                                                                                               |
| rail Index meta (queued)                     | `rail.indexQueued`                                                                                                            | **NEW**                                                                       | In the background · queued                                                                                                                                                                                                                               |
| rail Index meta / failed row                 | `rail.indexFailed`                                                                                                            | **NEW**                                                                       | Could not read the code                                                                                                                                                                                                                                  |
| chip — queued · reading · read · failed      | `indexing.queued` · `.running` · `.done` · `.failed`                                                                          | **NEW**                                                                       | Queued to read your code · Reading your code · {pct}% · Your code is read · Could not read your code                                                                                                                                                     |
| detail title · Close                         | `indexing.detailTitle` · `.close`                                                                                             | **NEW**                                                                       | Reading your code · Close                                                                                                                                                                                                                                |
| detail body                                  | `indexing.detailBody`                                                                                                         | **NEW**                                                                       | This runs in the background, so keep going. Only drafting your plan waits for it, and it starts by itself when reading finishes.                                                                                                                         |
| detail failed body                           | `indexing.failedBody`                                                                                                         | **NEW**                                                                       | Motir could not read {repo}. Nothing you have done is lost. Your plan waits until the code can be read.                                                                                                                                                  |
| failed actions                               | `indexing.retry` · `.checkConnection`                                                                                         | **NEW**                                                                       | Try again · Check the connection                                                                                                                                                                                                                         |
| Decision note — reading · failed             | `decision.waitNote` · `.failedNote`                                                                                           | **NEW**                                                                       | Motir is still reading your code. Pick either one now: your plan is drafted as soon as reading finishes, and you are told when it is ready. · Motir could not read your code yet. Either choice is safe: your plan is drafted once the code can be read. |
| 2d hint                                      | `connect.detectedHint`                                                                                                        | **CHANGED** (vs Revision 1)                                                   | Motir starts reading their code as soon as you continue. You will not have to wait for it.                                                                                                                                                               |
| detail aggregate · per-repo head · row chips | `index.aggregate` · `index.perRepo` · `index.state.*`                                                                         | unchanged, re-used                                                            | (as shipped)                                                                                                                                                                                                                                             |
| —                                            | `index.eyebrow` · `.heading` · `.body` · `.building` · `.callout` · `.next` · `.waiting` · `.completeTitle` · `.completeNote` | **RETIRED with the panel** (MOTIR-8246 deletes them when it removes the stop) | —                                                                                                                                                                                                                                                        |

**Chinese-length risk (MOTIR-8249 / MOTIR-8258):** the chip label is the bar's longest new slot;
it must fit `--height-btn-sm` on one line at 1280 px beside _Start from an idea instead_. At 390 px
it shares the flow-name row, which truncates the flow name first, never the chip.

#### GIVES / TAKES (Revision 2)

- **TAKES** the Index panel (Panel 3 of Revision 1 and of MOTIR-930's record) and its disabled Next.
- **GIVES MOTIR-8246** the chip, the detail, the background rail row, the failed state and the
  Decision note as its drawn surfaces, and their build. Its owed design subtask composes these
  panels and adds only the canvas-side states (plan waiting, plan ready). Comment posted there.
- **GIVES MOTIR-8254** nothing new to build: it restyles the frame as Revision 1 said; until
  MOTIR-8246 lands, the shipped Index stop keeps working in the restyled frame, and its acceptance
  is unchanged by this revision.
- **GIVES MOTIR-8256** the new pairs to gate: `--el-danger` border + `--el-danger-on-surface` glyph
  on `--el-page-bg`, `--el-text-strong` on `--el-tint-sky`; **MOTIR-8257** nothing (the E2E walks
  the shipped stop until MOTIR-8246).

### Revision 3 (2026-10-12) — no Start panel when the only project is the sign-up default

**The reviewer's note, verbatim (on Revision 2):** _"When there is only the default project, don't
need to show the project. The user didn't create the project, and it's the only project available,
go to connect step directly"_

**What was wrong.** The shipped wizard renders `StartPanel` whenever the project has no run
(`run === null` in `MigrateWizard.tsx`): a card naming the active project and a Start button that
POSTs `/api/onboarding/migrate`. For a new sign-up the workspace holds one project, the one Motir
created for them, so the card asks them to confirm a choice they never made and could not make
differently. (The importer already skips its picker in this case: `loadImportWizard` in
`app/(onboarding)/onboarding/import/_data.ts` falls through to the first project when no
`projectId` is given and shows the picker only for an empty or a bad request, so the importer is
unchanged by this revision.)

**What the board now draws.**

| panel | before (Revision 2)                     | now                                                                                                                                               |
| ----- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a    | —                                       | **Arrival with only the default project**: no Start panel; the wizard opens on **Connect** (2a → 2b/2d) under the **full** hero, rail on Connect. |
| 1b    | Start (the arrival screen for everyone) | Start, **only when the workspace has two or more projects**, unchanged in look and copy.                                                          |
| 10    | Narrow — Start and Import               | Narrow — the 1a arrival on Connect, and Import with the indexing chip.                                                                            |

**The hero rule changes from "full on Start" to "full on a run's first screen"** — Start (1b) or
Connect (1a) — and compact after any step advance. Measured on the board at 1280 px, the 1a Connect
card's action still sits above a laptop fold (its Connect GitHub button lands about 700 px down the
frame, inside an 800 px laptop viewport); no new token, no new string.

**Behaviour (for MOTIR-8254).**

1. **The condition is the workspace's project count**, read on the server by the migrate page:
   `run === null` and exactly one project in the workspace → the island receives `autoStart`.
   Schema has no "created at sign-up" flag, and none is needed: a one-project workspace has nothing
   to choose, whoever created the project.
2. **The island starts the run on mount** with the same `startRun` call (so the MOTIR-4759 kept set
   still rides the START call from the query), and renders Connect's 2a Checking state while the
   POST and the first read are in flight; the result lands on 2b or 2d in place. No Start panel
   is ever painted, so there is no flash.
3. **A failed start** shows the existing error alert above the Start panel (1b's panel, as the
   retry), never a dead Connect panel. A 409 (a run already exists) refreshes, as today.
4. **Two or more projects** → exactly today's Start (1b).

Copy: nothing new; Start's keys stay for 1b.

#### GIVES / TAKES (Revision 3)

- **TAKES** the Start panel from the one-project arrival.
- **GIVES MOTIR-8254** the `autoStart` arrival above (one server read of the project count, one
  mount effect, the fallback); its "every step unchanged" criterion is amended for Start exactly
  as Revision 1 amended it for Connect. Comment posted there.
- **GIVES MOTIR-8257** the E2E change: a fresh sign-up on `/onboarding/migrate` sees Connect, not
  Start; a two-project workspace still sees Start.
- **MOTIR-8246 and Revision 2 are unaffected.**

### Revision 4 (2026-10-12) — Start is a project choice, and the wizard turns warm

**The reviewer's notes, verbatim (on Revision 3):** _"screen 1b is still showing the single
project, what did you do?"_ and _"make the UI more colorful, use the warm color, the orange and the
yellow we added to the color palette"_

**What was wrong with 1b.** Revision 3 kept Start for a workspace with two or more projects but
drew it exactly as before: one card naming the open project and a Start button. With nothing else
on the screen it read as the single-project Start that Revision 3 removed, and it gave a person who
does have several projects no way to say which one they mean. Start now exists only when there is
something to choose, so it is drawn as the choice.

**1b, per element.**

| element                                            | primitive / markup                       | colour                                                                                                | shape                                             |
| -------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| legend "Which project are you migrating?"          | `fieldset` + `legend`                    | `--el-text`                                                                                           | —                                                 |
| one row per project in the workspace (fixtures: 3) | `label` wrapping a native `radio`        | border `--el-border`, fill `--el-page-bg`; hover border `--el-border-strong`                          | `--radius-card`, `--spacing-card-padding` × 12 px |
| the picked row (the open project, pre-selected)    | same, `checked`                          | fill `--el-tint-yellow`, border + 1 px ring `--el-highlight` (3.34:1 on the tint, light; 4.34:1 dark) | same                                              |
| radio                                              | native                                   | —                                                                                                     | 16 px                                             |
| project key tile                                   | `span`, mono key                         | `--el-text-strong` on the next tint in peach → yellow → rose                                          | `--radius-control`, 36 px                         |
| name · meta                                        | text                                     | `--el-text` · `--el-text-secondary` (5.93:1 on yellow, 5.36:1 on peach)                               | —                                                 |
| "Open now" chip on the open project                | chip                                     | `--el-tint-peach`, `--el-text-strong`                                                                 | `--radius-badge`, `--spacing-chip-x/y`            |
| CTA "Start with {project}"                         | `Button` primary md, trailing ArrowRight | the ink CTA, unchanged                                                                                | `--radius-btn`                                    |

**Behaviour (for MOTIR-8254).** The page passes the workspace's projects with the active one
marked. Picking the open project and pressing Start is today's `startRun`. Picking another project
first switches the active project with the existing `setActiveProjectAction` (the sidebar's
ProjectSwitcher path), then starts the run for it; the CTA's name follows the pick. Revision 3's
point 4 ("two or more projects → exactly today's Start") is replaced by this; its points 1 to 3 stand,
and a failed start shows the error alert above this panel.

**Proposed copy** (in the board's `NEW` map; `messages/` is not edited here):

| key                                   | English                               |
| ------------------------------------- | ------------------------------------- |
| `onboardingMigrate.start.chooseLabel` | Which project are you migrating?      |
| `onboardingMigrate.start.current`     | Open now                              |
| `onboardingMigrate.start.currentMeta` | The project you have open             |
| `onboardingMigrate.start.otherMeta`   | Switches to this project, then starts |
| `onboardingMigrate.start.ctaFor`      | Start with {project}                  |

`start.projectLine` and `start.cta` retire with the single-project card.

**The warm pass — the motir palette's warm touches (design-system §8, MOTIR-7583).** The orange is
`--el-highlight` / `--el-progress-fill` (`#d66000` light, `#fa5500` dark) and the yellow is
`--el-tint-yellow` (with `--el-tint-peach` beside it); the citrine gold is `--el-type-design`. All
are DECORATIVE roles, so the orange is used only for fills, rings, borders and glyphs, never for
text; every label stays on the ink tokens. It applies to all three boards (this one, the importer
and discovery), since they share the bar and hero.

| element                                      | before                                    | now                                                                                                                            |
| -------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| hero background                              | `--el-surface`                            | `--el-hero-glow`: a peach glow top-left and a yellow glow bottom-right over `--el-surface-soft` (light), the dark tints (dark) |
| hero waves                                   | the three `--el-showcase-wave-*` hues     | `--el-hero-wave-1/2/3` → orange, citrine, orange, at a slightly higher alpha                                                   |
| hero lede                                    | `--el-accent-on-surface` (blue)           | `--el-text-strong` (AA on every glow stop)                                                                                     |
| step eyebrow                                 | text only                                 | an 8 px `--el-highlight` dot before it (`aria-hidden`)                                                                         |
| rail: current step                           | `--el-surface` row, blue ring, ink marker | `--el-tint-yellow` row, `--el-highlight` ring, `--el-highlight` marker with a 22 % halo                                        |
| rail: background Index marker, spinners      | `--el-accent-on-surface`                  | `--el-highlight`                                                                                                               |
| Connect card                                 | plain card                                | `Card` tint by state: checking yellow, not connected peach, connected mint                                                     |
| progress bars                                | ink fill on `--el-muted`                  | `--el-progress-fill` on `--el-tint-yellow`                                                                                     |
| info callout, answered-steps marker          | `--el-tint-sky`                           | `--el-tint-yellow`, `--el-tint-peach`                                                                                          |
| avatar initial                               | `--el-tint-sky`                           | `--el-tint-peach`                                                                                                              |
| importer: current step marker                | ink fill, white number                    | `--el-tint-yellow` fill, `--el-text-strong` number, `--el-highlight` ring                                                      |
| importer: picked source card                 | ink border + ring                         | `--el-highlight` border + 22 % ring                                                                                            |
| discovery canvas: the "you are here" station | blue border + ring                        | `--el-highlight` border + ring                                                                                                 |

Measured pairs (WCAG): `--el-highlight` is 3.80:1 on the page, 3.34:1 on `--el-tint-yellow` and
3.01:1 on `--el-tint-peach` in light, and 4.34 / 4.53:1 on the dark tints, so every orange ring,
border and glyph clears the 3:1 non-text bar. Error, danger and success keep their own tokens.

**Four new Tier-3 roles**, declared in each board's own token block and proposed for
`packages/design-system/theme.css` (every input is a palette token, so a `data-palette` swap
re-tints them): `--el-hero-wave-1: var(--el-highlight)`, `--el-hero-wave-2: var(--el-type-design)`,
`--el-hero-wave-3: var(--el-highlight)`, and `--el-hero-glow` (the two radial gradients over
`--el-tint-peach` / `--el-tint-yellow` / `--el-surface-soft`).

#### GIVES / TAKES (Revision 4)

- **GIVES MOTIR-8254** the 1b project choice (the projects list, the switch-then-start path, the
  five keys), the warm pass on the migrate wizard and the importer, and the four hero roles in the
  design-system theme. The hero is the shared primitive MOTIR-8252 built, so the entrance and
  how-it-works (MOTIR-8250) warm with it; their layout and copy do not change.
- **GIVES MOTIR-8255** the warm pass on the discovery canvas's "you are here" station.
- **GIVES MOTIR-8256** the new orange and yellow pairs for its contrast run across every palette.
- **GIVES MOTIR-8257** the E2E change: a two-project workspace sees the project choice with the
  open project picked.
- **GIVES MOTIR-8258** the five new keys to translate.
