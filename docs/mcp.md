# Model Context Protocol (MCP) server

Motir exposes its project-management core to AI agents over one
**streamable-HTTP MCP endpoint**. Point any Model Context Protocol client —
Claude Code, a custom agent, the Motir CLI — at the endpoint, authenticate with
a personal access token, and the agent can read the ready set, dispatch the next
item, create work items, transition statuses, comment, search, and run the full
sprint cadence — using exactly the same services, permissions, and data the web
UI uses.

This document covers the server landed in Story 7.8: the endpoint, the
bearer-PAT auth gate, how to create a token, how to wire an agent, and the
complete catalog of every shipped tool with its input and output shape.

## What the Motir MCP server is

- **One endpoint, streamable HTTP.** The server is a single route —
  `app/api/mcp/route.ts` — served at `POST /api/mcp`. It speaks streamable HTTP
  only (no legacy SSE), is stateless (a fresh transport per request, no redis),
  and is never cached (`dynamic = 'force-dynamic'` — readiness and work-item
  state change constantly). It runs on the Vercel `mcp-handler` adapter, which
  bridges Next.js's Web `Request`/`Response` to the MCP SDK transport.
- **Every tool is a thin adapter over a service.** A tool resolves the
  `PROD-<n>` keys in its input to ids, then calls the **same service method an
  HTTP route calls** — `workItemsService`, `commentsService`, `sprintsService`,
  `backlogService`, … No tool contains business logic and no tool re-implements
  authorization.
