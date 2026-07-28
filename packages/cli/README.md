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

The full integration suite — the built binary driven against a live MCP
endpoint with a fake agent — is Subtask 7.9.5, which also wires this package
into the coverage gate.
