# ADR: Public projects — `public` is an access MODE (one of three, beside a membership scope), the one cross-org read exception

- **Status:** Accepted (2026-06-13, model locked with Yue 2026-06-12)
- **Story / Subtask:** 6.12 (Public projects — open project management) · Subtask 6.12.2
- **Extends:** Story 6.4's project-access model (`ProjectAccessLevel`
  open/limited/private + the `projectAccessService` `canBrowse`/`canEdit`
  policy in `lib/projects/access.ts`) — a **one-value extension**, NOT a
  parallel access system. Composes with Story 6.11's triage model
  (`docs/decisions/triage-model.md` — a submission IS a `work_item` in a
  `triage` state) and Story 6.10's org gate.
- **Supersedes / superseded by:** none
- **Amended:** 2026-09-27 — the four `ProjectAccessLevel` values became three access MODES
  (Open to the workspace · Members only · Public) plus a membership SCOPE (Full / Limited), by
  `docs/decisions/role-model.md` Q1 (Story MOTIR-6169 · MOTIR-6543). The title, the shipped-ground
  list, §1's ladder and table and §2's code are updated in place; see _AMENDMENT 1 (2026-09-27)_ at
  the end. §5 (READ anonymous, WRITE signed in) stands.
- **Consumed by:** 6.12.3 (schema — add `public` to the enum + the
  `PublicRequestVote` join + `project.publicOverviewMd` + the access-check
  extension), 6.12.4 (the public read-only view + the public projection +
  the Overview/README landing), 6.12.5 (cross-account submit-to-triage +
  duplicate detection), 6.12.6 (upvote + public-request comments), 6.12.7
  (the public roadmap), 6.12.8 (the make-public toggle + share link + the
  Overview editor), 6.12.9 (access + dedupe + voting tests), 6.12.10
  (cross-org e2e).

> Structured **Context → Decision → Consequences → References**, the
> convention the repo's first ADRs (`work-item-type-taxonomy.md`,
> `triage-model.md`) set: the load-bearing facts are pinned in explicit
> tables so the schema (6.12.3) and every consumer card build against one
> authoritative source rather than re-deriving the shapes. No application
> behaviour ships in this subtask; the shapes it freezes are what make the
> rest of the story buildable.

---

## Context

Story 6.12 makes a project **public**: open for read-only VIEW to ANY
signed-in Motir account — **across orgs and workspaces** — where a viewer
can change NOTHING except **submit a bug / feature request** (into the 6.11
Triage), **upvote** an existing request, and **comment** on it. This is the
"open source project management" / public-feedback-portal posture: a public
roadmap + a public intake, gated to authenticated accounts. A pure
motir-core, per-project capability — no AI boundary, no forward dependency.

The shape decision that governs everything downstream is **how `public`
relates to the already-shipped 6.4 access model**. The two candidate shapes:

1. **A parallel public-access system** — a separate `isPublic` flag + a
   second policy path + a second read surface, bolted alongside 6.4's
   `accessLevel`. This forks the access decision into two places that must
   be kept in sync forever, and invites the bug where one path grants what
   the other denies.
2. **`public` is a fourth value of the existing `ProjectAccessLevel` enum**,
   and the existing `projectAccessService` / `lib/projects/access.ts` policy
   is EXTENDED — one new enum value, the openness ladder grows by one rung,
   and every gate keeps reading the one policy.

Yue locked shape (2) on 2026-06-12. This ADR fixes the six load-bearing
details that shape leaves open: the **enum extension + ladder** (§1), the
**cross-org READ exception and where it lives** (§2), the **three explicit
write grants** (§3), the **public projection / visible-vs-hidden** (§4),
**account-required-not-anonymous** (§5), and **submission + dedupe + vote
semantics** (§6).

### The verified mirror (rung 1, cited not asserted — checked 2026-06-12)

