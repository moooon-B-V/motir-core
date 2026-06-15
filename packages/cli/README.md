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
```

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
