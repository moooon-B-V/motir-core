import type { PlanStory } from '../types';

/**
 * Story 7.11 — Cadence: auto-planning trigger + AI sprint planning + AI
 * project settings. The story that turns Epic 7's planning capabilities from
 * human-triggered actions into a self-sustaining CADENCE: the project keeps
 * itself planned (auto-expand the tree as the ready set drains) and keeps the
 * work PACKED into short, coding-agent-paced sprints — both governed by a small
 * set of AI settings on the project, surfaced in a settings panel.
 *
 * **What 7.11 is.** Three connected capabilities over the SHIPPED substrate, no
 * new architecture:
 *
 * 1. **The auto-plan cadence engine (7.11.3).** A background watcher riding the
 *    SHIPPED 1.6 cron substrate that, when a project's READY set (the 7.0 ready
 *    set) drains below `aiAutoPlanThreshold`, FIRES the 7.4 expand/augment job
 *    automatically. This PROMOTES 7.4.7's human-facing "suggest expanding stubs
 *    when the ready set drains" affordance into a real, opt-in AUTO-trigger — the
 *    same generate→human-approve→persist loop, just initiated by the cron instead
 *    of a click. Nothing auto-WRITES: the auto-fired job still returns a delta
 *    that a human approves (Principle #1 is never bypassed; the trigger is the
 *    only thing that becomes automatic).
 *
 * 2. **AI sprint planning (7.11.4 job + 7.11.5 persist).** A new `plan_sprint`
 *    job (motir-ai) that PACKS ready items into short sprints — honoring the
 *    is_blocked_by DAG (never schedule a blocked item before its blocker) and a
 *    per-sprint capacity — for COVERAGE at a coding-agent cadence. It returns a
 *    sprint-assignment DELTA; motir-core persists it via the SHIPPED Epic-4
 *    sprint services on the same generate→human-approve→persist seam (create
 *    sprints + assign items only after a human approves).
 *
 * 3. **AI project settings (7.11.2 columns + 7.11.6 panel).** The knobs that
 *    govern the above are COLUMNS on `model Project` (the established
 *    project-settings precedent — `workflowPolicyMode`, `accessLevel`,
 *    `estimationStatistic`, `pointScale`), surfaced in a settings panel that also
 *    re-exposes the 7.3 explanation-generation toggle.
 *
 * **The locked Epic-7 architecture this story inherits (full prose in
 * story-7.1.ts's header; restated only where it bears on cadence):**
 *
 * 1. **One-directional writes — generate → human-approve → persist.** Auto-plan
 *    and AI sprint planning are AUTO-TRIGGERS, not auto-writes. The auto-fired
 *    7.4 expand/augment job and the `plan_sprint` job both return DELTAS as data;
 *    motir-core persists them only behind a human approve, through the shipped
 *    `workItemsService` (the tree) and the shipped Epic-4 sprint services (the
 *    sprints). The AI never writes the tree or the sprint board directly.
 *
 * 2. **A tool-use SESSION over the async job substrate.** `plan_sprint` registers
 *    against the 7.1.4 handler interface `(job, ctx) => Promise<Result>` as a new
 *    `jobKind`, exactly like `generate_tree`/`expand_item`/`augment`; the cadence
 *    engine SUBMITS the existing 7.4 jobs — it adds a TRIGGER, not a new planner.
 *
 * 3. **motir-ai is STATEFUL; motir-core stays the system of record.** The sprint
 *    packing logic (the scheduler) lives in motir-ai (the closed planner side);
 *    `Sprint` rows and their item assignments live in motir-core (Epic 4, the
 *    open PM substrate). The AI-settings columns live in motir-core too — they
 *    are PM configuration, readable by the open core, NOT an AI-only table.
 *
 * **THE MIRROR GAP (rung-1 check — VERIFIED with web tools, not asserted).**
 * - **Jira** lets you set a sprint's length when you create/configure each
 *   sprint (default 2 weeks); a project-level DEFAULT sprint length is a
 *   long-standing UNMET feature request (JSWSERVER-6858 / JSWSERVER-7809), and
 *   Jira has NO AI sprint planning and NO auto-expand-the-backlog trigger.
 * - **Linear Cycles 2.0** (2026) is the closest prior art: "auto-scheduling"
 *   fills a cycle by pulling BACKLOG issues in priority order under a capacity
 *   constraint, plus AI capacity estimation and Cycle Autopilot (rollover). But
 *   (a) Linear AUTO-FILLS a cycle from an EXISTING backlog — it does NOT generate
 *   or auto-EXPAND the plan tree when work runs low; (b) Linear cycles are
 *   HUMAN-scale (1–8 weeks). Neither tool has a watcher that auto-FIRES planning
 *   when the ready set drains.
 * - **So two distinct deviations, both Principle-#11 justified:** (1) the
 *   auto-EXPAND cadence trigger has NO mirror — it is AI-native (the project
 *   keeps ITSELF planned); (2) AI sprint PACKING is adjacent to Linear's
 *   auto-scheduling but distinct — Motir packs into SHORT 2–3 day sprints honoring
 *   the dep DAG, for CODING-AGENT cadence (an agent completes a leaf in
 *   minutes–hours, not the days–weeks a human takes), where Linear packs 1–8 week
 *   HUMAN cycles. The short sprint is the deviation; its use case (coding-agent
 *   throughput, not human ceremony) is the justification recorded here.
 *
 * **Cross-story dep audit (notes.html #32): PASSES.** Every 7.11 leaf depends
 * only on backward/sideways same-epic ids — 7.4.7 (the suggest-expansion the
 * cadence promotes), 7.4.5 (the augment/expand/replan services + the reused job
 * substrate), the 7.11 design gate + the AI-settings columns it ships itself —
 * plus the SHIPPED 1.6 cron substrate, the 7.0 ready set, and the Epic-4 sprint
 * services. No forward-pointing dep on 7.12/7.13. Statuses follow the rule:
 * 7.11.1 (design, deps []) and 7.11.2 (the settings columns, deps []) are
 * `planned`; everything chained behind them or behind any not-yet-done
 * 7.4.x/7.11.x id is `blocked`.
 *
 * **The design gate fires (Principle #13).** 7.11 ships a real user-facing
 * surface — the AI-planning settings panel. So the FIRST subtask (7.11.1) is a
 * `design` card producing `design/ai-settings/*.mock.html` + `design-notes.md`,
 * and the UI code subtask (7.11.6) depends on it and is `blocked` behind it.
 */
