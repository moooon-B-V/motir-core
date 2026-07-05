# Coding convention & code-health — design notes

Design reference for the **coding-convention + code-health audit** surface (Story 7.14 —
"Coding-convention + code-health audit engine"). Produced by the **7.14.1** planning-time design
gate (MOTIR-922); it is the layout source of truth for the UI code subtask **7.14.5** (MOTIR-926 —
the review/approve UI + API), which is `blocked_by` this card.

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

The two artifacts are **linked**, and the direction matters (Yue, 2026-07-03):

- **The `CodingConvention` is the standard for the code Motir GENERATES** — not a linter for existing
  code. It is the house-rules document injected into every dispatched prompt (the productized
  CLAUDE.md). It is **versioned and always EDITABLE**: editing the current standard (or an AI-proposed
  draft) produces the next `proposed` version to approve; the approved `standard` supersedes the prior
  one (kept in history).
- **The `CodeAudit` measures EXISTING code against the approved convention** and reports what is **not
  up to standard** — the conformance gap between the code you have and the standard you want for new
  code. Where the convention is silent, it falls back to a clean-code baseline (so a finding is tagged
  either the convention rule it breaks, or "clean-code baseline"). Before any convention is approved,
  the baseline alone seeds the first proposed convention (adopt-if-clear / propose-if-messy).
- **The trigger:** approving / updating the convention **re-audits** existing code against the new
  standard (alongside the code-change trigger — on-demand / repo webhook). So the audit report is
  always stamped to the convention version it was measured against (`§ Convention vN`).

This is the corrected model the surface draws; it also refines the **7.14.2 decision** (the audit is
measured against the approved convention, not only a standalone clean-code rule set; a convention
update triggers a re-audit) and the **7.14.3 store** (`CodeAudit` gains a `conventionId` /
`conventionVersion` ref; a finding carries an optional `conventionRuleRef`) — the correction is
recorded as a comment on both sibling cards (MOTIR-923 / MOTIR-924) for the builder to fold in.

## The data behind the surface (from 7.14.2 / 7.14.3)

Two artifacts, one motir-ai store (never in motir-core — the open-core boundary):

- **`CodeAudit`** — `healthSummaryJson` (a CodeScene-CodeHealth-style **conformance** score/grade +
  per-category breakdown), `findingsJson` (`[{ rule, category, severity, fileRef, symbolRef, why,
conventionRuleRef? }]`, cursor-paginated), `codeGraphRef`, **`conventionId` / `conventionVersion`**
  (which approved convention the audit was measured against). Runs for migrate (there is code) AND on a
  convention approve/update (re-audit against the new standard).
- **`CodingConvention`** — `status: proposed | standard`, `version` (monotonic), `contentMd` (the
  sectioned document, EDITABLE), `provenanceJson` (per-rule adopted-vs-proposed for the badges),
  `approvedByUserId` / `approvedAt`. Exactly ONE `standard` per project; prior standards retained as
  history. Only a `standard` is injected into 7.6 prompt generation; a `proposed` is never injected.

## Multi-panel board — review EACH panel (mistake #31)

The `.mock.html` is a six-panel board; do not review only the first. Each panel is a `.panel-label`
mono caption + a centred `.panel` wrapper (the `design/ready` convention).

1. **Panel 1 — THE FULL SCREEN, in the real app shell (Audit tab).** The complete Code health page
   as it renders: the full-width **TopNav**, the **persistent left `SidebarNav`** (Code health
   active), and the content region — page header + **Audit / Convention tabs** + the audit content
   (conformance SUMMARY: grade + % conform + six-category breakdown, measured against the approved
   convention; the **"Deepen this audit" affordance** in situ — the non-blocking §10.3 connect-scanner
   card, shown only in the `noExternalScanner` state, between the summary and the findings; then a
   grouped, virtualized findings list where each finding cites the convention rule it breaks, or the
   clean-code baseline). This is the panel that answers "where am I / is the nav there / how do I
   leave".
2. **Panel 2 — Content region · the Convention tab.** The `contentMd` as a sectioned document with a
   header toolbar (Edit / Approve), each rule badged by provenance (Adopted vs Proposed), BOTH status
   banners (PROPOSED and STANDARD).
3. **Panel 3 — Content region · Edit mode.** The editable Markdown (`Textarea`), the **Approve as
   standard** primary action + explainer, and the approve-confirmation dialog (the deliberate human
   gate). Reached by clicking **Edit** on the Convention tab; Cancel returns.
4. **Panel 4 — Content region · Fresh (establish-only) + version states.** The no-codebase
   `EmptyState`, the stack-derived (all-Proposed) proposal, the version-history affordance, the
   "Re-run audit" action.
