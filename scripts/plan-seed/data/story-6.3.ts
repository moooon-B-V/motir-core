import type { PlanStory } from '../types';

/**
 * Story 6.3 — Dashboards & reports.
 *
 * The reporting layer over the PM substrate: **configurable dashboards** —
 * named, shareable widget grids whose widgets are backed by a **saved filter
 * (6.2) or the project** — plus the **project Reports hub** with the two
 * built-in analysis reports the stub names (**created-vs-resolved** and
 * **status distribution**). Charts reuse the Epic-4 viz: the 4.6.2
 * token-aware SVG primitives grow a donut and a two-series difference/area
 * form; NO charting library (the recorded 4.6 decision).
 *
 * Mirror-product check (decision-ladder rung 1 — VERIFIED against Atlassian
 * docs at plan time, 2026-06-10):
 *   • **Dashboards are SITE-level (cross-project), not per-project.** Any
 *     user creates them; each has an owner plus viewers/editors sharing
 *     (audiences: user, group, project/role, any-logged-in, public); edit
 *     mode offers column layouts + drag-rearrange; gadgets configure a
 *     per-gadget refresh; a wallboard mode exists; ~28 built-in gadgets.
 *   • **Gadgets are backed by a PROJECT or a SAVED FILTER** — the standard
 *     config pattern (Pie Chart, Created vs Resolved, Workload all offer
 *     "project or saved filter"; Filter Results is saved-filter-only).
 *   • **Filter-displaying gadgets paginate, capped at 50 rows/page** (a
 *     deliberate, non-raisable Cloud performance bound).
 *   • **Created vs Resolved** — config = project-or-filter + a period bucket
 *     + a days-back window + a cumulative toggle; renders as a two-series
 *     difference/area chart (red where created outpaces resolved, green
 *     where resolved outpaces created); lives in the project Reports tab.
 *     Jira's "resolved" = the Resolution FIELD being set.
 *   • **Pie Chart** — config = project-or-filter + a "Statistic Type"
 *     (finite-value fields: status, assignee, priority, type, component, …);
 *     the legend shows counts AND percentages.
 *   • **The Reports tab** groups agile reports (burndown, velocity, sprint
 *     report, …) and issue-analysis reports (Average Age, Created vs
 *     Resolved, Pie Chart, Resolution Time, …).
 *
 * Recorded deviations/narrowings (each justified): dashboards live at the
 * shipped `/dashboard` route, scoped to the WORKSPACE (our "site" — rung 2:
 * the shell's outer boundary); access narrows to
 * `private | workspace` with owner-only edit (Jira's audience matrix —
 * user/group/role/public lists, editor lists — is a documented extension; the
 * `access` field is the durable shape it grows into). "Resolved" maps to a
 * transition into a `done`-CATEGORY status via `getTerminalStatusKeys` — we
 * have no Resolution field (rung 2); this is the SAME done-predicate the
 * burndown/velocity/rollups use, so every report agrees on what "done" means.
 * The widget set narrows to the three the stub implies (filter results,
 * distribution, created-vs-resolved) behind a TOTAL widget-type registry the
 * extension gadgets slot into. Default/system dashboard, starring, wallboard,
 * per-gadget auto-refresh, version overlays → documented extensions.
 *
 * ⚠️ Design gate (planning-time). `design/reports/charts.mock.html` (4.6.1)
 * designs ONLY the chart visual language + the burndown/velocity — the
 * dashboard surface (grid, widget chrome, add-gadget picker, config panels,
 * sharing), the donut + difference-area chart forms, and the Reports hub +
 * report pages are undesigned → subtask **6.3.3** is the `type: design`
 * subtask; every UI code subtask (6.3.4/6.3.5/6.3.6) carries it in
 * `dependsOn` and seeds `'blocked'` (Principle #13).
 *
 * 📦 Dependency posture: backward/same-epic only (the mistake-#32 audit is
 * clean — deps point at Epic 4 (4.6.2/4.6.3), Epic 5 contracts via 6.1.2,
 * and same-epic 6.1.x/6.2.1). Story 6.2 expanded in this same planning pass:
 * 6.2.1 documents the **resolve-by-id data-source contract** (id → decode +
 * registry-validate via 6.1.1 → compiled WHERE + metadata DTO, stale
 * referents degrading per 6.1.2, every read behind the 6.4 browse gate) and
 * the **delete-dependents enumeration** with the "6.3 widgets join in by FK
 * later" line this story's 6.3.1 fills; 6.2.2 designs the "filter missing"
 * degraded widget card 6.3 INHERITS (reference, don't redraw). Saved filters
 * are PROJECT-contained (6.2's recorded deviation), so a widget's data
 * source is always project-scoped — a workspace dashboard aggregates
 * cross-project WIDGET-BY-WIDGET (each gadget names its own project/filter,
 * the verified Jira gadget pattern), never via a cross-project filter.
 *
 * Expanded from its `stubs.ts` entry per `motir plan 6.3`, on the standing
 * `seed/epic-5-plan` branch (Epic-5/6 planning). Matches the canonical style
 * of 5.1–5.6 and 6.1.
 */
