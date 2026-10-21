# ADR: Running a card in your agent — a detached launch through the agent's terminal server, the run's credentials off the agent's home, and a run that always ends

- **Status:** Proposed (2026-09-30), for acceptance at this card's `decision_approval` gate
- **Card:** MOTIR-7021 · **Story:** MOTIR-6864 (_Send a ready card to one of your instances_) ·
  **Epic:** MOTIR-6859
- **Answers** the line _"Running a card in an instance — MOTIR-6864's"_ under _What this does NOT
  decide_ in [`agent-instances.md`](agent-instances.md), and _"a run's credential is MOTIR-6864's"_ in
  [`agent-terminal.md`](agent-terminal.md). Both files are left unedited.
- **Consumed by** (every sibling in the story reads it):
  - MOTIR-7022: the design delta (§4's refusal set, §6's run states)
  - MOTIR-7023: the run record (§5)
  - MOTIR-7024: `motir run` inside an agent (§2, §3)
  - MOTIR-7025: the terminal server's launcher (§1, §2, §4)
  - MOTIR-7026: the start service and its route (§1, §4, §5)
  - MOTIR-7027: the lifecycle couplings (§6)
  - MOTIR-7028, MOTIR-7029: the card control and the My agents panel (§4, §6)
  - MOTIR-7030, MOTIR-7031: the story test gate and the E2E, through the above
  - Also read by MOTIR-6948 and MOTIR-6952 (the image update), which refuse during a run (§5, §6)
  - Added by MOTIR-8981 (AMENDMENT 2), read by the siblings of MOTIR-9055:
    - MOTIR-9045, MOTIR-9050: the run mode and the terminal server that acts on it (§7, §8)
    - MOTIR-9046, MOTIR-9052: the last-run read and `motir fix` in an agent (§7)
    - MOTIR-9049: the claim a fix in an agent opens, and releases on give-up (§7)
    - MOTIR-9043, MOTIR-9047, MOTIR-9051, MOTIR-9058, MOTIR-9053: the door's drawing, words and control (§9)
    - MOTIR-9054, MOTIR-9060: the automatic fix and its setting (§9)
    - MOTIR-9048, MOTIR-9059: the fix during a run, in the watch's other lanes (§7)
    - MOTIR-9056, MOTIR-9057: the E2E and the story gate (§7 to §9)
- **Supersedes:** none.
- **Evidence refs:** rung-2 paths were read at `origin/main` **`7550573`** (after the MOTIR-6861
  merge, #3270). Rung-1 sources were read on **2026-09-30**. §7 to §9 and AMENDMENT 2 (MOTIR-8981)
  were written against `origin/main` **`64932d347`** on **2026-10-19**.

---

## Context

A developer's agent is a Fly Machine with a volume at `/home/node`, owned by one person, on one
project, signed in to a coding agent with that person's own vendor account
([`agent-instances.md`](agent-instances.md) §1, §8, §9). It runs `motir agent-terminal serve`, which
holds PTY sessions the panel attaches to through `motir-relay` ([`agent-terminal.md`](agent-terminal.md)
Q2 to Q5). Separately, a card can already be run hosted: the server opens the `DispatchRun`, the CLI in
a container ADOPTS it, a run-bound `ApiToken` authenticates it, and the git-credential route hands it
tokens as Motir's App ([`hosted-agent-run.md`](hosted-agent-run.md) §1, §3;
[`hosted-run-runs-the-cli-as-the-app.md`](hosted-run-runs-the-cli-as-the-app.md)).

This record decides how a card runs inside the developer's agent. What the code says today:

1. **`DispatchRunOrigin` is `local | hosted`** (`prisma/schema.prisma`), and
   [`dispatch-run-record.md`](dispatch-run-record.md) Q3.3 forbids any usage, token, credit or cost
   column on the run.
2. **`exec` is synchronous.** `PersistentContainerOrchestrator.exec(handle, command, {timeoutSeconds})`
   (`packages/orchestrator/src/types.ts`) is Fly's `POST /machines/{id}/exec`, returning
   `{exitCode, stdout, stderr}`. It runs as root, which is why the clone wraps itself in `runuser -u
node` (`lib/agentInstances/cloneCommand.ts`).
3. **The terminal server knows nothing about runs.** It holds in-memory `node-pty` sessions, at most
   `MAX_SESSIONS = 4`, and a fifth `open` reaps the longest-detached one
   (`packages/cli/src/agentTerminal/server.ts`). It listens only on `0.0.0.0:7681`, behind the relay
   token.
4. **Sign-in is `checkSignIn`** (`agentTerminal/signIn.ts`): an `fs.stat` of each profile's
   `credentialPaths`. `claude`, `codex` and `opencode` answer signed in or not; `kimi`, `aider` and
   `goose` answer `unknown`. The state is pushed only as a WebSocket `signin` frame and stored nowhere.
5. **No profile carries an agent command** (`packages/cli/src/agentProfiles.ts`). `resolveAgent`
   (`commands/dispatch.ts`) launches the hosted OpenCode agent on the gateway whenever a run id is
   present, unless `--agent` is passed. The unattended flags are verified per profile in
   `packages/cli/sandbox/README.md`, _Auto-approve flags_.
