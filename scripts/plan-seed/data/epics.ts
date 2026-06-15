import type { EpicMeta, PlanItem } from '../types';

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
      "this isn't solid, every other epic builds on sand. All 8 stories (1.0–1.6) shipped; a " +
      'post-completion legal-posture task (1.7 — CLA Assistant setup) was added when the open-core ' +
      'license boundary was reviewed (a CLA is required from day one if a future relicense — to ' +
      'BSL/SSPL — must remain optional without retroactive contributor consent chasing).',
    items: [
      {
        id: '1.7',
        kind: 'task',
        title: 'Set up CLA Assistant + commit Apache ICLA on motir-core',
        status: 'done',
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
          'ICLA grants moooon B.V. a broad license to the contribution; the contributor retains ' +
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
          '**"moooon B.V."** as the receiving party in §1. Save. CLA Assistant now hooks every ' +
          'PR on motir-core: it comments asking outside contributors to sign, and adds a ' +
          'required status check that turns green only once signed. (4) On a `seed/cla-setup` ' +
          'branch in motir-core, commit **`motir-core/CLA.md`** (the Apache ICLA text + a ' +
          "short preamble naming moooon B.V. and linking to CLA Assistant's signing flow) AND " +
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
          'name moooon B.V. as the receiving party.\n' +
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
          'moooon B.V. retains enough rights over `motir-core` to relicense if the open-core ' +
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
        status: 'done',
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
    status: 'done',
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
        status: 'done',
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
        status: 'done',
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
        id: 'bug-filters-directory-builtins-i18n-and-layout',
        kind: 'bug',
        title:
          'Filters directory (/filters): built-in filter names render in English, the search field renders collapsed, and the name column is too narrow — the FiltersDirectory table',
        status: 'done',
        type: 'bug',
        dependsOn: ['bug-builtin-filter-names-not-localized'],
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 6 (where the bug was DISCOVERED) · ' +
          '**Surface:** the saved-filters directory page `/filters` — ' +
          '`app/(authed)/filters/_components/FiltersDirectory.tsx` (Story 6.2 · ' +
          'Subtask 6.2.4) · **Status:** open · **Reported by:** Yue.\n\n' +
          'Three defects on the `/filters` directory table, reported together. Two of ' +
          'them (search field + name column) share ONE root cause; the third is the ' +
          'sibling i18n leak.\n\n' +
          '**Defect 1 — built-in filter names are not translated (i18n leak).** The ' +
          '`BuiltinFilterRow` renders the English registry literal directly: ' +
          '`app/(authed)/filters/_components/FiltersDirectory.tsx:506` reads ' +
          '`name={builtin.name}` (via the shared `ApplyNameButton`). This is the SAME ' +
          'defect as `bug-builtin-filter-names-not-localized` (the issues-list ' +
          '`SavedFilterDropdown`) — a SECOND consumer of the same DTO that the first ' +
          "fix's audit missed (the `/filters` directory lists the eight built-ins in " +
          'the same table as saved rows, under a `默认`-equivalent grouping). So under ' +
          '`zh` the built-in rows show `My open issues / All issues / …` while the rest ' +
          'of the table chrome is localised. **This defect DEPENDED ON ' +
          '`bug-builtin-filter-names-not-localized`** (PR #1007, now MERGED — so this ' +
          'card is `planned`/ready): that fix added `slug` to `BuiltinFilterSummaryDto` ' +
          'and the `savedFilters.builtinNames.<slug>` catalog block, so the fix here is ' +
          'a one-line change — `BuiltinFilterRow` passes ' +
          '`name={t(`builtinNames.${builtin.slug}`)}` instead of `builtin.name`. (The ' +
          'persisted saved-filter rows are user-authored text and correctly stay ' +
          'verbatim — only the eight built-ins need threading.)\n\n' +
          '**Defect 2 — the search field renders collapsed (the "search style is off").** ' +
          'The search `Input` is wrapped in `<div className="max-w-sm">` at ' +
          '`FiltersDirectory.tsx:195`. **`max-w-sm` is one of the named `max-w-*` ' +
          "utilities that are BROKEN in motir-core**: `app/globals.css`'s `@theme` " +
          'redefines the spacing scale and ships NO `--container-*` scale, so Tailwind ' +
          "v4's `max-w-{sm,md,lg,3xl}` resolve to a near-zero width and collapse the box " +
          'to roughly the addon-icon width (~40px). The search input therefore renders as ' +
          'a tiny icon-sized control rather than a full search field — which reads as ' +
          '"the search button style is off." The codebase already documents this trap ' +
          '(`app/(authed)/reports/_components/ReportPageChrome.tsx:36-38`, ' +
          '`app/(auth)/layout.tsx:16-18`, `app/tokens/markdown-editor/page.tsx:51-53`) ' +
          'and the established fix is an arbitrary rem value (e.g. `max-w-[20rem]`), used ' +
          'in ~70 places already.\n\n' +
          '**Defect 3 — the name column is too narrow.** SAME root cause as defect 2: the ' +
          '`ApplyNameButton` is capped by `className="group flex max-w-md items-start …"` ' +
          'at `FiltersDirectory.tsx:400`. `max-w-md` collapses the same way `max-w-sm` ' +
          'does, crushing the name button to ~40px so the filter name wraps / truncates ' +
          'hard even when the table has ample room. The `<th>`/`<td>` for the name column ' +
          'also carry no width hint, so once the button stops collapsing the name column ' +
          'should additionally be allowed to take the slack (e.g. a `w-full` / `min-w` on ' +
          'the name cell with `min-w-0` truncation on the button, per the ' +
          'min-w-0-overflow rule) so it is visibly the widest column. Fix at minimum the ' +
          'broken `max-w-md`; confirm the column then reads at a comfortable width against ' +
          'real names.\n\n' +
          '**Repro.** Sign in as `zhuyue@motir.co` / `!QAZ1qaz`, open `moooon` / `motir` ' +
          '→ `/filters`. (1) Set UI language to Chinese → the eight built-in rows stay ' +
          'English while the columns/chrome are `zh`. (2) In any locale, note the search ' +
          'field is collapsed to an icon-sized box at the top-left. (3) Note the filter ' +
          'name column is narrower than the content wants, truncating names that would ' +
          'otherwise fit.\n\n' +
          '**Fix shapes.**\n\n' +
          '1. **Defect 1 (i18n):** once `bug-builtin-filter-names-not-localized` lands, ' +
          'change `BuiltinFilterRow` to thread `t(`builtinNames.${builtin.slug}`)` over ' +
          'the slug (the DTO already carries `slug` by then). No new catalog keys — reuse ' +
          'the `savedFilters.builtinNames` block that fix added.\n' +
          '2. **Defects 2 & 3 (layout):** replace the broken named `max-w-sm` ' +
          '(search wrapper) and `max-w-md` (name button) with arbitrary rem values — the ' +
          'repo-wide workaround — and give the name column the width slack (so it is the ' +
          'widest column) while keeping `min-w-0` truncation. NO design subtask needed: ' +
          'this restores the INTENDED layout the broken utility silently ate, it does not ' +
          'invent a new one.\n\n' +
          '## Acceptance criteria\n\n' +
          '- In the `zh` locale, all eight built-in rows in the `/filters` directory ' +
          'render their Chinese labels (reusing `savedFilters.builtinNames`), matching ' +
          'the issues-list dropdown after `bug-builtin-filter-names-not-localized`. The ' +
          '`en` locale is unchanged.\n' +
          '- The search field renders at a normal search-input width (not collapsed to ' +
          'an icon-sized box) — no named `max-w-*` utility remains on the wrapper.\n' +
          '- The filter-name column renders comfortably wide (visibly the widest column), ' +
          'no longer truncating names that fit the table; the name button no longer ' +
          'carries a broken named `max-w-*`. Long names still truncate gracefully via ' +
          '`min-w-0`, not overflow.\n' +
          '- No named `max-w-{sm,md,lg,xl,2xl,3xl}` utilities remain in ' +
          '`FiltersDirectory.tsx` (grep clean); arbitrary rem values used instead.\n' +
          '- A render test (happy-dom) asserts the built-in rows localise under `zh` in ' +
          'the directory (mirrors the dropdown test from the sibling fix); existing ' +
          '`filters-directory.test.tsx` stays green.\n' +
          '- AA contrast and the design-system primitives (`Input`, `Button`, `Pill`) are ' +
          'preserved; no service / DTO / route change (pure client layout + i18n thread).\n\n' +
          '## Context refs\n\n' +
          '- `app/(authed)/filters/_components/FiltersDirectory.tsx:506` — ' +
          '`BuiltinFilterRow` renders `name={builtin.name}` (defect 1 fix site).\n' +
          '- `app/(authed)/filters/_components/FiltersDirectory.tsx:195` — the ' +
          '`max-w-sm` search wrapper (defect 2 fix site).\n' +
          '- `app/(authed)/filters/_components/FiltersDirectory.tsx:400` — the ' +
          '`ApplyNameButton` `max-w-md` cap (defect 3 fix site); the name `<th>`/`<td>` ' +
          'are at lines ~232 / ~440.\n' +
          '- `app/globals.css` `@theme` — redefines `--spacing-*` and ships NO ' +
          '`--container-*` scale, which is why named `max-w-{sm,md,3xl}` collapse.\n' +
          '- `app/(authed)/reports/_components/ReportPageChrome.tsx:36-38`, ' +
          '`app/(auth)/layout.tsx:16-18`, `app/tokens/markdown-editor/page.tsx:51-53` — ' +
          'the documented `max-w-[…rem]`-not-`max-w-3xl` workaround precedent.\n' +
          '- `bug-builtin-filter-names-not-localized` — the sibling i18n fix this card ' +
          'depends on; it adds `slug` to `BuiltinFilterSummaryDto` + the ' +
          '`savedFilters.builtinNames` catalog block this card reuses.\n' +
          '- `lib/mappers/savedFilterMappers.ts` — `toBuiltinFilterSummaryDto` (already ' +
          'ships `slug` once the sibling fix merges).\n' +
          '- `motir-core/CLAUDE.md` — shape/colour token rules; `motir-meta` design notes ' +
          'on the broken named `max-w-*` scale.\n\n' +
          '**Note (audit gap that let defect 1 ship).** ' +
          '`bug-builtin-filter-names-not-localized` fixed only the issues-list ' +
          '`SavedFilterDropdown`; its consumer audit concluded the report scope + ' +
          'dashboard pickers list no built-ins (true) but MISSED that the `/filters` ' +
          'directory table renders them too. When the next i18n-key-vs-literal bug is ' +
          'fixed, grep ALL consumers of the DTO (`BuiltinFilterSummaryDto`) before ' +
          'declaring the surface list complete.',
      },
      {
        id: 'bug-filters-directory-name-link-hover-aa-contrast',
        kind: 'bug',
        title:
          'Filters directory (/filters): the filter-name link on a HOVERED row fails AA contrast — --el-link (#0075de) on --el-surface-soft (#fafaf9) is 4.37:1 (needs 4.5:1)',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 6 (where the bug was DISCOVERED) · ' +
          '**Surface:** the saved-filters directory page `/filters` — the ' +
          '`ApplyNameButton` filter-name cell in ' +
          '`app/(authed)/filters/_components/FiltersDirectory.tsx` (Story 6.2 · ' +
          'Subtask 6.2.4) · **Status:** open · **Reported by:** axe sweep in ' +
          '`tests/e2e/saved-filters.spec.ts` (the dependents-warning test).\n\n' +
          'The filter-name cell renders the name as a hover-underlined link:\n' +
          '`<span class="truncate font-medium text-(--el-text) ' +
          'group-hover:text-(--el-link) group-hover:underline">…</span>` inside a row ' +
          'with `hover:bg-(--el-surface-soft)`. On HOVER the text turns ' +
          '`--el-link` (`#0075de`) while the row background turns ' +
          '`--el-surface-soft` (`#fafaf9`). That pair computes to **4.37:1**, below the ' +
          'WCAG 2.1 AA threshold of **4.5:1** for normal-weight text at 14px (10.5pt). ' +
          'axe flags it as a `color-contrast` violation on the name link (e.g. the ' +
          'built-in "Done issues" row).\n\n' +
          '**Why it surfaced intermittently (and why it is NOT the modal-clip bug PR).** ' +
          'The bad colour only applies on `group-hover`, so axe trips ONLY when the ' +
          'cursor happens to rest on a name row at the moment of the directory a11y ' +
          'sweep. That is cursor-position-dependent, so the same spec passed on the ' +
          'green `main` run at the base commit and failed on an UNRELATED PR ' +
          '(`bug-sprint-report-modal-clipped-burndown`, PR #1036) whose diff touches ' +
          'only `CompleteSprintDialog` + the sprint-lifecycle spec. The underlying ' +
          'contrast deficit is a real shipped AA bug; the intermittent trigger is a ' +
          'separate spec-robustness smell (the directory axe sweep should normalise the ' +
          'pointer / not depend on a hover state) — fix both.\n\n' +
          '**Repro.** Open `/filters` (the saved-filters directory), hover any filter ' +
          'name row, and run an axe `color-contrast` check (or read the rendered colour ' +
          'pair): `#0075de` on `#fafaf9` = 4.37:1. Deterministic given the hover state.\n\n' +
          '**Root cause.** `--color-link: #0075de` (globals.css Tier 0) is tuned for AA ' +
          'on the white page background (`#ffffff`) but NOT on the slightly-darker ' +
          '`--color-surface-soft: #fafaf9` that the row hover paints behind it. The link ' +
          'hue and the hover surface were each chosen in isolation; their COMBINATION on ' +
          'the hovered name cell was never contrast-checked.\n\n' +
          '**Fix shapes (decide at fix time):**\n' +
          '1. **Darken `--el-link` (or add a dedicated `--el-link-on-soft`) so the link ' +
          'clears 4.5:1 on `--el-surface-soft`.** The cross-cutting fix — every ' +
          'link-on-hovered-row surface benefits — but it shifts the link hue app-wide, ' +
          'so re-verify the existing link surfaces still read as intended (and check the ' +
          'dark-theme `#58a6ff` / `#161616` pair too).\n' +
          '2. **Bold the name link on hover** (`group-hover:font-semibold`) so the 14px ' +
          'text qualifies for the 3:1 large-text threshold, which 4.37:1 clears. ' +
          'Contained to the directory cell, but layout-shifts the row on hover unless the ' +
          'weight is reserved.\n' +
          '3. **Use `--el-text` (no hue change) on hover and signal the link affordance ' +
          'with underline only.** Drops the colour cue; least invasive but changes the ' +
          'visual language.\n\n' +
          'Plus: make the directory a11y sweep deterministic (reset/blur the pointer ' +
          'before the axe call, or assert the hover colour pair directly) so the ' +
          'violation can no longer hide behind cursor position.\n\n' +
          '## Acceptance criteria\n\n' +
          '- The `/filters` filter-name link clears WCAG 2.1 AA (≥ 4.5:1 for normal ' +
          'text, or ≥ 3:1 if it becomes large/bold) in BOTH its rest and HOVERED-row ' +
          'states, in light AND dark themes.\n' +
          '- The `saved-filters` directory axe sweep is deterministic — it no longer ' +
          'passes/fails based on where the cursor happens to be at sweep time.\n' +
          '- Colour flows through `--el-*` tokens per `motir-core/CLAUDE.md` (no Tier-0 ' +
          '`--color-*` in component code); if a new token is needed, it is added at ' +
          'Tier 3.\n\n' +
          '## Context refs\n\n' +
          '- `app/(authed)/filters/_components/FiltersDirectory.tsx` — the ' +
          '`ApplyNameButton` name cell (the flagged `group-hover:text-(--el-link) ' +
          'group-hover:underline` span) and the row `hover:bg-(--el-surface-soft)`\n' +
          '- `app/globals.css` — `--color-link: #0075de` / `--el-link` (line ~98/337) ' +
          'and `--color-surface-soft: #fafaf9` / `--el-surface-soft` (line ~59/327); the ' +
          'dark values are `#58a6ff` / `#161616`\n' +
          '- `tests/e2e/saved-filters.spec.ts` — the directory axe sweep that caught it ' +
          '(the "an admin subscribes, changes owner, and deletes" test)\n' +
          '- Sibling Epic-6 filters bug ' +
          '[[bug-filters-directory-builtins-i18n-and-layout]] (same `/filters` table, ' +
          'different defect) — grep all `ApplyNameButton` consumers when fixing\n' +
          '- `motir-core/CLAUDE.md` — the `--el-*` colour-token + AA-contrast rules ' +
          '(finding #35: fix the colour pair, not just one side)',
      },
      {
        id: 'bug-zh-dashboards-reports-stale-glossary',
        kind: 'bug',
        title:
          'Chinese (zh) glossary leak: the dashboards/reports copy still says `仪表板` for "dashboard" (must be `工作台`) and `问题` for "work item" (must be `工作项`) — messages/zh.json',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 6 (where the bug was DISCOVERED) · ' +
          '**Surface:** `messages/zh.json` — the `dashboards.*` block (and the ' +
          'adjacent `reports.*` analytics copy) · **Status:** open · ' +
          '**Reported by:** Yue.\n\n' +
          'The Simplified-Chinese catalog ships two STALE glossary terms that the ' +
          'locked zh PM glossary explicitly BANS. Both are the same defect class as ' +
          '`bug-backlog-zh-sprint-translated-as-chongci` (a word-by-word / pre-rename ' +
          'term that survived into a shipped surface), and both live in the same ' +
          '`dashboards`/`reports` region of `messages/zh.json`, so they are fixed in one ' +
          'pass.\n\n' +
          '**Defect 1 (PRIMARY — the reported one): `仪表板` → `工作台`.** "Dashboard" ' +
          'is rendered `仪表板` throughout the `dashboards` block. The locked glossary ' +
          'is unambiguous: **dashboard → `工作台`** (what Teambition / Tapd / 飞书 call ' +
          'the home landing); **`仪表板` is BANNED** (the literal "instrument panel" ' +
          'calque). ~17 occurrences, all in the `dashboards` block: `dashboards.title` ' +
          '(`仪表板`), `newDashboard` (`新建仪表板`), `groupMine` (`我的仪表板`), ' +
          '`optionsAria` (`仪表板选项`), `backToList`, the empty-state `title`/`body`, ' +
          'the create/rename/delete dialog `title`/`body`/`confirm`/`submit`, ' +
          '`switchAria` (`切换仪表板`), the widget empty bodies, the `capBody` cap ' +
          'message, and the `createError`/`renameError`/`deleteError` toasts ' +
          '(`messages/zh.json:2261-2412`). Every `仪表板` → `工作台` (e.g. `新建仪表板` ' +
          '→ `新建工作台`, `切换仪表板` → `切换工作台`, `删除仪表板` → `删除工作台`).\n\n' +
          '**Defect 2 (SECONDARY — same defect class, same block): `问题` → `工作项` ' +
          'where it means "work item".** Motir renamed the tracked-unit noun ' +
          '**work item → `工作项` (BANNED: `问题`, the old Jira-ish "issue/question" ' +
          'term)**, but the dashboards/reports analytics copy still says `问题`: ' +
          '`dashboards` widget catalog + empty states — `仪表板将小组件——问题表格…` ' +
          '(`:2279`), `没有匹配的问题` (`:2337`), `分页问题表格…` (`:2353`), ' +
          '`…对问题进行细分…` (`:2355`), `创建的问题与已解决的问题…` (`:2357`), ' +
          '`问题类型` (`:2388`); and the `reports` block — `按{statistic}统计的问题` ' +
          '(`:2399`), `个问题` (`:2419`), `…的圆环图` body (`:2420`), ' +
          '`暂无可绘制的问题` (`:2421`). Each `问题` that denotes a tracked unit → ' +
          '`工作项` (`问题表格` → `工作项表格`, `问题类型` → `工作项类型`, `个问题` → ' +
          '`个工作项`, etc.).\n\n' +
          '**⚠️ Do NOT touch the legitimate `问题` idioms.** `出了点问题` / ' +
          '`出现问题` = "something went wrong" (error-state copy) is CORRECT Chinese ' +
          'and unrelated to the work-item noun — leave every `…出了点问题…` / ' +
          '`…出现问题…` string as-is. Only the occurrences that NAME a tracked unit ' +
          '(table/row/type/count of work items) are leaks. The fixer must grep ' +
          '`问题` and hand-classify, not blanket-replace.\n\n' +
          '**Repro.** Sign in as `zhuyue@motir.co` / `!QAZ1qaz`, set UI language to ' +
          'Chinese, open the `工作台` area (the dashboards landing) and the report ' +
          'pages: the nav/title/dialogs read `仪表板` (should be `工作台`), and the ' +
          'widget-catalog / report descriptions read `问题` (should be `工作项`).\n\n' +
          '## Acceptance criteria\n\n' +
          '- No `仪表板` remains anywhere in `messages/zh.json` (grep clean); every ' +
          'former `仪表板` reads `工作台`, matching the locked glossary and the rest of ' +
          'the app (e.g. the sidebar/nav already use `工作台`).\n' +
          '- No `问题` remains in `messages/zh.json` where it denotes a tracked unit ' +
          '(dashboards widget catalog + empty states + report descriptions) — each such ' +
          'occurrence reads `工作项`. The `出了点问题` / `出现问题` error idiom is ' +
          'UNCHANGED.\n' +
          '- `en` catalog is untouched (byte-identical); `tests/i18n-catalog.test.ts` ' +
          'parity stays green (no key add/remove — value-only edits).\n' +
          '- A grep check (or a small catalog test) asserts `仪表板` count is 0 and that ' +
          'no work-item-denoting `问题` remains, so a regression is caught.\n\n' +
          '## Context refs\n\n' +
          '- `messages/zh.json:2261-2412` — the `dashboards.*` block; all `仪表板` ' +
          'occurrences + the `问题` leaks at `:2279`, `:2337`, `:2353`, `:2355`, ' +
          '`:2357`, `:2388`.\n' +
          '- `messages/zh.json:2399`, `:2419-2421` — the `reports.*` analytics copy ' +
          '`问题` leaks.\n' +
          '- The locked zh glossary (planner memory `zh-translation-style`): ' +
          '**dashboard → `工作台` (❌ `仪表板`)**, **work item → `工作项` (❌ `问题`)**, ' +
          'reports → `报表`. The `en` catalog values stay byte-identical (tests assert ' +
          'English).\n' +
          '- `bug-backlog-zh-sprint-translated-as-chongci` (PR #502) — the precedent: a ' +
          'banned zh term (`冲刺` for Sprint) shipped to a surface; same shape, fixed by ' +
          'normalising the catalog values.\n' +
          '- `motir-core/CLAUDE.md` — i18n strings live in `messages/{en,zh}.json`; ' +
          'value-only edits, no service/DTO change.',
      },
      {
        id: 'bug-combobox-menu-clipped-inside-modal',
        kind: 'bug',
        title:
          'Combobox listbox is clipped by the Modal when opened inside a dialog (Add-widget config modal — Statistic type picker shows only the first 1–2 options)',
        status: 'done',
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
      {
        id: 'bug-promote-sprint-picker-clipped-inside-popover',
        kind: 'bug',
        title:
          'Combobox listbox is clipped by the parent Popover / Modal at every Combobox-in-dialog site (12 occurrences across 9 files: triage Promote popover ×3 + triage Merge popover + CreateIssueModal ×5 pickers + 5 other settings/filter modals). Reported repro: triage Promote → Active sprint shows the search input + 1 row, rest of sprint list cut off below popover edge.',
        status: 'planned',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 6 (where the bug was DISCOVERED) · ' +
          '**Surfaces:** triage promote flow (`app/(authed)/triage/_components/' +
          'PromotePopover.tsx`, Subtask 6.11.5 — the four-target picker after clicking ' +
          'the row-level **Promote** action) · shared components ' +
          '`components/ui/Combobox.tsx`, `components/ui/Popover.tsx` · ' +
          '**Status:** open · **Reported by:** Yue.\n\n' +
          "On the triage queue, opening a row's **Promote** popover and clicking " +
          '**Active sprint** flips the popover to step 2 — a searchable **Combobox** ' +
          "over the project's open sprints (`label: t('promote.pickSprint')`, " +
          "`searchable`, `searchPlaceholder: t('promote.pickSearch')`). When the " +
          "combobox opens, the listbox is **clipped by the popover's " +
          '`overflow-hidden` boundary**: the screenshot shows the Combobox trigger ' +
          '("Select…"), the search input ("Search"), and the FIRST option row ' +
          '("Sprint 4 · Sp… — Sprint entity, backlog rank…") visible, with every ' +
          'subsequent sprint cut off below the popover edge. The popover itself ' +
          'shows no scroll affordance because the listbox is positioned absolutely ' +
          "inside the trigger's container and lives OUTSIDE the popover-body scroll " +
          'flow — same shape as the Modal-clipped case below.\n\n' +
          '**Repro.** Sign in as `zhuyue@motir.co` / `!QAZ1qaz`, open the `moooon` / ' +
          '`motir` project → **Triage**. Make sure the project has 2+ open sprints ' +
          '(the seed populates several). On any triaged row, click the row-level ' +
          '**Promote** button to open the promote popover, then click **Active ' +
          'sprint**. Observe: the step-2 panel renders the sprint Combobox; click ' +
          'its trigger ("Select…"). The opened listbox extends below the popover and ' +
          'is clipped — only the search input + the first sprint row are reachable; ' +
          'arrowing further down is invisible. The popover itself does not scroll.\n\n' +
          '**Root cause (high confidence — identical to `bug-combobox-menu-clipped-' +
          'inside-modal`, but the parent container is a `Popover` instead of a ' +
          '`Modal`).** `components/ui/Combobox.tsx` (lines ~125-134, ~294-298, ' +
          '~386-413) branches its menu rendering by parent context:\n\n' +
          '- **Outside a dialog** → the menu is **portaled to `document.body`** with ' +
          'viewport-anchored `position: fixed`, so it escapes every overflow ancestor.\n' +
          '- **Inside a Radix Dialog** (detected via ' +
          '`triggerRef.current?.closest("[role=\\"dialog\\"]")`) → the menu is ' +
          'rendered **INLINE** as `absolute left-0 top-full ...` inside the ' +
          "trigger's `relative` container, because a portal would land outside the " +
          "dialog's focus scope and a centered dialog's CSS transform breaks fixed-" +
          "positioned children's viewport coordinates.\n\n" +
          '**Radix `PopoverContent` renders with `role="dialog"` by default** — it ' +
          'shares the focus-trap / outside-click contract with `DialogContent`. So ' +
          'when the Combobox is opened inside `Popover.Content`, the `closest("[role=' +
          '\\"dialog\\"]")` check matches the **popover** as its containing dialog ' +
          'and the menu falls through the INLINE branch. The popover panel itself ' +
          'declares `overflow-hidden` on its content (`components/ui/Popover.tsx:63`, ' +
          "matching the Modal's clipping boundary by design — the popover MUST stay " +
          "capped so it doesn't bleed past its anchored rect). The inline menu's " +
          "`max-h-64` (`16rem`) listbox is taller than the popover's remaining " +
          'vertical space (the promote popover is `width={320}` and step 2 stacks ' +
          'the back link, the label, the trigger, and a confirm button above the ' +
          "menu), so the moment the listbox's bottom edge crosses the popover's " +
          'bottom edge, it is clipped. **The menu has nowhere to scroll to**: an ' +
          '`absolute` child does not contribute to the popover-body scroll height.\n\n' +
          '**This is the SECOND surface of the same defect** that ' +
          '`bug-combobox-menu-clipped-inside-modal` documents (Combobox menu clipped ' +
          'by `Popover`/`Modal` `overflow-hidden`; the inline branch loses ' +
          'reachability for the focus-trap and positioning correctness it gains). ' +
          'The bugs are siblings, not duplicates: the fix site is the same ' +
          "(`Combobox.tsx`'s inline branch), but the bounding ancestor whose " +
          '`getBoundingClientRect` the menu must clamp against is the **popover ' +
          'panel** here, not the **modal panel**. The two share `role="dialog"` so ' +
          'the existing `closest("[role=\\"dialog\\"]")` ancestry lookup already ' +
          "finds the right element; the fix's rect-measurement just needs to work " +
          'against whichever dialog ancestor is nearest. Same `bug-inline-edit-' +
          'clipped-when-table-short` portal branch — uninvolved — stays UNTOUCHED.\n' +
          '\n' +
          '**Fix shapes (mirror the Modal sibling — decide at fix time).**\n' +
          "1. **Clamp the inline menu's height to the nearest dialog ancestor's " +
          'available space** (durable). When `inDialog` is true, compute ' +
          '`listMaxHeight` from the containing `[role="dialog"]` ancestor\'s bottom ' +
          "edge minus the trigger's bottom edge (with a small gap), and set the " +
          "listbox's `maxHeight` to that — mirroring the portaled branch's " +
          '`updatePosition` logic (`Combobox.tsx:166-189`) against ' +
          '`triggerRef.current.closest("[role=\\"dialog\\"]").getBoundingClientRect()` ' +
          'instead of `window.innerHeight`. The menu then SCROLLS INTERNALLY, ' +
          "the popover/modal doesn't, and clipping is gone for BOTH surfaces.\n" +
          '2. **Flip the menu above the trigger when the space below is shorter** ' +
          '(complement of 1). The portaled branch already does this; mirror it for ' +
          'inline. Combine with 1 so the menu picks the taller side AND clamps to it.\n' +
          '\n' +
          'Net: a **single** fix in the Combobox inline branch should resolve both ' +
          'this bug AND `bug-combobox-menu-clipped-inside-modal` — the dialog-ancestor ' +
          'rect lookup is parent-type-agnostic. Combining the two siblings into one ' +
          "fix Subtask is the natural shape; reference both ids in the fix's Context " +
          'refs.\n\n' +
          '**Wider impact — full system scan (2026-06-15).** The reported repro ' +
          '(`PromotePopover.tsx:193`) is ONE of MANY affected sites. A full scan of ' +
          '`Combobox`-rendered-inside-`Popover` AND `Combobox`-rendered-inside-`Modal` ' +
          'across the codebase enumerates every surface that hits the same inline-branch ' +
          'clipping; ALL of them are fixed by the single fix shape above. The fix ' +
          'Subtask MUST verify each one renders correctly post-fix (the clipping is ' +
          'load-bearing for keyboard reachability of every clipped option).\n' +
          '\n' +
          '_Triage page (the surface in the report):_\n' +
          '- `app/(authed)/triage/_components/PromotePopover.tsx:193` — sprint ' +
          'Combobox (THE REPORTED ONE, step 2 of the Promote popover after picking ' +
          '**Active sprint**).\n' +
          '- `app/(authed)/triage/_components/PromotePopover.tsx:217` — epic / story ' +
          'parent Combobox (step 2 of Promote after picking **Under an epic** or ' +
          '**Under a story**); same Popover, same clipping.\n' +
          '- `app/(authed)/triage/_components/PromotePopover.tsx:173` — Top / Bottom ' +
          'placement Combobox (step 1 of Promote, lives in the FOOTER of the same ' +
          "popover above the four target rows). Two options only, so it's borderline " +
          "visually — but it's the same inline-clipped branch and would clip if a third " +
          'placement option were ever added.\n' +
          '- `app/(authed)/triage/_components/MergePicker.tsx:78` — query-driven ' +
          'work-item Combobox (the **Mark duplicate / merge** triage action) ' +
          'rendered inside a Popover (`width={360}`). The search-driven option list ' +
          'is taller than the popover when 2+ results land; same clipping shape.\n' +
          '\n' +
          '_Other Combobox-in-Modal sites across the system (each is its own ' +
          'occurrence of the SAME defect; the original `bug-combobox-menu-clipped-' +
          'inside-modal` only named the Widget-config / Statistic-type case):_\n' +
          '- `app/(authed)/_components/CreateIssueModal.tsx` — **HIGHEST density** — ' +
          '5 Combobox-backed pickers + 1 DatePicker stacked in one modal: ' +
          '`<TypePicker>` (line 193), `<ParentPicker>` (line 211), ' +
          '`<WorkItemTypePicker>` (line 251), `<ExecutorPicker>` (line 264), ' +
          '`<PriorityPicker>` (line 331), `<DatePicker>` (line 339). Each picker in ' +
          '`components/issues/*Picker.tsx` wraps `Combobox`. The lower-half pickers ' +
          '(`PriorityPicker`, `WorkItemTypePicker`, `ExecutorPicker`) will be MOST ' +
          'severely clipped because they sit near the bottom of a tall modal — every ' +
          'option past the first 1–2 is unreachable. ' +
          '**`components/issues/WorkItemTypePicker.tsx:16` even carries a source ' +
          'comment acknowledging "Because the create modal is a `role=\\"dialog\\"`, ' +
          'the Combobox renders [inline]"** — the engineer who wrote the picker knew ' +
          'about the inline branch but did not realise it clips below the modal floor.\n' +
          '- `app/(authed)/settings/project/fields/_components/' +
          'FieldsSettingsEditor.tsx:623` — `<TypePicker>` inside the Create / Edit ' +
          'custom-field modal (the same TypePicker → Combobox wrap; renders the ' +
          'custom-field type list).\n' +
          '- `app/(authed)/filters/_components/ChangeOwnerDialog.tsx:96` — owner ' +
          'Combobox (workspace member list — can be long; the picker is the ONLY ' +
          'field in this modal so clipping below the modal floor is the dominant ' +
          'failure mode).\n' +
          '- `app/(authed)/filters/_components/SubscribeDialog.tsx:200, 213` — two ' +
          'stacked Comboboxes (subscription frequency + delivery channel) inside the ' +
          'subscribe modal.\n' +
          '- `app/(authed)/settings/organization/members/_components/' +
          'OrgMembersClient.tsx:479` — role Combobox inside the `<InviteModal>` ' +
          '(org-roles list — short, but clips when the trigger sits low in the modal). ' +
          'NOTE: the SAME file has another `<Combobox>` at line 361, but that one is ' +
          'on the page-level members table row (not inside a modal) — **unaffected**.\n' +
          '- `app/(authed)/settings/project/components/_components/' +
          'ComponentsSettingsEditor.tsx:821` — move-target Combobox inside ' +
          '`<DeleteComponentModal>` (lists every OTHER component in the project as ' +
          'a re-parent target; clips when a project has many components). NOTE: the ' +
          'SAME file has a `<Combobox>` at line 413 on the page-level filter bar ' +
          '(outside the modals) — **unaffected**.\n' +
          '- `app/(authed)/backlog/_components/CompleteSprintDialog.tsx:321` — ' +
          'Combobox inside the complete-sprint modal (likely the carry-over target ' +
          'sprint picker; the open-sprint list).\n' +
          '- `app/(authed)/dashboard/_components/WidgetConfigModal.tsx:228` — ' +
          'Statistic-type Combobox. **This is the ORIGINAL repro surface from ' +
          '`bug-combobox-menu-clipped-inside-modal`** — listed here for completeness ' +
          'so the fix Subtask covers ALL known occurrences in one sweep.\n' +
          '\n' +
          '_Verified safe (no Combobox inside the Modal):_ ' +
          '`AddWidgetModal.tsx`, `CreateProjectModal.tsx`, `WorkspaceSwitcher.tsx`, ' +
          '`BoardSwitcher.tsx`, `EditFilterDialog.tsx`, `SaveFilterDialog.tsx`, ' +
          '`DeleteFilterDialog.tsx`, `StartSprintDialog.tsx` (uses `<DatePicker>` ' +
          'only, which goes through its OWN Popover — not the Combobox inline ' +
          'branch), `ReleaseKeyModal.tsx`, `ArchiveProjectModal.tsx`, ' +
          '`ChangeKeyModal.tsx`, `BoardConfigEditor.tsx`, `WorkflowEditor.tsx`, ' +
          '`AddWidgetModal.tsx`, `CreateDashboardModal.tsx`, `ShortcutsCheatsheet.tsx`, ' +
          '`OrgControl.tsx`, `AttachmentPreview.tsx`, `IssueQuickView.tsx`. ' +
          '`AutomationRuleEditor.tsx` has 9 Comboboxes but is a full-page editor, ' +
          'NOT a modal — also unaffected.\n' +
          '\n' +
          '_Out-of-scope (different primitive, different clipping shape, NOT ' +
          'covered by this fix):_ `<DatePicker>` inside a Modal opens its OWN ' +
          '`<Popover>` (not a Combobox), so the inline-vs-portal branch above does ' +
          "NOT apply — Radix's nested-Popover-inside-Dialog has its own focus-trap " +
          'and clipping interactions that are out of scope here. If a follow-up ' +
          'report surfaces DatePicker clipping, log it as a separate bug — same ' +
          'family, different fix site.\n' +
          '\n' +
          '**Total: 12 affected Combobox-in-{Popover,Modal} sites across 9 files, ' +
          'all fixed by the single inline-branch clamp.** The fix Subtask should ' +
          'have a regression assertion per AFFECTED FILE (not per Combobox), opening ' +
          'each modal/popover at a viewport where the menu would have clipped pre-' +
          "fix and asserting the listbox's bottom-edge fits inside the dialog " +
          "ancestor's bottom-edge via `getBoundingClientRect`.\n\n" +
          '**Test gap that let it ship.** Same as the Modal sibling — Combobox tests ' +
          "cover the inline branch's opens/closes/keyboard-nav semantics but not its " +
          'rendered geometry inside a constrained parent. The fix MUST add a render ' +
          'or Playwright assertion: open the menu inside a `Popover.Content` whose ' +
          "remaining space is < the menu's natural height, then assert the " +
          "listbox's bottom-edge fits inside the popover's bottom-edge " +
          '(getBoundingClientRect). Pair it with the existing Modal-surface ' +
          'regression so the same `listMaxHeight` fix is covered on both parents.\n\n' +
          '## Context refs\n\n' +
          '- `app/(authed)/triage/_components/PromotePopover.tsx:191-202` — the ' +
          'concrete repro surface (the `<Combobox options={sprintOptions} searchable …>` ' +
          'rendered inside `Popover.Content` after `goToSprint` flips `step` to ' +
          '`sprint`)\n' +
          '- `components/ui/Popover.tsx:56-74` — `RadixPopover.Content` portal + ' +
          '`overflow-hidden rounded-(--radius-card)` panel; the `role="dialog"` source ' +
          "(Radix default) that triggers Combobox's inline branch\n" +
          '- `components/ui/Combobox.tsx:125-134, 166-189, 288-310, 386-413` — the ' +
          "inline-vs-portal branch + the portaled branch's viewport clamping (the " +
          "shape to mirror) + the inline branch's `absolute left-0 top-full` " +
          'rendering (the fix site)\n' +
          '- `bug-combobox-menu-clipped-inside-modal` (sibling) — the FIRST surface ' +
          'of the same defect (Combobox clipped by `Modal` `overflow-hidden`); the ' +
          "fix should subsume both and reference this bug's id\n" +
          '- `bug-inline-edit-clipped-when-table-short` (cousin) — the original ' +
          'table-overflow case that justified the portaled branch; the contract this ' +
          'fix must NOT regress\n' +
          '- `motir-core/CLAUDE.md` — colour via `--el-*`, shape via element-shape ' +
          'tokens (applies to whatever wrapper the fix introduces)\n\n' +
          '**Refactor signal (rule of three).** This is the THIRD documented ' +
          'occurrence of "menu/popover clipped by an ancestor\'s overflow" — first ' +
          'was `bug-inline-edit-clipped-when-table-short` (table → body-portal ' +
          'branch added), second was `bug-combobox-menu-clipped-inside-modal` ' +
          '(Modal → inline branch fails the same way in reverse), now this one ' +
          '(Popover, same shape as the Modal). The Combobox already encodes both ' +
          'branches inside one component with a `closest("[role=\\"dialog\\"]")` ' +
          'switch; this third occurrence does NOT add a new branch (Popover already ' +
          'matches `role="dialog"`), but it confirms the per-context-branch shape ' +
          'is at its ceiling. If a fourth occurrence surfaces in a NEW container ' +
          'type (e.g. a sticky-header data-grid or a drawer panel without ' +
          '`role="dialog"`), unify behind a single overflow-escape primitive ' +
          'instead of a fourth branch.',
      },
      {
        id: 'bug-account-notifications-row-divider-broken-by-cell-padding',
        kind: 'bug',
        title:
          "Account settings → Notifications: per-row divider lines are visibly broken (gap before the EMAIL column) because each row's border-b is drawn on individual grid cells and the event cell's pr-4 ends the border 1rem short of the toggle columns",
        status: 'planned',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 6 (where the bug was DISCOVERED) · ' +
          '**Surfaces:** account settings page → **Notifications** card ' +
          '(`app/(authed)/settings/account/_components/' +
          'NotificationPreferencesCard.tsx`, Subtask 5.7.x — the per-event ' +
          'email/in-app preferences grid) · **Status:** open · **Reported by:** Yue.\n\n' +
          'On the **Account settings** page, the **Notifications** card renders an ' +
          "EVENT × {EMAIL, IN-APP} grid (Mentioned / Commented on an item you're " +
          "involved in / Assigned to you / An item you're watching changes status / " +
          '…). Each row is meant to be separated from the next by a single ' +
          'horizontal divider that spans the full card width. Instead, every ' +
          'divider is **visibly broken**: the line under the event-label cell ends ' +
          '~1rem BEFORE the EMAIL column starts, producing a small but conspicuous ' +
          'gap right where the toggles begin. The result is a ragged "stitched" ' +
          'look — three disconnected segments per row (event | email | in-app) ' +
          "instead of one continuous rule. The card's outer border + the column-" +
          'header rule (which IS continuous) make the per-row breakage stand out.\n' +
          '\n' +
          '**Repro.** Sign in as `zhuyue@motir.co` / `!QAZ1qaz`, navigate to ' +
          '**Settings → Account**. Scroll to the **Notifications** card. Observe: ' +
          "the row between **Mentioned** and **Commented on an item you're " +
          'involved in** (and every row below it) shows a horizontal rule that ' +
          'breaks ~1rem before the EMAIL toggle column begins — a visible gap, ' +
          'then the rule resumes under the EMAIL cell, then under the IN-APP cell. ' +
          'The COLUMN-HEADER rule (under EVENT / EMAIL / IN-APP) is continuous, ' +
          "because the header cells don't carry the `pr-4` the event cells do.\n" +
          '\n' +
          '**Root cause (high confidence — source confirms it).** ' +
          '`NotificationPreferencesCard.tsx` lays the grid out as ' +
          '`<div role="grid" className="mt-2 grid grid-cols-[1fr_5rem_5rem] ' +
          'items-center">`. Each ROW is rendered as THREE separate sibling cells ' +
          '(an `<EventRow>` returns a `<>…</>` fragment of three `<div>`s — one ' +
          'event-label div + two `<NotificationCell>` toggle divs):\n' +
          '\n' +
          '- Event cell: `<div className="border-(--el-border-soft) border-b ' +
          'py-3.5 pr-4">` (`NotificationPreferencesCard.tsx:152`) — note the ' +
          '`pr-4` right-padding.\n' +
          '- Each toggle cell: `<div className="border-(--el-border-soft) flex ' +
          'justify-center border-b py-3.5">` (`NotificationPreferencesCard.tsx:196`) ' +
          '— no `pr-4`.\n' +
          '\n' +
          'Because the bottom border is painted on each INDIVIDUAL grid cell, the ' +
          "event cell's `border-b` ends at the cell's **content-box** right edge, " +
          'which is shifted left by exactly `pr-4` (1rem). The neighbouring EMAIL ' +
          "cell's `border-b` starts at ITS left content edge with no compensating " +
          'left padding, so a 1rem horizontal gap appears between the two borders. ' +
          'This repeats once more (smaller, often invisible) between EMAIL and IN-' +
          'APP if their box-sizing leaves any inter-cell gap; the dominant visible ' +
          'break is the 1rem one before EMAIL.\n' +
          '\n' +
          'The COLUMN-HEADER rule (`NotificationPreferencesCard.tsx:116-124`) does ' +
          'NOT exhibit the bug because its three cells use the SAME padding ' +
          '(`pb-3` on all, no `pr-4` on the EVENT header) — so the three borders ' +
          'meet flush. The bug is purely structural to the per-cell-border + ' +
          'asymmetric-padding combination on the data rows.\n' +
          '\n' +
          '**Fix shapes (decide at fix time — listed by durability).**\n' +
          '1. **Lift the divider OFF the cells and onto a row-spanning element ' +
          '(durable, recommended).** The grid is a flat `grid-cols-[1fr_5rem_5rem]` ' +
          'with cells laid out left-to-right per row; there is no row-spanning DOM ' +
          'element to attach the border to. Two sub-shapes:\n' +
          '   - **(a) Subgrid + per-row wrapper.** Wrap each row in a single ' +
          '`<div role="row" className="grid grid-cols-subgrid col-span-3 border-b ' +
          'border-(--el-border-soft)">` (Tailwind v4 supports `grid-cols-subgrid`); ' +
          'move the three cells inside. The border is now on ONE row-spanning ' +
          'element, so it spans uninterrupted regardless of per-cell padding. ' +
          'Bonus: cleaner DOM semantics (real `role="row"` instead of fragment).\n' +
          '   - **(b) Separator pseudo-row.** Between each row, insert a ' +
          '`<div className="col-span-3 border-b border-(--el-border-soft)" />` — ' +
          'simpler but adds an inert DOM node per row.\n' +
          '2. **Drop `pr-4` from the event cell and use `gap-x-*` on the grid for ' +
          'inter-column spacing instead** (minimal change). The grid becomes ' +
          "`grid grid-cols-[1fr_5rem_5rem] gap-x-4 items-center`; the event cell's " +
          "border now extends flush with the toggle cells'. **Risk:** changes the " +
          'visual spacing of the column-header rule (it currently has zero gap-x), ' +
          'and the column-header rule then also gains gap-x — verify the headers ' +
          'still read correctly. Lower-touch but couples spacing to bordering.\n' +
          '\n' +
          '**Recommended:** fix 1a (subgrid + per-row wrapper). It is the standard ' +
          'shape for "borders should be row-level, not cell-level" in a CSS-grid ' +
          'layout (Jira, Linear, GitHub all use it for their grid-shaped tables), ' +
          'and it future-proofs the card against any additional asymmetric per-cell ' +
          'padding the design might introduce (e.g. a leading icon column, a ' +
          'trailing description column).\n' +
          '\n' +
          '**Test gap that let it ship.** The existing Notifications-card tests ' +
          'cover the toggle interaction + the persisted preference value + the ' +
          '"Soon" disabled row, but not the **rendered geometry of the row ' +
          'dividers**. The fix MUST add either a render-test or Playwright ' +
          "assertion: the bounding rect of each row's border-bottom spans the " +
          "card's full inner width (left content-edge to right content-edge), with " +
          'no horizontal gap. Pair it with an axe sweep to confirm the cosmetic ' +
          "cleanup doesn't regress contrast.\n" +
          '\n' +
          '## Context refs\n\n' +
          '- `app/(authed)/settings/account/_components/' +
          'NotificationPreferencesCard.tsx:110-129` — the grid container ' +
          '(`grid grid-cols-[1fr_5rem_5rem]`) + the column-header cells (continuous ' +
          'rule, no `pr-4`) — the comparison case\n' +
          '- `app/(authed)/settings/account/_components/' +
          'NotificationPreferencesCard.tsx:139-176` — `EventRow` (returns a ' +
          'fragment of three sibling cells; the event cell has `border-b … pr-4` ' +
          '— the fix site)\n' +
          '- `app/(authed)/settings/account/_components/' +
          'NotificationPreferencesCard.tsx:178-205` — `NotificationCell` (the ' +
          'toggle cells; `border-b` without compensating left padding)\n' +
          '- `motir-core/CLAUDE.md` — colour via `--el-*` (the `--el-border-soft` ' +
          'used here is correct), shape via element-shape tokens (applies to ' +
          'whatever wrapper the fix introduces)\n' +
          '\n' +
          '**Class.** "Per-cell border in a CSS-grid table breaks at any cell with ' +
          'asymmetric inline padding" — a structural rendering bug, not a token / ' +
          'colour / a11y issue. First documented occurrence in this codebase; ' +
          'flag the row-level-divider pattern (fix 1a) as the project standard for ' +
          "grid-based tables going forward, so the same defect doesn't reappear in " +
          'future settings cards or other key-value grids.',
      },
      {
        id: 'bug-notification-pref-transitioned-still-disabled-after-5-4-shipped',
        kind: 'bug',
        title:
          'Notification preferences: the "An item you\'re watching changes status" row is still drawn disabled with "Soon" + "Available once issue-watching ships (Story 5.4)" copy, but Story 5.4 (issue-watching) shipped — the row should be settable',
        status: 'cancelled',
        type: 'bug',
        descriptionMd:
          '> **⛔ TOMBSTONED — reclassified as a planning gap (2026-06-14).** This bug self-scoped ' +
          'as "one boolean + two strings + one assertion." Verifying the runtime against that ' +
          'claim (decision-ladder rung 2 over the card prose) showed the premise is FALSE: the ' +
          'watcher transition EMAIL is sent UNGATED (`watcherNotificationsService` never consults ' +
          'the preference resolver) and the in-app `transitioned` notification is NEVER WRITTEN ' +
          '(`NOTIFICATION_FAN_IN_REGISTRY` has no `transitioned` descriptor) — so flipping ' +
          '`settable` alone would ship two DECORATIVE toggles (worse than the disabled state). The ' +
          'connecting subtasks were never planned (each story deferred the seam to the other; 5.4 ' +
          'shipped first). Replaced by **Story 5.7 subtasks 5.7.10** (in-app `transitioned` fan-in ' +
          'delivery), **5.7.11** (watcher-transition email gate), and **5.7.12** (the matrix flip, ' +
          'blocked on both). Root-cause class + the audit rule are recorded as **notes.html mistake ' +
          '#40**. The detailed diagnosis below remains accurate as the symptom record.\n\n' +
          '**Type:** bug · **Parent:** Epic 6 (where the bug was DISCOVERED) · ' +
          '**Surfaces:** account settings notification matrix ' +
          '(`/settings/account` — Subtask 5.7.6, `NotificationPreferencesCard.tsx`) · ' +
          '**Code surface owned by:** Story 5.7 (matrix UI · Subtask 5.7.6) + Story 5.4 ' +
          '(the seam that should have been closed when 5.4 shipped — the seam owner) · ' +
          '**Status:** open · **Reported by:** Yue.\n\n' +
          'On `/settings/account` the notification-preferences matrix shows four event-type rows: ' +
          "**Mentioned**, **Commented on an item you're involved in**, **Assigned to you**, and " +
          "**An item you're watching changes status**. The fourth row renders **disabled** with a " +
          'lavender **“Soon”** tag and the helper text **“Available once issue-watching ships ' +
          '(Story 5.4).”** Both Email and In-app switches are greyed out and unclickable. The user ' +
          'has no way to opt out of (or back into) the watcher-transition email + in-app fan-in.\n\n' +
          '**But Story 5.4 (Labels, components, watchers) is `done`**. Watching is shipped end-to-' +
          'end: the `WatchControl` (`Subtask 5.4.9`) is live on the issue detail rail; the watcher ' +
          'CRUD routes ship (`PUT/DELETE /api/work-items/[id]/watch`); `workItemsService.updateStatus` ' +
          '(`lib/services/workItemsService.ts:1178`) and `boardsService` ' +
          '(`lib/services/boardsService.ts:529`) BOTH emit `work-item/transitioned` events on every ' +
          'status change; the 5.7.3 in-app fan-in (`notificationFanInService.ts:141`) and the ' +
          '5.1.6 email job already consume `transitioned` and deliver to watchers ' +
          '(`watcherNotificationsService.ts`). The transitioned NOTIFICATIONS are live for every ' +
          'watcher right now. **Only the preference-matrix guard never flipped from `settable: ' +
          'false` to `settable: true` when 5.4 landed.** Class: "post-prerequisite-ships, forgotten ' +
          'flip" — Story 5.4\'s definition-of-done didn\'t include "close the seams that named you ' +
          'as the gate."\n\n' +
          '**Repro.** Sign in as `zhuyue@motir.co` / `!QAZ1qaz`, open `/settings/account`, scroll ' +
          'to the **Notifications** card. Observe the fourth row "An item you\'re watching ' +
          'changes status" renders greyed with a "Soon" / 即将推出 chip; the Email and In-app ' +
          '`Switch`es are `disabled`. The aria-label reads "Email for An item you\'re watching ' +
          'changes status (coming soon)". Now, in another browser tab, watch any work item (issue ' +
          'detail page → 👁 Watch), have a teammate transition that item to Done, and observe in ' +
          '`/notifications` that the user RECEIVES the transitioned notification — the channel is ' +
          'live, but the user cannot configure it.\n\n' +
          '**User impact.** A watcher who does NOT want transition emails (e.g. they watch many ' +
          'items for read-only triage) has NO control: the row is hard-disabled, and the service ' +
          'rejects writes with `NotificationEventTypeNotSettableError` (`notificationPreferences' +
          'Service.ts:70`). Their only escapes are unwatching every item or hiding by email-' +
          'client filter — both worse than a preference toggle that already exists in design and ' +
          'in service. This is missing a user CONTROL over real notifications the system is ' +
          'actively sending — not cosmetic.\n\n' +
          '**Root cause (high confidence — one-line seam in three files).**\n\n' +
          '- `lib/notifications/preferences.ts:70-75` — the `NOTIFICATION_PREFERENCE_EVENT_TYPES` ' +
          'row for `transitioned` is `{ settable: false, defaults: { email: true, in_app: true } }`. ' +
          'The source comment at line 70 documents the intent: *"Story 5.4 seam — drawn disabled, ' +
          'rejected on write, until issue-watching ships."* It must flip to `settable: true`. ' +
          "Defaults are already correct (both channels ON, mirroring Jira's personal-notification-" +
          'settings shape) so the resolver does the right thing the moment the flag flips.\n' +
          '- `messages/en.json:1415-1418` (`settings.account.notifications.events.transitioned`) — ' +
          '`label: "An item you\'re watching changes status"` (KEEP), `desc: "Available once ' +
          'issue-watching ships (Story 5.4)."` — must be replaced with a real description matching ' +
          'the shipped event semantics, e.g. **"Someone changes the status of an item you watch ' +
          '(including transitions to done or back open)."** (mirror the design copy + the other ' +
          "three rows' style — present-tense, user-impact-named).\n" +
          '- `messages/zh.json:1415-1418` — the matching zh `desc: "在事项关注功能上线后可用（故事 ' +
          '5.4）。"` must be replaced with a translated version of the new en copy. (Both locales ' +
          'must flip together; the existing convention is the matrix rows are translated in ' +
          "lockstep — search `transitioned` in both files and update each.) Verify the row's " +
          'aria-label flips from `cellAriaSoon` to `cellAria` automatically once `settable` is ' +
          '`true` — the existing `NotificationPreferencesCard.tsx:192-194` branches on ' +
          '`row.settable`, so no UI change.\n\n' +
          '**Service contract — verify before flipping.** ' +
          '`notificationPreferencesService.set` (`lib/services/notificationPreferencesService.ts:70`) ' +
          'rejects with `NotificationEventTypeNotSettableError` for non-settable types. Once ' +
          '`transitioned` flips to `settable: true`, writes will go through and the existing ' +
          'channel-gate resolver (consulted by both the 5.7.3 in-app fan-in AND the 5.1.6 email ' +
          "job — per the `preferences.ts` header comment) will honor the user's pick. Confirm the " +
          'fan-in actually consults the matrix for `transitioned` (not just `mentioned` / ' +
          '`commented` / `assigned`) — the `notificationFanInService.ts:141` comment claims 5.4 ' +
          'extends the resolver with `transitioned`, but the bug fix MUST verify with a test that ' +
          "flipping the user's `transitioned · email` cell to `off` actually suppresses the " +
          'watcher transition email (otherwise the toggle is just decorative — a worse defect than ' +
          'the disabled-with-Soon state).\n\n' +
          '**Fix shape (minimal, no follow-up).**\n\n' +
          '1. `lib/notifications/preferences.ts` — flip `settable: false` → `settable: true` on the ' +
          '`transitioned` row; rewrite the line-70 comment from "Story 5.4 seam — drawn disabled ' +
          '… until issue-watching ships" to a one-line "Watcher transition events (Story 5.4 — ' +
          "shipped); fanned in by 5.7.3 + 5.1.6, gated by the user's `transitioned · {channel}` " +
          'cell."\n' +
          '2. `messages/en.json` + `messages/zh.json` — replace the `transitioned.desc` strings ' +
          'with real present-tense copy describing the live event (mirror the existing three ' +
          "rows' style).\n" +
          '3. Add a test that asserts: (a) ' +
          '`notificationPreferencesService.set({ eventType: "transitioned", channel: "email", ' +
          'enabled: false })` SUCCEEDS for a user (currently throws `NotificationEventType' +
          'NotSettableError`); (b) once that cell is `off`, ' +
          '`watcherNotificationsService` does NOT deliver the email for a `work-item/transitioned` ' +
          'event the user would otherwise receive; (c) the matrix DTO returned by ' +
          '`GET /api/notification-preferences` reports `settable: true` for the `transitioned` ' +
          'row. The first two are integration-tier (real DB, mirror the existing fan-in tests); ' +
          'the third is a one-line DTO assertion or component test.\n' +
          '4. Audit the rest of the repo for similar stale "ships (Story X)" guards. The current ' +
          'sweep (`grep "Available once" + "settable: false" + "until …ships"` across `app ' +
          'components lib messages`) finds only this row — but the audit is itself the rule, not ' +
          'this single hit.\n\n' +
          'No DB migration; no schema change; no Modal/Card/Switch primitive change; no service-' +
          'method signature change; no shape/colour token churn — purely a flag flip + copy + ' +
          'test. Story 5.4 already paid for the runtime contract; the bug is one boolean + two ' +
          'strings + one assertion.\n\n' +
          '## Acceptance criteria\n\n' +
          '- The `/settings/account` notification matrix `transitioned` row is **enabled**: both ' +
          'Email and In-app `Switch`es are clickable; the lavender "Soon" / 即将推出 tag is ' +
          'absent; the helper text reads the new real copy (en + zh both updated).\n' +
          "- The row's aria-label is `cellAria` (not `cellAriaSoon`) — falls out of " +
          '`NotificationPreferencesCard.tsx:192-194` once `row.settable` is `true`.\n' +
          '- The user can toggle each cell; the response is honored and the cell trusts it ' +
          '(no `router.refresh` regression — the existing inline-toggle contract holds).\n' +
          '- `notificationPreferencesService.set` no longer throws ' +
          '`NotificationEventTypeNotSettableError` for `eventType: "transitioned"`.\n' +
          '- When the user sets `transitioned · email` to `off`, a subsequent ' +
          '`work-item/transitioned` event the user would otherwise receive (because they watch ' +
          'the item) does NOT deliver the email — verified by an integration test against the ' +
          'real `watcherNotificationsService`. Same for `in_app` and the 5.7.3 fan-in.\n' +
          '- Existing three rows (mentioned / commented / assigned) keep current behaviour ' +
          '(defaults, toggle paths, AA contrast). No regression in the other surfaces ' +
          'consuming `NOTIFICATION_PREFERENCE_EVENT_TYPES` (the resolver, the matrix DTO, the ' +
          'fan-in).\n' +
          '- A one-line note in `notes.html` (or `PRODECT_FINDINGS.md`) documents the ' +
          '"post-prerequisite-ships, forgotten flip" anti-pattern + the audit grep that catches ' +
          'it — so a future Story-X completion checklist includes "close the seams named after ' +
          'you." (Planner-side meta, not a code change — out of scope here but logged as a ' +
          'finding in the PR body.)\n\n' +
          '## Context refs\n\n' +
          '- `lib/notifications/preferences.ts:70-75` — the seam (the one-line flip)\n' +
          '- `messages/en.json:1415-1418`, `messages/zh.json:1415-1418` — the matching i18n copy ' +
          '(both locales)\n' +
          '- `app/(authed)/settings/account/_components/NotificationPreferencesCard.tsx:139-175` ' +
          '— the row renderer (no change; branches on `row.settable` already)\n' +
          '- `lib/services/notificationPreferencesService.ts:70` — the ' +
          '`NotificationEventTypeNotSettableError` throw that gates writes today\n' +
          '- `lib/services/workItemsService.ts:1178`, `lib/services/boardsService.ts:529` — the ' +
          '`work-item/transitioned` event emitters (proof that the runtime side shipped with 5.4)\n' +
          '- `lib/services/notificationFanInService.ts:141` — the 5.7.3 fan-in side that consumes ' +
          "`transitioned`; verify the channel-gate is consulted (or wire it if it isn't — part of " +
          'the fix)\n' +
          '- `lib/services/watcherNotificationsService.ts` — the email-side fan-out; verify the ' +
          'gate is consulted\n' +
          '- Story 5.4 (Labels, components, watchers) — `done`; Subtasks 5.4.4 (watcher CRUD), ' +
          '5.4.5 (transitioned event), 5.4.9 (`WatchControl`) all shipped\n' +
          '- Sibling family: `bug-automation-editor-status-id-not-key` (Epic 6 sibling — also a ' +
          '"editor said one thing, runtime contract said another" cross-layer defect; this is ' +
          'the time-shifted variant where the contract evolved and the editor seam was not flipped ' +
          'with it)\n\n' +
          '**Refactor signal.** This is the FIRST documented "post-prerequisite-ships, forgotten ' +
          'seam-flip" bug. The seam was correctly placed and correctly named (the comment cited ' +
          'Story 5.4 by id) — the failure was that landing 5.4 didn\'t include a "search for ' +
          'seams that named me" pass. Cheap catch: an audit grep ' +
          '(`grep -rn "ships (Story\\|Available once\\|until.*ships"`) added to the planner\'s ' +
          'Story-completion `motir mark <id> done` checklist would prevent the next instance. Not ' +
          'in scope for this bug; the rule of one fires at "log it as a recurring class" not "fix ' +
          'the planner runbook." If a second occurrence surfaces in another epic, promote the ' +
          'audit grep to a CI lint.',
      },
      {
        id: 'bug-reports-hub-agile-cards-collapse-to-one-url',
        kind: 'bug',
        title:
          'Reports hub: all three Agile cards (Burndown chart / Velocity chart / Sprint report) navigate to the SAME `/sprints/[id]/report` URL — collapses three distinct Jira reports onto one page',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 6 (where the bug was DISCOVERED) · ' +
          '**Surfaces:** project Reports hub (`/reports`, Subtask 6.3.6 — ' +
          '`app/(authed)/reports/page.tsx`) · **Code surface owned by:** Story 6.3 ' +
          '(Subtask 6.3.6 — built the hub) + Story 4.6 (the chart primitives + reads the new ' +
          'pages will compose: 4.6.2 chart primitives, 4.6.3 `getBurndownSeries`, 4.6.4 ' +
          '`getVelocity`, 4.6.5 burndown mount, 4.6.6 velocity mount — all `done`) · ' +
          '**Status:** open · **Reported by:** Yue.\n\n' +
          'On `/reports` the **Agile** group renders three cards: **Burndown chart**, **Velocity ' +
          'chart**, **Sprint report**. Three distinct names, three distinct icons (TrendingDown · ' +
          'BarChart3 · ListTree), three distinct body copies — visually a 3-up of three distinct ' +
          'reports. But **all three cards link to the exact same URL** (' +
          '`app/(authed)/reports/page.tsx:54-58, 68-90` — a single `agileHref` computed once ' +
          '(active sprint else most recently completed, else `/backlog`) and reused for every ' +
          '`<HubCard href={agileHref}>`). Clicking any of the three lands on the same sprint ' +
          'report page; the user has no way to deep-link directly into the Velocity chart (a ' +
          'cross-sprint history view), and "Burndown chart" / "Velocity chart" are misleading as ' +
          "card titles when they're actually sub-sections of the sprint report.\n\n" +
          '**Repro.** Sign in as `zhuyue@motir.co` / `!QAZ1qaz`, open the `moooon` / `motir` ' +
          'project, click **Reports** in the sidebar. Hover/click each of the three Agile cards; ' +
          'observe each navigates to `/sprints/<id>/report` (same id). Velocity in particular is ' +
          'CROSS-SPRINT by definition (the 4.6.4 `getVelocity` read returns recent-sprints ' +
          "committed-vs-completed), but the only way to see it is to open one specific sprint's " +
          "report, which frames the velocity beside that sprint's burndown rather than as a " +
          'project-level history.\n\n' +
          "**Mirror product (decision-authority rung 1).** Jira's Reports menu lists Burndown " +
          'chart, Velocity chart, and Sprint report as THREE separate pages: ' +
          '`/projects/{key}/reports/burndown-chart` (per-sprint, with a sprint picker), ' +
          '`/projects/{key}/reports/velocity-chart` (cross-sprint history, no per-sprint scope), ' +
          '`/projects/{key}/reports/sprint-report` (per-sprint, with a sprint picker — the ' +
          'completed/incomplete + carried view this codebase already ships at ' +
          '`/sprints/[id]/report`). Each is a focused, bookmarkable report with its own controls. ' +
          'Linear groups them similarly. Three-name three-card UI matches this — the same-URL ' +
          'collapse is a hub-affordance defect against rung 1, not a design intent. The 6.3.3 ' +
          'design says "the agile group … link cards into the SHIPPED surfaces" — that names ' +
          'WHICH primitives the new pages compose (4.6.5 / 4.6.6 mounts), not "all three deep-' +
          'link to the same URL." The shipped code collapsed three logical destinations onto one ' +
          'href and the design did not call for that.\n\n' +
          '**User impact.** (a) The Velocity-chart card is functionally dead — clicking it lands ' +
          'on the sprint report, which shows velocity as a side-by-side widget but does not let ' +
          'the user focus on it or jump between historical sprints to compare. (b) The Burndown-' +
          'chart card is half-functional — it lands on the sprint report which DOES contain a ' +
          'burndown section, but the user has no sprint picker (the burndown of any other sprint ' +
          "requires navigating to that sprint's report). (c) The hub itself fails its own " +
          '"grouped index" framing: an index where three entries point at the same destination is ' +
          'a bookmarks pane, not an index. (d) URL-bar tabs collapse — a user opening "Velocity ' +
          'chart" + "Sprint report" in two tabs gets two identical tabs.\n\n' +
          '**Root cause (clear — one `agileHref` computed once, reused three times).** ' +
          '`app/(authed)/reports/page.tsx:54-58` computes a single `agileHref` based on the ' +
          'active sprint (else most recent complete, else `/backlog`), then lines 68-90 mount ' +
          'three `<HubCard href={agileHref} …>` siblings. There is no branching, no per-card ' +
          'href; the destination is identical by construction. The 6.3.6 acceptance criteria ' +
          '("the hub matches the design (both groups; agile cards LINK, never redraw)") were ' +
          'satisfied at the "link, don\'t redraw" level but missed that each card needs a ' +
          'distinct link — the AC didn\'t say "three distinct URLs" and the implementer collapsed ' +
          'them; the design + Jira mirror both wanted three.\n\n' +
          '**Fix shape — three focused report pages, each composing the existing 4.6.x ' +
          'primitives + reads.** All chart components, all service reads, all DTOs already exist ' +
          '— this is composition, not new infrastructure.\n\n' +
          '1. **`/reports/burndown` (new page).** A focused project-level burndown report: a ' +
          "sprint picker (the project's sprints, default active else most-recent-complete) + the " +
          '4.6.5 `ReportBurndownSection` / 4.6.2 `BurndownChart` (`variant="full"`) for the ' +
          'picked sprint. Server Component, services-only per 4-layer; URL-driven sprint param ' +
          '(`?sprint=<id>`, the shipped `?view`/`?sort` convention from 2.5) so the picked sprint ' +
          'reloads/shares. Empty state when the project has no sprints (link to `/backlog`).\n' +
          '2. **`/reports/velocity` (new page).** A project-level cross-sprint velocity report: ' +
          'the 4.6.6 `VelocityChart` mounted at full page width with optional history-window + ' +
          'project-vs-board scope controls (URL-driven). The 4.6.4 `getVelocity` read already ' +
          'returns the cross-sprint series; the page just composes it standalone instead of as a ' +
          'side-widget. Low-history state (0–1 completed sprints) per the existing 4.6.6 design.\n' +
          '3. **Keep `/sprints/[id]/report` for the Sprint report card.** The third card stays ' +
          'pointed at the existing standalone sprint-report page (already a full per-sprint ' +
          'report with completed / incomplete / carried + the analytics row), but its href should ' +
          'still resolve to the active-sprint id (same `agileHref` logic, just isolated to this ' +
          'card).\n' +
          '4. **`app/(authed)/reports/page.tsx` re-wire.** Drop the single shared `agileHref`; ' +
          'compute three hrefs: `burndownHref = /reports/burndown` (with `?sprint=<active>` if ' +
          'one exists), `velocityHref = /reports/velocity`, `sprintReportHref = current ? ' +
          '/sprints/${current.id}/report : /backlog`. Pass each into its respective HubCard.\n' +
          '5. **i18n.** Update the existing `hub.burndownBody` copy ("Lives in the sprint ' +
          'report.") to match the new shape — e.g. "Points remaining across the active sprint, ' +
          'with a sprint picker." (en + zh both updated). The OTHER two copies are already shape-' +
          'correct.\n' +
          '6. **Sidebar / nav.** Verify the sidebar Reports link still points at `/reports` (it ' +
          'does — no change needed); the two new pages are reachable via the hub cards + direct ' +
          'URL. No new sidebar entries required.\n\n' +
          "**What's out of scope for this bug:** sprint picker UI primitive (use the existing " +
          'Combobox + a list of `sprintsService.listByProject`); chart redesign (composes 4.6.2 ' +
          'primitives as-is); a new design subtask (the new pages compose existing designed ' +
          'primitives and follow the existing report-page pattern at `/reports/created-vs-' +
          'resolved` and `/reports/distribution` — same chrome, same control vocabulary, just ' +
          'mounting a different chart; per the design-gate, composing existing primitives in ' +
          'their documented variants is NOT improvising a new surface). If a design tweak ' +
          'surfaces during build (e.g. how the sprint picker sits in the page header), capture ' +
          'as a finding and add a follow-up design subtask — do NOT block the fix on it.\n\n' +
          '## Acceptance criteria\n\n' +
          '- On `/reports`, the three Agile cards link to **three distinct URLs**: Burndown → ' +
          '`/reports/burndown` (with `?sprint=<id>` defaulting to active else recent-complete), ' +
          'Velocity → `/reports/velocity`, Sprint report → `/sprints/<active-id>/report` (else ' +
          '`/backlog` when no sprints exist).\n' +
          '- `/reports/burndown` renders a sprint picker + the full 4.6.5/4.6.2 burndown for the ' +
          'picked sprint. URL `?sprint=` param round-trips (reload + share restores).\n' +
          '- `/reports/velocity` renders the 4.6.6 velocity chart at full page width as a cross-' +
          'sprint history; low-history state (≤1 completed sprint) per the existing 4.6.6 ' +
          'design.\n' +
          '- Both new pages compose existing services only (4-layer; no new DB / Prisma / route ' +
          'changes; `reportsService.getBurndownSeries` + `.getVelocity` already exist).\n' +
          "- Per-viewer project gating works (no-access state on a project the viewer can't " +
          'see, mirroring the existing report pages).\n' +
          '- i18n strings updated in both `messages/en.json` and `messages/zh.json` for any copy ' +
          'that changes (the burndown card body line); existing strings preserved.\n' +
          '- The Burndown / Velocity / Sprint-report card titles + icons + groups are unchanged ' +
          '(this is a routing + new-page fix, not a hub redesign).\n' +
          '- A11y: hub cards keep their focus-ring + role; new pages pass the strict sweep; ' +
          'sprint picker keyboard-complete.\n' +
          '- An E2E (`tests/e2e/reports.spec.ts` — already exists per 6.3.7) extends to assert ' +
          'each of the three Agile cards lands on its expected URL and renders its expected ' +
          'chart, and that the burndown sprint picker reloads correctly.\n' +
          '- Shape + colour tokens unchanged (composes existing chart primitives via their ' +
          'documented variants).\n\n' +
          '## Context refs\n\n' +
          '- `app/(authed)/reports/page.tsx:54-58, 68-90` — the single-`agileHref`-three-cards ' +
          'site (the fix site)\n' +
          '- `app/(authed)/sprints/[id]/report/page.tsx` — the standalone sprint report (the ' +
          "sprint-report card's destination; unchanged)\n" +
          '- `app/(authed)/backlog/_components/BurndownChart.tsx` (4.6.2) + ' +
          '`ReportBurndownSection.tsx` (4.6.5) — the chart + section primitives the new ' +
          '`/reports/burndown` page composes\n' +
          '- `app/(authed)/backlog/_components/VelocityChart.tsx` (4.6.6) — the chart the new ' +
          '`/reports/velocity` page composes\n' +
          '- `lib/services/reportsService.ts` — `getBurndownSeries`, `getVelocity` (already ' +
          'shipped; the new pages call these directly Server-Component-side)\n' +
          '- `lib/services/sprintsService.ts` — `listByProject` (already used by the hub for the ' +
          'agileHref; reused for the sprint picker)\n' +
          '- `design/reports/dashboard.mock.html` panel 6 + `design/reports/design-notes.md` ' +
          'lines 290-291 — the design "agile group … link cards into the SHIPPED surfaces"; ' +
          'naming WHICH primitives compose, not "one URL"\n' +
          '- `app/(authed)/reports/created-vs-resolved/page.tsx`, ' +
          '`app/(authed)/reports/distribution/page.tsx` — the existing report-page pattern the ' +
          'two new pages mirror (header + URL-driven controls + chart + i18n)\n' +
          '- Story 6.3 (Reports + dashboards) — `done`, but Subtask 6.3.6\'s AC missed "three ' +
          'distinct URLs" → that\'s why the cards collapsed onto one href\n' +
          '- Jira reports menu (mirror product, rung 1) — Burndown / Velocity / Sprint report as ' +
          'three distinct pages with their own pickers and scope\n\n' +
          "**Refactor signal — Subtask AC drift.** Subtask 6.3.6's acceptance criteria said " +
          '"agile cards LINK, never redraw" but did NOT say "three distinct URLs." The implementer ' +
          "satisfied the letter (link, don't redraw — true; all three are `<Link>`s, none " +
          'redraws the chart) while violating the spirit (the cards are not an index if they all ' +
          'point at the same place). This is the second documented "AC satisfied by letter, ' +
          'violated by mirror-product intent" defect this cycle (sibling: ' +
          '`bug-notification-pref-transitioned-still-disabled-after-5-4-shipped`, where the seam ' +
          "comment named Story 5.4 by id and the 5.4 completion didn't flip it). Both are " +
          'planner-side process gaps: an AC that says "match the design" implicitly inherits ' +
          'mirror-product behaviour for everything the design under-specifies, and "match the ' +
          "mirror product\" is the planner's rung-1 obligation — not the implementer's. The fix " +
          'is to tighten ACs at PLAN time to name the rung-1 expectation explicitly when a card ' +
          'maps to a mirror-product behaviour that is not visually obvious (here: "three URLs, ' +
          'one per card, mirroring Jira\'s three reports"). Out of scope for this bug — captured ' +
          'as the refactor signal for a future planner-runbook tightening.',
      },
      {
        id: 'bug-sprint-report-charts-misaligned-burndown-missing-chart-sub',
        kind: 'bug',
        title:
          'Sprint report side-by-side charts misalign vertically — Burndown section is missing its `chart-sub` meta line that the 4.6.1 design specifies, but Velocity has one (and is rendering correctly)',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 6 (where the bug was DISCOVERED) · ' +
          '**Surfaces:** sprint report analytics row — the side-by-side charts ' +
          '(`app/(authed)/backlog/_components/SprintReport.tsx:179-197`) rendering ' +
          '`BurndownChart` (Subtask 4.6.5) + `VelocityChart` (Subtask 4.6.6) ' +
          '· **Code surface owned by:** Story 4.4 (Subtask 4.4.6 — the seam) + Story 4.6 ' +
          '(Subtasks 4.6.5 burndown / 4.6.6 velocity — the chart mounts) · **Status:** open · ' +
          '**Reported by:** Yue.\n\n' +
          'On the sprint report page (`/sprints/[id]/report`), the analytics row places the ' +
          'Burndown chart and the Velocity chart **side by side** per `design/reports/' +
          'charts.mock.html` panel 5 (the seam-placement panel — both charts dropped into the ' +
          'sprint-report seam reserved by 4.4.6). The two charts are **NOT vertically aligned**: ' +
          'the Velocity chart sits about a line lower than the Burndown chart, and consequently ' +
          'both the top (Y-axis cap line + first gridline) and the bottom (X-axis label / "View ' +
          'data table" affordance) drift out of horizontal alignment. The visual reads as ' +
          '"someone forgot to lay these out as a pair," which is exactly the bug: they ARE laid ' +
          'out as a pair (`flex` row, equal `basis-[300px]`, identical 600×300 SVG frames and ' +
          'shared `DEFAULT_MARGIN` from `ChartFrame`), but one section has an extra row of chrome ' +
          'above its chart that the other does not.\n\n' +
          '**Repro.** Sign in as `zhuyue@motir.co` / `!QAZ1qaz`, open the `moooon` / `motir` ' +
          'project → `/backlog`, click into a sprint with at least 2 completed predecessors so ' +
          'the velocity chart renders (not the low-history state), then open ' +
          '`/sprints/<id>/report`. Compare the two section frames in the analytics row: the ' +
          'Burndown header is one line ("📈 Burndown" + the chart legend underneath); the ' +
          'Velocity header is TWO lines ("📊 Velocity" + a sub-line "Last 3 completed sprints · ' +
          'avg completed 42.7" + the legend). The Velocity legend sits ~16-20px lower than the ' +
          'Burndown legend; the SVG chart frames cascade by the same offset; the X-axis labels ' +
          'and the "View data table" buttons at the bottom of each section misalign by the same ' +
          'amount.\n\n' +
          '**Root cause (high confidence — asymmetric pre-chart chrome).** The Burndown and ' +
          'Velocity primitives both target a 600×300 SVG via the same `ChartFrame.DEFAULT_MARGIN` ' +
          '(`{ top: 16, right: 16, bottom: 46, left: 44 }`) and the same `ChartLegend` rendered ' +
          'above the SVG with `mb-3`. The SVGs themselves are size-parity. The asymmetry is in ' +
          'the PRE-LEGEND chrome:\n\n' +
          '- `VelocityChart.tsx:72-77` renders an EXTRA `<span>` above its `<BarChart>`: ' +
          '*"{velocityWindow} · {velocityAverage}"* — the "last N completed sprints · avg ' +
          'completed N" meta line per `design/reports/charts.mock.html:1244-1248` (the design\'s ' +
          '`<div class="chart-head">` carries a `<h3 class="chart-title">Velocity</h3>` + a ' +
          '`<span class="chart-sub">last 7 completed sprints · avg completed 26</span>`).\n' +
          '- `BurndownChart.tsx:261-294` renders ONLY the chart — no `chart-sub` equivalent above ' +
          'the `<LineChart>`, even though `design/reports/charts.mock.html:878-880` specifies ' +
          'BOTH for burndown too: `<h3 class="chart-title">Sprint 6 · Burndown</h3>` + `<span ' +
          'class="chart-sub">Jun 2 → Jun 14 · completed · 42 pts committed</span>`. Same chrome ' +
          'pattern, present in the design, missing in the code.\n' +
          '- `SprintReport.tsx:179-197` hosts both sections with `flex flex-wrap gap-4` + ' +
          '`flex-1 basis-[300px]` per section. The section TITLES (the "📈 Burndown" and ' +
          '"📊 Velocity" lines) are mounted at the SECTION level (host-owned), so they ARE ' +
          'aligned. But the `chart-sub` meta sits INSIDE the velocity primitive ' +
          '(`VelocityChart`-owned) and is MISSING from the burndown primitive — so when the host ' +
          'lays the two sections side by side, one has a single header row above the chart and ' +
          'the other has two rows.\n\n' +
          'Net: the design specified two-line chart-heads on BOTH charts; the code implemented ' +
          'two-line head only on Velocity. The misalignment is the visible consequence.\n\n' +
          '**Class.** Design fidelity drift — a per-chart chrome detail the design drew on both ' +
          'panels but only one panel implemented. Not a layout bug (the `flex` / `basis` / SVG ' +
          'dimensions are correct), not a token bug (`--el-*` is correct), and not a margin bug ' +
          '(`DEFAULT_MARGIN` is correct). One missing element on one side; everything else is ' +
          'fine.\n\n' +
          '**Fix shape (recommended).** Add the missing burndown `chart-sub` meta line so both ' +
          'sections have the same two-row chrome above the SVG, per the design.\n\n' +
          '1. **`BurndownChart.tsx` — add a `<span className="text-xs text-(--el-text-muted)">` ' +
          "above the `<LineChart>`**, mirroring `VelocityChart.tsx:73-77`'s pattern. The copy " +
          'comes from the design (line 880): `Sprint 6 · Burndown` + `Jun 2 → Jun 14 · completed ' +
          '· 42 pts committed`. Drop the redundant "Sprint 6 · Burndown" prefix (the host section ' +
          'already names "Burndown"), so the sub-line is the date window + state + committed ' +
          'baseline: e.g. **`{start} → {end} · {state} · {committed} pts committed`** in the ' +
          "full variant. (Compact variant should keep its existing minimal chrome — that's the " +
          'scrum-header slot, panel 2.) The `BurndownSeriesDto` already carries `committed`, ' +
          '`state`, and day dates — no service/DTO change.\n' +
          '2. **i18n.** Add `sprintReport.burndownWindow` keys to `messages/en.json` and ' +
          '`messages/zh.json` matching the existing `sprintReport.velocityWindow` / ' +
          '`velocityAverage` pattern (window + state + committed-pts, ICU-formatted). Keep ' +
          'parallel naming so the en/zh files stay scannable.\n' +
          '3. **Wrap the `<div>` consistently** so both `BurndownChart` and `VelocityChart` ' +
          'return a `<div className="flex flex-col gap-2">` (currently burndown uses `gap-1`, ' +
          'velocity uses `gap-2`). Bring burndown to `gap-2` to match velocity — small ' +
          'consistency fix, lands inside the same diff.\n' +
          '4. **No `SprintReport.tsx` change.** The host section headers stay as-is (icon + ' +
          "name); the chart-sub line lives inside the chart primitive (matching the design's " +
          "`chart-head` block) so the primitive remains self-contained whether it's mounted in " +
          'the sprint report, the standalone `/reports/burndown` page (the sibling bug ' +
          '[[bug-reports-hub-agile-cards-collapse-to-one-url]] proposes), or anywhere else.\n\n' +
          '**Alternative fix (rejected).** Lift the velocity meta line OUT of `VelocityChart` ' +
          'and into the host section header (so both sections have one row of chrome and the ' +
          'sub-line disappears entirely). REJECTED because the design explicitly draws both ' +
          'charts with a `chart-sub` line (`charts.mock.html:878-880` for burndown and `:1244-' +
          '1248` for velocity — the planner verified both). Dropping the sub-line on velocity ' +
          'would mean dropping a documented design element to "fix" an alignment defect, when ' +
          'the design already says the alignment fix is to ADD the missing sub-line on burndown. ' +
          'Per the decision-authority ladder rung 1 (the mirror product / the design), the ' +
          'design wins.\n\n' +
          "**What's out of scope for this bug:** the compact-burndown variant (Story 4.5 scrum-" +
          'header slot — different design, panel 2, intentionally minimal). The empty / ' +
          'unestimated / low-history states (they already have their own micro-headers per ' +
          'panels 4 + 5). The standalone `/sprints/[id]/report` page chrome above the analytics ' +
          'row (the title + metaWindow + completedAt + goal line — unchanged).\n\n' +
          '## Acceptance criteria\n\n' +
          '- On `/sprints/[id]/report` for a sprint with ≥2 completed predecessors (velocity ' +
          'renders), the Burndown and Velocity sections are **vertically aligned**: both legends ' +
          'sit on the same Y; both SVG-frame tops sit on the same Y; both X-axis labels and ' +
          '"View data table" affordances sit on the same Y.\n' +
          '- The Burndown chart renders the missing `chart-sub` line above its `<LineChart>`, ' +
          "matching the velocity chart's posture and the design at `charts.mock.html:878-880`. " +
          'Copy: window (start → end) · state · committed-pts, ICU-formatted, both locales.\n' +
          "- The Velocity chart's existing `chart-sub` line is UNCHANGED (it was rendering the " +
          'design correctly all along).\n' +
          '- The compact-burndown variant in the scrum-header slot is UNCHANGED (panel 2 is ' +
          'minimal by design).\n' +
          '- Empty / unestimated / low-history states unchanged (their micro-headers per panels ' +
          '4 + 5 remain).\n' +
          '- Both chart primitives return `<div className="flex flex-col gap-2">` (the small ' +
          'consistency fix — burndown was `gap-1`, velocity was `gap-2`).\n' +
          '- Colour via `--el-*`, shape via element-semantic tokens; AA contrast holds; no new ' +
          '`--color-*` / raw `rounded-*`.\n' +
          '- A regression test: a Playwright (or RTL) assertion in `tests/e2e/sprint-report.spec.' +
          "ts` (or a sibling) that the burndown section's `<svg>` and the velocity section's " +
          '`<svg>` have equal `getBoundingClientRect().top` when both render on the standalone ' +
          'report page. Geometry, not CSS — same posture as the sibling sprint-report-modal-' +
          'clipped fix.\n\n' +
          '## Context refs\n\n' +
          '- `app/(authed)/backlog/_components/SprintReport.tsx:179-197` — the analytics row ' +
          'host (no change here)\n' +
          '- `app/(authed)/backlog/_components/BurndownChart.tsx:261-294` — the fix site ' +
          '(add the `chart-sub` `<span>` above the `<LineChart>`)\n' +
          '- `app/(authed)/backlog/_components/VelocityChart.tsx:72-77` — the existing pattern to ' +
          'mirror (already correct, no change)\n' +
          '- `components/ui/charts/LineChart.tsx`, `BarChart.tsx`, `ChartFrame.tsx` — the shared ' +
          'primitives (600×300, `DEFAULT_MARGIN = { top: 16, right: 16, bottom: 46, left: 44 }`, ' +
          '`ChartLegend mb-3`) — same on both sides, NOT the source of the misalignment\n' +
          '- `design/reports/charts.mock.html:878-880` (burndown chart-head, the missing piece) ' +
          'and `:1244-1248` (velocity chart-head, the implemented piece) — the design source\n' +
          '- `design/reports/design-notes.md:103-106` (the seam-placement note — both charts ' +
          'drop into the 4.4.6 sprint-report seam, side by side, per panel 5)\n' +
          '- `lib/dto/reports.ts` — `BurndownSeriesDto` (already carries `committed`, `state`, ' +
          'and day dates the new sub-line needs; no DTO change)\n' +
          '- `messages/en.json` `sprintReport.velocityWindow` / `velocityAverage` — the existing ' +
          'i18n pattern the new `burndownWindow` mirrors\n' +
          '- Sibling Epic-6 bugs in this PR: [[bug-sprint-report-modal-clipped-burndown]] ' +
          '(same surface, different defect — the modal clips the body; this is the analytics-row ' +
          'misalignment) and [[bug-reports-hub-agile-cards-collapse-to-one-url]] (also names the ' +
          '4.6.x chart primitives that this bug touches)\n\n' +
          '**Refactor signal — design-fidelity audit at chart-primitive level.** Both charts ' +
          'reach for the same shared `LineChart` / `BarChart` primitives + the same shared ' +
          '`ChartLegend` + the same shared `ChartFrame.DEFAULT_MARGIN`, but the per-chart ' +
          '`chart-head` chrome (title + sub) is hand-rolled inside each chart binder ' +
          '(`BurndownChart`, `VelocityChart`) — and the burndown binder forgot one element the ' +
          'design specified. A `ChartHead` primitive that takes `title` + `sub` props and is ' +
          'mounted by every chart binder would have prevented this entire shape of defect (the ' +
          'binder author would need to actively SKIP the `sub` prop, instead of forgetting to ' +
          'add it). Not in scope for this bug — captured as the refactor signal for a future ' +
          '4.6.2 primitive-extraction pass if a second chart binder ships with the same ' +
          'omission. The same shape generalises to legend / axis title / data-table affordance: ' +
          'anything the design draws on every chart panel should be a primitive, not a per-' +
          'binder copy.',
      },
      {
        id: 'bug-sprint-report-incomplete-list-zero-after-carry-over',
        kind: 'bug',
        title:
          'Sprint report on a COMPLETED sprint reads CURRENT membership for the "Issues not completed" list/count — so after carry-over moves the unfinished items out, the report shows 0 (Jira freezes the at-completion snapshot)',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 6 (where the bug was DISCOVERED) · ' +
          '**Surfaces:** sprint report read — `sprintsService.getSprintReport` ' +
          '(`lib/services/sprintsService.ts:518-580`), the standalone closed-sprint report page ' +
          '(`app/(authed)/sprints/[id]/report/page.tsx`), and indirectly the Reports hub Agile ' +
          'Sprint-report card (the standalone page is its destination) · **Code surface owned ' +
          'by:** Story 4.4 (Subtask 4.4.4 `getSprintReport` + 4.4.3 `completeSprint` carry-over) ' +
          '· **Status:** open · **Reported by:** Yue.\n\n' +
          'Complete a sprint with unfinished items and choose to carry them over to the next ' +
          'sprint (or the backlog). Then open `/sprints/<that-just-completed-sprint-id>/report` ' +
          '— Jira\'s closed-sprint report equivalent. The **"Issues not completed in this ' +
          'sprint"** section shows **0** with the empty-state copy ("Everything in scope was ' +
          'completed" or similar), and the not-completed list is empty. But the user knows real ' +
          "unfinished items existed at sprint completion (the complete-sprint dialog's carry-over " +
          'chooser told them so, and the items now sit in the next sprint / backlog). The report ' +
          "is silently lying about the sprint's outcome.\n\n" +
          '**Repro.** Sign in as `zhuyue@motir.co` / `!QAZ1qaz`, in `/backlog` start a sprint ' +
          'with 5 issues, mark 3 as done, click **Complete sprint** → carry the 2 unfinished to ' +
          '"Backlog" → confirm. The success-state modal correctly shows "2 not completed" with ' +
          'each row labelled "→ Backlog" (PRE-MOVE snapshot — see "Why the success modal looks ' +
          'right" below). Now reload, click **Open full report** on the same modal (or navigate ' +
          'directly to `/sprints/<id>/report`). The **standalone** report says **0 not ' +
          'completed**, the list is empty, but the points block still shows `committed: 5pts · ' +
          'completed: 3pts · notCompleted: 2pts` (because points use the immutable baseline + ' +
          'live rollup difference — see "What the report gets right" below). Net: a real Jira ' +
          'closed-sprint report would show the 2 unfinished items with "→ Backlog" labels; ' +
          "Motir's shows nothing.\n\n" +
          "**Mirror product (decision-authority rung 1).** Jira's **Sprint Report** for a " +
          'closed sprint is documented to display:\n\n' +
          '- **Completed Issues** — issues that were in the sprint at completion AND reached a ' +
          'done status\n' +
          '- **Issues Not Completed in this Sprint** — issues that were in the sprint at ' +
          'completion BUT did NOT reach done; each row carries a destination tag showing where ' +
          'it was moved (`→ Backlog` / `→ <Next Sprint>`)\n' +
          '- **Issues Removed From Sprint** — items pulled out manually BEFORE completion ' +
          '(distinct from carry-over)\n' +
          '- **Added After Sprint Started** — the scope-change figure\n\n' +
          'Crucially, Jira **freezes the at-completion membership snapshot** for the closed ' +
          'sprint report. Subsequently moving the carried-over items in the destination sprint, ' +
          "archiving them, or even deleting them does NOT change what the closed sprint's report " +
          "says — the closed sprint's history is immutable. This is the same posture Motir's " +
          'OWN code already takes for points (the immutable `committedPoints` baseline locked ' +
          'by `startSprint` in 4.4.2 — explicitly named in `sprintsService.ts:499-503` as "the ' +
          'IMMUTABLE `committed` baseline preserves the original scope") — but the LIST / COUNT ' +
          'silently drift to live membership in the same read. The two halves of the same DTO ' +
          'tell different stories.\n\n' +
          '**Root cause (high confidence — current-membership reads where historical were needed).** ' +
          '`sprintsService.getSprintReport` (`lib/services/sprintsService.ts:538-559`) builds the ' +
          '`incomplete` count + page via:\n\n' +
          '```ts\n' +
          'workItemRepository.countSprintIssuesByDoneMembership(id, ctx.workspaceId, {\n' +
          '  statusKeys: doneStatusKeys,\n' +
          '  include: false, // not-done\n' +
          '});\n' +
          'workItemRepository.findSprintIssuesByDoneMembership(id, ctx.workspaceId, {\n' +
          '  statusKeys: doneStatusKeys,\n' +
          '  include: false,\n' +
          '  take,\n' +
          '  cursor: options.incompleteCursor,\n' +
          '});\n' +
          '```\n\n' +
          'Both helpers read **current `work_item.sprintId` membership** from the `workItem` ' +
          'table. After `completeSprint` (`sprintsService.ts:330-460`) routes the unfinished ' +
          "issues out (4.4.3 sets each carried-over item's `sprintId` to the destination), " +
          '`workItem.sprintId !== <closed-sprint-id>` for those items, so they no longer match ' +
          'the membership filter → `incompleteCount = 0`, `incompleteRows = []`. The same code ' +
          'path works correctly for an **ACTIVE** sprint (membership IS the live truth there) ' +
          'and for an active-sprint LIVE PREVIEW from inside the complete-sprint modal (the ' +
          'modal fetches the report BEFORE calling complete — `CompleteSprintDialog.tsx:87-105` ' +
          '— so at fetch time membership still holds). The post-completion reload is when the ' +
          'drift surfaces.\n\n' +
          'The `sprintsService.ts:487-495` comment LITERALLY DOCUMENTS the bug as if it were the ' +
          'design: *"On a COMPLETED sprint, 4.4.3 has already carried the unfinished issues OUT, ' +
          'so the report shows what SHIPPED and stayed, while the IMMUTABLE `committed` baseline ' +
          'preserves the original scope (committed − completed = how much went unfinished) and ' +
          'the carry-over already routed those issues."* This is a planner-side judgment call ' +
          'that diverges from rung 1 with no documented use case — the comment is the smoking ' +
          'gun, not the defence. Per the decision-authority ladder, rung 1 (Jira) wins; the ' +
          'comment\'s framing is exactly the "AC satisfied by letter, mirror-product intent ' +
          'violated" anti-pattern this PR captured in [[bug-reports-hub-agile-cards-collapse-to' +
          '-one-url]] and [[bug-notification-pref-transitioned-still-disabled-after-5-4-shipped]].\n\n' +
          "**Why the success modal LOOKS right** (and isn't a contradicting data point). " +
          '`CompleteSprintDialog.tsx:87-105` fetches the report **BEFORE** `completeSprint` ' +
          'runs (`useEffect` runs on mount/open; `handleComplete` fires on submit, AFTER the ' +
          'fetch has populated `report`). The success-state `<SprintReport report={report} ' +
          'carryOverLabel={…}>` reuses that PRE-MOVE snapshot and re-renders the same row list ' +
          'with a "→ {destination}" badge per row (see `SprintReport.tsx:295-336` — the ' +
          '`carryOverLabel` prop branch). This is correct for the modal — and is exactly the ' +
          'SHAPE the standalone page must reproduce — but it works by **timing accident**, not ' +
          "by data design: if a parallel session's complete races the modal's fetch, the modal " +
          'would lose its snapshot too. The standalone page has no such timing window, so it ' +
          'NEVER sees the snapshot.\n\n' +
          "**What the report gets right (don't regress).** Several pieces of the report " +
          'already use historical / immutable data and must keep doing so:\n\n' +
          '- **`points.committed`** = `sprint.committedPoints`, the immutable baseline locked at ' +
          '`startSprint` (4.4.2). Unchanged.\n' +
          '- **`points.completed` + `points.notCompleted`** = the live rollup difference ' +
          '(`estimationService.rollupForSprint`). For an ACTIVE sprint this is the live truth; ' +
          'for a COMPLETED sprint this currently rolls up the items STILL in the sprint (the ' +
          'completed ones) — which gives the right `completed` figure but the wrong ' +
          '`notCompleted` (it would compute `0 not-completed-still-in-sprint` and then derive ' +
          '`notCompleted = committed - completed` for the missing-points number; verify which ' +
          'branch the rollup actually uses, and align with the new historical-list contract).\n' +
          '- **`addedAfterStart`** = `workItemRevisionRepository.countItemsAddedToSprintAfter` — ' +
          'already revision-trail based (`sprintsService.ts:564-569`). Unchanged. This is the ' +
          'proof that the infrastructure to read historical membership EXISTS in the codebase; ' +
          'the fix extends it.\n\n' +
          '**Fix shape — read at-completion membership for completed sprints, keep current ' +
          "membership for active ones.** The split is `sprint.state`-driven: an active sprint's " +
          '"incomplete" IS the live not-done items (their membership is current); a completed ' +
          'sprint\'s "incomplete" is whatever was in the sprint at `sprint.completedAt`.\n\n' +
          '1. **`workItemRepository`** — add two new helpers (or a `pointInTime?: Date` option ' +
          'on the existing pair):\n' +
          '   - `findSprintIssuesAtCompletion(sprintId, workspaceId, { atDate: sprint.completedAt, ' +
          'statusKeys, include, take, cursor })` — reads the `work_item_revision` trail to ' +
          "rebuild the membership SET at `atDate`, joins each item's status AT THAT TIME (so " +
          '"done at completion" is the correct status snapshot, not today\'s), and returns the ' +
          'page. Mirror the `countItemsAddedToSprintAfter` posture (`workItemRevisionRepository.ts:' +
          '112-130`) — same `work_item_revision`-based read, different query shape.\n' +
          '   - `countSprintIssuesAtCompletion(sprintId, workspaceId, { atDate, statusKeys, ' +
          'include })` — the count variant.\n' +
          '2. **`sprintsService.getSprintReport`** — branch on `sprint.state`:\n' +
          '   ```ts\n' +
          "   if (sprint.state === 'complete' && sprint.completedAt) {\n" +
          '     // historical reads — at-completion snapshot\n' +
          '     [completedCount, incompleteCount, completedRows, incompleteRows] = await ' +
          'Promise.all([\n' +
          '       countSprintIssuesAtCompletion(id, ws, { atDate: sprint.completedAt, statusKeys, ' +
          'include: true }),\n' +
          '       countSprintIssuesAtCompletion(id, ws, { atDate: sprint.completedAt, statusKeys, ' +
          'include: false }),\n' +
          '       findSprintIssuesAtCompletion(id, ws, { atDate: sprint.completedAt, statusKeys, ' +
          'include: true, take, cursor: completedCursor }),\n' +
          '       findSprintIssuesAtCompletion(id, ws, { atDate: sprint.completedAt, statusKeys, ' +
          'include: false, take, cursor: incompleteCursor }),\n' +
          '     ]);\n' +
          '   } else {\n' +
          '     // active sprint — current membership (existing path, unchanged)\n' +
          '   }\n' +
          '   ```\n' +
          '3. **Carry-over destination per row** — each not-completed row needs a ' +
          "`carryOverTo: { kind: 'backlog' } | { kind: 'sprint', name: string }` field on the " +
          '`SprintReportPageRowDto` so the standalone page can render the "→ Backlog" / ' +
          '"→ <Sprint name>" badge per Jira. Source: the revision trail entry that moved the ' +
          'item out of this sprint (the `sprintId` change right after `sprint.completedAt`). ' +
          "The DTO already accommodates a destination via the modal's `carryOverLabel` prop on " +
          '`SprintReport` (line 91 of SprintReport.tsx) — extend the DTO so the destination is ' +
          "PER ROW and authoritative (the modal's single-label-for-all was a shortcut because " +
          'the modal knew the user just chose one destination — Jira allows different ' +
          'destinations per row over time, e.g. some carried, some manually removed later).\n' +
          "4. **`SprintReport.tsx` consumer** — pass each row's destination through " +
          '`ReportIssueRow` (currently `carryOverLabel` is a single string for ALL rows; promote ' +
          'to per-row from the DTO). The modal continues to pass its single label as a fallback ' +
          "for the PRE-MOVE snapshot case where the DTO doesn't carry destinations yet.\n" +
          '5. **`points.notCompleted` for completed sprints** — re-derive from the at-completion ' +
          'snapshot too, so the points and the list AGREE. Currently for a completed sprint ' +
          'with carry-over the live rollup says `completed = 3, remaining = 0` → ' +
          '`notCompleted = 0`, contradicting the immutable `committed = 5`. Either compute ' +
          '`notCompleted = committed - completed` (the rough-but-correct fallback the comment ' +
          'already gestures at), OR — better — sum story points across the at-completion ' +
          'incomplete set (matches the new list exactly).\n\n' +
          "**What's out of scope for this bug:** rewriting the active-sprint path (it works), " +
          'restructuring `completeSprint` (no carry-over logic change), changing the ' +
          'work-item-revision schema (the trail already records sprint changes — verify before ' +
          'building the historical reader). The modal-success-state PRE-MOVE snapshot path stays ' +
          'as a sensible "we just made the move, here\'s what we just moved" UI affordance — but ' +
          'after the fix, even a fresh fetch into the standalone page reproduces the same shape ' +
          'via the new historical reader. If the revision trail does not record sprint-membership ' +
          "changes today (verify in `workItemsService.update*`), that's an out-of-scope " +
          "prerequisite — log a separate finding and gate this bug's fix on that landing.\n\n" +
          '## Acceptance criteria\n\n' +
          '- For a **COMPLETED** sprint where the user carried N unfinished items out, ' +
          '`GET /api/sprints/<id>/report` returns `incomplete.totalCount = N`, ' +
          '`incomplete.items.length = min(N, take)`, with each item being the same one that was ' +
          'unfinished at `sprint.completedAt`.\n' +
          '- Each not-completed row in the DTO carries a per-row carry-over destination ' +
          '(`backlog` / `{ sprintId, name }`) derived from the revision trail. The standalone ' +
          'page renders the "→ Backlog" / "→ <Sprint name>" badge per row (matching the ' +
          "modal's `carryOverLabel` posture and Jira).\n" +
          '- For an **ACTIVE** sprint the read path is **unchanged** (current membership; the ' +
          'live preview the complete-sprint modal already consumes stays byte-identical).\n' +
          '- `points.completed` and `points.notCompleted` on a completed sprint AGREE with the ' +
          'incomplete-list count: `notCompleted == committed - completed` (or, equivalently, ' +
          'equals the sum of story-points across the at-completion incomplete set). No more ' +
          'self-contradicting DTO.\n' +
          '- A regression test (integration, real Postgres): start sprint A with 5 issues, ' +
          'complete 3, carry 2 to Sprint B, complete A. Assert `GET /api/sprints/<A>/report` ' +
          'returns `incomplete.totalCount = 2`, the 2 items carry `carryOverTo = { kind: ' +
          '"sprint", name: "B" }`, and that subsequently moving one of those items in Sprint B ' +
          "(or to the backlog, or deleting it) does NOT change Sprint A's report (immutability " +
          'guarantee).\n' +
          "- The standalone page's i18n strings (`sprintReport.sectionNotCompleted`, the empty-" +
          'state copy) are unchanged. The "Issues removed from sprint" Jira concept (items ' +
          'pulled out BEFORE completion) is captured as a follow-up, not part of this fix — log ' +
          "a finding if the revision trail doesn't already distinguish it.\n" +
          '- 4-layer respected: new repository helpers (single Prisma `$queryRaw` calls per the ' +
          'existing revision-trail pattern), service composes them in `getSprintReport`, no ' +
          'changes in route layer.\n\n' +
          '## Context refs\n\n' +
          '- `lib/services/sprintsService.ts:487-580` — `getSprintReport` (the fix site) + the ' +
          'docstring comment that names the current behaviour as if it were the design (the ' +
          'smoking gun)\n' +
          '- `lib/services/sprintsService.ts:330-460` — `completeSprint` carry-over (where the ' +
          'membership move happens; informs the revision-trail query that rebuilds the snapshot)\n' +
          '- `lib/repositories/workItemRepository.ts` — `countSprintIssuesByDoneMembership` + ' +
          '`findSprintIssuesByDoneMembership` (the current-membership readers; the new ' +
          '`*AtCompletion` variants live alongside)\n' +
          '- `lib/repositories/workItemRevisionRepository.ts:112-130` ' +
          '(`countItemsAddedToSprintAfter`) — the existing revision-trail-based reader; the ' +
          'pattern to mirror for `findSprintIssuesAtCompletion` / `countSprintIssuesAtCompletion`\n' +
          '- `app/(authed)/backlog/_components/CompleteSprintDialog.tsx:87-105, 130-180` — the ' +
          "success modal's PRE-MOVE-snapshot fetch + single-label `carryOverLabel` (the shape " +
          'the per-row destination DTO field generalises)\n' +
          '- `app/(authed)/backlog/_components/SprintReport.tsx:295-336` — `ReportIssueRow` ' +
          '(consumes `carryOverLabel`; promote to per-row from the DTO)\n' +
          '- `app/(authed)/sprints/[id]/report/page.tsx` — the standalone report (the surface ' +
          'that exhibits the bug)\n' +
          '- `lib/dto/sprints.ts:81-150` — `SprintReportDto` (extend with per-row carry-over)\n' +
          '- Jira docs: closed-sprint Sprint Report (the rung-1 reference for the at-completion ' +
          'snapshot + the per-row destination tag)\n' +
          '- Sibling Epic-6 bugs in this PR: ' +
          '[[bug-sprint-report-modal-clipped-burndown]], ' +
          '[[bug-sprint-report-charts-misaligned-burndown-missing-chart-sub]] (also touch the ' +
          'sprint-report seam; the modal-clip bug is on the same modal whose PRE-MOVE snapshot ' +
          'is doing the right thing today). ' +
          '[[bug-reports-hub-agile-cards-collapse-to-one-url]] proposes a `/reports/burndown` + ' +
          '`/reports/velocity` split; the Sprint-report card destination ' +
          '(`/sprints/<id>/report`) is unchanged by this bug but its contents become CORRECT.\n\n' +
          '**Refactor signal — DTO whose fields read from different time horizons.** This is the ' +
          'second instance of "the same DTO has fields computed from different snapshots and ' +
          'they tell contradictory stories" — first was Story 5.4 vs the notification matrix ' +
          "guard (the runtime ships, the UI guard doesn't flip — different time horizons of " +
          "the same feature). Here it's within ONE DTO: `committed` is at-start-snapshot, " +
          '`notCompleted points` is live-rollup, `incomplete list/count` is live-membership. ' +
          'Three different time horizons. The right structural fix is to make the read function ' +
          "declare its `at: 'start' | 'completion' | 'now'` snapshot stance ONCE and apply " +
          'it consistently to every field — the function signature itself enforces internal ' +
          'consistency. Not in scope for this bug (the fix is to make the closed-sprint read ' +
          "fully `at: 'completion'`); captured as the refactor signal for a future " +
          '`reportsSnapshotAt(sprintId, when)` extraction across sprint and (eventually) board ' +
          'reports.',
      },
      {
        id: 'bug-sprint-report-modal-clipped-burndown',
        kind: 'bug',
        title:
          'Complete-sprint success modal: SprintReport bypasses Modal.Body, so the burndown section is clipped off the bottom with no scroll affordance',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 6 (where the bug was DISCOVERED) · ' +
          '**Surfaces:** complete-sprint flow success state ' +
          '(`app/(authed)/backlog/_components/CompleteSprintDialog.tsx:183-213`, Subtask 4.4.1 ' +
          'modal) rendering the shared `SprintReport` body ' +
          '(`app/(authed)/backlog/_components/SprintReport.tsx`, Subtask 4.4.6) + the modal ' +
          'primitive (`components/ui/Modal.tsx`, Subtask 1.0.5) · **Code surface owned by:** ' +
          'Story 4.4 (Sprint completion + report) · **Status:** open · **Reported by:** Yue.\n\n' +
          'On the **complete-sprint success modal** (the post-`POST /api/sprints/[id]/complete` ' +
          'success state — the modal whose title is `{sprint.name} 报告` / `{sprint.name} report`), ' +
          'the bottom of the report is **clipped off** with no scrollbar. The 3-up points rollup, ' +
          'scope-change line, completed section, and the start of the not-completed list are ' +
          'visible; the **燃尽图 (burndown) section** is rendered but cut off at the modal’s ' +
          'bottom edge — the chart legend bar (`理想线 · 剩余 · 新增范围`) is partly visible, the ' +
          'chart itself is not, and the velocity chart (`size="lg"` modal also renders the side-by-' +
          'side analytics row, design panel 5) is unreachable. The modal panel sits at its ' +
          '`max-h-[90vh]` cap; the user has no way to see the rest of the body short of opening ' +
          'the standalone `/sprints/[id]/report` page via the “Open full report” footer link.\n\n' +
          '**Repro.** Sign in as `zhuyue@motir.co` / `!QAZ1qaz`, open the `moooon` / `motir` ' +
          'project → `/backlog`, click **Complete sprint** on an active sprint (Sprint 4 in the ' +
          'reported screenshot — “Sprint 4 · Sprints & backlog”). Pick any carry-over destination, ' +
          'submit. The success-state modal opens with title `{sprint.name} 报告`. At typical ' +
          'laptop heights (≤ ~900px) observe that the modal grows to `max-h-[90vh]`, the body ' +
          'panel is cropped at that height, and the analytics row at the bottom of `SprintReport` ' +
          '(the burndown + velocity charts) is partly or fully outside the modal viewport with NO ' +
          'scroll affordance on the body. The modal’s body does not scroll; the page behind it ' +
          'does not scroll; the content is just clipped.\n\n' +
          '**Root cause (high confidence — single-line miss in the success-state render).** ' +
          '`Modal` (`components/ui/Modal.tsx:34-47, 188-224`) caps the panel at ' +
          '`flex max-h-[90vh] flex-col overflow-hidden` and delegates body scrolling to its ' +
          '`Modal.Body` subcomponent (`flex min-h-0 flex-1 flex-col overflow-y-auto`). A consumer ' +
          'that passes long content as a DIRECT child of `<Modal>` (without `Modal.Body`) inherits ' +
          'the cap WITHOUT the scroll recipe — the inner column lays out at its natural height, ' +
          'the panel’s `overflow-hidden` clips it, and nothing scrolls.\n\n' +
          'The success state in `CompleteSprintDialog.tsx:185-213` is exactly this shape — ' +
          '`<Modal …><SprintReport … /><Modal.Footer>…</Modal.Footer></Modal>`. `SprintReport` ' +
          'returns a `<div className="flex flex-col gap-4">…</div>` with the meta line, points ' +
          'rollup, scope-change row, two `ReportSection` lists, and the analytics row — easily ' +
          'taller than 90vh once the not-completed list has any rows and the burndown’s chart ' +
          'block is present. The form state of the SAME modal (the carry-over chooser, ' +
          '`CompleteSprintDialog.tsx:217-364`) DOES wrap its body in `<Modal.Body>` and scrolls ' +
          'correctly when fields stack — the success state is the asymmetric miss.\n\n' +
          'The standalone `/sprints/[id]/report` page ' +
          '(`app/(authed)/sprints/[id]/report/page.tsx`) does NOT have this bug because it is a ' +
          'normal authed page route — the document scrolls — so the same `SprintReport` component ' +
          'renders fully there. This is what makes the success-state modal the only affected ' +
          'surface.\n\n' +
          '**Class.** Third documented “long content in a `Modal` with `overflow-hidden` cap but ' +
          'no `Modal.Body` scroll seam” shape — sibling family with ' +
          '`bug-inline-edit-clipped-when-table-short` (table overflow, fixed via body-portal) and ' +
          '`bug-combobox-menu-clipped-inside-modal` (Combobox listbox clipped by modal). Those two ' +
          'are popover-in-clip-box defects; this one is body-in-clip-box (the simpler shape). The ' +
          '`Modal.Body` recipe already exists for exactly this case; the success state simply ' +
          'doesn’t reach for it.\n\n' +
          '**Fix shapes (decide at fix time — listed by likely durability):**\n' +
          '1. **Wrap `<SprintReport>` in `<Modal.Body>` in `CompleteSprintDialog`’s success ' +
          'state** (minimal, contained). Replace ' +
          '`<SprintReport report={report} sprint={completedSprint} statusByKey={statusByKey} ' +
          'carryOverLabel={carryOverLabel} />` with ' +
          '`<Modal.Body className="gap-4"><SprintReport … /></Modal.Body>` so the body fills the ' +
          'remaining column height (panel cap minus title + footer) and scrolls internally; the ' +
          '`Modal.Footer` stays pinned, and the analytics row is reachable. Mirrors the carry-over ' +
          'form-state branch of the SAME component (`CompleteSprintDialog.tsx:231-340`) — same ' +
          'modal, same recipe, just applied to the success branch too. (The `gap-4` className is ' +
          'carried over from `SprintReport`’s outer `<div>`, which can then drop its own ' +
          '`flex flex-col gap-4` wrapper if desired — or keep it; both work, the outer is a ' +
          'no-op once the body is a flex column.)\n' +
          '2. **Make `Modal` scroll its direct children by default** (broader; would also pre-empt ' +
          'a future fourth occurrence). Change the panel from `overflow-hidden` to a layout where ' +
          'the child column is itself scrollable, e.g. apply ' +
          '`overflow-y-auto` to the panel and keep `overflow-hidden` only on the cross-axis, or ' +
          'add a default `min-h-0 flex-1 overflow-y-auto` wrapper around `children` (excluding ' +
          'the `Modal.Footer` slot, which must stay pinned). Higher-risk — would change layout ' +
          'semantics for every existing Modal consumer (e.g. the create-issue modal’s expandable ' +
          'Explanation already relies on the current cap shape) and the focus-ring inset recipe ' +
          'lives on `Modal.Body`, not the panel. Probably not worth it for a one-call-site miss.\n' +
          '3. **Lint/jsx-typecheck** that long-content modals use `Modal.Body`. Too narrow to be a ' +
          'real rule (a short modal correctly omits `Modal.Body`); reserve for the rule-of-three ' +
          'footer below.\n\n' +
          '**Recommended:** fix 1. One-line change at the success-state site; no Modal API ' +
          'change; the existing `Modal.Body` recipe is exactly the seam that was meant to be ' +
          'used. Fix 2 is overreach for a single missed wrapper. Coverage gap that let it ship: ' +
          'no Playwright assertion on the success-state modal’s body scrollability with a ' +
          'long carry-over list — the carry-over form state was tested for scroll (mounted ' +
          '`Modal.Body`), the success state was not.\n\n' +
          '## Acceptance criteria\n\n' +
          '- On a viewport whose height is ≤ ~900px (typical laptop), opening the complete-sprint ' +
          'success modal with a sprint whose report body exceeds the modal’s `max-h-[90vh]` cap ' +
          '(any sprint with a few not-completed issues + the burndown rendered) shows a scrollable ' +
          'body: the burndown + velocity analytics row is reachable by scrolling inside the ' +
          'modal, NOT clipped at the bottom edge.\n' +
          '- The fix is at the `CompleteSprintDialog` success-state call site ' +
          '(`<Modal.Body>` wrapping `<SprintReport>`) — not a workaround inside `SprintReport` and ' +
          'not a change to the `Modal` primitive — so the `/sprints/[id]/report` standalone page ' +
          'is unaffected (it remains a normal scrolling page).\n' +
          '- The `Modal.Footer` (Open full report + Done) stays PINNED at the bottom of the ' +
          'panel as the body scrolls.\n' +
          '- The focus-ring inset recipe (`Modal.Body`’s `-m-1.5 p-1.5`) is preserved — any ' +
          '`Input`/control inside the report keeps its 4px focus-ring overhang from being clipped.\n' +
          '- The carry-over FORM state of the same modal is unchanged (it already uses ' +
          '`Modal.Body`); no regression there.\n' +
          '- A Playwright regression asserts the success-state modal’s body is scrollable when ' +
          'the report content exceeds the panel height: measure ' +
          '`bodyEl.scrollHeight > bodyEl.clientHeight`, scroll to the bottom, and assert the ' +
          'burndown section is visible (`getBoundingClientRect().bottom <= dialogRect.bottom`). ' +
          'Same geometry-not-CSS posture as the sibling overflow bugs ' +
          '(`bug-issue-detail-eyebrow-overflows-viewport`, ' +
          '`bug-combobox-menu-clipped-inside-modal`).\n' +
          '- next-intl strings unchanged; no service / DTO / route / DB change; AA contrast ' +
          'preserved; shape + colour tokens unchanged.\n\n' +
          '## Context refs\n\n' +
          '- `app/(authed)/backlog/_components/CompleteSprintDialog.tsx:182-213` — the ' +
          'success-state render (the fix site); compare with ' +
          '`CompleteSprintDialog.tsx:231-340` (the form state already wraps in `Modal.Body`)\n' +
          '- `app/(authed)/backlog/_components/SprintReport.tsx` (Subtask 4.4.6) — the shared ' +
          'presentational body; rendered identically here and on the standalone page\n' +
          '- `components/ui/Modal.tsx:34-47` (`contentVariants`, `flex max-h-[90vh] flex-col ' +
          'overflow-hidden`) + `Modal.tsx:188-224` (`ModalBody` — the `flex-1 overflow-y-auto` ' +
          'scroll recipe + the `-m-1.5 p-1.5` focus-ring inset) — the primitive whose seam this ' +
          'fix reaches for\n' +
          '- `app/(authed)/sprints/[id]/report/page.tsx` — the standalone closed-sprint report ' +
          'page; reference case where document scroll already works (no fix needed)\n' +
          '- `design/sprints/sprint-lifecycle.mock.html` panels 6–7 + ' +
          '`design/reports/charts.mock.html` panel 5 — the design intent: the analytics row is ' +
          'PART of the report body, not a hidden overflow\n' +
          '- `bug-inline-edit-clipped-when-table-short`, ' +
          '`bug-combobox-menu-clipped-inside-modal` (sibling family) — popover-shape clip-box ' +
          'defects in the same overflow-hidden family; this is the body-shape sibling\n' +
          '- `motir-core/CLAUDE.md` — the colour + shape token rules (a `Modal.Body` wrap ' +
          'introduces no new tokens; this is purely a layout fix)\n\n' +
          '**Refactor signal (rule of three).** This is now the **third** documented occurrence ' +
          'of “Modal’s `overflow-hidden` panel clips content because the consumer didn’t reach ' +
          'for the `Modal.Body` scroll seam.” The first two ' +
          '(`bug-inline-edit-clipped-when-table-short`, `bug-combobox-menu-clipped-inside-modal`) ' +
          'were popovers inside the cap; this one is the BODY itself. The `Modal.Body` opt-in ' +
          'shape is documented but easy to skip — a long-body modal that ships without it is ' +
          'this defect. Consider, in a follow-up Subtask: (a) a `<Modal scrollBody>` opt-out ' +
          'inverse where the default IS `Modal.Body` and a consumer that wants raw children ' +
          'opts out, OR (b) a Storybook/RTL render test that mounts every existing ' +
          '`<Modal>` consumer with synthetic long content + asserts no clipping. Not in scope ' +
          'for this bug; the rule of three is the trigger for the refactor pass.',
      },
      {
        id: 'bug-card-header-loses-padding-when-body-overrides-p-0',
        kind: 'bug',
        title:
          'Settings → Project → Details: the "Project details" card title and the Admin pill render flush against the card edges, because the editable variant overrides Card padding to `p-0` (to let body dividers extend edge-to-edge) but the Card header slot has no padding of its own and inherited the outer pad',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 6 (where the bug was DISCOVERED) · ' +
          '**Surfaces:** project settings → **Details** page → `ProjectDetailsCard` ' +
          '(`app/(authed)/settings/project/_components/ProjectDetailsCard.tsx`, Story 6.8) ' +
          'AND the shared `Card` primitive ' +
          '(`components/ui/Card.tsx`) — the API gap is in the primitive, the visible symptom is on ' +
          'the Details page · **Status:** open · **Reported by:** Yue.\n\n' +
          'On **Settings → Project → Details** (admin view), the card header row — the ' +
          '**"Project details"** title (left) and the **Admin** pill (right) — sits visibly flush ' +
          "against the card's outer edges. The title hugs the left border and the Admin pill " +
          'hugs the right border, with no horizontal breathing room. The body BELOW the header ' +
          '(Avatar / Name / Key field stack) is correctly padded, so the asymmetry is loud: the ' +
          'header looks like a separate, mis-styled slab on top of a normal card.\n\n' +
          '**Repro.** Sign in as `zhuyue@motir.co` / `!QAZ1qaz`, open the `moooon` / `motir` ' +
          'project, go to **Settings → Project → Details**. Observe the **Project details** card: ' +
          'the h2 title on the left and the Admin pill on the right have **zero left/right ' +
          'padding** against the card border. The "Your project\'s name, avatar and key. …" ' +
          'description copy ABOVE the card is also flush left against the page gutter — adjacent ' +
          'but a separate finding (page-level intro is unpadded too). The READ-ONLY variant ' +
          '(non-admin member) does NOT exhibit the bug, because that branch renders the card with ' +
          'default Card padding (no `p-0` override) — the comparison case.\n\n' +
          '**Root cause (high confidence — source confirms it).** `Card` ' +
          '(`components/ui/Card.tsx:21–24, 65`) paints its padding on the OUTER box via ' +
          '`p-(--spacing-card-padding)` from `cardVariants`, then renders the header slot as ' +
          '`<div className="mb-(--spacing-md)">{header}</div>` — **the header has only a bottom ' +
          'margin; no inline padding of its own.** The header was implicitly inheriting the outer ' +
          "`p-(--spacing-card-padding)` from the Card's box.\n\n" +
          'The editable Details branch ' +
          '(`ProjectDetailsCard.tsx:170–171`) overrides Card to `className="p-0"` and re-pads ' +
          'ONLY the body: `<Card header={<CardHead canManage t={td} />} className="p-0"> <div ' +
          'className="flex flex-col p-(--spacing-card-padding)">…</div></Card>`. The override ' +
          'exists for a real reason — the body uses an inline FieldStack list with full-width ' +
          'dividers (`border-b border-(--el-border)`) between fields, and the dividers must ' +
          "extend edge-to-edge inside the card, which only works if the Card's outer padding is " +
          "OFF and the body re-pads itself. But the same `p-0` ALSO strips the header's " +
          'inherited padding, leaving `CardHead` (the title + Admin pill in a ' +
          "`flex items-center justify-between` row) flush against the card's outer border.\n\n" +
          'The read-only branch (`ProjectDetailsCard.tsx:71–95`) uses plain ' +
          '`<Card header={…}>…</Card>` with default padding, so the header inherits ' +
          '`p-(--spacing-card-padding)` and renders correctly — confirming the bug is the ' +
          '`p-0` override path, not the `CardHead` component itself.\n\n' +
          '**This is a Card API gap, not a one-off mistake.** There is no documented way for a ' +
          'caller to say "give me a card whose HEADER is padded but whose BODY extends edge-to-' +
          'edge" — the two are coupled to a single `p-(--spacing-card-padding)` on the outer ' +
          'box. Any consumer that wants edge-to-edge body content (a list with full-width row ' +
          'dividers, a table whose header rule spans the full card width, a media tile with a ' +
          'flush-left thumbnail) hits this. **Class:** "Primitive\'s padding lives on the wrong ' +
          'DOM box for the layout we actually wanted." Same shape as the sibling ' +
          '`bug-account-notifications-row-divider-broken-by-cell-padding` earlier in this PR ' +
          '(border-on-each-cell vs. border-on-row-wrapper).\n\n' +
          '**Fix shapes (decide at fix time — listed by durability).**\n' +
          '1. **Slot-level padding in `Card` (durable, recommended).** Move the ' +
          "`p-(--spacing-card-padding)` OFF the Card's outer box and ONTO each slot " +
          'individually: the header slot, the children/body slot, and the footer slot each get ' +
          'their own `p-(--spacing-card-padding)`. Add an opt-out per slot — e.g. ' +
          '`<Card bodyFlush>` (or a per-slot `headerClassName` / `bodyClassName` prop) — for the ' +
          'edge-to-edge case so the body can drop its padding while the header KEEPS its own. ' +
          'This makes `<Card bodyFlush header={…}>` the canonical shape for the ' +
          '`ProjectDetailsCard` editable variant and any future list/table card. **Why durable:** ' +
          'every consumer that wants flush body content (the list-with-dividers pattern is going ' +
          'to recur — see the Notifications card sibling bug) is the same Card API gap; fixing ' +
          'it once at the primitive prevents the next occurrence. Aligns with the `Modal` ' +
          'precedent: `Modal.Body` is the documented seam for "let the body do its own padding."\n' +
          '2. **Pad the header inline at the consumer (minimal change, fragile).** Inside ' +
          '`ProjectDetailsCard.tsx:170`, replace `header={<CardHead … />}` with ' +
          '`header={<div className="p-(--spacing-card-padding) pb-0"><CardHead … /></div>}`. ' +
          'Fixes the visible symptom in one file. **Why fragile:** the next card that wants the ' +
          'same edge-to-edge body shape will repeat the workaround; the Card API gap stays. Also ' +
          'every consumer ends up reimplementing the same padding math, which silently drifts.\n\n' +
          '**Recommended:** fix 1 (slot-level padding in `Card`). It is the same shape as the ' +
          '`Modal.Body` seam (let the body opt out of the outer padding, header/footer stay ' +
          'padded), and it eliminates the API gap that will otherwise re-bite the next consumer. ' +
          'The migration is mechanical: scan the codebase for every existing `<Card>` use, and ' +
          'for the ones that need the OLD behavior (header + body share one padded box) nothing ' +
          'changes since slot padding sums to the same outer pad; for the ones that overrode ' +
          '`className="p-0"` (this card, and grep for any others) replace with `bodyFlush` so the ' +
          'header recovers its padding.\n\n' +
          '**Adjacent finding (NOT in this bug, but observed).** The Details PAGE header — the ' +
          '**"Details"** h1 title + the "Your project\'s name, avatar and key. …" intro copy ' +
          'above the card — also hugs the page gutter without left padding. That is a page-' +
          'level layout concern (the `SettingsLayout` container or the page itself), not a Card ' +
          'concern; it is out of scope for this bug and should be logged separately if it is a ' +
          'real defect rather than the intended design.\n\n' +
          '**Test gap that let it ship.** The existing `ProjectDetailsCard` tests cover the ' +
          'editable flow (name save, avatar pick, key change modal), but no test renders the ' +
          "card and asserts the **rendered geometry of the header** — the title's left edge " +
          "should sit `p-(--spacing-card-padding)` away from the card's outer left edge, and " +
          "the Admin pill's right edge should sit `p-(--spacing-card-padding)` away from the " +
          "card's outer right edge. The fix MUST add either a render-test or Playwright " +
          "measurement: render the admin view, measure the title's `getBoundingClientRect().left " +
          '- card.getBoundingClientRect().left`, assert it equals the card padding token value.\n\n' +
          '## Acceptance criteria\n\n' +
          '- On **Settings → Project → Details** (admin view), the **"Project details"** card ' +
          'title and the **Admin** pill render with the standard card padding on the left and ' +
          'right — NO flush-against-edge appearance, visually consistent with the read-only ' +
          "variant's header.\n" +
          '- The body FieldStack (Avatar / Name / Key) and its full-width dividers continue to ' +
          'extend edge-to-edge inside the card — the fix must NOT regress the body layout to a ' +
          'doubly-padded shape that shrinks the dividers.\n' +
          '- The read-only variant (`canManage={false}`) renders identically to today ' +
          '(regression guard on the green-path layout).\n' +
          '- A render-test (`tests/components/project-details-card-*.test.tsx`) or Playwright ' +
          "assertion measures the rendered geometry: the card-header title's `boundingClientRect " +
          ".left` minus the card's `boundingClientRect.left` equals the card padding token, and " +
          "the Admin pill's right inset is symmetric.\n" +
          '- AA contrast preserved (no colour change); the header copy + Admin pill keep their ' +
          'current `--el-*` tokens.\n' +
          '- If fix 1 is taken (slot-level padding in `Card`): every existing `<Card>` consumer ' +
          'in the codebase is audited and updated where the new slot model changes the rendered ' +
          'output; the `bodyFlush` (or chosen prop) shape is documented in the `Card.tsx` ' +
          'doc-comment as the canonical seam for edge-to-edge body content.\n\n' +
          '## Context refs\n\n' +
          '- `components/ui/Card.tsx:21–24, 65` — `cardVariants` puts `p-(--spacing-card-padding)` ' +
          'on the outer box; the header slot is `<div className="mb-(--spacing-md)">` with no ' +
          'inline padding of its own (the API gap)\n' +
          '- `app/(authed)/settings/project/_components/ProjectDetailsCard.tsx:170–171` — the ' +
          'editable branch overrides `<Card className="p-0">` and re-pads ONLY the body via the ' +
          'inner `<div className="flex flex-col p-(--spacing-card-padding)">`, stripping the ' +
          "header's inherited padding (the visible fix site)\n" +
          '- `app/(authed)/settings/project/_components/ProjectDetailsCard.tsx:71–95` — the ' +
          'read-only branch (default Card padding; the comparison case — no symptom)\n' +
          '- `app/(authed)/settings/project/_components/ProjectDetailsCard.tsx:303–320` — ' +
          '`CardHead` (the title + Admin/Read-only Pill row inside the header slot; not at fault)\n' +
          '- `components/ui/Modal.tsx` — the `Modal.Body` precedent: opt-in scroll seam that ' +
          'inverts which slot owns the padding; same shape as the recommended `bodyFlush` Card ' +
          'opt-in\n' +
          '- `motir-core/CLAUDE.md` — shape via element-shape tokens (the fix introduces no new ' +
          'tokens; this is purely a layout API change to how `Card` distributes its existing ' +
          '`--spacing-card-padding` across slots)\n' +
          '- Sibling bug `bug-account-notifications-row-divider-broken-by-cell-padding` (this ' +
          'same PR) — same class: "primitive\'s padding lives on the wrong DOM box for the ' +
          'layout we actually wanted." Both fixes lift the padding/border onto a different DOM ' +
          'level so the layout can express edge-to-edge content without losing the surrounding ' +
          'shell.\n\n' +
          '**Refactor signal (rule of three watch).** This is the SECOND documented occurrence ' +
          'of "consumer needed edge-to-edge body content and resorted to overriding the ' +
          "primitive's outer padding to `p-0`, losing the header/footer shell's padding as a " +
          'side-effect" (the first being any existing `<Card className="p-0">` use in the ' +
          'codebase — grep at fix time). The third occurrence justifies promoting the slot-' +
          'level-padding shape to the project standard for ALL shell primitives ' +
          '(Card / Panel / Sheet), not just Card.',
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
    items: [
      {
        id: '7.20',
        kind: 'bug',
        title:
          'Production work_item reads 500 (P2022 ColumnNotFound) — triage-marker columns ' +
          '(externalSubmitterName/Email, triagedAt, snoozedUntil) missing on prod from migration drift',
        status: 'done',
        type: 'bug',
        descriptionMd:
          '**Type:** bug · **Parent:** Epic 7 (discovery epic — surfaced right after the 7.8.3 ' +
          'deploy while closing out that Epic-7 subtask; per the discovery-epic rule the bug ' +
          'files here, NOT to the code-surface epic that owns the migration, Epic 6 / 6.11.3) · ' +
          '**Surfaces:** every full-row `work_item` read — reported as ' +
          '`GET /api/work-items/[id]/rollup` (the epic progress rollup: ' +
          '`estimationService.rollupForParent` → `workItemRepository.findById` → ' +
          '`prisma.workItem.findUnique`) returning 500; "can\'t load work items from an epic". · ' +
          '**Status:** FIXED (PR #1151 merged + deployed). · **Source:** prod incident reported ' +
          'by Yue (2026-06-15) after merging the 7.8.3 feature PR.\n\n' +
          "Production's `work_item` table was MISSING `externalSubmitterName`, " +
          '`externalSubmitterEmail`, `triagedAt`, `snoozedUntil` and the ' +
          '`(projectId, triagedAt)` index — the objects migration ' +
          '`20260613221114_add_work_item_triage_marker` (Subtask 6.11.3) adds. `schema.prisma` ' +
          'and the generated Prisma client SELECT those columns on every `work_item.findUnique` ' +
          '(no explicit `select`), so each full-row read threw ' +
          '`PrismaClientKnownRequestError P2022 ColumnNotFound`. List/board reads that use ' +
          'narrow `select` clauses kept working, which is why only the rollup / epic-detail ' +
          'surface visibly broke. The 7.8.3 merge did NOT cause it (token routes + settings UI ' +
          'only); the drift was latent and loading an epic merely exercised the affected read.\n\n' +
          '**Root cause (drift — exact mechanism uncertain, not confirmed against prod ' +
          '`_prisma_migrations`):** the `externalSubmitter*` columns were declared in ' +
          '`schema.prisma` (so the generated client SELECTs them) but absent from the prod DB. ' +
          'Two plausible mechanisms, both the same CLASS of schema-vs-DB drift: **(a)** the ' +
          '6.11.3 migration was recorded APPLIED on prod via `prisma migrate resolve --applied` ' +
          'WITHOUT its `ALTER` running (the documented shared-dev-DB drift escape hatch marks ' +
          'history without executing SQL); or **(b)** the 6.11.10 DROP of these very columns ' +
          '(PR #1146, OPEN at incident time) was applied to prod ahead of that PR merging — so ' +
          "the columns were dropped while main's schema still declared them. Either way: " +
          '**schema declares a column the DB lacks** — invisible to `migrate status` (reports ' +
          '"up to date"), invisible to CI (a fresh DB replays the real SQL), reproducible only ' +
          'on the drifted environment.\n\n' +
          '**Fix:** motir-core PR #1151 — a forward-only, IDEMPOTENT repair migration ' +
          '(`20260615120000_repair_work_item_triage_marker_columns`) re-adds the columns + index ' +
          'with `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`: it adds the missing ' +
          'objects on prod and is a no-op everywhere they already exist; no `schema.prisma` ' +
          'change (so `migrate dev` reports no drift).\n\n' +
          '**Resolution:** PR #1151 merged 2026-06-15 and deployed; the Vercel build ran ' +
          '`prisma migrate deploy`, the repair migration added the missing columns + index, and ' +
          'the epic rollup / work-item reads load again (verified by Yue on prod). **Note — ' +
          'these columns are being RETIRED:** Subtask 6.11.10 (PR #1146) drops ' +
          '`externalSubmitterName`/`Email` and removes them from the schema (the public portal ' +
          'was retired; triage attribution is now always `submittedByUserId`). So the durable ' +
          "end-state is columns-GONE — #1151's re-add was the correct EMERGENCY fix (it matched " +
          "main's then-current schema, which still declared the fields), and #1146's drop " +
          'migration was re-sequenced (renamed to `20260615130000_drop_triage_external_submitter` ' +
          "+ `DROP COLUMN IF EXISTS`) to land AFTER #1151's repair so the two do not fight on a " +
          'fresh-DB replay (add → repair re-add no-op → drop = gone, matching schema).\n\n' +
          '**Lesson (notes.html #41):** keep the prod DB and `schema.prisma` in lockstep — a ' +
          'full-row `findUnique`/`findFirst` (no `select`) SELECTs every schema scalar, so ONE ' +
          'column that exists in the schema but not the DB 500s every such read while ' +
          'narrow-`select` reads survive (masking the scope). The two ways to get there: ' +
          '`migrate resolve --applied` a migration whose SQL never ran, or apply a DROP from an ' +
          'unmerged PR to prod ahead of its schema change landing — never do either. If a ' +
          'shared-DB drift forces a manual fix, run the real SQL (or an idempotent equivalent) ' +
          'and keep the migration that matches it on `main`; repair forward-only with an ' +
          'idempotent `IF NOT EXISTS` migration, and re-sequence any conflicting later migration ' +
          'after it. Prefer narrow `select`s on hot read paths. And reproduce the real error ' +
          'before blaming the most-recently-merged diff.',
      },
    ],
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
        status: 'done',
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

/**
 * Top-level **parentless** bugs — root siblings of the epics themselves.
 *
 * When a bug surfaces against a code surface whose owning epic is already
 * `status: 'done'`, parenting the bug to that epic would re-open sealed work
 * and contradict the done state. The MOTIR.md bug-parent rule says to log it
 * **without** a parent instead — `bug.parentId IS NULL` is legal under the
 * kind-parent matrix (`work_item_triggers.sql`). The id is a **single integer
 * with no dot** — the next free top-level id that doesn't collide with an
 * existing epic id (currently `1`–`10`) or a previously-logged parentless bug.
 *
 * The loader (`seed.ts`) iterates this array AFTER the epic pass and creates
 * each entry with `parentId: null` and `kind: 'bug'`, so they appear at the
 * project root next to the epics in Motir's tree views.
 */
export const PARENTLESS_BUGS: PlanItem[] = [
  {
    id: '11',
    kind: 'bug',
    title: 'Sprint complete: target sprint card / backlog not refreshed when unfinished items move',
    status: 'done',
    type: 'bug',
    descriptionMd:
      '**Type:** bug · **Parent:** none (root sibling — Epic 4 Agile planning is `done`, so per ' +
      'MOTIR.md the bug logs parentless) · **Discovered in:** Story 4.4 (sprint lifecycle — ' +
      '`completeSprint` from subtask 4.4.3) + Story 4.5 (backlog list) · **Reported by:** Yue.\n\n' +
      'After completing a sprint that still has unfinished work items, the user picks a target — ' +
      'either a **future (planned) sprint** or the **backlog** — to receive those incomplete ' +
      'issues. The complete-sprint write itself succeeds: the active sprint flips to `complete` ' +
      'and the unfinished items reparent to the chosen target. BUT the **destination surface is ' +
      'NOT refreshed**: the future sprint card on the sprints page shows its pre-move issue list ' +
      '(no new rows / count), and the backlog list likewise still reads the pre-move state. The ' +
      'moved items are visible only after a manual page refresh or after navigating away and back. ' +
      'The board / list reads as if the move silently failed.\n\n' +
      '**Repro:** sign in as `zhuyue@motir.co` / `!QAZ1qaz`, open the `moooon` / `motir` project ' +
      '→ Sprints page. Pick an `active` sprint that has at least one issue not in the done ' +
      'category. Click **Complete sprint** and in the dialog choose **Move to <a planned sprint>** ' +
      '(or **Move to backlog**). Confirm. Observe: the active sprint flips to complete (correct), ' +
      'but the target planned-sprint card on the same page does NOT show the moved issues / its ' +
      'committed count is unchanged. Reload the page → the moved issues now appear in the target ' +
      'card. Same shape if the target is the backlog (Story 4.5): the backlog list reads pre-move ' +
      "until reload. **Compare:** the active sprint's own card DOES refresh (its in-place flip to " +
      'complete works), so the gap is specifically the **destination** of the move, not the ' +
      'source.\n\n' +
      '**Root cause (suspected — to be confirmed during fix).** `completeSprint` (subtask 4.4.3) ' +
      'is one transaction that flips the sprint state + reparents the unfinished items, returning ' +
      'a DTO. The Sprints page client invalidates the **active-sprint** view on success but does ' +
      'NOT invalidate the **target** view — neither the planned-sprint card list nor the backlog ' +
      "list — so React's cached fetch for those surfaces stays. The right fix is to broaden the " +
      'mutation-success invalidation set so EVERY surface whose item set changed re-fetches: the ' +
      'completing-sprint card, the chosen target sprint card (when target is a sprint), the ' +
      'backlog list (when target is backlog), and any sprint-aware aggregates on the page (sprint ' +
      'rollup / committed counts from 4.3.3). Likely sites: the Sprints page hook calling ' +
      "`completeSprint`, the backlog page hook, and the sprint-card components' fetch keys.\n\n" +
      '## Acceptance criteria\n\n' +
      '- After **Complete sprint → Move to <planned sprint X>**, the planned sprint X card on the ' +
      'Sprints page immediately shows the moved issues (its list grows; its committed-issue / ' +
      'point counts reflect the new total) — **without a manual reload**.\n' +
      '- After **Complete sprint → Move to backlog**, the backlog list (Story 4.5) immediately ' +
      'shows the moved issues without a manual reload (whether viewed on the Sprints page backlog ' +
      'section or on the dedicated backlog surface).\n' +
      "- The completing sprint's own card still correctly flips to `complete` and stops showing " +
      'the moved items (the source side is unregressed).\n' +
      '- Other on-page aggregates that depend on the move (e.g. velocity baseline for the now-' +
      'complete sprint, committed-count for the target sprint) re-render with the post-move ' +
      'numbers, not pre-move ones.\n' +
      '- A regression test (component or E2E) drives **Complete sprint → Move to planned sprint** ' +
      'and **→ Move to backlog**, asserts the target surface re-fetches on the success response ' +
      '(see the E2E `waitForResponse` discipline in motir-core CLAUDE.md), and asserts the moved ' +
      'issue is visible in the target card / backlog list on the SAME page render (no reload).\n\n' +
      '## Context refs\n\n' +
      '- `lib/services/sprintsService.ts` — `completeSprint` (subtask 4.4.3): the write returns ' +
      'the updated active sprint; check whether the response DTO names the target so the client ' +
      'can invalidate it deterministically.\n' +
      '- `app/(authed)/projects/[key]/sprints/_components/*` — the Sprints page client: the ' +
      'complete-sprint dialog + the on-success invalidation set (almost certainly missing the ' +
      'target-side keys).\n' +
      "- `app/(authed)/projects/[key]/backlog/_components/*` — Story 4.5's backlog list: the " +
      'cache key the move must invalidate when target is backlog.\n' +
      '- `lib/services/workItemsService.ts` — issue list / sprint-membership queries the target ' +
      'surfaces read.\n' +
      '- Story 4.3 `rollupForSprint` — the committed/completed/remaining aggregate the target ' +
      'card displays; must re-read post-move so the count is right.\n\n' +
      '**Why this matters.** The complete-sprint flow is the load-bearing seam between an active ' +
      "sprint and the next one. A user who can't see the move land on the destination reasonably " +
      'concludes the move silently failed and re-runs it (or worse, manually drags the items, ' +
      'creating double-moves). The fix is small and local — broaden the invalidation set on the ' +
      'mutation success — but the symptom is high-confusion. Fits the Story 4.4 fix surface; the ' +
      'closing-out subtask should land under Story 4.4 (or a fresh follow-up story under Epic 4 ' +
      "if Yue prefers to scope it separately) with the bug's id (`11`) named in its Context refs.",
  },
];
