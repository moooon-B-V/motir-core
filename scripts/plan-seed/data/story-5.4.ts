import type { PlanStory } from '../types';

/**
 * Story 5.4 — Labels, components, watchers.
 *
 * Three issue-organisation features in one story (the stub's bundle): a
 * project-scoped **label** folksonomy (create-by-typing, multi-valued, no
 * admin UI), an admin-managed **component** taxonomy (name + description +
 * default assignee, multi-valued, Project settings page), and **watchers**
 * (watch/unwatch + the watchers popover + watcher email notifications via the
 * 1.6 jobs). All three persist as join rows indexed for Epic-6 filtering (the
 * stub's "all filterable in Epic 6" constraint — documented contract, like
 * 5.3.1's).
 *
 * 📦 Lives in Epic 5. Deps: 5.4 siblings + 5.1.2/5.1.6 (same epic, earlier
 * story — the comment auto-watch hook + the notification-job pattern) + done
 * Epic-1/2/6.4 work. Cross-epic audit (`notes.html` mistake #32) clean: no
 * forward-pointing dep.
 *
 * Mirror-product check (decision-ladder rung 1 — VERIFIED against Atlassian
 * sources at plan time, 2026-06-10):
 *   • **Labels are site-GLOBAL in Jira** — and that is a documented pain
 *     (open suggestion JRACLOUD-23656 asks for project scoping; the global
 *     pool leaks across projects). The stub pins **project-scoped** labels —
 *     a justified deviation WITH the concrete use case: the deviation is
 *     exactly what the mirror's users ask for, and Prodect's workspace/
 *     project tenancy makes scoping the natural shape. Folksonomy mechanics
 *     mirrored: created by typing in the field, NO admin UI (rename/merge is
 *     Jira's documented gap — out of scope, same as the mirror), unused
 *     labels disappear (delete-on-last-use), multi-valued, **no spaces**
 *     (hyphens — the Jira rule). One fix of a documented mirror wart:
 *     case-INSENSITIVE uniqueness per project ('Performance' vs 'performance'
 *     duplicates are a filed Jira complaint, JRACLOUD-24907) — first-typed
 *     casing is the display form. SECOND justified deviation (product owner,
 *     2026-06-10): label chips are COLOURED — less enterprise than Jira's
 *     colourless labels; tint auto-assigned by name hash (FNV-1a mod 6) into
 *     the existing --el-tint-* pastels, no colour column / picker / admin;
 *     user-picked colours = the documented extension.
 *   • **Components are company-managed-only in Jira** (team-managed gets
 *     Compass components, a different product seam) — so the mirror for shape
 *     is company-managed: name (required) + description + default assignee,
 *     managed at Project settings → Components by project admins,
 *     multi-valued per issue, and the verified **default-assignee rules**: an
 *     unassigned new issue takes the default assignee of its component,
 *     first-alphabetically on conflict. Simplification recorded: Jira's
 *     five-way default-assignee enum (project default / project lead /
 *     component lead / unassigned / person) collapses to `defaultAssigneeId:
 *     userId | null` — Prodect has no project-lead concept and component
 *     *lead* exists in Jira chiefly to feed that enum; the lead field is the
 *     documented extension. **Delete with issues = the verified move-or-
 *     remove choice** (issues untouched either way).
 *   • **Watchers** — the eye icon + count at the issue header's right,
 *     toggling self-watch, opening the watchers list; permissions map Jira's
 *     verified pair (View voters and watchers / **Manage watchers**) onto the
 *     6.4 roles: anyone who can view sees the list and watches THEMSELVES
 *     (watching is not editing — `viewer` may watch); project admin +
 *     workspace admin/owner add/remove OTHERS. **A watcher must be able to
 *     view the issue** — Jira silently drops violators (a documented trap);
 *     we reject with a typed error instead. Watchers are notified on the
 *     standard events; **the actor is never notified of their own change**
 *     (the Jira default). **Autowatch**: you auto-watch what you create or
 *     comment on (the verified personal-setting behaviour) — constant-on
 *     here; the per-user preference toggle is Story 5.7's seam. Watch/unwatch
 *     writes NO history entry (mirror: watching is not a field change).
 *
 * Notification scope (kept honest): watcher emails fire on **comment added**
 * and **status transition** — the two highest-signal events; Jira's full
 * notification-scheme event matrix is the documented extension (its exact
 * default recipient table isn't even doc-enumerated). The watcher job rides
 * the SAME channel-agnostic events as 5.1.6 (`work-item/comment.created`) plus
 * a new `work-item/transitioned` emitted by `updateStatus`, and **dedupes
 * against mention emails** (a watcher who was also @mentioned gets ONE email —
 * the mention one). Story 5.7 (in-app bell) fans in off the same events.
 *
 * ⚠️ Design gate (planning-time). Undesigned surfaces → TWO `type: design`
 * subtasks: **5.4.6** the issue-view additions (rail Labels + Components cards
 * + the multi-select chip picker — NO multi-select input primitive exists
 * (rung-2 fact: `Combobox` is single-select; the only multi-select vocabulary
 * is the filter bar's OptionRow) — plus the header Watch control + watchers
 * popover), and **5.4.7** the Components admin page. UI code subtasks (5.4.8/
 * 5.4.9/5.4.10) carry their design in `dependsOn` and seed `'blocked'`
 * (Principle #13).
 *
 * Expanded from its `stubs.ts` entry per `prodect plan 5.4`, on the standing
 * `seed/epic-5-plan` branch. Matches the canonical depth + string-literal
 * style of Stories 5.1 / 5.2 / 5.3.
 */
