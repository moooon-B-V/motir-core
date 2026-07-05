# Import wizard — design notes

**Surface:** the issue-import wizard — connect a source → map fields/values → dry-run
preview → import + progress.
**Card:** MOTIR-937 (7.16.1 Design). **Story:** MOTIR-816 (Issue importer — Jira / Linear /
GitHub / CSV → Motir work items). **Renders in:** MOTIR-942 (7.16.6, the import wizard UI).
**Asset:** `import-wizard.mock.html` (source of truth) + `import-wizard.png` (full-page export) +
this file.

The wizard is a guided, GATED flow: four steps — **Connect · Map · Preview · Import** — where the
**Import step stays locked until the dry-run Preview is reviewed**. Nothing is written to the PM
core until the user confirms the preview.

---

## Grounded in the decision (MOTIR-938) — the flow is not invented

This is a `type: design` card that DRAWS a flow, so per the design-content dependency rule it is
grounded in the sibling **decision card 7.16.2 (MOTIR-938)**, which locks the durable shape the
code cards build. Everything drawn here traces to a decision the card records:

| Decision (MOTIR-938)                                                                                                                                           | Where it shows in this design                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Four sources behind a connector interface (Jira / Linear / GitHub Issues / CSV); a fifth source is a new connector, not a wizard change                        | Panel 1 source picker (4 cards) + the "one shape whichever you pick" copy                                  |
| Live source = OAuth/token + paginated fetch; CSV = uploaded-file parse, no credentials                                                                         | Panel 1 branch A (site URL + token + source project) / branch B (dropzone + id-column)                     |
| Field map: type→kind, status→workflow_status, priority, users-by-email, labels (+ comments/attachments/links/history)                                          | Panel 2 mapping table rows                                                                                 |
| Unmatched value = a user CHOICE, never a silent drop (status → pick/ default, user → leave unassigned / invite)                                                | Panel 2 "unmatched" / "no match" rows with a required select; the "2 values still need a decision" callout |
| Idempotent re-run via an `(source, external_id) → work_item_id` map; re-run = UPSERT, no duplicate CREATE; re-sync source-owned fields, keep Motir-local edits | Panel 5A re-run preview (0 create · 339 update) + "already imported… your Motir-local edits are kept" copy |
| Dry-run shares the SAME engine as the real run (preview = run minus writes)                                                                                    | Panel 3 copy "computed with the exact engine the real import uses"                                         |
| Every persist goes through `workItemsService` (one write authority)                                                                                            | Panel 4 footer "Writing through the normal work-item engine"                                               |

A step the decision does not name is NOT drawn. (If a code card later needs UI the decision didn't
cover, that is a new `design/` subtask, not an improvisation here.)

---

## Verified mirrors (cited per the mirror rule)

- **Plane — Jira import wizard.** connect → map statuses → map priorities → a **Summary** step that
  REVIEWS the mappings with **"Confirm to start the migration"** (and **Back** to adjust), then a
  progress phase. This is the Confirm gate, made visible as our Preview step. `docs.plane.so/importers/jira`
- **Linear — multi-source importer.** Jira / GitHub / Asana / CSV normalised into ONE model,
  mapping title / description / labels / priority / assignee / state / comments — the precedent for
  "one shape whichever source." `github.com/linear/linear/tree/master/packages/import`
- **Atlassian — CSV importer external-issue-id skip.** "already exists as PROJ-1, not importing" —
  the idempotency our dry-run surfaces as UPDATE-not-duplicate on a re-run.
  `jira.atlassian.com/browse/JRASERVER-64477`

---

## Access path (draw the door, not just the room)

The wizard is reached from two shipped affordances — named so MOTIR-942 wires the entry, not just
the screen:

1. **Onboarding entrance** — the secondary **"I have an existing project — import it"** row
   (`design/onboarding-entrance/onboarding-entrance.mock.html`, panel 1). Its "bring over existing
   work items from Jira, Linear or Plane" copy lands here.
2. **Settings › Project › Import** — the in-app entry for an existing project (a member importing
   into an already-created project). The wizard chrome title reads "Import work items · into
   <project>" for that path.

