# ADR: The platform-staff auth model — `PlatformRole`, the `/admin` gate, and the audited cross-tenant read

- **Status:** Accepted (2026-08-17)
- **Story / Subtask:** 8.5 Production hardening + observability (MOTIR-658) · Subtask
  **MOTIR-729** (8.5.17 — authored as 10.1.2 under Story 10.1, re-filed into Story 8.5
  on 2026-08-17)
- **Supersedes / superseded by:** none
- **Consumed by:** **MOTIR-2896** (8.5.16 — the foundation: the `platformRole` column,
  `requirePlatformStaff()`, the `app/(admin)/admin/` segment, the `PlatformAuditLog`
  model + its write path), **MOTIR-1167** (8.5.11 — the day-1 health glance and the two
  day-1 support writes), **MOTIR-730** (10.1.3 — `platformReadService` and the
  platform-scoped repositories), **MOTIR-731 / MOTIR-732 / MOTIR-733** (10.1.4–10.1.6 —
  the estate overview, the usage/cost rollups, the drill-down), **MOTIR-734 / MOTIR-735**
  (10.1.7–10.1.8 — the gating tests), all of Story **10.2** (MOTIR-736) and Story
  **10.3** (MOTIR-745, in particular MOTIR-749's impersonation and MOTIR-751's audit-log
  view).

> Structured **Status → Context → Decision → Consequences**, with the load-bearing
> shapes pinned in explicit tables so every downstream subtask implements against one
> authoritative source (the convention `work-item-type-taxonomy.md` set and
> `status-derivation.md` follow).

> **Filed under `docs/decisions/`, not `docs/adr/`.** The MOTIR-729 card says
> `docs/adr/platform-staff-auth.md`; shipped reality is that all 36 of this repo's ADRs
> live in `docs/decisions/` and there is no `docs/adr/` directory anywhere in the tree.
> Decision-authority ladder rung 2 (shipped reality) outranks the card's path, so this
> ADR joins its siblings — the same call `status-derivation.md` recorded for MOTIR-1616.

---

## Context

Every access question motir-core answers today is **scoped to one tenant**. `MemberRole`
(Story 6.4) asks whether a user may view or edit inside a workspace or project;
`OrganizationRole` (Story 6.10) asks the same one tier up; the permission catalog
(`lib/permissions/catalog.ts`, 16 domains, none of them cross-tenant) enumerates 31
enforced keys and every one of them resolves against a project the actor already belongs
to. The isolation rule underneath all of it is the **404-not-403 guard**: a principal who
cannot browse a project gets the same answer as one asking about a project that does not
exist, because a 403 confirms existence and lets a caller enumerate real keys
(`lib/api/v1/planning/operations.ts`, `projectAccessService`, `sprintsService`).

Motir now needs the one surface that deliberately reads **across** that boundary: the
internal operator console at `/admin`, where moooon B.V. staff see every org, workspace,
project and user at once, plus the platform-wide usage rollup. Story 8.5 needs a subset of
it before launch (a system-health glance and two support actions); Epic 10 builds the rest
on top.

**A platform-staff persona does not exist in the shipped schema.** Verified on
`origin/main` @ `bd0584c5` (2026-08-17): `git grep -iE 'isPlatformStaff|requirePlatformStaff|platform_staff'`
hits only `design/platform-admin/design-notes.md` and `scripts/plan-seed/data/story-10.1.ts`;
there is no `/admin` route of any kind (the only `admin` path in the tree is
`tests/helpers/adminDb.ts`, the test-side owner client); `prisma/schema.prisma` carries
`OrganizationRole` and `MemberRole` and nothing else role-shaped. All of it is net-new.

**Why this is decided once, in writing, before any of it is built.** Four cards across
three stories each need the same primitive — MOTIR-2896's gate, MOTIR-1167's day-1
support tools, MOTIR-730's read layer, MOTIR-751's audit view. Left to themselves each
would make a small reasonable choice (a boolean here, an enum there, a 403 where a 404 was
meant, an audit row shaped for its own screen), and four reasonable choices make one
incoherent security boundary. MOTIR-2582 is the planning bug that established the single
owner; this ADR is what that owner builds to.

