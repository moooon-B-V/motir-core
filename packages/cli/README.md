# `@motir/cli` — the `motir` command-line tool

Terminal dispatch of the Motir work loop. The CLI is an **MCP client** of the
Motir server (`/api/mcp`): every command speaks Model Context Protocol to the
tenant with a personal access token (PAT) as a bearer credential. There is no
parallel REST path — if the CLI needs a capability it lands as an MCP tool
first, then the CLI consumes it (story 7.9 architecture).

> **Status (Subtask 7.9.1):** this is the scaffold + auth + link layer. Read
> commands (`ready` / `status` / `open` — 7.9.2), single dispatch (`next` /
> `run` / `done` — 7.9.3), and the loop (`auto` / `batch` — 7.9.4+) land on the
> same `commander` program as their subtasks ship.

## Toolchain (the 7.9.1 evaluate-and-record decision)

- **CLI framework: [`commander`](https://github.com/tj/commander.js).** Chosen
  over `yargs` for its smaller surface, first-class subcommand tree (`motir auth
login`, `motir link add`), native async actions (`parseAsync`), and built-in
  `--help`/`--version`. yargs’ middleware/coercion power isn’t needed here.
- **Bundler: [`tsup`](https://tsup.egoist.dev) (esbuild under the hood).** A
  zero-config TS→ESM bundler that emits a single `dist/index.js` with the
  `#!/usr/bin/env node` shebang baked in (the `bin` entry). We use tsup rather
  than raw esbuild only to skip hand-writing the build script; the engine is the
  same esbuild the rest of the toolchain already trusts.
- **Runtime:** Node ≥ 22, ESM (`"type": "module"`).

## Install (in-repo — 7.9 distribution)

Publishing `@motir/cli` to npm is Epic-8 work (gated on securing the Motir
name). For now, install from the checkout:

```sh
pnpm --filter @motir/cli build      # produces dist/index.js (the `motir` binary)
# then run it directly, or `pnpm --filter @motir/cli exec motir …`
node packages/cli/dist/index.js --help
```

## Commands (this subtask)

```sh
motir auth login   [--server <url>] [--token <pat>]   # validate + store a PAT
motir auth status  [--server <url>]                   # server, token prefix, owning user
motir auth logout  [--server <url>]                   # forget the stored token

motir link [--server <url>] [--workspace <slug>] [--project <key>] [--repo <name>]
motir link add <repo> <path>                          # add a checkout-path override
motir link remove <repo>                              # remove an override

motir doctor [--agent <cmd>] [--json]                 # BYOK preflight (read-only)
```

## Dispatch — `motir next` / `motir run` / `motir done` (7.9.3)

```sh
motir next [--kinds <list>] [--print | --agent <cmd>] [--reset]
motir run <key> [--print | --agent <cmd>] [--force]
motir done <key> [--via <status>]
motir done --session <branch>
```

`next` picks the next ready item; `run` takes an explicit key. Both then follow
the same pipeline:

```
select → transition_status(in_progress) → dispatch_prompt → deliver
```

**The prompt is generated SERVER-SIDE** (`dispatch_prompt`, MOTIR-1802) and
printed byte-identical. The CLI never assembles prompt text, so every harness —
Claude Code, Codex, opencode, or a human reading it — receives the same
instruction and the grammar versions with the product.

**Two delivery modes.** `--print` (the default, and what you get whenever no
agent is configured) writes the prompt to **stdout** and everything else to
**stderr**, so `motir next --print | pbcopy` copies the prompt alone while you
still see the target repo and resolved path on screen. `--agent "<cmd>"` — or
`MOTIR_AGENT`, or `agentCommand` in the user config, in that precedence — runs
your agent on it, handing the prompt over **both** stdin **and**
`$MOTIR_PROMPT_FILE` (a 0600 temp file), streaming its output through live.

**Repo routing.** The dispatch payload names the item's repo (`targetRepo`);
the CLI maps that name to a checkout via the `.motir.json` override map or the
`<root>/<repoName>` convention, and runs the agent there — so dispatching a
`motir-ai` item while standing in `motir-core` just works. If the checkout is
**missing**, the agent runs at the workspace root so the prompt's GIT WORKFLOW
can create it, and the CLI verifies afterwards (reporting a suspect dispatch
with a `motir link add` hint if it did not appear). An item is **never** run in
some other existing checkout — an unpinned item falls back to the root.

**After the agent exits.** Exit 0 lands the item at **In Review**: a per-item-PR
item via `transition_status`, a session-lineage item via `mark_integrated` on
its inherited branch. A non-zero exit leaves the item **In Progress** (work was
started — nothing is reverted), propagates the agent's exit code, and records
the item in the session exclude list so the next `motir next` moves past it;
`--reset` clears that list.

**Closing out.** After you merge, `motir done <key>`. The default workflow has
no direct `in_progress → done` edge, so an item dispatched with `--print` (which
never observed an agent finish) needs `motir done --via in_review <key>`; an
illegal flip surfaces the server's own allowed-targets error verbatim. A merged
**session** PR closes out in bulk with `motir done --session <branch>`.

## The loop — `motir auto` (7.9.4)

```sh
motir auto --agent "<cmd>" [--kinds <list>] [--max <n>] [--keep-going] [--reset]
```

Drain the ready set unattended. Each iteration asks the server for **exactly one**
item and runs it through the same single-dispatch pipeline as `motir next`, then
loops; the run ends when the server has nothing ready left. It never fetches the
ready list up front — the set CHANGES while the run executes, because integrating
one item unlocks its dependents, so the loop **cascades through the dependency
graph** rather than draining a snapshot. An agent is required (`--agent`,
`MOTIR_AGENT`, or the configured `agentCommand`); `--print` has nobody to paste
for and is refused with guidance.

**One session branch, one pull request.** The run opens `motir/auto-<run-id>` on
`origin` in each repo it dispatches into — lazily, on that repo's first item, and
without touching your working tree or creating a local branch. Every item's work
is integrated onto it and recorded with `mark_integrated`, which moves the item to
**In Review** (never Done — `main` does not have the work yet) and is also what
makes its dependents ready mid-run. At the end the CLI surfaces **one pull request
per repo**: the run's single human review gate. **`main` is never auto-advanced**,
by the CLI or by the prompt.

After you merge that pull request, close the whole run out with
`motir done --session motir/auto-<run-id>`. A rejected pull request leaves the
items honestly In Review — the summary names every one of them with its branch.

**What it skips, and why.** An unexpanded epic/story in the ready set is a
_planning_ item, not a dispatchable one — there is no agent prompt for "do the
planning" — so the loop skips it untouched and lists it under _needs planning_
(`--include-planning`, which instead triggers its expansion, is 7.9.8). A
`type: manual` / `executor: human` item is skipped the same way, under _needs a
human_.

**When an agent fails** the run halts by default and the item is left In Progress
with nothing reverted; `--keep-going` finishes the rest instead. Either way the
end-of-run push and pull request still happen, so a late failure never abandons
the work that already integrated. `--max <n>` caps the dispatches. Ctrl-C stops
between items (or terminates the agent mid-run), then still lands the pull
request and prints the summary.

## Help + topics

`motir`, `motir help` and `motir --help` all print the same curated overview on
**stdout** and exit **0** — the front door a newcomer reads top to bottom:

```
Usage: motir [options] [command]

SETUP COMMANDS:      auth · link · doctor
READ COMMANDS:       ready · status · open
WORK LOOP COMMANDS:  next · run · done
HELP TOPICS:         help · environment · files
FLAGS:               -v, --version · -h, --help
EXAMPLES:            …
LEARN MORE:          …
```

Commands are grouped with commander's native `.helpGroup()` (see `src/help.ts`);
group ORDER is the registration order in `src/program.ts`. **A command
registered without an explicit group falls into `ADDITIONAL COMMANDS`**, so a
later subtask adds a command — and, with one `.helpGroup(...)` line, files it
under `SETUP` / `READ` / `WORK LOOP COMMANDS` — without ever rewriting the help
surface. (7.9.3 was the first to exercise that: `next` / `run` / `done` joined
the reserved work-loop group with one line each, and `auto` / `batch` will do
the same.)

Two **topics** answer what a command list cannot:

```sh
motir help environment   # the 4 env vars Motir reads, and what each overrides
motir help files         # ~/.config/motir/config.json + .motir.json
```

Per-command help is unchanged (`motir help <command>`, `motir <command> --help`,
nested: `motir help auth login`, `motir link add --help`). An unknown topic
fails like every other CLI error — one line plus a hint on **stderr**, exit
**1**, no stack trace — so `motir help | head` stays clean for piping.

## `motir doctor` — the BYOK preflight

Motir is **BYOK**: you bring your own coding agent and your own model key. So
before `motir next` / `motir auto`, `motir doctor` answers "is my setup
correct?" in one read-only pass instead of letting a missing agent or an
unsigned-in key surface halfway through a dispatch:

| Check                   | PASS means                                                   | FAIL means                                                                       |
| ----------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **Auth**                | the stored PAT connects, lists tools, and identifies you     | no token, or it is invalid/expired → `motir auth login`                          |
| **Project link**        | `.motir.json` resolved (walking up from the cwd)             | no link here or above → `motir link`                                             |
| **Workspace + project** | the linked project is reachable _for this token_             | wrong key, or your user is not a member                                          |
| **Repo checkouts**      | every override path resolves                                 | — (a not-yet-cloned **convention** path is fine, and only WARNs for an override) |
| **Coding agent**        | the binary is on PATH and answers `--version`                | it is not on PATH → the profile's install source                                 |
| **Agent credential**    | the agent's credential dir exists, or its key env var is set | neither → where to sign in                                                       |

It exits **non-zero** when any hard check fails, so `motir doctor && motir auto`
is a usable gate. `--json` emits the same report machine-readably. WARN rows
never fail the run — "no agent configured" is a warning, because `motir next
--print` hands you the prompt for an agent Motir never launches.

**Which agent gets checked**, in priority order: `--agent <cmd>` → the
`MOTIR_AGENT` env var → `agentCommand` in the user config. The value is a full
command line (`claude --dangerously-skip-permissions`); the first token is the
binary Motir looks for.

**It never reads your secret.** The credential check asks only whether a path
EXISTS or an env var is SET — the engine has no way to obtain a file's contents
or an env var's value, so nothing sensitive can be printed or logged. Nor does
`doctor` write anything: its only server calls are the handshake, `whoami`, and
a one-row search that proves the project is reachable.

**Known agent profiles** (the sandbox matrix, 7.9.7b) — Tier 1 pins both the
install source and the credential mount: `claude` (`~/.claude`), `codex`
(`~/.codex`), `opencode` (`~/.config/opencode`), `kimi`. Tier 2 —
`antigravity`, `cursor`, `aider`, `goose` — pins the install source only; where
those keep credentials is deliberately **not guessed**, so they report a WARN
("verify this one yourself") rather than a false FAIL. Any other agent works
too (`--agent "<cmd> <flag>"`): its binary is still checked, its credential is
yours to confirm.

### Config files

- **`~/.config/motir/config.json`** (XDG-respecting; override with
  `MOTIR_CONFIG_HOME`) — the credential store, `chmod 600`. The PAT lives here
  and **only** here. Keyed by server URL so one machine can hold tokens for
  several servers.
- **`.motir.json`** at the workspace root — the project link: `{ serverUrl,
workspace, project, repos? }`. Contains **no secret**, so it is safe to
  commit. Repo checkouts resolve by **convention** (`<root>/<repoName>`); the
  optional `repos` map carries overrides only. Commands resolve `.motir.json`
  by walking **upward** from the cwd, so any command works from inside any
  checkout under the root. An **empty folder is first-class** — bind and go; the
  first scaffold work items create the checkouts.

## Tests

```sh
pnpm --filter @motir/cli test       # package-local unit tests (no server, no DB)
```

`test/auto.test.ts` drives the whole `motir auto` loop against a scripted server,
agent and git, because its load-bearing properties — that it re-queries every
iteration, that an integrated item unlocks its dependents mid-run, that `main` is
never advanced, and that the pull request opens even when the run ended badly —
are not visible in any single function.

The full integration suite — the built binary driven against a live MCP
endpoint with a fake agent — is Subtask 7.9.5, which also wires this package
into the coverage gate.