Rendered as a centred wizard panel over a dimmed app shell — the routed-Modal pattern
(`components/ui/Modal.tsx`), like the onboarding flow.

---

## Primitives composed (no hand-rolling) — the checklist

Every surface is a NEW ARRANGEMENT of shipped primitives; the mock invents no new design-system
entry.

- **Card** (`components/ui/Card.tsx`) — the wizard panel, the source cards, the mapping table
  container, the summary tiles, the per-issue list container, the progress card.
- **Button** (`components/ui/Button.tsx`) — primary (Next / Confirm & import / View backlog / Retry),
  ghost (Back / Cancel), outline (Edit connection / Download report / Stop), danger-tinted is
  available for a destructive action (finding #35 shape: hue in the tint bg + strong text).
- **Pill** (`components/ui/Pill.tsx`) — the CREATE / UPDATE / SKIP / Failed action chips, the
  unmatched / no-match / status→default warning chips, the label chips, the "Authorized" chip.
- **IssueTypeIcon** (`components/issues/IssueTypeIcon.tsx`) — the kind hue on the mapping targets and
  the per-issue rows (`--el-type-{epic,story,task,bug,subtask}`), never grey.
- **FormField + Input** (`components/ui/FormField.tsx`, `Input.tsx`) — the site URL, token, id-column,
  and every labelled control (label + control + hint).
- **Combobox / select trigger** (`components/ui/Combobox.tsx`) — the source-project picker and every
  mapping-target select (status / priority / user / id-column).
- **Segmented** is available for the source-branch toggle where the UI needs it
  (`components/ui/Segmented.tsx`); here the two branches are shown side by side for the mock.
- **Spinner** (`components/ui/Spinner.tsx`) — the in-flight import indicator.
- **EmptyState** (`components/ui/EmptyState.tsx`) — the done/complete state, the "no issues found"
  state, the connect-failed state (icon + heading + body + actions).
- **ErrorState / callout** (`components/ui/ErrorState.tsx`) — the CSV-parse-error, the connect-failed
  and partial-failure notices, the info/gate/warn callouts.
- **Toast** (`components/ui/Toast.tsx`) — for the post-import "Imported N issues" confirmation on the
  destination `/issues` surface (referenced, not drawn as a panel).
- **Progress bar** — a thin composed bar (`--el-muted` track, `--el-accent` fill, `--el-success` on
  complete); if reused elsewhere it becomes a `components/ui/Progress` primitive (per-component growth,
  not a wizard-local hack).

Shape: every surface's radius / padding / height uses the element-semantic shape tokens
(`--radius-card` / `-input` / `-badge` / `-control`, `--spacing-*`, `--height-*`, `--shadow-*`) — no
raw `rounded-*` / `p-*` / `h-*`. Colour: only `--el-*` (incl. `--el-tint-*` and `--el-type-*`); the
token block is copied 1:1 from `app/globals.css` (Tier-0 → Tier-3 wiring), no invented hue.

---

## Panels + copy + per-element `--el-*` role

### Panel 0 — wizard chrome + step rail

- **Step rail** — four steps with connectors. States and their colour roles:
  - **done** — `--el-success` filled dot + check glyph, `--el-text-strong` label, connector line
    `--el-success`.
  - **current** — `--el-accent` filled dot with a `color-mix(--el-accent 18%)` focus halo,
    `--el-text` label.
  - **locked** — dashed `--el-border-strong` dot (a lock glyph on the Import step), `--el-text-faint`
    label. The **Import** step is drawn locked with sub-label "locked until preview".
- **Gate callout** (`--el-tint-lavender` bg, `--el-accent` icon): "**The Import step stays locked
  until the dry-run Preview is reviewed.** Every import is previewed before it writes — you always
  see exactly what will be created, updated, or skipped, then click Confirm. Back is available at
  every step to revise a mapping."
- **Footer** — ghost **Back** (left), a `--el-text-muted` "Step N of 4" note, primary **Next**
  (right).

### Panel 1 — Connect the source (step 1)

- Heading **"Where are your issues coming from?"**; body names the one-shape normalisation.
- **Source cards** — Jira / Linear / GitHub Issues / CSV, each a glyph in a distinct `--el-tint-*`
  slot (sky / lavender / mint / peach — tint slots kept mutually distinct, never invented hues),
  name, and a one-line meta ("Cloud · REST API", "API key", "OAuth · owner/repo", "Upload · no
  credentials"). Selected card: `--el-accent` border + halo + a check badge (`--el-accent` fill,
  `--el-accent-text` glyph).
- **Branch A (live source):** site URL (mono input), API token (masked, an "Authorized"
  `--el-tint-mint` pill + `--el-success` dot), hint "Stored encrypted, used only for this import."
  - "How to create a token ↗" link (`--el-link`), source-project combobox.
- **Branch B (CSV):** dropzone (dashed `--el-border-strong`, `--el-surface-soft`) "Drop a .csv file,
  or click to browse" / "One row per issue · UTF-8 · up to 10 MB"; uploaded file-row with a
  `--el-success` file icon; **"Which column is the issue ID?"** combobox with hint "Used to skip
  re-imports and update instead of duplicating on a re-run." (the idempotency seam, surfaced at
  connect time for CSV).
