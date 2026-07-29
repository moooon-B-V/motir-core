# The Motir sandbox image

The confined container an unattended `motir auto` run executes in, instead of a
skip-permissions coding agent loose on your host. This is the shape of the dev
sandbox Motir itself is built in.

Running `motir auto` in a normal console stays **fully supported** — the
container is the _recommended_ path, not a requirement.

> **Status (Subtask 7.9.7c).** The base image (Node ≥ 24.15, git, `gh`, the
> `motir` binary, the `AGENT` build-arg selector) shipped in 7.9.7a; 7.9.7b
> filled its per-agent layer seam with the **profile matrix** below — eight
> selectable coding agents, each with its own credential mount; 7.9.7d added
> **CodeGraph** (the binary, the per-agent MCP wiring, and the index + git sync
> hooks), which 7.9.7f kept clear of the read-only credential mounts. This slice
> adds the **validation harness**: every pull request now
> builds each profile, runs its liveness check, asserts the confinement claims
> against the real mount table, and drives `motir auto` end-to-end inside the
> image with a fake agent (see [Validation](#validation)). The published GHCR
> image is 7.9.7e.

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

## CodeGraph — the agent's own navigation graph

The image ships [CodeGraph](https://github.com/colbymchenry/codegraph) (the
engine the 7.5.3 spike selected) so the agent inside the container can ask
`callers` / `impact` / `explore` / `search` about the code it is editing instead
of grepping its way around an unfamiliar repo. Telemetry is off
(`CODEGRAPH_TELEMETRY=0`).

> ⚠️ This is the **coding agent's own per-container graph**, not `motir-ai`'s
> planner code graph (7.5.4). Same engine, different consumer, different store —
> nothing here talks to `motir-ai`.

Three moving parts:

1. **The binary**, in the base image — `codegraph --version` works in every
   profile, agent or not.
2. **The MCP server, wired per agent at build time** — `codegraph install
--target <id> --yes`, which also writes the auto-allow list so an unattended
   agent can call the tools instead of stopping to ask.
3. **The entrypoint**, which indexes the mounted `/workspace` on start and
   installs a `post-merge` + `post-checkout` git hook running `codegraph sync`,
   so the graph stays current as the branch advances.

### Which profiles get the MCP wiring

CodeGraph installs into the agents **it** has a target for — `claude`, `cursor`,
`codex`, `opencode`, `hermes`, `gemini`, `antigravity`, `kiro`. Five of the eight
profiles here intersect that set; the other three are left explicitly unwired
rather than pointed at a near-miss id (the same "leave it UNKNOWN rather than
guess" rule the credential column follows).

| Profile       | codegraph target | Config the agent actually reads                                         |
| ------------- | ---------------- | ----------------------------------------------------------------------- |
| `claude`      | `claude`         | `~/.claude.json` + `~/.claude/settings.json`                            |
| `codex`       | `codex`          | `~/.motir-sandbox/agent-config/.codex/config.toml` (redirected, below)  |
| `opencode`    | `opencode`       | `~/.motir-sandbox/agent-config/.config/opencode/opencode.jsonc` (ditto) |
| `cursor`      | `cursor`         | `~/.cursor/mcp.json`                                                    |
| `antigravity` | `antigravity`    | `~/.gemini/antigravity/mcp_config.json`                                 |
| `kimi`        | — none           | not wired                                                               |
| `aider`       | — none           | not wired (Aider is not an MCP client)                                  |
| `goose`       | — none           | not wired (no `goose` target in codegraph)                              |

The two redirected rows are why the next section exists: codegraph's own default
for them (`~/.codex/config.toml`, `~/.config/opencode/opencode.jsonc`) falls
inside that agent's read-only credential mount.

### When the credential mount would mask the wiring (7.9.7f)

For `codex` and `opencode` the config file above lives _inside_ the directory the
compose/dev-container form mounts read-only from the host — so the host's copy
shadowed the one the image built in, and those two agents saw no codegraph tools
at all under the recommended compose path.

Both are now pointed at a config home the **image** owns,
`~/.motir-sandbox/agent-config`, which sits outside every mounted path and so can
never be shadowed. The credential mounts are unchanged; nothing needs dropping.

| Profile    | Env var the entrypoint exports | Mechanism                                                                                                                                                                                                               |
| ---------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex`    | `CODEX_HOME`                   | `CODEX_HOME` governs `config.toml` **and** `auth.json`, so the redirected home is SEEDED from the read-only mount (credential + your own `config.toml` come along) and codegraph then MERGES its stanza into that copy. |
| `opencode` | `OPENCODE_CONFIG`              | `OPENCODE_CONFIG` is MERGED over the global config rather than replacing it, so your mounted `~/.config/opencode` still applies and no credential is copied at all. Auth lives in the XDG **data** dir, untouched.      |

Every value in that table was **verified against the real CLIs** — codex 0.146.0,
opencode 1.18.9, codegraph 1.5.0, each run against a scratch home with the
credential directory made unwritable to stand in for the `:ro` mount — not read
off their documentation. That is the same "leave an unverified third-party path
UNKNOWN rather than guess it" rule the credential column follows.

Two notes on the seam:

- **The codex seed copies a credential to a second path inside the container.**
  That widens nothing: the container could always read the mounted file. What the
  read-only mount guarantees — that the container cannot WRITE the host's copy —
  still holds.
- **`MOTIR_SANDBOX_CODEGRAPH=0` skips the redirect too**, along with the rest of
  the block, leaving each agent on its own default config exactly as before.

`claude`, `cursor` and `antigravity` never needed this — their MCP **server**
config sits outside the mounted path. One narrower gap remains for `claude`: the
auto-allow permission list `--yes` writes (`~/.claude/settings.json`) IS inside
its mount, so the agent has the codegraph tools but stops to ask before calling
them in an unattended run. It is declared in the profile table
(`codegraphConfig.knownAutoAllowGap`), asserted by `test/sandbox.test.ts` rather
than left silent, and tracked as **MOTIR-1840**.

The entrypoint keeps its stderr warning as a backstop for any config path that is
still unwritable; it should no longer fire for a supported profile.

### Escape hatch

`MOTIR_SANDBOX_CODEGRAPH=0` skips indexing, hook installation and the wiring
refresh entirely — useful for a `--print`-only workflow or a build-matrix smoke
test. Nothing in this step can fail a run: the graph is an enhancement to how
well the agent reads the repo, never a precondition for doing the work, so every
step warns to stderr and carries on.

The hooks are written into `.git/hooks` (or `core.hooksPath`) of `/workspace` and
of each repository one level below it. They are **never** written over a hook you
already have, and because `.git/hooks` is untracked they outlive the container in
your host repo — so each one self-guards: with no `codegraph` on `PATH` it is a
silent no-op, and it always exits 0 so it can never fail a merge or a checkout.

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

## Validation

Two CI jobs (`.github/workflows/ci.yml`) run on every pull request. They are the
reason the claims on this page can be believed rather than merely written down.

### `Sandbox smoke (loop + confinement)`

Builds the base image, then starts it with **exactly** the mount recipe from
[Run](#run) and executes two suites inside it:

- **`confinement.sh`** — asserts the blast radius against `/proc/self/mounts`,
  the ground truth: `/workspace` is the one writable host bind, every credential
  bind is `ro`, **no other host path is mounted at all**, the container is
  unprivileged, and there is no docker socket or docker client. It also proves
  the system tree (`/`, `/etc`, `/usr/local/*`, `/opt`, `/var`) is not writable
  by the user the agent runs as.

  > **What "writes outside `/workspace` fail" does and does not mean.** `$HOME`
  > and `/tmp` **are** writable inside the container — every coding agent writes
  > caches, logs and sessions there, and an image that forbade it would run no
  > agent at all. Those writes are confined because they land in the container's
  > ephemeral layer and die with `--rm`, not because permissions stop them. The
  > host-blast-radius claim is the mount-table one, and that is what is asserted.

- **`loop-smoke.sh`** — runs `motir auto --agent <fake-agent>` end to end with
  **no LLM, no Motir deployment, no Postgres and no network**: a zero-dependency
  stub MCP server scripts the ready set, a fake agent does the integration, and
  every MCP call is recorded so `assert-run.mjs` can check the SEQUENCE — one
  `next_ready` per iteration (never a batch read-ahead), each item flipped to In
  Progress before its prompt is fetched, each dispatched with the run's session
  branch as the seed, each recorded through `mark_integrated` on that branch, and
  exactly ONE pull request at the end. A run that exited 0 having skipped
  `mark_integrated` fails this test.

Run it yourself — it needs nothing but docker:

```sh
packages/cli/sandbox/smoke/run.sh            # build + smoke
packages/cli/sandbox/smoke/run.sh --keep     # keep the fixture for inspection
```

### `Sandbox profile <id>`

One leg per profile, read from `smoke/profiles.json`: `docker build
--build-arg AGENT=<id>` from a clean checkout, then `motir --version` **and** the
agent's own liveness check, run in the finished image as the unprivileged `node`
user — which is what catches an installer that landed its binary somewhere only
root can reach.

**Tier 1 gates; Tier 2 is allow-fail.** Tier-2 installers pull from vendor
endpoints Motir does not control, so a network flake there must not put a red X
on an unrelated pull request — but the leg still runs and is still reported, so a
profile that broke for real still gets noticed.

## Files

| File                             | What it is                                                                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                     | The base image: Node floor assertion, git + `gh`, the packed `motir` binary, the CodeGraph engine, the `AGENT` selector, the unprivileged user and the `/workspace` entrypoint.                                                                                     |
| `install-agent.sh`               | The per-agent layer seam invoked by the `AGENT` build arg — one case arm per profile, each smoke-testing the binary it installs and wiring the codegraph MCP server where codegraph has a target.                                                                   |
| `entrypoint.sh`                  | Verifies the mounts, redirects the two agents whose codegraph config a `:ro` mount would mask, indexes `/workspace` with CodeGraph and installs its git sync hooks, drops into `/workspace`, `exec`s your command. All output on stderr so stdout stays pipe-clean. |
| `docker-compose.yml`             | The compose form — one service + compose profile per agent, each with its credential mount.                                                                                                                                                                         |
| `devcontainer/devcontainer.json` | The dev-container form of the base image.                                                                                                                                                                                                                           |
| `devcontainer/<profile>/`        | The dev-container form of each agent profile.                                                                                                                                                                                                                       |
| `smoke/run.sh`                   | The validation driver: build the image, run it through the documented mount recipe, execute both in-container suites.                                                                                                                                               |
| `smoke/confinement.sh`           | The blast-radius assertions, read from `/proc/self/mounts` rather than from this page.                                                                                                                                                                              |
| `smoke/loop-smoke.sh`            | `motir auto --agent <fake-agent>` end to end inside the image — builds its own git fixture, needs no LLM and no server.                                                                                                                                             |
| `smoke/stub-server.mjs`          | A zero-dependency streamable-HTTP MCP server scripting the ready set, recording every call.                                                                                                                                                                         |
| `smoke/fake-agent.sh`            | The scripted agent: verifies the prompt arrived on BOTH delivery channels, integrates onto the session branch, exits 0.                                                                                                                                             |
| `smoke/assert-run.mjs`           | Asserts the recorded MCP call SEQUENCE — the thing an exit code cannot tell you.                                                                                                                                                                                    |
| `smoke/profiles.json`            | The CI build/liveness matrix: one entry per profile, read by the workflow so adding an agent extends CI on its own.                                                                                                                                                 |

The image sources' invariants (the read-only PAT mount, the absence of a docker
socket, the Node floor, the seam covering every agent profile, the codegraph
wiring and its sync hooks) are asserted by
[`test/sandbox.test.ts`](../test/sandbox.test.ts); the validation harness itself
is guarded against drift by
[`test/sandboxCi.test.ts`](../test/sandboxCi.test.ts).
