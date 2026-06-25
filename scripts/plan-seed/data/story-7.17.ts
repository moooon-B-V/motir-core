import type { SeedStory } from '../types';

/**
 * Story 7.17 — Issue importer (Jira / Linear / GitHub Issues / CSV → Motir
 * work items). The first of Epic 7's two genuinely-new CAPABILITIES the six
 * workflows compose (the other is Epic 9's hosted execution layer): a guided,
 * multi-step IMPORT WIZARD that pulls a backlog out of an existing issue
 * tracker — or a CSV export — and lands it in the Motir PM core as real work
 * items, mapped through the SHIPPED `workItemsService`. It is the capability
 * that WF3 (BYOK + code + import = 7.18) and WF6 (hosted + code + import =
 * 9.6) sequence; those workflow stories are thin orchestration over THIS
 * implementation.
 *
 * **What 7.17 is — a real importer, not an orchestration shell.** Unlike the
 * onboarding wizards (7.15/7.16) that orchestrate AI pieces other stories own,
 * 7.17 BUILDS the importer end to end: the `Import` model + the external-id map
 * (7.17.3), the per-source connectors (7.17.4), the mapping + persist engine
 * with its dry-run preview (7.17.5), and the wizard UI (7.17.6). The one thing
 * it does NOT re-implement is the work-item write authority: every imported
 * issue becomes a Motir work item through the Epic-2 `workItemsService` (kind /
 * workflow_status / priority / assignees / labels / comments / attachments /
 * links / parent / history), so all the 6.4 permissions + the 404-not-403
 * tenant guard + the validation that guards every native create apply
 * unchanged to imported rows. The importer is a PRODUCER of work-item writes,
 * not a second write path around them.
 *
 * **The three load-bearing properties (the mirror's shape, verified below):**
 *
 *   1. **A multi-step wizard with a REVIEW/CONFIRM-before-write gate.** Connect
 *      the source → MAP fields (issue-type → kind, status → workflow_status,
 *      priority, users, labels) → **DRY-RUN PREVIEW** (what will be created /
 *      skipped / re-used, with the mapping resolved) → only then RUN the import
 *      + show progress. Nothing is written to the PM core until the user
 *      confirms the preview. This is exactly Plane's Jira-import wizard
 *      (connect → map statuses → map priorities → a **Summary** step where you
 *      review and click **Confirm to start the migration**, with **Back** to
 *      adjust) — verified this session at docs.plane.so/importers/jira.
 *
 *   2. **IDEMPOTENT re-run via an external-id MAP — no duplicates.** Every
 *      imported issue carries its source's stable id (Jira `PROJ-123` / Linear
 *      identifier / GitHub `owner/repo#42` / a CSV id column); the importer
 *      persists an `external_id → work_item_id` mapping per import source, and a
 *      re-run UPDATES the already-mapped work item instead of creating a second
 *      one. This is precisely Atlassian's OWN CSV importer behaviour: it creates
 *      an "External issue ID" field tracking each issue's original id, and on a
 *      re-import an issue whose external id already exists is SKIPPED
 *      ("External issue 1 already exists as PROJ-1, not importing") — verified
 *      this session (jira.atlassian.com/browse/JRASERVER-64477 +
 *      support.atlassian.com CSV-skip KB). Motir adopts the durable shape (an
 *      explicit mapping table, re-run = upsert) rather than Jira's
 *      per-project-custom-field accident.
 *
 *   3. **A common mapping across heterogeneous sources.** Jira, Linear, GitHub
 *      Issues, and CSV expose different field vocabularies; the importer
 *      normalises each into ONE intermediate issue shape, then maps that shape
 *      onto the Motir grammar with user-confirmed field mappings. Linear's own
 *      importer (Jira/GitHub/Asana/CSV → one normalised model mapping
 *      title/description/labels/priority/assignee/state/comments) is the
 *      verified multi-source precedent (github.com/linear/linear/tree/master/
 *      packages/import).
 *
 * **Sources (locked, the workflows brief).** Jira, Linear, GitHub Issues, CSV.
 * Jira/Linear/GitHub are live REST connectors (OAuth/token, paginated); CSV is
 * an uploaded-file parse (the universal fallback — any tracker that exports CSV
 * imports through it). The connector layer (7.17.4) is an interface with four
 * implementations so a fifth source is a new connector, not a new wizard.
 *
 * **Design gate fires (AREA `design/import/`).** The wizard is a real
 * user-facing multi-step surface, so 7.17.1 produces the design asset FIRST
 * (connect → mapping → dry-run preview → run/progress, every step a panel), and
 * the UI code subtask (7.17.6) depends on it and is `blocked` until it lands.
 *
 * **Provisioning is real work (the manual subtask, mirror 1.6.7).** The live
 * connectors need source-side credentials — Jira/Linear/GitHub OAuth apps or
 * API tokens — that a human registers in those dashboards; 7.17.7 captures that
 * as a `manual` subtask (no PR, "done on user confirm"), not a code finding.
 *
 * **Cross-story dep audit (notes.html #32): PASSES — NO forward-pointing dep.**
 * Every `dependsOn` id's story number is ≤ 7.17: same-story 7.17.x only, plus
 * the already-SHIPPED Epic-2 `workItemsService` (the persist authority, an
 * implicit done dependency the cards name in prose, not as a forward id). There
 * is NO dep on any AI story (7.1–7.16): the importer is a pure PM-core
 * capability that does not call motir-ai — it is the BACKLOG source the
 * code-aware planning (7.18/9.6) later reconciles, but it stands alone.
 * Status rule: the two `dependsOn: []` cards (7.17.1 design, 7.17.2 decision)
 * are `planned`; every card chained behind a not-yet-done 7.17.x id is
 * `blocked`.
 */
