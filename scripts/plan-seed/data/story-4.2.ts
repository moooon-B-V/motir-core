import type { PlanStory } from '../types';

/**
 * Story 4.2 — Backlog UI (groom + rank + assign to sprint).
 *
 * The Jira-style **Backlog / sprint-planning** screen: a project's ranked
 * backlog (the issues with `sprint_id IS NULL`, in `backlog_rank` order) under a
 * stack of **sprint-planning containers**, where a team grooms — drag-to-reorder
 * (rank), drag issues into a sprint (assign), multi-select bulk-move, inline
 * create, and start a sprint — all bound to the bounded, cursor-paginated data
 * API Story 4.1 already shipped. A NEW nav destination (`/backlog`) and a NEW
 * design area (`design/backlog/`).
 *
 * 📦 **Almost pure frontend.** The whole data substrate — the `Sprint` entity +
 * CRUD (4.1.3), the issue↔sprint association + `backlog_rank` writes + the
 * BOUNDED `getBacklog`/`getSprintIssues` reads (4.1.4) — is shipped by Story 4.1
 * and this Story BINDS to it (4.1's own prose: "the bounded backlog + sprint-issue
 * READ queries the 4.2 UI binds to"). The ONLY net-new backend is a thin
 * composition subtask (4.2.2): atomic **bulk** sprint-assignment + create-into-
 * sprint, composing 4.1.4's single-issue primitives so the multi-select affordance
 * is one transaction, not N client round-trips. **NO external SaaS / secret** — it
 * is React + a service over the same Postgres — so there is NO `type: manual/human`
 * provisioning subtask (mistake #30 checked and clears).
 *
 * ⚠️ Design gate (planning-time, no exceptions). The Backlog is a brand-new
 * surface: `design/` has no `backlog/` area and no mockup depicts a ranked
 * backlog, a sprint-planning container, a drag-into-sprint state, or the
 * multi-select bulk bar — i.e. the WHOLE surface is unspecified, which under the
 * gate means NO design exists. So subtask **4.2.1 is a `type: design` subtask**
 * that CREATES `design/backlog/` (mirrors 1.0.5 / 1.2.1 / 1.3.3 / 1.5.1 and the
 * 4.5.1 scrum extension), and EVERY UI-touching code subtask (4.2.3 / 4.2.4 /
 * 4.2.5) carries 4.2.1 in `dependsOn` and names the asset in Context-refs. A UI
 * code subtask never reaches the ready set before its design asset exists
 * (Principle #13: design before code, within every Story).
 *
 * ── Mistake #32 audit + the points/velocity SEAM (the load-bearing scope
 * decision) ─────────────────────────────────────────────────────────────────────
 * The stub lists "inline estimate" and "Sprint planning view showing committed
 * points vs. team velocity". Both need data this Story does NOT own: **story
 * points** are Story **4.3** (estimation) and **velocity** (completed-sprint
 * history) is Story **4.6** — BOTH NUMBERED AFTER 4.2. Wiring 4.2 to read them
 * would be a **forward-pointing dependency** (4.2 → 4.3 / 4.6), exactly the
 * mistake-#32 smell that lies about the build order. Applying the rule's
 * "count the crossing stories" meta-test: only the POINTS/VELOCITY concern
 * crosses — the rank + drag + sprint-container + multi-select + bounded/virtualized
 * machinery (the BULK of 4.2) is self-contained on Story 4.1, and in the mirror
 * product (Jira) estimation is OPTIONAL and layers ONTO an already-usable backlog
 * (you can rank + sprint-plan without ever estimating). So this is a fix-(b)-shaped
 * resolution: the crossing concern moves to the later story that already owns it,
 * NOT a swap. Concretely:
 *   • 4.2 ships the backlog substrate and renders, on each issue row + in each
 *     sprint container header, a **documented points SEAM** (an empty estimate
 *     slot + an empty committed-points slot) — the SAME seam pattern Story 4.5
 *     used for the burndown chart it left to 4.6.
 *   • Story **4.3** (estimation) fills the seam — the inline-editable estimate
 *     badge on the backlog row + the per-sprint committed-points roll-up (4.3's
 *     stub already scopes "roll-ups to sprint + epic level"). 4.3 > 4.2, so 4.3
 *     depending on 4.2's seam is a normal BACKWARD dep.
 *   • Story **4.6** (velocity) adds the "committed vs velocity" comparison line to
 *     the sprint container. Also backward (4.6 > 4.2).
 * Net: every `dependsOn` below points only at Story 4.1 (sprint data, 4.1 < 4.2)
 * or a 4.2 sibling — the cross-epic/intra-epic forward audit PASSES, and "inline
 * estimate / committed points vs velocity" still ships, just owned by the story
 * that owns the data. The Backlog AS A WHOLE is complete (no scope cut); the work
 * is partitioned along the real dependency lines.
 *
 * Expanded from its `stubs.ts` entry per `prodect plan 4.2`. Matches the canonical
 * depth + string-literal style of Stories 4.1 / 4.5 / 3.2.
 */
