import type { PlanStory } from '../types';

/**
 * Story 7.12 — Planning metering, token accounting & credit ledger. The story
 * that makes Motir's planning loop ACCOUNTABLE: every planning job records what
 * model it ran, how many tokens it burned, and what that cost the ORGANIZATION in
 * Motir's own internal CREDIT unit — so usage is visible, A/B-comparable across
 * models, and bounded (out of credits → planning refuses). This is the data
 * spine the Epic-8 billing/checkout surface later sits on; only the metering +
 * ledger DATA lands here.
 *
 * **The customer-facing cost view is ORG-LEVEL (Yue, locked 2026-06-12).** The
 * Organization (Story 6.9) is the billing entity, so it is ALSO the home of every
 * cost-related view + setting: the token-cost dashboard lives in the ORG ADMIN
 * area (6.9), not on a per-project page. The org admin is the MAIN view for token
 * cost — the org balance + tier + total/monthly spend + per-model breakdown —
 * and the SAME view DRILLS DOWN org → workspace → project (the 7.12.2 metering
 * grain carries project+workspace so the rollup is real). Access is role-aware:
 * the org admin (gated by 6.9.4) sees the full org-wide cost + all drill-downs;
 * a non-admin member sees only their own project's slice, read-only. The
 * `CreditLedger`/tier are already org-keyed (7.12.3); 7.12.5 is the per-org
 * CUSTOMER cost view that reads them, distinct from 10.1.5's PLATFORM-staff
 * cross-ALL-orgs rollup (Motir ops).
 *
 * **The confirmed credit model (Yue approved 2026-06-12; baked in here as the
 * contract every later card builds against).** Credits are an INTERNAL unit, NOT
 * dollars/euros. Each LLM model carries a `creditRate` (credits per 1k input /
 * output tokens) set so credits NORMALIZE the $-cost difference across models AND
 * bake in Motir's margin (the profit on selling tokens). A planning TURN debits
 * `tokens × rate × margin → credits` from the tenant's `CreditLedger`; a
 * `CreditTransaction` row logs every debit + every top-up; a `PlanTier` carries
 * the basic credit allotment. When the balance hits ≤ 0, planning jobs are
 * REFUSED with a typed `OutOfCreditsError` — the upgrade / buy / checkout flow is
 * Epic 8, NOT here.
 *
 * **The verified mirror — the lovart-style / cost-plus credit abstraction.**
 * This is the now-standard shape for multi-model AI products (cited, not
 * asserted):
 *   - **Lovart** prices in an internal credit unit where advanced models cost
 *     MORE credits than cheaper ones, credits are usable across all supported
 *     models, the exact credit cost is shown before AND after each generation
 *     (transparency), monthly-plan credits refresh + clear on the billing date
 *     while purchased top-up credits never expire. Motir mirrors that
 *     per-model-rate + normalized-internal-unit + transparent-usage shape.
 *   - The broader **cost-plus credit model** (Metronome / Solvimon / Zenskar
 *     write-ups): customers consume an abstract credit that the vendor maps to
 *     real token spend PLUS a margin; crucially the exchange rate VARIES BY MODEL
 *     (the cited example: an Anthropic Claude Haiku call burns fewer credits than
 *     a Claude Opus call). That per-model `creditRate` table is exactly 7.12.3's
 *     core. The same write-ups stress real-time cost-next-to-usage visibility —
 *     which is why 7.12 ships the metering store (per-turn token capture) UNDER
 *     the ledger, not just a running balance.
 *
 * **Where the data LIVES — motir-ai's own DB (the 7.1.3 foundation), not the open
 * core.** The metering + ledger are AI-operational concerns with no home in an
 * exportable Jira clone, so they hang off the `AiProject` identity spine in
 * motir-ai's Postgres alongside the other context stores (direction docs 7.2,
 * lessons 7.10, code graph 7.5). This SHARPENS the open-core line exactly as the
 * other 7.x stores do: motir-core stays a complete PM tool with zero billing
 * tables; the credit machinery is closed-side. motir-core only DISPLAYS the
 * org balance/usage over the 7.1 boundary (7.12.5, in the 6.9 org-admin area) —
 * it never holds the ledger.
 *
 * **Metering rides the 7.1.4 job substrate (supports A/B across models).** Every
 * planning job — `noop`, `generate_tree` (7.3), `expand_item`/`augment`/`replan`
 * (7.4), `discovery` (7.2), `generate_prompt` (7.6) — records a `PlanningRun`
 * (jobId, model, tenant, sessionId) and one `PlanningTurn` per LLM round-trip
 * (input/output tokens). Because the run carries the MODEL, the same job kind run
 * under two models is directly comparable — token-for-token and credit-for-credit
 * — which is the A/B evaluation substrate Motir needs to pick planner models. The
 * debit hangs off the turn record: tokens are already captured there, so the
 * credit conversion is a pure function over metering, not a second source of
 * truth.
 *
 * **What 7.12 is NOT (named so each lands in its owning story / epic, not here):**
 * - **The buy / upgrade / checkout / pricing UI + Stripe billing** — EXPLICITLY
 *   Epic 8. 7.12 lands the data contract Epic-8 billing consumes (the rate table,
 *   the conversion + margin, the ledger/transaction shape) and the typed
 *   out-of-credits refusal; it does NOT build a paywall, a Stripe integration, a
 *   pricing page, or a top-up purchase flow. The only top-up path 7.12 models is
 *   the DATA shape (`CreditTransaction.kind = top_up`) that Epic-8 will write
 *   into — 7.12 itself never charges a card.
 * - **The planner model DECISION** (which Claude model planning defaults to) is
 *   7.2.2; 7.12 only METERS whatever model a run used.
 * - **Per-type prompt generation / dispatch** (7.6), **retrieval** (7.5) — 7.12
 *   meters the jobs those stories add; it does not implement them.
 *
 * **Cross-story dep audit (notes.html #32): PASSES.** Every 7.12 leaf depends only
 * on backward/sideways ids — 7.1.3 (motir-ai's DB foundation the stores hang off),
 * 7.1.4 (the job substrate metering hooks into), 7.1.5 (the core→ai client the
 * display reads over), plus the Epic-6 org tier it builds the cost view on top of
 * (6.9.3 the org ledger-key for 7.12.3, 6.9.4 the org-admin gating for 7.12.5 —
 * both Epic 6, backward, no forward dep) — plus same-story 7.12.x cards and the
 * design gate (7.12.1) it ships itself. No forward-pointing dep on Epic 8 (the
 * deferral is a SCOPE boundary recorded in prose + the content card, not a dep) and
 * none on Epic 10 (the cross-org platform rollup 10.1.5 is a SEPARATE concept).
 * Statuses follow the rule: the design subtask (`dependsOn: []`) is `planned`;
 * everything chained behind it or behind any not-yet-done 7.1.x / 6.9.x id is
 * `blocked`.
 *
 * **The design gate fires (Principle #13).** 7.12 ships a real user-facing
 * surface — the ORG-LEVEL cost dashboard (org balance/tier/spend + the
 * org → workspace → project drill-down), in motir-core's 6.9 org-admin area. So
 * the FIRST subtask (7.12.1) is a `design` card producing
 * `design/ai-usage/*.mock.html` + `design-notes.md` (composing into the 6.9
 * org-admin surface), and the UI-touching code subtask (7.12.5) depends on it and
 * is `blocked` behind it. The gate is scoped to the cost VIEW only — the
 * checkout/pricing surface is Epic 8 and explicitly out of this design area.
 */
