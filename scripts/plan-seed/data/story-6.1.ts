import type { PlanStory } from '../types';

/**
 * Story 6.1 — Structured search + filter builder.
 *
 * The advanced-search layer over the issue list: a **filter builder** —
 * field / operator / value rows under a flat **match all / match any**
 * (AND/OR) combinator — compiling to a **safe, parameterized query** over
 * issues, including the Epic-5 surfaces (custom-field values, labels,
 * components) through the join-predicate contracts 5.3.1 / 5.4.1 documented
 * for exactly this story. Free-text match on title/description. **NO
 * query-language parser** (the stub's hard constraint).
 *
 * 📦 First Epic-6 expansion. Deps point at Epic-5 schema/primitive subtasks
 * (backward — Epic 5 ships before 6; the audit is clean) and shipped 2.5.x
 * substrate. The 2.5.4 facet bar + its URL serialization were explicitly
 * built as "the forward-compatible substrate Epic 6 saved filters persist" —
 * 6.1 is the consumer that grows it.
 *
 * Mirror-product check (decision-ladder rung 1 — VERIFIED against Atlassian
 * sources at plan time, 2026-06-10):
 *   • **Jira basic search is AND-of-facets only.** Each field filter is a
 *     value list (IN — OR within the field), fields AND together, and the
 *     DOCUMENTED conversion blacklist says basic cannot express: **OR across
 *     fields, NOT, EMPTY, or the comparison operators (!=, >, >=, <, <=)** —
 *     all of those require JQL. Dates are the exception: basic ships
 *     relative + in-range pickers that compile to range conditions.
 *   • **The builder's justification (recorded):** the card pins
 *     operator rows + AND/OR with no parser — RICHER than Jira basic,
 *     deliberately: it delivers precisely the operators Jira itself punts to
 *     a query language (negation, empty, comparisons, any-match), as a flat
 *     structured builder (the Linear-style shape) instead of JQL. One level
 *     only — match all / match any over rows; **nested condition groups are
 *     the documented extension** (groups are where a builder starts becoming
 *     a parser).
 *   • **Text search** — Jira basic matches summary + description (+ text
 *     fields) with stemming. Ours: contains-match over title + description
 *     (the stub's scope) via ILIKE backed by a pg_trgm index; stemmed/
 *     full-text search is the documented extension (Jira's is Lucene-backed
 *     infrastructure we don't carry).
 *   • **Results** — the Jira navigator is a flat, sortable, paginated list
 *     (50/page; cross-project with project as a filter). Ours: the SAME
 *     compiled predicate feeds the shipped /issues surfaces — the List
 *     (2.5.8 + 2.5.12 pagination, the navigator-faithful result view) AND
 *     the Tree (whose 2.5.1 ancestor-retaining read composes the same WHERE
 *     fragment). **Scope deviation (recorded):** project-scoped, not
 *     cross-project — the entire shipped issue-list substrate (2.5.x) and
 *     the shell's navigation model are active-project-scoped (rung 2); a
 *     workspace-wide navigator is the documented extension when a use case
 *     lands (6.3 dashboards aggregate via saved filters regardless).
 *
 * Architecture (the no-parser compile path): a typed **FilterAST** —
 * `{ combinator: 'and' | 'or', conditions: [{ field, operator, value }] }` —
 * is the single interchange shape: the builder UI edits it, a **versioned
 * URL serialization** carries it (the substrate Story 6.2 persists as saved
 * filters), and a **per-field-type operator registry** (TOTAL, mistake #29:
 * every field type maps to an explicit operator set + compile function +
 * value-editor kind; an unknown field/operator is a typed 422, never a
 * silent pass-through) compiles it into parameterized WHERE fragments —
 * Prisma args / bound `$queryRaw` params ONLY, never string interpolation
 * (the injection-safety AC the epic stub names). Epic-5 predicates compile
 * through the documented join contracts: `custom_field_value` typed columns
 * + `[fieldId, value*]` indexes (5.3.1), `work_item_label` /
 * `work_item_component` joins (5.4.1).
 *
 * ⚠️ Design gate (planning-time). `filter.mock.html` (2.5.9) designs ONLY
 * the basic facet popover — the builder (rows, combinator toggle, operator
 * menus, per-type value editors, the applied-state summary) is undesigned →
 * subtask **6.1.3** is the `type: design` subtask; the UI code subtasks
 * (6.1.4 / 6.1.5) carry it in `dependsOn` and seed `'blocked'`
 * (Principle #13).
 *
 * Expanded from its `stubs.ts` entry per `motir plan 6.1`, on the standing
 * `seed/epic-5-plan` branch (Epic-5/6 planning). Matches the canonical style
 * of 5.1–5.6.
 */
