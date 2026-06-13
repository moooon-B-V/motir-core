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
    status: 'in_progress',
    descriptionMd:
      'The irreducible Jira core — the first epic of the PM substrate that makes Motir a usable ' +
      "standalone product. Built directly on Story 1.4's `work_item` model: issue types " +
      '(epic / story / task / bug), the issue detail view, create / edit, customizable per-project ' +
      'status **workflows**, assignees, and the issue list. After this epic a team can track real ' +
      'work by hand, with zero AI involved. The AI Planning Layer (Epic 7) later *generates* these ' +
      'same issues — but the manual path is the foundation and must stand on its own.\n\n' +
      '**Re-opened 2026-06-12 — Story 2.7 (work-item type + executor).** The 2026-06-12 Epic-7 ' +
      'augmentation surfaced a gap in this core model: a work item carries `kind` ' +
      '(epic/story/task/bug/subtask) but no executor-routing **type** (code/design/test/…) — the ' +
      "plan's own `type`/`executor` are only PROSE in the description today. Story 2.7 adds them as " +
      'real fields (a Principle-#11 justified deviation from Jira, whose only type axis is `kind`), ' +
      'so the AI layer can generate typed leaves (7.3) and route prompts by type (7.6), and a human ' +
      'can filter by type (Epic 6). It lands in Epic 2 — not Epic 7 — because it is a core ' +
      'work-item attribute, which keeps every AI consumer a clean backward dep.',
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
      {
        id: 'bug-inline-edit-detail-rail-refresh-on-success',
        kind: 'bug',
        title:
          'Issue detail rail: inline field edits still router.refresh() on success — the same revert race + a whole-route repaint',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 2 · **Surface:** the issue detail RAIL — ' +
          '`CoreFieldsPanel` (status / type / priority / assignee / due date / estimate / ' +
          'parent, Story 2.4) and `CustomFieldsSection` (text / number / date / select / user ' +
          'custom-field values, Story 5.3.7) · **Reported by:** finding #79 (Yue, 2026-06-10) · ' +
          '**Status:** done.\n\n' +
          'The detail-rail follow-up to [[bug-inline-status-revert-on-second-edit]]. That bug ' +
          "fixed the `/issues` LIST inline editors (PR #640) and set Yue's contract — **a " +
          'successful action response IS the confirmation: confirm the optimistic value ' +
          'locally, NO `router.refresh()` on success** (the refresh fan-out is what raced ' +
          'stale whole-page snapshots and reverted unrelated cells). The detail rail was ' +
          'explicitly OUT of scope there (finding #79) because `CoreFieldsPanel` was owned by ' +
          'open PR #633, and touching it in parallel would collide (the 7.0.2/7.0.3 lesson, ' +
          'finding #63).\n\n' +
          '**The defect (finding #79).** The rail editors call the edit Server Actions ' +
          '(`updateIssueAction` / `changeStatusAction` / `setCustomFieldValueAction`), then ' +
          '`router.refresh()` on success — the exact mechanic #640 removed from the list — and ' +
          'render every field from `item.*` / server props with no optimistic display state. ' +
          'Consequences: (a) two quick edits on the SAME detail page race two refresh payloads ' +
          'just like the list bug, and with no override to mask it the first field shows its ' +
          'OLD value; (b) every single-field edit repaints the WHOLE detail route (comments, ' +
          'activity, attachments) for one cell.\n\n' +
          '## Acceptance criteria\n\n' +
          '- The rail editors keep the picked value optimistically on the action’s success ' +
          'response — no `router.refresh()` on success.\n' +
          '- `router.refresh()` survives ONLY on the optimistic-concurrency STALE (409) ' +
          'conflict, where a re-read is the point.\n' +
          '- Covers both rail editors that shared the mechanic: `CoreFieldsPanel` (all built-in ' +
          'fields, incl. the relational parent) and `CustomFieldsSection` (all five custom ' +
          'field types).\n' +
          '- Component tests assert the optimistic value is kept and no refresh fires on ' +
          'success; the custom-fields E2E waits on the action’s authoritative network signal ' +
          '(the optimistic on-screen value is no longer a commit signal).\n\n' +
          '## Context refs\n\n' +
          '- `app/(authed)/issues/[key]/_components/CoreFieldsPanel.tsx`, ' +
          '`CustomFieldsSection.tsx` — the rail editors\n' +
          '- `components/issues/ParentPicker.tsx` — now hands the picked parent ' +
          '`{identifier, title}` up so the rail shows it without a re-read\n' +
          '- [[bug-inline-status-revert-on-second-edit]] (PR #640) — the list fix + the ' +
          'no-refresh contract this extends · finding #79\n\n' +
          '**Closed (2026-06-12): PR #879 merged.** `CoreFieldsPanel` and `CustomFieldsSection` ' +
          'now hold per-field optimistic overrides and KEEP the value on the action’s success ' +
          'response, with `router.refresh()` retained only on a stale conflict. ' +
          '`CustomFieldsSection` dropped `useRouter` entirely (its action has no stale path). ' +
          'Component tests assert the kept value + no-refresh; the custom-fields E2E was ' +
          'switched to wait on the Server Action POST / `DELETE /api/fields` responses rather ' +
          'than an optimistic on-screen value (the diffKeys + finding-#81 delete races the ' +
          'optimistic display exposed). `EstimateBadge`’s identical fix shipped in PR #873. ' +
          'Full CI green.',
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
      {
        id: 'bug-board-create-scrum-type-disabled',
        kind: 'bug',
        title:
          'Cannot create a Scrum board — the create-board dialog’s Scrum type option is permanently disabled (stale "Epic 4" seam left over after Story 4.5 shipped)',
        status: 'planned',
        type: 'bug',
        executor: 'coding_agent',
        estimateMinutes: 25,
        dependsOn: ['3.7.4', '4.5'],
        descriptionMd:
          '**Type:** bug (stale seam) · **Parent:** Epic 3 (Boards) · **Surfaces:** the ' +
          'create-board dialog on `/boards` (`BoardSwitcher.tsx` → `BoardFormModal`, Subtask ' +
          '**3.7.4**) · **Unblocked by:** Story **4.5** (Scrum board) + Subtask **3.7.3** ' +
          '(`boardsService.createBoard`) · **Status:** open · **Reported by:** Yue.\n\n' +
          'You cannot create a **Scrum** board through the UI. On `/boards`, the board switcher’s ' +
          '**New board** dialog draws a Kanban / Scrum type picker, but the **Scrum** tile is ' +
          'rendered permanently disabled — greyed (`opacity-60`, `aria-disabled`) with an ' +
          '**"Epic 4"** badge — and the only selectable type is Kanban. So every board a user ' +
          'creates is a Kanban board; there is no way to create a Scrum board from the product.\n\n' +
          '**Why it’s now a bug (not a deliberate seam).** When the create dialog shipped (3.7.4) ' +
          'the Scrum *board view* did not exist yet, so the Scrum tile was intentionally stubbed ' +
          'with the "Epic 4" badge as a forward-looking placeholder. That prerequisite has since ' +
          'landed: **Story 4.5 (Scrum board, sprint-scoped view) is `done`**, the backend ' +
          '`boardsService.createBoard(projectId, { type: scrum })` shipped in **3.7.3** (and is ' +
          'already exercised in production by 4.4’s sprint-start, which provisions a `type == ' +
          "scrum` board via that exact call), and the DTO/enum (`BoardTypeDto = 'kanban' | " +
          "'scrum'`) + the `POST /api/boards` route already validate and accept `scrum`. The " +
          'whole stack supports a user-created Scrum board EXCEPT the one disabled tile — the seam ' +
          'was never re-opened when 4.5 merged, so the UI silently caps board creation at Kanban.\n\n' +
          '**Root cause.** In `app/(authed)/boards/_components/BoardSwitcher.tsx`, `BoardFormModal` ' +
          'hardcodes the type and never lets it change:\n' +
          "- `const [type] = useState<BoardType>('kanban');` — state with **no setter**, so the " +
          'submitted type is always `kanban`.\n' +
          '- The Kanban tile is a static `role="radio" aria-checked` element; the **Scrum tile** ' +
          '(`data-testid="board-type-scrum"`) is a static `aria-disabled` / `aria-checked={false}` ' +
          "element with `opacity-60` and a `<Pill>{t('epic4Badge')}</Pill>` — neither tile is " +
          'actually a clickable control. There is no `onClick` / `onKeyDown` toggling `type` on ' +
          'either tile.\n\n' +
          '**Repro.** Sign in as `zhuyue@motir.co` / `!QAZ1qaz`, open the `moooon` / `motir` ' +
          'project → `/boards`. Open the board switcher → **New board**. Observe the type picker: ' +
          'the **Scrum** tile is greyed with an "Epic 4" badge and cannot be selected; only Kanban ' +
          'is available. Create the board → it is a Kanban board. There is no path to a Scrum ' +
          'board.\n\n' +
          '**Fix.** Re-open the seam now that 4.5 has shipped: make the type picker a real ' +
          'two-option radio group.\n' +
          "- Give `BoardFormModal` a working `const [type, setType] = useState<BoardType>('kanban')` " +
          '(Kanban stays the default).\n' +
          '- Make BOTH tiles selectable controls (button / `role="radio"` with `onClick` + arrow-key ' +
          'roving focus per the radiogroup a11y pattern), toggling `aria-checked` and the ' +
          'selected-state styling (`border-(--el-accent)` / `bg-(--el-muted)` like the current ' +
          'Kanban tile). Remove the `aria-disabled` / `opacity-60` and the `epic4Badge` Pill from ' +
          'the Scrum tile.\n' +
          '- Submit carries the chosen `type` to the existing `createBoard(name, type)` → ' +
          '`POST /api/boards { name, type }` path (already accepts `scrum`; no service/route/schema ' +
          'change). Newly-created Scrum boards already render correctly — a `scrum` board with no ' +
          'active sprint shows the 4.5 "No active sprint" empty state, and gains the sprint header ' +
          'once a sprint is started.\n' +
          '- Drop the now-unused `epic4Badge` i18n key from `messages/*.json` (and update the ' +
          '`newBoardSeedHint` copy if the type-picker hint changes). Keep the colour/shape token ' +
          'rules (`--el-*` + element-shape tokens) for any restyled tile.\n\n' +
          '## Acceptance criteria\n\n' +
          '- The New-board dialog’s Scrum tile is **enabled and selectable**; choosing it and ' +
          'submitting creates a `type == scrum` board (verified server-side), which then appears ' +
          'in the switcher and renders the 4.5 Scrum surface (sprint header / "No active sprint" ' +
          'empty state).\n' +
          '- Kanban remains the default selection; the picker is a proper radio group ' +
          '(arrow-key navigable, single selection, `aria-checked` tracks the choice) with no ' +
          '`aria-disabled` tile and no "Epic 4" badge.\n' +
          '- A component test for `BoardFormModal` asserts the Scrum tile is selectable and that ' +
          "submitting after selecting Scrum calls `onSubmit(name, 'scrum')` (today it always " +
          'submits `kanban`); an E2E (`board-multi.spec.ts` or sibling) creates a Scrum board ' +
          'end-to-end and asserts it renders the Scrum board view.\n' +
          '- No dead `epic4Badge` reference remains; `pnpm test:coverage` keeps any changed ' +
          'component file at/above the gate.\n\n' +
          '## Context refs\n\n' +
          '- `app/(authed)/boards/_components/BoardSwitcher.tsx` — `BoardFormModal` (the ' +
          "`useState<BoardType>('kanban')` with no setter, the static Kanban/Scrum tiles, the " +
          '`epic4Badge` Pill) + `createBoard()` which already POSTs `{ name, type }`\n' +
          '- `lib/services/boardsService.ts` `createBoard` + `lib/dto/boards.ts` `BoardTypeDto` + ' +
          '`app/api/boards/route.ts` (`InvalidBoardTypeError`) — the backend that already accepts ' +
          '`scrum`; `lib/services/sprintsService.ts` start flow — the existing in-product caller ' +
          'that provisions a `scrum` board via `createBoard`\n' +
          '- Story **4.5** (`story-4.5.ts`, `done`) — the Scrum board view that makes a ' +
          'user-created scrum board fully functional; Subtask **3.7.4** — the create dialog that ' +
          'owns the seam\n' +
          '- `messages/en.json` `epic4Badge` / `boardTypeScrum` / `newBoardSeedHint` — the copy to ' +
          'clean up\n' +
          '- `motir-core/CLAUDE.md` — colour via `--el-*`, shape via element-shape tokens (applies ' +
          'to the restyled Scrum tile); the radiogroup a11y pattern for the two-option picker',
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
    status: 'in_progress',
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
        status: 'done',
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
    status: 'in_progress',
    descriptionMd:
      'The tools that make the PM core enterprise-usable and complete the standalone Jira ' +
      'alternative: **search & filtering**, **dashboards & reports**, **roles & permissions**, ' +
      'project admin, and **automation rules**. After this epic, motir-core is a feature-complete ' +
      'PM tool — ready for the AI Planning Layer (Epic 7) to sit on top.',
    items: [
      {
        id: 'bug-automation-editor-status-id-not-key',
        kind: 'bug',
        title:
          'Automation editor stores the status ROW ID (not the key) → every UI-authored transitioned-trigger rule never fires, and every transition action always fails',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 6 · **Surfaces:** automation rule editor ' +
          '(Subtask 6.6.5 — `AutomationParts.statusOptions`) ↔ engine (Subtask 6.6.2 — ' +
          '`automationEngineService`) · **Status:** fix in flight (PR #821) · **Source:** ' +
          'surfaced by the Story 6.6 author→fire→audit E2E (Subtask 6.6.7).\n\n' +
          'The editor’s status comboboxes — the **transitioned** trigger’s from/to and the ' +
          '**transition** action’s target — stored the workflow status **row id** ' +
          '(`statusOptions` emitted `value: s.id`). But the engine treats ' +
          '`triggerConfig.toStatusId` / `fromStatusId` and a transition action’s ' +
          '`toStatusId` as status **KEYS**: it narrows transitioned events by ' +
          '`config.toStatusId === event.toStatusKey` (a key like `done`), and runs the ' +
          'action via `workItemsService.updateStatus(toStatusId)`, which takes a key. So a ' +
          'UI-authored *transitioned*-trigger rule **never matched any event** (id ≠ key), ' +
          'and a UI-authored *transition* action **always failed** with an unknown-status ' +
          'error. The headline recipe — "when an item transitions to Done, …" — was broken ' +
          'for every real user; only rules built directly in the service/engine tests (which ' +
          'pass keys) worked, so the gap never showed at the unit/integration tier.\n\n' +
          '**Root cause / fix:** the editor must store the KEY. `statusOptions` now emits ' +
          '`value: s.key` (one-line change; the component test that had encoded the id was ' +
          'updated). **Fix:** motir-core PR #821 — verified green by 6.6.7’s E2E (the ' +
          'transitioned author→fire→audit journey passes once the fix is applied). ' +
          '**Class:** a UI subtask (6.6.5) and its data-producing backend (6.6.2) disagreed ' +
          'on whether a JSON field named `…StatusId` holds an id or a key — caught only by ' +
          'the cross-layer E2E.',
      },
      {
        id: 'bug-automation-audit-log-tombstone-aa-contrast',
        kind: 'bug',
        title:
          'Automation audit-log tombstone ("item since deleted") fails AA colour-contrast (--el-text-faint)',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 6 · **Surfaces:** automation run-history / audit ' +
          'log (Subtask 6.6.6 — `AutomationRuleAuditLog.tsx`) · **Status:** fix in flight ' +
          '(PR #822) · **Source:** surfaced by the Story 6.6 audit-log axe sweep ' +
          '(Subtask 6.6.7).\n\n' +
          'The run-history **tombstone** row — "Triggering item since deleted", shown when an ' +
          'execution’s triggering work item was later deleted (the `SetNull` FK) — rendered ' +
          'with `text-(--el-text-faint)`, which **fails WCAG AA colour-contrast** (axe: ' +
          '`serious` `color-contrast`). The faint token is below the AA threshold on the ' +
          'panel surface — the same class as the sidebar-caption AA fix.\n\n' +
          '**Root cause / fix:** use `--el-text-secondary` — the AA-safe de-emphasis token; ' +
          'the `line-through` still conveys the deleted state. **Fix:** motir-core PR #822 — ' +
          'verified by 6.6.7’s `@a11y` sweep (a null-item execution renders the tombstone; ' +
          'the sweep is clean once the fix is applied).',
      },
      {
        id: 'bug-issue-detail-eyebrow-overflows-viewport',
        kind: 'bug',
        title:
          'Issue detail page overflows the viewport horizontally when the parent-breadcrumb eyebrow is long — right-rail controls scroll off-screen',
        status: 'done',
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
      {
        id: 'bug-reports-landing-charts-sized-for-widget-tile-not-page',
        kind: 'bug',
        title:
          'Reports landing pages render their charts at widget-tile proportions — Distribution donut is too small (lost in whitespace); Created-vs-Resolved line chart is too big (fills viewport width, runs off the bottom)',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 6 · **Surfaces:** reports landing pages ' +
          '(`/reports/distribution` — Subtask 6.5.2; `/reports/created-vs-resolved` — ' +
          'Subtask 6.5.3) · **Status:** open · **Reported by:** Yue.\n\n' +
          'On both full-page report landings under `/reports/*`, the chart visual is sized as ' +
          'if it were a **dashboard widget tile**, not a page-level data visualization. The two ' +
          'symptoms look opposite but share one root cause:\n\n' +
          '- **Distribution (`/reports/distribution`)** — the donut renders at ~170 px wide ' +
          'on a 1400+ px page, floating in a vast empty plot area. The "419 工作项" total + ' +
          'segment legend dominate the small ring; the whole upper half of the page is empty.\n' +
          '- **Created vs Resolved (`/reports/created-vs-resolved`)** — the line/area chart ' +
          'stretches to the FULL page width and proportionally grows TALL (the SVG uses ' +
          '`block w-full h-auto`, so width scales the viewBox and height comes along). With ' +
          'sparse data (a single spike at the right edge, Y axis up to 500), the chart fills ' +
          'the viewport horizontally AND vertically — the legend / Y-axis label "工作项" sit ' +
          'fine, but the X axis and the rest of the line run below the fold; on a 1280 px ' +
          'page the chart paints at ~1280 × ~600 px, well past a typical laptop fold.\n\n' +
          '**Repro.** Sign in as `zhuyue@motir.co` / `!QAZ1qaz`, open `/reports/distribution` ' +
          'on the `moooon` / `motir` project — observe the donut is small relative to the ' +
          'page; lots of whitespace above and around the ring (per screenshot 1). Then open ' +
          '`/reports/created-vs-resolved` and observe the chart fills the page width and ' +
          'the bottom of the plot area is below the fold (per screenshot 2). Resize the ' +
          "window: the donut stays the same pixel size (it's hard-coded), while the line " +
          'chart scales WITH the window — both directions of wrong.\n\n' +
          '**Root cause.** Two distinct sizing strategies in `components/ui/charts/`, both ' +
          'tuned for the 6.3.3 dashboard-widget tile (~400 px wide column), neither correct ' +
          'for a full-width report page:\n\n' +
          '1. **`DonutChart.tsx`** — the SVG uses a fixed pixel `style={{ width: size * 0.71 }}` ' +
          '(lines ~101-108) where `size` is a prop with a default of 220; `DistributionReport.tsx` ' +
          'passes `size={240}` (line 160). That gives the SVG a hard `width: 170px`, ' +
          'independent of the container. So even on a 1400-px-wide report page the donut ' +
          'stays ~170 px — that is the "lost in whitespace" symptom. (`preserveAspectRatio` ' +
          'and `h-auto` are present but irrelevant because `width` is hard-pixel.)\n' +
          '2. **`ChartFrame.tsx`** (used by `LineChart` / `BarChart` / `DifferenceAreaChart`) ' +
          'uses `className="block w-full h-auto"` on the SVG with `viewBox="0 0 ${width} ' +
          '${height}"` (lines ~85-94). That means the SVG scales **responsively to ' +
          'container width**, preserving the aspect ratio implied by the `width`/`height` ' +
          'props. `CreatedVsResolvedReport.tsx` passes `width={680} height={320}` (ratio ' +
          "~2.125:1). On a 1280-px page that's ~1280 × ~602 px; on a 1400-px page it's ~1400 " +
          '× ~659 px — both push the X axis below the fold. The `width`/`height` props are ' +
          'doing the WRONG job: they read like fixed canvas dimensions but actually only ' +
          'set the aspect ratio.\n\n' +
          'Both report pages embed the dashboard-widget-tuned chart components directly with ' +
          'no max-width / aspect-ratio override; the chrome ' +
          '(`app/(authed)/reports/_components/ReportPageChrome.tsx` / page wrappers) inherits ' +
          'the authed-shell padding-only container (`app/(authed)/layout.tsx:117`, no ' +
          '`max-w-*`), so the chart inherits the full page width.\n\n' +
          '**Why it survived 6.5.2 / 6.5.3.** The chart primitives were originally built ' +
          'for the 6.3.3 dashboard-widget surface where each widget sits in a tile ' +
          '~400 px wide — and at THAT width both shapes are correct (the 170 px donut sits ' +
          'centered in the tile; the 680 × 320 line chart at `w-full` of a ~400 px tile ' +
          'renders ~400 × ~188 px, a sensible widget chart). The 6.5.x report-landing ' +
          'subtasks reused them on a full-page surface without giving the chart a bounded ' +
          'container, so a tile-tuned chart paints on a page-tuned canvas. Same mistake on ' +
          'BOTH chart families, opposite-direction symptoms — a strong tell that the chart ' +
          "API doesn't carry the surface (tile vs page) signal it needs.\n\n" +
          '**Fix shapes (decide at fix time — both are mechanical):**\n' +
          '1. **Give the report-landing chart container a bounded width**, e.g. wrap each ' +
          'chart in a `max-w-3xl` (or `max-w-[56rem]`) centered block — the same shape we ' +
          'already use for narrow forms. For the donut, also raise the `size` prop ' +
          '(e.g. `size={360}` or `420`) so the ring is presence-sized for a page-level ' +
          'visualization rather than a tile thumbnail. For the line chart, leave the ' +
          'responsive `w-full` behaviour, but the bounded container caps its tall growth ' +
          '(56-rem ≈ 896 px max width × 2.125:1 aspect ≈ 422 px tall — fits one fold).\n' +
          '2. **Add a `surface` prop (or `variant`) to the chart primitives** — ' +
          '`surface="tile"` (default, current behaviour) vs `surface="page"` (caps the ' +
          'rendered size at a sensible page-level maximum with `max-width` / ' +
          '`aspect-ratio` CSS instead of relying on the consumer to wrap it). This is the ' +
          'durable shape — the chart component owns the responsive contract; consumers ' +
          'pick the surface intent.\n' +
          'Option 2 is the cleaner of the two and matches how `Pill` / `Card` / other ' +
          'primitives carry size variants already. Either way the fix is contained to ' +
          'the chart primitives + the two report-page wrappers; no data / service / DTO ' +
          'change.\n\n' +
          '**Verify via design.** `design/reports/` should already specify the page-level ' +
          'donut diameter and the line-chart max width/height (the 6.3.3 widget tile shape ' +
          'and the 6.5.x landing shape are DIFFERENT design surfaces — confirm by listing ' +
          'the area folder and reading `design-notes.md` before picking a number). If the ' +
          'landing shape was not specified in `design/reports/`, that is a design-gate ' +
          'miss on the 6.5.x stories — the fix should ADD a `type: design` subtask first ' +
          '(mirror 1.0.5 / 1.2.1 / 1.3.3 / 1.5.1 for output convention; produce a ' +
          '`*.mock.html` + `design-notes.md`), then the code fix follows.\n\n' +
          '**Test gap that let it ship.** Existing report-page tests likely assert data ' +
          'rendering (legend totals, table rows) but not chart geometry. The fix MUST add ' +
          "either a render-test or Playwright assertion that asserts the rendered SVG's " +
          '`offsetWidth` / `offsetHeight` (via `getBoundingClientRect`) fits sensible ' +
          'caps at a 1280-px viewport — e.g. donut diameter between 280–420 px on the ' +
          'distribution page; line chart total height ≤ 480 px on the created-vs-resolved ' +
          'page. Same measurement posture as the Epic-3 swimlane / Epic-6 detail-overflow ' +
          'bugs — measure rendered geometry via `getBoundingClientRect`, not CSS rules.\n\n' +
          '## Acceptance criteria\n\n' +
          '- On `/reports/distribution`, the donut renders at a **page-level** size ' +
          '(diameter in the 280–420 px range at typical laptop widths 1280–1440 px), not ' +
          'the 170-px widget-tile size; the ring + center total + legend feel like a ' +
          'primary page visualization, not an afterthought.\n' +
          '- On `/reports/created-vs-resolved`, the line/area chart fits **within one ' +
          'fold** at typical laptop widths (1280–1440 × 800–900 px viewport) — total ' +
          'chart height (plus legend + scope/period chrome) ≤ ~480 px so the X axis and ' +
          'plot area are visible without scrolling.\n' +
          '- The chart components carry their sizing intent **explicitly** (a `surface` ' +
          'prop, or a documented bounded-container contract) so a future report page or ' +
          "widget tile can't accidentally render the wrong size; the dashboard-widget " +
          '(6.3.3) surfaces continue to render at their existing tile size (guard against ' +
          'regression of the tile shape that was correct).\n' +
          '- Both report pages respect the design reference under `design/reports/` (if ' +
          'present); if no page-level chart sizing exists there, a `type: design` ' +
          'subtask is added first per the design-gate (MOTIR.md § Design-reference rule).\n' +
          '- A render-test or Playwright regression asserts the rendered chart geometry ' +
          'fits the caps above at a 1280-px viewport — measured via ' +
          '`getBoundingClientRect`, not CSS rules.\n' +
          '- AA contrast preserved; data-table fallback (`View data table`) still works; ' +
          'next-intl strings unchanged; no service / DTO / route change.\n\n' +
          '## Context refs\n\n' +
          '- `components/ui/charts/DonutChart.tsx` (lines ~95-145) — the SVG with ' +
          '`style={{ width: size * 0.71 }}` (the hard-pixel-width sizing strategy)\n' +
          '- `components/ui/charts/ChartFrame.tsx` (lines ~85-94) — the SVG with ' +
          '`block w-full h-auto` + `viewBox` (the responsive aspect-ratio sizing ' +
          'strategy used by `LineChart` / `BarChart` / `DifferenceAreaChart`)\n' +
          '- `app/(authed)/reports/_components/DistributionReport.tsx` (line 160) — ' +
          'passes `size={240}` to `<DonutChart />` (the widget-tuned size on a page-level ' +
          'surface)\n' +
          '- `app/(authed)/reports/_components/CreatedVsResolvedReport.tsx` (lines ' +
          '~231-238) — passes `width={680} height={320}` to `<DifferenceAreaChart />` ' +
          '(the widget-tuned aspect ratio on a page-level surface)\n' +
          '- `app/(authed)/reports/_components/ReportPageChrome.tsx` + the per-report ' +
          '`page.tsx` files — where a bounded-width wrapper would land if going with ' +
          'fix shape 1\n' +
          '- `design/reports/` (verify the page-level chart spec exists; if not, the ' +
          'fix opens a `type: design` subtask first per the design-gate)\n' +
          '- `bug-issue-detail-eyebrow-overflows-viewport` (sibling Epic 6 bug) — the ' +
          'recurring "Epic 6 surfaces stretch to the viewport" pattern; this one has the ' +
          'opposite manifestation but the same authed-shell uncapped-width root\n' +
          '- 6.3.3 widget tile + 6.5.2 / 6.5.3 report-landing — the two consumer ' +
          'surfaces whose differing requirements the chart API has to encode\n' +
          '- `motir-core/CLAUDE.md` — colour via `--el-*`, shape via element-shape tokens ' +
          '(applies to whatever wrapper / prop the fix introduces)\n\n' +
          '**Closed (2026-06-13): PR #836 merged.** The report-landing charts now size for ' +
          'the page, not the widget tile: the Distribution donut renders at a page-level ' +
          'diameter and the Created-vs-Resolved line/area chart is bounded so it fits within ' +
          'one fold, while the 6.3.3 dashboard-widget tiles keep their existing tile size. ' +
          'The bounded report card uses `max-w-[48rem]` — the named `max-w-3xl` resolves to ' +
          '~40px under motir-core’s `@theme` (which clears the container scale) and collapsed ' +
          'the layout. Full CI green (sharded Playwright E2E + Vitest). The PR also carried, ' +
          'at Yue’s request, the “issue” → “work item” terminology sweep across the app copy ' +
          'and the E2E selectors that key on the renamed aria-labels.',
      },
      {
        id: 'bug-board-cannot-drag-from-in-review-to-done',
        kind: 'bug',
        title:
          'Kanban board — dragging a card from In Review to Done does not move it (card snaps back, status unchanged)',
        status: 'planned',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 6 (where the bug was DISCOVERED) · ' +
          '**Surfaces:** Kanban board (`/boards`, Stories 3.1 / 3.2) · **Status:** ' +
          'open · **Reported by:** Yue.\n\n' +
          'On the Kanban board (`/boards`, flat / no swimlanes) a card in the **In Review** ' +
          'column cannot be dragged into **Done**. The drag visibly starts (the card lifts, the ' +
          'pointer follows it), but the drop either snaps back to In Review (the column it came ' +
          'from) or never registers — the card stays in In Review and the work-item status is ' +
          'unchanged. Adjacent column moves on the same board work as expected (other transitions ' +
          'verified manually), so this is specific to the `in_review → done` edge.\n\n' +
          '**Repro.** Sign in as `zhuyue@motir.co` / `!QAZ1qaz`, open the `moooon` / `motir` ' +
          "project → `/boards` (flat / no swimlanes; the default workflow's six columns: " +
          '`todo · blocked · in_progress · in_review · done · cancelled`). Find a work item ' +
          'whose current status is `in_review`. Drag it from the In Review column onto the ' +
          'Done column. Observe: the card does NOT settle in Done — it either snaps back to ' +
          'In Review immediately on drop, or the drag completes visually but a refresh shows ' +
          'the status unchanged. Repeat with a different card from In Review to confirm the ' +
          'edge is the variable, not the card.\n\n' +
          '**Diagnostic data the fix Subtask MUST capture before changing code (the bug ' +
          'report is symptomatic; the dispatch needs to nail down which branch is firing):**\n' +
          '1. Open DevTools → Network and replay the drag. Did the browser fire ' +
          '**`POST /api/board/move`** at all?\n' +
          '   - **NO request** → the bug is in the dnd-kit wiring: either the drop target ' +
          "isn't resolving (over-id mismatch), or `handleDragEnd` is short-circuiting before " +
          '`runMove` (likely a guard in `BoardContainer.tsx` — e.g. `canEdit` resolving false, ' +
          'or `columnOfOverId` returning null for the Done column). See ' +
          '`app/(authed)/boards/_components/BoardContainer.tsx` ~line 875 onward + the ' +
          '`columnOfOverId` helper in `boardMove.ts`.\n' +
          '   - **Request fired, response NON-200** → look at the status:\n' +
          '     - `409` (IllegalBoardMoveError) — the workflow rejected the transition. The ' +
          'default workflow DOES permit `in_review → done` (`lib/workflows/defaultWorkflow.ts` ' +
          'line ~74), so a 409 here would imply: (a) the project workflow is customised and ' +
          'the edge was removed; (b) the Done column maps a status whose key is NOT the ' +
          "literal `done` (the column's first mapped status by `position` is what " +
          '`boardsService.moveCard` transitions to — `boardsService.ts` ~lines 478-501); or ' +
          "(c) the card's current status isn't actually `in_review` (it could be in a " +
          'multi-status column that LOOKS like In Review but the card carries a different key).\n' +
          '     - `422` (UnmappedColumnTargetError) — the Done column maps NO live status; ' +
          'this would mean the workflow was edited (a status renamed/deleted) and the column ' +
          'mappings drifted. Unmapped statuses tray should be visible above the board if ' +
          "that's the case.\n" +
          '     - `404` — boardId / workItemId / column id stale (a re-projection ' +
          'mid-drag, or the active project changed in another tab).\n' +
          '     - `500` / network error — server fault; check server logs.\n' +
          '   - **Request fired, response 200 but UI snaps back** → reconcile bug in ' +
          '`BoardContainer.runMove` (`reconcileCard` produces an unexpected shape) or a ' +
          'racing re-fetch overwriting the optimistic state. Less likely but possible.\n' +
          '2. Check the toast. The 3.2.4 wiring emits a toast on snap-back ' +
          '(`moveIllegalDescription` / `moveUnmappedDescription` / `moveErrorDescription`). ' +
          'If a toast appears, READ IT — the copy names the failure class.\n' +
          '3. Inspect the Done column in DevTools — find its `data-testid` / id and confirm ' +
          'the dnd-kit `useDroppable({ id: column.id })` registration (`BoardColumn.tsx` ' +
          'line ~76). If the Done column has zero cards and no padding, its droppable area ' +
          'may be too narrow to reliably receive a drop at a typical pointer velocity ' +
          '(a 3.2.x finding; the empty-state region needs a sensible min-height).\n\n' +
          '**Hypotheses, in order of likelihood (the fix Subtask should narrow this with the ' +
          'diagnostics above, NOT pick one blind):**\n' +
          '1. **The Done column droppable surface is too small / mis-bounded** when the ' +
          'column is empty or short. The dnd-kit pointer collision detection ' +
          '(default `closestCorners`) needs a stable droppable rect; a zero-card column with ' +
          'only the header + an empty-state caption can resolve to a SIBLING column under ' +
          'the pointer, so the over-id never points at Done. Likely if no `POST /api/board/move` ' +
          'fires.\n' +
          '2. **The Done column maps a status whose KEY differs from `done`** in the live ' +
          'tenant (e.g. customized workflow, or seed drift). `moveCard` ' +
          '(`boardsService.ts:478-501`) transitions to the mapped target status; if that key ' +
          "isn't in the workflow's edges out of `in_review`, the service throws " +
          '`IllegalTransitionError` → 409 → snap-back. Likely if a 409 fires.\n' +
          '3. **A 409 IS firing and the toast is missing or unreadable** (e.g. dismissed too ' +
          'fast, or the next-intl string for `moveIllegalDescription` is missing in the ' +
          'current locale — the screenshot history shows the app is in `zh` for Yue). ' +
          'A silent 409 looks identical to a no-request bug from the user side.\n' +
          '4. **Sprint mode interaction.** If the board has an active sprint open and the ' +
          'item is NOT in the active sprint, board state might be filtering it out of the ' +
          'reconciled response. Less likely but worth ruling out via the network response ' +
          'body.\n' +
          '5. **A row-position rank collision** (`keyBetween` returns an identical key) — ' +
          'wildly unlikely (Story 1.4 fractional-index helper is well-tested) but the only ' +
          'remaining "request fires, 200 returns, card snaps back" branch.\n\n' +
          '**Why this is logged as a bug, not a finding.** Yue can reproduce it reliably ' +
          "(it's a hard blocker — you can't progress an issue to Done by drag, the primary " +
          'board interaction). Even if it turns out to be data drift in a specific tenant ' +
          '(hypothesis 2) or a localisation gap (hypothesis 3), the user-facing symptom is ' +
          'identical: "the board move silently fails." A finding would defer the user-facing ' +
          'fix; a bug attaches the fix to the seed so it surfaces in the board.\n\n' +
          '## Acceptance criteria\n\n' +
          '- The fix Subtask STARTS by reproducing the bug on a fresh `pnpm dev` against ' +
          'the seed, capturing the diagnostic data above (Network request fired? response ' +
          'status? toast? Done-column droppable rect?). The root cause is determined from ' +
          'observation, not assumption.\n' +
          '- After the fix, a card in `in_review` can be dragged into the Done column on ' +
          'the flat Kanban board and the move sticks: the card renders in Done, the work ' +
          'item status is `done`, and refreshing the page does not revert the change.\n' +
          '- Adjacent transitions that ALREADY worked (e.g. `todo → in_progress`, ' +
          '`in_progress → in_review`, `in_review → in_progress`, `in_progress → blocked`, ' +
          '`done → in_progress` reopen) continue to work — no regression in the green-path ' +
          'board moves.\n' +
          '- ALL six default columns accept drops cleanly even when EMPTY (the ' +
          'droppable surface for an empty column is at least, say, 120 px tall — the ' +
          'empty-state region has a sensible min-height so the drop target is reliable). ' +
          'This is the "fix the smallest hypothesis-1 surface" backstop regardless of which ' +
          'hypothesis turns out to be the actual root cause — if the fix is elsewhere, this ' +
          'still lands as a coverage improvement.\n' +
          '- The snap-back toast strings (`moveIllegalDescription` / ' +
          '`moveUnmappedDescription` / `moveErrorDescription`) are verified present and ' +
          'readable in BOTH `en` and `zh` locales (next-intl) — a silent snap-back is a ' +
          'bug-class on its own.\n' +
          '- A Playwright regression in `tests/e2e/board-flat.spec.ts` (or a sibling) ' +
          'exercises EACH default transition edge from a seed card (`todo → in_progress`, ' +
          '`in_progress → in_review`, **`in_review → done`** ← the one this bug names, plus ' +
          'the others); the test drives a real drag (`page.dragAndDrop` or pointer ' +
          'sequences) and asserts the card lands in the target column AND the work-item ' +
          'status reflects the transition after a reload. The matrix posture catches a ' +
          'future "one specific edge regresses" of the same shape.\n\n' +
          '## Context refs\n\n' +
          '- `app/(authed)/boards/_components/BoardContainer.tsx` — the dnd `handleDragEnd`, ' +
          '`runMove` (~line 498), `runTransition` (~line 547), and the over-id resolution. ' +
          'The 3.2.4 optimistic / 409-snap-back wiring.\n' +
          '- `app/(authed)/boards/_components/BoardColumn.tsx` (~line 76) — the ' +
          '`useDroppable({ id: column.id })` for each column; the empty-column droppable ' +
          'area is the hypothesis-1 fix site.\n' +
          '- `app/(authed)/boards/_components/boardMove.ts` — `columnOfOverId` + ' +
          '`relocateCard` (the over-id resolver and optimistic reducer).\n' +
          '- `app/api/board/move/route.ts` — the HTTP layer (typed-error → status mapping).\n' +
          '- `lib/services/boardsService.ts:415-535` — `moveCard` orchestration + the ' +
          'cross-column transition path (`applyStatusTransition` → `IllegalTransitionError` ' +
          '→ `IllegalBoardMoveError`).\n' +
          '- `lib/services/workItemsService.ts:1124-1182` — `applyStatusTransition`: it ' +
          'gates on `workflowsService.canTransition` ONLY — **does NOT readiness-gate moves ' +
          'into a `done`-category status against unresolved `is_blocked_by` links** (so an ' +
          'open blocker is NOT a cause of this bug at the service layer; if Yue wants ' +
          'readiness to GATE the move, that is a separate Story-4.x decision, not this fix).\n' +
          '- `lib/workflows/defaultWorkflow.ts:67-89` — the 15-edge default transition graph; ' +
          '`in_review → done` is the third edge (forward main path).\n' +
          '- `messages/en.json` + `messages/zh.json` — `boards.move*` strings the snap-back ' +
          'toast renders.\n' +
          '- `tests/e2e/board-flat.spec.ts` (and siblings) — the Playwright regression ' +
          'site.\n' +
          '- `motir-core/CLAUDE.md` — colour via `--el-*`, shape via element-shape tokens; ' +
          'the 4-layer Route → Service → Repository → Prisma contract for any backend ' +
          'change the fix may need.',
      },
      {
        id: 'bug-builtin-filter-names-not-localized',
        kind: 'bug',
        title:
          'Built-in saved-filter names render in English even when the UI locale is `zh` — the SavedFilterDropdown (and every other consumer) ships the English literal from the registry',
        status: 'planned',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 6 (where the bug was DISCOVERED) · ' +
          '**Surfaces:** every UI that lists built-in saved filters — confirmed in the ' +
          'issues-list `SavedFilterDropdown` (`/issues`), referenced by the reports ' +
          '`ReportScopeCombobox` and the dashboard `DataSourceField` saved-filter picker · ' +
          '**Status:** open · **Reported by:** Yue.\n\n' +
          'When the UI locale is `zh`, the dropdown chrome around saved filters IS ' +
          'translated correctly (`默认 / 我的筛选器 / 项目筛选器 / 查找筛选器…`), but the ' +
          'actual filter ROW names remain English (`My open issues / Reported by me / All ' +
          'issues / Open issues / Done issues / Created recently / Updated recently / ' +
          'Resolved recently`). The screenshot Yue attached shows the issues-list dropdown ' +
          'with a `查找筛选器…` placeholder + `默认` group header + English row names — ' +
          'evidence that the i18n thread reaches the chrome but stops at the rows. The ' +
          '"Built-in" / `内置` tag on the right column is localised, so the chrome / row ' +
          'split is visually jarring.\n\n' +
          '**Repro.** Sign in as `zhuyue@motir.co` / `!QAZ1qaz`, set the UI language to ' +
          'Chinese (or any non-English locale; `messages/zh.json` is the shipped second ' +
          'locale). Open the `moooon` / `motir` project → `/issues`, click the saved-filter ' +
          'dropdown trigger (the "Saved" / `已保存` button). Observe: the `默认` group ' +
          'header is in Chinese, the search placeholder is `查找筛选器…`, but every row ' +
          'in the group is in English. Same shape in the Distribution / Created-vs-' +
          'Resolved report-landing scope picker when a saved filter is chosen, and in the ' +
          "dashboard Add-widget modal's Data source picker (Saved filter mode).\n\n" +
          '**Root cause (HIGH confidence — the source comment names it).** ' +
          '`lib/savedFilters/builtins.ts:33` documents the design intent ' +
          '**verbatim**:\n\n' +
          '> `/** English display name (the 6.2.3 UI threads i18n over the slug). */`\n\n' +
          'The registry then hard-codes the `name` field as the English literal for each ' +
          'of the eight built-ins. The intended pattern was: server ships the slug ' +
          '(stable, locale-independent), and every UI consumer threads `t(...)` over the ' +
          'slug. **That thread was never wired.** Instead, the mapper at ' +
          '`lib/mappers/savedFilterMappers.ts:39` reads:\n\n' +
          '> `return { id: builtinFilterId(def.slug), name: def.name, builtin: true };`\n\n' +
          '…copying the English `def.name` straight onto the DTO `name` field. The UI ' +
          'then renders `builtin.name` directly — see ' +
          '`app/(authed)/issues/_components/SavedFilterDropdown.tsx:480` ' +
          '(`label={builtin.name}`). The slug never reaches the client; the DTO carries ' +
          "the English text. So `t('savedFilters.builtinNames.<slug>')` is what the " +
          'comment expected, but no such key exists in `messages/{en,zh}.json` and no ' +
          'consumer calls it.\n\n' +
          '**Impact.** Eight strings (the built-in names) leak English into every ' +
          'non-English locale, across at least three surfaces (issues-list dropdown, ' +
          'report scope, dashboard data source). It is the most visible i18n hole because ' +
          "the dropdown's chrome is fully localised — the row names stand out as the only " +
          'untranslated text.\n\n' +
          '**Fix shapes (decide at fix time — option 1 is the durable shape the comment ' +
          'asked for):**\n\n' +
          '1. **Client-side i18n via the slug (recommended; matches the design ' +
          'comment).** Add `slug` to `BuiltinFilterSummaryDto` (alongside `name`, or in ' +
          'place of it). Add a `savedFilters.builtinNames` block to `messages/en.json` and ' +
          '`messages/zh.json` keyed by slug ' +
          '(`my-open-issues / reported-by-me / all-issues / open-issues / done-issues / ' +
          'created-recently / updated-recently / resolved-recently`). Every UI consumer ' +
          'replaces `builtin.name` with ' +
          "`t(`savedFilters.builtinNames.${builtin.slug}`)`. The registry's English `name` " +
          'becomes the canonical FALLBACK (used only by tools / tests that have no `t` in ' +
          'scope), not the user-facing string. This is exactly what the ' +
          '`builtins.ts:33` comment described.\n' +
          '2. **Server-side localisation in the mapper.** Pass the request locale to ' +
          '`toBuiltinFilterSummaryDto`; resolve the localized name via a server-side ' +
          'message table; ship the localized string in `name`. Works, but it (a) bakes ' +
          'locale into the DTO (a row read returns a different shape per locale), (b) ' +
          'still leaves the registry as the English fallback for tools, and (c) is the ' +
          'opposite shape from the existing client-side i18n (everything else in the app ' +
          'uses `next-intl` on the client). Reject in favour of option 1.\n' +
          '3. **Inline `t` in each consumer over the slug.** Like option 1 but without ' +
          'adding a `savedFilters.builtinNames` namespace — each consumer has its own ' +
          'mapping table. Reject: violates DRY and the three consumers will drift.\n\n' +
          '**Recommended:** option 1. Single message namespace, slug-keyed, one DTO ' +
          'change, one `t(...)` call shape repeated across consumers. The registry stays ' +
          'as the source of slugs + the English fallback.\n\n' +
          '**Test gap that let it ship.** Existing tests likely verify the dropdown ' +
          'opens / lists the built-ins / applies a chosen filter — but assert against the ' +
          'English `name` directly, so the assertion would pass against any locale. The ' +
          'fix MUST add a test that:\n\n' +
          '- Renders `SavedFilterDropdown` (or any of the three consumers) under a `zh` ' +
          'next-intl `NextIntlClientProvider` wrapper.\n' +
          '- Asserts the rendered row labels are the **Chinese** strings, not the ' +
          'English ones.\n' +
          '- Asserts ALL eight built-ins translate (no half-translated regression).\n' +
          '- Re-renders under `en` and asserts the labels match the registry `name` ' +
          'literals (the en path stays green).\n\n' +
          '## Acceptance criteria\n\n' +
          '- In the `zh` locale, every built-in filter row in `SavedFilterDropdown` ' +
          'renders its Chinese label (8 strings: 我的待办 / 我报告的 / 全部事项 / 待办 / ' +
          '已完成 / 最近创建 / 最近更新 / 最近已解决 — exact wording to be confirmed at ' +
          'fix time against the existing translation style in `messages/zh.json`; the ' +
          'Chinese above is illustrative).\n' +
          '- Same in every other consumer that lists built-in saved filters — the report ' +
          'scope picker (`ReportScopeCombobox`) and the dashboard data-source picker ' +
          '(`DataSourceField`). Audit the call sites; each one must thread `t(...)` over ' +
          'the slug, not over `builtin.name`.\n' +
          '- The `en` locale renders the SAME English strings it does today (no ' +
          'regression of the green path).\n' +
          '- The `BuiltinFilterSummaryDto` carries `slug` (the locale-independent ' +
          'identifier). The `name` field MAY remain as the canonical English fallback for ' +
          'callers without a `t` in scope (tools, CLI, server-side logs), or MAY be ' +
          'dropped entirely if no such caller exists — decide at fix time.\n' +
          '- A render test asserts the Chinese labels under `zh` and the English labels ' +
          'under `en`, for all eight built-ins, in at least one consumer surface ' +
          '(`SavedFilterDropdown` recommended; the others share the same DTO + ' +
          "`t(...)` shape so one consumer's coverage is enough).\n" +
          '- The `lib/savedFilters/builtins.ts:33` comment is UPDATED to reflect the ' +
          'now-wired pattern ("English fallback; the UI threads ' +
          "`t('savedFilters.builtinNames.<slug>')` for the localised label\") so the " +
          'next reader of the registry sees the contract honoured rather than the ' +
          'broken promise.\n' +
          '- AA contrast preserved; no service / DTO transport change beyond adding ' +
          '`slug` to `BuiltinFilterSummaryDto`; no route change.\n\n' +
          '## Context refs\n\n' +
          '- `lib/savedFilters/builtins.ts:29-112` — the `BUILTIN_FILTERS` registry; the ' +
          'comment at line 33 documents the design intent (and names the gap). The eight ' +
          'slugs are the i18n keys.\n' +
          '- `lib/mappers/savedFilterMappers.ts:39` — `toBuiltinFilterSummaryDto`; where ' +
          '`def.name` leaks into the DTO unmediated.\n' +
          '- `lib/dto/savedFilters.ts` — `BuiltinFilterSummaryDto` definition; `slug` ' +
          'addition lands here.\n' +
          '- `app/(authed)/issues/_components/SavedFilterDropdown.tsx:480` — the issues-' +
          'list dropdown that renders `label={builtin.name}` directly (the most visible ' +
          'consumer; the screenshot surface).\n' +
          '- `app/(authed)/reports/_components/ReportScopeCombobox.tsx:54` — ' +
          '`label: f.name` for the report scope picker; second consumer.\n' +
          '- `app/(authed)/dashboard/_components/DataSourceField.tsx` — the dashboard ' +
          'data-source picker; third consumer (Saved filter mode).\n' +
          '- `messages/en.json:1893-...` + `messages/zh.json:1985-...` — the `savedFilters` ' +
          'i18n block; the `savedFilters.builtinNames.<slug>` keys land here.\n' +
          '- `bug-backlog-zh-sprint-translated-as-chongci` (sibling i18n bug) — the ' +
          'sprint/冲刺 mistranslation precedent; same shape as this one (i18n string ' +
          'mistakenly literal-shipped through to a `zh` surface).\n' +
          '- `motir-core/CLAUDE.md` — i18n strings live in `messages/{en,zh}.json`; ' +
          'service mappers carry locale-independent shapes (the DTO contract).\n\n' +
          '**Refactor signal (rule of three watch).** This is the SECOND i18n leak we ' +
          'have logged where a server-side English literal ships untranslated to a ' +
          '`zh`-localised UI surface — first was ' +
          '`bug-backlog-zh-sprint-translated-as-chongci` (the sprint label, fixed in ' +
          'PR #502), now this one (the eight built-in filter names). Both share the same ' +
          'underlying defect: a server-shipped human-readable string that should have ' +
          'been a locale-independent KEY (slug / id) for the client to thread `t(...)` ' +
          'over. If a third surface ships this way (e.g. workflow status labels, ' +
          'priority labels, or kind labels), the fix is no longer "thread `t(...)` per ' +
          'consumer" — it is a lint rule (or a typed `LocalizedString` DTO field) that ' +
          'forbids server-shipped user-facing English from crossing the boundary.',
      },
      {
        id: 'bug-combobox-menu-clipped-inside-modal',
        kind: 'bug',
        title:
          'Combobox listbox is clipped by the Modal when opened inside a dialog (Add-widget config modal — Statistic type picker shows only the first 1–2 options)',
        status: 'planned',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 6 (where the bug was DISCOVERED) · ' +
          '**Surfaces:** any `Combobox` opened inside a `Modal`; the concrete repro is the ' +
          'dashboard **Add widget → Distribution → Statistic type** picker ' +
          '(`app/(authed)/dashboard/_components/WidgetConfigModal.tsx`, Subtask 6.3.5; ' +
          'shared component `components/ui/Combobox.tsx`, `components/ui/Modal.tsx`) · ' +
          '**Status:** open · **Reported by:** Yue.\n\n' +
          'When a `Combobox` listbox opens inside a `Modal`, the open menu is **clipped by ' +
          "the modal's `overflow-hidden` boundary** instead of extending below the modal or " +
          'inside a scroll region. In the reported repro (Add Distribution widget, dark ' +
          'theme), the **Statistic type** picker shows only the first two options ' +
          '(`Status`, partial `Assignee`) and the rest (`Priority`, `Issue type`, `Reporter`, ' +
          'custom fields, etc.) are visually cut off at the bottom edge of the modal — the ' +
          'list is unreachable without keyboard arrowing blindly past the visible items. The ' +
          'modal itself shows no scroll affordance because the listbox is `position: absolute` ' +
          'relative to the trigger and lives OUTSIDE the modal-body scroll flow.\n\n' +
          '**Repro.** Sign in as `zhuyue@motir.co` / `!QAZ1qaz`, open the `moooon` / ' +
          '`motir` project → dashboard, click **Add widget**, pick the **Distribution** ' +
          'type. In the modal, leave Data source = `Project` and the project = `motir` ' +
          '(the defaults), then click the **Statistic type** combobox. Observe: the ' +
          'options panel opens below the trigger but the lower half of the option list is ' +
          'clipped at the bottom of the modal. The full list has at least 5–7 options ' +
          '(Status, Assignee, Priority, Issue type, Reporter, plus any custom fields) — ' +
          'only the first 1–2 are visible.\n\n' +
          '**Root cause (high confidence — the source comments document it).** ' +
          '`components/ui/Combobox.tsx` deliberately branches its menu rendering by parent ' +
          'context (lines ~125-134, ~294-298, ~386-413):\n\n' +
          '- **Outside a dialog** → the menu is **portaled to `document.body`** with ' +
          '`position: fixed` viewport-anchored positioning, so it escapes every overflow ' +
          "ancestor (this is the `bug-inline-edit-clipped-when-table-short` fix's posture).\n" +
          '- **Inside a Radix Dialog** (`triggerRef.current?.closest("[role=\\"dialog\\"]")`) ' +
          '→ the menu is rendered **INLINE** as ' +
          '`absolute left-0 top-full ... w-max min-w-full max-w-[18rem]` inside the ' +
          "trigger's `relative` container, because a portal would land outside the dialog's " +
          'focus scope (focus-trap war, source comment line 128) AND a portaled menu would ' +
          "be mis-positioned by the dialog's centering `translate`.\n\n" +
          "The inline menu sits inside the modal's `flex max-h-[90vh] flex-col " +
          'overflow-hidden` content panel (`components/ui/Modal.tsx:39`). `overflow-hidden` ' +
          'on the modal panel **clips the absolutely-positioned menu** the moment its ' +
          "bottom edge crosses the modal's bottom edge. The `menuInner` listbox carries " +
          '`max-h-64` (`16rem`) as a fallback cap, but that 16rem is **still taller than ' +
          'the remaining vertical space inside the modal** when the trigger sits in the ' +
          'lower half of a sm-width modal (Widget config modal is `size="sm"` = ' +
          '`max-w-[24rem]`, with several stacked fields above the Statistic-type trigger ' +
          '— Data source toggle, Project picker, the trigger itself).\n\n' +
          '**Net:** the inline branch sacrifices reachability for the focus-trap and ' +
          'positioning correctness it gains. The source comment claims **"A dialog scrolls ' +
          'rather than short-clips, so inline is both safe and the original, proven ' +
          "behaviour\"** — that's only true if the menu participates in the dialog's body " +
          "scroll flow, but an `absolute` child does NOT contribute to the body's scroll " +
          'height. The body has nowhere to scroll TO; the menu just renders past the ' +
          'overflow-hidden boundary and gets clipped.\n\n' +
          "**Sibling case to verify the fix doesn't regress** (the comment names " +
          'it): **`bug-inline-edit-clipped-when-table-short`** — the original case the ' +
          'body-portal branch was added for (a `Combobox` opened inline-edit in a TABLE ' +
          'cell, the table was short, `overflow:hidden` clipped the menu). That is the ' +
          'TABLE shape; this bug is the MODAL shape. Same underlying defect ' +
          '("popover clipped by an ancestor\'s overflow") in a different parent. The ' +
          'fix must work for BOTH shapes without re-breaking either.\n\n' +
          '**Fix shapes (decide at fix time — listed by likely durability):**\n' +
          "1. **Clamp the inline menu's height to the modal's available space** " +
          '(durable). When `inDialog` is true, compute `listMaxHeight` from the ' +
          "containing dialog's bottom edge minus the trigger's bottom edge (with a small " +
          "gap), and set the listbox's `maxHeight` to that — same shape as the portaled " +
          'branch already does against the viewport (`Combobox.tsx:166-189`), just ' +
          'measured against `triggerRef.current.closest("[role=\\"dialog\\"]").getBoundingClientRect()` ' +
          "instead of `window.innerHeight`. The menu then SCROLLS INTERNALLY (it's a " +
          '`max-h` listbox with `overflow-y-auto` — confirm in `menuInner`), the modal ' +
          "doesn't, and clipping is gone. This honours the inline-rendering invariant the " +
          'comment defends.\n' +
          '2. **Flip the menu above the trigger when the space below is shorter** ' +
          '(complement of fix 1). The portaled branch already does this; mirror it for ' +
          'inline. Combine with fix 1 so the menu picks the taller side AND clamps to it.\n' +
          "3. **Use Radix Dialog's `forceMount` + a contained portal target** (the " +
          'durable architectural fix; bigger change). Pass an `aside` portal target to ' +
          "the menu that's INSIDE the dialog's focus scope (e.g. mount a portal target as " +
          'a sibling of the modal body but outside `overflow-hidden`). This solves both ' +
          'this bug and any future "menu inside dialog" case in one place. Higher-touch — ' +
          "evaluate against the existing Combobox's contract before reaching for it.\n\n" +
          '**Recommended:** fix 1 + fix 2 together — minimal-touch, contained to the ' +
          'inline branch of `Combobox.tsx`, no Modal API change. The portaled branch is ' +
          'untouched (table-short bug stays fixed). Reserve fix 3 if a third occurrence ' +
          'surfaces (rule of three; see refactor signal below).\n\n' +
          '**Test gap that let it ship.** Existing tests for `Combobox` likely cover the ' +
          "portaled (outside-dialog) branch and the inline branch's **opens/closes/" +
          'keyboard-nav** semantics, but not its **rendered geometry inside a constrained ' +
          'parent**. The fix MUST add either a render-test or Playwright assertion: open ' +
          "the menu inside a modal whose remaining space is < the menu's natural height, " +
          "measure the listbox's `getBoundingClientRect()`, and assert it FITS inside the " +
          "modal's rect (`menuBottom <= dialogBottom - gap`). Same measurement posture as " +
          'the Epic-3 swimlane / Epic-6 detail-overflow bugs — geometry, not CSS.\n\n' +
          '## Acceptance criteria\n\n' +
          '- In the dashboard Add-widget config modal (`size="sm"`), the Statistic-type ' +
          'combobox menu is **fully reachable**: either the menu fits inside the modal ' +
          '(clamped + internally scrollable), or it flips above the trigger if that side ' +
          "has more room. No options are clipped by the modal's overflow-hidden boundary.\n" +
          '- The fix is in `components/ui/Combobox.tsx` (the inline branch) — not a ' +
          'workaround on the consumer side (`WidgetConfigModal.tsx`), so every other ' +
          '`Combobox`-in-`Modal` site benefits automatically (e.g. issue create / edit ' +
          'modals, sprint dialogs, project settings dialogs). Audit the existing call sites ' +
          'and confirm each renders correctly after the fix.\n' +
          '- The portaled (outside-dialog) branch is UNCHANGED in behaviour — inline-edit ' +
          'cells inside a short table still render the menu via the body portal ' +
          '(`bug-inline-edit-clipped-when-table-short` stays fixed). Verify with the ' +
          'existing inline-edit test fixtures.\n' +
          '- The menu still respects the focus-trap (Tab cycles inside the dialog; Escape ' +
          'closes the menu, not the dialog — the `data-inner-dismiss` mechanism stays ' +
          'intact). a11y axe sweep on the Add-widget modal stays clean.\n' +
          "- A Playwright (or RTL render) regression asserts the listbox's rendered " +
          "bottom-edge fits inside the dialog's rendered bottom-edge when a tall option " +
          'list opens near the bottom of a short modal — measured via ' +
          '`getBoundingClientRect`, not CSS rules.\n' +
          '- AA contrast preserved; next-intl strings unchanged; no service / DTO / route ' +
          'change.\n\n' +
          '## Context refs\n\n' +
          '- `components/ui/Combobox.tsx:125-134, 294-298, 386-413` — the inline-vs-portal ' +
          "branch + the inline branch's `absolute left-0 top-full` rendering (the fix site)\n" +
          '- `components/ui/Combobox.tsx:166-189` (`updatePosition`) — the portaled ' +
          "branch's viewport-clamping logic to mirror against the dialog rect for the " +
          'inline branch\n' +
          '- `components/ui/Modal.tsx:28-67` — the modal `contentVariants`; ' +
          '`flex max-h-[90vh] flex-col overflow-hidden` is the clipping boundary, by ' +
          "design (the modal MUST stay capped — the fix can't drop `overflow-hidden`)\n" +
          '- `app/(authed)/dashboard/_components/WidgetConfigModal.tsx:201-292` — the ' +
          'concrete repro surface (Subtask 6.3.5)\n' +
          '- `bug-inline-edit-clipped-when-table-short` (sibling) — the original ' +
          'table-overflow case that justified the portaled branch; the contract this fix ' +
          'must NOT regress\n' +
          '- `bug-board-cannot-drag-from-in-review-to-done`, ' +
          '`bug-reports-landing-charts-sized-for-widget-tile-not-page`, ' +
          '`bug-issue-detail-eyebrow-overflows-viewport` (sibling Epic 6 bugs) — the ' +
          'cluster of Epic 6 surfaces hitting layout / overflow defects this PR-cycle\n' +
          '- `motir-core/CLAUDE.md` — colour via `--el-*`, shape via element-shape tokens ' +
          '(applies to whatever wrapper the fix introduces)\n\n' +
          '**Refactor signal (rule of two → three).** This is the SECOND documented ' +
          'occurrence of "menu/popover clipped by an ancestor\'s overflow" — first was ' +
          '`bug-inline-edit-clipped-when-table-short` (table, fixed by adding the body-' +
          'portal branch), now this one (modal, the inline branch fails the same way ' +
          'in reverse). The Combobox already encodes both branches inside one component ' +
          'with a `closest("[role=\\"dialog\\"]")` switch — the per-context-branch shape ' +
          'is workable for two. If a third occurrence surfaces (e.g. a sticky-header ' +
          'data-grid or a drawer panel with its own focus scope), unify behind a single ' +
          'overflow-escape primitive instead of a third branch.',
      },
    ],
  },
  {
    id: '7',
    title: 'AI Planning Layer',
    status: 'in_progress',
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
      'audit passes; this is a deliberate deviation, not the mistake the rule guards against.)\n\n' +
      '**Locked AI architecture (the Epic-7 planning discussion with Yue, 2026-06-11; full ' +
      'rationale in story-7.1.ts; each story carries its slice):**\n\n' +
      '1. **One-directional writes.** motir-core is the system of record; the AI NEVER writes the ' +
      'tree. motir-core calls motir-ai to GENERATE → motir-ai returns a tree-DELTA → motir-core ' +
      'persists via the shipped `workItemsService`. Generate→human-approve→persist (Principle #3).\n' +
      '2. **A tool-use SESSION, not a one-shot call.** Planning context is non-local, so motir-ai ' +
      'HOSTS the planning agent and reads on demand; the whole tree is reachable every job, ' +
      "transmitted never. Context scales by the operation's blast radius (push bounded ops; " +
      'skeleton + retrieve for unbounded augment).\n' +
      '3. **Graph-traversal, not RAG.** Two explicit relational graphs walked over MCP, no vector ' +
      'store — the **plan tree** (motir-core: rollup + is_blocked_by + comments) and the **code ' +
      'graph** (motir-ai: `codegraph` embedded, GitHub-read-fed, webhook-refreshed). The verified ' +
      'Atlassian-Rovo mirror (Teamwork Graph; notes.html #33 — checked, not asserted).\n' +
      '4. **Async job model** serving BOTH the 7.2 chat and the headless MCP/CLI planners (7.9) — ' +
      'two co-equal front doors over one 7.1 boundary.\n' +
      '5. **motir-ai is STATEFUL** (headless ≠ stateless): its own DB holds the three context ' +
      'stores with no home in an open PM tool — direction docs (7.2), planning-mistakes (7.10), ' +
      'code graph (7.5/7.7). This is `motir-meta` productized, and it SHARPENS the open-core line ' +
      '(motir-core stays a complete, exportable Jira clone with zero AI tables).\n\n' +
      '**Two project kinds:** start-fresh (shipped first) and existing-project migration. ' +
      '**Story 7.10** (planning-mistakes store + learning loop) was added in the same pass — the ' +
      'orphaned-deferral fix for the third motir-ai store.\n\n' +
      '**Augmentation 2026-06-12 — Stories 7.11–7.13** (six user-flagged feature gaps): ' +
      '**7.11** cadence — an auto-planning trigger (expand when the ready set drains) + AI sprint ' +
      'planning into SHORT 2–3 day sprints (coding-agent cadence, not human 1–2 week) + the AI ' +
      'project-settings surface; **7.12** planning metering + token accounting + an internal ' +
      'CREDIT ledger (credits normalize per-model token cost × margin; pricing/checkout UI defers ' +
      'to Epic 8, the data lands now); **7.13** contextual planning from every work item (chat on ' +
      'any issue to expand/modify it, its siblings, or its parent — confirmation ALWAYS required ' +
      'before any tree write). The same pass added **Story 2.7** (work-item type + executor) in ' +
      'Epic 2 and an explanation-generation toggle (7.3.8). Every new dep points backward — the ' +
      'ordering audit stays clean.',
  },
  {
    id: '8',
    title: 'Launch readiness',
    status: 'in_progress',
    descriptionMd:
      'Everything between "feature complete" and "live, paid users." Stripe billing, marketing ' +
      'site + the Motir brand mark, go-to-market strategy, the one-time Prodect → Motir rebrand ' +
      'cutover, ToS + privacy policy, transactional email, basic analytics, production deploy, ' +
      'domain + SSL, onboarding, and day-1 admin tools. Most of this is human subtasks ' +
      "running through Motir's own queue. (Formerly Epic 5.)",
    items: [
      {
        id: 'bug-e2e-suite-flaky-specs',
        kind: 'bug',
        title:
          'E2E suite has flaky specs that intermittently red CI on unrelated PRs (drag-reorder reload, at-scale cursor paging, inline-edit reload, watch-popover hydration)',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 8 (cross-cutting test-suite stability — a green, ' +
          'reliable CI is a launch gate) · **Surfaces:** the Playwright E2E job (`tests/e2e/*`) · ' +
          '**Status:** open · **Reported by:** Yue.\n\n' +
          'The `Playwright E2E` CI job is **flaky** — a handful of specs fail intermittently from ' +
          'timing/hydration races, not from real product regressions. Because PR CI runs each ' +
          "branch MERGED with `main`, a flaky spec reds **any** open PR's E2E job regardless of " +
          'what that PR changed, forcing blind re-runs (observed blocking #836 and #864). The ' +
          'app behaviour under test is correct; the **tests** race the UI.\n\n' +
          '**Observed (PR #864 E2E run — `195 passed`, `4 flaky`, `1 failed`):**\n' +
          '1. `tests/e2e/labels-components-watch.spec.ts:341` — `@smoke watching: auto-watch on ' +
          'create, the W shortcut + typing guard, the popover roster, admin add, and the watcher ' +
          'emails`. **Failed all retries** this run: `expect(watch).toHaveAttribute(' +
          "'aria-pressed', 'false')` got `'true'` — the auto-watch-on-create state / popover " +
          'mounts before the assertion settles (hydration race; the first interaction on a ' +
          'freshly-loaded page is swallowed — the finding-#89 pattern).\n' +
          '2. `tests/e2e/attachments.spec.ts:228` — `at scale the read stays cursor-paged: 50 + ' +
          '"Show more" … (finding #57)`. Flaky: `expect(list.getByRole(\'listitem\')).toHaveCount' +
          '(100)` got `50` — the assertion races the lazy-load / "Show more" fetch (assert on the ' +
          'response/loaded state, not a fixed count after a click).\n' +
          '3. `tests/e2e/backlog.spec.ts:128` — `grooming session › drag-reorder a backlog row ' +
          'writes a single rank and the order survives reload`. Flaky: the post-reload order ' +
          "doesn't match the expected order — the dnd-kit reorder's persist PATCH races (the " +
          'reorder-drag vs viewport-bottom autoscroll class of bug: capture bbox after scrolling ' +
          'the target into view, drop on a concrete target, and `waitForResponse(PATCH→200)` ' +
          'BEFORE reloading).\n' +
          '4. `tests/e2e/dashboards.spec.ts:181` — `dashboards @smoke › A — create a workspace ' +
          'dashboard, add three widgets, switch layout, drag, reload persists`. Flaky: ' +
          '`expect((await moveResp).status()).toBe(200)` — the layout-move PATCH never fires / is ' +
          'still pending when awaited (same dnd persist race as #3).\n' +
          '5. `tests/e2e/estimation.spec.ts:89` — `estimate a backlog story via the inline picker ' +
          '— the badge updates and survives reload`. Flaky: ' +
          '`toHaveAccessibleName(...)` still reads the pre-estimate "Set story points" — the ' +
          'inline-edit commit / reload races (assert the persisted value via the success response ' +
          'before reload).\n\n' +
          '**Root-cause themes (verify per spec in the fix).** All five are TEST-side timing ' +
          'races, not product bugs: (a) **hydration churn swallowing the first click/keypress** on ' +
          'a freshly-loaded page — retry the load-time interaction / wait for a hydration signal; ' +
          '(b) **dnd-kit reorder persist** — scroll the target into view, drop on a concrete ' +
          'target element (never empty space), `waitForResponse(PATCH→200)` before asserting or ' +
          'reloading; (c) **at-scale lazy-load / reload reads** — wait for the network response or ' +
          'a settled DOM signal, never a fixed count or bare `waitForTimeout`. These match the ' +
          'recurring gotchas already learned on this suite (the reorder-drag/autoscroll bug, the ' +
          'cold-route/sign-in/hydration lane notes).\n\n' +
          '## Acceptance criteria\n\n' +
          '- Each of the five listed specs is hardened so it passes **5 consecutive full CI E2E ' +
          'runs with zero flakes** (not a single green run — re-run to prove it).\n' +
          '- Fixes are TEST-side: replace fixed sleeps with state/response waits; retry ' +
          'load-time interactions (click/keypress) that hydration can swallow; for dnd, scroll the ' +
          'target into view + drop on a concrete target + `waitForResponse(PATCH 200)` before ' +
          'asserting/reloading.\n' +
          '- **No product-code change** unless the investigation surfaces a REAL app race (e.g. an ' +
          'optimistic update that does not reconcile) — if so, fix it and note it explicitly; ' +
          'otherwise the app is correct and only the specs change.\n' +
          '- The `@axe` / a11y and data assertions the specs already make are preserved (harden ' +
          'the timing, do not weaken the coverage).\n\n' +
          '## Context refs\n\n' +
          '- `tests/e2e/labels-components-watch.spec.ts` (≈ line 341 — the watch @smoke journey)\n' +
          '- `tests/e2e/attachments.spec.ts` (≈ line 228 — at-scale cursor paging, finding #57)\n' +
          '- `tests/e2e/backlog.spec.ts` (≈ line 128 — grooming drag-reorder survives reload)\n' +
          '- `tests/e2e/dashboards.spec.ts` (≈ line 181 — layout drag + reload persists)\n' +
          '- `tests/e2e/estimation.spec.ts` (≈ line 89 — inline estimate survives reload)\n' +
          '- `tests/e2e/_helpers/*` (the shared `signIn` / `db-reset` harness) + ' +
          '`playwright.config.ts` (retries, webServer) — the place to add a shared ' +
          'hydration-ready / drag + persist helper rather than fixing each spec ad hoc\n\n' +
          '**Closed (2026-06-13): PR #873 merged.** All five specs were fixed at the ROOT — ' +
          'each now waits on the AUTHORITATIVE completion signal instead of racing the ' +
          'optimistic / async UI: drag-reorder and inline-edit assert the write `response` ' +
          '(status + body) before `reload()`; at-scale paging awaits the lazy-load fetch ' +
          'before asserting counts; dnd moves retry until the move commits (closestCorners ' +
          'can resolve a stale `over`); the watch toggle got a `seq` guard so an older ' +
          'reconcile can’t clobber the newest optimistic state, and the watch-popover ' +
          'click is retried past hydration churn. The discipline was codified as a ' +
          'CLAUDE.md rule (“E2E tests wait on the AUTHORITATIVE signal”, PR #874) and ' +
          'notes.html mistake #37 so the shape doesn’t recur. Verified green in CI; the ' +
          'EstimateBadge optimistic-keep fix that the estimation spec needed shipped in the ' +
          'same PR.',
      },
      {
        id: 'bug-e2e-custom-fields-empty-state-hydration-flake',
        kind: 'bug',
        title:
          'Custom-fields E2E spec flakes on the Fields-admin empty state — finding-#89 hydration churn recurs on a surface bug-e2e-suite-flaky-specs did not cover',
        status: 'in_progress',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 8 (cross-cutting test-suite stability — a green CI is ' +
          'a launch gate) · **Surfaces:** the `Playwright E2E` job ' +
          '(`tests/e2e/custom-fields.spec.ts`) · **Status:** open · **Reported by:** Yue.\n\n' +
          'A NEW manifestation of the same finding-#89 hydration-churn class that ' +
          '`bug-e2e-suite-flaky-specs` (DONE, PR #873) hardened — but on a spec that bug did NOT ' +
          'cover, so it recurs. Observed reding the `Playwright E2E (bulk-2)` leg on **PR #891** — ' +
          'a Vitest-ONLY change (per-worker test DB isolation) that touches no E2E code, so the ' +
          'red is purely an inherited flake: the merge-with-`main` CI taxing an unrelated PR, ' +
          'exactly the cost the parent bug + the CLAUDE.md “wait on the AUTHORITATIVE signal” rule ' +
          'describe.\n\n' +
          '**The failure (PR #891, run 27473371705 — `55 passed`, `1 failed`):** ' +
          '`tests/e2e/custom-fields.spec.ts:195` › “the PM defines the five field types …”. ' +
          '**Failed initial + retry #1.** The first assertion after `gotoFields()` on a ' +
          'freshly-seeded tenant (line ~204): `await expect(page.getByText(' +
          "'No custom fields yet')).toBeVisible()` timed out at 5000ms. The tenant is brand new " +
          '(`seedTenant`), so the empty state is trivially correct — the TEST raced the render.\n\n' +
          '**Root cause (the finding-#89 shape).** The WebServer log for the run is flooded with ' +
          '`next-intl` `ENVIRONMENT_FALLBACK: the \`now\` parameter wasn’t provided to ' +
          '\`relativeTime\`` warnings, then `Uncaught Error: Hydration failed because the server ' +
          'rendered text didn’t match the client`. A relative-time value rendered without a stable ' +
          '`now` mismatches between SSR and client → React regenerates the tree on hydration → the ' +
          'Fields-admin empty-state paint is delayed past the 5s `toBeVisible` window. Same class ' +
          'as finding #89 (relative-time SSR/client mismatch hydration-fails a page and swallows ' +
          'early interactions); the parent bug fixed five OTHER specs, not this surface.\n\n' +
          '**Preferred fix is PRODUCT-side, not per-spec (kills the whole class).** The recurring ' +
          'tell is the `ENVIRONMENT_FALLBACK` for `relativeTime`: next-intl renders relative times ' +
          'without a provided `now` (and/or `timeZone`), which is what causes the SSR/client ' +
          'mismatch + hydration churn everywhere it appears. Provide a stable `now`/`timeZone` to ' +
          'the next-intl provider (or pass `now` at each `format.relativeTime` call) so the warning ' +
          '— and the hydration regeneration it triggers — stops across ALL pages, not just this ' +
          'spec. That is more durable than re-timing one assertion. Only if the app proves correct ' +
          'and it is purely a test race should the fallback be test-side (wait on a ' +
          'hydration-settled / response signal, per the parent bug’s pattern). Per the decision ' +
          'ladder, the `ENVIRONMENT_FALLBACK` is a real config gap, so removing it is the root ' +
          'fix.\n\n' +
          '## Acceptance criteria\n\n' +
          '- `tests/e2e/custom-fields.spec.ts` passes **5 consecutive full CI E2E runs with zero ' +
          'flakes** (re-run to prove it, per the parent bug’s bar).\n' +
          '- The `next-intl` `ENVIRONMENT_FALLBACK` (`relativeTime`) warnings + the “Hydration ' +
          'failed” errors are GONE from the E2E WebServer log on the affected pages — the root ' +
          'cause removed, not just the one assertion re-timed. If a stable `now`/`timeZone` is ' +
          'supplied to next-intl, confirm relative times still render correctly in the app.\n' +
          '- Fix is product-side IF the `ENVIRONMENT_FALLBACK` is a real config gap (preferred); ' +
          'otherwise test-side timing hardening, stated explicitly. No coverage weakened.\n' +
          '- Sweep for the SAME `ENVIRONMENT_FALLBACK`/hydration tell on specs not in the parent ' +
          'bug’s five (it is a class, not a one-off) and fold them in.\n\n' +
          '## Context refs\n\n' +
          "- `tests/e2e/custom-fields.spec.ts` (≈ line 204 — the `'No custom fields yet'` " +
          'empty-state assertion that timed out).\n' +
          '- `bug-e2e-suite-flaky-specs` (this Epic, DONE via PR #873) — the parent class + the ' +
          'authoritative-signal discipline; this is the same shape on an uncovered surface.\n' +
          '- `notes.html` mistake #37 + the CLAUDE.md “E2E tests wait on the AUTHORITATIVE signal” ' +
          'rule; finding #89 (relative-time SSR/client mismatch hydration flake).\n' +
          '- The `next-intl` provider wiring (`NextIntlClientProvider` / the request config that ' +
          'sets `now` / `timeZone`) — where to supply a stable `now` so `relativeTime` stops ' +
          'falling back.',
      },
    ],
  },
  {
    id: '9',
    title: 'Native AI coding (hosted agent execution)',
    status: 'planned',
    descriptionMd:
      'The **third layer of the pipeline made native** — Motir runs the coding agent in a ' +
      "HOSTED cloud sandbox on the user's behalf. Until now Motir shipped only the **external-" +
      'agent (BYOK)** form of AI coding (7.6 generates a prompt, the user runs it in their own ' +
      'agent — locally, optionally in the 7.9.7 sandbox container). This epic adds the hosted ' +
      'runtime the vision reserved as "a **designed-for extension that augments — not replaces — ' +
      'the external-agent path**" (MOTIR.md § What Motir is) — previously noted as a decided ' +
      'follow-up BEYOND the eight planned epics, now planned (2026-06-12, Yue: "plan one step ' +
      'further — host the container as the coding agent").\n\n' +
      '**The hosted run mirrors the verified cloud-agent lifecycle** (Devin / Google Jules / ' +
      'OpenAI Codex cloud / GitHub Copilot coding agent): a dispatched ticket → provision a ' +
      'container-per-run sandbox → the agent autonomously edits + tests → opens a PR → human ' +
      'review. Billing is **usage-based**, reusing the Epic-7 credit system: hosted CODING runs ' +
      'spend tokens and debit the SAME 7.12 credit ledger as planning (one balance covers both).\n\n' +
      '**Builds entirely on Epic 7 — backward deps only:** the 7.9.7 multi-agent sandbox image ' +
      '(the hosted image extends it), 7.6 dispatch (a hosted run is a dispatch-target variant), ' +
      'and 7.12 metering + credits (the token-usage report records an `AgentRun` and debits the ' +
      'ledger). **Story 9.0** is the LLM metering gateway (fork of one-api) every hosted run ' +
      'meters through; **Story 9.1** is the hosted-execution foundation — the hosted container + ' +
      'run-scoped auth (the user is logged in INSIDE the run) + gateway-metered token usage; ' +
      '**Story 9.2** adds the runtime DESIGN-APPROVAL gate — distinct from MOTIR.md’s ' +
      'planning-time design gate: when the hosted agent PRODUCES a design in `motir auto`, a ' +
      'deployed preview (iframe) + a revise-chat hold the dependent subtasks on the user’s ' +
      'manual approval (per-project, default ON; the preview is undeployed on approval to cap ' +
      'cost). Future 9.x stories (deferred not forgotten): the PR review/iteration loop, ' +
      'multi-agent / parallel hosted runs, agent-selection policy, hosted-run pricing in the ' +
      'Epic-8 billing surface, and security hardening.',
  },
  {
    id: '10',
    title: 'Platform administration & operations',
    status: 'planned',
    descriptionMd:
      'The **Motir-internal operator console** — everything a SaaS platform team needs to run the ' +
      'system across ALL tenants, plus the home for the cross-tenant governance the customer-facing ' +
      'epics deliberately keep out. Added 2026-06-12 (Yue: "the admin board of the whole system"). ' +
      'Distinct from the per-tenant admin already in Epic 6 (roles 6.4, project/workspace settings): ' +
      'this is **platform staff**, gated by a superadmin role SEPARATE from tenant `MemberRole`, ' +
      'reading ACROSS tenants (audited).\n\n' +
      '**Stories:** **10.1** the superadmin console — an all-tenant overview (orgs/workspaces/' +
      'projects/users) + **token/credit usage rollups** (project→workspace→org→platform, per-model, ' +
      'top consumers); **10.2** system monitoring — INTEGRATED read-only from **Vercel** (deploys / ' +
      'function errors / traffic) + **Inngest** (job runs / failures / throughput / backlog) + the ' +
      '9.0 gateway + DB health, link-out not rebuild; **10.3** the governance toolkit — credit ' +
      'grants/adjustments, plan/tier management, org suspend/reactivate, time-boxed audited ' +
      'support impersonation, per-org feature flags / kill-switches, and a tamper-evident ' +
      '(hash-chained) admin audit log.\n\n' +
      '**Builds backward on:** the Epic-6 **Organization** tier (6.10 — the billing entity usage ' +
      'rolls up to), 7.12 metering + credit ledger, and 9.0 gateway spend. The **Triage inbox** ' +
      '(bug/feature intake → promote) is a customer-facing PM feature and lives in Epic 6 (6.11), ' +
      'not here. Future 10.x (named in the story headers, deferred not forgotten): abuse / content ' +
      'moderation, DSAR / compliance export-delete, status & maintenance banners, email-delivery ops.',
  },
];
