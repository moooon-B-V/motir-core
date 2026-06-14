import type { PlanStory } from '../types';

/**
 * Story 6.10 — The Organization (root-account) tier + org admin. Motir today
 * tops out at `Workspace` (Workspace → Project, gated by `WorkspaceMembership`);
 * there is NO tier ABOVE the workspace. This story introduces that missing top
 * tier — **`Organization`** — as the root account a customer signs up as, the
 * parent of N workspaces, and (the load-bearing decision) **the BILLING ENTITY
 * that credits and usage roll up to**.
 *
 * **Naming reality (verified against the live schema — build on this, do not
 * fight it).** A `model Account` ALREADY EXISTS in `prisma/schema.prisma`, but
 * it is **Better-Auth's auth-provider-link model** (the OAuth / credential
 * grant rows a `User` authenticates through) — it is NOT a tenancy tier and the
 * name is taken. So the new top tier is named **`Organization`** (never
 * `Account`); `OrganizationMembership` is its membership join (mirroring the
 * shipped `WorkspaceMembership`). This avoids a collision that would otherwise
 * silently entangle billing tenancy with auth-provider links.
 *
 * **The verified mirror — org→workspace hierarchy with org-level billing (rung
 * 1, cited not asserted).**
 *   - **Atlassian / Jira Cloud — the mirror for BOTH the two-level NESTING and
 *     org-level billing (verified June 2026, checked not asserted).** The
 *     **Organization** is the topmost structure; it "provides a layer that
 *     controls licensing, **billing** and security" across every site/product.
 *     The **org admin** is the highest level of admin and "also see[s] the
 *     billing details" — site admins below do not. **An Atlassian org may have
 *     ONE OR MULTIPLE sites under it** (a site holds the app instances; each
 *     site runs one instance of each app), and **a single account exists at the
 *     org level and can hold access to many sites within the org** — this is the
 *     exact shape of Motir's `Organization` → N `Workspace`. So Motir's
 *     `Organization` = Atlassian's org (the billing/identity root) and Motir's
 *     `Workspace` ≈ Atlassian's **site** (the container under the org). All org
 *     administration (users, billing, multiple sites) is handled at
 *     admin.atlassian.com; a person who is org admin of more than one org picks
 *     an org from a switcher there. (Atlassian Community "Jira's Structure —
 *     Orgs, Sites, Spaces" + "Bring multiple cloud sites under one
 *     Organisation"; Atlassian Support "Navigate Atlassian Administration" +
 *     "Switch between multiple Atlassian accounts" + "types of admin roles";
 *     resolution.de "Organizations and Sites".)
 *   - **Linear — the mirror for org-level BILLING ONLY, NOT for the nesting (a
 *     Linear workspace ≈ a Motir ORGANIZATION, not a Motir workspace).** A
 *     Linear **workspace** is "the home for all issues and interactions in an
 *     organization" — i.e. the workspace IS Linear's org-root; the workspace
 *     **Owner** role carries "the most sensitive settings like **billing**,
 *     security, and audit logs", and separate workspaces have "separate billing
 *     plans". That backs Motir's "credits/usage roll up to the root tenant"
 *     decision. **But Linear has NO sub-workspace tier:** its **teams** live
 *     inside a single workspace and are NOT workspaces (a Linear team is closer
 *     to a Motir project/group than to a Motir workspace), so Linear does NOT
 *     demonstrate the org→workspace nesting — only the billing-at-root point.
 *     One Linear account can belong to many workspaces and switch between them,
 *     but each such workspace is an independent root, which is "one account in
 *     many ORGANIZATIONS" in Motir's terms, not one org owning many workspaces.
 *     (Linear Docs — Workspaces; Concepts; Members and roles.)
 *   So the durable shape: a single root tenant that OWNS billing + cross-
 *   workspace membership, with workspaces nested under it. **The NESTING is
 *   mirrored by Atlassian (org → multiple sites); Linear backs only the
 *   billing-at-root half** (its workspace maps to Motir's org). Motir adopts the
 *   Atlassian shape: `Organization` is the billing/identity root, `Workspace`
 *   the container under it (the Atlassian "site"), the 6.4 `MemberRole` stays
 *   the WORKSPACE-scoped role, and a NEW org-scoped owner/admin role sits above
 *   it (mirroring Atlassian's org-admin-above-site-admin split). A single
 *   account may belong to MULTIPLE organizations (verified above) — so
 *   `OrganizationMembership` is a many-to-many User↔Organization join and the
 *   shell carries an org switcher for the multi-org case.
 *
 * **The billing-entity decision (Yue, locked).** Credits + usage roll up to the
 * `Organization`. 7.12 currently keys its `CreditLedger` to the workspace/
 * `AiProject` tenant; per this decision the ORCHESTRATOR re-keys 7.12's ledger
 * to the org and the metering rows (PlanningRun / AgentRun) carry
 * project+workspace+org for rollups. **6.10 does NOT do that re-keying and does
 * NOT depend on 7.12** — 6.10 ships the `Organization` MODEL + the org ADMIN
 * (members / settings / switcher) and ESTABLISHES that the org is the billing
 * entity; the org-scoped credit/usage VIEW is **7.12.5** (a forward story), and
 * the platform-wide rollup is 10.1.5. Wiring a credit view in here would be a
 * forward dependency on 7.12 — forbidden.
 *
 * **Scope boundary (what 6.10 is / is NOT).** 6.10 IS: the `Organization` +
 * `OrganizationMembership` schema (+ org owner/admin role + `Workspace.
 * organizationId`) with a backfill (every existing workspace → a default org);
 * org-scoped services + access gating (org membership gates workspace access;
 * org owner/admin extends the 6.4 role model); the org admin UI (org settings,
 * cross-workspace member management, the org switcher in the shell); the seed
 * loader modelling the `moooon` org; vitest + e2e. 6.10 is NOT: the customer
 * org usage/credit view (7.12.5), the platform-staff superadmin console that
 * reads ACROSS orgs (10.1 — a SEPARATE platform-staff concept, not the tenant
 * org-admin here), org suspend/feature-flags/credit-ops (10.3), or any billing
 * checkout (Epic 8).
 *
 * **The design gate fires (Principle #13).** 6.10 ships real user-facing
 * surfaces — the org switcher in the shell, org settings, and cross-workspace
 * member management. So the FIRST subtask (6.10.1) is a `design` card producing
 * `design/org-admin/*.mock.html` + `design-notes.md`, and the UI-touching code
 * subtask (6.10.5) depends on it and is `blocked` behind it.
 *
 * **Cross-story dep audit (notes.html #32): PASSES — NO forward deps.** Every
 * 6.10 leaf depends only on same-story 6.10.x cards (story number 6.10 ≤ 6.10). It
 * touches NOTHING in 7.x or 10.x. The billing-entity-is-the-org fact is recorded
 * in PROSE (the orchestrator re-keys 7.12, not this story); 6.10 carries no
 * `dependsOn` on 7.12/7.x/anything > 6.10. Statuses follow the rule: the design
 * card (6.10.1) and the decision card (6.10.2) have `dependsOn: []` → `planned`;
 * everything chained behind them is `blocked`.
 */
