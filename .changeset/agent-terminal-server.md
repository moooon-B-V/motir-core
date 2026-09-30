---
'@motir/cli': minor
---

`motir agent-terminal serve [--port 7681]` is the terminal server a Motir agent's machine runs (MOTIR-6938). It hands Motir's relay a login shell (`bash -l` in `$HOME/workspace`) over a WebSocket at `/v1/terminal`, only for an upgrade carrying a relay token signed with the machine's own key, and refuses anything else before a shell exists. A dropped connection keeps the shell: reconnecting with its session id re-attaches it and replays the last 256 KiB of output, with at most 4 shells per agent. It reports whether the agent's coding CLI is signed in by checking only that its credential file exists, and it logs lifecycle lines with ids only — never a byte of the terminal. The PTY it needs is built into the sandbox image (`/opt/motir-terminal`), so the package still depends on `commander` alone; run anywhere else, `serve` says "The terminal server runs inside a Motir agent image."