6. **`prepareHostedRun`** (`packages/cli/src/hostedGit.ts`) writes the run credential to a 0600
   `run.json`, a credential helper into a run-private `GIT_CONFIG_GLOBAL`, and a `gh` shim, all in a
   `mkdtemp` directory under `tmpdir()`. It puts no credential in the environment.
7. **An adopted run reports log bodies** (`reportLogBodies: … || Boolean(input.adoptedRunId)`,
   `commands/dispatch.ts`), and the CLI's reporter heartbeats every run it holds, whatever its origin
   (`dispatchRunReporter.ts`). The lapse reap closes only `origin: 'local'` runs
   (`dispatchRunRepository.ts`), and `isRunAlive` treats every hosted run as alive
   (`lib/runs/runLiveness.ts`).
8. **The agent boots from a pinned `imageDigest`**, and the boot probe records `terminalServer` once
   per digest (`probeTerminalServer`, `agentInstanceLifecycleService.ts`). A CLI change reaches an
   existing agent only when it moves to a newer image (MOTIR-6862).
9. **`WorkItemImplementationSource` is `hosted | byok | manual`.**

Rung-1 facts:

- **Fly's exec takes stdin.** The Machines API client's request type is `MachineExecRequest { Cmd,
Stdin, Timeout, Container, Machine }`, and its response is `{ exit_code, stdout, stderr }` (superfly,
  `fly-go`, `machine_types.go`, https://github.com/superfly/fly-go/blob/main/machine_types.go). Fly's
  own Machines API reference page does not document exec at all, so the client is the source.
- **Coder's AgentAPI runs a coding agent inside the workspace, behind a terminal the user can
  attach to.** It runs _"an in-memory terminal emulator"_ that _"translates API calls into
  appropriate terminal keystrokes"_, and `agentapi attach` connects to _"a running agent's terminal
  session"_ (Coder, `coder/agentapi` README, https://github.com/coder/agentapi). The repository is
  archived as of September 2026.
- **Coder's newer Agents product runs the loop in the control plane instead**: _"The agent loop runs
  inside the control plane"_, which executes tool calls _"by connecting to a Coder workspace over the
  existing workspace connection"_, and _"LLM provider credentials never enter the workspace"_ (Coder,
  _Coder Agents_ and _How Coder Agents Tasks Work_, https://coder.com/docs/ai-coder/agents and
  https://coder.com/docs/ai-coder/tasks-lifecycle).

The second Coder shape is not open to Motir. The model calls must be made by the vendor's own binary on
the developer's own sign-in, inside the developer's machine, because Motir may not intermediate that
credential ([`agent-instances.md`](agent-instances.md) §9, condition 4). So the first shape is the
reference: the agent process lives in the workspace, a control starts it, and the person can attach to
it.

## Decision

### §1 · The launch — a short `exec` that asks the terminal server to open a detached run session

**Motir starts a run with one Fly `exec` of a short local command. That command asks the running
terminal server to open a run-tagged PTY session running `motir run`, and returns at once.**

- **The command:**

  ```
  runuser -u node -- env HOME=/home/node motir agent-terminal run <KEY> --run-id <dispatchRunId>
  ```

  It runs with an exec timeout of 30 seconds and reads its credentials on **stdin** (§2). It exits `0`
  with `{"session":"<uuid>"}` on stdout once the session exists. The run's own exit is not awaited.

- **How the launcher reaches the server: a local control socket**, not the relay port. The server
  creates `/tmp/motir-agent-terminal/control.sock` at start, in a `0700` directory owned by `node`, on
  the rootfs. The launcher and the server speak one JSON request and one JSON answer over it. Port 7681
  and its relay token are unchanged.
- **The run session:**
  - It runs `motir run <KEY> --run-id <id>` in `$HOME/workspace`, with the server's own environment
    minus `MOTIR_TERMINAL_KEY` (as every shell gets), plus `MOTIR_HOSTED_STATE=<state dir>` (§2) and
    `MOTIR_AGENT_RUN=1`, which puts the CLI in agent mode (§3).
  - It is **tagged with its run id**, and there is **at most one** per agent. A second `run` request
    while one exists is refused `run_active`.
  - It is **never reaped** by the four-session limit and does not count toward it. The developer's own
    four shells are unchanged.
  - It is **watch-only.** A connection attached to it receives its output and its replay ring as any
    session does, but its input frames are dropped. Resize is applied. Cancel (§6) is how a person
    stops it, never a keystroke.
  - It is **listed** to every connection on attach, so the panel can offer it beside the developer's
    own shell (MOTIR-7029). Motir stores no session id.
- **Stop:** `motir agent-terminal stop --run-id <id>`, the same way. The server sends `SIGTERM` to the
  session's process group, then `SIGKILL` after 10 seconds, and answers `stopped` or `not_found`. Both
  are success to the caller.
- **Probes:** `motir agent-terminal signin` prints `{"profile","state"}` from the same `checkSignIn`
  the panel sees (§4). `motir agent-terminal run --help` exiting `0` is the image-capability probe (§4).

**Rejected:**

- **(a) An `exec` of `motir run` itself.** The exec blocks for the whole run and times out, and the
  run is in no session the terminal can attach to, so the developer cannot watch it.
- **(c) A new relay-borne control frame from Motir to the server.** It puts the relay, which today
  carries only a person's WebSocket and holds no Fly token, on the start path. It also needs a
  WebSocket client inside motir-core, which ships none. `exec` is a door motir-core already uses.
- **The launcher speaking to port 7681.** It would need the relay's per-instance key, which is kept
  out of every shell's environment on purpose ([`agent-terminal.md`](agent-terminal.md) Q3).

**What (b) forecloses:** a run can only start on a machine that is `running` with a current image. A
hibernated agent is woken first (§4), and an image without the launcher is refused (§4).

### §2 · The run's credentials — stdin, a run-private directory on the rootfs, and nothing in the home

**The run holds two credentials:** the run-bound `ApiToken` ([`hosted-agent-run.md`](hosted-agent-run.md)
§3, minted exactly as for a hosted run, `HOSTED_RUN_TOKEN_GRANT`) and the per-repository App tokens
from `POST /api/v1/dispatch-runs/{id}/git-credential`. Motir mints **no gateway key** for this run.

**Where they live:**

| credential         | where it is                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the run token      | the exec's **stdin**, then a `0600` `run.json` in a `0700` state directory `/tmp/motir-run-<runId>/`, written by the launcher before it asks for the session                                |
| the App git tokens | fetched on demand by the credential helper through that same state directory's `gitconfig`, cached in its `0600` `credentials.json` as `prepareHostedRun` already does                      |
| the git config     | `GIT_CONFIG_GLOBAL=/tmp/motir-run-<runId>/gitconfig`, set only in the run session's process tree; `gh` reaches GitHub only through the run's shim, which sets `GH_TOKEN` for one invocation |

**Where they never are:**

- **Not in any environment variable.** Only the state directory's PATH is in the session's
  environment, never a token.
- **Not in any long-lived `argv`.** The launcher's own argv carries the run id and the card key, neither of which is a secret. (See the amendment below for the one exec wrapper that holds the token.)
- **Not in `$HOME`.** `/tmp` is on the rootfs, which is reset on every wake
  ([`agent-instances.md`](agent-instances.md) §1), so nothing survives a stop even if the run was
  killed.
- **Not in `~/.gitconfig`, and not in the developer's `gh` auth** (`~/.config/gh`). The run never
  writes either. The developer's own shells keep their own git identity and credentials.

**The run's checkouts** are separate from the developer's. `MOTIR_WORKSPACE` points at
`$HOME/.motir/runs/<runId>`, where the CLI's existing materialize clones each repository with the
App's token and a plain `origin`. The developer's `$HOME/workspace/<repo>` checkouts, and any
uncommitted work in them, are never touched. The run directory holds code and no credential, and it is
removed when the session exits. The work survives on the pushed branch
([`run-death-keeps-work.md`](run-death-keeps-work.md)).

**When each dies:**

- The server removes the state directory and the run directory when the session's process exits,
  however it exits.
- Every close of the run revokes the run token (the row is deleted, as for every PAT) and the App
  tokens, through the same end path a hosted run uses (§6). A process still holding them is then
  refused by Motir and by GitHub.
- The token's `expiresAt` is the run's start + 12 hours + 5 minutes, the backstop plus the settle
  margin, as for a hosted run. Nothing outlives the run by more than that.

**Same-uid is not a privilege boundary, and this record does not pretend it is.** The developer's
shell and the coding agent run as `node`, as the run does, so either could read the state directory
while the run is live. That is `hostedGit.ts`'s position, restated for a machine the developer uses:
the bound is each credential's scope (one run's ingest, one card's prompt, the run's repositories),
its life, and its revocation at close.