**The cited posture (rung 1 — the mirror, cited not asserted).** The multi-tenant RBAC
literature carves out exactly one exception to tenant isolation: _no global roles that
bypass tenant isolation EXCEPT a small, highly-controlled super-admin set_, with _admin
actions and cross-tenant access logged centrally_ as SOC-2-style evidence. The same shape
ships in the products Motir mirrors — GitLab's admin area, Sentry's and Stripe's internal
consoles, Supastarter's super-admin panel, Vercel's estate view. Story 10.1's module
header (`scripts/plan-seed/data/story-10.1.ts`) records the citation; this ADR implements
it rather than restating it as a claim of its own.

### The two facts about the runtime that shape everything below

1. **RLS exists and is currently inert in production.** motir-core ships 69 RLS-enabled
   tables whose policies read the per-transaction GUCs `app.user_id` / `app.workspace_id` /
   `app.project_id` / `app.system_admin` (`lib/workspaces/context.ts`,
   `lib/organizations/context.ts`). Production's `DATABASE_URL` still connects as a
   **BYPASSRLS owner**, so none of those policies execute today; MOTIR-2435 owns the
   cutover to the non-bypass `motir_app` role. **Consequence for this ADR: RLS is the
   structural backstop, never the gate.** The application-layer check is primary, exactly
   as `app/api/%5Ftest/_helpers.ts` already records for the tenant guard.
2. **`withSystemContext` is not a general escape hatch, and its failure is silent.** It
   binds one flag, `app.system_admin`, and **24 of the 69 RLS tables carry an arm that
   reads it — 45 do not**, including `work_item`, `workspace`, `workspace_membership`,
   `organization`, `sprint` and `comment`. A read of an unarmed table inside that context
   returns **zero rows and raises nothing**, so the caller reads a denial as absence
   (MOTIR-2880). The arms are also READ-side only by design: `withSystemContext` is
   deliberately **refused** by the tenant-root WRITE policies (MOTIR-2865).

---

## Decision

### 1. The staff identity — a `PlatformRole` enum on `User`, orthogonal to every tenant role

`User` gains **one nullable column**:

```prisma
/// Platform-staff standing — moooon B.V. operators ONLY. NULL means "not
/// platform staff", which is every customer account and the default for every
/// row. Deliberately SEPARATE from `MemberRole` (Story 6.4, workspace/project)
/// and `OrganizationRole` (Story 6.10, org): those describe a user's standing
/// INSIDE one tenant, this one describes standing OUTSIDE all of them, and no
/// value of either can produce a value of this. See
/// docs/decisions/platform-staff-auth.md.
platformRole PlatformRole? @map("platform_role")
```

```prisma
/// Degrees of platform-staff access (ADR: platform-staff-auth). A LADDER —
/// each value contains the one before it. Values are deliberately disjoint
/// from `MemberRole` / `OrganizationRole`'s (`owner` / `admin` / `member` /
/// `viewer`) so that a log line, a test fixture or a code review can never
/// confuse a tenant role with a platform one.
enum PlatformRole {
  /// Read the estate: the console, the audited drill-down, the health glance.
  support
  /// `support` + the day-1 support WRITES (password reset, account suspend).
  operator
  /// `operator` + Story 10.3 governance, and the only role that may grant or
  /// revoke `platformRole` itself.
  superadmin

  @@map("platform_role")
}
```

**Why an enum and not a boolean.** The card offered a flag as the default and an enum
"if degrees of staff access are foreseen". They are not foreseen — they are already
specified, in a merged design asset:

| Degree       | Already-specified consumer                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `support`    | The read-only console — Panels 2–6 of `design/platform-admin/`, and Panel 8's health glance (MOTIR-1167). The drill-down is explicitly read-only. |
| `operator`   | Panel 9's two day-1 writes — send password reset, suspend/unsuspend an account — each behind a confirm dialog with a required reason.             |
| `superadmin` | Story 10.3: credit grants (MOTIR-747), org suspend (MOTIR-748), write-level impersonation (MOTIR-749, _"possibly two-person"_), feature flags     |
|              | (MOTIR-750). The design calls this tier _"separate, heavily-gated"_ in as many words.                                                             |

A boolean would collapse three specified tiers into one on day 1 and be widened later —
and widening a boolean to an enum after three stories have written `if (user.isPlatformStaff)`
means revisiting every call site with no compiler help, which is the migration this
choice avoids. Nullable-with-no-`none`-member is deliberate for the same reason: "is
staff" is `platformRole !== null`, so there is no non-staff enum value that a future
`in`-list could accidentally admit.