export const story_6_1: PlanStory = {
  id: '6.1',
  title: 'Structured search + filter builder',
  status: 'done',
  descriptionMd:
    'The advanced-search layer: a **filter builder** — field / operator / value rows under a ' +
    'flat **Match all / Match any** combinator — compiling to a **safe parameterized query** ' +
    "over the project's issues, including **custom-field values (5.3), labels and components " +
    '(5.4)** through the join-predicate contracts their schemas documented for this story. ' +
    'Free-text contains-match on title/description. **No query-language parser** — the builder ' +
    'IS the advanced mode.\n\n' +
    '**Where it sits relative to the mirror (verified, and the deviation recorded).** Jira ' +
    'basic search is AND-of-facets with IN-semantics per field; its OWN docs blacklist what ' +
    'basic cannot say — **OR across fields, NOT, EMPTY, comparisons (!=, >, <, ≥, ≤)** — all ' +
    'JQL-only. The builder deliberately sits between: it delivers exactly that blacklist ' +
    '(negation, empty/not-empty, comparisons, match-ANY) as structured rows — the no-parser ' +
    "route to JQL's most-used power. ONE level only (no nested groups — that is where " +
    'builders become parsers; documented extension). The 2.5.4 facet bar REMAINS as the quick ' +
    'path (Jira keeps basic next to advanced); the builder is the "Advanced" surface beside ' +
    'it, and a facet state upgrades losslessly into builder rows (the one-way basic→advanced ' +
    'conversion the mirror ships; complex builder states do not down-convert — also the ' +
    'mirror rule).\n\n' +
    '**The FilterAST + the operator registry (the load-bearing piece).** One typed shape — ' +
    '`{ combinator, conditions: [{ field, operator, value }] }` — edited by the UI, carried ' +
    'in a **versioned URL param** (`?filter=v1:…`, composing with the shipped ' +
    '`?view/?sort/?page` substrate — THE serialization Story 6.2 persists as saved filters), ' +
    'and compiled by a **per-field-type operator registry**: enum-ish fields (kind, status, ' +
    'priority, assignee, reporter, sprint, label, component, select-CF, user-CF) get ' +
    '`is any of / is none of / is empty / is not empty`; text (title/description + text-CF) ' +
    'gets `contains / does not contain`; numbers (story points, estimate, number-CF) get ' +
    '`= ≠ < ≤ > ≥ / empty`; dates (created, updated, due, date-CF) get `on or before / on or ' +
    'after / between / in the last N days / in the next N days / empty` (the relative forms ' +
    "mirror Jira basic's verified date pickers — and keep 6.2's saved filters like \"due " +
    'this week" durable). The registry is **TOTAL** (mistake #29): every field the builder ' +
    'offers has an explicit operator set + compile function + value-editor kind; unknown ' +
    'field/operator ids are typed 422s.\n\n' +
    '**Safe compilation (the injection AC).** Conditions compile to Prisma where-args / ' +
    'bound `$queryRaw` parameters ONLY — no string-built SQL anywhere on the path; the ' +
    'Epic-5 predicates ride the documented contracts (typed-EAV `[fieldId, value*]` indexed ' +
    'JOINs for custom fields; the label/component join tables). The compiled WHERE fragment ' +
    'feeds the EXISTING reads — the flat List (2.5.8/2.5.12 sort + pagination + count: the ' +
    "navigator-faithful result surface, 50/page like the mirror) AND the Tree (2.5.1's " +
    'ancestor-retaining read composes the same fragment, matches full-strength + muted ' +
    'ancestors) — one compiler, both views, no second query path.\n\n' +
    '**Bounded + complete (finding #57 + the real-product states).** Free-text ILIKE is ' +
    'backed by a pg_trgm GIN index (a contains-scan over 10k titles must not table-scan); ' +
    'every value-editor option list is the bounded read its owner ships (members, labels ' +
    'autocomplete, options ≤55); the result count tracks the filter; zero-result, ' +
    'invalid-URL-param (typed, recoverable — never a crash), stale-referent (a deleted ' +
    'option/label id in a shared URL → that condition reports "unknown value" and matches ' +
    'nothing rather than erroring the page), loading, and over-long-filter (row cap, e.g. ' +
    '20 conditions — a sanity guard) states are all designed + asserted.\n\n' +
    '**Out of scope (documented extension slots, each justified):** a JQL-style text query ' +
    "language (the stub's hard NO); nested condition groups (builder→parser line); " +
    'cross-project/workspace-wide search (the shipped substrate is active-project-scoped — ' +
    'rung 2; revisit with a real use case); stemmed/full-text search (Lucene-class infra; ' +
    'ILIKE+trgm covers the title/description scope); saving/naming filters (**Story 6.2** — ' +
    'this story ships the serialization it persists); filtering by watcher/"watched by me" ' +
    'and comment-count-style meta fields (additive registry entries when a use case lands); ' +
    "ORDER-BY as a filter concern (sorting is the List's shipped surface).",
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (the 6.1.1 pg_trgm ' +
    'index migration applies cleanly; re-run reports "No difference detected"), ' +
    '`pnpm db:seed`, `pnpm dev`.\n' +
    '- `pnpm test:coverage` — Vitest (real Postgres) over the AST/registry/compiler ' +
    '(operator matrix, injection fuzz, serialization round-trip) ≥90% per-file ' +
    'branch/fn/line.\n' +
    '- **Builder flow:** sign in as `zhuyue@motir.co` / `!QAZ1qaz` → /issues → the ' +
    '"Advanced" affordance beside the 2.5.4 facet bar (matching ' +
    '`design/work-items/filter-builder.mock.html`). Build: Status is any of (To do, In ' +
    'progress) AND Priority is none of (Lowest) AND Due in the next 14 days → the List ' +
    'shows the matching set + count; switch the combinator to Match any → the set widens ' +
    'accordingly; add "Story points > 5" and "Description contains oauth" rows → results ' +
    'track; the URL carries `?filter=v1:…` (reload + share-tab restores the exact builder ' +
    'state, composing with ?view/?sort/?page).\n' +
    '- **Negation/empty (the beyond-basic operators):** "Assignee is empty" and "Label is ' +
    'none of (perf-q3)" both compile and match correctly (the JQL-blacklist set works ' +
    'parser-free).\n' +
    '- **Epic-5 predicates:** filter by a select custom field (Severity is any of High), a ' +
    'number CF (Effort ≥ 3), a date CF (between), a user CF, a label, and a component — ' +
    'each via the indexed joins (EXPLAIN spot-check: index scans, no seq-scan over the ' +
    'value table); a deleted/archived referent in a shared URL degrades to the ' +
    '"unknown value" condition state, never a crash.\n' +
    '- **Both views:** the same filter applied in Tree mode retains ancestor context ' +
    '(muted non-matching ancestors — the 2.5.1 behaviour) with identical match sets; the ' +
    'List paginates the result at 50/page with the count.\n' +
    '- **Facet upgrade:** set kind+assignee in the quick facet bar → "Edit in Advanced" ' +
    'carries them in as rows losslessly; a builder state using OR/negation shows the ' +
    'facet bar as superseded (no silent down-conversion — the mirror rule).\n' +
    '- **Injection check:** the fuzz suite (quotes, SQL meta-chars, operator smuggling in ' +
    'values/field ids) produces parameterized queries only — assert via query logging that ' +
    'no user string reaches SQL unparameterized; malformed `?filter=` params yield the ' +
    'typed recoverable state.\n' +
    '- `pnpm test:e2e --grep filter-builder` — Playwright over the real stack: the build → ' +
    'results → URL round-trip → Epic-5-predicate journey.\n' +
    '- **a11y check:** the builder (rows, operator menus, per-type editors, combinator ' +
    'toggle) passes the strict axe sweep; fully keyboard-operable; colour via `--el-*`, ' +
    'shape via element tokens.',
  items: [
    {
      id: '6.1.1',
      title:
        'FilterAST + TOTAL operator registry + safe compiler (built-in fields) + versioned URL serialization + the trgm text index',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 32,
      dependsOn: [],
      descriptionMd:
        'The interchange shape and the compile path, over the BUILT-IN fields (everything ' +
        'shipped today: kind, status, priority, assignee, reporter, sprint, title/' +
        'description text, created/updated/due dates, story points, estimate). Pure ' +
        'backend + lib — no UI.\n\n' +
        "**`lib/filters/ast.ts`** — the typed `FilterAST` (`combinator: 'and'|'or'`, " +
        '`conditions: [{ field, operator, value }]`, row cap 20) + the **versioned URL ' +
        'codec** (`?filter=v1:<compact-json-base64url>`): encode/decode with typed, ' +
        'RECOVERABLE failures (a malformed/foreign param yields an "invalid filter" state ' +
        'object, never a throw into the page), composing with the shipped ' +
        '`?view/?sort/?page` params; a lossless upgrade map from the 2.5.4 facet params ' +
        'into AST rows (the basic→advanced conversion).\n\n' +
        '**`lib/filters/registry.ts`** — the per-field-type operator registry: every ' +
        'built-in field → its operator set + value-arity/validation + compile function + ' +
        'value-editor kind (the UI contract for 6.1.3/6.1.4). Operator semantics per the ' +
        'story description (enum is-any/none/empty; text contains/not; number ' +
        'comparisons; date absolute + between + relative-window + empty). **TOTAL** ' +
        '(mistake #29): unknown field/operator → typed 422; the registry test enumerates ' +
        "every entry's compile×validate×editor triple.\n\n" +
        '**The compiler** (repository layer per the 4-layer rule): AST → parameterized ' +
        'WHERE fragment — Prisma where-args where the shape allows, bound `$queryRaw` ' +
        'params where it does not (relative date windows, the trgm text match). NO string ' +
        'interpolation of user values or field/operator ids anywhere (ids resolve through ' +
        'the registry to fixed column references). The fragment slots into BOTH existing ' +
        'reads — `findProjectIssuesFlat`/`countProjectIssues` (the List + count) and the ' +
        '2.5.1 ancestor-retaining tree read — replacing/superseding the fixed ' +
        '`RepoIssueFilter` shape (which remains as the degenerate all-AND case so 2.5.4 ' +
        'facets keep working unchanged). **Migration:** a pg_trgm GIN index on ' +
        '`work_item(title, description)` for the contains-match (the finding-#57 ' +
        'no-table-scan guard).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The AST + codec round-trip property holds (every constructible AST encodes → ' +
        'decodes identically; fuzzed/malformed params yield the typed recoverable state); ' +
        'the facet→AST upgrade is lossless for every 2.5.4 facet combination.\n' +
        '- The registry is total over every built-in field with the specified operator ' +
        'sets; the enumeration test fails on any registry gap; unknown ids → 422.\n' +
        '- The compiler produces parameterized-only queries (the injection fuzz suite — ' +
        'quotes/meta-chars/smuggled operators in values AND field ids — asserts no user ' +
        'string reaches SQL raw, via query-log inspection); `and`/`or` combinators, ' +
        'negation, empty, comparisons, and relative date windows all compile correctly ' +
        '(matrix-tested against seeded data); both reads (flat + tree) accept the ' +
        'fragment with identical match sets.\n' +
        '- The trgm migration applies cleanly (re-run: no drift); EXPLAIN on a text ' +
        'contains over the large seed uses the index.\n' +
        '- Existing 2.5.4/2.5.8/2.5.12 behaviour is byte-identical (their tests ' +
        'untouched); `pnpm test:coverage` ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- `lib/issues/issueListFilter.ts` + `buildRepoFilter` + `RepoIssueFilter` ' +
        '(the shipped substrate this grows; the URL-param conventions)\n' +
        '- `workItemRepository.findProjectIssuesFlat` / the 2.5.1 tree read — the two ' +
        'consumers of the fragment\n' +
        '- The verified Jira basic/JQL operator split in the Story 6.1 description; ' +
        '`notes.html` mistake #29 (total registries)\n' +
        '- `motir-core/CLAUDE.md` (repo layer owns `$queryRaw`; FK/migration rules); ' +
        'finding #57 (the trgm index)',
    },
    {
      id: '6.1.2',
      title:
        'Epic-5 predicates — custom-field (per-type), label, and component conditions via the documented join contracts',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['6.1.1', '5.3.1', '5.4.1'],
      descriptionMd:
        'The registry + compiler extension consuming the contracts 5.3.1 / 5.4.1 ' +
        'documented for this story.\n\n' +
        '**Custom fields** — registry entries are DYNAMIC per project (the field list is ' +
        'data): each definition contributes a field entry keyed `cf:<fieldId>` with the ' +
        'operator set of its type (select → enum semantics over its options incl. ' +
        'archived ones for historical matching; user → enum over members; number/date/' +
        'text → their type sets). Compilation = the documented indexed JOIN per ' +
        'condition (`custom_field_value` on `[fieldId, valueOptionId|valueNumber|' +
        'valueDate|valueUserId]`; `is empty` = NOT EXISTS); multiple CF conditions ' +
        'compose under the combinator with one join apiece (aliased — no join collision; ' +
        'bounded by the 20-row cap).\n\n' +
        '**Labels / components** — `lbl`/`cmp` field entries with enum semantics ' +
        'compiling to EXISTS/NOT-EXISTS over `work_item_label`/`work_item_component` ' +
        '(the 5.4.1 indexed joins); `is empty` = no join rows.\n\n' +
        '**Stale-referent rule:** a condition referencing a deleted field/option/label/' +
        'component id (a shared or saved URL outliving the data) resolves to the typed ' +
        '"unknown value" condition — matches nothing, surfaces a per-row notice, never ' +
        'errors the query (the durable behaviour 6.2 saved filters depend on).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Every CF type filters correctly through its indexed join (EXPLAIN spot-checks ' +
        'on the large seed: index scans); select matching includes archived-option ' +
        'values; `is empty` semantics verified per type; multi-CF + label + component ' +
        'conditions compose under both combinators without join collisions.\n' +
        '- Label/component conditions match the 5.4 join data incl. negation + empty; ' +
        "the project's dynamic field entries appear/disappear with definitions " +
        '(registry totality preserved — the enumeration test covers the dynamic ' +
        'entries).\n' +
        '- Stale referents degrade to unknown-value (match-nothing + notice), asserted ' +
        'for field/option/label/component deletion each; injection fuzz extended over ' +
        'the dynamic ids.\n' +
        '- `pnpm test:coverage` ≥90% on the extension.\n\n' +
        '## Context refs\n\n' +
        '- The 5.3.1 predicate contract (typed-EAV columns + `[fieldId, value*]` indexes ' +
        '+ the JOIN sketch) and the 5.4.1 label/component join contract — written for ' +
        'this subtask\n' +
        '- 6.1.1 registry/compiler (the extension points)\n' +
        '- `customFieldsService` reads (5.3.2/5.3.3) for definitions/options; ' +
        '`labelsService`/`componentsService` reads (5.4.2/5.4.3) for values\n' +
        '- The stale-referent rule in the Story 6.1 description (the 6.2 dependency)',
    },
    {
      id: '6.1.3',
      title:
        'Design — the filter builder (`design/work-items/filter-builder.mock.html`: rows, combinator, operator menus, per-type editors, applied state)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 38,
      dependsOn: [],
      descriptionMd:
        'The design asset for the advanced surface. `filter.mock.html` (2.5.9) designs ' +
        'ONLY the basic facet popover — the builder is undesigned (the design-gate ' +
        'NONE-exists case). Output: **`design/work-items/filter-builder.mock.html`** + ' +
        'PNG + a design-notes section. Render checklist + AA + dark parity. Mirrors: ' +
        "Jira basic's field/value vocabulary for the editors; the flat-rows builder " +
        "shape (Linear's filter editor is the closest structured-builder reference) " +
        'for what Jira only offers as JQL.\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **Entry + coexistence** — the "Advanced" affordance beside the shipped ' +
        '`[Filter]` facet button in the `/issues` toolbar; the rule drawn explicitly: ' +
        'facets upgrade INTO the builder ("Edit in Advanced" carries them as rows); an ' +
        'advanced state beyond facet expressiveness shows the facet button as ' +
        'superseded (badge + tooltip), never silently down-converts (the verified ' +
        'one-way mirror rule).\n' +
        '- **The builder surface** — an anchored panel (the popover/card chrome): the ' +
        '**combinator control** ("Match all / Match any" — a segmented control reading ' +
        'as a sentence: "Match ALL of the following"), the **condition rows** (field ' +
        'picker → operator picker → value editor, each a Combobox-vocabulary control; ' +
        'row remove ×; the 20-row cap state), **Add condition**, **Clear all**, and ' +
        'live-apply (no Apply button — the 2.5.4 precedent; the URL updates as rows ' +
        'complete).\n' +
        '- **Per-type value editors** — enum fields: the 5.4.6 `MultiSelectPicker` ' +
        '(members with avatars, statuses with dots, kinds with type icons, labels, ' +
        'components, CF options incl. the archived mark); text: input; number: numeric ' +
        'input (+ the comparison operator already chosen in the row); date: the shipped ' +
        '`DatePicker` for absolute/between + a small stepper for the relative "in the ' +
        'last/next N days" forms; empty/not-empty operators collapse the value editor.\n' +
        '- **Incomplete-row behaviour** — a row missing its value is drawn pending ' +
        '(muted, excluded from the applied filter + count) — the live-apply rule needs ' +
        'this state pinned.\n' +
        '- **Applied state** — the toolbar summary (the active-filter ring + count ' +
        'badge extending the 2.5.4 grammar; a compact row-chip readout), the result ' +
        'count line, zero-results (the empty state + "Clear all"), and the ' +
        '**stale/unknown-value row** (the deleted-referent notice on a shared URL) + ' +
        'the **invalid-param recovery** state.\n' +
        '- **Both views** — the builder applied over the List (the navigator result) ' +
        'and the Tree (muted ancestor retention — reference the shipped behaviour, ' +
        "don't redraw it).\n\n" +
        '## Acceptance criteria\n\n' +
        '- The mockup + PNG + notes exist, composed from shipped primitives ' +
        '(`Combobox`, `MultiSelectPicker`, `DatePicker`, the 2.5.4 toolbar grammar) + ' +
        'token tiers; render checklist + AA + dark parity pass.\n' +
        '- Panels cover: entry/coexistence + the upgrade + superseded states, the ' +
        'builder (combinator, rows for EVERY editor kind, add/remove/clear, cap, ' +
        'pending rows), the applied summary + count + zero-results, ' +
        'stale-referent + invalid-param states, and the List/Tree applied views.\n' +
        '- `design-notes.md` names the editor-kind ↔ registry mapping (the 6.1.1 UI ' +
        'contract), the live-apply + pending-row rules, and records the one-way ' +
        'facet→builder conversion + the no-nested-groups extension slot.\n' +
        '- No improvised primitive; token needs recorded.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/filter.mock.html` + notes (2.5.9) — the facet grammar ' +
        'this extends; `list.mock.html` (the toolbar + result surface)\n' +
        '- The 5.4.6 `MultiSelectPicker` design (the enum editor); the shipped ' +
        '`DatePicker`/`Combobox`\n' +
        '- The verified Jira basic/JQL split + date-picker forms in the Story 6.1 ' +
        'description\n' +
        '- Findings #35/#54; the design-mockup render checklist',
    },
    {
      id: '6.1.4',
      title:
        'Filter-builder UI on /issues — built-in fields (rows, combinator, live-apply URL state, facet upgrade, applied summary)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: ['6.1.1', '6.1.3'],
      descriptionMd:
        'The builder surface for the built-in fields, per the 6.1.3 design, on the ' +
        '6.1.1 AST/codec/registry.\n\n' +
        '**Build** (extending the 2.5.3 `IssueListToolbar` + 2.5.4 `IssueFilterBar` ' +
        'area): the Advanced entry + panel; condition rows driven BY THE REGISTRY (field ' +
        "picker lists the registry's built-in entries; choosing a field populates its " +
        'operator set; the operator selects the value-editor kind — the UI renders the ' +
        'registry, it never hard-codes field lists); the combinator control; ' +
        'add/remove/clear + the row cap; **live-apply with pending-row exclusion** (the ' +
        'designed rule) writing the `?filter=v1:` param (composing with ' +
        '`?view/?sort/?page`, Suspense-keyed like the shipped params); the **facet ' +
        'upgrade** ("Edit in Advanced" → lossless rows) + the superseded-facet state; ' +
        'the applied toolbar summary + count; zero-results; the invalid-param recovery ' +
        'state. Both views consume the compiled filter through their existing reads ' +
        '(no view-specific query code here). Strings via next-intl.\n\n' +
        '**A11y:** rows are labelled groups; every picker keyboard-complete (the ' +
        'Combobox bar); the combinator reads as a sentence for SR users; the applied ' +
        'count announced; extends the /issues strict sweep.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The builder matches the design panel-for-panel for every built-in editor ' +
        'kind; rows render from the registry (a registry addition appears with zero UI ' +
        'changes — asserted with a test-only registry entry).\n' +
        '- Live-apply + pending exclusion + URL round-trip (reload/share restores ' +
        'state; composes with view/sort/page); the facet upgrade is lossless; the ' +
        'superseded state appears exactly when the AST exceeds facet expressiveness.\n' +
        '- Both views show identical match sets (spot E2E); count + zero-results + ' +
        'invalid-param states work.\n' +
        '- Axe-clean; token tiers only; next-intl; integration tests over the ' +
        'row/registry wiring + URL codec round-trip in the browser; coverage ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/filter-builder.mock.html` + notes (6.1.3) — THE ' +
        'authority\n' +
        '- 6.1.1 (AST/codec/registry — the UI contract); `IssueListToolbar`/' +
        '`IssueFilterBar` (2.5.3/2.5.4 — the surface this extends)\n' +
        '- The URL-driven param conventions (2.5.8 `?view`, 2.5.12 `?page`)\n' +
        '- The i18n threading pattern',
    },
    {
      id: '6.1.5',
      title:
        'Epic-5 rows in the builder — custom-field / label / component conditions (dynamic field entries, per-type editors, stale states)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['6.1.2', '6.1.4', '5.4.8'],
      descriptionMd:
        'The builder rows for the Epic-5 surfaces, on the 6.1.2 dynamic registry ' +
        'entries.\n\n' +
        "**Build:** the field picker grows the project's dynamic entries (custom " +
        'fields under a labelled group with their type glyphs — the 5.3.4 glyph map; ' +
        "Labels; Components); per-type value editors reuse the owners' vocabulary — " +
        'CF select options (archived marked, the 5.3.5 grammar), CF user → the member ' +
        'picker, CF number/date/text → the 6.1.4 editors, labels/components → the ' +
        '5.4.8 `MultiSelectPicker` fed by their bounded reads; the **stale/' +
        'unknown-value row state** (deleted referent in a shared URL → the designed ' +
        'notice, condition matches nothing); definitions changing under an open ' +
        "builder degrade gracefully (a removed field's row goes stale, not crashed).\n\n" +
        '## Acceptance criteria\n\n' +
        '- Every CF type + labels + components is buildable end-to-end (pick field → ' +
        'operators per type → designed editor → live results via the indexed joins); ' +
        "the dynamic entries track the project's definitions.\n" +
        '- Stale-referent rows render the designed notice and match nothing; a field ' +
        'deleted mid-session degrades the open row gracefully.\n' +
        '- URL round-trip covers dynamic conditions (shared links restore or go ' +
        'stale-typed); axe-clean; token tiers only.\n' +
        '- Integration tests over each editor kind + the stale paths; coverage ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- 6.1.2 (dynamic registry entries + stale rule); 6.1.4 (the row surface)\n' +
        '- The 5.3.5 rail-editor grammar + 5.3.4 glyph map; the 5.4.8 ' +
        '`MultiSelectPicker` + bounded reads\n' +
        '- `design/work-items/filter-builder.mock.html` (the CF/label/component ' +
        'panels)\n' +
        '- finding #57 (bounded option reads)',
    },
    {
      id: '6.1.6',
      title:
        'Story tests — compile-correctness matrix + injection fuzz + serialization properties + the build-a-filter E2E + a11y sweep',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['6.1.4', '6.1.5'],
      descriptionMd:
        'The story-closing verification (Principle #18; the 5.x split — the epic-wide ' +
        'journey stays Story 6.7).\n\n' +
        '**Vitest (integration, real Postgres):** the **compile-correctness matrix** — ' +
        'every (field-type × operator) cell against seeded data with known expected ' +
        'sets, under BOTH combinators, incl. relative date windows (frozen clock), ' +
        'empty/negation semantics, multi-CF join composition, and the tree-read parity ' +
        'cases (flat and tree match sets identical per AST); the **injection fuzz ' +
        'suite** (meta-chars, quote-smuggling, operator/field-id forgery, oversized ' +
        'ASTs → 422s; query-log assert: zero unparameterized user strings); the ' +
        '**serialization properties** (AST↔URL round-trip for generated ASTs; ' +
        'malformed-param recovery; facet-upgrade losslessness); the stale-referent ' +
        'matrix (deleted field/option/label/component each).\n\n' +
        '**Playwright E2E (`tests/e2e/filter-builder.spec.ts`):** the recipe journey — ' +
        'build the multi-row mixed filter (incl. a CF row + a label row + negation + ' +
        'a relative date), assert results + count, flip the combinator, round-trip ' +
        'the URL in a fresh context, upgrade from facets, hit zero-results + Clear ' +
        'all, and verify the Tree shows the same set with muted ancestors. **a11y:** ' +
        'the strict axe sweep over the open builder (every editor kind open once) + ' +
        'the applied state.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The matrix covers every registry cell (driven FROM the registry — a new ' +
        'entry without a matrix case fails the suite, the totality-guard pattern); ' +
        'fuzz + property suites green; tree/flat parity holds.\n' +
        "- The E2E journey passes green in CI's Playwright lane; the sweep reports " +
        'zero violations.\n' +
        '- The Story 6.1 verification recipe runs clean top to bottom; ' +
        '`pnpm test:coverage` keeps all 6.1 files ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- The 5.5.1/6.1.1 totality-guard pattern (matrix driven from the registry)\n' +
        '- `tests/integration/` + `tests/e2e/` conventions; the harness/selector ' +
        'memories\n' +
        '- The Story 6.1 verification recipe — the checklist this automates\n' +
        '- Story 6.7 (the epic-wide remainder — do not duplicate)',
    },
  ],
};
