# The Motir sandbox image

The confined container an unattended `motir auto` run executes in, instead of a
skip-permissions coding agent loose on your host. This is the shape of the dev
sandbox Motir itself is built in.

Running `motir auto` in a normal console stays **fully supported** — the
container is the _recommended_ path, not a requirement.

> **Status (Subtask 7.9.7b).** The base image (Node ≥ 24.15, git, `gh`, the
> `motir` binary, the `AGENT` build-arg selector) shipped in 7.9.7a; this slice
> fills its per-agent layer seam with the **profile matrix** below — eight
> selectable coding agents, each with its own credential mount. The build/smoke
> CI matrix lands in 7.9.7c, `codegraph` in 7.9.7d, and the published GHCR image
> in 7.9.7e. Until 7.9.7c, the profiles are **built and version-checked at image
> build time** (each install layer smoke-tests its own binary) but not yet
> exercised end-to-end by CI.

## What it confines — and what it does not

|                |                                                                                                                                                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Filesystem** | Confined. The only host surfaces inside the container are a writable `/workspace` (your `.motir.json` tree) and a **read-only** `~/.config/motir` (the PAT). No docker socket, no other host bind.                                                                            |
| **Network**    | **Open, by design.** Every coding agent needs its provider API, and every dispatched item needs git remotes plus the Motir server. This image confines the filesystem blast radius, not egress — reach for docker's own `--network` controls if your threat model needs more. |
| **Privileges** | Runs as the unprivileged `node` user (uid 1000), so files written into the mount stay owned by you rather than by root.                                                                                                                                                       |

The PAT mount is read-only because the container _consumes_ a credential and
never mints or rotates one: run `motir auth login` on the **host**.

## Build

The build context is the motir-core repo **root** (the image builds the `motir`
binary from your checkout — `@motir/cli` is not on npm yet):

```sh
docker build -f packages/cli/sandbox/Dockerfile -t motir-sandbox:base .
```

## Run

The entrypoint drops into `/workspace`, so a full unattended run is a one-liner:

```sh
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$HOME/.config/motir:/home/node/.config/motir:ro" \
  -v "$HOME/.claude:/home/node/.claude:ro" \
  motir-sandbox:claude motir auto --agent "claude --dangerously-skip-permissions"
```

Run it from your **workspace root** (the directory holding `.motir.json`), not
from inside a single checkout — `motir auto` dispatches across every repo in the
workspace. With no command, you get an interactive shell in `/workspace`
instead.

> The `base` image ships **no** coding agent, so `motir auto --agent …` has
> nothing to launch there. Use it for `motir next --print` workflows — the
> entrypoint keeps stdout clean, so piping the prompt straight out of
> `docker run` works — and run your agent on the host. For an unattended loop,
> build one of the agent profiles below.

## Compose

Each profile is its own service, gated behind a compose profile of the same
name, so you build and run exactly the variant you asked for:

```sh
cd packages/cli/sandbox
docker compose --profile codex build
docker compose --profile codex run --rm sandbox-codex \
  motir auto --agent "codex exec --sandbox workspace-write --ask-for-approval never"
```

`MOTIR_WORKSPACE=/path/to/workspace` overrides which host directory is mounted
as `/workspace`; the default is the parent of this motir-core checkout.

## Dev container

`devcontainer/devcontainer.json` is the VS Code / `devcontainer` CLI variant of
the **base** image, and `devcontainer/<profile>/devcontainer.json` is the same
thing per agent — same `/workspace` folder, same read-only PAT mount, the
profile's `AGENT` build arg plus that agent's own read-only credential mount:

```sh
devcontainer up --workspace-folder . \
  --config packages/cli/sandbox/devcontainer/claude/devcontainer.json
```

To use one for your own workspace, copy the file to
`<your-workspace>/.devcontainer/devcontainer.json` and repoint `build.context` /
`build.dockerfile` at your motir-core checkout. Once 7.9.7e publishes the image,
the whole `build` block collapses to a pinned `"image": "ghcr.io/…"`.

