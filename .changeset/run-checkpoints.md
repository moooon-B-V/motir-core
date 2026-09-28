---
'@motir/cli': minor
---

A run now CHECKPOINTS its work (MOTIR-6539). While the agent works, the CLI
pushes the card's work branch in every repository of the leg whenever it holds
commits origin does not have yet — every 60 seconds, and once more when the
agent ends however it ends — so a run that dies (hosted or local, a leaf or a
parent's child) leaves its commits on origin for `motir continue`. It never
commits on the agent's behalf, never pushes a branch with nothing new on it, and
never touches the session branch. A failed checkpoint push is one `log` event on
the run and is retried; it never fails the run. `checkout_ready` now names every
repository's branch (`data.branches`), and the scope drain emits it too.
