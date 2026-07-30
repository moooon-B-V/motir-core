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