export const story_6_10: PlanStory = {
  id: '6.10',
  title: 'Organization (root-account) tier + org admin',
  status: 'planned',
  gitBranch: 'feat/PROD-6.10-organization-tier-admin',
  descriptionMd:
    'Introduce the missing TOP tenancy tier above the workspace — the ' +
    '**`Organization`** (the root account a customer is, the parent of N ' +
    'workspaces) — and the org administration surfaces (org settings, ' +
    'cross-workspace member management, the org switcher in the shell). The ' +
    'org is **the billing entity credits + usage roll up to** (Yue, locked); ' +
    '6.10 establishes that identity + the admin, while the org-scoped credit/' +
    'usage VIEW is a later story (7.12.5) and the cross-org platform console is ' +
    'Epic 10 — both deliberately out of 6.10.\n\n' +
    '**The model (locked — see the module header for the full rationale + the ' +
    'verified mirror):**\n\n' +
    '- **`Organization` is the new root tier — NOT Better-Auth `Account`.** ' +
    'The existing `model Account` is Better-Auth’s OAuth/credential ' +
    'auth-provider-link, NOT a tenancy tier; the name is taken, so the org ' +
    'tier is `Organization`. `OrganizationMembership` mirrors the shipped ' +
    '`WorkspaceMembership`.\n' +
    '- **`Organization` → N `Workspace` → Project.** Today `Workspace` is the ' +
    'top tier with no parent; 6.10 adds `Workspace.organizationId` so every ' +
    'workspace belongs to exactly one org. **This two-level nesting mirrors ' +
    'Atlassian (one org → ONE OR MULTIPLE sites; Motir `Workspace` ≈ Atlassian ' +
    'site) — verified June 2026.** Linear does NOT have this nesting (a Linear ' +
    'workspace IS its org-root and maps to a Motir *organization*, not a ' +
    'workspace; Linear teams live inside one workspace and are not workspaces), ' +
    'so Linear backs only the billing-at-root half. A single account may belong ' +
    'to multiple orgs, so membership is a many-to-many join.\n' +
    '- **Org membership gates workspace access; an org owner/admin role sits ' +
    'ABOVE the 6.4 workspace `MemberRole`.** The 6.4 role stays the ' +
    'workspace-scoped role; a NEW org-scoped owner/admin extends it (mirroring ' +
    'Atlassian’s org-admin-above-site-admin / Linear’s Owner-above-Admin ' +
    'split).\n' +
    '- **The org is the BILLING ENTITY.** Credits + usage roll up to the org ' +
    '(the orchestrator re-keys 7.12’s ledger to the org separately — 6.10 ' +
    'records the decision, ships no credit view, and does NOT depend on ' +
    '7.12).\n' +
    '- **PROGRESSIVE DISCLOSURE (the scale principle, Yue 2026-06-13).** ONE ' +
    'model + ONE set of surfaces serves all three scales (individual / small ' +
    'org / enterprise); the UI reveals a tier only when its count ≥ 2, so there ' +
    'is NO detected "individual" mode and NEVER a migration. The `Organization` ' +
    'is auto-created at signup + renameable and is ALWAYS the header anchor (a ' +
    'one-person company is just an org of one — OPC); the WORKSPACE switcher is ' +
    'HIDDEN until the org has a 2nd workspace; the PROJECT stays in the sidebar. ' +
    'Only two count-driven reveals exist: the workspace switcher at ws #2 and ' +
    'the org menu’s switch-org section at org #2. At one workspace the ' +
    'workspace-settings SURFACE is hidden but the workspace tier still does the ' +
    'work underneath: the single Settings home (entered as the org’s settings) ' +
    'FOLDS IN the workspace-config sections (workflows/fields/labels/components/' +
    'automation/dashboards — all `workspaceId`-scoped) and routes each edit to ' +
    'its own tier (org→`Organization`, config→the single `Workspace`); at ws #2 ' +
    'those sections split into a per-workspace Settings area, with no data move. ' +
    'Full spec in `design/org-admin/design-notes.md` (6.10.1).\n\n' +
    '**Scope:** the org-admin design (6.10.1); the `Organization`-model + ' +
    'billing-entity + role decision (6.10.2); the schema + migration + backfill ' +
    'every-workspace→a-default-org (6.10.3); the org-scoped services + access ' +
    'gating (6.10.4); the org admin UI — settings + cross-workspace members + ' +
    'the shell org switcher (6.10.5); the seed loader modelling the `moooon` ' +
    'org (6.10.6); vitest (6.10.7); e2e (6.10.8); the create-workspace flow ' +
    'design — the dialog + the tier-2 first-reveal (6.10.10).\n\n' +
    '**CANCELLED — copy-on-create config clone (6.10.9), Yue 2026-06-14.** The ' +
    'plan assumed org/workspace-level settings that a new workspace would ' +
    'inherit, but the shipped schema keys all of that config — workflow ' +
    'statuses, boards, custom fields, labels, components, automation rules, ' +
    'saved filters — to the **project**, not the workspace (only dashboards are ' +
    'workspace-scoped), and a fresh workspace has no project. So there is no ' +
    'workspace-level config to clone. Decision (Path B, Yue): a new workspace ' +
    'just starts with its OWN fresh defaults — intentionally different custom ' +
    'fields / components / workflow per workspace — and config is NOT copied ' +
    'automatically. The shipped 6.10.5 create flow is already name-only (no ' +
    'copy), so this needs no code change. Any future "open pre-configured" UX ' +
    'belongs at PROJECT create (copy settings from an existing project, Jira’s ' +
    'shape), not here. 6.10.9 is kept as a `cancelled` tombstone; the 6.10.10 ' +
    'design’s copy-source-picker panels are superseded (not built).\n\n' +
    '**Out of scope (named so they land in their owning story, not here):** ' +
    'the customer org usage/credit DISPLAY (**7.12.5** — a forward story; ' +
    'wiring it here would be a forward dep, forbidden); the Motir-internal ' +
    'platform-staff superadmin console that reads ACROSS all orgs (**Epic 10 / ' +
    '10.1** — a SEPARATE platform-staff concept, not this tenant org-admin); ' +
    'org suspend / feature-flags / credit-grant ops (**10.3**); billing ' +
    'checkout / pricing (**Epic 8**).',
  verificationRecipeMd:
    '- Pull the Story branch; run the migration + `pnpm db:seed` against the ' +
    'local Postgres (`localhost:5433`).\n' +
    '- **The model + backfill.** Confirm `prisma/schema.prisma` has ' +
    '`Organization`, `OrganizationMembership`, and `Workspace.organizationId` ' +
    '(an `@relation`, NOT raw-SQL-only — the CLAUDE.md FK-as-relation rule), ' +
    'and that the backfill migration created exactly ONE default org per ' +
    'pre-existing workspace and pointed each workspace at it (no orphan ' +
    'workspace with a null `organizationId`). Confirm `Organization` is a NEW ' +
    'model and Better-Auth’s `Account` is untouched.\n' +
    '- **The seed.** After `pnpm db:seed`, the `moooon` org exists and owns ' +
    'its workspace(s); the seeding owner is an `OrganizationMembership` with ' +
    'the org-owner role.\n' +
    '- **Access gating.** A user who is a member of an org’s workspace but NOT ' +
    'of the org cannot reach that workspace (gated at the org tier); an org ' +
    'owner/admin can administer every workspace under the org; a non-member ' +
    'gets 404-not-403 cross-tenant (the standing guard). The 6.4 workspace ' +
    '`MemberRole` still governs in-workspace actions unchanged.\n' +
    '- **The org admin UI.** In the shell, the org switcher lists the orgs the ' +
    'signed-in user belongs to and switches the active org; org settings ' +
    'renders + saves; cross-workspace member management lists every member ' +
    'across the org’s workspaces (paginated — at-scale, NOT load-all) and can ' +
    'add/remove/role-change a member. Confirm there is NO credit/usage view ' +
    'and NO billing surface here (that is 7.12.5 / Epic 8).\n' +
    '- `pnpm test` (6.10.7) covers the org model + the membership-gating ' +
    'predicate (member-of-workspace-but-not-org is denied; org-owner spans all ' +
    'workspaces) + the backfill (one default org per workspace, idempotent).\n' +
    '- The e2e (6.10.8) creates an org, attaches workspaces, and manages a ' +
    'cross-workspace member end to end.\n' +
    '- **Dep audit.** Confirm no 6.10 subtask references any id > 6.10 (no ' +
    'forward dep on 7.12/7.x/10.x); the billing-entity fact is prose only.\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up Subtask ' +
    'under the same Story.',
  items: [
    {
      id: '6.10.1',
      title:
        'Design — org admin surfaces: org switcher, org settings, cross-workspace member management',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        '**Type:** design (the planning-time design gate, Principle #13 + the ' +
        'design-reference rule). The org admin UI (6.10.5) depends on this ' +
        'card; without it the surfaces would be improvised, which is forbidden ' +
        '(notes.html #31).\n\n' +
        'Produce the design asset for the **org administration surfaces** ' +
        'under `motir-core/design/org-admin/`. Author it as a **`*.mock.html` ' +
        'mockup** built from the real design system (the shipped ' +
        '`components/ui/*` primitives + the `--el-*` colour tokens + the ' +
        '`[data-display-style]` shape tokens) — NOT a `.pen`. The HTML route ' +
        'is preferred when a coding agent produces the design (no translation ' +
        'gap; the reviewer sees the actual tokens). A PNG export is optional; ' +
        'the `.mock.html` is the source of truth (MOTIR.md § Design-reference ' +
        'rule).\n\n' +
        '**Mirror (cited — the org-above-workspace admin shape).** Atlassian ' +
        'administers the org at admin.atlassian.com (users, billing, multiple ' +
        'sites) with the ORG admin above site admins; Linear’s workspace ' +
        'Owner holds the org-root settings (members, billing, security). Draw ' +
        'THAT shape — an org-scoped admin area distinct from the existing ' +
        'workspace settings — minus billing (billing/credit surfaces are ' +
        '7.12.5 / Epic 8, NOT this area).\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the ' +
        'multi-panel rule, mistake #31):\n\n' +
        '- **Panel 1 — the org switcher (in the shell).** The control in the ' +
        'app shell (e.g. atop the sidebar / next to the workspace switcher) ' +
        'that shows the ACTIVE org and lets a multi-org user switch orgs; ' +
        'within the active org, the workspaces are still switched by the ' +
        'existing workspace switcher (draw the org→workspace nesting clearly). ' +
        'Include the single-org case (the switcher is a quiet label, not a ' +
        'dropdown) and the multi-org case.\n' +
        '- **Panel 2 — org settings (populated).** The org-scoped settings ' +
        'page: org name, slug/identifier, and the org-level metadata an org ' +
        'owner controls — laid out like the existing workspace-settings ' +
        'surface but at the org tier. NAME, in the notes, the "billing lives ' +
        'here later (7.12.5 / Epic 8)" slot WITHOUT drawing an active billing ' +
        'control (a passive placeholder only).\n' +
        '- **Panel 3 — cross-workspace member management (populated).** The ' +
        'roster of everyone in the org ACROSS its workspaces: each member, ' +
        'their org role (owner / admin / member), and which workspaces they ' +
        'belong to; with add / remove / change-role affordances. Plan for ' +
        'SCALE — paginate / lazy-load the roster (a large org has hundreds of ' +
        'members across many workspaces — NO "load all rows", the at-scale ' +
        'rule, finding #57).\n' +
        '- **Panel 4 — the org-role + invite affordances.** The role picker ' +
        '(org owner / admin / member) and the "invite to org" entry, showing ' +
        'how an org role differs from the 6.4 workspace `MemberRole` (an org ' +
        'admin spans all workspaces; a workspace member does not). Draw the ' +
        'role-explanation copy.\n' +
        '- **Panel 5 — empty / loading / error + permission states.** The ' +
        'first-run / single-member empty state, the loading skeleton for the ' +
        'paginated roster, the fetch-error state, and the NOT-an-org-admin ' +
        'state (a workspace member who lacks org-admin sees a gated/forbidden ' +
        'treatment, not the controls).\n\n' +
        'Also write **`design/org-admin/design-notes.md`** naming the exact ' +
        'primitives used per surface, the exact copy strings, the placement ' +
        'decisions (esp. WHERE the org switcher sits relative to the workspace ' +
        'switcher), the per-`--el-*` colour role for each element (use the ' +
        'palette, not grey-only — finding #54; e.g. a per-org-role tint or a ' +
        'Pill tone for the role chips), and a "primitives composed (no ' +
        'hand-rolling)" checklist (the `design-notes.md` convention 1.3.3 / ' +
        '1.5.1 / 7.0.1 established). It MUST state, in writing, that ' +
        'billing/credit/usage is 7.12.5 / Epic 8 and absent here, and that the ' +
        'cross-ORG platform-staff console is Epic 10 (this is the tenant org ' +
        'admin, not the platform console).\n\n' +
        '**Branch.** `design/PROD-6.10.1-org-admin`. The `design/*` prefix gate ' +
        'skips CI E2E + the Vercel preview deploy (MOTIR.md § Plan-seed ' +
        'Workflow) — this PR only edits `design/org-admin/**`, no app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/org-admin/org-admin.mock.html` exists, renders ' +
        'the five panels above, and references ONLY `--el-*` tokens + ' +
        '`[data-display-style]` shape tokens (no Tier-0 `--color-*`, no ' +
        'hand-rolled spacing — the `motir-core/CLAUDE.md` § colour / shape ' +
        'rules).\n' +
        '- `motir-core/design/org-admin/design-notes.md` exists, names every ' +
        'primitive composed + every copy string + the per-element `--el-*` ' +
        'role, states WHERE the org switcher sits vs the workspace switcher, ' +
        'and STATES that billing/credit is 7.12.5 / Epic 8 and the cross-org ' +
        'platform console is Epic 10 — both out of scope here.\n' +
        '- The cross-workspace member roster is drawn paginated/lazy ' +
        '(at-scale, NOT load-all); the org switcher is drawn for BOTH the ' +
        'single-org and multi-org cases.\n' +
        '- The org-role affordances are drawn distinct from the 6.4 workspace ' +
        'role, with the role-explanation copy.\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Pill`, ' +
        '`Button`, `EmptyState`, a table/list pattern, a switcher/menu ' +
        'pattern, the skeleton/loader) — if a genuinely new primitive is ' +
        'needed, that is a NEW `design/` subtask, not a code workaround.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/ready/` (7.0.1) + the existing workspace-' +
        'settings design area — the closest existing design layouts; mirror ' +
        'their layout + `design-notes.md` shape.\n' +
        '- `motir-core/components/ui/Pill.tsx`, `Card.tsx`, `Button.tsx`, ' +
        '`EmptyState.tsx` — the composable surface.\n' +
        '- The existing workspace-switcher component in the app shell — the ' +
        'pattern the org switcher sits alongside / above.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` colour + ' +
        '`[data-display-style]` shape tokens.\n' +
        '- Atlassian admin.atlassian.com org admin + Linear workspace Owner ' +
        'settings — the cited org-root admin mirror.',
      dependsOn: [],
    },
    {
      id: '6.10.2',
      title:
        'Decision — the `Organization` model as top tier + the billing-entity decision + org roles vs 6.4 workspace roles',
      status: 'done',
      type: 'decision',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        '**Type:** decision (the keystone ADR the schema [6.10.3], the gating ' +
        '[6.10.4], and every later org-aware story build against). Produce a ' +
        'living decision document; no app behavior ships here, but the shapes ' +
        'it fixes are load-bearing.\n\n' +
        'Write `motir-core/docs/decisions/organization-tier.md` (an ADR). It ' +
        'MUST fix:\n\n' +
        '1. **The new tier is `Organization`, NOT Better-Auth `Account`.** ' +
        'State explicitly that `model Account` in `prisma/schema.prisma` is ' +
        'Better-Auth’s OAuth/credential auth-provider-link and is NOT a ' +
        'tenancy tier — the name is taken — so the root tenant tier is named ' +
        '`Organization` and its membership join `OrganizationMembership` ' +
        '(mirroring the shipped `WorkspaceMembership`). Record this so no one ' +
        'later "reuses" `Account` and entangles billing tenancy with auth ' +
        'links.\n' +
        '2. **The hierarchy.** `Organization` → N `Workspace` → Project. ' +
        '`Workspace` today has no parent; the decision adds ' +
        '`Workspace.organizationId` (every workspace belongs to exactly one ' +
        'org). **Cite the NESTING mirror precisely — it is Atlassian, NOT ' +
        'Linear:** an Atlassian org has ONE OR MULTIPLE sites under it and a ' +
        'single account can hold access to many sites within the org, so ' +
        'Motir’s `Organization` = the Atlassian org and Motir’s `Workspace` ≈ ' +
        'an Atlassian **site** (verified June 2026). **Linear does NOT have ' +
        'this nesting:** a Linear workspace IS its org-root (it maps to a Motir ' +
        '*organization*, not a workspace) and Linear teams are intra-workspace ' +
        'groups, not workspaces — so cite Linear ONLY for billing-at-the-root ' +
        '(the workspace Owner holds billing; separate workspaces bill ' +
        'separately), never for the org→workspace nesting. Record that a single ' +
        'account may belong to multiple orgs (Atlassian org switcher; Linear ' +
        'multi-workspace), so `OrganizationMembership` is a many-to-many ' +
        'User↔Organization join, not 1:1.\n' +
        '3. **The org is THE BILLING ENTITY (Yue, locked).** Credits + usage ' +
        'roll up to the `Organization`. Record that the ORCHESTRATOR re-keys ' +
        '7.12’s `CreditLedger` to the org and that metering rows ' +
        '(PlanningRun/AgentRun) carry project+workspace+org for rollups — but ' +
        'that **6.10 ships no credit view and takes no dep on 7.12** (the ' +
        'org-scoped usage view is 7.12.5; the platform rollup is 10.1.5). ' +
        'This decision merely DECLARES the billing entity so the later ' +
        're-keying has a home.\n' +
        '4. **Org roles vs the 6.4 workspace `MemberRole`.** The 6.4 ' +
        '`MemberRole` STAYS the workspace-scoped role (unchanged in-workspace ' +
        'semantics). A NEW org-scoped role (`OrganizationRole` — owner / ' +
        'admin / member) sits ABOVE it: an org OWNER/ADMIN can administer ' +
        'every workspace under the org and the org settings/membership; an org ' +
        'MEMBER has org-tier presence but no cross-workspace admin. Fix the ' +
        'precedence rule (how an org role composes with a workspace role at an ' +
        'access check) — mirror Atlassian org-admin-above-site-admin / Linear ' +
        'Owner-above-Admin.\n' +
        '5. **Access gating + membership DIRECTION + the backfill semantics.** ' +
        'Fix that org membership GATES workspace access (a workspace is ' +
        'reachable only by a member of its org) and the 404-not-403 cross-tenant ' +
        'posture is preserved. **Membership direction is ASYMMETRIC (Yue):** ' +
        '(i) adding a user to a WORKSPACE auto-creates their ' +
        '`OrganizationMembership` (role `member`) if absent — you cannot be in a ' +
        'workspace without being in its org (UPWARD auto-join, an enforced ' +
        'invariant); (ii) adding a user to the ORG creates NO workspace ' +
        'membership — a plain org member reaches only the workspaces they are ' +
        'EXPLICITLY added to (an org owner/admin still spans all workspaces by ' +
        'role, per §4), so "org-only" members in ZERO workspaces are a valid ' +
        'state (e.g. a billing admin). (iii) Removing from the org cascades ' +
        'loss of all its workspace access (the gate); removing from a workspace ' +
        'does NOT remove the org membership. The migration BACKFILL rule: each ' +
        'existing workspace gets its OWN default org (1:1, named from the ' +
        'workspace), every existing workspace member also becomes an org member ' +
        '(the upward invariant applied to legacy rows), and the ' +
        'seeding/owning user becomes that org’s owner — so no existing data is ' +
        'orphaned and the gate holds for legacy rows.\n' +
        '6. **Progressive disclosure + auto-provisioning (the scale principle, ' +
        'Yue 2026-06-13).** Fix that ONE model + ONE set of surfaces serves all ' +
        'three scales (individual / small org / enterprise) and the UI reveals a ' +
        'tier only when its count ≥ 2 — so there is NO detected "individual" ' +
        'mode and NEVER a migration. Record: (a) **signup AUTO-CREATES an ' +
        'org + a default workspace** for every new account (a one-person company ' +
        'is an org of one — OPC), and the org is RENAMEABLE; (b) the ORG is ' +
        'always the header anchor, the WORKSPACE switcher is hidden until ws #2, ' +
        'the PROJECT stays in the sidebar; (c) the only two count-driven reveals ' +
        'are the workspace switcher at ws #2 and the org menu’s switch-org ' +
        'section at org #2; (d) at one workspace the workspace-settings SURFACE ' +
        'is hidden but the workspace tier still operates underneath — the single ' +
        'Settings home FOLDS IN the workspace-config sections (all ' +
        '`workspaceId`-scoped) and routes each edit to its own tier ' +
        '(org→`Organization`, config→the single `Workspace`); at ws #2 they ' +
        'split into a per-workspace Settings area with no data move. (e) **There ' +
        'is NO org→workspace config INHERITANCE in the data model** — no ' +
        'org-level config defaults, no override rows, no runtime resolution; ' +
        'config is purely `Workspace`-scoped. The "inherit" UX is a ' +
        'COPY-ON-CREATE: a new workspace is **seeded by copying the source ' +
        'workspace’s config** at creation so it opens already configured (looks ' +
        'inherited), after which the workspaces are independent and either can ' +
        'overwrite. (Real live inheritance, if ever needed for enterprise, is an ' +
        'additive future change, not a migration.) ' +
        'The visual spec is `design/org-admin/design-notes.md` (6.10.1); this ' +
        'ADR fixes the model/auto-provisioning side that the schema (6.10.3), ' +
        'seed (6.10.6) and UI (6.10.5) build to.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/docs/decisions/organization-tier.md` exists and fixes ' +
        'all SIX sections, naming `Organization` (NOT `Account`) and citing ' +
        'the mirror PRECISELY: **Atlassian (org → one-or-multiple sites) for ' +
        'the org→workspace NESTING; Linear (workspace-root billing) for the ' +
        'billing-at-root half only — a Linear workspace maps to a Motir org, ' +
        'NOT a Motir workspace** (cited, not asserted).\n' +
        '- It states plainly that the org is the billing entity AND that 6.10 ' +
        'ships no credit/usage view + takes no dep on 7.12 (the re-keying is ' +
        'the orchestrator’s; the view is 7.12.5).\n' +
        '- It fixes the org-role-vs-workspace-role precedence and the ' +
        'access-gating rule (org membership gates workspace access; ' +
        '404-not-403 preserved).\n' +
        '- It fixes the backfill rule (one default org per existing ' +
        'workspace; the owner becomes org owner; no orphan workspace).\n' +
        '- It fixes the progressive-disclosure + auto-provisioning principle: ' +
        'signup auto-creates an org + default workspace (OPC = org of one; org ' +
        'renameable), the UI reveals a tier only at count ≥ 2 (no "individual" ' +
        'mode; org always shown, workspace hidden until ws #2), and at one ' +
        'workspace the Settings home folds in the workspace-config sections and ' +
        'routes each edit to its tier (the workspace settings still operate ' +
        'underneath; they split into a per-workspace area at ws #2).\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/prisma/schema.prisma` — the existing `Account` ' +
        '(Better-Auth, do NOT reuse), `Workspace`, `WorkspaceMembership`, and ' +
        '`MemberRole` (the 6.4 role) this builds above.\n' +
        '- `motir-core/lib/services/` workspace + membership services + the ' +
        '6.4 role/permission checks — what org gating extends.\n' +
        '- 6.10.1 — the design surfaces this decision’s roles/gating drive.\n' +
        '- Story 7.12 (stub) — the credit ledger the orchestrator re-keys to ' +
        'the org (NOT a dep of 6.10); Epic 10 (stub) — the cross-org platform ' +
        'console (a SEPARATE platform-staff concept).\n' +
        '- Atlassian Community "Jira’s Structure — Orgs, Sites, Spaces" + ' +
        'Atlassian Support "types of admin roles"; Linear Docs — Workspaces, ' +
        'Members and roles (the cited mirror).',
      dependsOn: [],
    },
    {
      id: '6.10.3',
      title:
        'Schema — `Organization` + `OrganizationMembership` + `Workspace.organizationId` + migration + backfill',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'Implement the schema for the org tier decided in 6.10.2, with a ' +
        'migration that BACKFILLS every existing workspace into a default org ' +
        'so no legacy data is orphaned. This is the data foundation the gating ' +
        '(6.10.4), the UI (6.10.5), and the seed (6.10.6) build on.\n\n' +
        '**Schema (`prisma/schema.prisma`):**\n\n' +
        '- **`Organization`** — the root tenant: `{ id, name, slug, ' +
        'createdAt, updatedAt, ... }` with `slug` unique. The NEW top tier ' +
        '(do NOT touch Better-Auth’s `Account`).\n' +
        '- **`OrganizationMembership`** — the membership join (mirrors ' +
        '`WorkspaceMembership`): `{ id, organizationId, userId, role ' +
        '(OrganizationRole owner|admin|member), createdAt }`, unique on ' +
        '`(organizationId, userId)`. Modelled as `@relation` to both ' +
        '`Organization` and `User` (back-relations on each).\n' +
        '- **`enum OrganizationRole`** — `owner | admin | member` (the ' +
        'org-scoped role from 6.10.2, distinct from the 6.4 `MemberRole`).\n' +
        '- **`Workspace.organizationId`** — a NON-nullable FK to ' +
        '`Organization` (after backfill), modelled as a Prisma `@relation` ' +
        '(`Workspace.organization` ↔ `Organization.workspaces`) with the ' +
        'matching `onDelete`/`onUpdate` — **NEVER a raw-SQL-only FK left as a ' +
        'bare scalar** (the CLAUDE.md FK-as-`@relation` rule — a split would ' +
        'put the schema graph + migrate DB in permanent drift). \n\n' +
        '**The migration + backfill (the load-bearing part).** A single ' +
        'migration that: (1) creates `Organization` + `OrganizationMembership` ' +
        '+ the enum; (2) adds `Workspace.organizationId` NULLABLE first; (3) ' +
        'BACKFILLS — for EACH existing workspace, create one default ' +
        '`Organization` (named/slugged from the workspace), point the ' +
        'workspace at it, and create an `OrganizationMembership(owner)` for ' +
        'the workspace’s owner/first-admin (so legacy data has an org owner); ' +
        '(4) makes `Workspace.organizationId` NON-nullable once every row is ' +
        'set. The backfill is idempotent / re-runnable-safe. Because the ' +
        'project uses `prisma migrate` + the shared dev DB, hand-author the ' +
        'data-backfill SQL in the migration (mirror the prodect-shared-db ' +
        'migrate pattern) so it is deterministic.\n\n' +
        '**Repositories (single-op each — 4-layer).** ' +
        '`organizationRepository` (find / create / update by id+slug) and ' +
        '`organizationMembershipRepository` (find-by-org+user, create [tx], ' +
        'list-by-org, delete [tx], update-role [tx]) — writes REQUIRE `tx` per ' +
        'CLAUDE.md. NO business logic here (that is 6.10.4’s service).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `prisma/schema.prisma` gains `Organization`, ' +
        '`OrganizationMembership`, `enum OrganizationRole`, and ' +
        '`Workspace.organizationId` — every FK modelled as a Prisma ' +
        '`@relation` on BOTH sides (no raw-SQL-only FK); `prisma migrate dev` ' +
        'reports "No difference detected" after the migration (no spurious ' +
        'DROP CONSTRAINT — the FK-drift rule).\n' +
        '- The migration backfills exactly ONE default org per pre-existing ' +
        'workspace, points each workspace at it, and creates an owner ' +
        '`OrganizationMembership` for each; after it, NO workspace has a null ' +
        '`organizationId` and the column is NON-nullable.\n' +
        '- The backfill is idempotent (re-running it creates no duplicate ' +
        'orgs/memberships).\n' +
        '- `organizationRepository` + `organizationMembershipRepository` ' +
        'exist as single-op repos; write methods require `tx`; Better-Auth’s ' +
        '`Account` model is untouched.\n\n' +
        '## Context refs\n\n' +
        '- 6.10.2 — the model + backfill decision this implements.\n' +
        '- `motir-core/prisma/schema.prisma` — `Workspace`, ' +
        '`WorkspaceMembership`, `MemberRole`, `User`, and the existing ' +
        '`Account` (Better-Auth — do NOT reuse); the patterns ' +
        '`OrganizationMembership` mirrors.\n' +
        '- `motir-core/lib/repositories/workspaceMembershipRepository.ts` — ' +
        'the single-op + required-`tx` repo pattern to mirror.\n' +
        '- `motir-core/CLAUDE.md` § FK-as-`@relation` (the FK-drift rule) + ' +
        '§ 4-layer (repository layer).',
      dependsOn: ['6.10.2'],
    },
    {
      id: '6.10.4',
      title:
        'Org-scoped services + access gating — org membership gates workspace access; org owner/admin extends 6.4 roles',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'Build the org service layer + the ACCESS GATING that makes the org ' +
        'tier real: org membership gates workspace access, and the org owner/' +
        'admin role extends (sits above) the 6.4 workspace role model. This is ' +
        'the business logic the org admin API/UI (6.10.5) and the platform ' +
        'stories later sit on.\n\n' +
        '**`organizationsService` (business logic + transactions — 4-layer):**\n\n' +
        '- Org CRUD (create/rename/update an org), membership management ' +
        '(invite/add a user to the org with an `OrganizationRole`, ' +
        'remove, change role), and "list members ACROSS the org’s workspaces" ' +
        '(the cross-workspace roster — PAGINATED, never load-all, the at-scale ' +
        'rule). Each write-flow is ONE `prisma.$transaction`; returns DTOs via ' +
        '`lib/mappers/*` (never raw Prisma); throws typed errors from ' +
        '`lib/organizations/errors.ts` the route maps to HTTP.\n' +
        '- **Membership DIRECTION (6.10.2 §5, asymmetric — enforce in the ' +
        'service, NOT scattered):** adding a user to the ORG creates ONLY an ' +
        '`OrganizationMembership` — NO workspace membership (org-only members in ' +
        'zero workspaces are valid; a plain org member reaches only workspaces ' +
        'they’re explicitly added to). Conversely the **add-to-WORKSPACE** flow ' +
        '(extending the existing `WorkspaceMembership` create) MUST auto-create ' +
        'the user’s `OrganizationMembership` (role `member`) in that workspace’s ' +
        'org if absent — the UPWARD invariant (you cannot be in a workspace ' +
        'without being in its org), in the SAME transaction. Removing from the ' +
        'org cascades loss of workspace access (gate); removing from a workspace ' +
        'leaves the org membership intact.\n' +
        '- Resolving the ACTIVE org for a session (for the switcher) + listing ' +
        'the orgs a user belongs to.\n' +
        '- **Auto-provision on signup (the progressive-disclosure principle, ' +
        '6.10.2 §6).** A `provisionForNewUser`-style flow that creates an org + ' +
        'a default workspace + the owner memberships for a brand-new account, in ' +
        'ONE transaction, wired into the existing signup/onboarding path — so ' +
        'every account is an org of one (OPC) from day one and there is never a ' +
        'tier-less user. Mirror the shape of the 6.10.3 backfill (which does the ' +
        'same for pre-existing workspaces); the org name defaults from the ' +
        'user/company and is renameable.\n' +
        '- **(Make the create-workspace path org-aware** so a new workspace is ' +
        'created under the active org with the creator as a member. The ' +
        '**copy-on-create deep-copy** of the source workspace’s config — the ' +
        '"looks-inherited" behaviour, 6.10.2 §6e — is its OWN subtask **6.10.9**, ' +
        'which extends this flow; do not inline it here.)\n\n' +
        '**The access gate (the load-bearing change).** Extend the existing ' +
        'workspace access check so that reaching a workspace requires the ' +
        'session user to be a member of the workspace’s ORG (org membership ' +
        'gates workspace access — 6.10.2). Compose the roles per 6.10.2’s ' +
        'precedence: an org OWNER/ADMIN is granted admin-equivalent access to ' +
        'EVERY workspace under the org (extending the 6.4 `MemberRole`); an ' +
        'org MEMBER falls back to their per-workspace `MemberRole`. Preserve ' +
        'the **404-not-403** cross-tenant posture (a non-member of the org ' +
        'sees the workspace as not-found, not forbidden — the standing ' +
        'guard).\n\n' +
        '**Where it threads.** The gate is a single authorization helper the ' +
        'existing workspace-scoped services/route guards call (do NOT scatter ' +
        'org checks across N routes); the 6.4 permission helper is extended, ' +
        'not duplicated. Reads that guard a write take `tx` + ' +
        '`SELECT FOR UPDATE` where a concurrent membership change could race ' +
        '(the lock-before-read-derived-update rule).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `organizationsService` owns org CRUD + membership management + the ' +
        'cross-workspace member listing (paginated), each write-flow in ONE ' +
        'transaction, returning DTOs (never raw Prisma), throwing typed ' +
        'errors; routes (added in 6.10.5) call exactly one service method.\n' +
        '- The access gate denies a user who is a member of a workspace but ' +
        'NOT of its org (org membership gates workspace access), and a ' +
        'non-org-member gets 404-not-403 cross-tenant.\n' +
        '- An org owner/admin is granted admin-equivalent access to every ' +
        'workspace under the org (the role composes ABOVE the 6.4 ' +
        '`MemberRole`); an org member falls back to their per-workspace ' +
        'role.\n' +
        '- The gate is a single shared helper (not scattered per route); the ' +
        '6.4 permission check is extended, not duplicated.\n' +
        '- 4-layer respected throughout (service owns transactions; repos are ' +
        'single-op with required `tx` on writes).\n\n' +
        '## Context refs\n\n' +
        '- 6.10.2 — the gating + role-precedence decision this implements.\n' +
        '- 6.10.3 — the `organizationRepository` / ' +
        '`organizationMembershipRepository` + the schema this orchestrates.\n' +
        '- `motir-core/lib/services/` — the workspace + membership services + ' +
        'the 6.4 permission/role helper the gate EXTENDS (mirror its shape).\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + the lock-before-read-derived-' +
        'update rule + the 404-not-403 cross-tenant guard.',
      dependsOn: ['6.10.3'],
    },
    {
      id: '6.10.5',
      title:
        'Org admin UI — org settings, cross-workspace member management, the org switcher in the shell',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 70,
      descriptionMd:
        'Build the org administration UI from the 6.10.1 design, over the ' +
        '6.10.4 services: the org switcher in the app shell, the org settings ' +
        'page, and cross-workspace member management. This is the customer-' +
        'facing org admin (the TENANT org owner/admin — NOT the Motir-internal ' +
        'platform console, which is Epic 10). **NO billing/credit/usage ' +
        'surface here** (that is 7.12.5 / Epic 8).\n\n' +
        '**4-layer (motir-core/CLAUDE.md).** Each surface’s route parses + ' +
        'calls ONE `organizationsService` method (6.10.4); the route is ' +
        'session-gated (401 without a session) + org-gated (404-not-403 for a ' +
        'non-org-member, via the 6.10.4 gate). No `db.*` / `$transaction` / ' +
        'business logic in routes.\n\n' +
        '**The surfaces (render the 6.10.1 design verbatim — incl. its ' +
        'PROGRESSIVE-DISCLOSURE rules):**\n\n' +
        '- **The org control in the shell + progressive disclosure (6.10.2 §6; ' +
        'design-notes "Progressive disclosure").** The ORG is ALWAYS the ' +
        'top-left anchor — a menu button (Settings / Members / Billing-soon / ' +
        'New workspace), with a **"Switch organization" section shown ONLY when ' +
        'the account is in ≥2 orgs**. The **WORKSPACE switcher renders ONLY when ' +
        'the active org has ≥2 workspaces** (to the right of the org, ' +
        '`Acme › Engineering`); at one workspace it is NOT rendered at all (no ' +
        '"individual" mode — an OPC is just an org of one). The PROJECT switcher ' +
        'stays in the sidebar; switching the workspace re-scopes it. At one ' +
        'workspace the workspace-settings SURFACE is hidden but its config still ' +
        'operates underneath: the single Settings home folds in the ' +
        'workspace-config sections (`settings/workspace/*`) and saves them to the ' +
        'single `Workspace` row; they split into a per-workspace Settings area ' +
        'only at ws #2 (no data move).\n' +
        '- **Org settings** — org name / slug / org-level metadata, editable ' +
        'by an org owner/admin (the gate enforces the role). The passive ' +
        '"billing later" placeholder per the design — NO active billing ' +
        'control.\n' +
        '- **Cross-workspace member management** — the roster of everyone ' +
        'across the org’s workspaces with org role + workspace membership, and ' +
        'add / remove / change-role actions. The roster is PAGINATED / lazy ' +
        '(the at-scale rule — NOT load-all; a large org has hundreds of ' +
        'members); inline edits follow the no-whole-tree-refresh rule (a ' +
        'success response is the confirmation — no `router.refresh` / ' +
        '`revalidatePath` fan-out on a field update).\n\n' +
        '**Design-system compliance.** References ONLY `--el-*` colour + ' +
        '`[data-display-style]` shape tokens (no Tier-0 `--color-*`, no ' +
        'hand-rolled spacing); uses the palette for the org-role chips (a Pill ' +
        'tone / per-role tint — not grey-only, finding #54); an `aria-live` ' +
        'region for the loading→loaded transition; i18n via a new ' +
        '`orgAdmin` namespace (the app’s locale set).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The org is ALWAYS the header anchor with its menu; org settings ' +
        'renders + saves (org-owner/admin gated); cross-workspace member ' +
        'management lists + adds + removes + role-changes members — all ' +
        'rendering the 6.10.1 design.\n' +
        '- **Progressive disclosure holds (6.10.2 §6 / design-notes):** with ONE ' +
        'workspace the workspace switcher is NOT rendered; creating a 2nd ' +
        'workspace makes it appear and switching it re-scopes the sidebar ' +
        'project switcher; the org menu’s "Switch organization" section is ' +
        'present only when the account is in ≥2 orgs; with one workspace there ' +
        'is no separate workspace-settings surface — its config sections fold ' +
        'into the Settings home and still save to the `Workspace` row (and split ' +
        'out into a per-workspace area at ws #2).\n' +
        '- The member roster is paginated/lazy (at-scale, NOT load-all); ' +
        'inline edits use the success-response-is-confirmation pattern (no ' +
        'whole-tree refresh).\n' +
        '- Routes are session-gated (401) + org-gated (404-not-403 ' +
        'cross-tenant); 4-layer respected (route → `organizationsService`; no ' +
        'client component touches the service directly).\n' +
        '- The UI references ONLY `--el-*` + shape tokens, uses the palette ' +
        'for role chips, and contains NO billing / credit / usage / checkout ' +
        'surface (7.12.5 / Epic 8).\n' +
        '- No new primitive is hand-rolled — composes the shipped ' +
        '`components/ui/*` (a new primitive would be a new `design/` ' +
        'subtask).\n\n' +
        '## Context refs\n\n' +
        '- 6.10.1 — the design asset (the surfaces this implements verbatim).\n' +
        '- 6.10.4 — the `organizationsService` + the access gate this UI calls ' +
        'through.\n' +
        '- The existing workspace-switcher + workspace-settings components — ' +
        'the patterns the org switcher / org settings sit alongside / above.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § colour/shape tokens + the ' +
        'inline-edit no-whole-tree-refresh rule.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` + shape tokens.\n' +
        '- 6.10.10 — the create-workspace flow design this org menu’s "New ' +
        'workspace" entry launches (the dialog + the tier-2 first-reveal).',
      dependsOn: ['6.10.1', '6.10.4', '6.10.10'],
    },
    {
      id: '6.10.6',
      title:
        'Seed loader — model the `moooon` org over its workspace(s); backfill in `pnpm db:seed`',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        'Teach the seed loader (`scripts/plan-seed/seed.ts` + the seed data) ' +
        'about the org tier so `pnpm db:seed` models the **`moooon`** org over ' +
        'its workspace(s) — the dev/demo data that exercises the new ' +
        'hierarchy. This keeps the seeded world consistent with the 6.10.3 ' +
        'schema + the 6.10.4 gating (every seeded workspace lives under an ' +
        'org; the seeding owner is an org owner).\n\n' +
        '- Create the `moooon` `Organization` and attach the existing seeded ' +
        'workspace(s) to it via `organizationId` (the seed’s workspaces no ' +
        'longer top-level-orphan — they nest under `moooon`).\n' +
        '- Create an `OrganizationMembership(owner)` for the seed’s ' +
        'owning/admin user, plus a couple of org members at different ' +
        'org-roles (owner / admin / member) so the cross-workspace member ' +
        'management UI (6.10.5) + the e2e (6.10.8) have realistic data.\n' +
        '- Apply the SAME backfill rule the 6.10.3 migration uses (idempotent: ' +
        're-seeding does not duplicate the org / memberships) so seed + ' +
        'migrate agree.\n' +
        '- If the plan-seed world models MORE than one workspace, attach them ' +
        'under `moooon` (or a second seeded org if the demo needs the ' +
        'multi-org switcher case) — pick whichever exercises the org switcher ' +
        '+ cross-workspace roster. Document the choice in the seed module.\n\n' +
        '## Acceptance criteria\n\n' +
        '- After `pnpm db:seed`, the `moooon` `Organization` exists, owns its ' +
        'workspace(s) (each workspace’s `organizationId` points at it), and ' +
        'has an owner `OrganizationMembership` for the seed owner + a few ' +
        'members at varied org-roles.\n' +
        '- Re-running `pnpm db:seed` is idempotent (no duplicate org / ' +
        'memberships) and agrees with the 6.10.3 migration backfill.\n' +
        '- The seeded world satisfies the 6.10.4 gate (no seeded workspace is ' +
        'orphaned from an org; the seed owner can administer it as org ' +
        'owner).\n\n' +
        '## Context refs\n\n' +
        '- 6.10.3 — the schema + the backfill rule the seed mirrors ' +
        '(idempotent).\n' +
        '- `motir-core/scripts/plan-seed/seed.ts` — the loader to extend (it ' +
        'already builds the `moooon`/`motir` workspace + project tree).\n' +
        '- 6.10.4 — the gate the seeded data must satisfy.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer (the seed goes through the same ' +
        'repositories where practical).',
      dependsOn: ['6.10.3'],
    },
    {
      id: '6.10.7',
      title: 'Vitest — org model + membership gating + backfill',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'Lock the org tier with tests over a real Postgres (the project ' +
        'convention; the only allowed `vi.mock` is `getSession()`). Exercise ' +
        'the model, the gating, and the backfill for real.\n\n' +
        '**The model + repositories (6.10.3):**\n\n' +
        '- An org + an `OrganizationMembership` create/read round-trips; the ' +
        '`(organizationId, userId)` uniqueness holds; the ' +
        '`Workspace.organizationId` relation resolves both ways.\n' +
        '- Write repo methods require `tx` (a compile-time guarantee; assert ' +
        'the create runs inside a transaction).\n\n' +
        '**The access gating (6.10.4):**\n\n' +
        '- A user who is a member of a WORKSPACE but NOT of its ORG is DENIED ' +
        'access (org membership gates workspace access) and sees 404-not-403 ' +
        'cross-tenant.\n' +
        '- An org OWNER/ADMIN is granted admin-equivalent access to EVERY ' +
        'workspace under the org (the role composes above the 6.4 ' +
        '`MemberRole`); an org MEMBER falls back to their per-workspace ' +
        'role.\n' +
        '- **Membership direction (6.10.2 §5):** adding a user to a WORKSPACE ' +
        'auto-creates their org membership (assert the `OrganizationMembership` ' +
        'row appears); adding a user to the ORG creates NO workspace membership ' +
        '(assert an org-only member reaches zero workspaces until explicitly ' +
        'added); removing from the org revokes all workspace access while ' +
        'removing from a workspace leaves the org membership intact.\n' +
        '- The cross-workspace member listing returns members across the ' +
        'org’s workspaces and PAGINATES (assert a page boundary, not a ' +
        'full-table load — the at-scale rule).\n' +
        '- A role change / removal is one transaction; a concurrent ' +
        'membership change serializes via the row lock (no lost update).\n\n' +
        '**The backfill (6.10.3):**\n\n' +
        '- Seeding pre-org workspaces then running the backfill creates ' +
        'exactly ONE default org per workspace, points each at it, and makes ' +
        'an owner membership; NO workspace is left with a null ' +
        '`organizationId`; re-running the backfill is idempotent (no ' +
        'duplicates).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The above cases pass over a real Postgres (only `getSession()` ' +
        'mocked); the gating + backfill + pagination are exercised for real, ' +
        'not asserted on mocks.\n' +
        '- The member-of-workspace-but-not-org denial, the org-owner-spans-' +
        'all-workspaces grant, and the one-default-org-per-workspace backfill ' +
        'each have a direct test.\n' +
        '- New service/repo code respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage); the empty-input / no-membership ' +
        '/ idempotent-backfill guards each have a direct test (a new repo ' +
        'method’s empty-input branch needs its own assertion or the gate ' +
        'fails).\n\n' +
        '## Context refs\n\n' +
        '- 6.10.3 / 6.10.4 (the schema + gating under test).\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + § coverage ' +
        'gate.\n' +
        '- `motir-core/tests/helpers/db.ts` — the per-test truncation helper ' +
        'the suite runs over.',
      dependsOn: ['6.10.4'],
    },
    {
      id: '6.10.8',
      title: 'E2E — create an org, attach workspaces, manage cross-workspace members',
      status: 'in_progress',
      type: 'e2e',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'A Playwright end-to-end flow proving the org tier works from the ' +
        'shell: create/administer an org, attach workspaces, and manage ' +
        'cross-workspace members — the customer-facing org admin path the ' +
        '6.10.5 UI ships.\n\n' +
        '**The flow:**\n\n' +
        '1. As the seeded org owner, open the org switcher in the shell — the ' +
        '`moooon` org is the active org; its workspace(s) are listed under it ' +
        'by the workspace switcher.\n' +
        '2. Open org settings — rename the org (or edit org metadata) and ' +
        'confirm it saves (and that there is NO billing/credit surface — ' +
        '7.12.5 / Epic 8).\n' +
        '3. Open cross-workspace member management — see the roster across the ' +
        'org’s workspaces (paginated); invite/add a member to the org, set ' +
        'their org role (admin), and confirm they appear with that role; ' +
        'change a role; remove a member.\n' +
        '4. Confirm GATING: a user who is in a workspace but NOT in the org ' +
        'cannot reach that workspace (a separate browser context / seeded ' +
        'non-org-member sees not-found, not forbidden — 404-not-403); an org ' +
        'admin can administer every workspace under the org.\n' +
        '5. (If the seed models a second org) switch orgs via the switcher and ' +
        'confirm the workspace switcher re-scopes to the other org’s ' +
        'workspaces.\n\n' +
        '**Harness.** Follow the prodect E2E run-harness conventions (run the ' +
        'dev server + the seeded DB; the selector gotchas — combobox option = ' +
        'label+secondary; exact/level on heading selectors; the empty-state ' +
        'headings). Drive the real UI, not API shortcuts.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The flow passes headless in CI: org switcher → org settings ' +
        'rename → cross-workspace member add/role-change/remove → the gating ' +
        'assertion (member-of-workspace-but-not-org is denied 404-not-403; org ' +
        'admin spans all workspaces).\n' +
        '- The member roster is asserted paginated (a page control / lazy ' +
        'load, not all rows at once).\n' +
        '- No billing/credit/checkout surface appears anywhere in the flow ' +
        '(7.12.5 / Epic 8).\n' +
        '- The test drives the real UI (no API-only shortcuts) and uses the ' +
        'prodect E2E selector conventions.\n\n' +
        '## Context refs\n\n' +
        '- 6.10.5 — the org admin UI under test.\n' +
        '- `motir-core/e2e/` — the existing Playwright specs + the ' +
        'run-harness + selector conventions to mirror.\n' +
        '- 6.10.6 — the seeded `moooon` org + members the flow runs against.',
      dependsOn: ['6.10.5'],
    },
    {
      id: '6.10.9',
      title:
        'Copy-on-create — seed a new workspace’s config from the source workspace (the "looks-inherited" behaviour)',
      status: 'cancelled',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 75,
      descriptionMd:
        '> **❌ CANCELLED (Yue, 2026-06-14) — will NOT be built. Kept as a ' +
        'tombstone for traceability.** This card assumed config lives at the ' +
        'org/workspace level and a new workspace would inherit it. The shipped ' +
        'schema disagrees: workflow statuses, boards, custom fields, labels, ' +
        'components, automation rules and saved filters are all **`projectId`-' +
        'scoped** (only dashboards are workspace-scoped), seeded per-project at ' +
        'project-create from hardcoded defaults — and a freshly-created ' +
        'workspace has **no project**, so there is nothing workspace-level to ' +
        'clone. Decision (**Path B**, Yue): a new workspace simply starts with ' +
        'its **own fresh defaults** — different custom fields / components / ' +
        'workflow per workspace is desirable, not a bug — and config is **not ' +
        'copied automatically**. The shipped 6.10.5 create flow ' +
        '(`createWorkspaceAction` → name-only `workspacesService.createWorkspace`) ' +
        'already does exactly this, so the cancellation requires **no code ' +
        'change**. If an "open pre-configured" experience is ever wanted, it ' +
        'belongs at **PROJECT** create (copy settings from an existing project — ' +
        'Jira’s actual shape, the cited mirror), as a future enhancement, NOT ' +
        'here. The 6.10.10 design’s copy-source-picker / "what gets copied" ' +
        'panels are **superseded** by this decision (the dialog stays ' +
        'name-only). Original spec below, retained for the record.\n\n' +
        '---\n\n' +
        'Make a newly-created workspace open **already configured like the ' +
        'workspace it was created from**, so multi-workspace *looks* inherited — ' +
        'WITHOUT any data-inheritance layer (6.10.2 §6e). When a user creates a ' +
        '2nd+ workspace under an org, **deep-copy the source workspace’s config** ' +
        'into the new workspace in the SAME transaction as the workspace ' +
        'creation; thereafter the workspaces are fully independent and either ' +
        'can overwrite. There are NO org-level config defaults, NO override ' +
        'rows, and NO runtime resolution — config stays purely ' +
        '`Workspace`-scoped; this is a one-time snapshot at creation.\n\n' +
        '**Why its own subtask.** The copy spans MANY `workspaceId`-scoped ' +
        'config tables, each with intra-workspace references that must be ' +
        'remapped to the new workspace’s rows (e.g. a board column points at a ' +
        'workflow status; an automation rule references a field/label) — a ' +
        'naive row-copy that keeps old ids would cross-link the two workspaces. ' +
        'So it needs a dedicated, carefully-ordered clone with an old→new id ' +
        'map, not a one-liner folded into 6.10.4.\n\n' +
        '**What to copy (the workspace-config surface):** workflow statuses + ' +
        'transitions, custom field definitions, labels, components, board(s) + ' +
        'board columns + column→status mappings, automation rules, dashboards, ' +
        'and saved filters — i.e. the `workspaceId`-scoped config models, NOT ' +
        'the work items / sprints / comments (content, never copied). The source ' +
        'workspace = the org’s existing workspace the user is creating from (for ' +
        'the first split, the sole existing workspace); document the selection.\n\n' +
        '**4-layer (motir-core/CLAUDE.md).** A `workspacesService` flow ' +
        '(extending the existing create-workspace path that 6.10.4 made ' +
        'org-aware) wraps the create + the clone in ONE `prisma.$transaction`; ' +
        'each table’s rows are copied via its repository (writes require `tx`); ' +
        'the old→new id map is built in the service. Returns the new workspace ' +
        'DTO. Idempotency is not required (each create is a fresh workspace), but ' +
        'the clone must be ALL-or-nothing (one tx).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Creating a workspace under an org with an existing workspace produces ' +
        'a new workspace whose workflow statuses/transitions, custom fields, ' +
        'labels, components, board(s)+columns+column→status mappings, automation ' +
        'rules, dashboards and saved filters MATCH the source at creation time.\n' +
        '- **No cross-linking:** every copied row references the NEW workspace’s ' +
        'rows (the id map is applied) — e.g. a copied board column points at the ' +
        'copied status, never the source workspace’s; editing one workspace’s ' +
        'config does not affect the other.\n' +
        '- Work items, sprints, comments and other CONTENT are NOT copied (only ' +
        'config).\n' +
        '- The whole create+clone is ONE transaction (all-or-nothing); the ' +
        'service owns it, repositories are single-op with required `tx`.\n' +
        '- No org-level config / override / resolution is introduced (config ' +
        'stays `Workspace`-scoped — the copy is a one-time snapshot).\n\n' +
        '## Context refs\n\n' +
        '- 6.10.2 §6e — the copy-on-create decision (no data inheritance).\n' +
        '- 6.10.10 — the create-workspace flow DESIGN this implements (the ' +
        'dialog, the copy-source picker, the states); build to it, do not ' +
        'improvise the surface.\n' +
        '- 6.10.4 — the org-aware create-workspace flow this extends + the ' +
        'signup auto-provision (the first workspace) it mirrors.\n' +
        '- `motir-core/prisma/schema.prisma` — the `workspaceId`-scoped config ' +
        'models to clone (workflowStatuses/transitions, customFieldDefinitions, ' +
        'labels, components, boards/boardColumns/boardColumnStatuses, ' +
        'automationRules, dashboards, savedFilters) + their intra-workspace FKs ' +
        'to remap.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer (service owns the tx; repos ' +
        'single-op, required `tx` on writes).',
      dependsOn: ['6.10.4', '6.10.10'],
    },
    {
      id: '6.10.10',
      title:
        'Design — the create-workspace flow: the dialog + copy-on-create source picker + the tier-2 first-reveal + states',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        '**Type:** design (the planning-time design gate, Principle #13 + the ' +
        'design-reference rule). The org-admin design (6.10.1) draws **"New ' +
        'workspace" only as a ROW in the always-present org menu** ("Adds the ' +
        'workspace switcher") — it does NOT draw the surface that row OPENS. ' +
        'Story 1.2 never drew it either (1.2.1’s switcher mockup ends at the ' +
        'membership list + "Invite teammates"). So the create-workspace flow ' +
        'is currently UNDESIGNED, and the implementation cards that build it ' +
        '(6.10.5 wires the org-menu entry; 6.10.9 builds the create+clone) ' +
        'would have to improvise it — forbidden (notes.html #31; design gate ' +
        '"unspecified == no design"). This card draws it.\n\n' +
        '**Why a NEW card, not a 6.10.1 reopen.** 6.10.1 is shipped/done; the ' +
        'create-workspace flow is a distinct, multi-state surface (a launched ' +
        'dialog + a source picker + a header/settings TRANSITION) that earns ' +
        'its own asset. It lives in the SAME design area: extend ' +
        '`motir-core/design/org-admin/` with a same-basename trio ' +
        '`create-workspace.{mock.html,design-notes.md,png}` (the design-asset ' +
        'is THREE files — notes + `.mock.html` source + a `.png` export; the ' +
        'PNG is the board-visible face and is REQUIRED — MOTIR.md § design ' +
        'DoD). Build it from the SHIPPED design system (the `components/ui/*` ' +
        'primitives + the `--el-*` colour tokens + the `[data-display-style]` ' +
        'shape tokens) — no `.pen`, no Tier-0 `--color-*`, no hand-rolled ' +
        'spacing.\n\n' +
        '**Mirror (cited — the create-with-config-copy shape).** Jira’s ' +
        '"create project" lets you **share/copy settings from an existing ' +
        'project** (the scheme-copy dialog) so the new project opens already ' +
        'configured; Linear’s create-team flow names the team and starts it ' +
        'from the workspace’s defaults. Draw THAT shape — a name-it dialog ' +
        'whose new workspace is **seeded by copying a source workspace’s ' +
        'config** (6.10.2 §6e / 6.10.9), distinct from a blank create.\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the ' +
        'multi-panel rule, mistake #31):\n\n' +
        '- **Panel 1 — the entry point in context.** Re-show the always-' +
        'present org menu (from 6.10.1) with **"New workspace"** highlighted as ' +
        'the launch point, so the dialog’s origin is unambiguous. Note that at ' +
        'ONE workspace this is the ONLY path to tier 2 (the workspace switcher ' +
        'is still hidden).\n' +
        '- **Panel 2 — the create dialog, ONE existing workspace (the first ' +
        'split).** A `Dialog` composing `FormField` + `Input` for the ' +
        'workspace **name** (+ the auto-derived **slug/identifier**, shown ' +
        'editable or as a passive preview — DECIDE and draw, mirroring how ' +
        '1.2/project-create handle the slug) + the create/cancel `Button`s. ' +
        'Because exactly one workspace exists, the copy source is IMPLICIT — ' +
        'draw a **passive "Starts with a copy of {Workspace}’s setup ' +
        '(workflows, fields, labels, boards…)" affordance**, NOT an active ' +
        'picker. NAME the exact copy-scope copy string so the user knows what ' +
        'is and isn’t copied (config yes; work items / content no — 6.10.9).\n' +
        '- **Panel 3 — the create dialog, ≥2 existing workspaces (the source ' +
        'picker).** The same dialog, now with an **explicit "Copy settings ' +
        'from" picker** (a `Select`/`Combobox` of the org’s workspaces, ' +
        'DEFAULTING to the active workspace) — this is the 6.10.9 ' +
        '"source workspace" choice made visible. Draw the chosen-source row + ' +
        'the "what gets copied" explanation. (Optionally a "Start blank" ' +
        'option — DECIDE in the notes whether blank-create is offered at all, ' +
        'given copy-on-create is the product’s "looks-inherited" behaviour.)\n' +
        '- **Panel 4 — the tier-2 FIRST-REVEAL transition.** The before→after ' +
        'of completing the create that takes the org from 1→2 workspaces: the ' +
        'header goes from `Acme` to **`Acme › {New Workspace}`** (the workspace ' +
        'switcher renders for the FIRST time), and the single folded Settings ' +
        'home SPLITS into a per-workspace Settings area (6.10.2 §6d). Draw both ' +
        'states and NAME, in the notes, **where the user lands after create** ' +
        '(the new workspace active, on its project list / a "create your first ' +
        'project" empty state — DECIDE) and where focus goes.\n' +
        '- **Panel 5 — states + permission gating.** The **submitting/creating** ' +
        'state (the clone is one all-or-nothing tx — 6.10.9 — so the dialog ' +
        'shows a pending state and stays open until it resolves), the **error** ' +
        'state (name/slug collision; copy/clone failure rolls the whole tx ' +
        'back — show a single in-dialog error, not a half-created workspace), ' +
        'and the **permission** treatment: WHO may create a workspace ' +
        '(org owner/admin per the 6.10.5 gate) — a member without the right ' +
        'sees NO "New workspace" entry (or a disabled+explained one — DECIDE ' +
        'and draw, consistent with how 6.10.1 gated the not-an-org-admin ' +
        'state).\n\n' +
        'Also write **`design/org-admin/create-workspace.design-notes.md`** ' +
        'naming the exact primitives per surface (`Dialog`, `FormField`, ' +
        '`Input`, `Select`/`Combobox`, `Button`, the switcher pattern), the ' +
        'exact copy strings (in/for the `orgAdmin` i18n namespace 6.10.5 adds), ' +
        'the per-`--el-*` colour role per element (use the palette, not ' +
        'grey-only — finding #54), and the DECISIONS this card is pinning so ' +
        'they are fixed at design time, NOT improvised in code: (a) slug ' +
        'editable vs auto/preview; (b) whether a "Start blank" option exists ' +
        'alongside copy-on-create; (c) the post-create landing + focus; (d) the ' +
        'who-can-create gate’s visual treatment. It MUST cross-reference 6.10.9 ' +
        '(the copy-on-create scope it visualises) and state that no ' +
        'billing/credit surface appears here (7.12.5 / Epic 8). Include the ' +
        '"primitives composed (no hand-rolling)" checklist.\n\n' +
        '**Branch.** `design/PROD-6.10.10-create-workspace-flow`. The ' +
        '`design/*` prefix gate skips CI E2E + the Vercel preview deploy ' +
        '(MOTIR.md § Plan-seed Workflow) — this PR only edits ' +
        '`design/org-admin/create-workspace.**`, no app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/org-admin/create-workspace.mock.html` exists and ' +
        'renders the five panels above, referencing ONLY `--el-*` tokens + ' +
        '`[data-display-style]` shape tokens (no Tier-0 `--color-*`, no ' +
        'hand-rolled spacing); a same-basename `.png` export is committed (the ' +
        'board-visible face).\n' +
        '- BOTH copy-source cases are drawn: the implicit single-workspace ' +
        '"starts with a copy of {Workspace}" affordance AND the ≥2-workspace ' +
        '"Copy settings from" picker (defaulting to the active workspace) — the ' +
        '6.10.9 source choice made visible.\n' +
        '- The tier-2 FIRST-REVEAL is drawn: header `Acme` → `Acme › {ws}` ' +
        '(switcher appears) and the Settings home split, with the post-create ' +
        'landing + focus named in the notes.\n' +
        '- The submitting / error (tx-rollback) / permission-gated states are ' +
        'drawn; the create is shown as one all-or-nothing op (no half-created ' +
        'workspace on failure).\n' +
        '- `design/org-admin/create-workspace.design-notes.md` exists, names ' +
        'every primitive + every copy string + the per-element `--el-*` role, ' +
        'and PINS the four decisions (slug edit; blank-vs-copy; post-create ' +
        'landing; who-can-create treatment); it cross-refs 6.10.9 and states ' +
        'billing is 7.12.5 / Epic 8 (absent here).\n' +
        '- The mockup composes ONLY shipped primitives — if a genuinely new ' +
        'primitive is needed, that is a NEW `design/` subtask, not a code ' +
        'workaround.\n\n' +
        '## Context refs\n\n' +
        '- 6.10.1 — the shipped org-admin design + `design-notes.md` (the org ' +
        'menu this dialog launches from; mirror its layout + notes shape).\n' +
        '- 6.10.2 §6d/§6e — the progressive-disclosure first-reveal + the ' +
        'copy-on-create (no-inheritance) decision this visualises.\n' +
        '- 6.10.9 — the create+clone backend this is the UI for (the exact ' +
        'config surface copied; the one-tx all-or-nothing semantics).\n' +
        '- 6.10.5 — the org-admin UI that wires the "New workspace" entry + ' +
        'renders this dialog (consumes this design).\n' +
        '- Story 1.2 (1.2.1) — the workspace switcher / settings / ' +
        'delete-confirmation dialog patterns to compose atop.\n' +
        '- `motir-core/components/ui/Dialog.tsx`, `Input.tsx`, `Button.tsx`, ' +
        'the `Select`/`Combobox` + `FormField` primitives — the composable ' +
        'surface.\n' +
        '- `motir-core/app/globals.css` — the `--el-*` colour + ' +
        '`[data-display-style]` shape tokens.\n' +
        '- Jira create-project "share settings" + Linear create-team — the ' +
        'cited create-with-config-copy mirror.',
      dependsOn: ['6.10.1', '6.10.2'],
    },
    {
      id: 'bug-org-last-owner-race',
      kind: 'bug',
      title:
        'Org last-owner guard has no row lock — concurrent removals can drop an org to zero owners',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        '**Type:** bug · **Parent:** Story 6.10 · **Discovered in:** Subtask ' +
        '6.10.7 (the org-tier Vitest matrix) · **In shipped code from:** 6.10.4 ' +
        '(`organizationsService`).\n\n' +
        'The last-owner guard in `organizationsService.removeMember` / ' +
        '`changeMemberRole` is NOT race-safe. It reads ' +
        '`organizationMembershipRepository.countOwnersByOrg` — a plain ' +
        '`SELECT count(*)` with **no `SELECT … FOR UPDATE`** — inside ' +
        '`withOrgContext`, which opens a default-isolation (READ COMMITTED) ' +
        'transaction. So two concurrent removals of the **two** owners of a ' +
        '2-owner org both observe `count = 2`, both pass the guard, and both ' +
        'delete → the org drops to **ZERO owners** (an unadministrable org). ' +
        'The same lost-update shape affects concurrent **demotion** of two ' +
        'owners via `changeMemberRole`.\n\n' +
        '**Reproduced deterministically** in 6.10.7 while writing the ' +
        'concurrency suite: two `removeMember` self-leaves fired with ' +
        '`Promise.allSettled` on a warm connection pool leave `owners = 0` ' +
        '(it only serializes — masking the bug — when the pool is cold, e.g. a ' +
        'single test in isolation). The `removeMember` / `changeMemberRole` ' +
        'doc-comments CLAIM "the count and the update run in one transaction so ' +
        'a concurrent demotion can’t drop the org to zero owners" — that ' +
        'comment is WRONG without a lock: a same-transaction COUNT does not ' +
        'lock the rows another transaction deletes.\n\n' +
        '**Why not fixed in 6.10.7:** 6.10.7 is a `type: test` subtask; per ' +
        'the CLAUDE.md debug protocol a pre-existing bug in shipped code is ' +
        'logged + surfaced, NOT absorbed into the test PR, and no flaky / race-' +
        'dependent assertion is shipped. The 6.10.7 suite locks only the ' +
        'deterministic, genuinely-protected unique-constraint races; this card ' +
        'owns the fix + its regression test.\n\n' +
        '**Root cause / fix.** The guard reads a derived value (the owner ' +
        'count) then writes based on it, with no lock between — the ' +
        'lock-before-read-derived-update rule (CLAUDE.md § 4-layer: "reads ' +
        'inside transactions that guard a write use `SELECT FOR UPDATE` when ' +
        'concurrent writes could race"). Fix: make the last-owner guard LOCK ' +
        'the org’s owner membership rows before counting — e.g. a ' +
        '`countOwnersByOrgForUpdate` repository read issued as `$queryRaw(… ' +
        'WHERE "organizationId" = $1 AND "role" = \'owner\' FOR UPDATE)` inside ' +
        'the same `withOrgContext` tx — so the second concurrent remover blocks ' +
        'until the first commits, re-counts, and correctly hits ' +
        '`LastOrgOwnerError`. (Alternatively escalate the guarded flows to ' +
        'SERIALIZABLE + retry on 40001, but the row-lock is the cheaper, ' +
        'localised fix and matches the existing rule.) Audit the sibling ' +
        '`workspacesService.removeMember` last-member guard (`countByWorkspace`, ' +
        'same non-locking shape) and apply the same fix if it shares the gap.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The last-owner guard locks the owner rows before counting; two ' +
        'concurrent removals of the two owners of a 2-owner org leave exactly ' +
        'ONE owner (the second hits `LastOrgOwnerError`), never zero — same for ' +
        'concurrent demotion via `changeMemberRole`.\n' +
        '- A regression test asserts the invariant over a real Postgres with a ' +
        'WARM pool (mirroring the 6.10.7 concurrency describe — the race only ' +
        'manifests when the two transactions truly run in parallel); the ' +
        'sequential last-owner guard still passes.\n' +
        '- The `workspacesService` last-member guard is audited; fixed if it ' +
        'shares the gap, or a one-line note says why it’s safe.\n' +
        '- 4-layer respected (the locking read is a single-op repository method ' +
        'taking `tx`; the service composes it in the existing transaction).\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/lib/services/organizationsService.ts` — ' +
        '`assertNotLastOwner`, `removeMember`, `changeMemberRole`.\n' +
        '- `motir-core/lib/repositories/organizationMembershipRepository.ts` — ' +
        '`countOwnersByOrg` (add the FOR-UPDATE variant).\n' +
        '- `motir-core/lib/organizations/context.ts` — `withOrgContext` (the ' +
        'READ COMMITTED tx the guard runs in).\n' +
        '- `motir-core/tests/organizations-tier.test.ts` — the 6.10.7 ' +
        'concurrency describe + the NOTE documenting this race (the regression ' +
        'test slots in beside it).\n' +
        '- `motir-core/CLAUDE.md` § lock-before-read-derived-update / ' +
        '`SELECT FOR UPDATE`.',
      dependsOn: ['6.10.4'],
    },
  ],
};
