# The Motir sandbox image

The confined container an unattended `motir auto` run executes in, instead of a
skip-permissions coding agent loose on your host. This is the shape of the dev
sandbox Motir itself is built in.

Running `motir auto` in a normal console stays **fully supported** — the
container is the _recommended_ path, not a requirement.

> **Status (Subtask 7.9.7a).** This is the BASE image: Node ≥ 24.15, git, `gh`
> and the `motir` binary, with the `AGENT` build-arg selector and its per-agent
> layer seam stood up but **no coding agent installed**. The per-agent install
> layers land in 7.9.7b, the build/smoke CI matrix in 7.9.7c, `codegraph` in
> 7.9.7d, and the published GHCR image in 7.9.7e.

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
  motir-sandbox:base motir auto --agent "<your agent command>"
```

Run it from your **workspace root** (the directory holding `.motir.json`), not
from inside a single checkout — `motir auto` dispatches across every repo in the
workspace. With no command, you get an interactive shell in `/workspace`
instead.

> The base image ships no coding agent, so `motir auto --agent …` has nothing to
> launch yet. Until 7.9.7b lands, use the base for `motir next --print`
> workflows — the entrypoint keeps stdout clean, so piping the prompt straight
> out of `docker run` works — and run your agent on the host.

## Compose

```sh
cd packages/cli/sandbox
docker compose --profile base build
docker compose --profile base run --rm sandbox motir auto --agent "<cmd>"
```

`MOTIR_WORKSPACE=/path/to/workspace` overrides which host directory is mounted
as `/workspace`; the default is the parent of this motir-core checkout.

## Dev container

`devcontainer/devcontainer.json` is the VS Code / `devcontainer` CLI variant of
the same image — same `/workspace` folder, same read-only PAT mount, same
`AGENT` build arg:

```sh
devcontainer up --workspace-folder . --config packages/cli/sandbox/devcontainer/devcontainer.json
```

To use it for your own workspace, copy the file to
`<your-workspace>/.devcontainer/devcontainer.json` and repoint `build.context` /
`build.dockerfile` at your motir-core checkout. Once 7.9.7e publishes the image,
the whole `build` block collapses to a pinned `"image": "ghcr.io/…"`.

## Selecting an agent (`AGENT`)

`--build-arg AGENT=<profile>` selects which coding agent is layered on the base.
The profile ids are the ones in
[`src/agentProfiles.ts`](../src/agentProfiles.ts) — `claude`, `codex`,
`opencode`, `kimi` (tier 1) and `antigravity`, `cursor`, `aider`, `goose` (tier 2) — plus the default `base`, which installs none.

The selector lives in the Dockerfile; the layers it selects live in
[`install-agent.sh`](./install-agent.sh)'s case block, which 7.9.7b fills in.
Until then, `base` is the only profile that builds — a known-but-unbuilt profile
is refused with an explicit message rather than producing an image that claims
an agent it does not have.

## Files

| File                             | What it is                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                     | The base image: Node floor assertion, git + `gh`, the packed `motir` binary, the `AGENT` selector, the unprivileged user and the `/workspace` entrypoint. |
| `install-agent.sh`               | The per-agent layer seam invoked by the `AGENT` build arg.                                                                                                |
| `entrypoint.sh`                  | Verifies the mounts, drops into `/workspace`, `exec`s your command. All output on stderr so stdout stays pipe-clean.                                      |
| `docker-compose.yml`             | The compose form — one profile per agent variant.                                                                                                         |
| `devcontainer/devcontainer.json` | The dev-container form of the same image.                                                                                                                 |

Their invariants (the read-only PAT mount, the absence of a docker socket, the
Node floor, the seam covering every agent profile) are asserted by
[`test/sandbox.test.ts`](../test/sandbox.test.ts).
