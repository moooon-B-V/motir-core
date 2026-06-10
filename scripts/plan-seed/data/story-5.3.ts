import type { PlanStory } from '../types';

/**
 * Story 5.3 — Custom fields (per-project definitions).
 *
 * The extensible-schema piece: per-project field DEFINITIONS (text / number /
 * date / select / user — the five types the epic prose pins, each present in
 * Jira's team-managed set), managed in the project settings area 6.4 built,
 * with VALUES stored against issues in a typed-EAV table and rendered +
 * inline-edited on the detail rail. Designed so Epic 6 search can filter on
 * values (the stub's explicit constraint) — the schema carries the typed
 * columns + indexes and the documented predicate contract; the filter UI
 * itself is Story 6.1.
 *
 * 📦 Lives in Epic 5. Deps: 5.3 siblings + done Epic-1/2/6.4 work — the
 * cross-epic audit (`notes.html` mistake #32) is clean (6.4 shipped early and
 * is `done`; depending on it is backward-in-time, not forward-pointing).
 *
 * Mirror-product check (decision-ladder rung 1 — VERIFIED against Atlassian
 * sources at plan time, 2026-06-10; team-managed = the small-team shape):
 *   • **Types** — team-managed offers Checkbox/Date/Dropdown/Formula/Label/
 *     Number/Paragraph/People/Short text/Time stamp/Time tracking. Our five
 *     (text·number·date·select·user) map to Short text / Number / Date /
 *     Dropdown / People — each a verified member of the mirror set. Dropdown
 *     is **single-select only** in team-managed (multi-select is the separate
 *     Checkbox type), so our single-select `select` IS the mirror shape, not a
 *     cut. People defaults multi with a restrict-to-single option; ours is
 *     single-user (the assignee grammar; multi-person is the documented
 *     extension alongside checkbox/paragraph/labels).
 *   • **Admin** — Project settings → Fields, managed by project admins.
 *     Fields are project-scoped, never shared across projects. Caps adopted:
 *     **50 fields/project, 55 options/field** (the documented Jira limits —
 *     cheap guards that keep every read bounded).
 *   • **Issue view** — fields with values show in the Details panel; empty
 *     ones hide behind **"Show more fields"** (Jira's hide-when-empty rule).
 *     We mirror that behaviour WITHOUT the layout-config admin (work-type
 *     layouts / hide-divider / per-type required are a whole admin subsystem —
 *     the documented extension, owned by 6.5's settings-hub composition).
 *   • **Options** — rename + reorder; **delete only when unused** (Jira's
 *     documented "Optimize" rule — deleted-option semantics for in-use options
 *     are UNVERIFIED in team-managed docs, so the safe verified rule wins);
 *     an in-use option is **archived** instead (hidden from new selection,
 *     existing values keep rendering, marked archived).
 *   • **Field deletion** — team-managed delete is immediate, permanent, and
 *     destroys stored values (no trash). Mirrored: hard delete with a confirm
 *     naming the value count.
 *   • **History** — value changes land in the issue changelog. Mirrored via
 *     the 1.4.6 revision diff (`customFields.<key>: {from,to}`), which 5.5
 *     renders.
 *   • **Storage** — Jira itself stores custom values as a typed-EAV
 *     `customfieldvalue` table (STRINGVALUE/NUMBERVALUE/DATEVALUE… columns).
 *     That settles typed-EAV over a JSON blob: typed columns give Epic-6
 *     real predicates + indexes and FK integrity for user/option values.
 *
 * ⚠️ Design gate (planning-time). TWO undesigned surfaces, so TWO `type:
 * design` subtasks: **5.3.4** the Fields admin page (`design/projects/
 * fields.mock.html` — the settings area design only covers Members+Access)
 * and **5.3.5** the rail rendering + per-type editors (`design/work-items/
 * custom-fields.mock.html` — `detail.pen` predates custom fields entirely).
 * The UI code subtasks (5.3.6 admin, 5.3.7 rail) carry their design in
 * `dependsOn` and seed `'blocked'` (Principle #13).
 *
 * Expanded from its `stubs.ts` entry per `prodect plan 5.3`, on the standing
 * `seed/epic-5-plan` branch. Matches the canonical depth + string-literal
 * style of Stories 5.1 / 5.2.
 */
