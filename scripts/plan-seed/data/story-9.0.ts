import type { SeedStory } from '../types';

/**
 * Story 9.0 — LLM metering gateway (fork of one-api). THE FOUNDATION of **Epic 9
 * (Native AI coding)** — numbered 9.0 so it sorts BEFORE 9.1 (backward deps):
 * a standalone, self-hostable LLM aggregator/gateway, its OWN module/service,
 * that every hosted coding run (9.1) routes its LLM calls THROUGH so Motir
 * meters authoritatively and debits credits. 9.1's container does NOT call
 * Anthropic/OpenAI/Moonshot directly — its egress is LOCKED to this gateway, the
 * gateway injects Motir's managed provider keys, and it bills on the PROVIDER's
 * own `usage` field. (Later the gateway can ALSO carry planning traffic — 7.2's
 * Anthropic SDK calls — for one unified meter; that is noted as a FUTURE
 * unification, NOT built here.)
 *
 * **CONFIRMED DECISION (Yue, 2026-06-12): fork `songquanpeng/one-api`.** A
 * self-hosted, OpenAI/Anthropic-compatible LLM aggregator (Go, MIT, ~34.8k★)
 * whose built-in primitives map almost 1:1 onto 7.12's credit machinery:
 *   - **Channels** — per-provider upstreams (OpenAI / Azure / Anthropic Claude /
 *     Google Gemini / DeepSeek / Moonshot / … ) under one unified API; this is
 *     where Motir's MANAGED provider keys live (web-verified: one-api is exactly
 *     a "LLM API management & key redistribution system, unifying multiple
 *     providers under a single API; single binary, Docker-ready").
 *   - **Tokens** — per-key access credentials with an expiry + a usage/quota cap
 *     → the natural home for 9.0.4's short-lived per-run VIRTUAL KEY.
 *   - **Per-user quota + per-model pricing/billing** — one-api debits a quota as
 *     `Group multiplier × Model multiplier × (prompt tokens + completion tokens ×
 *     completion multiplier)` (web-verified from its `channel-billing` logic).
 *     That per-model multiplier IS where Motir's resale MARGIN lives, and the
 *     per-user quota maps onto 7.12's `CreditLedger`. So forking one-api means
 *     reusing a battle-tested channels→tokens→quota→per-model-pricing spine
 *     rather than building an LLM proxy from scratch.
 *
 * **License gate (RECORDED — the load-bearing reason it is one-api and NOT the
 * richer alternative).** Motir's gateway lives in the COMMERCIAL CLOSED layer
 * (it is operated as Motir's hosted SaaS), so the fork's license must permit
 * closed-source network use:
 *   - `songquanpeng/one-api` is **MIT** (web-verified: "MIT License Copyright (c)
 *     2023 JustSong") — safe to fork into the closed commercial layer.
 *   - `QuantumNous/new-api` (a more billing-rich one-api fork) is **AGPL-3.0**
 *     (web-verified: dual-licensed, default AGPLv3 — "if you provide a modified
 *     version as a network service (SaaS) you must release the complete
 *     corresponding source under AGPLv3"). Its §13 network-copyleft would force
 *     Motir to open-source the closed gateway, so new-api is **REJECTED** for the
 *     commercial layer despite its richer billing.
 *   - **LiteLLM** (Python, MIT-core proxy) is the considered FALLBACK if one-api's
 *     Go billing model proves too rigid for the credit integration.
 *   - A **legal-review checkpoint** is recorded (9.0.1) so the MIT-fork posture +
 *     the new-api-AGPL rejection are signed off, not assumed.
 *
 * **WHY a gateway and not container self-report (the best-practice metering
 * architecture this story bakes in).** The meter must sit OUTSIDE the BILLED
 * sandbox's trust boundary — a 9.1 run executes an autonomous agent editing code,
 * so anything that container self-reports about its own token spend is
 * untrustworthy (it is the thing being billed). So the authoritative shape is:
 *   1. **Egress lock.** The hosted sandbox's LLM egress is LOCKED to the gateway
 *      (network policy + an injected `*_BASE_URL` / `ANTHROPIC_BASE_URL` /
 *      `OPENAI_BASE_URL` pointing at the gateway) — the container CANNOT reach a
 *      provider directly (9.0.7).
 *   2. **Managed keys at the gateway.** The container carries NO provider key; the
 *      gateway's channels inject Motir's managed Anthropic/OpenAI/Moonshot keys on
 *      the way out (9.0.2 provisions them, 9.0.3 wires the channels). A run's only
 *      credential is its virtual key (9.0.4).
 *   3. **Bill on the PROVIDER's authoritative `usage`.** The gateway meters on the
 *      token counts the PROVIDER returns, never a tokenizer estimate
 *      (web-verified field facts): Anthropic `usage.input_tokens` /
 *      `usage.output_tokens` + cache (`cache_creation_input_tokens` /
 *      `cache_read_input_tokens`), streaming totals in the final `message_delta`;
 *      OpenAI `usage` (prompt / completion / total), streaming via
 *      `stream_options: { include_usage: true }` → a FINAL chunk that carries
 *      `usage` while every prior chunk's `usage` is null (9.0.5).
 *   4. **Per-run attribution via a short-lived VIRTUAL KEY.** The orchestrator
 *      mints a per-run gateway key so the captured usage attributes to THE RUN —
 *      maps onto one-api's token system (9.0.4).
 *   5. **Resale margin in the gateway's per-model pricing.** The credit a run
 *      burns is `tokens × per-model creditRate × margin` — the margin is the
 *      gateway's per-model multiplier (9.0.6), reusing 7.12's `ModelCreditRate`.
 *   6. **Reconcile against the provider billing API** as an audit backstop (a
 *      finding-style note in 9.0.5/9.0.6, not a separate card here).
 *
 * **No Motir-design-system UI in this story.** The gateway's ADMIN surface is
 * forked one-api's OWN web UI (rebranded/trimmed in 9.0.3 — NOT rebuilt in the
 * Motir design system); the USER-FACING usage/credit display is 9.1.8 / 7.12.5.
 * So 9.0 ships NO `design/` subtask and the design gate does NOT fire — stated
 * explicitly here.
 *
 * **Backward deps only (the Epic-9 audit posture).** Every 9.0 leaf depends only
 * on same-story 9.0.x ids or backward 7.x ids (7.12.3 — the `CreditLedger` /
 * `creditService` / `ModelCreditRate` the gateway's spend syncs into). No dep
 * points above 9.0; none points to 9.1 or an unplanned future Epic-9 story (9.1
 * depends on 9.0, not the reverse — 9.0 is the foundation that ships first).
 * Because 9.0.1 is `dependsOn: []` it is `planned`; everything chained behind it
 * (or behind any not-yet-done 7.x id) is `blocked`.
 */
