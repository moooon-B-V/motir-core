import type { EpicMeta } from '../types';

/**
 * The 8 v1 epics (metadata only — stories are attached in `index.ts`).
 * Statuses: Epic 1 done · Epic 2 in progress · Epics 3–8 planned. Epic-direct
 * `items` carry standalone bugs parented to the epic (Jira shape).
 * Transcribed from prodect_plan/epic-*.html (frozen archive).
 */
export const EPICS: EpicMeta[] = [
  {
    id: '1',
    title: 'Foundation',
    status: 'done',
    descriptionMd:
      'The architectural floor every other epic stands on: **project bootstrap**, **design ' +
      'system & brand**, authentication, multi-tenant workspaces, projects, the work-item schema, ' +
      'the web app shell, and async job infrastructure. Boring, foundational, non-negotiable. If ' +
      "this isn't solid, every other epic builds on sand. Built — all 8 stories (1.0–1.6) shipped.",
  },
  {
    id: '2',
    title: 'Issue tracking core',
    status: 'done',
    descriptionMd:
      'The irreducible Jira core — the first epic of the PM substrate that makes Prodect a usable ' +
      "standalone product. Built directly on Story 1.4's `work_item` model: issue types " +
      '(epic / story / task / bug), the issue detail view, create / edit, customizable per-project ' +
      'status **workflows**, assignees, and the issue list. After this epic a team can track real ' +
      'work by hand, with zero AI involved. The AI Planning Layer (Epic 7) later *generates* these ' +
      'same issues — but the manual path is the foundation and must stand on its own.',
    items: [
      {
        id: 'bug-finding-47',
        kind: 'bug',
        title: 'Workflow settings page has no nav entry point — orphaned route',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 2 · **Source:** Finding #47.\n\n' +
          'The `/settings/project/workflow` route (shipped in subtask 2.2.5) works — page + all ' +
          'six Server-Action writes — but **nothing links to it**. App navigation points only to ' +
          '`/settings/project` (which renders just the archive card) and `/settings/workspace`, so ' +
          'the workflow editor is reachable only by typing the URL (the Playwright spec reaches it ' +
          'via `page.goto`). Only discoverability is missing.\n\n' +
          '**Root cause / fix:** the `/settings/project` area has no settings sub-nav pattern (no ' +
          'tabs/sidebar) to hang a "Workflow" link on — a cross-cutting app-shell concern. ' +
          'Resolution: add a project-settings sub-nav (Workflow / Archive / …) so every settings ' +
          'sub-page has an entry point. **Links:** *discovered in* Story 2.2 (subtask 2.2.5); ' +
          '*fix belongs to* Story 1.5 (app-shell / settings-nav). Not nested under either — linked.\n\n' +
          '**Resolution (prodect-core `4bc4463`):** the `/settings/project` page now renders a ' +
          '**Workflow navigation card** linking to the editor — the minimal fix, reusing the ' +
          'existing Card grammar (a single `<Link>` wrapping the card, no new settings-nav chrome ' +
          'invented). E2E in `tests/e2e/workflow-settings.spec.ts` asserts the editor is reachable ' +
          'by clicking through from project settings (no `page.goto`). The fuller settings sub-nav ' +
          '(tabs / sidebar section across Workflow / Archive / …) remains a separate design ' +
          'decision, deferred — this fix only restores discoverability.',
      },
      {
        id: 'bug-tree-header-misalignment',
        kind: 'bug',
        title: 'Tree view: column values not aligned with their headers',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 2 · **Discovered in:** Story 2.5 (issue list — Tree ' +
          'view) · **Status:** fixed (PR #124, merged)\n\n' +
          'On the project issue list at `/issues`, the **Tree view** renders misaligned: the column ' +
          '**values** in each row do not line up with the column **headers** above them — the ' +
          'header row and the data cells sit on different horizontal grids, so the layout reads as ' +
          '"off". First observed in the seeded `moooon` / `prodect` project after the plan was ' +
          'migrated into the seed (with a full backlog to render, the misalignment is obvious).\n\n' +
          '**Repro:** sign in as `info@moooon.net`, open the `moooon` / `prodect` project → ' +
          '`/issues`, switch to **Tree** view, and observe that the column headers do not sit ' +
          'above their values.\n\n' +
          '**Root cause (confirmed by browser repro, not code-reading).** The lazy + sortable ' +
          '`IssueTreeTable` (2.5.14) remaps the shared `buildIssueColumns` to wrap each header in a ' +
          'sort button but DROPPED each column’s fixed `width`. `TreeTable` then falls back to ' +
          '`max-content` for those tracks; because every row is its OWN CSS grid, `max-content` ' +
          'sizes each row to its own content, so the header row and the data rows land on different ' +
          'column grids → drift (measured up to ~73px). The static/filtered tree + the List never ' +
          'drifted because they forward `width`. (The original "virtualized body computes widths ' +
          'independently" guess was directionally right about "independent widths" but wrong on ' +
          'mechanism — there is no virtualization; it was the dropped `width`.)\n\n' +
          '**Fix.** Forward `width: col.width` in `IssueTreeTable`’s column remap, so the header + ' +
          'every data row share one fixed-width grid. Guarded by a regression test asserting the ' +
          'header and data rows carry the same fixed-px grid template (not `max-content`), plus a ' +
          'browser pixel-alignment measurement during the fix.',
      },
      {
        id: 'bug-ready-banner-no-deps',
        kind: 'bug',
        title: '"Ready to start" banner is suppressed for items with no dependencies',
        status: 'planned',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 2 · **Surfaces:** issue detail relationships panel ' +
          '(Subtask 2.4.5) + issue-list quick-view peek (Subtask 2.5.21) · **Status:** open · ' +
          '**Reported by:** Yue.\n\n' +
          'The green **"Ready to start"** readiness banner only appears on a work item that **has ' +
          'at least one `is_blocked_by` blocker** (all of them terminal). An item with **no ' +
          'depended-on work item at all** shows **no banner** — even though "nothing blocks it" is ' +
          'the *most* ready an item can be. It SHOULD show "Ready to start" too: a todo-category ' +
          'item with zero open blockers is ready, whether that is because every blocker resolved ' +
          'OR because it never had any.\n\n' +
          '**Repro:** sign in as `zhuyue@prodect.co` / `!QAZ1qaz`, open the `moooon` / `prodect` ' +
          'project, open any todo-status issue that has **no** "blocked by" links, and observe the ' +
          'relationships panel shows no readiness banner. Open one that IS blocked by an issue that ' +
          'is already done → it correctly shows the green "Ready to start". The no-dependency item ' +
          'should match. Same gap in the issue-list quick-view peek.\n\n' +
          '**Root cause.** NOT the service and NOT the badge — both already handle the no-blocker ' +
          'case correctly. `workItemsService.getReadiness` returns `ready: true` with an empty ' +
          'open-blocker set when an item has no blockers ("An item with no blockers → ready"), and ' +
          '`components/ui/ReadinessBadge` renders the green "Ready to start" state whenever ' +
          '`ready` is true (its prop doc: "true iff every blocker is terminal **or none exist**"). ' +
          'The suppression is purely the **call-site gate** in the two consuming components, which ' +
          'short-circuit on the blocker COUNT before ever rendering the badge:\n' +
          '- `app/(authed)/issues/[key]/_components/RelationshipsPanel.tsx` — ' +
          "`const showReadiness = blockedBy.length > 0 && currentCategory === 'todo';`\n" +
          '- `app/(authed)/issues/_components/IssueQuickViewContent.tsx` — ' +
          '`detail.blockedBy.length > 0 ? {…} : null` (mirrors the same rule by design).\n\n' +
          'Both carry a comment rationalizing it ("an item nothing blocks has no signal to give") — ' +
          'that decision is what is being reversed: a no-dependency todo item DOES have a signal, ' +
          '"Ready to start".\n\n' +
          '**Fix.** Drop the `blockedBy.length > 0` precondition from BOTH gates; keep the ' +
          "`category === 'todo'` guard (readiness is still moot once in-progress / done). The " +
          'banner then renders off the `readiness` verdict alone: `ready` (no blockers, or all ' +
          'terminal) → green "Ready to start"; not-ready → peach "Blocked" naming the open ' +
          'blockers. No service or DTO change — the `readiness` verdict and `ReadinessBadge` ' +
          'already cover the empty-blocker case. Update the two stale "shows only when there ARE ' +
          'blockers" comments accordingly.\n\n' +
          '## Acceptance criteria\n\n' +
          '- A **todo-category** work item with **no** `is_blocked_by` blockers shows the green ' +
          '**"Ready to start"** banner on the issue detail relationships panel.\n' +
          '- The same item shows the "Ready to start" peek in the issue-list quick-view.\n' +
          '- An in-progress / done item still shows **no** readiness banner (the `todo` guard is ' +
          'retained on both surfaces).\n' +
          '- Existing behaviour is unchanged for items that DO have blockers: all-terminal → ' +
          '"Ready to start"; any open blocker → "Blocked" naming the open blockers.\n' +
          '- A regression test (component or E2E) covers the no-blocker todo item rendering ' +
          '"Ready to start" on both surfaces.\n\n' +
          '## Context refs\n\n' +
          '- `app/(authed)/issues/[key]/_components/RelationshipsPanel.tsx` — the `showReadiness` ' +
          'gate (the primary fix site) + its rationalizing comment\n' +
          '- `app/(authed)/issues/_components/IssueQuickViewContent.tsx` — the mirrored quick-view ' +
          'gate\n' +
          '- `components/ui/ReadinessBadge.tsx` — already renders the ready state for `ready: ' +
          'true` (no change expected)\n' +
          '- `lib/services/workItemsService.ts` — `getReadiness` / `isReady` (already returns ' +
          '`ready: true`, empty blockers, for the no-dependency case — no change expected)\n' +
          '- `design/work-items/relationships.mock.html` — the readiness-banner design source',
      },
    ],
  },
  {
    id: '3',
    title: 'Boards',
    status: 'planned',
    descriptionMd:
      'The primary day-to-day surface for a working team: the **Kanban board** that visualizes ' +
      'issues as cards in columns mapped to the workflow statuses from Epic 2. Drag-drop to ' +
      'transition, swimlanes to group, WIP limits to enforce flow. This is where the PM core stops ' +
      'being a database and starts feeling like Jira / Linear. The **Scrum board** (the ' +
      'sprint-scoped variant of the same surface) lives in Epic 4 as Story 4.5 — it needs ' +
      'sprints, which are Epic 4, so per `notes.html` mistake #32 it ships from inside Epic 4 ' +
      'rather than forward-pointing across epics from here. Kanban-only is a valid standalone ' +
      'use (mirror products: Jira and Linear both ship Kanban without sprints).',
    items: [
      {
        id: 'bug-attachment-fk-migration-drift',
        kind: 'bug',
        title: 'Every `prisma migrate dev` re-proposes dropping the hand-managed attachment FK',
        status: 'planned',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 3 · **Discovered in:** Subtask 3.3.2 (board ' +
          '`swimlaneGroupBy` enum + migration) · **Root cause owned by:** Story 2.3.7 (the ' +
          '`attachment` table + `add_attachment_and_rls` migration) · **Status:** open.\n\n' +
          'There is **persistent drift between `prisma/schema.prisma` and the migration history** ' +
          'on `main`: the `attachment` table carries an `attachment_uploader_user_id_fkey` foreign ' +
          'key created in raw SQL by `20260603120000_add_attachment_and_rls`, but the Prisma model ' +
          '`Attachment` deliberately declares `uploaderUserId` as a **plain scalar with no Prisma ' +
          '`@relation`** (so the `User` model needs no back-relation — see the model comment). ' +
          'Because the FK exists in the migration-built shadow DB but NOT in the schema graph, ' +
          '**every `prisma migrate dev` invocation auto-generates a spurious ' +
          '`ALTER TABLE "attachment" DROP CONSTRAINT "attachment_uploader_user_id_fkey";`** at the ' +
          'top of the new migration.\n\n' +
          '**Impact.** It is a recurring foot-gun, not a runtime bug: any author who runs ' +
          '`migrate dev` and commits the generated SQL verbatim will **silently drop a real FK** ' +
          '(losing referential integrity on `attachment.uploader_user_id`). Each migration must be ' +
          'hand-curated to delete that line — 3.1.1 (boards) and 3.3.2 (swimlane enum) both had to. ' +
          'It also makes `migrate dev` output noisy and easy to misread.\n\n' +
          '**Repro:** on `main`, edit any model in `prisma/schema.prisma`, run ' +
          '`pnpm prisma migrate dev --name probe`, and observe the generated migration begins with ' +
          'a `DROP CONSTRAINT "attachment_uploader_user_id_fkey"` unrelated to the edit.\n\n' +
          '**Fix options (decide at fix time):**\n' +
          '1. **Model the relation in Prisma** — add the `uploader User @relation(...)` (+ the ' +
          '`User` back-relation) so the schema graph matches the DB, eliminating the diff. This is ' +
          'the clean fix but adds the back-relation the 2.3.7 comment intentionally avoided; weigh ' +
          'that trade-off.\n' +
          '2. **Drop the FK from the DB too** and rely on the application layer (mirrors how some ' +
          'other scalar FKs are handled) — only if the referential guarantee is not wanted.\n' +
          'Either way, land a corrective migration so the schema and migration history agree and ' +
          '`migrate dev` stops re-proposing the drop. Until then, **every migration PR must curate ' +
          'the spurious `DROP CONSTRAINT` line out** (note it in the migration header, as 3.3.2 ' +
          'did).\n\n' +
          '## Acceptance criteria\n\n' +
          '- `pnpm prisma migrate dev` on an otherwise-unchanged schema produces **no** migration ' +
          '(empty diff) — i.e. no spurious `attachment_uploader_user_id_fkey` drop.\n' +
          '- The chosen fix lands as one corrective migration that applies cleanly on a fresh DB ' +
          'and is idempotent; `attachment.uploader_user_id` integrity ends up in the intended state ' +
          '(FK kept-and-modeled, or intentionally dropped — whichever option is chosen).\n' +
          '- A short note in `prodect-core/CLAUDE.md` (migration conventions) records the decision ' +
          'so the pattern is not reintroduced.\n\n' +
          '## Context refs\n\n' +
          '- `prisma/schema.prisma` — the `Attachment` model (`uploaderUserId` scalar, no relation) ' +
          '+ the `User` model\n' +
          '- `prisma/migrations/20260603120000_add_attachment_and_rls/migration.sql` — where the FK ' +
          'is created in raw SQL (Story 2.3.7)\n' +
          '- 3.3.2 feature PR — the curated migration whose header documents this drift; ' +
          '`prodect-core/CLAUDE.md` — migration conventions',
      },
      {
        id: 'bug-swimlane-lane-header-not-spanning-scrolled-columns',
        kind: 'bug',
        title:
          'Swimlane lane-header band stops at the viewport edge — does NOT extend over columns revealed by horizontal scroll (e.g. "Cancelled")',
        status: 'planned',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 3 · **Surfaces:** swimlane board (Subtask 3.3.5 — ' +
          '`SwimlaneBoard.tsx`) · **Status:** open · **Reported by:** Yue.\n\n' +
          'On the `/boards` swimlane view (group-by Assignee / Priority / Epic), the **lane-header ' +
          'group row** (the soft tinted band that introduces each lane, with the chevron + label + ' +
          'count) only paints across the columns that fit in the viewport at render time. When the ' +
          'column track is wider than the viewport and the user scrolls horizontally to reveal more ' +
          'columns — e.g. the rightmost **Cancelled** column in the reported repro — **the band is ' +
          'absent over those scrolled-into-view columns**. The pinned top column-header row (the ' +
          'row that names each workflow column with its count + WIP chip) spans the full track ' +
          'correctly; only the lane band breaks. Result: each lane visually "ends" mid-board and ' +
          'the trailing columns look ungrouped, breaking the swimlane grouping illusion that the ' +
          '3.3.1 design promises.\n\n' +
          '**Repro:** sign in as `zhuyue@prodect.co` / `!QAZ1qaz`, open the `moooon` / `prodect` ' +
          'project → `/boards`, switch group-by to anything other than `none` (Assignee / Epic / ' +
          'Priority). Narrow the browser so the column track overflows horizontally (or use a ' +
          'project with the full default workflow `todo · in_progress · in_review · done · ' +
          'cancelled` — five columns at 288px + gutters overflow most laptop viewports). Scroll ' +
          'right inside the board. Observe that the soft lane-header band (`bg-(--el-surface-soft)` ' +
          'for normal lanes / `bg-(--el-muted)` for the catch-all) does NOT extend over the ' +
          'Cancelled column header area — only the bottom border of the lane (the row separator) ' +
          'continues, the tinted band itself stops. The pinned top column-header row spans the full ' +
          'track correctly, which is the visual giveaway that the lane header is the broken row.\n\n' +
          '**Root cause.** In `app/(authed)/boards/_components/SwimlaneBoard.tsx` (Subtask 3.3.5), ' +
          'the lane-header element is `sticky left-0 z-[2] flex w-full …` inside the outer ' +
          '`overflow-x-auto` container. The track rows (column-header, lane cells, load-more) use ' +
          '`flex min-w-max gap-3.5 px-6` so they grow to the intrinsic width of all columns. The ' +
          'lane header does NOT — it uses `w-full`, which on a `position: sticky` child inside an ' +
          "overflow-x scroller resolves to the **containing block's width = the scroller's " +
          'visible (clientWidth) area**, NOT the scroll width. So the band is exactly as wide as ' +
          'whatever portion of the board fits in the viewport when the lane mounts, and stays that ' +
          'width as you scroll right. The `sticky left-0` keeps the lane LABEL pinned to the left ' +
          'edge (correct behaviour — that IS the design), but the lane BAND should still extend ' +
          'across the full track behind the columns; today the two intents collide on the same ' +
          'element.\n\n' +
          '**Fix (decide at fix time — both are mechanical):**\n' +
          '1. **Split label and band.** Make the lane row a `track`-class row (so it gains ' +
          '`min-w-max`) and put a `sticky left-0` *inner* element around just the label + chevron ' +
          '+ count. The outer row paints the band across the full track; only the label sticks to ' +
          "the left edge. Mirrors the column-header row's shape; lowest risk.\n" +
          '2. **Replace `w-full` with `w-max` on the current element.** Keeps the structure but ' +
          'lets the sticky box grow to the scroll width; the `sticky left-0` still pins the visible ' +
          'portion. Verify the click target + keyboard semantics stay sensible (the whole band is ' +
          'an `aria-expanded` `role="button"` today — a wider band still works, but a fix-time ' +
          'sanity-check is warranted).\n' +
          'Option 1 is the cleaner of the two and matches the design-notes intent ("sticky-left ' +
          '`.lane-head` … above its `.lane-cols`"). Either way the fix is contained to ' +
          '`SwimlaneBoard.tsx`; no projection / service / DTO change. The same `track` measurement ' +
          "already used by the column-header row should drive the lane band's width to keep them " +
          'in lockstep when columns are added/removed.\n\n' +
          '## Acceptance criteria\n\n' +
          '- On a swimlane-grouped board whose column track is wider than the viewport, the ' +
          'lane-header band paints over the **full** track — including columns revealed by ' +
          'horizontal scroll (the Cancelled column in the repro).\n' +
          '- The lane label + chevron + count still STICK to the left edge as the user scrolls ' +
          "horizontally (the sticky-label behaviour is preserved — only the band's width extent " +
          'changes).\n' +
          '- The pinned top column-header row remains unchanged (it already spans correctly today, ' +
          'guard against regression).\n' +
          '- Collapsed lanes still collapse correctly; the catch-all lane (`bg-(--el-muted)`) and ' +
          'the named lanes (`bg-(--el-surface-soft)`) both render the band across the full track; ' +
          'AA contrast preserved.\n' +
          '- A Playwright regression in `tests/e2e/board-swimlanes.spec.ts` (or a sibling) ' +
          "asserts that the lane-header element's rendered width matches the column track's " +
          'width on a board narrower than its content (measure via ' +
          '`element.getBoundingClientRect()` rather than CSS rule inspection — same posture as ' +
          'the tree-header-misalignment fix).\n\n' +
          '## Context refs\n\n' +
          '- `app/(authed)/boards/_components/SwimlaneBoard.tsx` — the lane-header `div` with ' +
          '`sticky left-0 z-[2] flex w-full …` (the fix site) + the `track` shared-class for the ' +
          'column-header / cell / load-more rows it should align with\n' +
          '- `design/boards/swimlanes-wip.mock.html` + `design/boards/design-notes.md` (Subtask ' +
          '3.3.1) — the design source: a sticky-left `.lane-head` LABEL above its `.lane-cols` ' +
          'row, with the band intended to span the full track\n' +
          '- `prodect-core/CLAUDE.md` — colour via `--el-*`, shape via element-shape tokens ' +
          '(applies to whatever new wrapper the fix introduces)\n' +
          '- `tests/e2e/board-swimlanes.spec.ts` — where the regression check belongs, mirroring ' +
          'the structural posture of the `bug-tree-header-misalignment` fix (measure rendered ' +
          'width, not CSS rules)',
      },
    ],
  },
  {
    id: '4',
    title: 'Agile planning',
    status: 'planned',
    descriptionMd:
      'Sprint-based delivery on top of the issue tracker: the **backlog**, **sprints** (create / ' +
      'start / complete), **story-point estimation**, the **Scrum board** (the Epic-3 Kanban ' +
      "surface scoped to a board's active sprint, under a sprint header — Story 4.5, moved here " +
      'from Epic 3 per mistake #32 so it ships alongside the sprints it depends on), and the ' +
      'velocity + burndown charts that make iteration measurable. Turns Prodect from an issue ' +
      'tracker into a full agile-planning tool — the Scrum half of the Jira feature set, with ' +
      'the Scrum view sitting on the same board substrate Epic 3 already shipped.',
  },
  {
    id: '5',
    title: 'Collaboration & fields',
    status: 'planned',
    descriptionMd:
      'The layer that turns an issue from a record into a team workspace: **comments**, ' +
      '**@mentions**, **attachments**, **custom fields**, labels / components, assignees / ' +
      'watchers, and a per-issue **activity history**. The collaboration depth users expect from ' +
      "Jira before they'll switch.",
  },
  {
    id: '6',
    title: 'Search, reporting & admin',
    status: 'planned',
    descriptionMd:
      'The tools that make the PM core enterprise-usable and complete the standalone Jira ' +
      'alternative: **search & filtering**, **dashboards & reports**, **roles & permissions**, ' +
      'project admin, and **automation rules**. After this epic, prodect-core is a feature-complete ' +
      'PM tool — ready for the AI Planning Layer (Epic 7) to sit on top.',
  },
  {
    id: '7',
    title: 'AI Planning Layer',
    status: 'planned',
    descriptionMd:
      'The headline differentiator — a feature layered on the now-complete PM core (Epics 1-6). A ' +
      'chat front door drafts discovery context, generates and augments the issue tree in the PM ' +
      'core (the former "pre-plan" + "build phase"), and an execution surface turns issues into ' +
      'agent-ready prompts dispatched to the user\'s own coding agent (the former "execution" ' +
      'epic). This is the closed `prodect-ai` layer the open core calls into over a documented ' +
      'HTTP API. A team that never opens the chat box still has a full Jira alternative; this epic ' +
      'makes Prodect AI-native on top of that.',
  },
  {
    id: '8',
    title: 'Launch readiness',
    status: 'planned',
    descriptionMd:
      'Everything between "feature complete" and "live, paid users." Stripe billing, marketing ' +
      'landing page, ToS + privacy policy, transactional email, basic analytics, production ' +
      'deploy, domain + SSL, onboarding, and day-1 admin tools. Most of this is human subtasks ' +
      "running through Prodect's own queue. (Formerly Epic 5.)",
  },
];
