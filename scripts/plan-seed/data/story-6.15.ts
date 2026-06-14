import type { PlanStory } from '../types';

/**
 * Story 6.15 — Board filtering (the disabled `[Filter]` seam, wired).
 *
 * The "board filter" that Stories 3.7, 3.8, 4.2, 4.5, and 4.7 all DEFER to in
 * prose — "board filters are **Epic 6**", "the over-cap banner points at the
 * Epic-6 board-filter seam", "when Epic-6 board/saved filters land the link can
 * carry the active filter query" — but which was never actually planned as a
 * story or subtask. The `/boards` toolbar ships a permanently **disabled
 * `[Filter]` button** (`app/(authed)/boards/page.tsx`: "Filter is a disabled
 * seam here — Epic 6 wires board filtering", tooltip `filterComingSoon`), and
 * the 3.8.4 `OverCapBanner` "refine your filter" CTA points at a filter UI that
 * does not exist — so on an over-cap board the user is told to refine a filter
 * they cannot open. Surfaced when a `motir mark`-time test found the board
 * Filter "not working / disabled" and the ownership check found NO Epic-6 story
 * picks it up: Story 6.1 (the filter builder) explicitly scoped its results to
 * the `/issues` navigator only ("the board surface is the documented
 * extension when a use case lands"). This story is that use case — it closes
 * the orphaned deferral (the same shape as the board-column-admin planning gap:
 * a capability deferred to an epic but owned by no story is a planning bug to
 * fix, not a scope cut — there is no v1 tier; the plan IS the product).
 *
 * Mirror-product check (decision-ladder rung 1 — Atlassian docs): a Jira board
 * is BACKED by a filter, and a user narrows what the board shows with **board
 * quick filters / the board's saved filter** — filtering is a first-class board
 * affordance, not issue-navigator-only. So a real Jira clone MUST let a user
 * filter the board; ours shipping the board read unfiltered (every card,
 * bounded only by the 3.8 cap) is the prototype shortcut the deferring stories
 * always flagged.
 *
 * Scope (narrowed per the no-shortcuts / completeness rules): REUSE, don't
 * rebuild. The structured filter AST + compiler (`lib/filters/*`, 6.1) and
 * saved filters (`lib/savedFilters/*`, 6.2) are done; the issue list already
 * threads a compiled predicate into its read (`workItemRepository
 * .findByProjectFiltered` via `resolveFilterAst`). This story (a) threads that
 * SAME compiled predicate into the board projection so each column shows only
 * matching cards (6.15.2), (b) enables the toolbar seam by mounting the SAME
 * filter builder + saved-filter picker the /issues surface uses, board-scoped +
 * URL-addressable (6.15.3), and (c) verifies it end-to-end (6.15.4). Out of
 * scope: any change to the filter GRAMMAR/compiler (6.1 owns it), cross-project
 * boards (still the 3.7 Epic-6 extension), and the Scrum sprint-scope filter
 * (4.5 — the board filter composes WITH it, narrowing within the active sprint,
 * but does not alter it).
 *
 * Design gate (planning-time): the board toolbar reserves the `[Filter]` seam
 * (its disabled placement is in `design/boards/`), and the filter builder +
 * saved-filter PICKER are designed+built (6.1 / 6.2). But the COMPOSITION on
 * the board — the open filter builder/picker anchored in the board toolbar,
 * the active-filter summary/chips, the filtered + filtered-EMPTY board states,
 * and coexistence with the 3.3 group-by `Segmented` control and the 3.8
 * over-cap banner — is net-new board chrome the existing board mocks do NOT
 * depict. Per the design gate ("an element/panel the mockup does not depict ==
 * NO design → add a `type: design` subtask, never improvise"), 6.15.1 produces
 * that board-filter design asset under `design/boards/`, and the UI code
 * subtask (6.15.3) `dependsOn` it and ships `status: 'blocked'` until it lands.
 *
 * Cross-epic dependency audit: clean — every dep points at Epic ≤ 6 (6.1 / 6.2
 * same-epic-earlier; 3.7 / 3.8 earlier epic, both done; 6.15.5 → 6.15.1
 * same-epic-earlier). No forward-pointing deps. The substrate (6.1 filter
 * AST/compiler, 6.2 saved filters, 3.7 board CRUD, 3.8 bounded/virtualized board
 * load + over-cap) is ALL done, so 6.15.1 (design) and 6.15.2 (service) are
 * immediately ready; 6.15.5 (the quick-filter Work type facet) is blocked on the
 * 6.15.1 design; 6.15.3 (UI) on 6.15.1 + 6.15.2 + 6.15.5; 6.15.4 (tests) on
 * 6.15.3.
 *
 * Added per `motir plan` after the board-Filter ownership check (the disabled
 * seam is intentional, but no Epic-6 story owned wiring it). Re-planned after
 * Yue flagged the quick filter is missing **Work type** filtering (the
 * `WorkItemType` field is defined + compiled in the 6.1 registry and reachable
 * via `[Advanced]`, but absent from the quick-filter facet set) — added 6.15.5
 * to add that facet to the SHARED `IssueFilterBar` (the board + `/issues` both
 * gain it). Canonical depth: a board-filter design (6.15.1), the filtered board
 * read (6.15.2), the toolbar filter UI (6.15.3), the story tests (6.15.4), and
 * the quick-filter Work type facet (6.15.5).
 */