5. **Panel 5 — The fresh-project door.** The onboarding wizard step (the steady-state door is the
   persistent sidebar entry, drawn in Panel 1's shell).
6. **Panel 6 — The "Deepen this audit" affordance, state by state** (§10.3; MOTIR-1590 + MOTIR-1591).
   The DEFAULT card lives in Panel 1's audit report; this panel zooms its four states: **A** set-up
   guidance (the best-fit CodeQL branch, copy-paste `.github/workflows/codeql.yml` + a "Use SonarQube
   instead" out), **B** connected → re-auditing (the report refreshes — page-state-after-mutation),
   **C** deepened (external findings ingested — the Tier-2 chip on the audit sub-line + the connected
   banner; and the auto-detected variant that shows the same result with NO setup card), **D**
   dismissed (report fully usable, a quiet one-line re-open link remains).

Panels 2–4 are the **content region of the Panel 1 screen** in each state — each carries a `.ctx`
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

### Panel 2 — proposed-convention review

- **Document header toolbar (the edit door)**: a `.card-head` on the convention card — `<h3>`
  "Coding convention" + a version count Pill ("v3 · proposed") + an **"Edit"** secondary `Button`
  (lucide `pencil`) + an **"Approve as standard"** primary `Button`. The **Edit** button is the
  visible affordance to START editing — clicking it opens edit mode (Panel 3). Every convention
  state carries a matching edit door (State B / the standard has "Edit standard"; Panel 3 is the
  entered edit mode). This answers "how do I start editing the convention" — the door is ON the
  document, not just an editor that appears elsewhere.
- **Status banner (State A, PROPOSED)**: `.banner-proposed` on `--el-warning-surface`, lucide
  `alert-triangle`, title "**PROPOSED — review & approve**", sub "This draft is NOT yet used. Nothing
  is injected into prompts until you approve it as the standard. Tweak it first with **Edit** ↑" (the
  banner points at the header Edit button).
- **Status banner (State B, STANDARD)**: `.banner-standard` on `--el-success-surface`, lucide
  `shield-check`, title "**STANDARD — injected into every prompt for NEW code**", sub "The active
  standard governs the code Motir GENERATES… it is not a linter for existing code — the audit measures
  how far existing code is FROM this standard.", trailing count Pill "v2 · standard · approved by Yue".
  Below it: an **"Edit standard"** secondary `Button` (lucide `pencil`) + the note "The standard stays
  editable — **edit it anytime** (Panel 3) to produce the next version. Approving the new version
  supersedes this one (kept in history) AND re-audits your existing code against it." (draws that the
  standard itself is updatable + the re-audit trigger).
- **The document**: `.doc-section` blocks (Layering / Naming / Testing / Error handling), each a
  `<h4>` + rules. Every rule = a provenance `Pill` (Adopted / Proposed) + the rule text (with inline
  `<code>` for identifiers). Provenance legend at the foot: "**Adopted** your code already does this —
  we documented it" / "**Proposed** your code was silent / inconsistent — a clean-code default to
  review".

### Panel 3 — edit + approve

- **This is EDIT MODE (reached via the "Edit" button on Panel 2).** The panel label says so, and the
  editor lead reads "You reached this by clicking **Edit** on the convention — the read-only document
  (Panel 2) swaps to this editable Markdown in place." A ghost **"Cancel"** button in the header
  returns to read mode. (Read ↔ edit is an in-place toggle on the same convention card, not a separate
  screen.)
- **Editor** (`Card`): heading "Edit convention" + a count Pill "**editing v2 (standard) → v3 ·
  proposed**" (shows editing works ON the current standard, not only a fresh proposal); the framing
  "The convention is **always editable** — this is how you update it. Editing the current standard (or
  an AI-proposed draft) produces the next version to approve…" + the ETH-Zurich curate-don't-auto-gen
  explainer; a `Textarea` (label "Convention (Markdown)") holding the `contentMd` with `[adopted]` /
  `[proposed]` provenance tags; helper naming how the tags drive the Panel 2 badges.
- **Approve row**: primary `Button` "**Approve as standard**" (lucide `check`) + ghost `Button` "Save
  draft" + the note "Approving makes this the standard **injected into every prompt** for NEW code,
  supersedes v2 (kept in history), **and re-audits** your existing code against it."
- **Confirmation** (`Modal`, `role="alertdialog"`, drawn OPEN over its `--el-overlay-scrim`): title
  "**Approve as the coding standard?**", body "**v3** becomes the active standard, injected into every
  coding-agent prompt for the NEW code Motir generates." + "Motir will also **re-audit your existing
  code** against v3 and refresh the health report. The current standard **v2** is retained in history…",
  footer ghost "Cancel" + primary "**Approve &amp; re-audit**" (the button names the trigger). This
  communicates the deliberate human gate AND that approval re-audits.

### Panel 4 — fresh (establish-only) + version states

