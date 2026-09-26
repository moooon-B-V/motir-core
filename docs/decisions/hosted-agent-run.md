# ADR: A hosted agent run, end to end

- **Status:** Proposed (2026-09-26), for acceptance at this card's `decision_approval` gate
- **Card:** MOTIR-685 (9.1.2) · **Story:** MOTIR-683 (9.1, "A card runs on the hosted agent")
- **Consumed by:**
  - MOTIR-684 (the design)
  - MOTIR-687 (the image)
  - MOTIR-688 (the run's Motir credential)
  - MOTIR-689 (the gateway wiring)
  - MOTIR-6447 (the credit pre-flight)
  - MOTIR-6448 (machine time by run)
  - MOTIR-6449 (the run's git credential)
  - through them, MOTIR-690 (start) and MOTIR-6450 (end)
- **Supersedes:** this card's own earlier scope, a `motir-ai/docs/hosted-execution.md` that was to choose a container orchestrator and a per-agent `*_BASE_URL` matrix. It was never written; both questions have since been settled elsewhere (see Context).

> Structured **Status → Context → Decision → Consequences**, in the shape the other records here use. Every enumeration below was read on `origin/main` of motir-core `84b69443e`, motir-gateway `00f72c8` and motir-ai `c440da5` (2026-09-26).

---

## Context

Story 9.1 runs one card on OpenCode in a fresh metered container, as the person who dispatched it, and ends in a pull request. Almost every piece it needs already ships, and each was built without knowing the others:

| Shipped piece                                   | Where                                                                                      | What it keys on                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Container lifecycle and hosting meter           | `lib/services/hostedAgentContainerService.ts` (MOTIR-4336)                                 | a fleet slot `ref`; the meter row is attributed to org, workspace, project and repository, not to a run |
| The shared run record, ingest, stream and panel | `DispatchRun` / `DispatchRunEvent`, `/api/v1/dispatch-runs/*` (MOTIR-1789)                 | `DispatchRun.id`; `origin` is already `local \| hosted`                                                 |
| The per-run model key                           | motir-gateway `POST /api/motir/run-keys`, `DELETE /api/motir/run-keys/:runRef` (Story 9.0) | a `runRef` the caller chooses                                                                           |
| The run's usage and credits                     | motir-ai `GET /v1/agent-runs/:coreRunId/usage` (MOTIR-6381)                                | a `coreRunId` the caller chooses                                                                        |
| How OpenCode must be configured                 | motir-gateway `docs/hosted-run-egress.md`                                                  | the env names `MOTIR_GATEWAY_URL`, `MOTIR_RUN_KEY`                                                      |

The container orchestrator (Fly Machines in a separate org behind the `ContainerOrchestrator` port) was decided by MOTIR-1918 and built by MOTIR-4336. The harness was settled as OpenCode, on Motir's gateway key only, by the epic (MOTIR-673). **Neither is re-opened here.**

What nobody has recorded is how these pieces meet for one run. Seven questions have to be answered once, because at least two cards and usually two repositories depend on each.

---

## Decision

### 1 · One id: `DispatchRun.id`, everywhere

A hosted run's `DispatchRun.id` is the value passed as:

- the fleet slot `ref` (`fleetCeilingService.reserve`);
- the container meter row's run pointer (MOTIR-6448);
- the gateway key's `runRef`;
- motir-ai's `coreRunId`;
- the run credential's binding (§3).

It is created first (`dispatchRunService.open`, `origin: 'hosted'`), before anything is minted or booted, so every later write can name it. It is already what the run panel keys on, and 9.0 already bills by it.

**Rejected:** a separate "hosted run id". Every consumer would then need a join back to the run the person is looking at, and a key minted under one id and billed under another is a run that appears to cost nothing.

### 2 · The lifecycle, on the shared vocabulary only

The story forbids a hosted-only status or event vocabulary, so a hosted run is expressed entirely in what `DispatchRun` already has. **No `DispatchRunStatus` and no event kind is added.**

| Phase the panel shows | Written as                                                    | Written by                              |
| --------------------- | ------------------------------------------------------------- | --------------------------------------- |
| starting              | `run_opened`                                                  | the start path (MOTIR-690)              |
| cloned                | `checkout_ready`                                              | the in-container entrypoint (MOTIR-687) |
| running               | `agent_started`, then `log` events carrying OpenCode's output | the entrypoint                          |
| agent finished        | `agent_exited` (exit code)                                    | the entrypoint                          |
| pull request open     | `delivery_linked` (the pull request URL)                      | the entrypoint                          |
| done                  | `run_closed`                                                  | the end path (MOTIR-6450)               |

| How it ended                                    | `DispatchRunStatus` | Teardown reason | The card becomes                                                                                                                                                                  |
| ----------------------------------------------- | ------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agent exited 0 and a pull request opened        | `succeeded`         | `job_completed` | **Implemented** (`in_progress → implemented`), exactly as a local run's card once its pull request opens. From there the pull request's own CI and merge move it, as for any card |
| agent exited non-zero, or any start step failed | `failed`            | `job_completed` | **To Do** (`in_progress → todo`), so it can be dispatched again                                                                                                                   |
| a person pressed cancel                         | `cancelled`         | `gate_revoked`  | **To Do**                                                                                                                                                                         |
| wall-clock timeout (§5)                         | `timed_out`         | `job_timed_out` | **To Do**                                                                                                                                                                         |
| stalled (§5)                                    | `timed_out`         | `job_timed_out` | **To Do**                                                                                                                                                                         |

Stall and timeout share a status because they are the same fact to the record: the run ran out of time. The run's closing `log` event names which one it was (_"stalled: no agent output for 15 minutes"_ / _"timed out after 90 minutes"_), and that line is what the panel shows. Both edges out of `in_progress` are legal in the default workflow (`lib/workflows/defaultWorkflow.ts`). **Returning to To Do rather than staying In Progress is deliberate:** a failed hosted run holds no worktree and no person, so In Progress would be a claim nobody is exercising, and both claim doors refuse it.

`implementationSource: hosted` (with `implementationHarness: opencode`) is stamped at start and never cleared. It records how the card was attempted, and a later local run overwrites it through its own seam, as provenance already does (`docs/decisions/work-item-provenance.md`).

### 3 · The run's Motir credential: a run-bound `ApiToken`

The container needs to call Motir to report through the shared ingest and to read its card's dispatch prompt. It gets **one `ApiToken`**:

- **Bound to the run:** a new nullable `ApiToken.dispatchRunId`. A token carrying it is accepted by `/api/v1/dispatch-runs/{id}/events` and `/close` **only for that `{id}`**, refused on `POST /api/v1/dispatch-runs` (the server opens hosted runs itself), and allowed to read `GET /api/v1/work-items/[key]/dispatch-prompt` **only for that run's card**.
- **Owned by the dispatcher**, so every write it makes is attributed to the person who pressed Run hosted, as the story requires.
- **Grant:** `HOSTED_RUN_TOKEN_GRANT` = `['project:browse', 'work_item:edit']`, the two keys those routes assert. The binding in the first bullet is what narrows it; the keys alone are as coarse as the CLI's. It holds no `ai:*` key, so it cannot author or read plans.
- **Lifetime:** `expiresAt` = boot time + the run's timeout (§5) + 5 minutes for settle.
- **Death:** revoked at run end by the end path. Revoking an `ApiToken` **deletes its row** (MOTIR-3546), so a revoked run token cannot be revived. Its expiry is the backstop if revocation fails.

**Reference:** GitHub Actions' `GITHUB_TOKEN`, minted per job, limited to that job's repository and declared permissions, and invalid when the job ends. **Rejected:** a second, purpose-built token system. `ApiToken` already carries hashing, expiry and grant checks, so a run token differs by one column and one grant.

### 4 · The git identity: how the pull request is authored as the dispatcher

**The question was genuinely open, and the answer depends on who owns the repository.**

**Decision.**

- **A repository the USER owns** (reached through the opt-in "Motir Agent" App, MOTIR-1894): a **GitHub App user access token for the dispatcher**.
  - It is exchanged with `repository_id` set to that one repository, so it reaches nothing else.
  - It expires in 8 hours, longer than any run (§5).
  - It is revoked at run end with `DELETE /applications/{client_id}/token`.
  - Commits and the pull request are then the dispatcher's own, shown with the App's badge.
  - **If the dispatcher has not authorized the Motir Agent App, the run is refused before anything boots**, with the reason _"link your GitHub account to Motir to run hosted on owner/name"_. There is no bot fallback on a user's repository.
- **A repository MOTIR created** (reached through `motir-studio` in Motir's own organization, MOTIR-704 / MOTIR-1966): a **narrowed installation access token**.
  - Its access-token request body limits it to that one repository, `contents: write` and `pull_requests: write`.
  - It lasts one hour and is revoked with `DELETE /installation/token`.
  - Commits are authored as the dispatcher (their linked GitHub noreply address when they have one, otherwise their Motir name and verified email).
  - The pull request is opened by `motir-studio[bot]`, and its body names the dispatcher.

**Why the split, not one answer.**

- A user access token can only reach what the user can reach: _"The app can only access resources that the user has access to"_. A dispatcher is normally not a member of Motir's own organization, so the user token cannot work on a Motir-created repository.
- On a user's own repository the bot option can work, but it does not make the dispatcher the author. Only a user access token does: _"the GitHub UI will show the user's avatar photo along with the app's identicon badge as the author"_.

**Evidence.**

- GitHub, _Authenticating with a GitHub App on behalf of a user_:
  - attribution, and access limited to the overlap of the user's and the app's.
- GitHub, _Generating a user access token for a GitHub App_:
  - _"By default, the user access token expires after 8 hours"_;
  - `repository_id`: _"The ID of a single repository that the user access token can access."_
- GitHub REST, _Create an installation access token for an app_:
  - `repositories` / `permissions` narrowing;
  - _"Installation tokens expire one hour from the time you create them."_
- GitHub REST, _Revoke an installation access token_, and _OAuth authorizations: delete an app token_.
- GitHub, _Permissions required for GitHub Apps_: `POST /repos/{owner}/{repo}/pulls` needs `pull_requests: write`.

**Reference products, as observed in their own documentation (2026-09-26).**

- **GitHub Copilot's cloud agent** authors commits itself, _"with the developer who assigned the issue … marked as the co-author"_, and opens the pull request as Copilot. That is the bot option, and it is what the Motir-created-repository branch does.
- **Google Jules** opens the pull request as Jules. That is also the bot option.
- **Devin** defaults to its bot but offers an admin setting _"Open PRs as: User only"_, which _"opens as the user, and fails if their git account is not linked"_. That is this decision's user-repository branch, refusal included.
- **OpenAI Codex cloud** appears to act through the user's connected GitHub account, but no official OpenAI document states the pull request's author, so it is not relied on here.

**Rejected alternatives:**

- **The bot option everywhere.** It is simplest, but the story's "authored as the dispatcher" would then be true only of the commits, never of the pull request.
- **A user token with a bot fallback when not linked.** It silently changes who authored the work depending on a setting the dispatcher cannot see from the card. A refusal says what to do.

**Permissions.** Opening a pull request needs `pull_requests: write` under both branches, so the Motir Agent App needs **`contents: write` + `pull_requests: write`**. MOTIR-1894's title currently says _`Contents: write` — the ONLY permission_, and that is amended (Consequences).

**`workflows: write` is deliberately NOT requested.** A token holding it lets an autonomous agent rewrite the CI that runs with the repository's secrets. A run whose change touches `.github/workflows/` therefore fails at push. GitHub refuses it with _"refusing to allow a GitHub App to create or update workflow … without `workflows` permission"_, and that message becomes the run's failure reason.

### 5 · Timeout and stall

- **Wall-clock timeout: 90 minutes.**
  - The planning corpus caps a leaf's agent run at 60 minutes, and a card sized past that is split before it is dispatched.
  - To that add clone, dependency install, codegraph index, push and pull request. This is an allowance of up to 30 minutes, not a measured figure; the dogfood story (MOTIR-714) measures real runs, and the value is revisited if they disagree.
  - 90 minutes lets a correctly sized card finish, and stops a runaway one at 1.5× its budget. The seam's own ceiling, `HOSTED_AGENT_MAX_TIMEOUT_MS` (12 hours), is a spend backstop, not a target.
- **Stall window: 15 minutes with no agent output.**
  - "Output" is any line OpenCode writes to stdout or stderr, forwarded by the entrypoint as `log` events. The watchdog reads the time of the run's latest event.
  - The entrypoint sends **no heartbeat**: a heartbeat would prove the container is alive, and the watchdog exists to catch an agent that is alive and stuck.
  - 15 minutes clears the longest silent step a normal card runs, a full local test file or a cold dependency install, while ending a hung agent within a sixth of the budget.

Every credential's expiry is derived from the timeout: the run key's `expiresAt`, the run token's `expiresAt`, and the git credential's (bounded by GitHub's 8 hours or 1 hour, both longer). Nothing a run holds can outlive it by more than the 5-minute settle margin.

### 6 · motir-core's configuration names

| Name                        | Holds                                                                                   | Notes                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `MOTIR_GATEWAY_URL`         | the gateway's origin, no trailing `/v1`                                                 | the same name and meaning as the gateway's egress contract, so the container receives it verbatim                      |
| `MOTIR_RUN_KEY_MINT_SECRET` | the mint secret                                                                         | the same name the gateway reads, character for character                                                               |
| `MOTIR_HOSTED_AGENT_IMAGE`  | `ghcr.io/moooon-b-v/motir-hosted-agent@sha256:…`                                        | **a digest, never a tag**, so a publish cannot change what a running deployment boots                                  |
| `MOTIR_HOSTED_AGENT_MODEL`  | an override of the model §7 decides, as the gateway's bare model id (`claude-opus-4-8`) | optional; unset means §7's default. Passed to the key's `models` allow-list as is, and to OpenCode as `anthropic/<id>` |

All four are server-only: no public-env prefix, and never serialized to the browser.

### 7 · The model: `claude-opus-4-8`, one per deployment, chosen by Motir

**Why the run has a model chosen for it at all.** Something has to name one, and it cannot be OpenCode or the container:

- OpenCode is started with `OPENCODE_DISABLE_MODELS_FETCH=true` and runs as `opencode run --model <provider/id>` (motir-gateway `docs/hosted-run-egress.md`, container environment). It has no catalog to fall back on, so a run with no model named does not start.
- The run key is minted with a `models` allow-list, and the gateway refuses any other model with `403` (egress contract §1 and its threat table, `middleware/auth.go`). That allow-list is what stops an exfiltrated key from being spent on a dearer model, so the minter must know the model **before** the container boots.
- motir-ai debits every turn at the model's effective `ModelCreditRate` in the `agent` lane, and `debitForTurn` throws when the model has none (`src/llm/gatewayClient.ts`, the comment on `PLANNER_MODELS`). A model with no rate is a run whose first call fails.

So the model is a property of the run that motir-core fixes at start, the same way it fixes the run's id and timeout.

**The decision.** Every hosted run uses **`claude-opus-4-8`**. It is a code default in motir-core (a `HOSTED_AGENT_MODELS.default` constant beside the start path, in the shape of motir-ai's `PLANNER_MODELS`), and `MOTIR_HOSTED_AGENT_MODEL` overrides it per deployment. There is one model per deployment, and no person picks it per run.

**The eligible set** is the intersection of three records, read 2026-09-26:

| Model               | Rated in the `agent` lane (motir-ai, MOTIR-4487) | Served by the gateway's Anthropic channel (`ai-upstream-transfer-basis.md`, channel set) | Input credits / M tokens (planning-rate base, which the agent lane copies) |
| ------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `claude-fable-5`    | yes                                              | **no**                                                                                   | 23.0                                                                       |
| `claude-opus-4-8`   | yes                                              | yes                                                                                      | 11.5                                                                       |
| `claude-sonnet-4-6` | yes                                              | yes                                                                                      | 6.9                                                                        |
| `claude-haiku-4-5`  | yes                                              | yes                                                                                      | 2.3                                                                        |

DeepSeek is rated but has no transfer basis for prompt content (`ai-upstream-transfer-basis.md`), and a hosted run sends the customer's code, so it is out.

**Why Opus rather than Sonnet.**

- **A hosted run is paid for whether it succeeds or not.** Its cost is tokens plus up to 90 minutes of machine time (§5), and nobody watches it. A failed run spends all of that and then returns the card to To Do (§2) for a second full run. Sonnet's saving is 40% of the token cost of one run; it is gone the first time a run Opus would have finished has to be dispatched twice.
- **It is the model Motir already stands behind.** The planner that sizes these cards runs on `claude-opus-4-8` (MOTIR-3635), so a hosted card is executed by the same model class that decided it fits one run.
- **It is the dearest model the gateway serves today.** Fable 5 would need a channel change and a transfer-basis re-read first, and doubles the rate. That is a separate decision with its own evidence.

This is a judgement, not a measurement. The dogfood story (MOTIR-714) measures real runs, and this default is revisited if the success rates show Sonnet finishing the same cards.

**Rules any value of the override must meet**, so an operator cannot set a broken one:

- It is a **bare gateway model id** (`claude-opus-4-8`). The key's `models` list and the gateway both compare the request's bare id, so the start path passes it as is and prefixes `anthropic/` only for OpenCode's `--model`. Storing the prefixed form would put `anthropic/claude-opus-4-8` on the allow-list, and every call would be refused `403`.
- It must have an effective `agent`-lane rate in motir-ai, and it must be served by a channel with a transfer basis. Neither is checked at boot in 9.1. A wrong value fails the run's first call and closes it as `failed`, which the panel shows.

**The model is recorded.** The start path stamps it on the card as `implementationModel`, beside `implementationHarness: opencode` (§2), so the card says which model built it. The run key's allow-list and motir-ai's usage record carry it for billing.

**Rejected.**

- **The dispatcher picks per run, or the organization picks in settings.** A model picker is a price picker, and it needs a design, a surface and a rule for what a cheaper model is allowed to attempt. Story 9.1 has none of these, and "choosing among agents" is outside it (below).
- **Use the egress contract's example, `claude-sonnet-4-5`.** It was an example of the flag's shape. It has no `ModelCreditRate` in motir-ai, so a run on it would fail its first debit.
- **Leave it to configuration only, with no code default.** A missing value would then be a deployment that cannot run hosted at all. The code default makes the variable an override, as `PLANNER_MODEL` is.

---

## Consequences

- **Every consumer builds against one id and one vocabulary**, and the story's contract guards (no hosted-only status or event, no cost column on `DispatchRun`) are checkable against this document.
- **A dispatcher who has not linked GitHub cannot run hosted on their own repository** until they do. That is a real setup step, and it is the price of the pull request being theirs.
- **Owed on acceptance of this decision** (its close-out, filed as work, not done here):
  1. **Amend MOTIR-1894**: the Motir Agent App requests `contents: write` + `pull_requests: write`, never `workflows: write`, and enables user authorization ("Request user authorization (OAuth) during installation" plus expiring user tokens). Its title's "the ONLY permission" becomes false.
  2. **A "Link your GitHub account" surface**: a `design` card and a `code` card under 9.1. It covers where a person authorizes the Motir Agent App for their user and where the run's refusal sends them. MOTIR-6449 (the git credential) reads the stored authorization; it does not build the surface.
  3. **MOTIR-6449's criteria are amended** to the split above: a user token narrowed by `repository_id` for a user-owned repository, and a narrowed installation token for a Motir-created one.

---

## What this does NOT decide

- **The orchestrator, the fleet, the machine size or its price.** These are MOTIR-1918 and MOTIR-4336, plus AI economics.
- **The gateway's contract, or how usage is billed.** These are Story 9.0 and `docs/hosted-run-egress.md`.
- **Several hosted runs at once, a queue, or choosing among agents.** These are out of Story 9.1.
- **A model choice per organization, project or card**, or how a cheaper model's runs would be priced or limited. §7 fixes one model per deployment and nothing finer.
- **Network-level egress enforcement.** The lock is the credential (egress contract §4).
- **What a _local_ run's card becomes on failure.** Only hosted runs are decided here.
- **How a hosted run is re-run automatically after a design is sent back.** That is Story 9.2, which calls the start path this document's §1–§3 describe.
- **Whether Motir-created repositories ever move to user-authored pull requests.** That belongs to repository handover (MOTIR-711), not here.
