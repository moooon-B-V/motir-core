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