**Rejected:**

- **(a) Environment variables on the launch.** A long-lived session's environment is readable in
  `/proc/<pid>/environ` for its whole life, is inherited by everything the agent spawns, and an agent
  printing `env` writes it into a transcript.
- **(c) A file in the home.** It survives hibernation, sits beside files the developer syncs and
  backs up, and outlives a killed run.
- **The developer's own `gh` login for the push.** It would make the pull request depend on a
  credential Motir cannot see, scope or revoke, and a run on a repository the developer cannot push to
  would fail late. The App path is the hosted run's, with its authorship rules
  ([`hosted-agent-run.md`](hosted-agent-run.md) §4), and its pre-flight refuses an unwritable
  repository before anything starts (§4).

### §3 · The coding agent's command — `agentCommand` per profile, and a refusal where there is none

**Each profile in `agentProfiles.ts` gains `agentCommand`: the vendor's unattended form, or `null`.**
In agent mode (`MOTIR_AGENT_RUN=1`), `motir run` launches the profile named by the image's
`MOTIR_SANDBOX_AGENT` with that command. It does not read `MOTIR_AGENT` or the user config, and it
never falls back to the hosted OpenCode agent.

| profile       | `agentCommand` (from `sandbox/README.md`'s verified matrix)                          | prompt      |
| ------------- | ------------------------------------------------------------------------------------ | ----------- |
| `claude`      | `claude -p --dangerously-skip-permissions`                                           | stdin       |
| `codex`       | `codex exec --sandbox workspace-write --ask-for-approval never`                      | stdin       |
| `opencode`    | `opencode run --auto`                                                                | as argument |
| `kimi`        | `kimi -p`                                                                            | as argument |
| `aider`       | `aider --yes-always --message`                                                       | as argument |
| `goose`       | `goose run --no-session -t`, with `GOOSE_MODE=auto` added to the agent's environment | as argument |
| `antigravity` | `null` (not offered, [`agent-instances.md`](agent-instances.md) §9)                  | —           |
| `cursor`      | `null` (not offered)                                                                 | —           |

- **Verified at build, not asserted here.** The flags drift between releases (the README's own
  warning). MOTIR-7024 re-checks each against `<agent> --help` in the built image, and a mismatch is
  fixed there without amending this record.
- **The agent's environment is the session's own**, extended and never replaced: it needs the
  `CLAUDE_CONFIG_DIR` / `CODEX_HOME` the entrypoint set, which is where its sign-in is. Nothing added
  narrows or replaces a sign-in method: no `ANTHROPIC_API_KEY`, no `OPENAI_API_KEY`, no gateway URL
  ([`agent-terminal.md`](agent-terminal.md) Q9, requirement 2). The binary is started as the image
  installed it (requirement 1).
- **A profile whose `agentCommand` is `null` is refused** before anything starts, as
  `agent_profile_cannot_run` (§4). Today that is only the two profiles no agent can be created with,
  so the refusal is reachable only by a future profile added with no unattended form.

**AMENDMENT (MOTIR-8980) — the command a run launches is the profile's STREAMING form where it has
one.** `agentCommand` stays the plain-text form, but `claude -p`, `codex exec` and the rest print
nothing until the turn ends, so a run in a developer's agent showed no Agent output for the
whole of the work. Each profile with a headless stream now carries `agentStream` beside it, taken from
[`agent-chat.md`](agent-chat.md) Q1/Q3 (the Chat tab's flags, so the two cannot drift), and `motir run`
launches that: `claude -p --output-format stream-json --verbose …`, `codex exec --json …`,
`opencode run --format json …`, `kimi --output-format stream-json -p`, and `goose run -q --output-format
stream-json -i -` (without `--no-session`, so there is a session to resume). `aider` has no stream and
keeps `agentCommand`.

- **The log is readable lines, never the event objects.** `runAgent` reads the stream with the profile's
  own chat adapter and writes the reply text, one line per tool call (`Edit lib/x.ts`, `Bash: pnpm test`)
  and a line for each failure, to the terminal and to the run's `log` events alike.
- **The run records the agent's session id** — `data.sessionId` on `agent_started` where Motir chose it
  (`claude --session-id`), on `agent_exited` always (from the stream, else the agent's own session store
  for the run's checkout) — and each profile carries `resumeArgs(sessionId)` for a later fix to continue
  that conversation.
- **`MOTIR_AGENT_OUTPUT=text` forces the plain form** for a CLI version that refuses the stream flags.

**Rejected:** **(b) asking the developer to configure a command per agent.** It adds a setting whose
wrong value is found only when a run hangs at a prompt, and the verified matrix already exists.

**What (a) forecloses:** a developer cannot run a card with a custom agent command in their agent from
the card. They can still run `motir run` by hand in the terminal, which is a local run (§5).

### §4 · Starting: the checks, the probes, and the refusal set

**The route is `POST /api/work-items/[id]/agent-runs`** with `{ agentInstanceId, idempotencyKey }`,
beside the hosted route. **`GET /api/work-items/[id]/agent-runs/agents`** lists the caller's own
agents on the card's project, with whether each can run it and, if not, why. Only the owner can start a
run in an agent, and only by pressing the control. Nothing in Motir starts one on its own.

**Sign-in, and the image's capability, are read without waking the machine:**

- **Two probes, recorded on the agent.** `runLauncher` (`present | absent`) with the digest it was
  probed for, and `signInState` (`signed_in | signed_out | unknown`) with its time.
- **When they are probed:**
  - at every boot settle, beside the shipped `terminalServer` probe (`runLauncher` once per digest,
    `signInState` every boot);
  - by the start itself, on a `running` agent, with a synchronous `exec` of
    `motir agent-terminal signin` (10-second timeout) from the START SERVICE, never from the relay,
    so [`agent-terminal.md`](agent-terminal.md) Q7's rejection of a relay-side exec stands;
  - best effort, just before the machine is stopped by any hibernate.
- **Why a recorded sign-in is trustworthy for a hibernated agent:** the credential file is on the
  volume, and nothing can change the volume while the machine is stopped. The last state recorded
  while it ran is its state now. A probe that could not answer leaves the previous value.
- **`unknown` may start.** Three profiles can never answer, and an agent that was never probed has
  nothing to go on. The live probe after the wake is the net (§6).
- **An agent never probed for its current digest reads as too old.** Every boot after this record's
  code ships probes it, and a digest is fixed at create, so an agent with no record for its digest was
  last booted before the launcher existed. Its image cannot carry the launcher, which ships in a later
  CLI release (MOTIR-7032). The one move that could change a digest without a boot is MOTIR-6862's
  image update; it owes the probe for the digest it moves to (_Owed on acceptance_).

**The start's order.** Every check before "open the run" refuses in words and opens no run, claims no
card and starts no machine:

1. the caller's project access (`instance:use`, and edit on the card);
2. the agent is the caller's, not deleted, on the card's project;
3. the card is ready: a leaf by the keyed claim's rule, a parent of leaves by the scope claim's, as
   the hosted start reads it;
4. the agent has no running run;
5. the image has the launcher, and the profile has an `agentCommand`;
6. the agent is not recorded `signed_out`;
7. every repository of the run can be written by Motir's App (the hosted pre-flight, reused);
8. if the agent must be woken, the credit pre-flight the wake itself calls.

Then, and only then: **open the run** (§5), claim and stamp the cards, mint the run token, and hand the
rest to a durable launch job. The route answers with the run id at once. The job wakes the agent if
needed, waits for `running`, probes sign-in and the launcher live, and runs the §1 exec.

**The refusal set**, each with its code and status:

| refusal                                                                                     | code                                                                                                                                   | HTTP                                           |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| no `instance:use`, or no edit on the card                                                   | `permission_denied` (existing)                                                                                                         | 403                                            |
| not the owner, or the agent does not exist or is deleted                                    | `agent_instance_not_found` (existing), the same answer for all three so nothing leaks about another person's agent                     | 404                                            |
| the agent is on another project                                                             | `agent_instance_wrong_project`                                                                                                         | 409                                            |
| the card is not ready                                                                       | `agent_run_card_not_ready`, naming why (its status, or an open blocker)                                                                | 409                                            |
| a run is already running in the agent                                                       | `agent_instance_run_active`, carrying that run's id and card key so the words can name it                                              | 409                                            |
| the image predates the launcher                                                             | `agent_instance_image_too_old`                                                                                                         | 409                                            |
| the profile has no unattended command                                                       | `agent_profile_cannot_run`                                                                                                             | 409                                            |
| the coding agent is not signed in                                                           | `agent_not_signed_in`                                                                                                                  | 409                                            |
| a repository the App cannot write                                                           | `hosted_repository_not_writable` (existing)                                                                                            | 409                                            |
| the agent is `hibernating` or `deleting`                                                    | `agent_instance_state_conflict` (existing)                                                                                             | 409                                            |
| **the wake's refusals, passed through unchanged** from `agentInstanceLifecycleService.wake` | `agent_instance_start_refused` with `reason: credits` · `credits_unknown` · `fleet_busy`; `agent_instances_unavailable` (all existing) | 402 · 503 · 429; 503 (`mapAgentInstanceError`) |

A `starting` or `waking` agent is not refused: the launch job waits for it, as it waits for its own
wake.

**Rejected:** **(b) persisting the last `signin` frame the relay forwarded.** It is only written while
somebody has the terminal open, so it is stale exactly when the agent has been left alone, which is when
a run is most likely to be started. The probes above are taken by the server at every boot and stop,
whether or not anyone looked. **Image capability (b), try and fail**, starts a billed machine to learn
something a recorded probe already knows.

**What this forecloses:** a refusal after the machine has started is possible in exactly one case: an
agent whose sign-in was never recorded, woken and then found `signed_out` by the live probe. That run
is closed `failed` with the words _"the coding agent is not signed in"_ (§6).

### §5 · The record — `origin: instance`, the agent on the run, and one running run per agent

- **`DispatchRunOrigin` gains `instance`.** A run in an agent is neither `local` (it runs on Motir's
  machine, started from Motir, supervised by Motir) nor `hosted` (it has no gateway key, no model
  Motir chose, and no container of its own).
- **`DispatchRun.agentInstanceId`**, nullable, is a modelled `@relation` to `AgentInstance` on both
  sides, `onDelete: SetNull`. An agent row is never hard-deleted ([`agent-instances.md`](agent-instances.md)
  §4), so the name stays readable on a run whose agent was deleted.
- **`agent` = the profile id** (`claude`, `codex`, …), and **`model` = null**: the model is whatever the
  developer's own agent is set to, and Motir does not read it.
- **At most one `running` run per agent, enforced by the database:** a hand-written partial unique
  index on `dispatch_run (agent_instance_id) WHERE status = 'running'`. Two concurrent starts both
  pass the service's check; the loser's insert fails with `P2002`, which the service translates to
  `agent_instance_run_active`, naming the winner. The index is inexpressible in the datamodel, so no
  `@@index` or `@@unique` may claim the same column list (`CLAUDE.md`, the partial-index rule).
- **The active-run read by agent** (`findRunningByAgentInstance`) is a repository read the start,
  Hibernate, Delete, the idle check and the image update (MOTIR-6952) share.
- **The DTO** carries `agentInstance: { id, name, profile, profileLabel } | null`, so the run section and
  the run modal can say _"yue-claude · Claude Code"_. Every `switch` or ternary on `origin` is made
  total over the new value, including `isRunAlive` and the continue service's origin mapping.
- **The stamp on the cards is `implementationSource: byok`** with `implementationHarness` = the
  profile. A run in an agent is the developer's own subscription, which is what `byok` already means,
  and a new source value would be a second word for it. The CLI's own provenance seam writes the same.
- **The events are the shared vocabulary.** `run_opened` carries `origin: 'instance'`, the agent id and
  the profile. The CLI emits `agent_started`, `log`, `agent_exited` and `delivery_linked` as it does
  for every adopted run. **No event kind and no status is added.**
- **The log.** An adopted run reports its log bodies, and so does this one. That is the CLI's run log:
  the agent's output as the CLI captures it, bounded and expired after 30 days as every log body is
  ([`dispatch-run-record.md`](dispatch-run-record.md) Q4). It is not a tap on the PTY: no byte of any
  terminal session, the run's session included, reaches Motir through the terminal path, so
  [`agent-terminal.md`](agent-terminal.md) Q8 stands unchanged.
- **The charge is machine time only.** The agent's open interval already charges every running minute
  ([`agent-instances.md`](agent-instances.md) §5, AMENDMENT 2). **No gateway key is minted, no
  `AgentRunUsage` row is written** (that table is a hosted run's machine cost, written by
  `debitAgentMachine` against a `coreRunId`, and an interval charge writes none, §5), and the run gains
  no usage, token, credit or cost column ([`dispatch-run-record.md`](dispatch-run-record.md) Q3.3).
  The run holds no fleet slot of its own; the agent's interval holds one.

**Rejected:** **(b) a side table** for the agent link. The run already has one discriminator for who
executed it, and a side table would make the one-running-run rule a cross-table check the database
cannot enforce. **A new `WorkItemImplementationSource`**, for the reason above.

### §6 · The live run and the lifecycle — every path ends in a closed run

**Liveness.** The CLI in the agent heartbeats as every run's CLI does, and the lapse reap is widened
from `local` to `local | instance`: an instance run silent for 5 minutes is dead. **A durable
per-run supervise job** (`agent-instance-run/supervise`), modelled on `hostedRunService.supervise` and
deferring itself on the same one-minute poll, checks each pass, in order:

1. the run has already closed: stop;
2. the agent is no longer `running` (hibernated, failed, lost or deleted): close the run `failed`,
   _"the agent stopped"_;
3. the latest event is older than **15 minutes** (the hosted stall window): stop the session and close
   `timed_out`, _"stalled: no agent output for 15 minutes"_;
4. the run has reached the **12-hour backstop**: stop the session and close `timed_out`.

**What each lifecycle action does while a run is running:**

| event                                                           | what happens                                                                                                                                                                                                                      |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the idle timer or the sweep's idle check                        | **skips the agent.** [`agent-instances.md`](agent-instances.md) §2 already counts _"no active run"_ as part of idle; the check now reads it. Run events also bump `lastActivityAt` through `touchActivity`, at most once a minute |
| the owner presses Hibernate                                     | **refused**, `agent_instance_run_active` (409), naming the run                                                                                                                                                                    |
| the owner presses Delete                                        | **refused** the same way                                                                                                                                                                                                          |
| the sweep's 12-hour backstop                                    | the run is closed `timed_out` first, then the agent hibernates as today                                                                                                                                                           |
| the sweep's credit refusal                                      | the run is closed `failed`, _"out of credits"_, first, then the agent hibernates. Money still bounds a machine that is running a card                                                                                             |
| the reconcile finds the machine `gone` or `failed` (lost)       | the run is closed `failed`, _"the agent's machine was lost"_, in the same pass                                                                                                                                                    |
| the owner presses Cancel                                        | the run is closed `cancelled` through the end path, then `motir agent-terminal stop` stops its session. **Only the owner** may cancel: nobody else can reach an agent ([`agent-instances.md`](agent-instances.md) §8)             |
| the launch job finds `signed_out` or no launcher after the wake | the run is closed `failed` with the refusal's words (§4)                                                                                                                                                                          |
| the image update (MOTIR-6862)                                   | refused during a run, by the active-run read (§5)                                                                                                                                                                                 |

**Every close revokes.** One end path, `agentInstanceRunService.end`, closes every instance run that
the CLI did not close itself: it revokes the run token and the App tokens, appends the closing `log`
line naming why, and closes the run. It mints and revokes no gateway key. A stop that cannot reach the
machine is not an error: its credentials are already dead, and its next heartbeat is refused `409`,
which the CLI already treats as closed.

**Cards keep their status on every end but success.** A run that opens its pull requests moves its
cards In Progress → Implemented, as the CLI does for every run. Every other end leaves the card where
the work left it, with the _run died_ marker, as [`run-death-keeps-work.md`](run-death-keeps-work.md)
§3 decided for every origin.

**Rejected:**

- **Heartbeat alone**, as a local run. A local run has a person at the machine who sees a hung agent;
  a run in an agent is on a machine that charges by the minute and may have nobody watching.
- **Stall alone**, as a hosted run. The CLI already heartbeats, and a dead CLI is caught in 5 minutes
  instead of 15.
- **Hibernating under a run and closing it.** Hibernate is a person's button, and a run silently dying
  under it looks like a failure of the run. Refusing names the run and lets the person cancel it first.

### §7 · The fix mode — a repair that resumes the run's own session

**A fix in an agent continues the conversation that built the branch; it does not start a new one.**
The CI-fix step of a watch re-enters the run's own recorded session with the fix prompt, so the prompt
arrives in the existing conversation. After a run has ended, a fix started from the door does the same
for the session that run recorded, when that run was in this same agent.

- **How a fix in an agent is started and adopted.** The door's press opens the `fix` run as the claim's
  lock, through the agent-run start with `command: 'fix'` (one of `AGENT_RUN_COMMANDS`: `run`, `fix`,
  `continue`). The launch carries `--command fix` to the agent's terminal server, which spawns
  `motir fix <KEY>` with `MOTIR_DISPATCH_RUN_ID` set to that run in the process's environment, and
  `motir fix` ADOPTS the run through the path the hosted lane already uses (`hostedRunId`,
  `packages/cli/src/hostedMode.ts`) instead of claiming a second time. There is no `--run-id` flag on
  `motir fix`. An adopted fix run in a person's agent admits the classes the door admits (`ci`,
  `acceptance_rerun` and `review`); the hosted lane's adopted repair still answers a `review` only.
- **What is resumed, and by what.** The profile table's own resume form and the session id a run
  records, both of which arrived with MOTIR-8980 (and MOTIR-8979 stopped the watch being killed as a
  stall). This record states that a resume happens and cites those cards for how; it carries no
  per-profile flag string and no per-profile evidence table, because the verification is MOTIR-9044's
  and a second copy would drift from it.
- **What happens instead when a profile has no resume form**, or when the recorded session cannot be
  resumed: a fresh agent process **on the same branch**, and the run says so in words. The fallback is
  a recorded outcome, never a silent one, and it is never a refusal of the fix.
- **The budget is unchanged.** `CI_FIX_ATTEMPTS = 5` (`packages/cli/src/ciWatch.ts`) bounds a fix exactly
  as it bounds a watch. The counter moves on a RED verdict only and is spent per run. A run that
  exhausts it gives up in words and leaves the door pressable again.
- **What the claim guarantees**, stated once here: at most one repair of a card at a time; the claim
  opens the `fix` dispatch run as its lock; a second press is refused naming the holder, and that
  includes the presser's own fix run in their own agent; giving up releases the claim, so the door
  offers again. The decision ORDER and the refusal vocabulary are `workItemRepairService.claimRepair`'s
  (and the claim card MOTIR-9049's for any admission change); this record states the guarantee and one
  source states the steps.

**Rejected:** **(a) cold-starting a separate agent for each fix.** It re-reads the repository and
re-derives the failure from a prompt, which is the copying a person does by hand today, paid for on
every iteration.

### §8 · The continue mode — a dead run's branch, in the same agent

**`continue` carries on work that already began, from the branch the dead run left, in a fresh session
of the same agent, and it is a different command from `fix` with its own claim.** A card whose pull
request is already open has nothing to continue, which is the shipped `use_fix` refusal
(`workItemContinueRefusalSchema`, `lib/api/v1/workLoop/schema.ts`). Running it inside the agent changes
where it runs, not what it claims or what it writes: the start's `command: 'continue'` reaches the
terminal server, which spawns `motir continue <KEY>` with `MOTIR_DISPATCH_RUN_ID` set, and
`motir continue` adopts that run exactly as its hosted path already does.

**Rejected:** **(a) one command that sometimes starts fresh and sometimes resumes.** No person could
predict which, which is the reason `continue` has its own name in the CLI.

### §9 · Fix in my agent — the offer, the states, and the one fix Motir starts itself

**The door is offered when a delivery's CI is red, no repair is claimed, and the viewer has an agent
they can use; it defaults to the agent the card's last run used.** Availability is decided on the
server, where whether the card's fix part offers at all is already computed, extended with the agent
question, so the control never offers what the claim would refuse and a card in the part's `hidden`
state offers no door.

The states the two doors (the Development block's fix part and the ended run's modal) must render are
named here and drawn by MOTIR-9043; their words are MOTIR-9047's:

| state the door shows                       | the fix part's shipped vocabulary                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| offered                                    | `offer`                                                                               |
| preparing (the press is being answered)    | none shipped; the door card (MOTIR-9053) adds it                                      |
| in progress                                | `in_progress`                                                                         |
| refused (another repair holds the card)    | `in_progress` with the holder named; refusal vocabulary is the claim's                |
| fell back to a fresh session               | none shipped; a line in the fix run's own output (MOTIR-9052), shown by the door card |
| gave up                                    | `offer` with `lastGaveUp`                                                             |
| settled, the pull request went green first | `hidden` (or `pointer`, as the part already decides)                                  |

**The one exception to "a person presses it."** Behind a project setting that is off by default, a
delivery set reported red starts the fix in the card's own agent by itself, when three things hold:
the setting is on, that agent is up (running, never woken for this), and the repair is free. In every
other case it does nothing, silently. The trigger and its setting are MOTIR-9054's and MOTIR-9060's;
this record states only that the exception exists, its conditions and the correction it forces to §4.

**Rejected:** **(a) offering the door for any card with a pull request.** A green pull request has
nothing to fix and a claimed one would be refused. **(b) starting an automatic fix for anyone but the
card's own agent.** The start spends the agent owner's credits on a machine only they own.

## Consequences

- **The run's machine time is the agent's interval.** A developer running a card pays for the minutes
  the agent was running, as if they had typed the command themselves, and nothing else.
- **The sandbox image changes:** the terminal server gains the control socket, the run session and the
  three subcommands. Only agents on the newer image can run cards, so every agent created before
  MOTIR-7032's release reads _image too old_ until MOTIR-6862 moves it.
- **The run's checkouts cost volume space while it runs**, inside the fixed 10 GB volume
  ([`agent-instances.md`](agent-instances.md) §3). A volume too full to clone fails the run in words
  from the CLI.
- **A `motir run` the developer types by hand in the terminal is a `local` run** on their own PAT. It is
  not counted as the agent's running run and is not supervised. The two can run side by side, in
  separate checkouts.
- **Image currency, restated for the fix and continue modes (MOTIR-8981).** An agent boots from the
  digest it pinned, so neither the fix door nor the continue mode works on a production agent until its
  image carries the CLI that has them; an agent on an older image runs a `fix` or `continue` start into
  the same _image too old_ refusal §4 already gives a `run`.

**Which card acts on each section:**

| section | card(s)                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| §1      | MOTIR-7025 (socket, run session, `run`, `stop`, probes) · MOTIR-7026 (the exec)                                                 |
| §2      | MOTIR-7024 (agent mode's state directory and workspace) · MOTIR-7025 (the launcher writes it)                                   |
| §3      | MOTIR-7024                                                                                                                      |
| §4      | MOTIR-7026 (checks, probes, route, launch job) · MOTIR-7022, MOTIR-7028 (the refusals in words)                                 |
| §5      | MOTIR-7023                                                                                                                      |
| §6      | MOTIR-7027 (supervise, couplings, end path) · MOTIR-7028 (Cancel) · MOTIR-7029 (the live run)                                   |
| §7      | MOTIR-9045 (the mode) · MOTIR-9050 (spawn) · MOTIR-9049 (claim) · MOTIR-9052, MOTIR-9048, MOTIR-9059 (resume)                   |
| §8      | MOTIR-9045 · MOTIR-9050                                                                                                         |
| §9      | MOTIR-9043, MOTIR-9047, MOTIR-9051, MOTIR-9058 (design, words) · MOTIR-9053 (door) · MOTIR-9054, MOTIR-9060 (the automatic fix) |

## AMENDMENT 1 (MOTIR-8872) — Fly's exec API delivers no stdin

§2 assumed the Machines exec API's `stdin` field reaches the command. On production it does not: a
`stdin` field is accepted and the command reads zero bytes, so the launcher refused every run with no
credentials. The contract `exec(…, { stdin })` is kept, and the Fly adapter now honours it by wrapping
the command in a root `sh` that pipes the payload to it (`printf %s "$p" | exec "$@"`). The payload is a
positional, so it is never quoted into a shell string. **What changes in §2:** the run token is in the
argv of that one wrapper process for the length of the exec (at most 30 seconds), as the clone's token
already is; it is still in no environment variable and in no argv of the launcher, the run session or
anything it spawns. The token stays scoped to one run and is revoked at close. A failed launch now
records its exit code and a bounded stderr tail (the launcher never prints the token) in the run's
detail, instead of only the refusal code.

## AMENDMENT 2 (MOTIR-8981) — a run's session id is recorded, and one fix starts itself

Two sentences above stop being true when the fix mode ships. §1 and §4 are left as written, as
AMENDMENT 1 left §2, and this is what changes in them.

- **§1 says "Motir stores no session id." It now does.** The run's own terminal session id is recorded,
  so a fix can re-enter that session. **No terminal byte and no session content is stored**, and
  [`agent-terminal.md`](agent-terminal.md) Q8 stands untouched.
- **§4 says "Nothing in Motir starts one on its own." That is true of a run and false of a fix.** A
  **run** is still started only by a person pressing a control. A **fix** may be started by Motir when
  the project's auto-fix setting is on (§9). Read §4's sentence as about runs.

## Owed on acceptance

- **MOTIR-6862's image update records `runLauncher` for the digest it moves an agent to** (§4), or
  probes it at the next boot before a run can start. MOTIR-6948 is the decision that says which.
- **The CLI release that carries the launcher** is MOTIR-7032, already planned.
- **A release that publishes the sandbox images carrying the CLI with `fix` and `continue` in agent
  mode** (MOTIR-8981), owed on the same terms as MOTIR-7032's for the launcher, together with a check
  that the modes are in the binary an agent boots. Until an agent's digest moves, neither door works on
  it. This record names the obligation and not the release's mechanics.

## What this does NOT decide

- **Any price.** Machine time stays [`hosted-agent-machine-charge.md`](hosted-agent-machine-charge.md)'s
  rate on the agent's intervals. This record adds no rate and no charge.
- **Run hosted.** The OpenCode lane is unchanged, and an agent never receives a Motir gateway key.
- **The chat panel** (MOTIR-6863). A chat creates no run.
- **Moving an agent to a newer image** (MOTIR-6862). This record names the refusal an old image gets
  and the probe the update owes.
- **Motir-initiated runs in a user's agent.** There are none, apart from the single automatic fix §9
  records. The autonomous project lead's runs never target a user's agent.
- **Letting anyone but the owner start, watch or cancel a run in an agent.**
  [`agent-instances.md`](agent-instances.md) §8's owner-only rule stands with no exception.
- **The panel's layout and copy.** They are MOTIR-7022's design. This record names the states and
  refusals it must draw.
