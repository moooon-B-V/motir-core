---
'@motir/cli': minor
---

Dispatch runs are recorded and watchable. Every dispatch command — `motir next`,
`motir run <KEY>`, `motir run <scope>`, `motir batch` and `motir auto` — now opens
a run: the set it owned, what happened to each work item, and why it stopped,
watchable at `/runs/<id>`. Reporting is best-effort and can never break a run.

A run that finds its work item wrong can log a bug and submit a re-plan, with the
run's own policy electing which lanes are open. The dispatch prompt composes the
WHAT and submits it through the plan-session tools, and a `manual` work item can
be planned as a to-do list.
