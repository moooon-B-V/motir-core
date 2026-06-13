# ADR: The `Organization` root tier + the billing entity + org roles vs the 6.4 workspace role

- **Status:** Accepted (2026-06-12, billing-entity decision locked with Yue)
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
Five things must be frozen first, because each is referenced by more than one
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
5. **The access-gating rule + the migration backfill semantics** for existing data.

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

- **Atlassian / Jira Cloud.** The **Organization** is the topmost structure; it
  provides the layer that controls **licensing, billing, and security** across every
  site/product, administered at `admin.atlassian.com`. The **org admin** is the highest
  admin level and is the one who "also see[s] the billing details"; **site admins**
  below it do not. (Atlassian Community — "Jira's Structure — Orgs, Sites, Spaces"; "What
  is different between org admin, site admin and product admin"; Atlassian Support —
  "types of admin roles".) → Motir's `Organization` = Atlassian's **org** (billing +
  identity root); Motir's `Workspace` ≈ Atlassian's **site** (the product container
  under it).
- **Linear.** A workspace is "the home for all issues and interactions in an
  organization"; the workspace **Owner** role carries "the most sensitive settings like
  **billing**, security, and audit logs", and members belong to one-or-many **teams**
  under it. Separate workspaces have "separate billing plans" — billing sits at the
  org/workspace **root**. (Linear Docs — Workspaces; Members and roles.) → Motir's
  `Organization` = Linear's workspace-root (billing + identity); Motir's `Workspace` ≈ a
  Linear team-container under it.

Both mirrors share the durable shape Motir adopts: **a single root tenant that owns
billing + cross-workspace membership, with workspaces nested under it, and an org-level
owner/admin role above the workspace-level role.**

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

| Motir          | Atlassian | Linear            | Owns                                    |
| -------------- | --------- | ----------------- | --------------------------------------- |
| `Organization` | Org       | Workspace-root    | **billing**, identity, cross-ws members |
| `Workspace`    | Site      | Team-container    | projects, boards, the PM substrate      |
| `Project`      | (Space)   | (Team's projects) | issues / sprints                        |

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

### 5. Access gating + the backfill semantics

**Org membership gates workspace access (binding on 6.10.4).** A workspace is reachable
**only** by a member of its `Organization`. Concretely: reaching any workspace-scoped
resource requires `OrganizationMembership(user, workspace.organizationId)` to exist (or
the user to be an org owner/admin of that org). A user who is a member of the
**workspace** but **not** of its **org** is **denied**.

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
   point the workspace at it, and create an `OrganizationMembership(role = owner)` for
   that workspace's owner / first-admin — so every legacy row has an org **and** an org
   owner.
4. Make `Workspace.organizationId` **non-nullable** once every row is set.

The backfill is **idempotent / re-runnable-safe** (re-running creates no duplicate orgs
or memberships) — so the migration, the seed loader (6.10.6), and the tests (6.10.7) all
agree. (1:1 — not "one org for all workspaces" — because the org is the **billing**
entity: collapsing independent existing workspaces into a shared billing root would
silently merge their billing, which no migration should do unasked.)

---

## Consequences

- **6.10.3 (schema)** declares `Organization`, `OrganizationMembership`, `enum
OrganizationRole` (`owner | admin | member`), and `Workspace.organizationId` — every FK
  a Prisma `@relation` on both sides (§2) — plus the single backfill migration (§5).
  `prisma migrate dev` must report "No difference detected" after it (no spurious
  `DROP CONSTRAINT` — the FK-drift rule). `Account` is untouched.
- **6.10.4 (services + gate)** implements §4's precedence + §5's gating in the **one**
  extended permission helper, returning DTOs / throwing typed errors mapped to HTTP
  (404-not-403 for cross-tenant). The cross-workspace member listing is **paginated**
  (the at-scale rule — never load-all).
- **6.10.5 (UI)** renders the org switcher / org settings / cross-workspace member
  management from the 6.10.1 design — **no** billing/credit/usage surface here (that is
  7.12.5 / Epic 8). Org-role chips use the palette (a `Pill` tone), not grey-only.
- **6.10.6 (seed)** models the `moooon` org over its workspace(s) with an owner
  membership + varied org-roles, applying the **same** idempotent backfill rule so seed
  and migrate agree.
- **6.10.7 / 6.10.8 (tests / e2e)** assert: member-of-workspace-but-not-org is denied
  (404-not-403); org owner/admin spans all workspaces; the cross-workspace roster
  paginates; the backfill makes exactly one default org per workspace and is idempotent.
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