export const story_7_12: PlanStory = {
  id: '7.12',
  title: 'Planning metering + token accounting + credit ledger',
  status: 'planned',
  gitBranch: 'feat/PROD-7.12-metering-credit-ledger',
  descriptionMd:
    'Make Motir’s planning loop ACCOUNTABLE and BOUNDED: every planning job ' +
    'records the model + tokens it burned (the metering store), that token ' +
    'spend converts to Motir’s internal CREDIT unit through a per-model rate ' +
    '× margin, each debit/top-up lands in a per-tenant ledger, and when a ' +
    'tenant runs out of credits planning is refused with a typed error. The ' +
    'org balance/usage is DISPLAYED in motir-core over the 7.1 boundary — as an ' +
    'ORG-LEVEL cost dashboard in the 6.9 org-admin area (org admin primary, with ' +
    'an org → workspace → project drill-down) — but the buy / upgrade / pricing / ' +
    'checkout flow is **Epic 8 (Stripe billing)**; only the metering + ledger ' +
    'DATA lands now.\n\n' +
    '**The credit model (confirmed — see the module header for the full ' +
    'rationale + the mirror):**\n\n' +
    '- **Credits are an internal unit, not money.** Each LLM model carries a ' +
    '`creditRate` (credits per 1k input / output tokens) chosen so credits ' +
    'NORMALIZE the $-cost gap between models AND bake in Motir’s margin. A ' +
    'cheaper model burns fewer credits per turn than a pricier one (the ' +
    'lovart / cost-plus mirror: Haiku < Opus per call).\n' +
    '- **Debit per TURN, off the metering.** Every planning job records a ' +
    '`PlanningRun` (jobId, model, tenant, sessionId) + one `PlanningTurn` per ' +
    'LLM round-trip (input/output tokens). The credit debit is a pure function ' +
    'over that turn: `tokens × rate × margin → credits`, written to the ledger ' +
    'as a `CreditTransaction`.\n' +
    '- **Per-tenant ledger + tier.** `CreditLedger` holds the running balance; ' +
    '`CreditTransaction` logs each debit + top-up; `PlanTier` carries the basic ' +
    'allotment. Balance ≤ 0 → planning jobs refuse with a typed ' +
    '`OutOfCreditsError`.\n' +
    '- **The data lives in motir-ai** (its own DB, the 7.1.3 foundation), ' +
    'hanging off the `AiProject` spine — motir-core stays a clean PM tool with ' +
    'zero billing tables and only DISPLAYS the org balance over 7.1 (in the 6.9 ' +
    'org-admin area).\n\n' +
    '**Scope:** the balance/usage display design (7.12.1); the metering store ' +
    '— `PlanningRun` + `PlanningTurn` + monthly aggregation, recorded by the ' +
    '7.1.4 substrate for every job (7.12.2); the credit ledger — ' +
    '`CreditLedger` + `CreditTransaction` + `PlanTier` + the per-model ' +
    '`creditRate` table + the `tokens × rate × margin → credits` conversion + ' +
    'the per-turn debit (7.12.3); the enforcement / `OutOfCreditsError` (7.12.4); ' +
    'the motir-core ORG-LEVEL cost view API + display — the org cost dashboard ' +
    '(balance/tier/spend/per-model) with an org → workspace → project drill-down, ' +
    'in the 6.9 org-admin area, org-admin-gated (7.12.5); vitest (7.12.6); and ' +
    'the credit-model doc / Epic-8 data contract (7.12.7).\n\n' +
    '**Out of scope (named so they land in their own story / epic, not here):** ' +
    'the buy / upgrade / checkout / pricing UI + the Stripe integration ' +
    '(**Epic 8 billing** — 7.12 lands only the data contract it consumes + the ' +
    'typed refusal); the planner-model decision (7.2.2 — 7.12 only meters the ' +
    'model a run used); the jobs being metered themselves (7.2 / 7.3 / 7.4 / ' +
    '7.6).',
  verificationRecipeMd:
    '- Pull the Story branch; bring up both services locally (motir-core on ' +
    '`:3000`, motir-ai on its dev port, each pointed at the other), with at ' +
    'least one planning job kind runnable end to end (the 7.1.7 `noop` is ' +
    'enough to exercise metering; a `generate_tree` run if 7.3 is present).\n' +
    '- **Metering captures per turn (the A/B substrate).** Run a planning job ' +
    'for the `PROD` project. Confirm a `PlanningRun` row exists carrying the ' +
    'jobId + the MODEL + tenant + sessionId, and one `PlanningTurn` per LLM ' +
    'round-trip with non-zero input/output token counts. Re-run the SAME job ' +
    'kind under a different model (env/config swap) → a second run with the ' +
    'other model id, so the two are directly token-comparable.\n' +
    '- **Credit debit math.** With a known `creditRate` + margin for the run’s ' +
    'model, confirm the `CreditTransaction` debit equals `tokens × rate × ' +
    'margin` (rounded per the documented rule) and that `CreditLedger.balance` ' +
    'dropped by exactly that amount. A top-up transaction (the DATA path Epic-8 ' +
    'will drive — inserted directly here, no checkout) increases the balance ' +
    'and is logged as `kind = top_up`.\n' +
    '- **Out-of-credits enforcement.** Drive the balance to ≤ 0 (debit it down ' +
    'or seed a zero-balance tenant). Submit another planning job → it is ' +
    'REFUSED with the typed `OutOfCreditsError` (the 7.1.1 taxonomy code), NO ' +
    'LLM call is made, and the ledger is unchanged. There is NO upgrade/buy ' +
    'prompt wired (that is Epic 8) — the refusal is the boundary 7.12 ships.\n' +
    '- **The org cost dashboard (motir-core over 7.1).** As an ORG ADMIN, open ' +
    'the org-level cost view in the org-admin area (6.9): it shows the org ' +
    'credit balance, the tier, total + this-month spend (with a monthly history / ' +
    'trend), and a per-model breakdown — fetched over the 7.1 boundary (motir-core ' +
    'never holds the ledger). DRILL DOWN org → workspace → project and confirm the ' +
    'token cost narrows to the selected workspace, then project. Then as a ' +
    'NON-admin member confirm the view is limited to that member’s own project ' +
    'slice (read-only), not the org-wide total. Confirm there is NO checkout / ' +
    'pricing / buy-credits UI on this surface (Epic 8).\n' +
    '- `pnpm test` (motir-core) + the motir-ai suite — 7.12.6 covers metering ' +
    'capture per turn, the debit math (`rate × tokens × margin`, incl. ' +
    'rounding + the per-model rate lookup), and the out-of-credits refusal ' +
    '(no LLM call, ledger untouched).\n' +
    '- **Open-core boundary review (this Epic’s recurring posture).** No ' +
    '`motir-ai` import in `motir-core` (HTTP only); the ledger + rate table + ' +
    'metering live ONLY in motir-ai’s DB — motir-core has zero billing/credit ' +
    'tables and reaches the balance only via the 7.1 read; browsers never call ' +
    'motir-ai.\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up Subtask ' +
    'under the same Story.',
  items: [
    {
      id: '7.12.1',
      title:
        'Design — the ORG-LEVEL cost dashboard (org balance/tier/spend, org → workspace → project drill-down, per-model breakdown)',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        '**Type:** design (the planning-time design gate, Principle #13 + the ' +
        'design-reference rule). The org cost view (7.12.5) depends on ' +
        'this card; without it the surface would be improvised, which is ' +
        'forbidden (notes.html #31).\n\n' +
        'Produce the design asset for the **ORG-LEVEL token-cost dashboard** ' +
        '— the org admin’s home for token cost (Yue, locked 2026-06-12: all ' +
        'cost views/settings live at the ORG level, not the workspace). The ' +
        'design area can stay `motir-core/design/ai-usage/`, but it COMPOSES INTO ' +
        'the 6.9 org-admin / org-settings surface (note this in the design-notes — ' +
        'it is an org-admin panel, not a standalone per-project page). Author it ' +
        'as a **`*.mock.html` ' +
        'mockup** built from the real design system (the shipped ' +
        '`components/ui/*` primitives + the `--el-*` colour tokens + the ' +
        '`[data-display-style]` shape tokens) — NOT a `.pen`. The HTML route is ' +
        'preferred when a coding agent produces the design (no translation gap; ' +
        'the reviewer sees the actual tokens). A PNG export is optional; the ' +
        '`.mock.html` is the source of truth (MOTIR.md § Design-reference rule).\n\n' +
        '**SCOPE — display ONLY, NOT checkout (Epic 8).** This surface SHOWS ' +
        'usage; it does NOT sell credits. There is NO pricing table, NO ' +
        '“buy credits” button, NO plan-comparison / upgrade CTA, NO Stripe ' +
        'element — all of that is Epic 8 billing and explicitly out of this ' +
        'design area. The ONE forward-looking affordance allowed is a passive ' +
        '“out of credits” empty/blocked state that NAMES the limit (so the ' +
        'user understands why planning paused) WITHOUT an active purchase ' +
        'control — Epic 8 will attach the upgrade flow to that slot later.\n\n' +
        '**Mirror (cited — the lovart-style transparent-usage shape).** Lovart ' +
        'shows the exact credit cost before and after each generation and a ' +
        'usable-across-all-models balance; cost-plus write-ups stress ' +
        '“cost/usage visible in real time, per model”. Draw THAT at the ORG ' +
        'level: a clear org balance, the org’s spend + monthly trend, the ' +
        'org → workspace → project drill-down, and a per-MODEL breakdown (so the ' +
        'org admin sees a pricier model drained faster) — the transparency, minus ' +
        'the storefront.\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the ' +
        'multi-panel rule, mistake #31):\n\n' +
        '- **Panel 1 — the org cost summary (populated, the PRIMARY view).** ' +
        'The org’s current credit balance as the hero figure (with the org name ' +
        'and the tier, e.g. “Basic”), the org’s TOTAL spend + this-month spend, ' +
        'and a MONTHLY HISTORY / TREND (a small sparkline or bar trend of ' +
        'month-over-month spend) — as a set of stat cards/`Card`s. This is the ' +
        'org admin’s home for token cost. Credits are an INTERNAL unit — label ' +
        'them as credits, never as a currency. Show a quiet “credits, not $” ' +
        'affordance so it reads as an allotment, not a bill.\n' +
        '- **Panel 2 — the drill-down org → workspace → project.** A scope ' +
        'control / breadcrumb that drills the SAME cost view from the org TOTAL ' +
        'down to a chosen WORKSPACE, then a chosen PROJECT (the 7.12.2 metering ' +
        'grain supports each level). Draw all three levels: org-wide, ' +
        'one-workspace, one-project — each showing that level’s balance-share / ' +
        'spend + per-model breakdown. Make the drill path (where you are + how to ' +
        'go up) obvious.\n' +
        '- **Panel 3 — the per-model usage breakdown.** A table/list: per ' +
        'model (e.g. the planner Claude models), the tokens consumed (in / out) ' +
        'and the credits that cost this month, so a costlier model is visibly ' +
        'the bigger drain — shown at WHICHEVER drill level is active (org / ' +
        'workspace / project). Use the palette (not grey-only — finding #54): a ' +
        'small per-model tint or a usage bar via `--el-*` tints.\n' +
        '- **Panel 4 — the recent activity / per-run log.** A paginated list of ' +
        'recent planning RUNS (the metering rows): timestamp, job kind ' +
        '(generate / expand / augment / …), model, tokens, credits debited — ' +
        'plan for SCALE (paginate / lazy-load; an org accrues thousands of ' +
        'runs — no “load all rows”, the at-scale rule). Scoped to the active ' +
        'drill level.\n' +
        '- **Panel 5 — the limited member view.** The NON-admin member view of ' +
        'the same surface: a member who is not an org admin (6.9.4) sees only ' +
        'THEIR OWN project’s cost slice (read-only) — no org-wide total, no ' +
        'cross-workspace drill-up. Draw what a member sees vs the full org-admin ' +
        'view so the role gating is visible in the design.\n' +
        '- **Panel 6 — the low-balance + out-of-credits states.** A low-balance ' +
        'warning treatment (a `--el-warning` tint banner, NOT a page-level ' +
        'tinted surface — finding #35) and the zero/blocked state that explains ' +
        '“planning is paused — you’re out of credits” with NO active buy ' +
        'control (the Epic-8 upgrade slot is a passive placeholder here).\n' +
        '- **Panel 7 — empty / loading / error states.** The first-run empty ' +
        'state (no usage yet), the loading skeleton while fetching over 7.1, ' +
        'and the fetch-failed state (the motir-ai boundary is down → a clear ' +
        'retry, not a broken-looking zero).\n\n' +
        'Also write **`design/ai-usage/design-notes.md`** naming the exact ' +
        'primitives used per surface, the exact copy strings, the placement ' +
        'decisions, the per-`--el-*` colour role for each element (incl. the ' +
        'low-balance `--el-warning` role + the per-model tint roles), and a ' +
        '“primitives composed (no hand-rolling)” checklist (the ' +
        '`design-notes.md` convention 1.3.3 / 1.5.1 / 7.0.1 established). It ' +
        'MUST state, in writing, that checkout/pricing is Epic 8 and absent ' +
        'here.\n\n' +
        '**Branch.** `design/PROD-7.12.1-credit-usage-display`. The `design/*` ' +
        'prefix gate skips CI E2E + the Vercel preview deploy (MOTIR.md ' +
        '§ Plan-seed Workflow) — this PR only edits `design/ai-usage/**`, no ' +
        'app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/ai-usage/usage.mock.html` exists, renders the ' +
        'seven panels above (the ORG cost summary with a monthly trend, the ' +
        'org → workspace → project drill-down, the per-model breakdown, the ' +
        'paginated run log, the limited member view, the low-balance / ' +
        'out-of-credits states, and the empty/loading/error states), and ' +
        'references ONLY `--el-*` tokens + `[data-display-style]` shape tokens ' +
        '(no Tier-0 `--color-*`, no hand-rolled spacing — the ' +
        '`motir-core/CLAUDE.md` § colour / shape rules).\n' +
        '- `motir-core/design/ai-usage/design-notes.md` exists, names every ' +
        'primitive composed + every copy string + the per-element `--el-*` ' +
        'role, STATES that this is the ORG-LEVEL cost view composing into the ' +
        '6.9 org-admin surface (org admin primary), and STATES that ' +
        'checkout/pricing/upgrade is Epic 8 and out of scope (only a passive ' +
        'out-of-credits placeholder appears).\n' +
        '- The org cost summary (balance/tier/total+monthly spend with a history ' +
        'trend), the org → workspace → project drill-down, the per-model ' +
        'breakdown, and the per-run activity log are all drawn, with the activity ' +
        'log shown paginated/lazy (at-scale, not load-all).\n' +
        '- The limited NON-admin member view (own-project slice, read-only) is ' +
        'drawn distinct from the full org-admin view, so the 6.9.4 role gating is ' +
        'visible in the design.\n' +
        '- Credits are labelled as an internal unit, never as currency; the ' +
        'low-balance + out-of-credits states are drawn with NO active ' +
        'buy/upgrade control.\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Pill`, ' +
        '`Button`, `EmptyState`, a table/list pattern, the skeleton/loader) — ' +
        'if a genuinely new primitive is needed, that is a NEW `design/` ' +
        'subtask, not a code workaround.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/org-admin/` (6.9.1) — the org-admin surface this ' +
        'cost dashboard COMPOSES INTO (the org admin / org settings area); mirror ' +
        'its layout + `design-notes.md` shape and slot the cost view alongside it.\n' +
        '- `motir-core/design/ready/` (7.0.1) + `motir-core/design/ai-planning/` ' +
        '(7.3.1) — the closest existing design areas; mirror their layout + ' +
        '`design-notes.md` shape.\n' +
        '- 6.9.4 — the org-admin access gating that decides the full org-wide ' +
        'view (admin) vs the limited own-project member view.\n' +
        '- `motir-core/components/ui/Pill.tsx`, `Card.tsx`, `Button.tsx`, ' +
        '`EmptyState.tsx` — the composable surface.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` colour (incl. ' +
        '`--el-warning` for low balance) + `[data-display-style]` shape tokens.\n' +
        '- Story 8 (stub) — the Epic-8 billing/checkout surface this display is ' +
        'deliberately NOT (the upgrade flow attaches to the passive ' +
        'out-of-credits slot later).',
      dependsOn: [],
    },
    {
      id: '7.12.2',
      title:
        'Metering store (motir-ai) — `PlanningRun` + `PlanningTurn` + monthly aggregation, recorded per job',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'Stand up the METERING store in motir-ai (its own DB, the 7.1.3 ' +
        'foundation) — the per-turn token accounting EVERY planning job writes, ' +
        'and the substrate the credit ledger (7.12.3) and the display (7.12.5) ' +
        'read. This is the source of truth for “what did planning actually ' +
        'cost”; credits are derived from it, never independently tracked.\n\n' +
        '**Schema (hangs off the `AiProject` spine — 7.1.3):**\n\n' +
        '- **`PlanningRun`** — one row per planning JOB: `{ id, aiProjectId, ' +
        'jobId, jobKind, model, sessionId?, status, startedAt, finishedAt?, ' +
        'totalInputTokens, totalOutputTokens }`. It carries the MODEL so the ' +
        'same job kind run under two models is directly comparable (the A/B ' +
        'evaluation substrate — Principle: pick planner models on real data, ' +
        'not vibes). `jobId` ties back to the 7.1.4 `PlanJob`; `sessionId` ' +
        'groups the runs of one chat/planning session.\n' +
        '- **`PlanningTurn`** — one row per LLM ROUND-TRIP within a run: ' +
        '`{ id, planningRunId, turnIndex, inputTokens, outputTokens, model, ' +
        'createdAt }`. A planning job is a tool-use SESSION (Principle #2 — many ' +
        'turns), so token capture is per turn; the run’s totals roll up from ' +
        'its turns.\n' +
        '- **Monthly aggregation** — a per-tenant, per-model, per-month rollup ' +
        '(`UsageMonthly { aiProjectId, yearMonth, model, inputTokens, ' +
        'outputTokens, credits }`, upserted as turns land OR computed via a ' +
        'covered query) so the 7.12.5 display renders “this-month spend” + the ' +
        'per-model breakdown WITHOUT scanning every turn — plan for SCALE ' +
        '(thousands of runs/tenant; no full-table sweep on each page load, the ' +
        'at-scale rule).\n\n' +
        '**The hook — the 7.1.4 substrate records a run/turn for EVERY job.** ' +
        'The metering is wired into the job worker / handler context (`ctx`), ' +
        'NOT bolted onto each handler: when a job starts, open a `PlanningRun`; ' +
        'the `ctx` exposes a `recordTurn({ inputTokens, outputTokens, model })` ' +
        'the LLM-call wrapper calls after each round-trip; when the job ends, ' +
        'close the run with its rolled-up totals. So `noop` (no LLM call → a run ' +
        'with zero turns), `generate_tree`, `expand_item`/`augment`/`replan`, ' +
        '`discovery`, `generate_prompt` all meter uniformly with no per-handler ' +
        'code. The token counts come from the Anthropic SDK response usage ' +
        '(input/output token fields), not estimated.\n\n' +
        '**Layering.** motir-ai mirrors core’s layering lightly (7.1.3): a thin ' +
        'repository per entity (single Prisma op) + a `meteringService` that ' +
        'owns open-run / record-turn / close-run + the monthly upsert in one ' +
        'transaction per write. No metering logic inlined in the job-dispatch ' +
        'glue.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-ai/prisma/schema.prisma` gains `PlanningRun`, `PlanningTurn`, ' +
        'and the monthly-aggregation model, each FK-modelled as a Prisma ' +
        '`@relation` off `AiProject` (the CLAUDE.md FK-as-relation rule); a ' +
        'migration runs clean.\n' +
        '- Every planning job opens a `PlanningRun` (jobId + model + tenant + ' +
        'sessionId), records one `PlanningTurn` per LLM round-trip (token counts ' +
        'from the SDK usage, not estimated), and closes the run with rolled-up ' +
        'totals — wired via the 7.1.4 worker/`ctx`, NOT per-handler.\n' +
        '- The same job kind run under two models yields two runs distinguished ' +
        'by `model`, directly token-comparable (the A/B substrate).\n' +
        '- A `noop` run (no LLM call) produces a run with zero turns and zero ' +
        'tokens (metering is universal + degenerate-safe).\n' +
        '- The monthly aggregation answers “this-month tokens/credits per ' +
        'model” without scanning every turn row (a covered/rollup query, not a ' +
        'full sweep) — the at-scale rule.\n' +
        '- 4-layer-lite respected; the metering write is one transaction per ' +
        'turn/close; no motir-core DB connection introduced.\n\n' +
        '## Context refs\n\n' +
        '- 7.1.3 — the motir-ai Prisma foundation + `AiProject` spine the store ' +
        'hangs off.\n' +
        '- 7.1.4 — the `PlanJob` + the worker/handler `ctx` extension point the ' +
        'metering hook rides (the `recordTurn` surface added to `ctx`).\n' +
        '- 7.2.2 / 7.2.3 — the planner model + the Anthropic SDK whose response ' +
        '`usage` (input/output tokens) feeds the turn counts.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § FK-as-`@relation` — the patterns ' +
        'motir-ai mirrors.',
      dependsOn: ['7.1.4', '7.1.3'],
    },
    {
      id: '7.12.3',
      title:
        'Credit ledger (motir-ai) — `CreditLedger` + `CreditTransaction` + `PlanTier` + per-model `creditRate`; debit per turn',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'Build the CREDIT ledger on top of 7.12.2’s metering — the per-tenant ' +
        'balance, the transaction log, the basic-allotment tier, the per-model ' +
        'rate table, and the `tokens × rate × margin → credits` conversion that ' +
        'DEBITS the ledger per turn. Credits are an INTERNAL unit (header), ' +
        'normalized across models + carrying Motir’s margin.\n\n' +
        '**Billing entity (updated 2026-06-12): the `CreditLedger` keys to the ' +
        '`Organization`** — the Story 6.9 root-account billing entity (ONE balance ' +
        'per org; its N workspaces/projects roll up into it), NOT per-`AiProject`. ' +
        'The 7.12.2 metering rows keep the project/workspace grain so Story 10.1.5 ' +
        'can roll usage up project→workspace→org→platform, but the BALANCE + tier ' +
        'live at the org (standard SaaS: one org, one bill). This supersedes the ' +
        'per-`aiProjectId` ledger keying sketched below — read it as the org ' +
        'billing key (the 9.0 gateway debits the same org ledger).\n\n' +
        '**Schema (off the `AiProject` spine):**\n\n' +
        '- **`CreditLedger`** — one per tenant: `{ id, aiProjectId, ' +
        'balanceCredits, updatedAt }`. The running balance; the single row a ' +
        'debit/top-up mutates under a lock (read-derived update — FOR UPDATE + ' +
        're-read inside the tx; the lock-before-read-derived-update rule).\n' +
        '- **`CreditTransaction`** — the append-only log: `{ id, aiProjectId, ' +
        'kind (debit | top_up | grant | adjustment), credits (signed), ' +
        'planningRunId? | planningTurnId?, balanceAfter, reason, createdAt }`. ' +
        'A debit references the turn it came from (auditable back to tokens); a ' +
        '`top_up` is the DATA path Epic-8 billing will write into (7.12 itself ' +
        'never charges a card — it only models the row). `balanceAfter` makes ' +
        'the ledger self-auditing.\n' +
        '- **`PlanTier`** — the plan definition: `{ id, key (basic | …), ' +
        'name, monthlyCreditAllotment, … }` + the tenant’s current tier ' +
        '(`AiProject.planTierId` / a join). 7.12 ships the BASIC tier + the ' +
        'allotment-grant shape (a monthly `grant` transaction refreshing the ' +
        'allotment); the paid tiers + the purchase flow are Epic 8.\n' +
        '- **`ModelCreditRate`** — the per-model rate table: `{ id, model, ' +
        'creditsPer1kInput, creditsPer1kOutput, marginMultiplier, effectiveFrom ' +
        '}`. Versioned by `effectiveFrom` so a rate change does not retroactively ' +
        're-price old transactions (durable shape, not a single mutable row).\n\n' +
        '**The conversion (the load-bearing function).** A pure ' +
        '`creditsForTurn(turn, rate)` = `((inputTokens/1000) × ' +
        'creditsPer1kInput + (outputTokens/1000) × creditsPer1kOutput) × ' +
        'marginMultiplier`, rounded by a DOCUMENTED rule (round up to a whole ' +
        'credit, or to a fixed precision — fix it once, in 7.12.7’s doc, and ' +
        'apply it everywhere). The rate is looked up by the turn’s `model` + the ' +
        'effective-dated row. This is the SAME math the display and the doc ' +
        'cite — one source.\n\n' +
        '**Debit per turn, off the metering.** A `creditService` hooks the ' +
        '7.12.2 `recordTurn` path: after a turn is metered, compute its credits ' +
        'and write a `debit` transaction + decrement `CreditLedger.balance` in ' +
        'ONE transaction, locking the ledger row (FOR UPDATE, re-read inside the ' +
        'tx) so concurrent jobs for the same tenant can’t race the balance ' +
        '(the lock-before-read-derived-update rule). Idempotent on ' +
        '`planningTurnId` (a retried turn never double-debits).\n\n' +
        '**Margin + normalization are POLICY, in the rate table — not code.** ' +
        'The rates are seed/config data (a coding agent sets sensible defaults ' +
        'per the planner Claude models; Yue tunes them), so margin + the ' +
        'cross-model normalization are tuned WITHOUT a code change — the ' +
        'cost-plus mirror (the exchange rate varies by model: a cheaper model ' +
        'burns fewer credits).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-ai/prisma/schema.prisma` gains `CreditLedger`, ' +
        '`CreditTransaction`, `PlanTier`, and `ModelCreditRate` (effective-' +
        'dated), each FK-modelled as a Prisma `@relation`; a migration runs ' +
        'clean and seeds the BASIC tier + a default rate row per planner model.\n' +
        '- `creditsForTurn` computes `(tokens/1k × per-1k-rate) × margin` with ' +
        'the documented rounding, looking the rate up by model + effective ' +
        'date; it is a pure, directly-tested function.\n' +
        '- Each metered turn writes a `debit` `CreditTransaction` (referencing ' +
        'the turn, with `balanceAfter`) and decrements `CreditLedger.balance` in ' +
        'ONE transaction that LOCKS the ledger row (FOR UPDATE + re-read); ' +
        'concurrent debits for one tenant serialize correctly and a retried ' +
        'turn does not double-debit (idempotent on `planningTurnId`).\n' +
        '- A `top_up` / `grant` transaction increases the balance and is logged ' +
        '(the Epic-8 / monthly-allotment DATA path — no checkout here).\n' +
        '- The rate table is effective-dated: changing a rate does not re-price ' +
        'historical transactions.\n' +
        '- 4-layer-lite; the ledger lives only in motir-ai (no billing table in ' +
        'motir-core).\n\n' +
        '## Context refs\n\n' +
        '- 7.12.2 — the `PlanningTurn` metering this debits off (the ' +
        '`recordTurn` hook + the token source).\n' +
        '- 7.1.3 — the `AiProject` spine the ledger/tier hang off.\n' +
        '- `motir-core/CLAUDE.md` § FK-as-`@relation` + § 4-layer + the ' +
        'lock-before-read-derived-update rule (the balance is a read-derived ' +
        'update).\n' +
        '- 7.12.7 — the doc that fixes the rounding rule + the rate table + the ' +
        'margin (the human-readable side of this math).\n' +
        '- Story 8 (stub) — the Epic-8 billing that WRITES `top_up` transactions ' +
        'via checkout (7.12 ships only the row shape).',
      dependsOn: ['7.12.2', '6.9.3'],
    },
    {
      id: '7.12.4',
      title:
        'Enforcement (motir-ai) — refuse planning at balance ≤ 0 with a typed `OutOfCreditsError`',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'Make the credit balance ENFORCING, not just observational: when a ' +
        'tenant’s balance is ≤ 0, planning jobs are REFUSED before any LLM call, ' +
        'with a typed `OutOfCreditsError` mapped into the 7.1.1 error taxonomy. ' +
        'The upgrade / buy flow that would let the user recover is **Epic 8** — ' +
        '7.12 ships only the refusal (the boundary), not the remedy.\n\n' +
        '**Where the check fires (a pre-flight gate, not mid-LLM).** In the ' +
        '7.1.4 job worker, BEFORE a planning handler runs (and before it opens ' +
        'an LLM connection), check the tenant’s `CreditLedger.balance` via the ' +
        '7.12.3 `creditService`. If ≤ 0, do NOT run the handler: fail the job ' +
        'cleanly with `OutOfCreditsError` (a stable taxonomy code, e.g. ' +
        '`out_of_credits`), so the metering records the refusal (a run with zero ' +
        'turns + a refused status) and NO tokens are spent. A job already ' +
        'mid-flight that crosses zero on a turn debit finishes its current turn ' +
        'but is not RE-entered — the gate is per job submit + per turn-boundary, ' +
        'never a half-written planning result.\n\n' +
        '**Typed error, taxonomy-mapped.** `OutOfCreditsError` is a typed motir-' +
        'ai error carrying the tenant + the (non-positive) balance; the 7.1.4 ' +
        'job-error mapping turns it into the shared problem+json taxonomy ' +
        '(`type`/`title`/`status`/`code`) so motir-core’s client (7.1.5) ' +
        'surfaces it as a typed `OutOfCreditsError` too — the 7.12.5 display ' +
        'renders the “planning paused — out of credits” state from it. The ' +
        'error MUST be distinguishable from a generic job failure (the UI must ' +
        'know it is a credits problem, not a crash).\n\n' +
        '**No remedy here — Epic 8.** The error names the condition; it does NOT ' +
        'trigger a paywall, a checkout, or an auto-top-up. The 7.12.1 design’s ' +
        'passive out-of-credits slot is where Epic 8 later attaches the upgrade ' +
        'flow. 7.12 deliberately stops at the typed refusal.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A planning job submitted for a tenant with balance ≤ 0 is refused ' +
        'BEFORE any LLM call (no tokens spent, no turns recorded beyond the ' +
        'refused run), failing with the typed `OutOfCreditsError` mapped to a ' +
        'stable taxonomy code.\n' +
        '- The error is distinguishable from a generic job failure end-to-end ' +
        '(motir-ai job error → 7.1.1 taxonomy → motir-core typed error), so the ' +
        'display can render the credits-specific state.\n' +
        '- A tenant WITH positive balance is unaffected; the gate adds no ' +
        'measurable latency beyond one balance read.\n' +
        '- No upgrade / checkout / auto-top-up is triggered — the refusal is ' +
        'the terminal behaviour (Epic 8 owns the remedy).\n' +
        '- The refusal is itself metered (a refused `PlanningRun`) so usage ' +
        'analytics see blocked attempts.\n\n' +
        '## Context refs\n\n' +
        '- 7.12.3 — the `creditService` balance read the gate calls + the ' +
        'per-turn debit boundary.\n' +
        '- 7.1.4 — the job worker the pre-flight gate hooks into (before the ' +
        'handler runs) + the job-error mapping.\n' +
        '- 7.1.1 — the shared problem+json error taxonomy `OutOfCreditsError` ' +
        'maps into.\n' +
        '- Story 8 (stub) — the Epic-8 upgrade/checkout flow that the passive ' +
        'out-of-credits state defers to.',
      dependsOn: ['7.12.3'],
    },
    {
      id: '7.12.5',
      title:
        'Org cost dashboard API + display (motir-core) — org-level token cost in the 6.9 org-admin area, org → workspace → project drill-down, org-admin-gated',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'The motir-core side: the API + the UI for the ORG-LEVEL token-cost ' +
        'dashboard — fetching the metering aggregates + the org ledger balance ' +
        'from motir-ai over the 7.1 boundary and rendering the 7.12.1 design IN ' +
        'THE 6.9 ORG-ADMIN AREA. The org admin is the MAIN view for token cost ' +
        '(Yue, locked 2026-06-12): all cost views/settings live at the ORG level, ' +
        'and the cost DRILLS DOWN org → workspace → project. motir-core never ' +
        'holds the ledger; it reads it. **No checkout / pricing UI — that is ' +
        'Epic 8.**\n\n' +
        '**The PRIMARY view is the org cost dashboard (org-admin area, NOT a ' +
        'per-project page).** The org admin’s home for token cost: the org ' +
        'balance + tier + total spend + monthly history/trend + per-model ' +
        'breakdown, rendered inside the 6.9 org-admin / org-settings surface — ' +
        'because the Organization (6.9) is the billing entity and the home of all ' +
        'cost-related views (the `CreditLedger` + tier are already org-keyed in ' +
        '7.12.3). This is the per-org CUSTOMER cost view, distinct from 10.1.5’s ' +
        'PLATFORM-staff cross-ALL-orgs rollup (leave that alone).\n\n' +
        '**Drill-down org → workspace → project.** The same view drills from the ' +
        'org TOTAL down to a chosen WORKSPACE then a chosen PROJECT — the 7.12.2 ' +
        'metering rows carry the project/workspace grain, so each level’s token ' +
        'cost is real, not synthesized. The drill scope is a request parameter ' +
        '(below), so one endpoint + one view serve all three levels.\n\n' +
        '**Role-aware access (6.9.4).** An ORG ADMIN sees the full org-wide cost ' +
        '+ every drill-down (org / workspace / project). A NON-admin member sees ' +
        'only their OWN project’s cost slice, read-only — cost is an org-admin ' +
        'concern by default. The gating reuses the 6.9.4 org-admin access check ' +
        '(do NOT invent a parallel one); a member’s request is narrowed to their ' +
        'project scope server-side (never trust a client-sent scope).\n\n' +
        '**A new read over the 7.1 boundary (org-scoped).** The metering + ' +
        'balance live in motir-ai, so motir-core needs a read path for them. ' +
        'EXTEND the motir-ai internal endpoint (job-scoped or service-credential ' +
        'auth, the 7.1 shape) — `GET /v1/usage` — to accept an ORG scope + a ' +
        'DRILL-DOWN LEVEL (e.g. `?orgKey=…&scope=org|workspace|project&id=…`) and ' +
        'return the rollup AT THAT LEVEL: `{ balance, tier, totalSpend, ' +
        'monthSpend, monthlyHistory[], perModel[], recentRuns(paginated) }`. ' +
        'Consume it from the motir-core client (7.1.5). Browsers NEVER call ' +
        'motir-ai; the browser hits a motir-core route that calls the client (the ' +
        'open-core invariant); no billing tables in motir-core.\n\n' +
        '**4-layer (motir-core/CLAUDE.md).**\n\n' +
        '- **`GET /api/org/[orgKey]/usage`** (session auth, org-admin-gated) with ' +
        'a `?scope=org|workspace|project&id=…` drill-down param — the route ' +
        'parses + calls ONE `aiUsageService` method; the service enforces the ' +
        '6.9.4 org-admin gate (full org view for an admin; a member is narrowed ' +
        'to their own project scope), resolves the requested scope, calls the ' +
        '7.1.5 client’s org-scoped usage read, and maps the result to a DTO. No ' +
        '`motir-ai` import, no Prisma-for-billing in the route — the cost data is ' +
        'remote (over HTTP), so there is no motir-core billing repository/table ' +
        'here (this is a READ-THROUGH service, the email.ts-style leaf-client ' +
        'pattern; it MAY read org membership/role via the 6.9 org service to gate, ' +
        'but never holds a ledger).\n' +
        '- The route is org-scoped (404-not-403 for a non-member of the org, the ' +
        'standing cross-tenant guard) and session-gated (401 without a session); ' +
        'a non-admin member requesting an org/workspace scope is narrowed or ' +
        'refused (their slice only).\n\n' +
        '**The UI (renders 7.12.1 verbatim, in the org-admin area).** The ' +
        'org-level cost dashboard rendered inside the 6.9 org-admin / org-settings ' +
        'surface, with the panels: the org cost summary (org balance + tier + ' +
        'total + monthly spend with a history trend, internal-credit-labelled), ' +
        'the org → workspace → project drill-down, the per-model breakdown (at the ' +
        'active drill level), the paginated recent-runs activity log (lazy/paged — ' +
        'the at-scale rule, NOT load-all), the limited NON-admin member view ' +
        '(own-project slice, read-only), the low-balance + out-of-credits states, ' +
        'and the empty/loading/error states. **NO buy/upgrade/pricing control** — ' +
        'the out-of-credits state is the passive Epic-8 placeholder. References ' +
        'ONLY `--el-*` colour + `[data-display-style]` shape tokens; uses the ' +
        'palette (per-model tints / a `--el-warning` low-balance banner — not ' +
        'grey-only, finding #54); the activity log paginates; an `aria-live` ' +
        'region for the loading→loaded transition; i18n via a new `aiUsage` ' +
        'namespace (the app’s locale set).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The motir-ai `GET /v1/usage` (7.1-auth) is EXTENDED to accept an org ' +
        'scope + a drill-down level (`scope=org|workspace|project&id=…`) and ' +
        'returns the rollup at that level: balance + tier + total/month spend + ' +
        'monthly history + per-model breakdown + paginated recent runs; ' +
        'motir-core’s `GET /api/org/[orgKey]/usage` reads it via the 7.1.5 client ' +
        '(no `motir-ai` import; no billing Prisma in the route — read-through).\n' +
        '- The PRIMARY view is the ORG cost dashboard rendered in the 6.9 ' +
        'org-admin area (org balance + tier + total + monthly trend + per-model), ' +
        'NOT a per-project page; the org → workspace → project drill-down narrows ' +
        'the cost to the chosen level and the per-model breakdown + run log follow ' +
        'the active scope.\n' +
        '- Access is role-aware via the 6.9.4 gate: an org admin sees the full ' +
        'org-wide cost + all drill-downs; a non-admin member sees only their own ' +
        'project slice (read-only), and a member requesting an org/workspace scope ' +
        'is narrowed or refused server-side (never trust a client-sent scope).\n' +
        '- The display renders the 7.12.1 panels with `--el-*` tokens only; the ' +
        'recent-runs log is paginated/lazy (at-scale), the per-model breakdown ' +
        'uses the palette, and the out-of-credits state shows with NO active ' +
        'buy/upgrade control (Epic-8 placeholder).\n' +
        '- The route is session-gated (401) + org-scoped (404 for a non-member of ' +
        'the org, cross-tenant); 4-layer respected (route → service → 7.1.5 ' +
        'client; no client component touches the service directly).\n' +
        '- When motir-ai is unreachable, the view shows the error/retry state ' +
        '(not a misleading zero balance).\n' +
        '- No checkout/pricing/Stripe surface appears anywhere in this work ' +
        '(Epic 8); no billing tables are added to motir-core (the open-core ' +
        'invariant).\n\n' +
        '## Context refs\n\n' +
        '- 7.12.1 — the design asset (the org cost dashboard + drill-down + ' +
        'member view this implements verbatim).\n' +
        '- 6.9.4 — the org-admin services + access gate this REUSES (full org ' +
        'view for an admin; member narrowed to their own project) and the ' +
        'org-admin area this dashboard renders inside.\n' +
        '- 6.9.5 — the org-admin UI surface (org settings / org-admin area) the ' +
        'cost dashboard slots into.\n' +
        '- 7.12.2 / 7.12.3 — the metering aggregates (carrying the ' +
        'project/workspace grain that powers the drill-down) + the org-keyed ' +
        'ledger balance the `/v1/usage` endpoint reads.\n' +
        '- 10.1.5 — the PLATFORM-staff cross-ALL-orgs rollup this is deliberately ' +
        'NOT (7.12.5 is the per-org CUSTOMER view).\n' +
        '- 7.1.5 — the motir-core → motir-ai client this reads the usage over.\n' +
        '- `motir-core/lib/ai/motirAiClient.ts` (7.1.5) — the leaf client the ' +
        'service calls (the read-through pattern, like `lib/email.ts`).\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § colour/shape tokens.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` + shape tokens.',
      dependsOn: ['7.12.1', '7.12.3', '6.9.4'],
    },
    {
      id: '7.12.6',
      title: 'Vitest — metering capture per turn + credit debit math + out-of-credits enforcement',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'Lock the metering + ledger with tests on both sides. motir-core tests ' +
        'run over a real Postgres (the project convention; the only allowed ' +
        '`vi.mock` is `getSession()`); the motir-ai tests run over its own real ' +
        'Postgres (7.1.3) and stub the LLM SDK at the boundary with recorded ' +
        'usage figures (no live model in CI) — but the metering rows, the ' +
        'conversion math, the ledger transactions, and the enforcement are ' +
        'exercised for real.\n\n' +
        '**motir-ai — metering (7.12.2):**\n\n' +
        '- A planning job (driven with stubbed per-turn SDK usage) opens a ' +
        '`PlanningRun` carrying the model + tenant + jobId + sessionId, writes ' +
        'one `PlanningTurn` per round-trip with the exact stubbed token counts, ' +
        'and closes the run with correct rolled-up totals.\n' +
        '- The SAME job kind under two different models yields two runs ' +
        'distinguishable by `model` (the A/B substrate).\n' +
        '- A `noop` run records a run with zero turns / zero tokens.\n' +
        '- The monthly aggregation returns the right per-model month totals ' +
        'without scanning every turn (assert the aggregate matches a summed ' +
        'fixture).\n\n' +
        '**motir-ai — credit math + ledger (7.12.3):**\n\n' +
        '- `creditsForTurn` returns `(tokens/1k × per-1k-rate) × margin` with ' +
        'the documented rounding for a table of fixtures (incl. the rounding ' +
        'boundary), and looks the rate up by model + effective date — a cheaper ' +
        'model yields FEWER credits for the same tokens (cross-model ' +
        'normalization).\n' +
        '- Each metered turn writes a `debit` `CreditTransaction` (referencing ' +
        'the turn, with `balanceAfter`) and decrements `CreditLedger.balance` by ' +
        'exactly that; a top_up/grant increases it; the ledger balance always ' +
        'equals the signed sum of its transactions.\n' +
        '- Concurrency: two debits for one tenant in parallel serialize via the ' +
        'row lock and the final balance is correct (no lost update); a retried ' +
        'turn (same `planningTurnId`) does NOT double-debit (idempotent).\n' +
        '- A rate change (new `effectiveFrom`) does not re-price an earlier ' +
        'transaction.\n\n' +
        '**motir-ai — enforcement (7.12.4):**\n\n' +
        '- A job for a balance-≤-0 tenant is refused BEFORE any LLM call (assert ' +
        'the SDK stub was never invoked), fails with the typed ' +
        '`OutOfCreditsError` mapped to its taxonomy code, the ledger is ' +
        'unchanged, and a refused run is recorded.\n' +
        '- A positive-balance tenant runs normally.\n\n' +
        '**motir-core — the org cost read (7.12.5):**\n\n' +
        '- `GET /api/org/[orgKey]/usage` returns the DTO from a stubbed 7.1.5 ' +
        'client read (the client boundary is the stub; the service/route/DTO ' +
        'mapping is real); 401 without session; 404 for a non-member of the org ' +
        '(cross-tenant); an org admin gets the full org view while a non-admin ' +
        'member is narrowed to their own project slice (the 6.9.4 gate).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The above cases pass on both sides; motir-core over real Postgres ' +
        '(only `getSession()` mocked), motir-ai over its real Postgres with only ' +
        'the LLM SDK boundary stubbed.\n' +
        '- The debit math is asserted against a fixture table (including the ' +
        'rounding boundary + the per-model rate lookup), and the out-of-credits ' +
        'path is proven to make NO LLM call.\n' +
        '- New motir-core service code respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage); the credit-conversion + ' +
        'ledger-debit branches are directly covered (the empty-input / ' +
        'zero-token / rounding-boundary guards each have a test).\n\n' +
        '## Context refs\n\n' +
        '- 7.12.2 / 7.12.3 / 7.12.4 (everything under test), 7.12.5 (the read ' +
        'endpoint).\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + § coverage gate.\n' +
        '- 7.1.3 — the motir-ai test DB setup the metering/ledger tests run ' +
        'over.',
      dependsOn: ['7.12.3'],
    },
    {
      id: '7.12.7',
      title:
        'Content — the credit-model doc: rate table, conversion + margin, the Epic-8 billing data contract',
      status: 'blocked',
      type: 'content',
      executor: 'coding_agent',
      estimateMinutes: 35,
      descriptionMd:
        'Write the authoritative credit-model document — the human-readable ' +
        'companion to 7.12.3’s code — fixing the rate table, the conversion + ' +
        'margin, the rounding rule, and the DATA CONTRACT Epic-8 billing ' +
        'consumes. It is the single place “how credits work” is explained, so ' +
        'the math in 7.12.3 / 7.12.5 / 7.12.1 all cite ONE source.\n\n' +
        'Write `motir-ai/docs/credit-model.md` (owned by the closed side, where ' +
        'the ledger lives; `motir-core` may link it from a short pointer if a ' +
        'usage surface needs it). It MUST fix:\n\n' +
        '1. **What a credit IS** — an INTERNAL unit (not money), normalized ' +
        'across models, carrying Motir’s margin. State the lovart-style / ' +
        'cost-plus mirror (advanced models cost more credits; the exchange rate ' +
        'varies by model — a cheaper Claude model burns fewer credits than a ' +
        'pricier one) so the design rationale is captured, not folklore.\n' +
        '2. **The rate table** — the per-model `creditsPer1kInput` / ' +
        '`creditsPer1kOutput` / `marginMultiplier`, how they were chosen (the ' +
        '$-cost normalization + the margin), and the effective-dating rule (a ' +
        'rate change never re-prices history).\n' +
        '3. **The conversion** — `creditsForTurn = ((in/1k × rateIn) + (out/1k ' +
        '× rateOut)) × margin`, the EXACT rounding rule (fixed here, applied ' +
        'everywhere), and a worked example per planner model.\n' +
        '4. **The ledger model** — `CreditLedger` (balance), `CreditTransaction` ' +
        '(debit / top_up / grant / adjustment, signed, `balanceAfter`), ' +
        '`PlanTier` (the basic allotment + the monthly grant), and the per-turn ' +
        'debit semantics (locked, idempotent).\n' +
        '5. **The Epic-8 data contract (the deferral, written down).** EXACTLY ' +
        'what Epic-8 billing consumes + writes: it reads balance/tier/usage; it ' +
        'writes `top_up` transactions (checkout) + assigns paid `PlanTier`s + ' +
        'may set rates. State plainly that pricing, checkout, Stripe, the ' +
        'upgrade flow, and the $-price of a credit are ALL Epic 8 and out of ' +
        '7.12 — 7.12 ships the data + the typed out-of-credits refusal the ' +
        'upgrade flow later attaches to. This is the open-finding-style record ' +
        'that keeps the deferral honest (a real boundary, not a forgotten gap).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-ai/docs/credit-model.md` exists and fixes all five sections, ' +
        'with the conversion + rounding stated once and a worked example per ' +
        'planner model — the SAME math 7.12.3’s `creditsForTurn` implements ' +
        '(referenced, not divergently re-stated).\n' +
        '- The cost-plus / per-model-rate mirror is cited (not asserted) as the ' +
        'design rationale.\n' +
        '- An explicit “Epic-8 boundary” section enumerates what billing ' +
        'reads/writes and states that pricing/checkout/Stripe/the $-value of a ' +
        'credit are out of 7.12 — only the data contract + the typed refusal ' +
        'land now.\n' +
        '- No secrets / no real $-prices committed (credits are the internal ' +
        'unit; any illustrative $-figure is clearly marked illustrative).\n\n' +
        '## Context refs\n\n' +
        '- 7.12.3 — the rate table + conversion + ledger this documents (the ' +
        'code side of the same contract).\n' +
        '- 7.12.4 — the out-of-credits refusal the doc names as the 7.12-side ' +
        'boundary.\n' +
        '- `motir-ai/docs/contract.md` (7.1.1/7.1.9) — the sibling closed-side ' +
        'doc to sit alongside + match in shape.\n' +
        '- Story 8 (stub) — the Epic-8 billing the data contract is written ' +
        'for.',
      dependsOn: ['7.12.3'],
    },
  ],
};
