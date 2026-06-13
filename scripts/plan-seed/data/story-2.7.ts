import type { PlanStory } from '../types';

/**
 * Story 2.7 — Work-item TYPE + EXECUTOR model. The story that turns a piece of
 * planning PROSE into a structural, queryable, dispatch-routing field. Today the
 * seed loader writes "Type: code" / "Executor: coding_agent" as free text in the
 * description (see every leaf in story-7.1.ts / story-7.3.ts: `type` + `executor`
 * already live on `PlanItem`, but they have NOWHERE structural to land — they are
 * stringified into prose). This story adds the real columns, the picker UI, and
 * the filter integration so `type`/`executor` become first-class.
 *
 * **The taxonomy (CONFIRMED 2026-06-12 with Yue; baked into 2.7.2's decision).**
 * A FIXED `WorkItemType` enum — DISTINCT from `kind` (epic/story/task/bug/subtask)
 * and carried only on executable LEAVES (task / subtask / bug — NOT epic/story):
 *
 *   code · design · test · content (copy/docs/translate) · research
 *   (spike/investigation) · review (QA) · decision · deploy (infra/ops) ·
 *   manual (human SaaS/dashboard/provisioning) · chore
 *
 * Ten members, fixed so Story 7.6's per-type prompt generator can be a TOTAL
 * function over the enum (a `switch` with no `default` hole). Plus an `executor`
 * enum (`coding_agent | human`) with a type→executor DEFAULT map, OVERRIDABLE at
 * pick time:
 *
 *   code / test / deploy            → coding_agent
 *   manual / decision / review      → human
 *   design / content / research / chore → either (default coding_agent)
 *
 * `type` is NULLABLE — legacy rows + every epic/story row stay `null`; the picker
 * defaults sensibly per kind, and the type→executor default seeds `executor` when
 * a type is first chosen. Fixed enum now, extensible later — NOT free text (free
 * text would defeat the 7.6 total-function guarantee + the type filter facet).
 *
 * **WHY a type DISTINCT from kind — the Principle-#11 justified deviation
 * (VERIFIED mirror, not asserted).** In Jira the "issue type" IS the kind
 * hierarchy — epic / story / task / sub-task / bug — and that is the ONLY native
 * type axis (Atlassian "What are work types?": software spaces ship bug / story /
 * task standard types + sub-task; custom types still slot into that same
 * Epic → {story,task,bug} → sub-task hierarchy). Routing WHO executes a piece of
 * work is done in Jira through the **assignee field**, not a sub-type: with Rovo,
 * "you can add an agent to the assignee field," so an AI agent "shows up as an
 * assignee, with the same fields and patterns" a human would
 * (support.atlassian.com — "Collaborate on work items with AI agents"). So Jira
 * has NO native executor sub-type orthogonal to the issue-type hierarchy — the
 * routing signal is overloaded onto assignee. Motir's `type` (what KIND of work:
 * code vs design vs decision) + `executor` (WHO: coding_agent vs human) is a
 * deliberate deviation with a concrete, load-bearing use case: the Epic-7 AI
 * dispatch layer (7.6 prompt generation, the eventual native executor) routes by
 * `type` to pick the right prompt template and by `executor` to decide
 * coding-agent-dispatch vs human-assignment — a structural axis Jira's
 * kind-as-type + assignee-as-router shape cannot express without overloading two
 * fields. (Principle #11: deviate from the mirror only with a recorded concrete
 * justification — recorded here + in 2.7.2.)
 *
 * **Where this sits in Epic 2.** Epic 2 owns the `work_item` core (kind-parent
 * grammar, workflow status, the create modal + detail rail). 2.7 ADDS to that
 * core two new structural fields + their UI affordances; it does not touch the
 * AI layer (Epic 7) beyond making `type` the field 7.6's total-function generator
 * keys off. The seed loader (2.7.5) is the bridge: it stops emitting `type` /
 * `executor` as description prose and maps them to the new columns — so the very
 * plan modules in `scripts/plan-seed/data/` that carry `type`/`executor` per leaf
 * become the first consumers of the structured fields.
 *
 * **The design gate fires (Principle #13).** The type + executor picker is a NEW
 * element on TWO existing surfaces — the issue create modal and the detail rail —
 * so the FIRST subtask (2.7.1) is a `design` card producing
 * `design/work-items/*.mock.html` + `design-notes.md`, and every UI-touching code
 * subtask (2.7.4) depends on it and is `blocked` behind it.
 *
 * **Dependency / status audit (notes.html #32): PASSES.** Every `dependsOn` id is
 * a same-story 2.7.x id (no forward-pointing, no cross-epic dep — the field is
 * pure Epic-2 schema work; Epic 7 consumes it later, not the reverse). Per the
 * status rule: the two cards with `dependsOn: []` — the design gate (2.7.1) and
 * the taxonomy decision (2.7.2) — are `planned`; everything chained behind them is
 * `blocked` until they merge.
 */
