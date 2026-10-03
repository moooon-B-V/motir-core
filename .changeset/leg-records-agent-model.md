---
'@motir/cli': minor
---

Every leg a run reports now records the agent's self-reported model. `motir run`, `next`, `batch`, `run <scope>`, `continue` and `auto` send it as a top-level `model` on `agent_exited`, and `motir fix` and `motir review` now send it too (they sent none before). `fix` also sends its exit code top-level, so a repair leg records it like every other path. The model is null when the agent reported none, never a guess.
