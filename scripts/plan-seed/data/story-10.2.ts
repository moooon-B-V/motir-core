import type { SeedStory } from '../types';

/**
 * Story 10.2 (Epic 10 — Platform administration & operations) — System
 * monitoring & health. The OPS health surface of the platform-admin console:
 * the one place Motir-internal staff see, at a glance, whether the running
 * platform is HEALTHY — Vercel deploys + function error-rate + traffic, the
 * Inngest job pipeline (runs / failures / throughput / backlog / retries), the
 * 9.0 AI gateway (latency / error), and DB health — each as a compact signal
 * panel that LINKS OUT to the native dashboard for the deep dive.
 *
 * **The confirmed posture (Yue, the admin-features expansion) — INTEGRATE
 * read-only, do NOT rebuild observability.** Vercel and Inngest already ship
 * world-class observability UIs; re-implementing traces / log search /
 * per-step timelines would be a multi-quarter mistake and would rot against
 * their feature velocity. So 10.2 pulls a SMALL set of key SIGNALS over their
 * read-only APIs, renders them as health panels with thresholds, and LINKS OUT
 * to the native dashboard (the deployment inspector URL, the Inngest function
 * page) for anything deeper. The value Motir adds is the SINGLE PANE — Vercel
 * + Inngest + gateway + DB health in one operator view, cross-tenant, beside
 * the 10.1 usage rollups — not a re-built telemetry stack.
 *
 * **The verified integration surfaces (cited, not asserted — web-checked
 * 2026-06-12).**
 *   - **Vercel REST API** (`GET /v7/deployments`, HTTP bearer token, `teamId`
 *     scoping) returns, per deployment: `state` / `readyState` in
 *     `{ READY, ERROR, BUILDING, QUEUED, CANCELED, BLOCKED, INITIALIZING }`,
 *     `errorCode` / `errorMessage`, an `oomReport` out-of-memory flag,
 *     `target` (production / preview), the `inspectorUrl` (the link-out), and
 *     created/ready timestamps — exactly the deploy-health signal (last deploy
 *     state, recent error/canceled count) Motir surfaces. For function
 *     error-rate + traffic Vercel exposes the **Observability / Monitoring
 *     query API** (team- or project-level) and **Drains** (runtime / function
 *     logs, Pro/Enterprise) — read-only via the token. (Vercel docs:
 *     REST API › list-deployments; Observability; Query › Monitoring.)
 *   - **Inngest REST API** — fetch run status programmatically via
 *     `GET https://api.inngest.com/v1/events/{eventId}/runs` (signing-key
 *     auth) and the v2 "Get function run" / "List event function runs"
 *     endpoints (api-docs.inngest.com). The Inngest platform's observability
 *     surfaces the signals Motir mirrors as a panel: the **Function Status**
 *     snapshot (runs grouped by failed / succeeded / cancelled), the **Failed
 *     Functions** chart (top failing functions + failure frequency), **Total
 *     runs throughput**, and the **backlog** (runs waiting to be processed) —
 *     plus retries (default 4 attempts; exhausted → Failed) and Inngest's
 *     "replay a failed function" model IN PLACE OF a literal dead-letter queue
 *     (so the "dead-letter" signal Motir shows is the failed-after-retries
 *     set + a link-out to replay, NOT a DLQ table to drain). (Inngest docs:
 *     Observability & Metrics; Inspecting a Function run; Retries; Fetch run
 *     status and output.)
 *
 * **What this is NOT (read-only + link-out, no remediation).** 10.2 NEVER
 * mutates Vercel or Inngest — no triggering a redeploy, no cancelling a run, no
 * replaying from Motir (the operator clicks through to the native dashboard for
 * that). It reads signals and renders thresholds. The cross-tenant gating, the
 * `/admin` surface, and the audited read access all come from **10.1.3** (this
 * story rides that platform-staff auth — a hard, BACKWARD dep). The usage/cost
 * rollups are 10.1; the credit/governance toolkit is 10.3; this is purely the
 * RUNTIME-health pane.
 *
 * **Deferred future 10.x (NAMED so they are visibly deferred, not forgotten —
 * same posture as 10.3's header):** synthetic uptime / external-probe checks
 * (Motir reads the providers' health, it does not yet run its own canary), a
 * customer-facing public STATUS PAGE + maintenance banners (10.3's deferral
 * list owns the banner; 10.2 is the internal pane the status page would read
 * FROM), on-call paging / PagerDuty-Opsgenie escalation, and log-search /
 * trace UI (deliberately NOT rebuilt — that is the native dashboards' job, the
 * whole point of integrate-not-rebuild). Alerting in 10.2 is in-console
 * threshold BADGES (10.2.6); routing those to a pager is a future 10.x.
 *
 * **Open-core boundary.** The monitoring lives in motir-core's platform-admin
 * surface (the operator console). The Vercel + Inngest reads are
 * SERVER-TO-SERVER from motir-core's admin services (provider tokens held
 * server-side, 10.2.3) — browsers never hold a provider token, and the
 * provider APIs are never called from the client. The 9.0 gateway + DB health
 * are read from motir-core's own operational signals. No customer-tenant data
 * crosses into these panels; they are infra health, gated to platform staff.
 *
 * **The design gate fires (Principle #13).** 10.2 ships a real operator
 * surface — the ops health view. So the FIRST subtask (10.2.1) is a `design`
 * card producing `design/platform-admin/*.mock.html` + `design-notes.md`, and
 * every UI-touching code subtask (10.2.6 panels, 10.2.7 the view) depends on
 * it and is `blocked` behind it. The design area is SHARED with 10.1 / 10.3
 * (`design/platform-admin/`) — 10.2 adds the monitoring board to that area,
 * consistent with the one-console framing.
 *
 * **Cross-story dep audit (notes.html #32): PASSES.** Every 10.2 leaf depends
 * only on backward/sideways ids — same-story 10.2.x cards and 10.1.3 (the
 * platform-staff auth + gated admin surface + audited cross-tenant read access
 * this rides). No forward-pointing dep (nothing on 10.3, nothing on a higher
 * story). Statuses follow the rule: the two `dependsOn: []` cards (10.2.1
 * design, 10.2.2 decision) are `planned`; everything chained behind them or
 * behind the not-yet-done 10.1.3 is `blocked`.
 */
