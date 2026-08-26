# ADR: The `Organization` root tier + the billing entity + org roles vs the 6.4 workspace role

- **Status:** Accepted (2026-06-12, billing-entity decision locked with Yue; revised
  2026-06-13 — precise Atlassian-vs-Linear mirror citation, multi-org membership (N:N),
  asymmetric org↔workspace membership direction (§5), and progressive disclosure +
  auto-provisioning + settings-collapse + copy-on-create (§6))
- **Story / Subtask:** 6.10 (Organization (root-account) tier + org admin) · Subtask 6.10.2
- **Supersedes / superseded by:** none
- **Consumed by:** 6.10.3 (schema — `Organization` + `OrganizationMembership` +
  `Workspace.organizationId` + the backfill migration), 6.10.4 (org-scoped services +
  the access gate), 6.10.5 (org admin UI), 6.10.6 (seed loader), 6.10.7 (vitest),
  6.10.8 (e2e) — and, separately and later, the **orchestrator** that re-keys Story
  7.12's `CreditLedger` to the org, plus Story **7.12.5** (the org-scoped usage view)
  and **10.1.5** (the platform-wide rollup).

> Convention (set by the first ADR, `work-item-type-taxonomy.md`): a decision record
> is a markdown file under `docs/decisions/`, named for the thing it fixes, structured
> **Status → Context → Decision → Consequences**, with the load-bearing facts pinned in
> explicit tables/lists so downstream code has one authoritative source to implement
> against. No application behaviour ships in this subtask — the shapes it freezes are
> what make the rest of Story 6.10 buildable.

---

## Context

Motir's tenancy today **tops out at the `Workspace`**. The live hierarchy is
`Workspace → Project`, gated by `WorkspaceMembership` (a `User` ↔ `Workspace` join
carrying a workspace-scoped `MemberRole`; Story 6.4 added the per-project sibling
`ProjectMembership` + `project.accessLevel` below it). There is **no tier above the
workspace** — no structure a customer "is", no parent that owns N workspaces, and
critically **no entity for billing + usage to roll up to**.

Story 6.10 introduces that missing top tier and its administration surfaces. The data
foundation (6.10.3), the access gate (6.10.4), the admin UI (6.10.5), the seed
(6.10.6), and the tests (6.10.7/6.10.8) all build against the shapes this ADR fixes.
Six things must be frozen first, because each is referenced by more than one
downstream subtask and a later org-aware story (notably the Epic-7 credit work) keys
off them:

1. **What the new tier is called** — and, load-bearing, that it is **NOT** the
   existing `model Account`.
2. **The hierarchy** it inserts (`Organization → Workspace → Project`) and the FK that
   wires it.
3. **That the org is THE billing entity** — the locked decision that gives the later
   `CreditLedger` re-keying a home, while 6.10 itself ships no credit surface and takes
   no dependency on Epic 7.
4. **The org role model** and how it composes with the 6.4 workspace `MemberRole` at an
   access check.
5. **The access-gating rule, the asymmetric org↔workspace membership direction, and the
   migration backfill semantics** for existing data.
6. **Progressive disclosure + auto-provisioning** — one model + one set of surfaces
   serving individual / small-org / enterprise, revealing a tier only at count ≥ 2, with
   the org auto-created at signup; and how settings collapse / new-workspace config is
   seeded.

### The naming collision (the reason this ADR leads with a name)

`prisma/schema.prisma` **already contains `model Account`** — but it is **Better-Auth's
auth-provider-link model**: the OAuth / credential grant rows a `User` authenticates
through (`providerId`, `accountId`, `accessToken`, the Argon2id `password` hash, …,
`@@unique([providerId, accountId])`, `@@map("account")`). It is **not** a tenancy tier,
and the name is taken. "Account" is the obvious word for a customer's root tenant, so
the risk is real: a future contributor "reuses" `Account` for billing tenancy and
silently entangles the billing root with auth-provider links. This ADR forecloses that.

### The verified mirror (rung 1 — cited, not asserted)

Per the decision-authority ladder, the org-above-workspace shape is taken from how the
mirror products actually implement it:

- **Atlassian / Jira Cloud — the mirror for BOTH the nesting AND org-level billing.**
  The **Organization** is the topmost structure; it controls **licensing, billing, and
  security** across every site/product, administered at `admin.atlassian.com`. The **org
  admin** is the highest admin level and is the one who "also see[s] the billing
  details"; **site admins** below it do not. **An Atlassian org has ONE OR MULTIPLE
  sites under it**, and a single account can hold access to many sites within the org —
  which is exactly Motir's `Organization → N Workspace` nesting. A single account can
  also belong to / administer **multiple organizations** and pick one from a switcher.
  (Atlassian Community — "Jira's Structure — Orgs, Sites, Spaces"; "Bring multiple cloud
  sites under one Organisation"; Atlassian Support — "Navigate Atlassian Administration";
  "Switch between multiple Atlassian accounts"; "types of admin roles"; resolution.de —
  "Organizations and Sites".) → Motir's `Organization` = Atlassian's **org** (billing +
  identity root); Motir's `Workspace` ≈ Atlassian's **site** (the container under it).
- **Linear — the mirror for org-level BILLING ONLY, NOT for the nesting.** A Linear
  **workspace** is "the home for all issues and interactions in an organization" — i.e.
  the workspace **is** Linear's org-root; the workspace **Owner** carries "the most
  sensitive settings like **billing**, security, and audit logs", and separate
  workspaces have "separate billing plans". That backs Motir's billing-at-the-root
  decision. **But Linear has NO sub-workspace tier:** its **teams** live inside a single
  workspace and are NOT workspaces (a Linear team ≈ a Motir project/group, not a Motir
  workspace). (Linear Docs — Workspaces; Concepts; Members and roles.) → A Linear
  **workspace maps to a Motir `Organization`**, not to a Motir `Workspace`; Linear does
  not demonstrate the org→workspace nesting, only billing-at-root. One Linear account can
  belong to many workspaces — "one account in many ORGANIZATIONS" in Motir's terms.

