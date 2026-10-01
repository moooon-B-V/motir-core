---
'@motir/cli': minor
---

The Chat tab now works on a goose agent (MOTIR-7035). A prompt runs the image's own `goose run -q --output-format stream-json -i -`, unwrapped, with the prompt on stdin and `GOOSE_MODE=auto` (goose's own auto-approve) as the only environment addition; a resumed chat adds `--resume --session-id <id>`. goose's streamed chunks become text deltas, a `shell` call becomes a command row with its output, a `text_editor` change becomes an edit row with its diff, a failed tool becomes a failed result, and `complete` ends the turn — its token counts are dropped. Stop's "Headless run interrupted" line is consumed, so the stopped marker is shown once. The session list comes from `goose session list --format json`, only sessions in `$HOME/workspace`, newest first, at most 50; a resumed session draws no earlier turns, because goose's store has no documented export. No line of a turn is logged.
