# ADR: Chat with your agent — one headless process per turn, one transcript shape, and no Claude subscription behind a Motir-drawn chat

- **Status:** Proposed (2026-09-30), for acceptance at this card's `decision_approval` gate
- **Card:** MOTIR-7010 · **Story:** MOTIR-6863 (_Chat with your agent in the panel_) · **Epic:**
  MOTIR-6859
- **Consumed by** (every sibling in the story reads it):
  - MOTIR-7011: the Chat tab design (Q2's refusal, Q5's event kinds, Q6's refusals, Q7's list, Q8's
    states)
  - MOTIR-7012: the `/v1/chat` endpoint in `packages/cli` (Q3, Q4, Q5's union and adapter contract,
    Q6, Q7, Q10, Q11)
  - MOTIR-7013: the relay's chat channel (Q4's channel, Q8's close code, Q9, Q10)
  - MOTIR-7014: the Claude Code adapter (Q1's `claude` row, Q2's sign-in rule, Q5's mapping)
  - MOTIR-7015: the Codex adapter (Q1's `codex` row, Q5's mapping)
  - MOTIR-7016: the OpenCode adapter (Q1's `opencode` row, Q5's mapping)
  - MOTIR-7017: the Chat tab (Q2, Q4, Q6, Q7, Q8)
  - MOTIR-7018, MOTIR-7019: the story test gate and the E2E, through the above
  - Outside the story: MOTIR-7020 (the CLI release) and MOTIR-6865 (the production check), for Q2
- **Builds on:** `agent-terminal.md` — the relay, the owner-only ticket, the relay token, the server
  on port 7681, activity (Q6), the sign-in check (Q7), the never-logged sinks (Q8) and Anthropic's
  four conditions (Q9). It amends one thing there, on the record: Q8's table gains the chat sinks
  (Q10 below). `agent-instances.md` §9 (which profiles are offered) is unchanged.
- **Evidence refs:** rung-2 paths are read at `origin/main` **`7550573`** (after the MOTIR-6861
  merge). Rung-1 pages were read on **2026-09-30**. Every stream below was captured on 2026-09-30
  from the real binary, installed the way `packages/cli/sandbox/install-agent.sh` installs it, and
  pointed at a local mock model server so its own event stream could be recorded without a
  credential.

---

## Context

`agent-terminal.md` Q4 reserved `/v1/chat` _"on the same server and port, behind the same relay
token"_, and its _What this does NOT decide_ left the chat adapters to this story. What is true
today:

1. **The server refuses the path.** `packages/cli/src/agentTerminal/server.ts` `onUpgrade` answers
   `/v1/chat` with a plain HTTP 404, and `protocol.ts` calls the path _"Reserved for the chat story
   … Not served yet."_
2. **The relay dials only the terminal.** `lib/agentTerminal/relay/terminalRelay.ts` 404s any browser
   path but `/v1/terminal`. An upstream that refuses the upgrade with an HTTP status lands in
   `unexpected-response` and closes the browser with 4502 (_the machine did not answer_).
3. **The relay already parses small text frames.** `MAX_PARSED_TEXT_BYTES = 4 KiB`: any text frame
   under it is `JSON.parse`d to find `auth` and `ping`.
4. **The server's message cap is 1 MiB** (`websocket.ts` `MAX_MESSAGE_BYTES`).
5. **Six profiles are offered** (`lib/agentInstances/profiles.ts` `OFFERED_AGENT_PROFILES`): claude,
   codex, opencode, kimi, aider, goose.
6. **The server knows its profile** from `MOTIR_SANDBOX_AGENT`, and its environment carries the
   agent's redirected config homes (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) because the image entrypoint
   sources them first (`agent-terminal.md` Context 7).
7. **The sandbox matrix records each profile's non-interactive mode and verified auto-approve flag**
   (`packages/cli/sandbox/README.md`, _Auto-approve flags — VERIFIED_).
8. **Machines are 512 MB to 2 GB** (`agent-instances.md` §3).

## Decision

### Q1 · Each CLI's headless stream, and the supported set

Each row is the version `install-agent.sh` installs today, read from the binary's own `--help` and
run for real. The excerpts are trimmed; ids and long fields are elided with `…`.

| profile    | version (channel)                  | headless stream                                   | turn end                                | Stop (observed)                                                                          | session store                                                                          | resume                                    | verdict                       |
| ---------- | ---------------------------------- | ------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------- |
| `claude`   | Claude Code **2.1.280** (`stable`) | `claude -p --output-format stream-json --verbose` | one `result` line                       | SIGINT: `result` `error_during_execution`, `terminal_reason:"aborted_streaming"`, exit 0 | `$CLAUDE_CONFIG_DIR/projects/<cwd with / → ->/<session_id>.jsonl`                      | `--resume <session_id>`                   | **supported, with Q2's rule** |
| `codex`    | codex-cli **0.159.2** (`latest`)   | `codex exec --json`                               | `turn.completed` (or `turn.failed`)     | SIGINT: exit 1, no final event; the rollout records `turn_aborted`                       | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl`                       | `codex exec resume <thread_id>`           | **supported**                 |
| `opencode` | opencode **1.18.33** (`latest`)    | `opencode run --format json`                      | `step_finish` with `part.reason:"stop"` | SIGINT: exit 130, no final event                                                         | SQLite `~/.local/share/opencode/opencode.db`; `opencode session list --format json`    | `--session <id>`                          | **supported**                 |
| `kimi`     | kimi-code **2.1.1** (`latest`)     | `kimi -p <prompt> --output-format stream-json`    | `session.resume_hint` meta line         | SIGINT: exit 130, the partial reply flushed, no resume hint                              | `~/.kimi-code/sessions/wd_…/session_<uuid>/…/wire.jsonl`; `session_index.jsonl`        | `--session <id>` (`-r` is a hidden alias) | **supported**                 |
| `goose`    | goose **1.52.0** (`stable`)        | `goose run -q --output-format stream-json`        | `{"type":"complete",…}`                 | SIGINT: `{"type":"error","error":"Headless run interrupted"}`, exit 1                    | SQLite `~/.local/share/goose/sessions/sessions.db`; `goose session list --format json` | `--resume --session-id <id>`              | **supported**                 |
| `aider`    | aider-chat **0.86.2** (pip)        | **none**: `--message` prints plain text           | the process exits                       | not applicable                                                                           | `.aider.chat.history.md` in the working directory                                      | `--restore-chat-history`                  | **unsupported**               |

**The supported set is claude, codex, opencode, kimi and goose. Aider is unsupported**, and the tab's
reason says that Aider has no machine-readable output for a chat to follow. Its `--help` has no JSON or event
option; `--stream` only controls token streaming to the terminal. Its reply is prose with a banner
and a `Tokens:` footer, and it makes no tool calls, so there is no tool row to draw. Aider's own
scripting page says its Python API _"is not officially supported or documented, and could change in
future releases without providing backwards compatibility"_ (https://aider.chat/docs/scripting.html).
Scraping the terminal text is rejected: a view that breaks on a banner change is not a transcript.

**Captured streams** (raw captures, one per profile):

`claude` 2.1.280, a tool call then a reply:

```
{"type":"system","subtype":"init","session_id":"49c4fa44-…","tools":["Task","Bash",…],"permissionMode":"default","apiKeySource":"ANTHROPIC_API_KEY","claude_code_version":"2.1.280",…}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_8101…","name":"Bash","input":{"command":"ls","description":"List files"}}]},…}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_8101…","type":"tool_result","content":"a.txt\nb.md","is_error":false}]},…}
{"type":"assistant","message":{"content":[{"type":"text","text":"The directory contains the files listed above."}]},…}
{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","session_id":"49c4fa44-…","total_cost_usd":0.000796,…}
```

`codex` 0.159.2:

```
{"type":"thread.started","thread_id":"01a0f1e6-e507-7c00-a172-76c9ce46e8f1"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc ls","aggregated_output":"a.txt\nb.md\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"The directory contains the files listed above."}}
{"type":"turn.completed","usage":{"input_tokens":24,"output_tokens":30,…}}
```

`opencode` 1.18.33:

```
{"type":"step_start","sessionID":"ses_f0e15f2f2ffeRhqhbBfRDMXLUT","part":{"type":"step-start",…}}
{"type":"tool_use","sessionID":"ses_f0e1…","part":{"type":"tool","tool":"bash","callID":"call_7c83…","state":{"status":"completed","input":{"command":"ls"},"output":"a.txt\nb.md\nopencode.json\n","metadata":{"exit":0},"title":"ls"}}}
{"type":"step_finish","sessionID":"ses_f0e1…","part":{"reason":"tool-calls","type":"step-finish",…}}
{"type":"text","sessionID":"ses_f0e1…","part":{"type":"text","text":"The directory contains the files listed above."}}
{"type":"step_finish","sessionID":"ses_f0e1…","part":{"reason":"stop","type":"step-finish",…}}
```

`kimi` 2.1.1:

```
{"role":"meta","type":"system.version","version":"2.1.1"}
{"role":"assistant","tool_calls":[{"type":"function","id":"call_43b39d940437","function":{"name":"Bash","arguments":"{\"command\":\"ls\"}"}}]}
{"role":"tool","tool_call_id":"call_43b39d940437","content":"a.txt\nb.md\n"}
{"role":"assistant","content":"The directory contains the files listed above."}
{"role":"meta","type":"session.resume_hint","session_id":"session_542c66ca-c9c4-4267-ba4b-10bfab95ff91",…}
```

`goose` 1.52.0:

```
{"type":"message","message":{"role":"assistant","content":[{"type":"toolRequest","id":"call_63cb…","toolCall":{"status":"success","value":{"name":"shell","arguments":{"command":"ls"}}}}]}}
{"type":"message","message":{"role":"user","content":[{"type":"toolResponse","id":"call_63cb…","toolResult":{"status":"success","value":{"structuredContent":{"stdout":"a.txt\nb.md","exit_code":0},"isError":false}}}]}}
{"type":"message","message":{"id":"chatcmpl-a2c9…","role":"assistant","content":[{"type":"text","text":"The directory "}]}}
{"type":"message","message":{"id":"chatcmpl-a2c9…","role":"assistant","content":[{"type":"text","text":"listed above."}]}}
{"type":"complete","total_tokens":0,…}
```

`aider` 0.86.2 (all of it):

```
Aider v0.86.2
Model: openai/mock-model with whole edit format
The directory contains the files listed above.
Tokens: 597 sent, 8 received.
```

**Granularity differs, and the transcript shape absorbs it.** Claude Code streams token deltas with
`--include-partial-messages`, and goose streams one `message` line per chunk. Codex, OpenCode's `run`
and kimi's `-p` emit each message only when it is complete. A reply there arrives in one piece rather
than word by word. That is accepted (Q3 names what buys deltas).

**Rung-1 quotes the rows rest on:**

- Claude Code: _"The last line of the stream is a `result` message"_; _"If you stop a `claude -p` run
  with SIGTERM … Claude Code leaves the turn that was in progress unfinished and records no result
  for it. To end the turn instead, send SIGINT"_ (https://code.claude.com/docs/en/headless).
- Codex: _"When you enable `--json`, stdout becomes a JSON Lines (JSONL) stream … Event types include
  `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, and `error`"_;
  _"By default, `codex exec` runs in a read-only sandbox"_ (https://developers.openai.com/codex/noninteractive).
- OpenCode: `--format` _"default (formatted) or json (raw JSON events)"_; `--session` _"Session ID to
  continue"_ (https://opencode.ai/docs/cli/).
- kimi: _"In -p mode, no human approval is requested — regular tool calls are handled under the auto
  permission policy"_; sessions are _"saved under $KIMI_CODE_HOME/sessions/ … grouped by working
  directory"_ (https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html).
- goose: `--output-format` _"`stream-json` for events as they occur"_; _"goose uses a SQLite database
  (`sessions.db`)"_ (goose repo, `documentation/docs/guides/goose-cli-commands.md`).

**A version drift is expected, and the adapters own it.** Each adapter card records its fixtures from
the version the image installs when it is built, and names that version in each fixture's header. The
rows above are the evidence for the choice, not the contract.

### Q2 · Anthropic's terms — **option (b): the Claude Code chat runs on an API key or a cloud-provider sign-in, never on a Claude subscription**

The page, _Claude Code — Legal and compliance_, https://code.claude.com/docs/en/legal-and-compliance,
read **2026-09-30**. It says two things that point different ways.

**For hosting the binary:**

> _"preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or
> other agent infrastructure) requires agreeing to our Commercial Terms of Service and complying with
> the conditions below"_