So the durable shape: **a single root tenant that owns billing + cross-workspace
membership, with workspaces nested under it, and an org-level owner/admin role above the
workspace-level role.** The **nesting** is mirrored by **Atlassian (org → multiple
sites)**; **Linear** backs only the **billing-at-root** half (its workspace maps to
Motir's org). A single account may belong to **multiple organizations** (verified above),
so `OrganizationMembership` is a many-to-many `User ↔ Organization` join and the shell
carries an org switcher.

> **Membership vs managed identity — do not conflate (verified).** Atlassian separates
> two account↔org relationships: **membership/admin** is **many-to-many** (the switcher;
> what Motir builds here), while **managed identity** (an account is _claimed/managed by_
> exactly **one** org via a verified domain, for SSO / password policy) is **one-to-one**.
> They are orthogonal: being managed by org A does not stop you being a member of orgs B
> and C. Motir's `OrganizationMembership` is the **membership** relationship (N:N). The
> one-to-one managed-identity relationship is a **future SSO/domain-claim feature** (an
> Atlassian-Access equivalent) — when it lands it is a separate nullable
> `User.managedByOrganizationId`, **never** a constraint that makes membership 1:1.

---

## Decision

### 1. The new tier is `Organization`, **NOT** Better-Auth `Account`

The root tenant tier is the **new model `Organization`**, with membership join
**`OrganizationMembership`** (mirroring the shipped `WorkspaceMembership`). The existing
`model Account` is **left untouched**: it is Better-Auth's OAuth/credential
auth-provider-link, not a tenancy tier, and **must never be reused** for org/billing
tenancy.

| Concern             | Model                          | Notes                                                          |
| ------------------- | ------------------------------ | -------------------------------------------------------------- |
| Auth provider links | `Account` (Better-Auth)        | OAuth/credential grants per `User`. **Do not reuse / rename.** |
| Root tenant         | `Organization` (NEW)           | The customer's account; parent of N workspaces; billing root.  |
| Org membership      | `OrganizationMembership` (NEW) | `User` ↔ `Organization` join; carries the org role.            |

This is recorded so no later subtask "saves a model" by overloading `Account`.

### 2. The hierarchy: `Organization → N Workspace → Project`

The decision inserts `Organization` **above** `Workspace` and adds
**`Workspace.organizationId`** — a **non-nullable** FK (after backfill; see §5) so every
workspace belongs to **exactly one** org.

```
Organization                 ← NEW root tenant (billing + identity root)
   └── Workspace (N)          ← Workspace.organizationId → Organization  (NEW FK)
         └── Project (N)      ← unchanged (Workspace.id ← Project.workspaceId)
```

Mirror mapping (from Context):

| Motir          | Atlassian | Linear (no middle tier) | Owns                                    |
| -------------- | --------- | ----------------------- | --------------------------------------- |
| `Organization` | Org       | **Workspace** (=root)   | **billing**, identity, cross-ws members |
| `Workspace`    | Site      | — (no equivalent)       | projects, boards, the PM substrate      |
| `Project`      | (Space)   | Team / its projects     | issues / sprints                        |

The Linear column shows why it mirrors only billing-at-root and **not** the nesting: a
Linear workspace IS the org-root (maps to Motir's `Organization`), and Linear has no
sub-workspace tier — its teams sit at the project level, not the workspace level. The
nesting comes from Atlassian (org → one-or-multiple sites).

**FK-as-`@relation` (binding on 6.10.3).** `Workspace.organizationId` and both
`OrganizationMembership` FKs MUST be modelled as Prisma `@relation`s on **both** sides
(forward field + back-relation), never a raw-SQL-only FK left as a bare scalar — per the
`motir-core/CLAUDE.md` FK-as-`@relation` rule (a split puts the schema graph and the
migrate-built DB in permanent drift, so `prisma migrate dev` keeps re-proposing
`DROP CONSTRAINT`). The relations to declare:

- `Workspace.organization` ↔ `Organization.workspaces`
- `OrganizationMembership.organization` ↔ `Organization.memberships`
- `OrganizationMembership.user` ↔ `User.organizationMemberships`

### 3. The `Organization` is **THE BILLING ENTITY** (Yue, locked)

**Credits and usage roll up to the `Organization`.** The org is the entity a customer is
billed as; usage from every workspace and project under it aggregates to the org.

This ADR only **declares** the billing entity — it ships no billing/credit surface and
takes **no dependency on Epic 7 / Story 7.12**. The consequences are owned elsewhere
(forward work, recorded here so the declaration has a home, NOT a 6.10 dependency):

| Concern                                                                                  | Owner (forward — NOT a 6.10 dep)         |
| ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| Re-key 7.12's `CreditLedger` to the org                                                  | the orchestrator (separately, post-7.12) |
| Metering rows (`PlanningRun` / `AgentRun`) carry `project + workspace + org` for rollups | the orchestrator / 7.12                  |
| The **org-scoped usage/credit VIEW**                                                     | **Story 7.12.5**                         |
| The **platform-wide (cross-org) rollup**                                                 | **Story 10.1.5**                         |
| Billing checkout / pricing                                                               | **Epic 8**                               |

**Cross-story dep audit (notes.html #32):** every 6.10 leaf depends only on same-story
`6.10.x` ids — there is **no `dependsOn` on 7.12 / 7.x / 10.x**. The billing-entity fact
lives in **prose** (this ADR), exactly so 6.10 carries no forward dependency. Wiring any
credit read into 6.10 would be a forward dep and is forbidden.

### 4. Org roles vs the 6.4 workspace `MemberRole` — and the precedence rule

A **new org-scoped role enum** is introduced and sits **above** the workspace role; the
6.4 `MemberRole` is **unchanged** and keeps governing in-workspace actions.

| Role layer      | Enum                                                      | Scope         | Granted over                                                                                 |
| --------------- | --------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------- |
| Org (NEW)       | `OrganizationRole` = `owner` \| `admin` \| `member`       | the whole org | org settings, org membership, and **admin over every workspace under the org** (owner/admin) |
| Workspace (6.4) | `MemberRole` = `owner` \| `admin` \| `member` \| `viewer` | one workspace | in-workspace actions (unchanged)                                                             |

Semantics:

- **Org `owner` / `admin`** — administer org settings + org membership, **and** hold
  admin-equivalent access to **every** workspace under the org (the org role composes
  **above** the per-workspace `MemberRole`). `owner` is the single billing/destructive
  authority (mirrors Linear's Owner / Atlassian's org admin); `admin` is org
  administration without owner-only destructive/billing powers. (The precise
  owner-vs-admin power split at the surface level is 6.10.4/6.10.5's to enforce; this ADR
  fixes that both span all workspaces and that `owner ≥ admin ≥ member`.)
- **Org `member`** — has org-tier presence (belongs to the org, can be in its
  workspaces) but **no** cross-workspace admin; within any given workspace they fall back
  to **their own `MemberRole`** there.

**Precedence rule (the load-bearing composition, binding on 6.10.4).** At any
workspace-scoped access check, the effective capability is:

```
effective(user, workspace) =
    if user is org owner/admin of workspace.organization → ADMIN-equivalent (overrides MemberRole)
    else                                                  → the user's workspace MemberRole (6.4), unchanged
```

i.e. the org owner/admin grant is a **ceiling raise** — it can only **grant** access a
workspace role wouldn't, never **reduce** it. A workspace `owner`/`admin` keeps their
powers regardless of org role. This mirrors Atlassian's org-admin-above-site-admin and
Linear's Owner-above-Admin split.

### 5. Access gating + the asymmetric membership direction + the backfill semantics

**Org membership gates workspace access (binding on 6.10.4).** A workspace is reachable
**only** by a member of its `Organization`. Concretely: reaching any workspace-scoped
resource requires `OrganizationMembership(user, workspace.organizationId)` to exist (or
the user to be an org owner/admin of that org). A user who is a member of the
**workspace** but **not** of its **org** is **denied**.

**Membership direction is ASYMMETRIC (Yue, binding on 6.10.4).** Org membership is
**necessary but not sufficient** for workspace access, and the two memberships propagate
in only one direction:

- **Workspace add ⟹ org auto-join (UPWARD invariant, enforced).** Adding a user to a
  **workspace** (a `WorkspaceMembership` create) MUST also create their
  `OrganizationMembership` (role `member`) in that workspace's org if absent, in the
  **same transaction**. You cannot be in a workspace without being in its org.
- **Org add ⟹ NO workspace (no downward propagation) — EXCEPT at exactly ONE workspace.**
  Adding a user to the **org** creates **only** an `OrganizationMembership`. A plain org
  `member` reaches **only** the workspaces they are **explicitly** added to (an org
  owner/admin still spans all _by role_, per §4). So an **"org-only" member in zero
  workspaces is a valid state** — e.g. a billing admin who administers the org but works
  in no workspace.

  **⚠️ THE COUNT-1 ARM (MOTIR-3501, amended 2026-08-26 — the clause this ADR was missing).**
  When the org has **exactly one** workspace, an org add **also** creates that
  workspace's `WorkspaceMembership` (role `member`), in the **same transaction**.

  The asymmetry above is justified by there being a **choice** to withhold: a plain org
  member reaches only the workspaces someone explicitly put them in, which presupposes
  that "which workspace?" is a question with more than one answer. **§6 hides the
  workspace tier entirely below two workspaces**, so at count 1 the two clauses combined
  into a dead end: the invitee was placed into a tier with no UI, no switcher and no
  add-to-workspace action anywhere on the org roster, and their one visible exit — create
  a workspace — flipped the org out of the collapsed state and split the team. The
  billing-admin carve-out is only meaningful once a choice exists, which is the same
  predicate §6 already uses. **At ≥ 2 the asymmetry stands entirely unchanged.**

  **⚠️ WHOSE COUNT — the clause NEITHER §5 NOR §6 stated, and they need OPPOSITE answers.**
  "One workspace" is ambiguous between the **organization's** workspace count and the
  **viewer's** count within that org, and the two coincide only when the viewer belongs to
  every workspace in the org — the founder case, which is why the ambiguity survived.
  - **This clause (§5, MEMBERSHIP) reads the ORGANIZATION's count.** Whether an invitee is
    auto-joined must not depend on which workspaces the _inviting admin_ happens to belong
    to. Under an actor-scoped read this arm would fire in a **two**-workspace org whose
    admin belongs to one of them, creating precisely the membership this section
    withholds.
  - **§6's DISCLOSURE arm reads the VIEWER's count.** A rendered entry point answers "does
    this person have a choice to make?", and a workspace they are not a member of offers
    them none.

  **Do not unify them.** Reading the org's count required a row-level policy that did not
  exist (`workspace_org_member_read`, MOTIR-3512): `workspace`'s RLS admitted a row only
  via the caller's own memberships, so the read answered with the actor's slice and did so
  **silently** — a denied read narrows rather than raising, and 1-where-the-truth-is-2 is
  indistinguishable from a small org.

- **Removal.** Removing a user from the **org** cascades loss of access to **every**
  workspace under it (the gate). Removing them from a **workspace** leaves the org
  membership intact (they remain an org member, just lose that workspace).

**404-not-403 cross-tenant posture preserved (the standing guard, finding #26).** A
non-member of the org sees the workspace as **not-found (404)**, never **forbidden
(403)** — a cross-tenant id must be indistinguishable from a never-existed one, so the
gate never confirms a foreign tenant exists. This extends the existing
`projectAccessService` posture (`ProjectNotFoundError → 404` for missing **or**
cross-workspace ids) up to the org tier.

**Single shared gate, not scattered checks (binding on 6.10.4).** The org check is added
to the **one** authorization helper the workspace-scoped services already call — the 6.4
permission helper is **extended, not duplicated**, and org checks are **not** sprinkled
across N routes. Reads that guard a write take `tx` + `SELECT FOR UPDATE` where a
concurrent membership change could race (the lock-before-read-derived-update rule).

**The migration backfill (binding on 6.10.3 — no orphaned legacy data).** The migration
that adds the tier must leave **no** workspace with a null `organizationId`. The rule:

1. Create `Organization` + `OrganizationMembership` + `enum OrganizationRole`.
2. Add `Workspace.organizationId` **nullable**.
3. **Backfill — one default org per existing workspace (1:1):** for **each** pre-existing
   workspace, create exactly **one** `Organization` (named/slugged from the workspace),
   point the workspace at it, create an `OrganizationMembership(role = owner)` for that
   workspace's owner / first-admin, and — applying the upward invariant to legacy rows —
   create an `OrganizationMembership(role = member)` for **every other existing workspace
   member** — so every legacy row has an org, an org owner, and no workspace member who
   isn't also an org member.
4. Make `Workspace.organizationId` **non-nullable** once every row is set.

The backfill is **idempotent / re-runnable-safe** (re-running creates no duplicate orgs
or memberships) — so the migration, the seed loader (6.10.6), and the tests (6.10.7) all
agree. (1:1 — not "one org for all workspaces" — because the org is the **billing**
entity: collapsing independent existing workspaces into a shared billing root would
silently merge their billing, which no migration should do unasked.)

### 6. Progressive disclosure + auto-provisioning (the scale principle, Yue 2026-06-13)

Motir serves three scales — **individual / small org / enterprise** — from **one model
and one set of surfaces**. The data **always** carries all three tiers (so there is
**never a migration** as a customer grows); the **UI reveals a tier only when it offers
a choice (its count ≥ 2)**. "Scale" is not a mode the product detects — it emerges from
counts. There is **no "individual" branch**: a one-person company (**OPC**) is just an
`Organization` with one member.

**Auto-provisioning (binding on 6.10.4).** Signup **auto-creates** an `Organization` + a
default `Workspace` + the owner memberships for every new account, in one transaction
wired into the existing signup/onboarding path — so every account is an org of one from
day one and there is never a tier-less user. The org name defaults from the user/company
and is **renameable**. (This is the going-forward analogue of §5's backfill for existing
data.)

**Header disclosure (binding on 6.10.5).**

| Tier             | Shown in the header                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Organization** | **Always** — the top-left anchor (a menu button: settings / members / billing / new workspace). Its **"switch org" section appears only when the account is in ≥ 2 orgs.** |
| **Workspace**    | **Hidden until the org has ≥ 2 workspaces**, then a switcher appears to the right of the org (`Acme › Engineering`).                                                       |
| **Project**      | **Always** — in the sidebar header (unchanged). Switching the workspace re-scopes it.                                                                                      |

Only **two** count-driven reveals exist: the workspace switcher at workspace #2, and the
org menu's switch-org section at org #2.

**⚠️ WHOSE COUNT — every reveal in this section reads the VIEWER's (MOTIR-3502, amended
2026-08-26).** "The org has ≥ 2 workspaces" above means **the workspaces the viewer
belongs to within the active org**, not the organization's total. That is what has always
shipped (`ShellTierNav` counts the list the authed layout hands it, which is
`listUserWorkspaces(session.user.id)` filtered to the active org) and it is the right
predicate for a DISCLOSURE rule: a rendered entry point answers _"does this person have a
choice to make?"_, and a workspace they are not a member of offers them none.

**This is the OPPOSITE of the predicate §5's count-1 membership arm reads, deliberately.**
That arm reads the ORGANIZATION's count, because whether an invitee is stranded must not
depend on their inviter's memberships. The two coincide only when the viewer belongs to
every workspace in the org — the founder case, which is why the ambiguity went unnoticed
in both clauses. **Neither clause stated whose count until now; both must, and they must
not be unified.** See §5's count-1 arm for the membership half.

**Settings collapse (binding on 6.10.5).** At **one** workspace the workspace-settings
**surface** is hidden, but the workspace tier still does the work underneath: the single
Settings home (entered as the org's settings) **folds in** the workspace-config sections
(workflows / statuses / fields / labels / components / automation / dashboards — all
`workspaceId`-scoped) and **routes each edit to its own tier** (org → `Organization`,
config → the single `Workspace`). At ws #2 those sections **split** into a per-workspace
Settings area; the existing workspace's data does not move.

**⚠️ WHO CAN REACH THE FOLD-IN — the clause §6d was missing (MOTIR-3519, decided
2026-08-26).** The collapse hides a surface and relocates its contents, which is a claim
about an AUDIENCE that this section never made: the surface being hidden
(`/settings/workspace`) is gated on **workspace membership**, and the surface hosting the
fold-in (`/settings/organization`) was gated on the **org owner/admin role**, whole-page.
A workspace invitee is a plain org `member` (§5's upward invariant joins them with
`role: member`), so the collapse as first specified closed the source to them and refused
the destination — leaving no route to their team roster and, critically, **no route to
Leave workspace at all**.

**THE RULE, stated on roles and surfaces rather than on one page.** In the collapsed
state there is exactly ONE settings home, and it **gates per SECTION, never per page**:

| section                                                                                                            | who sees it                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| org-scoped (org name, billing, org danger zone, the org roster)                                                    | org **owner/admin** only — a plain org member sees the forbidden treatment for these, exactly as panel 5d specifies |
| the folded-in workspace-config sections (name, members, danger zone, and the `workspaceId`-scoped config surfaces) | any member **of that workspace**, which is the same gate the standalone area applies at ws ≥ 2                      |
| nothing at all                                                                                                     | a non-member of the org — 404, never 403 (the standing cross-tenant posture)                                        |

**A hidden tier may not remove a capability.** Progressive disclosure decides what the
product NAMES, not what a user may DO. So the general form, which every future surface
built on §6 inherits: **relocating a surface preserves its gate.** If the destination
admits fewer actors than the source, the destination's gate is what must change — not the
set of people who can act.

**Leave workspace, by name**, because it is the one capability with no alternative
surface anywhere in the product (`leaveWorkspaceAction` has a single consumer):

| workspace count | org role                               | where Leave lives                                           |
| --------------- | -------------------------------------- | ----------------------------------------------------------- |
| 1               | any org member who is in the workspace | the folded-in danger zone on `/settings/organization`       |
| ≥ 2             | any workspace member                   | the standalone `/settings/workspace` danger zone, unchanged |

Note that **rename and delete are membership-gated too**, not admin-gated
(`workspacesService.renameWorkspace` / `deleteWorkspace` both assert membership only), so
hosting these sections for a plain member widens nothing — it restores the reach they
already have at ws ≥ 2.

**Panel 5d's whole-page forbidden treatment is NARROWED, not overturned.** It was written
when this page carried org-scoped cards ONLY, and at that time per-page and per-section
were the same rule. §6d's fold-in is what makes them differ; the per-section reading is
what panel 5d means once the page hosts two tiers' sections.

**This clause is the THIRD of three that must be read together**, and taking one without
the others is how each of them was written wrong: §5's **count-1 arm** (an org add joins
the sole workspace), the **whose-count** clause (§5's membership arm reads the
ORGANIZATION's count, §6's disclosure arm reads the VIEWER's), and this one (a hidden
surface's contents keep their own gate).

**"Inherit" is a behavioural illusion, NOT a data relationship (binding on 6.10.4).**
There is **no org → workspace config inheritance** in the model — no org-level config
defaults, no override rows, no runtime resolution; config is purely `Workspace`-scoped.
The inherited _feel_ at ws #2 is a **copy-on-create**: a new workspace is **seeded by
deep-copying the source workspace's config** at creation (so it opens already
configured), after which the workspaces are fully independent and either can overwrite.
(Real live inheritance, if ever needed for enterprise, is an **additive future change,
not a migration**. The deep copy spans many config tables — with intra-workspace FKs to
remap so the two workspaces don't cross-link — so it is its own subtask, **6.10.9**.)

---

## Consequences

- **6.10.3 (schema)** declares `Organization`, `OrganizationMembership`, `enum
OrganizationRole` (`owner | admin | member`), and `Workspace.organizationId` — every FK
  a Prisma `@relation` on both sides (§2) — plus the single backfill migration (§5).
  `prisma migrate dev` must report "No difference detected" after it (no spurious
  `DROP CONSTRAINT` — the FK-drift rule). `Account` is untouched.
- **6.10.4 (services + gate)** implements §4's precedence + §5's gating in the **one**
  extended permission helper, returning DTOs / throwing typed errors mapped to HTTP
  (404-not-403 for cross-tenant). It owns the **asymmetric membership direction** (§5 —
  workspace-add auto-joins the org; org-add joins no workspace; removal cascade) and the
  **signup auto-provisioning** (§6). The cross-workspace member listing is **paginated**
  (the at-scale rule — never load-all). The **copy-on-create** deep-clone of a new
  workspace's config (§6) is its own subtask, **6.10.9**, extending 6.10.4's org-aware
  create-workspace path.
- **6.10.5 (UI)** renders the org switcher / org settings / cross-workspace member
  management from the 6.10.1 design, **with the §6 progressive-disclosure rules** (org
  always shown; workspace switcher only at ≥ 2 ws; org switch-list only at ≥ 2 orgs;
  one-workspace Settings folds in the workspace-config sections). **No**
  billing/credit/usage surface here (that is 7.12.5 / Epic 8). Org-role chips use the
  palette (a `Pill` tone), not grey-only; org-only members (zero workspaces) render with
  "No workspaces".
- **6.10.6 (seed)** models the `moooon` org over its workspace(s) with an owner
  membership + varied org-roles, applying the **same** idempotent backfill rule (incl.
  the upward invariant — every workspace member is an org member) so seed and migrate
  agree.
- **6.10.7 / 6.10.8 (tests / e2e)** assert: member-of-workspace-but-not-org is denied
  (404-not-403); org owner/admin spans all workspaces; **workspace-add auto-creates the
  org membership while org-add creates none** (the asymmetry) + the removal cascade; the
  cross-workspace roster paginates; the backfill makes exactly one default org per
  workspace and is idempotent.
- **The billing entity is now declared.** When Epic 7 lands, the orchestrator re-keys
  7.12's `CreditLedger` to the org and metering rows carry `project + workspace + org`;
  the org usage view is 7.12.5; the platform rollup is 10.1.5. **6.10 ships none of this
  and depends on none of it** — the fact is prose, the dependency is forward, and the
  cross-story audit stays clean.
- **Out of scope (named so they land in their owning story, not here):** the customer
  org usage/credit **view** (7.12.5); the Motir-internal **platform-staff superadmin
  console** that reads **across** all orgs (Epic 10 / 10.1 — a separate platform-staff
  concept, **not** this tenant org-admin); org suspend / feature-flags / credit-grant ops
  (10.3); billing checkout / pricing (Epic 8).
