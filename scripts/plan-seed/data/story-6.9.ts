import type { PlanStory } from '../types';

/**
 * Story 6.9 — Quick issue search (server-side issue-picker search).
 *
 * The "Search Story" that Stories 1.5 (cmd-K palette), 2.4.9 (link picker),
 * and 2.5 (issue-list text search) all DEFER to in prose — "full server
 * search is Epic 6", "Epic 6's Search Story owns that" — but which was never
 * actually planned as a story or subtask. Surfaced as **finding #98**: the
 * link/blocker picker (`workItemRepository.findLinkCandidates`) loads only the
 * 50 newest-created work items (`orderBy createdAt desc, take 50`) and filters
 * CLIENT-side, so in the 400+-item plan tenant ~88% of issues — including the
 * mid-plan 6.6.5 — are unreachable by search; you literally cannot pick an
 * older issue as a blocker. This story closes that gap with a reusable
 * server-side quick-search read.
 *
 * Mirror-product check (decision-ladder rung 1 — Atlassian docs): Jira's
 * issue-link / issue-picker control SERVER-searches issues by key + summary
 * as you type (the dedicated issue-picker endpoint), never a fixed recent
 * window filtered locally; the global quick-search / command palette does the
 * same. So server-side, query-driven search is the verified shape — ours was
 * a prototype shortcut (the 2.4.9 card knowingly shipped "a simple
 * prefix/contains read ... full search is Epic 6").
 *
 * Scope (narrowed per the no-shortcuts / completeness rules): build the
 * REUSABLE quick-search read once (6.9.1) and retrofit the BROKEN surface —
 * the link/blocker picker — onto it (6.9.2, closes #98). The cmd-K palette
 * (1.5's anticipated "Search" group) and the /issues quick-find (2.5's scoped
 * `contains`) are the SAME read's other consumers; they are functional-but-
 * limited today (not broken like the picker), so they are recorded here as
 * follow-on consumers to be planned as their own subtasks when those surfaces
 * are revisited — NOT built in this story (no scope creep onto unbroken
 * surfaces).
 *
 * Substrate already shipped: 6.1.1 built the `pg_trgm` GIN index + ILIKE
 * contains-match over title/description, and 6.4 (project access) is done —
 * so this story adds NO migration; it exposes a permission-scoped, bounded,
 * query-driven read over that existing index.
 *
 * Design gate (planning-time): the link picker is an EXISTING surface
 * (`design/work-items/links.mock.html`, 2.4.9 — kind selector + issue-search
 * Combobox with its typing/empty/selected states). 6.9.2 changes its DATA
 * SOURCE (server query vs. client filter over a fixed window), not its
 * layout — no new UI element, so NO `type: design` subtask is required; the
 * existing asset is linked in 6.9.2's context refs.
 *
 * Cross-epic dependency audit: clean — every dep points at Epic ≤ 6 (6.1.1
 * same-epic-earlier; 6.4 done substrate). No forward-pointing deps.
 *
 * Added per `motir plan` after finding #98 (the picker scale bug + the
 * phantom-Search-Story gap). Canonical depth: a reusable read (6.9.1), the
 * picker retrofit (6.9.2), and the story tests (6.9.3).
 */
