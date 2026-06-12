import type { PlanStory } from '../types';

/**
 * Story 9.1 — Hosted agent container: auth + gateway-metered token usage. The
 * second story of **Epic 9 (Native AI coding)** — it builds ON Story 9.0 (the
 * LLM metering gateway, a fork of one-api), which sorts BEFORE it (9.0 < 9.1,
 * so 9.1 depending on 9.0.x is a BACKWARD dep): Motir runs the coding agent
 * itself, in a hosted cloud sandbox, ON THE USER'S BEHALF — AUGMENTING (never
 * replacing) the Epic-7 BYOK external-agent path. Where 7.9's `motir auto`
 * dispatches a ready item to the user's OWN agent on the user's OWN machine, a
 * hosted run dispatches that same item into a Motir-operated container that
 * clones the repo, runs the selected agent, and opens a PR — the "dispatch a
 * ticket, get a PR back" experience, with no local agent install and no local
 * compute.
 *
 * **The trust-boundary principle (the metering posture 9.1 inherits from 9.0).**
 * The meter sits OUTSIDE the billed sandbox's trust boundary — at the 9.0
 * GATEWAY, never via in-container self-report. A hosted run executes an
 * autonomous agent editing code, so anything that container reports about its
 * OWN token spend is untrustworthy (it is the thing being billed). So a run's
 * LLM egress is LOCKED to the gateway (9.0.7), the orchestrator mints a per-run
 * gateway VIRTUAL KEY (9.0.4), and the gateway captures the PROVIDER's
 * authoritative `usage` (9.0.5) and debits the 7.12 credit ledger (9.0.6). 9.1
 * WIRES the run to the gateway and SURFACES the per-run usage/cost the gateway
 * captured — it does NOT self-report.
 *
 * **9.1 is the hosted-execution FOUNDATION, not the whole layer.** It ships the
 * container image + its auth + its wiring to the 9.0 gateway + the orchestration
 * that provisions one container per run and surfaces the PR. The richer Epic-9
 * capabilities (named under "Out of scope" below) ride this foundation in
 * later stories.
 *
 * **The verified mirror — the cloud-agent lifecycle (cited, not asserted; web-
 * checked 2026-06-12).** Every serious hosted coding agent shares one shape:
 * **dispatched task → provision a fresh cloud sandbox (container/VM PER RUN) →
 * the agent autonomously edits + runs tests → it opens a PULL REQUEST → a human
 * reviews/merges.** Motir mirrors exactly this.
 *   - **Devin** (Cognition) spins up its OWN cloud environment (shell + editor
 *     + browser) per task, works autonomously, and the output is "always a
 *     standard Git pull request" the team reviews and merges.
 *   - **Google Jules** provisions a FRESH cloud VM per task, clones the repo,
 *     writes a plan, makes multi-file changes, runs the existing tests, then
 *     "pushes to a branch and opens a pull request" so the existing CI runs
 *     before a human reviews/merges — explicitly ASYNCHRONOUS (dispatch and
 *     walk away).
 *   - **OpenAI Codex (cloud / web)** runs "each task in its own cloud sandbox
 *     environment, preloaded with your repository", isolated container, and
 *     proposes a pull request for review.
 *   - **GitHub Copilot coding agent** uses an EPHEMERAL, single-use dev
 *     environment (GitHub Actions / ARC runners — "ephemeral, single-use
 *     runners that are not reused"), opens a draft PR, and pushes commits as it
 *     works. Container-per-run isolation is the consensus posture.
 *
 * **The usage / billing mirror (cited) — hosted coding spends the SAME credits
 * as planning.** Hosted runs burn tokens, and the verified market shape is
 * usage-based metering of that burn:
 *   - **GitHub Copilot** moved to usage-based billing (2026): "premium request
 *     units replaced by GitHub AI Credits, credits consumed based on token
 *     usage (input, output, cached) at published per-model API rates" — agentic
 *     tool-calls fold into the token meter.
 *   - **Devin** bills ACUs (~$2.25 each; a typical bugfix 1–3 ACU = $2.25–6.75).
 *   - **Cursor / Codex** bill on actual token consumption, the rate varying by
 *     foundation model.
 *   This is EXACTLY 7.12's per-model `creditRate` × margin → internal-credit
 *   model. So a hosted CODING run must debit the SAME credit system planning
 *   does: a Motir user's credits cover planning AND coding, out of ONE
 *   `CreditLedger`. 9.1 therefore GENERALIZES 7.12's `PlanningRun` concept to an
 *   **`AgentRun` (kind: planning | coding)** and debits coding usage through
 *   7.12's `CreditLedger` / `CreditTransaction` — no second metering store, no
 *   second balance.
 *
 * **The architecture this story bakes in (locked):**
 *
 * 1. **A DIFFERENT image that EXTENDS 7.9.7's multi-agent base.** 7.9.7 ships
 *    the LOCAL multi-agent sandbox container the user runs on their own host
 *    (the agent-profile matrix: Claude Code / Codex CLI / OpenCode / Kimi /
 *    Antigravity / Cursor / Aider / Goose). 9.1's image is the CLOUD-HOSTED
 *    variant: it builds FROM that same base (same agent matrix, same Node floor,
 *    same credential-mount discipline) and adds hosted-only layers — the run
 *    harness + the hosted-mode entrypoint. It carries NO provider keys and does
 *    NO usage self-report: its agents' LLM `*_BASE_URL` point at the 9.0
 *    gateway (which injects Motir's managed keys and is the meter). One agent
 *    matrix, two deployment shapes (local-on-host, hosted-in-cloud). The local
 *    image is NOT replaced; the hosted image is its sibling.
 *
 * 2. **Auth IN the container is a short-lived RUN-SCOPED token — NO long-lived
 *    creds baked into the image.** Mirroring 7.1.5's job-scoped-token pattern, a
 *    hosted run is authenticated AS the dispatching user via a short-lived token
 *    minted at provision time, carried into the container, and used for: git /
 *    PR operations and the Motir API. The token expires with
 *    the run; the image carries no secret. (This is the cloud generalization of
 *    7.9.7's read-only credential MOUNTS — a hosted container has no host to
 *    mount from, so the credential is a minted run token, not a bind-mount.)
 *
 * 3. **Metering rides the 9.0 GATEWAY, not in-container self-report → 7.12's
 *    credit ledger.** The run's LLM egress is LOCKED to the 9.0 gateway (9.0.7);
 *    the orchestrator mints a per-run gateway VIRTUAL KEY (9.0.4) and injects it
 *    + the gateway base-URL into the container as the run's only LLM config; the
 *    gateway captures the PROVIDER's authoritative `usage` (9.0.5) and debits
 *    7.12's `CreditLedger` (9.0.6) — recording an `AgentRun` (kind=coding) so
 *    coding draws down the SAME balance as planning. 9.1 WIRES the run to the
 *    gateway + SURFACES the per-run usage/cost the gateway captured; there is NO
 *    in-sandbox self-report (that would be the wrong trust boundary — the
 *    container is the thing being billed).
 *
 * 4. **Reuses 7.6 dispatch.** A hosted run is dispatched from a READY item, the
 *    same as a BYOK prompt — it is a DISPATCH-TARGET VARIANT of 7.6.3's dispatch
 *    payload contract (the prose there already names "the future native
 *    AI-coding executor plugs into the SAME shape"). 9.1 is that executor.
 *
 * **Backward deps only (the Epic-9 audit posture).** Epic 9 builds on Epic 7 AND
 * on Story 9.0 (the gateway, which sorts BEFORE 9.1) — every 9.1 leaf depends
 * only on same-story 9.1.x ids, backward 9.0.x gateway ids (9.0.4 virtual keys,
 * 9.0.5 authoritative metering — 9.0 owns the credit debit via 9.0.6), or
 * DONE-or-planned 7.x ids (7.9.7 base, 7.6.3 dispatch, 7.12.2/7.12.3
 * metering+ledger, 7.1.5 token pattern referenced in prose). 9.0 < 9.1, so a dep
 * on 9.0.x is BACKWARD; no dep points ABOVE 9.1, and none points to an unplanned
 * future Epic-9 story. Because every upstream is not-yet-done, the status rule
 * makes the design + decision cards (`dependsOn: []`) `planned` and everything
 * else `blocked`.
 *
 * **The design gate fires.** 9.1 ships a real user-facing surface — kicking off
 * a hosted run + its live status/logs + per-run usage/credit-cost + the PR link
 * — so the FIRST subtask (9.1.1) is a `design` card producing
 * `design/hosted-agent/*.mock.html` + `design-notes.md`, and the UI code
 * subtask (9.1.8) depends on it and is `blocked` behind it.
 *
 * **Out of scope — named so they land in their own Epic-9 stories, not here
 * (visibly deferred, not forgotten):**
 *   - **The PR review / iteration loop** — review comments → the hosted agent
 *     iterates on the same run/PR (the "request changes, agent revises" cycle).
 *     9.1 opens a PR and stops; the loop is a later story.
 *   - **Multi-agent / parallel hosted runs** — N containers in flight at once,
 *     a run queue, concurrency limits per tenant. 9.1 is one container per run,
 *     sequential.
 *   - **Agent-selection policy** — which agent (from the matrix) runs an item,
 *     auto-picked by item type / cost / past success. 9.1 takes the agent as a
 *     dispatch parameter; the POLICY is later.
 *   - **Hosted-run pricing in Epic-8 billing** — the $-price of a hosted run,
 *     hosted-run tiers, the checkout that tops up credits for coding. 9.1 debits
 *     the EXISTING credit ledger; the storefront stays Epic 8.
 *   - **Security hardening** — egress allow-listing, secret-scanning the agent's
 *     diffs, supply-chain attestation of the image, per-run network policy
 *     beyond the 9.1.3 baseline. 9.1 ships the provisioning baseline; the
 *     hardening pass is a dedicated later story.
 */
