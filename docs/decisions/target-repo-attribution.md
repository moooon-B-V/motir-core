# Per-item repo attribution (`work_item.targetRepo`)

**Status:** accepted · **Date:** 2026-07-28 · **Card:** MOTIR-1804 (Story 7.9, the
Motir CLI) · **Supersedes:** the `targetRepo` half of the cancelled MOTIR-860 (7.7.3)

> **Amended 2026-07-30 (MOTIR-1783, Story MOTIR-1775).** Two decisions below were
> written when the workspace's connected repos were the only repo registry Motir had.
> `project_repository` (MOTIR-1780) now records a **project's** repository set, so:
>
> - **§2's validation domain is the ITEM'S PROJECT's set**, not the workspace's
>   connected repos — a pin naming a **sibling project's** repo is now the typed
>   error it always should have been. The domain includes rows whose repository is
>   not created yet: a plan pins repositories before it creates them (the set ADR
>   §5.1), so validation catches typos, not planning ahead.
> - **§3's dispatch default is the project's SINGLE established repo**, not the
>   workspace's single connected one. The refusal to guess at two or more is
>   unchanged, and is now pinned by a test so it cannot creep back.
>
> A project with **no** set — every project created before that table — resolves and
> validates against the workspace's connected repos exactly as described below; that
> is the compatibility rung, and it answers only for a MISSING set, never underneath
> one that exists. The dispatch payload additionally carries the resolved repo's
> **clone URL + default branch** (`targetRepoCloneUrl` / `targetRepoDefaultBranch`,
> derived from the mirror row — see `lib/repos/cloneUrl.ts`), because a bare name only
> answers an agent that already has the checkout. Details:
> `docs/decisions/project-repository-set.md` (§5 and its Consequences).

> **⚠️ Amended 2026-08-18 (MOTIR-3037, Story MOTIR-2732) — the attribution is a REFERENCE to the
> project's `project_repository` row, and the bare NAME below is what that reference resolves to on
> read.** §1's "bare name, not `owner/name`" is kept as the resolution's OUTPUT; §2's validation
> domain and §3's three-rung dispatch default are unchanged in substance. `work_item.targetRepoRole`
> and MOTIR-1913's resolution pass retire. See "Amendment 2026-08-18" at the foot of this file, and
> `docs/decisions/work-item-repository-set.md`'s amendment of the same date for the element shape.

## Context

A Motir project spans **several repos**. The planning rule "ONE SUBTASK = ONE REPO =
ONE PR" has so far lived only in the planner's prose — nothing in the product records
which repo an item belongs to.

The CLI half is already shipped and waiting for it. `motir link add <repo> <path>`
(7.9.1, `packages/cli/src/config/linkConfig.ts`) writes checkout-path overrides into
`.motir.json`, mapping a repo **name** to a directory; unmapped names resolve by the
convention `<link-root>/<repoName>`. So the CLI can already find repo B's checkout —
it just has no way to learn that an item belongs to repo B.

The producer that was supposed to supply it, MOTIR-860, was cancelled with all of
Story 7.7 on 2026-06-30; only its `sessionBranch` half survived (shipped separately as
7.8.10). MOTIR-881 (7.9.3, single dispatch) states its repo-routing criterion as "an
item targeting repo B dispatches with the agent's cwd inside B's checkout even when
invoked from repo A" and assumes the payload carries `targetRepo`. Verified against
`origin/main` @ `e6196636`: no `targetRepo` existed anywhere in `lib`, `app`,
`packages`, `prisma`, or `docs`.

## Decision

### 1. A nullable `targetRepo` column on `work_item`, holding the bare repo NAME

The value is the **bare name** (`motir-core`), not the `owner/name` ref. That is
exactly the key the CLI's `repos` override map and its `<root>/<repoName>` convention
already use, so the two halves fit with zero translation. The authoring surface
_accepts_ `owner/name` and normalizes it to the name, because that is the form the
GitHub surfaces and `resolveCodeContext` display — an agent copying from either place
lands in the same state.

Column-level alternatives rejected:

- **A FK to `github_repo`.** The connected set is workspace-scoped and mutable —
  disconnecting a repo would either cascade the attribution away or block the
  disconnect. A pin should survive a repo being briefly disconnected; it is a
  planning decision, not a foreign-key relationship.
