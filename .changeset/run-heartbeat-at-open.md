---
'@motir/cli': patch
---

A run now sends its first heartbeat the moment the CLI opens or adopts it, then every 60 seconds as before (MOTIR-7328). A run killed in its first minute used to have sent no heartbeat at all, so Motir read it as a run from a CLI too old to heartbeat and kept it alive for 12 hours: `motir continue` refused it as `run_alive` and the card showed no _run died_ marker. Now such a run is dead five minutes after it was last heard from, like any other.
