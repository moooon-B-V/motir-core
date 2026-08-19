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

> **Just trying to wire an agent? Start with the published guide instead:
> [`/docs/mcp`](https://app.motir.co/docs/mcp)** — what the MCP is for versus
> `/api/v1`, a config block for Claude Code, Cursor, VS Code, Codex CLI and any
> other streamable-HTTP client, and one call that comes back. Its
> [tool catalogue](https://app.motir.co/docs/mcp/tools) lists every tool with the
> permission that gates it.
>
> **This document is the REFERENCE**, and it is what the guide hands you off to:
> it keeps the per-tool input tables and output shapes below, which is the part
> that changes most and is therefore kept beside the code. (ADR
> `docs/decisions/public-api-conventions.md`, Amendment 12 Q3.)

## What the Motir MCP server is

- **One endpoint, streamable HTTP.** The server is a single route —
  `app/api/mcp/route.ts` — served at `POST /api/mcp`. It speaks streamable HTTP
  only (no legacy SSE), is stateless (a fresh transport per request, no redis),
  and is never cached (`dynamic = 'force-dynamic'` — readiness and work-item
  state change constantly). It runs on the Vercel `mcp-handler` adapter, which
  bridges Next.js's Web `Request`/`Response` to the MCP SDK transport.
- **Every tool is a thin adapter over a service.** A tool resolves the
  `<KEY>-<n>` keys in its input to ids, then calls the **same service method an
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

## Creating a token

The MCP server authenticates with a **personal access token (PAT)**. Mint one
from the web UI:

**Settings → Account → Tokens → Create.**

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

## Token permissions

Every token carries a **grant** — a set of the same **permissions** the rest of
Motir enforces, in `resource:action` form, chosen when the token is minted. At
dispatch, each tool call is gated by that grant: if the permission the tool's
own service asserts is not in the grant, the call is rejected with a typed
**`PERMISSION_NOT_GRANTED`** error _before_ any work runs, naming the missing
key.

> **This replaced six coarse "scopes" (`read`, `work_items:write`, …) in
> MOTIR-2572.** Those names no longer exist and are not accepted anywhere.
> **Every token minted before the change keeps exactly the authority it had** —
> Motir expands the stored values when it reads them, and nothing was reissued
> or rewritten. The reasoning is in
> [`docs/decisions/token-permissions.md`](decisions/token-permissions.md).

**The grant NARROWS; it does not replace the role.** The token still acts as its
owner, so the same workspace/project access checks apply on every call (a
foreign or unreachable item is still a 404-not-403 not-found). A call must pass
**both** gates: the grant must hold the tool's permission **and** the owner's
role must permit the operation. A token whose owner is an admin but whose grant
omits `work_item:delete` still cannot delete; a token holding it still cannot
delete in a workspace its owner can't reach. Granting a permission the owner's
role does not have changes nothing — you can grant less than your own access,
never more.

The permissions a token can hold, and the tools each one gates, are listed on
the [tool catalogue](https://app.motir.co/docs/mcp/tools), which is **generated
from the shipped map** rather than transcribed — so it cannot go stale the day
someone adds a tool. Each tool's own entry below names its permission too.

**Default grant.** A token minted without an explicit choice gets **every
grantable permission EXCEPT `work_item:delete`**. Note that `work_item:delete`
governs **archiving as well as deleting** — that is the gate the server has
always applied to both — so a default-granted token can neither archive nor
delete, and archiving is an opt-in.

**AI planning is its own permission.** `ai:plan` gates `expand_item` and the
three plan-session tools, all of which spend the workspace's AI credits. Under
the old vocabulary they travelled with _edit work items_ because nothing
narrower existed; an agent wired only to file work items can now be denied them.

## Rate limits

`POST /api/mcp` is metered on **two** budgets, keyed on the token owner **+ the
token's workspace** — not on the token itself. Minting a second token does not
buy a second allowance; that is the point, because the expensive half of this
surface shares its counter with Motir's own UI.

| What is spent                      | On                                                                    | Default        | Env                                           |
| ---------------------------------- | --------------------------------------------------------------------- | -------------- | --------------------------------------------- |
| **Requests** (`mcp:call`)          | every request, whatever it asks for                                   | 300 per minute | `MOTIR_MCP_RATE_LIMIT` / `_WINDOW_MS`         |
| **AI generations** (`ai:generate`) | `expand_item`, `submit_plan_session` — the tools that run a model job | 10 per minute  | `MOTIR_AI_GENERATE_RATE_LIMIT` / `_WINDOW_MS` |

Reads, transitions and sprint writes only ever spend the first budget: an agent
polling `next_ready` is not metered as if it were generating a plan. The two
job-submitting tools spend **both**, and their generation budget is the same one
the "Expand" and plan buttons in the Motir UI draw from.

**How a refusal arrives**, in the two shapes:

- **Over the request budget** — HTTP **429** with `Retry-After` and the
  `X-RateLimit-Limit` / `-Remaining` / `-Reset` triple, and a JSON-RPC error body:

  ```json
  {
    "jsonrpc": "2.0",
    "id": null,
    "error": {
      "code": -32029,
      "message": "Too many requests. Retry in 27 seconds.",
      "data": {
        "code": "RATE_LIMITED",
        "retryAfterSeconds": 27,
        "limit": 300,
        "remaining": 0,
        "resetAt": 1754835600
      }
    }
  }
  ```

  An SDK client surfaces this as a transport error carrying the 429; a client
  posting JSON-RPC directly can read `error.data` and back off precisely.

- **Over the generation budget** — an ordinary tool **error result**
  (`isError: true`) whose text carries `RATE_LIMITED` and the retry seconds. The
  request itself succeeded, so it comes back as a normal `tools/call` response.

The `X-RateLimit-*` headers ride **every** response, not only the refusals, so a
client can pace itself before it hits the wall.

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
`initialize` handshake and registers **39 tools**.

**Dual-content convention.** Every successful tool result carries **both** a
human-readable `text` block (a compact summary a person watching the session can
read) **and** `structuredContent` — the JSON an agent parses. On a failure a
tool returns an `isError` result whose text is `CODE: message` (the service's
own typed error code + message), so an agent can self-correct.

**Where the shapes come from (Story 11.6).** `structuredContent` is DERIVED from
the same `zod` resource schemas `/api/v1` responds with, rather than hand-shaped
per tool — so the two surfaces cannot disagree about what a work item is, and a
CI guard fails the build if a field is added on one and forgotten on the other.
See `docs/decisions/public-api-conventions.md` Amendment 7.

**Nothing a caller SEES has moved.** The tools still declare **no**
`outputSchema`, deliberately and for new reasons: an `outputSchema` is published
in `tools/list` and validated by the SDK at request time, which would turn a
shape defect into a runtime error in front of an agent and would make every
additive change a published-contract change. The derivation is internal; the
guard is in CI.

**What is frozen and what is free.** Only the DATA SHAPE is shared and guarded —
it is the half with a second consumer. Tool **names**, `tools/list`
**descriptions**, **argument** names and **scopes** remain MCP's own and are
expected to churn: rewording a description is how an agent's behaviour gets
tuned, and nothing in the guard constrains it.

> ⚠️ **One field changed meaning**, and it is the only non-additive change in
> Story 11.6. On the work-item rows `key` used to be the NUMERIC key while
> `/api/v1` — and MCP's own `list_ready` rows — used it for the `<KEY>-<n>`
> identifier. `key` is now the **identifier everywhere**, and the numeric key
> rides beside it as **`numericKey`**, so nothing is lost. Readers of
> `identifier` are unaffected.

Shared input conventions:

- A **work item** is addressed by its `<KEY>-<n>` **identifier** (case-insensitive),
  e.g. `"ACME-7"`. The owning project is derived from the key prefix.
- A **project** is addressed by its **key**, e.g. `"ACME"` (case-insensitive) —
  the prefix chosen for that project at creation, not a reserved or
  platform-wide value. Obtain it from `list_projects`, which returns the `key`
  of every project the token can reach.
- A **sprint** is addressed by its opaque **id** (not a `<KEY>-<n>` key) — obtain
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
| `projectKey` | string                   | yes      | Project key, e.g. `"ACME"`.                                    |
| `kinds`      | array of work-item kinds | no       | Restrict to these kinds; omit for any.                         |
| `priority`   | array of priorities      | no       | Restrict to these priorities; omit for any.                    |
| `assigneeId` | string \| null           | no       | A user id; `null` or `"unassigned"` for the unassigned bucket. |
| `cursor`     | string                   | no       | Opaque page cursor from a previous call's `nextCursor`.        |
| `limit`      | integer (1–200)          | no       | Page size; default 50.                                         |

**Output** — `structuredContent`: `{ items: ReadyItemDto[], nextCursor: string | null }`.
Each `ReadyItemDto` has `id`, `key` (the `<KEY>-<n>` identifier), `kind`, `title`,
`priority`, `status: { key, category }`, `assignee` (or null), and
`descriptionExcerpt` — **plus the `dependencies` block** and the
**[`commentCount`](#the-commentcount-field)** below.

##### The `dependencies` block (list reads)

Both LIST reads — `list_ready` and `search_work_items` — attach the **same**
per-row dependency projection, so one client renderer covers both:

```jsonc
"dependencies": {
  "blockedBy": [{ "key": "ACME-3", "title": "Ship the schema", "status": "done" }],
  "blocks": [{ "key": "ACME-9", "title": "Wire the UI", "status": "todo" }]
}
```

- `blockedBy` — what gates this item; `blocks` — what this item gates.
- Each entry is `{ key, title, status }`: `key` is the `<KEY>-<n>` identifier,
  `status` the raw workflow status key.
- **Both arrays are ALWAYS present** — empty when the item has no edge in that
  direction, so a renderer never branches on presence.
- Archived items on the far end are excluded (the MOTIR-1328 rule), and a
  cross-**project** edge inside the workspace resolves normally (links may cross
  projects); a far end in another tenant never appears.
- Ordered by `key` (numeric-aware), so repeated calls render identically.
- The whole page costs **two** queries regardless of page size — never one read
  per row. For a single item's full relationship set (including `relates_to` /
  `duplicates` / `clones` and the link ids the inline remove needs), use
  `get_work_item`.

The human-readable text block carries the same graph in compact form, appended
to each row's line: `ACME-7 [task/high] Wire the dispatch — unassigned · blocked
by ACME-3 · blocks ACME-9`.

##### The `commentCount` field

**All five work-item reads** — `list_ready`, `search_work_items`, `next_ready`,
`claim_next_ready`, and `get_work_item` — attach the same number to every work
item they return:

```jsonc
"commentCount": 3
```

- **What it counts** — every comment on the item, **replies included**. It is the
  same total [`get_work_item_activity`](#get_work_item_activity) reports as
  `totalCount` / `totalComments` and the web Activity header renders, so the
  badge and the thread behind it can never disagree.
- **Always present as a number**, `0` when there is no discussion — never
  `undefined`, never omitted at zero, so a renderer never branches on presence.
- **Why it is here** — the activity read has to be CALLED to discover a card has
  nothing to say. This is the signal that makes the call worth making: fetch the
  thread for the cards that have one, skip the round-trip for the rest. On a
  dispatch read (`next_ready` / `claim_next_ready`) a non-zero count means the
  card's prose is not the whole brief — read the discussion before starting.
- **One query per page**, whatever the page size — never one read per row.
- Scoped to the caller's workspace, over ids the read has already view-gated: a
  row you cannot see never appears, so it never carries a count.
- On **`get_work_item`** it rides the **item itself**, not the child rows —
  that aggregate answers for one card; the list reads answer per row.
- It is an MCP projection, not a web DTO field: `ReadyItemDto`,
  `WorkItemListItemDto` and `IssueDetailDto` are unchanged.

##### The dispatch advisories

**Both dispatch surfaces** — `dispatch_prompt` and `claim_next_ready` — return an
`advisories` array beside their payload:

```jsonc
"advisories": [
  { "item": "ACME-7", "referenced": "ACME-5", "referencedStatus": "in_review", "severity": "likely-missing-edge" },
  { "kind": "shape", "item": "ACME-7", "severity": "likely-ordering-violation", "phrase": "once it lands", "criterionIndex": 5 },
  { "kind": "shape", "item": "ACME-7", "severity": "likely-repo-straddle", "path": "motir-ai/src/x.ts", "repo": "motir-ai", "reason": "contradiction", "criterionIndex": 2 }
]
```

Two families ride one array, discriminated by `kind`. **Narrow with
`kind === "shape"`; anything else is a `reference`** — the tag is absent on the
reference variant, deliberately, so widening the union changed no byte of the
shape three consumers already read.

A **`reference`** entry names a work item the dispatched card's **acceptance
criteria** reference while the card carries **no `blocked_by` edge to it**. An
acceptance criterion is what the card is closed against, so naming a not-done
item there is consuming it — and the graph, which is the only part a ready set
can read, does not say so.

A **`shape`** entry has no far end at all: the card's own criteria are
mis-shaped. Two severities, each with its own remedy:

| severity                    | what it found                                                                                        | remedy                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `likely-ordering-violation` | criterion `criterionIndex` carries `phrase` — state that exists only after this card's own PR merged | CUT the card at that criterion             |
| `likely-repo-straddle`      | criterion `criterionIndex` names `path`, which lives in `repo` — a repo the card does not CARRY      | SPLIT the card per repo (one repo, one PR) |

`likely-repo-straddle` carries `reason`: `"contradiction"` when the card CARRIES
repositories and the criterion's path is in none of them, or `"unpinnable"` when
it carries none and its criteria name two or more repos — the pin is then not
merely missing, there is no single value it could take. **Since MOTIR-2728 the
comparison is against the card's whole `targetRepos` SET**, so a path in ANY
repository the card carries is not a contradiction; a path in a repository it
does NOT carry still is, which is the defect this was built to find. **It knowingly fires on a boundary-contract card** (a producer
plus its mirrored consumer, two coordinated PRs, legitimately one card) and
**cannot see the bare-symbol form** of the same tell (a symbol whose repo you
happen to know), so it narrows the human check rather than replacing it.

- **Always present, `[]` when there are none** — so a client reads one shape.
- **The `likely-missing-edge` tier only.** The prose-vs-graph check also emits a
  plain `advisory` tier for a reference named anywhere ELSE in a body (an
  incident record, a superseded-by note, an out-of-scope aside). That is useful
  while browsing a card and noise in front of an agent about to branch, so the
  dispatch surfaces carry the acceptance-criteria tier alone.
  [`validate_work_item`](#validate_work_item) still reports both.
- **⚠️ NEVER a gate.** Readiness, `openBlockers`, the claim, and the selection
  order are **identical** whether the array is empty or not — an advisory changes
  what a caller is TOLD, never what it may do. Three legitimate shapes trip it: a
  boundary-contract card whose criteria name both halves of a two-PR split, a
  criterion naming a card for contrast, and a sibling that will be done before
  this item starts. Blocking any of them would teach authors to write vaguer
  acceptance criteria, which is worse than the miss it would catch.
- **What to do with one** — before branching, check that the substrate the
  referenced item provides is already on `origin/main` (`git ls-tree` /
  `git grep` for the file, symbol or test the criterion names). If it lives only
  on an open pull request, the card is blocked in fact: wire the `blocked_by`
  edge and stop, rather than rebuilding the other half or stacking onto the
  unmerged branch.
- `dispatch_prompt` **also renders them into the prompt's CONTEXT section**, so
  every agent harness inherits the instruction — no harness writes its own
  prompt. The array is the same content, handed over for the human watching.

The human-readable text block carries it in the same compact form the
`dependencies` marker uses, and renders **nothing at zero**: `ACME-7
[task/high] Wire the dispatch — unassigned · blocks ACME-9 · 3 comments`.

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
with `descriptionMd`, `contextRefs`, `blockerKeys`, `parentKey`, `runCommand`
(`motir run <key>`), `sessionBranch`, `targetRepo`, `targetRepoCloneUrl`, and
`targetRepoDefaultBranch` — plus the
[`commentCount`](#the-commentcount-field) the list reads carry. A non-zero
count on a dispatch payload is the cue to read
[`get_work_item_activity`](#get_work_item_activity) before starting.

**`targetRepo` — WHICH repo to run this in** (MOTIR-1804): the bare repo name
(`"motir-core"`) the CLI maps to a checkout via `.motir.json` (`motir link add
<repo> <path>`), so an item targeting repo B dispatches with the agent's cwd
inside B's checkout even when invoked from repo A. **Resolved**, unlike the raw
pin on `WorkItemDto`: the item's explicit `targetRepo` when it has one, else the
**single** repo of the item's project when it has exactly one, else `null`.
`null` means Motir cannot say — with two or more repos and no pin it never
guesses; the CLI falls back to its link-root rule.

The domain is the **project's repository set** (`project_repository`,
MOTIR-1780 · MOTIR-1783). A project that has **no** set — every project created
before that table — still resolves against the **workspace's connected repos**,
unchanged; that fallback answers only for a missing set, never underneath one
that exists (a project whose repositories are all still planned resolves to
`null`, not to a workspace repo it did not choose). See
`docs/decisions/target-repo-attribution.md` and
`docs/decisions/project-repository-set.md`.

**`targetRepoCloneUrl` / `targetRepoDefaultBranch` — HOW to obtain it**
(MOTIR-1783): `targetRepo` is a bare NAME, which answers an agent that already
has the checkout; these two answer one that does not. The HTTPS clone URL
(`"https://github.com/moooon/motir-core.git"`, derived from the connected repo's
coordinates) and the branch a fresh clone lands on (`"main"`).

Both are **nullable and always present** — a null value, never an omitted key,
never `""`. They are `null` whenever Motir cannot know them: no repo resolved at
all; the pin names a repository that does not exist **yet** (a set row still
being planned — `targetRepo` is still served, because the routing decision
stands) or is no longer connected; or the repo's provider is one this build
cannot address. `targetRepoDefaultBranch` is deliberately **not** defaulted to
`"main"`: a guessed branch is the same class of error as a guessed repo, and a
consumer can only fall back sensibly if it can tell the two apart.

#### `claim_next_ready`

ATOMICALLY **claim** the next ready Subtask for dispatch and return the same
dispatch payload as `next_ready`. Unlike `next_ready` (which only READS), this is
the race-safe write that two concurrent `motir run` sessions use: in one
transaction it locks the highest-ranked ready item (`SELECT … FOR UPDATE SKIP
LOCKED`), transitions it to **In Progress**, and returns it. Two concurrent
callers therefore never claim the same item — the loser takes the next-best, or
gets an empty result and **retries**. The claim **IS** the dispatch status flip,
so do NOT call `transition_status` afterwards.

**Scope** — resolved server-side: when the project has an **active sprint**, the
claim is scoped to it (dispatch only committed work); when there is **no active
sprint** — Motir used without sprint planning (plain Kanban) — the claim widens
to the whole project. A missing sprint is therefore never an error, and no sprint
id is passed.

| Input        | Type   | Required | Notes        |
| ------------ | ------ | -------- | ------------ |
| `projectKey` | string | yes      | Project key. |

**Output** — `structuredContent`:
`{ item: ReadyItemDispatchDto | null, advisories: [...], reason? }`.
On a claim, `item` is the same `ReadyItemDispatchDto` as `next_ready` (with
`status` now in the `in_progress` category) — including `targetRepo` and its
`targetRepoCloneUrl` / `targetRepoDefaultBranch` coordinates and its
[`commentCount`](#the-commentcount-field), resolved
identically (see `next_ready` above for the project-scoped rule and the null
semantics). When nothing could be claimed,
`item` is `null` and `reason` is `"none_ready"` (retry — a sibling may have just
claimed the last one — or check there is unblocked work to start). Requires
`work_item:edit` (it flips status).

**`advisories`** — see [the dispatch advisories](#the-dispatch-advisories).
Always present, `[]` when there are none, on BOTH arms.

#### `dispatch_prompt`

Return the **canonical, server-generated coding-agent prompt** for one work item.
This is the prompt a BYOK CLI prints and hands to the agent verbatim — **the
client never assembles its own prompt grammar**, so every agent harness (Claude
Code / Codex / opencode / …) receives the identical instruction and the grammar
versions with the product.

A pure **read**: it does NOT claim the item and does NOT change its status
(`claim_next_ready` is the tool that does both), and it works on ANY work item,
not only a ready one — so re-printing an in-progress item's prompt is safe.

| Input           | Type   | Required | Notes                                                                                                              |
| --------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `key`           | string | yes      | Work item identifier, e.g. `"ACME-7"`.                                                                             |
| `sessionBranch` | string | no       | Branch to FALL BACK to when the item carries no lineage of its own — the unattended-run seed (see `workflowMode`). |

**Output** — `structuredContent`:
`{ key, prompt, targetRepo, targetRepoCloneUrl, targetRepoDefaultBranch, workflowMode, sessionBranch, advisories }`.

- **`advisories`** — see [the dispatch advisories](#the-dispatch-advisories).
  Always present, `[]` when there are none. The same content the `prompt` already
  renders in its CONTEXT section, handed over separately so a client can warn the
  HUMAN before the agent starts.
- **`prompt`** — the full text, in four sections: **CONTEXT** (project, item,
  sizing, repo, parent, satisfied dependencies, the context refs and the card
  body), **WHAT TO DO**, **ACCEPTANCE CRITERIA**, **GIT WORKFLOW**. The card's
  `## Acceptance criteria` and `## Context refs` sections are lifted into their
  own sections rather than repeated inside the body.
- **`targetRepo`** — the same RESOLVED repo `next_ready` returns, through the
  same project-scoped resolution (see `next_ready` above and
  `docs/decisions/target-repo-attribution.md`), so the two dispatch surfaces can
  never route differently.
- **`targetRepoCloneUrl`** / **`targetRepoDefaultBranch`** — the same clone
  coordinates `next_ready` returns, with the same null semantics (present with a
  null value whenever Motir cannot say).
- **`workflowMode`** — `"per_item_pr"` (branch from `origin/main`, one PR, stop)
  or `"session_lineage"` (branch from / integrate into the inherited session
  branch, then call `mark_integrated`). **Chosen server-side** from the item's
  inherited lineage. The `sessionBranch` INPUT is a fallback, never an override:
  an item whose dependencies are already integrated — or that is itself
  integrated — keeps that branch, so a caller can never redirect a live lineage
  onto a second branch. What the seed does enable is the FIRST item of an
  unattended `motir auto` run, which by definition has no integrated dependency
  yet and would otherwise be told to open a pull request of its own. A manual
  item ignores the seed entirely. The branch name must be a plain git ref
  (`[A-Za-z0-9][A-Za-z0-9._-/]*`); it is interpolated into prompt text that
  instructs an agent to run `git … origin/<branch>`.
- **`sessionBranch`** (output) — the branch the prompt instructs, or `null`.

**Variants, all decided server-side.** WHAT TO DO varies by the item's `type`
(`code` / `design` / `test` / `decision` / …). A **manual** item (`type: manual`
or `executor: human`) gets the human-instruction form and **no GIT WORKFLOW
section at all** — it has no branch and no PR — and reports `per_item_pr` with a
null branch.

The prompt is a **pure function of server state**: two calls for an unchanged item
return byte-identical text (no LLM, no timestamps). See
`docs/decisions/dispatch-prompt-assembly.md` for the grammar's rationale and the
single named extension point enrichment lands on. Requires `project:browse`.

#### `get_work_item`

Read one work item by identifier as the full issue-detail aggregate — the same
shape the detail page reads.

| Input           | Type   | Required | Notes                                                                                                              |
| --------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `key`           | string | yes      | Work item identifier, e.g. `"ACME-7"`.                                                                             |
| `sessionBranch` | string | no       | Branch to FALL BACK to when the item carries no lineage of its own — the unattended-run seed (see `workflowMode`). |

**Output** — `structuredContent`: the `IssueDetailDto` aggregate: the item
(description, status, priority, assignee, …), its parent, children, dependency
links, and a readiness verdict. The **item** additionally carries
[`commentCount`](#the-commentcount-field) — how much discussion this card has,
so the [`get_work_item_activity`](#get_work_item_activity) round-trip is only
paid when there is something to read. The child rows do **not** carry it: this
aggregate answers for one card, and the list reads answer per row.

Each **CHILD** row additionally carries the same
[`dependencies` block](#the-dependencies-block-list-reads) the list reads attach
— identical shape, identical guarantees — so the children's build ORDER is
derivable from this one call. Since MOTIR-2228 the child rows are the SHARED
schema's output (v1's `WorkItemChild`) widened with the fields the aggregate has
always carried, so a child row's `key` is now its `<KEY>-<n>` identifier and the
numeric key rides as `numericKey`:

```jsonc
"children": [
  {
    "identifier": "ACME-8", "kind": "subtask", "title": "Ship the schema", "status": "todo",
    "dependencies": { "blockedBy": [], "blocks": [{ "key": "ACME-9", "title": "Wire the UI", "status": "todo" }] }
  }
]
```

It costs **two** queries regardless of child count (the same batched reader), and
it is the sibling sub-graph — the item's OWN edges are the richer top-level
`blockedBy` / `blocks` / `relatesTo` groups, which also carry link ids. `motir
show` folds it into the build-order WAVE column; `show --json` adds a computed
`wave` per child (`null` for a member of a dependency cycle).

#### `get_work_item_activity`

Read one page of a work item's **discussion and change trail** — the comments
`add_comment` writes, and the history the Activity section shows. Deliberately a
SEPARATE call from `get_work_item`: that aggregate is a single round-trip and
stays one, so a card with 200 comments never slows an ordinary read.

| Input    | Type                                   | Required | Notes                                                                                 |
| -------- | -------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `key`    | string                                 | yes      | Work item identifier, e.g. `"ACME-7"`.                                                |
| `view`   | `"all"` \| `"comments"` \| `"history"` | no       | Which stream to read. Default `"all"`.                                                |
| `cursor` | string                                 | no       | Opaque continuation token from a previous call's `nextCursor`. Echo it back verbatim. |
| `order`  | `"asc"` \| `"desc"`                    | no       | Page-walk direction. Omit for each view's shipped default (below).                    |

**Output** — `structuredContent` is the page DTO of the selected view, exactly
as the app's own Activity routes return it (no MCP-specific reshaping):

| `view`     | Default `order` | Payload                  | Shape                                                                                                                         |
| ---------- | --------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `all`      | `desc`          | `ActivityAllPageDto`     | `{ entries: ({type:'comment', thread} \| {type:'history', entry})[], nextCursor, totalComments, totalChanges, workItemRefs }` |
| `comments` | `asc`           | `CommentsPageDTO`        | `{ threads: CommentThreadDTO[], totalCount, nextCursor, order, workItemRefs }`                                                |
| `history`  | `desc`          | `ActivityHistoryPageDto` | `{ entries: ActivityEntryDto[], nextCursor, totalCount }`                                                                     |

A `CommentThreadDTO` is a root comment (`id`, `author`, `bodyMd`, `createdAt`,
`editedAt`, `mentionedUserIds`) carrying its single-level `replies`. An
`ActivityEntryDto` is one displayable revision — `changeKind`, `changedAt`,
`actor`, and typed `parts` (`field` / `fieldEdited` / `link` / `collection` /
`commentDeleted` / `created` / `generic`); a body-field edit records only THAT
the field changed, never its text.

Three things to know when paging:

- **A short page with a non-null `nextCursor` is normal**, not an error — both
  `all` and `history` walk a bounded scan that can stop early inside a stretch
  of suppressed noise. Keep calling until `nextCursor` is `null`; the text block
  says `MORE REMAINS` for exactly this reason.
- **The `all` cursor is an opaque composite** carrying both sources' positions.
  Echo it back unchanged — never construct, parse or merge one. A malformed one
  returns `INVALID_ACTIVITY_CURSOR`.
- **Nothing is truncated.** Comment bodies come back in full in both the
  structured payload and the text block (the MOTIR-1709 rule). An item with no
  comments and no displayable revisions returns a well-formed EMPTY page —
  empty entries, zero totals, `nextCursor: null` — so "nothing was said" is
  distinguishable from "could not look".

Read-scoped, and access-gated exactly like the UI: an item in another workspace
(or one the token's role cannot browse) is an indistinguishable not-found.

### Work-item writes

#### `create_work_item`

Create a work item (epic / story / task / bug / subtask) under a project,
optionally parented. The reporter is pinned to the token owner. Use
`kind: "epic"` with no `parentKey` to create a **top-level capability area**;
`kind: "bug"` under a story/epic to **log a bug** (the bug-logging protocol). An
epic is **root-only** — the kind-parent matrix admits no parent for it, so
passing a `parentKey` alongside `kind: "epic"` is rejected with
`ILLEGAL_PARENT_TYPE` (MOTIR-1345 — the AI planner generates the whole tree,
epics included, so the agent surface can create one).

| Input                | Type                                                | Required | Notes                                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectKey`         | string                                              | yes      | The project the item is created in, e.g. `"ACME"`.                                                                                                                                                                                                                  |
| `kind`               | `"epic" \| "story" \| "task" \| "bug" \| "subtask"` | yes      | The work item kind. `epic` is root-only (reject if `parentKey` is given).                                                                                                                                                                                           |
| `title`              | string                                              | yes      | The title (one line).                                                                                                                                                                                                                                               |
| `parentKey`          | string                                              | no       | Parent identifier — must be a kind-legal, same-project parent.                                                                                                                                                                                                      |
| `descriptionMd`      | string                                              | no       | Markdown description body.                                                                                                                                                                                                                                          |
| `priority`           | priority enum                                       | no       | Omit for the project default.                                                                                                                                                                                                                                       |
| `storyPoints`        | number \| null                                      | no       | Story-point estimate (non-negative, ≤ 9999.99, ≤ 2 decimals). Omit/`null` → unestimated.                                                                                                                                                                            |
| `estimateMinutes`    | number \| null                                      | no       | Time estimate in minutes (non-negative integer). Omit/`null` → unestimated.                                                                                                                                                                                         |
| `type`               | type enum \| null                                   | no       | Work type (code / design / test / …) — leaf kinds only; rejected on a story. Seeds the executor from the type default unless `executor` is also given. Omit/`null` → untyped.                                                                                       |
| `executor`           | `"coding_agent" \| "human"` \| null                 | no       | Who executes the work — leaf kinds only; overrides the type default. Omit/`null` → the type default (or unset).                                                                                                                                                     |
| `targetRepo`         | string \| null                                      | no       | WHICH repo the item ships in — bare repo name (`"motir-core"`) or `"owner/name"`. Must name a repo in **this project's** repository set (else `UNKNOWN_TARGET_REPO`). Omit/`null` → unpinned.                                                                       |
| `targetRepos`        | string[]                                            | no       | EVERY repo the item ships in, ORDERED — element 0 is the PRIMARY dispatch routes to. Same validation per element. MUTUALLY EXCLUSIVE with `targetRepo` (else `CONFLICTING_TARGET_REPO_INPUT`). Omit → the set comes from `targetRepo`; `[]` → the empty set.        |
| `targetRepositories` | string[]                                            | no       | The same set as REFERENCES — the project's repository ROW IDS, ORDERED, element 0 the primary. Survives a rename, and can name one of two rows sharing a role. MUTUALLY EXCLUSIVE with BOTH fields above; an id outside this project is `UNKNOWN_PROJECT_REPO_REF`. |
| `plannedWithHarness` | string                                              | no       | Self-reported planning **harness** (e.g. `"Claude Code"`, `"Codex"`). Recorded as planning provenance alongside the server-set source `mcp`. Omit → unrecorded.                                                                                                     |
| `plannedWithModel`   | string                                              | no       | Self-reported planning **model** (e.g. `"claude-opus-4-8"`, `"deepseek-chat"`). Recorded as planning provenance. Omit → unrecorded.                                                                                                                                 |

**Output** — `structuredContent`: the created `WorkItemDto`.

Every item created through this tool is stamped with planning provenance
`source = mcp` (server-set — a caller cannot claim `manual`/`native`); the
optional `plannedWithHarness` / `plannedWithModel` record the agent's
self-reported harness + LLM (recorded as-is, no verification implied). See
`docs/decisions/work-item-provenance.md`.

The leaf-authoring fields (`estimateMinutes`, `type`, `executor`, `storyPoints`,
`targetRepo`) mirror `update_work_item`, so a subtask can be created
fully-specified in a single call rather than a create-then-update round-trip. The
same service rules apply as on the patch path: `type`/`executor` are leaf-only
(an epic/story kind is rejected), setting `type` without an explicit `executor`
seeds it from the type default, and `targetRepo` is validated against this
project's repository set.

**`targetRepo` — pinning the repo an item ships in** (MOTIR-1804). This is what
makes _one subtask = one repo = one PR_ enforceable in the product rather than
only in the planner's rules, and it is what routes the CLI: `motir link add
<repo> <path>` maps a repo NAME to a checkout, and this field says which name the
item belongs to. Accepts the bare name or `"owner/name"` (normalized to the
name), matched case-insensitively against **this project's repository set** and
stored with that repo's own casing. An unknown name is rejected with
`UNKNOWN_TARGET_REPO`, whose message lists the names the project accepts.

**`targetRepos` — a card that ships in MORE THAN ONE repo** (MOTIR-2725 ·
MOTIR-2728). A work item carries an ORDERED SET of repositories, and
`targetRepo` is that set's FIRST element — the PRIMARY, the one dispatch routes
the CLI to. The two are not two facts, so **exactly one of them may be sent**: a
write carrying both is rejected with `CONFLICTING_TARGET_REPO_INPUT` rather than
resolved by a precedence rule that would drop a repository you believed you had
recorded. Send `targetRepo` (or `targetRepos: ["x"]`) for a card that ships in
one; send `targetRepos` for one that ships in several; send `targetRepos: []` to
clear the set.

Every element is validated against the same project-scoped domain a single pin
is validated against. Duplicates collapse (the first spelling wins, compared on
the matched name, so `motir-core`, `MOTIR-CORE` and `moooon/motir-core` are one
element), blank elements are dropped, and ONE unknown element rejects the whole
write — validation is all-or-nothing, because a partially-accepted set would
store a repository list you never wrote.

**`targetRepositories` — the same set, as REFERENCES** (MOTIR-2732 · MOTIR-3039).
A repository is a THING in a Motir project — a row with an id, a role, a label and
an establish state — and this field names those ROWS rather than their names. The
names you read back on `targetRepo` / `targetRepos` are what these references
RESOLVE to, which is the whole point: **rename the repository and a card keeps
pointing at it**, where a stored name would silently stop matching.

Prefer it whenever you have the ids. Two things a name cannot do: survive a
rename, and distinguish two rows that share a role (a project with two `api`
repositories). Its rules are the name field's, on an id — ORDERED with element 0
the primary, duplicates collapse keeping the first, `[]` is the empty set, and ONE
id outside THIS item's project rejects the whole write with
`UNKNOWN_PROJECT_REPO_REF`, whose message lists the project's rows as
`id (name)` so you can self-correct in one hop.

**All three fields are ONE field in three forms, so send exactly one.** Two of
them together is `CONFLICTING_TARGET_REPO_INPUT`, never a precedence rule.

A project that has **no repository set** has no rows to reference, so its cards
keep using the name fields — unchanged, and the reason both forms exist.

**What the set changes downstream, and what it does not.** It does not change
dispatch: `next_ready` / `claim_next_ready` / `dispatch_prompt` still resolve
exactly ONE repository — the primary — with its clone URL and default branch, so
an agent is still sent into one checkout. What it changes is COMPLETION: an item
carrying repositories does not reach Done until EVERY one of them has a pull
request merged onto that repository's own default branch. A merge that leaves any
of them outstanding holds the item at **In Review** and posts a note naming which.

**ONE SUBTASK = ONE REPO = ONE PR is untouched.** A subtask is one worktree, one
branch, one PR; that is physical. The set exists for the containers above it — a
story or a task whose children land in different checkouts — and for the
boundary-contract card that legitimately ships two coordinated PRs.

The validation domain is every row of the project's set — including rows whose
repository has not been **created yet** (MOTIR-1783). A plan pins repositories
before it creates them, so a pin at `proposed` is ordinary; what validation
catches is the typo and the **sibling project's** repo, which workspace-wide
validation used to accept. A project with no set of its own still validates
against the workspace's connected repos, unchanged. See
`docs/decisions/target-repo-attribution.md` and
`docs/decisions/project-repository-set.md`.

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

#### `attach_file`

Put a **file on a work item** — so a reader sees the deliverable on the card
instead of hunting for a pull request. Use it for a deliverable that has no home
of its own: a `research` card's findings document, a `review`'s notes, a
`verification`'s evidence.

The **repository stays the source of truth** for anything that also lives in one.
The attachment is the card's view of that file, never a second home for it.

⚠️ **Not for a design asset.** A design result has its own publisher and its own
panel on the work item, and `text/html` is refused here — the three layers that
make HTML safe to serve belong to that lifecycle. The rule, in the form a prompt
author can act on: _a deliverable a LIFECYCLE owns goes through that lifecycle's
publisher; everything else goes through this tool. If you are unsure, the test is
whether a dedicated panel exists for it._ (`docs/decisions/attachment-api-door.md` §3.)

Bytes arrive base64-encoded because MCP carries JSON, not multipart — the
transport's constraint, not a second upload path. A payload that is not valid
base64 is refused rather than salvaged: `Buffer.from(s, 'base64')` discards
characters outside the alphabet instead of failing, so an unchecked decode would
attach garbage that only fails when a human opens it.

| Input           | Type   | Required | Notes                                                              |
| --------------- | ------ | -------- | ------------------------------------------------------------------ |
| `key`           | string | yes      | Work item identifier, e.g. `"ACME-7"`.                             |
| `filename`      | string | yes      | The name a reader sees, e.g. `"findings.md"`.                      |
| `contentType`   | string | yes      | Media type. Must be on the upload allowlist; `text/html` is a 415. |
| `contentBase64` | string | yes      | The file's bytes, base64-encoded.                                  |

**Output** — `structuredContent`: the created attachment — `id`, `workItemKey`,
`filename`, `mimeType`, `sizeBytes`, `source`, `contentPath`, `uploader`,
`createdAt`. `source` is `api` for anything through this tool or the equivalent
`/api/v1` route: it records the DOOR, not the actor, because Motir cannot
distinguish an agent from a person holding a token. The row appears in the work
item's ordinary attachments panel, attributed to the token owner — the same
component, with no special treatment.

**Refusals** — every one comes from the shipped attachment service, so this tool
and the browser upload answer one rule with one status: a file over the
organization's per-file limit, a media type off the allowlist, an exhausted
per-user upload budget, the organization's total storage cap, and a work item the
token cannot reach (indistinguishable from one that does not exist). The size and
type limits are defined once, in `lib/blob/allowlist.ts` and the plan
entitlements — this page deliberately quotes no number that would drift.

**Permission** — `work_item:edit`. Attaching a file to a card is editing that
card, and this is a permission the token `motir auth login` mints **does** carry,
so a dispatched run can call it. (Worth checking for any tool you write: a
permission outside that grant produces a tool that works perfectly for an
interactive operator and not at all for the agent it was built for.)

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
| `fromKey`      | string                                                                 | yes      | The first item's identifier, e.g. `"ACME-3"`.             |
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

| Input                | Type                                | Required | Notes                                                                                                                                 |
| -------------------- | ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `key`                | string                              | yes      | Work item identifier, e.g. `"ACME-7"`.                                                                                                |
| `title`              | string                              | no       | New title.                                                                                                                            |
| `descriptionMd`      | string \| null                      | no       | New description; `null` clears it.                                                                                                    |
| `explanationMd`      | string \| null                      | no       | New explanation ("why"); `null` clears it.                                                                                            |
| `priority`           | `lowest…highest`                    | no       | New priority.                                                                                                                         |
| `type`               | work type \| null                   | no       | Leaf items only; `null` clears it. First set seeds the executor.                                                                      |
| `executor`           | `"coding_agent" \| "human"` \| null | no       | Leaf items only; `null` clears it.                                                                                                    |
| `estimateMinutes`    | number \| null                      | no       | Estimated minutes (time); `null` clears it.                                                                                           |
| `storyPoints`        | number \| null                      | no       | Story-point estimate (non-negative, ≤ 9999.99, ≤ 2 decimals); set / change / `null` clears it.                                        |
| `targetRepo`         | string \| null                      | no       | Repo the item ships in — bare name or `"owner/name"`; must be in this project's repo set. `null` clears.                              |
| `targetRepos`        | string[]                            | no       | Replace the repo SET wholesale, ORDERED, element 0 the primary; `[]` clears it. Mutually exclusive with `targetRepo`.                 |
| `targetRepositories` | string[]                            | no       | Replace the set as REFERENCES — the project's repository row ids, ORDERED; `[]` clears it. Mutually exclusive with BOTH fields above. |
| `assigneeId`         | string \| null                      | no       | Assignee user id (must be a workspace member); `null` unassigns.                                                                      |
| `dueDate`            | string (ISO-8601) \| null           | no       | Due date; `null` clears it.                                                                                                           |

**Output** — `structuredContent`: the updated `WorkItemDto`. A non-member
assignee, a `type`/`executor` on a non-leaf, an out-of-range `storyPoints` value,
a `targetRepo` (or any `targetRepos` element) outside this project's repository
set (`UNKNOWN_TARGET_REPO`), a `targetRepositories` element that is not one of this
project's repository rows (`UNKNOWN_PROJECT_REPO_REF`), or more than one of the
three repo fields at once (`CONFLICTING_TARGET_REPO_INPUT`) returns a typed
error.

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
| `key`  | string                                    | yes      | Work item identifier, e.g. `"ACME-7"`.          |
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
| `key`       | string         | yes      | The work item to move, e.g. `"ACME-7"`.                                                   |
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
| `projectKey` | string             | yes      | Project key, e.g. `"ACME"`.                                    |
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
Each row also carries the same [`dependencies` block](#the-dependencies-block-list-reads)
and [`commentCount`](#the-commentcount-field) `list_ready` returns — identical
shapes, so one renderer covers both lists.

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
| `projectKey` | string | yes      | The project key, e.g. `"ACME"`. |

**Output** — `structuredContent`: `{ sprints: SprintDto[] }`.

#### `validate_sprint`

Check whether a sprint is **finishable**: a sprint is VALID ⟺ every in-sprint,
not-done item has its ENTIRE transitive `blocked_by` closure AND all of its
children either `done` or also in the sprint (the parent-ready cascade applied to
the sprint — a child inherits its ancestors' blockers, and a parent needs its
children). Productizes the _re-validate-the-active-sprint_ rule a planning agent
runs after any plan/re-plan that touches sprint membership or a sprint item's
`blocked_by` edges. Read-only.

| Input        | Type             | Required | Notes                                                                                                                                            |
| ------------ | ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `projectKey` | string           | yes      | The project key, e.g. `"ACME"`.                                                                                                                  |
| `sprintId`   | string           | no       | The sprint to validate; omit to validate the **active** sprint.                                                                                  |
| `condition`  | `loose`\|`tight` | no       | Default `loose` — a `done` gating item outside the sprint counts as satisfied. `tight` requires it to be IN the sprint, else it gates. (7.8.22.) |

**Output** — `structuredContent`: a `SprintValidityDto` —
`{ sprintId, valid, blockers }`. When `valid` is `false`, `blockers` lists each
gated in-sprint item as `{ item, blockedBy, blockerStatus, blockerSprintId }`
(the out-of-sprint, not-done work to pull in or move the gated item off). A
missing active sprint (with no `sprintId`) returns a `NO_ACTIVE_SPRINT` tool
error; an unknown `sprintId` returns `SPRINT_NOT_FOUND`.

#### `validate_work_item`

The single-item analogue of `validate_sprint`: is a work item **finishable**?
Let `S` = the target + all its descendants (its **subtree**). The item is VALID
⟺ every not-`done` item in `S` has each `blocked_by` dependency either inside `S`
(its own work) or `done`. A blocker INSIDE the subtree never gates (it is the
target's own work); only out-of-subtree work can. The target may be any non-leaf
kind — epic / story / task / bug (a `subtask` is the leaf). Read-only.

| Input       | Type             | Required | Notes                                                                                                                                                 |
| ----------- | ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`       | string           | yes      | The work item identifier, e.g. `"ACME-7"` (case-insensitive).                                                                                         |
| `condition` | `loose`\|`tight` | no       | Default `loose` — a `done` dependency outside the subtree counts as satisfied. `tight` requires every dependency to be IN the subtree, else it gates. |

**Output** — `structuredContent`: a `WorkItemValidityDto` —
`{ key, valid, blockers, advisories }`. When `valid` is `false`, `blockers` lists
each gated in-subtree item as `{ item, blockedBy, blockerStatus, blockerSprintId }`
(the out-of-subtree, unsatisfied work gating it). An unknown / cross-workspace key
returns a `WORK_ITEM_NOT_FOUND` tool error.

`advisories` is the **prose-vs-graph** channel (MOTIR-1969) and is **never a
blocker**. It carries the same two families the dispatch surfaces return (see
[the dispatch advisories](#the-dispatch-advisories) for the full shape), except
that this surface reports **both reference tiers** rather than the
acceptance-criteria one alone.

A `reference` entry is `{ item, referenced, referencedStatus, severity }`, where
`item` is the card whose body names `referenced`, and `severity` is:

| severity              | trigger                                                       |
| --------------------- | ------------------------------------------------------------- |
| `advisory`            | the not-`done` item is named anywhere in the body             |
| `likely-missing-edge` | it is named inside the card's own acceptance-criteria section |

A `shape` entry (`kind: "shape"`) reports a defect in the card's OWN criteria,
with no second work item involved: `likely-ordering-violation` (a criterion that
turns on the card's own merge — cut there) or `likely-repo-straddle` (a criterion
naming a path outside the card's `targetRepo` — split per repo).

`valid`, `blockers`, and an item's readiness are **identical** whether or not
advisories are emitted, at EVERY severity — a card legitimately names cards it
does not depend on (out-of-scope sections, context refs, contrast references, a
boundary-contract card naming both halves of a two-PR split), so this reports the
gap without enforcing it. Wire a `blocked_by` edge if the card really consumes
the reference; ignore the advisory if the reference is context only. A `done`
reference, a self-reference, an ancestor, and anything already in the
`blocked_by` set never produce one. **Blind spots:** the reference check reads
`descriptionMd` only, so a `type: decision` card's deferrals — which live in the
document it produces, not in its card body — are outside its reach; and
`likely-repo-straddle` sees only repo-QUALIFIED paths, never a bare symbol whose
repo a reader happens to know.

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
| `keys`     | array of strings | yes      | Work item identifiers, e.g. `["ACME-7","ACME-8"]`. |
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

### AI planning

#### `expand_item`

Submit an **AI expansion** of one container work item — the planner drafts the
children it should have. This is the MCP surface for the same capability the
"Expand" action in Motir fires; an unattended CLI run uses it to grow its own
backlog when the ready set drains.

| Input | Type   | Required | Notes                                                                                |
| ----- | ------ | -------- | ------------------------------------------------------------------------------------ |
| `key` | string | yes      | The container's identifier, e.g. `"ACME-7"`. Epic / story / task / bug — not a leaf. |

**Output** — `structuredContent`: `{ jobId, planId }`.

**It submits and returns.** The call resolves the moment motir-ai accepts the
job — it never streams and never polls. The browser surfaces stream because a
human is watching a comet fill in; a headless caller has nobody to show it to,
and an agent blocked on an LLM run is an agent not working. Use
`get_plan_status` to find out what became of it.

> **⚠️ This does NOT create work items.** The job produces a **`Plan` of
> proposals**. `approvePlan` — a human decision made in Motir, not on this
> surface — is the only path from a proposal to a work item, and an `add`
> proposal's `workItemId` stays `null` until then. Firing this tool, and polling
> it all the way to `planned`, both leave the tree byte-for-byte unchanged. Do
> not report proposed children as created.

Errors: a leaf target (or one outside the caller's project) returns
`INVALID_TARGET` / `NOT_FOUND`; a refused job returns the motir-ai code verbatim
— `MOTIR_AI_OUT_OF_CREDITS` (buy credits; do not retry) or
`MOTIR_AI_UNAVAILABLE` (retryable). The job runs on the **token owner's** AI
credits, and draws the shared **`ai:generate`** budget (see
[Rate limits](#rate-limits)) — the same one the "Expand" button in Motir spends,
so a loop here cannot be paid for out of a looser allowance. Over budget returns
a `RATE_LIMITED` tool error _before_ the job is submitted; retry after the
seconds it names. Requires `ai:plan` — the permission that exists precisely so a
token allowed to file work items can still be denied a billable planning submit.

Two different limits, and they compose: `ai:plan` decides whether this token may
submit at all, `ai:generate` decides how much the workspace has left to spend.

#### `get_plan_status`

Read what became of a submitted planning job. The come-back-later half of
`expand_item`, for a client with no stream to hold open.

| Input    | Type   | Required | Notes                                                      |
| -------- | ------ | -------- | ---------------------------------------------------------- |
| `planId` | string | one of   | The plan id the submit returned. Pass this **or** `jobId`. |
| `jobId`  | string | one of   | The job id the submit returned. Pass this **or** `planId`. |

Exactly one of the two — both come out of the same `expand_item` result, and
passing both (or neither) returns `BAD_REQUEST`.

**Output** — `structuredContent`:
`{ planId, projectId, status, origin, jobId, itemCount, createdAt, plannedAt, decidedAt, job }`.

- **`status`** — the plan's own status: `generating` · `planned` · `approved` ·
  `declined`.
- **`itemCount`** — how many **proposals** the plan bundles. **Not** a count of
  created work items; see the gate note above.
- **`job`** — the motir-ai job's state, present **only while `status` is
  `generating`** (a settled plan's job already delivered, so it is never probed):
  `{ status, reachable, failure }`. This block exists because **a failed job
  writes no terminal plan state of its own** — so the plan status alone would
  strand a poller. An abandoned plan is settled to `declined` by a background
  reconciler within the hour (MOTIR-3064), but only eventually and only when it
  holds no proposals; this block is how a client polling a live submit learns
  its run died _now_.
  `reachable: false` means motir-ai itself could not be asked and `failure`
  describes _that_ outage, not a job failure; the plan read still answers.

A pure read. Errors: an unknown / other-tenant plan id returns `PLAN_NOT_FOUND`
and an unknown job id `NO_PLAN_FOR_JOB` — the same 404-not-403 contract every
other tool keeps. Requires `project:browse`.

#### `get_plan`

Read a plan **with the proposals it bundles** — what the planning pass actually
proposed, not just how many items it produced.

| Input    | Type   | Required | Notes                                                                    |
| -------- | ------ | -------- | ------------------------------------------------------------------------ |
| `planId` | string | yes      | The plan id — from an `expand_item` submit, `get_plan_status`, or Motir. |

**Which one to reach for:** `get_plan_status` answers _"what became of the job I
fired?"_ — a status, a count, and (while generating) whether the job died. It is
the poll. **`get_plan` answers _"what did it propose?"_** — the items themselves,
so a headless client can SHOW or judge the content instead of sending its user to
a browser. Neither takes a decision on the plan.

**Output** — `structuredContent`: the `PlanWithItemsDto` — the plan
(`id, projectId, status, title, summary, sourceJobId, origin, itemCount, createdAt, plannedAt, decidedAt, decidedById`)
plus `items[]`, one entry per proposal:

- **`op`** — `add` · `modify` · `remove`.
- **`proposedFields`** (`add`) — the new node's values: `title`, `kind`, `type`,
  `priority`, `executor`, `storyPoints`, `estimateMinutes`, `descriptionMd`,
  `explanationMd`.
- **`patch`** (`modify`) — only the CHANGED fields.
- **`workItemId`** — the target of a `modify` / `remove`; **`null` for an
  un-materialized `add`**.
- **`parentRef`** / **`blockedByRefs`** — each a real `work_item.id` **or** an
  intra-plan temp-ref `planItem:<planItemId>` pointing at another `add` in the
  same plan. Resolve the temp-refs against `items[].id` to rebuild the proposed
  tree and its dependency edges; the text block renders exactly that, indented.

A plan still `generating` returns the proposals that have arrived **so far**
rather than erroring — proposals stream in, so a caller polling the content sees
it fill.

> **⚠️ These are PROPOSALS, not work items.** Nothing in `items[]` exists in the
> tree. Approving the plan in Motir is the only path from a proposal to a
> `work_item` row, and an `add`'s `workItemId` stays `null` until then. Titles and
> sizing that read like work items are still proposals — do not report them as
> created.

A pure read. Errors: an unknown / other-tenant plan id returns `PLAN_NOT_FOUND`
(404-not-403, no existence leak). Requires `project:browse`.

#### Authoring a plan YOURSELF — `create_plan` · `add_plan_items`

The three tools above hand a **prompt** to Motir's planner and let it decide the
tree. These two are the other door: **you decide the tree, and Motir reviews it
exactly like any other plan.** Reach for them when you have already decomposed
the work — you are sitting in the repository with the code in front of you, which
is the position from which planning is easiest and Motir's own generator is not.

The comparison that matters is with `create_work_item`, not with the
conversation tools:

|                            | `create_work_item`             | `create_plan` + `add_plan_items`                         |
| -------------------------- | ------------------------------ | -------------------------------------------------------- |
| what lands                 | a `work_item` row, immediately | a `Plan` of proposals                                    |
| review                     | none                           | a person reads the tree and Approves / Declines in Motir |
| AI credits                 | none                           | none — no job runs, no prompt is assembled               |
| who is recorded as planner | `mcp` + the harness you report | the same, on the plan AND on every item it creates       |

##### `create_plan`

Open a `generating` plan on a project — the container you then fill.

| Input                | Type   | Required | Notes                                                                |
| -------------------- | ------ | -------- | -------------------------------------------------------------------- |
| `projectKey`         | string | yes      | The project key, e.g. `"ACME"`. Case-insensitive.                    |
| `title`              | string | no       | A short label — what this plan proposes, in a line.                  |
| `summary`            | string | no       | A longer Markdown summary, shown to the reviewer above the tree.     |
| `plannedWithHarness` | string | no       | The harness you run as, e.g. `"Claude Code"`. Shown to the reviewer. |
| `plannedWithModel`   | string | no       | The model you run, e.g. `"claude-opus-5"`. Shown beside the harness. |

**Output** — `structuredContent`: the plan (`id`, `status: "generating"`,
`projectId`, `title`, `summary`, `origin`, `itemCount`, `authorSource`,
`authorHarness`, `authorModel`, the lifecycle timestamps).

**The authorship is recorded, and it is not something you can claim.**
`authorSource` is set to `mcp` **server-side** — exactly as `create_work_item`
fixes its own `source` — so the two arguments you do supply are the harness and
the model, self-reported and stored as given. This is what the Plans list and the
plan-detail header show: a reviewer can see they are approving an agent's plan
rather than a Motir generation. When the plan is approved, every work item it
creates carries the same triple (`mcp · <harness> · <model>`).

Requires **`work_item:edit`** — the permission `plansService.createPlan` itself
asserts, even though no work item is created here.

##### `add_plan_items`

Append a batch of proposals, and optionally close the plan.

| Input       | Type    | Required | Notes                                                                  |
| ----------- | ------- | -------- | ---------------------------------------------------------------------- |
| `planId`    | string  | yes      | The id `create_plan` returned.                                         |
| `proposals` | array   | yes      | One or more proposals; see the shape below.                            |
| `final`     | boolean | no       | `true` on the LAST batch — closes the plan (`generating` → `planned`). |

Each proposal is `{ op, proposedFields?, workItemId?, patch?, parentRef?, blockedByRefs?, baseRevision? }`
— the same shape `get_plan` returns, minus the fields the server owns:

- **`op`** — `add` · `modify` · `remove`.
- **`proposedFields`** (`add`, required) — `title` (required), `kind`,
  `descriptionMd`, `explanationMd`, `type`, `priority`, `executor`,
  `storyPoints`, `estimateMinutes`, `targetRepo`, `targetRepoRole`.
- **`workItemId`** / **`patch`** / **`baseRevision`** — for a `modify` / `remove`.
- **`parentRef`** / **`blockedByRefs`** — a real `work_item.id`, **or** an
  intra-plan temp-ref `planItem:<id>`.

**Output** — `structuredContent`: the plan and its `items[]`, plus
**`planItemIds`** — the ids of the proposals **this call** created, **in the order
you sent them**.

**That order is the contract, and it is how a tree gets built.** A proposal can
only be a parent once it has an id, so send the tree **layer by layer, parents
before children**, and pass `planItem:<id>` from a previous call's `planItemIds`
as the next layer's `parentRef` or `blockedByRefs` entry:

```jsonc
// 1 — the epics and stories
add_plan_items({ planId, proposals: [
  { op: "add", proposedFields: { title: "Billing", kind: "epic" } },
  { op: "add", proposedFields: { title: "Invoices", kind: "story" }, parentRef: "planItem:<epic id>" },
]})
// → planItemIds: ["ck_epic", "ck_story"]   (index-for-index with what you sent)

// 2 — the leaves, hung off ids from step 1, and CLOSE the plan
add_plan_items({ planId, final: true, proposals: [
  { op: "add", proposedFields: { title: "Invoice PDF", kind: "subtask", storyPoints: 3, estimateMinutes: 45 },
    parentRef: "planItem:ck_story" },
  { op: "add", proposedFields: { title: "Email the invoice", kind: "subtask", storyPoints: 2, estimateMinutes: 30 },
    parentRef: "planItem:ck_story", blockedByRefs: ["planItem:ck_pdf"] },
]})
```

`final: true` moves the plan to `planned`, which is what puts it in the review
queue. **Appending to a plan that has already been closed is refused** —
`PLAN_NOT_GENERATING` — so send `final` exactly once, on your last batch. The
plan row is locked for the append, so two concurrent callers serialize rather
than interleaving into each other's `planItemIds`.

You do **not** set planning provenance on a proposal: `add_plan_items` stamps
each `add` from the plan's own authorship, so the plan and the items it creates
can never disagree about who wrote them.

Requires **`ai:view_plan`** — the permission `plansService.addProposals` asserts.
Together with `create_plan`'s `work_item:edit`, a token needs **both** keys to
author a plan end to end.

> **⚠️ Neither tool creates a work item.** Approving the plan in Motir is the
> only path from a proposal to a `work_item` row, and approval does **not** happen
> on this surface. Do not report proposed work as created. Read the plan back with
> `get_plan` to show what you proposed.

Errors: an unknown / other-tenant `projectKey` or `planId` returns
`PROJECT_NOT_FOUND` / `PLAN_NOT_FOUND` (404-not-403, no existence leak); a
malformed proposal returns `INVALID_PROPOSAL`; an append after `final` returns
`PLAN_NOT_GENERATING`.

##### `validate_plan` — CHECK the plan BEFORE `final: true`

The step between the last `add_plan_items` and the one that closes the plan, and
the only moment it is cheap. It answers _"is what I just proposed finishable?"_
over the project's live tree **⊕** this plan's proposals — the same check
Motir's own generator runs as its pre-commit post-condition, which is why a
Motir-generated plan arrives coherent.

| Input       | Type   | Required | Notes                                                                                                                             |
| ----------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `planId`    | string | yes      | The id `create_plan` returned.                                                                                                    |
| `condition` | enum   | no       | `loose` (default) — a done dependency outside the plan counts as satisfied. `tight` — every dependency must be IN the projection. |

**Output** — `structuredContent`: `{ planId, valid, blockers }`. Each blocker is
`{ item, blockedBy, blockerStatus, blockerSprintId }`; an `item` or `blockedBy`
of the form `planItem:<id>` names a **proposal in this plan**, not a work item.

```jsonc
validate_plan({ planId })
// → { planId: "cm…", valid: false, blockers: [
//      { item: "planItem:ck_email", blockedBy: "ACME-14",
//        blockerStatus: "todo", blockerSprintId: null } ] }
// "the invoice-email card I proposed is gated by ACME-14, which is neither in
//  this plan nor done" — fixable now, in the plan, before anybody reads it.
```

> **⚠️ What `valid: true` means, exactly.** The containing set is the whole
> projected forest of the plan's PROJECT — so a not-done item in the same project
> is IN the set and does not gate, under either `condition`. The gate this
> catches is an out-of-forest one: a **cross-project** blocker, or (under
> `tight`) a done one. Read it as _"nothing outside this project's forest gates
> this plan"_, not as _"every dependency is satisfied"_.

**This is the WHOLE-plan verdict and takes no target.** Do not approximate it by
looping `validate_work_item` per root: a `blocked_by` edge between two sibling
roots — a story under proposed epic B gated by one under proposed epic A — is
VALID here, because both materialize together, and a false positive per-root.
For ONE subtree, pass `planId` to `validate_work_item` instead.

Requires **`project:browse`** — the key `plansService.getPlan` asserts, the same
one the two other validators name. It is **not** `ai:view_plan`: that key gates
the plan DECISIONS (approve / decline / append), and this one decides nothing.

Errors: an unknown / other-tenant `planId` returns `PLAN_NOT_FOUND`
(404-not-403, no existence leak).

##### The PROJECTED mode on the existing validators

`validate_work_item` and `validate_sprint` each take the same optional
**`planId`**, and ask their own question over the projection instead of the
committed tree:

- **`validate_work_item({ key, planId })`** — is this SUBTREE finishable once the
  plan materializes? `key` may be a committed identifier (`"ACME-7"`) **or** a
  `planItem:<id>` temp-ref naming an `add` in that plan, which is the case an
  authoring agent usually has: the card it wants to check has no key yet.
- **`validate_sprint({ planId })`** — will the project's ACTIVE sprint still be
  finishable once the plan materializes? On this path the plan names its own
  project, so `projectKey` is not required; `sprintId` is **refused** rather than
  ignored, because a projected verdict is always about the active sprint (an
  `add` lands in the backlog, and a plan cannot move anything into a sprint).

> **⚠️ Omitting `planId` is not a mode — it is the tool as it has always been.**
> A call without it never builds a projection at all and returns exactly what it
> returned before this existed. Both modes are **read-only**: a projection is
> assembled in memory, answered from, and thrown away. Nothing is created,
> nothing is mutated, and no proposal becomes a work item except by approving
> the plan in Motir.

> **The reads that deliberately do NOT take a `planId`:** `list_ready`,
> `next_ready` and `claim_next_ready`. **A proposal is not dispatchable** — it has
> no key, nothing can claim it, and a ready list that included one would put a
> card in front of an agent whose very next call is _claim this_. That exclusion
> is a decision, not an omission (`docs/decisions/agent-authored-plans.md`
> AMENDMENT 3, Q6).

##### The PROJECTED mode on the two READS

`get_work_item` and `search_work_items` take the same optional **`planId`** and
answer over the projection — the project's live tree **⊕** that plan's proposals
— so an agent can ask _"what does the tree look like WITH what I just
proposed"_ in one call, instead of fetching `get_plan` and merging it against a
search by hand on every turn.

**A proposal is never mixed into a work item's array.** It rides its own —
`proposals` on a search, `proposedChildren` on a projected detail — and each row
additionally carries `proposal: true` and `key: null`, because a proposal has no
key until the plan is approved and **none is ever invented for it**. Two locks,
so a caller that flattens the arrays still cannot confuse the two.

**`get_work_item({ key, planId })`** answers under a `projection` key, and the
ordinary `children` array comes back EMPTY — a keyless proposal cannot sit in the
array committed children use, and nothing about that array is widened:

| `projection.…`      | What it holds                                                                  |
| ------------------- | ------------------------------------------------------------------------------ |
| `target`            | the card itself — a proposal (addressed by `planItem:<id>`) or a committed row |
| `parent`            | the projected parent, or null                                                  |
| `committedChildren` | committed children, minus any the plan removes                                 |
| `proposedChildren`  | children **this plan** proposes under the target                               |
| `blockedBy`         | the projected dependency edges — committed and proposed, each self-marked      |

A caller branches on `projection` being present, exactly as it does on a search.

| Field              | What it holds                                                                  |
| ------------------ | ------------------------------------------------------------------------------ |
| `target`           | the card itself — a proposal (addressed by `planItem:<id>`) or a committed row |
| `parent`           | the projected parent, or null                                                  |
| `children`         | COMMITTED children only, minus any the plan removes                            |
| `proposedChildren` | children **this plan** proposes under the target                               |
| `blockedBy`        | the projected dependency edges — committed and proposed, each self-marked      |

`key` may be a committed identifier **or** a `planItem:<id>` temp-ref, which is
what an authoring agent usually holds. A committed row the plan `modify`s
carries the patch verbatim as `pendingPatch` — _this is the row as it stands,
and this is what the plan would change about it_ — and one the plan `remove`s
comes back with `status: "removed_by_plan"` rather than as a not-found.

**`search_work_items({ projectKey, filter, planId })`** keeps `items` as the
filtered committed page (minus anything the plan removes) and adds:

```jsonc
{
  "items": [ /* committed rows, exactly as without planId */ ],
  "total": 42,
  "nextCursor": null,
  "projection": {
    "planId": "cm…",
    "filterAppliesTo": "items",
    "removedIds": ["cmq…"],
    "modifiedIds": ["cmr…"]
  },
  "proposals": [
    { "proposal": true, "key": null, "tempRef": "planItem:ck_pdf",
      "planItemId": "ck_pdf", "title": "Invoice PDF", "kind": "subtask", … }
  ]
}
```

> **⚠️ THE FILTER DOES NOT REACH PROPOSALS, and `projection.filterAppliesTo`
> says so on every response.** The FilterAST compiles to parameterized SQL over
> `work_item` rows, through the one registry that makes it injection-safe. A
> proposal is not such a row, so the choice was between reimplementing the whole
> grammar in memory — a second compiler, guaranteed to drift from the one the
> `/items` page uses — and saying plainly what the filter covers. Motir says it:
> `items` is filtered, `proposals` is the plan's **whole** `add` set. That answer
> is the same every time, rather than an accident of which fields a given
> proposal happens to carry.

> **Omitting `planId` is not a mode.** Neither read builds a projection without
> it, and the response has no `projection` / `proposals` key at all — so a call
> without it is byte-identical to what it returned before this existed. Both
> modes are read-only.

#### Planning as a CONVERSATION — `open_plan_session` · `append_plan_turn` · `submit_plan_session`

Changing a plan in Motir is not a one-shot prompt: it is a **persisted,
resumable, multi-turn conversation** that ACCUMULATES intent and is SUBMITTED
when you are ready. These three tools are that conversation over MCP — the same
substrate the Motir web app's planning rail talks through, so a terminal client
and a browser are two views of one thread.

**One thread per scope, addressed by scope.** A thread's identity is
`(project, anchor set)`, so every one of these tools takes `projectKey` plus an
optional `targetKeys` and never a session id:

| Input        | Type     | Required | Notes                                                                                                                                                                                |
| ------------ | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `projectKey` | string   | yes      | The project key, e.g. `"ACME"` (case-insensitive).                                                                                                                                   |
| `targetKeys` | string[] | no       | Work-item identifiers to ANCHOR the conversation at (max 20, case-insensitive). Omit for the **project-wide** thread. The SET is the identity — order and duplicates are irrelevant. |
| `body`       | string   | yes\*    | `append_plan_turn` only — what you want changed about the plan.                                                                                                                      |

Re-opening a scope **RESUMES** its conversation (same row, every turn already on
it); a different anchor set is a different conversation. Anchors are resolved
and permission-checked before they become a scope, so an item you cannot see is
a `NOT_FOUND`, never a silent anchor.

- **`open_plan_session`** — open or resume the thread and read it.
  **Output** — `structuredContent`: the session DTO
  `{ id, projectId, targetKeys, turnCount, lastJobId, lastSubmittedAt, createdAt, updatedAt, turns }`,
  where `turns` is the FULL ordered thread (`user` turns are what was typed,
  `system` turns are submission markers carrying their `jobId`). Submits
  nothing and costs nothing — but it still requires `ai:plan`, because opening
  the thread is what the shipped gate asks for.
- **`append_plan_turn`** — add one turn. **Output**: the updated session DTO.
  **⚠️ Appending does NOT submit.** Turns accumulate until you call
  `submit_plan_session`; that separation is the point — a later turn **refines**
  the earlier ones rather than replacing them, so _"add auth to the billing
  epic"_ then _"keep every subtask under 3 points"_ go out as ONE coherent
  change. A first turn opens the thread on its own, so no separate `open` call
  is required to start talking. Requires `ai:plan`.
- **`submit_plan_session`** — send the accumulated intent as ONE job.
  **Output** — `structuredContent`: `{ jobId, planId, session }`. It **submits
  and returns** exactly like `expand_item` — poll `get_plan_status` for the
  outcome, then `get_plan` to SHOW what was proposed. A single-turn thread is sent verbatim; a multi-turn thread is sent as
  the numbered accumulated intent. The submission is recorded on the thread as a
  `system` marker turn carrying the job id, and the thread stays open for
  further refinement.

> **⚠️ Submitting does NOT create work items.** The job produces a **`Plan` of
> proposals** — approving that plan, a decision made in Motir and not on this
> surface, is the only path from a proposal to a work item. Do not report
> proposed work as created.

Errors: a thread that was never opened returns `PLAN_CHANGE_SESSION_NOT_FOUND`;
one with no turns yet returns `PLAN_CHANGE_EMPTY_INTENT` (say what to change
first); an empty body returns `PLAN_CHANGE_EMPTY_TURN`; more than 20 anchors
returns `PLAN_CHANGE_TOO_MANY_TARGETS`. A refused job returns the motir-ai code
verbatim — `MOTIR_AI_OUT_OF_CREDITS` (do not retry) or `MOTIR_AI_UNAVAILABLE`
(retryable) — and **leaves the thread intact**, so your turns are never lost and
no orphan `Plan` is opened. The job runs on the **token owner's** AI credits, and
`submit_plan_session` — alone among these three — draws the shared
**`ai:generate`** budget (see [Rate limits](#rate-limits)): opening a thread and
appending turns cost nothing at the provider, submitting one does. Over budget
returns a `RATE_LIMITED` tool error before the job is submitted, and likewise
leaves the thread intact.

> **Fresh projects.** These tools drive plan CHANGE (augment / contextual
> re-plan) against an existing tree. Generating a plan for an empty project is
> driven by the onboarding interview in Motir, a different conversation — this
> surface does not reach it.

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

#### `list_projects`

Enumerate the projects the presented token can reach — the read that lets a
client **resolve** a project instead of asking the user to type its key. Takes
**no arguments**: the workspace is the one the token is bound to, so this can
never reach another tenant. `whoami`'s companion — `whoami` answers "who am I and
which workspace", this answers "which projects are in it".

**Input** — none.

**Output** — `structuredContent`: `{ projects: ProjectRow[] }`, where each
`ProjectRow` is:

| Field         | Type                                           | Notes                                                        |
| ------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `key`         | string                                         | The project key — exactly what `projectKey` takes elsewhere. |
| `id`          | string                                         | Opaque project id.                                           |
| `name`        | string                                         | Display name.                                                |
| `slug`        | string                                         | URL slug.                                                    |
| `accessLevel` | `"open" \| "limited" \| "private" \| "public"` | Browse-access level — disambiguates same-named projects.     |

The text block lists one project per line: `ACME — Acme Corp · open`.

**Access + tenancy.** Backed by the SAME service the app shell's project switcher
calls, so the checks are the UI's: workspace membership is asserted, then every
project the caller may not browse (Story 6.4) is filtered out. A workspace with no
reachable projects returns an **empty list**, not an error.

**No per-row cost.** The whole call is a constant number of queries regardless of
how many projects come back. `createdAt` and a work-item count are deliberately
omitted — either would cost an extra projection or a query per row, which a
client looping over projects would inherit as a scale bug.

#### `get_project_state`

Read a project's **planning preconditions** — the configuration an agent should
**verify** before planning against it, instead of assuming. `list_projects`
answers "which projects can I reach"; this answers "what state is one in".

Four questions, one call:

- **Is the project established?** The immutable onboarding marker, resolved
  through `resolvePlanningHostGate` — the same gate the planning surfaces read.
- **Is code connected?** Whether the workspace has a GitHub App installation and
  which repositories the grant covers.
- **Is that code INDEXED?** Per-repo `indexed` / `pending`, from the succeeded
  `system.code-graph-index` ledger, plus the set-level `hasRunning`.
- **What is the project's repository SET, and where did onboarding stop?**

**Input**

| Field        | Type   | Required | Notes                       |
| ------------ | ------ | -------- | --------------------------- |
| `projectKey` | string | yes      | Project key, e.g. `"ACME"`. |

**Output** — `structuredContent`: a `ProjectStateDto`:

| Field          | Type                           | Notes                                                                                                               |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `project`      | object                         | `{ key, id, name, onboardingRanAt }` — the marker is carried beside the verdict it produced.                        |
| `planningGate` | `"workspace" \| "onboarding"`  | `resolvePlanningHostGate`'s verdict: `workspace` = established, `onboarding` = never onboarded.                     |
| `code`         | object                         | `{ installed: boolean, index: MigrateIndexStatusDto }` — see below.                                                 |
| `repoSet`      | `ProjectRepoDto[]`             | The PROJECT's repository set (distinct from the workspace's connected set); `[]` when the establish step never ran. |
| `onboarding`   | `MigrateOnboardingDto \| null` | The migrate-onboarding run (`step` / `status` / `codeGraphReady` / `conventionApprovedAt`), or `null`.              |

`code.index` is the **shipped `MigrateIndexStatusDto`** — the exact shape the
migrate wizard's Index step polls — reused rather than re-invented:
`{ repos: [{ provider, repoRef, status }], indexedCount, total, hasRunning, allIndexed }`.
`status` is `indexed` when a succeeded index run matches the repo's `owner/name`
ref and `pending` otherwise; `pending` covers queued, in flight, **and never
attempted** — the ledger cannot separate them per repo, because a running row
carries no `repoRef` (which is why `hasRunning` is a set-level flag). A
repository connected before the index feature shipped reports `pending`, which is
the honest answer: it has no graph (MOTIR-1961).

`code.installed` is carried separately from `index.total === 0` on purpose: no
installation and an installation whose grant covers no repositories are different
states with different fixes.

**Nothing configured is an ANSWER, not an error.** A project with no
installation, no repos and no migrate run returns
`installed: false`, an empty index status, `repoSet: []` and `onboarding: null` —
every field present. A planner must be able to tell "there is no code" from "I
could not look".

**Read-only.** There is no way here to stamp the onboarding marker, trigger an
index, or advance a migrate run. Reporting a precondition and satisfying it are
different acts; only the first lives on this surface. It also makes no `motir-ai`
round-trip — pre-plan document contents and the code-graph query surface stay
behind the open-core boundary.

**Access + tenancy.** `projectKey` selects **within** the token's workspace, it
does not choose one: the key is resolved by the same browse-gated service every
other project-scoped tool uses, so another tenant's key reads as a plain
not-found (404-not-403, no existence leak).

**No per-repo cost.** The index state comes from ONE ledger query joined against
the repo list in memory, so the call's query count is invariant to how many
repositories the grant covers.

#### `mark_integrated`

Record that a work item's work has been integrated onto a session branch (the
write the CLI loop calls on agent success): the item moves to **In review** and
its `sessionBranch` is recorded — in ONE transaction — which unblocks its
dependents while the session PR awaits a human merge. Optionally self-report the
**implementation provenance** — how the item was built (Story MOTIR-1685).

**Input**

| Field                   | Type                 | Required | Notes                                                                                                             |
| ----------------------- | -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `key`                   | string               | yes      | The work item identifier, e.g. `ACME-7`.                                                                          |
| `sessionBranch`         | string               | yes      | The integration branch the work was merged onto.                                                                  |
| `implementationSource`  | `"byok" \| "manual"` | no       | Self-reported execution lane; defaults to `byok` when a harness/model is reported. `hosted` is not accepted here. |
| `implementationHarness` | string               | no       | Self-reported harness (e.g. `opencode`, `Claude Code`). Recorded as-is (no verification implied).                 |
| `implementationModel`   | string               | no       | Self-reported model (e.g. `claude`, `deepseek`).                                                                  |

**Output** — `structuredContent`: the updated `WorkItemDto` (now `in_review`,
carrying `sessionBranch` and any recorded implementation provenance). Omitting
the provenance fields leaves the implementation triple untouched. See
`docs/decisions/work-item-provenance.md`.

#### `complete_session`

Close out a session branch after its PR is merged: every work item recorded on
the branch moves to **Done** and its branch is cleared, in one transaction.
Returns a per-item outcome (`completed` / `already_done` / `failed`). Optionally
self-report implementation provenance applied to **every item it closes**.

**Input**

| Field                   | Type                 | Required | Notes                                                                  |
| ----------------------- | -------------------- | -------- | ---------------------------------------------------------------------- |
| `sessionBranch`         | string               | yes      | The branch whose recorded items are being closed out.                  |
| `implementationSource`  | `"byok" \| "manual"` | no       | Self-reported lane; defaults to `byok`. `hosted` is not accepted here. |
| `implementationHarness` | string               | no       | Self-reported harness, stamped on every closed item.                   |
| `implementationModel`   | string               | no       | Self-reported model, stamped on every closed item.                     |

**Output** — `structuredContent`:
`{ sessionBranch, results: [{ key, outcome, reason? }] }`. Omitting the
provenance fields leaves each item's provenance as its `mark_integrated` report
or the manual-lane stamp.

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
- **Revoke on leak — instantly.** Revoking a token from Settings → Account → Tokens
  is instant: the very next tool call with that token fails the bearer
  gate with a 401. Revocation is a soft-revoke (the row is kept for the audit
  trail, stamped `revokedAt`).
- **Tokens are stored only as a SHA-256 hash.** Motir persists the hash plus a
  short display prefix — never the plaintext. A database read cannot reveal a
  usable token.
- **The `motir_pat_` prefix is greppable on purpose.** Like GitHub's `ghp_`
  convention, the fixed prefix lets secret scanners detect a leaked Motir token
  in code or logs.
