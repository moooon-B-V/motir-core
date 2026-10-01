# Claude Code chat fixtures (MOTIR-7014)

**These fixtures are DERIVED, not freshly recorded.** No model was called and no
credential was used to produce them. They are built from:

- the real `claude` **2.1.280** captures quoted in `docs/decisions/agent-chat.md`
  (Q1's `claude` stream, Q1's Stop row — `result` / `error_during_execution` /
  `terminal_reason:"aborted_streaming"` — and Q2's `claude auth status --json`
  answer), and
- Claude Code's documented `--output-format stream-json` schema (headless mode):
  the `system`/`init` line, `stream_event` lines carrying the Messages API's
  streaming events with `--include-partial-messages`, complete `assistant` and
  `user` (tool result) messages, and the final `result` line.

The flags were confirmed against the installed binary's own `--help`
(`claude --version` → 2.1.285 on the authoring host; `claude auth status --help`
lists `--json`). The ADR pins 2.1.280, so every stream fixture's `# ` header line
names **Claude Code 2.1.280**; the test loader drops that header before replay.
Ids, costs and token counts are illustrative.

When the image's pinned version moves, re-record these from the real binary
(pointed at a local mock model server, as the ADR's captures were) and update the
header lines.

| file                                  | what it is                                                                |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `text-reply.jsonl`                    | a plain streamed reply (thinking dropped, text deltas, then the message)  |
| `read.jsonl`                          | a `Read` tool call and its result, then a reply                           |
| `edit.jsonl`                          | an `Edit` with `old_string` / `new_string` (the diff), then a reply       |
| `bash.jsonl`                          | the ADR's `ls` capture, with partial messages                             |
| `failed-tool.jsonl`                   | a `Bash` call whose result is `is_error: true`, `Exit code 1`             |
| `stopped.jsonl`                       | a turn stopped with SIGINT mid-reply: the `aborted_streaming` result      |
| `resume.jsonl`                        | a `--resume` turn: `init` names the resumed session                       |
| `no-key.jsonl`                        | Q2's backstop: an `init` with `apiKeySource: "none"`                      |
| `unknown-line.jsonl`                  | an unrecognised JSON line and a non-JSON line mid-turn                    |
| `auth-status-api-key.json`            | an Anthropic API key sign-in                                              |
| `auth-status-api-key-over-oauth.json` | the ADR's own capture: an OAuth sign-in with `ANTHROPIC_API_KEY` also set |
| `auth-status-cloud-provider.json`     | a cloud-provider (Bedrock) sign-in: `apiProvider` not `firstParty`        |
| `auth-status-subscription.json`       | a Claude subscription sign-in: no `apiKeySource` at all                   |
| `auth-status-key-source-none.json`    | `apiKeySource: "none"`                                                    |
| `auth-status-signed-out.json`         | not signed in                                                             |
| `store/<id>.jsonl`                    | one session file in Claude Code's project store, for `readHistory`        |
