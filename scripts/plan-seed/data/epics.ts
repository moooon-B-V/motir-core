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
        title: 'Set up CLA Assistant + commit Apache ICLA on motir-core',
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
          'ICLA grants Motir Inc. a broad license to the contribution; the contributor retains ' +
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
          '(2) Authorize CLA Assistant on `moooon-B-V/motir-core` (motir-ai is private and ' +
          "won't have outside contributors — skip it). (3) Paste the Apache ICLA text " +
          '(https://www.apache.org/licenses/icla.pdf — convert to plain text), modified to name ' +
          '**"Motir Inc."** as the receiving party in §1. Save. CLA Assistant now hooks every ' +
          'PR on motir-core: it comments asking outside contributors to sign, and adds a ' +
          'required status check that turns green only once signed. (4) On a `seed/cla-setup` ' +
          'branch in motir-core, commit **`motir-core/CLA.md`** (the Apache ICLA text + a ' +
          "short preamble naming Motir Inc. and linking to CLA Assistant's signing flow) AND " +
          'either create `motir-core/CONTRIBUTING.md` or amend the existing one with a short ' +
          'paragraph: *"By opening a PR, you\'ll be asked to sign our CLA via CLA Assistant. This ' +
          "grants us the rights we need to maintain the project's open-source license and to " +
          'potentially relicense the codebase in the future. You retain copyright of your ' +
          'contribution."* Open + merge that PR (the `seed/*` prefix skips E2E + Vercel preview ' +
          'per MOTIR.md § Plan seed). (5) Open a throwaway PR from a second GitHub account ' +
          '(or any account without a signed CLA on file); confirm the bot comments + the status ' +
          'check appears red until signed. Close the throwaway PR. (6) Record the throwaway PR ' +
          "URL in the seed PR's body as the verification artifact (so future-me can audit that " +
          'the gate is live).\n\n' +
          '## Acceptance criteria\n\n' +
          '- CLA Assistant is installed and active on `moooon-B-V/motir-core` (visible in the ' +
          "repo's installed-apps list and in CLA Assistant's dashboard).\n" +
          '- `motir-core/CLA.md` exists at repo root, contains Apache ICLA text adapted to ' +
          'name Motir Inc. as the receiving party.\n' +
          '- `motir-core/CONTRIBUTING.md` carries a paragraph naming the CLA requirement and ' +
          'pointing contributors at the signing flow.\n' +
          '- A throwaway PR from an unsigned account demonstrates the bot comments + the ' +
          'required status check, recorded in the seed PR body.\n' +
          '- This task flips to `done` only on user confirmation that steps 1–5 are complete ' +
          '(mirrors 1.6.7 — manual SaaS provisioning, no PR-of-code to gate on).\n\n' +
          '## Context refs\n\n' +
          '- `MOTIR.md` § Source of truth (open-core architecture paragraph) — names the ' +
          'GPL-3.0 / closed-source `motir-ai` split this CLA underwrites.\n' +
          '- `notes.html` mistake #17 — open-core is an architectural shift, not a license toggle; ' +
          'the CLA is the legal half of that architecture.\n' +
          '- Apache ICLA template: https://www.apache.org/licenses/icla.pdf\n' +
          '- CLA Assistant: https://cla-assistant.io\n' +
          '- Related: a follow-up task to land MOTIR.md "License boundary" + "Fork posture" ' +
          'doc edits (from the same legal-posture conversation) is out of scope here — separate ' +
          '`seed/*` PR against motir-meta. The trademark filing (~$500, ~12 months) is ALSO ' +
          'out of scope and tracked as a finding rather than a planned task (it has no software ' +
          'artifact and no dependency on the seed).',
        explanationMd:
          'The CLA is the legal floor under the open-core moat. The license boundary rule ' +
          '(`motir-core` GPL-3.0 calling `motir-ai` closed over HTTP) survives only if ' +
          'Motir Inc. retains enough rights over `motir-core` to relicense if the open-core ' +
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
      'The irreducible Jira core — the first epic of the PM substrate that makes Motir a usable ' +
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
          '**Resolution (motir-core `4bc4463`):** the `/settings/project` page now renders a ' +
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
          'Issue list: inline cell-edit pickers are clipped / unusable when the table is short',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 2 · **Surfaces:** issue list (Story 2.5 — List + Tree ' +
          'views, inline cell editing from Subtask 2.5.5) · **Status:** in progress · **Reported ' +
          'by:** Yue.\n\n' +
          'On the project issue list at `/issues`, clicking a cell to edit it inline (the ' +
          '**status / assignee / priority** pickers) opens a dropdown that is **clipped and ' +
          'unusable when the table is shorter than the open picker** — i.e. when the list has only ' +
          'a few rows. The dropdown opens downward past the bottom of the (short) table card and ' +
          'is cut off, so only the first option or two are reachable. On a near-empty list the ' +
          'inline editor is effectively unusable.\n\n' +
          '**Repro:** sign in as `zhuyue@prodect.co` / `!QAZ1qaz`, open a project whose `/issues` ' +
          'list has just a few rows (or filter down to a few), switch to List or Tree view, and ' +
          'click a Status / Assignee / Priority cell to edit it inline. The picker menu is clipped ' +
          "at the table's bottom edge instead of overlaying the page.\n\n" +
          '**Root cause.** `components/ui/Combobox.tsx` (the picker primitive) rendered its menu ' +
          'as `position: absolute` inside the trigger’s `relative` container — **not portaled**. ' +
          'The List/Tree table cards wrap their rows in `overflow-hidden` to clip the rounded card ' +
          'corners (`IssueListTable.tsx`, `TreeTable.tsx`). A short list = a short card, so the ' +
          'downward-opening menu extends past the card’s bottom border and `overflow-hidden` ' +
          'clips it. (The listbox’s own `max-h-64` is NOT the cause — the clip is the table ' +
          'card’s overflow, confirmed by a browser repro.) `DatePicker` never had this bug ' +
          'because it opens through the Radix Popover **portal**.\n\n' +
          '**Fix.** Render the Combobox menu via `createPortal` to `document.body` with ' +
          'viewport-anchored `position: fixed` (anchored to the trigger rect, re-computed on open ' +
          '/ ancestor-scroll / resize), flipping above the trigger when there is more room there ' +
          'and capping the listbox height to the available viewport space. This escapes **every** ' +
          'overflow ancestor — fixing the latent clip for all Combobox consumers, not just the ' +
          'issue list (the same approach `DatePicker` already takes). WAI-ARIA combobox/listbox ' +
          'semantics, keyboard nav, focus return, and `onClose` are unchanged; click-outside also ' +
          'treats the portaled menu as "inside" so an option click still commits.\n\n' +
          '## Acceptance criteria\n\n' +
          '- On a short `/issues` list (few rows), opening a Status / Assignee / Priority inline ' +
          'picker shows the **full** option menu — no clipping at the table card edge.\n' +
          '- The picker menu overlays the page (portaled), opening downward by default and ' +
          'flipping above the trigger when there is insufficient room below; it never runs ' +
          'off-screen (height capped, scrolls internally if needed).\n' +
          '- Selecting an option still commits the edit; Escape / click-outside still close and ' +
          'return focus to the trigger; keyboard navigation and ARIA are unchanged.\n' +
          '- The fix is in the shared `Combobox` primitive, so every consumer benefits; no ' +
          'regression in the other Combobox usages (TypePicker / ParentPicker / filter bar / ' +
          'board column menu / settings).\n' +
          '- A regression test asserts the open menu is portaled out of an `overflow-hidden` ' +
          'ancestor (`position: fixed`) and that a click inside the portaled menu still commits.\n\n' +
          '## Context refs\n\n' +
          '- `components/ui/Combobox.tsx` — the picker primitive (the fix site)\n' +
          '- `app/(authed)/issues/_components/IssueInlineEdit.tsx` — the inline-edit cell editors ' +
          'that mount the pickers `autoOpen`\n' +
          '- `app/(authed)/issues/_components/IssueListTable.tsx`, `components/ui/TreeTable.tsx` — ' +
          'the `overflow-hidden` table cards that clip the menu\n' +
          '- `components/ui/DatePicker.tsx` / `components/ui/Popover.tsx` — the portal pattern ' +
          'this fix mirrors\n' +
          '- `tests/components/combobox-portal.test.tsx` — the regression test\n\n' +
          '**Resolution (PR #444 feature, #445 plan, both merged).** TWO root causes on the inline ' +
          'editors, fixed together: (1) **Combobox menu (status / assignee / priority)** was ' +
          '`position:absolute` inside the trigger, so the List/Tree table cards’ `overflow:hidden` ' +
          'clipped it on a short table — now portaled to `document.body` with viewport-anchored ' +
          '`position:fixed` + flip, EXCEPT when inside a focus-trapping `[role="dialog"]` (the ' +
          'create-issue modal), where it renders inline (a portaled menu fought the dialog’s focus ' +
          'trap — caught by E2E and fixed). (2) **Due field (`DatePicker`)** — its calendar was ' +
          'already a portaled Popover (never clipped), but its anchor input defaulted to ' +
          '`--height-input` (44px), taller than the Tree view’s 40px rows (`TreeTable` ROW_PX), so ' +
          'on the last row it overflowed and was clipped; now rendered at `--height-control` (36px), ' +
          'matching the sibling inline editors and fitting both row heights. Regression tests: ' +
          '`tests/components/combobox-portal.test.tsx` (portaled-out + inline-in-dialog) and the ' +
          'inline Due assertion in `tests/components/issue-inline-edit.test.tsx`. Verified in a real ' +
          'browser; full CI (incl. Playwright E2E) green.\n\n' +
          '**Note:** this card consolidates a duplicate filing of the same bug that a parallel ' +
          'session had added under Epic 4 (`status: planned`) — the Epic-4 duplicate is removed in ' +
          'this same PR. List-surface bugs are parented to Epic 2 here, matching the ' +
          '`bug-tree-header-misalignment` / `bug-ready-banner-no-deps` precedent. The Epic-4 ' +
          'filing’s unique repro (single-row `TEST-3`, Priority picker clipped below the table) is ' +
          'the same defect captured above.',
      },
      {
        id: 'bug-inline-status-revert-on-second-edit',
        kind: 'bug',
        title:
          "Issue list: inline status edit — the first item's status sometimes reverts after editing a second item",
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 2 · **Surface:** issue list inline cell editing ' +
          '(Story 2.5, Subtask 2.5.5 — the status / assignee / priority editors) · **Reported ' +
          'by:** Yue, 2026-06-10.\n\n' +
          'Change the **status** of work item A inline on `/issues`, then change the status of a ' +
          "second work item B — **intermittently, A's status flips back to its previous value** " +
          'after the second edit. "Sometimes": it does not reproduce on every attempt; editing ' +
          'the two items in quick succession appears to raise the hit rate, which smells like a ' +
          'timing race rather than a deterministic logic error.\n\n' +
          '**Repro (intermittent):** sign in as `zhuyue@prodect.co` / `!QAZ1qaz`, open `/issues` ' +
          "in List view, inline-edit item A's Status cell (e.g. To do → In progress), then " +
          "promptly inline-edit item B's Status cell. Watch A's cell after B's edit settles — " +
          'on a hit, A renders its OLD status again.\n\n' +
          '**Scoped to DISPLAY-ONLY (Yue, 2026-06-10): the backend is correct.** Yue verified ' +
          "the API persists the update — A's row holds the NEW status in the database while the " +
          'list renders the OLD one. So this is a client-side stale-display race in the list ' +
          'UI, not a lost write: no data corruption, but trust-breaking (the user is shown ' +
          'state the system knows is wrong, until the next reload).\n\n' +
          '**⚠️ Client mechanism NOT diagnosed — failing repro test FIRST (the ' +
          'reproduce-before-diagnosing rule; the filter check-mark lesson).** This card records ' +
          'the SYMPTOM plus the backend-correct scoping above; WHICH client interleaving causes ' +
          'the stale render has not been verified, and the fix MUST begin with a red repro ' +
          'test — not a code-reading theory. The test still asserts the DB row alongside the ' +
          'cell (locking in the backend-correct fact and catching any regression to a lost ' +
          'write), but the red assertion is the rendered cell.\n\n' +
          '**Investigation surface (hypotheses to test, NOT conclusions).** Each inline cell ' +
          'editor in `IssueInlineEdit.tsx` keeps a local optimistic `override` and calls ' +
          '`router.refresh()` after its PATCH resolves. Two rapid edits put two PATCHes + two ' +
          "refreshes in flight: candidate mechanisms include (a) B's refresh payload being " +
          "read/snapshotted before A's write is visible and re-rendering A from stale server " +
          "props after A's `override` is gone, (b) refresh responses resolving out of order, " +
          '(c) the `override` being cleared by ANY refresh completion rather than its own. A ' +
          'deterministic repro can interleave these orderings — component/integration test with ' +
          'controlled response ordering, or Playwright with route interception delaying the ' +
          'first PATCH/refresh. Also check whether the detail-page status control and the board ' +
          'column-menu transition share the pattern (fix once in the shared mechanic if so).\n\n' +
          '## Acceptance criteria\n\n' +
          '- A repro test exists that is RED on the pre-fix code (two rapid inline status edits ' +
          'with adversarial response ordering → the first cell renders the old status) and ' +
          'green after; it asserts the rendered cell, and confirms the DB row holds the new ' +
          'status throughout (the backend-correct fact, locked in against regression).\n' +
          "- After the fix, A's cell shows its new status across B's edit and every refresh " +
          'ordering — the rendered list converges to the persisted state without a manual ' +
          'reload.\n' +
          '- The fix covers all three inline editors sharing the mechanic (status / assignee / ' +
          'priority) — asserted for at least status + assignee — and any other surface found to ' +
          'share it during investigation.\n' +
          '- Single-edit behavior unchanged: the existing inline-edit tests stay green.\n\n' +
          '## Context refs\n\n' +
          '- `app/(authed)/issues/_components/IssueInlineEdit.tsx` — the per-cell `override` + ' +
          '`router.refresh()` mechanic (lines ~95-200)\n' +
          '- `app/(authed)/issues/_components/issueColumns.tsx`, `IssueListTable.tsx` — how ' +
          'server props flow back into the cells\n' +
          '- `lib/services/workItemsService.ts` (`updateStatus`) — the persisted-state side the ' +
          'repro test must assert\n' +
          '- `tests/components/issue-inline-edit.test.tsx` — the existing suite the repro ' +
          'extends\n' +
          '- notes.html (reproduce-before-diagnosing; the twice-wrong filter check-mark bug)\n\n' +
          '## Re-opened (Yue, 2026-06-10) — PR #619 did not fix it\n\n' +
          'The merged fix (`useConvergingOverride`, PR #619) defended each cell against stale ' +
          'full-tree payloads but KEPT the refresh fan-out that creates them — ' +
          "`revalidatePath('/issues')` in the field actions plus `router.refresh()` per cell " +
          'put up to four whole-page RSC snapshots in flight for two quick edits, and the ' +
          'defense only lives in mounted component state. Yue verified the revert still ' +
          'happens in the live app and set the correct contract: **a successful action ' +
          'response IS the confirmation** — call the endpoint, confirm the optimistic value ' +
          'when it returns, no whole-tree refresh on success. Re-fix in PR #640: actions no ' +
          'longer revalidate, cells no longer refresh on success (only the optimistic-' +
          'concurrency STALE conflict still refreshes), so there are no payloads left to ' +
          'race. The detail page `CoreFieldsPanel` shares the refresh-on-success mechanic ' +
          'but is owned by open PR #633 — logged as a finding (#79) for a follow-up, not ' +
          'touched in #640.\n\n' +
          '**Closed (2026-06-11): PR #640 merged.** Full CI green including the inline-edit ' +
          'E2E. The PR also fixed a consequence the first commit introduced and the E2E ' +
          'caught: with no refresh, server props freeze, so a follow-up edit on the same row ' +
          'submitted a dead `expectedUpdatedAt` — the provider now keeps a per-row ledger of ' +
          'server-acknowledged `updatedAt` values and submissions send max(ledger, prop). ' +
          'Regression tests cover same-cell (reassign → unassign) and cross-cell (status → ' +
          'assignee) follow-ups against the real service.',
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
          '- A short note in `motir-core/CLAUDE.md` (migration conventions) records the decision ' +
          'so the pattern is not reintroduced.\n\n' +
          '## Context refs\n\n' +
          '- `prisma/schema.prisma` — the `Attachment` model (`uploaderUserId` scalar, no relation) ' +
          '+ the `User` model\n' +
          '- `prisma/migrations/20260603120000_add_attachment_and_rls/migration.sql` — where the FK ' +
          'is created in raw SQL (Story 2.3.7)\n' +
          '- 3.3.2 feature PR — the curated migration whose header documents this drift; ' +
          '`motir-core/CLAUDE.md` — migration conventions',
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
          '- `motir-core/CLAUDE.md` — colour via `--el-*`, shape via element-shape tokens ' +
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
          '- `motir-core/CLAUDE.md` — colour via `--el-*`, shape via element-shape tokens ' +
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
    status: 'done',
    descriptionMd:
      'Sprint-based delivery on top of the issue tracker: the **backlog**, **sprints** (create / ' +
      'start / complete), **story-point estimation**, the **Scrum board** (the Epic-3 Kanban ' +
      "surface scoped to a board's active sprint, under a sprint header — Story 4.5, moved here " +
      'from Epic 3 per mistake #32 so it ships alongside the sprints it depends on), and the ' +
      'velocity + burndown charts that make iteration measurable. Turns Motir from an issue ' +
      'tracker into a full agile-planning tool — the Scrum half of the Jira feature set, with ' +
      'the Scrum view sitting on the same board substrate Epic 3 already shipped.',
    items: [
      {
        id: 'bug-backlog-zh-sprint-translated-as-chongci',
        kind: 'bug',
        title:
          'Backlog (zh): "Sprint" inconsistently localized to 冲刺 — should stay Latin "Sprint"',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 4 (Agile planning) · **Surface:** the backlog ' +
          '(Story 4.2) + estimation settings (Story 4.3) i18n catalog · **Locale:** `zh` ' +
          '(Simplified Chinese) · **Reported by:** Yue.\n\n' +
          'In the `zh` catalog the product term **Sprint** was rendered as **冲刺** in 6 keys, ' +
          'while the rest of the backlog/estimation surface (~30 keys — the page subtitle, the ' +
          'sprint error states, the entire start-sprint flow, create / collapse / expand sprint, ' +
          'the DnD instructions, …) already keeps it Latin **Sprint**. A single product term was ' +
          'split two ways inside one surface — the kind of inconsistency a native SaaS UI never ' +
          'ships.\n\n' +
          '**Decision (locked zh glossary).** **Sprint stays Latin "Sprint"** everywhere, the ' +
          'same call already made for **Scrum** and **Kanban** (kept Latin; the methodology word ' +
          "看板 is reserved for the Kanban board TYPE). Mirror check: Atlassian's own zh build " +
          'keeps Sprint/Scrum/Kanban Latin in these contexts. CJK↔Latin spacing follows the ' +
          'convention already in the file (a space between a CJK char and the Latin word; no ' +
          'space against full-width punctuation 。，).\n\n' +
          'The 6 offending keys: `estimation.cardSubtitle`, `estimation.statisticHint`, ' +
          '`estimation.savedDesc`, `backlog.moveToSprint`, `backlog.noSprintsToMove`, ' +
          '`backlog.sprintPoints.emptyAria`.\n\n' +
          '## Acceptance criteria\n\n' +
          '- All 6 keys render Latin **Sprint** (no `冲刺` remains anywhere in `messages/zh.json`).\n' +
          '- Spacing matches the file convention (space between CJK and the Latin word; full-width ' +
          'punctuation hugs the word).\n' +
          '- The `en` catalog is untouched (byte-identical — tests/E2E assert English).\n' +
          '- `tests/i18n-catalog.test.ts` stays green (structural parity holds; no key added or ' +
          'removed) and `messages/zh.json` is Prettier-clean + valid JSON.\n\n' +
          '## Context refs\n\n' +
          '- `messages/zh.json` — the 6 keys above; `messages/en.json` for the source strings.\n' +
          '- `tests/i18n-catalog.test.ts` — the parity gate.\n' +
          '- Locked zh glossary (Scrum/Kanban/Sprint stay Latin; board → 面板, Kanban → 看板).\n\n' +
          '**Resolution:** fixed in `subtask/PROD-bug-zh-sprint-latin` (PR #502) — the 6 stray ' +
          '`冲刺` normalised to Latin `Sprint`; i18n-catalog parity + Prettier green.',
      },
      {
        id: 'bug-issue-list-not-refreshed-after-create',
        kind: 'bug',
        title: 'Issue list / tree does not update after creating a new work item via the modal',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 4 (current epic — discovered during Epic 4 work) · ' +
          '**Code surface owned by:** Story 2.5 (issue list, subtask 2.5.3 — the page wiring) ' +
          'crossed with Story 2.3 (the `CreateIssueModal` from 2.3.3, which 2.5\'s "New issue" ' +
          'toolbar trigger reuses) · **Status:** open · **Reported by:** Yue.\n\n' +
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
          '- `bug-inline-edit-clipped-when-table-short` (Epic-2 — the other list-surface ' +
          'bug filed in the same session); `bug-tree-header-misalignment` (Epic-2 — the precedent ' +
          'for filing list-surface bugs against the issue list).',
      },
      {
        id: 'bug-backlog-selection-bar-move-to-backlog-always-shown',
        kind: 'bug',
        title:
          'Backlog selection bar: "Move to backlog" button is shown even when every selected item is already in the backlog (should hide / disable)',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 4 (current epic — discovered during Epic 4 work) · ' +
          '**Code surface owned by:** Story 4.2 (Backlog UI), Subtask 4.2.5 — the selection bar + ' +
          'its bulk-action buttons · **Status:** open · **Reported by:** Yue.\n\n' +
          'On the `/backlog` page, selecting one or more rows reveals the **selection bar** with ' +
          'two bulk-move buttons: **Move to sprint ▸** and **Move to backlog**. The "Move to ' +
          'backlog" button is rendered **unconditionally** whenever `selectedIds.size > 0` — ' +
          'INCLUDING when every selected row is already in the backlog (`sprint_id IS NULL`). In ' +
          'that case the button is a no-op (moving backlog items "to the backlog" is meaningless), ' +
          "but it sits as an active-looking control on the bar. The Jira backlog (rung 1) doesn't " +
          'do this: its bulk-action set is contextual to where the selected items currently live. ' +
          'The user surfaced this in the backlog screenshot (four rows selected, all of them ' +
          'backlog items, and "移动到待办列表" still appears next to "移动到 Sprint").\n\n' +
          '**Repro:** sign in as `zhuyue@prodect.co` / `!QAZ1qaz`, open the `moooon` / `prodect` ' +
          'project → `/backlog`. The page mounts with several backlog rows below the sprint ' +
          'containers. Click one (or shift-click a range) of the BACKLOG rows — the selection bar ' +
          'appears at the top of the stack with `N selected` + `Move to sprint ▸` + ' +
          '`Move to backlog` + Clear. Observe that `Move to backlog` is enabled even though every ' +
          'selected row is already in the backlog. Clicking it dispatches a no-op bulk write ' +
          '(`bulkMoveToBacklog` with rows that already have `sprint_id IS NULL` — the service ' +
          'currently treats it as a guarded no-op, but the UI affordance still suggests an action ' +
          'is available).\n\n' +
          '**Root cause.** `app/(authed)/backlog/_components/SelectionBar.tsx` lines 61–68 render ' +
          'the `Move to backlog` button unconditionally — there is no check against the selected ' +
          "items' current sprint membership. The `useBacklogDnd()` hook (the coordinator that " +
          'owns `selectedIds`) does have the per-item sprint membership available (it has to, ' +
          'because that is what `bulkAssignToSprint` / `bulkMoveToBacklog` operate on). The bar ' +
          'just does not consult it.\n\n' +
          '**Fix shape (decide at fix time — both are defensible).**\n' +
          '1. **HIDE the button when every selected item is already in the backlog.** Most Jira-' +
          'faithful (Jira hides irrelevant bulk actions); cleanest visually. Symmetric counterpart ' +
          ': hide `Move to sprint ▸` when every selected item is already in the SAME sprint ' +
          '(can the same selection span multiple sprints? today yes, since the bar shows over a ' +
          'mixed selection; preserve that case).\n' +
          '2. **DISABLE the button** (greyed + `aria-disabled`) when every selected item is ' +
          'already in the backlog, with a tooltip explaining why. Slightly more discoverable than ' +
          'hiding, but adds a tooltip primitive call.\n' +
          'Either way, the gate reads the same: `someSelectedItemIsInASprint = ids.some(id => ' +
          'itemSprintIdById.get(id) != null)`. Plumb a `getSprintIdFor(id)` (or the existing ' +
          'item-by-id map) out of `useBacklogDnd()` to `SelectionBar`, derive the booleans, gate ' +
          'each button. No service / API change — purely a UI gate on existing state.\n\n' +
          '**Symmetric gap (in scope for the same fix).** Apply the mirror rule to `Move to sprint ' +
          '▸` too: if every selected item is already in the SAME sprint, hide/disable that button ' +
          '(submenu would only re-pick the same sprint, a no-op). The two gates are the same shape ' +
          'and ship together — leaving one untreated would be the same finding-#33 / mirror-product ' +
          'shortfall on the symmetric branch.\n\n' +
          '## Acceptance criteria\n\n' +
          '- When the selection bar is open and **every** selected item has `sprint_id IS NULL` ' +
          '(already in the backlog), the `Move to backlog` button is **hidden** (preferred) or ' +
          'visibly **disabled** with an explanatory tooltip.\n' +
          '- When the selection contains at least one item with `sprint_id IS NOT NULL` (i.e. ' +
          'currently in a sprint), the `Move to backlog` button remains visible + enabled and ' +
          'still moves that subset to the backlog (mixed selections behave as today).\n' +
          '- Symmetric: when **every** selected item is in the SAME sprint, the `Move to sprint ▸` ' +
          'button is hidden/disabled (re-picking the same sprint is a no-op).\n' +
          '- `Clear` and the `N selected` count are unaffected; the selection model and the ' +
          'multi-select drag path are unchanged.\n' +
          '- A component test asserts BOTH branches: (a) all-backlog selection → no `Move to ' +
          'backlog` button rendered; (b) mixed selection (≥1 sprint item + ≥1 backlog item) → both ' +
          'buttons rendered. Symmetric branch tested too: all-same-sprint selection → no `Move to ' +
          'sprint ▸` button.\n' +
          '- AA contrast / keyboard nav / focus return preserved; no change to ' +
          '`bulkAssignToSprint` / `bulkMoveToBacklog` service signatures.\n\n' +
          '## Context refs\n\n' +
          '- `app/(authed)/backlog/_components/SelectionBar.tsx` lines 61–68 — the unconditional ' +
          'render site (the fix site)\n' +
          '- `app/(authed)/backlog/_components/BacklogDndProvider.tsx` — the `useBacklogDnd` ' +
          'coordinator that owns `selectedIds` + the per-item sprint membership the gate needs; ' +
          'plumb a `getSprintIdFor(id)` (or expose the item-by-id map) for the gate to read\n' +
          '- Story 4.2.5 (multi-select + atomic bulk move) — the subtask that shipped the bar ' +
          'without the gate; AC said `selection bar shows "N selected" + Move to sprint ▸ + Move ' +
          'to backlog` but did not specify contextual gating (the AC undershot — flag it as the ' +
          'plan gap that lets the bug exist)\n' +
          '- `design/backlog/backlog.mock.html` panel 4 — the multi-select bar spec; verify ' +
          'whether the mockup specifies the contextual gate (if not, this is also a design-notes ' +
          'addendum, not a design rework — the gate is a behaviour spec, not a layout change)\n' +
          '- Mirror: Jira backlog selection bar — actions are contextual to the selection origin ' +
          '(rung 1)\n' +
          '- Related: `bug-backlog-zh-sprint-translated-as-chongci` (sibling Epic-4 bug filed in ' +
          'the same session — same surface, different shape)',
      },
    ],
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
    items: [
      {
        id: 'bug-settings-modal-input-focus-ring-clipped',
        kind: 'bug',
        title:
          'Settings create/edit modals: input focus ring is clipped by the scrollable modal body',
        status: 'planned',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 5 (current epic — discovered during Epic 5 work) · ' +
          '**Code surface owned by:** subtask 5.4.10 (components admin UI) + subtask 5.3.6 ' +
          '(fields admin UI), both sitting on the shared `Modal` / `Input` primitives · ' +
          '**Status:** open · **Reported by:** Yue.\n\n' +
          'In **Project settings → Components → 创建组件** (`CreateComponentModal`), the focused ' +
          "name input's focus ring renders visibly **cut off** — flat/clipped at the left and " +
          'right edges instead of fully rounded on all four sides. The identical defect shows in ' +
          '**Project settings → Fields → 创建字段** (the create-field modal): the same clipped ' +
          'ring around the 名称 input. One root cause, multiple surfaces — the edit variants of ' +
          'both modals share the same body wrapper and clip the same way.\n\n' +
          '**Repro:** sign in as `zhuyue@prodect.co` / `!QAZ1qaz`, open any project → Project ' +
          'settings → Components → 创建组件 (the name input autofocuses — the clipped ring is ' +
          'immediate). Same in Project settings → Fields → 创建字段. Locale-independent (zh ' +
          'screenshots; nothing locale-specific in the layout).\n\n' +
          '**Root cause (verified in code, confirm in the fix).** `components/ui/Input.tsx` draws ' +
          'its focus ring as `focus-within:ring-2 … ring-offset-2` — a box-shadow extending ~4px ' +
          "OUTSIDE the field's border box. Both modals wrap their form body in " +
          '`<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">` ' +
          '(`ComponentsSettingsEditor.tsx` create ≈line 530 / edit modal; `FieldsSettingsEditor.tsx` ' +
          '≈lines 606 + 793). Per the CSS spec, `overflow-y: auto` forces the computed ' +
          '`overflow-x` from `visible` to `auto`, so the body becomes a clip/scroll box on BOTH ' +
          "axes — and since the Input stretches to the container's full content width, the " +
          "ring's horizontal overhang is painted outside the clip box and cut. Rings are " +
          'box-shadows: they never grow the layout box, so nothing scrolls — the paint is just ' +
          "silently clipped. The recipe is sanctioned by the primitive itself (`Modal.tsx`'s " +
          'comment: consumer "can give its body `flex-1 overflow-y-auto` and pin a footer"), so ' +
          'every current and future modal following the documented pattern inherits the clip — ' +
          'this is a **primitive-layer bug**, not a per-screen one.\n\n' +
          '**Fix shape (durable, primitive-level — never per-modal padding hacks).** Add a ' +
          '`Modal.Body` sub-component to `components/ui/Modal.tsx` that owns the scroll recipe ' +
          'once and makes it ring-safe (the standard inset-compensation pattern: horizontal ' +
          'padding ≥ the ring overhang inside the scroll container, paired with an equal ' +
          'negative margin so the visual gutter does not shift), update the `Modal.tsx` comment ' +
          'to prescribe `Modal.Body`, and migrate the consumers (create + edit × components / ' +
          'fields, plus every other modal body the sweep finds). Footer pinning must keep ' +
          'working.\n\n' +
          '## Acceptance criteria\n\n' +
          '- In 创建组件 / edit component and 创建字段 / edit field, the focus ring of every ' +
          'focusable field renders fully on all four sides (no flat/clipped edge), in zh and en.\n' +
          '- The fix lands in the shared `Modal` primitive (a `Modal.Body` or equivalent) and the ' +
          'consumers adopt it — no one-off padding patch inside a single modal.\n' +
          '- Repo-wide sweep: every other modal body using the `overflow-y-auto` recipe is ' +
          'migrated in the same fix (grep `overflow-y-auto` across modal-rendering components).\n' +
          '- Scroll behaviour is preserved: a long body still scrolls within the `max-h-[90vh]` ' +
          "panel, the footer stays pinned, and the fields' visual alignment with the modal " +
          'title/footer is unchanged (the inset compensation must not narrow the body).\n' +
          '- A regression test covers `Modal.Body` (renders children, applies the ring-safe ' +
          'scroll classes); existing components/fields settings tests stay green.\n\n' +
          '## Context refs\n\n' +
          '- `components/ui/Modal.tsx` — the primitive (the `overflow-hidden` panel + the comment ' +
          'prescribing the consumer-side `overflow-y-auto` body recipe); the fix site\n' +
          '- `components/ui/Input.tsx` — `focus-within:ring-2 … ring-offset-2` (the ~4px overhang ' +
          'that gets clipped)\n' +
          '- `app/(authed)/settings/project/components/_components/ComponentsSettingsEditor.tsx` — ' +
          'CreateComponentModal / EditComponentModal bodies\n' +
          '- `app/(authed)/settings/project/fields/_components/FieldsSettingsEditor.tsx` — ' +
          'create/edit field modal bodies\n' +
          '- Subtasks 5.4.10 + 5.3.6 — the owning admin-UI subtasks\n' +
          '- `bug-inline-edit-clipped-when-table-short` (Epic 2) — precedent for the ' +
          '"focus/popover clipped by an overflow container" bug family.',
      },
    ],
  },
  {
    id: '6',
    title: 'Search, reporting & admin',
    status: 'planned',
    descriptionMd:
      'The tools that make the PM core enterprise-usable and complete the standalone Jira ' +
      'alternative: **search & filtering**, **dashboards & reports**, **roles & permissions**, ' +
      'project admin, and **automation rules**. After this epic, motir-core is a feature-complete ' +
      'PM tool — ready for the AI Planning Layer (Epic 7) to sit on top.',
    items: [
      {
        id: 'bug-issue-detail-eyebrow-overflows-viewport',
        kind: 'bug',
        title:
          'Issue detail page overflows the viewport horizontally when the parent-breadcrumb eyebrow is long — right-rail controls scroll off-screen',
        status: 'planned',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 6 (where the bug was DISCOVERED) · ' +
          '**Surfaces:** issue detail page (`/issues/[key]`, Subtask 2.4.1 — ' +
          '`app/(authed)/issues/[key]/page.tsx` + Subtask 2.4.3 — ' +
          '`ParentBreadcrumb.tsx`) · **Status:** open · **Reported by:** Yue.\n\n' +
          'On the issue **detail** page (`/issues/[key]`), some work items render with a ' +
          'page width LARGER than the browser viewport — the entire page is pushed to the ' +
          'right and the rightmost controls in the header (the watch popover trigger + the ' +
          '**Edit** button) and the right-rail (CoreFieldsPanel — status, assignee, priority, ' +
          'labels, components, etc.) are clipped off-screen. The overflow originates beneath ' +
          "the authed shell, but the consequence is the same: fields on the right aren't " +
          'reachable without horizontal scroll. Most items render correctly; only some ' +
          'trigger it — the ones with a long ancestor chain in their eyebrow.\n\n' +
          '**Repro.** Sign in as `zhuyue@motir.co` / `!QAZ1qaz`, open the `moooon` / `motir` ' +
          'project, navigate to a subtask whose Story title is long — e.g. **PROD-346** ' +
          '(Subtask 6.6.6 "Audit-log UI — per-rule execution log …", whose parent is ' +
          'Story 6.6 "Automation rules"); or **PROD-356** (under Story 6.8 "Edit project ' +
          'details + change project key (with old-key redirects)"). Observe at typical ' +
          'laptop widths: the eyebrow row renders on ONE line and extends past the right ' +
          'edge of the viewport, the page-body description text gets cut off mid-word at ' +
          'the right edge ("dura…" in the original repro), and the right rail ' +
          '(CoreFieldsPanel) is partly or fully off-screen. Items with a short Story title ' +
          "(or a top-level item with no breadcrumb at all) render normally — that's why " +
          "it's intermittent. Yue's follow-up screenshot of PROD-356's eyebrow shows the " +
          'row laid out as `PROD-356 · ⚡ Epic: Epic 6: Search, reporting & admin · 📖 ' +
          'Story: 6.8 Edit project details + change project key (with old-key redirects) · ' +
          'blocked` on a single non-wrapping line wider than the viewport — the smoking gun.\n\n' +
          '**Root cause (hypothesis to verify in the fix Subtask).** The eyebrow row in ' +
          '`app/(authed)/issues/[key]/page.tsx` (~line 220) is a ' +
          '`<div className="flex flex-wrap items-center gap-x-3 gap-y-2">` whose children ' +
          'include the type icon, the identifier, **`<ParentBreadcrumb>`**, a status `Pill`, ' +
          'and an `ml-auto` right cluster (rollup badge + watch + edit). ' +
          '`ParentBreadcrumb` correctly sets `min-w-0 flex-wrap` on its OWN `<nav>` and ' +
          '`truncate` on the title span (`ParentBreadcrumb.tsx:30, 44`) — **but only the ' +
          "breadcrumb's INNER track has `min-w-0`; the breadcrumb sits as a flex child of " +
          'the eyebrow with no `flex-1 min-w-0` wrapper, so the eyebrow flex track resolves ' +
          'the breadcrumb to its min-content width (the default for a flex item is ' +
          '`min-width: auto`, i.e. min-content).** `truncate` only fires when the container ' +
          "is bounded; here it isn't, so the breadcrumb grows to its full text width. The " +
          "eyebrow then exceeds the viewport. AND the page body's " +
          '`grid grid-cols-1 gap-6 md:grid-cols-[1fr_18rem]` (`page.tsx:264`) has the same ' +
          'shape — `1fr` is `minmax(auto, 1fr)`, so any wide min-content child (the eyebrow ' +
          'above OR a wide `<pre>` / table / long URL inside the Markdown description) ' +
          'pushes the whole grid wider than the viewport. The authed shell wrapper ' +
          '(`app/(authed)/layout.tsx:117`, `<div className="px-4 py-6 sm:px-6 lg:px-8">`) ' +
          'sets only padding — no `min-w-0`, no `max-w-*` cap, no `overflow-x` guard — so ' +
          "it doesn't contain the overflow either. The intermittent shape (some items " +
          "overflow, most don't) is the giveaway: the bug is content-driven, and the " +
          'trigger is min-content of an inline-only-sized child.\n\n' +
          '**Why it survived 2.4.1 / 2.4.3.** The detail page was first built against ' +
          '`design/work-items/detail.png` whose mockup ancestors are short ("Epic: Foo"), ' +
          'so a min-content breadcrumb fit naturally. Epic 6 introduced Stories with long ' +
          'titles (parenthetical clauses — "(with old-key redirects)", "(status, error ' +
          'detail, pagination)") that crossed the threshold; the design did not change, ' +
          'but the data did.\n\n' +
          '**Fix shapes (decide at fix time — both are mechanical, both are needed):**\n' +
          '1. **Eyebrow flex container.** Wrap the `<ParentBreadcrumb />` slot in a ' +
          '`flex-1 min-w-0` cell (or give the `<nav>` itself `flex-1 min-w-0`), so the ' +
          'truncate inside the breadcrumb actually has a bounded track to truncate against. ' +
          'Verify the `ml-auto` right cluster stays pinned right; verify multi-ancestor ' +
          'chains still wrap to a second line at narrow widths.\n' +
          '2. **Two-column body grid.** Add `min-w-0` to the `<main>` (the `1fr` track) so ' +
          'wide markdown content (long URLs, code blocks, tables) cannot blow out the grid ' +
          'either — a separate latent overflow source that shares the page. (Same shape as ' +
          '`bug-swimlane-lane-header-not-spanning-scrolled-columns` in Epic 3 — both are ' +
          '"a flex/grid track sized to the wrong intrinsic width.")\n' +
          'Both fixes are contained to `page.tsx` (and possibly the `<nav>` className in ' +
          '`ParentBreadcrumb.tsx`); no projection / service / DTO change.\n\n' +
          '**Test gap that let it ship.** Existing tests for 2.4.1 / 2.4.3 cover the ' +
          'short-ancestor case; the long-ancestor case is uncovered. The fix MUST add a ' +
          'render-test or Playwright assertion: render the detail page for an item whose ' +
          "ancestor title is at least 80 chars, measure the page root's " +
          '`scrollWidth`/`clientWidth`, and assert no horizontal overflow ' +
          '(`scrollWidth <= clientWidth + tolerance`). Same measurement posture as the ' +
          'Epic-3 swimlane / `bug-tree-header-misalignment` fixes — measure rendered ' +
          'geometry, not CSS rules.\n\n' +
          '## Acceptance criteria\n\n' +
          '- On the issue detail page, an item with a LONG ancestor title (≥ 80 chars) ' +
          'renders WITHOUT pushing the page wider than the viewport — no horizontal scroll ' +
          'on the page root, the right-rail (CoreFieldsPanel) and the header right cluster ' +
          '(rollup badge + watch + Edit) are fully visible at typical laptop widths ' +
          '(1280–1440 px).\n' +
          '- The ancestor breadcrumb TRUNCATES inside its track (the existing ' +
          '`<span className="truncate">` actually fires) when the ancestor title would ' +
          'otherwise overflow; multi-ancestor chains still wrap to a second line at ' +
          'narrower widths (the `flex-wrap` behaviour is preserved).\n' +
          '- The right-cluster `ml-auto` still pins right; the description / explanation / ' +
          'relationships / activity sections still fill the 2-col grid; AA contrast ' +
          'preserved (no colour change).\n' +
          '- A WIDE markdown child (a code block with a long line, a long unbroken URL, ' +
          'a wide table) inside Description / Explanation does NOT blow out the page either ' +
          '(the `<main>` grid track has `min-w-0`); wide content scrolls inside its own ' +
          'block (or wraps), not the whole page.\n' +
          '- Items with a SHORT ancestor (or no ancestors — a top-level Epic) render ' +
          'identically to today (guard against regression of the green-path layout).\n' +
          '- A render-test (`tests/components/issue-detail-*.test.tsx`) or Playwright ' +
          'regression seeds an item with a long ancestor title and asserts the page root ' +
          '`scrollWidth <= clientWidth + 1` at a 1280-px viewport — measuring rendered ' +
          'geometry via `getBoundingClientRect` / `scrollWidth`, not CSS rules.\n\n' +
          '## Context refs\n\n' +
          '- `app/(authed)/issues/[key]/page.tsx` — the eyebrow `flex flex-wrap` row ' +
          '(~line 220) and the body `grid grid-cols-[1fr_18rem]` (~line 264) — both fix sites\n' +
          '- `app/(authed)/issues/[key]/_components/ParentBreadcrumb.tsx` — the breadcrumb ' +
          '`<nav>` already carries `min-w-0 flex-wrap` and a `truncate` span; the missing ' +
          "piece is its OUTER slot's bounded track\n" +
          '- `app/(authed)/layout.tsx:117` — the authed shell wrapper (padding-only, no ' +
          '`min-w-0` / `max-w-*` / `overflow-x` guard; intentional, since the page owns its ' +
          'own width)\n' +
          '- `design/work-items/detail.png` + `design/work-items/design-notes.md` — the ' +
          'design source (the eyebrow is meant to truncate, not push the page wider)\n' +
          '- `bug-swimlane-lane-header-not-spanning-scrolled-columns` + ' +
          '`bug-swimlane-collapsed-lane-header-not-full-width` (Epic 3 siblings) — same ' +
          'shape (wrong intrinsic width on a flex/grid track); precedent for the ' +
          '`getBoundingClientRect`-based test posture\n' +
          '- `motir-core/CLAUDE.md` — colour via `--el-*`, shape via element-shape tokens ' +
          '(applies to whatever wrapper the fix introduces)\n\n' +
          '**Refactor signal (rule of three watch).** This is the THIRD occurrence of ' +
          '"wrong intrinsic width on a flex/grid track" — the two Epic-3 swimlane bugs ' +
          'and now this one. The pattern is consistent enough across surfaces that the ' +
          'next occurrence justifies a shared layout primitive / lint rule for ' +
          '"every flex/grid track that should shrink needs `min-w-0`."',
      },
    ],
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
      'epic). This is the closed `motir-ai` layer the open core calls into over a documented ' +
      'HTTP API. A team that never opens the chat box still has a full Jira alternative; this epic ' +
      'makes Motir AI-native on top of that.\n\n' +
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
      'site + the Motir brand mark, go-to-market strategy, the one-time Prodect → Motir rebrand ' +
      'cutover, ToS + privacy policy, transactional email, basic analytics, production deploy, ' +
      'domain + SSL, onboarding, and day-1 admin tools. Most of this is human subtasks ' +
      "running through Motir's own queue. (Formerly Epic 5.)",
  },
];