export const story_9_0: SeedStory = {
  id: '9.0',
  title:
    'LLM metering gateway (fork of one-api) — the authoritative meter every hosted run routes through',
  status: 'planned',
  gitBranch: 'feat/PROD-9.0-llm-metering-gateway',
  descriptionMd:
    'The FOUNDATION of **Epic 9 (Native AI coding)**: a standalone, ' +
    'self-hostable LLM aggregator/gateway — its OWN module/service, a fork of ' +
    '`songquanpeng/one-api` (MIT, Go) — that every hosted coding run (9.1) ' +
    'routes its LLM calls THROUGH so Motir meters AUTHORITATIVELY and debits ' +
    'credits. The hosted sandbox never calls a provider directly: its LLM ' +
    'egress is LOCKED to this gateway, the gateway injects Motir’s managed ' +
    'provider keys, and it bills on the PROVIDER’s own `usage` field — the ' +
    'meter sits OUTSIDE the billed container’s trust boundary (the container is ' +
    'the thing being billed, so it cannot self-report its own spend).\n\n' +
    '**The decision (confirmed — see the module header for the full ' +
    'rationale + the cited license gate):**\n\n' +
    '- **Fork `songquanpeng/one-api` (MIT).** Its built-in ' +
    'channels → tokens → per-user quota → per-model pricing/billing maps almost ' +
    '1:1 onto 7.12’s `CreditLedger` / `ModelCreditRate`: channels hold Motir’s ' +
    'managed provider upstreams (Anthropic / OpenAI / Moonshot / …), tokens are ' +
    'the per-run virtual keys, the per-user quota is the credit balance, and ' +
    'the per-model multiplier is where the resale MARGIN lives.\n' +
    '- **License gate.** one-api is **MIT** (safe to fork into the commercial ' +
    'CLOSED layer). The richer `QuantumNous/new-api` is **AGPL-3.0** and is ' +
    'REJECTED (its §13 network-copyleft would force open-sourcing the closed ' +
    'gateway). **LiteLLM** (Python, MIT-core) is the considered fallback. A ' +
    'legal-review checkpoint is recorded.\n' +
    '- **Authoritative metering.** Bill on the provider’s `usage` (Anthropic ' +
    '`input_tokens`/`output_tokens` + cache; OpenAI `usage`, streaming via ' +
    '`stream_options.include_usage` final chunk) — NEVER a tokenizer estimate; ' +
    'attribute per-run via a short-lived VIRTUAL KEY; the egress lock + managed ' +
    'keys keep the meter outside the sandbox; the resale margin lives in the ' +
    'gateway’s per-model pricing; reconcile against the provider billing API as ' +
    'an audit backstop.\n\n' +
    '**Scope:** the fork/license/metering-architecture decision + the ' +
    'legal-review checkpoint (9.0.1); provisioning the gateway infra + Motir’s ' +
    'managed upstream provider keys + secrets (9.0.2); forking + standing up ' +
    'one-api as the Motir gateway service (9.0.3); the per-run virtual keys ' +
    '(9.0.4); the authoritative provider-`usage` metering, incl. streaming + ' +
    'cache tokens (9.0.5); the credit integration into 7.12’s ledger + the ' +
    'out-of-credits 429 + the resale margin (9.0.6); the egress-lock / proxy ' +
    'enforcement contract (9.0.7); and the integration test (9.0.8).\n\n' +
    '**Out of scope (named so they land in their owning story, not here):** ' +
    'the hosted container / run harness / orchestration that USES the gateway ' +
    '(**Story 9.1** — 9.0 is the meter, 9.1 is the run); the user-facing ' +
    'usage/credit DISPLAY (9.1.8 / 7.12.5 — 9.0’s only admin surface is forked ' +
    'one-api’s OWN UI, rebranded/trimmed, NOT the Motir design system, so 9.0 ' +
    'carries no design subtask); routing the PLANNING traffic (7.2’s Anthropic ' +
    'SDK) through the gateway for one unified meter (a FUTURE unification, ' +
    'noted not built); checkout / pricing / the $-value of a credit (**Epic ' +
    '8** — the gateway debits the existing 7.12 ledger, it never charges a ' +
    'card).',
  verificationRecipeMd:
    '- Pull the Story branch; stand up the Motir gateway service locally (the ' +
    '9.0.3 forked one-api, Docker-ready single binary) with at least one ' +
    'channel pointed at a provider (a real Anthropic/OpenAI key for a live ' +
    'smoke, or a recorded-`usage` stub for CI), and motir-ai up (its own DB, ' +
    '7.1.3) so the credit sync (9.0.6) has a `CreditLedger` to write.\n' +
    '- **The gateway speaks OpenAI/Anthropic-compatible.** Point an ' +
    'OpenAI/Anthropic client at the gateway’s base URL with a minted VIRTUAL ' +
    'KEY (9.0.4) and make a completion → it proxies to the upstream channel ' +
    '(Motir’s managed provider key injected by the gateway, NOT the client’s), ' +
    'and returns a normal response. A request with NO/expired virtual key is ' +
    'refused.\n' +
    '- **Authoritative usage capture (the meter, 9.0.5).** After the call, ' +
    'confirm the gateway recorded the PROVIDER’s `usage` for the request — ' +
    'Anthropic `input_tokens`/`output_tokens` (+ cache tokens if a cached ' +
    'prompt was used), OpenAI `usage` (prompt/completion/total) — attributed to ' +
    'the run via the virtual key, NOT a tokenizer estimate. Repeat with a ' +
    'STREAMED response and confirm the usage is still captured (Anthropic final ' +
    '`message_delta`; OpenAI the `stream_options.include_usage` FINAL chunk).\n' +
    '- **Credit debit (9.0.6).** With a known per-model `creditRate` + margin, ' +
    'confirm the captured usage synced to 7.12’s `CreditLedger` as a ' +
    '`CreditTransaction` debit equal to `tokens × creditRate × margin` (7.12.3’s ' +
    'conversion, unchanged) and the balance dropped by exactly that. The resale ' +
    'margin is the gateway’s per-model multiplier.\n' +
    '- **Out-of-credits → 429.** Drive the tenant’s balance to ≤ 0; a ' +
    'subsequent gateway request for that tenant’s virtual key is REFUSED with a ' +
    '`429` (rate/quota-exhausted) BEFORE any upstream provider call (no tokens ' +
    'spent, the provider key never used). No buy/upgrade is triggered (Epic 8).\n' +
    '- **Egress lock (9.0.7).** Review the contract doc: a 9.1 run reaches ' +
    'providers ONLY via the gateway (network policy + injected `*_BASE_URL`); ' +
    'document how a direct-to-provider bypass is prevented. (9.1 wires the ' +
    'lock; 9.0 ships the enforcement contract + the gateway side.)\n' +
    '- `pnpm test` / the gateway + motir-ai suites — 9.0.8 covers virtual-key ' +
    'attribution + usage capture (incl. a STREAMED response) + credit debit + ' +
    'the out-of-credits 429 (no upstream call).\n' +
    '- **License posture review.** Confirm the fork is the MIT ' +
    '`songquanpeng/one-api` (NOT the AGPL `new-api`), the rebrand/trim keeps the ' +
    'MIT NOTICE/attribution intact, and the legal-review checkpoint (9.0.1) is ' +
    'signed off.\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up Subtask ' +
    'under the same Story.',
  items: [
    {
      id: '9.0.1',
      title:
        'Decision — fork one-api (MIT): the license gate (reject new-api AGPL; LiteLLM fallback) + legal-review checkpoint + the metering architecture',
      status: 'planned',
      type: 'decision',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        '**Type:** decision (the keystone ADR every other 9.0 card — and all ' +
        'of Epic 9’s metering — builds against). Produce a living architecture ' +
        'document; no app behavior ships here, but the shapes it fixes are ' +
        'load-bearing.\n\n' +
        'Write `gateway/docs/metering-gateway.md` (owned by the new gateway ' +
        'module, the closed commercial side; `motir-ai` links it from a short ' +
        'pointer). It MUST fix three things:\n\n' +
        '1. **The fork choice + the LICENSE GATE (the load-bearing reason).** ' +
        'Fork **`songquanpeng/one-api`** — a self-hosted ' +
        'OpenAI/Anthropic-compatible LLM aggregator (Go, ~34.8k★) whose built-in ' +
        '**channels → tokens → per-user quota → per-model pricing/billing** maps ' +
        'almost 1:1 onto 7.12’s `CreditLedger` / `ModelCreditRate` (web-verified: ' +
        'one-api’s quota debits as `Group multiplier × Model multiplier × ' +
        '(prompt tokens + completion tokens × completion multiplier)`; tokens ' +
        'carry an expiry + a usage cap; channels hold per-provider upstream ' +
        'keys). The gateway lives in the COMMERCIAL CLOSED layer (operated as ' +
        'Motir’s hosted SaaS), so the fork’s license must permit closed-source ' +
        'NETWORK use: one-api is **MIT** (web-verified: "MIT License Copyright ' +
        '(c) 2023 JustSong") — safe. The richer `QuantumNous/new-api` is ' +
        '**AGPL-3.0** (web-verified: dual-licensed, default AGPLv3 — a SaaS ' +
        'modification must release its complete source under AGPLv3); its §13 ' +
        'network-copyleft would force open-sourcing the closed gateway, so ' +
        'new-api is **REJECTED** for the commercial layer DESPITE its richer ' +
        'billing. **LiteLLM** (Python, MIT-core proxy) is the considered ' +
        'FALLBACK if one-api’s Go billing model proves too rigid for the credit ' +
        'integration. Record this trade table (fork / license / billing-fit) ' +
        'explicitly. **A LEGAL-REVIEW CHECKPOINT** is part of this card: a ' +
        'human/manual sign-off that the MIT-fork-into-closed-layer posture + the ' +
        'new-api-AGPL rejection + the rebrand’s MIT-NOTICE retention are ' +
        'approved (raise it as a `manual` follow-up if legal sign-off is needed ' +
        'beyond a documented finding — the manual-subtask-for-user-config ' +
        'posture).\n' +
        '2. **WHY a gateway, not container self-report (the metering ' +
        'architecture).** Fix that the meter sits OUTSIDE the BILLED sandbox’s ' +
        'trust boundary: a 9.1 run executes an autonomous agent editing code, so ' +
        'its self-reported token spend is untrustworthy (it is the thing being ' +
        'billed). So: (a) the sandbox’s LLM egress is LOCKED to the gateway ' +
        '(network policy + injected `*_BASE_URL`); (b) the gateway injects ' +
        'Motir’s MANAGED provider keys (the container carries none); (c) billing ' +
        'is on the PROVIDER’s authoritative `usage` field, NEVER a tokenizer ' +
        'estimate; (d) per-run attribution is a short-lived VIRTUAL KEY; (e) the ' +
        'resale MARGIN lives in the gateway’s per-model pricing; (f) reconcile ' +
        'against the provider billing API as an audit backstop. Cite the ' +
        'web-verified provider `usage`-field facts (Anthropic ' +
        '`usage.input_tokens`/`output_tokens` + `cache_creation_input_tokens`/' +
        '`cache_read_input_tokens`, streaming totals in the final ' +
        '`message_delta`; OpenAI `usage`, streaming via ' +
        '`stream_options:{include_usage:true}` → a FINAL chunk carrying `usage`, ' +
        'all prior chunks `usage:null`).\n' +
        '3. **The credit-sync contract + the FUTURE unification (scope ' +
        'boundary).** Fix that the gateway’s per-model pricing reuses 7.12’s ' +
        '`ModelCreditRate` and its spend syncs to 7.12’s `CreditLedger` via ' +
        '`creditService` (9.0.6), so a hosted CODING run draws down the SAME ' +
        'balance planning does (one ledger). Record that routing the PLANNING ' +
        'traffic (7.2’s Anthropic SDK) through the gateway for ONE unified meter ' +
        'is a FUTURE unification — noted, NOT built in 9.0 — and that checkout / ' +
        'the $-value of a credit is Epic 8.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `gateway/docs/metering-gateway.md` exists and fixes all three ' +
        'sections, with the fork/license trade table (one-api MIT chosen; ' +
        'new-api AGPL rejected with the §13 reason; LiteLLM MIT fallback) and ' +
        'the legal-review checkpoint recorded.\n' +
        '- The gateway-not-self-report rationale is stated with the six metering ' +
        'invariants (egress lock, managed keys, authoritative-`usage` billing, ' +
        'virtual-key attribution, per-model-pricing margin, provider-billing ' +
        'reconciliation), each CITING the verified mirror / field facts rather ' +
        'than asserting them.\n' +
        '- The provider `usage`-field facts are documented per provider ' +
        '(Anthropic incl. cache + streaming `message_delta`; OpenAI incl. the ' +
        '`include_usage` final chunk) as the bill-on-`usage` source.\n' +
        '- The credit-sync contract (gateway pricing reuses `ModelCreditRate`; ' +
        'spend syncs to `CreditLedger`) + the FUTURE planning-traffic ' +
        'unification + the Epic-8 checkout boundary are written down as scope ' +
        'lines, not forgotten gaps.\n' +
        '- `motir-ai` carries a short pointer doc to it; the env/infra inputs ' +
        '9.0.2 must provision (the gateway host, the managed provider keys, the ' +
        'gateway↔motir-ai sync secret) are named as the explicit input to ' +
        '9.0.2.\n\n' +
        '## Context refs\n\n' +
        '- This module header (the locked decision + the cited license gate + ' +
        'the metering architecture).\n' +
        '- `songquanpeng/one-api` (MIT) — the fork target (its README + ' +
        '`controller/channel-billing.go` quota model: channels / tokens / ' +
        'per-user quota / per-model multiplier).\n' +
        '- `QuantumNous/new-api` (AGPL-3.0) — the rejected richer fork (the ' +
        'license-gate reason).\n' +
        '- 7.12.3 — the `CreditLedger` / `creditService` / `ModelCreditRate` the ' +
        'gateway’s spend syncs into (the per-model rate + margin this reuses).\n' +
        '- Story 9.1 (stub) — the hosted run that meters THROUGH this gateway ' +
        '(9.0 is the meter, 9.1 is the run).\n' +
        '- Anthropic Messages API `usage` + prompt-caching docs; OpenAI Chat ' +
        'Completions streaming `stream_options.include_usage` (web-verified ' +
        '2026-06-12) — the bill-on-provider-`usage` field facts.',
      dependsOn: [],
    },
    {
      id: '9.0.2',
      title:
        'Provision the gateway service infra + Motir’s managed upstream provider keys (Anthropic/OpenAI/Moonshot/…) + secrets (manual)',
      status: 'blocked',
      type: 'manual',
      executor: 'human',
      estimateMinutes: 35,
      descriptionMd:
        '**Type:** manual/human (no PR — infra / dashboard / secret work, ' +
        'mirror 1.6.7; marked done on Yue’s confirmation). A coding agent ' +
        'cannot stand up a gateway host, create commercial provider accounts, or ' +
        'mint production provider keys. Wired here via `dependsOn` so the ' +
        'prerequisite is visible at PLAN time (the manual-subtask-for-user-' +
        'config posture), not discovered at run time.\n\n' +
        'Using the env/infra inventory fixed by 9.0.1:\n\n' +
        '1. **The gateway service host.** Provision where the forked one-api ' +
        'gateway runs (its single-binary / Docker deploy + its own datastore — ' +
        'one-api keeps channels/tokens/quota in its own DB), separate from the ' +
        'motir-core / motir-ai web tiers and reachable by the 9.1 run sandboxes ' +
        '(the sandboxes’ egress targets it). Sized for the sequential ' +
        'one-container-per-run baseline.\n' +
        '2. **Motir’s MANAGED upstream provider keys.** Create the commercial ' +
        'Motir-owned accounts + API keys for the supported providers — Anthropic, ' +
        'OpenAI, Moonshot (Kimi), and any others the 7.9.7 agent matrix needs — ' +
        'and load them into the gateway’s CHANNELS (one channel per upstream). ' +
        'These are the keys the gateway INJECTS on egress; the run containers ' +
        'NEVER hold them. Keep them in the gateway’s secret store, not in any ' +
        'image.\n' +
        '3. **The gateway↔motir-ai sync secret + the gateway admin credential.** ' +
        'Mint the shared secret the gateway uses to sync spend into motir-ai’s ' +
        '`CreditLedger` (9.0.6) and the admin login for the forked one-api UI ' +
        '(9.0.3). Wire the env keys 9.0.1 named on each side.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A gateway service host exists (the forked one-api deployable), ' +
        'separate from the web tiers, reachable by run sandboxes, with its own ' +
        'datastore provisioned.\n' +
        '- Motir’s managed provider keys (Anthropic / OpenAI / Moonshot / …) ' +
        'exist and are loaded into the gateway’s channels (one per upstream); ' +
        'they live only in the gateway’s secret store.\n' +
        '- The gateway↔motir-ai sync secret + the gateway admin credential are ' +
        'set, and all infra env keys from 9.0.1’s inventory are present in each ' +
        'environment.\n' +
        '- Yue confirms; Motir marks the subtask done (no PR).\n\n' +
        '## Context refs\n\n' +
        '- 9.0.1’s env/infra inventory + the channel/managed-keys decision.\n' +
        '- 7.1.2 / 9.1.3 (the motir-ai + hosted-run provisioning manual cards) — ' +
        'the precedent shape for provisioning + secret wiring.\n' +
        '- `songquanpeng/one-api` — the channels (upstream keys) + the ' +
        'single-binary/Docker deploy this provisions.',
      dependsOn: ['9.0.1'],
    },
    {
      id: '9.0.3',
      title:
        'Fork + stand up one-api as the Motir gateway service — the OpenAI/Anthropic-compatible endpoints + upstream provider channels; rebrand/trim',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 80,
      descriptionMd:
        'Fork `songquanpeng/one-api` (MIT) into a SEPARATE Motir gateway ' +
        'module/repo (its OWN service — `gateway/` / `motir-gateway`, the ' +
        'open-core boundary: it is neither motir-core nor motir-ai, it is the ' +
        'closed metering proxy) and stand it up as the Motir LLM gateway. This ' +
        'card brings up the SERVICE + its compatible endpoints + its provider ' +
        'channels; the per-run virtual keys (9.0.4), the metering capture ' +
        '(9.0.5), and the credit sync (9.0.6) build on it.\n\n' +
        '**Fork + license hygiene.** Fork from the MIT `songquanpeng/one-api` ' +
        '(NOT the AGPL `new-api`, per 9.0.1). RETAIN the MIT LICENSE / NOTICE / ' +
        'attribution in the fork (MIT requires the copyright + permission ' +
        'notice survive). Pin the upstream commit/tag behind the fork so ' +
        'security updates can be rebased.\n\n' +
        '**The compatible endpoints + channels (the gateway core, reused not ' +
        'rebuilt).** one-api already exposes OpenAI- and Anthropic-compatible ' +
        'endpoints over a unified API and routes them to CHANNELS (per-provider ' +
        'upstreams). Configure the channels for Motir’s managed providers ' +
        '(Anthropic / OpenAI / Moonshot / …, the keys from 9.0.2) so a request ' +
        'with a valid gateway token is proxied to the right upstream with ' +
        'Motir’s managed key injected (the client’s key is never used). Verify ' +
        'the compatible surface a coding agent CLI expects (an ' +
        '`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` pointed at the gateway behaves ' +
        'as the provider) — this is what the 9.0.7 egress lock relies on.\n\n' +
        '**Rebrand / trim to the needed surface.** Trim one-api’s broad ' +
        'feature set (it ships many provider integrations + a full reseller UI) ' +
        'to the surface Motir needs: the channels for Motir’s providers, the ' +
        'token/quota system (for 9.0.4/9.0.6), and the admin UI — rebranded to ' +
        'Motir, NOT rebuilt in the Motir design system (the admin surface is ' +
        'one-api’s OWN forked UI; the user-facing display is 9.1.8 / 7.12.5). ' +
        'Disable/strip the public self-signup / reseller flows that don’t fit a ' +
        'single-operator internal gateway. Keep it self-hostable (the ' +
        'single-binary / Docker deploy 9.0.2 provisions).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A separate Motir gateway module/repo exists, forked from the MIT ' +
        '`songquanpeng/one-api` with the MIT LICENSE/NOTICE retained and the ' +
        'upstream commit pinned for rebasing.\n' +
        '- The gateway runs (single-binary / Docker, per 9.0.2) and exposes the ' +
        'OpenAI/Anthropic-compatible endpoints; a request with a valid gateway ' +
        'token proxies to the configured upstream channel with Motir’s MANAGED ' +
        'provider key injected (the caller supplies no provider key).\n' +
        '- Channels are configured for Motir’s managed providers (Anthropic / ' +
        'OpenAI / Moonshot / …); pointing an agent CLI at the gateway via ' +
        '`*_BASE_URL` works as the provider (the 9.0.7 lock relies on this).\n' +
        '- The surface is rebranded to Motir + trimmed (public self-signup / ' +
        'reseller flows stripped) but NOT rebuilt in the Motir design system; no ' +
        'Motir `design/` asset is introduced (the admin UI is the forked one).\n' +
        '- The gateway is the open-core CLOSED metering proxy — it is its own ' +
        'service, neither motir-core nor motir-ai imports it; they reach it over ' +
        'HTTP only.\n\n' +
        '## Context refs\n\n' +
        '- 9.0.1 — the fork/license decision (MIT one-api; the retained NOTICE; ' +
        'the trim-not-rebuild posture).\n' +
        '- 9.0.2 — the gateway host + the managed provider keys this loads into ' +
        'channels.\n' +
        '- `songquanpeng/one-api` — the fork source (channels / unified ' +
        'compatible endpoints / token+quota system / admin UI).\n' +
        '- Story 9.1 (stub) — the run sandbox whose egress this gateway ' +
        'terminates (9.0.7 locks it here).',
      dependsOn: ['9.0.1'],
    },
    {
      id: '9.0.4',
      title:
        'Per-run VIRTUAL KEYS — mint a short-lived gateway key per run/session so usage attributes to the run (maps to one-api’s token system)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'Make every hosted run’s LLM traffic ATTRIBUTABLE by minting a ' +
        'short-lived, run-scoped VIRTUAL KEY at the gateway — the per-run ' +
        'gateway credential a 9.1 run’s container presents on its LLM calls, so ' +
        'the captured usage (9.0.5) attributes to THE RUN (and thence the ' +
        'tenant). This is the gateway-side analog of 9.1.5’s run-scoped Motir ' +
        'token — distinct from it: 9.1.5 authenticates the run to MOTIR; this ' +
        'virtual key authenticates the run to the GATEWAY for LLM egress.\n\n' +
        '**Maps onto one-api’s token system.** one-api already models per-key ' +
        'TOKENS with an expiry + a usage/quota cap + a group; this card drives ' +
        'that programmatically: an orchestrator-requested mint API ' +
        '(`POST /gateway/virtual-keys` — gateway-admin-credential auth, the ' +
        '9.0.2 secret) creates a one-api token scoped to the run, carrying the ' +
        'tenant/run id (so 9.0.5’s usage rows + 9.0.6’s debit bind to the right ' +
        'tenant), with a TTL bounded by the run’s lifecycle timeout and a quota ' +
        'cap derived from the tenant’s remaining credits. The orchestrator ' +
        '(9.1.7) requests the mint at provision time and injects the virtual key ' +
        'into the container as the ONLY LLM credential (alongside the ' +
        'gateway base URL).\n\n' +
        '**Short-lived + revocable.** The virtual key EXPIRES with the run ' +
        '(post-TTL / post-teardown it is dead — a replayed key is rejected) and ' +
        'is REVOKED on teardown so a finished run cannot spend. One key per run ' +
        '(or per session, per the 9.0.1 decision); it cannot act for another ' +
        'tenant. No long-lived provider key ever leaves the gateway — the ' +
        'virtual key is a gateway credential, not a provider key.\n\n' +
        '**Layering.** A thin gateway-client module (in the gateway service, or ' +
        'a motir-side admin client over HTTP — fix per 9.0.1) owns ' +
        'mint/revoke; the orchestrator requests it, never inlines one-api admin ' +
        'calls. Keep the open-core boundary: the orchestrator reaches the ' +
        'gateway over HTTP, never imports it.\n\n' +
        '## Acceptance criteria\n\n' +
        '- An orchestrator-requested mint creates a run-scoped gateway virtual ' +
        'key (a one-api token) carrying the tenant/run id, a TTL ≤ the run ' +
        'lifecycle timeout, and a quota cap from the tenant’s remaining ' +
        'credits.\n' +
        '- A request to the gateway with a valid virtual key is proxied + ' +
        'attributed to its run/tenant; a request with no / an expired / a ' +
        'revoked key is refused (401/403), and a key for tenant A cannot spend ' +
        'as tenant B.\n' +
        '- The key is revoked on teardown and dead post-TTL (a replayed key from ' +
        'a finished run is rejected).\n' +
        '- The virtual key is the ONLY LLM credential the container holds; no ' +
        'managed provider key leaves the gateway.\n' +
        '- Open-core boundary respected: the orchestrator reaches the gateway ' +
        'over HTTP (mint/revoke) and never imports it.\n\n' +
        '## Context refs\n\n' +
        '- 9.0.3 — the standing gateway + its token/quota system this drives.\n' +
        '- 9.0.1 — the virtual-key-attribution decision (per-run vs per-session; ' +
        'the gateway-admin mint auth).\n' +
        '- 9.1.5 (stub) — the run-scoped MOTIR token this is the gateway-side ' +
        'analog of (distinct credential: Motir-auth vs gateway-LLM-egress); ' +
        '9.1.7 — the orchestration that requests the mint + injects the key.\n' +
        '- 7.12.3 — the `CreditLedger` whose remaining balance bounds the ' +
        'virtual key’s quota cap.',
      dependsOn: ['9.0.3'],
    },
    {
      id: '9.0.5',
      title:
        'METERING — capture the authoritative provider `usage` per request (incl. streaming final-chunk + cache tokens), attributed by virtual key → run',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'Make the gateway the AUTHORITATIVE meter: for every proxied request, ' +
        'capture the token usage the PROVIDER returns (never a tokenizer ' +
        'estimate), attributed by the virtual key (9.0.4) to its run/tenant. ' +
        'This is the metering source of truth the credit debit (9.0.6) is a pure ' +
        'function over — the same posture 7.12.2 takes for planning, now at the ' +
        'gateway for coding.\n\n' +
        '**Bill on the provider’s `usage` field (web-verified — the ' +
        'load-bearing facts).** The gateway reads usage from the UPSTREAM ' +
        'response, per provider:\n' +
        '- **Anthropic** — `usage.input_tokens` + `usage.output_tokens`, plus ' +
        'the cache fields `cache_creation_input_tokens` + ' +
        '`cache_read_input_tokens` (cache writes/reads are billed differently, ' +
        'so they MUST be captured, not folded into plain input). For a STREAMED ' +
        'response the final totals arrive in the terminal `message_delta` ' +
        'event — capture there, not from a mid-stream estimate.\n' +
        '- **OpenAI** — `usage` (prompt / completion / total tokens). For a ' +
        'STREAMED response, usage is null on every chunk UNLESS ' +
        '`stream_options: { include_usage: true }` is set, in which case a FINAL ' +
        'chunk (after the content, `choices: []`) carries the `usage` — the ' +
        'gateway MUST request include_usage on streamed upstream calls and read ' +
        'the final chunk (if the stream is interrupted the final usage chunk may ' +
        'not arrive — record the partial + flag it for the 9.0.6 ' +
        'reconciliation).\n' +
        'one-api already parses upstream `usage` for its own quota debit ' +
        '(`controller/channel-billing.go`); this card ensures the captured shape ' +
        'is the FULL provider usage (incl. cache + streaming) and is recorded ' +
        'against the run, not just decremented from a quota.\n\n' +
        '**Attribute by virtual key → run.** Each captured usage row carries the ' +
        'virtual key’s run/tenant (9.0.4) + the model + input/output (+ cache) ' +
        'tokens + the timestamp, so 9.0.6 debits the right `CreditLedger` and ' +
        '7.12.5 / 9.1.8 can show per-run spend. Capture per REQUEST (a run makes ' +
        'many model calls — many usage rows per run, the per-turn shape 7.12.2 ' +
        'uses).\n\n' +
        '**Provider-billing reconciliation (the audit backstop — noted).** The ' +
        'gateway’s captured usage is the BILL basis, but the gateway also ' +
        'records enough (channel + upstream request id where available) to ' +
        'reconcile against the provider’s billing API as an audit backstop ' +
        '(catches a missed streaming final-chunk or an upstream discrepancy). ' +
        'The reconciliation JOB is a finding-style note here, not a separate ' +
        'card — the capture must record what reconciliation needs.\n\n' +
        '## Acceptance criteria\n\n' +
        '- For a non-streamed Anthropic call the gateway records ' +
        '`input_tokens`/`output_tokens` + the cache tokens from the upstream ' +
        '`usage`; for OpenAI it records `usage` (prompt/completion/total) — from ' +
        'the PROVIDER response, NOT a tokenizer estimate.\n' +
        '- For a STREAMED response usage is still captured authoritatively ' +
        '(Anthropic terminal `message_delta`; OpenAI the ' +
        '`stream_options.include_usage` FINAL chunk — the gateway requests ' +
        'include_usage upstream); an interrupted stream records the partial + a ' +
        'reconcile flag.\n' +
        '- Each usage row is attributed by the virtual key to its run/tenant + ' +
        'model, one row per upstream request (a run accrues many).\n' +
        '- The captured shape carries cache tokens distinctly (Anthropic cache ' +
        'writes/reads are not folded into plain input).\n' +
        '- The gateway records enough to reconcile against the provider billing ' +
        'API (channel + upstream request id where exposed) — the reconciliation ' +
        'job is noted as a follow-up finding, the capture supports it.\n\n' +
        '## Context refs\n\n' +
        '- 9.0.4 — the virtual key the usage is attributed by (run/tenant).\n' +
        '- 9.0.3 — the gateway + `controller/channel-billing.go`’s existing ' +
        'upstream-`usage` parse this extends to the full provider shape.\n' +
        '- 7.12.2 — the planning metering store (`PlanningRun`/`PlanningTurn`, ' +
        'token-from-SDK-`usage`, not estimated) this mirrors at the gateway for ' +
        'coding (the per-request/per-turn capture shape).\n' +
        '- Anthropic Messages API `usage` + prompt-caching (`input_tokens` / ' +
        '`output_tokens` / `cache_creation_input_tokens` / ' +
        '`cache_read_input_tokens`; streaming `message_delta`) and OpenAI Chat ' +
        'Completions `stream_options.include_usage` final-chunk (web-verified ' +
        '2026-06-12) — the bill-on-provider-`usage` facts.',
      dependsOn: ['9.0.4'],
    },
    {
      id: '9.0.6',
      title:
        'CREDIT integration — sync gateway spend to 7.12’s `CreditLedger` (tokens × per-model creditRate × margin → debit); out-of-credits → 429; resale margin in per-model pricing',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'Wire the gateway’s authoritative metering (9.0.5) into 7.12’s credit ' +
        'machinery so a hosted CODING run draws down the SAME `CreditLedger` ' +
        'planning does (one balance, no second ledger), and refuse the gateway ' +
        'when the tenant is out of credits. This is the load-bearing reuse: the ' +
        'gateway’s per-model pricing IS 7.12’s `ModelCreditRate` × margin, and ' +
        'the debit IS 7.12.3’s `creditsForTurn` conversion.\n\n' +
        '**Sync spend → `CreditLedger` (the debit).** As the gateway captures a ' +
        'request’s usage (9.0.5), sync it to motir-ai’s `creditService` (7.12.3) ' +
        '— `creditsForTurn = ((in/1k × creditsPer1kInput) + (out/1k × ' +
        'creditsPer1kOutput)) × marginMultiplier`, looked up by the request’s ' +
        'model + the effective-dated `ModelCreditRate` row — writing a `debit` ' +
        '`CreditTransaction` (referencing the gateway usage row / the run) + ' +
        'decrementing `CreditLedger.balance` under the ledger ROW LOCK (FOR ' +
        'UPDATE + re-read — the lock-before-read-derived-update rule), IDEMPOTENT ' +
        'on the gateway usage id so a retried sync never double-debits. The sync ' +
        'crosses the gateway→motir-ai boundary over HTTP (the 9.0.2 sync secret); ' +
        'the LEDGER stays in motir-ai (open-core: the gateway meters, motir-ai ' +
        'owns the balance). A coding `AgentRun` (9.1.6’s generalized ' +
        '`PlanningRun`) is the metering home the gateway spend records into.\n\n' +
        '**The resale margin lives in the gateway’s per-model pricing.** The ' +
        'margin is NOT a code constant — it is the `marginMultiplier` of the ' +
        'effective-dated per-model rate (7.12.3’s `ModelCreditRate`, which the ' +
        'gateway’s pricing mirrors). So Motir tunes the resale margin per model ' +
        'without a code change (the cost-plus mirror: a pricier model burns more ' +
        'credits). one-api’s native per-model multiplier is the gateway-side ' +
        'expression of the same rate; keep the two in sync (the rate table is ' +
        'the source of truth, the gateway pricing follows it).\n\n' +
        '**Out of credits → the gateway REFUSES (429).** When a tenant’s ' +
        '`CreditLedger.balance` is ≤ 0 (or the virtual key’s quota cap is ' +
        'exhausted — 9.0.4 caps it at the remaining balance), the gateway ' +
        'REFUSES the request with a `429` BEFORE any upstream provider call (no ' +
        'tokens spent, the managed provider key never used). This is the ' +
        'gateway-edge enforcement that complements 7.12.4’s pre-flight gate + ' +
        '9.1.7’s provision-time check: even a mid-run call that crosses zero is ' +
        'refused at the gateway, so the meter can never go negative without a ' +
        'block. It maps to 7.12’s typed `OutOfCreditsError` over the boundary. ' +
        'No buy/upgrade is triggered (Epic 8).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Each captured gateway request syncs a `debit` `CreditTransaction` to ' +
        'motir-ai’s `CreditLedger` equal to 7.12.3’s `creditsForTurn` (tokens × ' +
        'per-model rate × margin, effective-dated lookup), decrementing the ' +
        'balance under the row lock, IDEMPOTENT on the gateway usage id (a ' +
        'retried sync never double-debits).\n' +
        '- The debit lands on the SAME `CreditLedger` planning uses (a planning ' +
        'run and a gateway-metered coding call draw down ONE balance), recorded ' +
        'against the coding `AgentRun` (9.1.6); the ledger stays in motir-ai (no ' +
        'billing table in the gateway beyond one-api’s own quota mirror).\n' +
        '- The resale margin is the effective-dated per-model ' +
        '`marginMultiplier` (config/seed, not a code constant); changing it ' +
        'reprices new debits without code + without repricing history.\n' +
        '- A request for a balance-≤-0 (or quota-exhausted) tenant is refused ' +
        'with `429` BEFORE any upstream call (no tokens spent, the provider key ' +
        'never used), mapped to 7.12’s `OutOfCreditsError`; no buy/upgrade ' +
        'triggered (Epic 8).\n' +
        '- Open-core boundary: the sync crosses gateway→motir-ai over HTTP (the ' +
        '9.0.2 secret); neither imports the other.\n\n' +
        '## Context refs\n\n' +
        '- 9.0.5 — the captured authoritative usage this debits off (per ' +
        'request, with cache + streaming tokens).\n' +
        '- 7.12.3 — the `creditService` + `creditsForTurn` + `ModelCreditRate` ' +
        '(per-model rate + margin) + the locked-ledger debit this REUSES ' +
        'verbatim; the lock-before-read-derived-update rule.\n' +
        '- 7.12.4 — the typed `OutOfCreditsError` the gateway 429 maps to (the ' +
        'pre-flight gate this complements at the edge).\n' +
        '- 9.1.6 (stub) — the coding `AgentRun` (generalized `PlanningRun`) the ' +
        'gateway spend records into; 9.1.7 — the provision-time gate the gateway ' +
        '429 backstops.\n' +
        '- `songquanpeng/one-api` `controller/channel-billing.go` — the native ' +
        'per-model multiplier the gateway pricing keeps in sync with the rate ' +
        'table.',
      dependsOn: ['9.0.5', '7.12.3'],
    },
    {
      id: '9.0.7',
      title:
        'EGRESS LOCK / proxy enforcement — the contract that the 9.1 hosted sandbox reaches providers ONLY via the gateway (network policy + base-URL injection); bypass-prevention',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Make the gateway UNAVOIDABLE for a billed run: the 9.1 hosted sandbox ' +
        'must reach LLM providers ONLY through the gateway, never directly — ' +
        'this is WHAT makes the meter authoritative (a run that could call a ' +
        'provider directly could spend untracked tokens). This card ships the ' +
        'enforcement CONTRACT + the gateway side of it; 9.1 (the sandbox) wires ' +
        'the lock into its run containers, so this is the contract document + ' +
        'the gateway affordances 9.1 consumes.\n\n' +
        '**Two mechanisms, both required (defense in depth).** (1) **Base-URL ' +
        'injection** — the run container is given `ANTHROPIC_BASE_URL` / ' +
        '`OPENAI_BASE_URL` / the per-agent equivalents pointed at the gateway ' +
        '(+ the virtual key, 9.0.4) as its ONLY LLM config, so the agent CLIs ' +
        'talk to the gateway by default (the gateway is OpenAI/Anthropic-' +
        'compatible, 9.0.3, so this is transparent). (2) **Network policy** — ' +
        'the run container’s egress is RESTRICTED so direct connections to ' +
        'provider API hosts are BLOCKED and only the gateway (+ git remotes the ' +
        'run needs) is reachable. Base-URL injection alone is not enough (an ' +
        'agent could be reconfigured); the network policy is the hard wall.\n\n' +
        '**Bypass-prevention (document it).** The contract MUST document how a ' +
        'direct-to-provider bypass is prevented and what its residual risks are: ' +
        'the container holds NO managed provider key (9.0.2/9.0.4 — even if it ' +
        'reached a provider it has no key to spend), the network policy blocks ' +
        'provider hosts, and the gateway is the only egress with a usable ' +
        'credential. Note the deferred HARDENING (full egress allow-listing ' +
        'beyond the baseline) as a 9.1/Epic-9 security story — 9.0 fixes the ' +
        'CONTRACT (no key in the container + provider hosts blocked + gateway-' +
        'only credential), the exhaustive allow-list is later.\n\n' +
        '**The gateway side.** The gateway only honors a valid virtual key ' +
        '(9.0.4) — an un-keyed or foreign request is refused — so even a ' +
        'request that reaches the gateway without a run’s virtual key cannot ' +
        'spend. Document the `*_BASE_URL` + virtual-key injection shape 9.1.7 ' +
        'uses at provision time.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `gateway/docs/egress-lock.md` (or the metering-gateway doc) fixes the ' +
        'two-mechanism contract: base-URL injection (`*_BASE_URL` → gateway + ' +
        'virtual key as the container’s only LLM config) AND a network policy ' +
        'blocking direct provider hosts (only the gateway + git remotes ' +
        'reachable).\n' +
        '- It documents bypass-prevention: no managed provider key in the ' +
        'container (gateway injects it), provider hosts blocked, gateway-only ' +
        'usable credential — and names the residual risk + the deferred ' +
        'exhaustive-allow-list hardening (a 9.1/Epic-9 security story).\n' +
        '- The gateway enforces virtual-key-only access (an un-keyed / foreign ' +
        'request is refused) so a sandbox cannot spend without its run’s key.\n' +
        '- The `*_BASE_URL` + virtual-key injection shape 9.1.7 consumes at ' +
        'provision is specified (the contract 9.1 wires the lock from).\n' +
        '- The contract is consistent with 9.0.3 (the compatible endpoints the ' +
        'base URL targets) + 9.0.4 (the virtual key) — no direct-provider path ' +
        'with a usable credential exists for a run.\n\n' +
        '## Context refs\n\n' +
        '- 9.0.3 — the OpenAI/Anthropic-compatible gateway the `*_BASE_URL` ' +
        'targets (so injection is transparent to the agent CLIs).\n' +
        '- 9.0.4 — the virtual key the gateway requires (no key → no spend, even ' +
        'on a request that reaches the gateway).\n' +
        '- 9.0.2 — the managed provider keys that live ONLY at the gateway (the ' +
        'container holds none).\n' +
        '- 9.1.3 / 9.1.7 (stub) — the run-container network policy + the ' +
        'provision-time `*_BASE_URL`/virtual-key injection that WIRE this lock; ' +
        'the deferred egress-allow-list hardening is a 9.1/Epic-9 security ' +
        'story.',
      dependsOn: ['9.0.3'],
    },
    {
      id: '9.0.8',
      title:
        'Integration test — virtual-key attribution + usage capture (incl. a streamed response) + credit debit + out-of-credits 429',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'Lock the gateway metering end to end. The provider UPSTREAM is stubbed ' +
        'at the channel boundary with RECORDED `usage` figures (no live model in ' +
        'CI — a fake upstream that returns a Motir-controlled Anthropic/OpenAI ' +
        'response shape, incl. a streamed variant), and motir-ai runs over its ' +
        'own real Postgres (7.1.3) so the `CreditLedger` debit is exercised for ' +
        'real — but the virtual-key attribution, the authoritative-usage ' +
        'capture, the credit conversion, and the 429 enforcement run against the ' +
        'real gateway + ledger.\n\n' +
        '**Virtual-key attribution (9.0.4):**\n\n' +
        '- A minted run-scoped virtual key proxies a request that is attributed ' +
        'to its run/tenant; an absent / expired / revoked key is refused ' +
        '(401/403); a tenant-A key cannot spend as tenant B.\n\n' +
        '**Usage capture (9.0.5) — incl. streaming:**\n\n' +
        '- A non-streamed Anthropic-shaped response yields a usage row with ' +
        '`input_tokens`/`output_tokens` + the cache tokens captured DISTINCTLY ' +
        '(not folded into input); a non-streamed OpenAI-shaped response captures ' +
        '`usage` (prompt/completion/total) — from the stubbed PROVIDER response, ' +
        'NOT a tokenizer estimate.\n' +
        '- A STREAMED response still captures usage authoritatively (the stub ' +
        'emits the Anthropic terminal `message_delta` / the OpenAI ' +
        '`include_usage` FINAL chunk; the gateway reads it) — assert the ' +
        'captured totals equal the stub’s figures.\n\n' +
        '**Credit debit (9.0.6):**\n\n' +
        '- The captured usage syncs a `debit` `CreditTransaction` to ' +
        'motir-ai’s `CreditLedger` equal to 7.12.3’s `creditsForTurn` (tokens × ' +
        'per-model rate × margin, effective-dated lookup) and the balance drops ' +
        'by exactly that; the debit is IDEMPOTENT on the gateway usage id (a ' +
        'retried sync does not double-debit) and the SAME ledger planning uses ' +
        'is debited (one balance).\n\n' +
        '**Out-of-credits 429 (9.0.6):**\n\n' +
        '- A request for a balance-≤-0 (or quota-exhausted) tenant is refused ' +
        'with `429` and the UPSTREAM stub is NEVER invoked (assert no provider ' +
        'call, no tokens spent, the ledger unchanged), mapped to 7.12’s ' +
        '`OutOfCreditsError`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The above cases pass with the provider upstream stubbed (recorded ' +
        '`usage`, incl. a streamed variant) and motir-ai over its real Postgres; ' +
        'no live model / no real provider call in CI.\n' +
        '- The streamed-usage capture is proven (the captured totals equal the ' +
        'stub’s final-chunk / `message_delta` figures), and the out-of-credits ' +
        '429 is proven to make NO upstream call.\n' +
        '- The credit debit is asserted against a fixture (the per-model rate ' +
        'lookup + the rounding boundary, REUSING 7.12.6’s conversion fixtures ' +
        'where sensible) and the idempotent-retry + one-balance reuse are ' +
        'covered.\n\n' +
        '## Context refs\n\n' +
        '- 9.0.4 / 9.0.5 / 9.0.6 (everything under test).\n' +
        '- 7.12.6 — the metering/ledger test patterns + conversion fixtures this ' +
        'composes with (the SAME debit math, now for gateway-metered coding ' +
        'usage).\n' +
        '- 7.1.3 — the motir-ai test DB the `CreditLedger` debit runs over.\n' +
        '- Anthropic `message_delta` / OpenAI `include_usage` final-chunk ' +
        '(web-verified 2026-06-12) — the streamed-usage shape the upstream stub ' +
        'reproduces.',
      dependsOn: ['9.0.5', '9.0.6'],
    },
  ],
};
