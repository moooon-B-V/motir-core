import type { PlanStory } from '../types';

/**
 * Story 2.5 — Issue list view.
 * Faithful transcription of prodect_plan/story-2.5-issue-list.html (frozen archive).
 */
export const story_2_5: PlanStory = {
  id: '2.5',
  title: 'Issue list view',
  status: 'in_progress',
  descriptionMd:
    'The project\'s issue index — the surface the sidebar "Issues" link opens (today a stub). Per the ' +
    'shipped mockup `design/work-items/tree.png` this is a **hierarchical tree-table**: ' +
    'a Server-Component route at `/issues` that lists every non-archived issue in the active ' +
    'project nested by parent (epic → story → task → sub-task, with bugs in place), each row carrying its ' +
    'type icon · `PROD-N` identifier · title (tree-indented, expand/collapse), assignee, and a ' +
    'status pill. Above the table: an **"Issues" header** + the "all issues in {project}" ' +
    'subtitle, a **Filter** affordance (kind · status · assignee · text), a **"Tree" ' +
    'view-switcher**, and the **"New issue"** trigger (reuses 2.3.3\'s ' +
    '`CreateIssueModal`). Rows support **inline status + assignee edits** (the same ' +
    'gated controls the detail page uses), plus the drawn **empty state** and **loading ' +
    "skeleton**. This is the precursor surface Epic 6's search + saved filters extend.\n\n" +
    '**Prerequisites:** Tree-table design EXISTS; the two undrawn seams each get a design subtask ' +
    '(the design-reference rule / notes.html mistake #31). ' +
    'The tree-table mockup was drafted in the 2.3 design pass and lives under its area at ' +
    '`design/work-items/tree.png` (+ `tree.pen`, frames `table` / `list-tree` / `table (skeleton)`). ' +
    'But `tree.png` draws the `[Filter]` and `[Tree ▾]` controls only in their *disabled, closed* state — ' +
    'their **expanded surfaces are undrawn**, so each gets its own design subtask before its code can ' +
    'build: **2.5.7** designs the List view + switcher menu (gating 2.5.8), and **2.5.9** ' +
    'designs the open filter-bar popover (gating 2.5.4). Every UI subtask below carries its design reference in ' +
    'CONTEXT and MUST match its layout: the `[Filter]` · ' +
    '`[Tree ▾]` · `[+ New issue]` toolbar, the **TITLE / ASSIGNEE / STATUS** ' +
    'three-column tree-table with type icon + identifier + indented title, the centered empty state, and the ' +
    'skeleton. Reuse the named primitives (`Card`, `Pill`, `Button`, ' +
    '`Combobox`, `Popover`, `EmptyState`, `Spinner`, ' +
    '`IssueTypeIcon`) and the `--el-*` element tokens (never Tier-0 `--color-*` / ' +
    '`text-foreground` — `prodect-core/CLAUDE.md`); issue-type icons take their type hue ' +
    'via `IssueTypeIcon`, status goes through `Pill` tones (finding #35 AA-safe).\n\n' +
    '**Read-mostly & reconciled with shipped reality (decision-authority rung 2 > rung 3).** ' +
    'Story 1.4 already ships the reads this Story composes: `workItemRepository.findByProjectFiltered` ' +
    '(flat, non-archived, `key asc` — kind/status/assignee filters) + `findSubtree` ' +
    '(recursive CTE) + `workItemsService.listWorkItems`. The two write affordances (inline status / ' +
    "assignee) add NO new mutation primitives — they reuse 2.2.4's gated `updateStatus` (via 2.4.4's " +
    "`changeStatusAction`) and 2.3.6's status-free `updateWorkItem` (via " +
    '`updateIssueAction`), and the shared `StatusPicker` / `AssigneePicker`. ' +
    'The "New issue" button reuses 2.3.3\'s `CreateIssueModal` / `CreateIssueProvider` (no ' +
    'second create path). All routes follow the 4-layer architecture and carry an explicit ' +
    '`workspaceId` gate at the read layer (**finding #26** — the shipped ' +
    '`findByProjectFiltered` filters only `projectId`; 2.5.1 ADDS the workspace filter, ' +
    'since RLS is inert under the dev/CI superuser until the Epic-8 cutover). Route reconciliation (finding ' +
    '#50): the list lives at `app/(authed)/issues/page.tsx` resolving the active project via ' +
    '`getActiveProject()`, NOT a card-illustrative `/projects/[key]/issues`.\n\n' +
    '**Card-vs-design reconciliation (the design is the layout authority).** The Epic-2 card calls ' +
    'this "a sortable table … with column controls." The shipped mockup draws a *hierarchical tree-table* ' +
    'with a fixed **TITLE / ASSIGNEE / STATUS** column set, a `[Filter]` button, and a ' +
    '`[Tree ▾]` **view-switcher** — no per-column sort arrows and no column show/hide ' +
    'menu. v1 ships the **Tree view exactly as drawn**; 2.5.3 renders the `[Tree ▾]` ' +
    'control **disabled** (only "Tree") as a forward-compatible seam. Making that switcher work — ' +
    'the **flat, sortable "List" mode** behind it — is now its own planned work: **2.5.7** ' +
    "designs the List view + switcher menu (the design gate: `tree.png` doesn't specify them), and " +
    '**2.5.8** wires the control (Tree ↔ List + single-column sort, URL-driven). **Saved / ' +
    'named views, multi-sort, and column show/hide config stay Epic 6** (saved views & advanced ' +
    'search) — not invented here (no complexity for nothing).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install && pnpm prisma generate && pnpm prisma migrate dev` ' +
    'against a fresh local DB (no new migration expected — this Story is read-first; the only writes reuse shipped mutation paths).\n' +
    '- `pnpm test` — Vitest covers: `getProjectTree` nesting + ancestor-retained filter + cross-workspace isolation (2.5.1); ' +
    '`TreeTable` nesting/expand/keyboard (2.5.2); page data-shaping (2.5.3); filter callback + URL state (2.5.4); ' +
    'inline cell opens shared picker + calls shared action (2.5.5).\n' +
    '- `pnpm test:e2e` — `issue-list-flow` (2.5.6) + the shell-a11y sweep on `/issues`.\n' +
    '- **Manual UX check — render:** open "Issues"; confirm the tree-table matches `tree.png` ' +
    '(type icons, identifiers, indented titles, expand chevrons on parents only, assignee, status pills, ' +
    'the Filter / Tree / New-issue toolbar).\n' +
    '- **Manual UX check — interact:** expand/collapse rows; filter by kind/status/assignee/text ' +
    "(ancestors stay for context; URL updates + reloads safely); change a row's status inline " +
    '(only legal targets; illegal rejected); reassign + unassign inline; click a row → its detail page; ' +
    'a row\'s quick-view button opens the item in a modal (a "peek") with an "Open full page" link to its detail page; ' +
    '"New issue" opens the create modal.\n' +
    '- **Empty + loading:** a fresh project shows "No issues yet"; the table shows the skeleton while loading.\n' +
    "- **Cross-workspace check:** as a workspace-A-only user, the workspace-B project's issues never appear at `/issues`.\n" +
    '- **Scale check (finding #57) — `pnpm db:seed:large` (2.5.16):** seed the large project, open it at `/issues`. ' +
    '*List:* the footer shows "1–50 of N" and Next/Prev/page-jump move through pages (the page doesn\'t render all N rows). ' +
    "*Tree:* a collapsed parent shows a chevron but its children aren't loaded; expanding lazy-loads them (a brief loading row); " +
    'a parent with >50 children shows "Load more children"; scrolling a deeply-expanded tree stays smooth ' +
    '(virtualized — the DOM row count stays bounded). Confirms the issue index survives a real backlog, not just a demo.',
  items: [
    {
      id: '2.5.1',
      title: 'Project issue-tree read — `getProjectTree` + workspace gate + filter',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 18,
      descriptionMd:
        'The read that backs the whole list: every non-archived issue in a project, assembled into the ' +
        'nested **forest** the tree-table renders. New ' +
        '`workItemsService.getProjectTree(projectId, filter, ctx)` returning ' +
        '`WorkItemTreeNodeDto[]` — roots ordered by `key` asc, each node carrying its ' +
        'children (same order) plus the columns the rows show: `kind`, `identifier`, ' +
        '`title`, `status`, `assigneeId`, `depth`, and ' +
        "`hasChildren`. Reuses Story 1.4's recursive-CTE pattern: add a " +
        '`workItemRepository.findProjectForest(projectId, workspaceId, filter?)` single-op read ' +
        '(one round-trip, no N+1), then the service nests the flat rows by `parentId` preserving ' +
        'sibling `key` order. Map to DTOs in `lib/mappers/workItemMappers.ts`.\n\n' +
        '**Explicit workspace gate (finding #26).** The shipped ' +
        '`findByProjectFiltered` filters only `projectId` + `archivedAt`; ' +
        'the forest read carries an EXPLICIT `workspaceId` on both the anchor and the recursive ' +
        'step (mirrors `findByProjectAndKinds` / `findAncestors`) so a cross-workspace ' +
        "row can't leak even with RLS inert. The service resolves the project's tenant and rejects a " +
        'cross-tenant `projectId` (reuse `ProjectNotFoundError` → 404, the ' +
        'existing no-existence-leak shape).\n\n' +
        '**Filter semantics — context-preserving.** The optional filter (kind · status · ' +
        'assigneeId · case-insensitive text on identifier+title) matches rows, but a matching DESCENDANT ' +
        'RETAINS its ancestors (rendered muted/non-matching) so the tree stays navigable — the standard ' +
        'tree-filter behavior, not a flat `WHERE` that orphans children. Text search is a scoped ' +
        '`contains` (identifier + title only) — full-text / cross-project search is Epic 6, not ' +
        'this Story.\n\n' +
        '## Acceptance criteria\n\n' +
        "- `getProjectTree` returns the project's non-archived issues nested by parent, roots and siblings ordered by `key` asc, each node exposing kind/identifier/title/status/assigneeId/depth/hasChildren.\n" +
        '- The forest read carries an explicit `workspaceId` filter on anchor + recursive step; a cross-workspace `projectId` 404s (no row/title leak).\n' +
        '- A filter (kind/status/assignee/text) returns matching rows AND their ancestor chain for context; an empty project returns `[]`; a no-filter call returns the full forest.\n' +
        '- One DB round-trip (recursive CTE), no N+1; archived items excluded; depth bounded by the Story-1.4 cap.\n' +
        '- Vitest (real Postgres): nesting + sibling order at depth ≥3, ancestor-retention under a descendant-matching filter, cross-workspace isolation at the repo layer, empty project.\n\n' +
        '## Context refs\n\n' +
        '- `workItemRepository.findSubtree` / `findAncestors` (1.4 / 2.4.3) — recursive-CTE + dual-side `workspaceId` pattern to mirror\n' +
        "- `findByProjectFiltered` + `listWorkItems` + `WorkItemSummaryDto` — the flat read this generalizes (reconcile, don't duplicate)\n" +
        '- `lib/mappers/workItemMappers.ts`, `lib/dto/workItems.ts`, `ProjectNotFoundError`\n' +
        '- `prodect-core/CLAUDE.md` — 4-layer · single-op repo · finding-#26 workspace gate',
    },
    {
      id: '2.5.2',
      title: '`components/ui/TreeTable` primitive (accessible tree-grid)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 18,
      descriptionMd:
        'The reusable, design-system primitive the list route composes — there is NO table primitive in ' +
        '`components/ui/*` today (JobsDashboard / WorkflowEditor each hand-roll a local ' +
        '`<table>`; this is the shared one). A generic, presentational ' +
        '`TreeTable`: typed `columns` (header + per-row `cell` render) and a ' +
        'nested `rows` model with expand/collapse, indentation by depth, a per-row chevron ' +
        '(leaf rows show none — matching the mockup), sticky header, and a whole-row link target. Pure ' +
        'presentation: it takes already-shaped data + render-props and emits no queries.\n\n' +
        '**Accessibility is the load-bearing requirement.** Implement the WAI-ARIA ' +
        '**treegrid** pattern: `role="treegrid"`, rows with `aria-level` / ' +
        '`aria-expanded` / `aria-posinset` / `aria-setsize`, roving focus, ' +
        'and keyboard support (Up/Down move, Right expand / move-in, Left collapse / move-out, Enter opens ' +
        'the row). Themed entirely off `--el-*` tokens (header text `--el-text-secondary`, ' +
        'row hover `hover:bg-(--el-surface)` on the ROW not a page surface, borders ' +
        '`--el-border`); add a `/tokens/tree-table` specimen joined to the shell-a11y ' +
        "sweep. Match the mockup's spacing, the uppercase column captions, and the row density.\n\n" +
        '## Acceptance criteria\n\n' +
        '- Generic `TreeTable<Row>` with typed columns + nested rows; renders header + indented, expandable rows matching `tree.png` (chevron only on parents, type-icon/identifier/title in the TITLE cell via render-prop).\n' +
        '- Full treegrid a11y: `role="treegrid"`, `aria-level/expanded/posinset/setsize`, roving tabindex, arrow-key expand/collapse/move, Enter activates the row link; axe-clean on the specimen.\n' +
        '- Colours via `--el-*` only (no Tier-0 utilities); row hover tints the row, never a page surface (finding #35).\n' +
        '- Presentational only — no data fetching, no Server-Action imports; expand/collapse state is controllable by the consumer.\n' +
        '- Component test (happy-dom): nesting + indent, expand/collapse toggles children + `aria-expanded`, keyboard move/expand; `/tokens/tree-table` in the strict shell-a11y sweep.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/tree.png` (+ `tree.pen`) — layout / density / column captions (open it FIRST; inspect all 3 panels)\n' +
        '- `components/issues/ChildList.tsx` (2.4.3) + `ISSUE_TYPE_META` / `IssueTypeIcon` / `Pill` — the row vocabulary to reuse\n' +
        "- `components/ui/Combobox.tsx` (2.3.4) — the project's hand-rolled WAI-ARIA + roving-tabindex reference; `app/globals.css` `--el-*` tiers; `/tokens` route convention\n" +
        '- `prodect-core/CLAUDE.md` — `--el-*` token rule',
    },
    {
      id: '2.5.3',
      title: 'The `/issues` route — tree-table + header + toolbar + empty/loading',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['2.5.1', '2.5.2'],
      descriptionMd:
        'Replace the `ProjectStubPage` at `app/(authed)/issues/page.tsx` with the ' +
        'real surface. The Server Component resolves the active project (`getActiveProject()` → ' +
        '`/dashboard` if none), calls `getProjectTree` (2.5.1), and renders, top to ' +
        'bottom per `tree.png`: the **"Issues"** header + **"All issues in ' +
        '{project}"** subtitle; the toolbar — a `[Filter]` button (a disabled/placeholder ' +
        'shell here; wired in 2.5.4), the `[Tree ▾]` view-switcher (renders "Tree" as the ' +
        'active/only v1 mode — the documented seam for a future List mode), and the ' +
        "**[+ New issue]** button reusing 2.3.3's `CreateIssueModal` trigger; and " +
        'the **TreeTable** (2.5.2) with the three columns — TITLE (`IssueTypeIcon` + ' +
        '`identifier` + title, the whole row linking to `/issues/{identifier}`), ' +
        'ASSIGNEE (avatar + name, "Unassigned" empty), STATUS (`Pill` by category).\n\n' +
        '**Empty + loading states (mockup panels 2 & 3).** A project with no issues ' +
        'renders the centered `EmptyState` ("No issues yet" / "Create your first issue to start ' +
        'tracking work." / a New-issue CTA). A Suspense/loading boundary renders the skeleton table ' +
        '(header + shimmer rows) drawn in panel 3. Expand/collapse state is client-held (default: roots ' +
        'expanded one level, matching the mockup); no per-row persistence in v1.\n\n' +
        '## Acceptance criteria\n\n' +
        "- `/issues` renders the active project's issues as the nested TreeTable with TITLE/ASSIGNEE/STATUS exactly per `tree.png`; each row links to its `/issues/[key]` detail page; rows expand/collapse.\n" +
        '- Header + subtitle + the `[Filter]` · `[Tree ▾]` · `[+ New issue]` toolbar render; "New issue" opens 2.3.3\'s `CreateIssueModal` (no second create path); the view-switcher shows "Tree".\n' +
        '- An empty project renders the drawn `EmptyState`; a loading boundary renders the skeleton table.\n' +
        '- 4-layer + explicit workspace gate (the page never queries Prisma directly); colours via `--el-*`; type icons take their type hue, status via `Pill` tones.\n' +
        "- Vitest over the page's data shaping (real PG: project-scoped nesting, empty); the route joins the shell-a11y sweep in 2.5.6 (needs the seeded fixture that spec builds).\n\n" +
        '## Context refs\n\n' +
        '- `design/work-items/tree.png` — all 3 panels (populated · empty · skeleton)\n' +
        '- `app/(authed)/issues/page.tsx` (the stub to replace) + `_components/ProjectStubPage`; `getActiveProject()`; the 2.4.1 `/issues/[key]` detail page as the sibling/route convention\n' +
        '- 2.3.3 `CreateIssueModal` / `CreateIssueProvider` / `CreateIssueTrigger`; `EmptyState` / `Button` / `Pill` / `IssueTypeIcon`; 2.5.2 `TreeTable`; 2.5.1 `getProjectTree`\n' +
        '- `prodect-core/CLAUDE.md` — Server Component / 4-layer / `--el-*`',
    },
    {
      id: '2.5.4',
      title: 'Filter bar — kind · status · assignee · text (URL-driven)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 14,
      dependsOn: ['2.5.3', '2.5.9'],
      descriptionMd:
        'Wire the `[Filter]` affordance into a working filter bar over the tree: a ' +
        '`Popover` (or inline bar) exposing **kind** (issue-type multi-select), ' +
        "**status** (the project's workflow statuses), **assignee** (workspace " +
        'members + "Unassigned"), and a **text** quick-filter (identifier + title). Each filter ' +
        "feeds `getProjectTree`'s context-preserving filter (2.5.1) so matches keep their " +
        'ancestor chain.\n\n' +
        '**Durable shape: state lives in the URL.** Filters serialize to query params ' +
        '(e.g. `?kind=bug&status=in_progress&assignee=…&q=…`) so a filtered view is ' +
        'shareable / bookmarkable / reload-safe, and the Server Component reads them directly — this is the ' +
        "exact serialization **Epic 6's saved filters** will persist, so v1's filter URL is the " +
        'forward-compatible substrate, not a throwaway. A "clear filters" affordance resets to the full ' +
        'tree; an active-filter count shows on the Filter button. Reuse the shared pickers ' +
        '(`Combobox` / `StatusPicker` options source / member combobox) — no new ' +
        'picker components.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Filter by kind / status / assignee / text narrows the tree; a matching descendant keeps its ancestors visible; "Unassigned" is selectable; clear resets.\n' +
        '- Filter state is reflected in the URL query and is reload-/share-safe; the Server Component reads it and re-queries; the Filter button shows an active count.\n' +
        '- Pickers are the shared primitives (no parallel components); options come from the project workflow + workspace members already in context.\n' +
        '- Component test (happy-dom): toggling a filter updates the query + calls back; clear resets. (Tree re-query proven in 2.5.1; end-to-end in 2.5.6.)\n\n' +
        '## Context refs\n\n' +
        '- **Design reference (REQUIRED): `design/work-items/filter.mock.html` + `design-notes.md` — produced by the `type: design` subtask `2.5.9` (in `depends_on`); match its popover layout, the four filter groups, the active-count badge, and the clear affordance.**\n' +
        '- 2.5.1 `getProjectTree` filter contract; 2.5.3 route (where the bar mounts)\n' +
        '- `components/ui/Combobox` / `Popover`; `StatusPicker` option source; the workspace-member combobox used by `AssigneePicker`; `ISSUE_TYPE_META`\n' +
        '- `next/navigation` `useSearchParams` / `useRouter` URL-state pattern; the workflow-settings filter UI for prior art',
    },
    {
      id: '2.5.5',
      title: "Inline row edits — status + assignee (reuse 2.4.4's gated controls)",
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 10,
      dependsOn: ['2.5.3'],
      descriptionMd:
        'Make the STATUS and ASSIGNEE cells editable in place — the card\'s "inline status/assignee edits." ' +
        'This is a **reuse subtask, not new mutation work**: the STATUS pill opens the shared ' +
        "`StatusPicker` (legal next statuses from the row's workflow) committing via 2.4.4's gated " +
        '`changeStatusAction` → 2.2.4 `updateStatus`; the ASSIGNEE cell opens the ' +
        'shared `AssigneePicker` committing via `updateIssueAction` → the status-free ' +
        '`updateWorkItem` (null = unassign, writes a revision). Same components and Server Actions ' +
        "the detail page's `CoreFieldsPanel` (2.4.4) uses — identical gating (workspace + " +
        'membership; cross-workspace target 404s; no client-trusted ids).\n\n' +
        '**List-specific UX.** Editing commits optimistically and `revalidatePath`s ' +
        '`/issues` so the row reconciles without a full reload; an illegal/stale change surfaces ' +
        'the typed error as a toast and leaves the cell unchanged. Opening an inline control does NOT trigger ' +
        "the row's navigate-to-detail link (stop propagation). The status picker offers only legal targets " +
        "for THAT row's current status (per-row workflow context).\n\n" +
        '## Acceptance criteria\n\n' +
        "- A row's STATUS cell edits inline via the shared `StatusPicker` → `changeStatusAction` (legal targets only; illegal/stale → toast, no change); ASSIGNEE edits + unassigns via `AssigneePicker` → `updateIssueAction` (revision written).\n" +
        "- Both reuse 2.4.4's components + actions — NO parallel components or new actions; the list and detail page share them.\n" +
        '- Both are Server-Action-gated (workspace + membership); a forged cross-workspace target 404s; opening a control does not navigate the row.\n' +
        '- Commit is optimistic + revalidates the list; component test asserts the cell opens the shared picker and calls the shared action (legal-target listing covered by the shared 2.4.4 tests).\n\n' +
        '## Context refs\n\n' +
        '- 2.4.4 `CoreFieldsPanel` inline pattern + `changeStatusAction` / `updateIssueAction` (`app/(authed)/issues/[key]/edit/actions.ts`) — reuse verbatim\n' +
        "- 2.3.6 `StatusPicker` / `AssigneePicker`; 2.5.2 `TreeTable` cell render-props; 2.5.1 node DTO (each row's status + workflow context)\n" +
        '- `prodect-core/CLAUDE.md` — Server-Action gate / finding #26',
    },
    {
      id: '2.5.6',
      title:
        'Story E2E — render · expand · filter · inline edit · view-switcher · isolation + a11y',
      status: 'in_progress',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 15,
      dependsOn: ['2.5.3', '2.5.4', '2.5.5', '2.5.8', '2.5.12', '2.5.14', '2.5.15', '2.5.16'],
      descriptionMd:
        'The Story-closing Playwright spec that drives the real stack through the whole surface, plus the ' +
        'a11y gate. `tests/e2e/issue-list-flow.spec.ts`: seed a project with a multi-level tree ' +
        '(epic → story → task → sub-task + a bug), then assert — the tree renders project-scoped and nested ' +
        '(indent + identifiers + status pills); expand/collapse shows/hides descendants; filter by kind / ' +
        'status / assignee / text narrows the tree while keeping ancestors; an inline status change (legal) ' +
        'persists + an illegal one is rejected; an inline reassign + unassign persists; the empty state ' +
        'renders for a fresh project; a row click navigates to `/issues/[key]`; and ' +
        '**cross-workspace isolation** — a workspace-A user never sees workspace-B issues at ' +
        '`/issues`.\n\n' +
        '**View-switcher (2.5.8).** The spec also drives the `[Tree ▾]` control: ' +
        'switch **Tree → List** (the tree flattens, indentation/chevrons gone) and back; the ' +
        'choice round-trips through the URL (`?view=`) on reload/share; in List, clicking a ' +
        'sortable header re-orders the rows and updates `?sort=` (asc↔desc) with the active-sort ' +
        'indicator; the whole-row link still navigates in both views. (Per-row property columns — ' +
        'priority/assignee/reporter/due/estimate — render in both.)\n\n' +
        '**A11y.** Add BOTH `/issues` views (populated **Tree** AND ' +
        '**List**) to the STRICT shell-a11y axe sweep — the treegrid semantics from 2.5.2 and the ' +
        "List's sortable-header `aria-sort` (2.5.8) must hold on the real route. Reuse the shipped " +
        'E2E helpers (`shell-session.ts`, `workflow.ts`) and the create flow to build ' +
        'fixtures.\n\n' +
        '## Acceptance criteria\n\n' +
        '- E2E covers: nested render + expand/collapse, filter (kind/status/assignee/text, ancestor-retained), inline status (legal + illegal) and assignee (reassign + unassign), empty state, row→detail navigation, cross-workspace isolation.\n' +
        '- **View-switcher (2.5.8):** Tree↔List switch round-trips through `?view=` (reload/share-safe); List sort by a column header round-trips through `?sort=` (asc↔desc) and re-orders rows; the row link navigates in both views.\n' +
        "- BOTH `/issues` views (populated Tree AND List) join the strict shell-a11y sweep with zero violations — treegrid roles/levels (2.5.2) + the List's `aria-sort` headers (2.5.8) correct.\n" +
        '- **SCALE check — runs against `pnpm db:seed:large` (2.5.16):** on the seeded large project, the spec asserts the **List paginates** (page 1 shows the page size not all rows; Next/Prev/page-jump change `?page=` and the visible range) and the **Tree lazy-loads + virtualizes** (a collapsed parent\'s children are NOT in the DOM until expanded; expanding fetches them; "Load more children" appears on a >page-size parent; the DOM row count stays bounded even with deep expansion). This is the verification that the finding-#57 scale work actually holds at real size — not just on a 7-node fixture.\n' +
        '- Spec drives the real stack (Next + Postgres) via the shipped helpers; deterministic (no fixed sleeps); green on CI.\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/_helpers/shell-session.ts` (1.5.6) + `workflow.ts` (2.2.7) + `issue-create-edit-flow.spec.ts` (2.3.8) — fixtures + conventions to mirror\n' +
        '- **`pnpm db:seed:large` (the 2.5.16 dev seed)** — the large project the pagination + lazy-load/virtualization scale assertions run against\n' +
        '- `tests/e2e/shell-a11y.spec.ts` — the strict sweep to extend (BOTH Tree + List views); the 2.5.3 route + 2.5.2 `data-testid` hooks\n' +
        '- 2.5.8 `IssueListToolbar` / the `[Tree ▾]` menu + the List view + the `?view=`/`?sort=` URL contract — the switcher behaviour to drive\n' +
        '- `playwright.config.ts` webServer block',
    },
    {
      id: '2.5.7',
      title: 'Design — flat sortable List view + the `[Tree ▾]` switcher menu',
      status: 'done',
      type: 'design',
      executor: 'human',
      estimateMinutes: 40,
      descriptionMd:
        "The design asset the view-switcher's **List mode** needs — the surface " +
        '`tree.png` does NOT specify it (it draws only the Tree view and a *disabled* ' +
        '`[Tree ▾]` control, which 2.5.3 ships as a forward-compatible seam). Without this asset, ' +
        '2.5.8 would be improvising UI — the planning-time design gate. Produce, under ' +
        '`design/work-items/`, a `list.mock.html` (built from the live design system — ' +
        '`components/ui/*` + `--el-*` tokens, preferred so the coding agent composes the ' +
        'same primitives) OR a `.pen`+PNG, plus a `design-notes.md` section, covering:\n\n' +
        '- The **flat List table**: the same **TITLE / ASSIGNEE / STATUS** ' +
        'columns as the tree but *un-nested* (no indent, no chevrons), rows in the active sort order. ' +
        'Specify any extra sortable columns the List earns over the Tree (e.g. **Updated** / ' +
        '**Priority**) — or none if TITLE/ASSIGNEE/STATUS suffice.\n' +
        '- **Sortable column headers**: the hover affordance, the active-sort indicator + ' +
        'asc/desc caret, and the default sort (e.g. `key` asc).\n' +
        '- The **`[Tree ▾]` switcher menu** open: the `Tree` / ' +
        '`List` options + the active/selected treatment.\n' +
        "- The List view's **empty + loading** states (reuse the tree's `EmptyState` " +
        '+ skeleton, or note the deltas).\n\n' +
        'Mirror the output convention of the prior design subtasks (**1.0.5 / 1.2.1 / 1.3.3 / 1.5.1 ' +
        '/ 2.4.7 / 2.4.8**). Colour only through `--el-*`; status via `Pill` tones; ' +
        'type icons take their type hue.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A `design/work-items/list.mock.html` (or `.pen`+PNG) + a ' +
        '`design-notes.md` entry exist, naming the composing primitives, copy, the column set, the ' +
        'sort affordance + active indicator, and the switcher-menu states.\n' +
        "- The List table reuses the tree's row vocabulary (`IssueTypeIcon` · identifier · " +
        '`Pill` · avatar) — no new visual primitive invented; consistent with `tree.png`.\n' +
        '- Empty + loading + the open switcher menu are all specified (multi-panel).\n' +
        '- Colour flows only through `--el-*`; AA-safe (finding #35).\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/tree.png` (+ `tree.pen`) + `design-notes.md` — the tree design this extends\n' +
        '- `design/work-items/relationships.mock.html` (2.4.7) — the in-repo HTML-mockup convention to mirror\n' +
        '- `components/ui/*` primitive inventory + `app/globals.css` `--el-*` tiers + the `/tokens` route',
    },
    {
      id: '2.5.8',
      title: 'The `[Tree ▾]` view-switcher — Tree ↔ flat sortable List (URL-driven)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['2.5.3', '2.5.7'],
      descriptionMd:
        'Make the `[Tree ▾]` control in the 2.5.3 toolbar FUNCTIONAL: a real menu ' +
        '(`Popover`/`Combobox`) toggling between the existing **Tree** view ' +
        "and a new **flat, sortable List** view, per 2.5.7's design. The 2.5.3 toolbar ships the " +
        'control disabled as a forward-compatible seam; this replaces that placeholder with the working ' +
        'switcher.\n\n' +
        '**Durable shape: view + sort live in the URL** ' +
        "(e.g. `?view=list&sort=key:asc`), exactly like 2.5.4's filter params — shareable / " +
        "reload-safe and the same serialization Epic 6's saved views will persist. The Server Component reads " +
        'them: `view=tree` (default) renders the nested `TreeTable` (2.5.2); ' +
        "`view=list` renders a **flat** table (the project's issues un-nested, sorted by " +
        'the active key) reusing the same row cells. List sorting is a flat `ORDER BY` over the ' +
        "existing project read — add a flat, sorted variant of 2.5.1's read; do NOT re-nest then flatten in JS.\n\n" +
        '**Scope guard.** v1 = the Tree/List toggle + single-column sort with the drawn ' +
        'affordance. **Saved / named views, multi-sort, and column show/hide config stay Epic 6** ' +
        '(saved views & advanced search) — not invented here (no complexity for nothing).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The `[Tree ▾]` control opens a menu with **Tree** (default) + ' +
        '**List**; choosing one switches the view and reflects the choice in the URL ' +
        '(`?view=`), reload-/share-safe.\n' +
        "- **List** renders the project's issues FLAT, sorted by the active column; clicking a " +
        'sortable header updates `?sort=` (asc/desc) with the drawn active-sort indicator; default ' +
        'sort = `key` asc.\n' +
        '- Both views reuse the same row cells + the whole-row link to `/issues/[key]`; matches ' +
        '`list.mock.html` (2.5.7); colours via `--el-*`, status via `Pill` tones.\n' +
        '- 4-layer + explicit workspace gate; the flat read reuses/extends 2.5.1 (no N+1, no JS re-nesting).\n' +
        '- Component test (toggle view + sort updates the URL + re-queries). The Tree↔List switch + sort ' +
        'round-trip is driven end-to-end by the **Story E2E (2.5.6)**, which also adds the List ' +
        'view to the strict shell-a11y sweep — so the sortable headers must carry `aria-sort`.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/list.mock.html` + `design-notes.md` (2.5.7) — the layout authority\n' +
        '- 2.5.3 `app/(authed)/issues/page.tsx` + `_components/IssueListToolbar` (the disabled `[Tree ▾]` to wire) + `IssueTreeTable` / `issueRows`\n' +
        "- 2.5.1 `getProjectTree` / `findProjectForest` (add the flat, sorted variant); 2.5.4's URL-param pattern; `components/ui/Popover` / `Combobox`\n" +
        '- `prodect-core/CLAUDE.md` — 4-layer · `--el-*` tokens',
    },
    {
      id: '2.5.9',
      title: 'Design — Filter bar (kind · status · assignee · text) popover + active-count + clear',
      status: 'done',
      type: 'design',
      executor: 'human',
      estimateMinutes: 35,
      descriptionMd:
        'The design asset the `[Filter]` control needs — `tree.png` draws only the ' +
        '*disabled* `[Filter]` button (a forward-compatible seam, exactly like the ' +
        '`[Tree ▾]` control that got **2.5.7**); it does NOT specify the **open ' +
        'filter surface**. Without this asset, **2.5.4** would be improvising UI — the ' +
        'planning-time design gate (`notes.html` mistake #31), the same gap 2.5.7 closed for the List ' +
        'view. Produce, under `design/work-items/`, a `filter.mock.html` (built from the ' +
        'live design system — `components/ui/*` + `--el-*` tokens, preferred so the coding ' +
        'agent composes the same primitives) plus a `design-notes.md` section, covering:\n\n' +
        '- The **Filter trigger**: its resting state, the active treatment, and the ' +
        '**active-filter count badge** (e.g. `Filter · 3`) shown when filters apply.\n' +
        '- The **open `Popover`** (anchored to the trigger): the layout of the four ' +
        'filter groups — **kind** (issue-type multi-select, type icon + name), ' +
        '**status** (the project workflow statuses, `Pill` tones), ' +
        '**assignee** (workspace members + an explicit **"Unassigned"** option), and a ' +
        '**text** quick-filter (identifier + title) — composed from the shared ' +
        '`Combobox` / `StatusPicker` option source / member combobox; **no new ' +
        'picker primitive**.\n' +
        '- The **selected-state vocabulary** (how a chosen kind/status/assignee reads — checks, ' +
        'chips, or selected rows) and the **"Clear filters"** affordance.\n' +
        '- States: **closed-inactive · closed-active (with count) · open-empty · open-populated** ' +
        '(multi-panel).\n\n' +
        'Mirror the output convention of the prior design subtasks (**1.0.5 / 1.2.1 / 1.3.3 / 1.5.1 / ' +
        '2.4.7 / 2.5.7**). Colour only through `--el-*`; status via `Pill` tones; ' +
        'type icons take their type hue. The popover reuses `Popover` + `Combobox` so 2.5.4 ' +
        'composes the same primitives.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A `design/work-items/filter.mock.html` + a `design-notes.md` entry exist, ' +
        'naming the composing primitives, copy, the four filter groups, the active-count badge, the ' +
        'selected-state treatment, and the clear affordance.\n' +
        '- The filter controls reuse the shared pickers (`Combobox` / `StatusPicker` ' +
        'options / member combobox) + **"Unassigned"** — no new visual primitive; consistent with ' +
        "`tree.png`'s toolbar.\n" +
        '- Closed-inactive, closed-active (count), open-empty, and open-populated are all specified ' +
        '(multi-panel).\n' +
        '- Colour flows only through `--el-*`; AA-safe (finding #35).\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/tree.png` (+ `tree.pen`) + `design-notes.md` — the tree/toolbar design this extends (the disabled `[Filter]` seam)\n' +
        '- `design/work-items/list.mock.html` (2.5.7) + `relationships.mock.html` (2.4.7) — the in-repo HTML-mockup convention to mirror\n' +
        '- `components/ui/Popover` / `Combobox`; `StatusPicker` option source; the workspace-member combobox used by `AssigneePicker`; `ISSUE_TYPE_META`\n' +
        '- `app/(authed)/settings/workspace/jobs/_components/JobsDashboard.tsx` `StatusFilter` — prior art for an in-app, URL-driven filter affordance',
    },
    {
      id: '2.5.10',
      title: 'Design — List view pagination (server-paged navigator)',
      status: 'done',
      type: 'design',
      executor: 'human',
      estimateMinutes: 30,
      descriptionMd:
        'Finding #57: the List loads EVERY project issue with no paging — a scale gap a real ' +
        "Jira alternative can't have. This designs the **paged List affordance**, mirroring " +
        'Jira\'s issue navigator (rung 1): a footer pagination bar — **"Showing 1–50 of N"** ' +
        '+ prev/next + page jumps — over a fixed page size. The List is already flat + server-sorted + ' +
        'filterable, so paging is `LIMIT/OFFSET` + a count; the bar drives a URL ' +
        '`?page=` param that composes with the existing `?view`/`?sort`/ ' +
        'filter params. Design the loading state (skeleton while a page streams), the page-out-of-range ' +
        "and empty-result states, and the count's relationship to the active filter (count of the FILTERED " +
        'set). Output: extend `design/work-items/list.mock.html` (a pagination panel) + ' +
        '`design-notes.md`. Colour via `--el-*`, AA-safe; reuse shipped primitives ' +
        '(Button / SectionLabel) — no new visual primitive.\n\n' +
        '*(PR #109 merged 2026-06-05, merge commit `b70d15a` — design APPROVED. Added **panel 5** to ' +
        '`list.mock.html`: the server-paged footer bar inside the table box (Jira-navigator shape) — ' +
        '"Showing 1–50 of N" + Prev/Next chevrons + numbered pages with ellipsis truncation; current page = ' +
        'accent chip + `aria-current="page"`; Prev/Next disable at the ends. Two states (page 1 + a middle ' +
        'page); chevron-left/right icon defs added. `design-notes.md` section: page size 50, `LIMIT/OFFSET` ' +
        '+ count, `?page=` composes with sort+filter (count tracks the FILTERED set), out-of-range clamps ' +
        'to last page, 0 rows → empty state with no pager; Tree explicitly excluded (it scales via ' +
        'lazy-load/virtual, 2.5.11). Render-checklist applied (icon viewBox, no nested buttons, prettier, ' +
        'both panels, light+dark). Gates 2.5.12.)*\n\n' +
        '## Acceptance criteria\n\n' +
        '- The List mockup gains a pagination bar (range "1–50 of N" + prev/next + page controls), ' +
        'with loading / empty / out-of-range states; `design-notes.md` names the page size, ' +
        'the `?page=` URL param, and that the count honours the active filter.\n' +
        "- Mirrors Jira's navigator paging; reuses shipped primitives; `--el-*` only; AA-safe.\n\n" +
        '## Context refs\n\n' +
        '- `design/work-items/list.mock.html` + `design-notes.md` (2.5.7) — the surface to extend\n' +
        '- `components/ui/Button` + the `/tokens` tokens; Jira issue-navigator pagination as the mirror',
    },
    {
      id: '2.5.11',
      title: 'Design — Tree view at scale: sortable headers + lazy-expand + virtualization',
      status: 'done',
      type: 'design',
      executor: 'human',
      estimateMinutes: 45,
      descriptionMd:
        "Finding #57: the Tree loads the WHOLE forest at once. Jira's hierarchy grids (Structure / " +
        "Advanced Roadmaps) don't paginate a tree — they **lazy-load children on expand** and " +
        '**virtualize** rows. This designs that, PLUS the **sortable tree-grid column ' +
        "headers** (2.5.7 deferred Tree sorting; it's natural once children are lazy-loaded — each " +
        'children-fetch carries `ORDER BY <sort>`, so siblings sort WITHIN their parent, ' +
        'hierarchy preserved). Specify:\n\n' +
        '- **Sortable headers** — each tree-grid column header is a sort button with the ' +
        'asc / desc / unsorted states + a sort-arrow indicator (the same shape the List shipped, applied ' +
        'to the `role="treegrid"` header). Sorting re-orders siblings within every parent.\n' +
        '- **Lazy-expand** — a collapsed parent shows it has children (the chevron) without ' +
        "loading them; expanding fetches that node's children (a spinner/placeholder row on the expanding " +
        'node), and a **"Load more children"** affordance when a parent has more children ' +
        'than the per-node page.\n' +
        '- **Virtualization** — invisible to the eye (only viewport rows render); note it in ' +
        'design-notes, no distinct visual.\n\n' +
        'Output: `design/work-items/tree-scale.mock.html` (or extend the tree design) + ' +
        '`design-notes.md`. `--el-*` only; AA-safe (sort not by colour alone — the ' +
        'arrow + `aria-sort` carry it).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The mockup draws sortable tree-grid headers (asc/desc/unsorted + arrow), the lazy-expand ' +
        'loading row + "Load more children" affordance, and documents virtualization + the keyboard/ ' +
        '`aria-sort` model; `design-notes.md` states sorting re-orders siblings ' +
        'within parents and names the per-node page size.\n' +
        "- Mirrors Jira's hierarchy-grid lazy-load + virtualization; sort indicated by arrow + " +
        '`aria-sort`, not colour alone (finding #35); `--el-*` only.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/tree.png` + the shipped `components/ui/TreeTable` (2.5.2) — the surface to extend\n' +
        "- The List's shipped sort-header affordance (2.5.7/2.5.8) — the indicator to mirror onto the treegrid\n" +
        '- Jira Structure / Advanced Roadmaps as the lazy-load + virtualization mirror',
    },
    {
      id: '2.5.12',
      title: 'List view server-side pagination (LIMIT/OFFSET + count, filter/sort-aware)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 20,
      dependsOn: ['2.5.4', '2.5.8', '2.5.10'],
      descriptionMd:
        'Make the flat List server-paged per the 2.5.10 design (finding #57). Through the 4-layer path: ' +
        '`findProjectIssuesFlat` gains `limit`/`offset` + a sibling COUNT ' +
        'query over the same filter (the count is of the FILTERED set); `getProjectIssuesList` ' +
        'returns `{ items, total, page, pageSize }`; the `/issues` route reads ' +
        '`?page=` (parsed/clamped in `issueListView` beside `parseSort`) and ' +
        'passes it down; the List table renders the pagination bar (range + prev/next + page jumps) per the ' +
        'design. `?page` composes with `?view`/`?sort`/filter and is part of ' +
        "the Suspense key so a page change re-streams the skeleton. Page size is the design's constant.\n\n" +
        '## Acceptance criteria\n\n' +
        '- The List fetches + renders one page (default 50) with a "1–50 of N" bar; prev/next/page-jump ' +
        'update `?page` and re-stream; the count reflects the active filter.\n' +
        '- Paging is server-side (`LIMIT/OFFSET` + count) through Route → Service → ' +
        'Repository — no raw Prisma in the route, no client-side slicing of a full fetch.\n' +
        '- Out-of-range page clamps to the last page; empty/filtered-empty states intact; sort + filter ' +
        'still work under paging.\n' +
        '- Integration test (real PG): page boundaries + filtered count; component test: the bar drives ' +
        '`?page`. tsc/eslint/prettier clean; next build compiles.\n\n' +
        '## Context refs\n\n' +
        '- `lib/repositories/workItemRepository.ts` `findProjectIssuesFlat` + `lib/services/workItemsService.ts` `getProjectIssuesList` + `lib/issues/issueListView.ts` (`parseSort`/`serializeSort` → add `parsePage`)\n' +
        '- `app/(authed)/issues/page.tsx` + `IssueListTable` / `IssueListToolbar`\n' +
        '- The 2.5.10 design asset (List pagination) — the layout authority',
    },
    {
      id: '2.5.13',
      title:
        'Tree lazy-load read contract — roots + children-of-node (workspace-gated, sortable, paged-per-node)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['2.5.1', '2.5.11'],
      descriptionMd:
        'The backend the lazy Tree consumes (finding #57). Today `getProjectTree` loads the ' +
        'whole forest in one query and nests in JS — replace that with **incremental reads**: ' +
        'a `listRoots` (top-level issues of the project, paged + sorted) and a ' +
        "`listChildren(parentId)` (a node's direct children, paged + sorted), both " +
        'workspace-gated (the explicit `workspaceId` filter, finding #26 — RLS is inert under the ' +
        'dev/CI superuser) and carrying a `hasChildren` flag per row so the client knows whether ' +
        'to render an expand chevron WITHOUT fetching. Sorting carries through as the `ORDER BY` ' +
        'of each read (siblings sort within their parent). Pure reads through Repository → Service → DTO; ' +
        'the legacy whole-forest read stays only if a non-lazy caller still needs it (else removed). NO ' +
        'schema change.\n\n' +
        '*(PR #111 merged 2026-06-05, merge commit `6bee620` — the lazy-tree backend (finding #57). ' +
        '`workItemRepository.findProjectTreeLevel(projectId, workspaceId, parentId|null, sort, {take, offset})` ' +
        "reads ONE level — roots (`parentId IS NULL`) or a parent's direct children — sorted via the " +
        'whitelisted `ISSUE_SORT_SQL` + `key`-asc tiebreaker (total order → paging never skips/repeats), ' +
        'each row carrying an `EXISTS` `hasChildren` flag (chevron without loading the subtree). Explicit ' +
        'workspace+project gate (finding #26); fetches `take+1` → `hasMore` (no COUNT). ' +
        '`workItemsService.listRootIssues`/`listChildIssues` → `TreeLevelDto{rows,hasMore}`; roots gate ' +
        'the project (ProjectNotFoundError), children gate the parent by workspace ' +
        '(WorkItemNotFoundError — no empty-list leak); `clampTreePage` caps a forged `?take` (default 50, ' +
        'max 200). New `WorkItemTreeRow`/`WorkItemTreeRowDto`/`TreeLevelDto` + `toWorkItemTreeRowDto`. ' +
        '**Two flagged deviations (rung-1 justified):** (a) OFFSET paging + `take+1` hasMore (consistent ' +
        'with the List 2.5.12) rather than the design-notes\' "cursor" hint — keyset over an arbitrary ' +
        'multi-column sort is disproportionate; cursor → Epic 6; (b) lazy reads are the UNfiltered tree — ' +
        'a FILTERED tree keeps the context-preserving `getProjectTree` over the already-bounded result ' +
        '(lazy+context-preserving filter → Epic 6). Integration tests (real PG): roots/children ' +
        'paging+hasMore, hasChildren, sort-within-parent, empty leaf, project + parent workspace isolation. ' +
        'tsc/eslint/prettier clean; CI runs the real-PG suite. Gates 2.5.14.)*\n\n' +
        '## Acceptance criteria\n\n' +
        '- `workItemRepository` gains `listRoots` + `listChildren` ' +
        '(each: `limit/offset`, the whitelisted `ORDER BY` sort, the ' +
        '`workspaceId` gate, a per-row `hasChildren`); `workItemsService` ' +
        'exposes them returning DTOs.\n' +
        '- Cross-workspace project/parent id → not-found, never a leak (finding #26); an empty level → ' +
        "`[]`; sort axes match the List's whitelist.\n" +
        '- Integration tests (real PG): roots paging, children paging, `hasChildren` ' +
        'correctness, sort within a parent, workspace isolation. No raw Prisma outside the repo; ' +
        'tsc/eslint/prettier clean.\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/workItemsService.ts` `getProjectTree` + `lib/repositories/workItemRepository.ts` (the forest read to replace; `findProjectIssuesFlat` as the sort/gate reference)\n' +
        '- `lib/issues/issueListView.ts` sort whitelist; `prodect-core/CLAUDE.md` 4-layer + finding #26 gate\n' +
        '- The 2.5.11 design — the per-node page size + which columns sort',
    },
    {
      id: '2.5.14',
      title: 'TreeTable — lazy-expand + sortable headers (wire 2.5.13)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 26,
      dependsOn: ['2.5.2', '2.5.13', '2.5.11'],
      descriptionMd:
        'Rework the Tree rendering to lazy-load + sort per the 2.5.11 design (finding #57), composing the ' +
        '2.5.13 reads. **Scope split (re-planned 2026-06-05):** this subtask is the LAZY + ' +
        'SORTABLE tree; **virtualization is its own 2.5.15** (a separable DOM-perf layer) and the ' +
        '**seed is 2.5.16** — so each lands as a reviewable PR, not a 1k-line sprawl.\n\n' +
        "- **Server-Action layer** — a `'use server'` wrapper over 2.5.13's " +
        '`listRootIssues`/`listChildIssues` (session + active-project gate, like the ' +
        'shipped issue actions) so the client can fetch a level on expand / sort. The initial roots may load ' +
        'in the Server Component; children + re-sorts come through the action.\n' +
        "- **Lazy-expand** — render roots; a parent's chevron shows from " +
        "`hasChildren` without loading; expanding fetches `listChildIssues` (the design's " +
        'spinner placeholder row on the node, `aria-busy`) and inserts them; a **"Load more ' +
        'children"** row at the children\'s indent when a parent exceeds the per-node page (50), ' +
        'appending the next page on click (parent never collapses).\n' +
        '- **Sortable headers** — each column header is a sort button (the EXACT List ' +
        'affordance: caret + `aria-sort` asc/desc/none, not colour alone) that re-fetches via the ' +
        "sorted reads; siblings re-order WITHIN each parent (hierarchy preserved); shares the List's " +
        '`?sort=` URL shape. Already-expanded nodes re-fetch their children on a sort change.\n' +
        "- **Setsize count (read tweak)** — the design wants each row's " +
        "`aria-setsize` = its parent's TRUE child total, but 2.5.13's read returns only " +
        '`hasMore`. Extend the lazy read/service to also return the per-node **total child ' +
        'count** (a cheap COUNT) so `aria-posinset`/`aria-setsize` are honest ' +
        "(e.g. 19 of 128) — needed now AND by 2.5.15's virtualization.\n\n" +
        'The accessible treegrid contract (2.5.2) + roving-tabindex keyboard model + the STRICT axe sweep ' +
        'must still pass; `→` on a collapsed parent triggers its lazy fetch. A specimen route covers ' +
        'the sortable-header + loading + load-more states for the sweep.\n\n' +
        '*(PR #115 merged 2026-06-05, merge commit `8ac519e` — the /issues Tree is now LAZY + SORTABLE ' +
        '(finding #57). The Server Component loads only the first page of ROOTS (listRootIssues); children ' +
        'stream in on expand via `listRootIssuesAction`/`listChildIssuesAction` (spinner row + "Load more ' +
        'children" append, per-node page 50); column headers sort (caret + `aria-sort`, not colour alone) ' +
        'via `?sort=`, re-ordering siblings within their parent. **TreeTable** extended backward-compatibly ' +
        '(per-row hasChildren/posinset/setsize overrides + busy/aria-busy + onRowActivate + per-column ' +
        'ariaSort); **setsize count** added to the 2.5.13 read (`TreeLevelDto.total` + ' +
        '`countProjectTreeLevel`) for honest aria-posinset/setsize. `IssueTreeStaticTable` keeps the ' +
        'FILTERED tree on the context-preserving whole-forest read (lazy+filter = Epic 6). **Bug fixed:** ' +
        "`buildIssueListHref` only emitted `?sort=` for the List, so Tree sort wouldn't persist — now both " +
        'views. **Decisions (flagged for review):** a sort change REMOUNTS the tree (expansion resets, not ' +
        'in-place re-fetch); the filtered tree is non-lazy/non-sortable; no new /tokens specimen (new states ' +
        'are component-tested + hit the strict a11y sweep on the real /issues route via 2.5.6). 4 new ' +
        'lazy-tree component tests + the count integration test; CI green (one flaky ' +
        '`workflow-delete-reassign` E2E — unrelated to this diff, passed on re-run). Split into 2.5.15 ' +
        '(virtualization) + 2.5.16 (db:seed:large).)*\n\n' +
        '## Acceptance criteria\n\n' +
        '- Tree renders roots; a node lazy-loads its children on first expand (spinner row → real rows); ' +
        '"Load more children" appears + appends past the per-node page (50); collapsed parents never ' +
        'pre-load.\n' +
        '- Column headers sort (caret + `aria-sort`, not colour alone); sorting re-orders ' +
        'siblings within each parent and persists in `?sort=` like the List; expanded nodes ' +
        're-fetch on sort change.\n' +
        '- The lazy read/service returns the per-node total child count; rows carry honest ' +
        '`aria-level/posinset/setsize/expanded`; the treegrid a11y contract + STRICT axe sweep ' +
        'still pass + roving-tabindex keyboard (incl. `→` triggers lazy fetch).\n' +
        '- Component tests: expand→lazy-load→render, load-more append, header sort re-fetch; integration ' +
        'test for the count; tsc/eslint/prettier clean; next build compiles.\n' +
        "- **Virtualization is NOT in this subtask** (it's 2.5.15) — but the row model + the " +
        'DOM structure are built so windowing drops in without a rewrite (a flat ordered "visible rows" list ' +
        'the renderer maps over).\n\n' +
        '## Context refs\n\n' +
        '- `components/ui/TreeTable.tsx` (2.5.2) + `app/(authed)/issues/_components/IssueTreeTable.tsx` + `IssueTreeSection.tsx` — the rendering to rework\n' +
        '- The 2.5.13 `listRootIssues`/`listChildIssues` reads (extend with the count) + the 2.5.11 design\n' +
        '- The shipped List sort-header affordance (2.5.8 `IssueListTable`) + the `?sort=` URL contract (`issueListView`) to mirror; the existing issue Server Actions for the action pattern\n' +
        '- `tests/e2e/shell-a11y.spec.ts` tree-table strict sweep + the `/tokens` convention',
    },
    {
      id: '2.5.15',
      title: 'Tree row virtualization — window the treegrid (a11y-honest)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['2.5.14'],
      descriptionMd:
        'The DOM-perf layer the 2.5.11 design calls for, split out of 2.5.14: **virtualize** the ' +
        'treegrid so only the rows in (or near) the viewport mount — a deeply-expanded big tree stays fast. ' +
        'Lazy-load (2.5.14) already bounds the DATA fetched; this bounds the DOM. Add a windowing approach ' +
        'consistent with the stack (e.g. `@tanstack/react-virtual`) over the flat ordered ' +
        '"visible rows" model 2.5.14 produced; an off-view row is removed and a spacer preserves scroll ' +
        'height.\n\n' +
        '*(PR #123 merged 2026-06-06, merge commit `23eac88` — hand-rolled fixed-row (40px) windowing in ' +
        '`components/ui/TreeTable.tsx` over the 2.5.14 flat visible-rows model. The rowgroup keeps its FULL ' +
        'height and each mounted row is absolutely positioned at `index * ROW_PX` (the spacer), so only ' +
        'viewport(+overscan) rows mount while the page scrollbar stays honest. Windows against the nearest ' +
        'scrollable ANCESTOR (the shell `<main>` — no internal scrollbar, no layout change) or a ' +
        '`getScrollElement` prop; degrades to render-all when no viewport is measurable (SSR / the small-tree ' +
        'component tests), so markup is identical with/without a live scroll container. A11y-honest: each ' +
        'mounted row keeps its TRUE aria-level/posinset/setsize/expanded from the flat model; roving tabindex ' +
        'intact (arrowing to an off-window row scrolls it in → mounts → focuses it). Pure `rowgroup → row` ' +
        'structure (no spacer divs) so the strict axe treegrid sweep is unaffected. Chose hand-rolled over ' +
        "`@tanstack/react-virtual` — that lib mounts 0 rows under happy-dom, so it can't back the required " +
        'deterministic component test; the card allows "or equivalent". 4 new TreeTable virtualization tests ' +
        '(window slice · scroll shifts window · arrow-past mounts+focuses · honest setsize); 142 component ' +
        'tests green; tsc/eslint(--max-warnings=0)/prettier clean; next build compiles + static-generates.)*\n\n' +
        '**A11y is the hard part (must hold across the window):** each mounted row keeps its ' +
        "TRUE `aria-level` / `aria-posinset` / `aria-setsize` (using 2.5.14's " +
        'per-node count) so a screen reader announces the real position though only a window exists; the ' +
        'shipped roving-tabindex keyboard model still works — `↑/↓` move the active row and ' +
        'auto-scroll mounts the landed row, `→/←` expand/collapse, `Enter` activates. ' +
        'No distinct visual (a virtualized row is identical to a real one).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Only viewport(+overscan) rows are in the DOM; scrolling a large expanded tree keeps the DOM row ' +
        'count bounded + stays smooth; a spacer preserves scroll height + the scrollbar.\n' +
        '- Each mounted row keeps honest `aria-level/posinset/setsize/expanded`; the STRICT axe ' +
        'sweep + the treegrid contract still pass with virtualization on.\n' +
        '- Keyboard nav unchanged: arrow-moving to an off-view row scrolls it into view + mounts it + ' +
        'focuses it (roving tabindex intact); Enter activates the row link.\n' +
        '- Component test: a tall tree mounts only a window; arrowing past the window mounts + focuses the ' +
        'landed row. tsc/eslint/prettier clean; next build compiles.\n\n' +
        '## Context refs\n\n' +
        '- The 2.5.14 `IssueTreeTable` / `TreeTable` (the flat visible-rows model + roving tabindex to window)\n' +
        "- A virtualization lib (`@tanstack/react-virtual` or equivalent) — add to deps; the 2.5.11 design's virtualization section\n" +
        '- `tests/e2e/shell-a11y.spec.ts` tree-table strict sweep — must stay green with windowing',
    },
    {
      id: '2.5.16',
      title: '`pnpm db:seed:large` — dev seed for a real-scale project',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 14,
      descriptionMd:
        'A **`pnpm db:seed:large`** dev script (`scripts/seed-large.ts` + ' +
        'a `package.json` script) that seeds a **real-scale project** so the finding-#57 ' +
        "scale work is verifiable in the actual UI (you can't see pagination / lazy-load / virtualization with " +
        '7 issues). Creates a demo workspace + member + project and a **large issue set**: a ' +
        'multi-level tree of a few thousand issues — many roots, AND some parents with **>50 ' +
        'children** (to exercise "Load more children" + windowing) — plus enough rows to span many List ' +
        'pages. **Idempotent / re-runnable** (clears + reseeds its own demo workspace, never ' +
        'touches other data); prints the seeded project URL + login. Dev tooling only — may use Prisma / ' +
        '`createWorkItem` directly (NOT product code); kept out of the prod bundle.\n\n' +
        '*(PR #117 merged 2026-06-05, merge commit `98f782f` — `scripts/seed-large.ts` + the `pnpm db:seed:large` ' +
        'package script (run via tsx). Seeds one self-contained demo tenant (fixed user ' +
        '`seed-large@prodect.dev` / `hunter2hunter2` + workspace + project) and a ~2,000-issue tree through ' +
        'the SHIPPED create path (allocate-key + repo.create — valid against the kind-parent triggers): ' +
        '60 root epics (List spans many pages, roots paginate), epic #1 with 130 children (Tree "Load more ' +
        'children" at 50/page) + a deep 90-grandchild branch (nested load-more / virtualization), the rest ' +
        'a handful each. Idempotent (clears its OWN demo workspace by name; never touches other data); ' +
        'refuses NODE_ENV=production; dev-only (not in the Next bundle); size-tunable via SEED_* env; ' +
        'prints a sign-in + the /issues path; documented in the README. The 2.5.6 E2E scale check + the ' +
        'manual Story verification run against it. tsc/eslint(--max-warnings=0)/prettier clean.)*\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm db:seed:large` seeds a demo workspace/project with a few-thousand-issue tree ' +
        '(incl. ≥1 parent with >50 children) + many List-page-spanning rows; idempotent on re-run; prints ' +
        'the project URL + a usable login.\n' +
        '- The data is valid per the kind-parent + workflow rules (goes through the create path / valid ' +
        "inserts — the DB triggers don't reject it); reasonably fast (batched).\n" +
        '- Dev-only (excluded from the prod build); documented in the README / Story verification. The ' +
        '2.5.6 E2E + the manual scale check run against it. tsc/eslint/prettier clean.\n\n' +
        '## Context refs\n\n' +
        '- `scripts/db-up.sh` + `package.json` scripts; the `createWorkItem` service / Prisma client + the kind-parent matrix (valid tree shapes)\n' +
        '- How a workspace + member + project are created (the shipped services / fixtures) for a self-contained demo tenant\n' +
        "- The Story verification recipe's scale check (the consumer) + 2.5.6's scale E2E",
    },
    {
      id: '2.5.17',
      kind: 'bug',
      title: 'Bug — filter-bar facet check marks de-sync on rapid multi-select (finding #58)',
      status: 'done',
      type: 'bug',
      executor: 'coding_agent',
      estimateMinutes: 6,
      dependsOn: ['2.5.4'],
      descriptionMd:
        '**Resolution (PR #116) — corrected root cause.** The real bug was **not** the ' +
        'rapid-multi-select stale-closure race described below — that theory was wrong (a faithful ' +
        'round-trip test passed on `main`). **Filter selection was not optimistic:** the check marks / ' +
        'facet counts / trigger badge rendered straight off the server-round-tripped `filter` prop, so a ' +
        'clicked status showed *no* check until the `router.push` → Server re-read settled — and a ' +
        'status matching nothing (e.g. "Blocked") made the empty read make it look permanently broken.\n\n' +
        '**Fix:** mirror the filter into local `optimistic` state that updates the instant a facet is ' +
        'toggled; render every check mark + count from it; reconcile to the prop on identity change ' +
        '(navigation landed / external reset), guarded like the `urlText` sync. A synchronous ' +
        '`filterRef` stays the compose source so back-to-back toggles still stack (the original race ' +
        'concern, kept covered). Regression test: click a status → `aria-selected` + badge update with ' +
        'NO round-trip (fails on `main`). The stale-closure framing in the sections below is retained ' +
        'as the audit trail of the mis-diagnosis.\n\n' +
        '**Regression introduced by 2.5.4** (logged as **finding #58**). In the ' +
        '`/issues` filter popover, checking two or more **Status** values in quick ' +
        "succession silently reverts the first one's check mark — the visible ticks, the active-count " +
        'badge, and the actually-filtered tree disagree. It\'s intermittent ("sometimes"): toggling ' +
        'slowly always works. The same latent race lives on the **Kind** and **Assignee** facets.\n\n' +
        '**Root cause — stale-closure clobber.** `IssueFilterBar` is a Client Component ' +
        'whose `filter` is a **prop derived from the URL**: each selection round-trips ' +
        'through `router.push` → Server-Component re-read → new `filter` prop. The facet ' +
        '`OptionRow` toggles compute next-state from the **render-time `filter` ' +
        'closure** (`apply(toggleStatus(filter, s.key))`). A second click that lands before ' +
        'the first navigation settles still sees the *old* `filter`, so its push drops the ' +
        'in-flight first selection. The text quick-filter *already* solved exactly this — it threads the ' +
        'latest filter through an effect-synced `filterRef.current` (the "must not be clobbered" ' +
        'comment) — but the KIND/STATUS/ASSIGNEE toggles were never migrated to that ref.\n\n' +
        '**Fix:** route every facet toggle through `filterRef.current` (e.g. ' +
        '`apply(toggleStatus(filterRef.current, s.key))` for kind / status / assignee / unassigned), ' +
        'so each push composes onto the freshest filter regardless of in-flight navigations. Pure reducers in ' +
        '`lib/issues/issueListFilter.ts` are correct and unchanged — the bug is in the caller only.\n\n' +
        '## Acceptance criteria\n\n' +
        "- Toggling two+ statuses (or kinds, or assignees) in quick succession — before navigation flushes — keeps EVERY selected row's check mark; the pushed URL carries all selected keys; the active-count badge matches the visible ticks.\n" +
        '- All four facet toggles (kind · status · assignee · unassigned) read `filterRef.current`, not the render-time `filter` closure; the pure reducers in `lib/issues/issueListFilter.ts` stay untouched.\n' +
        '- Regression test in `tests/components/issue-filter-bar.test.tsx`: fire two status toggles **synchronously** (no `await` between clicks, navigation not yet flushed) → assert the pushed `href` contains BOTH status keys and both rows render `aria-selected="true"` (the current code drops the first).\n' +
        '- No behavioural change to slow/single toggles, Clear, or the text debounce; tsc / eslint / prettier clean.\n\n' +
        '## Context refs\n\n' +
        '- **Finding #58** in `PRODECT_FINDINGS.md` (full root-cause writeup)\n' +
        '- `app/(authed)/issues/_components/IssueFilterBar.tsx` — the `OptionRow` `onToggle` handlers (KIND/STATUS/ASSIGNEE) + the existing `filterRef` / text-debounce precedent (~L143–167) to mirror\n' +
        '- `lib/issues/issueListFilter.ts` (`toggleKind`/`toggleStatus`/`toggleAssignee`/`toggleUnassigned` — pure, reused as-is); `tests/components/issue-filter-bar.test.tsx` (where the regression test lands)',
    },
    {
      id: '2.5.18',
      title: 'Design — work-item quick-view (peek) modal + row trigger + "Open full page" link',
      status: 'done',
      type: 'design',
      executor: 'human',
      estimateMinutes: 35,
      descriptionMd:
        'The design asset the `/issues` **quick view** needs — a *peek* overlay that shows a work item ' +
        'in a modal **without leaving the list**, with a clear path to the full detail page. Neither ' +
        '`tree.png` nor the 2.4 detail design draws this surface, so its code (**2.5.19**) is blocked on ' +
        'it — the planning-time design gate (`notes.html` mistake #31), the same gap 2.5.7 / 2.5.9 closed ' +
        'for the List view and the filter popover. Produce, under `design/work-items/`, a ' +
        '`quick-view.mock.html` (built from the live design system — `components/ui/*` + `--el-*` tokens, ' +
        'preferred so the coding agent composes the same primitives, incl. the existing ' +
        '`components/ui/Modal`) OR a `.pen`+PNG, plus a `design-notes.md` section, covering:\n\n' +
        '- The **row trigger**: how a row exposes "quick view". The tree/list rows are **already a ' +
        'whole-row link to `/issues/[key]`** (2.5.3 / 2.5.8), so the trigger CANNOT be a `<button>` nested ' +
        'inside that anchor (no nested interactive elements). Specify the resolution — e.g. a dedicated ' +
        '**quick-view icon button in a trailing row-actions cell** that sits *outside* the row link ' +
        '(deliver the row link as a stretched/overlay link, not a wrapping `<a>`), its hover/focus ' +
        'affordance, tooltip, and whether it shows on hover or always.\n' +
        '- The **modal layout**: a *condensed* subset of the 2.4 detail page — type icon + `PROD-N` ' +
        'identifier + title, the `Status` `Pill`, assignee avatar, a description excerpt, and the few key ' +
        "meta fields worth a glance. Decide what the peek shows vs. what stays detail-only (don't rebuild " +
        'the whole detail page in a modal). Reuse the detail/row vocabulary (`IssueTypeIcon` · `Pill` · ' +
        'avatar) — no new visual primitive.\n' +
        '- The prominent **"Open full page →"** affordance (link/button) that routes to `/issues/[key]`, ' +
        'plus the header identifier — both clearly go to the detail page.\n' +
        '- **Close affordances**: the `×` button, `Esc`, and backdrop click; the focus-trap / ' +
        'return-focus behaviour the `Modal` primitive already gives.\n' +
        "- The peek's **loading** state (the item's fields fetch when the modal opens) and a graceful " +
        '**not-found / no-access** state (a stale or forbidden key in the URL).\n' +
        '- Works opened from **both** the Tree and the List view (shared row cells), and the responsive / ' +
        'narrow-width treatment (centered modal vs. full-height sheet on mobile).\n\n' +
        'Mirror the output convention of the prior design subtasks (**2.4.7 / 2.4.8 / 2.5.7 / 2.5.9**). ' +
        'Colour only through `--el-*`; status via `Pill` tones; type icons take their type hue; AA-safe ' +
        '(finding #35).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A `design/work-items/quick-view.mock.html` (or `.pen`+PNG) + a `design-notes.md` entry exist, ' +
        'naming the composing primitives (incl. `Modal`), the condensed field set, the copy, and every ' +
        'state below.\n' +
        '- The **row trigger** is specified as a NON-nested affordance compatible with the existing ' +
        'whole-row link to `/issues/[key]` (no `<button>` inside an `<a>`), for both Tree and List rows.\n' +
        '- The modal specifies its content, the **"Open full page →"** link to the detail page, the close ' +
        'affordances, and the **loading + not-found/no-access** states (multi-panel).\n' +
        '- Reuses the detail/row visual vocabulary — no new visual primitive invented; consistent with ' +
        '`tree.png` + the 2.4 detail design. Colour flows only through `--el-*`; AA-safe (finding #35).\n\n' +
        '## Context refs\n\n' +
        '- The 2.4 detail-page design (`design/work-items/detail.*` + `design-notes.md`) — the field vocabulary the peek condenses\n' +
        '- `design/work-items/tree.png` (+ `tree.pen`) + `list.mock.html` (2.5.7) — the row designs the trigger attaches to\n' +
        '- `components/ui/Modal` (the 2.3 `CreateIssueModal` + the detail surfaces use it) + `components/ui/*` primitive inventory + `app/globals.css` `--el-*` tiers + the `/tokens` route',
    },
    {
      id: '2.5.19',
      title: 'Work-item quick-view modal in `/issues` (URL-driven peek + "Open full page")',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 15,
      dependsOn: ['2.5.3', '2.5.8', '2.5.18'],
      descriptionMd:
        'Add a **quick view** to `/issues`: a per-row trigger opens the work item in a **modal over the ' +
        'list** (a "peek"), so a user can scan an item without losing their place in the tree/list; the ' +
        'modal carries a prominent **"Open full page →"** link to `/issues/[key]`. Build it per ' +
        "**2.5.18**'s design, composing the existing `components/ui/Modal` + the detail field vocabulary — " +
        'do NOT rebuild the whole 2.4 detail page.\n\n' +
        "**Durable shape: the peek lives in the URL** (e.g. `?peek=<key>`), exactly like 2.5.4's filter " +
        "and 2.5.8's `view`/`sort` params — shareable, reload-safe, and `Esc`/back closes it by clearing " +
        'the param. The Server Component reads `searchParams.peek`; when present it calls the shipped ' +
        '`getIssueDetail(identifier, ctx)` (2.4) for that key and renders the `IssueQuickView` modal over ' +
        'the list — so the workspace/membership gate and the not-found/no-access path are inherited from ' +
        "that read, not re-implemented. A stale or forbidden `peek` key renders the design's not-found " +
        'state, not a crash.\n\n' +
        '**The trigger** is the non-nested row affordance 2.5.18 draws (a quick-view icon button in the ' +
        'trailing row-actions cell, outside the whole-row `/issues/[key]` link — no `<button>` inside an ' +
        '`<a>`). It lives in the **shared row cells** so it appears in BOTH the Tree and the List view; ' +
        'activating it pushes `?peek=<key>`.\n\n' +
        '**Scope guard.** v1 = open the peek, show the condensed fields read-only, "Open full page", and ' +
        'close. **Editing inside the peek is out of scope** (inline edits are 2.5.5 on the rows; full edit ' +
        "is the detail page) — keep the modal a read surface so we don't fork the edit paths (no " +
        'complexity for nothing).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Each row (Tree and List) shows the quick-view trigger from 2.5.18; activating it opens the ' +
        'modal and sets `?peek=<key>` (shareable / reload-safe). A direct load of `/issues?peek=<key>` ' +
        'opens with the modal already shown.\n' +
        '- The modal renders the condensed fields per `quick-view.mock.html` from `getIssueDetail` ' +
        '(reused, not duplicated); the **"Open full page →"** control and the header identifier navigate ' +
        'to `/issues/[key]`. `×` / `Esc` / backdrop close it by clearing `?peek=`, with focus returned to ' +
        'the trigger.\n' +
        "- The trigger is NOT nested inside the row's `/issues/[key]` link (no nested interactive); the " +
        'whole-row link still works; colours via `--el-*`, status via `Pill` tones.\n' +
        '- A stale / cross-workspace / deleted `peek` key renders the not-found/no-access state (no leak, ' +
        "no crash) — inherited from `getIssueDetail`'s gate; 4-layer respected, no new read added unless a " +
        'lighter projection is justified.\n' +
        '- Component test (trigger sets `?peek` + the modal renders the item + "Open full page" href is ' +
        '`/issues/[key]` + close clears the param). The open→peek→"Open full page" flow is exercised ' +
        'end-to-end by the **Story E2E (2.5.6)**, which also sweeps the open modal for shell-a11y (focus ' +
        'trap, labelled dialog, return focus).\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/quick-view.mock.html` + `design-notes.md` (2.5.18) — the layout authority\n' +
        "- 2.5.3 `app/(authed)/issues/page.tsx` (reads `searchParams`; render the modal here) + the shared row cells / `issueRows` + `IssueTreeTable` (where the trigger lands) + 2.5.8's flat List rows\n" +
        '- 2.4 `getIssueDetail(identifier, ctx)` / `IssueDetailDto` + `app/(authed)/issues/[key]/page.tsx` (the detail destination) + its field components to compose the condensed view\n' +
        '- `components/ui/Modal` (the 2.3 `CreateIssueModal` open/close+URL precedent) · 2.5.4 / 2.5.8 URL-param pattern · `prodect-core/CLAUDE.md` — 4-layer · `--el-*` tokens',
    },
    {
      id: '2.5.20',
      title: 'Design — ready/blocked readiness in the quick-view (peek) modal',
      status: 'planned',
      type: 'design',
      executor: 'human',
      estimateMinutes: 25,
      descriptionMd:
        'The design asset for showing **ready / blocked** readiness INSIDE the `/issues` quick-view ' +
        '(peek) modal. The shipped `quick-view.mock.html` (2.5.18) deliberately scoped the peek as a ' +
        'read preview and listed the **readiness badge (2.4.5) as DETAIL-ONLY** (design-notes ' +
        '"What the peek shows vs. what stays detail-only", L805–811). This subtask **reconciles that ' +
        "decision**: the peek should surface an item's readiness so a user can tell at a glance, while " +
        'scanning the list, whether the item is **Ready to start** or **Blocked** (and on what) — without ' +
        'opening the full page. Because the existing mockup does not draw this in the peek, 2.5.21 would be ' +
        'improvising UI without this asset — the planning-time design gate (`notes.html` mistake #31), the ' +
        'same gate 2.5.7 / 2.5.9 / 2.5.18 closed for their surfaces.\n\n' +
        '**No new visual primitive — reuse the shipped `ReadinessBadge` (2.4.5).** The ready/blocked ' +
        'treatment already exists as a reusable primitive (`components/ui/ReadinessBadge` — mint ' +
        '"Ready to start" / peach "Blocked · Waiting on N issue(s) — PROD-3, PROD-8" with the open ' +
        'blockers named as links, state carried by TEXT not colour alone, AA-safe per finding #35). This ' +
        'design DOES NOT invent a new badge — it decides WHERE the existing badge sits in the peek and how ' +
        'it behaves in the modal context. Update `design/work-items/quick-view.mock.html` + the ' +
        '`design-notes.md` "Work-item quick view (peek) modal" section to cover:\n\n' +
        '- **Placement** — where the `ReadinessBadge` lives in the two-column peek (e.g. a full-width row ' +
        'at the top of the main column above the Description, or at the top of the 300px core-fields rail). ' +
        'Pick one and justify it briefly; keep it consistent with how the badge reads on the detail page.\n' +
        '- **States (multi-panel)** — **blocked** (named open blockers as links), **ready** ' +
        '("All blockers resolved"), and **no blockers at all** (mirror the detail-page rule: an item with ' +
        'no `is_blocked_by` in-edge shows NO banner — there is no readiness signal to give; confirm the ' +
        'peek follows the same rule rather than rendering an empty/"ready" banner for everything).\n' +
        '- **Blocker links inside a modal** — the named-blocker links route to `/issues/[key]`. Decide ' +
        'whether clicking one **swaps the peek** to that key (`?peek=`) or **navigates to the full page** ' +
        '(closing the peek); the detail-page badge links straight to the detail page — note which the peek ' +
        'uses and why.\n' +
        '- **Reconcile the design-notes** — move "readiness badge" OUT of the peek\'s "Detail-only" list ' +
        'and into "What the peek shows", so the doc and the mockup agree (the relationships/links panel ' +
        'itself STAYS detail-only — only the readiness signal is promoted).\n\n' +
        'Mirror the output convention of the prior design subtasks (**2.4.7 / 2.5.7 / 2.5.9 / 2.5.18**). ' +
        "Colour only through `--el-*`; the badge's tones come from `--el-tint-mint` / `--el-tint-peach` " +
        'with `--el-text-strong`; AA-safe (finding #35); toggle dark mode in the mockup to confirm token ' +
        'parity.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `quick-view.mock.html` gains the readiness treatment in the peek (the shipped `ReadinessBadge` ' +
        'shape — NO new visual primitive) with **blocked · ready · no-blockers (no banner)** panels, and ' +
        'the `design-notes.md` peek section documents its placement, the named-blocker link behaviour ' +
        '(swap-peek vs. navigate), and the no-blockers rule.\n' +
        '- The design-notes "Detail-only" list is updated — readiness is promoted into the peek; the ' +
        'relationships/links panel stays detail-only.\n' +
        '- Consistent with the detail-page readiness banner (2.4.5) and `tree.png` toolbar; colour flows ' +
        'only through `--el-*`; state is conveyed by text + icon, not colour alone; AA-safe (finding #35).\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/quick-view.mock.html` + `design-notes.md` "Work-item quick view (peek) modal" section (the surface to extend) + its "Detail-only" line to reconcile\n' +
        '- `design/work-items/relationships.mock.html` + the `design-notes.md` "Relationships panel + ready/blocked badge" section (2.4.5) — the readiness banner this reuses\n' +
        '- `components/ui/ReadinessBadge.tsx` (the shipped primitive) + `components/ui/*` inventory + `app/globals.css` `--el-*` tiers + the `/tokens` route',
    },
    {
      id: '2.5.21',
      title: 'Show ready/blocked readiness in the `/issues` quick-view modal',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 8,
      dependsOn: ['2.5.19', '2.5.20'],
      descriptionMd:
        'Render the **ready / blocked** signal inside the `/issues` quick-view (peek) modal per ' +
        "**2.5.20**'s design, so a user can tell while scanning the list whether a peeked item is " +
        '**Ready to start** or **Blocked** (and on what) without opening the full page. This is a ' +
        '**purely presentational** addition to the 2.5.19 modal — no new read, no new mutation, no new ' +
        'visual primitive.\n\n' +
        '**The data is already in hand.** The peek renders from the shipped ' +
        '`getIssueDetail(projectId, key, ctx)` (2.4), whose `IssueDetailDto` ALREADY carries ' +
        '`readiness: ReadinessVerdictDto` (`{ ready, openBlockers }`) — the same verdict the detail ' +
        "page's relationships panel feeds to `ReadinessBadge`. So 2.5.21 drops the shipped " +
        '`components/ui/ReadinessBadge` (2.4.5) into the `IssueQuickView` modal, fed from ' +
        "`detail.readiness`, at the placement 2.5.20 specifies. Map `openBlockers` to the badge's " +
        '`{ identifier, href }` exactly as the detail page does (reuse that mapping — do NOT re-derive ' +
        'readiness; the service owns the per-project terminal classification, finding #21).\n\n' +
        "**Match the design's rules:** show NO banner when the item has no blockers (mirror the " +
        'detail-page rule — 2.5.20 confirms it); the open blockers are named as links to ' +
        '`/issues/[key]`, with the swap-peek-vs-navigate behaviour 2.5.20 decides; readiness state is ' +
        'conveyed by text + icon, never colour alone (the badge already does this); colours via ' +
        '`--el-*`.\n\n' +
        '**Scope guard.** Only the readiness signal moves into the peek — the full relationships / links ' +
        'panel STAYS detail-only (no link create/remove, no Blocks/Relates-to/Duplicates groups in the ' +
        'peek). v1 = render the existing badge from the already-returned verdict (no complexity for ' +
        'nothing).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The quick-view modal renders the shipped `ReadinessBadge` from `detail.readiness` per ' +
        '`quick-view.mock.html` (2.5.20): **blocked** names the open blockers as `/issues/[key]` links, ' +
        '**ready** shows "Ready to start", an item with **no blockers shows no banner**.\n' +
        "- Reuses `getIssueDetail`'s existing `readiness` field + the `ReadinessBadge` primitive — NO new " +
        'read, NO new component, NO re-derivation of readiness; the relationships/links panel stays ' +
        'detail-only.\n' +
        '- The named-blocker links behave as 2.5.20 specifies (swap `?peek=` or navigate to full page); ' +
        "the badge never breaks the modal's focus-trap / `Esc` / return-focus or the non-nested row " +
        'trigger; colours via `--el-*`, state by text + icon not colour alone (finding #35).\n' +
        "- Component test: a blocked item's peek renders the blocked badge with the open-blocker links; a " +
        'ready item renders "Ready to start"; an item with no blockers renders no banner. tsc / eslint / ' +
        'prettier clean; next build compiles.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/quick-view.mock.html` + `design-notes.md` (2.5.20) — the layout authority\n' +
        '- The 2.5.19 `IssueQuickView` modal (`app/(authed)/issues/_components/*`) — the surface to extend (where the badge mounts)\n' +
        '- `components/ui/ReadinessBadge.tsx` (2.4.5) + `app/(authed)/issues/[key]/page.tsx` (how the detail page feeds `detail.readiness` → `ReadinessBadge`, incl. the `openBlockers` → `{identifier, href}` mapping to reuse)\n' +
        '- `lib/dto/workItems.ts` `ReadinessVerdictDto` / `IssueDetailDto.readiness`; `lib/services/workItemsService.ts` `getReadiness` (the read already wired into `getIssueDetail`); `prodect-core/CLAUDE.md` — `--el-*` tokens',
    },
  ],
};