- **An agent sees exactly what its token's user sees.** The bearer PAT resolves
  to its owning user; every service call runs in that user's
  `ServiceContext` (`{ userId, workspaceId }`), so the Story 6.4 role checks and
  the 404-not-403 cross-tenant contract apply unchanged (see
  [Permission model](#permission-model)).
- **It lives in motir-core.** This is the open agent-dispatch surface of the
  Motir stack — the place a hosted or BYOK coding agent connects to pick up and
  update work.

```
agent ──POST /api/mcp (Authorization: Bearer motir_pat_…)──▶ withMcpAuth
        └─ verifyMcpToken: resolve PAT → { userId, workspaceId } (401 if absent/invalid/revoked/expired)
           └─ tool handler ──ServiceContext──▶ the SAME service the UI route calls
```

## Creating an API token

The MCP server authenticates with a **personal access token (PAT)**. Mint one
from the web UI:

**Settings → Account → API tokens → Create.**

Give the token a **label** (a human name, e.g. `claude-code`, ≤ 100 chars) and
an **expiry** (the select offers 30 / 90 / 365 days or never; 90 days is the
recommended default). On create, the **full plaintext token is shown exactly
once**, with a copy affordance:

```
motir_pat_<43 url-safe characters>
```

**Copy it then — it is irretrievable afterward.** Motir stores only a SHA-256
hash of the token plus a short display prefix; nothing can reproduce the
plaintext. The token list afterward shows, per row, only:

- the display **prefix** (e.g. `motir_pat_Ab` — a hint, never the secret),
- **created**, **expires** (or "never"), and **last used** timestamps,
- a **Revoke** action.

Token management is a cookie-session UI action: you create, list, and revoke
your **own** tokens while signed in to the web app. A PAT itself cannot mint
more PATs — the MCP tool surface has no token-management tool. Cross-user token
ids read as not-found (the 404-not-403 contract), so a token only ever
sees/mutates its owner's tokens.

## Token scopes

Every token carries a set of **scopes** — the capability boundary for that
token. At dispatch, each tool call is gated by the granted scopes: if the
tool's scope is not in the token's set, the call is rejected with a typed
**`SCOPE_NOT_GRANTED`** error _before_ any work runs.

**Scope NARROWS; it does not replace the role.** The token still acts as its
owner, so the same workspace/project access checks apply on every call (a
foreign or unreachable item is still a 404-not-403 not-found). A call must pass
**both** gates: the token must hold the tool's scope **and** the owner's role
must permit the operation. A token whose owner is an admin but whose
`work_items:delete` scope is off still cannot delete; a token that holds the
delete scope still cannot delete in a workspace its owner can't reach.

The scopes and the tools each one gates:

| Scope                | Gates                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`               | `get_work_item`, `list_ready`, `next_ready`, `search_work_items`, `whoami`, `list_sprints`                                                          |
| `work_items:write`   | `create_work_item`, `update_work_item`, `transition_status`, `add_comment`, `link_work_items`, `unlink_work_items`, `move_to_parent`, `change_kind` |
| `work_items:archive` | `archive_work_item`, `unarchive_work_item` (recoverable soft-remove)                                                                                |
| `work_items:delete`  | `delete_work_item` — the only irreversible, subtree-cascade op; **OFF by default**                                                                  |
| `sprints:write`      | `create_sprint`, `update_sprint`, `delete_sprint`, `start_sprint`, `complete_sprint`, `move_to_sprint`, `move_to_backlog`                           |
| `integration`        | `mark_integrated`, `complete_session`                                                                                                               |

**Default grant set.** A token minted without an explicit scope choice gets
**every scope EXCEPT `work_items:delete`** — full read + write + archive +
sprint + integration, with the single irreversible cascade-delete opt-in only.
Archive stays on by default (it is recoverable); only `delete_work_item`, which
cascades to the whole subtree, must be granted deliberately.

## Wiring an agent

Use the endpoint URL for your deployment. In **local development** it is:

```
http://localhost:3000/api/mcp
```

In a hosted deployment, replace the origin with your Motir host (e.g.
`https://<your-motir-host>/api/mcp`). Authenticate with the
`Authorization: Bearer <token>` header on every request.

### Claude Code CLI

```bash
claude mcp add --transport http motir http://localhost:3000/api/mcp \
  --header "Authorization: Bearer motir_pat_…"
```

### `.mcp.json`

The equivalent project config block:

```json
{
  "mcpServers": {
    "motir": {
      "type": "http",
      "url": "http://localhost:3000/api/mcp",
      "headers": {
        "Authorization": "Bearer motir_pat_…"
      }
    }
  }
}
```

### Any streamable-HTTP MCP client

Point the client at the endpoint and send the bearer header:

```
Transport:  streamable HTTP
URL:        http://localhost:3000/api/mcp
Header:     Authorization: Bearer motir_pat_…
```

A request with an absent, malformed, unknown, revoked, or expired token is
rejected with **401** (a `WWW-Authenticate` response) **before any tool runs** —
the rejection never distinguishes the reason, so a caller can't probe token
state.

## Tool catalog

The server reports itself as `{ name: "motir", version: "0.1.0" }` in the MCP
`initialize` handshake and registers **26 tools**.

**Dual-content convention.** Every successful tool result carries **both** a
human-readable `text` block (a compact summary a person watching the session can
read) **and** `structuredContent` — the DTO JSON an agent parses. The DTOs are
the exact shapes the HTTP routes already ship; the tools deliberately declare no
`outputSchema`, so `structuredContent` is free-form DTO JSON. On a failure a
tool returns an `isError` result whose text is `CODE: message` (the service's
own typed error code + message), so an agent can self-correct.

Shared input conventions:

- A **work item** is addressed by its `PROD-<n>` **identifier** (case-insensitive),
  e.g. `"PROD-7"`. The owning project is derived from the key prefix.
- A **project** is addressed by its **key**, e.g. `"PROD"` (case-insensitive).
- A **sprint** is addressed by its opaque **id** (not a `PROD-<n>` key) — obtain
  it from `list_sprints`.
- Paginated reads take an opaque **`cursor`** in and return a **`nextCursor`**
  out (null at the tail); there is no load-everything path.

### Reads & dispatch

#### `list_ready`

Browse the ready-to-start set: a cursor-paginated page of work items in a
project whose every dependency is satisfied — the same set the project's Ready
view shows.

| Input        | Type                     | Required | Notes                                                          |
| ------------ | ------------------------ | -------- | -------------------------------------------------------------- |
| `projectKey` | string                   | yes      | Project key, e.g. `"PROD"`.                                    |
| `kinds`      | array of work-item kinds | no       | Restrict to these kinds; omit for any.                         |
| `priority`   | array of priorities      | no       | Restrict to these priorities; omit for any.                    |
| `assigneeId` | string \| null           | no       | A user id; `null` or `"unassigned"` for the unassigned bucket. |
| `cursor`     | string                   | no       | Opaque page cursor from a previous call's `nextCursor`.        |
| `limit`      | integer (1–200)          | no       | Page size; default 50.                                         |

**Output** — `structuredContent`: `{ items: ReadyItemDto[], nextCursor: string | null }`.
Each `ReadyItemDto` has `id`, `key` (the `PROD-<n>` identifier), `kind`, `title`,
`priority`, `status: { key, category }`, `assignee` (or null), and
`descriptionExcerpt`.

#### `next_ready`

Dispatch ONE item: the highest-ranked ready item not in `excludeIds`, as the
full dispatch payload an agent runs. Walk the set by appending each handled id
to `excludeIds`.

| Input        | Type                     | Required | Notes                                              |
| ------------ | ------------------------ | -------- | -------------------------------------------------- |
| `projectKey` | string                   | yes      | Project key.                                       |
| `kinds`      | array of work-item kinds | no       | Restrict to these kinds.                           |
| `priority`   | array of priorities      | no       | Restrict to these priorities.                      |
| `assigneeId` | string \| null           | no       | User id; `null`/`"unassigned"` for unassigned.     |
| `excludeIds` | array of strings         | no       | Work item ids already dispatched this loop — skip. |

**Output** — `structuredContent`: `{ item: ReadyItemDispatchDto | null }`
(`null` when nothing is ready). `ReadyItemDispatchDto` extends `ReadyItemDto`
with `descriptionMd`, `contextRefs`, `blockerKeys`, `parentKey`, and
`runCommand` (`motir run <key>`).

#### `get_work_item`

Read one work item by identifier as the full issue-detail aggregate — the same
shape the detail page reads.

| Input | Type   | Required | Notes                                  |
| ----- | ------ | -------- | -------------------------------------- |
| `key` | string | yes      | Work item identifier, e.g. `"PROD-7"`. |

**Output** — `structuredContent`: the `IssueDetailDto` aggregate: the item
(description, status, priority, assignee, …), its parent, children, dependency
links, and a readiness verdict.

### Work-item writes

#### `create_work_item`

Create a work item (story / task / bug / subtask) under a project, optionally
parented. The reporter is pinned to the token owner. Use `kind: "bug"` under a
story/epic to **log a bug** (the bug-logging protocol). Epic is deliberately not
an offered kind.

| Input           | Type                                      | Required | Notes                                                                                    |
| --------------- | ----------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `projectKey`    | string                                    | yes      | The project the item is created in, e.g. `"PROD"`.                                       |
| `kind`          | `"story" \| "task" \| "bug" \| "subtask"` | yes      | The work item kind.                                                                      |
| `title`         | string                                    | yes      | The title (one line).                                                                    |
| `parentKey`     | string                                    | no       | Parent identifier — must be a kind-legal, same-project parent.                           |
| `descriptionMd` | string                                    | no       | Markdown description body.                                                               |
| `priority`      | priority enum                             | no       | Omit for the project default.                                                            |
| `storyPoints`   | number \| null                            | no       | Story-point estimate (non-negative, ≤ 9999.99, ≤ 2 decimals). Omit/`null` → unestimated. |

**Output** — `structuredContent`: the created `WorkItemDto`.

#### `transition_status`

Move a work item to a target workflow status. The `status` argument accepts the
status **key** (e.g. `"in_progress"`) **or** its display **label** (e.g.
`"In progress"`), case-insensitive. An illegal move returns an
`ILLEGAL_TRANSITION` error enriched with the **allowed targets** from the item's
current status, so the agent can self-correct.

| Input    | Type   | Required | Notes                                    |
| -------- | ------ | -------- | ---------------------------------------- |
| `key`    | string | yes      | Work item identifier.                    |
| `status` | string | yes      | Target status — its key or display name. |

**Output** — `structuredContent`: the updated `WorkItemDto`. The text block
reports the move (`from → to`, or `already in "x" (no-op)`).

#### `add_comment`

Post a Markdown comment on a work item as the token owner. Mention parsing,
`comment_mention` rows, auto-watch, and the comment-created job event all fire
exactly as from the UI — a mention emails the mentioned member with no
MCP-specific wiring.

| Input  | Type   | Required | Notes                                                    |
| ------ | ------ | -------- | -------------------------------------------------------- |
| `key`  | string | yes      | Work item identifier.                                    |
| `body` | string | yes      | Comment body (Markdown). Mention with `@[name](userId)`. |

**Output** — `structuredContent`: the created `CommentDTO`.

#### `link_work_items`

Create a relationship between two work items — the primitive for the **dependency
edges** the plan is built on. The `relationship` is read `fromKey <relationship>
toKey` and uses the same five UI relationship kinds as the relationships panel
(`blocked_by` / `blocks` / `relates_to` / `duplicates` / `clones`); `blocks` is
the inverse direction of `blocked_by`, both stored as the single `is_blocked_by`
edge. An `is_blocked_by` link removes the blocked item from the ready set
(`list_ready` / `next_ready` honor it) and renders the inverse edge on the other
item. Targets may live in **another project in the same workspace**.

Re-creating an existing link is **idempotent** (a success no-op, not an error). A
**self** link, a dependency **cycle** (`is_blocked_by` only), or a
**cross-workspace** link returns a typed error naming the violation. The link is
an edit of the FROM item, so the same Story-6.4 edit gate as the UI applies.

| Input          | Type                                                                   | Required | Notes                                                     |
| -------------- | ---------------------------------------------------------------------- | -------- | --------------------------------------------------------- |
| `fromKey`      | string                                                                 | yes      | The first item's identifier, e.g. `"PROD-3"`.             |
| `toKey`        | string                                                                 | yes      | The second item's identifier (may be in another project). |
| `relationship` | `"blocked_by" \| "blocks" \| "relates_to" \| "duplicates" \| "clones"` | yes      | Read `fromKey <relationship> toKey`.                      |

**Output** — `structuredContent`: the created `WorkItemLinkDto` (plus the
`relationship`). For an idempotent no-op, `{ idempotent: true, relationship }`.

#### `unlink_work_items`

Remove a relationship between two work items, addressed by the same `fromKey` +
`toKey` + `relationship` used to create it. **Idempotent** — removing a link that
is already absent succeeds as a no-op. Same edit gate as the UI link path.

| Input          | Type                                                                   | Required | Notes                         |
| -------------- | ---------------------------------------------------------------------- | -------- | ----------------------------- |
| `fromKey`      | string                                                                 | yes      | The first item's identifier.  |
| `toKey`        | string                                                                 | yes      | The second item's identifier. |
| `relationship` | `"blocked_by" \| "blocks" \| "relates_to" \| "duplicates" \| "clones"` | yes      | The relationship to remove.   |

**Output** — `structuredContent`: `{ removed: boolean, relationship }` — `removed`
is `false` when no such link existed (the idempotent no-op).

#### `update_work_item`

Edit a work item's fields — the partial-patch counterpart of `create_work_item`,
which can only set kind/title/parentKey/description/priority/story-points on
create. Patch any
subset of the UI-editable fields; an omitted field is left unchanged, and an
explicit `null` clears a nullable one. The workflow **status** is NOT edited here
(use `transition_status`), and neither is `kind`/`parent` — each is a structural
move with its own tool (`change_kind` for the hierarchy kind, `move_to_parent`
for the parent). Note `type`/`executor` here are the **work type** axis
(code/design/test/…), a different thing from the hierarchy `kind`.
The leaf-only `type`/`executor` rule (setting them on an epic/story is rejected),
the type→executor seed, and the assignee-membership check all apply exactly as in
the UI; the same Story-6.4 edit gate gates the call.

| Input             | Type                                | Required | Notes                                                                                          |
| ----------------- | ----------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `key`             | string                              | yes      | Work item identifier, e.g. `"PROD-7"`.                                                         |
| `title`           | string                              | no       | New title.                                                                                     |
| `descriptionMd`   | string \| null                      | no       | New description; `null` clears it.                                                             |
| `explanationMd`   | string \| null                      | no       | New explanation ("why"); `null` clears it.                                                     |
| `priority`        | `lowest…highest`                    | no       | New priority.                                                                                  |
| `type`            | work type \| null                   | no       | Leaf items only; `null` clears it. First set seeds the executor.                               |
| `executor`        | `"coding_agent" \| "human"` \| null | no       | Leaf items only; `null` clears it.                                                             |
| `estimateMinutes` | number \| null                      | no       | Estimated minutes (time); `null` clears it.                                                    |
| `storyPoints`     | number \| null                      | no       | Story-point estimate (non-negative, ≤ 9999.99, ≤ 2 decimals); set / change / `null` clears it. |
| `assigneeId`      | string \| null                      | no       | Assignee user id (must be a workspace member); `null` unassigns.                               |
| `dueDate`         | string (ISO-8601) \| null           | no       | Due date; `null` clears it.                                                                    |

**Output** — `structuredContent`: the updated `WorkItemDto`. A non-member
assignee, a `type`/`executor` on a non-leaf, or an out-of-range `storyPoints`
value returns a typed error.

#### `change_kind`

**Reclassify** a work item: change its hierarchy **kind** between `story`,
`task`, `bug`, and `subtask`. This is the structural change `update_work_item`
leaves out (kind is "a structural move, not a field edit") and `create_work_item`
can set only at creation — so an agent that mis-typed an item can fix it
**without** the delete-and-recreate that would lose its identifier, history,
comments, and links. The sibling of `move_to_parent` (parent is the other
structural move update can't do).

This changes the hierarchy **kind**, NOT the **work type** — the `type`
(code/design/test/…) and `executor` axis stays on `update_work_item`. `epic` is
not an available target (epics are planner/seed scaffolding, excluded from the
agent surface exactly as in `create_work_item`).

The new kind must keep the kind-parent matrix legal on **both** sides: it must be
a legal child of the item's **current parent**, and must legally parent **every
existing child** — else `ILLEGAL_PARENT_TYPE`. A container kind (`story`) cannot
keep a leaf-only **work type**, so reclassifying a typed leaf into a container
without first clearing its `type` returns `TYPE_NOT_ALLOWED_ON_KIND`. Same
Story-6.4 edit gate as the UI; a missing / cross-tenant key is an
indistinguishable 404.

| Input  | Type                                      | Required | Notes                                           |
| ------ | ----------------------------------------- | -------- | ----------------------------------------------- |
| `key`  | string                                    | yes      | Work item identifier, e.g. `"PROD-7"`.          |
| `kind` | `"story" \| "task" \| "bug" \| "subtask"` | yes      | The new hierarchy kind. `epic` is not a target. |

**Output** — `structuredContent`: the reclassified `WorkItemDto` (its `kind`
updated). An illegal parent/child pairing or a type-bearing container returns a
typed error.

#### `archive_work_item`

Soft-delete (archive) a work item: it leaves the ready set (`list_ready` /
`next_ready`) and search, but is fully recoverable. Archives **only this item** —
children are left intact (the deliberate "Linear shape", not a Jira parent→subtree
cascade; a destructive subtree delete is the separate `delete_work_item`). Same
edit gate as the UI.

| Input | Type   | Required | Notes                 |
| ----- | ------ | -------- | --------------------- |
| `key` | string | yes      | Work item identifier. |

**Output** — `structuredContent`: the archived `WorkItemDto` (`archivedAt` set).

#### `unarchive_work_item`

Restore an archived work item — the inverse of `archive_work_item` (Jira
"restore"). Clears `archivedAt` so the item returns to active views and records an
`unarchived` history entry. Same edit gate as the UI.

| Input | Type   | Required | Notes                 |
| ----- | ------ | -------- | --------------------- |
| `key` | string | yes      | Work item identifier. |

**Output** — `structuredContent`: the restored `WorkItemDto` (`archivedAt` null).

#### `delete_work_item`

**PERMANENTLY** delete a work item **and its entire subtree** — the root plus
every descendant, and all their links / comments / history, are removed in one
transaction. This is **irreversible**: there is no undo, unlike
`archive_work_item`. Pick **archive** for a recoverable soft-remove that takes a
single card out of the ready set, **delete** to erase a mistaken subtree for
good. Gated on the same project-admin **manage** capability the UI's delete
requires (a member who can edit but not manage gets a typed access error); a
missing / cross-tenant key is an indistinguishable 404 not-found.

| Input | Type   | Required | Notes                 |
| ----- | ------ | -------- | --------------------- |
| `key` | string | yes      | Work item identifier. |

**Output** — `structuredContent`: the deletion summary
`{ deleted: true, id, identifier, title, totalCount, descendantCount, byKind }` —
`totalCount` is the number of rows removed (root + descendants), `descendantCount`
is `totalCount − 1`, and `byKind` is the per-kind breakdown of the descendants
(captured before the cascade). A denied or not-found key returns a typed error.

#### `move_to_parent`

**Re-parent** a work item: move it under a different parent, or promote it to a
top-level root. This is the structural move `create_work_item` (parent is
set only at create) and `update_work_item` (a field patch, not a structural
move) deliberately leave out — so an agent can re-home a card **without** the
delete-and-recreate hack that would lose its identifier, history, comments, and
links. Re-parenting is its own verb for the same reason status
(`transition_status`) and sprint membership (`move_to_sprint`) are.

Pass `parentKey` to move the item under that parent (appended to the parent's
children at a freshly-minted position), or `null` to promote it to a top-level
root. The same rules as the UI's tree/board re-parent apply: the new parent must
be a **kind-legal** parent in the **same project**, and the move may not create a
**cycle** (under itself or a descendant) or exceed the **4-level depth** limit —
each returns a typed error naming the violation. Same Story-6.4 edit gate as the
UI; a missing / cross-tenant key is an indistinguishable 404.

| Input       | Type           | Required | Notes                                                                                     |
| ----------- | -------------- | -------- | ----------------------------------------------------------------------------------------- |
| `key`       | string         | yes      | The work item to move, e.g. `"PROD-7"`.                                                   |
| `parentKey` | string \| null | yes      | The new parent's identifier, or `null` to promote to a top-level root. Same-project only. |

**Output** — `structuredContent`: the re-parented `WorkItemDto` (its `parentId`
now the new parent, or `null` at the top level).

### Search

#### `search_work_items`

Search a project's work items with a versioned **FilterAST envelope** — the same
filter grammar the `/issues` advanced filter and saved filters use (one codec,
N carriers). Omit `filter` to page the whole project. Cursor-paginated.

| Input        | Type               | Required | Notes                                                          |
| ------------ | ------------------ | -------- | -------------------------------------------------------------- |
| `projectKey` | string             | yes      | Project key, e.g. `"PROD"`.                                    |
| `filter`     | FilterAST envelope | no       | `{ version, combinator, conditions }`; omit for whole project. |
| `cursor`     | string             | no       | Opaque page cursor from a previous `nextCursor`.               |
| `limit`      | integer (1–50)     | no       | Page size; default 50 (the List's server cap).                 |

The `filter` envelope:

- `version` — must be the supported envelope version (`v1`).
- `combinator` — `"and"` (match all rows) or `"or"` (match any).
- `conditions` — an array (up to the row cap) of
  `{ field, operator, value }`:
  - `field` — a built-in (`kind`, `status`, `priority`, `type`, `assignee`,
    `reporter`, `sprint`, `text`, `created`, `updated`, `due`, `storyPoints`,
    `estimate`), a label/component (`lbl`, `cmp`), or a custom field
    (`cf:<fieldId>`).
  - `operator` — one of `is_any_of`, `is_none_of`, `is_empty`, `is_not_empty`,
    `contains`, `not_contains`, `eq`, `ne`, `lt`, `lte`, `gt`, `gte`,
    `on_or_before`, `on_or_after`, `between`, `in_last_days`, `in_next_days`
    (must be in the field's set).
  - `value` — by operator arity: a string list for `is_any_of`/`is_none_of`
    (and a `[from, to]` pair for `between`), a string for `contains`/
    `not_contains` and single dates (`YYYY-MM-DD`), a number for comparisons and
    `in_last_days`/`in_next_days`, or `null` for `is_empty`/`is_not_empty`.

A malformed/foreign-version envelope returns a clean filter-decode error
(`MALFORMED_FILTER` / `UNSUPPORTED_FILTER_VERSION` / `INVALID_FILTER`); an
unknown field/operator or a bad value arity returns the registry's
validation error.

**Output** — `structuredContent`:
`{ items: WorkItemListItemDto[], total: number, nextCursor: string | null }`.

### Sprints

The eight sprint tools cover the full Scrum cadence over the Epic-4 sprint
services. Run `list_sprints` first to get a sprint's `id`; the mutating tools
require **sprint-admin** permission (enforced in the service).

#### `list_sprints`

List a project's sprints (in sequence order), each with its `id`, `name`,
`state` (planned / active / complete), `goal`, window, and issue count. The
read every other sprint tool depends on.

| Input        | Type   | Required | Notes                           |
| ------------ | ------ | -------- | ------------------------------- |
| `projectKey` | string | yes      | The project key, e.g. `"PROD"`. |

**Output** — `structuredContent`: `{ sprints: SprintDto[] }`.

#### `create_sprint`

Create a **planned** sprint (it starts empty). Scope it with `move_to_sprint`,
then `start_sprint`.

| Input        | Type   | Required | Notes                                           |
| ------------ | ------ | -------- | ----------------------------------------------- |
| `projectKey` | string | yes      | Project key.                                    |
| `name`       | string | no       | Defaults to `"Sprint <n>"` (the next sequence). |
| `goal`       | string | no       | Sprint goal.                                    |
| `startDate`  | string | no       | Planned start (ISO-8601).                       |
| `endDate`    | string | no       | Planned end (ISO-8601); must be ≥ `startDate`.  |

**Output** — `structuredContent`: the created `SprintDto`.

#### `update_sprint`

Rename, re-goal, or re-date a sprint. A completed sprint is frozen; an active
sprint can still have its goal/window changed. Omit a field to leave it
unchanged; pass `null` to clear the goal or a date.

| Input       | Type           | Required | Notes                                                             |
| ----------- | -------------- | -------- | ----------------------------------------------------------------- |
| `sprintId`  | string         | yes      | The sprint id (from `list_sprints`).                              |
| `name`      | string         | no       | New name; omit to leave unchanged.                                |
| `goal`      | string \| null | no       | `null` clears; omit to leave unchanged.                           |
| `startDate` | string \| null | no       | ISO-8601; `null` clears; omit to leave unchanged.                 |
| `endDate`   | string \| null | no       | ISO-8601 (≥ `startDate`); `null` clears; omit to leave unchanged. |

**Output** — `structuredContent`: the updated `SprintDto`.

#### `delete_sprint`

Delete a **planned or complete** sprint. Its issues are **not** deleted — they
fall back to the backlog in their existing order. The **active** sprint cannot
be deleted; complete it instead.

| Input      | Type   | Required | Notes          |
| ---------- | ------ | -------- | -------------- |
| `sprintId` | string | yes      | The sprint id. |

**Output** — `structuredContent`: `{ sprintId: string, deleted: true }`.

#### `move_to_sprint`

Add a bulk selection of work items to a sprint in one atomic move (all or none),
appended in selection order. All items must belong to the sprint's project.

| Input      | Type             | Required | Notes                                              |
| ---------- | ---------------- | -------- | -------------------------------------------------- |
| `keys`     | array of strings | yes      | Work item identifiers, e.g. `["PROD-7","PROD-8"]`. |
| `sprintId` | string           | yes      | The target sprint id.                              |

**Output** — `structuredContent`: `{ items: WorkItemDto[] }` (the moved items).

#### `move_to_backlog`

The inverse of `move_to_sprint`: move a bulk selection out of their sprint and
back to the backlog in one atomic move. Each item keeps its backlog order; an
item already in the backlog is a no-op.

| Input  | Type             | Required | Notes                                         |
| ------ | ---------------- | -------- | --------------------------------------------- |
| `keys` | array of strings | yes      | Work item identifiers to move to the backlog. |

**Output** — `structuredContent`: `{ items: WorkItemDto[] }` (the moved items).

#### `start_sprint`

Activate a planned sprint. A project can have only one active sprint at a time;
only a planned sprint is startable. Optionally rename/re-goal and set the window
on start.

| Input       | Type           | Required | Notes                                 |
| ----------- | -------------- | -------- | ------------------------------------- |
| `sprintId`  | string         | yes      | The sprint id.                        |
| `name`      | string         | no       | Rename on start.                      |
| `goal`      | string \| null | no       | Goal edit on start; `null` clears it. |
| `startDate` | string         | no       | ISO-8601; defaults to now.            |
| `endDate`   | string         | no       | ISO-8601; must be ≥ `startDate`.      |

**Output** — `structuredContent`: the updated `SprintDto`.

#### `complete_sprint`

Close out an active sprint. Only an active sprint is completable. Done items stay
on the completed sprint as its record; unfinished items carry over. The
carry-over disposition is **required** — there is no default.

| Input         | Type                                    | Required | Notes                                                                                      |
| ------------- | --------------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `sprintId`    | string                                  | yes      | The sprint id.                                                                             |
| `carryOverTo` | `"backlog"` \| `{ "sprintId": "<id>" }` | yes      | Where unfinished items go: the backlog, or another **planned** sprint in the same project. |

**Output** — `structuredContent`: the updated `SprintDto`.

### Identity

#### `whoami`

Resolve the identity behind the presented token: the owning user (id, name,
email) and the active workspace the bearer gate resolved for this request. Takes
**no arguments**. Used by the CLI's auth commands to confirm and display the
authenticated account; it reads only the actor's own identity, so there is no
cross-user exposure.

**Input** — none.

**Output** — `structuredContent`: `{ user, workspace }` (the actor's user
profile and active-workspace summary; `workspace` may be null only in the race
where the membership was removed mid-request).

## Permission model

The MCP layer does **not** re-implement authorization. There is exactly one auth
decision point: the transport-level bearer gate (`lib/mcp/auth.ts`).

- **The bearer gate resolves the actor once per request.** `verifyMcpToken`
  re-hashes the presented PAT, looks it up, and rejects absent / malformed /
  unknown / revoked / expired tokens with a **401 before any tool dispatch**. On
  success it resolves the token owner's active/default workspace (the same
  cookie-less resolution the HTTP middleware uses) and stashes
  `{ userId, workspaceId }` on the request's `AuthInfo.extra`.
- **Every tool runs in that user's `ServiceContext`.** `contextFromExtra` lifts
  the resolved `{ userId, workspaceId }` into the `ServiceContext`
  (`lib/mcp/context.ts`) and the tool calls the **same service method** an HTTP
  route calls. So the **Story 6.4 role checks** (browse gate on reads, edit gate
  on writes, sprint-admin gate on sprint mutations) apply **unchanged** — no
  tool re-checks them.
- **Cross-tenant access returns not-found, never a leak.** A work item, project,
  or sprint that is unknown or belongs to another tenant surfaces as the **same
  "not found"** result a genuinely missing one does (the service throws the same
  `WorkItemNotFoundError` / `ProjectNotFoundError` / `SprintNotFoundError` for
  both). This is the **404-not-403 contract** — the MCP surface never returns a
  403 that would confirm a resource exists.

In short: an agent acting through a PAT can do exactly what its token's owner can
do through the web UI in that user's active workspace — no more, no less.

## Security notes

- **The plaintext token is shown once.** When you create a token, copy it
  immediately — it is never displayed again and cannot be recovered.
- **Treat it like a password.** Store it in a secret manager or your agent's
  credential store, never in committed code or shared chat.
- **Set an expiry.** Prefer a bounded lifetime (30 / 90 / 365 days) over "never";
  90 days is a reasonable default for an agent you re-provision periodically.
- **Revoke on leak — instantly.** Revoking a token from Settings → Account → API
  tokens is instant: the very next tool call with that token fails the bearer
  gate with a 401. Revocation is a soft-revoke (the row is kept for the audit
  trail, stamped `revokedAt`).
- **Tokens are stored only as a SHA-256 hash.** Motir persists the hash plus a
  short display prefix — never the plaintext. A database read cannot reveal a
  usable token.
- **The `motir_pat_` prefix is greppable on purpose.** Like GitHub's `ghp_`
  convention, the fixed prefix lets secret scanners detect a leaked Motir token
  in code or logs.
