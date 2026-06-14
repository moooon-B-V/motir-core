# ADR: Epic-level privacy on public projects — the `publicChildrenHidden` flag + server-side-everywhere exclusion

- **Status:** Accepted (2026-06-13, model locked with Yue 2026-06-12)
- **Story / Subtask:** 6.14 (Epic-level privacy on public projects) · Subtask 6.14.2
- **Supersedes / superseded by:** none
- **Extends:** `public-projects.md` (Story 6.12 — the `public` access level + the
  public PROJECTION). This ADR adds ONE predicate to that projection; it does NOT
  fork a parallel access or read system.
- **Consumed by:** 6.14.3 (the `work_item` flag + migration + the supporting
  index), 6.14.4 (the server-side exclusion predicate + the tell-strip / marker,
  threaded into the 6.12.4 public projection across every read path), 6.14.5
  (tree-expand placeholder UI), 6.14.6 (detail child-panel placeholder UI), 6.14.7
  (the project-admin set/unset control), 6.14.8 (the enforcement + toggle vitest),
  6.14.9 (the cross-org public-viewer-vs-member e2e).

> Structured **Status → Context → Decision → Consequences → References**, the
> convention the repo's ADRs set (`work-item-type-taxonomy.md`, `triage-model.md`):
> the load-bearing facts are pinned in explicit tables so the schema (6.14.3), the
> enforcement (6.14.4), and the admin control (6.14.7) build against one
> authoritative source rather than each re-deriving the shapes. **No application
> behaviour ships in this subtask;** the shapes it freezes are what make the rest
> of the story buildable — and, above all, what make the load-bearing no-leak
> guarantee a single auditable predicate instead of N scattered filters.

---

## Context

Story 6.12 shipped **public projects**: a fourth `ProjectAccessLevel = public`
on which ANY authenticated Motir account reads CROSS-ORG (the single bypass of
the 6.10 org/workspace membership gate), through a dedicated **public PROJECTION**
(6.12.4) — a read shape at the service/repository layer that strips internal-only
fields (assignees, estimates, internal comments) so nothing internal crosses the
wire. Every public surface (Overview / board / work-item list / roadmap) flows
through that one projection.

Story 6.14 adds the next control an admin of a public project needs: the ability
to mark an individual **EPIC** as **private**, so that the epic's whole subtree —
its stories / tasks / subtasks — plus the epic's aggregate **tells** (child count,
progress / rollup, point total) are hidden from public / non-member viewers, while
the epic **ROW itself stays visible** as a deliberate "this epic is not public"
placeholder. Project **members** continue to see everything. The "not public"
statement appears in TWO places for a public viewer: (a) when they EXPAND the
private epic in the work-item TREE (the children rows are replaced by the
placeholder), and (b) the CHILD PANEL on the epic's work-item DETAIL page.

The shape decision that governs everything downstream is **how the hiding is
modelled and enforced**. The naive alternatives both fail:

