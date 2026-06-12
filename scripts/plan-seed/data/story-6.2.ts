import type { PlanStory } from '../types';

/**
 * Story 6.2 — Saved filters.
 *
 * Persistence for the 6.1 filter substrate: a **named, owned, shareable
 * `saved_filter` entity** storing the SAME versioned FilterAST envelope the
 * `?filter=v1:` URL codec carries (one codec, two carriers — the URL and the
 * row), applied from a **filter dropdown** on `/issues`, managed in a
 * **filters directory**, starred per-user, emailed on a schedule
 * (**subscriptions**), and exposed through a **documented data-source
 * contract** that Story 6.3 dashboards/reports consume.
 *
 * Mirror-product check (decision-ladder rung 1 — VERIFIED against Atlassian
 * Cloud docs at plan time, 2026-06-10):
 *   • **Save / Save as.** Jira saves a search via "Save as" (name); the
 *     OWNER of an applied filter with modified criteria gets **Save**
 *     (overwrite) + **Save as**; a NON-owner gets **Save as only** (docs:
 *     manage-filters + edit-a-board-filter). Owners edit name, description,
 *     permissions, and criteria.
 *   • **Sharing.** Cloud filters carry separate **Viewers and Editors**
 *     grant lists over scopes private / user / group / project(+role) /
 *     any-logged-in / public; sharing at all is gated by a global
 *     permission, public by a site toggle; a private filter is visible to
 *     the owner + Jira admins, and admins can change owner / delete any
 *     shared filter.
 *   • **Directory + starring.** A searchable Filters directory (name /
 *     owner / viewers-editors / popularity = star count / actions);
 *     starring puts a filter at the top of the nav Filters menu.
 *   • **Subscriptions.** Alive in Cloud: per-filter email subscriptions on
 *     preset schedules or advanced cron; "only the first 200 results of a
 *     filter are sent."
 *   • **System filters.** Nine built-ins (My open work items, Reported by
 *     me, All / Open / Done work items, Viewed / Created / Resolved /
 *     Updated recently) — "cannot be deleted or edited."
 *   • **Deletion in use.** Cloud WARNS when deleting a filter a board uses
 *     (JSWCLOUD-6706); Data Center hard-blocks while boards/subscriptions
 *     exist; a dashboard gadget whose filter was deleted just breaks with
 *     "filter could not be retrieved."
 *   • **Scope.** Jira filters are user-owned, SITE-GLOBAL objects (not
 *     project-contained); the project tension is handled by the project
 *     share scope + JQL criteria. Boards are built ON a filter only in the
 *     company-managed family; team-managed boards are not filter-based.
 *
 * Recorded deviations (justified-deviation rule — each earns its line):
 *   • **Project-contained, not site-global.** The AST's referents
 *     (statuses, custom fields, labels, components, sprints) and the entire
 *     shipped search substrate are project-scoped (rung 2; the 6.1 recorded
 *     deviation). Cross-project filters = the same documented extension
 *     slot as 6.1's workspace-wide search.
 *   • **Two visibilities (private / project), owner+admin editing.** Jira's
 *     six share scopes + per-filter Viewers/Editors lists presuppose
 *     site-global filters and groups, which Motir doesn't have; project
 *     containment + the shipped 6.4 roles already draw the boundary. The
 *     per-filter editor-grant list is the documented extension.
 *   • **Boards stay status-mapped, not filter-sourced.** Motir mirrors
 *     the team-managed family (the 3.1/3.6 tested decision; 6.4 made the
 *     same family choice) — so "filters as board sources" is the
 *     company-managed shape we deviate from (documented extension); the
 *     stub's "data sources for boards, dashboards, and reports" resolves to
 *     the 6.3 dashboards/reports contract, which IS planned here.
 *   • **Preset schedules, not cron.** Subscriptions ship Jira's preset tier
 *     (daily / weekdays / weekly at an hour); the advanced-cron editor is a
 *     power-user surface with no stated use case yet (extension).
 *   • **System filters: the expressible subset.** Built-ins compile to
 *     FilterAST over shipped fields; "Viewed recently" needs a view-history
 *     substrate Motir doesn't carry (extension), so it's omitted.
 *
 * ⚠️ Design gate (planning-time). `filter-builder.mock.html` (6.1.3)
 * designs ONLY the builder — every 6.2 surface (save affordance + dirty
 * state, the dropdown, the directory, visibility control, delete-in-use
 * warning, subscription editor) is undesigned → subtask **6.2.2** is the
 * `type: design` subtask; every UI code subtask carries it in `dependsOn`
 * and seeds `'blocked'` (Principle #13).
 *
 * Expanded from its `stubs.ts` entry per `motir plan 6.2`, on the standing
 * `seed/epic-5-plan` branch (Epic-5/6 planning). Matches the canonical style
 * of 5.1–5.6 / 6.1.
 */