export const story_10_2: SeedStory = {
  id: '10.2',
  title: 'System monitoring & health (Vercel + Inngest)',
  status: 'planned',
  gitBranch: 'feat/PROD-10.2-system-monitoring-health',
  descriptionMd:
    'The OPS HEALTH pane of the platform-admin console (Epic 10): a single ' +
    'operator view that pulls KEY SIGNALS read-only from Vercel and Inngest ' +
    '(plus the 9.0 AI gateway and DB health), renders them as compact health ' +
    'panels with alert thresholds, and LINKS OUT to the native dashboards for ' +
    'the deep dive. **Integrate, do NOT rebuild observability** — Motir adds ' +
    'the single pane (Vercel + Inngest + gateway + DB in one cross-tenant ' +
    'operator view beside the 10.1 usage rollups), not a re-built telemetry ' +
    'stack.\n\n' +
    '**The posture (confirmed — see the module header for the full rationale ' +
    '+ the cited surfaces):**\n\n' +
    '- **Read-only + link-out.** Motir NEVER mutates Vercel or Inngest (no ' +
    'redeploy, no cancel, no replay from Motir). It reads signals and shows ' +
    'thresholds; the operator clicks through to the native dashboard ' +
    '(Vercel’s deployment `inspectorUrl`, the Inngest function page) for ' +
    'remediation + the deep dive.\n' +
    '- **The Vercel signals** (`GET /v7/deployments`, bearer token, `teamId` ' +
    'scoping): last-deploy `state`/`readyState` (READY/ERROR/BUILDING/…), ' +
    'recent ERROR/CANCELED + `oomReport` counts, `target` (prod/preview); ' +
    'function error-rate + traffic via the Observability/Monitoring query ' +
    'API. Read-only via the token.\n' +
    '- **The Inngest signals** (`api.inngest.com/v1/events/:id/runs` + the v2 ' +
    'run endpoints, signing-key auth; the Observability surface): Function ' +
    'Status (runs by failed/succeeded/cancelled), top Failed Functions + ' +
    'frequency, Total-runs throughput, backlog (waiting runs), retries (4 ' +
    'attempts; exhausted → Failed). Inngest has NO literal dead-letter queue ' +
    '— failed-after-retries + “replay” is the equivalent, so Motir shows the ' +
    'failed set + a link-out to replay, not a DLQ to drain.\n' +
    '- **The 9.0 gateway + DB health** read from motir-core’s own operational ' +
    'signals: gateway latency / error-rate (per 9.0’s per-run metering), DB ' +
    'reachability / pool / latency.\n' +
    '- **Rides 10.1.3.** The cross-tenant gating, the `/admin` surface, and ' +
    'the audited read access are 10.1.3’s — 10.2 is platform-staff-only and ' +
    'depends on it.\n\n' +
    '**Scope:** the ops-health design (10.2.1); the integrate-not-rebuild ' +
    'signal/pull-mechanism decision (10.2.2); the manual provision of the ' +
    'Vercel + Inngest API tokens (10.2.3); the Vercel read-only integration ' +
    '(10.2.4); the Inngest read-only integration (10.2.5); the gateway + DB ' +
    'health panels + alert thresholds (10.2.6); the monitoring UI — panels + ' +
    'link-outs (10.2.7); and vitest over the integrations (mocked external ' +
    'APIs) + the threshold logic (10.2.8).\n\n' +
    '**Out of scope (named so they land in their own story / future 10.x, not ' +
    'here):** the usage/cost ROLLUPS (10.1); the credit / governance toolkit ' +
    '(10.3); synthetic uptime probes / on-call paging / a public status page ' +
    '+ maintenance banners / log-search + trace UI — the last is ' +
    'DELIBERATELY not rebuilt (the native dashboards own it, the whole point ' +
    'of integrate-not-rebuild); in-console threshold badges are the only ' +
    'alerting 10.2 ships, routing them to a pager is a future 10.x.',
  verificationRecipeMd:
    '- Pull the Story branch; run motir-core with a platform-staff ' +
    '(superadmin) session (the 10.1.3 gating) and the Vercel + Inngest ' +
    'monitoring tokens wired (10.2.3). In a NON-staff session the ops-health ' +
    'route is denied (404-not-403, the standing cross-tenant guard from ' +
    '10.1.3) — confirm first.\n' +
    '- **Vercel panel (read-only).** Open the ops-health view → the Vercel ' +
    'panel shows the latest production deploy’s state, a recent ' +
    'ERROR/CANCELED count, and function error-rate / traffic. Each row LINKS ' +
    'OUT to the deployment’s `inspectorUrl` (the native dashboard) — there is ' +
    'NO redeploy / cancel control in Motir. Force an error state (or use a ' +
    'fixture) → the panel’s threshold badge flips to warning/critical.\n' +
    '- **Inngest panel (read-only).** The Inngest panel shows Function Status ' +
    '(by succeeded/failed/cancelled), the top failing functions + frequency, ' +
    'throughput, and the backlog of waiting runs; the failed set links OUT to ' +
    'the Inngest function page (for replay) — Motir does NOT replay. Confirm ' +
    'the retries/failed-after-retries signal renders (Inngest has no literal ' +
    'DLQ — the failed-after-4-attempts set is the equivalent).\n' +
    '- **Gateway + DB health.** The 9.0 gateway panel shows latency / ' +
    'error-rate from the gateway metering; the DB panel shows reachability / ' +
    'latency. Each carries a threshold badge (healthy / degraded / down).\n' +
    '- **Thresholds + degrade-safely.** With a provider API made to fail ' +
    '(bad/absent token, or a stubbed 5xx), the affected panel shows a clear ' +
    '“can’t reach Vercel/Inngest” state + retry — NOT a misleading all-green ' +
    'or a crashed page (the rest of the board still renders). Threshold ' +
    'breaches show the warning/critical badge per the documented rule.\n' +
    '- `pnpm test` (motir-core) — 10.2.8 covers the Vercel + Inngest clients ' +
    'against MOCKED external APIs (recorded fixtures: a healthy deploy, an ' +
    'ERROR/OOM deploy, a run set with failures + backlog), the signal → ' +
    'panel-DTO mapping, and the threshold logic (each band: healthy / ' +
    'degraded / critical, incl. the boundary) — plus the staff-gating on the ' +
    'ops-health route (non-staff denied).\n' +
    '- **Provisioning (10.2.3) confirmation.** The Vercel + Inngest ' +
    'read-only API tokens exist (least-privilege, monitoring scope), are set ' +
    'server-side on the deployment, and browsers never hold them — Yue ' +
    'confirms (no PR).\n' +
    '- **Open-core / read-only boundary review.** The provider APIs are ' +
    'called ONLY server-to-server from motir-core admin services (no provider ' +
    'token in any client bundle; no provider API call from the browser); ' +
    'every call is READ-only (list/get, never a POST that mutates); the view ' +
    'is platform-staff-gated. No customer-tenant data appears in these infra ' +
    'panels.\n' +
    '- If every step holds, approve and merge the Story PR. If anything ' +
    'fails, comment with what didn’t work and Motir will produce a follow-up ' +
    'Subtask under the same Story.',
  items: [
    {
      id: '10.2.1',
      title:
        'Design — the ops health view (Vercel / Inngest / gateway / DB panels + link-outs to native dashboards)',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        '**Type:** design (the planning-time design gate, Principle #13 + the ' +
        'design-reference rule). The monitoring panels (10.2.6) and the ops ' +
        'view (10.2.7) depend on this card; without it the surface would be ' +
        'improvised, which is forbidden (notes.html #31).\n\n' +
        'Produce the design asset for the **ops health view** under ' +
        '`motir-core/design/platform-admin/` (the SHARED Epic-10 admin design ' +
        'area — 10.1 overview/rollups + 10.3 toolkit live here too; add the ' +
        'monitoring board to it, consistent with the one-console framing). ' +
        'Author it as a **`*.mock.html` mockup** built from the real design ' +
        'system (the shipped `components/ui/*` primitives + the `--el-*` ' +
        'colour tokens + the `[data-display-style]` shape tokens) — NOT a ' +
        '`.pen`. The HTML route is preferred when a coding agent produces the ' +
        'design (no translation gap; the reviewer sees the actual tokens). A ' +
        'PNG export is optional; the `.mock.html` is the source of truth ' +
        '(MOTIR.md § Design-reference rule).\n\n' +
        '**SCOPE — read-only signals + link-out, NOT a rebuilt observability ' +
        'UI.** This surface SHOWS health signals and LINKS OUT to the native ' +
        'dashboards (Vercel’s deployment inspector, the Inngest function ' +
        'page) for the deep dive. There is NO trace timeline, NO log-search, ' +
        'NO per-step run viewer drawn here — that is the native dashboards’ ' +
        'job (integrate-not-rebuild). There is also NO remediation control ' +
        '(no redeploy / cancel / replay button) — Motir is read-only; the ' +
        'link-out is how the operator acts.\n\n' +
        '**Mirror (cited — the operator-console / single-pane shape).** ' +
        'Mirror SaaS operator health consoles + the source dashboards: ' +
        'Vercel’s Observability deploy/function panels and Inngest’s ' +
        'Observability (the Function Status snapshot, the Failed Functions ' +
        'chart, the throughput + backlog charts). Draw the COMPACT signal + ' +
        'threshold + link-out version of those, unified in one board — not a ' +
        'copy of either full dashboard.\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the ' +
        'multi-panel rule, mistake #31):\n\n' +
        '- **Panel 1 — the health board overview (populated, all-green).** A ' +
        'grid of compact health `Card`s — one per source (Vercel deploys, ' +
        'Vercel functions, Inngest jobs, 9.0 gateway, DB) — each showing a ' +
        'status dot (healthy / degraded / critical via `--el-success` / ' +
        '`--el-warning` / `--el-danger` tints), the headline signal (e.g. ' +
        '“last deploy READY”, “0.3% fn error”, “12 failed runs / 1h”), and a ' +
        '“view in <provider> ↗” link-out. This is the at-a-glance pane.\n' +
        '- **Panel 2 — the Vercel deploy panel (expanded).** The latest ' +
        'production deploy’s state + timestamp, a small recent-deploys list ' +
        '(state pill per row: READY / ERROR / CANCELED / BUILDING; an OOM ' +
        'flag), function error-rate + traffic mini-stats, each row link-out ' +
        'to the deployment `inspectorUrl`. Paginate / cap the recent-deploys ' +
        'list (an account accrues many deploys — the at-scale rule, no ' +
        'load-all).\n' +
        '- **Panel 3 — the Inngest job panel (expanded).** Function Status ' +
        '(runs grouped succeeded / failed / cancelled), the top failing ' +
        'functions + failure frequency, throughput, and the backlog (waiting ' +
        'runs) — each a compact stat/mini-bar; the failed set link-out to the ' +
        'Inngest function page (for replay — Motir does not replay). NAME, in ' +
        'copy, that there is no DLQ to drain (failed-after-retries + replay is ' +
        'the model).\n' +
        '- **Panel 4 — the gateway + DB health panel + thresholds.** The 9.0 ' +
        'gateway latency / error-rate and the DB reachability / latency, each ' +
        'with a threshold BADGE (healthy / degraded / critical) and the ' +
        'configured threshold shown (e.g. “critical > 2% error”). Use a ' +
        '`--el-warning` / `--el-danger` tint BANNER for a breach (NOT a ' +
        'page-level tinted surface — finding #35).\n' +
        '- **Panel 5 — empty / loading / partial-failure states.** The ' +
        'loading skeleton while polling; the per-panel “can’t reach ' +
        'Vercel/Inngest” error + retry (a degraded provider must NOT blank the ' +
        'whole board or show a misleading all-green — the other panels still ' +
        'render); and the first-run / no-data state.\n\n' +
        'Also write **`design/platform-admin/monitoring-design-notes.md`** (or ' +
        'extend the area’s `design-notes.md` with a Monitoring section) naming ' +
        'the exact primitives used per surface, the exact copy strings (incl. ' +
        'the link-out labels + the “no DLQ — replay in Inngest” line), the ' +
        'placement decisions, the per-`--el-*` colour role for each element ' +
        '(incl. the status-dot success/warning/danger roles + the threshold ' +
        'badge roles), and a “primitives composed (no hand-rolling)” checklist ' +
        '(the `design-notes.md` convention 1.3.3 / 1.5.1 / 7.0.1 established). ' +
        'It MUST state, in writing, that this is read-only + link-out (no ' +
        'remediation control, no rebuilt trace/log UI).\n\n' +
        '**Branch.** `design/PROD-10.2.1-ops-health-view`. The `design/*` ' +
        'prefix gate skips CI E2E + the Vercel preview deploy (MOTIR.md ' +
        '§ Plan-seed Workflow) — this PR only edits ' +
        '`design/platform-admin/**`, no app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A `*.mock.html` under `motir-core/design/platform-admin/` renders ' +
        'the five panels above and references ONLY `--el-*` tokens + ' +
        '`[data-display-style]` shape tokens (no Tier-0 `--color-*`, no ' +
        'hand-rolled spacing — the `motir-core/CLAUDE.md` § colour / shape ' +
        'rules).\n' +
        '- The design-notes file exists, names every primitive composed + ' +
        'every copy string + the per-element `--el-*` role (incl. the ' +
        'status-dot + threshold-badge roles), and STATES the read-only + ' +
        'link-out posture (no remediation control; no rebuilt trace/log/run ' +
        'UI — that is the native dashboards).\n' +
        '- Every source panel (Vercel deploys, Vercel functions, Inngest, ' +
        'gateway, DB) carries a health status indicator + a “view in ' +
        '<provider> ↗” link-out; the recent-deploys + failed-runs lists are ' +
        'drawn paginated/capped (at-scale, not load-all).\n' +
        '- The partial-failure state is drawn (one provider down ≠ a blank or ' +
        'all-green board); the threshold breach uses a tint banner, not a ' +
        'page-level tinted surface (finding #35); the palette is used (status ' +
        'colours, not grey-only — finding #54).\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Pill`, ' +
        '`Button`/link, `EmptyState`, a table/list pattern, the ' +
        'skeleton/loader, a stat/mini-chart pattern) — if a genuinely new ' +
        'primitive is needed (e.g. a sparkline), that is a NEW `design/` ' +
        'subtask, not a code workaround.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/platform-admin/` (10.1.1) — the SHARED Epic-10 ' +
        'admin design area to extend; mirror its layout + `design-notes.md` ' +
        'shape (the overview / rollups board this monitoring board sits ' +
        'beside).\n' +
        '- `motir-core/design/ready/` (7.0.1) + `motir-core/design/ai-usage/` ' +
        '(7.12.1) — the closest existing stat/panel design areas to mirror.\n' +
        '- `motir-core/components/ui/Card.tsx`, `Pill.tsx`, `Button.tsx`, ' +
        '`EmptyState.tsx` — the composable surface.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` colour (incl. ' +
        '`--el-success` / `--el-warning` / `--el-danger` for the status dots + ' +
        'threshold badges) + `[data-display-style]` shape tokens.\n' +
        '- Vercel Observability + Inngest Observability dashboards (the cited ' +
        'mirror — the compact signal+link-out version of those panels).',
      dependsOn: [],
    },
    {
      id: '10.2.2',
      title:
        'Decision — integrate-not-rebuild: which signals, the pull mechanism (poll vs webhook), and the link-out boundary',
      status: 'planned',
      type: 'decision',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        '**Type:** decision (the keystone ADR the 10.2 code cards build ' +
        'against). Produce a living monitoring-integration document; no app ' +
        'behavior ships here, but the signal set + the pull mechanism + the ' +
        'read-only/link-out boundary it fixes are load-bearing for 10.2.4–' +
        '10.2.7.\n\n' +
        'Write `motir-core/docs/ops-monitoring.md` (the authoritative ' +
        'integration spec). It MUST fix:\n\n' +
        '1. **The signal inventory (small, key signals only — not a clone).** ' +
        'Enumerate EXACTLY what Motir pulls, per source, with the cited API ' +
        'shape:\n' +
        '   - **Vercel deploys** — `GET /v7/deployments` (bearer token, ' +
        '`teamId` scoping): the latest production deploy `state`/`readyState` ' +
        '(READY / ERROR / BUILDING / QUEUED / CANCELED / BLOCKED / ' +
        'INITIALIZING), recent ERROR/CANCELED + `oomReport` counts, `target`, ' +
        'the `inspectorUrl` (the link-out), created/ready timestamps.\n' +
        '   - **Vercel functions** — function error-rate + traffic via the ' +
        'Observability / Monitoring query API (team/project level); decide ' +
        'whether Drains (function-log streaming, Pro/Enterprise) are in scope ' +
        'or deferred (default: deferred — the query API’s rollups suffice for ' +
        'a health badge).\n' +
        '   - **Inngest jobs** — Function Status (runs by succeeded / failed ' +
        '/ cancelled), top Failed Functions + frequency, Total-runs ' +
        'throughput, backlog (waiting runs), retries (default 4 attempts; ' +
        'exhausted → Failed) via the REST API ' +
        '(`api.inngest.com/v1/events/:id/runs` + the v2 run endpoints, ' +
        'signing-key auth) / the Observability surface. RECORD that Inngest ' +
        'has NO literal dead-letter queue — the failed-after-retries set + ' +
        '“replay” is the equivalent, so the Motir “dead-letter” signal is the ' +
        'failed set + a link-out to replay, NOT a DLQ table to drain.\n' +
        '   - **9.0 gateway** — latency / error-rate from the gateway’s ' +
        'per-run metering (motir-core-internal, not an external API).\n' +
        '   - **DB** — reachability / latency / pool health (motir-core ' +
        'internal).\n' +
        '2. **The pull mechanism (poll vs webhook), justified.** Default to ' +
        'POLLING on a bounded cadence (a server-side scheduled read on the 1.6 ' +
        'Inngest cron substrate — note the recursion: Inngest schedules the ' +
        'read of Inngest’s OWN health, which is fine, the read is independent ' +
        'of the pipeline’s health) writing the latest signals to a small ' +
        'snapshot cache, so a page load reads the cache (never N live provider ' +
        'calls per viewer — the at-scale rule + provider rate-limit respect: ' +
        'Vercel returns X-RateLimit-* headers). Where a webhook exists and ' +
        'beats polling (e.g. a Vercel deploy-event webhook for instant deploy ' +
        'state), note it as an enhancement; the BASELINE is poll-to-cache. ' +
        'Fix the cadence + the cache TTL + the rate-limit backoff rule.\n' +
        '3. **The read-only + link-out boundary.** State PLAINLY: Motir makes ' +
        'ONLY read calls (list/get) to Vercel + Inngest — never a mutating ' +
        'POST (no redeploy, cancel, replay). Every deep-dive / remediation is ' +
        'a LINK-OUT to the native dashboard (the Vercel `inspectorUrl`, the ' +
        'Inngest function page). Trace / log-search / per-step run viewing are ' +
        'NOT rebuilt — the native dashboards own them.\n' +
        '4. **The threshold model.** The health bands (healthy / degraded / ' +
        'critical) per signal and the default thresholds (e.g. fn error-rate ' +
        '> X% = critical; backlog > N = degraded; DB latency > Yms = ' +
        'degraded), fixed ONCE here and consumed by 10.2.6 — config, not ' +
        'hard-code, so they tune without a code change.\n' +
        '5. **Auth + token inventory (the input to 10.2.3).** List the ' +
        'least-privilege, READ-only tokens each source needs ' +
        '(`VERCEL_MONITORING_TOKEN` + `VERCEL_TEAM_ID`; ' +
        '`INNGEST_SIGNING_KEY` / a read API key) and that they are held ' +
        'SERVER-side only (never in a client bundle).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/docs/ops-monitoring.md` exists and fixes all five ' +
        'sections, with the concrete API shape cited per signal (the Vercel ' +
        '`/v7/deployments` fields, the Inngest run endpoints + the ' +
        'no-DLQ/replay note).\n' +
        '- The poll-to-cache mechanism is justified against per-viewer live ' +
        'calls (the at-scale + rate-limit rationale), with the cadence + TTL + ' +
        'backoff fixed; any webhook enhancement is named as optional, not the ' +
        'baseline.\n' +
        '- The read-only + link-out boundary is stated explicitly (no ' +
        'mutating call; deep dive = link-out; no rebuilt trace/log/run UI).\n' +
        '- The threshold bands + defaults are fixed once (the input to ' +
        '10.2.6) as config, not code.\n' +
        '- The token inventory is explicit (the input to 10.2.3) and ' +
        'least-privilege + server-side-only.\n\n' +
        '## Context refs\n\n' +
        '- This module header (the cited Vercel + Inngest surfaces).\n' +
        '- Vercel docs: REST API › list-deployments; Observability; Query › ' +
        'Monitoring; Drains. Inngest docs: Observability & Metrics; Inspecting ' +
        'a Function run; Retries; Fetch run status and output.\n' +
        '- `lib/jobs/registry.ts` (the 1.6 Inngest cron substrate) — where the ' +
        'poll-to-cache scheduled read rides.\n' +
        '- 9.0 (stub) — the gateway metering the gateway-health signal reads.\n' +
        '- 10.1.2 — the platform-staff auth model the ops view inherits (the ' +
        'sibling decision card; keep this consistent with it).',
      dependsOn: [],
    },
    {
      id: '10.2.3',
      title: 'Provision the Vercel + Inngest read-only monitoring API tokens (manual)',
      status: 'blocked',
      type: 'manual',
      executor: 'human',
      estimateMinutes: 30,
      descriptionMd:
        '**Type:** manual/human (no PR — dashboard / secret work, mirror ' +
        '1.6.7; marked done on Yue’s confirmation). A coding agent cannot mint ' +
        'a provider API token or set a production secret. Wired here via ' +
        '`dependsOn` so the prerequisite is visible at PLAN time (notes.html ' +
        '#30), not discovered at run time.\n\n' +
        'Using the token inventory fixed by 10.2.2:\n\n' +
        '1. **Mint the Vercel monitoring token** — a Vercel access token ' +
        'scoped READ-only to the Motir team (least privilege: enough to call ' +
        '`GET /v7/deployments` + the Observability/Monitoring query API, ' +
        'NOTHING that can redeploy / mutate). Capture the `VERCEL_TEAM_ID` for ' +
        'team-scoped requests.\n' +
        '2. **Mint / locate the Inngest read key** — the signing key (or a ' +
        'read-scoped API key) used to call the Inngest REST run endpoints ' +
        '(`api.inngest.com/v1/events/:id/runs` + the v2 run endpoints). ' +
        'Read-only.\n' +
        '3. **Wire env, server-side only** — set `VERCEL_MONITORING_TOKEN`, ' +
        '`VERCEL_TEAM_ID`, and `INNGEST_SIGNING_KEY` (/ the read key) on the ' +
        'motir-core deployment as SERVER secrets. They MUST NOT be exposed to ' +
        'the client (no `NEXT_PUBLIC_` prefix) — browsers never hold a ' +
        'provider token (the open-core / read-only boundary).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A Vercel read-only monitoring token + `VERCEL_TEAM_ID`, and an ' +
        'Inngest read key, exist (least-privilege, monitoring/read scope — no ' +
        'mutating capability).\n' +
        '- All tokens are set as SERVER secrets on the motir-core deployment ' +
        'and are absent from any client bundle (no `NEXT_PUBLIC_`).\n' +
        '- The env keys from 10.2.2’s inventory are present in each ' +
        'environment.\n' +
        '- Yue confirms; Motir marks the subtask done (no PR).\n\n' +
        '## Context refs\n\n' +
        '- 10.2.2’s token inventory (the keys + scopes).\n' +
        '- 7.1.2 / 1.6.7 — the precedent manual-provisioning shape (secret ' +
        'mint + env wiring, no PR, done-on-confirm).',
      dependsOn: ['10.2.2'],
    },
    {
      id: '10.2.4',
      title: 'Vercel integration (read-only) — deploys, function error-rate, traffic',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'The motir-core server-side client + service that READ the Vercel ' +
        'health signals (10.2.2’s inventory) and map them to the ops-health ' +
        'DTOs. Read-only: list/get only — never a mutating call.\n\n' +
        '**4-layer-aware, but the data is REMOTE (no DB table for the live ' +
        'signal).** This mirrors the 7.12.5 read-through shape: a leaf CLIENT ' +
        'primitive + a service, no motir-core repository for the live provider ' +
        'data (it lives at Vercel). The snapshot CACHE (10.2.2’s ' +
        'poll-to-cache) IS a motir-core table, so its read/write goes through ' +
        'a real repository + the 4-layer.\n\n' +
        '- **`lib/ops/vercelClient.ts`** — a server-only leaf client (like ' +
        '`lib/email.ts`): `listDeployments({ teamId, projectId?, limit, ' +
        'target? })` → the typed deploy list (state/readyState, errorCode/' +
        'errorMessage, oomReport, target, inspectorUrl, timestamps) from ' +
        '`GET /v7/deployments`; `getFunctionMetrics(...)` → error-rate + ' +
        'traffic from the Observability/Monitoring query API. Auth with ' +
        '`VERCEL_MONITORING_TOKEN`; scope with `VERCEL_TEAM_ID`. Respects the ' +
        'X-RateLimit-* headers with the 10.2.2 backoff. `import "server-only"` ' +
        '— never bundled to the client.\n' +
        '- **`lib/services/opsMonitoringService.ts`** (the Vercel slice) — ' +
        'calls the client, derives the Vercel health DTO (latest-prod-deploy ' +
        'state, recent ERROR/CANCELED/OOM counts, fn error-rate, traffic, the ' +
        'per-deploy `inspectorUrl` link-outs), applies the 10.2.2 thresholds ' +
        '(reused from 10.2.6’s threshold module once it lands — for now the ' +
        'service computes the bands from config). Reads the snapshot cache; on ' +
        'a cache miss / a forced refresh, calls the client.\n' +
        '- **The snapshot cache (poll-to-cache).** A scheduled read on the 1.6 ' +
        'Inngest cron substrate (`lib/jobs/registry.ts`) calls the client on ' +
        'the 10.2.2 cadence and upserts a `MonitoringSnapshot` row (source = ' +
        'vercel, signalsJson, fetchedAt) via a real repository (4-layer, write ' +
        'requires `tx`). The viewer-facing read hits the cache, NOT Vercel — ' +
        'so N viewers ≠ N provider calls (the at-scale + rate-limit rule).\n' +
        '- **Gated.** The service is only reachable through the 10.1.3 ' +
        'platform-staff surface; this card adds the Vercel slice, not a new ' +
        'public route.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `vercelClient` lists deployments + reads function metrics READ-only ' +
        '(no mutating call anywhere), auth’d by the server-side token + team ' +
        'scope, with X-RateLimit backoff; it is `server-only` (importing it ' +
        'from a client component is a build error).\n' +
        '- `opsMonitoringService` derives the Vercel health DTO (latest deploy ' +
        'state, recent error/cancel/OOM counts, fn error-rate + traffic, the ' +
        'per-deploy `inspectorUrl` link-outs) and applies the configured ' +
        'thresholds.\n' +
        '- The poll-to-cache scheduled read writes a `MonitoringSnapshot` ' +
        '(source vercel) via a real repository (4-layer, write takes `tx`); ' +
        'the viewer read hits the cache, not Vercel.\n' +
        '- When Vercel is unreachable / the token is bad, the service returns ' +
        'a typed “provider unavailable” signal (the panel renders the ' +
        'error/retry state, not a misleading green) — it does NOT throw the ' +
        'whole board down.\n' +
        '- No `motir-ai` import; no provider token in any client bundle; ' +
        '4-layer respected for the cache.\n\n' +
        '## Context refs\n\n' +
        '- 10.2.2 — the Vercel signal inventory + thresholds + poll-to-cache ' +
        'cadence + the rate-limit/backoff rule.\n' +
        '- 10.2.3 — the `VERCEL_MONITORING_TOKEN` + `VERCEL_TEAM_ID` it ' +
        'consumes.\n' +
        '- 10.1.3 — the platform-staff gating + the audited cross-tenant read ' +
        'surface this slice plugs into.\n' +
        '- `motir-core/lib/email.ts` — the server-only leaf-client pattern to ' +
        'mirror; `lib/jobs/registry.ts` — the 1.6 cron substrate the ' +
        'poll-to-cache read rides.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer (for the cache repo/service).\n' +
        '- Vercel docs: REST API › list-deployments; Observability; Query › ' +
        'Monitoring.',
      dependsOn: ['10.2.2', '10.1.3'],
    },
    {
      id: '10.2.5',
      title:
        'Inngest integration (read-only) — job runs / failures / throughput / backlog (the 1.6 pipeline health)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'The motir-core server-side client + service that READ the Inngest ' +
        'pipeline-health signals (the 1.6/Inngest job substrate’s health) and ' +
        'map them to the ops-health DTOs. Read-only: list/get only — never a ' +
        'mutating call (no replay from Motir; replay is a link-out to the ' +
        'Inngest dashboard).\n\n' +
        '**Same read-through shape as 10.2.4.** A server-only leaf client + ' +
        'the Inngest slice of `opsMonitoringService`, riding the SAME ' +
        '`MonitoringSnapshot` poll-to-cache (source = inngest) so a page load ' +
        'reads the cache, not the Inngest API.\n\n' +
        '- **`lib/ops/inngestClient.ts`** — a server-only leaf client: reads ' +
        'run status / function-run lists via the Inngest REST API ' +
        '(`api.inngest.com/v1/events/:id/runs` + the v2 ' +
        '“Get function run” / “List event function runs” endpoints, ' +
        'signing-key auth). Surfaces: Function Status (runs grouped by ' +
        'succeeded / failed / cancelled), the top failing functions + failure ' +
        'frequency, Total-runs throughput, the backlog (waiting runs), and the ' +
        'retries / failed-after-retries signal. `import "server-only"`.\n' +
        '- **`opsMonitoringService` (the Inngest slice)** — derives the ' +
        'Inngest health DTO (status counts, the failed-functions set with the ' +
        'link-out to the Inngest function page, throughput, backlog, the ' +
        'failed-after-retries count as the “dead-letter” equivalent), applies ' +
        'the 10.2.2 thresholds. RECORD in code comments + the DTO naming that ' +
        'Inngest has NO literal DLQ — the failed-after-4-retries set + replay ' +
        'is the model, so Motir shows the failed set + a replay LINK-OUT, ' +
        'never a drain action.\n' +
        '- **Poll-to-cache** — the scheduled read (10.2.4’s substrate) also ' +
        'fetches Inngest + upserts the `MonitoringSnapshot` (source inngest). ' +
        'NOTE the benign recursion: the read of Inngest’s health is scheduled ' +
        'ON Inngest — acceptable because the read is independent of pipeline ' +
        'throughput (and if Inngest is fully down, the snapshot simply staleness-' +
        'flags, which is itself the “Inngest unreachable” signal).\n' +
        '- **Gated** through the 10.1.3 surface.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `inngestClient` reads run status / function-run lists READ-only ' +
        '(no mutating call), signing-key auth’d, server-only; it surfaces ' +
        'Function Status counts, top failed functions + frequency, throughput, ' +
        'backlog, and the failed-after-retries signal.\n' +
        '- The Inngest health DTO carries the failed set with a link-out to ' +
        'the Inngest function page (for replay) and NAMES the no-DLQ/replay ' +
        'model (no drain action in Motir).\n' +
        '- The Inngest signals ride the SAME `MonitoringSnapshot` ' +
        'poll-to-cache (source inngest); the viewer read hits the cache; ' +
        'Inngest-unreachable flags the snapshot stale (the panel shows the ' +
        '“can’t reach Inngest” state, the other panels still render).\n' +
        '- No mutating call; no token in a client bundle; 4-layer for the ' +
        'cache; the slice is reachable only through the 10.1.3 staff surface.\n\n' +
        '## Context refs\n\n' +
        '- 10.2.2 — the Inngest signal inventory (status / failed / throughput ' +
        '/ backlog / retries) + the no-DLQ/replay record + thresholds.\n' +
        '- 10.2.3 — the `INNGEST_SIGNING_KEY` / read key it consumes.\n' +
        '- 10.2.4 — the shared `MonitoringSnapshot` poll-to-cache + the ' +
        'server-only leaf-client pattern this mirrors.\n' +
        '- 10.1.3 — the platform-staff gating it plugs into.\n' +
        '- `lib/jobs/registry.ts` — the 1.6 Inngest substrate whose health ' +
        'this reads (and on which the poll-to-cache read is scheduled).\n' +
        '- Inngest docs: Observability & Metrics; Inspecting a Function run; ' +
        'Retries; Fetch run status and output; the REST run endpoints ' +
        '(api-docs.inngest.com).',
      dependsOn: ['10.2.2', '10.1.3'],
    },
    {
      id: '10.2.6',
      title: 'The 9.0 gateway + DB health panels + alert thresholds',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'The motir-core-INTERNAL health signals (no external provider) + the ' +
        'shared THRESHOLD module that turns every signal (Vercel, Inngest, ' +
        'gateway, DB) into a health band (healthy / degraded / critical). This ' +
        'card completes the signal set and centralizes the alerting logic.\n\n' +
        '- **9.0 gateway health.** Read the 9.0 AI gateway’s per-run metering ' +
        '(latency + error-rate over a recent window) and derive a gateway ' +
        'health DTO. This is motir-core-internal (the gateway’s own ' +
        'operational signals / metering store) — a real repository + service ' +
        'read (4-layer), NOT an external API. If 9.0’s metering is in ' +
        'motir-ai, read it over the 7.1 boundary (the read-through pattern); ' +
        'otherwise read the local gateway metrics.\n' +
        '- **DB health.** Reachability + latency + pool health: a lightweight ' +
        'probe (a cheap `SELECT 1` round-trip timing + pool stats) exposed as ' +
        'a DB health DTO through a service. Degrade-safe: a failed probe IS ' +
        'the “DB down” signal, not an unhandled throw.\n' +
        '- **The threshold module** (`lib/ops/thresholds.ts`) — a pure, ' +
        'directly-testable function set: `bandFor(signalKey, value)` → ' +
        '`healthy | degraded | critical`, driven by the 10.2.2 config ' +
        '(default thresholds, tunable without a code change). EVERY panel ' +
        '(Vercel 10.2.4, Inngest 10.2.5, gateway, DB) routes its headline ' +
        'value through this — one source of alerting truth, so the badge logic ' +
        'is consistent + unit-testable in isolation. Threshold breaches ' +
        'produce an in-console ALERT badge (warning / critical); routing the ' +
        'alert to a pager / email is a future 10.x (named in the header), NOT ' +
        'this card.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A gateway health DTO (latency + error-rate over a recent window) is ' +
        'derived from the 9.0 metering (local read, or over the 7.1 boundary ' +
        'if the metering lives in motir-ai) — no new external provider.\n' +
        '- A DB health DTO (reachability + latency + pool) comes from a ' +
        'lightweight probe through a service; a failed probe yields the “DB ' +
        'down” signal (degrade-safe, no unhandled throw).\n' +
        '- `lib/ops/thresholds.ts` exposes a pure `bandFor(signalKey, value)` ' +
        'driven by the 10.2.2 config; Vercel / Inngest / gateway / DB signals ' +
        'all route through it; a breach produces a warning/critical badge.\n' +
        '- The thresholds are config (tunable without a code change), and the ' +
        'band function is directly unit-tested (10.2.8) at each band incl. the ' +
        'boundary.\n' +
        '- 4-layer respected for the gateway + DB reads; no pager/email ' +
        'routing here (future 10.x).\n\n' +
        '## Context refs\n\n' +
        '- 10.2.2 — the threshold model + the default bands this implements + ' +
        'the gateway/DB signal definitions.\n' +
        '- 10.2.4 / 10.2.5 — the Vercel + Inngest signals that also route ' +
        'through this threshold module.\n' +
        '- 9.0 (stub) — the gateway metering the gateway-health read consumes ' +
        '(local or over the 7.1 boundary).\n' +
        '- `motir-core/lib/db.ts` — the Prisma singleton the DB probe times ' +
        '(through a repository, per 4-layer).\n' +
        '- `motir-core/CLAUDE.md` § 4-layer.',
      dependsOn: ['10.2.4', '10.2.5'],
    },
    {
      id: '10.2.7',
      title: 'The monitoring UI — the ops health view (panels + link-outs)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'The motir-core ops-health VIEW: the route + the UI that render the ' +
        '10.2.1 design from the 10.2.4 / 10.2.5 / 10.2.6 signals — the single ' +
        'operator pane (Vercel + Inngest + gateway + DB), each panel a health ' +
        'signal + threshold badge + a LINK-OUT to the native dashboard. No ' +
        'remediation control (read-only); no rebuilt trace/log/run UI.\n\n' +
        '**4-layer (motir-core/CLAUDE.md).**\n\n' +
        '- **`GET /api/admin/ops-health`** (platform-staff-gated via 10.1.3 — ' +
        'NOT a tenant session; the superadmin gate) — the route parses + calls ' +
        'ONE `opsMonitoringService` method that returns the assembled ' +
        'ops-health DTO (the per-source panels + their bands + link-outs), ' +
        'reading the `MonitoringSnapshot` cache (never N live provider calls ' +
        'per request). A non-staff caller is denied (404-not-403, the standing ' +
        'guard inherited from 10.1.3).\n' +
        '- **The UI** (renders 10.2.1 verbatim) — the ops-health page under ' +
        'the 10.1.3 `/admin` surface: the health board overview, the Vercel ' +
        'deploy panel (recent deploys paginated/capped + per-row ' +
        '`inspectorUrl` link-outs), the Inngest job panel (status / failed / ' +
        'throughput / backlog + the failed-set link-out to the Inngest ' +
        'function page), the gateway + DB panels with threshold badges, and ' +
        'the empty / loading / partial-failure states (one provider down ≠ a ' +
        'blank or all-green board). References ONLY `--el-*` colour + ' +
        '`[data-display-style]` shape tokens; uses the palette (status ' +
        'colours via `--el-success` / `--el-warning` / `--el-danger`, not ' +
        'grey-only — finding #54); a `--el-warning` / `--el-danger` tint ' +
        'BANNER for a breach (not a page-level tinted surface — finding #35); ' +
        'an `aria-live` region for the loading→loaded + the threshold-breach ' +
        'transitions; i18n via a new `opsHealth` namespace (the app’s locale ' +
        'set). Every link-out opens the native dashboard (new tab, ' +
        'rel=noopener).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `GET /api/admin/ops-health` is platform-staff-gated (10.1.3; ' +
        'non-staff → 404), reads the snapshot cache (no N-live-calls per ' +
        'request), and returns the assembled per-source panel DTO via ONE ' +
        'service method (4-layer; no provider client in the route).\n' +
        '- The view renders the 10.2.1 panels with `--el-*` tokens only; each ' +
        'source panel shows a health status + threshold badge + a “view in ' +
        '<provider> ↗” link-out; the recent-deploys + failed-runs lists ' +
        'paginate/cap (at-scale).\n' +
        '- There is NO remediation control (no redeploy / cancel / replay) and ' +
        'NO rebuilt trace/log/run UI — deep dive is the link-out only.\n' +
        '- The partial-failure state renders (a down provider shows ' +
        'error/retry; the rest of the board still renders); the breach uses a ' +
        'tint banner (finding #35); the palette is used (finding #54); an ' +
        '`aria-live` region announces the load + breach transitions.\n' +
        '- 4-layer respected (route → service → the 10.2.4/10.2.5 clients via ' +
        'the cache; no client component touches the service directly); the ' +
        'view lives under the 10.1.3 `/admin` surface.\n\n' +
        '## Context refs\n\n' +
        '- 10.2.1 — the design asset (the panels this implements verbatim).\n' +
        '- 10.2.4 / 10.2.5 / 10.2.6 — the Vercel / Inngest / gateway+DB signal ' +
        'DTOs + the threshold bands this renders.\n' +
        '- 10.1.3 — the platform-staff `/admin` surface + the gating this view ' +
        'lives under (404-not-403 for non-staff).\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § colour/shape tokens.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` (incl. success / ' +
        'warning / danger) + shape tokens.',
      dependsOn: ['10.2.1', '10.2.4', '10.2.5'],
    },
    {
      id: '10.2.8',
      title:
        'Vitest — the integrations (mocked external APIs) + the threshold logic + staff-gating',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'Lock the monitoring integrations + the threshold logic with tests. ' +
        'motir-core tests run over a real Postgres (the project convention; ' +
        'the only allowed `vi.mock` is `getSession()`), but the EXTERNAL ' +
        'provider APIs (Vercel, Inngest) are mocked at the client boundary ' +
        'with RECORDED fixtures (no live provider call in CI) — the ' +
        'signal→DTO mapping, the snapshot cache, the threshold bands, and the ' +
        'gating are exercised for real.\n\n' +
        '**Vercel integration (10.2.4):**\n\n' +
        '- Given a recorded `GET /v7/deployments` fixture (a healthy READY ' +
        'prod deploy; an ERROR deploy with `errorCode`/`errorMessage`; an ' +
        '`oomReport` deploy), the service derives the right Vercel health DTO ' +
        '(latest state, recent error/cancel/OOM counts, the per-deploy ' +
        '`inspectorUrl` link-outs).\n' +
        '- A function-metrics fixture yields the right error-rate + traffic ' +
        'signal.\n' +
        '- A provider 5xx / a bad-token response yields the typed ' +
        '“unavailable” signal (NOT a throw that blanks the board); the ' +
        'rate-limit backoff path is exercised.\n' +
        '- The poll-to-cache read upserts a `MonitoringSnapshot` (source ' +
        'vercel) and the viewer read returns the cached signals (no second ' +
        'provider call).\n\n' +
        '**Inngest integration (10.2.5):**\n\n' +
        '- Given a recorded run-set fixture (succeeded / failed / cancelled ' +
        'counts; top failing functions; a backlog; a failed-after-retries ' +
        'set), the service derives the Inngest health DTO with the right ' +
        'status counts, the failed set + the Inngest-function link-out, ' +
        'throughput, and the failed-after-retries (“dead-letter equivalent”) ' +
        'count.\n' +
        '- Inngest-unreachable flags the snapshot stale → the “can’t reach ' +
        'Inngest” signal (degrade-safe).\n\n' +
        '**Thresholds (10.2.6):**\n\n' +
        '- `bandFor(signalKey, value)` returns `healthy | degraded | ' +
        'critical` for a fixture table per signal, INCLUDING the band ' +
        'boundary (the exact threshold value), and is driven by config (a ' +
        'changed threshold changes the band without a code change). The ' +
        'gateway + DB health DTOs route through it correctly.\n\n' +
        '**Gating (10.2.7 / 10.1.3):**\n\n' +
        '- `GET /api/admin/ops-health` returns the assembled DTO for a ' +
        'platform-staff session; a NON-staff session is denied (404), proving ' +
        'the 10.1.3 gate holds on this route.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The above cases pass over real Postgres (only `getSession()` ' +
        'mocked; the Vercel + Inngest clients stubbed at their boundary with ' +
        'recorded fixtures — no live provider call).\n' +
        '- The threshold band function is asserted against a fixture table ' +
        'incl. each boundary; the provider-unavailable paths are proven ' +
        'degrade-safe (a down provider does not blank the board).\n' +
        '- The staff-gating is proven (non-staff → 404) on the ops-health ' +
        'route.\n' +
        '- New motir-core service code respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage); the threshold branches + the ' +
        'provider-unavailable guards each have a direct test.\n\n' +
        '## Context refs\n\n' +
        '- 10.2.4 / 10.2.5 / 10.2.6 / 10.2.7 (everything under test).\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + § coverage ' +
        'gate.\n' +
        '- 10.1.3 — the staff-gating asserted on the ops-health route.',
      dependsOn: ['10.2.4', '10.2.5'],
    },
  ],
};
