# The hosted agent image

The container Motir boots, once per hosted run, to run the Motir CLI's own
`motir run` on the run the server opened (Story MOTIR-683 · MOTIR-687, made to
run the CLI by MOTIR-6560). `docs/decisions/hosted-run-runs-the-cli-as-the-app.md`
is the decision it implements: a leaf, a leaf that spans several repositories and
a parent worked through its children all run exactly as they do on a laptop.

`entrypoint.ts` is only a launcher. Everything a run does — reading its cards,
cloning every repository it touches, indexing each checkout with codegraph,
launching OpenCode on the gateway key per the egress contract, pushing, opening
and linking one pull request per repository, and closing the run — is the CLI's
(`packages/cli/src/hostedMode.ts`, `hostedAgent.ts`, `hostedGit.ts`,
`hostedCodegraph.ts`).

## The run's inputs

Everything arrives as environment at boot. Nothing is baked into the image.

| variable                | what it is                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `MOTIR_DISPATCH_RUN_ID` | the `DispatchRun.id` the server opened — the CLI ADOPTS it, never opens one            |
| `MOTIR_WORK_ITEM_KEY`   | the dispatched card, e.g. `MOTIR-683` — a leaf, or a parent run as its scope           |
| `MOTIR_API_URL`         | Motir's origin, for every call the CLI makes                                           |
| `MOTIR_RUN_TOKEN`       | the run's Motir credential (MOTIR-688), reaching only the run's own cards              |
| `MOTIR_GATEWAY_URL`     | the gateway's origin, no trailing `/v1` (egress contract §2)                           |
| `MOTIR_RUN_KEY`         | the per-run gateway key (MOTIR-689) — the ONLY credential the agent ever sees          |
| `MOTIR_MODEL`           | the model in OpenCode's form, `anthropic/<bare gateway id>` (decision §7)              |
| `MOTIR_RUN_MODE`        | optional — `run` (the default), `continue` for a dead run's branch, `review`, or `fix` |
| `MOTIR_REVIEW_GATE_ID`  | `review` only — the `agent_review` gate the run answers (MOTIR-6820)                   |
| `MOTIR_REVIEW_VERSION`  | `review` only — the version under review; a served prompt for another exits 0          |

A `review` run (MOTIR-6824, `hosted-agent-run.md` §8) runs `motir review <KEY>`:
it checks every pull request out detached at its reviewed head, locks the run
read-only (every push fails, `gh` refuses), and submits the agent's ONE verdict —
the only thing that leaves the container.

A `fix` run (MOTIR-6929, `hosted-agent-run.md` §8.6) runs `motir fix <KEY>` on the
repair the server's claim opened: it adopts the run (never claims), clones every
repository and checks each pull request out on its OWN branch, locks pushes to
exactly those branches (`gh` refuses), and runs the agent on the review-fix prompt
with the recorded findings. It opens no pull request; a repair that pushes nothing
closes and leaves the card To fix.

There is no repository, base ref, git token or git author among them: the run's
repositories come from its cards, and GitHub is reached only through the CLI's
credential helper on the run's git-credential route, as Motir's App.

`MOTIR_WORKSPACE` (default `/workspace`) and `MOTIR_CLI_BIN` (default `motir`)
exist so the smoke test can point the launcher at a scratch workspace and at the
CLI's source; a real run leaves them unset.

## What the end path reads

The container exits with the CLI's own code: `0` when the run completed, the
agent's code when it failed, non-zero on a halted run. `20` means the launcher
refused its inputs and never reached the CLI. A killed CLI exits `128 + signal`.
The CLI closes the run it adopted; the server's end path closes it only when the
CLI never did.

## Building and testing it

The build context is the repository root, because the CLI is built from this
checkout:

```sh
docker build -t motir-hosted-agent:local -f packages/cli/sandbox/hosted/Dockerfile .
MOTIR_HOSTED_AGENT_IMAGE=motir-hosted-agent:local \
  pnpm --filter @motir/cli exec vitest run sandbox/hosted/smoke.test.ts
```

Without `MOTIR_HOSTED_AGENT_IMAGE` the smoke test still drives the launcher and
the CLI as processes (no Docker needed) and skips its image layer.
`.github/workflows/hosted-agent-image.yml` builds, proves and — on `main` —
publishes it by digest.