- **No audit** (`EmptyState`, lucide `file-search`): title "**No codebase to analyze yet**",
  description "Your convention is established from your chosen stack — the code-health audit runs
  later, once there's code to read.", action secondary `Button` "View chosen stack".
- **Stack-derived proposal**: a `.banner-proposed` "**PROPOSED — established from your stack**" ·
  "Next.js + Prisma + Postgres defaults. No audit — nothing to adopt yet, so every rule is a
  clean-code default.", then all-**Proposed** rules (no Adopted, because there is no code). Note:
  "Same proposed → approve → standard gate (Panel 3). Only the audit differs (there is none)."
- **Version history** (`Card`): heading "Version history" + a secondary "Re-run audit" `Button`; the
  refresh note names **three triggers** — code changes (on-demand / repo webhook, proposes a new
  version if the code drifts) and convention changes (approving an edited convention re-audits existing
  code against the new standard) — the approved standard retained, never silently overwritten. A
  `.version` list: **v3** "Latest re-audit · Proposed" (Review), **v2** "Active standard · Standard ·
  approved by Yue" (current, View), **v1** "First standard · superseded" (Restore).

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
| **Banner — PROPOSED**                           | `--el-warning-surface` (peach) fill, glyph `--el-warning`, ink `--el-text-strong`                                                                                                                | attention, not yet active                                                                   |
| **Banner — STANDARD**                           | `--el-success-surface` (mint) fill, glyph `--el-success`, ink `--el-text-strong`                                                                                                                 | settled / active                                                                            |
| Health grade tile                               | `--el-success-surface` bg + `--el-text-strong`                                                                                                                                                   | a good (B) grade; a poor grade would fall to `--el-warning-surface` / `--el-danger-surface` |
| Category dots                                   | `--el-success` (ok) · `--el-warning` (watch) · `--el-danger` (gap)                                                                                                                               | redundant text label beside each (not colour-alone)                                         |
| File / symbol refs                              | `.coderef` → `--el-text-identifier` on `--el-code-bg`                                                                                                                                            | mono, matches shipped code-chip                                                             |
| Convention-rule ref (finding cites convention)  | `.conv-ref` → `--el-callout-text` on `--el-callout-bg` (lavender)                                                                                                                                | lavender = the convention identity (matches the Proposed provenance tone)                   |
| Clean-code-baseline ref (convention silent)     | `.base-ref` → `--el-text-secondary` on `--el-chip-bg` + `--el-chip-border`                                                                                                                       | a quiet neutral tag; the general-health "too"                                               |
| Count / meta chips                              | `Pill tone="neutral"` → `--el-chip-bg` + `--el-text-secondary` + `--el-chip-border`                                                                                                              |                                                                                             |
| Primary CTA ("Approve as standard")             | `Button variant="primary"` → `--el-accent` + `--el-accent-text`                                                                                                                                  |                                                                                             |
| Secondary CTA ("Re-run audit", "View stack")    | `Button variant="secondary"` → `--el-button-border` + `--el-text`                                                                                                                                |                                                                                             |
| Ghost CTA ("Cancel", "Save draft", row actions) | `Button variant="ghost"` → `--el-text`                                                                                                                                                           |                                                                                             |
| Textarea                                        | `--el-input-border` + `--el-page-bg` + `--el-text`                                                                                                                                               | `Textarea` primitive                                                                        |
| Modal panel + scrim                             | `--el-page-bg` + `--el-border` + `--shadow-modal`; scrim `--el-overlay-scrim`                                                                                                                    | `Modal` (`role=alertdialog`)                                                                |
| EmptyState icon                                 | `--el-icon-muted`                                                                                                                                                                                | `EmptyState` primitive                                                                      |
| EmptyState / Modal description                  | `--el-text-subtitle`                                                                                                                                                                             | the shipped lead-paragraph role                                                             |
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
- [x] **Button** (`components/ui/Button.tsx`) — primary (Approve as standard), secondary (Re-run
      audit / View stack), ghost (Cancel / Save draft / row actions); sizes md + sm.
- [x] **Modal** (`components/ui/Modal.tsx`) — the approve confirmation, `role="alertdialog"`, over
      `--el-overlay-scrim`, with a ghost + primary `Modal.Footer`.
- [x] **Textarea** (`components/ui/Textarea.tsx`) — the editable Markdown, on the input tokens.
- [x] **EmptyState** (`components/ui/EmptyState.tsx`) — the fresh / no-codebase state (Panel 4).
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
  context files _reduced_ task success (~3%) and _raised_ cost (~20%). This JUSTIFIES the explicit
  **Approve as standard** gate (Panel 3): Motir drafts a first version, but a human curates + approves
  before it enters any prompt — the productized CLAUDE.md is curated, not bloated auto-gen. (Fuller
  citation set — SonarQube, Sourcery "Teaching Sourcery", the "Learning Natural Coding Conventions"
  research — lives in the 7.14.2 decision record.)
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