1. **A hard 404 on the epic row.** Makes the public project look broken — a gap
   in the roadmap with no explanation. Rejected: the row staying visible is a
   deliberate public-transparency choice ("there are N epics; this one's details
   are private").
2. **A client-side hide** (fetch the children, hide them in the DOM). Leaks the
   entire subtree over the wire — visible in the network tab — exactly the
   anti-pattern GitLab/Jira server-side enforcement exists to prevent. Rejected.

So the model is: **a privacy flag on the epic, scoped to public projects, enforced
SERVER-SIDE on EVERY read path by a single predicate threaded into 6.12's public
projection** (Yue, locked 2026-06-12). A private epic's children must NEVER be
transmitted to a public/non-member viewer by ANY read — the tree, the detail
child-panel, the public board, the 7.0 ready set, and the 6.1 FilterAST search
are ALL filtered at the read/service layer, so nothing leaks. This ADR fixes the
six load-bearing details that shape leaves open: the **flag** (§1), the
**public-project scope** (§2), the **server-side-everywhere enforcement** (§3),
the **aggregate-tell strip + marker** (§4), the **member-bypass + admin-only
set** (§5), and the **descendant test** (§6).

### The verified mirror (rung 1 — verified, not asserted; checked 2026-06-12)

Per the decision-authority ladder, the mirror product is the primary standard.
Epic-level public-privacy has three converging references, each observed in the
docs (not asserted from memory — `notes.html` #33):

- **GitLab confidential issues** — an issue visible only to project members with
  sufficient role; non-members cannot view it AND it is "hidden in search results
  for users without the necessary permissions" — i.e. the hiding is **server-side
  and applied to search too**, not a client toggle. Motir's analogue raises this
  from a single issue to an epic **subtree** (the children), with the parent row
  kept as a visible placeholder rather than a hard 404.
  (https://docs.gitlab.com/ee/user/project/issues/confidential_issues.html)
- **Jira issue-level security (security schemes / levels)** — "A secured work item
  is not visible ANYWHERE in Jira to a user who is not in the work item's security
  level": the enforcement is **total and server-side, applied across every view and
  search**, and a Jira ADMIN can always add themselves to a level — the exact
  "members/admin bypass the exclusion" shape. Motir mirrors the
  server-enforced-hidden-with-no-leak posture (with a placeholder for the epic row
  rather than total invisibility — the kept row is the deliberate transparency
  choice).
  (https://confluence.atlassian.com/adminjiraserver/configuring-issue-level-security-938847117.html)
- **Canny / Productboard per-item public-roadmap visibility** — the
  public-feedback-portal mirror (the same rung-1 portal 6.12 mirrors) ships a "what
  shows on the public roadmap" visibility control: Canny scopes the public roadmap
  by board/status toggles (an unchecked board "will not display"), and Productboard
  portals show non-members ONLY public-facing items. That is the "show on public
  roadmap" toggle Motir productizes at **epic granularity** — the admin decides
  which epics' contents are public.
  (https://help.canny.io/en/articles/3828148-public-roadmap,
  https://support.productboard.com/hc/en-us/articles/360056315454)

The synthesis Motir ships: **GitLab/Jira's server-enforced, search-inclusive,
no-leak hiding + member/admin bypass**, applied to an **epic subtree**, with the
**Canny/Productboard "kept, visible placeholder row"** instead of total
invisibility.

---

## Decision

### §1 — The model: an epic-kind boolean flag `publicChildrenHidden` on `work_item`

| Fact                | Decision                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Column              | `publicChildrenHidden Boolean @default(false)` on `work_item` (6.14.3)                                                                                     |
| Meaningful for      | **epic-kind items only** — a no-op marker on any other kind                                                                                                |
| What it hides       | the epic's **descendants** (stories / tasks / subtasks) + the epic's **aggregate tells** (child count / progress / points) — for public/non-member viewers |
| What it never hides | the epic **ROW** (key / title / kind / status stay visible — the deliberate placeholder)                                                                   |
| Set/unset by        | the **project admin** only (§5)                                                                                                                            |

**Boolean, not an enum — justification.** The only state the story needs is binary:
_are this epic's children public, or hidden from non-members?_ An epic `visibility`
enum (`public | private_children`) would buy a named slot only if a THIRD epic
visibility mode were anticipated — most plausibly `private_entirely` (hide the row
too). But the story makes hiding the row a **named non-goal** (the visible row IS
the feature — the public-transparency placeholder), so no third state is on the
roadmap. A boolean is therefore the durable shape, not a shortcut: it is the
complete state space the locked model has. The name `publicChildrenHidden` encodes
the exact semantics (a generic `private` would be ambiguous about whether the row
is hidden too). **If a third mode ever lands**, migrating one boolean to an enum is
a contained, mechanical migration; this ADR is the recorded trigger for that
revisit, so choosing the boolean now forecloses nothing.

**Epic-only — REJECT on a non-epic, do not silently ignore.** Setting the flag on
a story/task/subtask is **rejected at the write layer** (6.14.7 — the service
validates `kind === 'epic'` and throws a typed error the route maps to 422/400),
not silently coerced to a no-op. Rationale: a silent ignore hides a caller bug
(the API would 200 on a meaningless write); an explicit rejection surfaces it. The
constraint is **enforced in the service**, not a DB CHECK — "the column may be true
only when `kind = 'epic'`" is awkward and brittle as a CHECK across the kind enum,
and the 4-layer write authority (`workItemsService`) is where kind-shaped
validation already lives. 6.14.3 MAY add a cheap partial CHECK/index if it falls
out naturally, but the service guard is the authoritative contract and the one
6.14.8 tests directly.

### §2 — Scoped to public projects (a no-op everywhere else)

The flag is **stored** on the epic regardless of project access level, but its
enforcement branch is **reached ONLY when the viewer is a non-member AND the
project's `accessLevel = public`.** It changes NOTHING:

- on a **non-public** project — there is no "public/non-member viewer" population
  there at all (6.12's cross-org READ exception is the only thing that creates one;
  a cross-org user on a non-public project stays **404-not-403**, untouched by this
  story);
- for a **member** on a public project — members bypass (§5);
- for the **admin** — the admin reads as a member.

So the flag is inert until BOTH conditions hold. An admin MAY pre-mark an epic
private before flipping the project to public (the flag persists and simply has no
effect until then). This keeps the new behaviour strictly additive: no existing
read on any existing project changes.

### §3 — Server-side enforcement on EVERY read path (the load-bearing requirement)

The exclusion is **a SINGLE predicate threaded into the 6.12.4 public PROJECTION**,
gated on `viewer is non-member on a public project`:

> **the predicate:** a work item whose epic ancestor has `publicChildrenHidden =
true` is **EXCLUDED** from the projected result.

Because 6.12 centralised the public read in ONE projection that every public
surface already flows through, this is one auditable branch — **NOT N independent
filters** scattered across the reads. Every read that goes through the projection
inherits the exclusion and cannot leak. The exact read paths the predicate must
cover (the checklist 6.14.4 implements and 6.14.8 tests):

| #   | Read path                                                        | Exclusion effect for a non-member                                                                  |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | **Tree projection** (`getProjectTree` / forest)                  | children of a private epic are ABSENT from the tree payload                                        |
| 2   | **Work-item DETAIL child-panel** (`listChildIssues` of the epic) | returns EMPTY + the "children-hidden" marker (§4)                                                  |
| 3   | **Public BOARD** (6.12 board read)                               | cards descending from a private epic are absent                                                    |
| 4   | **Ready SET** (7.0 `ReadyItem` read)                             | items descending from a private epic are absent                                                    |
| 5   | **FilterAST SEARCH** (6.1.1 compiled query)                      | a child of a private epic does NOT match — mirroring GitLab confidential issues hidden from search |

**Excluded server-side, never client-side.** The children are removed at the
read/service layer — they are never SELECTed into the response — so there is no
leak in the API / network tab. The enforcement is **parameterized over the read
set** (a shared projection helper), so adding a NEW public read without applying
the predicate is a defect 6.14.8's parameterized test is designed to catch.

### §4 — The aggregate-tell strip + the "children-hidden" marker

A private epic's public-projection **ROW** must not leak the _shape_ of the hidden
subtree. The projection of that row:

| Field                               | Public viewer (non-member)            | Member           |
| ----------------------------------- | ------------------------------------- | ---------------- |
| `key` / `title` / `kind` / `status` | present (the visible placeholder row) | present          |
| `childrenHidden` (the marker)       | **`true`**                            | `false` / absent |
| `childCount`                        | **omitted / null**                    | real count       |
| `progress` / rollup                 | **omitted / null**                    | real rollup      |
| `pointTotal`                        | **omitted / null**                    | real total       |
| children (nested / via child read)  | **absent** (§3)                       | present          |

**Marker DTO shape.** The public work-item node DTO gains an optional
`childrenHidden?: boolean`. When `true`, the count / progress / point fields are
null (or omitted) in that same projection — set together, in the projection layer,
so the two can never disagree. The UI (6.14.5 / 6.14.6) renders the placeholder
**off the marker alone** and therefore never has a child in hand to leak or a tell
to reconstruct. The marker is the contract between the no-leak server (§3) and the
placeholder UI: the UI is told "hidden", not given the data and asked to hide it.

### §5 — Members bypass; the admin sets the flag

- **Member bypass.** The exclusion predicate is **gated on the viewer being a
  non-member**; a project member's reads return the children + the real rollups
  exactly as today. No read path may key the exclusion off anything other than
  **`non-member-on-a-public-project` AND `descends-from-a-private-epic`** — not the
  flag alone, not the project level alone.
- **Admin-only set/unset.** Only the **project admin** can set/unset
  `publicChildrenHidden`, reusing the **existing 6.4 project-admin check** (the gate
  6.4.4's `setAccessLevel` / `projectMembersService` already enforces — `done`).
  **No new permission is introduced.** A non-admin write is rejected (403); the
  6.14.7 UI shows the control read-only / absent for non-admins.

### §6 — The descendant test ("descends from a private epic"), kept indexable

The `work_item` tree is `epic → story → task/subtask` (leaf depth ≤ 3 per the
kind-parent matrix in `prisma/sql/work_item_triggers.sql`), resolved today by a
**recursive CTE over `parentId`** (`findProjectForest` / `findSubtree`) — there is
**no denormalized epic/root-ancestor column** on `work_item`. The exclusion stays
an in-SQL predicate (finding #57 — never a load-all-then-filter-in-app):

1. **Resolve the project's private-epic id set** — `SELECT id FROM work_item WHERE
projectId = :p AND kind = 'epic' AND publicChildrenHidden = true`. This set is
   tiny (bounded by the project's epic count) and cheaply indexed. 6.14.3 adds the
   **supporting index** this read needs (e.g. a partial index on
   `(projectId) WHERE publicChildrenHidden`), so it stays an indexable lookup.
2. **Apply membership of the epic ancestor in that set as a `WHERE` clause:**
   - For the **recursive tree/forest reads** (paths 1–2), thread the exclusion
     through the **same CTE the read already uses** — propagate a `privateAncestor`
     flag down the recursion (a row inherits it when its parent had it OR its parent
     is a private epic) and drop rows where it is set. No second pass, no app-memory
     filter.
   - For the **flat reads** (board / ready / search, paths 3–5), the predicate is
     "the item's epic ancestor ∈ private-epic-id-set". Because the chain is bounded
     at depth ≤ 3 and top-level epics have `parentId IS NULL`, the epic ancestor is
     reachable via the bounded `parentId` chain (indexed by
     `@@index([projectId, parentId, position])`); the projection resolves it with a
     bounded join / `EXISTS` against the private-epic set rather than walking rows in
     app memory.

**A denormalized root-epic column is explicitly CONSIDERED and DEFERRED.** Storing
each item's root-epic id would collapse every flat read to a single indexed
equality, but it costs write-time maintenance (re-parent and flag-toggle fan-out
across the subtree) plus a backfill migration, and it duplicates ancestry the
recursive CTE already derives. Given the bounded depth and the tiny private-epic
set, the CTE-propagation + bounded-join approach is correct, simpler, and has no
write-amplification — so it is the chosen shape. If later profiling shows the
ancestor resolution is hot on a large public board, adding a trigger-maintained
root-epic column is a **contained optimization that does not change this predicate's
contract** (the projection still asks "does the epic ancestor carry the flag?").
This ADR records that as the deferred follow-up, not a shortcut taken now.

---

## Consequences

- **6.14.3** adds `publicChildrenHidden Boolean @default(false)` to `work_item` in
  one migration, backfilling existing rows to `false` (no behaviour change on
  deploy), plus the partial index §6.1 needs. The epic-only rule is enforced at the
  write layer (§1), not a DB CHECK (a cheap CHECK is optional, not required). FK
  rules don't apply (it's a scalar), but the CLAUDE.md migration discipline does.
- **6.14.4** owns the single predicate + the tell-strip / marker in the 6.12.4
  projection, applied across all five read paths (§3) via a parameterized helper, so
  a future public read is caught if it skips the predicate.
- **6.14.5 / 6.14.6** render the placeholder purely off the §4 `childrenHidden`
  marker — they never receive a child, so there is nothing for the client to leak or
  to reconstruct a tell from. Both use the same copy (the 6.14.1 design), one inline
  at the tree child-indent, one in the detail child-panel slot.
- **6.14.7** is the admin-gated write, reusing the 6.4 admin check (no new
  permission), validating `kind === 'epic'` and rejecting otherwise; the toggle uses
  the inline-edit "success response is the confirmation" pattern (no whole-tree
  refresh).
- **6.14.8 / 6.14.9** lock the guarantee: a non-member cannot read a private epic's
  children via ANY path (asserted at the PAYLOAD level, not the DOM), the tells are
  stripped, a member bypasses, the flag is a no-op on a non-public project, and the
  admin toggle flips enforcement live.
- **The exclusion is additive and centralised.** Because it is one predicate in an
  existing projection gated on a population that only exists on public projects, no
  existing read on any existing project changes; the blast radius is exactly "a
  non-member viewing a public project."
- **Deferred (recorded, not owed by this story):** a denormalized root-epic
  ancestor column as a read optimization (§6); finer-grained (story/task-level)
  privacy and per-viewer allow-lists (the story's named out-of-scope items); and
  anonymous public access (6.12 already deferred it — a viewer is always a signed-in
  account).

---

## References

- **Story / plan:** `scripts/plan-seed/data/story-6.14.ts` (this story — the locked
  model, scope, and the verification recipe) · `scripts/plan-seed/data/story-6.12.ts`
  §§ 6.12.2 (public-access semantics), 6.12.4 (the public PROJECTION this extends),
  6.12.7 (the public roadmap that also honours it) ·
  `scripts/plan-seed/data/story-6.4.ts` § 6.4.4 (the project-admin check the set/unset
  reuses — `done`).
- **Repo decisions:** `docs/decisions/public-projects.md` (6.12.2 — the ADR this
  extends) · `docs/decisions/triage-model.md`, `docs/decisions/work-item-type-taxonomy.md`
  (the ADR structure + the read-exclusion-everywhere precedent).
- **Code:** `lib/services/workItemsService.ts` (the write authority the set/unset
  routes through; the tree / detail-child / ready-set read paths the predicate threads
  into) · `lib/repositories/workItemRepository.ts` (`findProjectForest` / `findSubtree`
  — the recursive `parentId` CTE the descendant walk reuses) · `prisma/schema.prisma`
  (the `work_item` model + `ProjectAccessLevel` enum) ·
  `prisma/sql/work_item_triggers.sql` (the kind-parent matrix — epic → story →
  task/subtask).
- **Mirror (verified 2026-06-12):** GitLab confidential issues
  (https://docs.gitlab.com/ee/user/project/issues/confidential_issues.html) —
  hidden-from-non-members incl. search, server-side · Jira issue-level security
  (https://confluence.atlassian.com/adminjiraserver/configuring-issue-level-security-938847117.html)
  — "not visible anywhere" + admin bypass · Canny public roadmap
  (https://help.canny.io/en/articles/3828148-public-roadmap) + Productboard portals
  (https://support.productboard.com/hc/en-us/articles/360056315454) — per-item "what
  shows publicly" visibility.
  </content>
  </invoke>