- **A second repo registry** (a `project_repo` table). The workspace already has a
  connected repo set — the 7.10.3 installation mirror (`github_repo`, both providers).
  Two registries would drift.

### 2. Validated at the write layer against the workspace's CONNECTED repo set

`create_work_item` / `update_work_item` (and every other `createWorkItem` /
`updateWorkItem` caller) reject an unknown name with the typed
`UnknownTargetRepoError` → 422 / a self-correctable MCP tool error naming the
connected set. Matching is case-insensitive and the **connected repo's own casing is
stored**, so the column and `.motir.json` can never disagree on a directory name.

The validation domain is provider-agnostic — every repo under any of the workspace's
installations (GitHub _and_ GitLab, which share the `github_repo` table). The CLI
routes on a _checkout_, and a GitLab-connected repo is checked out exactly like a
GitHub one, so narrowing by provider would reject a legitimate pin. (This is the one
place the resolution deliberately differs from `lib/ai/codeContext.ts`, which reads
the GitHub installation only because motir-ai's code graph is GitHub-keyed.)

No DB constraint backs this: the domain lives in another table and changes as repos
connect and disconnect. A pin that was valid when written stays readable afterwards.

### 3. The default is resolved at DISPATCH, never baked into the row

`ReadyItemDispatchDto.targetRepo` (so `next_ready`, `claim_next_ready`, and
`POST /api/ready/next`) carries the **resolved** value:

1. the item's explicit pin, when it has one; else
2. the workspace's **single** connected repo, when it has exactly one; else
3. `null`.

The column itself only ever holds an explicit pin. `WorkItemDto.targetRepo` exposes
that raw pin, so the authoring surfaces can tell "pinned to the only connected repo"
from "not pinned".

Two consequences worth being explicit about:

- **No backfill, and no write-time defaulting.** Baking today's default into every row
  would freeze a _guess_ in a column whose whole purpose is to record a _decision_ —
  and afterwards the two would be indistinguishable. Resolving at read time also means
  the payload always reflects the current connected set.
- **`null` is a real answer, never a guess.** With two or more connected repos and no
  pin, Motir says "I don't know" and the CLI falls back to its link-root/bootstrap
  rule, where a human notices immediately. Dispatching an agent into an arbitrary
  checkout would be silently wrong, which is strictly worse.

## Consequences

- The CLI's repo routing (MOTIR-881) has its producer; `.motir.json`'s `repos` map and
  the payload now speak the same vocabulary (bare repo names).
- The planner can enforce ONE SUBTASK = ONE REPO **in the product**, at plan time, via
  `create_work_item` / `update_work_item` — not only in `plan-rules.md`.
- A repo change is a first-class History entry (`activity.fields.targetRepo`), so an
  agent dispatched into the wrong checkout is auditable.
- Dispatch does one extra workspace-scoped read (the connected repo set) for the ONE
  item being dispatched. The list read (`GET /api/ready`) is untouched.

## Amendment 2026-08-18 (MOTIR-3037, Story MOTIR-2732) — the attribution is a REFERENCE; the NAME is what it resolves to

**Card:** MOTIR-3037 · **Read on `origin/main` @ `d3346bad`.** Companion amendment:
`docs/decisions/work-item-repository-set.md` "Amendment 2026-08-18", which carries the element
shape, the migration and the delivery states. This one amends the ATTRIBUTION MODEL — the thing
this ADR decided, and the thing every section below reasons about **as a name**.

### What changes

> **A work item is attributed to a repository by pointing at the project's `project_repository`
> ROW. The bare NAME every surface still publishes is what that reference RESOLVES to on read —
> the realized repository's own `name`, falling back to the row's authored `name` before the
> repository exists.**

§1's choice of "the bare repo NAME, not the `owner/name` ref" is **kept, as the resolution's
output**: the CLI's `repos` override map and its `<root>/<repoName>` convention are untouched,
the dispatch payload still carries one bare name, and `packages/cli` needs no change. What moves
is where that name comes FROM — a column the product stored, versus a row the product resolves.

### Why §1's own reasoning now points the other way

§1 rejected a foreign key **to `github_repo`** on two grounds, both correct and both about that
table:

- _"The connected set is workspace-scoped and mutable — disconnecting a repo would either cascade
  the attribution away or block the disconnect."_
- _"A second repo registry (a `project_repo` table). The workspace already has a connected repo
  set … Two registries would drift."_

The second one shipped anyway, deliberately: `project_repository` (MOTIR-1780) exists, and this
ADR's own **2026-07-30 amendment** already moved §2's validation domain onto it. So the choice is
no longer "one registry or two"; it is "a card points at the registry it is already validated
against, or copies a string out of it." And the first objection does not survive the move either
— `ProjectRepo.githubRepoId` is `@relation(…, onDelete: SetNull)`, so a disconnect nulls the
mirror and **leaves the row**: the pin survives a disconnect _because_ it references the planning
row rather than the connected one, which is exactly the property §1 was defending.

What a stored name cannot survive is the case `ProjectRepo.name`'s own comment names —
_"a rename on the host must not silently re-point a dispatch"_. A `work_item.targetRepo` holding
a name IS silently re-pointed by that rename, and nothing in the product notices. That is the
defect this amendment exists for, and it is a defect of the attribution model, not of the set.

### §2's validation, restated as resolution

§2 (as amended 2026-07-30) validates an authored name against the item's PROJECT's repository set,
with the workspace's connected repos as the compatibility rung for a project that has none. Both
rungs stand. What the write path now does with the result is keep the **row**, not the string:

- A name that matches a row in the project's set — in ANY state, per the authoring domain
  `lib/projectRepos/names.ts`'s `toProjectRepoPinNames` (which already returns the `rowId`) — is
  stored as a reference to that row.
- A name that matches nothing is the same typed `UnknownTargetRepoError` → 422 / self-correctable
  MCP error, unchanged.
- A name that resolves only through the **compatibility rung** (a project with no set at all) has
  no row to point at. It is stored in the FROZEN legacy `work_item.targetRepo` and read as the
  last rung of name resolution — see the companion amendment's §A7 for why the migration does not
  invent rows for that population.

Matching stays case-insensitive, and the casing stored is the domain repository's own — but it is
now stored in one place, `github_repo.name`, rather than copied per card.

### §3's three-rung dispatch default is UNCHANGED, and now reads one level in

`resolveDispatchRepo` answers with the same three rungs and the same refusal to guess:

1. the item's explicit primary — now **the first REFERENCE, resolved to a name** (the realized
   repository's, else the row's authored one), else the frozen legacy scalar for the unresolvable
   tail;
