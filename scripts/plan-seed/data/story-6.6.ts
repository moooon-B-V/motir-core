import type { PlanStory } from '../types';

/**
 * Story 6.6 — Automation rules.
 *
 * The when/then rule engine, project-scoped: a rule = **trigger →
 * condition(s) → action(s)**, evaluated ASYNCHRONOUSLY off the
 * channel-agnostic job events Epics 2+5 emit, executed via the Story 1.6
 * Inngest pipeline, with actions flowing through the SHIPPED services (never
 * raw writes) so permissions, revisions, and notifications stay consistent.
 * A per-rule execution **audit log** + enable/disable + bounded caps make it
 * a real-product surface, not a demo hook.
 *
 * Mirror-product check (decision-ladder rung 1 — VERIFIED against Atlassian
 * cloud-automation docs at plan time, 2026-06-10):
 *   • **Rule anatomy** — Jira rules are trigger → conditions → actions, one
 *     trigger per rule; branches (related-item paths) and smart values are
 *     additional components. Ours ships the canonical three; branches +
 *     smart values are the documented extension (they are where a rule
 *     engine becomes a scripting language).
 *   • **Scope + permissions** — Jira has project-scoped rules (managed by
 *     project admins, in project settings) and global/multi-project rules
 *     (site admins only). Ours: project-scoped only, admin-gated via the
 *     shipped 6.4 manage-project permission — the stub's scope; the
 *     global/workspace tier is the documented extension.
 *   • **Rule actor** — Jira attributes rule actions to a configurable rule
 *     actor, defaulting to the synthetic "Automation for Jira" app user.
 *     **Recorded deviation:** ours runs actions as the RULE OWNER (the
 *     admin who created the rule — Jira's own configurable-actor shape,
 *     just without the synthetic default): a per-workspace synthetic user
 *     would leak into every member-bounded surface the shipped reads
 *     enumerate (pickers, mentions, boards, assignable members) for no
 *     stated use case. The audit log + automation provenance on emitted
 *     events keep attribution honest; the dedicated system actor is the
 *     documented extension.
 *   • **Loop prevention** — Jira's DEFAULT is that a rule does NOT fire
 *     when its trigger event was caused by another rule's action; chaining
 *     is opt-in ("Allow rule trigger") with a loop-detection depth limit of
 *     10. Ours ships the default only: events emitted from
 *     automation-executed actions carry `viaAutomationRuleId` provenance
 *     and the engine skips them, period. The opt-in chaining toggle is the
 *     documented extension (no chaining use case yet — no complexity for
 *     nothing).
 *   • **Audit log + failure handling** — Jira keeps a per-rule execution
 *     log (success / failure / no-actions, per-step detail, **90-day
 *     retention**), notifies the rule owner on error (deduped to the first
 *     failure after a success), and AUTO-DISABLES runaway rules (scheduled
 *     rules at 10 consecutive failures; limit-breaching rules immediately).
 *     Ours ships all three shapes: the bounded audit log with a 90-day
 *     retention sweep, the owner error email (first-failure-after-success
 *     dedupe) via the 1.6 email pipeline, and auto-disable at 10
 *     consecutive failures.
 *   • **Execution model** — Jira rules run asynchronously through a rule
 *     processing queue, never inline with the triggering action. Ours
 *     matches 1:1: the engine is an Inngest job consuming the post-commit
 *     events — the 1.6 pipeline IS the rule-processing queue.
 *   • **Triggers / actions / conditions (the verified core sets)** — Jira's
 *     most-used triggers: created, transitioned, field value changed,
 *     commented (+ scheduled and ~30 more); most-used actions: edit fields,
 *     transition, assign, comment (+ manage watchers and ~60 more);
 *     conditions: issue-fields condition + JQL condition (+ if/else,
 *     user condition). Ours ships exactly the verified core: four triggers
 *     (created / transitioned / field-changed / commented — "assigned" is
 *     the field-changed trigger preset on assignee), the stub's action set
 *     grown to Jira's verified top tier (set field incl. custom fields,
 *     transition, add watcher, add comment, add label), and conditions as
 *     ONE flat match-all/any group of 6.1 FilterAST rows evaluated against
 *     the triggering item — the issue-fields/JQL-condition analogue with
 *     zero new predicate machinery.
 *
 * Architecture: `automation_rule` (typed trigger config + the 6.1 FilterAST
 * as the condition group + a typed action list, validated by TOTAL
 * trigger/action registries — mistake #29) + `automation_rule_execution`
 * (the audit trail). The engine compiles the condition AST through the
 * 6.1.1/6.1.2 compiler scoped to the triggering work item (one indexed
 * query), executes actions through the shipped services as the rule owner,
 * and writes the audit row — idempotent per (event × rule), replay-safe.
 * New events this story adds: `work-item/created` + `work-item/field.changed`
 * emitted post-commit by the SHIPPED workItemsService (riding the 1.4.6
 * revision-diff machinery for changed-field ids) — the same events the 5.7
 * stub already anticipates for assignment notifications ("as Stories 5.4 +
 * 6.6 land").
 *
 * ⚠️ Design gate (planning-time). No automation surface exists under
 * `design/` (listed: projects/ has access-members + fields only) → subtask
 * **6.6.4** is the `type: design` subtask (`design/projects/
 * automation.mock.html`, riding the 6.5.1 settings-AREA chrome — Story 6.5
 * reserves the Automation nav slot this surface mounts in; the condition
 * rows reuse the 6.1.3 builder grammar). The UI code subtasks
 * (6.6.5 / 6.6.6) carry it in `dependsOn` and seed `'blocked'`
 * (Principle #13).
 *
 * The stub's "small built-in action set for v1" is reframed per the
 * no-V1-tier rule: the action set is small because Jira's verified top tier
 * IS small, and every exclusion below is a documented extension slot with a
 * justification, not an unowned "later".
 *
 * Cross-epic dependency audit: clean — every dep points at Epic ≤ 6
 * (6.1.x same-epic-earlier; 5.x backward; 1.6 + 6.4 are done substrate).
 *
 * Expanded from its `stubs.ts` entry per `motir plan 6.6`, on the standing
 * `seed/epic-5-plan` branch (Epic-5/6 planning). Matches the canonical style
 * of 5.1–5.6 / 6.1.
 */
