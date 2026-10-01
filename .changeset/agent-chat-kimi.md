---
'@motir/cli': minor
---

The agent chat now works on a kimi agent (MOTIR-7034). A prompt runs the unmodified `kimi -p <prompt> --output-format stream-json` in `$HOME/workspace` (plus `--session <id>` to continue a session), with no flag or environment variable added, and each streamed message becomes a transcript event: the reply (whole, not word by word), each tool call as a read, an edit with its diff, a shell command with its output or another tool, and each tool's result, failed ones marked. Stop ends the turn as stopped with the partial reply kept. The session list is read from kimi's own `session_index.jsonl`, limited to `$HOME/workspace`, newest first, at most 50; a resumed session's earlier turns are not redrawn, because kimi's session log format is not documented. Nothing from the stream is logged.
