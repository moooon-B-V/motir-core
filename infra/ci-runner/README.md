# The Motir CI runner image

The container every ephemeral fleet runner boots from — the thing
`MOTIR_RUNNER_IMAGE` names and that
`lib/orchestrator/adapters/fly/flyMachines.ts` refuses to start without.

| File                    | What it is                                                                  |
| ----------------------- | --------------------------------------------------------------------------- |
| `Dockerfile`            | The image. Its header carries the toolchain derivation + evidence table.    |
| `entrypoint.sh`         | dockerd → drop to `runner` → `exec run.sh --jitconfig`. One job, then exit. |
| `smoke/assert-image.sh` | The mechanical §7.2 / §7.4 assertions, on sources and on the built image.   |
| `smoke/prove-boot.sh`   | Boots the real image; proves dockerd + `run.sh` + a `services:` container.  |

Built, asserted and proven by `.github/workflows/runner-image.yml` on every
pull request; published by `.github/workflows/release-runner-image.yml` on a
`runner-v*` tag. `tests/ciFleet/ciRunnerImage.test.ts` guards the sources.

## Using it

The fleet consumes a **digest**, never a tag:

```
MOTIR_RUNNER_IMAGE=ghcr.io/moooon-b-v/motir-ci-runner@sha256:<64 hex>
```

§7.2 of `docs/decisions/ci-runner-fleet.md` requires it: these containers run
agent-authored customer code, and a mutable tag could change what executes
between the boot decision and the pull. The release workflow prints the digest
into its job summary and pulls the image back by it before reporting.

MOTIR-1979 sets it in the deployment, alongside `FLY_FLEET_API_TOKEN` and
`FLY_FLEET_APP` (see `.env.example`).

## Boot contract

The orchestrator puts these on the Machine
(`lib/services/ciRunnerBootService.ts` → `buildSpec()`):

| Variable                         | Role                                              |
| -------------------------------- | ------------------------------------------------- |
| `ACTIONS_RUNNER_INPUT_JITCONFIG` | **Required.** The base64 JIT config. §7.4.        |
| `ACTIONS_RUNNER_CONFIG_ARGS`     | `--no-default-labels`; not forwarded — see below. |
| `MOTIR_RUNNER_LABEL`             | The single §M-compliant fleet label.              |
| `MOTIR_INTENT_ID`                | Attribution, echoed into the container log.       |
| `MOTIR_WORKFLOW_JOB_ID`          | Attribution, echoed into the container log.       |

`ACTIONS_RUNNER_CONFIG_ARGS` is deliberately not forwarded: it is a `config.sh`
flag and this image has no `config.sh`. The guarantee it restates — no default
labels — is already made at mint time, because a JIT config's `labels` array is
the runner's complete label set and GitHub adds no defaults to a JIT runner.

## What is not proven in CI

`smoke/prove-boot.sh` proves the entrypoint's dockerd path, that `run.sh` is
exec'd as the unprivileged `runner` user with the JIT config, and that a
`services: postgres:16-alpine` container is reachable on `localhost:5432` the
way the starters' jobs need.

It does **not** prove live registration, "takes exactly one job, de-registers,
exits", or non-residency after the job — those need a JIT config minted against
a real runner group by an org token with `Self-hosted runners: write`, both of
which are **MOTIR-1919**'s manual deliverables and have not landed. **MOTIR-1928
owns that proof**, together with the real p50/p95 boot latency against §6 (this
image's pull time is a term in it — the compressed size is printed by the build
workflow's job summary for exactly that attribution).

## Local build

```sh
docker build -f infra/ci-runner/Dockerfile -t motir-ci-runner:dev infra/ci-runner
infra/ci-runner/smoke/assert-image.sh --image motir-ci-runner:dev
infra/ci-runner/smoke/prove-boot.sh   --image motir-ci-runner:dev   # needs --privileged
```

The build context is this directory, not the repo root: the image contains
nothing from motir-core's tree, and a root context would ship the whole checkout
into a container that executes customer code.

## Bumping a pin

Every pin is an `ARG` at the top of the `Dockerfile` with a checksum beside it.
To move one, update both, then let CI rebuild — `assert-image.sh` fails the
build if a version stops being exact or a download stops being verified.

- **Actions runner** — `RUNNER_VERSION` + `RUNNER_SHA256` from the release body
  of <https://github.com/actions/runner/releases>.
- **Ubuntu** — `UBUNTU_DIGEST`. `ubuntu-latest` is what §8's parity target
  tracks, so move this when GitHub moves `ubuntu-latest`, not before.
- **Node** — `NODE_VERSION` + `NODE_SHA256` from `nodejs.org/dist/v<x>/SHASUMS256.txt`.
  Stay on the major the starters' `setup-node` asks for (22).
- **Docker / Playwright** — `DOCKER_VERSION` + `DOCKER_SHA256` (the static
  tarball) and `PLAYWRIGHT_VERSION` (whose own `install-deps` list is used).

Adding a toolchain entry is not a free choice: the derivation rule is that the
image carries the **union of what the two starters' workflows actually install**,
with the file:line evidence recorded. An entry with no evidence line does not
belong in the image; a starter workflow that starts installing something new
does.