export const story_6_6: PlanStory = {
  id: '6.6',
  title: 'Automation rules',
  status: 'planned',
  descriptionMd:
    'The when/then rule engine, project-scoped: a rule = **one trigger → one flat condition ' +
    'group → an ordered action list**, evaluated asynchronously off the channel-agnostic job ' +
    'events (Epics 2+5) through the Story 1.6 Inngest pipeline — the queued execution model ' +
    'the mirror runs (verified: Jira rules execute through a rule-processing queue, never ' +
    'inline). Actions execute through the SHIPPED services — `workflowsService` transitions, ' +
    '`workItemsService` field writes, `watchersService`, `commentsService`, `labelsService`, ' +
    '`customFieldsService` — never raw writes, so workflow legality, permissions, revision ' +
    'rows, and downstream notifications behave exactly as if a person did it.\n\n' +
    '**The verified core sets (rung 1 — Atlassian cloud-automation docs, 2026-06-10).** ' +
    'Triggers: **work item created / transitioned (with optional from→to status narrowing) / ' +
    'field value changed (field picker; "assigned" is its assignee preset) / commented** — ' +
    "Jira's four most-used issue-event triggers. Actions: **transition, set field (built-ins " +
    "+ every 5.3 custom-field type), add watcher, add comment, add label** — the stub's set " +
    "grown to Jira's verified top tier. Conditions: ONE flat **match all / match any** group " +
    'of 6.1 FilterAST rows evaluated against the triggering item — the issue-fields/JQL-' +
    'condition analogue, reusing the 6.1.1/6.1.2 TOTAL operator registry + safe compiler ' +
    'wholesale (zero new predicate machinery; the registry stays the single predicate ' +
    'authority).\n\n' +
    '**The rule actor (recorded deviation).** Jira defaults rule attribution to a synthetic ' +
    '"Automation for Jira" user with a configurable actor; ours runs actions as the **rule ' +
    "owner** (the project admin who created it — Jira's own configurable-actor shape minus " +
    'the synthetic default), because a per-workspace synthetic user would leak into every ' +
    'member-bounded surface the shipped reads enumerate (assignable members, mention pickers, ' +
    'boards) for no stated use case. The audit log + event provenance keep attribution ' +
    'honest; the dedicated system actor is the documented extension.\n\n' +
    '**Loop prevention (the Jira default, hard-shipped).** Every event emitted from an ' +
    'automation-executed action carries `viaAutomationRuleId` provenance, and the engine ' +
    'NEVER fires a rule off a provenance-carrying event — the verified Jira default (rules ' +
    'don\'t trigger rules). The "Allow rule trigger" opt-in chain + depth-10 loop detection ' +
    'is the documented extension when a chaining use case lands.\n\n' +
    '**Real-product operations (finding #57 — bounded everywhere).** A per-rule execution ' +
    '**audit log** (`automation_rule_execution`: success / failure / no-actions-performed, ' +
    'error detail, duration, the triggering item), paginated, with the Jira-verified **90-day ' +
    'retention** enforced by a cron sweep; **auto-disable at 10 consecutive failures** (the ' +
    'Jira number) with the disabled state surfaced in the UI; an **owner error email** on the ' +
    'first failure after a success (the verified dedupe rule) via the 1.6 email pipeline; ' +
    'idempotent execution per (event × rule) so Inngest replays never double-fire actions; ' +
    'caps — **100 rules per project, 10 actions per rule, the 6.1 20-row condition cap** — ' +
    'each a typed 422 with a designed state, never a silent truncation.\n\n' +
    '**Out of scope (documented extension slots, each justified):** scheduled/cron triggers ' +
    '(need a saved-filter item-selection substrate — Story 6.2 ships it; revisit after); ' +
    'branches + smart values (where a rule engine becomes a scripting language); global / ' +
    "multi-project rules (Jira gates these on site admins; Motir's admin substrate is " +
    'project-scoped today); the "Allow rule trigger" chaining opt-in (above); send-email / ' +
    'webhook / create-item actions (each drags a new surface — templates, outbound HTTP ' +
    'policy, kind-parent rules — additive registry entries when a use case lands); monthly ' +
    'usage quotas (the open-core billing boundary — Epic 8.1 owns metering); a manual ' +
    '"run rule now" trigger (cheap but unowned by any use case yet).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (the 6.6.1 ' +
    'automation tables apply cleanly; re-run reports "No difference detected"), ' +
    '`pnpm db:seed`, `pnpm dev` (+ the Inngest dev server per the E2E harness notes).\n' +
    '- `pnpm test:coverage` — Vitest (real Postgres) over the registries, the engine ' +
    '(trigger × condition × action matrix, loop prevention, idempotency, auto-disable), ' +
    'and the CRUD service ≥90% per-file branch/fn/line.\n' +
    '- **Author flow:** sign in as `zhuyue@motir.co` / `!QAZ1qaz` → project settings → ' +
    'Automation (matching `design/projects/automation.mock.html`). Create: "when an item ' +
    'transitions to Done, if Kind is any of (Bug), then add watcher Bo + comment ' +
    "'Verify the fix'\" — the editor builds when/if/then rows from the registries; the " +
    'rule lists enabled with owner + last-run.\n' +
    '- **Firing:** move a Bug to Done in the board → within the async window the watcher ' +
    "appears, the comment lands attributed to the rule owner, and the rule's audit log " +
    'shows a Success row (trigger item, duration); a non-Bug transition logs ' +
    'no-actions-performed (condition gated); a viewer (6.4 role) cannot see or edit the ' +
    'Automation settings surface.\n' +
    '- **Set-field + CF:** a field-changed-trigger rule (Priority changed → set CF ' +
    '"Severity" to High) fires off a priority edit and writes the CF value through the ' +
    '5.3 service (revision row + rail update included); the assignee preset fires on ' +
    'assignment.\n' +
    '- **Loop prevention:** a rule whose action would satisfy its own trigger (transition ' +
    '→ transition) executes ONCE — the provenance-carrying event is skipped, the audit ' +
    'log shows the single run, no cascade.\n' +
    "- **Failure handling:** point a rule's transition action at a workflow-illegal " +
    'target → the run logs Failure with the typed error; the owner email arrives once ' +
    '(first-failure-after-success dedupe); after 10 consecutive failures the rule shows ' +
    'auto-disabled with the designed banner; re-enabling resets the counter.\n' +
    '- **Caps + retention:** the 101st rule / 11th action / 21st condition row each hit ' +
    'the typed 422 + designed state; the retention sweep deletes only audit rows older ' +
    'than 90 days (spot-check with a back-dated row).\n' +
    '- `pnpm test:e2e --grep automation` — Playwright over the real stack: the ' +
    'author → fire → audit journey.\n' +
    '- **a11y check:** the Automation settings pages (list, editor with every row kind ' +
    'open, audit log) pass the strict axe sweep; fully keyboard-operable; colour via ' +
    '`--el-*`, shape via element tokens.',
  items: [
    {
      id: '6.6.1',
      title:
        'Schema + TOTAL trigger/action registries + `automationRulesService` CRUD (admin-gated, enable/disable, caps) + routes',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 32,
      dependsOn: ['6.1.1'],
      descriptionMd:
        "The rule model and the authoring surface's backend. Pure backend — no UI, no " +
        'engine yet.\n\n' +
        '**Schema (FKs as Prisma relations, both sides):** `automation_rule` — projectId, ' +
        'name, enabled, triggerType + typed triggerConfig JSON, conditionAst JSON (the ' +
        '6.1 FilterAST shape, row-capped 20), actions JSON (ordered, max 10), ownerId ' +
        '(the rule actor — the recorded deviation), consecutiveFailureCount, timestamps; ' +
        '`automation_rule_execution` — ruleId, status enum (success / failure / ' +
        'no_actions), triggering workItemId (nullable — the item may be deleted later), ' +
        'error text, durationMs, createdAt; indexed `[ruleId, createdAt]` for the paged ' +
        'log + the retention sweep.\n\n' +
        '**`lib/automation/registry.ts`** — TWO TOTAL registries (mistake #29). ' +
        'Triggers: `created` / `transitioned` (optional from/to status-id narrowing) / ' +
        '`field-changed` (built-in-field picker config; `assignee` is the "assigned" ' +
        'preset) / `commented` — each entry = config schema + validate + the event name ' +
        'it consumes + the UI editor kind. Actions (this subtask: the shipped-substrate ' +
        'entries): `transition` (target status id) / `set-field` (built-ins the shipped ' +
        '`workItemsService.update` accepts — assignee, priority, due date, story ' +
        'points) — each entry = config schema + validate + execute fn signature + editor ' +
        'kind. Unknown trigger/action/field ids → typed 422; the enumeration test fails ' +
        'on any registry gap. Epic-5 entries (watcher / comment / label / custom-field) ' +
        'land in 6.6.3 as registry EXTENSIONS — same pattern as 6.1.1→6.1.2.\n\n' +
        '**`automationRulesService` + routes** (4-layer): create / update / enable / ' +
        'disable / delete / list / get, gated by the shipped 6.4 manage-project ' +
        'permission (viewers get 403/404 per the 6.4 read rules); validation composes ' +
        'the trigger/action registries + the 6.1.1 condition-AST validation (built-in ' +
        'fields here); caps — 100 rules/project, 10 actions/rule, 20 condition rows — ' +
        'as typed 422s; enable resets consecutiveFailureCount; delete cascades the ' +
        'execution log (Prisma onDelete).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Migration applies cleanly (re-run: no drift); both tables modelled with ' +
        'relations on both sides per the CLAUDE.md FK rule.\n' +
        "- Both registries are TOTAL with enumeration tests (every entry's " +
        'config-schema × validate × editor triple); malformed/unknown configs → 422 ' +
        '(fuzzed, incl. smuggled field ids through the condition AST — the 6.1 ' +
        'injection posture extends here).\n' +
        '- CRUD + enable/disable + caps behave per the description; admin-gating ' +
        'asserted per 6.4 role (admin yes, member no, viewer no); a rule referencing a ' +
        'since-deleted status/field degrades typed (the 6.1 stale-referent rule), ' +
        'never crashes validation.\n' +
        '- `pnpm test:coverage` ≥90% on the new files.\n\n' +
        '## Context refs\n\n' +
        '- 6.1.1 `lib/filters/ast.ts` + registry (the condition substrate + the ' +
        'totality/422 pattern to mirror)\n' +
        '- `lib/services/projectAccessService.ts` + the 6.4 role checks (the ' +
        'admin gate); `workflowsService` (status ids for transition configs)\n' +
        '- The verified Jira anatomy/scope/actor facts in the Story 6.6 description\n' +
        '- `motir-core/CLAUDE.md` (4-layer, FK-as-relation, required-tx)',
    },
    {
      id: '6.6.2',
      title:
        'Execution engine — `work-item/created` + `work-item/field.changed` events, the rule-run Inngest job (match → conditions → actions-as-owner), loop prevention, audit writes, auto-disable + owner error email, retention sweep',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 38,
      dependsOn: ['6.6.1'],
      descriptionMd:
        'The heart of the story: events in, attributed service calls out, every run ' +
        'audited.\n\n' +
        '**New events (rung-2 emit points):** `work-item/created` (post-commit from the ' +
        'shipped `workItemsService` create path) and `work-item/field.changed` ' +
        '(post-commit from its update path, carrying the changed built-in field ids the ' +
        '1.4.6 revision-diff machinery already computes) — typed in `JobEventDataMap`, ' +
        'workspace-scoped, emit-on-commit-only (the 5.1.2/5.4.5 rule: a rolled-back tx ' +
        'emits nothing). Payloads carry `viaAutomationRuleId?: string` provenance — ' +
        'these are the same events the 5.7 stub anticipates for assignment ' +
        'notifications.\n\n' +
        "**The engine job** (a 1.6 `defineJob` per consumed event): load the project's " +
        'ENABLED rules matching the trigger (narrowed by trigger config — from/to ' +
        'status, field id); **skip any event carrying provenance** (the Jira-default ' +
        "loop rule — no rule fires off another rule's action, ever); evaluate the " +
        "condition group by compiling the rule's FilterAST through the 6.1.1 compiler " +
        'scoped to the triggering item (`AND id = :workItemId` — one indexed query; ' +
        'empty group = pass); execute the action list IN ORDER through the shipped ' +
        'services as the rule owner (this subtask: `transition` via `workflowsService` ' +
        '— workflow-illegal target = a recorded failure, not a bypass; `set-field` via ' +
        '`workItemsService.update`), stamping provenance on every event those service ' +
        'calls emit; write the `automation_rule_execution` row (success / failure with ' +
        'the typed error / no_actions when the condition gates). **Idempotent per ' +
        '(event × rule)** — Inngest replays and retries never double-execute actions ' +
        '(the 5.1.6/5.4.5 idempotency pattern, keyed on event id × rule id).\n\n' +
        '**Failure ops:** a failed run increments consecutiveFailureCount; at 10 the ' +
        'rule auto-disables (the verified Jira number); a success resets the counter; ' +
        'the owner gets the error email on the FIRST failure after a success only (the ' +
        'verified dedupe) — a new `lib/emailTemplates/automationRuleFailed.tsx` through ' +
        'the 1.6 email pipeline. **Retention:** a daily cron sweep (the 1.6.4 ' +
        'system-job pattern) deletes execution rows older than 90 days (the verified ' +
        'Jira retention), batched.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Both events typed + emitted post-commit only (rollback emits nothing — ' +
        'asserted); existing create/update tests stay green; payloads carry changed ' +
        'field ids + provenance.\n' +
        '- The matrix holds: matching rules fire, trigger-config narrowing works ' +
        '(from/to, field id, the assignee preset), conditions gate (pass / fail / ' +
        'empty-group), actions execute in order attributed to the owner with real ' +
        'revision rows, and a workflow-illegal transition logs Failure without ' +
        'corrupting state.\n' +
        '- Loop proof: a self-triggering rule (transition → transition) runs exactly ' +
        'once — the provenance-stamped follow-on event is skipped (asserted via the ' +
        'audit log + event payloads).\n' +
        '- Replay/retry double-executes nothing (idempotency per event × rule); ' +
        'failure counting, auto-disable at 10, counter reset on success/re-enable, ' +
        'and the first-failure-only email all asserted; the sweep deletes only >90d ' +
        'rows.\n' +
        '- `pnpm test:coverage` ≥90%; the engine lives in services/jobs per the ' +
        '4-layer rule (no raw writes anywhere on the action path).\n\n' +
        '## Context refs\n\n' +
        '- `lib/jobs/*` (1.6 — defineJob, sendEvent, typed event map, idempotency + ' +
        'DLQ patterns); `lib/jobs/definitions/dailyHealthCheck.ts` (the cron-sweep ' +
        'exemplar)\n' +
        '- 6.6.1 (registries + schema); 6.1.1 (the compiler the conditions ride)\n' +
        '- `workItemsService` create/update + the 1.4.6 revision-diff machinery (the ' +
        'emit points); `workflowsService.updateStatus` (transition legality)\n' +
        '- The 5.1.6/5.4.5 idempotent-notification-job pattern + the 5.1.2 ' +
        'emit-on-commit rule; the verified Jira loop/failure/retention facts in the ' +
        'Story 6.6 description',
    },
    {
      id: '6.6.3',
      title:
        'Epic-5 registry extensions — commented + transitioned triggers, add-watcher / add-comment / add-label / set-custom-field actions, Epic-5 condition rows',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['6.6.2', '6.1.2', '5.1.2', '5.3.3', '5.4.2', '5.4.4', '5.4.5'],
      descriptionMd:
        'The registry + engine extensions consuming the Epic-5 surfaces — the same ' +
        'extension pattern as 6.1.2 over 6.1.1.\n\n' +
        "**Triggers:** `commented` consumes `work-item/comment.created` (5.1.2's " +
        'emit — a third consumer, no new emit path) and `transitioned` consumes ' +
        "`work-item/transitioned` (5.4.5's emit), both honoring provenance skip; " +
        'both events grow the `viaAutomationRuleId?` field if 5.1.2/5.4.5 landed ' +
        'without it.\n\n' +
        '**Actions:** `add-watcher` (a member picker config) via `watchersService` ' +
        '(5.4.4 — its view-access validation applies; an ineligible user = a recorded ' +
        'failure); `add-comment` (a fixed-body config) via `commentsService` (5.1.2 — ' +
        "mention parsing applies; the comment's own event carries provenance so " +
        'mention emails still send but no rule re-fires); `add-label` (type-to-create ' +
        'config) via `labelsService` (5.4.2 find-or-create semantics); ' +
        '`set-custom-field` (per-type value config — select option / user / number / ' +
        'date / text) via `customFieldsService` values (5.3.3 — per-type validation + ' +
        'revision diffs apply). Each is a TOTAL registry entry (config schema + ' +
        'validate + execute + editor kind); stale referents (deleted option/label/' +
        'field/user) degrade to a recorded failure with the typed error, never a ' +
        'crash.\n\n' +
        "**Conditions:** the rule editor's field vocabulary grows the 6.1.2 dynamic " +
        'entries (custom fields, labels, components) — the condition compiler already ' +
        'handles them; this subtask wires validation + the editor-kind contract.\n\n' +
        '## Acceptance criteria\n\n' +
        '- All four new actions execute through their owning services with full ' +
        'side-effect fidelity (watcher emails fan out per 5.4.5, mention parsing runs, ' +
        'revision rows land) attributed to the rule owner; provenance stamps every ' +
        'follow-on event (loop proof extends: comment-trigger rule + add-comment ' +
        'action runs once).\n' +
        '- Both new triggers narrow correctly (transitioned from/to) and skip ' +
        'provenance events; registry totality preserved (enumeration tests cover the ' +
        'extensions); stale-referent configs fail typed per referent kind.\n' +
        '- Epic-5 condition rows gate rules correctly (CF / label / component ' +
        'predicates via the 6.1.2 joins, spot-checked with EXPLAIN on the large ' +
        'seed).\n' +
        '- `pnpm test:coverage` ≥90% on the extensions.\n\n' +
        '## Context refs\n\n' +
        '- 6.6.1/6.6.2 (the registries + engine extension points)\n' +
        '- 5.1.2 `commentsService` + its event; 5.4.4 `watchersService`; 5.4.2 ' +
        '`labelsService`; 5.3.3 `customFieldsService` values; 5.4.5 ' +
        '`work-item/transitioned`\n' +
        '- 6.1.2 (the dynamic condition entries + stale-referent rule)\n' +
        '- The verified Jira action list in the Story 6.6 description (the top-tier ' +
        'justification)',
    },
    {
      id: '6.6.4',
      title:
        'Design — Automation settings (`design/projects/automation.mock.html`: rule list, when/if/then editor, audit log, failure/cap states)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 38,
      dependsOn: ['6.5.1'],
      descriptionMd:
        'The design asset for the whole surface — nothing under `design/` covers ' +
        'automation (the design-gate NONE-exists case). Output: ' +
        '**`design/projects/automation.mock.html`** + PNG + a section in ' +
        '`design/projects/design-notes.md`, built from the real design system. Render ' +
        'checklist + AA + dark parity. Mirrors: the 6.5.1 settings-AREA chrome ' +
        '(grouped nav + page frame — Automation occupies the nav slot Story 6.5 ' +
        'reserves; design the pages INSIDE that chrome, never a second frame); ' +
        "Jira's rule builder for the when/if/then vocabulary; the 6.1.3 " +
        'filter-builder grammar for the condition rows (the SAME row anatomy — do ' +
        'not invent a second predicate UI).\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **The rule list** (the Automation page in the 6.5 settings area): ' +
        'name, enabled toggle, owner, last-run status glyph + time, per-rule overflow ' +
        '(edit / disable / delete / view log); the empty state ("No rules yet" + ' +
        'create); the auto-disabled banner state (failure count + re-enable); the ' +
        '100-rule cap state; the viewer-excluded rule (this page is admin-only — ' +
        'note the 6.4 gate, no viewer variant needed).\n' +
        '- **The editor** — the when/if/then column: **When** (trigger picker + its ' +
        'config editor per kind: status from/to comboboxes for transitioned, the ' +
        'built-in/CF field picker for field-changed with the "Assignee" preset ' +
        'surfaced, none for created/commented); **If** (the 6.1.3 condition-row ' +
        'grammar — match all/any + field/operator/value rows + the 20-row cap; the ' +
        'empty "always" state); **Then** (ordered action rows: action picker + ' +
        'per-action config editor — status target, field + value editors per type, ' +
        'member picker, comment body, label type-to-create; add/remove/reorder; the ' +
        '10-action cap); name field; save/cancel; validation states (unknown/stale ' +
        'referent rows, the typed 422 surfaces).\n' +
        '- **The audit log** (per rule): paginated rows — status pill (Success / ' +
        'Failure / No actions), triggering item key + link, duration, time, the ' +
        'expandable error detail on failures; the empty state; the 90-day retention ' +
        'note line.\n' +
        '- **The nav entry** — the Automation item in the 6.5.1 grouped settings ' +
        'nav (the reserved slot), in its active/inactive states.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The mockup + PNG + notes exist, composed from shipped primitives ' +
        '(`Combobox`, `MultiSelectPicker`, `Pill`, `Modal`/page chrome per the ' +
        'settings grammar, the 6.1.3 condition rows) + token tiers; render checklist ' +
        '+ AA + dark parity pass.\n' +
        '- Panels cover: list (populated, empty, auto-disabled, cap), the editor ' +
        'with EVERY trigger-config kind and EVERY action-config kind open at least ' +
        'once, condition rows (incl. cap + stale-referent), the audit log ' +
        '(populated, empty, failure expanded), and the hub card.\n' +
        '- `design-notes.md` names the editor-kind ↔ registry mapping (the ' +
        '6.6.1/6.6.3 UI contract), the when/if/then copy, the last-run glyph ' +
        'vocabulary, and records the condition-row reuse of 6.1.3.\n' +
        '- No improvised primitive; token needs recorded.\n\n' +
        '## Context refs\n\n' +
        '- `design/projects/settings-area.mock.html` + notes (6.5.1 — the area ' +
        'chrome + the reserved Automation nav slot); `fields.mock.html` (a sibling ' +
        'settings page for content-density reference)\n' +
        '- `design/work-items/filter-builder.mock.html` (6.1.3 — the condition-row ' +
        'grammar to reuse)\n' +
        '- The verified Jira rule-builder anatomy in the Story 6.6 description\n' +
        '- Findings #35/#54; the design-mockup render checklist',
    },
    {
      id: '6.6.5',
      title:
        'Automation settings UI — rule list + when/if/then editor (registry-driven rows, enable/disable, caps, validation states)',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: ['6.6.1', '6.6.4', '6.1.4', '6.5.2'],
      descriptionMd:
        'The authoring surface, per the 6.6.4 design, on the 6.6.1 routes — the ' +
        'Automation page mounted in the reserved slot of the 6.5.2 settings-nav ' +
        'registry (admin-gated end to end via its access predicates: the nav entry, ' +
        'the page, and every route 403 for non-admins).\n\n' +
        '**Build:** the rule list (name, toggle, owner, last-run glyph, overflow ' +
        'actions, empty + cap + auto-disabled-banner states); the editor with ' +
        'when/if/then rows driven BY THE REGISTRIES (trigger picker → its config ' +
        'editor kind; action rows → per-action editors; a registry addition appears ' +
        'with zero UI changes — the 6.1.4 pattern, asserted with a test-only entry); ' +
        'the **If** group reusing the 6.1.4 condition-row components scoped to the ' +
        'rule editor (match all/any + rows + cap — one predicate UI in the product); ' +
        'add/remove/reorder actions; save/validation surfacing the typed 422s ' +
        '(caps, unknown/stale referents) per the designed states; enable/disable ' +
        'with the counter-reset behaviour; delete with confirm. The Automation nav ' +
        'entry fills the 6.5.2 reserved slot (a registry entry, not a new chrome). ' +
        'Strings via next-intl.\n\n' +
        '**A11y:** the when/if/then columns are labelled groups; every picker ' +
        'keyboard-complete; the toggle + last-run status announced; action reorder ' +
        'keyboard-operable; extends the settings strict sweep.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Matches the design panel-for-panel: list states, every trigger/action ' +
        'config editor kind, condition rows, caps, stale-referent + 422 surfacing, ' +
        'the nav entry in the reserved slot.\n' +
        '- Rows render from the registries (test-only-entry assertion); the ' +
        'condition group is the reused 6.1.4 component (no forked predicate UI); ' +
        'editor round-trips every rule shape 6.6.1 accepts.\n' +
        '- Admin-gating: viewers/members see no Automation nav entry and get the ' +
        '6.4-shaped denial on direct navigation; axe-clean; token tiers only; ' +
        'next-intl.\n' +
        '- Integration tests over the editor wiring + validation states; coverage ' +
        '≥90%.\n\n' +
        '## Context refs\n\n' +
        '- `design/projects/automation.mock.html` + notes (6.6.4) — THE authority\n' +
        '- 6.6.1 (routes + registries — the UI contract); 6.1.4 (the condition-row ' +
        'components to reuse)\n' +
        '- 6.5.2 (the settings-nav registry + access predicates — the mount ' +
        'point); the i18n threading pattern',
    },
    {
      id: '6.6.6',
      title:
        'Audit-log UI — per-rule execution log (status, error detail, pagination) + last-run surfacing + the auto-disabled banner wiring',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 25,
      dependsOn: ['6.6.2', '6.6.4'],
      descriptionMd:
        'The observability half of the surface, per the 6.6.4 audit-log panels, on ' +
        'the 6.6.2 execution data.\n\n' +
        '**Build:** the per-rule log view (paginated `[ruleId, createdAt]` reads — ' +
        'bounded, finding #57): status pill (Success / Failure / No actions), ' +
        'triggering item key linking to the issue (a deleted item renders the ' +
        'designed tombstone, not a dead link), duration, relative time, expandable ' +
        'failure detail (the typed error); the empty state + the 90-day retention ' +
        "note; the list's last-run glyph + time fed by the same data; the " +
        'auto-disabled banner on list + editor (failure count, the re-enable ' +
        'affordance wired to the 6.6.1 counter-reset). Admin-gated like the rest of ' +
        'the surface. Strings via next-intl.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Matches the designed audit panels: every status kind rendered, failure ' +
        'detail expands, pagination over a seeded 100+-row log is bounded (no ' +
        'load-all), tombstone for deleted items, empty + retention-note states.\n' +
        "- Last-run + auto-disabled surfacing track the engine's writes live " +
        '(re-enable resets and the banner clears); axe-clean; token tiers only; ' +
        'next-intl.\n' +
        '- Integration tests over the log read + states; coverage ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- `design/projects/automation.mock.html` + notes (6.6.4) — the audit ' +
        'panels\n' +
        '- 6.6.2 (`automation_rule_execution` + the failure/disable semantics)\n' +
        '- The 2.5.12 pagination conventions; the jobs-dashboard read patterns ' +
        '(`jobRunsService` — the closest shipped log surface)',
    },
    {
      id: '6.6.7',
      title:
        'Story tests — engine matrix + loop/idempotency/auto-disable proofs + the author→fire→audit E2E + a11y sweep',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['6.6.3', '6.6.5', '6.6.6'],
      descriptionMd:
        'The story-closing verification (Principle #18; the epic-wide journey stays ' +
        'Story 6.7 — do not duplicate it).\n\n' +
        '**Vitest (integration, real Postgres + the in-process job harness):** the ' +
        '**engine matrix** — every (trigger × config-narrowing) × (condition pass / ' +
        'fail / empty / Epic-5 row) × (action) cell against seeded data, DRIVEN FROM ' +
        'the registries (a new entry without a matrix case fails the suite — the ' +
        '6.1.6 totality-guard pattern), incl. ordered multi-action rules and ' +
        'per-action failure isolation; the **loop-prevention proofs** (self-trigger, ' +
        'A-triggers-B via provenance — neither cascades); **idempotency** (replay / ' +
        'retry per event × rule); **failure ops** (counter, auto-disable at 10, ' +
        'reset on success + re-enable, the first-failure-only email via the email ' +
        'harness); **caps + retention** (101st rule / 11th action / 21st row 422s; ' +
        "the sweep's >90d boundary); attribution (revision/comment rows carry the " +
        'owner).\n\n' +
        '**Playwright E2E (`tests/e2e/automation.spec.ts`):** the recipe journey — ' +
        'create the Bug-to-Done rule in the editor (trigger config + condition row + ' +
        'two actions), fire it from the board, await the async effects (watcher + ' +
        'comment + Success audit row), assert the no-actions path on a non-matching ' +
        'item, drive a Failure (illegal transition target) through to the audit ' +
        'detail + banner, and verify the viewer lockout. **a11y:** the strict axe ' +
        'sweep over list, editor (every row kind open once), and audit log.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The registry-driven matrix is green and total; loop, idempotency, ' +
        'failure-ops, caps, retention, and attribution proofs all hold.\n' +
        "- The E2E journey passes green in CI's Playwright lane (async waits via " +
        "the harness's job-completion signal, not sleeps); the sweep reports zero " +
        'violations.\n' +
        '- The Story 6.6 verification recipe runs clean top to bottom; ' +
        '`pnpm test:coverage` keeps all 6.6 files ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- The 6.1.6 registry-driven-matrix pattern; the 1.6 in-process job-test ' +
        'harness + email harness\n' +
        '- `tests/integration/` + `tests/e2e/` conventions; the E2E harness/OOM/' +
        'selector memories\n' +
        '- The Story 6.6 verification recipe — the checklist this automates\n' +
        '- Story 6.7 (the epic-wide remainder — filter compilation + permissions + ' +
        'automation firing TOGETHER stays there)',
    },
  ],
};
