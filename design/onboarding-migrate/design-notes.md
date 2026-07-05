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
> pixels here are (a) the **wizard chrome + the six-step rail** with its done/current/**locked** states
> and the convention-before-generation gate, and (b) the **index-progress step** (§Panel 2).

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
- **The convention is ONE per project** (`design/coding-convention`: "exactly ONE `standard` per
  project"), so it governs the whole multi-repo codebase — NOT one convention per repo.

**How each step becomes multi-repo (what the mock now draws):**

| Step                    | Multi-repo treatment                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connect** (Panel 1)   | "Connect the repositories in this project" — a **multi-select** repo list (web · api · shared, all Selected switches) + a "**3 repositories** selected" summary. The selection is the set of repos that make up this project.                                                                                                                                                |
| **Index** (Panel 2)     | **One code graph across all repos**, built **per repo**: a `.idx-repo` list — each repo its own progress bar + state (`Indexed` / `Indexing…` / `Queued`) — under an **aggregate meter** ("2 of 3 repositories done · 78%"). The **gate is aggregate**: Next stays disabled until **every** repo finishes. Complete state = "3 of 3 indexed · 5,412 files · 31,208 symbols". |
| **Audit** (Panel 3)     | The audit is **measured across all 3 repositories** (a per-repo grade line — acme/web B · acme/api A− · acme/shared A), but **one convention governs the whole project**.                                                                                                                                                                                                    |
| **Discovery** (Panel 4) | "I've read your **3 repositories** — a Next.js web app, a Node API and a shared package…" — the AI's code context is the whole project.                                                                                                                                                                                                                                      |
| **Generate** (Panel 5)  | The plan is grounded in the **whole-project code graph**; each proposed node carries a **repo tag** (`acme/api` / `acme/web`) so it's clear which repo the work lands in, and a cross-repo proposal (reminders reuse the API's notification service) reads naturally.                                                                                                        |
| **States** (Panel 6)    | Index failure is **per-repo** — "acme/api failed; the other 2 stay indexed · Re-run acme/api" (a scoped retry, not a full re-index). Resume names the whole set ("Your import (3 repositories) is paused at step 3").                                                                                                                                                        |

**Implications for the downstream build cards (flagged, not built here):**

- **MOTIR-931 (orchestration)** indexes **N repos** into the project code graph — a fan-out over the
  selected repos (mirrors `indexRepoIntoWorkspaceProjects`), with an aggregate "all repos done" gate
  before the audit runs.
- **MOTIR-1499 (state machine)** tracks **per-repo index status** (not a single boolean) so Save & exit,
  resume, and a per-repo retry all work; the step is "done" only when every repo is indexed.
- **MOTIR-934 (wizard UI)** renders the per-repo index list + the multi-select connect list; the repo↔
  project association captured at Connect is what a future refinement uses to stop indexing a repo into
  unrelated projects.

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

## The spine — a gated, resumable wizard (the model this draws)

1. **Six steps, one rail.** `Connect · Index · Audit & convention · Discovery · Generate · Review`. The
   rail shows each step's state — **done** (mint check + a mint connector spine), **current** (accent
   marker + an `--el-accent-on-surface` ring row), **upcoming** (quiet outline marker), **locked**
   (muted marker + a padlock). The rail is the map: it makes the GATE visible.
2. **★ The convention-before-generation GATE.** `Generate` (step 5) and `Review` (step 6) are drawn
   **LOCKED** — a padlock marker + an accent **"Approve the convention to unlock"** `.lock-tag` — until
   the coding convention is approved at step 3. This is the load-bearing constraint of Workflow B: no
   plan is generated before the user's coding standard is set, so the generated plan is grounded in an
   approved convention. The gate is stated in THREE places: on the rail (locked steps), in a lavender
   `.callout.gate` in the step-3 content, and in the footer note ("Next unlocks after you approve the
   convention").
3. **The index gate (Cursor mirror).** `Next` on step 2 is **disabled** (a `.btn.disabled`) until the
   code graph is built — the audit and plan need a complete index. Drawn in both an **in-flight** state
   (a `.spin` ring + a determinate `.idx-meter` at 61% + files/symbols stats + Next disabled) and a
   **complete** state (a mint "Index ready" pill + Next enabled).
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

### Panel 0 — the wizard chrome + the six-step rail (the gate visible)

The whole frame: **brand bar** (Motir wordmark + `Sparkles` tile · "Import an existing project" flow
label · **Save & exit** · avatar) over the `[248px rail | content]` grid, with the **Back/Next footer**.
Drawn at **step 3** so the rail shows every state at once — `Connect ✓ · Index ✓ · Audit & convention ●
(current) · Discovery ○ (upcoming) · Generate 🔒 · Review 🔒` — and the **locked Generate** carries the
"Approve the convention to unlock" tag. This is the panel that answers "what is this / where am I / how
do I leave / why is Generate locked". Copy: eyebrow **"Step 3 of 6 · The gate"**, H1 **"Review your code
health & approve a coding convention"**, the gate callout **"Approve the convention to continue. The
Generate step is locked on the rail until your coding standard is approved — this is the
convention-before-generation gate."**

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

### Panel 3 — Audit + proposed-convention approve (step 3, ★ the gate) — **composes 7.14.1 (`design/coding-convention/`)**

The 7.14.5 review/approve surface embedded as the gate step. The **Code health** card (grade **B** tile
on `--el-success-surface` · "78% of your code already meets the convention · 12 files below" · the
six-category `.cat-grid` with ok/watch/gap dots — measured **against § Convention v1 · proposed**) and
the **Coding convention** card (a `v1 · proposed` lavender pill + an **Edit** ghost button + sectioned
rules, each a provenance `Pill` — **Adopted** mint / **Proposed** lavender). The **gate callout**:
**"Approve the convention to continue. Nothing is injected into a prompt until you approve it as your
standard — and the Generate step stays locked until you do. You can edit it first."** Footer: **"Approve
& set as standard"** primary (+ "Save draft" ghost) and the note "Approving unlocks Generate &
re-audits your code". The audit/convention model (convention = the standard for NEW code Motir
generates; audit = existing code measured against it; approve/update → re-audit) is **owned by 7.14.1**
— this panel embeds its surface and its approve gate, it does not re-argue the model.

### Panel 4 — Light discovery (step 4) — **composes 7.2.1 (`design/ai-chat/`)**

A SHORT discovery pass, migrate-framed. Eyebrow "Step 4 of 6", H1 **"We read your code — now tell us
your goals"**, lead "… we already know your stack and structure from the code, so this is about intent
and scope — not re-deriving what you've built." The 7.2 chat surface embedded as a compact `Card` (AI /
user `.bubble`s + a `.composer` reading "Message Motir…") — the AI opens with what it learned from the
code ("I've read acme/web — a Next.js + Prisma app …") and asks intent questions (reuse the existing
notification service? new page or existing dashboard?). **Owned by 7.2.1** — the full gated onboarding
conversation is theirs; here it's the short migrate variant, cited not re-designed.

### Panel 5 — Code-aware generate + review (steps 5–6) — **composes 7.3.1 (`design/ai-planning/`)**

The 7.3/7.4 generate → review → approve surface embedded, made **migrate-specific**. Eyebrow "Steps 5-6
of 6", H1 **"A plan grounded in your code"**. A **success-tinted** callout makes the code-aware framing
unmistakable: **"This plan reflects your existing code. Proposals reuse your notification service,
extend your admin dashboard, and honour your approved convention — grounded in the code graph + the
audit, not a blank-slate plan."** The canvas (`--el-canvas` dot-grid) shows proposed nodes — a firm
Story node + dashed-accent **`Subtask · add`** proposed nodes (the `design/ai-planning` `add`-op
language) — over the **confirm-to-persist** bar ("4 proposed · Nothing saved yet" · Discard ghost ·
**"Add 4 items to your backlog"** primary). The generating rail state reads "Reading your codebase…".
**Owned by 7.3.1 / 7.4** — the canvas + chat + confirm-to-persist review is theirs; here it's the
migrate mode, cited not re-designed.

### Panel 6 — empty / error / resume states

Four states in a `.states-grid`, each reusing shipped `EmptyState` + a `.callout.danger` (via
`--el-danger`): **Connect failed** ("Couldn't reach GitHub · your place is saved · Retry connect"),
**Index failed — retry** ("Indexing stopped partway · 1,284 of ~2,100 files … we kept what we have ·
Re-run indexing", keeping partial work), **Audit failed** ("… your index is intact, so this is safe to
retry · Re-run audit / Set from defaults instead" — the clean-code-defaults fallback the 7.14.1 fresh
route already draws), and the ★ **Resume** state ("Welcome back — pick up where you left off · your
import for acme/web is paused at **Audit & convention (step 3 of 6)** · Connect and Index are done and
saved · **Resume at step 3** / Start over"). A footer note ties resume to MOTIR-1499's `MigrateOnboarding`
state machine + MOTIR-931's resumable routes.

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
| Rail — **locked** step (the gate)          | marker `--el-muted` + `--el-text-faint` padlock; name `--el-text-muted`; the `.lock-tag` `--el-accent-on-surface`                                                                       |
| Gate callout (`.callout.gate`)             | `--el-callout-bg` (lavender) fill · `--el-callout-text` ink · glyph `--el-accent-on-surface`                                                                                            |
| Footer gate note                           | `--el-text-muted` text · lucide lock `--el-accent-on-surface`                                                                                                                           |
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
- [x] **The step rail** — a NEW ARRANGEMENT of `Card`/list-row grammar + tint marker tiles + a connector
      spine + lucide glyphs (`check`, `lock`), generalising the `design/coding-convention` Panel 5
      wizard step-strip. Done/current/upcoming/locked states pair a glyph + a label + a tint (never
      colour-alone — finding #35).
- [x] **The per-repo index list** (`.idx-repo`) — a NEW ARRANGEMENT of list-row grammar + a per-repo
      progress bar + a state `Pill`, so a **multi-repo** project indexes with per-repo status under an
      aggregate gate. No new primitive — rows + bars + shipped `Pill` tones.
- [x] **The embedded surfaces compose their OWN primitives** — Connect = 7.7.1's grant-rows + repo-rows (a **multi-select** repo set) + Switch; Audit/convention = 7.14.1's grade tile + provenance pills + banners; Discovery = 7.2.1's
      chat bubbles + composer; Generate = 7.3.1's canvas node + confirm-to-persist. Reproduced from their
      shipped assets, **not re-designed**.
- [x] Icons are **lucide** (`Sparkles`, `History`, `check`, `lock`, `github`, `badge-check`, `layout-grid`,
      `database`, `info`, `send`, `boxes`, `triangle-alert`, `refresh-cw`, `power`, `arrow-left`,
      `arrow-right`, `pencil`) at `viewBox="0 0 24 24"`, stroke 2, round caps — matching the shipped
      surfaces.

### Token / a11y rules honoured

- Colour strictly via `--el-*` (incl. `--el-tint-*`); no Tier-0 `--color-*` in product UI, no invented
  hex/rgb/named colour, no `color-mix` over a raw hue (mistake #54). The only raw values are the
  non-semantic elevation shadows, the `--el-overlay-scrim`, and the canvas dot-grid texture — never a
  card/pill/state fill, border, or text colour.
- Shape strictly via element-semantic shape tokens; no raw `rounded-*`/`p-*`/`h-*` for a surface's own
  box (the shape rule) — so a `[data-style]`/`[data-display-style]` swap re-shapes the whole wizard.
- **Not colour-alone** — every rail state pairs a glyph (check / number / padlock) + a label + a tint;
  the locked steps carry the `.lock-tag` text; category dots carry a redundant text label; the disabled
  Next carries `aria-disabled`; the rail is an `aria-label`led `nav` and the current step is
  `aria-current="step"`.
- **AA holds** — every coloured chip/tile carries the hue in the tint background with `--el-text-strong`
  ink; dark parity verified by toggling `data-theme="dark"` (every `--el-*` re-skins through the
  `[data-theme='dark']` `--color-*` overrides).
