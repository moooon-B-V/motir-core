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
> hooks), which 7.9.7f + 7.9.7g keep clear of the read-only credential mounts;
> 7.9.7c added the **validation harness** — every pull request builds
> each profile, runs its liveness check, asserts the confinement claims against
> the real mount table, and drives `motir auto` end-to-end inside the image with
> a fake agent (see [Validation](#validation)). This slice **publishes** it: the
> smoke-tested images go to GHCR on a `cli-v*` tag, so adopting the sandbox is a
> `docker run`, not a `git clone` (see [Publishing](#publishing)). MOTIR-1877
> then closed the last thing that still needed a prior host login: the
> credential mount is **optional**, `MOTIR_TOKEN` / `MOTIR_SERVER` are honoured
> everywhere, and `motir login` runs inside the container (see
> [the three ways](#three-ways-to-give-it-a-motir-credential)) — reaching the
> **published** image only with `cli-v0.1.1`, the current release (MOTIR-2131;
> see [Published images](#published-images)).

## Run

> **Setting it up for the first time?** The published guide at
> **<https://app.motir.co/docs/sandbox>** is the first ten minutes — pick a profile,
> start the container, `motir login`, `motir link`, `motir doctor` — and needs no
> checkout. This README is the reference for everything past that.

Pull and go — no checkout, no build, and no prior host login:

```sh
docker run --rm -it \
  -v "$PWD:/workspace" \
  -e MOTIR_TOKEN -e MOTIR_SERVER \
  -v "$HOME/.claude:/home/node/.claude:ro" \
  ghcr.io/moooon-b-v/motir-sandbox:claude \
  motir auto --agent "claude --dangerously-skip-permissions"
```

One required mount, one optional one, and the agent's own:

| Mount / variable               | Why                                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `$PWD:/workspace`              | **Required, writable.** Your `.motir.json` tree — the only host path the agent can change.                                                      |
| `MOTIR_TOKEN` / `MOTIR_SERVER` | The Motir credential, from the environment. Needs no host state at all, so it is the CI / fresh-machine / published-image path.                 |
| `$HOME/.config/motir:…:ro`     | **Optional**, read-only. A credential you already have on this host — an alternative to the two variables above, not a requirement (see below). |
| `$HOME/.claude:…:ro`           | Read-only. The agent's own credential — swap it for your profile's row in [the matrix](#the-profile-matrix).                                    |

Run it from your **workspace root** (the directory holding `.motir.json`), not
from inside a single checkout — `motir auto` dispatches across every repo in the
workspace. With no command, you get an interactive shell in `/workspace`
instead.

### Three ways to give it a Motir credential

The container needs a token for your Motir server. It has the same three tiers
the CLI has anywhere else — the resolution ladder is
`MOTIR_TOKEN` → the stored config — and all three work in here (MOTIR-1877):

1. **`-e MOTIR_TOKEN -e MOTIR_SERVER`** — pass them through from your shell.
   `GH_TOKEN` / `GH_HOST` one-for-one. Nothing is mounted, nothing is written to
   disk, and it is the only tier a CI runner or a brand-new machine can use.
   Mint the token in Motir under **Settings → Account → API tokens**.
2. **`motir login`, inside the container** — a device grant: it prints a code and
   a URL, you approve it in a browser on any device, and the container polls
   until the token is minted. Headless by construction, which is exactly what a
   container is. **This needs the credential mount to be ABSENT** — with no bind
   over it, `~/.config/motir` inside the container is writable and the login
   persists for the container's life (and dies with `--rm`, like the rest of the
   ephemeral layer).
3. **`-v "$HOME/.config/motir:/home/node/.config/motir:ro"`** — mount a
   credential you already have. Read-only, because a container that mounts one
   _consumes_ it and never mints or rotates it. This is the convenient path on
   the laptop you already ran `motir login` on.

With none of them, the entrypoint says so on **stderr** and names all three
before anything fails deeper in.

> **An environment credential does not widen the blast radius.** It is a variable
> in one process tree, not a host path, so the mount table — the thing
> [confinement](#what-it-confines--and-what-it-does-not) is actually asserted
> against — is one entry SHORTER than it used to be. The smoke lane proves both
> halves: the mount-free legs run with only `/workspace` bound, and the
> confinement suite still refuses any host bind beyond the documented ones.

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
  -e MOTIR_TOKEN -e MOTIR_SERVER \
  -v "$HOME/.claude:/home/node/.claude:ro" \
  ghcr.io/moooon-b-v/motir-sandbox@sha256:<digest> \
  motir auto --agent "claude --dangerously-skip-permissions"
```

Every release keeps its own table below, newest first, and older ones are never
edited: a moving `:claude` is a pointer, but `:claude-0.1.0` and the digest
beside it are a promise about specific bytes, and [Public, and asserted to
be](#public-and-asserted-to-be-motir-2010) tells a story that reads on the
`cli-v0.1.0` rows in particular. Overwriting a release's digests in place would
quietly change what an earlier paragraph is talking about.

The digests are filled in from the release run's job summary at each `cli-v*`
tag (see [Publishing](#publishing)) — these tables are the record, but they are
a transcription, so the registry is always the authority:

```sh
docker buildx imagetools inspect ghcr.io/moooon-b-v/motir-sandbox:claude
```

### Release `cli-v0.1.1`

([run 30966874373](https://github.com/moooon-B-V/motir-core/actions/runs/30966874373)).
Each row's immutable twin — `:<profile>-0.1.1` — points at the same manifest, and
the moving `:<profile>` tags point here too: this is the current release. Every
digest below differs from its `cli-v0.1.0` row, which is the whole point of the
release — see [Current, and asserted to
be](#current-and-asserted-to-be-motir-2131).

| Tag                                            | Digest                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/moooon-b-v/motir-sandbox:base`        | `sha256:f58990cf375dbe35c746f57e44bf47430f16089d4d21b0528f94e251358fe21a` |
| `ghcr.io/moooon-b-v/motir-sandbox:claude`      | `sha256:aabc233887475ef147e24beb8f0703964e516087a2fc0988c7b87f470df0dfcc` |
| `ghcr.io/moooon-b-v/motir-sandbox:codex`       | `sha256:a39149a096900db72a39bc5d012284a09e9481aade9f573a3751f6a4cdb71532` |
| `ghcr.io/moooon-b-v/motir-sandbox:opencode`    | `sha256:dda49f319f7b29b392996e0cba7ed81afa7c6018067bbce7c963e2a83b2d04a0` |
| `ghcr.io/moooon-b-v/motir-sandbox:kimi`        | `sha256:74b43a68481927a908dd0e84bb7e664d395d7bec34eea630e8667286e1caf6f4` |
| `ghcr.io/moooon-b-v/motir-sandbox:antigravity` | `sha256:f1a826c558a1eaf299b10256d7ce8250be35e7c17a648017d0b14d90fb6aec91` |
| `ghcr.io/moooon-b-v/motir-sandbox:cursor`      | `sha256:20e6ed2c3781b590a0e465e6bb7731da5d82319a2ee08affc37d6254c3eee8c0` |
| `ghcr.io/moooon-b-v/motir-sandbox:aider`       | `sha256:1ae5866f83e9c36bfbb1ae2cd5f07dc0bbbc5013081e25cdfab2e7e8c360308b` |
| `ghcr.io/moooon-b-v/motir-sandbox:goose`       | `sha256:f9fdbbcf3588dda3b84cb3e975f5c654d8d0e45558b0350776f73f36ccbccb41` |

### Release `cli-v0.1.0`

([run 30547054641](https://github.com/moooon-B-V/motir-core/actions/runs/30547054641)).
Each row's immutable twin — `:<profile>-0.1.0` — points at the same manifest.

| Tag                                            | Digest                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/moooon-b-v/motir-sandbox:base`        | `sha256:292289b41e97acc93f8f336ca31d4146a25941036e0199ca8e5e9e931262066e` |
| `ghcr.io/moooon-b-v/motir-sandbox:claude`      | `sha256:be09575019378b707e229808a7d832f063afe6515dfe325371cf4b13f85362be` |
| `ghcr.io/moooon-b-v/motir-sandbox:codex`       | `sha256:f1212309ebbd945cfb9cff398565e78f77225472defece899ccf311d0cbef0e6` |
| `ghcr.io/moooon-b-v/motir-sandbox:opencode`    | `sha256:9a1f012847795029ffe5b015f320fc1485e658cd693adbd33bcad0e6b580ba4b` |
| `ghcr.io/moooon-b-v/motir-sandbox:kimi`        | `sha256:e0aec4f3908fb64e60bda93ce260e0f598f6c7a502b3bb764aef5dc0f5cdc561` |
| `ghcr.io/moooon-b-v/motir-sandbox:antigravity` | `sha256:3e0a1e5600ec86b9f7583f918be5ee5445caf75da85210b8bcf6abfd51be8496` |
| `ghcr.io/moooon-b-v/motir-sandbox:cursor`      | `sha256:0955c69d320cc26af0882cc93205f2d38ac82770b963cec5076d714666d17b3c` |
| `ghcr.io/moooon-b-v/motir-sandbox:aider`       | `sha256:dfbb31dd911a27b48d910a273a93980c5ff510c197b1c98de8130d6845265c9c` |
| `ghcr.io/moooon-b-v/motir-sandbox:goose`       | `sha256:57d6e0e0024f3e8f57490d7e782e3745e7e399f5f1f1bd5f5af0a26fc49f38ac` |

### Public, and asserted to be (MOTIR-2010)

**No `docker login`, no token, no org membership.** The package is public, which
is what makes the `docker run` at the top of this file a real instruction rather
than an instruction-shaped sentence.

That is worth stating because it was once false and nothing noticed. `cli-v0.1.0`
built nine images, smoke-tested them, pushed them, pulled every one back by
digest, recorded the nine digests above, and went green — while the package was
**private**, so the first command in [`docs/cli.md`](../../../docs/cli.md)
returned `unauthorized` for everyone outside the org. The verify job pulled as
the _publisher_, and for a publisher a private package is perfectly pullable.
_Published_ and _obtainable_ are different claims, and only a caller with **no
credential** can tell them apart.

So the release lane now ends with a job that holds none:
[`smoke/assert-public.mjs`](smoke/assert-public.mjs) resolves every digest it
just pushed against GHCR with no `Authorization` header, from a job with no
registry login and no `packages:` scope, and fails the release if any of them
refuses. It probes a known-public repository first and reports INDETERMINATE if
_that_ fails — a broken probe answers "private" to everything, and "private" is
the answer it is hunting.

**It is ONE package, not nine.** Every profile is a TAG in the single OCI
repository `moooon-b-v/motir-sandbox` — the registry says so itself, issuing the
same `scope="repository:moooon-b-v/motir-sandbox:pull"` challenge for `:claude`,
`:codex` and `:base` alike. GHCR's visibility is a property of the package, so
one setting governs all eighteen tags. (Useful to know before touching it: the
public-visibility flip is UI-only and **irreversible** — see
[`docs/decisions/fleet-image-pull.md`](../../../docs/decisions/fleet-image-pull.md)
§4.1.)

Check it yourself, from any shell, credentials or not — the script never sends
one either way:

```sh
node packages/cli/sandbox/smoke/assert-public.mjs \
  --ref ghcr.io/moooon-b-v/motir-sandbox:claude
```

### Current, and asserted to be (MOTIR-2131)

Obtainable is not the same claim as **up to date**, and the second one failed
next. Five days after `cli-v0.1.0` was cut, `:claude` was eleven commits behind
`main`: it greeted every new user with a credential banner naming _one_ of the
[three tiers](#three-ways-to-give-it-a-motir-credential) above and telling them
to log in on the host — the exact thing [`docs/cli.md`](../../../docs/cli.md)
§ The sandbox promises you do not have to do. `motir login` was not in the image
at all. Nothing noticed, and nothing could have: CI was green, the docs were
accurate about `main`, and `motir auto` in a normal console worked. None of
those consume the artifact.

**`cli-v0.1.1` is the release cut to close it** ([the table
above](#release-cli-v011)) — nine new digests, none of them equal to their
`cli-v0.1.0` row, built from a `main` that has carried `motir login` and the
three-tier banner since MOTIR-1877. The fix was to the published bytes, not to
`main`, which had been right the whole time. Note what that argument rests on,
though: it is build provenance, not an observation of the running image. Nothing
in CI asserts the banner's text — `assert-current.mjs` compares tags to commits
and `assert-public.mjs` asks the registry a question about access, and neither
one reads a line of output. Someone has to run the image and look.

Drift itself is expected here — [Publishing](#publishing) has no push-to-`main`
trigger on purpose, because a `:latest` that moves on every merge is not a
sandbox you can reproduce a run in. What was missing is a **tripwire on how
long the drift has sat**, so the gap surfaces before a user does:

```sh
node packages/cli/sandbox/smoke/assert-current.mjs
```

No Docker, no network, no credential — it compares the newest `cli-v*` tag
against your checkout and tells you what is unreleased, and for how long.
`.github/workflows/sandbox-staleness.yml` runs it daily and fails once the
oldest unreleased commit passes the window (three days by default —
`--max-age-days` moves it). It reports the drift even while it passes, so the
number is visible before it is fatal, and it distinguishes _drifted_ from
_bumped but never tagged_, which need opposite fixes.

⚠️ **The obvious version-only check would not have caught this.** Comparing
`packages/cli/package.json` to the newest tag is a real check — it catches a
release prepared and never cut — but on 2026-08-04 the version was `0.1.0` and
the tag was `cli-v0.1.0`, a perfect match, for the entire time the images were
wrong. Nobody forgot to tag a bump. Nobody bumped.

## What it confines — and what it does not

|                |                                                                                                                                                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Filesystem** | Confined. The only host surfaces inside the container are a writable `/workspace` (your `.motir.json` tree) and, _if you mount one_, a **read-only** `~/.config/motir` (the PAT). With the environment tier there is exactly ONE host bind. No docker socket, no other host bind. |
| **Network**    | **Open, by design.** Every coding agent needs its provider API, and every dispatched item needs git remotes plus the Motir server. This image confines the filesystem blast radius, not egress — reach for docker's own `--network` controls if your threat model needs more.     |
| **Privileges** | Runs as the unprivileged `node` user (uid 1000), so files written into the mount stay owned by you rather than by root.                                                                                                                                                           |

A MOUNTED PAT is read-only because the container _consumes_ that credential and
never rotates it — so `motir login` cannot persist over a `:ro` bind, and says so
in one sentence rather than dying on an `EROFS` (the smoke lane asserts exactly
that). Minting a credential in here is a different matter and is supported:
start the container **without** the mount and run `motir login`, or hand it a
token with `MOTIR_TOKEN`. See [the three ways](#three-ways-to-give-it-a-motir-credential).

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

**Every service passes `MOTIR_TOKEN` and `MOTIR_SERVER` through from your shell**,
so the compose form has the same mount-free credential path as `docker run`:
export the two variables and the `~/.config/motir` bind carries nothing the run
needs. The bind stays in the file because compose cannot express a conditional
mount (and it is still the right default on a host you have logged in on) — if
you want a container with genuinely no credential mount, which is also what
`motir login` inside the container requires, use the `docker run` form above.

## Dev container

`devcontainer/devcontainer.json` is the VS Code / `devcontainer` CLI variant of
the **base** image, and `devcontainer/<profile>/devcontainer.json` is the same
thing per agent — same `/workspace` folder, same read-only PAT mount, the
profile's `AGENT` build arg plus that agent's own read-only credential mount:

```sh
devcontainer up --workspace-folder . \
  --config packages/cli/sandbox/devcontainer/claude/devcontainer.json
```

Each variant also forwards `MOTIR_TOKEN` / `MOTIR_SERVER` from your local
environment (`remoteEnv`), so a dev container on a machine that never ran a host
login still resolves a credential — the same tier the `docker run` and compose
forms use.

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

| Profile       | codegraph target | Config the agent actually reads                                         |
| ------------- | ---------------- | ----------------------------------------------------------------------- |
| `claude`      | `claude`         | `~/.motir-sandbox/agent-config/.claude/` (redirected, below)            |
| `codex`       | `codex`          | `~/.motir-sandbox/agent-config/.codex/config.toml` (redirected, below)  |
| `opencode`    | `opencode`       | `~/.motir-sandbox/agent-config/.config/opencode/opencode.jsonc` (ditto) |
| `cursor`      | `cursor`         | `~/.cursor/mcp.json`                                                    |
| `antigravity` | `antigravity`    | `~/.gemini/antigravity/mcp_config.json`                                 |
| `kimi`        | — none           | not wired                                                               |
| `aider`       | — none           | not wired (Aider is not an MCP client)                                  |
| `goose`       | — none           | not wired (no `goose` target in codegraph)                              |

The three redirected rows are why the next section exists: codegraph's own
default for them (`~/.claude/`, `~/.codex/config.toml`,
`~/.config/opencode/opencode.jsonc`) falls inside that agent's read-only
credential mount.

### When the credential mount would mask the wiring (7.9.7f, 7.9.7g)

For `claude`, `codex` and `opencode` the config file above lives _inside_ the
directory the compose/dev-container form mounts read-only from the host — so the
host's copy shadowed the one the image built in, and those agents saw no
codegraph tools at all under the recommended compose path.

All three are now pointed at a config home the **image** owns,
`~/.motir-sandbox/agent-config`, which sits outside every mounted path and so can
never be shadowed. The credential mounts are unchanged; nothing needs dropping.

| Profile    | Env var the entrypoint exports | Mechanism                                                                                                                                                                                                               |
| ---------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`   | `CLAUDE_CONFIG_DIR`            | `CLAUDE_CONFIG_DIR` governs the state file, `settings.json`, `CLAUDE.md` **and** `.credentials.json`, so the redirected dir is SEEDED from the read-only mount and codegraph then merges its stanza into that copy.     |
| `codex`    | `CODEX_HOME`                   | `CODEX_HOME` governs `config.toml` **and** `auth.json`, so the redirected home is SEEDED from the read-only mount (credential + your own `config.toml` come along) and codegraph then MERGES its stanza into that copy. |
| `opencode` | `OPENCODE_CONFIG`              | `OPENCODE_CONFIG` is MERGED over the global config rather than replacing it, so your mounted `~/.config/opencode` still applies and no credential is copied at all. Auth lives in the XDG **data** dir, untouched.      |

Every value in that table was **verified against the real CLIs** — claude 2.1.220,
codex 0.146.0, opencode 1.18.9, codegraph 1.5.0, each run against a scratch home
with the credential directory made unwritable to stand in for the `:ro` mount —
not read off their documentation. That is the same "leave an unverified
third-party path UNKNOWN rather than guess it" rule the credential column follows.

#### The `claude` profile, in detail (7.9.7g / MOTIR-1840)

`codegraph install --target claude --yes` writes **three** files, and the shipped
Claude Code CLI reads none of them where codegraph puts them:

| codegraph writes               | what it is                            | where Claude Code 2.1.220 reads it from |
| ------------------------------ | ------------------------------------- | --------------------------------------- |
| `<home>/.claude.json`          | the MCP **server** stanza             | `$CLAUDE_CONFIG_DIR/.claude.json`       |
| `<home>/.claude/settings.json` | the **auto-allow** list + prompt hook | `$CLAUDE_CONFIG_DIR/settings.json`      |
| `<home>/.claude/CLAUDE.md`     | the agent's codegraph instructions    | `$CLAUDE_CONFIG_DIR/CLAUDE.md`          |

`$CLAUDE_CONFIG_DIR` defaults to `~/.claude`, so the last two land inside the
read-only mount and are masked by the host's copies. The first is a **legacy
path the 2.x CLI no longer reads at all** — verified by `claude mcp list`, which
ignores a `~/.claude.json` holding the codegraph stanza. So this profile did not
merely stop to ask before calling the tools: it had no code-graph tools.

Pointing `CLAUDE_CONFIG_DIR` at `~/.motir-sandbox/agent-config/.claude` and
running `codegraph install` with `HOME=~/.motir-sandbox/agent-config` lines up two
of the three files exactly. The entrypoint then lifts the `mcpServers` key from
the third into the redirected state file — a **merge** of one key, so your own MCP
servers and the rest of Claude Code's state survive. A state file that is present
but unparseable is left alone and reported, never overwritten.

**The mount contract, amended — deliberately.** 7.9.7b's rule was that an agent
credential is mounted read-only and never copied. `codex` already had to break
that, and `claude` now does too: `CLAUDE_CONFIG_DIR` moves `.credentials.json`
along with everything else, so a redirect without a seed would trade "no
code-graph tools" for "not signed in". The reasoning is the same one the codex
seed rests on — **copying the credential to a second path inside the container
widens nothing**, because the container could always read the mounted file; what
the `:ro` mount actually guarantees, that the container cannot WRITE the host's
copy, still holds. What is copied is bounded and explicit
(`CLAUDE_SEED_ENTRIES` in `entrypoint.sh`): the credential, the state file, your
settings, your `CLAUDE.md`, and `agents/` `commands/` `skills/` `plugins/`.
Session archives (`projects/`, `file-history/`, `history.jsonl`, …) are **not**
copied — they are per-machine state the container regenerates, and they are ~95%
of the directory's size on a working machine.

A side effect worth knowing: the redirected config dir is **writable**, where
`~/.claude` was mounted `:ro`. Claude Code can keep its own session state again
instead of failing to write it.

Two notes on the seam:

- **`MOTIR_SANDBOX_CODEGRAPH=0` skips the redirect too**, along with the rest of
  the block, leaving each agent on its own default config exactly as before.
- `cursor` and `antigravity` never needed any of this — their MCP server config
  sits outside the mounted path.

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

The build/smoke matrix lives in `.github/workflows/sandbox-images.yml` and runs
on every pull request (`ci.yml` calls it). It is the reason the claims on this
page can be believed rather than merely written down — and, because
[Publishing](#publishing) calls the very same workflow, it is also the release
gate: the push step is a later step of the job that just proved the image works,
so an image no smoke test touched cannot reach the registry.

### `Sandbox smoke (loop + failure + confinement)`

Builds the base image, then starts it **three times** — once per credential
recipe from [Run](#run), because whether a credential mount is present and
whether a token is in the environment are properties of how the container was
LAUNCHED, not something a script can simulate from inside one.

**Run 1 — with the read-only credential mount.** Four suites:

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
  stub `/api/v1` server scripts the ready set, a fake agent does the integration,
  and every request is recorded so `assert-run.mjs` can check the SEQUENCE — one
  read of the ready set per iteration (never a batch read-ahead), each item's
  prompt fetched with the run's session branch as the seed, each flipped to In
  Progress before its agent is launched, each integration recorded on that same
  branch, and exactly ONE pull request at the end. A run that exited 0 having
  skipped the integration record fails this test.

  > **⚠️ The stub spoke MCP until 11.5.6 and answered every `GET` with a 405, so
  > from the moment the CLI moved to `/api/v1` the first request of every smoke
  > run failed (MOTIR-2436). It serves the real endpoints now, and its bodies are
  > checked against the CLI's own generated validators by
  > `packages/cli/test/sandboxStub.test.ts` — the v1 client rejects a response
  > that is only nearly right, so an approximate body would fail here in a Docker
  > matrix twenty minutes into CI rather than in the unit lane in milliseconds.**

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

- **`readonly-login-smoke.sh`** — `motir login` under that same mount. The grant
  succeeds and there is then nowhere to put the token, which must surface as ONE
  sentence naming the fix (and pointing at `MOTIR_TOKEN`, the tier that needs no
  disk) — never an `EROFS`, never a stack trace, and with the mounted credential
  left byte-for-byte unchanged. A supported configuration used correctly must not
  read as a crash (MOTIR-1836 is that class of bug).

**Run 2 — no credential mount, `-e MOTIR_TOKEN -e MOTIR_SERVER`.**
`env-credential-smoke.sh` asserts the bind really is absent (against
`/proc/self/mounts`, so the leg cannot pass on a credential it was handed rather
than the one under test), then drives the whole `loop-smoke.sh` suite —
`motir ready` plus the full `motir auto` loop — on the environment tier alone.
This is the recipe CI and a fresh machine use, so it is smoke-tested as its own
case rather than assumed to follow from the mounted one.

**Run 3 — no mount and no token: a fresh machine.** `login-smoke.sh` runs
`motir login --no-browser` inside the container against the stub's device routes:
the code is printed grouped (`K4TP-9RXM`) with its URL, the approval is scripted
after one `authorization_pending` poll, and the minted credential is written to
the container's own `~/.config/motir/config.json` at mode 600. Then `motir ready`
reads the plan with nothing in the environment — which is the actual claim, not
that a file appeared.

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
the [validation](#validation) matrix with its push steps on, then **two**
post-deploy verification jobs, because there are two different claims to check:

1. **`sandbox-published`** pulls every image back **by digest** and runs `motir
--version` in it — "the push exited 0" and "the bytes are in the registry and
   they run" are not the same claim. Its summary prints the digest table; paste
   it into [Published images](#published-images).
2. **`sandbox-public`** asks whether a **stranger** can pull them, which the
   first job structurally cannot: it logs in, and a private package is pullable
   by its publisher. See [Public, and asserted to
   be](#public-and-asserted-to-be-motir-2010) for why that gap shipped nine
   unobtainable images green, and what closed it.

Auth is the workflow's own `GITHUB_TOKEN` under a `packages: write` permission
block, granted on the release lane only. **No repository secret, no registry
account, nothing provisioned out of band** — and the pull-request lane, which has
no such block, cannot push even if it tried.

Five things worth knowing before your first release:

- **Something will tell you when the next one is overdue.** Because this lane
  fires only on a tag, `main` and the published image drift apart between
  releases by design — and drifted five days and eleven commits without anyone
  noticing once already (MOTIR-2131). `sandbox-staleness.yml` runs
  [`assert-current.mjs`](smoke/assert-current.mjs) daily and goes red when the
  oldest unreleased commit passes its window; see [Current, and asserted to
  be](#current-and-asserted-to-be-motir-2131). Run it yourself any time with
  `node packages/cli/sandbox/smoke/assert-current.mjs` — it needs nothing but a
  checkout with tags, and after a bump merges it will keep failing until the tag
  is pushed, naming the exact command.

- **Package visibility.** A GHCR package starts **private**. After the first
  successful release, make it public once at
  `https://github.com/orgs/moooon-B-V/packages/container/motir-sandbox/settings`
  — one flip, covering every tag, and **irreversible**. This bullet existed
  before `cli-v0.1.0` and the step was skipped anyway, which is exactly why the
  release now FAILS on it (`sandbox-public`) instead of merely mentioning it. Do
  it before the tag if you can; the failing job prints the same URL if you
  cannot.
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

| File                             | What it is                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                     | The base image: Node floor assertion, git + `gh`, the packed `motir` binary, the CodeGraph engine, the `AGENT` selector, the unprivileged user and the `/workspace` entrypoint.                                                                                                                                              |
| `install-agent.sh`               | The per-agent layer seam invoked by the `AGENT` build arg — one case arm per profile, each smoke-testing the binary it installs and wiring the codegraph MCP server where codegraph has a target.                                                                                                                            |
| `entrypoint.sh`                  | Verifies the mounts, names all three credential paths when none is present, redirects the three agents whose codegraph config a `:ro` mount would mask, indexes `/workspace` with CodeGraph and installs its git sync hooks, drops into `/workspace`, `exec`s your command. All output on stderr so stdout stays pipe-clean. |
| `docker-compose.yml`             | The compose form — one service + compose profile per agent, each passing `MOTIR_TOKEN` / `MOTIR_SERVER` through and mounting its agent credential.                                                                                                                                                                           |
| `devcontainer/devcontainer.json` | The dev-container form of the base image.                                                                                                                                                                                                                                                                                    |
| `devcontainer/<profile>/`        | The dev-container form of each agent profile.                                                                                                                                                                                                                                                                                |
| `smoke/run.sh`                   | The validation driver: build the image, then run it through each documented credential recipe — mounted, env-only, and nothing-at-all — executing the suites that belong to each.                                                                                                                                            |
| `smoke/confinement.sh`           | The blast-radius assertions, read from `/proc/self/mounts` rather than from this page.                                                                                                                                                                                                                                       |
| `smoke/loop-smoke.sh`            | `motir auto --agent <fake-agent>` end to end inside the image — builds its own git fixture, needs no LLM and no server.                                                                                                                                                                                                      |
| `smoke/failure-smoke.sh`         | The failure path: an agent that dies mid-run must still cost nothing — the branch is pushed and the pull request opened, with the store writable and unwritable.                                                                                                                                                             |
| `smoke/env-credential-smoke.sh`  | The mount-free environment tier: proves the bind is absent, then runs the whole loop on `MOTIR_TOKEN` alone.                                                                                                                                                                                                                 |
| `smoke/login-smoke.sh`           | `motir login` performed INSIDE the container — device grant, approval, a credential written to its own config dir, and a read that uses it.                                                                                                                                                                                  |
| `smoke/readonly-login-smoke.sh`  | The same login under the `:ro` mount: it must refuse in one sentence naming the fix, write nothing, and never leak an `EROFS`.                                                                                                                                                                                               |
| `smoke/stub-server.mjs`          | A zero-dependency `/api/v1` server scripting the ready set, recording every request — plus the two device-grant routes `motir login` speaks. Its bodies are validated against the generated client by `packages/cli/test/sandboxStub.test.ts`.                                                                               |
| `smoke/fake-agent.sh`            | The scripted agent: verifies the prompt arrived on BOTH delivery channels, integrates onto the session branch, exits 0.                                                                                                                                                                                                      |
| `smoke/failing-agent.sh`         | The scripted agent that refuses ONE named item and delegates the rest — so the run has real integrated work behind it when the failure lands.                                                                                                                                                                                |
| `smoke/assert-run.mjs`           | Asserts the recorded request SEQUENCE — the thing an exit code cannot tell you.                                                                                                                                                                                                                                              |
| `smoke/assert-public.mjs`        | Asks whether a STRANGER can pull what the release just pushed — a manifest probe that sends no `Authorization` header and checks a known-public control first. Three-valued: public / private-or-absent / could not tell.                                                                                                    |
| `smoke/assert-current.mjs`       | Asks whether the published image is still what `main` says it is — compares the newest `cli-v*` tag against a checkout and fails once unreleased work has SAT past its window. Needs no Docker, network or credential.                                                                                                       |
| `smoke/profiles.json`            | The CI build/liveness matrix: one entry per profile, read by the workflow so adding an agent extends CI on its own.                                                                                                                                                                                                          |

Three workflow files sit outside this directory: the build/smoke/publish matrix
itself, `.github/workflows/sandbox-images.yml`; the tagged release lane that
calls it with publishing on, `.github/workflows/release-sandbox.yml`; and the
daily drift tripwire, `.github/workflows/sandbox-staleness.yml`.

The image sources' invariants (the read-only PAT mount, the absence of a docker
socket, the Node floor, the seam covering every agent profile, the codegraph
wiring and its sync hooks) are asserted by
[`test/sandbox.test.ts`](../test/sandbox.test.ts); the validation harness and the
release lane are guarded against drift by
[`test/sandboxCi.test.ts`](../test/sandboxCi.test.ts).
