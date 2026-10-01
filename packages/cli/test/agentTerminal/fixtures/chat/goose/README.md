# goose chat fixtures (MOTIR-7035)

Streams replayed by `test/agentTerminal/chatGoose.test.ts` through a fake spawn.

**Version: goose 1.52.0 (`stable`)**, the version `docs/decisions/agent-chat.md`
Q1 records as the one `packages/cli/sandbox/install-agent.sh` installs.

**These are NOT fresh recordings.** No goose binary was installed and no model
was called when they were written. Each line is built from:

- the real goose 1.52.0 capture in `docs/decisions/agent-chat.md` Q1 (the
  `message` / `toolRequest` / `toolResponse` / `complete` shapes, with the
  capture's elided ids filled in), and Q1's observed Stop line,
  `{"type":"error","error":"Headless run interrupted"}`;
- goose's documented `--output-format stream-json` events and message content
  types (`text`, `toolRequest`, `toolResponse`; a tool result is either
  `{"status":"success","value":{…}}` or `{"status":"error","error":"…"}`), and
  its developer extension's `shell` and `text_editor` tools;
- goose's documented `goose session list --format json` rows (`id`, `name`,
  `working_dir`, `created_at`, `updated_at`) for `session-list.json`.

Each `.jsonl` opens with a `#` header naming the CLI version and the argv. The
header is not JSON, so replaying it also proves the mapper drops a non-JSON line.

| file                   | what it is                                                |
| ---------------------- | --------------------------------------------------------- |
| `plain-reply.jsonl`    | a reply streamed as three chunks of one message           |
| `shell-and-edit.jsonl` | a `shell` call and a `text_editor` `str_replace`, a reply |
| `stopped.jsonl`        | SIGINT mid-reply: the interrupt line, then exit 1         |
| `failed-tool.jsonl`    | a command exiting 1 (`isError`), then a tool `error`      |
| `resumed.jsonl`        | a follow-up turn run with `--resume --session-id`         |
| `session-list.json`    | a listing across two directories                          |

When a goose image is at hand, re-record them from the real binary (a local
mock model server, as the ADR's captures were made) and keep the header.