export const story_7_17: SeedStory = {
  id: '7.17',
  title: 'Issue importer (Jira / Linear / GitHub / CSV → Motir work items)',
  status: 'planned',
  gitBranch: 'feat/PROD-7.17-issue-importer',
  descriptionMd:
    'The **issue importer**: a guided, multi-step wizard that pulls an ' +
    'existing backlog out of **Jira, Linear, GitHub Issues, or a CSV export** ' +
    'and lands it in the Motir PM core as real work items — mapped through the ' +
    'shipped `workItemsService`, so imported issues are first-class Motir work ' +
    'items (kind / workflow_status / priority / assignees / labels / comments ' +
    '/ attachments / links / parent / history) under the same permissions, ' +
    'tenant guard, and validation as natively-created ones. This is one of ' +
    "Epic 7's two new CAPABILITIES the six workflows compose: WF3 (7.18) and " +
    'WF6 (9.6) sequence this importer; those stories are thin orchestration ' +
    'over the implementation here.\n\n' +
    '**The three properties this story exists to deliver (the verified mirror ' +
    'shape — see the module header for the citations):**\n\n' +
    '1. **A multi-step wizard with a review/confirm-before-write gate.** ' +
    'Connect the source → MAP fields (issue-type → kind, status → ' +
    'workflow_status, priority, users, labels) → a **DRY-RUN PREVIEW** of ' +
    'exactly what will be created / updated / skipped → only on CONFIRM does ' +
    'the import run + stream progress. Nothing is written until the preview is ' +
    "confirmed (Plane's Jira-import Summary→Confirm gate).\n" +
    '2. **Idempotent re-run via an external-id MAP.** Each imported issue ' +
    "carries its source's stable id; the importer persists an " +
    '`external_id → work_item_id` mapping per source, so a RE-RUN updates the ' +
    "already-mapped work item instead of duplicating it (Atlassian's own " +
    '"external issue id already exists, not importing" skip behaviour, adopted ' +
    'as an explicit mapping table).\n' +
    '3. **One mapping across heterogeneous sources.** Each connector ' +
    'normalises its source into ONE intermediate issue shape; the mapping + ' +
    'persist engine maps that onto the Motir grammar once ' +
    "(Linear's multi-source-into-one-model importer shape).\n\n" +
    '**Scope:** the import-wizard design asset (7.17.1); the sources + mapping ' +
    '+ idempotency DECISION (7.17.2); the `Import` model + the external-id map ' +
    '+ migration (7.17.3); the per-source connectors — Jira/Linear/GitHub REST ' +
    '(paginated) + CSV parse (7.17.4); the mapping + PERSIST engine via ' +
    '`workItemsService` with the dry-run preview (7.17.5); the wizard UI ' +
    '(7.17.6); the source-credential PROVISIONING manual subtask (7.17.7); the ' +
    'mapping/idempotency/dry-run vitest (7.17.8); and the import-a-Jira-export ' +
    '+ a-CSV E2E (7.17.9).\n\n' +
    '**Out of scope (named so they land where they belong, not here):** the ' +
    'WF3/WF6 ORCHESTRATION that sequences this importer with codebase ' +
    'onboarding + reconciles the imported backlog against the code graph (7.18 ' +
    '/ 9.6 — they consume 7.17.5); any AI/planning over the imported backlog ' +
    '(Epic-7 planning stories — the importer writes plain PM-core rows, the ' +
    'planner reads them later); and a hosted-only import variant (none — the ' +
    'importer is the SAME capability under BYOK and hosted).',
  verificationRecipeMd:
    '- Pull the Story branch; bring up motir-core on `:3000` against the dev ' +
    'Postgres (`localhost:5433`). For the live connectors, have the source ' +
    'credentials provisioned (7.17.7) — or use the recorded connector ' +
    'fixtures the tests ship; the CSV path needs no credentials.\n' +
    '- **The wizard, end to end (the story).** Sign in as `zhuyue@motir.co`; ' +
    'open **Import** for a project. Step through the wizard:\n' +
    '  1. **Connect** — pick a source (Jira / Linear / GitHub / CSV); for the ' +
    'live sources authorize / paste a token + select the source project/repo, ' +
    'for CSV upload the export file. The wizard advances when the source is ' +
    'reachable + issues are enumerable.\n' +
    '  2. **Map** — the wizard shows the discovered source fields and proposes ' +
    'mappings (issue-type → kind, status → workflow_status, priority, users by ' +
    'email, labels); ADJUST a mapping (e.g. map a Jira "Epic" to Motir ' +
    '`epic`, an unmatched status to a Motir status). Unmapped users/labels ' +
    'surface a clear "create / leave unassigned" choice.\n' +
    '  3. **Dry-run preview** — the wizard shows EXACTLY what the run will do: ' +
    'N issues to CREATE, M to UPDATE (already mapped from a prior run), K to ' +
    'SKIP, with the resolved mapping per issue and any warnings. **Nothing is ' +
    'written yet.** Click **Back** to re-map; the preview re-computes.\n' +
    '  4. **Run** — CONFIRM; the import runs and streams progress (created / ' +
    'updated counts advancing). When it finishes, navigate to /issues and ' +
    'confirm the imported backlog exists, parented per the grammar, with ' +
    'kind / status / priority / assignees / labels / comments mapped.\n' +
    '- **Idempotency holds (the load-bearing assertion).** Re-run the SAME ' +
    'import (same source, same scope). The dry-run preview now shows the ' +
    'previously-imported issues as UPDATE (already mapped), zero as a duplicate ' +
    'CREATE; after the run, /issues shows the SAME count (the issues were ' +
    'updated in place via the external-id map, not duplicated). Change a title ' +
    'in the source, re-run → that one work item is UPDATED, no new row.\n' +
    '- **The preview is honest (no write before confirm).** Abort at the ' +
    'dry-run step (close the wizard) → /issues shows NOTHING was created (the ' +
    'preview computed the plan without touching the PM core).\n' +
    '- **CSV path with no credentials.** Repeat steps 2–4 with a CSV export ' +
    '(an id column mapped as the external id) — it imports + is idempotent on ' +
    're-upload with no source credentials at all (the universal fallback).\n' +
    '- `pnpm test` (motir-core) — 7.17.8 covers the mapping correctness ' +
    '(each source field → the right Motir field), the idempotent re-run ' +
    '(external-id map → upsert, no dupes), and the dry-run plan ' +
    '(create/update/skip classification without writes).\n' +
    '- `pnpm test:e2e import` — 7.17.9 drives a Jira export + a CSV through ' +
    'connect → map → dry-run → run, asserts the work items appear correctly ' +
    "mapped, and asserts a re-run doesn't duplicate.\n" +
    '- **Open-core boundary review (this Epic’s recurring posture).** The ' +
    'importer lives ENTIRELY in motir-core (it is a PM-core capability — it ' +
    'persists work items via `workItemsService`); it makes NO call to ' +
    'motir-ai and adds no AI table. The imported backlog is just work items ' +
    'the later code-aware planning (7.18/9.6) can read — the importer itself ' +
    'has no AI dependency.\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up ' +
    'Subtask under the same Story.',
  items: [
    {
      id: '7.17.1',
      title:
        'Design — the import wizard (connect source → field/status/user/label mapping → dry-run preview → import + progress)',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        '**Type:** design (the planning-time design gate, Principle #13 + the ' +
        'design-reference rule). The import-wizard UI (7.17.6) depends on this ' +
        'card; without it the multi-step flow would be improvised, which is ' +
        'forbidden (notes.html #31). This card designs the import wizard SHELL ' +
        '+ each step as a panel, composing ONLY shipped `components/ui/*` ' +
        'primitives + `--el-*` colour tokens + `[data-display-style]` shape ' +
        'tokens.\n\n' +
        'Produce the design asset under `motir-core/design/import/`. Author it ' +
        'as a **`*.mock.html` mockup** built from the real design system (the ' +
        'shipped primitives + the `--el-*` tokens + the ' +
        '`[data-display-style]` shape tokens) — NOT a `.pen`. The ' +
        '`.mock.html` is the source of truth (MOTIR.md § Design-reference ' +
        'rule); the HTML route is preferred when a coding agent produces the ' +
        'design (no Pencil→code translation gap; the reviewer sees the ' +
        'actual tokens).\n\n' +
        '**Mirror (VERIFIED this session — cite in design-notes.md).** ' +
        "Plane's Jira-import WIZARD: connect the source → map statuses → map " +
        'priorities → a **Summary** step where you REVIEW the mappings and ' +
        'click **Confirm to start the migration** (with **Back** to adjust), ' +
        'then a progress phase (docs.plane.so/importers/jira). ' +
        "Linear's multi-source importer (Jira/GitHub/Asana/CSV normalised into " +
        'one model, mapping title/description/labels/priority/assignee/state/' +
        'comments — github.com/linear/linear/tree/master/packages/import). ' +
        "Atlassian's own CSV importer + its external-issue-id skip behaviour " +
        '(the idempotency the dry-run surfaces — ' +
        'jira.atlassian.com/browse/JRASERVER-64477). Draw the Motir importer ' +
        'as THAT guided, gated wizard.\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the ' +
        'multi-panel rule, mistake #31):\n\n' +
        '- **Panel 0 — the wizard chrome + a step rail.** The overall ' +
        'stepped-wizard frame: a STEP RAIL showing the four steps (Connect ' +
        '· Map · Preview · Import) with done / current / locked ' +
        'states, a Back/Next footer, and the **Import** action visibly GATED ' +
        'behind the Preview step (you cannot run until you have reviewed the ' +
        "dry-run — Plane's Confirm gate made visible).\n" +
        '- **Panel 1 — Connect the source (step 1).** A source picker (Jira ' +
        '· Linear · GitHub Issues · CSV) as selectable cards; the ' +
        'live-source branch (authorize / paste-token + pick the source ' +
        'project/repo) and the CSV branch (a file dropzone + "which column is ' +
        'the issue id?" hint). Draw both branches + the "source reachable, N ' +
        'issues found" confirmation.\n' +
        '- **Panel 2 — Field mapping (step 2).** The mapping table: each ' +
        'source field (issue type, status, priority, assignee, labels) in a ' +
        'row with a Motir-side mapping control (issue-type → kind via the ' +
        '`IssueTypeIcon` hues; status → a `workflow_status` select; priority; ' +
        'user-by-email match with an "unmatched → create / leave unassigned" ' +
        'choice; labels). Show an auto-proposed mapping + an edited one, and ' +
        'the unmatched-value treatment.\n' +
        '- **Panel 3 — Dry-run PREVIEW (step 3, the ★ gate step).** The ' +
        'review surface: a summary (N to CREATE · M to UPDATE [already ' +
        'imported] · K to SKIP), the resolved per-issue mapping in a ' +
        'scrollable/paginated list (real-product scale — do NOT draw a "all ' +
        'rows at once" dump), warnings (unmapped status, missing user), and ' +
        'the primary **Confirm & import** CTA + **Back** to re-map. Make ' +
        'unmistakable that **nothing is written until Confirm**.\n' +
        '- **Panel 4 — Import RUN + progress (step 4).** The running state: a ' +
        'progress indicator (created / updated counts advancing, an ' +
        '`aria-live` region), a per-issue log/stream, and the DONE state with ' +
        'a "view imported backlog" link to /issues. Draw an in-flight + a ' +
        'complete state.\n' +
        '- **Panel 5 — re-run / empty / error states.** The RE-RUN preview ' +
        '(the same import run again: previously-imported issues shown as ' +
        'UPDATE, zero duplicate CREATE — the idempotency made visible); the ' +
        'connect-failed (bad token / unreachable source), CSV-parse-error, and ' +
        'partial-failure (some issues errored, the rest imported) states. ' +
        'Reuse the shipped `EmptyState` + a danger callout via ' +
        '`--el-danger`.\n\n' +
        'Also write **`design/import/design-notes.md`** naming the exact ' +
        'primitives used per surface, the exact copy strings (especially the ' +
        'gate copy — "review what will be imported before it runs" — and the ' +
        'idempotency framing on re-run — "already imported, will be updated"), ' +
        'the placement decisions, the per-`--el-*` colour role for each ' +
        'element (the step-rail done/current/locked tones; the ' +
        'create/update/skip summary tones; the danger callouts), the VERIFIED ' +
        'mirror citations (Plane / Linear / Atlassian CSV), and a "primitives ' +
        'composed (no hand-rolling)" checklist (the `design-notes.md` ' +
        'convention 1.3.3 / 1.5.1 / 7.0.1 established).\n\n' +
        '**Branch.** `design/PROD-7.17.1-import-wizard-surface`. The ' +
        '`design/*` prefix gate skips CI E2E + the Vercel preview deploy (per ' +
        'MOTIR.md § Plan-seed Workflow) — this PR only edits ' +
        '`design/import/**`, no app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/import/import-wizard.mock.html` exists, renders ' +
        'the panels above (incl. the step rail with the Import action gated ' +
        'behind Preview), and references ONLY `--el-*` colour tokens + ' +
        '`[data-display-style]` shape tokens (no Tier-0 `--color-*`, no ' +
        'hand-rolled spacing — the `motir-core/CLAUDE.md` § colour / shape ' +
        'rules).\n' +
        '- The wizard makes the **review/confirm-before-write GATE visible**: ' +
        'the dry-run Preview step is drawn as the step BEFORE Import, with ' +
        '"nothing is written until Confirm" copy and the Import action ' +
        'unreachable until Preview is reviewed.\n' +
        '- The **idempotent re-run** is drawn (the re-run preview shows ' +
        'previously-imported issues as UPDATE, no duplicate CREATE), and the ' +
        'connect-failed / CSV-parse-error / partial-failure states are drawn.\n' +
        '- The per-issue preview + the import log are drawn at real-product ' +
        'scale (paginated / virtualized list, NOT an all-rows dump — the ' +
        'no-shortcuts rule).\n' +
        '- `design/import/design-notes.md` exists, names every primitive + ' +
        'copy string + per-element `--el-*` role, and the verified mirror ' +
        'citations (Plane / Linear / Atlassian CSV).\n' +
        '- The mockup COMPOSES the shipped primitives — it invents no new ' +
        'design-system entry inside this Story (if one is needed, that is a ' +
        'NEW `design/` subtask, not a code workaround).\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/` — a sibling wizard design (e.g. the ' +
        'onboarding wizards) for the step-rail + multi-panel layout + ' +
        '`design-notes.md` shape to mirror.\n' +
        '- `motir-core/components/ui/` — the `Card`, `Button`, `EmptyState`, ' +
        'the `IssueTypeIcon`, the select/combobox, the step/progress ' +
        'primitives, the toast — the composable surface.\n' +
        '- `motir-core/app/globals.css` — `--el-*` colour tokens + ' +
        '`[data-display-style]` shape tokens (the swap layer the mockup ' +
        'references).\n' +
        '- docs.plane.so/importers/jira (the connect → map → Summary+Confirm ' +
        'wizard), github.com/linear/linear/tree/master/packages/import (the ' +
        'multi-source mapping), jira.atlassian.com/browse/JRASERVER-64477 (the ' +
        'external-issue-id idempotency) — the verified mirrors.',
      dependsOn: [],
    },
    {
      id: '7.17.2',
      title:
        'Decision — sources, the field mapping (type/status/priority/users/labels/comments/attachments/links/history), idempotent re-run, and dry-run',
      status: 'planned',
      type: 'decision',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        '**Type:** decision. Record the durable, industry-standard SHAPE of ' +
        'the importer BEFORE the code subtasks build it (the no-shortcuts ' +
        'rule: pick the durable shape, not the demoable happy path). The three ' +
        'later code cards (7.17.3 model, 7.17.4 connectors, 7.17.5 ' +
        'mapping/persist) all implement what this card decides.\n\n' +
        '**Decide the SOURCES + their access shape.** Jira, Linear, GitHub ' +
        'Issues (live REST: OAuth/token, PAGINATED — never "fetch all in one ' +
        'call"), and CSV (uploaded-file parse, the universal fallback that ' +
        'needs no credentials). Record that the connector layer is an ' +
        'INTERFACE (`IssueSourceConnector`) with four implementations so a ' +
        'fifth source is a new connector, not a wizard change. Record the ' +
        'verified Linear precedent (Jira/GitHub/Asana/CSV normalised into one ' +
        'model) for the multi-source-into-one-shape design.\n\n' +
        '**Decide the MAPPING (source issue → Motir work item).** The full ' +
        'field map onto the Epic-2 grammar, all PERSISTED via ' +
        '`workItemsService`:\n' +
        '- **issue-type → kind** (Motir `epic`/`story`/`task`/`bug`/' +
        '`subtask`), honouring the kind-parent matrix (a mapped parent must be ' +
        'a legal parent for the child kind).\n' +
        '- **status → workflow_status** (mapped to the PROJECT’s workflow ' +
        'statuses; unmatched source statuses prompt a user choice — map to an ' +
        'existing status or to a sensible default — never silently dropped).\n' +
        '- **priority** (mapped to Motir’s priority scale; unmatched → ' +
        'none).\n' +
        '- **users** (assignee + reporter, matched by EMAIL to ' +
        'workspace members; unmatched → a clear "leave unassigned" / "invite" ' +
        'choice, not a silent drop).\n' +
        '- **labels** (mapped/created as Motir labels), **comments** ' +
        '(imported with author + timestamp where the source provides them), ' +
        '**attachments** (fetched + stored where the source + scope allow), ' +
        '**links / parent** (parent → the work-item parent edge per the ' +
        'matrix; issue links → Motir links), and **history** (imported as ' +
        'available — at minimum created/closed timestamps; richer history ' +
        'where the source exposes it).\n' +
        'Record which fields each SOURCE actually exposes (a matrix: not every ' +
        'source has every field — CSV has only what the columns carry), so the ' +
        'mapping degrades gracefully per source.\n\n' +
        '**Decide IDEMPOTENT re-run (the external-id map).** Every imported ' +
        "issue carries its source's stable id (Jira `PROJ-123` / Linear " +
        'identifier / GitHub `owner/repo#42` / a CSV id column). The importer ' +
        'persists an `(import_source, external_id) → work_item_id` MAP; a ' +
        're-run resolves each source issue through the map and UPSERTS (update ' +
        'the mapped work item) instead of creating a duplicate. Record the ' +
        "verified Atlassian behaviour (its CSV importer's external-issue-id " +
        'skip — "already exists as PROJ-1, not importing") as the precedent, ' +
        'and the decision to adopt the EXPLICIT mapping-table shape (re-run = ' +
        'upsert) rather than a per-project custom field. Decide the update ' +
        'policy on re-run (which fields re-sync vs. which respect local edits ' +
        '— default: re-sync source-owned fields, do not clobber ' +
        'Motir-local-only changes; record the rule).\n\n' +
        '**Decide the DRY-RUN.** Every import is PREVIEWED before it writes: ' +
        'the importer computes the plan (per issue: CREATE / UPDATE / SKIP + ' +
        'the resolved mapping + warnings) WITHOUT touching the PM core, the ' +
        'user confirms, THEN it runs (Plane’s Summary→Confirm gate). ' +
        'Record that the dry-run shares the SAME mapping engine as the real ' +
        'run (the preview is the run minus the writes — not a separate ' +
        'estimator that could diverge).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A decision doc (committed under `design/import/` or the story’s ' +
        'decision location) records: the four sources + the connector-' +
        'interface shape + pagination; the full field-mapping table (type/' +
        'status/priority/users/labels/comments/attachments/links-parent/' +
        'history) onto the Epic-2 grammar with per-source availability; the ' +
        'unmatched-value policy (status/user/label — choice, never silent ' +
        'drop); the external-id-map idempotency + the re-run upsert/update ' +
        'policy; and the dry-run-shares-the-engine rule.\n' +
        '- Each decision cites the VERIFIED mirror (Plane Confirm gate / ' +
        'Linear multi-source model / Atlassian external-id skip), or is ' +
        'flagged an assumption-to-verify — none asserted.\n' +
        '- Every persist path is specified to go through `workItemsService` ' +
        '(no second write path around the Epic-2 write authority); no ' +
        '"MVP-now / v2-later" or "load all issues" shortcut (pagination + ' +
        'dry-run + idempotency are in the v1 shape — the no-shortcuts rule).\n' +
        '- No forward dep: the decision references only same-story ids + the ' +
        'shipped `workItemsService`.\n\n' +
        '## Context refs\n\n' +
        '- 7.17.1 — the wizard design the mapping/preview/idempotency steps ' +
        'render.\n' +
        '- `motir-core/lib/services/workItemsService` (Epic-2) — the persist ' +
        'authority every mapped issue flows through; its create surface ' +
        'defines what fields a mapping can set.\n' +
        '- `motir-core/lib/workflows/` — the project workflow_status set a ' +
        'source status maps onto; `prisma/sql/work_item_triggers.sql` — the ' +
        'kind-parent matrix a mapped type/parent must satisfy.\n' +
        '- docs.plane.so/importers/jira, ' +
        'github.com/linear/linear/tree/master/packages/import, ' +
        'jira.atlassian.com/browse/JRASERVER-64477 + the Atlassian CSV-skip KB ' +
        '— the verified mirrors.',
      dependsOn: [],
    },
    {
      id: '7.17.3',
      title:
        'The Import model + idempotency — `Import` (source, mapping, status) + the external-id → work-item map; schema + migration',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Build the persistence foundation the importer rides: the `Import` ' +
        'record + the external-id MAP that makes re-runs idempotent. 4-layer ' +
        '(Route→Service→Repository→Prisma, `motir-core/CLAUDE.md`); ' +
        'this card is the schema + repositories, 7.17.5 adds the engine that ' +
        'writes through them.\n\n' +
        '**The model.** An `Import` row ' +
        '`{ id, projectId, source (jira|linear|github|csv), sourceRef ' +
        '(the connected project/repo/file ref), mapping (the confirmed ' +
        'field-mapping config as typed JSON), status (draft|previewed|' +
        'running|succeeded|partially_failed|failed), counts ' +
        '(created/updated/skipped/failed), createdBy, createdAt, updatedAt }`. ' +
        'And the idempotency table: `ImportedIssue` ' +
        '`{ id, importSource (the Import or a stable source identity), ' +
        'externalId (the source’s stable id), workItemId (the Motir work ' +
        'item it maps to), sourceHash (to detect source-side changes on ' +
        're-run), createdAt, updatedAt }` with a UNIQUE constraint on ' +
        '`(projectId/importSource, externalId)` — the constraint is what makes ' +
        'a duplicate import a no-op/update at the DB level, not just in ' +
        'application code.\n\n' +
        '**Every FK is a Prisma `@relation`** (the migrate-dev-drift rule, ' +
        '`motir-core/CLAUDE.md`): `Import.project` ↔ project, ' +
        '`ImportedIssue.workItem` ↔ work_item (with the right `onDelete` — if ' +
        'a work item is deleted, its mapping row goes too so a re-run ' +
        're-creates it), `ImportedIssue.import` ↔ `Import`. Model both sides; ' +
        'no raw-SQL-only FK. `pnpm migrate` reports "No difference detected" ' +
        'after.\n\n' +
        '**Repositories (single-op, writes require `tx`).** ' +
        '`importRepository` (create/update the Import + its status/counts) and ' +
        '`importedIssueRepository` (find-by-`(source, externalId)` for the ' +
        'idempotency lookup — a READ used inside the import transaction, so it ' +
        'takes `tx` + `SELECT FOR UPDATE` when the same import could race; ' +
        'upsert the mapping row). Repository names match the entity ' +
        '(`ImportedIssue` → `importedIssueRepository`), not the call site.\n\n' +
        '**No business logic here.** The mapping/persist engine (7.17.5) owns ' +
        'the transaction + the create-vs-update decision; this card provides ' +
        'the schema + the single-op data access + the unique constraint that ' +
        'enforces idempotency.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `Import` + `ImportedIssue` models exist with every FK as a Prisma ' +
        '`@relation` (both sides, explicit `onDelete`); `pnpm migrate` runs ' +
        'clean and a fresh `prisma migrate dev` reports "No difference ' +
        'detected" (no FK drift).\n' +
        '- A UNIQUE constraint on `(import-source identity, externalId)` ' +
        'exists — a second import of the same external id cannot create a ' +
        'second mapping row (idempotency enforced at the DB, not only in ' +
        'code).\n' +
        '- `importRepository` + `importedIssueRepository` exist (single-op ' +
        'methods; writes require `tx`; the idempotency lookup used in a tx ' +
        'takes `tx` + `FOR UPDATE`); repository names match the entity.\n' +
        '- No business logic / transaction in the repositories (that is ' +
        '7.17.5); no raw-SQL-only FK.\n\n' +
        '## Context refs\n\n' +
        '- 7.17.2 — the decided model fields + the external-id-map shape this ' +
        'implements.\n' +
        '- `motir-core/lib/repositories/` + `motir-core/CLAUDE.md` § 4-layer ' +
        '+ § Migrations (FK-as-`@relation`) — the repository pattern + the ' +
        'FK-drift rule to follow.\n' +
        '- `motir-core/prisma/schema.prisma` — the work_item model the ' +
        '`ImportedIssue.workItem` relation points at.\n' +
        '- The work-item / label / comment repositories — the existing ' +
        'single-op repo shape to mirror.',
      dependsOn: ['7.17.2'],
    },
    {
      id: '7.17.4',
      title:
        'Per-source connectors — Jira / Linear / GitHub REST (paginated) + CSV parse: fetch issues + metadata into one normalised shape',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 75,
      descriptionMd:
        'Build the connector layer: one `IssueSourceConnector` INTERFACE with ' +
        'four implementations (Jira / Linear / GitHub Issues REST + CSV ' +
        'parse), each fetching a source’s issues + metadata and ' +
        'NORMALISING them into the single intermediate issue shape the mapping ' +
        'engine (7.17.5) consumes. The interface is the extension seam — a ' +
        'fifth source is a new implementation, not a wizard change ' +
        '(the 7.17.2 decision).\n\n' +
        '**The interface.** `IssueSourceConnector` exposes (roughly): ' +
        '`connect(config)` (validate credentials / parse the file, return the ' +
        'reachable source + a count), `discoverFields()` (the source’s ' +
        'field vocabulary the mapping step renders — its issue types, ' +
        'statuses, priorities, label set), and `listIssues(cursor)` returning ' +
        'a PAGE of normalised issues + the next cursor (paginated — never ' +
        '"fetch all" into memory; the no-shortcuts/at-scale rule). The ' +
        'normalised `SourceIssue` carries: `externalId`, title, descriptionMd, ' +
        'type, status, priority, assignee/reporter emails, labels, comments ' +
        '(author + body + ts), attachment refs, parent ref + links, and ' +
        'created/closed timestamps — the union the 7.17.2 mapping needs (a ' +
        'source that lacks a field returns it empty; the per-source ' +
        'availability matrix).\n\n' +
        '**Per source.**\n' +
        '- **Jira** — REST (Cloud + Server token / OAuth from 7.17.7), ' +
        'paginated issue search; map Jira fields (issuetype, status, priority, ' +
        'assignee/reporter, labels, comment, attachment, issuelinks, parent/' +
        'epic link, changelog) into `SourceIssue`.\n' +
        '- **Linear** — its GraphQL/REST API (token from 7.17.7), paginated; ' +
        'map Linear state/labels/assignee/comments/parent.\n' +
        '- **GitHub Issues** — REST (token / the App, paginated); map ' +
        'labels/assignees/comments/`owner/repo#n` as the externalId; (PRs ' +
        'excluded — issues only).\n' +
        '- **CSV** — stream-parse the uploaded file (do not slurp a huge file ' +
        'whole), one row → one `SourceIssue`, the id column as ' +
        '`externalId`; tolerate the messy real-world CSV (quoting, ' +
        'newlines-in-cells, missing columns) with clear per-row errors.\n\n' +
        '**Resilience.** Rate-limit + retry the live APIs (backoff on 429/5xx); ' +
        'a single bad issue/row does not abort the whole fetch (it is ' +
        'collected as a per-issue error the preview surfaces). Credentials ' +
        'come from the 7.17.7-provisioned source apps/tokens, read from ' +
        'config/secret, never hard-coded.\n\n' +
        '**Layering.** The connectors are a `lib/import/connectors/` module ' +
        '(not a repository — they hit external APIs, not Prisma); the 7.17.5 ' +
        'service orchestrates them. No connector writes the DB (that is ' +
        '7.17.5 through `workItemsService` + the 7.17.3 repos).\n\n' +
        '## Acceptance criteria\n\n' +
        '- An `IssueSourceConnector` interface + four implementations (Jira / ' +
        'Linear / GitHub / CSV) exist; each normalises into the shared ' +
        '`SourceIssue` shape (with per-source empties where a field is ' +
        'absent).\n' +
        '- The live connectors are PAGINATED (page + cursor; no "fetch all" ' +
        'into memory) and rate-limit/retry-resilient; CSV is stream-parsed ' +
        'with per-row error tolerance — no all-rows-at-once shortcut.\n' +
        '- A single bad issue/row is collected as a per-issue error (surfaced ' +
        'later in the preview), not a whole-run abort.\n' +
        '- Credentials are read from the 7.17.7-provisioned config/secret, ' +
        'never hard-coded; the externalId per source is the stable id (Jira ' +
        'key / Linear id / `owner/repo#n` / CSV id column).\n' +
        '- Connectors hit external APIs only — they do NOT write the DB ' +
        '(persist is 7.17.5 via `workItemsService`).\n\n' +
        '## Context refs\n\n' +
        '- 7.17.2 — the sources + the normalised-shape + pagination decision ' +
        'this implements; 7.17.3 — the externalId the connector emits is the ' +
        'idempotency key.\n' +
        '- github.com/linear/linear/tree/master/packages/import — the ' +
        'verified multi-source connector + normalisation precedent to mirror.\n' +
        '- `motir-core/lib/` — where an external-integration module ' +
        '(non-Prisma) sits; the existing fetch/secret-reading conventions.\n' +
        '- Jira REST issue-search, the Linear API, the GitHub Issues REST API ' +
        'docs — the per-source field vocabularies to map.',
      dependsOn: ['7.17.3'],
    },
    {
      id: '7.17.5',
      title:
        'The mapping + PERSIST engine — map source issues → Motir work items via `workItemsService`, with the dry-run preview',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 80,
      descriptionMd:
        'The heart of the importer: the engine that takes the 7.17.4 ' +
        'normalised `SourceIssue` stream + the user-confirmed field mapping ' +
        '(7.17.2) and PERSISTS each issue as a Motir work item through the ' +
        'shipped `workItemsService` — kind / workflow_status / priority / ' +
        'assignees / labels / comments / attachments / links / parent / ' +
        'history — IDEMPOTENTLY (via the 7.17.3 external-id map), with the ' +
        'DRY-RUN preview that is the same engine minus the writes. This is the ' +
        'card 7.18 / 9.6 consume; it is the importer’s core. 4-layer ' +
        '(`motir-core/CLAUDE.md`); the service owns the transaction.\n\n' +
        '**The mapping.** For each `SourceIssue`, resolve the Motir work-item ' +
        'create/update payload from the confirmed mapping: issue-type → kind ' +
        '(honouring the kind-parent matrix — a mapped parent must be legal for ' +
        'the child); status → the project’s `workflow_status`; priority; ' +
        'assignee/reporter → workspace members by email (unmatched → the ' +
        'decided policy); labels (map/create); comments (with author + ts); ' +
        'attachments (fetch + store where allowed); parent + links; and the ' +
        'created/closed history. Parent edges are resolved in a SECOND pass ' +
        '(or topologically) so a child whose parent imports later still links ' +
        'correctly.\n\n' +
        '**The persist — through `workItemsService`, idempotent.** For each ' +
        'issue, look up `(import-source, externalId)` in the 7.17.3 map ' +
        '(`FOR UPDATE`): if ABSENT → `workItemsService.create(...)` + write ' +
        'the mapping row; if PRESENT → `workItemsService.update(...)` the ' +
        'mapped work item (the re-run upsert; respecting the 7.17.2 ' +
        'do-not-clobber-local-edits policy via the `sourceHash`). EVERY write ' +
        'goes through `workItemsService` — the importer adds NO second write ' +
        'path around the Epic-2 authority, so the 6.4 permissions + the tenant ' +
        'guard + the validation all apply to imported rows. The whole import ' +
        'runs in service-owned transaction(s) (batched per page so a ' +
        '10k-issue import does not hold one giant tx — durable at scale).\n\n' +
        '**The dry-run preview (the gate’s data).** A `preview(import)` ' +
        'path runs the SAME mapping + the SAME idempotency lookup but emits a ' +
        'PLAN — per issue: CREATE / UPDATE (already mapped) / SKIP + the ' +
        'resolved payload + any warning (unmapped status, missing user, illegal ' +
        'parent) — and WRITES NOTHING. The real run is literally the preview ' +
        'with the writes enabled (one engine, a `dryRun` flag), so the preview ' +
        'can never diverge from what the run does (the 7.17.2 ' +
        'shares-the-engine rule). The preview is paginated/streamed (a 10k ' +
        'preview is not one giant payload).\n\n' +
        '**API.** `POST /api/import` (create a draft Import), ' +
        '`POST /api/import/:id/preview` (compute + return the dry-run plan, no ' +
        'writes), `POST /api/import/:id/run` (execute, streaming progress), ' +
        '`GET /api/import/:id` (status + counts, for resume/progress). Routes ' +
        'call ONE service method; the service owns the transaction + the ' +
        'connector orchestration; no raw Prisma in a route.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Each `SourceIssue` maps to a Motir work-item payload per the ' +
        'confirmed mapping (kind/status/priority/users/labels/comments/' +
        'attachments/links/parent/history), and EVERY persist goes through ' +
        '`workItemsService` (no second write path) — imported rows obey the ' +
        '6.4 permissions + tenant guard + validation.\n' +
        '- The run is IDEMPOTENT: an issue absent from the external-id map is ' +
        'CREATEd + mapped; a present one is UPDATEd (the mapped work item); a ' +
        're-run creates zero duplicates (the 7.17.3 unique constraint + the ' +
        '`FOR UPDATE` lookup hold under a concurrent re-run).\n' +
        '- The dry-run `preview` classifies each issue CREATE/UPDATE/SKIP + ' +
        'emits warnings + WRITES NOTHING, and is the SAME engine as the run ' +
        '(a `dryRun` flag, not a separate estimator) — the preview cannot ' +
        'diverge from the run.\n' +
        '- Parent/link edges resolve correctly even when the parent imports ' +
        'after the child (a second/topological pass); the kind-parent matrix ' +
        'is honoured (an illegal parent is a surfaced warning, not a 500).\n' +
        '- Runs at scale: paginated per the 7.17.4 stream, batched ' +
        'transactions (no one-giant-tx / load-all-rows), partial failures ' +
        'recorded per issue with the rest committed.\n' +
        '- 4-layer respected; routes call one service method; no raw Prisma in ' +
        'a route; no `motir-ai` import (the importer is pure PM-core).\n\n' +
        '## Context refs\n\n' +
        '- 7.17.4 — the normalised `SourceIssue` stream + per-issue errors ' +
        'this consumes; 7.17.3 — the external-id map + the unique constraint ' +
        'the idempotency rides; 7.17.2 — the mapping + idempotency + dry-run ' +
        'rules.\n' +
        '- `motir-core/lib/services/workItemsService` (Epic-2) — the SOLE ' +
        'persist authority every imported issue flows through (create/update; ' +
        'labels/comments/links/parent surfaces).\n' +
        '- `motir-core/lib/workflows/` — the project workflow_status set; ' +
        '`prisma/sql/work_item_triggers.sql` — the kind-parent matrix the ' +
        'mapping honours.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer (service owns the tx; one method ' +
        'per route) + the lock-before-read-derived-update rule (the ' +
        '`FOR UPDATE` idempotency lookup).',
      dependsOn: ['7.17.4'],
    },
    {
      id: '7.17.6',
      title: 'The import wizard UI — connect → map → dry-run preview → run → progress',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'Build the user-facing import wizard EXACTLY as 7.17.1 specifies — the ' +
        'stepped flow that walks a user through connect → map → dry-run ' +
        'preview → run, with the review/confirm-before-write gate visible. ' +
        'This is the UI subtask the design gate guards: it depends on 7.17.1 ' +
        '(design) + 7.17.5 (the engine + APIs it drives) and is `blocked` ' +
        'until both land.\n\n' +
        '**The wizard shell.** A route under the authed shell (e.g. ' +
        '`app/(authed)/import/[id]/page.tsx`, plus a "new import" entry) that ' +
        'reads the current Import from 7.17.5’s `GET /api/import/:id` ' +
        '(Server Component via a service) and renders the step rail (Connect ' +
        '· Map · Preview · Import) with done / current / locked ' +
        'states. The **Import** action is rendered UNREACHABLE until the ' +
        'Preview step has been reviewed (the gate from 7.17.1 made visible). ' +
        'Back/Next; the wizard reads its step/status from the persisted Import ' +
        'so a re-open resumes (no restart).\n\n' +
        '**The steps.** Step 1 the source picker + the live-source ' +
        'connect/token + project-select OR the CSV dropzone (+ the id-column ' +
        'choice); step 2 the mapping table (issue-type → kind via the ' +
        '`IssueTypeIcon` hues, status → a `workflow_status` select, priority, ' +
        'user-by-email with the unmatched choice, labels), driven by ' +
        '7.17.4’s `discoverFields`; step 3 the dry-run PREVIEW — calls ' +
        '`POST …/preview`, renders the CREATE/UPDATE/SKIP summary + the ' +
        'paginated/virtualized per-issue list + warnings + **Confirm & ' +
        'import** + **Back**; step 4 the run — calls `POST …/run`, streams ' +
        'progress (created/updated counts in an `aria-live` region) to the ' +
        'DONE state with a link to /issues. Re-run shows the idempotency ' +
        'framing ("already imported — will be updated").\n\n' +
        '**Tokens + a11y + i18n.** References ONLY `--el-*` colour + ' +
        '`[data-display-style]` shape tokens (no Tier-0 utilities — the ' +
        '`motir-core/CLAUDE.md` colour/shape rules); the step-rail ' +
        'done/current/locked + the create/update/skip summary tones use the ' +
        '`--el-*` roles 7.17.1 assigns (chips put the hue in the tint ' +
        'BACKGROUND with `--el-text-strong`, never a page-level tint — finding ' +
        '#35). The preview + progress regions are `aria-live`; the rail + ' +
        'Back/Next are keyboard-reachable; the per-issue preview is ' +
        'paginated/virtualized (NOT an all-rows dump — the no-shortcuts rule). ' +
        'Add an `import` i18n namespace for the wizard strings across the ' +
        'locale set the app ships.\n\n' +
        '**No business logic in the client.** A client component owns the ' +
        'step interactions + the preview/progress stream, but it calls the ' +
        '7.17.5 APIs — it never touches the service layer directly; the page ' +
        'is a Server Component reading via a service (4-layer).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The wizard renders the step rail + the four steps per the 7.17.1 ' +
        'mockup, composed of the named primitives, referencing ONLY `--el-*` ' +
        '+ shape tokens (no Tier-0 utilities).\n' +
        '- The dry-run Preview step renders the CREATE/UPDATE/SKIP summary + ' +
        'the per-issue plan + warnings, and the **Import** action is ' +
        'unreachable until Preview is reviewed (the confirm-before-write gate ' +
        'made visible); **Back** re-computes the preview.\n' +
        '- The run step streams progress (created/updated counts, `aria-live`) ' +
        'and the re-run preview shows the idempotency framing (already-imported ' +
        '→ update, no duplicate create).\n' +
        '- The per-issue preview + the run log are paginated/virtualized (no ' +
        'all-rows dump); a11y: `aria-live` regions, keyboard-reachable rail + ' +
        'Back/Next; strings in the `import` namespace.\n' +
        '- No client component calls the service layer directly (it goes ' +
        'through the 7.17.5 API); the page is a Server Component (4-layer).\n\n' +
        '## Context refs\n\n' +
        '- 7.17.1 — the design asset this implements (every panel + the step ' +
        'rail + the gate + the idempotency framing).\n' +
        '- 7.17.5 — the engine + the `POST …/preview` / `POST …/run` / ' +
        '`GET …/:id` APIs this drives; 7.17.4 — `discoverFields` feeding the ' +
        'mapping step.\n' +
        '- `motir-core/components/ui/` — the `IssueTypeIcon`, the select/' +
        'combobox, the step/progress primitives, `EmptyState`, the toast + ' +
        'the authed shell to mirror.\n' +
        '- `motir-core/app/globals.css` — `--el-*` + `[data-display-style]` ' +
        'tokens.',
      dependsOn: ['7.17.1', '7.17.5'],
    },
    {
      id: '7.17.7',
      title: 'Provision the source OAuth apps / API tokens (Jira / Linear / GitHub) for import',
      status: 'blocked',
      type: 'manual',
      executor: 'human',
      estimateMinutes: 40,
      descriptionMd:
        '**Type:** manual / human (provisioning — mirror 1.6.7: no PR, "done ' +
        'on user confirm"). The live connectors (7.17.4) authenticate to the ' +
        'source trackers, which requires source-side credentials a HUMAN ' +
        'registers in those vendors’ dashboards — work a coding agent ' +
        'cannot do (it has no Atlassian / Linear / GitHub account, no consent ' +
        'screen access). Without this the Jira/Linear/GitHub connectors have ' +
        'no credentials to run; the CSV path needs none (it is the ' +
        'no-credentials fallback, deliberately).\n\n' +
        '**What to provision (record the resulting ids/secrets into the ' +
        'app’s secret store / env, NOT into the repo):**\n' +
        '- **Jira** — register an Atlassian OAuth 2.0 (3LO) app (or document ' +
        'the API-token path for Jira Cloud/Server): the client id/secret, the ' +
        'redirect URL, and the read scopes (read issues + comments + ' +
        'attachments + users). Note Cloud vs. Server differences.\n' +
        '- **Linear** — create a Linear OAuth application (or a personal/' +
        'workspace API key path): client id/secret + redirect + the read ' +
        'scope. \n' +
        '- **GitHub** — the read scope for Issues: either reuse the 7.7 Motir ' +
        'GitHub App’s installation token (issues:read) if its scopes ' +
        'cover issue import, OR register a dedicated OAuth app / token; record ' +
        'which, and the scope. (If 7.7’s App is reused, note the ' +
        'dependency is satisfied by an already-provisioned credential.)\n' +
        '- **CSV** — nothing to provision (the universal, credential-free ' +
        'source) — recorded explicitly so the absence is intentional, not an ' +
        'oversight.\n\n' +
        '**Env wiring.** The connectors (7.17.4) read these from config/secret ' +
        'at runtime; this card documents the exact env var names + where each ' +
        'value comes from + the redirect URLs registered, and confirms each is ' +
        'set in the relevant environment. No application code in this card (it ' +
        'is the manual prerequisite the code rides) — but it MUST land for the ' +
        'live-source E2E (7.17.9) to exercise a real connector (the E2E ' +
        'otherwise runs the connectors against recorded fixtures).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The Jira + Linear + GitHub source credentials (OAuth app ids/' +
        'secrets or API tokens) are registered in the respective dashboards ' +
        'with the READ scopes the import needs, and the ids/secrets + redirect ' +
        'URLs are recorded in the app’s secret store / env (never ' +
        'committed to the repo).\n' +
        '- The exact env var names + their source + the registered redirect ' +
        'URLs are documented (so 7.17.4 reads them by the agreed names); the ' +
        'GitHub choice (reuse 7.7’s App vs. dedicated) is recorded.\n' +
        '- The CSV "no credentials needed" is recorded explicitly.\n' +
        '- No PR / no application code — "done on user confirm" (mirror ' +
        '1.6.7); the card is checked off when the credentials are confirmed ' +
        'present in the target environment.\n\n' +
        '## Context refs\n\n' +
        '- 7.17.2 — the sources this provisions credentials for; 7.17.4 — the ' +
        'connectors that READ these credentials (the env var names to align ' +
        'on).\n' +
        '- 7.7.2 (the Motir GitHub App registration) — the existing GitHub ' +
        'credential this may reuse for the Issues read scope.\n' +
        '- The Atlassian OAuth 2.0 (3LO), Linear OAuth, and GitHub OAuth/App ' +
        'developer docs — the registration steps + the read scopes.\n' +
        '- MOTIR.md § the 1.6.7 provisioning-subtask shape (manual, no PR, ' +
        'done-on-confirm).',
      dependsOn: ['7.17.2'],
    },
    {
      id: '7.17.8',
      title: 'Vitest — mapping correctness + idempotency (re-run no-dupe) + dry-run',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'Lock the importer’s three load-bearing properties against ' +
        'regression. motir-core tests run over a real Postgres (the project ' +
        'convention; `tests/helpers/db.ts` truncates between tests; the only ' +
        'allowed `vi.mock` is `getSession()`). The CONNECTORS (the external ' +
        'fetch) are stubbed with recorded source fixtures (a small ' +
        'Jira/Linear/GitHub payload + a CSV file) — but the mapping, the ' +
        'persist through `workItemsService`, the external-id map, and the ' +
        'dry-run run FOR REAL against the DB.\n\n' +
        '**Mapping correctness** (7.17.5):\n' +
        '- Each source field maps to the RIGHT Motir field: issue-type → kind ' +
        '(per the kind-parent matrix), status → the project workflow_status, ' +
        'priority, assignee/reporter → members by email (matched + unmatched ' +
        '→ the decided policy), labels, comments (author + ts), parent/links ' +
        '(incl. the second-pass parent-after-child case), history timestamps.\n' +
        '- An illegal kind-parent mapping surfaces a WARNING (not a 500) and ' +
        'the issue is handled per the decided policy.\n' +
        '- A per-source availability case (CSV with only some columns) maps ' +
        'the present fields + leaves the absent ones empty (no crash).\n\n' +
        '**Idempotency — the load-bearing case** (7.17.3 + 7.17.5):\n' +
        '- A first import CREATEs N work items + N mapping rows. A SECOND ' +
        'import of the SAME source issues creates ZERO new work items — each ' +
        'is resolved through the external-id map and UPDATEd in place ' +
        '(assert the work-item COUNT is unchanged + the mapping rows are ' +
        'unchanged).\n' +
        '- A source-side change (a changed title, a new `sourceHash`) on ' +
        're-run UPDATEs that one work item, respecting the ' +
        'do-not-clobber-local-edits policy; an unchanged issue is a no-op.\n' +
        '- The DB UNIQUE constraint holds under a simulated concurrent re-run ' +
        '(the `FOR UPDATE` lookup serialises — no duplicate mapping row).\n\n' +
        '**Dry-run** (7.17.5):\n' +
        '- `preview` classifies each issue CREATE / UPDATE / SKIP + emits the ' +
        'warnings AND WRITES NOTHING (assert the work-item + mapping counts ' +
        'are unchanged after a preview).\n' +
        '- The preview plan MATCHES what the subsequent real run does (same ' +
        'engine, `dryRun` flag) — run after the preview and assert the actual ' +
        'creates/updates equal the previewed plan.\n\n' +
        '## Acceptance criteria\n\n' +
        '- All cases above pass over a real Postgres; the only mocks are ' +
        '`getSession()` + the connector fetch boundary (recorded source ' +
        'fixtures) — the mapping / persist / external-id-map / dry-run paths ' +
        'are real.\n' +
        '- The idempotency case FAILS if the external-id map / unique ' +
        'constraint is removed (a re-run then duplicates) — proving the test ' +
        'guards idempotency, not asserts it.\n' +
        '- The dry-run case FAILS if `preview` writes (the count changes) or ' +
        'if the preview plan diverges from the real run.\n' +
        '- New service/repo code respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage) — no untested branch in the ' +
        'mapping resolution, the create-vs-update decision, or the dry-run ' +
        'classifier.\n\n' +
        '## Context refs\n\n' +
        '- 7.17.5 (the mapping + persist + dry-run engine), 7.17.3 (the ' +
        'external-id map + unique constraint), 7.17.4 (the connector boundary ' +
        'the fixtures stand in for) — everything under test.\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + coverage gate + ' +
        'the single-allowed-`getSession`-mock rule.\n' +
        '- `motir-core/tests/helpers/db.ts` — the truncate-between-tests ' +
        'harness; the existing work-item service tests — the real-DB persist ' +
        'assertion pattern to mirror.',
      dependsOn: ['7.17.5'],
    },
    {
      id: '7.17.9',
      title:
        'Playwright E2E — import a Jira export + a CSV → work items appear correctly mapped; re-run doesn’t dupe',
      status: 'blocked',
      type: 'e2e',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'End-to-end browser test (`tests/e2e/import.spec.ts`) over the seeded ' +
        '`moooon`/`motir` tenant — closes the importer promise from a ' +
        'user’s seat. Because a live Jira/Linear/GitHub API in CI is ' +
        'impractical, the spec drives the wizard UI and backs the connectors ' +
        'with recorded fixtures: a **Jira export fixture** (the Jira ' +
        'connector’s recorded payload) and a **CSV file** (the ' +
        'credential-free path, exercised fully end to end) — so the test ' +
        'asserts the WIZARD + the mapping + the gate + idempotency, not live ' +
        'source availability.\n\n' +
        '**The spec.**\n' +
        '1. Sign in as `zhuyue@motir.co` via the existing `signIn` helper; ' +
        'open **Import** for a project. Assert the wizard opens at **Connect** ' +
        'with the step rail showing **Import** gated behind Preview.\n' +
        '2. **CSV path (no credentials).** Upload the CSV fixture; pick the id ' +
        'column. Advance to **Map**; assert the proposed mapping renders; ' +
        'adjust one mapping (e.g. a status). Advance to **Preview**: assert ' +
        'the CREATE summary (N to create, 0 to update on a first run) + the ' +
        'per-issue plan; assert **nothing is in /issues yet** (open it in a ' +
        'second context or after-abort check). **Confirm & import**; assert ' +
        'the progress stream then the DONE state; navigate to /issues and ' +
        'assert the backlog exists, parented per the grammar, with kind / ' +
        'status / priority / assignee / labels / comments mapped.\n' +
        '3. **Idempotent re-run.** Run the SAME CSV import again; assert the ' +
        'Preview now shows those issues as UPDATE (0 duplicate CREATE); ' +
        'Confirm; assert /issues shows the SAME count (no duplicates).\n' +
        '4. **Jira export path.** Repeat connect → map → preview → run with ' +
        'the Jira export fixture (the connector stubbed to the recorded ' +
        'payload); assert the Jira issue-type/status/priority/assignee map ' +
        'onto the Motir grammar and the work items appear.\n' +
        '5. **The gate.** At the Preview step, ABORT (close the wizard) and ' +
        'assert /issues shows nothing was written (review-before-write holds).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e import` passes locally + in CI, backed by the Jira ' +
        'export fixture + the real CSV path (no live source API).\n' +
        '- The spec asserts CORRECT MAPPING (kind/status/priority/assignee/' +
        'labels/comments appear on the imported work items, parented per the ' +
        'grammar) for both the CSV and the Jira-export path.\n' +
        '- The spec asserts IDEMPOTENCY: a re-run shows UPDATE (not duplicate ' +
        'CREATE) in the preview and /issues count is unchanged after.\n' +
        '- The spec asserts the GATE: aborting at Preview leaves /issues ' +
        'untouched (nothing written before Confirm).\n' +
        '- It uses the existing `signIn(page, email, password)` helper + the ' +
        'established aria-live waiting patterns — no new auth plumbing; not ' +
        'flake-prone (explicit waits on the step-rail state + the progress ' +
        '`aria-live` region + the post-import confirmation, no fixed sleeps).\n\n' +
        '## Context refs\n\n' +
        '- 7.17.6 (the wizard UI under test), 7.17.5 (the mapping + ' +
        'idempotency + dry-run engine), 7.17.4 (the connector boundary the ' +
        'Jira-export fixture stands in for).\n' +
        '- `motir-core/tests/e2e/` — the `signIn` helper + the established ' +
        'aria-live waiting patterns to mirror; the existing fixture-loading ' +
        'convention for the Jira export + CSV files.\n' +
        '- 7.17.2 — the mapping the spec asserts; 7.17.1 — the wizard surface ' +
        'the spec drives.',
      dependsOn: ['7.17.6'],
    },
  ],
};
