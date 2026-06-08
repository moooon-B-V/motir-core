import type { PlanStory } from '../types';

/**
 * Story 7.0 — Ready set: page + endpoint (the AI dispatch surface, front-half
 * of stub 7.5 pulled forward).
 *
 * **Justified deviation from linear epic order** (notes.html #32, the
 * epic-ordering-follows-deps rule). 7.0 ships ahead of the remaining Epic 6
 * stubs (6.1 filter builder, 6.2 saved filters, 6.3 dashboards) — Epic 7 begins
 * BEFORE Epic 6 finishes. This is a deliberate planner deviation, NOT a
 * forward-pointing cross-epic dep mistake, because:
 *
 *   (a) **No forward-pointing dep.** Every 7.0 subtask depends only on Epic-2
 *       readiness primitives (`workItemsService.getReadinessForItems` /
 *       `getReadiness`, both `status: done` since 2.2.6 / finding #21) and
 *       Epic-1 shell pieces (SidebarNav, the issues-list row primitive).
 *       Backward-only — passes the cross-epic dep audit.
 *
 *   (b) **Independently useful before any AI.** 7.0 ships the page + two
 *       endpoints that BYOK `prodect run` consumes RIGHT NOW. The dispatch
 *       surface unblocks Yue's own day-to-day dogfooding (`prodect run <id>`
 *       fetches the next ready item from `/api/ready/next` instead of the
 *       planner reading the seed by hand), and unblocks any future agent the
 *       user wires up — without depending on any Epic-7 AI work.
 *
 *   (c) **Front-half of stub 7.5, not a duplicate.** Stub 7.5 names the SAME
 *       surface ("ready-set query over the dependency DAG that powers what's
 *       next" + "narrow single-artifact planner tools"). 7.0 ships the
 *       page + the two endpoints; 7.5's remaining scope (shared-context
 *       retrieval = the prompt-injection moat; the broader planner tool
 *       surface beyond `ready`) stays in 7.5. Cross-reference in stubs.ts.
 *
 * **Mirror product (rung 1, VERIFIED — not asserted).** Jira has no top-level
 * "Ready" nav. Its closest equivalent is filters/saved-searches ("My Open
 * Issues", "Assigned to me"). Linear ships **Inbox** / **My Issues** as
 * top-level surfaces — closer to what we want. Prodect ships an
 * AI-coding-native dispatch surface that no mirror product has a direct
 * equivalent for (Jira/Linear don't dispatch to an agent CLI). So 7.0 is a
 * **justified deviation from the mirror** under the rung-1 escape clause:
 * concrete use case = the BYOK `prodect run` flow + a future native AI-coding
 * extension. Justification recorded inline rather than reflexively mirroring.
 *
 * **Why a dedicated page + endpoint, not a `?ready=1` filter on /issues.** The
 * user named the real consumer: the page IS the human mirror of an endpoint an
 * agent calls. Search-as-filter (6.1) is derivative — a planner can ad-hoc
 * "show me ready bugs in Epic 4" — but it's NOT the dispatch surface. The
 * dispatch surface needs a stable URL the BYOK CLI can curl, a fixed DTO
 * shape, and a sort the agent doesn't have to compose. A filter predicate
 * grows fields-for-everyone; a dedicated endpoint keeps the contract honest.
 * 6.1 still gets a `ready` predicate later — additive, secondary surface.
 *
 * **Why TWO endpoints, one service method (`GET /api/ready` + `POST
 * /api/ready/next`).** Two consumers, two semantics, one source of truth:
 *
 *   - `GET /api/ready` — the **list** (browse the whole ready set). Idempotent,
 *     cursor-paginated, cacheable. The /ready page's server-component fetch.
 *     Returns `ReadyItemDto` (the cheap card-row shape).
 *   - `POST /api/ready/next` — the **dispatch** (give me ONE thing to run
 *     next). Body carries `excludeIds` (so an agent can skip what it already
 *     tried), `kinds` (so a coding agent can ask for only coding subtasks).
 *     Returns `ReadyItemDispatchDto` (list shape + `descriptionMd` +
 *     `contextRefs` + `dependsOn` resolution — the full payload the agent
 *     needs to actually dispatch).
 *
 * One service method (`workItemsService.listReady` + a thin `getNextReady`
 * projection over it) feeds both — same predicate, different DTO. Splitting at
 * the route layer keeps each contract honest and lets `/next` grow
 * dispatch-time semantics (claim/audit) later without affecting `/api/ready`.
 *
 * **Durable shapes from day one** (feedback_durable_shapes_no_shortcuts).
 * NO "load all rows, paginate in v2" shortcut — cursor pagination at the
 * service + endpoint layer from the first subtask, so a 10k-item backlog never
 * forces a re-do (planning-time scale check, finding #57). The dispatch
 * endpoint stays read-only for now (no claim row, no audit) — but the
 * deterministic sort + the explicit `excludeIds` are the durable foundation
 * that a future claim/audit row attaches to without re-shaping the contract.
 *
 * Sidebar entry: a new "Ready" item between Issues and Boards, with the
 * readiness count as a badge. Justified deviation from rung 1 (Jira/Linear
 * don't have one) for the reasons above.
 */