2. the project's SINGLE established repository, when that is unambiguous;
3. `null` — a real answer the CLI acts on.

The two consequences §3 states are strengthened rather than changed. **"No backfill, and no
write-time defaulting"** — the migration backfills the REFERENCE from the decision already
recorded, and still bakes no default into any row. **"`null` is a real answer, never a guess"** —
a reference to a row that is `proposed`, `creating` or `failed` resolves to no checkout and
therefore to `null` at dispatch, exactly as an unresolved role did; what changes is that the
card can now SAY which repository it is waiting on, because it is pointing at it.

### What retires

**`work_item.targetRepoRole` and MOTIR-1913's resolution pass.** This ADR's model needed neither —
they belong to `project-repository-set.md` §5.2/§5.3, which introduced the role precisely because
"a name pinned at generation is stale the moment the user edits a row, and meaningless before the
row is created at all." A reference is stale under neither condition, so the stand-in and the pass
that resolved it both go. The companion amendment's §A3 carries the reading that settled it and
the two costs it accepts.

### Consequences, amended

- The bullet _"A repo change is a first-class History entry (`activity.fields.targetRepo`), so an
  agent dispatched into the wrong checkout is auditable"_ **still holds and gets sharper**: the
  activity entry records the reference that changed, and renders the name it resolved to at the
  time — so a rename no longer looks like a re-attribution in the history, which under the stored
  name it could not be distinguished from.
- The bullet about the CLI and `.motir.json` speaking the same vocabulary is unchanged: the
  vocabulary is still bare repository names, and the CLI never sees a reference.
- One new cost, stated: the dispatch read gains a join from the item to its repository rows. It is
  the same read that MOTIR-2725 already added to render per-repository delivery, so no query is
  added — one is widened.
