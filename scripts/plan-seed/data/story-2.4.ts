import type { SeedStory } from '../types';

/**
 * Story 2.4 — Issue detail view.
 * Faithful transcription of prodect_plan/story-2.4-issue-detail.html (frozen archive).
 */
export const story_2_4: SeedStory = {
  id: '2.4',
  title: 'Issue detail view',
  status: 'done',
  descriptionMd:
    'The canonical issue page — the read surface a `PROD-N` link opens. A Server-Component' +
    ' route at `/issues/[key]` that composes the shipped reads (`getWorkItem`,' +
    ' children, parent chain, links, revisions) into one page: header (type icon · identifier · title ·' +
    ' status), the rendered Markdown description + AI-drafted explanation, a read-only core-fields panel,' +
    ' a parent breadcrumb + child list for tree navigation, a **workflow-aware inline status' +
    ' control** and an **inline assignee picker** (the only two write affordances on' +
    " the page — everything else routes to 2.3.6's edit form), and a relationships panel that becomes the" +
    " FIRST production caller of 2.2.6's `isReady` (finding #21's payoff — the blocked/ready" +
    ' badge). The layout reserves explicit, documented extension slots for Epic 5 (comments · attachments ·' +
    ' custom fields · activity) so that Story lands as additions, not a rewrite.\n\n' +
    '**Prerequisites (all shipped or in-flight):** Story 1.4 ships the work-item reads' +
    ' (`workItemsService.getWorkItem`, `listChildren`, `getWorkItemSubtree`,' +
    ' `listRevisions`) + the `work_item_link` dependency table. Story 2.1 ships the' +
    ' type metadata + icons (`lib/issues/issueTypes.ts`). Story 2.2 ships the workflow statuses /' +
    ' transitions / `category` taxonomy and `workflowsService.isReady` +' +
    ' `canTransition` (2.2.6 — this Story is its first PRODUCTION caller; until now `isReady`' +
    ' is exercised only by the `_test` route). Story 2.3 ships `MarkdownView` (2.3.5),' +
    ' the filtered pickers + `StatusPicker`/`AssigneePicker` (2.3.4/2.3.6), and the' +
    ' `/issues/[key]/edit` route (2.3.6) the detail page\'s "Edit" button targets. **This' +
    " Story is read-first**: it adds NO new mutation primitives — the two inline controls reuse 2.2.4's" +
    " gated `updateStatus` and 2.3.6's now-status-free `updateWorkItem` (for assignee)." +
    " All routes follow `motir-core/CLAUDE.md`'s 4-layer architecture and carry an explicit" +
    ' `workspaceId` gate at the application layer (finding #26 — RLS is defense-in-depth, inert' +
    ' under the dev/CI superuser until the Epic-8 cutover). **Route reconciliation (rung 2 > rung' +
    ' 3):** issue routes live under the shipped active-project shell at `app/(authed)/issues/[key]/`' +
    ' (resolving the active project via `getActiveProject()`), NOT the card-illustrative' +
    ' `/projects/[key]/issues/...` — same decision recorded as finding #50 for 2.3.3/2.3.6. The' +
    " detail page (`page.tsx`) and 2.3.6's edit page (`edit/page.tsx`) are siblings in" +
    ' that tree; `getWorkItemByIdentifier` is shared — whichever of 2.4.1 / 2.3.6 lands first adds' +
    ' it, the other reuses it (do NOT add a second copy).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install && pnpm prisma generate && pnpm prisma migrate dev`' +
    ' against a fresh local DB (no new migration expected — this Story is read-first).\n' +
    '- `pnpm test` — Vitest covers: `getIssueDetail` shape + cross-workspace 404 (2.4.1); fields' +
    ' panel + AI-drafted badge (2.4.2); breadcrumb/children + isolation (2.4.3); inline' +
    ' status/assignee actions (2.4.4); readiness verdict + link grouping (2.4.5).\n' +
    '- `pnpm test:e2e` — `issue-detail-flow` (2.4.6 — incl. the link add/remove + guardrail' +
    ' scenarios from 2.4.9) + the shell-a11y sweep on `/issues/[key]` (incl. the open add-link' +
    ' combobox).\n' +
    '- **Manual UX check — read:** open a `PROD-N` link; confirm header, rendered Markdown' +
    ' description, AI-drafted explanation badge, core fields, parent breadcrumb, child list all' +
    ' render; the "Edit" button opens the 2.3.6 form.\n' +
    '- **Manual UX check — inline edits:** change status via the inline control (only legal targets' +
    ' offered); reassign + unassign; both persist across reload; an illegal transition is not' +
    ' silently applied.\n' +
    '- **Manual UX check — readiness:** create A blocked-by B; A\'s detail page reads "Blocked' +
    ' (B)"; move B to Done; A reads "Ready".\n' +
    "- **Manual UX check — link management (2.4.9):** from A's relationships panel, add a" +
    ' "relates to" link to C via the combobox → C appears under "Relates to"; add a "blocked by"' +
    ' → the readiness banner flips to Blocked; remove a link inline → it disappears and the banner' +
    ' re-judges; a self-link / duplicate is rejected inline.\n' +
    '- **Cross-workspace check:** as a workspace-A-only user, visit a workspace-B issue URL → 404' +
    ' (no leak of title/existence).',
  items: [
    {
      id: '2.4.1',
      title: 'Detail route `/issues/[key]` + `getIssueDetail` read + page shell',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 16,
      descriptionMd:
        'The route + data spine the rest of the Story hangs off. A Server Component at' +
        ' `app/(authed)/issues/[key]/page.tsx` resolves the active project' +
        ' (`getActiveProject()`) and reads the work item BY ITS PROJECT-SCOPED IDENTIFIER' +
        " (e.g. `PROD-42`) — not by raw id — since that's what the URL carries and what every" +
        ' link in the app produces.\n\n' +
        '**Service (one aggregate read).** Add' +
        ' `workItemsService.getIssueDetail(identifier, ctx)` returning a single' +
        ' `IssueDetailDto` that bundles what the page needs in one round-trip: the work item,' +
        ' its parent (id + identifier + kind + title + status, for the breadcrumb), its direct children' +
        ' (same shape, for the child list), its links (blocked-by / blocks), and its workflow context' +
        " (the project's statuses + legal next-transitions for the current status). It composes existing" +
        ' repo reads behind ONE service method (CLAUDE.md: the page calls one service method, not five' +
        ' repos). Tenant gate FIRST: a cross-workspace or non-existent identifier collapses to a uniform' +
        ' 404 (no existence leak) — reuse `WorkItemNotFoundError`. `getWorkItemByIdentifier`' +
        ' is the underlying repo lookup (`@@unique([projectId, identifier])`); if 2.3.6 already' +
        ' added it, reuse it — do not add a second copy.\n\n' +
        '**Page shell.** The two-column layout every later subtask fills: a header row' +
        ' (type icon from 2.1.1 · `PROD-N` identifier · title · a status pill placeholder' +
        ' 2.4.4 upgrades to the inline control), a main column (description/explanation — 2.4.2, child' +
        ' list — 2.4.3), and a metadata sidebar (core fields — 2.4.2; relationships — 2.4.5). An "Edit"' +
        ' button links to `/issues/[key]/edit` (2.3.6). The layout reserves clearly-commented' +
        ' **Epic-5 extension slots** (comments · attachments · custom fields · activity) as' +
        ' empty regions, so those land as fills rather than a re-layout. Renders inside the Story-1.5' +
        ' authed shell; unauthenticated → sign-in redirect; non-member / cross-workspace → 404.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Route renders for an existing issue addressed by `PROD-N`; cross-workspace / unknown' +
        ' identifier → 404 (no title/existence leak); unauthenticated → sign-in redirect.\n' +
        '- `workItemsService.getIssueDetail` returns ONE `IssueDetailDto` (work item + parent +' +
        ' children + links + workflow context); the page makes exactly one service call. Explicit' +
        ' `workspaceId` gate (finding #26).\n' +
        '- `getWorkItemByIdentifier` is the single shared identifier lookup (reused from 2.3.6 if' +
        ' present, else added here — never duplicated).\n' +
        '- Header renders type icon + identifier + title + a (static, for now) status pill; an "Edit"' +
        ' button links to the 2.3.6 edit route; Epic-5 extension slots exist as documented empty regions.\n' +
        '- Vitest (real Postgres) over `getIssueDetail`: happy path shape, cross-workspace 404,' +
        ' parent/children/links populated correctly. The STRICT shell-a11y sweep is extended to the' +
        ' detail route (added here, asserted across later subtasks).\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/workItemsService.ts` + `lib/repositories/workItemRepository.ts` (1.4) —' +
        ' `getWorkItem`/`listChildren`/`findById`/`getWorkItemByIdentifier` + the workspaceId-filter' +
        ' convention\n' +
        '- `app/(authed)/issues/[key]/edit/` (2.3.6) — the sibling route shape +' +
        ' `getActiveProject()` resolution (finding #50)\n' +
        '- `lib/dto/workItems.ts` + `lib/mappers/workItemMappers.ts` — DTO + mapper conventions' +
        ' (no `@prisma/client` leak)\n' +
        "- Story 1.5 authed shell + 1.5.5 shell-a11y sweep — extend, don't duplicate\n" +
        '- `motir-core/CLAUDE.md` — 4-layer, one-service-call-per-page, entity-naming',
    },
    {
      id: '2.4.2',
      title: 'Description / explanation render + read-only core-fields panel',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 14,
      dependsOn: ['2.4.1'],
      descriptionMd:
        "The page's content body. The **description** renders through" +
        ' `MarkdownView` (2.3.5) — the same single render module the editor preview uses, so' +
        ' the read view and the edit-time preview can never diverge. The **explanation**' +
        ' (`explanationMd`, the "why this matters" axis from Story 1.4) renders read-only' +
        ' beneath it with an **"AI-drafted" badge** when `explanationSource ==' +
        " 'ai_draft'` (the provenance enum 1.4 shipped); editing/regenerating the explanation is an" +
        ' Epic-7 concern and is NOT a control here. Empty description shows a muted "No description"' +
        ' placeholder rather than blank space.\n\n' +
        '**Core-fields panel** (the metadata sidebar): every read-only field on' +
        ' `work_item` — type, priority, assignee (avatar/name or "Unassigned"), reporter, due' +
        ' date, estimate (minutes → human duration), created / updated (the same deterministic' +
        ' `en-US`/`UTC` formatter the jobs dashboard adopted after the 1.6.5' +
        ' hydration fix — issue timestamps are an audit surface, so render them deterministically). These' +
        ' are DISPLAY only; the two interactive fields (status, assignee) get their inline controls in' +
        ' 2.4.4. The "Edit" button (2.4.1) remains the path for every other field.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Description renders via `MarkdownView` (GFM + sanitized + highlighted + underlined links);' +
        ' empty → muted placeholder.\n' +
        '- Explanation renders read-only with an "AI-drafted" badge iff' +
        " `explanationSource == 'ai_draft'`; absent explanation hides the section entirely.\n" +
        '- Core-fields panel shows type / priority / assignee / reporter / due date / estimate /' +
        ' created / updated, each with a stable label; timestamps use the deterministic' +
        ' `en-US`/`UTC` formatter (no hydration mismatch).\n' +
        '- Component test (happy-dom) over the fields panel: each field renders its value or the' +
        ' documented empty state; an `ai_draft` explanation shows the badge, a `user_authored` one' +
        ' does not.\n' +
        '- STRICT shell-a11y sweep on the detail route stays green with content populated.\n\n' +
        '## Context refs\n\n' +
        '- `components/ui/MarkdownView.tsx` + `lib/markdown/render.tsx` (2.3.5) — the ONE render' +
        ' path\n' +
        '- `lib/issues/issueTypes.ts` (2.1.1) — type icon/label; the priority enum + labels from' +
        ' Story 1.4\n' +
        '- The 1.6.5 `formatDateTime` (`en-US`/`UTC`, "UTC" suffix) — reuse, don\'t re-derive\n' +
        '- `explanationSource` enum + `explanationMd` semantics (Story 1.4 · AI-storage boundary' +
        ' note)',
    },
    {
      id: '2.4.3',
      title: 'Parent breadcrumb + child list (tree navigation)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 12,
      dependsOn: ['2.4.1'],
      descriptionMd:
        'Navigation through the work-item tree (the AI-native execution DAG + Jira-style' +
        ' epic→story→task→bug→subtask hierarchy from 2.1.1). A **parent breadcrumb** walks' +
        ' the ancestor chain (each ancestor = type icon + `PROD-N` + title, linking to its own' +
        ' detail page) so a Subtask shows its Task → Story → Epic lineage. A **child list**' +
        " shows the item's direct children (type icon + identifier + title + status pill + assignee)," +
        ' each a link to its detail page; an item with no children shows nothing (no empty scaffold).\n\n' +
        '**Reads.** Children come from the `getIssueDetail` bundle (2.4.1).' +
        " The ancestor chain is bounded (Story 1.4's depth limit is 4) so it's a short parent-walk; if a" +
        ' dedicated read is cleaner than threading it through the aggregate, add' +
        ' `workItemRepository.findAncestors` (a single recursive-CTE read mirroring' +
        ' `findSubtree`) with the explicit `workspaceId` filter. Breadcrumb + child' +
        ' links are plain `<a>`/`next/link` to `/issues/[childKey]`' +
        " — clicking one navigates to that item's detail page (the recursion the tree implies).\n\n" +
        '## Acceptance criteria\n\n' +
        '- A nested item (e.g. a subtask under a task under a story under an epic) shows its full' +
        " ancestor breadcrumb, each segment linking to that ancestor's detail page; a top-level epic" +
        ' shows no breadcrumb.\n' +
        '- An item with children lists them (icon + identifier + title + status), each linking to its' +
        ' detail page; a leaf shows no child section.\n' +
        '- Ancestor read is workspace-scoped (cross-workspace ancestors never leak) and bounded by the' +
        ' depth limit; no N+1 (one bundled read or one CTE).\n' +
        '- Vitest (real Postgres): breadcrumb order is root→self; child list matches `listChildren`;' +
        ' cross-workspace isolation holds.\n' +
        '- Breadcrumb + child links are keyboard-navigable; shell-a11y sweep stays green.\n\n' +
        '## Context refs\n\n' +
        '- `lib/repositories/workItemRepository.ts` — `findChildren`, `findSubtree` (the' +
        ' recursive-CTE pattern to mirror for ancestors), the workspaceId-filter convention\n' +
        '- `lib/issues/issueTypes.ts` (2.1.1) — type icons for breadcrumb/child rows\n' +
        "- 2.4.1's `IssueDetailDto` — extend with the ancestor chain if not bundled already",
    },
    {
      id: '2.4.4',
      title: 'Inline controls: workflow-aware status + assignee',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 14,
      dependsOn: ['2.4.1', '2.3.6'],
      descriptionMd:
        'The two write affordances the scope names — and the ONLY ones on the detail page (everything' +
        " else is the Edit form). Both REUSE 2.3.6's components + gated actions; this Subtask wires them" +
        ' inline, it does not build new mutation primitives.\n\n' +
        '**Status control (workflow-aware).** The header status pill becomes a' +
        ' `StatusPicker` (2.3.6) that offers only the LEGAL next statuses for the current one —' +
        " the project's transitions in restricted mode, any status in open mode (2.2's" +
        ' `canTransition` / the workflow context already in the `getIssueDetail`' +
        " bundle). Selecting one calls 2.2.4's gated `updateStatus` via a detail-page Server" +
        " Action (`changeStatusAction` — reuse 2.3.6's if its signature fits, else a thin" +
        ' sibling); an illegal/stale transition surfaces the typed error inline; success toasts +' +
        ' `revalidatePath`s the detail route so the pill + the activity trail reconcile.\n\n' +
        '**Assignee control.** The sidebar assignee field becomes an' +
        ' `AssigneePicker` (2.3.6, a workspace-member combobox) that reassigns via the' +
        " now-status-free `updateWorkItem` (2.3.6's finding-#46 cleanup) through an" +
        ' `updateAssigneeAction` — assignee is a non-status patch field, so it rides the' +
        ' ordinary patch path (which still writes a revision). "Unassign" is supported (null assignee).' +
        ' Optimistic + toast + revalidate. Permission: any project member can change status/assignee in' +
        ' v1 (no per-field RBAC until Epic 6) — but the Server Actions still carry the explicit' +
        ' `workspaceId`/membership gate (finding #26).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Status control offers exactly the legal next statuses (restricted: transition rows; open:' +
        " all); choosing one persists via 2.2.4's `updateStatus`; an illegal/stale move surfaces" +
        ' the typed error inline and does not change the pill.\n' +
        '- Assignee control reassigns (and unassigns) via the status-free `updateWorkItem`; a' +
        ' revision row is written for the change.\n' +
        '- Both controls are Server-Action-gated (workspace + membership); a forged cross-workspace' +
        ' target 404s; no client-trusted ids.\n' +
        "- Both reuse 2.3.6's `StatusPicker`/`AssigneePicker` — no parallel components; the detail" +
        ' page and edit form share them.\n' +
        '- Vitest (real Postgres) over the two actions: legal status change, illegal rejection,' +
        ' reassign + unassign, cross-workspace 404. Component test: the status control lists only' +
        ' legal targets. shell-a11y stays green with the controls rendered.\n\n' +
        '## Context refs\n\n' +
        "- 2.3.6's `StatusPicker` / `AssigneePicker` + `changeStatusAction` / the status-free" +
        " `updateWorkItem` (finding #46) — reuse, don't rebuild\n" +
        '- `workItemsService.updateStatus` (2.2.4) + `workflowsService.canTransition` (2.2.3) —' +
        ' the gated paths\n' +
        "- 2.4.1's `IssueDetailDto` workflow context (statuses + legal transitions) — the picker's" +
        ' option source\n' +
        '- `motir-core/CLAUDE.md` — Server Action / 4-layer / workspaceId-gate rules',
    },
    {
      id: '2.4.5',
      title: 'Relationships panel + ready/blocked badge (first `isReady` caller)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 12,
      dependsOn: ['2.4.1', '2.4.7'],
      descriptionMd:
        "The dependency surface — and the **first production wiring of 2.2.6's" +
        " `isReady`** (finding #21's payoff; until now it has only a `_test`" +
        " caller). A relationships panel lists the item's links from the `work_item_link` table" +
        ' (1.4.3): **blocked by** (its blockers), **blocks**, and the other' +
        ' Jira-style kinds shipped (`relates_to` / `duplicates` / `clones`)' +
        ' grouped by kind, each linked item shown with icon + identifier + title + status pill. A' +
        ' prominent **ready / blocked badge** reflects `workflowsService.isReady`:' +
        ' "Blocked" when any blocker is non-terminal (each blocker judged against ITS OWN project\'s' +
        ' terminal set — 2.2.6), "Ready" when all blockers are terminal (done/cancelled). The badge names' +
        ' the open blocker(s) so the reason is legible.\n\n' +
        '**Scope discipline.** This panel READS links — creating/removing links is a' +
        ' later surface, planned as **2.4.8 (design) + 2.4.9 (code)** below (NOT Epic 5 —' +
        ' Jira puts "Link issue" on the detail view, so it\'s PM-core/Epic 2). So here the panel is' +
        ' read-only with a documented "manage dependencies" extension slot. The blocked/ready' +
        " badge is the same primitive Epic 3 boards + Epic 6 reports will reuse, so it's a small presentational" +
        ' component (`ReadinessBadge`) fed by the service verdict, not bespoke page markup.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Relationships panel groups links by kind (blocked-by / blocks / relates-to / duplicates /' +
        ' clones); each linked item shows icon + identifier + title + status and links to its detail' +
        ' page; no links → the panel shows a muted empty state, not blank.\n' +
        '- The readiness badge reads `isReady`: "Blocked" (naming the open blocker[s]) when a' +
        ' blocker is non-terminal, "Ready" when all are terminal — terminal judged per the blocker\'s' +
        ' own project (2.2.6 / finding #21).\n' +
        '- A blocker transitioning to a terminal status (done OR cancelled) flips the badge to Ready' +
        ' on the next render (revalidation); recategorizing a status live re-judges it.\n' +
        '- `ReadinessBadge` is a reusable presentational component (Epic 3/6 will reuse it), fed by' +
        ' the service verdict — no duplicate readiness logic in the page.\n' +
        '- Vitest (real Postgres): a blocked item reads "Blocked"; resolving the blocker reads' +
        ' "Ready"; cancelled-resolves; cross-workspace links never leak. shell-a11y stays green (the' +
        " badge's state is conveyed by text, not color alone).\n\n" +
        '## Context refs\n\n' +
        '- `workflowsService.isReady` + `findBlockerStates` (2.2.6) — the verdict + per-project' +
        ' terminal logic; this is its first production caller\n' +
        '- `lib/repositories/workItemLinkRepository.ts` (1.4.3) — link reads by kind + the' +
        ' workspaceId filter\n' +
        '- 1.5.5 Pill-tone AA rules (finding #35) — the badge must convey state by text, AA-safe tint\n' +
        "- 2.4.1's `IssueDetailDto` links — extend if the grouped-by-kind shape isn't already bundled",
    },
    {
      id: '2.4.6',
      title: 'Story E2E — detail page lifecycle (Playwright) + closes Story 2.4',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: ['2.4.1', '2.4.2', '2.4.3', '2.4.4', '2.4.5', '2.4.9', '2.4.10'],
      descriptionMd:
        'The Story-closing Playwright suite at `tests/e2e/issue-detail-flow.spec.ts`,' +
        ' driving the real shell. Setup uses the 2.2.7 `_test` harness +' +
        ' `shell-session` helpers (create project, create items, link, transition) so it has' +
        ' no ordering dependency on the create-modal/edit-form specs. Mirrors the 1.6.6 lesson —' +
        " real-stack E2E catches UI↔service seam bugs the unit tests structurally can't.\n\n" +
        'This is the Story CLOSER, so it covers EVERY Story-2.4 surface end to end — the read +' +
        ' inline-edit surfaces (2.4.1–2.4.5) AND the link-management surface (2.4.9): adding/removing a' +
        ' link through the relationships panel is a real UI↔service seam (Server Action →' +
        ' `linkWorkItems`/`unlinkWorkItems` → trigger → revalidate → the panel +' +
        " readiness banner re-render) exactly the kind of path unit tests can't exercise, so it earns" +
        " a driven scenario rather than living only in 2.4.9's component/service tests.\n\n" +
        '**Scenarios (single specs):**\n\n' +
        '- **Renders the canonical page:** navigate to `/issues/PROD-N`; assert header (icon +' +
        ' identifier + title + status), the Markdown description (bold/link/code rendered), the' +
        ' core-fields panel, and the "Edit" link → `/issues/PROD-N/edit`.\n' +
        '- **Tree navigation:** for a subtask under a task under a story, the breadcrumb shows the' +
        " lineage and a breadcrumb link navigates to the ancestor's detail page; a parent's child" +
        ' list links down to a child.\n' +
        '- **Inline status (workflow-aware):** change status to a legal next status → pill updates +' +
        " persists across reload; an illegal target isn't offered (restricted) or is rejected (open" +
        ' boundary) — no silent change.\n' +
        '- **Inline assignee:** assign to a workspace member, then unassign; both persist across' +
        ' reload.\n' +
        '- **Readiness:** an item blocked by a non-terminal item reads "Blocked"; transition the' +
        ' blocker to done → the badge reads "Ready".\n' +
        '- **Link management — add (2.4.9):** from the relationships panel, add a `blocked_by` link' +
        ' to another issue via the combobox → the row appears under "Blocked by" and the readiness' +
        ' banner flips Ready→Blocked (driven through the UI, then asserted to persist across reload).\n' +
        '- **Link management — remove (2.4.9):** remove that link inline (with confirm) → the row' +
        ' disappears and the banner flips back to Ready; removing a `relates_to` link drops both' +
        ' reciprocal rows.\n' +
        '- **Link management — guardrails (2.4.9):** a self-link / duplicate / cycle attempt surfaces' +
        ' an INLINE error in the add form and persists nothing (the typed trigger errors round-tripped' +
        ' to the UI).\n' +
        '- **Create with a link (2.4.10):** open the create modal, add a pending link via the' +
        ' "Linked issues" combobox, create the issue → the link exists on the new issue\'s detail' +
        ' relationships panel (written atomically with the issue); removing the pending row before' +
        ' create writes nothing.\n' +
        '- **Cross-workspace isolation:** a user in workspace-A visiting a workspace-B identifier →' +
        ' 404 (no leak); the link combobox surfaces only own-workspace candidates.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e --grep issue-detail-flow` passes locally + in CI against a fresh-DB run;' +
        ' no flake under 10 consecutive CI runs.\n' +
        '- All scenarios present as specs with the documented assertions; status/assignee AND link' +
        ' add/remove changes are verified to PERSIST across reload (not just optimistic), each driven' +
        ' through the real UI (combobox, inline controls) — not by calling the service directly.\n' +
        '- The link-management scenarios drive the 2.4.9 add control + per-row remove; the guardrail' +
        ' spec asserts the inline error (self-link/duplicate/cycle) leaves the DB unchanged.\n' +
        '- Uses only the auth + 2.2.7 `_test` harness helpers for setup (extends them if needed — no' +
        ' parallel helper); selectors target stable `data-testid`/role hooks added in 2.4.1–2.4.5 +' +
        ' 2.4.9, not brittle text.\n' +
        '- The `/issues/[key]` route stays in the STRICT shell-a11y sweep (added in 2.4.1), confirmed' +
        ' populated INCLUDING the open add-link combobox/dialog (reuses the 2.3.4 Combobox a11y).\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/_helpers/workflow.ts` (2.2.7 — createItem/transition/linkBlockedBy) +' +
        ' `shell-session.ts` (1.5.6)\n' +
        '- `tests/e2e/workflow-delete-reassign.spec.ts` (2.3.2) +' +
        ' `issue-create-edit-flow.spec.ts` (2.3.8) — sibling conventions to mirror\n' +
        "- The detail-page `data-testid` hooks from 2.4.1–2.4.5 **+ 2.4.9's add-link control /" +
        ' per-row remove hooks**; `playwright.config.ts` webServer block\n' +
        "- 2.4.9's `RelationshipsPanel` add control + `createLinkAction`/`removeLinkAction` + the" +
        ' typed link errors (`lib/workItems/linkErrors.ts`) the guardrail spec asserts',
    },
    {
      id: '2.4.7',
      title:
        'Design — relationships panel + ready/blocked badge + edit-page related issues (HTML mockup)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 20,
      descriptionMd:
        'The missing design asset that the design-gate requires before 2.4.5 can be built.' +
        ' `detail.pen` specifies the issue-detail page (Description / Explanation / Activity +' +
        ' the core-fields rail) but **does NOT specify any relationships / dependency / linked-issues' +
        ' surface or a readiness signal** — so that element is unspecified == no design == this' +
        " subtask. Produces an **HTML mockup** (per MOTIR.md's accepted design-asset" +
        " formats) built from the real design system — the shipped `components/ui/*` primitives'" +
        ' markup + the `globals.css` `--el-*` tokens — so there is no Pencil→code' +
        ' translation gap and 2.4.5 composes the same primitives.\n\n' +
        '**Surfaces designed:** (a) the issue-detail *Relationships* section card' +
        ' (left column, after Explanation, before Activity) grouping links by kind (blocked-by / blocks /' +
        ' relates-to / duplicates / clones) with a prominent *ready/blocked* banner that names the' +
        ' open blockers; states for blocked / ready / no-links; and (b) the read-only related-issues block' +
        ' on the **2.3.6 edit page** (user directive — the edit page needs related issues' +
        ' too). Output: `design/work-items/relationships.mock.html` +' +
        ' `design/work-items/design-notes.md` (mirrors the 1.0.5 / 1.2.1 / 1.3.3 / 1.5.1 design' +
        ' output convention).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/work-items/relationships.mock.html` exists, is self-contained, and renders the' +
        ' detail-page Relationships card (blocked / ready / no-links) + the edit-page related-issues' +
        ' block + an in-context placement panel, using the real `--el-*` tokens (light + dark parity).\n' +
        '- Composes the shipped primitives (Card, Pill tones, SectionLabel, IssueTypeIcon hue) — no' +
        ' invented containers/typography; readiness state conveyed by TEXT, not colour alone (finding' +
        ' #35 AA).\n' +
        '- `design/work-items/design-notes.md` names the primitives, copy, placement, states, and' +
        ' out-of-scope extension slots (link create/remove = Epic 5).\n' +
        '- **Opened as a PR and APPROVED by the user before 2.4.5 starts** (review-gated — this is' +
        ' a design subtask, not auto-mergeable on CI).\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/detail.pen` — the existing detail design to sit inside (read the' +
        ' SOURCE, all frames)\n' +
        '- `app/globals.css` (Tier-0 `--color-*` + Tier-3 `--el-*`) +' +
        ' `components/ui/{Card,Pill,SectionLabel}` + `components/issues/IssueTypeIcon` +' +
        ' `lib/issues/issueTypes`\n' +
        '- The shipped `ChildList` row grammar (2.4.3) + `ContentSectionCard` header (2.4.2) to' +
        ' mirror\n' +
        '- The mirror product (Jira "Linked issues" + dependency display) for anything the above' +
        ' leaves open',
    },
    {
      id: '2.4.8',
      title: 'Design — link-management interaction (add / remove relationship links)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: ['2.4.7'],
      descriptionMd:
        "The add/remove-link interaction that 2.4.5's read-only relationships panel deferred. The" +
        ' **backend already exists** — `workItemsService.linkWorkItems` /' +
        ' `unlinkWorkItems` (1.4.4) with the typed trigger errors (self-link / duplicate /' +
        " cycle / cross-workspace). What's missing is the UI, and it's UI ⇒ it needs a design before any" +
        ' code (the design-gate). This is the design asset; **2.4.9** builds against it.\n\n' +
        '**Mirror product (rung 1):** Jira\'s "Link issue" affordance lives on the issue' +
        ' detail view, so this is PM-core (Epic 2 / Story 2.4), NOT Epic 5. Design, extending the approved' +
        " `design/work-items/relationships.mock.html`: **(a)** the panel's add" +
        ' entry point (a "+ Link issue" control in the Relationships header, replacing the read-only' +
        ' "Manage in Epic 5" note); **(b)** the add-link form — a **kind selector**' +
        ' (blocked by / blocks / relates to / duplicates / clones) + an **issue-search Combobox**' +
        ' (reusing the 2.3.4 `Combobox`) over an in-workspace candidate read, with the' +
        ' empty / typing / selected states; **(c)** the inline **remove**' +
        ' affordance on each row (+ a confirm); **(d)** the inline **error states**' +
        ' the triggers surface (self-link, duplicate, cycle, cross-workspace); **(e)** the' +
        ' **create-modal "Linked issues" section** (designed in `create.pen`, never' +
        ' built) — the same controls, but links are COLLECTED as pending rows and written on create (built' +
        ' by 2.4.10). Output:' +
        ' `design/work-items/links.mock.html` + an update to' +
        ' `design/work-items/design-notes.md`, mirroring the 2.4.7 output convention' +
        ' (self-contained HTML built from the real `--el-*` tokens + shipped primitives).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/work-items/links.mock.html` exists, self-contained, real `--el-*` tokens (light +' +
        ' dark), and renders: the add entry point on the relationships panel; the add-link form (kind' +
        ' selector + issue-search Combobox: empty / typing / selected); the per-row remove affordance +' +
        ' confirm; and the inline error states (self-link / duplicate / cycle / cross-workspace).\n' +
        '- Composes shipped primitives only (2.3.4 `Combobox`, `Pill`, `Modal`/`Popover`,' +
        ' `Button`, `SectionLabel`, `IssueTypeIcon`) — no hand-rolled controls; states conveyed by' +
        ' text + AA-safe tints (finding #35).\n' +
        '- `design-notes.md` names the primitives, copy, placement, states, and the' +
        ' read-only→editable transition of the panel.\n' +
        '- **Opened as a PR and APPROVED by the user before 2.4.9 starts** (review-gated design' +
        ' subtask).\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/relationships.mock.html` + `design-notes.md` (2.4.7 base to extend) +' +
        ' `detail.pen`\n' +
        '- `components/ui/Combobox` (2.3.4, WAI-ARIA listbox-combobox) +' +
        ' `Modal`/`Popover`/`Button`/`Pill`\n' +
        '- `lib/dto/workItemLinks.ts` — the five link kinds + direction convention\n' +
        '- `lib/workItems/linkErrors.ts` — the error states the form must surface (self-link /' +
        ' duplicate / cycle / cross-workspace)\n' +
        '- The mirror product — Jira\'s "Link issue" dialog (kind dropdown + issue picker)',
    },
    {
      id: '2.4.9',
      title: 'Link management UI — add / remove relationship links',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['2.4.5', '2.4.8'],
      descriptionMd:
        'Make the 2.4.5 relationships panel INTERACTIVE — wire the shipped' +
        ' `linkWorkItems` / `unlinkWorkItems` (1.4.4) into it per the' +
        ' **2.4.8** design. Thin Server Actions (`createLinkAction` /' +
        ' `removeLinkAction`) over the gated service methods (no raw Prisma — 4-layer rule);' +
        ' a client add-link control opened from the panel header (kind selector + issue-search Combobox);' +
        ' an inline remove on each row; `revalidatePath` on the detail route so the groups AND' +
        ' the readiness banner update (adding a non-terminal blocker flips Ready→Blocked; removing it flips' +
        ' back). The typed link errors map to inline messages (no crash). The 2.4.5 "Manage in Epic 5"' +
        ' read-only note is REPLACED by the real control.\n\n' +
        '**Candidate read.** The issue-search Combobox needs an in-workspace candidate' +
        ' lookup (by identifier / title, excluding self + already-linked). Add a lightweight' +
        ' `workItemsService.listLinkCandidates` (workspace-scoped, explicit' +
        " `workspaceId` filter — finding #26; cross-project allowed, matching the link model's" +
        ' same-workspace rule); full cross-cutting search is Epic 6, so this is a simple prefix/contains' +
        ' read, not the search engine. **Scope:** management lives on the DETAIL panel; the' +
        " edit page's related-issues block stays READ-ONLY (an editor keeps context there — 2.4.5).\n\n" +
        '## Acceptance criteria\n\n' +
        '- From the relationships panel, add a link of each of the five kinds to another in-workspace' +
        ' issue via the Combobox search; the new link appears in its group on revalidation, and the' +
        ' readiness banner re-judges (a new non-terminal `is_blocked_by` target flips Ready→Blocked).\n' +
        '- Remove a link inline (with confirm) → it disappears from its group + the banner re-judges;' +
        ' `relates_to` removes both reciprocal rows (service already does this).\n' +
        '- Self-link / duplicate / cycle / cross-workspace are rejected with an INLINE message (the' +
        ' typed errors → 422/409), nothing persisted, no crash; the add control is permission-gated' +
        ' (workspace member; the gated service + the trigger backstop).\n' +
        '- Server Actions call ONE gated service method each (no raw Prisma); `listLinkCandidates`' +
        ' carries an explicit `workspaceId` filter.\n' +
        '- Vitest (real Postgres) for the actions + `listLinkCandidates` (incl. excludes-self /' +
        ' excludes-already-linked / cross-workspace empty); a component test for the add control (kind' +
        ' + combobox + submit + error surfacing); the detail + edit routes stay green on the' +
        ' shell-a11y sweep (the add dialog/combobox is accessible — reuse the 2.3.4 Combobox' +
        ' semantics).\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/links.mock.html` + `design-notes.md` (2.4.8 — REQUIRED, match its' +
        ' layout/primitives)\n' +
        '- `lib/services/workItemsService.ts` — `linkWorkItems` / `unlinkWorkItems` +' +
        ' `listCandidateParents` (the candidate-read pattern to mirror for `listLinkCandidates`)\n' +
        '- `lib/workItems/linkErrors.ts` + `lib/dto/workItemLinks.ts` (kinds +' +
        ' `LinkWorkItemsInput`)\n' +
        '- `app/(authed)/issues/[key]/_components/RelationshipsPanel.tsx` (2.4.5 — make it' +
        ' interactive) + `components/ui/Combobox` (2.3.4)\n' +
        '- 2.3.3 / 2.3.6 Server-Action + `revalidatePath` conventions',
    },
    {
      id: '2.4.10',
      title: 'Link management in the create modal (Linked issues at create time)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 14,
      dependsOn: ['2.4.8', '2.4.9'],
      descriptionMd:
        '**Closes a real design-vs-built gap:** `create.pen` designs a' +
        ' "Linked issues" section in the CREATE modal (a relationship-kind chip + a linked row + "Add' +
        ' link" + "Choose a relationship") but it was **never built** — 2.3.3/2.3.4' +
        " shipped the modal without it. This adds it, designed in 2.4.8's `links.mock.html`" +
        " (panel 5) and reusing 2.4.9's AddLink control (kind selector + issue-search Combobox +" +
        ' remove) — NO parallel control.\n\n' +
        "**The one real difference from 2.4.9 (why it's its own subtask):** at create" +
        " the issue has no id yet, so chosen links can't be written immediately. They are" +
        " **collected in the modal's form state** (rendered as pending rows with a" +
        ' relationship-kind chip) and **written WHEN the issue is created** — inside' +
        " `createWorkItem`'s existing `$transaction`, right after the item" +
        ' insert, atomically with it (issue + links commit or roll back together). Extend' +
        ' `CreateWorkItemInput` with a `links: {toId, kind}[]`;' +
        ' `createWorkItem` writes the `work_item_link` rows via the same repo +' +
        ' trigger backstop (reciprocal `relates_to` handled as in 1.4.4);' +
        ' `createIssueAction` threads the collected links. Cycle is validated on create' +
        ' (the new id exists by then); self-link is impossible (no id to self-link); duplicate is' +
        ' prevented in the pending list. Edit-page + detail-panel adds stay 2.4.9 (immediate write).\n\n' +
        '## Acceptance criteria\n\n' +
        '- From the create modal, add one+ links of various kinds via the combobox → they show as' +
        ' PENDING rows (kind chip + icon · id · title + remove); removing a pending row before Create' +
        ' drops it (nothing written).\n' +
        '- Creating the issue writes the links ATOMICALLY with it (one transaction — issue + links' +
        " succeed or fail together); the links then appear on the new issue's detail relationships" +
        ' panel + re-judge its readiness.\n' +
        "- Reuses 2.4.9's AddLink control + the gated service (no raw Prisma, no parallel control);" +
        ' a cycle / cross-workspace target is rejected on create with an inline error, and the issue' +
        ' is NOT created (or is created without the bad link — decide: reject the whole submit,' +
        ' surfaced inline).\n' +
        '- Vitest (real PG): `createWorkItem` with links writes them in the same tx + rolls back on' +
        " a bad link; a component test for the modal's pending-link collect/remove; shell-a11y stays" +
        ' green (the modal combobox reuses 2.3.4 a11y).\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/links.mock.html` panel 5 + `design-notes.md` "Create modal — Linked' +
        ' issues" (2.4.8 — REQUIRED)\n' +
        "- 2.4.9's AddLink control + `createLinkAction` (reuse, don't fork)\n" +
        '- `components/issues/CreateIssueModal.tsx` + `app/(authed)/issues/actions.ts`' +
        ' (`createIssueAction`, 2.3.3)\n' +
        '- `workItemsService.createWorkItem` + `linkWorkItems` + `lib/dto/workItems.ts`' +
        ' (`CreateWorkItemInput`) + `lib/dto/workItemLinks.ts`\n' +
        '- The mirror product — Jira\'s create dialog "Linked issues" row',
    },
    {
      id: '2.4.11',
      title: 'Design — the `DatePicker` calendar component',
      status: 'done',
      type: 'design',
      executor: 'human',
      estimateMinutes: 45,
      descriptionMd:
        'The design for a **design-system calendar date-picker**. The issue Due-date fields' +
        ' (create modal 2.3.3 / edit form 2.3.6 / detail core-fields rail 2.4.2) currently fall back to the' +
        ' native `<input type="date">` — its FIELD now uses the `Input` primitive,' +
        " but the native browser CALENDAR POPUP is OS chrome and doesn't match the design system. This designs" +
        " the replacement so 2.4.12 isn't improvising UI (the design gate — there is no calendar in the system" +
        ' today). Produce, under `design/work-items/`, a `datepicker.mock.html` (built' +
        ' from the live design system — `components/ui/*` + `--el-*` tokens, so the coding' +
        ' agent composes the same primitives) + a `design-notes.md` section, covering:\n\n' +
        '- The **trigger** — an `Input`-styled field showing the selected date' +
        ' (formatted like `formatDate` → "Jun 4, 2026") or a placeholder, with a calendar glyph,' +
        ' and a **Clear** affordance (Due date is nullable).\n' +
        '- The **calendar popover** (anchored via the `Popover` primitive): the' +
        ' month/year caption + prev/next-month nav, the weekday header row, and the day grid — with the' +
        ' **selected day**, **today**, hover, focused, and disabled day states all' +
        ' specified through `--el-*` tokens (AA-safe, finding #35; selection not conveyed by colour' +
        ' alone).\n' +
        '- The **placeholder / cleared** state.\n' +
        '- A documented **keyboard model** for 2.4.12: arrows move days, PageUp/Down change' +
        ' months, Home/End jump to week start/end, Enter selects, Esc closes.\n\n' +
        "Mirror the prior design subtasks' output convention (**1.0.5 / 2.4.7 / 2.4.8 / 2.5.7**)." +
        ' Colour only through `--el-*`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A `design/work-items/datepicker.mock.html` + a `design-notes.md` entry' +
        ' exist, naming the composing primitives (`Popover` + `Input`-styled trigger),' +
        ' copy, and every day-cell state (selected / today / hover / focus / disabled).\n' +
        '- Trigger, open calendar, and placeholder/cleared states are all drawn (multi-panel); colour flows' +
        ' only through `--el-*`; AA-safe.\n' +
        '- The keyboard interaction model is documented for the code subtask to implement.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/relationships.mock.html` (2.4.7) — the in-repo HTML-mockup convention' +
        ' to mirror\n' +
        '- `components/ui/Popover.tsx` + `Input.tsx` + `Combobox.tsx` — the anchored-popover +' +
        ' field chrome to compose\n' +
        '- `app/globals.css` `--el-*` tiers + the `/tokens` route convention',
    },
    {
      id: '2.4.12',
      title: '`components/ui/DatePicker` primitive + wire into the issue date fields',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: ['2.4.11'],
      descriptionMd:
        'Build a presentational, accessible `DatePicker` in `components/ui/` per' +
        ' 2.4.11, and replace the native `<input type="date">` (currently `Input`-' +
        'wrapped) in ALL THREE issue date surfaces — the create modal (2.3.3), the edit form (2.3.6), and the' +
        ' detail core-fields rail (2.4.2). A shared primitive, no per-surface re-implementation (the same way' +
        ' `Combobox` / `TreeTable` are shared).\n\n' +
        '**Shape.** An `Input`-styled trigger (selected date or placeholder + a' +
        ' Clear control) opening a `Popover` month grid. Value crosses as an ISO date string' +
        ' (`YYYY-MM-DD`) — exactly what the forms already hold — so the swap is drop-in:' +
        ' `value` + `onChange(next: string | null)` + `disabled`. Pure' +
        ' presentation: no queries, no Server-Action imports; the forms keep their existing commit paths (the' +
        " edit form's submit, the detail rail's commit-on-close). Date math is UTC-safe (no off-by-one from" +
        ' local-tz parsing — the bug the ISO-string shape already guards).\n\n' +
        '**A11y (load-bearing).** The WAI-ARIA dialog + grid date-picker pattern (hand-rolled' +
        ' like `Combobox` / `TreeTable`): a labelled trigger button with' +
        ' `aria-haspopup`; a labelled dialog containing a `grid` of day buttons with' +
        ' roving focus + the 2.4.11 keyboard model; the selected day carries' +
        ' `aria-current="date"`. Themed via `--el-*` only.\n\n' +
        '**Scope guard.** Single-date selection only. Date RANGES, relative presets ("in 3' +
        ' days"), and time-of-day stay out of scope — no use case yet (no complexity for nothing).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `components/ui/DatePicker` matches `datepicker.mock.html` (2.4.11):' +
        ' Input-styled trigger + Popover month grid, prev/next-month nav, selected/today states, a Clear' +
        ' control; value in/out is an ISO `YYYY-MM-DD` string (or null).\n' +
        '- Replaces the native date input in the create modal, edit form, AND detail core-fields rail —' +
        " one shared primitive; the forms' existing commit / validation paths are unchanged.\n" +
        '- Full date-picker a11y: labelled trigger + dialog, a day `grid` with roving focus,' +
        ' arrows / PageUp-Down / Home-End / Enter / Esc keyboard; the selected day exposes' +
        ' `aria-current="date"`; a `/tokens/date-picker` specimen joins the STRICT' +
        ' shell-a11y sweep (axe-clean).\n' +
        '- Colours via `--el-*` only; UTC-safe date math (no local-tz off-by-one).\n' +
        '- Component test (happy-dom): open → navigate months → select a day → clear; keyboard day-move +' +
        ' select; the specimen in the strict a11y sweep.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/datepicker.mock.html` + `design-notes.md` (2.4.11) — the layout' +
        ' authority\n' +
        '- `components/ui/Popover.tsx` (anchored popover) + `Input.tsx` (trigger chrome) +' +
        ' `Combobox.tsx` / `TreeTable.tsx` (hand-rolled WAI-ARIA + roving-focus references)\n' +
        '- The native date inputs to replace — `CreateIssueModal` (2.3.3), `EditIssueForm` (2.3.6),' +
        ' `CoreFieldsPanel` (2.4.2): all hold an ISO `YYYY-MM-DD` string today;' +
        ' `lib/utils/datetime.ts` `formatDate`\n' +
        '- `tests/e2e/shell-a11y.spec.ts` + the `/tokens` route convention;' +
        ' `motir-core/CLAUDE.md` — `--el-*` tokens',
    },
  ],
};
