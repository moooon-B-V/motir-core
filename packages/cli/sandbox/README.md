# The Motir sandbox image

The confined container an unattended `motir auto` run executes in, instead of a
skip-permissions coding agent loose on your host. This is the shape of the dev
sandbox Motir itself is built in.

Running `motir auto` in a normal console stays **fully supported** — the
container is the _recommended_ path, not a requirement.

> **Status (Subtask 7.9.7e).** The base image (Node ≥ 24.15, git, `gh`, the
> `motir` binary, the `AGENT` build-arg selector) shipped in 7.9.7a; 7.9.7b
> filled its per-agent layer seam with the **profile matrix** below — eight
> selectable coding agents, each with its own credential mount; 7.9.7d added
> **CodeGraph** (the binary, the per-agent MCP wiring, and the index + git sync
> hooks); 7.9.7c added the **validation harness** — every pull request builds
> each profile, runs its liveness check, asserts the confinement claims against
> the real mount table, and drives `motir auto` end-to-end inside the image with
> a fake agent (see [Validation](#validation)). This slice **publishes** it: the
> smoke-tested images go to GHCR on a `cli-v*` tag, so adopting the sandbox is a
> `docker run`, not a `git clone` (see [Publishing](#publishing)).

## Run

Pull and go — no checkout, no build:

```sh
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$HOME/.config/motir:/home/node/.config/motir:ro" \
  -v "$HOME/.claude:/home/node/.claude:ro" \
  ghcr.io/moooon-b-v/motir-sandbox:claude \
  motir auto --agent "claude --dangerously-skip-permissions"
```

Three mounts, and they are the whole host contract:

| Mount                      | Why                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `$PWD:/workspace`          | Writable. Your `.motir.json` tree — the only host path the agent can change.                                 |
| `$HOME/.config/motir:…:ro` | Read-only. The Motir PAT: `motir auth login` runs on the **host**, the container only consumes the result.   |
| `$HOME/.claude:…:ro`       | Read-only. The agent's own credential — swap it for your profile's row in [the matrix](#the-profile-matrix). |

Run it from your **workspace root** (the directory holding `.motir.json`), not
from inside a single checkout — `motir auto` dispatches across every repo in the
workspace. With no command, you get an interactive shell in `/workspace`
instead.

> The `base` image ships **no** coding agent, so `motir auto --agent …` has
> nothing to launch there. Use it for `motir next --print` workflows — the
> entrypoint keeps stdout clean, so piping the prompt straight out of
> `docker run` works — and run your agent on the host. For an unattended loop,
> pull one of the agent profiles below.

## Published images

`ghcr.io/moooon-b-v/motir-sandbox`, one tag per profile plus the agent-less
base, built for **linux/amd64 + linux/arm64** (Apple Silicon is a first-class
BYOK dev machine). Each tag exists in two forms:

- `:<profile>` — **moving**. Points at the latest release. Convenient, not
  reproducible.
- `:<profile>-<version>` — **immutable**, where `<version>` is the
  [`@motir/cli`](../package.json) version the image was cut from, so the `motir`
  inside the image and the one on npm are the same build.

**Pin the digest for anything you need to reproduce.** A moving tag is not a
sandbox you can re-enter — the same argument 7.9.7a makes for the base image:

```sh
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$HOME/.config/motir:/home/node/.config/motir:ro" \
  -v "$HOME/.claude:/home/node/.claude:ro" \
  ghcr.io/moooon-b-v/motir-sandbox@sha256:<digest> \
  motir auto --agent "claude --dangerously-skip-permissions"
```

| Tag                                            | Digest                                 |
| ---------------------------------------------- | -------------------------------------- |
| `ghcr.io/moooon-b-v/motir-sandbox:base`        | _no release published yet — see below_ |
| `ghcr.io/moooon-b-v/motir-sandbox:claude`      | _no release published yet — see below_ |
| `ghcr.io/moooon-b-v/motir-sandbox:codex`       | _no release published yet — see below_ |
| `ghcr.io/moooon-b-v/motir-sandbox:opencode`    | _no release published yet — see below_ |
| `ghcr.io/moooon-b-v/motir-sandbox:kimi`        | _no release published yet — see below_ |
| `ghcr.io/moooon-b-v/motir-sandbox:antigravity` | _no release published yet — see below_ |
| `ghcr.io/moooon-b-v/motir-sandbox:cursor`      | _no release published yet — see below_ |
| `ghcr.io/moooon-b-v/motir-sandbox:aider`       | _no release published yet — see below_ |
| `ghcr.io/moooon-b-v/motir-sandbox:goose`       | _no release published yet — see below_ |

The digests are filled in from the release run's job summary at each `cli-v*`
tag (see [Publishing](#publishing)) — this table is the record, but it is a
transcription, so the registry is always the authority:

```sh
docker buildx imagetools inspect ghcr.io/moooon-b-v/motir-sandbox:claude
```

## What it confines — and what it does not

|                |                                                                                                                                                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Filesystem** | Confined. The only host surfaces inside the container are a writable `/workspace` (your `.motir.json` tree) and a **read-only** `~/.config/motir` (the PAT). No docker socket, no other host bind.                                                                            |
| **Network**    | **Open, by design.** Every coding agent needs its provider API, and every dispatched item needs git remotes plus the Motir server. This image confines the filesystem blast radius, not egress — reach for docker's own `--network` controls if your threat model needs more. |
| **Privileges** | Runs as the unprivileged `node` user (uid 1000), so files written into the mount stay owned by you rather than by root.                                                                                                                                                       |

The PAT mount is read-only because the container _consumes_ a credential and
never mints or rotates one: run `motir auth login` on the **host**.

> **The CLI's own mutable state does not live beside the PAT.** The session
> exclude list (the ids `motir auto` skips after a failed agent) resolves from
> `MOTIR_STATE_HOME` → `MOTIR_CONFIG_HOME` → `XDG_STATE_HOME` →
> `~/.local/state/motir` — deliberately NOT the read-only config dir, which
> would give the CLI no writable state directory at all inside this image. That
> is not a hypothetical: it used to live there, and the write on the failure
> path aborted whole runs before their close-out (MOTIR-1836). Inside the
> container `~/.local/state` is the ephemeral layer, so the list is per-run;
> mount a writable path and point `MOTIR_STATE_HOME` at it if you want it to
> survive `--rm`. Nothing is lost if you don't — the list only avoids
> re-picking an item that just failed, and a failed item is already held out of
> the ready set by its status. If the store is unwritable wherever it lands, the
> CLI says so once and carries on.

## Build it yourself

Everything below still works from a checkout — that is the path to take when you
are **customising a profile**, adding an agent, or running the image off an
unreleased commit. The build context is the motir-core repo **root** (the image
builds the `motir` binary from your checkout):

```sh
docker build -f packages/cli/sandbox/Dockerfile -t motir-sandbox:base .
```

A locally built image runs exactly like a pulled one — same mounts, same
entrypoint; only the image reference changes:

```sh
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$HOME/.config/motir:/home/node/.config/motir:ro" \
  -v "$HOME/.claude:/home/node/.claude:ro" \
  motir-sandbox:claude motir auto --agent "claude --dangerously-skip-permissions"
```

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
`build.dockerfile` at your motir-core checkout — **or** drop the whole `build`
block and pin the published image instead, which needs no checkout at all:

```jsonc
{
  "image": "ghcr.io/moooon-b-v/motir-sandbox@sha256:<digest>",
  // …the same mounts / workspaceFolder the committed file carries
}
```

The committed files keep the `build` block because they are the _repo's_ dev
containers, and a checkout is exactly what those are for.

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

| Profile       | codegraph target | Config the image writes                      |
| ------------- | ---------------- | -------------------------------------------- |
| `claude`      | `claude`         | `~/.claude.json` + `~/.claude/settings.json` |
| `codex`       | `codex`          | `~/.codex/config.toml`                       |
| `opencode`    | `opencode`       | `~/.config/opencode/opencode.jsonc`          |
| `cursor`      | `cursor`         | `~/.cursor/mcp.json`                         |
| `antigravity` | `antigravity`    | `~/.gemini/antigravity/mcp_config.json`      |
| `kimi`        | — none           | not wired                                    |
| `aider`       | — none           | not wired (Aider is not an MCP client)       |
| `goose`       | — none           | not wired (no `goose` target in codegraph)   |

> **Known interaction — a `:ro` credential mount can mask the wiring.** For
> `codex` and `opencode` the config file above lives _inside_ the directory the
> compose/dev-container form mounts read-only from the host, so at run time the
> host's copy shadows the one the image built in and the agent sees no codegraph
> tools. The entrypoint detects this and says so on stderr rather than leaving it
> silent; `claude`, `cursor` and `antigravity` are unaffected (their config sits
> outside the mounted path). Drop that agent's `:ro` mount to restore the tools.
> Tracked as a follow-up against the 7.9.7b mount contract.

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

The build/smoke matrix lives in `.github/workflows/sandbox-images.yml` and runs
on every pull request (`ci.yml` calls it). It is the reason the claims on this
page can be believed rather than merely written down — and, because
[Publishing](#publishing) calls the very same workflow, it is also the release
gate: the push step is a later step of the job that just proved the image works,
so an image no smoke test touched cannot reach the registry.

### `Sandbox smoke (loop + failure + confinement)`

Builds the base image, then starts it with **exactly** the mount recipe from
[Run](#run) and executes three suites inside it:

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

- **`failure-smoke.sh`** — the same loop with an agent that **fails** partway
  through, which the happy path structurally cannot cover: the exclude store is
  only written on the failure path, so only a failing agent, under the real
  read-only credential mount, exercises it. It asserts that a run which
  integrated work and _then_ hit a failing agent still pushes its branch and
  opens its ONE pull request, reporting the failed item — the case
  `closeOutRepos` exists to guarantee and that MOTIR-1836 broke. Two legs: one
  with the state home writable (the store lands in `~/.local/state/motir` and
  the credential mount is never touched), one with `MOTIR_STATE_HOME` forced
  back onto the read-only mount (the run still closes out, warning instead of
  dying).

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

**Tier 1 gates; Tier 2 is allow-fail — on the pull-request lane.** Tier-2
installers pull from vendor endpoints Motir does not control, so a network flake
there must not put a red X on an unrelated pull request — but the leg still runs
and is still reported, so a profile that broke for real still gets noticed. **On
the release lane every tier gates**: a release that quietly shipped six of eight
images, green, is worse than one that failed.

## Publishing

`.github/workflows/release-sandbox.yml`, on a `cli-v<x.y.z>` **tag** — the same
tag that releases [`@motir/cli`](../package.json) to npm, so the binary in the
image and the published package are the same version by construction. There is
deliberately no push-to-`main` trigger: a `:latest` that moves on every merge is
not a sandbox anyone can reproduce a run in.

```sh
# 1. bump packages/cli/package.json `version`, open + merge the PR
# 2. tag the merge commit
git tag cli-v0.2.0 && git push origin cli-v0.2.0
```

The tag fires the guard (tag version must equal `packages/cli/package.json`), then
the [validation](#validation) matrix with its push steps on, then a
**post-deploy verification** job that pulls every image back **by digest** and
runs `motir --version` in it — because "the push exited 0" and "a user can pull
this and run it" are different claims. That job's summary prints the digest
table; paste it into [Published images](#published-images).

Auth is the workflow's own `GITHUB_TOKEN` under a `packages: write` permission
block, granted on the release lane only. **No repository secret, no registry
account, nothing provisioned out of band** — and the pull-request lane, which has
no such block, cannot push even if it tried.

Four things worth knowing before your first release:

- **Package visibility.** A GHCR package starts private. After the first
  successful release, make it public once at
  `https://github.com/orgs/moooon-B-V/packages/container/motir-sandbox/settings`,
  or the `docker run` at the top of this page will ask a stranger for
  credentials.
- **`workflow_dispatch` with `dry_run: true`** runs the whole lane without
  pushing — how to validate a change to the release path without minting a
  version.
- **What "arm64 works" is actually backed by.** The runner is amd64, so that is
  the arch the liveness and smoke checks EXECUTE. The arm64 half is built under
  QEMU, where each install arm still runs its own `<agent> --version` at build
  time — a strong build-time check, not a run-time one. An agent whose vendor
  ships no arm64 binary therefore fails the RELEASE build rather than shipping a
  broken arm64 layer.
- **A Tier-2 vendor can block a release, on purpose.** Since every tier gates
  here, a vendor endpoint that is down at tag time fails the run. Re-run the
  failed job once the vendor recovers (the guard is idempotent — re-tagging is
  not needed), or drop that profile from `smoke/profiles.json` and
  `AGENT_PROFILES` if it is gone for good. Do not "fix" it by publishing a
  partial set: the verification job fails on a missing digest precisely so a
  short release cannot pass as a complete one.

Not in scope here, deliberately: signing / SBOM / provenance attestation (a real
hardening concern, and its own decision — half of it would be worse than none),
and the **hosted** run image, which is 9.1.3 / 9.1.4's separate registry.

## Files

| File                             | What it is                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                     | The base image: Node floor assertion, git + `gh`, the packed `motir` binary, the CodeGraph engine, the `AGENT` selector, the unprivileged user and the `/workspace` entrypoint.                   |
| `install-agent.sh`               | The per-agent layer seam invoked by the `AGENT` build arg — one case arm per profile, each smoke-testing the binary it installs and wiring the codegraph MCP server where codegraph has a target. |
| `entrypoint.sh`                  | Verifies the mounts, indexes `/workspace` with CodeGraph and installs its git sync hooks, drops into `/workspace`, `exec`s your command. All output on stderr so stdout stays pipe-clean.         |
| `docker-compose.yml`             | The compose form — one service + compose profile per agent, each with its credential mount.                                                                                                       |
| `devcontainer/devcontainer.json` | The dev-container form of the base image.                                                                                                                                                         |
| `devcontainer/<profile>/`        | The dev-container form of each agent profile.                                                                                                                                                     |
| `smoke/run.sh`                   | The validation driver: build the image, run it through the documented mount recipe, execute both in-container suites.                                                                             |
| `smoke/confinement.sh`           | The blast-radius assertions, read from `/proc/self/mounts` rather than from this page.                                                                                                            |
| `smoke/loop-smoke.sh`            | `motir auto --agent <fake-agent>` end to end inside the image — builds its own git fixture, needs no LLM and no server.                                                                           |
| `smoke/failure-smoke.sh`         | The failure path: an agent that dies mid-run must still cost nothing — the branch is pushed and the pull request opened, with the store writable and unwritable.                                  |
| `smoke/stub-server.mjs`          | A zero-dependency streamable-HTTP MCP server scripting the ready set, recording every call.                                                                                                       |
| `smoke/fake-agent.sh`            | The scripted agent: verifies the prompt arrived on BOTH delivery channels, integrates onto the session branch, exits 0.                                                                           |
| `smoke/failing-agent.sh`         | The scripted agent that refuses ONE named item and delegates the rest — so the run has real integrated work behind it when the failure lands.                                                     |
| `smoke/assert-run.mjs`           | Asserts the recorded MCP call SEQUENCE — the thing an exit code cannot tell you.                                                                                                                  |
| `smoke/profiles.json`            | The CI build/liveness matrix: one entry per profile, read by the workflow so adding an agent extends CI on its own.                                                                               |

Two workflow files sit outside this directory: the build/smoke/publish matrix
itself, `.github/workflows/sandbox-images.yml`, and the tagged release lane that
calls it with publishing on, `.github/workflows/release-sandbox.yml`.

The image sources' invariants (the read-only PAT mount, the absence of a docker
socket, the Node floor, the seam covering every agent profile, the codegraph
wiring and its sync hooks) are asserted by
[`test/sandbox.test.ts`](../test/sandbox.test.ts); the validation harness and the
release lane are guarded against drift by
[`test/sandboxCi.test.ts`](../test/sandboxCi.test.ts).
