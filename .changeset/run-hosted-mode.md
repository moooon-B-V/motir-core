---
'@motir/cli': minor
---

`motir run` gains a HOSTED mode (MOTIR-6558). Given `--run-id <id>` or
`MOTIR_DISPATCH_RUN_ID`, it ADOPTS a run Motir already opened instead of opening
one — a leaf, a multi-repository leaf, or a parent whose members the server
claimed — and reads that run's cards and order back rather than claiming a
second set. It needs no `.motir.json` (the project comes from the run, the
checkouts go under `MOTIR_WORKSPACE`, default `/workspace`, cloned as
`<root>/<name>`), never prompts, and keeps a scope going past a failed card. The
env ladder gains the hosted names one rung below their general twins:
`MOTIR_RUN_TOKEN` below `MOTIR_TOKEN`, `MOTIR_API_URL` below `MOTIR_SERVER`. A
run without a run id is unchanged.