export const story_7_11: PlanStory = {
  id: '7.11',
  title: 'Cadence — auto-planning + AI sprint planning',
  status: 'planned',
  gitBranch: 'feat/PROD-7.11-cadence-auto-planning',
  descriptionMd:
    'Make planning a self-sustaining CADENCE rather than a series of manual ' +
    'clicks. A project configured for it KEEPS ITSELF PLANNED — the tree ' +
    'auto-expands as the ready set drains — and keeps the work PACKED into ' +
    'short, coding-agent-paced sprints, all governed by a small set of AI ' +
    'settings on the project. This rides entirely on SHIPPED substrate (the ' +
    '1.6 cron, the 7.0 ready set, the 7.4 expand/augment jobs, the Epic-4 ' +
    'sprint services) — it adds TRIGGERS + a scheduler + settings, not new ' +
    'architecture.\n\n' +
    '**The three capabilities (locked — see the module header for the full ' +
    'rationale + the verified mirror gap):**\n\n' +
    '- **Auto-plan cadence.** A background watcher on the SHIPPED 1.6 cron ' +
    'fires the 7.4 expand/augment job when a project’s ready set drains below ' +
    '`aiAutoPlanThreshold` — promoting 7.4.7’s human "suggest expanding stubs" ' +
    'affordance into a real opt-in AUTO-trigger. The auto-fired job still ' +
    'returns a delta a human approves; only the TRIGGER becomes automatic ' +
    '(generate → human-approve → persist is never bypassed).\n' +
    '- **AI sprint planning.** A new `plan_sprint` job packs ready items into ' +
    'short (`aiSprintLengthDays`, default 2–3) sprints, honoring the ' +
    'is_blocked_by DAG + a per-sprint capacity, for coding-agent cadence; ' +
    'motir-core creates the sprints + assigns the items via the SHIPPED Epic-4 ' +
    'sprint services, again behind a human approve.\n' +
    '- **AI project settings.** The knobs (`aiAutoPlanEnabled`, ' +
    '`aiAutoPlanThreshold`, `aiSprintPlanningEnabled`, `aiSprintLengthDays`, ' +
    '`aiPlannerModel`) are COLUMNS on `model Project` (the project-settings ' +
    'precedent), surfaced in a settings panel that also re-exposes the 7.3 ' +
    'explanation-generation toggle.\n\n' +
    '**Mirror gap (verified):** Jira sets sprint length per-sprint (no ' +
    'project default; no AI planning, no auto-expand trigger); Linear Cycles ' +
    '2.0 auto-FILLS a cycle from an existing backlog at HUMAN (1–8 wk) cadence ' +
    'but never auto-EXPANDS the plan. Motir’s auto-expand trigger has no ' +
    'mirror, and its SHORT 2–3 day sprint is a justified deviation for ' +
    'coding-agent throughput.\n\n' +
    '**Scope:** the AI-settings panel design (7.11.1); the `Project` ' +
    'AI-settings columns + migration (7.11.2); the auto-plan cadence engine on ' +
    'the 1.6 cron (7.11.3); the `plan_sprint` packing job (7.11.4); the ' +
    'sprint-planning API + persist via Epic-4 services (7.11.5); the ' +
    'AI-settings UI panel (7.11.6); vitest (7.11.7); and the ' +
    'enable-cadence → sprints-planned + expansion-auto-fired E2E (7.11.8).\n\n' +
    '**Out of scope (named so they land in their own stories, not here):** ' +
    'planning metering + the credit ledger that bills the auto-fired jobs ' +
    '(7.12); contextual per-item planning (7.13); the Epic-4 sprint BOARD/' +
    'ceremony UI itself (shipped — 7.11 reuses its services, it does not ' +
    'rebuild the board); the Epic-8 billing/checkout flow.',
  verificationRecipeMd:
    '- Pull the Story branch; bring up both services locally (motir-core on ' +
    '`:3000`, motir-ai on its dev port, each pointed at the other), the 1.6 ' +
    'cron running, and a seeded `PROD` project with a planned tree + a ready ' +
    'set (the 7.0 ready set populated).\n' +
    '- **AI settings (7.11.2 / 7.11.6).** Open the project’s AI-planning ' +
    'settings panel: toggle **Auto-plan** on and set a ready-set THRESHOLD; ' +
    'toggle **AI sprint planning** on and set **sprint length** in days ' +
    '(default 2–3); confirm the 7.3 explanation toggle is present here too, ' +
    'and the planner-model choice persists. Reload — every setting round-trips ' +
    '(they are `Project` columns).\n' +
    '- **Auto-plan cadence (7.11.3).** Drive the ready set BELOW the threshold ' +
    '(mark enough ready items in-progress / done, or lower the threshold). On ' +
    'the next cron tick, an `expand`/`augment` job auto-FIRES for the project ' +
    '(visible as a pending proposed delta in the 7.4 review surface) — WITHOUT ' +
    'a click. Confirm it did NOT auto-write: the proposed expansion waits for a ' +
    'human approve (Principle #1). With auto-plan OFF, no job fires.\n' +
    '- **AI sprint planning (7.11.4 / 7.11.5).** Trigger sprint planning: the ' +
    '`plan_sprint` job returns a proposed packing — short sprints sized to ' +
    '`aiSprintLengthDays`, each respecting per-sprint capacity, and NO item ' +
    'scheduled into a sprint before an item that blocks it (the is_blocked_by ' +
    'DAG honored). Approve → the sprints are created and items assigned via the ' +
    'SHIPPED Epic-4 sprint services (verify the sprint board shows them); ' +
    'nothing is persisted before approve.\n' +
    '- `pnpm test` (motir-core) + the motir-ai suite — 7.11.7 covers: the ' +
    'cadence trigger fires exactly when ready < threshold (and not otherwise, ' +
    'and not when auto-plan is off); sprint packing respects the DAG + the ' +
    'length/capacity bounds; the settings columns persist + default sensibly.\n' +
    '- **Open-core boundary review (this Epic’s recurring posture).** The ' +
    'sprint SCHEDULER lives in motir-ai (returns a delta); the `Sprint` rows + ' +
    'item assignments are written in motir-core via the Epic-4 services; the ' +
    'AI-settings columns are on `Project` (open core, no AI-only table). No ' +
    '`motir-ai` import in `motir-core`; the cron watcher submits jobs over the ' +
    '7.1.5 client only.\n' +
    '- If every step holds, approve and merge the Story PR. If anything ' +
    'fails, comment with what didn’t work and Motir will produce a follow-up ' +
    'Subtask under the same Story.',
  items: [
    {
      id: '7.11.1',
      title:
        'Design — the AI-planning project settings panel (auto-plan + sprint cadence + planner model)',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        '**Type:** design (the planning-time design gate, Principle #13 + the ' +
        'design-reference rule). The AI-settings UI panel (7.11.6) depends on ' +
        'this card; without it the settings surface would be improvised, which ' +
        'is forbidden (notes.html #31).\n\n' +
        'Produce the design asset for the **AI-planning project settings ' +
        'panel** under `motir-core/design/ai-settings/`. Author it as a ' +
        '**`*.mock.html` mockup** built from the real design system (the ' +
        'shipped `components/ui/*` primitives + the `--el-*` colour tokens + ' +
        'the `[data-display-style]` shape tokens) — NOT a `.pen`. The HTML ' +
        'route is preferred when a coding agent produces the design (no ' +
        'translation gap; the reviewer sees the actual tokens). A PNG export ' +
        'is optional; the `.mock.html` is the source of truth (MOTIR.md ' +
        '§ Design-reference rule).\n\n' +
        '**Mirror (VERIFIED — and where Motir deviates).** Jira/Linear surface ' +
        'sprint/cycle LENGTH as a setting (Linear: a cycle-length-in-weeks ' +
        'selector + an enable toggle; Jira: per-sprint dates) but neither has ' +
        'an "auto-plan when work runs low" toggle or an AI-planner-model ' +
        'choice. So this panel BORROWS the cycle-length-selector shape (a ' +
        'numeric/stepper control + an enable switch) and ADDS the AI-native ' +
        'controls. Mirror the EXISTING motir-core project-settings surface ' +
        '(where `workflowPolicyMode` / `estimationStatistic` / `pointScale` ' +
        'already render) so this panel reads as one more settings section, not ' +
        'a bolt-on.\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the ' +
        'multi-panel rule, mistake #31):\n\n' +
        '- **Panel 1 — the settings panel (default/disabled state).** The ' +
        'section laid out among the existing project-settings rows: an ' +
        '**Auto-plan** group (an enable switch + a "ready-set threshold" ' +
        'stepper — "auto-expand the plan when fewer than N ready items ' +
        'remain"); an **AI sprint planning** group (an enable switch + a ' +
        '"sprint length (days)" stepper, DEFAULT 2–3, with helper copy naming ' +
        'the coding-agent-cadence rationale); the **explanation-generation** ' +
        'toggle surfaced from 7.3 (a switch — "draft a why for each item"); and ' +
        'the **planner model** choice (a `Combobox`/`DropdownMenu` of the ' +
        'allowed planner models). Show each control DISABLED-but-present where a ' +
        'parent toggle is off (e.g. threshold greyed until Auto-plan is on).\n' +
        '- **Panel 2 — the enabled state.** Both switches on, the dependent ' +
        'controls live: a threshold of e.g. 5, a sprint length of 2 days, a ' +
        'chosen model — so the reviewer sees the "configured" look + the ' +
        'helper/hint copy under each control.\n' +
        '- **Panel 3 — the inline explanations / guardrails.** The helper text ' +
        'that makes the cadence SAFE-by-default explicit: "auto-plan PROPOSES ' +
        'an expansion for your approval — it never creates work without you" ' +
        '(Principle #1 restated in copy), and the short-sprint rationale ' +
        '("sized for coding-agent throughput, not human sprints"). Draw any ' +
        'validation state (threshold must be ≥ 1; sprint length within an ' +
        'allowed range).\n' +
        '- **Panel 4 — save + permission/empty states.** The save affordance ' +
        '(or auto-save confirmation, matching the existing settings pattern), ' +
        'the read-only state for a non-admin (settings gated by the same role ' +
        'that governs the other project settings), and the "AI not provisioned" ' +
        'state (if the motir-ai key/boundary isn’t configured, the AI groups ' +
        'show a clear disabled explanation rather than broken controls).\n\n' +
        'Also write **`design/ai-settings/design-notes.md`** naming the exact ' +
        'primitives used per surface (the switch, the stepper, the ' +
        '`Combobox`/`DropdownMenu`, the helper-text treatment, the settings-row ' +
        'layout), the exact copy strings (incl. the Principle-#1 guardrail copy ' +
        'and the short-sprint rationale), the placement decisions (this section ' +
        'among the existing project-settings rows), and the per-`--el-*` colour ' +
        'role for each element, plus a "primitives composed (no hand-rolling)" ' +
        'checklist (the `design-notes.md` convention 1.3.3 / 1.5.1 / 7.0.1 ' +
        'established).\n\n' +
        '**Branch.** `design/PROD-7.11.1-ai-settings-panel`. The `design/*` ' +
        'prefix gate skips CI E2E + the Vercel preview deploy (MOTIR.md ' +
        '§ Plan-seed Workflow) — this PR only edits `design/ai-settings/**`, no ' +
        'app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/ai-settings/ai-planning-settings.mock.html` ' +
        'exists, renders the four panels above, and references ONLY `--el-*` ' +
        'tokens + `[data-display-style]` shape tokens (no Tier-0 `--color-*`, ' +
        'no hand-rolled spacing — the `motir-core/CLAUDE.md` § colour / shape ' +
        'rules).\n' +
        '- `motir-core/design/ai-settings/design-notes.md` exists, names every ' +
        'primitive composed + every copy string + the per-element `--el-*` role ' +
        '(incl. the Principle-#1 guardrail copy and the short-sprint ' +
        'rationale).\n' +
        '- All five settings (auto-plan enable, threshold, sprint-planning ' +
        'enable, sprint length, planner model) + the surfaced 7.3 explanation ' +
        'toggle are drawn, with dependent controls disabled when their parent ' +
        'toggle is off, and the non-admin read-only + AI-not-provisioned states ' +
        'shown.\n' +
        '- The mockup composes ONLY shipped primitives (`Switch`/`Toggle`, the ' +
        'stepper/number input, `Combobox`/`DropdownMenu`, `Card`, helper ' +
        'text) — if a genuinely new primitive is needed, that is a NEW ' +
        '`design/` subtask, not a code workaround.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/app/(app)/settings/` (the existing project-settings ' +
        'surface where `workflowPolicyMode` / `estimationStatistic` / ' +
        '`pointScale` render) — the layout + `design-notes.md` shape to mirror.\n' +
        '- `motir-core/components/ui/` — the `Switch`/`Toggle`, the number/' +
        'stepper input, `Combobox`/`DropdownMenu`, `Card` primitives to ' +
        'compose.\n' +
        '- 7.4.1 (`design/ai-planning/`) — the sibling AI design area; mirror ' +
        'its multi-panel + `design-notes.md` shape.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` colour + ' +
        '`[data-display-style]` shape tokens (the swap layer the mock ' +
        'references).',
      dependsOn: [],
    },
    {
      id: '7.11.2',
      title: 'The `Project` AI-settings columns + migration (auto-plan / sprint / planner model)',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'Add the AI-planning configuration as COLUMNS on `model Project` — the ' +
        'established project-settings precedent (`workflowPolicyMode`, ' +
        '`accessLevel`, `estimationStatistic`, `pointScale` all live here). ' +
        'These are PM configuration readable by the OPEN core (not an AI-only ' +
        'table); the cadence engine (7.11.3), the sprint-planning flow ' +
        '(7.11.4/7.11.5), and the settings panel (7.11.6) all read them.\n\n' +
        'No forward dependency — this card has `dependsOn: []` (it adds ' +
        'standalone columns with safe defaults) so it is `planned` and unblocks ' +
        'the rest of the story.\n\n' +
        '**Columns (with defaults chosen so the feature is OFF until opted ' +
        'in):**\n\n' +
        '- `aiAutoPlanEnabled` (boolean, default `false`) — the auto-expand ' +
        'cadence switch.\n' +
        '- `aiAutoPlanThreshold` (int, default e.g. `5`) — auto-expand when the ' +
        'ready set drains below this; a `@db`-level / app-level check enforces ' +
        '≥ 1.\n' +
        '- `aiSprintPlanningEnabled` (boolean, default `false`) — the AI sprint ' +
        'planning switch.\n' +
        '- `aiSprintLengthDays` (int, default `2`) — the SHORT coding-agent ' +
        'sprint length (the justified deviation; an allowed range, e.g. 1–14, ' +
        'enforced app-side; default 2–3 per the mirror-gap rationale).\n' +
        '- `aiPlannerModel` (string/enum, nullable → falls back to the 7.2.2 ' +
        'default planner model) — the per-project planner-model override.\n' +
        '- (The explanation-generation toggle column is added by Story 7.3; ' +
        '7.11 only SURFACES it in the panel — do NOT re-add it here.)\n\n' +
        '**4-layer (motir-core/CLAUDE.md).** A migration + the ' +
        '`projectRepository` read/update methods (write methods take `tx`); ' +
        'reads/writes flow through the project settings service; the DTO + ' +
        'mapper expose the new fields. If `aiPlannerModel` is modelled as an ' +
        'enum, follow the enum-migration convention; any FK stays a `@relation` ' +
        '(none expected here — these are scalars/enum).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `prisma/schema.prisma` carries the five columns on `Project` with ' +
        'the defaults above; a migration applies cleanly (`prisma migrate dev` ' +
        'reports no drift afterward — every default is in the migration, ' +
        'finding the CLAUDE.md FK/enum rule).\n' +
        '- The project settings service reads + updates the new fields through ' +
        'the repository (write path takes `tx`); the settings DTO + mapper ' +
        'expose them; existing projects backfill to the safe defaults ' +
        '(feature OFF).\n' +
        '- App-side validation: `aiAutoPlanThreshold ≥ 1`; `aiSprintLengthDays` ' +
        'within the allowed range; invalid values are rejected with a typed ' +
        'error (not silently clamped at the DB).\n' +
        '- 4-layer respected; no raw Prisma in a route; no AI-only table ' +
        'introduced (these are open-core `Project` columns).\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/prisma/schema.prisma` § `model Project` — the existing ' +
        '`workflowPolicyMode` / `accessLevel` / `estimationStatistic` / ' +
        '`pointScale` columns (the precedent shape to mirror).\n' +
        '- `motir-core/lib/repositories/projectRepository.ts` + the project ' +
        'settings service/DTO/mapper — the 4-layer files to extend.\n' +
        '- 7.2.2 — the default planner model `aiPlannerModel` falls back to.\n' +
        '- `motir-core/CLAUDE.md` § migrations (FK = `@relation`) + § 4-layer.',
      dependsOn: [],
    },
    {
      id: '7.11.3',
      title:
        'Auto-plan cadence engine (motir-core + motir-ai) — cron watcher fires 7.4 expand at threshold',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'The cadence trigger: a background watcher on the SHIPPED 1.6 cron ' +
        'substrate that fires the 7.4 expand/augment job for a project when its ' +
        'READY set (the 7.0 ready set) drains below `aiAutoPlanThreshold`. This ' +
        'PROMOTES 7.4.7’s human-facing "suggest expanding stubs when the ready ' +
        'set drains" into a real, opt-in AUTO-trigger — Principle #17 ' +
        'productized as cadence.\n\n' +
        '**It adds a TRIGGER, not a planner.** The watcher does NOT plan; it ' +
        'SUBMITS the existing 7.4 `expand_item`/`augment` job via the 7.1.5 ' +
        'client (minting the job-scoped token as any submit does). The returned ' +
        'delta lands in the SAME 7.4 review surface a human approves — ' +
        'generate → human-approve → persist is never bypassed (Principle #1). ' +
        'The ONLY thing that becomes automatic is the decision to START the ' +
        'job.\n\n' +
        '**The watcher (4-layer, on the 1.6 cron).** A scheduled task ' +
        '(registered on the shipped 1.6 cron substrate — the same place 1.6 ' +
        'schedules its periodic jobs) that, per tick, for each project with ' +
        '`aiAutoPlanEnabled = true`: (1) reads the project’s ready-set COUNT ' +
        'via the shipped 7.0 ready-set query (a read method, not a recompute); ' +
        '(2) if `readyCount < aiAutoPlanThreshold`, submits ONE expand/augment ' +
        'job; (3) records that a job was auto-fired so it does NOT re-fire while ' +
        'one is already pending/in-review for that project (DEBOUNCE — no ' +
        'duplicate auto-expansions stacking up). The orchestration lives in a ' +
        'service; the cron task is a thin trigger that calls it.\n\n' +
        '**Choosing WHAT to expand.** The watcher targets the augment/expand ' +
        'entry 7.4 already exposes (expand a stub epic/story, or augment from ' +
        'the project’s direction) — it reuses 7.4.5’s service, passing a ' +
        '"cadence-initiated" provenance so the review surface can show the ' +
        'expansion was auto-proposed (vs. user-clicked). It does NOT invent a ' +
        'new planning path.\n\n' +
        '**Idempotence + safety.** Disabled projects are skipped entirely; a ' +
        'project already at/above threshold is skipped; a project with a ' +
        'pending auto-proposal is skipped (debounce). A job-submit failure is ' +
        'logged and retried next tick, never crashes the cron sweep for other ' +
        'projects.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A scheduled watcher runs on the 1.6 cron substrate; per tick it ' +
        'evaluates each `aiAutoPlanEnabled` project’s ready-set count against ' +
        '`aiAutoPlanThreshold` (via the shipped 7.0 ready-set read).\n' +
        '- When `readyCount < threshold`, it submits ONE 7.4 expand/augment job ' +
        'via the 7.1.5 client; the resulting delta appears in the 7.4 review ' +
        'surface as a cadence-initiated proposal — and is NOT persisted until a ' +
        'human approves (Principle #1 holds).\n' +
        '- Debounce: while a project has a pending/in-review auto-proposal it is ' +
        'not re-fired; a disabled project and an at-threshold project are ' +
        'skipped.\n' +
        '- A submit failure for one project is isolated (logged, retried next ' +
        'tick) and does not abort the sweep for others.\n' +
        '- 4-layer respected (cron task → service → repos/client); no ' +
        '`motir-ai` import in motir-core (the watcher calls over the 7.1.5 ' +
        'client only).\n\n' +
        '## Context refs\n\n' +
        '- The SHIPPED 1.6 cron substrate (the periodic-job scheduler + its ' +
        'task-registration pattern) — where this watcher registers.\n' +
        '- The DONE 7.0 ready set (`lib/.../readySet` query/service) — the ' +
        'ready-count read this thresholds on.\n' +
        '- 7.4.7 — the human "suggest expansion when ready drains" affordance ' +
        'this promotes into an auto-trigger.\n' +
        '- 7.4.5 — the augment/expand/replan services the watcher submits ' +
        'through; 7.1.5 — the core→ai client + job-scoped token mint.\n' +
        '- 7.11.2 — the `aiAutoPlanEnabled` / `aiAutoPlanThreshold` columns ' +
        'read here.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer.',
      dependsOn: ['7.4.7', '7.11.2'],
    },
    {
      id: '7.11.4',
      title:
        'The `plan_sprint` packing job (motir-ai) — pack ready items into short dep-aware sprints',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'Implement the `plan_sprint` job handler in motir-ai — a new `jobKind` ' +
        'registered against the 7.1.4 handler interface ' +
        '`(job, ctx) => Promise<Result>`, alongside `generate_tree` / ' +
        '`expand_item` / `augment` / `replan`. It PACKS the project’s ready ' +
        'items into short sprints sized for coding-agent cadence and returns a ' +
        'sprint-assignment DELTA (it does NOT write sprints — persist is ' +
        'core-side behind a human approve, 7.11.5).\n\n' +
        '**The packing problem (deterministic scheduler, NOT free-form LLM ' +
        'output).** Given the ready set + the is_blocked_by DAG + ' +
        '`aiSprintLengthDays` + a per-sprint CAPACITY (derived from item ' +
        'estimates — `estimateMinutes` — and an assumed coding-agent ' +
        'throughput-per-day for that sprint length), produce an ORDERED list of ' +
        'sprints, each a set of items, such that: (1) no item is scheduled in a ' +
        'sprint EARLIER than any item that blocks it (topological order over ' +
        'is_blocked_by — the load-bearing constraint); (2) each sprint’s total ' +
        'estimate fits the per-sprint capacity; (3) items pack greedily by ' +
        'priority + readiness for COVERAGE (drain the ready set across the ' +
        'fewest sprints, not a clever optimum). The scheduler is a pure, ' +
        'testable function; the LLM is used (if at all) only to ' +
        'EXPLAIN/annotate the proposed packing, never to invent the schedule ' +
        '(no shortcut, no hallucinated ordering).\n\n' +
        '**Reads.** The handler reads the project’s ready set + the ' +
        'is_blocked_by edges via the 7.1.6 read-back (job-scoped token) — the ' +
        'SAME skeleton + dependency projection the other jobs use (extend the ' +
        'projection if the blocking edges aren’t already in the skeleton; this ' +
        'is a read, no new write path). It reads `aiSprintLengthDays` from the ' +
        'job context (passed by 7.11.5 from the 7.11.2 column).\n\n' +
        '**The sprint-assignment delta (the contract 7.11.5 persists).** A ' +
        'versioned, structured-output shape: an ordered list of proposed ' +
        'sprints, each `{ tempId, name, lengthDays, itemKeys[] }`, plus ' +
        'top-level `deltaVersion`. It carries NO write authority — core chooses ' +
        'to commit it via the Epic-4 sprint services. Mirror the 7.3.2 ' +
        'tree-delta shape’s tempId/versioning conventions so the persist side ' +
        'is familiar.\n\n' +
        '**Why SHORT sprints (the justified deviation, recorded).** A coding ' +
        'agent completes a leaf in minutes–hours, so a human 1–2 WEEK sprint ' +
        'would batch dozens of agent-completable items into one opaque bucket. ' +
        'A 2–3 DAY sprint gives the cadence a tight feedback loop (plan → ' +
        'dispatch → review → re-plan) matched to agent throughput — the Linear ' +
        'Cycles auto-scheduling mirror packs 1–8 WEEK HUMAN cycles; Motir packs ' +
        'short agent cycles. The length is a setting (`aiSprintLengthDays`), so ' +
        'a human-paced team can widen it.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A `plan_sprint` handler is registered for `kind: plan_sprint` and ' +
        'submitting the job drives `queued → running → succeeded` with the ' +
        'sprint-assignment delta in the result.\n' +
        '- The packing is DEPENDENCY-CORRECT: over a fixture ready set with ' +
        'is_blocked_by edges, no item is placed in a sprint before an item that ' +
        'blocks it (topological-order assertion); a cyclic/over-capacity input ' +
        'is handled (cycle → typed error; an item too big for one sprint → its ' +
        'own sprint or a clear flag, never silently dropped).\n' +
        '- Each sprint respects `aiSprintLengthDays` + the per-sprint capacity ' +
        'derived from estimates; the packing drains the ready set across the ' +
        'fewest sprints (coverage, not an NP-hard optimum).\n' +
        '- The scheduler is a pure, unit-testable function; the returned delta ' +
        'conforms to the versioned sprint-assignment schema (tempIds, ' +
        '`deltaVersion`); no sprint is WRITTEN in the handler (persist is ' +
        '7.11.5).\n' +
        '- Reads only the ready set + blocking edges via 7.1.6 (job-scoped ' +
        'token); no new write path into core.\n\n' +
        '## Context refs\n\n' +
        '- 7.1.4 — the job substrate + handler registry (the `jobKind` ' +
        'extension point) + the job stream.\n' +
        '- 7.1.6 — the read-back skeleton + the is_blocked_by/ready projection ' +
        'the scheduler reads (extend the projection for blocking edges if ' +
        'needed — read only).\n' +
        '- 7.3.2 — the tree-delta shape whose tempId/versioning conventions the ' +
        'sprint-assignment delta mirrors.\n' +
        '- 7.4.5 — the services 7.11.5 reuses to persist (the contract this ' +
        'delta feeds).\n' +
        '- 7.11.2 — `aiSprintLengthDays` (passed in the job context).\n' +
        '- The repo’s claude-api guidance — the Anthropic SDK structured-output ' +
        'pattern for the annotate step (the SCHEDULE is deterministic, not ' +
        'model-invented).',
      dependsOn: ['7.4.5', '7.11.2'],
    },
    {
      id: '7.11.5',
      title:
        'Sprint-planning API + persist (motir-core) — create sprints + assign via Epic-4 services',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'The motir-core side of AI sprint planning: the API + service that ' +
        'SUBMIT a `plan_sprint` job, STREAM its progress, and — on a human ' +
        'approve — PERSIST the proposed packing by creating sprints + assigning ' +
        'items through the SHIPPED Epic-4 sprint services. This is the ' +
        'generate → human-approve → persist seam (Principle #1) applied to ' +
        'sprints; it REUSES Epic-4’s services, it does not re-implement sprint ' +
        'CRUD.\n\n' +
        '**4-layer (motir-core/CLAUDE.md).** Routes parse + call ONE service ' +
        'method; the service owns orchestration; sprint writes go through the ' +
        'Epic-4 sprint service (never raw Prisma in a route).\n\n' +
        '- **`POST /api/ai/plan/sprint`** (session auth, tenant-gated) — ' +
        'resolves the active project, reads `aiSprintLengthDays` + ' +
        '`aiSprintPlanningEnabled` from the 7.11.2 columns (refuses with a ' +
        'typed error if sprint planning is disabled), submits a `plan_sprint` ' +
        'job via the 7.1.5 client (passing the sprint length in context, ' +
        'minting the job-scoped token), returns `{ jobId }`.\n' +
        '- **`GET /api/ai/plan/sprint/:jobId/stream`** — proxies the 7.1.4 job ' +
        'stream (SSE) to the browser; on terminal the proposed ' +
        'sprint-assignment delta is available via the job result. (Browsers ' +
        'stream from CORE, never from motir-ai.)\n' +
        '- **`POST /api/ai/plan/sprint/approve`** — body carries the APPROVED ' +
        '(possibly human-edited) sprint-assignment delta. The service ' +
        'RE-VALIDATES it independently of the planner (defense in depth — the ' +
        'client-submitted delta is never trusted): every `itemKey` exists, is ' +
        'in the project + the ready set, and the assignment still respects the ' +
        'is_blocked_by DAG; then it creates the sprints + assigns the items ' +
        'through the EPIC-4 sprint services, in ONE transaction (a partial ' +
        'sprint plan is never committed), resolving tempIds → real sprint ids, ' +
        'applying every 6.4 permission + the 404-not-403 tenant guard as the ' +
        'session user. Returns the created sprint keys + assignment counts. An ' +
        'empty delta is a valid no-op.\n\n' +
        '**Re-validate on approve, don’t re-pack.** Approve persists EXACTLY ' +
        'the approved packing — it does NOT re-call the scheduler (that would ' +
        'discard human edits). Re-packing is an explicit fresh `plan_sprint` ' +
        'submit.\n\n' +
        '**The auto-fired path.** When `aiSprintPlanningEnabled` is on, the ' +
        '7.11.3 cadence engine MAY also submit `plan_sprint` on its sweep ' +
        '(same as expand) — but the proposal still routes through this ' +
        'approve gate; the cadence never auto-creates sprints. (Keep the submit ' +
        'path shared so cadence + manual use one service method.)\n\n' +
        '## Acceptance criteria\n\n' +
        '- `POST /api/ai/plan/sprint` submits a `plan_sprint` job (sprint ' +
        'length in context, freshly minted token) and returns `{ jobId }`; it ' +
        'refuses with a typed error when `aiSprintPlanningEnabled` is false; ' +
        '`…/:jobId/stream` proxies progress to the browser.\n' +
        '- `POST /api/ai/plan/sprint/approve` re-validates the delta ' +
        '(item-existence + ready-membership + DAG-respect) and rejects a ' +
        'malformed/illegal packing with a typed 400 BEFORE any write, then ' +
        'creates sprints + assigns items via the EPIC-4 sprint services ' +
        '(verified: no raw Prisma in the route), resolving tempIds → ids, in ' +
        'ONE transaction.\n' +
        '- The approved (human-edited) packing is what persists; approve does ' +
        'NOT re-pack; an empty delta is a valid no-op.\n' +
        '- Atomicity: a per-sprint/assignment failure rolls the whole approve ' +
        'back (no partial plan).\n' +
        '- Session + tenant gate on all three routes (401 no session; ' +
        '404-not-403 cross-tenant); 6.4 permissions honored; 4-layer respected; ' +
        'sprint writes go through the Epic-4 services.\n\n' +
        '## Context refs\n\n' +
        '- The SHIPPED Epic-4 sprint services (create-sprint + assign-item) — ' +
        'the persist authority this reuses (do NOT re-implement sprint CRUD).\n' +
        '- 7.11.4 — the `plan_sprint` job + the sprint-assignment delta this ' +
        'submits/persists.\n' +
        '- 7.1.5 — the core→ai client + the job-scoped token mint; 7.1.4 — the ' +
        'job stream proxied here.\n' +
        '- 7.11.2 — the `aiSprintPlanningEnabled` / `aiSprintLengthDays` ' +
        'columns read here.\n' +
        '- 7.11.3 — the cadence engine that shares this submit path.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer.',
      dependsOn: ['7.11.4'],
    },
    {
      id: '7.11.6',
      title:
        'AI-settings UI panel (motir-core) — the toggles/config, surfacing the 7.3 explanation toggle',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Build the AI-planning settings panel EXACTLY as 7.11.1 specifies — the ' +
        'surface where a project is configured for cadence. It reads + writes ' +
        'the 7.11.2 `Project` columns and SURFACES the 7.3 ' +
        'explanation-generation toggle, so all AI-planning configuration lives ' +
        'in one place.\n\n' +
        '**The panel (a section in the existing project settings).** Render it ' +
        'among the existing project-settings rows (where `workflowPolicyMode` / ' +
        '`estimationStatistic` / `pointScale` already live) — NOT a standalone ' +
        'page — so it reads as one more settings section:\n\n' +
        '- **Auto-plan** — an enable switch (`aiAutoPlanEnabled`) + a ' +
        '"ready-set threshold" stepper (`aiAutoPlanThreshold`, disabled until ' +
        'the switch is on, validated ≥ 1).\n' +
        '- **AI sprint planning** — an enable switch ' +
        '(`aiSprintPlanningEnabled`) + a "sprint length (days)" stepper ' +
        '(`aiSprintLengthDays`, default 2–3, disabled until on, range-' +
        'validated) with the coding-agent-cadence helper copy.\n' +
        '- **Explanation generation** — the 7.3 toggle surfaced here (read + ' +
        'write the 7.3-owned column; do NOT duplicate it).\n' +
        '- **Planner model** — a `Combobox`/`DropdownMenu` of the allowed ' +
        'planner models (`aiPlannerModel`, falls back to the 7.2.2 default).\n' +
        '- The Principle-#1 guardrail copy ("auto-plan PROPOSES for your ' +
        'approval — it never creates work without you") + the AI-not-' +
        'provisioned + non-admin read-only states from 7.11.1.\n\n' +
        '**4-layer + data flow.** The panel is a client component that calls a ' +
        'settings route → the project settings service → the 7.11.2 ' +
        'repository methods (it never touches the service/Prisma directly). ' +
        'Saves persist through the existing project-settings update path (match ' +
        'the existing save/auto-save UX); validation errors from 7.11.2 surface ' +
        'inline.\n\n' +
        '**Tokens + a11y + i18n.** References ONLY `--el-*` colour + ' +
        '`[data-display-style]` shape tokens (no Tier-0 utilities — the ' +
        '`motir-core/CLAUDE.md` colour/shape rules); the switches/steppers/' +
        'combobox are keyboard-reachable with aria-labels; helper text is ' +
        'associated via `aria-describedby`; gated by the same role that governs ' +
        'the other project settings (non-admin → read-only). New copy lands in ' +
        'an `aiSettings` i18n namespace across the shipped locale set.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The panel renders the 7.11.1 controls (auto-plan enable + threshold; ' +
        'sprint-planning enable + length; planner model) PLUS the surfaced 7.3 ' +
        'explanation toggle, as a section among the existing project settings — ' +
        'composed of the named primitives, `--el-*` tokens only.\n' +
        '- Each setting reads from + writes to its 7.11.2 `Project` column (the ' +
        'explanation toggle to its 7.3-owned column) through the settings ' +
        'service; dependent controls are disabled when their parent toggle is ' +
        'off; validation (threshold ≥ 1, length in range) surfaces inline.\n' +
        '- The AI-not-provisioned + non-admin read-only states render per ' +
        '7.11.1; the Principle-#1 guardrail copy is present.\n' +
        '- A11y: keyboard-reachable controls, aria-labels on the switches/' +
        'steppers/combobox, helper text linked via `aria-describedby`; no ' +
        'client component touches the service layer directly; copy is i18n’d in ' +
        'the `aiSettings` namespace.\n\n' +
        '## Context refs\n\n' +
        '- 7.11.1 — the design asset (the panels this implements verbatim).\n' +
        '- 7.11.2 — the `Project` AI-settings columns + the settings service/' +
        'DTO this reads/writes.\n' +
        '- The existing project-settings surface (`workflowPolicyMode` / ' +
        '`estimationStatistic` / `pointScale` rows) — the section to extend + ' +
        'the save UX to match.\n' +
        '- Story 7.3 — the explanation-generation toggle column surfaced (not ' +
        'duplicated) here.\n' +
        '- `motir-core/components/ui/` (`Switch`/`Toggle`, stepper, ' +
        '`Combobox`/`DropdownMenu`) + `app/globals.css` (`--el-*` + shape ' +
        'tokens).',
      dependsOn: ['7.11.1', '7.11.2'],
    },
    {
      id: '7.11.7',
      title:
        'Vitest — cadence trigger fires at threshold + sprint packing respects deps/length + settings persist',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'Lock the cadence on both sides. motir-core tests run over a real ' +
        'Postgres (the project convention; `tests/helpers/db.ts` truncates ' +
        'between tests; the only allowed `vi.mock` is `getSession()`). The ' +
        'motir-ai LLM call (the packing-annotate step) is stubbed at the SDK ' +
        'boundary — but the deterministic SCHEDULER, the delta schema, the ' +
        'cadence trigger, and the persist path are exercised for real.\n\n' +
        '**motir-ai — `plan_sprint` scheduler:**\n\n' +
        '- Over a fixture ready set with is_blocked_by edges, the returned ' +
        'packing is DEPENDENCY-CORRECT (no item in a sprint before a blocker — ' +
        'topological-order assertion) and conforms to the versioned ' +
        'sprint-assignment schema.\n' +
        '- Each sprint respects `aiSprintLengthDays` + the per-sprint capacity ' +
        '(an over-length item gets its own sprint / a clear flag, never ' +
        'silently dropped); the packing drains the ready set across the fewest ' +
        'sprints.\n' +
        '- A dependency CYCLE → a typed error (not an infinite loop / silent ' +
        'misorder).\n\n' +
        '**motir-core — cadence engine + sprint persist + settings:**\n\n' +
        '- **Cadence trigger (7.11.3):** with `aiAutoPlanEnabled = true` and ' +
        'the ready set seeded BELOW `aiAutoPlanThreshold`, one cron tick submits ' +
        'exactly ONE expand/augment job (assert the client was called once); ' +
        'with the ready set AT/ABOVE threshold, or with auto-plan OFF, NO job ' +
        'fires; with a pending auto-proposal already present, the next tick does ' +
        'NOT re-fire (debounce). A submit failure for one project does not abort ' +
        'the sweep for another.\n' +
        '- **Sprint persist (7.11.5):** `POST /api/ai/plan/sprint/approve` ' +
        'persists an approved fixture packing through the EPIC-4 sprint services ' +
        '(assert via a repository read — the allowed cross-layer reach): the ' +
        'sprints exist + the items are assigned, tempIds resolved; the ' +
        'approve-side re-validation rejects a delta that violates the DAG or ' +
        'references a non-ready item with a 400 BEFORE any write (DB unchanged); ' +
        'an empty delta is a no-op; atomicity holds (one forced failure rolls ' +
        'the whole approve back).\n' +
        '- **Settings (7.11.2):** the five `Project` columns persist + ' +
        'round-trip + default to OFF/safe; `aiAutoPlanThreshold < 1` and an ' +
        'out-of-range `aiSprintLengthDays` are rejected with a typed error.\n' +
        '- Auth: 401 without session; 404 on a cross-tenant project; 6.4 ' +
        'permissions honored; sprint-planning refused when disabled.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The above cases pass on both sides; the motir-core suite runs over a ' +
        'real Postgres (no mocks beyond `getSession()`); the motir-ai suite ' +
        'stubs only the LLM SDK boundary (the scheduler itself is tested for ' +
        'real).\n' +
        '- The cadence trigger is proven to fire EXACTLY at the threshold ' +
        'boundary (below → fires; at/above → not; off → not; debounced → not), ' +
        'not asserted.\n' +
        '- New motir-core service/repo code respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage); no untested branch in the cadence ' +
        'engine or the sprint-persist service.\n\n' +
        '## Context refs\n\n' +
        '- 7.11.3 (the cadence engine under test), 7.11.4 (the scheduler), ' +
        '7.11.5 (the persist service), 7.11.2 (the settings columns).\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + coverage gate.\n' +
        '- The Epic-4 sprint services + the 7.0 ready-set query — asserted ' +
        'against.',
      dependsOn: ['7.11.3', '7.11.5'],
    },
    {
      id: '7.11.8',
      title:
        'Playwright E2E — enable short-sprint cadence + auto-plan; observe sprints planned + expansion auto-fired',
      status: 'blocked',
      type: 'e2e',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'End-to-end browser test (`tests/e2e/ai-cadence.spec.ts`) closing the ' +
        'story from the user’s seat: a project manager turns on the cadence ' +
        'settings, AI sprint planning produces a packing they approve, and an ' +
        'auto-expansion fires when the ready set drains. To keep CI ' +
        'deterministic, the `plan_sprint` + expand jobs are backed by RECORDED ' +
        'fixture deltas (the same boundary stub 7.11.7 uses — no live LLM), and ' +
        'the cron tick is driven explicitly (a test trigger advancing the 1.6 ' +
        'scheduler), so the test asserts the UI + cadence loop + the real ' +
        'persist, not model quality or wall-clock timing.\n\n' +
        '**The spec.**\n\n' +
        '1. Sign in as `zhuyue@motir.co` (the project manager) on the seeded ' +
        '`moooon`/`motir` tenant with a `PROD` project that has a planned tree ' +
        '+ a populated ready set.\n' +
        '2. Open the AI-planning settings panel (7.11.6): toggle **Auto-plan** ' +
        'on, set a threshold; toggle **AI sprint planning** on, set sprint ' +
        'length to 2 days; save. Reload and assert every setting round-tripped.\n' +
        '3. **AI sprint planning:** trigger sprint planning; assert the ' +
        'proposed packing renders (short sprints sized to 2 days, ' +
        'dependency-correct order). Approve; assert the Epic-4 sprint board now ' +
        'shows the created sprints with the items assigned, and that a ' +
        'generate-then-discard run persisted NO sprints (approve is the only ' +
        'write).\n' +
        '4. **Auto-plan cadence:** drive the ready set below the threshold ' +
        '(mark enough ready items in-progress/done) and advance the cron via ' +
        'the test trigger. Assert an expand/augment proposal AUTO-appears in the ' +
        '7.4 review surface, flagged as cadence-initiated, WITHOUT a click — and ' +
        'that it is a PROPOSAL awaiting approve (nothing auto-written). Toggle ' +
        'auto-plan OFF, advance the cron again, assert NO new proposal appears.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e ai-cadence` passes locally + in CI, backed by the ' +
        'recorded fixture deltas + the explicit cron trigger (no live model, no ' +
        'wall-clock waits).\n' +
        '- The spec uses the existing `signIn(page, email, password)` helper ' +
        'and the established navigation patterns; settings round-trip on ' +
        'reload.\n' +
        '- The approve step creates real sprints on the Epic-4 board with items ' +
        'assigned; the discard step writes nothing.\n' +
        '- The cadence step shows an auto-fired expansion proposal (flagged ' +
        'cadence-initiated, awaiting approve) when ready < threshold, and NONE ' +
        'when auto-plan is off.\n' +
        '- Not flake-prone: explicit waits on the proposal-rendered + ' +
        'sprint-created states (no fixed sleeps; the cron is triggered, not ' +
        'awaited).\n\n' +
        '## Context refs\n\n' +
        '- 7.11.6 (the settings panel under test), 7.11.5 (the sprint approve ' +
        'path), 7.11.3 (the cadence engine + its test cron trigger), 7.11.4 ' +
        '(the fixture-delta boundary the E2E stubs at).\n' +
        '- `motir-core/tests/e2e/ready.spec.ts` (7.0.8) — the E2E patterns ' +
        '(sign-in helper, navigation, aria-live waits) to mirror.\n' +
        '- The Epic-4 sprint board — the surface the approved sprints appear ' +
        'on.\n' +
        '- `motir-core/scripts/plan-seed/` — the seeded tenant + how to fixture ' +
        'the ready set + the recorded deltas for the run.',
      dependsOn: ['7.11.6'],
    },
  ],
};