- **Confirmation callout** (`--el-tint-sky` info): "**Source reachable — 342 issues found** in PAY.
  Motir will page through them; nothing is fetched all at once." (pagination made visible).

### Panel 2 — Field mapping (step 2)

- Heading **"Map source fields to Motir"**; body: "Motir proposed a mapping from what it found.
  Review each row — edit any control, and resolve the unmatched values … before continuing.
  Unmatched values are never dropped silently."
- **Mapping table** — one row per source field: source name + sample values (mono, `--el-text-muted`)
  → an arrow → the Motir-side control(s):
  - **Issue type → kind** — value lines with the **IssueTypeIcon** hue (Story `--el-type-story`,
    Subtask `--el-type-subtask`); an `auto` tag (`--el-text-tertiary`, mono).
  - **Status → workflow_status** — a matched line + an **unmatched** line: source value carries an
    `unmatched` warn pill (`--el-tint-peach`), the target select is warn-styled (`--el-tint-peach`
    bg, `--el-warning` border) reading "Choose a status…" — a required decision, never a drop.
  - **Priority** — mapped to Motir's scale; an `edited` tag (`--el-accent`) marks a user override
    vs the `auto` proposal.
  - **Assignee & reporter** — matched-by-email line (a member Avatar + name in an `--el-tint-mint`
    pill, `matched` tag) + a **no-match** line ("rob@acme.com" + `no match` warn pill) whose select
    offers **"Leave unassigned"** (the invite/leave choice; never silent).
  - **Labels** — source label chips → "Create as Motir labels" (`auto`).
- **Unresolved callout** (`--el-tint-peach` warn): "**2 values still need a decision** — 1 unmatched
  status, 1 unmatched user. Resolve them to continue; comments, attachments and issue links carry
  over automatically where the source provides them."
- **Footer** — the primary **Next: Preview** is **disabled** (`--el-muted` fill, `--el-text-faint`)
  with a "2 unresolved" note, until every unmatched value is resolved.

### Panel 3 — Dry-run PREVIEW (step 3 · ★ the gate)

- Chrome sub-title "**· dry run — nothing written yet**". Heading **"Review what will be imported"**;
  body: "This is a dry run computed with the exact engine the real import uses — the preview is the
  run minus the writes."
- **Summary tiles** — three tiles with their tone:
  - **To create** — `--el-tint-mint` bg, `--el-success` dot: "318 · new work items".
  - **To update** — `--el-tint-sky` bg, `--el-info` dot: "21 · already imported before".
  - **To skip** — `--el-surface` bg, `--el-text-faint` dot: "3 · unchanged / no id".
    Numbers in `--el-text-strong`, serif.
- **Warnings callout** (`--el-tint-peach` warn): "**7 warnings** — 4 issues have a status you left at
  the default, 3 reference a user who will be left unassigned. They will still import. Review
  warnings" (link `--el-link`).
- **Per-issue plan** — a real-scale table (source id · title+IssueTypeIcon · mapping · action pill)
  with a **paginated footer**: "Showing 1–25 of 342" + a pager (page 1 active in `--el-accent`).
  This is deliberately NOT an all-rows dump — the list is windowed/paginated (the no-shortcuts +
  virtualization rule). Rows show CREATE / UPDATE / SKIP pills and a `status → default` warn pill on
  a defaulted issue.