and, under _Authentication and credential use_:

> _"Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their
> own Claude subscription, including where a platform hosts Claude Code"_

**Against a product built on top of it:**

> _"Developers building products or services that interact with Claude's capabilities, including those
> using the Agent SDK, should use API key authentication through Claude Console or a supported cloud
> provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own
> applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their
> users."_

and _"Anthropic reserves the right to take measures to enforce these restrictions and may do so
without prior notice."_

**The reading.** The terminal is squarely the first case: the user types into the vendor's own
interface, in the vendor's own binary, on their own sign-in. The Chat tab is not. It is a Motir
interface that sends the user's prompts into the binary's programmatic stream, which is the same
`stream-json` transport the Agent SDK drives, and renders what comes back. That is a third-party
product interacting with Claude's capabilities, and the page directs such products to API-key or
cloud-provider authentication. The carve-out names _"signing in to the unmodified Claude Code
binary"_, not a third party's interface in front of it.

The reading could go either way, and the card's rule is explicit: **if the answer is not clearly (a),
the Claude Code adapter does not ship on a subscription.** It is not clearly (a). The commercial
agreement MOTIR-6944 accepted (the Commercial Terms, recorded on that card 2026-09-29) does not
change this: it is the precondition for hosting, not a permission for this use.

**So:**