export const story_2_7: PlanStory = {
  id: '2.7',
  title: 'Work-item type + executor',
  status: 'planned',
  gitBranch: 'feat/PROD-2.7-work-item-type-executor',
  descriptionMd:
    'Promote two pieces of planning metadata from PROSE to STRUCTURE: a ' +
    'work-item **type** (what KIND of work — `code` / `design` / `test` / ' +
    '`content` / `research` / `review` / `decision` / `deploy` / `manual` / ' +
    '`chore`) and an **executor** (WHO does it — `coding_agent` or `human`). ' +
    'Today the plan-seed loader stringifies these into each leaf’s description ' +
    '("Type: code", "Executor: coding_agent"); this story makes them real ' +
    '`work_item` fields with a picker, a filter facet, and a type→executor ' +
    'default map.\n\n' +
    '**The model (locked — see the module header for the full rationale):**\n\n' +
    '- **`type`** — a FIXED `WorkItemType` enum (ten members), DISTINCT from ' +
    '`kind`, carried only on executable LEAVES (task / subtask / bug). ' +
    'NULLABLE: every epic/story row + every legacy row stays `null`. Fixed (not ' +
    'free text) so Story 7.6’s per-type prompt generator is a TOTAL function ' +
    'over it and the filter facet is a closed set.\n' +
    '- **`executor`** — `coding_agent | human`, with a type→executor DEFAULT ' +
    '(`code`/`test`/`deploy` → coding_agent; `manual`/`decision`/`review` → ' +
    'human; `design`/`content`/`research`/`chore` → either, default ' +
    'coding_agent), seeded when a type is first chosen and OVERRIDABLE.\n' +
    '- **The justified deviation from the Jira mirror (Principle #11).** Jira’s ' +
    'issue type IS the kind hierarchy (epic/story/task/sub-task/bug) and routes ' +
    'WHO executes via the assignee field (an AI agent "shows up as an ' +
    'assignee"). Motir splits the axes — `type` (what work) + `executor` (who) ' +
    '— for one concrete use case: the Epic-7 AI dispatch layer routes by `type` ' +
    '(prompt template) and `executor` (agent-dispatch vs human-assign). ' +
    'Recorded in 2.7.2.\n\n' +
    '**Scope:** the picker design under `design/work-items/` (2.7.1); the ' +
    'taxonomy + default-map decision (2.7.2); the schema — enum + nullable ' +
    'column + executor field + migration + the default helper (2.7.3); the ' +
    'picker UI on the create modal + detail rail (2.7.4); the seed-loader ' +
    'mapping that stops emitting type/executor as prose (2.7.5); the Epic-6 ' +
    'FilterAST `type` facet (2.7.6); vitest (2.7.7); and the create-typed-item + ' +
    'filter-by-type E2E (2.7.8).\n\n' +
    '**Out of scope (named so they land where they belong):** the per-type ' +
    'PROMPT generation that keys off `type` (Story 7.6); the AI dispatch surface ' +
    'that routes by `executor` (Story 7.6 / 7.7); any change to the kind-parent ' +
    'grammar (`type` is orthogonal to `kind` and never affects parenting).',
  verificationRecipeMd:
    '- Pull the Story branch; run `pnpm prisma migrate dev` (clean — the new ' +
    'enum + nullable column + executor field apply with no drift) and ' +
    '`pnpm db:seed`.\n' +
    '- **The seed is now structured (the loader bridge).** After re-seeding, ' +
    'open a few `PROD` leaves: the type + executor are rendered as CHIPS from ' +
    'the structured fields, and the description body NO LONGER contains the ' +
    '"Type:" / "Executor:" prose lines (2.7.5 stopped emitting them). Epics and ' +
    'stories show NO type chip (`type` is leaf-only → `null` there).\n' +
    '- **Create-modal + detail picker (the design-gated UI).** Open the issue ' +
    'create modal: the type picker offers exactly the ten taxonomy members with ' +
    'their per-type hue (the `--el-type-*`/`IssueTypeIcon` treatment), and ' +
    'choosing a type SEEDS the executor per the default map (e.g. picking ' +
    '`code` selects `coding_agent`; picking `manual` selects `human`), still ' +
    'OVERRIDABLE. Create a `code`/`coding_agent` task and a `manual`/`human` ' +
    'one; on the detail rail the type chip + executor indicator render and are ' +
    'editable inline. A type override persists; a kind that is epic/story shows ' +
    'no type control.\n' +
    '- **Filter by type (Epic-6 integration).** On /issues, the filter builder ' +
    'now offers `type` as a facet over the shipped 6.1.1 FilterAST; filtering ' +
    '`type = manual` returns exactly the manual leaves, and `type = code OR ' +
    'type = test` composes; a saved view round-trips the `type` predicate.\n' +
    '- `pnpm test` — 2.7.7 covers: the type→executor default helper for every ' +
    'enum member; the schema (enum values, `type` nullable, leaf-only ' +
    'enforcement); the picker default-seeding + override; the loader mapping ' +
    '(structured fields set, prose absent); and the FilterAST `type` predicate ' +
    'round-trip. New service/repo code respects the per-file coverage gate ' +
    '(`motir-core/CLAUDE.md` § coverage).\n' +
    '- **The mirror deviation is honest.** Confirm 2.7.2’s decision records the ' +
    'verified Jira mirror (issue-type = kind; executor routing = assignee, ' +
    'NOT a sub-type) and the concrete Epic-7-dispatch justification — the ' +
    'Principle-#11 paper trail.\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up Subtask ' +
    'under the same Story.',
  items: [
    {
      id: '2.7.1',
      title: 'Design — the type + executor picker on the create modal + the detail rail',
      status: 'in_progress',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        '**Type:** design (the planning-time design gate, Principle #13 + the ' +
        'design-reference rule). The picker UI (2.7.4) depends on this card; ' +
        'without it the new type/executor element would be improvised onto two ' +
        'existing surfaces, which is forbidden (notes.html #31).\n\n' +
        'Produce the design asset for the **work-item type + executor picker** ' +
        'under `motir-core/design/work-items/`. Author it as a `*.mock.html` ' +
        'mockup built from the real design system (the shipped ' +
        '`components/ui/*` primitives + the `--el-*` colour tokens + the ' +
        '`[data-display-style]` shape tokens) — NOT a `.pen`. The HTML route is ' +
        'preferred when a coding agent produces the design (no translation gap; ' +
        'the reviewer sees the actual tokens). A PNG export is optional; the ' +
        '`.mock.html` is the source of truth (MOTIR.md § Design-reference rule).' +
        '\n\n' +
        '**Mirror (VERIFIED — Atlassian).** In Jira the issue-type control IS ' +
        'the kind hierarchy and routing-who is the ASSIGNEE field (an AI agent ' +
        '"shows up as an assignee"). Motir adds a NEW, separate type+executor ' +
        'control alongside the existing kind/assignee affordances — draw it so ' +
        'it reads as a sibling of the type-icon area, NOT a replacement for ' +
        'kind. The per-type hue mirrors the shipped `IssueTypeIcon` treatment ' +
        '(a per-kind hue already exists — extend the same idea to the ten ' +
        'TYPE members via `--el-type-*`-style tokens).\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the ' +
        'multi-panel rule, mistake #31):\n\n' +
        '- **Panel 1 — the type picker on the CREATE MODAL.** A dropdown / ' +
        'combobox offering exactly the ten taxonomy members (`code`, `design`, ' +
        '`test`, `content`, `research`, `review`, `decision`, `deploy`, ' +
        '`manual`, `chore`), each row a per-type hued chip + label. Show that ' +
        'it appears only when the chosen KIND is a leaf (task/subtask/bug) and ' +
        'is ABSENT for epic/story. Show the empty/unset state (`type` may be ' +
        'left null).\n' +
        '- **Panel 2 — the executor control + the default-seeding behaviour.** ' +
        'The `coding_agent | human` toggle/segmented control sitting next to ' +
        'the type picker, and the COPY/affordance showing that choosing a type ' +
        'SEEDS the executor from the default map (e.g. `code` → coding_agent, ' +
        '`manual` → human) while leaving it overridable. Draw both the ' +
        'agent-selected and human-selected states.\n' +
        '- **Panel 3 — the type chip + executor indicator on the DETAIL ' +
        'RAIL.** How a typed item reads on the issue detail: a type chip (hued, ' +
        'like an `IssueTypeIcon`-adjacent chip) + a compact executor indicator ' +
        '(an agent vs person glyph), each inline-EDITABLE (click → the same ' +
        'picker). Show a leaf WITH a type and a leaf with `type = null` (the ' +
        '"set a type" affordance).\n' +
        '- **Panel 4 — the ten-type legend + hue map.** A reference panel ' +
        'showing every type member with its hue + its executor default, so the ' +
        'palette is decided once (the per-type `--el-type-*` role each chip ' +
        'uses — AA contrast: hue in the chip BACKGROUND with ' +
        '`--el-text-strong`, finding #35; never a page-level tint).\n\n' +
        'Also write **`design/work-items/design-notes.md`** naming the exact ' +
        'primitives used per surface (the `Combobox`/`DropdownMenu`, `Pill`/ ' +
        'chip, the segmented control, `IssueTypeIcon` adjacency), the exact ' +
        'copy strings (the ten labels + the executor labels + the "set a type" ' +
        'empty copy), the placement decisions on each surface, the per-`--el-*` ' +
        'colour role for each element (incl. each per-type hue + the executor ' +
        'glyph colours), and a "primitives composed (no hand-rolling)" ' +
        'checklist (the `design-notes.md` convention 1.3.3 / 1.5.1 / 7.0.1 ' +
        'established).\n\n' +
        '**Branch.** `design/PROD-2.7.1-type-executor-picker`. The `design/*` ' +
        'prefix gate skips CI E2E + the Vercel preview deploy (MOTIR.md ' +
        '§ Plan-seed Workflow) — this PR only edits `design/work-items/**`, no ' +
        'app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/work-items/type-executor-picker.mock.html` ' +
        'exists, renders the four panels above, and references ONLY `--el-*` ' +
        'tokens + `[data-display-style]` shape tokens (no Tier-0 `--color-*`, ' +
        'no hand-rolled spacing — the `motir-core/CLAUDE.md` § colour / shape ' +
        'rules).\n' +
        '- `motir-core/design/work-items/design-notes.md` exists, names every ' +
        'primitive composed + every copy string + the per-element `--el-*` role ' +
        '(incl. the ten per-type hues + the executor-default behaviour).\n' +
        '- The mock shows the type picker as LEAF-ONLY (absent for epic/story), ' +
        'the type-null/unset state, the executor default-seeding-then-override ' +
        'behaviour, and the editable detail-rail chip + indicator.\n' +
        '- The mockup composes ONLY shipped primitives (`Combobox` / ' +
        '`DropdownMenu`, `Pill`, the segmented control, `IssueTypeIcon`) — if a ' +
        'genuinely new primitive is needed, that is a NEW `design/` subtask, ' +
        'not a code workaround.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/work-items/` — the existing design area for the ' +
        'create modal + detail rail (mirror its layout + `design-notes.md` ' +
        'shape; the picker is a NEW element ON these surfaces).\n' +
        '- `motir-core/components/issues/IssueTypeIcon.tsx` — the per-KIND hue ' +
        'pattern the per-TYPE hue extends (`--el-type-*`).\n' +
        '- `motir-core/components/ui/Pill.tsx`, the `DropdownMenu`/`Combobox` ' +
        'primitive, the segmented-control primitive — the composable surface.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` colour + ' +
        '`[data-display-style]` shape tokens (the swap layer the mock ' +
        'references; the per-type hue tier is added here in 2.7.4).',
      dependsOn: [],
    },
    {
      id: '2.7.2',
      title: 'Decision — the WorkItemType taxonomy + the type→executor default map',
      status: 'done',
      type: 'decision',
      executor: 'coding_agent',
      estimateMinutes: 35,
      descriptionMd:
        '**Type:** decision (the ADR that fixes the taxonomy 2.7.3’s enum, ' +
        '2.7.4’s picker, 2.7.5’s loader mapping, 2.7.6’s filter facet, and — ' +
        'downstream — Story 7.6’s prompt generator all build against). No app ' +
        'behaviour ships here, but the set it freezes is load-bearing.\n\n' +
        'Write `motir-core/docs/decisions/work-item-type-taxonomy.md` (mirror ' +
        'the repo’s ADR convention). It MUST fix:\n\n' +
        '1. **The fixed `WorkItemType` enum (ten members).** `code` · ' +
        '`design` · `test` · `content` (copy/docs/translate) · `research` ' +
        '(spike/investigation) · `review` (QA) · `decision` · `deploy` ' +
        '(infra/ops) · `manual` (human SaaS/dashboard/provisioning) · `chore`. ' +
        'Record a one-line scope for each so the picker labels + the 7.6 prompt ' +
        'templates have an authoritative gloss. FIXED, not free text — so 7.6’s ' +
        'per-type generator is a TOTAL function (a `switch` with no `default` ' +
        'hole) and the 2.7.6 filter facet is a closed set; extensible later by ' +
        'an explicit enum addition + migration, never ad-hoc strings.\n' +
        '2. **`type` is DISTINCT from `kind` and LEAF-ONLY.** `kind` ' +
        '(epic/story/task/subtask/bug) is the structural hierarchy; `type` is ' +
        'the NATURE of executable work and is carried ONLY on leaves ' +
        '(task/subtask/bug). Epics + stories + legacy rows are `type = null`.\n' +
        '3. **The `executor` enum + the type→executor DEFAULT map.** `executor ' +
        '∈ { coding_agent, human }`. Default map: `code`/`test`/`deploy` → ' +
        'coding_agent; `manual`/`decision`/`review` → human; ' +
        '`design`/`content`/`research`/`chore` → either, default coding_agent. ' +
        'The default SEEDS `executor` when a type is first chosen and is ' +
        'OVERRIDABLE; record the map as the single source 2.7.3’s helper ' +
        'encodes.\n' +
        '4. **The Jira-mirror deviation (Principle #11 — the honest paper ' +
        'trail).** Record the VERIFIED mirror: in Jira the "issue type" IS the ' +
        'kind hierarchy (epic/story/task/sub-task/bug — Atlassian "What are ' +
        'work types?"), and routing WHO executes is done via the ASSIGNEE field ' +
        '— with Rovo "you can add an agent to the assignee field," so an AI ' +
        'agent "shows up as an assignee, with the same fields and patterns" ' +
        '(support.atlassian.com — "Collaborate on work items with AI agents"). ' +
        'Jira therefore has NO native executor sub-type orthogonal to ' +
        'issue-type. Motir’s separate `type` + `executor` axes are a DELIBERATE ' +
        'deviation justified by a concrete use case: the Epic-7 AI dispatch ' +
        'layer routes by `type` (which prompt template) and `executor` ' +
        '(coding-agent dispatch vs human assignment) — a structural axis the ' +
        'kind-as-type + assignee-as-router shape cannot express without ' +
        'overloading two fields.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/docs/decisions/work-item-type-taxonomy.md` exists and ' +
        'fixes all four sections: the ten-member enum with per-member gloss, ' +
        'the leaf-only + distinct-from-kind + nullable rule, the executor enum ' +
        '+ the full type→executor default map, and the cited Principle-#11 ' +
        'deviation.\n' +
        '- The default map is recorded as an explicit table (the single source ' +
        '2.7.3’s helper implements) — every one of the ten types has a default ' +
        'executor.\n' +
        '- The Jira mirror is CITED (issue-type = kind; executor = assignee, ' +
        'NOT a sub-type), with the concrete Epic-7-dispatch justification — not ' +
        'asserted (notes.html #33: verify the mirror, cite what was observed).' +
        '\n\n' +
        '## Context refs\n\n' +
        '- This module header (the locked taxonomy + the deviation rationale).' +
        '\n' +
        '- `scripts/plan-seed/types.ts` — `PlanItem.type` / `PlanItem.executor` ' +
        '(the plan-side fields already carrying these values as the loader ' +
        'input 2.7.5 maps).\n' +
        '- Atlassian Support — "What are work types?" (issue-type = the kind ' +
        'hierarchy) + "Collaborate on work items with AI agents" (agent ' +
        'routing via the assignee field) — the cited mirror.\n' +
        '- Story 7.6 (stub) — the per-type prompt generator whose total-function ' +
        'guarantee this fixed enum exists to support.',
      dependsOn: [],
    },
    {
      id: '2.7.3',
      title:
        'Schema — WorkItemType enum + nullable work_item.type + executor field + migration + default helper',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'Make the taxonomy structural. Add to `prisma/schema.prisma` the ' +
        'fields 2.7.2 froze, with a clean migration and the default helper the ' +
        'picker + loader both consume. 4-layer (`motir-core/CLAUDE.md`): the ' +
        'enum + columns are Prisma; the default helper is a pure ' +
        '`lib/issues/*` function; any read/write of the new fields flows ' +
        'Route → Service → Repository.\n\n' +
        '- **`enum WorkItemType`** — the ten members exactly as 2.7.2 fixed ' +
        '(`code`, `design`, `test`, `content`, `research`, `review`, ' +
        '`decision`, `deploy`, `manual`, `chore`).\n' +
        '- **`enum Executor`** — `coding_agent`, `human`.\n' +
        '- **`work_item.type WorkItemType?`** — NULLABLE (epics/stories + ' +
        'legacy rows = null). Leaf-only is a SEMANTIC rule the service enforces ' +
        '(see below), not a DB constraint a column can express; the column ' +
        'itself is simply nullable.\n' +
        '- **`work_item.executor Executor?`** — nullable; set alongside `type` ' +
        '(seeded from the default map when a type is chosen).\n' +
        '- **The default helper** `lib/issues/executorDefaults.ts` — a pure ' +
        '`defaultExecutorForType(type: WorkItemType): Executor` encoding ' +
        '2.7.2’s map exactly (a TOTAL function over the enum — no `default` ' +
        'branch hole), plus `isLeafType`-style guards. This is the SINGLE ' +
        'source the picker (2.7.4) + the loader (2.7.5) call — neither ' +
        're-states the map.\n' +
        '- **Leaf-only enforcement** in `workItemsService` (the write ' +
        'authority): reject (typed error) any attempt to set `type`/`executor` ' +
        'on an epic/story kind; allow it on task/subtask/bug. Keep it a service ' +
        'validation (the kind-parent grammar already lives there), not a ' +
        'trigger.\n\n' +
        '**Migration hygiene (`motir-core/CLAUDE.md` § migrations).** The new ' +
        'columns are plain nullable enum columns — no FK — so no `@relation` ' +
        'concern; but run `prisma migrate dev` and confirm "No difference ' +
        'detected" on a second run (no drift). The enums + columns must be ' +
        'authored in `schema.prisma` (not raw-SQL-only) so the schema graph + ' +
        'the migration-built DB stay in sync.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `prisma/schema.prisma` declares `enum WorkItemType` (the ten ' +
        'members) + `enum Executor` + nullable `work_item.type` + ' +
        '`work_item.executor`; `pnpm prisma migrate dev` applies cleanly and a ' +
        'second `migrate dev` reports no drift.\n' +
        '- `lib/issues/executorDefaults.ts` exports a TOTAL ' +
        '`defaultExecutorForType` over every enum member matching 2.7.2’s map ' +
        'exactly (verified by 2.7.7).\n' +
        '- `workItemsService` rejects setting `type`/`executor` on an ' +
        'epic/story with a typed error, and permits it on task/subtask/bug; the ' +
        '4-layer split is respected (route → service → repository → Prisma; the ' +
        'write goes through `workItemsService`, never raw Prisma in a route).\n' +
        '- Existing rows are unaffected (the column is nullable; the migration ' +
        'back-fills nothing — 2.7.5 sets values via re-seed).\n\n' +
        '## Context refs\n\n' +
        '- 2.7.2 — the taxonomy + default map this encodes.\n' +
        '- `motir-core/prisma/schema.prisma` — the `work_item` model + the ' +
        'existing `kind` enum (the sibling axis `type` is distinct from).\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the write authority ' +
        'where leaf-only enforcement lives.\n' +
        '- `motir-core/lib/issues/parentRules.ts` — the existing pure ' +
        '`lib/issues/*` rule module the default helper sits beside.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § migrations.',
      dependsOn: ['2.7.2'],
    },
    {
      id: '2.7.4',
      title: 'The type/executor picker UI (create modal + detail rail) + per-type hue tokens',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'Build the picker EXACTLY as 2.7.1 specifies, on the two existing ' +
        'surfaces — the issue create modal and the detail rail. This is the ' +
        'human-facing half of the field: choosing a type, seeing the executor ' +
        'seeded from the default map, overriding it, and reading/editing both ' +
        'on the detail.\n\n' +
        '**Per-type hue tokens.** Add the per-type colour tier to ' +
        '`app/globals.css` — `--el-type-{code,design,test,content,research,' +
        'review,decision,deploy,manual,chore}` mapped to Tier-0 palette values ' +
        '(the per-component `--el-*` growth pattern, notes.html #20; mirror the ' +
        'existing `--el-type-{epic,story,task,bug,subtask}` kind hues). AA ' +
        'contrast: hue in the chip BACKGROUND with `--el-text-strong` text ' +
        '(finding #35), never a page-level tint.\n\n' +
        '**Create modal.** Add the type picker (a `Combobox`/`DropdownMenu` of ' +
        'the ten hued members) — RENDERED ONLY when the selected kind is a leaf ' +
        '(task/subtask/bug), absent for epic/story. On selecting a type, SEED ' +
        '`executor` via the 2.7.3 `defaultExecutorForType` helper (single ' +
        'source — the UI does NOT re-state the map) into the adjacent executor ' +
        'control (a segmented `coding_agent | human` control), still ' +
        'overridable. `type` may be left unset (null).\n\n' +
        '**Detail rail.** Render the type chip (hued via `--el-type-*`, ' +
        '`IssueTypeIcon`-adjacent) + a compact executor indicator (agent vs ' +
        'person glyph), both inline-editable via the same picker. A leaf with ' +
        '`type = null` shows the "set a type" affordance; an epic/story shows ' +
        'NO type control.\n\n' +
        '**4-layer + a11y.** The picker is a client component that calls the ' +
        '2.7.3-backed create/update endpoints (through services — never the ' +
        'repository/Prisma directly). References ONLY `--el-*` colour + ' +
        '`[data-display-style]` shape tokens (no Tier-0 utilities — the ' +
        '`motir-core/CLAUDE.md` colour/shape rules). Keyboard-reachable; the ' +
        'type dropdown + executor control carry aria-labels. **i18n:** the ten ' +
        'type labels + the two executor labels + the "set a type" copy go in ' +
        'the issues i18n namespace (the same locale set the app ships).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The create modal shows the type picker (the ten hued members) ONLY ' +
        'for a leaf kind; choosing a type seeds the executor from ' +
        '`defaultExecutorForType` (e.g. `code` → coding_agent, `manual` → ' +
        'human) into the segmented control, still overridable; `type` may be ' +
        'left null.\n' +
        '- The detail rail renders the hued type chip + executor indicator and ' +
        'both are inline-editable; a `type = null` leaf shows "set a type"; an ' +
        'epic/story shows no type control.\n' +
        '- `app/globals.css` gains the ten `--el-type-*` per-type hues (AA: hue ' +
        'in the background, `--el-text-strong` text); the picker references ' +
        'ONLY `--el-*` + shape tokens.\n' +
        '- No client component touches the service/repository layer directly ' +
        '(it calls the create/update endpoints); the picker matches the 2.7.1 ' +
        'design panels (no improvised affordance).\n' +
        '- a11y: keyboard-reachable, aria-labelled type + executor controls.\n\n' +
        '## Context refs\n\n' +
        '- 2.7.1 — the design asset (the four panels this implements ' +
        'verbatim).\n' +
        '- 2.7.3 — the enum + `defaultExecutorForType` helper this seeds the ' +
        'executor from (single source).\n' +
        '- `motir-core/components/issues/IssueTypeIcon.tsx` — the per-kind hue ' +
        'pattern the per-type chip extends.\n' +
        '- `motir-core/components/ui/Pill.tsx`, the `Combobox`/`DropdownMenu` ' +
        'primitive, the segmented-control primitive — the composable surface.\n' +
        '- `motir-core/app/globals.css` — where the `--el-type-*` per-type hue ' +
        'tier is added.\n' +
        '- `motir-core/CLAUDE.md` § colour / shape + § 4-layer.',
      dependsOn: ['2.7.1', '2.7.3'],
    },
    {
      id: '2.7.5',
      title:
        'Seed loader — map PlanItem.type/executor to the structured fields (stop emitting prose)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        'Close the loop the whole plan-seed system was waiting on. The plan ' +
        'modules under `scripts/plan-seed/data/` ALREADY carry `type` + ' +
        '`executor` per leaf (every card in story-7.1.ts / story-7.3.ts / this ' +
        'very module), but the loader (`scripts/plan-seed/seed.ts`) currently ' +
        'STRINGIFIES them into the work-item description ("Type: code", ' +
        '"Executor: coding_agent"). Now that 2.7.3 gives them real columns, map ' +
        'them STRUCTURALLY and stop emitting the prose.\n\n' +
        '- **Map** `PlanItem.type` → `work_item.type` and `PlanItem.executor` ' +
        '→ `work_item.executor` (both written through `workItemsService`, the ' +
        'create authority — the loader already uses it). When a leaf omits ' +
        '`executor` but has a `type`, SEED it from 2.7.3’s ' +
        '`defaultExecutorForType` (single source) so the seeded tree matches ' +
        'what the picker would default. Epics + stories get `type = null` ' +
        '(leaf-only).\n' +
        '- **Stop emitting the prose.** Remove the "Type:" / "Executor:" lines ' +
        'from the description the loader composes — the description stays CLEAN ' +
        '(the card’s real prose: description + acceptance criteria + context ' +
        'refs). The structured fields are now the source of truth; the chips ' +
        'render from them (2.7.4).\n' +
        '- **Validate against the loader’s own values.** `PlanItem.type` is a ' +
        'free `string` on the plan side (types.ts), so the loader must map it ' +
        'to the `WorkItemType` enum and FAIL LOUDLY on an unknown type (a typo ' +
        'in a plan module is a seed-time error, not a silently-dropped field) — ' +
        'this is the structural backstop the prose form never had.\n\n' +
        '## Acceptance criteria\n\n' +
        '- After `pnpm db:seed`, leaves carry `work_item.type` + ' +
        '`work_item.executor` as STRUCTURED fields (verified by a repository ' +
        'read), and the description body no longer contains "Type:" / ' +
        '"Executor:" prose lines.\n' +
        '- A leaf with a `type` but no explicit `executor` is seeded with the ' +
        '`defaultExecutorForType` value; epics/stories are seeded `type = ' +
        'null`.\n' +
        '- An unknown `PlanItem.type` string aborts the seed with a clear error ' +
        '(no silent drop); the mapping goes through `workItemsService` (not raw ' +
        'Prisma).\n' +
        '- Re-seeding is idempotent in the established loader way (no duplicate ' +
        'work items; existing seed behaviour preserved apart from the new ' +
        'fields).\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/scripts/plan-seed/seed.ts` — the loader that currently ' +
        'emits type/executor as prose (the lines to remove + the mapping to ' +
        'add).\n' +
        '- `motir-core/scripts/plan-seed/types.ts` — `PlanItem.type` ' +
        '(string) / `PlanItem.executor` — the loader input shape.\n' +
        '- 2.7.3 — the `WorkItemType`/`Executor` enums + the ' +
        '`defaultExecutorForType` helper the loader maps to + seeds from.\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the create authority ' +
        'the loader writes through.',
      dependsOn: ['2.7.3'],
    },
    {
      id: '2.7.6',
      title: 'Epic-6 filter integration — `type` becomes a filterable field in the 6.1.1 FilterAST',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'Make `type` a first-class FILTER facet over the shipped 6.1.1 ' +
        'versioned FilterAST — so a user (and, later, the 7.5 planner read ' +
        'tool) can slice the backlog by the nature of the work ("all `manual` ' +
        'items still open", "the `code` vs `design` split"). This is what ' +
        'promoting `type` from prose to a column UNLOCKS — prose was ' +
        'unfilterable.\n\n' +
        '- **Register `type` as a filterable field** in the 6.1.1 FilterAST ' +
        'field registry: a closed-set enum facet over the ten `WorkItemType` ' +
        'members (the fixed enum makes this a clean equality/`in` predicate — ' +
        'no free-text matching). Support `type = X`, `type in (X, Y)`, and ' +
        '`type is null` (the unset/epic-story case), composing with the ' +
        'existing predicates (AND/OR) exactly like the other enum facets ' +
        '(status/kind/priority).\n' +
        '- **Repository translation.** The FilterAST → Prisma `where` ' +
        'translation maps the `type` predicate to a `work_item.type` clause ' +
        '(single-op repository method, 4-layer). Mirror however ' +
        '`kind`/`status` are already translated — `type` is the same shape ' +
        '(an enum column), so reuse that path, do not invent a new one.\n' +
        '- **Saved-view round-trip.** Because the FilterAST is the saved-view ' +
        'serialization, a saved view with a `type` predicate must round-trip ' +
        '(persist + reload) unchanged — the versioned AST already guarantees ' +
        'this for the existing facets; confirm `type` rides it.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The 6.1.1 FilterAST accepts `type` as a closed-set enum facet ' +
        '(`= X` / `in (…)` / `is null`), composing with AND/OR alongside the ' +
        'existing status/kind/priority predicates.\n' +
        '- The FilterAST → Prisma translation produces the correct ' +
        '`work_item.type` `where` clause (verified by 2.7.7 over a real ' +
        'Postgres); the translation lives in the repository layer (4-layer, ' +
        'mirroring the existing enum facets).\n' +
        '- A saved view carrying a `type` predicate round-trips unchanged; an ' +
        'unknown type value in an incoming AST is rejected by the existing ' +
        'AST validation (the closed set is enforced).\n\n' +
        '## Context refs\n\n' +
        '- The shipped 6.1.1 FilterAST — the versioned filter grammar + its ' +
        'field registry + the FilterAST → Prisma translator (the existing ' +
        '`kind`/`status` enum-facet path `type` mirrors).\n' +
        '- 2.7.3 — the `WorkItemType` enum (the closed set the facet validates ' +
        'against) + the `work_item.type` column the predicate targets.\n' +
        '- `motir-core/lib/services/workItemsService.ts` / the issues list ' +
        'read path — where the FilterAST is applied.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer.',
      dependsOn: ['2.7.3'],
    },
    {
      id: '2.7.7',
      title:
        'Vitest — schema + default map + picker default-seeding + loader mapping + filter facet',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'Lock the whole type/executor model with tests over a real Postgres ' +
        '(the project convention; `tests/helpers/db.ts` truncates between ' +
        'tests; the only allowed `vi.mock` is `getSession()`). Cover every ' +
        'piece the story adds:\n\n' +
        '- **The default map (2.7.3).** `defaultExecutorForType` returns the ' +
        'right executor for EVERY one of the ten enum members (a table test ' +
        'over the full enum — proves the TOTAL function has no hole and matches ' +
        '2.7.2’s map: `code`/`test`/`deploy` → coding_agent; ' +
        '`manual`/`decision`/`review` → human; the four "either" types → ' +
        'coding_agent).\n' +
        '- **Schema + leaf-only enforcement (2.7.3).** A leaf (task/subtask/bug) ' +
        'persists a `type` + `executor`; setting `type` on an epic/story is ' +
        'rejected with the typed error; `type` defaults to null on a row that ' +
        'omits it.\n' +
        '- **Picker default-seeding (2.7.4).** The seeding logic: choosing a ' +
        'type yields the default executor (and an override sticks) — tested at ' +
        'the service/helper boundary the picker calls (not a DOM test; that’s ' +
        '2.7.8’s E2E).\n' +
        '- **Loader mapping (2.7.5).** Seeding a fixture plan leaf with a ' +
        '`type`/`executor` writes the STRUCTURED fields (asserted via a ' +
        'repository read) and the resulting description contains NO "Type:" / ' +
        '"Executor:" prose; a leaf with a type but no executor gets the default; ' +
        'an unknown type string aborts with a clear error.\n' +
        '- **Filter facet (2.7.6).** A FilterAST with `type = manual` returns ' +
        'exactly the manual leaves; `type in (code, test)` composes; `type is ' +
        'null` returns epics/stories/untyped; a saved-view round-trip preserves ' +
        'the `type` predicate; an unknown type value in an AST is rejected.\n\n' +
        '## Acceptance criteria\n\n' +
        '- All the above pass over a real Postgres (no mocks beyond ' +
        '`getSession()`); the default-map test iterates the FULL enum (a new ' +
        'member with no mapping would fail the suite).\n' +
        '- The loader-mapping test asserts BOTH the structured fields are set ' +
        'AND the prose is absent (the regression guard for 2.7.5’s "stop ' +
        'emitting prose").\n' +
        '- New service/repo code (the leaf-only enforcement, the default ' +
        'helper, the filter translation) respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage) — every branch of the empty-input ' +
        'guards has a direct test.\n\n' +
        '## Context refs\n\n' +
        '- 2.7.3 / 2.7.4 / 2.7.5 / 2.7.6 — everything under test.\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + § coverage gate.\n' +
        '- `motir-core/lib/services/workItemsService.ts` + the FilterAST ' +
        'translator — the units asserted against.',
      dependsOn: ['2.7.3'],
    },
    {
      id: '2.7.8',
      title:
        'Playwright E2E — create a typed work item (pick type + executor), filter the list by type',
      status: 'blocked',
      type: 'e2e',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        'End-to-end browser test (`tests/e2e/work-item-type.spec.ts`) closing ' +
        'the story from the user’s seat: pick a type + executor on create, see ' +
        'them on the detail, then filter the list by type.\n\n' +
        '**The spec.**\n\n' +
        '1. Sign in as `zhuyue@motir.co` on the seeded `moooon`/`motir` tenant ' +
        '(the existing `signIn` helper — no new auth plumbing).\n' +
        '2. Open the issue create modal; choose kind = task (a leaf), then pick ' +
        '`type = code` — assert the executor control SEEDED to `coding_agent` ' +
        '(the default map). Create it. Open a second create, pick ' +
        '`type = manual` — assert the executor seeded to `human`; OVERRIDE it ' +
        'to `coding_agent` and assert the override sticks; create it.\n' +
        '3. On the first item’s detail rail, assert the hued `code` type chip + ' +
        'the `coding_agent` executor indicator render; assert they are ' +
        'inline-editable (open the picker).\n' +
        '4. Assert the type picker is ABSENT when the chosen kind is a story ' +
        '(leaf-only) — open a create, pick kind = story, confirm no type ' +
        'control.\n' +
        '5. On /issues, build a filter `type = code` over the 6.1.1 filter ' +
        'builder — assert the first item is present and the `manual` item is ' +
        'absent; switch to `type = manual` and assert the inverse.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e work-item-type` passes locally + in CI.\n' +
        '- The spec asserts: the executor default-seeds per the map ' +
        '(`code` → coding_agent, `manual` → human), an override sticks, the ' +
        'detail chip + indicator render + edit, the type control is leaf-only ' +
        '(absent for story), and the type filter slices the list correctly both ' +
        'ways.\n' +
        '- The spec uses the established E2E patterns (the `signIn` helper, the ' +
        'combobox-option selectors, explicit waits — no fixed sleeps; mind the ' +
        'combobox-option-name gotcha: option name = label + secondary).\n\n' +
        '## Context refs\n\n' +
        '- 2.7.4 (the picker UI under test), 2.7.6 (the type filter facet under ' +
        'test).\n' +
        '- `motir-core/tests/e2e/` — the existing create-modal + filter E2E ' +
        'patterns (sign-in helper, combobox selectors) to mirror.\n' +
        '- 2.7.1 — the design panels the rendered surfaces must match.',
      dependsOn: ['2.7.4'],
    },
  ],
};
