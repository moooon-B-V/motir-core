---
'@motir/cli': minor
---

The chat beside the terminal now works on an agent whose profile is `opencode` (MOTIR-7016). A prompt runs the unmodified `opencode run --format json --auto`, with the prompt on its argv and nothing added to its environment, and each JSON event becomes a transcript event: the reply's text, a tool call by its kind (a `read`, an `edit` with its diff, a `bash` command with its output and exit code, anything else by its name) and the tool's result, a failed tool drawn failed. The turn completes on OpenCode's `step_finish` with reason `stop`; Stop is the runner's SIGINT. The session list is OpenCode's own `opencode session list --format json`, scoped to the workspace, newest first and at most 50, and a listed session resumes through `--session <id>`, its earlier turns read from `opencode export <id>`. Reasoning, tokens and cost are dropped, an unrecognised event is shown as a quiet row and never logged, and nothing is copied off the agent's volume.