export const story_5_3: PlanStory = {
  id: '5.3',
  title: 'Custom fields (per-project definitions)',
  status: 'planned',
  descriptionMd:
    'The extensible-schema layer: project admins define **custom fields** — `text` · `number` · ' +
    '`date` · `select` (single, with managed options) · `user` — in the project settings area ' +
    '(6.4), and issues carry **values** for them, rendered and inline-edited on the detail rail ' +
    'beside the built-in fields. Values are stored **typed-EAV** (one row per issue × field with ' +
    'per-type value columns — the shape Jira itself uses) so **Epic 6 can filter on them with real ' +
    'predicates and indexes** — the stub\'s "design carefully" constraint, honoured in the schema, ' +
    'not deferred.\n\n' +
    '**The Jira-verified shape (rung 1, team-managed, checked at plan time).** Our five types each ' +
    "map to a verified member of Jira's team-managed set (Short text / Number / Date / Dropdown / " +
    'People). Team-managed **Dropdown is single-select only** (multi-select is the separate ' +
    'Checkbox type), so single-select IS the mirror shape. Definitions live at **Project settings ' +
    '→ Fields**, project-admin-gated (the 6.4 two-tier check), project-scoped, with the documented ' +
    'Jira caps adopted as guards: **50 fields per project, 55 options per field**. On the issue ' +
    'view, fields WITH values render as rail cards; empty ones collapse behind **"Show more ' +
    'fields"** (Jira\'s hide-when-empty rule) — mirrored without the work-type layout-config ' +
    'subsystem (layouts / per-type required / create-form placement are the documented extension, ' +
    "composing into 6.5's settings hub). **Field deletion is hard** (team-managed has no trash: " +
    'immediate, permanent, values destroyed — confirm names the value count). **Options** rename ' +
    'and reorder freely; an **in-use option archives** (hidden from new selection, existing values ' +
    'keep rendering with an archived mark) and **deletes only when unused** — the verified ' +
    '"Optimize" rule; in-use-delete semantics are undocumented in the mirror, so the safe rule ' +
    'wins. **Value changes write the 1.4.6 revision diff** (`customFields.<key>`) — the History ' +
    'entries Story 5.5 renders, same as built-in fields.\n\n' +
    "**Validation is the service's job, per type:** number → decimal (the storage column, not " +
    'float drift); date → date-only ISO, UTC-safe (the dueDate convention); select → the option ' +
    'must belong to the field and (for NEW sets) not be archived; user → a workspace member who ' +
    'can view the project (the 6.4 `assignableMembersService` scoping — the same rule as ' +
    'assignee/mentions); text → length-capped. Setting a value upserts the row; clearing deletes ' +
    'it (no tombstone rows). Who edits values = who edits the issue (`admin`/`member`; read-only ' +
    '`viewer` sees values, no editors).\n\n' +
    "**Bounded everywhere (finding #57).** The detail read joins ≤50 definitions + this issue's " +
    "value rows (one bounded query slotted into `getIssueDetail`'s parallel fetch); the admin " +
    'list is ≤50 by the cap; options ≤55. The Epic-6 contract is documented in the schema ' +
    "subtask: per-type value columns indexed by `[fieldId, value*]` so 6.1's filter builder " +
    'compiles JOIN-on-value predicates without a schema change.\n\n' +
    '**Completeness — the real-product states.** Admin: empty ("No custom fields yet"), the ' +
    'caps reached (50/55 — disabled add + explanatory copy), delete confirm with value count, ' +
    'option archive vs delete split, loading/error. Rail: empty-value placeholder, "Show more ' +
    'fields" expander, per-type editors with inline validation errors, archived-option ' +
    "rendering, viewer read-only, concurrent-edit refresh (the rail's existing " +
    'optimistic-concurrency pattern). All drawn by 5.3.4/5.3.5, asserted in 5.3.8.\n\n' +
    '**Out of scope (documented extension slots, each justified):** the remaining mirror types ' +
    '(paragraph / checkbox-multi / labels / multi-person / formula / time stamp — additive ' +
    "types on the same EAV substrate; labels overlap Story 5.4's taxonomy); work-type field " +
    'layouts, per-type **required** flags, and create/edit-form placement (the layout-config ' +
    'admin subsystem — 6.5 composes the settings hub; values are editable the moment an issue ' +
    'exists via the rail); custom fields in the board/list/tree columns (Epic-6 saved-views ' +
    'territory); cross-project/global fields (company-managed Jira, not the team-managed ' +
    'mirror); and the filter UI over values (**Story 6.1**, which consumes the documented ' +
    'predicate contract).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (applies the 5.3.1 ' +
    'definition/option/value migration cleanly; re-run reports "No difference detected"), ' +
    '`pnpm db:seed`, `pnpm dev`.\n' +
    '- `pnpm test:coverage` — Vitest (real Postgres) over the definitions + values services ' +
    '(CRUD, caps, per-type validation, option archive/delete rules, permission gates) ≥90% ' +
    'per-file branch/fn/line; new repo methods carry empty-input-guard tests.\n' +
    '- **Admin flow:** sign in as `zhuyue@prodect.co` / `!QAZ1qaz` (project admin) → Project ' +
    'settings → Fields (matching `design/projects/fields.mock.html`). Create one field of each ' +
    'type (Severity/select with 3 options, Customer/text, Effort/number, Go-live/date, ' +
    'Stakeholder/user) → all list in order; rename + reorder a select option; archive an in-use ' +
    'option (stays rendered on issues, gone from new pickers); delete an unused option; delete ' +
    'a field → the confirm names the value count and values vanish. As `eikooc@prodect.co` ' +
    '(member, not project admin) → the Fields page is read-only/forbidden.\n' +
    '- **Rail flow:** open an issue → defined fields with values render as rail cards below the ' +
    'built-ins (matching `design/work-items/custom-fields.mock.html`); empty ones sit behind ' +
    '"Show more fields"; set each type inline (text, number, date via DatePicker, select via ' +
    'Combobox, user via the member picker) → values persist and the revision trail records ' +
    '`customFields.<key>` diffs; clear a value → the card returns to the empty set; invalid ' +
    'input (bad number, archived option, non-member user) errors inline, nothing persists.\n' +
    '- **Permissions:** a project `viewer` sees values but no editors; cross-workspace reads ' +
    '404 (finding #44).\n' +
    '- **Caps:** the 51st field and 56th option are rejected with the explanatory error; the ' +
    'admin UI disables add at the cap.\n' +
    '- **Epic-6 seam:** the schema doc note exists (typed value columns + `[fieldId, value*]` ' +
    'indexes + the JOIN predicate sketch); a raw SQL spot-check filters issues by ' +
    '`Severity = High` using only the indexes (no JSON parsing).\n' +
    '- `pnpm test:e2e --grep custom-fields` — Playwright over the real stack: define → set on ' +
    'an issue → edit → History shows the change → delete field → values gone.\n' +
    '- **a11y check:** the Fields admin page + the rail editors pass the strict axe sweep ' +
    '(labelled controls, keyboard-complete pickers, "Show more fields" as a disclosure, state ' +
    'as text); colour via `--el-*`, shape via element shape tokens.',
  items: [
    {
      id: '5.3.1',
      title:
        'Schema — `custom_field_definition` + `custom_field_option` + typed-EAV `custom_field_value` (+ the documented Epic-6 predicate contract)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 20,
      dependsOn: [],
      descriptionMd:
        'The extensible-schema substrate. Schema + migration + repo skeletons only.\n\n' +
        '**`CustomFieldDefinition`** — `id`, `workspaceId`, `projectId`, `key` (machine slug, ' +
        '`@@unique([projectId, key])` — the stable handle revision diffs and Epic-6 predicates ' +
        'reference; generated from the label, immutable after create), `label`, `fieldType` ' +
        "(`'text' | 'number' | 'date' | 'select' | 'user'`), `description?`, `position` " +
        '(fractional-index `String @db.Text` — the `WorkflowStatus` convention), timestamps. ' +
        'Index `[projectId, position]`. The project-scoped-config precedent is `WorkflowStatus` ' +
        '(key+label split, fractional position) — mirror it.\n\n' +
        '**`CustomFieldOption`** — `id`, `fieldId` (Cascade), `label`, `position` (fractional), ' +
        '`archived` (default false), timestamps; `@@index([fieldId, position])`. Options are ' +
        'ROWS, not a JSON config blob: orderable, renameable, FK-able from value rows (the ' +
        'archive/delete rules need referential integrity).\n\n' +
        '**`CustomFieldValue`** — typed-EAV, the Jira `customfieldvalue` shape: `id`, ' +
        '`workspaceId`, `workItemId` (Cascade — values die with the issue), `fieldId` (Cascade — ' +
        'team-managed field delete destroys values), and ONE populated per-type column: ' +
        '`valueText String? @db.Text`, `valueNumber Decimal?`, `valueDate DateTime? @db.Date`, ' +
        '`valueUserId String?` (FK → User, SetNull — a deleted user clears the value, never ' +
        'blocks), `valueOptionId String?` (FK → CustomFieldOption, **Restrict** — the service ' +
        'must clear/migrate values before an option hard-deletes; the DB backstops the ' +
        'only-when-unused rule). `@@unique([workItemId, fieldId])` (one value per pair — upsert ' +
        'target). **The Epic-6 contract:** indexes `[fieldId, valueOptionId]`, `[fieldId, ' +
        'valueNumber]`, `[fieldId, valueDate]`, `[fieldId, valueUserId]` (+ the unique covers ' +
        'by-item reads), and a schema-comment block documenting the JOIN-predicate sketch 6.1 ' +
        'compiles (`JOIN custom_field_value v ON v.work_item_id = w.id AND v.field_id = ? WHERE ' +
        'v.value_option_id = ?`). Every FK a two-sided `@relation` (CLAUDE.md rule).\n\n' +
        '**Repo skeletons** (single-op, writes require `tx`): definition CRUD + ' +
        '`listByProject`, `countByProject`; option CRUD + `listByField`, `countByField`, ' +
        '`countValuesByOption`; value `upsert`, `deleteByWorkItemAndField`, ' +
        '`listByWorkItem(workItemId)` (bounded by the 50-field cap), `countByField` (the ' +
        'delete-confirm number).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The three models exist with the exact scoping/uniques/indexes above; every FK is a ' +
        'two-sided `@relation` with the stated onDelete actions (value→option Restrict, ' +
        'value→user SetNull, value→workItem + value→field + option→field Cascade); ' +
        '`prisma migrate dev` re-run reports no drift.\n' +
        '- The Epic-6 predicate contract is documented (schema comment + a `lib/dto` or doc ' +
        'note 6.1 can cite): typed columns + the four `[fieldId, value*]` indexes + the JOIN ' +
        'sketch.\n' +
        '- Repo methods exist as single ops; Vitest (real Postgres) verifies the cascades ' +
        '(field delete removes values; issue delete removes values; option delete with values ' +
        'is DB-rejected), the one-value-per-pair unique, and empty-input guards (coverage ' +
        'gate).\n\n' +
        '## Context refs\n\n' +
        '- `prisma/schema.prisma` — `WorkflowStatus` (the project-scoped-config precedent: ' +
        'key/label/position) + `WorkItem`/`User`; `prodect-core/CLAUDE.md` (FK rule, ' +
        'required-`tx`)\n' +
        "- Jira's `customfieldvalue` typed-EAV schema (the verified storage precedent in the " +
        'Story 5.3 description)\n' +
        '- `lib/repositories/workflowStatusRepository.ts` (or equivalent) — repo conventions ' +
        'for project-scoped config\n' +
        '- Story 6.1 stub — the downstream consumer of the predicate contract',
    },
    {
      id: '5.3.2',
      title:
        '`customFieldsService` (definitions) — CRUD + option rename/reorder/archive/delete-when-unused + the 50/55 caps, admin-gated, routes',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['5.3.1'],
      descriptionMd:
        'The definitions half of the service. Per the 4-layer rule: ' +
        '`lib/services/customFieldsService.ts` + typed errors (`lib/customFields/errors.ts`) + ' +
        'DTOs/mappers + HTTP-only routes.\n\n' +
        '**Definition CRUD** — `createField(projectId, { label, fieldType, description?, ' +
        'options? }, ctx)` (slug-generates the immutable `key`, unique per project; seeds ' +
        'initial options for `select`; enforces the **50-field cap** with a typed error), ' +
        '`renameField`, `reorderField` (fractional index — the board-settings precedent), ' +
        '`deleteField` (the team-managed mirror: HARD delete, values destroyed via the cascade; ' +
        'the service returns/exposes the **value count** so the UI confirm can name it — ' +
        '`countValuesByField` read first). All **project-admin-gated** — the 6.4 two-tier check ' +
        '(`isWorkspaceManager(wsRole) || projectMembership.role === admin`), exactly the ' +
        'members-page pattern.\n\n' +
        '**Option management** (select fields) — `addOption` (55-cap), `renameOption`, ' +
        '`reorderOption`, and the verified split: `archiveOption` (any time — hidden from new ' +
        'selection, existing values keep rendering) vs `deleteOption` (**only when unused** — ' +
        '`countValuesByOption === 0`, else a typed `OptionInUseError`; the DB Restrict ' +
        'backstops). Unarchive supported (the inverse is free).\n\n' +
        '**Reads** — `listFields(projectId, ctx)` (admin page: definitions + option sets + ' +
        'per-field value counts, ≤50 bounded); a lighter `listFieldsForIssueRail` shape is ' +
        "5.3.3's concern. **Routes:** `GET/POST /api/projects/[id]/fields`, `PATCH/DELETE " +
        '/api/fields/[id]`, `POST/PATCH/DELETE` under `/api/fields/[id]/options` — parse → one ' +
        'service call → typed-error mapping (403 not-admin / 404 cross-workspace per finding ' +
        '#44 / 409 in-use / 422 caps).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Field create/rename/reorder/delete + option add/rename/reorder/archive/unarchive/' +
        'delete ship with the caps (50/55 → typed errors), the immutable-key rule, and the ' +
        'only-when-unused option delete (in-use → 409; archive offered); field delete ' +
        'cascades values and the API exposes the pre-delete value count.\n' +
        '- Every mutation is project-admin-gated (6.4 two-tier); non-admins get 403, ' +
        'cross-workspace 404; a `viewer`/`member` can READ definitions (the rail needs them) ' +
        'but not mutate.\n' +
        '- One service method = one transaction; reorder uses fractional indexing (no ' +
        'renumber sweeps); routes are HTTP-only; `pnpm test:coverage` ≥90% incl. the cap + ' +
        'in-use branches.\n\n' +
        '## Context refs\n\n' +
        '- 5.3.1 models/repos; `app/(authed)/settings/project/members/page.tsx` (the 6.4 ' +
        'admin-gate pattern to reuse) + `lib/projects/roles`\n' +
        '- The board-settings fractional reorder precedent (3.6) for option/field reorder\n' +
        '- The verified mirror rules in the Story 5.3 description (50/55 caps; hard field ' +
        'delete; archive vs delete-when-unused)\n' +
        '- `lib/services/workspacesService.ts` / `projectsService` DTO+mapper conventions',
    },
    {
      id: '5.3.3',
      title:
        '`customFieldsService` (values) — per-type validated set/clear + revision-trail diffs + the bounded detail-read join',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['5.3.1'],
      descriptionMd:
        'The values half. `setValue(workItemId, fieldId, rawValue | null, ctx)` + the read ' +
        'shape the rail consumes.\n\n' +
        '**Per-type validation (the service is the authority):** `text` → trimmed, ' +
        'length-capped (a constant, e.g. 1000 chars); `number` → decimal parse into the ' +
        'Decimal column (reject NaN/∞; preserve scale); `date` → date-only ISO, UTC-safe (the ' +
        'dueDate `T00:00:00.000Z` convention — no local-tz off-by-one); `select` → the option ' +
        'belongs to this field AND is not archived for NEW writes (an existing value holding ' +
        'an archived option remains valid + renderable); `user` → a workspace member who can ' +
        'view the project (the 6.4 `assignableMembersService` scoping — same rule as ' +
        'assignee/mentions). Type mismatches and cross-field options → typed 422s.\n\n' +
        '**Write semantics:** non-null → upsert the `[workItemId, fieldId]` row (exactly one ' +
        'per-type column populated, the rest null); null → DELETE the row (no tombstones). In ' +
        'the SAME transaction, write the 1.4.6 revision entry — `diff: { "customFields.<key>": ' +
        '{ from, to } }` (display-friendly from/to: the option label, the user id, the raw ' +
        "scalar — the mapper renders), `changeKind: 'updated'` — the History entry 5.5 " +
        'renders, the parity Jira has. Permissions: who edits the issue edits values ' +
        '(`admin`/`member` with view; `viewer` 403; cross-workspace 404).\n\n' +
        '**Read** — extend `getIssueDetail` with `customFields: CustomFieldWithValueDto[]` ' +
        "(definitions in position order, each with its option set + this issue's value, " +
        'resolved for display: option label+archived flag, user id/name/image). ONE bounded ' +
        'query (≤50 defs cap) slotted into the existing parallel fetch — no N+1, no separate ' +
        'round-trip from the page. A dedicated `setCustomFieldValueAction` server action ' +
        '(the rail pattern: action → service → `router.refresh()`); custom values do NOT ' +
        "overload `updateIssueAction`'s scalar input (different table, different validation " +
        'surface — keep the seams clean).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `setValue` validates per type exactly as specified (incl. archived-option ' +
        'new-write rejection, non-viewable-user rejection, decimal + UTC-date integrity), ' +
        'upserts/deletes the single row, and writes the `customFields.<key>` revision diff ' +
        'in the same tx.\n' +
        '- `getIssueDetail` returns the bounded `customFields` array (defs + resolved ' +
        'values) without an N+1; an issue with no values still lists definitions (the rail ' +
        'needs them for "Show more fields").\n' +
        '- Permission matrix enforced (member sets, viewer 403, cross-workspace 404); ' +
        'concurrent set on the same pair converges via the upsert (last-write-wins, no ' +
        'duplicate-row error).\n' +
        '- Routes/action are HTTP-only thin; `pnpm test:coverage` ≥90% across every type ' +
        'branch + the clear path.\n\n' +
        '## Context refs\n\n' +
        '- 5.3.1 value model + repos; `lib/services/workItemsService.ts` `getIssueDetail` ' +
        '(the parallel-fetch assembly to extend) + `updateIssueAction` (the action pattern ' +
        'to mirror, NOT extend)\n' +
        '- `lib/services/workItemRevisionsService.ts` + the revision diff shape ' +
        '(`Record<string, {from,to}>`) — extend with the `customFields.<key>` keys\n' +
        '- `lib/services/assignableMembersService.ts` (6.4) — the user-value scoping\n' +
        '- The dueDate UTC convention (2.3.12) for the date type',
    },
    {
      id: '5.3.4',
      title:
        'Design — Fields admin page (`design/projects/fields.mock.html`: field list + create/edit + options editor + caps/delete states)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: [],
      descriptionMd:
        'The design asset for the settings surface. The projects design area covers only ' +
        'Members + Access (6.4.1) — no Fields page exists anywhere, the design-gate ' +
        'NONE-exists case. Output: **`design/projects/fields.mock.html`** (built from ' +
        '`components/ui/*` + `--el-*`/element-shape tokens) + PNG + a section in ' +
        '`design/projects/design-notes.md`. Render checklist + AA + dark parity. Mirror: ' +
        'Jira team-managed Project settings → Fields.\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **Entry** — the new "Fields" card on the project-settings hub (the existing ' +
        'card+link grammar — sixth card beside Workflow/Board/Estimation/Members/Archive) ' +
        'and the Fields page shell (the settings detail-page chrome 6.4.1 set).\n' +
        '- **Field list** — one row per definition: type glyph (per-type icon), label, type ' +
        'name, value-count gloss, drag/reorder handle (the board-settings reorder grammar), ' +
        'row actions (rename, options for select, delete). Position order. Empty state ' +
        '("No custom fields yet" + Add field). The **cap state** (50 reached → Add disabled ' +
        '+ explanatory line).\n' +
        '- **Add/edit field** — the create affordance (inline form or modal — match the ' +
        '6.4.1 grammar): label, type picker (the five types w/ glyphs + one-line ' +
        'descriptions), description (optional); type immutable after create (stated in the ' +
        'edit state); select type reveals the options editor.\n' +
        '- **Options editor** (select fields) — option rows: label, drag-reorder, rename ' +
        'inline, archive toggle (archived rows muted + badged, "hidden from new ' +
        'selection"), delete (enabled only when unused — disabled state carries the ' +
        '"in use on N issues — archive instead" tooltip), Add option (+ the 55-cap state).\n' +
        '- **Delete field confirm** — names the value count ("Deletes the field and its ' +
        'values on N issues. This can\'t be undone." — the team-managed hard-delete truth); ' +
        '`--el-danger` confirm + ghost cancel (the 2.4.9 grammar).\n' +
        '- **Read-only** — the non-admin state (controls absent/disabled + the quiet ' +
        'permission line, the 6.4 read-only grammar); loading skeleton; `ErrorState`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/projects/fields.mock.html` + PNG + the design-notes section exist; ' +
        'composed from shipped primitives + token tiers only; render checklist + AA + dark ' +
        'parity pass.\n' +
        '- Panels cover: the hub card, the field list (populated + empty + cap), add/edit ' +
        'with the five-type picker, the options editor (reorder/rename/archive/' +
        'delete-when-unused/cap), the delete-field confirm naming the value count, and the ' +
        'read-only state.\n' +
        '- `design-notes.md` names primitives + copy strings, the per-type glyph map ' +
        '(shared with 5.3.5), and records the deliberate non-features (no required flag, no ' +
        'layouts, no create-form placement — the 6.5 extension).\n' +
        '- No improvised primitive; new token needs recorded for the code subtasks.\n\n' +
        '## Context refs\n\n' +
        '- `design/projects/access-members.mock.html` + design-notes (6.4.1) — the settings ' +
        'page grammar to extend; `app/(authed)/settings/project/page.tsx` (the hub cards)\n' +
        '- The board-settings reorder grammar (3.6 design) for drag handles\n' +
        '- The verified mirror behaviours in the Story 5.3 description (caps, hard delete, ' +
        'archive-vs-delete)\n' +
        '- Findings #35/#54; the design-mockup render checklist',
    },
    {
      id: '5.3.5',
      title:
        'Design — custom fields on the detail rail (`design/work-items/custom-fields.mock.html`: per-type cards + editors + "Show more fields")',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: [],
      descriptionMd:
        'The design asset for the issue-view surface. `detail.pen` predates custom fields ' +
        'entirely — the rail cards, per-type editors, and the empty-fields disclosure are ' +
        'all undesigned (NONE exists). Output: ' +
        '**`design/work-items/custom-fields.mock.html`** + PNG + a section in ' +
        '`design/work-items/design-notes.md`. Render checklist + AA + dark parity. Mirror: ' +
        'the Jira issue-view Details / "Show more fields" behaviour (verified).\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **Placement** — custom-field cards in the core-fields rail, BELOW the built-in ' +
        'fields (status…estimate, created/updated stay last or the design picks the exact ' +
        'order), each reusing the shipped `FieldCard` grammar verbatim (uppercase label + ' +
        'chevron toggle + value line) — no new card chrome.\n' +
        '- **Per-type value rendering** — text (truncating, full on title); number ' +
        '(formatted decimal); date (the `formatDate` style the rail already uses); select ' +
        '(the option label — an **archived** option renders with a muted "(archived)" ' +
        'mark); user (Avatar + name, the assignee grammar). Empty value = the muted ' +
        'placeholder ("None"/"—", the rail convention).\n' +
        '- **Per-type editors** (inline, the FieldCard toggle pattern): text → input; ' +
        'number → numeric input with inline validation error; date → the shipped ' +
        '`DatePicker` (2.4.12) with Clear; select → the shipped `Combobox` (archived ' +
        'options excluded; a current-but-archived value shown selected with the mark); ' +
        'user → the member picker (the AssigneePicker grammar) with an Unset row. Each ' +
        'editor shows the inline 422 error state (rose-tint, the 2.4.9 grammar).\n' +
        '- **"Show more fields"** — fields WITHOUT values collapse behind a quiet ' +
        'disclosure row at the rail\'s end ("Show more fields (N)" → expands to the empty ' +
        'cards for setting; collapses back; a field gaining a value moves above the line — ' +
        'the verified Jira hide-when-empty rule). With NO custom fields defined, the rail ' +
        'is byte-identical to today (no disclosure, no section gap).\n' +
        "- **Viewer read-only** — values render, no chevrons/editors (the rail's existing " +
        'read-only grammar). Loading: the rail skeleton extends naturally.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/work-items/custom-fields.mock.html` + PNG + the design-notes section ' +
        'exist; composed from the shipped `FieldCard`/picker primitives + token tiers ' +
        'only; render checklist + AA + dark parity pass.\n' +
        '- Panels cover: rail placement among built-ins, all five value renderings (incl. ' +
        'archived-option + empty placeholder), all five editors with an inline error ' +
        'state, the "Show more fields (N)" disclosure (collapsed + expanded + the ' +
        'no-fields-defined null case), and viewer read-only.\n' +
        '- `design-notes.md` names the per-type glyph/format map (shared with 5.3.4), the ' +
        'exact ordering rule, and the no-fields null-case guarantee (rail unchanged).\n' +
        '- No improvised primitive — every editor is a shipped picker; any token need ' +
        'recorded.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/detail.pen` + design-notes (the rail grammar) + ' +
        '`CoreFieldsPanel.tsx` `FieldCard` (the shipped card to compose — rung-2 reality)\n' +
        '- `components/ui/DatePicker` (2.4.11/12 design+code), `Combobox`, ' +
        '`AssigneePicker` — the editors\n' +
        '- The verified Jira Details/"Show more fields" rule in the Story 5.3 ' +
        'description\n' +
        '- Findings #35/#54; the design-mockup render checklist',
    },
    {
      id: '5.3.6',
      title:
        'Fields admin UI — Project settings → Fields (list/reorder, create/edit, options editor, caps + delete-with-count confirm)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: ['5.3.2', '5.3.4'],
      descriptionMd:
        'The settings surface: `app/(authed)/settings/project/fields/page.tsx` (+ the new ' +
        'hub card), per the 5.3.4 design, on the 5.3.2 routes. The 6.4 members page is the ' +
        'structural template (server component + admin gate + read-only degradation).\n\n' +
        '**Build:** the hub card; the field list (type glyph, label, value-count gloss, ' +
        'drag-reorder via the shipped dnd pattern from board settings, row actions); ' +
        'add/edit field (label, five-type picker, description; type immutable; select ' +
        'reveals options); the options editor (reorder/rename inline, archive toggle, ' +
        'delete-when-unused with the in-use tooltip, add w/ 55-cap); the delete-field ' +
        'confirm naming the value count (from the 5.3.2 read); the 50-cap state; empty / ' +
        'loading / error; the non-admin read-only state. Mutations via server actions → ' +
        '`customFieldsService` → `router.refresh()`; i18n strings under a new ' +
        '`settings.customFields` namespace (the en-byte-identical i18n convention).\n\n' +
        '**A11y:** reorder is keyboard-operable (the board-settings dnd precedent), ' +
        'destructive confirms focus-managed, the options editor rows labelled; extends the ' +
        'settings-route axe sweep.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The page matches `fields.mock.html` panel-for-panel (list, add/edit, options ' +
        'editor incl. archive/delete split + tooltips, both cap states, the ' +
        'value-count delete confirm, empty/read-only states).\n' +
        '- All mutations round-trip (create each type, rename, reorder persists across ' +
        'reload, option lifecycle, field delete) honouring the admin gate — a non-admin ' +
        'member sees read-only, a viewer/none is gated per 6.4.\n' +
        '- Keyboard-complete reorder + editors; the strict axe sweep over the page is ' +
        'clean; colour/shape only through the token tiers; strings via next-intl.\n' +
        '- Component/integration tests over the action wiring + gate rendering; ' +
        '`pnpm test:coverage` holds.\n\n' +
        '## Context refs\n\n' +
        '- `design/projects/fields.mock.html` + notes (5.3.4) — THE layout authority\n' +
        '- `app/(authed)/settings/project/members/page.tsx` (6.4) — the page + gate ' +
        'template; the hub `page.tsx` card list\n' +
        '- 5.3.2 routes/actions; the board-settings dnd reorder (3.6) for the handle ' +
        'pattern\n' +
        '- `messages/en.json` `settings.*` namespace conventions (the i18n threading ' +
        'pattern memory)',
    },
    {
      id: '5.3.7',
      title:
        'Detail-rail custom fields UI — per-type cards + inline editors + "Show more fields" disclosure',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: ['5.3.3', '5.3.5'],
      descriptionMd:
        'The issue-view surface: extend `CoreFieldsPanel` (or a sibling ' +
        '`CustomFieldsSection` it composes) to render the `customFields` array from the ' +
        '5.3.3 detail read, per the 5.3.5 design.\n\n' +
        '**Build:** value cards reusing the shipped `FieldCard` grammar (label + chevron + ' +
        'value line) below the built-ins; per-type display (text/number/date/select w/ ' +
        'archived mark/user w/ Avatar) and per-type inline editors (input, numeric, the ' +
        'shipped `DatePicker`, `Combobox` excluding archived options, the member picker w/ ' +
        'Unset) — each committing through `setCustomFieldValueAction` (5.3.3) with the ' +
        "inline 422 error state and `router.refresh()` on success (the rail's existing " +
        'pattern); clearing returns the card to empty. **"Show more fields (N)"** ' +
        'disclosure for empty fields (expand/collapse; a field gaining a value moves above ' +
        'the line on refresh); with no definitions the rail renders byte-identical to ' +
        'today. Viewer read-only (no editors). The editors honour `disabled` while a ' +
        'patch is pending (the `isPending` rail convention).\n\n' +
        '**A11y:** the disclosure is a proper `aria-expanded` button; every editor ' +
        'labelled by its field label; errors announced inline (the rose-tint grammar); ' +
        'extends the detail-route strict axe sweep.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The rail matches `custom-fields.mock.html` panel-for-panel: all five types ' +
        'render + edit inline, archived-option display + exclusion rules hold, empty ' +
        'placeholder + clear path work, the disclosure shows/hides empty fields with the ' +
        'correct count, the no-definitions case leaves the rail unchanged.\n' +
        '- Edits persist via the dedicated action with per-type validation errors inline ' +
        '(nothing persists on 422); the revision trail records each change; viewer sees ' +
        'read-only.\n' +
        '- Keyboard-complete editors + disclosure; strict axe sweep clean; token tiers ' +
        'only.\n' +
        '- Component/integration tests: per-type render/edit branches, the disclosure ' +
        'count, read-only; existing detail tests stay green; `pnpm test:coverage` holds.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/custom-fields.mock.html` + notes (5.3.5) — THE layout ' +
        'authority\n' +
        '- `CoreFieldsPanel.tsx` (`FieldCard`, the `patch`/`isPending`/refresh pattern) — ' +
        "extend, don't fork\n" +
        '- 5.3.3 (`customFields` read + `setCustomFieldValueAction`); the shipped pickers ' +
        '(`DatePicker`, `Combobox`, member picker)\n' +
        '- The 2.4.6 detail a11y sweep (extend scope)',
    },
    {
      id: '5.3.8',
      title:
        'Story tests — Vitest matrix (types × validation × permissions × lifecycle) + Playwright E2E (define → set → history → delete) + a11y sweep',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['5.3.6', '5.3.7'],
      descriptionMd:
        'The story-closing verification (Principle #18; the 5.1.7/5.2.8 split — epic-wide ' +
        'journeys stay Story 5.6).\n\n' +
        '**Vitest (integration, real Postgres):** the full matrix — five types × ' +
        '(valid set / invalid set / clear / re-set) with the per-type edge cases (decimal ' +
        'scale, UTC date boundary, archived-option new-write rejection, non-viewable user, ' +
        'text cap); definition lifecycle (create → rename → reorder → delete-with-values, ' +
        'cascades verified); option lifecycle (archive keeps values renderable; delete ' +
        'blocked in-use at BOTH service and DB layers; delete-when-unused); the 50/55 ' +
        'caps; the permission matrix (project admin / member / viewer / cross-workspace) ' +
        'over definitions AND values; revision diffs (`customFields.<key>`) written per ' +
        'change.\n\n' +
        '**Playwright E2E (`tests/e2e/custom-fields.spec.ts`):** as the PM — create the ' +
        'five fields (Severity select w/ options, Customer text, Effort number, Go-live ' +
        'date, Stakeholder user) in settings; open an issue → set each type inline (date ' +
        'via the DatePicker grid, select via Combobox, user via the member picker ' +
        'keyboard path); reload → values persist; the History/revision data shows the ' +
        'changes; "Show more fields" discloses the still-empty ones; archive an option → ' +
        'gone from the picker, still rendered on the holding issue; delete Severity → the ' +
        'confirm names the count, the rail card disappears. **Role pass:** non-admin ' +
        'member gets read-only settings; viewer gets read-only rail. Run against the ' +
        'standing dev-server harness.\n\n' +
        '**Strict a11y sweep:** the Fields settings page + the detail rail with editors ' +
        'open pass the strict axe config (extends the settings + 2.4.6 sweeps).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The Vitest matrix covers every cell above; `pnpm test:coverage` keeps all 5.3 ' +
        'files ≥90% branch/fn/line.\n' +
        '- `custom-fields.spec.ts` passes the define → set-each-type → persist → ' +
        "archive/delete journey + both role passes, green in CI's Playwright lane " +
        '(selector gotchas: Combobox option names include secondary text — match ' +
        'substrings).\n' +
        '- The strict axe sweep over both surfaces reports zero violations.\n' +
        '- The Story 5.3 verification recipe runs clean top to bottom; shared-DB flake ' +
        'isolation respected.\n\n' +
        '## Context refs\n\n' +
        '- `tests/integration/` + `tests/e2e/` conventions; the E2E selector-gotcha + ' +
        'harness memories (standing dev server; Combobox names)\n' +
        '- The 5.1.7/5.2.8 story-test shape (the split vs Story 5.6)\n' +
        '- The Story 5.3 verification recipe — the checklist this automates\n' +
        '- The strict-a11y sweep configs (settings + detail routes)',
    },
  ],
};
