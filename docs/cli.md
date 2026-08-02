# The `motir` CLI

Terminal dispatch of the Motir work loop: read your project's ready set, hand
one item's prompt to your own coding agent, and close the work out after you
merge it.

The CLI is an **MCP client** of the Motir server (`/api/mcp`). Every command
speaks Model Context Protocol with a personal access token as its bearer
credential — there is no parallel REST path, so the CLI can never disagree with
the web app about what "ready" means. See [`docs/mcp.md`](./mcp.md) for the token
and tool surface it consumes.

Motir is **BYOK**: you bring your own coding agent and your own model key. Motir
launches the agent, hands it a server-generated prompt, and reports its exit
code. It never reads the agent's credential and never inspects its output.

**Contents** — [Install](#install) · [Authenticate](#authenticate) ·
[Link](#link-a-workspace-root) · [Preflight](#preflight) ·
[Your first run](#your-first-run) · [Command reference](#command-reference) ·
[The three run shapes](#the-three-run-shapes) ·
[Planning](#planning-from-the-terminal) ·
[Session branches](#session-branches-what-motir-auto-actually-does) ·
[Failure policy](#failure-policy) · [Agent wiring](#agent-wiring) ·
[The sandbox](#the-sandbox) · [Files and environment](#files-and-environment) ·
[Troubleshooting](#troubleshooting)

---

## Install

```sh
npm install -g @motir/cli
motir --help
```

`pnpm add -g @motir/cli` and `yarn global add @motir/cli` install the same
package. Runtime: **Node ≥ 22**, ESM. Every example below writes `motir`.

**For contributors** — to run the CLI from a `motir-core` checkout instead of
the published package:

```sh
pnpm --filter @motir/cli build      # produces packages/cli/dist/index.js
node packages/cli/dist/index.js --help
```

---

## Authenticate

```sh
motir login
```

That is the whole thing. `motir login` prints a short code, opens Motir in your
browser, and waits for you to approve it there:

```
  Your code:  K4TP-9RXM
  Open:       https://app.motir.co/device
```

Sign in, enter the code, approve — and the terminal reports who it connected as
and which workspace it bound to. **Codes last 15 minutes**, and nothing is
written to disk until you approve, so a denied, expired, or `Ctrl-C`'d login
leaves no credential behind.

**No browser on that machine?** The code and the URL are printed either way, so
an SSH session or a container uses the _same_ command — open the URL on any
device and enter the code there. `--no-browser` skips the launch attempt
outright:

```sh
motir login --no-browser
motir login --server https://motir.internal.example   # a self-hosted server
```

The credential lands in `~/.config/motir/config.json`, `chmod 600` inside a
`0700` directory, **keyed by server URL** — so one machine can hold credentials
for several Motir servers. If that directory is read-only (the sandbox image
mounts it that way on purpose), use the `MOTIR_TOKEN` tier below instead: it is
never written to disk at all.

### What the approval mints

The token `motir login` creates is **not** a general-purpose PAT. It is fixed at
the boundary, and the approval screen shows it rather than letting you edit it:

| Property      | Value                                                        |
| ------------- | ------------------------------------------------------------ |
| **Scopes**    | `read`, `work_items:write`, `integration` — and nothing else |
| **Expiry**    | 90 days                                                      |
| **Label**     | `CLI · <hostname>`, so you can tell which machine it is      |
| **Workspace** | the one you choose on the approval screen                    |

Those three scopes are exactly what the CLI's MCP calls resolve to: `read` for
the selection and prompt tools, `work_items:write` for the status flips, and
`integration` for `mark_integrated` / `complete_session` (which `motir auto` and
`motir done --session` use). It calls nothing gated by `work_items:archive`,
`work_items:delete`, or `sprints:write`.

The grant cannot **widen** that set, and cannot **narrow** it either — a
hand-narrowed grant would fail somewhere in the middle of an unattended
`motir auto` run, which is the worst place to discover a missing scope. If you
want a different grant, mint one by hand in **Settings → Account → API tokens →
Create** (which keeps its full scope choice and its 30/90/365/never expiry) and
supply it with the `--token` tier below. Reasoning:
[`docs/decisions/cli-login.md`](./decisions/cli-login.md); per-scope detail:
[`docs/mcp.md` § Token scopes](./mcp.md#token-scopes).

### The three credential tiers

`motir login` is the middle one. All three end in the same place — a PAT the CLI
sends as its bearer credential — and differ only in who supplies it:

| Tier                           | How                                          | For                                                 |
| ------------------------------ | -------------------------------------------- | --------------------------------------------------- |
| **`MOTIR_TOKEN`**              | export the variable — no login step, no file | CI, containers, any box with a read-only config dir |
| **`motir login`**              | browser approval (above)                     | a person at a terminal                              |
| **`motir auth login --token`** | paste a PAT you already hold                 | scripts, and servers predating the device grant     |

**`MOTIR_TOKEN` is honoured by every command**, not only at login, and is never
written anywhere. Pair it with `MOTIR_SERVER` when there is no `.motir.json` to
walk up to:

```sh
export MOTIR_TOKEN=motir_pat_…
export MOTIR_SERVER=https://app.motir.co   # optional — this is also the default
motir ready                                # no login step at all
```

It **outranks** a stored credential, so a stale one exported in a shell profile
wins silently; `motir auth status` names the source it used for exactly that
reason. Precedence: `--token <pat>` > `MOTIR_TOKEN` > `config.json`.

The paste path is unchanged, and is what a script wants when it already holds a
token:

```sh
motir auth login --server https://app.motir.co          # prompts for the token
motir auth login --server https://app.motir.co --token motir_pat_…
```

`auth login` validates before storing: it connects, lists the server's tools, and
resolves the owner with `whoami`, so an invalid or revoked token is rejected
there rather than halfway through a dispatch. Mint the PAT it wants in the web
app — **Settings → Account → API tokens → Create** — and copy it immediately;
Motir stores only a hash, so the plaintext is shown exactly once
([`docs/mcp.md` § Creating an API token](./mcp.md#creating-an-api-token)).

```sh
motir auth status     # server, token prefix, owning user, active workspace
```

### Disconnecting

Two different actions, and only one of them is a kill switch:

- **`motir logout` forgets the local copy.** It removes the credential from
  **this machine** only; the token itself keeps working anywhere else it is held.
- **Revoking the token in Settings → Account → API tokens is the disconnect.**
  That kills the credential server-side, everywhere, immediately. A terminal
  connected by `motir login` appears in that list as `CLI · <hostname>`, which is
  what makes "disconnect that machine" a single obvious row.

```sh
motir logout                    # this machine, the resolved server
motir logout --server <url>     # a specific server
```

`motir auth logout` is the same action under the older name.

---

## Link a workspace root

`motir link` binds a **workspace-root directory** — the folder your repo
checkouts live under — to a server, workspace, and project. It writes
`.motir.json` there.

```sh
cd ~/projects/acme          # the folder holding your checkouts
motir link --project ACME
```

`.motir.json` holds **no secret** (`{ serverUrl, workspace, project, repos? }`),
so it is safe to commit. Every command resolves it by walking **upward** from
the current directory, so any command works from inside any checkout under the
root.

**Repo checkouts resolve by convention** — `<root>/<repoName>`, matching the
repo name Motir pins on each work item. The optional `repos` map carries
overrides only:

```sh
motir link add motir-ai ../elsewhere/motir-ai   # repo lives off-convention
motir link remove motir-ai                      # drop the override
motir link                                      # bare re-run: show the binding
```

If this very directory _is_ the single repo's checkout, say so:

```sh
motir link --project ACME --repo acme-app       # writes { "acme-app": "." }
```

An **empty folder is first class**: bind it and go — the first scaffold work
items create the checkouts themselves.

---

## Preflight

```sh
motir doctor
```

One read-only pass that answers "is my setup correct?" before a dispatch stops
halfway through:

| Check                   | PASS means                                                    | FAIL means                                                             |
| ----------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Auth**                | the resolved credential connects, lists tools, identifies you | no token, or invalid / expired → `motir login`                         |
| **Project link**        | `.motir.json` resolved (walking up from the cwd)              | no link here or above → `motir link`                                   |
| **Workspace + project** | the linked project is reachable _for this token_              | wrong key, or your user is not a member                                |
| **Repo checkouts**      | every override path resolves                                  | — a not-yet-cloned **convention** path is fine; an override only WARNs |
| **Coding agent**        | the binary is on PATH and answers `--version`                 | not on PATH → the profile's install source                             |
| **Agent credential**    | the agent's credential exists, or its key env var is set      | neither → where to sign in                                             |

It exits **non-zero** when a hard check fails, so `motir doctor && motir auto`
is a usable gate. WARN rows never fail it — "no agent configured" is a warning,
because `motir next --print` hands you the prompt for an agent Motir never
launches. `--json` emits the same report machine-readably; `--agent <cmd>`
checks a specific agent instead of the configured one.

**It never reads your secret.** The credential check asks only whether a path
exists or an env var is set. `doctor` writes nothing: its only server calls are
the handshake, `whoami`, and a one-row search proving the project is reachable.

---

## Your first run

Start by getting your bearings — where the project stands, what the current
sprint holds, and what the item you are about to pick up actually says:

```sh
motir status                   # ready / in-flight counts + the active sprint
motir sprint                   # the active sprint's items, and what blocks what
motir ready                    # what can be picked up right now
```

`motir sprint` and `motir ready` show dependency edges in their own columns, so
you can see which item unblocks the most before choosing one — see
[Dependencies in the terminal](#dependencies-in-the-terminal--two-renderings).

Then **read the item before you dispatch it.** `motir show` gives you the whole
card — fields, readiness, its dependency edges, and, for a story, its children in
build order:

```sh
motir show MOTIR-42            # the item you're about to hand an agent
```

That is worth the ten seconds: it is where you notice that the card assumes
something that does not exist yet, or that three of its siblings are buildable in
parallel. Now claim it:

```sh
motir next --print             # claim the top item, print its prompt
```

`--print` writes the **prompt to stdout** and everything else (the repo, the
resolved path, the workflow mode) **to stderr** — so `motir next --print | pbcopy`
copies the prompt alone while you still see the context on screen. Paste it into
whatever agent you like; when the agent's pull request is merged, close the item
out:

```sh
motir done --via in_review MOTIR-42
```

(The `--via` hop is needed on this path because the CLI never saw an agent
finish — see [Closing out](#closing-out).)

To have Motir launch the agent for you, and then to drain the whole ready set:

```sh
motir next  --agent "claude --dangerously-skip-permissions"
motir auto  --agent "claude --dangerously-skip-permissions" --max 5
```

`motir auto` is the unattended loop. Read
[Session branches](#session-branches-what-motir-auto-actually-does) before your
first one — it explains what lands where, and why nothing reaches `main` without
you.

---

## Command reference

Every command and flag the binary registers. `motir`, `motir help`, and
`motir --help` all print the same curated overview on stdout and exit 0.

### Setup

| Command                        | Flags                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `motir login`                  | `--server <url>` · `--no-browser`                                             |
| `motir logout`                 | `--server <url>`                                                              |
| `motir auth login`             | `--server <url>` · `--token <pat>`                                            |
| `motir auth status`            | `--server <url>`                                                              |
| `motir auth logout`            | `--server <url>`                                                              |
| `motir link`                   | `--server <url>` · `--workspace <slug>` · `--project <key>` · `--repo <name>` |
| `motir link add <repo> <path>` | —                                                                             |
| `motir link remove <repo>`     | —                                                                             |
| `motir doctor`                 | `--agent <cmd>` · `--json`                                                    |

```sh
motir login                                    # the usual way in
motir login --no-browser                       # …over SSH: just print the code
motir auth login --server https://app.motir.co --token motir_pat_…
motir auth status --server https://app.motir.co
motir link --project ACME --repo acme-app
motir link add motir-ai ../elsewhere/motir-ai
motir doctor --agent "codex exec --sandbox workspace-write" --json
```

### Read

| Command              | Flags                                                           |
| -------------------- | --------------------------------------------------------------- |
| `motir ready`        | `--kinds <list>` · `--assignee <id\|me\|unassigned>` · `--json` |
| `motir status`       | `--json`                                                        |
| `motir sprints`      | `--state <planned\|active\|complete>` · `--json`                |
| `motir sprint [ref]` | `--kinds <list>` · `--json`                                     |
| `motir show <key>`   | `--activity` · `--comments` · `--json`                          |
| `motir open <key>`   | `--print`                                                       |

```sh
motir ready --kinds subtask,bug --assignee me
motir ready --json | jq '.[].key'
motir status                       # ready / in-flight counts + the active sprint
motir sprints --state active       # just the one that's running
motir sprint                       # the active sprint's work items
motir sprint "Journey D"           # …a specific one, by name prefix
motir show MOTIR-1775              # one item: fields, edges, children in build order
motir show MOTIR-1775 --activity   # …plus the discussion: comments AND history
motir show MOTIR-1775 --comments   # …just what people said
motir open MOTIR-42 --print        # print the URL, don't launch a browser
```

`--kinds` takes any of `epic,story,task,bug,subtask`; an unknown kind is a hard
error naming the valid set. These reads ride the same MCP tools the web app's
**`/ready`** page uses, so the two can never disagree — `/ready` is the human
mirror of `motir ready`, and its in-app help popover is the on-surface
explanation of what "ready" means.

`motir sprints` marks the active sprint with a `*` in the first column:

```
1 sprint:
   STATE   NAME                                      ITEMS  POINTS  WINDOW
─  ──────  ────────────────────────────────────────  ─────  ──────  ─────────────────────
*  active  Journey D · The Motir CLI — terminal di…     41      45  2026-07-28T00:00:00…
```

#### `motir sprint [ref]` — how the ref resolves

The one behaviour you cannot guess. `ref` is matched in this order, and the
first rule that yields **exactly one** sprint wins:

1. **Omitted** → the **active** sprint. If no sprint is active, that is an error
   telling you to run `motir sprints`.
2. **A sprint id** (the opaque `cmq…` string `--json` and the MCP emit).
3. **An exact name**, case-insensitively.
4. **A name prefix**, case-insensitively.

A prefix matching **more than one** sprint is an error that names the
candidates, so you can retype with enough of the name to disambiguate — it never
silently picks the first:

```console
$ motir sprint "Sprint 1"
Error: "Sprint 1" matches 11 sprints.
Hint: Name one of: Sprint 1 · Project bootstrap, Sprint 10 · Swimlanes + WIP limits, …
```

No match at all fails the same way (one line + hint on **stderr**, exit **1**).
Note that step 3 precedes step 4 deliberately: a sprint literally named
`Sprint 1` would resolve to itself even though it is also a prefix of
`Sprint 10`.

#### `motir show --activity` / `--comments` — the discussion

`show` reads the card; these two flags read what was **said about** it. Same
command, because the discussion is part of the item, not a separate object —
the shape `gh issue view <n> --comments` uses.

| Flag         | What it prints                                              |
| ------------ | ----------------------------------------------------------- |
| `--activity` | The merged stream: comment threads **and** the change trail |
| `--comments` | The comment threads only                                    |

```console
$ motir show MOTIR-1999 --activity
… the usual show block …

ACTIVITY
2 of 9 comments · 1 of 4 changes

[comment] Zhu Yue · 3 days ago (2026-07-30T12:00:00.000Z)
          The rationale for archiving it.
  ↳ reply Odie · 1 hour ago (2026-08-02T11:00:00.000Z) (edited)
          Agreed — the mirror does the same.
[change]  Mo · 1 hour ago (2026-08-02T11:00:00.000Z) — changed status: To Do → In Progress

MORE — 7 comments and 3 changes not on this page. `motir show` prints ONE page
and never drains the stream; read the rest in Motir: `motir open MOTIR-1999`.
```

Four things worth knowing:

- **Neither flag = the read you already had.** The stream is a **second** tool
  call, made only when you ask for it, so a card with two hundred comments never
  slows down a plain `motir show` (or the dispatch path that leans on it).
- **Comment bodies are printed IN FULL**, never excerpted. A rationale you can
  only half-read is worse than one you know you have to page for.
- **One page, and it says what it left behind.** There is no `--cursor`: this is
  a look, not a walk. When more remains, the footer names how much and points at
  `motir open <key>` for the whole stream in Motir. A **short page that still has
  a cursor is normal** for the merged view (the trail is scanned in bounded
  windows), and the footer says that too rather than implying the page is
  everything.
- **`--json`** emits the activity page **unaltered** under an `activity` key
  beside the usual aggregate — cursor and totals included. Without a flag the key
  is absent, so the payload is exactly what it was before.

The two flags are alternatives: passing both is refused by name rather than
silently resolved to one of them. Both need only the `read` scope, which is what
`motir login` mints.

### Dependencies in the terminal — two renderings

Dependency edges show up in **two different shapes**, and they are not
inconsistent with each other — they answer different questions because the sets
they describe have different shapes.

> A **ready set or a sprint spans many parents**, so its edges are disconnected
> fragments with no graph to draw → a **column**. A **story's children are one
> closed dependency graph** (every `blocked_by` edge joins siblings under the
> same parent) → a **build order**.

#### 1. Edge COLUMNS — on `motir ready` and `motir sprint`

`motir sprint` carries both directions, because a sprint holds mixed-status work
and "why can't this finish?" is the load-bearing question:

```
KEY         KIND     STATUS       PRIORITY  BLOCKED BY                             BLOCKS                  TITLE
──────────  ───────  ───────────  ────────  ─────────────────────────────────────  ──────────────────────  ─────────────────────
MOTIR-669   subtask  todo         high      MOTIR-662✓, MOTIR-664✓, MOTIR-668✓ +2  MOTIR-1869, MOTIR-1872  8.7.9 Publish the `@…
MOTIR-809   story    in_progress  medium    MOTIR-808✓                             MOTIR-1789              Motir CLI — terminal…
✓ = already done
```

`motir ready` carries **only `BLOCKS`**. That is not an omission: an item is in
the ready set precisely because every blocker is already done, so a `BLOCKED BY`
column would be dead in every row. What a picker actually wants is downstream
impact — _"do this one first, it unblocks three."_

```
KEY         KIND     PRIORITY  ASSIGNEE    BLOCKS                              TITLE
──────────  ───────  ────────  ──────────  ──────────────────────────────────  ─────────────────────
MOTIR-1777  subtask  highest   unassigned  MOTIR-1779, MOTIR-1781              Spike — verify the t…
MOTIR-1043  subtask  high      unassigned                                      8.8 The public /toke…
```

Reading the cells:

- **Blank means no edges** — never `0`, which would read as a count the row does
  not have (`MOTIR-1043` above).
- **`✓` marks a blocker that is already `done` or `cancelled`.** It no longer
  gates, so it must not read as if it does. Live edges are listed **first**;
  settled ones follow, suffixed.
- **`+n` is truncation, not a count of anything.** A cell prints at most
  **three** keys and collapses the rest, because a wrapped cell would wreck the
  column alignment of every row below it.
- **`--json` always carries the full, untruncated edge block.** The abbreviation
  is a display concern only; the machine view never lies. Here is the same row
  both ways — the table collapses its fourth edge, the JSON keeps all four:

  ```
  MOTIR-1122  subtask  high  unassigned  MOTIR-1123, MOTIR-1124, MOTIR-1161 +1  8.5.1 Decide produc…
  ```

  ```console
  $ motir ready --json | jq '.[] | select(.key == "MOTIR-1122") | .dependencies'
  {
    "blockedBy": [],
    "blocks": [
      { "key": "MOTIR-1123", "title": "8.5.2 Provision transactional-email provider…", "status": "todo" },
      { "key": "MOTIR-1124", "title": "8.5.4 Production deploy + attach motir.co domain…", "status": "todo" },
      { "key": "MOTIR-1161", "title": "8.5.5 Provision error-monitoring (Sentry)…", "status": "todo" },
      { "key": "MOTIR-1165", "title": "8.5.9 App-level rate limiting on auth…", "status": "blocked" }
    ]
  }
  ```

  Note the field is **`key`** (the `MOTIR-<n>` identifier), on both the row and
  every edge entry.

- Against an **older Motir server** that does not project edges at all, the
  columns are simply absent — the reads degrade to their previous shape rather
  than failing. (The CLI is versioned and published independently of the
  server.)

#### 2. The `WAVE` build order — on `motir show <key>`

A parent's children are a closed DAG, so `motir show` sorts them into **waves**
and puts the wave number in a column. **Wave 1 is the story's independently
buildable set** — everything no un-done sibling gates, i.e. what you can start
in parallel right now. Wave 2 is what only wave 1 gates, and so on:

```console
$ motir show MOTIR-1775
```

```
CHILDREN (10) — build order
WAVE  KEY         KIND     STATUS   BLOCKED BY                             TITLE
────  ──────────  ───────  ───────  ─────────────────────────────────────  ─────────────────────
1     MOTIR-1776  subtask  todo                                            Decision — repo owne…
1     MOTIR-1777  subtask  todo                                            Spike — verify the t…
1     MOTIR-1780  subtask  todo                                            (motir-core) Project…
2     MOTIR-1778  subtask  blocked  MOTIR-1776                             (motir-core) Design …
2     MOTIR-1779  subtask  blocked  MOTIR-1777                             Apply the GitHub gra…
2     MOTIR-1783  subtask  blocked  MOTIR-1780                             (motir-core) Name th…
3     MOTIR-1781  subtask  blocked  MOTIR-1777, MOTIR-1779, MOTIR-1780     (motir-core) The rep…
4     MOTIR-1782  subtask  blocked  MOTIR-1778, MOTIR-1781                 (motir-core) The app…
5     MOTIR-1784  subtask  blocked  MOTIR-1780, MOTIR-1781, MOTIR-1782 +1  (motir-core) Vitest …
5     MOTIR-1785  subtask  blocked  MOTIR-1782                             (motir-core) Playwri…
```

The wave number **is** the graph: three items can start immediately, and
`MOTIR-1784` waits on four things (three shown, `+1` truncated). `BLOCKED BY`
names the actual edges rather than just asserting an order, so "why is this
wave 5?" is answerable from the row.

Two marks appear here that the columns above don't need, and the legend prints
**only** when a row actually shows one:

- **`✓` — already done.** Same meaning as in the columns.
- **`↗` — a blocker outside this parent.** Plan rules forbid these, but the data
  can hold them, so they are named rather than hidden. They deliberately do
  **not** form a wave: nothing in this table can clear them, so counting them
  would distort every wave below.

`show --json` re-orders `children` into the same build order and stamps each with
its `wave`, so a script gets the ordering without re-deriving the graph.

##### The cycle marker

If children block each other in a loop they have **no position in any build
order**. `motir show` reports that rather than inventing one: the cycle members
come last with `—` in the `WAVE` column, followed by

```
⚠ dependency CYCLE — MOTIR-101, MOTIR-102 block each other and have no build order. Fix the blocked_by edges.
```

This is **a planning bug in the tree, not a CLI error** — `show` still exits
**0**. The fix is to correct the `blocked_by` edges (in the web app, or with the
`link_work_items` / `unlink_work_items` MCP tools); `motir show` is only
reporting what the plan says. In `--json`, a cycle member's `wave` is `null`.

### Work loop

| Command                | Flags                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `motir next`           | `--kinds <list>` · `--print` · `--agent <cmd>` · `--reset`                                           |
| `motir run <key>`      | `--print` · `--agent <cmd>` · `--force`                                                              |
| `motir auto`           | `--agent <cmd>` · `--kinds <list>` · `--max <n>` · `--keep-going` · `--reset` · `--include-planning` |
| `motir batch`          | `--agent <cmd>` · `--kinds <list>` · `--max <n>` · `--keep-going` · `--reset`                        |
| `motir plan [args...]` | `--detach`                                                                                           |
| `motir done [key]`     | `--session <branch>` · `--via <status>`                                                              |

```sh
motir next --kinds subtask --print
motir next --agent "claude --dangerously-skip-permissions" --reset
motir run MOTIR-42 --print                  # a SPECIFIC item
motir run MOTIR-42 --force                  # dispatch it even though it isn't ready
motir auto --agent "claude --dangerously-skip-permissions" --max 5 --keep-going
motir auto --agent "…" --include-planning   # also fire expansions for unexpanded containers
motir batch --agent "codex exec --sandbox workspace-write --ask-for-approval never"
motir plan                                  # resume the project-wide conversation
motir plan MOTIR-42 "size these" --detach   # anchored, one turn, don't wait
motir done MOTIR-42                         # after you merge its pull request
motir done --via in_review MOTIR-42         # …when the CLI never saw the agent finish
motir done --session motir/auto-20260729-011830
```

`--print` is **registered but refused** on `auto` and `batch`: an unattended run
has nobody to paste a prompt, so the flag fails with guidance rather than
commander's bare "unknown option".

### Help and topics

```sh
motir help                     # the curated overview (also: motir, motir --help)
motir help auth login          # per-command help, nested
motir link add --help          # the same, the other way round
motir help environment         # the 6 env vars Motir reads, and what each overrides
motir help files               # ~/.config/motir/config.json + .motir.json
motir --version                # -v also works
```

The two topics are also plain commands (`motir environment`, `motir files`). An
unknown topic fails like every other CLI error — one line plus a hint on
**stderr**, exit **1**, no stack trace — so `motir help | head` stays clean for
piping.

---

## The three run shapes

Selection differs; the pipeline does not. Every dispatch runs:

```
select → transition_status(in_progress) → dispatch_prompt → deliver
```

**The prompt is generated SERVER-SIDE** (`dispatch_prompt`) and printed
byte-identical. The CLI never assembles prompt text, so every harness — Claude
Code, Codex, opencode, or a human reading it — receives the same instruction,
and the prompt grammar versions with the product rather than with your CLI
build.

**Repo routing.** The dispatch payload names the item's repo; the CLI maps that
name to a checkout via `.motir.json` or the `<root>/<repoName>` convention and
runs the agent **there** — so dispatching a `motir-ai` item while standing in
`motir-core` just works. Three outcomes, and only three: the checkout exists
(run in it), the checkout is **missing** (run at the workspace root so the
prompt's GIT WORKFLOW can create it, then verify afterwards), or the item pins
no repo at all (run at the root). An item is **never** run in some other
existing checkout — dispatching into the wrong repo is worse than admitting the
gap.

|                       | `motir next` / `motir run`              | `motir auto`                                       | `motir batch`                                   |
| --------------------- | --------------------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| Work list             | one item                                | **live** — one `next_ready` per iteration          | **frozen** — the ready set snapshotted up front |
| Becomes ready mid-run | n/a                                     | picked up (the loop cascades the dependency graph) | **not** picked up — counted and named           |
| Git lineage           | none — the item's own branch off `main` | ONE session branch per repo, `motir/auto-<run-id>` | **none** — each item branches off `origin/main` |
| Pull requests         | one, opened by the agent                | ONE per repo, opened by the CLI at the end         | **one per item**, opened by the agent           |
| Close-out             | `motir done <key>`                      | `motir done --session <branch>` (bulk)             | `motir done <key>` (per item)                   |
| Agent required        | no (`--print` is the default)           | **yes**                                            | **yes**                                         |

**`motir batch` freezes the list and prints it before the first agent starts** —
so you can Ctrl-C out of a run you did not want while nothing has been touched.
A strictly main-ready snapshot is mutually independent by construction (an item
is in it only when every dependency is done **on main**), which is why it needs
no session branch: each item rides the per-item flow unchanged. An item that is
ready **only** because a dependency is integrated-awaiting-review is excluded
and named — that dependency's code is not on `main`, so a pull request of its
own could not even build. That lineage is `auto`'s territory.

**What both loops skip.** An unexpanded epic/story is a _planning_ item, not a
dispatchable one — there is no agent prompt for "do the planning" — so it is
skipped untouched under _needs planning_. A `type: manual` / `executor: human`
item is skipped the same way under _needs a human_. Neither is transitioned;
they are left exactly as the loop found them.

**`motir auto --include-planning`** turns the first of those into an action: the
CLI submits an AI expansion (`expand_item`), records it, and asks for the next
ready item **immediately**. It triggers; it never waits — the job's output is a
plan of **proposals**, and approving that plan in Motir is the only thing that
turns a proposal into a work item, so there is nothing here to wait _for_. The
item goes on the run's exclude list because it stays childless and would
otherwise be handed straight back. A failed expansion is **non-halting** (unlike
a failed agent): nothing in the run depended on it. Expansions spend the **AI
credits of the token owner**, which is why the flag is opt-in. There is no
`--include-planning` on `batch` — an expansion's output could never join a
frozen snapshot.

---

## Planning from the terminal

`motir plan` is the planning front door, not a dispatch command: it changes the
**plan** rather than implementing an item, which is why it takes no agent.

```sh
motir plan                                # resume the project-wide conversation
motir plan MOTIR-42                       # resume it anchored at MOTIR-42
motir plan "split the billing epic"       # one turn, submitted, proposals printed
motir plan MOTIR-42 "size these" --detach # anchored, submitted, ids returned
```

Leading `MOTIR-<n>` arguments **anchor** the conversation at those items; the
rest of the arguments are a turn.

**It is a conversation, and it is the same conversation the web app shows.** The
thread is persisted and resumable, addressed by its scope (the project, or the
project plus the anchor keys) — so a turn typed in the terminal appears in the
web planning panel and vice versa. One conversation, two surfaces.

Interactively, turns **accumulate** and nothing reaches the planner until you
submit:

```
/submit   send every turn on this thread as ONE change
/exit     leave; the thread and its turns stay saved
/help     this list
```

Two things follow, and they are the contracts to hold onto:

- **Appending is not submitting.** A turn is server-side the moment you press
  Enter, so `/exit`, Ctrl-D, or a crash can never lose one. Only `/submit`
  spends the token owner's AI credits.
- **A submit PROPOSES; it does not write your tree.** What comes back is a plan
  of **proposals** — approving it in Motir is what turns a proposal into a work
  item. Nothing the CLI prints means "created N items".

By default `motir plan` waits for the planner and prints the proposal tree;
`--detach` returns the job id, plan id, and a review URL instead. Non-interactive
invocations must pass the turn as text — `motir plan` with no text and no TTY is
refused up front, because a prompt nobody can answer is the one failure mode
with no diagnosis.

**It does not onboard a fresh project.** A project with no work items is refused
with a pointer at the web onboarding interview: generating a _first_ plan is a
guided discovery flow, and `motir plan` joins the conversation once there is a
tree to evolve. (`motir auto --include-planning` is the other planning trigger —
it fires an expansion for an unexpanded container mid-run, and produces
proposals the same way.)

Streams split the same way the rest of the CLI splits them: **stdout carries the
result** (the proposal tree, or the detached ids), **stderr carries the
conversation** — so `motir plan "…" > plan.txt` keeps the proposals and leaves
the chatter on your terminal.

---

## Session branches: what `motir auto` actually does

A run does **not** open a pull request per item. On the first item routed into a
given repo, the CLI creates ONE session branch there — `motir/auto-<run-id>`,
where the run id is a timestamp like `20260729-011830` — and every item's work
is integrated onto it. At the end the CLI surfaces **one pull request per repo**:
the run's single human review gate.

The branch is created **remotely**
(`git push origin refs/remotes/origin/main:refs/heads/<branch>`). The CLI never
checks out and never creates a local branch, so `motir auto` in a repo with a
dirty working tree is safe. Creation is idempotent: a re-run finds the branch
present and reuses it rather than rewinding the commits already on it.

**Statuses run ahead of `main`, deliberately.** An integrated item is recorded
with `mark_integrated` and moves to **In Review** — never Done. In Review is the
honest status: the work exists on the session branch, `main` does not have it,
and a human has not looked at it. That same recording is what makes the item's
dependents ready _mid-run_, which is how the loop cascades through the
dependency graph instead of stopping at whatever happened to be ready at second
zero. So between the run ending and your merge, the tenant shows a set of In
Review items whose code is not on `main`. That is the design, not drift.

**Nothing reaches Done without you.** The session branch carries no `MOTIR-<n>`
key in its name or its pull-request title — on purpose. Motir's status webhook
parses a PR's branch and title for a key, and a session PR carries _many_ items;
a key in either would link the whole run to one card and move only that one. The
keys ride in the PR **body**, which is not parsed. The real close-out is
explicit:

```sh
motir done --session motir/auto-20260729-011830
```

which walks every item recorded on that branch to Done in one call
(`complete_session`) and prints the per-item outcome.

### Why there is no auto-merge to `main`

Because the shipped close-out is a human's. `motir auto` runs entirely in
`workflowMode: 'session_lineage'`
([`packages/cli/src/commands/dispatch.ts`](../packages/cli/src/commands/dispatch.ts),
the `deliver()` branch that calls `mark_integrated` instead of transitioning
straight to In Review, and the `motir done --session` close-out below it). In
that mode the item's _best_ outcome — agent exited 0, work integrated, branch
pushed — is **In Review**. There is no code path anywhere in the CLI that merges
a pull request, advances `main`, or moves an item to Done on its own: the only
`done` write in the tool is the one you type. The prompt agrees with the CLI —
the session-lineage GIT WORKFLOW tells the agent to integrate into the session
branch and explicitly **not** to open a pull request of its own.

So the boundary is a property of the design rather than a setting: an unattended
loop can produce as much work as you let it, and every line of it still waits in
one reviewable pull request per repo. This document is the record of that
decision; there is no separate ADR for it.

### Unwinding a rejected run

If you don't want what a run produced, **don't run `motir done --session`** —
that is the only thing that would move those items to Done.

- The items stay **In Review** and the summary names every one with its branch,
  so nothing is lost track of.
- To redo one, `motir run <key>` re-dispatches it: the CLI moves it back to In
  Progress (a legal edge from In Review) and fetches a fresh prompt.
- To abandon the run, close the pull request and delete the branch on origin.
  Moving the items _backwards_ in the workflow is a web-app (or MCP
  `transition_status`) action — the CLI's only status writes are the dispatch
  flips and `motir done`, and it will not silently walk an item through a status
  you did not name.

---

## Failure policy

**A non-zero agent exit is an ordinary outcome, not a crash.** The item is left
**In Progress** — work was started and is half-done, so reverting it to To Do
would hide that — and **nothing is reverted** in the repo.

- The item is added to a persisted **session exclude list**
  (`~/.local/state/motir/session-excludes.json`, scoped per server + project), so
  the next `motir next` moves past it instead of re-picking the same failure.
  `--reset` clears the list; a later success (or `motir done`) drops that entry.
  It is a convenience, not a correctness mechanism — a failed item is already
  held out of the ready set by its `in_progress` status — so if that file cannot
  be written, Motir says so once and carries on rather than failing the run.
- `motir next` / `motir run` propagate the agent's own exit code, so a script
  wrapping them can tell a failed run from a successful one.
- `motir auto` and `motir batch` **halt** on the first failure by default;
  `--keep-going` finishes the rest.
- Either way the **end-of-run close-out still happens**: the branch is pushed
  and the pull request opened, so a late failure never abandons the work that
  already integrated.
- **Ctrl-C** stops between items (a second Ctrl-C exits immediately), then still
  lands the pull request and prints the summary.

**Exit codes.** `0` success · `1` any dispatch failed, or a user-facing error
(printed as one `Error:` line plus a `Hint:` on stderr) · `130` interrupted.
An unexpected internal error prints a stack — that distinction is deliberate: a
missing link is a CLI error, a programming bug is not.

**A bootstrap dispatch that produced no checkout is a failure**, not a success
with a warning: the prompt's whole job was to create that checkout, and every
later item routed at the repo would repeat the same bootstrap. The CLI names the
expected path and suggests `motir link add <repo> <path>` in case the repo
simply lives off-convention.

### Closing out

After you merge:

```sh
motir done MOTIR-42                    # per-item pull request (next / run / batch)
motir done --session <branch>          # a merged session pull request (auto)
```

The default workflow has **no direct `in_progress → done` edge**. An item the
CLI dispatched and watched finish is already In Review, so `motir done` is a
single legal hop. An item dispatched with `--print` — where Motir never observed
an agent finish — is still In Progress, and needs the hop named explicitly:

```sh
motir done --via in_review MOTIR-42
```

`--via` is opt-in and never inferred: the CLI does not walk an item through a
status you did not ask for. An illegal flip surfaces the server's own
allowed-targets error verbatim, plus that hint.

---

## Agent wiring

Which agent runs, in priority order: **`--agent <cmd>` → `MOTIR_AGENT` →
`agentCommand` in `~/.config/motir/config.json`**. The value is a full command
line; the first token is the binary Motir looks for on PATH.

**The prompt is delivered two ways at once**, because agent CLIs disagree about
how they take input:

- on **stdin**, for agents that read a piped prompt; and
- as **`$MOTIR_PROMPT_FILE`** — a path to a `0600` temp file — for agents that
  want `--prompt-file <path>`, or that re-exec themselves and lose stdin.

Supplying both means a new agent usually needs no Motir change at all. The child
inherits stdout/stderr, so its output **streams through live** — a coding-agent
run is minutes long, and a silent terminal is indistinguishable from a hang.

### Headless recipes

An unattended run needs the agent to stop asking for approval. These flags
**drift between releases** — run `<agent> --help` against the version you
actually have, and treat a mismatch as this table being stale.

```sh
motir auto --agent "claude --dangerously-skip-permissions"
motir auto --agent "codex exec --sandbox workspace-write --ask-for-approval never"
motir auto --agent "opencode run --auto"
motir auto --agent "kimi -p"
motir auto --agent "agy -p --dangerously-skip-permissions"        # Antigravity
motir auto --agent "agent -p --force"                             # Cursor
motir auto --agent "aider --yes-always"
GOOSE_MODE=auto motir auto --agent "goose run --no-session"
```

Set it once instead of per invocation:

```sh
export MOTIR_AGENT="claude --dangerously-skip-permissions"
motir doctor && motir auto --max 5
```

Any other agent works too — pass its own unattended flag and Motir launches it
unchanged. `motir doctor` still checks the binary; for an agent it does not have
a profile for, confirming the credential is yours.

### The copy-paste flow

No agent configured is a first-class mode, not a degraded one:

```sh
motir next --print                  # prompt on stdout, context on stderr
motir next --print | pbcopy         # copy the prompt alone
motir next --print > /tmp/task.md   # …or hand it to anything else
```

Paste it into your editor's agent, let it do the work and open the pull request,
then `motir done --via in_review <key>` once you merge.

---

## The sandbox

An unattended agent running with permissions bypassed is worth confining. Motir
publishes a container image for exactly that — `motir auto` in a normal console
stays **fully supported**; the container is the _recommended_ path, not a
requirement.

Pull and go — no checkout, no build:

```sh
docker run --rm -it \
  -v "$PWD:/workspace" \
  -e MOTIR_TOKEN -e MOTIR_SERVER \
  -v "$HOME/.claude:/home/node/.claude:ro" \
  ghcr.io/moooon-b-v/motir-sandbox:claude \
  motir auto --agent "claude --dangerously-skip-permissions"
```

The host contract is a **writable** `/workspace` (your `.motir.json` tree — the
only host path the agent can change) and a **read-only** mount of your agent's
own credential. Run it from your **workspace root**, not from inside a single
checkout — `motir auto` dispatches across every repo in the workspace.

**The Motir credential has three routes in, and the mount is no longer the only
one.** `MOTIR_TOKEN` / `MOTIR_SERVER` are read by every command, so a fresh
machine or a CI runner that never ran a host login gets in with two environment
variables and no host state at all. With no mount, `~/.config/motir` inside the
container is writable — so `motir login`, headless by construction, runs in
there too. Mounting a host credential still works and is still read-only:

```sh
  -v "$HOME/.config/motir:/home/node/.config/motir:ro"   # optional
```

An env credential outranks a mounted one and is never written to disk.

There is one tag per agent profile (`claude`, `codex`, `opencode`, `kimi`,
`antigravity`, `cursor`, `aider`, `goose`) plus an agent-less `base`, built for
linux/amd64 + linux/arm64. `:<profile>` moves with each release;
`:<profile>-<version>` is immutable. **Pin the digest for anything you need to
reproduce** — the digest table is filled in from each `cli-v*` release run, and
the registry is always the authority:

```sh
docker buildx imagetools inspect ghcr.io/moooon-b-v/motir-sandbox:claude
```

**Building it yourself** stays supported, and is the path to take when you are
customising a profile, adding an agent, or running an unreleased commit — as it
is today, before the first `cli-v*` tag publishes the images. The build context
is the motir-core repo root:

```sh
docker build -f packages/cli/sandbox/Dockerfile --build-arg AGENT=claude \
  -t motir-sandbox:claude .
```

A locally built image runs exactly like a pulled one — same mounts, same
entrypoint, only the image reference changes. Compose and dev-container forms
ship alongside it.

**What it confines, and what it does not.** The filesystem blast radius is
confined to the mounts above (no docker socket, no other host bind) and the
container runs as the unprivileged `node` user, so files land owned by you.
**Network egress is open by design** — every coding agent needs its provider
API, and every dispatched item needs git remotes plus the Motir server; reach
for docker's own `--network` controls if your threat model needs more.

Full detail — the profile matrix, per-agent credential mounts, the CodeGraph
wiring, and the CI/publish lanes —
[`packages/cli/sandbox/README.md`](../packages/cli/sandbox/README.md).

---

## Files and environment

Motir keeps exactly **two** files, and only one holds a secret:

| Path                           | What                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `~/.config/motir/config.json`  | **Secret — never commit.** The credential store, `chmod 600` inside a `0700` dir, keyed by server URL. Also `agentCommand`. |
| `.motir.json` (workspace root) | **No secret — safe to commit.** The link: server, workspace, project, plus the optional `repos` override map.               |

A third file, `~/.local/state/motir/session-excludes.json`, holds the
failed-dispatch exclude list (ids and keys of your own project — no secret). It
is **state, not a credential**, so it lives in the state home rather than beside
the PAT: the sandbox image mounts the config dir read-only, which would leave the
CLI no writable state directory at all. Setting `MOTIR_CONFIG_HOME` still moves
it too, so one relocation continues to move the whole CLI state.

Seven environment variables, none required — each overrides a default
(`motir help environment` prints this from the shipped code):

| Variable            | Overrides                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `MOTIR_TOKEN`       | The PAT, honoured by **every** command. Set it and there is no login step and no file. Outranks a stored credential.   |
| `MOTIR_SERVER`      | Which server to talk to. Chain: `--server` > this > `.motir.json` > the single stored server > `https://app.motir.co`. |
| `MOTIR_AGENT`       | The agent command. Precedence: `--agent` > `MOTIR_AGENT` > `agentCommand` in config.                                   |
| `MOTIR_CONFIG_HOME` | Where `motir/config.json` lives. Highest-precedence config home; also the second-choice state home.                    |
| `XDG_CONFIG_HOME`   | The config home when `MOTIR_CONFIG_HOME` is unset (else `~/.config`).                                                  |
| `MOTIR_STATE_HOME`  | Where `motir/session-excludes.json` lives. Chain: this > `MOTIR_CONFIG_HOME` > `XDG_STATE_HOME` > `~/.local/state`.    |
| `XDG_DATA_HOME`     | Motir stores nothing here — `doctor` reads it only to find where _your agent_ keeps its credential.                    |

`motir doctor` probes your agent's own key variables (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `CURSOR_API_KEY`) for **presence** and never reads a value.

---

## Troubleshooting

**`motir login` printed a code but no browser opened.** That is a supported
outcome, not a failure — the launch is additive and the printed code and URL are
sufficient on their own. Open the URL on any device, sign in, and enter the code;
the terminal is still waiting. Pass `--no-browser` to skip the attempt entirely
on a box you know is headless.

**`Error: The code expired before it was approved.`** — codes last 15 minutes.
Nothing was written, so there is nothing to clean up: run `motir login` again for
a fresh one.

**`Error: Approval was denied. No credential was written.`** — someone (possibly
you, on the wrong request) pressed Deny at `/device`. Nothing was created, so
there is nothing to revoke. If that request was not yours, it means someone had
your code — start a fresh `motir login` and approve only a code you are looking
at in your own terminal.

**`Error: Could not write the credential to <path>.`** — the config directory is
read-only. The sandbox image mounts it that way deliberately, since a container
consumes a credential rather than minting one. Either make the directory
writable, point `MOTIR_CONFIG_HOME` at one that is, or skip the file entirely
with `MOTIR_TOKEN` — the environment tier is never written to disk.

**`Error: <server> refused to start a login (HTTP 404).`** — that server predates
`motir login`. Use the paste path instead: `motir auth login --token <pat>`.

**`Error: Token invalid or expired.`** — the token was revoked, expired, or
never stored for this server. Every unauthorized MCP response maps to this one
error with the same hint; the CLI does not guess which of the four it was
(matching the server's uniform 401). Reconnect with `motir login`, or store a
fresh PAT with `motir auth login`. `motir auth status` tells you which token the
CLI is holding for a server — and which source it came from — without exposing
it.

**`Error: No Motir project link found in this directory or any parent.`** — you
are outside the linked tree. Run `motir link` at your workspace root, or `cd`
into it. Remember the lookup walks **upward** only: a sibling directory of the
root is not covered.

**`MOTIR-42 is not ready. Waiting on: …`** — readiness is dependency-only, so
the message names the open blockers (and an ancestor that is itself blocked). If
you know a blocker is about to merge, override it deliberately:
`motir run MOTIR-42 --force`. This is a refusal rather than a silent decision on
purpose.

**`Suspect dispatch: the agent exited 0 but "<repo>" still has no checkout at
<path>.`** — a bootstrap dispatch did not produce its checkout. Usually the repo
lives off-convention: `motir link add <repo> <path>` and re-run. If the agent
genuinely failed to scaffold, `motir run <key>` re-dispatches it.

**`motir next` says "No ready work items" but the board disagrees.** Check for
the skip line above it: previously-failed items are held out via the exclude
list. `motir next --reset` clears it and retries them. Also confirm `--kinds`
isn't narrowing the set, and that the token's user can actually see the project
(`motir doctor`).

**`` `motir auto` needs an agent to run. ``** — an unattended loop cannot run in
`--print` mode. Pass `--agent "<cmd>"`, set `MOTIR_AGENT`, or configure
`agentCommand`; `motir doctor` verifies it before the run.

**`` `motir plan` needs a terminal to converse in. ``** — a non-interactive
invocation with no turn text would sit on a prompt nobody can answer. Pass the
turn as an argument: `motir plan "<what to change>"`, plus `--detach` to skip
the wait.

**`<PROJECT> has no work items yet — there is no plan here to change.`** — the
project has never been planned. `motir plan` evolves an existing tree; the first
plan comes from the web onboarding interview the hint links to.

**A `transition_status` failure naming allowed targets.** The workflow refused
the move. For a merged item still sitting In Progress, that is the missing In
Review hop: `motir done --via in_review <key>`.

**The agent binary can't be launched (ENOENT).** That is a setup problem, not a
failed piece of work, so it stops the run rather than being recorded as a failed
item. `motir doctor` diagnoses it and names the profile's install source.

---

## See also

- [`docs/mcp.md`](./mcp.md) — the tool surface the CLI consumes: minting a PAT,
  token scopes, and every MCP tool with its input/output shape.
- [`packages/cli/README.md`](../packages/cli/README.md) — the package's own
  reference: toolchain decisions, module layout, and the two test lanes.
- [`packages/cli/sandbox/README.md`](../packages/cli/sandbox/README.md) — the
  sandbox image in full: profile matrix, credential mounts, CodeGraph, CI.
- **`/ready`** in the web app — the human mirror of `motir ready`, with an
  in-app help popover explaining what makes an item ready.