**The load-bearing invariant, stated once so it can be cited:**

> **No tenant role, at any tier, in any combination, produces a `PlatformRole`.** There is
> no "org owner ⇒ platform staff" path, no role mapping, no inheritance, no
> `Math.max(tenantRole, platformRole)`. The column is written only by the paths §6 names.
> A workspace owner, an org owner and an anonymous visitor are all equally non-staff, and
> `/admin` answers all three identically.

Three concrete corollaries, each of which is a shape someone would otherwise build:

- **`PlatformRole` is NOT a permission-catalog key.** `lib/permissions/catalog.ts` is the
  project-scoped vocabulary; its 16 domains are all tenant-scoped and none may gain a
  `platform` domain. Putting one there would make it grantable, because
  `lib/tokens/grant.ts` grants keys from that catalog to API tokens — and a customer's PAT
  must never be able to carry platform standing.
- **`PlatformRole` is NOT in the session payload.** It is read from the database on each
  request that needs it (§2), not added to Better-Auth's `additionalFields`. A revoked
  operator must lose access on their next request, not on their next sign-in.
- **`PlatformRole` is NOT `app.system_admin`.** That GUC is the trusted-machine context —
  jobs, webhooks, the meter — and §3 keeps the two apart deliberately.

### 2. The gate — `requirePlatformStaff()`, server-side, answering 404

```ts
// lib/platform/auth.ts
export interface PlatformPrincipal {
  userId: string;
  email: string;
  role: PlatformRole;
}

/** Resolves the acting platform principal, or throws NotPlatformStaffError. */
export async function requirePlatformStaff(
  minimum: PlatformRole = 'support',
): Promise<PlatformPrincipal>;
```

| Property              | Decision                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where it lives        | `lib/platform/auth.ts` — a new `lib/platform/` domain, beside `lib/platform/errors.ts`. Not `lib/permissions/` (that is the tenant vocabulary, §1) and not `lib/auth/index.ts` (that is Better-Auth adapter wiring, which `CLAUDE.md` names as a framework boundary not to refactor). |
| Input                 | `getSession()` from `@/lib/auth` — nothing is read from the request, a header, a cookie claim or a client prop.                                                                                                                                                                       |
| Lookup                | The `platformRole` column, read fresh per request through `platformStaffRepository`, wrapped in React `cache()` for per-request dedupe (the shape `getSession` already uses).                                                                                                         |
| Ladder                | `minimum` compares on the `support < operator < superadmin` order. A read surface asks for `support`; MOTIR-1167's two writes ask for `operator`; 10.3 asks for `superadmin`.                                                                                                         |
| Failure               | Throws `NotPlatformStaffError` — one error for "no session", "session but no `platformRole`" and "role below `minimum`". The three are **indistinguishable** to the caller.                                                                                                           |
| Rendering the failure | A React Server Component / layout calls `notFound()`. A route handler returns the **same 404 body the tenant guard returns** for an unknown id. **No response, header, log line or redirect anywhere says `403`, `forbidden`, or names `/admin`.**                                    |

**`/admin` is deliberately NOT added to `proxy.ts`'s `config.matcher`.** The proxy's
optimistic check _redirects_ a cookie-less request to `/sign-in?next=<path>` — a response
that is visibly different from an unknown path's 404 and therefore proves `/admin` is
real. An anonymous request must instead reach the `(admin)` layout and be answered by
`requirePlatformStaff()` with the ordinary 404. This is the one place where following the
established authed-route pattern would break the posture, which is why it is written down
rather than left to be inferred. (It costs nothing: the layout's session read is the same
one every authed page already makes.)

The gate is asserted at **two** layers, and both are required: the `(admin)` layout (§4),
and **every platform-scoped service method** independently (§3). The layout protects the
pages; the service check protects against a future route handler, server action or job
that reaches the platform tier without passing through a layout.

### 3. Cross-tenant reads — an explicit platform tier, and an audit row written in the same transaction

The bypass is a **tier**, not a flag threaded through the existing services. A tenant-scoped
service must never grow a `skipTenantFilter` parameter: the whole point is that the set of
code that can read across tenants is small, named, and greppable.