export const story_5_4: PlanStory = {
  id: '5.4',
  title: 'Labels, components, watchers',
  status: 'planned',
  descriptionMd:
    'The issue-organisation layer: **labels** (a project-scoped folksonomy — type to create, ' +
    'multi-valued, no admin ceremony), **components** (an admin-managed taxonomy with default ' +
    'assignees, the "which part of the product" axis), and **watchers** (follow an issue for ' +
    'notifications, distinct from assignee). All three persist as indexed join rows so **Epic 6 ' +
    "filters on them with real predicates** (the stub's constraint — the contract is documented " +
    'in the schema subtask, the 5.3.1 pattern).\n\n' +
    '**Labels (the Jira-verified folksonomy, project-scoped by deliberate deviation).** Jira ' +
    'labels are site-global — and project scoping is an OPEN JIRA SUGGESTION (JRACLOUD-23656): ' +
    "the global pool leaking across projects is the mirror's documented pain. The stub pins " +
    'project scope; recorded as the justified deviation users ask the mirror for. Mechanics ' +
    'mirrored exactly: labels are **created by typing** in the issue field (autocomplete over the ' +
    'project\'s existing labels + a "create" row), **multi-valued**, **no spaces** (hyphens — the ' +
    "Jira rule), and there is **NO admin UI** (rename/merge is Jira's documented gap; ours too — " +
    'the Epic-6 extension). A label exists only while used: removing its last use deletes the row ' +
    '(unused labels disappear, the verified behaviour). One wart-fix: **case-insensitive ' +
    "uniqueness** per project (the filed 'Performance'/'performance' duplicate complaint), " +
    'first-typed casing displayed. **Second justified deviation — label chips are COLOURED** ' +
    "(product owner, 2026-06-10): Jira's labels are colourless-enterprise; Prodect is " +
    'deliberately more colourful. The tint is **auto-assigned deterministically from the label ' +
    'name** (FNV-1a over `nameLower`, mod 6 — the seed-loader hash family) into the existing ' +
    '`--el-tint-{peach,rose,mint,lavender,sky,yellow}` pastels with `--el-text-strong` text ' +
    '(finding #35 AA) — NO colour column, NO picker, NO admin: the folksonomy stays ' +
    'type-to-create and the same label is the same colour on every surface (rail, picker, ' +
    'Epic-6 filters). User-picked colours = the documented extension.\n\n' +
    '**Components (company-managed Jira is the shape mirror).** Project-scoped, **admin-managed ' +
    'at Project settings → Components** (the 6.4 two-tier gate): `name` (required, ' +
    'case-insensitively unique), `description?`, `defaultAssigneeId?` — the verified Jira ' +
    'five-way default-assignee enum collapsed to a nullable user (no project-lead concept here; ' +
    'component lead = the documented extension). Issues carry **multiple components**. The ' +
    '**default-assignee rule** (verified): an issue CREATED with components and no assignee takes ' +
    'the default assignee of its **first-alphabetical** component that has one. **Deleting a ' +
    'component with issues forces the verified choice**: move those issues to another component, ' +
    'or just remove the association — issues untouched either way. Label/component changes write ' +
    'revision-trail diffs (the links-diff precedent: `{ labels: { added/removed } }`).\n\n' +
    "**Watchers (the verified contract).** The **eye + count** control at the detail header's " +
    'right toggles self-watch (keyboard `W` — the Jira shortcut) and opens the **watchers ' +
    'popover** (avatars + names; add/remove). Permission mapping: anyone who can VIEW the issue ' +
    'sees the list and watches **themselves** (watching is not editing — a `viewer` may watch); ' +
    'project admin + workspace admin/owner **manage others** (Jira\'s "Manage watchers"). A ' +
    'watcher MUST hold view access — Jira silently drops violators (a documented trap); we ' +
    'reject with a typed error. **Auto-watch**: creating or commenting on an issue watches it ' +
    '(the verified Jira personal-setting behaviour, constant-on; the opt-out preference is ' +
    "Story 5.7's). Watching writes no history (mirror). **Watcher emails** ride the 1.6 jobs on " +
    "the channel-agnostic events: `work-item/comment.created` (5.1.6's event) and a new " +
    '`work-item/transitioned` emitted post-commit by `updateStatus` (which today writes only the ' +
    'revision row — rung-2 fact). Scope: those two highest-signal events; the full ' +
    'notification-scheme matrix is the documented extension. **The actor is never self-notified**, ' +
    'and a watcher who was also @mentioned gets ONE email — the mention wins (cross-job dedupe: ' +
    "the watcher job skips the comment's mentioned users).\n\n" +
    '**Bounded everywhere (finding #57).** Label autocomplete is a bounded prefix read (take 20); ' +
    "the rail cards render this issue's rows (≤ caps); watcher fan-out pages through watchers; " +
    'components list is project-scoped admin data. Adopted caps as guards: 100 labels per issue ' +
    'is absurd — per-issue labels capped at 20 (Jira has no documented per-issue cap; a sanity ' +
    'guard, recorded), components per project uncapped but listed bounded, watchers paged.\n\n' +
    '**Completeness — the real-product states.** Labels: the create-row in the picker ("Create ' +
    "'perf-q3'\"), the no-spaces inline error, the empty rail placeholder. Components: empty " +
    'admin state, the in-use delete dialog (move-or-remove with a target picker + counts), ' +
    'default-assignee at-create visible in the revision trail. Watchers: count updates ' +
    'optimistically, the manage-others affordance only for admins, the typed no-view-access ' +
    'error surfaced inline, viewer read-only states everywhere. All drawn by 5.4.6/5.4.7, ' +
    'asserted in 5.4.11.\n\n' +
    '**Out of scope (documented extension slots, each justified):** label rename/merge admin ' +
    "(Jira's own gap; Epic-6 admin territory if a use case lands); component lead + the " +
    'five-way default-assignee enum (no project-lead concept; the nullable user covers the use ' +
    'case); voting (Jira\'s sibling feature — no use case for a small-team tool, "no complexity ' +
    'for nothing"); per-user notification preferences + the in-app bell (**Story 5.7**); ' +
    'watcher notifications on every field edit (the full scheme matrix — extension); ' +
    'user-PICKED label colours (the auto name-hash tint ships in this story — the recorded ' +
    'less-enterprise deviation; a `color` column + picker is the additive extension).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (applies the 5.4.1 ' +
    'label/component/watcher migration cleanly; re-run reports "No difference detected"), ' +
    '`pnpm db:seed`, `pnpm dev`.\n' +
    '- `pnpm test:coverage` — Vitest (real Postgres) over the three services (folksonomy ' +
    'lifecycle, component CRUD + default-assignee + move-or-remove, watcher permissions + ' +
    'auto-watch) ≥90% per-file branch/fn/line; empty-input guards on new repo methods.\n' +
    '- **Labels flow:** sign in as `zhuyue@prodect.co` / `!QAZ1qaz`, open an issue → the Labels ' +
    'rail card (matching `design/work-items/labels-components-watch.mock.html`). Type `perf-q3` ' +
    '→ the "Create" row adds it as a chip; type `PERF-Q3` on another issue → autocomplete offers ' +
    'the SAME label (case-insensitive, original casing shown); a label with a space is rejected ' +
    'inline; remove the chip from every issue → it stops appearing in autocomplete; the ' +
    'revision trail records added/removed.\n' +
    '- **Components flow:** Project settings → Components (matching ' +
    '`design/projects/components.mock.html`): create "API" (default assignee Bo) and "Web" (no ' +
    'default); assign both to an issue via the rail card; create a NEW issue with component API ' +
    'and no assignee → it lands assigned to Bo (first-alphabetical rule when multiple); delete ' +
    '"API" while in use → the dialog forces move-to-"Web" or remove, counts shown, issues ' +
    'survive. Non-admin member: the admin page is read-only.\n' +
    '- **Watchers flow:** the eye + count sits in the detail header; click (or press `W`) → you ' +
    'watch, count bumps; the popover lists watchers; as project admin add `odie@prodect.co` → ' +
    'listed; adding a user who cannot view a private-project issue is rejected with the inline ' +
    'error (not silently dropped); creating an issue auto-watches you; commenting auto-watches ' +
    'you; a `viewer` can watch themselves but sees no manage affordances.\n' +
    '- **Notifications:** with Bo watching, a comment by the PM → the dev email console shows ' +
    'the watcher email to Bo and NONE to the PM (actor) — and if Bo was also @mentioned, ONLY ' +
    'the mention email arrives (dedupe); a status transition fires the transition email to ' +
    'watchers, never the actor; replaying the Inngest event double-sends nothing (idempotent).\n' +
    '- **Epic-6 seam:** the documented join-predicate contract exists (label/component/watcher ' +
    'joins + indexes); a raw SQL spot-check filters issues by label and by component using the ' +
    'indexes.\n' +
    '- `pnpm test:e2e --grep labels-components-watch` — Playwright over the real stack: the ' +
    'three flows above end-to-end.\n' +
    '- **a11y check:** the chip picker (combobox-with-chips), the watchers popover, and the ' +
    'Components admin pass the strict axe sweep; `W` shortcut documented; state conveyed as ' +
    'text; colour via `--el-*`, shape via element tokens.',
  items: [
    {
      id: '5.4.1',
      title:
        'Schema — `label` + `work_item_label`, `component` + `work_item_component`, `watcher` (+ Epic-6 join-predicate contract, repos)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: [],
      descriptionMd:
        'The persistence for all three features. Schema + migration + repo skeletons only.\n\n' +
        '**`Label`** — `id`, `workspaceId`, `projectId`, `name` (display casing as first ' +
        'typed), `nameLower` (the case-insensitive uniqueness key: `@@unique([projectId, ' +
        'nameLower])` — the wart-fix decision), `createdAt`. **`WorkItemLabel`** — ' +
        '`workItemId` (Cascade) + `labelId` (Cascade), `@@unique([workItemId, labelId])`, ' +
        '`@@index([labelId])` (the Epic-6 by-label join). Labels are rows so the join is ' +
        'FK-clean, but they live ONLY while used (the service deletes a label row when its ' +
        'last join row goes — folksonomy semantics; no orphan-label GC needed by design).\n\n' +
        '**`Component`** — `id`, `workspaceId`, `projectId`, `name` + `nameLower` ' +
        '(`@@unique([projectId, nameLower])`), `description?`, `defaultAssigneeId?` (FK → ' +
        'User, **SetNull** — a departed user clears the default, never blocks), timestamps. ' +
        '**`WorkItemComponent`** — `workItemId` (Cascade) + `componentId` (**Restrict** — the ' +
        'service must run the move-or-remove flow before a component deletes; the DB ' +
        'backstops), `@@unique([workItemId, componentId])`, `@@index([componentId])`.\n\n' +
        '**`Watcher`** — `workItemId` (Cascade), `userId` (Cascade — a deleted user stops ' +
        'watching), `createdAt`, `@@unique([workItemId, userId])`, `@@index([userId])` (the ' +
        '"issues I watch" read 5.7/6.x will want). Every FK a two-sided `@relation` ' +
        '(CLAUDE.md). **The Epic-6 contract** documented (schema comment + note): ' +
        '`JOIN work_item_label/work_item_component ON …` predicate sketches over the ' +
        '`[labelId]`/`[componentId]` indexes.\n\n' +
        '**Repo skeletons** (single-op, writes require `tx`): label find-or-create reads ' +
        '(`findByNameLower`, `searchByPrefix(projectId, q, take)`), join add/remove, ' +
        '`countUsesByLabel`; component CRUD + `listByProject` + join add/remove + ' +
        '`countItemsByComponent` + `reassignItems(fromId, toId, tx)`; watcher ' +
        'add/remove/`listByWorkItem(paged)`/`existsFor`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The five models exist with the exact uniques/indexes/onDelete actions above ' +
        '(label joins Cascade; component join Restrict; defaultAssignee SetNull; watcher ' +
        'Cascade both sides); relations two-sided; `prisma migrate dev` re-run reports no ' +
        'drift.\n' +
        '- The Epic-6 join-predicate contract is documented beside the 5.3.1 one.\n' +
        '- Repo methods exist as single ops; Vitest verifies the uniques (case-insensitive ' +
        'label/component names), the Restrict backstop, the cascades, and empty-input guards ' +
        '(coverage gate).\n\n' +
        '## Context refs\n\n' +
        '- `prisma/schema.prisma` conventions + the 5.3.1 contract-comment pattern; ' +
        '`prodect-core/CLAUDE.md` (FK rule, required-`tx`)\n' +
        '- The verified mirror semantics in the Story 5.4 description (folksonomy ' +
        'delete-on-last-use; move-or-remove; watcher view-access)\n' +
        '- `lib/repositories/` conventions (workItemRepository paging shapes)',
    },
    {
      id: '5.4.2',
      title:
        '`labelsService` — type-to-create folksonomy (no-spaces, case-insensitive find-or-create, delete-on-last-use), bounded autocomplete, revision diffs',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 26,
      dependsOn: ['5.4.1'],
      descriptionMd:
        'The folksonomy mechanics, server-side. `lib/services/labelsService.ts` + typed ' +
        'errors + DTOs + HTTP-only routes.\n\n' +
        '**`setLabels(workItemId, names[], ctx)` / `addLabel` / `removeLabel`** — edit-gated ' +
        '(`admin`/`member` with view; `viewer` 403; cross-workspace 404 per finding #44). ' +
        'Validation per the verified Jira rules: **no spaces** (typed 422 naming the hyphen ' +
        'convention), trimmed, length-capped (a constant, e.g. 60 chars), per-issue cap 20 ' +
        '(the recorded sanity guard). **Find-or-create case-insensitively**: match on ' +
        '`nameLower` within the project; create with first-typed display casing on miss — in ' +
        'the SAME transaction as the join write. **Delete-on-last-use**: removing a label ' +
        'from an issue checks `countUsesByLabel` inside the tx and deletes the label row at ' +
        'zero (the FOR-UPDATE/lock discipline for the read-derived delete — the ' +
        'lock-before-read-derived-update rule). Revision diff per change: ' +
        '`{ labels: { added: [name], removed: [name] } }` (the links-diff precedent).\n\n' +
        '**`searchLabels(projectId, q, ctx)`** — the autocomplete read: case-insensitive ' +
        'prefix match, bounded `take: 20`, view-gated, returning display names. ' +
        "**`getLabelsForWorkItem`** rides the detail read (slotted into `getIssueDetail`'s " +
        'parallel fetch, the 5.3.3 pattern — one bounded query, no N+1).\n\n' +
        '## Acceptance criteria\n\n' +
        "- Add/remove/set round-trip with find-or-create (case-insensitive — 'PERF-Q3' " +
        "matches 'perf-q3', original casing returned), no-spaces + length + per-issue-cap " +
        '422s, and the delete-on-last-use rule (verified under concurrent removal — the ' +
        'locked count); revision diffs written per change.\n' +
        '- `searchLabels` is bounded (20), prefix, case-insensitive; `getIssueDetail` carries ' +
        "the issue's labels without an extra round-trip.\n" +
        '- Permission matrix enforced (member edits, viewer 403, cross-workspace 404); one ' +
        'service method = one transaction; routes HTTP-only; coverage gate ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- 5.4.1 repos; the verified folksonomy rules in the Story 5.4 description\n' +
        '- `lib/services/workItemsService.ts` `getIssueDetail` (the parallel-fetch slot) + ' +
        'the links revision-diff precedent (`{ links: { added/removed } }`)\n' +
        '- The lock-before-read-derived-update rule (the delete-at-zero count)\n' +
        '- 5.1.2 / 5.3.3 — the sibling service conventions',
    },
    {
      id: '5.4.3',
      title:
        '`componentsService` — admin CRUD + default-assignee-at-create (first-alphabetical) + move-or-remove delete + per-issue assignment, revision diffs',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['5.4.1'],
      descriptionMd:
        'The taxonomy half. `lib/services/componentsService.ts` + typed errors + DTOs + ' +
        'HTTP-only routes.\n\n' +
        '**Admin CRUD** (project-admin-gated, the 6.4 two-tier check): create/rename ' +
        '(case-insensitively unique per project), edit description, set/clear ' +
        '`defaultAssigneeId` (must be a member who can view the project — the ' +
        '`assignableMembersService` scoping; SetNull covers departure). **Delete = the ' +
        'verified move-or-remove flow**: the API takes `{ moveToComponentId?: string }` — ' +
        'with a target, `reassignItems` moves every join row (skipping duplicates where the ' +
        'issue already carries the target); without, joins are removed; either way issues ' +
        'are untouched and the response reports the affected count. The whole flow is ONE ' +
        'transaction (the Restrict FK backstops a missed path).\n\n' +
        '**Per-issue assignment** — `setComponents(workItemId, componentIds[], ctx)` / ' +
        'add/remove, edit-gated, validating same-project components; revision diffs ' +
        '`{ components: { added/removed: [name] } }`. Components ride `getIssueDetail` ' +
        '(bounded, the 5.3.3 slot pattern). **`listComponents(projectId)`** for the admin ' +
        'page + pickers (name order, with per-component item counts for the admin list + ' +
        'delete dialog).\n\n' +
        '**Default-assignee-at-create (the verified Jira rule):** in ' +
        '`workItemsService.createWorkItem`, when the input carries component ids and NO ' +
        'assignee, resolve the **first-alphabetical** component (by `nameLower`) having a ' +
        'non-null `defaultAssigneeId` and assign it — inside the existing create ' +
        'transaction, recorded in the create revision. No assignee mutation on later ' +
        'component changes (create-time only — the mirror rule).\n\n' +
        '## Acceptance criteria\n\n' +
        '- CRUD + uniqueness + default-assignee validation + the move-or-remove delete ' +
        '(both branches, counts reported, duplicate-join skip) round-trip, all ' +
        'project-admin-gated; per-issue set/add/remove edit-gated with same-project ' +
        'validation; viewer 403 / cross-workspace 404.\n' +
        '- A create with components + no assignee lands on the first-alphabetical default ' +
        '(verified with two defaulted components); a create WITH an assignee never ' +
        'overrides; later component edits never touch assignee.\n' +
        '- Revision diffs written for assignment changes; `getIssueDetail` carries ' +
        'components bounded; one method = one tx; routes HTTP-only; coverage ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- 5.4.1 repos (incl. `reassignItems`); the verified component rules in the Story ' +
        '5.4 description\n' +
        '- `workItemsService.createWorkItem` (the create-tx to extend) + ' +
        '`assignableMembersService` (6.4 scoping)\n' +
        '- The 6.4 admin-gate pattern (`settings/project/members/page.tsx`)\n' +
        '- The links revision-diff precedent',
    },
    {
      id: '5.4.4',
      title:
        '`watchersService` — self watch/unwatch + admin manage-others + view-access validation + auto-watch hooks (create, comment)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 26,
      dependsOn: ['5.4.1', '5.1.2'],
      descriptionMd:
        'The watch mechanics. `lib/services/watchersService.ts` + typed errors + DTOs + ' +
        'HTTP-only routes.\n\n' +
        '**`watch(workItemId, ctx)` / `unwatch`** — ANYONE who can view the issue watches ' +
        'themselves (a `viewer` included — watching is not editing; the verified permission ' +
        'split). Idempotent (re-watching is a no-op, the unique absorbs it). ' +
        '**`addWatcher(workItemId, userId, ctx)` / `removeWatcher`** — the "Manage ' +
        'watchers" half: project admin + workspace admin/owner only; the target MUST be a ' +
        'workspace member who can view the issue — **rejected with a typed 422** naming the ' +
        'reason (the mirror silently drops, a documented trap we fix). ' +
        '**`listWatchers(workItemId, { cursor }, ctx)`** — view-gated, paged, avatars/names ' +
        '+ a total count (the header eye count rides the detail read — slot a bounded ' +
        '`watcherCount` + `viewerIsWatching` into `getIssueDetail`). NO revision entries ' +
        '(mirror: watching is not a field change).\n\n' +
        '**Auto-watch hooks (the verified create-or-comment rule, constant-on):** ' +
        '`createWorkItem` adds the creator as watcher inside the create tx; ' +
        '`commentsService.addComment` (5.1.2) adds the commenter inside the comment tx ' +
        '(idempotent — the unique). The Story-5.7 preference toggle is the documented seam ' +
        '(a `userId`-keyed opt-out the hooks will consult; not built here).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Self watch/unwatch (incl. viewer), idempotent; manage-others admin-gated with ' +
        'the typed no-view-access rejection (private-project non-member target → 422, ' +
        'never silent drop); list paged + view-gated; cross-workspace 404.\n' +
        '- `getIssueDetail` carries `watcherCount` + `viewerIsWatching` without an extra ' +
        'round-trip; no revision rows from any watch path.\n' +
        '- Creating an issue auto-watches the creator; commenting auto-watches the ' +
        'commenter; both inside the owning tx, both idempotent.\n' +
        '- One method = one tx; routes HTTP-only; coverage ≥90% incl. the permission ' +
        'matrix.\n\n' +
        '## Context refs\n\n' +
        '- 5.4.1 watcher repo; the verified watcher contract in the Story 5.4 description ' +
        '(view-required, manage permission, autowatch)\n' +
        '- `workItemsService.createWorkItem` + `commentsService.addComment` (5.1.2) — the ' +
        'txs the hooks join\n' +
        '- `getIssueDetail` (the parallel-fetch slot); finding #44 (404-not-403)\n' +
        '- Story 5.7 stub — the preference seam these hooks will consult later',
    },
    {
      id: '5.4.5',
      title:
        'Watcher notification job — `work-item/transitioned` event + fan-out on comment/transition (actor excluded, mention-dedupe, idempotent)',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['5.4.4', '5.1.6'],
      descriptionMd:
        'The watcher email pipeline, on the 5.1.6 pattern.\n\n' +
        '**New event:** `work-item/transitioned` (workspaceId, workItemId, actorId, ' +
        'fromStatusKey, toStatusKey, revisionId) — emitted by `workItemsService.' +
        'updateStatus` AFTER its transaction commits (today it writes only the revision ' +
        'row — rung-2 fact; the event NEVER fires on rollback, the 5.1.2 rule). Typed in ' +
        '`JobEventDataMap`.\n\n' +
        '**Job** (`lib/jobs/definitions/watcherNotify.ts`, the 1.6 `defineJob` harness): ' +
        "consumes `work-item/comment.created` (5.1.6's event — the SAME emit, a second " +
        'consumer; no new emit path) and `work-item/transitioned`. Per event: page through ' +
        "the issue's watchers; **exclude the actor** (the verified never-self-notify " +
        "default); **exclude the comment's mentioned users** (they get the 5.1.6 mention " +
        'email — one email per person per event, the dedupe rule); re-validate view access ' +
        'at send time; render **`watcherCommentNotification`** / ' +
        '**`watcherTransitionNotification`** templates (pure, hand-written plain text, ' +
        'deep link — the emailTemplates contract; "<Author> commented on PROD-N" / ' +
        '"<Actor> moved PROD-N to <Status>") and send idempotently per (event × user) via ' +
        'the harness key. Failures → DLQ. Fan-out is PAGED (a 200-watcher issue never ' +
        'builds an unbounded batch).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `work-item/transitioned` is typed + emitted post-commit by `updateStatus` ' +
        '(rollback emits nothing); existing transition tests stay green.\n' +
        '- The job mails every watcher EXCEPT the actor and (for comments) the mentioned ' +
        'users; targets failing the send-time view check are skipped; both templates are ' +
        'pure with unredacted deep links.\n' +
        '- Replay/retry double-sends nothing (idempotency per event × user, ' +
        '`@inngest/test` coverage); failures land in the DLQ; fan-out pages.\n' +
        '- Coverage gate ≥90% on the job + templates + the emit seam.\n\n' +
        '## Context refs\n\n' +
        '- `lib/jobs/definitions/` + 5.1.6 (`mentionNotify` — the pattern + the shared ' +
        '`comment.created` event + the mention-recipient list to dedupe against)\n' +
        '- `workItemsService.updateStatus` (the post-commit emit point; its revision ' +
        'write at lines ~768)\n' +
        '- `lib/emailTemplates/` contract + `workspaceInvite.tsx` exemplar\n' +
        '- The verified notify rules (watchers on comment/transition; never the actor) in ' +
        'the Story 5.4 description; Story 5.7 (the in-app consumer of the same events)',
    },
    {
      id: '5.4.6',
      title:
        'Design — issue-view additions (`design/work-items/labels-components-watch.mock.html`: multi-select chip picker, rail cards, watch control + popover)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 45,
      dependsOn: [],
      descriptionMd:
        'The design asset for every issue-view surface this story adds. NONE exists: ' +
        '`detail.pen` predates all three features, and — rung-2 fact — the codebase has ' +
        '**no multi-select input primitive** (`Combobox` is single-select; the only ' +
        "multi-select vocabulary is the filter bar's OptionRow rows). Output: " +
        '**`design/work-items/labels-components-watch.mock.html`** + PNG + a design-notes ' +
        'section. Render checklist + AA + dark parity. Mirrors: the Jira issue-view Labels ' +
        '/ Components fields and the verified eye-icon watch control.\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **The multi-select chip picker** (the new `components/ui` primitive 5.4.8 ' +
        'builds — design it ONCE, generically: labels, components, and future Epic-6 ' +
        'facets all compose it): a FieldCard-embedded control showing value **chips** ' +
        '(label text · remove ×) + a type-to-filter input; the anchored listbox reuses ' +
        'the OptionRow vocabulary (option rows + trailing Check, ' +
        '`aria-multiselectable`); keyboard-complete (type/↑↓/Enter toggles, Backspace ' +
        'removes the last chip, Esc closes). Chips are `--radius-badge` — neutral by ' +
        'default (what Components uses), with an optional per-value tint.\n' +
        '- **Labels rail card** — the picker with the **create-row** ("Create ' +
        "'perf-q3'\" when no match, the folksonomy affordance), **coloured chips** (the " +
        'recorded less-enterprise deviation: tint auto-assigned by name hash into the ' +
        'six `--el-tint-*` pastels, `--el-text-strong` text per finding #35; option ' +
        'rows carry the tint swatch dot), the no-spaces inline ' +
        'error, the empty placeholder, the per-issue-cap state, and the read-only ' +
        '(viewer) chip-only rendering.\n' +
        '- **Components rail card** — the same picker WITHOUT a create-row (admin-managed ' +
        "taxonomy: options come from the project's components; an empty project shows " +
        '"No components defined" + a quiet admin-page link for admins), chips with the ' +
        'component glyph; read-only state.\n' +
        "- **Watch control** — the **eye + count** in the detail header's right group " +
        '(beside Edit — the shipped `ml-auto` cluster): watching vs not-watching states ' +
        '(filled vs outline + the count), hover/focus, the `W` shortcut hint (tooltip). ' +
        '**Watchers popover** anchored to it: the watcher list (Avatar · name, paged ' +
        '"Show more"), your own row marked, the admin-only **add-watcher** row (the ' +
        'member-picker vocabulary) + per-row remove for admins, the inline ' +
        'no-view-access error, and the viewer (no-manage) variant.\n' +
        '- **States** — loading skeletons for the two cards; the optimistic count bump; ' +
        'light + dark.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The mockup + PNG + notes exist, composed from shipped primitives + the token ' +
        'tiers; render checklist + AA + dark parity pass.\n' +
        '- Panels cover: the generic chip picker (closed/open/typing/keyboard states), ' +
        'labels card (create-row, no-spaces error, cap, empty, read-only), components ' +
        'card (no create-row, empty-project, read-only), the watch control (both states ' +
        '+ count) and the watchers popover (list, paged, admin add/remove, inline ' +
        'error, non-admin variant).\n' +
        "- `design-notes.md` names the primitive's generic API surface (5.4.8 + Epic-6 " +
        'reuse), the OptionRow vocabulary reuse, the label-colour decision (auto ' +
        'name-hash tint — the recorded deviation), and the ' +
        'header placement (the `ml-auto` cluster).\n' +
        '- No improvised primitive beyond the ONE designed here; token needs recorded.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/` notes + `detail.pen` (rail + header grammar); ' +
        '`CoreFieldsPanel` `FieldCard` + the header `ml-auto` cluster ' +
        '(`issues/[key]/page.tsx`)\n' +
        '- `IssueFilterBar` OptionRow (the multi-select vocabulary) + `Combobox` (the ' +
        'listbox a11y bar)\n' +
        '- The verified mirror behaviours (eye+count, folksonomy create) + the ' +
        'label-colour deviation in the Story 5.4 description\n' +
        '- Findings #35/#54; the design-mockup render checklist',
    },
    {
      id: '5.4.7',
      title:
        'Design — Components admin page (`design/projects/components.mock.html`: list + create/edit + default assignee + move-or-remove delete)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: [],
      descriptionMd:
        'The design asset for the settings surface (the design-gate NONE-exists case — ' +
        'the projects area covers Members+Access and, in-flight, Fields). Output: ' +
        '**`design/projects/components.mock.html`** + PNG + a design-notes section. ' +
        "Render checklist + AA + dark parity. Mirror: Jira's Project settings → " +
        'Components (company-managed — the verified shape source).\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **Entry** — the "Components" card on the settings hub (slotting after ' +
        'Estimation, before Members — the domain order) + the page shell (the 6.4.1 ' +
        'settings chrome).\n' +
        '- **Component list** — name-ordered rows: name, description (truncating), ' +
        'default assignee (Avatar + name or muted "None"), item count, row actions ' +
        '(edit, delete). Empty state ("No components yet" + Add component).\n' +
        '- **Add/edit** — name (required, case-insensitive-unique inline error), ' +
        'description, default assignee (the member picker with an explicit "None" row + ' +
        'the helper line explaining the at-create rule).\n' +
        '- **Delete dialog — the move-or-remove choice** (the verified Jira flow): when ' +
        'in use, the dialog shows the item count and forces a radio choice — "Move N ' +
        'work items to…" (a component picker excluding self) or "Remove the component ' +
        'from N work items" — issues untouched either way; unused components confirm ' +
        'simply. `--el-danger` confirm + ghost cancel (the house destructive grammar).\n' +
        '- **Read-only** — the non-admin state; loading skeleton; `ErrorState`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The mockup + PNG + notes exist, composed from shipped primitives + token ' +
        'tiers; render checklist + AA + dark parity pass.\n' +
        '- Panels cover: the hub card, the list (populated/empty), add/edit with the ' +
        'default-assignee picker + helper copy, the move-or-remove delete dialog (both ' +
        'branches + counts), and read-only/loading/error.\n' +
        '- `design-notes.md` names primitives + copy strings and records the ' +
        'simplification (nullable default assignee; lead = documented extension).\n' +
        '- No improvised primitive; token needs recorded.\n\n' +
        '## Context refs\n\n' +
        '- `design/projects/access-members.mock.html` + notes (6.4.1) and the in-flight ' +
        '5.3.4 fields page — the settings grammar to match\n' +
        '- `app/(authed)/settings/project/page.tsx` (the hub card list + slot)\n' +
        '- The verified Jira component rules in the Story 5.4 description\n' +
        '- Findings #35/#54; the design-mockup render checklist',
    },
    {
      id: '5.4.8',
      title:
        '`MultiSelectPicker` primitive + Labels & Components rail cards (chips, create-row, caps; the Epic-6-reusable control)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: ['5.4.2', '5.4.3', '5.4.6'],
      descriptionMd:
        'The issue-view assignment UI. Two pieces, per the 5.4.6 design:\n\n' +
        '**`components/ui/MultiSelectPicker`** — the generic chip-input primitive the ' +
        'design specifies (value chips + remove ×, type-to-filter input, anchored ' +
        '`aria-multiselectable` listbox on the OptionRow vocabulary, full keyboard model ' +
        'incl. Backspace-removes-last, optional **create-row** via an `onCreate` prop, ' +
        'optional per-value cap, optional per-value **tint** — chip colour + the option-row ' +
        'swatch dot). PURE + typed-generic (options in, selection out — no ' +
        'fetching), component-tested in isolation, documented for Epic-6 facet reuse. ' +
        'This is the ONE new primitive the story earns (rung-2: nothing multi-select ' +
        'exists; designed in 5.4.6 — not improvised).\n\n' +
        '**Rail cards** (in `CoreFieldsPanel`/siblings, the FieldCard grammar): ' +
        '**Labels** — the picker with `onCreate` wired to the folksonomy (typed ' +
        'no-spaces/cap errors inline), options from the bounded `searchLabels` ' +
        'autocomplete (debounced), chips from the detail read, **tinted by the ' +
        'deterministic name-hash** (FNV-1a over `nameLower` mod 6 → the six `--el-tint-*` ' +
        'pastels, `--el-text-strong` text — the Story 5.4 label-colour deviation; the ' +
        'pure helper lives beside the picker for Epic-6 reuse); **Components** — the ' +
        'picker without create (options = `listComponents`, the empty-project state with ' +
        'the admin link). Both persist via server actions → the 5.4.2/5.4.3 services → ' +
        '`router.refresh()` (the rail pattern); viewer renders read-only chips. Strings ' +
        'via next-intl.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `MultiSelectPicker` matches the 5.4.6 design (every keyboard/visual state), ' +
        'is axe-clean standalone, pure, and component-tested (toggle/create/cap/' +
        'Backspace paths); no fetching inside.\n' +
        '- The Labels card round-trips create/add/remove with the inline 422s; ' +
        'autocomplete is debounced + bounded; case-insensitive match surfaces the ' +
        'existing casing; the same label renders the same hash tint everywhere ' +
        '(deterministic — unit-tested).\n' +
        '- The Components card assigns/unassigns from the project taxonomy; ' +
        'empty-project + read-only states match the design.\n' +
        '- Token tiers only; the detail-route axe sweep stays clean; integration tests ' +
        'over both cards; coverage ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/labels-components-watch.mock.html` + notes (5.4.6) — THE ' +
        'authority\n' +
        '- 5.4.2/5.4.3 services + routes; `CoreFieldsPanel` `FieldCard` + the rail ' +
        'action pattern\n' +
        '- `IssueFilterBar` OptionRow + `Combobox` internals (the listbox/a11y ' +
        'vocabulary to reuse)\n' +
        '- The i18n threading pattern (en byte-identical)',
    },
    {
      id: '5.4.9',
      title:
        'Watch control + watchers popover in the detail header (eye + count, `W` shortcut, admin manage-others)',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['5.4.4', '5.4.6'],
      descriptionMd:
        'The watch surface, per the 5.4.6 design: a `WatchControl` in the detail ' +
        "header's `ml-auto` cluster (beside Edit — the shipped slot).\n\n" +
        '**Build:** the eye + count button (watching = filled + accent per the design; ' +
        'not = outline), toggling self-watch with an optimistic count bump (reconciled ' +
        'on refresh); the **`W` keyboard shortcut** (ignored while typing in ' +
        'inputs/editors — the standard guard); the **watchers popover** (paged list of ' +
        'Avatar · name rows, your row marked, "Show more"); the **admin-only manage ' +
        'rows** — add-watcher via the member-picker vocabulary with the inline ' +
        'no-view-access 422, per-row remove; non-admins see the list only. Data from ' +
        'the detail read (`watcherCount`/`viewerIsWatching`) + the paged list route on ' +
        'open; mutations via server actions → `watchersService`. A `viewer` can toggle ' +
        'their own watch (the verified rule).\n\n' +
        '**A11y:** the button carries an `aria-pressed`/label with the count ("Watch — ' +
        '3 watching"); the popover is a labelled dialog/listbox per the design; the ' +
        'shortcut is documented in the tooltip; state conveyed as text + icon, never ' +
        'colour alone.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The control matches the design (both states + count), toggles ' +
        'optimistically incl. for a viewer, and `W` toggles outside text inputs.\n' +
        '- The popover lists watchers paged; project admin adds/removes others (the ' +
        'no-view-access rejection surfaces inline); non-admins get no manage ' +
        'affordances.\n' +
        '- Auto-watch effects surface correctly (create/comment then revisit → ' +
        'watching state on).\n' +
        '- Axe-clean (header + open popover); token tiers only; integration tests ' +
        'over toggle/manage/shortcut; coverage ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/labels-components-watch.mock.html` + notes (5.4.6)\n' +
        '- `issues/[key]/page.tsx` header (`ml-auto` cluster — the placement, rung-2) ' +
        '+ 5.4.4 service/routes\n' +
        '- The shipped popover/member-picker vocabularies (Combobox, the 2.4.9 ' +
        'confirm grammar)\n' +
        '- The verified watcher UX (eye+count, W shortcut) in the Story 5.4 ' +
        'description',
    },
    {
      id: '5.4.10',
      title:
        'Components admin UI — Project settings → Components (list, create/edit w/ default assignee, move-or-remove delete)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 32,
      dependsOn: ['5.4.3', '5.4.7'],
      descriptionMd:
        'The settings surface: `app/(authed)/settings/project/components/page.tsx` + ' +
        'the hub card (after Estimation), per the 5.4.7 design, on the 5.4.3 routes — ' +
        'the 6.4 members page (and the in-flight 5.3.6 fields page) as the structural ' +
        'template.\n\n' +
        '**Build:** the name-ordered list (description, default assignee w/ Avatar, ' +
        'item count, actions); add/edit (name uniqueness inline error, description, ' +
        'the member picker with the explicit "None" row + the at-create helper copy); ' +
        'the **move-or-remove delete dialog** (radio choice + target picker excluding ' +
        'self + counts, both branches wired); empty / loading / error; the non-admin ' +
        'read-only state. Server actions → `componentsService` → `router.refresh()`; ' +
        'strings under `settings.components` (next-intl).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The page matches `components.mock.html` panel-for-panel (list, add/edit ' +
        'incl. default-assignee picker, the move-or-remove dialog with live counts + ' +
        'both branches, empty/read-only states).\n' +
        '- All mutations round-trip honouring the admin gate; a non-admin member sees ' +
        "read-only; the delete dialog's move branch actually reassigns (verified " +
        'against an in-use component) and the remove branch detaches.\n' +
        '- Axe-clean; token tiers only; next-intl strings; integration tests over the ' +
        'action wiring + gate; coverage ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- `design/projects/components.mock.html` + notes (5.4.7) — THE authority\n' +
        '- 5.4.3 routes/actions; `settings/project/members/page.tsx` (6.4) + the hub ' +
        'card list\n' +
        '- The i18n threading pattern; the 2.4.9 destructive-dialog grammar',
    },
    {
      id: '5.4.11',
      title:
        'Story tests — Vitest matrix (folksonomy × components × watchers × notifications) + Playwright E2E + a11y sweep',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 32,
      dependsOn: ['5.4.5', '5.4.8', '5.4.9', '5.4.10'],
      descriptionMd:
        'The story-closing verification (Principle #18; the 5.1.7/5.2.8/5.3.8 split — ' +
        'epic-wide journeys stay Story 5.6).\n\n' +
        '**Vitest (integration, real Postgres):** labels — find-or-create casing, ' +
        'no-spaces/caps, delete-on-last-use under concurrent removal, autocomplete ' +
        'bounds; components — CRUD uniqueness, default-assignee-at-create incl. the ' +
        'first-alphabetical conflict + no-override, both delete branches incl. ' +
        'duplicate-join skip; watchers — the permission matrix (self vs manage-others ' +
        'vs viewer), the typed no-view rejection, auto-watch on create/comment ' +
        'idempotency; notifications — actor exclusion, mention-dedupe (a watcher who ' +
        'was mentioned gets ONE email), send-time view re-check, replay idempotency, ' +
        'transitioned-event emit-on-commit-only.\n\n' +
        '**Playwright E2E (`tests/e2e/labels-components-watch.spec.ts`):** as the PM — ' +
        'type-create `perf-q3` on an issue (chip appears; spaced label rejected ' +
        'inline); the same label autocompletes case-insensitively on another issue; ' +
        'admin-create components, assign two to an issue, create a fresh issue with a ' +
        'defaulted component and no assignee → auto-assigned; delete an in-use ' +
        'component via the MOVE branch → the issue carries the target; watch via the ' +
        'eye and via `W`; the popover lists watchers; admin adds Odie; the dev email ' +
        'console shows the watcher email on a comment by another user, none to the ' +
        'actor. **Role pass:** viewer — read-only chips, CAN watch, no manage rows; ' +
        'non-admin member — read-only Components settings. Run against the standing ' +
        'dev-server harness.\n\n' +
        '**Strict a11y sweep:** the detail route (chip pickers open + watchers ' +
        'popover open) and the Components settings page pass the strict axe config.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The Vitest matrix covers every cell above; `pnpm test:coverage` keeps all ' +
        '5.4 files ≥90% branch/fn/line.\n' +
        "- The E2E journey + both role passes run green in CI's Playwright lane " +
        '(Combobox-name selector gotchas respected).\n' +
        '- The strict axe sweep over both surfaces reports zero violations.\n' +
        '- The Story 5.4 verification recipe runs clean top to bottom; shared-DB ' +
        'flake isolation respected.\n\n' +
        '## Context refs\n\n' +
        '- `tests/integration/` + `tests/e2e/` conventions; the E2E ' +
        'selector/harness memories\n' +
        '- The 5.1.7/5.2.8/5.3.8 story-test shape\n' +
        '- The Story 5.4 verification recipe — the checklist this automates\n' +
        '- `@inngest/test` (the notification matrix) + the dev email console ' +
        '`[EMAIL]` grep contract',
    },
  ],
};