export const story_7_0: PlanStory = {
  id: '7.0',
  title: 'Ready set — page + endpoint (the AI dispatch surface)',
  status: 'planned',
  descriptionMd:
    'Ship the **agent dispatch surface**: a dedicated `/ready` page that lists every ready-to-' +
    'start work item in the active project, AND the two HTTP endpoints that back it — `GET ' +
    '/api/ready` (the page consumes this, browse the whole set, cursor-paginated) and `POST ' +
    '/api/ready/next` (the BYOK `prodect run` CLI / a future AI coding agent consumes this, ' +
    'dispatch ONE item with full prompt-ready payload). Same predicate underneath (readiness ' +
    'via the already-shipped `workItemsService.getReadinessForItems`, finding #21) — different ' +
    "DTOs per consumer. The page and the agent always agree on what's ready.\n\n" +
    '**A work item is "ready"** when every one of its `is_blocked_by` blockers has reached a ' +
    "terminal status (its OWN project's `category = done`). This is shipped logic: the same " +
    'rule the 2.4.5 ReadinessBadge banner + the 3.1.4 board projection already enforce. 7.0 ' +
    'projects it as a list + an endpoint.\n\n' +
    '**Scope:** the service method (`listReady` + `getNextReady`), the two endpoints, the page, ' +
    'a sidebar nav entry with a count badge, a per-row "Copy `prodect run PROD-<n>`" affordance ' +
    'for the BYOK CLI flow, the design mockup that defines all of the above, and the tests + ' +
    'verification recipe.\n\n' +
    '**Sort.** Deterministic: `(priority desc, key asc)`. Cursor encodes `(priority, key)` so a ' +
    'BYOK agent walking `next` via `excludeIds` traverses the set predictably and reseeds give ' +
    'the same order every time. NOT random; NOT created-at; NOT updated-at — those leak ' +
    "dispatch decisions to scheduling artifacts the planner can't audit.\n\n" +
    '**Pagination.** Cursor (NOT offset) from day one — the planning-time scale check ' +
    '(finding #57, "how does the mirror product handle 10k of these?"). A real ready set in a ' +
    'mature project will have hundreds of items; the agent loop will walk via cursor; the page ' +
    'will virtualize the list. No "load all rows now, paginate in v2" shortcut.\n\n' +
    '**Out of scope:**\n\n' +
    '- **Claim / audit semantics on `/next`.** It is read-only here (no row written when an ' +
    'agent picks). Claim+audit lands when stub 7.6 (prompt generation + external-agent ' +
    'dispatch) does — that\'s where "agent picked X at time T" becomes a real audit need.\n' +
    '- **The 6.1 filter builder integration** (`?filter=ready+...`). Additive, secondary; lands ' +
    'as part of 6.1, not here. 7.0 ships the dispatch surface; 6.1 generalizes it as a search ' +
    'predicate.\n' +
    '- **Shared-context retrieval / file-content injection into the dispatch payload** — the ' +
    'OTHER half of stub 7.5. `/api/ready/next` returns `contextRefs` (file paths the agent ' +
    'should read) but does NOT itself read+inline those files. The prompt-quality moat stays ' +
    'in 7.5; 7.0 ships the ready set + the references, not the file payloads.\n' +
    '- **Multi-project aggregation.** Scoped to the active project, like every other ' +
    'Prodect read (the established `getActiveProject` pattern). A cross-project ready view ' +
    'is a future addition; 6.4 project-level access gating must land first.\n' +
    "- **Native AI coding in-app.** This is the BYOK surface (the agent runs on the user's " +
    'machine and calls our endpoint). Native agent runs are a designed-for extension beyond ' +
    'the planned epics (PRODECT.md § What Prodect is).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma generate`, `pnpm db:seed`, `pnpm dev`.\n' +
    '- `pnpm test` — vitest covers: `listReady` predicate (every is_blocked_by terminal across ' +
    "its own project's workflow), `kinds` / `assigneeId` / `priority` filter axes, " +
    '`(priority desc, key asc)` sort stability across pagination, cursor round-trip ' +
    '(decoding/encoding) and idempotence over reseed, the workspace-membership gate on both ' +
    'endpoints, the 404-not-403 not-found contract on a cross-tenant `projectKey`, the ' +
    '`excludeIds` honor on `/next`, and the `ReadyItemDispatchDto` carrying `descriptionMd` + ' +
    '`contextRefs` + the resolved `dependsOn` keys.\n' +
    '- `pnpm test:e2e` — Playwright covers: signed in as `zhuyue@prodect.co`, navigate to ' +
    '**Ready** in the sidebar; the rail shows a numeric badge equal to the rendered count. ' +
    'Click into a row → the issue detail opens via peek (existing pattern). Click "Copy ' +
    '`prodect run PROD-<n>`" → the command lands on the clipboard verbatim. Mark a row\'s ' +
    'ONLY blocker `done` from the detail page → return to /ready → the formerly-blocked item ' +
    'has appeared in the list AND the sidebar badge increments (the live recompute matches the ' +
    "existing ReadinessBadge's per-project-terminal classification).\n" +
    '- **Endpoint smoke (the agent contract).** From a terminal: `curl ' +
    '"$BASE_URL/api/ready?projectKey=PROD&limit=5"` with a real session cookie → returns a ' +
    'JSON `{ items, nextCursor }` shape; iterating via `?cursor=$nextCursor` reaches the same ' +
    'tail twice (deterministic). `curl -X POST "$BASE_URL/api/ready/next" -d ' +
    '\'{"projectKey":"PROD","kinds":["subtask","task"]}\'` → returns a single ' +
    '`ReadyItemDispatchDto` with `descriptionMd`, `contextRefs`, resolved blocker keys.\n' +
    "- **Open-core check (the license-boundary review, this Epic's recurring posture).** " +
    'Confirm `/api/ready` and `/api/ready/next` live entirely in `prodect-core` (the open ' +
    "side); no `prodect-ai` import sneaks in. The endpoints are the AGENT'S contract — a " +
    'future native AI-coding layer calls them OVER HTTP from `prodect-ai`, not by linking.\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, comment with ' +
    "what didn't work and Prodect will produce a follow-up Subtask under the same Story.",
  items: [
    {
      id: '7.0.1',
      title: 'Design — `/ready` page + per-row dispatch affordance + sidebar entry',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 35,
      descriptionMd:
        '**Type:** design (planning-time design gate, Principle #13 + the design-reference ' +
        'rule). Every UI-touching subtask in this Story depends on this one; without it the ' +
        '/ready page would be improvised, which is forbidden (notes.html #31).\n\n' +
        'Produce the design asset for the **Ready** surface under ' +
        '`prodect-core/design/ready/`. Author it as a **`*.mock.html` mockup** built from the ' +
        'real design system (the `components/ui/*` primitives + the `--el-*` tokens + the ' +
        '`[data-display-style]` shape tokens) — NOT a `.pen`. The HTML route is preferred when ' +
        'a coding agent produces the design (no Pencil→code translation gap; the reviewer ' +
        'sees the actual tokens). Render a PNG export for the board view if useful, but the ' +
        '`.mock.html` is the source of truth (PRODECT.md § Design-reference rule).\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the multi-panel rule, ' +
        'mistake #31):\n\n' +
        '- **Panel 1 — populated /ready page.** Header ("Ready to start" + the active project ' +
        'identifier + a small "What is this?" info popover that explains the predicate to a ' +
        'first-time user). Below: a flat list of cards (NOT a kanban board — readiness is a ' +
        'flat set; a board would lie about its structure). Each row carries: ' +
        '`IssueTypeIcon` (hued via `--el-type-*`), key (`PROD-<n>`), title, a ' +
        '`Pill` for priority, assignee avatar, a "Copy `prodect run PROD-<n>`" icon-button on ' +
        'hover (its own `--el-*` tooltip-on-hover state — show the tooltip in a side panel ' +
        'too). The list virtualizes (reuse the `useRowWindow` primitive the tree view uses ' +
        'already).\n' +
        '- **Panel 2 — sidebar with the new "Ready" entry and badge.** Drawn in context ' +
        '(the existing SidebarNav rail), showing the new "Ready" item BETWEEN Issues and ' +
        'Boards, with a count badge (e.g. "12") in the same `Pill` grammar already used in the ' +
        'shell. Badge tone: neutral; we are not coloring it by urgency.\n' +
        '- **Panel 3 — empty state.** When the active project has zero ready items. Reuse the ' +
        'shipped `EmptyState` primitive; copy explains the predicate (Items become ready when ' +
        "every is_blocked_by link reaches its project's done category) and links to /issues " +
        "so the user can find work that's NOT ready.\n" +
        '- **Panel 4 — copy-affordance toast / confirmation.** When the user clicks the ' +
        '"Copy `prodect run PROD-<n>`" icon, a small confirmation toast appears (the existing ' +
        'toast primitive) — "Copied. Paste this into your terminal."\n\n' +
        'Also write **`design/ready/design-notes.md`** naming the exact primitives used per ' +
        'surface, the exact copy strings, the placement decisions, the per-`--el-*` colour ' +
        'role for each element, and a "primitives composed (no hand-rolling)" checklist (the ' +
        '`design-notes.md` convention 1.3.3 / 1.5.1 established).\n\n' +
        '**Branch.** `design/PROD-7.0.1-ready-surface`. The `design/*` prefix gate skips CI ' +
        'E2E + the Vercel preview deploy (per PRODECT.md § Plan seed Workflow) — this PR ' +
        'only edits `design/ready/**`, no app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `prodect-core/design/ready/ready.mock.html` exists, renders the four panels above ' +
        'side-by-side, references ONLY `--el-*` tokens (no Tier-0 `--color-*`, no hand-rolled ' +
        'spacing — the rules in `prodect-core/CLAUDE.md` § colour / shape).\n' +
        '- `prodect-core/design/ready/design-notes.md` exists, names every primitive composed + ' +
        'every copy string + the per-element `--el-*` role.\n' +
        '- (Optional) a PNG export of the mockup for the board view.\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Pill`, `IssueTypeIcon`, ' +
        '`Button`, `EmptyState`, etc.) — no new design system entries invented inside this ' +
        "Story (if one would be needed, that's a NEW `design/` subtask, not a code workaround).\n\n" +
        '## Context refs\n\n' +
        '- `prodect-core/design/work-items/` — the closest existing area; mirror its layout ' +
        'and `design-notes.md` shape.\n' +
        '- `prodect-core/components/ui/ReadinessBadge.tsx` — the shipped readiness primitive ' +
        "(2.4.5); the page list shouldn't re-render the banner itself, but the per-row " +
        '"ready" tone draws from the same `--el-success` family.\n' +
        '- `prodect-core/components/ui/Pill.tsx` — the priority pill + the badge tone.\n' +
        '- `prodect-core/components/ui/EmptyState.tsx` — Panel 3.\n' +
        '- `prodect-core/components/issues/IssueTypeIcon.tsx` — per-kind icon + hue.\n' +
        '- `prodect-core/app/(authed)/_components/SidebarNav.tsx` — the rail Panel 2 modifies.\n' +
        '- `prodect-core/app/globals.css` — `--el-*` colour tokens + `[data-display-style]` ' +
        'shape tokens (the swap layer the mockup must reference).',
    },
    {
      id: '7.0.2',
      title: '`workItemsService.listReady` + `getNextReady` (service layer, cursor-paginated)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'Add two new service methods on `workItemsService`. Both share ONE underlying query + ' +
        'the existing `getReadinessForItems` batched read; the projections differ only in ' +
        'shape.\n\n' +
        '```ts\n' +
        '// lib/workItems/readyFilter.ts (NEW)\n' +
        'export interface ReadyListFilter {\n' +
        '  kinds?: WorkItemKind[];           // default: every kind\n' +
        '  assigneeId?: string | null;       // null = unassigned; undefined = any\n' +
        '  priority?: WorkItemPriority[];    // default: every priority\n' +
        '  cursor?: string;                  // base64(\\`<priority>:<key>\\`)\n' +
        '  limit?: number;                   // default 50, cap 200\n' +
        '}\n\n' +
        '// lib/services/workItemsService.ts (EXTEND)\n' +
        'async listReady(\n' +
        '  projectId: string,\n' +
        '  filter: ReadyListFilter,\n' +
        '  ctx: ServiceContext,\n' +
        '): Promise<{ items: ReadyItemDto[]; nextCursor: string | null }>\n\n' +
        'async getNextReady(\n' +
        '  projectId: string,\n' +
        '  filter: Omit<ReadyListFilter, "limit" | "cursor"> & { excludeIds?: string[] },\n' +
        '  ctx: ServiceContext,\n' +
        '): Promise<ReadyItemDispatchDto | null>\n' +
        '```\n\n' +
        '**Algorithm.** Both methods follow the SAME predicate, different DTO + cap:\n\n' +
        '1. Tenant-gate the project (the established `project.workspaceId !== ctx.workspaceId` ' +
        '→ `ProjectNotFoundError` shape, finding #26).\n' +
        '2. Apply `kind` / `assigneeId` / `priority` filters at the repository layer. The ' +
        '**non-terminal** clause is part of the same query (a ready item is by definition not ' +
        'yet in a `done` category status; filtering them out at the SQL layer avoids reading ' +
        "rows we'll throw away). The exact non-terminal predicate reuses " +
        '`workflowsService.getTerminalStatusKeysByProjects` — same source as `getReadiness`.\n' +
        '3. Compute readiness on the candidate set via `getReadinessForItems` (the batched ' +
        'read — two queries, no N+1). Filter to `ready === true`.\n' +
        '4. Sort `(priority desc, key asc)` (priority ordering is the schema enum order ' +
        '`lowest < low < medium < high < highest` — reverse it).\n' +
        '5. Apply cursor (decode `<priority>:<key>` → seek-after predicate). Take `limit + 1` ' +
        "so we can emit `nextCursor` only when there's a next page.\n" +
        '6. Map to DTO (cheap `ReadyItemDto` for `listReady`; full ' +
        '`ReadyItemDispatchDto` for `getNextReady` — see 7.0.3).\n\n' +
        '`getNextReady` is `listReady({ ...filter, limit: 1 + excludeIds.length, cursor: ' +
        'undefined })` filtered post-hoc against `excludeIds`, then `items[0] ?? null`. ' +
        'Same query plan, single-item projection. (`excludeIds` is a small set in practice — ' +
        "the agent's recent picks — so post-filter is fine; we don't push it into SQL because " +
        'it would defeat the cursor predicate.)\n\n' +
        '**Cursor format.** `base64url(JSON.stringify([priority, key]))`. Opaque to callers; ' +
        "a stable round-trip the BYOK CLI doesn't introspect. (NOT a sequence offset — " +
        'offset-based pagination over a live set is the surface that breaks on reseed; the ' +
        '(priority, key) tuple is deterministic across reseed.)\n\n' +
        '**Repository.** Add `workItemRepository.findReadyCandidates(projectId, filter, ' +
        'workspaceId)` — single Prisma `findMany` with the kind/assignee/priority/non-terminal ' +
        'predicates + the sort + the limit. Read-only, no `tx` needed (the 4-layer rule, ' +
        '`prodect-core/CLAUDE.md`).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `listReady` returns ONLY items whose `is_blocked_by` set is empty OR fully ' +
        'terminal-per-project (same predicate as `ReadinessBadge`).\n' +
        '- Sort is `(priority desc, key asc)`. Stable across reseed (the cursor encodes the ' +
        'sort key, not a row id).\n' +
        '- Cursor: `?cursor=<opaque>` resumes deterministically; iterating to the tail reaches ' +
        'the same final item twice; an out-of-range cursor returns `[]`.\n' +
        '- `kinds` filter — passing `["bug"]` returns only bugs; default = all kinds.\n' +
        '- `assigneeId` filter — `null` returns unassigned only; `"user-id"` returns that ' +
        "user's ready items; omitted returns every assignee.\n" +
        '- `priority` filter — passing `["high","highest"]` returns only those tones.\n' +
        '- `getNextReady` returns the FIRST item under the sort that is not in `excludeIds`, ' +
        'or `null` when the filtered set is exhausted.\n' +
        '- 4-layer: the new code lives in service + repository + DTO/mapper; no Prisma in ' +
        'routes; write-free → no `tx` plumbing.\n' +
        '- No N+1: at most two reads per call (candidate fetch + readiness batch).\n\n' +
        '## Context refs\n\n' +
        '- `prodect-core/lib/services/workItemsService.ts` (#1095-1200) — `getReadiness`, ' +
        '`getReadinessForItems`, the per-project terminal classification.\n' +
        '- `prodect-core/lib/services/workflowsService.ts` — ' +
        '`getTerminalStatusKeysByProjects`.\n' +
        '- `prodect-core/lib/repositories/workItemRepository.ts` — the existing list/find ' +
        'methods to mirror.\n' +
        '- `prodect-core/prisma/schema.prisma` — `WorkItemPriority` enum order (lowest → ' +
        'highest).\n' +
        '- `prodect-core/CLAUDE.md` § 4-layer rule.',
      dependsOn: [],
    },
    {
      id: '7.0.3',
      title: '`ReadyItemDto` + `ReadyItemDispatchDto` types + mappers',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 20,
      descriptionMd:
        'Define the two DTOs the endpoints serialize and add their mappers. The split is the ' +
        "load-bearing decision: don't grow ONE DTO into a kitchen sink that's expensive for " +
        'the page and incomplete for the agent.\n\n' +
        '```ts\n' +
        '// lib/dto/ready.ts (NEW)\n' +
        'export interface ReadyItemDto {\n' +
        '  id: string;\n' +
        '  key: string;                          // PROD-<n>\n' +
        '  kind: WorkItemKind;\n' +
        '  title: string;\n' +
        '  priority: WorkItemPriority;\n' +
        '  status: { key: string; category: string };\n' +
        '  assignee: { id: string; name: string; avatarUrl: string | null } | null;\n' +
        '  descriptionExcerpt: string | null;    // first ~200 chars, no markdown\n' +
        '}\n\n' +
        'export interface ReadyItemDispatchDto extends ReadyItemDto {\n' +
        '  descriptionMd: string | null;\n' +
        '  contextRefs: string[];                // file paths the agent should read\n' +
        "  blockerKeys: string[];                // resolved keys, for the agent's prompt\n" +
        '  parentKey: string | null;             // story/task/bug parent if any\n' +
        '  runCommand: string;                   // "prodect run <key>" — convenience\n' +
        '}\n' +
        '```\n\n' +
        '**Why two shapes, not one.** A list of 50 items rendered on the page should NOT ship ' +
        '200KB of markdown bodies down the wire — the page only renders an excerpt. The ' +
        'dispatch surface, conversely, needs the FULL `descriptionMd` + the `contextRefs` + ' +
        "the resolved blockers' keys because that's the payload the agent stuffs into its " +
        'prompt. One DTO that has everything either over-fetches for the page or under-' +
        'serves the agent.\n\n' +
        '**`contextRefs` source.** The work-item field already shipped (Subtask 2.1.5 added ' +
        '`contextRefs: string[]` to the schema). Mapper just forwards it; no new field, no ' +
        'new migration.\n\n' +
        '**`blockerKeys` resolution.** The dispatch DTO resolves blocker ids to keys ' +
        '(`PROD-<n>`) via the existing `workItemRepository.findByIds` (already used in ' +
        '`getBlocking` / `getBlockers`). For a READY item this set is by definition fully ' +
        '**terminal** blockers (the dependency story for the agent: "these were the things ' +
        'that had to land first; they did"). Empty array when the item had no blockers at ' +
        'all.\n\n' +
        '**`runCommand`** is `prodect run ${key}` verbatim. Server-side construction so the ' +
        'page + the CLI agree on the exact string; the page\'s "Copy" affordance copies ' +
        '`runCommand`, no string-templating in the client.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `lib/dto/ready.ts` exports both interfaces.\n' +
        '- `lib/mappers/readyMappers.ts` exports `toReadyItemDto(row, ...)` and ' +
        '`toReadyItemDispatchDto(row, blockerRows, ...)` — pure, no DB calls.\n' +
        '- `descriptionExcerpt` strips markdown to plain text and truncates to ~200 chars ' +
        'on a word boundary, ellipsis appended only when truncated.\n' +
        '- `runCommand` matches `^prodect run PROD-\\d+$`.\n' +
        '- DTOs typecheck against an example row + blocker rows in a unit test (smoke).\n\n' +
        '## Context refs\n\n' +
        '- `prodect-core/lib/dto/workItems.ts` — `WorkItemSummaryDto` shape to mirror.\n' +
        '- `prodect-core/lib/mappers/workItemMappers.ts` — the established mapper convention.\n' +
        '- `prodect-core/prisma/schema.prisma` — `contextRefs`, `assignee`, the work item row.',
      dependsOn: [],
    },
    {
      id: '7.0.4',
      title: '`GET /api/ready` — list endpoint (the page + browse consumer)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      descriptionMd:
        'Add the list route. Query params: `projectKey` (required), `kinds` (CSV), ' +
        '`assigneeId` (uuid or `"unassigned"`), `priority` (CSV), `cursor`, `limit` (default ' +
        '50, cap 200). Returns `{ items: ReadyItemDto[], nextCursor: string | null }`.\n\n' +
        '4-layer: route handler reads session via `getSession()`, parses + validates query ' +
        '(zod schema in `lib/api/readySchema.ts`), resolves project by key via ' +
        '`projectsService.getByKey`, calls `workItemsService.listReady`, maps service errors to ' +
        'HTTP status (404 on `ProjectNotFoundError` — the no-existence-leak contract, finding ' +
        '#26 — 401 on missing session, 400 on bad cursor).\n\n' +
        '**Cache headers.** `Cache-Control: private, no-store` — readiness changes with every ' +
        'status flip; we never serve a stale page. Etag/last-modified would be premature.\n\n' +
        '**Pagination convention.** Match the seed/dispatch shape we want for future endpoints: ' +
        '`{ items, nextCursor: string | null }`. NOT JSON:API, NOT Link headers — the page ' +
        "consumes JSON directly and the BYOK CLI shouldn't have to parse Link.\n\n" +
        '## Acceptance criteria\n\n' +
        '- `GET /api/ready?projectKey=PROD&limit=5` returns ≤ 5 items + a `nextCursor` when ' +
        'more remain, `nextCursor: null` at the tail.\n' +
        '- `GET /api/ready` without a valid session → 401.\n' +
        '- `GET /api/ready?projectKey=NOT_REAL` → 404 (not 403 — the cross-tenant case is ' +
        'indistinguishable from never-existed, finding #26).\n' +
        '- `limit > 200` → clamped silently to 200 (NOT 400 — friendlier for the CLI).\n' +
        '- `cursor` round-trips: GET with `nextCursor` from a previous call resumes ' +
        'deterministically.\n' +
        '- All query params optional except `projectKey`; bad shape → 400 with a zod-formatted ' +
        'error.\n' +
        '- No Prisma import in the route file (the 4-layer gate).',
      dependsOn: ['7.0.2', '7.0.3'],
    },
    {
      id: '7.0.5',
      title: '`POST /api/ready/next` — dispatch endpoint (the BYOK agent consumer)',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 25,
      descriptionMd:
        'Add the dispatch route. Body schema (zod): `{ projectKey: string, kinds?: ' +
        'WorkItemKind[], assigneeId?: string | "unassigned" | null, priority?: ' +
        'WorkItemPriority[], excludeIds?: string[] }`. Returns `ReadyItemDispatchDto` OR ' +
        '`204 No Content` when the filtered ready set is empty.\n\n' +
        '**Why POST, not GET.** The body carries `excludeIds` — a non-trivial list that grows ' +
        'with each agent loop iteration. Query-string GETs blow past URL length limits in ' +
        'practice and force CLI consumers into URL escaping. POST with a JSON body is the ' +
        'honest shape for the dispatch contract.\n\n' +
        '**Idempotency.** The endpoint is **read-only for now** (no claim row, no audit). A ' +
        'future Subtask under stub 7.6 (prompt generation + external-agent dispatch) wraps ' +
        "this with claim/audit semantics. 7.0 ships the read; that's enough for the BYOK " +
        '`prodect run` flow today.\n\n' +
        '**Why `204` not `200 { items: [] }`.** The semantic is "give me ONE thing; there is ' +
        'nothing." A `null` body would conflate "no project" with "empty ready set" against a ' +
        'real project. 204 is unambiguous.\n\n' +
        '4-layer: route → `projectsService.getByKey` → `workItemsService.getNextReady` → DTO ' +
        'serialization. Same session + tenant gate as `GET /api/ready`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `POST /api/ready/next` with a valid body + a non-empty ready set returns 200 + a ' +
        '`ReadyItemDispatchDto`.\n' +
        '- Same call with `excludeIds: [<first-item-id>]` returns the SECOND item under the ' +
        'sort. Three repeated calls each with an expanding `excludeIds` walk the set in order.\n' +
        '- Empty ready set (or fully excluded) → 204, no body.\n' +
        '- No session → 401. Bad shape → 400 (zod error). Cross-tenant `projectKey` → 404.\n' +
        '- The returned DTO carries `descriptionMd`, `contextRefs`, `blockerKeys` (the ' +
        'resolved keys of items that USED to block this one), and `runCommand`.\n' +
        '- Route imports no Prisma; the 4-layer gate holds.',
      // Depends on 7.0.4 too: the `projectsService.getByKey` / `projectRepository.findByIdentifier`
      // resolver that turns the body's `projectKey` into a `projectId` is SHARED agent-dispatch
      // infra both endpoints consume, and it is authored by 7.0.4 (the GET endpoint), not main.
      // Recorded here so the DAG is honest (Principle #14) — see PRODECT_FINDINGS #64. The 7.0.5
      // route adds ONLY `app/api/ready/next/route.ts`; it does not duplicate the resolver, so it
      // stacks cleanly on 7.0.4 (merge 7.0.4 first; 7.0.5 then rebases green).
      dependsOn: ['7.0.2', '7.0.3', '7.0.4'],
    },
    {
      id: '7.0.6',
      title: '/ready page + sidebar nav entry + count badge',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Build the `/ready` page (Server Component) AND wire the sidebar nav entry between ' +
        'Issues and Boards with a live count badge.\n\n' +
        '**Page.** `app/(authed)/ready/page.tsx`. Server component. Resolves the active ' +
        'project via `getActiveProject()` (the established pattern, mirror /dashboard + ' +
        '/issues), calls `workItemsService.listReady` directly (server-component path; the API ' +
        'endpoint is for OTHER consumers, the page reads the service directly — no double-' +
        'fetch, the established 4-layer pattern in Server Components per the /issues page).\n\n' +
        '**Renders** EXACTLY what 7.0.1 specifies: header + popover, list of cards with the ' +
        'per-row copy affordance, the empty state when zero. Virtualization via `useRowWindow` ' +
        '(reuse, not invent). Each row is whole-card clickable into the existing issue peek ' +
        '(the same QuickView pattern /issues uses) — DO NOT navigate to /issues/[key] full ' +
        'page on row click; peek is the established interaction in this codebase (notes.html ' +
        '#7).\n\n' +
        '**Sidebar.** Edit `app/(authed)/_components/SidebarNav.tsx` — insert a new entry ' +
        "between Issues and Boards: icon (Lucide `Zap` is the planner's suggestion; final " +
        "choice locked by 7.0.1 design-notes), label `t('nav.ready')`, href `/ready`, " +
        "`active: isActive(pathname, '/ready')`. **Count badge** sourced from the SAME " +
        '`listReady` call the page renders — to avoid double-fetching, the (authed) layout ' +
        '(`app/(authed)/layout.tsx`) reads the count once and passes it via the existing ' +
        "sidebar props plumbing. (If that plumbing doesn't yet expose a slot, the agent " +
        'opens a small follow-up subtask before grinding through it — finding rather than ' +
        'improvising.)\n\n' +
        '**i18n.** Add `nav.ready` to the `shell` namespace; add the page strings (header, ' +
        'empty-state copy, popover body, toast) to a new `ready` namespace. Locale = the same ' +
        'set the rest of the app ships.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `/ready` renders the four panel-1 elements from the mockup, composed of the named ' +
        'primitives, references only `--el-*` colour + `[data-display-style]` shape tokens — ' +
        'no Tier-0 utilities (the `prodect-core/CLAUDE.md` colour/shape rule).\n' +
        '- Empty project renders panel-3 EmptyState verbatim.\n' +
        '- Sidebar shows "Ready" between Issues and Boards with a numeric badge matching the ' +
        'rendered count.\n' +
        '- Row click → peek opens (same pattern as /issues).\n' +
        '- "Copy `prodect run PROD-<n>`" icon-button is keyboard-reachable, has an aria-label ' +
        '("Copy run command for PROD-<n>"), and shows the panel-4 toast on click.\n' +
        '- The page typechecks against the existing Server Component conventions; no client ' +
        'component touches the service layer directly.\n' +
        '- Mobile: the SidebarDrawer carries the same "Ready" entry (no separate mobile ' +
        'nav configuration).\n' +
        '- A11y: list rows have correct semantic markup (the existing virtualized list pattern ' +
        'already established).',
      dependsOn: ['7.0.1', '7.0.2', '7.0.3'],
    },
    {
      id: '7.0.7',
      title: 'Vitest — service + endpoint + readiness predicate behavior',
      status: 'planned',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 35,
      descriptionMd:
        'Vitest suite over real Postgres (the test convention, `tests/helpers/db.ts` truncates ' +
        'between tests). Cover the new service + endpoints end-to-end at the unit/integration ' +
        "level (NOT browser E2E — that's 7.0.8).\n\n" +
        '**Service tests** (`lib/services/workItemsService.listReady.test.ts`):\n\n' +
        '- An item with no `is_blocked_by` is ready. (Empty-blocker base case.)\n' +
        '- An item with a `is_blocked_by` → a TERMINAL blocker (project status category = ' +
        '`done`) is ready.\n' +
        '- An item with a non-terminal blocker is NOT ready.\n' +
        '- A blocker in ANOTHER project whose own workflow puts its status in `done` keeps ' +
        'the dependent ready (the per-project terminal classification, finding #21 — explicit ' +
        'cross-project test).\n' +
        '- Sort: insert items at every (priority, key) tuple, assert order is ' +
        '`highest > high > medium > low > lowest`, ties broken by key ascending.\n' +
        '- `kinds: ["bug"]` returns only bugs.\n' +
        '- `assigneeId: null` returns unassigned only.\n' +
        '- `priority: ["high","highest"]` returns only those tones.\n' +
        '- Cursor round-trip: list with limit=2 + the returned cursor twice; assert the same ' +
        'tail is reached every run (deterministic).\n' +
        '- `getNextReady` returns the first item under the sort; with `excludeIds` of that ' +
        'item, returns the second; exhaust → `null`.\n' +
        '- Cross-workspace project id → `ProjectNotFoundError`.\n\n' +
        '**Endpoint tests** (`app/api/ready/route.test.ts`, ' +
        '`app/api/ready/next/route.test.ts`):\n\n' +
        '- 200 + body shape for happy path on each endpoint.\n' +
        '- 401 without session (the single allowed `vi.mock` is `getSession`).\n' +
        '- 404 on cross-tenant `projectKey`.\n' +
        '- 400 on bad cursor / bad zod body.\n' +
        '- 204 on `POST /next` with an empty filtered ready set.\n' +
        '- `Cache-Control: private, no-store` on `GET /api/ready`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test` runs the new specs green over a real Postgres (the project convention).\n' +
        '- No mocks except `getSession()` (the single allowed exception per ' +
        '`prodect-core/CLAUDE.md`).\n' +
        "- Coverage on `lib/services/workItemsService.ts`'s new methods + the two routes is " +
        'demonstrable; no untested branch in `listReady` / `getNextReady`.',
      dependsOn: ['7.0.4', '7.0.5'],
    },
    {
      id: '7.0.8',
      title: 'Playwright E2E — /ready page, copy affordance, live badge updates',
      status: 'planned',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 30,
      descriptionMd:
        'End-to-end browser test (`tests/e2e/ready.spec.ts`) over the seeded `moooon`/`prodect` ' +
        "tenant. Closes the agent-dispatch promise from the user's perspective.\n\n" +
        '**The spec.**\n\n' +
        '1. Sign in as `zhuyue@prodect.co` / `!QAZ1qaz` (the project manager).\n' +
        '2. Confirm the sidebar shows "Ready" between Issues and Boards with a numeric badge ' +
        '> 0 (the seeded plan has ready items).\n' +
        '3. Click "Ready"; the /ready page renders the list. Assert the first row\'s priority ' +
        "pill is the highest among visible items (sort correctness from a real user's seat).\n" +
        '4. Click the "Copy `prodect run`" icon on the first row. Read clipboard text; assert ' +
        'it matches `^prodect run PROD-\\d+$`. Toast appears (panel-4 from the mockup).\n' +
        "5. Open the first row's peek; close it. (Smoke that the row interaction matches " +
        '/issues — no full-page navigation.)\n' +
        "6. Pick any visible row — note its key. Navigate to that row's blockers (via peek " +
        '> Relationships panel, the shipped 2.4.5 pattern). Mark the LAST non-terminal ' +
        'blocker `done`. Return to /ready and assert the formerly-blocked item now appears.\n' +
        '7. Reload /ready; assert the sidebar badge updates to match the new count.\n' +
        '8. Sign out; sign back in as `bophilips@prodect.co` (a workspace member, not the ' +
        'PM); confirm /ready still renders correctly (the workspace-membership gate, NOT a ' +
        'PM-only surface).\n\n' +
        '**Empty-state branch** is covered in vitest (creating an empty-ready-set tenant in ' +
        'Playwright is more setup than the value warrants).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e ready` passes locally + in CI.\n' +
        '- The spec uses the existing `signIn(page, email, password)` helper, no new auth ' +
        'plumbing invented.\n' +
        '- Clipboard read uses the established Playwright pattern (the codebase already does ' +
        'clipboard assertions; mirror that — no new flag-flipping).\n' +
        '- The spec is NOT flake-prone: explicit waits on `aria-live` for the toast, on the ' +
        'badge text change for step 7 (poll up to 5s).',
      dependsOn: ['7.0.6', '7.0.7'],
    },
    {
      id: '7.0.9',
      title: 'BYOK doc — `prodect run` against `/api/ready/next` (the agent contract surfaced)',
      status: 'planned',
      type: 'content',
      executor: 'coding_agent',
      estimateMinutes: 15,
      descriptionMd:
        'Surface the agent contract in the project README so the BYOK flow is discoverable ' +
        'without reading the seed. This is the "tell users the endpoint exists" subtask — ' +
        'small but load-bearing for adoption.\n\n' +
        'Add a new section to `prodect-core/README.md`:\n\n' +
        '> ### Agent dispatch (BYOK)\n' +
        '> \n' +
        '> Prodect exposes a stable agent contract so you can drive your own coding agent ' +
        "(Claude Code / Cursor / Aider / your own script) against the project's ready set:\n" +
        '> \n' +
        '> - `GET /api/ready?projectKey=PROD` — list every ready work item.\n' +
        '> - `POST /api/ready/next` with body `{ "projectKey": "PROD", "kinds": ["subtask"] ' +
        '}` — get ONE item to run next, including its full description + context-file ' +
        'references. Pass `"excludeIds": [...]` across calls to walk the set.\n' +
        '> \n' +
        '> The session cookie is the auth surface; use the same login flow your browser does.\n' +
        '> \n' +
        '> The `/ready` page is the human mirror of `/api/ready` — anything an agent sees, ' +
        'a planner can see.\n\n' +
        '## Acceptance criteria\n\n' +
        '- README has the new section under a clear heading.\n' +
        '- Both endpoints + the example POST body are present verbatim.\n' +
        '- No new docs file invented — this is a README addition, not a new site/page.',
      dependsOn: ['7.0.4', '7.0.5'],
    },
  ],
};