export const story_6_9: PlanStory = {
  id: '6.9',
  title: 'Quick issue search (server-side issue-picker search)',
  status: 'in_progress',
  descriptionMd:
    'The reusable **server-side issue quick-search** the pickers need — and the "Search Story" ' +
    'that Stories 1.5 / 2.4.9 / 2.5 defer to in prose but that was never planned (surfaced as ' +
    '**finding #98**). Today the link/blocker picker loads the **50 newest-created** work items ' +
    'and filters client-side, so on a real tenant (the plan tenant has 400+ items) most issues ' +
    'are invisible to search and **cannot be linked at all** — you cannot pick an older issue ' +
    'as a blocker.\n\n' +
    '**The verified shape (rung 1 — Atlassian docs).** Jira’s issue-picker / link control ' +
    'SERVER-searches issues by **key + summary** as you type (a dedicated, bounded issue-picker ' +
    'read), never a fixed recent window filtered locally. Ours matches: a query-driven read over ' +
    'the **6.1.1 `pg_trgm` index** (ILIKE contains on title + key prefix/exact), **workspace-' +
    'scoped + 6.4-permission-aware** (you only find issues you may see), **bounded** to a page ' +
    'size (finding #57 — never an unbounded fetch), ordered by relevance (exact-key first, then ' +
    'title match).\n\n' +
    '**The fix (closes #98).** The link/blocker candidate read composes that quick-search with ' +
    'the existing direction-aware **exclusions** (self + already-linked for the chosen ' +
    'relationship), and the picker’s Combobox goes **query-driven** (debounced fetch per ' +
    'keystroke) instead of fetch-newest-50-then-client-filter. Both link surfaces (the 2.4.9 ' +
    'detail panel and the 2.4.10 create modal) ride the same control, so both are fixed at once.' +
    '\n\n' +
    '**Out of scope (recorded follow-on consumers, each its own future subtask).** The cmd-K ' +
    'palette’s "Search" group (1.5’s anticipated consumer) and the /issues quick-find ' +
    '(2.5 ships a scoped `contains` today) are the SAME read’s other consumers; they are ' +
    'limited-but-functional, not broken like the picker, so they are deliberately NOT built here ' +
    '— they adopt 6.9.1 when those surfaces are next touched (no scope creep onto unbroken ' +
    'UI). No new migration: this rides the index 6.1.1 already shipped.',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (reports **"No ' +
    'difference detected"** — this story adds no schema; it reuses the 6.1.1 `pg_trgm` ' +
    'index), `pnpm db:seed`, `pnpm dev`.\n' +
    '- `pnpm test:coverage` — Vitest (real Postgres) over the quick-search read (key + ' +
    'title trgm, permission scope, bound, ordering) and the link-candidate composition ' +
    '(exclusions preserved) ≥ 90% per-file branch/fn/line.\n' +
    '- **The #98 repro, now passing:** sign in as `zhuyue@motir.co` / `!QAZ1qaz` → open a ' +
    'late-plan issue (e.g. an Epic-6 subtask) → relationships panel → **Link issue** ' +
    '→ set "is blocked by" → type an **early-plan** issue’s key (e.g. `PROD-3`) or ' +
    'a title fragment → it **appears** (it is nowhere near the 50 newest) and links. Before ' +
    'this story the same search returned nothing.\n' +
    '- **Exclusion + permission:** the current issue and already-linked issues never appear; an ' +
    'issue in a project the signed-in user cannot access (6.4) does not appear; the create-modal ' +
    'link control searches identically.\n' +
    '- **Scale:** with the 400+-item seed the picker search returns matches across the WHOLE ' +
    'tenant (not just recent), bounded to the page size, with no full table scan (the trgm index ' +
    'is used — spot-check with EXPLAIN).\n' +
    '- `pnpm test:e2e --grep link` — the picker journey (open → search an old issue ' +
    '→ link → it renders in its group).\n' +
    '- **a11y:** the link form (kind selector + searching Combobox: empty / typing / no-results ' +
    '/ selected) passes the strict axe sweep; fully keyboard-operable; colour via `--el-*`.',
  items: [
    {
      id: '6.9.1',
      title:
        'Reusable server-side issue quick-search read — key + title (trgm), workspace + 6.4-permission scoped, bounded + relevance-ordered',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['6.1.1'],
      descriptionMd:
        'The shared read both pickers (and, later, the cmd-K palette) consume. Pure backend, ' +
        'no UI.\n\n' +
        '**`workItemSearchRepository` (or an addition to `workItemRepository`)** — a ' +
        'single query-op: given `workspaceId`, a `query` string, and a `limit`, return ' +
        'non-archived work items whose **key** matches (prefix / exact, case-insensitive) OR ' +
        'whose **title** ILIKE-contains the query, using the **6.1.1 `pg_trgm` GIN index** (a ' +
        'contains-scan over 10k titles must not table-scan), ordered relevance-first (exact-key ' +
        '→ key-prefix → title match), bounded to `limit`. Read-only → the `db` ' +
        'singleton; **explicit `workspaceId` gate** (finding #26 — the primary tenant ' +
        'filter, since RLS is inert under the dev/CI superuser).\n\n' +
        '**`workItemsService.quickSearch(query, ctx, opts)`** (4-layer) — trims/guards ' +
        'the query (empty → empty result, no scan; a minimum-length guard), applies the ' +
        '**6.4 project-access** filter so a user only finds issues in projects they may read ' +
        '(reuse the shipped `projectAccessService` predicates — the same gate the issue ' +
        'list rides), maps rows to `WorkItemSummaryDto`, and bounds the page. No new route is ' +
        'required by THIS subtask (6.9.2 wires it behind the existing link action); expose it as ' +
        'a service method the actions/route layer calls.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The read matches on key (prefix/exact) AND title (trgm ILIKE), is bounded, and is ' +
        'relevance-ordered; EXPLAIN shows the `pg_trgm` index used (no full scan) on the large ' +
        'seed.\n' +
        '- `quickSearch` is workspace-scoped AND 6.4-permission-scoped (a user cannot find an ' +
        'issue in a project they cannot read — asserted per role); empty / whitespace / ' +
        'below-min-length query returns empty without scanning.\n' +
        '- Returns `WorkItemSummaryDto[]`; no schema change (`migrate dev` = "No difference ' +
        'detected"); `pnpm test:coverage` ≥ 90% on the new files.\n\n' +
        '## Context refs\n\n' +
        '- 6.1.1 `lib/filters/*` + the `pg_trgm` index migration (the substrate this reuses); ' +
        'the 2.5 issue-list `contains` read (`findByProjectFiltered` / the list query — the ' +
        'closest shipped text-match precedent)\n' +
        '- `lib/services/projectAccessService.ts` + the 6.4 read predicates (the permission ' +
        'gate); finding #26 (the explicit `workspaceId` tenant filter)\n' +
        '- `WorkItemSummaryDto` + `toWorkItemSummaryDto` (the return shape)\n' +
        '- `motir-core/CLAUDE.md` (4-layer, required-tx on writes — N/A here, read-only)',
    },
    {
      id: '6.9.2',
      title:
        'Link/blocker picker retrofit — candidate read becomes query-driven server-side (closes finding #98); both link surfaces',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 24,
      dependsOn: ['6.9.1'],
      descriptionMd:
        'Make the link picker actually find any issue — the finding-#98 fix. UI behaviour ' +
        'change on an EXISTING surface (no new component, no design subtask).\n\n' +
        '**Backend:** replace `findLinkCandidates`’ newest-50 window with the 6.9.1 ' +
        'quick-search composed with the existing **direction-aware exclusions** — ' +
        '`listLinkCandidates` passes the typed `query` + the (self + already-linked-for-this-' +
        'relationship) exclude set + the bound into `quickSearch`, so the result is a SEARCHED, ' +
        'excluded, bounded candidate page (not a recent slice). `listLinkCandidatesAction` ' +
        'grows a `query` parameter.\n\n' +
        '**Frontend (`AddLinkControl` + `LinkAddForm`):** the issue-search Combobox goes ' +
        '**query-driven** — debounced server fetch as the user types (the same Combobox ' +
        'already shows loading / no-results / selected states), instead of fetching newest-50 ' +
        'once and filtering client-side. Re-fetch on relationship change (the exclusion set ' +
        'differs) is preserved. Keep the immediate-write Add path (`createLinkAction` → ' +
        'refresh) and the typed-error banner unchanged. The 2.4.10 create-modal control ' +
        '(`CreateIssueLinksField`) rides the same shared form, so it is fixed in lockstep.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The #98 repro passes: from a late-plan issue, typing an early-plan issue’s key ' +
        'or title fragment surfaces it and links it (it is outside any newest-N window); the ' +
        'newest-50 cap is gone.\n' +
        '- Exclusions hold (self + already-linked for the chosen relationship never appear); ' +
        'permission scope holds (6.9.1); both the detail panel and the create modal search ' +
        'server-side; the Combobox debounces and shows loading / no-results states; colour via ' +
        '`--el-*`, shape via element tokens; axe-clean; next-intl.\n' +
        '- Integration tests over the searched candidate read (query + exclusion + bound) and ' +
        'the action; `pnpm test:coverage` ≥ 90%.\n\n' +
        '## Context refs\n\n' +
        '- **finding #98** (the bug + root cause); 6.9.1 (the read it composes)\n' +
        '- `app/(authed)/issues/[key]/_components/AddLinkControl.tsx`, ' +
        '`components/issues/LinkAddForm.tsx`, the `listLinkCandidatesAction` action, ' +
        '`workItemsService.listLinkCandidates`, `workItemRepository.findLinkCandidates`\n' +
        '- `design/work-items/links.mock.html` + design-notes (2.4.9 — the EXISTING picker ' +
        'design; data-source change only, layout unchanged) — THE authority\n' +
        '- The i18n threading pattern; the Combobox primitive (debounced async options)',
    },
    {
      id: '6.9.3',
      title:
        'Story tests — quick-search correctness + permission/exclusion + the #98 large-seed regression E2E + a11y sweep',
      status: 'in_progress',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 26,
      dependsOn: ['6.9.2'],
      descriptionMd:
        'The story-closing verification (Principle #18).\n\n' +
        '**Vitest (integration, real Postgres):** quick-search correctness (key prefix/exact + ' +
        'title trgm, relevance order, bound), the permission scope (a user cannot find issues in ' +
        'a project they cannot read — per 6.4 role), the link-candidate composition ' +
        '(exclusions preserved under search), and the **#98 regression guard**: seed a large ' +
        'item set, prove an EARLY-created issue is returned by a search from a LATE issue’s ' +
        'picker (the exact case the newest-50 cap broke).\n\n' +
        '**Playwright E2E (extend `tests/e2e/*link*`):** open a late issue’s relationships ' +
        'panel → Link issue → type an early issue’s key → it appears → ' +
        'link it → it renders in its group; assert the no-results state; assert the create-' +
        'modal link control searches the same way. **a11y:** strict axe sweep over the link form ' +
        '(empty / typing / no-results / selected).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The correctness + permission + exclusion matrix is green; the #98 large-seed ' +
        'regression guard fails on the old newest-50 read and passes on the new one.\n' +
        '- The E2E journey passes in CI’s Playwright lane (async waits via the harness, not ' +
        'sleeps); the axe sweep reports zero violations.\n' +
        '- The Story 6.9 verification recipe runs clean top to bottom; `pnpm test:coverage` ' +
        'keeps all 6.9 files ≥ 90%.\n\n' +
        '## Context refs\n\n' +
        '- finding #98 (the behaviour the regression guard pins); 6.9.1 / 6.9.2\n' +
        '- `tests/integration/` + `tests/e2e/` conventions; the E2E harness / selector ' +
        'memories\n' +
        '- The Story 6.9 verification recipe — the checklist this automates',
    },
  ],
};