## Selecting an agent (`AGENT`)

`--build-arg AGENT=<profile>` selects which coding agent is layered on the base.
The profile ids are the ones in
[`src/agentProfiles.ts`](../src/agentProfiles.ts) — plus the default `base`,
which installs none. The selector lives in the Dockerfile; the layers it selects
live in [`install-agent.sh`](./install-agent.sh)'s case block.

```sh
docker build -f packages/cli/sandbox/Dockerfile \
  --build-arg AGENT=claude -t motir-sandbox:claude .
```

Motir is **BYOK and agent-agnostic**: these profiles make the popular CLIs
first-class, they do not make Motir depend on any of them. Nothing here
redistributes an agent — each layer fetches the third-party CLI from its
**official source at build time**, under that project's own licence. An agent
that is not listed still works via the tier-3 escape hatch below.

## The profile matrix

Tier 1 is first-class: install source **and** credential location are pinned.
Tier 2 is also-supported, with the credential path pinned only where the vendor
documents one.

| Profile       | Tier | Installed from                                                        | Binary                         | Credential mount (read-only)                           |
| ------------- | ---- | --------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------ |
| `claude`      | 1    | npm `@anthropic-ai/claude-code`                                       | `claude`                       | `~/.claude`                                            |
| `codex`       | 1    | npm `@openai/codex` (Apache-2.0)                                      | `codex`                        | `~/.codex`                                             |
| `opencode`    | 1    | npm `opencode-ai` (MIT)                                               | `opencode`                     | `~/.config/opencode` **and** `~/.local/share/opencode` |
| `kimi`        | 1    | npm `@moonshot-ai/kimi-code` (MIT)                                    | `kimi`                         | `~/.kimi-code`                                         |
| `antigravity` | 2    | `curl -fsSL https://antigravity.google/cli/install.sh \| bash`        | `agy`                          | — (OS keyring; see below)                              |
| `cursor`      | 2    | `curl https://cursor.com/install -fsS \| bash`                        | `agent` (alias `cursor-agent`) | `~/.local/share/cursor-agent`                          |
| `aider`       | 2    | PyPI `aider-chat` in a venv (Apache-2.0)                              | `aider`                        | `~/.aider.conf.yml` + a model key from the env         |
| `goose`       | 2    | `curl -fsSL …/goose/releases/download/stable/download_cli.sh \| bash` | `goose`                        | `~/.config/goose`                                      |

### Auto-approve flags — VERIFIED, not remembered

An unattended run needs the agent to stop asking for approval, and **these flags
drift between releases**. Every entry below was re-checked against the vendor's
CURRENT documentation while writing this matrix; **re-verify before trusting one,
and treat a mismatch as the doc being stale, not the agent being broken.** Run
`<agent> --help` in the built image — that is the version you are actually
running.

| Profile       | Non-interactive                 | Auto-approve                                                                                                                       |
| ------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `claude`      | `-p` / `--print`                | `--dangerously-skip-permissions` (equivalent to `--permission-mode bypassPermissions`)                                             |
| `codex`       | `codex exec`                    | `--sandbox workspace-write --ask-for-approval never`; full bypass is `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`) |
| `opencode`    | `opencode run "<prompt>"`       | `--auto` ("auto-approve permissions that are not explicitly denied")                                                               |
| `kimi`        | `-p` / `--prompt`               | none needed — `-p` already runs under the `auto` permission policy; interactively, `--yolo`                                        |
| `antigravity` | `-p` / `--print` / `--prompt`   | `--dangerously-skip-permissions`                                                                                                   |
| `cursor`      | `-p` / `--print`                | `--force` (alias `--yolo`) — without it, print mode only _proposes_ edits                                                          |
| `aider`       | `--message "<prompt>"` (`-m`)   | `--yes-always`                                                                                                                     |
| `goose`       | `goose run --no-session -t "…"` | `GOOSE_MODE=auto` — an **environment variable**, not a flag (`approve`/`smartapprove` refuse to run non-interactively)             |

