import type { PlanStory } from '../types';

/**
 * Story 5.5 — Activity history feed.
 *
 * The read surface over the append-only trail every other story has been
 * feeding since 1.4.6: render the `work_item_revision` rows as a
 * human-readable **History** feed on the issue detail view, and complete the
 * Activity section's tab set — **All / Comments / History** — in the seam
 * Story 5.1 designs and builds (its section header carries the History filter
 * as the documented 5.5 slot). NO new write model: the stub's "append-only
 * activity" already exists; this story is mapping + merging + rendering.
 *
 * 📦 Lives in Epic 5. Deps: 5.5 siblings + 5.1.2/5.1.3/5.1.5 (same epic,
 * earlier story — the comments read for the All merge + the Activity-section
 * design/UI seam) + done 1.4.6. Cross-epic audit clean: no forward dep.
 *
 * Mirror-product check (decision-ladder rung 1 — VERIFIED against Atlassian
 * sources at plan time, 2026-06-10):
 *   • **Tabs** — Jira's Activity filters are All / Comments / History / Work
 *     log; **All is the merged stream**; the default tab is Comments. We ship
 *     All / Comments / History (no worklog feature → no tab), default
 *     Comments — the mirror set minus the feature we don't have.
 *   • **Entry anatomy** — actor + timestamp + "changed the <Field>" + old →
 *     new values, null sides rendered as the empty form ("None"). Verified
 *     via the changelog model (`changeitem`: field, old, new, null for
 *     empty) + Atlassian's own UI strings.
 *   • **What History shows** — field edits, workflow transitions, and
 *     comment DELETIONS (who/when, never the content — matching what 5.1.2
 *     records); comment ADDS live under Comments/All only (the verified-safe
 *     default — no official doc puts adds in History).
 *   • **One sort toggle across tabs** — the per-user newest/oldest control
 *     applies to comments AND history together (JRACLOUD-73076, Fixed) —
 *     so 5.1.5's toggle generalises to the whole section, not per-tab.
 *   • **Append-only** — history can't be edited or deleted by ANYONE,
 *     admins included (the open JRACLOUD-78612/76283 requests confirm no
 *     mutation surface exists). Mirrored: this story ships READ-ONLY — no
 *     mutation API of any kind.
 *   • **Scale** — Jira's REST changelog is paginated and long histories are
 *     a known perf complaint; the UI batch size is undocumented. We ship the
 *     house shape: cursor-paged + "Show more" (finding #57), reusing the
 *     1.4.6 repo's existing cursor read (rung-2: `listByWorkItem` already
 *     pages newest-first by `(changedAt, id)`).
 *
 * The load-bearing piece is the **diff-renderer registry** (rung-2 audit done
 * at plan time): the trail's vocabulary today is ~20 scalar keys (title,
 * status, assigneeId, priority, dueDate, estimateMinutes, kind, parentId,
 * descriptionMd, explanationMd, storyPoints, archivedAt, position, …) plus
 * `sprintId`/`backlogRank` (4.x), `links: {added/removed}` (2.4), and the
 * in-flight 5.1–5.4 shapes (comment-deleted, `attachments`, `labels`,
 * `components`, `customFields.<key>`). Per the mistake-#29 lesson the
 * registry must be **TOTAL over every key the codebase writes, with a
 * generic fallback** for unknown keys — so a sibling story landing a new
 * diff shape degrades to a legible generic entry, never a crash or a silent
 * drop. Ids resolve to display values at read time (users → names/avatars,
 * status keys → labels, option ids → labels, linked ids → identifiers) in
 * BATCHED, per-page-bounded lookups.
 *
 * ⚠️ Design gate (planning-time). The History entry row grammar, the All
 * merged stream, and the per-change-type renderings are undesigned (5.1.3
 * draws the Activity section + the tab seam only) → subtask **5.5.3** is the
 * `type: design` subtask, dependsOn 5.1.3 (it extends that asset's section
 * grammar), so it seeds `'blocked'`; the UI code subtask (5.5.4) carries it
 * + the 5.1.5 section seam in `dependsOn` (Principle #13).
 *
 * Expanded from its `stubs.ts` entry per `prodect plan 5.5`, on the standing
 * `seed/epic-5-plan` branch. Matches the canonical style of 5.1–5.4.
 */
