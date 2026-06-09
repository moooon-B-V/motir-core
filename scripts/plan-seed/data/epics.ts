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
    status: 'in_progress',
    descriptionMd:
      'The architectural floor every other epic stands on: **project bootstrap**, **design ' +
      'system & brand**, authentication, multi-tenant workspaces, projects, the work-item schema, ' +
      'the web app shell, and async job infrastructure. Boring, foundational, non-negotiable. If ' +
      "this isn't solid, every other epic builds on sand. All 8 stories (1.0–1.6) shipped; a " +
      'post-completion legal-posture task (1.7 — CLA Assistant setup) was added when the open-core ' +
      'license boundary was reviewed (a CLA is required from day one if a future relicense — to ' +
      'BSL/SSPL — must remain optional without retroactive contributor consent chasing).',
    items: [
      {
        id: '1.7',
        kind: 'task',
        title: 'Set up CLA Assistant + commit Apache ICLA on prodect-core',
        status: 'planned',
        type: 'manual',
        executor: 'human',
        estimateMinutes: 30,
        descriptionMd:
          '**Type:** task · **Parent:** Epic 1 · **Executor:** human (no PR-of-code; ' +
          'GitHub-side install + a tiny doc commit).\n\n' +
          '**Why now, not at launch (Epic 8).** Industry pattern (MongoDB, Elastic, GitLab, ' +
          'Sentry, Plane) is unambiguous: introduce the CLA on day one. Without it, every outside ' +
          "contributor's commit becomes a copyright fragment we cannot unilaterally relicense — " +
          "even a single drive-by typo fix poisons the codebase's future optionality. The " +
          '**asymmetry is severe**: setting it up costs ~30 minutes; retrofitting it costs ' +
          'months-to-years of contributor outreach (Elastic took ~2 years). The relicense option ' +
          "we're protecting is NOT a current plan — it's the floor under all open-core options " +
          'should economics ever break (HashiCorp/Elastic/Redis/MongoDB all eventually exercised ' +
          'theirs, each one made possible by a CLA they had in place from earlier).\n\n' +
          '**Template chosen by the planner: Apache ICLA (a LICENSE, not an assignment).** Apache ' +
          'ICLA grants Prodect Inc. a broad license to the contribution; the contributor retains ' +
          'their copyright. This is contributor-friendly (low friction, the de-facto industry ' +
          'standard for individual contributions) AND broad enough to permit a future ' +
          'BSL/SSPL/source-available relicense — the rights granted include sublicensing, which ' +
          'is what a relicense needs. Considered and REJECTED: (a) **MongoDB-style copyright ' +
          'assignment** — broader rights but creates contributor pushback that hurts the ' +
          'community side of the moat; only worth it if a relicense is concretely planned, which ' +
          'it is not; (b) **DCO alone** (Developer Certificate of Origin, `Signed-off-by:` per ' +
          'commit) — much lower friction, used by Linux kernel + GitLab alongside their CLA, but ' +
          "the DCO is an ATTESTATION not a grant, so it doesn't carry the relicensing rights " +
          "we're protecting. DCO solves a different problem (provenance) and is not a CLA " +
          'substitute for our purpose.\n\n' +
          '**What you do.** (1) Sign in to https://cla-assistant.io with GitHub. ' +
          '(2) Authorize CLA Assistant on `moooon-B-V/prodect-core` (prodect-ai is private and ' +
          "won't have outside contributors — skip it). (3) Paste the Apache ICLA text " +
          '(https://www.apache.org/licenses/icla.pdf — convert to plain text), modified to name ' +
          '**"Prodect Inc."** as the receiving party in §1. Save. CLA Assistant now hooks every ' +
          'PR on prodect-core: it comments asking outside contributors to sign, and adds a ' +
          'required status check that turns green only once signed. (4) On a `seed/cla-setup` ' +
          'branch in prodect-core, commit **`prodect-core/CLA.md`** (the Apache ICLA text + a ' +
          "short preamble naming Prodect Inc. and linking to CLA Assistant's signing flow) AND " +
          'either create `prodect-core/CONTRIBUTING.md` or amend the existing one with a short ' +
          'paragraph: *"By opening a PR, you\'ll be asked to sign our CLA via CLA Assistant. This ' +
          "grants us the rights we need to maintain the project's open-source license and to " +
          'potentially relicense the codebase in the future. You retain copyright of your ' +
          'contribution."* Open + merge that PR (the `seed/*` prefix skips E2E + Vercel preview ' +
          'per PRODECT.md § Plan seed). (5) Open a throwaway PR from a second GitHub account ' +
          '(or any account without a signed CLA on file); confirm the bot comments + the status ' +
          'check appears red until signed. Close the throwaway PR. (6) Record the throwaway PR ' +
          "URL in the seed PR's body as the verification artifact (so future-me can audit that " +
          'the gate is live).\n\n' +
          '## Acceptance criteria\n\n' +
          '- CLA Assistant is installed and active on `moooon-B-V/prodect-core` (visible in the ' +
          "repo's installed-apps list and in CLA Assistant's dashboard).\n" +
          '- `prodect-core/CLA.md` exists at repo root, contains Apache ICLA text adapted to ' +
          'name Prodect Inc. as the receiving party.\n' +
          '- `prodect-core/CONTRIBUTING.md` carries a paragraph naming the CLA requirement and ' +
          'pointing contributors at the signing flow.\n' +
          '- A throwaway PR from an unsigned account demonstrates the bot comments + the ' +
          'required status check, recorded in the seed PR body.\n' +
          '- This task flips to `done` only on user confirmation that steps 1–5 are complete ' +
          '(mirrors 1.6.7 — manual SaaS provisioning, no PR-of-code to gate on).\n\n' +
          '## Context refs\n\n' +
          '- `PRODECT.md` § Source of truth (open-core architecture paragraph) — names the ' +
          'GPL-3.0 / closed-source `prodect-ai` split this CLA underwrites.\n' +
          '- `notes.html` mistake #17 — open-core is an architectural shift, not a license toggle; ' +
          'the CLA is the legal half of that architecture.\n' +
          '- Apache ICLA template: https://www.apache.org/licenses/icla.pdf\n' +
          '- CLA Assistant: https://cla-assistant.io\n' +
          '- Related: a follow-up task to land PRODECT.md "License boundary" + "Fork posture" ' +
          'doc edits (from the same legal-posture conversation) is out of scope here — separate ' +
          '`seed/*` PR against prodect-meta. The trademark filing (~$500, ~12 months) is ALSO ' +
          'out of scope and tracked as a finding rather than a planned task (it has no software ' +
          'artifact and no dependency on the seed).',
        explanationMd:
          'The CLA is the legal floor under the open-core moat. The license boundary rule ' +
          '(`prodect-core` GPL-3.0 calling `prodect-ai` closed over HTTP) survives only if ' +
          'Prodect Inc. retains enough rights over `prodect-core` to relicense if the open-core ' +
          'economics ever require it. Without a CLA, every outside contributor holds a copyright ' +
          'fragment we cannot unilaterally move — and the relicense option dies. With a CLA from ' +
          "day one, the option stays alive for the project's full lifetime at zero ongoing cost.",
      },
    ],
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
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 2 · **Surfaces:** issue detail relationships panel ' +
          '(Subtask 2.4.5) + issue-list quick-view peek (Subtask 2.5.21) · **Status:** fixed ' +
          '(PR #250, merged) · **Reported by:** Yue.\n\n' +
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
          '- `design/work-items/relationships.mock.html` — the readiness-banner design source\n\n' +
          '**Resolution (PR #250, merged).** Dropped the `blockedBy.length > 0` precondition from ' +
          'BOTH call-site gates, keeping only the `category` todo guard: `RelationshipsPanel`’s ' +
          "`showReadiness` is now just `currentCategory === 'todo'`, and `IssueQuickViewContent` " +
          'always builds the `readiness` verdict (the quick-view panel still suppresses it past ' +
          '`todo` via `statusCategory`). No service / DTO / badge change — exactly as diagnosed. ' +
          'Regression coverage added: `relationships-panel.test.tsx` + `issue-quick-view.test.tsx` ' +
          'assert a no-blocker todo item renders "Ready to start" on both surfaces, and ' +
          '`issue-detail-flow.spec.ts` (E2E) asserts a fresh item reads "Ready to start" before ' +
          'any link is added, then flips to "Blocked".',
      },
      {
        id: 'bug-inline-edit-clipped-when-table-short',
        kind: 'bug',
        title:
          'Issue list: inline cell-edit pickers are clipped / unusable when the table is shorter than the picker',
        status: 'planned',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 2 · **Discovered in:** Story 2.5 (issue list — inline ' +
          'status/assignee/priority editing, subtask 2.5.5) · **Status:** open · **Reported by:** Yue.\n\n' +
          'On the project issue list (e.g. `/issues` in the seeded `moooon` / `prodect` tenant, or ' +
          'the screenshot repro on a `test` project with one row `TEST-3`), clicking an **inline ' +
          'editable cell** (status / assignee / priority) opens its picker popover, but **the ' +
          'picker is clipped by the table container when the table is not tall enough to hold it**. ' +
          'The screenshot shows the Priority picker (Highest / High / Medium ✓ / Low / Lowest) opened ' +
          "on `TEST-3`, the only row in the list — the popover spills below the table's rendered " +
          'box and is cut off / unscrollable / unclickable past the visible area. The same surface ' +
          "works fine when the table is tall (many rows push the table's rendered height past the " +
          "picker's height, so the popover has room to land).\n\n" +
          '**Repro:** sign in as `zhuyue@prodect.co` / `!QAZ1qaz`, create a small workspace+project ' +
          'with **one** work item (or open any project that today renders a single-row list). On ' +
          "`/issues` open the picker on the row's status / assignee / priority cell. Observe the " +
          "picker visibly cuts off at the table's bottom edge — options below the cut are not " +
          "clickable. Add more rows until the table grows past the picker's height; the picker " +
          'now renders fully and the bug disappears.\n\n' +
          '**Root cause (hypothesis to verify in the fix Subtask).** The list / tree table wrapper ' +
          'almost certainly carries an `overflow-hidden` (or `overflow-auto` / `overflow-x-auto`) ' +
          "on a container that establishes the picker popover's containing block — `Popover` / " +
          "`Combobox` / picker primitives that don't render into a portal are clipped by any " +
          'ancestor with `overflow != visible`. The fix is either (a) **portal the picker** out of ' +
          'the table (the standard Radix / shadcn pattern — render into `document.body` via a ' +
          "portal so the popover escapes the table's clip region), or (b) **drop the clip on the " +
          "table container** if portal isn't available. Either way it's a contained component-" +
          'layer fix; no service or DTO change. Verify the picker is also keyboard-accessible after ' +
          "the fix (Esc dismisses, arrow keys traverse) and that the table's own " +
          "overflow-x scroll for wide column tracks isn't regressed.\n\n" +
          '## Acceptance criteria\n\n' +
          '- On the issue list (`/issues`) with a **single-row** (or otherwise short) table, ' +
          'opening any inline picker — status, assignee, **priority** (the repro), or any other ' +
          'inline-editable cell — renders the picker **fully visible** and **fully interactive**: ' +
          "every option is clickable; the bottom of the picker is not clipped by the table's box.\n" +
          '- Same behaviour holds on the Tree view AND the List view (and any other view variants ' +
          '2.5 ships).\n' +
          '- Existing wide-column horizontal scroll on the table is unchanged (guard against ' +
          'regression: opening a picker on a row off-screen to the right still positions over the ' +
          "cell, not under the scroll container's clip).\n" +
          '- Keyboard navigation works post-fix: Esc dismisses, arrow keys move between options, ' +
          'Enter commits.\n' +
          '- A Playwright regression in `tests/e2e/issue-list-flow.spec.ts` (or a sibling) opens ' +
          "an inline picker on a **single-row** project list and asserts the picker's rendered " +
          'bounding box is fully inside the viewport AND that every option is clickable (mirror the ' +
          'measurement posture of `bug-tree-header-misalignment` and the swimlane bugs — measure ' +
          'rendered geometry, not CSS rules).\n\n' +
          '## Context refs\n\n' +
          '- `app/(authed)/issues/_components/IssueListPage.tsx` (or wherever 2.5.3 / 2.5.8 mount ' +
          'the list + tree views) — the table container that establishes the clipping region\n' +
          '- The 2.5.5 inline-edit cell components (status / assignee pickers) AND the priority ' +
          "picker that 2.5's extension subtasks added — the popover render sites\n" +
          '- `components/ui/Popover` / `components/ui/Combobox` (or whichever popover primitive the ' +
          'inline pickers compose from) — if portal support exists, the fix is flipping it on; if ' +
          'not, the primitive needs a `portalled` prop\n' +
          '- `bug-tree-header-misalignment` (sibling Epic-2 bug, same Story 2.5 surface, similar ' +
          'measurement-based regression test posture)',
      },
      {
        id: 'bug-issue-list-not-refreshed-after-create',
        kind: 'bug',
        title: 'Issue list / tree does not update after creating a new work item via the modal',
        status: 'planned',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 2 · **Discovered in:** Story 2.5 (issue list, ' +
          'subtask 2.5.3 — the page wiring) crossed with Story 2.3 (the `CreateIssueModal` from ' +
          '2.3.3, which 2.5\'s "New issue" toolbar trigger reuses) · **Status:** open · ' +
          '**Reported by:** Yue.\n\n' +
          'On the project issue list (`/issues`), after the user clicks **+ New work item** ' +
          '(top-right of the Work Items page in the repro), fills out `CreateIssueModal`, and ' +
          'submits, the newly-created work item **does not appear in the list / tree** until the ' +
          'user manually refreshes the page. The create-service obviously succeeds (the row exists ' +
          "on reload), but the list view's rendered data is stale — the projection that " +
          '`getProjectTree` (2.5.1) feeds `IssueTreeTable` / list view is not invalidated when the ' +
          'modal commits a new issue.\n\n' +
          '**Repro:** sign in as `zhuyue@prodect.co` / `!QAZ1qaz`, open any project → `/issues` ' +
          '(or the repro `test` project shown in the screenshot, which had a single row `TEST-3`). ' +
          'Click **+ New work item**, fill the modal (any title, any kind), submit. The modal ' +
          'closes successfully but the table still shows only the pre-existing rows; reload the ' +
          'page and the new row appears. Same gap whether the user lands in the Tree view or the ' +
          'List view.\n\n' +
          '**Root cause (hypothesis to verify in the fix Subtask).** The `/issues` page is a Server ' +
          'Component that data-fetches from `getProjectTree` at request time. ' +
          "`CreateIssueModal`'s success path almost certainly does ONE of: (a) close the modal " +
          'without invalidating any cache (the bug shape), (b) `router.refresh()` only when ' +
          'mounted from a specific context (e.g. the detail page tree but not the issue-list ' +
          'toolbar trigger), or (c) `revalidatePath` against a narrower path than `/issues`. The ' +
          "fix is to make the modal's success callback unconditionally invalidate the list — " +
          "either via `router.refresh()` in the trigger's success handler on `/issues`, or by " +
          "extending the create service's `revalidatePath` set to include the project's " +
          '`/issues` route. Contrast the 2.5.5 inline-edit path, which already `revalidatePath`s ' +
          'after commit (per the 2.5.5 description: "Commit is optimistic + revalidates the list") ' +
          "— that's the correct shape, the create path needs to mirror it. Also worth verifying: " +
          'creating a CHILD work item from inside the tree (Story 2.4.x) refreshes correctly, so ' +
          'the bug may be specifically the toolbar `+ New work item` entry point on the list ' +
          'page.\n\n' +
          '## Acceptance criteria\n\n' +
          '- After submitting `CreateIssueModal` from the `/issues` toolbar `+ New work item` ' +
          'trigger, the new row appears in the list / tree **without a manual page reload**.\n' +
          '- Same behaviour in BOTH the Tree view and the List view (and any other 2.5 view ' +
          'variants).\n' +
          '- The newly-created item appears at the correct position per the active sort + filters ' +
          '(if filters exclude it, it correctly does NOT appear — the bug is staleness, not sort/' +
          'filter wiring).\n' +
          '- Creating a child work item from inside the tree (e.g. via the row-context create ' +
          'affordance from Story 2.4) continues to refresh correctly (guard against regression).\n' +
          '- Creating a work item from any OTHER entry point that feeds back into the same list ' +
          '(detail page → "Add child", board → "Add card", etc.) continues to refresh its origin ' +
          'list correctly.\n' +
          '- A Playwright regression in `tests/e2e/issue-list-flow.spec.ts` (or a sibling) creates ' +
          'an issue via the `/issues` toolbar and asserts the new row appears in the list before ' +
          'any reload (poll the table for the new title with a tight timeout; do NOT call ' +
          '`page.reload()`).\n\n' +
          '## Context refs\n\n' +
          '- `app/(authed)/issues/page.tsx` + `IssueListPage.tsx` (or wherever 2.5.3 mounts the ' +
          'toolbar trigger) — the page that needs to revalidate after create\n' +
          '- 2.3.3 `CreateIssueModal` / `CreateIssueProvider` / `CreateIssueTrigger` — the modal + ' +
          'success-callback surface\n' +
          '- `workItemsService.createWorkItem` (or whichever service the modal POSTs to) — the ' +
          "`revalidatePath` set on success (likely needs `/issues` added if it isn't there)\n" +
          '- 2.5.5 (inline edit) — the working precedent: "Commit is optimistic + revalidates the ' +
          'list" — same shape the create path needs to mirror\n' +
          '- 2.5.1 `getProjectTree` — the projection the list view reads; the cache it sits behind ' +
          'is what must be invalidated\n' +
          '- `bug-tree-header-misalignment` / `bug-inline-edit-clipped-when-table-short` (sibling ' +
          'Epic-2 list-surface bugs)',
      },
    ],
  },
  {
    id: '3',
    title: 'Boards',
    status: 'done',
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
        status: 'done',
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
        status: 'done',
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
      {
        id: 'bug-swimlane-collapsed-lane-header-not-full-width',
        kind: 'bug',
        title:
          'Swimlane lane-header band is NOT full track width when the lane is COLLAPSED — same shape as the prior `bug-swimlane-lane-header-not-spanning-scrolled-columns`, but only the expanded state was covered',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 3 · **Surfaces:** swimlane board (Subtask 3.3.5 — ' +
          '`SwimlaneBoard.tsx`) · **Status:** open · **Reported by:** Yue · **Sibling of:** ' +
          '`bug-swimlane-lane-header-not-spanning-scrolled-columns` (this is the SECOND occurrence ' +
          'of the same shape — collapsed-state was not covered by the prior fix).\n\n' +
          'On the `/boards` swimlane view (group-by Assignee / Priority / Epic), when a lane is ' +
          '**collapsed** (chevron pointing right, body hidden) the lane-header band does NOT span ' +
          'the full column track — it shrinks to roughly the width of the inline header content ' +
          '(chevron + label + count badge), leaving the rightmost columns visually outside the ' +
          'band. The same lane in its **expanded** state paints the band across the full track ' +
          'correctly (that case was fixed by the prior bug). Asymmetry between expanded and ' +
          'collapsed visual shape is the giveaway.\n\n' +
          '**Repro:** sign in as `zhuyue@prodect.co` / `!QAZ1qaz`, open the `moooon` / `prodect` ' +
          'project → `/boards`, switch group-by to anything other than `none` (Epic recommended — ' +
          'matches the original repro screenshot). Click a lane header to collapse it. Observe ' +
          "that the collapsed lane's gray band stops well short of the rightmost column (in the " +
          'default workflow, the band visibly ends around `In Review` or earlier — `Done` and ' +
          '`Cancelled` sit OUTSIDE the band). Expand the same lane and the band paints full-width ' +
          'as intended.\n\n' +
          '**Root cause (hypothesis to verify in the fix Subtask).** In ' +
          '`app/(authed)/boards/_components/SwimlaneBoard.tsx`, the prior fix landed `min-w-max` ' +
          'on the **lane-row wrapper** (the outer `<div data-testid={swimlane-${lane.key}}>`), so ' +
          'the wrapper grows to its `max-content` width. That `max-content` is established by the ' +
          'child cell-row (`${track}` flex row of `w-72` `LaneCell`s over `columns.map(...)`) — ' +
          'but the cell-row only renders inside the `!isCollapsed` ternary branch. Collapsing ' +
          "removes the width-establishing child, so the wrapper's `max-content` drops to the " +
          'header-only inline width (chevron + label + count), and `min-w-max` resolves against ' +
          'that smaller value. Net: the band paints behind a narrower wrapper, columns sit ' +
          "outside it. The prior fix's comment at SwimlaneBoard.tsx:122-126 named this exact " +
          'risk for the EXPANDED case ("the lane-header band collapses to the scroller\'s ' +
          'clientWidth and stops at the viewport edge") but did not notice that collapsing pulls ' +
          'out the width source.\n\n' +
          '**Fix shapes (decide at fix time — NOT prescriptive; trade-offs to weigh):**\n' +
          '1. **Render an invisible width-establishing track row OUTSIDE the `!isCollapsed` ' +
          'ternary** — e.g. a zero-height `${track} h-0 pointer-events-none invisible` row of ' +
          "`w-72 shrink-0` spacer cells. Keeps the wrapper's `max-content` at full track width " +
          'regardless of collapsed state. Lowest disruption to the existing sticky-stacking + ' +
          'click semantics; cost is one extra DOM row per lane.\n' +
          '2. **Move `min-w-max` off the wrapper and onto an explicit-width band element**, ' +
          'driven from the `columns` array (`width: columns.length * 288 + (columns.length - 1) ' +
          '* 14 + 48` — the same shape the `track` class encodes). Removes the dependency on a ' +
          'width-establishing child entirely; cost is keeping the explicit-width formula in sync ' +
          "with the `track` class's `w-72 gap-3.5 px-6`.\n" +
          '3. **Always render the cell-row track, hide it with `visibility: hidden h-0` when ' +
          'collapsed** — simplest diff. (NOT `display: none`, which would remove the element from ' +
          'layout entirely and collapse back to the original bug.) Functionally equivalent to ' +
          'option 1.\n' +
          'Each option leaves the sticky-pinned label content (`sticky left-6 z-[2]`) ' +
          "untouched — only the band's width source changes.\n\n" +
          '**Test gap that let it ship.** The existing swimlane render tests ' +
          '(`tests/components/board-swimlanes-render.test.tsx`, `board-swimlanes.test.ts`) ' +
          'likely assert the band-spans-track shape only in the default (expanded) state. The ' +
          'fix MUST add a collapsed-state assertion: toggle collapse on a lane, measure the ' +
          "header band's `offsetWidth` (or computed style), and assert it equals the " +
          "column-track's intrinsic width — not the viewport width, not the header-content " +
          'width. Same measurement posture as the `bug-tree-header-misalignment` and prior ' +
          '`bug-swimlane-lane-header-not-spanning-scrolled-columns` fixes (measure rendered ' +
          'width via `getBoundingClientRect`, not CSS rules).\n\n' +
          '## Acceptance criteria\n\n' +
          '- On a swimlane-grouped board, the lane-header band paints across the **full column ' +
          'track** when the lane is **collapsed** (chevron right) — including columns beyond ' +
          'the viewport edge.\n' +
          '- The same lane, **expanded** (chevron down), continues to paint the band full-width ' +
          '(guard against regression of the prior fix).\n' +
          "- Collapsing / expanding a lane does NOT change the band's rendered width — only the " +
          'cell-row visibility.\n' +
          '- The sticky-pinned label + chevron + count behaviour is unchanged (label still ' +
          'sticks to the left edge as the user scrolls horizontally).\n' +
          '- The catch-all lane (`bg-(--el-muted)`) and named lanes (`bg-(--el-surface-soft)`) ' +
          'both render the band full-width in BOTH collapsed and expanded states.\n' +
          '- A render-test regression in `tests/components/board-swimlanes-render.test.tsx` ' +
          'asserts the collapsed-lane band width equals the column-track width (measure ' +
          "`offsetWidth`/`getBoundingClientRect`, not CSS rules) — mirrors the prior fix's test " +
          'posture.\n\n' +
          '## Context refs\n\n' +
          '- `app/(authed)/boards/_components/SwimlaneBoard.tsx` lines ~119-188 — the lane-row ' +
          'wrapper, the `min-w-max` comment naming the prior bug, the header `<div role="button">`, ' +
          'and the `!isCollapsed` ternary that hides the width-establishing cell-row\n' +
          '- `bug-swimlane-lane-header-not-spanning-scrolled-columns` (sibling Epic-3 bug, same ' +
          'shape, expanded-state-only) — the precedent fix this one extends\n' +
          '- `PRODECT_FINDINGS.md` #61 — the planner-side finding entry that surfaced this bug\n' +
          '- `tests/components/board-swimlanes-render.test.tsx` — where the missing collapsed-' +
          'state assertion belongs\n' +
          '- `prodect-core/CLAUDE.md` — colour via `--el-*`, shape via element-shape tokens ' +
          '(applies to whatever new wrapper the fix introduces)\n\n' +
          '**Refactor signal (rule of three):** this is the SECOND occurrence of `min-w-max` ' +
          'open-coded on a swimlane row producing a width-establishment bug. If a third ' +
          'occurrence surfaces, extract a shared `TrackRow` (or `useTrackWidth`) primitive ' +
          'rather than open-coding `min-w-max` per row. Not yet — fix this one in place, but ' +
          'note the pattern for the next time.',
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
      'makes Prodect AI-native on top of that.\n\n' +
      '**Story 7.0 ships early (justified deviation from linear epic order).** The AI dispatch ' +
      'surface — the `/ready` page + `GET /api/ready` + `POST /api/ready/next` — is the BYOK ' +
      "agent contract today and the future native AI-coding layer's contract tomorrow. It has no " +
      'forward-pointing cross-epic dep (consumes only Epic-2 readiness primitives) and is ' +
      'independently useful before any AI planning ships, so we pull it in front of the ' +
      'remaining Epic-6 stubs rather than waiting. Full justification + the front-half/back-' +
      'half split with stub 7.5 lives in story-7.0.ts. (notes.html #32 — the cross-epic dep ' +
      'audit passes; this is a deliberate deviation, not the mistake the rule guards against.)',
  },
  {
    id: '8',
    title: 'Launch readiness',
    status: 'planned',
    descriptionMd:
      'Everything between "feature complete" and "live, paid users." Stripe billing, marketing ' +
      'site + the nifer brand mark, go-to-market strategy, the one-time Prodect → nifer rebrand ' +
      'cutover, ToS + privacy policy, transactional email, basic analytics, production deploy, ' +
      'domain + SSL, onboarding, and day-1 admin tools. Most of this is human subtasks ' +
      "running through Prodect's own queue. (Formerly Epic 5.)",
  },
];