| Layer         | Shape                                                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service       | `lib/services/platform*Service.ts` (MOTIR-730's `platformReadService` is the first). Every public method takes a `PlatformPrincipal` as its **first** parameter and re-asserts the ladder.                           |
| Repository    | `lib/repositories/platform*Repository.ts`. Reads only. Each method takes `tx: Prisma.TransactionClient` as a **required** parameter — not `tx?` — so a platform read cannot be issued on the unbound `db` singleton. |
| Context       | `withPlatformRead(...)` (below) — the only helper that binds `app.platform_staff`.                                                                                                                                   |
| Tenant filter | Deliberately absent. A platform repository method carries no `workspaceId` / `organizationId` predicate, and that absence is the thing being reviewed rather than a bug to be caught.                                |

#### 3a. `withPlatformRead` — the audit is structural, not a convention

This is the load-bearing paragraph of this ADR:

> **There is no way to open a platform context without naming, up front, what is about to
> be read.** The audit row is INSERTed as the first statement inside the same transaction
> as the read. A read that rolls back leaves no audit row, and a read that commits cannot
> exist without one. Auditing is therefore not a step a caller can forget — it is the
> price of the transaction.

```ts
// lib/platform/context.ts
export async function withPlatformRead<T>(
  principal: PlatformPrincipal,
  entry: PlatformAuditEntry, // action, targetKind, targetId, targetLabel
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T>;
```

It opens `db.$transaction`, `set_config('app.platform_staff', 'true', true)` and
`set_config('app.user_id', principal.userId, true)`, appends the `PlatformAuditLog` row,
then calls `fn`. It **does not** bind `app.workspace_id` or `app.project_id` — binding a
tenant GUC would narrow the very read this context exists to widen.

**Why a new `app.platform_staff` GUC rather than reusing `app.system_admin`.** Three
reasons, in ascending order of weight:

1. `withSystemContext`'s own docstring records that it is _never fed user input_ and binds
   a constant for machine paths. A platform-staff HTTP request is a human principal; the
   two belong to different classes of trust.
2. An audit of "who can read across tenants" that cannot separate a cron from an operator
   answers the SOC-2 question incorrectly.
3. **The decisive one.** The console needs `system_admin` READ arms on `work_item`,
   `workspace`, `workspace_membership`, `organization`, `sprint` and `comment` — six of
   the 45 tables that carry none. Adding them for the console's benefit would silently
   widen the **job runtime's** reach over the same six tables, because `withSystemContext`
   is what the job ledger, the webhook paths and the meters already bind. A separate GUC
   makes the console's new arms visible to the console and to nothing else.

The arms MOTIR-730 adds are **READ-side only**, mirroring the refusal MOTIR-2865 recorded
for `system_admin`: **no INSERT / UPDATE / DELETE policy on any tenant table gains a
`platform_staff` arm.** A platform principal that needs to write a tenant row (10.3's
governance actions) does it through a named service method that resolves the tenant and
opens a normal `withWorkspaceServiceContext` / `withOrgServiceWriteContext`, so the write
is confined to the one tenant it names.

**The read-only "View as tenant" session (design Panel 6) is not this mechanism.** It
opens the tenant's own app with writes disabled; it must be built as a _scoped tenant_
session, audited at open, and must never be implemented by binding `app.platform_staff`
into a tenant request path. Doing so would make every subsequent query in that request
cross-tenant. Ownership: MOTIR-733 for the read-only half, MOTIR-749 for the write-level
half.

#### 3b. `PlatformAuditLog` — the record shape, one table, four writers

```prisma
/// Every platform-staff action against the estate: the cross-tenant READS the
/// console performs (MOTIR-730), the day-1 support WRITES (MOTIR-1167), and
/// Story 10.3's governance actions (MOTIR-747/748/749/750). One shape, because
/// "who touched this tenant, and when?" cannot be answered by three tables.
/// APPEND-ONLY: the repository exposes create + reads and nothing else.
model PlatformAuditLog {
  id             String                  @id @default(cuid())
  /// The operator. Restrict on the FK: a user with audit rows on record cannot
  /// be hard-deleted (the `WorkItem.reporter` precedent).
  actorUserId    String                  @map("actor_user_id")
  /// The operator's role AT THE TIME. Snapshotted, not joined — a later grant
  /// or revoke must not rewrite what the record says happened.
  actorRole      PlatformRole            @map("actor_role")
  /// `<domain>.<verb>`, from the code-owned PLATFORM_AUDIT_ACTIONS union.
  action         String
  targetKind     PlatformAuditTargetKind @map("target_kind")
  /// Bare ids and a label, with NO @relation and NO FK — deliberately. The
  /// record must outlive the org, workspace, project or user it describes; a
  /// Cascade would delete exactly the evidence of what happened to a tenant
  /// that was then deleted, and a Restrict would make the audit log block
  /// account deletion. (CLAUDE.md's FK rule holds: no SQL FK, so no @relation.)
  targetId       String?                 @map("target_id")
  targetLabel    String?                 @map("target_label")
  organizationId String?                 @map("organization_id")
  /// REQUIRED for every write action, NULL for a read. Enforced in the service,
  /// not by the column, because reads legitimately have none.
  reason         String?
  metadata       Json?
  createdAt      DateTime                @default(now()) @map("created_at")

  actor User @relation(fields: [actorUserId], references: [id], onDelete: Restrict)

  @@index([organizationId, createdAt])
  @@index([actorUserId, createdAt])
  @@map("platform_audit_log")
}

enum PlatformAuditTargetKind {
  organization
  workspace
  project
  user
  platform

  @@map("platform_audit_target_kind")
}
```

**`action` is a `String` in the database and a closed union in TypeScript.** A Postgres
enum would need an `ALTER TYPE` migration for every action four stories add across two
epics; an audit vocabulary is open-ended by nature. The closedness that matters —
catching a typo at the call site — is bought by a code-owned
`PLATFORM_AUDIT_ACTIONS` const union in `lib/platform/auditActions.ts`, exactly as
`lib/permissions/catalog.ts` owns the permission keys in code rather than in the schema.

**RLS on `platform_audit_log`, stated as enforced state rather than intent.** The table
ships `ENABLE` + `FORCE ROW LEVEL SECURITY` and **one PERMISSIVE `FOR ALL` policy** in the
same migration that creates it:

```sql
CREATE POLICY platform_audit_log_platform_only ON platform_audit_log
  FOR ALL
  USING      (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');
```

Three things this fixes, each because getting it wrong has already cost this repo a card:

- **`FOR ALL`, not four verb-specific policies.** `tests/tenant-root-creation-rls.test.ts`
  asserts that every RLS-enabled table admits all four verbs; a table with SELECT and
  INSERT policies only fails it. Under a non-bypass role "no policy" is not "no gate" — it
  is a closed door (the MOTIR-2435 / `add_workspace_rls` lesson).
- **No tenant arm at all.** No value of `app.workspace_id` or `app.organization_id` admits
  a row. A tenant request cannot read the platform audit log even by accident.
- **Append-only is an APPLICATION property here, not a database one.** The policy admits
  UPDATE and DELETE _under a platform context_ because the totality guard requires the
  verbs to be covered; what makes the table append-only is that
  `platformAuditLogRepository` exposes `create` and reads and no mutator. Tamper-_evidence_
  (the hash chain) is deliberately not in this ADR — it is MOTIR-751's, and the design
  says so explicitly. Do not read this bullet as a claim that the row cannot be edited.

The table is **not** added to that test's `DELIBERATELY_UNGUARDED` map: it ships a policy,
which is the other branch of the same either/or.

### 4. Where the admin app lives — `app/(admin)/admin/` inside motir-core

A gated route group inside motir-core, a **sibling of `(authed)` / `(auth)` / `(public)` /
`(onboarding)` / `(planning)`** — not a separate application, not a subdomain, not a
second Next app.

| Question              | Decision                                                                                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route group           | `app/(admin)/admin/` — `admin/page.tsx` (overview), `admin/usage/page.tsx`, `admin/tenants/[scope]/[id]/page.tsx`, and the search API the top-bar box calls, per the merged design.                                                                        |
| Gate placement        | `app/(admin)/layout.tsx` calls `requirePlatformStaff()` before rendering anything, and calls `notFound()` on the throw. The layout is the single choke point for the pages.                                                                                |
| Middleware            | Not in `proxy.ts`'s matcher — §2.                                                                                                                                                                                                                          |
| API routes            | `app/api/admin/**`, each handler calling `requirePlatformStaff()` itself. A layout does not protect a route handler.                                                                                                                                       |
| Why inside motir-core | It reuses the shipped auth, the app shell, the design system and the `--el-*` / shape tokens; the design composes `Sidebar`, `Popover`, `CommandPalette`, `Segmented`, `Card` and `Pill` with **no bespoke admin CSS**. A second app would fork all of it. |
| Why open-core is fine | The console is operator UI over motir-core's own data; it holds no metering (§5) and no proprietary planning logic, so nothing about it belongs on the closed side (Principle #19).                                                                        |
| Entry affordance      | The staff-only "Platform admin" row in the TopNav avatar `Popover` (design Panel 1). **Absent** for non-staff — not disabled, not hidden by CSS: not rendered, so no markup names the route.                                                               |

### 5. Usage and cost are READ over the 7.1 boundary — motir-core holds no metering

motir-core does not gain a metering table, a credit ledger or a spend rollup. The planning
metering (7.12) and the coding-gateway spend (9.0) live in motir-ai, and the platform
console reads a **pre-aggregated platform rollup** over the 7.1 boundary — the same
leaf-client read-through `aiUsageService` already ships for the org dashboard
(`getOrgUsage` → `GET /v1/usage` in `lib/ai/motirAiClient.ts`), one level up.

- **Pre-aggregated, never a live scan (finding #57).** At platform scale the raw metering
  is billions of rows; the rollup is stored at multiple hierarchy levels
  (project → workspace → org → platform) and queried at the right granularity. The rollup
  table itself and its aggregation job are **MOTIR-732's** build, not this ADR's.
- **The enrichment split is motir-core's.** motir-ai returns ids; motir-core joins its own
  workspace / project names on before the DTO reaches the browser, exactly as
  `aiUsageService` does today.
- **A transport failure renders as an error, never as a zero.** The design draws this
  state explicitly (Panel 7d: _"no tenant has zero usage; the figures are simply not
  loaded"_), and `getOrgUsage` already maps a non-2xx to a typed error for that reason.
- **The open-core invariants hold unchanged.** Browsers never call motir-ai; only
  motir-core's server-side handlers do, over the private service channel
  (`docs/ai-boundary.md` invariant 1).

### 6. Who may GRANT platform standing, and how the first one exists

- **Only `superadmin` may grant or revoke `platformRole`,** and there is **no in-app grant
  UI before Story 10.3**. Nothing in MOTIR-2896, MOTIR-1167 or Story 10.1 renders a
  control that writes the column.
- **Development:** `db:seed` seeds one platform-staff user so `/admin` is reachable
  locally (MOTIR-2896's criterion).
- **Production:** the first row is written by an **operator script run against the
  production database** — there is no bootstrap endpoint, no environment variable, and no
  "first user becomes staff" rule, because each of those is a permanent hole left open to
  buy a one-time convenience.
- **That production step has no owning card, so this ADR does not defer it silently —
  it is filed as MOTIR-2932** (8.5.18, `blocked_by` MOTIR-2896). Story 8.5 is launch
  readiness and MOTIR-1167's day-1 operator tools are gated on staff existing in
  production; without that card the tools ship green and unreachable, which is the
  MOTIR-1916 shape (_five done cards and the fleet could not boot a runner_).

### 7. Read-mostly — the accurate allocation, which is not the one MOTIR-729 was authored with

Story 10.1's body says _"10.1 is read-mostly (its only writes are audit-log appends)"_.
**That remains true of Story 10.1 and is NOT true of the platform surface from day 1.**
`design/platform-admin/design-notes.md` — merged 2026-08-11, nearly two months after
MOTIR-729 was authored on 2026-06-15 — adds Panels 8 and 9 for Story 8.5 and allocates two
writes to **MOTIR-1167**, before Epic 10 runs at all. The card's fourth acceptance
criterion was amended on the record on 2026-08-17 to match; this table is the allocation
every consumer builds to.

| Action                                                           | Story / card                      | Minimum role | Reason required | Audited |
| ---------------------------------------------------------------- | --------------------------------- | ------------ | --------------- | ------- |
| Read the estate; drill into a tenant; the health glance          | 8.5 MOTIR-1167 · 10.1.4–6         | `support`    | no              | yes     |
| Send a password reset                                            | **8.5 MOTIR-1167**                | `operator`   | **yes**         | yes     |
| Suspend / unsuspend an **account**                               | **8.5 MOTIR-1167**                | `operator`   | **yes**         | yes     |
| Credit grants, plan / tier assignment                            | 10.3 MOTIR-747                    | `superadmin` | yes             | yes     |
| Suspend / reactivate an **organization**                         | 10.3 MOTIR-748                    | `superadmin` | yes             | yes     |
| Write-level impersonation (time-boxed)                           | 10.3 MOTIR-749                    | `superadmin` | yes             | yes     |
| Per-org feature flags / kill-switches                            | 10.3 MOTIR-750                    | `superadmin` | yes             | yes     |
| Classify an **organization** internal-billing / remove it        | **MOTIR-4565** (Story MOTIR-4337) | `superadmin` | **yes**         | yes     |
| The audit-log **VIEW**, searchable + tamper-evident (hash chain) | 10.3 MOTIR-751                    | `superadmin` | n/a             | n/a     |
| Grant / revoke `platformRole`                                    | 10.3 (no card yet — §6)           | `superadmin` | yes             | yes     |

Every one of those writes reuses **this** gate and **this** `PlatformAuditLog`. The day-1
rows are the plain append-only shape above; 10.3's hash chaining extends the same table
rather than introducing a second one.

> **⚠️ AMENDED 2026-09-05 (Story MOTIR-4337 · MOTIR-4565).** The row above the last one is the
> first member of this table from OUTSIDE Epic 10 and Story 8.5, and it is placed at
> `superadmin` deliberately rather than at the `operator` degree MOTIR-1167's two writes take:
> it changes what an organization is BILLED, which is the class every other `superadmin` row here
> already covers (credit grants, tier assignment, per-org flags). Its two actions —
> `org.internal_billing_set` and `org.internal_billing_unset` — join
> `PLATFORM_AUDIT_ACTIONS` in the same pull request, both `reason: 'required'`.
>
> It also ships the FIRST `platform_staff` policy arms on a tenant table —
> a SELECT arm and an UPDATE arm on `organization`, and on `organization` only.
> Those are carved from **MOTIR-730** on the record, which keeps
> `platformReadService` and every other table's arms; the boundary is written up in
> `docs/decisions/internal-billing-classification.md` §5. Until they landed, the
> _"deliberately does NOT decide"_ table's allocation meant a cross-tenant read of any
> tenant table from this tier returned zero rows and raised nothing.

---

## What this ADR deliberately does NOT decide

Named with their owner, so no deliverable leaves the plan at the moment this card goes
done (the MOTIR-1916 rule):

| Not decided here                                                                                          | Owner                                                                          |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Which tables get a `platform_staff` READ arm, and each policy's SQL                                       | MOTIR-730 (10.1.3)                                                             |
| The `PlatformUsageDTO` shape and the platform rollup table + its job                                      | MOTIR-732 (10.1.5)                                                             |
| The console's own layout, copy and i18n namespace                                                         | `design/platform-admin/` (merged) + MOTIR-2896                                 |
| The `PLATFORM_AUDIT_ACTIONS` vocabulary's initial members                                                 | MOTIR-2896 seeds it; each consumer extends it                                  |
| Hash-chained tamper evidence and the audit-log viewer                                                     | MOTIR-751 (10.3.6)                                                             |
| Write-level impersonation's time-box, two-person rule and banner                                          | MOTIR-749 (10.3.4)                                                             |
| Whether `/admin` is reachable in a self-hosted build                                                      | open — no card; see Consequences                                               |
| The production bootstrap of the first staff row                                                           | **MOTIR-2932** (8.5.18), filed by this ADR                                     |
| The account-SUSPENSION **mechanism** — the `User` columns, the session revocation and the sign-in refusal | **MOTIR-1167** (8.5.11) — shipped there; added retroactively by **MOTIR-3641** |

**⚠️ The row above is recorded, not deferred, and it is the one this table was missing.** §7 allocates
_"suspend / reactivate an account"_ to MOTIR-1167 and `design/platform-admin/design-notes.md` Panel 9
specifies the behaviour precisely (_"signed out of every session immediately and cannot sign back
in"_) — **both allocate the ACTION, and until MOTIR-1167 merged neither allocated the MECHANISM, which
did not exist.** On `origin/main` at `2852f19b2`: `User` carried no suspension column of any shape,
Better-Auth's `admin` plugin (which ships `banned` / `banReason` / `banExpires`) was not in
`lib/auth/index.ts`'s `plugins` array, and nothing anywhere refused a sign-in for a disabled account or
revoked another user's sessions. So the ADR and the card agreed the work was owned while neither owned
it, and the card was sealed at 5 points / 60 minutes against a delivered 35 files / +3,782 lines.

It ships today as `prisma/schema.prisma`'s `User.suspendedAt` / suspension-reason columns,
`lib/auth/accountSuspension.ts`, a `databaseHooks.session.create.before` hook in `lib/auth/index.ts`,
a `SELECT … FOR UPDATE` guard in `lib/repositories/platformUserRepository.ts`, and a copy branch on
**both** credential sign-in surfaces (`SignInCard.tsx`, `PublicAuthDialog.tsx`).

**The general rule this produced** (MOTIR-3641, in `motir-meta/prompts/plan-rules/phase-deepen.md` and
mirrored into `SHARED_PLANNING_RULES`): **a row of an allocation table names an ACTION, and a verb
presupposes the thing it acts on — so every row owes a line about the SUBSTRATE that action writes to.**
_"Send a password reset"_ had substrate (the shipped `requestPasswordReset` flow); _"suspend an
account"_ had none, and the two are indistinguishable in a table with an owner column and a role
column. Adding a row here is what that check produces when the answer is _absent_.

---

## Consequences

**Good.**

- One primitive, four consumers, no drift. MOTIR-2896 ships it; MOTIR-1167, MOTIR-730 and
  Story 10.3 consume it by name.
- The audit obligation cannot be forgotten, because it is the transaction's entry cost
  (§3a) rather than a line a reviewer has to notice is missing.
- The 404 posture is total: no route in the matcher, no menu row in the markup, no error
  body naming the surface, and one indistinguishable error for all three denial cases.
- The blast radius of the escape hatch is a directory. "What can read across tenants?" is
  answered by `ls lib/services/platform*Service.ts` plus the one context helper.

**Costs, accepted.**

- A three-value enum is more than day 1 strictly needs. The alternative was widening a
  boolean across three stories' call sites with no compiler help.
- A second cross-cutting GUC alongside `app.system_admin` is one more thing a policy author
  must know about. The alternative silently widened the job runtime over six tenant tables.
- Every platform read costs one INSERT. At operator traffic (a handful of humans) that is
  free; it is a real cost only if a platform read is ever put on a hot path, which is what
  the pre-aggregated rollup (§5) exists to prevent.

**Open, and honestly open.**

- **Self-hosting.** motir-core is GPL-3.0 and anyone may run it. A self-hosted operator
  granting themselves `superadmin` over their own single-tenant instance is harmless and
  arguably correct — but nothing decides whether `/admin` should be present, absent or
  degraded there, and no card owns the question. It does not block anything below Story
  10.3 and is recorded here rather than answered, so the next reader finds it named.
- **RLS is inert in production until MOTIR-2435 lands.** Everything in §3's RLS half is a
  backstop that does not execute yet. The application-layer gate is doing all of the work
  today, and a reader must not take the policy SQL above as evidence that the database is
  currently enforcing anything.

---

## References

- `design/platform-admin/design-notes.md` + `console.mock.html` — the merged design
  (MOTIR-728 for Panels 1–7, MOTIR-1166 for Panels 8–9). §§ "What this area is",
  "⚠️ Net-new capability", "Where it lives", "The three boundaries, in writing".
- `scripts/plan-seed/data/story-10.1.ts` — Story 10.1's module header: the locked
  platform-staff model and the cited multi-tenant security posture.
- `lib/workspaces/context.ts` · `lib/organizations/context.ts` — the GUC-binding context
  helpers and `withSystemContext`'s documented limits (MOTIR-2880, MOTIR-2865).
- `docs/rls-runtime-role-inventory.md` — what executes under the non-bypass role today.
- `tests/tenant-root-creation-rls.test.ts` — the four-verb totality guard and the
  `DELIBERATELY_UNGUARDED` set.
- `lib/permissions/catalog.ts` · `docs/decisions/permission-inventory.md` ·
  `docs/decisions/token-permissions.md` — the tenant permission vocabulary this is
  separate from.
- `lib/ai/motirAiClient.ts` · `lib/services/aiUsageService.ts` · `docs/ai-boundary.md` —
  the 7.1 read-through pattern §5 extends.
- `app/api/%5Ftest/_helpers.ts` — the shipped 404-not-403 precedent (`productionGate`).
- MOTIR-2582 · MOTIR-2897 — the planning bugs that consolidated ownership onto MOTIR-2896.