- **(a) rejected** — "the user's own use of the hosted binary." It fits the terminal, not a Motir
  interface. Shipping on this reading stakes the Claude Code profile, and the terminal with it, on an
  interpretation Anthropic may enforce against _"without prior notice."_
- **(c) rejected** — no Claude Code chat at all. The same page expressly allows products to use
  API-key and cloud-provider credentials: _"Each end user must authenticate with their own Anthropic
  API key, Claude subscription plan credentials, or 3P inference provider credential … That usage is
  billed directly to the end user."_ A user on their own API key is exactly the case the page
  describes, so refusing them buys nothing.
- **(b) chosen.** The Claude Code adapter ships. It chats when the agent's Claude Code authenticates
  with an Anthropic API key or a cloud provider (Bedrock, Vertex / Agent Platform, Foundry), and
  refuses when it would authenticate with a Claude subscription.

**How the adapter tells, without reading a credential.** Before each turn it runs the vendor's own
`claude auth status --json` (Claude Code 2.1.280 ships it: _"Show authentication status … --json
Output as JSON (default)"_). Observed on the capture host, which carried an OAuth sign-in of its own,
with `ANTHROPIC_API_KEY` also set:

```
{ "loggedIn": true, "authMethod": "oauth_token", "apiProvider": "firstParty", …, "apiKeySource": "ANTHROPIC_API_KEY" }
```

- **Chat allowed** when `apiProvider` is not `firstParty` (a cloud provider), or when `apiKeySource`
  is present and is not `none` (an API key the user configured: the environment or an
  `apiKeyHelper`). Without the key the same host printed no `apiKeySource` at all. The Claude Code
  adapter card records the exact values from the pinned version in its fixtures.
- **Chat refused** otherwise, with the Q4 refusal `subscription_signin`, and no turn process is
  started.
- **A second check, per turn:** Claude Code's `system/init` line carries `apiKeySource`. If it reads
  `none`, the runner kills the process at once and ends the turn `failed` with the same code. This is
  a backstop for a sign-in changed between the probe and the turn; the probe is the gate.

The probe reads only the binary's answer, never a credential file, so the terminal ADR's Q7 and Q9
condition 4 hold. **Motir sets nothing to make the chat work**: no `ANTHROPIC_API_KEY`, no
`apiKeyHelper`, no `--bare` (which would disable OAuth, a restriction of a built-in method that Q9
condition 2 forbids). The user who wants the chat configures their own key, in their own agent, as
Claude Code documents it. The terminal is unaffected: a subscription sign-in there is the carve-out
case.

**What the tab says** on a subscription sign-in (MOTIR-7011 writes the copy): the chat is not
available for Claude Code signed in with a Claude subscription, because Anthropic's terms do not
allow a third-party interface to drive it on one; sign in with an Anthropic API key or a cloud
provider to chat, or keep using the terminal.

**How this is reversed.** The page itself says _"For questions about permitted authentication methods
for your use case, please contact sales."_ Written confirmation from Anthropic that a Motir-drawn
chat on the user's own subscription is permitted would allow deleting the gate. That confirmation is
a follow-up for a person, as Cursor's is in `agent-instances.md` §9.

**Other vendors.** The Codex sign-in is governed by OpenAI's Terms of Use, which MOTIR-6944 read in
full (comment of 2026-09-29): _"You may not share your account credentials or make your account
available to anyone else"_. Nothing in them addresses an interface in front of the CLI, and the chat
shares no credential, so Codex chats on either sign-in. OpenCode, kimi and goose carry no such term
beyond their licences (`agent-instances.md` §9). §9 already says that in those CLIs a Claude model is
used with the user's own API key.

### Q3 · Process model — one CLI process per turn, resuming the session from the CLI's own store

A turn starts the CLI in its one-shot headless mode, with the session id when the chat already has
one, streams its stdout, and ends when the process exits.

**Invocations** (the adapters own the exact argv; these are its shape):

| profile    | new chat                                                                                                                        | resumed chat adds                          | prompt on   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------- |
| `claude`   | `claude -p --output-format stream-json --verbose --include-partial-messages --session-id <uuid> --dangerously-skip-permissions` | `--resume <id>` in place of `--session-id` | stdin       |
| `codex`    | `codex exec --json -c sandbox_mode="workspace-write" -`                                                                         | `codex exec resume <id> …` (same flags)    | stdin (`-`) |
| `opencode` | `opencode run --format json --auto <prompt>`                                                                                    | `--session <id>`                           | argv        |
| `kimi`     | `kimi -p <prompt> --output-format stream-json`                                                                                  | `--session <id>`                           | argv        |
| `goose`    | `goose run -q --output-format stream-json -i -`                                                                                 | `--resume --session-id <id>`               | stdin       |

- **The working directory is `$HOME/workspace`**, the terminal's (`shellCwd`), so the chat and the
  terminal see the same repositories and the same per-directory session stores.
- **Permission flags are the sandbox matrix's verified auto-approve flags**
  (`packages/cli/sandbox/README.md`). `codex exec resume` takes no `--sandbox` flag in 0.159.2, so
  Codex passes the same setting as a `-c` override on both forms. The machine is the user's own sandbox, and a headless turn has
  nobody to answer a prompt: Claude Code's default `-p` mode denied a plain `ls > listing.txt` in the
  capture, and `codex exec` defaults to a read-only sandbox. goose's is an environment variable,
  `GOOSE_MODE=auto`. kimi's `-p` is already auto.
- **The prompt goes on stdin where the CLI documents it**, so it is not in the process table; argv
  otherwise. Either way it stays on the user's machine.

**Why per turn:**

- **Memory.** Measured RSS while streaming: claude ~230 MB, codex ~200 MB (node wrapper plus Rust
  child), opencode ~520–590 MB, kimi ~350 MB, goose ~126 MB. A process held per open session between
  turns would put two OpenCode chats past a 512 MB machine. Per turn, nothing is resident while the
  user reads or types.
- **Crash recovery is the store.** A turn process that dies leaves the CLI's session on disk; the next
  turn resumes it. Nothing on the server needs rebuilding.
- **It is the mode every supported CLI documents.** Resume was observed on all five: the resumed run
  kept the same session id and sent the full prior history to the model.

**Rejected:**

- **A long-lived process per session, fed prompts on stdin** (Claude Code's `--input-format
stream-json`). Only Claude Code has it; the other four would each need their own server protocol
  (codex `app-server` JSON-RPC, OpenCode `serve` HTTP/SSE, kimi and goose ACP over stdio). That is
  five clients to build and five resident processes to hold. Those protocols do give token deltas
  and a clean in-band interrupt, so they are the upgrade path (_What this does NOT decide_).
- **ACP for everything.** kimi, goose and OpenCode speak it, but Claude Code and Codex do so only
  through third-party wrapper packages, which the image does not install and which Q9 condition 1
  would have to vet as "unmodified".

### Q4 · The `/v1/chat` wire protocol — JSON text frames on its own WebSocket, the list on the socket

The chat is **one WebSocket per open chat view**, at `/v1/chat` on the agent's server (port 7681) and
on the relay, behind the same ticket (`agent-terminal.md` Q3) and relay token. **All frames are JSON
text; there are no binary frames.** A frame is at most 1 MiB (Context 4).

**The ticket names its channel.** `POST …/terminal-ticket` takes `{ "channel": "terminal" | "chat" }`
(default `terminal`, so today's panel is unchanged). The ticket and the connection row record it in a
`channel` column. The relay redeems a ticket only on the path of its channel; a mismatch is 4401.

| direction       | frame                                                    | meaning                                                                               |
| --------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| browser → relay | `{"t":"auth","ticket"}`                                  | first frame; consumed by the relay, as for the terminal                               |
| server → client | `{"t":"hello","profile","supported","reason"?,"signin"}` | the first server frame: Q1's verdict (and Q2's) and the terminal's sign-in state      |
| client → server | `{"t":"list"}`                                           | ask for the session list                                                              |
| server → client | `{"t":"sessions","items":[{"id","title","updatedAt"}]}`  | Q7's list                                                                             |
| client → server | `{"t":"open","session"?}`                                | attach: a new chat, or resume `session`                                               |
| server → client | `{"t":"ready","session","resumed"}`                      | attached. `session` is null for a new chat until the CLI names it                     |
| server → client | `{"t":"history","events","truncated"}`                   | on a resume: the earlier turns, read from the CLI's store (Q7), before any live event |
| client → server | `{"t":"prompt","text"}`                                  | start a turn. `text` is 1 to 64 KiB                                                   |
| server → client | `{"t":"session","id"}`                                   | the CLI's session id, sent once, as soon as the stream reveals it                     |
| server → client | `{"t":"event","turn","e"}`                               | one transcript event (Q5) of turn `turn`, in order                                    |
| client → server | `{"t":"stop"}`                                           | stop the running turn (Q6)                                                            |
| client → server | `{"t":"ping","active"}` · server → client `{"t":"pong"}` | the terminal's heartbeat, every 20 s                                                  |
| server → client | `{"t":"signin","profile","state"}`                       | the sign-in state on change, exactly as on the terminal                               |
| server → client | `{"t":"error","code"}`                                   | a refusal; the socket stays open                                                      |

**Error codes:** `unsupported` (Q1's verdict), `subscription_signin` (Q2), `not_signed_in` (the
terminal's check says so), `turn_running` (Q6), `no_turn` (a `stop` with nothing running),
`unknown_session`, `taken_over` (Q6), `too_large`, `bad_frame`.

**The session list travels on the socket.** A separate HTTP path is rejected: the relay proxies
WebSocket upgrades only, and a second path would need its own ticket and its own proxy for one small
request the authenticated socket can answer.

### Q5 · ONE transcript event shape, and the adapter contract

**The union** (`packages/cli/src/agentTerminal/chat/protocol.ts`, MOTIR-7012). Every adapter maps
into it, and the tab draws nothing else:

| `e.k`         | fields                                                                                              | drawn as                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `user`        | `text`                                                                                              | the developer's prompt                                                            |
| `text`        | `id`, `delta`                                                                                       | assistant text; deltas with one `id` concatenate. A complete message is one delta |
| `tool_call`   | `id`, `kind` (`read` · `edit` · `command` · `other`), `name`, `title`, `path`?, `command`?, `diff`? | one collapsed row                                                                 |
| `tool_result` | `id`, `ok`, `output`?, `exitCode`?, `truncated`                                                     | the row's expanded body; `ok:false` marks it failed                               |
| `turn_end`    | `reason` (`completed` · `stopped` · `failed`), `code`?                                              | the end-of-turn marker                                                            |
| `error`       | `code`, `message`?                                                                                  | an inline notice that does not end the turn (a retry, a denied tool)              |
| `other`       | `name`                                                                                              | a quiet row naming an event nobody mapped                                         |

- **Tool kinds.** `read` is a file read; `edit` is a file write or change, carrying a unified `diff`
  when the stream supplies one (Claude Code's `Edit` / `Write` / `MultiEdit` inputs, OpenCode's edit
  tool) and only the `path` otherwise (Codex's `file_change` names paths and change kinds); `command`
  is a shell command with its output (`Bash`, `command_execution`, `bash`, `shell`); everything else
  is `other`, named by the tool.
- **Bounds.** A `tool_result.output` over 64 KiB is cut to its last 64 KiB with `truncated: true`,
  so no frame nears the 1 MiB cap. A `diff` is bounded the same way.
- **Dropped, never mapped:** reasoning and thinking blocks, and every token-count and cost field
  (Claude Code's `total_cost_usd`, Codex's `usage`, goose's `complete` counts). Q10 says why.
- **An unrecognised line** becomes `other` when it parses as JSON with a type, and is dropped when it
  does not. It never ends a turn and is never logged (Q10).

**The adapter contract** (`packages/cli/src/agentTerminal/chat/adapter.ts`, MOTIR-7012; one file per
profile under `chat/adapters/`):

```ts
interface ChatAdapter {
  readonly profile: string; // the MOTIR_SANDBOX_AGENT id it serves
  /** Q1/Q2: whether a turn may run now. Claude Code's runs `claude auth status --json`. */
  support(
    ctx: ChatContext,
  ): Promise<
    { supported: true } | { supported: false; code: 'unsupported' | 'subscription_signin' }
  >;
  /** Q3: the argv, the stdin (if the prompt goes there) and the ONLY env additions allowed (Q11). */
  turnCommand(input: { prompt: string; sessionId: string | null; ctx: ChatContext }): TurnCommand;
  /** Q5: a fresh stateful mapper per turn. */
  createMapper(): {
    onLine(line: string): TranscriptEvent[];
    sessionId(): string | null; // Q4's `session` frame, once known
  };
  /** Q7: newest first, at most `limit`. */
  listSessions(ctx: ChatContext, limit: number): Promise<ChatSessionSummary[]>;
  /** Q7: a resumed session's earlier turns, within `budgetBytes`. May return `unavailable`. */
  readHistory(
    ctx: ChatContext,
    sessionId: string,
    budgetBytes: number,
  ): Promise<{ events: TranscriptEvent[]; truncated: boolean } | { unavailable: true }>;
}
```

`ChatContext` carries the home, the working directory and the server's own environment. The
**runner** (`chat/turns.ts`), not the adapter, owns spawning, Stop, the per-agent limit and
`turn_end`: an adapter maps lines, and never writes `turn_end` itself. The runner writes it from
the process exit (Q6) and the adapter's own end marker (Q1's _turn end_ column) only tells it the
turn completed rather than failed.

### Q6 · A turn's start, its Stop, and concurrency

- **Start.** On `prompt`: `support()` (Q2's probe included), then the terminal's sign-in state
  (`not_signed_in` when the check says signed out; `unknown` is let through, since the three
  uncheckable profiles would otherwise never chat), then the per-agent limit below. Only then is a
  process spawned. A refusal spawns nothing.
- **End.** The runner writes `turn_end` when the process exits:
  - `completed` when the adapter saw its end marker and the exit code is 0;
  - `stopped` when a `stop` was received for this turn, whatever the process printed;
  - `failed` otherwise (a crash, a non-zero exit, Q2's backstop), with a code.
- **Stop.** SIGINT to the process group; if it has not exited after **5 seconds**, SIGKILL. SIGINT
  is the documented way for Claude Code (SIGTERM _"records no result"_) and the observed way for the
  other four; none of them offers anything better in its one-shot mode. The CLI's store keeps
  whatever it wrote (Codex's rollout records `turn_aborted`), and the text already streamed stays in
  the tab. The adapter's own interrupt markers (Claude Code's `aborted_streaming` result, goose's
  _"Headless run interrupted"_) are consumed, not shown twice.
- **One running turn per agent, not only per session.** A second `prompt` anywhere on the agent
  while a turn runs is refused `turn_running`. This is Q3's memory argument: two OpenCode turns do
  not fit a 512 MB machine. The tab shows who is busy; it is one developer on their own agent.
- **Two sockets on one session** follow the terminal's rule: the later `open` takes it over, the
  earlier socket receives `taken_over`, and a running turn keeps running and streams to the new
  socket.
- **A dropped socket does not stop a turn.** The turn runs to its end, and its events are kept in a
  **256 KiB ring** per running turn (the terminal's replay size). A re-`open` of that session gets the
  `history`, then the ring's events for the running turn, then live ones. The ring is freed when the
  turn ends and no socket holds the session.
- **The terminal may be running the same CLI on the same session.** The chat does not guard that:
  the two are the same user on the same store, and what happens is what that CLI does with two
  writers. The tab does not claim otherwise.

### Q7 · The session list and resume — from the CLI's own store, newest first, at most 50

- **Source.** Each adapter reads its own CLI's store on the volume, preferring the CLI's own listing
  command where it has one: `opencode session list --format json`, `goose session list --format
json`, kimi's `session_index.jsonl`; the JSONL files for Claude Code and Codex. **Nothing is copied
  to Motir.**
- **Scope.** Sessions whose working directory is `$HOME/workspace`: Claude Code's project directory
  for that path; Codex's rollouts whose `session_meta` names it; the others by their directory field.
- **Newest first by last activity** — the session's last-updated time (a JSONL file's mtime, or the
  CLI's `updated` field). Codex's own `--last` chose the most recently _updated_ session in the
  capture, so this is the vendor's order too.
- **At most 50**, with `title` the CLI's title where it keeps one and otherwise the first prompt, cut
  to 120 characters.
- **Chat and terminal sessions are not told apart.** Both are the same user's same CLI in the same
  directory, and a session begun in the terminal is a legitimate one to continue in the chat. Telling
  them apart would mean reading undocumented vendor markers.
- **Resume** is the CLI's own option (Q1's column), and its history comes from `readHistory`, within
  **256 KiB**, newest turns kept. A CLI whose store the adapter cannot read reliably answers
  `unavailable`, and the tab shows the resumed session with no earlier turns drawn; the agent still
  has them.
- **A new chat's id.** Claude Code takes `--session-id <uuid>` minted by the server, so its id is
  known at once. The others reveal it in the stream (Codex's `thread.started`, OpenCode's
  `sessionID`, goose's session, kimi's `session.resume_hint` at the end of the turn); the server sends
  `{"t":"session"}` when it does. A kimi turn stopped before its hint leaves a session the next `list`
  still shows.

### Q8 · An image with no chat server — the relay reads the 404 as close code **4411**

- The relay dials `/v1/chat`. **An image whose server predates this story answers the upgrade with
  HTTP 404** (Context 1). The relay maps exactly that answer, on the chat channel only, to close code
  **4411, "the agent's image has no chat server"**. Any other refusal stays 4502. **No database probe
  and no new column**: the dial is the probe, and it costs nothing on an image that has the server.
- **Rejected: a second probe column beside `terminalServer`.** It would need an `exec` on every boot
  of every agent, for an answer the first chat dial gives for free.
- **Before the panel connects, it already knows the verdict for most profiles.** A lib-side table,
  `CHAT_PROFILES` beside `AGENT_SIGN_IN_HINTS` in `lib/agentInstances/profiles.ts`, lists the Q1
  verdict per profile. The tab draws aider's disabled state without connecting. For a supported
  profile, the server's `hello` is authoritative: it carries Q2's refusal, and an old image gives 4411.

`TERMINAL_CLOSE` gains `noChatServer: 4411`. No existing code is renumbered.

### Q9 · Activity — every chat frame counts, except an inactive heartbeat, and the relay parses none

- The relay calls `touchActivity` on a chat connection's open and close, and on **every frame in
  either direction**, through the same 60-second throttle as the terminal. A streaming turn therefore
  keeps the agent awake, and so does a developer typing.
- **The exception is a heartbeat from a hidden tab.** The relay tells heartbeat frames by comparing
  a frame's bytes to three constants: `{"t":"ping","active":true}` (counts),
  `{"t":"ping","active":false}` and `{"t":"pong"}` (do not). The panel sends those exact bytes.
- **So on the chat channel the relay parses nothing after `auth`.** `MAX_PARSED_TEXT_BYTES` parsing
  (Context 3) applies to the terminal only. A short chat frame is content, and it is compared, never
  decoded.

### Q10 · What is never logged — `agent-terminal.md` Q8, extended to chat

`agent-terminal.md` Q8's table holds for chat, row for row, and **this record amends it** with these
chat rows:

| sink                                  | how it is kept clean                                                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the chat server's stdout              | lifecycle lines only: a chat opened, a turn started and ended with its reason and duration, a refusal code. Never a prompt, an event, a tool output, a path or a session title                            |
| the turn process's stdout and stderr  | stdout goes to the mapper and nowhere else. stderr (kimi writes tool progress there) is read and discarded, never forwarded to the server's own output                                                    |
| the relay                             | forwards chat frames unread (Q9); logs ids and close codes                                                                                                                                                |
| the database                          | the `agent_terminal_connection` row with `channel = chat`, its open and its close. **No chat table, no transcript, no session list, no title**                                                            |
| Sentry (relay, server, browser)       | no frame payload attached to an event; the panel keeps the transcript in component state, never in a breadcrumb, `localStorage` or analytics                                                              |
| **model calls, keys and token usage** | **Motir makes none and records none.** The CLI calls the vendor on the user's own credential. Token and cost fields are dropped by the mapper (Q5), so they reach neither the browser nor any Motir store |

The `history` a resume sends and the 256 KiB turn ring are read from, and held in, the user's own
machine. They are not Motir storage.

### Q11 · `agent-terminal.md` Q9 for chat — the binary unwrapped, no sign-in touched

- **Unmodified.** The adapter spawns the binary the image installed, from `PATH`, directly: no
  wrapper, shim, alias or `sh -c`.
- **No authentication method removed, disabled or restricted.** The environment is the server's own
  minus `MOTIR_TERMINAL_KEY`, exactly as the shell's. **The one addition allowed is a permission
  mode that is not a credential**, and goose's `GOOSE_MODE=auto` is the only one. No adapter sets an
  API key, a base URL, a provider, a model or a token. No flag forces, hides or replaces a sign-in
  method; that is why Claude Code's `--bare` is not used.
- **The sign-in completes through the vendor's own flow**, in the terminal, as today. The chat never
  starts a sign-in; `not_signed_in` points at the terminal.
- **No credential is collected, stored or intermediated.** The server stats the credential file
  (terminal Q7) and asks `claude auth status` (Q2). Neither reads the credential.

## Consequences

- **Claude Code's chat reaches fewer users than the story assumed.** A developer signed in with a
  Claude subscription, which is how most are, sees the chat refused with Q2's reason and keeps the
  terminal. The epic's production check (MOTIR-6865) and the E2E (MOTIR-7019) change accordingly.
- **Two more adapters.** kimi and goose have usable streams, so they get adapter cards beside the
  three planned. Aider shows a disabled tab.
- **Replies arrive whole on three profiles.** Codex, OpenCode and kimi stream complete messages, not
  words. Q3's rejected protocols are how that improves.
- **The relay gains a channel, not a service.** One `channel` column on two tables, one close code,
  one path. No new app, secret or port.
- **The agent can act on its own machine during a chat** with the sandbox's auto-approve flags, as an
  unattended run already does. The machine is the user's own and holds nothing of Motir's.

**Which card acts on each question:**

| question | card(s)                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------- |
| Q1       | MOTIR-7014, MOTIR-7015, MOTIR-7016, the kimi and goose adapter cards · MOTIR-7017 (aider's state) |
| Q2       | MOTIR-7014 (the probe, the backstop) · MOTIR-7011 and MOTIR-7017 (the refusal) · MOTIR-7019       |
| Q3       | MOTIR-7012 (the runner) · each adapter (its argv)                                                 |
| Q4       | MOTIR-7012 (server frames) · MOTIR-7013 (channel, ticket) · MOTIR-7017 (client)                   |
| Q5       | MOTIR-7012 (union, contract) · each adapter (its mapping) · MOTIR-7011 and MOTIR-7017 (the rows)  |
| Q6       | MOTIR-7012 · MOTIR-7017                                                                           |
| Q7       | each adapter · MOTIR-7012 (the frames) · MOTIR-7017                                               |
| Q8       | MOTIR-7013 (4411) · MOTIR-7017 (`CHAT_PROFILES`, the states)                                      |
| Q9       | MOTIR-7013 · MOTIR-7017 (the exact heartbeat bytes)                                               |
| Q10      | MOTIR-7012 · MOTIR-7013 · MOTIR-7017 · MOTIR-7018 (the guards)                                    |
| Q11      | each adapter · MOTIR-7012                                                                         |

## What this does NOT decide

- **Whether Anthropic would allow a subscription-backed chat if asked.** Q2 refuses it on the page as
  written and names how it is reversed; asking is a person's follow-up, not this record's.
- **Token-level streaming and in-band interrupt for Codex, OpenCode, kimi and goose** through their
  server protocols (codex `app-server`, OpenCode `serve`, ACP). Q3 rejects them for now and records
  that they work.
- **Approving an agent's tool use from the chat.** Turns run under the sandbox's auto-approve flags;
  an approval prompt in the tab is not built.
- **Attachments, images or slash commands in the prompt box.** A prompt is text.
- **The tab's layout and copy**, which are MOTIR-7011's. This record names the states it must draw.
- **Anything the terminal decided**: the ticket, the token, the terminal protocol, the sign-in check
  and the relay's home are unchanged. Only Q8's table gains rows (Q10), and the ticket gains a
  channel (Q4).
- **Sending a card to an agent, with a run record** — MOTIR-6864's. A chat creates no run record.
- **Moving an agent to a newer image** — MOTIR-6862's. 4411 names the state; it moves nothing.
- **Copying transcripts to Motir** for search, audit or sharing. Q10 refuses it, and nothing here
  builds it.
