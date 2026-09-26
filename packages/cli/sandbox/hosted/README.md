# The hosted agent image

The container Motir boots, once per dispatched card, to run that card with
OpenCode and hand back a pull request (Story MOTIR-683 · Subtask MOTIR-687).
`entrypoint.ts` is the whole program; `docs/decisions/hosted-agent-run.md` is the
decision it implements; the gateway's `docs/hosted-run-egress.md` fixes how
OpenCode is configured, and `opencode.egress.json` is that document verbatim.

## The run's inputs

Everything arrives as environment at boot. Nothing is baked into the image.

| variable                                           | what it is                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `MOTIR_DISPATCH_RUN_ID`                            | the `DispatchRun.id` — the one id the run carries everywhere                    |
| `MOTIR_WORK_ITEM_KEY`                              | the card, e.g. `MOTIR-683`                                                      |
| `MOTIR_WORK_ITEM_TITLE`                            | optional — the card's title, for the commit and the pull request                |
| `MOTIR_REPOSITORY`                                 | `owner/name` on GitHub                                                          |
| `MOTIR_BASE_REF`                                   | the branch to clone and to open the pull request against                        |
| `MOTIR_API_URL`                                    | Motir's origin, for the dispatch prompt and the shared ingest                   |
| `MOTIR_RUN_TOKEN`                                  | the run's Motir credential (MOTIR-688)                                          |
| `MOTIR_GIT_TOKEN`                                  | the run's GitHub credential (MOTIR-6449)                                        |
| `MOTIR_GIT_AUTHOR_NAME` / `MOTIR_GIT_AUTHOR_EMAIL` | the dispatcher, as the author of every commit                                   |
| `MOTIR_GATEWAY_URL`                                | the gateway's origin, no trailing `/v1` (egress contract §2)                    |
| `MOTIR_RUN_KEY`                                    | the per-run gateway key (MOTIR-689) — the ONLY one of these the agent ever sees |
| `MOTIR_MODEL`                                      | the model in OpenCode's form, `anthropic/<bare gateway id>` (decision §7)       |

`MOTIR_WORKSPACE`, `MOTIR_GIT_REMOTE_URL` and `MOTIR_GITHUB_API_URL` exist so the
smoke test can point the run at stubs; a real run leaves them unset.

## What the end path reads

| exit | meaning                                                                       |
| ---- | ----------------------------------------------------------------------------- |
| `0`  | the agent exited 0, its work was pushed and the pull request opened           |
| `10` | the agent exited non-zero (its log tail is on `agent_exited`); nothing pushed |
| `11` | the agent exited 0 and changed nothing; nothing pushed                        |
| `20` | an input was missing or malformed, or a setup step (prompt, clone) failed     |
| `21` | the work could not be committed, pushed or opened as a pull request           |

## Building and testing it

```sh
docker build -t motir-hosted-agent:local packages/cli/sandbox/hosted
MOTIR_HOSTED_AGENT_IMAGE=motir-hosted-agent:local \
  pnpm --filter @motir/cli exec vitest run sandbox/hosted/smoke.test.ts
```

Without `MOTIR_HOSTED_AGENT_IMAGE` the smoke test still drives the entrypoint as
a process (no Docker needed) and skips its image layer.
`.github/workflows/hosted-agent-image.yml` builds, proves and — on `main` —
publishes it by digest.