Per the decision-authority ladder, the mirror product is the primary
standard (observed, not asserted from memory — `notes.html` #33):

- **Public project / roadmap visibility.** OpenProject ships an explicit
  PUBLIC project visibility + a public roadmap as its "Open Source Project
  Management" posture (https://www.openproject.org/roadmap/); Plane (the
  open-source Jira/Linear alternative) ships a transparent public roadmap +
  Intake (https://plane.so/open-source); GitHub public repos are the
  "anyone-can-read, only-collaborators-write" baseline this mirrors, narrowed
  to "any authenticated account."
- **Public feedback portals.** Canny / Productboard / Featurebase are the
  verified portal mirror for the **submit + upvote + comment + status-
  roadmap** set, including **Canny's automatic duplicate detection** —
  "Canny automatically detects if a requested feature already exists … the
  customer can add their upvote and leave comments on the existing request"
  (https://canny.io/use-cases/feature-request-management) — and
  Productboard's "Share > Publish > copy link" public portal + status roadmap
  (https://support.productboard.com/hc/en-us/articles/360056315454).

The portal pattern pairs (a) public roadmap visibility with (b) a feedback
portal, and every rung-1 portal ships the SAME four behaviours — upvoting,
duplicate-detection-on-submit, comments, a status roadmap — so all four are
in scope (adopted, not gold-plated).

### The shipped ground this builds on (rung 2 — enforced reality)

The model must respect what is already in `motir-core`, which on these
points **outranks the card's prose** (rung 2 over rung 3):

- **`ProjectAccessLevel` is a closed Postgres enum `{ open, limited,
private }`**, `project.accessLevel @default(open)` (`prisma/schema.prisma`).
  Adding a value is an enum ALTER + no default change — existing projects
  stay their current level, nothing is locked out.
  _(Amended 2026-09-27: entry is now `project.accessMode` — `workspace` ·
  `members` · `public` — read with each membership's `accessScope`, `full` or
  `limited`, by the one rule `canEnter` in `lib/permissions/resolve.ts`.
  `accessLevel` survives beside it until the contract story drops it, written
  together with the mode so the RLS policies keyed on `'public'` still agree.)_
- **The policy is pure + already factored** (`lib/projects/access.ts`):
  `canBrowse` / `canEdit` / `canComment` / `canModerateComments` /
  `canCreateAttachments` / `canDeleteAllAttachments` / `canManageWatchers` /
  `canManageProject` decide over `ProjectAccessInputs = { accessLevel,
workspaceRole, projectRole }` with **no IO** _(amended 2026-09-27: `{ accessMode,
workspaceRole, accessScope, addedToProject }` — roles live on the workspace since
  MOTIR-6168 and entry on the mode since MOTIR-6169)_. Two rails frame every level:
  a workspace **owner/admin always passes**, and a **non-workspace-member
  (`workspaceRole == null`) always FAILS both browse and edit** — "the
  project gate sits beneath the workspace gate (finding #26)."
- **The IO half enforces the 404-not-403 cross-tenant posture**
  (`projectAccessService.resolveInputs`): it throws `ProjectNotFoundError`
  (→ 404, no existence leak) when the project is missing **OR lives in
  another workspace** (`project.workspaceId !== ctx.workspaceId`). **A
  cross-org viewer never even reaches `canBrowse` today** — `resolveInputs`
  404s first. This is the exact gate `public` must carve its single
  exception through (§2), and it is why the exception is TWO touch-points,
  not one.
- **A submission is born a `work_item` in a `triage` state**
  (`triage-model.md`): `triagedAt: DateTime?` non-null ⇔ in triage,
  excluded from every normal read; the queue read (6.11.3) is the only
  inclusion read, ordered newest-first and paginated. `work_item.reporterId`
  is **NON-NULL** (`onDelete: Restrict`); the triage model attributes an
  **in-app member submission** to the real submitting member (real
  `reporterId`, `externalSubmitter{Name,Email}` NULL), and reserves the
  intake-user + `externalSubmitter*` shape for the **anonymous public-portal
  form** only. (§6 places 6.12 public submissions on the _authenticated_
  branch, not the anonymous one.)

---

## Decision

### 1. `public` is an access mode; the ladder is public > workspace > members

_(Amended 2026-09-27, Story MOTIR-6169 — `role-model.md` Q1.)_ Entry is one of three
**access modes** — `enum ProjectAccessMode { workspace, members, public }`,
`@@map("project_access_mode")` — read with each workspace membership's **access
scope**, `full` or `limited`. The old four levels map onto them: `open` → `workspace`,
`limited` and `private` → `members`, `public` → `public`. The **openness ladder**
(most → least open):

| Mode                                | Who can ENTER (and READ)                                                         | Who can WRITE (normal edits)                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **`public`**                        | as `workspace`, plus **ANY account, across orgs, reading** (the public read set) | an entrant whose workspace role writes — a non-entrant only the 3 grants of §3 |
| `workspace` (Open to the workspace) | every **Full**-scope workspace member, anyone added, and Managers                | an entrant whose workspace role writes                                         |
| `members` (Members only)            | only the people **added**, and Managers                                          | an entrant whose workspace role writes                                         |

A **Limited**-scope member enters only the projects they were added to, in every
mode — on a `public` one they were not added to they read as a visitor does, and it
is not listed as one of their projects. What an entrant may DO is their workspace
role (Manager · Member · Viewer · custom), never the mode.

The table as first written, for the record — the four-value enum `{ open, limited,
private, public }` that Story 6.12 extended:

| Level        | Who can READ                                           | Who can WRITE (normal edits)                         |
| ------------ | ------------------------------------------------------ | ---------------------------------------------------- |
| **`public`** | **ANY authenticated Motir account, across orgs** (new) | nobody who is a non-member — only the 3 grants of §3 |
| `open`       | any workspace member                                   | any workspace member                                 |
| `limited`    | any workspace member (view + comment)                  | project members (member/admin)                       |
| `private`    | project members (or workspace owner/admin)             | project members (member/admin)                       |

`public` is the ONLY level that crosses the org/workspace boundary for READ;
every other level keeps its 6.4 semantics verbatim. This is a **one-value
extension of the 6.4 enum + the SAME `projectAccessService`** — NOT a
parallel access system, NOT a second `isPublic` flag. No default change:
`@default(open)` stays, so existing projects are untouched and adding the
value locks nothing out (rung 2). The default stays `open`, never `public` —
a project becomes public only by an explicit admin action (6.12.8).

### 2. `public` = any authenticated account reads cross-org — the single auditable exception, in TWO named touch-points

A `public` project's READ paths admit **any signed-in account, regardless of
org/workspace membership.** Because today's gate stops a cross-org viewer at
two distinct points (the `resolveInputs` 404 guard AND the `canBrowse`
non-member rail), the exception is **exactly two touch-points, each a single
auditable branch — and nowhere else**:

1. **The pure-policy branch (`lib/projects/access.ts`).** `canBrowse` gains
   ONE leading branch, BEFORE both rails:

   ```ts
   export function canBrowse(i: ProjectAccessInputs): boolean {
     if (i.accessLevel === 'public') return true; // ← the public read exception (§2)
     if (isWorkspaceManager(i.workspaceRole)) return true;
     if (i.workspaceRole == null) return false;
     // …open/limited/private unchanged…
   }
   ```

   _(Amended 2026-09-27: the policy is a permission SET now, and the exception is its
   first layer — `resolveOpen` in `lib/permissions/resolve.ts`:)_

   ```ts
   if (i.accessMode === 'public') held ∪= PUBLIC_PROJECT_PERMISSIONS; // ← the public read exception
   if (!canEnter(i)) return held;          // no membership / Members only and not added / Limited and not added
   if (i.workspaceRole === 'manager') held ∪= ROLE_GATED_PERMISSIONS;
   else held ∪= the workspace role's set;  // nothing subtracted by the mode
   ```

   It is leading + unconditional so a `public` project is browsable by anyone
   the policy is asked about — including a viewer with `workspaceRole == null`
   and `projectRole == null`. `canEdit` / `canComment` / `canManageProject`
   etc. gain NO such branch (§3).

2. **The IO branch (`projectAccessService`).** A new **dedicated public-read
   resolution path** is the ONLY caller that bypasses the
   `project.workspaceId !== ctx.workspaceId` 404 guard. The existing
   `resolveInputs(projectId, ctx, tx)` — workspace-scoped, used by EVERY
   current capability method — is left **untouched**, so the 404-not-403
   cross-tenant posture for non-public projects is fully preserved (a
   cross-org user hitting a non-public project still gets
   `ProjectNotFoundError` → 404, never 403). The public path instead:
   - loads the project by id **without** a workspace-equality assertion;
   - if `project.accessLevel !== 'public'`, throws `ProjectNotFoundError`
     (→ 404) — a non-public project is still indistinguishable from
     never-existed to a cross-org user (no existence leak);
   - if `public`, resolves the actor's roles **relative to the project's own
     workspace** (a cross-org viewer simply resolves to `workspaceRole == null
/ projectRole == null`, and the §2.1 leading branch grants browse). A
     viewer who happens to also be a member of that workspace keeps their
     richer role and their normal capabilities.

   Concretely this is a new method — e.g. `assertCanBrowsePublic(projectId,
actorUserId, tx?)` + a `getPublicCapabilities(projectId, actorUserId)` —
   on `projectAccessService`, the SINGLE place the workspace-equality guard
   is skipped. No other read may key off "is on a public project."

**Why two branches, not "just make `canBrowse` return true":** the pure
policy never sees `workspaceId`; the 404 guard never sees `accessLevel`-vs-
membership. Each lives in its own layer, so the exception must be expressed
once in each — and the test (6.12.9) asserts BOTH: a cross-org account reads
a public project, AND a cross-org account still 404s on a non-public project
of the same org. Any third place that grants cross-org read is a bug.

### 3. Writes limited to submit + upvote + comment — three explicit grants, NOT a `canEdit` relaxation

A public viewer is **not a member**, so `canEdit` is FALSE for them on every
normal write (create / move / assign / status / field-edit) — unchanged from
6.4; `canEdit` gains **no** `public` branch. The three writes a public viewer
CAN do are NEW, narrow, independently-named pure predicates in
`lib/projects/access.ts`, each true for **any authenticated account on a
public project** and each independent of `canEdit`:

| Grant                     | True when                                    | Gates (consumer)                   |
| ------------------------- | -------------------------------------------- | ---------------------------------- |
| `canSubmitToTriage`       | the project is `public` (any authed account) | 6.12.5 submit-to-triage            |
| `canUpvotePublicRequest`  | the project is `public` (any authed account) | 6.12.6 upvote                      |
| `canCommentPublicRequest` | the project is `public` (any authed account) | 6.12.6 comment on a public request |

- **They decide over `accessLevel` alone** (plus the always-true fact that
  the route already required a session). They do NOT consult
  `workspaceRole` / `projectRole`, because their whole point is to admit a
  non-member. A project member on a public project also satisfies them (they
  are authenticated) — and additionally keeps their richer internal
  capabilities through the existing predicates.
- **No other write path may ever key off "is on a public project."** Every
  normal mutation stays gated by `canEdit` / `canComment` / `canManageProject`
  exactly as today. If a future write needs a public-viewer path, it gets its
  OWN named grant here — never a relaxation of an existing edit gate.
- **Each grant's write still routes through the shipped write authority**
  (`workItemsService`) inside one service transaction (4-layer), so the public
  writes obey the same invariants (kind-parent grammar, status workflow) as
  internal ones.

### 4. Visible vs HIDDEN — a public PROJECTION at the read layer

The public read goes through a dedicated **public projection** — a read
shape / DTO that NEVER includes the hidden internal fields — NOT a UI that
fetches everything and hides it (which would leak internal data over the
wire). The stripping happens in the service/repository read layer.

**The EXACT hidden-field set** (stripped from every public read):

| Hidden field          | Why                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------- |
| **assignees**         | who is doing the work is internal team information                                           |
| **estimates**         | story points / time estimates are internal planning data                                     |
| **internal comments** | the work item's own discussion thread (Story 5.1 comments) is internal — see the split below |

**What IS visible** (the public-safe fields):

- work item **key / title / kind / status / description**, board columns +
  ordering, the public **roadmap** (status-grouped, §6), **vote counts**,
  and **public-request comments** (§4 split, below);
- the project's **`publicOverviewMd`** (the public Overview/README Markdown
  field, added in 6.12.3) — a public-safe field included in the projection
  **only when the project is `public`**.

**The comment split (the line 6.12.2 must fix).** Two distinct threads:

- the work item's **internal discussion** (the existing Story 5.1 comment
  thread) is **HIDDEN** by the projection;
- a **public-request comment** (authored on a public request via
  `canCommentPublicRequest`, 6.12.6) is **PUBLIC-visible**.

To make this a data fact and not a UI convention, a public-request comment
carries an explicit **public-visible marker** (e.g. `comment.isPublic`,
default false), set true ONLY when the comment is authored through the §3
public-comment grant; the public projection returns **only `isPublic`
comments** for a request and never the internal thread. The marker lands in
6.12.6 (the card that builds public-request comments); the projection
contract is fixed here.

**Scope note — what is hidden is FIELDS, not WHICH items.** On a public
project the work items themselves are public by definition (that is what
"public" means), so the projection hides internal FIELDS uniformly; it does
not maintain a per-item public/private allow-list. Triage items remain
excluded from the normal board/list reads by the 6.11 `triagedAt` gate, and
surface only on the public submit / request-detail / roadmap-"submitted"
reads (§6).

### 5. READ is anonymous; WRITE requires sign-in

> **⚠️ REVISED 2026-06-14 (supersedes "Account-required, NOT anonymous" for
> READ).** Yue locked a revised model: a public project page is **FULLY PUBLIC —
> anyone VIEWS it with NO sign-in**, server-rendered + crawlable (SEO/GEO). Only
> the three **WRITES** (submit / upvote / comment) still require a signed-in
> account ("sign-in-to-act", the GitHub / Canny standard). Anonymous _writes_
> stay out of scope (they need the deferred abuse / anonymous-identity model).
> This matches the revised Story 6.12 seed + the 6.12.3 card, and is what Subtask
> 6.12.3 implements: `canBrowse` returns true for ANYONE — an unauthenticated
> request included — on a public project (the §2.1 leading branch already admits
> a null-role actor), and the public-read resolver (`resolvePublicInputs`) takes
> a NULLABLE actor. The bullets below describe the ORIGINAL (pre-revision)
> account-required posture and are retained for history; where they say "every
> public route is session-gated" / "there is no unauthenticated principal", read
> the revision: **READ is not session-gated; only the three writes are.**

A public viewer **MUST be a signed-in Motir account** (any org). Anonymous /
logged-out access is explicitly **out of scope (future)** — it would need an
anonymous-identity model + heavier abuse controls this story does not build.
Consequences fixed here:

- **Every public route is session-gated.** No session ⇒ redirect to sign-in,
  not a 200. `canBrowse`-via-public (§2) is evaluated for an _authenticated_
  actor; there is no unauthenticated principal.
- **Every write is attributed to a real account** and rate-limited **by that
  account** (§6) — every submit / upvote / comment carries a `userId` for
  attribution and per-account throttling.
- **The share link (6.12.8) is an ENTRY POINTER, not an auth bypass.** It is
  a stable public URL to the public view; following it still requires
  sign-in. Rotating / disabling the link changes the entry URL, never the
  access rule (the rule is `accessLevel === 'public'`).

This is the deliberate narrowing: GitHub-public-repo "anyone can read"
semantics, gated to "any _authenticated_ user," so every interaction carries
a real account.

### 6. Submission + dedupe + vote model

**Submission reuses 6.11's intake — on the AUTHENTICATED branch.** A public
submission is **born a `work_item` in the `triage` state** (the 6.11 model,
no second submissions table), created through `workItemsService` (6.11.4's
creation path), scoped to the public project. **Crucially, a 6.12 public
submitter is a REAL authenticated cross-org account, not the anonymous
portal submitter** of the triage ADR §3:

| Submission origin                       | `reporterId`                        | `externalSubmitter{Name,Email}` |
| --------------------------------------- | ----------------------------------- | ------------------------------- |
| 6.12 public-project submit (this story) | the **real cross-org account**      | NULL                            |
| 6.11 anonymous public-portal form       | the per-project intake service user | captured name + email           |

So a 6.12 public submission is the in-app-member shape (real `reporterId`,
honouring the non-null `reporterId` invariant) where the reporter merely
happens to be a workspace **non-member** — `reporterId` is an FK to `User`
with no membership precondition, so a cross-org account is a valid reporter.
Gated by `canSubmitToTriage` (§3), NOT `canEdit`. Rate-limited +
abuse-guarded per the 6.11.4 precedent (per-account throttle + size cap),
since it is an internet-facing write.

**Duplicate detection — deterministic, BEFORE create (Canny's behaviour).**
A service method takes a draft title/text and returns matching EXISTING
public requests for the project so the UI can offer **"upvote this instead"**:

- a **deterministic** title/text match (normalized-token / trigram
  similarity), reusing the shipped 6.1.1 FilterAST search where it fits —
  **NOT an AI call** (AI-assisted dedupe is a named Epic-7 enhancement, out
  of scope);
- it searches **only public-facing requests** (respecting the projection)
  and DOES include still-in-triage requests (a duplicate of an un-promoted
  request is still surfaceable);
- if the user picks an existing request, **NO new item is created** — the
  flow hands off to the §6 upvote (6.12.6); if they pick "submit as new," the
  create path runs.

**Vote model — one vote per account per item, server-enforced.** A
`PublicRequestVote` join `{ id, workItemId, userId, createdAt }`, **unique on
`(workItemId, userId)`**, modelled as a Prisma `@relation` on BOTH sides (to
`work_item` and `User`) per the FK-as-`@relation` migration rule (added in
6.12.3 alongside the access foundation so the schema is coherent in one
migration). The uniqueness makes a second upvote a **no-op / toggle**, never
a double count; a concurrent vote serializes via a row lock
(lock-before-read-derived-update) so the count never loses an update. The
**vote COUNT is a sort key the 6.11.3 triage queue reads**, so the project
admin sees the highest-demand requests first — the demand signal the whole
portal pattern is built around.

---

## Consequences

- **6.12.3** adds `public` to the `ProjectAccessLevel` enum (no default
  change), the `PublicRequestVote` join (every FK an `@relation` on both
  sides, unique on `(workItemId, userId)`), and the nullable
  `project.publicOverviewMd` Markdown column, all in one migration; extends
  `canBrowse` with the single leading `public` branch (§2.1) and adds the
  dedicated public-read resolution path + the three grants
  (`canSubmitToTriage` / `canUpvotePublicRequest` / `canCommentPublicRequest`,
  §3) on `projectAccessService`. `canEdit` is unchanged.
- **6.12.4** builds the public read-only view + Overview/README landing over
  the public projection (§4) — stripping assignees / estimates / internal
  comments at the read layer; the route is session-gated (§5) and resolves
  access through the §2.2 public path; a non-public project stays 404
  cross-org.
- **6.12.5** implements the authenticated cross-org submit (real
  `reporterId`, §6) through `workItemsService`, gated by `canSubmitToTriage`,
  rate-limited; plus the deterministic dedupe-before-create.
- **6.12.6** implements upvote (the `PublicRequestVote` toggle + the
  count-as-sort-key into 6.11.3) and the public-request comment (with the
  `isPublic` marker, §4), gated by `canUpvotePublicRequest` /
  `canCommentPublicRequest`, NOT `canEdit`.
- **6.12.7** builds the public roadmap over the §4 projection (status-grouped,
  vote-counted, paginated); 6.12.8 adds the four-level Access control + the
  share link (an entry pointer, §5) + the Overview editor.
- **6.12.9 / 6.12.10** assert the access matrix — a cross-org account READS a
  public project but `canEdit` is false; the three grants succeed; a
  non-public project is 404 cross-org (proving `public` is the _only_
  cross-org read exception) — plus the dedupe match and one-vote-per-account,
  on a real Postgres within the per-file coverage gate, and the cross-org e2e.
- **Extending the public capability later** (e.g. anonymous access, AI
  dedupe, custom-branded portal) reuses this enum value + the two-touch-point
  exception + the projection — no new access system, no second submissions
  table.

## References

- `scripts/plan-seed/data/story-6.12.ts` — the Story 6.12 module header (the
  locked model + the verified mirror this ADR records).
- `lib/projects/access.ts` — the pure `canBrowse` / `canEdit` / `canComment`
  / `canManageProject` policy + `ProjectAccessInputs` this EXTENDS (the
  workspace-owner/admin and non-member rails the §2.1 public branch leads).
- `lib/services/projectAccessService.ts` — `resolveInputs` (the
  `project.workspaceId !== ctx.workspaceId` → `ProjectNotFoundError` 404
  guard left untouched) + the capability methods; the §2.2 public-read
  resolution path is added here as the single workspace-equality bypass.
- `prisma/schema.prisma` — `enum ProjectAccessLevel { open limited private }`
  (`@default(open)`) the enum value extends; `work_item.reporterId` non-null
  (the §6 attribution respects); `project` (the `publicOverviewMd` column).
- `docs/decisions/triage-model.md` — the submission-IS-a-`work_item`-in-
  `triage` model the public submit reuses, and the member-vs-anonymous
  attribution split §6 places 6.12 on (the authenticated branch).
- `docs/decisions/public-follow-and-changelog.md` — Story 8.9: the PUSH half of
  this surface (a derived changelog tab, an anonymous Atom feed, and the
  `public_follow` row), which extends the §4 public PROJECTION with a
  time-ordered stream and RETIRES the external `links.changelog` row §2's
  sidebar renders today.
- `lib/services/workItemsService.ts` — the write authority submit / upvote /
  comment route through; `moveWorkItem` / `updateStatus` / `createWorkItem`.
- `lib/workflows/defaultWorkflow.ts` — the status keys/categories the public
  roadmap (6.12.7) maps to the four public buckets.
- Canny (https://canny.io/use-cases/feature-request-management) — duplicate
  detection + upvote-the-existing + status roadmap; OpenProject
  (https://www.openproject.org/roadmap/) + Plane (https://plane.so/open-source)
  — public project / public roadmap visibility; Productboard portal
  (https://support.productboard.com/hc/en-us/articles/360056315454) — the
  public portal + share-link + status roadmap shape.
- `notes.html` mistake #33 (verify the mirror, cite what was observed) +
  finding #26 (the project gate sits beneath the workspace gate — the rail
  §2 carves the public exception through) + the decision-authority ladder
  (mirror → shipped code → card) this ADR resolves from.

---

## AMENDMENT 1 (2026-09-27) — three access modes and a membership scope

**By:** Story MOTIR-6169 · Subtask MOTIR-6543, applying `docs/decisions/role-model.md` Q1
(confirmed at the DECISION, MOTIR-6165).

- **Levels → modes.** `ProjectAccessLevel` `{ open, limited, private, public }` is replaced, as
  the statement of who may ENTER, by `ProjectAccessMode` `{ workspace, members, public }` on
  `project.accessMode`. The data migration (MOTIR-6542) maps `open` → `workspace`, `limited` and
  `private` → `members`, `public` → `public`, and reports every person a `limited` project stops
  admitting. `accessLevel` is kept, written together with the mode, until the contract story
  drops it.
- **A membership scope.** Each workspace membership is `full` (enters every `workspace` /
  `public` project, plus any `members` project they were added to) or `limited` (enters ONLY the
  projects they were added to). A Manager — the org Owner and Admins included — enters every
  project; scope is never read for one.
- **One entry rule.** `canEnter` (`lib/permissions/resolve.ts`) decides entry; an entrant holds
  exactly their workspace role's keys and a non-entrant nothing, except the public read set on a
  `public` project. The per-level subtraction (`limited` withholding edit, `private` everything)
  retired with the levels.
- **Listings follow entry, not browse.** A project list, switcher or search shows the projects the
  actor can ENTER. `canBrowse` still answers the read gate, so a `public` project's link keeps
  working for a Limited person who was not added — as a visitor's does — without the project
  appearing among their own.
- **What stands.** §2's two touch-points (the public branch of the policy and the one
  workspace-equality bypass in `resolvePublicInputs`, which now reads `accessModeOf(project) ===
'public'`), §3's three grants, §4's projection and **§5 — READ anonymous, WRITE signed in** —
  are unchanged. The Visitor role that formalises the public read set is MOTIR-6170's.

## AMENDMENT 2 (2026-09-27) — the Visitor role, and its one resolution

**By:** Story MOTIR-6170 · Subtask MOTIR-6642, applying `docs/decisions/role-model.md` §4 and Q3
(confirmed at the DECISION, MOTIR-6165).

- **The Visitor is a role.** Anyone who cannot ENTER a `public` project — an anonymous reader, a
  signed-in person of another organisation, a Limited member who was not added — is that project's
  **Visitor**, granted automatically and stored nowhere.
- **Its key set is the Viewer's.** `VISITOR_PERMISSIONS` (`lib/permissions/builtinRoles.ts`) is
  DERIVED from `WORKSPACE_ROLE_PERMISSIONS.viewer`, never retyped: `project:browse`, `report:view`,
  `approval:view_any`, `plan:view_any`, `run:view_any` — every view key and nothing that writes,
  decides or authors (no `ai:view_plan`). A Visitor is a Viewer nobody assigned.
- **The public read set is the Visitor's plus the three request grants.** `PUBLIC_PROJECT_PERMISSIONS`
  = `VISITOR_PERMISSIONS` ∪ `{ public_request:submit, public_request:upvote,
public_request:comment }`, the grants motir.co's act routes still assert (§3). This ADDS
  `approval:view_any` and `report:view` to what a non-entrant held on a public project: the DECISION
  gives a Visitor every approval record.
- **One resolution.** `projectAccessService.resolveVisitor(identifier, session)` answers every
  Visitor URL with one of three verdicts: `not_found` (the public surface is off, no public project
  carries the identifier, or it is not `public` — ONE indistinguishable answer), `enter` (the
  session's user can enter the project and belongs in their own view), or `visitor` with the
  `VisitorReadContext` (`lib/visitor/context.ts`) every Visitor read takes — the project, the actor
  (or none), the Visitor key set and the private-epic hidden set (§4, `epic-privacy.md` §3) read
  once.
- **Not a third place.** `resolveVisitor` is built ON `resolvePublicInputs`, §2's existing
  workspace-equality bypass, so §2's _"any third place that grants cross-org read is a bug"_ stands
  unchanged.
- **Rate limited per IP.** A Visitor's reads spend the `public-read` scope
  (`lib/rateLimit/publicReadGuard.ts`), keyed on the client IP and separate from `public-write`, so
  reading never spends the allowance for filing a request.