export const story_6_2: PlanStory = {
  id: '6.2',
  title: 'Saved filters',
  status: 'planned',
  descriptionMd:
    "Persist the 6.1 filter builder's state as **named saved filters**: a project-scoped " +
    '`saved_filter` entity owned by its creator, carrying the SAME versioned FilterAST envelope ' +
    'the `?filter=v1:` URL codec serializes (one codec, two carriers — a saved filter is the URL ' +
    'param given a name, an owner, and permissions). Applied from a **filter dropdown** beside ' +
    'the builder on `/issues` (starred first, then mine / project-shared / built-in defaults, ' +
    'searchable), managed in a **filters directory**, starred per-user, optionally **emailed on ' +
    'a schedule** (subscriptions), and exposed to Story 6.3 dashboards/reports through a ' +
    '**documented data-source contract**.\n\n' +
    '**Where it sits relative to the mirror (verified, deviations recorded).** Jira Cloud: save ' +
    'a search as a filter; the owner of a modified filter gets **Save + Save as**, a non-owner ' +
    '**Save as only** — we mirror that dirty-state rule exactly. Jira filters are user-owned ' +
    'SITE-GLOBAL objects with six share scopes and separate Viewers/Editors grant lists; ours ' +
    "are **project-contained** (the AST's referents — statuses, custom fields, labels, " +
    'components, sprints — are project data, and the whole shipped search substrate is ' +
    'project-scoped; the 6.1 recorded deviation) with **two visibilities** — `private` (owner + ' +
    'project/workspace admins) and `project` (everyone who can browse the project, riding the ' +
    '6.4 gate) — and editing by owner + project admin (the per-filter editor-grant list and ' +
    'cross-project filters are documented extensions). Sharing (visibility `project`) requires ' +
    "role ≥ member — a viewer is a read-only persona and publishing into the project's shared " +
    'namespace is a write; viewers still create/star PRIVATE filters freely (filters are a ' +
    'read-layer construct). Project admins (+ workspace owner/admin) can edit, delete, and ' +
    'change the owner of any project-shared filter — the Jira-admin powers, project-sized.\n\n' +
    "**Built-in defaults (the system filters).** The expressible subset of Jira's nine, as " +
    'non-persisted AST constants (NOT rows): My open issues, Reported by me, All issues, Open ' +
    'issues, Done issues, Created / Updated / Resolved recently. Non-editable, non-deletable ' +
    '(the mirror rule); applying one loads its rows into the builder like any saved filter ' +
    '("Viewed recently" omitted — no view-history substrate; extension).\n\n' +
    '**Durability (the load-bearing piece).** The stored payload is the versioned envelope the ' +
    '6.1.1 codec defines — decode + registry-validate on EVERY resolve, never trust-and-compile: ' +
    'a stale referent inside a saved AST (deleted option / label / field) degrades to the 6.1.2 ' +
    'unknown-value condition (matches nothing + per-row notice — the rule 6.1 recorded for ' +
    'exactly this story); a malformed or future-versioned envelope yields the typed recoverable ' +
    'state, never a crash. Name uniqueness is per-project case-insensitive (our call, not ' +
    'mirror-verified — two "Sprint blockers" in one shared dropdown is ambiguity nobody wants).\n\n' +
    '**Subscriptions.** Per-user, per-filter email on a preset schedule (daily / weekdays / ' +
    "weekly at an hour — Jira's preset tier; advanced cron is the extension), running on the " +
    'Story 1.6 jobs substrate (the `dailyHealthCheck` cron precedent) and the ' +
    '`lib/emailTemplates/` layer: first 50 results (our page unit; Jira caps at 200) + total ' +
    'count + a deep link to the applied filter. Deleting a filter deletes its subscriptions — ' +
    'after a Cloud-style **warning that names the dependents** (subscription count now; 6.3 ' +
    'widget usages once they exist).\n\n' +
    '**The 6.3 data-source contract (what "reuse for dashboards and reports" means).** A ' +
    'documented service read — resolve a saved filter id to its compiled WHERE fragment + ' +
    'metadata (name, owner, visibility) — plus the usage seam: consumers reference filters by ' +
    'FK, the delete warning enumerates them, and a widget whose filter was deleted renders a ' +
    'designed "filter missing" state (the verified Cloud gadget behaviour), never a crash. ' +
    '**Boards stay status-mapped** — Motir mirrors the team-managed family (3.1/3.6 tested ' +
    'decision, the same family 6.4 chose), so filter-sourced boards (a company-managed shape) ' +
    'are the documented extension; the stub\'s "boards" consumer resolves to this contract.\n\n' +
    '**Bounded + complete (finding #57).** Directory and dropdown reads are paginated/bounded ' +
    'and searchable server-side (a project with 500 filters must not ship them all to a ' +
    'dropdown); star counts aggregate in the query, not in JS over all rows; empty / loading / ' +
    'error / no-access states designed + asserted; every list keyed for the project so one ' +
    "team's filters never leak into another's.\n\n" +
    '**Out of scope (documented extension slots, each justified):** cross-project / ' +
    'workspace-global filters (follows the 6.1 scope deviation); per-filter Viewers/Editors ' +
    'grant lists + group scopes (no groups in Motir; 6.4 roles draw the boundary); ' +
    'filter-sourced boards (company-managed shape; ours are team-managed-style status boards); ' +
    'advanced cron subscriptions; "Viewed recently" (no view-history substrate); public/' +
    'anonymous sharing (no anonymous surface exists — rung 2).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (the `saved_filter` / ' +
    'star / subscription migrations apply cleanly; re-run reports "No difference detected"), ' +
    '`pnpm db:seed`, `pnpm dev`.\n' +
    '- `pnpm test:coverage` — Vitest (real Postgres) over the service/permission matrix, the ' +
    'persist→resolve round-trip, and the subscription scheduler ≥90% per-file branch/fn/line.\n' +
    '- **Save flow:** sign in as `zhuyue@motir.co` / `!QAZ1qaz` → /issues → build a filter ' +
    '(Status is any of (To do) AND Priority is none of (Lowest)) → **Save as** → name it ' +
    '"Sprint blockers", visibility **Project** → the toolbar shows the applied filter\'s name; ' +
    'edit a row → the dirty state appears with **Save** + **Save as** (you own it); a second ' +
    'account (`bophilips@motir.co`) applying the same filter and editing a row sees **Save ' +
    "as only** (the mirror's non-owner rule).\n" +
    '- **Apply + star:** the dropdown lists starred first, then My filters / Project filters / ' +
    'Defaults; starring "Sprint blockers" floats it to the top; applying any entry loads its ' +
    'rows into the builder and writes the `?filter=v1:` URL (shareable; reload-safe); the ' +
    'built-in defaults (My open issues, Reported by me, …) apply but expose no edit/delete.\n' +
    '- **Visibility + permissions:** a private filter is invisible to `bophilips@motir.co` ' +
    '(dropdown + directory + direct id); flipping it to Project makes it appear; a project ' +
    '**viewer** can create/star private filters but gets no Project-visibility option; a ' +
    "project **admin** can rename/delete/change-owner on a member's shared filter.\n" +
    '- **Directory:** the filters page lists name / owner / visibility / stars / actions, ' +
    'server-searched and paginated; rename + visibility change + delete work per the matrix; ' +
    'empty and no-access states render designed.\n' +
    '- **Stale referent:** save a filter on a label, delete the label, re-apply the saved ' +
    'filter → the condition row shows the unknown-value notice and matches nothing (no crash); ' +
    'a hand-corrupted stored envelope yields the typed recoverable state.\n' +
    '- **Subscription:** subscribe daily-at-09:00 to "Sprint blockers" → trigger the job (dev ' +
    'Inngest) → the email renders ≤50 results + total count + a deep link that opens the ' +
    'applied filter; deleting the filter first warns "1 subscription will be removed", then ' +
    'cascades.\n' +
    '- `pnpm test:e2e --grep saved-filters` — Playwright over the real stack: save → dirty → ' +
    'save-as → share → second-user apply/star → delete-with-warning journey.\n' +
    '- **a11y check:** dropdown, directory, share control, and dialogs pass the strict axe ' +
    'sweep; fully keyboard-operable; colour via `--el-*`, shape via element tokens.',
  items: [
    {
      id: '6.2.1',
      title:
        'Schema + service + API — `saved_filter` (versioned AST envelope, visibility, stars) + permission matrix + built-in defaults + the 6.3 data-source contract',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 34,
      dependsOn: ['6.1.1', '6.4'],
      descriptionMd:
        'The persistence + permission layer. Pure backend — no UI.\n\n' +
        '**Schema (one migration, FKs as Prisma `@relation`s):** `saved_filter` — project FK, ' +
        'owner FK, `name` (unique per project, case-insensitive — cite the story decision), ' +
        '`description?`, `visibility` enum `{ private, project }`, and the **versioned AST ' +
        'envelope** (JSONB carrying exactly what the 6.1.1 codec encodes, version field ' +
        'included); `saved_filter_star` — (filter, user) unique pair. Timestamps throughout.\n\n' +
        '**Service + repos (4-layer):** CRUD with the permission matrix — create/star: any ' +
        'project member incl. viewer (private only for viewers); visibility `project` requires ' +
        'role ≥ member; update/delete/change-owner: owner OR project admin (workspace ' +
        'owner/admin always); every read filtered by the 6.4 browse gate + visibility. ' +
        '**Resolve** (THE data-source contract, documented for 6.3 in the service JSDoc): ' +
        'id → decode + registry-validate the stored envelope via 6.1.1 (NEVER trust-and-' +
        'compile) → the compiled WHERE fragment + metadata DTO; stale referents degrade per ' +
        'the 6.1.2 unknown-value rule; malformed/future-versioned envelopes → the typed ' +
        'recoverable error. **List reads** bounded + server-searched + paginated (mine / ' +
        'project / starred views; star counts aggregated in SQL — finding #57). **Built-in ' +
        'defaults:** the system filters as non-persisted AST constants (My open issues, ' +
        'Reported by me, All/Open/Done issues, Created/Updated/Resolved recently) exposed ' +
        'through the same list/resolve reads with `builtin: true` (no write paths). **Delete ' +
        'dependents:** the delete read enumerates dependents (subscriptions now; 6.3 widgets ' +
        'join in by FK later) so the UI can render the Cloud-style warning; deletion cascades ' +
        'subscriptions in the same transaction.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Migration applies cleanly (re-run: no drift); both FKs modelled as `@relation`s; ' +
        'the name-uniqueness constraint is case-insensitive per project.\n' +
        '- The permission matrix holds for every (role × visibility × action) cell — ' +
        "matrix-tested, incl. the viewer private-only rule and admin powers over others' " +
        "shared filters; private filters never appear in another user's reads (asserted at " +
        'the service AND route layer).\n' +
        '- Persist→resolve round-trips every constructible AST (property test reusing the ' +
        '6.1.1 generators); stale-referent and malformed-envelope paths yield the typed ' +
        'degraded states; built-in defaults resolve and reject writes.\n' +
        '- List reads are paginated + server-searched; an EXPLAIN spot-check shows no ' +
        'full-table star aggregation; `pnpm test:coverage` ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- 6.1.1 `lib/filters/ast.ts` (the envelope + codec — the single source of the ' +
        'stored shape) + the 6.1.2 stale-referent rule\n' +
        '- Story 6.4 roles/gates (`ProjectMembership`, access levels) — the permission ' +
        'substrate; `motir-core/CLAUDE.md` (4-layer, required-`tx`, FK `@relation` rule)\n' +
        '- The verified Jira facts in the Story 6.2 description (Save/Save-as ownership, ' +
        'admin powers, system-filter immutability)\n' +
        '- finding #57 (bounded reads)',
    },
    {
      id: '6.2.2',
      title:
        'Design — saved-filter surfaces (`design/work-items/saved-filters.mock.html`: save + dirty state, dropdown, directory, visibility, delete warning, subscription editor)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 40,
      dependsOn: ['6.1.3'],
      descriptionMd:
        'The design asset for every 6.2 surface. `filter-builder.mock.html` (6.1.3) designs ' +
        'ONLY the builder — saving/managing/sharing is undesigned (the design-gate NONE-exists ' +
        'case). Output: **`design/work-items/saved-filters.mock.html`** + PNG + a "Saved ' +
        'filters (Story 6.2)" section in `design/work-items/design-notes.md`. Render checklist ' +
        "+ AA + dark parity. Mirrors: Jira's Save/Save-as split, its Filters directory " +
        'columns, its starred-first menu.\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **Save affordance + dirty state** — where Save / Save as sit relative to the 6.1.3 ' +
        'builder panel; the applied-filter **name chip** in the toolbar; the dirty indicator ' +
        'on modification; the owner (Save + Save as) vs non-owner (Save as only) split; the ' +
        'save dialog (name, optional description, visibility control) incl. the ' +
        "duplicate-name error and the viewer's private-only state.\n" +
        '- **The filter dropdown** — entry beside the builder affordance: starred first, then ' +
        'My filters / Project filters / Defaults groups, server-backed search, per-row star ' +
        'toggle + owner/visibility hints, the "View all filters" footer to the directory; ' +
        'empty states per group.\n' +
        '- **The filters directory** — the project-level page (placement off the /issues ' +
        'surface; name the route in the notes): columns name / owner / visibility / stars / ' +
        'actions; search + pagination; row actions by permission (rename, edit details, ' +
        'visibility, change owner [admin], delete); built-in defaults listed read-only; ' +
        'empty + no-access states.\n' +
        '- **Visibility control + delete warning** — the private/project control (with the ' +
        'one-line explanation of each, the 6.4.1 grammar); the delete confirm naming ' +
        'dependents ("1 subscription will be removed"; the 6.3 widget line reserved).\n' +
        '- **Subscription editor** — per-filter subscribe: preset schedule (daily / weekdays ' +
        '/ weekly + hour), the subscribed state, unsubscribe; where it mounts (dropdown row ' +
        'action + directory row action).\n' +
        '- **The "filter missing" widget state** — the designed degraded card 6.3 renders ' +
        'when a referenced filter is gone (the verified Cloud gadget behaviour) — drawn here ' +
        'so 6.3 inherits it.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The mockup + PNG + notes exist, composed from shipped primitives (`Combobox`, ' +
        '`Modal`, `Pill`, `EmptyState`, the 6.1.3 builder chrome) + token tiers; render ' +
        'checklist + AA + dark parity pass.\n' +
        '- Panels cover: save dialog + dirty/ownership states, the dropdown (all groups + ' +
        'search + star), the directory (columns, actions-by-role, built-ins, empty/no-access), ' +
        'visibility control, delete-with-dependents warning, subscription editor, and the ' +
        'filter-missing widget state.\n' +
        '- `design-notes.md` names the directory route, the dropdown grouping/order rule ' +
        '(starred → mine → project → defaults), the owner/non-owner save split, and records ' +
        'the two-visibility deviation + extension slots.\n' +
        '- No improvised primitive; token needs recorded.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/filter-builder.mock.html` + notes (6.1.3) — the surface this ' +
        'extends; `filter.mock.html` (2.5.9) + `list.mock.html` (the toolbar grammar)\n' +
        '- `design/projects/` 6.4.1 (the access-control + members-panel grammar to mirror ' +
        'for visibility + change-owner)\n' +
        '- The verified Jira directory columns / starred-menu / Save-as facts in the Story ' +
        '6.2 description\n' +
        '- Findings #35/#54; the design-mockup render checklist',
    },
    {
      id: '6.2.3',
      title:
        'Save + apply UI on /issues — Save/Save-as with dirty state, the filter dropdown (starred/mine/project/defaults), name chip, star toggle',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: ['6.2.1', '6.2.2', '6.1.4'],
      descriptionMd:
        'The /issues-side surfaces, per the 6.2.2 design, on the 6.2.1 API.\n\n' +
        '**Build** (extending the 6.1.4 builder area): the **save dialog** (name / ' +
        'description / visibility, duplicate-name + viewer-private-only states) wired to the ' +
        'current builder AST; the **applied-filter name chip** + dirty indicator — the chip ' +
        'tracks whether the URL AST still equals the saved envelope; **Save** (owner: ' +
        'overwrite) vs **Save as** (everyone) per the mirror rule; the **filter dropdown** — ' +
        'starred → My filters → Project filters → Defaults, server-backed search ' +
        '(debounced, bounded), per-row star toggle, "View all filters" footer; applying an ' +
        'entry loads the resolved AST into the builder + the `?filter=v1:` URL (the saved ' +
        'filter IS the URL once applied — reload/share keeps working with no new state ' +
        'channel); rename/edit-details from the chip menu for those permitted. Strings via ' +
        'next-intl.\n\n' +
        '**A11y:** dialog focus-trapped; the dropdown groups labelled; star toggles ' +
        'announce state; the dirty indicator is not colour-only; extends the /issues strict ' +
        'sweep.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Save / dirty / Save-as match the design and the ownership split (non-owner never ' +
        'sees overwrite-Save); duplicate names surface the designed error; a viewer gets no ' +
        'Project visibility option.\n' +
        '- The dropdown renders the four groups in order, searches server-side, stars ' +
        'in-place, and applies entries into builder + URL (round-trip: applying then ' +
        'reloading restores identical state); defaults apply but expose no edit/delete.\n' +
        '- The chip + dirty state track URL↔saved-envelope equality through builder edits, ' +
        'URL navigation, and apply actions.\n' +
        '- Axe-clean; token tiers only; next-intl; integration tests over save / dirty / ' +
        'apply / star wiring; coverage ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/saved-filters.mock.html` + notes (6.2.2) — THE authority\n' +
        '- 6.2.1 (API + permission matrix + defaults); 6.1.4 (the builder surface + URL ' +
        'state this extends); 6.1.1 (envelope equality for the dirty check)\n' +
        '- The i18n threading pattern; the 2.5.x URL-param conventions',
    },
    {
      id: '6.2.4',
      title:
        'Filters directory — the project-level manage surface (search, pagination, actions by role, built-ins, delete-with-dependents warning)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['6.2.1', '6.2.2'],
      descriptionMd:
        'The directory, per the 6.2.2 design (which names the route), on the 6.2.1 list/' +
        'write API.\n\n' +
        '**Build:** the paginated, server-searched table — name (→ applies the filter on ' +
        '/issues) / owner / visibility / star count + my-star toggle / actions; row actions ' +
        'gated by the matrix (rename + edit details + visibility for owner/admin; change ' +
        'owner admin-only; delete with the **dependents warning** — the confirm enumerates ' +
        'subscriptions [and reserves the 6.3 widget line] before cascading); built-in ' +
        'defaults listed read-only with their designed mark; empty, loading, error, and ' +
        'no-access states per the design. Strings via next-intl.\n\n' +
        '**A11y:** a real table with row-action menus keyboard-complete; the delete confirm ' +
        'names consequences in text; extends the strict sweep.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The directory paginates + searches server-side (asserted: no unbounded fetch); ' +
        'name-click applies on /issues; star toggles update the aggregate.\n' +
        '- Every row action enforces the matrix in the UI AND re-checks server-side (403 ' +
        'paths tested); change-owner is admin-only; delete shows the dependents warning and ' +
        'cascades subscriptions.\n' +
        '- Built-ins are present, read-only, and unstarrable-or-starrable per the design ' +
        'decision recorded in the notes; empty/no-access states render designed.\n' +
        '- Axe-clean; token tiers only; next-intl; integration tests over the table + ' +
        'actions; coverage ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/saved-filters.mock.html` + notes (6.2.2) — THE authority ' +
        '(incl. the route placement)\n' +
        '- 6.2.1 (list reads + matrix + dependents read); the shell nav conventions (1.5) ' +
        'for mounting the route\n' +
        '- The verified Jira directory columns + admin powers in the Story 6.2 description\n' +
        '- The i18n threading pattern',
    },
    {
      id: '6.2.5',
      title:
        'Filter subscriptions — schedule schema + Inngest cron delivery (results email, 50-row cap, deep link) + subscribe/unsubscribe UI',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 32,
      dependsOn: ['6.2.1', '6.2.2', '6.2.4'],
      descriptionMd:
        'The emailed-results loop, on the Story 1.6 jobs substrate.\n\n' +
        "**Schema:** `saved_filter_subscription` — filter FK (cascade per 6.2.1's delete), " +
        'user FK, schedule preset (`daily | weekdays | weekly(day)`) + hour (workspace-' +
        'timezone semantics documented), unique per (filter, user).\n\n' +
        '**Delivery:** an Inngest **cron** job (the `dailyHealthCheck` precedent) ticking ' +
        'hourly → due subscriptions fan out as events (one delivery per subscription — ' +
        'retries/DLQ ride the shipped 1.6 machinery); each delivery resolves the filter via ' +
        'the 6.2.1 read AS THE SUBSCRIBER (the permission matrix applies — a subscriber who ' +
        'lost browse access gets no mail, and a filter gone private stops delivering to ' +
        'non-owners), renders `lib/emailTemplates/filterSubscription.tsx` — filter name, ' +
        'first **50 results** (our page unit; Jira caps at 200) as identifier + title + ' +
        'status, the total count, a deep link to the applied `?filter=v1:` URL, and an ' +
        'unsubscribe link — and sends via `lib/email.ts`. Zero-result deliveries still send ' +
        "(the mirror's subscription is a report, not an alert; note it in the template " +
        'copy).\n\n' +
        '**UI:** the subscribe control + preset editor per the 6.2.2 design (dropdown row ' +
        'action + directory row action), the subscribed state, unsubscribe (in-app + the ' +
        'email link, token-authenticated like the shipped unsubscribe patterns). Strings ' +
        'via next-intl.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Schedule semantics tested with a frozen clock: daily/weekdays/weekly(day) at the ' +
        'configured hour each compute due-ness correctly across DST boundaries (documented ' +
        'timezone rule).\n' +
        '- The delivery resolves as the subscriber (permission-loss and gone-private paths ' +
        'asserted: no mail), caps at 50 + true total count, deep-links to the exact applied ' +
        'state, and survives a stale-referent AST (the email renders the degraded ' +
        'condition, never crashes the job — DLQ stays empty in the happy path).\n' +
        '- Template snapshot-tested (subject + text + html; unsubscribe link verbatim in ' +
        'plain text per the email-template contract); subscribe/unsubscribe round-trips ' +
        'from both mounts; filter deletion cascades subscriptions.\n' +
        '- `pnpm test:coverage` ≥90% on the new service/job files.\n\n' +
        '## Context refs\n\n' +
        '- `lib/jobs/` (defineJob/registry/retries/DLQ) + ' +
        '`lib/jobs/definitions/dailyHealthCheck.ts` — the cron precedent\n' +
        '- `lib/emailTemplates/` contract in `motir-core/CLAUDE.md` (pure templates, ' +
        'hand-written plain text) + `lib/email.ts`\n' +
        '- 6.2.1 resolve-as-user read; `design/work-items/saved-filters.mock.html` (the ' +
        'subscription editor panels)\n' +
        '- The verified Jira subscription facts (presets/cron, 200-cap) in the Story 6.2 ' +
        'description',
    },
    {
      id: '6.2.6',
      title:
        'Story tests — permission/visibility matrix + persist→resolve properties + the save→share→subscribe E2E + a11y sweep',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['6.2.3', '6.2.4', '6.2.5'],
      descriptionMd:
        'The story-closing verification (Principle #18; the epic-wide journey stays Story ' +
        '6.7).\n\n' +
        '**Vitest (integration, real Postgres):** the **(role × visibility × action) ' +
        'matrix** driven from a table so a new action without a matrix row fails (the ' +
        'totality-guard pattern); the **persist→resolve property suite** (every generated ' +
        'AST round-trips; malformed + future-versioned envelopes recover typed; stale ' +
        'referents degrade per field/option/label/component); name-uniqueness collisions; ' +
        'star aggregation; built-in immutability; subscription due-ness (frozen clock) + ' +
        'the as-subscriber resolution paths; the delete-dependents enumeration + cascade.\n\n' +
        '**Playwright E2E (`tests/e2e/saved-filters.spec.ts`):** the recipe journey — ' +
        'build → Save as (Project) → applied chip → edit a row → dirty → Save → second ' +
        'user applies + stars + edits → Save-as-only → directory rename / visibility flip ' +
        '/ admin change-owner → subscribe → delete with the dependents warning → the ' +
        'private filter invisible to the second user throughout its private phase. ' +
        '**a11y:** the strict axe sweep over the save dialog, dropdown (all groups), ' +
        'directory, and subscription editor.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The matrix + property + scheduler suites are green and registry/table-driven ' +
        '(adding an action or AST node without coverage fails); fuzz reuses the 6.1.6 ' +
        'generators against the STORED path.\n' +
        "- The E2E journey passes green in CI's Playwright lane; the sweep reports zero " +
        'violations.\n' +
        '- The Story 6.2 verification recipe runs clean top to bottom; ' +
        '`pnpm test:coverage` keeps all 6.2 files ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- The 6.1.6 generator/fuzz suites (reused against persistence); the totality-' +
        'guard pattern (5.5.1/6.1.1)\n' +
        '- `tests/integration/` + `tests/e2e/` conventions; the harness/selector memories\n' +
        '- The Story 6.2 verification recipe — the checklist this automates\n' +
        '- Story 6.7 (the epic-wide remainder — do not duplicate)',
    },
  ],
};
