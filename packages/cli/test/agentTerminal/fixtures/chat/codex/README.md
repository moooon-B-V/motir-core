# Codex chat fixtures (MOTIR-7015)

Streams and a session store for the Codex chat adapter
(`src/agentTerminal/chat/adapters/codex.ts`), replayed through a fake spawn by
`test/agentTerminal/chatCodex.test.ts`.

**Version: codex-cli 0.159.2** (`@openai/codex`, channel `latest`), the version
`docs/decisions/agent-chat.md` Q1 records as the one `packages/cli/sandbox/install-agent.sh`
installed when the decision's streams were captured (2026-09-30).

## ⚠️ How these were made — RECONSTRUCTED, not re-recorded

No `codex` binary was installed where this card was built, and none was
installed or run for it, and no model was called. So these files are **not a
fresh capture**. They are built from:

1. **The real capture quoted in the ADR** (Q1, the `codex` 0.159.2 excerpt):
   `thread.started` → `turn.started` → `item.started` / `item.completed`
   `command_execution` → `item.completed` `agent_message` → `turn.completed`.
   `command.jsonl` is that capture with the ADR's `…` elisions filled in.
2. **The ADR's observed facts**: SIGINT makes codex exit 1 with **no final
   event**, and the rollout records `turn_aborted` (Q1, Q6); rollouts live at
   `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl` and their
   `session_meta` names the working directory (Q1, Q7); a resume keeps the same
   thread id (Q3).
3. **The vendor's documented `codex exec --json` schema**
   (https://developers.openai.com/codex/noninteractive): top-level
   `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`
   and `error`; item types `agent_message`, `reasoning`, `command_execution`,
   `file_change` (paths and change kinds, no diff), `mcp_tool_call`,
   `web_search`, `todo_list` and `error`.

The rollout lines under `store/` follow the rollout format Codex writes
(`session_meta`, `turn_context`, `response_item`, `event_msg`), reduced to the
records the adapter reads. Only the ids, paths, prompts and replies are
invented.

**Re-record them** from the real binary when one is available — the ADR's
method: install codex the way `install-agent.sh` does, point it at a local mock
model server, run the invocation in each file's header, and keep the header's
version current. The adapter owns version drift (ADR Q1).

## Files

Each `.jsonl` opens with a `#` header naming the CLI version and the
invocation; the test strips it before replay.

| file                   | what it is                                                                 |
| ---------------------- | -------------------------------------------------------------------------- |
| `message.jsonl`        | a plain reply (a reasoning item, dropped; an agent message)                |
| `command.jsonl`        | a command execution with its output, then a reply — the ADR's capture      |
| `file-change.jsonl`    | two `file_change` items (one path; two paths), then a reply                |
| `failed-command.jsonl` | a command that exits 1 (`status: failed`), then a reply                    |
| `interrupted.jsonl`    | a turn stopped mid-command: the stream simply ends, no final event         |
| `resume.jsonl`         | `codex exec resume <id>`: the same thread id, the earlier turn remembered  |
| `other-events.jsonl`   | `todo_list`, `web_search`, `mcp_tool_call`, `error`s and an unknown event  |
| `turn-failed.jsonl`    | `turn.failed`: an error notice and no end marker                           |
| `store/`               | a `$CODEX_HOME`: four rollouts (one in another directory) and a stray file |

The store's rollouts: `…01a0f1e6…` (2026-09-28, a command turn then a resumed
turn), `…01a0f1e7…` (2026-09-29, an `apply_patch` edit), `…01a0f1e9…`
(2026-09-30, a turn ending in `turn_aborted`), and `…01a0f1ec…`, whose
`session_meta` names `/home/agent/other-directory` and is therefore not listed.
Git does not keep mtimes, so the test copies the store and sets each file's
mtime itself.