- **Gate callout** (`--el-tint-lavender`, `--el-accent` shield-check): "**Nothing has been written to
  Motir yet.** The import runs only when you click Confirm — until then this project is untouched,
  and you can go Back to change any mapping."
- **Footer** — ghost **Back to mapping** + primary **"Confirm & import 339 issues"** (create+update
  count; skips excluded).

### Panel 4 — Import RUN + progress (step 4)

- **In-flight** — chrome "Importing… · do not close this tab". Progress card: a **Spinner** + "Importing
  issues from Jira PAY…", a `198 / 339` count, a **progress bar** (`--el-accent` fill on `--el-muted`
  track). A **`role="status" aria-live="polite"`** counts row — "**184** created · **14** updated ·
  **0** failed · ~40s remaining" — so the advancing counts are announced. A **live log** streams the
  most recent per-issue results (Created `--el-success` / Updated `--el-info` verbs + mono source id).
  Footer: outline "Stop after current batch" + a "Writing through the normal work-item engine — safe
  to leave running" note.
- **Complete** — chrome "Import complete". An **EmptyState.ok** (`--el-tint-mint` circle,
  `--el-success` check): "**Imported 339 issues into Payments Platform**" / "325 created, 14 updated,
  3 skipped. Comments, labels and issue links came across; 3 users had no Motir match and were left
  unassigned." Actions: primary **"View imported backlog →"** (to `/issues`) + outline "Download
  report (CSV)".

### Panel 5 — re-run / empty / error states

- **A · Idempotent re-run** (the ★ idempotency, visible) — the same import run again: summary tiles
  read **0 to create** (dimmed) · **339 to update** · **0 to skip**. Info callout (`--el-tint-sky`,
  refresh icon): "**Every issue is already imported — they'll be updated, not duplicated.** Motir
  matches each source ID to the work item it created last time and re-syncs source-owned fields; your
  Motir-local edits are kept." Rows show the external id → the existing `MOTIR-2231` target + an
  UPDATE pill (no duplicate CREATE).
- **B · Connect failed** — an EmptyState with a `--el-tint-rose` / `--el-danger` icon: "Couldn't reach
  Jira" / "The token was rejected (401). Check the site URL and that the token has read access to PAY,
  then try again." Actions: outline "Edit connection" + primary "Retry".
- **C · CSV parse error** — a danger callout (`--el-tint-rose`): "**Couldn't read acme-backlog.csv** —
  row 47 has 11 columns but the header has 14. Fix the row or re-export, then upload again." + a warn
  callout for a missing id-column selection; action "Choose another file".
- **D · Partial failure** — a warn callout: "**Imported 336 of 339 — 3 issues failed.** The rest came
  through. Failed issues weren't partially written; re-run to retry only the 3." + a table of failed
  rows (Failed `--el-danger` pill) with reasons ("Parent PAY-9999 not found", "Title exceeds 512
  chars"). Actions: outline "Download error report" + primary "Retry 3 failed".
- **E · Nothing to import** — an EmptyState: "No issues found" / "The selected Jira project has no
  issues matching the import scope. Pick a different project or adjust the filter." + "Change source".

---

## Notes on token / a11y discipline

- **AA contrast** — every coloured chip/tile puts the hue in the tint BACKGROUND with
  `--el-text-strong` text (finding #35); the page/panel surfaces stay untinted (`--el-page-bg` /
  `--el-surface`).
- **Not grey + primary** — issue-type hues (`--el-type-*`), the create/update tints
  (`--el-tint-mint` / `--el-tint-sky`), warn/danger tints (`--el-tint-peach` / `--el-tint-rose`), and
  the lavender gate tint carry meaning across the wizard (finding #54).
- **Dark parity** — the token block flips under `[data-theme='dark']`; toggle in the mock to confirm.
- **aria-live** — the import progress counts sit in a `role="status" aria-live="polite"` region so
  screen readers hear the advancing totals; the streaming log is `aria-hidden` (decorative echo of the
  same counts).