export const story_6_15: PlanStory = {
  id: '6.15',
  title: 'Board filtering (wire the disabled board `[Filter]` seam)',
  status: 'planned',
  descriptionMd:
    'Wire the **board filter** that the `/boards` toolbar reserves as a permanently **disabled ' +
    '`[Filter]` button** today (`page.tsx`: "Filter is a disabled seam here — Epic 6 wires board ' +
    'filtering"). Stories **3.7 / 3.8 / 4.2 / 4.5 / 4.7** all defer board filtering to "Epic 6" in ' +
    'prose, and the **3.8.4 over-cap banner** ("refine the board filter") points at this seam — but ' +
    'no Epic-6 story ever owned it: **Story 6.1** scoped its filter builder to the **/issues ' +
    'navigator** only, naming the board "the documented extension when a use case lands." This is ' +
    'that use case. (Not a bug — the disabled state is a deliberate seam; the gap is the missing ' +
    'story, the same shape as the board-column-admin planning gap.)\n\n' +
    '**The verified shape (rung 1 — Atlassian docs).** A Jira board is backed by a filter and the ' +
    'user narrows it with board quick-filters / its saved filter — filtering is a first-class board ' +
    'affordance, not navigator-only. Today the board read (`boardsService.getBoard` / ' +
    '`loadColumnCards`) takes **no predicate** and projects every card (bounded only by the 3.8 ' +
    'cap), so a user cannot shrink an over-cap board even though the banner tells them to.\n\n' +
    '**The fix — REUSE, not rebuild.** The structured filter AST + compiler (`lib/filters/*`, 6.1) ' +
    'and saved filters (`lib/savedFilters/*`, 6.2) are done, and the issue list already threads a ' +
    'compiled predicate into its read (`findByProjectFiltered` via `resolveFilterAst`). This story ' +
    'threads that SAME predicate into the board projection (each column shows only matching cards), ' +
    'mounts the SAME filter builder + saved-filter picker on the board toolbar (board-scoped, ' +
    'URL-addressable, reload-safe), and points the over-cap "refine filter" CTA at it. The 3.8 ' +
    'bounded/virtualized load + over-cap `truncated` flag now apply to the **filtered** set, and ' +
    'the 4.5 Scrum sprint-scope filter composes with it (narrow WITHIN the active sprint).\n\n' +
    '**Plus — the missing Work type facet (6.15.5).** The shipped quick filter (`IssueFilterBar`) is ' +
    'a curated four-facet subset (text · kind · status · assignee); the **Work type** field ' +
    '(`WorkItemType` — `code/design/test/…` + the nullable **Untyped** bucket) was reachable only via ' +
    '`[Advanced]`, so a user could not filter the board (or the `/issues` list) by Work type from the ' +
    'quick popover. The FilterAST + 6.1 registry already DEFINE and COMPILE `type` ' +
    "(`enumField('type', 'type-select', { nullable, WORK_ITEM_TYPES })`), so this is a missing " +
    'quick-filter **facet**, not a grammar change — 6.15.5 adds the Work type facet group to the ' +
    'SHARED `IssueFilterBar` (so `/issues` gains it too), and the board reuses it.\n\n' +
    '**Out of scope.** The filter grammar/compiler/registry (6.1 owns `type` — already complete, no ' +
    'change) and the board read (6.15.2 threads whatever AST — `type` already compiles); cross-project ' +
    'boards (still the 3.7 Epic-6 extension); altering the Scrum scope filter (4.5). No new migration.',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (reports **"No difference ' +
    'detected"** — this story adds no schema; it reuses the 6.1 filter substrate), `pnpm db:seed`, ' +
    '`pnpm dev`.\n' +
    '- `pnpm test:coverage` — Vitest (real Postgres) over the filtered board read (predicate ' +
    'applied per column, the cap/`truncated` computed over the FILTERED set, workspace + ' +
    '6.4-permission scope) ≥ 90% per-file branch/fn/line.\n' +
    '- **The repro, now passing:** sign in as `zhuyue@motir.co` / `!QAZ1qaz` → `moooon` / `motir` ' +
    '→ `/boards`. The toolbar **Filter** is now **enabled**; open it, build a quick filter (e.g. ' +
    '`type = Bug`) or pick a saved filter → the board re-projects so every column shows only ' +
    'matching cards; the active filter shows as a chip/summary; **Clear** restores the full board. ' +
    'The selection survives a reload (it is in the URL).\n' +
    '- **Work type facet (6.15.5):** open the filter — the popover now shows a **Work type** group ' +
    '(Code / Design / Test / … + **Untyped**) between Kind and Status; selecting e.g. `Design` ' +
    'narrows the board to design work items. The SAME facet appears on `/issues` (shared ' +
    '`IssueFilterBar`).\n' +
    '- **Over-cap CTA:** on a board that exceeds the 3.8 cap, the "refine the board filter" banner’s ' +
    'CTA opens the filter (it no longer points at a dead seam); applying a filter that brings the ' +
    'set under the cap dismisses the banner.\n' +
    '- **Scrum compose:** on a Scrum board with an active sprint, a board filter narrows WITHIN the ' +
    'sprint scope (4.5) — it does not show cards outside the sprint.\n' +
    '- `pnpm test:e2e --grep board-filter` — apply a filter on a board end-to-end → only matching ' +
    'cards across columns → clear restores.\n' +
    '- **a11y:** the board filter affordance (closed / open builder / saved-filter picker / active ' +
    'chips / no-results board) passes the strict axe sweep; fully keyboard-operable; colour via ' +
    '`--el-*`, shape via element-semantic tokens; next-intl (en + zh).',
  items: [
    {
      id: '6.15.1',
      title:
        'Design — board filter surface: the enabled toolbar Filter affordance, the builder + saved-filter picker on the board, active-filter chips, filtered/filtered-empty states (design/boards/)',
      status: 'in_progress',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 40,
      dependsOn: [],
      descriptionMd:
        'The board-filter surface is net-new board chrome the existing `design/boards/` mocks do ' +
        'NOT depict (they draw the `[Filter]` button only as a DISABLED seam). Per the design gate, ' +
        'produce the design asset BEFORE the UI code subtask (6.15.3 `dependsOn` this).\n\n' +
        '**Deliver the THREE-file design-asset set under `design/boards/`** (CLAUDE.md design-asset ' +
        'rule): `board-filter.mock.html` (a self-contained mock built from the real design system — ' +
        '`components/ui/*` primitives + `--el-*` / shape tokens, NEVER Tier-0), a same-basename ' +
        '`board-filter.png` full-page export (Playwright chromium, light theme, `deviceScaleFactor: ' +
        '2`, width ~1200), and an update to `design/boards/design-notes.md` indexing the surface.\n\n' +
        '**Specify, REUSING the shipped filter primitives (do not redesign them):** the **enabled** ' +
        'Filter affordance in the board toolbar (replacing the disabled seam, beside the 3.3 ' +
        'group-by `Segmented` + "New issue"); the filter **builder** + **saved-filter picker** opened ' +
        'from it (the SAME `IssueFilterBar` / 6.2 saved-filter picker the /issues navigator uses — ' +
        'show its anchoring on the board, not a new control); the **active-filter summary/chips** + ' +
        'Clear; the **filtered board** and the **filtered-EMPTY board** state (no card matches — an ' +
        '`EmptyState`, distinct from the 3.2 brand-new-board empty state); and **coexistence** with ' +
        'the 3.8 **over-cap banner** (whose "refine filter" CTA opens this) and the group-by control. ' +
        'Multi-panel (closed · open builder · saved-filter picker · active/chips · filtered-empty · ' +
        'over-cap-with-filter).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/boards/board-filter.mock.html` + `board-filter.png` + a `design-notes.md` entry ' +
        'all land, naming every composing primitive (`IssueFilterBar`, the saved-filter picker, ' +
        '`Pill`/chip, `EmptyState`, `Button`, the toolbar) and the `--el-*` colour + shape-token role ' +
        'for each element.\n' +
        '- The mock reuses the existing filter builder + saved-filter picker (no hand-rolled filter ' +
        'UI); colour strictly via `--el-*`, shape via element-semantic tokens; AA holds; it shows the ' +
        'closed, open, active, filtered-empty, and over-cap-coexistence panels.\n' +
        '- No app code in this subtask — it ships on a `design/PROD-6.15.1-*` branch (CI skips E2E + ' +
        'integration + Vercel preview, per the design-prefix gate).\n\n' +
        '## Context refs\n\n' +
        '- `design/boards/` (the board mocks + `design-notes.md`; the disabled `[Filter]` seam ' +
        'placement) — THE layout authority to extend\n' +
        '- The 6.1 / 6.2 filter design (the `IssueFilterBar` + saved-filter picker mock + ' +
        'design-notes — the primitive to reuse, not redraw) + `app/(authed)/issues/_components/' +
        'IssueFilterBar.tsx` (the shipped markup)\n' +
        '- `app/(authed)/boards/_components/OverCapBanner.tsx` (the 3.8 banner the filter coexists ' +
        'with) + the 3.3 group-by `Segmented`\n' +
        '- `motir-core/CLAUDE.md` (the colour / shape token rules + the THREE-file design-asset DoD)',
    },
    {
      id: '6.15.2',
      title:
        'Filtered board read — thread a compiled filter predicate (6.1 AST) into getBoard/loadColumnCards; cap + `truncated` over the filtered set; Scrum-scope compose',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 32,
      dependsOn: [],
      descriptionMd:
        'Make the board projection filterable. Pure backend, no UI — the reusable read 6.15.3 ' +
        'consumes.\n\n' +
        '**`boardsService.getBoard`** grows an optional **filter input** — a `FilterAst` (built ' +
        'inline from a board query) OR a resolved **saved-filter id** (reuse the 6.2 saved-filter ' +
        'resolution + access gate). The service compiles it with the SAME `resolveFilterAst` ' +
        '(`lib/filters/registry.ts`) the /issues list uses, producing the Prisma `where` fragment, ' +
        'and threads it into **`loadColumnCards`** so each column’s card read is `AND`-ed with the ' +
        'predicate (mirror `workItemRepository.findByProjectFiltered` — the shipped precedent that ' +
        'applies a compiled filter to a project read). Repository writes still require `tx`; this is ' +
        'read-only.\n\n' +
        '**Cap / `truncated` over the FILTERED set (3.8).** The `BOARD_ISSUE_CAP` count + the ' +
        '`truncated` flag + the virtualization bound must be computed over the **filtered** result, ' +
        'not the whole board — so a filter that brings the set under the cap clears `truncated` ' +
        '(that is the over-cap banner’s whole purpose). **Scrum compose (4.5):** the predicate ' +
        '`AND`s with the existing active-sprint scope filter — it narrows WITHIN the sprint, never ' +
        'widening it. **Tenant + permission:** the explicit `workspaceId` gate (finding #26) and the ' +
        '6.4 project-access scope are unchanged and still apply.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `getBoard` accepts an optional filter (inline AST or saved-filter id); when present, each ' +
        'column projects ONLY matching cards; when absent, behaviour is byte-identical to today ' +
        '(no regression to the unfiltered board).\n' +
        '- `truncated` / the cap count / the virtualization bound are computed over the filtered ' +
        'set; a filter under the cap clears `truncated`. On a Scrum board the predicate composes ' +
        'with (does not replace) the 4.5 sprint scope.\n' +
        '- Invalid / unauthorized saved-filter id → a typed error the route maps (no raw Prisma ' +
        'escaping the service); workspace + 6.4 scope preserved; no schema change (`migrate dev` = ' +
        '"No difference detected"); `pnpm test:coverage` ≥ 90% on changed files.\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/boardsService.ts` (`getBoard` + `loadColumnCards` + the 3.8 cap/`truncated` ' +
        'logic + the 4.5 sprint-scope filter), `lib/mappers/boardMappers.ts`, `lib/dto/boards.ts`\n' +
        '- `lib/filters/ast.ts` + `lib/filters/registry.ts` (`resolveFilterAst` — the 6.1 compiler) ' +
        'and `workItemRepository.findByProjectFiltered` (the shipped "apply a compiled filter to a ' +
        'project read" precedent)\n' +
        '- `lib/savedFilters/*` (6.2 — saved-filter resolution + `access.ts` gate)\n' +
        '- finding #26 (explicit `workspaceId` tenant filter); `motir-core/CLAUDE.md` (4-layer)',
    },
    {
      id: '6.15.3',
      title:
        'Enable the board `[Filter]` seam — mount the builder + saved-filter picker (reuse IssueFilterBar/6.2), URL-driven board-scoped filter state, active chips + Clear, over-cap CTA opens it',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 34,
      dependsOn: ['6.15.1', '6.15.2', '6.15.5'],
      descriptionMd:
        'Replace the disabled `[Filter]` seam with the working board filter, per the 6.15.1 design, ' +
        'reading through 6.15.2. The reused `IssueFilterBar` already carries the Work type facet (6.15.5), ' +
        'so the board exposes it automatically — no board-specific filter UI.\n\n' +
        '**Enable the toolbar affordance** (`app/(authed)/boards/page.tsx` — drop `disabled` + the ' +
        '`filterComingSoon` tooltip) and mount the SAME filter **builder** + **saved-filter picker** ' +
        'the /issues navigator uses (reuse `IssueFilterBar` + the 6.2 picker — do NOT hand-roll a ' +
        'board-specific filter UI), anchored per the design. **URL-driven, board-scoped state:** the ' +
        'active filter lives in the URL (a `?filter=` AST param and/or a saved-filter id), composing ' +
        'with the existing `?board=<id>` selection (the 2.5.19 `?peek` / 3.7 board-selection pattern) ' +
        '— shareable + reload-safe, and **per board** (switching boards does not leak the filter). ' +
        'The board re-projects via 6.15.2 (the read is server-driven; follow the board’s existing ' +
        'fetch path — assert the response before asserting cards, never race the optimistic UI, per ' +
        'CLAUDE.md). **Active-filter chips + Clear**; the 3.8 **`OverCapBanner`** "refine filter" CTA ' +
        'now OPENS the filter (it currently points at the dead seam). **Filtered-empty** board → the ' +
        '6.15.1 `EmptyState` (distinct from the brand-new-board empty state). next-intl en + zh; ' +
        'drop the `filterComingSoon` key if now unused.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The board Filter is enabled; opening it shows the builder + saved-filter picker; applying ' +
        'a filter re-projects the board so each column shows only matching cards; the active filter ' +
        'shows as chips with Clear; the state is URL-addressable, reload-safe, and per-board.\n' +
        '- The over-cap banner CTA opens the filter; a filter under the cap dismisses the banner; the ' +
        'filtered-empty board shows the EmptyState; on a Scrum board the filter narrows within the ' +
        'active sprint.\n' +
        '- Matches the 6.15.1 design (reuses `IssueFilterBar` / the saved-filter picker — no ' +
        'hand-rolled filter UI); colour via `--el-*`, shape via element tokens; axe-clean; en + zh; ' +
        'component/interaction tests over the filter wiring; `pnpm test:coverage` ≥ 90%.\n\n' +
        '## Context refs\n\n' +
        '- `design/boards/board-filter.*` (6.15.1 — THE layout authority) + 6.15.2 (the filtered read)\n' +
        '- `app/(authed)/boards/page.tsx` (the disabled seam + `filterComingSoon`), the board ' +
        'toolbar / `BoardContainer` (the `?board=` selection + fetch path), ' +
        '`app/(authed)/boards/_components/OverCapBanner.tsx` (the 3.8 CTA to wire)\n' +
        '- `app/(authed)/issues/_components/IssueFilterBar.tsx` + the 6.2 saved-filter picker (the ' +
        'primitives to reuse) + the 2.5.19 `?peek` URL-state pattern\n' +
        '- `motir-core/CLAUDE.md` (colour/shape tokens; the "wait on the authoritative signal" rule ' +
        'for the re-project)',
    },
    {
      id: '6.15.4',
      title:
        'Story tests — filtered board read (predicate per column, cap over filtered set, permission/Scrum compose) + the board-filter E2E journey + a11y sweep',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['6.15.3'],
      descriptionMd:
        'The story-closing verification (Principle #18).\n\n' +
        '**Vitest (integration, real Postgres):** the filtered board read — the predicate applied ' +
        'per column, the `truncated`/cap computed over the FILTERED set (a filter under the cap ' +
        'clears `truncated`), the unfiltered path unchanged, the 6.4-permission + workspace scope, ' +
        'and the **Scrum compose** (the filter `AND`s with the 4.5 sprint scope, never widening it). ' +
        'An unauthorized/invalid saved-filter id → the typed error.\n\n' +
        '**Playwright E2E (`tests/e2e/board-filter.spec.ts`):** on a seeded board, open the toolbar ' +
        'Filter → apply a quick filter (kind `Bug`) → assert only matching cards across ' +
        'columns (wait on the board re-projection response, not the optimistic UI) → **toggle a Work ' +
        'type facet (e.g. `Design`) and assert the board re-projects to that work type** (the 6.15.5 ' +
        'facet) → apply a saved filter → Clear restores the full board → the over-cap banner CTA opens ' +
        'the filter; assert the URL carries the filter and survives reload. **a11y:** strict axe sweep ' +
        'over the filter affordance (closed / open builder incl. the Work type group / saved-filter ' +
        'picker / active chips / filtered-empty).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The read matrix (predicate per column · cap-over-filtered · unfiltered-unchanged · ' +
        'permission/tenant scope · Scrum compose · **work-type facet narrows the board** · typed ' +
        'saved-filter error) is green.\n' +
        '- The E2E journey passes in CI’s Playwright lane (async waits via the harness, not sleeps — ' +
        'arm `waitForResponse` before the action, per CLAUDE.md); the axe sweep reports zero ' +
        'violations.\n' +
        '- The Story 6.15 verification recipe runs clean top to bottom; `pnpm test:coverage` keeps ' +
        'all 6.15 files ≥ 90%.\n\n' +
        '## Context refs\n\n' +
        '- 6.15.2 (the read under test) + 6.15.3 (the UI journey)\n' +
        '- `tests/e2e/board-crud.spec.ts` / `board-scrum.spec.ts` (the board E2E setup + selector ' +
        'patterns to build on) + `tests/helpers/db.ts` (the large-seed fixture for the cap case)\n' +
        '- The E2E selector / "wait on the authoritative signal" memories; the Story 6.15 ' +
        'verification recipe — the checklist this automates',
    },
    {
      id: '6.15.5',
      title:
        'Quick-filter Work type facet — add the WorkItemType facet to the shared IssueFilterBar (facet state + facet→AST + i18n); the board + /issues both reuse it',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['6.15.1'],
      descriptionMd:
        'Add the **Work type** facet the quick filter is missing. The shipped quick-filter popover ' +
        '(`IssueFilterBar`) exposes text · kind · status · assignee; the **`WorkItemType`** field ' +
        '(`type`) is fully DEFINED + COMPILED in the 6.1 registry ' +
        "(`enumField('type', 'type-select', { nullable: true, valueWhitelist: WORK_ITEM_TYPES })`) " +
        'and is reachable via the `[Advanced]` builder — but NOT as a quick facet, so a user cannot ' +
        'filter by Work type from the popover. Add the facet to the SHARED component (the board and the ' +
        '`/issues` navigator both gain it). **No grammar/registry/compiler change and no board-read ' +
        'change** — `type` already compiles; this is purely the quick-filter facet + its state + the ' +
        'facet→AST conversion.\n\n' +
        '**Facet state** (`lib/issues/issueListFilter.ts`): add `types: WorkItemType[]` (+ an ' +
        '`includeUntyped` flag for the registry’s nullable empty bucket) to the `IssueFilter` shape, ' +
        'mirroring `kinds`/`statuses` — the `DEFAULT` value, the `toggleType` helper, and the ' +
        '`IssueFilterParams` URL round-trip (encode/decode), so the facet is shareable + reload-safe.\n\n' +
        '**Facet UI** (`app/(authed)/issues/_components/IssueFilterBar.tsx`): add the **Work type** ' +
        'group between Kind and Status per the 6.15.1 design — a `role="listbox" ' +
        'aria-multiselectable` of the 10 `WORK_ITEM_TYPES` (leading glyph = `WorkItemTypeIcon` in the ' +
        '`--el-type-*` hue, label `labels.workItemType.*`, trailing accent `Check`) + the **Untyped** ' +
        'row (the IS-NULL bucket). The active-count badge + the applied summary chips include the ' +
        'Work type values.\n\n' +
        '**Facet→AST** (`lib/filters/ast.ts` `facetFilterToAst`): push a ' +
        "`{ field: 'type', operator: 'is_any_of', value }` condition from the selected types, and " +
        'map the **Untyped** selection to the registry’s empty-bucket token (the same `is_empty` ' +
        'pattern `assignee`’s Unassigned uses) so the basic→advanced upgrade stays **lossless**. ' +
        'i18n en + zh (the `labels.workItemType.*` keys exist; add the facet group label, e.g. ' +
        '`filterWorkType`).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The quick-filter popover shows a **Work type** facet (the 10 types + **Untyped**); ' +
        'selecting types narrows the read to matching work types; the facet round-trips through the ' +
        'URL/params (reload-safe) and feeds the active-count badge + applied chips.\n' +
        '- `facetFilterToAst` emits the `type` `is_any_of` condition (and maps Untyped → the ' +
        'empty-bucket operator); the basic→advanced upgrade drops no condition (lossless), proven by a ' +
        'unit test over the new facet.\n' +
        '- NO change to the filter grammar/registry/compiler or the board read (they already support ' +
        '`type`); matches the 6.15.1 design (reuses `WorkItemTypeIcon` — no hand-rolled UI); colour via ' +
        '`--el-*`, shape via element-semantic tokens; axe-clean; en + zh; component + unit tests; ' +
        '`pnpm test:coverage` ≥ 90% on changed files.\n\n' +
        '## Context refs\n\n' +
        '- `design/boards/board-filter.mock.html` (6.15.1 — the Work type facet layout, panel 1) + ' +
        '`design/boards/design-notes.md` (the "NET-NEW in 6.15 — the Work type facet" note)\n' +
        '- `app/(authed)/issues/_components/IssueFilterBar.tsx` (the popover to extend) + ' +
        '`lib/issues/issueListFilter.ts` (the `IssueFilter` facet state + the param round-trip)\n' +
        '- `lib/filters/ast.ts` (`facetFilterToAst`) + `lib/filters/registry.ts` (the `type` field def ' +
        '— already complete) + `lib/issues/executorDefaults.ts` (`WORK_ITEM_TYPES`)\n' +
        '- `lib/issues/workItemTypeMeta.ts` (`WORK_ITEM_TYPE_META` — glyph + hue) + ' +
        '`components/issues/WorkItemTypeIcon.tsx`\n' +
        '- `messages/en.json` + `messages/zh.json` (`labels.workItemType.*` + the new `filterWorkType` ' +
        'group label); `motir-core/CLAUDE.md` (4-layer; colour/shape tokens)',
    },
  ],
};
