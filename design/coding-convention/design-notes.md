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

Built from the real design system: the mock inlines the token layer from
`packages/design-system/theme.css` (the `@theme` Tier-0 `--color-*`/shape scale, the Tier-3
`--el-*` element layer, the `[data-theme='dark']` overrides) and composes the SHIPPED
`@motir/design-system` primitives — no new vocabulary is invented in this Story.

| Surface                                                       | Asset                                                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Coding-convention review / approve (all states + access path) | `convention.mock.html` (source of truth) · `convention.png` (light export) · `convention.dark.png` (dark-parity export) |

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

The `.mock.html` is a five-panel board (amended from six — the edit/approve panel removed per
MOTIR-1660); do not review only the first. Each panel is a `.panel-label` mono caption + a centred
`.panel` wrapper (the `design/ready` convention).

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
4. **Panel 4 — The fresh-project door.** The onboarding wizard step (the steady-state door is the
   persistent sidebar entry, drawn in Panel 1's shell).
5. **Panel 5 — The "Deepen this audit" affordance, state by state** (§10.3; MOTIR-1590 + MOTIR-1591).
   The DEFAULT card lives in Panel 1's audit report; this panel zooms its four states unchanged.

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

---

## Per-element `--el-*` colour role (the token map)

Colour flows through Tier-3 `--el-*` ONLY — no Tier-0 `--color-*`, no invented hue (the
`motir-core/CLAUDE.md` colour rule; mistake #54). Every coloured chip puts the hue in the TINT
background with `--el-text-strong` ink, AA-safe in both themes (finding #35).

| Element                                         | Token(s)                                                                                                                                                                                         | Note                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Page / card body ink                            | `--el-text`, `--el-text-strong` (headings/emphasis), `--el-text-secondary` (copy), `--el-text-muted` / `--el-text-faint` (captions/eyebrows)                                                     | via the shipped text-role scale                                                             |
| Card surface + edge                             | `--el-card` bg, `--el-border` (1px), `--shadow-subtle` on finding rows                                                                                                                           | `Card` primitive                                                                            |
| **Severity — Critical**                         | `Pill severity="danger"` → `--el-tint-rose` bg + `--el-text-strong`                                                                                                                              | worst                                                                                       |
| **Severity — High**                             | `Pill severity="warning"` → `--el-tint-peach` bg + `--el-text-strong`                                                                                                                            |                                                                                             |
| **Severity — Medium**                           | `Pill severity="info"` → `--el-tint-sky` bg + `--el-text-strong`                                                                                                                                 |                                                                                             |
| **Severity — Low**                              | `Pill tone="neutral"` → `--el-chip-bg` + `--el-text-secondary` + `--el-chip-border`                                                                                                              | a quiet chip, not a hue                                                                     |
| **Provenance — Adopted**                        | `Pill severity="success"` → `--el-tint-mint` bg + `--el-text-strong`                                                                                                                             | green = confirmed from your code                                                            |
| **Provenance — Proposed**                       | `Pill status="planned"` → `--el-tint-lavender` bg + `--el-text-strong`                                                                                                                           | brand-lavender = a proposal to review                                                       |
| **Banner — DERIVED FROM YOUR CODE · auto-used**   | `--el-success-surface` (mint) fill, glyph `--el-success`, ink `--el-text-strong`                                                                                                                 | settled / active                                                                            |
| Health grade tile                               | `--el-success-surface` bg + `--el-text-strong`                                                                                                                                                   | a good (B) grade; a poor grade would fall to `--el-warning-surface` / `--el-danger-surface` |
| Category dots                                   | `--el-success` (ok) · `--el-warning` (watch) · `--el-danger` (gap)                                                                                                                               | redundant text label beside each (not colour-alone)                                         |
| File / symbol refs                              | `.coderef` → `--el-text-identifier` on `--el-code-bg`                                                                                                                                            | mono, matches shipped code-chip                                                             |
| Convention-rule ref (finding cites convention)  | `.conv-ref` → `--el-callout-text` on `--el-callout-bg` (lavender)                                                                                                                                | lavender = the convention identity (matches the Proposed provenance tone)                   |
| Clean-code-baseline ref (convention silent)     | `.base-ref` → `--el-text-secondary` on `--el-chip-bg` + `--el-chip-border`                                                                                                                       | a quiet neutral tag; the general-health "too"                                               |
| Count / meta chips                              | `Pill tone="neutral"` → `--el-chip-bg` + `--el-text-secondary` + `--el-chip-border`                                                                                                              |                                                                                             |
| Secondary CTA ("Refine with Motir", "Re-run audit", "View stack")    | `Button variant="secondary"` → `--el-button-border` + `--el-text`                                                                                                                                |                                                                                             |
| Ghost CTA ("Cancel", "Save draft", row actions) | `Button variant="ghost"` → `--el-text`                                                                                                                                                           |                                                                                             |
| EmptyState icon                                 | `--el-icon-muted`                                                                                                                                                                                | `EmptyState` primitive                                                                      |
| EmptyState description                          | `--el-text-subtitle`                                                                                                                                                                             | the shipped lead-paragraph role                                                             |
| Current-version highlight                       | border `--el-accent-on-surface`, bg `--el-surface-soft`                                                                                                                                          | the active standard row                                                                     |
| Sidebar rail (Panel 1 shell)                    | `--el-sidebar-bg` + `--el-sidebar-border`; active row `--el-sidebar-item-bg-active` + `--el-accent-on-surface` glyph; wizard current-step `--el-accent-on-surface`                               | the persistent nav                                                                          |
| Top bar (TopNav) + tabs (Segmented)             | bar `--el-page-bg` + `--el-border` bottom hairline; Plan-with-AI `--el-accent`; tabs track `--el-tabnav-track`, active tab `--el-page-bg` + `--shadow-subtle`, active glyph `--el-tabnav-active` | the shell chrome + in-page view switch                                                      |
| **Deepen card** (`.deepen`, secondary aside)    | bg `--el-surface-soft` (quiet, NOT `--el-card`) + `--el-border`; lead glyph `--el-accent-on-surface`; dismiss × `--el-text-muted`                                                                | reads as an optional aside inside the report, not a report card                             |
| Tool option row (`.tool`)                       | bg `--el-page-bg` + `--el-border`; icon `--el-text-secondary`                                                                                                                                    | the SonarQube branch                                                                        |
| **Recommended** tool (`.tool-rec`, best-fit)    | border `--el-accent-on-surface` + bg `--el-surface-soft`; icon `--el-accent-on-surface` (reuses the current-version-highlight pattern)                                                           | the GH-native CodeQL default                                                                |
| "Recommended" tag (`.tag-rec`)                  | `--el-callout-text` on `--el-callout-bg` (lavender = the brand/recommendation identity)                                                                                                          | matches the convention-identity tone                                                        |
| Copy-paste setup block (`.setup-code`)          | `--el-code-text` on `--el-code-bg` + `--el-border`, `--radius-input` editor surface                                                                                                              | the `codeql.yml` guidance                                                                   |
| Tier-2 ingested chip (`.tier2-chip`)            | `--el-callout-text` on `--el-callout-bg` (lavender)                                                                                                                                              | on the audit sub-line, connected/auto-detected                                              |
| Connected banner (`.deepen-done`)               | `--el-success-surface` fill, glyph `--el-success`, ink `--el-text-strong`                                                                                                                        | settled/deepened (State C); the re-auditing variant uses `--el-surface-soft` + a `.spin`    |
| Re-open link (`.deepen-link`, dismissed)        | `--el-link`                                                                                                                                                                                      | the quiet one-line re-open (State D)                                                        |
| Re-audit spinner (`.spin`)                      | ring `--el-border-strong`, head `--el-accent-on-surface`                                                                                                                                         | the re-auditing affordance (State B)                                                        |

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
- [x] **EmptyState** (`components/ui/EmptyState.tsx`) — the fresh / no-codebase state (Panel 3).
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
