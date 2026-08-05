# Coding convention & code-health — design notes

Design reference for the **coding-convention + code-health audit** surface (Story 7.14 —
"Coding-convention + code-health audit engine"). Produced by the **7.14.1** planning-time design
gate (MOTIR-922); it is the layout source of truth for the UI code subtask **7.14.5** (MOTIR-926 —
the code-health UI), which is `blocked_by` this card.

> **Amendment (7.14.1b · MOTIR-1661, 2026-07-15):** rewrites the convention surface to match the
> corrected model pinned by the decision **[MOTIR-1660](#)** (§2):
> **(i)** the convention is **DERIVED + AUTO-USED** — no human approve gate and no free-edit
> (supersedes the MOTIR-1567 free-edit Textarea + the MOTIR-922 approve gate);
> **(ii)** the convention is **READ-ONLY** per repo, refined ONLY via the **universal AI chat**
> (the "Refine with Motir" entry composes the existing `PlanWithAILauncher` → `PlanningWorkspace`
> — cite `design/ai-chat/planning-workspace`; never a bespoke convention editor);
> **(iii)** PER REPO — one convention per (project, repo) pair.
> The audit report + the §10.3 "Deepen this audit" affordance are UNCHANGED.

> **Amendment (7.14.x · MOTIR-1607, 2026-07-04):** added the **§10.3 "Deepen this audit"
> connect-scanner affordance** — a non-blocking, dismissible card that renders INSIDE the audit
> report when no external scanner is connected (Panel 1, in situ) — plus **Panel 6**, its state
> gallery (setup guidance · re-audit · connected/auto-detected · dismissed). It grounds the flow in
> the decision **MOTIR-1590** (§10.3: detect → auto-ingest → no-scanner still-audit + optional
> best-fit Deepen → re-audit-on-connect; GitHub code scanning/CodeQL as the GH-native default,
> SonarQube/SonarCloud as the ecosystem branch; NEVER a required install) and the backend
> **MOTIR-1591** (the structured `noExternalScanner` state + best-fit suggestion exposed over the 7.1
> read-back contract). It is the design reference the code subtask **MOTIR-1592** is `blocked_by`.

> **Amendment (MOTIR-2087, 2026-08-04):** adds **Panel 4b — the audit tab's PRE-AUDIT states**.
> The audit tab had exactly ONE drawn empty state (Panel 4's start-fresh, establish-only case) and
> `AuditPanel.tsx` renders it for every `!audit` — including a project with connected, indexed repos,
> which is what the live `MOTIR` project hits today. Panel 4b draws the two undrawn states — **repos
> connected but never audited**, and **a first audit deriving** — placing the repo-backed state
> BESIDE the fresh one so the difference is a deliberate contrast. It is the design reference for
> **MOTIR-2081** (which state renders) and **MOTIR-2080** (the action that runs the first audit).
> It does NOT touch the connect aside or the per-repo freshness list — those are **MOTIR-1764**'s
> element on the same page (two designs, two elements, no overlap).

> **Amendment (MOTIR-2206, 2026-08-05):** adds **Panel 7 — the audit tab for a MULTI-REPO
> project**. MOTIR-2123 widened the convention half of `/code-health` to the whole repo set and
> deliberately left the audit half on `repoRefs[0]`, recording in its own commit that presenting N
> reports was _"an undesigned presentation question, out of this card's scope."_ Panel 7 is that
> question answered: the **LIST-AND-REPORT** model (a worst-first repo list carrying each repo's own
> grade, and the selected repo's report — Panel 1's report, unchanged — beneath it), the explicit
> refusal to draw a project-level grade, the **partially-derived** fifth state that Panel 4b's
> all-or-nothing A–D cannot express, and the four rules the build cannot re-decide (which repo the
> poll watches, the sort order, findings stay per repo, N = 1 draws no list). Panels 1, 2, 4b, 5 and
> 6 are UNCHANGED — Panel 7 is the layer above them that chooses whose report is on screen. It is
> the design reference for **MOTIR-2207**, which is `blocked_by` this card and is its **only**
> consumer.

Built from the real design system: the mock inlines the token layer from
`packages/design-system/theme.css` (the `@theme` Tier-0 `--color-*`/shape scale, the Tier-3
`--el-*` element layer, the `[data-theme='dark']` overrides) and composes the SHIPPED
`@motir/design-system` primitives — no new vocabulary is invented in this Story.

| Surface                                                       | Asset                                                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Coding-convention review / approve (all states + access path) | `convention.mock.html` (source of truth) · `convention.png` (light export) · `convention.dark.png` (dark-parity export) |

> **Amendment (MOTIR-2245, 2026-08-05):** adds **Panel 8 — the audit tab's PER-REPO TRIGGERS**:
> a row action that audits ONE repo and a header action that audits every repo with no report, over
> the repo-scoped trigger MOTIR-2247 ships. It **amends Panel 7 and redraws nothing** — Panel 7's row
> anatomy, states, ordering, selection model and N = 1 rule all stand. It settles two questions the
> build card would otherwise invent answers to: an `unavailable` row gets **no** audit trigger (only
> its free re-READ), and **no trigger confirms** (the shipped whole-set button, which costs more,
> already does not). Panel 8 §8 records what it gives and takes, by key.

## The model: convention ↔ audit (the load-bearing relationship)

**Corrected by MOTIR-1660 (7.14.2e, 2026-07-06).** The two artifacts are **linked**, and the
direction matters (Yue, 2026-07-03):

- **The `CodingConvention` is the standard for the code Motir GENERATES** — not a linter for existing
  code. It is the house-rules document injected into every dispatched prompt (the productized
  CLAUDE.md). It is **DERIVED from the real code** (migrate: the code IS the convention; fresh:
  stack + clean-code defaults) and **AUTO-USED** — there is NO human approve gate and NO free-edit
  (the ETH-Zurich "no-blind-auto-gen" caveat wanted grounding in the real code, not a non-expert
  rubber-stamp). **READ-ONLY and PER REPO** — each repo has its own convention document discoverable
  on the Code-health page; it cannot be hand-edited. **To change it, the user tells Motir in the
  UNIVERSAL AI CHAT** via the "Refine with Motir" entry — the same `PlanWithAILauncher` →
  `PlanningWorkspace` surface that handles ALL AI conversation (per design/ai-chat; never a bespoke
  convention editor). Supersedes the ADR's `proposed → standard` approve lifecycle and the
  MOTIR-1567 free-edit.
- **The `CodeAudit` measures EXISTING code against the derived convention** and reports what is **not
  up to standard** — the conformance gap between the code you have and the standard for new
  code. Where the convention is silent, it falls back to a clean-code baseline (so a finding is tagged
  either the convention rule it breaks, or "clean-code baseline"). Before any convention exists from
  code, the baseline alone seeds the first derived convention (adopt-if-clear / propose-if-messy).
- **The trigger:** a code change (on-demand / repo webhook) proposes a new convention version if the
  code drifts; a "refine with Motir" revision re-audits existing code against the revised standard.
  So the audit report is always stamped to the convention version it was measured against
  (`§ Convention vN`).

## The data behind the surface (from 7.14.2 / 7.14.3)

Two artifacts, one motir-ai store (never in motir-core — the open-core boundary):

- **`CodeAudit`** — `healthSummaryJson` (a CodeScene-CodeHealth-style **conformance** score/grade +
  per-category breakdown), `findingsJson` (`[{ rule, category, severity, fileRef, symbolRef, why,
conventionRuleRef? }]`, cursor-paginated), `codeGraphRef`, **`conventionId` / `conventionVersion`**
  (which approved convention the audit was measured against). Runs for migrate (there is code) AND on a
  convention approve/update (re-audit against the new standard).
- **`CodingConvention`** — `contentMd` (the sectioned document, READ-ONLY), `provenanceJson`
  (per-rule adopted-vs-proposed for the badges), `repoIdentifier` (one per repo). Derived from code
  (migrate) or stack + clean-code defaults (fresh); auto-applied to every prompt for that repo.
  Changes happen via the universal AI chat ("refine with Motir"); the version history tracks every
  revision. The convention is the standard for NEW code — there is no "proposed" vs "standard"
  lifecycle.

## Multi-panel board — review EACH panel (mistake #31)

The `.mock.html` is a seven-panel board (labelled 1 · 2 · 4 · 4b · 5 · 6 · 7 — the edit/approve
panel was removed per MOTIR-1660, Panel 4b added per MOTIR-2087, Panel 7 per MOTIR-2206); do not
review only the first. Each panel is a `.panel-label` mono caption + a centred `.panel` wrapper (the
`design/ready` convention).

1. **Panel 1 — THE FULL SCREEN, in the real app shell (Audit tab).** The complete Code health page
   as it renders: the full-width **TopNav**, the **persistent left `SidebarNav`** (Code health
   active), and the content region — page header + **Audit / Convention tabs** + the audit content
   (conformance SUMMARY: grade + % conform + six-category breakdown, measured against the derived
   convention; the **"Deepen this audit" affordance** in situ — the non-blocking §10.3 connect-scanner
   card, shown only in the `noExternalScanner` state, between the summary and the findings; then a
   grouped, virtualized findings list where each finding cites the convention rule it breaks, or the
   clean-code baseline). This is the panel that answers "where am I / is the nav there / how do I
   leave".
2. **Panel 2 — Content region · the Convention tab (READ-ONLY, per repo).** The `contentMd` as a
   sectioned document with a header toolbar (per-repo label + "Refine with Motir" button), each rule
   badged by provenance (Adopted vs Proposed), and a "DERIVED FROM YOUR CODE · auto-used" banner.
   The **"Refine with Motir"** button composes the universal AI chat (`PlanWithAILauncher` →
   `PlanningWorkspace` per `design/ai-chat`); there is NO approve gate, no Edit button, no Textarea.
   The convention is a read-only document.
3. **Panel 3 — Content region · Fresh (establish-only) + version states.** The no-codebase
   `EmptyState`, the stack-derived proposal, the version-history affordance, the "Re-run audit"
   action. Updated per MOTIR-1660: the stack-derived proposal is also derived + auto-used.
   _(Numbering note: this panel is labelled **"Panel 4"** in the mock — the old Panel 3
   edit/approve panel was removed by MOTIR-1660 and the remaining labels were not renumbered. The
   mock's labels are 1 · 2 · 4 · 4b · 5 · 6; where the two disagree, the mock's label wins.)_
   3b. **Panel 4b — the audit tab BEFORE a first audit exists (MOTIR-2087).** Four states from the one
   `!audit` branch: **A** start-fresh/no repos (shipped, unchanged) · **B** repo-backed but never
   audited · **C** a first audit deriving · **D** the poll's 60-second cut-off. A and B are drawn
   side by side — the contrast IS the point.
4. **Panel 4 — The fresh-project door.** The onboarding wizard step (the steady-state door is the
   persistent sidebar entry, drawn in Panel 1's shell).
5. **Panel 5 — The "Deepen this audit" affordance, state by state** (§10.3; MOTIR-1590 + MOTIR-1591).
   The DEFAULT card lives in Panel 1's audit report; this panel zooms its four states unchanged.
6. **Panel 7 — the audit tab for a MULTI-REPO project (MOTIR-2206).** The layer ABOVE Panel 1 that
   chooses which repo's report is on screen: **7a** the steady state (five repos, four audited — the
   worst-first list, then the selected repo's report), **7b** the **partially-derived** fifth state
   in its two cases (E1 the selected repo has landed · E2 it has not), **7c** the row anatomy and
   its four states (audited · deriving · not audited · unavailable). Panels 1/2/4b are unchanged
   beneath it.

Panels 2–3 are the **content region of the Panel 1 screen** in each state — each carries a `.ctx`
breadcrumb strip ("Code health › Convention tab", etc.) so the reader always knows it's the same
screen, not a new one.

## The screen — app shell, orientation & navigation (Panel 1)

The surface is drawn AS THE REAL SCREEN, inside the shipped `AppLayout` shell — not as floating
cards — so a reviewer can see the nav, orient, and navigate. This answers three questions directly:

- **Is the left nav there?** YES — it's the **persistent app shell**. `AppLayout` = a full-width
  56px **TopNav** above a `[240px SidebarNav | scrolling main]` grid; the rail is always present
  (≥md; an off-canvas drawer below md). Panel 1 draws the whole thing: the TopNav (the
  `Org › Workspace` tier crumb left; Plan-with-AI + create + search + theme + bell + avatar right,
  mirroring `TopNav.tsx`) and the `SidebarNav` rail with **Code health** active.
- **Where am I ("you are here")?** Three shipped cues, all drawn: the **active sidebar row** (Code
  health, inset + accent glyph + grade badge), the page **`<h1>`** ("Code health", serif `text-2xl`
  with the `activity` glyph — the shipped page-header pattern), and the **`Acme › Engineering`** tier
  crumb in the top bar. The app has no universal slash-breadcrumb (only issue-detail has an ancestor
  breadcrumb), so orientation rides on h1 + active row + tier crumb.
- **How do I go back / navigate?** Code health is a **top-level project page** (like Reports), so
  there is no dedicated "Back" button — the **persistent sidebar IS the way out** (click Boards /
  Issues / Reports…). WITHIN the page, the **Audit / Convention tabs** (`Segmented`) switch the two
  views, and edit mode (Panel 3) has an explicit **Cancel** back to the Convention tab. An
  orientation callout under Panel 1 states all of this.

**The Code health page has two tabs** (`Segmented` raised-track control): **Audit** (the conformance
report) and **Convention** (the standard document + edit/approve/versions). The page header carries
the title + subtitle + the "Re-run audit" action; the tabs sit below it.

**Access / the door:** the steady-state door is the persistent **Code health** sidebar entry (drawn
active in Panel 1's shell) — inserted after Reports in `SidebarNav.tsx` (glyph lucide `activity`,
label `t('nav.codeHealth')`, href `/code-health`, badge = the grade; also in the mobile
`SidebarDrawer`), shown for a project with a connected repo OR an established convention. The
**fresh-project door** is the onboarding wizard's _Establish convention_ step (Panel 5). The code
subtask 7.14.5 wires both.

---

## Panel anatomy + exact copy

### Panel 1 — the full screen (app shell + Audit tab)

- **Shell**: full-width `.topbar` (`Acme › Engineering` crumb + right cluster) above the
  `.shell-body` grid = `.rail` (240px, Code health active) + `.main`/`.content`. Then the page header:
  serif `<h1>` "Code health" (with the `activity` glyph) + subtitle + the "Re-run audit" secondary
  `Button`; below it the **Audit | Convention** `.tabs` (Audit active). The audit content lives in
  `.content` as cards.
- **Audit card header**: `<h3>` "Audit" + a neutral count `Pill` "143 findings". Sub-line: "Audited
  `acme/web@a1b9f30` **against § Convention v2 · your standard** · code graph index v7 · 2 hours ago."
  (the convention version the audit was measured against is a `.conv-ref` chip).
- **Relationship banner** (`.banner-standard`, lucide `git-compare`): "**Measured against your
  convention — the standard for NEW code**" · "Code health scores how far your EXISTING code is from
  the convention Motir injects into every prompt. Update the convention (Panel 3) and this re-audits
  automatically against the new standard." (draws the convention → audit link + the re-audit trigger).
- **Health summary**: a `.grade` tile — big serif letter "**B**" + "**78% conform**" — on
  `--el-success-surface`, beside the verdict "**78% of your code already meets your convention — 12
  files fall below the standard.**" + the "CodeScene-CodeHealth-style **conformance** score across six
  categories… each category graded against the matching convention section; where the convention is
  silent it falls back to clean-code defaults (tagged `Clean-code baseline`)." explainer. A six-cell
  category grid, coloured dot + label, framed as conformance: "Layering · conforms", "Naming ·
  conforms", "Complexity · 12 off-standard", "Duplication · 6 clusters", "Testing · below standard",
  "Error handling · conforms".
- **Findings list** (`Card`): eyebrow "Not up to your convention · grouped by category, worst first ·
  each finding cites the convention rule it breaks, or the clean-code baseline where the convention is
  silent", then finding rows. Each row = a severity `Pill` + the rule (bold) + a one-line "why this
  matters" + `.coderef` file/symbol chips + **a reference tag**: a `.conv-ref` "§ Convention · <section>
  — <rule>" (lavender = the convention identity) when the finding breaks a convention rule (the
  Layering / Testing / Naming findings map to the exact Panel 2 rules), or a `.base-ref`
  "Clean-code baseline" (neutral) where the convention is silent (the "too": general code health).
  Severities: **Critical** (danger), **High** (warning), **Medium** (info), **Low** (neutral). Footer +
  `.virt-note` review-only annotation naming the `useRowWindow` primitive + the cursor-paginated
  `codeAuditRepository` read (the scale mechanism — see "Scale" below).
- **"Deepen this audit" affordance** (`.deepen`, in situ between the health-summary card and the
  findings card) — the §10.3 connect-scanner card, drawn ONLY in the backend `noExternalScanner`
  state (MOTIR-1591). It is deliberately a **secondary, dismissible aside**, not a report card: a
  quiet `--el-surface-soft` fill (vs the white `--el-card` of the report), a `.deepen-dismiss` ghost
  **×** (lucide `x`, top-right), and an **"Optional · non-blocking"** eyebrow — so it visibly only
  _deepens_ the already-complete report and never gates it. Anatomy: a `scan-search` lead glyph +
  serif title "**Deepen this audit with an external scanner**" + a sub that states the report is
  already complete and **no external scanner is connected**; a **best-fit** label naming the repo
  (`acme/web`, a GitHub repo); then two `.tool` option rows — **GitHub code scanning (CodeQL)** as the
  `.tool-rec` **Recommended** default (accent edge + a lavender "Recommended" `.tag-rec`; lucide
  `github`; primary **Set up CodeQL**) and **SonarQube / SonarCloud** as the ecosystem branch (lucide
  `shield-check`; secondary **Connect Sonar**) — and a `.setup-hint` footer that names the re-audit
  behaviour and points to Panel 6. The **access path** for the affordance is exactly this: it renders
  in the audit report the user is already reading, so the door is the report itself.

### Panel 2 — read-only convention per repo (MOTIR-1660)

- **Document header toolbar (the refine door)**: a `.card-head` on the convention card — `<h3>`
  "Coding convention" + a per-repo label ("per repo · acme/web") + a "derived from your code"
  provenance chip + a **"Refine with Motir"** secondary `Button` (lucide `sparkles` — the universal
  AI chat identity). This button **composes** the existing universal AI chat launcher
  (`PlanWithAILauncher` → `PlanningWorkspace`, per `design/ai-chat` and MOTIR-1193 / MOTIR-1299);
  there is NO Edit (pencil) button, NO "Approve as standard" primary button, no Textarea.
- **Status banner**: `.banner-standard` on `--el-success-surface`, lucide `database` (derived from
  the code itself), title "**DERIVED FROM YOUR CODE · auto-used**", sub "This convention is derived
  from the code in `acme/web` and applied automatically to every prompt for NEW code Motir generates
  for this repo. There is no approve gate — the grounding in your real code IS the curation. To
  change it, tell Motir in the universal AI chat with 'Refine with Motir' — the convention stays
  read-only until you do."
- **The document**: `.doc-section` blocks (Layering / Naming / Testing / Error handling), each a
  `<h4>` + rules. Every rule = a provenance `Pill` (Adopted / Proposed) + the rule text (with inline
  `<code>` for identifiers). Provenance legend at the foot: "**Adopted** your code already does this
  — we documented it" / "**Proposed** your code was silent / inconsistent — a clean-code default to
  review".
- **Refine callout**: a footer note below the document explaining that "Refine with Motir" opens the
  universal AI chat where the convention is read-only context and the chat is the mutation surface —
  no free-form Textarea. Cites `design/ai-chat` + `PlanWithAILauncher` / `PlanningWorkspace`.

### Panel 3 — fresh (establish-only) + version states

- **No audit** (`EmptyState`, lucide `file-search`): title "**No codebase to analyze yet**",
  description "Your convention is established from your chosen stack — the code-health audit runs
  later, once there's code to read.", action secondary `Button` "View chosen stack".
- **Stack-derived proposal**: a `.banner-standard` "**DERIVED FROM YOUR STACK · auto-used**" ·
  "Next.js + Prisma + Postgres defaults. No audit — nothing to adopt yet, so every rule is a
  clean-code default. Auto-applied to every prompt; refine with Motir via the universal AI chat to
  change.", then all-**Proposed** rules (no Adopted, because there is no code). Note:
  "Same derived + auto-used, read-only model (Panel 2). Only the audit differs (there is none)."
- **Version history** (`Card`): heading "Version history" + a secondary "Re-run audit" `Button`; the
  refresh note names **two triggers** — code changes (on-demand / repo webhook, proposes a new
  convention version if the code drifts) and convention changes (a "refine with Motir" revision via
  the universal AI chat re-audits existing code against the revised standard). The convention is
  retained and never silently overwritten — changes are tracked in the version history. A `.version`
  list: **v3** "Latest re-audit" (Review), **v2** "Active" (current, View), **v1** "First standard ·
  superseded" (Restore).

### Panel 4b — the audit tab's PRE-AUDIT states (MOTIR-2087)

**The problem this fixes.** `AuditPanel.tsx:55` returns ONE `EmptyState` for `!audit`. Its copy —
"No codebase to analyze yet / Your convention is established from your chosen stack…" — is correct
for a start-fresh project and **false twice over** for a repo-backed one: there IS a codebase, and
its convention would be derived from the code graph, not from a chosen stack. **The "chosen stack"
sentence must never appear on a project with connected repos.** That single line is what makes the
shipped state wrong, and it is the reason the two states are drawn side by side rather than as two
independently-written screens.

**One branch becomes four.** All four compose the shipped `EmptyState`
(`packages/design-system/src/components/ui/EmptyState.tsx` — `icon` / `title` / `description` /
`action`). No new primitive, no new pattern.

| State                              | Condition                      | Icon (lucide)               | Action                              | Built by                                                                |
| ---------------------------------- | ------------------------------ | --------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| **A** · start-fresh                | `!audit && repos.length === 0` | `file-search`               | secondary **View chosen stack**     | shipped (copy unchanged) — the branch that selects it is **MOTIR-2081** |
| **B** · repo-backed, never audited | `!audit && repos.length > 0`   | `folder-git-2`              | **primary** **Run the first audit** | copy + branch **MOTIR-2081**; the action **MOTIR-2080**                 |
| **C** · deriving                   | `!audit && reauditing`         | the `.spin` ring (no glyph) | **none — removed**                  | **MOTIR-2080**                                                          |
| **D** · poll exhausted             | `!audit && pollExhausted`      | `clock`                     | secondary **Check again**           | **MOTIR-2080**                                                          |

**Exact copy — verbatim, ready to become `en.json` keys** (every key needs its `zh.json` twin; the
consuming card owns the catalogue-parity gate):

| Key (under `codeHealth.audit`)      | Copy                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `emptyTitle` _(A, unchanged)_       | No codebase to analyze yet                                                                                                                                                           |
| `emptyDescription` _(A, unchanged)_ | Your convention is established from your chosen stack — the code-health audit runs later, once there's code to read.                                                                 |
| `noAuditTitle` _(B)_                | No audit for this code yet                                                                                                                                                           |
| `noAuditDescription` _(B)_          | Motir has indexed your connected repos but has never measured them against a convention. Run the first audit to derive the convention from your code and score what's already there. |
| `runFirstAudit` _(B, action)_       | Run the first audit                                                                                                                                                                  |
| `derivingTitle` _(C)_               | Deriving your first audit…                                                                                                                                                           |
| `derivingDescription` _(C)_         | Motir is reading the code graph for these repos, deriving a convention from what it finds, and scoring your code against it.                                                         |
| `derivingDuration` _(C)_            | This usually takes a few minutes. You can leave this page — the audit keeps running.                                                                                                 |
| `stillRunningTitle` _(D)_           | Still working on your first audit                                                                                                                                                    |
| `stillRunningDescription` _(D)_     | The audit is taking longer than this page waits. It keeps running in the background — check again in a few minutes.                                                                  |
| `checkAgain` _(D, action)_          | Check again                                                                                                                                                                          |

**Which slot each element occupies.** `title` takes the headline. **The repo list rides in
`description`** — `EmptyState.description` is typed `ReactNode` precisely so copy can carry inline
nodes, so the description is a sentence followed by a row of `--el-code-*` repo chips (the shipped
code-chip grammar, one per `resolveCodeContext().repos[].repoRef`). It is NOT a fifth slot and NOT a
new prop. **The repo list stays visible in B, C and D** — it is the constant that says "this screen
is about your code"; only the headline, the icon and the action change beneath it. State C's
duration line also rides in `description`, below the chips.

**Why B's action is primary and A's is secondary.** A's action is _navigational_ — there is nothing
to run, so it points at the stack the convention came from. B's action is _generative_, and it is
the only thing to do on the screen. The weight difference is the design carrying the semantic one.

**What replaces the action once fired (State C).** The action is **removed**, not disabled and not
left in a `loading` state. The job runs for minutes; a pending button implies a request the page is
blocked on and invites a second click. The spinner moves to the **icon** slot (the shipped `.spin`
ring — `--el-border-strong` track, `--el-accent-on-surface` head) and the duration line takes the
action's place. **The deriving state is signalled by the ring, never by a border-style change** — no
dashed border, which would collide with borders that carry data elsewhere in the system.

**State D is a routine outcome, not an edge case.** `REAUDIT_POLL_MS` (3000) ×
`REAUDIT_POLL_TRIES` (20) = **exactly 60 seconds**. A first audit across five repos does not finish
in one minute, so **most first runs land in D** — it must be designed as a normal resting state, not
an error. Three consequences the consuming card must honour:

1. **It renders INSIDE the empty state**, not in the rose `Card tint="rose"` error strip at the top
   of `CodeHealthClient` where `setError(t('deepen.reauditPending'))` puts it today. A job that is
   still running is not a failure; colouring it as one teaches the user their audit broke.
2. **"Check again" re-READS the audit** (the island's `reload()`). It must NOT re-`POST`
   `/api/ai/coding-convention/refresh`, which would queue a second `code_audit` +
   `propose_convention` pair for work already in flight.
3. The 60-second window is a **UI** wait, not a job timeout — the copy says the audit keeps running
   because it does.

**Page-state after the mutation (the contract).** The trigger fires from **inside the client island**
(`CodeHealthClient`), and the surface that must update is that same island's own state — contract
case 3. It resolves through the island's **own refetch**: `reaudit()` already polls `AUDIT_URL` and
calls `reload()`, which `setAudit(...)`. **No `router.refresh()`, no `revalidatePath()`** — the
island is seeded from `useState(initialProps)` and a server re-read cannot reach it. There is no
second surface to route: **verified against `SidebarNav.tsx:294–297`, the Code health nav row carries
label + href only — no grade badge** (the badge in Panel 5's access-path drawing is design intent
that was never built), so no Server-Component surface changes when the first audit lands.

**A prop the page already has and throws away.** `page.tsx:58` resolves `repos` via
`resolveCodeContext` and uses it only to decide whether to fetch. Distinguishing A from B needs that
repo set — and the chips need `repoRef` — so it must be threaded `page.tsx → CodeHealthClient →
AuditPanel`. That is a prop addition, not a new data path.

**One divergence between this asset and shipped code, recorded so the consumer decides deliberately:**
Panel 4 (and State A here) draws a secondary **"View chosen stack"** action, but the shipped
`AuditPanel` passes `EmptyState` no `action` at all. The design keeps it; MOTIR-2081 either wires it
or drops it explicitly — it should not stay an undocumented gap.

### Panel 5 — access path (the door)

- **Sidebar rail** (`Sidebar` / `SidebarNav` grammar): a `.rail-head` project stand-in ("acme/web ·
  moooon workspace"), the primary nav section (Dashboard / Issues / Boards / Reports / **Code health**
  / …) with **Code health** drawn `active` (the `--el-sidebar-item-bg-active` inset row + accent
  glyph), its grade badge "B" as a neutral count chip, then a `Settings` row. The `.between-note`
  states the exact insertion (after Reports; glyph `activity`; `t('nav.codeHealth')`; `/code-health`;
  connected-repo-or-established-convention gating; mobile `SidebarDrawer`).
- **Onboarding wizard step strip** (`Card`, eyebrow "Fresh project · onboarding wizard"): steps
  "Discovery ✓ → Design system ✓ → **Establish convention** (current) → Review plan", the current step
  in the accent-outlined `.step.current` state; note that the surface opens IN the wizard for a fresh
  project, then stays reachable at the sidebar entry.

### Panel 6 — the "Deepen this audit" affordance, state by state (§10.3)

Grounds the flow in **MOTIR-1590** (the §10.3 decision) + **MOTIR-1591** (the backend
`noExternalScanner` + best-fit state) — the affordance does NOT invent a flow. The DEFAULT card is
Panel 1's in-situ `.deepen`; this panel is the state gallery.

- **State A — set up CodeQL (the recommended branch).** The `.deepen` card zoomed into guided setup:
  a `github` lead glyph + "**Set up GitHub code scanning (CodeQL)**", a copy-paste `.setup-code`
  block (`.github/workflows/codeql.yml` — the lightest native path, SARIF into the code-scanning API
  Motir already reads), a `.setup-hint` that Motir **detects the upload automatically and re-audits**
  (no explicit connect step), and a `.deepen-foot` with a primary **Re-audit now** (lucide
  `refresh-cw`), ghost **Copy workflow**, and ghost **Use SonarQube instead** (the branch out). This
  is the GH-native default; the Sonar branch is the `sonar-project.properties` path.
- **State B — connected → re-auditing** (page-state-after-mutation). The audit card with a
  `.deepen-done` running banner on `--el-surface-soft`: a `.spin` ring + "**CodeQL connected —
  re-auditing your code…**" · the existing report stays readable while Tier-2 findings ingest and the
  report refreshes. (The page-state contract: connecting is a mutation on the audit surface, so the
  report re-reads — it does not silently keep the pre-connect state.)
- **State C — deepened / connected** (and the auto-detected variant). The audit sub-line now carries a
  Tier-2 `.tier2-chip` "**CodeQL · 8 findings ingested**" (lucide `github`), the count is bumped
  (143 → 151), and a green `.deepen-done` "**Scanner connected — this audit now includes CodeQL
  findings**" banner replaces the setup card (external findings merge into the list, tagged by
  source). A `.setup-hint` documents the **auto-detected variant**: when MOTIR-1591 finds an existing
  SARIF source (code-scanning API / `sonar-project.properties` / a CI scan workflow / an ESLint
  config) it ingests silently — the same chip + banner appear with **no** setup card ever shown
  (Tier 2, zero user action).
- **State D — dismissed.** The audit report unchanged and fully usable; the card is replaced by a
  quiet one-line `.deepen-link` ("Deepen this audit with an external scanner", lucide `scan-search`)
  that re-opens it. A `.setup-hint` notes the dismissal is per-project so it doesn't nag on every
  visit — the non-blocking contract taken to its conclusion.

### Panel 7 — the audit tab for a MULTI-REPO project (MOTIR-2206)

**The problem this answers.** `page.tsx`'s `loadCodeHealthSurfaces` reads `const auditRepoKey = repoRefs[0]`
and returns ONE `CodeAudit` surface beside one convention surface **per** repo; `CodeHealthClient.tsx`
derives `const auditRepoRef = repoRefs[0] ?? null` and scopes `reload`, `loadMoreFindings` and the
re-audit poll to it. Both are presentation, not data — MOTIR-1662 scoped `CodeAudit` to
`(project, repo)` in the store and MOTIR-2123 made `aiConventionService.reaudit` fan out one
`code_audit` + `propose_convention` pair per connected repo. So one re-audit on MOTIR derives **five**
`CodeAudit` rows and the tab shows the one that sorts first under `listByInstallation`'s
`owner asc, name asc`. The other four are derived, stored, paid for and invisible, and the single
grade on screen reads as a statement about the _project_ when it is a statement about `motir-ai`.

#### 1 · The selection model — **LIST-AND-REPORT**, worst-first, one report at a time

A `Repositories` card holds a **worst-first list of the connected repos**, each row carrying that
repo's own grade, conformance, finding count and audit time; **the selected repo's report renders
beneath it, unchanged from Panel 1**. Clicking a row swaps the report.

**Rejected, one line each:**

| Rejected                                                              | Why it loses                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stacked reports, one per repo** (the shape the Convention tab uses) | MEASURED: the shipped `HealthSummary` card renders **288 px** tall at the 1080 px content width — five of them is **1 440 px of grade tiles before a single finding row**, with no comparison anywhere and five independent `nextOffset` lists live at once. |
| **A `Segmented` repo switcher**                                       | The shipped tab primitive cannot carry a per-repo grade, wraps badly at five long `owner/name` labels, and reuses one line below the control that already means _Audit \| Convention_.                                                                       |
| **One merged findings list with a repo column**                       | Turns one `nextOffset` into N interleaved cursors — a new pagination contract — and no mirror does it (see §3).                                                                                                                                              |
| **A worst-first ranking with no report**                              | Answers "which repo is worst" and deletes the report the tab exists for.                                                                                                                                                                                     |

**Why LIST-AND-REPORT wins.** It is the shape all three verified mirrors converge on (below); it puts
the grade **where a grade is true** — per repo — instead of inventing a project one; it leaves the
pagination contract untouched; and it makes _"the repo on screen"_ a single nameable value, which is
exactly what the re-audit poll needs to watch (§4). The list is also the answer to
_"how does a person discover the other four repos exist?"_ — today there is no affordance at all.

**Mirror (rung 1, verified PER SURFACE — `notes.html` #33, not a generic "scale = selector" reflex).**
**CodeScene** (this asset's standing mirror) analyses a project of several repositories and presents
a **per-repository Code Health entry that you open** — the score lives on the repository, and the
detail view is one repository at a time. **SonarQube/SonarCloud** does the same one level up: a
**Projects list with a rating and a quality gate per project**, drilling into ONE project's issues;
it never merges issues across projects by default and it publishes no single portfolio grade in the
community tier. **GitHub code scanning** (Panel 1/6's best-fit branch) has a **security overview that
ranks repositories by alert counts** and links into one repository's alerts. Three products, one
convergent answer: **rank the repos, drill into one.** None of them averages quality across repos.

#### 2 · The cross-repo summary — **there is NO project-level grade**, and that is the decision

Five repos have five grades, five conformance percentages and five finding counts. A project-level
grade would have to be a **mean**, and a mean of quality scores across codebases of different sizes
is a claim rather than a calculation: it would report "67%" for a project holding a 34% repo and a
94% repo, and it would move when a repo is _connected_ rather than when any code changed. So the
card head carries **counts that are true by addition** instead:

> **4 of 5** audited · **462** findings across them · 1 not audited yet

This is the same rule `design/repository-set` §15.6 fixed for its own header — _"the header count
counts what is TRUE (`4 of 5 can clone`) rather than what was attempted"_ — inherited, not
re-invented. During a fan-out the counts stay honest: they count what has **landed**, never what was
queued (Panel 7b's E1 reads _2 of 5 audited · 223 findings · 2 deriving_).

#### 3 · Findings — **per repo, behind the selection; `nextOffset` is untouched**

`FindingsList` paginates ONE audit's findings (`FINDINGS_PAGE_SIZE = 100`, `nextOffset`). They stay
that way. A merged list would need N interleaved cursors and a cross-repo ordering rule for a
worst-first list that is already worst-first _within_ a repo, and no mirror merges (§1). **The one
thing the build must add: switching repos RESETS the list** — the newly selected repo's first page,
never an append onto the previous repo's — because `nextOffset` is an offset into a specific audit.

**The read shape, and the one motir-core-only change it needs.** The list needs `healthSummary` +
`total` for **every** repo; only the selected repo needs `findings`. `aiConventionService.getAudit`
currently pins `findingsLimit: FINDINGS_PAGE_SIZE`, so reading N surfaces today ships N × 100
findings to draw a five-row list. Verified at rung 2 against `motir-ai` `origin/main`:
`GET /v1/code-audit` already accepts `findingsLimit`, and `parsePositiveInt` (`src/app.ts:80`)
**rejects `0`** with a `validation_error` — so the cheapest legal summary read is `findingsLimit=1`,
not `0`. Exposing `findingsLimit` as an optional opt on `getAudit` (and as a query param on
`app/api/ai/coding-convention/audit/route.ts`, beside the `findingsOffset` it already parses) is a
**motir-core-only** change: `motirAiClient.getCodeAudit` already forwards the field and nothing in
`motir-ai` moves.

> ⚠️ **This amends MOTIR-2207's acceptance criteria** (`notes.html` #214 — a design that decides
> something its consuming card's criteria forbid must SWEEP those criteria, not leave the card to
> discover the contradiction). MOTIR-2207 reads _"No file under `lib/ai/`, no route under
> `app/api/ai/`, and nothing in the motir-ai repo is modified by this PR."_ Its stated intent is
> **no boundary work**, and this passthrough is not boundary work. The criterion is amended on the
> card to: nothing in `motir-ai` changes and `lib/ai/motirAiClient.ts`'s boundary contract is
> unchanged; `aiConventionService.getAudit` and the audit route MAY gain the optional
> `findingsLimit` passthrough this panel requires.

#### 4 · Which repo the re-audit poll watches — one sentence, and the build cannot pick another

> **The poll watches the repo whose report is on screen: `reaudit()` fires exactly ONE
> `POST /api/ai/coding-convention/refresh` and then polls the SELECTED repo's audit surface for a new
> `audit.id`; when no repo is selected yet it polls the first row, and the selection does not move
> for the duration of the run.**

Two consequences that follow from it and are part of the rule: the ONE-POST invariant is MOTIR-2123's
and a poll tick must never re-POST; and the list's **order is recomputed only on a completed read**,
so a repo finishing mid-run cannot re-sort the list under the reader.

**Order:** ascending `conformancePct` (worst first), then the deriving rows, then the never-audited
rows, with connected-repo order (`owner asc, name asc`) as the tiebreak — and as the WHOLE order
before any audit exists, where conformance is undefined. **Selection is held by `repoRef`, never by
index**, so a re-sort can never move it.

**Selection lives in component state on the existing client island** — the same place the
`Audit | Convention` tab state already lives. Not a query param, not a URL segment: the tab itself
is not addressable today and this panel does not open that question.

#### 5 · The **partially-derived** state — the fifth state, and it lives in the LIST

Panel 4b's A–D are all-or-nothing because they were drawn for one report. A fan-out queues N pairs at
once and they land one at a time, so a project is routinely **partly** audited — and with
`REAUDIT_POLL_MS × REAUDIT_POLL_TRIES = 60 s` against a multi-repo first run, this is the state MOTIR
actually sits in for minutes. **It is not a fifth empty state: it is a state of the LIST**, which is
what makes it structurally different from C and D rather than a variant of them. Two cases:

| Case                                  | Condition                                                | What renders                                                                                                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E1** · selected repo has landed     | the selected `repoRef` has an audit; ≥1 sibling does not | The report renders normally (7a). The LIST carries the difference: landed rows show their grade, in-flight rows show `.spin` + **Deriving…**, never-audited rows show the `folder-git-2` + **Not audited yet** state. |
| **E2** · selected repo has not landed | the selected `repoRef` has no audit; ≥1 sibling does     | The LIST is unchanged from E1. **Only the report area** is empty, and it carries a ONE-REPO deriving state whose headline names that repository and whose body says the others are unaffected.                        |

**Why E2's copy is not Panel 4b State C.** C reads _"Motir is reading the code graph for **these
repos**"_ over a chip row of the whole set — correct when nothing has been derived and the whole
project is waiting. In E2 one repo is waiting and the rest are readable, so the headline is singular
and the body points at the list. It is not D either: D is the 60-second cut-off with **nothing at all**
on screen. **Panel 4b's A–D keep their shipped copy and fire unchanged whenever NO repo has an
audit** — this panel takes nothing away from MOTIR-2080 / MOTIR-2081.

**How the build knows a repo is "deriving" — no new backend field.** `reaudit()` already returns
`ReauditResultDTO { repos: [{ repoKey, auditJobId, conventionJobId }] }`, so the island knows exactly
which repos it queued; a repo is _deriving_ while it is in that set and its `audit.id` has not
changed since the POST. Do NOT invent a status field on the DTO — that would be a motir-ai change and
a two-repo straddle.

#### 5b · The run must SURVIVE the page — the deriving state cannot live in client memory (Yue, 2026-08-05)

**The promise the copy makes.** Panel 4b State C says _"You can leave this page — the audit keeps
running."_ §5 above reuses it verbatim for E2. **Half of that is already true and half of it is a
promise this design, as first drafted, could not keep.**

**True: the job does not stop.** `refreshCodeAudit` POSTs `/v1/code-context/refresh`, motir-ai
persists each job and answers with its ids; the browser's poll is an OBSERVER, so aborting it by
navigating away cannot cancel anything. Leaving the page does not stop the audit.

**False as first drafted: the PAGE forgets the run.** `reauditing` and `pollExhausted` are
`useState`, and §5's per-repo "deriving" set was defined off `reaudit()`'s in-memory return. All
three are gone on the next mount. So a user who takes the copy at its word and leaves comes back to:

- Panel 4b **State B** — _"No audit for this code yet"_ with a **primary "Run the first audit"** — on
  a project whose first audit is running right now; and
- Panel 7 rows reading **"Not audited yet"** for every repo still deriving.

One click then fires a **second fan-out — five `code_audit` + five `propose_convention` jobs for work
already in flight**. `reaudit()`'s only guard is `if (reauditing) return;`, which is in-memory: the
MOTIR-2123 ONE-POST invariant holds per click and **not across a page leave**. The fan-out is what
makes it expensive; the amnesia is older than the fan-out and is true today at N = 1.

**The rule: an in-flight run is RESUMED on mount, from a durable record, before any trigger renders.**

1. **Persist the run when it is fired.** `reaudit()` already receives
   `ReauditResultDTO { repos: [{ repoKey, auditJobId, conventionJobId }] }`. Write it, keyed by
   project, to `localStorage` — the mechanism this very component already uses for the
   deepen-dismissed flag (`dismissKey(projectId)` + `useSyncExternalStore`), so it is a second use of
   a shipped pattern, not a new one.
2. **Resume it on mount, against the SERVER.** For each stored `auditJobId`, read the shipped,
   session-gated **`GET /api/ai/jobs/[jobId]`** (`{ status, result }`, backed by
   `motirAiClient.getJob`). A `queued` / `running` status restores that repo's **Deriving…** row; a
   terminal status clears the entry and re-reads the audit surface. **No motir-ai change and no new
   core route** — the read already exists and is already reachable from the browser.
3. **The trigger does not render until resumption resolves.** Otherwise the duplicate-POST hole
   simply narrows to the few hundred milliseconds before the first status answers. This is Panel 4b
   State C's _"the action is REMOVED, not disabled"_ rule applied to one more moment: while the run's
   state is unknown, there is no button to press twice.
4. **`localStorage` is per browser, and the design says so rather than implying more.** Returning on
   a DIFFERENT device still shows the pre-audit state — the job is still running and still lands, but
   that browser cannot know it is in flight. The durable fix is a server-side record of the fired run;
   it is not designed here because nothing on the surface needs it and inventing a store is not this
   panel's work. What IS required here is that the copy never over-promises: it says the audit keeps
   running (true everywhere) and never says "we'll show you the progress wherever you are."

> **Ownership.** This is a defect in SHIPPED behaviour — reproducible today with one repo — that the
> fan-out makes five times more expensive, and it is a PREREQUISITE of §5's per-repo deriving state,
> which cannot be built on a source that does not survive a mount. It is therefore **not** absorbed
> into MOTIR-2207 (`notes.html` #27 / #172 — a defect found during a card gets its own card and its
> own PR): it is filed as **MOTIR-2223**, and MOTIR-2207 is `blocked_by` it so the durable signal
> lands before the rows that read it.

#### 6 · The four row states, and the row anatomy (7c)

Left to right: the **octocat** + the repo's `owner/name` in mono (`.coderef` grammar) · then EITHER
the **grade chip** OR an **icon-and-word state** · then the finding count as a neutral `count-pill` ·
then when it was audited.

| Row state           | Marker                                                                   | Trailing                   |
| ------------------- | ------------------------------------------------------------------------ | -------------------------- |
| **audited**         | grade chip — `B · 78% conform`, tint by the SHIPPED tone rule            | count-pill + relative time |
| **deriving**        | `.spin` ring + **Deriving…**                                             | `started 40 seconds ago`   |
| **not audited yet** | lucide `folder-git-2` on `--el-warning` + **Not audited yet**            | `—`                        |
| **unavailable**     | lucide `triangle-alert` on `--el-danger` + **Couldn't load this report** | ghost **Try again**        |

**The fourth state exists because MOTIR-2207's criteria require the behaviour** — _"One repo's audit
read REJECTING degrades that repo only… the page still renders its siblings' reports and does not
fall into the whole-page `loadError`."_ A required behaviour with no drawn state is what the build
improvises; so it is drawn. It inherits `design/repository-set` §15.6's rule that **a failure never
fails the person**: one row goes red, the siblings stay readable, and the roll-up counts what is TRUE.

**Colour is never alone.** The grade chip puts the hue in the TINT with `--el-text-strong` ink and
repeats the grade LETTER and the percentage as text; the three non-graded states carry colour on the
ICON and meaning in the WORD — §15.6's rule, unchanged. **Selection** reuses this asset's existing
current-row highlight (`--el-accent-on-surface` border on `--el-surface-soft`, the pair
`.version.current` and `.tool-rec` already use) **plus a semibold repo name**, so selection is not
colour-only either.

**A11y — rows are sibling buttons, never a listbox.** A row carries a per-row action, and a
`role="listbox"` of `role="option"` rows may not contain interactive children: the shipped
`SavedFilterDropdown` failed the 6.2.6 axe sweep on exactly that (`aria-required-children` critical +
`nested-interactive` serious). So: a `role="group"` wrapper, ONE `<button>` per row whose accessible
name is the repo plus its state, the recovery as a SIBLING button, and the selected row marked
`aria-current`. Contrast: `--el-text-muted` is 4.34:1 on `--el-surface-soft` (below AA), so the
timestamp on the **selected** row steps up to `--el-text-secondary`.

#### 7 · N = 1 — the list is not drawn at all

With exactly one connected repo the list does not render; the tab is exactly what ships today, and
Panel 4b's A–D remain its only pre-audit states. This is a deliberate departure from
`design/repository-set` §15.5's _"design it as a SET whose degenerate case is one"_: there the set
strip still answered a per-repository question (which repo, what permission) at N = 1, whereas this
list's only jobs are **selection** and **comparison**, both vacuous with one row. MOTIR-2207's own
criterion — _"A single-repo project renders exactly as it does today"_ — is the same call, stated
from the other side.

#### 8 · Exact copy — new keys under `codeHealth.audit` (each needs its `zh.json` twin)

| Key                            | Copy                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repos.title`                  | Repositories                                                                                                                                                                                            |
| `repos.connected`              | {count, plural, one {# connected} other {# connected}}                                                                                                                                                  |
| `repos.rollupAudited`          | **{audited} of {total}** audited                                                                                                                                                                        |
| `repos.rollupFindings`         | **{count}** findings across them                                                                                                                                                                        |
| `repos.rollupDeriving`         | {count} deriving                                                                                                                                                                                        |
| `repos.rollupNotAudited`       | {count} not audited yet                                                                                                                                                                                 |
| `repos.grade`                  | {grade} · {pct}% conform                                                                                                                                                                                |
| `repos.findingCount`           | {count, plural, one {# finding} other {# findings}}                                                                                                                                                     |
| `repos.stateDeriving`          | Deriving…                                                                                                                                                                                               |
| `repos.stateNotAudited`        | Not audited yet                                                                                                                                                                                         |
| `repos.stateUnavailable`       | Couldn't load this report                                                                                                                                                                               |
| `repos.retry`                  | Try again                                                                                                                                                                                               |
| `repos.pick`                   | Show the audit for {repoRef}                                                                                                                                                                            |
| `repos.groupLabel`             | Choose a repository's audit report                                                                                                                                                                      |
| `audit.derivingOneTitle`       | Deriving the audit for {repoRef}…                                                                                                                                                                       |
| `audit.derivingOneDescription` | Motir is reading this repository's code graph, deriving its convention, and scoring the code against it. The other repositories are unaffected — pick one above to read its report while this finishes. |

`audit.derivingDuration` ("This usually takes a few minutes…") is REUSED verbatim under E2 — it is
true of one repo exactly as it is of five.

#### 9 · Its relationship to MOTIR-1764 — the coordination point, stated because the asset does not exist

**Verified on `origin/main`, 2026-08-05: MOTIR-1764's asset does NOT exist.** `design/` was listed in
full; there is no `code-context` area, and the only occurrences of "freshness" / "code-context" under
`design/` are prose in `design/repository-set/design-notes.md`, which puts the surface explicitly out
of its own scope (§13: _"The code-context / index-freshness surface, and the code-blind planning
signal — MOTIR-1764… none of it drawn"_) and records, in §14.4, that it _"does not exist yet"_.

So the card's own escape hatch applies, and this is how it is honoured:

- **Nothing here is deferred to MOTIR-1764** (`notes.html` #130 — a design that defers a capability to
  a downstream which does not provide it). Every element MOTIR-2207 needs is drawn in Panel 7, and
  MOTIR-2207 is this panel's **only** consumer — there is no second card, so there is no unwired
  allocation edge (`notes.html` #213).
- **This panel defines the page's per-repo ROW anatomy ONCE** (§6), grounded in the two per-repo
  grammars that already ship — `ConventionPanel`'s per-repo card header (repo name + state Pill +
  trailing action) and `design/repository-set` §15's per-repository line (octocat + mono name + chip +
  icon-and-word state). It is not a rival grammar; it is the same one, on this page.
- **The coordination point.** MOTIR-1764's design pass **reads Panel 7 first and adopts this row
  anatomy**. If index freshness is per repo — and it is — the preferred end state is **ONE list on
  this page with a freshness column added to these rows**, not a second list beside it. In that case
  MOTIR-1764 **amends Panel 7** rather than drawing its own; that amendment is the seam, and it is
  named here so the choice is made deliberately in one place instead of discovered as drift.

---

### Panel 8 — the audit tab's PER-REPO TRIGGERS (MOTIR-2245)

**An AMENDMENT to Panel 7, not a redraw of it.** Panel 7's row anatomy, its four states, its
ordering, its selection model, its rollup and its N = 1 rule all stand exactly as written; this
panel appends ONE element to the row and ONE to the card header. Panel 4b's A–D pre-audit states,
the report panel and the Convention tab are untouched.

**The problem it answers.** MOTIR-2207 made every connected repo's state legible and left every row
**read-only**. `AuditRepoList`'s only per-row action is `onRetry`, which re-**READS** a failed row
and is documented in the shipped component as _"Never a re-audit: the row failed to LOAD, which says
nothing about whether it needs deriving."_ So the page can tell an admin that `motir-meta` has never
been assessed and offers them exactly one way to act on it: a button that re-derives **all five**
repos. Learning about the sixth repo costs six derivations, which is why people leave repos
un-audited instead.

#### 1 · The two controls

| Control                            | Where                                               | Scope                                 | Weight                                                          |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| **Audit this repo** / **Re-audit** | the row's **last** element, after the timestamp     | that repo alone                       | `Button` `variant="secondary"` / `variant="ghost"`, `size="sm"` |
| **Audit the {n} with no report**   | the card **header**, after the `{n} connected` Pill | every repo in the `not_audited` state | `Button` `variant="secondary"` `size="sm"`                      |

Both post MOTIR-2247's scoped `POST /api/ai/coding-convention/refresh` with an explicit `repoKeys`.
No new primitive, no new variant: all of it is the shipped `Button` at `size="sm"`.

#### 2 · Per row state — and the one that gets NO trigger

| Row state       | Trailing action                                              | Why                                                                                                      |
| --------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **audited**     | **Re-audit** (ghost)                                         | the row already has a report; re-deriving is the rarer need, so it must not compete with the row's grade |
| **not_audited** | **Audit this repo** (secondary, bordered)                    | the one thing worth doing on this row — its weight says so without shouting                              |
| **deriving**    | **nothing**                                                  | the work is already happening; a second trigger can only duplicate it                                    |
| **unavailable** | the shipped **Try again** (ghost) — and **NO audit trigger** | ⚠️ see below                                                                                             |

**⚠️ An `unavailable` row gets NO audit trigger, and this is the panel's sharpest decision.** The
read FAILED, so nothing on screen knows whether that repo has a report at all; offering "Audit this
repo" there spends a derivation to fix what may be a display error. **Re-READ first — it is free,
and it tells you which state the row is really in**, after which the row renders its own correct
action. This also disposes of the adjacency hazard the card was filed over rather than merely
mitigating it: the free recovery and the paid trigger are **mutually exclusive per row**, so the two
never sit one pixel apart and a mis-click between them is not possible rather than unlikely.

**A `deriving` row's action is REMOVED, not disabled** — Panel 4b State C's shipped rule
(_"the action is REMOVED, not disabled"_) applied one altitude down. A disabled button invites a
second press and explains nothing; the spinner and the word already say what is happening.

**A11y — the row stays a `role="group"` of sibling buttons.** The trigger is a **sibling** of the
row's select button, exactly as `onRetry` already is, never nested inside it (Panel 7 §6's recorded
constraint: a `role="option"` row may not contain interactive children — the `SavedFilterDropdown`
6.2.6 axe failure). The select button's `aria-current` and its `"<pick> · <state>"` accessible name
are unchanged. **Each trigger carries its OWN accessible name that repeats the repo** —
_"Audit moooon-B-V/motir-meta"_ — because "Audit this repo" alone is meaningless read out of context.

#### 3 · The header control, and its ZERO state

It is labelled with the **count** — _"Audit the 2 with no report"_ — so the button states its own
price before it is pressed; it is the only control on this page that acts on a SET.

**At zero un-audited repos the control is ABSENT, not disabled** — the same rule as the deriving
row. A disabled button whose only meaning is "there is nothing to do" is a control that has to be
explained, and the rollup already says _5 of 5 audited_. Nothing becomes unreachable: per-row
**Re-audit** stays on every row.

#### 4 · The ARRIVAL from the /planning nudge

MOTIR-2246's nudge links here, so this panel owes the first second after that click (drawn as 8a).
**The arrival does NOT re-order the list and adds no deep-link parameter.** Panel 7 §4's order is
worst-first, so an admin arriving from the nudge sees the graded rows before the un-audited ones —
deliberately: the nudge already NAMED the repos it is about, the header control acts on all of them
at once and sits above every row, and re-sorting on arrival would mean the same page shows a
different order depending on how you reached it.

#### 5 · The CONFIRM question, answered

**No confirmation dialog**, and the evidence is on this page rather than in taste. The shipped
whole-project **"Re-audit now"** fires on ONE click with no confirm — and it is the _expensive_
action, deriving every connected repo. Every trigger this panel adds costs strictly LESS than that
button already costs unconfirmed, so gating the cheaper action while the dearer one stays ungated
would teach exactly the wrong lesson about which press is worth pausing over.

What replaces a dialog, all of it already shipped: the row flips to **Deriving…** immediately, so the
press is visibly acknowledged; the trigger is then REMOVED from that row, so it cannot be pressed
twice; and MOTIR-2223's durable in-flight record means even a reload cannot produce a duplicate run.
If a confirm is ever wanted it belongs on the **whole-set** button FIRST — a separate decision about
a control this panel does not touch.

#### 6 · N = 1 — the page is UNCHANGED, and no second affordance is invented

`AuditRepoList` returns `null` at one connected repo (Panel 7 §7 — selection and comparison are both
vacuous with one row), so there is no row to hang a row action on and no header to hang a bulk action
on. **That is not a hole.** `AuditPanel`'s existing primary **"Re-audit now"** ALREADY audits the only
repo, and at N = 1 the whole-set fan-out and a per-repo scope are the same request. The single-repo
page is byte-identical to today's, and the build card must not invent a second affordance for it.

#### 7 · Copy — new keys under `codeHealth.audit.repos` (each needs its `zh.json` twin)

| Key                     | Copy                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `repos.auditOne`        | Audit this repo                                                                      |
| `repos.auditOneLabel`   | Audit {repoRef}                                                                      |
| `repos.reauditOne`      | Re-audit                                                                             |
| `repos.reauditOneLabel` | Re-audit {repoRef}                                                                   |
| `repos.auditUnaudited`  | {count, plural, one {Audit the # with no report} other {Audit the # with no report}} |

#### 8 · What this amendment GIVES and TAKES, by key (`notes.html` #214)

| Card                                 | Gives                                                                                                                                                                                   | Takes               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| **MOTIR-2249** (the build card)      | both controls, their per-state placement, the weight/word rule, the ABSENT-at-zero rule, the accessible-name rule, the arrival behaviour, the confirm decision, and the copy keys in §7 | **YES — see below** |
| **MOTIR-2246** (the nudge design)    | the arrival target: what the nudge's link lands on (8a), so its own asset can describe where it sends people                                                                            | —                   |
| **MOTIR-2247** (the scoped trigger)  | nothing — it ships the server half and is `in_review`; this panel is its first consumer                                                                                                 | —                   |
| MOTIR-2207 / MOTIR-2087 / MOTIR-2206 | nothing — their panels are not redrawn                                                                                                                                                  | —                   |

**The TAKE, applied to MOTIR-2249 in this same pass.** MOTIR-2249's body reads: the row action
_"sits beside — and must stay visually and semantically distinct from — the shipped `onRetry`
recovery."_ §2 above decides that the two are **mutually exclusive per row** — an `unavailable` row
offers only the free re-read — so they never sit beside each other at all. Built as written, the card
would place a paid trigger next to a free recovery in exactly the row state where a user is most
confused, which is the hazard the card itself was filed to avoid. MOTIR-2249's criteria are amended
in this pass to require the opposite: **the `unavailable` row renders its re-read and no audit
trigger**, asserted.

#### 9 · Designed against a RENDER of the shipped surface (`notes.html` #73)

The `AuditRepoList` this amends is SHIPPED, so it was rendered rather than reasoned about: the real
component was dumped through the repo's own vitest + RTL setup across all four row states, and 8a/8b
compose from that output. Two things the render settled that reading the `.tsx` would not have:

- **The rollup carries a FIFTH clause the notes' §6 table never listed** — `rollupUnavailable`
  (_"1 couldn't be loaded"_) renders whenever a read failed. Panel 8's rollups are written against
  the real set of clauses, not the table.
- **The trailing timestamp already occupies the row's last slot** (`—` in the non-audited states), so
  the trigger appends AFTER it rather than replacing it — which is why §2 specifies "the row's last
  element" rather than "the trailing slot".

## Per-element `--el-*` colour role (the token map)

Colour flows through Tier-3 `--el-*` ONLY — no Tier-0 `--color-*`, no invented hue (the
`motir-core/CLAUDE.md` colour rule; mistake #54). Every coloured chip puts the hue in the TINT
background with `--el-text-strong` ink, AA-safe in both themes (finding #35).

| Element                                                           | Token(s)                                                                                                                                                                                         | Note                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Page / card body ink                                              | `--el-text`, `--el-text-strong` (headings/emphasis), `--el-text-secondary` (copy), `--el-text-muted` / `--el-text-faint` (captions/eyebrows)                                                     | via the shipped text-role scale                                                                                                   |
| Card surface + edge                                               | `--el-card` bg, `--el-border` (1px), `--shadow-subtle` on finding rows                                                                                                                           | `Card` primitive                                                                                                                  |
| **Severity — Critical**                                           | `Pill severity="danger"` → `--el-tint-rose` bg + `--el-text-strong`                                                                                                                              | worst                                                                                                                             |
| **Severity — High**                                               | `Pill severity="warning"` → `--el-tint-peach` bg + `--el-text-strong`                                                                                                                            |                                                                                                                                   |
| **Severity — Medium**                                             | `Pill severity="info"` → `--el-tint-sky` bg + `--el-text-strong`                                                                                                                                 |                                                                                                                                   |
| **Severity — Low**                                                | `Pill tone="neutral"` → `--el-chip-bg` + `--el-text-secondary` + `--el-chip-border`                                                                                                              | a quiet chip, not a hue                                                                                                           |
| **Provenance — Adopted**                                          | `Pill severity="success"` → `--el-tint-mint` bg + `--el-text-strong`                                                                                                                             | green = confirmed from your code                                                                                                  |
| **Provenance — Proposed**                                         | `Pill status="planned"` → `--el-tint-lavender` bg + `--el-text-strong`                                                                                                                           | brand-lavender = a proposal to review                                                                                             |
| **Banner — DERIVED FROM YOUR CODE · auto-used**                   | `--el-success-surface` (mint) fill, glyph `--el-success`, ink `--el-text-strong`                                                                                                                 | settled / active                                                                                                                  |
| Health grade tile                                                 | `--el-success-surface` bg + `--el-text-strong`                                                                                                                                                   | a good (B) grade; a poor grade would fall to `--el-warning-surface` / `--el-danger-surface`                                       |
| Category dots                                                     | `--el-success` (ok) · `--el-warning` (watch) · `--el-danger` (gap)                                                                                                                               | redundant text label beside each (not colour-alone)                                                                               |
| File / symbol refs                                                | `.coderef` → `--el-text-identifier` on `--el-code-bg`                                                                                                                                            | mono, matches shipped code-chip                                                                                                   |
| Convention-rule ref (finding cites convention)                    | `.conv-ref` → `--el-callout-text` on `--el-callout-bg` (lavender)                                                                                                                                | lavender = the convention identity (matches the Proposed provenance tone)                                                         |
| Clean-code-baseline ref (convention silent)                       | `.base-ref` → `--el-text-secondary` on `--el-chip-bg` + `--el-chip-border`                                                                                                                       | a quiet neutral tag; the general-health "too"                                                                                     |
| Count / meta chips                                                | `Pill tone="neutral"` → `--el-chip-bg` + `--el-text-secondary` + `--el-chip-border`                                                                                                              |                                                                                                                                   |
| Secondary CTA ("Refine with Motir", "Re-run audit", "View stack") | `Button variant="secondary"` → `--el-button-border` + `--el-text`                                                                                                                                |                                                                                                                                   |
| Ghost CTA ("Cancel", "Save draft", row actions)                   | `Button variant="ghost"` → `--el-text`                                                                                                                                                           |                                                                                                                                   |
| EmptyState icon                                                   | `--el-icon-muted`                                                                                                                                                                                | `EmptyState` primitive                                                                                                            |
| EmptyState description                                            | `--el-text-subtitle`                                                                                                                                                                             | the shipped lead-paragraph role                                                                                                   |
| Current-version highlight                                         | border `--el-accent-on-surface`, bg `--el-surface-soft`                                                                                                                                          | the active standard row                                                                                                           |
| Sidebar rail (Panel 1 shell)                                      | `--el-sidebar-bg` + `--el-sidebar-border`; active row `--el-sidebar-item-bg-active` + `--el-accent-on-surface` glyph; wizard current-step `--el-accent-on-surface`                               | the persistent nav                                                                                                                |
| Top bar (TopNav) + tabs (Segmented)                               | bar `--el-page-bg` + `--el-border` bottom hairline; Plan-with-AI `--el-accent`; tabs track `--el-tabnav-track`, active tab `--el-page-bg` + `--shadow-subtle`, active glyph `--el-tabnav-active` | the shell chrome + in-page view switch                                                                                            |
| **Deepen card** (`.deepen`, secondary aside)                      | bg `--el-surface-soft` (quiet, NOT `--el-card`) + `--el-border`; lead glyph `--el-accent-on-surface`; dismiss × `--el-text-muted`                                                                | reads as an optional aside inside the report, not a report card                                                                   |
| Tool option row (`.tool`)                                         | bg `--el-page-bg` + `--el-border`; icon `--el-text-secondary`                                                                                                                                    | the SonarQube branch                                                                                                              |
| **Recommended** tool (`.tool-rec`, best-fit)                      | border `--el-accent-on-surface` + bg `--el-surface-soft`; icon `--el-accent-on-surface` (reuses the current-version-highlight pattern)                                                           | the GH-native CodeQL default                                                                                                      |
| "Recommended" tag (`.tag-rec`)                                    | `--el-callout-text` on `--el-callout-bg` (lavender = the brand/recommendation identity)                                                                                                          | matches the convention-identity tone                                                                                              |
| Copy-paste setup block (`.setup-code`)                            | `--el-code-text` on `--el-code-bg` + `--el-border`, `--radius-input` editor surface                                                                                                              | the `codeql.yml` guidance                                                                                                         |
| Tier-2 ingested chip (`.tier2-chip`)                              | `--el-callout-text` on `--el-callout-bg` (lavender)                                                                                                                                              | on the audit sub-line, connected/auto-detected                                                                                    |
| Connected banner (`.deepen-done`)                                 | `--el-success-surface` fill, glyph `--el-success`, ink `--el-text-strong`                                                                                                                        | settled/deepened (State C); the re-auditing variant uses `--el-surface-soft` + a `.spin`                                          |
| Re-open link (`.deepen-link`, dismissed)                          | `--el-link`                                                                                                                                                                                      | the quiet one-line re-open (State D)                                                                                              |
| Re-audit spinner (`.spin`)                                        | ring `--el-border-strong`, head `--el-accent-on-surface`                                                                                                                                         | the re-auditing affordance (State B)                                                                                              |
| **Pre-audit repo chips** (`.repo-chips code`, Panel 4b B/C/D)     | `--el-text-identifier` on `--el-code-bg`, `--radius-control`                                                                                                                                     | the shipped `.coderef` code-chip grammar reused — one chip per connected repo                                                     |
| **First-audit ring** (`.es-spin`, Panel 4b C)                     | track `--el-border-strong`, head `--el-accent-on-surface`, `--radius-badge`                                                                                                                      | the `.spin` grammar at icon-slot size; the ONLY deriving signal — never a border-style change                                     |
| **Duration line** (`p.dur`, Panel 4b C)                           | `--el-text-muted`                                                                                                                                                                                | quieter than the `--el-text-subtitle` description above it                                                                        |
| **"Run the first audit"** (Panel 4b B, primary)                   | `Button variant="primary"` → `--el-accent` bg + `--el-accent-text` ink                                                                                                                           | the one generative action on the screen; State A's stays secondary                                                                |
| **Repo row** (`.repo-row`, Panel 7)                               | transparent fill on the `Card`; hairline `--el-border-soft` between rows; `--radius-control` + `--spacing-control-{x,y}` (the shipped list-row shape)                                            | a list row, so it takes the small-affordance shape tokens — not `--radius-card`                                                   |
| **Repo row — SELECTED** (`.repo-row.sel`)                         | border `--el-accent-on-surface`, bg `--el-surface-soft`, name at `font-weight: 700`                                                                                                              | the SAME current-row pair `.version.current` / `.tool-rec` use; the weight keeps it non-colour-only                               |
| **Repo row — timestamp on a selected row** (`.rr-when`)           | `--el-text-secondary` (NOT `--el-text-muted`)                                                                                                                                                    | muted is 4.34:1 on `--el-surface-soft`, below AA — the selected row steps it up                                                   |
| **Repo grade chip** (`.rr-grade`)                                 | `--el-tint-mint` (≥70) · `--el-tint-yellow` (≥40) · `--el-tint-peach` (<40), ink `--el-text-strong`, `--radius-badge` + `--spacing-chip-{x,y}`                                                   | the SHIPPED `HealthSummary` tone rule (`AuditPanel.tsx`'s `pct >= 70 ? 'mint' : pct >= 40 ? 'yellow' : 'peach'`), reused verbatim |
| **Repo row state — not audited yet**                              | icon `--el-warning` (lucide `folder-git-2`), word `--el-text-strong`                                                                                                                             | `design/repository-set` §15.6's icon-and-word vocabulary; never colour alone                                                      |
| **Repo row state — deriving**                                     | the shipped `.spin` ring (track `--el-border-strong`, head `--el-accent-on-surface`) + word `--el-text-strong`                                                                                   | the same ring Panel 4b State C uses, at inline size                                                                               |
| **Repo row state — unavailable**                                  | icon `--el-danger` (lucide `triangle-alert`), word `--el-text-strong`, recovery `Button variant="ghost" size="sm"`                                                                               | one row fails, never the page — §15.6's "a failure never fails the person"                                                        |
| **Roll-up strip** (`.rollup`)                                     | `--el-text-secondary`, the counts in `--el-text-strong`                                                                                                                                          | counts only; there is deliberately no project grade to colour                                                                     |

> **Supersession (MOTIR-2206).** The health-grade-tile row above reads _"`--el-success-surface` bg;
> a poor grade would fall to `--el-warning-surface` / `--el-danger-surface`"_ — design intent that
> shipped differently. `AuditPanel.tsx` picks the SUMMARY's tone with
> `pct >= 70 ? 'mint' : pct >= 40 ? 'yellow' : 'peach'` on the `Card tint`, i.e. the `--el-tint-*`
> scale. **That shipped rule is the one rule**, and Panel 7's grade chip and grade tile both use it,
> so a repo's grade cannot read one hue in the list and another in the report. (Design against
> shipped reality — the tone was verified by RENDERING the component, not by reading this table.)

**Shape** flows through element-semantic shape tokens ONLY (no raw `rounded-*`/`p-*`/`h-*`; the
`motir-core/CLAUDE.md` shape rule): cards `--radius-card` + `--spacing-card-padding`; buttons
`--radius-btn` + `--height-btn-{sm,md}` + `--spacing-btn-x`; pills `--radius-badge` +
`--spacing-chip-{x,y}`; textarea `--radius-input` + `--spacing-input-{x,y}`; modal `--radius-modal`;
code chips `--radius-control`; elevation `--shadow-{subtle,card,modal}`.

## Scale — the mirror's mechanism, per surface (notes.html #58)

A scale decision cites the mirror's ACTUAL mechanism for THIS surface, not a generic "we paginate".
The findings list mirrors **CodeScene CodeHealth**: findings are grouped by category/hotspot and
ranked **worst-first** inside a bounded, grouped structure — never an unbounded flat lint dump. The
render **virtualizes** via the shipped 2.5.15 `useRowWindow` primitive (only viewport rows in the
DOM), and more findings stream in by **cursor** as the list scrolls (the `codeAuditRepository`
findings read is cursor-paginated, 7.14.3). Drawn as a windowed slice + the `.virt-note` annotation.

## Primitives composed (no hand-rolling) — the checklist

Every element maps to a shipped `@motir/design-system` primitive; the mock hand-writes CSS that
reproduces each primitive's shipped classes/tokens (annotated inline). No new design-system entry is
invented in this Story — if one were needed, that is a NEW `design/` subtask, not a code workaround.

- [x] **Card** (`components/ui/Card.tsx`) — every panel container + finding row + version row.
- [x] **Pill** (`components/ui/Pill.tsx`) — severity (info/success/warning/danger), provenance
      (severity="success" Adopted / status="planned" Proposed), and neutral count/meta chips. No
      custom tone invented — all are shipped `Pill` variants.
- [x] **Button** (`components/ui/Button.tsx`) — secondary (Refine with Motir / Re-run audit /
      View stack), ghost (Cancel / row actions); sizes md + sm.
- [x] **EmptyState** (`components/ui/EmptyState.tsx`) — the fresh / no-codebase state (Panel 3), and
      all four pre-audit states in Panel 4b (A/B/C/D), which differ ONLY in their `icon` / `title` /
      `description` / `action` props. The repo chips ride inside `description` (typed `ReactNode`);
      no fifth slot and no new prop are invented.
- [x] **AppLayout shell** (`components/ui/AppLayout.tsx`) — the full-screen composition (Panel 1):
      the 56px full-width **TopNav** above the `[240px rail | scrolling main]` grid, reproduced so the
      surface is drawn as the REAL screen (persistent nav + top bar), not floating cards.
- [x] **TopNav** (`app/(authed)/_components/TopNav.tsx` + `ShellTierNav.tsx`) — the top bar: the
      `Org › Workspace` tier crumb + the right icon cluster (Plan-with-AI, create, search, theme,
      bell, avatar).
- [x] **Sidebar / SidebarNav** (`components/ui/Sidebar.tsx` + `app/(authed)/_components/SidebarNav.tsx`)
      — the persistent rail with the active **Code health** entry (Panel 1's shell); the shipped rail +
      inset active-row grammar on the `--el-sidebar-*` tokens.
- [x] **Segmented** (`components/ui/Segmented.tsx`) — the in-page **Audit / Convention** tabs; the
      raised-track grammar (`--el-tabnav-track` track, active = `--el-page-bg` + `--shadow-subtle`,
      active glyph `--el-tabnav-active`).
- [x] The shipped **page-header** pattern — serif `text-2xl` `<h1>` + leading lucide icon + muted
      subtitle (mirrors `reports/page.tsx`).
- [x] **`useRowWindow`** (`components/ui/useRowWindow.ts`) — the virtualization primitive the
      findings list uses (annotated, not re-implemented in the mock).
- [x] **Deepen affordance composes only shipped primitives** — the `.deepen` card is a `Card` on the
      `data-surface` quiet (`--el-surface-soft`) fill; the tool rows are `Card`s; **Set up CodeQL** /
      **Connect Sonar** / **Re-audit now** are `Button` (primary / secondary / ghost, size sm); the
      dismiss × is a ghost icon `Button` (`--radius-control`); the **Recommended** tag + Tier-2 chip
      are `Pill`-grammar chips on the lavender callout tokens; the `codeql.yml` block is a code
      surface on the shipped `--el-code-*` tokens. **No new design-system entry is invented** — if the
      code subtask (MOTIR-1592) finds it needs one, that is a NEW `design/` subtask, not a workaround.
- [x] **Panel 7's repo list invents NO primitive.** The card is `Card` (header + count `Pill`); each
      row is a flex of shipped parts — the `GithubMark` octocat (`components/icons/GithubMark.tsx`,
      because lucide 1.x ships no brand icons), the `.coderef` mono code-chip grammar for the repo
      name, a `Pill`-grammar tint chip for the grade, the neutral `count-pill` for the finding count,
      the shipped `.spin` ring for deriving, and `Button variant="ghost" size="sm"` for the one
      recovery. Selected uses the existing `.version.current` highlight. If the build finds it needs
      a new design-system entry, that is a NEW `design/` subtask, not a workaround.
- [x] Icons are lucide glyphs (`refresh-cw`, `alert-triangle`, `shield-check`, `check`,
      `file-search`, `sparkles`, `activity`, `layout-dashboard`, `circle-dot`, `columns-3`,
      `bar-chart-3`, `settings`), coloured via `currentColor` from the element token.

## Mirror (rung-1, VERIFIED) — cited, not asserted

- **CodeScene CodeHealth™** — the report is a health SCORE/grade + hotspots (grouped, worst-first),
  NOT a raw lint list. Grounds Panel 1's summary-first shape and the grouped, virtualized findings.
- **CodeRabbit `code-guidelines`** — the propose → review → approve-into-config shape. Grounds the
  Panel 2/3 flow: a generated draft the user curates and approves before it governs anything.
- **The AGENTS.md / CLAUDE.md-generator caveat (ETH Zurich)** — blindly auto-generated agent
  context files _reduced_ task success (~3%) and _raised_ cost (~20%). The MOTIR-1660 response is
  that the convention is DERIVED FROM THE REAL CODE — the grounding in actual repository code IS the
  curation. A non-technical founder cannot meaningfully "approve" a Node-layering rule, so the
  `proposed → standard` human gate is removed; the convention is auto-applied and changed only via
  the universal AI chat ("refine with Motir"). (Fuller citation set lives in the MOTIR-1660 decision
  record.)
- **GitHub code scanning / CodeQL — the SARIF-native, GitHub-integrated default** (Panel 1/6 best-fit).
  For a GitHub repo it is the lightest path: a workflow file, results uploaded as SARIF to the
  code-scanning API Motir already reads (no new account). Grounds why CodeQL is the `.tool-rec`
  Recommended branch, not "install SonarQube by default" (MOTIR-1590 §10.3). **SonarQube / SonarCloud**
  is cited as the ecosystem branch for teams already configured with a `sonar-project.properties`
  (ingested through the same §10.1 SARIF adapter, MOTIR-1574). Both are OPTIONAL — the Tier-1 +
  Opengrep audit always produces a report with nothing connected (§10.2 zero-setup posture).
- **Multi-repository PRESENTATION — re-checked for THIS surface (Panel 7; `notes.html` #33).** A
  scale/presentation decision is a rung-1 fact and rung 1 means the mirror's ACTUAL mechanism for the
  surface in hand, never a generic pattern. Three products, one convergent answer — **rank the
  repositories, drill into one**: **CodeScene** scores Code Health per repository and opens one
  repository's analysis at a time; **SonarQube / SonarCloud** lists projects with a per-project
  rating + quality gate and drills into ONE project's issues, merging issues across projects nowhere
  in the default path; **GitHub code scanning**'s security overview ranks repositories by alert count
  and links into a single repository's alerts. **None of the three publishes an averaged
  portfolio-level quality grade** — which is the cited ground for Panel 7 §2's refusal to draw one,
  not merely an aesthetic preference.

## Designed against a RENDER of the shipped surface (`notes.html` #73)

Panel 7 composes elements that already ship, so the shipped surface was **rendered before anything
was drawn** — not read from the `.tsx` (reading the source is what #73 logs as insufficient). The
real `AuditPanel` and `ConventionPanel` were server-rendered from their own source with the real
`messages/en.json` copy, styled by the project's own Tailwind + `@motir/design-system/theme.css`
build, and screenshotted in Chromium at the 1080 px content width. Three things in this panel come
from that render rather than from the code:

- the **288 px** `HealthSummary` height that kills the stacked-reports alternative (§1);
- the **shipped tone rule** for the grade (`mint / yellow / peach` off `conformancePct`), which
  contradicted this document's own token-map line and superseded it;
- the confirmation that the Convention tab's per-repo card header — repo name + version `Pill` +
  trailing action — is the page's existing per-repo grammar, which Panel 7's row extends instead of
  competing with. (The same render also shows the Convention tab's trailing control rendering as
  `PlanWithAILauncher`'s **"Plan with AI"**, where Panel 2 specifies **"Refine with Motir"** — a
  pre-existing asset/shipped divergence, recorded here so it is not mistaken for Panel 7's doing and
  not silently absorbed by MOTIR-2207. It belongs to whoever next touches Panel 2.)

## Token / a11y rules honoured

- Colour strictly via `--el-*` (incl. `--el-tint-*`); no Tier-0 `--color-*`, no invented hex/rgb/
  named colour, no `color-mix` over a raw hue (mistake #54; the `motir-core/CLAUDE.md` colour rule).
- Shape strictly via element-semantic shape tokens; no raw `rounded-*`/`p-*`/`h-*` for a surface's own
  box (the shape rule).
- Every coloured badge carries the hue in the TINT background with `--el-text-strong` ink → clears
  WCAG AA in both themes (finding #35); severity + category status also carry a redundant text label
  / dot, never colour-alone.
- Dark-theme parity verified by rendering `convention.dark.png` (toggle in the mock header) — every
  `--el-*` re-skins through the `[data-theme='dark']` `--color-*` overrides + the `--el-overlay-scrim`
  dark companion.
