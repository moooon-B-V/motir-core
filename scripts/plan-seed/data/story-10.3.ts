import type { PlanStory } from '../types';

/**
 * Story 10.3 — Credit/account operations + governance toolkit. The Motir-INTERNAL
 * platform-staff console gains its OPERATIONAL hands: the day-2 toolkit a support /
 * trust-and-safety operator reaches for when a customer's account needs touching —
 * granting or adjusting credits, assigning a plan/tier, suspending or reactivating
 * an org, stepping into a tenant to reproduce a bug (impersonation), flipping a
 * per-org feature flag / kill-switch, and — the spine under all of it — an
 * append-only, tamper-evident AUDIT LOG that records every superadmin action.
 *
 * This is Epic 10's third story (NEW epic: Platform administration & operations).
 * It rides ON TOP of 10.1's console: 10.1 gives the superadmin AUTH model + the
 * gated, fully-audited cross-tenant READ surface (10.1.3); 10.3 adds the WRITE /
 * governance actions that operate against real tenants. Every action here is a
 * privileged cross-tenant MUTATION, so every action here is audited — the audit
 * log (10.3.6) is not an afterthought panel, it is the integrity substrate the
 * whole toolkit is accountable to.
 *
 * **What 10.3 ships (the five operator capabilities + the audit spine):**
 * - **Credit/billing ops (10.3.2)** — grant + adjust credits over 7.12's
 *   `CreditLedger` / `CreditTransaction`, view a tenant's ledger, and assign a
 *   `PlanTier`. This is the OPERATOR side of the same credit machinery 7.12 built
 *   for the customer: 7.12.3 already modelled `CreditTransaction.kind ∈ { debit,
 *   top_up, grant, adjustment }` — 10.3.2 is the authenticated staff path that
 *   WRITES `grant` / `adjustment` rows (a support credit, a goodwill refund, a
 *   billing correction) and assigns tiers, where 7.12 itself only ever modelled
 *   the row shape. The ledger stays in motir-ai; the console reaches it over the
 *   7.1 boundary, never holding billing tables in core.
 * - **Org lifecycle (10.3.3)** — suspend / reactivate an `Organization` (6.9's
 *   root-account tier). A suspended org GATES all access for every member of every
 *   workspace under it (a tenant-wide tripwire for non-payment / abuse), and the
 *   action is audited with a reason. Reactivation is the symmetric, audited
 *   reverse.
 * - **Support impersonation (10.3.4)** — a staff operator ENTERS a tenant to
 *   reproduce an issue, READ-ONLY or full, **time-boxed + FULLY AUDITED + with a
 *   persistent banner**. The verified mirror is the standard safe-impersonation
 *   shape (Yaro Labs / WorkOS / Authress): a logged "login-as" flow that requires
 *   a reason, auto-expires (15–60 min, fresh re-initiation after), surfaces a
 *   persistent high-visibility banner so the operator never mistakes the tenant's
 *   live environment for their own, and writes an immutable, separately-stored
 *   audit entry of when/why/who — annotated "run-by staff X" on every action taken
 *   while impersonating. We mirror that exactly.
 * - **Feature flags / kill-switches (10.3.5)** — per-org toggles a staff operator
 *   flips WITHOUT a deploy (disable AI / hosted runs for one org, gate a beta).
 *   The mirror is the standard ops-flag / kill-switch shape (LaunchDarkly /
 *   Unleash / ConfigCat): a permanent, default-safe, instantly-evaluated toggle,
 *   scoped per-tenant, changed through an audited admin surface — not an
 *   experiment flag with a 2–4-week lifecycle, but a durable operational control.
 * - **The admin audit log (10.3.6)** — every superadmin action (the 10.1.3 reads
 *   + every 10.3 write) recorded as `{ actor, targetTenant, action, payload, time
 *   }`, **append-only + tamper-evident (hash-chained) + searchable**. The verified
 *   mirror is the standard tamper-evident-log shape (Mattermost / hash-chaining
 *   write-ups): each entry's hash is computed over its fields PLUS the previous
 *   entry's hash, so altering any past record invalidates every later hash; the
 *   log is append-only with write access restricted to the audit pipeline and read
 *   access restricted to staff. The same operators who can change systems must NOT
 *   be able to quietly alter the record of those changes.
 *
 * **Where the data lives — split across the open-core boundary, on purpose.** The
 * CREDIT / ledger data is motir-ai's (7.12, the closed side); the ORG lifecycle
 * state, the per-org FEATURE FLAGS, the IMPERSONATION grants, and the AUDIT LOG
 * are platform-operational facts about motir-core tenants and live in motir-core's
 * DB (the `Organization` from 6.9 is a core entity; suspension/flags gate core
 * access; the audit log records core-side staff actions). 10.3.2's credit ops
 * reach the ledger over the 7.1 boundary (the 7.12 read/write path), exactly as
 * 7.12.5's display does — the console never grows its own billing tables. This
 * keeps the open-core line clean: motir-core stays an exportable Jira clone; the
 * superadmin/governance tables are an OPERATOR overlay, not customer PM data.
 *
 * **Cross-story dep audit (notes.html #32): PASSES — no forward-pointing deps.**
 * Every `dependsOn` id's story number is ≤ 10.3:
 *   - 10.1.3 (the gated, audited cross-tenant admin surface) — backward, same epic.
 *   - 7.12.3 (the `CreditLedger` / `CreditTransaction` / `PlanTier` the credit ops
 *     write over) — Epic 7, backward.
 *   - 6.9.4 (the org-scoped services + access gating suspend/reactivate hook into)
 *     — Epic 6, backward.
 *   - 10.3.x (same-story chaining) and the same-story design gate (10.3.1).
 * No dep points forward. Statuses follow the rule: 10.3.1 (design, `dependsOn: []`)
 * is `planned`; everything chained behind it or behind a not-yet-done 10.1.x /
 * 7.12.x / 6.9.x id is `blocked`.
 *
 * **The design gate fires (Principle #13).** 10.3 ships a real staff-facing
 * surface — the ops toolkit (credit grant/adjust, plan/tier mgmt, org suspend,
 * impersonation entry, feature flags, the audit-log view). So the FIRST subtask
 * (10.3.1) is a `design` card producing `design/platform-admin/*.mock.html` +
 * `design-notes.md` (the SAME `design/platform-admin/` area 10.1.1 / 10.2.1 own —
 * this story adds the ops-toolkit panels to it), and the UI-touching code subtask
 * (10.3.7) depends on it and is `blocked` behind it.
 *
 * **Deferred future 10.x (named here so they are visibly deferred, NOT forgotten
 * — a real boundary, the open-finding-style record):**
 * - **Abuse / content moderation** — the trust-and-safety queue (report → review →
 *   action a tenant/user) beyond the blunt org-suspend lever 10.3.3 ships. A future
 *   10.x.
 * - **DSAR / compliance ops** — GDPR/CCPA data-subject export + right-to-erasure
 *   (per-user data export / hard-delete across both DBs), data-retention controls.
 *   A future 10.x with its own legal/compliance design.
 * - **Status / maintenance banners** — the platform-wide status-page +
 *   maintenance-window broadcast (a public status feed + in-app banner), distinct
 *   from the per-impersonation banner here. A future 10.x.
 * - **Email-delivery ops** — bounce/complaint handling, the suppression list, a
 *   resend/deliverability console over the transactional-email provider. A future
 *   10.x.
 * These are deliberately OUT of 10.3's scope so the story stays the credit /
 * account / governance toolkit + its audit spine, not an unbounded admin grab-bag.
 */