export const story_5_5: PlanStory = {
  id: '5.5',
  title: 'Activity history feed',
  status: 'planned',
  descriptionMd:
    'The per-issue **History** feed: every field change, transition, link/label/component/' +
    'attachment change, sprint move, and comment deletion — rendered chronologically from the ' +
    '**append-only `work_item_revision` trail that already exists** (1.4.6; every mutating path ' +
    'records a diff — the rung-2 audit at plan time found 17 call sites and no gaps). This story ' +
    'adds NO write model: it is the read mapping (diff → human-readable entry), the **All** ' +
    'merged stream (comments + history interleaved), and the tab UI completing the Activity ' +
    'section Story 5.1 ships with the History seam reserved.\n\n' +
    '**The Jira-verified shape (rung 1, checked at plan time).** Activity filters **All / ' +
    'Comments / History** (Jira adds Work log — we have no worklog feature, so no tab), default ' +
    '**Comments**, with **ONE per-user newest/oldest toggle spanning all tabs** (the verified ' +
    "JRACLOUD-73076 behaviour — 5.1.5's toggle generalises to the section). A History entry is " +
    '**actor + "changed the <Field>" + old → new + timestamp**, empty sides as "None" (the ' +
    'changelog null). History carries field edits, transitions, and **comment deletions** ' +
    '(who/when, never the content — exactly what 5.1.2 records); **comment adds stay under ' +
    'Comments/All** (the verified-safe default). And History is **append-only — no edit or ' +
    'delete surface for anyone, admins included** (mirrored: this story ships read-only, no ' +
    'mutation API exists).\n\n' +
    '**The renderer registry (the real work).** Diffs are machine shapes ' +
    '(`{ assigneeId: { from: "u_1", to: "u_2" } }`); the feed needs sentences ("Bo changed the ' +
    'Assignee: Odie → Mo"). A per-key registry maps every diff key the codebase writes — the ' +
    'scalar fields, `status` (workflow labels), `sprintId`/`backlogRank` (sprint moves render as ' +
    '"moved to Sprint X" / rank changes are NOISE — collapsed, see below), `links` ' +
    '(added/removed with identifiers), and the in-flight 5.1–5.4 shapes (`attachments`, ' +
    '`labels`, `components`, `customFields.<key>` via the definition label, comment-deleted) — ' +
    '**TOTAL with a generic fallback** (mistake #29: a lookup over an open set must cover every ' +
    'value; unknown future keys render a legible generic "changed <key>" entry, never crash or ' +
    'vanish). Display resolution is **batched per page** (users, status labels, option labels, ' +
    'linked identifiers — one lookup set per page, no N+1) and tolerant of deleted referents ' +
    '(a removed user/option/issue renders its stored id/name fallback, never a broken entry). ' +
    '**Noise policy (a deliberate decision):** pure `position`/`backlogRank` reorders and the ' +
    'denormalised `key`/`identifier` writes are suppressed from the feed (Jira does not show ' +
    'board-reorder noise in History; the data stays in the trail) — the registry marks keys ' +
    'renderable/suppressed explicitly, so suppression is also total, not accidental.\n\n' +
    '**The All stream.** Comments (5.1) and history entries interleave chronologically under ' +
    '**All** — a service-level merge of the two cursor-paged sources with a composite ' +
    '`(timestamp, type, id)` cursor, page-bounded from both sides (never fetch-all-then-sort; ' +
    "finding #57). The Comments tab stays exactly 5.1.5's surface; the History tab is " +
    'revisions only; All is the merge with each entry in its native row grammar.\n\n' +
    '**Completeness — the real-product states.** The `created` revision renders as the feed ' +
    'anchor ("Bo created the issue"); `archived` renders; empty History ("No history yet" — ' +
    'practically unreachable since create writes one, but the state exists); loading skeleton ' +
    'rows; `ErrorState`; "Show more" at each tab\'s older edge; the sort toggle flipping all ' +
    'tabs together; viewer read-only (the whole surface is read-only anyway — no affordance ' +
    'delta); deleted-referent fallbacks. All drawn by 5.5.3, asserted in 5.5.5.\n\n' +
    '**Out of scope (documented extension slots, each justified):** a Work log tab (no ' +
    'time-tracking feature — the tab follows the feature if one ever lands); history for ' +
    'comment EDITS beyond the Edited tag (Jira keeps no comment version history either); ' +
    'cross-issue/project-level activity streams (Epic-6 reporting territory); retention/purge ' +
    'admin (the mirror has none — append-only is the contract); rendering rank/position noise ' +
    '(suppressed by the explicit policy above); realtime updates (the section refreshes like ' +
    'every other surface — the 5.1 decision).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (NO migration — this ' +
    'story adds no write model; "No difference detected"), `pnpm db:seed`, `pnpm dev`.\n' +
    '- `pnpm test:coverage` — Vitest (real Postgres) over the activity read service (registry ' +
    'totality, batching, merge cursor) ≥90% per-file branch/fn/line.\n' +
    '- **History flow:** sign in as `zhuyue@prodect.co` / `!QAZ1qaz`, open an issue with a ' +
    'history (edit title, change status, assign, link an issue, set a custom field, add+delete ' +
    'a comment first) → Activity → **History** (matching the 5.5.3 design): entries read as ' +
    'sentences with actor avatar + name + "changed the <Field>" + old → new (empty side ' +
    '"None"), the status entry shows workflow labels not keys, the link entry shows the ' +
    'identifier, the custom-field entry shows the field label and option label, the comment ' +
    'deletion shows who/when and NO content, and the oldest entry is "created the issue".\n' +
    '- **All flow:** the **All** tab interleaves the comments and history entries in true ' +
    'timestamp order, each in its native row grammar; the **Comments** tab is unchanged ' +
    "(5.1.5); the section's ONE sort toggle flips all three tabs together; the default tab " +
    'is Comments.\n' +
    '- **Noise policy:** drag the issue around a board/backlog (position/rank writes) → NO ' +
    'feed entries appear for pure reorders; the trail still holds the rows (DB check).\n' +
    '- **Scale check (finding #57):** seed an issue with 200+ revisions + 50 comments (the ' +
    '5.5.5 fixture) → History first-paints one page + "Show more"; All pages via the ' +
    'composite cursor (network shows bounded reads from both sources, never fetch-all).\n' +
    '- **Fallbacks:** delete a user/option referenced by an old entry (or simulate) → the ' +
    'entry renders the stored fallback, never a crash; an artificially-injected unknown diff ' +
    'key renders the generic entry.\n' +
    '- **Read-only:** no mutation route/action exists for revisions (code audit + 404 on ' +
    'probing); cross-workspace reads 404 (finding #44).\n' +
    '- `pnpm test:e2e --grep activity` — Playwright over the real stack: the History + All ' +
    'journeys above.\n' +
    "- **a11y check:** the tabs are a proper `tablist` (or the section's filter grammar from " +
    'the design), entries are a labelled feed readable as text, the sweep over the populated ' +
    'section is clean; colour via `--el-*`, shape via element tokens.',
  items: [
    {
      id: '5.5.1',
      title:
        'Activity read service — paged revision feed + the TOTAL diff-renderer registry (batched display resolution, noise policy, fallbacks)',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: [],
      descriptionMd:
        'The mapping layer: `lib/services/activityService.ts` (read-only — no writes, no ' +
        'mutation routes) turning `work_item_revision` rows into renderable ' +
        '`ActivityEntryDto`s.\n\n' +
        '**`listHistory(workItemId, { cursor, order }, ctx)`** — view-gated (404 ' +
        'cross-workspace, finding #44), riding the EXISTING 1.4.6 repo cursor read ' +
        '(`listByWorkItem` pages newest-first by `(changedAt, id)` — rung-2; extend the repo ' +
        'with the `asc` variant for the oldest-first order, same index). Page size 20, ' +
        '`totalCount` for the tab badge/Show-more copy.\n\n' +
        '**The renderer registry** (`lib/activity/renderers.ts`): one entry per diff key, ' +
        'each producing a typed `ActivityEntryDto` part — `{ field, verb, from, to }` display ' +
        'forms. Coverage is **TOTAL over the audited vocabulary** (the plan-time call-site ' +
        'audit): the scalar field keys from create/update/move/archive (`title`, ' +
        '`descriptionMd` → rendered as "updated the Description" without inlining the body, ' +
        '`explanationMd`/`explanationSource`, `kind`, `priority`, `assigneeId`, `reporterId`, ' +
        '`dueDate`, `estimateMinutes`, `storyPoints`, `parentId`, `archivedAt`, `projectId`, ' +
        '`key`/`identifier`, `position`), `status` (workflow LABELS via the project workflow, ' +
        'not raw keys), `sprintId` (sprint names — "moved to <Sprint>" / "moved to the ' +
        'backlog"), `backlogRank`, `links` (added/removed → identifiers + link kind), and the ' +
        '5.1–5.4 shapes as they land (`attachments`, `labels`, `components`, ' +
        '`customFields.<key>` via the definition label, the comment-deleted record) — plus ' +
        'the **generic fallback** for any unknown key ("changed <key>", raw values ' +
        'stringified safely). Mistake #29: the lookup is total BY CONSTRUCTION — a registry ' +
        'miss falls through to the fallback, never throws, never silently drops.\n\n' +
        '**Noise policy (explicit, not accidental):** keys marked `suppressed` — pure ' +
        '`position`/`backlogRank`-only diffs and the denormalised `key`/`identifier` writes — ' +
        'produce NO entry (Jira shows no reorder noise); a diff mixing suppressed + ' +
        'renderable keys renders the renderable parts. The suppression list lives IN the ' +
        'registry so every key has an explicit disposition.\n\n' +
        "**Display resolution, batched per page:** collect the page's referenced ids " +
        '(actors + assignee/reporter values → users; status keys → workflow labels; option ' +
        'ids → option labels; linked ids → identifiers; sprint ids → names) and resolve in ' +
        'ONE batched lookup set (no N+1). Deleted referents degrade to the stored id / a ' +
        '"former member" form — never a crash. `created` renders as the anchor entry; ' +
        '`archived` renders.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `listHistory` pages both orders over the existing index with `totalCount`; ' +
        'view-gated; cross-workspace 404; NO mutation surface exists anywhere in the new ' +
        'code (read-only contract).\n' +
        '- The registry covers EVERY diff key found in the plan-time audit with explicit ' +
        'renderable/suppressed disposition + the generic fallback; a test enumerates the ' +
        "codebase's recordRevision call sites' keys against the registry (the totality " +
        'guard — a new unregistered key fails the test, pointing at the fallback decision).\n' +
        '- Status renders workflow labels; sprint moves render names; links render ' +
        'identifiers; description edits never inline body text; suppressed keys produce no ' +
        'entry; mixed diffs render partially.\n' +
        '- Resolution is one batched lookup set per page (asserted — no per-entry queries); ' +
        'deleted referents render fallbacks.\n' +
        '- `pnpm test:coverage` ≥90% across the registry branches incl. fallback + ' +
        'suppression.\n\n' +
        '## Context refs\n\n' +
        '- `lib/repositories/workItemRevisionRepository.ts` (`listByWorkItem` — the existing ' +
        'cursor read to extend with `asc`) + `lib/services/workItemRevisionsService.ts` + ' +
        'the `WorkItemRevisionDto` diff shape\n' +
        '- The plan-time diff-vocabulary audit in the Story 5.5 description (the 17 call ' +
        'sites); `notes.html` mistake #29 (total lookups)\n' +
        '- `workflowsService` (status labels), `sprintRepository` (names), the 5.3 ' +
        'option/definition reads, the member DTOs — the resolution sources\n' +
        '- finding #44 (404-not-403); finding #57 (paged, never load-all)',
    },
    {
      id: '5.5.2',
      title:
        'The "All" merged stream — comments + history interleaved by composite cursor (bounded two-source merge)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['5.5.1', '5.1.2'],
      descriptionMd:
        "The merged tab's read: `activityService.listAll(workItemId, { cursor, order }, " +
        'ctx)` interleaving the 5.1.2 comments read and the 5.5.1 history feed in true ' +
        'timestamp order.\n\n' +
        '**The merge (bounded — finding #57):** fetch ONE page from each source (comments ' +
        'cursor + revisions cursor, each take 20, same order), merge-sort by `(timestamp, ' +
        'type, id)`, emit the first 20, and return a **composite cursor** carrying each ' +
        "source's position — the classic two-pointer merge over paged streams; never " +
        'fetch-all-then-sort, never re-read consumed pages. Entries keep their native DTO ' +
        '(a comment entry IS the 5.1 comment DTO with its thread context flattened to the ' +
        'feed form the design specifies; a history entry IS the 5.5.1 entry) under a ' +
        'discriminated `type`. Comment-deleted revision entries appear in All (and ' +
        'History) exactly once — they are revisions, not comments; live comments appear ' +
        'as comments only (the verified comment-adds-not-in-History rule holds by ' +
        'construction).\n\n' +
        '**Order + gating:** both orders supported (the section toggle); view-gated; the ' +
        'same `totalCount` pair for the tab copy.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `listAll` interleaves correctly across page boundaries (a seeded interleaving ' +
        'where the nth page boundary splits a same-minute cluster round-trips without ' +
        'loss or duplication — the composite-cursor property test); both orders work.\n' +
        '- Each page issues exactly one bounded read per source (asserted); no ' +
        'fetch-all path exists.\n' +
        '- Discriminated entries carry their native shapes; comment deletions appear ' +
        'once (as history); live comments never duplicate into history.\n' +
        '- View-gated + 404 cross-workspace; `pnpm test:coverage` ≥90% incl. the ' +
        'boundary/duplication property cases.\n\n' +
        '## Context refs\n\n' +
        '- 5.5.1 (`listHistory` + entry DTOs); 5.1.2 (`listComments` — cursor take 20 + ' +
        'totalCount, the other source)\n' +
        '- The verified All-tab merge behaviour in the Story 5.5 description\n' +
        '- finding #57 (the bounded two-source merge requirement)',
    },
    {
      id: '5.5.3',
      title:
        'Design — History entries + the All stream (`design/work-items/activity-history.mock.html`: per-change-type row grammar, tabs, fallbacks)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 32,
      dependsOn: ['5.1.3'],
      descriptionMd:
        'The design asset for the History feed + the All merge. 5.1.3 designs the Activity ' +
        'SECTION (tabs seam, comments grammar, sort toggle) with History as its documented ' +
        'disabled slot — this asset extends that grammar to the history entries themselves ' +
        '(the design-gate NONE-exists case for every history row form). DependsOn 5.1.3 (it ' +
        "composes that asset's section + tab grammar — blocked until it lands). Output: " +
        '**`design/work-items/activity-history.mock.html`** + PNG + a design-notes section. ' +
        'Render checklist + AA + dark parity. Mirror: the verified Jira History anatomy.\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **The activated tab row** — All / Comments / History (the 5.1.3 seam made live; ' +
        'default Comments; counts per the reads), the ONE sort toggle governing all tabs ' +
        '(the verified cross-tab rule).\n' +
        '- **History row grammar** — compact, comment-row-aligned but visually quieter ' +
        '(the feed-vs-conversation distinction): actor Avatar (smaller) + name + the verb ' +
        'sentence + relative time. Per-change-type value forms: **scalar** ("changed the ' +
        'Priority: Medium → High" — old struck/muted, new emphasised; "None" for empty ' +
        'sides); **status** (the two workflow labels as `Pill`s with the → between); ' +
        '**assignee/user fields** (Avatar + name pairs); **dates** (formatted, the rail ' +
        'convention); **description/explanation** ("updated the Description" — no body ' +
        'inline); **links** ("linked PROD-12 as blocks" / removal form, identifier mono + ' +
        'link); **labels/components** (chip add/remove forms); **attachments** ' +
        '("attached <name>" / "removed the attachment <name>"); **custom fields** (the ' +
        'definition label + per-type value forms incl. option labels); **sprint** ("moved ' +
        'to Sprint 4" / "moved to the backlog"); **comment deleted** ("deleted a comment" ' +
        '+ reply-count gloss, NO content — the verified rule); **created** (the anchor: ' +
        '"created the issue") and **archived**; and the **generic fallback** row ' +
        '("changed <key>") — drawn so the fallback is a designed state, not an accident.\n' +
        '- **The All stream** — comments (full 5.1.3 grammar) interleaved with history ' +
        'rows (this grammar) in one chronology; the visual rhythm that keeps the two ' +
        'scannable (the quieter history rows between comment cards).\n' +
        '- **States** — "Show more" per tab edge; the loading skeleton (history-row ' +
        'variant); empty History; the deleted-referent fallback ("former member"); light ' +
        '+ dark.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The mockup + PNG + notes exist, composing the 5.1.3 section/tab grammar + ' +
        'shipped primitives + token tiers; render checklist + AA + dark parity pass.\n' +
        '- Panels cover: the live tab row + cross-tab sort toggle, EVERY per-change-type ' +
        'row form listed above (incl. fallback + deleted-referent + created/archived), ' +
        'the All interleave rhythm, and the Show-more/loading/empty states.\n' +
        '- `design-notes.md` names the row grammar primitives, the noise-suppression ' +
        'policy surface (what never renders), and the quieter-than-comments visual rule.\n' +
        '- No improvised primitive; token needs recorded for 5.5.4.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/comments.mock.html` + notes (5.1.3) — the section, tab ' +
        'seam, and comment grammar this composes with\n' +
        '- The verified Jira History anatomy + cross-tab sort rule in the Story 5.5 ' +
        'description\n' +
        '- `Pill`/`Avatar`/`IssueTypeIcon` + the rail `formatDate` conventions — the ' +
        'value-form vocabulary\n' +
        '- Findings #35/#54; the design-mockup render checklist',
    },
    {
      id: '5.5.4',
      title:
        'History + All tabs UI — activate the Activity section seam (feed rows, Show more, the cross-tab sort toggle)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['5.5.1', '5.5.2', '5.5.3', '5.1.5'],
      descriptionMd:
        'The UI: activate the History filter seam 5.1.5 ships disabled, and add the All ' +
        'merge — completing the Activity section.\n\n' +
        "**Build** (extending 5.1.5's `CommentsSection` into the full `ActivitySection`): " +
        'the live tab row (All / Comments / History, default Comments, counts); the ' +
        '**history feed rows** per the 5.5.3 grammar — every per-change-type form, the ' +
        'fallback row, deleted-referent forms, created/archived anchors; the **All** ' +
        'interleave rendering each entry in its native grammar; "Show more" per tab edge ' +
        'driving the respective cursor reads (scroll position preserved); the ONE sort ' +
        'toggle now governing all three tabs (the verified cross-tab rule — refetch all ' +
        'active sources on flip, persisted as 5.1.5 does); loading skeletons (the ' +
        'history-row variant) + empty states + `ErrorState`. Comments behaviour is ' +
        'UNCHANGED (5.1.5 owns it — this subtask must not regress its tests). Tab choice ' +
        'is URL-driven (`?activity=all|comments|history` — shareable, the house pattern). ' +
        'Strings via next-intl.\n\n' +
        "**A11y:** the filter row per the design's grammar (tabs/filters with proper " +
        'roles + keyboard), each feed a labelled list with entries readable as full ' +
        'sentences, the sweep extended over the populated History + All states.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The section matches `activity-history.mock.html` panel-for-panel: all three ' +
        'tabs live (URL-driven, default Comments), every change-type row form renders ' +
        'from seeded data (incl. fallback + former-member), All interleaves in true ' +
        'order, Show more pages each tab, the single toggle flips all tabs.\n' +
        '- The Comments tab is byte-identical to 5.1.5 (its tests untouched and green); ' +
        'no mutation affordance exists on history entries (read-only).\n' +
        '- Axe-clean over History + All populated states; token tiers only; next-intl ' +
        'strings.\n' +
        '- Component/integration tests over tab switching, paging, toggle propagation, ' +
        'and a render test per change-type row; coverage ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/activity-history.mock.html` + notes (5.5.3) — THE ' +
        'authority\n' +
        '- 5.1.5 (`CommentsSection` + the seam + the toggle to generalise); 5.5.1/5.5.2 ' +
        'reads\n' +
        '- The URL-driven view pattern (2.5.8 `?view=` precedent)\n' +
        '- The 2.4.6 detail a11y sweep (extend scope)',
    },
    {
      id: '5.5.5',
      title:
        'Story tests — Vitest (registry totality, merge properties) + Playwright E2E (history journey, All interleave, scale) + a11y sweep',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['5.5.4'],
      descriptionMd:
        'The story-closing verification (Principle #18; the 5.1.7/5.2.8/5.3.8/5.4.11 ' +
        'split — the epic-wide journey stays Story 5.6).\n\n' +
        '**Vitest (integration, real Postgres):** the registry totality guard (every ' +
        'recordRevision call-site key has a disposition — the test that fails when a ' +
        'future story adds an unregistered key); a render-mapping case per change type ' +
        '(incl. workflow-label resolution, sprint names, option labels, ' +
        'former-member/deleted-option fallbacks, the unknown-key fallback, suppression of ' +
        'pure rank/position diffs, mixed-diff partial rendering); the All-merge property ' +
        'tests (page-boundary interleaving, no loss/duplication, both orders); ' +
        'view-gating + 404.\n\n' +
        '**Playwright E2E (`tests/e2e/activity.spec.ts`):** as the PM — manufacture a ' +
        'history (edit fields, transition, link, label, set a custom field, attach, ' +
        'add+delete a comment, sprint-move) → the History tab reads as the designed ' +
        'sentences (spot-assert the status Pill pair, the link identifier, the ' +
        'comment-deletion entry with no content, the created anchor); the All tab ' +
        'interleaves the comment with the history around it; the sort toggle flips all ' +
        'tabs; board-drag the issue → no reorder noise appears. **At-scale fixture** ' +
        '(200+ revisions, 50 comments): first paint is one page + Show more on each ' +
        'tab; network shows bounded reads (the composite cursor on All). Run against ' +
        'the standing dev-server harness.\n\n' +
        '**Strict a11y sweep:** the populated History + All states pass the strict axe ' +
        'config (extending the 5.1.7 section sweep).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The Vitest suite covers the totality guard + every mapping/merge case named ' +
        'above; `pnpm test:coverage` keeps all 5.5 files ≥90% branch/fn/line.\n' +
        '- `activity.spec.ts` passes the full journey + the noise-policy assert + the ' +
        "scale walk, green in CI's Playwright lane.\n" +
        '- The strict axe sweep reports zero violations.\n' +
        '- The Story 5.5 verification recipe runs clean top to bottom; shared-DB flake ' +
        'isolation respected.\n\n' +
        '## Context refs\n\n' +
        '- `tests/integration/` + `tests/e2e/` conventions; the E2E harness/selector ' +
        'memories\n' +
        '- The 5.x story-test shape (the split vs Story 5.6)\n' +
        '- The Story 5.5 verification recipe — the checklist this automates\n' +
        '- The 5.5.1 totality-guard pattern (mistake #29)',
    },
  ],
};
