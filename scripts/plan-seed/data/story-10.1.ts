import type { PlanStory } from '../types';

/**
 * Story 10.1 — Superadmin console + platform overview + usage/cost rollups.
 * THE foundation of **Epic 10 (NEW: Platform administration & operations)** —
 * the Motir-INTERNAL operator console the platform staff (not customers) use to
 * SEE the whole estate: every org / workspace / project / user across all
 * tenants, plus the usage + cost rollups that aggregate 7.12's planning metering
 * and 9.0's coding-gateway spend per project → workspace → org → platform. Every
 * later Epic-10 story (10.2 monitoring, 10.3 credit/governance ops) rides the
 * platform-staff auth + the audited cross-tenant read access this story stands
 * up.
 *
 * **This is a DIFFERENT kind of admin from everything before it.** Up to Epic 9,
 * every "admin" surface in Motir is TENANT admin — a workspace owner managing
 * their own workspace (6.4 roles), an org owner managing their own org (6.10). The
 * 6.4 `MemberRole` and the 6.10 org owner/admin role are CUSTOMER roles, scoped to
 * ONE tenant, and the 404-not-403 cross-tenant guard is the load-bearing
 * isolation rule everywhere. 10.1 introduces the FIRST surface that deliberately
 * reads ACROSS that boundary — the Motir operator looking at all customers at
 * once — so it MUST be a separate, deliberately-controlled concept, never an
 * elevation of a tenant role.
 *
 * **The platform-staff auth model (the keystone, locked here as the contract
 * every Epic-10 story inherits).** A SUPERADMIN / platform-staff capability is a
 * concept SEPARATE from tenant `MemberRole` and the 6.10 org roles — a flag /
 * `PlatformRole` on the `User` (Motir employees only), checked by a dedicated
 * gate that is NOT reachable by any tenant-role escalation. The cross-tenant
 * reads BYPASS the standard tenant scoping (the operator legitimately sees other
 * tenants' data) but are FULLY AUDITED: every cross-tenant read records who read
 * what, when. This is the "highly controlled super-admin" exception the
 * multi-tenant-RBAC literature explicitly carves out — the verified security
 * posture (cited in 10.1.2): a good multi-tenant model has NO global roles that
 * bypass tenant isolation EXCEPT a small, audited platform-staff set, and admin
 * actions / cross-tenant access are logged centrally for SOC-2-style evidence.
 *
 * **The usage/cost rollups read PRE-AGGREGATED data, never scan-all (finding
 * #57).** The platform-overview + the usage views aggregate two metering spines —
 * 7.12's planning metering (`PlanningRun`/`PlanningTurn` + the credit ledger) and
 * 9.0's coding-gateway spend (the authoritative per-request provider `usage` the
 * 9.0.5 meter captures) — across the FULL estate, sliced per project → workspace
 * → org → platform, per-model, and by top consumers. At platform scale that is
 * billions of metering rows, so the rollup is computed from PRE-AGGREGATED
 * rollup tables (the monthly/daily aggregates 7.12 already maintains + a
 * platform-level rollup this story adds), NOT a live sweep of raw runs/turns on
 * every page load. This is the standard usage-metering shape (cited in 10.1.5):
 * raw events become unmanageable into the billions, so you store aggregations at
 * MULTIPLE hierarchy levels and query the rollup at the right granularity — the
 * "load all rows" full-table-scan is the prototype tell the at-scale rule
 * forbids.
 *
 * **The mirror — SaaS operator consoles (rung 1, cited not asserted, see
 * 10.1.1/10.1.2).** The verified shape is the internal operator/superadmin panel
 * the platform team uses to manage ALL tenants from one place: e.g. Supastarter's
 * super-admin panel (manage all tenants, subscriptions, teams), MSP-style
 * multi-tenant dashboards (view usage + run lifecycle actions across every
 * client from a single console), and the Stripe/Vercel-dashboard idiom of an
 * estate overview (counts + activity) drilling into a single account's usage,
 * deploys, and members. Motir mirrors that estate-overview → usage-rollup →
 * drill-down shape; the deep monitoring (10.2) + the credit/governance toolkit
 * (10.3) attach to the same console.
 *
 * **Where this lives — a gated `/admin` surface inside motir-core (decided in
 * 10.1.2).** The console is server-rendered motir-core pages under a
 * platform-staff-gated route segment (e.g. `/admin`), NOT a separate app — it
 * reuses motir-core's auth, shell, and design system, and the cross-tenant reads
 * go through new platform-scoped SERVICE methods that deliberately skip the
 * tenant filter (and audit) rather than through the normal tenant-scoped repos.
 * The usage rollups are READ over the 7.1 boundary from motir-ai (where the
 * 7.12 metering + 9.0 gateway spend live) — motir-core never holds the metering;
 * it reads the pre-aggregated platform rollup the same open-core way 7.12.5 reads
 * a single tenant's balance.
 *
 * **What 10.1 is and is NOT.** 10.1 ships the console FOUNDATION: the
 * platform-staff auth + the gated surface + the audited cross-tenant read access
 * (10.1.3), the estate OVERVIEW (counts + activity, rolled up — 10.1.4), the
 * usage/cost ROLLUPS (7.12 + 9.0 spend per project→workspace→org→platform +
 * per-model + top consumers, pre-aggregated — 10.1.5), and the DRILL-DOWN
 * (org/workspace/project detail — 10.1.6). It is NOT the deep system monitoring
 * (Vercel/Inngest health — **Story 10.2**) nor the credit/account governance
 * TOOLKIT (grants, suspend, impersonation, feature flags, the admin audit-log
 * VIEW — **Story 10.3**); those are read-write operator ACTIONS + observability
 * that build on 10.1's auth + console shell. 10.1 is read-mostly (the only writes
 * are audit-log appends) — the operator can SEE the estate; ACTING on it is 10.3.
 *
 * **Cross-story dep audit (notes.html #32): PASSES — no forward-pointing deps.**
 * Every 10.1 leaf depends only on backward/sideways ids whose story number is ≤
 * 10.1: same-story 10.1.x cards (incl. the design gate 10.1.1 it ships itself),
 * 6.10.3 (the `Organization` model + `Workspace.organizationId` the rollup
 * hierarchy and the overview counts read — Epic 6 < 10), 7.12.2 (the planning
 * metering store the usage rollup aggregates — Epic 7 < 10), and 9.0.5 (the
 * authoritative gateway spend meter the cost rollup aggregates — Epic 9 < 10).
 * No dep points forward to 10.2 / 10.3 or beyond. Statuses follow the rule:
 * 10.1.1 (design, `dependsOn: []`) and 10.1.2 (decision, `dependsOn: []`) are
 * `planned`; everything chained behind them or behind any not-yet-done upstream
 * id (6.10.3 / 7.12.2 / 9.0.5 / 10.1.x) is `blocked`.
 *
 * **The design gate fires (Principle #13).** 10.1 ships a real user-facing
 * surface — the operator console (overview + rollup views + drill-down). So the
 * FIRST subtask (10.1.1) is a `design` card producing
 * `design/platform-admin/*.mock.html` + `design-notes.md`, and every UI-touching
 * code subtask (10.1.4 / 10.1.5 / 10.1.6) depends on it and is `blocked` behind
 * it. Stories 10.2 + 10.3 reuse the SAME `design/platform-admin/` area (their
 * skeletons say so), so 10.1.1 also establishes the console's shell language they
 * extend.
 *
 * **Deferred future 10.x (named so they're visibly deferred, not forgotten —
 * mirrors 10.3's named-deferral discipline):** a real-time platform activity
 * feed / global search across tenants; per-region / per-shard estate breakdowns
 * once Motir is multi-region; an exportable platform-usage report (CSV/scheduled)
 * for finance; SLA / per-tenant-health scoring on the overview. These attach to
 * this console later; 10.1 ships the estate overview + usage rollups + drill-down
 * they grow from.
 */
