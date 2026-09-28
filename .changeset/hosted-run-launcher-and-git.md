---
'@motir/cli': minor
---

A hosted run launches its own agent and reaches GitHub only as Motir's App (MOTIR-6559). With `MOTIR_DISPATCH_RUN_ID` set and no `--agent`, `motir run` launches OpenCode on `MOTIR_MODEL` through the gateway (`MOTIR_GATEWAY_URL`, `MOTIR_RUN_KEY`), configured exactly as the gateway's egress contract says and on an allow-listed environment that never holds the run credential. git and `gh` get the run's repository tokens from its git-credential route through a credential helper and a `gh` shim — never from an environment variable — and every commit is authored as the App's bot of its repository. Every pull request a hosted run opens names the person who dispatched it, the card and the run. A hosted run always reports its agent's output, so the stall watchdog sees a long step working.