export const story_6_3: PlanStory = {
  id: '6.3',
  title: 'Dashboards & reports',
  status: 'planned',
  descriptionMd:
    'The reporting layer: **configurable dashboards** — named, shareable grids of widgets ' +
    'backed by a **saved filter (6.2) or the project** — and the **project Reports hub** ' +
    'hosting the two built-in analysis reports (**created-vs-resolved**, **status ' +
    'distribution**). Charts reuse the Epic-4 viz (the 4.6.2 token-aware SVG primitives, ' +
    'grown by a donut + a two-series difference/area form) — **no charting library** (the ' +
    'recorded 4.6 decision).\n\n' +
    '**Where it sits relative to the mirror (verified, and the deviations recorded).** Jira ' +
    'dashboards are site-level: any user creates them, an owner shares them via ' +
    'viewer/editor audiences, gadgets configure a project OR a saved filter as their data ' +
    'source, edit mode offers column layouts + drag-rearrange, and filter-displaying gadgets ' +
    'paginate at a hard 50/page. Ours map the "site" to the WORKSPACE (the shell\'s outer ' +
    'boundary — rung 2) at the shipped `/dashboard` route (the 1.1.2 smoke landing this ' +
    'story replaces): multiple named dashboards, an `access` of `private | workspace`, ' +
    'owner-only edit. Saved filters are PROJECT-contained (the 6.2 recorded deviation), so ' +
    'every widget data source is project-scoped and a dashboard aggregates cross-project ' +
    'WIDGET-BY-WIDGET — each gadget names its own project or filter, exactly the verified ' +
    'gadget pattern. The richer audience matrix (user/group/' +
    'role/public, editor lists), the default/system dashboard, starring, wallboard mode, and ' +
    'per-gadget auto-refresh are **documented extensions** the shape grows into.\n\n' +
    '**The widget-type registry (the load-bearing piece).** Three widget types ship — ' +
    '**filter-results** (a paginated issue table, the verified 50/page cap), **distribution** ' +
    '(donut by a *statistic type* — the finite-value fields the 6.1 registry already ' +
    'enumerates as enum-ish: kind, status, priority, assignee, reporter, sprint, label, ' +
    'component, select/user custom fields), and **created-vs-resolved** (period bucket + ' +
    'days-back window + cumulative toggle — the verified Jira config). Each registers in a ' +
    '**TOTAL per-widget-type registry** (mistake #29): config schema + validation, data-source ' +
    'resolution, renderer, and config-editor kind — an unknown widget type or malformed ' +
    'config is a typed 422, never a silent pass-through. Every widget names its data source ' +
    'as `{ savedFilterId } | { projectId }` (the verified gadget pattern); a dashboard caps ' +
    'at 20 widgets (the DC default as our sanity bound).\n\n' +
    '**"Resolved" semantics (recorded deviation).** Jira\'s created-vs-resolved counts the ' +
    'Resolution FIELD being set; we have no resolution field, so "resolved" = a transition ' +
    'into a `done`-category status (`workflowsService.getTerminalStatusKeys`) — the SAME ' +
    'predicate the burndown (4.6.3), velocity (4.6.4), and rollups (4.3.3) resolve, so every ' +
    'report agrees on "done". The resolved series derives from the **1.4.6 revision trail** ' +
    'via ONE bounded grouped query windowed by the days-back config (the 4.6.3 pattern — ' +
    'never an all-revisions load + JS reduce); the created series buckets `createdAt`. A ' +
    'reopened issue (a transition back OUT of done inside the window) subtracts — the series ' +
    'count NET resolutions per bucket.\n\n' +
    '**Viewer-scoped permissions (the 6.4 seam).** A workspace-shared dashboard renders for ' +
    'EVERY workspace member, but each widget read enforces the **6.4 project-access gate per ' +
    'VIEWER, not per owner**: a widget over a private project (or a saved filter scoped to ' +
    "one) the viewer can't access renders the designed no-access widget state — it never " +
    'leaks counts, rows, or chart shapes (the mirror behaviour: Jira gadgets show only what ' +
    'the viewer can see). Dashboard CRUD itself: create = any member; edit/delete = owner.\n\n' +
    '**Bounded + complete (finding #57 + the real-product states).** Every widget read is a ' +
    'bounded aggregate or a paginated page (filter-results rides the 2.5.12 pagination read ' +
    'at ≤50/page; distribution is a GROUP-BY with counts; created-vs-resolved is day/week/' +
    'month buckets over a capped window — never per-issue loads); per-widget loading / ' +
    'error / empty / no-access / stale-referent states (a widget whose saved filter was ' +
    'deleted renders the designed stale state, never a crash) are designed + asserted; the ' +
    'dashboards list, the empty dashboard, and the zero-data chart states are all specified.\n\n' +
    '**Out of scope (documented extension slots, each justified):** the Jira audience ' +
    'matrix + editor lists (the `access` enum grows); default/system dashboard + starring + ' +
    'the wallboard/slideshow (presentation-layer extensions); per-gadget auto-refresh ' +
    '(needs a polling story); more gadget types (Assigned to Me, Activity Stream, Two ' +
    'Dimensional Statistics, Average Age, Resolution Time — registry additions); version ' +
    'overlays on created-vs-resolved (no version entity in the schema); column config on ' +
    'filter-results (fixed sensible columns ship; a picker is additive); cross-workspace ' +
    'dashboards (no such scope exists — rung 2).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (the 6.3.1 dashboard ' +
    'tables apply cleanly; re-run reports "No difference detected"), `pnpm db:seed`, ' +
    '`pnpm dev`.\n' +
    '- `pnpm test:coverage` — Vitest (real Postgres) over the widget registry, the ' +
    'aggregation reads (bucket/cumulative/group-by matrices), and the permission gates ≥90% ' +
    'per-file branch/fn/line.\n' +
    '- **Dashboards flow:** sign in as `zhuyue@motir.co` / `!QAZ1qaz` → /dashboard ' +
    '(matching `design/reports/dashboard.mock.html`) → create "Team overview", access ' +
    'Workspace → add a **filter-results** widget over a 6.2 saved filter (rows paginate at ' +
    'the designed page size, ≤50), a **distribution** donut (Statistic type: Status — counts ' +
    '+ percentages in the legend), and a **created-vs-resolved** chart (Weekly, last 90 ' +
    'days; toggle Cumulative and watch the series re-shape) → switch the layout between ' +
    '1/2/3 columns and drag widgets between columns → reload: layout + positions persist.\n' +
    '- **Sharing + permissions:** as `bophilips@motir.co`, the Workspace dashboard is ' +
    'visible but not editable (no edit affordances); a Private dashboard is invisible. ' +
    "Point a widget at a 6.4-private project bophilips isn't a member of → bophilips sees " +
    'the no-access widget state, zhuyue sees the data (per-viewer gating).\n' +
    '- **Stale referent:** delete the saved filter behind a widget → the 6.2 delete warning ' +
    'names the dependent widget ("1 dashboard widget" — the enumeration 6.3.1 extends); ' +
    'confirm → the widget renders the inherited "filter missing" card with the reconfigure ' +
    'affordance (never a crash).\n' +
    '- **Reports hub:** /reports (the stub page this story replaces) lists the agile group ' +
    '(links to the shipped burndown / velocity / sprint-report surfaces) + the analysis ' +
    'group. Open **Created vs Resolved** → scope = project or saved filter, period + ' +
    'days-back + cumulative controls, the difference/area chart with the red/green ' +
    'semantics; resolve an issue (transition into a done-category status) and re-run → the ' +
    "resolved series ticks up in today's bucket; reopen it → the net count drops back. Open " +
    '**Status distribution** → the donut + legend track the statistic-type picker (status, ' +
    'priority, assignee, …).\n' +
    '- **Both charts** match the chart visual language (axes, gridlines, visible text ' +
    'legend, `--el-chart-*` tokens only — finding #35: colour never the sole signal); dark ' +
    'mode parity holds.\n' +
    '- `pnpm test:e2e --grep dashboards` — Playwright over the real stack: the ' +
    'create-dashboard → add-widgets → drag → reload journey + the reports journey.\n' +
    '- **a11y check:** the dashboard grid (widget chrome, add-gadget picker, config ' +
    'panels) and both report pages pass the strict axe sweep; charts carry their ' +
    'visually-hidden data tables (the 4.6.1 a11y pattern); fully keyboard-operable.',
  items: [
    {
      id: '6.3.1',
      title:
        'Dashboard + widget data model, services, and CRUD API (workspace-scoped, access private|workspace, TOTAL widget-type registry, 20-widget cap)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['6.2.1'],
      descriptionMd:
        'The dashboard substrate. Pure backend — no UI.\n\n' +
        '**Migration** — `dashboard` (id, workspaceId, name, ownerId, `access: ' +
        "'private' | 'workspace'`, `layout: 'one' | 'two' | 'three'` columns, timestamps) " +
        'and `dashboard_widget` (id, dashboardId, `type`, `column`, `position` — the ' +
        'shipped base-62 fractional index (`lib/workItems/positioning.ts` vocabulary) so ' +
        'drag-reorder is one-field, `config Json`, plus a NULLABLE `savedFilterId` FK ' +
        '(`onDelete: SetNull` — a deleted filter STALES the widget, never deletes it) and ' +
        'a nullable `projectId` FK (`onDelete: Cascade`)). Both FKs modelled as ' +
        '`@relation`s on BOTH sides (the FK-drift rule). Indexes: `[workspaceId]`, ' +
        '`[dashboardId, column, position]`.\n\n' +
        '**`lib/dashboards/widgetRegistry.ts`** — the TOTAL per-widget-type registry ' +
        '(mistake #29): each type (`filter_results`, `distribution`, ' +
        '`created_vs_resolved`) maps to a config Zod schema (validating the data source — ' +
        'exactly one of `savedFilterId`/`projectId` — plus per-type settings: page size ' +
        '≤50 / statistic-type id / period + days-back + cumulative), a data-source ' +
        'resolver, and the renderer/editor kinds (the UI contract for 6.3.3/6.3.5). ' +
        'Unknown type or malformed config → typed 422; the enumeration test fails on any ' +
        'registry gap.\n\n' +
        '**`dashboardsService`** (4-layer; one method = one transaction): dashboard CRUD ' +
        '(create = any workspace member; rename/relayout/access-change/delete = ' +
        'owner-only — typed 403 otherwise), widget add/update/remove/move (validated ' +
        'through the registry; the 20-widget cap → typed 422; `move` takes ' +
        'column + neighbour ids and computes the fractional index server-side, the board ' +
        'precedent), and the reads — `listDashboards` (private-to-me + workspace-shared, ' +
        'bounded) and `getDashboard` (widgets ordered by column/position; access ' +
        'enforced: private + not owner → 404-shaped denial). Routes are HTTP-only under ' +
        '`app/api/dashboards/`; the finding-#26 workspaceId gate covers every route. ' +
        '**Fill the reserved 6.2.1 dependents line:** extend the saved-filter ' +
        'delete-dependents enumeration with the widget FK join (the Cloud-style warning ' +
        'now counts "N dashboard widgets" alongside subscriptions — the line 6.2.2\'s ' +
        'warning design reserved); the delete itself stays `SetNull` (the widget goes ' +
        'STALE, the verified Cloud gadget behaviour — it never cascades).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The migration applies cleanly (re-run: no drift); both FKs are two-sided ' +
        '`@relation`s; deleting a saved filter nulls `savedFilterId` (stale, not gone); ' +
        'deleting a project cascades its project-sourced widgets; the 6.2.1 ' +
        "delete-dependents read counts the filter's widgets (asserted: the warning DTO " +
        'names N widgets before a delete that stales them).\n' +
        '- The registry is total over the three types (enumeration test: every type has ' +
        'schema × resolver × renderer-kind × editor-kind); unknown types/configs → 422; ' +
        'the data-source XOR is enforced.\n' +
        '- CRUD honours the permission matrix (member create / owner-only mutate / ' +
        'private invisible to non-owners — each asserted both service- and route-level); ' +
        'the widget cap holds; move produces stable fractional orderings under ' +
        'concurrent-ish sequences (the 3.2 test pattern).\n' +
        "- Reads are bounded (list ≤ a sane page; get loads one dashboard's ≤20 " +
        'widgets); empty-input guards on the new repo methods (coverage gate); ' +
        '`pnpm test:coverage` ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- 6.2.1 (the `saved_filter` table the FK references + the delete-dependents ' +
        'enumeration this extends — its "6.3 widgets join in by FK later" line)\n' +
        '- `lib/workItems/positioning.ts` + the 3.2 move-service pattern (fractional ' +
        'index, server-computed)\n' +
        '- `motir-core/CLAUDE.md` (4-layer, required-`tx`, FK/migration rules); ' +
        'finding #26 (workspace gate); `lock-before-read-derived-update` (the move tx)\n' +
        '- The verified Jira dashboard facts in the Story 6.3 description (ownership/' +
        'sharing/layout/cap)',
    },
    {
      id: '6.3.2',
      title:
        'Report + widget data reads — created-vs-resolved buckets, distribution group-by (TOTAL statistic registry), filter-results page; per-VIEWER 6.4 gating',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 32,
      dependsOn: ['4.6.3', '6.1.2', '6.2.1'],
      descriptionMd:
        'The aggregation reads every widget and report page consumes — extending ' +
        '**`reportsService`** (the home 4.6.3 creates). Pure backend.\n\n' +
        '**`getCreatedVsResolved(scope, { period, daysBack, cumulative })`** — scope = ' +
        '`{ projectId } | { savedFilterId }` (the filter resolves through THE 6.2.1 ' +
        'resolve-by-id contract — decode + registry-validate via 6.1.1, never ' +
        'trust-and-compile — into the WHERE fragment the buckets scope to). Two series: **created** = `createdAt` bucketed by ' +
        'day/week/month over the days-back window; **resolved** = NET transitions into a ' +
        '`done`-category status (`getTerminalStatusKeys` — the recorded deviation: our ' +
        'resolution IS the done category) derived from the **1.4.6 revision trail** via ' +
        'ONE bounded grouped `$queryRaw` (the 4.6.3 pattern; a reopen inside the window ' +
        'subtracts). `cumulative: true` running-sums within the window server-side. ' +
        'Window capped (e.g. ≤366 days, ≤120 buckets) → typed 422 beyond.\n\n' +
        '**`getDistribution(scope, statisticType)`** — a bounded GROUP-BY count over the ' +
        'scoped items, through a **TOTAL statistic-type registry**: the enum-ish field ' +
        'vocabulary the 6.1 registry already enumerates (kind, status, priority, ' +
        'assignee, reporter, sprint, label, component, select-CF `cf:<id>`, user-CF) — ' +
        'label/component/CF group-bys ride the SAME 5.3.1/5.4.1 indexed joins 6.1.2 ' +
        'compiles (one item counted once per label ⇒ multi-label items appear in ' +
        'multiple segments, the Jira behaviour — documented); unknown statistic ids → ' +
        '422. Returns segments (id, label, count, percentage) + the total; a NULL group ' +
        'surfaces as the designed "None" segment.\n\n' +
        '**`getFilterResultsPage(scope, page, pageSize ≤ 50)`** — rides the EXISTING ' +
        '2.5.8/2.5.12 list read + count with the compiled fragment (no second query ' +
        'path; the verified 50/page gadget cap enforced server-side).\n\n' +
        '**Per-VIEWER gating (the 6.4 seam).** Every read resolves access for the ' +
        'REQUESTING user: a project-sourced scope checks 6.4 project access; a ' +
        'filter-sourced scope rides the 6.2.1 resolve (already behind the 6.4 browse ' +
        'gate + filter visibility for the CALLER — pass the viewer, never the owner). ' +
        'Denied → a typed no-access result (the widget state), NEVER partial ' +
        'data or a leaked count. Stale referents (deleted filter/project/statistic ' +
        'referent) → the typed stale result (the 6.1.2 unknown-value precedent).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The bucket matrix holds against seeded revisions at known dates: ' +
        'day/week/month × cumulative × reopens (net), window edges inclusive, ' +
        'created-vs-resolved reconciles with the seeded counts; the resolved derivation ' +
        'is ONE bounded grouped query (no all-revisions load — asserted on the large ' +
        'seed via query inspection + a timing sanity bound).\n' +
        '- The statistic registry is total (enumeration test over every entry incl. ' +
        'dynamic CF entries); each group-by rides the indexed joins (EXPLAIN ' +
        'spot-checks); percentages sum to 100±rounding; the None segment + multi-label ' +
        'multi-count behaviours are asserted.\n' +
        '- Filter-results pages exactly match the /issues list for the same filter ' +
        '(parity test) at ≤50/page.\n' +
        '- Per-viewer gating: the no-access matrix (private project × workspace-shared ' +
        'dashboard × viewer/non-viewer) is asserted route-level; stale referents → ' +
        'typed stale results; window/bucket caps → 422.\n' +
        '- Routes HTTP-only; empty-input guards on new repo aggregates; ' +
        '`pnpm test:coverage` ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- 4.6.3 `reportsService` + `workItemRevisionRepository.aggregate*` (the ' +
        'bounded grouped-derivation pattern + the done-category predicate via ' +
        '`getTerminalStatusKeys`)\n' +
        '- 6.1.1/6.1.2 (the compiled WHERE fragment + the 5.3.1/5.4.1 join contracts ' +
        'the group-bys reuse); 6.2.1 (the resolve-by-id data-source contract — the ' +
        'service JSDoc written for this story)\n' +
        '- 6.4 project-access service (the per-viewer gate); finding #26\n' +
        '- The verified Jira report configs in the Story 6.3 description; findings ' +
        '#57 (bounded), #29 (total registries)',
    },
    {
      id: '6.3.3',
      title:
        'Design — dashboards + reports hub (`design/reports/dashboard.mock.html`: grid, widget chrome, add/config panels, donut + diff-area charts, report pages)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 40,
      dependsOn: ['6.2.2'],
      descriptionMd:
        'The design asset for every 6.3 surface. `design/reports/charts.mock.html` ' +
        '(4.6.1) designs ONLY the chart visual language + burndown/velocity — the ' +
        'dashboard surface, the two new chart FORMS (donut, two-series ' +
        'difference/area), and the Reports hub + report pages are undesigned (the ' +
        'design-gate NONE-exists case). The "filter missing" widget card + the ' +
        'saved-filter picker vocabulary come from 6.2.2 (carried in `dependsOn` — ' +
        "inherit, don't redraw). Output: **`design/reports/dashboard.mock.html`** " +
        '+ PNG + a design-notes section appended to `design/reports/design-notes.md`. ' +
        'Built FROM the real design system (the 4.6.1 convention — `--el-*`/' +
        '`--el-chart-*` + shape tokens, shipped `Card`/`Modal`/`Combobox`/`EmptyState`/' +
        '`ErrorState`/`Pill` + the 2.5 issue-row vocabulary). Render checklist + AA + ' +
        'dark parity. Mirrors: the verified Jira dashboard/gadget grammar; the 4.6.1 ' +
        'chart language for everything chart-shaped.\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **Dashboards home (/dashboard)** — the dashboards list (mine + ' +
        'workspace-shared, owner + access badges), create (name + access), the empty ' +
        'state ("create your first dashboard"), and the switcher between dashboards.\n' +
        '- **The dashboard grid** — view vs EDIT mode (the Jira split): the column ' +
        'layout picker (1/2/3), widget cards in the `Card` chrome (title, source line ' +
        '— filter or project name —, the per-type body, the overflow menu: configure / ' +
        'remove), drag affordances + drop targets between/within columns (the 3.2 ' +
        'dnd-kit vocabulary), the 20-widget cap state, and the add-widget picker (the ' +
        'three types with thumbnails + one-line descriptions).\n' +
        '- **Widget config panels** — per type, driven by the registry editor kinds: ' +
        'the data-source control (saved filter Combobox — the 6.2 list — OR the ' +
        'project; exactly one), filter-results (page size ≤50), distribution (the ' +
        'statistic-type Combobox), created-vs-resolved (period segmented control, ' +
        'days-back stepper, cumulative toggle).\n' +
        '- **The widget bodies** — filter-results: the compact issue table (fixed ' +
        'columns: key, title, kind glyph, status Pill, priority, assignee avatar; the ' +
        '2.5 row vocabulary at gadget density) + its pager; distribution: the **donut** ' +
        '(a NEW chart form in the 4.6.1 language: same frame/legend grammar, counts + ' +
        'percentages in a visible text legend — colour never the sole signal) with a ' +
        'segment-hue note (`--el-chart-*` growth: a small categorical ramp, dark-parity ' +
        'checked); created-vs-resolved: the **two-series difference/area** form (created ' +
        'vs resolved lines, the red/green difference fill per the verified mirror, the ' +
        'cumulative variant).\n' +
        '- **Widget states** — loading skeleton, error (`ErrorState`), empty (zero ' +
        'matching issues), **no-access** (the 6.4 per-viewer state: a locked card, no ' +
        'counts), and **stale** — the "filter missing" degraded card **6.2.2 already ' +
        "designed for exactly this surface: INHERIT it (reference, don't redraw), " +
        'adding only the in-grid reconfigure affordance**.\n' +
        '- **Reports hub (/reports)** — the grouped index the stub page becomes: the ' +
        'agile group (burndown / velocity / sprint report — link cards into the ' +
        'SHIPPED surfaces, referenced greyed, never redrawn) + the analysis group ' +
        '(created-vs-resolved, status distribution).\n' +
        '- **The two report pages** — full-form chart + the config controls (the same ' +
        'registry editor kinds as the widget panels, page-level: scope, period/' +
        'days-back/cumulative; statistic type), the zero-data state, and the a11y ' +
        'visually-hidden data-table note (the 4.6.1 pattern).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The mockup + PNG + notes exist, composed from shipped primitives + the ' +
        '4.6.1 chart language; render checklist + AA + dark parity pass (incl. the new ' +
        'categorical donut ramp).\n' +
        '- Panels cover: dashboards home + create + empty, grid view/edit + layouts + ' +
        'drag + cap + add-picker, all three config panels, all three widget bodies, ' +
        'every widget state (loading/error/empty/no-access/stale), the Reports hub, ' +
        'and both report pages.\n' +
        '- `design-notes.md` names the widget-type ↔ registry editor/renderer mapping ' +
        '(the 6.3.1 UI contract), the new `--el-chart-*` categorical tokens, the ' +
        'donut + difference-area specs the 6.3.4 primitives build, and records the ' +
        'extension slots (audiences, wallboard, refresh, more gadgets).\n' +
        '- No improvised primitive; token needs recorded.\n\n' +
        '## Context refs\n\n' +
        '- `design/reports/charts.mock.html` + `design-notes.md` (4.6.1) — the chart ' +
        'language + a11y pattern this extends\n' +
        '- `design/work-items/saved-filters.mock.html` (6.2.2) — the "filter missing" ' +
        'degraded card this surface inherits + the filter-picker vocabulary\n' +
        '- `design/work-items/list.mock.html` (the issue-row vocabulary the ' +
        'filter-results body compacts); `design/boards/` (the dnd drag/drop grammar)\n' +
        '- The verified Jira dashboard/gadget/report facts in the Story 6.3 ' +
        'description\n' +
        '- Findings #35/#54; the design-mockup render checklist; ' +
        '`can-render-ui-headless`',
    },
    {
      id: '6.3.4',
      title:
        'Chart primitives — donut + two-series difference/area forms in the 4.6.2 token-aware SVG layer (+ the categorical `--el-chart-*` ramp)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 26,
      dependsOn: ['4.6.2', '6.3.3'],
      descriptionMd:
        'The two chart forms 6.3 needs, grown INSIDE the 4.6.2 primitive layer (same ' +
        'shared frame, axis/legend grammar, a11y pattern — no charting library, the ' +
        'recorded decision). Per the 6.3.3 design.\n\n' +
        '**Donut** — segments from `(label, count, percentage)` data; the visible text ' +
        'legend with counts + percentages (colour never the sole signal — finding ' +
        '#35); hover/focus segment emphasis; the None segment styling; bounded segment ' +
        'count with the designed overflow treatment ("+N more" rolled into the ' +
        'legend). **Difference/area** — two series over time buckets; the red/green ' +
        'difference fill between them (the verified mirror semantics) via the ' +
        '`--el-chart-*` danger/success-mapped tokens; the cumulative variant is just ' +
        'data (no separate form); reuses the 4.6.2 axes/gridlines/ticks.\n\n' +
        '**Tokens** — ADD the categorical ramp (`--el-chart-cat-1..n`) + the ' +
        'created/resolved series tokens to `globals.css` Tier 3 per the growth pattern ' +
        '(mistake #20), mapped to existing `--color-*`, dark-parity inherited; extend ' +
        'the `/tokens` chart specimen (the 4.6.2 pattern) with both forms.\n\n' +
        '**A11y** — both forms carry the 4.6.1 pattern: the visually-hidden data ' +
        'table mirroring the series/segments, `role="img"` + a generated summary ' +
        'label.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Both forms render from data props alone (pure presentational, ' +
        'SSR-friendly), match the 6.3.3 spec panel-for-panel, and compose the 4.6.2 ' +
        'frame (no duplicated axis/legend code).\n' +
        '- All colour via `--el-chart-*` (the new tokens added to Tier 3 + the dark ' +
        'flip verified); shape via element tokens; the /tokens specimen shows both ' +
        'forms light + dark.\n' +
        '- The donut overflow treatment caps segments; zero-data renders the designed ' +
        'empty treatment (never NaN geometry).\n' +
        '- Unit tests over the geometry helpers (arc math, difference-fill ' +
        'segmentation, bucket scaling) + the hidden-table rendering; ' +
        '`pnpm test:coverage` ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- The 4.6.2 chart primitives + `--el-chart-*` Tier-3 block + the /tokens ' +
        'chart specimen — the layer this grows\n' +
        '- `design/reports/dashboard.mock.html` + notes (6.3.3) — THE authority for ' +
        'both forms\n' +
        '- `motir-core/CLAUDE.md` (token tiers, the growth pattern); findings ' +
        '#35/#54\n' +
        '- The 4.6.1 chart a11y pattern (hidden data table)',
    },
    {
      id: '6.3.5',
      title:
        'Dashboards UI at /dashboard — list/create/switch, the grid (view/edit, layouts, dnd), widget add/config/remove, the three widget renderers + all states',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 38,
      dependsOn: ['6.3.1', '6.3.2', '6.3.3', '6.3.4'],
      descriptionMd:
        'The dashboard surface, per the 6.3.3 design, replacing the 1.1.2 smoke ' +
        'landing at `/dashboard` (its projects-empty branch moves with it — the ' +
        'page-comment contract).\n\n' +
        '**Build:** the dashboards home (list mine + workspace-shared with owner/' +
        'access badges, create modal, empty state, switcher); the grid — view vs edit ' +
        'mode, the 1/2/3-column layout picker, widget `Card` chrome, drag between/' +
        'within columns via the 3.2 dnd-kit vocabulary (server-computed fractional ' +
        'positions through the 6.3.1 move endpoint; optimistic with rollback — the ' +
        'board pattern), the add-widget picker, per-type config panels DRIVEN BY THE ' +
        'REGISTRY (the UI renders registry editor kinds — it never hard-codes the ' +
        'widget-type list; a registry addition appears with zero UI changes), remove ' +
        'w/ confirm, the 20-widget cap state. **The three renderers** consume the ' +
        '6.3.2 reads: filter-results (the compact 2.5-vocabulary table + pager, ' +
        '≤50/page), distribution (the 6.3.4 donut), created-vs-resolved (the 6.3.4 ' +
        'difference/area) — each wrapped in the designed loading / error / empty / ' +
        '**no-access** / **stale** states (per-widget isolation: one failing widget ' +
        'never takes down the grid). Owner-only edit affordances; viewers get the ' +
        'read-only grid. Strings via next-intl (the threading pattern).\n\n' +
        '**A11y:** widgets are labelled regions; the grid is keyboard-traversable; ' +
        'drag has the dnd-kit keyboard path (the 3.2 precedent); config panels are ' +
        'proper dialogs; charts expose their hidden tables; extends the strict sweep.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The surface matches the design panel-for-panel (home, grid view/edit, ' +
        'layouts, dnd, picker, all three config panels, all three renderers, every ' +
        'widget state); drag persists + survives reload; the cap + confirm flows ' +
        'work.\n' +
        '- Config panels render from the registry (asserted with a test-only registry ' +
        'entry); the data-source XOR is enforced in the UI; stale + no-access render ' +
        'per design (and never leak data).\n' +
        '- Owner/viewer affordance split holds; private dashboards invisible to ' +
        'others (route + UI).\n' +
        '- Axe-clean; token tiers only; next-intl; integration tests over the grid ' +
        'wiring, registry-driven panels, optimistic move + rollback; coverage ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- `design/reports/dashboard.mock.html` + notes (6.3.3) — THE authority\n' +
        '- 6.3.1 (CRUD/move API + registry UI contract); 6.3.2 (the widget reads); ' +
        '6.3.4 (the chart forms)\n' +
        '- The 3.2 board dnd + optimistic-move pattern; ' +
        '`portal-popover-breaks-in-radix-dialog` (config-panel pickers)\n' +
        '- `app/(authed)/dashboard/page.tsx` (the smoke landing this replaces — keep ' +
        'the projects-empty branch); the i18n threading pattern',
    },
    {
      id: '6.3.6',
      title:
        'Reports hub at /reports + the two built-in report pages (created-vs-resolved, status distribution) with the verified Jira configs',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['6.3.2', '6.3.3', '6.3.4'],
      descriptionMd:
        'The project Reports surface, per the 6.3.3 design, replacing the Epic-6 stub ' +
        'page at `/reports` (the surface 4.6 explicitly deferred here).\n\n' +
        '**Build:** the hub — the grouped index (agile group: burndown / velocity / ' +
        'sprint-report link cards into the SHIPPED surfaces; analysis group: the two ' +
        'report pages); **Created vs Resolved** (`/reports/created-vs-resolved`) — ' +
        'scope control (the active project by default, or a 6.2 saved filter), period ' +
        '+ days-back + cumulative controls (URL-driven params, the shipped ' +
        '?view/?sort convention, so a configured report is shareable), the 6.3.4 ' +
        'difference/area chart + the designed zero-data state; **Status distribution** ' +
        '(`/reports/distribution`) — the statistic-type picker + scope control, the ' +
        '6.3.4 donut + legend. Both pages share the registry editor kinds with the ' +
        '6.3.5 config panels (one control vocabulary, two hosts). Per-viewer gating ' +
        'surfaces the designed no-access state (a filter over a project the viewer ' +
        "can't see). Strings via next-intl.\n\n" +
        '**A11y:** the hub cards + both pages pass the strict sweep; charts expose ' +
        'the hidden tables; controls keyboard-complete.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The hub matches the design (both groups; agile cards LINK, never redraw); ' +
        'the stub page is gone.\n' +
        '- Both report pages match the design; config state round-trips through the ' +
        'URL (reload/share restores); charts track the controls live; zero-data + ' +
        'no-access + stale-filter states render per design.\n' +
        '- The resolved series demonstrably tracks done-category transitions (resolve ' +
        '+ reopen an issue → the bucket nets correctly — the E2E hook 6.3.7 ' +
        'automates).\n' +
        '- Axe-clean; token tiers only; next-intl; integration tests over the ' +
        'control↔URL↔read wiring; coverage ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- `design/reports/dashboard.mock.html` + notes (6.3.3) — THE authority (hub ' +
        '+ report-page panels)\n' +
        '- 6.3.2 (the reads + configs); 6.3.4 (the chart forms); the 2.5.8/2.5.12 ' +
        'URL-param conventions\n' +
        '- `app/(authed)/reports/page.tsx` (the stub this replaces); the 4.6.5/4.6.6 ' +
        "mounted chart surfaces (the agile links' targets)\n" +
        '- The verified Jira report configs in the Story 6.3 description; the i18n ' +
        'threading pattern',
    },
    {
      id: '6.3.7',
      title:
        'Story tests — aggregation matrices + permission/no-access matrix + the dashboard E2E journey + the reports E2E + a11y sweeps',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['6.3.5', '6.3.6'],
      descriptionMd:
        'The story-closing verification (Principle #18; the epic-wide journey stays ' +
        'Story 6.7).\n\n' +
        '**Vitest (integration, real Postgres):** the **bucket matrix** ' +
        '(day/week/month × cumulative × reopen-nets × window edges, against seeded ' +
        'revisions at known dates; large-seed boundedness assertions); the ' +
        '**statistic matrix** driven FROM the registry (every entry incl. dynamic CF ' +
        'entries — a new entry without a case fails, the totality-guard pattern); ' +
        'filter-results/issues-list **parity**; the **permission matrix** (owner / ' +
        'member / non-member × private / workspace × project-sourced / ' +
        'filter-sourced → data / 404 / no-access, route-level); stale-referent ' +
        'matrix (deleted filter / project / statistic referent); widget CRUD + move ' +
        'ordering properties; the registry enumeration guards (widget types + ' +
        'statistic types).\n\n' +
        '**Playwright E2E (`tests/e2e/dashboards.spec.ts`):** the recipe journey — ' +
        'create a dashboard, add all three widget types (filter + project sourced), ' +
        'configure each, switch layout, drag a widget across columns, reload ' +
        "(persistence), share-to-workspace + verify the second user's read-only + " +
        'no-access states, delete the backing filter → stale state. ' +
        '**(`tests/e2e/reports.spec.ts`):** the hub → both report pages → configure ' +
        '→ resolve + reopen an issue → the created-vs-resolved bucket nets; the ' +
        'distribution donut tracks a status change. **a11y:** the strict sweep over ' +
        'the grid (edit mode, a config panel open, every widget state visible) + ' +
        'both report pages.\n\n' +
        '## Acceptance criteria\n\n' +
        '- All matrices green; boundedness + parity + permission assertions hold; ' +
        'the registry-driven suites fail on any uncovered entry.\n' +
        "- Both E2E journeys pass green in CI's Playwright lane; the sweeps report " +
        'zero violations.\n' +
        '- The Story 6.3 verification recipe runs clean top to bottom; ' +
        '`pnpm test:coverage` keeps all 6.3 files ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- The 6.1.6 matrix/totality-guard pattern; the 5.6 at-scale fixture ' +
        'conventions\n' +
        '- `tests/e2e/` harness + selector memories (`prodect-e2e-selector-gotchas`, ' +
        '`board-e2e-dnd-at-scale-gotchas` — the dnd drag step)\n' +
        '- The Story 6.3 verification recipe — the checklist this automates\n' +
        '- Story 6.7 (the epic-wide remainder — do not duplicate)',
    },
  ],
};