> ⚠️ **`codex --full-auto` is deprecated upstream** and prints a warning; the
> card that planned this matrix still listed it as verified. Use `codex exec`
> with an explicit sandbox + approval policy instead. This is exactly why the
> flags are re-verified rather than carried forward.

So a full unattended run looks like:

```sh
docker compose --profile claude run --rm sandbox-claude \
  motir auto --agent "claude --dangerously-skip-permissions"
```

### Credentials

Every profile mounts its agent's credential path **read-only**, for the same
reason the Motir PAT is read-only: the container _consumes_ a credential and
never mints or rotates one. **Sign in on the host first**, then run the
container.

Three consequences worth knowing before you hit them:

- **The host path must exist.** Docker materialises a missing bind source as a
  root-owned empty directory, which then shadows the agent's own config. Sign in
  on the host (or `mkdir`/`touch` the path) before the first run — this applies
  especially to `aider`, whose mount is a single `~/.aider.conf.yml` **file**.
- **An agent that writes session state into its credential directory will fail
  to.** Claude Code and Kimi keep history/session data alongside their
  credentials, so a read-only mount makes those writes fail. Point the agent's
  state at the writable container home when it supports that (e.g. Kimi's
  `KIMI_CODE_HOME`), or drop `:ro` for that one profile if you accept the wider
  blast radius. Making this ergonomic per agent is 7.9.7c's smoke-matrix work.
- **`antigravity` mounts nothing, on purpose.** `agy` stores its token in the OS
  keyring (Keychain / Secret Service / Credential Manager) and documents no
  portable file, so there is nothing honest to mount — guessing a path would
  create an empty root-owned directory on your host. Authenticate _inside_ the
  container: the CLI detects a non-local shell and prints a copy-paste
  authorization URL. `goose` has the same keyring default, but it falls back to
  a file-based `secrets.yaml` in its config dir, which the profile sets
  `GOOSE_DISABLE_KEYRING=1` to force.

### Not shipped: Gemini CLI

There is **no `gemini` profile**, deliberately. Google's Gemini CLI is retired
and Antigravity CLI (`agy`) is its mandated replacement, so the sunset tool is
absent from the matrix rather than merely non-default. The sandbox test asserts
it stays absent.

### Tier 3 — any other agent

An agent not in the matrix is still supported, unchanged: build the base image
and give `motir auto` the full command.

```sh
docker compose --profile base run --rm sandbox \
  motir auto --agent "<your-cli> <its-unattended-flag>"
```

If the agent needs to be _inside_ the image, add a case arm to
`install-agent.sh` and a service to `docker-compose.yml` — that is the whole
extension surface. Adding it to `AGENT_PROFILES` without an arm fails the
sandbox test rather than silently falling through to "unknown AGENT".

## Files

| File                             | What it is                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                     | The base image: Node floor assertion, git + `gh`, the packed `motir` binary, the `AGENT` selector, the unprivileged user and the `/workspace` entrypoint. |
| `install-agent.sh`               | The per-agent layer seam invoked by the `AGENT` build arg — one case arm per profile, each smoke-testing the binary it installs.                          |
| `entrypoint.sh`                  | Verifies the mounts, drops into `/workspace`, `exec`s your command. All output on stderr so stdout stays pipe-clean.                                      |
| `docker-compose.yml`             | The compose form — one service + compose profile per agent, each with its credential mount.                                                               |
| `devcontainer/devcontainer.json` | The dev-container form of the base image.                                                                                                                 |
| `devcontainer/<profile>/`        | The dev-container form of each agent profile.                                                                                                             |

Their invariants (the read-only PAT mount, the absence of a docker socket, the
Node floor, the seam covering every agent profile) are asserted by
[`test/sandbox.test.ts`](../test/sandbox.test.ts).
