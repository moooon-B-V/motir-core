---
'@motir/cli': minor
---

A run now reports what its agent writes into `$MOTIR_AGENT_REPORT` besides the model (MOTIR-8698, MOTIR-8722, MOTIR-8810). An agent that stops on an unbuildable card and writes its reason there as `unbuildable` gets the run-found report made for it (`POST /api/v1/dispatch-runs/{id}/unbuildable`); an agent with no Motir tools gets its build-through points (`discrepancy`) recorded on the card and its STOP (`stop`) commented and, when re-planning is on, the card moved to Planning. Every dispatch-prompt read now sends `agentReport=1`, which is how the server knows it may name that file as the route; 0.12.0 and older send nothing and are told to use the `report_unbuildable_target` tool instead, so their reports are no longer lost.
