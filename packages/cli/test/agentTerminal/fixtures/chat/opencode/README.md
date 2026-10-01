# OpenCode chat fixtures (MOTIR-7016)

**Pinned version: opencode 1.18.33** (`latest` channel, npm `opencode-ai`), the version
`docs/decisions/agent-chat.md` Q1 records the image installing on 2026-09-30.

⚠️ **These fixtures are RECONSTRUCTED, not recorded on this card's host.** No `opencode` binary was
installed where MOTIR-7016 was built, and no model was called. Each stream was built from:

- the real `opencode run --format json` capture in `docs/decisions/agent-chat.md` Q1 (the `step_start` ·
  `tool_use` · `step_finish` (`reason:"tool-calls"`) · `text` · `step_finish` (`reason:"stop"`)
  sequence, the `sessionID` on every line, a `bash` tool's `state.output` and `metadata.exit`), and
- OpenCode's documented JSON event output (the `run` command's `--format json`, `--session`, and the
  `session list --format json` / `export` commands at https://opencode.ai/docs/cli/), for the fields
  the ADR's excerpt elides (`part.id`, `callID`, a `read` / `edit` tool's `state`, the edit tool's
  `metadata.diff`, a tool `state.status:"error"` with its `error`, `step_finish` token counts).

The ADR's Q1 row also records the stop behaviour these reproduce: SIGINT exits 130 with **no final
event**, so `stopped.jsonl` simply ends.

When the image's `opencode` is available, re-record each stream from the real binary (against a mock
model server, as the ADR did) and replace these; the header line of each `.jsonl` names the version it
stands for.

| file                      | what it is                                                               |
| ------------------------- | ------------------------------------------------------------------------ |
| `plain-reply.jsonl`       | a plain reply                                                            |
| `read-edit-command.jsonl` | a `read`, an `edit` with its unified diff, and a `bash` command          |
| `stopped.jsonl`           | a turn stopped by SIGINT: no `step_finish` `stop`, the process exits 130 |
| `failed-tool.jsonl`       | a `read` whose `state.status` is `error`, then the reply                 |
| `continued-session.jsonl` | a turn run with `--session <id>`: the same `sessionID`                   |
| `session-list.json`       | `opencode session list --format json` output                             |
| `export.json`             | `opencode export <id>` output, for a resume's history                    |

Each `.jsonl` opens with one `#` header line (the version, the invocation and what it shows); the test
strips it before replaying the rest, one line at a time, through a fake process.