export const story_10_3: PlanStory = {
  id: '10.3',
  title: 'Credit/account operations + governance toolkit',
  status: 'planned',
  gitBranch: 'feat/PROD-10.3-ops-governance-toolkit',
  descriptionMd:
    'The Motir-INTERNAL platform-staff console gains its OPERATIONAL hands — ' +
    'the day-2 toolkit a support / trust-and-safety operator reaches for when a ' +
    "customer's account needs touching, all riding on 10.1's gated, audited " +
    'cross-tenant console (10.1.3). Every capability here is a privileged ' +
    'cross-tenant MUTATION, so every capability here is **audited**: the admin ' +
    'audit log (10.3.6) is the integrity substrate the whole toolkit is ' +
    'accountable to, not an afterthought.\n\n' +
    '**What 10.3 ships (five operator capabilities + the audit spine):**\n\n' +
    '- **Credit/billing ops** — grant + adjust credits over **7.12’s ledger**, ' +
    "view a tenant's ledger, and assign a `PlanTier`. 7.12.3 already modelled " +
    '`CreditTransaction.kind ∈ { debit, top_up, grant, adjustment }`; 10.3.2 is ' +
    'the authenticated STAFF path that writes the `grant` / `adjustment` rows (a ' +
    'support credit, a goodwill refund, a billing correction) and assigns tiers, ' +
    'over the 7.1 boundary — the ledger stays in motir-ai.\n' +
    '- **Org lifecycle** — suspend / reactivate an `Organization` (6.9). A ' +
    'suspended org GATES all access for every member of every workspace under it ' +
    '(non-payment / abuse tripwire); the action is audited with a reason.\n' +
    '- **Support impersonation** — enter a tenant to reproduce an issue, ' +
    'read-only or full, **time-boxed + FULLY AUDITED + with a persistent ' +
    'banner** (the standard safe-impersonation shape).\n' +
    '- **Feature flags / kill-switches** — per-org toggles flipped WITHOUT a ' +
    'deploy (disable AI / hosted runs for one org), the standard durable ' +
    'ops-flag shape.\n' +
    '- **The admin audit log** — every superadmin action recorded `{ actor, ' +
    'targetTenant, action, time }`, **append-only + tamper-evident ' +
    '(hash-chained) + searchable**.\n\n' +
    '**Open-core boundary.** Credit/ledger data is motir-ai’s (reached over ' +
    '7.1, like 7.12.5); the org-lifecycle state, per-org flags, impersonation ' +
    'grants, and the audit log are platform-operational facts about core tenants ' +
    'and live in motir-core’s DB as a staff OVERLAY — motir-core stays an ' +
    'exportable PM tool with no superadmin tables leaking into customer data.\n\n' +
    '**Scope:** the ops-toolkit design (10.3.1); credit/billing ops over 7.12 ' +
    '(10.3.2); org suspend/reactivate gating (10.3.3); support impersonation, ' +
    'time-boxed + audited + bannered (10.3.4); per-org feature flags / ' +
    'kill-switches (10.3.5); the tamper-evident admin audit log (10.3.6); the ops ' +
    'toolkit UI (10.3.7); vitest (10.3.8).\n\n' +
    '**Out of scope — the deferred future 10.x (named so they are visibly ' +
    'deferred, not forgotten):** abuse / content moderation (the trust-and-safety ' +
    'queue beyond the blunt org-suspend lever); DSAR / compliance export + ' +
    'right-to-erasure; platform-wide status / maintenance banners (distinct from ' +
    'the per-impersonation banner here); email-delivery ops ' +
    '(bounce/complaint/suppression). Each is a future 10.x with its own story.',
  verificationRecipeMd:
    '- Pull the Story branch; bring up motir-core (`:3000`) + motir-ai (its dev ' +
    'port, each pointed at the other), seeded with a platform-staff user (10.1), ' +
    'at least one `Organization` (6.9) with a workspace + project + a few work ' +
    'items, and a `CreditLedger` for that tenant (7.12).\n' +
    '- **Credit ops (10.3.2).** As staff, open a tenant’s billing-ops panel: ' +
    'GRANT 500 credits with a reason → a `grant` `CreditTransaction` appears ' +
    'in the ledger (over 7.1), `CreditLedger.balance` rises by exactly 500, and ' +
    'an AUDIT entry records the actor + target + amount + reason. ADJUST by −100 ' +
    '(a correction) → an `adjustment` row, balance down 100, audited. Assign ' +
    'the tenant a different `PlanTier` → audited. A NON-staff user hitting ' +
    'the same route is denied (403/404, the 10.1 gate).\n' +
    '- **Org lifecycle (10.3.3).** Suspend the org with a reason → every ' +
    'member of every workspace under it is now GATED (a normal member load of any ' +
    'project in that org is refused with the suspended state, NOT a 500), and the ' +
    'suspension is audited. Reactivate → access returns, audited. A workspace ' +
    'under a DIFFERENT (un-suspended) org is unaffected.\n' +
    '- **Impersonation (10.3.4).** Start an impersonation of a tenant member ' +
    '(read-only) with a reason → the session carries a persistent, ' +
    'high-visibility BANNER (“You are viewing as … — staff session, ' +
    'expires HH:MM”); a read-only session cannot mutate (a write is refused); ' +
    'every request while impersonating is audited “run-by staff X” with ' +
    'the reason. Wait past the time-box (or force-expire) → the session ' +
    'auto-ends and a fresh start is required. Every start + end + action is in the ' +
    'audit log.\n' +
    '- **Feature flags (10.3.5).** Flip the org’s `ai_planning` ' +
    'kill-switch OFF → a planning job for that org is refused (the flag ' +
    'evaluates instantly, default-safe), audited; flip it back ON → planning ' +
    'works. Another org is unaffected (per-tenant scope).\n' +
    '- **Audit log integrity (10.3.6).** Open the audit-log view: every action ' +
    'above is listed (actor, target tenant, action, time), searchable/filterable, ' +
    'paginated (at-scale, not load-all). Run the integrity verifier → the ' +
    'hash-chain validates. Then TAMPER with one historical row directly in the DB ' +
    '(change an amount/reason) and re-run the verifier → it FAILS at that row ' +
    'and every row after (proving the chain is tamper-evident, not just ' +
    'append-only).\n' +
    '- `pnpm test` (motir-core) + the motir-ai suite — 10.3.8 covers the ' +
    'credit grant/adjust path, the suspend gating (a suspended org blocks member ' +
    'access; an un-suspended sibling does not), the impersonation audit + ' +
    'read-only enforcement + time-box, and the audit-log hash-chain integrity ' +
    '(append validates; a tampered row fails verification).\n' +
    '- **Open-core boundary review.** No `motir-ai` import in motir-core (credit ' +
    'ops go over the 7.1 client); the credit ledger lives ONLY in motir-ai; the ' +
    'superadmin overlay tables (org-suspension state, flags, impersonation grants, ' +
    'audit log) are staff-only and never exposed to a tenant session or a browser ' +
    'outside the gated `/admin` surface.\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up Subtask ' +
    'under the same Story.',
  items: [
    {
      id: '10.3.1',
      title:
        'Design — the ops toolkit surfaces (credit grant/adjust, plan/tier, org suspend, impersonation entry, feature flags, the audit-log view)',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        '**Type:** design (the planning-time design gate, Principle #13 + the ' +
        'design-reference rule). The ops-toolkit UI (10.3.7) depends on this ' +
        'card; without it the surfaces would be improvised, which is forbidden ' +
        '(notes.html #31).\n\n' +
        'Produce the design asset for the **ops / governance toolkit** under ' +
        '`motir-core/design/platform-admin/` — the SAME area 10.1.1 (the ' +
        'console overview + rollups) and 10.2.1 (the health view) own; this card ' +
        'ADDS the ops-toolkit panels to it (mirror their layout + ' +
        '`design-notes.md` shape, do not fork a new area). Author it as a ' +
        '**`*.mock.html` mockup** built from the real design system (the shipped ' +
        '`components/ui/*` primitives + the `--el-*` colour tokens + the ' +
        '`[data-display-style]` shape tokens) — NOT a `.pen`. The HTML route ' +
        'is preferred when a coding agent produces the design (no translation ' +
        'gap; the reviewer sees the actual tokens).\n\n' +
        '**This is a DESTRUCTIVE-action surface — design for safety.** Every ' +
        'panel here mutates a real customer account, so the design must carry the ' +
        'safe-action affordances throughout: a required REASON field on every ' +
        'privileged action (the audit needs it), a confirm step on the ' +
        'irreversible/heavy ones (suspend, large credit grant), and a clear ' +
        '“this is audited” cue so the operator knows the action is on ' +
        'the record. Use the palette with intent: `--el-danger` for ' +
        'suspend/kill-switch-off, `--el-warning` for adjustments/low-balance, ' +
        '`--el-success` for reactivate/grant (not grey-only — finding #54), ' +
        'with the hue in the tint BACKGROUND + `--el-text-strong` (finding #35), ' +
        'never a page-level tinted surface.\n\n' +
        '**Mirror (cited, the verified shapes):**\n\n' +
        '- **Impersonation** — the safe SaaS “login-as” shape ' +
        '(Yaro Labs / WorkOS / Authress): a reason-gated entry, a read-only vs ' +
        'full toggle, and a PERSISTENT, high-visibility banner during the session ' +
        'so the operator never mistakes the tenant’s live environment for ' +
        'their own. Draw the entry control AND the active-session banner.\n' +
        '- **Feature flags / kill-switches** — the ops-flag shape ' +
        '(LaunchDarkly / Unleash / ConfigCat): a per-org list of durable, ' +
        'default-safe toggles with an instant on/off and an “off = disabled” ' +
        'danger treatment, distinct from experiment flags.\n' +
        '- **Audit log** — a searchable, paginated, append-only event list ' +
        '(actor, target tenant, action, time, reason) with an integrity ' +
        '“verified” indicator.\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the ' +
        'multi-panel rule, mistake #31):\n\n' +
        '- **Panel 1 — the tenant ops drawer (credit + plan).** A tenant’s ' +
        'credit balance + tier, with GRANT-credits and ADJUST-credits actions ' +
        '(amount + required reason), the recent ledger transactions (paginated), ' +
        'and a plan/tier assignment control. Credits are an INTERNAL unit ' +
        '(label them as credits, never currency — the 7.12 convention).\n' +
        '- **Panel 2 — org lifecycle.** The org status (active / suspended), ' +
        'a SUSPEND action (reason + confirm, `--el-danger`) and the symmetric ' +
        'REACTIVATE (`--el-success`), with a visible note that suspension gates ' +
        'all member access across every workspace under the org.\n' +
        '- **Panel 3 — impersonation.** The entry control (target user, ' +
        'read-only vs full, required reason, the time-box duration), AND — as ' +
        'a separate drawn state — the persistent ACTIVE-SESSION banner ' +
        '(“Viewing as … — staff session, read-only, expires ' +
        'HH:MM — Exit”) that rides every page during impersonation.\n' +
        '- **Panel 4 — per-org feature flags / kill-switches.** A list of the ' +
        'durable toggles (e.g. `ai_planning`, `hosted_runs`, a beta gate) with ' +
        'an instant on/off, the current state, and a danger treatment on an ' +
        'OFF/disabled kill-switch; each flip carries a reason.\n' +
        '- **Panel 5 — the admin audit log.** A searchable, FILTERABLE ' +
        '(by actor / tenant / action / date), PAGINATED event list — ' +
        'actor, target tenant, action, time, reason — plan for SCALE ' +
        '(thousands of staff actions; lazy/paged, no “load all rows”, ' +
        'the at-scale rule) — with an integrity-“verified” ' +
        'indicator (the hash-chain is intact) and a row-detail view (the full ' +
        'action payload).\n' +
        '- **Panel 6 — empty / loading / error / denied states.** First-run ' +
        'empty (no flags set / no audit rows yet), the loading skeleton, the ' +
        'fetch-failed state (credit ops over 7.1 — motir-ai down → a ' +
        'clear retry, not a broken zero), and the NOT-STAFF denied state (the ' +
        '10.1 gate — a normal user must never see this surface).\n\n' +
        'Also write **`design/platform-admin/ops-toolkit-design-notes.md`** ' +
        'naming the exact primitives used per surface, the exact copy strings ' +
        '(incl. the impersonation banner copy + the suspend/grant confirm copy), ' +
        'the placement decisions, the per-`--el-*` colour role for each element ' +
        '(the danger/warning/success roles above), the required-reason + ' +
        'confirm-step pattern, and a “primitives composed (no ' +
        'hand-rolling)” checklist (the `design-notes.md` convention). It MUST ' +
        'state, in writing, which future 10.x surfaces are deliberately ABSENT ' +
        'here (abuse moderation, DSAR/compliance, status/maintenance banners, ' +
        'email-delivery ops).\n\n' +
        '**Branch.** `design/PROD-10.3.1-ops-toolkit`. The `design/*` prefix gate ' +
        'skips CI E2E + the Vercel preview deploy (MOTIR.md § Plan-seed ' +
        'Workflow) — this PR only edits `design/platform-admin/**`, no app ' +
        'code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/platform-admin/ops-toolkit.mock.html` exists, ' +
        'renders the six panels above, and references ONLY `--el-*` tokens + ' +
        '`[data-display-style]` shape tokens (no Tier-0 `--color-*`, no ' +
        'hand-rolled spacing — the `motir-core/CLAUDE.md` § colour / ' +
        'shape rules).\n' +
        '- `motir-core/design/platform-admin/ops-toolkit-design-notes.md` exists, ' +
        'names every primitive composed + every copy string + the per-element ' +
        '`--el-*` role, documents the required-reason + confirm + ' +
        '“this-is-audited” safe-action pattern, and lists the deferred ' +
        'future 10.x surfaces as out of scope.\n' +
        '- The impersonation panel draws BOTH the entry control AND the ' +
        'persistent active-session banner; the audit-log panel is drawn ' +
        'paginated/filterable with an integrity indicator (at-scale, not ' +
        'load-all).\n' +
        '- Destructive actions (suspend, kill-switch-off, large grant) carry a ' +
        'confirm + reason; the not-staff denied state is drawn.\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Pill`, ' +
        '`Button`, `Combobox`/`Select`, `EmptyState`, a table/list pattern, the ' +
        'skeleton/loader, a confirm `Modal`) — if a genuinely new primitive ' +
        'is needed, that is a NEW `design/` subtask, not a code workaround.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/platform-admin/` (10.1.1 + 10.2.1) — the area ' +
        'this extends; mirror its layout + `design-notes.md` shape.\n' +
        '- `motir-core/design/ai-usage/` (7.12.1) — the closest credit/ledger ' +
        'design precedent (the internal-credit labelling + per-model breakdown ' +
        'shapes to stay consistent with).\n' +
        '- `motir-core/components/ui/Pill.tsx`, `Card.tsx`, `Button.tsx`, ' +
        '`EmptyState.tsx`, `Modal.tsx`, the table/list + Combobox primitives — ' +
        'the composable surface.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` colour (incl. ' +
        '`--el-danger` / `--el-warning` / `--el-success`) + `[data-display-style]` ' +
        'shape tokens.\n' +
        '- Yaro Labs / WorkOS / Authress safe-impersonation write-ups (the ' +
        'reason-gated, time-boxed, bannered shape) — the impersonation ' +
        'mirror.',
      dependsOn: [],
    },
    {
      id: '10.3.2',
      title:
        'Credit/billing ops — grant/adjust credits + view ledger + plan/tier assignment (over 7.12 via 7.1)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'The OPERATOR side of 7.12’s credit machinery: an authenticated ' +
        'platform-staff path that GRANTS / ADJUSTS a tenant’s credits, views ' +
        'their ledger, and assigns a `PlanTier` — all over the 7.1 boundary, ' +
        'so the ledger stays in motir-ai and motir-core grows no billing tables. ' +
        '7.12.3 already modelled `CreditTransaction.kind ∈ { debit, top_up, ' +
        'grant, adjustment }` and the `PlanTier`; 10.3.2 is the staff WRITE path ' +
        'for the `grant` / `adjustment` rows (a support credit, a goodwill ' +
        'refund, a billing correction) + the tier assignment that 7.12 itself ' +
        'only modelled the shape of.\n\n' +
        '**The motir-ai side (the ledger owner).** Add staff-scoped operations to ' +
        'motir-ai’s credit service (7.12.3): `grantCredits(aiProject, ' +
        'amount, reason, actor)`, `adjustCredits(aiProject, signedAmount, reason, ' +
        'actor)`, `assignTier(aiProject, tierKey, actor)`, and a ' +
        '`getLedger(aiProject, page)` read. Each WRITE is one transaction that ' +
        'locks the `CreditLedger` row (FOR UPDATE + re-read inside the tx — ' +
        'the lock-before-read-derived-update rule, same as 7.12.3’s per-turn ' +
        'debit) and appends the signed `CreditTransaction` with `balanceAfter` + ' +
        'the `reason` + the actor; a `grant` is positive, an `adjustment` is ' +
        'signed. Expose them behind a service-credential-auth internal endpoint ' +
        '(the 7.1 shape) — e.g. `POST /v1/admin/credits` / ' +
        '`POST /v1/admin/tier` / `GET /v1/admin/ledger` — callable ONLY by ' +
        'motir-core’s server (never a browser).\n\n' +
        '**The motir-core side (the gated staff route, 4-layer).** A ' +
        '`/admin/…` route (gated by the 10.1.3 superadmin check) parses + ' +
        'calls ONE `adminCreditsService` method; the service resolves the target ' +
        'tenant’s `AiProject` identity + calls the 7.1.5 client’s new ' +
        'admin-credit operations + RECORDS the action to the 10.3.6 audit log + ' +
        'maps to a DTO. No `motir-ai` import, no Prisma-for-billing in core ' +
        '(read-through over 7.1, the `email.ts`-style leaf-client pattern). The ' +
        'route is staff-gated (the 10.1 gate — a non-staff caller is denied) ' +
        'and the action is AUDITED (10.3.6) with actor + target + amount + ' +
        'reason BEFORE returning success.\n\n' +
        '**No checkout here.** This is the operator granting/correcting credits, ' +
        'NOT a customer buying them — there is no Stripe, no pricing, no ' +
        'card charge (that is Epic 8). 10.3.2 writes `grant` / `adjustment` ' +
        'rows directly, the support/goodwill path, distinct from the `top_up` ' +
        'checkout path Epic 8 owns.\n\n' +
        '## Acceptance criteria\n\n' +
        '- motir-ai exposes staff-scoped, service-credential-auth credit ops ' +
        '(grant / adjust / assign-tier / get-ledger) on the 7.12.3 credit ' +
        'service; each write locks the ledger row (FOR UPDATE + re-read), appends ' +
        'a signed `CreditTransaction` with `balanceAfter` + reason + actor, and ' +
        'is one transaction.\n' +
        '- motir-core’s `/admin` credit route is gated by the 10.1.3 ' +
        'superadmin check (non-staff → denied), calls ONE service method ' +
        '(4-layer; no `motir-ai` import, no billing Prisma in core — ' +
        'read-through over the 7.1.5 client), and AUDITS the action (10.3.6) ' +
        'with actor + target + amount + reason.\n' +
        '- A grant raises the balance by exactly the amount; an adjustment ' +
        'moves it by the signed amount; a tier assignment changes the ' +
        'tenant’s `PlanTier` — each reflected in the ledger read and ' +
        'each audited.\n' +
        '- No checkout/pricing/Stripe surface (Epic 8); these are ' +
        'grant/adjustment rows, not `top_up`.\n' +
        '- The ledger lives only in motir-ai; motir-core has zero billing ' +
        'tables.\n\n' +
        '## Context refs\n\n' +
        '- 7.12.3 — the `CreditLedger` / `CreditTransaction` (kind grant / ' +
        'adjustment) / `PlanTier` + the lock-before-read-derived-update debit ' +
        'pattern this reuses for grants.\n' +
        '- 7.12.5 / `motir-core/lib/ai/motirAiClient.ts` (7.1.5) — the ' +
        'read-through-over-7.1 pattern the staff route mirrors (no billing table ' +
        'in core).\n' +
        '- 10.1.3 — the superadmin gate + the audited cross-tenant surface ' +
        'this route lives under.\n' +
        '- 10.3.6 — the audit log every action records to.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + the ' +
        'lock-before-read-derived-update rule.',
      dependsOn: ['10.1.3', '7.12.3'],
    },
    {
      id: '10.3.3',
      title: 'Org lifecycle — suspend/reactivate an org (gates all access) + the audited action',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'A staff operator can SUSPEND or REACTIVATE an `Organization` (6.9’s ' +
        'root-account tier). A suspended org is a tenant-wide tripwire: it GATES ' +
        'all access for every member of every workspace under it (the ' +
        'non-payment / abuse lever), and both the suspend and the reactivate are ' +
        'audited with a reason. This is the blunt account-level control; the ' +
        'finer-grained abuse/moderation queue is a deferred future 10.x (named in ' +
        'the header), not here.\n\n' +
        '**Schema (motir-core — the org is a core entity from 6.9).** Add ' +
        'the suspension state to `Organization`: `{ suspendedAt?, suspendedReason?, ' +
        'suspendedByUserId? }` (or a small `OrganizationSuspension` row if a ' +
        'history of suspend/reactivate events is wanted — prefer the row so ' +
        'the lifecycle is auditable beyond the latest state). Model every FK as a ' +
        'Prisma `@relation` (the CLAUDE.md FK-as-relation rule). A migration runs ' +
        'clean.\n\n' +
        '**The gate (the load-bearing part).** Suspension must DENY access ' +
        'everywhere a tenant member would normally be admitted — hook the ' +
        '6.9.4 org-scoped access gating (org membership already gates workspace ' +
        'access there): when the resolved org is suspended, the access check ' +
        'fails CLEANLY with a typed `OrganizationSuspendedError` that the route ' +
        'layer maps to a clear state (a 403-with-reason for members, NOT a 500 ' +
        'and NOT a misleading 404), so a suspended tenant sees “this ' +
        'account is suspended” rather than a broken app. The gate is ' +
        'evaluated on the org resolution that already happens per request (no ' +
        'extra round-trip), and it does NOT apply to a platform-staff session ' +
        '(staff can still inspect a suspended org through the console).\n\n' +
        '**The action (4-layer, staff-gated, audited).** A `/admin` route ' +
        '(gated by 10.1.3) calls ONE `orgLifecycleService` method ' +
        '(`suspend(orgId, reason, actor)` / `reactivate(orgId, reason, actor)`) ' +
        'that, in one transaction, writes the suspension state (via the org / ' +
        'suspension repository) and is AUDITED (10.3.6) with actor + target org + ' +
        'action + reason. Reactivate is the symmetric reverse (clears / closes ' +
        'the suspension), also audited.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `Organization` (6.9) carries suspension state (modelled as a ' +
        '`@relation`-clean schema, history-preserving preferred); a migration ' +
        'runs clean.\n' +
        '- Suspending an org GATES all access for every member of every ' +
        'workspace under it via the 6.9.4 access gating — a member load is ' +
        'refused with a typed `OrganizationSuspendedError` → a clear ' +
        'suspended state (not a 500, not a misleading 404); a sibling un-suspended ' +
        'org is unaffected; a platform-staff session is NOT gated.\n' +
        '- Suspend + reactivate each run through a staff-gated (10.1.3) 4-layer ' +
        'route → ONE service method → one transaction, and each is ' +
        'AUDITED (10.3.6) with actor + target + reason.\n' +
        '- The gate adds no extra per-request round-trip (it rides the org ' +
        'resolution already performed).\n\n' +
        '## Context refs\n\n' +
        '- 6.9.4 — the org-scoped services + access gating the suspension ' +
        'gate hooks into (org membership gates workspace access).\n' +
        '- 6.9.3 — the `Organization` + `Workspace.organizationId` schema ' +
        'the suspension state extends.\n' +
        '- 10.1.3 — the superadmin gate the suspend/reactivate route lives ' +
        'under.\n' +
        '- 10.3.6 — the audit log the action records to.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § FK-as-`@relation` + the ' +
        '404-not-403 tenant-guard convention (suspension is a 403-with-reason, ' +
        'distinct from the cross-tenant 404).',
      dependsOn: ['10.1.3', '6.9.4'],
    },
    {
      id: '10.3.4',
      title:
        'Support impersonation — enter a tenant (read-only or full), time-boxed + FULLY AUDITED + banner',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 75,
      descriptionMd:
        'A platform-staff operator can ENTER a tenant to reproduce an issue — ' +
        'READ-ONLY or full — **time-boxed, FULLY AUDITED, and with a ' +
        'persistent banner**. This is the highest-trust capability in the ' +
        'toolkit (a staff member acting AS a customer), so it implements the ' +
        'verified safe-impersonation shape exactly; the difference between a ' +
        'correct and a dangerous implementation is entirely in these controls.\n\n' +
        '**Verified mirror (cited, not asserted — Yaro Labs / WorkOS / ' +
        'Authress).** The safe SaaS “login-as” pattern: (1) a ' +
        'reason-gated START (the operator states why — ideally a ticket ' +
        'ref); (2) a TIME-BOX (sessions last ~15–60 min and auto-expire, ' +
        'requiring fresh re-initiation, never an indefinite session); (3) a ' +
        'persistent, HIGH-VISIBILITY banner the whole session so the operator ' +
        'never mistakes the tenant’s live environment for their own; (4) an ' +
        'IMMUTABLE, separately-stored audit entry of when/why/who, with every ' +
        'action taken while impersonating annotated “run-by staff X”; ' +
        '(5) NO raw tokens / no shared session — a distinct, scoped ' +
        'impersonation session, not the customer’s real credentials.\n\n' +
        '**Schema + session (motir-core).** An `ImpersonationGrant` ' +
        '`{ id, staffUserId, targetUserId, targetOrgId, mode (read_only | full), ' +
        'reason, startedAt, expiresAt, endedAt?, endedReason? }` (FK as ' +
        '`@relation`). Starting one mints a SCOPED impersonation session ' +
        '(distinct from the staff member’s own auth and from the ' +
        'customer’s — the session carries `impersonatedUserId` + ' +
        '`staffUserId` + `mode` + `expiresAt`), NOT a re-login as the customer. ' +
        'The session is honoured by the request context: reads run AS the target ' +
        'user (the operator sees what the customer sees); in `read_only` mode ' +
        'every WRITE is refused (a typed `ImpersonationReadOnlyError`); the ' +
        'session AUTO-EXPIRES at `expiresAt` (a stale grant is rejected at the ' +
        'gate, no indefinite access). The grant is staff-gated to START (10.1.3) ' +
        'and only the staff member (or another staff member) can end it.\n\n' +
        '**The banner.** While an impersonation session is active, EVERY page ' +
        'renders a persistent, high-visibility banner (the 10.3.1 design): ' +
        '“Viewing as {name} — staff session ({mode}) — expires ' +
        '{HH:MM} — Exit”. It is not dismissable (the safety property ' +
        'is that it is ALWAYS visible), uses `--el-warning` / `--el-danger` so ' +
        'it is unmistakable, and the Exit control ends the grant immediately.\n\n' +
        '**The audit (every action, run-by).** Starting, ending, and EVERY ' +
        'request made while impersonating are recorded to the 10.3.6 audit log, ' +
        'annotated with the staff actor + the impersonated user + the reason ' +
        '(the “run-by staff X” annotation the mirror requires) — so ' +
        'the trail shows not just “this happened” but “staff X did ' +
        'this AS customer Y, for reason Z, during this session”. The audit ' +
        'is the non-negotiable counterweight to the access.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Starting an impersonation requires a REASON, is staff-gated (10.1.3), ' +
        'and is TIME-BOXED (`expiresAt`, a bounded default duration); the grant ' +
        'auto-expires and a stale grant is rejected at the gate (no indefinite ' +
        'session).\n' +
        '- A `read_only` session can READ as the target user but every WRITE is ' +
        'refused with a typed `ImpersonationReadOnlyError`; a `full` session can ' +
        'act (and every action is attributed).\n' +
        '- A persistent, non-dismissable, high-visibility BANNER renders on ' +
        'every page during the session (the 10.3.1 design) with the target, ' +
        'mode, expiry, and an Exit that ends the grant immediately.\n' +
        '- The START, the END, and every request made while impersonating are ' +
        'AUDITED (10.3.6) annotated “run-by staff X as user Y, reason Z” ' +
        '— the trail attributes every impersonated action to the staff ' +
        'actor.\n' +
        '- The session is a distinct scoped session, NOT the customer’s raw ' +
        'credentials / token; ending it returns the operator to their own staff ' +
        'context.\n\n' +
        '## Context refs\n\n' +
        '- 10.1.3 — the superadmin gate + the audited cross-tenant access ' +
        'this builds on (impersonation is the strongest cross-tenant action).\n' +
        '- 10.3.6 — the tamper-evident audit log every start/end/action ' +
        'records to.\n' +
        '- 10.3.1 — the design for the entry control + the persistent ' +
        'active-session banner.\n' +
        '- `motir-core/lib/auth` (Better-Auth `getSession()`) — the session ' +
        'context the scoped impersonation session layers over (it does NOT ' +
        're-login as the customer).\n' +
        '- Yaro Labs / WorkOS / Authress safe-impersonation write-ups — the ' +
        'time-boxed + audited + bannered + reason-gated + no-raw-token shape ' +
        'mirrored here.',
      dependsOn: ['10.1.3'],
    },
    {
      id: '10.3.5',
      title:
        'Feature flags / kill-switches — per-org toggles (disable AI / hosted runs for an org)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Per-org operational toggles a staff operator flips WITHOUT a deploy — ' +
        'disable AI planning for an abusive org, turn off hosted runs for one ' +
        'tenant, gate a beta behind an allow-list. These are durable OPS flags / ' +
        'kill-switches, not experiment flags.\n\n' +
        '**Verified mirror (cited — LaunchDarkly / Unleash / ConfigCat).** An ' +
        'ops flag / kill-switch is PERMANENT (not a 2–4-week experiment ' +
        'flag), defaults to a SAFE state, evaluates INSTANTLY (no remote ' +
        'round-trip on the hot path), is scoped per-tenant, and is changed ' +
        'through an AUDITED admin surface. We model exactly that: a small known ' +
        'set of named, durable, per-org switches — not an unbounded ' +
        'experimentation platform (that would be its own epic).\n\n' +
        '**Schema (motir-core).** An `OrgFeatureFlag` ' +
        '`{ id, organizationId, key, enabled, updatedByUserId?, updatedAt, ' +
        'reason? }` keyed unique on `(organizationId, key)` (FK as `@relation`). ' +
        'A flag is the OVERRIDE for an org; the platform default for a `key` (a ' +
        'small registry of known flag keys — `ai_planning`, `hosted_runs`, ' +
        '… — each with a default-safe value) applies when no per-org ' +
        'row exists. So evaluation is “per-org override, else platform ' +
        'default”, and absence is the documented safe default.\n\n' +
        '**Evaluation (instant, default-safe).** A `featureFlagService.isEnabled' +
        '(org, key)` resolves the per-org override or the default — cheap, ' +
        'no external call, suitable for the hot path (cache the small per-org flag ' +
        'set on the org resolution already performed per request). The ' +
        'CONSUMERS: the AI-planning entry (e.g. the 7.x dispatch / planning ' +
        'submit) checks `ai_planning` and refuses cleanly when off (a typed, ' +
        'distinguishable “disabled-for-org” error, not a crash); other ' +
        'gated features check their key. A flag OFF is a kill-switch: it disables ' +
        'instantly for that org only, with no effect on other tenants.\n\n' +
        '**The admin action (4-layer, staff-gated, audited).** A `/admin` route ' +
        '(10.1.3-gated) calls ONE `featureFlagService.setFlag(org, key, enabled, ' +
        'reason, actor)` method (one transaction, upsert the `OrgFeatureFlag`), ' +
        'and the flip is AUDITED (10.3.6) with actor + target org + key + ' +
        'new-state + reason. The known-key registry is validated (an unknown key ' +
        'is rejected — flags are a closed set, not free-form).\n\n' +
        '## Acceptance criteria\n\n' +
        '- An `OrgFeatureFlag` schema (unique `(organizationId, key)`, FK as ' +
        '`@relation`) + a registry of known flag keys with default-safe ' +
        'platform defaults; a migration runs clean.\n' +
        '- `featureFlagService.isEnabled(org, key)` resolves per-org override ' +
        'else default, evaluates with no external round-trip (hot-path safe), ' +
        'and absence → the documented safe default.\n' +
        '- An `ai_planning` (or equivalent) flag OFF instantly disables that ' +
        'feature FOR THAT ORG ONLY (a typed, distinguishable disabled error, not ' +
        'a crash); another org is unaffected.\n' +
        '- Flipping a flag runs through a staff-gated (10.1.3) 4-layer route ' +
        '→ ONE service method → one transaction, validates the key ' +
        'against the known registry (unknown key rejected), and is AUDITED ' +
        '(10.3.6) with actor + org + key + state + reason.\n\n' +
        '## Context refs\n\n' +
        '- 6.9.3 — the `Organization` the flags are scoped to.\n' +
        '- 10.1.3 — the superadmin gate the flag-flip route lives under.\n' +
        '- 10.3.6 — the audit log each flip records to.\n' +
        '- The 7.x planning-dispatch / submit path — the `ai_planning` ' +
        'kill-switch consumer (refuses cleanly when off).\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § FK-as-`@relation`.\n' +
        '- LaunchDarkly / Unleash / ConfigCat ops-flag / kill-switch write-ups ' +
        '— the permanent, default-safe, instant, per-tenant, audited shape ' +
        'mirrored here.',
      dependsOn: ['10.1.3'],
    },
    {
      id: '10.3.6',
      title:
        'The admin audit log — every superadmin action recorded (actor, target, action, time), tamper-evident, searchable',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'The integrity spine the whole toolkit is accountable to: EVERY ' +
        'superadmin action — the 10.1.3 cross-tenant reads + every 10.3 ' +
        'write (credit grant/adjust, tier assign, org suspend/reactivate, ' +
        'impersonation start/end/action, flag flip) — recorded as a ' +
        'durable, **append-only, tamper-evident, searchable** event. The same ' +
        'operators who can change customer systems must NOT be able to quietly ' +
        'alter the record of those changes — that is the property this card ' +
        'guarantees.\n\n' +
        '**Verified mirror (cited — Mattermost / hash-chaining write-ups).** ' +
        'Append-only is NOT tamper-evident on its own; cryptographic chaining is. ' +
        'The standard shape: each entry’s hash is computed over its own ' +
        'fields PLUS the previous entry’s hash — `entryHash = ' +
        'H(seq || time || actor || targetTenant || action || payload || ' +
        'prevHash)` — so altering any past record invalidates that ' +
        'entry’s hash AND every later hash (the chain breaks at the tampered ' +
        'row and stays broken after it). Write access is restricted to the audit ' +
        'pipeline; read access to staff; deletion is not a normal operation.\n\n' +
        '**Schema (motir-core).** An `AdminAuditEntry` `{ id, seq (monotonic), ' +
        'actorUserId, targetOrgId?, targetUserId?, action (a typed enum: ' +
        'credit_grant / credit_adjust / tier_assign / org_suspend / ' +
        'org_reactivate / impersonation_start / impersonation_end / ' +
        'impersonation_action / flag_set / cross_tenant_read / …), ' +
        'payloadJson, reason?, createdAt, prevHash, entryHash }` (FK as ' +
        '`@relation`; `seq` + `entryHash` are the chain). The row is INSERT-only ' +
        '— no update/delete methods on its repository at all (append is the ' +
        'only write); the table is the closest thing to a ledger in core.\n\n' +
        '**The append path (serialized, hash-chained).** An `auditService.record' +
        '(entry)` that, in one transaction, reads the latest entry’s ' +
        '`entryHash` UNDER A LOCK (so concurrent appends can’t fork the ' +
        'chain — the lock-before-read-derived-update rule: the chain head is ' +
        'a read-derived write), computes `entryHash = H(… || prevHash)`, and ' +
        'inserts. Every 10.3 service write calls `auditService.record(…)` as ' +
        'part of (or immediately after, same transaction where possible) its own ' +
        'action, so the audit can’t be skipped. (HMAC with a server-held key ' +
        'over plain SHA is the stronger variant — pick + document one; either ' +
        'gives tamper-EVIDENCE, the goal here, short of an external anchor which ' +
        'is a deferred hardening.)\n\n' +
        '**The verifier + the read.** A `verifyChain(fromSeq?, toSeq?)` walks the ' +
        'entries recomputing each `entryHash` from the prior `prevHash` and ' +
        'reports the first seq where the chain breaks (or OK) — this is what ' +
        'proves a tamper. A `searchEntries({ actor?, tenant?, action?, dateRange? ' +
        '}, page)` read powers the 10.3.7 audit-log view, PAGINATED (thousands of ' +
        'entries — the at-scale rule, no full-table sweep / no load-all). ' +
        'Both are staff-gated reads (10.1.3).\n\n' +
        '## Acceptance criteria\n\n' +
        '- An `AdminAuditEntry` schema with `seq` + `prevHash` + `entryHash` ' +
        '(FK as `@relation`); the repository has ONLY an append (insert) + reads ' +
        '— NO update/delete (append-only is enforced at the repo surface); a ' +
        'migration runs clean.\n' +
        '- `auditService.record` appends one entry per action, computing ' +
        '`entryHash` over the entry fields + the prior `prevHash`, reading the ' +
        'chain head UNDER A LOCK (concurrent appends serialize, no forked ' +
        'chain).\n' +
        '- EVERY 10.3 write (10.3.2 credit, 10.3.3 suspend, 10.3.4 ' +
        'impersonation, 10.3.5 flag) AND the 10.1.3 cross-tenant reads record an ' +
        'entry (actor, target tenant, action, time, reason).\n' +
        '- `verifyChain` validates an untampered chain and, after a row is ' +
        'altered directly in the DB, FAILS at that seq and stays failed for ' +
        'every later seq (tamper-EVIDENT, not merely append-only).\n' +
        '- `searchEntries` filters by actor / tenant / action / date and is ' +
        'paginated (at-scale, not load-all); both verify + search are ' +
        'staff-gated.\n\n' +
        '## Context refs\n\n' +
        '- 10.1.3 — the superadmin surface whose cross-tenant reads (and ' +
        'all 10.3 writes) this records; the staff gate on the audit reads.\n' +
        '- 10.3.2 / 10.3.3 / 10.3.4 / 10.3.5 — the actions that call ' +
        '`auditService.record`.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer (the append is a repo ' +
        'insert-only + a service that owns the transaction) + the ' +
        'lock-before-read-derived-update rule (the chain head is read-derived) + ' +
        '§ FK-as-`@relation`.\n' +
        '- Mattermost / PostgreSQL hash-chaining tamper-evident-audit-log ' +
        'write-ups — the entry-hash-over-prev-hash chain mirrored here.',
      dependsOn: ['10.1.3'],
    },
    {
      id: '10.3.7',
      title: 'The ops toolkit UI — the staff console surfaces (renders the 10.3.1 design)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 75,
      descriptionMd:
        'The staff-facing UI that renders the 10.3.1 design — the ops ' +
        'toolkit panels wired to the 10.3.2–10.3.6 services, inside the ' +
        'gated `/admin` console (10.1.3). Every surface here drives a privileged ' +
        'mutation, so every surface carries the safe-action affordances the ' +
        'design fixed (required reason, confirm on the heavy ones, the ' +
        '“this-is-audited” cue).\n\n' +
        '**4-layer (motir-core/CLAUDE.md).** Each panel’s action posts to ' +
        'an `/admin/…` route (10.1.3-gated) that calls ONE service method ' +
        '(the 10.3.2–6 services); client components never touch a service ' +
        'directly. The data reads (a tenant’s ledger over 7.1, the org ' +
        'status, the flags, the audit log) come through their services. The ' +
        'whole surface is staff-only — a non-staff user is denied (the 10.1 ' +
        'gate; the denied state from 10.3.1).\n\n' +
        '**The surfaces (the 10.3.1 panels, verbatim):**\n\n' +
        '- **Tenant ops drawer** — credit balance + tier + recent ledger ' +
        '(paginated, over 7.1), the grant/adjust actions (amount + required ' +
        'reason + confirm on a large grant), the tier-assignment control ' +
        '(10.3.2).\n' +
        '- **Org lifecycle** — the suspend (reason + confirm, `--el-danger`) ' +
        '/ reactivate (`--el-success`) controls + the current status (10.3.3).\n' +
        '- **Impersonation** — the entry control (target, read-only/full, ' +
        'reason, duration) AND the persistent active-session BANNER that rides ' +
        'every page while impersonating, with the Exit control (10.3.4). The ' +
        'banner is non-dismissable + high-visibility (the safety property).\n' +
        '- **Feature flags** — the per-org toggle list with instant on/off + ' +
        'a reason + the kill-switch-off danger treatment (10.3.5).\n' +
        '- **Audit log** — the searchable, filterable (actor / tenant / ' +
        'action / date), PAGINATED event list + the integrity-verified indicator ' +
        '+ a row-detail view (10.3.6). At-scale (lazy/paged), not load-all.\n' +
        '- **Empty / loading / error / denied** states throughout (the 7.1 ' +
        'credit read can fail → retry, not a broken zero; the not-staff ' +
        'denied state).\n\n' +
        '**Tokens + a11y.** References ONLY `--el-*` colour + ' +
        '`[data-display-style]` shape tokens; uses the palette with intent ' +
        '(`--el-danger` suspend/kill, `--el-warning` adjust/impersonation banner, ' +
        '`--el-success` reactivate/grant — not grey-only, finding #54; hue ' +
        'in the tint background + `--el-text-strong`, finding #35). An ' +
        '`aria-live` region for action results; i18n via a new `platformAdmin` ' +
        'namespace (the app’s locale set). The destructive confirms are real ' +
        'confirm `Modal`s, not `window.confirm`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The five toolkit panels render the 10.3.1 design with `--el-*` tokens ' +
        'only; each privileged action posts to a 10.1.3-gated `/admin` route ' +
        '→ ONE service method (4-layer; no client component touches a ' +
        'service or Prisma directly).\n' +
        '- Credit grant/adjust + tier assign (10.3.2), suspend/reactivate ' +
        '(10.3.3), impersonation start/exit + the persistent banner (10.3.4), ' +
        'flag flips (10.3.5), and the searchable/paginated audit log + integrity ' +
        'indicator (10.3.6) are all wired and functional.\n' +
        '- Destructive actions carry a required reason + a confirm `Modal`; the ' +
        'impersonation banner is non-dismissable + always-visible during a ' +
        'session.\n' +
        '- The audit log + ledger are paginated/lazy (at-scale, not load-all); ' +
        'the palette is used (not grey-only); error/empty/denied states render; ' +
        'a non-staff user is denied.\n\n' +
        '## Context refs\n\n' +
        '- 10.3.1 — the design asset (the panels this implements verbatim).\n' +
        '- 10.3.2 / 10.3.3 / 10.3.4 / 10.3.5 / 10.3.6 — the services this ' +
        'wires.\n' +
        '- 10.1.3 — the gated `/admin` surface this lives inside + the ' +
        'staff gate on every route.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § colour/shape tokens.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` + shape tokens.',
      dependsOn: ['10.3.1', '10.3.2', '10.3.3', '10.3.4', '10.3.5', '10.3.6'],
    },
    {
      id: '10.3.8',
      title: 'Vitest — credit grant + suspend gating + impersonation audit + audit-log integrity',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'Lock the governance toolkit with tests on both sides. motir-core tests ' +
        'run over a real Postgres (the project convention; the only allowed ' +
        '`vi.mock` is `getSession()`); the motir-ai credit-ops tests run over its ' +
        'own real Postgres (7.1.3) with the LLM SDK boundary stubbed (not ' +
        'exercised here). The privileged-mutation paths, the gating, and the ' +
        'hash-chain integrity are exercised for real.\n\n' +
        '**Credit ops (10.3.2):**\n\n' +
        '- A staff grant raises the ledger balance by exactly the amount and ' +
        'writes a `grant` `CreditTransaction` (with `balanceAfter` + reason); an ' +
        'adjustment moves it by the signed amount (`adjustment` row); a tier ' +
        'assign changes the `PlanTier` — each over the 7.1 client (stubbed ' +
        'at the client boundary in core; real on the motir-ai service side) and ' +
        'each AUDITED.\n' +
        '- A non-staff caller to the `/admin` credit route is denied (the 10.1 ' +
        'gate).\n\n' +
        '**Org suspend gating (10.3.3):**\n\n' +
        '- Suspending an org makes a normal member load of a project under it ' +
        'fail with the typed `OrganizationSuspendedError` → the clear ' +
        'suspended state (NOT a 500, NOT a 404); a sibling un-suspended org is ' +
        'unaffected; a platform-staff session is NOT gated. Reactivate restores ' +
        'access. Suspend + reactivate are each audited.\n\n' +
        '**Impersonation (10.3.4):**\n\n' +
        '- Starting a `read_only` impersonation lets a READ run as the target ' +
        'but every WRITE is refused with `ImpersonationReadOnlyError`; the start, ' +
        'the end, and an action while impersonating are each AUDITED annotated ' +
        '“run-by staff X as user Y”. A grant past `expiresAt` is ' +
        'rejected at the gate (time-box enforced, no indefinite session). ' +
        'Starting requires a reason + staff gating.\n\n' +
        '**Feature flags (10.3.5):**\n\n' +
        '- `isEnabled` returns the per-org override else the default-safe ' +
        'value; an `ai_planning`-OFF org refuses the gated feature (typed ' +
        'disabled error) while a sibling org is unaffected; an unknown flag key ' +
        'is rejected; a flip is audited.\n\n' +
        '**Audit-log integrity (10.3.6) — the load-bearing test:**\n\n' +
        '- Appending entries builds a valid hash chain and `verifyChain` ' +
        'returns OK; concurrent appends for the same actor serialize (no forked ' +
        'chain, the lock holds). Then TAMPER with a historical row directly ' +
        '(change an amount/reason) and `verifyChain` FAILS at that seq AND every ' +
        'later seq (proving tamper-evidence, not just append-only). The audit ' +
        'repository exposes NO update/delete (append-only at the repo surface). ' +
        '`searchEntries` filters + paginates correctly.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The above cases pass; motir-core over real Postgres (only ' +
        '`getSession()` mocked, the 7.1 client stubbed at its boundary), motir-ai ' +
        'credit ops over its real Postgres.\n' +
        '- The audit-tamper case is proven: an untampered chain verifies, a ' +
        'mutated historical row makes `verifyChain` fail at + after that seq.\n' +
        '- The suspend-gating, impersonation-read-only + time-box, and ' +
        'flag-disabled paths are each proven (the gate fires, the typed error ' +
        'is distinguishable, a sibling tenant is unaffected).\n' +
        '- New motir-core service code respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage); the audit hash-chain + the ' +
        'suspend-gate + the impersonation-write-refusal branches are directly ' +
        'covered.\n\n' +
        '## Context refs\n\n' +
        '- 10.3.2 / 10.3.3 / 10.3.4 / 10.3.5 / 10.3.6 (everything under test).\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + § ' +
        'coverage gate.\n' +
        '- 7.1.3 — the motir-ai test DB the credit-ops side runs over.\n' +
        '- 10.1.3 — the staff gate the denied-path tests assert.',
      dependsOn: ['10.3.2', '10.3.6'],
    },
  ],
};