export const story_10_1: PlanStory = {
  id: '10.1',
  title: 'Superadmin console + platform overview + usage/cost rollups',
  status: 'planned',
  gitBranch: 'feat/PROD-10.1-superadmin-console',
  descriptionMd:
    'The Motir-INTERNAL operator console — the gated `/admin` surface platform ' +
    'staff (NOT customers) use to see the whole estate across every tenant: the ' +
    'orgs / workspaces / projects / users overview (counts + activity) and the ' +
    'usage + cost ROLLUPS that aggregate **7.12 planning metering** + **9.0 ' +
    'coding-gateway spend** per project → workspace → org → platform, per-model, ' +
    'and by top consumers — with drill-down into a single org/workspace/project. ' +
    'It is the FOUNDATION of **Epic 10**: the platform-staff auth + the audited ' +
    'cross-tenant read access every later Epic-10 story (10.2 monitoring, 10.3 ' +
    'credit/governance ops) rides.\n\n' +
    '**The platform-staff model (locked — see the module header for the full ' +
    'rationale + the cited security posture):**\n\n' +
    '- **Superadmin is a SEPARATE concept from tenant `MemberRole`** (and from ' +
    'the 6.10 org owner/admin role): a `PlatformRole` / flag on the `User` for ' +
    'Motir employees only, gated by a dedicated check NOT reachable by any ' +
    'tenant-role escalation. This is the "highly controlled super-admin" the ' +
    'multi-tenant-RBAC literature carves out — the ONLY role that legitimately ' +
    'crosses the tenant boundary.\n' +
    '- **Cross-tenant reads BYPASS tenant scoping but are FULLY AUDITED.** The ' +
    'operator legitimately sees other tenants’ data; every cross-tenant ' +
    'read records who read what, when (the central admin-action log, SOC-2-style ' +
    'evidence). The 404-not-403 tenant guard everywhere else stays intact — only ' +
    'platform-scoped service methods skip it, and only those, and they audit.\n' +
    '- **The rollups read PRE-AGGREGATED data, never scan-all (finding #57).** ' +
    'At platform scale (billions of metering rows) the usage/cost views compute ' +
    'from rollup tables — 7.12’s monthly aggregates + a platform-level ' +
    'rollup this story adds — NOT a live sweep of raw `PlanningRun`/`PlanningTurn` ' +
    '+ gateway-usage rows on every page load. Aggregations are stored at MULTIPLE ' +
    'hierarchy levels (project/workspace/org/platform) and queried at the right ' +
    'granularity (the at-scale rule).\n' +
    '- **It lives in a gated `/admin` segment inside motir-core**, reusing its ' +
    'auth + shell + design system; the metering is READ over the 7.1 boundary ' +
    'from motir-ai (where 7.12 + 9.0 spend live) — motir-core never holds the ' +
    'metering, the open-core way 7.12.5 reads a single tenant’s balance.\n\n' +
    '**Scope:** the console design (overview + rollup views + drill-down) ' +
    '(10.1.1); the platform-staff auth model decision (10.1.2); the platform-' +
    'staff auth + the gated admin surface + the audited cross-tenant read access ' +
    '(10.1.3); the estate overview (counts + activity, rolled up) (10.1.4); the ' +
    'usage/cost rollups (7.12 + 9.0 spend per project→workspace→org→platform + ' +
    'per-model + top consumers, pre-aggregated) (10.1.5); the drill-down ' +
    '(org/workspace/project detail) (10.1.6); vitest — cross-tenant gating + ' +
    'rollup math (10.1.7); and the e2e — staff sees it, a normal user is denied ' +
    '(10.1.8).\n\n' +
    '**Out of scope (named so they land in their own story, not here):** the ' +
    'deep system MONITORING (Vercel deploys / Inngest job health / DB health — ' +
    '**Story 10.2**); the credit/account governance TOOLKIT (credit grants, plan/' +
    'tier assignment, org suspend, support impersonation, feature flags, the ' +
    'admin audit-log VIEW — **Story 10.3**). 10.1 is read-mostly (its only writes ' +
    'are audit-log appends): the operator SEES the estate; ACTING on it is 10.3. ' +
    'Also deferred (named in the header): a global activity feed / cross-tenant ' +
    'search, per-region breakdowns, an exportable usage report, per-tenant SLA ' +
    'scoring.',
  verificationRecipeMd:
    '- Pull the Story branch; bring up motir-core on `:3000` + motir-ai on its ' +
    'dev port (each pointed at the other), with at least one org spanning ' +
    'multiple workspaces/projects seeded (6.10 backfill) and some planning + ' +
    'gateway metering present (7.12 + 9.0 runs — the 7.1.7 `noop` and a gateway ' +
    'request are enough to populate the rollup).\n' +
    '- **Platform-staff gating (the security boundary).** As a NORMAL user ' +
    '(any tenant role, even a workspace/org owner), navigate to `/admin` → you ' +
    'are DENIED (404, not 403 — the surface does not exist for you). Flip a test ' +
    'user’s `PlatformRole`/flag to platform-staff → `/admin` now loads. ' +
    'Confirm NO tenant role (owner/admin) grants access — only the platform flag ' +
    'does.\n' +
    '- **The estate overview (rolled up, not scan-all).** The overview shows ' +
    'estate counts (orgs / workspaces / projects / users) + recent activity, ' +
    'fetched from rollups/covered queries — confirm (via query logs / EXPLAIN or ' +
    'the code) that rendering the overview does NOT sweep every work-item or ' +
    'metering row; it reads counts + a paginated activity slice.\n' +
    '- **The usage/cost rollups (7.12 + 9.0, per the hierarchy).** Open the ' +
    'usage view: it shows spend rolled up per project → workspace → org → ' +
    'platform, a per-MODEL breakdown, and a top-consumers list — aggregating ' +
    'BOTH the 7.12 planning metering AND the 9.0 gateway spend. Confirm the ' +
    'platform total equals the sum of its orgs, an org equals the sum of its ' +
    'workspaces, and a workspace the sum of its projects (the rollup is ' +
    'internally consistent), and that the view reads PRE-AGGREGATED rollups ' +
    '(not a live full-table sweep — finding #57).\n' +
    '- **Drill-down.** From an org row, drill into the org → its workspaces / ' +
    'projects, that org’s usage, recent jobs, members, and status. From a ' +
    'project, drill to the project detail. The drill-down reads cross-tenant ' +
    '(the operator sees a tenant they don’t belong to) — and EACH such read ' +
    'is recorded in the cross-tenant access audit (confirm a row appears: actor, ' +
    'target tenant, what, when).\n' +
    '- **Audit of cross-tenant reads.** Perform a few drill-downs as ' +
    'platform-staff, then confirm the audit log captured each cross-tenant read ' +
    '(this is the read-audit; the read-WRITE governance actions + the audit-log ' +
    'VIEW are 10.3 — here we only verify the read audit is being WRITTEN).\n' +
    '- `pnpm test` (motir-core) + the motir-ai suite — 10.1.7 covers the ' +
    'cross-tenant read GATING (a non-staff principal is blocked from every ' +
    'platform-scoped service method; only the platform flag passes) and the ' +
    'ROLLUP MATH (platform = Σ orgs = ΣΣ workspaces = ΣΣΣ projects; per-model ' +
    'splits sum to the total; the pre-aggregated rollup matches a summed ' +
    'fixture).\n' +
    '- **Open-core boundary review (this Epic’s recurring posture).** No ' +
    '`motir-ai` import in `motir-core` (the metering is read over the 7.1 ' +
    'boundary, HTTP only); the platform rollup of 7.12 + 9.0 spend lives in ' +
    'motir-ai’s DB and motir-core reads the pre-aggregated result; browsers ' +
    'never call motir-ai; the `/admin` surface is server-gated (the platform ' +
    'check runs server-side, never trusted from the client).\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up ' +
    'Subtask under the same Story.',
  items: [
    {
      id: '10.1.1',
      title:
        'Design — the platform admin console: estate overview + usage/cost rollup views + drill-down',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        '**Type:** design (the planning-time design gate, Principle #13 + the ' +
        'design-reference rule). The overview (10.1.4), the usage/cost rollups ' +
        '(10.1.5), and the drill-down (10.1.6) all depend on this card; without ' +
        'it the operator console would be improvised, which is forbidden ' +
        '(notes.html #31). This card ALSO establishes the `design/platform-admin/` ' +
        'shell language that Stories 10.2 (monitoring) + 10.3 (governance ' +
        'toolkit) extend (their skeletons reuse this area).\n\n' +
        'Produce the design asset for the **platform admin console** under ' +
        '`motir-core/design/platform-admin/`. Author it as a **`*.mock.html` ' +
        'mockup** built from the real design system (the shipped ' +
        '`components/ui/*` primitives + the `--el-*` colour tokens + the ' +
        '`[data-display-style]` shape tokens) — NOT a `.pen`. The HTML route is ' +
        'preferred when a coding agent produces the design (no translation gap; ' +
        'the reviewer sees the actual tokens). A PNG export is optional; the ' +
        '`.mock.html` is the source of truth (MOTIR.md § Design-reference ' +
        'rule).\n\n' +
        '**This is an INTERNAL operator console, not a customer surface — but it ' +
        'still uses the Motir design system.** It is gated to platform staff, so ' +
        'it may read denser / more table-heavy than a customer screen (an ' +
        'operator scanning the whole estate), but it composes the SAME shipped ' +
        'primitives + tokens (no bespoke admin CSS). Draw it so it is legibly ' +
        '"the operator view," visually distinct from a tenant view (e.g. an ' +
        '`--el-info`-tinted "Platform staff" context banner so an operator never ' +
        'confuses it with a customer tenant), without inventing new primitives.\n\n' +
        '**Mirror (cited — SaaS operator consoles).** The verified shape is the ' +
        'internal superadmin panel managing ALL tenants from one place: ' +
        'Supastarter’s super-admin panel (manage all tenants / subscriptions ' +
        '/ teams), MSP-style multi-tenant dashboards (view usage + drill into any ' +
        'client from one console), and the Stripe/Vercel-dashboard idiom (an ' +
        'estate overview of counts + activity that drills into a single ' +
        'account’s usage / members / status). Draw THAT: overview → ' +
        'usage-rollup → drill-down.\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the multi-panel ' +
        'rule, mistake #31):\n\n' +
        '- **Panel 1 — the estate OVERVIEW (populated).** The platform-staff ' +
        'context banner + the estate counts (orgs / workspaces / projects / ' +
        'users) as a small set of stat `Card`s, plus a recent-activity feed ' +
        '(new orgs/workspaces, recent planning/coding jobs) shown PAGINATED ' +
        '(an at-scale activity slice, not "load all" — finding #57). Use the ' +
        'palette (per-entity tints, not grey-only — finding #54).\n' +
        '- **Panel 2 — the usage/cost ROLLUP (the hierarchy).** A table/treemap ' +
        'of spend rolled up per project → workspace → org → platform, with the ' +
        'platform total as the hero and an expandable hierarchy beneath it. Show ' +
        'usage as both the metered tokens/credits AND a clear per-LEVEL total, so ' +
        'an operator sees which org/workspace is the big consumer. Plan for SCALE ' +
        '(hundreds of orgs → the list paginates / virtualizes; the rollup is ' +
        'pre-aggregated, so the table never implies a full scan).\n' +
        '- **Panel 3 — the per-MODEL breakdown + TOP CONSUMERS.** A per-model ' +
        'usage table (planning Claude models + the 9.0 gateway models) — tokens ' +
        '/ credits / $-equivalent per model — and a "top consumers" leaderboard ' +
        '(the N orgs/workspaces draining the most), each row a drill-in target. ' +
        'Per-model tint via `--el-*` (a costlier model visibly the bigger ' +
        'drain), not grey-only.\n' +
        '- **Panel 4 — the DRILL-DOWN detail (org/workspace/project).** The ' +
        'single-tenant detail an operator drills into: that tenant’s usage ' +
        'over time, its recent jobs (planning + coding), its members, and its ' +
        'status — with a CLEAR "you are viewing another tenant’s data ' +
        '(audited)" affordance (the cross-tenant-read-is-audited posture made ' +
        'visible). The recent-jobs list paginates.\n' +
        '- **Panel 5 — gating, empty, loading + error states.** The ' +
        'access-DENIED state a non-staff user would (not) see — drawn so the ' +
        'reviewer understands `/admin` is a 404 for non-staff, NOT a visible ' +
        '"forbidden" page (the surface does not exist for them); the first-run ' +
        'empty state (no usage yet); the loading skeleton while the rollup ' +
        'fetches over 7.1; and the fetch-failed state (motir-ai down → retry, ' +
        'not a misleading zero).\n\n' +
        'Also write **`design/platform-admin/design-notes.md`** naming the exact ' +
        'primitives used per surface, the exact copy strings, the placement ' +
        'decisions, the per-`--el-*` colour role for each element (incl. the ' +
        '`--el-info` platform-staff banner role + the per-model / per-entity tint ' +
        'roles), and a "primitives composed (no hand-rolling)" checklist (the ' +
        '`design-notes.md` convention 1.3.3 / 1.5.1 / 7.0.1 established). It MUST ' +
        'state, in writing, that this is the SHARED `platform-admin` shell ' +
        'Stories 10.2 (monitoring panels) + 10.3 (governance toolkit) extend, and ' +
        'that 10.1 is read-mostly (the governance ACTIONS are 10.3).\n\n' +
        '**Branch.** `design/PROD-10.1.1-platform-admin-console`. The `design/*` ' +
        'prefix gate skips CI E2E + the Vercel preview deploy (MOTIR.md ' +
        '§ Plan-seed Workflow) — this PR only edits `design/platform-admin/' +
        '**`, no app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/platform-admin/console.mock.html` exists, renders ' +
        'the five panels above, and references ONLY `--el-*` tokens + ' +
        '`[data-display-style]` shape tokens (no Tier-0 `--color-*`, no ' +
        'hand-rolled spacing — the `motir-core/CLAUDE.md` § colour / shape ' +
        'rules).\n' +
        '- `motir-core/design/platform-admin/design-notes.md` exists, names every ' +
        'primitive composed + every copy string + the per-element `--el-*` role, ' +
        'and STATES that this is the shared shell 10.2 + 10.3 extend and that ' +
        'governance actions are 10.3.\n' +
        '- The usage/cost rollup is drawn AS A HIERARCHY (project → workspace → ' +
        'org → platform) with a per-model breakdown + a top-consumers list, all ' +
        'paginated/virtualized at scale (not load-all — finding #57).\n' +
        '- The platform-staff context banner + the "viewing another tenant ' +
        '(audited)" drill-down affordance are both drawn; the access-denied ' +
        'state is drawn as a 404 (surface absent), not a visible forbidden page.\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Pill`, ' +
        '`Button`, `EmptyState`, a table/list pattern, the skeleton/loader) — if ' +
        'a genuinely new primitive is needed, that is a NEW `design/` subtask, ' +
        'not a code workaround.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/ai-usage/` (7.12.1) — the closest existing usage-' +
        'display design (the per-model breakdown + the at-scale activity log ' +
        'shape to mirror, now at platform scope).\n' +
        '- `motir-core/design/ready/` (7.0.1) — the design-area + `design-notes.md` ' +
        'layout convention.\n' +
        '- `motir-core/components/ui/Card.tsx`, `Pill.tsx`, `Button.tsx`, ' +
        '`EmptyState.tsx` — the composable surface.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` colour (incl. `--el-info` ' +
        'for the staff banner) + `[data-display-style]` shape tokens.\n' +
        '- Stories 10.2 + 10.3 (skeletons) — the monitoring + governance surfaces ' +
        'that reuse this `platform-admin` shell.',
      dependsOn: [],
    },
    {
      id: '10.1.2',
      title:
        'Decision — the platform-staff auth model: `PlatformRole` separate from `MemberRole`, audited cross-tenant read, where `/admin` lives',
      status: 'planned',
      type: 'decision',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        '**Type:** decision (the keystone ADR every Epic-10 story builds ' +
        'against — the platform-staff auth model + the cross-tenant read ' +
        'posture). Produce a living ADR; no app behavior ships here, but the ' +
        'shapes it fixes are load-bearing for 10.1.3 + all of 10.2 / 10.3.\n\n' +
        'Write `motir-core/docs/adr/platform-staff-auth.md` (the authoritative ' +
        'decision). It MUST fix:\n\n' +
        '1. **Superadmin is SEPARATE from every tenant role.** Decide the ' +
        'representation — a `PlatformRole` enum / a boolean flag on the `User` ' +
        '(Motir employees only), distinct from tenant `MemberRole` (6.4) and the ' +
        '6.10 org owner/admin role. It MUST NOT be reachable by any tenant-role ' +
        'escalation (no "org owner ⇒ platform staff" path). Justify the choice ' +
        '(a `PlatformRole` enum if degrees of staff access are foreseen — e.g. ' +
        'read-only-staff vs full-ops for the 10.3 destructive actions — else a ' +
        'flag). Mirror the cited security posture: "no global roles that bypass ' +
        'tenant isolation EXCEPT a small, highly-controlled super-admin set."\n' +
        '2. **The console gate.** A dedicated server-side gate ' +
        '(`requirePlatformStaff()`) the `/admin` route segment + every ' +
        'platform-scoped service method calls — checked SERVER-side, never ' +
        'trusted from the client. A non-staff principal hitting `/admin` gets a ' +
        '404 (the surface does not exist for them — the 404-not-403 posture, ' +
        'extended: the admin area is invisible, not merely forbidden).\n' +
        '3. **Cross-tenant read access (the bypass + the audit).** Decide HOW the ' +
        'cross-tenant reads work: platform-scoped SERVICE methods that ' +
        'deliberately SKIP the tenant filter (reading across all tenants) — ' +
        'distinct from the normal tenant-scoped service paths, so the bypass is ' +
        'explicit and localized, never an accidental missing filter. EVERY ' +
        'cross-tenant read MUST be audited (actor, target tenant, what was read, ' +
        'when) — fix the audit-record shape here (the `PlatformAuditLog` row 10.3 ' +
        'also writes governance ACTIONS into). Cite the posture: admin actions + ' +
        'cross-tenant access logged centrally (SOC-2-style evidence).\n' +
        '4. **Where the admin app lives.** Decide: a gated `/admin` route segment ' +
        'INSIDE motir-core (recommended — reuses auth + shell + design system) ' +
        'vs a separate surface. Record the decision + why; if `/admin`, fix the ' +
        'segment + the layout-level gate placement.\n' +
        '5. **The read-over-7.1 posture for usage.** State that the usage/cost ' +
        'rollups are READ from motir-ai over the 7.1 boundary (where 7.12 + 9.0 ' +
        'spend live) — motir-core holds no metering; the platform console reads ' +
        'the pre-aggregated platform rollup the open-core way. (The platform ' +
        'rollup table itself + its aggregation job are 10.1.5’s build; this ' +
        'ADR only fixes that it is pre-aggregated + read over 7.1, finding #57.)\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/docs/adr/platform-staff-auth.md` exists and fixes all five ' +
        'sections with a concrete `PlatformRole`/flag shape, the ' +
        '`requirePlatformStaff()` gate contract, the cross-tenant-read service ' +
        'pattern + the `PlatformAuditLog` record shape, the `/admin` placement, ' +
        'and the read-over-7.1 posture.\n' +
        '- The separation from tenant `MemberRole` + the 6.10 org role is stated ' +
        'explicitly, with the "no tenant-role escalation path" invariant called ' +
        'out as load-bearing.\n' +
        '- The cited multi-tenant security posture (highly-controlled super-admin ' +
        'exception; central audit of admin actions / cross-tenant access) is ' +
        'referenced as the rationale, not asserted.\n' +
        '- It is stated that 10.1 is read-mostly (the only writes are audit ' +
        'appends) and that the governance ACTIONS (grants/suspend/impersonate/' +
        'flags) + the audit-log VIEW are Story 10.3, which reuses this same ' +
        'gate + `PlatformAuditLog`.\n\n' +
        '## Context refs\n\n' +
        '- This module header (the locked platform-staff model + the cited ' +
        'mirror/security posture).\n' +
        '- 6.4 (the tenant `MemberRole` this is SEPARATE from) + 6.10.x (the ' +
        '`Organization` + org owner/admin role it is ALSO separate from — the ' +
        'rollup hierarchy’s top tier).\n' +
        '- `motir-core/lib/auth/` — the Better-Auth session wiring the gate sits ' +
        'beside (the `User` the flag/role hangs off).\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + the 404-not-403 tenant guard ' +
        'this posture extends.\n' +
        '- Stories 10.2 + 10.3 (stubs) — the monitoring + governance ops that ' +
        'reuse this gate + the `PlatformAuditLog` shape.',
      dependsOn: [],
    },
    {
      id: '10.1.3',
      title:
        'Platform-staff auth + the gated `/admin` surface + the audited cross-tenant read access',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'Build the FOUNDATION the whole console (and all of 10.2 / 10.3) rides: ' +
        'the platform-staff auth, the gated `/admin` route segment, and the ' +
        'audited cross-tenant read PRIMITIVE — per the 10.1.2 ADR. No tenant data ' +
        'is shown yet (that is 10.1.4+); this card ships the gate + the bypass + ' +
        'the audit, proven by a trivial gated landing page.\n\n' +
        '**Platform-staff identity (schema + 4-layer).**\n\n' +
        '- Add the `PlatformRole`/flag to the `User` model (per 10.1.2 — e.g. a ' +
        '`platformRole` enum nullable column, default none), FK/enum-modelled per ' +
        'the CLAUDE.md schema rules; a migration runs clean. Seed at least one ' +
        'platform-staff user in `db:seed` (Motir’s own operator) so the ' +
        'console is reachable in dev.\n' +
        '- `requirePlatformStaff(session)` — a server-side gate (in ' +
        '`lib/auth/` / a `platformAuth` module) that returns the staff principal ' +
        'or throws a typed `NotPlatformStaffError`. It is the ONLY thing that ' +
        'grants `/admin`; no tenant role reaches it.\n\n' +
        '**The gated `/admin` segment.** A route segment `app/admin/` whose ' +
        'layout calls `requirePlatformStaff()` server-side and renders the ' +
        'console shell (the 10.1.1 platform-staff banner + nav). A non-staff ' +
        'principal → a 404 (the surface does not exist for them — NOT a visible ' +
        '403), per the ADR. The check is server-side only; nothing trusts a ' +
        'client claim.\n\n' +
        '**The audited cross-tenant read primitive (the load-bearing seam).** A ' +
        '`platformReadService` (the cross-tenant read authority) whose every ' +
        'method (a) requires the platform-staff principal, (b) reads ACROSS ' +
        'tenants via platform-scoped repository methods that deliberately SKIP ' +
        'the tenant filter, and (c) writes a `PlatformAuditLog` row (actor, ' +
        'targetTenant, action/what-read, at) for the cross-tenant read — in the ' +
        'SAME transaction as the read where the read is itself a query (or ' +
        'immediately after, for a pure read). The bypass is LOCALIZED here: ' +
        'normal services keep their 404-not-403 tenant scoping untouched; only ' +
        'this service crosses the boundary, and only it audits. Add the ' +
        '`PlatformAuditLog` model (the shape 10.3 also appends governance actions ' +
        'into), FK-modelled per CLAUDE.md.\n\n' +
        '**4-layer (motir-core/CLAUDE.md):** route (`app/admin/**`, gate + parse ' +
        'only) → `platformReadService` (the cross-tenant + audit logic, owns the ' +
        'transaction) → platform-scoped repositories (the single-op tenant-' +
        'filter-skipping reads + the audit-log write, `tx`-required) → Prisma. NO ' +
        'tenant-scoped repo is modified to skip its filter — the bypass lives in ' +
        'NEW platform repo methods, so the existing tenant guard is never ' +
        'weakened.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The `User` gains the `platformRole`/flag (migration clean, ' +
        'enum/relation-modelled per CLAUDE.md); a platform-staff user is seeded.\n' +
        '- `requirePlatformStaff()` gates `app/admin/`: a non-staff principal ' +
        '(incl. a tenant owner/admin) gets a 404; a platform-staff user reaches ' +
        'the console shell. The check is server-side only.\n' +
        '- `platformReadService` reads across tenants via platform-scoped repo ' +
        'methods (the tenant filter is skipped ONLY here) and writes a ' +
        '`PlatformAuditLog` row for each cross-tenant read; no existing tenant-' +
        'scoped service/repo is altered (the 404-not-403 guard stays intact ' +
        'everywhere else).\n' +
        '- 4-layer respected; the bypass + the audit are localized to the ' +
        'platform service/repos; a typed `NotPlatformStaffError` maps to the 404 ' +
        'response.\n\n' +
        '## Context refs\n\n' +
        '- 10.1.2 — the ADR this implements (the `PlatformRole` shape, the gate ' +
        'contract, the `PlatformAuditLog` record, the `/admin` placement).\n' +
        '- `motir-core/lib/auth/` — the session + `User` the flag/gate hang off.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + the 404-not-403 guard (the ' +
        'cross-tenant bypass is the deliberately-localized exception).\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the tenant-scoped ' +
        'read authority the platform reads parallel (platform repos skip the ' +
        'filter the normal path enforces).',
      dependsOn: ['10.1.2'],
    },
    {
      id: '10.1.4',
      title:
        'The estate overview — orgs/workspaces/projects/users counts + activity (paginated, rolled up — finding #57)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'Build the console OVERVIEW: the estate counts (orgs / workspaces / ' +
        'projects / users) + a recent-activity feed, across ALL tenants, rendered ' +
        'from the 10.1.1 design. Reads through the 10.1.3 `platformReadService` ' +
        '(audited cross-tenant). At platform scale this MUST be rolled-up / ' +
        'covered queries, never a sweep of every row on each load (finding #57).\n\n' +
        '**The counts (cheap, rolled-up).** Estate counts come from covered ' +
        'count queries (or a small maintained rollup), NOT by loading the rows: ' +
        '`count(orgs)`, `count(workspaces)`, `count(projects)`, `count(users)` — ' +
        'each a single indexed count, with the org/workspace/project hierarchy ' +
        'from 6.10.3 (`Workspace.organizationId`) so the counts can also be sliced ' +
        'per org later. A "new this week/month" delta per count is a cheap ' +
        'windowed count, not a scan.\n\n' +
        '**The activity feed (paginated, at-scale).** A recent-activity slice — ' +
        'new orgs / workspaces / projects + recent planning/coding job activity ' +
        '— PAGINATED (cursor/keyset, newest first), NEVER "load all" (a busy ' +
        'platform produces an unbounded stream; the at-scale rule). The job ' +
        'activity that comes from metering (planning/coding runs) is READ over ' +
        'the 7.1 boundary from motir-ai (a recent-runs slice), not held in ' +
        'motir-core.\n\n' +
        '**4-layer (motir-core/CLAUDE.md):** `app/admin/` overview route ' +
        '(gate + parse) → an `platformOverviewService` method (resolves the ' +
        'counts + the activity page via `platformReadService`, audited) → ' +
        'platform-scoped count/list repos (single-op covered queries) + the 7.1.5 ' +
        'client for the metering-sourced activity → DTO. The UI renders the ' +
        '10.1.1 overview panel: the stat cards + the paginated activity feed, ' +
        '`--el-*` tokens only, the palette (per-entity tints, not grey-only — ' +
        'finding #54), an `aria-live` region for the load→loaded transition, ' +
        'i18n via a new `platformAdmin` namespace.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The overview shows estate counts (orgs/workspaces/projects/users) from ' +
        'covered count queries (NOT row loads) + a "new this period" delta per ' +
        'count; the org/workspace/project hierarchy uses 6.10.3’s ' +
        '`Workspace.organizationId`.\n' +
        '- The recent-activity feed is paginated (cursor/keyset, newest first), ' +
        'never load-all; the metering-sourced job activity is read over the 7.1 ' +
        'boundary (no metering held in motir-core).\n' +
        '- Every cross-tenant read goes through `platformReadService` and is ' +
        'audited (10.1.3); the route is platform-staff-gated (404 for non-staff).\n' +
        '- 4-layer respected; the UI renders the 10.1.1 overview panel with ' +
        '`--el-*` tokens only + the palette; rendering the overview does NOT ' +
        'sweep every work-item / metering row (finding #57).\n\n' +
        '## Context refs\n\n' +
        '- 10.1.1 — the overview panel design this implements.\n' +
        '- 10.1.3 — the `platformReadService` + the audited cross-tenant read + ' +
        'the gate.\n' +
        '- 6.10.3 — the `Organization` + `Workspace.organizationId` the counts + ' +
        'the hierarchy read (the rollup’s top tiers).\n' +
        '- 7.1.5 — the motir-core → motir-ai client the metering-sourced activity ' +
        'is read over.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § colour/shape tokens.',
      dependsOn: ['10.1.3', '6.10.3'],
    },
    {
      id: '10.1.5',
      title:
        'The usage/cost rollups — aggregate 7.12 planning metering + 9.0 gateway spend per project→workspace→org→platform + per-model + top consumers (pre-aggregated)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 80,
      descriptionMd:
        'Build the usage/cost ROLLUPS — the platform-level aggregation of BOTH ' +
        'metering spines, sliced down the tenant hierarchy and by model + top ' +
        'consumers, rendered from the 10.1.1 design. This is the analytical heart ' +
        'of the console, and it is the card finding #57 governs: at platform ' +
        'scale it reads PRE-AGGREGATED rollups, NEVER a live scan of raw metering.\n\n' +
        '**Two spines, one rollup.** Aggregate:\n' +
        '- **7.12 planning metering** — `PlanningRun`/`PlanningTurn` + the credit ' +
        'ledger’s debits (7.12.2): the planning token/credit spend per ' +
        'tenant + per model.\n' +
        '- **9.0 gateway spend** — the authoritative per-request provider `usage` ' +
        'the 9.0.5 meter captures (input/output + cache tokens, attributed by ' +
        'virtual key → run → tenant): the coding-agent token/credit spend per ' +
        'tenant + per model.\n' +
        'Both live in motir-ai’s DB, so the rollup is computed THERE and ' +
        'READ over the 7.1 boundary — motir-core never holds the metering.\n\n' +
        '**The hierarchy (project → workspace → org → platform).** Each metering ' +
        'row carries project + workspace + org (per the locked decision — metering ' +
        'rows carry the full tenant path for rollup), so spend rolls up cleanly: ' +
        'platform = Σ orgs = ΣΣ workspaces = ΣΣΣ projects. Plus a per-MODEL ' +
        'breakdown (each model’s share of the total) and a TOP-CONSUMERS ' +
        'ranking (the N orgs/workspaces draining the most).\n\n' +
        '**Pre-aggregated, never scan-all (finding #57 — the load-bearing ' +
        'constraint).** At platform scale (billions of runs/turns/gateway rows) a ' +
        'live `GROUP BY` over raw metering on each page load is the prototype ' +
        'tell. Instead: maintain a **platform usage rollup** — extend 7.12’s ' +
        'existing monthly per-tenant/per-model aggregates with the org/workspace/' +
        'project + the 9.0 gateway spend, into a rollup table keyed by ' +
        '`(level, entityId, yearMonth, model)` (the cited shape: store ' +
        'aggregations at MULTIPLE hierarchy levels, query the rollup at the right ' +
        'granularity). Populate it incrementally as metering lands (upsert on ' +
        'write) AND/OR via a periodic rollup job (the Inngest substrate); the ' +
        'console reads the ROLLUP, so a page load is a small indexed read, not a ' +
        'sweep. Document the freshness model (real-time-ish via upsert + a ' +
        'reconciling job).\n\n' +
        '**The read path (over 7.1).** Add a motir-ai internal endpoint (the 7.1 ' +
        'shape, service-credential auth) — e.g. `GET /v1/platform/usage` ' +
        'returning `{ platformTotal, byOrg[], byWorkspace[], byProject[], ' +
        'perModel[], topConsumers[] }` for a period, ALL from the rollup — and ' +
        'consume it from the motir-core 7.1.5 client through ' +
        '`platformReadService` (audited). The motir-core route is platform-' +
        'staff-gated; browsers never call motir-ai.\n\n' +
        '**4-layer (motir-core/CLAUDE.md):** `app/admin/usage` route ' +
        '(gate + parse) → a `platformUsageService` method (reads the rollup via ' +
        'the 7.1.5 client, audited via `platformReadService`) → the client (a ' +
        'read-through leaf, like `lib/email.ts` — no motir-core metering table) → ' +
        'DTO. The UI renders the 10.1.1 rollup + per-model + top-consumers panels: ' +
        'the hierarchy table (expandable, virtualized at scale), the per-model ' +
        'breakdown (per-model tints, not grey-only — finding #54), the top-' +
        'consumers leaderboard (each row a 10.1.6 drill target); `--el-*` tokens ' +
        'only; the `platformAdmin` i18n namespace.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The usage view shows spend rolled up per project → workspace → org → ' +
        'platform, a per-model breakdown, and a top-consumers list, aggregating ' +
        'BOTH 7.12 planning metering AND 9.0 gateway spend; the rollup is ' +
        'internally consistent (platform = Σ orgs = ΣΣ workspaces = ΣΣΣ ' +
        'projects).\n' +
        '- The aggregation reads a PRE-AGGREGATED platform rollup (a rollup table ' +
        'keyed by level/entity/month/model, maintained by upsert + a reconciling ' +
        'job) — a page load is a small indexed read, NOT a live GROUP BY over ' +
        'raw runs/turns/gateway rows (finding #57); the freshness model is ' +
        'documented.\n' +
        '- The rollup lives in motir-ai and is read over the 7.1 boundary ' +
        '(`GET /v1/platform/usage`); motir-core holds no metering and reads it ' +
        'via the 7.1.5 client through the audited `platformReadService`; the ' +
        'route is platform-staff-gated; no `motir-ai` import in motir-core.\n' +
        '- 4-layer respected; the UI renders the 10.1.1 rollup/per-model/top-' +
        'consumers panels with `--el-*` tokens + the palette; the hierarchy table ' +
        'virtualizes/paginates at scale (not load-all).\n\n' +
        '## Context refs\n\n' +
        '- 10.1.1 — the rollup + per-model + top-consumers panel design.\n' +
        '- 10.1.3 — the audited cross-tenant `platformReadService` + the gate.\n' +
        '- 7.12.2 — the planning metering store (`PlanningRun`/`PlanningTurn` + ' +
        'the monthly aggregates this rollup extends) one spine aggregates.\n' +
        '- 9.0.5 — the authoritative gateway `usage` meter (per-request provider ' +
        'tokens attributed by virtual key → run → tenant) the other spine ' +
        'aggregates.\n' +
        '- 7.1.5 — the motir-core → motir-ai client the platform rollup is read ' +
        'over.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § colour/shape tokens; ' +
        'the at-scale / no-load-all rule (finding #57).',
      dependsOn: ['10.1.3', '7.12.2', '9.0.5'],
    },
    {
      id: '10.1.6',
      title: 'Drill-down — the org/workspace/project detail (usage, recent jobs, members, status)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'Build the DRILL-DOWN: from the overview (10.1.4) or a top-consumers / ' +
        'rollup row (10.1.5), open a single tenant’s detail — its usage, ' +
        'recent jobs, members, and status — rendered from the 10.1.1 drill-down ' +
        'panel. This is where the operator looks INTO one customer; every read is ' +
        'cross-tenant and AUDITED.\n\n' +
        '**The three drill levels (org / workspace / project).** An ORG detail ' +
        'shows its workspaces/projects, its usage rollup (the 10.1.5 slice scoped ' +
        'to this org), its recent jobs, its members (cross-workspace, from 6.10), ' +
        'and its status (active / suspended — the suspend ACTION is 10.3; here we ' +
        'only DISPLAY the status). A WORKSPACE detail scopes to its projects + ' +
        'members; a PROJECT detail to its work + recent jobs. Each reuses the ' +
        'SAME rollup + audited-read machinery, scoped to the entity.\n\n' +
        '**Usage scoped to the entity (still pre-aggregated).** The drill-down’s ' +
        'usage panel reads the 10.1.5 rollup FILTERED to this org/workspace/' +
        'project (a small indexed read at that hierarchy level — the multi-level ' +
        'rollup is exactly what makes a per-entity slice cheap), NOT a re-scan. ' +
        'The recent-jobs list is a PAGINATED slice read over 7.1 (not load-all — ' +
        'the at-scale rule).\n\n' +
        '**4-layer (motir-core/CLAUDE.md):** `app/admin/orgs/[id]` (+ workspace / ' +
        'project) routes (gate + parse) → a `platformDrilldownService` (resolves ' +
        'the entity + its scoped usage/jobs/members/status via ' +
        '`platformReadService`, audited) → platform-scoped repos (the tenant-' +
        'filter-skipping single-op reads) + the 7.1.5 client (scoped usage + ' +
        'recent jobs) → DTO. The UI renders the 10.1.1 drill-down panel: the ' +
        'scoped usage, the paginated recent-jobs list, the members list, the ' +
        'status, AND the "viewing another tenant (audited)" affordance; `--el-*` ' +
        'tokens only; the `platformAdmin` i18n namespace.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Drilling into an org/workspace/project shows that entity’s scoped ' +
        'usage (the 10.1.5 rollup filtered to the entity — a small indexed read, ' +
        'not a re-scan), its paginated recent jobs (read over 7.1), its members, ' +
        'and its status (display-only; the suspend ACTION is 10.3).\n' +
        '- Every drill-down read is cross-tenant via `platformReadService` and is ' +
        'AUDITED (a `PlatformAuditLog` row per drill); the "viewing another ' +
        'tenant (audited)" affordance is shown; the route is platform-staff-gated ' +
        '(404 for non-staff).\n' +
        '- 4-layer respected; the recent-jobs + members lists paginate (not ' +
        'load-all); the UI renders the 10.1.1 drill-down panel with `--el-*` ' +
        'tokens + the palette.\n\n' +
        '## Context refs\n\n' +
        '- 10.1.1 — the drill-down panel design.\n' +
        '- 10.1.4 — the overview the drill-down is reached from.\n' +
        '- 10.1.5 — the rollup the per-entity usage slice filters (the multi-' +
        'level rollup makes the scoped read cheap).\n' +
        '- 10.1.3 — the audited cross-tenant `platformReadService` + the gate.\n' +
        '- 6.10.x — the `Organization` + cross-workspace membership the org detail ' +
        'shows (members + the workspace/project children).\n' +
        '- Story 10.3 (stub) — the governance ACTIONS (suspend / impersonate / ' +
        'grant) the drill-down’s status display defers to.',
      dependsOn: ['10.1.4', '10.1.5'],
    },
    {
      id: '10.1.7',
      title: 'Vitest — cross-tenant read gating (non-staff blocked) + rollup math',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Lock the two load-bearing properties of the console: the cross-tenant ' +
        'read GATING (only platform staff, fully audited) and the rollup MATH ' +
        '(the hierarchy + per-model splits sum correctly, from the pre-aggregated ' +
        'rollup). motir-core tests run over a real Postgres (the project ' +
        'convention; the only allowed `vi.mock` is `getSession()`); the rollup ' +
        'aggregation tests run over motir-ai’s real Postgres (7.1.3) with the ' +
        'metering seeded as fixtures (no live LLM/gateway in CI).\n\n' +
        '**Gating (the security boundary — 10.1.3):**\n\n' +
        '- A NON-staff principal (no role, a tenant member, AND a tenant ' +
        'owner/admin, AND a 6.10 org owner) is DENIED `/admin` + every ' +
        'platform-scoped service method — a 404 (surface absent), via ' +
        '`requirePlatformStaff()`; only the platform `PlatformRole`/flag passes. ' +
        'Assert NO tenant-role escalation reaches it.\n' +
        '- Every cross-tenant read through `platformReadService` writes a ' +
        '`PlatformAuditLog` row (actor, target tenant, what, when); a read that ' +
        'is NOT through the platform service path does NOT cross tenants (the ' +
        'normal 404-not-403 guard is unaltered — assert a normal tenant service ' +
        'still 404s cross-tenant).\n\n' +
        '**Rollup math (the analytical correctness — 10.1.5):**\n\n' +
        '- Over a seeded fixture (orgs → workspaces → projects with known ' +
        'planning + gateway metering), the rollup satisfies platform = Σ orgs = ' +
        'ΣΣ workspaces = ΣΣΣ projects; the per-model splits sum to the level ' +
        'total; top-consumers ranks by the right measure.\n' +
        '- The rollup read matches a directly-summed fixture (proving the ' +
        'pre-aggregated rollup equals the ground truth) AND is served from the ' +
        'rollup table, not a raw scan (assert the rollup table is the source — ' +
        'e.g. the query targets it / a raw-scan path is not taken) — the ' +
        'finding-#57 property.\n' +
        '- BOTH spines are aggregated: a fixture with planning-only, gateway-' +
        'only, and mixed tenants all roll up correctly (neither spine is ' +
        'dropped).\n' +
        '- The per-entity drill-down slice (10.1.6) filtered to one org equals ' +
        'that org’s direct sum (the scoped read is consistent with the ' +
        'rollup).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The gating + audit cases pass over real Postgres (only `getSession()` ' +
        'mocked); the rollup-math cases pass over motir-ai’s real Postgres ' +
        'with seeded metering fixtures.\n' +
        '- The rollup math is asserted against a directly-summed fixture (the ' +
        'hierarchy identity + the per-model split + both spines), and the ' +
        'pre-aggregated source is proven (no raw full-scan path — finding #57).\n' +
        '- New motir-core service code respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage); the gate-deny branch + the ' +
        'audit-write branch + the rollup-empty/zero guards each have a direct ' +
        'test.\n\n' +
        '## Context refs\n\n' +
        '- 10.1.3 (the gate + the audited cross-tenant read) + 10.1.5 (the ' +
        'rollup) + 10.1.6 (the scoped drill slice) — everything under test.\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + § ' +
        'coverage gate.\n' +
        '- 7.1.3 — the motir-ai test DB the rollup-aggregation tests run over.',
      dependsOn: ['10.1.5'],
    },
    {
      id: '10.1.8',
      title:
        'E2E — platform-staff sees overview + rollups + drills into an org; a normal user is denied',
      status: 'blocked',
      type: 'e2e',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        '**Type:** e2e (Playwright) — the full operator-console flow end to end, ' +
        'across the platform-staff gate and the audited cross-tenant reads, ' +
        'proving the surface a real operator uses (and that a normal user can’t ' +
        'reach it).\n\n' +
        '**The denied path (the security boundary, first).** As a NORMAL signed-in ' +
        'user (a tenant member — and, in a second case, a tenant OWNER), navigate ' +
        'to `/admin` → DENIED (a 404 / not-found, the surface does not exist for ' +
        'them — NOT a visible forbidden page). Confirm no `/admin` nav affordance ' +
        'is shown to them anywhere in the normal shell.\n\n' +
        '**The operator path.** Sign in as the seeded platform-staff user → ' +
        '`/admin` loads with the platform-staff context banner. The OVERVIEW ' +
        'shows the estate counts + the paginated activity feed. Open the USAGE ' +
        'view → the rollup hierarchy (project → workspace → org → platform), the ' +
        'per-model breakdown, and the top-consumers list render, aggregating ' +
        'planning + gateway spend. DRILL into an org (from a top-consumers row) → ' +
        'its detail shows the scoped usage, recent jobs, members, and status, ' +
        'with the "viewing another tenant (audited)" affordance. (Reading the ' +
        'audit-log itself is 10.3’s view; here we assert the affordance + ' +
        'that the drill works.)\n\n' +
        'Use the seeded estate (a `moooon`-style org over multiple workspaces ' +
        'with some planning + gateway metering — 6.10 + 7.12 + 9.0 seed) so the ' +
        'rollup + drill have real data. Mind the known E2E selector gotchas ' +
        '(heading exact/level, combobox option = label + secondary) per the ' +
        'project’s e2e conventions.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A normal user (member AND owner cases) is denied `/admin` (404 / ' +
        'not-found, no visible forbidden page, no nav affordance); a ' +
        'platform-staff user reaches the console.\n' +
        '- The platform-staff flow renders the overview (counts + paginated ' +
        'activity), the usage rollup (hierarchy + per-model + top-consumers, both ' +
        'spines), and a successful drill into an org (scoped usage / recent jobs ' +
        '/ members / status + the audited-read affordance).\n' +
        '- The test runs in CI (Playwright) against the seeded multi-tenant ' +
        'estate; the gate is exercised server-side (the denied user truly cannot ' +
        'load the surface, not merely a hidden link).\n\n' +
        '## Context refs\n\n' +
        '- 10.1.4 (overview) + 10.1.5 (rollups) + 10.1.6 (drill-down) — the ' +
        'surfaces exercised.\n' +
        '- 10.1.3 — the gate the denied/allowed split proves.\n' +
        '- `motir-core` Playwright e2e setup + the project’s e2e selector ' +
        'conventions (heading exact/level; combobox option = label + secondary).\n' +
        '- 6.10 + 7.12 + 9.0 seed — the multi-tenant estate + metering the flow ' +
        'runs over.',
      dependsOn: ['10.1.6'],
    },
  ],
};