export const story_9_1: PlanStory = {
  id: '9.1',
  title:
    'Hosted agent container — auth + gateway-metered token usage (the hosted-execution foundation)',
  status: 'planned',
  gitBranch: 'feat/PROD-9.1-hosted-agent-container',
  descriptionMd:
    'The foundation of **Epic 9 (Native AI coding)**: Motir runs the coding ' +
    'agent itself, in a hosted cloud sandbox, ON THE USER’S BEHALF — ' +
    'AUGMENTING the Epic-7 BYOK path (`motir auto` on the user’s own machine, ' +
    'the user’s own agent). A hosted run is dispatched from a ready item ' +
    '(reusing 7.6 dispatch), Motir provisions ONE container per run, the ' +
    'selected agent clones the repo and autonomously edits, the run opens a ' +
    'PR, and a human reviews — the verified cloud-agent lifecycle Devin / ' +
    'Google Jules / OpenAI Codex cloud / GitHub Copilot coding agent all ' +
    'share (dispatch → provision sandbox → agent works → PR → review).\n\n' +
    '**The architecture (locked — see the module header for the full ' +
    'rationale + the cited mirror):**\n\n' +
    '- **A DIFFERENT image that EXTENDS 7.9.7’s LOCAL multi-agent base.** ' +
    '7.9.7 is the container the user runs locally (the agent-profile matrix); ' +
    '9.1’s image builds FROM it and adds the hosted-only layers (run harness, ' +
    'hosted entrypoint). It carries NO provider keys — its agents’ LLM ' +
    '`*_BASE_URL` point at the 9.0 gateway. One agent matrix, two deployment ' +
    'shapes — the local image is not replaced.\n' +
    '- **Auth IN the container is a short-lived RUN-SCOPED token** (mirroring ' +
    '7.1.5’s job-scoped-token pattern) — used for git/PR and the Motir API; ' +
    'it expires with the run. **NO long-lived creds baked ' +
    'into the image.** (LLM auth is separate: the per-run GATEWAY virtual key, ' +
    '9.0.4.)\n' +
    '- **Metering rides the 9.0 GATEWAY, not in-container self-report.** ' +
    'The meter sits OUTSIDE the billed sandbox’s trust boundary — the run’s ' +
    'LLM egress is LOCKED to the 9.0 gateway (9.0.7), the orchestrator mints a ' +
    'per-run gateway VIRTUAL KEY (9.0.4), and the gateway captures the ' +
    'PROVIDER’s authoritative `usage` (9.0.5) and debits 7.12’s `CreditLedger` ' +
    '(9.0.6). Hosted CODING runs thus draw down the SAME credit system as ' +
    'planning — a user’s credits cover planning AND coding (an `AgentRun` ' +
    'kind=coding, the generalized `PlanningRun`). 9.1 WIRES the run to the ' +
    'gateway + SURFACES the captured usage/cost; the container does NOT ' +
    'self-report. (Usage-based billing is ' +
    'the verified mirror: Copilot’s AI-credits-by-token, Devin’s ACUs, ' +
    'Cursor/Codex token-burn.)\n' +
    '- **Reuses 7.6 dispatch** — a hosted run is a DISPATCH-TARGET VARIANT of ' +
    '7.6.3’s payload contract (the executor the 7.6.3 prose reserved a seam ' +
    'for).\n\n' +
    '**Scope:** the hosted-run surface design (9.1.1); the hosted-execution ' +
    'architecture decision — orchestration, lifecycle, metering via the 9.0 ' +
    'gateway (9.1.2); the infra provisioning (9.1.3); the hosted container ' +
    'image extending 7.9.7 (9.1.4); the in-container run-scoped auth (9.1.5); ' +
    'wiring the run to the 9.0 gateway + surfacing the gateway-captured ' +
    'usage/cost on the run record (9.1.6); the hosted-run ' +
    'orchestration from a 7.6 dispatch (9.1.7); the hosted-run UI (9.1.8); ' +
    'vitest (9.1.9).\n\n' +
    '**Out of scope (named so they land in their own Epic-9 stories, not ' +
    'here):** the PR review/iteration loop (review comments → the agent ' +
    'revises); multi-agent / parallel hosted runs; agent-selection policy ' +
    '(which agent runs an item); hosted-run PRICING in Epic-8 billing (9.1 ' +
    'debits the existing ledger — the storefront stays Epic 8); security ' +
    'hardening (egress allow-listing, diff secret-scanning, image ' +
    'attestation — 9.1 ships the provisioning baseline).',
  verificationRecipeMd:
    '- Pull the Story branch; with both services up (motir-core on `:3000`, ' +
    'motir-ai on its dev port, each pointed at the other) and the hosted-run ' +
    'infra reachable (9.1.3 — a local container host is enough for the smoke), ' +
    'open a READY item and choose **Run hosted** (vs the BYOK “copy prompt” / ' +
    '`motir auto`).\n' +
    '- **The lifecycle, end to end.** The dispatch provisions ONE container ' +
    'for the run; the hosted-run view streams status (`provisioning → cloning ' +
    '→ running → opening PR → done`) and live logs; on success a PR link ' +
    'appears and the item moves to the review state. Confirm the container is ' +
    'torn down after the run (no lingering sandbox) and that the lifecycle ' +
    'TIMEOUT cleans up a run that overruns.\n' +
    '- **Run-scoped auth (no baked creds).** Inspect the image: it carries NO ' +
    'long-lived git/API/agent secret. The run authenticates with a short-lived ' +
    'token minted at provision time; after the run’s TTL the same token is ' +
    'rejected (assert a post-expiry call 401s), and the PR was made AS the ' +
    'dispatching user (visible in the PR author / the ' +
    'run’s attribution).\n' +
    '- **Gateway metering → credit debit (via 9.0).** After the run, confirm ' +
    'the run’s LLM calls went THROUGH the 9.0 gateway on a per-run virtual key ' +
    '(9.0.4 — the container held no provider key), the gateway captured the ' +
    'PROVIDER’s authoritative `usage` (9.0.5), and a ' +
    '`CreditTransaction` debit landed against the SAME `CreditLedger` planning ' +
    'uses (9.0.6) — recorded as an `AgentRun` `kind = coding` carrying the ' +
    'model + the in/out tokens, the balance dropped by `tokens × rate × ' +
    'margin` for the run’s model (7.12.3’s conversion, unchanged). A planning ' +
    'run and a coding run debit ONE balance. Confirm the run record SURFACES ' +
    'that per-run usage/cost (no in-sandbox self-report).\n' +
    '- **The display.** The hosted-run view shows the per-run token usage + ' +
    'the credit cost + the PR link; the project usage view (7.12.5) now lists ' +
    'the coding run alongside planning runs (the generalized `AgentRun`). NO ' +
    'checkout / buy-credits control appears (Epic 8).\n' +
    '- `pnpm test` (motir-core) + the motir-ai suite — 9.1.9 covers the run ' +
    'harness, the gateway wiring (per-run virtual key + base-URL injection → ' +
    'the gateway-captured usage/cost surfaced on the run), the run-scoped ' +
    'auth (mint / present / expire / reject), and the lifecycle ' +
    '(timeout/cleanup).\n' +
    '- **Open-core boundary review (this Epic’s recurring posture).** No ' +
    '`motir-ai` import in `motir-core` (HTTP only); the metering + ledger live ' +
    'only in motir-ai; the container reaches Motir ONLY through the ' +
    'run-scoped-token endpoints; browsers never call motir-ai or the ' +
    'container.\n' +
    '- If every step holds, approve and merge the Story PR. If anything ' +
    'fails, comment with what didn’t work and Motir will produce a follow-up ' +
    'Subtask under the same Story.',
  items: [
    {
      id: '9.1.1',
      title:
        'Design — the hosted-run surface (kick off from a ready item, live status/logs, per-run usage + credit cost, the PR link)',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        '**Type:** design (the planning-time design gate, Principle #13 + the ' +
        'design-reference rule). The hosted-run UI (9.1.8) depends on this ' +
        'card; without it the surface would be improvised, which is forbidden ' +
        '(notes.html #31).\n\n' +
        'Produce the design asset for the **hosted-run surface** under ' +
        '`motir-core/design/hosted-agent/`. Author it as a **`*.mock.html` ' +
        'mockup** built from the real design system (the shipped ' +
        '`components/ui/*` primitives + the `--el-*` colour tokens + the ' +
        '`[data-display-style]` shape tokens) — NOT a `.pen`. The HTML route is ' +
        'preferred when a coding agent produces the design (no translation ' +
        'gap; the reviewer sees the actual tokens). A PNG export is optional; ' +
        'the `.mock.html` is the source of truth (MOTIR.md § Design-reference ' +
        'rule).\n\n' +
        '**Mirror (cited — the cloud-agent run surface).** Devin / Jules / ' +
        'Codex cloud / Copilot coding agent all present the same shape: a run ' +
        'you KICK OFF from a ticket, a live status + streamed log/plan view ' +
        'while it works, and a PULL REQUEST link as the terminal output (a ' +
        'human reviews/merges). Draw THAT — plus Motir’s differentiator: the ' +
        'per-run TOKEN USAGE + the CREDIT COST shown inline (the lovart/cost-' +
        'plus transparency 7.12 established, now for a coding run).\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the multi-' +
        'panel rule, mistake #31):\n\n' +
        '- **Panel 1 — the kick-off / dispatch-target choice.** On a ready ' +
        'item’s dispatch affordance, the choice between **Run hosted** (Motir ' +
        'runs the agent in the cloud) and the existing BYOK path (copy prompt ' +
        '/ `motir auto`). Show the agent selector (from the 7.9.7 matrix — ' +
        'Claude Code / Codex / … — taken as a parameter here; the auto-pick ' +
        'POLICY is a deferred Epic-9 story) and a “this will spend credits” ' +
        'affordance with an estimate caveat.\n' +
        '- **Panel 2 — the live run view (running).** Status as a clear ' +
        'lifecycle stepper (`provisioning → cloning → running → opening PR → ' +
        'done`) + a streamed LOG/console region (the agent’s output) with an ' +
        'aria-live region; a cancel control (lifecycle teardown). Plan the log ' +
        'for SCALE — virtualize / tail, never “render every line” (the at-' +
        'scale rule).\n' +
        '- **Panel 3 — the run-complete state (the PR + the cost).** The ' +
        'opened PR as the hero link (open in GitHub), the per-run TOKEN usage ' +
        '(model, in/out tokens, steps) and the CREDIT cost debited, and the ' +
        'item’s new review state. This is the “dispatch a ticket, get a PR ' +
        'back” payoff.\n' +
        '- **Panel 4 — the run history / list.** A paginated list of a ' +
        'project’s hosted runs (item, agent, status, duration, tokens, ' +
        'credits, PR) — plan for SCALE (paginate/lazy; a project accrues many ' +
        'runs — no “load all rows”). Use the palette (per-status tint via ' +
        '`Pill` tones, not grey-only — finding #54).\n' +
        '- **Panel 5 — the failure / out-of-credits / empty / loading ' +
        'states.** A run-FAILED state (agent non-zero / provision failure / ' +
        'timeout) with the log tail + a re-run affordance; the OUT-OF-CREDITS ' +
        'state (a hosted run refused because the shared 7.12 balance is ≤ 0 — ' +
        'a `--el-warning` banner naming the limit, NO active buy control: the ' +
        'Epic-8 upgrade slot, per 7.12.1); the empty state (no runs yet); the ' +
        'loading skeleton.\n\n' +
        'Also write **`design/hosted-agent/design-notes.md`** naming the exact ' +
        'primitives used per surface, the exact copy strings, the placement ' +
        'decisions, the per-`--el-*` colour role for each element (incl. the ' +
        'per-status `Pill` tones + the `--el-warning` out-of-credits role), ' +
        'and a “primitives composed (no hand-rolling)” checklist (the ' +
        'design-notes.md convention 1.3.3 / 1.5.1 / 7.0.1 / 7.12.1 ' +
        'established). It MUST state, in writing, that checkout/pricing/' +
        'upgrade is Epic 8 and absent here (only a passive out-of-credits ' +
        'placeholder), and that the PR review/iteration loop + the agent-' +
        'selection POLICY are deferred Epic-9 stories (this surface takes the ' +
        'agent as a parameter and stops at PR-opened).\n\n' +
        '**Branch.** `design/PROD-9.1.1-hosted-run-surface`. The `design/*` ' +
        'prefix gate skips CI E2E + the Vercel preview deploy (MOTIR.md ' +
        '§ Plan-seed Workflow) — this PR only edits `design/hosted-agent/**`, ' +
        'no app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/hosted-agent/hosted-run.mock.html` exists, ' +
        'renders the five panels above, and references ONLY `--el-*` tokens + ' +
        '`[data-display-style]` shape tokens (no Tier-0 `--color-*`, no hand-' +
        'rolled spacing — the `motir-core/CLAUDE.md` § colour / shape rules).\n' +
        '- `motir-core/design/hosted-agent/design-notes.md` exists, names ' +
        'every primitive composed + every copy string + the per-element ' +
        '`--el-*` role, and STATES the deferrals (checkout = Epic 8; PR ' +
        'review-loop + agent-selection policy = later Epic-9 stories).\n' +
        '- The kick-off panel shows the hosted-vs-BYOK choice + the agent ' +
        'selector + the spends-credits affordance; the live view shows the ' +
        'lifecycle stepper + a virtualized/tailed log (not load-all); the ' +
        'complete state shows the PR link + per-run tokens + credit cost.\n' +
        '- The out-of-credits + failed states are drawn with NO active ' +
        'buy/upgrade control (Epic-8 placeholder); the run history is ' +
        'paginated/lazy (at-scale).\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Pill`, ' +
        '`Button`, `EmptyState`, a table/list pattern, the skeleton/loader) — ' +
        'if a genuinely new primitive is needed, that is a NEW `design/` ' +
        'subtask, not a code workaround.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/ai-usage/` (7.12.1) + `motir-core/design/' +
        'dispatch/` (7.6.1) — the closest existing design areas (usage ' +
        'transparency + the dispatch surface); mirror their layout + ' +
        '`design-notes.md` shape.\n' +
        '- `motir-core/components/ui/Pill.tsx`, `Card.tsx`, `Button.tsx`, ' +
        '`EmptyState.tsx` — the composable surface.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` colour (incl. ' +
        '`--el-warning`) + `[data-display-style]` shape tokens.\n' +
        '- The cloud-agent run-surface mirror (web-verified 2026-06-12): ' +
        'Devin, Google Jules, OpenAI Codex cloud, GitHub Copilot coding agent ' +
        '— dispatch → live status/logs → PR link.\n' +
        '- Story 8 (stub) — the Epic-8 billing the out-of-credits state defers ' +
        'to.',
      dependsOn: [],
    },
    {
      id: '9.1.2',
      title:
        'Decision — the hosted-execution architecture: container orchestration, the run lifecycle, metering via the 9.0 gateway',
      status: 'planned',
      type: 'decision',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        '**Type:** decision (the keystone ADR the hosted image / auth / ' +
        'gateway-wiring / orchestration cards all build against). Produce a living ' +
        'architecture document; no app behavior ships here, but the shapes it ' +
        'fixes are load-bearing for the rest of 9.1 and all of Epic 9.\n\n' +
        'Write `motir-ai/docs/hosted-execution.md` (owned by the side that ' +
        'operates the runs; `motir-core` links it from a short pointer). It ' +
        'MUST fix three things:\n\n' +
        '1. **Container orchestration.** How a run’s container is provisioned ' +
        'and run: **container-per-run** (one fresh, isolated container per ' +
        'dispatched item — the Devin/Jules/Codex/Copilot consensus: ephemeral, ' +
        'single-use, not reused) on a runner/orchestrator. Fix the ' +
        'orchestrator choice (a container runtime + a thin run-orchestrator ' +
        'service vs a managed sandbox provider) with the durable interface ' +
        'BEHIND it, so the provider can swap without touching callers (no ' +
        'shortcut, no premature SaaS lock-in — the 7.1.4 “durable + self-' +
        'hostable, broker swaps behind the interface” posture). Fix isolation ' +
        '(filesystem confined to the run workspace; no host filesystem; no ' +
        'docker socket — the 7.9.7 posture, cloud variant) and the LIFECYCLE ' +
        '(a per-run TIMEOUT + guaranteed teardown/cleanup even on crash, so a ' +
        'hung agent can’t leak a container or burn unbounded tokens).\n' +
        '2. **The run lifecycle.** The state machine ' +
        '`dispatched → provision → run → PR → teardown` (with `failed` / ' +
        '`canceled` / `timed_out` branches), what each transition emits ' +
        '(status + log events the 9.1.8 UI streams), and where it persists ' +
        '(the `AgentRun` record — see 9.1.6’s generalization of 7.12’s ' +
        '`PlanningRun`). Tie it to the 7.6 dispatch entry (a hosted run starts ' +
        'from a 7.6.3 dispatch payload, a dispatch-target variant) and the ' +
        'review exit (the PR link; the item’s review state).\n' +
        '3. **Metering via the 9.0 GATEWAY (the trust-boundary posture).** The ' +
        'meter sits OUTSIDE the billed sandbox’s trust boundary — at the 9.0 ' +
        'gateway, NEVER via in-container self-report (the container runs an ' +
        'autonomous agent editing code; it is the thing being billed, so its ' +
        'own report of its spend is untrustworthy — notes.html #33: verify, ' +
        'don’t trust). Fix that: (a) the run’s LLM EGRESS is LOCKED to the 9.0 ' +
        'gateway (9.0.7 — a network policy + an injected `*_BASE_URL` is the ' +
        'container’s only LLM config); (b) the container holds NO provider key ' +
        '— the gateway injects Motir’s managed keys (9.0.2/9.0.3); (c) the ' +
        'orchestrator mints a per-run gateway VIRTUAL KEY (9.0.4) and the ' +
        'gateway captures the PROVIDER’s authoritative `usage` (9.0.5), ' +
        'debiting 7.12’s ledger (9.0.6). 9.1’s job is to WIRE the run to the ' +
        'gateway (inject the per-run virtual key + the gateway base-URL) and ' +
        'SURFACE the gateway-captured per-run usage/cost on the `AgentRun` ' +
        'record — NOT to capture usage in the sandbox. Record the injection ' +
        'shape (which `*_BASE_URL` vars each Tier-1 agent in the 7.9.7 matrix — ' +
        'Claude Code / Codex / OpenCode / Kimi — honors to route through the ' +
        'gateway) so the wiring is agent-aware even though the meter is the ' +
        'gateway for all of them.\n\n' +
        'Also fix the run-scoped AUTH shape at the architecture level (the ' +
        '9.1.5 detail builds on it): a short-lived token minted at provision, ' +
        'scoped to the run + the dispatching user, used for git/PR + the Motir ' +
        'API; expires with the run; NO long-lived secret in ' +
        'the image (the 7.1.5 job-scoped-token pattern, generalized to a ' +
        'container). LLM auth is SEPARATE — the per-run gateway virtual key ' +
        '(9.0.4), not the Motir run token.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-ai/docs/hosted-execution.md` exists and fixes ' +
        'orchestration (container-per-run + the swappable interface + ' +
        'isolation + the timeout/cleanup lifecycle), the run lifecycle state ' +
        'machine (`dispatched → provision → run → PR → teardown` + failure ' +
        'branches + the emitted status/log events), and the metering posture ' +
        '(via the 9.0 gateway — egress lock + per-run virtual key + base-URL ' +
        'injection, NOT in-container self-report) with the per-Tier-1-agent ' +
        '`*_BASE_URL` injection note.\n' +
        '- The container-per-run + ephemeral-isolation decision cites the ' +
        'verified mirror (Devin/Jules/Codex/Copilot) rather than asserting ' +
        'it.\n' +
        '- The run-scoped-auth shape is fixed (short-lived, run-+-user-scoped, ' +
        'no baked secret) as the contract 9.1.5 implements.\n' +
        '- It names the env/infra inputs 9.1.3 must provision (the container ' +
        'host/orchestrator, the hosted-image registry, the run-sandbox secrets ' +
        '+ network policy) — the explicit input to the 9.1.3 manual card.\n' +
        '- `motir-core` carries a short pointer doc to it; the deferrals (PR ' +
        'review-loop, parallel runs, agent-selection policy, hardening) are ' +
        'restated as out-of-9.1.\n\n' +
        '## Context refs\n\n' +
        '- This module header (the locked architecture + the cited mirror).\n' +
        '- 7.9.7 (`packages/cli/sandbox/`) — the LOCAL multi-agent base image ' +
        'the hosted image extends (same agent matrix + isolation posture); the ' +
        'cloud variant generalizes its credential MOUNTS to a minted run ' +
        'token.\n' +
        '- 7.1.5 — the job-scoped-token pattern the run-scoped token mirrors.\n' +
        '- Story 9.0 — the LLM metering gateway this run meters THROUGH: 9.0.4 ' +
        '(per-run virtual keys), 9.0.5 (authoritative provider-`usage` ' +
        'capture), 9.0.6 (the credit debit into 7.12), 9.0.7 (the egress ' +
        'lock + the `*_BASE_URL` injection shape 9.1 wires).\n' +
        '- 7.12.2 / 7.12.3 — the metering + ledger the gateway feeds (the ' +
        '`PlanningRun` → `AgentRun` generalization the lifecycle persists ' +
        'into).\n' +
        '- 7.6.3 — the dispatch payload contract a hosted run is a target ' +
        'variant of (the seam its prose reserved for the native AI-coding ' +
        'executor).\n' +
        '- Cloud-agent lifecycle (web-verified 2026-06-12): Devin (own cloud ' +
        'env per task → PR), Google Jules (fresh VM per task, clone → plan → ' +
        'PR), OpenAI Codex cloud (per-task isolated sandbox → PR), GitHub ' +
        'Copilot coding agent (ephemeral single-use runners → draft PR).',
      dependsOn: [],
    },
    {
      id: '9.1.3',
      title:
        'Provision the hosted-run infrastructure — container host/orchestrator, image registry, run-sandbox secrets + network policy (manual)',
      status: 'blocked',
      type: 'manual',
      executor: 'human',
      estimateMinutes: 35,
      descriptionMd:
        '**Type:** manual/human (no PR — infra / dashboard / secret work, ' +
        'mirror 1.6.7; marked done on Yue’s confirmation). A coding agent ' +
        'cannot stand up a container host, create a private image registry, or ' +
        'mint production infra secrets. Wired here via `dependsOn` so the ' +
        'prerequisite is visible at PLAN time (notes.html #30), not discovered ' +
        'at run time.\n\n' +
        'Using the infra inventory fixed by 9.1.2:\n\n' +
        '1. **The container host / orchestrator** — provision where hosted ' +
        'runs execute (the container runtime + the run-orchestrator surface ' +
        '9.1.2 chose), separate from the motir-core / motir-ai web tiers (a ' +
        'run is untrusted-ish compute — it executes an agent editing code — so ' +
        'it lives apart). Capacity enough for the sequential one-container-per-' +
        'run baseline (parallel runs are a deferred Epic-9 story).\n' +
        '2. **The hosted-image registry** — a private registry the 9.1.4 image ' +
        'publishes to and the orchestrator pulls from (the hosted variant of ' +
        '7.9.7’s image).\n' +
        '3. **Run-sandbox secrets + network policy** — the orchestrator’s ' +
        'credential to mint/sign run-scoped tokens (the signing key the 9.1.5 ' +
        'auth uses), and the baseline network policy for a run container ' +
        '(egress OPEN by default — agents need their model APIs + git remotes, ' +
        'the 7.9.7 “confine the filesystem, not egress” posture; the egress ' +
        'ALLOW-LISTING hardening is a deferred Epic-9 story, named so it isn’t ' +
        'forgotten). Wire the env keys 9.1.2 named on each side.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A container host / orchestrator exists for hosted runs, separate ' +
        'from the web tiers, sized for the sequential baseline.\n' +
        '- A private image registry exists; the 9.1.4 image can be pushed to ' +
        'and pulled from it.\n' +
        '- The run-token signing secret + the baseline run-container network ' +
        'policy are set, and all infra env keys from 9.1.2’s inventory are ' +
        'present in each environment.\n' +
        '- Yue confirms; Motir marks the subtask done (no PR).\n\n' +
        '## Context refs\n\n' +
        '- 9.1.2’s infra/env inventory + the orchestration decision.\n' +
        '- 7.1.2 (the motir-ai provisioning manual card) — the precedent shape ' +
        'for provisioning + secret wiring.\n' +
        '- 7.9.7 — the image whose hosted variant this registry serves.',
      dependsOn: ['9.1.2'],
    },
    {
      id: '9.1.4',
      title:
        'The HOSTED container image (extends 7.9.7’s multi-agent base) — run harness + hosted entrypoint (LLM egress points at the 9.0 gateway, NO provider keys)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 80,
      descriptionMd:
        'Build the HOSTED container image — the cloud-hosted SIBLING of ' +
        '7.9.7’s local multi-agent sandbox. It builds FROM 7.9.7’s base (same ' +
        'agent-profile matrix — Claude Code / Codex / OpenCode / Kimi / … — ' +
        'same Node floor, same isolation posture) and ADDS the hosted-only ' +
        'layers; the local 7.9.7 image is NOT replaced (one agent matrix, two ' +
        'deployment shapes). Deliverable under `packages/cli/sandbox/hosted/` ' +
        '(a hosted Dockerfile + harness sources alongside 7.9.7’s ' +
        '`packages/cli/sandbox/`).\n\n' +
        '**The run harness (the hosted run’s main loop).** Given a run’s ' +
        'inputs (the target repo + ref, the dispatched item’s generated prompt ' +
        'from 7.6, the selected agent, the run-scoped token), the harness: ' +
        '(1) CLONES the repo (over the run-scoped token — git auth is 9.1.5), ' +
        '(2) runs the SELECTED agent on the dispatched prompt headlessly (the ' +
        'agent-profile invocation from the 7.9.7 matrix, in its auto-approve ' +
        'mode — the container is the wall), (3) opens a PULL REQUEST with the ' +
        'agent’s changes (branch → push → PR, as the dispatching user via the ' +
        'run-scoped token). On agent failure / non-zero it reports the failure ' +
        '+ the log tail and does NOT open a PR. This is the in-container ' +
        'realization of the Devin/Jules/Codex/Copilot “clone → agent edits → ' +
        'open PR” lifecycle (web-verified).\n\n' +
        '**LLM egress points at the 9.0 GATEWAY — NO provider keys, NO ' +
        'self-report.** The image carries NO provider API keys; instead its ' +
        'agents’ LLM `*_BASE_URL` (`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / ' +
        'the per-agent equivalents) point at the 9.0 gateway, which injects ' +
        'Motir’s managed keys on egress (9.0.2/9.0.3). The container’s only LLM ' +
        'credential is the per-run gateway VIRTUAL KEY (9.0.4), injected at ' +
        'provision (9.1.7) alongside the gateway base-URL. The container does ' +
        'NOT meter or self-report its own usage — that was the WRONG trust ' +
        'boundary (the container is the thing being billed). The gateway is the ' +
        'authoritative meter (9.0.5) and debits the ledger (9.0.6); 9.1.6 only ' +
        'SURFACES the gateway-captured per-run usage/cost on the run record. ' +
        'So the image just needs the agent CLIs configured to honor the ' +
        'injected `*_BASE_URL` + virtual key (the gateway is ' +
        'OpenAI/Anthropic-compatible, 9.0.3, so this is transparent).\n\n' +
        '**The hosted-mode entrypoint.** A hosted entrypoint distinct from ' +
        '7.9.7’s interactive `motir auto` shell: it reads the run inputs from ' +
        'the orchestrator (env / a mounted run-spec), runs the harness once, ' +
        'emits structured status/log events the 9.1.7 orchestration streams to ' +
        'the UI, and EXITS (one run = one container = one process, then ' +
        'teardown). NO long-lived credential is baked into the image (auth is ' +
        'the minted run-scoped token, 9.1.5); filesystem confined to the run ' +
        'workspace; no docker socket (the 7.9.7 isolation, cloud variant).\n\n' +
        'This card builds the IMAGE + the harness/entrypoint; the ' +
        'minting + presentation of the run-scoped token is 9.1.5, the ' +
        'gateway-wiring + usage SURFACING is 9.1.6, and the orchestration that ' +
        'provisions + injects the gateway virtual key/base-URL + streams it ' +
        'is 9.1.7 — this is the unit those compose.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The hosted image builds FROM the 7.9.7 base (asserted: it does not ' +
        're-define the agent matrix — it inherits it) and adds the harness + ' +
        'hosted entrypoint; `docker build` succeeds from a clean ' +
        'checkout and the image runs the hosted entrypoint’s liveness check.\n' +
        '- Given a run spec (repo + ref + prompt + agent + a STUB run-scoped ' +
        'token + a STUB gateway base-URL/virtual key), the harness clones, ' +
        'runs the agent, and opens a PR on a ' +
        'fixture repo with a FAKE agent (a script that edits a file, exits 0) ' +
        '— asserted in a CI-friendly smoke that needs ' +
        'NO real LLM; a non-zero fake agent yields a reported failure + no ' +
        'PR.\n' +
        '- The image carries NO provider keys and does NO usage self-report: ' +
        'the agents’ LLM `*_BASE_URL` resolve to the injected gateway base-URL ' +
        '(asserted: a fake agent’s model call hits the stub gateway, not a ' +
        'provider host) and the virtual key is the only LLM credential.\n' +
        '- NO long-lived secret is present in the image (asserted); ' +
        'filesystem writes outside the run workspace fail; no docker socket ' +
        'inside.\n' +
        '- The hosted entrypoint runs ONCE and exits (one run per container), ' +
        'emitting structured status/log events.\n\n' +
        '## Context refs\n\n' +
        '- 7.9.7 (`packages/cli/sandbox/`) — the LOCAL multi-agent base image ' +
        'this EXTENDS (the agent-profile matrix + Node floor + isolation it ' +
        'inherits; the credential MOUNTS it generalizes to a minted token).\n' +
        '- 9.1.2 — the orchestration + lifecycle + the gateway-metering ' +
        'posture this harness implements.\n' +
        '- 9.0.3 / 9.0.4 / 9.0.7 — the OpenAI/Anthropic-compatible gateway the ' +
        'agents’ `*_BASE_URL` target, the per-run virtual key (the only LLM ' +
        'credential), and the egress-lock contract the base-URL injection ' +
        'realizes.\n' +
        '- 7.6.2 / 7.6.3 — the generated prompt + dispatch payload the harness ' +
        'runs the agent on (a hosted run is a 7.6 dispatch-target variant).\n' +
        '- `packages/cli/` — the built `motir` binary / shared sources the ' +
        'image bundles.',
      dependsOn: ['9.1.2'],
    },
    {
      id: '9.1.5',
      title:
        'Auth / login in the container — the run authenticated AS the user via a short-lived run-scoped token (no baked-in long-lived creds)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Make a hosted run act AS the dispatching user without baking any ' +
        'long-lived credential into the image — the cloud generalization of ' +
        '7.1.5’s job-scoped-token pattern (7.9.7 mounts the user’s real ' +
        'credentials read-only; a hosted container has no host to mount from, ' +
        'so the credential is a MINTED, short-lived run token, not a ' +
        'bind-mount).\n\n' +
        '**Mint at provision (the orchestrator side, motir-core/-ai).** When a ' +
        'run is provisioned (9.1.7), mint a short-lived RUN-SCOPED token ' +
        '(signed with the 9.1.3 run-token signing secret) encoding the run id ' +
        '+ the dispatching user + the target project/repo + a TTL bounded by ' +
        'the lifecycle timeout. It is injected into the container as the ONLY ' +
        'credential — never an agent API key, never a long-lived git token, ' +
        'never a service secret.\n\n' +
        '**Present in the container (two uses).** The harness (9.1.4) ' +
        'presents the run-scoped token for: (a) **git / PR** — clone + push + ' +
        'open-PR AS the user (via the GitHub identity the 9.1.7 orchestration ' +
        'exchanges the run token for, or a scoped installation token minted ' +
        'for the run — fix per the 9.1.2 decision; the user is the PR author); ' +
        '(b) **the Motir API** — any read it needs (the dispatched item’s ' +
        'prompt/context), permission-checked AS the user, the 7.1.6 read-back ' +
        'posture. (LLM egress is NOT one of these — that goes to the 9.0 ' +
        'gateway on the per-run gateway VIRTUAL KEY, 9.0.4, a SEPARATE ' +
        'credential; there is no in-container usage report.)\n\n' +
        '**Verify + expire (the server side).** Every endpoint the container ' +
        'hits validates the run-scoped token (signature + TTL + run/user/' +
        'project match) and REJECTS an expired or foreign token (a token from ' +
        'a finished/torn-down run is dead; a token for run A cannot act on run ' +
        'B or another tenant — 404-not-403 cross-tenant, the standing guard). ' +
        'The token is single-purpose and run-bounded: it cannot be replayed ' +
        'after teardown.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A run-scoped token is minted at provision (signed, encoding run + ' +
        'user + project/repo + a TTL ≤ the lifecycle timeout) and is the ONLY ' +
        'credential injected — no agent key / long-lived git token / service ' +
        'secret in the container.\n' +
        '- The container authenticates git/PR and the Motir API read with the ' +
        'run-scoped token; the PR is authored AS the dispatching user. (LLM ' +
        'egress uses the separate 9.0.4 gateway virtual key, not this token.)\n' +
        '- An expired token (post-TTL / post-teardown) is rejected (401); a ' +
        'token scoped to run A / tenant A cannot act on run B / tenant B ' +
        '(rejected; 404-not-403 cross-tenant).\n' +
        '- Verified end-to-end with the 9.1.4 harness over a fixture: the run ' +
        'acts AS the user, and a tampered/expired token fails the run cleanly ' +
        'rather than acting unauthenticated.\n' +
        '- No long-lived credential anywhere in the image or the run spec ' +
        '(asserted) — auth is exclusively the minted run-scoped token.\n\n' +
        '## Context refs\n\n' +
        '- 7.1.5 — the job-scoped-token MINT pattern this generalizes (signed, ' +
        'short-TTL, user+project-scoped, presented on read-back).\n' +
        '- 7.1.6 — the permission-checked-as-the-user read-back posture the ' +
        'container’s Motir API reads mirror.\n' +
        '- 9.1.4 — the harness that PRESENTS the token (git/PR + the Motir API ' +
        'read).\n' +
        '- 9.1.2 — the run-scoped-auth shape fixed at the architecture level ' +
        '(+ how the run token exchanges for the GitHub identity).\n' +
        '- 9.1.3 — the run-token signing secret this mints/verifies against.',
      dependsOn: ['9.1.4'],
    },
    {
      id: '9.1.6',
      title:
        'Meter the run VIA the 9.0 gateway — wire the per-run gateway virtual key + base-URL into the run, surface the gateway-captured usage/credit cost on the `AgentRun` (NO in-sandbox self-report)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'Meter a hosted CODING run AUTHORITATIVELY by routing its LLM traffic ' +
        'THROUGH the 9.0 gateway — NOT by trusting an in-container ' +
        'self-report. The meter sits OUTSIDE the billed sandbox’s trust ' +
        'boundary (the container runs an autonomous agent editing code; it is ' +
        'the thing being billed, so its own report of its spend is ' +
        'untrustworthy — that was the WRONG trust boundary and is removed). The ' +
        'gateway already OWNS the metering + the credit debit: it captures the ' +
        'PROVIDER’s authoritative `usage` (9.0.5) and debits 7.12’s ' +
        '`CreditLedger` (9.0.6). THIS card’s job is to (a) WIRE the run to the ' +
        'gateway — mint the per-run gateway VIRTUAL KEY (9.0.4) and inject it + ' +
        'the gateway base-URL into the run — and (b) SURFACE the ' +
        'gateway-captured per-run usage/credit cost on the run record for the ' +
        '9.1.8 UI. So a hosted CODING run spends from the SAME credits planning ' +
        'does (a user’s credits cover planning AND coding, ONE balance, ONE ' +
        'ledger — owned by motir-ai), with no second metering store.\n\n' +
        '**Wire the run to the gateway (mint + inject).** At provision (driven ' +
        'by 9.1.7), request the gateway to mint a short-lived, run-scoped ' +
        'VIRTUAL KEY (9.0.4 — carrying the tenant/run id, a TTL bounded by the ' +
        'lifecycle timeout, a quota cap from the tenant’s remaining credits) ' +
        'via the gateway-admin client, and inject it + the gateway base-URL ' +
        'into the container as the run’s only LLM config (the agents’ ' +
        '`*_BASE_URL`, 9.1.4). The orchestrator reaches the gateway over HTTP ' +
        '(the open-core boundary: motir-core/-ai never import the gateway). On ' +
        'teardown the virtual key is revoked (9.0.4). There is NO usage-report ' +
        'endpoint the container POSTs to — the gateway is the meter.\n\n' +
        '**Generalize `PlanningRun` → `AgentRun` (kind: planning | coding) — in ' +
        'motir-ai.** 7.12.2 modelled `PlanningRun` (jobId, model, tenant, ' +
        'sessionId, token totals) + `PlanningTurn`. Add a `kind` discriminator ' +
        '(default `planning` for every existing planning row — a non-breaking ' +
        'migration) so a CODING run is the same shape: `AgentRun { kind: ' +
        'coding, runId (the 9.1 hosted run, not a 7.1.4 PlanJob), model, ' +
        'tenant, totalInputTokens, totalOutputTokens, steps }`. The ' +
        'gateway’s spend (9.0.6) records into THIS `AgentRun` (kind=coding) — ' +
        'it is the metering home the gateway debit references — so the 7.12.5 ' +
        'usage display + the monthly aggregation see coding runs ALONGSIDE ' +
        'planning runs with no new store (a coding run is just an `AgentRun` ' +
        'whose kind is coding). Keep the rename additive + back-compatible ' +
        '(existing planning code/queries keep working; the table/relation is ' +
        'generalized not duplicated).\n\n' +
        '**Surface the gateway-captured usage/cost on the run.** The gateway ' +
        'attributes each captured `usage` row + each credit debit to the run ' +
        'via the virtual key (9.0.5/9.0.6); this card ensures the run’s ' +
        '`AgentRun` exposes the resulting per-run token totals + the credit ' +
        'cost (read back from the gateway debit / the ledger transactions ' +
        'referencing the run) so 9.1.8 can show them. The container reports ' +
        'NOTHING about its spend — the surfaced numbers come from the gateway’s ' +
        'authoritative metering, not the sandbox.\n\n' +
        '**Out-of-credits interplay (named, not built here).** The shared ' +
        'balance means a hosted run can hit the 7.12.4 out-of-credits boundary ' +
        'on two edges: 9.1.7’s PROVISION-time pre-flight gate (refuse before ' +
        'provisioning), and the GATEWAY edge — a mid-run call that crosses zero ' +
        'is refused with a `429` at the gateway (9.0.6) before any upstream ' +
        'call. 9.1 debits the existing ledger (through the gateway) — it adds ' +
        'NO checkout/top-up (Epic 8).\n\n' +
        '**Layering (the open-core boundary).** The mint/inject + the ' +
        'usage-surfacing ride a thin gateway-admin client over HTTP; the LEDGER ' +
        '+ the metering stay in motir-ai and the DEBIT is the gateway’s (9.0.6) ' +
        '— motir-core holds no billing table and only DISPLAYS over 7.1. No ' +
        'in-container metering, no self-report endpoint.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-ai/prisma/schema.prisma` generalizes `PlanningRun` → ' +
        '`AgentRun` with a `kind` (planning | coding) discriminator via a ' +
        'NON-breaking migration (existing rows backfill to `planning`; ' +
        'planning code/queries keep working); FK-as-`@relation` preserved.\n' +
        '- At provision the run is wired to the gateway: a per-run gateway ' +
        'VIRTUAL KEY (9.0.4) is minted + injected with the gateway base-URL as ' +
        'the run’s only LLM config, and revoked on teardown — there is NO ' +
        'in-sandbox usage-report endpoint (asserted: no self-report path ' +
        'exists; the container holds no provider key).\n' +
        '- The run’s LLM spend is captured + debited AT THE GATEWAY (9.0.5/' +
        '9.0.6) against the SAME `CreditLedger` planning uses, recorded into ' +
        'this `AgentRun` (kind=coding) — a coding run and a planning run draw ' +
        'down ONE balance.\n' +
        '- The `AgentRun` surfaces the gateway-captured per-run token totals + ' +
        'the credit cost (read back from the gateway debit), so 9.1.8 can show ' +
        'them; a foreign-tenant virtual key cannot attribute spend to another ' +
        'tenant (the gateway enforces it, 9.0.4).\n' +
        '- The 7.12.5 usage display + the monthly aggregation include the ' +
        'coding `AgentRun` with no new store (asserted: a coding run appears in ' +
        'the per-run log + the per-model month totals).\n' +
        '- Open-core boundary respected: the mint/inject + usage read cross to ' +
        'the gateway/motir-ai over HTTP; the ledger/metering stay in motir-ai ' +
        '(no billing table in motir-core); no checkout/top-up introduced (Epic ' +
        '8).\n\n' +
        '## Context refs\n\n' +
        '- 9.0.4 — the per-run gateway VIRTUAL KEY this mints + injects (the ' +
        'run’s only LLM credential).\n' +
        '- 9.0.5 — the authoritative provider-`usage` the gateway captures ' +
        '(the meter this run’s cost is surfaced from).\n' +
        '- 9.0.6 — the credit debit the gateway OWNS (tokens × per-model rate × ' +
        'margin → 7.12’s `CreditLedger`); the gateway 429 the shared balance ' +
        'can trigger.\n' +
        '- 7.12.2 — the metering store (`PlanningRun`/`PlanningTurn`) this ' +
        'GENERALIZES to `AgentRun` (kind), the home the gateway spend records ' +
        'into.\n' +
        '- 7.12.4 / 7.12.5 — the out-of-credits boundary (the provision gate is ' +
        '9.1.7) + the usage display the generalized `AgentRun` surfaces in.\n' +
        '- 9.1.4 / 9.1.7 — the image whose `*_BASE_URL` point at the gateway + ' +
        'the orchestration that requests the mint + injects the key.\n' +
        '- `motir-core/CLAUDE.md` § FK-as-`@relation`.',
      dependsOn: ['9.1.4', '9.0.4', '9.0.5'],
    },
    {
      id: '9.1.7',
      title:
        'The hosted-run ORCHESTRATION — provision a container-per-run from a 7.6 dispatch, inject prompt + run-scoped auth, stream status/logs, enforce lifecycle, surface the PR',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 75,
      descriptionMd:
        'The server-side engine that turns a 7.6 dispatch into a running ' +
        'hosted container and drives its lifecycle to a PR — the orchestration ' +
        'tying 9.1.4 (the image) + 9.1.5 (auth) + 9.1.6 (usage) together, ' +
        'consumed by the 9.1.8 UI.\n\n' +
        '**Entry: a 7.6 dispatch-target variant.** A hosted run starts from a ' +
        'READY item’s 7.6.3 dispatch payload — the SAME contract the BYOK path ' +
        'uses, with the dispatch TARGET set to “hosted” (and the selected ' +
        'agent as a parameter). So 7.6’s prompt generation produces the prompt ' +
        'the harness runs; 9.1 adds the hosted EXECUTION target the 7.6.3 ' +
        'prose reserved a seam for. The item flips to in_progress on dispatch ' +
        '(the existing transition).\n\n' +
        '**Pre-flight credit gate (the shared-balance boundary).** Before ' +
        'provisioning (and before any token spend), check the tenant’s 7.12 ' +
        '`CreditLedger` balance via the 7.12.4 `creditService`. ≤ 0 → REFUSE ' +
        'the run with the typed out-of-credits error (the 9.1.1 out-of-credits ' +
        'state renders it; NO buy control — Epic 8), no container provisioned, ' +
        'no tokens spent.\n\n' +
        '**Provision → run → PR → teardown (the 9.1.2 lifecycle).** ' +
        '(1) PROVISION a fresh container-per-run on the 9.1.3 orchestrator ' +
        'from the 9.1.4 hosted image; (2) INJECT the run spec (repo + ref, the ' +
        '7.6 prompt, the selected agent) + the 9.1.5 run-scoped token (for ' +
        'git/PR + the Motir API) + the per-run 9.0 gateway VIRTUAL KEY + ' +
        'gateway base-URL (the run’s only LLM config — the mint/inject 9.1.6 ' +
        'wires); (3) STREAM the container’s structured status/log ' +
        'events (the lifecycle stepper + the console the 9.1.8 UI shows) — ' +
        'persisted to the `AgentRun` + streamed (SSE, the 7.1.4 stream shape); ' +
        '(4) on success SURFACE the PR (the harness opened it as the user — ' +
        'record the PR link on the run + move the item to its review state); ' +
        '(5) ENFORCE the lifecycle — a per-run TIMEOUT cancels + tears down a ' +
        'overrunning run, and teardown is GUARANTEED on every terminal path ' +
        '(success / failure / cancel / timeout / crash) so no container ' +
        'leaks. A user CANCEL tears the run down and leaves the item ' +
        'in_progress (named).\n\n' +
        '**One container per run, sequential (the 9.1 baseline).** Parallel / ' +
        'multi-agent hosted runs are a deferred Epic-9 story — 9.1 provisions ' +
        'ONE container per run. (The run record + the orchestrator interface ' +
        'are shaped so a future concurrency story adds a queue WITHOUT ' +
        'reshaping this — durable shape, not a parallel-capable shortcut now.)' +
        '\n\n' +
        '**4-layer (motir-core) + the boundary.** The dispatch route calls a ' +
        '`hostedRunService` that provisions via the orchestrator client + mints ' +
        'the run token (9.1.5) + records the run; the usage debit happens in ' +
        'motir-ai (9.1.6) — motir-core never holds the ledger. Browsers hit a ' +
        'motir-core route (status/logs/cancel); they never call the container ' +
        'or motir-ai directly.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A hosted run is dispatched from a ready item via the 7.6.3 ' +
        'payload (target=hosted, agent as a parameter); the item flips to ' +
        'in_progress.\n' +
        '- The pre-flight gate REFUSES a run for a balance-≤-0 tenant before ' +
        'provisioning (no container, no token spend) with the typed out-of-' +
        'credits error; a positive-balance tenant provisions normally.\n' +
        '- Provision injects the run spec + the 9.1.5 run-scoped token (the ' +
        'ONLY credential); status/log events stream to the client (SSE) + ' +
        'persist on the `AgentRun`; on success the PR link is recorded + the ' +
        'item moves to its review state.\n' +
        '- The lifecycle is enforced: a per-run TIMEOUT cancels + tears down; ' +
        'teardown is guaranteed on success/failure/cancel/timeout/crash (no ' +
        'leaked container — asserted with a fixture run that overruns); a user ' +
        'cancel tears down + leaves the item in_progress.\n' +
        '- ONE container per run (sequential baseline); 4-layer respected ' +
        '(route → `hostedRunService` → orchestrator client; no Prisma in the ' +
        'route); browsers never reach the container or motir-ai.\n\n' +
        '## Context refs\n\n' +
        '- 7.6.3 — the dispatch payload contract a hosted run is a TARGET ' +
        'variant of (the native-AI-coding executor seam).\n' +
        '- 9.1.4 (the image provisioned) / 9.1.5 (the run-scoped token ' +
        'injected) / 9.1.6 (the gateway virtual-key mint/inject + the ' +
        'gateway-metered usage the run produces).\n' +
        '- 9.1.2 — the orchestration + lifecycle decision this implements; ' +
        '9.1.3 — the orchestrator/registry/secrets it runs on.\n' +
        '- 7.1.4 — the SSE stream shape the status/log streaming mirrors; ' +
        '7.12.4 — the `creditService` the pre-flight gate calls.\n' +
        '- `motir-core/lib/ai/motirAiClient.ts` (7.1.5) — the leaf client the ' +
        'service reads/debits motir-ai over.',
      dependsOn: ['9.1.4', '9.1.5', '7.6.3'],
    },
    {
      id: '9.1.8',
      title:
        'The hosted-run UI — kick off a hosted run (vs BYOK), live status/logs, per-run token-usage + credit-cost, the PR link',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'The motir-core UI that renders the 9.1.1 design: kick off a hosted ' +
        'run from a ready item, watch it live, and land on the PR + the cost. ' +
        'Renders the 9.1.1 five panels verbatim; reads the 9.1.7 orchestration ' +
        '+ the 9.1.6 usage over the existing routes/boundary. **No checkout / ' +
        'pricing UI — Epic 8.**\n\n' +
        '**Kick-off (the dispatch-target choice).** On a ready item’s dispatch ' +
        'affordance (the 7.6.4 dispatch surface), add the **Run hosted** ' +
        'choice alongside the existing BYOK path (copy prompt / `motir auto`), ' +
        'with the agent selector (the 7.9.7 matrix — a parameter; the auto-pick ' +
        'POLICY is a deferred Epic-9 story) and the “spends credits” ' +
        'affordance. Kicking off calls the 9.1.7 dispatch route.\n\n' +
        '**Live run view.** The lifecycle stepper (`provisioning → cloning → ' +
        'running → opening PR → done`) + the streamed LOG console (subscribing ' +
        'to the 9.1.7 SSE status/log stream), an `aria-live` region for the ' +
        'state transitions, and a CANCEL control (the 9.1.7 teardown). The log ' +
        'is virtualized/tailed (the at-scale rule — never render every line). ' +
        '**Run-complete:** the PR link as the hero, the per-run token usage ' +
        '(model, in/out, steps) + the CREDIT cost debited (read from the 9.1.6 ' +
        '`AgentRun`), and the item’s review state.\n\n' +
        '**Run history + states.** A paginated hosted-run list (item, agent, ' +
        'status, duration, tokens, credits, PR — at-scale, lazy/paged), the ' +
        'FAILED state (log tail + re-run), the OUT-OF-CREDITS state (the ' +
        'passive Epic-8 placeholder — a `--el-warning` banner, NO active buy ' +
        'control, per 9.1.1 / 7.12.1), and the empty/loading/error states (incl. ' +
        'the motir-ai/orchestrator-unreachable state — a clear retry, not a ' +
        'misleading zero).\n\n' +
        '**4-layer + tokens.** Routes parse + call ONE service method ' +
        '(`hostedRunService` for dispatch/status/cancel; the usage read rides ' +
        '7.12.5’s usage service / the 7.1.5 client); session-gated (401) + ' +
        'tenant-scoped (404-not-403 cross-tenant). References ONLY `--el-*` ' +
        'colour + `[data-display-style]` shape tokens; uses the palette ' +
        '(per-status `Pill` tones, the `--el-warning` out-of-credits banner — ' +
        'not grey-only, finding #54); i18n via a new `hostedRun` namespace (the ' +
        'app’s locale set).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A ready item offers **Run hosted** vs the BYOK path + the agent ' +
        'selector; kicking off dispatches via 9.1.7 and the item flips to ' +
        'in_progress.\n' +
        '- The live view streams the lifecycle stepper + the log console ' +
        '(virtualized/tailed, at-scale) with an `aria-live` region + a working ' +
        'cancel; the complete state shows the PR link + the per-run tokens + ' +
        'the credit cost (from the 9.1.6 `AgentRun`).\n' +
        '- The run history is paginated/lazy; the failed + out-of-credits ' +
        'states render (out-of-credits with NO active buy/upgrade control — ' +
        'Epic-8 placeholder); the orchestrator/motir-ai-unreachable state shows ' +
        'a retry, not a zero.\n' +
        '- Renders the 9.1.1 design with `--el-*` tokens only (no Tier-0 ' +
        '`--color-*`, no hand-rolled spacing); the palette is used (per-status ' +
        'tones, the warning banner).\n' +
        '- 4-layer respected (route → service → 7.1.5/orchestrator client; no ' +
        'Prisma in routes; no client component touches a service directly); ' +
        'session-gated + tenant-scoped; no checkout/pricing surface anywhere ' +
        '(Epic 8).\n\n' +
        '## Context refs\n\n' +
        '- 9.1.1 — the design asset (the five panels this implements ' +
        'verbatim).\n' +
        '- 9.1.6 — the `AgentRun` usage/credit-cost the complete state reads; ' +
        '9.1.7 — the dispatch/status/log/cancel orchestration the UI drives.\n' +
        '- 7.6.4 — the dispatch surface this adds the hosted-target choice ' +
        'to.\n' +
        '- 7.12.5 — the usage display the per-run cost is consistent with (the ' +
        'generalized `AgentRun`); `motir-core/lib/ai/motirAiClient.ts` (7.1.5) ' +
        '— the read-through client.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § colour/shape tokens; ' +
        '`motir-core/app/globals.css` — the `--el-*` + shape tokens.',
      dependsOn: ['9.1.1', '9.1.6', '9.1.7'],
    },
    {
      id: '9.1.9',
      title:
        'Vitest — run harness + gateway wiring (virtual-key mint/inject → gateway-metered usage surfaced) + run-scoped auth + lifecycle',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'Lock the hosted-execution foundation with tests on both sides. ' +
        'motir-core tests run over a real Postgres (the project convention; ' +
        'the only allowed `vi.mock` is `getSession()`); the motir-ai tests run ' +
        'over its own real Postgres (7.1.3) with the agent/LLM boundary stubbed ' +
        '(a FAKE agent + recorded usage figures — no real LLM, no real ' +
        'container provisioning in CI) — but the metering rows, the credit ' +
        'debit, the run-scoped auth, and the lifecycle are exercised for ' +
        'real.\n\n' +
        '**The run harness (9.1.4):**\n\n' +
        '- Given a run spec + a fake agent (edits a file, exits 0) over a ' +
        'fixture repo, the harness clones, runs the ' +
        'agent, and opens a PR (asserted against a fixture git remote / a ' +
        'stub PR surface); a non-zero fake agent yields a reported failure + ' +
        'NO PR.\n' +
        '- The image carries NO provider keys; the fake agent’s model call ' +
        'resolves to the injected gateway base-URL (asserted: it hits the stub ' +
        'gateway, not a provider host) — the container does NO usage ' +
        'self-report.\n\n' +
        '**Gateway wiring → metering surfaced (9.1.6):**\n\n' +
        '- At provision a per-run gateway VIRTUAL KEY (9.0.4) is minted + ' +
        'injected with the gateway base-URL as the run’s only LLM config and ' +
        'revoked on teardown (asserted against a stub gateway-admin client); ' +
        'there is NO in-sandbox usage-report endpoint.\n' +
        '- The gateway-captured usage (stubbed with recorded `usage` figures, ' +
        '9.0.5) debits the SAME `CreditLedger` planning uses (9.0.6) recorded ' +
        'into the `AgentRun` (kind=coding) — the balance drops by exactly ' +
        '`(tokens/1k × rate) × margin` for the run’s model.\n' +
        '- The `PlanningRun` → `AgentRun` generalization is non-breaking: an ' +
        'existing planning row reads back as kind=planning and a planning + a ' +
        'coding run draw down ONE balance (asserted: the balance after both = ' +
        'start − planningDebit − codingDebit).\n' +
        '- The `AgentRun` surfaces the gateway-captured per-run token totals + ' +
        'credit cost (asserted: read back from the gateway debit, not from a ' +
        'container report); a foreign-tenant virtual key cannot attribute ' +
        'spend to another tenant.\n\n' +
        '**Run-scoped auth (9.1.5):**\n\n' +
        '- A minted run-scoped token authenticates git/PR + the Motir API ' +
        'read AS the dispatching user; an EXPIRED (post-TTL ' +
        '/ post-teardown) token is rejected (401); a run-A/tenant-A token ' +
        'cannot act on run B / tenant B (rejected; 404-not-403 cross-tenant); ' +
        'NO long-lived credential (and no provider key) is present in the run ' +
        'spec.\n\n' +
        '**Lifecycle (9.1.7):**\n\n' +
        '- A run that overruns is cancelled by the per-run TIMEOUT and torn ' +
        'down; teardown is invoked on every terminal path ' +
        '(success/failure/cancel/timeout) — asserted no run is left ' +
        '“provisioned” after a terminal state; the pre-flight credit gate ' +
        'refuses a balance-≤-0 tenant BEFORE provisioning (no container, no ' +
        'token spend).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The above cases pass on both sides; motir-core over real Postgres ' +
        '(only `getSession()` mocked), motir-ai over its real Postgres with ' +
        'only the agent/LLM + container-provision boundary stubbed (a fake ' +
        'agent, no real LLM/container in CI).\n' +
        '- The credit debit is asserted against a fixture (the per-model rate ' +
        'lookup + the rounding boundary, REUSING 7.12.6’s conversion fixtures ' +
        'where sensible), and the planning-+-coding ONE-balance reuse is ' +
        'proven; the out-of-credits pre-flight makes NO provision + NO token ' +
        'spend.\n' +
        '- New motir-core service code respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage); the gateway-wiring + the ' +
        'run-scoped-auth verify branches are directly covered (the expired / ' +
        'foreign-tenant / revoked-key guards each have a test).\n\n' +
        '## Context refs\n\n' +
        '- 9.1.4 / 9.1.5 / 9.1.6 / 9.1.7 (everything under test).\n' +
        '- 7.12.6 — the metering/ledger test patterns + conversion fixtures ' +
        'this composes with (the SAME debit math, now for a coding run).\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + § coverage ' +
        'gate; `tests/helpers/db.ts`, `vitest.config.ts` — the harness + the ' +
        'gate list.\n' +
        '- 7.1.3 — the motir-ai test DB the metering/ledger/run tests run ' +
        'over.',
      dependsOn: ['9.1.6', '9.1.7'],
    },
  ],
};