export const story_4_2: PlanStory = {
  id: '4.2',
  title: 'Backlog UI (groom + rank + assign to sprint)',
  status: 'planned',
  descriptionMd:
    "The **Backlog / sprint-planning** screen — Prodect's clone of the Jira backlog. A new nav " +
    "destination (`/backlog`, project-scoped) showing the project's **ranked backlog** (issues with " +
    '`sprint_id IS NULL`, in `backlog_rank` order) beneath a stack of **sprint-planning containers**, ' +
    'where a team grooms and plans: drag-to-reorder (rank), drag an issue into a sprint (assign), ' +
    'multi-select + bulk-move, inline create, and the start-sprint entry point. It is the READ/WRITE ' +
    'face of the data model Story 4.1 shipped — 4.2 owns no entity and no rules, it BINDS the bounded ' +
    'API to a real grooming UI.\n\n' +
    '**What 4.2 owns vs. what Story 4.1 already shipped (the clean seam).** Story **4.1** owns the ' +
    'persistence + rules: the `Sprint` entity + CRUD (4.1.3), the issue↔sprint association + ' +
    '`backlog_rank` single-row writes, and the **bounded, cursor-paginated** `getBacklog(projectId, ' +
    '{ cursor, limit })` + `getSprintIssues(sprintId)` reads + `listByProject` (4.1.4). 4.2 owns the ' +
    'UI that binds to them + ONE thin backend composition (4.2.2: atomic **bulk** assign + ' +
    "create-into-sprint over 4.1.4's primitives). 4.2 does NOT re-implement ranking, association, the " +
    'sprint state machine, or the bounded reads — it consumes them.\n\n' +
    '**Mistake-#32 resolution — the points/velocity SEAM (see the module header).** Story points are ' +
    'Story **4.3** and velocity is Story **4.6**, both numbered AFTER 4.2, so 4.2 reading them would be ' +
    'a forward-pointing dependency (a planning bug). It is NOT cut — it is re-owned: 4.2 renders a ' +
    '**documented points seam** (an estimate slot on each row, a committed-points slot in each sprint ' +
    'header) that **Story 4.3** fills (inline estimate + per-sprint roll-up — 4.3 already scopes ' +
    '"roll-ups to sprint + epic level") and a **velocity seam** that **Story 4.6** fills ("committed ' +
    'vs velocity"). This is the exact seam pattern Story 4.5 used to leave the burndown chart to 4.6. ' +
    'Every `dependsOn` here points backward (Story 4.1) or sideways (a 4.2 sibling) — the forward audit ' +
    'passes.\n\n' +
    '**The two stacked regions (the Jira backlog layout, mirror rung 1).** Top: zero-or-more ' +
    '**sprint-planning containers**, each a collapsible panel with the sprint name + state chip, the ' +
    'date range, an **issue count**, the committed-points SLOT (→ 4.3), a **Start-sprint** entry point ' +
    '(the start FLOW is Story 4.4 — 4.2 mounts/seams it, exactly as 4.5 seams Complete-sprint), its ' +
    'ranked issue rows, and an inline **+ Create issue** row; plus a **Create sprint** affordance to add ' +
    'an empty planned sprint (4.1.3 `createSprint`). Bottom: the **Backlog** container — the ranked ' +
    'list of unassigned issues with its own count header ("N issues") and inline create. Both regions ' +
    'hold the SAME issue-row component.\n\n' +
    '**The issue row.** A backlog row composes the work-items row vocabulary (Story 2.x list): a drag ' +
    'handle, the issue-type icon (its `--el-type-*` hue), the key (`PROD-42`), the summary, an epic ' +
    'chip, the **estimate SLOT** (→ 4.3), the assignee avatar, the status `Pill`, a selection ' +
    'affordance, and a `⋯` context menu (move to sprint ▸, move to top/bottom of backlog, …). Rows are ' +
    'reused identically in the backlog and inside sprint containers (one global rank field, so a row ' +
    'drags between regions).\n\n' +
    '**Drag (reuse the Story-3.2 dnd-kit contract, NOT a new one).** Reorder within a region (writes ' +
    '`backlog_rank` via 4.1.4 `rankIssue` — a single-row `keyBetween` write, never an N-row renumber), ' +
    'drag a row from the backlog into a sprint (assign), and drag between sprints / back to the ' +
    'backlog. Built on the SAME `@dnd-kit/core` + `@dnd-kit/sortable` + `boardMove.ts` move contract ' +
    'the board (3.2) already ships, and on the SAME `useRowWindow` virtualization (3.2.5) so a drag out ' +
    'of a windowed list keeps its node. Writes are **optimistic with snap-back on error** (the 3.2 ' +
    'board contract). A drag that crosses projects is impossible here (the backlog is single-project), ' +
    'but the 4.1.4 same-project guard still backstops the assign write.\n\n' +
    '**Multi-select + bulk (real grooming, atomic at scale).** Click / shift-range / ⌘-toggle to ' +
    'select N rows; a selection bar offers bulk **Move to sprint ▸** and **Move to backlog**, executed ' +
    'as ONE transaction via 4.2.2 (a bounded-batch `bulkAssignToSprint` / `bulkMoveToBacklog`), not N ' +
    'sequential single-issue calls (Jira moves multi-selections atomically; N round-trips would be slow ' +
    'and leave partial state on failure). Inline **+ Create issue** creates straight into the backlog or ' +
    'a target sprint (4.2.2 `createBacklogIssue` — create + rank-append + optional assign in one tx).\n\n' +
    '**Completeness / scale (finding #57 — the load-bearing non-functional axis).** A real backlog is ' +
    'thousands of issues, so the list is **lazy-loaded + virtualized**, NEVER load-all: it binds to ' +
    "4.1.4's cursor-paginated `getBacklog` (fetch a page, append on scroll via the existing " +
    'load-more/`useRowWindow` machinery) and shows a bounded count header. Sprint containers bind to ' +
    '`getSprintIssues` (also paged-capable). Reordering and assigning stay O(1) single-row (or bounded ' +
    'bulk) writes against the fractional index. A backlog UI that fetched every row to render the list ' +
    'or summed every loaded card would be prototype-thinking — flag and forbid it (finding #57).\n\n' +
    '**The real-product states.** **Empty backlog** (no unassigned issues) → an `EmptyState` with a ' +
    'create CTA; **no sprints planned** → the sprint region shows only the Create-sprint affordance; ' +
    '**loading** → a backlog skeleton (reuse the 3.2.2 scaffold idiom); **error** → `ErrorState` with ' +
    'retry; **scale** → the bounded count header + virtualized list. Every state is drawn in 4.2.1, not ' +
    'improvised.\n\n' +
    '**See all issues — the issue-navigator link (mirror rung 1, Jira "View in Issue Navigator").** ' +
    "The page-head toolbar carries a **View all issues** link that deep-links to the project's issue " +
    'navigator — the **Story-2.5 `/issues` List/Tree** (every issue across the backlog AND all sprints, ' +
    'sortable/filterable/paginated). VERIFIED against Jira (June 2026): the backlog/board does NOT ' +
    'flatten its grouped planning view into a flat "all issues" list on the same page — it LINKS OUT to ' +
    'the navigator with the board filter applied. Prodect already ships that navigator, so 4.2 reuses ' +
    'it via a plain `<a>` (no new view, no flat list duplicated here — "no complexity for nothing"); ' +
    'when Epic-6 board/saved filters land the link can carry the active filter query.\n\n' +
    '**Nav + a11y + tokens.** A new **Backlog** sidebar item + ⌘K entry (project-scoped, adjacent to ' +
    'Boards, with a `nav.backlog` i18n key); drag is keyboard-operable (dnd-kit keyboard sensor, per ' +
    '3.2); selection + counts are read as text (not colour/shape alone — finding #35); colour via ' +
    '`--el-*`, shape via the element shape tokens (no Tier-0 `--color-*` / raw `rounded-*` — ' +
    '`prodect-core/CLAUDE.md`).\n\n' +
    '**Out of scope (Epic-4 siblings / Epic 6 / later):** story-point estimation + the inline-estimate ' +
    'badge + the committed-points roll-up that fills the seam (Story **4.3**); the velocity comparison ' +
    'that fills the velocity seam (Story **4.6**); the sprint START / COMPLETE flows + scope-lock + ' +
    'carry-over + sprint report — 4.2 mounts/seams the Start-sprint entry point but the flow is Story ' +
    '**4.4**; the Scrum BOARD view (Story **4.5**); the sprint entity / association / rank writes / ' +
    'bounded reads themselves (Story **4.1** — consumed, not built); rich backlog filtering / quick ' +
    'filters / the filter builder (Epic **6** — the backlog ships its data-bound list; a saved-filter ' +
    'or field/operator filter layer is the Epic-6 search surface, not duplicated here — no complexity ' +
    'for nothing); board CRUD / multi-board nav (Story **3.7**); cross-project backlogs (the backlog is ' +
    "single-project by 4.1's `sprint.projectId` model).",
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (no 4.2 migration — the sprint + `backlog_rank` schema is Story 4.1), `pnpm db:seed`, `pnpm dev`. (Requires Story 4.1 merged so sprints + the bounded backlog/sprint reads exist to bind to.)\n' +
    '- **Design exists first:** `design/backlog/backlog.mock.html` + `backlog-scale.mock.html` + a PNG export + `design/backlog/design-notes.md` exist (subtask 4.2.1), built from `components/ui/*` + `--el-*`/element-shape tokens only, AA-safe, passing the render checklist — and the points/velocity/start-sprint SEAMS are named in the notes as filled by Stories 4.3 / 4.6 / 4.4.\n' +
    '- `pnpm test` — vitest (real Postgres) covers the 4.2.2 composition: `bulkAssignToSprint` / `bulkMoveToBacklog` move every selected issue in ONE transaction (partial failure rolls back), the same-project guard rejects a cross-project member of the batch, the batch size is bounded, and `createBacklogIssue` creates + appends a `backlog_rank` + optionally assigns in one tx and records a 1.4.6 revision.\n' +
    '- `pnpm test:e2e --grep backlog` — Playwright drives a real grooming session: the `/backlog` page renders the sprint containers + the ranked backlog; drag a row to reorder (its `backlog_rank` changes, neighbours do not); drag a row into a sprint (it leaves the backlog and the sprint count increments); multi-select two rows and bulk-move them to a sprint atomically; inline-create an issue into the backlog and into a sprint; the Start-sprint entry point is present (the flow is 4.4).\n' +
    "- **Backlog render check:** sign in as `zhuyue@prodect.co`, open the `prodect` project → the **Backlog** nav item leads to `/backlog`, which shows the sprint-planning container(s) above the ranked backlog list, each issue row with type icon / key / summary / epic chip / assignee / status, the empty **estimate slot** (the 4.3 seam, not a number yet) and the sprint header's empty **committed-points slot** (the 4.3 seam) + **velocity slot** (the 4.6 seam). Layout matches `design/backlog/backlog.mock.html`.\n" +
    '- **View-all-issues check:** the page-head toolbar shows a **View all issues** link that navigates to the project\'s issue navigator (`/issues`, Story 2.5) — every issue across the backlog and all sprints in the sortable/filterable list; the backlog page does NOT rebuild a flat all-issues list (Jira\'s "View in Issue Navigator" mirror).\n' +
    "- **Rank check:** dragging an issue between two neighbours writes a single `backlog_rank` (4.1.4 `keyBetween`) that lands it strictly between them; no other row's rank changes; the order survives reload.\n" +
    '- **Assign check:** dragging a backlog issue into a sprint sets its `sprint_id` (it disappears from the backlog list, appears in the sprint container, the counts update); dragging it back to the backlog restores it in rank order.\n' +
    '- **Bulk check:** selecting multiple rows (click + shift-range + ⌘-toggle) and choosing "Move to sprint" moves them all atomically (one request); a forced mid-batch failure leaves NONE moved (transaction rollback), not a partial set.\n' +
    '- **Create check:** the inline "+ Create issue" row creates an issue into the backlog (ranked at the end) or directly into a sprint (assigned) in one action.\n' +
    '- **Scale check (finding #57):** `pnpm db:seed:large` (a project with thousands of backlog issues) → `/backlog` renders a bounded first page + a count header, lazy-loads more on scroll (the `useRowWindow` window + cursor pages, never a load-all), drag still works out of the virtualized list, and the DOM row count stays bounded; matches `design/backlog/backlog-scale.mock.html`.\n' +
    '- **States check:** empty backlog → `EmptyState` + create CTA; no sprints → Create-sprint affordance only; loading → skeleton; error → `ErrorState` + retry.\n' +
    '- **a11y check:** the backlog + each sprint container are labelled landmarks; drag is keyboard-operable (dnd-kit keyboard sensor); selection state + counts read as text (not colour-alone, finding #35).',
  items: [
    {
      id: '4.2.1',
      title:
        'Design — Backlog / sprint-planning surface: sprint containers, ranked backlog list, issue row, drag + multi-select states, scale + points/velocity seams (NEW design/backlog/)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 48,
      dependsOn: [],
      descriptionMd:
        'The design asset EVERY UI subtask of this story builds against. The Backlog is a brand-new ' +
        'surface — `design/` has no `backlog/` area and no existing mockup depicts a ranked backlog, a ' +
        'sprint-planning container, a drag-into-sprint state, or a multi-select bar — so under the design ' +
        'gate NO design exists and this subtask CREATES it FIRST (mirrors 1.0.5 / 1.2.1 / 1.3.3 / 1.5.1 ' +
        'and the 4.5.1 scrum extension). Output: a NEW area `design/backlog/` with ' +
        '`backlog.mock.html` (the surface + its states) + `backlog-scale.mock.html` (the large-backlog ' +
        'virtualized/paginated panel) + PNG exports + `design/backlog/design-notes.md` naming every ' +
        'composing primitive, copy string, and placement. Built from the real design system ' +
        '(`components/ui/*` + the `--el-*` tokens + element shape tokens — so a coding agent has no ' +
        'Pencil→code gap); `--el-*` only (no Tier-0 `--color-*`); shape via the element shape tokens; ' +
        'AA-safe; the Jira backlog / sprint-planning screen as the mirror.\n\n' +
        "**This surface REUSES existing vocabularies — reference, don't redraw.** The issue ROW reuses " +
        'the Story-2.x work-items list row (type icon + key + summary + epic chip + assignee + status); ' +
        'the DRAG affordance reuses the Story-3.2 board drag vocabulary (handle, drag overlay, drop ' +
        'highlight); the empty/loading/error states reuse the shipped `EmptyState` / `ErrorState` / ' +
        'skeleton idioms. Draw the NET-NEW composition, not the primitives.\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **Page layout** — within the app shell: the new **Backlog** nav item (where it sits relative ' +
        'to Boards/Reports + its icon) and the two stacked regions — sprint containers (top) over the ' +
        'backlog container (bottom).\n' +
        '- **Sprint-planning container** — a collapsible panel: sprint **name** + state `Pill`, the ' +
        '**date range**, an **issue count**, a **committed-points slot** (the Story-4.3 SEAM — draw it ' +
        'as a labelled empty slot, note it is filled by 4.3), a **velocity slot** (the Story-4.6 SEAM), ' +
        'the **Start-sprint** entry point (note the flow is Story 4.4 — this asset specifies only the ' +
        'entry point placement/label, like 4.5.1 did for Complete-sprint), the ranked issue rows, and an ' +
        'inline **+ Create issue** row. Plus the empty sprint container ("No issues — drag from the ' +
        'backlog") and the **Create sprint** affordance (adds an empty planned sprint).\n' +
        '- **Backlog container** — the count header ("N issues" — the bounded count, not a loaded-row ' +
        'tally), the ranked rows, the inline create row.\n' +
        '- **Issue row** — the composed row with the drag handle, type icon (`--el-type-*` hue), key, ' +
        'summary, epic chip, the **estimate slot** (the Story-4.3 SEAM — an empty/placeholder badge, ' +
        'noted as filled by 4.3), assignee avatar, status `Pill`, the selection affordance, and the `⋯` ' +
        'context menu. Specify the slot order so the estimate seam has a reserved place (4.3 drops a ' +
        'number in without a relayout).\n' +
        '- **Drag states** — a row mid-drag (the overlay), the drop-target highlight on a sprint ' +
        'container and on a backlog insertion point, and the multi-select drag (the "N issues" stacked ' +
        'overlay).\n' +
        '- **Multi-select** — the selected-row treatment and the selection/bulk-action bar ("N ' +
        'selected" + Move to sprint ▸ / Move to backlog), distinct from a single-row hover.\n' +
        '- **Context menu (`⋯`)** — the row actions: Move to sprint ▸ (submenu of sprints), Move to top ' +
        '/ bottom of backlog, (and the seams the later stories add).\n' +
        '- **States** — empty backlog `EmptyState` + create CTA; no-sprints state; loading skeleton; ' +
        '`ErrorState` + retry.\n' +
        '- **Scale panel (`backlog-scale.mock.html`)** — the large backlog: the bounded count header, ' +
        'the virtualized list window (only the visible rows rendered), and the lazy-load affordance, so ' +
        'the build target is the bounded shape, not load-all (finding #57).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A NEW `design/backlog/` area exists with `backlog.mock.html` + `backlog-scale.mock.html` + PNG export(s) + `design/backlog/design-notes.md`; the mockups are built from `components/ui/*` + `--el-*`/element-shape tokens only (no Tier-0 `--color-*`, no raw `rounded-*`/`p-*` for control shape), pass the render checklist (icon viewBox, no nested buttons, prettier), and are AA-safe.\n' +
        '- The mockups draw: the page layout + nav item, the sprint-planning container (name + state + dates + count + the committed-points SEAM slot + the velocity SEAM slot + Start-sprint entry point + inline create + Create-sprint), the backlog container (bounded count header + rows + inline create), the issue row (with a RESERVED estimate-seam slot), the drag states (single + multi-select overlay + drop highlights), the multi-select selection/bulk bar, the `⋯` context menu, every empty/loading/error state, and the scale panel (bounded count + virtualized window + lazy-load).\n' +
        '- `design-notes.md` names each composing primitive (`Pill`, `EmptyState`, `ErrorState`, the work-items row, the `⋯` menu, the skeleton) AND explicitly documents the SEAMS: the row estimate slot + the sprint committed-points slot are filled by **Story 4.3**, the velocity slot by **Story 4.6**, and the Start-sprint flow is **Story 4.4** (this asset is the entry point only) — so a future coding agent does not improvise them.\n' +
        '- The asset REUSES (references, does not redraw) the work-items row + the 3.2 board drag vocabulary + the shipped state primitives; it specifies only the net-new backlog/sprint-planning composition.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/list.mock.html` + `design-notes.md` (Story 2.x) — the issue-row vocabulary to reuse (type icon, key, summary, epic chip, assignee, status)\n' +
        '- `design/boards/board.mock.html` + the 3.2 board design-notes — the drag handle / overlay / drop-highlight vocabulary to reference (so backlog drag matches board drag)\n' +
        '- `components/ui/*` (`Pill`, `EmptyState`, `ErrorState`, `Button`, the menu primitive) + the heading/type scale — the primitives to compose\n' +
        '- `app/globals.css` `--el-*` + element-shape tokens; the `/tokens` specimen route\n' +
        '- Story 4.3 (estimation — fills the estimate + committed-points seams), Story 4.6 (velocity — fills the velocity seam), Story 4.4 (Start-sprint flow the entry point seams to) — name them in the notes\n' +
        '- The Jira backlog / sprint-planning screen as the mirror; finding #57 (bounded/virtualized, not load-all), #35 (not colour-alone), #54 (use the palette)',
    },
    {
      id: '4.2.2',
      title:
        'Backend — atomic bulk sprint-assign / move-to-backlog + create-into-sprint (composes the 4.1.4 single-issue primitives; bounded batch, one transaction)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['4.1.3', '4.1.4'],
      descriptionMd:
        "The ONLY net-new backend in this Story: a thin composition layer over Story 4.1.4's " +
        "single-issue primitives, so the backlog's multi-select + inline-create affordances are ATOMIC " +
        'and bounded rather than N client round-trips. Strictly composes existing service methods + the ' +
        '4-layer rules (CLAUDE.md); adds no new schema (the sprint + `backlog_rank` model is Story ' +
        '4.1).\n\n' +
        '**Why a backend subtask at all (vs. looping 4.1.4 in the client).** Jira moves a multi-selection ' +
        'to a sprint in one operation; doing it as N sequential `assignToSprint` calls from the browser ' +
        'is slow at real-team scale and NON-ATOMIC — a mid-batch failure leaves half the selection moved. ' +
        'A bounded server transaction is the durable shape (completeness/scale axis), so the bulk move ' +
        'is one `prisma.$transaction`.\n\n' +
        "**Methods** (extend `sprintsService` / `backlogService` — wherever 4.1.4's association writes " +
        'live; same module, one tx per method, DTO mapping, typed errors, the finding-#26 `workspaceId` ' +
        'gate on every read/write):\n' +
        '- `bulkAssignToSprint(itemIds: string[], sprintId: string)` — assign every issue in ONE ' +
        "transaction, reusing 4.1.4 `assignToSprint`'s same-project guard per item (reject the WHOLE " +
        'batch with `CrossProjectSprintAssignmentError` if any member is cross-project — atomic, no ' +
        'partial move); records a 1.4.6 revision per moved item in the same tx. **Bounded:** cap the ' +
        'batch (e.g. ≤ a sane max) and reject oversize with a typed error — never an unbounded write.\n' +
        '- `bulkMoveToBacklog(itemIds: string[])` — null `sprint_id` for every issue in one tx (they ' +
        'reappear in `backlog_rank` order); same bounded + revision rules.\n' +
        '- `createBacklogIssue(projectId, { sprintId?, title, type, ... })` — create an issue, append ' +
        'its `backlog_rank` (4.1.4 create-time-rank path), and — when `sprintId` is given — assign it ' +
        '(same-project guard) ALL in one transaction; records the create + assignment revision. Reuses ' +
        '`workItemsService.create`; keep the new surface thin.\n' +
        '- **Empty-input guards** (`prodect-core-coverage-gate`): an empty `itemIds` short-circuits ' +
        '(no-op, not an error) with a direct unit test so the branch-coverage gate stays green.\n\n' +
        '**Routes** (HTTP-only, one service call + error→status mapping each): `POST ' +
        '/api/sprints/[id]/issues:bulk` (bulk assign) / `POST /api/projects/[id]/backlog:bulk-move` ' +
        '(bulk to backlog) / `POST /api/projects/[id]/backlog/issues` (create into backlog or sprint) — ' +
        'or the closest existing route shape; no business logic in the route.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `bulkAssignToSprint` + `bulkMoveToBacklog` move every issue in the batch in ONE transaction (a forced mid-batch failure rolls the whole batch back — no partial move); the same-project guard rejects the whole batch if any member is cross-project; the batch is bounded (oversize → typed error); each moved item records a 1.4.6 revision.\n' +
        '- `createBacklogIssue` creates an issue, appends a `backlog_rank`, and optionally assigns it to a sprint (same-project guarded) in one transaction, recording the revision; it reuses `workItemsService.create` rather than re-implementing creation.\n' +
        '- Methods own their transaction, return DTOs (mapped in `lib/mappers/*`), throw typed errors the routes map to status codes, and enforce the finding-#26 `workspaceId` gate; empty `itemIds` is a guarded no-op with a direct test.\n' +
        '- Routes are HTTP-only one-service-call handlers; no new migration (the model is Story 4.1).\n' +
        '- `pnpm test:coverage` keeps the new/changed service + route files ≥90% branch/fn/line (the CI coverage gate).\n\n' +
        '## Context refs\n\n' +
        '- Story 4.1.4 (`assignToSprint` / `moveToBacklog` / `rankIssue` + the create-time-rank path) + 4.1.3 (`sprintsService` + DTOs/errors) — the single-issue primitives this composes; do NOT re-implement them\n' +
        '- `lib/services/workItemsService.ts` — the `create` path `createBacklogIssue` reuses; the 1.4.6 `workItemRevisionsService` audit write to reuse in the same tx\n' +
        '- `lib/services/boardsService.ts` — the bulk/transaction + DTO-mapping shape to mirror; `lib/mappers/*`, `lib/dto/*`, `lib/<domain>/errors.ts` layout\n' +
        '- `prodect-core/CLAUDE.md` (4-layer: one-tx-per-method, repo single-ops, required-`tx` writes, HTTP-only routes) + `prodect-core-coverage-gate` (empty-input guard tests) + finding #26 (`workspaceId` gate)',
    },
    {
      id: '4.2.3',
      title:
        'Backlog page + nav — ranked virtualized/paginated backlog list + sprint-planning containers (read render) + empty/loading/error/scale states + points/velocity seams',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 34,
      dependsOn: ['4.2.1', '4.1.4'],
      descriptionMd:
        'The page scaffold + the read-only render of the backlog surface — the structure subtasks 4.2.4 ' +
        '(drag) and 4.2.5 (multi-select + create) build interaction onto. Drawn per ' +
        '`design/backlog/backlog.mock.html`; reuses the work-items row + the shipped state primitives + ' +
        'the `useRowWindow` virtualization (3.2.5). No drag and no selection yet — those are 4.2.4 / ' +
        '4.2.5.\n\n' +
        '**Route + nav.** A new `/backlog` route under `app/(authed)/backlog/` (project-scoped — the ' +
        'active project from the shell context, like `/boards`). Add a **Backlog** item to `SidebarNav` ' +
        '(adjacent to Boards) + an `AppCommandPalette` ⌘K entry, with a `nav.backlog` i18n key (and ' +
        "every shipped locale's value). No other nav change. The page-head toolbar carries a **View " +
        'all issues** link (mirror rung 1 — Jira "View in Issue Navigator", VERIFIED June 2026): a ' +
        "plain `<a>` to the project's issue navigator (`/issues`, the Story-2.5 List/Tree — every issue " +
        'across the backlog AND all sprints). NOT a flat list rebuilt on this page (Jira links out to ' +
        'the navigator, it does not flatten the grouped planning view) — the navigator already exists, ' +
        'so this is a link, no new view; a `backlog.viewAllIssues` i18n key (every shipped locale). It ' +
        'sits beside the disabled `[Filter]` seam (Epic 6) + `[+ New issue]`.\n\n' +
        "**Sprint-planning containers (read render).** Bind to 4.1.3 `listByProject` (the project's " +
        'sprints) + 4.1.4 `getSprintIssues` per sprint: render each as a collapsible container with the ' +
        'name + state `Pill` + date range + **issue count**, the ranked issue rows, the ' +
        '**committed-points SLOT** (the Story-4.3 seam — a reserved labelled empty slot, NOT a computed ' +
        'number) + the **velocity SLOT** (the Story-4.6 seam), and the **Start-sprint** entry point (the ' +
        'flow is Story 4.4 — render it as the seam 4.4 wires, exactly as 4.5.3 seams Complete-sprint) + ' +
        'a **Create-sprint** affordance (4.1.3 `createSprint`). The inline-create row + the `⋯` menu are ' +
        'placed but wired in 4.2.5.\n\n' +
        '**Backlog list (bound to the BOUNDED read — finding #57).** Bind to 4.1.4 ' +
        '`getBacklog(projectId, { cursor, limit })`: render the **bounded count header** ("N issues" — ' +
        'from the aggregate count, not a loaded-row tally), the ranked rows in a **virtualized** list via ' +
        'the shipped `useRowWindow` hook (3.2.5 — only visible rows in the DOM), and **lazy-load the next ' +
        'page** on scroll via the cursor (the 3.2.5 load-more machinery). NEVER fetch every row. Each ' +
        'row composes the work-items row vocabulary + the reserved **estimate SLOT** (the Story-4.3 ' +
        'seam).\n\n' +
        '**States.** Empty backlog → `EmptyState` + create CTA; no sprints → the Create-sprint ' +
        'affordance only; loading → a backlog skeleton (the 3.2.2 scaffold idiom); error → `ErrorState` ' +
        '+ retry. All per the 4.2.1 design.\n\n' +
        '**Tokens + a11y.** Colour via `--el-*` (issue-type hue via the `IssueTypeIcon`); shape via the ' +
        'element shape tokens (no Tier-0 `--color-*`, no raw `rounded-*`/`p-*` for control shape — ' +
        'CLAUDE.md); the backlog + each sprint container are labelled landmarks; counts read as text ' +
        '(finding #35).\n\n' +
        '**Out of scope here:** drag-to-reorder / drag-into-sprint (4.2.4); multi-select + bulk + inline ' +
        'create wiring + the `⋯` menu actions (4.2.5); the estimate/points/velocity NUMBERS (Stories ' +
        '4.3 / 4.6 fill the seams); the Start-sprint FLOW (Story 4.4).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A new `/backlog` route renders the sprint-planning containers above the ranked backlog list for the active project; a **Backlog** `SidebarNav` item + ⌘K entry (with a `nav.backlog` i18n key in every shipped locale) lead to it; no other nav change.\n' +
        '- The page-head toolbar carries a **View all issues** link (a plain `<a>`, `backlog.viewAllIssues` i18n key) deep-linking to the project issue navigator (`/issues`, Story 2.5) — the Jira "View in Issue Navigator" affordance; NO flat all-issues list is rebuilt on this page.\n' +
        '- The backlog list binds to 4.1.4 `getBacklog` (cursor-paginated): a bounded count header, a `useRowWindow`-virtualized list (only visible rows in the DOM), and lazy-load-on-scroll via the cursor — NEVER a load-all read.\n' +
        '- Each sprint container renders name + state pill + date range + issue count + the committed-points SLOT + velocity SLOT (reserved empty seams, labelled, not computed) + the Start-sprint entry-point seam + the Create-sprint affordance; the backlog + sprint rows are the SAME work-items-vocabulary row with a RESERVED estimate slot.\n' +
        '- Empty / no-sprints / loading / error states render per `design/backlog/backlog.mock.html`; colour via `--el-*`, shape via element tokens, AA-safe; the backlog + each sprint container are labelled landmarks and counts read as text (finding #35).\n' +
        '- No drag, no selection, no create wiring yet (4.2.4 / 4.2.5); the estimate/points/velocity slots are empty seams (Stories 4.3 / 4.6).\n' +
        '- Component tests assert the container/list render, the bounded count header + virtualized window (DOM stays bounded on a large seed), and each state.\n\n' +
        '## Context refs\n\n' +
        '- `design/backlog/backlog.mock.html` + `design-notes.md` (4.2.1) — the layout + seam spec this matches\n' +
        '- `app/(authed)/boards/page.tsx` + `app/(authed)/boards/_components/BoardColumn.tsx` (`useRowWindow`) / `BoardColumnPager.tsx` (3.2.2 / 3.2.5) — the page scaffold + virtualization + load-more idioms to reuse\n' +
        '- `app/(authed)/_components/SidebarNav.tsx` + `AppCommandPalette.tsx` — where the Backlog nav item + ⌘K entry land; the i18n `nav.*` key pattern\n' +
        '- `app/(authed)/issues/` (Story 2.5 List/Tree — the issue navigator the **View all issues** toolbar link targets); Jira "View in Issue Navigator" is the mirror — link out, do not rebuild a flat list here\n' +
        '- Story 4.1.4 (`getBacklog` / `getSprintIssues`) + 4.1.3 (`listByProject` / `createSprint`) — the reads/CRUD this binds to; `components/ui/*` (`Pill`, `EmptyState`, `ErrorState`) + the work-items row\n' +
        '- finding #57 (bounded/virtualized list), #35 (not colour-alone), #54 (palette); `prodect-core/CLAUDE.md` (`--el-*` + element-shape rules)',
    },
    {
      id: '4.2.4',
      title:
        'Drag — reorder (rank) + drag-into-sprint + drag-between-sprints over the virtualized list, reusing the Story-3.2 dnd-kit move contract (optimistic + snap-back)',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 32,
      dependsOn: ['4.2.1', '4.2.3', '4.2.2'],
      descriptionMd:
        'Make the backlog groomable by drag — reorder within a region, drag an issue into a sprint, and ' +
        'drag between sprints / back to the backlog — built on the SAME `@dnd-kit` move contract the ' +
        'board (Story 3.2) already ships, over the 4.2.3 virtualized list. Drawn per the 4.2.1 drag ' +
        'states. No new drag mechanism (reuse), no new card vocabulary.\n\n' +
        '**Reuse the 3.2 contract.** Render the rows inside a `@dnd-kit/core` `DndContext` + ' +
        '`@dnd-kit/sortable` exactly as the board does, reusing the `boardMove.ts` move-resolution + the ' +
        'drag overlay + the keyboard sensor (drag is keyboard-operable). The 3.2.5 `useRowWindow` ' +
        'virtualization keeps the dragged node attached when it scrolls out of the window (the same ' +
        '"render the active drag node + its neighbours" guard the board uses).\n\n' +
        '**The three moves → 4.1.4 / 4.2.2 writes:**\n' +
        '- **Reorder within a region** → 4.1.4 `rankIssue(itemId, { beforeId?, afterId? })`: compute the ' +
        'new `backlog_rank` between the drop neighbours (a single-row `keyBetween` write — never an N-row ' +
        'renumber), handling the append/prepend edges.\n' +
        '- **Drag backlog → sprint** (or **sprint → sprint**) → 4.1.4 `assignToSprint` (single) with an ' +
        'optional rank placement within the target; the same-project guard backstops the write.\n' +
        '- **Drag sprint → backlog** → 4.1.4 `moveToBacklog` (the issue reappears in `backlog_rank` ' +
        'order).\n\n' +
        '**Optimistic + snap-back (the 3.2 board contract).** Apply the move locally on drop, fire the ' +
        'write, and **snap back + surface an error** on failure — never leave the UI out of sync with ' +
        'the server. Counts (the sprint issue count, the backlog count header) update with the move.\n\n' +
        '**Scale (finding #57).** Drag composes with the virtualized + lazy-loaded list (4.2.3): a drop ' +
        'target may be a not-yet-loaded region (drop at the end of a sprint / backlog resolves to a ' +
        'rank-append, no need to have every row loaded), and the rank write stays O(1). The drag never ' +
        'forces a load-all.\n\n' +
        '**Out of scope here:** multi-select drag of N rows + the bulk bar (4.2.5 — single-row drag ' +
        'here); inline create + the `⋯` menu (4.2.5); the points/velocity numbers (4.3 / 4.6).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Rows render inside a `@dnd-kit` `DndContext`/`SortableContext` reusing the Story-3.2 `boardMove.ts` move-resolution + drag overlay + keyboard sensor; dragging out of the `useRowWindow`-virtualized list keeps the active node attached.\n' +
        "- Reorder within a region writes a single `backlog_rank` via 4.1.4 `rankIssue` (`keyBetween`, append/prepend edges handled) — strictly between the drop neighbours, no other row's rank changed; drag backlog→sprint / sprint→sprint calls `assignToSprint` (same-project guarded); drag sprint→backlog calls `moveToBacklog`.\n" +
        '- Moves are optimistic and SNAP BACK with a surfaced error on write failure; the sprint issue count + backlog count header update with the move; drag is keyboard-operable.\n' +
        '- Drag composes with the virtualized/lazy-loaded list (finding #57): a drop into a not-yet-fully-loaded region resolves correctly (append/edge) and never forces a load-all; rank writes stay O(1).\n' +
        '- Component tests assert reorder (single-row rank write), drag-into-sprint (assign + counts), drag-to-backlog (move + restore), and snap-back on failure.\n\n' +
        '## Context refs\n\n' +
        '- `app/(authed)/boards/_components/boardMove.ts` + `BoardColumn.tsx` (`DndContext` + `useRowWindow` + the active-node-attached guard) + `BoardCard.tsx` (Story 3.2.3–3.2.5) — the dnd-kit move contract + virtualized-drag pattern to reuse\n' +
        '- Story 4.1.4 (`rankIssue` / `assignToSprint` / `moveToBacklog`) — the single-row writes the drops call; 4.2.2 — the bulk path 4.2.5 layers on (single here)\n' +
        '- `design/backlog/backlog.mock.html` drag-state panels (4.2.1) — the overlay + drop-highlight spec\n' +
        '- `@dnd-kit/core` / `@dnd-kit/sortable` / `@dnd-kit/utilities` (already in `package.json`); finding #57 (drag over a bounded list); `prodect-core/CLAUDE.md`',
    },
    {
      id: '4.2.5',
      title:
        'Multi-select + atomic bulk move + inline create + row context menu (the grooming actions)',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['4.2.1', '4.2.3', '4.2.4', '4.2.2'],
      descriptionMd:
        'The grooming actions on top of the rendered + draggable backlog: multi-select with an atomic ' +
        'bulk move, inline issue create into the backlog or a sprint, and the per-row `⋯` context menu. ' +
        'Drawn per the 4.2.1 multi-select + context-menu panels; binds to the 4.2.2 bulk/create endpoints.\n\n' +
        '**Multi-select.** A selection model over the rows: click selects, **shift-click** selects the ' +
        'range, **⌘/ctrl-click** toggles one (the Jira backlog selection model). Selected rows take the ' +
        'design\'s selected treatment; a **selection bar** shows "N selected" + bulk **Move to sprint ▸** ' +
        "(submenu of the project's sprints) + **Move to backlog**. Selection survives lazy-load of more " +
        'rows (key by issue id, not row index — it must not break as the virtualized window scrolls).\n\n' +
        '**Atomic bulk move (binds to 4.2.2).** Bulk actions call 4.2.2 `bulkAssignToSprint` / ' +
        '`bulkMoveToBacklog` — ONE request, one transaction (NOT a client loop over the single-issue ' +
        'endpoint): the whole selection moves or none does. Optimistic with snap-back on failure (the ' +
        '4.2.4 contract); counts update; the selection clears on success. Multi-select **drag** (dragging ' +
        'a selection of N rows, the "N issues" overlay from 4.2.1) routes through the same bulk path.\n\n' +
        '**Inline create (binds to 4.2.2).** The **+ Create issue** rows (in the backlog and in each ' +
        'sprint container, placed by 4.2.3) call 4.2.2 `createBacklogIssue` — into the backlog ' +
        '(rank-appended) or directly into that sprint (assigned) — in one action; the new row appears in ' +
        'place without a full reload.\n\n' +
        '**Row context menu (`⋯`).** Per-row actions: **Move to sprint ▸** (submenu), **Move to ' +
        'backlog**, **Move to top / bottom of backlog** (rank to the boundary via 4.1.4 `rankIssue` ' +
        'append/prepend). The menu reuses the shipped menu primitive (no nested buttons, no hand-rolled ' +
        'popover). Keyboard-operable; the seams later stories add (estimate/points) are NOT here.\n\n' +
        '**Out of scope here:** the points/velocity numbers (Stories 4.3 / 4.6); the Start/Complete-sprint ' +
        'FLOWS (Story 4.4 — the entry points are seams from 4.2.3); rich filtering (Epic 6).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Rows support click / shift-range / ⌘-toggle selection (keyed by issue id so it survives lazy-load + virtualized scroll); selected rows take the design treatment; a selection bar shows "N selected" + Move to sprint ▸ + Move to backlog.\n' +
        '- Bulk move calls 4.2.2 `bulkAssignToSprint` / `bulkMoveToBacklog` as ONE atomic request (not a client loop); optimistic with snap-back on failure; counts update; selection clears on success; multi-select drag of N rows routes through the same bulk path.\n' +
        '- The inline **+ Create issue** rows call 4.2.2 `createBacklogIssue` to create into the backlog (rank-appended) or a sprint (assigned) in one action; the new row appears in place.\n' +
        '- The `⋯` row menu offers Move to sprint ▸ / Move to backlog / Move to top|bottom of backlog (4.1.4 `rankIssue` boundary), reuses the shipped menu primitive (no nested buttons), and is keyboard-operable.\n' +
        '- Colour via `--el-*`, shape via element tokens, AA-safe; matches `design/backlog/backlog.mock.html`.\n' +
        '- Component tests assert the selection model (incl. shift-range + survive-lazy-load), the atomic bulk move (one request + snap-back), inline create into backlog + sprint, and the `⋯` menu actions.\n\n' +
        '## Context refs\n\n' +
        '- Story 4.2.2 (`bulkAssignToSprint` / `bulkMoveToBacklog` / `createBacklogIssue`) — the atomic endpoints these actions bind to; Story 4.2.4 (optimistic/snap-back + the dnd context) — the drag path multi-select drag reuses\n' +
        '- `design/backlog/backlog.mock.html` multi-select + context-menu panels (4.2.1) — the selection bar + `⋯` menu spec\n' +
        '- `components/ui/*` menu primitive (the shipped dropdown/menu; no nested buttons) + the work-items row; `app/(authed)/boards/_components/ColumnActionsMenu.tsx` — the row/column `⋯` menu pattern to mirror\n' +
        '- finding #35 (selection read as text, not colour-alone); `prodect-core/CLAUDE.md` (`--el-*` + element-shape, menu primitive reuse)',
    },
    {
      id: '4.2.6',
      title:
        'Story tests — bulk/create service + selection/drag/create components + at-scale backlog-grooming E2E',
      status: 'planned',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 24,
      dependsOn: ['4.2.2', '4.2.3', '4.2.4', '4.2.5'],
      descriptionMd:
        "The closing test subtask — the same split Stories 4.1.5 / 4.5.4 used: this Story's OWN " +
        'service/component tests + a focused at-scale backlog E2E, against the real Postgres (the ' +
        "project convention: no mocks except `getSession`; `tests/helpers/db.ts` truncation). Story 4.1's " +
        'single-issue association/rank + bounded reads are already proven in 4.1.5; this proves the bulk ' +
        'composition + the grooming UI on top.\n\n' +
        '**Service (vitest, real Postgres).** 4.2.2: `bulkAssignToSprint` / `bulkMoveToBacklog` move the ' +
        'whole batch in ONE transaction (a forced mid-batch failure rolls back — assert NONE moved, not ' +
        'a partial set), the same-project guard rejects a batch with a cross-project member (atomic), the ' +
        'batch bound rejects oversize, an empty `itemIds` is a guarded no-op, and each move records a ' +
        '1.4.6 revision; `createBacklogIssue` creates + appends a `backlog_rank` + optionally assigns in ' +
        'one tx and records the revision.\n\n' +
        '**Component.** The container/list render + bounded count + virtualized window (DOM stays bounded ' +
        'on a large seed); the selection model (click / shift-range / ⌘-toggle, survives lazy-load); ' +
        'drag reorder (single-row rank write) + drag-into-sprint (assign + counts) + snap-back on ' +
        'failure; inline create into backlog + sprint; the `⋯` menu actions; the empty/loading/error ' +
        'states.\n\n' +
        '**E2E (Playwright) `tests/e2e/backlog.spec.ts`.** A real grooming session against a seeded ' +
        'project with sprints + a backlog:\n' +
        '- **Render** — `/backlog` shows the sprint container(s) over the ranked backlog; the Backlog ' +
        'nav item leads here.\n' +
        '- **Rank** — drag a row between two neighbours; its order changes and survives reload (single-row ' +
        'rank).\n' +
        '- **Assign** — drag a backlog row into a sprint; it leaves the backlog, the sprint count ' +
        'increments; drag it back; it restores in rank order.\n' +
        '- **Bulk** — multi-select two rows and Move to sprint; both move in one action; (a forced ' +
        'failure path leaves none moved).\n' +
        '- **Create** — inline-create an issue into the backlog and into a sprint.\n' +
        '- **Scale (finding #57)** — against `pnpm db:seed:large`, the backlog renders a bounded first ' +
        'page + count, lazy-loads on scroll (DOM bounded), and drag still works out of the virtualized ' +
        'list.\n\n' +
        'Defers nothing to a later test story (4.2 is self-contained); the Scrum-board + combined ' +
        'at-scale Scrum journey is Stories 4.5.4 / 4.7, not here.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test` (real Postgres) covers 4.2.2 (atomic bulk move + rollback-on-failure, same-project batch guard, batch bound, empty-input no-op, create-into-sprint, 1.4.6 revisions) and the components (container/list/bounded-count/virtualized window, selection model incl. shift-range + survive-lazy-load, drag reorder/assign/snap-back, inline create, `⋯` menu, states).\n' +
        '- `pnpm test:e2e --grep backlog` runs green over the real stack: render + nav, drag-reorder (survives reload), drag-assign + count update + restore, atomic multi-select bulk move, inline create into backlog + sprint, and the at-scale bounded/virtualized/lazy-load grooming (DOM bounded, drag works) on `db:seed:large`.\n' +
        '- `pnpm test:coverage` keeps the Story-4.2 service/route + component files ≥90% branch/fn/line (the CI coverage gate); the suite uses the real-Postgres harness + the single allowed `getSession` mock.\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/board-ui.spec.ts` (3.2.7) + `tests/e2e/board-swimlanes.spec.ts` (3.3.7) — the dnd-kit + virtualized-list E2E patterns (drag, drop, scroll) to build the backlog E2E on; `tests/helpers/db.ts` (real-Postgres truncation + large-seed fixture)\n' +
        '- Story 4.2.2 (bulk/create service) + 4.2.3/4.2.4/4.2.5 (the UI under test); Story 4.1.5 — the single-issue association/rank/bounded-read tests this builds atop (no duplication)\n' +
        '- `prodect-core-coverage-gate` (≥90% per-file; empty-input guards need a direct test) + `prodect-core-local-postgres` (sandbox PG@5433 + Playwright) + `prodect-core/CLAUDE.md` (real-Postgres, no mocks, single `getSession` mock) + the `prodect-e2e-selector-gotchas` / `prodect-e2e-run-harness-oom` lessons',
    },
  ],
};
